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
import { App, Focus, ViewMode } from './app.ts'
import { flatten } from './tree.ts'
import { keyString } from './keys.ts'
import { BUILTIN_THEMES } from './theme.ts'
import { openEditor, openLazygit, openSerie } from './externals.ts'
import { toggleFullStage, toggleStaged } from './staging.ts'
import { handleFinderKey, openFinder } from './finder.ts'
import {
  handleCardKey,
  handleComposeKey,
  handleThreadListKey,
  nextThread,
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
    //
    // "Without awaiting" is not the same as "fire and forget": staging used to be
    // launched blind with `void`, and two presses inside one operation raced over
    // the index and lost a line. `staging.ts` now decides here, synchronously, and
    // hands the git work to a serial queue. Don't put the `void` back.
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

/**
 * route returns true when refiner claimed the key. Exported for tests, which
 * drive the app through it with the normalized key strings.
 */
export function route(app: App, renderer: CliRenderer, key: string): boolean {
  // Overlays get first refusal, outermost first, so their keys never leak into
  // whatever is behind them.
  if (app.confirm) return handleConfirmKey(app, key)
  if (app.themePicker) return handleThemePickerKey(app, key)
  if (app.help) return handleHelpKey(app, key)
  if (app.threadList) return handleThreadListKey(app, key)
  if (app.finder) return handleFinderKey(app, key)
  // The inline textarea owns the keyboard while it is open: `esc` and the save
  // chords are claimed, everything else is typing and must NOT reach the
  // global handler — `q` in a comment is a letter, not a quit.
  if (app.compose) return handleComposeKey(app, key)
  // A card under the cursor speaks first. `r`, `e` and `g` all mean something
  // globally, and on a thread the thread is what you mean; what the card does
  // not claim (arrows, paging, `h`, `tab`…) falls through to the pane as usual.
  if (app.focus === Focus.Content && app.threadAtCursor() && handleCardKey(app, key)) return true
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
      app.confirm = {
        title: 'Quit refiner?',
        yes: 'quit',
        no: 'stay',
        onYes: () => shutdown(renderer),
      }
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
    case 's':
      void openSerie(app, renderer)
      return true
    case 'c':
      // Reachable only when no other modal is open — route() checks those first.
      app.threadList = { cursor: 0 }
      return true
    case 'n':
      nextThread(app, 1)
      return true
    case 'N':
      nextThread(app, -1)
      return true
    case 'z':
      // Every card in the file at once. From either pane: the tree cursor is
      // often where you are when you want the whole file's review unfolded.
      app.toggleAllExpanded()
      return true
    case 'p':
    case 'ctrl+p':
      // ⌃p is the alias every editor trained people to reach for. It is safe to
      // claim here because overlays get first refusal in `route()`, so it never
      // reaches a focused text widget.
      openFinder(app)
      return true
    case 'k':
    case '?':
      // The keymap used to live in a permanent footer. Moving it here gives the
      // diff that row back; the header advertises the key so it stays findable.
      app.help = { scrollY: 0, bodyHeight: 0 }
      return true
    case 't':
      // Opens on the palette in force, so ↑↓ moves away from where you are
      // rather than from the top of a list.
      app.themePicker = { cursor: app.themeIndex(), original: app.themeName }
      return true
    // The five keys below change the pane's width, and with it the layout:
    // cards re-wrap, so the row under the cursor moves or stops existing.
    // `withStableCursor` keeps the cursor on the same thing.
    case 'b':
      // Toggle tree auto-hide: when on, the tree pane hides while content has
      // focus and reappears the moment focus returns to it (left arrow).
      app.withStableCursor(() => {
        app.treeAutoHide = !app.treeAutoHide
      })
      app.persistState()
      return true
    case '[':
      app.withStableCursor(() => {
        app.treeWidthPct = Math.max(15, app.treeWidthPct - 5)
      })
      app.persistState()
      return true
    case ']':
      app.withStableCursor(() => {
        app.treeWidthPct = Math.min(70, app.treeWidthPct + 5)
      })
      app.persistState()
      return true
    case 'left':
      app.withStableCursor(() => {
        app.focus = Focus.Tree
      })
      return true
    case 'right':
      if (app.selectedPath !== '') {
        app.withStableCursor(() => {
          app.focus = Focus.Content
        })
      }
      return true
    default:
      return false
  }
}

/**
 * handleConfirmKey drives a yes/no box — quitting, deleting a thread. For the
 * quit, nothing is lost by saying yes (threads are written on every edit and
 * staging lives in git), so it guards against the fat-finger, not against data
 * loss; for a deletion it IS the guard, which is why `D` asks and `d` is not a
 * key.
 */
function handleConfirmKey(app: App, key: string): boolean {
  const confirm = app.confirm
  if (!confirm) return false
  switch (key) {
    case 'y':
    case 'enter':
      app.confirm = null
      confirm.onYes()
      return true
    case 'n':
    case 'esc':
    case 'q':
      app.confirm = null
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

/**
 * handleThemePickerKey drives the theme overlay.
 *
 * Moving the cursor applies the palette immediately: the panes are still on
 * screen behind the box, so the preview IS the answer to "does this theme work
 * for reading a diff". enter keeps it (and writes state.json), esc puts the
 * original back — which is why it is a real undo and not just a close.
 */
function handleThemePickerKey(app: App, key: string): boolean {
  const picker = app.themePicker
  if (!picker) return false
  const n = BUILTIN_THEMES.length
  switch (key) {
    case 'up':
      picker.cursor = (picker.cursor - 1 + n) % n
      app.setTheme(BUILTIN_THEMES[picker.cursor]!.name)
      return true
    case 'down':
      picker.cursor = (picker.cursor + 1) % n
      app.setTheme(BUILTIN_THEMES[picker.cursor]!.name)
      return true
    case 'enter':
      app.chooseTheme(BUILTIN_THEMES[picker.cursor]!.name)
      app.themePicker = null
      return true
    case 'esc':
    case 'q':
    case 't':
      app.setTheme(picker.original)
      app.themePicker = null
      return true
    default:
      // Modal: swallow everything else.
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
    //
    // `void` is correct here and must stay: the mode flips synchronously inside
    // `toggleFileMode`, and the reload it starts carries a generation
    // (`App.loadGen`) so the older of two in-flight toggles cannot land. Making
    // this handler `async` to await it would move `preventDefault()` past the
    // dispatch — see the header of this file. Unlike `space`, this is a read:
    // discarding the stale result is the fix, not a queue.
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
      if (node?.type === 'file') toggleFullStage(app, node.file)
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
  // Display rows: the diff plus every card row, which the cursor walks like
  // any other row.
  const n = app.displayRowCount()
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
      toggleStaged(app)
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

/** Whether a text widget owns the keyboard: the finder's input or the compose textarea. */
export function textFieldActive(app: App): boolean {
  return app.finder !== null || app.compose !== null
}

export { ViewMode }
