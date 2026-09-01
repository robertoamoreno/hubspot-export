import type { TicketProperty } from "./tickets.ts";

export interface CheckpointData {
  /**
   * Index into the ticket id list of the first ticket not yet processed.
   * Everything before this is written to the output files.
   *
   * This is an absolute ticket offset, not a chunk number, so CHUNK_SIZE can
   * change between runs without shifting where the resume lands.
   */
  nextTicketIndex?: number;
  /**
   * Legacy chunk index from before nextTicketIndex existed. Only meaningful
   * alongside the CHUNK_SIZE the run used, which was never recorded.
   */
  nextChunk?: number;
  /** Year filter used for this run (undefined = all tickets). */
  year?: number;
  /** Pipeline id filter used for this run (undefined = all pipelines). */
  pipeline?: string;
  /** Byte positions of output files at the end of the last completed chunk. */
  filePositions: {
    ticketsCsv: number;
    messagesCsv: number;
    dumpJsonl: number;
  };
  /** Cumulative stats up to (but not including) nextChunk. */
  stats: {
    processed: number;
    totalEmails: number;
    totalConversations: number;
    errors: number;
    /** Tickets exported with known-missing email data. Absent in old checkpoints. */
    incompleteTickets?: number;
  };
}

/**
 * Whether a checkpoint's file positions can be safely resumed from.
 *
 * Earlier versions read these positions off an append-mode file descriptor,
 * which reports offset 0 until the first write in the process. A chunk that
 * wrote no tickets therefore recorded {0, 0, 0}, and resuming from it would
 * truncate every output file — headers included — to nothing.
 *
 * A checkpoint claiming completed chunks must have non-zero CSV positions,
 * because both CSVs get a header row before any ticket is written.
 * dump.jsonl legitimately stays at 0 if no ticket has been written yet.
 */
export function hasValidFilePositions(cp: CheckpointData): boolean {
  const claimsProgress = (cp.nextTicketIndex ?? cp.nextChunk ?? 0) > 0;
  const p = cp.filePositions;
  if (!p) return false;
  const values = [p.ticketsCsv, p.messagesCsv, p.dumpJsonl];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    return false;
  }
  if (claimsProgress && (p.ticketsCsv === 0 || p.messagesCsv === 0)) {
    return false;
  }
  return true;
}

/** Save checkpoint atomically (write tmp + rename). */
export async function saveCheckpoint(
  outputDir: string,
  data: CheckpointData,
): Promise<void> {
  const path = `${outputDir}/checkpoint.json`;
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, path);
}

/** Load checkpoint, or return null if none exists. */
export async function loadCheckpoint(
  outputDir: string,
): Promise<CheckpointData | null> {
  try {
    const text = await Deno.readTextFile(`${outputDir}/checkpoint.json`);
    return JSON.parse(text) as CheckpointData;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Remove checkpoint file (called on successful completion). */
export async function clearCheckpoint(outputDir: string): Promise<void> {
  try {
    await Deno.remove(`${outputDir}/checkpoint.json`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Cache filename for one filter combination. The pipeline and year are part of
 * the name so a filtered run can never reuse a cache built for a different
 * filter (or for the whole account).
 */
export function ticketIdsCachePath(
  outputDir: string,
  year?: number,
  pipelineId?: string,
): string {
  const parts = ["ticket_ids"];
  if (pipelineId) parts.push(`p${pipelineId.replace(/[^a-zA-Z0-9]+/g, "-")}`);
  if (year) parts.push(String(year));
  return `${outputDir}/${parts.join("_")}.json`;
}

/** Cache ticket IDs to disk so we never re-fetch on resume. */
export async function saveTicketIds(
  outputDir: string,
  ids: string[],
  year?: number,
  pipelineId?: string,
): Promise<void> {
  await Deno.writeTextFile(
    ticketIdsCachePath(outputDir, year, pipelineId),
    JSON.stringify(ids),
  );
}

/** Load cached ticket IDs, or return null if not cached. */
export async function loadTicketIds(
  outputDir: string,
  year?: number,
  pipelineId?: string,
): Promise<string[] | null> {
  try {
    const text = await Deno.readTextFile(
      ticketIdsCachePath(outputDir, year, pipelineId),
    );
    return JSON.parse(text) as string[];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Cache property definitions to disk. */
export async function saveProperties(
  outputDir: string,
  properties: TicketProperty[],
): Promise<void> {
  await Deno.writeTextFile(
    `${outputDir}/properties.json`,
    JSON.stringify(properties),
  );
}

/** Load cached property definitions, or return null if not cached. */
export async function loadProperties(
  outputDir: string,
): Promise<TicketProperty[] | null> {
  try {
    const text = await Deno.readTextFile(`${outputDir}/properties.json`);
    return JSON.parse(text) as TicketProperty[];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
