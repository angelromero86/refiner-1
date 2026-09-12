/**
 * Display-width helpers.
 *
 * Rows are composed as plain-text chunks and handed to OpenTUI, so unlike the
 * original Go implementation there are no ANSI escapes embedded in the strings
 * we measure — width is purely a function of the characters. `Bun.stringWidth`
 * gives us terminal cell width (CJK and emoji count as 2), and truncation walks
 * graphemes so a wide character is never split down the middle.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Terminal cell width of `s`. */
export function width(s: string): number {
  return Bun.stringWidth(s)
}

/** Expand tabs the way the diff viewer does everywhere: 4 spaces. */
export function expandTabs(s: string): string {
  return s.replaceAll('\t', '    ')
}

/**
 * truncate cuts `s` to at most `w` display columns, never splitting a grapheme.
 * If the next grapheme would straddle the limit it is dropped, so the result can
 * be one column narrower than `w` — callers that need an exact width pad after.
 */
export function truncate(s: string, w: number): string {
  if (w <= 0) return ''
  if (width(s) <= w) return s
  let out = ''
  let acc = 0
  for (const { segment } of segmenter.segment(s)) {
    const cw = width(segment)
    if (acc + cw > w) break
    out += segment
    acc += cw
  }
  return out
}

/** pad appends spaces until `s` is exactly `w` columns wide (no-op if wider). */
export function pad(s: string, w: number): string {
  const cur = width(s)
  return cur < w ? s + ' '.repeat(w - cur) : s
}

/**
 * fitExact expands tabs then forces `s` to exactly `w` columns by truncating or
 * padding. Replaces the Go `fit()` helper, which measured byte length and so
 * misaligned any row containing non-ASCII.
 */
export function fitExact(s: string, w: number): string {
  return pad(truncate(expandTabs(s), w), w)
}

/**
 * wrapLine wraps `s` to `w` columns, breaking at spaces when possible. Words
 * wider than `w` are hard-split. Leading whitespace is preserved as an indent so
 * list-ish markdown still reads. Always returns at least one line.
 */
export function wrapLine(s: string, w: number): string[] {
  if (w < 1) w = 1
  s = expandTabs(s)
  if (s === '') return ['']

  const trimmed = s.replace(/^ +/, '')
  const indent = s.length - trimmed.length
  const prefix = ' '.repeat(indent)

  const words = trimmed.split(/\s+/).filter((x) => x !== '')
  if (words.length === 0) return [prefix]

  const avail = Math.max(1, w - indent)
  const out: string[] = []
  let line = ''

  const flush = () => {
    out.push(prefix + line)
    line = ''
  }

  for (let word of words) {
    // Word wider than the available column: hard-split into chunks.
    while (width(word) > avail) {
      if (line !== '') flush()
      const head = truncate(word, avail)
      // A single grapheme wider than `avail` would make no progress; emit it
      // anyway so we terminate.
      const chunk = head === '' ? [...segmenter.segment(word)][0]!.segment : head
      line = chunk
      flush()
      word = word.slice(chunk.length)
    }
    if (line === '') {
      line = word
      continue
    }
    if (avail - width(line) >= 1 + width(word)) {
      line += ' ' + word
    } else {
      flush()
      line = word
    }
  }
  if (line !== '' || out.length === 0) out.push(prefix + line)
  return out
}

/**
 * ISO timestamp → the shortest label that still places it: "23:25" today,
 * "12 sep 23:25" this year, "2025-09-12" before that. Local time. The input
 * comes back unchanged when it won't parse. Card headers spend every column
 * on the finding, so a stamp that always carried the year truncated the rest.
 */
export function formatStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const sameDay = d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hm
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
