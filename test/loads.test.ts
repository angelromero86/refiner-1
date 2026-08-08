/**
 * Two `tab` presses inside git's latency.
 *
 * `tab` in the tree fires `void app.toggleFileMode()`: the mode flips
 * synchronously (it has to — `preventDefault()` only counts during the dispatch)
 * and the reload runs behind it. Two presses therefore leave two loads in flight,
 * and `loadAllFiles` runs two git commands to `loadChangedFiles`' one, so the
 * ALL load is systematically the slower and lands LAST. It used to overwrite
 * `files`/`nodes`/`flat` after the mode had already flipped back: the header said
 * CHANGES while the tree listed the whole repo, the counts counted the wrong
 * list, and every `enter` on a folder from then on wrote ALL-tree paths into the
 * CHANGES collapse set.
 *
 * None of this is tested by racing git against itself. The interleaving is driven
 * by explicit gates over the two seams — `listFiles` and `loadDiffPair` — via a
 * subclass, so each test runs the same body under BOTH resolution orders and
 * expects the same outcome. The real timing asymmetry is an implementation
 * accident; a test that leaned on it would be intermittent.
 *
 * The fix is a generation counter (`App.loadGen`), bumped synchronously by
 * `clearCaches()` and re-checked by every load before it writes shared state.
 * Deliberately NOT the serial queue that `src/staging.ts` uses: a reload is a
 * READ, where the newest intent invalidates the older one and a discarded result
 * costs nothing, while a discarded staging press would lose the user's work.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, FileMode } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import { Mode, type ChangedFile, type Source } from '../src/git.ts'
import { flatten } from '../src/tree.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

// The repo of the report: one changed file, one untouched one, in different
// folders — so the CHANGES tree and the ALL tree differ in both their files and
// their folders and a load landing in the wrong one is visible either way.
const CHANGES_FILES = ['src/a.txt']
const ALL_FILES = ['src/a.txt', 'sub/b.txt']
const CHANGES_TREE = ['src', 'src/a.txt']
/** ALL is folded to its folders by the one-time collapse. */
const ALL_TREE = ['src', 'sub']

let dir = ''
let cwd = ''

