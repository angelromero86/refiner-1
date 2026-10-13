/**
 * `refiner web <url>`: a Chrome the reviewer drives, with review threads on top.
 *
 * No extension. We launch Chrome with a debugging port and a profile of its own
 * (`src/web/chrome.ts`), and over CDP:
 *
 *   - every page target is auto-attached PAUSED (`waitForDebuggerOnStart`), so
 *     the overlay is registered before the page runs its first script, in every
 *     tab the reviewer opens;
 *   - `src/web/overlay.js` is injected with `addScriptToEvaluateOnNewDocument`
 *     into an isolated world — it survives every navigation, full loads and SPA
 *     route changes alike, the page cannot see it, and the page's CSP does not
 *     apply to it;
 *   - the overlay talks back through `Runtime.addBinding` scoped to that world,
 *     and we answer by evaluating `__refinerRecv(...)` in the context the call
 *     came from.
 *
 * The threads live in `.refiner/web-comments.json`, written by the same
 * `Store` as `comments.json` — same merge-on-save, same atomic rename, same
 * read-only poisoning — and in the same shape, so `/refine-resolve` reads both
 * with one set of rules. They are a SEPARATE file because `comments.json` is a
 * contract with the VSCode extension in which every thread is `file` + line
 * `range`; a thread anchored to a DOM element is neither, and handing the
 * extension one would be inventing a line for it. Here `file` is the page key
 * (`src/web/page.ts`), `range` is a placeholder the Store requires, and the
 * real target is the `web` object (`WebTarget`).
 *
 * The overlay is a view and never the source of truth: it sends intents, we
 * mutate the store, save, and broadcast the state back to every open tab. One
 * queue (`this.chain`) serializes mutations and reloads, for the same reason
 * staging is queued in the TUI — two of them interleaving lose one.
 */

import { watch, type FSWatcher } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import overlaySource from './overlay.js' with { type: 'text' }
import { CDP } from './cdp.ts'
import { launchChrome, profileDir, runningEndpoint, type Browser } from './chrome.ts'
import { pageKey } from './page.ts'
import { locateSource, SOURCE_PROBE, type ProbeResult, type WebSource } from './source.ts'
import { Store, type StoredThread, type ThreadStatus } from '../comments.ts'

export const WEB_STORE_REL = '.refiner/web-comments.json'
export const SHOTS_REL = '.refiner/shots'

/** What the overlay records about an element; resolved again on every load. */
export interface Fingerprint {
  tag: string
  id: string
  testid: string
  role: string
  name: string
  text: string
  classes: string[]
  css: string
  path: string
  /** Document coordinates at capture time. */
  rect: { x: number; y: number; w: number; h: number }
  /** Where inside the element the reviewer clicked, as fractions. The pin goes there. */
  at: { fx: number; fy: number }
}

/** The `web` field of a thread in `web-comments.json`. */
export interface WebTarget {
  url: string
  page: string
  title: string
  viewport: { w: number; h: number }
  anchor: Fingerprint
  source?: WebSource
  /** Repo-relative PNG of the element as the reviewer saw it. */
  shot?: string
}

export type WebThread = StoredThread & { web: WebTarget }

export function isWebThread(t: StoredThread): t is WebThread {
  const w = (t as { web?: unknown }).web
  return typeof w === 'object' && w !== null && typeof (w as WebTarget).page === 'string'
}

/** The overlay as an injectable script. `core` is the resolver alone. */
export function overlayScript(mode: 'ui' | 'core'): string {
  return `${overlaySource}(${JSON.stringify(mode)});`
}

type Msg =
  | { type: 'hello'; href: string }
  | {
      type: 'create'
      req: number
      href: string
      title: string
      viewport: { w: number; h: number }
      anchor: Fingerprint
      pick: string
      body: string
    }
  | { type: 'reply'; req: number; threadId: string; body: string }
  | { type: 'status'; req: number; threadId: string; status: ThreadStatus }
  | { type: 'delete'; req: number; threadId: string }
  | { type: 'goto'; req: number; threadId: string }

interface Tab {
  sessionId: string
  /** The overlay's execution context, learned from its first binding call. */
  ctx: number | null
  href: string
  /** A thread to open once the overlay on the next page says hello. */
  focus: string | null
}

