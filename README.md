# Mage CLI

Upload and organize a [Mage](https://magelegal.com) data room from your terminal, or from an AI agent.

Built for founders running diligence who want to populate a data room fast, and for the agents they hand the job to. Point it at a folder; it mirrors the structure into your room.

```bash
npx @magelegal/cli upload ./diligence --to "Corporate"
```

## Install

Run it on demand with `npx` (no install):

```bash
npx @magelegal/cli <command>
```

Or install the `mage` binary globally:

```bash
npm install -g @magelegal/cli
mage --help
```

Requires Node.js 20 or newer.

## Authentication

Sign in with your Mage account — no key to copy:

```bash
mage login
```

Your browser opens, you confirm a short code, and you're in. The CLI then picks a room (or asks, if your organization has several — brand-new account? it offers to create your first room right there) and **mints its own room-scoped API key** — named `CLI — <hostname>`, visible under **Settings → API keys** like any other key. That key is what every command runs on from then on, so the login **never expires**; it works until you revoke it (`mage logout`, or delete it in Settings → API keys).

Over SSH (or with `--no-browser`) the CLI prints the approval URL instead of opening a browser — visit it from any device, your phone included.

Everything is stored at `~/.config/mage/config.json`, readable only by you (`0600`).

Browser login needs an **owner or admin** of the room (it mints a key). A room member can use a key an admin minted for them, below.

### Using an existing key

Have a key from **Settings → API keys**? Store it directly:

```bash
mage login sk_…             # or: mage login --with-key  (hidden prompt, stays out of shell history)
```

### Headless / agent use

Set `MAGE_API_KEY` and skip `login` entirely. This is the path for AI agents and CI:

```bash
export MAGE_API_KEY="sk_…"
mage upload ./data-room
```

The CLI discovers which room the key belongs to on first use, so the key is all an agent needs.

| Variable | Purpose |
| --- | --- |
| `MAGE_API_KEY` | Room-scoped API key (overrides any stored login) |
| `MAGE_API_URL` | Override the API base URL (default `https://api-dataroom.magelegal.com`) |
| `MAGE_ROOM_ID` | Pin the room id (otherwise resolved from the key) |
| `MAGE_OAUTH_CLIENT_ID` | Override the OAuth client id (rare — it is discovered from the API) |

## Commands

| Command | Description |
| --- | --- |
| `mage login [key] [--room <room>] [--no-browser]` | Sign in via your browser (or store an API key) and bind this machine to a room |
| `mage logout` | Sign out: revoke the CLI's key where possible and clear this machine |
| `mage rooms` | List your organization's data rooms (browser login) |
| `mage use <room>` | Switch which room this machine is bound to (browser login) |
| `mage upload <paths…> [--to <folder>] [--for-item <itemId>]` | Upload files or whole folders, mirroring their structure |
| `mage readiness` | Show the room's readiness checklist: what's present, partial, and missing |
| `mage readiness attach <itemId> <documents…>` | Attach already-uploaded documents to a checklist item |
| `mage ls [folder]` | List the room's documents, grouped by folder |
| `mage download [target] [dest]` | Download the room, a folder, or one document, mirroring the folder structure |
| `mage mkdir <folder>` | Create an empty folder |
| `mage rm <target> [--folder] [--yes]` | Delete a document, or a folder with `--folder` |
| `mage version` | Print the CLI version |

Global flags: `--json` (machine-readable output on stdout) and `--api-url <url>`.

Every command above belongs to the **data room** product (`mage --help` groups them under "Data room"). Mage's diligence platform has no CLI surface yet; when it does, its commands will arrive as their own group rather than mixing in.

### Upload

A file lands in the folder you choose with `--to`; a directory mirrors its contents beneath it.

```bash
# One file into a folder (the folder is created if needed)
mage upload term-sheet.pdf --to "Financing"

# A whole tree: ./diligence/Corporate/charter.pdf  →  Corporate/charter.pdf
mage upload ./diligence

# The same tree, nested under a top-level folder
mage upload ./diligence --to "01-Diligence"
```

Uploads run in parallel. Dotfiles (`.DS_Store`, `.git`, …) are skipped. Files begin processing on arrival; `mage ls` shows their status.

### Readiness

Every room carries a readiness checklist — the documents investors expect to find, each `present`, `partial`, or `missing`. The CLI reads and fills it:

```bash
mage readiness                # the checklist, with what's still missing
mage readiness --json         # the same, structured for an agent

# Upload and satisfy a checklist item in one step
mage upload 2025-tax-return.pdf --for-item tax-returns

# Or link documents that are already in the room
mage readiness attach fin-statements q1.pdf q2.pdf
```

`--for-item` uploads the files, then attaches every one that landed to the item. `attach` accepts a document id, a name, or `folder/name`, and is additive — documents already attached to the item stay attached.

### List

```bash
mage ls                 # the whole room, grouped by folder
mage ls "Corporate"     # one folder and its subfolders
mage ls --json          # raw document array for scripting
```

### Download

```bash
mage download                        # the whole room → ./<room-name>/
mage download . ./backup             # the whole room → ./backup/
mage download "Corporate" ./corp     # one folder (recursive) → ./corp/
mage download "Corporate/charter.pdf"  # a single document, by folder/name (or by id)
mage download --json                 # machine-readable results for scripting
```

Folder structure is mirrored locally, files download five at a time, and every
file lands on the room's access-audit trail. Downloading requires a key minted
with the **Download** permission — keys minted by `mage login` include it.
Keys created before permissions existed are upload/organize-only: re-mint the
key (or run `mage login` again) to download.

### Delete

```bash
mage rm "Corporate/charter.pdf"     # a document, by folder/name (or by id)
mage rm "Drafts" --folder           # a folder (its documents move to Unsorted, never deleted)
mage rm "old.pdf" --yes             # skip the confirmation prompt
```

`rm` asks for confirmation interactively. In a non-interactive shell (an agent or CI), pass `--yes` to proceed.

## Using it with an AI agent

This is what the CLI is really for. Getting every document into a data room is the slowest part of running diligence — hand your agent a key and it does the gathering for you: it reads what the room still needs, pulls the documents from wherever they live (your accounting system, your drive, your inbox), and uploads each one against the right checklist item.

```bash
export MAGE_API_KEY="sk_…"    # the key is all an agent needs — it discovers its room
```

The loop:

```bash
# 1. Read what's missing.
mage readiness --json
#    → items with status "missing", each with an itemId, a label,
#      and a founderHint describing what the item should contain

# 2. Gather the documents from wherever they live (the agent's own tools).

# 3. Upload each against its item — one step, upload + attach.
mage upload ./downloads/2025-tax-return.pdf --for-item tax-returns

# 4. Re-read to confirm, and repeat until nothing required is missing.
mage readiness --json
```

An example task to give an agent: *"Pull last year's tax return from our accounting system and satisfy the missing tax items in my Mage data room readiness checklist."*

Beyond readiness, the same key drives the whole room: `mage ls --json` to read the current state, `mage mkdir` to lay out structure, `mage upload ./exports --to "Corporate"` to mirror local files in. Every command speaks `--json`, so an agent can read structured results and decide what to do next.

## What a key can and cannot do

A room-scoped key acts in **its own room only** and carries the permission set chosen when it was minted — visible under **Settings → API keys**. Keys minted by `mage login` can read the room's document list, upload, manage folders, delete documents, download document files, and read and fill the readiness checklist. A key minted without the **Download** permission cannot fetch document contents; one minted without **Manage room** (the default) cannot change room settings, people, or sharing. No key can reach another room or delete the room itself. Permissions are fixed at mint — re-mint to change them — and revoking a key under **Settings → API keys** kills it everywhere instantly. Keys created before permissions existed act as upload/organize-only.

Only `mage rooms` and `mage use` act as *you* rather than as the key (they list your org's rooms and mint the key for a newly chosen room); they reuse your browser sign-in and re-ask for approval when it has lapsed.

## Development

```bash
bun install
bun test          # unit tests
bun run typecheck
bun run build     # bundles to dist/index.js
```

The CLI is a thin client over the Mage lite data-room API; all document processing happens server-side.

## License

MIT
