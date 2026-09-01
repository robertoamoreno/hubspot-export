import { CsvParseStream } from "@std/csv";
import { csvEscape, writeAll } from "./export.ts";

/**
 * Rewrite a CSV in place, removing columns that are empty in every data row.
 *
 * Most of a ticket export's columns are properties no ticket in the run
 * happens to use — on one production portal, 1326 of 1462. Which ones are
 * empty is only knowable after the last row is written, so this runs as a
 * post-pass over the finished file rather than at write time.
 *
 * Reads the file twice and never holds more than one row in memory, so it
 * stays flat regardless of export size. The output is written to a temp file
 * and renamed over the original, so an interrupted compaction leaves the
 * original intact.
 */
export async function dropEmptyColumns(
  path: string,
): Promise<{ before: number; after: number; rows: number }> {
  // --- pass 1: which columns carry data? ---
  let header: string[] | undefined;
  let populated: boolean[] = [];
  let rows = 0;

  for await (const row of rowsOf(path)) {
    if (!header) {
      header = row;
      populated = new Array(row.length).fill(false);
      continue;
    }
    rows++;
    for (let i = 0; i < row.length && i < populated.length; i++) {
      if (!populated[i] && row[i].trim() !== "") populated[i] = true;
    }
  }

  if (!header) return { before: 0, after: 0, rows: 0 };

  const keep = header.map((_, i) => populated[i]);
  const after = keep.filter(Boolean).length;
  if (after === header.length) {
    return { before: header.length, after, rows };
  }

  // --- pass 2: rewrite keeping only populated columns ---
  const tmp = `${path}.compact`;
  const out = await Deno.open(tmp, { write: true, create: true, truncate: true });
  const encoder = new TextEncoder();
  try {
    for await (const row of rowsOf(path)) {
      const line = row.filter((_, i) => keep[i]).map(csvEscape).join(",") + "\n";
      await writeAll(out, encoder.encode(line));
    }
  } finally {
    out.close();
  }
  await Deno.rename(tmp, path);

  return { before: header.length, after, rows };
}

/** Stream a CSV file row by row, honouring quoted fields and embedded newlines. */
async function* rowsOf(path: string): AsyncGenerator<string[]> {
  const file = await Deno.open(path, { read: true });
  const stream = file.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new CsvParseStream());
  for await (const row of stream) {
    yield row as string[];
  }
}
