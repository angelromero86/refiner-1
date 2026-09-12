/**
 * The comment-body markdown renderer.
 *
 * The one thing that must never regress is the row width: the diff pane draws
 * these rows inline with `wrapMode: 'none'`, so a row one column off shifts
 * every row under it. The corpus below is chosen to hit the ways that goes
 * wrong — wide graphemes, tabs, words longer than the pane, fences with no
 * closer — at a spread of widths. The rest pins the vocabulary agents write in
 * (`skills/refine-review/SKILL.md`) and the styles that land on it.
 */
import { describe, expect, test } from 'bun:test'
import { createTextAttributes, type TextChunk } from '@opentui/core'
import { firstLine, renderMarkdown, severityOf } from '../src/markdown.ts'
import { applyTheme, chunk, S } from '../src/styles.ts'
import { themeByName } from '../src/theme.ts'
import { width } from '../src/text.ts'

const text = (row: TextChunk[]) => row.map((c) => c.text).join('')
const lines = (body: string, w: number) => renderMarkdown(body, { width: w }).map(text)

/** The example body from SKILL.md, verbatim. */
const SKILL_BODY =
  '[must-fix] `parseConfig` returns `undefined` when the file is empty, but every caller assumes an object.\n\nThe early return on line 34 skips the default merge:\n\n```ts\nif (!raw) return;  // callers then read `.port` off undefined\n```\n\nReturning `DEFAULT_CONFIG` here keeps the contract the three call sites in `server.ts` rely on.'

const CORPUS: Record<string, string> = {
  skill: SKILL_BODY,
  empty: '',
  whitespace: '  \n\n\t\n',
  tagOnly: '[nit]',
  tagThenFence: '[suggestion]\n```ts\nconst x = 1\n```',
  longWord: 'A ' + 'x'.repeat(200) + ' tail and https://example.com/' + 'segment/'.repeat(30),
  longCode: 'Call `' + 'veryLongIdentifier'.repeat(12) + '` here.',
  cjk: '[question] 漢字テスト 日本語の文章がここにあります。' + '長い'.repeat(40) + ' end',
  emoji: 'Rockets 🚀🚀🚀 and flags 🇪🇸🇯🇵 and 👨‍👩‍👧‍👦 families ' + '🎉'.repeat(50),
  tabs: 'Tab\there\n\n```\n\tindented\twith\ttabs\n\t\tdeeper\n```\n\n-\tbullet with tab',
  nested:
    '- one\n  - nested one\n  - nested two with a rather long text that has to wrap around the column\n- two\n1. first\n2. second\n10. tenth\n   - under tenth',
  unterminatedFence: 'Before\n\n```rust\nfn main() {\n    println!("hi");\n',
  quote: '> Quoted **rule** with `code`\n>\n> Second paragraph of the quote that is long enough to wrap at narrow widths\n\nAfter.',
  headingsAndRules: '# Title\n\ntext\n\n---\n\n## Sub\n***\nmore',
  linkage: 'See [the docs](https://x.y/z) and [](https://bare.url) and [broken](nope',
  markers: 'a * b and snake_case_name and foo__bar__baz and **unclosed and `tick and *star',
  multiBlank: 'one\n\n\n\n\ntwo\n\n\n',
  crlf: '[nit] one\r\n\r\ntwo\r\n- a\r\n- b',
}

const WIDTHS = [4, 7, 12, 23, 40, 80]

describe('every row is exactly opts.width columns', () => {
  for (const [name, body] of Object.entries(CORPUS)) {
    for (const w of WIDTHS) {
      test(`${name} @ ${w}`, () => {
        const rows = renderMarkdown(body, { width: w })
        for (const [i, row] of rows.entries()) {
          expect({ i, w: width(text(row)) }).toEqual({ i, w })
          for (const c of row) expect(c.text).not.toBe('')
        }
      })
    }
  }

  test('highlighted fence rows are padded and cut like plain ones', () => {
    const body = '```ts\nshort\n' + 'longer than the pane '.repeat(5) + '\n```'
    const rows = renderMarkdown(body, {
      width: 24,
      highlight: (code) => code.split('\n').map((l) => [chunk(l.slice(0, 3), S.add), chunk(l.slice(3))]),
    })
    for (const row of rows) expect(width(text(row))).toBe(24)
    // The block background is painted over every chunk the hook returned.
    for (const row of rows) for (const c of row) expect(c.bg).toBe(S.mdCodeBlock.bg)
    // …and the hook's own foreground survives.
    expect(rows[0]![1]!.fg).toBe(S.add.fg)
  })
})

