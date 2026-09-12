/**
 * Drift tracking: re-anchor every thread to the working tree it is looking at.
 *
 * A thread's `range` is a pair of line numbers and nothing keeps them true —
 * the reviewer edits, an agent applies a fix, and the thread sits under the
 * wrong code. So on every load (`App.loadFiles`, so startup and every refresh)
 * and after every per-file diff load, the threads of each file are matched
 * against the file's current content by `src/anchor.ts`:
 *
 *   - a thread without an `anchor` gets one captured from where it sits now
 *     (the backfill; the same thing the VSCode extension does the first time
 *     it sees a thread in an open document);
 *   - a thread with one is relocated, and a `moved` result with a different
 *     range is written back through `Store.setRange`.
 *
 * Both are persisted with one `save()` per pass, and the outcome lands in
 * `App.drift`, keyed by thread id, so the UI can flag a `lost` thread and say
 * where a `moved` one came from. `from` — the range the thread had before this
 * session moved it — lives in memory only: on disk the corrected range IS the
 * thread's range, and the extension keeps no such history either. It is sticky
 * for the life of a store instance (a later pass finding the thread `exact` at
 * its corrected position must not erase the notice that it moved), and starts
 * over when `App.refresh()` loads a fresh store, whose ranges are then the new
 * baseline.
 *
 * The pass follows the load-generation rule from `src/app.ts`: it captures
 * `loadGen` and the store on its first line, does all its reading, and only
 * then — under one guard — writes anything. A relocation computed from a file
 * the external editor has since rewritten, or against a store `refresh()` has
 * since replaced, is discarded whole.
 */

import { captureAnchor, relocate, splitLines } from './anchor.ts'
import type { App } from './app.ts'
import type { Anchor } from './comments.ts'
import { persistStore } from './threads-ui.ts'

export type DriftStatus = 'exact' | 'moved' | 'lost'

export interface Drift {
  status: DriftStatus
  /** The thread's range before this session relocated it; equals the range when `exact`. */
  from: { start: number; end: number }
}

/**
 * relocateThreads re-anchors the threads of `paths` — every file with a thread
 * when omitted — and persists what changed. Never rejects.
 */
export async function relocateThreads(app: App, paths?: string[]): Promise<void> {
  const gen = app.loadGeneration()
  const store = app.store
  const files = paths ?? [...new Set(store.threads.map((t) => t.file))]
  if (files.length === 0 && paths === undefined) {
    // Nothing to relocate, but a fresh store still resets the baseline.
    settleBaseline(app, store)
    return
  }

  // All the reading first, with nothing written in between.
  const contents = await Promise.all(files.map(readLines))
  if (gen !== app.loadGeneration() || store !== app.store) return

  settleBaseline(app, store)
  let changed = false
  let driftChanged = false
  files.forEach((path, i) => {
    const lines = contents[i]
    for (const t of store.threadsForFile(path)) {
      const prior = app.drift.get(t.id)
      const from = prior?.from ?? { start: t.range.start, end: t.range.end }
      let status: DriftStatus
      if (lines === null) {
        status = 'lost'
      } else if (!t.anchor) {
        const anchor = captureAnchor(lines, t.range.start, t.range.end)
        // A range past the end of the file has no text to snapshot; an empty
        // anchor would only make the thread permanently unfindable. Leave it
        // for a later pass — the file may grow back — and flag it.
        if (anchor.lines.length === 0) {
          status = 'lost'
        } else {
          store.setAnchor(t.id, anchor)
          changed = true
          status = 'exact'
        }
      } else {
        const res = relocate(lines, t.anchor, t.range.start)
        if (res.status === 'lost') {
          status = 'lost'
        } else {
          if (res.start !== t.range.start || res.end !== t.range.end) {
            store.setRange(t.id, res.start, res.end)
            changed = true
          }
          status = 'exact'
        }
      }
      // Relative to the baseline, not to this pass: a thread found exactly where
      // the previous pass put it has still moved from where the file said.
      if (status === 'exact' && (from.start !== t.range.start || from.end !== t.range.end)) {
        status = 'moved'
      }
      if (!prior || prior.status !== status) driftChanged = true
      app.drift.set(t.id, { status, from })
    }
  })

  if (paths === undefined) {
    // A full pass is the moment to forget threads that no longer exist.
    for (const id of app.drift.keys()) {
      if (store.indexOfThread(id) < 0) app.drift.delete(id)
    }
  }

  // A read-only store keeps the corrected view in memory and nothing else: the
  // refusal is `save()`'s, and it is already on the header.
  if (changed && store.writeBlocked() === null) await persistStore(app, { quiet: true })
  if (changed || driftChanged) app.render()
}

/**
 * The drift map describes one store instance. `refresh()` replaces the store
 * with a fresh read of the file, whose ranges are the new baseline for `from`.
 */
function settleBaseline(app: App, store: App['store']): void {
  if (app.driftStore === store) return
  app.driftStore = store
  app.drift.clear()
}

/**
 * The file's lines, or null when it cannot be read — gone from the working
 * tree, or unreadable — in which case every thread on it is lost. Same
 * resolution rule as everywhere else: `path` is root-relative and `Bun.file`
 * resolves against the cwd, which `main()` put at the repo root.
 */
async function readLines(path: string): Promise<string[] | null> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    return splitLines(await file.text())
  } catch {
    return null
  }
}

/**
 * The snapshot for a thread being created over `start`-`end` of a file whose
 * working-tree text is `text` — undefined when there is nothing to snapshot,
 * so the key stays absent and a later pass backfills it.
 */
export function anchorFor(text: string | null, start: number, end: number): Anchor | undefined {
  if (text === null) return undefined
  const anchor = captureAnchor(splitLines(text), start, end)
  return anchor.lines.length === 0 ? undefined : anchor
}
