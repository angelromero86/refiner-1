#!/usr/bin/env bun
/**
 * refiner — a git code-review TUI with line-level staging and review threads.
 *
 *   refiner            → uncommitted changes (working tree + index)
 *   refiner <branch>   → review the current branch against <branch>...HEAD
 */

import { createCliRenderer } from '@opentui/core'
import { App } from './app.ts'
import { installKeyHandling } from './dispatch.ts'
import { gitUserName, Mode, type Source } from './git.ts'
import { loadConfig } from './config.ts'
import { statePath } from './state.ts'
import { configPath } from './theme.ts'
import { applyTheme } from './styles.ts'
import { configureAssetRoot } from './syntax.ts'
import { View } from './view.ts'

const USAGE = `refiner — git code-review TUI

usage:
  refiner              review uncommitted changes (working tree + index)
  refiner <branch>     review the current branch against <branch>...HEAD

keys:
  press k inside refiner for the full keymap

config:
  ${configPath()}
  (optional — set your editor there, e.g. editor = "nvim")

state:
  ${statePath()}
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE)
    return
  }

  // Must run before anything reaches into OpenTUI's asset resolution.
  configureAssetRoot()

  const { theme, editor, popup, warning } = await loadConfig()
  if (warning) process.stderr.write(`warning: ${warning}\n`)
  applyTheme(theme)

  const source: Source =
    args.length > 0
      ? { mode: Mode.Review, target: args[0]! }
      : { mode: Mode.Uncommitted, target: '' }

  const app = await App.create(source)
  app.author = (await gitUserName()) || guessUser()
  app.editor = editor
  app.popup = popup

  const renderer = await createCliRenderer({
    // The console overlay would swallow keys we bind; errors surface in the
    // app's own error banner instead.
    consoleMode: 'disabled',
    exitOnCtrlC: false,
  })

  new View(app, renderer)
  installKeyHandling(app, renderer)

  renderer.on('resize', (width: number, height: number) => {
    void app.onResize(width, height)
  })

  app.width = renderer.width
  app.height = renderer.height
  await app.loadFiles()
}

/**
 * Author label when git has no user.name configured. Mirrors the Go original's
 * fallback chain: git config → OS username → "anon".
 */
function guessUser(): string {
  return process.env['USER'] ?? process.env['LOGNAME'] ?? 'anon'
}

main().catch((err: unknown) => {
  process.stderr.write(`refiner: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
