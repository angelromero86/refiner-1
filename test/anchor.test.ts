/**
 * `src/anchor.ts` is a port of the VSCode extension's algorithm, so the first
 * half pins the behaviour the two clients must agree on (an anchor written by
 * one is relocated by the other). The second half covers what refiner adds on
 * top: the fuzzy fallback and the guard against a trivial anchor teleporting.
 */
import { expect, test } from 'bun:test'
import { captureAnchor, relocate, splitLines } from '../src/anchor.ts'

const ORIGINAL = `import { a } from './a'
import { b } from './b'

export function compute(x: number): number {
  const y = a(x)
  const z = b(y)
  return y + z
}

export function other(): void {
  console.log('other')
}
`

function lines(text: string): string[] {
  return splitLines(text)
}

/** The four-line body of `compute`, L5-L7 plus the closing brace. */
function bodyAnchor() {
  return captureAnchor(lines(ORIGINAL), 5, 8)
}

test('captureAnchor snapshots the range and CTX=3 lines of context on each side', () => {
  const a = captureAnchor(lines(ORIGINAL), 5, 6)
  expect(a.lines).toEqual(['  const y = a(x)', '  const z = b(y)'])
  expect(a.before).toEqual(["import { b } from './b'", '', 'export function compute(x: number): number {'])
  expect(a.after).toEqual(['  return y + z', '}', ''])
})

test('captureAnchor clamps a range that runs past the end of the file', () => {
  const a = captureAnchor(['one', 'two'], 2, 9)
  expect(a.lines).toEqual(['two'])
  expect(a.before).toEqual(['one'])
  expect(a.after).toEqual([])
  expect(captureAnchor(['one', 'two'], 5, 9).lines).toEqual([])
})

test('unchanged file relocates exactly', () => {
  const res = relocate(lines(ORIGINAL), bodyAnchor(), 5)
  expect(res).toEqual({ start: 5, end: 8, status: 'exact', confidence: 'exact' })
})

test('insertions above shift the thread and report moved', () => {
  const edited = "import { c } from './c'\nimport { d } from './d'\n" + ORIGINAL
  const res = relocate(lines(edited), bodyAnchor(), 5)
  expect(res).toEqual({ start: 7, end: 10, status: 'moved', confidence: 'context' })
})

test('a duplicated snippet is disambiguated by its context', () => {
  // The same two lines appear in two functions; only one has `compute` above it.
  const text = `function first(): void {
  const y = a(x)
  const z = b(y)
}

export function compute(x: number): number {
  const y = a(x)
  const z = b(y)
  return y + z
}
`
  const anchor = captureAnchor(lines(text), 7, 8)
  // Both copies move down by three; the closer one is the WRONG one.
  const edited = '// 1\n// 2\n// 3\n' + text
  const res = relocate(lines(edited), anchor, 7)
  expect(res.status).toBe('moved')
  expect(res.start).toBe(10)
  expect(res.end).toBe(11)

  // Without context, proximity decides — which is the extension's tie-break.
  const bare = { lines: anchor.lines, before: [], after: [] }
  expect(relocate(lines(edited), bare, 7).start).toBe(5)
})

test('a deleted snippet is lost, and keeps its previous range', () => {
  const edited = ORIGINAL.replace('  const y = a(x)\n  const z = b(y)\n  return y + z\n', '  return 0\n')
  const res = relocate(lines(edited), bodyAnchor(), 5)
  expect(res).toEqual({ start: 5, end: 8, status: 'lost', confidence: 'none' })
})

test('a trailing-whitespace-only change is still exact', () => {
  const edited = ORIGINAL.replace('  const y = a(x)\n', '  const y = a(x)   \n').replace(
    '  return y + z\n',
    '  return y + z\t\n',
  )
  const res = relocate(lines(edited), bodyAnchor(), 5)
  expect(res.status).toBe('exact')
  expect(res.confidence).toBe('exact')
})

test('an anchor captured longer than the current file is lost, not clamped onto it', () => {
  const anchor = { lines: ['a', 'b', 'c', 'd'], before: [], after: [] }
  const res = relocate(['a', 'b'], anchor, 1)
  expect(res.status).toBe('lost')
  expect(res.start).toBe(1)
})

