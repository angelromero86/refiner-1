/**
 * Two `space` presses inside one git operation.
 *
 * A single staging operation takes ~21 ms end to end; keyboard autorepeat is
 * ~30 ms, and a deliberate double-tap is faster than either. The presses used to
 * be launched at git with `void` and nothing serialized them, so two of them
 * overlapped on the same index: the second built its patch from `app.staged` —
 * git's answer to the FIRST press, still one reload away — and since a patch
 * describes the COMPLETE desired set, that patch described the first press's
 * line as unstaged and dropped it. No error, no banner, a line the reviewer
 * believed was staged simply missing from the commit.
 *
 * These tests need no timing luck: `toggleStaged` decides synchronously, so two
 * calls in the same tick are guaranteed to be the race, and the queue is
 * guaranteed to serialize them. Everything is asserted against real git — `git
 * show :file` and the staged diff — rather than against the app's own
 * bookkeeping, which is precisely what used to disagree with the index.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import { filterContentLines, LineKind, parse, stagedIndicesFromDiffs, type Line } from '../src/diff.ts'
import { Mode, type Source } from '../src/git.ts'
import { toggleFullStage, toggleStaged } from '../src/staging.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

let dir = ''
let cwd = ''

beforeEach(async () => {
  // realpath so the app's cwd-relative git calls and the fixture's `cwd: dir`
  // ones agree on macOS, where /var is a symlink to /private/var.
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-race-')))
  cwd = process.cwd()
  process.chdir(dir)
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function commitBase(path: string, content: string) {
  await Bun.write(join(dir, path), content)
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
}

/** The unified diff refiner works from: whole-file context, working tree vs HEAD. */
async function worktreeDiff(path: string): Promise<Line[]> {
  const r = await git(['diff', '--no-color', '-U99999', 'HEAD', '--', path])
  expect(r.exitCode).toBe(0)
  return filterContentLines(parse(r.stdout))
}

/** What git actually has staged, as indices into the unified diff. */
async function stagedIndices(path: string): Promise<number[]> {
  const combined = await worktreeDiff(path)
  const cached = await git(['diff', '--no-color', '-U99999', '--cached', 'HEAD', '--', path])
  const unstaged = await git(['diff', '--no-color', '-U0', '--', path])
  const staged = stagedIndicesFromDiffs(combined, cached.stdout, unstaged.stdout)
  return staged ? [...staged].sort((a, b) => a - b) : []
}

function sorted(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b)
}

/**
 * An app parked on `path` with its diff loaded — the state the content pane is in
 * when the user presses space. `new App` rather than `App.create` so no config or
 * UI state is read from the machine running the tests.
 */
async function openOn(path: string): Promise<{ app: App; adds: number[] }> {
  const app = new App(SOURCE, new Store())
  await app.loadFiles()
  const file = app.findFile(path)
  expect(file).not.toBeNull()
  app.selectedPath = path
  await app.loadDiffFor(file!)
  const unified = app.cache.get(path)?.unified ?? []
  const adds = unified
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.kind === LineKind.Add)
    .map(([, i]) => i)
  return { app, adds }
}

// ------------------------------------------------------------------ the report

test('two presses in the same tick stage both lines', async () => {
  await commitBase('f.txt', 'a\nb\nc\nd\ne\n')
  await Bun.write(join(dir, 'f.txt'), 'a\nA1\nb\nA2\nc\nA3\nd\ne\n')
  const { app, adds } = await openOn('f.txt')
  expect(adds).toHaveLength(3)

  // The repro, exactly: space, move the cursor, space, with nothing awaited in
  // between — which is all "within 21 ms" amounts to.
  app.contentCursor = adds[0]
  toggleStaged(app)
  app.contentCursor = adds[1]
  toggleStaged(app)

  // Decided synchronously and accumulated, so the second press knows about the
  // first even though git has not been told about either yet...
  expect(app.stagingIntent.get('f.txt')).toEqual(new Set([adds[0], adds[1]]))
  // ...painted in the same frame...
  expect(sorted(app.stagedFor('f.txt'))).toEqual([adds[0], adds[1]])
  // ...and coalesced into ONE git operation rather than two racing ones.
  expect(app.stagingPending.size).toBe(1)

  await app.stagingIdle()

  expect(app.err).toBeNull()
  expect(await stagedIndices('f.txt')).toEqual([adds[0], adds[1]])
  expect((await git(['show', ':f.txt'])).stdout).toBe('a\nA1\nb\nA2\nc\nd\ne\n')
  // The intent hands back to git's answer once the queue drains; leaving it
  // behind would paint lines as staged that git never received.
  expect(app.stagingIntent.size).toBe(0)
  expect(app.stagingFullIntent.size).toBe(0)
  expect(sorted(app.stagedFor('f.txt'))).toEqual([adds[0], adds[1]])
})

