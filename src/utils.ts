import { convert } from "html-to-text";

/** Convert HTML to plain text. */
export function stripHtml(html: string): string {
  return convert(html, { wordwrap: false }).trim();
}

/** Normalised message direction, consistent across emails and conversations. */
export type Direction = "INCOMING" | "OUTGOING" | "UNKNOWN";

/**
 * Map a raw HubSpot direction onto a single vocabulary.
 *
 * The two sources disagree: conversation messages use INCOMING/OUTGOING,
 * while an email's hs_email_direction uses INCOMING_EMAIL for inbound and
 * EMAIL — not "OUTGOING" — for a message sent from the CRM. Exporting both
 * raw meant `direction == "INCOMING"` silently missed every inbound email.
 */
export function normalizeDirection(raw: string): Direction {
  switch (raw.trim().toUpperCase()) {
    case "INCOMING":
    case "INCOMING_EMAIL":
      return "INCOMING";
    case "OUTGOING":
    case "EMAIL":
    case "FORWARDED_EMAIL":
      return "OUTGOING";
    default:
      return "UNKNOWN";
  }
}
