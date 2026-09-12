/**
 * The whole application state, plus the geometry helpers the view derives from
 * it.
 *
 * The Go original was a bubbletea Model: an immutable value threaded through
 * Update, returning (Model, Cmd) pairs. OpenTUI is imperative, so this is a
 * mutable object whose methods mutate in place and then call `render()`. The
 * state fields and their invariants are otherwise unchanged:
 *
 *   - contentCursor, contentScroll and selectionAnchor index the DISPLAY rows
 *     (`src/rows.ts`): the active diff with the thread cards spliced in.
 *     Staging and hunks map back to the diff through `diffIdxAt`.
 *   - selectionAnchor === -1 means "no shift-selection active"; otherwise the
 *     selection runs between selectionAnchor and contentCursor (inclusive).
 *   - cache, staged, loadingDiff and collapsed are all keyed by file path.
 *   - The async loads that used to be tea.Cmds are plain async methods; each one
 *     re-checks that its result is still relevant before applying it, because a
 *     second load can be kicked off while the first is in flight. That check is
 *     `loadGen` — see its comment; it is what lets the key handler fire a reload
 *     without awaiting it.
 */

import {
  align,
  contextOnly,
  creationMode,
  deletionMode,
  hunkStarts,
  RowKind,
  filterContentLines,
  filterCurrentView,
  LineKind,
  parse,
  stagedIndicesFromDiffs,
  type AlignedRow,
  type Line,
} from './diff.ts'
import {
  fullyStaged,
  isChanged,
  loadAllFiles,
  loadChangedFiles,
  loadDiff,
  loadStagedDiff,
  loadUnstagedDiff,
  Mode,
  repoName as gitRepoName,
  type ChangedFile,
  type Source,
} from './git.ts'
import { build as buildTree, flatten, type FlatNode, type Node } from './tree.ts'
import { Store, type StoredThread } from './comments.ts'
import { relocateThreads, type Drift } from './relocate.ts'
import { highlightDiff, NO_HIGHLIGHTS, type DiffHighlights } from './syntax.ts'
import { defaultUIState, loadState, saveState } from './state.ts'
import {
  defaultConfig,
  type EditorConfig,
  type IconConfig,
  type PopupConfig,
} from './config.ts'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_NAME,
  emptyOverrides,
  resolveTheme,
  themeByName,
  type ThemeOverrides,
} from './theme.ts'
import { applyTheme } from './styles.ts'
import { buildLayout, type DisplayRow, type Layout } from './rows.ts'

export enum Focus {
  Tree,
  Content,
}

/**
 * What the file tree lists.
 *
 *   All     → every file in the repo (the default), so a thread can be anchored
 *             anywhere and the tree is never empty
 *   Changes → only files that differ, for working through a review
 *
 * A file with no changes is shown as a diff made entirely of context lines, so the
 * existing renderers handle it unmodified — see diff.ts `contextOnly`.
 */
export enum FileMode {
  Changes,
  All,
}

export function fileModeLabel(m: FileMode): string {
  return m === FileMode.All ? 'ALL' : 'CHANGES'
}

/**
 * Which diff renderer drives the content pane. Cycled by Tab.
 *
 *   Unified → classic unified diff with +/- columns (default)
 *   Split   → old / new side by side
 *   Current → post-change file only: ctx + add (no dels). Shows what the file
 *             looks like AFTER the diff, with the additions still in green.
 */
export enum ViewMode {
  Unified,
  Split,
  Current,
}

export function viewModeLabel(v: ViewMode): string {
  switch (v) {
    case ViewMode.Split:
      return 'SPLIT'
    case ViewMode.Current:
      return 'NORMAL'
    default:
      return 'DIFF'
  }
}

/**
 * The parsed/aligned cache for a single file. Built once per file load and
 * reused for every keystroke until a refresh, a staging operation or a resize
 * invalidates it.
 *
 * `current` is the unified list filtered to ctx + add; `currentIdx` maps each
 * current row back to its index in `unified` so staging keeps working in
 * unified-index space regardless of the active view.
 */
export interface RenderedDiff {
  unified: Line[]
  split: AlignedRow[]
  current: Line[]
  currentIdx: number[]
  /**
   * `new file mode <mode>` from git's diff header, or null when the file exists
   * in HEAD. Captured here because `filterContentLines` throws the header away
   * and `buildPartialPatch` cannot recover it from the lines — see
   * `creationMode` in `src/diff.ts`. Staging is its only reader.
   */
  createMode: string | null
  /**
   * `deleted file mode <mode>` from that same header, or null when the file
   * survives. Same reason, opposite end: without it a fully-selected deletion
   * stages as an empty blob instead of removing the entry, and a truncated file
   * is indistinguishable from a deleted one once the header is gone. See
   * `deletionMode` in `src/diff.ts`.
   */
  deleteMode: string | null
}

/**
 * One queued staging operation.
 *
 * Jobs are plain data rather than closures so the pending map can coalesce them
 * by path: a newer job for a path replaces the older one outright. That is only
 * sound because a job carries the COMPLETE desired state rather than a delta —
 * the same reset-then-apply invariant that makes the patch safe. See the header
 * of `src/staging.ts`.
 */
export type StagingJob =
  | {
      kind: 'partial'
      path: string
      file: ChangedFile
      /** Unified-line indices that should end up in the index. */
      desired: Set<number>
      /** The diff the decision was taken against, held by reference. */
      unified: Line[]
      /**
       * `RenderedDiff.createMode` / `.deleteMode` for that same diff. Carried on
       * the job rather than re-read from the cache when it runs, because
       * `invalidateStagedDiff` can drop the entry while the job waits its turn.
       */
      createMode: string | null
      deleteMode: string | null
    }
  | { kind: 'full'; path: string; file: ChangedFile; want: boolean }

/** Shared empty result for `stagedFor`, so the hot render path allocates nothing. */
const EMPTY_STAGED: ReadonlySet<number> = new Set<number>()

/**
 * The thread list (`c`). `cursor` indexes the THREADS the list shows — in tree
 * order, grouped under their file, minus the resolved ones while `openOnly` —
 * never the rows, since the file headers between them are not selectable.
 * `openOnly` outlives the modal (`App.threadListOpenOnly`): a filter you set is
 * a preference for the session, not for one look.
 */
export interface ThreadListModal {
  cursor: number
  openOnly: boolean
}

/**
 * The inline compose block: a textarea spliced into the diff pane under a card
 * (reply, edit) or under the anchor line (new thread). While it is open the
 * content cursor parks on its first row and every key but `esc` and the save
 * chords goes to the widget.
 */
export interface Compose {
  kind: 'new' | 'reply' | 'edit'
  /** The thread replied to or edited; '' for a new one. */
  threadId: string
  /** New thread only: what it anchors to. */
  file: string
  start: number
  end: number
  /** Edit only: the comment whose body is in the widget. */
  commentId: string
}

/**
 * A yes/no question over the panes — quitting, deleting a thread. `y`/`enter`
 * run `onYes`; `n`/`esc` just close it. There is no pointer here, so the keys
 * are spelled out in the box.
 */
export interface Confirm {
  title: string
  /** What `y` does, in one or two words: `quit`, `delete`. */
  yes: string
  /** What `n` does: `stay`, `keep`. */
  no: string
  onYes: () => void
}

/** The keymap overlay (`k`). Scrollable, because the list outgrows short terminals. */
export interface HelpModal {
  scrollY: number
  /** Visible body rows, written by the renderer so paging knows its step. */
  bodyHeight: number
}

