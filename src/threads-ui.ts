/**
 * Review threads in the diff pane: the keys that act on a card, the inline
 * compose block, `n`/`N`, and the all-threads list (`c`).
 *
 * There is no thread modal. A thread is a card in the row stream
 * (`src/rows.ts`, `src/card.ts`); the cursor walks onto it and the card's own
 * keys take over — `enter` expands it, `r` replies, `e` edits, `x` resolves,
 * `D` deletes. Writing happens in a textarea spliced into the pane right under
 * the card (or under the anchor line for a new thread), and while it is open
 * only `esc` and the save chords are ours; everything else is typing.
 *
 * Every mutation saves the store immediately. That matters because the file is
 * shared with the VSCode extension and with agents: a reply that only existed in
 * memory would be invisible to them, and would be lost the moment the reviewer
 * pressed `r`. And every mutation goes through `App.withStableCursor`, because
 * it changes the rows under the cursor.
 */

import { readFileSync, statSync } from 'node:fs'
import { App, ViewMode, type Compose } from './app.ts'
import { Store } from './comments.ts'
import type { SaveReport, StoredThread } from './comments.ts'
import { anchorFor } from './relocate.ts'

/**
 * threadsWritable gates the paths that mutate the store, and explains itself in
 * the banner when it says no.
 *
 * The real defence is in `Store.save()` — any future caller gets it for free —
 * but refusing up front is what makes the refusal honest: without it the
 * reviewer types a whole comment, `save()` rejects asynchronously, and the pane
 * shows a comment that exists only in memory.
 *
 * Synchronous and I/O-free, because it is called from key dispatch (see
 * CLAUDE.md, "Global key handlers … only synchronously"). Reading threads is
 * never gated: a store poisoned by `refresh()` still holds the reviewer's
 * threads and they must stay readable.
 */
function threadsWritable(app: App): boolean {
  const blocked = app.store.writeBlocked()
  if (blocked === null) return true
  app.err = blocked
  app.render()
  return false
}

// ------------------------------------------------------------------ compose

/**
 * openCompose splices the block in and scrolls it fully into view, with the
 * content cursor parked on its first row — where it stays until the block
 * closes, since the keys go to the widget meanwhile.
 */
function openCompose(app: App, compose: Compose, initial: string): void {
  app.compose = compose
  app.threadsEpoch++
  app.inputs.setComposeValue(initial)
  app.selectionAnchor = -1
  const layout = app.activeLayout()
  const start = layout.composeStart
  if (start < 0) return
  const row = layout.rows[start]
  const lines = row?.kind === 'compose' ? row.lines : 1
  // Reveal the whole block: visible at its last row first, then the cursor
  // goes back to the first, which ensureCursorVisible leaves alone if it fits.
  app.contentCursor = start + lines - 1
  app.ensureCursorVisible()
  app.contentCursor = start
  app.ensureCursorVisible()
}

/**
 * closeCompose drops the block and puts the cursor where the reviewer was
 * working: the card's header for a reply or an edit, the anchor's last row for
 * a new thread that was abandoned.
 */
export function closeCompose(app: App): void {
  const c = app.compose
  if (!c) return
  const line = c.kind === 'new' ? c.end : 0
  app.compose = null
  app.threadsEpoch++
  app.inputs.setComposeValue('')
  if (c.threadId !== '') {
    const start = app.cardStartOf(c.threadId)
    if (start >= 0) app.contentCursor = start
  } else if (line > 0) {
    app.pendingNavLine = line
    app.navigateToPendingLine()
  }
  app.clampCursor()
  app.ensureCursorVisible()
}

/**
 * handleComposeKey claims only what must not reach the textarea: `esc` cancels
 * and the three save chords commit. Anything else returns false and falls
 * through to the widget — that is how typing works. Synchronous on purpose:
 * the caller has to call preventDefault() during the event dispatch.
 */
export function handleComposeKey(app: App, key: string): boolean {
  if (!app.compose) return false
  switch (key) {
    case 'esc':
      closeCompose(app)
      return true
    // Three accepted save keys. alt+enter is the advertised primary (it works
    // in zellij and wherever ctrl chords are taken); alt+s is the mnemonic
    // fallback; ctrl+s is kept for muscle memory.
    case 'alt+enter':
    case 'alt+s':
    case 'ctrl+s':
      submitCompose(app)
      return true
    default:
      return false
  }
}

/**
 * submitCompose commits the text field:
 *
 *   edit   → update the comment body in place
 *   reply  → append a comment to the thread
 *   new    → create the thread with this as its first comment
 *
 * Then the block closes, the thread is expanded and the cursor lands on its
 * header.
 */
