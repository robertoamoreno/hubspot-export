import { getClient, hubspotFetch, isSplittable } from "./hubspot.ts";
import { type Direction, normalizeDirection, stripHtml } from "./utils.ts";

const EMAIL_PROPERTIES = [
  "hs_email_subject",
  "hs_email_text",
  "hs_email_html",
  "hs_email_direction",
  "hs_timestamp",
  "hs_email_sender_email",
  "hs_email_to_email",
  "hs_email_from_email",
];

export interface EmailMessage {
  id: string;
  subject: string;
  body: string;
  direction: Direction;
  /** The raw hs_email_direction value, before normalisation. */
  directionRaw: string;
  sender: string;
  recipient: string;
  timestamp: string;
  sourceType: "EMAIL";
}

export interface AssociationFetchResult {
  associations: Map<string, string[]>;
  /** Ticket ids whose email associations could not be fetched. */
  failedTicketIds: string[];
}

export interface EmailFetchResult {
  emails: Map<string, EmailMessage>;
  /** Email ids whose content could not be fetched. */
  failedEmailIds: string[];
}

/**
 * Run `fn` over a batch of ids, halving the batch on a per-record failure so
 * one bad id doesn't cost the whole request. Returns the ids that could not
 * be fetched, so callers can report incomplete data instead of silently
 * treating it as "this ticket has no emails".
 *
 * Exported for tests.
 */
export async function fetchWithSplit(
  ids: string[],
  fn: (ids: string[]) => Promise<void>,
  label: string,
): Promise<string[]> {
  try {
    await fn(ids);
    return [];
  } catch (err) {
    if (ids.length === 1 || !isSplittable(err)) {
      console.warn(
        `  Warning: ${label} failed for ${ids.length} record(s) ` +
          `(${ids[0]}${ids.length > 1 ? `..${ids[ids.length - 1]}` : ""}): ${err}`,
      );
      return ids;
    }
    console.warn(
      `  Warning: ${label} failed for ${ids.length} records, splitting: ${err}`,
    );
    const mid = Math.floor(ids.length / 2);
    return [
      ...await fetchWithSplit(ids.slice(0, mid), fn, label),
      ...await fetchWithSplit(ids.slice(mid), fn, label),
    ];
  }
}

interface BatchAssociationResponse {
  results: Array<{
    from: { id: string };
    to: Array<{ toObjectId: number; associationTypes: unknown[] }>;
  }>;
}

/**
 * Batch fetch email associations for many tickets at once.
 * Uses POST /crm/v4/associations/tickets/emails/batch/read (up to 1000 per request).
 * Returns a map: ticketId → emailId[]
 */
export async function batchGetEmailAssociations(
  ticketIds: string[],
): Promise<AssociationFetchResult> {
  const associations = new Map<string, string[]>();
  const failedTicketIds: string[] = [];
  if (ticketIds.length === 0) return { associations, failedTicketIds };

  const readBatch = async (batch: string[]) => {
    const data = await hubspotFetch<BatchAssociationResponse>(
      "/crm/v4/associations/tickets/emails/batch/read",
      undefined,
      "POST",
      { inputs: batch.map((id) => ({ id })) },
    );
    for (const item of data.results) {
      const emailIds = item.to.map((t) => String(t.toObjectId));
      if (emailIds.length > 0) {
        associations.set(item.from.id, emailIds);
      }
    }
  };

  const totalBatches = Math.ceil(ticketIds.length / 1000);
  for (let i = 0; i < ticketIds.length; i += 1000) {
    const batchNum = Math.floor(i / 1000) + 1;
    const batch = ticketIds.slice(i, i + 1000);
    console.log(`  Associations batch ${batchNum}/${totalBatches} (${i + batch.length}/${ticketIds.length} tickets)...`);
    failedTicketIds.push(
      ...await fetchWithSplit(batch, readBatch, "email associations"),
    );
  }

  return { associations, failedTicketIds };
}

/**
 * Batch fetch email details for a list of email IDs.
 * Uses SDK batch read (up to 100 per request).
 */
export async function batchFetchEmails(
  emailIds: string[],
): Promise<EmailFetchResult> {
  const emails = new Map<string, EmailMessage>();
  const failedEmailIds: string[] = [];
  if (emailIds.length === 0) return { emails, failedEmailIds };

  const client = getClient();

  const readBatch = async (batch: string[]) => {
    const response = await client.crm.objects.emails.batchApi.read(
      {
        inputs: batch.map((id) => ({ id })),
        properties: EMAIL_PROPERTIES,
        propertiesWithHistory: [],
      },
      false,
    );
    for (const email of response.results) {
      const p = email.properties;
      const rawText = p.hs_email_text || p.hs_email_html || "";
      const bodyText = stripHtml(rawText);
      emails.set(email.id, {
        id: email.id,
        subject: p.hs_email_subject || "",
        body: bodyText,
        direction: normalizeDirection(p.hs_email_direction || ""),
        directionRaw: p.hs_email_direction || "",
        sender: p.hs_email_sender_email || p.hs_email_from_email || "",
        recipient: p.hs_email_to_email || "",
        timestamp: p.hs_timestamp || "",
        sourceType: "EMAIL",
      });
    }
  };

  const totalBatches = Math.ceil(emailIds.length / 100);
  for (let i = 0; i < emailIds.length; i += 100) {
    const batchNum = Math.floor(i / 100) + 1;
    if (batchNum % 10 === 1 || batchNum === totalBatches) {
      console.log(`  Email content batch ${batchNum}/${totalBatches} (${Math.min(i + 100, emailIds.length)}/${emailIds.length} emails)...`);
    }
    const batch = emailIds.slice(i, i + 100);
    failedEmailIds.push(
      ...await fetchWithSplit(batch, readBatch, "email content"),
    );
  }

  return { emails, failedEmailIds };
}

/** Get emails for a single ticket given pre-fetched data. */
export function getEmailsForTicket(
  ticketId: string,
  associationMap: Map<string, string[]>,
  emailCache: Map<string, EmailMessage>,
): EmailMessage[] {
  const emailIds = associationMap.get(ticketId) || [];
  const messages: EmailMessage[] = [];
  for (const id of emailIds) {
    const email = emailCache.get(id);
    if (email) messages.push(email);
  }
  return messages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
