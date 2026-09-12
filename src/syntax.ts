/**
 * Syntax highlighting for diff content, via OpenTUI's tree-sitter client.
 *
 * The diff is highlighted as two whole documents rather than line by line: the
 * post-change file (context + additions) and the pre-change file (context +
 * deletions). Tree-sitter needs full-file context to parse at all, and doing it
 * per row would produce garbage on anything that spans lines — a template
 * literal, a block comment, a multi-line call.
 *
 * Each row then looks up its own runs by line number: additions and context from
 * the new document, deletions from the old one. That is also why highlighting
 * survives partial staging — the documents are rebuilt from the same parsed diff
 * the renderer is showing.
 *
 * Highlighting is best-effort. Unknown filetypes, a missing parser or a
 * tree-sitter failure all degrade to "no runs", and the row renders in its plain
 * diff colors.
 *
 * Embedded languages (an Angular `template:` string, a lit-html tag) get a second
 * pass over the same document — see `findInjections`.
 */

import { getTreeSitterClient } from '@opentui/core'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LineKind, type Line } from './diff.ts'
import { expandTabs } from './text.ts'

/** A run of columns on one line sharing a capture group. [start, end) */
export interface Run {
  start: number
  end: number
  group: string
}

/**
 * Captures that say something about the text rather than how to color it.
 *
 * nvim-treesitter's queries — which is where these come from — carry editor
 * features we don't implement: `spell`/`nospell` mark regions for the spell
 * checker, `conceal` marks delimiters an editor would hide, `none` explicitly
 * asks for no highlight. They are emitted AFTER the visual capture covering the
 * same span, and the painter lets the last one win, so leaving them in meant a
 * markdown code span was captured as `markup.raw` and then immediately buried
 * under `nospell` — a group no theme maps, so it rendered as plain text. This is
 * most of why markdown looked unhighlighted.
 */
const NON_VISUAL_GROUPS = new Set(['spell', 'nospell', 'conceal', 'none'])

/** 1-based line number → the runs on that line, left to right, non-overlapping. */
export type LineRuns = Map<number, Run[]>

export interface DiffHighlights {
  /** Keyed by newNum — additions and context. */
  new: LineRuns
  /** Keyed by oldNum — deletions and context. */
  old: LineRuns
}

export const NO_HIGHLIGHTS: DiffHighlights = { new: new Map(), old: new Map() }

/**
 * Grammars we ship ourselves, under `assets/parsers/<filetype>/`.
 *
 * @opentui/core bundles four (typescript, javascript, markdown, zig) and no
 * more. The rest are vendored — see `scripts/fetch-parsers.ts` for where each
 * one comes from — and registered at startup with `addFiletypeParser`, which
 * takes local paths, so nothing is fetched at runtime.
 *
 * Adding one is: put it in `SOURCES` there, add the name here, and map its
 * extensions in `FILETYPES`. `test/syntax.test.ts` fails if the three disagree.
 */
export const VENDORED_FILETYPES = ['json', 'toml', 'css', 'scss', 'html', 'xml'] as const

/** Directory holding them, under `assets/` in the repo and in the sidecar. */
export const PARSER_DIR_NAME = 'parsers'

/**
 * Extension → parser. Anything unlisted renders in flat diff colors, which is
 * also what happens when a parser fails to load: highlighting is best-effort.
 */
const FILETYPES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  // No `tsx` grammar is bundled, and the plain TypeScript one is error-tolerant
  // enough to still color most of a component. JSX regions come out worse than
  // the rest; that is the trade, not a bug to chase.
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  zig: 'zig',

  json: 'json',
  toml: 'toml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  // An SVG is XML, and reviewing one is mostly reading its attributes.
  svg: 'xml',
}

