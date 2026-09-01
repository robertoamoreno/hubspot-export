import { assertEquals } from "@std/assert";
import { normalizeDirection, stripHtml } from "./utils.ts";

Deno.test("normalizeDirection maps conversation values", () => {
  assertEquals(normalizeDirection("INCOMING"), "INCOMING");
  assertEquals(normalizeDirection("OUTGOING"), "OUTGOING");
});

Deno.test("normalizeDirection maps HubSpot's email vocabulary", () => {
  assertEquals(normalizeDirection("INCOMING_EMAIL"), "INCOMING");
  // HubSpot uses bare "EMAIL" for a message sent from the CRM, not "OUTGOING"
  assertEquals(normalizeDirection("EMAIL"), "OUTGOING");
  assertEquals(normalizeDirection("FORWARDED_EMAIL"), "OUTGOING");
});

Deno.test("normalizeDirection is case- and whitespace-insensitive", () => {
  assertEquals(normalizeDirection("  incoming_email "), "INCOMING");
  assertEquals(normalizeDirection("Outgoing"), "OUTGOING");
});

Deno.test("normalizeDirection falls back to UNKNOWN", () => {
  assertEquals(normalizeDirection(""), "UNKNOWN");
  assertEquals(normalizeDirection("SOMETHING_NEW"), "UNKNOWN");
});

Deno.test("every observed production value maps to a real direction", () => {
  // The four values the sample export actually produced.
  for (const raw of ["EMAIL", "INCOMING_EMAIL", "INCOMING", "OUTGOING"]) {
    assertEquals(normalizeDirection(raw) === "UNKNOWN", false, `${raw} unmapped`);
  }
});

Deno.test("stripHtml converts markup to plain text", () => {
  assertEquals(stripHtml("<p>hello <b>world</b></p>"), "hello world");
  assertEquals(stripHtml("  plain  "), "plain");
  assertEquals(stripHtml(""), "");
});
