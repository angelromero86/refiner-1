/**
 * The three diff row renderers — unified, split and "current" (post-change).
 *
 * Each returns a list of styled chunks rather than a string, but the row is
 * still segmented exactly as before: marker + gutter + content + padding. The
 * gutter is where staged/comment state is signalled, so it is always styled
 * independently of the content.
 */

import type { TextChunk } from '@opentui/core'
import { LineKind, RowKind, type AlignedRow, type Line } from './diff.ts'
import { chunk, S, type CursorRowStyles, type Style } from './styles.ts'
import { expandTabs, fitExact, truncate, width } from './text.ts'

const NUM_COL_WIDTH = 4
const MARKER_WIDTH = 2 // "▶ " or "  "
const DIVIDER_WIDTH = 3 // " │ "
const SPLIT_SIDE_GUTTER_WIDTH = NUM_COL_WIDTH + 1 // "NNNN "

function padNum(n: number): string {
  if (n === 0) return ' '.repeat(NUM_COL_WIDTH)
  return String(n).padStart(NUM_COL_WIDTH, ' ')
}

/**
 * signCol returns a NUM_COL_WIDTH-wide column with `sign` right-aligned, so it
 * lines up with the line-number padding and the gutter stays visually straight.
 */
function signCol(sign: string): string {
  return ' '.repeat(NUM_COL_WIDTH - 1) + sign
}

/** Total display width of a chunk list. */
export function chunksWidth(chunks: TextChunk[]): number {
  let n = 0
  for (const c of chunks) n += width(c.text)
  return n
}

/** Cut a chunk list to at most `w` columns, preserving per-chunk styles. */
function truncateChunks(chunks: TextChunk[], w: number): TextChunk[] {
  const out: TextChunk[] = []
  let acc = 0
  for (const c of chunks) {
    const cw = width(c.text)
    if (acc + cw <= w) {
      out.push(c)
      acc += cw
      continue
    }
    const head = truncate(c.text, w - acc)
    if (head !== '') out.push({ ...c, text: head })
    break
  }
  return out
}

/**
 * Force a row to exactly `w` columns: truncate when too wide, otherwise append
 * a padding chunk so a cursor row's highlight runs uniformly to the edge.
 */
function fitRow(chunks: TextChunk[], w: number, padStyle?: Style): TextChunk[] {
  const visible = chunksWidth(chunks)
  if (visible > w) return truncateChunks(chunks, w)
  if (visible < w && padStyle) {
    return [...chunks, chunk(' '.repeat(w - visible), padStyle)]
  }
  return chunks
}

/**
 * cursorStylesForLine picks the cursor-row variant for a unified line, taking
 * staged state into account. Variants share the cursor bg so the selection color
 * prevails; the fg follows the line's kind.
 */
function cursorStylesForLine(kind: LineKind, staged: boolean): CursorRowStyles {
  if (staged && (kind === LineKind.Add || kind === LineKind.Del)) return S.stagedCursorRow
  switch (kind) {
    case LineKind.Add:
      return S.addCursorRow
    case LineKind.Del:
      return S.delCursorRow
    default:
      return S.ctxCursorRow
  }
}

/**
 * splitSideKind maps an aligned row's kind to the per-side equivalent line kind
 * for cursor styling. The "empty" side of a del/add row is treated as context.
 */
function splitSideKind(rowKind: RowKind, isOld: boolean): LineKind {
  switch (rowKind) {
    case RowKind.Del:
      return isOld ? LineKind.Del : LineKind.Ctx
    case RowKind.Add:
      return isOld ? LineKind.Ctx : LineKind.Add
    case RowKind.Mod:
      return isOld ? LineKind.Del : LineKind.Add
    default:
      return LineKind.Ctx
  }
}

/**
 * Per-row visual flags shared by all three renderers.
 *
 *   isCursor   — the row holds the actual content cursor (gets "▶ ")
 *   isSelected — the row is within the shift-selection range (or is the cursor)
 *   focused    — the content pane has focus (cursor/selection show only then)
 *   hasComment — a thread anchors to this row's working-tree line
 *   staged     — unified/current only: the line is in git's index
 *   oldStaged / newStaged — split only: per-side staging
 */
