import { getClient, hubspotFetch } from "./hubspot.ts";

export interface TicketProperty {
  name: string;
  label: string;
}

export interface TicketPipeline {
  id: string;
  label: string;
}

export interface Ticket {
  id: string;
  properties: Record<string, string | null>;
}

/** Fetch all property definitions for tickets. */
export async function fetchTicketProperties(): Promise<TicketProperty[]> {
  const client = getClient();
  console.log("Fetching ticket property definitions...");
  const response = await client.crm.properties.coreApi.getAll("tickets");
  const props = response.results
    .map((p) => ({ name: p.name, label: p.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  console.log(`Found ${props.length} ticket properties.`);
  return props;
}

interface PipelinesResponse {
  results: Array<{ id: string; label: string }>;
}

/** Fetch the ticket pipelines defined in the portal. */
export async function fetchTicketPipelines(): Promise<TicketPipeline[]> {
  const data = await hubspotFetch<PipelinesResponse>("/crm/v3/pipelines/tickets");
  return data.results.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Resolve a user-supplied pipeline (id or label, case-insensitive) against the
 * portal's pipelines. Throws listing the valid options rather than letting a
 * typo quietly export zero tickets.
 */
export function resolvePipeline(
  input: string,
  pipelines: TicketPipeline[],
): TicketPipeline {
  const needle = input.trim().toLowerCase();
  const match = pipelines.find(
    (p) => p.id.toLowerCase() === needle || p.label.toLowerCase() === needle,
  );
  if (!match) {
    throw new Error(
      `Unknown pipeline "${input}". Available ticket pipelines:\n` +
        pipelines.map((p) => `  ${p.id}\t${p.label}`).join("\n"),
    );
  }
  return match;
}

interface ListResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after: string } };
}

interface BatchReadResponse {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
}

interface SearchResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after: string } };
  total: number;
}

/** Search filters for a createdate window, optionally narrowed to one pipeline. */
function searchFilters(
  fromMs: number,
  toMs: number,
  pipelineId?: string,
): Array<Record<string, string>> {
  // Filters within one filterGroup are ANDed by the Search API.
  const filters = [
    { propertyName: "createdate", operator: "GTE", value: String(fromMs) },
    { propertyName: "createdate", operator: "LT", value: String(toMs) },
  ];
  if (pipelineId) {
    filters.push({
      propertyName: "hs_pipeline",
      operator: "EQ",
      value: pipelineId,
    });
  }
  return filters;
}

/** Stop halving a date range once it is this small (see fetchIdsForDateRange). */
const MIN_SPLIT_RANGE_MS = 1000;

/**
 * Fetch ticket IDs within a date range using the Search API.
 * If the range contains >10k results (HubSpot's search limit),
 * it automatically splits the range in half and recurses.
 *
 * Exported for tests.
 */
export async function fetchIdsForDateRange(
  fromMs: number,
  toMs: number,
  label: string,
  pipelineId?: string,
): Promise<string[]> {
  // Probe the total count first
  const probeBody = {
    filterGroups: [{ filters: searchFilters(fromMs, toMs, pipelineId) }],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    properties: ["hs_object_id"],
    limit: 1,
  };

  const probe = await hubspotFetch<SearchResponse>(
    "/crm/v3/objects/tickets/search",
    undefined,
    "POST",
    probeBody,
  );

  if (probe.total === 0) return [];

  // If >10k, split the range in half and recurse.
  // Halving a 1ms range yields midMs === fromMs, so the second recursive call
  // would repeat the parent range forever; stop splitting before that point.
  if (probe.total > 10000) {
    if (toMs - fromMs > MIN_SPLIT_RANGE_MS) {
      const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
      const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const firstHalf = await fetchIdsForDateRange(fromMs, midMs, `${fmtDate(fromMs)}..${fmtDate(midMs)}`, pipelineId);
      const secondHalf = await fetchIdsForDateRange(midMs, toMs, `${fmtDate(midMs)}..${fmtDate(toMs)}`, pipelineId);
      return firstHalf.concat(secondHalf);
    }
    console.warn(
      `  WARNING: ${label} holds ${probe.total} tickets within ${toMs - fromMs}ms, ` +
        `past the search API's 10,000 result cap. Some ticket ids in this ` +
        `range will be missing from the export.`,
    );
  }

  // <=10k results, safe to paginate fully
  const ids: string[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: searchFilters(fromMs, toMs, pipelineId) }],
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      properties: ["hs_object_id"],
      limit: 100,
    };
    if (after) body.after = after;

    const response = await hubspotFetch<SearchResponse>(
      "/crm/v3/objects/tickets/search",
      undefined,
      "POST",
      body,
    );

    for (const t of response.results) {
      ids.push(t.id);
    }

    after = response.paging?.next?.after;
  } while (after);

  console.log(`  ${label}: ${ids.length} tickets`);
  return ids;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Fetch ticket IDs for a specific year using the Search API.
 * Queries month-by-month, automatically splitting months with >10k
 * tickets into smaller date ranges to stay under HubSpot's search limit.
 * Skips future months that haven't occurred yet.
 */
