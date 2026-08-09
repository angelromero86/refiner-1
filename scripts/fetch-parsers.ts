#!/usr/bin/env bun
/**
 * Regenerates `assets/parsers/` — the tree-sitter grammars refiner ships itself.
 *
 * @opentui/core bundles parsers for typescript, javascript, markdown and zig and
 * nothing else, so every other filetype rendered in flat diff colors. The client
 * takes extra grammars through `addFiletypeParser`, which accepts plain local
 * paths, so the fix is to vendor a `.wasm` and its highlight query per language
 * and hand them over at startup — no network at runtime, which is the one thing
 * a git TUI has no business doing on its own.
 *
 * The artifacts are committed (~400 KB total). This script exists so they can be
 * regenerated and audited rather than taken on faith: run it and diff.
 *
 *   bun run scripts/fetch-parsers.ts
 *
 * Grammars come from their own release pages wherever the upstream project
 * publishes a `.wasm`, so the grammar matches the queries written against it.
 * SCSS publishes none and is compiled here from the npm tarball, which needs the
 * tree-sitter CLI (`cargo install tree-sitter-cli`) — the only step with a tool
 * requirement, and only when regenerating.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PARSER_DIR_NAME, VENDORED_FILETYPES } from '../src/syntax.ts'

interface Source {
  /** A release URL, or an npm tarball to compile when upstream ships no wasm. */
  wasm: string | { npm: string; subdir?: string }
  /** Concatenated in order — the same thing nvim's `; inherits:` line means. */
  queries: string[]
  grammar: string
  license: string
}

const NVIM = 'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries'
const REL = (repo: string, file: string) => `https://github.com/${repo}/releases/latest/download/${file}`

const SOURCES: Record<string, Source> = {
  json: {
    wasm: REL('tree-sitter/tree-sitter-json', 'tree-sitter-json.wasm'),
    queries: [`${NVIM}/json/highlights.scm`],
    grammar: 'tree-sitter/tree-sitter-json',
    license: 'MIT',
  },
  toml: {
    wasm: REL('tree-sitter-grammars/tree-sitter-toml', 'tree-sitter-toml.wasm'),
    queries: [`${NVIM}/toml/highlights.scm`],
    grammar: 'tree-sitter-grammars/tree-sitter-toml',
    license: 'MIT',
  },
  css: {
    wasm: REL('tree-sitter/tree-sitter-css', 'tree-sitter-css.wasm'),
    queries: [`${NVIM}/css/highlights.scm`],
    grammar: 'tree-sitter/tree-sitter-css',
    license: 'MIT',
  },
  scss: {
    // No upstream wasm. The grammar is CSS's with SCSS on top, so it takes the
    // CSS queries as a base — that is where property/value coloring comes from —
    // and its own on top for `$variables`, `@mixin` and nesting.
    wasm: { npm: 'tree-sitter-scss@1.0.0' },
    queries: [`${NVIM}/css/highlights.scm`, 'npm:queries/highlights.scm'],
    grammar: 'serenadeai/tree-sitter-scss (npm tree-sitter-scss@1.0.0)',
    license: 'MIT',
  },
  html: {
    wasm: REL('tree-sitter/tree-sitter-html', 'tree-sitter-html.wasm'),
    // The grammar's own queries, NOT nvim's: nvim's html highlights inherit an
    // `html_tags` file written against a different grammar, and the query fails
    // to compile against this one — which reads as "no highlighting", silently.
    queries: ['https://raw.githubusercontent.com/tree-sitter/tree-sitter-html/master/queries/highlights.scm'],
    grammar: 'tree-sitter/tree-sitter-html',
    license: 'MIT',
  },
  xml: {
    wasm: REL('tree-sitter-grammars/tree-sitter-xml', 'tree-sitter-xml.wasm'),
    queries: [`${NVIM}/xml/highlights.scm`],
    grammar: 'tree-sitter-grammars/tree-sitter-xml',
    license: 'MIT',
  },
}

const root = join(import.meta.dir, '..')
const outDir = join(root, 'assets', PARSER_DIR_NAME)

