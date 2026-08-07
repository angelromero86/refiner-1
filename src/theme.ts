/**
 * The customizable color palette, read from `~/.config/refiner/config.toml`.
 *
 * Each field is named for its UI role, not its hue, so a config edit reads as
 * intent ("make the focus color orange") rather than a color swap ("change cyan
 * to orange"). Values are hex strings — terminal-independent, so the app looks
 * the same regardless of which palette the terminal maps ANSI codes to.
 *
 * The file is read-only as far as refiner is concerned; UI preferences that
 * refiner writes itself live in state.json instead.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Theme {
  /**
   * Primary — brand identity. App name in header, border around the header
   * pane, border around modal overlays.
   */
  primary: string

  /**
   * Accent — secondary highlight. Footer key labels, modified status badge (M),
   * directory names in the tree, `▶` marker on the selected message in modals,
   * and the "this thing has comments" cue (`●` in the tree, scrollbar band).
   */
  accent: string

  /**
   * Focus — "this is active / informational". Focused pane border, mode label
   * in the header, rename status badge (R/C).
   */
  focus: string

  /** Muted — subtle scaffolding. Line-number gutter, idle pane border. */
  muted: string

  /**
   * Foreground — the app's default text color: diff context lines, comment
   * bodies, snippets, and the scrollbar viewport thumb tint.
   */
  foreground: string

  /**
   * Diff hunk backgrounds + foregrounds. addFg also paints the `A` status
   * badge; delFg also paints `D`, the error banner and the OUTDATED label.
   */
  addBg: string
  delBg: string
  addFg: string
  delFg: string
  stagedBg: string
  stagedFg: string

  /**
   * Comment — "this thing has reviewer comments". Drives the gutter background
   * on commented lines, the `●` tree marker, and the scrollbar comment band.
   * Used as both foreground and background — pick something vivid either way.
   */
  comment: string

  /**
   * CommentLabel — text color for line numbers drawn on top of the comment
   * background. Pick strong contrast against `comment`.
   */
  commentLabel: string

  /** CursorBg — background of the row under the cursor. */
  cursorBg: string
}

export function defaultTheme(): Theme {
  return {
    primary: '#d48472',
    accent: '#d99a3a',
    focus: '#c4ba6e',
    muted: '#4a3a2e',
    foreground: '#e6cfa8',

    addBg: '#0d2117',
    delBg: '#211517',
    addFg: '#56d364',
    delFg: '#f85149',
    stagedBg: '#0d1a2e',
    stagedFg: '#4493f8',

    // Dark pink — distinctive enough that "this line has a comment" reads
    // instantly without overlapping any other UI state color.
    comment: '#5a2638',
    commentLabel: '#f5e6c8',

    // Just barely lighter than the omarchy ochre terminal bg (#1c1714): each
    // channel bumped by 0x0a to keep the warm hue but separate the row.
    cursorBg: '#26211e',
  }
}

/** configDir honors XDG_CONFIG_HOME, matching Go's os.UserConfigDir(). */
export function configDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && xdg !== '') return join(xdg, 'refiner')
  return join(homedir(), '.config', 'refiner')
}

export function configPath(): string {
  return join(configDir(), 'config.toml')
}

/** snake_case in the file → camelCase on the Theme. */
const KEY_MAP: Record<string, keyof Theme> = {
  primary: 'primary',
  accent: 'accent',
  focus: 'focus',
  muted: 'muted',
  foreground: 'foreground',
  add_bg: 'addBg',
  del_bg: 'delBg',
  add_fg: 'addFg',
  del_fg: 'delFg',
  staged_bg: 'stagedBg',
  staged_fg: 'stagedFg',
  comment: 'comment',
  comment_label: 'commentLabel',
  cursor_bg: 'cursorBg',
}

/**
 * loadTheme reads the config file, merging non-empty fields over the defaults.
 * A missing file is not an error — you get the defaults. A malformed file is
 * reported so the user knows why their colors didn't apply.
 */
export async function loadTheme(path = configPath()): Promise<{ theme: Theme; warning?: string }> {
  const defaults = defaultTheme()
  const file = Bun.file(path)
  if (!(await file.exists())) return { theme: defaults }

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await file.text())
  } catch (err) {
    return { theme: defaults, warning: `decoding ${path}: ${(err as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { theme: defaults }

  const theme = { ...defaults }
  for (const [fileKey, themeKey] of Object.entries(KEY_MAP)) {
    const v = (parsed as Record<string, unknown>)[fileKey]
    if (typeof v === 'string' && v !== '') theme[themeKey] = v
  }
  return { theme }
}
