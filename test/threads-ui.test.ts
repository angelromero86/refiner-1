/**
 * The card keys and the inline compose block (`src/threads-ui.ts`), including
 * what happens after a save that merged.
 *
 * A save that finds the file changed rebuilds `store.threads` from disk, and
 * every index the UI held means something else afterwards — the modal-era bug
 * was `D` deleting whoever slid into the old slot. Everything is therefore
 * re-derived from ids: the cursor from the card it was on, the compose block
 * from its thread.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { CliRenderer } from '@opentui/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from '../src/app.ts'
import { Store, type StoredThread } from '../src/comments.ts'
import { route } from '../src/dispatch.ts'
import { handleCardKey, openOrCreateThread, persistStore, submitCompose } from '../src/threads-ui.ts'
import { FILE, diffOf, openPane, thread } from './pane.ts'

let dir = ''
let storePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-threads-ui-'))
  storePath = join(dir, '.refiner', 'comments.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeStore(threads: unknown[]): Promise<void> {
  await Bun.write(storePath, JSON.stringify({ version: 1, threads }, null, 2) + '\n')
}

async function readThreadIds(): Promise<string[]> {
  const data = JSON.parse(await Bun.file(storePath).text())
  return data.threads.map((t: { id: string }) => t.id)
}

/** A pane over `src/f.ts` whose store is the file at `storePath`. */
async function paneOn(threads: StoredThread[]): Promise<App> {
  await writeStore(threads)
  return openPane({ store: await Store.load(storePath) })
}

/** Wait for the fire-and-forget save AND the re-anchoring that follows it. */
async function settle(app: App): Promise<void> {
  await app.store.flush()
  await new Promise((r) => setTimeout(r, 5))
}

const renderer = {} as CliRenderer
const press = (app: App, ...keys: string[]) => {
  for (const k of keys) route(app, renderer, k)
}
const onCard = (app: App, id: string) => {
  app.contentCursor = app.cardStartOf(id)
  expect(app.threadAtCursor()?.id).toBe(id)
}

// ------------------------------------------------------------------- merges

test('a merge that reorders threads lands the reply by id and keeps the cursor on its card', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4)])
  onCard(app, 't-B')
  press(app, 'r')
  expect(app.compose).toMatchObject({ kind: 'reply', threadId: 't-B' })
  expect(app.cursorRow()?.kind).toBe('compose')

  // Meanwhile the extension deletes t-A and an agent adds t-C.
  await writeStore([thread('t-B', 4, 4), thread('t-C', 6, 6)])

  app.inputs.setComposeValue('mi respuesta')
  press(app, 'alt+enter')
  await settle(app)

  // Index 1 now holds a completely different thread; the reply must not.
  expect(app.store.threads.map((t) => t.id)).toEqual(['t-B', 't-C'])
  expect(app.store.threads[0].comments.map((c) => c.body)).toEqual(['body of t-B', 'mi respuesta'])
  expect(await readThreadIds()).toEqual(['t-B', 't-C'])
  // Compose closed, the thread expanded, the cursor on its header.
  expect(app.compose).toBeNull()
  expect(app.expandedThreads.has('t-B')).toBe(true)
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-B', line: 0 })
})

test('D after a merge deletes the thread under the cursor, not its old index', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4)])
  onCard(app, 't-B')
  press(app, 'r')
  await writeStore([thread('t-B', 4, 4), thread('t-C', 6, 6)])
  app.inputs.setComposeValue('mi respuesta')
  press(app, 'alt+enter')
  await settle(app)

  expect(app.threadAtCursor()?.id).toBe('t-B')
  press(app, 'D')
  expect(app.confirm?.title).toMatch(/Delete this thread\? \(2 comments\)/)
  press(app, 'y')
  await settle(app)

  expect(await readThreadIds()).toEqual(['t-C'])
  expect(app.confirm).toBeNull()
  // The cursor fell back onto the code the card sat under.
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 4 })
})

test('n on the confirm keeps the thread', async () => {
  const app = await paneOn([thread('t-A', 1, 1)])
  onCard(app, 't-A')
  press(app, 'D', 'n')
  expect(app.confirm).toBeNull()
  expect(app.store.threads).toHaveLength(1)
})

test('compose closes when the thread it was writing in was deleted elsewhere', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4)])
  onCard(app, 't-B')
  press(app, 'r')

  // Both of ours are gone; only the agent's thread is left.
  await writeStore([thread('t-C', 6, 6)])

  app.inputs.setComposeValue('respuesta huerfana')
  press(app, 'alt+enter')
  await settle(app)

  expect(app.compose).toBeNull()
  // And the reviewer is told, rather than left believing it saved.
  expect(app.err?.message).toMatch(/nowhere to go/)
  expect(await readThreadIds()).toEqual(['t-C'])
})