test('a press that lands while the previous operation is still running is not lost', async () => {
  await commitBase('g.txt', 'a\nb\nc\n')
  await Bun.write(join(dir, 'g.txt'), 'a\nA1\nb\nA2\nc\n')
  const { app, adds } = await openOn('g.txt')
  expect(adds).toHaveLength(2)

  // Press the second key from inside the reload the first operation ends with —
  // the one moment a test can time exactly, and the worst one for the old code:
  // the cache had just been cleared, so the press was a silent no-op, and the
  // staged set it would have read was a reload stale.
  const reload = app.loadFiles.bind(app)
  let pressed = false
  app.loadFiles = async () => {
    if (!pressed) {
      pressed = true
      app.contentCursor = adds[1]
      toggleStaged(app)
    }
    await reload()
  }

  app.contentCursor = adds[0]
  toggleStaged(app)
  await app.stagingIdle()

  expect(pressed).toBe(true)
  expect(app.err).toBeNull()
  // Two separate git operations this time — so this also pins that they ran one
  // after the other. Interleaved, `apply₁` would have failed against an index
  // `unstage₂` had already reset.
  expect(await stagedIndices('g.txt')).toEqual([adds[0], adds[1]])
  expect((await git(['show', ':g.txt'])).stdout).toBe('a\nA1\nb\nA2\nc\n')
})

// --------------------------------------------------------------------- parity

test('the same line twice in one tick leaves it unstaged', async () => {
  await commitBase('h.txt', 'a\nb\n')
  await Bun.write(join(dir, 'h.txt'), 'a\nA1\nb\n')
  const { app, adds } = await openOn('h.txt')
  app.contentCursor = adds[0]

  toggleStaged(app)
  toggleStaged(app)
  expect(app.stagingIntent.get('h.txt')).toEqual(new Set())

  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect(await stagedIndices('h.txt')).toEqual([])
  expect((await git(['diff', '--cached', 'HEAD'])).stdout).toBe('')
})

test('the same file twice in one tick leaves it out of the index', async () => {
  // The tree's `space`, which has the same exposure: both presses used to read
  // the same pre-reload porcelain and both decide "stage".
  await commitBase('i.txt', 'a\nb\n')
  await Bun.write(join(dir, 'i.txt'), 'a\nB\n')
  const { app } = await openOn('i.txt')
  const file = app.findFile('i.txt')!

  toggleFullStage(app, file)
  toggleFullStage(app, file)
  expect(app.stagingFullIntent.get('i.txt')).toBe(false)

  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect((await git(['diff', '--cached', 'HEAD'])).stdout).toBe('')
  expect(app.stagingFullIntent.size).toBe(0)
})

test('one press on the tree still stages the whole file', async () => {
  await commitBase('j.txt', 'a\nb\n')
  await Bun.write(join(dir, 'j.txt'), 'a\nB\nc\n')
  const { app } = await openOn('j.txt')

  toggleFullStage(app, app.findFile('j.txt')!)
  await app.stagingIdle()

  expect(app.err).toBeNull()
  expect((await git(['show', ':j.txt'])).stdout).toBe('a\nB\nc\n')
  expect((await git(['status', '--porcelain=v1'])).stdout).toBe('M  j.txt\n')
})

// ------------------------------------------------------------------- bursts

test('a burst over a multi-line selection stages exactly those lines', async () => {
  await commitBase('k.txt', 'a\nb\nc\n')
  await Bun.write(join(dir, 'k.txt'), 'a\nA1\nA2\nb\nA3\nc\nA4\n')
  const { app, adds } = await openOn('k.txt')
  expect(adds).toHaveLength(4)

  // Shift-select the first two additions, press space, then — without awaiting —
  // press again on a third line.
  app.selectionAnchor = adds[0]
  app.contentCursor = adds[1]
  toggleStaged(app)
  app.selectionAnchor = -1
  app.contentCursor = adds[2]
  toggleStaged(app)
  app.contentCursor = adds[3]
  toggleStaged(app)

  expect(app.stagingPending.size).toBe(1)
  await app.stagingIdle()

  expect(app.err).toBeNull()
  expect(await stagedIndices('k.txt')).toEqual(adds)
  expect((await git(['show', ':k.txt'])).stdout).toBe('a\nA1\nA2\nb\nA3\nc\nA4\n')
})

