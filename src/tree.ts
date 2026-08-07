/** File-tree construction and flattening for the left pane. */

import type { ChangedFile } from './git.ts'

export interface DirNode {
  type: 'dir'
  name: string
  path: string
  children: Node[]
}

export interface FileNode {
  type: 'file'
  name: string
  path: string
  file: ChangedFile
}

export type Node = DirNode | FileNode

export interface FlatNode {
  node: Node
  depth: number
  /** Pre-built tree-guide prefix ("│ ", "├ ", "└ ", "  "). */
  prefix: string
}

export function build(files: ChangedFile[]): Node[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const path = parts.slice(0, i + 1).join('/')
      let dir = current.children.find((c): c is DirNode => c.type === 'dir' && c.name === name)
      if (!dir) {
        dir = { type: 'dir', name, path, children: [] }
        current.children.push(dir)
      }
      current = dir
    }
    current.children.push({
      type: 'file',
      name: parts[parts.length - 1],
      path: f.path,
      file: f,
    })
  }
  sortDir(root)
  return root.children
}

function sortDir(d: DirNode): void {
  // Dirs before files, then alphabetical. Array.prototype.sort is stable in
  // modern JS engines, matching Go's sort.SliceStable.
  d.children.sort((a, b) => {
    const aIsDir = a.type === 'dir'
    const bIsDir = b.type === 'dir'
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  for (const c of d.children) {
    if (c.type === 'dir') sortDir(c)
  }
}

export function flatten(nodes: Node[], collapsed: Set<string>): FlatNode[] {
  return flattenInner(nodes, collapsed, 0, [])
}

/**
 * flattenInner walks the tree producing a linear list of visible nodes.
 * ancestorTrails encodes per-ancestor-level whether the ancestor still has
 * siblings below — used to draw the "│ " continuation lines.
 */
function flattenInner(
  nodes: Node[],
  collapsed: Set<string>,
  depth: number,
  ancestorTrails: boolean[],
): FlatNode[] {
  const out: FlatNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const isLast = i === nodes.length - 1
    let prefix = ''
    if (depth >= 1) {
      for (const t of ancestorTrails) prefix += t ? '│ ' : '  '
      // The horizontal connector matters: `├─` visibly reaches the entry it
      // belongs to, where a bare `├ ` leaves it floating next to one.
      prefix += isLast ? '└─' : '├─'
    }
    out.push({ node: n, depth, prefix })
    if (n.type === 'dir' && !collapsed.has(n.path)) {
      const childTrails = depth >= 1 ? [...ancestorTrails, !isLast] : []
      out.push(...flattenInner(n.children, collapsed, depth + 1, childTrails))
    }
  }
  return out
}
