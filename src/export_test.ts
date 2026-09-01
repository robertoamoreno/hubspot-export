import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { DumpWriter, writeAll } from "./export.ts";
import type { TicketProperty } from "./tickets.ts";

/** A sink that accepts at most `chunk` bytes per write(), like a short write. */
function shortWriteSink(chunk: number) {
  const written: number[] = [];
  return {
    calls: 0,
    bytes: written,
    // deno-lint-ignore require-await
    async write(p: Uint8Array): Promise<number> {
      this.calls++;
      const n = Math.min(chunk, p.byteLength);
      for (let i = 0; i < n; i++) written.push(p[i]);
      return n;
    },
  };
}

Deno.test("writeAll loops until every byte is written", async () => {
  const sink = shortWriteSink(3);
  const payload = new TextEncoder().encode("abcdefghij"); // 10 bytes
  const n = await writeAll(sink, payload);
  assertEquals(n, 10);
  assertEquals(new Uint8Array(sink.bytes), payload);
  assertEquals(sink.calls, 4); // 3 + 3 + 3 + 1
});

Deno.test("writeAll handles a buffer larger than many short writes", async () => {
  const sink = shortWriteSink(7);
  const payload = new TextEncoder().encode("x".repeat(5000));
  assertEquals(await writeAll(sink, payload), 5000);
  assertEquals(sink.bytes.length, 5000);
});

Deno.test("writeAll throws instead of spinning when no progress is made", async () => {
  // deno-lint-ignore require-await
  const stuck = { async write(_p: Uint8Array): Promise<number> { return 0; } };
  await assertRejects(
    () => writeAll(stuck, new TextEncoder().encode("data")),
    Error,
    "Short write",
  );
});

Deno.test("writeAll on an empty buffer is a no-op", async () => {
  const sink = shortWriteSink(3);
  assertEquals(await writeAll(sink, new Uint8Array(0)), 0);
  assertEquals(sink.calls, 0);
});

const PROPS: TicketProperty[] = [
  { name: "subject", label: "Ticket name" },
  { name: "hs_pipeline", label: "Pipeline" },
];

Deno.test("DumpWriter round-trips a multi-megabyte message body intact", async () => {
  Deno.env.set("HUBSPOT_PORTAL_ID", "12345678");
  const dir = await Deno.makeTempDir();
  try {
    const writer = await DumpWriter.create(dir, PROPS);
    const body = "A".repeat(3 * 1024 * 1024); // 3 MB single CSV field
    await writer.writeTicket({
      ticket: { id: "1", properties: { subject: "big", hs_pipeline: "0" } },
      messages: [{
        id: "m1",
        subject: "s",
        body,
        direction: "INCOMING",
        sender: "a@b.c",
        recipient: "d@e.f",
        timestamp: "2024-01-01T00:00:00Z",
        sourceType: "EMAIL",
      }],
    });
    await writer.close();

    const messages = await Deno.readTextFile(`${dir}/messages.csv`);
    // The 3 MB body must survive in full, not be truncated by a short write.
    assertEquals(messages.includes(body), true);
    assertEquals(messages.trimEnd().split("\n").length, 2); // header + 1 row
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
