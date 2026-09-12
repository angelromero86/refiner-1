/**
 * Which rows of the working-tree diff paint as staged.
 *
 * `computeStagedIndices` attributes by LINE NUMBER — a Del row by its HEAD
 * line against the cached diff, an Add row by its working-tree line against
 * the index→worktree diff. The version it replaced matched the cached diff's
 * lines by content, and inside a block of added lines every repeated line
 * (blank, `}`) was claimed by the first row with that text: staging the tail
 * of a block painted every other row from the top. Not cosmetic — the queue
 * hands painting back to that answer, and the NEXT toggle builds its complete
 * desired set from it and reset-then-applies it, so the index ended up holding
 * the painting.
 *
 * Three layers, matching the invariant's exposure: pure round-trips through
 * refiner's own `buildPartialPatch` (the bug reproduces with no git at all),
 * the same scenarios against real git — where the slider heuristic can align
 * the two diffs differently — and the second press through `App`, asserted on
 * `git show :path`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { Store } from '../src/comments.ts'
import {
  addNewNums,
  buildPartialPatch,
  computeStagedIndices,
  delOldNums,
  filterContentLines,
  LineKind,
  parse,
  stagedIndicesFromDiffs,
  type Line,
} from '../src/diff.ts'
import { Mode, type Source } from '../src/git.ts'
import { toggleStaged } from '../src/staging.ts'

const SOURCE: Source = { mode: Mode.Uncommitted, target: '' }

// ------------------------------------------------------------------- fixtures

const HEAD_A = 'head1\nhead2\n'
/** Two functions with blank lines and `}` between them — every line the old matcher tripped on. */
const WORK_A = 'head1\nhead2\nfoo() {\n\n  a\n}\n\nbar() {\n\n  b\n}\n'
/** Rows of the `bar` function in the HEAD→worktree diff of A: rows 0–1 are head1/head2. */
const BAR_ROWS = [7, 8, 9, 10]

const HEAD_F = 'a\nz\n'
/** One block with blanks; the middle chunk (`two` with its blanks) is what gets staged. */
const WORK_F = 'a\none\n\n\ntwo\n\n\nthree\nz\n'
const MIDDLE_ROWS = [3, 4, 5]

function sorted(s: ReadonlySet<number> | null): number[] {
  return s ? [...s].sort((a, b) => a - b) : []
}

/**
 * The HEAD→worktree diff refiner works from, built here without git so the
 * pure tests need none: a textual diff of two whole files where nothing is
 * shared but the given context rows. Callers pass the diff body directly.
 */
function combinedOf(body: string[]): Line[] {
  return filterContentLines(parse(['--- a/f', '+++ b/f', '@@ -1 +1 @@', ...body, ''].join('\n')))
}

const COMBINED_A = combinedOf([
  ' head1',
  ' head2',
  '+foo() {',
  '+',
  '+  a',
  '+}',
  '+',
  '+bar() {',
  '+',
  '+  b',
  '+}',
])

const COMBINED_F = combinedOf([' a', '+one', '+', '+', '+two', '+', '+', '+three', ' z'])

/**
 * The two sets the way git would produce them AFTER `include` is applied to a
 * clean index, derived from the patch itself: its Del lines are the cached
 * diff's, and the Add rows it left out are what the index→worktree diff adds.
 */
function setsAfter(combined: Line[], include: Set<number>) {
  const patch = buildPartialPatch('f', combined, include)
  const unstagedAdds = new Set<number>()
  combined.forEach((l, i) => {
    if (l.kind === LineKind.Add && !include.has(i)) unstagedAdds.add(l.newNum)
  })
  return { stagedDels: delOldNums(parse(patch)), unstagedAdds }
}

// ----------------------------------------------------------------------- pure

test('scenario A: the tail of a block with blank lines and braces comes back contiguous', () => {
  expect(COMBINED_A.map((l) => l.kind)).toEqual([
    LineKind.Ctx,
    LineKind.Ctx,
    ...Array<LineKind>(9).fill(LineKind.Add),
  ])
  const { stagedDels, unstagedAdds } = setsAfter(COMBINED_A, new Set(BAR_ROWS))
  // The old matcher's answer here was [3, 5, 7, 9] — "línea sí, línea no".
  expect(sorted(computeStagedIndices(COMBINED_A, stagedDels, unstagedAdds))).toEqual(BAR_ROWS)
})

