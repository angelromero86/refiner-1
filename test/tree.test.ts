/**
 * `dirState` — what a folder name's color claims.
 *
 * The claim is about the CHANGES under a directory, never about its files, and
 * the difference only shows in ALL mode, where the tree lists the whole repo and
 * most files under any given folder are unchanged. Deriving the state from "is
 * every file staged?" makes every folder in the repo read as work outstanding,
 * which is what it used to do.
 *
 * The porcelain codes are the input, so they are spelled out here rather than
 * built by a helper: `' '`/`' '` (unchanged) and `'M'`/`' '` (fully staged) are
 * one character apart and mean opposite things.
 */

import { expect, test, describe } from 'bun:test'
import { build, dirState, DirState, type DirNode } from '../src/tree.ts'
import type { ChangedFile, Status } from '../src/git.ts'

const file = (path: string, status: Status, indexCode: string, workCode: string): ChangedFile => ({
  path,
  status,
  indexCode,
  workCode,
})

/** A file with no changes at all — only ALL mode produces these. */
const unchanged = (path: string) => file(path, ' ', ' ', ' ')
const unstaged = (path: string) => file(path, 'M', ' ', 'M')
const staged = (path: string) => file(path, 'M', 'M', ' ')
/** Staged edit plus a further edit on top of it. */
const partial = (path: string) => file(path, 'M', 'M', 'M')
const untracked = (path: string) => file(path, '?', '?', '?')

/** The top-level directory of a tree built from `files`. */
const dir = (files: ChangedFile[], name = 'src'): DirNode => {
  const node = build(files).find((n): n is DirNode => n.type === 'dir' && n.name === name)
  expect(node).toBeDefined()
  return node!
}

describe('dirState', () => {
  test('a folder with nothing changed under it is Clean', () => {
    expect(dirState(dir([unchanged('src/a.ts'), unchanged('src/b.ts')]))).toBe(DirState.Clean)
  })

  test('one unstaged change anywhere below makes it Unstaged', () => {
    expect(dirState(dir([unstaged('src/a.ts')]))).toBe(DirState.Unstaged)
    // Buried under unchanged siblings, which is the ALL-mode shape.
    expect(dirState(dir([unchanged('src/a.ts'), unchanged('src/b.ts'), unstaged('src/deep/c.ts')]))).toBe(
      DirState.Unstaged,
    )
    // An untracked file is unstaged too: nothing of it is in the index yet.
    expect(dirState(dir([untracked('src/new.ts')]))).toBe(DirState.Unstaged)
    // Half in the index still leaves work to do.
    expect(dirState(dir([partial('src/a.ts')]))).toBe(DirState.Unstaged)
  })

  test('everything that changed is in the index → Staged', () => {
    expect(dirState(dir([staged('src/a.ts')]))).toBe(DirState.Staged)
    // Unchanged files must not hold the folder back — this is the case that used
    // to paint the entire repo in the "needs attention" color.
    expect(dirState(dir([staged('src/a.ts'), unchanged('src/b.ts'), unchanged('src/c.ts')]))).toBe(DirState.Staged)
  })

  test('the state of a parent is the worst state below it', () => {
    const root = dir([staged('src/deep/a.ts'), unstaged('src/other/b.ts')])
    expect(dirState(root)).toBe(DirState.Unstaged)
    const deep = root.children.find((c): c is DirNode => c.type === 'dir' && c.name === 'deep')!
    expect(dirState(deep)).toBe(DirState.Staged)
    const other = root.children.find((c): c is DirNode => c.type === 'dir' && c.name === 'other')!
    expect(dirState(other)).toBe(DirState.Unstaged)
  })

  test('a folder holding only empty folders is Clean, not Staged', () => {
    // Not reachable from `build` (every leaf is a file), but the recursion has to
    // return the neutral answer rather than inheriting one.
    const empty: DirNode = { type: 'dir', name: 'x', path: 'x', children: [] }
    expect(dirState(empty)).toBe(DirState.Clean)
    expect(dirState({ type: 'dir', name: 'y', path: 'y', children: [empty] })).toBe(DirState.Clean)
  })
})
