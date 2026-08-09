/**
 * The vendored-parser contract.
 *
 * Highlighting is best-effort by design — `highlightDiff` never throws, and a
 * parser that fails to load just leaves the row in flat diff colors. That makes
 * every failure here silent, which is exactly why the wiring gets a test: an
 * extension mapped to a filetype nobody ships, a filetype whose assets never got
 * committed, or a `bun run build` that leaves them out of the sidecar all look
 * identical from the outside — like a file that simply isn't colored.
 *
 * Parsing itself is not tested here: it needs the tree-sitter worker, and what
 * breaks in practice is the plumbing around it, not tree-sitter.
 */

import { expect, test, describe } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { filetypeFor, PARSER_DIR_NAME, VENDORED_FILETYPES } from '../src/syntax.ts'

const repoRoot = join(import.meta.dir, '..')
const parserDir = join(repoRoot, 'assets', PARSER_DIR_NAME)

/** Parsers @opentui/core brings; the vendored ones are additional. */
const BUNDLED = ['typescript', 'javascript', 'markdown', 'zig']

/** Every extension we claim to highlight, with the filetype it should resolve to. */
const EXPECTED: Record<string, string> = {
  'a.ts': 'typescript',
  'a.mts': 'typescript',
  'a.cts': 'typescript',
  'a.tsx': 'typescript',
  'a.js': 'javascript',
  'a.mjs': 'javascript',
  'a.cjs': 'javascript',
  'a.jsx': 'javascript',
  'a.md': 'markdown',
  'a.markdown': 'markdown',
  'a.zig': 'zig',
  'a.json': 'json',
  'a.toml': 'toml',
  'a.css': 'css',
  'a.scss': 'scss',
  'a.html': 'html',
  'a.htm': 'html',
  'a.xml': 'xml',
  'a.svg': 'xml',
}

describe('filetype mapping', () => {
  for (const [path, filetype] of Object.entries(EXPECTED)) {
    test(`${path} → ${filetype}`, () => {
      expect(filetypeFor(path)).toBe(filetype)
    })
  }

  test('every filetype is one somebody actually ships', () => {
    const known = new Set([...BUNDLED, ...VENDORED_FILETYPES])
    for (const filetype of Object.values(EXPECTED)) expect(known).toContain(filetype)
  })

  test('every vendored parser is reachable from some extension', () => {
    const mapped = new Set(Object.values(EXPECTED))
    for (const filetype of VENDORED_FILETYPES) expect(mapped).toContain(filetype)
  })

  test('an unknown extension highlights nothing rather than guessing', () => {
    expect(filetypeFor('a.rs')).toBeNull()
    expect(filetypeFor('Makefile')).toBeNull()
    // A dotfile is a name, not an extension: `.gitignore` must not read as "gitignore".
    expect(filetypeFor('.gitignore')).toBeNull()
    // Case is the file's business, not the map's.
    expect(filetypeFor('A.JSON')).toBe('json')
    // Paths, not just basenames — a dot in a directory name means nothing.
    expect(filetypeFor('src/a.b/c.toml')).toBe('toml')
  })
})

describe('vendored assets', () => {
  for (const filetype of VENDORED_FILETYPES) {
    test(`${filetype} ships a parser and a query`, async () => {
      const wasm = join(parserDir, filetype, 'parser.wasm')
      const scm = join(parserDir, filetype, 'highlights.scm')
      expect(existsSync(wasm)).toBe(true)
      expect(existsSync(scm)).toBe(true)
      // Empty files load without error and highlight nothing — the silent
      // failure this whole file exists to catch.
      expect((await Bun.file(wasm).stat()).size).toBeGreaterThan(1024)
      expect((await Bun.file(scm).text()).trim().length).toBeGreaterThan(0)
    })
  }

  test('the build script copies them next to the binary', async () => {
    // Not a guess at the build's output: the sidecar path is what
    // `parserRoot()` looks for first, so the two have to name it the same way.
    const build = await Bun.file(join(repoRoot, 'scripts/build.ts')).text()
    expect(build).toContain('PARSER_DIR_NAME')
  })
})
