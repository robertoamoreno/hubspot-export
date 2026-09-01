import { assertEquals } from "@std/assert";
import { batchGetEmailAssociations, fetchWithSplit } from "./emails.ts";
import { errorStatus, HubSpotApiError, isSplittable } from "./hubspot.ts";

function apiError(status: number) {
  return new HubSpotApiError(status, "/test", "boom");
}

Deno.test("errorStatus reads a direct API error and an SDK-style error", () => {
  assertEquals(errorStatus(apiError(404)), 404);
  assertEquals(errorStatus({ code: 400 }), 400);       // HubSpot SDK shape
  assertEquals(errorStatus(new TypeError("network")), undefined);
  assertEquals(errorStatus(null), undefined);
});

Deno.test("isSplittable only for per-record 4xx", () => {
  assertEquals(isSplittable(apiError(400)), true);
  assertEquals(isSplittable(apiError(404)), true);
  assertEquals(isSplittable({ code: 400 }), true);
  // API unhealthy or exhausted backoff — splitting would just multiply load
  assertEquals(isSplittable(apiError(429)), false);
  assertEquals(isSplittable(apiError(500)), false);
  assertEquals(isSplittable(apiError(503)), false);
  assertEquals(isSplittable(new TypeError("network")), false);
});

Deno.test("fetchWithSplit reports nothing failed on success", async () => {
  let calls = 0;
  // deno-lint-ignore require-await
  const failed = await fetchWithSplit(["a", "b", "c"], async () => { calls++; }, "test");
  assertEquals(failed, []);
  assertEquals(calls, 1);
});

Deno.test("fetchWithSplit isolates the one bad record and salvages the rest", async () => {
  const seen: string[] = [];
  const failed = await fetchWithSplit(
    ["1", "2", "3", "BAD", "5", "6", "7", "8"],
    // deno-lint-ignore require-await
    async (ids) => {
      if (ids.includes("BAD")) throw apiError(400);
      seen.push(...ids);
    },
    "test",
  );
  assertEquals(failed, ["BAD"]);
  assertEquals(seen.sort(), ["1", "2", "3", "5", "6", "7", "8"]);
});

Deno.test("fetchWithSplit reports every id when they are all bad", async () => {
  const failed = await fetchWithSplit(
    ["a", "b"],
    // deno-lint-ignore require-await
    async () => { throw apiError(400); },
    "test",
  );
  assertEquals(failed.sort(), ["a", "b"]);
});

Deno.test("fetchWithSplit does not split on a server-side failure", async () => {
  let calls = 0;
  const ids = Array.from({ length: 64 }, (_, i) => String(i));
  const failed = await fetchWithSplit(
    ids,
    // deno-lint-ignore require-await
    async () => { calls++; throw apiError(503); },
    "test",
  );
  assertEquals(failed, ids);   // whole batch reported, nothing silently dropped
  assertEquals(calls, 1);      // and no retry storm
});

Deno.test("batchGetEmailAssociations surfaces the tickets it could not read", async () => {
  Deno.env.set("HUBSPOT_ACCESS_TOKEN", "test-token");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const ids: string[] = JSON.parse(String(init?.body)).inputs.map(
      (i: { id: string }) => i.id,
    );
    if (ids.includes("BAD")) {
      return Promise.resolve(new Response("bad input", { status: 400 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: ids.map((id) => ({
            from: { id },
            to: [{ toObjectId: Number(id) * 10, associationTypes: [] }],
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  try {
    const { associations, failedTicketIds } = await batchGetEmailAssociations(
      ["1", "2", "BAD", "4"],
    );
    assertEquals(failedTicketIds, ["BAD"]);
    assertEquals(associations.get("1"), ["10"]);
    assertEquals(associations.get("4"), ["40"]);
    assertEquals(associations.has("BAD"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("batchGetEmailAssociations short-circuits on an empty input", async () => {
  const { associations, failedTicketIds } = await batchGetEmailAssociations([]);
  assertEquals(associations.size, 0);
  assertEquals(failedTicketIds, []);
});
