import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  // src/index.ts opens with `#!/usr/bin/env node`; tsup preserves it so the
  // built dist/index.js is directly executable as the `mage` bin.
  clean: true,
  minify: false,
  sourcemap: false,
  dts: false,
  // Bake the package version into the binary (no runtime package.json read).
  define: { __VERSION__: JSON.stringify(version) },
})
