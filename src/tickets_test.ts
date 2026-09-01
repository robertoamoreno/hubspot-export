import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchIdsForDateRange,
  fetchTicketIdsByPipeline,
  fetchTicketIdsByYear,
  filterStagePropertiesForPipeline,
  resolvePipeline,
  type TicketPipeline,
} from "./tickets.ts";
import { propertiesCachePath, ticketIdsCachePath } from "./checkpoint.ts";

const PIPELINES: TicketPipeline[] = [
  { id: "0", label: "Support Pipeline", stageIds: ["1", "2"] },
  { id: "12345678", label: "Escalations", stageIds: ["3"] },
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

// --- stage property filtering ----------------------------------------------

const SUPPORT: TicketPipeline = { id: "0", label: "Support", stageIds: ["1", "2", "1358949122"] };
const DESIGN: TicketPipeline = { id: "22278748", label: "Design", stageIds: ["99001", "99002"] };
const ALL = [SUPPORT, DESIGN];

function props(...names: string[]) {
  return names.map((n) => ({ name: n, label: n }));
}

Deno.test("stage properties of other pipelines are dropped", () => {
  const kept = filterStagePropertiesForPipeline(
    props(
      "hs_v2_date_entered_1",           // ours
      "hs_v2_cumulative_time_in_2",     // ours
      "hs_v2_date_exited_99001",        // Design
      "hs_v2_latest_time_in_99002",     // Design
    ),
    SUPPORT,
    ALL,
  ).map((p) => p.name);
  assertEquals(kept, ["hs_v2_date_entered_1", "hs_v2_cumulative_time_in_2"]);
});

Deno.test("long numeric stage ids are handled like short ones", () => {
  const kept = filterStagePropertiesForPipeline(
    props("hs_v2_date_entered_1358949122", "hs_v2_date_entered_99001"),
    SUPPORT,
    ALL,
  ).map((p) => p.name);
  assertEquals(kept, ["hs_v2_date_entered_1358949122"]);
});

Deno.test("non-stage properties are never dropped", () => {
  const names = [
    "subject",
    "hs_pipeline",
    "hs_v2_date_entered_current_stage",   // no stage id suffix
    "custom_field_99001",                 // stage-id suffix but not hs_
    "hs_something_404",                   // hs_ but 404 is not a known stage
  ];
  const kept = filterStagePropertiesForPipeline(props(...names), SUPPORT, ALL)
    .map((p) => p.name);
  assertEquals(kept, names);
});

Deno.test("filtering is a no-op when the pipeline owns every stage", () => {
  const only = [SUPPORT];
  const names = ["hs_v2_date_entered_1", "hs_v2_date_entered_2", "subject"];
  assertEquals(
    filterStagePropertiesForPipeline(props(...names), SUPPORT, only).map((p) => p.name),
    names,
  );
});

Deno.test("a pipeline with no stages still keeps non-stage properties", () => {
  const empty: TicketPipeline = { id: "x", label: "Empty", stageIds: [] };
  const kept = filterStagePropertiesForPipeline(
    props("subject", "hs_v2_date_entered_1"),
    empty,
    [...ALL, empty],
  ).map((p) => p.name);
  assertEquals(kept, ["subject"]);
});

Deno.test("property cache path is keyed by pipeline", () => {
  assertEquals(propertiesCachePath("/o"), "/o/properties.json");
  assertEquals(propertiesCachePath("/o", "0"), "/o/properties_p0.json");
  assertEquals(
    propertiesCachePath("/o", "0") === propertiesCachePath("/o"),
    false,
  );
});
