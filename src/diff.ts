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
 * delOldNums collects the HEAD-side line numbers of every Del line — for
 * `git diff --cached HEAD`, the HEAD lines the index no longer has.
 */
export function delOldNums(lines: Line[]): Set<number> {
  const out = new Set<number>()
  for (const l of lines) if (l.kind === LineKind.Del) out.add(l.oldNum)
  return out
}

/**
 * addNewNums collects the new-side line numbers of every Add line — for the
 * index→worktree `git diff`, the working-tree lines the index does not have.
 */
export function addNewNums(lines: Line[]): Set<number> {
  const out = new Set<number>()
  for (const l of lines) if (l.kind === LineKind.Add) out.add(l.newNum)
  return out
}

/**
 * computeStagedIndices returns the indices in `combined` (the filtered
 * HEAD→worktree diff) whose change is already in the index.
 *
 * The attribution is by LINE NUMBER, never by content, and each side has its
 * own numbering to be attributed in:
 *
 *   - a Del row is a HEAD line, and it is staged iff that HEAD line is gone
 *     from the index — `stagedDelOldNums`, the Del `oldNum`s of
 *     `git diff --cached HEAD`;
 *   - an Add row is a working-tree line, and it is staged iff that line is
 *     already in the index, i.e. NOT among the lines the index→worktree diff
 *     adds — `unstagedAddNewNums`, the Add `newNum`s of a plain `git diff`;
 *   - a Ctx row is never staged.
 *
 * Content matching is what this replaced, and it is forbidden here for a
 * reason that is not cosmetic. The previous version paired Add rows with the
 * cached diff's Add lines by `(anchor, text)`, consuming duplicates in order —
 * so inside one block of added lines every repeated line (blank, `}`, `})`)
 * was claimed by the FIRST row with that text, and staging the tail of a block
 * painted every other row from its top instead. It was also wrong whenever
 * git's slider heuristic aligned the cached diff differently from the worktree
 * one, at which point a staged line simply vanished from the painting.
 * Then `drain()` cleared the intent, `stagedFor()` fell back to this answer,
 * and the next `toggleStaged` built its complete desired set from it and
 * reset-then-applied — a genuinely corrupt index, from a rendering bug.
 *
 * Line numbers cannot go wrong that way: a worktree line is in the index or it
 * is not, whatever its neighbours say. What CAN differ between the two diffs
 * is which member of a run of identical lines git calls "the added one" — and
 * `reconcileRuns` folds that back, see there. An identical line repeated
 * elsewhere in the file, NOT adjacent, is the one case left where the two
 * diffs can disagree unresolvably — inherent to describing one index through
 * two diffs, and out of reach of anything short of reconciling against the
 * index blob itself.
 */
export function computeStagedIndices(
  combined: Line[],
  stagedDelOldNums: ReadonlySet<number>,
  unstagedAddNewNums: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < combined.length; i++) {
    const l = combined[i]
    if (l.kind === LineKind.Del && stagedDelOldNums.has(l.oldNum)) out.add(i)
    else if (l.kind === LineKind.Add && !unstagedAddNewNums.has(l.newNum)) out.add(i)
  }
  // Dels live in HEAD's numbering; Adds in the working tree's. The HEAD
  // sequence is the Ctx and Del rows in order, the worktree sequence the Ctx
  // and Add rows — each in the numbering its side is attributed in.
  reconcileRuns(
    combined,
    out,
    LineKind.Del,
    (l) => l.kind !== LineKind.Add,
    (l) => stagedDelOldNums.has(l.oldNum),
    (dels, hits) => Math.min(dels, hits),
  )
  reconcileRuns(
    combined,
    out,
    LineKind.Add,
    (l) => l.kind !== LineKind.Del,
    (l) => unstagedAddNewNums.has(l.newNum),
    (adds, hits) => Math.max(0, adds - hits),
  )
  return out
}