/** filetypeFor maps a path to a bundled parser name, or null if unsupported. */
export function filetypeFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  return FILETYPES[base.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * OpenTUI resolves the tree-sitter WASM runtime and its parser assets relative to
 * its OWN module URL. Under Bun that URL is inside the global install cache, where
 * the `web-tree-sitter` peer dependency isn't reachable, and initialization fails
 * with "Cannot find module 'web-tree-sitter/tree-sitter.wasm'".
 *
 * Asset keys are plain package-relative paths ("web-tree-sitter/tree-sitter.wasm",
 * "@opentui/core/parser.worker.js"), so pointing OTUI_ASSET_ROOT at our own
 * node_modules makes all of them resolve. We locate that directory by resolving the
 * WASM from here, where the dependency IS reachable.
 *
 * A compiled single-file binary embeds these assets and needs none of this, so the
 * whole thing is skipped when the path can't be resolved. An explicit
 * OTUI_ASSET_ROOT from the environment always wins.
 */
export function configureAssetRoot(): void {
  if (process.env['OTUI_ASSET_ROOT']) return
  const root = findAssetRoot()
  if (root) process.env['OTUI_ASSET_ROOT'] = root
}

const WASM_KEY = 'web-tree-sitter/tree-sitter.wasm'

function findAssetRoot(): string | null {
  // A compiled binary can't spawn the parser worker out of Bun's virtual
  // filesystem, so `bun run build` drops the assets it needs next to the
  // executable. Checked first because it's the shipped layout.
  const beside = join(dirname(process.execPath), ASSET_DIR_NAME)
  if (existsSync(join(beside, WASM_KEY))) return beside

  // Running from source: resolve the WASM from here, where the dependency is
  // reachable, and take its node_modules as the root.
  try {
    const resolved = import.meta.resolve(WASM_KEY)
    if (!resolved.startsWith('file://')) return null
    const path = Bun.fileURLToPath(resolved)
    if (!path.endsWith(WASM_KEY) || !existsSync(path)) return null
    return path.slice(0, path.length - WASM_KEY.length - 1)
  } catch {
    return null
  }
}

/** Name of the sidecar directory `bun run build` writes next to the binary. */
export const ASSET_DIR_NAME = 'refiner-assets'

/**
 * Everything the tree-sitter worker needs at runtime, as paths relative to
 * node_modules. Consumed by scripts/build.ts; kept here so the list lives next to
 * the code that depends on it.
 */
export const RUNTIME_ASSETS: readonly string[] = [
  WASM_KEY,
  '@opentui/core/parser.worker.js',
  '@opentui/core/assets',
]

/**
 * Where the vendored parsers live: beside the executable in the shipped layout,
 * otherwise in the checkout we're running from.
 *
 * Resolved from the module's own location, never from the cwd — refiner runs
 * from the user's repo root, so a relative path would look for parsers inside
 * whatever project is being reviewed.
 */
function parserRoot(): string | null {
  const beside = join(dirname(process.execPath), ASSET_DIR_NAME, PARSER_DIR_NAME)
  if (existsSync(beside)) return beside
  // A compiled binary's `import.meta.dir` is inside Bun's virtual filesystem, so
  // this check simply fails there and the sidecar above is the only answer.
  const inRepo = join(import.meta.dir, '..', 'assets', PARSER_DIR_NAME)
  if (existsSync(inRepo)) return inRepo
  return null
}

/**
 * Hand the vendored grammars to the client. Per-language and best-effort: a
 * half-installed sidecar loses the languages it's missing, not all of them.
 */
function registerVendoredParsers(client: ReturnType<typeof getTreeSitterClient>): void {
  const root = parserRoot()
  if (!root) return
  for (const filetype of VENDORED_FILETYPES) {
    const wasm = join(root, filetype, 'parser.wasm')
    const highlights = join(root, filetype, 'highlights.scm')
    if (!existsSync(wasm) || !existsSync(highlights)) continue
    client.addFiletypeParser({ filetype, wasm, queries: { highlights: [highlights] } })
  }
}

let initialized: Promise<boolean> | null = null

/** Initialize the shared client once; false when highlighting is unavailable. */
async function ensureClient(): Promise<boolean> {
  initialized ??= (async () => {
    try {
      const client = getTreeSitterClient()
      await client.initialize()
      registerVendoredParsers(client)
      return true
    } catch {
      return false
    }
  })()
  return initialized
}

/**
 * highlightDiff builds the old and new documents from a parsed diff and returns
 * the per-line runs for each. Never throws.
 */
export async function highlightDiff(path: string, lines: Line[]): Promise<DiffHighlights> {
  const filetype = filetypeFor(path)
  if (!filetype) return NO_HIGHLIGHTS
  if (!(await ensureClient())) return NO_HIGHLIGHTS

  const newDoc = documentFor(lines, 'new')
  const oldDoc = documentFor(lines, 'old')

  const [newRuns, oldRuns] = await Promise.all([
    runsFor(newDoc, filetype),
    // An all-additions file has no old side worth parsing.
    oldDoc.text === '' ? Promise.resolve(new Map<number, Run[]>()) : runsFor(oldDoc, filetype),
  ])
  return { new: newRuns, old: oldRuns }
}

/** One side of the diff, reassembled into something a parser can read. */
interface Document {
  text: string
  /**
   * The line number the first row carries, so runs can be keyed by the file's
   * own numbering even when the diff doesn't start at line 1.
   */
  firstLine: number
  /**
   * 0-based indices of lines that open a new hunk, i.e. where the text jumps
   * over part of the file. Only `findInjections` cares: the two sides of a gap
   * are not adjacent in the real file, so nothing may span one.
   */
  gaps: Set<number>
}

/** documentFor reassembles one side of the diff into source text. */
function documentFor(lines: Line[], side: 'old' | 'new'): Document {
  const skip = side === 'new' ? LineKind.Del : LineKind.Add
  const out: string[] = []
  const gaps = new Set<number>()
  let firstLine = 0
  let expected = 0
  for (const l of lines) {
    if (l.kind === skip) continue
    if (l.kind !== LineKind.Ctx && l.kind !== LineKind.Add && l.kind !== LineKind.Del) continue
    const num = side === 'new' ? l.newNum : l.oldNum
    if (firstLine === 0) firstLine = num
    else if (num !== expected) gaps.add(out.length)
    expected = num + 1
    // Strip the diff marker (the parser must see source, not a diff) and expand
    // tabs exactly as the renderer does. Without that, every column past a tab
    // would be offset and the runs would paint the wrong characters.
    out.push(expandTabs(l.text.slice(1)))
  }
  return { text: out.join('\n'), firstLine: firstLine === 0 ? 1 : firstLine, gaps }
}

/** Flat capture list as the client returns it: [start, end, group, meta?]. */
type Highlights = [number, number, string, unknown?][]

async function highlightOnce(text: string, filetype: string): Promise<Highlights> {
  const result = await getTreeSitterClient()
    .highlightOnce(text, filetype)
    .catch(() => ({ highlights: undefined }) as { highlights?: Highlights })
  return result.highlights ?? []
}

/**
 * runsFor highlights a document and converts tree-sitter's flat character offsets
 * into per-line column runs.
 *
 * Overlapping captures are expected — tree-sitter emits general groups before
 * specific ones for the same span (`variable`, then `type`, then `constant`). We
 * paint them in order into a per-column array so the most specific one wins, then
 * collapse equal neighbours back into runs.
 *
 * Embedded regions are painted last, over a cleared span, so the host's one big
 * `string` capture doesn't show through the grammar that replaced it.
 */
async function runsFor(doc: Document, filetype: string): Promise<LineRuns> {
  const { text, firstLine } = doc

  // Line boundaries as character offsets, so an offset can be mapped to (line, col).
  const lineStart: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStart.push(i + 1)
  }
  const lineEnd = (i: number) => (i + 1 < lineStart.length ? lineStart[i + 1] - 1 : text.length)

  const gapOffsets = [...doc.gaps].map((li) => lineStart[li]!).sort((a, b) => a - b)
  const injections = findInjections(text, filetype, gapOffsets)
  const [highlights, embedded] = await Promise.all([
    highlightOnce(text, filetype),
    Promise.all(injections.map((inj) => highlightOnce(text.slice(inj.start, inj.end), inj.filetype))),
  ])
  if (highlights.length === 0 && embedded.every((e) => e.length === 0)) return new Map()

  // Per-line column → winning group, allocated lazily so untouched lines cost nothing.
  const painted = new Map<number, (string | undefined)[]>()

  /** Paint [start, end) — a capture can span lines (block comments, template literals), so clip per line. */
  const paint = (start: number, end: number, group: string | undefined) => {
    let li = lineIndexOf(lineStart, start)
    while (li < lineStart.length && lineStart[li] < end) {
      const from = Math.max(start, lineStart[li])
      const to = Math.min(end, lineEnd(li))
      if (to > from) {
        let cols = painted.get(li)
        if (!cols && group !== undefined) {
          cols = new Array<string | undefined>(lineEnd(li) - lineStart[li])
          painted.set(li, cols)
        }
        if (cols) for (let c = from - lineStart[li]; c < to - lineStart[li]; c++) cols[c] = group
      }
      li++
    }
  }

  /** Same, but leaving the `${…}` substitutions in the host's colors. */
  const paintAround = (holes: Span[], start: number, end: number, group: string | undefined) => {
    let from = start
    for (const [hs, he] of holes) {
      if (he <= from) continue
      if (hs >= end) break
      if (hs > from) paint(from, hs, group)
      from = he
    }
    if (from < end) paint(from, end, group)
  }

  for (const [start, end, group] of highlights) {
    if (end <= start || NON_VISUAL_GROUPS.has(group)) continue
    paint(start, end, group)
  }

  for (const [i, inj] of injections.entries()) {
    paintAround(inj.holes, inj.start, inj.end, undefined)
    for (const [start, end, group] of embedded[i]) {
      if (end <= start || NON_VISUAL_GROUPS.has(group)) continue
      paintAround(inj.holes, inj.start + start, inj.start + end, group)
    }
  }

  const out: LineRuns = new Map()
  for (const [li, cols] of painted) {
    const runs: Run[] = []
    let c = 0
    while (c < cols.length) {
      const g = cols[c]
      if (g === undefined) {
        c++
        continue
      }
      let end = c + 1
      while (end < cols.length && cols[end] === g) end++
      runs.push({ start: c, end, group: g })
      c = end
    }
    if (runs.length > 0) out.set(firstLine + li, runs)
  }
  return out
}

