/**
 * The theme, resolved into ready-to-use chunk styles.
 *
 * The Go original leaned on lipgloss, where a style renders a string into ANSI
 * and nested styles need the outer background re-applied by hand. Here a "style"
 * is just a set of fields stamped onto a TextChunk, and OpenTUI composites cells
 * directly — so the background of a segment is simply the background of those
 * cells. That removes a whole class of bug (an inner reset swallowing the outer
 * bg), but the segmentation is unchanged: every row is still built as
 * marker + gutter + content + pad so each part can carry its own colors.
 */

import { RGBA, createTextAttributes, type TextChunk } from '@opentui/core'
import { defaultTheme, type Theme } from './theme.ts'
import type { Status } from './git.ts'

export interface Style {
  fg?: RGBA
  bg?: RGBA
  bold?: boolean
  underline?: boolean
}

/** chunk stamps a style onto a piece of text. */
export function chunk(text: string, style?: Style): TextChunk {
  const attributes =
    style?.bold || style?.underline
      ? createTextAttributes({ bold: style.bold, underline: style.underline })
      : undefined
  return {
    __isChunk: true,
    text,
    ...(style?.fg ? { fg: style.fg } : {}),
    ...(style?.bg ? { bg: style.bg } : {}),
    ...(attributes ? { attributes } : {}),
  }
}

/** Derive a variant of `style` with a background forced on. */
export function withBg(style: Style, bg: RGBA): Style {
  return { ...style, bg }
}

/**
 * The segment styles for one row under the cursor / inside a selection. All
 * variants share the cursor background so the selection color prevails over
 * add/del/staged backgrounds; only the foreground reflects the line's kind.
 */
export interface CursorRowStyles {
  marker: Style
  gutter: Style
  content: Style
  pad: Style
}

export interface Palette {
  primary: RGBA
  accent: RGBA
  focus: RGBA
  muted: RGBA
  foreground: RGBA

  addBg: RGBA
  delBg: RGBA
  addFg: RGBA
  delFg: RGBA
  stagedBg: RGBA
  stagedFg: RGBA
  commentBg: RGBA
  commentLabel: RGBA
  cursorBg: RGBA
  background: RGBA
}

export interface Styles {
  palette: Palette

  appName: Style
  dim: Style
  mode: Style
  hotkey: Style
  text: Style

  add: Style
  del: Style
  hunk: Style

  gutter: Style
  addGutter: Style
  delGutter: Style
  addContent: Style
  addPad: Style
  delContent: Style
  delPad: Style
  stagedGutter: Style
  stagedContent: Style
  stagedPad: Style
  /**
   * Gutter on commented lines. Overrides cursor/kind backgrounds on the gutter
   * only — the content area keeps its own styling — so the comment cue stays
   * visible even when the row is highlighted or selected.
   */
  commentGutter: Style

  statusM: Style
  statusA: Style
  statusD: Style
  statusR: Style
  statusUntracked: Style

  dir: Style
  dirStaged: Style
  fileStaged: Style
  /** Paints the `●` beside files that have at least one thread. */
  marker: Style
  treeGuide: Style

  addCursorRow: CursorRowStyles
  delCursorRow: CursorRowStyles
  stagedCursorRow: CursorRowStyles
  ctxCursorRow: CursorRowStyles

  /** Whether diff content should be syntax-colored at all. */
  syntaxHighlight: boolean
}

/**
 * The live style set. Mutated in place by applyTheme so every module that
 * imported it sees the new colors — the same shape the Go package-level style
 * vars had.
 */
export const S: Styles = buildStyles(defaultTheme())

export function applyTheme(t: Theme): void {
  Object.assign(S, buildStyles(t))
  syntaxColors = resolveSyntax(t.syntax)
  syntaxCache.clear()
}

/** Resolved capture-group colors, and the memo for dotted-fallback lookups. */
let syntaxColors = resolveSyntax(defaultTheme().syntax)
const syntaxCache = new Map<string, RGBA | undefined>()

function resolveSyntax(spec: Record<string, string>): Map<string, RGBA> {
  const out = new Map<string, RGBA>()
  for (const [group, hex] of Object.entries(spec)) {
    try {
      out.set(group, RGBA.fromHex(hex))
    } catch {
      // A bad color in the config shouldn't take the whole palette down.
    }
  }
  return out
}

/**
 * syntaxColor resolves a tree-sitter capture group to a color, walking back along
 * dots: `keyword.function.builtin` tries the full name, then `keyword.function`,
 * then `keyword`. Returns undefined when nothing matches, which leaves the row's
 * own diff color in place.
 */