test('a reply being typed while another client deletes the thread is closed with a notice', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4)])
  onCard(app, 't-B')
  press(app, 'r')
  await writeStore([thread('t-A', 1, 1)])
  // Any save that merges — here a relocation-style write on the other thread.
  app.store.setStatus('t-A', 'resolved')
  await persistStore(app)
  expect(app.compose).toBeNull()
  expect(app.err?.message).toMatch(/deleted by another client/)
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 4 })
})

test('a new thread remembers its id, so its first reply re-anchors too', async () => {
  const app = await paneOn([thread('t-A', 1, 1)])
  // Lines 6-7, a selection ending on unified idx 7.
  app.selectionAnchor = app.displayIdxOfDiff(6)
  app.contentCursor = app.displayIdxOfDiff(7)
  press(app, 'enter')
  expect(app.compose).toMatchObject({ kind: 'new', file: FILE, start: 6, end: 7 })
  app.inputs.setComposeValue('hilo nuevo')
  press(app, 'alt+enter')
  await settle(app)

  const created = app.threadAtCursor()!
  expect(created.range).toEqual({ start: 6, end: 7 })
  expect(created.comments[0].body).toBe('hilo nuevo')

  // Now somebody else reorders the file under us and the reviewer replies.
  const mine = JSON.parse(await Bun.file(storePath).text()).threads.find(
    (t: { id: string }) => t.id === created.id,
  )
  await writeStore([thread('t-Z', 9, 9), mine])
  press(app, 'r')
  app.inputs.setComposeValue('y una respuesta')
  press(app, 'alt+enter')
  await settle(app)

  expect(app.threadAtCursor()?.id).toBe(created.id)
  expect(app.threadAtCursor()?.comments).toHaveLength(2)
  expect(await readThreadIds()).toEqual(['t-Z', created.id])
})

// -------------------------------------------------------------------- keys

test('enter on a line with a thread goes to its card and expands it', async () => {
  const app = await paneOn([thread('t-A', 3, 4)])
  app.contentCursor = app.displayIdxOfDiff(3) // line 3, inside 3-4
  press(app, 'enter')
  expect(app.compose).toBeNull()
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A', line: 0 })
  expect(app.expandedThreads.has('t-A')).toBe(true)
  // enter on the card folds it again; and again unfolds.
  press(app, 'enter')
  expect(app.expandedThreads.has('t-A')).toBe(false)
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A', line: 0 })
  press(app, 'enter')
  expect(app.expandedThreads.has('t-A')).toBe(true)
})

test('enter over deleted lines only does nothing', async () => {
  const app = await paneOn([])
  app.contentCursor = app.displayIdxOfDiff(2) // the del-only row
  press(app, 'enter')
  expect(app.compose).toBeNull()
})

test('esc abandons a new thread and puts the cursor back on the anchor line', async () => {
  const app = await paneOn([])
  app.contentCursor = app.displayIdxOfDiff(6)
  press(app, 'enter')
  expect(app.compose?.kind).toBe('new')
  const start = app.activeLayout().composeStart
  expect(app.contentCursor).toBe(start)
  // Typing goes to the widget: the key is not claimed, and nothing global fires.
  expect(route(app, renderer, 'q')).toBe(false)
  expect(app.confirm).toBeNull()
  press(app, 'esc')
  expect(app.compose).toBeNull()
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 6 })
  expect(app.store.threads).toHaveLength(0)
})

test('e edits the last comment of yours; none → a banner, not a compose', async () => {
  const app = await paneOn([
    thread('t-A', 1, 1, { bodies: ['opener', 'mine', 'theirs'], authors: ['Claude', 'angel', 'Claude'] }),
    thread('t-B', 4, 4, { bodies: ['only theirs'], authors: ['Claude'] }),
  ])
  // Agents are `role: user` in the fixture; make the second thread an assistant's.
  app.store.threads[1].comments[0].role = 'assistant'
  onCard(app, 't-A')
  press(app, 'e')
  expect(app.compose).toMatchObject({ kind: 'edit', threadId: 't-A', commentId: 't-A-c1' })
  expect(app.inputs.composeValue()).toBe('mine')
  app.inputs.setComposeValue('mine, edited')
  press(app, 'ctrl+s')
  await settle(app)
  expect(app.store.threads[0].comments[1].body).toBe('mine, edited')
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A' })

  onCard(app, 't-B')
  press(app, 'e')
  expect(app.compose).toBeNull()
  expect(app.err?.message).toMatch(/no comment of yours/)
})

test('x resolves and folds the card; x again reopens it, still folded', async () => {
  const app = await paneOn([thread('t-A', 3, 4)])
  onCard(app, 't-A')
  press(app, 'enter') // expand
  expect(app.activeLayout().rows.filter((r) => r.kind === 'card')).toHaveLength(3)
  press(app, 'x')
  await settle(app)
  expect(app.store.threads[0].status).toBe('resolved')
  expect(app.activeLayout().rows.filter((r) => r.kind === 'card')).toHaveLength(1)
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A', line: 0 })
  expect(JSON.parse(await Bun.file(storePath).text()).threads[0].status).toBe('resolved')
  press(app, 'x')
  await settle(app)
  expect(app.store.threads[0].status).toBe('open')
  expect(app.expandedThreads.has('t-A')).toBe(false)
  expect(app.activeLayout().rows.filter((r) => r.kind === 'card')).toHaveLength(2)
})

