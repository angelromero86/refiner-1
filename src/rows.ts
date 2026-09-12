/**
 * The display rows of the diff pane: the active diff's rows with the review
 * threads spliced in as cards, and the inline compose block when one is open.
 *
 * This is the one place that knows where a card goes. Everything above it —
 * the cursor, the scroll, the selection — lives in DISPLAY space, an index into
 * `Layout.rows`, and everything below it — staging, hunks, line numbers — lives
 * in the active diff's index space. `diffToDisplay` and `DisplayRow.idx` are
 * the two directions of that mapping; `App.diffIdxAt` is the usual door.
 *
 * Placement: a card goes AFTER the last active row whose `newNum` is the
 * thread's last line. If no row carries that line — the range falls outside the
 * diff's context, the thread is lost — it goes after the last row with a lower
 * `newNum`, and failing that at the very top. Threads therefore never vanish
 * from the pane, which is what the modal-era UI did with a thread outside the
 * hunks. Del-only rows (`newNum === 0`) never host a card: they are not
 * working-tree lines.
 *
 * The layout is a function of the pane width — an expanded card is as tall as
 * its wrapped markdown — so it is memoized by `App.layout(width)`, and the
 * rendered card rows travel with it so that a cursor move never re-renders a
 * comment body.
 */

import type { TextChunk } from '@opentui/core'
import { ViewMode, type App } from './app.ts'
import { renderCard } from './card.ts'
import type { StoredThread } from './comments.ts'

export type DisplayRow =
  /** Index into the ACTIVE array (unified / split / current). */
  | { kind: 'diff'; idx: number }
  /** Line `line` of a thread's card; 0 is the header. */
  | { kind: 'card'; threadId: string; line: number; lines: number }
  /** Rows reserved for the inline textarea, its hint, and (new thread) its header. */
  | { kind: 'compose'; line: number; lines: number }

export interface Layout {
  rows: DisplayRow[]
  /** Active diff idx → display idx (hunk jumps, `navigateToPendingLine`, staging feedback). */
  diffToDisplay: number[]
  /** Thread id → display idx of the card's header row. */
  cardStart: Map<string, number>
  /** Thread id → the card's rendered rows, cursor-less. */
  cards: Map<string, TextChunk[][]>
  /** Display idx of the compose block's first row, or -1 when not composing. */
  composeStart: number
}

/** Rows the inline textarea occupies. */
export const COMPOSE_H = 6
/** Textarea plus its hint row. */
export const COMPOSE_ROWS = COMPOSE_H + 1
/** A new thread's block also opens with a `New thread · L41-45` header. */
export const COMPOSE_NEW_ROWS = COMPOSE_ROWS + 1

/** The rows of the active view, reduced to what placement needs. */
function activeRows(app: App): readonly { newNum: number }[] {
  const cached = app.cache.get(app.selectedPath)
  if (!cached) return []
  switch (app.effectiveViewMode()) {
    case ViewMode.Split:
      return cached.split
    case ViewMode.Current:
      return cached.current
    default:
      return cached.unified
  }
}

/**
 * hostFor finds the active row a range ends on: the last row carrying `end`
 * exactly, else the last row with a lower working-tree line, else -1 (top).
 * `exact` says which of the three it was, for the card header.
 */
export function hostFor(
  rows: readonly { newNum: number }[],
  end: number,
): { idx: number; exact: boolean } {
  let lower = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const n = rows[i]!.newNum
    if (n === end) return { idx: i, exact: true }
    if (lower < 0 && n > 0 && n < end) lower = i
  }
  return { idx: lower, exact: false }
}

export function buildLayout(app: App, contentW: number): Layout {
  const rows: DisplayRow[] = []
  const cardStart = new Map<string, number>()
  const cards = new Map<string, TextChunk[][]>()
  let composeStart = -1

  const active = activeRows(app)
  const diffToDisplay = new Array<number>(active.length)
  const compose = app.compose

  // Threads by host row, in `threadsForFile` order (start line, then store order).
  const hosted = new Map<number, { t: StoredThread; exact: boolean }[]>()
  for (const t of app.store.threadsForFile(app.selectedPath)) {
    const { idx, exact } = hostFor(active, t.range.end)
    const list = hosted.get(idx)
    if (list) list.push({ t, exact })
    else hosted.set(idx, [{ t, exact }])
  }
  const composeHost = compose?.kind === 'new' ? hostFor(active, compose.end).idx : null

  const emitCompose = (lines: number): void => {
    composeStart = rows.length
    for (let line = 0; line < lines; line++) rows.push({ kind: 'compose', line, lines })
  }
  const emitCards = (host: number): void => {
    for (const { t, exact } of hosted.get(host) ?? []) {
      const rendered = renderCard(t, {
        width: contentW,
        expanded: app.expandedThreads.has(t.id),
        drift: app.threadDrift(t.id),
        hostExact: exact,
      })
      cards.set(t.id, rendered)
      cardStart.set(t.id, rows.length)
      const lines = rendered.length
      for (let line = 0; line < lines; line++) rows.push({ kind: 'card', threadId: t.id, line, lines })
      if (compose && compose.kind !== 'new' && compose.threadId === t.id) emitCompose(COMPOSE_ROWS)
    }
  }

  if (composeHost === -1) emitCompose(COMPOSE_NEW_ROWS)
  emitCards(-1)
  for (let i = 0; i < active.length; i++) {
    diffToDisplay[i] = rows.length
    rows.push({ kind: 'diff', idx: i })
    // A thread being written goes right under its code, ahead of any card that
    // already sits there: it is the thing being typed into.
    if (composeHost === i) emitCompose(COMPOSE_NEW_ROWS)
    emitCards(i)
  }

  return { rows, diffToDisplay, cardStart, cards, composeStart }
}
