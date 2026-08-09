/**
 * Reads `~/.config/refiner/config.toml` once and hands back everything it holds:
 * the color palette and the editor settings.
 *
 * Parsing lives here rather than in theme.ts so that file can stay about colors.
 * Everything is best-effort — a missing file gives defaults, a malformed one gives
 * defaults plus a warning, and a bad individual value is ignored rather than
 * taking the rest of the config down with it.
 */

import {
  configPath,
  DEFAULT_THEME_NAME,
  emptyOverrides,
  resolveTheme,
  THEME_KEY_MAP,
  themeByName,
  type Theme,
  type ThemeOverrides,
} from './theme.ts'

/**
 * How an editor wants a line number on its command line.
 *
 *   plus   — `nvim +42 file`   (vi, vim, nvim, emacs, nano, micro, kak, joe…)
 *   suffix — `druk file:42`    (druk, helix, subl, zed…)
 *   none   — the editor takes no line argument
 */
export type LineStyle = 'plus' | 'suffix' | 'none'

export interface EditorConfig {
  /** argv of the editor, already split. Never empty. */
  command: string[]
  lineStyle: LineStyle
}

/**
 * Size of the floating window `e` and `g` open, as a percentage of the terminal.
 * Only tmux and zellij can honour it — without a multiplexer the child gets the
 * whole screen and there is nothing to size.
 */
export interface PopupConfig {
  widthPct: number
  heightPct: number
}

/**
 * Glyphs for the file tree. Defaults are Nerd Font folder icons; any string works,
 * including emoji — the renderer measures the glyph and pads it to a fixed cell
 * budget, so a 2-cell emoji keeps the filenames aligned just as a 1-cell glyph does.
 */
export interface IconConfig {
  folderOpen: string
  folderClosed: string
}

export interface Config {
  /** The palette in force at startup: `themeName`'s base with `themeOverrides` on top. */
  theme: Theme
  /** Which built-in palette the file asked for; `t` can change it at runtime. */
  themeName: string
  /**
   * The file's own color keys, kept apart from the resolved theme so switching
   * palettes at runtime can re-apply them over the new base. A user who wrote
   * `focus = "#ff0000"` means it in every theme.
   */
  themeOverrides: ThemeOverrides
  editor: EditorConfig
  popup: PopupConfig
  icons: IconConfig
  /**
   * Reload by itself when an agent, the VSCode extension or git changes something
   * under refiner. Off falls back to pressing `r`.
   */
  watch: boolean
  warning?: string
}

/** nf-fa-folder_open / nf-fa-folder. */
const DEFAULT_ICONS: IconConfig = {
  folderOpen: '\uf07c',
  folderClosed: '\uf07b',
}

function resolveIcons(value: unknown): IconConfig {
  const out = { ...DEFAULT_ICONS }
  if (typeof value !== 'object' || value === null) return out
  const obj = value as Record<string, unknown>
  if (typeof obj['folder_open'] === 'string' && obj['folder_open'] !== '') {
    out.folderOpen = obj['folder_open']
  }
  if (typeof obj['folder_closed'] === 'string' && obj['folder_closed'] !== '') {
    out.folderClosed = obj['folder_closed']
  }
  return out
}

const DEFAULT_POPUP_PCT = 90

/** Percentages below 20 leave nothing usable; above 100 tmux rejects outright. */
function resolvePct(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POPUP_PCT
  return Math.min(100, Math.max(20, Math.round(value)))
}

/**
 * Line-argument conventions for editors people actually launch from a terminal.
 * `plus` is the POSIX-ish default, so only the exceptions need listing.
 */
const LINE_STYLES: Record<string, LineStyle> = {
  vi: 'plus',
  vim: 'plus',
  nvim: 'plus',
  emacs: 'plus',
  emacsclient: 'plus',
  nano: 'plus',
  pico: 'plus',
  micro: 'plus',
  joe: 'plus',
  kak: 'plus',

  druk: 'suffix',
  hx: 'suffix',
  helix: 'suffix',
  subl: 'suffix',
  zed: 'suffix',
  code: 'suffix',
  codium: 'suffix',
  cursor: 'suffix',
}

