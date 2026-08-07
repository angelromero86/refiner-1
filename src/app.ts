/**
 * The whole application state, plus the geometry helpers the view derives from
 * it.
 *
 * The Go original was a bubbletea Model: an immutable value threaded through
 * Update, returning (Model, Cmd) pairs. OpenTUI is imperative, so this is a
 * mutable object whose methods mutate in place and then call `render()`. The
 * state fields and their invariants are otherwise unchanged:
 *
 *   - selectionAnchor === -1 means "no shift-selection active"; otherwise the
 *     selection runs between selectionAnchor and contentCursor (inclusive).
 *   - cache, staged, loadingDiff and collapsed are all keyed by file path.
 *   - The async loads that used to be tea.Cmds are plain async methods; each one
 *     re-checks that its result is still relevant before applying it, because a
 *     second load can be kicked off while the first is in flight.
 */

import {
  align,
  computeStagedIndices,
  filterContentLines,
  filterCurrentView,
  LineKind,
  parse,
  type AlignedRow,
  type Line,
} from './diff.ts'
import {
  fullyStaged,
  loadChangedFiles,
  loadDiff,
  loadStagedDiff,
  Mode,
  repoName as gitRepoName,
  type ChangedFile,
  type Source,
} from './git.ts'
import { build as buildTree, flatten, type DirNode, type FlatNode, type Node } from './tree.ts'
import { Store, type StoredThread } from './comments.ts'
import { highlightDiff, NO_HIGHLIGHTS, type DiffHighlights } from './syntax.ts'
import { defaultUIState, loadState, saveState } from './state.ts'
import {
  defaultConfig,
  type EditorConfig,
  type IconConfig,
  type PopupConfig,
} from './config.ts'

export enum Focus {
  Tree,
  Content,
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
}

/** The FSM state of the thread modal. */
export enum ModalMode {
  Browse,
  Compose,
  Edit,
}

export interface ThreadModal {
  /** Index into store.threads, or -1 while composing a brand-new thread. */
  threadIdx: number
  /** New-thread anchor (only meaningful while threadIdx === -1). */
  newThreadFile: string
  newThreadStart: number
  newThreadEnd: number
  /** Cursor within the comment list (browse mode). */
  selectedComment: number
  mode: ModalMode
  /** Index of the comment being edited; only valid in Edit mode. */
  editIdx: number
  /** Topmost wrapped body row currently shown. */
  scrollY: number
  /** Visible row count for the wrapped body (excludes title/status/footer). */
  bodyHeight: number
}

export interface ThreadListModal {
  cursor: number
}

/** The keymap overlay (`k`). Scrollable, because the list outgrows short terminals. */
export interface HelpModal {
  scrollY: number
  /** Visible body rows, written by the renderer so paging knows its step. */
  bodyHeight: number
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
  collapsed = new Set<string>()
  cursor = 0

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

  /**
   * Destination line for a jump that was requested before the target file's
   * diff finished loading. The load applies it once the cache is populated.
   */
  pendingNavLine = 0

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

  /** The review-thread store — `store.threads`, each holding `comments`. */
  store: Store
  modal: ThreadModal | null = null
  threadList: ThreadListModal | null = null
  finder: FinderModal | null = null
  help: HelpModal | null = null
  /** True while the quit confirmation is up. `q` and `esc` are easy to hit. */
  quitConfirm = false