const missing = VENDORED_FILETYPES.filter((ft) => !(ft in SOURCES))
if (missing.length > 0) {
  console.error(`No source for vendored filetype(s): ${missing.join(', ')}`)
  process.exit(1)
}

async function get(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res.arrayBuffer()
}

/** Compile a grammar published only as source. Needs the tree-sitter CLI. */
async function buildFromNpm(spec: string): Promise<Uint8Array> {
  const work = join(outDir, '.build')
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })

  const pack = Bun.spawn(['npm', 'pack', spec, '--quiet'], { cwd: work, stdout: 'pipe', stderr: 'pipe' })
  if ((await pack.exited) !== 0) throw new Error(`npm pack ${spec}: ${await new Response(pack.stderr).text()}`)
  const tgz = (await new Response(pack.stdout).text()).trim().split('\n').pop()!

  const src = join(work, 'src')
  await mkdir(src, { recursive: true })
  const untar = Bun.spawn(['tar', 'xzf', tgz, '-C', src, '--strip-components=1'], { cwd: work })
  if ((await untar.exited) !== 0) throw new Error(`tar xzf ${tgz}`)

  const out = join(work, 'parser.wasm')
  const build = Bun.spawn(['tree-sitter', 'build', '--wasm', '-o', out, '.'], {
    cwd: src,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await build.exited) !== 0) {
    throw new Error(`tree-sitter build --wasm failed for ${spec} (is the tree-sitter CLI installed?)`)
  }

  const wasm = new Uint8Array(await Bun.file(out).arrayBuffer())
  const queries = new Map<string, string>()
  for (const rel of ['queries/highlights.scm']) {
    const f = Bun.file(join(src, rel))
    if (await f.exists()) queries.set(`npm:${rel}`, await f.text())
  }
  npmQueries.set(spec, queries)
  await rm(work, { recursive: true, force: true })
  return wasm
}

/** Query files that came out of an npm tarball, keyed by spec then by `npm:` path. */
const npmQueries = new Map<string, Map<string, string>>()

const rows: string[] = []

for (const ft of VENDORED_FILETYPES) {
  const s = SOURCES[ft]!
  const dir = join(outDir, ft)
  await mkdir(dir, { recursive: true })

  const wasm =
    typeof s.wasm === 'string'
      ? new Uint8Array(await get(s.wasm))
      : await buildFromNpm(s.wasm.npm)
  await Bun.write(join(dir, 'parser.wasm'), wasm)

  // One file per language: the runtime hands over a single path, and the `;`
  // headers keep every chunk's origin attached to the text it produced.
  let scm = ''
  for (const q of s.queries) {
    const text = q.startsWith('npm:')
      ? (npmQueries.get((s.wasm as { npm: string }).npm)?.get(q) ??
        (() => {
          throw new Error(`${ft}: ${q} not found in the npm tarball`)
        })())
      : new TextDecoder().decode(await get(q))
    scm += `; ---- source: ${q.startsWith('npm:') ? `${(s.wasm as { npm: string }).npm}/${q.slice(4)}` : q}\n${text.trimEnd()}\n\n`
  }
  await Bun.write(join(dir, 'highlights.scm'), scm)

  const kb = (wasm.byteLength / 1024).toFixed(0)
  rows.push(`| \`${ft}\` | ${s.grammar} | ${s.license} | ${kb} KB |`)
  console.log(`${ft.padEnd(5)} ${kb.padStart(4)} KB  ${s.grammar}`)
}

await Bun.write(
  join(outDir, 'README.md'),
  `# Vendored tree-sitter parsers

Regenerate with \`bun run scripts/fetch-parsers.ts\`; see that file for why these
are committed and where each piece comes from.

| filetype | grammar | license | wasm |
| --- | --- | --- | --- |
${rows.join('\n')}

Highlight queries come from
[nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)
(Apache-2.0) except HTML's and SCSS's own, which ship with their grammars (MIT).
Each \`highlights.scm\` records its sources in \`;\` headers.
`,
)

console.log(`\nWrote assets/${PARSER_DIR_NAME}/ — ${VENDORED_FILETYPES.length} parsers`)