/**
 * The theme picker (`t`).
 *
 * `original` is what to go back to on esc: moving the cursor applies the palette
 * for real, because a swatch cannot tell you whether a theme is comfortable to
 * read a diff in and the diff is right there behind the overlay. That makes esc
 * a genuine undo rather than a way to close a box.
 */
export interface ThemePickerModal {
  cursor: number
  original: string
}

/**
 * The fuzzy file picker. `matches` indexes into App.files and is rebuilt on
 * every keystroke; `positions` holds where each query term matched, for the
 * highlight in the row renderer.
 */
export interface FinderModal {
  cursor: number
  matches: number[]
  positions: number[][]
}

/**
 * The text widgets live in the view layer (they are renderables), so the app
 * reaches them through this narrow interface instead of holding them directly.
 *
 * Deliberately no focus()/blur() here: which widget owns the keyboard is derived
 * from this state on every render. Requesting focus imperatively meant it could
 * be asked for while the widget was still invisible, which silently does nothing
 * — that bug swallowed every keystroke in the compose box.
 */
export interface TextInputs {
  composeValue(): string
  setComposeValue(v: string): void
  finderValue(): string
  setFinderValue(v: string): void
}

/** See `App.cursorIdentity`. */
export interface CursorIdentity {
  /** The diff row under (or last above) the cursor; -1 when there is none. */
  diffIdx: number
  /** The card the cursor was on, or ''. */
  threadId: string
  /** The line within that card (or compose block). */
  line: number
  /** The cursor was on the compose block, which has no id: it goes back onto it. */
  compose: boolean
}

const NO_INPUTS: TextInputs = {
  composeValue: () => '',
  setComposeValue: () => {},
  finderValue: () => '',
  setFinderValue: () => {},
}

export class App {
  source: Source
  repoName = ''
  files: ChangedFile[] = []

  // Tree state.
  nodes: Node[] = []
  flat: FlatNode[] = []
  cursor = 0
  fileMode: FileMode = FileMode.All
  /**
   * Which folders are collapsed, kept per mode. One shared set would mean that
   * collapsing things while browsing the whole repo silently rearranged the much
   * shorter changed-files tree you came from.
   */
  private collapsedByMode: Record<FileMode, Set<string>> = {
    [FileMode.Changes]: new Set(),
    [FileMode.All]: new Set(),
  }

  get collapsed(): Set<string> {
    return this.collapsedByMode[this.fileMode]
  }

  /**
   * Whether ALL mode has had its one-time collapse applied. Only once: doing it on
   * every toggle would throw away folders the user had deliberately opened.
   */
  private allModeCollapsed = false

  // Content state.
  selectedPath = ''
  focus: Focus = Focus.Tree
  viewMode: ViewMode = ViewMode.Unified
  contentCursor = 0
  contentScroll = 0
  selectionAnchor = -1

  // Persisted preferences, mirrored to disk on change so the view can read them
  // every render without touching the filesystem.
  treeAutoHide = defaultUIState().treeAutoHide
  treeWidthPct = defaultUIState().treeWidthPct

  /** The palette in force. Always a built-in name; see `initTheme`. */
  themeName = DEFAULT_THEME_NAME
  /**
   * The name to WRITE to state.json, or '' while the user has never picked one.
   *
   * Deliberately not the same field as `themeName`: persisting the active theme
   * would latch config.toml's `theme = …` into state.json the first time any
   * other preference was saved, and from then on the file would be shadowed by a
   * choice the user never made. Only the picker sets this.
   */
  private themeChoice = ''
  /** config.toml's color keys, re-applied over every base palette. */
  themeOverrides: ThemeOverrides = emptyOverrides()
  /**
   * Bumped on every palette change. The view holds colors on renderables it
   * builds once (pane backgrounds, overlay borders, the text widgets), so it
   * needs to know a repaint is not enough — this is what tells it to restamp
   * them, without diffing palettes on every frame.
   */
  themeEpoch = 0

  /**
   * Destination line for a jump that was requested before the target file's
   * diff finished loading. The load applies it once the cache is populated.
   */
  pendingNavLine = 0
  /**
   * A thread `n`/`N` or the list asked for whose file is not loaded yet — not
   * in the tree (CHANGES mode, so the mode is toggled first) or not in the
   * cache. `loadFiles` and `loadDiffFor` consume it once they can, under their
   * generation guards like `pendingNavLine`.
   */
  pendingJumpThread = ''

  // Caches, keyed by file path.
  cache = new Map<string, RenderedDiff>()
  /** path → set of unified-line indices currently staged in git. */
  staged = new Map<string, Set<number>>()
  loadingDiff = new Set<string>()
  /**
   * path → syntax runs for the file's old and new sides. Populated after the diff
   * itself, because parsing is slower than rendering and must never delay the
   * first paint — the file shows uncolored for a frame, then colors in.
   */
  highlights = new Map<string, DiffHighlights>()

  /**
   * Which "generation" of on-disk state the loads in flight belong to.
   *
   * The rule, and there is only one:
   *
   *   Anything that invalidates the state derived from disk bumps `loadGen`
   *   SYNCHRONOUSLY (that is `clearCaches()`, and only it). Every async load
   *   captures `loadGen` on its first line and writes nothing shared —
   *   `files`/`nodes`/`flat`/`cache`/`staged`/`highlights`/`err`/`loading` — once
   *   its generation has stopped being the current one.
   *
   * This is what makes `tab` safe to fire un-awaited. The intent is synchronous
   * (`fileMode` flips during the key dispatch, because `preventDefault()` only
   * counts there — see `src/dispatch.ts`); what is guarded is the LANDING of the
   * result. Two presses inside git's latency leave two loads in flight, and
   * without this the slower one — `loadAllFiles` runs two git commands to
   * `loadChangedFiles`' one, so it is systematically the slower — overwrote
   * `files` after the mode had flipped back. The header said CHANGES while the
   * tree listed the whole repo.
   *
   * Discarding is the right answer here and it is NOT the right answer for
   * staging: these are READS, where the newest intent invalidates the older one
   * and a dropped result costs nothing, whereas a dropped staging keypress loses
   * the user's work. That is why `src/staging.ts` serializes instead. Don't
   * unify them.
   *
   * The precondition of the whole design: a bump is always immediately followed
   * by a load that will repopulate the screen. Bump before starting, never in
   * the middle — see `onResize()` for the trap.
   */
  private loadGen = 0

  /** The current generation, for loads that live outside this class (`src/relocate.ts`). */
  loadGeneration(): number {
    return this.loadGen
  }

  // ----------------------------------------------------------- staging queue
  // Written synchronously by the key handler, consumed by the serial drain in
  // `src/staging.ts`.

  /**
   * path → the staged set the user has just ASKED for, kept only while that path
   * has work in the queue.
   *
   * `staged` above is git's answer to the PREVIOUS keypress and only lands a
   * reload later. A second press that built its patch from it would describe the
   * first press's line as unstaged and silently drop it, because the patch is a
   * complete desired set and not a delta.
   */
  stagingIntent = new Map<string, Set<number>>()
  /** The same, for the whole-file toggle: true = "I want all of it in the index". */
  stagingFullIntent = new Map<string, boolean>()
  /**
   * At most ONE queued job per path — this map IS the coalescing. A burst of
   * keypresses collapses into one or two git operations carrying the latest
   * intent instead of one operation per press.
   */
  stagingPending = new Map<string, StagingJob>()
  /** The drain in progress, or null when the queue is idle. */
  stagingRunning: Promise<void> | null = null

