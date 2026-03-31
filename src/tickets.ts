import { getClient, hubspotFetch } from "./hubspot.ts";

export interface TicketProperty {
  name: string;
  label: string;
}

export interface Ticket {
  id: string;
  properties: Record<string, string | null>;
}

/** Fetch all property definitions for tickets. */
export async function fetchTicketProperties(): Promise<TicketProperty[]> {
  const client = getClient();
  console.log("Fetching ticket property definitions...");
  const response = await client.crm.properties.coreApi.getAll("tickets");
  const props = response.results
    .map((p) => ({ name: p.name, label: p.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  console.log(`Found ${props.length} ticket properties.`);
  return props;
}

interface ListResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after: string } };
}

interface BatchReadResponse {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
}

/**
 * Fetch all tickets in two phases:
 *   1. List ticket IDs via GET (no properties in URL → no 414)
 *   2. Batch-read full properties via POST (no 3 000-char search body limit)
 *
 * This avoids both the 414 URI-too-large error from the GET list endpoint
 * and the 400 body-too-large error from the Search API (which caps request
 * bodies at 3 000 characters — far too small for 200+ property names).
 */
export async function fetchAllTickets(
  properties: TicketProperty[],
): Promise<Ticket[]> {
  const propertyNames = properties.map((p) => p.name);

  // Phase 1 — collect every ticket ID via the list endpoint (GET, no props)
  const allIds: string[] = [];
  let after: string | undefined;
  let page = 0;

  console.log("Fetching ticket IDs...");
  const startTime = Date.now();

  do {
    const params: Record<string, string> = { limit: "100" };
    if (after) params.after = after;

    const response = await hubspotFetch<ListResponse>(
      "/crm/v3/objects/tickets",
      params,
    );

    for (const t of response.results) {
      allIds.push(t.id);
    }

    after = response.paging?.next?.after;
    page++;

    if (page % 50 === 0 || !after) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ...${allIds.length} ticket IDs fetched (${elapsed}s elapsed)`);
    }
  } while (after);

  // Phase 2 — batch-read full properties (POST, 100 IDs per request)
  console.log("Fetching ticket properties via batch read...");
  const tickets: Ticket[] = [];

  for (let i = 0; i < allIds.length; i += 100) {
    const batch = allIds.slice(i, i + 100);

    const response = await hubspotFetch<BatchReadResponse>(
      "/crm/v3/objects/tickets/batch/read",
      undefined,
      "POST",
      {
        inputs: batch.map((id) => ({ id })),
        properties: propertyNames,
        propertiesWithHistory: [],
      },
    );

    for (const t of response.results) {
      tickets.push({ id: t.id, properties: t.properties });
    }

    if ((i / 100 + 1) % 50 === 0 || i + 100 >= allIds.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ...${tickets.length} tickets hydrated (${elapsed}s elapsed)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${tickets.length} tickets in ${totalTime}s.`);

  return tickets;
}
