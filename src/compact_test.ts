import { assertEquals } from "@std/assert";
import { dropEmptyColumns } from "./compact.ts";

async function withCsv(content: string, fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/t.csv`;
  await Deno.writeTextFile(path, content);
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("empty columns are removed, populated ones kept", async () => {
  await withCsv("a,b,c,d\n1,,3,\n4,,6,\n", async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r, { before: 4, after: 2, rows: 2 });
    assertEquals(await Deno.readTextFile(p), "a,c\n1,3\n4,6\n");
  });
});

Deno.test("a column with data in only one row is kept", async () => {
  await withCsv("a,b\n,\n,x\n,\n", async (p) => {
    await dropEmptyColumns(p);
    assertEquals(await Deno.readTextFile(p), "b\n\nx\n\n");
  });
});

Deno.test("whitespace-only cells count as empty", async () => {
  await withCsv('a,b\n1,"   "\n2,"\t"\n', async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r.after, 1);
    assertEquals(await Deno.readTextFile(p), "a\n1\n2\n");
  });
});

Deno.test("quoted fields with commas and newlines survive the rewrite", async () => {
  const body = 'line one\nline two, with comma and "quotes"';
  await withCsv(`a,b,c\n1,"${body.replace(/"/g, '""')}",\n`, async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r.after, 2);
    const out = await Deno.readTextFile(p);
    // round-trip the rewritten file to confirm the body is byte-identical
    const { parse } = await import("@std/csv");
    const rows = parse(out);
    assertEquals(rows[1][1], body);
  });
});

Deno.test("a file with no empty columns is left untouched", async () => {
  const original = "a,b\n1,2\n3,4\n";
  await withCsv(original, async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r, { before: 2, after: 2, rows: 2 });
    assertEquals(await Deno.readTextFile(p), original);
  });
});

Deno.test("a header-only file drops every column", async () => {
  await withCsv("a,b,c\n", async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r, { before: 3, after: 0, rows: 0 });
  });
});

Deno.test("an empty file is handled", async () => {
  await withCsv("", async (p) => {
    assertEquals(await dropEmptyColumns(p), { before: 0, after: 0, rows: 0 });
  });
});

Deno.test("no temp file is left behind", async () => {
  await withCsv("a,b\n1,\n", async (p) => {
    await dropEmptyColumns(p);
    let exists = true;
    try { await Deno.stat(`${p}.compact`); } catch { exists = false; }
    assertEquals(exists, false);
  });
});

Deno.test("scales to a wide, mostly-empty file", async () => {
  // Shape of a real export: 1462 columns, ~9% populated.
  const cols = 1462;
  const populated = new Set(Array.from({ length: 136 }, (_, i) => i * 10 % cols));
  const header = Array.from({ length: cols }, (_, i) => `c${i}`);
  const row = Array.from({ length: cols }, (_, i) => populated.has(i) ? "x" : "");
  const csv = [header.join(","), ...Array(50).fill(row.join(","))].join("\n") + "\n";
  await withCsv(csv, async (p) => {
    const r = await dropEmptyColumns(p);
    assertEquals(r.before, cols);
    assertEquals(r.after, populated.size);
    assertEquals(r.rows, 50);
  });
});