test('scenario F: a middle chunk of a block of blanks comes back as itself', () => {
  // By content the blanks of `two` were claimed by the blanks of `one`: [2, 3, 4].
  const { stagedDels, unstagedAdds } = setsAfter(COMBINED_F, new Set(MIDDLE_ROWS))
  expect(sorted(computeStagedIndices(COMBINED_F, stagedDels, unstagedAdds))).toEqual(MIDDLE_ROWS)
})

test('every subset of a block of repeated lines round-trips', () => {
  // The complete truth table for A's nine Add rows — the old matcher failed
  // most of it. Pure, so 512 cases are cheap.
  const adds = COMBINED_A.map((l, i) => (l.kind === LineKind.Add ? i : -1)).filter((i) => i >= 0)
  for (let mask = 1; mask < 1 << adds.length; mask++) {
    const include = new Set(adds.filter((_, k) => mask & (1 << k)))
    const { stagedDels, unstagedAdds } = setsAfter(COMBINED_A, include)
    expect(sorted(computeStagedIndices(COMBINED_A, stagedDels, unstagedAdds))).toEqual(
      sorted(include),
    )
  }
})

test('a context row is never staged, whatever the sets say', () => {
  // Line numbers colliding with a Ctx row's are exactly what a slid diff
  // produces; they must not mark it.
  const out = computeStagedIndices(COMBINED_A, new Set([1, 2]), new Set([1, 2]))
  expect(sorted(out)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('slider: the two diffs may disagree on WHICH blank is the added one, never on how many', () => {
  // Worktree `}` at lines 4–6, of which the worktree diff calls line 4 the
  // added one and the index→worktree diff calls line 6 the missing one. Read
  // one number against the other, row 4 is "added and in the index" and the
  // run paints one `}` more than the index holds — which the next toggle would
  // then put there. The count inside a run of identical lines is what is
  // well-defined, so that is what is reconciled.
  const combined = combinedOf([' x {', '+', '+})', ' })', ' })'])
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([5])))).toEqual([1])
  // Same run, the consistent reading: no reconciliation needed, nothing moves.
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([3])))).toEqual([1])
  // And the mirror on the HEAD side: cached diff deletes HEAD line 3, the
  // worktree diff shows HEAD line 2 as the Del row of the same run.
  const dels = combinedOf([' a', '-', ' ', ' b'])
  expect(sorted(computeStagedIndices(dels, new Set([3]), new Set()))).toEqual([1])
  expect(sorted(computeStagedIndices(dels, new Set([2]), new Set()))).toEqual([1])
})

test('slider: a consistent run keeps git\'s own pick; a slid one corrects the count', () => {
  // Two blanks added inside a run of four (Ctx, Add, Add, Ctx at worktree
  // lines 2–5). When the index→worktree diff names an Add row's line, the two
  // readings agree on the count and nothing moves — whichever row git picked.
  const combined = combinedOf([' a', ' ', '+', '+', ' ', ' b'])
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([3])))).toEqual([3])
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([4])))).toEqual([2])
  // Slid onto the Ctx row at line 5: one staged is still the truth, and the
  // LATER row carries it.
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([5])))).toEqual([3])
  // Three of the run's lines missing from the index: only two rows can carry
  // that, and both are unstaged.
  expect(sorted(computeStagedIndices(combined, new Set(), new Set([2, 3, 4])))).toEqual([])
})

test('stagedIndicesFromDiffs: an empty cached diff is nothing staged, whatever the other says', () => {
  // An untracked file: no index entry, so the index→worktree diff is blank —
  // which read naively says every Add is already in the index.
  const combined = combinedOf(['+a', '+b'])
  expect(stagedIndicesFromDiffs(combined, '', '')).toBeNull()
})

test('stagedIndicesFromDiffs: a staged deletion leaves every Add row unstaged', () => {
  // HEAD a/b/c, deletion staged, then the file put back in the working tree
  // with a new line: no index entry, so the index→worktree diff is blank again.
  const combined = combinedOf([' a', '-b', '+X', ' c'])
  const cached = [
    'diff --git a/f b/f',
    'deleted file mode 100644',
    '--- a/f',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
    '',
  ].join('\n')
  expect(sorted(stagedIndicesFromDiffs(combined, cached, ''))).toEqual([1])
})

test('the number helpers read one side each, including -U0 hunks', () => {
  const u0 = ['--- a/f', '+++ b/f', '@@ -2,0 +3,2 @@ ctx', '+x', '+y', '@@ -7 +9,0 @@', '-z', ''].join(
    '\n',
  )
  expect(sorted(addNewNums(parse(u0)))).toEqual([3, 4])
  expect(sorted(delOldNums(parse(u0)))).toEqual([7])
})

