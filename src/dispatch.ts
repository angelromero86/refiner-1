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
  handleThreadListKey,
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
    // Everything below must decide synchronously: preventDefault() only counts
    // during this dispatch, and anything we don't claim has to reach the focused
    // text widget untouched. Handlers therefore kick off their git/store I/O
    // without awaiting it.
    if (route(app, renderer, key)) {
      event.preventDefault()
      app.render()
    }
  })
}

function shutdown(renderer: CliRenderer): void {
  renderer.destroy()
  process.exit(0)
}

/** route returns true when refiner claimed the key. */
function route(app: App, renderer: CliRenderer, key: string): boolean {
  // Overlays get first refusal, outermost first, so their keys never leak into
  // whatever is behind them.
  if (app.quitConfirm) return handleQuitConfirmKey(app, renderer, key)
  if (app.help) return handleHelpKey(app, key)
  if (app.modal) return handleModalKey(app, key)
  if (app.threadList) return handleThreadListKey(app, key)
  if (app.finder) return handleFinderKey(app, key)
  if (handleGlobalKey(app, renderer, key)) return true
  return app.focus === Focus.Tree
    ? handleTreeKey(app, key)
    : handleContentKey(app, renderer, key)
}

/**
 * handleGlobalKey covers the shortcuts that work from either pane. Returns true
 * when the key was consumed.
 */
function handleGlobalKey(app: App, renderer: CliRenderer, key: string): boolean {
  switch (key) {
    case 'q':
    case 'esc':
      // Both are one keystroke away from anything else you might be doing, so
      // they ask first. ⌃c stays immediate as the deliberate escape hatch.
      app.quitConfirm = true
      return true
    case 'r':
      // An explicit refresh is the user saying "start over", so it also dismisses
      // whatever error is on screen.
      app.err = null
      void app.refresh()
      return true
    case 'g':
      void openLazygit(app, renderer)
      return true
    case 'c':
      // Reachable only when no other modal is open — route() checks those first.
      app.threadList = { cursor: 0 }
      return true
    case 'p':
      openFinder(app)
      return true
    case 'k':
    case '?':
      // The keymap used to live in a permanent footer. Moving it here gives the
      // diff that row back; the header advertises the key so it stays findable.
      app.help = { scrollY: 0, bodyHeight: 0 }
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

/**
 * handleQuitConfirmKey drives the quit confirmation. Nothing is lost by quitting
 * — threads are written on every edit and staging lives in git — so this guards
 * against the fat-finger, not against data loss.
 */
function handleQuitConfirmKey(app: App, renderer: CliRenderer, key: string): boolean {
  switch (key) {
    case 'y':
    case 'enter':
      shutdown(renderer)
      return true
    case 'n':
    case 'esc':
    case 'q':
      app.quitConfirm = false
      return true
    default:
      // Modal: swallow everything so a stray key can't act on the view behind.
      return true
  }
}

/**
 * handleHelpKey drives the keymap overlay. Scrollable because the full list
 * outgrows a short terminal, and dismissible with the same key that opened it.
 */
function handleHelpKey(app: App, key: string): boolean {
  const help = app.help
  if (!help) return false
  switch (key) {
    case 'esc':
    case 'k':
    case '?':
    case 'q':
      app.help = null
      return true
    case 'up':
      help.scrollY = Math.max(0, help.scrollY - 1)
      return true
    case 'down':
      help.scrollY++
      return true
    case 'pgup':
    case 'ctrl+u':
      help.scrollY = Math.max(0, help.scrollY - Math.max(1, help.bodyHeight - 1))
      return true
    case 'pgdown':
    case 'ctrl+d':
      help.scrollY += Math.max(1, help.bodyHeight - 1)
      return true
    case 'home':
      help.scrollY = 0
      return true
    default:
      // Swallow everything else: the overlay is modal.
      return true
  }
}

function handleTreeKey(app: App, key: string): boolean {
  // Keys that don't act on a row go first. An empty tree is exactly when you most
  // need Tab — no changes to review means CHANGES has nothing in it, and putting
  // this after the guard below left the UI with no way out.
  if (key === 'tab') {
    // Contextual: in the tree Tab switches WHAT is listed, in the diff it
    // switches HOW the file is shown.
    void app.toggleFileMode()
    return true
  }

  if (app.flat.length === 0) return false
  switch (key) {
    case 'up':
      // Wraps around, matching the original.
      app.cursor = (app.cursor - 1 + app.flat.length) % app.flat.length
      selectFileAtCursor(app)
      return true
    case 'down':
      app.cursor = (app.cursor + 1) % app.flat.length
      selectFileAtCursor(app)
      return true
    case 'enter':
      activateCursor(app)
      return true
    case ' ': {
      const node = app.flat[app.cursor]?.node
      if (node?.type === 'file') void toggleFullStage(app, node.file)
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

function handleContentKey(app: App, renderer: CliRenderer, key: string): boolean {
  const n = app.activeRowCount()
  const h = app.paneInnerHeight()

  switch (key) {
    case 'e':
      void openEditor(app, renderer)
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
      if (app.contentCursor > 0) app.contentCursor--
      app.selectionAnchor = -1
      break
    case 'down':
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
    case 'h':
      // Next block of changed lines. Wraps, so it never becomes a dead key.
      app.jumpToHunk(1)
      return true
    case 'H':
      app.jumpToHunk(-1)
      return true
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
      void toggleStaged(app)
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
