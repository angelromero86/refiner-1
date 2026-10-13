/**
 * Finding and launching the browser `refiner web` drives.
 *
 * Always with a profile of its own (`--user-data-dir`): since Chrome 136 the
 * remote-debugging switch is ignored on the default profile, by design — it is
 * how cookie-stealing malware used to work. The dedicated profile is
 * persistent, so the reviewer logs into their app once and stays logged in, and
 * their everyday Chrome is never touched.
 *
 * The port is chosen by Chrome (`--remote-debugging-port=0`) and read back from
 * the `DevToolsActivePort` file it writes into the profile, so two sessions —
 * two repos — never fight over 9222. The same file is how `refiner web shot`
 * finds a session that is already running.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
}

/** The browser binary: `REFINER_CHROME` wins, then the usual install paths. */
export function findChrome(): string {
  const env = process.env['REFINER_CHROME']
  if (env) {
    if (!existsSync(env)) throw new Error(`REFINER_CHROME points at ${env}, which does not exist`)
    return env
  }
  for (const p of CANDIDATES[process.platform] ?? []) if (existsSync(p)) return p
  throw new Error('no Chrome/Chromium found; set REFINER_CHROME to the browser binary')
}

/**
 * One profile per repo, outside the repo: a Chrome profile is hundreds of MB of
 * cache that has no business in a working tree (or in `git status`), and per
 * repo because two projects usually mean two logins.
 */
export function profileDir(repoRoot: string): string {
  const slug = repoRoot.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return join(homedir(), '.config', 'refiner', 'chrome', slug)
}

export interface Browser {
  wsUrl: string
  proc: ReturnType<typeof Bun.spawn> | null
}

/** The endpoint of a Chrome already running on `profile`, or null. */
export async function runningEndpoint(profile: string): Promise<string | null> {
  const file = Bun.file(join(profile, 'DevToolsActivePort'))
  if (!(await file.exists())) return null
  const [port, path] = (await file.text()).trim().split('\n')
  if (!port || !path) return null
  try {
    // The file outlives a crashed browser; only a live answer counts.
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return null
    return `ws://127.0.0.1:${port}${path}`
  } catch {
    return null
  }
}

export async function launchChrome(profile: string, opts: { headless?: boolean } = {}): Promise<Browser> {
  await mkdir(profile, { recursive: true })
  // A stale port file from a crashed session would be read back as ours.
  await rm(join(profile, 'DevToolsActivePort'), { force: true })
  const args = [
    findChrome(),
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    ...(opts.headless ? ['--headless=new', '--window-size=1280,900'] : []),
    'about:blank',
  ]
  const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const ws = await runningEndpoint(profile)
    if (ws) return { wsUrl: ws, proc }
    if (proc.exitCode !== null) {
      throw new Error(
        `Chrome exited (${proc.exitCode}) before opening its debugging port — is another window using profile ${profile}?`,
      )
    }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error('Chrome did not open its debugging port within 15s')
}
