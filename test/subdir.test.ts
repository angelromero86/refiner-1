/**
 * Launching refiner from a subdirectory of the repo.
 *
 * git mixes three path spaces and the app used to assume they were one:
 * `status --porcelain` reports root-relative paths, pathspecs and `--no-index`
 * paths resolve against the cwd, and `ls-files` is both cwd-relative AND scoped to
 * the cwd. From a subdirectory that meant every diff came back empty and every
 * staging operation was a no-op — with no error, because git's answer to a
 * pathspec that matches nothing is usually exit 0 and silence.
 *
 * The fix is one rule: refiner runs from the repo root. These tests deliberately
 * leave the process in `sub/` and check both halves — the broken behaviour before
 * `enterRepoRoot()`, so the ones after it prove the fix rather than the plumbing.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPartialPatch, filterContentLines, LineKind, parse } from '../src/diff.ts'
import {
  applyPatchToIndex,
  enterRepoRoot,
  loadAllFiles,
  loadChangedFiles,
  loadDiff,
  Mode,
  stageFile,
  unstageFile,
  type ChangedFile,
  type Source,
} from '../src/git.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

let dir = ''
let cwd = ''

const fileA: ChangedFile = {
  path: 'src/a.txt',
  status: 'M',
  indexCode: ' ',
  workCode: 'M',
}
const fileNew: ChangedFile = {
  path: 'src/new.txt',
  status: '?',
  indexCode: '?',
  workCode: '?',
}
const fileEmpty: ChangedFile = {
  path: 'src/empty.txt',
  status: '?',
  indexCode: '?',
  workCode: '?',
}

/**
 * The fixture leaves the process in the WRONG place on purpose: `sub/`, exactly
 * where a user would be when they type `refiner`.
 */
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-subdir-')))
  cwd = process.cwd()
  process.chdir(dir)
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'Test'])

  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'sub'), { recursive: true })
  await Bun.write(join(dir, 'src/a.txt'), 'one\ntwo\n')
  await Bun.write(join(dir, 'sub/b.txt'), 'x\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])

  await Bun.write(join(dir, 'src/a.txt'), 'one\ntwo\nthree\n')
  await Bun.write(join(dir, 'sub/b.txt'), 'x\ny\n')
  await Bun.write(join(dir, 'src/new.txt'), 'fresh\n')
  await Bun.write(join(dir, 'src/empty.txt'), '')

  process.chdir(join(dir, 'sub'))
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

/** Always run against the repo root, whatever the process cwd happens to be. */
async function git(args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, exitCode }
}

async function porcelain(): Promise<string> {
  return (await git(['status', '--porcelain=v1'])).stdout
}

// ------------------------------------------------------------ the rule itself

test('enterRepoRoot lands on the repo root from a subdirectory', async () => {
  expect(process.cwd()).toBe(join(dir, 'sub'))
  // `mkdtemp(tmpdir())` hands back /var/folders/… while git reports the realpath
  // /private/var/folders/…; the fixture resolves `dir` so this compares like for like.
  expect(await enterRepoRoot()).toBe(dir)
  expect(process.cwd()).toBe(dir)
})

// -------------------------------------------------------------------- reading

test('a diff loaded from a subdirectory is empty — the bug', async () => {
  // Pinned so the next test demonstrates the fix and not the plumbing: git exits 0
  // and prints nothing, which is indistinguishable from "no changes".
  expect(await loadDiff(SOURCE, fileA)).toBe('')
})

test('the same diff is complete after entering the root', async () => {
  await enterRepoRoot()
  const text = await loadDiff(SOURCE, fileA)
  expect(text).toContain('+three')
  const lines = filterContentLines(parse(text))
  expect(lines.map((l) => l.kind)).toEqual([LineKind.Ctx, LineKind.Ctx, LineKind.Add])
})

test('loadChangedFiles paths are root-relative from anywhere', async () => {
  // The half that already worked — porcelain ignores the cwd. Pinned so nobody
  // "fixes" it into cwd-relative paths and re-splits the two path spaces.
  const paths = (await loadChangedFiles(SOURCE)).map((f) => f.path)
  expect(paths).toContain('src/a.txt')
  expect(paths).toContain('sub/b.txt')
})

test('loadAllFiles lists the whole repo, root-relative, exactly once', async () => {
  await enterRepoRoot()
  const paths = (await loadAllFiles(SOURCE)).map((f) => f.path)
  expect(paths.sort()).toEqual(['src/a.txt', 'src/empty.txt', 'src/new.txt', 'sub/b.txt'])
  // `b.txt` is what ls-files reports from `sub/`. It never matches the `sub/b.txt`
  // porcelain reports, so the file used to appear twice: once bare and statusless,
  // once with its 'M'.
  expect(paths).not.toContain('b.txt')
})

test('every path loadAllFiles returns can be opened from the process cwd', async () => {
  await enterRepoRoot()
  // Exactly what `readAsContext()` and `isThreadOutdated()` do with these paths,
  // without having to stand up an App.
  for (const f of await loadAllFiles(SOURCE)) {
    expect(await Bun.file(f.path).exists(), f.path).toBe(true)
  }
})

test('an untracked file has a diff from a subdirectory', async () => {
  await enterRepoRoot()
  expect(await loadDiff(SOURCE, fileNew)).toContain('+fresh')
})

test('an unreadable untracked path is reported instead of swallowed', async () => {
  // `--no-index` exits 1 both when the files differ (normal) and when it cannot
  // open one (broken). The whitelist used to accept both and return "", which is
  // how the one place git DID complain became the one place nobody listened.
  await expect(loadDiff(SOURCE, fileNew)).rejects.toThrow(/Could not access/)
})

test('an empty untracked file still yields a header-only diff', async () => {
  // The guardrail for the check above: nothing differs, so git prints no hunk —
  // but it does print the header, so stdout is non-empty and this must not throw.
  await enterRepoRoot()
  const text = await loadDiff(SOURCE, fileEmpty)
  expect(text).toContain('new file mode')
})

// -------------------------------------------------------------------- writing

test('stageFile from a subdirectory reaches the index', async () => {
  await enterRepoRoot()
  await stageFile('src/a.txt')
  expect(await porcelain()).toContain('M  src/a.txt')
})

test('unstageFile from a subdirectory really unstages', async () => {
  await git(['add', 'src/a.txt'])
  expect(await porcelain()).toContain('M  src/a.txt')

  await enterRepoRoot()
  await unstageFile('src/a.txt')
  // Not "it didn't throw": `git restore --staged` fails on an unmatched pathspec,
  // but the `git reset` fallback exits 0 having done nothing, so the old code
  // reported success with the file still staged.
  expect(await porcelain()).toContain(' M src/a.txt')
})

test('partial staging from a subdirectory stages the line it was asked to', async () => {
  await enterRepoRoot()
  const lines = filterContentLines(parse(await loadDiff(SOURCE, fileA)))
  const adds = lines.map((l, i) => [l, i] as const).filter(([l]) => l.kind === LineKind.Add)
  expect(adds).toHaveLength(1)

  const patch = buildPartialPatch('src/a.txt', lines, new Set([adds[0][1]]))
  expect(patch).toContain('+three')
  await applyPatchToIndex(patch)

  // `git apply` documents that it ignores patched paths outside the cwd, so from
  // `sub/` this used to exit 0 and leave the index untouched.
  const staged = await git(['diff', '--cached', 'HEAD'])
  expect(staged.stdout).toContain('+three')
  expect((await git(['show', ':src/a.txt'])).stdout).toBe('one\ntwo\nthree\n')
})
