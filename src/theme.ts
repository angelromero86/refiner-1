/**
 * The customizable color palette. src/config.ts reads the file; this module owns
 * the shape, the defaults and the file-key mapping.
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
   * Accent — secondary highlight. Key labels in the header and overlays, modified
   * status badge (M), directory names in the tree, `▶` marker on the selected row,
   * and the "a thread is anchored here" cue (`●` in the tree, minimap band).
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
   * Thread — "a review thread is anchored here". Drives the gutter background on
   * those lines, the `●` tree marker and the minimap band. Used as both
   * foreground and background — pick something vivid either way.
   */
  thread: string

  /**
   * ThreadLabel — text color for line numbers drawn on top of the thread
   * background. Pick strong contrast against `thread`.
   */
  threadLabel: string

  /**
   * ThreadMarker — the `●` beside files with threads, and the minimap band.
   *
   * Separate from `thread` because the two are opposite roles: `thread` is a
   * background and wants to be dark enough to read code on top of, while this is a
   * foreground on that same dark terminal and has to actually stand out. Reusing
   * the background colour here made the dot practically invisible.
   */
  threadMarker: string

  /**
   * TreeGuide — the ├ └ │ lines that draw the file tree's structure.
   *
   * Its own knob rather than a shade of `muted`, because it wants to be light
   * enough to trace a nesting level by eye but never compete with the filenames
   * sitting right next to it.
   */
  treeGuide: string

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
   * fill the code underneath bleeds through the overlay's text. The default is the
   * terminal background the rest of this palette was tuned against, so a modal
   * looks like it sits on the terminal rather than on the diff. Set it lighter
   * for a raised, "floating card" look.
   */
  background: string
}

/**
 * The built-in palettes, in the order the `t` picker lists them.
 *
 * A theme is a whole Theme value, not a patch over the default: a light theme
 * has to move every knob (backgrounds, diff washes, the thread plum), and a
 * palette expressed as a diff against a dark one is a palette nobody can read as
 * a palette. The cost is repetition, which is the point — each entry is
 * self-contained and reviewable next to the colors it names.
 */
export interface ThemeEntry {
  /** Stable id: what config.toml and state.json store. */
  name: string
  /** One line for the picker, saying what the palette is for. */
  about: string
  build(): Theme
}

export const BUILTIN_THEMES: readonly ThemeEntry[] = [
  {
    name: 'gruvbox-dark',
    about: 'warm, low-contrast dark — the original',
    build: gruvboxDark,
  },
  {
    name: 'gruvbox-light',
    about: 'the same palette on paper, for bright rooms',
    build: gruvboxLight,
  },
  {
    name: 'vesper',
    about: 'near-monochrome dark, orange and mint accents',
    build: vesper,
  },
]

export const DEFAULT_THEME_NAME = 'gruvbox-dark'

/** themeByName returns undefined for an unknown name — callers fall back. */
export function themeByName(name: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.name === name)?.build()
}

/**
 * The parts of a palette config.toml is allowed to override.
 *
 * Kept as a separate value rather than folded into the resolved Theme because
 * the theme can change at runtime (the `t` picker) and the overrides have to
 * survive that: they are the user's explicit instruction, so they are re-applied
 * on top of whichever base palette is active rather than being a snapshot of the
 * one that happened to be loaded at startup.
 */
export interface ThemeOverrides {
  colors: Partial<Record<ColorKey, string>>
  syntax: Record<string, string>
  syntaxHighlight?: boolean
}

export function emptyOverrides(): ThemeOverrides {
  return { colors: {}, syntax: {} }
}

/**
 * resolveTheme builds the live palette: a built-in base with the config's own
 * keys stamped on top. An unknown name falls back to the default rather than
 * failing — a typo in config.toml or a state.json written by a newer build
 * should cost the theme, not the session.
 */
