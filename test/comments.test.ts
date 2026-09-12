/**
 * The store is shared with the Refiner VSCode extension, so these tests are
 * mostly about NOT breaking the other tool: unknown fields and the extension's
 * `anchor` must survive a load→mutate→save round-trip, and the serialized
 * formatting must match what the extension writes.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
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

// ------------------------------------------------------- unreadable = no writes
//
// Every save is a whole-file replace, so a store that could not READ the file
// must never write it: the bytes it would flatten are the extension's, or an
// agent's, or a half-written file that is about to be finished. These pin the
// refusal from both ends — never write when we didn't read, always write when we
// did (a missing or empty file is an ordinary new repo, not a corrupt one).

const MALFORMED = '{\n  "version": 1,\n  "threads": [\n    { "id": "t-abc-1" }\n'

test('loadOrReadOnly on malformed JSON yields a read-only store', async () => {
  await Bun.write(storePath, MALFORMED)
  const s = await Store.loadOrReadOnly(storePath)
  expect(s.readOnly).toBe(true)
  expect(s.threads).toEqual([])
  expect(s.loadError?.message).toMatch(/decode/)
})

test('a read-only store refuses to save and leaves the file byte-for-byte', async () => {
  await Bun.write(storePath, MALFORMED)
  const before = await Bun.file(storePath).text()

  // The exact path from the report: fall back, take a comment, save.
  const s = await Store.loadOrReadOnly(storePath)
  s.addThread('src/a.txt', 1, 1, { author: 'angel', body: 'nuevo comentario' })
  await expect(s.save()).rejects.toThrow(/refusing to overwrite/)

  expect(await Bun.file(storePath).text()).toBe(before)
})

test('a refused save leaves the sync witness alone', async () => {
  // Otherwise the watcher compares the file against a write that never happened,
  // decides it is our own echo and skips the reload that would repair things.
  await Bun.write(storePath, MALFORMED)
  const s = await Store.loadOrReadOnly(storePath)
  await expect(s.save()).rejects.toThrow(/refusing to overwrite/)
  expect(s.lastSyncedText).toBeNull()
  expect(s.writeSeq).toBe(0)
})

test('the refusal names the file and says what to do', async () => {
  await Bun.write(storePath, MALFORMED)
  const s = await Store.loadOrReadOnly(storePath)
  const blocked = s.writeBlocked()
  expect(blocked?.message).toContain(storePath)
  expect(blocked?.message).toMatch(/press r/)
  // Same wording the write path uses, so the UI can refuse up front.
  await expect(s.save()).rejects.toThrow(blocked?.message)
})

test('a missing store file stays writable', async () => {
  const s = await Store.loadOrReadOnly(storePath)
  expect(s.readOnly).toBe(false)
  expect(s.writeBlocked()).toBeNull()
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'first ever' })
  await s.save()
  expect((await Store.load(storePath)).threads).toHaveLength(1)
})

test('an empty store file stays writable', async () => {
  await Bun.write(storePath, '  \n')
  const s = await Store.loadOrReadOnly(storePath)
  expect(s.readOnly).toBe(false)
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'first ever' })
  await s.save()
  expect((await Store.load(storePath)).threads).toHaveLength(1)
})

test('markUnreadable keeps threads readable but blocks writes', async () => {
  // The symmetric case: loaded fine, then the file broke underneath us.
  await seed()
  const before = await Bun.file(storePath).text()
  const s = await Store.load(storePath)
  s.markUnreadable(new Error('decode boom'))

  expect(s.readOnly).toBe(true)
  expect(s.threads).toHaveLength(1)
  expect(s.threadAt('src/app/commands.ts', 85)?.id).toBe('t-ms9j4trq-1')

  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  await expect(s.save()).rejects.toThrow(/refusing to overwrite/)
  expect(await Bun.file(storePath).text()).toBe(before)
})

test('a repaired file loads clean again, without restarting', async () => {
  await Bun.write(storePath, MALFORMED)
  expect((await Store.loadOrReadOnly(storePath)).readOnly).toBe(true)

  // What the watcher does after somebody fixes the JSON: load a fresh store.
  await seed()
  const s = await Store.loadOrReadOnly(storePath)
  expect(s.readOnly).toBe(false)
  expect(s.threads).toHaveLength(1)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  await s.save()
  expect((await Store.load(storePath)).threads[0].comments).toHaveLength(2)
})

// -------------------------------------------- concurrent writers = merge, not clobber
//
// The store is open for as long as the TUI session lasts, and the extension and
// agents write to the same file the whole time. Every save therefore re-reads and
// replays the local mutation log onto whatever it finds, addressing everything by
// id: an index means nothing once somebody else has inserted into the array.

/** What another process does: read, add, write the whole file back. */
async function externalWrite(mutate: (data: any) => void): Promise<void> {
  const text = await Bun.file(storePath).text()
  const data = JSON.parse(text)
  mutate(data)
  await Bun.write(storePath, JSON.stringify(data, null, 2) + '\n')
}

