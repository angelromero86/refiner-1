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
 * Parsers bundled with @opentui/core. Anything outside this list simply doesn't
 * get highlighted — OpenTUI can fetch more parsers, but that means a network
 * round trip, which a git TUI has no business doing on its own.
 */
const FILETYPES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  zig: 'zig',
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

let initialized: Promise<boolean> | null = null

/** Initialize the shared client once; false when highlighting is unavailable. */
async function ensureClient(): Promise<boolean> {
  initialized ??= (async () => {
    try {
      await getTreeSitterClient().initialize()
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
    runsFor(newDoc.text, filetype, newDoc.firstLine),
    // An all-additions file has no old side worth parsing.
    oldDoc.text === '' ? Promise.resolve(new Map<number, Run[]>()) : runsFor(oldDoc.text, filetype, oldDoc.firstLine),
  ])
  return { new: newRuns, old: oldRuns }
}

/**
 * documentFor reassembles one side of the diff into source text. `firstLine` is
 * the line number the first row carries, so runs can be keyed by the file's own
 * numbering even when the diff doesn't start at line 1.
 */
function documentFor(lines: Line[], side: 'old' | 'new'): { text: string; firstLine: number } {
  const skip = side === 'new' ? LineKind.Del : LineKind.Add
  const out: string[] = []
  let firstLine = 0
  for (const l of lines) {
    if (l.kind === skip) continue
    if (l.kind !== LineKind.Ctx && l.kind !== LineKind.Add && l.kind !== LineKind.Del) continue
    if (firstLine === 0) firstLine = side === 'new' ? l.newNum : l.oldNum
    // Strip the diff marker (the parser must see source, not a diff) and expand
    // tabs exactly as the renderer does. Without that, every column past a tab
    // would be offset and the runs would paint the wrong characters.
    out.push(expandTabs(l.text.slice(1)))
  }
  return { text: out.join('\n'), firstLine: firstLine === 0 ? 1 : firstLine }
}

/**
 * runsFor highlights `text` and converts tree-sitter's flat character offsets into
 * per-line column runs.
 *
 * Overlapping captures are expected — tree-sitter emits general groups before
 * specific ones for the same span (`variable`, then `type`, then `constant`). We
 * paint them in order into a per-column array so the most specific one wins, then
 * collapse equal neighbours back into runs.
 */
async function runsFor(text: string, filetype: string, firstLine: number): Promise<LineRuns> {
  const result = await getTreeSitterClient()
    .highlightOnce(text, filetype)
    .catch(() => ({ highlights: undefined }) as { highlights?: [number, number, string][] })
  const highlights = result.highlights
  if (!highlights || highlights.length === 0) return new Map()

  // Line boundaries as character offsets, so an offset can be mapped to (line, col).
  const lineStart: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStart.push(i + 1)
  }
  const lineEnd = (i: number) => (i + 1 < lineStart.length ? lineStart[i + 1] - 1 : text.length)

  // Per-line column → winning group, allocated lazily so untouched lines cost nothing.
  const painted = new Map<number, (string | undefined)[]>()

  for (const h of highlights) {
    const [start, end, group] = h
    if (end <= start) continue
    let li = lineIndexOf(lineStart, start)
    // A capture can span lines (block comments, template literals): clip per line.
    while (li < lineStart.length && lineStart[li] < end) {
      const from = Math.max(start, lineStart[li])
      const to = Math.min(end, lineEnd(li))
      if (to > from) {
        let cols = painted.get(li)
        if (!cols) {
          cols = new Array<string | undefined>(lineEnd(li) - lineStart[li])
          painted.set(li, cols)
        }
        for (let c = from - lineStart[li]; c < to - lineStart[li]; c++) cols[c] = group
      }
      li++
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