// ------------------------------------------------------------------- real git

let dir = ''
let cwd = ''

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'refiner-staged-')))
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

async function worktreeDiff(path: string): Promise<Line[]> {
  const r = await git(['diff', '--no-color', '-U99999', 'HEAD', '--', path])
  expect(r.exitCode).toBe(0)
  return filterContentLines(parse(r.stdout))
}

/** The derivation exactly as `App.loadDiffPair` performs it. */
async function stagedIndices(path: string, combined: Line[]): Promise<number[]> {
  const cached = await git(['diff', '--no-color', '-U99999', '--cached', 'HEAD', '--', path])
  const unstaged = await git(['diff', '--no-color', '-U0', '--', path])
  return sorted(stagedIndicesFromDiffs(combined, cached.stdout, unstaged.stdout))
}

async function applyToIndex(patch: string) {
  const r = await git(['apply', '--cached', '--whitespace=nowarn'], patch)
  expect(r.stderr.trim() + r.stdout.trim()).toBe('')
  expect(r.exitCode).toBe(0)
}

/**
 * Stage `include`, read the painting back, and assert two things: the rows
 * asked for, and — the property that actually protects the index — that
 * re-applying the PAINTING reproduces the blob byte for byte. The second is
 * what the next toggle relies on; where git slides a run of identical lines
 * the painting is allowed to name a different member, and the blob must not
 * change for it.
 */
async function stageAndReadBack(path: string, head: string, work: string, include: number[]) {
  await commitBase(path, head)
  await Bun.write(join(dir, path), work)
  const combined = await worktreeDiff(path)
  await applyToIndex(buildPartialPatch(path, combined, new Set(include)))
  const blob = (await git(['show', `:${path}`])).stdout
  const painted = await stagedIndices(path, combined)

  await git(['restore', '--staged', '--', path])
  const again = buildPartialPatch(path, combined, new Set(painted))
  if (again !== '') await applyToIndex(again)
  expect((await git(['show', `:${path}`])).stdout, 'the painting re-applied').toBe(blob)
  return { combined, painted, blob }
}

test('git: scenario A — the bar function stages as its own four rows', async () => {
  const { painted, blob } = await stageAndReadBack('a.ts', HEAD_A, WORK_A, BAR_ROWS)
  expect(painted).toEqual(BAR_ROWS)
  expect(blob).toBe('head1\nhead2\nbar() {\n\n  b\n}\n')
})

test('git: scenario F — the middle chunk of a block with blanks', async () => {
  const { painted, blob } = await stageAndReadBack('f.txt', HEAD_F, WORK_F, MIDDLE_ROWS)
  expect(painted).toEqual(MIDDLE_ROWS)
  expect(blob).toBe('a\n\ntwo\n\nz\n')
})

test('git: slider — only the blank staged next to an existing blank', async () => {
  // Worktree a, "", Y, "", "", b over HEAD a, "", b. git puts the existing blank
  // wherever its heuristic likes in each of the three diffs; whichever blank
  // row ends up painted, exactly one of them is, and Y is not.
  const combined = await (async () => {
    await commitBase('s.txt', 'a\n\nb\n')
    await Bun.write(join(dir, 's.txt'), 'a\n\nY\n\n\nb\n')
    return worktreeDiff('s.txt')
  })()
  const blanks = combined
    .map((l, i) => (l.kind === LineKind.Add && l.text === '+' ? i : -1))
    .filter((i) => i >= 0)
  const y = combined.findIndex((l) => l.text === '+Y')
  expect(blanks).toHaveLength(2)
  await applyToIndex(buildPartialPatch('s.txt', combined, new Set([blanks[1]])))
  expect((await git(['show', ':s.txt'])).stdout).toBe('a\n\n\nb\n')

  const painted = await stagedIndices('s.txt', combined)
  expect(painted).toHaveLength(1)
  expect(blanks).toContain(painted[0])
  expect(painted).not.toContain(y)
})

test('git: slider — a deleted blank next to a blank that stays', async () => {
  const { combined, painted } = await stageAndReadBack('d.txt', 'a\n\n\nb\n', 'a\n\nb\nc\n', [
    2,
  ])
  expect(combined[2].kind).toBe(LineKind.Del)
  expect(painted).toEqual([2])
})

