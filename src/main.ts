import "@std/dotenv/load";
import { fetchTicketProperties, fetchAllTicketIds, fetchTicketIdsByYear, fetchTicketsBatch } from "./tickets.ts";
import {
  batchGetEmailAssociations,
  batchFetchEmails,
  getEmailsForTicket,
} from "./emails.ts";
import { fetchConversationsForTicket } from "./conversations.ts";
import { DumpWriter } from "./export.ts";
import type { Message, TicketDump } from "./export.ts";
import { parallelStream } from "./hubspot.ts";

const SKIP_CONVERSATIONS = (Deno.env.get("SKIP_CONVERSATIONS") || "").toLowerCase() === "true";
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  loadTicketIds,
  saveTicketIds,
  loadProperties,
  saveProperties,
} from "./checkpoint.ts";

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
const YEAR: number | undefined = (() => {
  const val = Deno.env.get("YEAR");
  if (!val) return undefined;
  const year = parseInt(val);
  if (isNaN(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid YEAR value: "${val}". Must be a 4-digit year (e.g. 2024).`);
  }
  return year;
})();

async function main() {
  console.log("=== HubSpot Ticket + Conversation Dump ===\n");
  if (SKIP_CONVERSATIONS) {
    console.log("SKIP_CONVERSATIONS=true — fetching emails only (no conversation threads)\n");
  }

  await Deno.mkdir(OUTPUT_DIR, { recursive: true });

  // --- Check for existing checkpoint ---
  const checkpoint = await loadCheckpoint(OUTPUT_DIR);
  let resuming = false;
  let startChunk = 0;
  let processed = 0;
  let totalEmails = 0;
  let totalConversations = 0;
  let errors = 0;

  if (checkpoint) {
    if (checkpoint.year !== YEAR) {
      console.log(
        `Checkpoint was for year=${checkpoint.year ?? "all"} but current YEAR=${YEAR ?? "all"}. ` +
        `Ignoring checkpoint and starting fresh.\n`,
      );
      await clearCheckpoint(OUTPUT_DIR);
    } else {
      resuming = true;
      startChunk = checkpoint.nextChunk;
      processed = checkpoint.stats.processed;
      totalEmails = checkpoint.stats.totalEmails;
      totalConversations = checkpoint.stats.totalConversations;
      errors = checkpoint.stats.errors;
      console.log(
        `Resuming from checkpoint: chunk ${startChunk} ` +
        `(${processed} tickets already processed, ` +
        `${totalEmails} emails, ${totalConversations} convos)\n`,
      );
    }
  }

  if (YEAR) {
    console.log(`Filtering tickets to year: ${YEAR}\n`);
  }

  // --- Load or fetch ticket properties (always try cache first) ---
  let properties = await loadProperties(OUTPUT_DIR);
  if (!properties) {
    properties = await fetchTicketProperties();
    await saveProperties(OUTPUT_DIR, properties);
  } else {
    console.log(`Loaded ${properties.length} ticket properties from cache.`);
  }
  const propertyNames = properties.map((p) => p.name);

  // --- Load or fetch ticket IDs (always try cache first) ---
  let allTicketIds = await loadTicketIds(OUTPUT_DIR, YEAR);
  if (!allTicketIds) {
    allTicketIds = YEAR
      ? await fetchTicketIdsByYear(YEAR)
      : await fetchAllTicketIds();
    await saveTicketIds(OUTPUT_DIR, allTicketIds, YEAR);
  } else {
    console.log(`Loaded ${allTicketIds.length} ticket IDs from cache.`);
  }

  if (allTicketIds.length === 0) {
    console.log("No tickets found. Check your access token and scopes.");
    return;
  }

  // --- Open writer (append mode if resuming) ---
  const writer = await DumpWriter.create(
    OUTPUT_DIR,
    properties,
    resuming ? checkpoint!.filePositions : undefined,
  );

  const startTime = Date.now();
  const totalChunks = Math.ceil(allTicketIds.length / CHUNK_SIZE);

  console.log(
    `\nProcessing ${allTicketIds.length} tickets in ${totalChunks} chunks of ${CHUNK_SIZE} (concurrency: ${CONCURRENCY})...`,
  );
  if (resuming) {
    console.log(`Skipping chunks 1-${startChunk} (already complete).`);
  }
  console.log();

  for (let chunkIdx = startChunk; chunkIdx < totalChunks; chunkIdx++) {
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

        if (!SKIP_CONVERSATIONS) {
          try {
            const convos = await fetchConversationsForTicket(ticket.id);
            messages.push(...convos);
            totalConversations += convos.length;
          } catch (err) {
            console.warn(`  Warning: conversations for ticket ${ticket.id}: ${err}`);
            errors++;
          }
        }

        messages.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        processed++;
        if (processed % 200 === 0 || processed === allTicketIds.length) {
          const elapsed = (Date.now() - startTime) / 1000;
          const remaining = processed > 0
            ? Math.ceil(((allTicketIds.length - processed) / (processed / elapsed)))
            : 0;
          const eta = remaining > 60
            ? `${Math.floor(remaining / 60)}m ${remaining % 60}s`
            : `${remaining}s`;
          console.log(
            `Progress: ${processed}/${allTicketIds.length} (${((processed / allTicketIds.length) * 100).toFixed(1)}%) | ` +
            `${totalEmails} emails, ${totalConversations} convos | ` +
            `ETA: ${processed < allTicketIds.length ? eta : "done"}`,
          );
        }

        return { ticket, messages };
      },
      async (dump) => {
        await writer.writeTicket(dump);
      },
    );

    // --- Save checkpoint after each chunk ---
    const filePositions = await writer.getFilePositions();
    await saveCheckpoint(OUTPUT_DIR, {
      nextChunk: chunkIdx + 1,
      year: YEAR,
      filePositions,
      stats: { processed, totalEmails, totalConversations, errors },
    });
    console.log(`  [Checkpoint saved: ${processed} tickets complete]\n`);

    // chunk data (tickets, emailAssociations, emailCache) falls out of scope here → GC reclaims
  }

  await writer.close();
  const stats = writer.stats;

  // All done — clear checkpoint (keep cache files for potential future runs)
  await clearCheckpoint(OUTPUT_DIR);

  console.log("\n=== Dump Complete ===");
  console.log(`Tickets:      ${processed}`);
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
