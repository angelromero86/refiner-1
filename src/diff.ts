/**
 * Unified-diff parsing, side-by-side alignment, staged-line detection and
 * partial-patch construction.
 *
 * Everything here is a pure function over strings — no git, no terminal, no
 * framework. `buildPartialPatch` is the one function whose output is consumed
 * by `git apply --cached`, so it is covered by parity tests against a corpus
 * of real diffs; treat any change to it as load-bearing.
 */

export enum LineKind {
  Meta,
  Header,
  Hunk,
  Add,
  Del,
  Ctx,
}

export interface Line {
  text: string
  kind: LineKind
  oldNum: number
  newNum: number
  /**
   * True when the original diff had a `\ No newline at end of file` marker
   * immediately following this line. Per unified-diff spec the marker applies
   * to the side(s) implied by the line's prefix: ' ' = both, '-' = old, '+' =
   * new. Lost markers cause `git apply --cached` to reject the patch because
   * context lengths no longer match HEAD.
   */
  noNewline: boolean
}

export enum RowKind {
  Ctx,
  Mod,
  Del,
  Add,
  Hunk,
  Meta,
}

export interface AlignedRow {
  kind: RowKind
  oldNum: number
  newNum: number
  oldText: string
  newText: string
  /**
   * Source indices into the input lines slice. -1 if N/A. Used to map a
   * split-view row back to the underlying unified line(s) for staging.
   */
  oldSrcIdx: number
  newSrcIdx: number
}

const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function line(kind: LineKind, text: string, oldNum = 0, newNum = 0): Line {
  return { text, kind, oldNum, newNum, noNewline: false }
}

/**
 * computeStagedIndices returns the set of indices in `combined` whose line is
 * also present in `staged`. Both inputs are filtered (ctx/del/add only) and
 * share the same HEAD reference. Del lines are matched by oldNum; add lines by
 * (anchor=previous ctx/del oldNum, content) — duplicates are matched in order.
 */
export function computeStagedIndices(combined: Line[], staged: Line[]): Set<number> {
  const out = new Set<number>()
  if (combined.length === 0 || staged.length === 0) return out

  const stagedDels = new Set<number>()
  // Key is `${anchor}\0${content}` — a struct key in Go, a joined string here.
  const stagedAddCount = new Map<string, number>()
  const addKey = (anchor: number, content: string) => `${anchor}\0${content}`

  let anchor = 0
  for (const l of staged) {
    switch (l.kind) {
      case LineKind.Ctx:
        anchor = l.oldNum
        break
      case LineKind.Del:
        stagedDels.add(l.oldNum)
        anchor = l.oldNum
        break
      case LineKind.Add: {
        const key = addKey(anchor, stripPrefix(l.text, '+'))
        stagedAddCount.set(key, (stagedAddCount.get(key) ?? 0) + 1)
        break
      }
    }
  }

  anchor = 0
  for (let i = 0; i < combined.length; i++) {
    const l = combined[i]
    switch (l.kind) {
      case LineKind.Ctx:
        anchor = l.oldNum
        break
      case LineKind.Del:
        if (stagedDels.has(l.oldNum)) out.add(i)
        anchor = l.oldNum
        break
      case LineKind.Add: {
        const key = addKey(anchor, stripPrefix(l.text, '+'))
        const n = stagedAddCount.get(key) ?? 0
        if (n > 0) {
          stagedAddCount.set(key, n - 1)
          out.add(i)
        }
        break
      }
    }
  }
  return out
}

/**
 * buildPartialPatch builds a unified-diff patch suitable for `git apply --cached`.
 * Only the changes in `include` (indices into `combined`) appear as actual
 * del/add operations. Unselected dels become context (HEAD-and-index still has
 * them); unselected adds are omitted (neither HEAD nor index has them).
 * Returns "" if there's nothing to stage.
 */