function agentThread(id: string): Record<string, unknown> {
  return {
    id,
    file: 'src/other.ts',
    range: { start: 1, end: 2 },
    status: 'open',
    comments: [
      {
        id: `c-${id}`,
        author: 'Claude',
        role: 'assistant',
        body: 'written by the agent',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ],
  }
}

async function readFile(): Promise<any> {
  return JSON.parse(await Bun.file(storePath).text())
}

test('load records the sync witness', async () => {
  await seed()
  const s = await Store.load(storePath)
  expect(s.lastSyncedText).toBe(await Bun.file(storePath).text())
  // A missing file has no bytes to be synced with, so the next save must merge
  // rather than assume the file is still absent.
  await rm(storePath)
  expect((await Store.load(storePath)).lastSyncedText).toBeNull()
})

test('save does not lose a thread written by another process between load and save', async () => {
  await seed()
  const s = await Store.load(storePath)

  // T2: an agent appends a thread while the reviewer is composing.
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))

  // T3: the reviewer saves their own new thread.
  const mine = s.addThread('src/a.ts', 10, 10, { author: 'angel', body: 'mio' })
  const report = await s.save()

  expect(report.merged).toBe(true)
  const after = await readFile()
  // Disk order first, ours appended: additions commute, the file's order is the
  // contract's order.
  expect(after.threads.map((t: any) => t.id)).toEqual(['t-ms9j4trq-1', 't-agent-1', mine.id])
  expect(after.threads[1].comments).toHaveLength(1)
  expect(after.threads[1].comments[0].body).toBe('written by the agent')
  // And in memory, so the UI is showing the merged truth.
  expect(s.threads.map((t) => t.id)).toEqual(['t-ms9j4trq-1', 't-agent-1', mine.id])
  expect(s.indexOfThread('t-agent-1')).toBe(1)
})

test('two replies to the same thread both survive, in disk-then-local order', async () => {
  await seed()
  const s = await Store.load(storePath)

  await externalWrite((d) =>
    d.threads[0].comments.push({
      id: 'c-agent-1',
      author: 'Claude',
      role: 'assistant',
      body: 'from the agent',
      createdAt: '2026-08-01T10:00:00.000Z',
    }),
  )
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'from me' })
  const report = await s.save()

  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  const comments = (await readFile()).threads[0].comments
  expect(comments.map((c: any) => c.body)).toEqual([
    '[suggestion] Esta es una sugerencia',
    'from the agent',
    'from me',
  ])
})

test('the merge does not resurrect a thread deleted locally', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.deleteThread('t-ms9j4trq-1')
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))
  await s.save()

  const ids = (await readFile()).threads.map((t: any) => t.id)
  expect(ids).toEqual(['t-agent-1'])
})

test('a deleted comment stays deleted through a merge', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.deleteComment('t-ms9j4trq-1', 0)
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))
  await s.save()

  const after = await readFile()
  expect(after.threads[0].comments).toEqual([])
  expect(after.threads[1].id).toBe('t-agent-1')
})

test('a reply to a thread the other client deleted is dropped, not thrown', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'into the void' })
  await externalWrite((d) => {
    d.threads = [agentThread('t-agent-1')]
  })

  const report = await s.save()
  expect(report.dropped).toBe(1)
  expect(report.merged).toBe(true)
  const after = await readFile()
  expect(after.threads.map((t: any) => t.id)).toEqual(['t-agent-1'])
  // No phantom thread invented to hold the orphaned reply.
  expect(after.threads).toHaveLength(1)
})

