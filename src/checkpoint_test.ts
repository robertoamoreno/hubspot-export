import { assertEquals } from "@std/assert";
import {
  type CheckpointData,
  clearCheckpoint,
  hasValidFilePositions,
  loadCheckpoint,
  saveCheckpoint,
} from "./checkpoint.ts";

function cp(partial: Partial<CheckpointData> = {}): CheckpointData {
  return {
    nextChunk: 2,
    filePositions: { ticketsCsv: 500, messagesCsv: 900, dumpJsonl: 4000 },
    stats: { processed: 10, totalEmails: 5, totalConversations: 3, errors: 0 },
    ...partial,
  };
}

Deno.test("hasValidFilePositions accepts a normal checkpoint", () => {
  assertEquals(hasValidFilePositions(cp()), true);
});

Deno.test("hasValidFilePositions rejects all-zero positions past chunk 0", () => {
  // What the old append-mode seek produced for a chunk that wrote nothing.
  assertEquals(
    hasValidFilePositions(
      cp({ filePositions: { ticketsCsv: 0, messagesCsv: 0, dumpJsonl: 0 } }),
    ),
    false,
  );
});

Deno.test("hasValidFilePositions rejects a zero CSV position past chunk 0", () => {
  assertEquals(
    hasValidFilePositions(
      cp({ filePositions: { ticketsCsv: 0, messagesCsv: 900, dumpJsonl: 4000 } }),
    ),
    false,
  );
});

Deno.test("hasValidFilePositions allows dump.jsonl at 0 when no ticket was written", () => {
  // Headers make both CSVs non-zero, but jsonl only grows per ticket.
  assertEquals(
    hasValidFilePositions(
      cp({ nextChunk: 1, filePositions: { ticketsCsv: 120, messagesCsv: 95, dumpJsonl: 0 } }),
    ),
    true,
  );
});

Deno.test("hasValidFilePositions rejects negative and non-finite positions", () => {
  for (const bad of [-1, NaN, Infinity]) {
    assertEquals(
      hasValidFilePositions(
        cp({ filePositions: { ticketsCsv: bad, messagesCsv: 900, dumpJsonl: 4000 } }),
      ),
      false,
      `expected ${bad} to be rejected`,
    );
  }
});

Deno.test("hasValidFilePositions rejects a checkpoint with no positions at all", () => {
  assertEquals(
    hasValidFilePositions({ ...cp(), filePositions: undefined } as unknown as CheckpointData),
    false,
  );
});

Deno.test("checkpoint round-trips through disk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadCheckpoint(dir), null);

    const data = cp({ year: 2025 });
    await saveCheckpoint(dir, data);
    assertEquals(await loadCheckpoint(dir), data);

    // No .tmp file left behind by the atomic write.
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names, ["checkpoint.json"]);

    await clearCheckpoint(dir);
    assertEquals(await loadCheckpoint(dir), null);
    await clearCheckpoint(dir); // idempotent
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an all-tickets checkpoint round-trips year as undefined", () => {
  // JSON drops `year: undefined`, so a re-read must still compare equal to
  // an unset YEAR env var (main.ts uses `checkpoint.year !== YEAR`).
  const parsed = JSON.parse(JSON.stringify(cp())) as CheckpointData;
  assertEquals(parsed.year, undefined);
});
