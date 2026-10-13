/**
 * A minimal Chrome DevTools Protocol client: one WebSocket to the BROWSER
 * endpoint, with every page reached through a flat session (`sessionId` on the
 * message) rather than a socket of its own. That is what lets the browser-level
 * `Target.setAutoAttach` hand us every tab the reviewer opens — including the
 * ones a `target=_blank` link opens — paused before its first script, so the
 * overlay is registered before the page can run a line.
 *
 * Deliberately not puppeteer/playwright: we use a dozen methods, and a
 * 10 MB dependency that downloads its own browser is the opposite of "opens the
 * Chrome you already have".
 */

type Listener = (params: any, sessionId: string | undefined) => void

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
}

export class CDP {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<Listener>>()
  private closedHandlers: Array<() => void> = []
  closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)))
    ws.addEventListener('close', () => this.onClose())
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`CDP: timed out connecting to ${url}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CDP(ws))
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`CDP: could not connect to ${url}`))
      })
    })
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP: ${method} on a closed connection`))
    const id = ++this.seq
    const msg: Record<string, unknown> = { id, method, params }
    if (sessionId) msg['sessionId'] = sessionId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(msg))
    })
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  onClosed(fn: () => void): void {
    if (this.closed) fn()
    else this.closedHandlers.push(fn)
  }

  close(): void {
    this.ws.close()
  }

  private onMessage(text: string): void {
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    const set = this.listeners.get(msg.method)
    if (!set) return
    for (const fn of set) {
      try {
        fn(msg.params, msg.sessionId)
      } catch {
        // A listener's bug must not take the connection down with it.
      }
    }
  }

  private onClose(): void {
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error(`CDP ${p.method}: connection closed`))
    this.pending.clear()
    for (const fn of this.closedHandlers) fn()
    this.closedHandlers = []
  }
}