export function submitCompose(app: App): void {
  const c = app.compose
  if (!c) return
  const body = app.inputs.composeValue().trim()
  if (body === '') return
  // The compose box should not have opened at all in this state, but this is the
  // commit point and the text is still in the widget: refusing here keeps it
  // there to be copied out, instead of moving it into a store that cannot be
  // written and calling it saved.
  if (!threadsWritable(app)) return

  let threadId = c.threadId
  switch (c.kind) {
    case 'edit': {
      const t = threadById(app, c.threadId)
      const idx = t ? t.comments.findIndex((x) => x.id === c.commentId) : -1
      if (!t || idx < 0) {
        // The comment went away under us — another client deleted it and a
        // merge re-anchored past it. Say so and keep the text where the
        // reviewer can still copy it, rather than throwing out of a key
        // handler.
        app.err = new Error(
          'the comment you were editing is no longer in the file; another client deleted it',
        )
        app.render()
        return
      }
      app.store.setCommentBody(t.id, idx, body)
      break
    }
    case 'reply': {
      const t = threadById(app, c.threadId)
      if (!t) {
        app.err = new Error('the thread you were replying to is no longer in the file')
        app.render()
        return
      }
      app.store.appendComment(t.id, { author: app.author, body, role: 'user' })
      break
    }
    default: {
      const t = app.store.addThread(
        c.file,
        c.start,
        c.end,
        { author: app.author, body, role: 'user' },
        anchorFor(readWorkingTree(c.file), c.start, c.end),
      )
      threadId = t.id
      break
    }
  }

  save(app)
  app.compose = null
  app.inputs.setComposeValue('')
  app.expandedThreads.add(threadId)
  app.threadsEpoch++
  const start = app.cardStartOf(threadId)
  if (start >= 0) app.contentCursor = start
  app.selectionAnchor = -1
  app.clampCursor()
  app.ensureCursorVisible()
}

function threadById(app: App, id: string): StoredThread | null {
  const i = app.store.indexOfThread(id)
  return i >= 0 ? app.store.threads[i] : null
}

// -------------------------------------------------------------------- keys

/**
 * openOrCreateThread is bound to Enter on a DIFF row. A line that already has
 * a thread takes the cursor to that card and expands it — not into compose;
 * otherwise compose opens for a new thread over the selection's working-tree
 * line range. Does nothing when the selection covers only deleted lines, since
 * there is no working-tree line to anchor to.
 */
export function openOrCreateThread(app: App): void {
  if (app.selectedPath === '') return
  const cached = app.cache.get(app.selectedPath)
  if (!cached) return

  const cursorLine = app.cursorLine()
  if (cursorLine > 0) {
    const existing = app.store.threadAt(app.selectedPath, cursorLine)
    if (existing) {
      app.expandedThreads.add(existing.id)
      app.threadsEpoch++
      const start = app.cardStartOf(existing.id)
      if (start >= 0) app.contentCursor = start
      app.selectionAnchor = -1
      app.ensureCursorVisible()
      return
    }
  }

  // Compose a new thread over the selection — collect the working-tree line
  // bounds it spans. The selection is over display rows; card rows inside it
  // carry no line and are skipped.
  const [selStart, selEnd] = app.selectionRange()
  let start = 0
  let end = 0
  const collect = (newNum: number) => {
    if (newNum <= 0) return
    if (start === 0 || newNum < start) start = newNum
    if (newNum > end) end = newNum
  }
  const view = app.effectiveViewMode()
  for (let d = selStart; d <= selEnd; d++) {
    const i = app.diffIdxAt(d)
    if (i < 0) continue
    switch (view) {
      case ViewMode.Split:
        collect(cached.split[i]?.newNum ?? 0)
        break
      case ViewMode.Current:
        collect(cached.current[i]?.newNum ?? 0)
        break
      default:
        collect(cached.unified[i]?.newNum ?? 0)
        break
    }
  }
  if (start === 0) return
  if (!threadsWritable(app)) return
  openCompose(
    app,
    { kind: 'new', threadId: '', file: app.selectedPath, start, end, commentId: '' },
    '',
  )
}

/**
 * handleCardKey is the card's own vocabulary, consulted BEFORE the global keys
 * when the cursor is on a card: `r`, `e` and `g` mean something else globally
 * (refresh, editor, lazygit), and on a card the thread is what you mean.
 * Returns false for anything else so arrows, paging, `h`/`H`, `tab` and the
 * rest keep working over a card.
 */
