#!/usr/bin/env bun
/**
 * Builds the standalone binary plus the assets it can't embed.
 *
 * `bun build --compile` puts our code and OpenTUI's native renderer inside the
 * executable, but the tree-sitter parser worker can't be spawned from Bun's
 * virtual filesystem — it needs a real file on disk. So the WASM runtime, the
 * worker and the bundled grammars (~3.7 MB) go into a sidecar directory next to
 * the binary, which src/syntax.ts looks for at startup.
 *
 * Ship both, or ship just the binary and lose syntax highlighting.
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ASSET_DIR_NAME, PARSER_DIR_NAME, RUNTIME_ASSETS } from '../src/syntax.ts'

const root = join(import.meta.dir, '..')
const outDir = join(root, 'dist')
const binary = join(outDir, 'refiner')
const assetsDir = join(outDir, ASSET_DIR_NAME)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const build = Bun.spawn(
  ['bun', 'build', '--compile', '--minify', '--outfile', binary, join(root, 'src/index.ts')],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
)
if ((await build.exited) !== 0) process.exit(1)

for (const rel of RUNTIME_ASSETS) {
  const from = join(root, 'node_modules', rel)
  const to = join(assetsDir, rel)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

// Our own grammars ride along in the same sidecar, which is the only place a
// compiled binary can find them — `src/syntax.ts` looks here first.
await cp(join(root, 'assets', PARSER_DIR_NAME), join(assetsDir, PARSER_DIR_NAME), {
  recursive: true,
})

const size = (await Bun.file(binary).stat()).size
console.log(`\ndist/refiner            ${(size / 1024 / 1024).toFixed(1)} MB`)
console.log(`dist/${ASSET_DIR_NAME}/     tree-sitter runtime + grammars (bundled and vendored)`)
// Never the binary on its own: `scripts/install.ts` is what puts the two in the
// one layout where a compiled binary can still find its parsers.
console.log(`\nInstall both together:\n  bun run install-local`)
