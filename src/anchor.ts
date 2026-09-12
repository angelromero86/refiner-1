/**
 * Content-based anchoring: keep a thread attached to the CODE it was written
 * against, not to the line number it happened to have.
 *
 * A thread's `range` is a pair of working-tree line numbers, and nothing keeps
 * them true: the reviewer edits the file, an agent applies a fix, and the thread
 * is now sitting under somebody else's code. So alongside the range the store
 * keeps an `Anchor` — the text of the anchored lines plus a few lines of context
 * on each side — and `relocate()` searches the current file for it.
 *
 * This is the same algorithm as the Refiner VSCode extension's `src/anchor.ts`,
 * ported line for line where it matters: `captureAnchor` (CTX = 3), the
 * trailing-whitespace-insensitive compare, and the scoring that ranks an exact
 * occurrence by context matches ×1000 minus distance. The two clients share
 * `.refiner/comments.json`, so an anchor written by one must mean the same thing
 * to the other, and `status` keeps the extension's semantics on disk:
 *
 *   exact  the anchored text is still at its previous position
 *   moved  it was found elsewhere; `start`/`end` say where
 *   lost   it is nowhere to be found; `start`/`end` are the previous position
 *
 * On top of that, two things the extension does not do:
 *
 *   - A fuzzy fallback before giving up. The extension only accepts a window
 *     whose every line matches, so touching one line of a four-line thread
 *     loses it. Here a window where at least 60% of the lines match is accepted
 *     (`FUZZY_MIN_RATIO`), ranked by how many lines match, then by context, then
 *     by proximity — and reported as `moved`, with `confidence: 'fuzzy'` so a
 *     caller can tell.
 *   - A guard against teleporting. `}` on its own matches hundreds of places in
 *     any file, and the extension's scoring happily picks the nearest one once
 *     the original is gone. A TRIVIAL anchor — no letters or digits in any of
 *     its lines — is therefore not accepted far from where it was unless at
 *     least one context line agrees (`NEAR`), and a fuzzy match must include at
 *     least one non-trivial line, or `foo() } }` would relocate onto `bar() } }`.
 */

import type { Anchor } from './comments.ts'

/** How many lines of leading/trailing context to keep for disambiguation. */
const CTX = 3

/**
 * The share of an anchor's lines that must match for a fuzzy relocation. At 60%
 * a four-line thread survives one edited line and a three-line thread too; a
 * two-line thread needs both, which is the exact scan again.
 */
const FUZZY_MIN_RATIO = 0.6

/**
 * How far a trivial anchor may move without any context agreeing. A `}` that
 * shifted a few lines because something was inserted above is the ordinary
 * case; a `}` that "moved" 200 lines is almost certainly a different brace.
 */
const NEAR = 10

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Compare ignoring trailing whitespace, so a stray space doesn't break anchoring. */
export function norm(line: string): string {
  return line.replace(/\s+$/, '')
}

export function blockEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i]) !== norm(b[i])) return false
  }
  return true
}

/** Snapshot the anchor for a 1-based, inclusive line range. */
export function captureAnchor(lines: string[], start1: number, end1: number): Anchor {
  const s = Math.max(0, start1 - 1)
  const e = Math.min(lines.length - 1, end1 - 1)
  return {
    lines: lines.slice(s, e + 1),
    before: lines.slice(Math.max(0, s - CTX), s),
    after: lines.slice(e + 1, Math.min(lines.length, e + 1 + CTX)),
  }
}

export type RelocateStatus = 'exact' | 'moved' | 'lost'

/**
 * How the position was established. `exact`: the text is where it was.
 * `context`: the whole text was found elsewhere (context and proximity picked
 * the occurrence). `fuzzy`: only part of the text was found. `none`: nothing
 * was found and the position is the old one, unverified.
 */
export type RelocateConfidence = 'exact' | 'context' | 'fuzzy' | 'none'

export interface RelocateResult {
  /** 1-based, inclusive. */
  start: number
  end: number
  status: RelocateStatus
  confidence: RelocateConfidence
}

/**
 * Find where `anchor` now lives in `lines`. `prevStart1` is the thread's
 * current `range.start` — where it was last known to be.
 */
