/**
 * `refiner web …` — the browser half of refiner.
 *
 *   refiner web <url>          open Chrome on <url> with the review overlay
 *   refiner web shot <thread>  screenshot a web thread's element as it is NOW
 *   refiner web list           the web threads, as JSON lines (for agents)
 *
 * `shot` is the agent's half of the loop: after `/refine-resolve` changes the
 * code, it re-finds the element the reviewer pointed at and photographs it, so
 * the agent can check its fix with its own eyes before replying. It reuses the
 * reviewer's running Chrome when there is one (same cookies, same session) and
 * starts a headless one on the same profile otherwise.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { CDP } from './cdp.ts'
import { launchChrome, profileDir, runningEndpoint } from './chrome.ts'
import { normalizeUrl } from './page.ts'
import { isWebThread, overlayScript, SHOTS_REL, WEB_STORE_REL, WebSession, type WebThread } from './session.ts'
import { Store } from '../comments.ts'

export const WEB_USAGE = `refiner web — review threads on a running web app

usage:
  refiner web <url>            open Chrome on <url> with the review overlay
  refiner web shot <thread>    screenshot a web thread's element as it is now
  refiner web list             print the web threads as JSON lines

in the browser:
  C        comment on an element (click it; ↑ selects the parent)
  shift+C  all threads, every page
  esc      cancel / close

threads: ${WEB_STORE_REL}   screenshots: ${SHOTS_REL}/
browser: REFINER_CHROME overrides which Chrome is launched
`

export async function runWeb(root: string, args: string[], author: string): Promise<void> {
  const [cmd, ...rest] = args
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(WEB_USAGE)
    return
  }
  if (cmd === 'shot') {
    process.stdout.write(JSON.stringify(await shotThread(root, rest[0] ?? '')) + '\n')
    return
  }
  if (cmd === 'list') return list(root)
  return serve(root, normalizeUrl(cmd), author, rest.includes('--headless'))
}

async function serve(root: string, url: string, author: string, headless: boolean): Promise<void> {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const log = (line: string) => process.stdout.write(`${dim(new Date().toTimeString().slice(0, 8))} ${line}\n`)
  const session = await WebSession.start({ root, url, author, headless, log })
  const open = session.store.threads.filter(isWebThread).filter((t) => t.status === 'open').length
  process.stdout.write(
    [
      '',
      `  \x1b[1mrefiner web\x1b[0m  ${url}`,
      `  ${dim('threads')}  ${WEB_STORE_REL}  ${dim(`(${open} open)`)}`,
      `  ${dim('in the page: C comment · shift+C threads · esc cancel — close the window or ^C to stop')}`,
      '',
    ].join('\n') + '\n',
  )
  const stop = () => void session.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await session.done
  await session.store.flush()
  log('browser closed')
}

async function loadThreads(root: string): Promise<WebThread[]> {
  const store = await Store.load(join(root, WEB_STORE_REL))
  return store.threads.filter(isWebThread)
}

async function list(root: string): Promise<void> {
  for (const t of await loadThreads(root)) {
    const last = t.comments[t.comments.length - 1]
    process.stdout.write(
      JSON.stringify({
        id: t.id,
        status: t.status,
        page: t.web.page,
        url: t.web.url,
        element: `<${t.web.anchor.tag}>${t.web.anchor.text ? ` "${t.web.anchor.text.slice(0, 60)}"` : ''}`,
        source: t.web.source ?? null,
        shot: t.web.shot ?? null,
        comments: t.comments.length,
        lastRole: last?.role ?? null,
      }) + '\n',
    )
  }
}

/** Matches the TUI and the skills: a full id or a unique suffix. */
function findThread(threads: WebThread[], ref: string): WebThread {
  const exact = threads.find((t) => t.id === ref)
  if (exact) return exact
  const hits = threads.filter((t) => ref !== '' && t.id.endsWith(ref))
  if (hits.length === 1) return hits[0]!
  throw new Error(hits.length ? `"${ref}" matches ${hits.length} threads` : `no web thread "${ref}"`)
}

