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
import { chmod, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPartialPatch,
  computeStagedIndices,
  creationMode,
  deletionMode,
  filterContentLines,
  LineKind,
  parse,
  type Line,
} from '../src/diff.ts'
import { applyPatchToIndex, enterRepoRoot, unstageFile } from '../src/git.ts'

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
  return (await worktreeDiffWithHeader(path)).combined
}

/**
 * The same diff, plus the two facts `filterContentLines` throws away: the modes
 * from `new file mode <mode>` and `deleted file mode <mode>`, which the caller
 * has to hand back to `buildPartialPatch` for a file absent from HEAD or gone
 * from the working tree. This is exactly what `App.loadDiffPair` caches.
 */
async function worktreeDiffWithHeader(
  path: string,
): Promise<{ combined: Line[]; createMode: string | null; deleteMode: string | null }> {
  const r = await git(['diff', '--no-color', '-U99999', 'HEAD', '--', path])
  expect(r.exitCode).toBe(0)
  return {
    combined: filterContentLines(parse(r.stdout)),
    createMode: creationMode(r.stdout),
    deleteMode: deletionMode(r.stdout),
  }
}

/** `git apply --cached` without the success assertion, for the rejection cases. */
async function tryApplyToIndex(patch: string) {
  return await git(['apply', '--cached', '--whitespace=nowarn'], patch)
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

// ------------------------------------------------------- files absent from HEAD
//
// `git apply --cached` needs the creation form of the header for these — the
// classic `--- a/<path>` has no preimage to read, and refiner unstages BEFORE it
// applies, so a rejected patch used to leave the index entry gone entirely.

test('partially staging a file absent from HEAD creates the index entry', async () => {
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('A  nuevo.txt\n')

  const { combined, createMode } = await worktreeDiffWithHeader('nuevo.txt')
  expect(createMode).toBe('100644')

  // What the app does: reset the entry to HEAD (i.e. remove it), then apply.
  await git(['restore', '--staged', '--', 'nuevo.txt'])
  await applyToIndex(buildPartialPatch('nuevo.txt', combined, new Set([1, 2]), { createMode }))

  expect((await git(['show', ':nuevo.txt'])).stdout).toBe('l2\nl3\n')
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('AM nuevo.txt\n')
  expect(await stagedIndices('nuevo.txt', combined)).toEqual([1, 2])
})

test('the classic header is what git rejects for a creation', async () => {
  // The regression witness: this is the failure the extra argument exists to
  // avoid, and it is why inferring nothing and defaulting to the old shape is
  // not an option for a file with no HEAD blob.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])

  const combined = await worktreeDiff('nuevo.txt')
  await git(['restore', '--staged', '--', 'nuevo.txt'])

  const r = await tryApplyToIndex(buildPartialPatch('nuevo.txt', combined, new Set([1, 2])))
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('does not exist in index')
  // And the index entry is gone, which is the bug's actual damage.
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('?? nuevo.txt\n')
})

test('a second press on an AM file still patches partially', async () => {
  // Added, then edited: porcelain says `AM`, and `parsePorcelain` prefers the
  // tree column, so `ChangedFile.status` is 'M' even though HEAD has no blob.
  // The header is what settles it, so this path needs no status special case.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\nl4\n')
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('AM nuevo.txt\n')

  const { combined, createMode } = await worktreeDiffWithHeader('nuevo.txt')
  expect(createMode).toBe('100644')
  expect(combined).toHaveLength(4)

  await git(['restore', '--staged', '--', 'nuevo.txt'])
  await applyToIndex(buildPartialPatch('nuevo.txt', combined, new Set([0, 3]), { createMode }))
  expect((await git(['show', ':nuevo.txt'])).stdout).toBe('l1\nl4\n')
  expect(await stagedIndices('nuevo.txt', combined)).toEqual([0, 3])
})

test('a file whose HEAD blob is empty is not a creation', async () => {
  // The case that forbids inferring creation from `oldCount === 0`: the filtered
  // line list is byte-identical to a real creation's (all Add), and git even
  // emits the same `@@ -0,0 +1,N @@` — but the index entry already exists, so
  // the creation header is exactly wrong.
  await commitBase('vacio.txt', '')
  await Bun.write(join(dir, 'vacio.txt'), 'l1\nl2\nl3\n')

  const { combined, createMode } = await worktreeDiffWithHeader('vacio.txt')
  expect(createMode).toBeNull()
  expect(combined.every((l) => l.kind === LineKind.Add)).toBe(true)

  // The classic header — what refiner emits without a mode — applies cleanly.
  await applyToIndex(buildPartialPatch('vacio.txt', combined, new Set([1, 2])))
  expect((await git(['show', ':vacio.txt'])).stdout).toBe('l2\nl3\n')

  // And the creation header is rejected, which is why the verdict has to come
  // from git's header rather than from the lines.
  await git(['restore', '--staged', '--', 'vacio.txt'])
  const r = await tryApplyToIndex(
    buildPartialPatch('vacio.txt', combined, new Set([1, 2]), { createMode: '100644' }),
  )
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('already exists in index')
})

test('a new executable file keeps its mode', async () => {
  // The assertion that fails the moment someone hard-codes `100644`.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'run.sh'), '#!/bin/sh\necho one\necho two\n')
  await chmod(join(dir, 'run.sh'), 0o755)
  await git(['add', 'run.sh'])

  const { combined, createMode } = await worktreeDiffWithHeader('run.sh')
  expect(createMode).toBe('100755')

  await git(['restore', '--staged', '--', 'run.sh'])
  await applyToIndex(buildPartialPatch('run.sh', combined, new Set([0, 1]), { createMode }))

  expect((await git(['ls-files', '--stage', '--', 'run.sh'])).stdout).toStartWith('100755 ')
  expect((await git(['show', ':run.sh'])).stdout).toBe('#!/bin/sh\necho one\n')
})

test('a new file without a trailing newline round-trips', async () => {
  // The `\ No newline` invariant, on the creation path. Only the new side gets a
  // marker: with a `--- /dev/null` old side there is nothing for one to describe.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nn.txt'), 'n1\nn2\nn3')
  await git(['add', 'nn.txt'])

  const { combined, createMode } = await worktreeDiffWithHeader('nn.txt')
  await git(['restore', '--staged', '--', 'nn.txt'])

  const patch = buildPartialPatch('nn.txt', combined, new Set([1, 2]), { createMode })
  expect(patch).toContain('\\ No newline at end of file')
  expect(patch).not.toContain('--- a/')
  // Exactly one marker: the old side is /dev/null.
  expect(patch.split('\\ No newline at end of file')).toHaveLength(2)
  await applyToIndex(patch)
  expect((await git(['show', ':nn.txt'])).stdout).toBe('n2\nn3')
})

test('staging every line of a new file matches git add', async () => {
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])

  const { combined, createMode } = await worktreeDiffWithHeader('nuevo.txt')
  await git(['restore', '--staged', '--', 'nuevo.txt'])
  await applyToIndex(
    buildPartialPatch('nuevo.txt', combined, new Set(changedIndices(combined)), { createMode }),
  )

  expect((await git(['show', ':nuevo.txt'])).stdout).toBe('l1\nl2\nl3\n')
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('A  nuevo.txt\n')
})

