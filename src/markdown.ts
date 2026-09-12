/**
 * Markdown for review-comment bodies, rendered straight to styled rows.
 *
 * The bodies come from agents following `skills/refine-review/SKILL.md`: a
 * severity tag up front, paragraphs split by blank lines, inline code, fenced
 * blocks, bullet lists, blockquotes, the odd heading or rule. That is the whole
 * dialect this module speaks — it is a renderer for that vocabulary, not a
 * CommonMark implementation, and the simplifications are deliberate (see the
 * notes on each block kind below).
 *
 * Two invariants matter to the pane that draws the result:
 *
 * - Every row is EXACTLY `width` columns, measured with `Bun.stringWidth` and
 *   pre-padded. The widgets run with `wrapMode: 'none'`, so a row one column
 *   off would shift every row under it instead of failing locally.
 * - Styles are read off the live `S` at render time, never captured, so a theme
 *   swap only needs a redraw.
 *
 * Everything here is pure and synchronous. Syntax highlighting of fenced blocks
 * is an optional hook (`MarkdownOptions.highlight`) precisely because the real
 * highlighter is async; whoever wires it decides how to bridge that.
 */

import type { TextChunk } from '@opentui/core'
import { chunk, S, type Style } from './styles.ts'
import { expandTabs, width } from './text.ts'

export interface MarkdownOptions {
  /** Exact column width of every emitted row. */
  width: number
  /**
   * Optional highlighter for fenced blocks. Gets the block's text (tabs already
   * expanded) and its language tag; returns one chunk row per code line, or
   * null to fall back to plain `mdCodeBlock`. Rows may come back any width —
   * they are cut and padded here, and the block background is painted over
   * whatever background they carry.
   */
  highlight?: (code: string, lang: string) => TextChunk[][] | null
}

export type Severity = 'must-fix' | 'suggestion' | 'question' | 'nit'

const SEVERITY_RE = /^\s*\[(must-fix|suggestion|question|nit)\]\s*/i

/**
 * severityOf splits the leading `[tag]` off a body. `rest` is the body with the
 * tag and the whitespace after it removed. Null when the body doesn't open with
 * one of the four tags — a tag anywhere else is just text.
 */
export function severityOf(body: string): { tag: Severity; rest: string } | null {
  const m = SEVERITY_RE.exec(body)
  if (!m) return null
  return { tag: m[1]!.toLowerCase() as Severity, rest: body.slice(m[0].length) }
}

// ───────────────────────────── inline ─────────────────────────────

type InlineKind = 'text' | 'bold' | 'code' | 'link' | Severity

/**
 * One styled run of a paragraph before wrapping. `atomic` runs (code spans, the
 * severity badge) never break at their inner spaces: a code span's background
 * reads as one token, and a badge split over two rows is not a badge.
 */
interface Piece {
  text: string
  kind: InlineKind
  atomic?: boolean
}

const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}

/** Whether `_` at `i` can open/close emphasis: it must sit at a word edge. */
function atWordEdge(s: string, i: number, side: 'open' | 'close'): boolean {
  const ch = side === 'open' ? s[i - 1] : s[i + 1]
  return ch === undefined || /[\s\p{P}]/u.test(ch)
}

/**
 * parseInline turns one paragraph's text into pieces. Markers that never find
 * their partner stay literal — an agent writing `a * b` or `snake_case` should
 * not see characters vanish.
 */