  /** The review-thread store — `store.threads`, each holding `comments`. */
  store: Store
  /**
   * Where each thread stands against the working tree, by thread id, as of the
   * last relocation pass (`src/relocate.ts`). In memory only: on disk a moved
   * thread's range simply IS its corrected range.
   */
  drift = new Map<string, Drift>()
  /** The store `drift` describes; a different one means a fresh baseline. */
  driftStore: Store | null = null
  /** The most recent relocation pass, for callers that need it settled. */
  relocation: Promise<void> = Promise.resolve()
  threadList: ThreadListModal | null = null
  /** Last `o` setting of the thread list; see `ThreadListModal.openOnly`. */
  threadListOpenOnly = false
  compose: Compose | null = null
  /** Threads whose card shows every comment; the rest are collapsed. */
  expandedThreads = new Set<string>()
  /**
   * Bumped by every in-memory change to what a card shows — a reply, an
   * edit, a status flip, a relocation, a merge in `save()`, a fenced block's
   * highlight landing, a card expanded or collapsed. The layout memo keys on
   * it; `withStableCursor` bumps it for you, and every mutation path that
   * can move rows under the cursor should go through that.
   */
  threadsEpoch = 0
  finder: FinderModal | null = null
  help: HelpModal | null = null
  themePicker: ThemePickerModal | null = null
  /** The yes/no box in force, or null. `q` and `esc` are easy to hit; so is `D`. */
  confirm: Confirm | null = null

  width = 0
  height = 0
  loading = true
  err: Error | null = null

  /**
   * Absolute path of the repo root, and also the process cwd — `main()` chdirs
   * there before anything else. Every path in the app is relative to it, so the
   * only consumers are the edges where a path leaves the process and cannot rely
   * on our cwd (today: the editor argv in `externals.ts`).
   */
  root = ''
  /** Author label for new comments; resolved once at startup. */
  author = 'anon'
  /** Which editor `e` launches, and how it takes a line number. */
  editor: EditorConfig = defaultConfig().editor
  /** How big the floating window for `e` and `g` should be. */
  popup: PopupConfig = defaultConfig().popup
  /** Glyphs for the file tree. */
  icons: IconConfig = defaultConfig().icons

  inputs: TextInputs = NO_INPUTS
  /** Set by the view; invoked after any state mutation. */
  render: () => void = () => {}

  constructor(source: Source, store: Store) {
    this.source = source
    this.store = store
  }

  static async create(source: Source): Promise<App> {
    // A broken/absent store must not stop the reviewer from reviewing, so a file
    // that won't parse yields an empty store and the problem goes to the error
    // banner. `loadOrReadOnly` is what keeps that empty store from being a loaded
    // gun: it never read the file, so it never writes it, and the header says so
    // for as long as that holds.
    const store = await Store.loadOrReadOnly()
    const app = new App(source, store)
    app.err = store.loadError
    const [name, state] = await Promise.all([gitRepoName(), loadState()])
    app.repoName = name
    app.treeAutoHide = state.treeAutoHide
    app.treeWidthPct = state.treeWidthPct
    app.themeChoice = state.themeName
    return app
  }

  /**
   * initTheme settles the startup palette: the picker's last choice if there is
   * one, else config.toml's `theme`, else the default. Called once, after
   * `create()` has read state.json and the config has been parsed.
   *
   * A name neither file agrees on (a theme a later build removed) resolves to
   * the default inside `resolveTheme`; `themeName` is normalized here so the
   * picker's cursor still lands on something real.
   */
  initTheme(configThemeName: string, overrides: ThemeOverrides): void {
    this.themeOverrides = overrides
    const wanted = this.themeChoice !== '' ? this.themeChoice : configThemeName
    this.setTheme(themeByName(wanted) ? wanted : DEFAULT_THEME_NAME)
  }

  /**
   * setTheme swaps the live palette without persisting anything — the picker's
   * live preview, and the startup path. `chooseTheme` is the committing form.
   */
  setTheme(name: string): void {
    this.themeName = name
    applyTheme(resolveTheme(name, this.themeOverrides))
    this.themeEpoch++
  }

  /** chooseTheme is setTheme plus "remember this across sessions". */
  chooseTheme(name: string): void {
    this.setTheme(name)
    this.themeChoice = name
    this.persistState()
  }

  /** The picker's list, in a fixed order so the cursor means something. */
  themeIndex(): number {
    const i = BUILTIN_THEMES.findIndex((t) => t.name === this.themeName)
    return i < 0 ? 0 : i
  }

  /**
   * persistState writes the preference fields. Best effort: failing to remember
   * a preference is annoying, not fatal.
   */
  persistState(): void {
    void saveState({
      treeAutoHide: this.treeAutoHide,
      treeWidthPct: this.treeWidthPct,
      themeName: this.themeChoice,
    }).catch(() => {})
  }

  /**
   * clearCaches drops everything derived from on-disk state, AND cancels the
   * loads already in flight. Called after any operation (external editor, manual
   * refresh, mode switch) that can change what `git status` / `git diff` will
   * report.
   *
   * The generation bump is the second half of that sentence: emptying the maps
   * only helps if the load that was reading git a moment ago cannot refill them
   * with what it found before the change. Every caller — `refresh()`,
   * `toggleFileMode()` and `src/externals.ts` — starts a fresh load immediately
   * afterwards, which is the precondition that keeps the bump from stranding the
   * screen on "Loading…". Bump before starting a load, never in the middle of
   * one.
   *
   * Deliberately NOT the staging intent maps. Their contract is the opposite of
   * this one: they hold what the user has just asked for and git has not been
   * told yet. Clearing them here would send the next keypress back to reading
   * git's stale answer, which is exactly the race the queue exists to close.
   */
  clearCaches(): void {
    this.loadGen++
    this.cache.clear()
    this.staged.clear()
    this.loadingDiff.clear()
    this.highlights.clear()
  }

  /**
   * invalidateStagedDiff drops what a staging write actually made stale, which
   * is strictly less than `clearCaches()` throws away.
   *
   * Writing the index cannot change any file's working tree, and the rendered
   * diff comes from `git diff HEAD` — so `cache` and `highlights` stay valid and
   * only the staged-line set does not. Keeping the rendered diff is what lets a
   * keypress landing mid-operation still work: `toggleStaged` needs the cache to
   * map the cursor to unified indices, and with the cache cleared it returned
   * silently for the whole reload window, losing the press.
   *
   * The path about to be reloaded keeps its entry because `loadFiles()`
   * overwrites it. Any other path (a whole-file toggle from the tree) is dropped
   * instead, or `ensureDiffLoaded` would serve its stale staged marks for ever.
   *
   * Deliberately does NOT bump `loadGen` either, for the same reason: the loads
   * in flight are still reading the same working tree (writing the index cannot
   * change it), so killing them would only cost a repaint. It is why
   * `loadHighlights` keeps its own `cache.has` check on top of the generation
   * guard — this is the one invalidation the generation does not describe.
   */
  invalidateStagedDiff(path: string): void {
    this.staged.delete(path)
    if (path === this.selectedPath) return
    this.cache.delete(path)
    this.highlights.delete(path)
  }

  /**
   * stagedFor is the single answer to "which lines does this file show as
   * staged": the queued intent while one exists, otherwise git's answer. Painting
   * the intent is what makes `space` feel instant — git is ~21 ms behind.
   */
  stagedFor(path: string): ReadonlySet<number> {
    return this.stagingIntent.get(path) ?? this.staged.get(path) ?? EMPTY_STAGED
  }

  /**
   * stagingIdle resolves once the staging queue has drained. For tests and for
   * shutdown paths only — nothing in the key path may await it.
   */
  async stagingIdle(): Promise<void> {
    let p = this.stagingRunning
    while (p !== null) {
      await p
      const next = this.stagingRunning
      // A job can queue more work, so wait for the new drain too — but never
      // spin on a handle that has already settled.
      if (next === p) return
      p = next
    }
  }

