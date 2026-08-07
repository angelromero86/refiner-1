/**
 * Normalizes OpenTUI key events into the compact strings the original
 * bubbletea implementation switched on ("up", "shift+down", "ctrl+u",
 * "alt+enter", " ", "G").
 *
 * Doing the translation once here means every key-handling switch in the app is
 * a verbatim port of the Go original, and the terminal-specific quirks live in
 * exactly one place. The name/modifier mappings below were verified against
 * OpenTUI's own parser with real escape sequences rather than assumed.
 */

import type { ParsedKey } from '@opentui/core'

/** OpenTUI's key names → the names the handlers expect. */
const NAME_ALIASES: Record<string, string> = {
  return: 'enter',
  linefeed: 'enter',
  escape: 'esc',
  space: ' ',
  pageup: 'pgup',
  pagedown: 'pgdown',
}

/**
 * Keys where Shift is reported as a modifier rather than folded into the
 * character. For letters, Shift means "uppercase" instead (so shift+g is "G",
 * matching what the tree/content handlers expect for `G` = jump to end).
 */
const SHIFTABLE = new Set([
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pgup',
  'pgdown',
  'tab',
  'enter',
])

export function keyString(key: ParsedKey): string {
  const raw = key.name ?? ''
  const base = NAME_ALIASES[raw] ?? raw
  if (base === '') return ''

  const isSingleChar = [...base].length === 1 && base !== ' '
  let out = base

  if (key.shift) {
    if (isSingleChar) out = base.toUpperCase()
    else if (SHIFTABLE.has(base)) out = `shift+${base}`
  }

  // `meta` is Alt on most terminals; `option` is the macOS spelling of the
  // same physical key. Treat them alike so alt+enter works either way.
  if (key.meta || key.option) out = `alt+${out}`
  if (key.ctrl) out = `ctrl+${out}`
  return out
}
