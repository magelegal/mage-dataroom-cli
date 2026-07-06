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
| `mage upload <paths…> [--to <folder>]` | Upload files or whole folders, mirroring their structure |
| `mage ls [folder]` | List the room's documents, grouped by folder |
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

### List

```bash
mage ls                 # the whole room, grouped by folder
mage ls "Corporate"     # one folder and its subfolders
mage ls --json          # raw document array for scripting
```

### Delete

```bash
mage rm "Corporate/charter.pdf"     # a document, by folder/name (or by id)
mage rm "Drafts" --folder           # a folder (its documents move to Unsorted, never deleted)
mage rm "old.pdf" --yes             # skip the confirmation prompt
```

`rm` asks for confirmation interactively. In a non-interactive shell (an agent or CI), pass `--yes` to proceed.

## Using it with an AI agent

Hand your agent a key and a directory, and let it populate the room:

```bash
export MAGE_API_KEY="sk_…"

mage ls --json                              # read the current state first
mage mkdir "Corporate/Charters"             # lay out structure
mage upload ./exports --to "Corporate"      # mirror local files in
mage ls                                      # confirm
```

Every command speaks `--json`, so an agent can read structured results and decide what to do next.

## What a key can and cannot do

A room-scoped key — whether the CLI minted it at login or you pasted one in — can read the room's document list, upload, manage folders, and delete documents in **its own room only**. It **cannot** download document contents, reach another room, or change room settings. Revoke a key any time under **Settings → API keys**; that kills it everywhere instantly.

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