export interface SessionOptions {
  root: string
  url: string
  author: string
  headless?: boolean
  /** Defaults to the per-repo profile under ~/.config/refiner/chrome. */
  profile?: string
  log?: (line: string) => void
}

export class WebSession {
  store!: Store
  cdp!: CDP
  private browser!: Browser
  readonly tabs = new Map<string, Tab>()
  private chain: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private firstTab!: Promise<string>
  private closing = false
  /** Resolves when the browser goes away — the window closed, or `close()`. */
  done!: Promise<void>

  private constructor(private opts: SessionOptions) {}

  get storePath(): string {
    return join(this.opts.root, WEB_STORE_REL)
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  static async start(opts: SessionOptions): Promise<WebSession> {
    const s = new WebSession(opts)
    await s.boot()
    return s
  }

  private async boot(): Promise<void> {
    await mkdir(join(this.opts.root, '.refiner'), { recursive: true })
    this.store = await Store.loadOrReadOnly(this.storePath)
    if (this.store.readOnly) this.log(`! ${this.store.writeBlocked()!.message}`)

    const profile = this.opts.profile ?? profileDir(this.opts.root)
    if (await runningEndpoint(profile)) {
      throw new Error(
        `a refiner web session is already running for this repo (profile ${profile}); close that Chrome window first`,
      )
    }
    this.browser = await launchChrome(profile, { headless: this.opts.headless })
    this.cdp = await CDP.connect(this.browser.wsUrl)
    this.done = new Promise((resolve) => {
      this.cdp.onClosed(() => resolve())
      this.browser.proc?.exited.then(() => resolve())
    })
    void this.done.then(() => this.shutdown())

    let firstResolve!: (s: string) => void
    this.firstTab = new Promise((r) => (firstResolve = r))
    this.cdp.on('Target.attachedToTarget', (p) => {
      void this.attach(p).then((ok) => {
        if (ok) firstResolve(p.sessionId)
      })
    })
    this.cdp.on('Target.detachedFromTarget', (p) => this.tabs.delete(p.sessionId))
    this.cdp.on('Runtime.bindingCalled', (p, sessionId) => {
      if (p.name !== '__refiner' || !sessionId) return
      this.onBinding(sessionId, p.executionContextId, p.payload)
    })
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })

    const sid = await this.firstTab
    await this.cdp.send('Page.navigate', { url: this.opts.url }, sid)
    // Chrome's own windows are not where the reviewer works.
    await this.cdp.send('Page.bringToFront', {}, sid).catch(() => {})

