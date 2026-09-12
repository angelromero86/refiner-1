/**
 * A review thread as rows of the diff pane.
 *
 * A card sits in the row stream right under the last line of its range
 * (`src/rows.ts` decides where) and the cursor walks through it row by row like
 * any other row. Three shapes:
 *
 *   collapsed      ┃ @author · must-fix · 12:30 · 2 comments
 *                  ┃ first line of the LAST comment, truncated…
 *   resolved       ┃ ✓ @author · must-fix · first line of the last comment…
 *   expanded       ┃ @author · 12:30 · 2 comments
 *                  ┃ the opener's body as markdown (its badge leads it)
 *                  ┃ ───
 *                  ┃ @replier · 13:05
 *                  ┃ their body …
 *                  ┃                       ← one blank bar row before the code
 *
 * The header names the OPENER (whose finding this is); the preview quotes the
 * LAST comment (what is new). Every row is exactly `width` columns, measured
 * with `Bun.stringWidth` — the pane runs with `wrapMode: 'none'`, so a row one
 * column off would shift everything under it.
 *
 * Cursor and selection are not painted here: the layout caches these rows and
 * `paintCardRow` stamps a background over the one under the cursor per frame,
 * so a cursor move never re-renders markdown.
 */

import type { RGBA, TextChunk } from '@opentui/core'
import type { StoredComment, StoredThread } from './comments.ts'
import { highlightBlock } from './codeblocks.ts'
import { firstLine, renderMarkdown, severityOf, type Severity } from './markdown.ts'
import type { Drift } from './relocate.ts'
import { chunk, S, type Style } from './styles.ts'
import { formatStamp, truncate, width } from './text.ts'

export interface CardOptions {
  /** Exact column width of every row. */
  width: number
  expanded: boolean
  /** Where relocation left the thread, for the header's suffix; null before any pass. */
  drift: Drift | null
  /**
   * Whether a diff row carries the thread's last line. When not — the range
   * is outside the diff's context, or the thread is lost — the header spells
   * the range out, so the reader knows the card is not on its exact line.
   */
  hostExact: boolean
}

/** Left margin, bar, gap: the columns every card row spends before its text. */
const BAR_W = 3
const SEP = ' · '

export function renderCard(t: StoredThread, opts: CardOptions): TextChunk[][] {
  const w = Math.max(BAR_W + 1, Math.floor(opts.width))
  const resolved = t.status === 'resolved'
  const barStyle: Style = resolved ? S.dim : S.marker
  const inner = w - BAR_W
  const row = (content: TextChunk[]): TextChunk[] =>
    fitRow([chunk(' '), chunk('┃', barStyle), chunk(' '), ...content], w)

  const opener = t.comments[0]
  const last = t.comments[t.comments.length - 1]
  const sev = opener ? severityOf(opener.body) : null

  if (resolved && !opts.expanded) {
    const head: TextChunk[] = [chunk('✓ @' + (opener?.author ?? ''), S.dim)]
    if (sev) head.push(chunk(SEP, S.dim), chunk(sev.tag, S.dim))
    head.push(chunk(SEP, S.dim))
    const used = chunksWidth(head)
    head.push(chunk(preview(last, inner - used), S.dim))
    return [row(head)]
  }

  const rows: TextChunk[][] = [row(header(t, opener, last, sev, opts))]
  if (!opts.expanded) {
    rows.push(row([chunk(preview(last, inner), S.text)]))
    return rows
  }

  // The opener's body comes straight under the header — that row already
  // names the author and the time, and the severity badge is the first thing
  // the body renders. Repeating either was the first thing to go.
  const authorStyle = resolved ? S.dim : S.mode
  t.comments.forEach((c, i) => {
    if (i > 0) {
      rows.push(row([chunk('───', S.dim)]))
      rows.push(row([chunk(`@${c.author}${SEP}${formatStamp(c.createdAt)}`, authorStyle)]))
    }
    for (const body of renderMarkdown(c.body, { width: inner, highlight: highlightBlock })) {
      rows.push([chunk(' '), chunk('┃', barStyle), chunk(' '), ...body])
    }
  })
  rows.push(row([]))
  return rows
}

function header(
  t: StoredThread,
  opener: StoredComment | undefined,
  last: StoredComment | undefined,
  sev: { tag: Severity } | null,
  opts: CardOptions,
): TextChunk[] {
  const resolved = t.status === 'resolved'
  const out: TextChunk[] = []
  if (resolved) out.push(chunk('✓ ', S.dim))
  out.push(chunk('@' + (opener?.author ?? ''), resolved ? S.dim : S.mode))
  // Collapsed, the badge is the one thing worth scanning for and the body is
  // hidden, so it rides the header; expanded, the body opens with it.
  if (sev && !opts.expanded) {
    out.push(chunk(SEP, S.dim), chunk(sev.tag, resolved ? S.dim : severityStyle(sev.tag)))
  }
  // Collapsed, the time of the LAST comment (what is new); expanded, the
  // opener's, because that is whose body sits right under this row.
  const stamped = opts.expanded ? opener : last
  if (stamped) out.push(chunk(SEP, S.dim), chunk(formatStamp(stamped.createdAt), S.dim))
  const n = t.comments.length
  if (n > 1) out.push(chunk(SEP, S.dim), chunk(`${n} comments`, S.dim))
  const d = opts.drift
  if (d?.status === 'moved') out.push(chunk(SEP, S.dim), chunk(`moved from L${d.from.start}`, S.dim))
  else if (d?.status === 'lost') {
    out.push(chunk(SEP, S.dim), chunk(`lost — was ${rangeLabel(d.from)}`, S.del))
  }
  if (!opts.hostExact) out.push(chunk(SEP, S.dim), chunk(rangeLabel(t.range), S.dim))
  return out
}

function rangeLabel(r: { start: number; end: number }): string {
  return r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`
}

/** The one-line preview, cut to `avail` columns with an ellipsis when it won't fit. */
function preview(c: StoredComment | undefined, avail: number): string {
  if (!c || avail <= 0) return ''
  const text = firstLine(c.body)
  if (width(text) <= avail) return text
  return truncate(text, Math.max(0, avail - 1)) + '…'
}

export function severityStyle(tag: Severity): Style {
  switch (tag) {
    case 'must-fix':
      return S.sevMustFix
    case 'suggestion':
      return S.sevSuggestion
    case 'question':
      return S.sevQuestion
    default:
      return S.sevNit
  }
}

/**
 * paintCardRow lays a background under a whole row — the cursor or selection
 * tint — keeping every foreground, the bar's included.
 */
export function paintCardRow(row: TextChunk[], bg: RGBA): TextChunk[] {
  return row.map((c) => ({ ...c, bg }))
}

function chunksWidth(chunks: TextChunk[]): number {
  let n = 0
  for (const c of chunks) n += width(c.text)
  return n
}

/** Exactly `w` columns: clip by grapheme, then pad. */
function fitRow(chunks: TextChunk[], w: number): TextChunk[] {
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
    const head = truncate(c.text, w - acc)
    if (head !== '') {
      out.push({ ...c, text: head })
      acc += width(head)
    }
    break
  }
  if (acc < w) out.push(chunk(' '.repeat(w - acc)))
  return out
}
