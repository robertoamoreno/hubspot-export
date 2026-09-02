import "@std/dotenv/load";
import {
  fetchAllTicketIds,
  fetchTicketIdsByPipeline,
  fetchTicketIdsByYear,
  fetchTicketPipelines,
  fetchTicketProperties,
  fetchTicketsBatch,
  filterStagePropertiesForPipeline,
  resolvePipeline,
} from "./tickets.ts";
import type { TicketPipeline } from "./tickets.ts";
import {
  batchGetEmailAssociations,
  batchFetchEmails,
  getEmailsForTicket,
} from "./emails.ts";
import { fetchConversationsForTicket } from "./conversations.ts";
import { dedupeMessages } from "./dedupe.ts";
import { dropEmptyColumns } from "./compact.ts";
import { FileResolver } from "./attachments.ts";
import { DumpWriter } from "./export.ts";
import type { Message, TicketDump } from "./export.ts";
import { parallelStream } from "./hubspot.ts";

const SKIP_CONVERSATIONS = (Deno.env.get("SKIP_CONVERSATIONS") || "").toLowerCase() === "true";
const SKIP_DEDUPE = (Deno.env.get("SKIP_DEDUPE") || "").toLowerCase() === "true";
const DROP_EMPTY_COLUMNS =
  (Deno.env.get("DROP_EMPTY_COLUMNS") || "").toLowerCase() === "true";
