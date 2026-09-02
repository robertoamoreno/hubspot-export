import { hubspotFetch } from "./hubspot.ts";
import { type Direction, normalizeDirection, stripHtml } from "./utils.ts";
import type { MessageAttachment } from "./attachments.ts";

export interface ConversationMessage {
  id: string;
  subject: string;
  body: string;
  direction: Direction;
  /** The raw conversations API direction value, before normalisation. */
  directionRaw: string;
  sender: string;
  recipient: string;
  timestamp: string;
  sourceType: "CONVERSATION";
  threadId: string;
  /** Files the API returned with this message. */
  attachments: MessageAttachment[];
}

interface ThreadsListResponse {
  results: Array<{
    id: string;
    createdAt: string;
    latestMessageTimestamp?: string;
    associatedContactId?: string;
  }>;
  paging?: { next?: { after: string } };
}

interface ThreadMessagesResponse {
  results: Array<{
    id: string;
    type: string;
    createdAt: string;
    text?: string;
    richText?: string;
    subject?: string;
    truncationStatus?: string;
    senders?: Array<{
      actorId?: string;
      name?: string;
      deliveryIdentifier?: { type: string; value: string };
    }>;
    recipients?: Array<{
      actorId?: string;
      recipientField?: string;
      deliveryIdentifier?: { type: string; value: string };
    }>;
    direction?: string;
    attachments?: Array<{
      type?: string;
      fileId?: string;
      name?: string;
      fileUsageType?: string;
      url?: string;
    }>;
  }>;
  paging?: { next?: { after: string } };
}

/**
 * Get conversation thread IDs associated with a ticket using the
 * Conversations API's native associatedTicketId filter.
 */
async function getThreadIdsForTicket(ticketId: string): Promise<string[]> {
  const threadIds: string[] = [];
  let after: string | undefined;

  do {
    const params: Record<string, string> = {
      associatedTicketId: ticketId,
      limit: "500",
    };
    if (after) params.after = after;

    try {
      const data = await hubspotFetch<ThreadsListResponse>(
        "/conversations/v3/conversations/threads",
        params,
      );

      if (data.results.length === 0) break;

      for (const thread of data.results) {
        threadIds.push(thread.id);
      }

      after = data.paging?.next?.after;
    } catch (err) {
      console.warn(
        `  Warning: Failed to get threads for ticket ${ticketId}: ${err}`,
      );
      break;
    }

  } while (after);

  return threadIds;
}

/** Fetch all messages in a conversation thread. */
async function fetchThreadMessages(
  threadId: string,
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  let after: string | undefined;

  do {
    const params: Record<string, string> = { limit: "100" };
    if (after) params.after = after;

    try {
      const data = await hubspotFetch<ThreadMessagesResponse>(
        `/conversations/v3/conversations/threads/${threadId}/messages`,
        params,
      );

      if (data.results.length === 0) break;

      for (const msg of data.results) {
        // Skip status change events - they don't contain conversation content
        if (msg.type === "THREAD_STATUS_CHANGE") continue;

        const rawBody = msg.text || msg.richText || "";
        const body = stripHtml(rawBody);
        const attached = msg.attachments ?? [];
        // A message can be nothing but a file — dropping it on an empty body
        // would lose the attachment with it.
        if (!body && attached.length === 0) continue;

        const sender =
          msg.senders?.[0]?.deliveryIdentifier?.value ||
          msg.senders?.[0]?.name ||
          msg.senders?.[0]?.actorId ||
          "";
        const recipient =
          msg.recipients?.[0]?.deliveryIdentifier?.value ||
          msg.recipients?.[0]?.actorId ||
          "";

        const attachments: MessageAttachment[] = attached.map(
          (a) => ({
            fileId: a.fileId ?? "",
            name: a.name ?? "",
            kind: a.fileUsageType ?? a.type ?? "OTHER",
            url: a.url ?? "",
          }),
        );

        messages.push({
          id: msg.id,
          subject: msg.subject || "",
          body,
          direction: normalizeDirection(msg.direction || ""),
          directionRaw: msg.direction || "",
          sender,
          recipient,
          timestamp: msg.createdAt,
          sourceType: "CONVERSATION",
          threadId,
          attachments,
        });
      }

      after = data.paging?.next?.after;
    } catch (err) {
      console.warn(
        `  Warning: Failed to fetch messages for thread ${threadId}: ${err}`,
      );
      break;
    }

  } while (after);

  return messages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/** Fetch all conversation messages associated with a ticket. */
export async function fetchConversationsForTicket(
  ticketId: string,
): Promise<ConversationMessage[]> {
  const threadIds = await getThreadIdsForTicket(ticketId);
  if (threadIds.length === 0) return [];

  const allMessages: ConversationMessage[] = [];
  for (const threadId of threadIds) {
    const messages = await fetchThreadMessages(threadId);
    allMessages.push(...messages);
  }

  return allMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