export function buildPartialPatch(path: string, combined: Line[], include: Set<number>): string {
  if (include.size === 0) return ''

  interface BodyEntry {
    ch: ' ' | '-' | '+'
    text: string
    /** Index into `combined`; used to look up noNewline for trailing markers. */
    srcIdx: number
  }
  const entries: BodyEntry[] = []
  let oldCount = 0
  let newCount = 0
  let any = false

  for (let i = 0; i < combined.length; i++) {
    const l = combined[i]
    switch (l.kind) {
      case LineKind.Ctx:
        entries.push({ ch: ' ', text: stripPrefix(l.text, ' '), srcIdx: i })
        oldCount++
        newCount++
        break
      case LineKind.Del: {
        const txt = stripPrefix(l.text, '-')
        if (include.has(i)) {
          entries.push({ ch: '-', text: txt, srcIdx: i })
          oldCount++
          any = true
        } else {
          // Unselected del → context: HEAD has it, post-apply index also has it.
          entries.push({ ch: ' ', text: txt, srcIdx: i })
          oldCount++
          newCount++
        }
        break
      }
      case LineKind.Add:
        if (include.has(i)) {
          entries.push({ ch: '+', text: stripPrefix(l.text, '+'), srcIdx: i })
          newCount++
          any = true
        }
        // Unselected adds are omitted entirely.
        break
    }
  }
  if (!any) return ''

  // Locate the last entry on each side so we can place `\ No newline …`
  // markers correctly. The patch's old side is HEAD verbatim, so its trailing
  // state must match HEAD's; the new side reflects the post-patch index.
  let oldLast = -1
  let newLast = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const ch = entries[i].ch
    if (oldLast < 0 && (ch === ' ' || ch === '-')) oldLast = i
    if (newLast < 0 && (ch === ' ' || ch === '+')) newLast = i
    if (oldLast >= 0 && newLast >= 0) break
  }
  // HEAD lacks trailing newline iff the file's last old-side line in `combined`
  // (last Ctx or Del) carried the marker.
  let headNoNewline = false
  for (let i = combined.length - 1; i >= 0; i--) {
    const k = combined[i].kind
    if (k === LineKind.Ctx || k === LineKind.Del) {
      headNoNewline = combined[i].noNewline
      break
    }
  }
  // Post-patch new side lacks trailing newline iff the source line of the
  // chosen new-side-last carried a marker. For a ctx/del-as-ctx that's HEAD's
  // state for that line; for an included add it's the working tree's state.
  let postNoNewline = false
  if (newLast >= 0) postNoNewline = combined[entries[newLast].srcIdx].noNewline

  const marker = '\\ No newline at end of file\n'
  let buf = ''
  buf += `diff --git a/${path} b/${path}\n`
  buf += `--- a/${path}\n`
  buf += `+++ b/${path}\n`
  buf += `@@ -1,${oldCount} +1,${newCount} @@\n`
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    buf += e.ch + e.text + '\n'
    // Marker placement rules — a marker after a ' ' line applies to both
    // sides, after '-' to old only, after '+' to new only.
    if (i === oldLast && i === newLast) {
      if (headNoNewline || postNoNewline) buf += marker
    } else if (i === oldLast) {
      if (headNoNewline) buf += marker
    } else if (i === newLast) {
      if (postNoNewline) buf += marker
    }
  }
  return buf
}

export function parse(text: string): Line[] {
  const out: Line[] = []
  let oldNum = 0
  let newNum = 0
  let inHunk = false

  const lines = text.split('\n')
  // Drop the trailing empty element produced by split when the text ends with
  // "\n" — otherwise it gets classified as a phantom ctx line and throws hunk
  // counts off by one, breaking `git apply --cached`.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = hunkRe.exec(raw)
      if (m) {
        oldNum = parseInt(m[1], 10)
        newNum = parseInt(m[2], 10)
        inHunk = true
      }
      out.push(line(LineKind.Hunk, raw))
      continue
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      out.push(line(LineKind.Header, raw))
      inHunk = false
      continue
    }
    // Inside a hunk, `\ No newline at end of file` is a marker that attaches
    // to the previously-emitted content line — never a standalone entry.
    // Dropping it (or treating it as Meta) loses information buildPartialPatch
    // needs to keep the patch consistent with HEAD's trailing-newline state.
    if (inHunk && raw.startsWith('\\')) {
      if (out.length > 0) out[out.length - 1].noNewline = true
      continue
    }
    if (isMeta(raw)) {
      out.push(line(LineKind.Meta, raw))
      inHunk = false
      continue
    }
    if (!inHunk) {
      out.push(line(LineKind.Meta, raw))
      continue
    }
    if (raw.startsWith('+')) {
      out.push(line(LineKind.Add, raw, 0, newNum))
      newNum++
    } else if (raw.startsWith('-')) {
      out.push(line(LineKind.Del, raw, oldNum, 0))
      oldNum++
    } else {
      out.push(line(LineKind.Ctx, raw, oldNum, newNum))
      oldNum++
      newNum++
    }
  }
  return out
}

function isMeta(s: string): boolean {
  return (
    s.startsWith('diff ') ||
    s.startsWith('index ') ||
    s.startsWith('new file') ||
    s.startsWith('deleted file') ||
    s.startsWith('similarity ') ||
    s.startsWith('rename ') ||
    s.startsWith('Binary ') ||
    s.startsWith('\\') // "\ No newline at end of file" marker
  )
}

