# Mage Data Room CLI

This directory is the source of truth for the **public, open-source** package
[`@magelegal/cli`](https://www.npmjs.com/package/@magelegal/cli). It is developed
inside a private monorepo and mirrored automatically to
[magelegal/mage-dataroom-cli](https://github.com/magelegal/mage-dataroom-cli).

## Everything in this directory becomes public

Write every file — code, comments, tests, fixtures, docs — as if it publishes the
moment you save it, because it does (on the next sync).

- **No internal names**: no customer, deal, partner, attorney, or vendor names;
  no competitor names; nothing seen in a live data room or production trace.
  Invent synthetic examples (`ExampleCo`, `founder@example.com`, `Seed Round`).
- **No internal infrastructure**: no account IDs, internal hostnames, staging
  identifiers, secret names, or links to private repos, dashboards, or tickets.
  The public API hosts (`api-dataroom.magelegal.com`) are fine — they're the
  product.
- **No internal context in prose**: comments and docs explain the code, never
  the internal roadmap, incidents, or systems around it.

A sync-time scanner enforces a denylist, but the scanner is a backstop —
it cannot recognize a novel name. The rule is the mechanism.

## Product scope

Everything here is the **data room** product: commands live in
`src/commands/dataroom/` and render under the "Data room:" help group. If the
diligence platform ever grows a CLI surface, it gets `src/commands/diligence/`
and its own help group. Shared seams (`client`, `config`, `session`, `output`,
`prompt`) stay product-neutral.

## Development

```bash
bun install
bun test          # unit tests
bun run typecheck
bun run build     # bundles to dist/index.js
```

Zero runtime dependencies beyond `commander` + `picocolors`; keep it that way —
this runs via `npx` on strangers' machines. Node floor is 20 (`engines`); don't
raise it for a convenience.

Releases: bump `version` in package.json; the sync runs on prod promotion
(monorepo push to `main`), and a new version then gets a `v<version>` tag
automatically, which the public repo's `release.yml` publishes to npm via
trusted publishing (OIDC, tokenless). Staging merges do NOT release — a CLI
version must never precede the prod API it talks to.
