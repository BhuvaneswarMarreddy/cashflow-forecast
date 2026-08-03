# cf-ledger — an MCP server over your CashFlow ledger

## 1. What this is

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude read
your transaction ledger and answer questions about it. Five tools, all read-only:

| Tool | Answers |
|---|---|
| `get_ledger_summary` | Income, spending and net by year and by month; spending by category; top merchants. |
| `find_transactions` | Search by text, date range, kind, account and amount, with exact cents totals over **all** matches. |
| `explain_counterparty` | The whole two-way relationship with one person or payee — sent, received, net, and whether it is loan-shaped or a running tab. |
| `get_recurring` | Subscriptions and recurring charges detected from repetition in the ledger itself, with the monthly total. |
| `list_unmapped` | The money the app cannot yet classify, grouped biggest-impact-first, with the evidence behind each suggestion. |

**Nothing here can write.** The tools are pure functions over an in-memory ledger; they
never see the filesystem, Firestore or the network. `list_unmapped` reports what needs a
decision and stops — classification only ever happens with an explicit confirmation by
you, inside the app. The read-only property is enforced by tests, not just by intent:
`server.check.ts` greps every source under `mcp/` for the write surface of both Firebase
SDKs (`.set(`, `.update(`, `.delete(`, `.add(`, `.create(`, `writeBatch`, `batch(`,
`bulkWriter`, `recursiveDelete`) and fails the build if one appears, and separately
asserts that only four collections are ever named.

Every tool's answer is computed by the same `src/lib` code the app itself uses — the MCP
layer is wiring, so a number here and a number on screen cannot disagree.

## 2. Prerequisites

```bash
npm install          # at the repo root; the server shares the app's dependencies
```

Then **one** data source:

**A Monarch export (default).** In Monarch: *Settings → Data → Download transactions*.
Unzip it into `transactionsbyaccount/` at the repo root — one CSV per account, files
directly in the folder, no nested directory. This folder is gitignored. Point somewhere
else with `CASHFLOW_CSV_DIR=/path/to/folder`.

**Or live Firestore.** Optional, needs a service-account key — see §6.

## 3. Try it

```bash
npm run mcp
```

The server starts on stdio and then **sits there silently**. That is correct, not a
hang: stdout is the JSON-RPC channel, so the server prints exactly one line to *stderr*
(`cf-ledger MCP server on stdio`) and nothing at all to stdout until a client speaks to
it. Ctrl-C to stop.

To prove the whole pipeline works before wiring any client:

```bash
npm run test:mcp
```

That suite loads a fixture ledger, exercises all five tools, checks the error messages
verbatim, and spawns the real server binary over real stdio to confirm the protocol
stream stays clean.

## 4. Use it from Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cf-ledger": {
      "command": "/ABSOLUTE/PATH/TO/cashflow-forecast/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/TO/cashflow-forecast/mcp/server.ts"],
      "env": {
        "CASHFLOW_CSV_DIR": "/ABSOLUTE/PATH/TO/cashflow-forecast/transactionsbyaccount"
      }
    }
  }
}
```

Absolute paths throughout, and **use the `tsx` binary directly — not `npm run mcp`.**
npm prints its own banner to stdout, which corrupts the JSON-RPC stream before the
server ever gets a turn; the client just reports a disconnect.

Then quit and reopen Claude Desktop — config is read at launch — and look for the tools
icon in the message box. `cf-ledger` and its five tools should be listed.

## 5. Use it from Claude Code

```bash
claude mcp add cf-ledger -- /ABSOLUTE/PATH/TO/cashflow-forecast/node_modules/.bin/tsx /ABSOLUTE/PATH/TO/cashflow-forecast/mcp/server.ts
```

Same rule: the `tsx` binary, absolute paths. Check it with `claude mcp list`.

## 6. Optional: read live Firestore instead of the CSV

The CSV is a snapshot; Firestore is what the app is looking at right now. It costs one
service account.

```bash
gcloud iam service-accounts create cf-mcp-reader \
  --display-name="CashFlow MCP read-only" --project=marreddy-cashflow

gcloud projects add-iam-policy-binding marreddy-cashflow \
  --member="serviceAccount:cf-mcp-reader@marreddy-cashflow.iam.gserviceaccount.com" \
  --role="roles/datastore.viewer"
