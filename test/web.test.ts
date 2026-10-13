/**
 * `refiner web`: the page key (pure), and the whole loop against a real headless
 * Chrome — inject, create, survive a navigation, re-find a moved element, pick
 * up an agent's reply from disk, and photograph the element again.
 *
 * The browser half is skipped when no Chrome is installed (CI images without
 * one), never faked: the point of these tests is CDP's actual behaviour —
 * isolated worlds, bindings scoped to them, scripts that outlive navigations —
 * and a mock would only pin our assumptions about it.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeUrl, pageKey } from '../src/web/page.ts'
import { findChrome } from '../src/web/chrome.ts'
import { isWebThread, WebSession, WEB_STORE_REL } from '../src/web/session.ts'
import { locateSource } from '../src/web/source.ts'
import { shotThread } from '../src/web/cli.ts'

// A real browser: a cold Chrome start plus a page load is seconds, not ms.
setDefaultTimeout(20_000)

describe('pageKey', () => {
  test('collapses ids, keeps words, drops host and query', () => {
    expect(pageKey('http://localhost:4200/users/42/edit?tab=2')).toBe('/users/:id/edit')
    expect(pageKey('https://staging.example.com/users/42/edit')).toBe('/users/:id/edit')
    expect(pageKey('http://x/o/3f2b1c9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f')).toBe('/o/:id')
    expect(pageKey('http://x/p/507f1f77bcf86cd799439011')).toBe('/p/:id')
    expect(pageKey('http://x/settings/')).toBe('/settings')
    expect(pageKey('http://x/')).toBe('/')
  })
  test('hash routing is the route', () => {
    expect(pageKey('http://x/index.html#/cart/9')).toBe('/cart/:id')
    expect(pageKey('http://x/#!/cart')).toBe('/cart')
    // An in-page anchor is not a route.
    expect(pageKey('http://x/docs#install')).toBe('/docs')
  })
  test('normalizeUrl', () => {
    expect(normalizeUrl('localhost:4200')).toBe('http://localhost:4200')
    expect(normalizeUrl('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://a.test/')).toBe('http://a.test/')
  })
})

describe('locateSource', () => {
  let repo = ''
  beforeAll(async () => {
    repo = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-src-')))
    await mkdir(join(repo, 'src/app/settings'), { recursive: true })
    await Bun.write(
      join(repo, 'src/app/settings/settings-form.component.ts'),
      "@Component({\n  selector: 'app-settings-form',\n  templateUrl: './settings-form.component.html',\n})\nexport class SettingsFormComponent {}\n",
    )
    await Bun.write(
      join(repo, 'src/app/settings/settings-form.component.html'),
      '<form>\n  <h2>Profile</h2>\n  <button data-testid="save">Save changes</button>\n</form>\n',
    )
    await Bun.write(join(repo, 'src/app/settings/settings-form.component.spec.ts'), 'class SettingsFormComponent {}\n')
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
  })
  afterAll(() => rm(repo, { recursive: true, force: true }))

  test('angular: class by git grep (not the spec), template line by the element text', async () => {
    const s = await locateSource(repo, { framework: 'angular', component: 'SettingsFormComponent' }, 'Save changes')
    expect(s).toEqual({
      framework: 'angular',
      component: 'SettingsFormComponent',
      file: 'src/app/settings/settings-form.component.ts',
      line: 5,
      template: 'src/app/settings/settings-form.component.html:3',
    })
  })
  test('an inspector attribute wins, made repo-relative', async () => {
    const s = await locateSource(repo, { hint: `${repo}/src/x.vue:12:3`, via: 'data-insp-path' }, '')
    expect(s).toEqual({ file: 'src/x.vue', line: 12 })
  })
  test('a file outside the repo is no hint at all', async () => {
    expect(await locateSource(repo, { file: '/elsewhere/a.tsx', framework: 'react', component: 'Nope' }, '')).toEqual({
      framework: 'react',
      component: 'Nope',
    })
  })
})

let chrome = ''
try {
  chrome = findChrome()
} catch {
  chrome = ''
}

describe.skipIf(!chrome)('refiner web against headless Chrome', () => {
  let repo = ''
  let session: WebSession
  let server: ReturnType<typeof Bun.serve>

  // `/items/:id` renders a toolbar; `?v=2` re-renders it the way a refactor
  // would — an extra wrapper and a reshuffled class list — so the CSS path
  // recorded at creation no longer matches but the test id and text still do.
  // The CSP forbids every script: the overlay must not care.
  const html = (path: string, v2: boolean) => `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<title>Items</title></head><body style="margin:0;font:16px sans-serif">
<h1>Item ${path}</h1>
${v2 ? '<div class="wrap"><section>' : '<section>'}
  <button class="btn primary" data-testid="save">Save changes</button>
  <button class="btn">Cancel</button>
${v2 ? '</section></div>' : '</section>'}
<a id="next" href="/items/7">next</a>
</body></html>`

  type Truthy<T> = Exclude<T, false | '' | 0 | null | undefined>
  const until = async <T>(fn: () => Promise<T>, ms = 8000): Promise<Truthy<T>> => {
    const end = Date.now() + ms
    let last: unknown
    while (Date.now() < end) {
      try {
        const v = await fn()
        if (v) return v as Truthy<T>
      } catch (e) {
        last = e
      }
      await Bun.sleep(100)
    }
    throw new Error(`timed out${last ? `: ${(last as Error).message}` : ''}`)
  }
  const state = () =>
    session.evalOverlay<{ page: string; threads: { id: string; comments: number; drift: string | null }[]; pins: number }>(
      '__refinerApi.state()',
    )
  const readStore = async () => JSON.parse(await Bun.file(join(repo, WEB_STORE_REL)).text())

  beforeAll(async () => {
    repo = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-web-')))
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
    await mkdir(join(repo, 'src/settings'), { recursive: true })
    await Bun.write(
      join(repo, 'src/settings/settings-form.component.ts'),
      "@Component({ selector: 'app-settings-form', templateUrl: './settings-form.component.html' })\nexport class SettingsFormComponent {}\n",
    )
    await Bun.write(join(repo, 'src/settings/settings-form.component.html'), '<h2>Profile</h2>\n<button>Save changes</button>\n')
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url)
        if (u.pathname === '/ng') {
          // Angular's dev-mode debug API, as far as the probe uses it — in the
          // MAIN world, which is the whole point: the overlay cannot see it.
          return new Response(
            `<!doctype html><body><app-settings-form><button>Save changes</button></app-settings-form>
<script>
  class SettingsFormComponent {}
  window.ng = {
    getOwningComponent: () => new SettingsFormComponent(),
    getComponent: () => null,
    getHostElement: () => document.querySelector('app-settings-form'),
  }
</script></body>`,
            { headers: { 'content-type': 'text/html' } },
          )
        }
        return new Response(html(u.pathname, u.searchParams.get('v') === '2'), {
          headers: { 'content-type': 'text/html' },
        })
      },
    })
    session = await WebSession.start({
      root: repo,
      url: `http://127.0.0.1:${server.port}/items/42`,
      author: 'tester',
      headless: true,
      profile: join(repo, '.chrome'),
    })
  }, 30_000)

  afterAll(async () => {
    await session?.close()
    server?.stop(true)
    await rm(repo, { recursive: true, force: true })
  })

  test('creating a thread writes the store, with a fingerprint and a screenshot', async () => {
    await until(async () => (await state()).page === '/items/:id')
    await session.evalOverlay(`__refinerApi.create('[data-testid=save]', 'make this **blue**')`)
    const data = await until(async () => {
      const d = await readStore()
      return d.threads.length === 1 && d
    })
    const t = data.threads[0]
    expect(isWebThread(t)).toBe(true)
    expect(t.file).toBe('/items/:id')
    expect(t.status).toBe('open')
    expect(t.comments[0]).toMatchObject({ author: 'tester', role: 'user', body: 'make this **blue**' })
    expect(t.web.page).toBe('/items/:id')
    expect(t.web.url).toBe(`http://127.0.0.1:${server.port}/items/42`)
    expect(t.web.anchor).toMatchObject({ tag: 'button', testid: 'save', text: 'Save changes' })
    expect(t.web.shot).toMatch(/^\.refiner\/shots\/.+\.png$/)
    const png = Bun.file(join(repo, t.web.shot))
    expect(await png.exists()).toBe(true)
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new TextEncoder().encode('PNG'))
    // Pictures stay out of git.
    expect(await Bun.file(join(repo, '.refiner/shots/.gitignore')).text()).toBe('*\n')
    // The pick token is cleaned off the reviewer's DOM.
    expect(await session.evalOverlay<boolean>(`!!document.querySelector('[data-refiner-pick]')`)).toBe(false)
    expect((await state()).pins).toBe(1)
  })

  test('the thread follows to another item of the same page, exactly', async () => {
    await session.navigate(`http://127.0.0.1:${server.port}/items/7`)
    const s = await until(async () => {
      const s = await state()
      return s.threads[0]?.drift && s.pins === 1 && s
    })
    expect(s.page).toBe('/items/:id')
    expect(s.threads[0]!.drift).toBe('exact')
  })

  test('a refactored DOM: a test id still pins exactly, a bare element is re-found as moved', async () => {
    // Cancel has no id and no test id: only its text, its classes and where it
    // sat in the tree identify it — and the refactor below moves it in the tree.
    await session.evalOverlay(`__refinerApi.create('section > button:nth-of-type(2)', 'wrong label')`)
    await until(async () => (await readStore()).threads.length === 2)
    await until(async () => (await state()).pins === 2)

    await session.navigate(`http://127.0.0.1:${server.port}/items/7?v=2`)
    const s = await until(async () => {
      const s = await state()
      return s.threads.length === 2 && s.threads.every((t) => t.drift) && s
    })
    expect(s.threads.map((t) => t.drift)).toEqual(['exact', 'moved'])
    expect(s.pins).toBe(2)
  })

  test("an agent's reply on disk reaches the open page", async () => {
    const data = await readStore()
    data.threads[0].comments.push({
      id: 'c-agent001',
      author: 'Claude Code',
      role: 'assistant',
      body: 'Done.',
      createdAt: new Date().toISOString(),
    })
    data.extraRootKey = 'kept'
    await Bun.write(join(repo, WEB_STORE_REL), JSON.stringify(data, null, 2) + '\n')
    await until(async () => (await state()).threads[0]?.comments === 2)

    // And a reply from the page merges on top of it rather than over it.
    const id = data.threads[0].id
    await session.evalOverlay(`__refinerApi.reply(${JSON.stringify(id)}, 'thanks')`)
    const after = await until(async () => {
      const d = await readStore()
      return d.threads[0].comments.length === 3 && d
    })
    expect(after.threads[0].comments.map((c: { role: string }) => c.role)).toEqual(['user', 'assistant', 'user'])
    expect(after.extraRootKey).toBe('kept')
  })

  test("shot re-finds the element in the reviewer's running Chrome and photographs it", async () => {
    const [save, cancel] = (await readStore()).threads
    const a = await shotThread(repo, save.id.slice(-4), join(repo, '.chrome'))
    expect(a).toMatchObject({ id: save.id, status: 'exact', text: 'Save changes', before: save.web.shot })
    expect(await Bun.file(join(repo, a.shot)).exists()).toBe(true)
    // The thread's URL is the plain page, so Cancel is back where it was.
    const b = await shotThread(repo, cancel.id, join(repo, '.chrome'))
    expect(b).toMatchObject({ status: 'exact', text: 'Cancel' })
    // The tab it opened is gone again; only the reviewer's remains.
    await until(async () => session.tabs.size === 1)
  })

  test('another page shows none of them', async () => {
    await session.navigate(`http://127.0.0.1:${server.port}/about`)
    const s = await until(async () => {
      const s = await state()
      return s.page === '/about' && s
    })
    expect(s.pins).toBe(0)
    expect(s.threads.length).toBe(2) // listed in the panel, pinned nowhere
  })

  test('a thread created in an Angular app knows its component, file and template line', async () => {
    await session.navigate(`http://127.0.0.1:${server.port}/ng`)
    await until(async () => (await state()).page === '/ng')
    await session.evalOverlay(`__refinerApi.create('button', 'shorter label')`)
    const t = await until(async () => (await readStore()).threads.find((x: { file: string }) => x.file === '/ng'))
    expect(t.web.source).toEqual({
      framework: 'angular',
      component: 'SettingsFormComponent',
      file: 'src/settings/settings-form.component.ts',
      line: 2,
      template: 'src/settings/settings-form.component.html:2',
    })
  })
})