export function syntaxColor(group: string): RGBA | undefined {
  const hit = syntaxCache.get(group)
  if (hit !== undefined || syntaxCache.has(group)) return hit
  let name = group
  let found: RGBA | undefined
  for (;;) {
    const c = syntaxColors.get(name)
    if (c) {
      found = c
      break
    }
    const dot = name.lastIndexOf('.')
    if (dot < 0) break
    name = name.slice(0, dot)
  }
  syntaxCache.set(group, found)
  return found
}

function buildStyles(t: Theme): Styles {
  const primary = RGBA.fromHex(t.primary)
  const accent = RGBA.fromHex(t.accent)
  const focus = RGBA.fromHex(t.focus)
  const muted = RGBA.fromHex(t.muted)
  const foreground = RGBA.fromHex(t.foreground)

  const addBg = RGBA.fromHex(t.addBg)
  const delBg = RGBA.fromHex(t.delBg)
  const addFg = RGBA.fromHex(t.addFg)
  const delFg = RGBA.fromHex(t.delFg)
  const stagedBg = RGBA.fromHex(t.stagedBg)
  const stagedFg = RGBA.fromHex(t.stagedFg)
  const commentBg = RGBA.fromHex(t.comment)
  const commentLabel = RGBA.fromHex(t.commentLabel)
  const cursorBg = RGBA.fromHex(t.cursorBg)
  const background = RGBA.fromHex(t.background)

  // Cursor row variants per line kind. The bg is always cursorBg so the
  // selection color wins; the fg keeps the kind's vivid color so you can still
  // tell whether a selected line is add/del/staged.
  const buildCursor = (fg: RGBA): CursorRowStyles => ({
    marker: { bg: cursorBg, fg: accent, bold: true },
    gutter: { bg: cursorBg, fg },
    content: { bg: cursorBg, fg },
    pad: { bg: cursorBg },
  })

  return {
    palette: {
      primary,
      accent,
      focus,
      muted,
      foreground,
      addBg,
      delBg,
      addFg,
      delFg,
      stagedBg,
      stagedFg,
      commentBg,
      commentLabel,
      cursorBg,
      background,
    },

    appName: { fg: primary, bold: true },
    dim: { fg: muted },
    mode: { fg: focus },
    hotkey: { fg: accent },
    // The explicit default-text style. Used everywhere that would otherwise
    // inherit the terminal's own foreground.
    text: { fg: foreground },

    // add/del reuse the diff-hunk foregrounds so the "+ / -" concept has a
    // single source of truth. They also drive the A / D tree badges and the
    // error banner.
    add: { fg: addFg },
    del: { fg: delFg },
    hunk: { fg: focus, bold: true },

    gutter: { fg: muted },
    addGutter: { bg: addBg, fg: addFg },
    delGutter: { bg: delBg, fg: delFg },
    addContent: { bg: addBg, fg: addFg },
    addPad: { bg: addBg },
    delContent: { bg: delBg, fg: delFg },
    delPad: { bg: delBg },
    stagedGutter: { bg: stagedBg, fg: stagedFg },
    stagedContent: { bg: stagedBg, fg: stagedFg },
    stagedPad: { bg: stagedBg },
    commentGutter: { bg: commentBg, fg: commentLabel },

    // A/D reuse the diff hunk fgs so a freshly-added file in the tree matches
    // its `+` lines in the diff. `?` reuses primary — "this is a brand-new
    // file, look at it" lines up with the brand color.
    statusM: { fg: accent, bold: true },
    statusA: { fg: addFg, bold: true },
    statusD: { fg: delFg, bold: true },
    statusR: { fg: focus, bold: true },
    statusUntracked: { fg: primary, bold: true },

    // Folders share the footer's accent + bold so they pop out of the dim tree
    // scaffolding. Fully-staged folders flip to the staged blue.
    dir: { fg: accent, bold: true },
    dirStaged: { fg: stagedFg, bold: true },
    fileStaged: { fg: stagedFg },
    marker: { fg: commentBg },
    // Guide lines (│ ├ └) use the soft cursor color so they read as tree
    // structure without competing with file names.
    treeGuide: { fg: cursorBg },

    syntaxHighlight: t.syntaxHighlight,

    addCursorRow: buildCursor(addFg),
    delCursorRow: buildCursor(delFg),
    stagedCursorRow: buildCursor(stagedFg),
    ctxCursorRow: {
      marker: { bg: cursorBg, fg: accent, bold: true },
      gutter: { bg: cursorBg, fg: muted },
      content: { bg: cursorBg, fg: foreground },
      pad: { bg: cursorBg },
    },
  }
}

/** statusStyle maps a git status code to its badge style in the tree. */
export function statusStyle(s: Status): Style {
  switch (s) {
    case 'M':
      return S.statusM
    case 'A':
      return S.statusA
    case 'D':
      return S.statusD
    case 'R':
    case 'C':
      return S.statusR
    case '?':
      return S.statusUntracked
    default:
      return {}
  }
}