  findFile(path: string): ChangedFile | null {
    // Linear scan — `files` is small (typically well under a few hundred).
    return this.files.find((f) => f.path === path) ?? null
  }

  // ---------------------------------------------------------------- loading

  /**
   * listFiles is the one git call `loadFiles` makes, split out so the mode it
   * runs for is an argument rather than a field read mid-expression — and so a
   * test can gate it. `protected` for the second reason only.
   */
  protected async listFiles(mode: FileMode): Promise<ChangedFile[]> {
    return mode === FileMode.All ? loadAllFiles(this.source) : loadChangedFiles(this.source)
  }

  async loadFiles(): Promise<void> {
    // Both captured before the first await: `mode` is what this load is FOR, and
    // `gen` is what makes its result discardable. See `loadGen`.
    const gen = this.loadGen
    const mode = this.fileMode
    // Threads are re-anchored alongside the git call — independent work under
    // the same generation — and awaited below so the corrected ranges are on
    // screen with the tree. See `src/relocate.ts`.
    const relocated = relocateThreads(this)
    this.relocation = relocated
    let files: ChangedFile[]
    try {
      files = await this.listFiles(mode)
    } catch (err) {
      // A discarded load's failure must not paint the banner over a healthy view
      // — the banner replaces the whole tree pane. The load that superseded us
      // owns `err` and `loading` now.
      if (gen !== this.loadGen) return
      this.loading = false
      this.err = err as Error
      this.render()
      return
    }
    await relocated
    // One guard, above the WHOLE application block: the cursor clamp and the
    // selection handling below belong to the current tree as much as `files`
    // does, and a stale load must touch neither.
    if (gen !== this.loadGen) return
    this.files = files
    this.loading = false
    // Resolved once, from `mode`, rather than through the `collapsed` getter,
    // which reads `this.fileMode` at call time. Under the guard the two agree;
    // spelling it out is what stops them drifting apart again — a tree built for
    // ALL flattened against the CHANGES set is how the contradiction started.
    const collapsed = this.collapsedByMode[mode]
    this.nodes = buildTree(this.files)
    this.flat = flatten(this.nodes, collapsed)
    // Fold ALL down once — on the first load or the first toggle into it, whichever
    // comes first. A repo of hundreds of files is unreadable fully expanded, but
    // doing it on every load would keep closing folders the user just opened.
    // Stays UNDER the guard: a discarded load must not consume the one-time flag.
    if (mode === FileMode.All && !this.allModeCollapsed) {
      this.allModeCollapsed = true
      this.collapseAllButPath(this.selectedPath, collapsed)
      this.flat = flatten(this.nodes, collapsed)
    }
    if (this.cursor >= this.flat.length) {
      this.cursor = this.flat.length > 0 ? this.flat.length - 1 : 0
    }
    // A jump that had to wait for this tree — `n` onto a thread whose file only
    // ALL lists. Past the guard, so `revealPath` opens the right mode's folders.
    if (this.pendingJumpThread !== '') {
      const i = this.store.indexOfThread(this.pendingJumpThread)
      const t = i >= 0 ? this.store.threads[i] : null
      if (t && this.findFile(t.file)) this.jumpToThread(t)
      else this.pendingJumpThread = ''
    }
    if (this.selectedPath !== '') {
      const file = this.findFile(this.selectedPath)
      if (file) {
        this.render()
        await this.loadDiffFor(file)
        return
      }
      // File is no longer present — clear the right pane.
      this.selectedPath = ''
      this.contentCursor = 0
      this.contentScroll = 0
      this.focus = Focus.Tree
    }
    this.render()
  }

  /**
   * loadDiffPair runs the working-tree diff and the two index diffs
   * concurrently and derives the staged-line indices from them. Shared by the
   * UI refresh and the full-file stage/unstage decision. `protected` so a test
   * can gate it.
   *
   * Three diffs, because the staged set is attributed by line number and each
   * kind of row is numbered on a different side: a Del row is HEAD line
   * `oldNum`, staged iff `git diff --cached HEAD` deletes that line; an Add row
   * is working-tree line `newNum`, staged iff the index→worktree `git diff`
   * does NOT add it. Never by content — see `computeStagedIndices`.
   */
  protected async loadDiffPair(file: ChangedFile): Promise<{
    combined: Line[]
    aligned: AlignedRow[]
    stagedIdx: Set<number> | null
    createMode: string | null
    deleteMode: string | null
  }> {
    // A file with no changes has no diff to ask git for; it is displayed as one
    // made entirely of context lines instead. Only reachable in ALL mode.
    if (!isChanged(file)) {
      const combined = await this.readAsContext(file.path)
      return {
        combined,
        aligned: align(combined),
        stagedIdx: null,
        createMode: null,
        deleteMode: null,
      }
    }
    const [combinedText, stagedText, unstagedText] = await Promise.all([
      loadDiff(this.source, file),
      loadStagedDiff(this.source, file).catch(() => ''),
      loadUnstagedDiff(this.source, file),
    ])
    const combined = filterContentLines(parse(combinedText))
    const aligned = align(combined)
    // Read before the header lines are filtered out. Both of `loadDiff`'s
    // uncommitted branches answer this the same way — `git diff HEAD` for an
    // `A`/`AM` file and `git diff --no-index -- /dev/null <path>` for a `?` one
    // both emit `new file mode` — so one rule covers every file missing from
    // HEAD, including the new half of a rename.
    const createMode = creationMode(combinedText)
    // Read from the same text and for the same reason: a file the user deleted
    // and one they truncated to zero bytes leave identical `Line[]`, and only
    // the header separates "remove the entry" from "stage an empty blob".
    const deleteMode = deletionMode(combinedText)
    const stagedIdx = stagedIndicesFromDiffs(combined, stagedText, unstagedText)
    return { combined, aligned, stagedIdx, createMode, deleteMode }
  }

  /**
   * readAsContext loads a file for display in ALL mode.
   *
   * Two guards, because ALL mode lists whatever is in the repo — images, fixtures,
   * lockfiles — not just source. Neither is worth rendering as text, and reading a
   * huge one would stall the UI, so both get a one-line placeholder.
   */
  private async readAsContext(path: string): Promise<Line[]> {
    const MAX_BYTES = 2 * 1024 * 1024
    try {
      // `path` is repo-root-relative and `Bun.file` resolves against the cwd, so
      // this is only correct because `main()` chdirs to the root at startup.
      const f = Bun.file(path)
      const size = f.size
      if (size > MAX_BYTES) {
        return contextOnly(`(${Math.round(size / 1024)} KB — too large to display)`)
      }
      const text = await f.text()
      // A NUL byte is the usual heuristic, and the one git itself uses.
      if (text.includes('\u0000')) return contextOnly('(binary file)')
      return contextOnly(text)
    } catch (err) {
      return contextOnly(`(cannot read: ${(err as Error).message})`)
    }
  }

