/**
 * Line-level and file-level staging.
 *
 * The patch handed to `git apply --cached` always describes the COMPLETE
 * desired staged set rather than a delta, because we reset the file's index to
 * HEAD first. That guarantees the patch's base always matches the index, so
 * applying can never fail from context drift left by an earlier partial stage.
 *
 * For a file with no blob in HEAD, "reset to HEAD" means REMOVING the index
 * entry, and that is a precondition rather than a convenience: the patch carries
 * a `new file mode` header, which `git apply --cached` refuses with `already
 * exists in index` if the entry is still there. So the unstage cannot move after
 * the apply, and it cannot be skipped as an optimisation when nothing looked
 * staged. Conversely the classic `--- a/<path>` header fails such a file with
 * `does not exist in index` — which is why the header shape comes from git's own
 * diff (`createMode`) instead of being assumed.
 *
 * The other end of the same rule: a file deleted in the working tree whose every
 * line is selected needs the `deleted file mode` header (`deleteMode`), or git
 * applies the patch happily and leaves an EMPTY blob in the index instead of
 * removing the entry. Reset-then-apply stays right there too — the restore puts
 * HEAD's entry back and the patch removes it again, so repeating is idempotent,
 * and an empty desired set means the restore alone, leaving the file staged as
 * unmodified (` D`).
 *
 * Every entry point here is split in two. The SYNCHRONOUS half runs inside the
 * key dispatch: resolve the cursor to unified indices, decide the direction,
 * record the desired set in `app.stagingIntent`, queue a job. The ASYNCHRONOUS
 * half is a serial queue that talks to git, one operation at a time. All three
 * properties are load-bearing:
 *
 *   - Synchronous, because `preventDefault()` only counts during the dispatch
 *     (`src/dispatch.ts`) and because the cursor has usually moved on by the
 *     time git answers — deferring the *decision* would stage the wrong line.
 *   - Serial, because `unstageFile` + `applyPatchToIndex` is a two-command
 *     sequence that assumes nobody touches the index in between. Two in flight
 *     interleave as unstage₁, unstage₂, apply₂, apply₁ and either lose a line or
 *     fail outright.
 *   - Intent-based, because `app.staged` is git's answer to the PREVIOUS press
 *     and arrives a reload late. A second press building its patch from it would
 *     describe the first press's line as unstaged and drop it — silently, since
 *     that patch applies perfectly well.
 *
 * The reset-then-apply invariant is also what makes the queue safe to coalesce:
 * a job describes the whole desired set, so a newer job for a path simply
 * replaces the pending one and a burst of N presses costs one or two git
 * operations instead of N.
 */

import { App, isStageable, ViewMode, type StagingJob } from './app.ts'
import { buildPartialPatch, LineKind, RowKind } from './diff.ts'
import {
  applyPatchToIndex,
  isChanged,
  Mode,
  stageFile,
  unstageFile,
  type ChangedFile,
} from './git.ts'

/**
 * toggleStaged stages or unstages the add/del lines under the cursor (or the
 * whole shift-selection). Direction is decided by the current state: if every
 * targeted line is already staged, unstage them; otherwise stage them all.
 *
 * Returns as soon as the intent is recorded; the git work happens on the queue.
 */