test('git: slider — `-foo`/`+}` next to an existing `}`', async () => {
  // The cached diff pairs the new `}` with the OLD line 3 and shows HEAD's `}`
  // as context after it; the worktree diff does the opposite. By content the
  // staged `}` used to vanish from the painting.
  const combined = await (async () => {
    await commitBase('b.ts', 'x {\n  foo\n}\n')
    await Bun.write(join(dir, 'b.ts'), 'x {\n}\n}\nz\n')
    return worktreeDiff('b.ts')
  })()
  const foo = combined.findIndex((l) => l.text === '-  foo')
  const brace = combined.findIndex((l) => l.text === '+}')
  const z = combined.findIndex((l) => l.text === '+z')
  expect([foo, brace, z].every((i) => i >= 0)).toBe(true)
  await applyToIndex(buildPartialPatch('b.ts', combined, new Set([foo, brace])))
  expect((await git(['show', ':b.ts'])).stdout).toBe('x {\n}\n}\n')
  expect(await stagedIndices('b.ts', combined)).toEqual([foo, brace].sort((a, b) => a - b))
})

test('git: a staged deletion with the file back in the working tree paints no Add', async () => {
  // Porcelain reports this path twice, `D ` and `??`. The `?` entry's diff is
  // `loadDiff`'s `--no-index` one — every line an Add — while the cached diff
  // is a non-empty `deleted file mode` and the index→worktree diff is blank,
  // because git diffs nothing it has no entry for. Blank read as "no unstaged
  // lines" painted the whole file staged with nothing in the index.
  await commitBase('g.txt', 'a\nb\nc\n')
  await git(['rm', '-q', '--', 'g.txt'])
  await Bun.write(join(dir, 'g.txt'), 'a\nX\nc\n')
  expect((await git(['status', '--porcelain', '--', 'g.txt'])).stdout).toBe('D  g.txt\n?? g.txt\n')
  const r = await git(['diff', '--no-index', '--no-color', '-U99999', '--', '/dev/null', 'g.txt'])
  const combined = filterContentLines(parse(r.stdout))
  expect(combined.map((l) => l.kind)).toEqual([LineKind.Add, LineKind.Add, LineKind.Add])
  expect(await stagedIndices('g.txt', combined)).toEqual([])
})

// ---------------------------------------------------------- the second press

async function openOn(path: string): Promise<App> {
  const app = new App(SOURCE, new Store())
  await app.loadFiles()
  const file = app.findFile(path)
  expect(file).not.toBeNull()
  app.selectedPath = path
  await app.loadDiffFor(file!)
  return app
}

test('the second press builds on a correct painting', async () => {
  // Stage the bar function through the real key path, let the queue drain and
  // hand painting back to git's answer, then toggle ONE more row. With the
  // painting read by content the desired set was {1, 2, 4, 6, 8}-shaped and the
  // reset-then-apply wrote it into the index.
  await commitBase('a.ts', HEAD_A)
  await Bun.write(join(dir, 'a.ts'), WORK_A)
  const app = await openOn('a.ts')

  app.selectionAnchor = BAR_ROWS[0]
  app.contentCursor = BAR_ROWS[BAR_ROWS.length - 1]
  toggleStaged(app)
  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect(app.stagingIntent.size).toBe(0)
  expect(sorted(app.staged.get('a.ts') ?? null)).toEqual(BAR_ROWS)
  expect((await git(['show', ':a.ts'])).stdout).toBe('head1\nhead2\nbar() {\n\n  b\n}\n')

  // Row 2 is `foo() {`. The desired set must be the four bar rows plus it.
  app.selectionAnchor = -1
  app.contentCursor = 2
  toggleStaged(app)
  expect(sorted(app.stagingIntent.get('a.ts') ?? null)).toEqual([2, ...BAR_ROWS])
  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect((await git(['show', ':a.ts'])).stdout).toBe('head1\nhead2\nfoo() {\nbar() {\n\n  b\n}\n')
  expect(sorted(app.staged.get('a.ts') ?? null)).toEqual([2, ...BAR_ROWS])

  // And back off again: the same row, now staged, unstages alone.
  toggleStaged(app)
  await app.stagingIdle()
  expect(app.err).toBeNull()
  expect((await git(['show', ':a.ts'])).stdout).toBe('head1\nhead2\nbar() {\n\n  b\n}\n')
  expect(sorted(app.staged.get('a.ts') ?? null)).toEqual(BAR_ROWS)
})