  async loadDiffFor(file: ChangedFile): Promise<void> {
    const gen = this.loadGen
    this.loadingDiff.add(file.path)
    try {
      const { combined, aligned, stagedIdx, createMode, deleteMode } = await this.loadDiffPair(file)
      // Above `cache.set`, above `staged.set`, and above `navigateToPendingLine`:
      // a discarded load that refilled the cache would put the PRE-staging diff
      // back after `clearCaches()` had dropped it, and one that consumed
      // `pendingNavLine` would lose the jump for good. The `file.path ===
      // this.selectedPath` check below answers a different question — "is this
      // file still the visible one?" — and both are needed.
      //
      // Returning from inside the `try` still runs the `finally`, so
      // `loadingDiff` is cleaned up; it skips the trailing `render()` and
      // `loadHighlights()`, which is what we want for a result nobody will show.
      if (gen !== this.loadGen) return
      const { out: current, idx: currentIdx } = filterCurrentView(combined)
      this.cache.set(file.path, {
        unified: combined,
        split: aligned,
        current,
        currentIdx,
        createMode,
        deleteMode,
      })
      if (stagedIdx) this.staged.set(file.path, stagedIdx)
      else this.staged.delete(file.path)
      // The file was just read by git; its threads follow. Not awaited — the
      // diff paints now and the pass re-renders if anything moved.
      this.relocation = relocateThreads(this, [file.path])

      // Preserve cursor/scroll across reloads (staging, resize, refresh); clamp
      // to the new row count and drop a stale selection.
      if (file.path === this.selectedPath) {
        if (this.pendingNavLine > 0) this.navigateToPendingLine()
        if (this.pendingJumpThread !== '') this.landOnPendingThread()
        this.clampCursor()
        this.ensureCursorVisible()
      }
    } catch (err) {
      // Same rule as `loadFiles`: a superseded load does not get to paint the
      // banner over the view that replaced it.
      if (gen !== this.loadGen) return
      this.err = err as Error
    } finally {
      this.loadingDiff.delete(file.path)
    }
    this.render()
    void this.loadHighlights(file.path)
  }

  /**
   * loadHighlights parses the file for syntax colors and repaints when done.
   * Best-effort and non-blocking: an unsupported language or a tree-sitter failure
   * just leaves the diff in its plain colors.
   */
  private async loadHighlights(path: string): Promise<void> {
    const gen = this.loadGen
    if (this.highlights.has(path)) return
    const cached = this.cache.get(path)
    if (!cached) return
    const hl = await highlightDiff(path, cached.unified)
    // These runs describe `cached.unified`. Two ways it can stop being the diff
    // on screen while tree-sitter parses, and they do not overlap:
    // an invalidation (generation bumped — and a reload may already have put a
    // DIFFERENT diff back under this key, which `cache.has` would happily
    // accept), or a staging write dropping this path's entry on its own
    // (`invalidateStagedDiff`, which deliberately leaves the generation alone).
    if (gen !== this.loadGen) return
    if (!this.cache.has(path)) return
    this.highlights.set(path, hl)
    if (path === this.selectedPath) this.render()
  }

  /** Syntax runs for the selected file; empty when unavailable. */
  activeHighlights(): DiffHighlights {
    return this.highlights.get(this.selectedPath) ?? NO_HIGHLIGHTS
  }

  /** ensureDiffLoaded kicks off a load unless it is cached or already running. */
  ensureDiffLoaded(file: ChangedFile): void {
    if (this.cache.has(file.path) || this.loadingDiff.has(file.path)) return
    void this.loadDiffFor(file)
  }

  /**
   * refresh re-reads the store and the whole change set.
   *
   * Deliberately does NOT clear `err`. Staging and external processes finish by
   * refreshing, and clearing here wiped the very error they had just recorded —
   * which is why failures used to vanish instead of reaching the banner. The
   * explicit `r` binding clears it before calling this.
   */
  async refresh(): Promise<void> {
    // What the cursor is on, before the store and the diff are replaced: the
    // thread cards a reload brings in or takes out move every row under it.
    const at = this.selectedPath !== '' ? this.cursorIdentity() : null
    this.clearCaches()
    const gen = this.loadGen
    // Let any save in flight finish first. It is about to be replaced by a fresh
    // store, and a store dropped mid-save takes its unwritten edits with it.
    await this.store.flush()
    // Pick up edits the VSCode extension or an agent may have made to
    // .refiner/comments.json since the last refresh.
    try {
      this.store = await Store.load()
    } catch (err) {
      // Keep the in-memory store rather than losing the reviewer's context, but
      // stop it writing: what is on disk now is not what we are holding, and a
      // save is a whole-file replace.
      //
      // Deliberately does NOT set `err`. This runs after every staging operation
      // and on every watcher event, and the banner replaces the entire tree pane
      // (`src/view.ts` buildTree), so setting it here would make the file list
      // vanish each time a line is staged while the file is broken. The signal
      // instead rides the header, which costs no rows and — being derived from
      // `store.readOnly` rather than latched — cannot be dismissed by `r` while
      // the store is still poisoned. The full explanation arrives at the moment
      // it is actionable: when the reviewer tries to write.
      this.store.markUnreadable(err as Error)
    }
    // Only the file reload is discardable, and the guard sits here — BELOW the
    // store half — on purpose. Waiting for the save in flight and poisoning a
    // store whose file broke under us are facts about the disk, not about which
    // view is current: skipping either would leave a store that thinks it is
    // synced with bytes it never read. What a superseded refresh must not do is
    // spend a `git status` on a change set somebody newer is already loading.
    if (gen !== this.loadGen) return
    // The fresh store is a new layout; the memo keys on its identity.
    this.threadsEpoch++
    await this.loadFiles()
    if (gen !== this.loadGen || at === null) return
    if (this.selectedPath !== '' && this.cache.has(this.selectedPath)) this.restoreCursor(at)
  }

  async onResize(width: number, height: number): Promise<void> {
    this.width = width
    this.height = height
    // Split-side widths depend on terminal size, so the aligned cache is stale.
    //
    // `cache.clear()` and NOT `clearCaches()`, however tempting the tidy-up
    // looks: this is the one invalidation that can run with nothing selected —
    // a resize during startup is perfectly ordinary — and the generation bump
    // would then kill the very first `loadFiles()` with nothing queued to
    // replace it. `loading` would stay true and "Loading…" is the whole tree
    // pane. The rule is bump-then-load; here there may be no load.
    this.cache.clear()
    const file = this.selectedPath !== '' ? this.findFile(this.selectedPath) : null
    if (file) await this.loadDiffFor(file)
    else this.render()
  }

  // ------------------------------------------------------------- selection

  /** True when the selected file actually differs; false for ALL-mode browsing. */
  isFileChanged(path: string): boolean {
    const f = this.findFile(path)
    return f !== null && isChanged(f)
  }

  /**
   * The view actually rendered, as opposed to the one Tab has cycled to.
   *
   * A file with no changes only makes sense in the post-change view: the other two
   * would show the same text twice, or against an empty column. The stored
   * preference is left alone so it comes back when you move to a file that has a
   * real diff.
   */
  effectiveViewMode(): ViewMode {
    if (this.selectedPath !== '' && !this.isFileChanged(this.selectedPath)) {
      return ViewMode.Current
    }
    return this.viewMode
  }

