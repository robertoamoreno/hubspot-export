import { assertEquals } from "@std/assert";
import {
  ATTACHMENTS_DIR,
  attachmentFileName,
  type DownloadStats,
  downloadAttachments,
  shouldDownload,
} from "./download.ts";
import type { Message } from "./export.ts";
import type { MessageAttachment } from "./attachments.ts";

function att(p: Partial<MessageAttachment> = {}): MessageAttachment {
  return { fileId: "1844", name: "shot.png", kind: "IMAGE", url: "https://h.net/a.png", ...p };
}
function msg(attachments: MessageAttachment[]): Message {
  return {
    id: "m1", subject: "s", body: "b", direction: "INCOMING", directionRaw: "INCOMING",
    sender: "a@b.c", recipient: "d@e.f", timestamp: "2025-01-01T00:00:00Z",
    sourceType: "EMAIL", attachments,
  };
}
function stats(): DownloadStats {
  return { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
}

Deno.test("file name is prefixed with the id so same-named files can't collide", () => {
  // HubSpot emits a lot of ~WRD0001.jpg
  assertEquals(attachmentFileName(att({ fileId: "1", name: "~WRD0001.jpg" })), "1-~WRD0001.jpg");
  assertEquals(attachmentFileName(att({ fileId: "2", name: "~WRD0001.jpg" })), "2-~WRD0001.jpg");
});

Deno.test("a hostile file name cannot escape the attachments directory", () => {
  for (const hostile of [
    "../../etc/passwd",
    "a/b\\c:d*e?.png",
    "..\\..\\windows\\system32",
    "with\u0000null.png",
    "....//....//x",
  ]) {
    const name = attachmentFileName(att({ name: hostile }));
    // single path segment: no separators, no control characters survive
    assertEquals(name.includes("/"), false, hostile);
    assertEquals(name.includes("\\"), false, hostile);
    // deno-lint-ignore no-control-regex -- asserting control chars are gone
    const CONTROL = /[\x00-\x1f]/;
    assertEquals(CONTROL.test(name), false, hostile);
    // and it resolves back inside the directory it is joined to
    const resolved = new URL(name, "file:///out/attachments/").pathname;
    assertEquals(resolved.startsWith("/out/attachments/"), true, hostile);
  }
});

Deno.test("ordinary punctuation in a name is preserved", () => {
  assertEquals(attachmentFileName(att({ name: "PLACE Support 1-3.png" })), "1844-PLACE Support 1-3.png");
});

Deno.test("an inline image with no file id gets a stable hashed prefix", () => {
  const a = attachmentFileName(att({ fileId: "", url: "https://x.io/logo.png", name: "logo.png" }));
  const b = attachmentFileName(att({ fileId: "", url: "https://x.io/logo.png", name: "logo.png" }));
  assertEquals(a, b);              // stable across runs
  assertEquals(a.startsWith("url"), true);
  const c = attachmentFileName(att({ fileId: "", url: "https://x.io/other.png", name: "logo.png" }));
  assertEquals(a === c, false);    // different url, different file
});

Deno.test("a very long name is truncated", () => {
  const n = attachmentFileName(att({ name: "x".repeat(400) }));
  assertEquals(n.length <= 126, true);
});

Deno.test("downloads a file and records its local path", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${ATTACHMENTS_DIR}`);
    const a = att();
    const s = stats();
    await downloadAttachments([msg([a])], dir, s);
    assertEquals(s, { downloaded: 1, skipped: 0, failed: 0, bytes: 4 });
    assertEquals(a.localPath, "attachments/1844-shot.png");
    assertEquals((await Deno.readFile(`${dir}/${a.localPath}`)).length, 4);
  } finally {
    globalThis.fetch = real;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a file already on disk is not re-fetched", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
  };
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${ATTACHMENTS_DIR}`);
    const s = stats();
    await downloadAttachments([msg([att()])], dir, s);
    const a2 = att();
    await downloadAttachments([msg([a2])], dir, s);   // second run
    assertEquals(calls, 1);
    assertEquals(s.downloaded, 1);
    assertEquals(s.skipped, 1);
    assertEquals(a2.localPath, "attachments/1844-shot.png");
  } finally {
    globalThis.fetch = real;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a 404 is counted and skipped, not fatal", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("nope", { status: 404 }));
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${ATTACHMENTS_DIR}`);
    const a = att();
    const s = stats();
    await downloadAttachments([msg([a])], dir, s);
    assertEquals(s.failed, 1);
    assertEquals(s.downloaded, 0);
    assertEquals(a.localPath, undefined);
  } finally {
    globalThis.fetch = real;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("attachments without a url are left alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // unresolved email attachment id — nothing to fetch
    const a = att({ url: "" });
    const s = stats();
    await downloadAttachments([msg([a])], dir, s);
    assertEquals(s, { downloaded: 0, skipped: 0, failed: 0, bytes: 0 });
    assertEquals(a.localPath, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inline images are skipped by default and included in all mode", () => {
  const inline = att({ kind: "INLINE", fileId: "", url: "https://x.io/logo.png" });
  const real = att({ kind: "IMAGE" });
  assertEquals(shouldDownload(inline, "files"), false);
  assertEquals(shouldDownload(inline, "all"), true);
  assertEquals(shouldDownload(real, "files"), true);
  assertEquals(shouldDownload(real, "all"), true);
  // no url is never downloadable in either mode
  assertEquals(shouldDownload(att({ url: "" }), "all"), false);
});

Deno.test("default mode leaves inline images on disk untouched", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })); };
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${ATTACHMENTS_DIR}`);
    const s = stats();
    await downloadAttachments(
      [msg([att({ kind: "INLINE", fileId: "", url: "https://x.io/l.png" }), att({ kind: "OTHER" })])],
      dir, s,
    );
    assertEquals(calls, 1);        // only the real attachment
    assertEquals(s.downloaded, 1);
  } finally {
    globalThis.fetch = real;
    await Deno.remove(dir, { recursive: true });
  }
});
