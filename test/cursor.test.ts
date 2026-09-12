/**
 * The cursor lives in DISPLAY space: it walks through a card's rows like any
 * other row, and everything that needs a diff row — staging, hunks — maps
 * through `diffIdxAt` and skips what is not one.
 */
import { expect, test } from 'bun:test'
import type { CliRenderer } from '@opentui/core'
import { route } from '../src/dispatch.ts'
import { toggleStaged } from '../src/staging.ts'
import { FILE, openPane, thread } from './pane.ts'

/** Nothing here reaches the renderer; the key handlers that would (⌃c, g, s) are not pressed. */
const renderer = {} as CliRenderer
const press = (app: ReturnType<typeof openPane>, ...keys: string[]) => {
  for (const k of keys) route(app, renderer, k)
}

/** A pane with one EXPANDED card under unified idx 4 (line 4). */
function expandedPane() {
  const app = openPane({
    threads: [thread('t-A', 3, 4, { bodies: ['a paragraph\n\nand another'] })],
  })
  app.expandedThreads.add('t-A')
  app.threadsEpoch++
  return app
}

test('down walks through every row of an expanded card', () => {
  const app = expandedPane()
  const layout = app.activeLayout()
  const start = layout.cardStart.get('t-A')!
  const lines = (layout.rows[start] as { lines: number }).lines
  expect(lines).toBeGreaterThan(2)

  app.contentCursor = start - 1
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 4 })
  for (let line = 0; line < lines; line++) {
    press(app, 'down')
    expect(app.cursorRow()).toEqual({ kind: 'card', threadId: 't-A', line, lines })
    expect(app.threadAtCursor()?.id).toBe('t-A')
    expect(app.cursorLine()).toBe(4)
    expect(app.contentLineLabel()).toBe(`thread · ${line + 1}/${lines}`)
  }
  press(app, 'down')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 5 })
  expect(app.cursorLine()).toBe(5)
  // And back up through it.
  press(app, 'up')
  expect(app.cursorRow()).toEqual({ kind: 'card', threadId: 't-A', line: lines - 1, lines })
  // `end` is the last display row, which here is a diff row.
  press(app, 'end')
  expect(app.contentCursor).toBe(app.displayRowCount() - 1)
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 9 })
})

test('space on a card row queues nothing', () => {
  const app = expandedPane()
  app.contentCursor = app.activeLayout().cardStart.get('t-A')! + 1
  press(app, ' ')
  expect(app.stagingPending.size).toBe(0)
  expect(app.stagingRunning).toBeNull()
  expect(app.stagingIntent.size).toBe(0)
})

test('h lands on the display index of the hunk start', () => {
  const app = expandedPane()
  // Hunks in unified: the deletion at idx 2, the addition at idx 5. The card
  // sits between them, so idx 5 is NOT display row 5.
  app.contentCursor = 0
  press(app, 'h')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 2 })
  press(app, 'h')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 5 })
  expect(app.contentCursor).toBe(app.displayIdxOfDiff(5))
  expect(app.contentCursor).toBeGreaterThan(5)
  // From inside the card, "next" is still the hunk after it.
  app.contentCursor = app.activeLayout().cardStart.get('t-A')! + 1
  press(app, 'h')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 5 })
  press(app, 'H')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 2 })
  // Wraps.
  press(app, 'H')
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 5 })
})

test('staging a selection that spans a card stages exactly the diff rows', () => {
  const app = expandedPane()
  // Hold the queue so the job can be inspected instead of handed to git.
  app.stagingRunning = new Promise<void>(() => {})
  const layout = app.activeLayout()
  // From the deletion (idx 2) down through the card to the addition (idx 5).
  app.selectionAnchor = layout.diffToDisplay[2]
  app.contentCursor = layout.diffToDisplay[5]
  toggleStaged(app)
  const job = app.stagingPending.get(FILE)
  expect(job?.kind).toBe('partial')
  if (job?.kind !== 'partial') throw new Error('unreachable')
  // Unified indices 2 (del) and 5 (add); the ctx rows and the card rows are not lines.
  expect([...job.desired].sort()).toEqual([2, 5])
  expect([...app.stagedFor(FILE)].sort()).toEqual([2, 5])
})

test('the selection paints across the card but the count stays in diff rows', () => {
  const app = expandedPane()
  const layout = app.activeLayout()
  app.contentCursor = layout.diffToDisplay[4]
  press(app, 'shift+down', 'shift+down')
  const [a, b] = app.selectionRange()
  expect(a).toBe(layout.diffToDisplay[4])
  expect(b).toBe(layout.cardStart.get('t-A')! + 1)
  expect(app.cursorRow()?.kind).toBe('card')
  expect(app.contentLineLabel()).toBe(`thread · 2/${(layout.rows[b] as { lines: number }).lines}`)
})

test('a layout change under the cursor keeps it on the same thing', () => {
  const app = expandedPane()
  const layout = app.activeLayout()
  // On the diff row under the card.
  app.contentCursor = layout.diffToDisplay[6]
  app.withStableCursor(() => app.expandedThreads.delete('t-A'))
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 6 })
  expect(app.contentCursor).toBeLessThan(layout.diffToDisplay[6])

  // On the card's header: expanding keeps the header; collapsing clamps the line.
  app.contentCursor = app.cardStartOf('t-A')
  app.withStableCursor(() => app.expandedThreads.add('t-A'))
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A', line: 0 })
  app.contentCursor = app.cardStartOf('t-A') + 3
  app.withStableCursor(() => app.expandedThreads.delete('t-A'))
  expect(app.cursorRow()).toMatchObject({ kind: 'card', threadId: 't-A', line: 1 })

  // The card's thread deleted: the cursor drops to the code it sat under.
  app.withStableCursor(() => app.store.deleteThread('t-A'))
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 4 })
})

test('navigateToPendingLine lands in display space', () => {
  const app = expandedPane()
  app.pendingNavLine = 6
  app.navigateToPendingLine()
  expect(app.cursorRow()).toEqual({ kind: 'diff', idx: 6 })
  expect(app.contentCursor).toBe(app.displayIdxOfDiff(6))
})