test('the card keys yield to the pane for anything they do not claim', async () => {
  const app = await paneOn([thread('t-A', 3, 4)])
  onCard(app, 't-A')
  expect(handleCardKey(app, 'down')).toBe(false)
  press(app, 'down')
  expect(app.cursorRow()).toMatchObject({ kind: 'card', line: 1 })
  press(app, 'down')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 5 })
  // Off the card, `r` is the global refresh again — not a reply.
  expect(app.threadAtCursor()).toBeNull()
})

test('z expands every card in the file, then folds them all', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4), thread('t-C', 8, 8)])
  app.expandedThreads.add('t-B')
  app.threadsEpoch++
  press(app, 'z')
  expect([...app.expandedThreads].sort()).toEqual(['t-A', 't-B', 't-C'])
  press(app, 'z')
  expect(app.expandedThreads.size).toBe(0)
})

// ---------------------------------------------------------------- n / N

test('n and N walk the threads in tree order, across files, and wrap', async () => {
  await writeStore([])
  const other = 'src/g.ts'
  const threads = [
    { ...thread('t-g', 2, 2), file: other },
    thread('t-f2', 6, 6),
    thread('t-f1', 2, 2),
  ]
  await writeStore(threads)
  const app = openPane({
    store: await Store.load(storePath),
    files: [{ path: other, diff: diffOf([' one', ' two', '+three']).replaceAll(FILE, other) }],
  })
  app.contentCursor = 0
  press(app, 'n')
  expect(app.selectedPath).toBe(FILE)
  expect(app.threadAtCursor()?.id).toBe('t-f1')
  expect(app.expandedThreads.has('t-f1')).toBe(true)
  press(app, 'n')
  expect(app.threadAtCursor()?.id).toBe('t-f2')
  press(app, 'n')
  expect(app.selectedPath).toBe(other)
  expect(app.threadAtCursor()?.id).toBe('t-g')
  press(app, 'n')
  expect(app.selectedPath).toBe(FILE)
  expect(app.threadAtCursor()?.id).toBe('t-f1')
  press(app, 'N')
  expect(app.threadAtCursor()?.id).toBe('t-g')
  press(app, 'N', 'N')
  expect(app.threadAtCursor()?.id).toBe('t-f1')
  // Between threads: N goes to the one before the cursor's line.
  app.contentCursor = app.displayIdxOfDiff(4) // line 4, between t-f1 (2) and t-f2 (6)
  press(app, 'N')
  expect(app.threadAtCursor()?.id).toBe('t-f1')
  app.contentCursor = app.displayIdxOfDiff(4)
  press(app, 'n')
  expect(app.threadAtCursor()?.id).toBe('t-f2')
})

test('the thread list jumps to the card', async () => {
  const app = await paneOn([thread('t-A', 1, 1), thread('t-B', 4, 4)])
  press(app, 'c')
  expect(app.threadList).not.toBeNull()
  press(app, 'down', 'enter')
  expect(app.threadList).toBeNull()
  expect(app.threadAtCursor()?.id).toBe('t-B')
  expect(app.expandedThreads.has('t-B')).toBe(true)
})

// ------------------------------------------------------------ drift anchor

test('a new thread carries an anchor captured from the working tree', async () => {
  // The read is cwd-relative, like every file access in refiner.
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    await Bun.write(join(dir, FILE), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n')
    const app = await paneOn([])
    app.selectionAnchor = app.displayIdxOfDiff(4) // line 4
    app.contentCursor = app.displayIdxOfDiff(5) // line 5
    openOrCreateThread(app)
    app.inputs.setComposeValue('hilo con anchor')
    submitCompose(app)
    await settle(app)

    const created = app.threadAtCursor()!
    expect(created.anchor).toEqual({
      lines: ['l4', 'l5'],
      before: ['l1', 'l2', 'l3'],
      after: ['l6', 'l7', 'l8'],
    })
    const disk = JSON.parse(await Bun.file(storePath).text())
    expect(disk.threads[0].anchor).toEqual(created.anchor)
  } finally {
    process.chdir(cwd)
  }
})

test('a new thread on a file that cannot be read is created without an anchor', async () => {
  const app = await paneOn([])
  app.compose = { kind: 'new', threadId: '', file: 'does-not-exist.ts', start: 4, end: 5, commentId: '' }
  app.inputs.setComposeValue('sin anchor')
  submitCompose(app)
  await settle(app)

  const created = app.store.threads[0]
  expect('anchor' in created).toBe(false)
  expect(created.range).toEqual({ start: 4, end: 5 })
})