/**
 * stagedIndicesFromDiffs is `computeStagedIndices` fed from git's raw answers:
 * `stagedText` is `git diff --cached HEAD -- <path>` and `unstagedText` the
 * index→worktree `git diff -U0 -- <path>`, both for the file `combined` came
 * from. Null means nothing is staged, which is what `App.staged` stores as an
 * absent entry.
 *
 * The two `''` cases are the point of having this in one place. An empty
 * cached diff is "index equals HEAD": nothing staged, whatever the other diff
 * says — and for an untracked file it says nothing at all, which read naively
 * is "every line is in the index". One step later the same trap again: a file
 * whose DELETION is staged has no index entry either, so the index→worktree
 * diff is blank even when the working tree has the file back, and only the
 * cached diff's own header (`deleted file mode`) tells that apart from "the
 * working tree matches the index". Then every Add row is unstaged by
 * definition.
 */
export function stagedIndicesFromDiffs(
  combined: Line[],
  stagedText: string,
  unstagedText: string,
): Set<number> | null {
  if (stagedText === '') return null
  const unstagedAdds =
    deletionMode(stagedText) !== null ? addNewNums(combined) : addNewNums(parse(unstagedText))
  return computeStagedIndices(combined, delOldNums(parse(stagedText)), unstagedAdds)
}

/**
 * reconcileRuns fixes the COUNT of staged rows inside every run of identical
 * adjacent lines, which is the one thing the two diffs can disagree on.
 *
 * Between identical neighbours git's choice of "the changed one" is arbitrary,
 * and the worktree diff and the index diff do not have to make the same one:
 * with `}` at worktree lines 4–6, the former may add line 4 while the latter
 * says line 6 is the one not in the index. Read one number against the other
 * and line 4 is both "added" and "in the index" — staged — while line 6 is a
 * Ctx row and cannot show anything, so one more `}` paints as staged than the
 * index holds. That is not content-equivalent: the next toggle would rebuild
 * the desired set from the painting and put the extra `}` into the index.
 *
 * Within the run the lines are interchangeable, so the count IS well-defined:
 * `hits` of the run's `oldNum`s/`newNum`s are on the other diff's list, and
 * `target(changedRows, hits)` says how many of the run's changeable rows must
 * be marked. Whatever git's own alignment already marked is kept where the
 * count agrees; otherwise rows are dropped from the front or added from the
 * back, so a consistent pair of diffs is a no-op and a slid one settles on the
 * later rows. Every choice yields the same blob when `buildPartialPatch`
 * re-applies it, which is what makes the choice safe to make.
 */
function reconcileRuns(
  combined: Line[],
  out: Set<number>,
  changeKind: LineKind,
  onSide: (l: Line) => boolean,
  hit: (l: Line) => boolean,
  target: (changedRows: number, hits: number) => number,
): void {
  let runStart = -1
  let runText = ''
  let runNoNewline = false
  let hits = 0
  let changed: number[] = []
  const flush = () => {
    if (runStart < 0 || changed.length === 0) return
    const want = target(changed.length, hits)
    let have = changed.filter((i) => out.has(i)).length
    for (let k = 0; k < changed.length && have > want; k++) {
      if (out.delete(changed[k])) have--
    }
    for (let k = changed.length - 1; k >= 0 && have < want; k--) {
      if (!out.has(changed[k])) {
        out.add(changed[k])
        have++
      }
    }
  }
  for (let i = 0; i < combined.length; i++) {
    const l = combined[i]
    if (!onSide(l)) continue
    const text = l.text.slice(1)
    if (runStart < 0 || text !== runText || l.noNewline !== runNoNewline) {
      flush()
      runStart = i
      runText = text
      runNoNewline = l.noNewline
      hits = 0
      changed = []
    }
    if (hit(l)) hits++
    if (l.kind === changeKind) changed.push(i)
  }
  flush()
}

