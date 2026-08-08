/**
 * Persists code-review threads to `.refiner/comments.json` at the repo root.
 *
 * This file is a CONTRACT shared with the Refiner VSCode extension and with
 * Claude Code — all three read and write it, often at the same time. Four
 * consequences drive the design here:
 *
 *   1. The on-disk shape (`version` + `threads[]`, `range: {start, end}`,
 *      `comments[]`, optional `anchor`) is not ours to change unilaterally.
 *   2. Fields we don't understand must survive a round-trip. The extension
 *      maintains `anchor` for drift tracking; if refiner dropped it on every
 *      save, opening the TUI would silently degrade the editor's ability to
 *      keep threads attached to their code. So we mutate the parsed objects in
 *      place and never rebuild them field by field — the root object included,
 *      or a key the extension invents tomorrow dies at the first save.
 *   3. A store that never managed to READ its file never writes it. Writing on
 *      top of bytes we could not parse would destroy somebody else's threads — a
 *      half-written file from the extension, an agent killed mid-write, a merge
 *      conflict marker. The rule lives here, in the class that owns the
 *      contract, and not in the callers: `load()` throwing only protects the
 *      user if every caller leaves the store unusable, and one that handed back
 *      an empty-but-writable store was exactly how the data went missing.
 *   4. **We are never the only writer.** The dangerous window is not the write,
 *      it is the whole `load()` → `save()` interval, which lasts as long as the
 *      TUI session: an agent replying to a thread while the reviewer composes a
 *      comment used to be erased by that comment. So a save is not a whole-file
 *      replace from memory any more. Every mutation is also recorded as an
 *      operation keyed by *id* (`pending`), and `save()` re-reads the file: if
 *      the bytes moved since we last synced, those operations are re-applied on
 *      top of the DISK copy instead of overwriting it. Ids, never indices —
 *      indices do not survive somebody else's insert.
 *
 * Two smaller rules fall out of that:
 *
 *   - Saves are serialized through `writeChain`. `src/threads-ui.ts` fires them
 *     with `void`, and two of those re-reading the same file would merge onto
 *     the same base and clobber each other; merging between processes is
 *     pointless without serialization inside one.
 *   - The write itself is a temp file plus `rename()`. `Bun.write()` truncates
 *     in place, so a concurrent reader can see a half-written file — which is to
 *     say we would be manufacturing case 3 for the process next door.
 *
 * Line numbers are 1-based and inclusive, matching the editor gutter.
 */

import { join } from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import { repoRoot } from './git.ts'

export type CommentRole = 'user' | 'assistant'
export type ThreadStatus = 'open' | 'resolved'

export const StatusOpen: ThreadStatus = 'open'
export const StatusResolved: ThreadStatus = 'resolved'

export interface StoredComment {
  id: string
  /** Display name of whoever wrote the comment. */
  author: string
  /** "user" = a human; "assistant" = an AI agent. Drives styling. */
  role: CommentRole
  /** Markdown body. */
  body: string
  /** ISO-8601 timestamp. */
  createdAt: string
}

/**
 * A content snapshot the extension uses to keep a thread attached as lines
 * shift. refiner never authors it, but always preserves it.
 */
export interface Anchor {
  lines: string[]
  before: string[]
  after: string[]
}

export interface StoredThread {
  id: string
  /** Repo-relative path, forward slashes. */
  file: string
  /** 1-based inclusive line range. */
  range: { start: number; end: number }
  status: ThreadStatus
  comments: StoredComment[]
  anchor?: Anchor
}

export interface StoreData {
  version: number
  threads: StoredThread[]
}

/**
 * What a completed `save()` did, so the UI can re-anchor itself and say what
 * happened. `merged` is the interesting one: it means `store.threads` is a
 * different array now, built from the file rather than from memory.
 */
export interface SaveReport {
  /** The file had moved under us and our edits were replayed onto it. */
  merged: boolean
  /** Local edits with nowhere to land: the other client deleted the target. */
  dropped: number
  /** Comment bodies whose disk version we replaced (both sides edited one). */
  overwritten: number
}

/**
 * One local mutation, replayable onto any base. Everything is addressed by id:
 * the public API takes comment *indices*, but an index means nothing once
 * somebody else has inserted into the same array.
 */
