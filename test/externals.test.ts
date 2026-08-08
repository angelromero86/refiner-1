/**
 * Popup geometry.
 *
 * Neither tmux nor zellij centres a floating window once you give it an explicit
 * size — they place it at their own default origin and clip the overflow, so the
 * window lands bottom-right and comes out smaller than requested. The origin has to
 * be passed explicitly, and that arithmetic is exactly the kind of thing that
 * regresses silently, so it's pinned here.
 */
import { expect, test } from 'bun:test'
import { editorInvocation, tmuxPopupArgs, zellijFloatingArgs } from '../src/externals.ts'
import type { EditorConfig } from '../src/config.ts'

/** Read an option's value out of an argv list. */
function opt(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

test('tmux popup is centred with the requested size', () => {
  const argv = tmuxPopupArgs({ widthPct: 90, heightPct: 90 }, 'src/app.ts:42')
  expect(argv[0]).toBe('display-popup')
  expect(opt(argv, '-x')).toBe('C')
  expect(opt(argv, '-y')).toBe('C')
  expect(opt(argv, '-w')).toBe('90%')
  expect(opt(argv, '-h')).toBe('90%')
  expect(opt(argv, '-T')).toBe(' src/app.ts:42 ')
  // Closes itself when the editor exits, or the pane would linger.
  expect(argv).toContain('-E')
})

test('zellij floating pane is centred with the requested size', () => {
  const argv = zellijFloatingArgs({ widthPct: 90, heightPct: 90 }, 'lazygit')
  expect(argv[0]).toBe('run')
  expect(argv).toContain('--floating')
  expect(argv).toContain('--close-on-exit')
  // 90% wide leaves 10% of slack: half on each side.
  expect(opt(argv, '--x')).toBe('5%')
  expect(opt(argv, '--y')).toBe('5%')
  expect(opt(argv, '--width')).toBe('90%')
  expect(opt(argv, '--height')).toBe('90%')
  // `--` must come last so the command's own flags aren't eaten by zellij.
  expect(argv[argv.length - 1]).toBe('--')
})

test('the centring offset tracks whatever size is configured', () => {
  for (const [pct, want] of [
    [100, '0%'],
    [90, '5%'],
    [80, '10%'],
    [50, '25%'],
    [20, '40%'],
  ] as const) {
    const argv = zellijFloatingArgs({ widthPct: pct, heightPct: pct }, 't')
    expect(opt(argv, '--x'), `width ${pct}%`).toBe(want)
    expect(opt(argv, '--y'), `height ${pct}%`).toBe(want)
  }
})

test('an odd size still yields an integer offset zellij will accept', () => {
  // zellij takes a bare integer or an integer percentage — "7.5%" is not valid.
  const argv = zellijFloatingArgs({ widthPct: 85, heightPct: 75 }, 't')
  expect(opt(argv, '--x')).toBe('8%')
  expect(opt(argv, '--y')).toBe('13%')
  for (const flag of ['--x', '--y']) {
    expect(opt(argv, flag)).toMatch(/^\d+%$/)
  }
})

test('width and height are centred independently', () => {
  const argv = zellijFloatingArgs({ widthPct: 100, heightPct: 50 }, 't')
  expect(opt(argv, '--x')).toBe('0%')
  expect(opt(argv, '--y')).toBe('25%')
})

/**
 * The editor is the one place a path leaves the process into something that does
 * NOT inherit our cwd: under tmux and zellij the multiplexer's server spawns it,
 * from whatever directory it feels like. So the argv must be absolute even though
 * every path inside refiner is root-relative.
 */
test('the editor gets an absolute path but a repo-relative title', () => {
  const editor: EditorConfig = { command: ['nvim'], lineStyle: 'plus' }
  const { argv, title } = editorInvocation(editor, '/repo/root', 'src/app.ts', 42)
  expect(argv).toEqual(['nvim', '+42', '/repo/root/src/app.ts'])
  // Relative on purpose: an absolute path in a popup border eats the whole width.
  expect(title).toBe('src/app.ts:42')
})

test('the suffix line style keeps the line number after the absolute path', () => {
  const editor: EditorConfig = { command: ['code', '-g'], lineStyle: 'suffix' }
  const { argv, title } = editorInvocation(editor, '/repo/root', 'src/app.ts', 42)
  expect(argv.at(-1)).toBe('/repo/root/src/app.ts:42')
  expect(title).toBe('src/app.ts:42')
})

test('a deleted line has no working-tree position, so no line argument', () => {
  const editor: EditorConfig = { command: ['nvim'], lineStyle: 'plus' }
  const { argv, title } = editorInvocation(editor, '/repo/root', 'src/app.ts', 0)
  expect(argv).toEqual(['nvim', '/repo/root/src/app.ts'])
  expect(title).toBe('src/app.ts')
})