test('unstaging every line of a new file removes the entry', async () => {
  // For a creation, "nothing staged" is "no index entry" — never an empty blob.
  // `buildPartialPatch` returns '' and the app runs the unstage alone.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])

  const { combined, createMode } = await worktreeDiffWithHeader('nuevo.txt')
  expect(buildPartialPatch('nuevo.txt', combined, new Set(), { createMode })).toBe('')

  await git(['restore', '--staged', '--', 'nuevo.txt'])
  expect((await git(['status', '--porcelain', '--', 'nuevo.txt'])).stdout).toBe('?? nuevo.txt\n')
  expect((await git(['ls-files', '--stage', '--', 'nuevo.txt'])).stdout).toBe('')
})

test('incremental staging on a creation does not drift', async () => {
  // The reset-then-apply invariant, on the new header. Here the reset is not an
  // optimisation to skip: `git apply --cached` refuses a `new file mode` patch
  // with `already exists in index` while the entry is still there.
  await commitBase('seed.txt', 'seed\n')
  await Bun.write(join(dir, 'nuevo.txt'), 'l1\nl2\nl3\n')
  await git(['add', 'nuevo.txt'])

  const { combined, createMode } = await worktreeDiffWithHeader('nuevo.txt')
  await git(['restore', '--staged', '--', 'nuevo.txt'])
  await applyToIndex(buildPartialPatch('nuevo.txt', combined, new Set([1]), { createMode }))
  expect(await stagedIndices('nuevo.txt', combined)).toEqual([1])

  // Applying the union without resetting first is the failure mode the order
  // guards against.
  const second = buildPartialPatch('nuevo.txt', combined, new Set([1, 2]), { createMode })
  const clash = await tryApplyToIndex(second)
  expect(clash.exitCode).not.toBe(0)
  expect(clash.stderr).toContain('already exists in index')

  await git(['restore', '--staged', '--', 'nuevo.txt'])
  await applyToIndex(second)
  expect(await stagedIndices('nuevo.txt', combined)).toEqual([1, 2])
  expect((await git(['show', ':nuevo.txt'])).stdout).toBe('l2\nl3\n')
})