/**
 * resolveEditor picks the editor command: the config's `editor`, else $VISUAL,
 * else $EDITOR, else nvim. The string is split on whitespace so `editor = "code -w"`
 * works.
 */
function resolveEditor(configured: unknown): string[] {
  const raw =
    (typeof configured === 'string' && configured.trim() !== '' ? configured : '') ||
    process.env['VISUAL'] ||
    process.env['EDITOR'] ||
    'nvim'
  const parts = raw.trim().split(/\s+/).filter((p) => p !== '')
  return parts.length > 0 ? parts : ['nvim']
}

function resolveLineStyle(command: string[], configured: unknown): LineStyle {
  if (configured === 'plus' || configured === 'suffix' || configured === 'none') {
    return configured
  }
  const bin = command[0]!
  const base = bin.slice(bin.lastIndexOf('/') + 1)
  return LINE_STYLES[base] ?? 'plus'
}

export function defaultConfig(): Config {
  const command = resolveEditor(undefined)
  return {
    theme: resolveTheme(DEFAULT_THEME_NAME, emptyOverrides()),
    themeName: DEFAULT_THEME_NAME,
    themeOverrides: emptyOverrides(),
    editor: { command, lineStyle: resolveLineStyle(command, undefined) },
    popup: { widthPct: DEFAULT_POPUP_PCT, heightPct: DEFAULT_POPUP_PCT },
    icons: { ...DEFAULT_ICONS },
    watch: true,
  }
}

export async function loadConfig(path = configPath()): Promise<Config> {
  const file = Bun.file(path)
  if (!(await file.exists())) return defaultConfig()

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(await file.text())
  } catch (err) {
    return { ...defaultConfig(), warning: `decoding ${path}: ${(err as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultConfig()
  const obj = parsed as Record<string, unknown>

  // ---- theme ----------------------------------------------------------
  // `theme = "vesper"` picks the base palette; the individual color keys below
  // are stamped on top of it. An unknown name is ignored rather than fatal, and
  // silently — a warning here would be printed on every launch for a typo the
  // picker can fix in one keystroke.
  const named = obj['theme']
  const themeName =
    typeof named === 'string' && themeByName(named) ? named : DEFAULT_THEME_NAME

  const themeOverrides = emptyOverrides()
  for (const [fileKey, themeKey] of Object.entries(THEME_KEY_MAP)) {
    const v = obj[fileKey]
    if (typeof v === 'string' && v !== '') themeOverrides.colors[themeKey] = v
  }
  if (typeof obj['syntax_highlight'] === 'boolean') {
    themeOverrides.syntaxHighlight = obj['syntax_highlight']
  }
  // `[syntax]` merges over the theme's own table rather than replacing it, so
  // recoloring one group doesn't blank out every other.
  const syntax = obj['syntax']
  if (typeof syntax === 'object' && syntax !== null) {
    for (const [group, color] of Object.entries(syntax as Record<string, unknown>)) {
      if (typeof color === 'string' && color !== '') themeOverrides.syntax[group] = color
    }
  }
  const theme = resolveTheme(themeName, themeOverrides)

  // ---- editor ---------------------------------------------------------
  const command = resolveEditor(obj['editor'])
  const editor: EditorConfig = {
    command,
    lineStyle: resolveLineStyle(command, obj['editor_line']),
  }

  const popup: PopupConfig = {
    widthPct: resolvePct(obj['popup_width']),
    heightPct: resolvePct(obj['popup_height']),
  }

  return {
    theme,
    themeName,
    themeOverrides,
    editor,
    popup,
    icons: resolveIcons(obj['icons']),
    watch: typeof obj['watch'] === 'boolean' ? obj['watch'] : true,
  }
}

/**
 * editorArgv builds the full command to open `file` at `line`. A line of 0 (the
 * cursor sits on a deleted line, which has no working-tree position) just opens
 * the file.
 */
export function editorArgv(editor: EditorConfig, file: string, line: number): string[] {
  if (line <= 0 || editor.lineStyle === 'none') return [...editor.command, file]
  if (editor.lineStyle === 'suffix') return [...editor.command, `${file}:${line}`]
  return [...editor.command, `+${line}`, file]
}
