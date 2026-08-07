/**
 * Key routing.
 *
 * OpenTUI runs global handlers before the focused renderable sees the event, and
 * lets a global handler call preventDefault() to stop it there. That gives us
 * exactly the routing the bubbletea version had for free: this handler decides
 * first, and anything it declines while a text field is focused falls through to
 * the widget, which is how typing works in the compose box and the file picker.
 *
 * The switch bodies are deliberate near-verbatim ports of the Go handlers, so
 * behaviour differences show up as diffs rather than as subtle drift.
 */

import type { CliRenderer, KeyEvent } from '@opentui/core'
import { App, Focus, ModalMode, ViewMode } from './app.ts'
import { flatten } from './tree.ts'
import { keyString } from './keys.ts'
import { openEditor, openLazygit } from './externals.ts'
import { toggleFullStage, toggleStaged } from './staging.ts'
import { handleFinderKey, openFinder } from './finder.ts'
import {
  handleCommentsListKey,
  handleModalKey,
  openOrCreateThread,
} from './threads-ui.ts'

export function installKeyHandling(app: App, renderer: CliRenderer): void {
  renderer.keyInput.on('keypress', (event: KeyEvent) => {
    const key = keyString(event)
    if (key === '') return
    // ctrl+c always quits, from any modal or pane.
    if (key === 'ctrl+c') {
      event.preventDefault()
      shutdown(renderer)
      return
    }
    void route(app, renderer, key, event)
  })
}

function shutdown(renderer: CliRenderer): void {
  renderer.destroy()
  process.exit(0)
}

async function route(
  app: App,
  renderer: CliRenderer,
  key: string,
  event: KeyEvent,
): Promise<void> {
  // Modals get first refusal, in the same order the Go Update did.
  if (app.modal) {
    const consumed = await handleModalKey(app, key)
    if (consumed) {
      event.preventDefault()
      app.render()
    }
    return
  }
  if (app.commentsList) {
    if (handleCommentsListKey(app, key)) {
      event.preventDefault()
      app.render()
    }
    return
  }
  if (app.finder) {
    if (handleFinderKey(app, key)) {
      event.preventDefault()
      app.render()
    }
    return
  }

  if (await handleGlobalKey(app, renderer, key)) {
    event.preventDefault()
    app.render()
    return
  }

  const handled =
    app.focus === Focus.Tree
      ? await handleTreeKey(app, key)
      : await handleContentKey(app, renderer, key)
  if (handled) {
    event.preventDefault()
    app.render()
  }
}

/**
 * handleGlobalKey covers the shortcuts that work from either pane. Returns true
 * when the key was consumed.
 */
async function handleGlobalKey(app: App, renderer: CliRenderer, key: string): Promise<boolean> {
  switch (key) {
    case 'q':
    case 'esc':
      shutdown(renderer)
      return true
    case 'r':
      await app.refresh()
      return true
    case 'g':
      await openLazygit(app, renderer)
      return true
    case 'c':
      // Reachable only when no other modal is open — route() checks those first.
      app.commentsList = { cursor: 0 }
      return true
    case 'p':
      openFinder(app)
      return true
    case 'b':
      // Toggle tree auto-hide: when on, the tree pane hides while content has
      // focus and reappears the moment focus returns to it (left arrow).
      app.treeAutoHide = !app.treeAutoHide
      app.persistState()
      return true
    case '[':
      app.treeWidthPct = Math.max(15, app.treeWidthPct - 5)
      app.persistState()
      return true
    case ']':
      app.treeWidthPct = Math.min(70, app.treeWidthPct + 5)
      app.persistState()
      return true
    case 'left':
      app.focus = Focus.Tree
      return true
    case 'right':
      if (app.selectedPath !== '') app.focus = Focus.Content
      return true
    default:
      return false
  }
}