test('an empty anchor is lost', () => {
  const res = relocate(lines(ORIGINAL), { lines: [], before: [], after: [] }, 3)
  expect(res).toEqual({ start: 3, end: 3, status: 'lost', confidence: 'none' })
})

// ------------------------------------------------------------------- fuzzy

test('fuzzy: one edited line out of four still relocates, as moved', () => {
  const edited = ORIGINAL.replace('  const z = b(y)\n', '  const z = b(y) * 2\n')
  const res = relocate(lines(edited), bodyAnchor(), 5)
  expect(res).toEqual({ start: 5, end: 8, status: 'moved', confidence: 'fuzzy' })
})

test('fuzzy: the edited block also follows a shift', () => {
  const edited = ('// header\n// header\n' + ORIGINAL).replace(
    '  const z = b(y)\n',
    '  const z = b(y) * 2\n',
  )
  const res = relocate(lines(edited), bodyAnchor(), 5)
  expect(res).toEqual({ start: 7, end: 10, status: 'moved', confidence: 'fuzzy' })
})

test('fuzzy: two edited lines out of four is below the bar and lost', () => {
  const edited = ORIGINAL.replace('  const y = a(x)\n  const z = b(y)\n', '  const y = 1\n  const z = 2\n')
  expect(relocate(lines(edited), bodyAnchor(), 5).status).toBe('lost')
})

test('fuzzy: a window whose only matching lines are braces does not count', () => {
  const text = `function foo(): void {
  foo()
}
}
`
  // Anchor on `foo()` + two closing braces; the file now has a different call
  // followed by the same braces. Two of three lines match, but nothing
  // informative does.
  const anchor = captureAnchor(lines(text), 2, 4)
  const edited = text.replace('  foo()', '  bar()')
  expect(relocate(lines(edited), anchor, 2).status).toBe('lost')
})

test('fuzzy: a partial match far away needs a context line to agree', () => {
  const body = ['  const y = a(x)', '  const z = b(y)', '  return y + z']
  const filler = Array.from({ length: 60 }, (_, i) => `// filler ${i}`)
  const anchor = { lines: body, before: ['function f() {'], after: ['}'] }
  // Far away, two of three lines match, and neither neighbour is the one we knew.
  const stranger = [...filler, 'function g() {', body[0], '  const z = c(y)', body[2], '}']
  expect(relocate(stranger, anchor, 1).status).toBe('lost')
  // Same distance, but the surroundings agree: accepted.
  const known = [...filler, 'function f() {', body[0], '  const z = c(y)', body[2], '}']
  const res = relocate(known, anchor, 1)
  expect(res.status).toBe('moved')
  expect(res.start).toBe(62)
})

// ------------------------------------------------------------- common line

test('a lone `}` does not teleport to a distant brace when its own is gone', () => {
  const text = ['function a() {', '  x()', '}', ...Array.from({ length: 40 }, (_, i) => `// ${i}`), 'function b() {', '  y()', '}']
  const anchor = captureAnchor(text, 3, 3)
  expect(anchor.lines).toEqual(['}'])
  // `a` is rewritten as a one-liner: its brace is gone, b's is 40 lines down.
  const edited = ['const a = () => x()', ...text.slice(3)]
  expect(relocate(edited, anchor, 3).status).toBe('lost')
})

test('a lone `}` still follows a small shift, and a large one when context agrees', () => {
  const text = ['function a() {', '  x()', '}', ...Array.from({ length: 40 }, (_, i) => `// ${i}`), 'function b() {', '  y()', '}']
  const anchor = captureAnchor(text, 3, 3)
  // Two lines inserted above: near, accepted without asking for context.
  const near = ['// new', '// new', ...text]
  expect(relocate(near, anchor, 3)).toMatchObject({ start: 5, status: 'moved' })
  // Whole function a moved to the bottom: far, but `x()` above it still matches.
  const far = [...text.slice(3), 'function a() {', '  x()', '}']
  const res = relocate(far, anchor, 3)
  expect(res.status).toBe('moved')
  expect(res.start).toBe(far.length)
})