export function handleCardKey(app: App, key: string): boolean {
  const t = app.threadAtCursor()
  if (!t) return false
  switch (key) {
    case 'enter':
      app.toggleExpanded(t.id)
      return true
    case 'r':
      if (!threadsWritable(app)) return true
      openCompose(app, { kind: 'reply', threadId: t.id, file: '', start: 0, end: 0, commentId: '' }, '')
      return true
    case 'e': {
      if (!threadsWritable(app)) return true
      // The reviewer's own last word in the thread; an agent's comment is not
      // theirs to rewrite. Falls back to the last human comment for a store
      // written under a different author name.
      const mine =
        [...t.comments].reverse().find((c) => c.author === app.author) ??
        [...t.comments].reverse().find((c) => c.role === 'user')
      if (!mine) {
        app.err = new Error('no comment of yours in this thread to edit')
        app.render()
        return true
      }
      openCompose(
        app,
        { kind: 'edit', threadId: t.id, file: '', start: 0, end: 0, commentId: mine.id },
        mine.body,
      )
      return true
    }
    case 'x': {
      if (!threadsWritable(app)) return true
      const resolved = t.status === 'resolved'
      // Resolving folds the card to its one muted row; reopening leaves it
      // folded, to be opened on purpose.
      app.withStableCursor(() => {
        app.store.setStatus(t.id, resolved ? 'open' : 'resolved')
        app.expandedThreads.delete(t.id)
      })
      save(app)
      return true
    }
    case 'D': {
      if (!threadsWritable(app)) return true
      const n = t.comments.length
      app.confirm = {
        title: `Delete this thread? (${n} ${n === 1 ? 'comment' : 'comments'})`,
        yes: 'delete',
        no: 'keep',
        onYes: () => {
          if (!threadsWritable(app)) return
          app.withStableCursor(() => {
            app.store.deleteThread(t.id)
            app.expandedThreads.delete(t.id)
          })
          save(app)
        },
      }
      return true
    }
    default:
      return false
  }
}

/**
 * nextThread is `n` / `N`: the thread after or before the cursor, in tree
 * order — `app.files` order, then `range.start` — with threads on files the
 * tree does not list (CHANGES mode) after all of them, by path. Wraps.
 */
export function nextThread(app: App, delta: 1 | -1): void {
  const ordered = orderedThreads(app)
  if (ordered.length === 0) return
  const here = app.threadAtCursor()
  let i: number
  if (here) {
    const at = ordered.findIndex((t) => t.id === here.id)
    i = (at + delta + ordered.length) % ordered.length
  } else {
    // Between threads: the first one past the cursor's file and line.
    const fileIdx = app.files.findIndex((f) => f.path === app.selectedPath)
    const here = fileIdx < 0 ? Number.MAX_SAFE_INTEGER : fileIdx
    const line = app.cursorLine()
    const after = (t: StoredThread): boolean => {
      const ti = app.files.findIndex((f) => f.path === t.file)
      const there = ti < 0 ? Number.MAX_SAFE_INTEGER : ti
      if (there !== here) return there > here
      return t.range.start > line
    }
    const firstAfter = ordered.findIndex(after)
    if (delta === 1) i = firstAfter < 0 ? 0 : firstAfter
    else i = ((firstAfter < 0 ? ordered.length : firstAfter) - 1 + ordered.length) % ordered.length
  }
  app.jumpToThread(ordered[i]!)
}

function orderedThreads(app: App): StoredThread[] {
  const rank = new Map(app.files.map((f, i) => [f.path, i] as const))
  const key = (t: StoredThread): [number, string, number] => [
    rank.get(t.file) ?? Number.MAX_SAFE_INTEGER,
    rank.has(t.file) ? '' : t.file,
    t.range.start,
  ]
  return [...app.store.threads].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka[0] !== kb[0]) return ka[0] - kb[0]
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1
    return ka[2] - kb[2]
  })
}

// -------------------------------------------------------------- thread list

/** handleThreadListKey returns true when the key was consumed. */
export function handleThreadListKey(app: App, key: string): boolean {
  if (!app.threadList) return false
  switch (key) {
    case 'esc':
    case 'c':
      app.threadList = null
      return true
  }
  const threads = app.store.threads
  if (threads.length === 0) return true

  switch (key) {
    case 'up':
      if (app.threadList.cursor > 0) app.threadList.cursor--
      return true
    case 'down':
      if (app.threadList.cursor < threads.length - 1) app.threadList.cursor++
      return true
    case 'enter': {
      const t = threads[app.threadList.cursor]
      app.threadList = null
      if (t) app.jumpToThread(t)
      return true
    }
    default:
      return true
  }
}

