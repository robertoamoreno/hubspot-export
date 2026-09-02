import { assertEquals } from "@std/assert";
import { decodeEntities, parseAttachmentIds, parseInlineImages } from "./attachments.ts";

Deno.test("parseAttachmentIds splits HubSpot's semicolon list", () => {
  assertEquals(parseAttachmentIds("184474135197;184472068650"), [
    "184474135197",
    "184472068650",
  ]);
  assertEquals(parseAttachmentIds("184466885287"), ["184466885287"]);
});

Deno.test("parseAttachmentIds handles empty and messy input", () => {
  assertEquals(parseAttachmentIds(""), []);
  assertEquals(parseAttachmentIds(null), []);
  assertEquals(parseAttachmentIds(undefined), []);
  assertEquals(parseAttachmentIds(" 1 ; ;2; "), ["1", "2"]);
});

Deno.test("parseInlineImages pulls src urls out of an HTML body", () => {
  const found = parseInlineImages(
    `<p>hi</p><img src="https://cdn.example.com/a/screenshot.png" alt="x">`,
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].url, "https://cdn.example.com/a/screenshot.png");
  assertEquals(found[0].name, "screenshot.png");
  assertEquals(found[0].kind, "INLINE");
  assertEquals(found[0].fileId, "");
});

Deno.test("parseInlineImages handles single quotes and extra attributes", () => {
  const found = parseInlineImages(
    `<img width="10" src='https://x.io/b.jpg' class="c">`,
  );
  assertEquals(found.map((f) => f.url), ["https://x.io/b.jpg"]);
});

Deno.test("parseInlineImages skips cid: and data: sources", () => {
  // cid: points at a MIME part the API never exposes; data: is already inline.
  const found = parseInlineImages(
    `<img src="cid:ii_abc"><img src="data:image/png;base64,AAA"><img src="https://x.io/c.gif">`,
  );
  assertEquals(found.map((f) => f.url), ["https://x.io/c.gif"]);
});

Deno.test("parseInlineImages de-duplicates a repeated image", () => {
  const found = parseInlineImages(
    `<img src="https://x.io/logo.png"><p>hi</p><img src="https://x.io/logo.png">`,
  );
  assertEquals(found.length, 1);
});

Deno.test("parseInlineImages decodes a url-encoded filename", () => {
  const found = parseInlineImages(
    `<img src="https://h.net/hubfs/PLACE%20Support%201-3.png">`,
  );
  assertEquals(found[0].name, "PLACE Support 1-3.png");
});

Deno.test("parseInlineImages copes with a url it cannot parse", () => {
  const found = parseInlineImages(`<img src="/relative/path.png">`);
  assertEquals(found.length, 1);
  assertEquals(found[0].name, "image");
});

Deno.test("parseInlineImages returns nothing for HTML without images", () => {
  assertEquals(parseInlineImages("<p>just text</p>"), []);
  assertEquals(parseInlineImages(""), []);
});

Deno.test("decodeEntities restores an ampersand in a query string", () => {
  assertEquals(
    decodeEntities("https://h.net/proxy?portalId=1&amp;url=https://x.io/a.png"),
    "https://h.net/proxy?portalId=1&url=https://x.io/a.png",
  );
});

Deno.test("decodeEntities handles named, decimal and hex forms", () => {
  assertEquals(decodeEntities("a&amp;b&lt;c&gt;d&quot;e&#39;f&#x27;g"), `a&b<c>d"e'f'g`);
});

Deno.test("decodeEntities leaves an ordinary url alone", () => {
  const u = "https://x.io/a.png?a=1&b=2";
  assertEquals(decodeEntities(u), u);
});

Deno.test("inline image urls are entity-decoded", () => {
  // Regression: HubSpot's content proxy links 401'd because &amp; survived.
  const found = parseInlineImages(
    `<img src="https://api-na1.hubspot.com/contentproxy/v1/proxy/redirect?portalId=1234567&amp;url=https://x.io/a.png">`,
  );
  assertEquals(found[0].url.includes("&amp;"), false);
  assertEquals(found[0].url.includes("&url="), true);
});