    this.watchStore()
  }

  /** Set a freshly attached target up, then let it run. True for a page. */
  private async attach(p: any): Promise<boolean> {
    const sid: string = p.sessionId
    const resume = () => this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {})
    if (p.targetInfo.type !== 'page') {
      await resume()
      return false
    }
    this.tabs.set(sid, { sessionId: sid, ctx: null, href: p.targetInfo.url, focus: null })
    try {
      await this.cdp.send('Page.enable', {}, sid)
      await this.cdp.send('Runtime.enable', {}, sid)
      await this.cdp.send('Runtime.addBinding', { name: '__refiner', executionContextName: 'refiner' }, sid)
      await this.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: overlayScript('ui'), worldName: 'refiner', runImmediately: true },
        sid,
      )
    } catch (err) {
      this.log(`! could not instrument a tab: ${(err as Error).message}`)
    }
    await resume()
    return true
  }

  /** Run `fn` after everything queued before it. A failure never jams the queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private onBinding(sessionId: string, ctx: number, payload: string): void {
    const tab = this.tabs.get(sessionId)
    if (!tab) return
    tab.ctx = ctx
    let msg: Msg
    try {
      msg = JSON.parse(payload)
    } catch {
      return
    }
    if (msg.type === 'hello') {
      tab.href = msg.href
      const page = pageKey(msg.href)
      let focus: string | null = null
      if (tab.focus) {
        const t = this.store.threads.find((x) => x.id === tab.focus)
        if (t && isWebThread(t) && t.web.page === page) focus = t.id
        tab.focus = null
      }
      void this.push(tab, this.stateFor(tab, focus))
      return
    }
    void this.enqueue(() => this.mutate(tab, msg)).catch(() => {})
  }

  private async mutate(tab: Tab, msg: Exclude<Msg, { type: 'hello' }>): Promise<void> {
    const kind = msg.type
    const blocked = kind === 'goto' ? null : this.store.writeBlocked()
    if (blocked) {
      await this.push(tab, { type: 'ack', kind, req: msg.req, ok: false, error: blocked.message })
      return
    }
    try {
      let id: string | undefined
      switch (msg.type) {
        case 'create':
          id = await this.create(tab, msg)
          break
        case 'reply':
          this.store.appendComment(msg.threadId, { author: this.opts.author, body: msg.body, role: 'user' })
          this.log(`↩ reply on ${msg.threadId}`)
          break
        case 'status':
          this.store.setStatus(msg.threadId, msg.status)
          this.log(`${msg.status === 'resolved' ? '✓ resolved' : '↺ reopened'} ${msg.threadId}`)
          break
        case 'delete':
          this.store.deleteThread(msg.threadId)
          this.log(`✕ deleted ${msg.threadId}`)
          break
        case 'goto': {
          const t = this.store.threads.find((x) => x.id === msg.threadId)
          if (!t || !isWebThread(t)) throw new Error(`thread ${msg.threadId} not found`)
          tab.focus = t.id
          await this.cdp.send('Page.navigate', { url: t.web.url }, tab.sessionId)
          return
        }
      }
      const report = await this.store.save()
      if (report.dropped || report.overwritten) {
        const parts = []
        if (report.dropped) parts.push(`${report.dropped} edit(s) had nowhere to land`)
        if (report.overwritten) parts.push(`${report.overwritten} comment(s) edited on both sides`)
        this.log(`! merged with another writer: ${parts.join(', ')}`)
      }
      // State before the ack: the overlay opens the new thread's card on the
      // ack, and a card for a thread it has not been told about yet is nothing.
      await this.broadcast()
      await this.push(tab, { type: 'ack', kind, req: msg.req, ok: true, id })
    } catch (err) {
      await this.push(tab, { type: 'ack', kind, req: msg.req, ok: false, error: (err as Error).message })
    }
  }

  private async create(tab: Tab, msg: Extract<Msg, { type: 'create' }>): Promise<string> {
    const sid = tab.sessionId
    const pick = msg.pick.replace(/[^a-z0-9]/gi, '')
    const page = pageKey(msg.href)

    // Main world: the frameworks' debug hooks are only visible from there.
    let probe: ProbeResult | null = null
    try {
      const r = await this.cdp.send(
        'Runtime.evaluate',
        { expression: SOURCE_PROBE.replace('__PICK__', pick), returnByValue: true },
        sid,
      )
      probe = r.result?.value ?? null
    } catch {
      // A page mid-navigation has no main world to ask; the thread goes without.
    }
    const source = await locateSource(this.opts.root, probe, msg.anchor.text)
    const shot = await this.capture(tab, msg.anchor.rect, pick)

    const web: WebTarget = {
      url: msg.href,
      page,
      title: msg.title,
      viewport: msg.viewport,
      anchor: msg.anchor,
    }
    if (source) web.source = source
    if (shot) web.shot = shot
    const t = this.store.addThread(page, 1, 1, { author: this.opts.author, body: msg.body, role: 'user' }, undefined, {
      web,
    })
    const where = source?.template ?? (source?.file ? `${source.file}${source.line ? ':' + source.line : ''}` : '')
    this.log(`＋ ${t.id} on ${page}  <${msg.anchor.tag}>${source?.component ? `  ${source.component}` : ''}${where ? `  ${where}` : ''}`)
    return t.id
  }

  /**
   * A PNG of the element with some page around it, as the reviewer saw it —
   * which is what lets an agent that cannot see the browser understand
   * "this is misaligned". Our own UI is hidden for the shot, except a dashed
   * outline around the element.
   */
  private async capture(tab: Tab, rect: Fingerprint['rect'], pick: string): Promise<string | undefined> {
    const PAD = 48
    try {
      await this.push(tab, { type: 'shoot', on: true })
      await Bun.sleep(80)
      const x = Math.max(0, rect.x - PAD)
      const y = Math.max(0, rect.y - PAD)
      const r = await this.cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x, y, width: Math.max(1, rect.w + PAD * 2), height: Math.max(1, Math.min(rect.h + PAD * 2, 2400)), scale: 1 },
        },
        tab.sessionId,
      )
      const dir = join(this.opts.root, SHOTS_REL)
      await mkdir(dir, { recursive: true })
      // Pictures of somebody's local app are not source; keep them out of git.
      const ignore = Bun.file(join(dir, '.gitignore'))
      if (!(await ignore.exists())) await Bun.write(ignore, '*\n')
      const name = `${Date.now().toString(36)}-${pick}.png`
      const tmp = join(dir, `${name}.tmp`)
      await Bun.write(tmp, Buffer.from(r.data, 'base64'))
      await rename(tmp, join(dir, name))
      return `${SHOTS_REL}/${name}`
    } catch (err) {
      this.log(`! screenshot failed: ${(err as Error).message}`)
      return undefined
    } finally {
      await this.push(tab, { type: 'shoot', on: false })
    }
  }

  private stateFor(tab: Tab, focus: string | null = null): object {
    return {
      type: 'state',
      author: this.opts.author,
      page: pageKey(tab.href),
      threads: this.store.threads.filter(isWebThread),
      readOnly: this.store.readOnly,
      focus,
    }
  }

  private async push(tab: Tab, msg: object): Promise<void> {
    if (tab.ctx === null) return
    try {
      await this.cdp.send(
        'Runtime.evaluate',
        { expression: `globalThis.__refinerRecv && __refinerRecv(${JSON.stringify(msg)})`, contextId: tab.ctx },
        tab.sessionId,
      )
    } catch {
      // The context died with a navigation; the next page's hello resyncs it.
    }
  }

  private async broadcast(): Promise<void> {
    await Promise.all(Array.from(this.tabs.values()).map((t) => this.push(t, this.stateFor(t))))
  }

  /**
   * Pick up writes from agents (`/refine-resolve`) and from a second session.
   * Same witness as the TUI's watcher: an exact match with `lastSyncedText` is
   * our own echo. The reload runs in the mutation queue, so it can never swap
   * the store out from under a save.
   */
  private watchStore(): void {
    const dir = join(this.opts.root, '.refiner')
    try {
      this.watcher = watch(dir, (_ev, name) => {
        if (name !== 'web-comments.json') return
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => void this.enqueue(() => this.reload()), 120)
      })
    } catch {
      this.log('! cannot watch .refiner/; agent replies show up on the next page load')
    }
  }

  private async reload(): Promise<void> {
    let text: string
    try {
      text = await Bun.file(this.storePath).text()
    } catch {
      return
    }
    if (text === this.store.lastSyncedText) return
    const before = new Map(this.store.threads.map((t) => [t.id, t.comments.length]))
    const next = await Store.loadOrReadOnly(this.storePath)
    if (next.readOnly) {
      // Somebody's write in progress, most likely. Keep showing what we had.
      this.store.markUnreadable(next.loadError!)
      return
    }
    this.store = next
    for (const t of next.threads) {
      const n = before.get(t.id)
      const last = t.comments[t.comments.length - 1]
      if (n === undefined) this.log(`＋ ${t.id} arrived from another writer`)
      else if (t.comments.length > n && last?.role === 'assistant') this.log(`✦ ${last.author} replied on ${t.id}`)
    }
    await this.broadcast()
  }

  /** Test hook: evaluate in the overlay's world of the first tab that has one. */
  async evalOverlay<T = unknown>(expression: string): Promise<T> {
    for (const tab of this.tabs.values()) {
      if (tab.ctx === null) continue
      const r = await this.cdp.send(
        'Runtime.evaluate',
        { expression, contextId: tab.ctx, returnByValue: true, awaitPromise: true },
        tab.sessionId,
      )
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
      return r.result.value as T
    }
    throw new Error('no overlay context yet')
  }

  /** Test hook: navigate the first tab. */
  async navigate(url: string): Promise<void> {
    const sid = await this.firstTab
    const tab = this.tabs.get(sid)
    if (tab) tab.ctx = null
    await this.cdp.send('Page.navigate', { url }, sid)
  }

  private shutdown(): void {
    if (this.closing) return
    this.closing = true
    this.watcher?.close()
    if (this.watchTimer) clearTimeout(this.watchTimer)
  }

  async close(): Promise<void> {
    this.shutdown()
    await this.chain.catch(() => {})
    await this.store.flush()
    try {
      await this.cdp.send('Browser.close')
    } catch {
      this.browser.proc?.kill()
    }
    await this.done
  }
}
