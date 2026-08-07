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
}

export function defaultUIState(): UIState {
  return { treeAutoHide: false, treeWidthPct: 35 }
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
