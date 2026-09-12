/**
 * The keymap, as data.
 *
 * This is the single source of truth for what the help overlay (`k`) shows. It
 * used to live as two hardcoded hint lists in the footer, which meant the
 * bindings and their documentation drifted apart every time one changed.
 *
 * Keeping it here rather than in the view also makes the omissions obvious: if a
 * key is handled in dispatch.ts but missing from this file, it's undiscoverable.
 */

export interface Binding {
  keys: string
  what: string
}

export interface KeySection {
  title: string
  bindings: Binding[]
}

export const KEYMAP: readonly KeySection[] = [
  {
    title: 'Panes',
    bindings: [
      { keys: '← →', what: 'move focus between the file tree and the diff' },
      { keys: 'b', what: 'auto-hide the tree while the diff has focus' },
      { keys: '[ ]', what: 'narrow / widen the tree' },
    ],
  },
  {
    title: 'File tree',
    bindings: [
      { keys: '↑ ↓', what: 'navigate (wraps around)' },
      { keys: 'enter', what: 'expand or collapse a folder · focus the diff for a file' },
      {
        keys: 'tab',
        what: 'switch between CHANGES and ALL — ALL lists the whole repo, so you can read and comment on files nobody has touched',
      },
      { keys: 'space', what: 'stage or unstage the whole file' },
      { keys: 'p / ⌃p', what: 'fuzzy file finder — space-separated terms, order-independent' },
    ],
  },
  {
    title: 'Diff',
    bindings: [
      { keys: '↑ ↓', what: 'scroll — through the thread cards too, row by row' },
      { keys: '⇧↑ ⇧↓', what: 'extend a multi-line selection' },
      { keys: '⌃u ⌃d', what: 'half-page up / down (also pgup / pgdn)' },
      { keys: 'home / end', what: 'jump to the first / last row (G also jumps to the end)' },
      {
        keys: 'h / H',
        what: 'jump to the next / previous hunk — the next block of changed lines, wrapping at the ends',
      },
      { keys: 'space', what: 'stage or unstage the line, or the whole selection (cards are skipped)' },
      { keys: 'enter', what: 'go to the thread on this line, or start a new one over the selection' },
      { keys: 'tab', what: 'cycle the view: DIFF → SPLIT → NORMAL' },
      { keys: 'e', what: 'open the file in your editor, at the line under the cursor' },
    ],
  },
  {
    title: 'Review threads',
    bindings: [
      {
        keys: 'enter',
        what: 'on a card: expand or collapse it — collapsed shows the header and one preview line',
      },
      { keys: 'r', what: 'on a card: reply — the textarea opens right under it' },
      { keys: 'e', what: 'on a card: edit your last comment in the thread' },
      { keys: 'x', what: 'on a card: resolve the thread, or reopen it — resolved folds to one muted row' },
      { keys: 'D', what: 'on a card: delete the whole thread (asks first)' },
      { keys: 'z', what: 'expand every card in the file, or collapse them all' },
      { keys: 'n / N', what: 'next / previous thread, across files in tree order' },
      {
        keys: 'c',
        what: 'list every thread, grouped by file — enter jumps to it, x resolves or reopens it, o hides the resolved ones',
      },
      { keys: 'alt+enter', what: 'save what you wrote (alt+s and ⌃s work too)' },
      { keys: 'esc', what: 'cancel writing' },
    ],
  },
  {
    title: 'Session',
    bindings: [
      { keys: 'r', what: 'refresh — re-reads git and .refiner/comments.json' },
      { keys: 'g', what: 'open lazygit' },
      { keys: 's', what: 'open serie — the commit graph' },
      { keys: 'k', what: 'this help (? works too)' },
      {
        keys: 't',
        what: 'theme — ↑↓ previews on the diff behind, enter keeps it, esc puts the old one back',
      },
      { keys: 'q / esc', what: 'quit — asks to confirm first' },
      { keys: '⌃c', what: 'quit immediately, from anywhere, no confirmation' },
    ],
  },
]
