/**
 * Renames, which refiner deliberately does not model.
 *
 * A rename is one change over two paths; everything downstream of `git.ts` assumes
 * a `ChangedFile` is exactly one path — the tree splits it on `/`, the diff cache
 * and `app.staged` key on it, `stageFile`/`unstageFile` hand it to git as a
 * pathspec. So `loadChangedFiles` asks git for `--no-renames` and the pair arrives
 * as an ordinary `D` plus an ordinary `A`.
 *
 * The tests below pin the two failures that produced: `R ` (clean rename) left the
 * old side's deletion staged when the user unstaged the new side, and `RM` (rename
 * then edit) never reached the two-path branch at all — `path` became the literal
 * `"old.txt -> new.txt"`, which git answers with an empty diff and a silent no-op.
 * Anything asserting `!path.includes(' -> ')` is pinning that second one.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isChanged,
  loadAllFiles,
  loadChangedFiles,
  loadDiff,
  Mode,
  parseNameStatus,
  parsePorcelain,
  stageFile,
  unstageFile,
  type ChangedFile,
  type Source,
} from '../src/git.ts'
import { build, type DirNode, type Node } from '../src/tree.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

let dir = ''
let cwd = ''

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-rename-')))
  cwd = process.cwd()
  process.chdir(dir)
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** `old.txt` committed with three lines, then `git mv`-ed to `new.txt`. */
async function renamedBase() {
  await Bun.write(join(dir, 'old.txt'), 'a\nb\nc\n')
  await Bun.write(join(dir, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['mv', 'old.txt', 'new.txt'])
}

function byPath(files: ChangedFile[]): Map<string, ChangedFile> {
  return new Map(files.map((f) => [f.path, f]))
}

// ------------------------------------------------------------------- the parsers

test('parsePorcelain never lets an arrow into a path', () => {
  // With `--no-renames` these are the lines git emits for a rename plus an edit.
  const files = parsePorcelain('D  old.txt\nAM new.txt\n')
  expect(files.every((f) => !f.path.includes(' -> '))).toBe(true)
})

test('parsePorcelain reports the two halves of a rename as ordinary entries', () => {
  const files = parsePorcelain('D  old.txt\nAM new.txt\n')
  expect(files).toHaveLength(2)
  expect(files[0]).toEqual({ path: 'old.txt', status: 'D', indexCode: 'D', workCode: ' ' })
  // `AM` is the rename-then-edit case: not in HEAD, and the tree has moved on
  // since the `git add`. Note `status` is 'M' while `indexCode` is 'A' — the Y
  // column wins. Whoever needs "is this in HEAD" must read `indexCode`.
  expect(files[1]).toEqual({ path: 'new.txt', status: 'M', indexCode: 'A', workCode: 'M' })
})

test('parsePorcelain keeps a filename that genuinely contains an arrow', () => {
  // The old ` -> ` split would have cut this in half the moment the status letter
  // came out 'R'. Nothing splits any more, so the name survives verbatim.
  const files = parsePorcelain('A  a -> b.txt\n')
  expect(files).toHaveLength(1)
  expect(files[0].path).toBe('a -> b.txt')
})

test('parseNameStatus produces no three-column entries', () => {
  const files = parseNameStatus('A\tnew.txt\nD\told.txt\n')
  expect(files).toHaveLength(2)
  expect(files.map((f) => f.path)).toEqual(['new.txt', 'old.txt'])
  expect(files.every((f) => !f.path.includes('\t'))).toBe(true)
  expect(files.some((f) => f.status === 'R')).toBe(false)
})

// ------------------------------------------------------------ against real repos

test('a pure rename is listed as two files', async () => {
  await renamedBase()

  const files = await loadChangedFiles(SOURCE)
  expect(files).toHaveLength(2)
  const m = byPath(files)
  expect(m.get('old.txt')!.status).toBe('D')
  expect(m.get('new.txt')!.indexCode).toBe('A')
  expect(files.every((f) => !f.path.includes(' -> '))).toBe(true)
})

test('a rename followed by an edit keeps its path', async () => {
  await renamedBase()
  // The report's own reproduction. Porcelain says `RM old.txt -> new.txt`, whose
  // status letter is 'M', so the rename branch was never even reached and `path`
  // became the whole line's tail.
  await Bun.write(join(dir, 'new.txt'), 'a\nb\nc\nd\n')

  const files = await loadChangedFiles(SOURCE)
  expect(files.find((f) => f.path === 'new.txt')).toBeDefined()
  expect(files.find((f) => f.path === 'old.txt')!.status).toBe('D')
  expect(files.every((f) => !f.path.includes(' -> '))).toBe(true)
})

test('a rename inside a directory does not invent a directory', async () => {
  await mkdir(join(dir, 'src'), { recursive: true })
  await Bun.write(join(dir, 'src/a.ts'), 'a\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['mv', 'src/a.ts', 'src/b.ts'])
  await Bun.write(join(dir, 'src/b.ts'), 'a\nb\n')

  const nodes = build(await loadChangedFiles(SOURCE))
  // `'src/a.ts -> src/b.ts'.split('/')` used to yield a phantom `src/a.ts -> src`
  // directory holding a single `b.ts`.
  expect(nodes).toHaveLength(1)
  expect(nodes[0].type).toBe('dir')
  const src = nodes[0] as DirNode
  expect(src.name).toBe('src')
  expect(src.children.map((c) => c.name)).toEqual(['a.ts', 'b.ts'])
  expect(everyNode(nodes).every((n) => !n.name.includes(' -> '))).toBe(true)
})

test('a cross-directory rename lands in both directories', async () => {
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'lib'), { recursive: true })
  await Bun.write(join(dir, 'src/a.ts'), 'a\n')
  await Bun.write(join(dir, 'lib/keep.ts'), 'k\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['mv', 'src/a.ts', 'lib/a.ts'])

  const paths = (await loadChangedFiles(SOURCE)).map((f) => f.path).sort()
  expect(paths).toEqual(['lib/a.ts', 'src/a.ts'])
  const names = everyNode(build(await loadChangedFiles(SOURCE))).map((n) => n.name)
  expect(names.sort()).toEqual(['a.ts', 'a.ts', 'lib', 'src'])
})

test('unstaging both halves leaves nothing staged', async () => {
  await renamedBase()
  // The bug's own assertion. One `git restore --staged -- new.txt` used to leave
  // `D  old.txt` in the index: a commit there would delete the original without
  // adding the replacement.
  const files = await loadChangedFiles(SOURCE)
  for (const f of files) await unstageFile(f.path)

  expect((await git(['diff', '--cached', 'HEAD'])).stdout).toBe('')
  const after = (await git(['status', '--porcelain'])).stdout.split('\n').filter((l) => l !== '')
  expect(after.sort()).toEqual([' D old.txt', '?? new.txt'])
  // The old side is back in the index at HEAD's blob, which is what makes the
  // deletion unstaged rather than merely invisible.
  expect((await git(['ls-files', '--stage', '--', 'old.txt'])).stdout).toContain('old.txt')
})

test('staging the new side of a rename does not fail on a pathspec', async () => {
  await renamedBase()
  await Bun.write(join(dir, 'new.txt'), 'a\nb\nc\nd\n')

  const f = (await loadChangedFiles(SOURCE)).find((x) => x.path === 'new.txt')!
  // Used to be `git add -- 'old.txt -> new.txt'`, i.e. `fatal: pathspec ... did
  // not match any files` straight into the error banner.
  await stageFile(f.path)
  // Asserted through refiner's own view: a bare `git status --porcelain` would
  // re-detect the rename and print `R  old.txt -> new.txt` again.
  const after = byPath(await loadChangedFiles(SOURCE)).get('new.txt')!
  expect([after.indexCode, after.workCode]).toEqual(['A', ' '])
  expect((await git(['ls-files', '--stage', '--', 'new.txt'])).stdout).toContain('new.txt')
})

test('the old side of a rename has a diff of its own', async () => {
  await renamedBase()

  const old = (await loadChangedFiles(SOURCE)).find((f) => f.path === 'old.txt')!
  const text = await loadDiff(SOURCE, old)
  expect(text).toContain('-a')
  expect(text).toContain('deleted file mode')
})

test('the new side of a rename has a diff after a later edit', async () => {
  await renamedBase()
  await Bun.write(join(dir, 'new.txt'), 'a\nb\nc\nd\n')

  const f = (await loadChangedFiles(SOURCE)).find((x) => x.path === 'new.txt')!
  // The blank panel: `git diff HEAD -- 'old.txt -> new.txt'` exits 0 with no output.
  expect(await loadDiff(SOURCE, f)).toContain('+d')
})

test('ALL mode does not lose the renamed file', async () => {
  await renamedBase()
  await Bun.write(join(dir, 'new.txt'), 'a\nb\nc\nd\n')

  const files = await loadAllFiles(SOURCE)
  expect(files.every((f) => !f.path.includes(' -> '))).toBe(true)
  const m = byPath(files)
  // `new.txt` used to come back from ls-files with `status: ' '` — listed as
  // unchanged — while a phantom `'old.txt -> new.txt'` was appended at the end.
  expect(isChanged(m.get('new.txt')!)).toBe(true)
  expect(m.get('old.txt')!.status).toBe('D')
  expect(isChanged(m.get('seed.txt')!)).toBe(false)
})

test('review mode splits the rename too', async () => {
  await Bun.write(join(dir, 'old.txt'), 'a\nb\nc\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['checkout', '-q', '-b', 'feat'])
  await git(['mv', 'old.txt', 'new.txt'])
  await git(['commit', '-qam', 'rename'])

  // Review mode parses with `parseNameStatus`, not `parsePorcelain`. This is what
  // pins that BOTH argv changed: with only the porcelain one, git answers here
  // with `R100\told.txt\tnew.txt` and the two-path model survives.
  const files = await loadChangedFiles({ mode: Mode.Review, target: 'main' })
  const m = byPath(files)
  expect([...m.keys()].sort()).toEqual(['new.txt', 'old.txt'])
  expect(m.get('new.txt')!.status).toBe('A')
  expect(m.get('old.txt')!.status).toBe('D')
  expect(files.some((f) => f.status === 'R')).toBe(false)
})

test('the flag beats the user configuring renames on', async () => {
  await renamedBase()
  // `status.renames`/`diff.renames` are ordinary user config; a command-line
  // option has to win or the fix only holds on default setups.
  await git(['config', 'status.renames', 'true'])
  await git(['config', 'diff.renames', 'copies'])

  const files = await loadChangedFiles(SOURCE)
  expect(files.map((f) => f.path).sort()).toEqual(['new.txt', 'old.txt'])
  expect(files.some((f) => f.status === 'R' || f.status === 'C')).toBe(false)
})

/** Every node in the tree, dirs and files alike. */
function everyNode(nodes: Node[]): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    out.push(n)
    if (n.type === 'dir') out.push(...everyNode(n.children))
  }
  return out
}