  /**
   * toggleFileMode switches the tree between the changed files and the whole repo.
   *
   * Entering ALL collapses every folder except the ones leading to the selected
   * file — a repo of a few hundred files is unreadable fully expanded. Leaving it
   * drops a selection that has no changes, since it would not be in the list.
   *
   * Fired un-awaited from the key handler, so it can overlap itself: the prologue
   * below is the user's intent and stays immediate, while the reload it starts is
   * discardable. `clearCaches()` is the generation bump that makes the older of
   * two in-flight toggles land nowhere.
   */
  async toggleFileMode(): Promise<void> {
    this.fileMode = this.fileMode === FileMode.Changes ? FileMode.All : FileMode.Changes

    // Going back to CHANGES with an untouched file selected would leave the diff
    // pane showing something the tree no longer lists.
    if (this.fileMode === FileMode.Changes && this.selectedPath !== '') {
      if (!this.isFileChanged(this.selectedPath)) {
        this.selectedPath = ''
        this.contentCursor = 0
        this.selectionAnchor = -1
        this.focus = Focus.Tree
      }
    }

    this.clearCaches()
    const gen = this.loadGen
    // Must come before collapsing: the folders to collapse are the ones in the tree
    // we are switching TO, and loadFiles is what builds it.
    await this.loadFiles()

    // The epilogue moves the cursor over `flat`, which by now may belong to a
    // later toggle. Its own epilogue will do this for its own tree.
    if (gen !== this.loadGen) return
    if (this.cursor >= this.flat.length) this.cursor = Math.max(0, this.flat.length - 1)
    // Past the guard, so `collapsed` is this tree's own set: the file carried
    // across the toggle is opened up and pointed at in the mode we landed in.
    this.revealPath(this.selectedPath)
    this.render()
  }

