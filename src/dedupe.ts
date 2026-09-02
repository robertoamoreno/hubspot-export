import type { Message } from "./export.ts";

/**
 * How far apart two copies of the same message may be timestamped.
 *
 * An email's hs_timestamp and the same message's conversation createdAt are
 * usually identical; the widest gap observed in production was ~5s.
 */
const DUPLICATE_WINDOW_MS = 60_000;

/** Whitespace- and case-insensitive body, for comparing two copies. */
function bodyKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Merge two copies of one message, preferring the email.
 *
 * The email is a first-class CRM engagement with a stable object id, so it is
 * the copy worth keeping — but only the conversation copy knows the thread,
 * so that gets carried across.
 */
function merge(a: Message, b: Message): Message {
  const email = a.sourceType === "EMAIL" ? a : b.sourceType === "EMAIL" ? b : undefined;
  const convo = a.sourceType === "CONVERSATION"
    ? a
    : b.sourceType === "CONVERSATION"
    ? b
    : undefined;
  // Keep every file from both copies, matched on fileId (or url for inline).
  const merged = [...a.attachments];
  for (const att of b.attachments) {
    const key = att.fileId || att.url;
    if (!merged.some((m) => (m.fileId || m.url) === key)) merged.push(att);
  }
  if (!email) return { ...a, attachments: merged }; // two conversation copies
  return convo
    ? { ...email, threadId: convo.threadId, attachments: merged }
    : { ...email, attachments: merged };
}

/**
 * Drop duplicate messages within one ticket.
 *
 * When a connected inbox backs a conversation thread, HubSpot exposes the same
 * message twice — once as an email engagement and once as a thread message,
 * with different ids. Exporting both inflated messages.csv and the per-ticket
 * Message Count by ~22% in a production sample.
 *
 * Two messages are the same when their bodies match ignoring case and
 * whitespace and their timestamps fall within DUPLICATE_WINDOW_MS. Bodies are
 * compared in full, so two genuinely repeated short replies stay distinct
 * unless they also land in the same time window.
 */
export function dedupeMessages(
  messages: Message[],
): { messages: Message[]; removed: number } {
  const kept: Message[] = [];
  const keptKeys: string[] = [];
  const keptTimes: number[] = [];
  let removed = 0;

  for (const msg of messages) {
    const key = bodyKey(msg.body);
    const time = new Date(msg.timestamp).getTime();

    let dupIdx = -1;
    if (key) {
      for (let i = 0; i < kept.length; i++) {
        if (keptKeys[i] !== key) continue;
        // An unparseable timestamp on either side can't be compared; fall back
        // to treating identical bodies within the same ticket as duplicates.
        const bothTimed = Number.isFinite(time) && Number.isFinite(keptTimes[i]);
        if (!bothTimed || Math.abs(keptTimes[i] - time) <= DUPLICATE_WINDOW_MS) {
          dupIdx = i;
          break;
        }
      }
    }

    if (dupIdx === -1) {
      kept.push(msg);
      keptKeys.push(key);
      keptTimes.push(time);
    } else {
      kept[dupIdx] = merge(kept[dupIdx], msg);
      removed++;
    }
  }

  return { messages: kept, removed };
}
