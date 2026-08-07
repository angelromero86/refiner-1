/**
 * Hunk navigation (`h` / `H`).
 *
 * "Hunk" here is not git's: refiner asks for `-U99999`, so git calls the whole file
 * one hunk and the `@@` headers never reach the cache. What the reviewer sees as a
 * hunk is a contiguous run of changed rows, and that is what gets jumped between.
 *
 * The caller flattens its rows to booleans first, so this is view-independent — the
 * same function serves unified, split and post-change.
 */
import { expect, test } from 'bun:test'
import { filterContentLines, hunkStarts, LineKind, parse } from '../src/diff.ts'

const B = (pattern: string): boolean[] => [...pattern].map((c) => c === 'x')

test('finds the first row of each run', () => {
  //          0123456789
  expect(hunkStarts(B('..xx...x..'))).toEqual([2, 7])
})

test('a run touching either edge still counts', () => {
  expect(hunkStarts(B('xx...'))).toEqual([0])
  expect(hunkStarts(B('...xx'))).toEqual([3])
  expect(hunkStarts(B('xxxxx'))).toEqual([0])
})

test('adjacent single rows are separate hunks only when context separates them', () => {
  // One unbroken run, however long.
  expect(hunkStarts(B('xxxx'))).toEqual([0])
  // A single context row is enough to split it.
  expect(hunkStarts(B('xx.xx'))).toEqual([0, 3])
  expect(hunkStarts(B('x.x.x'))).toEqual([0, 2, 4])
})

test('no changes means nothing to jump to', () => {
  expect(hunkStarts(B('.....'))).toEqual([])
  expect(hunkStarts([])).toEqual([])
})

test('matches what a real diff looks like', () => {
  // Two edits separated by untouched lines, as -U99999 would report them.
  const diff = [
    'diff --git a/f.ts b/f.ts',
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -1,6 +1,6 @@',
    ' keep one',
    '-old two',
    '+new two',
    ' keep three',
    ' keep four',
    '-old five',
    '+new five',
    ' keep six',
    '',
  ].join('\n')

  const lines = filterContentLines(parse(diff))
  const changed = lines.map((l) => l.kind === LineKind.Add || l.kind === LineKind.Del)
  // rows: ctx del add ctx ctx del add ctx
  expect(changed).toEqual([false, true, true, false, false, true, true, false])
  expect(hunkStarts(changed)).toEqual([1, 5])
})

test('the post-change view sees one hunk where unified sees a del+add pair', () => {
  const diff = [
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    ' keep',
    '',
  ].join('\n')
  const lines = filterContentLines(parse(diff))

  // Unified counts the deletion and the addition as one contiguous block.
  expect(hunkStarts(lines.map((l) => l.kind === LineKind.Add || l.kind === LineKind.Del))).toEqual([
    1,
  ])
  // The post-change view hides deletions, so only the addition remains — still one
  // hunk, but starting at a different row, which is why the flags are rebuilt per
  // view rather than computed once.
  const current = lines.filter((l) => l.kind !== LineKind.Del)
  expect(hunkStarts(current.map((l) => l.kind === LineKind.Add))).toEqual([1])
})