  /**
   * Collapse everything, then reopen just the folders on the way to `path`.
   *
   * The set is a parameter rather than the `collapsed` getter: the caller knows
   * which mode's tree it just built, and the getter answers for whatever mode is
   * active when it runs, which after an interleaved toggle is the other one.
   */
  private collapseAllButPath(path: string, collapsed: Set<string>): void {
    collapsed.clear()
    const walk = (nodes: Node[]): void => {
      for (const n of nodes) {
        if (n.type !== 'dir') continue
        collapsed.add(n.path)
        walk(n.children)
      }
    }
    walk(this.nodes)
    if (path === '') return
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) collapsed.delete(parts.slice(0, i).join('/'))
  }

  /**
   * revealPath opens the folders on the way to `path` and parks the tree cursor
   * on it, so the file in the diff pane is also the file the tree is pointing at.
   * The pane scrolls to follow, because its window is derived from the cursor.
   *
   * Every jump that moves the diff pane WITHOUT walking the tree calls this: the
   * mode toggle, the finder, a thread. Each one leaves the cursor wherever it
   * was, and the row it should be on is routinely folded away inside a collapsed
   * folder — most of ALL mode is collapsed by construction. Merely parking the
   * cursor "if the row happens to be visible" is what those callers used to do,
   * and it silently did nothing in exactly that case.
   *
   * Opening folders is a deliberate side effect on the collapse set, and it
   * survives: coming back to a mode leaves it showing the file you left on.
   *
   * `collapsed` answers for whatever mode is active when it runs (see
   * `collapseAllButPath`), so a caller inside an overlapping load must be past
   * its generation guard before calling this — the tree and the set have to be
   * the same mode's.
   */
  revealPath(path: string): void {
    if (path === '') return
    const parts = path.split('/')
    let opened = false
    for (let i = 1; i < parts.length; i++) {
      if (this.collapsed.delete(parts.slice(0, i).join('/'))) opened = true
    }
    if (opened) this.flat = flatten(this.nodes, this.collapsed)
    const i = this.flat.findIndex((f) => f.node.type === 'file' && f.node.path === path)
    if (i >= 0) this.cursor = i
  }

  /** Inclusive [start, end] over DISPLAY rows; consumers skip the non-diff ones. */
  selectionRange(): [number, number] {
    if (this.selectionAnchor < 0) return [this.contentCursor, this.contentCursor]
    return this.selectionAnchor <= this.contentCursor
      ? [this.selectionAnchor, this.contentCursor]
      : [this.contentCursor, this.selectionAnchor]
  }

  hasSelection(): boolean {
    return this.selectionAnchor >= 0 && this.selectionAnchor !== this.contentCursor
  }

  /**
   * Row count of the active DIFF array — not what the cursor ranges over. The
   * minimap keys its marks off it; everything cursor-shaped wants
   * `displayRowCount()`.
   */
  activeRowCount(): number {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return 0
    switch (this.effectiveViewMode()) {
      case ViewMode.Split:
        return cached.split.length
      case ViewMode.Current:
        return cached.current.length
      default:
        return cached.unified.length
    }
  }

  /** How many rows the cursor can stand on: diff rows plus card and compose rows. */
  displayRowCount(): number {
    return this.activeLayout().rows.length
  }

  /** The active diff idx under display row `d`, or -1 on a card or compose row. */
  diffIdxAt(d: number): number {
    const row = this.activeLayout().rows[d]
    return row?.kind === 'diff' ? row.idx : -1
  }

  /** Display idx of active diff row `idx`, or -1 when out of range. */
  displayIdxOfDiff(idx: number): number {
    return this.activeLayout().diffToDisplay[idx] ?? -1
  }

  cursorRow(): DisplayRow | null {
    return this.activeLayout().rows[this.contentCursor] ?? null
  }

  /** The thread whose card the cursor is on (any of its rows), or null. */
  threadAtCursor(): StoredThread | null {
    const row = this.cursorRow()
    if (row?.kind !== 'card') return null
    const i = this.store.indexOfThread(row.threadId)
    return i >= 0 ? this.store.threads[i] : null
  }

  /** Display idx of a thread's card header, or -1 when it is not in this file's layout. */
  cardStartOf(threadId: string): number {
    return this.activeLayout().cardStart.get(threadId) ?? -1
  }

  /**
   * Keep the cursor and the selection inside the rows that exist. A no-op
   * while the file's diff is not loaded: there are no rows to clamp to, and
   * zeroing the cursor during a reload would lose the place the reload is
   * about to restore.
   */
  clampCursor(): void {
    if (!this.cache.has(this.selectedPath)) return
    const n = this.displayRowCount()
    if (this.selectionAnchor >= n) this.selectionAnchor = -1
    if (this.contentCursor >= n) this.contentCursor = Math.max(0, n - 1)
    if (this.contentCursor < 0) this.contentCursor = 0
  }

  /**
   * What the cursor is on, in terms that survive a layout change: the card
   * (by thread id) and the line within it, or the diff row. Both are kept for
   * a card row, so a card that vanishes — its thread deleted — drops the
   * cursor onto the code it sat under.
   */
  cursorIdentity(): CursorIdentity {
    const rows = this.activeLayout().rows
    const row = rows[this.contentCursor]
    if (!row) return { diffIdx: -1, threadId: '', line: 0, compose: false }
    if (row.kind === 'diff') return { diffIdx: row.idx, threadId: '', line: 0, compose: false }
    let diffIdx = -1
    for (let d = this.contentCursor; d >= 0; d--) {
      const r = rows[d]!
      if (r.kind === 'diff') {
        diffIdx = r.idx
        break
      }
    }
    return {
      diffIdx,
      threadId: row.kind === 'card' ? row.threadId : '',
      line: row.line,
      compose: row.kind === 'compose',
    }
  }

  /** Put the cursor back on what `cursorIdentity()` described, in the layout as it is now. */
  restoreCursor(id: CursorIdentity): void {
    if (!this.cache.has(this.selectedPath)) return
    const composeStart = id.compose && this.compose ? this.activeLayout().composeStart : -1
    const start = id.threadId === '' ? -1 : this.cardStartOf(id.threadId)
    if (composeStart >= 0) {
      this.contentCursor = composeStart + id.line
      this.clampCursor()
      this.revealCompose()
      return
    }
    if (start >= 0) {
      const row = this.activeLayout().rows[start]
      const lines = row?.kind === 'card' ? row.lines : 1
      this.contentCursor = start + Math.min(id.line, lines - 1)
    } else if (id.diffIdx >= 0) {
      const d = this.displayIdxOfDiff(id.diffIdx)
      if (d >= 0) this.contentCursor = d
    }
    this.clampCursor()
    this.ensureCursorVisible()
  }

  /**
   * revealCompose scrolls so the WHOLE compose block is on screen, cursor on
   * its first row. `ensureCursorVisible` only answers for one row, and a block
   * half off the pane is a hidden textarea with the keyboard still in it — see
   * `View.renderCompose`. Used when the block opens and again after anything
   * that can move it: a resize, a reload, a relocation.
   */
  revealCompose(): void {
    const layout = this.activeLayout()
    const start = layout.composeStart
    if (start < 0) return
    const row = layout.rows[start]
    const lines = row?.kind === 'compose' ? row.lines : 1
    this.contentCursor = start + lines - 1
    this.ensureCursorVisible()
    this.contentCursor = start
    this.ensureCursorVisible()
  }

  /**
   * withStableCursor runs a mutation that changes the rows — a reply, a card
   * expanded, a thread relocated — and keeps the cursor on the same thing
   * rather than the same index. It bumps `threadsEpoch` itself, so a caller
   * cannot mutate and forget to invalidate the layout.
   */
  withStableCursor(fn: () => void): void {
    const id = this.cursorIdentity()
    fn()
    this.threadsEpoch++
    this.restoreCursor(id)
  }

  /**
   * Which of the active view's rows are part of a change, flattened to a flat
   * boolean list so hunk-finding doesn't need to know which view is on screen.
   */
  private changedRowFlags(): boolean[] {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return []
    switch (this.effectiveViewMode()) {
      case ViewMode.Split:
        return cached.split.map(
          (r) => r.kind === RowKind.Add || r.kind === RowKind.Del || r.kind === RowKind.Mod,
        )
      case ViewMode.Current:
        // Deletions aren't shown here, so an add is the only visible change.
        return cached.current.map((l) => l.kind === LineKind.Add)
      default:
        return cached.unified.map((l) => l.kind === LineKind.Add || l.kind === LineKind.Del)
    }
  }

  /**
   * jumpToHunk moves the cursor to the start of the next (`+1`) or previous (`-1`)
   * block of changed lines.
   *
   * Wraps around, like the tree cursor does: on a file whose only change is near
   * the top, stopping dead at the last hunk would leave you pressing a key that
   * does nothing. A file with no changes has no hunks and this is a no-op.
   */
  jumpToHunk(delta: 1 | -1): void {
    // Found in diff space, compared and landed in display space: the cursor
    // may be standing on a card between two hunks.
    const starts = hunkStarts(this.changedRowFlags()).map((i) => this.displayIdxOfDiff(i))
    if (starts.length === 0) return

    let target: number
    if (delta === 1) {
      target = starts.find((i) => i > this.contentCursor) ?? starts[0]
    } else {
      // The cursor usually sits ON a hunk start, and "previous" should then mean
      // the one before it, not the one it is already on.
      target = [...starts].reverse().find((i) => i < this.contentCursor) ?? starts[starts.length - 1]
    }
    this.contentCursor = target
    this.selectionAnchor = -1
    // Centered, not merely visible: landing on the pane's edge would show the
    // hunk's first line and nothing under it, which is the part you came to read.
    this.centerCursor()
  }

  /** How many separate blocks of changed lines the active view holds. */
  hunkCount(): number {
    return hunkStarts(this.changedRowFlags()).length
  }

  /**
   * The working-tree line number the content cursor sits on: the row's
   * `newNum`, or the thread's last line on a card row, or the anchor's last
   * line on a compose row.
   */
  cursorLine(): number {
    const row = this.cursorRow()
    if (!row) return 0
    if (row.kind === 'card') return this.threadAtCursor()?.range.end ?? 0
    if (row.kind === 'compose') {
      const c = this.compose
      if (!c) return 0
      if (c.kind === 'new') return c.end
      const i = this.store.indexOfThread(c.threadId)
      return i >= 0 ? this.store.threads[i].range.end : 0
    }
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return 0
    switch (this.effectiveViewMode()) {
      case ViewMode.Split:
        return cached.split[row.idx]?.newNum ?? 0
      case ViewMode.Current:
        return cached.current[row.idx]?.newNum ?? 0
      default:
        return cached.unified[row.idx]?.newNum ?? 0
    }
  }

  /**
   * navigateToPendingLine scans the active cache for a row whose working-tree
   * line number matches the pending target and parks the cursor there.
   */
  navigateToPendingLine(): void {
    if (this.pendingNavLine === 0 || this.selectedPath === '') return
    const target = this.pendingNavLine
    this.pendingNavLine = 0
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return

    const rows: { newNum: number }[] =
      this.effectiveViewMode() === ViewMode.Split
        ? cached.split
        : this.effectiveViewMode() === ViewMode.Current
          ? cached.current
          : cached.unified
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].newNum === target) {
        this.contentCursor = this.displayIdxOfDiff(i)
        this.selectionAnchor = -1
        this.ensureCursorVisible()
        return
      }
    }
  }

  /**
   * jumpToThread points the pane at a thread: reveal its file, expand its
   * card, park the cursor on the header, centered. A file the tree does not
   * list (CHANGES mode) means switching to ALL first; a file not yet cached
   * means waiting for its diff. Both wait through `pendingJumpThread`.
   */
  jumpToThread(t: StoredThread): void {
    this.expandedThreads.add(t.id)
    this.threadsEpoch++
    const file = this.findFile(t.file)
    if (!file) {
      if (this.fileMode === FileMode.Changes) {
        this.pendingJumpThread = t.id
        void this.toggleFileMode()
      } else {
        // ALL lists everything there is: this file is not in the repo.
        this.err = new Error(`thread's file is not in the repo: ${t.file}`)
      }
      return
    }
    if (this.selectedPath !== t.file) {
      this.selectedPath = t.file
      this.contentCursor = 0
      this.contentScroll = 0
    }
    this.selectionAnchor = -1
    this.revealPath(t.file)
    this.focus = Focus.Content
    this.pendingJumpThread = t.id
    if (this.cache.has(t.file)) {
      this.landOnPendingThread()
      return
    }
    this.ensureDiffLoaded(file)
  }

  /** Finish a `jumpToThread` once the file's layout exists. */
  private landOnPendingThread(): void {
    const id = this.pendingJumpThread
    this.pendingJumpThread = ''
    const start = this.cardStartOf(id)
    if (start < 0) return
    this.contentCursor = start
    this.selectionAnchor = -1
    this.centerCursor()
  }

  /** Expand or collapse one card, keeping the cursor on what it was on. */
  toggleExpanded(id: string): void {
    this.withStableCursor(() => {
      if (!this.expandedThreads.delete(id)) this.expandedThreads.add(id)
    })
  }

  /** `z`: expand every card in the file if any is collapsed, else collapse them all. */
  toggleAllExpanded(): void {
    const threads = this.store.threadsForFile(this.selectedPath)
    if (threads.length === 0) return
    const anyCollapsed = threads.some((t) => !this.expandedThreads.has(t.id))
    this.withStableCursor(() => {
      for (const t of threads) {
        if (anyCollapsed) this.expandedThreads.add(t.id)
        else this.expandedThreads.delete(t.id)
      }
    })
  }

  /** Counts for the header: `open` and `resolved` threads. */
  threadCounts(): { open: number; resolved: number } {
    let open = 0
    let resolved = 0
    for (const t of this.store.threads) {
      if (t.status === 'resolved') resolved++
      else open++
    }
    return { open, resolved }
  }

  // ---------------------------------------------------------------- layout
  // All derived from width/height so the view stays a pure function of state.
  // The panes are borderless: the only chrome is the four rows off the top (the
  // header, its rule, the pane titles and the lighter rule under them) and the
  // one column of rule between the panes.

  /** True when the tree pane is currently zero-width. */
  treeHidden(): boolean {
    return this.treeAutoHide && this.focus !== Focus.Tree
  }

  treePanelWidth(): number {
    if (this.treeHidden()) return 0
    const pct = Math.min(70, Math.max(15, this.treeWidthPct))
    return Math.max(24, Math.floor((this.width * pct) / 100))
  }

  /** The rule dividing the panes; zero columns when the tree is hidden. */
  paneRuleWidth(): number {
    return this.treeHidden() ? 0 : 1
  }

  diffPanelWidth(): number {
    return Math.max(20, this.width - this.treePanelWidth() - this.paneRuleWidth())
  }

  /**
   * Rows available inside a pane.
   *
   * Four rows of chrome, each of them a line of information or a divider: the
   * header, the rule under it, the pane titles, and the lighter rule under
   * those. There is no footer — the keymap moved into the `k` overlay — and the
   * panes have no borders, so a pane runs from there to the last row of the
   * terminal.
   */
  paneInnerHeight(): number {
    return Math.max(1, this.height - 4)
  }

  /**
   * ensureCursorVisible scrolls contentScroll so contentCursor is in view.
   * Idempotent; safe after any cursor move.
   */
  ensureCursorVisible(): void {
    const h = this.paneInnerHeight()
    if (this.contentCursor < this.contentScroll) {
      this.contentScroll = this.contentCursor
    } else if (this.contentCursor >= this.contentScroll + h) {
      this.contentScroll = this.contentCursor - h + 1
    }
    // The row count shrinks whenever a card folds, resolves or goes away, and
    // a scroll left past the new end paints one row and a pane of blanks.
    if (this.cache.has(this.selectedPath)) {
      this.contentScroll = Math.min(this.contentScroll, Math.max(0, this.displayRowCount() - h))
    }
    if (this.contentScroll < 0) this.contentScroll = 0
  }

  /**
   * centerCursor puts the cursor row in the middle of the pane.
   *
   * For a jump — as opposed to a one-row move — the minimal scroll of
   * ensureCursorVisible is the wrong behaviour: it parks the target on the very
   * edge, showing its first line and none of what follows, so you have to scroll
   * anyway to see what you jumped to.
   *
   * Clamped at both ends, so a hunk near the start or the end of the file sits as
   * close to the middle as the file allows rather than leaving the pane half empty.
   */
  centerCursor(): void {
    const h = this.paneInnerHeight()
    const maxScroll = Math.max(0, this.displayRowCount() - h)
    const centered = this.contentCursor - Math.floor(h / 2)
    this.contentScroll = Math.min(maxScroll, Math.max(0, centered))
  }

  // -------------------------------------------------------------- staging

  /** Every change to the file is in git's index (derived from porcelain XY). */
  isFileFullyStaged(path: string): boolean {
    const f = this.findFile(path)
    return f ? fullyStaged(f) : false
  }

  /** How many files have all their changes in the index (header label). */
  stagedFileCount(): number {
    return this.files.filter((f) => fullyStaged(f)).length
  }

  // -------------------------------------------------------------- threads

  /**
   * lineHasThread reports whether a working-tree line has a thread anchored to
   * it. Called per row during render, so it must stay O(threads in file) —
   * which the store's byFile index guarantees.
   */
  lineHasThread(path: string, newLine: number): boolean {
    if (newLine <= 0 || path === '') return false
    return this.store.threadAt(path, newLine) !== null
  }

  fileHasThreads(path: string): boolean {
    if (path === '') return false
    return this.store.hasThreadsFor(path)
  }

  /** Where `id` stands against the working tree, or null before any pass has seen it. */
  threadDrift(id: string): Drift | null {
    return this.drift.get(id) ?? null
  }

  // ----------------------------------------------------------- display rows
  // The diff pane shows the active diff's rows with the thread cards spliced
  // in (`src/rows.ts`). The cursor, the scroll and the selection index THOSE
  // rows; staging and hunks index the diff and map through `diffIdxAt`.

  /**
   * Text columns inside the diff pane: its width minus one column of padding
   * each side. Mirrors the view's box, so the app can build the same layout the
   * view draws without being handed a width.
   */
  contentWidth(): number {
    return Math.max(1, this.diffPanelWidth() - 2)
  }

  /**
   * The layout the pane is drawing: built at the full content width, or one
   * column narrower when the rows overflow the pane and the last column goes to
   * the scrollbar. Both are memoized, so asking is cheap.
   */
  activeLayout(): Layout {
    const w = this.contentWidth()
    const full = this.layout(w)
    return full.rows.length > this.paneInnerHeight() ? this.layout(Math.max(1, w - 1)) : full
  }

  /** The two most recent widths' layouts, with what they were built from. */
  private layoutMemo = new Map<number, { key: readonly unknown[]; layout: Layout }>()

  /**
   * layout is `buildLayout` memoized on everything it reads: the file, the
   * view, the diff and store objects, `threadsEpoch`, the compose block and
   * the palette (card rows carry resolved colors). Two slots, because the view
   * asks for `w` and then `w - 1` on every frame that has a scrollbar.
   */
  layout(contentW: number): Layout {
    const key = [
      this.selectedPath,
      this.effectiveViewMode(),
      this.cache.get(this.selectedPath),
      this.store,
      this.threadsEpoch,
      this.compose,
      this.themeEpoch,
    ] as const
    const slot = this.layoutMemo.get(contentW)
    if (slot && slot.key.every((k, i) => k === key[i])) return slot.layout
    const layout = buildLayout(this, contentW)
    this.layoutMemo.delete(contentW)
    this.layoutMemo.set(contentW, { key, layout })
    while (this.layoutMemo.size > 2) {
      this.layoutMemo.delete(this.layoutMemo.keys().next().value!)
    }
    return layout
  }

  // ---------------------------------------------------------------- labels

  contentLineLabel(): string {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return '—'
    const row = this.cursorRow()
    if (!row) return '—'
    // The counts stay in diff rows: `row/total` is "where in the file", and a
    // card is not part of the file.
    const total = this.activeRowCount()
    if (row.kind === 'card') return `thread · ${row.line + 1}/${row.lines}`
    if (row.kind === 'compose') return 'compose'
    switch (this.effectiveViewMode()) {
      case ViewMode.Split: {
        const r = cached.split[row.idx]
        if (!r) return '—'
        return formatLineLabel(r.oldNum, r.newNum, row.idx + 1, total)
      }
      case ViewMode.Current: {
        const l = cached.current[row.idx]
        if (!l) return '—'
        return formatLineLabel(l.oldNum, l.newNum, row.idx + 1, total)
      }
      default: {
        const l = cached.unified[row.idx]
        if (!l) return '—'
        return formatLineLabel(l.oldNum, l.newNum, row.idx + 1, total)
      }
    }
  }

  modeLabel(): string {
    return this.source.mode === Mode.Review ? `review · ${this.source.target}` : 'uncommitted'
  }
}

function formatLineLabel(oldNum: number, newNum: number, row: number, total: number): string {
  if (newNum > 0 && oldNum > 0 && newNum !== oldNum) {
    return `L ${oldNum}→${newNum} · ${row}/${total}`
  }
  if (newNum > 0) return `L ${newNum} · ${row}/${total}`
  if (oldNum > 0) return `L -${oldNum} · ${row}/${total}`
  return `· ${row}/${total}`
}

/** True for line kinds that can be staged (context lines cannot). */
export function isStageable(kind: LineKind): boolean {
  return kind === LineKind.Add || kind === LineKind.Del
}
