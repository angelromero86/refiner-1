/**
 * The editor command is assembled from config + the cursor's line, and a wrong
 * argument order means `e` either opens the wrong place or fails outright. These
 * pin the two conventions and the fallback chain.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editorArgv, loadConfig, type EditorConfig } from '../src/config.ts'

let dir = ''
let cfg = ''
const saved = { VISUAL: process.env['VISUAL'], EDITOR: process.env['EDITOR'] }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-cfg-'))
  cfg = join(dir, 'config.toml')
  delete process.env['VISUAL']
  delete process.env['EDITOR']
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  if (saved.VISUAL === undefined) delete process.env['VISUAL']
  else process.env['VISUAL'] = saved.VISUAL
  if (saved.EDITOR === undefined) delete process.env['EDITOR']
  else process.env['EDITOR'] = saved.EDITOR
})

const ed = (command: string[], lineStyle: EditorConfig['lineStyle']): EditorConfig => ({
  command,
  lineStyle,
})

test('plus style puts the line before the file (vi convention)', () => {
  expect(editorArgv(ed(['nvim'], 'plus'), 'src/a.ts', 42)).toEqual(['nvim', '+42', 'src/a.ts'])
})

test('suffix style appends the line to the path', () => {
  expect(editorArgv(ed(['druk'], 'suffix'), 'src/a.ts', 42)).toEqual(['druk', 'src/a.ts:42'])
})

test('line 0 opens the file plainly', () => {
  // A cursor parked on a deleted line has no working-tree position.
  expect(editorArgv(ed(['nvim'], 'plus'), 'src/a.ts', 0)).toEqual(['nvim', 'src/a.ts'])
  expect(editorArgv(ed(['druk'], 'suffix'), 'src/a.ts', 0)).toEqual(['druk', 'src/a.ts'])
})

test('"none" never passes a line', () => {
  expect(editorArgv(ed(['ed'], 'none'), 'a.ts', 9)).toEqual(['ed', 'a.ts'])
})

test('extra editor args are preserved before the file', () => {
  expect(editorArgv(ed(['code', '-w', '-g'], 'suffix'), 'a.ts', 7)).toEqual([
    'code',
    '-w',
    '-g',
    'a.ts:7',
  ])
})

test('missing config falls back to $VISUAL, then $EDITOR, then nvim', async () => {
  expect((await loadConfig(cfg)).editor.command).toEqual(['nvim'])

  process.env['EDITOR'] = 'nano'
  expect((await loadConfig(cfg)).editor.command).toEqual(['nano'])

  process.env['VISUAL'] = 'helix'
  expect((await loadConfig(cfg)).editor.command).toEqual(['helix'])
})

test('config editor wins over the environment and is split into argv', async () => {
  process.env['EDITOR'] = 'nano'
  await Bun.write(cfg, 'editor = "code -w"\n')
  const c = await loadConfig(cfg)
  expect(c.editor.command).toEqual(['code', '-w'])
  // Style comes from the binary name, not the whole string.
  expect(c.editor.lineStyle).toBe('suffix')
})

test('line style is detected from the editor basename, path and all', async () => {
  await Bun.write(cfg, 'editor = "/opt/homebrew/bin/druk"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('suffix')

  await Bun.write(cfg, 'editor = "/usr/bin/vim"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('plus')
})

test('an unknown editor defaults to the plus convention', async () => {
  await Bun.write(cfg, 'editor = "some-editor"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('plus')
})

test('editor_line overrides the detected style', async () => {
  await Bun.write(cfg, 'editor = "nvim"\neditor_line = "suffix"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('suffix')

  await Bun.write(cfg, 'editor = "druk"\neditor_line = "none"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('none')

  // Garbage falls back to detection rather than breaking the key.
  await Bun.write(cfg, 'editor = "druk"\neditor_line = "sideways"\n')
  expect((await loadConfig(cfg)).editor.lineStyle).toBe('suffix')
})

test('theme and editor come from the same file, and a bad file warns', async () => {
  await Bun.write(cfg, 'primary = "#ff0000"\neditor = "druk"\n')
  const c = await loadConfig(cfg)
  expect(c.theme.primary).toBe('#ff0000')
  expect(c.editor.command).toEqual(['druk'])
  expect(c.warning).toBeUndefined()

  await Bun.write(cfg, 'this is not = = toml')
  const bad = await loadConfig(cfg)
  expect(bad.warning).toContain('decoding')
  // Defaults survive a broken file.
  expect(bad.theme.primary).toBe('#fe8019')
})

test('[syntax] merges over the defaults instead of replacing them', async () => {
  await Bun.write(cfg, '[syntax]\nkeyword = "#000000"\n')
  const c = await loadConfig(cfg)
  expect(c.theme.syntax['keyword']).toBe('#000000')
  // Untouched groups are still there.
  expect(c.theme.syntax['string']).toBe('#b8bb26')
})

test('popup size defaults to 90% and is clamped to something usable', async () => {
  expect((await loadConfig(cfg)).popup).toEqual({ widthPct: 90, heightPct: 90 })

  await Bun.write(cfg, 'popup_width = 100\npopup_height = 75\n')
  expect((await loadConfig(cfg)).popup).toEqual({ widthPct: 100, heightPct: 75 })

  // Nothing usable below 20%, and tmux rejects anything over 100.
  await Bun.write(cfg, 'popup_width = 5\npopup_height = 400\n')
  expect((await loadConfig(cfg)).popup).toEqual({ widthPct: 20, heightPct: 100 })

  // A non-number falls back rather than producing NaN% on the command line.
  await Bun.write(cfg, 'popup_width = "big"\n')
  expect((await loadConfig(cfg)).popup.widthPct).toBe(90)
})
