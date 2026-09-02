import type { Ticket, TicketProperty } from "./tickets.ts";
import type { EmailMessage } from "./emails.ts";
import type { ConversationMessage } from "./conversations.ts";

export type Message = EmailMessage | ConversationMessage;

export interface TicketDump {
  ticket: Ticket;
  messages: Message[];
}

const MESSAGES_CSV_HEADER = [
  "ticket_id",
  "message_id",
  "timestamp",
  "direction",
  "sender",
  "recipient",
  "subject",
  "body",
  "source_type",
  "thread_id",
  "direction_raw",
].join(",");

const ATTACHMENTS_CSV_HEADER = [
  "ticket_id",
  "message_id",
  "source_type",
  "file_id",
  "name",
  "kind",
  "url",
  "local_path",
].join(",");

/** Escape a value for CSV (RFC 4180). */
export function csvEscape(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Write a buffer in full, looping until every byte lands.
 *
 * `Deno.FsFile.write()` is not guaranteed to consume the whole buffer — it
 * returns the number of bytes actually written. Ignoring that return value
 * silently truncates long rows (a single email body can span megabytes) and
 * corrupts every byte offset after it. Returns the total bytes written.
 */
export async function writeAll(
  file: Pick<Deno.FsFile, "write">,
  bytes: Uint8Array,
): Promise<number> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const n = await file.write(bytes.subarray(offset));
    if (n <= 0) {
      throw new Error(
        `Short write: wrote ${n} of ${bytes.byteLength - offset} remaining bytes`,
      );
    }
    offset += n;
  }
  return offset;
}

/** Columns appended after the ticket properties. */
const EXTRA_TICKET_COLUMNS = ["Message Count", "URL"];

/**
 * Build the tickets.csv header row.
 *
 * HubSpot lets two properties carry the same display label, and a label can
 * also collide with one of the appended columns. Internal property names are
 * unique, so only the colliding labels get their name appended — every other
 * header keeps its plain label, so existing consumers are unaffected.
 */
export function buildTicketHeaders(properties: TicketProperty[]): string[] {
  const counts = new Map<string, number>();
  for (const c of EXTRA_TICKET_COLUMNS) counts.set(c, 1);
  for (const p of properties) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);

  const headers = properties.map((p) =>
    (counts.get(p.label) ?? 0) > 1 ? `${p.label} (${p.name})` : p.label
  );
  return [...headers, ...EXTRA_TICKET_COLUMNS];
}

export interface FilePositions {
  ticketsCsv: number;
  messagesCsv: number;
  dumpJsonl: number;
  /** Absent in checkpoints written before attachments.csv existed. */
  attachmentsCsv?: number;
}

export class DumpWriter {
  private ticketsFile: Deno.FsFile;
  private messagesFile: Deno.FsFile;
  private jsonlFile: Deno.FsFile;
  private attachmentsFile: Deno.FsFile;
  private encoder = new TextEncoder();
  private ticketCount = 0;
  private messageCount = 0;
  private attachmentCount = 0;
  private properties: TicketProperty[];
  private portalId: string;
  /** Bytes written to each output file, tracked as we go. See getFilePositions(). */
  private pos: FilePositions;

  private constructor(
    ticketsFile: Deno.FsFile,
    messagesFile: Deno.FsFile,
    jsonlFile: Deno.FsFile,
    attachmentsFile: Deno.FsFile,
    properties: TicketProperty[],
    portalId: string,
    startPositions: FilePositions,
  ) {
    this.ticketsFile = ticketsFile;
    this.messagesFile = messagesFile;
    this.jsonlFile = jsonlFile;
    this.attachmentsFile = attachmentsFile;
    this.properties = properties;
    this.portalId = portalId;
    this.pos = { ...startPositions };
  }

