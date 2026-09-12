/**
 * Syntax colors for the fenced blocks inside review comments.
 *
 * `src/markdown.ts` renders synchronously and takes its highlighter as a plain
 * function, while tree-sitter (`src/syntax.ts`) is asynchronous. This module is
 * the bridge: `highlightBlock` answers from a cache and, on a miss, starts the
 * parse and answers null — the block paints plain for one frame, the parse
 * lands, the listener installed by the view bumps `App.threadsEpoch` and
 * redraws, and the next call finds the runs.
 *
 * What is cached is the RUNS (string indices + capture group), never chunks:
 * the colors are resolved through the live `S` at every call, so a theme swap
 * needs nothing but a redraw, like everywhere else.
 *
 * Nothing is parsed until a listener exists. The cache is only useful to
 * whoever re-renders when it fills, so a render path that never installed one —
 * a test, a headless layout — gets plain blocks and spawns no parser worker.
 */

import type { TextChunk } from '@opentui/core'
import { chunk, S, syntaxColor } from './styles.ts'
import { filetypeFor, highlightSource, type LineRuns } from './syntax.ts'

/**
 * Fence tags agents actually write → the parser that reads them. Anything else
 * goes through `filetypeFor('x.' + tag)`, so a tag that happens to be a known
 * extension (`json`, `css`) still works without a row here.
 */
const FENCE_LANGS: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  zig: 'zig',
}

/** Parser name for a fence tag, or null when no grammar reads it. */
export function fenceFiletype(lang: string): string | null {
  const tag = lang.trim().toLowerCase()
  if (tag === '') return null
  return FENCE_LANGS[tag] ?? filetypeFor('x.' + tag)
}

/** Bound on cached blocks; the cache is cleared wholesale past it. */
const MAX_CACHED = 256

/** `filetype\0code` → runs, or null for a parse that produced nothing. */
const cache = new Map<string, LineRuns | null>()
const inFlight = new Set<string>()
let onReady: (() => void) | null = null

/**
 * installCodeblockHighlighter arms the async half: `notify` runs after every
 * parse that lands, and is expected to redraw. Until this is called,
 * `highlightBlock` never starts a parse.
 */
export function installCodeblockHighlighter(notify: () => void): void {
  onReady = notify
}

/** Forget every cached block. For tests. */
export function resetCodeblocks(): void {
  cache.clear()
  inFlight.clear()
  onReady = null
}

/**
 * highlightBlock is the `MarkdownOptions.highlight` hook: cached rows for this
 * snippet, or null (plain) while the parse is pending or impossible.
 */
export function highlightBlock(code: string, lang: string): TextChunk[][] | null {
  const filetype = fenceFiletype(lang)
  if (!filetype) return null
  const key = filetype + '\0' + code
  const hit = cache.get(key)
  if (hit === null) return null
  if (hit !== undefined) return toRows(code, hit)

  if (onReady !== null && !inFlight.has(key)) {
    inFlight.add(key)
    void highlightSource(code, filetype).then(
      (runs) => {
        inFlight.delete(key)
        if (cache.size >= MAX_CACHED) cache.clear()
        cache.set(key, runs.size > 0 ? runs : null)
        onReady?.()
      },
      () => {
        inFlight.delete(key)
        cache.set(key, null)
      },
    )
  }
  return null
}

/**
 * toRows slices each line of the snippet along its runs. Only the foreground is
 * set — `renderFence` paints the block background over every chunk — and a span
 * with no color of its own takes the block's text color rather than nothing, so
 * it does not fall back to the terminal's default.
 */
function toRows(code: string, runs: LineRuns): TextChunk[][] {
  const base = S.mdCodeBlock
  return code.split('\n').map((text, i) => {
    const lineRuns = runs.get(i + 1)
    if (!lineRuns || lineRuns.length === 0) return [chunk(text, base)]
    const out: TextChunk[] = []
    let at = 0
    for (const run of lineRuns) {
      const start = Math.max(run.start, at)
      const end = Math.min(run.end, text.length)
      if (end <= start) continue
      if (start > at) out.push(chunk(text.slice(at, start), base))
      const fg = syntaxColor(run.group)
      out.push(chunk(text.slice(start, end), fg ? { ...base, fg } : base))
      at = end
    }
    if (at < text.length) out.push(chunk(text.slice(at), base))
    return out.length > 0 ? out : [chunk(text, base)]
  })
}