export function toggleStaged(app: App): void {
  if (app.source.mode !== Mode.Uncommitted || app.selectedPath === '') return
  const cached = app.cache.get(app.selectedPath)
  if (!cached) return
  const file = app.findFile(app.selectedPath)
  if (!file) return

  let [start, end] = app.selectionRange()

  // Map the selection to unified indices. Split rows go through
  // oldSrcIdx/newSrcIdx; current rows through cached.currentIdx.
  const targets = new Set<number>()
  switch (app.effectiveViewMode()) {
    case ViewMode.Split: {
      end = Math.min(end, cached.split.length - 1)
      for (let i = start; i <= end; i++) {
        const r = cached.split[i]
        if (!r) continue
        if ((r.kind === RowKind.Del || r.kind === RowKind.Mod) && r.oldSrcIdx >= 0) {
          targets.add(r.oldSrcIdx)
        }
        if ((r.kind === RowKind.Add || r.kind === RowKind.Mod) && r.newSrcIdx >= 0) {
          targets.add(r.newSrcIdx)
        }
      }
      break
    }
    case ViewMode.Current: {
      end = Math.min(end, cached.current.length - 1)
      for (let i = start; i <= end; i++) {
        // Only add lines are visible in current view — ctx is not stageable.
        if (cached.current[i]?.kind === LineKind.Add) targets.add(cached.currentIdx[i])
      }
      break
    }
    default: {
      end = Math.min(end, cached.unified.length - 1)
      for (let i = start; i <= end; i++) {
        const l = cached.unified[i]
        if (l && isStageable(l.kind)) targets.add(i)
      }
      break
    }
  }
  if (targets.size === 0) return

  // A file with no blob in HEAD needs the creation form of the patch header, and
  // the mode for it comes from git's own diff — see `creationMode` in
  // `src/diff.ts`. Both branches of `loadDiff` supply it (`git diff HEAD` for an
  // `A`/`AM` file, `--no-index` for a `?` one), so on the normal path partial
  // staging works for those too, including the new half of a rename.
  //
  // This is the safety net for when it somehow did not: without the mode there
  // is no patch git will accept, and `resetAndApply` unstages FIRST, so pressing
  // on would empty the file's index entry and then fail. Staging the whole file
  // is the lesser wrong. It has to read `indexCode`, not `status`: `parsePorcelain`
  // prefers the tree column, so an added-then-edited file (`AM`) has `status ===
  // 'M'` while still being absent from HEAD.
  const createMode = cached.createMode
  if (createMode === null && (file.status === '?' || file.indexCode === 'A')) {
    toggleFullStage(app, file)
    return
  }

  // The base is what we last ASKED for, not what git last reported — see the
  // header. Without that, two presses inside one reload both start from the same
  // set and the second one's patch un-stages the first one's line.
  const stagedSet = app.stagedFor(app.selectedPath)
  let allStaged = true
  for (const idx of targets) {
    if (!stagedSet.has(idx)) {
      allStaged = false
      break
    }
  }

  const desired = new Set(stagedSet)
  if (allStaged) for (const idx of targets) desired.delete(idx)
  else for (const idx of targets) desired.add(idx)

  app.stagingIntent.set(app.selectedPath, desired)
  // A line-level job supersedes a whole-file one: they describe the same file in
  // mutually exclusive terms.
  app.stagingFullIntent.delete(app.selectedPath)
  enqueue(app, {
    kind: 'partial',
    path: app.selectedPath,
    file,
    desired,
    unified: cached.unified,
    createMode,
    // Only used when `desired` covers every line of a deleted file; see
    // `deletionMode` in `src/diff.ts`. No guard beside `createMode`'s: a missing
    // mode here degrades to today's behaviour (an empty blob in the index)
    // rather than to a rejected patch on top of an already-reset entry.
    deleteMode: cached.deleteMode,
  })
}

/**
 * toggleFullStage stages or unstages every change in a file. Auto-decides the
 * direction: if any line is already staged it unstages, otherwise it stages.
 *
 * Synchronous like `toggleStaged`, and for the same reasons.
 */
export function toggleFullStage(app: App, file: ChangedFile): void {
  if (app.source.mode !== Mode.Uncommitted) return
  // ALL mode lists files with nothing to stage; git would no-op, but the reload it
  // triggers would still throw away every cached diff for nothing.
  if (!isChanged(file)) return

  // Porcelain's index column (X) already means "the index differs from HEAD",
  // which is exactly the question the original asked by loading and scanning both
  // diffs. Reading it here saves two git invocations per keypress and works even
  // when the file's diff was never opened. Untracked files read as "not staged"
  // (X='?'), so the first press adds them; once added porcelain reports 'A' and
  // the general rule takes over.
  //
  // The pending intent wins when there is one: with only `file.indexCode` to go
  // on, two presses inside one reload would both read the same stale porcelain,
  // both decide "stage", and the toggle would lose its parity.
  const want = !(app.stagingFullIntent.get(file.path) ?? hasStagedChanges(file))
  app.stagingFullIntent.set(file.path, want)
  // Keep the line-level intent in step, so the panel paints the whole file at
  // once and a follow-up line toggle builds on what we just asked for.
  const cached = app.cache.get(file.path)
  if (cached) {
    const lines = new Set<number>()
    if (want) {
      for (let i = 0; i < cached.unified.length; i++) {
        if (isStageable(cached.unified[i].kind)) lines.add(i)
      }
    }
    app.stagingIntent.set(file.path, lines)
  } else {
    app.stagingIntent.delete(file.path)
  }
  enqueue(app, { kind: 'full', path: file.path, file, want })
}

