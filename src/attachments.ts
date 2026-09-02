import { errorStatus, hubspotFetch } from "./hubspot.ts";

export interface MessageAttachment {
  /** HubSpot file id. Empty for images found inline in HTML, which have no file object. */
  fileId: string;
  name: string;
  /** IMAGE or OTHER from the conversations API; INLINE for an image found in email HTML. */
  kind: string;
  /** Direct URL. Empty when a file id could not be resolved (needs the `files` scope). */
  url: string;
  /** Path under the output directory once downloaded. */
  localPath?: string;
}

/** `<img src="...">` in an email body. */
const IMG_TAG = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * Image URLs embedded in an email's HTML body.
 *
 * The exported message body comes from hs_email_text when it exists, which is
 * almost always — so the HTML, and every image in it, would otherwise never be
 * looked at. cid: references are skipped: they point at MIME parts that the
 * API does not expose, so recording them would only produce dead links.
 */
export function parseInlineImages(html: string): MessageAttachment[] {
  const seen = new Set<string>();
  const found: MessageAttachment[] = [];
  for (const m of html.matchAll(IMG_TAG)) {
    const url = m[1].trim();
    if (!url || url.startsWith("cid:") || url.startsWith("data:")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ fileId: "", name: fileNameFromUrl(url), kind: "INLINE", url });
  }
  return found;
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "image";
  } catch {
    return "image";
  }
}

interface FileResponse {
  id: string;
  name: string;
  extension?: string;
  url?: string;
}

/**
 * Resolve HubSpot file ids to names and URLs.
 *
 * Email engagements expose only hs_attachment_ids, so a lookup is needed to
 * get anything useful. That endpoint requires the `files` scope, which the
 * README's three scopes do not include — without it every lookup 403s, so the
 * ids are still recorded but with no name or URL, and the caller is told once
 * rather than per file.
 */
export class FileResolver {
  private cache = new Map<string, MessageAttachment | null>();
  private scopeMissing = false;
  private failures = 0;

  get missingScope(): boolean {
    return this.scopeMissing;
  }
  get failureCount(): number {
    return this.failures;
  }

  async resolve(fileIds: string[]): Promise<MessageAttachment[]> {
    const out: MessageAttachment[] = [];
    for (const id of fileIds) {
      if (!this.cache.has(id)) {
        this.cache.set(id, await this.lookup(id));
      }
      const hit = this.cache.get(id);
      out.push(hit ?? { fileId: id, name: "", kind: "OTHER", url: "" });
    }
    return out;
  }

  private async lookup(id: string): Promise<MessageAttachment | null> {
    if (this.scopeMissing) return null;
    try {
      const f = await hubspotFetch<FileResponse>(`/files/v3/files/${id}`);
      return {
        fileId: f.id,
        name: f.name + (f.extension ? `.${f.extension}` : ""),
        kind: "OTHER",
        url: f.url ?? "",
      };
    } catch (err) {
      if (errorStatus(err) === 403) {
        this.scopeMissing = true;
        console.warn(
          "  Warning: the `files` scope is missing, so email attachment ids " +
            "cannot be resolved to names or URLs. They are still recorded in " +
            "attachments.csv. Add the `files` scope to the service key to " +
            "resolve them.",
        );
        return null;
      }
      this.failures++;
      console.warn(`  Warning: could not resolve file ${id}: ${err}`);
      return null;
    }
  }
}

/** Split HubSpot's semicolon-separated hs_attachment_ids value. */
export function parseAttachmentIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(";").map((s) => s.trim()).filter(Boolean);
}