export function resolveTheme(name: string, overrides: ThemeOverrides): Theme {
  const base = themeByName(name) ?? defaultTheme()
  const theme: Theme = { ...base, syntax: { ...base.syntax } }
  for (const [key, value] of Object.entries(overrides.colors)) {
    if (value) theme[key as ColorKey] = value
  }
  for (const [group, color] of Object.entries(overrides.syntax)) {
    if (color) theme.syntax[group] = color
  }
  if (typeof overrides.syntaxHighlight === 'boolean') {
    theme.syntaxHighlight = overrides.syntaxHighlight
  }
  return theme
}

export function defaultTheme(): Theme {
  return gruvboxDark()
}

function gruvboxDark(): Theme {
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

    thread: '#4c2b3d', // dark plum — a background
    threadLabel: '#fbf1c7', // fg0
    threadMarker: '#d3869b', // bright purple — same hue, readable as a foreground

    treeGuide: '#665c54', // bg3
    cursorBg: '#3c3836', // bg1 — the classic gruvbox cursorline
    background: '#282828', // bg0

    syntaxHighlight: true,
    syntax: defaultSyntax(),
  }
}

/**
 * Gruvbox Light. The same palette gruvbox publishes for a paper background: the
 * FADED variants of each hue, which are the only ones that survive dark text on
 * light — the bright accents the dark theme uses wash out completely up here.
 *
 * The diff washes are the one place this is not a straight transposition. A dark
 * theme tints toward its hue by ADDING light, and doing the mirror image (tinting
 * toward black) makes an added line read as a shadow. They are near-white tints
 * of the same green/red/blue instead, light enough that the faded syntax colors
 * still read on top of them.
 */
function gruvboxLight(): Theme {
  return {
    primary: '#af3a03', // faded orange
    accent: '#b57614', // faded yellow
    focus: '#427b58', // faded aqua
    muted: '#7c6f64', // fg4 — dark enough to read on bg0
    foreground: '#3c3836', // fg1

    addBg: '#dfe9c0',
    delBg: '#f4d5cd',
    addFg: '#79740e', // faded green
    delFg: '#9d0006', // faded red
    stagedBg: '#d3e2e8',
    stagedFg: '#076678', // faded blue

    thread: '#ebd3e0', // pale plum — still a background
    threadLabel: '#282828', // fg0: dark label on a light cue
    threadMarker: '#8f3f71', // faded purple

    treeGuide: '#bdae93', // bg3
    cursorBg: '#ebdbb2', // bg1 — the light cursorline
    background: '#fbf1c7', // bg0

    syntaxHighlight: true,
    syntax: buildSyntax({
      keyword: '#9d0006', // red
      func: '#79740e', // green
      string: '#79740e',
      number: '#8f3f71', // purple
      type: '#b57614', // yellow
      variable: '#3c3836', // fg1
      tag: '#427b58', // aqua
      link: '#076678', // blue
      brand: '#af3a03', // orange
      punctuation: '#7c6f64', // fg4
      comment: '#928374', // gray
    }),
  }
}

/**
 * Vesper. A near-monochrome dark theme: structure comes from white-on-black and
 * only two accents are ever spent — warm orange and mint.
 *
 * Which means it deliberately does NOT color keywords. That is the whole idea of
 * the palette, and it is worth saying out loud here because a later pass looking
 * only at the syntax map would read the gray keywords as an omission and "fix"
 * them into red.
 */
function vesper(): Theme {
  return {
    primary: '#ffc799', // orange
    accent: '#99ffe4', // mint
    focus: '#ffffff', // plain white: in this palette, "active" is full contrast
    muted: '#8b8b8b',
    foreground: '#ffffff',

    addBg: '#12251f',
    delBg: '#2a1618',
    addFg: '#99ffe4', // mint stands in for green
    delFg: '#ff8080',
    stagedBg: '#26201b',
    stagedFg: '#ffc799', // orange stands in for blue

    thread: '#3a2a3a',
    threadLabel: '#ffffff',
    threadMarker: '#ff8080',

    treeGuide: '#3a3a3a',
    cursorBg: '#2a2a2a',
    background: '#101010',

    syntaxHighlight: true,
    syntax: buildSyntax({
      keyword: '#a0a0a0', // gray on purpose — see above
      func: '#ffc799',
      string: '#99ffe4',
      number: '#ffc799',
      type: '#ffc799',
      variable: '#ffffff',
      tag: '#ffc799',
      link: '#a0a0a0',
      brand: '#ffc799',
      punctuation: '#8b8b8b',
      comment: '#8b8b8b',
    }),
  }
}

