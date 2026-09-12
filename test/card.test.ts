/**
 * The card rows (`src/card.ts`): exactly `width` columns in every shape, and
 * the header saying what it should.
 */
import { describe, expect, test } from 'bun:test'
import type { TextChunk } from '@opentui/core'
import { paintCardRow, renderCard } from '../src/card.ts'
import { S } from '../src/styles.ts'
import { formatStamp, width } from '../src/text.ts'
import { thread } from './pane.ts'

const text = (row: TextChunk[]) => row.map((c) => c.text).join('')
const lines = (rows: TextChunk[][]) => rows.map(text)

const opts = { width: 60, expanded: false, drift: null, hostExact: true }

const variants = {
  collapsed: [thread('t', 3, 4), opts],
  expanded: [
    thread('t', 3, 4, {
      bodies: [
        '[must-fix] `hunkStarts` ignores the last hunk.\n\n```ts\nreturn out\n```\n\n- one\n- two',
        'Fixed in a follow-up.',
      ],
      authors: ['Claude Code', 'angel'],
    }),
    { ...opts, expanded: true },
  ],
  resolved: [thread('t', 3, 4, { status: 'resolved' }), opts],
  resolvedExpanded: [thread('t', 3, 4, { status: 'resolved' }), { ...opts, expanded: true }],
  moved: [thread('t', 3, 4), { ...opts, drift: { status: 'moved', from: { start: 1, end: 2 } } }],
  lost: [
    thread('t', 3, 4),
    { ...opts, drift: { status: 'lost', from: { start: 1, end: 2 } }, hostExact: false },
  ],
  offLine: [thread('t', 30, 41), { ...opts, hostExact: false }],
  wide: [
    thread('t', 3, 4, {
      bodies: ['日本語のコメントが長くて長くて長くて長くて長くて長くて長くて長くて長くて長い'],
      authors: ['名前'],
    }),
    opts,
  ],
} as const

describe('width', () => {
  for (const [name, [t, o]] of Object.entries(variants)) {
    for (const w of [12, 24, 60, 121]) {
      test(`${name} at ${w}`, () => {
        const rows = renderCard(t, { ...o, width: w })
        expect(rows.length).toBeGreaterThan(0)
        rows.forEach((row, i) => {
          expect({ i, w: width(text(row)) }).toEqual({ i, w })
          for (const c of row) expect(c.text).not.toBe('')
        })
      })
    }
  }
})

describe('shape', () => {
  test('collapsed: header, then the last comment previewed', () => {
    const t = thread('t', 3, 4, { bodies: ['opener text', 'the reply'], authors: ['Claude', 'angel'] })
    const rows = lines(renderCard(t, opts))
    expect(rows).toHaveLength(2)
    const stamp = formatStamp(t.comments[1].createdAt)
    expect(rows[0]).toBe(` ┃ @Claude · ${stamp} · 2 comments`.padEnd(60))
    expect(rows[1]).toBe(' ┃ the reply'.padEnd(60))
  })

  test('the header carries the severity of the opener and no count for one comment', () => {
    const t = thread('t', 3, 4, { bodies: ['[nit] trailing space'] })
    const [head, preview] = lines(renderCard(t, opts))
    expect(head).toMatch(/^ ┃ @someone · nit · \S/)
    expect(head).not.toContain('comments')
    expect(preview.trimEnd()).toBe(' ┃ trailing space')
  })

  test('a long preview is cut with an ellipsis', () => {
    const t = thread('t', 3, 4, { bodies: ['word '.repeat(40)] })
    const [, preview] = lines(renderCard(t, { ...opts, width: 30 }))
    expect(width(preview)).toBe(30)
    expect(preview.trimEnd().endsWith('…')).toBe(true)
  })

  test('resolved collapses to one muted row', () => {
    const t = thread('t', 3, 4, { status: 'resolved', bodies: ['[question] why?'] })
    const rows = renderCard(t, opts)
    expect(rows).toHaveLength(1)
    expect(text(rows[0]).trimEnd()).toBe(' ┃ ✓ @someone · question · why?')
    for (const c of rows[0]) if (c.text.trim() !== '') expect(c.fg).toEqual(S.dim.fg)
  })

  test('expanded: author rows, markdown bodies, a rule between comments, a blank bar row last', () => {
    const [t, o] = variants.expanded
    const rows = lines(renderCard(t, o))
    // Header, then the opener's body straight away: no second author row, and
    // the badge is the body's, not the header's.
    expect(rows[0]).toMatch(/^ ┃ @Claude Code · \S.* · 2 comments/)
    expect(rows[0]).not.toContain('must-fix')
    expect(rows[1].trimEnd()).toBe(' ┃ must-fix hunkStarts ignores the last hunk.')
    expect(rows).toContain(' ┃   return out'.padEnd(60))
    expect(rows).toContain(' ┃ • one'.padEnd(60))
    const rule = rows.indexOf(' ┃ ───'.padEnd(60))
    expect(rule).toBeGreaterThan(1)
    expect(rows[rule + 1]).toMatch(/^ ┃ @angel · /)
    expect(rows[rule + 2].trimEnd()).toBe(' ┃ Fixed in a follow-up.')
    expect(rows[rows.length - 1]).toBe(' ┃'.padEnd(60))
  })

  test('drift and an off-line host show in the header', () => {
    expect(lines(renderCard(...variants.moved))[0]).toContain(' · moved from L1')
    const lost = lines(renderCard(...variants.lost))[0]
    expect(lost).toContain(' · lost — was L1-2')
    expect(lost).toContain(' · L3-4')
    expect(lines(renderCard(...variants.offLine))[0]).toContain(' · L30-41')
    expect(lines(renderCard(...variants.collapsed))[0]).not.toContain(' · L3')
  })

  test('the bar takes the thread color, or the muted one once resolved', () => {
    const open = renderCard(...variants.collapsed)[0][1]
    expect(open.text).toBe('┃')
    expect(open.fg).toEqual(S.palette.threadMarker)
    const done = renderCard(...variants.resolved)[0][1]
    expect(done.fg).toEqual(S.palette.muted)
  })

  test('painting a row keeps every foreground and sets one background', () => {
    const row = renderCard(...variants.collapsed)[0]
    const painted = paintCardRow(row, S.palette.cursorBg)
    expect(text(painted)).toBe(text(row))
    painted.forEach((c, i) => {
      expect(c.bg).toEqual(S.palette.cursorBg)
      expect(c.fg).toEqual(row[i].fg)
    })
  })
})
