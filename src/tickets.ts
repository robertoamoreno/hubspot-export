import { getClient, hubspotFetch } from "./hubspot.ts";

export interface TicketProperty {
  name: string;
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

/**
 * Fetch ticket IDs for a specific year using the Search API.
 * Queries month-by-month to stay under HubSpot's 10k-per-query limit.
 */
export async function fetchTicketIdsByYear(year: number): Promise<string[]> {
  const allIds: string[] = [];
  console.log(`Fetching ticket IDs for year ${year}...`);
  const startTime = Date.now();

  for (let month = 0; month < 12; month++) {
    const fromMs = Date.UTC(year, month, 1);
    const toMs = Date.UTC(year, month + 1, 1);
    let after: string | undefined;
    let monthCount = 0;

    do {
      const body: Record<string, unknown> = {
        filterGroups: [{
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(fromMs) },
            { propertyName: "createdate", operator: "LT", value: String(toMs) },
          ],
        }],
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
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
        allIds.push(t.id);
        monthCount++;
      }

      after = response.paging?.next?.after;
    } while (after);

    if (monthCount > 0) {
      const monthName = new Date(fromMs).toLocaleString("en", { month: "short" });
      console.log(`  ${monthName} ${year}: ${monthCount} tickets`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${allIds.length} ticket IDs for ${year} in ${totalTime}s.`);
  return allIds;
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