export function parseInline(text: string): Piece[] {
  const out: Piece[] = []
  let buf = ''
  const flush = () => {
    if (buf !== '') out.push({ text: buf, kind: 'text' })
    buf = ''
  }
  const push = (p: Piece) => {
    flush()
    out.push(p)
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    // Backslash escapes on ASCII punctuation.
    if (ch === '\\' && i + 1 < text.length && PUNCT.includes(text[i + 1]!)) {
      buf += text[i + 1]
      i += 2
      continue
    }

    // Code span: a run of N backticks closed by the next run of exactly N.
    if (ch === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const close = findBacktickRun(text, i + n, n)
      if (close >= 0) {
        let code = text.slice(i + n, close)
        // CommonMark strips one space on each side when both are present.
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        push({ text: code, kind: 'code', atomic: true })
        i = close + n
        continue
      }
      buf += text.slice(i, i + n)
      i += n
      continue
    }

    // Strong: `**x**` or `__x__`. Like single `_`, the double form needs word
    // edges so `foo__bar__baz` stays what the author typed.
    if ((ch === '*' || ch === '_') && text[i + 1] === ch && !isSpace(text[i + 2])) {
      const marker = ch + ch
      const close = ch === '*' || atWordEdge(text, i, 'open') ? findClosing(text, i + 2, marker) : -1
      if (close >= 0) {
        flush()
        for (const p of parseInline(text.slice(i + 2, close))) {
          out.push(p.kind === 'text' ? { ...p, kind: 'bold' } : p)
        }
        i = close + 2
        continue
      }
    }

    // Emphasis: `*x*` / `_x_`. No italic attribute to paint, so the markers are
    // simply dropped. `_` additionally needs a word edge so identifiers survive.
    if ((ch === '*' || ch === '_') && !isSpace(text[i + 1]) && text[i + 1] !== ch) {
      if (ch === '*' || atWordEdge(text, i, 'open')) {
        const close = findEmphasisClose(text, i + 1, ch)
        if (close >= 0) {
          flush()
          out.push(...parseInline(text.slice(i + 1, close)))
          i = close + 1
          continue
        }
      }
    }

    // Link: `[text](url)`. The URL is dropped unless the text is empty.
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i))
      if (m) {
        const label = m[1]!.trim() !== '' ? m[1]! : m[2]!
        if (label !== '') push({ text: label, kind: 'link' })
        i += m[0].length
        continue
      }
    }

    buf += ch
    i++
  }
  flush()
  return out
}

/** Index of the next backtick run of exactly `n`, or -1. */
function findBacktickRun(s: string, from: number, n: number): number {
  let i = from
  while (i < s.length) {
    if (s[i] !== '`') {
      i++
      continue
    }
    let k = 0
    while (s[i + k] === '`') k++
    if (k === n) return i
    i += k
  }
  return -1
}

/** Index of `marker` at or after `from`, skipping over code spans. */
function findClosing(s: string, from: number, marker: string): number {
  let i = from
  while (i < s.length) {
    if (s[i] === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const close = findBacktickRun(s, i + n, n)
      if (close >= 0) {
        i = close + n
        continue
      }
    }
    if (s.startsWith(marker, i) && i > from && !isSpace(s[i - 1])) {
      if (marker[0] === '*' || atWordEdge(s, i + marker.length - 1, 'close')) return i
    }
    i++
  }
  return -1
}

/** Closing single `*`/`_` for emphasis: preceded by a non-space, not doubled. */
function findEmphasisClose(s: string, from: number, ch: string): number {
  let i = from
  while (i < s.length) {
    if (s[i] === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const close = findBacktickRun(s, i + n, n)
      if (close >= 0) {
        i = close + n
        continue
      }
    }
    if (s[i] === ch && s[i + 1] !== ch && i > from && !isSpace(s[i - 1])) {
      if (ch === '*' || atWordEdge(s, i, 'close')) return i
    }
    i++
  }
  return -1
}

/** Plain text of a piece list — markers gone, styles forgotten. */
function plainText(pieces: Piece[]): string {
  return pieces.map((p) => p.text).join('')
}

// ───────────────────────────── blocks ─────────────────────────────

interface ListItem {
  ordered: boolean
  /** The marker as written (`1.`, `3)`) for ordered items. */
  marker: string
  /** 0 or 1 — deeper source indentation is clamped to one level. */
  level: number
  pieces: Piece[]
}

type Block =
  | { kind: 'paragraph'; pieces: Piece[] }
  | { kind: 'heading'; pieces: Piece[] }
  | { kind: 'quote'; paragraphs: Piece[][] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'fence'; lang: string; lines: string[] }
  | { kind: 'rule' }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_RE = /^ {0,3}>\s?(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const EMPTY_LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** Whether `line` opens a block that interrupts a paragraph or list item. */
function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  )
}

