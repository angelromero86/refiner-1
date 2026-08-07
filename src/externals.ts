/**
 * Handing the terminal over to another program and taking it back.
 *
 * The Go original used bubbletea's ExecProcess, which tore down the TUI, ran the
 * child with inherited stdio and rebuilt the TUI afterwards. OpenTUI exposes the
 * same shape via suspend()/resume(): suspend drops raw mode, mouse tracking and
 * input handling so the child owns the terminal outright.
 *
 * Inside tmux we don't suspend at all — the child goes into a display-popup, a
 * separate pane that never touches ours, so the TUI can keep rendering behind it.
 */

import type { CliRenderer } from '@opentui/core'
import type { App } from './app.ts'

/** True when running inside a tmux session. */
export function inTmux(): boolean {
  const t = process.env['TMUX']
  return t !== undefined && t !== ''
}

function centeredPopupArgs(widthPct: number, heightPct: number): string[] {
  return ['display-popup', '-B', '-E', '-w', `${widthPct}%`, '-h', `${heightPct}%`]
}

/**
 * contentFramePopupArgs positions a popup precisely over the content pane's text
 * area, so `e` feels like editing in place.
 *
 * Rows from the top:    1..3 header (rounded border = 3 rows), 4 content pane
 *                       top border, 5 first content row.
 * Columns from the left: 1..treeW tree pane, treeW+1 content border-left,
 *                       treeW+2 content padding-left, treeW+3.. content text.
 */
function contentFramePopupArgs(app: App): string[] {
  const x = app.treePanelWidth() + 3
  const y = 5
  const w = Math.max(1, app.diffPanelWidth() - 4)
  const h = Math.max(1, app.paneInnerHeight())
  return [
    'display-popup',
    '-B',
    '-E',
    '-x',
    String(x),
    '-y',
    String(y),
    '-w',
    String(w),
    '-h',
    String(h),
  ]
}

/**
 * runExternal runs a child process with the terminal to itself, then refreshes
 * everything — the working tree may well have changed while it had control.
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
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await proc.exited
  } catch (err) {
    app.err = err as Error
  } finally {
    if (suspend) renderer.resume()
  }
  app.clearCaches()
  await app.refresh()
}

/** openEditor opens nvim on the selected file (`e`). */
export async function openEditor(app: App, renderer: CliRenderer): Promise<void> {
  if (app.selectedPath === '') return
  if (inTmux()) {
    await runExternal(
      app,
      renderer,
      ['tmux', ...contentFramePopupArgs(app), 'nvim', app.selectedPath],
      false,
    )
  } else {
    await runExternal(app, renderer, ['nvim', app.selectedPath], true)
  }
}

/** openLazygit opens lazygit (`g`). */
export async function openLazygit(app: App, renderer: CliRenderer): Promise<void> {
  if (inTmux()) {
    await runExternal(app, renderer, ['tmux', ...centeredPopupArgs(90, 90), 'lazygit'], false)
  } else {
    await runExternal(app, renderer, ['lazygit'], true)
  }
}