/**
 * What `buildPartialPatch` cannot work out for itself: the facts that live in
 * git's own diff header and are gone by the time the line list is cached.
 *
 * Every field is optional and absence means "an ordinary modification of a file
 * that exists in HEAD" — the shape refiner emitted before this existed. That is
 * deliberate: adding a field must never change the bytes produced by a caller
 * that does not set it, because `test/diff.test.ts` pins those bytes against
 * fixtures generated by the original Go implementation.
 */
export interface PatchHeader {
  /**
   * The mode from `new file mode <mode>` when git said this diff CREATES the
   * file (no blob in HEAD), else null/absent. `creationMode()` reads it.
   *
   * It has to be a mode and not a boolean because git writes the mode into the
   * index: hard-coding `100644` silently drops an executable's `+x` bit.
   */
  createMode?: string | null
  /**
   * The mode from `deleted file mode <mode>` when git said this diff REMOVES the
   * file, else null/absent. `deletionMode()` reads it.
   *
   * A mode again, and here it is not a nicety: `git apply --cached` refuses a
   * symlink deletion announced as `100644` with `wrong type`, and downgrades an
   * executable's to a stderr warning that `applyPatchToIndex` (exit-code only)
   * would swallow.
   */
  deleteMode?: string | null
}

/**
 * creationMode reads `new file mode <mode>` out of a raw `git diff` header and
 * returns the mode (`'100644'`, `'100755'`, …), or null for anything else.
 *
 * It works on the RAW diff text on purpose. `filterContentLines` drops the meta
 * and header lines before anything is cached, so by the time a `Line[]` reaches
 * `buildPartialPatch` the answer is gone — and it cannot be recovered from the
 * lines, because a file whose HEAD blob is EMPTY produces a byte-identical
 * filtered list (all Add, no Ctx, no Del, and git even emits the same
 * `@@ -0,0 +1,N @@`) while needing the opposite header. Inferring creation from
 * `oldCount === 0` therefore breaks the empty-blob case, which git rejects with
 * `already exists in index`.
 *
 * Only the header block of the first file is scanned — the search stops at the
 * first `@@` — so a body line reading "new file mode 100644" cannot fool it.
 * refiner always diffs a single path anyway.
 */
export function creationMode(rawDiff: string): string | null {
  return headerMode(rawDiff, /^new file mode (\d{6})\s*$/)
}

/**
 * deletionMode reads `deleted file mode <mode>` out of a raw `git diff` header
 * and returns the mode (`'100644'`, `'100755'`, `'120000'`, …), or null for
 * anything else.
 *
 * The mirror of `creationMode`, and needed for the same reason: the answer is
 * unrecoverable from the cached `Line[]`, because deleting a file and TRUNCATING
 * one to zero bytes produce byte-identical filtered lists (all Del, same
 * `@@ -1,N +0,0 @@`) while needing opposite headers. Inferring deletion from
 * `newCount === 0` would empty-blob one and delete the other; the golden corpus
 * says so out loud, since `alldel.txt.diff` is a truncation whose current
 * `+++ b/f.txt` output is correct.
 *
 * Stops at the first `@@` like its sibling, so a body line cannot fake it.
 */
export function deletionMode(rawDiff: string): string | null {
  return headerMode(rawDiff, /^deleted file mode (\d{6})\s*$/)
}

/** Scans only the preamble of the first file's diff — up to the first `@@`. */
function headerMode(rawDiff: string, re: RegExp): string | null {
  for (const raw of rawDiff.split('\n')) {
    if (raw.startsWith('@@')) break
    const m = re.exec(raw)
    if (m) return m[1]
  }
  return null
}

/**
 * buildPartialPatch builds a unified-diff patch suitable for `git apply --cached`.
 * Only the changes in `include` (indices into `combined`) appear as actual
 * del/add operations. Unselected dels become context (HEAD-and-index still has
 * them); unselected adds are omitted (neither HEAD nor index has them).
 * Returns "" if there's nothing to stage.
 *
 * `header` carries what only the caller can know — see `PatchHeader`. Omit it
 * and the output is byte-for-byte what it has always been.
 */