import {
  hasValidFilePositions,
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
const PIPELINE = Deno.env.get("PIPELINE")?.trim() || undefined;
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
  if (SKIP_DEDUPE) {
    console.log("SKIP_DEDUPE=true — keeping duplicate email/conversation copies\n");
  }

  await Deno.mkdir(OUTPUT_DIR, { recursive: true });

  // --- Resolve the pipeline filter first: it is part of the checkpoint and
  // cache identity, and a typo should fail before any bulk work starts ---
  let pipeline: TicketPipeline | undefined;
  let allPipelines: TicketPipeline[] = [];
  if (PIPELINE) {
    allPipelines = await fetchTicketPipelines();
    pipeline = resolvePipeline(PIPELINE, allPipelines);
    console.log(`Filtering tickets to pipeline: ${pipeline.label} (${pipeline.id})\n`);
  }

  // --- Check for existing checkpoint ---
  const checkpoint = await loadCheckpoint(OUTPUT_DIR);
  let resuming = false;
  let startIndex = 0;
  let processed = 0;
  let totalEmails = 0;
  let totalConversations = 0;
  let errors = 0;
  let incompleteTickets = 0;
  let duplicatesRemoved = 0;
  const fileResolver = new FileResolver();

  if (checkpoint) {
    if (checkpoint.year !== YEAR || checkpoint.pipeline !== pipeline?.id) {
      console.log(
        `Checkpoint was for year=${checkpoint.year ?? "all"}, ` +
        `pipeline=${checkpoint.pipeline ?? "all"} but current ` +
        `YEAR=${YEAR ?? "all"}, PIPELINE=${pipeline?.id ?? "all"}. ` +
        `Ignoring checkpoint and starting fresh.\n`,
      );
      await clearCheckpoint(OUTPUT_DIR);
    } else if (!hasValidFilePositions(checkpoint)) {
      console.warn(
        `Checkpoint has unusable file positions ` +
        `(${JSON.stringify(checkpoint.filePositions)}) — it was written by an ` +
        `older version that misread them. Resuming would truncate the output ` +
        `files, so starting fresh instead.\n`,
      );
      await clearCheckpoint(OUTPUT_DIR);
    } else {
      resuming = true;
      if (checkpoint.nextTicketIndex !== undefined) {
        startIndex = checkpoint.nextTicketIndex;
      } else {
        // Written before the offset was recorded. The chunk size that produced
        // it was never stored, so this can only assume the current one.
        startIndex = (checkpoint.nextChunk ?? 0) * CHUNK_SIZE;
        console.warn(
          `Checkpoint predates absolute ticket offsets. Resuming at ticket ` +
          `${startIndex}, which assumes it was written with the current ` +
          `CHUNK_SIZE=${CHUNK_SIZE}. If the interrupted run used a different ` +
          `CHUNK_SIZE, delete checkpoint.json and start over.\n`,
        );
      }
      processed = checkpoint.stats.processed;
      totalEmails = checkpoint.stats.totalEmails;
      totalConversations = checkpoint.stats.totalConversations;
      errors = checkpoint.stats.errors;
      incompleteTickets = checkpoint.stats.incompleteTickets ?? 0;
      duplicatesRemoved = checkpoint.stats.duplicatesRemoved ?? 0;
      console.log(
        `Resuming from checkpoint: ticket ${startIndex} ` +
        `(${processed} tickets already processed, ` +
        `${totalEmails} emails, ${totalConversations} convos)\n`,
      );
    }
  }

  if (YEAR) {
    console.log(`Filtering tickets to year: ${YEAR}\n`);
  }

  // --- Load or fetch ticket properties (always try cache first) ---
  let properties = await loadProperties(OUTPUT_DIR, pipeline?.id);
  if (!properties) {
    properties = await fetchTicketProperties();
    if (pipeline) {
      const before = properties.length;
      properties = filterStagePropertiesForPipeline(
        properties,
        pipeline,
        allPipelines,
      );
      const dropped = before - properties.length;
      if (dropped > 0) {
        console.log(
          `Dropped ${dropped} stage properties belonging to other pipelines ` +
          `(${before} -> ${properties.length} ticket columns).`,
        );
      }
    }
    await saveProperties(OUTPUT_DIR, properties, pipeline?.id);
  } else {
    console.log(`Loaded ${properties.length} ticket properties from cache.`);
  }
  const propertyNames = properties.map((p) => p.name);

  // --- Load or fetch ticket IDs (always try cache first) ---
  let allTicketIds = await loadTicketIds(OUTPUT_DIR, YEAR, pipeline?.id);
  if (!allTicketIds) {
    if (YEAR) {
      allTicketIds = await fetchTicketIdsByYear(YEAR, pipeline?.id);
    } else if (pipeline) {
      allTicketIds = await fetchTicketIdsByPipeline(pipeline.id);
    } else {
      allTicketIds = await fetchAllTicketIds();
    }
    await saveTicketIds(OUTPUT_DIR, allTicketIds, YEAR, pipeline?.id);
  } else {
    console.log(`Loaded ${allTicketIds.length} ticket IDs from cache.`);
  }

  if (allTicketIds.length === 0) {
    console.log(
      pipeline
        ? `No tickets found in pipeline "${pipeline.label}"${YEAR ? ` for ${YEAR}` : ""}.`
        : "No tickets found. Check your access token and scopes.",
    );
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
    console.log(`Skipping the first ${startIndex} tickets (already complete).`);
  }
  console.log();

  for (
    let offset = startIndex;
    offset < allTicketIds.length;
    offset += CHUNK_SIZE
  ) {
    const chunkIds = allTicketIds.slice(offset, offset + CHUNK_SIZE);
    const chunkNum = Math.floor(offset / CHUNK_SIZE) + 1;

    console.log(`--- Chunk ${chunkNum}/${totalChunks} (${chunkIds.length} tickets) ---`);

    // 2a. Fetch ticket properties for this chunk
    const tickets = await fetchTicketsBatch(chunkIds, propertyNames);

    // 2b. Fetch email associations for this chunk
    const { associations: emailAssociations, failedTicketIds } =
      await batchGetEmailAssociations(chunkIds);
    const chunkEmailIds = [...new Set([...emailAssociations.values()].flat())];

    // 2c. Fetch email content for this chunk
    const { emails: emailCache, failedEmailIds } = await batchFetchEmails(
      chunkEmailIds,
    );

    // A ticket whose associations or email bodies we could not read gets
    // exported as if it simply had no emails. Count those explicitly so a
    // dropped batch can't pass for a clean run.
    if (failedTicketIds.length > 0 || failedEmailIds.length > 0) {
      const failedEmails = new Set(failedEmailIds);
      const incomplete = new Set(failedTicketIds);
      for (const [ticketId, ids] of emailAssociations) {
        if (ids.some((id) => failedEmails.has(id))) incomplete.add(ticketId);
      }
      errors += failedTicketIds.length + failedEmailIds.length;
      incompleteTickets += incomplete.size;
      console.warn(
        `  WARNING: ${incomplete.size} ticket(s) in this chunk have incomplete ` +
        `email data (${failedTicketIds.length} association lookup(s) and ` +
        `${failedEmailIds.length} email body fetch(es) failed).`,
      );
    }

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

        // Email attachments arrive as bare file ids; fill in name and url.
        for (const m of messages) {
          const unresolved = m.attachments.filter((a) => a.fileId && !a.url);
          if (unresolved.length === 0) continue;
          const resolved = await fileResolver.resolve(
            unresolved.map((a) => a.fileId),
          );
          for (let i = 0; i < unresolved.length; i++) {
            const r = resolved[i];
            if (r.url) {
              unresolved[i].name = r.name;
              unresolved[i].url = r.url;
            }
          }
        }

        let finalMessages = messages;
        if (!SKIP_DEDUPE) {
          const deduped = dedupeMessages(messages);
          finalMessages = deduped.messages;
          duplicatesRemoved += deduped.removed;
        }

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

        return { ticket, messages: finalMessages };
      },
      async (dump) => {
        await writer.writeTicket(dump);
      },
    );

    // --- Save checkpoint after each chunk ---
    const filePositions = writer.getFilePositions();
    await saveCheckpoint(OUTPUT_DIR, {
      nextTicketIndex: offset + chunkIds.length,
      year: YEAR,
      pipeline: pipeline?.id,
      filePositions,
      stats: {
        processed,
        totalEmails,
        totalConversations,
        errors,
        incompleteTickets,
        duplicatesRemoved,
      },
    });
    console.log(`  [Checkpoint saved: ${processed} tickets complete]\n`);

    // chunk data (tickets, emailAssociations, emailCache) falls out of scope here → GC reclaims
  }

  await writer.close();
  const stats = writer.stats;

  // All done — clear checkpoint (keep cache files for potential future runs)
  await clearCheckpoint(OUTPUT_DIR);

  // Compaction rewrites tickets.csv, invalidating the byte offsets a resume
  // relies on, so it only runs once the checkpoint is gone.
  if (DROP_EMPTY_COLUMNS) {
    console.log("\nDropping empty ticket columns...");
    const { before, after, rows } = await dropEmptyColumns(
      `${OUTPUT_DIR}/tickets.csv`,
    );
    console.log(
      `  tickets.csv: ${before} -> ${after} columns ` +
      `(${before - after} empty across all ${rows} tickets)`,
    );
  }

  console.log("\n=== Dump Complete ===");
  console.log(`Tickets:      ${processed}`);
  console.log(`Messages:     ${stats.messages}`);
  console.log(`Attachments:  ${stats.attachments}`);
  console.log(`  Emails:     ${totalEmails}`);
  console.log(`  Conversations: ${totalConversations}`);
  if (duplicatesRemoved > 0) {
    console.log(`  Duplicates removed: ${duplicatesRemoved}`);
  }
  console.log(`Errors:       ${errors}`);
  if (incompleteTickets > 0) {
    console.log(`Incomplete:   ${incompleteTickets} tickets missing some email data`);
  }
  console.log(`Output dir:   ${OUTPUT_DIR}/`);
  console.log(`  tickets.csv   - ticket metadata`);
  console.log(`  messages.csv  - all conversation messages`);
  console.log(`  attachments.csv - files referenced by messages`);
  console.log(`  dump.jsonl    - full structured data`);

  if (errors > 0) {
    console.error(
      `\nCompleted with ${errors} error(s) — this export is missing data. ` +
      `Review the warnings above before treating it as complete.`,
    );
    Deno.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