export interface ShotResult {
  id: string
  url: string
  /** What the anchor resolver made of the page now: exact | moved | lost. */
  status: string
  score: number
  /** The element's text now, to compare with the anchor's. */
  text: string | null
  /** Repo-relative PNG of the element now (the whole viewport when lost). */
  shot: string
  /** The reviewer's original picture, if one was taken. */
  before: string | null
  /** Why the page itself failed to load (dev server down, DNS…), if it did. */
  error?: string
}

export async function shotThread(root: string, ref: string, profile = profileDir(root)): Promise<ShotResult> {
  if (!ref) throw new Error('usage: refiner web shot <thread-id>')
  const t = findThread(await loadThreads(root), ref)
  let ws = await runningEndpoint(profile)
  const launched = ws ? null : await launchChrome(profile, { headless: true })
  ws ??= launched!.wsUrl
  const cdp = await CDP.connect(ws)
  let targetId = ''
  try {
    targetId = (await cdp.send('Target.createTarget', { url: 'about:blank', background: true })).targetId
    const sid: string = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    await cdp.send('Page.enable', {}, sid)
    // The reviewer's viewport, so a responsive layout breaks the same way.
    const vp = t.web.viewport ?? { w: 1280, h: 900 }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false }, sid)
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on('Page.loadEventFired', (_p, s) => {
        if (s !== sid) return
        off()
        resolve()
      })
    })
    const nav = await cdp.send('Page.navigate', { url: t.web.url }, sid)
    // `lost` alone would read as "your change removed the element".
    const navError: string | undefined = nav.errorText || undefined
    await Promise.race([loaded, Bun.sleep(15_000)])
    // SPAs render after `load`; give the app a moment to settle.
    await Bun.sleep(1200)

    // Main world, one shot: the resolver only reads the DOM. Our running
    // session's overlay (if any) is in this tab too — hide it for the picture.
    const expr = `(() => {
      ${overlayScript('core')}
      const host = document.querySelector('refiner-overlay'); if (host) host.style.display = 'none'
      const r = globalThis.__refinerCore.resolve(${JSON.stringify(t.web.anchor)})
      if (!r.el) return { status: r.status, score: r.score }
      r.el.scrollIntoView({ block: 'center' })
      r.el.style.outline = '2px dashed #ff3d7f'
      r.el.style.outlineOffset = '2px'
      return { status: r.status, score: r.score, rect: globalThis.__refinerCore.docRect(r.el), text: (r.el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140) }
    })()`
    const res = (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid)).result?.value as {
      status: string
      score: number
      rect?: { x: number; y: number; w: number; h: number }
      text?: string
    }
    await Bun.sleep(100)
    const PAD = 48
    const params: Record<string, unknown> = { format: 'png' }
    if (res?.rect) {
      params['captureBeyondViewport'] = true
      params['clip'] = {
        x: Math.max(0, res.rect.x - PAD),
        y: Math.max(0, res.rect.y - PAD),
        width: Math.max(1, res.rect.w + PAD * 2),
        height: Math.max(1, Math.min(res.rect.h + PAD * 2, 2400)),
        scale: 1,
      }
    }
    const png = (await cdp.send('Page.captureScreenshot', params, sid)).data as string
    await mkdir(join(root, SHOTS_REL), { recursive: true })
    const out = `${SHOTS_REL}/${t.id}-now.png`
    await Bun.write(join(root, out), Buffer.from(png, 'base64'))
    return {
      id: t.id,
      url: t.web.url,
      status: res?.status ?? 'lost',
      score: Math.round((res?.score ?? 0) * 100) / 100,
      text: res?.text ?? null,
      shot: out,
      before: t.web.shot ?? null,
      ...(navError ? { error: `page did not load: ${navError}` } : {}),
    }
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    if (launched) {
      await cdp.send('Browser.close').catch(() => launched.proc?.kill())
      await launched.proc?.exited
    }
    cdp.close()
  }
}
