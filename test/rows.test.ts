/**
 * Where a thread's card lands in the row stream (`src/rows.ts`).
 *
 * The rule: after the last active row carrying the thread's last line; failing
 * that, after the last row with a lower working-tree line; failing that, at the
 * top. A del-only row is not a working-tree line and never hosts one. Threads
 * therefore never vanish from the pane, which is the whole point of doing it
 * this way instead of the modal.
 */
import { expect, test } from 'bun:test'
import { ViewMode } from '../src/app.ts'
import { COMPOSE_NEW_ROWS, COMPOSE_ROWS, hostFor } from '../src/rows.ts'
import { FILE, diffOf, openPane, rowKinds, thread } from './pane.ts'

test('a card follows the row carrying its last line', () => {
  const app = openPane({ threads: [thread('t-A', 3, 4)] })
  // newNum 4 is unified idx 4.
  expect(rowKinds(app)).toEqual([
    'd0', 'd1', 'd2', 'd3', 'd4', 'c:t-A:0', 'c:t-A:1', 'd5', 'd6', 'd7', 'd8', 'd9',
  ])
  const layout = app.activeLayout()
  expect(layout.cardStart.get('t-A')).toBe(5)
  expect(layout.diffToDisplay).toEqual([0, 1, 2, 3, 4, 7, 8, 9, 10, 11])
})

test('a line outside the diff context lands after the nearest lower row', () => {
  // The diff only reaches line 9; a thread on 20-21 sits after the last row.
  const app = openPane({ threads: [thread('t-A', 20, 21)] })
  const kinds = rowKinds(app)
  expect(kinds.slice(-3)).toEqual(['d9', 'c:t-A:0', 'c:t-A:1'])
})

test('a thread below every row goes to the top', () => {
  // The diff's first line is 5; a thread on line 2 has nothing to sit under.
  const app = openPane({
    diff: diffOf([' five', '+six', ' seven'], '@@ -5,3 +5,3 @@'),
    threads: [thread('t-A', 2, 2)],
  })
  expect(rowKinds(app).slice(0, 3)).toEqual(['c:t-A:0', 'c:t-A:1', 'd0'])
})

test('a del-only row never hosts a card', () => {
  // Unified idx 2 is the deletion (newNum 0). A thread ending on line 2 sits
  // under idx 1 (newNum 2), not under the deletion.
  const app = openPane({ threads: [thread('t-A', 2, 2)] })
  expect(rowKinds(app).slice(0, 5)).toEqual(['d0', 'd1', 'c:t-A:0', 'c:t-A:1', 'd2'])
  expect(hostFor([{ newNum: 1 }, { newNum: 0 }, { newNum: 0 }], 2)).toEqual({ idx: 0, exact: false })
})

test('two threads on the same line keep store order', () => {
  const app = openPane({ threads: [thread('t-B', 4, 4), thread('t-A', 2, 4)] })
  // Sorted by range.start: t-A (2) before t-B (4).
  expect(rowKinds(app).slice(4, 10)).toEqual([
    'd4', 'c:t-A:0', 'c:t-A:1', 'c:t-B:0', 'c:t-B:1', 'd5',
  ])
  const same = openPane({ threads: [thread('t-B', 4, 4), thread('t-A', 4, 4)] })
  // Equal starts: the store's order, which is the file's order.
  expect(rowKinds(same).slice(5, 9)).toEqual(['c:t-B:0', 'c:t-B:1', 'c:t-A:0', 'c:t-A:1'])
})

