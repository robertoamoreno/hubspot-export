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
].join(",");

/** Escape a value for CSV (RFC 4180). */
function csvEscape(value: string): string {
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

export interface FilePositions {
  ticketsCsv: number;
  messagesCsv: number;
  dumpJsonl: number;
}

export class DumpWriter {
  private ticketsFile: Deno.FsFile;
  private messagesFile: Deno.FsFile;
  private jsonlFile: Deno.FsFile;
  private encoder = new TextEncoder();
  private ticketCount = 0;
  private messageCount = 0;
  private properties: TicketProperty[];
  private portalId: string;

  private constructor(
    ticketsFile: Deno.FsFile,
    messagesFile: Deno.FsFile,
    jsonlFile: Deno.FsFile,
    properties: TicketProperty[],
    portalId: string,
  ) {
    this.ticketsFile = ticketsFile;
    this.messagesFile = messagesFile;
    this.jsonlFile = jsonlFile;
    this.properties = properties;
    this.portalId = portalId;
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
      // Truncate files to the last known-good positions (removes partial chunk data)
      await Deno.truncate(`${outputDir}/tickets.csv`, resume.ticketsCsv);
      await Deno.truncate(`${outputDir}/messages.csv`, resume.messagesCsv);
      await Deno.truncate(`${outputDir}/dump.jsonl`, resume.dumpJsonl);

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

      return new DumpWriter(ticketsFile, messagesFile, jsonlFile, properties, portalId);
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

    const writer = new DumpWriter(ticketsFile, messagesFile, jsonlFile, properties, portalId);

    // Build ticket CSV header from property labels + extras
    const headers = properties.map((p) => p.label);
    headers.push("Message Count", "URL");
    await writer.writeLine(ticketsFile, headers.map(csvEscape).join(","));

    await writer.writeLine(messagesFile, MESSAGES_CSV_HEADER);
    return writer;
  }

  private async writeLine(file: Deno.FsFile, line: string): Promise<void> {
    await file.write(this.encoder.encode(line + "\n"));
  }

  async writeTicket(dump: TicketDump): Promise<void> {
    const { ticket, messages } = dump;
    const url = `https://app.hubspot.com/contacts/${this.portalId}/ticket/${ticket.id}`;

    // Build ticket CSV row from properties in order + extras
    const values = this.properties.map((p) => ticket.properties[p.name] ?? "");
    values.push(String(messages.length), url);

    await this.writeLine(this.ticketsFile, values.map(csvEscape).join(","));
    this.ticketCount++;

    // Write message CSV rows
    for (const msg of messages) {
      const threadId = "threadId" in msg ? msg.threadId : "";
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
      ]
        .map(csvEscape)
        .join(",");

      await this.writeLine(this.messagesFile, msgRow);
      this.messageCount++;
    }

    // Write JSONL
    await this.writeLine(this.jsonlFile, JSON.stringify(dump));
  }

  /** Get current byte positions of all output files (for checkpointing). */
  async getFilePositions(): Promise<FilePositions> {
    return {
      ticketsCsv: await this.ticketsFile.seek(0, Deno.SeekMode.Current),
      messagesCsv: await this.messagesFile.seek(0, Deno.SeekMode.Current),
      dumpJsonl: await this.jsonlFile.seek(0, Deno.SeekMode.Current),
    };
  }

  async close(): Promise<void> {
    this.ticketsFile.close();
    this.messagesFile.close();
    this.jsonlFile.close();
  }

  get stats(): { tickets: number; messages: number } {
    return { tickets: this.ticketCount, messages: this.messageCount };
  }
}
