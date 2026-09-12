/**
 * The key normalizer is the seam between OpenTUI and every key handler in the
 * app, so it is pinned against OpenTUI's real parser fed real escape sequences —
 * not against hand-written ParsedKey literals, which would only test my
 * assumptions about what the terminal sends.
 */
import { expect, test } from 'bun:test'
import { parseKeypress } from '@opentui/core'
import { keyString } from '../src/keys.ts'

const cases: [string, string][] = [
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1b[1;2A', 'shift+up'],
  ['\x1b[1;2B', 'shift+down'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\x1b', 'esc'],
  ['\t', 'tab'],
  [' ', ' '],
  ['a', 'a'],
  ['q', 'q'],
  ['G', 'G'],
  ['D', 'D'],
  ['N', 'N'],
  ['n', 'n'],
  ['x', 'x'],
  ['z', 'z'],
  ['r', 'r'],
  ['e', 'e'],
  ['y', 'y'],
  ['\x03', 'ctrl+c'],
  ['\x15', 'ctrl+u'],
  ['\x04', 'ctrl+d'],
  ['\x13', 'ctrl+s'],
  ['\x10', 'ctrl+p'],
  ['\x0e', 'ctrl+n'],
  ['\x1b\r', 'alt+enter'],
  ['\x1bs', 'alt+s'],
  ['\x1b[5~', 'pgup'],
  ['\x1b[6~', 'pgdown'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
]

/** parseKeypress returns null for input it can't classify — never for these. */
function parsed(seq: string) {
  const k = parseKeypress(seq)
  if (!k) throw new Error(`opentui failed to parse ${JSON.stringify(seq)}`)
  return k
}

test.each(cases)('%j → %s', (seq, want) => {
  expect(keyString(parsed(seq))).toBe(want)
})

test('every key the app binds is reachable', () => {
  // Guards against a normalizer change silently orphaning a binding.
  const produced = new Set(cases.map(([seq]) => keyString(parsed(seq))))
  const bound = [
    'up',
    'down',
    'left',
    'right',
    'shift+up',
    'shift+down',
    'enter',
    'esc',
    'tab',
    ' ',
    'ctrl+c',
    'ctrl+u',
    'ctrl+d',
    'ctrl+s',
    'ctrl+p',
    'ctrl+n',
    'alt+enter',
    'alt+s',
    'pgup',
    'pgdown',
    'home',
    'end',
    'G',
    'D',
    'N',
    'n',
    'x',
    'z',
    'r',
    'e',
    'y',
  ]
  for (const b of bound) expect(produced, `binding ${b}`).toContain(b)
})