test('editing a comment the other client also edited wins, and says so', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setCommentBody('t-ms9j4trq-1', 0, 'my version')
  await externalWrite((d) => {
    d.threads[0].comments[0].body = 'their version'
  })

  const report = await s.save()
  expect(report.overwritten).toBe(1)
  expect((await readFile()).threads[0].comments[0].body).toBe('my version')
})

test('an edit is not reported as an overwrite when nobody else touched it', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setCommentBody('t-ms9j4trq-1', 0, 'my version')
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))

  const report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  expect((await readFile()).threads[0].comments[0].body).toBe('my version')
})

test("anchor and unknown fields written by the OTHER process survive the merge", async () => {
  await seed()
  const s = await Store.load(storePath)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  await externalWrite((d) => {
    d.threads[0].anchor = { lines: ['moved'], before: [], after: [] }
    d.threads[0].futureField = { nested: 'theirs' }
    d.threads[0].brandNew = 42
  })

  await s.save()
  const t = (await readFile()).threads[0]
  expect(t.anchor).toEqual({ lines: ['moved'], before: [], after: [] })
  expect(t.futureField).toEqual({ nested: 'theirs' })
  expect(t.brandNew).toBe(42)
  expect(t.comments).toHaveLength(2)
})

test('unknown ROOT keys survive a plain round-trip and a merge', async () => {
  await seed({ ...EXISTING, schema: 'x', extra: { deep: [1, 2] } })
  const s = await Store.load(storePath)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  await s.save()

  let after = await readFile()
  expect(after.schema).toBe('x')
  expect(after.extra).toEqual({ deep: [1, 2] })

  // And again through the merge path, where the base is the file's own object.
  await externalWrite((d) => {
    d.rootFromThem = true
  })
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'another' })
  expect((await s.save()).merged).toBe(true)

  after = await readFile()
  expect(after.schema).toBe('x')
  expect(after.rootFromThem).toBe(true)
  expect(after.threads).toHaveLength(2)
})

test('formatting still matches the extension after a merge', async () => {
  await seed()
  const s = await Store.load(storePath)
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'mine' })
  await s.save()

  const text = await Bun.file(storePath).text()
  expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n')
  expect(text.endsWith('}\n')).toBe(true)
})

test('save refuses when the disk stopped parsing, and keeps the pending edits', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'nuevo comentario' })

  // An agent caught mid-write, or a conflict marker.
  await Bun.write(storePath, MALFORMED)
  const before = await Bun.file(storePath).text()

  await expect(s.save()).rejects.toThrow(/refusing to overwrite/)
  expect(await Bun.file(storePath).text()).toBe(before)
  // Bug 01's poison is one-way: the refusal holds until a fresh load proves the
  // file readable again. Nothing local was thrown away in the meantime.
  expect(s.readOnly).toBe(true)
  expect(s.hasPendingWrites()).toBe(true)
  expect(s.threads).toHaveLength(2)
  await expect(s.save()).rejects.toThrow(/refusing to overwrite/)
  // But nothing is WRITING any more, which is what the watcher gates on: those
  // stranded edits must not block the refresh that reloads a repaired file.
  expect(s.isWriting()).toBe(false)
})

test('concurrent saves do not clobber each other', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'first' })
  const a = s.save()
  s.addThread('b.ts', 2, 2, { author: 'angel', body: 'second' })
  const b = s.save()
  await Promise.all([a, b])

  const bodies = (await readFile()).threads.flatMap((t: any) =>
    t.comments.map((c: any) => c.body),
  )
  expect(bodies.filter((x: string) => x === 'first')).toHaveLength(1)
  expect(bodies.filter((x: string) => x === 'second')).toHaveLength(1)
})

test('an uneventful save takes the fast path and updates the witness', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.appendComment('t-ms9j4trq-1', { author: 'angel', body: 'a reply' })
  const report = await s.save()

  expect(report).toEqual({ merged: false, dropped: 0, overwritten: 0 })
  // The witness must be the bytes actually on disk, or the watcher stops
  // recognising our own echo and refreshes the whole TUI on every keystroke.
  expect(s.lastSyncedText).toBe(await Bun.file(storePath).text())
  expect(s.hasPendingWrites()).toBe(false)
  expect(s.writeSeq).toBe(1)
})