// ------------------------------------------------------------- the serial queue

/**
 * enqueue records a job and makes sure the drain is running. At most one job per
 * path is pending — a newer one replaces it, which is safe because a job carries
 * the complete desired state rather than a delta.
 */
function enqueue(app: App, job: StagingJob): void {
  app.stagingPending.set(job.path, job)
  // The drain cannot finish before this assignment: the map is non-empty, so its
  // first act is to await a job.
  if (app.stagingRunning === null) app.stagingRunning = drain(app)
}

/**
 * drain runs queued jobs one at a time until the queue is empty.
 *
 * A job is removed from the pending map BEFORE it runs, so a keypress arriving
 * while git is busy creates a fresh entry instead of mutating the one in flight.
 */
async function drain(app: App): Promise<void> {
  try {
    for (;;) {
      const job = takeNext(app)
      if (!job) break
      try {
        await runJob(app, job)
      } catch (err) {
        // The runners record git's own failures; this is for a bug in ours.
        // A thrown job must never take the queue down with it.
        app.err = err as Error
      }
    }
  } finally {
    // Hand painting back to git's answer, which the last job's reload just
    // refreshed — including on the error path, where the truth is the point.
    // In `finally` because an intent left behind would paint lines as staged
    // that git never received, for the rest of the session.
    for (const path of [...app.stagingIntent.keys()]) {
      if (!app.stagingPending.has(path)) app.stagingIntent.delete(path)
    }
    for (const path of [...app.stagingFullIntent.keys()]) {
      if (!app.stagingPending.has(path)) app.stagingFullIntent.delete(path)
    }
    app.stagingRunning = null
    app.render()
  }
}

/** Oldest pending job, removed from the map. Insertion order, so FIFO by path. */
function takeNext(app: App): StagingJob | null {
  for (const [path, job] of app.stagingPending) {
    app.stagingPending.delete(path)
    return job
  }
  return null
}

async function runJob(app: App, job: StagingJob): Promise<void> {
  if (job.kind === 'full') {
    await applyFullStage(app, job.file, job.want)
    return
  }
  // The patch is built here rather than in the key handler for two reasons: the
  // keypress pays no CPU proportional to the file's size, and a job the queue
  // coalesces away never builds one at all.
  //
  // Holding `unified` across the wait is safe. It comes from `git diff HEAD` —
  // working tree against HEAD, independent of the index — so staging cannot
  // renumber it, and every reload builds a fresh array rather than mutating this
  // one.
  await resetAndApply(
    app,
    job.file,
    buildPartialPatch(job.path, job.unified, job.desired, {
      createMode: job.createMode,
      deleteMode: job.deleteMode,
    }),
  )
}

/**
 * resetAndApply resets the file's index entry to HEAD, then applies the patch
 * describing the desired staged set. See the note at the top of this file for
 * why it is done in that order.
 */
async function resetAndApply(app: App, file: ChangedFile, patch: string): Promise<void> {
  try {
    // Best effort: a no-op when nothing was staged.
    await unstageFile(file.path).catch(() => {})
    if (patch !== '') await applyPatchToIndex(patch)
    app.err = null
  } catch (err) {
    app.err = err as Error
  }
  await settle(app, file.path)
}

/** The whole-file half: `git add` or `git restore --staged`, direction decided. */
async function applyFullStage(app: App, file: ChangedFile, want: boolean): Promise<void> {
  try {
    if (want) await stageFile(file.path)
    else await unstageFile(file.path)
    app.err = null
  } catch (err) {
    app.err = err as Error
  }
  await settle(app, file.path)
}

/**
 * settle re-reads what the write changed. Skipped while more jobs are waiting:
 * each job carries its own file and its own diff and depends on nothing the
 * reload produces, so a burst pays for one reload instead of one per press.
 */
async function settle(app: App, path: string): Promise<void> {
  app.invalidateStagedDiff(path)
  if (app.stagingPending.size > 0) return
  await app.loadFiles()
}

function hasStagedChanges(file: ChangedFile): boolean {
  return file.indexCode !== ' ' && file.indexCode !== '?' && file.indexCode !== ''
}