type Op =
  | { kind: 'addThread'; thread: StoredThread }
  | { kind: 'appendComment'; threadId: string; comment: StoredComment }
  | { kind: 'deleteThread'; threadId: string }
  | { kind: 'deleteComment'; threadId: string; commentId: string }
  | { kind: 'setBody'; threadId: string; commentId: string; body: string; prevBody: string }

/**
 * normalize makes parsed JSON safe to render from by MUTATING it, never by
 * rebuilding it. That is what carries unknown fields across a round-trip, and
 * since this same object is the base a concurrent save merges onto, rebuilding
 * it would delete the other client's root-level keys just as surely as the
 * whole-file overwrite this replaces.
 */
function normalize(parsed: unknown): StoreData {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { version: 1, threads: [] }
  }
  const data = parsed as StoreData
  if (typeof data.version !== 'number') data.version = 1
  if (!Array.isArray(data.threads)) data.threads = []
  // Normalize just enough to render safely; anything else stays untouched.
  for (const t of data.threads) {
    if (!t.range || typeof t.range.start !== 'number') {
      t.range = { start: 1, end: 1 }
    }
    if (typeof t.range.end !== 'number') t.range.end = t.range.start
    if (!Array.isArray(t.comments)) t.comments = []
    if (t.status !== 'open' && t.status !== 'resolved') t.status = StatusOpen
  }
  return data
}

export class Store {
  data: StoreData = { version: 1, threads: [] }
  private path = ''
  /** file → indices into data.threads; rebuilt on every mutation. */
  private byFile = new Map<string, number[]>()
  private seq = 0
  /**
   * Why we don't trust what is on disk, or null while we do.
   *
   * Purely in-memory: it is never serialized, has no place in `StoreData` and
   * cannot reach the file. Set once the bytes at `path` failed to read or parse,
   * and never cleared — a store that has been poisoned stays poisoned, and
   * recovery means loading a fresh one (`App.refresh()` does exactly that once
   * somebody repairs the file).
   */
  private unreadable: Error | null = null
  /**
   * Local mutations not yet known to be on disk, oldest first. Cleared by a
   * successful write; kept across a refused one, so the next attempt still
   * carries them.
   */
  private pending: Op[] = []
  /** Serializes `save()`. Never rejects — a failed save must not poison it. */
  private writeChain: Promise<void> = Promise.resolve()
  /** Saves started but not finished. Part of `hasPendingWrites()`. */
  private inFlight = 0
  /** Makes each temp file name unique within the process. */
  private tmpSeq = 0

  /**
   * The exact text we know the file holds — set by `load()` AND by `save()`.
   *
   * Two readers. `save()` compares it against the file to decide whether
   * anybody else wrote in the meantime, and the file watcher (`src/watch.ts`)
   * compares against it to tell an edit by the extension or an agent apart from
   * the echo of our own write. Content, not timestamps: two writes can land in
   * the same clock tick. `null` means we have never seen this file's bytes —
   * a brand-new store, or one whose file did not exist — and every reader must
   * treat that as "assume nothing".
   */
  lastSyncedText: string | null = null
  /**
   * Bumped on every completed write. The watcher pairs it with `lastSyncedText`
   * so a write that finished *while it was reading* can't be mistaken for the
   * echo it was comparing against.
   */
  writeSeq = 0

  get threads(): StoredThread[] {
    return this.data.threads
  }

  /** The read failure that made this store read-only, or null. */
  get loadError(): Error | null {
    return this.unreadable
  }

  /** True when `save()` will refuse. See `writeBlocked()` for the reason. */
  get readOnly(): boolean {
    return this.unreadable !== null
  }

  private rebuildIndex(): void {
    this.byFile = new Map()
    this.data.threads.forEach((t, i) => {
      const list = this.byFile.get(t.file)
      if (list) list.push(i)
      else this.byFile.set(t.file, [i])
    })
  }