```

`roles/datastore.viewer` and nothing else. Then create the key **outside the repo**:

```bash
mkdir -p ~/.config/cashflow && chmod 700 ~/.config/cashflow
gcloud iam service-accounts keys create ~/.config/cashflow/cf-mcp-reader.json \
  --iam-account=cf-mcp-reader@marreddy-cashflow.iam.gserviceaccount.com
chmod 600 ~/.config/cashflow/cf-mcp-reader.json
```

Add both variables to the `env` block in your client config (or export them for
`npm run mcp`):

```json
"env": {
  "CASHFLOW_FIRESTORE_KEY": "/Users/you/.config/cashflow/cf-mcp-reader.json",
  "CASHFLOW_FIRESTORE_UID": "the-firebase-auth-uid"
}
```

The uid is in the Firebase console under *Authentication → Users*. Firestore is used only
when **both** are set; with only the key you get a message telling you the uid is
missing, rather than a silent fall back to a stale CSV.

> **`firestore.rules` do not protect you here.** The Admin SDK bypasses security rules
> entirely — a key with write permission would be able to write no matter what the rules
> file says. **IAM is the guarantee**, which is why the role above is exactly
> `roles/datastore.viewer` and why the key must never be created with a broader one.
> Belt and braces: the loader (`mcp/load-firestore.ts`) reads four hard-coded collection
> paths — `accounts`, `transactions`, `income`, `reviews` — with no function anywhere
> that takes a collection name, so the sync-metadata document that holds a
> credential-bearing provider URL is unreachable from this server by construction.

Documents cross into the server through an explicit field whitelist: each mapper builds
a fresh object out of named fields, so a field this server does not use — an ingest
fingerprint, a provider id, your own free-text note on a reviewed deposit — is dropped
by construction and never reaches the model.

## 7. Privacy

Merchants, amounts, dates and account names **do** flow to the model. That is the
product: you cannot ask "what did I spend at the pharmacy last quarter" without sending
the pharmacy and the amounts.

What does not flow: every tool response passes through the app's own redactor
(`src/lib/obs/redact.ts`) before it leaves the server, which strips URLs, tokens, keys
and long account-number runs, and masks card numbers down to `****1111`. The check suite
plants a credential URL and a card number in a fixture and asserts zero findings in all
five tools' output.

Consider what that means for your client, though: with Claude Desktop or Claude Code,
whatever the model reads goes to Anthropic under that product's terms. The server is
local; the conversation is not.

## 8. Troubleshooting

**"Server disconnected" right after starting.** Something printed to stdout. Almost
always this is `npm run` in the client config instead of the `tsx` binary — see §4. Any
`console.log` added anywhere in the import graph does it too; the server prints to stderr
only, on purpose.

The five errors the server itself reports, verbatim:

- `CSV folder not found at <path>. Export your transactions from Monarch (Settings -> Data -> Download transactions), unzip into transactionsbyaccount/ at the repo root, or set CASHFLOW_FIRESTORE_KEY=/path/to/service-account.json to read live data instead.`
  → the folder is missing, or `CASHFLOW_CSV_DIR` points at the wrong place. Relative
  paths resolve against the *client's* working directory, so use an absolute one.

- `No .csv files in <path>. The Monarch export is one CSV per account; place them directly in this folder.`
  → the unzip left a nested folder. Move the CSVs up one level.

- `CASHFLOW_FIRESTORE_KEY points to <path> but it cannot be read: ENOENT. Check the path, or unset it to fall back to the CSV export.`
  → wrong path, or `EACCES` if the key's permissions are too tight for the user running
  the client.

- `CASHFLOW_FIRESTORE_UID is not set. It must be the Firebase Auth uid whose ledger to read (Firebase console -> Authentication -> Users).`
  → half-configured Firestore. Set the uid, or unset the key to use the CSV.

- `The service account was refused by Firestore. It needs the roles/datastore.viewer role on the project — and nothing more; this server is read-only by design.`
  → the IAM binding from §6 was not applied, or was applied to a different project.

**Numbers look stale.** The ledger is cached for 60 seconds per process, and the CSV
source is only as fresh as your last Monarch export. `get_ledger_summary` reports
`loadedAt` and the ledger's date span — check them before trusting a "lapsed"
subscription in `get_recurring`, which is judged against today.
