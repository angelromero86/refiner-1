/**
 * Handing the terminal to another program and taking it back.
 *
 * There are three ways to do that, and which one you get depends on where refiner
 * is running:
 *
 *   tmux    → `display-popup`: a bordered, titled window floating over the TUI,
 *             which keeps rendering behind it.
 *   zellij  → `run --floating`: the same idea under a different multiplexer.
 *   neither → suspend the renderer and let the child own the whole terminal.
 *
 * Only the last one is full-screen, and that isn't a choice: without a multiplexer
 * nothing can give a child process a sub-rectangle of the terminal. Doing it
 * ourselves would mean running the editor under a PTY (`Bun.Terminal`) and writing
 * a VT emulator to paint its output into a pane — plus a prefix key to decide who
 * owns each keystroke, which is the problem tmux already solves.
 */

import { join } from 'node:path'
import type { CliRenderer } from '@opentui/core'
import type { App } from './app.ts'
import { editorArgv, type EditorConfig, type PopupConfig } from './config.ts'

/** True when running inside a tmux session. */
export function inTmux(): boolean {
  const t = process.env['TMUX']
  return t !== undefined && t !== ''
}

/** True when running inside a zellij session. */
export function inZellij(): boolean {
  const z = process.env['ZELLIJ']
  return z !== undefined && z !== ''
}

/**
 * The top-left corner that centres a popup of the given size, as a percentage of
 * the terminal.
 *
 * Neither multiplexer centres a floating window for you once you ask for an
 * explicit size: each places it at its own default origin and then clips whatever
 * hangs off the screen. That reads as "stuck to the bottom-right AND smaller than I
 * asked for" — two symptoms, one cause.
 */
function centreOffset(pct: number): number {
  return Math.round((100 - pct) / 2)
}

/**
 * A centred tmux popup, sized as a percentage of the terminal and framed like the
 * app's own overlays. `-E` closes it when the command exits; `-b rounded` matches
 * the rounded borders everywhere else (tmux 3.3+).
 *
 * `-x C -y C` is tmux's own "centre of the terminal". It's spelled out rather than
 * left to the default because display-popup takes its position semantics from
 * display-menu, where the default is pane-relative.
 */
export function tmuxPopupArgs(popup: PopupConfig, title: string): string[] {
  return [
    'display-popup',
    '-E',
    '-b',
    'rounded',
    '-T',
    ` ${title} `,
    '-x',
    'C',
    '-y',
    'C',
    '-w',
    `${popup.widthPct}%`,
    '-h',
    `${popup.heightPct}%`,
  ]
}

/**
 * zellij's equivalent: a floating pane that closes with the command.
 *
 * zellij has no "centre" keyword, so the origin is computed from the size. Left to
 * itself it cascades new floating panes from its own default offset, which is how a
 * 90% pane ends up hanging off the bottom-right and getting trimmed.
 */
export function zellijFloatingArgs(popup: PopupConfig, title: string): string[] {
  return [
    'run',
    '--floating',
    '--close-on-exit',
    '--name',
    title,
    '--x',
    `${centreOffset(popup.widthPct)}%`,
    '--y',
    `${centreOffset(popup.heightPct)}%`,
    '--width',
    `${popup.widthPct}%`,
    '--height',
    `${popup.heightPct}%`,
    '--',
  ]
}

/**
 * runExternal runs a child process, then refreshes everything — the working tree
 * may well have changed while it had control.
 *
 * `suspend` is false for the multiplexer paths: the child lands in its own pane, so
 * our renderer keeps the terminal. That also means the child must NOT inherit our
 * stdio — a tmux error message would otherwise be painted straight over the TUI —
 * so its output is captured and surfaced in the error banner instead.
 */
async function runExternal(
  app: App,
  renderer: CliRenderer,
  cmd: string[],
  suspend: boolean,
): Promise<void> {
  if (suspend) renderer.suspend()
  try {
    const proc = Bun.spawn(cmd, {
      stdin: suspend ? 'inherit' : 'ignore',
      stdout: suspend ? 'inherit' : 'pipe',
      stderr: suspend ? 'inherit' : 'pipe',
    })
    if (suspend) {
      await proc.exited
      app.err = null
    } else {
      const [err, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0 && err.trim() !== '') {
        app.err = new Error(`${cmd[0]}: ${err.trim()}`)
      } else {
        app.err = null
      }
    }
  } catch (err) {
    app.err = err as Error
  } finally {
    if (suspend) renderer.resume()
  }
  // Whatever we were about to ask git for, a tool that has just had the index to
  // itself outranks it.
  app.stagingIntent.clear()
  app.stagingFullIntent.clear()
  app.clearCaches()
  await app.refresh()
}

/**
 * What to run for `e`, and what to label the window.
 *
 * The argv path is ABSOLUTE while the title stays repo-relative, and both halves
 * are deliberate. Under tmux and zellij the editor is not our child — the
 * multiplexer's server spawns it, in whatever directory it decides (usually the
 * pane's), so it does not inherit the chdir to the repo root that makes every
 * other path in the app work. The only thing still under our control there is the
 * argv, so the path has to carry the root itself. The title, meanwhile, sits in a
 * popup border where an absolute path would eat the whole width.
 */
export function editorInvocation(
  editor: EditorConfig,
  root: string,
  path: string,
  line: number,
): { argv: string[]; title: string } {
  return {
    argv: editorArgv(editor, join(root, path), line),
    title: line > 0 ? `${path}:${line}` : path,
  }
}

/**
 * openEditor opens the configured editor on the selected file, at the line under
 * the cursor (`e`). The editor and its line-argument style come from config.toml,
 * falling back to $VISUAL / $EDITOR / nvim.
 */
export async function openEditor(app: App, renderer: CliRenderer): Promise<void> {
  if (app.selectedPath === '') return
  const { argv, title } = editorInvocation(
    app.editor,
    app.root,
    app.selectedPath,
    app.cursorLine(),
  )

  if (inTmux()) {
    await runExternal(app, renderer, ['tmux', ...tmuxPopupArgs(app.popup, title), ...argv], false)
  } else if (inZellij()) {
    await runExternal(app, renderer, ['zellij', ...zellijFloatingArgs(app.popup, title), ...argv], false)
  } else {
    await runExternal(app, renderer, argv, true)
  }
}

/** openLazygit opens lazygit (`g`). */
export async function openLazygit(app: App, renderer: CliRenderer): Promise<void> {
  if (inTmux()) {
    await runExternal(app, renderer, ['tmux', ...tmuxPopupArgs(app.popup, 'lazygit'), 'lazygit'], false)
  } else if (inZellij()) {
    await runExternal(
      app,
      renderer,
      ['zellij', ...zellijFloatingArgs(app.popup, 'lazygit'), 'lazygit'],
      false,
    )
  } else {
    await runExternal(app, renderer, ['lazygit'], true)
  }
}
