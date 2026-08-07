/**
 * Line-level and file-level staging.
 *
 * The patch handed to `git apply --cached` always describes the COMPLETE
 * desired staged set rather than a delta, because we reset the file's index to
 * HEAD first. That guarantees the patch's base always matches the index, so
 * applying can never fail from context drift left by an earlier partial stage.
 */

import { App, isStageable, ViewMode } from './app.ts'
import { buildPartialPatch, LineKind, RowKind } from './diff.ts'
import {
  applyPatchToIndex,
  Mode,
  stageFile,
  unstageFile,
  type ChangedFile,
} from './git.ts'

/**
 * toggleStaged stages or unstages the add/del lines under the cursor (or the
 * whole shift-selection). Direction is decided by the current state: if every
 * targeted line is already staged, unstage them; otherwise stage them all.
 */
export async function toggleStaged(app: App): Promise<void> {
  if (app.source.mode !== Mode.Uncommitted || app.selectedPath === '') return
  const cached = app.cache.get(app.selectedPath)
  if (!cached) return
  const file = app.findFile(app.selectedPath)
  if (!file) return

  let [start, end] = app.selectionRange()

  // Map the selection to unified indices. Split rows go through
  // oldSrcIdx/newSrcIdx; current rows through cached.currentIdx.
  const targets = new Set<number>()
  switch (app.viewMode) {
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

  // Untracked files have no HEAD blob, so partial patching is fragile. Fall back
  // to staging or unstaging the whole file.
  if (file.status === '?') {
    await toggleFullStage(app, file)
    return
  }

  const stagedSet = app.staged.get(app.selectedPath) ?? new Set<number>()
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

  const patch = buildPartialPatch(app.selectedPath, cached.unified, desired)
  await resetAndApply(app, file, patch)
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
  app.clearCaches()
  await app.loadFiles()
}

/**
 * toggleFullStage stages or unstages every change in a file. Auto-decides the
 * direction: if any line is already staged it unstages, otherwise it stages.
 */
export async function toggleFullStage(app: App, file: ChangedFile): Promise<void> {
  if (app.source.mode !== Mode.Uncommitted) return
  try {
    // Untracked files aren't in the index at all, so `git add` is the only
    // meaningful direction until they are — and once added, porcelain reports
    // them as 'A' rather than '?', so this branch stops applying.
    //
    // For everything else, porcelain's index column (X) already means "the index
    // differs from HEAD", which is exactly the question the original asked by
    // loading and scanning both diffs. Reading it here saves two git invocations
    // per keypress and works even when the file's diff was never opened.
    if (file.status === '?') await stageFile(file.path)
    else if (hasStagedChanges(file)) await unstageFile(file.path)
    else await stageFile(file.path)
    app.err = null
  } catch (err) {
    app.err = err as Error
  }
  app.clearCaches()
  await app.loadFiles()
}

function hasStagedChanges(file: ChangedFile): boolean {
  return file.indexCode !== ' ' && file.indexCode !== '?' && file.indexCode !== ''
}
