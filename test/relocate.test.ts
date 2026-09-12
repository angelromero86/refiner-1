/**
 * Threads follow the code. `src/relocate.ts` re-anchors every thread against
 * the working tree on load, persists the corrections through the store's
 * id-keyed log, and records the outcome in `App.drift` for the UI.
 *
 * The tests run from a throwaway git repo, like `loads.test.ts`, because the
 * file reads are cwd-relative — refiner runs from the repo root — and because
 * the `loadFiles()`/`loadDiffFor()` triggers need a real change set.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import { Mode, type Source } from '../src/git.ts'
import { relocateThreads } from '../src/relocate.ts'
import { captureAnchor, splitLines } from '../src/anchor.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

const ORIGINAL = `import { a } from './a'

export function compute(x: number): number {
  const y = a(x)
  return y * 2
}
`

let dir = ''
let cwd = ''
let storePath = ''

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-relocate-')))
  cwd = process.cwd()
  process.chdir(dir)
  storePath = join(dir, '.refiner', 'comments.json')
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])
  await mkdir(join(dir, 'src'), { recursive: true })
  await Bun.write(join(dir, 'src/a.ts'), ORIGINAL)
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

function thread(id: string, file: string, start: number, end: number, anchor?: unknown) {
  return {
    id,
    file,
    range: { start, end },
    status: 'open',
    comments: [
      { id: `c-${id}`, author: 'Claude', role: 'assistant', body: 'x', createdAt: '2026-08-01T10:00:00.000Z' },
    ],
    ...(anchor ? { anchor } : {}),
  }
}

async function writeStore(threads: unknown[]): Promise<void> {
  await Bun.write(storePath, JSON.stringify({ version: 1, threads }, null, 2) + '\n')
}

async function readStore(): Promise<any> {
  return JSON.parse(await Bun.file(storePath).text())
}

async function makeApp(): Promise<App> {
  return new App(SOURCE, await Store.load(storePath))
}

/** The anchor the extension (or we) would have captured for L4-L5 of ORIGINAL. */
const BODY_ANCHOR = captureAnchor(splitLines(ORIGINAL), 4, 5)

// ----------------------------------------------------------------- the pass

test('a thread without an anchor is backfilled from the file and persisted', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5)])
  const app = await makeApp()
  await relocateThreads(app)

  expect(app.threadDrift('t-1')).toEqual({ status: 'exact', from: { start: 4, end: 5 } })
  const disk = await readStore()
  expect(disk.threads[0].anchor).toEqual(BODY_ANCHOR)
  expect(disk.threads[0].range).toEqual({ start: 4, end: 5 })
  expect(app.threadDrift(app.store.threads[0].id)?.status).toBe('exact')
})

test('a thread whose code moved is moved with it, on disk and in memory', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\nimport { c } from './c'\n" + ORIGINAL)
  const app = await makeApp()
  await relocateThreads(app)

  expect(app.store.threads[0].range).toEqual({ start: 6, end: 7 })
  expect(app.store.threadAt('src/a.ts', 6)?.id).toBe('t-1')
  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })
  const disk = await readStore()
  expect(disk.threads[0].range).toEqual({ start: 6, end: 7 })
  // The anchor is not re-captured on a move: same contract as the extension.
  expect(disk.threads[0].anchor).toEqual(BODY_ANCHOR)
})

test('a thread whose code is gone is lost, and nothing is written', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { a } from './a'\n\nexport const compute = a\n")
  const before = await Bun.file(storePath).text()
  const app = await makeApp()
  await relocateThreads(app)

  expect(app.threadDrift('t-1')).toEqual({ status: 'lost', from: { start: 4, end: 5 } })
  expect(app.threadDrift(app.store.threads[0].id)?.status).toBe('lost')
  expect(app.store.threads[0].range).toEqual({ start: 4, end: 5 })
  expect(await Bun.file(storePath).text()).toBe(before)
})

test('a thread on a file that no longer exists is lost, anchor or not', async () => {
  await writeStore([thread('t-1', 'src/gone.ts', 1, 1), thread('t-2', 'src/gone.ts', 3, 3, BODY_ANCHOR)])
  const before = await Bun.file(storePath).text()
  const app = await makeApp()
  await relocateThreads(app)
  expect(app.threadDrift('t-1')?.status).toBe('lost')
  expect(app.threadDrift('t-2')?.status).toBe('lost')
  // No backfill of an anchor nobody can capture.
  expect(await Bun.file(storePath).text()).toBe(before)
})

test('a range past the end of the file is not backfilled with an empty anchor', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 40, 42)])
  const before = await Bun.file(storePath).text()
  const app = await makeApp()
  await relocateThreads(app)
  expect(app.threadDrift('t-1')?.status).toBe('lost')
  expect(await Bun.file(storePath).text()).toBe(before)
})