async function handleTreeKey(app: App, key: string): Promise<boolean> {
  if (app.flat.length === 0) return false
  switch (key) {
    case 'up':
    case 'k':
      // Wraps around, matching the original.
      app.cursor = (app.cursor - 1 + app.flat.length) % app.flat.length
      selectFileAtCursor(app)
      return true
    case 'down':
    case 'j':
      app.cursor = (app.cursor + 1) % app.flat.length
      selectFileAtCursor(app)
      return true
    case 'enter':
      activateCursor(app)
      return true
    case ' ': {
      const node = app.flat[app.cursor]?.node
      if (node?.type === 'file') await toggleFullStage(app, node.file)
      return true
    }
    default:
      return false
  }
}

/**
 * selectFileAtCursor mirrors the file under the tree cursor into the content
 * pane without touching focus, so the right pane always reflects the highlighted
 * row. No-op on a directory, which keeps the previously selected file visible.
 */
function selectFileAtCursor(app: App): void {
  const node = app.flat[app.cursor]?.node
  if (!node || node.type !== 'file') return
  if (app.selectedPath === node.path) return
  app.selectedPath = node.path
  app.contentCursor = 0
  app.contentScroll = 0
  app.selectionAnchor = -1
  app.ensureDiffLoaded(node.file)
}

/**
 * activateCursor handles Enter in the tree: toggles directory expansion, or
 * moves focus to the content pane for files.
 */
function activateCursor(app: App): void {
  const node = app.flat[app.cursor]?.node
  if (!node) return
  if (node.type === 'dir') {
    if (app.collapsed.has(node.path)) app.collapsed.delete(node.path)
    else app.collapsed.add(node.path)
    app.flat = flatten(app.nodes, app.collapsed)
    if (app.cursor >= app.flat.length) app.cursor = Math.max(0, app.flat.length - 1)
    return
  }
  // Ensure the file is selected — covers pressing Enter as the very first key,
  // before any arrow move triggered an auto-select.
  selectFileAtCursor(app)
  app.focus = Focus.Content
}

async function handleContentKey(app: App, renderer: CliRenderer, key: string): Promise<boolean> {
  const n = app.activeRowCount()
  const h = app.paneInnerHeight()

  switch (key) {
    case 'e':
      await openEditor(app, renderer)
      return true
    case 'tab':
      // Cycle DIFF → SPLIT → NORMAL → DIFF. Not persisted: sessions always
      // start in DIFF.
      app.viewMode = (app.viewMode + 1) % 3
      app.contentCursor = 0
      app.contentScroll = 0
      app.selectionAnchor = -1
      return true
    case 'shift+up':
      if (app.selectionAnchor < 0) app.selectionAnchor = app.contentCursor
      if (app.contentCursor > 0) app.contentCursor--
      break
    case 'shift+down':
      if (app.selectionAnchor < 0) app.selectionAnchor = app.contentCursor
      if (app.contentCursor < n - 1) app.contentCursor++
      break
    case 'up':
    case 'k':
      if (app.contentCursor > 0) app.contentCursor--
      app.selectionAnchor = -1
      break
    case 'down':
    case 'j':
      if (app.contentCursor < n - 1) app.contentCursor++
      app.selectionAnchor = -1
      break
    case 'pgup':
    case 'ctrl+u':
      // ctrl+u/d are the Mac-friendly aliases — PgUp/PgDn need fn-gymnastics on
      // most Apple keyboards.
      app.contentCursor = Math.max(0, app.contentCursor - Math.floor(h / 2))
      app.selectionAnchor = -1
      break
    case 'pgdown':
    case 'ctrl+d':
      app.contentCursor = Math.min(n - 1, app.contentCursor + Math.floor(h / 2))
      app.selectionAnchor = -1
      break
    case 'home':
      app.contentCursor = 0
      app.selectionAnchor = -1
      break
    case 'end':
    case 'G':
      app.contentCursor = n - 1
      app.selectionAnchor = -1
      break
    case ' ':
      await toggleStaged(app)
      return true
    case 'enter':
      openOrCreateThread(app)
      return true
    default:
      return false
  }
  if (app.contentCursor < 0) app.contentCursor = 0
  app.ensureCursorVisible()
  return true
}

/** Exported for the view, which needs to know whether a text field owns input. */
export function textFieldActive(app: App): boolean {
  if (app.finder) return true
  return app.modal !== null && app.modal.mode !== ModalMode.Browse
}

export { ViewMode }
