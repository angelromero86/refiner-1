/**
 * Live reload: notice when something outside refiner changes the review, and pick
 * it up without the user pressing `r`.
 *
 * Two things are watched, both cheap because they are single well-known paths:
 *
 *   .refiner/  → an agent or the VSCode extension writing a thread
 *   .git/      → `index` and `HEAD`, i.e. staging, unstaging, commits, checkouts
 *
 * Deliberately NOT watched: the working tree itself. Doing that means recursively
 * watching the repo, which on a few hundred files is a lot of handles for something
 * `r` already does on demand. In practice the gap barely shows: an agent that edits
 * code also replies in its thread, and that write is watched.
 *
 * Everything here degrades to nothing. If fs.watch isn't available on the
 * filesystem, refiner behaves exactly as it did before — `r` still works.
 */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { App } from './app.ts'

/** Collapse a burst of events — an atomic replace fires several — into one reload. */
const DEBOUNCE_MS = 120

/**
 * How long to wait before retrying while an overlay is open. Refreshing under a
 * half-written comment would be hostile, and the thread indices the modal holds
 * could shift beneath it.
 */
const BUSY_RETRY_MS = 400

export function installWatchers(app: App, repoRoot: string): () => void {
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const reload = (): void => {
    timer = null
    if (overlayOpen(app)) {
      // Try again shortly rather than dropping the event on the floor.
      timer = setTimeout(reload, BUSY_RETRY_MS)
      return
    }
    void app.refresh()
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(reload, DEBOUNCE_MS)
  }

  /**
   * The store write we are seeing may be our own. Compare the file against the text
   * save() last produced and ignore an exact match; anything else is somebody else's
   * edit and worth reloading for.
   */
  const onStoreEvent = (): void => {
    const expected = app.store.lastWrittenText
    if (expected === null) {
      schedule()
      return
    }
    void Bun.file(join(repoRoot, '.refiner', 'comments.json'))
      .text()
      .then((text) => {
        if (text !== expected) schedule()
      })
      .catch(() => schedule()) // deleted or unreadable — let the reload surface it
  }

  const add = (path: string, handler: (file: string | null) => void): void => {
    try {
      const w = watch(path, (_event, filename) => handler(filename))
      // A watch dying must never take the app with it.
      w.on('error', () => {})
      watchers.push(w)
    } catch {
      // Path missing or unwatchable: skip it, keep the others.
    }
  }

  // `.refiner/` rather than the file itself: both we and the extension write by
  // atomic replace, which swaps the inode and would silently orphan a file watch.
  add(join(repoRoot, '.refiner'), (file) => {
    if (file === null || file === 'comments.json') onStoreEvent()
  })

  // The repo root catches `.refiner/` being created later, on the first thread.
  add(repoRoot, (file) => {
    if (file === '.refiner') {
      add(join(repoRoot, '.refiner'), (f) => {
        if (f === null || f === 'comments.json') onStoreEvent()
      })
      schedule()
    }
  })

  add(join(repoRoot, '.git'), (file) => {
    // `index` covers add/reset/commit; HEAD covers checkout. Ignore the rest —
    // .git is busy with lock files and object writes we don't care about.
    if (file === 'index' || file === 'HEAD') schedule()
  })

  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}

/** True while something modal owns the screen. */
function overlayOpen(app: App): boolean {
  return (
    app.modal !== null ||
    app.threadList !== null ||
    app.finder !== null ||
    app.help !== null ||
    app.quitConfirm
  )
}