// ------------------------------------------------ files gone from the working tree
//
// The mirror of the block above. Here the entry has to LEAVE the index, and the
// classic header will not do it: git applies `+++ b/<path>` with `+1,0` happily,
// exits 0, and leaves the EMPTY blob behind — a commit that writes an empty file
// where the user asked for none. Only `deleted file mode` removes the entry, and
// only a fully-covering selection may ask for it.

test('staging the full deletion removes the index entry', async () => {
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))
  expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe(' D gone.txt\n')

  const { combined, deleteMode } = await worktreeDiffWithHeader('gone.txt')
  expect(deleteMode).toBe('100644')
  expect(combined.every((l) => l.kind === LineKind.Del)).toBe(true)

  const patch = buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })
  expect(patch).toContain('deleted file mode 100644\n')
  expect(patch).toContain('+++ /dev/null\n')
  expect(patch).not.toContain('+++ b/gone.txt')
  expect(patch).toContain('@@ -1,3 +0,0 @@\n')

  await applyToIndex(patch)
  expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe('D  gone.txt\n')
  expect((await git(['ls-files', '--stage', '--', 'gone.txt'])).stdout).toBe('')
  // The bug's signature, asserted directly: no entry at all, empty blob least of all.
  expect((await git(['show', ':gone.txt'])).exitCode).not.toBe(0)
})

test('the classic header is what leaves an empty blob for a deletion', async () => {
  // The regression witness. This is what refiner emitted before `deleteMode`
  // existed: exit 0, nothing on stderr, `app.err` null — and the wrong index.
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))

  const combined = await worktreeDiff('gone.txt')
  const legacy = buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)))
  expect(legacy).toContain('+++ b/gone.txt\n')

  const r = await tryApplyToIndex(legacy)
  expect(r.exitCode).toBe(0)
  expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe('MD gone.txt\n')
  // e69de29… is the empty blob: the file survives the commit, emptied.
  expect((await git(['ls-files', '--stage', '--', 'gone.txt'])).stdout).toContain(
    'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  )
})

test('`+++ /dev/null` without the mode line writes a bogus dev/null entry', async () => {
  // Why the mode line is not decoration: the "minimal" fix is worse than the bug.
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))

  const combined = await worktreeDiff('gone.txt')
  const patch = buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)), {
    deleteMode: '100644',
  }).replace('deleted file mode 100644\n', '')

  const r = await tryApplyToIndex(patch)
  expect(r.exitCode).toBe(0)
  expect((await git(['status', '--porcelain'])).stdout).toContain('AD dev/null')
})

test('partial staging of a deletion keeps the file in the index', async () => {
  // The non-regression twin: two of three lines is still a modification, and the
  // unselected del becomes context. `newCount === 0` is what gates the new branch.
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('gone.txt')
  const patch = buildPartialPatch('gone.txt', combined, new Set([0, 1]), { deleteMode })
  expect(patch).not.toContain('deleted file mode')
  expect(patch).toContain('+++ b/gone.txt\n')

  await applyToIndex(patch)
  expect((await git(['show', ':gone.txt'])).stdout).toBe('c\n')
  expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe('MD gone.txt\n')
  expect(await stagedIndices('gone.txt', combined)).toEqual([0, 1])
})

