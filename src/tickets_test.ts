import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchIdsForDateRange,
  fetchTicketIdsByPipeline,
  fetchTicketIdsByYear,
  resolvePipeline,
  type TicketPipeline,
} from "./tickets.ts";
import { ticketIdsCachePath } from "./checkpoint.ts";

const PIPELINES: TicketPipeline[] = [
  { id: "0", label: "Support Pipeline" },
  { id: "12345678", label: "Escalations" },
];

// --- pipeline resolution ---------------------------------------------------

Deno.test("resolvePipeline matches on id", () => {
  assertEquals(resolvePipeline("12345678", PIPELINES).label, "Escalations");
});

Deno.test("resolvePipeline matches on label, case- and space-insensitively", () => {
  assertEquals(resolvePipeline("support pipeline", PIPELINES).id, "0");
  assertEquals(resolvePipeline("  Escalations  ", PIPELINES).id, "12345678");
});

Deno.test("resolvePipeline throws listing the valid pipelines", () => {
  const err = (() => {
    try { resolvePipeline("Suport Pipeline", PIPELINES); } catch (e) { return e as Error; }
  })()!;
  assertStringIncludes(err.message, 'Unknown pipeline "Suport Pipeline"');
  assertStringIncludes(err.message, "Support Pipeline");
  assertStringIncludes(err.message, "Escalations");
});

// --- cache keys ------------------------------------------------------------

Deno.test("cache path keeps each filter combination separate", () => {
  assertEquals(ticketIdsCachePath("/o"), "/o/ticket_ids.json");
  assertEquals(ticketIdsCachePath("/o", 2025), "/o/ticket_ids_2025.json");
  assertEquals(ticketIdsCachePath("/o", undefined, "0"), "/o/ticket_ids_p0.json");
  assertEquals(ticketIdsCachePath("/o", 2025, "0"), "/o/ticket_ids_p0_2025.json");
  // A pipeline-filtered run must never collide with the whole-account cache
  assertEquals(
    ticketIdsCachePath("/o", 2025, "0") === ticketIdsCachePath("/o", 2025),
    false,
  );
});

Deno.test("cache path sanitises ids that are not filesystem safe", () => {
  assertEquals(ticketIdsCachePath("/o", undefined, "a/b c"), "/o/ticket_ids_pa-b-c.json");
});

// --- search request shape --------------------------------------------------

interface SearchBody {
  filterGroups: Array<{ filters: Array<Record<string, string>> }>;
}

function stubSearch(
  reply: (body: SearchBody, span: number) => { total: number; results: Array<{ id: string }> },
) {
  const real = globalThis.fetch;
  const bodies: SearchBody[] = [];
  globalThis.fetch = (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as SearchBody;
    bodies.push(body);
    const f = body.filterGroups[0].filters;
    const from = Number(f.find((x) => x.operator === "GTE")!.value);
    const to = Number(f.find((x) => x.operator === "LT")!.value);
    return Promise.resolve(
      new Response(JSON.stringify(reply(body, to - from)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

function pipelineFilters(bodies: SearchBody[]) {
  return bodies.map((b) =>
    b.filterGroups[0].filters.find((f) => f.propertyName === "hs_pipeline")
  );
}

Deno.test("pipeline filter is sent on every search request", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  const stub = stubSearch(() => ({ total: 2, results: [{ id: "a" }, { id: "b" }] }));
  try {
    const ids = await fetchTicketIdsByPipeline("12345678");
    assertEquals(ids, ["a", "b"]);
    assertEquals(stub.bodies.length > 0, true);
    for (const f of pipelineFilters(stub.bodies)) {
      assertEquals(f, { propertyName: "hs_pipeline", operator: "EQ", value: "12345678" });
    }
  } finally {
    stub.restore();
  }
});

Deno.test("year filter carries the pipeline through every month", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  const stub = stubSearch(() => ({ total: 1, results: [{ id: "x" }] }));
  try {
    const ids = await fetchTicketIdsByYear(2024, "0");
    assertEquals(ids.length, 12); // one per month of a fully past year
    for (const f of pipelineFilters(stub.bodies)) {
      assertEquals(f?.value, "0");
    }
  } finally {
    stub.restore();
  }
});

Deno.test("no pipeline means no hs_pipeline filter", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  const stub = stubSearch(() => ({ total: 1, results: [{ id: "x" }] }));
  try {
    await fetchTicketIdsByYear(2024);
    assertEquals(pipelineFilters(stub.bodies).every((f) => f === undefined), true);
  } finally {
    stub.restore();
  }
});

// --- 10k splitting ---------------------------------------------------------

Deno.test("an oversized range is halved until it fits", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  // >1000ms windows look oversized; anything smaller returns one id.
  const stub = stubSearch((body, span) => {
    if (span > 1000) return { total: 20000, results: [] };
    const from = body.filterGroups[0].filters.find((f) => f.operator === "GTE")!.value;
    return { total: 1, results: [{ id: `id-${from}` }] };
  });
  try {
    const ids = await fetchIdsForDateRange(0, 4000, "test");
    // 4000ms → 4 leaf ranges of 1000ms, in ascending order
    assertEquals(ids, ["id-0", "id-1000", "id-2000", "id-3000"]);
  } finally {
    stub.restore();
  }
});

Deno.test("splitting stops instead of recursing forever on a tiny range", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  // Always oversized: halving a range this small yields midMs === fromMs, so
  // the old code recursed on an identical range until the stack blew.
  const stub = stubSearch(() => ({ total: 20000, results: [{ id: "only" }] }));
  try {
    const ids = await fetchIdsForDateRange(0, 500, "tiny");
    assertEquals(ids, ["only"]); // returns what it can rather than hanging
  } finally {
    stub.restore();
  }
});

Deno.test("an empty range short-circuits without paginating", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  const stub = stubSearch(() => ({ total: 0, results: [] }));
  try {
    assertEquals(await fetchIdsForDateRange(0, 10_000, "empty"), []);
    assertEquals(stub.bodies.length, 1); // probe only
  } finally {
    stub.restore();
  }
});

Deno.test("resolvePipeline rejects when the portal has no pipelines", () => {
  let threw = false;
  try { resolvePipeline("anything", []); } catch { threw = true; }
  assertEquals(threw, true);
});
