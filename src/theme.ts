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

  /**
   * Whether to syntax-highlight diff content. When off, add/del lines render in
   * flat green/red as they did before highlighting existed.
   */
  syntaxHighlight: boolean

  /**
   * Syntax colors by tree-sitter capture group.
   *
   * Lookup falls back along dots, so `keyword.function` uses `keyword` unless it
   * is given its own entry — the same rule editors use, which keeps a custom
   * palette to a handful of lines instead of an exhaustive table.
   */
  syntax: Record<string, string>

  /**
   * Background — the fill behind modal overlays.
   *
   * The panes themselves stay transparent and show the terminal through, exactly
   * as before. Overlays can't: they float above the diff, so without an opaque
   * fill the code underneath bleeds through the comment text. The default is the
   * terminal background the rest of this palette was tuned against, so a modal
   * looks like it sits on the terminal rather than on the diff. Set it lighter
   * for a raised, "floating card" look.
   */
  background: string
}

export function defaultTheme(): Theme {
  return {
    // Gruvbox Dark. Chrome uses the warm bright accents; the diff backgrounds are
    // gruvbox's own DiffAdd/DiffDelete tints so added and removed lines read as
    // washes rather than blocks of colored text — which is what makes room for
    // syntax colors on top of them.
    primary: '#fe8019', // bright orange
    accent: '#fabd2f', // bright yellow
    focus: '#8ec07c', // bright aqua
    muted: '#7c6f64', // bg4 — line numbers stay legible, idle borders stay quiet
    foreground: '#ebdbb2', // fg1

    addBg: '#32361a',
    delBg: '#402120',
    addFg: '#b8bb26', // bright green
    delFg: '#fb4934', // bright red
    stagedBg: '#23303d',
    stagedFg: '#83a598', // bright blue

    comment: '#4c2b3d',
    commentLabel: '#fbf1c7', // fg0

    cursorBg: '#3c3836', // bg1 — the classic gruvbox cursorline
    background: '#282828', // bg0

    syntaxHighlight: true,
    syntax: defaultSyntax(),
  }
}

/**
 * Capture group → color, following gruvbox.nvim's assignments. Only the roots are
 * listed; dotted children inherit (see Theme.syntax).
 */
export function defaultSyntax(): Record<string, string> {
  return {
    keyword: '#fb4934', // red
    conditional: '#fb4934',
    repeat: '#fb4934',
    label: '#fb4934',
    exception: '#fb4934',

    function: '#b8bb26', // green
    string: '#b8bb26',
    character: '#b8bb26',

    number: '#d3869b', // purple
    boolean: '#d3869b',
    float: '#d3869b',
    constant: '#d3869b',

    type: '#fabd2f', // yellow
    constructor: '#fabd2f',
    attribute: '#fabd2f',
    annotation: '#fabd2f',

    variable: '#ebdbb2', // fg1
    property: '#ebdbb2',
    parameter: '#ebdbb2',
    field: '#ebdbb2',
    namespace: '#ebdbb2',
    module: '#ebdbb2',
    operator: '#ebdbb2',

    tag: '#8ec07c', // aqua
    include: '#8ec07c',
    preproc: '#8ec07c',

    punctuation: '#a89984', // fg4 — present but recessive
    comment: '#928374', // gray
    text: '#ebdbb2',
    title: '#fabd2f',
    emphasis: '#ebdbb2',
    literal: '#b8bb26',
    reference: '#8ec07c',
    uri: '#83a598',
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

/** snake_case in the file → camelCase on the Theme. Color fields only. */
const KEY_MAP: Record<string, ColorKey> = {
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
  background: 'background',
}

/** The Theme fields that hold a single color string. */
type ColorKey = Exclude<keyof Theme, 'syntax' | 'syntaxHighlight'>

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

  const obj = parsed as Record<string, unknown>
  const theme = { ...defaults, syntax: { ...defaults.syntax } }
  for (const [fileKey, themeKey] of Object.entries(KEY_MAP)) {
    const v = obj[fileKey]
    if (typeof v === 'string' && v !== '') theme[themeKey] = v
  }
  if (typeof obj['syntax_highlight'] === 'boolean') {
    theme.syntaxHighlight = obj['syntax_highlight']
  }
  // `[syntax]` merges over the defaults rather than replacing them, so recoloring
  // one group doesn't blank out every other.
  const syntax = obj['syntax']
  if (typeof syntax === 'object' && syntax !== null) {
    for (const [group, color] of Object.entries(syntax as Record<string, unknown>)) {
      if (typeof color === 'string' && color !== '') theme.syntax[group] = color
    }
  }
  return { theme }
}
