/**
 * Live reload: notice when something outside refiner changes the review, and pick
 * it up without the user pressing `r`.
 *
 * Three things are watched:
 *
 *   the working tree → somebody (usually an agent) editing the code under review
 *   .refiner/        → an agent or the VSCode extension writing a thread
 *   .git/            → `index` and `HEAD`: staging, unstaging, commits, checkouts
 *
 * The working tree needs a recursive watch, and a recursive watch over a repo would
 * drown in `node_modules` — so which paths to skip is decided by **git**, not by a
 * hand-written denylist: `git ls-files --others --directory --ignored` returns the
 * collapsed set of ignored paths, honouring whatever the user's `.gitignore` actually
 * says. Without that filter a `bun install` would trigger a refresh storm.
 *
 * `.git/` is excluded from the recursive watch and handled by its own watcher: git
 * churns through lock files and loose objects constantly, and only `index` and `HEAD`
 * mean anything to us.
 *
 * Everything here degrades to nothing. If fs.watch isn't available — or recursive
 * watching hits a per-directory limit, which is a real risk on Linux with a huge
 * tree — refiner behaves exactly as it did before: `r` still refreshes on demand.
 */

import { watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import type { App } from './app.ts'

/** Where the store lives, relative to the repo root, in recursive-event form. */
const STORE_REL = '.refiner/comments.json'

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
  /**
   * Ignored path prefixes, as git reports them. Empty until the lookup returns, so
   * the first moments after startup may let a `node_modules` event through — one
   * spurious refresh, against blocking startup on a git call.
   */
  let ignored: string[] = []

  const reload = (): void => {
    timer = null
    // `isWriting()` as well as the overlay: `refresh()` REPLACES `app.store`,
    // and doing that under a save that is still merging would throw away the
    // very edits it is in the middle of persisting. Deliberately not
    // `hasPendingWrites()` — a store whose save was refused keeps its edits
    // forever, and waiting for those would block the refresh that repairs it.
    if (overlayOpen(app) || app.store.isWriting()) {
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
   * The store write we are seeing may be our own. Compare the file against the
   * text the store is synced with and ignore an exact match; anything else is
   * somebody else's edit and worth reloading for.
   *
   * The witness and the write counter are captured SYNCHRONOUSLY, before the read
   * — `app.refresh()` swaps `app.store` for a different object, and comparing
   * against a store we didn't compare with would mean nothing.
   */
  const onStoreEvent = (): void => {
    const store = app.store
    const expected = store.lastSyncedText
    const seqAtEvent = store.writeSeq
    if (expected === null) {
      schedule()
      return
    }
    void Bun.file(join(repoRoot, '.refiner', 'comments.json'))
      .text()
      .then((text) => {
        if (shouldReload({ text, expected, seqAtEvent, seqNow: store.writeSeq })) schedule()
      })
      .catch(() => schedule()) // deleted or unreadable — let the reload surface it
  }

  const add = (
    path: string,
    handler: (file: string | null) => void,
    recursive = false,
  ): void => {
    try {
      const w = watch(path, { recursive }, (_event, filename) => handler(filename))
      // A watch dying must never take the app with it.
      w.on('error', () => {})
      watchers.push(w)
    } catch {
      // Path missing or unwatchable: skip it, keep the others. A recursive watch
      // is the one most likely to fail (inotify limits on a huge tree), and losing
      // it costs only the automatic pickup of working-tree edits.
    }
  }

  /** Normalize a recursive event's path so prefix comparisons behave on any OS. */
  const rel = (file: string): string => file.split(sep).join('/')

  /**
   * One recursive watch over the whole repo covers the working tree AND the store —
   * including `.refiner/` being created later, on the very first thread.
   *
   * The store is deliberately matched by path rather than by watching the directory:
   * both we and the extension replace the file by rename, which swaps the inode and
   * would orphan a watch bound to it. A rename arrives here as an event on the
   * destination name, which is what we compare against.
   */
  add(
    repoRoot,
    (file) => {
      // A null filename means "something changed but we don't know what". Treat it
      // as a working-tree change: the reload is what decides whether anything moved.
      if (file === null) {
        schedule()
        return
      }
      switch (classify(rel(file), ignored)) {
        case 'store':
          onStoreEvent()
          return
        case 'worktree':
          schedule()
          return
        default:
          return
      }
    },
    true,
  )

  add(join(repoRoot, '.git'), (file) => {
    // `index` covers add/reset/commit; HEAD covers checkout. Ignore the rest —
    // .git is busy with lock files and object writes we don't care about.
    if (file === 'index' || file === 'HEAD') schedule()
  })

  // Fire and forget: the watch is already live, and an event arriving before the
  // list does costs one spurious refresh, not a missed one.
  void ignoredPrefixes().then((list) => {
    ignored = list
  })

  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}

/** What an event on a repo-relative path means to us. */
export type EventKind = 'store' | 'worktree' | 'ignore'

/**
 * classify decides what a recursive-watch event is worth.
 *
 * Pure and exported because it is the whole of the noise filter, and both failure
 * directions are expensive: too eager and an agent's edit never shows up; too lax and
 * a `bun install` triggers a refresh per file written.
 *
 * `ignored` is git's own collapsed ignore list — see `ignoredPrefixes()`. Prefix
 * matching is on `<prefix>/` boundaries so `dist/` never swallows `dist-notes.md`,
 * which is exactly the kind of near-miss a hand-rolled filter gets wrong.
 */
export function classify(path: string, ignored: readonly string[]): EventKind {
  // git's own directory churns through locks and loose objects constantly; `index`
  // and `HEAD` are meaningful and have their own dedicated watcher.
  if (path === '.git' || path.startsWith('.git/')) return 'ignore'

  if (path === STORE_REL) return 'store'
  // Our own temp file, caught mid-rename. Never a reason to reload.
  if (path.startsWith(STORE_REL + '.')) return 'ignore'

  for (const raw of ignored) {
    const prefix = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (prefix === '') continue
    if (path === prefix || path.startsWith(prefix + '/')) return 'ignore'
  }
  return 'worktree'
}

/**
 * The paths git ignores, collapsed to directories, as prefixes to skip.
 *
 * Asking git rather than keeping a denylist means the filter honours whatever this
 * repo's `.gitignore` actually says — `node_modules/`, `dist/`, a bespoke `data/` —
 * without refiner having to guess. `--directory` collapses an ignored tree to its
 * root, so the list stays a handful of entries instead of one per file.
 *
 * Computed once. A directory that becomes ignored later leaks through until the next
 * launch, costing spurious refreshes and nothing worse.
 */
async function ignoredPrefixes(): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ['git', 'ls-files', '--others', '--directory', '--ignored', '--exclude-standard'],
      { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
    )
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return []
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
  } catch {
    return []
  }
}

/**
 * Should an event that carried `text` be turned into a reload?
 *
 * Pure, and exported, because it is the whole of the echo-suppression rule and
 * getting it wrong is expensive in both directions: suppress too eagerly and a
 * thread written by somebody else never appears; suppress too little and every
 * keystroke triggers a full `refresh()` (git status plus every diff) under the
 * user's cursor.
 *
 * The rule: suppress ONLY when the file matches the text we are synced with AND
 * no write of ours completed while we were reading. Without the second half, a
 * write of ours landing during the read makes the file match a witness that
 * describes a different moment, and the external event that woke us — the one
 * whose data we may have just flattened — is discarded. A reload too many is a
 * flicker; one too few is data the reviewer never sees.
 */
export function shouldReload(o: {
  /** The file's contents at the moment we read it, or null if unreadable. */
  text: string | null
  /** `Store.lastSyncedText`, captured when the event arrived. */
  expected: string | null
  /** `Store.writeSeq`, captured when the event arrived. */
  seqAtEvent: number
  /** `Store.writeSeq` now, after the read. */
  seqNow: number
}): boolean {
  if (o.expected === null || o.text === null) return true
  if (o.seqNow !== o.seqAtEvent) return true
  return o.text !== o.expected
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