  /**
   * Create a DumpWriter. When `resume` is provided, files are opened in
   * append mode and truncated to the checkpoint's saved byte positions
   * (removing any partial chunk data from a crash). Headers are not re-written.
   */
  static async create(
    outputDir: string,
    properties: TicketProperty[],
    resume?: FilePositions,
  ): Promise<DumpWriter> {
    const portalId = Deno.env.get("HUBSPOT_PORTAL_ID");
    if (!portalId) {
      throw new Error(
        "HUBSPOT_PORTAL_ID is not set. Add it to your .env file. Find it in your HubSpot URL: app.hubspot.com/contacts/{portal_id}/...",
      );
    }

    await Deno.mkdir(outputDir, { recursive: true });

    if (resume) {
      // Truncate files to the last known-good positions (removes partial chunk data).
      // Deno.truncate() *grows* a file with NUL bytes when the requested size
      // exceeds the current one, so verify we are only ever shrinking.
      const targets: Array<[string, number]> = [
        [`${outputDir}/tickets.csv`, resume.ticketsCsv],
        [`${outputDir}/messages.csv`, resume.messagesCsv],
        [`${outputDir}/dump.jsonl`, resume.dumpJsonl],
      ];
      for (const [path, want] of targets) {
        const { size } = await Deno.stat(path);
        if (want > size) {
          throw new Error(
            `Checkpoint expects ${path} to be at least ${want} bytes but it is ` +
              `${size}. The output files and checkpoint.json are out of sync — ` +
              `delete checkpoint.json to restart the export.`,
          );
        }
      }
      for (const [path, want] of targets) {
        await Deno.truncate(path, want);
      }

      // A checkpoint from before attachments.csv existed cannot say where to
      // resume in it, so start the file fresh and say what is missing.
      const attachmentsPath = `${outputDir}/attachments.csv`;
      const attachmentsStart = resume.attachmentsCsv;
      if (attachmentsStart === undefined) {
        console.warn(
          "  Warning: this checkpoint predates attachment capture. " +
            "attachments.csv will only cover tickets exported from here on; " +
            "re-run from scratch for a complete set.",
        );
        const fresh = await Deno.open(attachmentsPath, {
          write: true,
          create: true,
          truncate: true,
        });
        const w = new DumpWriter(
          await Deno.open(`${outputDir}/tickets.csv`, { write: true, append: true }),
          await Deno.open(`${outputDir}/messages.csv`, { write: true, append: true }),
          await Deno.open(`${outputDir}/dump.jsonl`, { write: true, append: true }),
          fresh,
          properties,
          portalId,
          { ...resume, attachmentsCsv: 0 },
        );
        await w.writeLine(fresh, ATTACHMENTS_CSV_HEADER, "attachmentsCsv");
        return w;
      }
      const { size: attSize } = await Deno.stat(attachmentsPath);
      if (attachmentsStart > attSize) {
        throw new Error(
          `Checkpoint expects ${attachmentsPath} to be at least ` +
            `${attachmentsStart} bytes but it is ${attSize}. Delete ` +
            `checkpoint.json to restart the export.`,
        );
      }
      await Deno.truncate(attachmentsPath, attachmentsStart);

      // Open in append mode
      const ticketsFile = await Deno.open(`${outputDir}/tickets.csv`, {
        write: true,
        append: true,
      });
      const messagesFile = await Deno.open(`${outputDir}/messages.csv`, {
        write: true,
        append: true,
      });
      const jsonlFile = await Deno.open(`${outputDir}/dump.jsonl`, {
        write: true,
        append: true,
      });
      const attachmentsFile = await Deno.open(attachmentsPath, {
        write: true,
        append: true,
      });

      return new DumpWriter(
        ticketsFile,
        messagesFile,
        jsonlFile,
        attachmentsFile,
        properties,
        portalId,
        resume,
      );
    }

    // Fresh start — truncate and write headers
    const ticketsFile = await Deno.open(`${outputDir}/tickets.csv`, {
      write: true,
      create: true,
      truncate: true,
    });
    const messagesFile = await Deno.open(`${outputDir}/messages.csv`, {
      write: true,
      create: true,
      truncate: true,
    });
    const jsonlFile = await Deno.open(`${outputDir}/dump.jsonl`, {
      write: true,
      create: true,
      truncate: true,
    });
    const attachmentsFile = await Deno.open(`${outputDir}/attachments.csv`, {
      write: true,
      create: true,
      truncate: true,
    });

    const writer = new DumpWriter(
      ticketsFile,
      messagesFile,
      jsonlFile,
      attachmentsFile,
      properties,
      portalId,
      { ticketsCsv: 0, messagesCsv: 0, dumpJsonl: 0, attachmentsCsv: 0 },
    );

    await writer.writeLine(
      ticketsFile,
      buildTicketHeaders(properties).map(csvEscape).join(","),
      "ticketsCsv",
    );

    await writer.writeLine(messagesFile, MESSAGES_CSV_HEADER, "messagesCsv");
    await writer.writeLine(
      attachmentsFile,
      ATTACHMENTS_CSV_HEADER,
      "attachmentsCsv",
    );
    return writer;
  }

