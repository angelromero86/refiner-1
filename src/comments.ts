/**
 * Persists code-review threads to `.refiner/comments.json` at the repo root.
 *
 * This file is a CONTRACT shared with the Refiner VSCode extension and with
 * Claude Code — all three read and write it. Two consequences drive the design
 * here:
 *
 *   1. The on-disk shape (`version` + `threads[]`, `range: {start, end}`,
 *      `comments[]`, optional `anchor`) is not ours to change unilaterally.
 *   2. Fields we don't understand must survive a round-trip. The extension
 *      maintains `anchor` for drift tracking; if refiner dropped it on every
 *      save, opening the TUI would silently degrade the editor's ability to
 *      keep threads attached to their code. So we mutate the parsed objects in
 *      place and never rebuild them field by field.
 *
 * Line numbers are 1-based and inclusive, matching the editor gutter.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
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

export class Store {
  data: StoreData = { version: 1, threads: [] }
  private path = ''
  /** file → indices into data.threads; rebuilt on every mutation. */
  private byFile = new Map<string, number[]>()
  private seq = 0

  get threads(): StoredThread[] {
    return this.data.threads
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

  /**
   * load reads the store from the current repo. A missing file yields an empty
   * store ready to be populated; malformed JSON throws so the user finds out
   * rather than silently losing threads on the next save.
   */
  static async load(storePath?: string): Promise<Store> {
    const s = new Store()
    s.path = storePath ?? join(await repoRoot(), '.refiner', 'comments.json')

    const file = Bun.file(s.path)
    if (!(await file.exists())) return s

    const text = await file.text()
    if (text.trim() === '') return s

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`decode ${s.path}: ${(err as Error).message}`)
    }
    const obj = parsed as Partial<StoreData>
    s.data = {
      version: typeof obj.version === 'number' ? obj.version : 1,
      threads: Array.isArray(obj.threads) ? obj.threads : [],
    }
    // Normalize just enough to render safely; anything else stays untouched.
    for (const t of s.data.threads) {
      if (!t.range || typeof t.range.start !== 'number') {
        t.range = { start: 1, end: 1 }
      }
      if (typeof t.range.end !== 'number') t.range.end = t.range.start
      if (!Array.isArray(t.comments)) t.comments = []
      if (t.status !== 'open' && t.status !== 'resolved') t.status = StatusOpen
    }
    // Keep generated ids from colliding with ids already in the file.
    s.seq = s.data.threads.length + s.data.threads.reduce((n, t) => n + t.comments.length, 0)
    s.rebuildIndex()
    return s
  }

  /**
   * save writes the store back. Formatting matches the VSCode extension's
   * (2-space indent, trailing newline) so the two tools don't fight over
   * whitespace in git.
   */
  async save(): Promise<void> {
    if (this.path === '') this.path = join(await repoRoot(), '.refiner', 'comments.json')
    await mkdir(join(this.path, '..'), { recursive: true })
    await Bun.write(this.path, JSON.stringify(this.data, null, 2) + '\n')
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
    this.rebuildIndex()
    return t
  }

  /** appendComment appends a comment to the thread with the given id. */
  appendComment(threadId: string, c: NewComment): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    t.comments.push(this.makeComment(c))
  }

  /** deleteThread removes a thread by id. */
  deleteThread(threadId: string): void {
    this.data.threads = this.data.threads.filter((t) => t.id !== threadId)
    this.rebuildIndex()
  }

  /** deleteComment removes the i-th comment of a thread. */
  deleteComment(threadId: string, idx: number): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    if (idx < 0 || idx >= t.comments.length) throw new Error(`comment ${idx} out of range`)
    t.comments.splice(idx, 1)
  }

  /** setCommentBody edits the body of the i-th comment of a thread. */
  setCommentBody(threadId: string, idx: number, body: string): void {
    const t = this.data.threads.find((x) => x.id === threadId)
    if (!t) throw new Error(`thread ${threadId} not found`)
    if (idx < 0 || idx >= t.comments.length) throw new Error(`comment ${idx} out of range`)
    t.comments[idx].body = body
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