test('a burst that unstages leaves exactly the untouched line', async () => {
  await commitBase('l.txt', 'a\nb\n')
  await Bun.write(join(dir, 'l.txt'), 'a\nA1\nA2\nA3\nb\n')
  const { app, adds } = await openOn('l.txt')
  expect(adds).toHaveLength(3)

  app.selectionAnchor = adds[0]
  app.contentCursor = adds[2]
  toggleStaged(app)
  await app.stagingIdle()
  expect(await stagedIndices('l.txt')).toEqual(adds)

  // Now take two of them back out, again inside one tick.
  app.selectionAnchor = -1
  app.contentCursor = adds[0]
  toggleStaged(app)
  app.contentCursor = adds[2]
  toggleStaged(app)
  await app.stagingIdle()

  expect(app.err).toBeNull()
  expect(await stagedIndices('l.txt')).toEqual([adds[1]])
  expect((await git(['show', ':l.txt'])).stdout).toBe('a\nA2\nb\n')
})

// ---------------------------------------------------------------- untracked

test('space on an untracked file stages just that line', async () => {
  // No blob in HEAD, so the patch needs git's creation header — which
  // `git diff --no-index` supplies for a `?` file exactly as `git diff HEAD`
  // does for an `A` one. This used to fall back to staging the file whole (the
  // old `status === '?'` shortcut); bug 06 made the header the deciding factor
  // instead, and the fallback now only fires when git named no mode at all.
  await commitBase('m.txt', 'seed\n')
  await Bun.write(join(dir, 'u.txt'), 'n1\nn2\n')
  const { app, adds } = await openOn('u.txt')
  expect(adds).toHaveLength(2)
  expect(app.findFile('u.txt')?.status).toBe('?')
  expect(app.cache.get('u.txt')?.createMode).toBe('100644')

  app.contentCursor = adds[0]
  toggleStaged(app)
  await app.stagingIdle()

  expect(app.err).toBeNull()
  expect((await git(['show', ':u.txt'])).stdout).toBe('n1\n')
  expect((await git(['status', '--porcelain=v1', '--', 'u.txt'])).stdout).toBe('AM u.txt\n')
})

test('two presses on an untracked file cancel out', async () => {
  // The same line twice inside one tick. Without the intent the second press
  // would read the same stale set as the first, decide "stage" again, and the
  // toggle would have no way back. The desired set ends empty, which for a file
  // absent from HEAD has to mean "no index entry" and not "empty blob".
  await commitBase('m.txt', 'seed\n')
  await Bun.write(join(dir, 'v.txt'), 'n1\nn2\n')
  const { app, adds } = await openOn('v.txt')

  app.contentCursor = adds[0]
  toggleStaged(app)
  toggleStaged(app)
  expect(sorted(app.stagingIntent.get('v.txt') ?? new Set<number>())).toEqual([])

  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect((await git(['status', '--porcelain=v1', '--', 'v.txt'])).stdout).toBe('?? v.txt\n')
  expect((await git(['ls-files', '--stage', '--', 'v.txt'])).stdout).toBe('')
})

test('a second press on a file added to the index still stages line by line', async () => {
  // The second-keypress case. Once the first press lands, porcelain reports
  // `AM`, and `parsePorcelain` prefers the tree column — so `status` is 'M'
  // while the file is still absent from HEAD. A guard on `status` would fix the
  // first press only; the mode from git's header covers both.
  await commitBase('m.txt', 'seed\n')
  await Bun.write(join(dir, 'w.txt'), 'n1\nn2\nn3\n')
  await git(['add', 'w.txt'])

  // `git add` staged all three, so the first press TAKES ONE BACK OUT — the
  // report's repro verbatim: "I wanted to drop one line and lost them all".
  const first = await openOn('w.txt')
  expect(first.app.findFile('w.txt')?.status).toBe('A')
  first.app.contentCursor = first.adds[0]
  toggleStaged(first.app)
  await first.app.stagingIdle()
  expect(first.app.err).toBeNull()
  expect((await git(['show', ':w.txt'])).stdout).toBe('n2\nn3\n')
  expect((await git(['status', '--porcelain=v1', '--', 'w.txt'])).stdout).toBe('AM w.txt\n')

  // Reopen: this is now `AM`, i.e. status 'M' with indexCode 'A'.
  const second = await openOn('w.txt')
  const file = second.app.findFile('w.txt')
  expect(file?.status).toBe('M')
  expect(file?.indexCode).toBe('A')
  expect(second.app.cache.get('w.txt')?.createMode).toBe('100644')

  second.app.contentCursor = second.adds[0]
  toggleStaged(second.app)
  await second.app.stagingIdle()

  expect(second.app.err).toBeNull()
  expect((await git(['show', ':w.txt'])).stdout).toBe('n1\nn2\nn3\n')
  expect((await git(['status', '--porcelain=v1', '--', 'w.txt'])).stdout).toBe('A  w.txt\n')
})
