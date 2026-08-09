/**
 * Persisted UI preferences, stored next to config.toml as state.json.
 *
 * Kept separate from the theme because refiner WRITES this file itself whenever
 * the user toggles a preference, while config.toml is hand-edited. It's JSON
 * rather than TOML for exactly that reason: no serializer needed for a blob
 * nobody is expected to edit by hand.
 *
 * viewMode is intentionally NOT persisted: every session starts in DIFF
 * (unified) view; the user can cycle with Tab as needed.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { configDir } from './theme.ts'

export interface UIState {
  /** Collapse the tree pane while the content pane has focus. */
  treeAutoHide: boolean
  /** Tree pane width as a percentage of terminal width; clamped to 15..70. */
  treeWidthPct: number
  /**
   * The palette picked with `t`, or '' while the user has never picked one.
   *
   * Empty is not the same as the default name: it is what lets config.toml's
   * `theme = …` keep working. The precedence is "last thing the user said" —
   * a name here wins over the file, because pressing `t` is a more recent
   * instruction than a line written some time ago, and a config edit wins back
   * the moment the picker has never run. An unknown name (a theme this build
   * dropped) falls back to the default rather than to a blank screen.
   */
  themeName: string
}

export function defaultUIState(): UIState {
  return { treeAutoHide: false, treeWidthPct: 35, themeName: '' }
}

export function statePath(): string {
  return join(configDir(), 'state.json')
}

/** loadState reads state.json; a missing or corrupt file yields the defaults. */
export async function loadState(): Promise<UIState> {
  const s = defaultUIState()
  try {
    const file = Bun.file(statePath())
    if (!(await file.exists())) return s
    const raw = (await file.json()) as Partial<UIState>
    if (typeof raw.treeAutoHide === 'boolean') s.treeAutoHide = raw.treeAutoHide
    if (typeof raw.treeWidthPct === 'number' && raw.treeWidthPct > 0) {
      s.treeWidthPct = raw.treeWidthPct
    }
    if (typeof raw.themeName === 'string') s.themeName = raw.themeName
    return s
  } catch {
    return s
  }
}

/**
 * saveState writes state.json. Callers ignore failures on purpose — losing a
 * preference is annoying but never worth interrupting the UI for.
 */
export async function saveState(s: UIState): Promise<void> {
  await mkdir(configDir(), { recursive: true })
  await Bun.write(statePath(), JSON.stringify(s, null, 2) + '\n')
}
