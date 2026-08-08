/**
 * Echo suppression, which is the whole of the watcher's decision-making.
 *
 * The watcher exists to notice the extension or an agent writing
 * `.refiner/comments.json`. Since our own saves fire the same events, it compares
 * the file against the text the store is synced with and stays quiet on a match.
 * That comparison used to be the entire rule, and it has a hole: if one of our
 * writes COMPLETES while the handler is reading the file, the bytes it reads
 * match a witness that describes a different moment, and the external event —
 * possibly the one announcing data we have just flattened — is dropped.
 *
 * The rule is pinned here rather than through a live `fs.watch`, because the
 * interesting cases are orderings, not filesystem behaviour.
 */
import { expect, test } from 'bun:test'
import { shouldReload } from '../src/watch.ts'

const SYNCED = '{\n  "version": 1,\n  "threads": []\n}\n'

test('suppresses the echo of our own write', () => {
  expect(
    shouldReload({ text: SYNCED, expected: SYNCED, seqAtEvent: 3, seqNow: 3 }),
  ).toBe(false)
})

test('reloads when the file does not match what we are synced with', () => {
  expect(
    shouldReload({ text: SYNCED + ' ', expected: SYNCED, seqAtEvent: 3, seqNow: 3 }),
  ).toBe(true)
})

test('does not discard an external event when a write of ours finished during the read', () => {
  // Same bytes, but our own save landed in between: the comparison is against a
  // witness from before that write and no longer means anything. A reload too
  // many is a flicker; one too few is a thread the reviewer never sees.
  expect(
    shouldReload({ text: SYNCED, expected: SYNCED, seqAtEvent: 3, seqNow: 4 }),
  ).toBe(true)
})

test('reloads when we have never seen the file, or cannot read it now', () => {
  expect(
    shouldReload({ text: SYNCED, expected: null, seqAtEvent: 0, seqNow: 0 }),
  ).toBe(true)
  expect(
    shouldReload({ text: null, expected: SYNCED, seqAtEvent: 1, seqNow: 1 }),
  ).toBe(true)
})

// -------------------------------------------------------- el filtro de ruido
//
// `classify` decide qué merece una recarga. Los dos sentidos del error cuestan:
// demasiado estricto y la edición de un agente no aparece nunca; demasiado laxo y
// un `bun install` provoca una recarga por fichero escrito.

import { classify } from '../src/watch.ts'

const IGNORED = ['node_modules/', 'dist/', '.env']

test('una edición del working tree pide recarga', () => {
  expect(classify('src/app.ts', IGNORED)).toBe('worktree')
  expect(classify('README.md', IGNORED)).toBe('worktree')
  expect(classify('a/b/c/deep.ts', IGNORED)).toBe('worktree')
})

test('el store se enruta a su propio manejador, no a una recarga', () => {
  expect(classify('.refiner/comments.json', IGNORED)).toBe('store')
})

test('el temporal del rename se descarta', () => {
  // Nuestra propia escritura atómica, sorprendida a medio camino.
  expect(classify('.refiner/comments.json.4242.1.tmp', IGNORED)).toBe('ignore')
})

test('el interior de .git se descarta: tiene su propio watcher', () => {
  for (const p of ['.git', '.git/index', '.git/objects/ab/cdef', '.git/index.lock']) {
    expect(classify(p, IGNORED), p).toBe('ignore')
  }
})

test('lo que git ignora se descarta, ficheros y directorios', () => {
  expect(classify('node_modules/pkg/index.js', IGNORED)).toBe('ignore')
  expect(classify('dist/refiner', IGNORED)).toBe('ignore')
  expect(classify('.env', IGNORED)).toBe('ignore')
})

test('un prefijo ignorado no se come un hermano con nombre parecido', () => {
  // El fallo clásico de un filtro a mano: `dist/` tragándose `dist-notes.md`.
  expect(classify('dist-notes.md', IGNORED)).toBe('worktree')
  expect(classify('node_modules-backup/x.ts', IGNORED)).toBe('worktree')
  expect(classify('.environment', IGNORED)).toBe('worktree')
})

test('sin lista de ignorados todo cuenta como working tree', () => {
  // Los primeros instantes tras arrancar, antes de que git responda: una recarga
  // de más, nunca una de menos.
  expect(classify('node_modules/pkg/index.js', [])).toBe('worktree')
  expect(classify('.refiner/comments.json', [])).toBe('store')
  expect(classify('.git/index', [])).toBe('ignore')
})