  /**
   * Generate a short, unique id. Matches the VSCode extension's scheme
   * (`<prefix>-<base36 millis>-<seq>`) so ids from either tool read alike.
   */
  private newId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${Date.now().toString(36)}-${this.seq.toString(36)}`
  }

  /** Keep generated ids clear of everything already in `data`. */
  private bumpSeq(): void {
    const n =
      this.data.threads.length +
      this.data.threads.reduce((acc, t) => acc + t.comments.length, 0)
    if (n > this.seq) this.seq = n
  }

  /** Parse `text` into a renderable `StoreData`, or throw the `decode` error. */
  private decode(text: string): StoreData {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`decode ${this.path}: ${(err as Error).message}`)
    }
    return normalize(parsed)
  }

  /** Adopt freshly-read data as our synced state. */
  private adopt(data: StoreData, text: string | null): void {
    this.data = data
    this.lastSyncedText = text
    this.bumpSeq()
    this.rebuildIndex()
  }

  /**
   * load reads the store from the current repo. A missing file yields an empty
   * store ready to be populated; malformed JSON throws so the user finds out
   * rather than silently losing threads on the next save.
   *
   * A missing or empty file deliberately leaves `lastSyncedText` at null: we
   * have seen no bytes, so the next `save()` must merge onto whatever it finds
   * rather than assume the file is still absent.
   */
  static async load(storePath?: string): Promise<Store> {
    const s = new Store()
    s.path = storePath ?? join(await repoRoot(), '.refiner', 'comments.json')

    const file = Bun.file(s.path)
    if (!(await file.exists())) return s

    const text = await file.text()
    if (text.trim() === '') return s

    s.adopt(s.decode(text), text)
    return s
  }

  /**
   * loadOrReadOnly is `load()` for callers that must keep going when the file is
   * broken — the TUI, which has staging to do whether or not the threads parse.
   *
   * On failure it hands back an empty store that KNOWS it never read the file,
   * so the reviewer sees the problem instead of a plausible-looking empty list
   * that overwrites everything on the first comment. Only a genuine read failure
   * marks it: a missing file and an empty one are ordinary new-repo states and
   * come back writable, exactly as `load()` returns them.
   */
  static async loadOrReadOnly(storePath?: string): Promise<Store> {
    // Resolved outside the try so the fallback store knows its own path even if
    // it was `repoRoot()` itself that failed.
    let path = storePath ?? ''
    try {
      if (path === '') path = join(await repoRoot(), '.refiner', 'comments.json')
      return await Store.load(path)
    } catch (err) {
      const s = new Store()
      s.path = path
      s.markUnreadable(err as Error)
      return s
    }
  }

  /**
   * markUnreadable poisons a store whose file stopped being readable AFTER it
   * was loaded — the reviewer's threads are still in memory and still worth
   * reading, but the bytes on disk are now unknown, so writing them back would
   * be the same whole-file overwrite over somebody else's data.
   *
   * One-way on purpose. Recovery is a fresh `load()`, not an un-poison.
   */
  markUnreadable(err: Error): void {
    this.unreadable = err
  }

  /**
   * The error `save()` would reject with, or null when the store is writable.
   *
   * Exposed so a caller can refuse a mutation BEFORE making it — the UI declines
   * to open the compose box rather than accepting a comment it cannot persist —
   * with exactly the wording the write path would have produced.
   */
  writeBlocked(): Error | null {
    if (this.unreadable === null) return null
    const where = this.path === '' ? '.refiner/comments.json' : this.path
    // Actionable part first: the banner is clipped to the pane, and the cause
    // (which repeats the path) is the least useful thing to keep.
    return new Error(
      `refusing to overwrite ${where}: it could not be read; repair or move the file, then press r (${this.unreadable.message})`,
    )
  }

  /**
   * True while some local edit is not yet known to be on disk — including edits
   * stranded by a refused save, which is why the watcher does NOT use this one:
   * a poisoned store never clears `pending`, and gating the reload on it would
   * disable the refresh that is the only cure.
   */
  hasPendingWrites(): boolean {
    return this.pending.length > 0 || this.inFlight > 0
  }

  /**
   * True while a save is actually running. What the watcher gates on: a
   * `refresh()` landing mid-save would swap this store out from under it.
   */
  isWriting(): boolean {
    return this.inFlight > 0
  }

  /** Position of a thread in `threads`, or -1. The stable way to hold onto one. */
  indexOfThread(id: string): number {
    return this.data.threads.findIndex((t) => t.id === id)
  }

  /**
   * flush waits for every queued save to settle. Never rejects: the caller
   * (`App.refresh()`) only wants to know that nothing is still in flight before
   * it swaps this store out for a fresh one.
   */
  async flush(): Promise<void> {
    let chain = this.writeChain
    for (;;) {
      await chain
      if (this.writeChain === chain) return
      chain = this.writeChain
    }
  }

  /**
   * save writes the store back, re-reading and merging first when somebody else
   * has touched the file since we last synced. Formatting matches the VSCode
   * extension's (2-space indent, trailing newline) so the two tools don't fight
   * over whitespace in git.
   *
   * Serialized: concurrent calls queue behind each other, because two saves that
   * re-read the same base would each merge onto it and the second would drop the
   * first's work. A rejection does not break the queue for the next caller.
   */
  save(): Promise<SaveReport> {
    this.inFlight += 1
    const run = this.writeChain.then(
      () => this.writeOnce(),
      () => this.writeOnce(),
    )
    this.writeChain = run.then(
      () => {
        this.inFlight -= 1
      },
      () => {
        this.inFlight -= 1
      },
    )
    return run
  }

  /**
   * One re-read → merge → write cycle. Runs alone, inside `writeChain`.
   *
   * The refusal is first — before the path is resolved, before `mkdir` and above
   * all before `lastSyncedText` is touched: leaving that field describing a
   * write that never happened would make the watcher (`src/watch.ts`) mistake
   * the real file for our own echo and skip the reload that would have repaired
   * the situation.
   */
  private async writeOnce(): Promise<SaveReport> {
    const blocked = this.writeBlocked()
    if (blocked) throw blocked
    if (this.path === '') this.path = join(await repoRoot(), '.refiner', 'comments.json')
    await mkdir(join(this.path, '..'), { recursive: true })

    const report: SaveReport = { merged: false, dropped: 0, overwritten: 0 }
    const disk = await this.readForMerge()

    if (disk !== null && disk !== this.lastSyncedText) {
      // Somebody else wrote between our last sync and now. Their copy is the
      // base; our own edits go on top of it, by id.
      let base: StoreData
      try {
        base = this.decode(disk)
      } catch (err) {
        // Same refusal as a store that never read its file, and for the same
        // reason: these bytes are somebody's half-finished write or a conflict
        // marker, and flattening them is the data loss we are here to prevent.
        // Poisoned, so the refusal survives until a fresh load() proves the file
        // readable again. `pending` is kept — nothing local is thrown away.
        this.markUnreadable(err as Error)
        throw this.writeBlocked()!
      }
      this.replay(base, report)
      report.merged = true
      this.adopt(base, null)
    }

    const text = JSON.stringify(this.data, null, 2) + '\n'
    await this.writeAtomic(text)
    // Only after the bytes are really there. Claiming a write that failed would
    // hand the watcher a witness for a file that never existed.
    this.lastSyncedText = text
    this.pending = []
    this.writeSeq += 1
    return report
  }

  /**
   * The file as it is right now, or null when it is absent or blank (an ordinary
   * new repo — there is nothing to merge with). An unreadable-for-other-reasons
   * file poisons the store rather than being overwritten.
   */
  private async readForMerge(): Promise<string | null> {
    try {
      const file = Bun.file(this.path)
      if (!(await file.exists())) return null
      const text = await file.text()
      return text.trim() === '' ? null : text
    } catch (err) {
      // Deleted between the two calls is still just "not there": an absent file
      // is an ordinary new-repo state, not a reason to stop writing.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      this.markUnreadable(err as Error)
      throw this.writeBlocked()!
    }
  }

  /**
   * replay applies the pending log onto `base`, in order.
   *
   * Every case is idempotent and tolerant of a missing target: the point of the
   * log is that it can land on a file we have never seen. Nothing throws — an
   * operation with nowhere to go is counted in the report so the UI can say so,
   * because silently dropping the reviewer's reply would be this very bug in
   * miniature.
   */
  private replay(base: StoreData, report: SaveReport): void {
    for (const op of this.pending) {
      switch (op.kind) {
        case 'addThread': {
          // Ours is appended after whatever the file already had: additions
          // commute, and the file's order is the contract's order.
          if (!base.threads.some((t) => t.id === op.thread.id)) base.threads.push(op.thread)
          break
        }
        case 'appendComment': {
          const t = base.threads.find((x) => x.id === op.threadId)
          if (!t) {
            report.dropped += 1
            break
          }
          if (!Array.isArray(t.comments)) t.comments = []
          // By id, because the thread may have arrived through `addThread`
          // above carrying this comment already.
          if (!t.comments.some((c) => c.id === op.comment.id)) t.comments.push(op.comment)
          break
        }
        case 'deleteThread':
          // A deletion is intentional and cannot be expressed any other way;
          // gone from the base is a no-op, not a conflict.
          base.threads = base.threads.filter((t) => t.id !== op.threadId)
          break
        case 'deleteComment': {
          const t = base.threads.find((x) => x.id === op.threadId)
          if (!t) break
          t.comments = t.comments.filter((c) => c.id !== op.commentId)
          break
        }
        case 'setBody': {
          const t = base.threads.find((x) => x.id === op.threadId)
          const c = t?.comments.find((x) => x.id === op.commentId)
          if (!c) {
            report.dropped += 1
            break
          }
          // `body` is scalar: last writer wins, but never quietly.
          if (c.body !== op.prevBody && c.body !== op.body) report.overwritten += 1
          c.body = op.body
          break
        }
      }
    }
  }

  /**
   * writeAtomic replaces the file rather than truncating it.
   *
   * `Bun.write()` over an existing path truncates in place — same inode, size
   * dips through the truncated value — so a reader that happens to look mid-write
   * (the extension's watcher, an agent's read-modify-write) can see invalid JSON.
   * A temp file plus `rename()` makes the swap indivisible: readers see the old
   * bytes or the new ones.
   *
   * The temp name deliberately isn't `comments.json`, so the directory watcher in
   * `src/watch.ts` ignores it, and lives in the same directory so the rename
   * stays within one filesystem.
   */
  private async writeAtomic(text: string): Promise<void> {
    this.tmpSeq += 1
    const tmp = `${this.path}.${process.pid.toString(36)}.${this.tmpSeq.toString(36)}.tmp`
    try {
      await Bun.write(tmp, text)
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** threadsForFile returns threads on `path`, sorted by start line ascending. */
  threadsForFile(path: string): StoredThread[] {
    const idxs = this.byFile.get(path) ?? []
    return idxs
      .map((i) => this.data.threads[i])
      .sort((a, b) => a.range.start - b.range.start)
  }

  /** threadAt returns the first thread covering `line` in `path`, or null. */
  threadAt(path: string, line: number): StoredThread | null {
    for (const i of this.byFile.get(path) ?? []) {
      const t = this.data.threads[i]
      if (line >= t.range.start && line <= t.range.end) return t
    }
    return null
  }

  /** hasThreadsFor reports whether any thread anchors to `path`. O(1). */
  hasThreadsFor(path: string): boolean {
    return (this.byFile.get(path) ?? []).length > 0
  }

  /** addThread appends a thread (no save) and returns it. */
  addThread(file: string, start: number, end: number, first: NewComment): StoredThread {
    const t: StoredThread = {
      id: this.newId('t'),
      file,
      range: { start, end },
      status: StatusOpen,
      comments: [this.makeComment(first)],
    }
    this.data.threads.push(t)
    this.pending.push({ kind: 'addThread', thread: t })
    this.rebuildIndex()
    return t
  }

  /** appendComment appends a comment to the thread with the given id. */
  appendComment(threadId: string, c: NewComment): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    const comment = this.makeComment(c)
    t.comments.push(comment)
    this.pending.push({ kind: 'appendComment', threadId, comment })
  }

  /** deleteThread removes a thread by id. */
  deleteThread(threadId: string): void {
    this.data.threads = this.data.threads.filter((t) => t.id !== threadId)
    this.pending.push({ kind: 'deleteThread', threadId })
    this.rebuildIndex()
  }

  /**
   * deleteComment removes the i-th comment of a thread. The index is the
   * caller's (it is what the modal cursor holds); what gets logged is the id it
   * resolves to, since the index means nothing on another client's copy.
   */
  deleteComment(threadId: string, idx: number): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    if (idx < 0 || idx >= t.comments.length) throw new Error(`comment ${idx} out of range`)
    const [removed] = t.comments.splice(idx, 1)
    this.pending.push({ kind: 'deleteComment', threadId, commentId: removed.id })
  }

  /** setCommentBody edits the body of the i-th comment of a thread. */
  setCommentBody(threadId: string, idx: number, body: string): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    if (idx < 0 || idx >= t.comments.length) throw new Error(`comment ${idx} out of range`)
    const c = t.comments[idx]
    this.pending.push({ kind: 'setBody', threadId, commentId: c.id, body, prevBody: c.body })
    c.body = body
  }

  private makeComment(c: NewComment): StoredComment {
    return {
      id: this.newId('c'),
      author: c.author,
      role: c.role ?? 'user',
      body: c.body,
      createdAt: new Date().toISOString(),
    }
  }
}

export interface NewComment {
  author: string
  body: string
  role?: CommentRole
}
