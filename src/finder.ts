/**
 * The fuzzy file picker (`p`).
 *
 * Multi-term substring match: the query is split on whitespace and every term
 * must appear somewhere in the lowercased path. Order doesn't matter, so
 * "con task" matches "Controllers/Task.ts". Ranking is the sum of each term's
 * earliest position (lower is better), tie-broken by shorter path.
 */

import { App, Focus } from './app.ts'
import type { FinderModal } from './app.ts'

export function newFinderModal(): FinderModal {
  return { cursor: 0, matches: [], positions: [] }
}

/** refreshFinder rebuilds the match list from the current query. */
export function refreshFinder(app: App): void {
  if (!app.finder) return
  const q = app.inputs.finderValue().trim().toLowerCase()
  const terms = q.split(/\s+/).filter((t) => t !== '')

  interface Scored {
    idx: number
    score: number
    positions: number[]
  }
  const hits: Scored[] = []

  for (let i = 0; i < app.files.length; i++) {
    const path = app.files[i].path.toLowerCase()
    if (q === '') {
      // Empty query → everything, in natural order.
      hits.push({ idx: i, score: 0, positions: [] })
      continue
    }
    let matched = true
    let score = 0
    const positions: number[] = []
    for (const t of terms) {
      const pos = path.indexOf(t)
      if (pos < 0) {
        matched = false
        break
      }
      score += pos
      positions.push(pos)
    }
    if (!matched) continue
    hits.push({ idx: i, score: score * 1000 + path.length, positions })
  }

  if (q !== '') {
    // Array.prototype.sort is stable, so equal scores keep file order.
    hits.sort((a, b) => a.score - b.score)
  }

  app.finder.matches = hits.map((h) => h.idx)
  app.finder.positions = hits.map((h) => h.positions)
  if (app.finder.cursor >= app.finder.matches.length) {
    app.finder.cursor = app.finder.matches.length - 1
  }
  if (app.finder.cursor < 0) app.finder.cursor = 0
}

export function openFinder(app: App): void {
  app.finder = newFinderModal()
  app.inputs.setFinderValue('')
  refreshFinder(app)
}

export function closeFinder(app: App): void {
  app.finder = null
}

/**
 * pickFinderResult opens the highlighted file: syncs the tree cursor to it so
 * the left pane stays consistent, then focuses the content pane.
 */
export function pickFinderResult(app: App): void {
  if (!app.finder) return
  const { cursor, matches } = app.finder
  if (cursor < 0 || cursor >= matches.length) return
  const fileIdx = matches[cursor]
  if (fileIdx < 0 || fileIdx >= app.files.length) return
  const picked = app.files[fileIdx]
  closeFinder(app)

  for (let i = 0; i < app.flat.length; i++) {
    const n = app.flat[i].node
    if (n.type === 'file' && n.path === picked.path) {
      app.cursor = i
      break
    }
  }
  app.selectedPath = picked.path
  app.contentCursor = 0
  app.contentScroll = 0
  app.selectionAnchor = -1
  app.focus = Focus.Content
  app.ensureDiffLoaded(picked)
}

/** handleFinderKey returns true when the key was consumed by the picker. */
export function handleFinderKey(app: App, key: string): boolean {
  if (!app.finder) return false
  switch (key) {
    case 'esc':
      closeFinder(app)
      return true
    case 'up':
    case 'ctrl+p':
      if (app.finder.cursor > 0) app.finder.cursor--
      return true
    case 'down':
    case 'ctrl+n':
      if (app.finder.cursor < app.finder.matches.length - 1) app.finder.cursor++
      return true
    case 'enter':
      pickFinderResult(app)
      return true
    default:
      // Anything else belongs to the text input; the matches are recomputed
      // after the widget has updated its value.
      return false
  }
}
