/**
 * The store is shared with the Refiner VSCode extension, so these tests are
 * mostly about NOT breaking the other tool: unknown fields and the extension's
 * `anchor` must survive a load→mutate→save round-trip, and the serialized
 * formatting must match what the extension writes.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/comments.ts'

let dir = ''
let storePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-store-'))
  storePath = join(dir, '.refiner', 'comments.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const EXISTING = {
  version: 1,
  threads: [
    {
      id: 't-ms9j4trq-1',
      file: 'src/app/commands.ts',
      range: { start: 84, end: 86 },
      status: 'open',
      comments: [
        {
          id: 'm-ms9j4trq-2',
          author: 'Angel Romero',
          role: 'user',
          body: '[suggestion] Esta es una sugerencia',
          createdAt: '2026-07-31T22:44:09.025Z',
        },
      ],
      anchor: {
        lines: ['  showThreadCode: (path: string, line: number) => void'],
        before: ['  refineMoveTo: (row: number) => void'],
        after: ['  threadsList: () => void'],
      },
      // A field neither tool knows about today. Must still be there tomorrow.
      futureField: { nested: true },
    },
  ],
}

async function seed(data: unknown = EXISTING): Promise<void> {
  await Bun.write(storePath, JSON.stringify(data, null, 2) + '\n')
}

test('missing file yields an empty store', async () => {
  const s = await Store.load(storePath)
  expect(s.threads).toEqual([])
  expect(s.data.version).toBe(1)
})

test('load reads the extension schema', async () => {
  await seed()
  const s = await Store.load(storePath)
  expect(s.threads).toHaveLength(1)
  expect(s.threads[0].range).toEqual({ start: 84, end: 86 })
  expect(s.threadAt('src/app/commands.ts', 85)?.id).toBe('t-ms9j4trq-1')
  expect(s.threadAt('src/app/commands.ts', 83)).toBeNull()
  expect(s.hasThreadsFor('src/app/commands.ts')).toBe(true)
  expect(s.hasThreadsFor('nope.ts')).toBe(false)
})

test('anchor and unknown fields survive a mutate + save round-trip', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  await s.save()

  const after = JSON.parse(await Bun.file(storePath).text())
  const t = after.threads[0]
  expect(t.anchor).toEqual(EXISTING.threads[0].anchor)
  expect(t.futureField).toEqual({ nested: true })
  expect(t.comments).toHaveLength(2)
  expect(t.comments[1].body).toBe('a reply')
  expect(t.comments[1].role).toBe('user')
  expect(t.comments[0]).toEqual(EXISTING.threads[0].comments[0])
})

test('serialized formatting matches the extension (2-space indent, trailing newline)', async () => {
  await seed()
  const s = await Store.load(storePath)
  await s.save()
  const text = await Bun.file(storePath).text()
  expect(text).toBe(JSON.stringify(EXISTING, null, 2) + '\n')
})

test('addThread generates prefixed ids and defaults to open', async () => {
  const s = await Store.load(storePath)
  const t = s.addThread('a.ts', 3, 5, { author: 'angel', body: 'hi' })
  expect(t.id).toStartWith('t-')
  expect(t.comments[0].id).toStartWith('c-')
  expect(t.status).toBe('open')
  expect(t.range).toEqual({ start: 3, end: 5 })
  expect(s.threadAt('a.ts', 4)).not.toBeNull()
})

test('deleting the last comment leaves the thread empty for the caller to drop', async () => {
  const s = await Store.load(storePath)
  const t = s.addThread('a.ts', 1, 1, { author: 'angel', body: 'only' })
  s.deleteComment(t.id, 0)
  expect(s.threads[0].comments).toHaveLength(0)
  s.deleteThread(t.id)
  expect(s.threads).toHaveLength(0)
  expect(s.hasThreadsFor('a.ts')).toBe(false)
})

test('setCommentBody edits in place and rejects out-of-range', async () => {
  const s = await Store.load(storePath)
  const t = s.addThread('a.ts', 1, 1, { author: 'angel', body: 'before' })
  s.setCommentBody(t.id, 0, 'after')
  expect(s.threads[0].comments[0].body).toBe('after')
  expect(() => s.setCommentBody(t.id, 9, 'x')).toThrow('out of range')
  expect(() => s.setCommentBody('nope', 0, 'x')).toThrow('not found')
})

test('threadsForFile sorts by start line', async () => {
  const s = await Store.load(storePath)
  s.addThread('a.ts', 50, 50, { author: 'a', body: '1' })
  s.addThread('a.ts', 10, 10, { author: 'a', body: '2' })
  s.addThread('b.ts', 1, 1, { author: 'a', body: '3' })
  expect(s.threadsForFile('a.ts').map((t) => t.range.start)).toEqual([10, 50])
})

test('generated ids do not collide with ids already in the file', async () => {
  await seed()
  const s = await Store.load(storePath)
  const t = s.addThread('a.ts', 1, 1, { author: 'a', body: 'x' })
  const ids = new Set([
    ...s.threads.map((x) => x.id),
    ...s.threads.flatMap((x) => x.comments.map((c) => c.id)),
  ])
  // 2 threads + 2 comments, all distinct.
  expect(ids.size).toBe(4)
  expect(t.id).not.toBe('t-ms9j4trq-1')
})

test('corrupt JSON throws instead of silently resetting the file', async () => {
  await Bun.write(storePath, '{ not json')
  await expect(Store.load(storePath)).rejects.toThrow('decode')
})

test('a thread with a malformed range is normalized, not dropped', async () => {
  await seed({ version: 1, threads: [{ id: 'x', file: 'a.ts', comments: [] }] })
  const s = await Store.load(storePath)
  expect(s.threads).toHaveLength(1)
  expect(s.threads[0].range).toEqual({ start: 1, end: 1 })
  expect(s.threads[0].status).toBe('open')
})