describe('blank rows between blocks', () => {
  test('exactly one between blocks, none at the ends, never two in a row', () => {
    const out = lines(CORPUS.multiBlank!, 20)
    expect(out).toEqual(['one'.padEnd(20), ' '.repeat(20), 'two'.padEnd(20)])
  })

  test('empty body renders to nothing', () => {
    expect(renderMarkdown('', { width: 40 })).toEqual([])
    expect(renderMarkdown('  \n\n', { width: 40 })).toEqual([])
    expect(renderMarkdown('x', { width: 0 })).toEqual([])
  })

  test('a body that is only a tag is one badge row', () => {
    expect(lines('[nit]', 12)).toEqual(['nit         '])
  })
})

describe('severityOf', () => {
  test('parses each tag and returns the rest', () => {
    expect(severityOf('[must-fix] body')).toEqual({ tag: 'must-fix', rest: 'body' })
    expect(severityOf('[suggestion]\n\nbody')).toEqual({ tag: 'suggestion', rest: 'body' })
    expect(severityOf('  [question] x')).toEqual({ tag: 'question', rest: 'x' })
    expect(severityOf('[NIT] x')).toEqual({ tag: 'nit', rest: 'x' })
    expect(severityOf('[nit]')).toEqual({ tag: 'nit', rest: '' })
  })

  test('a tag that is not at the start, or unknown, is text', () => {
    expect(severityOf('body [nit]')).toBeNull()
    expect(severityOf('[blocker] body')).toBeNull()
    expect(severityOf('')).toBeNull()
  })
})

describe('firstLine', () => {
  test('strips the tag and inline markup, collapses whitespace', () => {
    expect(firstLine(SKILL_BODY)).toBe(
      'parseConfig returns undefined when the file is empty, but every caller assumes an object.',
    )
    expect(firstLine('[nit]   **Bold**   and\n_em_ and [a link](http://x)  ')).toBe('Bold and em and a link')
  })

  test('a leading fence yields its first code line behind a backtick', () => {
    expect(firstLine('[suggestion]\n```ts\n\n  const x = 1\n```')).toBe('`const x = 1')
  })

  test('skips rules and blank blocks; empty when nothing is left', () => {
    expect(firstLine('---\n\n# Heading here')).toBe('Heading here')
    expect(firstLine('- first item\n- second')).toBe('first item second')
    expect(firstLine('> quoted')).toBe('quoted')
    expect(firstLine('[nit]')).toBe('')
    expect(firstLine('')).toBe('')
  })

  test('is not truncated', () => {
    const long = 'word '.repeat(100).trim()
    expect(firstLine(long)).toBe(long)
  })
})

