/**
 * The review-thread modals: the single-thread view (`enter` on a diff row) and
 * the all-threads list (`c`).
 *
 * The single-thread modal is a small state machine — Browse / Compose / Edit —
 * kept explicit rather than encoded in overlapping booleans, so both the key
 * handler and the renderer can branch on one value.
 *
 * Every mutation saves the store immediately. That matters because the file is
 * shared with the VSCode extension and with agents: a reply that only existed in
 * memory would be invisible to them, and would be lost the moment the reviewer
 * pressed `r`.
 */

import { readFileSync, statSync } from 'node:fs'
import { App, Focus, ModalMode, ViewMode, type ThreadModal } from './app.ts'
import { Store } from './comments.ts'
import type { SaveReport, StoredThread } from './comments.ts'
import { anchorFor } from './relocate.ts'

export function newThreadModal(
  threadIdx: number,
  threadId: string,
  file: string,
  start: number,
  end: number,
): ThreadModal {
  return {
    threadIdx,
    threadId,
    newThreadFile: file,
    newThreadStart: start,
    newThreadEnd: end,
    selectedComment: 0,
    mode: threadIdx < 0 ? ModalMode.Compose : ModalMode.Browse,
    editIdx: -1,
    scrollY: 0,
    bodyHeight: 0,
  }
}

function openModal(app: App, modal: ThreadModal): void {
  app.modal = modal
  if (modal.mode === ModalMode.Compose) app.inputs.setComposeValue('')
}

/**
 * threadsWritable gates the paths that mutate the store, and explains itself in
 * the banner when it says no.
 *
 * The real defence is in `Store.save()` — any future caller gets it for free —
 * but refusing up front is what makes the refusal honest: without it the
 * reviewer types a whole comment, `save()` rejects asynchronously, and the modal
 * drops back to browse showing a comment that exists only in memory.
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

export function closeModal(app: App): void {
  app.modal = null
  app.inputs.setComposeValue('')
}

/**
 * openOrCreateThread is bound to Enter in the content pane. If the cursor row
 * falls inside an existing thread it opens it in browse mode; otherwise it opens
 * a compose modal anchored to the selection's working-tree line range. Does
 * nothing when the selection covers only deleted lines, since there is no
 * working-tree line to anchor to.
 */
export function openOrCreateThread(app: App): void {
  if (app.selectedPath === '') return
  const cached = app.cache.get(app.selectedPath)
  if (!cached) return

  const cursorLine = app.cursorLine()
  if (cursorLine > 0) {
    const existing = app.store.threadAt(app.selectedPath, cursorLine)
    if (existing) {
      const idx = app.store.indexOfThread(existing.id)
      if (idx >= 0) {
        openModal(app, newThreadModal(idx, existing.id, '', 0, 0))
        return
      }
    }
  }

  // Compose a new thread over the selection — collect the working-tree line
  // bounds it spans.
  let [selStart, selEnd] = app.selectionRange()
  let start = 0
  let end = 0
  const collect = (newNum: number) => {
    if (newNum <= 0) return
    if (start === 0 || newNum < start) start = newNum
    if (newNum > end) end = newNum
  }

  switch (app.effectiveViewMode()) {
    case ViewMode.Split:
      selEnd = Math.min(selEnd, cached.split.length - 1)
      for (let i = selStart; i <= selEnd; i++) collect(cached.split[i]?.newNum ?? 0)
      break
    case ViewMode.Current:
      selEnd = Math.min(selEnd, cached.current.length - 1)
      for (let i = selStart; i <= selEnd; i++) collect(cached.current[i]?.newNum ?? 0)
      break
    default:
      selEnd = Math.min(selEnd, cached.unified.length - 1)
      for (let i = selStart; i <= selEnd; i++) collect(cached.unified[i]?.newNum ?? 0)
      break
  }
  if (start === 0) return
  // Opening an existing thread above stays allowed; only composing a new one is
  // gated, since that is the branch that ends in a write.
  if (!threadsWritable(app)) return
  openModal(app, newThreadModal(-1, '', app.selectedPath, start, end))
}

/**
 * jumpToThread points the content pane at a thread's file and schedules the
 * cursor onto its first line. No-op when the file isn't in the change set,
 * which would otherwise dump the reviewer at the tree with no explanation.
 */
export function jumpToThread(app: App, t: StoredThread): void {
  const file = app.findFile(t.file)
  if (!file) return
  app.selectedPath = t.file
  app.revealPath(t.file)
  app.pendingNavLine = t.range.start
  app.focus = Focus.Content
  if (app.cache.has(app.selectedPath)) {
    app.navigateToPendingLine()
    return
  }
  app.ensureDiffLoaded(file)
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
      // Open the thread modal rather than jumping straight to code, so threads
      // whose file left the diff are still reachable. Goto-code is `g` inside.
      const idx = app.threadList.cursor
      app.threadList = null
      openModal(app, newThreadModal(idx, threads[idx].id, '', 0, 0))
      return true
    }
    default:
      return true
  }
}

