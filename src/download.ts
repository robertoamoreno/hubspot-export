import { retry } from "@std/async/retry";
import type { MessageAttachment } from "./attachments.ts";
import type { Message } from "./export.ts";

/** Where downloaded files live, relative to the output directory. */
export const ATTACHMENTS_DIR = "attachments";

/**
 * Filesystem-safe file name for an attachment.
 *
 * Prefixed with the file id so two different files sharing a name (HubSpot
 * emits plenty of `~WRD0001.jpg`) cannot overwrite each other, and so a
 * re-run can tell whether a file is already on disk.
 */
export function attachmentFileName(att: MessageAttachment): string {
  // deno-lint-ignore no-control-regex -- stripping control characters is the point
  const CONTROL_OR_SEPARATOR = /[/\\:*?"<>|\x00-\x1f]/g;
  const safe = (att.name || "file")
    .replace(CONTROL_OR_SEPARATOR, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
  const id = att.fileId || hashUrl(att.url);
  return `${id}-${safe}`;
}

/** Short stable id for an inline image, which has no HubSpot file id. */
function hashUrl(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `url${(h >>> 0).toString(36)}`;
}

/**
 * Which attachments to fetch.
 *
 * Inline images are overwhelmingly email-signature logos, tracking pixels and
 * embedded document thumbnails: in a 120-ticket sample they were 2706 of 2781
 * rows and 65MB, against 73 genuine files. They stay recorded in
 * attachments.csv either way; "all" also puts them on disk.
 */
export type DownloadMode = "files" | "all";

export function shouldDownload(
  att: MessageAttachment,
  mode: DownloadMode,
): boolean {
  if (!att.url) return false;
  return mode === "all" || att.kind !== "INLINE";
}

export interface DownloadStats {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/**
 * Download every attachment on these messages that has a URL, filling in
 * localPath as it goes.
 *
 * Files already on disk are left alone, so an interrupted run costs nothing to
 * repeat. A file that cannot be fetched is counted and skipped rather than
 * failing the export — a missing image should not cost a ticket's text.
 */
export async function downloadAttachments(
  messages: Message[],
  outputDir: string,
  stats: DownloadStats,
  mode: DownloadMode = "files",
): Promise<void> {
  for (const msg of messages) {
    for (const att of msg.attachments) {
      if (!shouldDownload(att, mode)) continue;
      const name = attachmentFileName(att);
      const rel = `${ATTACHMENTS_DIR}/${name}`;
      const abs = `${outputDir}/${rel}`;

      const existing = await sizeOf(abs);
      if (existing !== null) {
        att.localPath = rel;
        stats.skipped++;
        stats.bytes += existing;
        continue;
      }

      try {
        const bytes = await fetchBytes(att.url);
        await Deno.writeFile(abs, bytes);
        att.localPath = rel;
        stats.downloaded++;
        stats.bytes += bytes.byteLength;
      } catch (err) {
        stats.failed++;
        console.warn(`  Warning: could not download ${att.url}: ${err}`);
      }
    }
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await Deno.stat(path)).size;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  return await retry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        // 4xx means this URL will never work; don't spend retries on it.
        const err = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw Object.assign(err, { permanent: true });
        }
        throw err;
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    {
      maxAttempts: 3,
      minTimeout: 500,
      maxTimeout: 5000,
      multiplier: 2,
      jitter: 1,
      isRetriable: (err) => !(err as { permanent?: boolean }).permanent,
    },
  );
}
