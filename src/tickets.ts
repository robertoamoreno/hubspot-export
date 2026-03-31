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

interface SearchResponse {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
  paging?: { next?: { after: string } };
}

/**
 * Fetch all tickets using the Search API (POST) to avoid 414 errors
 * when requesting many properties — GET puts them in the URL, POST in the body.
 */
export async function fetchAllTickets(
  properties: TicketProperty[],
): Promise<Ticket[]> {
  const propertyNames = properties.map((p) => p.name);
  const tickets: Ticket[] = [];
  let after: string | undefined;
  let page = 0;

  console.log("Fetching all tickets...");
  const startTime = Date.now();

  do {
    const body: Record<string, unknown> = {
      properties: propertyNames,
      limit: 100,
      filterGroups: [],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    };
    if (after) body.after = after;

    const response = await hubspotFetch<SearchResponse>(
      "/crm/v3/objects/tickets/search",
      undefined,
      "POST",
      body,
    );

    for (const t of response.results) {
      tickets.push({ id: t.id, properties: t.properties });
    }

    after = response.paging?.next?.after;
    page++;

    if (page % 50 === 0 || !after) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ...${tickets.length} tickets fetched (${elapsed}s elapsed)`);
    }
  } while (after);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Fetched ${tickets.length} tickets in ${totalTime}s.`);

  return tickets;
}