// ------------------------------------------------------------ thread modal

/**
 * handleModalKey returns true when the key was consumed. Anything it declines
 * while a text field is active falls through to the widget, which is how typing
 * works in compose/edit mode.
 *
 * Synchronous on purpose: the caller has to call preventDefault() during the
 * event dispatch, so the decision cannot wait on I/O. Store writes are fired off
 * without awaiting — the in-memory mutation the UI renders from has already
 * happened by then.
 */
export function handleModalKey(app: App, key: string): boolean {
  const modal = app.modal
  if (!modal) return false

  if (key === 'esc') {
    // Cancelling compose/edit on an existing thread returns to browse; anywhere
    // else it closes the modal.
    if (modal.mode !== ModalMode.Browse && modal.threadIdx >= 0) {
      modal.mode = ModalMode.Browse
      modal.editIdx = -1
      app.inputs.setComposeValue('')
      return true
    }
    closeModal(app)
    return true
  }

  if (modal.mode !== ModalMode.Browse) {
    switch (key) {
      // Three accepted save keys. alt+enter is the advertised primary (it works
      // in zellij and wherever ctrl chords are taken); alt+s is the mnemonic
      // fallback; ctrl+s is kept for muscle memory.
      case 'alt+enter':
      case 'alt+s':
      case 'ctrl+s':
        submitModalCompose(app)
        return true
      default:
        // Everything else is text input.
        return false
    }
  }

  // Browse mode — only meaningful with an existing thread.
  if (modal.threadIdx < 0) return true
  const t = app.store.threads[modal.threadIdx]
  if (!t) {
    closeModal(app)
    return true
  }

  switch (key) {
    case 'up':
      if (modal.selectedComment > 0) modal.selectedComment--
      return true
    case 'down':
      if (modal.selectedComment < t.comments.length - 1) modal.selectedComment++
      return true
    case 'pgup':
    case 'ctrl+u': {
      // Free scroll without moving the comment selection — useful when one
      // comment is taller than the modal body.
      const h = modal.bodyHeight < 1 ? 5 : modal.bodyHeight
      modal.scrollY = Math.max(0, modal.scrollY - (h - 1))
      return true
    }
    case 'pgdown':
    case 'ctrl+d': {
      const h = modal.bodyHeight < 1 ? 5 : modal.bodyHeight
      modal.scrollY += h - 1
      return true
    }
    case 'g':
      if (app.findFile(t.file) === null) return true
      closeModal(app)
      jumpToThread(app, t)
      return true
    case 'r':
      if (!threadsWritable(app)) return true
      modal.mode = ModalMode.Compose
      modal.editIdx = -1
      app.inputs.setComposeValue('')
      return true
    case 'e':
      if (!threadsWritable(app)) return true
      if (modal.selectedComment >= 0 && modal.selectedComment < t.comments.length) {
        modal.mode = ModalMode.Edit
        modal.editIdx = modal.selectedComment
        app.inputs.setComposeValue(t.comments[modal.selectedComment].body)
      }
      return true
    case 'd': {
      if (modal.selectedComment < 0 || modal.selectedComment >= t.comments.length) return true
      // Before the mutation, not after: `deleteComment` cannot be undone from
      // memory once the save that would have made it real has been refused.
      if (!threadsWritable(app)) return true
      app.store.deleteComment(t.id, modal.selectedComment)
      if (t.comments.length === 0) {
        // No comments left → the thread itself is meaningless. Drop it.
        app.store.deleteThread(t.id)
        save(app)
        closeModal(app)
        return true
      }
      if (modal.selectedComment >= t.comments.length) modal.selectedComment = t.comments.length - 1
      save(app)
      return true
    }
    case 'D':
      if (!threadsWritable(app)) return true
      app.store.deleteThread(t.id)
      save(app)
      closeModal(app)
      return true
    default:
      return true
  }
}

/**
 * submitModalCompose commits the text field:
 *
 *   Edit                    → update the existing comment body in place
 *   Compose, threadIdx >= 0 → append a reply
 *   Compose, threadIdx < 0  → create a new thread with this as its first comment
 *
 * Afterwards it drops back into browse mode.
 */
