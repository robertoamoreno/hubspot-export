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
    nextTicketIndex: 10,
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

// --- resume offset is independent of CHUNK_SIZE ----------------------------

Deno.test("checkpoint records an absolute ticket offset, not a chunk index", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A run with CHUNK_SIZE=25 that completed 3 chunks stops at ticket 75.
    await saveCheckpoint(dir, cp({ nextChunk: undefined, nextTicketIndex: 75 }));
    const loaded = (await loadCheckpoint(dir))!;
    // Re-running with any CHUNK_SIZE must resume at the same ticket.
    assertEquals(loaded.nextTicketIndex, 75);
    assertEquals(loaded.nextChunk, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hasValidFilePositions understands progress from either field", () => {
  const zero = { ticketsCsv: 0, messagesCsv: 0, dumpJsonl: 0 };
  // Legacy shape: progress claimed via nextChunk
  assertEquals(
    hasValidFilePositions(cp({ nextChunk: 2, nextTicketIndex: undefined, filePositions: zero })),
    false,
  );
  // New shape: progress claimed via nextTicketIndex
  assertEquals(
    hasValidFilePositions(cp({ nextChunk: undefined, nextTicketIndex: 75, filePositions: zero })),
    false,
  );
  // No progress claimed at all — zero positions are legitimate
  assertEquals(
    hasValidFilePositions(cp({ nextChunk: undefined, nextTicketIndex: 0, filePositions: zero })),
    true,
  );
});
