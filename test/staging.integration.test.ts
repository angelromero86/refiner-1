/**
 * End-to-end staging against a real git repository.
 *
 * The unit tests prove the patch text matches the Go implementation byte for
 * byte; these prove git actually *accepts* that text and that the resulting
 * index contains exactly the lines we asked for. This is the path that can
 * corrupt a user's index, so it is exercised against real `git apply --cached`
 * rather than a mock — including the no-trailing-newline cases, which are the
 * ones that historically get rejected.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPartialPatch,
  computeStagedIndices,
  filterContentLines,
  LineKind,
  parse,
  type Line,
} from '../src/diff.ts'

let dir = ''
let cwd = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refiner-stage-'))
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

async function git(args: string[], stdin?: string) {
  const proc = Bun.spawn(['git', ...args], {
    cwd: dir,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function commitBase(path: string, content: string) {
  await Bun.write(join(dir, path), content)
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
}

/** The unified diff refiner works from: whole-file context, working tree vs HEAD. */
async function worktreeDiff(path: string): Promise<Line[]> {
  const r = await git(['diff', '--no-color', '-U99999', 'HEAD', '--', path])
  expect(r.exitCode).toBe(0)
  return filterContentLines(parse(r.stdout))
}

/** What is currently staged, as indices into `combined`. */
async function stagedIndices(path: string, combined: Line[]): Promise<number[]> {
  const r = await git(['diff', '--no-color', '-U99999', '--cached', 'HEAD', '--', path])
  if (r.stdout === '') return []
  const staged = filterContentLines(parse(r.stdout))
  return [...computeStagedIndices(combined, staged)].sort((a, b) => a - b)
}

async function applyToIndex(patch: string) {
  const r = await git(['apply', '--cached', '--whitespace=nowarn'], patch)
  // Surface git's own complaint rather than a bare exit code.
  expect(r.stderr.trim() + r.stdout.trim()).toBe('')
  expect(r.exitCode).toBe(0)
}

function changedIndices(combined: Line[]): number[] {
  const out: number[] = []
  for (let i = 0; i < combined.length; i++) {
    if (combined[i].kind === LineKind.Add || combined[i].kind === LineKind.Del) out.push(i)
  }
  return out
}

test('stages a single added line and leaves the rest unstaged', async () => {
  await commitBase('a.txt', 'a\nb\nc\n')
  await Bun.write(join(dir, 'a.txt'), 'a\nNEW1\nb\nNEW2\nc\n')

  const combined = await worktreeDiff('a.txt')
  const changed = changedIndices(combined)
  expect(changed).toHaveLength(2)

  const patch = buildPartialPatch('a.txt', combined, new Set([changed[0]]))
  await applyToIndex(patch)

  expect(await stagedIndices('a.txt', combined)).toEqual([changed[0]])
  // The index has NEW1 but not NEW2.
  const staged = await git(['show', ':a.txt'])
  expect(staged.stdout).toBe('a\nNEW1\nb\nc\n')
})

test('stages a deletion without touching a neighbouring addition', async () => {
  await commitBase('b.txt', 'keep\ndrop\nalso\n')
  await Bun.write(join(dir, 'b.txt'), 'keep\nalso\nadded\n')

  const combined = await worktreeDiff('b.txt')
  const dels = combined
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.kind === LineKind.Del)
    .map(([, i]) => i)
  expect(dels).toHaveLength(1)

  await applyToIndex(buildPartialPatch('b.txt', combined, new Set(dels)))
  expect(await stagedIndices('b.txt', combined)).toEqual(dels)
  expect((await git(['show', ':b.txt'])).stdout).toBe('keep\nalso\n')
})