test('the file is replaced, never truncated in place', async () => {
  // A reader that looks mid-write must see either the old bytes or the new ones,
  // never a half-file — which is precisely the malformed input that turns the
  // other client read-only.
  await seed()
  const s = await Store.load(storePath)
  const before = statSync(storePath).ino
  s.addThread('a.ts', 1, 1, { author: 'angel', body: 'x' })
  await s.save()
  expect(statSync(storePath).ino).not.toBe(before)
  // And no temp file left behind.
  expect(readdirSync(join(dir, '.refiner'))).toEqual(['comments.json'])
})

test('a thread with a malformed range is normalized, not dropped', async () => {
  await seed({ version: 1, threads: [{ id: 'x', file: 'a.ts', comments: [] }] })
  const s = await Store.load(storePath)
  expect(s.threads).toHaveLength(1)
  expect(s.threads[0].range).toEqual({ start: 1, end: 1 })
  expect(s.threads[0].status).toBe('open')
})

// ------------------------------------------------------------- relocation
// `setRange` and `setAnchor` are what drift tracking writes (`src/relocate.ts`).
// They ride the same id-keyed log as every other mutation, so a corrected range
// survives a merge onto a file another client rewrote meanwhile — and, unlike a
// reply or an edit, they never count as a conflict: both clients derive them
// from the same file with the same algorithm.

const NEW_ANCHOR = { lines: ['  const y = a(x)'], before: ['{'], after: ['}'] }

test('setRange moves the thread in place and persists', async () => {
  await seed()
  const s = await Store.load(storePath)
  const range = s.threads[0].range
  s.setRange('t-ms9j4trq-1', 90, 92)
  // Same object: whatever else lives inside `range` is kept.
  expect(s.threads[0].range).toBe(range)
  expect(s.threadAt('src/app/commands.ts', 91)?.id).toBe('t-ms9j4trq-1')
  expect(s.threadAt('src/app/commands.ts', 85)).toBeNull()
  expect(s.hasPendingWrites()).toBe(true)

  await s.save()
  const t = (await readFile()).threads[0]
  expect(t.range).toEqual({ start: 90, end: 92 })
  expect(t.anchor).toEqual(EXISTING.threads[0].anchor)
  expect(t.futureField).toEqual({ nested: true })
})

test('setAnchor backfills the snapshot and persists', async () => {
  await seed({ ...EXISTING, threads: [{ ...EXISTING.threads[0], anchor: undefined }] })
  const s = await Store.load(storePath)
  expect(s.threads[0].anchor).toBeUndefined()
  s.setAnchor('t-ms9j4trq-1', NEW_ANCHOR)
  await s.save()
  expect((await readFile()).threads[0].anchor).toEqual(NEW_ANCHOR)
})

test('setRange and setAnchor throw on an unknown thread', async () => {
  const s = await Store.load(storePath)
  expect(() => s.setRange('nope', 1, 1)).toThrow(/not found/)
  expect(() => s.setAnchor('nope', NEW_ANCHOR)).toThrow(/not found/)
})

test('a corrected range survives a merge, and does not touch what the other client wrote', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setRange('t-ms9j4trq-1', 90, 92)
  s.setAnchor('t-ms9j4trq-1', NEW_ANCHOR)

  // An agent replies and adds a thread while we were relocating.
  await externalWrite((d) => {
    d.threads[0].comments.push({
      id: 'c-agent-1',
      author: 'Claude',
      role: 'assistant',
      body: 'from the agent',
      createdAt: '2026-08-01T11:00:00.000Z',
    })
    d.threads[0].futureField = { nested: 'theirs' }
    d.threads.push(agentThread('t-agent-1'))
  })

  const report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  const after = await readFile()
  expect(after.threads.map((t: any) => t.id)).toEqual(['t-ms9j4trq-1', 't-agent-1'])
  expect(after.threads[0].range).toEqual({ start: 90, end: 92 })
  expect(after.threads[0].anchor).toEqual(NEW_ANCHOR)
  expect(after.threads[0].comments.map((c: any) => c.id)).toEqual(['m-ms9j4trq-2', 'c-agent-1'])
  expect(after.threads[0].futureField).toEqual({ nested: 'theirs' })
  expect(after.threads[1].range).toEqual({ start: 1, end: 2 })
  // And in memory.
  expect(s.threads[0].range).toEqual({ start: 90, end: 92 })
})