export function buildPartialPatch(
  path: string,
  combined: Line[],
  include: Set<number>,
  header: PatchHeader = {},
): string {
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
  //
  // None of this needs to know about the creation or deletion headers below.
  // With every entry a '+', `oldLast` stays -1 and the sweep over `combined`
  // finds no Ctx/Del, so `headNoNewline` stays false and only the new side's
  // marker is emitted — exactly what a `--- /dev/null` old side requires. With
  // every entry a '-' it is the same story mirrored: `newLast` stays -1,
  // `postNoNewline` stays false, and only HEAD's marker survives, which is what
  // a `+++ /dev/null` new side requires and what git itself writes.
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
  // A file absent from HEAD needs git's creation form: `a/<path>` does not
  // exist for `git apply --cached` to read the preimage from, and it answers
  // the classic header with `does not exist in index`. The `oldCount === 0`
  // half is a safety net, not a second opinion — a creation diff cannot contain
  // ctx or del lines, so it never fires on its own. It only means a wrong
  // `createMode` degrades to today's behaviour instead of emitting a
  // `--- /dev/null` next to a `-` line, which would be a brand new failure mode.
  const creating = (header.createMode ?? null) !== null && oldCount === 0
  // The mirror image: the file is gone from the working tree AND the selection
  // covers every one of its lines, so nothing survives on the new side. Without
  // the deletion form git happily applies `+++ b/<path>` with `+1,0` and leaves
  // the EMPTY blob in the index — exit 0, no warning, wrong commit.
  //
  // `newCount === 0` is the load-bearing half here rather than a safety net: a
  // PARTIAL selection over a deleted file leaves the unselected dels as context,
  // so newCount > 0 and the classic header is still the right one (the file
  // shrinks in the index but stays there). It cannot collide with `creating` —
  // both would need `entries` to be empty, and that returns above.
  const deleting = (header.deleteMode ?? null) !== null && newCount === 0
  let buf = ''
  buf += `diff --git a/${path} b/${path}\n`
  if (creating) {
    buf += `new file mode ${header.createMode}\n`
    buf += `--- /dev/null\n`
    buf += `+++ b/${path}\n`
    // `-0,0` is what git itself writes for a creation. `-1,0` is accepted too
    // (git 2.51.2), but looking like git's own output is the cheapest way not
    // to trip over a stricter `apply`.
    buf += `@@ -0,0 +1,${newCount} @@\n`
  } else if (deleting) {
    // `deleted file mode` is not decoration. With `+++ /dev/null` alone git
    // still exits 0, removes the entry — and adds a bogus `dev/null` one
    // (`AD dev/null`, empty blob), which is worse than the bug being fixed.
    buf += `deleted file mode ${header.deleteMode}\n`
    buf += `--- a/${path}\n`
    buf += `+++ /dev/null\n`
    // `+0,0` is git's own form for a deletion, matching `-0,0` above.
    buf += `@@ -1,${oldCount} +0,0 @@\n`
  } else {
    buf += `--- a/${path}\n`
    buf += `+++ b/${path}\n`
    buf += `@@ -1,${oldCount} +1,${newCount} @@\n`
  }
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
 * hunkStarts returns the row indices that begin a run of changed rows.
 *
 * Note this is not git's notion of a hunk. refiner asks for `-U99999`, so git
 * reports the entire file as one hunk and the `@@` headers are dropped before
 * anything is cached. What a reviewer actually perceives as "a hunk" is a
 * contiguous block of added/removed lines surrounded by context, which is exactly
 * what this finds — and it works the same whichever view is active, because the
 * caller flattens its own rows down to "changed or not" first.
 */
export function hunkStarts(changed: boolean[]): number[] {
  const out: number[] = []
  for (let i = 0; i < changed.length; i++) {
    if (changed[i] && !changed[i - 1]) out.push(i)
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