/**
 * The eleven colors a syntax map is actually made of.
 *
 * Every theme fills the same roles and `buildSyntax` expands them into the full
 * capture-group table, so a new palette cannot ship half a map — which is the
 * failure this shape exists to prevent: the `markup.*` groups were missing
 * entirely once already, and markdown rendered bare for it.
 */
interface SyntaxRoles {
  keyword: string
  func: string
  string: string
  number: string
  type: string
  variable: string
  tag: string
  /** Links and other "points elsewhere" text. */
  link: string
  /** The theme's own primary — used for bold prose, which has no bold attribute. */
  brand: string
  punctuation: string
  comment: string
}

/**
 * Capture group → color. Only the roots are listed; dotted children inherit
 * (see Theme.syntax). The assignments follow gruvbox.nvim's.
 */
function buildSyntax(c: SyntaxRoles): Record<string, string> {
  return {
    keyword: c.keyword,
    conditional: c.keyword,
    repeat: c.keyword,
    label: c.keyword,
    exception: c.keyword,

    function: c.func,
    string: c.string,
    character: c.string,

    number: c.number,
    boolean: c.number,
    float: c.number,
    constant: c.number,

    type: c.type,
    constructor: c.type,
    attribute: c.type,
    annotation: c.type,

    variable: c.variable,
    property: c.variable,
    parameter: c.variable,
    field: c.variable,
    namespace: c.variable,
    module: c.variable,
    operator: c.variable,

    tag: c.tag,
    include: c.tag,
    preproc: c.tag,

    punctuation: c.punctuation, // present but recessive
    comment: c.comment,
    text: c.variable,

    // Prose, i.e. what markdown emits. These used to be listed under the names
    // the Go original used — `title`, `emphasis`, `literal`, `reference`, `uri`
    // — which no tree-sitter grammar has ever emitted, so every markdown capture
    // fell through to no color and the file rendered bare. The colors are the
    // old intent, moved onto the group names the parser actually produces.
    markup: c.variable,
    'markup.heading': c.type, // like a type name — the structure
    'markup.strong': c.brand, // no bold available, so it needs a color
    'markup.italic': c.number, // for the same reason
    'markup.raw': c.string, // a code span IS a string
    'markup.link': c.link,
    'markup.link.label': c.tag, // the words you read
    'markup.list': c.punctuation, // bullets are punctuation
    'markup.quote': c.comment,
    'markup.strikethrough': c.comment,
  }
}

/**
 * Gruvbox Dark's capture-group table, kept as the exported default because
 * config.ts merges `[syntax]` over it.
 */
export function defaultSyntax(): Record<string, string> {
  return buildSyntax({
    keyword: '#fb4934', // red
    func: '#b8bb26', // green
    string: '#b8bb26',
    number: '#d3869b', // purple
    type: '#fabd2f', // yellow
    variable: '#ebdbb2', // fg1
    tag: '#8ec07c', // aqua
    link: '#83a598', // blue
    brand: '#fe8019', // orange
    punctuation: '#a89984', // fg4
    comment: '#928374', // gray
  })
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
export const THEME_KEY_MAP: Record<string, ColorKey> = {
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
  thread: 'thread',
  thread_label: 'threadLabel',
  thread_marker: 'threadMarker',
  tree_guide: 'treeGuide',
  cursor_bg: 'cursorBg',
  background: 'background',
}

/** The Theme fields that hold a single color string. */
export type ColorKey = Exclude<keyof Theme, 'syntax' | 'syntaxHighlight'>
