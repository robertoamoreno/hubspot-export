# HubSpot Ticket & Conversation Dump

Exports all tickets and their full conversation histories (emails, replies, threads) from HubSpot into CSV files.

## What This Does

This tool connects to your HubSpot account and downloads:

1. **All tickets** with their metadata (every property defined in your account)
2. **All emails** associated with each ticket (incoming and outgoing)
3. **All conversation threads** linked to each ticket (chat messages, thread replies)

Everything is saved as CSV and JSONL files that you can open in Excel, import into a database, or feed into a knowledge base.

Designed for large accounts (100k-750k+ tickets): processes in chunks of 5,000, saves progress after each chunk, and automatically resumes from the last checkpoint if interrupted.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- A **HubSpot Service Key** (see next section)

## Getting a HubSpot Service Key

A service key allows this tool to read data from your HubSpot account. Follow these steps to create one:

### Step-by-step instructions

**1.** Log in to your HubSpot account and click the **Settings gear icon** in the top navigation bar. In the left sidebar, expand **Integrations** and click **Service Keys**:

![Settings sidebar showing Integrations > Service Keys](docs/step-1-settings-sidebar.png)

**2.** On the Service Keys page, click **"Create service key"** in the top right corner:

![Service Keys list with Create button](docs/step-2-service-keys-list.png)

**3.** Enter a **Name** for your key (e.g. "Ticket Dump"):

![Create Service Key form](docs/step-3-create-form.png)

**4.** Click **"+ Add new scope"**. In the search box, search for each of the three required scopes one at a time and check the box for each:

| Scope | Why it's needed |
|-------|----------------|
| `tickets` | Read ticket data and associations |
| `conversations.read` | Read conversation threads and messages |
| `sales-email-read` | Read email content associated with tickets |

![Searching and selecting scopes](docs/step-4-add-scope.png)

**5.** Click **"Update"** after selecting all three scopes, then click **"Create"**. Your key will be shown on the next page. Click **"Show"** to reveal it, then **"Copy"** to copy it to your clipboard:

![Completed service key showing token and scopes](docs/step-5-completed-key.png)

The token looks like: `pat-na2-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

## How to Run

### Step 1: Set up your token

Create a file called `.env` with your service key and portal ID:

```
HUBSPOT_ACCESS_TOKEN=pat-na2-your-actual-token-here
HUBSPOT_PORTAL_ID=12345678
```

You can find your portal ID in any HubSpot URL: `app.hubspot.com/contacts/{portal_id}/...`

### Step 2: Run the export

```bash
docker run --env-file .env -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

That's it! The tool will:
- Read your HubSpot token from the `.env` file
- Download all tickets and their conversations in chunks of 5,000
- Save a checkpoint after each chunk (so it can resume if interrupted)
- Save the output files in the `output/` folder on your machine

### Exporting a specific year

For large accounts, you can filter to a single year to keep export times manageable:

```bash
docker run --env-file .env -e YEAR=2025 -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

This uses the HubSpot Search API to only fetch tickets created in the specified year. Only months up to the current date are queried (future months are skipped). Date ranges with more than 10,000 tickets are automatically split into smaller ranges to stay within HubSpot's search API limits.

### Resuming an interrupted export

If the export is stopped or crashes, just run the same command again. It will automatically:
- Load cached ticket IDs and properties (skipping the initial discovery phase)
- Resume from the last completed chunk
- Append to the existing output files

To start fresh, delete the `output/` folder before running.

### Sample output

```
=== HubSpot Ticket + Conversation Dump ===

Fetching ticket property definitions...
Found 658 ticket properties.
Fetching ticket IDs...
  ...5000 ticket IDs fetched (15.3s elapsed)
Fetched 50000 ticket IDs in 149.8s.

Processing 50000 tickets in 10 chunks of 5000 (concurrency: 10)...

--- Chunk 1/10 (5000 tickets) ---
  Associations batch 1/5 (1000/5000 tickets)...
  ...
Progress: 5000/50000 (10.0%) | 8368 emails, 3118 convos | ETA: 82m 5s
  [Checkpoint saved: 5000 tickets complete]

--- Chunk 2/10 (5000 tickets) ---
  ...

=== Dump Complete ===
Tickets:      50000
Messages:     95432
  Emails:     62100
  Conversations: 33332
Errors:       3
Output dir:   ./output/
  tickets.csv   - ticket metadata
  messages.csv  - all conversation messages
  dump.jsonl    - full structured data
