/**
 * ALL mode: listing the whole repo, and showing a file that has no diff.
 *
 * `contextOnly` is the trick the whole feature rests on — an unchanged file is
 * rendered as a diff in which nothing changed, so none of the three renderers need
 * to know it isn't a real diff. That makes its line numbering and its leading
 * marker load-bearing, hence the pinning here.
 *
 * `loadAllFiles` runs against real repos because the interesting part is what git
 * does and doesn't report: .gitignore'd paths must not appear, and a staged deletion
 * must, even though `ls-files` has forgotten it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextOnly, LineKind } from '../src/diff.ts'
import { isChanged, loadAllFiles, Mode, type Source } from '../src/git.ts'

// ------------------------------------------------------------- contextOnly

test('contextOnly numbers both sides from 1 and keeps the diff marker', () => {
  const lines = contextOnly('alpha\nbeta\ngamma\n')
  expect(lines).toHaveLength(3)
  expect(lines.map((l) => l.kind)).toEqual([LineKind.Ctx, LineKind.Ctx, LineKind.Ctx])
  // The leading space is what the renderers strip; without it the first character
  // of every line would be eaten.
  expect(lines.map((l) => l.text)).toEqual([' alpha', ' beta', ' gamma'])
  expect(lines.map((l) => l.oldNum)).toEqual([1, 2, 3])
  expect(lines.map((l) => l.newNum)).toEqual([1, 2, 3])
})

test('contextOnly does not invent a line for the trailing newline', () => {
  expect(contextOnly('one\n')).toHaveLength(1)
  expect(contextOnly('one\ntwo\n')).toHaveLength(2)
  // No trailing newline: same count, but the last line is flagged like git would.
  const nonl = contextOnly('one\ntwo')
  expect(nonl).toHaveLength(2)
  expect(nonl[1].noNewline).toBe(true)
  expect(contextOnly('one\ntwo\n')[1].noNewline).toBe(false)
})

test('contextOnly handles an empty file and a blank line', () => {
  expect(contextOnly('')).toEqual([])
  expect(contextOnly('\n')).toHaveLength(1)
  expect(contextOnly('\n')[0].text).toBe(' ')
})

test('contextOnly preserves indentation verbatim', () => {
  // Tabs are expanded later, by the renderer and the syntax pass together — doing
  // it here would desynchronise the two.
  const lines = contextOnly('\tif (x) {\n    y()\n')
  expect(lines[0].text).toBe(' \tif (x) {')
  expect(lines[1].text).toBe('     y()')
})

// ------------------------------------------------------------ loadAllFiles

let dir = ''
let cwd = ''
const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-all-'))
  cwd = process.cwd()
  process.chdir(dir)
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
}

test('lists tracked and untracked files, changed or not', async () => {
  await Bun.write(join(dir, 'kept.txt'), 'a\n')
  await Bun.write(join(dir, 'edited.txt'), 'b\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await Bun.write(join(dir, 'edited.txt'), 'B\n')
  await Bun.write(join(dir, 'fresh.txt'), 'c\n')

  const files = await loadAllFiles(SOURCE)
  const byPath = new Map(files.map((f) => [f.path, f]))
  expect([...byPath.keys()].sort()).toEqual(['edited.txt', 'fresh.txt', 'kept.txt'])

  // The unchanged file is listed but carries no status.
  expect(byPath.get('kept.txt')!.status).toBe(' ')
  expect(isChanged(byPath.get('kept.txt')!)).toBe(false)
  // The changed ones keep theirs, so the tree still shows the badge.
  expect(byPath.get('edited.txt')!.status).toBe('M')
  expect(byPath.get('fresh.txt')!.status).toBe('?')
  expect(isChanged(byPath.get('edited.txt')!)).toBe(true)
})

test('respects .gitignore — no build output, no node_modules', async () => {
  await Bun.write(join(dir, '.gitignore'), 'ignored/\n*.log\n')
  await mkdir(join(dir, 'ignored'), { recursive: true })
  await Bun.write(join(dir, 'ignored/junk.txt'), 'x\n')
  await Bun.write(join(dir, 'debug.log'), 'x\n')
  await Bun.write(join(dir, 'real.txt'), 'x\n')

  const paths = (await loadAllFiles(SOURCE)).map((f) => f.path).sort()
  expect(paths).toEqual(['.gitignore', 'real.txt'])
})

test('a staged deletion still appears, though ls-files has dropped it', async () => {
  await Bun.write(join(dir, 'doomed.txt'), 'x\n')
  await Bun.write(join(dir, 'stays.txt'), 'y\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['rm', '-q', 'doomed.txt'])

  const files = await loadAllFiles(SOURCE)
  const doomed = files.find((f) => f.path === 'doomed.txt')
  expect(doomed, 'a deleted file must remain reviewable').toBeDefined()
  expect(doomed!.status).toBe('D')
  expect(files.map((f) => f.path)).toContain('stays.txt')
})

test('every path appears exactly once', async () => {
  await Bun.write(join(dir, 'a.txt'), 'x\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  // Staged AND unstaged changes: porcelain reports one entry, ls-files another.
  await Bun.write(join(dir, 'a.txt'), 'staged\n')
  await git(['add', 'a.txt'])
  await Bun.write(join(dir, 'a.txt'), 'and then some\n')

  const paths = (await loadAllFiles(SOURCE)).map((f) => f.path)
  expect(paths).toEqual(['a.txt'])
})

test('an empty repo lists nothing rather than failing', async () => {
  expect(await loadAllFiles(SOURCE)).toEqual([])
})