/** A `[start, end)` character span. */
type Span = [number, number]

/**
 * A template literal holding another language, as offsets into the host document.
 */
interface Injection {
  /** First character after the opening backtick. */
  start: number
  /** The closing backtick. */
  end: number
  filetype: string
  /**
   * The `${…}` substitutions inside it, ascending and disjoint. They are host
   * code, not embedded code, so they keep the host's highlighting — which is what
   * makes lit-html templates readable, since theirs are full of them.
   */
  holes: Span[]
}

/**
 * Object keys whose template-literal value is another language. This is Angular:
 * `@Component({ template: `…` })` is HTML and `styles: [`…`]` is CSS, and both are
 * extremely common in a TS file under review.
 */
const KEYED_INJECTIONS: Record<string, string> = { template: 'html', styles: 'css' }

/** Template tags: lit-html and friends write `html`…`` / `css`…``. */
const TAGGED_INJECTIONS: Record<string, string> = { html: 'html', css: 'css' }

/** Host grammars whose template literals are worth scanning at all. */
const INJECTION_HOSTS = new Set(['typescript', 'javascript'])

/** Characters after which a pending `template:` / `css`` no longer applies. */
const DISARM = new Set([';', '}', ')', ']'])

/** Most files have none; a component has one or two. The cap is a runaway guard. */
const MAX_INJECTIONS = 16