test('"moved from" is kept across passes until the store is reloaded', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const app = await makeApp()
  await relocateThreads(app)
  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })

  // The next pass finds it exactly where the previous one put it.
  await relocateThreads(app, ['src/a.ts'])
  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })

  // A fresh store — what refresh() does — makes the corrected range the baseline.
  app.store = await Store.load(storePath)
  await relocateThreads(app)
  expect(app.threadDrift('t-1')).toEqual({ status: 'exact', from: { start: 5, end: 6 } })
})

test('a full pass forgets threads that are gone; a per-file pass leaves the others alone', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR), thread('t-2', 'src/gone.ts', 1, 1)])
  const app = await makeApp()
  await relocateThreads(app)
  expect(app.threadDrift('t-2')?.status).toBe('lost')

  app.store.deleteThread('t-2')
  await relocateThreads(app, ['src/a.ts'])
  expect(app.threadDrift('t-2')?.status).toBe('lost')
  await relocateThreads(app)
  expect(app.threadDrift('t-2')).toBeNull()
})

test('a read-only store is corrected in memory and never written', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const before = await Bun.file(storePath).text()
  const app = await makeApp()
  app.store.markUnreadable(new Error('broken under us'))
  await relocateThreads(app)

  expect(app.store.threads[0].range).toEqual({ start: 5, end: 6 })
  expect(app.threadDrift('t-1')?.status).toBe('moved')
  expect(await Bun.file(storePath).text()).toBe(before)
  expect(app.err).toBeNull()
})

test('a stale pass writes nothing: generation bumped while it was reading', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const before = await Bun.file(storePath).text()
  const app = await makeApp()
  const pass = relocateThreads(app)
  app.clearCaches() // the external editor came back, say
  await pass

  expect(app.threadDrift('t-1')).toBeNull()
  expect(app.store.threads[0].range).toEqual({ start: 4, end: 5 })
  expect(await Bun.file(storePath).text()).toBe(before)
})

test('a stale pass writes nothing: store replaced while it was reading', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const app = await makeApp()
  const old = app.store
  const fresh = await Store.load(storePath)
  const pass = relocateThreads(app)
  app.store = fresh // synchronously: the pass has captured `old` and is reading
  await pass

  expect(old.threads[0].range).toEqual({ start: 4, end: 5 })
  expect(app.drift.size).toBe(0)
})

test('relocation merges onto what another client wrote meanwhile', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const app = await makeApp()
  // An agent replies between our load and our relocation save.
  const disk = await readStore()
  disk.threads[0].comments.push({
    id: 'c-agent',
    author: 'Claude',
    role: 'assistant',
    body: 'done',
    createdAt: '2026-08-01T11:00:00.000Z',
  })
  await writeStore(disk.threads)

  await relocateThreads(app)
  const after = await readStore()
  expect(after.threads[0].range).toEqual({ start: 5, end: 6 })
  expect(after.threads[0].comments.map((c: any) => c.id)).toEqual(['c-t-1', 'c-agent'])
  // A clean merge is not news; the banner stays as it was.
  expect(app.err).toBeNull()
})

test('a quiet save does not clear a banner somebody else put up', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5)])
  const app = await makeApp()
  app.err = new Error('staging failed')
  await relocateThreads(app)
  expect((await readStore()).threads[0].anchor).toEqual(BODY_ANCHOR)
  expect(app.err?.message).toBe('staging failed')
})

// -------------------------------------------------------------- triggers

test('loadFiles relocates every thread before the tree lands', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR), thread('t-2', 'src/a.ts', 1, 1)])
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const app = await makeApp()
  await app.loadFiles()

  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })
  expect(app.threadDrift('t-2')?.status).toBe('exact')
  const disk = await readStore()
  expect(disk.threads[0].range).toEqual({ start: 5, end: 6 })
  expect(disk.threads[1].anchor).toBeDefined()
})

test('refresh relocates against the store it just loaded', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  const app = await makeApp()
  await app.loadFiles()
  expect(app.threadDrift('t-1')?.status).toBe('exact')

  // An agent edits the file; the watcher would call refresh().
  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  await app.refresh()
  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })
  expect((await readStore()).threads[0].range).toEqual({ start: 5, end: 6 })
})

test('loadDiffFor relocates the threads of that file', async () => {
  await writeStore([thread('t-1', 'src/a.ts', 4, 5, BODY_ANCHOR)])
  const app = await makeApp()
  await app.loadFiles()
  expect(app.threadDrift('t-1')?.status).toBe('exact')

  await Bun.write(join(dir, 'src/a.ts'), "import { b } from './b'\n" + ORIGINAL)
  const file = app.findFile('src/a.ts')!
  await app.loadDiffFor(file)
  await app.relocation
  expect(app.threadDrift('t-1')).toEqual({ status: 'moved', from: { start: 4, end: 5 } })
  expect(app.store.threads[0].range).toEqual({ start: 5, end: 6 })
})
