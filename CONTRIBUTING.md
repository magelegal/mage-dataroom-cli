# Contributing

Thanks for your interest in the Mage CLI!

This repository is a **read-only mirror**: the CLI is developed in Mage's
internal monorepo and synced here automatically, so history arrives as squashed
sync commits and pull requests can't be merged through GitHub directly.

Contributions are still welcome:

- **Issues** are the best way to report bugs or request features — we watch them.
- **Pull requests** get reviewed here; if accepted, a maintainer applies the
  change internally with `Co-authored-by:` credit, and it lands in the next
  sync (your PR is then closed with a pointer to the sync commit).

CI runs on every PR (`bun test`, typecheck, build, and an `npm publish`
dry-run), so you'll get fast feedback either way.

## Local development

```bash
bun install
bun test
bun run typecheck
bun run build     # bundles to dist/index.js
node dist/index.js --help
```

Please keep examples synthetic (`ExampleCo`, `founder@example.com`) — never
real company, deal, or person names.