beforeEach(async () => {
  // realpath so the app's cwd-relative git calls and the fixture's `cwd: dir`
  // ones agree on macOS, where /var is a symlink to /private/var.
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-loads-')))
  cwd = process.cwd()
  process.chdir(dir)
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'sub'), { recursive: true })
  await Bun.write(join(dir, 'src/a.txt'), 'a1\na2\na3\n')
  await Bun.write(join(dir, 'sub/b.txt'), 'b1\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  // Half staged, half not, so `loadDiffPair` produces a non-empty staged set and
  // the "a stale diff must not refill the cache" tests can see `staged` too.
  await Bun.write(join(dir, 'src/a.txt'), 'a1\nA2\na3\n')
  await git(['add', 'src/a.txt'])
  await Bun.write(join(dir, 'src/a.txt'), 'a1\nA2\na3\nA4\n')
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

// --------------------------------------------------------------------- gates

/**
 * An App whose two async seams can be held open, one gate per call in call
 * order, so a test picks the interleaving instead of hoping for it.
 *
 * `new GatedApp(...)` rather than `App.create()`: nothing here may read the
 * machine's `~/.config/refiner/`.
 */
class GatedApp extends App {
  gateFiles = false
  /** One deferred per `listFiles` call, in call order. */
  fileGates: PromiseWithResolvers<void>[] = []
  /** What each of those calls asked git for — the load's OWN mode. */
  fileCalls: FileMode[] = []
  /** Modes whose load should reject once let through. */
  failModes = new Set<FileMode>()

  gateDiff = false
  diffGates: PromiseWithResolvers<void>[] = []
  failDiff = false

  protected override async listFiles(mode: FileMode): Promise<ChangedFile[]> {
    this.fileCalls.push(mode)
    if (this.gateFiles) {
      const gate = Promise.withResolvers<void>()
      this.fileGates.push(gate)
      await gate.promise
    }
    if (this.failModes.has(mode)) throw new Error(`listFiles failed for mode ${mode}`)
    return super.listFiles(mode)
  }

  protected override async loadDiffPair(file: ChangedFile) {
    if (this.gateDiff) {
      const gate = Promise.withResolvers<void>()
      this.diffGates.push(gate)
      await gate.promise
    }
    if (this.failDiff) throw new Error('loadDiffPair failed')
    return super.loadDiffPair(file)
  }
}

/** A Store whose `flush()` can be held open — the wait `refresh()` does first. */
class GatedStore extends Store {
  gate: PromiseWithResolvers<void> | null = null
  override async flush(): Promise<void> {
    await super.flush()
    if (this.gate) await this.gate.promise
  }
}

/**
 * An app parked in CHANGES with one ALL load already behind it — the state after
 * startup plus one `tab`, and the state the report's repro starts from.
 */
async function opened(store: Store = new Store()): Promise<GatedApp> {
  const app = new GatedApp(SOURCE, store)
  await app.loadFiles() // startup: ALL, and the one-time collapse fires here
  await app.toggleFileMode() // → CHANGES
  expect(app.fileMode).toBe(FileMode.Changes)
  expect(paths(app)).toEqual(CHANGES_FILES)
  return app
}

const paths = (app: App) => app.files.map((f) => f.path)
const rows = (app: App) => app.flat.map((f) => f.node.path)

/** The collapse set of a mode that may not be the active one. */
function collapsedFor(app: App, mode: FileMode): string[] {
  const was = app.fileMode
  app.fileMode = mode
  const out = [...app.collapsed].sort()
  app.fileMode = was
  return out
}

/**
 * What the header claims and what the tree shows, in one assertion — the header
 * composes `fileModeLabel(app.fileMode)` and `${app.files.length} files` from
 * two different places (`src/view.ts`), and the bug is exactly them disagreeing.
 */
function expectHeaderAgreesWithTree(app: App): void {
  const expected = app.fileMode === FileMode.All ? ALL_FILES : CHANGES_FILES
  expect(paths(app)).toEqual(expected)
  expect(app.flat.filter((f) => f.node.type === 'file')).toHaveLength(
    app.flat.filter((f) => expected.includes(f.node.path)).length,
  )
}

// ------------------------------------------------------------- the report

test('two toggles land on one mode — newest load first', async () => {
  const app = await opened()
  app.gateFiles = true

  const t1 = app.toggleFileMode() // → ALL
  const t2 = app.toggleFileMode() // → CHANGES
  // The intent is synchronous: the header is already right, before any git ran.
  expect(app.fileMode).toBe(FileMode.Changes)
  expect(app.fileCalls.slice(-2)).toEqual([FileMode.All, FileMode.Changes])

  app.fileGates[1].resolve()
  await t2
  app.fileGates[0].resolve()
  await t1

  expect(app.fileMode).toBe(FileMode.Changes)
  expect(paths(app)).toEqual(CHANGES_FILES)
  expect(rows(app)).toEqual(CHANGES_TREE)
  expect(app.err).toBeNull()
  expectHeaderAgreesWithTree(app)
})

test('two toggles land on one mode — oldest load first', async () => {
  const app = await opened()
  app.gateFiles = true

  const t1 = app.toggleFileMode() // → ALL
  const t2 = app.toggleFileMode() // → CHANGES

  app.fileGates[0].resolve()
  await t1
  // Even arriving first, the ALL load is already superseded and writes nothing:
  // the tree never flashes the whole repo while the header says CHANGES.
  expect(paths(app)).toEqual(CHANGES_FILES)
  expect(rows(app)).toEqual(CHANGES_TREE)

  app.fileGates[1].resolve()
  await t2

  expect(app.fileMode).toBe(FileMode.Changes)
  expect(paths(app)).toEqual(CHANGES_FILES)
  expect(rows(app)).toEqual(CHANGES_TREE)
  expect(app.err).toBeNull()
  expectHeaderAgreesWithTree(app)
})

test('the mirror direction ends in ALL, in either order', async () => {
  for (const newestFirst of [true, false]) {
    const app = await opened()
    await app.toggleFileMode() // → ALL
    app.gateFiles = true

    const t1 = app.toggleFileMode() // → CHANGES
    const t2 = app.toggleFileMode() // → ALL
    if (newestFirst) {
      app.fileGates[1].resolve()
      await t2
      app.fileGates[0].resolve()
      await t1
    } else {
      app.fileGates[0].resolve()
      await t1
      app.fileGates[1].resolve()
      await t2
    }

    expect(app.fileMode).toBe(FileMode.All)
    expect(paths(app)).toEqual(ALL_FILES)
    expect(rows(app)).toEqual(ALL_TREE)
    expect(app.err).toBeNull()
    expectHeaderAgreesWithTree(app)
  }
})

test('the cursor epilogue belongs to the toggle that won', async () => {
  const app = await opened()
  app.gateFiles = true
  app.cursor = 1 // on `src/a.txt` in the CHANGES tree

  const t1 = app.toggleFileMode() // → ALL
  const t2 = app.toggleFileMode() // → CHANGES
  app.fileGates[1].resolve()
  await t2
  app.fileGates[0].resolve()
  await t1

  // Clamped against the tree that is actually on screen, never against the other
  // one — the ALL tree is longer, so a stale clamp would leave the cursor off the
  // end of the CHANGES tree.
  expect(app.cursor).toBeLessThan(app.flat.length)
  expect(rows(app)).toEqual(CHANGES_TREE)
})

// ------------------------------------------------------- errors and the banner

test("a superseded load's failure never reaches the banner", async () => {
  const app = await opened()
  app.gateFiles = true
  app.failModes.add(FileMode.All)

  const t1 = app.toggleFileMode() // → ALL, will throw
  const t2 = app.toggleFileMode() // → CHANGES, will succeed
  app.fileGates[1].resolve()
  await t2
  app.fileGates[0].resolve()
  await t1

  // The banner replaces the whole tree pane; a discarded ALL load must not put
  // it over a healthy CHANGES view.
  expect(app.err).toBeNull()
  expect(app.loading).toBe(false)
  expect(paths(app)).toEqual(CHANGES_FILES)
})

test("the current load's failure still reaches the banner", async () => {
  const app = await opened()
  app.failModes.add(FileMode.All)

  await app.toggleFileMode() // → ALL, throws, and nothing supersedes it

  expect(app.err).not.toBeNull()
  expect(app.err?.message).toContain('listFiles failed')
  // Not left spinning: the guard must not cost the error path its `loading` flip.
  expect(app.loading).toBe(false)
})

test('loadFiles still never clears the banner', async () => {
  // `src/externals.ts` and staging record an error and then refresh; clearing on
  // a successful reload wiped the very error they had just set (CLAUDE.md).
  const app = await opened()
  const recorded = new Error('from staging')
  app.err = recorded
  await app.toggleFileMode()
  expect(app.err).toBe(recorded)
})

// -------------------------------------------------------- the diff cache

test('a superseded diff load does not refill the cache', async () => {
  const app = await opened()
  const file = app.findFile('src/a.txt')!
  app.selectedPath = 'src/a.txt'
  app.contentCursor = 5
  let renders = 0
  app.render = () => {
    renders++
  }

  app.gateDiff = true
  const load = app.loadDiffFor(file)
  expect(app.loadingDiff.has('src/a.txt')).toBe(true)

  // Anything that invalidates — a refresh, a mode switch, the external editor.
  app.clearCaches()
  app.diffGates[0].resolve()
  await load

  // `file.path === this.selectedPath` is still true, so the old relevance check
  // waved this through and put the PRE-invalidation diff (and its staged marks)
  // straight back into the maps `clearCaches` had just emptied.
  expect(app.cache.has('src/a.txt')).toBe(false)
  expect(app.staged.has('src/a.txt')).toBe(false)
  // The `finally` still runs, so nothing is left marked as loading.
  expect(app.loadingDiff.has('src/a.txt')).toBe(false)
  // And it touched neither the cursor nor the screen.
  expect(app.contentCursor).toBe(5)
  expect(renders).toBe(0)
})

test('a current diff load still fills the cache', async () => {
  const app = await opened()
  const file = app.findFile('src/a.txt')!
  app.selectedPath = 'src/a.txt'

  app.gateDiff = true
  const load = app.loadDiffFor(file)
  app.diffGates[0].resolve()
  await load

  expect(app.cache.has('src/a.txt')).toBe(true)
  // Half the change is in the index, so git's staged set landed too.
  expect(app.staged.get('src/a.txt')?.size).toBeGreaterThan(0)
  expect(app.loadingDiff.has('src/a.txt')).toBe(false)
})

test('a superseded diff load does not eat pendingNavLine', async () => {
  const app = await opened()
  const file = app.findFile('src/a.txt')!
  app.selectedPath = 'src/a.txt'
  app.pendingNavLine = 3

  app.gateDiff = true
  const load = app.loadDiffFor(file)
  app.clearCaches()
  app.diffGates[0].resolve()
  await load

  // `navigateToPendingLine()` zeroes the field on entry, so a discarded load that
  // reached it would lose the jump for ever — which is why the guard sits above
  // it and not merely above `cache.set`.
  expect(app.pendingNavLine).toBe(3)

  // The control: the load that is still current does consume it.
  app.gateDiff = false
  await app.loadDiffFor(file)
  expect(app.pendingNavLine).toBe(0)
  expect(app.cache.has('src/a.txt')).toBe(true)
})

test("a superseded diff load's failure never reaches the banner", async () => {
  const app = await opened()
  const file = app.findFile('src/a.txt')!
  app.selectedPath = 'src/a.txt'
  app.gateDiff = true
  app.failDiff = true

  const load = app.loadDiffFor(file)
  app.clearCaches()
  app.diffGates[0].resolve()
  await load

  expect(app.err).toBeNull()
  expect(app.loadingDiff.has('src/a.txt')).toBe(false)

  // Still latched when nothing supersedes it.
  app.gateDiff = false
  await app.loadDiffFor(file)
  expect(app.err?.message).toContain('loadDiffPair failed')
})

// ------------------------------------------------------------ the collapse sets

test('the one-time ALL collapse is not consumed by a load nobody sees', async () => {
  // The real window, narrow but real: `installKeyHandling` runs before the
  // startup `await app.loadFiles()` (`src/index.ts`), so `tab` can land on top of
  // the very first load.
  const app = new GatedApp(SOURCE, new Store())
  app.gateFiles = true
  const first = app.loadFiles() // startup, ALL
  const t = app.toggleFileMode() // → CHANGES

  app.fileGates[1].resolve()
  await t
  app.fileGates[0].resolve()
  await first

  expect(app.fileMode).toBe(FileMode.Changes)
  expect(rows(app)).toEqual(CHANGES_TREE)
  expect(collapsedFor(app, FileMode.Changes)).toEqual([])

  // The flag went with the discarded load, so the first ALL tree the user
  // actually sees is still folded.
  const back = app.toggleFileMode() // → ALL
  app.fileGates[2].resolve()
  await back
  expect(rows(app)).toEqual(ALL_TREE)
  expect(collapsedFor(app, FileMode.All)).toEqual(['src', 'sub'])
})

test('a folder opened by hand survives a round trip, and the sets stay apart', async () => {
  const app = await opened()
  await app.toggleFileMode() // → ALL, folded
  expect(rows(app)).toEqual(ALL_TREE)

  // `enter` on `src`, as `activateCursor` does it.
  app.collapsed.delete('src')
  app.flat = flatten(app.nodes, app.collapsed)
  expect(rows(app)).toContain('src/a.txt')

  await app.toggleFileMode() // → CHANGES
  await app.toggleFileMode() // → ALL
  // Not re-folded: the one-time flag is spent.
  expect(rows(app)).toContain('src/a.txt')
  expect(collapsedFor(app, FileMode.All)).toEqual(['sub'])
  expect(collapsedFor(app, FileMode.Changes)).toEqual([])
})

test('a crossed double toggle leaves no ALL path in the CHANGES set', async () => {
  const app = await opened()
  app.gateFiles = true
  const t1 = app.toggleFileMode() // → ALL
  const t2 = app.toggleFileMode() // → CHANGES
  app.fileGates[1].resolve()
  await t2
  app.fileGates[0].resolve()
  await t1

  // The contradictory state was self-perpetuating: with the ALL tree on screen
  // and the mode reading CHANGES, every `enter` on a folder wrote an ALL-only
  // path into the CHANGES collapse set and kept it there for the session.
  expect(rows(app)).toEqual(CHANGES_TREE)
  expect(collapsedFor(app, FileMode.Changes)).not.toContain('sub')
  expect(collapsedFor(app, FileMode.All)).toEqual(['src', 'sub'])
})

// ------------------------------------------------------------------- refresh

test('a watcher refresh landing mid-toggle does not restore the old list', async () => {
  const app = await opened()
  app.gateFiles = true

  // `.git/index` moved: `src/watch.ts` fires `void app.refresh()`.
  const r = app.refresh()
  await until(() => app.fileGates.length === 1, 'refresh to reach git')
  // …and the user presses `tab` while it is still out there.
  const t = app.toggleFileMode() // → ALL
  expect(app.fileGates).toHaveLength(2)

  app.fileGates[1].resolve()
  await t
  app.fileGates[0].resolve() // the refresh's CHANGES list arrives last
  await r

  expect(app.fileMode).toBe(FileMode.All)
  expect(paths(app)).toEqual(ALL_FILES)
  expect(rows(app)).toEqual(ALL_TREE)
  expectHeaderAgreesWithTree(app)
})

test('a superseded refresh still flushes and reloads the store, but not the files', async () => {
  const store = new GatedStore()
  const app = await opened(store)
  store.gate = Promise.withResolvers<void>()

  const r = app.refresh() // bumps the generation, then parks in `store.flush()`
  const before = app.fileCalls.length
  app.gateFiles = true
  const t = app.toggleFileMode() // → ALL, supersedes it

  store.gate.resolve()
  app.fileGates[0].resolve()
  await t
  // Defensive: without the guard the refresh takes a gate of its own, and an
  // unresolved gate would hang instead of failing.
  for (const g of app.fileGates) g.resolve()
  await r

  // The store half of `refresh()` runs regardless — waiting for a save in flight
  // and poisoning a store whose file broke are facts about the disk, not about
  // which view is current. Only the git half is skipped.
  expect(app.fileCalls.slice(before)).toEqual([FileMode.All])
  expect(app.fileMode).toBe(FileMode.All)
  expect(paths(app)).toEqual(ALL_FILES)
  expect(app.store).not.toBe(store) // it did swap in the freshly loaded one
  expect(app.store.readOnly).toBe(false)
})

/** Wait for a STATE, never for a duration — the outcome stays deterministic. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`timed out waiting for ${what}`)
}