/**
 * findInjections locates embedded-language template literals in a host document.
 *
 * OpenTUI's tree-sitter client can do injections, but it picks the injected
 * language off the captured NODE TYPE, and Angular's HTML and CSS are both a
 * plain `template_string` — one mapping can't tell them apart. So the scan lives
 * here, over the text, and stays deliberately shallow: it tracks comments,
 * strings and `${…}` nesting only well enough to find where a literal ends.
 *
 * Two rules keep a wrong guess cheap. A literal is only claimed when the token
 * before it says so (`template:`, `styles:`, an `html` tag), so an unrecognized
 * backtick — a regex literal holding one, say, which this scanner does not model
 * — costs at most a missed injection. And a literal must be TERMINATED inside one
 * hunk: the document is diff context, not the file, so an unclosed template would
 * otherwise swallow unrelated code from the next hunk and paint it as markup.
 */
export function findInjections(text: string, filetype: string, gapOffsets: readonly number[] = []): Injection[] {
  if (!INJECTION_HOSTS.has(filetype)) return []
  const out: Injection[] = []
  let armed: string | null = null
  let i = 0
  while (i < text.length && out.length < MAX_INJECTIONS) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close < 0 ? text.length : close + 2
      continue
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(text, i)
      continue
    }
    if (c === '`') {
      const lit = scanTemplate(text, i)
      if (armed && lit.terminated && lit.end > i + 1 && !spansGap(gapOffsets, i, lit.end)) {
        out.push({ start: i + 1, end: lit.end, filetype: armed, holes: lit.holes })
      }
      i = lit.next
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < text.length && isIdentPart(text[j]!)) j++
      const word = text.slice(i, j)
      let k = j
      while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++
      // An identifier always settles the question: it either arms its own
      // language or replaces whatever was armed before it.
      armed = text[k] === ':' ? (KEYED_INJECTIONS[word] ?? null) : text[k] === '`' ? (TAGGED_INJECTIONS[word] ?? null) : null
      i = j
      continue
    }
    if (DISARM.has(c)) armed = null
    i++
  }
  return out
}