/**
 * parseBlocks is a line-oriented pass. Tabs are expanded first so nothing
 * downstream (indent detection, the highlight hook, width math) ever sees one.
 *
 * Deliberate simplifications against CommonMark: a blockquote is exactly the
 * `>`-prefixed lines (no lazy continuation), nested blocks inside quotes and list
 * items are flattened to text, indented code blocks (four spaces) are not a
 * thing — agents write fences — and a blank line always ends a list.
 */
export function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map(expandTabs)
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const open = fence[1]!
      const code: string[] = []
      let closed = false
      i++
      for (; i < lines.length; i++) {
        const l = lines[i]!
        const t = l.trim()
        // Closes on a run of the same fence character at least as long as the
        // opener, alone on its line. An unterminated fence runs to the end.
        if (t[0] === open[0] && /^(`+|~+)$/.test(t) && t.length >= open.length) {
          closed = true
          i++
          break
        }
        code.push(l)
      }
      // A closed fence keeps its trailing blank lines — they were put there.
      // An unclosed one is usually a body that ran out, and the blank lines at
      // its end are the body's, not the snippet's.
      if (!closed) while (code.length > 0 && isBlank(code[code.length - 1]!)) code.pop()
      blocks.push({ kind: 'fence', lang: fence[2] ?? '', lines: code })
      continue
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', pieces: parseInline(heading[2] ?? '') })
      i++
      continue
    }

    if (QUOTE_RE.test(line)) {
      const paragraphs: Piece[][] = []
      let cur: string[] = []
      const flush = () => {
        if (cur.length) paragraphs.push(parseInline(cur.join(' ')))
        cur = []
      }
      for (; i < lines.length; i++) {
        const m = QUOTE_RE.exec(lines[i]!)
        if (!m) break
        const inner = m[1]!
        if (isBlank(inner)) flush()
        else cur.push(inner.trim())
      }
      flush()
      blocks.push({ kind: 'quote', paragraphs })
      continue
    }

    if (LIST_RE.test(line) || EMPTY_LIST_RE.test(line)) {
      const items: ListItem[] = []
      for (; i < lines.length; ) {
        const m = LIST_RE.exec(lines[i]!) ?? EMPTY_LIST_RE.exec(lines[i]!)
        if (!m) break
        const indent = m[1]!.length
        const marker = m[2]!
        const text: string[] = [(m[3] ?? '').trim()]
        i++
        // Continuation: following non-blank lines that are not themselves a
        // list item or another block start belong to this item.
        while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
          text.push(lines[i]!.trim())
          i++
        }
        items.push({
          ordered: /\d/.test(marker),
          marker,
          level: indent >= 2 ? 1 : 0,
          pieces: parseInline(text.filter((t) => t !== '').join(' ')),
        })
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    // Paragraph: soft line breaks join with a space so the text reflows to the
    // pane, exactly as a markdown viewer would.
    const text: string[] = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
      text.push(lines[i]!.trim())
      i++
    }
    blocks.push({ kind: 'paragraph', pieces: parseInline(text.join(' ')) })
  }

  return blocks
}

// ───────────────────────────── layout ─────────────────────────────

type Base = 'mdText' | 'mdHeading' | 'mdQuote'

/** Resolve a piece to its live style, under the block's base tone. */
function styleOf(p: Piece, base: Base): Style {
  switch (p.kind) {
    case 'code':
      return S.mdCode
    case 'link':
      return S.mdLink
    case 'bold':
      return base === 'mdText' ? S.mdBold : { ...S[base], bold: true }
    case 'must-fix':
      return S.sevMustFix
    case 'suggestion':
      return S.sevSuggestion
    case 'question':
      return S.sevQuestion
    case 'nit':
      return S.sevNit
    default:
      return S[base]
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function chunksWidth(chunks: TextChunk[]): number {
  let n = 0
  for (const c of chunks) n += width(c.text)
  return n
}

/**
 * hardCut splits a chunk row into rows of at most `w` columns, breaking between
 * graphemes regardless of words. Each row makes progress by at least one
 * grapheme even when that grapheme is wider than `w`, so it terminates; such a
 * row is over-wide and the final `fit` clips it.
 */
function hardCut(chunks: TextChunk[], w: number): TextChunk[][] {
  const rows: TextChunk[][] = []
  let row: TextChunk[] = []
  let acc = 0
  for (const c of chunks) {
    let buf = ''
    for (const { segment } of segmenter.segment(c.text)) {
      const cw = width(segment)
      if (acc + cw > w && (acc > 0 || buf !== '')) {
        if (buf !== '') row.push({ ...c, text: buf })
        rows.push(row)
        row = []
        acc = 0
        buf = ''
      }
      buf += segment
      acc += cw
    }
    if (buf !== '') row.push({ ...c, text: buf })
  }
  if (row.length > 0 || rows.length === 0) rows.push(row)
  return rows
}

/** Force a row to exactly `w` columns: clip, then pad with `padStyle`. */
function fit(chunks: TextChunk[], w: number, padStyle?: Style): TextChunk[] {
  const out: TextChunk[] = []
  let acc = 0
  for (const c of chunks) {
    if (c.text === '') continue
    const cw = width(c.text)
    if (acc + cw <= w) {
      out.push(c)
      acc += cw
      continue
    }
    let head = ''
    for (const { segment } of segmenter.segment(c.text)) {
      if (acc + width(segment) > w) break
      head += segment
      acc += width(segment)
    }
    if (head !== '') out.push({ ...c, text: head })
    break
  }
  if (acc < w) out.push(chunk(' '.repeat(w - acc), padStyle))
  return out
}

/**
 * wrapPieces lays styled pieces out as rows of at most `avail` columns, greedy
 * at spaces. A "word" is a run of non-space text across piece boundaries, so
 * `` `foo`'s `` stays together; atomic pieces are words whole. Words wider than
 * `avail` are hard-cut.
 */
function wrapPieces(pieces: Piece[], base: Base, avail: number): TextChunk[][] {
  avail = Math.max(1, avail)
  const words: TextChunk[][] = []
  let word: TextChunk[] = []
  const endWord = () => {
    if (word.length) words.push(word)
    word = []
  }
  for (const p of pieces) {
    const style = styleOf(p, base)
    if (p.atomic) {
      word.push(chunk(p.text, style))
      continue
    }
    for (const part of p.text.split(/(\s+)/)) {
      if (part === '') continue
      if (/^\s+$/.test(part)) endWord()
      else word.push(chunk(part, style))
    }
  }
  endWord()

  const rows: TextChunk[][] = []
  let line: TextChunk[] = []
  let lineW = 0
  const flush = () => {
    rows.push(line)
    line = []
    lineW = 0
  }
  for (const w of words) {
    const ww = chunksWidth(w)
    if (ww > avail) {
      if (lineW > 0) flush()
      const cut = hardCut(w, avail)
      for (let k = 0; k < cut.length - 1; k++) rows.push(cut[k]!)
      line = cut[cut.length - 1]!
      lineW = chunksWidth(line)
      continue
    }
    if (lineW === 0) {
      line = w
      lineW = ww
    } else if (lineW + 1 + ww <= avail) {
      line.push(chunk(' ', S[base]), ...w)
      lineW += 1 + ww
    } else {
      flush()
      line = w
      lineW = ww
    }
  }
  if (line.length > 0 || rows.length === 0) rows.push(line)
  return rows
}

/** Rows for one paragraph-like block under a fixed prefix (first row / rest). */
function prefixed(
  pieces: Piece[],
  base: Base,
  w: number,
  first: TextChunk[],
  rest: TextChunk[],
): TextChunk[][] {
  const indent = chunksWidth(first)
  const body = wrapPieces(pieces, base, w - indent)
  return body.map((row, k) => fit([...(k === 0 ? first : rest), ...row], w))
}

const CODE_INDENT = 2

function renderFence(block: { lang: string; lines: string[] }, opts: MarkdownOptions): TextChunk[][] {
  const w = opts.width
  const bg = S.mdCodeBlock
  const indent = chunk(' '.repeat(CODE_INDENT), bg)
  const avail = Math.max(1, w - CODE_INDENT)

  let rows: TextChunk[][] | null = null
  if (opts.highlight && block.lines.length > 0) {
    const hl = opts.highlight(block.lines.join('\n'), block.lang)
    if (hl) {
      // The block background wins over whatever the highlighter painted, so the
      // fenced area reads as one surface.
      rows = hl.map((row) => row.map((c) => ({ ...c, bg: bg.bg })))
    }
  }
  if (!rows) rows = block.lines.map((l) => [chunk(l, bg)])

  const out: TextChunk[][] = []
  for (const row of rows) {
    for (const part of hardCut(row, avail)) out.push(fit([indent, ...part], w, bg))
  }
  // An empty fence still marks its place with one tinted row.
  if (out.length === 0) out.push(fit([indent], w, bg))
  return out
}

function renderList(items: ListItem[], w: number): TextChunk[][] {
  const out: TextChunk[][] = []
  for (const it of items) {
    const pad = '  '.repeat(it.level)
    const marker = it.ordered ? it.marker : '•'
    const first = [chunk(pad + marker + ' ', it.ordered ? S.mdText : S.mdBullet)]
    const rest = [chunk(' '.repeat(pad.length + width(marker) + 1), S.mdText)]
    out.push(...prefixed(it.pieces, 'mdText', w, first, rest))
  }
  return out
}

const QUOTE_BAR = '▎ '

function renderQuote(paragraphs: Piece[][], w: number): TextChunk[][] {
  const bar = [chunk(QUOTE_BAR, S.mdQuote)]
  const out: TextChunk[][] = []
  paragraphs.forEach((p, k) => {
    if (k > 0) out.push(fit([chunk(QUOTE_BAR.trimEnd(), S.mdQuote)], w))
    out.push(...prefixed(p, 'mdQuote', w, bar, bar))
  })
  if (out.length === 0) out.push(fit([chunk(QUOTE_BAR.trimEnd(), S.mdQuote)], w))
  return out
}

function renderBlock(block: Block, opts: MarkdownOptions): TextChunk[][] {
  const w = opts.width
  switch (block.kind) {
    case 'paragraph':
      return prefixed(block.pieces, 'mdText', w, [], [])
    case 'heading':
      return prefixed(block.pieces, 'mdHeading', w, [], [])
    case 'quote':
      return renderQuote(block.paragraphs, w)
    case 'list':
      return renderList(block.items, w)
    case 'fence':
      return renderFence(block, opts)
    case 'rule':
      return [fit([chunk('─'.repeat(w), S.mdRule)], w)]
  }
}

/**
 * renderMarkdown turns a comment body into rows of exactly `opts.width`
 * columns. Blocks are separated by exactly one blank row, with none at either
 * end. An empty body renders to no rows at all.
 */
export function renderMarkdown(body: string, opts: MarkdownOptions): TextChunk[][] {
  const w = Math.max(0, Math.floor(opts.width))
  if (w === 0) return []

  const sev = severityOf(body)
  const blocks = parseBlocks(sev ? sev.rest : body)
  if (sev) {
    const badge: Piece = { text: sev.tag, kind: sev.tag, atomic: true }
    const head = blocks[0]
    if (head && head.kind === 'paragraph') {
      head.pieces = [badge, { text: ' ', kind: 'text' }, ...head.pieces]
    } else {
      blocks.unshift({ kind: 'paragraph', pieces: [badge] })
    }
  }

  const out: TextChunk[][] = []
  for (const block of blocks) {
    const rows = renderBlock(block, { ...opts, width: w })
    if (rows.length === 0) continue
    if (out.length > 0) out.push(fit([], w))
    out.push(...rows)
  }
  return out
}

/**
 * firstLine is the one-line plain-text summary a collapsed card shows: the
 * first block's text with the severity tag and all markup stripped and its
 * whitespace collapsed. A leading fence yields its first code line behind a
 * backtick so a snippet-only comment still says something. Never truncated —
 * the card knows its own width.
 */
export function firstLine(body: string): string {
  const sev = severityOf(body)
  for (const block of parseBlocks(sev ? sev.rest : body)) {
    let text: string
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        text = plainText(block.pieces)
        break
      case 'quote':
        text = block.paragraphs.map(plainText).join(' ')
        break
      case 'list':
        text = block.items.map((it) => plainText(it.pieces)).join(' ')
        break
      case 'fence': {
        const first = block.lines.find((l) => !isBlank(l))
        text = first === undefined ? '' : '`' + first.trim()
        break
      }
      case 'rule':
        text = ''
        break
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return ''
}
