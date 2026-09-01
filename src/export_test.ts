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

// --- checkpoint file positions -------------------------------------------

function ticketDump(id: string, messageCount: number) {
  return {
    ticket: { id, properties: { subject: `t${id}`, hs_pipeline: "0" } },
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `${id}-m${i}`,
      subject: "hello, world",           // comma forces CSV quoting
      body: `line one\nline two ${i}`,   // newline forces CSV quoting
      direction: "INCOMING",
      sender: "a@b.c",
      recipient: "d@e.f",
      timestamp: "2024-01-01T00:00:00Z",
      sourceType: "EMAIL" as const,
    })),
  };
}

async function sizes(dir: string) {
  return {
    ticketsCsv: (await Deno.stat(`${dir}/tickets.csv`)).size,
    messagesCsv: (await Deno.stat(`${dir}/messages.csv`)).size,
    dumpJsonl: (await Deno.stat(`${dir}/dump.jsonl`)).size,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  Deno.env.set("HUBSPOT_PORTAL_ID", "12345678");
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("getFilePositions matches real file sizes on a fresh run", async () => {
  await withTempDir(async (dir) => {
    const writer = await DumpWriter.create(dir, PROPS);
    // Positions must be correct even before any ticket is written (headers only).
    assertEquals(writer.getFilePositions(), await sizes(dir));

    for (const id of ["1", "2", "3"]) await writer.writeTicket(ticketDump(id, 2));
    assertEquals(writer.getFilePositions(), await sizes(dir));
    await writer.close();
  });
});

Deno.test("getFilePositions matches real file sizes after a resume", async () => {
  await withTempDir(async (dir) => {
    const first = await DumpWriter.create(dir, PROPS);
    await first.writeTicket(ticketDump("1", 3));
    const checkpoint = first.getFilePositions();
    await first.close();

    const second = await DumpWriter.create(dir, PROPS, checkpoint);
    await second.writeTicket(ticketDump("2", 1));
    assertEquals(second.getFilePositions(), await sizes(dir));
    await second.close();
  });
});

Deno.test("a resumed chunk that writes nothing keeps the previous positions", async () => {
  // Regression: positions used to be read from an append-mode fd, which
  // reports 0 until the first write. An empty chunk checkpointed {0,0,0}.
  await withTempDir(async (dir) => {
    const first = await DumpWriter.create(dir, PROPS);
    await first.writeTicket(ticketDump("1", 2));
    const checkpoint = first.getFilePositions();
    await first.close();

    const second = await DumpWriter.create(dir, PROPS, checkpoint);
    // ...no writeTicket calls at all (every ticket id in the chunk was deleted)
    const after = second.getFilePositions();
    await second.close();

    assertEquals(after, checkpoint);
    assertEquals(after, await sizes(dir));
    assertEquals(after.ticketsCsv > 0, true);
  });
});

Deno.test("an empty chunk followed by a resume does not destroy the export", async () => {
  // End-to-end version of the data-loss bug: chunk 1 writes tickets, chunk 2
  // writes nothing, then the run is interrupted and resumed from chunk 3.
  await withTempDir(async (dir) => {
    const w1 = await DumpWriter.create(dir, PROPS);
    await w1.writeTicket(ticketDump("1", 2));
    await w1.writeTicket(ticketDump("2", 1));
    const afterChunk1 = w1.getFilePositions();
    await w1.close();

    const w2 = await DumpWriter.create(dir, PROPS, afterChunk1);
    const afterChunk2 = w2.getFilePositions(); // empty chunk
    await w2.close();

    const w3 = await DumpWriter.create(dir, PROPS, afterChunk2);
    await w3.writeTicket(ticketDump("3", 1));
    await w3.close();

    const jsonl = (await Deno.readTextFile(`${dir}/dump.jsonl`)).trimEnd().split("\n");
    assertEquals(jsonl.length, 3);
    assertEquals(jsonl.map((l) => JSON.parse(l).ticket.id), ["1", "2", "3"]);

    const tickets = (await Deno.readTextFile(`${dir}/tickets.csv`)).trimEnd().split("\n");
    assertEquals(tickets[0].startsWith("Ticket name,Pipeline"), true); // header intact, written once
    assertEquals(tickets.length, 4);
  });
});

Deno.test("resume truncates a partially written trailing row", async () => {
  await withTempDir(async (dir) => {
    const w1 = await DumpWriter.create(dir, PROPS);
    await w1.writeTicket(ticketDump("1", 1));
    const good = w1.getFilePositions();
    await w1.close();

    // Simulate a crash midway through the next chunk's output.
    await Deno.writeTextFile(`${dir}/dump.jsonl`, '{"ticket":{"id":"2","prop', {
      append: true,
    });

    const w2 = await DumpWriter.create(dir, PROPS, good);
    await w2.writeTicket(ticketDump("3", 1));
    await w2.close();

    const jsonl = (await Deno.readTextFile(`${dir}/dump.jsonl`)).trimEnd().split("\n");
    assertEquals(jsonl.map((l) => JSON.parse(l).ticket.id), ["1", "3"]);
  });
});

Deno.test("resume refuses to grow a file that is shorter than the checkpoint", async () => {
  await withTempDir(async (dir) => {
    const w1 = await DumpWriter.create(dir, PROPS);
    await w1.writeTicket(ticketDump("1", 1));
    const pos = w1.getFilePositions();
    await w1.close();

    // Output truncated behind the checkpoint's back (partial copy, disk full...).
    await Deno.truncate(`${dir}/dump.jsonl`, 5);

    await assertRejects(
      () => DumpWriter.create(dir, PROPS, pos),
      Error,
      "out of sync",
    );
  });
});
