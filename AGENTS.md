# Mage Data Room CLI

This directory is the source of truth for a public, open-source npm package. It is
developed inside a private monorepo and mirrored automatically to its public GitHub repo.

## Everything here becomes public

Write every file — code, comments, tests, fixtures, docs — as if it publishes the moment
you save it, because the next prod promotion publishes it verbatim.

- **No internal names.** No customer, deal, partner, attorney, vendor, or competitor names,
  and nothing seen in a live data room or production trace. Invent synthetic examples
  (`ExampleCo`, `founder@example.com`, `Seed Round`).
- **No internal infrastructure.** No account ids, internal hostnames, staging identifiers,
  secret names, or links to private repos, dashboards, or tickets. The public API host is
  fine — it is the product.
- **No internal context in prose.** Comments and docs explain the code, never the roadmap,
  the incidents, or the systems around it.
- The denylist scan (`.github/dataroom-cli-denylist.txt`) gates PRs and the sync, but it
  can only match a name someone already wrote down. It is a backstop; the rule is the
  mechanism.

## Product scope

Everything here is the data room product: commands live in `src/commands/dataroom` and
render under the "Data room:" help group. If the diligence platform ever grows a CLI
surface it gets `src/commands/diligence` and its own help group. Shared seams (`client`,
`config`, `session`, `output`, `prompt`) stay product-neutral.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

Zero runtime dependencies beyond `commander` and `picocolors` — this runs via `npx` on
strangers' machines, so keep it that way. The Node floor is 20 in `engines`; don't raise it
for a convenience.

## Releasing

- The mirror runs on prod promotion (a monorepo push to `main`). A bumped `version` in
  `package.json` gets a version tag automatically, and the public repo's release workflow
  publishes to npm via trusted publishing (OIDC, tokenless).
- Staging merges never release. A CLI version must never precede the prod API it talks to,
  so neither the public repo nor npm can describe a feature prod can't serve.
