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

import { App, Focus, ModalMode, ViewMode, type ThreadModal } from './app.ts'
import { Store } from './comments.ts'
import type { StoredThread } from './comments.ts'

export function newThreadModal(
  threadIdx: number,
  file: string,
  start: number,
  end: number,
): ThreadModal {
  return {
    threadIdx,
    newThreadFile: file,
    newThreadStart: start,
    newThreadEnd: end,
    selectedMsg: 0,
    mode: threadIdx < 0 ? ModalMode.Compose : ModalMode.Browse,
    editIdx: -1,
    scrollY: 0,
    bodyHeight: 0,
  }
}

function openModal(app: App, modal: ThreadModal): void {
  app.modal = modal
  if (modal.mode === ModalMode.Compose) {
    app.inputs.setComposeValue('')
    app.inputs.focusCompose()
  } else {
    app.inputs.blurCompose()
  }
}

export function closeModal(app: App): void {
  app.modal = null
  app.inputs.setComposeValue('')
  app.inputs.blurCompose()
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
    const existing = app.threads.threadAt(app.selectedPath, cursorLine)
    if (existing) {
      const idx = app.threads.threads.findIndex((t) => t.id === existing.id)
      if (idx >= 0) {
        openModal(app, newThreadModal(idx, '', 0, 0))
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

  switch (app.viewMode) {
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
  openModal(app, newThreadModal(-1, app.selectedPath, start, end))
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
  app.pendingNavLine = t.range.start
  app.focus = Focus.Content
  if (app.cache.has(app.selectedPath)) {
    app.navigateToPendingLine()
    return
  }
  app.ensureDiffLoaded(file)
}

// ------------------------------------------------------------ comments list

/** handleCommentsListKey returns true when the key was consumed. */
export function handleCommentsListKey(app: App, key: string): boolean {
  if (!app.commentsList) return false
  switch (key) {
    case 'esc':
    case 'c':
      app.commentsList = null
      return true
  }
  const threads = app.threads.threads
  if (threads.length === 0) return true

  switch (key) {
    case 'up':
    case 'k':
      if (app.commentsList.cursor > 0) app.commentsList.cursor--
      return true
    case 'down':
    case 'j':
      if (app.commentsList.cursor < threads.length - 1) app.commentsList.cursor++
      return true
    case 'enter': {
      // Open the thread modal rather than jumping straight to code, so threads
      // whose file left the diff are still reachable. Goto-code is `g` inside.
      const idx = app.commentsList.cursor
      app.commentsList = null
      openModal(app, newThreadModal(idx, '', 0, 0))
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
 */
export async function handleModalKey(app: App, key: string): Promise<boolean> {
  const modal = app.modal
  if (!modal) return false

  if (key === 'esc') {
    // Cancelling compose/edit on an existing thread returns to browse; anywhere
    // else it closes the modal.
    if (modal.mode !== ModalMode.Browse && modal.threadIdx >= 0) {
      modal.mode = ModalMode.Browse
      modal.editIdx = -1
      app.inputs.setComposeValue('')
      app.inputs.blurCompose()
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
        await submitModalCompose(app)
        return true
      default:
        // Everything else is text input.
        return false
    }
  }

  // Browse mode — only meaningful with an existing thread.
  if (modal.threadIdx < 0) return true
  const t = app.threads.threads[modal.threadIdx]
  if (!t) {
    closeModal(app)
    return true
  }

  switch (key) {
    case 'up':
    case 'k':
      if (modal.selectedMsg > 0) modal.selectedMsg--
      return true
    case 'down':
    case 'j':
      if (modal.selectedMsg < t.comments.length - 1) modal.selectedMsg++
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
      modal.mode = ModalMode.Compose
      modal.editIdx = -1
      app.inputs.setComposeValue('')
      app.inputs.focusCompose()
      return true
    case 'e':
      if (modal.selectedMsg >= 0 && modal.selectedMsg < t.comments.length) {
        modal.mode = ModalMode.Edit
        modal.editIdx = modal.selectedMsg
        app.inputs.setComposeValue(t.comments[modal.selectedMsg].body)
        app.inputs.focusCompose()
      }
      return true
    case 'd': {
      if (modal.selectedMsg < 0 || modal.selectedMsg >= t.comments.length) return true
      app.threads.deleteComment(t.id, modal.selectedMsg)
      if (t.comments.length === 0) {
        // No comments left → the thread itself is meaningless. Drop it.
        app.threads.deleteThread(t.id)
        await save(app)
        closeModal(app)
        return true
      }
      if (modal.selectedMsg >= t.comments.length) modal.selectedMsg = t.comments.length - 1
      await save(app)
      return true
    }
    case 'D':
      app.threads.deleteThread(t.id)
      await save(app)
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
export async function submitModalCompose(app: App): Promise<void> {
  const modal = app.modal
  if (!modal) return
  const body = app.inputs.composeValue().trim()
  if (body === '') return

  if (modal.mode === ModalMode.Edit) {
    const t = app.threads.threads[modal.threadIdx]
    if (t) app.threads.setCommentBody(t.id, modal.editIdx, body)
  } else if (modal.threadIdx >= 0) {
    const t = app.threads.threads[modal.threadIdx]
    if (t) {
      app.threads.appendComment(t.id, { author: app.author, body, role: 'user' })
      // Land the browse cursor on the new comment.
      modal.selectedMsg = t.comments.length - 1
    }
  } else {
    const t = app.threads.addThread(modal.newThreadFile, modal.newThreadStart, modal.newThreadEnd, {
      author: app.author,
      body,
      role: 'user',
    })
    const idx = app.threads.threads.findIndex((x) => x.id === t.id)
    if (idx >= 0) {
      modal.threadIdx = idx
      modal.selectedMsg = 0
    }
  }

  await save(app)
  modal.mode = ModalMode.Browse
  modal.editIdx = -1
  app.inputs.setComposeValue('')
  app.inputs.blurCompose()
}

/**
 * save persists the store, surfacing failures in the error banner. Losing a
 * comment silently would be much worse than a visible warning.
 */
async function save(app: App): Promise<void> {
  try {
    await app.threads.save()
    app.err = null
  } catch (err) {
    app.err = err as Error
  }
}

/** Re-export so callers don't need to reach into comments.ts for the type. */
export type { Store }