export function submitModalCompose(app: App): void {
  const modal = app.modal
  if (!modal) return
  const body = app.inputs.composeValue().trim()
  if (body === '') return
  // The compose box should not have opened at all in this state, but this is the
  // commit point and the text is still in the widget: refusing here keeps it
  // there to be copied out, instead of moving it into a store that cannot be
  // written and calling it saved.
  if (!threadsWritable(app)) return

  if (modal.mode === ModalMode.Edit) {
    const t = app.store.threads[modal.threadIdx]
    if (!t || modal.editIdx < 0 || modal.editIdx >= t.comments.length) {
      // The comment went away under us — another client deleted it and a merge
      // re-anchored past it. Say so and keep the text where the reviewer can
      // still copy it, rather than throwing out of a key handler.
      app.err = new Error(
        'the comment you were editing is no longer in the file; another client deleted it',
      )
      app.render()
      return
    }
    app.store.setCommentBody(t.id, modal.editIdx, body)
  } else if (modal.threadIdx >= 0) {
    const t = app.store.threads[modal.threadIdx]
    if (t) {
      app.store.appendComment(t.id, { author: app.author, body, role: 'user' })
      // Land the browse cursor on the new comment.
      modal.selectedComment = t.comments.length - 1
    }
  } else {
    const { newThreadFile: file, newThreadStart: start, newThreadEnd: end } = modal
    const t = app.store.addThread(
      file,
      start,
      end,
      { author: app.author, body, role: 'user' },
      anchorFor(readWorkingTree(file), start, end),
    )
    const idx = app.store.indexOfThread(t.id)
    if (idx >= 0) {
      modal.threadIdx = idx
      modal.threadId = t.id
      modal.selectedComment = 0
    }
  }

  save(app)
  modal.mode = ModalMode.Browse
  modal.editIdx = -1
  app.inputs.setComposeValue('')
}

/**
 * The text a new thread's anchor is captured from — the file as it is at the
 * moment the reviewer commits the comment, which is the moment the range was
 * chosen against. Synchronous on purpose: this runs inside the key dispatch,
 * where the thread must be added and the modal re-pointed before the handler
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
 * What is NOT settled while the write is in flight is which thread lives at
 * which index — a save that finds the file changed rebuilds `store.threads`
 * from disk — so the ids the UI is pointing at are captured here, before the
 * first await, and resolved back to indices afterwards.
 *
 * `quiet` is for writes the reviewer did not ask for: a relocation must not
 * clear a banner somebody else put up (the same rule as `loadFiles()`, which
 * never clears `err`), so it only touches the banner to report a merge that
 * dropped or overwrote something. Never rejects.
 */
export async function persistStore(app: App, opts: { quiet?: boolean } = {}): Promise<void> {
  const anchors = captureAnchors(app)
  try {
    const report = await app.store.save()
    if (report.merged) reanchor(app, anchors)
    // Only a clean save clears the banner: a merge that had to drop or
    // overwrite something is exactly the news the reviewer must not miss.
    const notice = mergeNotice(report)
    if (notice !== null || !opts.quiet) app.err = notice
    if (report.merged || notice !== null) app.render()
  } catch (err) {
    app.err = err as Error
    app.render()
  }
}

/** The ids the open overlays are pointing at, taken before a save can move them. */
interface UiAnchors {
  threadId: string
  /** Id of the comment under the browse cursor, or ''. */
  selectedId: string
  /** Id of the comment being edited, or ''. */
  editId: string
}

function captureAnchors(app: App): UiAnchors | null {
  const modal = app.modal
  if (!modal || modal.threadIdx < 0) return null
  const t = app.store.threads[modal.threadIdx]
  const at = (i: number): string => (t && i >= 0 && i < t.comments.length ? t.comments[i].id : '')
  return {
    threadId: modal.threadId,
    selectedId: at(modal.selectedComment),
    editId: at(modal.editIdx),
  }
}

/**
 * reanchor puts the overlays back onto the objects they were showing, after a
 * merge replaced `store.threads` with the file's version of it.
 *
 * Indices only: everything the UI holds is an index into an array that has just
 * been rebuilt, so each one is re-derived from the id captured before the save.
 * A thread that is simply gone (deleted by the other client) closes the modal —
 * showing the next thread along under the same cursor is how `d` deletes the
 * wrong comment.
 */
function reanchor(app: App, anchors: UiAnchors | null): void {
  const modal = app.modal
  if (modal && modal.threadIdx >= 0) {
    // The modal's OWN id, not the captured one: a save is asynchronous, and the
    // reviewer may have closed this modal and opened another meanwhile. That one
    // needs re-anchoring just as much, and to its own thread.
    const idx = app.store.indexOfThread(modal.threadId)
    const t = idx >= 0 ? app.store.threads[idx] : null
    if (!t) {
      closeModal(app)
    } else {
      modal.threadIdx = idx
      const same = anchors !== null && anchors.threadId === modal.threadId
      const find = (id: string): number =>
        id === '' ? -1 : t.comments.findIndex((c) => c.id === id)
      const last = Math.max(0, t.comments.length - 1)
      const sel = same ? find(anchors.selectedId) : -1
      modal.selectedComment = sel >= 0 ? sel : Math.min(Math.max(0, modal.selectedComment), last)
      // -1 rather than a guess: submitModalCompose refuses on it and says why.
      if (same && modal.mode === ModalMode.Edit) modal.editIdx = find(anchors.editId)
    }
  }
  if (app.threadList) {
    const n = app.store.threads.length
    if (app.threadList.cursor >= n) app.threadList.cursor = Math.max(0, n - 1)
  }
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