export function relocate(lines: string[], anchor: Anchor, prevStart1: number): RelocateResult {
  const len = anchor.lines.length
  const prev0 = Math.max(0, prevStart1 - 1)
  const lost = (): RelocateResult => ({
    start: prevStart1,
    end: prevStart1 + Math.max(0, len - 1),
    status: 'lost',
    confidence: 'none',
  })
  // Nothing to look for — including a range that was captured past the end of
  // the file — and a block longer than the file has no window to land in.
  if (len === 0 || len > lines.length) return lost()

  // Fast path: unchanged at its old position.
  if (prev0 + len <= lines.length && blockEquals(lines.slice(prev0, prev0 + len), anchor.lines)) {
    return { start: prevStart1, end: prevStart1 + len - 1, status: 'exact', confidence: 'exact' }
  }

  const trivial = isTrivial(anchor.lines)

  // Exact block elsewhere: the extension's scan, plus the teleport guard.
  let best = -1
  let bestScore = -Infinity
  for (let i = 0; i + len <= lines.length; i++) {
    if (!blockEquals(lines.slice(i, i + len), anchor.lines)) continue
    if (trivial && Math.abs(i - prev0) > NEAR && !corroborated(lines, i, len, anchor)) continue
    // Prefer occurrences whose surrounding context also matches, then the
    // closest one to where the thread used to be.
    const score = contextScore(lines, i, len, anchor) * 1000 - Math.abs(i - prev0)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best >= 0) {
    return { start: best + 1, end: best + len, status: 'moved', confidence: 'context' }
  }

  // Fuzzy: the best window where enough of the lines still match.
  const need = Math.ceil(len * FUZZY_MIN_RATIO)
  best = -1
  bestScore = -Infinity
  for (let i = 0; i + len <= lines.length; i++) {
    let matched = 0
    let informative = 0
    for (let k = 0; k < len; k++) {
      if (norm(lines[i + k]) !== norm(anchor.lines[k])) continue
      matched++
      if (!isTrivialLine(anchor.lines[k])) informative++
    }
    if (matched < need || informative === 0) continue
    // Partial evidence needs corroboration: either the surroundings agree or
    // the window is about where the thread already was.
    if (Math.abs(i - prev0) > NEAR && !corroborated(lines, i, len, anchor)) continue
    const score = matched * 100000 + contextScore(lines, i, len, anchor) * 1000 - Math.abs(i - prev0)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best >= 0) {
    return { start: best + 1, end: best + len, status: 'moved', confidence: 'fuzzy' }
  }

  return lost()
}

/** How many of the anchor's context lines are found around window `i`. */
export function contextScore(lines: string[], i: number, len: number, anchor: Anchor): number {
  let score = 0
  for (let k = 0; k < anchor.before.length; k++) {
    const li = i - 1 - k
    const ai = anchor.before.length - 1 - k
    if (li >= 0 && norm(lines[li]) === norm(anchor.before[ai])) score++
  }
  for (let k = 0; k < anchor.after.length; k++) {
    const li = i + len + k
    if (li < lines.length && norm(lines[li]) === norm(anchor.after[k])) score++
  }
  return score
}

/**
 * True when at least one INFORMATIVE context line is found around window `i`.
 * `contextScore` above counts a matching `}` like any other line, faithfully to
 * the extension, but as the evidence that lets a weak match through it is worth
 * nothing: a closing brace follows almost every block in the file.
 */
function corroborated(lines: string[], i: number, len: number, anchor: Anchor): boolean {
  for (let k = 0; k < anchor.before.length; k++) {
    const li = i - 1 - k
    const ai = anchor.before.length - 1 - k
    if (li < 0 || isTrivialLine(anchor.before[ai])) continue
    if (norm(lines[li]) === norm(anchor.before[ai])) return true
  }
  for (let k = 0; k < anchor.after.length; k++) {
    const li = i + len + k
    if (li >= lines.length || isTrivialLine(anchor.after[k])) continue
    if (norm(lines[li]) === norm(anchor.after[k])) return true
  }
  return false
}

/** A line carrying no letter or digit: `}`, `);`, `]`, a blank — one of hundreds. */
function isTrivialLine(line: string): boolean {
  return !/[\p{L}\p{N}]/u.test(line)
}

function isTrivial(lines: string[]): boolean {
  return lines.every(isTrivialLine)
}