/**
 * align builds the side-by-side aligned rows from a unified Line list. The
 * indices stored in oldSrcIdx/newSrcIdx point back into the input list — pass
 * the SAME list the caller intends to use as canonical (e.g. filtered).
 */
export function align(lines: Line[]): AlignedRow[] {
  const out: AlignedRow[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]

    if (l.kind === LineKind.Ctx) {
      const txt = stripPrefix(l.text, ' ')
      out.push({
        kind: RowKind.Ctx,
        oldNum: l.oldNum,
        newNum: l.newNum,
        oldText: txt,
        newText: txt,
        oldSrcIdx: i,
        newSrcIdx: i,
      })
      i++
      continue
    }

    if (l.kind === LineKind.Del || l.kind === LineKind.Add) {
      const dels: { line: Line; idx: number }[] = []
      const adds: { line: Line; idx: number }[] = []
      while (i < lines.length && lines[i].kind === LineKind.Del) {
        dels.push({ line: lines[i], idx: i })
        i++
      }
      while (i < lines.length && lines[i].kind === LineKind.Add) {
        adds.push({ line: lines[i], idx: i })
        i++
      }
      const max = Math.max(dels.length, adds.length)
      for (let j = 0; j < max; j++) {
        const d = j < dels.length ? dels[j] : null
        const a = j < adds.length ? adds[j] : null
        if (d && a) {
          out.push({
            kind: RowKind.Mod,
            oldNum: d.line.oldNum,
            newNum: a.line.newNum,
            oldText: stripPrefix(d.line.text, '-'),
            newText: stripPrefix(a.line.text, '+'),
            oldSrcIdx: d.idx,
            newSrcIdx: a.idx,
          })
        } else if (d) {
          out.push({
            kind: RowKind.Del,
            oldNum: d.line.oldNum,
            newNum: 0,
            oldText: stripPrefix(d.line.text, '-'),
            newText: '',
            oldSrcIdx: d.idx,
            newSrcIdx: -1,
          })
        } else if (a) {
          out.push({
            kind: RowKind.Add,
            oldNum: 0,
            newNum: a.line.newNum,
            oldText: '',
            newText: stripPrefix(a.line.text, '+'),
            oldSrcIdx: -1,
            newSrcIdx: a.idx,
          })
        }
      }
      continue
    }

    if (l.kind === LineKind.Hunk) {
      out.push({
        kind: RowKind.Hunk,
        oldNum: 0,
        newNum: 0,
        oldText: l.text,
        newText: l.text,
        oldSrcIdx: -1,
        newSrcIdx: -1,
      })
      i++
      continue
    }

    out.push({
      kind: RowKind.Meta,
      oldNum: 0,
      newNum: 0,
      oldText: l.text,
      newText: l.text,
      oldSrcIdx: -1,
      newSrcIdx: -1,
    })
    i++
  }
  return out
}

/**
 * contextOnly turns a file's contents into a diff that consists entirely of
 * context lines.
 *
 * This is how a file with no changes gets displayed: rather than teach the
 * renderers about "not a diff", we hand them a diff where nothing changed. Every
 * view then works unmodified — though only the post-change one is worth looking at,
 * since the other two would show the same text twice.
 *
 * The leading space matters: the renderers strip a one-character diff marker from
 * every line, so the text has to carry it just like real `git diff` output does.
 */
export function contextOnly(text: string): Line[] {
  const lines = text.split('\n')
  // A trailing newline produces a final empty element that is not a line.
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (endsWithNewline) lines.pop()

  return lines.map((t, i) => ({
    text: ' ' + t,
    kind: LineKind.Ctx,
    oldNum: i + 1,
    newNum: i + 1,
    // Mirrors what git would report, so anything reading this stays consistent.
    noNewline: !endsWithNewline && i === lines.length - 1,
  }))
}

/**
 * filterContentLines drops meta/header/hunk lines so the remaining list holds
 * only ctx/del/add — what gets cached and rendered.
 */
export function filterContentLines(input: Line[]): Line[] {
  return input.filter(
    (l) => l.kind !== LineKind.Meta && l.kind !== LineKind.Header && l.kind !== LineKind.Hunk,
  )
}

/**
 * filterCurrentView produces the post-change file view: ctx + add lines only.
 * The parallel index list maps each filtered row back to its position in the
 * unified list so staging and other unified-indexed operations still work.
 */
export function filterCurrentView(input: Line[]): { out: Line[]; idx: number[] } {
  const out: Line[] = []
  const idx: number[] = []
  for (let i = 0; i < input.length; i++) {
    if (input[i].kind === LineKind.Del) continue
    out.push(input[i])
    idx.push(i)
  }
  return { out, idx }
}

/** Go's strings.TrimPrefix — removes `prefix` only if present. */
function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s
}
