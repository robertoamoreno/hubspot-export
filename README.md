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

### Exporting a specific pipeline

To export only the tickets in one pipeline, pass its name or its id:

```bash
docker run --env-file .env -e PIPELINE="Support Pipeline" -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

Matching is case-insensitive, and an unrecognised value fails immediately with
a list of the pipelines in your account — so a typo can't quietly export zero
tickets. Combine it with `YEAR` to narrow further:

```bash
docker run --env-file .env -e PIPELINE=0 -e YEAR=2025 -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

Filtering to a pipeline also trims the ticket columns. HubSpot generates four
properties per pipeline *stage* (date entered, date exited, cumulative time in,
latest time in), and a ticket in one pipeline can never hold a value for
another pipeline's stages. On a portal with 32 pipelines and 208 stages that
removed 760 of 1,460 columns — and shrinks every batch request by the same
proportion, so the export runs faster too.

Pipeline-filtered runs go through the Search API (the plain list endpoint
can't filter), splitting large date ranges the same way the `YEAR` filter does.
Cached ticket ids are stored per filter combination, so a pipeline run never
reuses a whole-account cache.

### Skipping conversations (emails only)

If you only need email data and want to dramatically reduce API usage (~3,300 calls instead of ~242,000 for 90k tickets):

```bash
docker run --env-file .env -e SKIP_CONVERSATIONS=true -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

Conversation threads (live chat, chatbot, Messenger) are the most API-intensive part of the export since HubSpot has no batch endpoint for them. Email data already captures most support interactions (incoming/outgoing emails with full content, sender, recipient, and timestamps).

### Duplicate messages

When a connected inbox backs a conversation thread, HubSpot returns the same
message twice — once as an email engagement and once as a thread message, with
different ids. Both are fetched, then collapsed into a single row: the email
copy is kept (it has a stable CRM object id) and the thread id from the
conversation copy is carried onto it.

Two messages are treated as the same when their bodies match ignoring case and
whitespace *and* their timestamps are within 60 seconds, so a genuinely
repeated reply stays a separate row. The count is reported as
`Duplicates removed` at the end of the run.

To keep both copies, set `SKIP_DEDUPE=true`.

### Dropping empty ticket columns

`tickets.csv` has one column per ticket property defined in your account, and
most accounts define far more than any one export uses — a production run of
7,687 tickets filled only 269 of 1,462 columns.

```bash
docker run --env-file .env -e DROP_EMPTY_COLUMNS=true -v "$(pwd)/output:/app/output" tempestdx/hubspot-export
```

After the export finishes, columns that are empty in *every* row are removed.
It runs over the completed file rather than a sample, because more tickets
surface more used properties — the same export filled 136 columns at 81
tickets and 269 at 7,687. On that run it took under two seconds and cut
`tickets.csv` from 27.9 MB to 18.7 MB.

This only runs once the export is complete, since rewriting `tickets.csv`
invalidates the byte offsets a resume depends on.

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
Incomplete:   12 tickets missing some email data
Output dir:   ./output/
  tickets.csv   - ticket metadata
  messages.csv  - all conversation messages
  attachments.csv - files referenced by messages
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
| `direction` | `INCOMING` (customer), `OUTGOING` (agent), or `UNKNOWN` — normalised across both sources | `INCOMING` |
| `sender` | Sender's email address | `john@example.com` |
| `recipient` | Recipient's email address | `support@company.com` |
| `subject` | Email subject line | `Re: Cannot login` |
| `body` | Message content (plain text) | `I tried resetting my password but...` |
| `source_type` | `EMAIL` or `CONVERSATION` | `EMAIL` |
| `thread_id` | Conversation thread ID (conversations only) | `thread_789` |
| `direction_raw` | The unnormalised value HubSpot returned. Emails use `EMAIL` (meaning *sent*) and `INCOMING_EMAIL`; conversations use `OUTGOING` and `INCOMING` | `INCOMING_EMAIL` |

### `attachments.csv`

One row per file referenced by a message.

| Column | Description | Example |
|--------|-------------|---------|
| `ticket_id` | Ticket the file belongs to | `18415718414` |
| `message_id` | Message the file was attached to | `m_abc123` |
| `source_type` | `EMAIL` or `CONVERSATION` | `CONVERSATION` |
| `file_id` | HubSpot file id. Empty for inline images | `184474609443` |
| `name` | File name | `Screenshot 2025-01-02.png` |
| `kind` | `IMAGE` or `OTHER` from HubSpot, or `INLINE` for an image found in an email's HTML body | `IMAGE` |
| `url` | Direct URL. Conversation attachment URLs are publicly readable | `https://….hubspotusercontent-na1.net/…` |
| `local_path` | Path to the downloaded file, when `DOWNLOAD_ATTACHMENTS=true` | `attachments/184474609443-screenshot.png` |

Three sources feed this file:

- **Conversation attachments** come back inline from the Conversations API with
  a name and a directly downloadable URL.
- **Email attachments** appear on the email as `hs_attachment_ids`. Turning an
  id into a name and URL needs the **`files` scope**, which is not in the three
  scopes listed above. Without it the ids are still recorded, but `name` and
  `url` stay empty and the run warns once.
- **Inline images** are pulled out of `hs_email_html`. The message body is taken
  from `hs_email_text` whenever it exists — which is almost always — so images
  present only in the HTML would otherwise never be seen.

### `dump.jsonl`

One JSON object per line, containing the full structured data for each ticket and all its messages. Useful for programmatic processing.

### Cache and checkpoint files

The `output/` folder also contains files used for caching and resume:

| File | Purpose |
|------|---------|
| `ticket_ids.json` | Cached ticket IDs (avoids re-fetching on resume) |
| `ticket_ids_2025.json` | Cached ticket IDs for year-filtered runs |
| `ticket_ids_p0_2025.json` | Cached ticket IDs per pipeline (`p<id>`) and year |
| `properties.json` | Cached property definitions |
| `properties_p0.json` | Cached property definitions for a pipeline-filtered run (`p<id>`) |
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

### `Completed with N error(s) — this export is missing data`

Some batches could not be read from HubSpot, so the tickets they covered were
written without their emails. The run exits with a non-zero status when this
happens, and the `Incomplete:` line reports how many tickets are affected.

When a batch fails with a per-record error (a 4xx), the tool splits it in half
and retries so a single bad record doesn't cost the whole batch — the warnings
name the ids it could not read. Rate limits and server errors are not split;
those are retried with backoff instead, and lower `CONCURRENCY` if they persist.

A run that reports `Errors: 0` exits `0` and its output is complete.

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
| `PIPELINE` | No | — | Filter to one ticket pipeline, by name or id (e.g. `"Support Pipeline"` or `0`). Case-insensitive; an unknown value lists the valid pipelines and exits |
| `YEAR` | No | — | Filter to tickets created in this year (e.g. `2025`). Uses the Search API; only queries up to the current date and auto-splits large date ranges |
| `SKIP_CONVERSATIONS` | No | `false` | Set to `true` to skip fetching conversation threads/messages and only export emails. Reduces API calls by ~98% |
| `DROP_EMPTY_COLUMNS` | No | `false` | Set to `true` to remove ticket columns that are empty across the whole export, as a post-pass |
| `SKIP_DEDUPE` | No | `false` | Set to `true` to keep both copies of a message that HubSpot returns as both an email and a conversation message |

## Development

The project pins Deno 2.7.4 in the Dockerfile, and `deno.lock` is version 5 —
older Deno releases can't read it. Rather than installing Deno locally, run the
toolchain out of the same pinned image:

```bash
# Tests
docker run --rm -v "$(pwd):/app" -w /app denoland/deno:2.7.4 task test

# Lint
docker run --rm -v "$(pwd):/app" -w /app denoland/deno:2.7.4 lint

# Type check (needs an explicit entrypoint — `check` isn't one of the
# subcommands the image's entrypoint script forwards on its own)
docker run --rm -v "$(pwd):/app" -w /app --entrypoint deno denoland/deno:2.7.4 check src/*.ts
```

To build the runtime image locally:

```bash
docker build -t hubspot-export:local .
```

`scripts/build-and-push.sh` also pushes to Docker Hub and creates a git tag —
use a plain `docker build` for local work.

Test files live next to the code as `src/*_test.ts` and are excluded from the
runtime image via `.dockerignore`.