  width = 0
  height = 0
  loading = true
  err: Error | null = null

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
    // A broken/absent store must not stop the reviewer from reviewing, so fall
    // back to an empty one and surface the problem in the error banner.
    let store: Store
    let storeErr: Error | null = null
    try {
      store = await Store.load()
    } catch (err) {
      store = new Store()
      storeErr = err as Error
    }
    const app = new App(source, store)
    app.err = storeErr
    const [name, state] = await Promise.all([gitRepoName(), loadState()])
    app.repoName = name
    app.treeAutoHide = state.treeAutoHide
    app.treeWidthPct = state.treeWidthPct
    return app
  }

  /**
   * persistState writes the preference fields. Best effort: failing to remember
   * a preference is annoying, not fatal.
   */
  persistState(): void {
    void saveState({ treeAutoHide: this.treeAutoHide, treeWidthPct: this.treeWidthPct }).catch(
      () => {},
    )
  }

  /**
   * clearCaches drops everything derived from on-disk state. Called after any
   * operation (staging, external editor, manual refresh) that can change what
   * `git status` / `git diff` will report.
   */
  clearCaches(): void {
    this.cache.clear()
    this.staged.clear()
    this.loadingDiff.clear()
    this.highlights.clear()
  }

  findFile(path: string): ChangedFile | null {
    // Linear scan — `files` is small (typically well under a few hundred).
    return this.files.find((f) => f.path === path) ?? null
  }

  // ---------------------------------------------------------------- loading

  async loadFiles(): Promise<void> {
    try {
      this.files = await loadChangedFiles(this.source)
    } catch (err) {
      this.loading = false
      this.err = err as Error
      this.render()
      return
    }
    this.loading = false
    this.nodes = buildTree(this.files)
    this.flat = flatten(this.nodes, this.collapsed)
    if (this.cursor >= this.flat.length) {
      this.cursor = this.flat.length > 0 ? this.flat.length - 1 : 0
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
   * loadDiffPair runs the working-tree diff and the index diff concurrently and
   * derives the staged-line indices from the pair. Shared by the UI refresh and
   * the full-file stage/unstage decision.
   */
  private async loadDiffPair(file: ChangedFile): Promise<{
    combined: Line[]
    aligned: AlignedRow[]
    stagedIdx: Set<number> | null
  }> {
    const [combinedText, stagedText] = await Promise.all([
      loadDiff(this.source, file),
      loadStagedDiff(this.source, file).catch(() => ''),
    ])
    const combined = filterContentLines(parse(combinedText))
    const aligned = align(combined)
    let stagedIdx: Set<number> | null = null
    if (stagedText !== '') {
      stagedIdx = computeStagedIndices(combined, filterContentLines(parse(stagedText)))
    }
    return { combined, aligned, stagedIdx }
  }

  async loadDiffFor(file: ChangedFile): Promise<void> {
    this.loadingDiff.add(file.path)
    try {
      const { combined, aligned, stagedIdx } = await this.loadDiffPair(file)
      const { out: current, idx: currentIdx } = filterCurrentView(combined)
      this.cache.set(file.path, { unified: combined, split: aligned, current, currentIdx })
      if (stagedIdx) this.staged.set(file.path, stagedIdx)
      else this.staged.delete(file.path)

      // Preserve cursor/scroll across reloads (staging, resize, refresh); clamp
      // to the new row count and drop a stale selection.
      if (file.path === this.selectedPath) {
        if (this.pendingNavLine > 0) this.navigateToPendingLine()
        if (this.selectionAnchor >= this.activeRowCount()) this.selectionAnchor = -1
        if (this.contentCursor >= this.activeRowCount()) {
          this.contentCursor = Math.max(0, this.activeRowCount() - 1)
        }
        this.ensureCursorVisible()
      }
    } catch (err) {
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
    if (this.highlights.has(path)) return
    const cached = this.cache.get(path)
    if (!cached) return
    const hl = await highlightDiff(path, cached.unified)
    // The cache may have been dropped while we were parsing (staging, refresh).
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
    this.clearCaches()
    // Pick up edits the VSCode extension or an agent may have made to
    // .refiner/comments.json since the last refresh.
    try {
      this.store = await Store.load()
    } catch {
      // Keep the in-memory store rather than losing the reviewer's context.
    }
    await this.loadFiles()
  }

  async onResize(width: number, height: number): Promise<void> {
    this.width = width
    this.height = height
    // Split-side widths depend on terminal size, so the aligned cache is stale.
    this.cache.clear()
    const file = this.selectedPath !== '' ? this.findFile(this.selectedPath) : null
    if (file) await this.loadDiffFor(file)
    else this.render()
  }

  // ------------------------------------------------------------- selection

  /** Inclusive [start, end] over rows in the active diff. */
  selectionRange(): [number, number] {
    if (this.selectionAnchor < 0) return [this.contentCursor, this.contentCursor]
    return this.selectionAnchor <= this.contentCursor
      ? [this.selectionAnchor, this.contentCursor]
      : [this.contentCursor, this.selectionAnchor]
  }

  hasSelection(): boolean {
    return this.selectionAnchor >= 0 && this.selectionAnchor !== this.contentCursor
  }

  /** Row count of the currently displayed diff; 0 when nothing is loaded. */
  activeRowCount(): number {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return 0
    switch (this.viewMode) {
      case ViewMode.Split:
        return cached.split.length
      case ViewMode.Current:
        return cached.current.length
      default:
        return cached.unified.length
    }
  }

  /** The working-tree line number the content cursor currently sits on. */
  cursorLine(): number {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return 0
    switch (this.viewMode) {
      case ViewMode.Split:
        return cached.split[this.contentCursor]?.newNum ?? 0
      case ViewMode.Current:
        return cached.current[this.contentCursor]?.newNum ?? 0
      default:
        return cached.unified[this.contentCursor]?.newNum ?? 0
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
      this.viewMode === ViewMode.Split
        ? cached.split
        : this.viewMode === ViewMode.Current
          ? cached.current
          : cached.unified
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].newNum === target) {
        this.contentCursor = i
        this.ensureCursorVisible()
        return
      }
    }
  }

  // ---------------------------------------------------------------- layout
  // All derived from width/height so the view stays a pure function of state.
  // Keep consistent with the border widths used when building the panes
  // (rounded border = 1 column each side).

  /** True when the tree pane is currently zero-width. */
  treeHidden(): boolean {
    return this.treeAutoHide && this.focus !== Focus.Tree
  }

  treePanelWidth(): number {
    if (this.treeHidden()) return 0
    const pct = Math.min(70, Math.max(15, this.treeWidthPct))
    return Math.max(24, Math.floor((this.width * pct) / 100))
  }

  diffPanelWidth(): number {
    return Math.max(20, this.width - this.treePanelWidth())
  }

  middleHeight(): number {
    // Header only (3 rows). There is no footer: the keymap moved into the `k`
    // overlay, which buys the diff a row back.
    return Math.max(1, this.height - 3)
  }

  /** Rows available INSIDE a pane, after its own top+bottom border. */
  paneInnerHeight(): number {
    return Math.max(1, this.middleHeight() - 2)
  }

  /**
   * ensureCursorVisible scrolls contentScroll so contentCursor is in view.
   * Idempotent; safe after any cursor move.
   */
  ensureCursorVisible(): void {
    const h = this.paneInnerHeight()
    if (this.contentCursor < this.contentScroll) {
      this.contentScroll = this.contentCursor
      return
    }
    if (this.contentCursor >= this.contentScroll + h) {
      this.contentScroll = this.contentCursor - h + 1
    }
    if (this.contentScroll < 0) this.contentScroll = 0
  }

  // -------------------------------------------------------------- staging

  /** Every change to the file is in git's index (derived from porcelain XY). */
  isFileFullyStaged(path: string): boolean {
    const f = this.findFile(path)
    return f ? fullyStaged(f) : false
  }

  /**
   * isDirFullyStaged is true when the dir holds at least one file and every
   * descendant file is fully staged. Empty subdirs don't disqualify it.
   */
  isDirFullyStaged(d: DirNode): boolean {
    const { total, staged } = this.dirFileStats(d)
    return total > 0 && total === staged
  }

  private dirFileStats(d: DirNode): { total: number; staged: number } {
    let total = 0
    let staged = 0
    for (const child of d.children) {
      if (child.type === 'file') {
        total++
        if (this.isFileFullyStaged(child.path)) staged++
      } else {
        const sub = this.dirFileStats(child)
        total += sub.total
        staged += sub.staged
      }
    }
    return { total, staged }
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

  /**
   * isThreadOutdated reports whether a thread can no longer be reached from the
   * current diff. Two heuristics, cheapest first:
   *
   *   1. The file isn't in the current change set (committed, reverted, or out
   *      of scope) — the reviewer can't see what the thread was anchored to.
   *   2. The file is on disk but shorter than the thread's end line — the
   *      anchored lines literally aren't there.
   *
   * Both miss the case where the file is still in the diff but the commented
   * CONTENT moved. The VSCode extension solves that with its `anchor` snapshot;
   * refiner preserves that field but doesn't yet use it here.
   *
   * Reads the file from disk, so only call it from rare paths (modals, the
   * thread list) — never from per-row render code.
   */
  async isThreadOutdated(t: StoredThread): Promise<boolean> {
    if (this.findFile(t.file) === null) return true
    try {
      const file = Bun.file(t.file)
      if (!(await file.exists())) return true
      const data = await file.text()
      let count = 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] === '\n') count++
      }
      if (data.length > 0 && !data.endsWith('\n')) count++
      return t.range.end > count
    } catch {
      return true
    }
  }

  // ---------------------------------------------------------------- labels

  contentLineLabel(): string {
    const cached = this.cache.get(this.selectedPath)
    if (!cached) return '—'
    switch (this.viewMode) {
      case ViewMode.Split: {
        const r = cached.split[this.contentCursor]
        if (!r) return '—'
        return formatLineLabel(r.oldNum, r.newNum, this.contentCursor + 1, cached.split.length)
      }
      case ViewMode.Current: {
        const l = cached.current[this.contentCursor]
        if (!l) return '—'
        return formatLineLabel(l.oldNum, l.newNum, this.contentCursor + 1, cached.current.length)
      }
      default: {
        const l = cached.unified[this.contentCursor]
        if (!l) return '—'
        return formatLineLabel(l.oldNum, l.newNum, this.contentCursor + 1, cached.unified.length)
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
