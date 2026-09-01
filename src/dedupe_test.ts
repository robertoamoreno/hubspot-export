import { assertEquals } from "@std/assert";
import { dedupeMessages } from "./dedupe.ts";
import type { Message } from "./export.ts";

function email(body: string, timestamp: string, id = "e1"): Message {
  return {
    id, subject: "s", body, direction: "OUTGOING", directionRaw: "EMAIL",
    sender: "a@b.c", recipient: "d@e.f", timestamp, sourceType: "EMAIL",
  };
}
function convo(body: string, timestamp: string, id = "c1", threadId = "t9"): Message {
  return {
    id, subject: "s", body, direction: "OUTGOING", directionRaw: "OUTGOING",
    sender: "a@b.c", recipient: "d@e.f", timestamp, sourceType: "CONVERSATION", threadId,
  };
}

Deno.test("identical copies from both sources collapse to one", () => {
  const r = dedupeMessages([
    email("Hello there", "2025-01-01T10:00:00.000Z"),
    convo("Hello there", "2025-01-01T10:00:00.000Z"),
  ]);
  assertEquals(r.removed, 1);
  assertEquals(r.messages.length, 1);
});

Deno.test("the email copy survives and keeps the conversation's thread id", () => {
  const r = dedupeMessages([
    email("Hello there", "2025-01-01T10:00:00.000Z", "email-123"),
    convo("Hello there", "2025-01-01T10:00:00.000Z", "convo-456", "thread-789"),
  ]);
  const [m] = r.messages;
  assertEquals(m.sourceType, "EMAIL");
  assertEquals(m.id, "email-123");
  assertEquals("threadId" in m ? m.threadId : undefined, "thread-789");
});

Deno.test("order of the two copies does not matter", () => {
  const r = dedupeMessages([
    convo("Hello there", "2025-01-01T10:00:00.000Z", "convo-456", "thread-789"),
    email("Hello there", "2025-01-01T10:00:00.000Z", "email-123"),
  ]);
  assertEquals(r.messages.length, 1);
  assertEquals(r.messages[0].sourceType, "EMAIL");
  assertEquals(r.messages[0].id, "email-123");
});

Deno.test("copies differing only in whitespace and case still match", () => {
  const r = dedupeMessages([
    email("Hello   there\nfriend", "2025-01-01T10:00:00.000Z"),
    convo("hello there friend", "2025-01-01T10:00:00.000Z"),
  ]);
  assertEquals(r.removed, 1);
});

Deno.test("a 5s skew between the two sources still matches", () => {
  // Widest gap seen in production was ~5s.
  const r = dedupeMessages([
    email("Hello there", "2025-01-01T10:00:00.000Z"),
    convo("Hello there", "2025-01-01T10:00:05.037Z"),
  ]);
  assertEquals(r.removed, 1);
});

Deno.test("the same body sent hours apart stays two messages", () => {
  const r = dedupeMessages([
    email("Thanks!", "2025-01-01T10:00:00.000Z", "a"),
    email("Thanks!", "2025-01-01T14:00:00.000Z", "b"),
  ]);
  assertEquals(r.removed, 0);
  assertEquals(r.messages.map((m) => m.id), ["a", "b"]);
});

Deno.test("different bodies at the same instant stay two messages", () => {
  const r = dedupeMessages([
    email("First message", "2025-01-01T10:00:00.000Z", "a"),
    convo("Second message", "2025-01-01T10:00:00.000Z", "b"),
  ]);
  assertEquals(r.removed, 0);
  assertEquals(r.messages.length, 2);
});

Deno.test("empty bodies are never treated as duplicates of each other", () => {
  const r = dedupeMessages([
    email("", "2025-01-01T10:00:00.000Z", "a"),
    convo("", "2025-01-01T10:00:00.000Z", "b"),
  ]);
  assertEquals(r.removed, 0);
  assertEquals(r.messages.length, 2);
});

Deno.test("surviving messages keep their original order", () => {
  const r = dedupeMessages([
    email("one", "2025-01-01T10:00:00.000Z", "a"),
    convo("one", "2025-01-01T10:00:00.000Z", "b"),
    email("two", "2025-01-01T11:00:00.000Z", "c"),
    email("three", "2025-01-01T12:00:00.000Z", "d"),
  ]);
  assertEquals(r.messages.map((m) => m.id), ["a", "c", "d"]);
  assertEquals(r.removed, 1);
});

Deno.test("an unparseable timestamp falls back to body-only matching", () => {
  const r = dedupeMessages([
    email("Hello there", "", "a"),
    convo("Hello there", "", "b"),
  ]);
  assertEquals(r.removed, 1);
  assertEquals(r.messages[0].id, "a");
});

Deno.test("an empty message list is handled", () => {
  assertEquals(dedupeMessages([]), { messages: [], removed: 0 });
});

Deno.test("three copies of one message collapse to one", () => {
  const r = dedupeMessages([
    convo("Hello", "2025-01-01T10:00:00.000Z", "c1", "t1"),
    email("Hello", "2025-01-01T10:00:01.000Z", "e1"),
    convo("Hello", "2025-01-01T10:00:02.000Z", "c2", "t2"),
  ]);
  assertEquals(r.removed, 2);
  assertEquals(r.messages.length, 1);
  assertEquals(r.messages[0].sourceType, "EMAIL");
});
