/**
 * A diff pane without git: an `App` whose cache holds a parsed diff and whose
 * store holds the given threads, sized to a fixed terminal. Shared by the tests
 * that walk the cursor over cards (`rows`, `card`, `cursor`), which are about
 * the row arithmetic and not about what git says.
 *
 * `new App` rather than `App.create`, so nothing here reads `~/.config`.
 */
import { App, Focus, type TextInputs } from '../src/app.ts'
import { Store, type StoredThread } from '../src/comments.ts'
import { align, filterContentLines, filterCurrentView, parse } from '../src/diff.ts'
import { Mode, type ChangedFile, type Source } from '../src/git.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

export const FILE = 'src/f.ts'

/** A unified diff of `src/f.ts`, whole-file context as refiner asks git for. */
export function diffOf(lines: string[], hunk = '@@ -1,99 +1,99 @@'): string {
  return [
    `diff --git a/${FILE} b/${FILE}`,
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    hunk,
    ...lines,
    '',
  ].join('\n')
}

/**
 * The default fixture: ten working-tree lines, a deletion after line 2 and an
 * addition at line 5, so unified has a del-only row (newNum 0).
 *
 *   idx  old new  kind
 *   0    1   1    ctx
 *   1    2   2    ctx
 *   2    3   -    del
 *   3    4   3    ctx
 *   4    5   4    ctx
 *   5    -   5    add
 *   6    6   6    ctx
 *   7    7   7    ctx
 *   8    8   8    ctx
 *   9    9   9    ctx
 */
export const DEFAULT_DIFF = diffOf([
  ' line one',
  ' line two',
  '-gone',
  ' line three',
  ' line four',
  '+added five',
  ' line six',
  ' line seven',
  ' line eight',
  ' line nine',
])

export function thread(
  id: string,
  start: number,
  end: number,
  extra: Partial<StoredThread> & { bodies?: string[]; authors?: string[] } = {},
): StoredThread {
  const bodies = extra.bodies ?? [`body of ${id}`]
  const authors = extra.authors ?? ['someone']
  const { bodies: _b, authors: _a, ...rest } = extra
  return {
    id,
    file: FILE,
    range: { start, end },
    status: 'open',
    comments: bodies.map((body, i) => ({
      id: `${id}-c${i}`,
      author: authors[i] ?? authors[authors.length - 1] ?? 'someone',
      role: 'user',
      body,
      createdAt: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z`,
    })),
    ...rest,
  }
}

export interface PaneOptions {
  diff?: string
  threads?: StoredThread[]
  /** A store to use instead of one built from `threads` (one loaded from disk). */
  store?: Store
  /** Further files, each with its own cached diff, after `FILE`. */
  files?: { path: string; diff: string }[]
  width?: number
  height?: number
  /** Working-tree-vs-index status; 'M' by default so staging is allowed. */
  status?: ChangedFile['status']
}

/** Parse a diff into the cache entry the app would have built for it. */
export function rendered(diff: string) {
  const unified = filterContentLines(parse(diff))
  const { out: current, idx: currentIdx } = filterCurrentView(unified)
  return { unified, split: align(unified), current, currentIdx, createMode: null, deleteMode: null }
}

export function openPane(opts: PaneOptions = {}): App {
  let store = opts.store
  if (!store) {
    store = new Store()
    store.data.threads.push(...(opts.threads ?? []))
    // `rebuildIndex` is private; adding through the public API would log ops.
    ;(store as unknown as { rebuildIndex(): void }).rebuildIndex()
  }

  const app = new App(SOURCE, store)
  const changed = (path: string): ChangedFile => ({
    path,
    status: opts.status ?? 'M',
    indexCode: ' ',
    workCode: 'M',
  })
  app.files = [changed(FILE), ...(opts.files ?? []).map((f) => changed(f.path))]
  app.selectedPath = FILE
  app.focus = Focus.Content
  app.width = opts.width ?? 80
  app.height = opts.height ?? 24
  app.treeAutoHide = true // the diff pane takes the whole width
  app.author = 'angel'

  app.cache.set(FILE, rendered(opts.diff ?? DEFAULT_DIFF))
  for (const f of opts.files ?? []) app.cache.set(f.path, rendered(f.diff))

  let compose = ''
  const inputs: TextInputs = {
    composeValue: () => compose,
    setComposeValue: (v) => {
      compose = v
    },
    finderValue: () => '',
    setFinderValue: () => {},
  }
  app.inputs = inputs
  return app
}

/** The kinds of the layout's rows, compactly: `d3` = diff idx 3, `c:t-A:1`, `x2` = compose line 2. */
export function rowKinds(app: App): string[] {
  return app.activeLayout().rows.map((r) => {
    switch (r.kind) {
      case 'diff':
        return `d${r.idx}`
      case 'card':
        return `c:${r.threadId}:${r.line}`
      default:
        return `x${r.line}`
    }
  })
}