describe('text content', () => {
  test('the SKILL.md body at 40 columns', () => {
    expect(lines(SKILL_BODY, 40)).toEqual([
      'must-fix parseConfig returns undefined  ',
      'when the file is empty, but every caller',
      'assumes an object.                      ',
      '                                        ',
      'The early return on line 34 skips the   ',
      'default merge:                          ',
      '                                        ',
      '  if (!raw) return;  // callers then rea',
      '  d `.port` off undefined               ',
      '                                        ',
      'Returning DEFAULT_CONFIG here keeps the ',
      'contract the three call sites in        ',
      'server.ts rely on.                      ',
    ])
  })

  test('lists: bullets, kept ordinals, one nesting level, indented continuation', () => {
    expect(lines(CORPUS.nested!, 30)).toEqual([
      '• one                         ',
      '  • nested one                ',
      '  • nested two with a rather  ',
      '    long text that has to wrap',
      '    around the column         ',
      '• two                         ',
      '1. first                      ',
      '2. second                     ',
      '10. tenth                     ',
      '  • under tenth               ',
    ])
  })

  test('blockquotes carry the bar on every row, including the gap', () => {
    expect(lines(CORPUS.quote!, 26)).toEqual([
      '▎ Quoted rule with code   ',
      '▎                         ',
      '▎ Second paragraph of the ',
      '▎ quote that is long      ',
      '▎ enough to wrap at narrow',
      '▎ widths                  ',
      '                          ',
      'After.                    ',
    ])
  })

  test('headings lose their markers; rules span the width', () => {
    expect(lines(CORPUS.headingsAndRules!, 10)).toEqual([
      'Title     ',
      '          ',
      'text      ',
      '          ',
      '──────────',
      '          ',
      'Sub       ',
      '          ',
      '──────────',
      '          ',
      'more      ',
    ])
  })

  test('links keep the text, or the url when the text is empty', () => {
    expect(lines(CORPUS.linkage!, 80)[0]!.trimEnd()).toBe(
      'See the docs and https://bare.url and [broken](nope',
    )
  })

  test('unmatched markers stay literal; emphasis markers are dropped', () => {
    expect(lines(CORPUS.markers!, 80)[0]!.trimEnd()).toBe(
      'a * b and snake_case_name and foo__bar__baz and **unclosed and `tick and *star',
    )
    expect(lines('_em_ and *em* and **b** and __init__ and \\*lit\\*', 80)[0]!.trimEnd()).toBe(
      'em and em and b and init and *lit*',
    )
  })

  test('an unterminated fence runs to the end of the body', () => {
    expect(lines(CORPUS.unterminatedFence!, 24)).toEqual([
      'Before                  ',
      '                        ',
      '  fn main() {           ',
      '      println!("hi");   ',
    ])
  })

  test('tabs are expanded everywhere', () => {
    for (const row of lines(CORPUS.tabs!, 40)) expect(row).not.toContain('\t')
    expect(lines(CORPUS.tabs!, 40)[2]).toBe('      indented    with    tabs          ')
  })

  test('a word wider than the pane is hard-cut, not dropped', () => {
    const out = lines('x'.repeat(10), 4)
    expect(out).toEqual(['xxxx', 'xxxx', 'xx  '])
  })

  test('a code span never breaks at its inner space', () => {
    expect(lines('aaaa `b c` dd', 7)).toEqual(['aaaa   ', 'b c dd '])
  })
})

describe('styles', () => {
  const bold = createTextAttributes({ bold: true })

  test('tag, bold and code land on their own chunks', () => {
    const [row] = renderMarkdown('[must-fix] a **b** `c` [d](e)', { width: 40 })
    const find = (t: string) => row!.find((c) => c.text === t)!

    const tag = find('must-fix')
    expect(tag.fg).toBe(S.sevMustFix.fg)
    expect(tag.fg).toBe(S.palette.delFg)
    expect(tag.attributes).toBe(bold)

    expect(find('a').fg).toBe(S.mdText.fg)
    expect(find('a').attributes).toBeUndefined()

    expect(find('b').attributes).toBe(bold)
    expect(find('b').fg).toBe(S.mdBold.fg)

    expect(find('c').fg).toBe(S.mdCode.fg)
    expect(find('c').bg).toBe(S.mdCode.bg)
    expect(find('c').bg).toBe(S.palette.cursorBg)

    expect(find('d').attributes).toBe(createTextAttributes({ underline: true }))
    expect(find('d').fg).toBe(S.mdLink.fg)
  })

  test('each severity takes its own hue', () => {
    const fgOf = (body: string) => renderMarkdown(body, { width: 20 })[0]![0]!.fg
    expect(fgOf('[must-fix] x')).toBe(S.sevMustFix.fg)
    expect(fgOf('[suggestion] x')).toBe(S.sevSuggestion.fg)
    expect(fgOf('[question] x')).toBe(S.sevQuestion.fg)
    expect(fgOf('[nit] x')).toBe(S.sevNit.fg)
  })

  test('fenced rows carry the block background edge to edge', () => {
    const [row] = renderMarkdown('```\nx\n```', { width: 8 })
    expect(text(row!)).toBe('  x     ')
    for (const c of row!) expect(c.bg).toBe(S.mdCodeBlock.bg)
  })

  test('styles are read at render time, so a theme swap shows on the next render', () => {
    const before = renderMarkdown('[nit] x', { width: 10 })[0]![0]!.fg
    applyTheme(themeByName('vesper')!)
    try {
      const after = renderMarkdown('[nit] x', { width: 10 })[0]![0]!.fg
      expect(after).toBe(S.sevNit.fg)
      expect(after).not.toBe(before)
    } finally {
      applyTheme(themeByName('gruvbox-dark')!)
    }
  })
})
