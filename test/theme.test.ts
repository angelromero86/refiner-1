/**
 * The built-in palettes and how one gets chosen.
 *
 * Two things are pinned here. A theme is a WHOLE palette — a missing color key
 * would fall back to whatever the interface's default happened to be and paint
 * one element from the wrong theme, and a short syntax table is exactly the bug
 * that left markdown rendering bare. And the precedence between state.json (the
 * `t` picker) and config.toml (hand-edited), which is invisible until it is
 * wrong: a theme that "won't change" or one that silently ignores the config
 * file are the same bug seen from two sides.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import { loadConfig } from '../src/config.ts'
import { Mode, type Source } from '../src/git.ts'
import { KEYMAP } from '../src/keymap.ts'
import { loadState, saveState, statePath } from '../src/state.ts'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_NAME,
  defaultTheme,
  emptyOverrides,
  resolveTheme,
  themeByName,
  type ColorKey,
  type Theme,
} from '../src/theme.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

let dir = ''
const savedXdg = process.env['XDG_CONFIG_HOME']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-theme-'))
  // Keeps chooseTheme's state.json write off the real user config dir.
  process.env['XDG_CONFIG_HOME'] = dir
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = savedXdg
})

const COLOR_KEYS = Object.keys(defaultTheme()).filter(
  (k) => k !== 'syntax' && k !== 'syntaxHighlight',
) as ColorKey[]

async function makeApp(): Promise<App> {
  return new App(SOURCE, await Store.load(join(dir, '.refiner', 'comments.json')))
}

test('the picker offers the three palettes, default first', () => {
  expect(BUILTIN_THEMES.map((t) => t.name)).toEqual([
    'gruvbox-dark',
    'gruvbox-light',
    'vesper',
  ])
  expect(DEFAULT_THEME_NAME).toBe('gruvbox-dark')
  expect(themeByName(DEFAULT_THEME_NAME)).toEqual(defaultTheme())
})

test('every built-in fills every color key with a real hex', () => {
  for (const entry of BUILTIN_THEMES) {
    const t = entry.build()
    for (const key of COLOR_KEYS) {
      expect(`${entry.name}.${key}=${t[key]}`).toMatch(/=#[0-9a-f]{6}$/)
    }
    expect(entry.about).not.toBe('')
  }
})

test('every built-in carries the whole syntax table, markup included', () => {
  const groups = Object.keys(defaultTheme().syntax).sort()
  expect(groups).toContain('markup.heading')
  for (const entry of BUILTIN_THEMES) {
    expect(Object.keys(entry.build().syntax).sort()).toEqual(groups)
  }
})

test('the light theme is actually light, the dark ones dark', () => {
  // Cheap luminance proxy: a theme whose background is brighter than its
  // foreground is a light theme. Catches a palette pasted from the wrong side.
  const brightness = (hex: string): number =>
    parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
  for (const entry of BUILTIN_THEMES) {
    const t = entry.build()
    const light = entry.name.endsWith('-light')
    expect(brightness(t.background) > brightness(t.foreground)).toBe(light)
  }
})

test('config overrides stamp on top of whichever base is active', () => {
  const overrides = { ...emptyOverrides(), colors: { focus: '#ff0000' } as Partial<
    Record<ColorKey, string>
  > }
  const vesper = resolveTheme('vesper', overrides)
  expect(vesper.focus).toBe('#ff0000')
  // Untouched keys still come from the base, not from the default theme.
  expect(vesper.background).toBe(themeByName('vesper')!.background)
})

test('an unknown theme name resolves to the default instead of failing', () => {
  expect(resolveTheme('solarized-mango', emptyOverrides())).toEqual(defaultTheme())
})

test('resolveTheme never mutates the built-in it started from', () => {
  const before: Theme = themeByName('vesper')!
  resolveTheme('vesper', {
    colors: { background: '#123456' },
    syntax: { keyword: '#123456' },
  })
  expect(themeByName('vesper')).toEqual(before)
})

test('config.toml picks the base palette and keeps overriding single colors', async () => {
  const path = join(dir, 'config.toml')
  await Bun.write(path, 'theme = "gruvbox-light"\nfocus = "#ff00ff"\n[syntax]\nkeyword = "#010203"\n')
  const cfg = await loadConfig(path)
  expect(cfg.themeName).toBe('gruvbox-light')
  expect(cfg.theme.background).toBe(themeByName('gruvbox-light')!.background)
  expect(cfg.theme.focus).toBe('#ff00ff')
  expect(cfg.theme.syntax['keyword']).toBe('#010203')
  // The overrides survive separately, so switching themes at runtime re-applies them.
  expect(cfg.themeOverrides.colors.focus).toBe('#ff00ff')
})

test('an unknown name in config.toml falls back without losing the rest of the file', async () => {
  const path = join(dir, 'config.toml')
  await Bun.write(path, 'theme = "nope"\neditor = "code -w"\n')
  const cfg = await loadConfig(path)
  expect(cfg.themeName).toBe(DEFAULT_THEME_NAME)
  expect(cfg.editor.command).toEqual(['code', '-w'])
})

test("the picker's choice outranks config.toml", async () => {
  await saveState({ treeAutoHide: false, treeWidthPct: 35, themeName: 'vesper' })
  const app = await App.create(SOURCE)
  app.initTheme('gruvbox-light', emptyOverrides())
  expect(app.themeName).toBe('vesper')
})

test('config.toml still decides while the picker has never run', async () => {
  const app = await App.create(SOURCE)
  app.initTheme('vesper', emptyOverrides())
  expect(app.themeName).toBe('vesper')
  // Nothing was chosen, so nothing was written — the file keeps deciding.
  expect((await loadState()).themeName).toBe('')
})

test('choosing writes state.json; previewing does not', async () => {
  const app = await makeApp()
  app.setTheme('vesper')
  expect(app.themeName).toBe('vesper')
  expect(await Bun.file(statePath()).exists()).toBe(false)

  app.chooseTheme('gruvbox-light')
  await Bun.sleep(20)
  expect((await loadState()).themeName).toBe('gruvbox-light')
})

test('other preferences never latch a theme the user did not pick', async () => {
  const app = await makeApp()
  app.initTheme('vesper', emptyOverrides())
  app.treeAutoHide = true
  app.persistState()
  await Bun.sleep(20)
  // vesper came from config.toml; writing it here would shadow the file forever.
  expect((await loadState()).themeName).toBe('')
  expect((await loadState()).treeAutoHide).toBe(true)
})

test('a theme dropped by a later build degrades to the default', async () => {
  await saveState({ treeAutoHide: false, treeWidthPct: 35, themeName: 'gone' })
  const app = await App.create(SOURCE)
  app.initTheme('also-gone', emptyOverrides())
  expect(app.themeName).toBe(DEFAULT_THEME_NAME)
})

test('themeIndex points the picker at the palette in force', async () => {
  const app = await makeApp()
  app.setTheme('vesper')
  expect(BUILTIN_THEMES[app.themeIndex()]!.name).toBe('vesper')
})

test('the theme key is documented — an unlisted key is undiscoverable', () => {
  const keys = KEYMAP.flatMap((s) => s.bindings.map((b) => b.keys))
  expect(keys).toContain('t')
})
