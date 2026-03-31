import "@std/dotenv/load";
import { fetchTicketProperties, fetchAllTicketIds, fetchTicketsBatch } from "./tickets.ts";
import {
  batchGetEmailAssociations,
  batchFetchEmails,
  getEmailsForTicket,
} from "./emails.ts";
import { fetchConversationsForTicket } from "./conversations.ts";
import { DumpWriter } from "./export.ts";
import type { Message, TicketDump } from "./export.ts";
import { parallelStream } from "./hubspot.ts";

const OUTPUT_DIR = Deno.env.get("OUTPUT_DIR") || "./output";
const CONCURRENCY = (() => {
  const val = parseInt(Deno.env.get("CONCURRENCY") || "10");
  if (isNaN(val) || val < 1) {
    throw new Error(`Invalid CONCURRENCY value: "${Deno.env.get("CONCURRENCY")}". Must be a positive integer.`);
  }
  return val;
})();
const CHUNK_SIZE = (() => {
  const val = parseInt(Deno.env.get("CHUNK_SIZE") || "5000");
  if (isNaN(val) || val < 1) {
    throw new Error(`Invalid CHUNK_SIZE value: "${Deno.env.get("CHUNK_SIZE")}". Must be a positive integer.`);
  }
  return val;
})();

async function main() {
  console.log("=== HubSpot Ticket + Conversation Dump ===\n");

  // 1. Discover properties and fetch all ticket IDs (cheap — just strings)
  const properties = await fetchTicketProperties();
  const propertyNames = properties.map((p) => p.name);
  const allTicketIds = await fetchAllTicketIds();
  if (allTicketIds.length === 0) {
    console.log("No tickets found. Check your access token and scopes.");
    return;
  }

  // 2. Process in chunks to bound memory usage
  const writer = await DumpWriter.create(OUTPUT_DIR, properties);
  let processed = 0;
  let totalEmails = 0;
  let totalConversations = 0;
  let errors = 0;
  const startTime = Date.now();
  const totalChunks = Math.ceil(allTicketIds.length / CHUNK_SIZE);

  console.log(
    `\nProcessing ${allTicketIds.length} tickets in ${totalChunks} chunks of ${CHUNK_SIZE} (concurrency: ${CONCURRENCY})...\n`,
  );

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunkIds = allTicketIds.slice(
      chunkIdx * CHUNK_SIZE,
      (chunkIdx + 1) * CHUNK_SIZE,
    );
    const chunkNum = chunkIdx + 1;

    console.log(`--- Chunk ${chunkNum}/${totalChunks} (${chunkIds.length} tickets) ---`);

    // 2a. Fetch ticket properties for this chunk
    const tickets = await fetchTicketsBatch(chunkIds, propertyNames);

    // 2b. Fetch email associations for this chunk
    const emailAssociations = await batchGetEmailAssociations(chunkIds);
    const chunkEmailIds = [...new Set([...emailAssociations.values()].flat())];

    // 2c. Fetch email content for this chunk
    const emailCache = await batchFetchEmails(chunkEmailIds);

    // 2d. Fetch conversations & write output for this chunk
    await parallelStream<typeof tickets[0], TicketDump>(
      tickets,
      CONCURRENCY,
      async (ticket) => {
        const messages: Message[] = [];

        const emails = getEmailsForTicket(ticket.id, emailAssociations, emailCache);
        messages.push(...emails);
        totalEmails += emails.length;

        try {
          const convos = await fetchConversationsForTicket(ticket.id);
          messages.push(...convos);
          totalConversations += convos.length;
        } catch (err) {
          console.warn(`  Warning: conversations for ticket ${ticket.id}: ${err}`);
          errors++;
        }

        messages.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        processed++;
        if (processed % 200 === 0 || processed === allTicketIds.length) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = processed / elapsed;
          const remaining = rate > 0 ? Math.ceil((allTicketIds.length - processed) / rate) : 0;
          const eta = remaining > 60
            ? `${Math.floor(remaining / 60)}m ${remaining % 60}s`
            : `${remaining}s`;
          console.log(
            `Progress: ${processed}/${allTicketIds.length} (${((processed / allTicketIds.length) * 100).toFixed(1)}%) | ` +
            `${totalEmails} emails, ${totalConversations} convos | ` +
            `${rate.toFixed(1)} tickets/s | ETA: ${processed < allTicketIds.length ? eta : "done"}`,
          );
        }

        return { ticket, messages };
      },
      async (dump) => {
        await writer.writeTicket(dump);
      },
    );
    // chunk data (tickets, emailAssociations, emailCache) falls out of scope here → GC reclaims
  }

  await writer.close();
  const stats = writer.stats;

  console.log("\n=== Dump Complete ===");
  console.log(`Tickets:      ${stats.tickets}`);
  console.log(`Messages:     ${stats.messages}`);
  console.log(`  Emails:     ${totalEmails}`);
  console.log(`  Conversations: ${totalConversations}`);
  console.log(`Errors:       ${errors}`);
  console.log(`Output dir:   ${OUTPUT_DIR}/`);
  console.log(`  tickets.csv   - ticket metadata`);
  console.log(`  messages.csv  - all conversation messages`);
  console.log(`  dump.jsonl    - full structured data`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