/**
 * The text a new thread's anchor is captured from — the file as it is at the
 * moment the reviewer commits the comment, which is the moment the range was
 * chosen against. Synchronous on purpose: this runs inside the key dispatch,
 * where the thread must be added and the cursor re-pointed before the handler
 * returns, and a source file reads in microseconds. Null when the file is not
 * there or is too large to be a source file; the thread is then created
 * without an anchor and the next relocation pass backfills one.
 *
 * `file` is root-relative and resolves against the cwd, like every other read.
 */
function readWorkingTree(file: string): string | null {
  const MAX_BYTES = 2 * 1024 * 1024
  try {
    if (statSync(file).size > MAX_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * save persists the store, surfacing failures in the error banner. Losing a
 * comment silently would be much worse than a visible warning.
 *
 * Fire and forget: the in-memory store is already updated, so the UI is correct
 * the moment this is called; only the disk write is still in flight.
 */
function save(app: App): void {
  void persistStore(app)
}

/**
 * persistStore is `save` for callers that need to know when the write is done
 * (`src/relocate.ts`, which writes corrected ranges and then re-renders).
 *
 * A save that finds the file changed rebuilds `store.threads` from disk, and
 * the rows under the cursor with it — so when it reports a merge the cursor is
 * re-anchored by identity (`withStableCursor`, which also invalidates the
 * layout) and an open compose block is checked against the merged copy: its
 * thread gone means it closes, and the banner says why.
 *
 * `quiet` is for writes the reviewer did not ask for: a relocation must not
 * clear a banner somebody else put up (the same rule as `loadFiles()`, which
 * never clears `err`), so it only touches the banner to report a merge that
 * dropped or overwrote something. Never rejects.
 */
export async function persistStore(app: App, opts: { quiet?: boolean } = {}): Promise<void> {
  try {
    const report = await app.store.save()
    const lost = report.merged ? reanchor(app) : null
    // Only a clean save clears the banner: a merge that had to drop or
    // overwrite something — or that took the thread being written in — is
    // exactly the news the reviewer must not miss.
    const notice = lost ?? mergeNotice(report)
    if (notice !== null || !opts.quiet) app.err = notice
    if (report.merged || notice !== null) app.render()
  } catch (err) {
    app.err = err as Error
    app.render()
  }
}

/**
 * reanchor puts the UI back onto the objects it was showing, after a merge
 * replaced `store.threads` with the file's version of it.
 *
 * The cursor is re-derived from the card id it was on — never from its index,
 * which means something else in the rebuilt array. A compose block on a thread
 * that is simply gone (deleted by the other client) closes, because typing a
 * reply into a thread that no longer exists is how a reply disappears.
 */
function reanchor(app: App): Error | null {
  app.withStableCursor(() => {})
  let lost: Error | null = null
  const c = app.compose
  if (c && c.threadId !== '' && threadById(app, c.threadId) === null) {
    closeCompose(app)
    lost = new Error('the thread you were writing in was deleted by another client')
  }
  if (app.threadList) {
    const n = app.store.threads.length
    if (app.threadList.cursor >= n) app.threadList.cursor = Math.max(0, n - 1)
  }
  return lost
}

/**
 * mergeNotice turns a save report into banner text, or null when the save was
 * uneventful.
 *
 * The two things it reports are the conflicts the file format cannot represent:
 * a reply to a thread another client had already deleted (nowhere to put it) and
 * two edits to the same comment body (a scalar — one of them has to win). Saying
 * so is the whole point; a merge that quietly ate one of them would be this bug
 * again, just smaller.
 */
function mergeNotice(report: SaveReport): Error | null {
  const parts: string[] = []
  if (report.dropped > 0) {
    parts.push(
      report.dropped === 1
        ? 'one edit had nowhere to go: another client had deleted that thread or comment'
        : `${report.dropped} edits had nowhere to go: another client had deleted those threads or comments`,
    )
  }
  if (report.overwritten > 0) {
    parts.push(
      report.overwritten === 1
        ? 'one comment edited by another client was replaced by your version'
        : `${report.overwritten} comments edited by another client were replaced by your version`,
    )
  }
  if (parts.length === 0) return null
  return new Error(`saved, but ${parts.join('; ')}`)
}

/** Re-export so callers don't need to reach into comments.ts for the type. */
export type { Store }