test('emptying a file is not the same as deleting it', async () => {
  // The test that justifies the whole design, and the integration twin of the
  // golden fixture `alldel.txt.diff`. Truncating produces a byte-identical
  // filtered `Line[]` to a deletion; only the header separates them, and getting
  // it wrong here would delete a file the user merely emptied.
  await commitBase('trunc.txt', 'r1\nr2\nr3\n')
  await Bun.write(join(dir, 'trunc.txt'), '')

  const { combined, deleteMode } = await worktreeDiffWithHeader('trunc.txt')
  expect(deleteMode).toBeNull()
  expect(combined.every((l) => l.kind === LineKind.Del)).toBe(true)

  const patch = buildPartialPatch('trunc.txt', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })
  expect(patch).toContain('+++ b/trunc.txt\n')
  expect(patch).not.toContain('deleted file mode')

  await applyToIndex(patch)
  expect((await git(['show', ':trunc.txt'])).stdout).toBe('')
  expect((await git(['ls-files', '--stage', '--', 'trunc.txt'])).stdout).toStartWith(
    '100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  )
  expect((await git(['status', '--porcelain', '--', 'trunc.txt'])).stdout).toBe('M  trunc.txt\n')
})

test('deleting an executable keeps its mode in the header', async () => {
  // A hard-coded 100644 exits 0 here but prints `warning: run.sh has type
  // 100755, expected 100644` — which `applyPatchToIndex` (exit code only) would
  // swallow. `applyToIndex`'s empty-stderr assertion is what catches it.
  await Bun.write(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
  await chmod(join(dir, 'run.sh'), 0o755)
  await commitBase('seed.txt', 'seed\n')
  expect((await git(['ls-files', '--stage', '--', 'run.sh'])).stdout).toStartWith('100755 ')
  await unlink(join(dir, 'run.sh'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('run.sh')
  expect(deleteMode).toBe('100755')

  const patch = buildPartialPatch('run.sh', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })
  expect(patch).toContain('deleted file mode 100755\n')
  await applyToIndex(patch)
  expect((await git(['ls-files', '--stage', '--', 'run.sh'])).stdout).toBe('')
  expect((await git(['status', '--porcelain', '--', 'run.sh'])).stdout).toBe('D  run.sh\n')
})

test('deleting a symlink does not fail', async () => {
  // The case a hard-coded mode does not merely warn about: git refuses it with
  // `wrong type` and, because refiner unstages BEFORE it applies, the press
  // would report an error and leave nothing staged.
  await Bun.write(join(dir, 'target.txt'), 'target\n')
  await symlink('target.txt', join(dir, 'link.txt'))
  await commitBase('seed.txt', 'seed\n')
  expect((await git(['ls-files', '--stage', '--', 'link.txt'])).stdout).toStartWith('120000 ')
  await unlink(join(dir, 'link.txt'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('link.txt')
  expect(deleteMode).toBe('120000')
  // git stores a symlink's target with no trailing newline, so the marker rides along.
  const patch = buildPartialPatch('link.txt', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })
  expect(patch).toContain('deleted file mode 120000\n')
  expect(patch).toContain('\\ No newline at end of file')

  await applyToIndex(patch)
  expect((await git(['ls-files', '--stage', '--', 'link.txt'])).stdout).toBe('')
  expect((await git(['status', '--porcelain', '--', 'link.txt'])).stdout).toBe('D  link.txt\n')

  // And the hard-coded mode is a hard failure, not a warning.
  const wrong = buildPartialPatch('link.txt', combined, new Set(changedIndices(combined)), {
    deleteMode: '100644',
  })
  await git(['restore', '--staged', '--', 'link.txt'])
  const r = await tryApplyToIndex(wrong)
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('wrong type')
})

test('a deleted file with no trailing newline keeps its marker', async () => {
  // The `\ No newline` invariant on the deletion path. Only the old side has
  // lines, so exactly one marker — and without it git rejects the patch, since
  // the preimage would no longer match HEAD.
  await commitBase('gone.txt', 'a\nb\nc')
  await unlink(join(dir, 'gone.txt'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('gone.txt')
  const patch = buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })
  expect(patch).toContain('\\ No newline at end of file')
  expect(patch.split('\\ No newline at end of file')).toHaveLength(2)
  await applyToIndex(patch)
  expect((await git(['ls-files', '--stage', '--', 'gone.txt'])).stdout).toBe('')

  // Dropping the marker is what git rejects.
  await git(['restore', '--staged', '--', 'gone.txt'])
  const stripped = await tryApplyToIndex(patch.replace('\\ No newline at end of file\n', ''))
  expect(stripped.exitCode).not.toBe(0)
})

test('a staged deletion round-trips through computeStagedIndices', async () => {
  // What the TUI paints as "staged" after the press. Nothing here knows the
  // header changed shape, so this is the guard that it still agrees.
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('gone.txt')
  await applyToIndex(
    buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)), { deleteMode }),
  )
  expect(await stagedIndices('gone.txt', combined)).toEqual([0, 1, 2])
})