/** True when [start, end] crosses a hunk boundary, where the file is not contiguous. */
function spansGap(gapOffsets: readonly number[], start: number, end: number): boolean {
  return gapOffsets.some((o) => o > start && o <= end)
}

const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$'
const isIdentPart = (c: string) => isIdentStart(c) || (c >= '0' && c <= '9')

/** Index just past a '…' / "…" string starting at `i`. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i]
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') j += 2
    else if (c === quote || c === '\n') return j + 1
    else j++
  }
  return text.length
}

/** Scan a template literal opening at `i`, recording its `${…}` substitutions. */
function scanTemplate(text: string, i: number): { end: number; next: number; holes: Span[]; terminated: boolean } {
  const holes: Span[] = []
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') return { end: j, next: j + 1, holes, terminated: true }
    if (c === '$' && text[j + 1] === '{') {
      const close = skipBraces(text, j + 1)
      holes.push([j, Math.min(close + 1, text.length)])
      j = close + 1
      continue
    }
    j++
  }
  return { end: text.length, next: text.length, holes, terminated: false }
}

/** Index of the '}' matching the '{' at `i`, or the end of the text. */
function skipBraces(text: string, i: number): number {
  let depth = 0
  let j = i
  while (j < text.length) {
    const c = text[j]!
    if (c === '{') depth++
    else if (c === '}') {
      if (--depth === 0) return j
    } else if (c === '"' || c === "'") {
      j = skipQuoted(text, j)
      continue
    } else if (c === '`') {
      j = scanTemplate(text, j).next
      continue
    } else if (c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
      const close = text[j + 1] === '/' ? text.indexOf('\n', j) : text.indexOf('*/', j + 2)
      j = close < 0 ? text.length : text[j + 1] === '/' ? close : close + 2
      continue
    }
    j++
  }
  return text.length
}

/** Binary search for the line containing a character offset. */
function lineIndexOf(lineStart: number[], offset: number): number {
  let lo = 0
  let hi = lineStart.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStart[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * highlightSource highlights a standalone snippet — a fenced block inside a
 * review comment — as a one-document parse, returning runs keyed by 1-based
 * line. Same pipeline as the diff, minus the hunk bookkeeping: a snippet has
 * no gaps. Never throws; an unavailable client yields no runs.
 */
export async function highlightSource(text: string, filetype: string): Promise<LineRuns> {
  if (!(await ensureClient())) return new Map()
  return runsFor({ text, firstLine: 1, gaps: new Set() }, filetype)
}