test('collapsed, expanded and resolved cards have their own heights', () => {
  const app = openPane({
    threads: [
      thread('t-open', 1, 1, { bodies: ['one paragraph'] }),
      thread('t-done', 2, 2, { status: 'resolved' }),
    ],
  })
  let kinds = rowKinds(app)
  expect(kinds.filter((k) => k.startsWith('c:t-open'))).toHaveLength(2)
  expect(kinds.filter((k) => k.startsWith('c:t-done'))).toHaveLength(1)

  // Expanded: header + 1 body row + trailing bar row.
  app.expandedThreads.add('t-open')
  app.threadsEpoch++
  kinds = rowKinds(app)
  expect(kinds.filter((k) => k.startsWith('c:t-open'))).toHaveLength(3)
  // A resolved thread expands like any other.
  app.expandedThreads.add('t-done')
  app.threadsEpoch++
  kinds = rowKinds(app)
  expect(kinds.filter((k) => k.startsWith('c:t-done'))).toHaveLength(3)
  // Every card row knows the card's total.
  for (const r of app.activeLayout().rows) {
    if (r.kind === 'card') expect(r.lines).toBe(3)
  }
})

test('the compose block goes under its card, or under the anchor line for a new thread', () => {
  const app = openPane({ threads: [thread('t-A', 3, 4)] })
  app.compose = { kind: 'reply', threadId: 't-A', file: '', start: 0, end: 0, commentId: '' }
  let layout = app.activeLayout()
  expect(layout.composeStart).toBe(7)
  expect(rowKinds(app).slice(5, 7 + COMPOSE_ROWS + 1)).toEqual([
    'c:t-A:0', 'c:t-A:1', ...Array.from({ length: COMPOSE_ROWS }, (_, i) => `x${i}`), 'd5',
  ])

  // A new thread over lines 6-7: right after unified idx 7 (newNum 7), with
  // its own header row on top.
  app.compose = { kind: 'new', threadId: '', file: FILE, start: 6, end: 7, commentId: '' }
  layout = app.activeLayout()
  expect(layout.composeStart).toBe(layout.diffToDisplay[7] + 1)
  const block = layout.rows.slice(layout.composeStart, layout.composeStart + COMPOSE_NEW_ROWS)
  expect(block.every((r) => r.kind === 'compose' && r.lines === COMPOSE_NEW_ROWS)).toBe(true)
  expect(layout.rows[layout.composeStart + COMPOSE_NEW_ROWS]).toEqual({ kind: 'diff', idx: 8 })

  app.compose = null
  expect(app.activeLayout().composeStart).toBe(-1)
})

test('split and current views place cards by their own rows', () => {
  const app = openPane({ threads: [thread('t-A', 5, 5)] })
  // Unified: the addition is idx 5.
  expect(app.activeLayout().cardStart.get('t-A')).toBe(6)
  app.viewMode = ViewMode.Current
  // Current view drops the deletion: `added five` is idx 4.
  const cur = app.activeLayout()
  expect(cur.rows[cur.cardStart.get('t-A')! - 1]).toEqual({ kind: 'diff', idx: 4 })
  app.viewMode = ViewMode.Split
  const split = app.activeLayout()
  const host = split.rows[split.cardStart.get('t-A')! - 1]
  expect(host.kind).toBe('diff')
  expect(app.cache.get(FILE)!.split[(host as { idx: number }).idx].newNum).toBe(5)
})

test('the layout is memoized until threadsEpoch moves', () => {
  const app = openPane({ threads: [thread('t-A', 3, 4)] })
  const a = app.activeLayout()
  expect(app.activeLayout()).toBe(a)
  app.expandedThreads.add('t-A')
  // Not yet: the memo has not been told.
  expect(app.activeLayout()).toBe(a)
  app.threadsEpoch++
  const b = app.activeLayout()
  expect(b).not.toBe(a)
  expect(b.rows.length).toBeGreaterThan(a.rows.length)
  // A different width is a different layout, and both stay cached.
  const narrow = app.layout(30)
  expect(app.layout(30)).toBe(narrow)
  expect(app.activeLayout()).toBe(b)
})

test('no file, no rows', () => {
  const app = openPane()
  app.selectedPath = ''
  expect(app.activeLayout().rows).toEqual([])
})