test('reset-then-apply is idempotent for a deletion, and unstaging restores it', async () => {
  // `resetAndApply` unchanged, on the new header: restore puts HEAD's entry back
  // and the patch removes it again. And an empty desired set means the restore
  // alone — the file returns to the index with HEAD's content, status ` D`.
  await commitBase('gone.txt', 'a\nb\nc\n')
  await unlink(join(dir, 'gone.txt'))

  const { combined, deleteMode } = await worktreeDiffWithHeader('gone.txt')
  const patch = buildPartialPatch('gone.txt', combined, new Set(changedIndices(combined)), {
    deleteMode,
  })

  for (let i = 0; i < 2; i++) {
    await git(['restore', '--staged', '--', 'gone.txt'])
    await applyToIndex(patch)
    expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe('D  gone.txt\n')
  }

  // Unstaging: the empty include set produces no patch at all.
  expect(buildPartialPatch('gone.txt', combined, new Set(), { deleteMode })).toBe('')
  await git(['restore', '--staged', '--', 'gone.txt'])
  expect((await git(['status', '--porcelain', '--', 'gone.txt'])).stdout).toBe(' D gone.txt\n')
  expect((await git(['show', ':gone.txt'])).stdout).toBe('a\nb\nc\n')
})

test('the old half of a rename stages as an ordinary deletion', async () => {
  // `loadChangedFiles` passes `--no-renames`, so a rename arrives as a plain `D`
  // plus a plain `A`. That is what makes this path reachable at all for renames.
  await commitBase('old.txt', 'r1\nr2\n')
  await unlink(join(dir, 'old.txt'))
  await Bun.write(join(dir, 'new.txt'), 'r1\nr2\n')

  const { combined, deleteMode } = await worktreeDiffWithHeader('old.txt')
  expect(deleteMode).toBe('100644')
  await applyToIndex(
    buildPartialPatch('old.txt', combined, new Set(changedIndices(combined)), { deleteMode }),
  )
  expect((await git(['ls-files', '--stage', '--', 'old.txt'])).stdout).toBe('')
  expect((await git(['status', '--porcelain', '--', 'old.txt'])).stdout).toBe('D  old.txt\n')
})

test('staging from a subdirectory produces the same index as from the root', async () => {
  // The real pipeline, run from where a user would actually launch refiner. Every
  // path here is root-relative; only `enterRepoRoot()` makes them mean anything.
  // Without it `git apply --cached` exits 0 and silently ignores a patch whose
  // header points outside the cwd, so the index stays empty and nothing complains.
  await mkdir(join(dir, 'sub'), { recursive: true })
  await Bun.write(join(dir, 'sub/keep.txt'), 'k\n')
  await commitBase('i.txt', 'p\nq\nr\n')
  await Bun.write(join(dir, 'i.txt'), 'p\nQ\nr\nS\n')

  const combined = await worktreeDiff('i.txt')
  const changed = changedIndices(combined)
  expect(changed.length).toBeGreaterThan(1)
  const include = new Set([changed[0]])

  // From the root: the reference index.
  await applyToIndex(buildPartialPatch('i.txt', combined, include))
  const fromRoot = (await git(['diff', '--cached', '--no-color', 'HEAD'])).stdout
  expect(fromRoot).not.toBe('')
  await git(['restore', '--staged', '--', 'i.txt'])

  // Same flow, driven through refiner's own git layer from `sub/`.
  process.chdir(join(dir, 'sub'))
  expect(await enterRepoRoot()).toBe(realpathSync(dir))
  await unstageFile('i.txt')
  await applyPatchToIndex(buildPartialPatch('i.txt', combined, include))

  const fromSub = (await git(['diff', '--cached', '--no-color', 'HEAD'])).stdout
  expect(fromSub).toBe(fromRoot)
})