```

## Output Files

After the export completes, you'll find three files in the `output/` folder:

### `tickets.csv`

One row per ticket. Columns are dynamically generated from every ticket property defined in your HubSpot account, plus two extra columns appended at the end:

| Column | Description |
|--------|-------------|
| *(all property labels)* | Every ticket property in your account (e.g. "Ticket name", "Pipeline", "Ticket status", "Priority", "Create date", etc.) |
| `Message Count` | Total emails + conversation messages found for this ticket |
| `URL` | Direct link to the ticket in HubSpot |

### `messages.csv`

One row per message. Contains the full conversation history for all tickets.

| Column | Description | Example |
|--------|-------------|---------|
| `ticket_id` | Which ticket this belongs to | `12345678` |
| `message_id` | Unique message ID | `msg_abc123` |
| `timestamp` | When the message was sent | `2024-01-15T10:30:00Z` |
| `direction` | `INCOMING` (customer) or `OUTGOING` (agent) | `INCOMING` |
| `sender` | Sender's email address | `john@example.com` |
| `recipient` | Recipient's email address | `support@company.com` |
| `subject` | Email subject line | `Re: Cannot login` |
| `body` | Message content (plain text) | `I tried resetting my password but...` |
| `source_type` | `EMAIL` or `CONVERSATION` | `EMAIL` |
| `thread_id` | Conversation thread ID (conversations only) | `thread_789` |

### `dump.jsonl`

One JSON object per line, containing the full structured data for each ticket and all its messages. Useful for programmatic processing.

### Cache and checkpoint files

The `output/` folder also contains files used for caching and resume:

| File | Purpose |
|------|---------|
| `ticket_ids.json` | Cached ticket IDs (avoids re-fetching on resume) |
| `ticket_ids_2025.json` | Cached ticket IDs for year-filtered runs |
| `properties.json` | Cached property definitions |
| `checkpoint.json` | Current progress (deleted on successful completion) |

These are safe to delete if you want to force a fresh export.

## How Long Does It Take?

| Ticket Count | Estimated Time |
|-------------|---------------|
| 1-100 | Under 1 minute |
| 1,000 | 2-5 minutes |
| 10,000 | 15-25 minutes |
| 50,000 | 1-2 hours |
| 100,000 | 3-5 hours |
| 300,000+ | 10-15 hours |

The tool uses batch APIs and parallel fetching to maximize throughput while respecting HubSpot's rate limits. Email associations and content are fetched in bulk (up to 1,000 per request), and conversation threads are fetched with configurable concurrent workers. Progress with ETA is printed to the terminal as it runs.

For very large accounts, use the `YEAR` filter to export one year at a time.

## Troubleshooting

### `HUBSPOT_ACCESS_TOKEN is not set`

Make sure you:
1. Created the `.env` file
2. Added your actual token to the `.env` file
3. Included `--env-file .env` in the `docker run` command

### `HUBSPOT_PORTAL_ID is not set`

Add your portal ID to the `.env` file. Find it in any HubSpot URL: `app.hubspot.com/contacts/{portal_id}/...`

### `HubSpot API 401` / `Unauthorized`

Your token is invalid or expired. Generate a new one in HubSpot Settings > Integrations > Service Keys.

### `HubSpot API 403` / `Forbidden`

Your token is missing required scopes. Go to your Service Key settings and make sure these scopes are enabled:
- `tickets`
- `conversations.read`
- `sales-email-read`

If you see 403 errors specifically when fetching emails, you may also need to add the `crm.objects.emails.read` scope.

### `Rate limit exceeded` / `429 Too Many Requests`

The tool has built-in rate limiting with automatic retry and exponential backoff. If it persists, reduce concurrency:

```bash
docker run --env-file .env -e CONCURRENCY=5 -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

### The output files are empty

Check the terminal output for errors. Common causes:
- No tickets exist in the HubSpot account
- The token doesn't have the `tickets` scope
- Network connectivity issues

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | Yes | — | Your HubSpot service key / PAT |
| `HUBSPOT_PORTAL_ID` | Yes | — | HubSpot portal ID (for ticket URLs in CSV). Find it in your HubSpot URL: `app.hubspot.com/contacts/{portal_id}/...` |
| `OUTPUT_DIR` | No | `./output` | Where to save the dump files |
| `CONCURRENCY` | No | `10` | Number of parallel conversation fetches. Lower if you hit rate limits |
| `CHUNK_SIZE` | No | `5000` | Number of tickets per processing chunk. Lower to reduce memory usage |
| `YEAR` | No | — | Filter to tickets created in this year (e.g. `2025`). Uses the Search API; only queries up to the current date and auto-splits large date ranges |