export interface RowState {
  isCursor: boolean
  isSelected: boolean
  focused: boolean
  hasComment: boolean
  staged?: boolean
  oldStaged?: boolean
  newStaged?: boolean
}

export function renderUnifiedRow(l: Line, st: RowState, w: number): TextChunk[] {
  let text = expandTabs(l.text)
  // Move the +/- marker out of the content into the opposite empty line-number
  // slot. Context text just loses its leading space.
  let oldCol = padNum(l.oldNum)
  let newCol = padNum(l.newNum)
  switch (l.kind) {
    case LineKind.Add:
      oldCol = signCol('+')
      text = stripFirst(text, '+')
      break
    case LineKind.Del:
      newCol = signCol('-')
      text = stripFirst(text, '-')
      break
    case LineKind.Ctx:
      text = stripFirst(text, ' ')
      break
  }
  const gutter = `${oldCol} ${newCol} │ `
  const staged = st.staged ?? false

  if (st.isSelected && st.focused) {
    const cs = cursorStylesForLine(l.kind, staged)
    // The comment indicator (pink gutter) overrides the cursor bg on the gutter
    // only — the content keeps its cursor styling, so a commented line that is
    // also the cursor still reads as the cursor.
    const gutterStyle = st.hasComment ? S.commentGutter : cs.gutter
    return fitRow(
      [
        chunk(st.isCursor ? '▶ ' : '  ', cs.marker),
        chunk(gutter, gutterStyle),
        chunk(text, cs.content),
      ],
      w,
      cs.pad,
    )
  }

  // Not selected. Comment-pink wins over staged/add/del on the gutter only.
  let gutterStyle: Style
  let contentStyle: Style
  let padStyle: Style | undefined

  if (staged && (l.kind === LineKind.Add || l.kind === LineKind.Del)) {
    gutterStyle = S.stagedGutter
    contentStyle = S.stagedContent
    padStyle = S.stagedPad
  } else if (l.kind === LineKind.Add) {
    gutterStyle = S.addGutter
    contentStyle = S.addContent
    padStyle = S.addPad
  } else if (l.kind === LineKind.Del) {
    gutterStyle = S.delGutter
    contentStyle = S.delContent
    padStyle = S.delPad
  } else {
    gutterStyle = S.gutter
    contentStyle = S.text
    padStyle = undefined
  }
  if (st.hasComment) gutterStyle = S.commentGutter

  return fitRow(
    [chunk('  '), chunk(gutter, gutterStyle), chunk(text, contentStyle)],
    w,
    padStyle,
  )
}

/**
 * renderCurrentRow renders one row of the "current file" view — post-change
 * only (no dels), so a single line-number column is enough. A leading `+` on add
 * lines preserves the cue that the line is part of the diff.
 */
export function renderCurrentRow(l: Line, st: RowState, w: number): TextChunk[] {
  let text = expandTabs(l.text)
  let sign = ' '
  switch (l.kind) {
    case LineKind.Add:
      sign = '+'
      text = stripFirst(text, '+')
      break
    case LineKind.Ctx:
      text = stripFirst(text, ' ')
      break
  }
  // Single-column gutter: "<sign> NNNN │ ".
  const gutter = `${sign} ${padNum(l.newNum)} │ `
  const staged = st.staged ?? false

  if (st.isSelected && st.focused) {
    const cs = cursorStylesForLine(l.kind, staged)
    const gutterStyle = st.hasComment ? S.commentGutter : cs.gutter
    return fitRow(
      [
        chunk(st.isCursor ? '▶ ' : '  ', cs.marker),
        chunk(gutter, gutterStyle),
        chunk(text, cs.content),
      ],
      w,
      cs.pad,
    )
  }

  let gutterStyle: Style
  let contentStyle: Style
  let padStyle: Style | undefined

  if (staged && l.kind === LineKind.Add) {
    gutterStyle = S.stagedGutter
    contentStyle = S.stagedContent
    padStyle = S.stagedPad
  } else if (l.kind === LineKind.Add) {
    gutterStyle = S.addGutter
    contentStyle = S.addContent
    padStyle = S.addPad
  } else {
    gutterStyle = S.gutter
    contentStyle = S.text
    padStyle = undefined
  }
  if (st.hasComment) gutterStyle = S.commentGutter

  return fitRow(
    [chunk('  '), chunk(gutter, gutterStyle), chunk(text, contentStyle)],
    w,
    padStyle,
  )
}

