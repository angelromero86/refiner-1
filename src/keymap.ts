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
      { keys: 'p', what: 'fuzzy file finder — space-separated terms, order-independent' },
    ],
  },
  {
    title: 'Diff',
    bindings: [
      { keys: '↑ ↓', what: 'scroll' },
      { keys: '⇧↑ ⇧↓', what: 'extend a multi-line selection' },
      { keys: '⌃u ⌃d', what: 'half-page up / down (also pgup / pgdn)' },
      { keys: 'home / end', what: 'jump to the first / last row (G also jumps to the end)' },
      { keys: 'space', what: 'stage or unstage the line, or the whole selection' },
      { keys: 'enter', what: 'open the thread on this line, or start a new one' },
      { keys: 'tab', what: 'cycle the view: DIFF → SPLIT → NORMAL' },
      { keys: 'e', what: 'open the file in your editor, at the line under the cursor' },
    ],
  },
  {
    title: 'Review threads',
    bindings: [
      { keys: 'c', what: 'list every thread in the repo (a thread holds one or more comments)' },
      { keys: '↑ ↓', what: 'move between the comments inside a thread' },
      { keys: '⌃u ⌃d', what: 'scroll a long comment without changing the selection' },
      { keys: 'g', what: 'jump to the code the thread is anchored to' },
      { keys: 'r', what: 'reply — adds a comment to this thread' },
      { keys: 'e', what: 'edit the selected comment' },
      { keys: 'd / D', what: 'delete the selected comment / the whole thread' },
      { keys: 'alt+enter', what: 'save what you wrote (alt+s and ⌃s work too)' },
      { keys: 'esc', what: 'cancel writing, or close the thread' },
    ],
  },
  {
    title: 'Session',
    bindings: [
      { keys: 'r', what: 'refresh — re-reads git and .refiner/comments.json' },
      { keys: 'g', what: 'open lazygit' },
      { keys: 'k', what: 'this help (? works too)' },
      { keys: 'q / esc', what: 'quit — asks to confirm first' },
      { keys: '⌃c', what: 'quit immediately, from anywhere, no confirmation' },
    ],
  },
]