export async function fetchTicketIdsByYear(
  year: number,
  pipelineId?: string,
): Promise<string[]> {
  const allIds: string[] = [];
  console.log(`Fetching ticket IDs for year ${year}...`);
  const startTime = Date.now();
  const nowMs = Date.now();

  for (let month = 0; month < 12; month++) {
    const fromMs = Date.UTC(year, month, 1);
    // Skip months that haven't started yet
    if (fromMs > nowMs) break;
    const toMs = Math.min(Date.UTC(year, month + 1, 1), nowMs);
    const ids = await fetchIdsForDateRange(fromMs, toMs, `${MONTH_NAMES[month]} ${year}`, pipelineId);
    allIds.push(...ids);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${allIds.length} ticket IDs for ${year} in ${totalTime}s.`);
  return allIds;
}

/** Earliest createdate the export will look back to when no YEAR is set. */
const EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * Fetch ticket IDs for one pipeline across all time.
 *
 * The plain list endpoint cannot filter, so this goes through the Search API
 * over an open date range. The 10,000-result cap is handled by the same
 * halving recursion the YEAR filter uses.
 */
export async function fetchTicketIdsByPipeline(
  pipelineId: string,
): Promise<string[]> {
  console.log(`Fetching ticket IDs for pipeline ${pipelineId}...`);
  const startTime = Date.now();
  const ids = await fetchIdsForDateRange(
    EPOCH_MS,
    Date.now(),
    "all time",
    pipelineId,
  );
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${ids.length} ticket IDs in ${totalTime}s.`);
  return ids;
}

/**
 * Fetch all ticket IDs via GET (no properties in URL → no 414).
 * Returns just the ID strings — cheap to hold in memory even at 750k+.
 */
export async function fetchAllTicketIds(): Promise<string[]> {
  const allIds: string[] = [];
  let after: string | undefined;
  let page = 0;

  console.log("Fetching ticket IDs...");
  const startTime = Date.now();

  do {
    const params: Record<string, string> = { limit: "100" };
    if (after) params.after = after;

    const response = await hubspotFetch<ListResponse>(
      "/crm/v3/objects/tickets",
      params,
    );

    for (const t of response.results) {
      allIds.push(t.id);
    }

    after = response.paging?.next?.after;
    page++;

    if (page % 50 === 0 || !after) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ...${allIds.length} ticket IDs fetched (${elapsed}s elapsed)`);
    }
  } while (after);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${allIds.length} ticket IDs in ${totalTime}s.`);

  return allIds;
}

/**
 * Batch-read full properties for a set of ticket IDs via POST.
 * Processes in groups of 100 (HubSpot batch limit).
 */
export async function fetchTicketsBatch(
  ids: string[],
  propertyNames: string[],
): Promise<Ticket[]> {
  const tickets: Ticket[] = [];

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);

    const response = await hubspotFetch<BatchReadResponse>(
      "/crm/v3/objects/tickets/batch/read",
      undefined,
      "POST",
      {
        inputs: batch.map((id) => ({ id })),
        properties: propertyNames,
        propertiesWithHistory: [],
      },
    );

    for (const t of response.results) {
      tickets.push({ id: t.id, properties: t.properties });
    }
  }

  return tickets;
}
