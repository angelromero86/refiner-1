/**
 * The thread modal after a save that merged.
 *
 * `ThreadModal.threadIdx` is an index into `store.threads`, and a save that finds
 * the file changed rebuilds that array from disk. An index left over from the old
 * one points at whatever slid into the slot — so `d`/`D`, which read the thread
 * straight out of `threads[threadIdx]`, would delete somebody else's thread. That
 * is trading one silent data loss for another, which is why the modal is
 * re-anchored by thread id (and the comment cursor by comment id).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, ModalMode, type TextInputs } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import { Mode, type Source } from '../src/git.ts'
import { handleModalKey, newThreadModal, submitModalCompose } from '../src/threads-ui.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

let dir = ''
let storePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-modal-'))
  storePath = join(dir, '.refiner', 'comments.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function thread(id: string, file: string): Record<string, unknown> {
  return {
    id,
    file,
    range: { start: 1, end: 1 },
    status: 'open',
    comments: [
      {
        id: `c-${id}`,
        author: 'someone',
        role: 'user',
        body: `body of ${id}`,
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ],
  }
}

async function writeStore(threads: unknown[]): Promise<void> {
  await Bun.write(storePath, JSON.stringify({ version: 1, threads }, null, 2) + '\n')
}

async function readThreadIds(): Promise<string[]> {
  const data = JSON.parse(await Bun.file(storePath).text())
  return data.threads.map((t: { id: string }) => t.id)
}

/** An app wired to a store at `storePath`, with a text widget it can read. */
async function makeApp(): Promise<{ app: App; setCompose: (v: string) => void }> {
  const app = new App(SOURCE, await Store.load(storePath))
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
  app.author = 'angel'
  return { app, setCompose: (v) => (compose = v) }
}

/** Wait for the fire-and-forget save AND the re-anchoring that follows it. */
async function settle(app: App): Promise<void> {
  await app.store.flush()
  await new Promise((r) => setTimeout(r, 5))
}

test('a merge that reorders threads re-anchors the open modal by id', async () => {
  await writeStore([thread('t-A', 'a.ts'), thread('t-B', 'b.ts')])
  const { app, setCompose } = await makeApp()
  // The reviewer opens t-B, which is at index 1 right now.
  app.modal = newThreadModal(1, 't-B', '', 0, 0)

  // Meanwhile the extension deletes t-A and an agent adds t-C.
  await writeStore([thread('t-B', 'b.ts'), thread('t-C', 'c.ts')])

  app.modal.mode = ModalMode.Compose
  setCompose('mi respuesta')
  submitModalCompose(app)
  await settle(app)

  // Index 1 now holds a completely different thread; the modal must not.
  expect(app.store.threads[1].id).toBe('t-C')
  expect(app.modal?.threadIdx).toBe(0)
  expect(app.store.threads[app.modal!.threadIdx].id).toBe('t-B')
  // The reply landed on t-B, and t-A stayed deleted.
  expect(await readThreadIds()).toEqual(['t-B', 't-C'])
  expect(app.store.threads[0].comments).toHaveLength(2)
})

test('D after a merge deletes the thread the modal is showing, not its old index', async () => {
  await writeStore([thread('t-A', 'a.ts'), thread('t-B', 'b.ts')])
  const { app, setCompose } = await makeApp()
  app.modal = newThreadModal(1, 't-B', '', 0, 0)

  await writeStore([thread('t-B', 'b.ts'), thread('t-C', 'c.ts')])

  app.modal.mode = ModalMode.Compose
  setCompose('mi respuesta')
  submitModalCompose(app)
  await settle(app)

  expect(handleModalKey(app, 'D')).toBe(true)
  await settle(app)

  expect(await readThreadIds()).toEqual(['t-C'])
  expect(app.modal).toBeNull()
})

test('the modal closes when the thread it was showing was deleted elsewhere', async () => {
  await writeStore([thread('t-A', 'a.ts'), thread('t-B', 'b.ts')])
  const { app, setCompose } = await makeApp()
  app.modal = newThreadModal(1, 't-B', '', 0, 0)

  // Both of ours are gone; only the agent's thread is left.
  await writeStore([thread('t-C', 'c.ts')])

  app.modal.mode = ModalMode.Compose
  setCompose('respuesta huerfana')
  submitModalCompose(app)
  await settle(app)

  expect(app.modal).toBeNull()
  // And the reviewer is told, rather than left believing it saved.
  expect(app.err?.message).toMatch(/nowhere to go/)
  expect(await readThreadIds()).toEqual(['t-C'])
})

test('the comment cursor follows its comment across a merge', async () => {
  await writeStore([thread('t-A', 'a.ts')])
  const { app, setCompose } = await makeApp()
  app.modal = newThreadModal(0, 't-A', '', 0, 0)
  // Browsing the first (and only) comment.
  expect(app.modal.selectedComment).toBe(0)

  // The agent gets its reply in first, ahead of everything we are about to add.
  const withAgentFirst = thread('t-A', 'a.ts')
  withAgentFirst.comments = [
    {
      id: 'c-agent',
      author: 'Claude',
      role: 'assistant',
      body: 'from the agent',
      createdAt: '2026-08-01T11:00:00.000Z',
    },
    ...(withAgentFirst.comments as unknown[]),
  ]
  await writeStore([withAgentFirst])

  app.modal.mode = ModalMode.Compose
  setCompose('mi respuesta')
  submitModalCompose(app)
  await settle(app)

  // submitModalCompose parks the cursor on the comment it just added; after the
  // merge that comment is last, behind the agent's.
  const comments = app.store.threads[0].comments
  expect(comments.map((c) => c.body)).toEqual(['from the agent', 'body of t-A', 'mi respuesta'])
  expect(comments[app.modal!.selectedComment].body).toBe('mi respuesta')
})

test('a new thread remembers its id, so its first reply re-anchors too', async () => {
  await writeStore([thread('t-A', 'a.ts')])
  const { app, setCompose } = await makeApp()
  app.modal = newThreadModal(-1, '', 'b.ts', 4, 6)
  setCompose('hilo nuevo')
  submitModalCompose(app)
  await settle(app)

  const created = app.store.threads[app.modal!.threadIdx]
  expect(app.modal?.threadId).toBe(created.id)
  expect(created.file).toBe('b.ts')

  // Now somebody else reorders the file under us and the reviewer replies.
  const mine = JSON.parse(await Bun.file(storePath).text()).threads.find(
    (t: { id: string }) => t.id === created.id,
  )
  await writeStore([thread('t-Z', 'z.ts'), mine])

  app.modal!.mode = ModalMode.Compose
  setCompose('y una respuesta')
  submitModalCompose(app)
  await settle(app)

  expect(app.store.threads[app.modal!.threadIdx].id).toBe(created.id)
  expect(app.store.threads[app.modal!.threadIdx].comments).toHaveLength(2)
  expect(await readThreadIds()).toEqual(['t-Z', created.id])
})