test('a range written by both clients is last-writer-wins, never a conflict', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setRange('t-ms9j4trq-1', 90, 92)
  // The extension relocated the same thread from a newer file.
  await externalWrite((d) => {
    d.threads[0].range = { start: 95, end: 97 }
    d.threads[0].anchor = { lines: ['theirs'], before: [], after: [] }
  })
  const report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  const t = (await readFile()).threads[0]
  expect(t.range).toEqual({ start: 90, end: 92 })
  // We only wrote the range; their anchor is kept.
  expect(t.anchor).toEqual({ lines: ['theirs'], before: [], after: [] })
})

test('relocating a thread the other client deleted is a no-op, not a dropped edit', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setRange('t-ms9j4trq-1', 90, 92)
  s.setAnchor('t-ms9j4trq-1', NEW_ANCHOR)
  await externalWrite((d) => {
    d.threads = [agentThread('t-agent-1')]
  })
  const report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  expect((await readFile()).threads.map((t: any) => t.id)).toEqual(['t-agent-1'])
})

test('addThread stores the anchor it was given, through a plain save and a merge', async () => {
  await seed()
  const s = await Store.load(storePath)
  const t = s.addThread('src/a.ts', 10, 11, { author: 'angel', body: 'mio' }, NEW_ANCHOR)
  expect(t.anchor).toEqual(NEW_ANCHOR)
  await externalWrite((d) => d.threads.push(agentThread('t-agent-1')))
  await s.save()
  const after = await readFile()
  const mine = after.threads.find((x: any) => x.id === t.id)
  expect(mine.anchor).toEqual(NEW_ANCHOR)
  expect(mine.range).toEqual({ start: 10, end: 11 })
  // Without one, the key is absent rather than null — the extension backfills
  // on `!st.anchor`, and so does refiner.
  const bare = s.addThread('src/b.ts', 1, 1, { author: 'angel', body: 'bare' })
  expect('anchor' in bare).toBe(false)
})

// ----------------------------------------------------------------- status
// `setStatus` is the reviewer's `x`: resolve or reopen. Same id-keyed log, so
// a verdict given while an agent was replying lands on the merged copy.

test('setStatus flips the thread and persists', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setStatus('t-ms9j4trq-1', 'resolved')
  expect(s.threads[0].status).toBe('resolved')
  expect(s.hasPendingWrites()).toBe(true)
  await s.save()
  expect((await readFile()).threads[0].status).toBe('resolved')
  s.setStatus('t-ms9j4trq-1', 'open')
  await s.save()
  expect((await readFile()).threads[0].status).toBe('open')
  expect(() => s.setStatus('nope', 'open')).toThrow(/not found/)
})

test('a status flip survives a merge and a deleted thread swallows it quietly', async () => {
  await seed()
  const s = await Store.load(storePath)
  s.setStatus('t-ms9j4trq-1', 'resolved')
  await externalWrite((d) => {
    d.threads[0].comments.push({
      id: 'c-agent-2',
      author: 'Claude',
      role: 'assistant',
      body: 'late reply',
      createdAt: '2026-08-01T11:00:00.000Z',
    })
  })
  let report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  const t = (await readFile()).threads[0]
  expect(t.status).toBe('resolved')
  expect(t.comments.map((c: { id: string }) => c.id)).toContain('c-agent-2')

  s.setStatus('t-ms9j4trq-1', 'open')
  await externalWrite((d) => {
    d.threads = d.threads.filter((x: { id: string }) => x.id !== 't-ms9j4trq-1')
  })
  report = await s.save()
  expect(report).toEqual({ merged: true, dropped: 0, overwritten: 0 })
  expect((await readFile()).threads.some((x: { id: string }) => x.id === 't-ms9j4trq-1')).toBe(false)
})