test('round-trips every line: stage all, then unstage all', async () => {
  await commitBase('c.txt', 'one\ntwo\nthree\n')
  await Bun.write(join(dir, 'c.txt'), 'ONE\ntwo\nTHREE\nfour\n')

  const combined = await worktreeDiff('c.txt')
  const all = new Set(changedIndices(combined))

  await applyToIndex(buildPartialPatch('c.txt', combined, all))
  expect(await stagedIndices('c.txt', combined)).toEqual([...all].sort((a, b) => a - b))
  expect((await git(['show', ':c.txt'])).stdout).toBe('ONE\ntwo\nTHREE\nfour\n')

  // Unstaging is "reset to HEAD, then apply the remaining set" — here, empty.
  await git(['restore', '--staged', '--', 'c.txt'])
  expect(await stagedIndices('c.txt', combined)).toEqual([])
})

test('HEAD without a trailing newline is accepted by git apply', async () => {
  // The marker case: HEAD's last line has no "\n", so the patch must carry
  // `\ No newline at end of file` on the old side or git rejects it outright.
  await commitBase('d.txt', 'x\ny\nz')
  await Bun.write(join(dir, 'd.txt'), 'x\nY\nz')

  const combined = await worktreeDiff('d.txt')
  const all = new Set(changedIndices(combined))
  expect(all.size).toBeGreaterThan(0)

  const patch = buildPartialPatch('d.txt', combined, all)
  expect(patch).toContain('\\ No newline at end of file')
  await applyToIndex(patch)
  expect((await git(['show', ':d.txt'])).stdout).toBe('x\nY\nz')
})

test('new side losing its trailing newline is staged correctly', async () => {
  await commitBase('e.txt', 'm1\nm2\n')
  await Bun.write(join(dir, 'e.txt'), 'm1\nm2\nm3')

  const combined = await worktreeDiff('e.txt')
  const all = new Set(changedIndices(combined))
  const patch = buildPartialPatch('e.txt', combined, all)
  await applyToIndex(patch)
  expect((await git(['show', ':e.txt'])).stdout).toBe('m1\nm2\nm3')
})

test('partial staging of duplicate identical lines picks the right occurrence', async () => {
  // Ambiguous content is where anchor+content matching earns its keep.
  await commitBase('f.txt', 'same\nsame\nkeep\n')
  await Bun.write(join(dir, 'f.txt'), 'same\nsame\nkeep\nsame\n')

  const combined = await worktreeDiff('f.txt')
  const adds = combined
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.kind === LineKind.Add)
    .map(([, i]) => i)
  expect(adds).toHaveLength(1)

  await applyToIndex(buildPartialPatch('f.txt', combined, new Set(adds)))
  expect(await stagedIndices('f.txt', combined)).toEqual(adds)
  expect((await git(['show', ':f.txt'])).stdout).toBe('same\nsame\nkeep\nsame\n')
})

test('incremental staging: reset-then-apply keeps the index consistent', async () => {
  // This is the invariant the app relies on: the patch always describes the
  // COMPLETE desired set against HEAD, so applying twice in a row never drifts.
  await commitBase('g.txt', 'l1\nl2\nl3\nl4\n')
  await Bun.write(join(dir, 'g.txt'), 'L1\nl2\nL3\nl4\nL5\n')

  const combined = await worktreeDiff('g.txt')
  const changed = changedIndices(combined)
  expect(changed.length).toBeGreaterThanOrEqual(3)

  // Stage the first change.
  const first = new Set([changed[0]])
  await applyToIndex(buildPartialPatch('g.txt', combined, first))
  expect(await stagedIndices('g.txt', combined)).toEqual([...first])

  // Now add a second one: reset to HEAD, then apply the union.
  const union = new Set([changed[0], changed[1]])
  await git(['restore', '--staged', '--', 'g.txt'])
  await applyToIndex(buildPartialPatch('g.txt', combined, union))
  expect(await stagedIndices('g.txt', combined)).toEqual([...union].sort((a, b) => a - b))
})

test('an empty include set produces no patch', async () => {
  await commitBase('h.txt', 'a\n')
  await Bun.write(join(dir, 'h.txt'), 'b\n')
  const combined = await worktreeDiff('h.txt')
  expect(buildPartialPatch('h.txt', combined, new Set())).toBe('')
})