  private async writeLine(
    file: Deno.FsFile,
    line: string,
    key: keyof FilePositions,
  ): Promise<void> {
    this.pos[key] = (this.pos[key] ?? 0) +
      await writeAll(file, this.encoder.encode(line + "\n"));
  }

  async writeTicket(dump: TicketDump): Promise<void> {
    const { ticket, messages } = dump;
    const url = `https://app.hubspot.com/contacts/${this.portalId}/ticket/${ticket.id}`;

    // Build ticket CSV row from properties in order + extras
    const values = this.properties.map((p) => ticket.properties[p.name] ?? "");
    values.push(String(messages.length), url);

    await this.writeLine(
      this.ticketsFile,
      values.map(csvEscape).join(","),
      "ticketsCsv",
    );
    this.ticketCount++;

    // Write message CSV rows
    for (const msg of messages) {
      const threadId = ("threadId" in msg ? msg.threadId : "") ?? "";
      const msgRow = [
        ticket.id,
        msg.id,
        msg.timestamp,
        msg.direction,
        msg.sender,
        msg.recipient,
        msg.subject,
        msg.body,
        msg.sourceType,
        threadId,
        msg.directionRaw,
      ]
        .map(csvEscape)
        .join(",");

      await this.writeLine(this.messagesFile, msgRow, "messagesCsv");
      this.messageCount++;
    }

    // Write attachment rows
    for (const msg of messages) {
      for (const att of msg.attachments) {
        await this.writeLine(
          this.attachmentsFile,
          [
            ticket.id,
            msg.id,
            msg.sourceType,
            att.fileId,
            att.name,
            att.kind,
            att.url,
            att.localPath ?? "",
          ].map(csvEscape).join(","),
          "attachmentsCsv",
        );
        this.attachmentCount++;
      }
    }

    // Write JSONL
    await this.writeLine(this.jsonlFile, JSON.stringify(dump), "dumpJsonl");
  }

  /**
   * Byte positions of all output files, for checkpointing.
   *
   * These are counted as we write rather than read back off the file
   * descriptors. Asking an append-mode fd for its offset returns 0 until the
   * first write in the process, so a chunk that wrote no tickets used to
   * checkpoint {0, 0, 0} — and the next resume would truncate every output
   * file, headers included, to nothing.
   */
  getFilePositions(): FilePositions {
    return { ...this.pos };
  }

  async close(): Promise<void> {
    this.ticketsFile.close();
    this.messagesFile.close();
    this.jsonlFile.close();
    this.attachmentsFile.close();
  }

  get stats(): { tickets: number; messages: number; attachments: number } {
    return {
      tickets: this.ticketCount,
      messages: this.messageCount,
      attachments: this.attachmentCount,
    };
  }
}