export function renderSplitRow(
  r: AlignedRow,
  st: RowState,
  sideWidth: number,
  w: number,
): TextChunk[] {
  if (sideWidth < 1) sideWidth = 1
  const oldGutter = padNum(r.oldNum) + ' '
  const newGutter = padNum(r.newNum) + ' '
  const oldText = fitExact(r.oldText, sideWidth)
  const newText = fitExact(r.newText, sideWidth)
  const oldStaged = st.oldStaged ?? false
  const newStaged = st.newStaged ?? false

  if (st.isSelected && st.focused) {
    const csOld = cursorStylesForLine(splitSideKind(r.kind, true), oldStaged)
    const csNew = cursorStylesForLine(splitSideKind(r.kind, false), newStaged)
    let oldGutterStyle = csOld.gutter
    let newGutterStyle = csNew.gutter
    let oldContentStyle = csOld.content
    let newContentStyle = csNew.content
    if (st.hasComment) {
      oldGutterStyle = S.commentGutter
      newGutterStyle = S.commentGutter
      // Keep the pink continuous across an empty side.
      if (r.kind === RowKind.Add) oldContentStyle = S.commentGutter
      if (r.kind === RowKind.Del) newContentStyle = S.commentGutter
    }
    return fitRow(
      [
        chunk(st.isCursor ? '▶ ' : '  ', csOld.marker),
        chunk(oldGutter, oldGutterStyle),
        chunk(oldText, oldContentStyle),
        chunk(' │ ', S.ctxCursorRow.pad),
        chunk(newGutter, newGutterStyle),
        chunk(newText, newContentStyle),
      ],
      w,
      csNew.pad,
    )
  }

  const body = [
    chunk('  '),
    ...renderSplitSide(oldGutter, oldText, r.kind, true, oldStaged, st.hasComment),
    chunk(' │ ', S.gutter),
    ...renderSplitSide(newGutter, newText, r.kind, false, newStaged, st.hasComment),
  ]
  return chunksWidth(body) > w ? truncateChunks(body, w) : body
}

function renderSplitSide(
  gutter: string,
  text: string,
  kind: RowKind,
  isOld: boolean,
  staged: boolean,
  hasComment: boolean,
): TextChunk[] {
  const delSide = isOld && (kind === RowKind.Del || kind === RowKind.Mod)
  const addSide = !isOld && (kind === RowKind.Add || kind === RowKind.Mod)
  // "Empty side": this side has no content for this row because the change
  // belongs to the other side (old side of an Add, new side of a Del).
  const emptySide = (isOld && kind === RowKind.Add) || (!isOld && kind === RowKind.Del)

  let gutterStyle: Style = S.gutter
  if (staged && (delSide || addSide)) gutterStyle = S.stagedGutter
  else if (delSide) gutterStyle = S.delGutter
  else if (addSide) gutterStyle = S.addGutter
  if (hasComment) gutterStyle = S.commentGutter

  // On a commented row, paint an empty side's content pink too so the marker
  // reads as one continuous block from gutter to divider.
  let contentStyle: Style
  if (staged && (delSide || addSide)) contentStyle = S.stagedContent
  else if (delSide) contentStyle = S.delContent
  else if (addSide) contentStyle = S.addContent
  else if (hasComment && emptySide) contentStyle = S.commentGutter
  else contentStyle = S.text

  return [chunk(gutter, gutterStyle), chunk(text, contentStyle)]
}

/** Per-side text width for a given total content width in split view. */
export function splitSideWidth(w: number): number {
  const out = Math.floor((w - MARKER_WIDTH - SPLIT_SIDE_GUTTER_WIDTH * 2 - DIVIDER_WIDTH) / 2)
  return out < 1 ? 1 : out
}

/** Go's strings.TrimPrefix for a single-character prefix. */
function stripFirst(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s
}
