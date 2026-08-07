/**
 * Everything that draws.
 *
 * The renderable tree is built once and then updated in place — each render pass
 * recomputes the visible rows from state and assigns new StyledText, which keeps
 * the "view is a function of state" discipline the bubbletea version had without
 * rebuilding the widget tree every frame.
 *
 * Two things the Go version did by hand are now the framework's job: pane borders
 * with an embedded title (BoxRenderable's `title`), and compositing modals over
 * the base view (absolute position + zIndex, which replaces ~40 lines of
 * ANSI-aware line splicing).
 *
 * Only the rows actually on screen are ever built, so a 20k-line diff costs the
 * same as a 20-line one.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core'
import { App, Focus, ModalMode, ViewMode, viewModeLabel } from './app.ts'
import type { StoredThread } from './comments.ts'
import { LineKind } from './diff.ts'
import { refreshFinder } from './finder.ts'
import type { Status } from './git.ts'
import {
  chunksWidth,
  renderCurrentRow,
  renderSplitRow,
  renderUnifiedRow,
  splitSideWidth,
  type RowState,
} from './render.ts'
import { chunk, S, statusStyle, withBg, type Style } from './styles.ts'
import { truncate, width as textWidth, wrapLine } from './text.ts'
import type { FlatNode } from './tree.ts'

const NL: TextChunk = { __isChunk: true, text: '\n' }
const EMPTY: TextChunk = { __isChunk: true, text: '' }

/** Join per-row chunk lists into one multi-line StyledText. */
function rowsToStyledText(rows: TextChunk[][]): StyledText {
  const out: TextChunk[] = []
  rows.forEach((row, i) => {
    if (i > 0) out.push(NL)
    out.push(...row)
  })
  return new StyledText(out.length > 0 ? out : [EMPTY])
}

/** Border (2) + vertical padding (2) around an overlay's content rows. */
const OVERLAY_CHROME_H = 4
/** Rows the compose textarea occupies. */
const COMPOSE_H = 6

export class View {
  private app: App
  private renderer: CliRenderer

  private headerText!: TextRenderable
  private treeBox!: BoxRenderable
  private treeText!: TextRenderable
  private contentBox!: BoxRenderable
  private contentText!: TextRenderable
  private footerText!: TextRenderable

  private modalBox!: BoxRenderable
  private modalText!: TextRenderable
  private composeInput!: TextareaRenderable
  private modalHint!: TextRenderable

  private listBox!: BoxRenderable
  private listText!: TextRenderable

  private finderBox!: BoxRenderable
  private finderTitle!: TextRenderable
  private finderInput!: InputRenderable
  private finderText!: TextRenderable

  /** Ids of threads whose anchor no longer exists; see refreshOutdated. */
  private outdated = new Set<string>()
  private overlayWasOpen = false

  constructor(app: App, renderer: CliRenderer) {
    this.app = app
    this.renderer = renderer
    this.build()
    app.render = () => this.render()
    app.inputs = {
      composeValue: () => this.composeInput.plainText,
      setComposeValue: (v) => this.composeInput.setText(v),
      focusCompose: () => this.composeInput.focus(),
      blurCompose: () => this.composeInput.blur(),
      finderValue: () => this.finderInput.value,
      setFinderValue: (v) => {
        this.finderInput.value = v
      },
      focusFinder: () => this.finderInput.focus(),
      blurFinder: () => this.finderInput.blur(),
    }
  }

  private build(): void {
    const ctx = this.renderer
    const root = this.renderer.root
    root.flexDirection = 'column'

    const headerBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: 'rounded',
      borderColor: S.palette.primary,
      paddingLeft: 1,
      paddingRight: 1,
      height: 3,
      flexShrink: 0,
    })
    this.headerText = new TextRenderable(ctx, { content: '' })
    headerBox.add(this.headerText)

    const middle = new BoxRenderable(ctx, { flexDirection: 'row', flexGrow: 1 })

    this.treeBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: 'rounded',
      borderColor: S.palette.muted,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    })
    this.treeText = new TextRenderable(ctx, { content: '' })
    this.treeBox.add(this.treeText)

    this.contentBox = new BoxRenderable(ctx, {
      border: true,
      borderStyle: 'rounded',
      borderColor: S.palette.muted,
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 1,
    })
    this.contentText = new TextRenderable(ctx, { content: '' })
    this.contentBox.add(this.contentText)

    middle.add(this.treeBox)
    middle.add(this.contentBox)

    this.footerText = new TextRenderable(ctx, { content: '', height: 1, flexShrink: 0 })

    root.add(headerBox)
    root.add(middle)
    root.add(this.footerText)

    // ---- overlays -------------------------------------------------------
    this.modalBox = this.overlayBox()
    this.modalText = new TextRenderable(ctx, { content: '' })
    this.composeInput = new TextareaRenderable(ctx, {
      height: COMPOSE_H,
      placeholder: 'Write a comment… (markdown ok)',
      placeholderColor: S.palette.muted,
      textColor: S.palette.foreground,
      focusedTextColor: S.palette.foreground,
    })
    this.modalHint = new TextRenderable(ctx, { content: '', height: 1 })
    // Order matters: text, then the widget, then the hint underneath it.
    this.modalBox.add(this.modalText)
    this.modalBox.add(this.composeInput)
    this.modalBox.add(this.modalHint)

    this.listBox = this.overlayBox()
    this.listText = new TextRenderable(ctx, { content: '' })
    this.listBox.add(this.listText)

    this.finderBox = this.overlayBox()
    this.finderTitle = new TextRenderable(ctx, { content: '', height: 1 })
    this.finderInput = new InputRenderable(ctx, {
      placeholder:
        'search files (space-separated terms — "con task" matches "Controllers/Task.ts")',
      placeholderColor: S.palette.muted,
      textColor: S.palette.foreground,
      focusedTextColor: S.palette.foreground,
    })
    this.finderText = new TextRenderable(ctx, { content: '' })
    this.finderBox.add(this.finderTitle)
    this.finderBox.add(this.finderInput)
    this.finderBox.add(this.finderText)

    // The match list is derived from the query, and the widget updates its value
    // only after our global key handler has run — so recompute on its own change
    // event instead of guessing in the key handler.
    this.finderInput.on(InputRenderableEvents.INPUT, () => {
      if (!this.app.finder) return
      refreshFinder(this.app)
      this.render()
    })

    root.add(this.modalBox)
    root.add(this.listBox)
    root.add(this.finderBox)
  }

  private overlayBox(): BoxRenderable {
    const b = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: 'rounded',
      borderColor: S.palette.primary,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      position: 'absolute',
      zIndex: 100,
      flexDirection: 'column',
    })
    b.visible = false
    return b
  }

  // ------------------------------------------------------------------ render

  render(): void {
    const app = this.app
    if (app.width === 0 || app.height === 0) return

    // The outdated check hits the filesystem, so it runs once when an overlay
    // that shows the flag opens — never per diff row, never per frame.
    const overlayOpen = app.modal !== null || app.commentsList !== null
    if (overlayOpen && !this.overlayWasOpen) this.refreshOutdated()
    this.overlayWasOpen = overlayOpen

    this.renderHeader()
    this.renderMiddle()
    this.renderFooter()
    this.renderThreadModal()
    this.renderCommentsList()
    this.renderFinder()
  }

  private renderHeader(): void {
    const app = this.app
    const left: TextChunk[] = [
      chunk(app.repoName, S.appName),
      chunk(' · ', S.dim),
      chunk(app.modeLabel(), S.mode),
      chunk(' · ', S.dim),
      chunk(viewModeLabel(app.viewMode), { ...S.hotkey, bold: true }),
    ]
    const right = `${app.files.length} files · ${app.stagedFileCount()} staged · ${app.threads.threads.length} comments`

    // The border sits outside the box width; the padding is inside it.
    const contentW = Math.max(1, app.width - 4)
    const gap = Math.max(1, contentW - chunksWidth(left) - textWidth(right))
    this.headerText.content = new StyledText(
      clampRow([...left, chunk(' '.repeat(gap)), chunk(right, S.text)], contentW),
    )
  }

  private renderMiddle(): void {
    const app = this.app
    const innerH = app.paneInnerHeight()

    this.treeBox.visible = !app.treeHidden()
    if (this.treeBox.visible) {
      const treeW = app.treePanelWidth()
      this.treeBox.width = treeW
      this.treeBox.borderColor = app.focus === Focus.Tree ? S.palette.focus : S.palette.muted
      this.treeText.content = this.buildTree(Math.max(1, treeW - 4), innerH)
    }

    const contentFocused = app.focus === Focus.Content
    this.contentBox.borderColor = contentFocused ? S.palette.focus : S.palette.muted
    // The Go version hand-drew a top border with the path spliced into it;
    // `title` does exactly that natively.
    this.contentBox.title = app.selectedPath === '' ? undefined : ` ${app.selectedPath} `
    this.contentBox.titleColor = contentFocused ? S.palette.focus : S.palette.muted

    this.contentText.content = this.buildContent(Math.max(1, app.diffPanelWidth() - 4), innerH)
  }

  private renderFooter(): void {
    const app = this.app
    // `tab` cycles DIFF → SPLIT → NORMAL → DIFF; show the NEXT one so the hint
    // reads as "press tab to go to X".
    const nextMode =
      app.viewMode === ViewMode.Split
        ? 'NORMAL'
        : app.viewMode === ViewMode.Current
          ? 'DIFF'
          : 'SPLIT'

    const hints: [string, string][] =
      app.focus === Focus.Tree
        ? [
            ['↑↓', ' navigate'],
            ['→', ' content'],
            ['enter', ' open/select'],
            ['space', ' stage'],
            ['p', ' find'],
            ['c', ' comments'],
            ['[ ]', ' resize'],
            ['g', ' lazygit'],
            ['r', ' refresh'],
            ['q', ' quit'],
          ]
        : [
            ['↑↓', ' scroll'],
            ['⇧↑↓', ' select'],
            ['space', ' stage'],
            ['enter', ' comment'],
            ['p', ' find'],
            ['c', ' threads'],
            ['←', ' tree'],
            ['tab', ` ${nextMode}`],
            ['b', ' hide tree'],
            ['e', ' edit'],
            ['q', ' quit'],
          ]

    const left: TextChunk[] = []
    hints.forEach(([keyLabel, desc], i) => {
      if (i > 0) left.push(chunk(' · ', S.dim))
      left.push(chunk(keyLabel, S.hotkey))
      left.push(chunk(desc, S.dim))
    })

    let right =
      app.focus === Focus.Tree ? `${app.cursor + 1}/${app.flat.length}` : app.contentLineLabel()
    if (app.selectedPath !== '') right += ' · ' + basename(app.selectedPath)

    const contentW = Math.max(1, app.width - 2)
    const gap = Math.max(1, contentW - chunksWidth(left) - textWidth(right))
    this.footerText.content = new StyledText(
      clampRow([chunk(' '), ...left, chunk(' '.repeat(gap)), chunk(right, S.dim)], app.width),
    )
  }

  // -------------------------------------------------------------------- tree

  private buildTree(w: number, h: number): StyledText {
    const app = this.app
    if (app.loading) return rowsToStyledText([[chunk('Loading…', S.dim)]])
    if (app.err) return rowsToStyledText([[chunk('Error: ' + app.err.message, S.del)]])
    if (app.flat.length === 0) return rowsToStyledText([[chunk('No changes.', S.dim)]])

    const maxStart = Math.max(0, app.flat.length - h)
    let start = Math.max(0, app.cursor - Math.floor(h / 2))
    if (start > maxStart) start = maxStart
    const end = Math.min(app.flat.length, start + h)

    const rows: TextChunk[][] = []
    for (let i = start; i < end; i++) {
      rows.push(this.buildTreeRow(app.flat[i], i === app.cursor, w))
    }
    return rowsToStyledText(rows)
  }

  private buildTreeRow(item: FlatNode, isCursor: boolean, w: number): TextChunk[] {
    const app = this.app
    // The cursor highlight shows only while the tree has focus.
    const cursorHere = isCursor && app.focus === Focus.Tree
    const bg = S.palette.cursorBg

    if (item.node.type === 'dir') {
      const dir = item.node
      // Nerd Font folder icons — open / closed.
      const icon = app.collapsed.has(dir.path) ? '' : ''
      const label = `${icon}  ${dir.name}/`
      const base = app.isDirFullyStaged(dir) ? S.dirStaged : S.dir
      if (cursorHere) {
        return fitOverlayRow(
          [chunk(item.prefix, { bg }), chunk(label, withBg(base, bg))],
          w,
          { bg },
        )
      }
      return clampRow([chunk(item.prefix, S.treeGuide), chunk(label, base)], w)
    }

    const file = item.node
    const status = file.file.status
    // "Selected file" = the one shown in the content pane. Underlined rather than
    // given a row background so it doesn't compete with the cursor row.
    const isSelectedFile = app.selectedPath === file.path
    const staged = app.isFileFullyStaged(file.path)
    const hasThreads = app.fileHasThreads(file.path)

    if (cursorHere) {
      let nameStyle: Style = staged ? withBg(S.fileStaged, bg) : { bg }
      if (isSelectedFile) nameStyle = { ...nameStyle, underline: true }
      return fitOverlayRow(
        [
          chunk(item.prefix, { bg }),
          chunk(status, withBg(statusStyle(status), bg)),
          chunk('  ', { bg }),
          chunk(file.name, nameStyle),
        ],
        w,
        { bg },
        hasThreads ? chunk('●', { bg, fg: S.palette.commentBg }) : null,
      )
    }

    let nameStyle: Style = staged ? S.fileStaged : S.text
    if (isSelectedFile) nameStyle = { ...nameStyle, underline: true }
    return rightAlignMarker(
      [
        chunk(item.prefix, S.treeGuide),
        chunk(status, statusStyle(status)),
        chunk('  '),
        chunk(file.name, nameStyle),
      ],
      w,
      hasThreads ? chunk('●', S.marker) : null,
    )
  }

  // ----------------------------------------------------------------- content

  private buildContent(w: number, h: number): StyledText {
    const app = this.app
    if (app.selectedPath === '') return rowsToStyledText([[]])
    const cached = app.cache.get(app.selectedPath)
    if (!cached) return rowsToStyledText([[chunk('Loading…', S.dim)]])

    // The last column belongs to the scrollbar; diff rows get what's left.
    const contentW = Math.max(1, w - 1)
    const focused = app.focus === Focus.Content
    const [selStart, selEnd] = app.selectionRange()
    const stagedSet = app.staged.get(app.selectedPath) ?? new Set<number>()

    const rows: TextChunk[][] = []
    const from = app.contentScroll

    switch (app.viewMode) {
      case ViewMode.Split: {
        const end = Math.min(from + h, cached.split.length)
        const sideW = splitSideWidth(contentW)
        for (let i = from; i < end; i++) {
          const row = cached.split[i]
          rows.push(
            renderSplitRow(
              row,
              {
                isCursor: i === app.contentCursor,
                isSelected: i >= selStart && i <= selEnd,
                focused,
                hasComment: app.lineHasComment(app.selectedPath, row.newNum),
                oldStaged: row.oldSrcIdx >= 0 && stagedSet.has(row.oldSrcIdx),
                newStaged: row.newSrcIdx >= 0 && stagedSet.has(row.newSrcIdx),
              } satisfies RowState,
              sideW,
              contentW,
            ),
          )
        }
        break
      }
      case ViewMode.Current: {
        const end = Math.min(from + h, cached.current.length)
        for (let i = from; i < end; i++) {
          const line = cached.current[i]
          rows.push(
            renderCurrentRow(
              line,
              {
                isCursor: i === app.contentCursor,
                isSelected: i >= selStart && i <= selEnd,
                focused,
                hasComment: app.lineHasComment(app.selectedPath, line.newNum),
                staged: stagedSet.has(cached.currentIdx[i]),
              } satisfies RowState,
              contentW,
            ),
          )
        }
        break
      }
      default: {
        const end = Math.min(from + h, cached.unified.length)
        for (let i = from; i < end; i++) {
          const line = cached.unified[i]
          rows.push(
            renderUnifiedRow(
              line,
              {
                isCursor: i === app.contentCursor,
                isSelected: i >= selStart && i <= selEnd,
                focused,
                hasComment: app.lineHasComment(app.selectedPath, line.newNum),
                staged: stagedSet.has(i),
              } satisfies RowState,
              contentW,
            ),
          )
        }
        break
      }
    }

    // Pad every row to exactly contentW and the list to exactly h, so the
    // scrollbar column lands flush against the right edge on every line.
    for (const row of rows) {
      const rw = chunksWidth(row)
      if (rw < contentW) row.push(chunk(' '.repeat(contentW - rw)))
    }
    while (rows.length < h) rows.push([chunk(' '.repeat(contentW))])

    const scrollbar = this.buildScrollbar(h)
    for (let i = 0; i < h; i++) rows[i].push(scrollbar[i])

    return rowsToStyledText(rows)
  }

  /**
   * buildScrollbar returns one styled cell per row — the vertical minimap down
   * the right edge of the content pane:
   *
   *   - a colored block where the file has changes in that band
   *     (comment > staged > del > add; the most important state wins)
   *   - a tinted block where the current viewport sits (the thumb)
   *   - "▌" where both overlap: left half thumb, right half the kind color
   */
  private buildScrollbar(h: number): TextChunk[] {
    const app = this.app
    const out: TextChunk[] = Array.from({ length: h }, () => chunk(' '))
    if (app.selectedPath === '' || h <= 0) return out
    const cached = app.cache.get(app.selectedPath)
    if (!cached || cached.unified.length === 0) return out

    const lines = cached.unified
    const total = lines.length
    const stagedSet = app.staged.get(app.selectedPath) ?? new Set<number>()

    const marks = Array.from({ length: h }, () => ({
      comment: false,
      staged: false,
      del: false,
      add: false,
    }))
    for (let i = 0; i < total; i++) {
      const l = lines[i]
      const row = Math.min(h - 1, Math.floor((i * h) / total))
      if (app.lineHasComment(app.selectedPath, l.newNum)) marks[row].comment = true
      if (stagedSet.has(i)) {
        marks[row].staged = true
        continue
      }
      if (l.kind === LineKind.Del) marks[row].del = true
      else if (l.kind === LineKind.Add) marks[row].add = true
    }

    // The thumb maps the visible window in the ACTIVE row space (split/current
    // rows aren't 1:1 with unified). The marks above stay keyed off `unified`
    // because that is the canonical "where do the changes live" view.
    const active = app.activeRowCount() || total
    const vpStart = Math.floor((app.contentScroll * h) / active)
    let vpEnd = Math.floor(((app.contentScroll + h) * h) / active)
    if (vpEnd <= vpStart) vpEnd = vpStart + 1
    if (vpEnd > h) vpEnd = h

    // The foreground color doubles as the thumb tint so it reads against the
    // dim track.
    const thumb = S.palette.foreground
    for (let r = 0; r < h; r++) {
      const mk = marks[r]
      const inVp = r >= vpStart && r < vpEnd
      const kindBg = mk.comment
        ? S.palette.commentBg
        : mk.staged
          ? S.palette.stagedFg
          : mk.del
            ? S.palette.delFg
            : mk.add
              ? S.palette.addFg
              : null

      if (kindBg && inVp) out[r] = chunk('▌', { bg: kindBg, fg: thumb })
      else if (kindBg) out[r] = chunk(' ', { bg: kindBg })
      else if (inVp) out[r] = chunk(' ', { bg: thumb })
    }
    return out
  }

  // ---------------------------------------------------------------- overlays

  /**
   * refreshOutdated recomputes which threads can no longer be reached from the
   * current diff. Asynchronous and filesystem-bound, so it runs on overlay open
   * and re-renders once the answers land.
   */
  private refreshOutdated(): void {
    const threads = this.app.threads.threads.slice()
    void Promise.all(
      threads.map(async (t) => [t.id, await this.app.isThreadOutdated(t)] as const),
    ).then((results) => {
      this.outdated = new Set(results.filter(([, stale]) => stale).map(([id]) => id))
      // Only re-render if an overlay is still open; overlayWasOpen is already
      // true by now, so this cannot loop.
      if (this.app.modal || this.app.commentsList) this.render()
    })
  }

  private renderThreadModal(): void {
    const app = this.app
    const modal = app.modal
    if (!modal) {
      this.modalBox.visible = false
      this.composeInput.visible = false
      return
    }
    const outerW = Math.min(110, Math.max(40, app.width - 10))
    const innerW = outerW - 6
    // Reserve rows for border (2), padding (2), title (1), status (1), a spacer
    // (1), and either the footer hint (1) or the textarea. Sized for the taller
    // case so the layout doesn't jump when the mode flips.
    const bodyH = Math.min(30, Math.max(5, app.height - 14))

    const composing = modal.mode !== ModalMode.Browse
    const rows: TextChunk[][] = []

    if (modal.threadIdx >= 0) {
      const t = app.threads.threads[modal.threadIdx]
      if (!t) {
        this.modalBox.visible = false
        return
      }
      rows.push([chunk(`Thread · ${t.file}:${t.range.start}-${t.range.end}`, S.appName)])
      const meta: TextChunk[] = [chunk(`status: ${t.status} · id: ${t.id}`, S.dim)]
      if (this.outdated.has(t.id)) meta.push(chunk(' · OUTDATED', S.del))
      rows.push(meta)
      rows.push([])
    } else {
      rows.push([
        chunk(
          `New thread · ${modal.newThreadFile}:${modal.newThreadStart}-${modal.newThreadEnd}`,
          S.appName,
        ),
      ])
      rows.push([])
    }

    // Scrollable body of wrapped comments.
    const { lines: bodyLines, selectedStartRow } = this.modalBodyLines(innerW)
    let scroll = Math.max(0, modal.scrollY)
    if (modal.mode === ModalMode.Browse && bodyLines.length > 0) {
      if (selectedStartRow < scroll) scroll = selectedStartRow
      else if (selectedStartRow >= scroll + bodyH) scroll = selectedStartRow - bodyH + 1
    }
    if (scroll > bodyLines.length - bodyH) scroll = bodyLines.length - bodyH
    if (scroll < 0) scroll = 0
    // Persist the clamped values for the next key event.
    modal.scrollY = scroll
    modal.bodyHeight = bodyH

    const bodyEnd = Math.min(bodyLines.length, scroll + bodyH)
    const body: TextChunk[][] = []
    for (let i = scroll; i < bodyEnd; i++) body.push(bodyLines[i])
    while (body.length < bodyH) body.push([])

    // Inline scroll affordances at the edges.
    if (scroll > 0 && body.length > 0) body[0] = [chunk(`▲ ${scroll} more above`, S.dim)]
    if (bodyEnd < bodyLines.length && body.length > 0) {
      body[body.length - 1] = [chunk(`▼ ${bodyLines.length - bodyEnd} more below`, S.dim)]
    }
    rows.push(...body)
    rows.push([])

    this.modalText.content = rowsToStyledText(rows)
    this.composeInput.visible = composing
    this.composeInput.width = innerW
    this.modalHint.content = new StyledText(
      composing ? this.composeHint(modal.mode) : this.browseHint(modal.threadIdx),
    )

    const innerRows = rows.length + (composing ? COMPOSE_H : 0) + 1
    const totalH = Math.min(app.height, innerRows + OVERLAY_CHROME_H)
    this.modalBox.width = outerW
    this.modalBox.height = totalH
    this.modalBox.left = Math.max(0, Math.floor((app.width - outerW) / 2))
    this.modalBox.top = Math.max(0, Math.floor((app.height - totalH) / 2))
    this.modalBox.visible = true
  }

  private composeHint(mode: ModalMode): TextChunk[] {
    return [
      chunk('alt+enter', S.hotkey),
      chunk(mode === ModalMode.Edit ? ' save edit · ' : ' save · ', S.dim),
      chunk('esc', S.hotkey),
      chunk(' cancel', S.dim),
    ]
  }

  private browseHint(threadIdx: number): TextChunk[] {
    const app = this.app
    const hint: TextChunk[] = [
      chunk('↑↓', S.hotkey),
      chunk(' message · ', S.dim),
      chunk('⌃u/⌃d', S.hotkey),
      chunk(' scroll · ', S.dim),
    ]
    const t = threadIdx >= 0 ? app.threads.threads[threadIdx] : null
    if (t && app.findFile(t.file) !== null) {
      hint.push(chunk('g', S.hotkey), chunk(' goto · ', S.dim))
    }
    hint.push(
      chunk('r', S.hotkey),
      chunk(' reply · ', S.dim),
      chunk('e', S.hotkey),
      chunk(' edit · ', S.dim),
      chunk('d/D', S.hotkey),
      chunk(' del · ', S.dim),
      chunk('esc', S.hotkey),
      chunk(' close', S.dim),
    )
    return hint
  }

  /**
   * modalBodyLines builds the wrapped, scrollable body: every comment header
   * plus its wrapped body, with a selection marker. This list is what
   * modal.scrollY scrolls over.
   */
  private modalBodyLines(innerW: number): {
    lines: TextChunk[][]
    selectedStartRow: number
  } {
    const app = this.app
    const modal = app.modal
    const lines: TextChunk[][] = []
    let selectedStartRow = 0
    if (!modal || modal.threadIdx < 0) return { lines, selectedStartRow }
    const t = app.threads.threads[modal.threadIdx]
    if (!t) return { lines, selectedStartRow }

    const wrapW = Math.max(1, innerW - 4) // accounts for the 4-space body indent
    t.comments.forEach((msg, i) => {
      const selected = modal.mode === ModalMode.Browse && i === modal.selectedMsg
      if (selected) selectedStartRow = lines.length
      lines.push([
        selected ? chunk('▶ ', S.hotkey) : chunk('  '),
        chunk(`@${msg.author} · ${formatStamp(msg.createdAt)}`, S.mode),
      ])
      for (const raw of msg.body.split('\n')) {
        for (const wrapped of wrapLine(raw, wrapW)) {
          lines.push([chunk('    '), chunk(wrapped, S.text)])
        }
      }
      lines.push([])
    })
    return { lines, selectedStartRow }
  }

  private renderCommentsList(): void {
    const app = this.app
    if (!app.commentsList) {
      this.listBox.visible = false
      return
    }
    const threads = app.threads.threads
    const contentW = Math.min(100, Math.max(40, Math.floor((app.width * 2) / 3)))
    const contentH = Math.min(20, Math.max(5, app.height - 8))
    const rowW = Math.max(1, contentW - 4)

    const rows: TextChunk[][] = []
    rows.push([chunk(`Comments (${threads.length})`, S.appName)])
    rows.push([])

    if (threads.length === 0) {
      rows.push([chunk('No threads yet. Select lines in the content and press enter.', S.dim)])
    } else {
      // Visible window centered on the cursor.
      let start = Math.max(0, app.commentsList.cursor - Math.floor(contentH / 2))
      let end = start + contentH
      if (end > threads.length) {
        end = threads.length
        start = Math.max(0, end - contentH)
      }
      for (let i = start; i < end; i++) {
        rows.push(this.buildCommentsListRow(threads[i], i === app.commentsList.cursor, rowW))
      }
    }
    rows.push([])
    rows.push([
      chunk('↑↓', S.hotkey),
      chunk(' navigate · ', S.dim),
      chunk('enter', S.hotkey),
      chunk(' open thread · ', S.dim),
      chunk('esc', S.hotkey),
      chunk(' close', S.dim),
    ])

    this.listText.content = rowsToStyledText(rows)
    const outerW = contentW + 2
    const totalH = Math.min(app.height, rows.length + OVERLAY_CHROME_H)
    this.listBox.width = outerW
    this.listBox.height = totalH
    this.listBox.left = Math.max(0, Math.floor((app.width - outerW) / 2))
    this.listBox.top = Math.max(0, Math.floor((app.height - totalH) / 2))
    this.listBox.visible = true
  }

  private buildCommentsListRow(t: StoredThread, isCursor: boolean, w: number): TextChunk[] {
    const loc = `${t.file}:${t.range.start}-${t.range.end}`
    const first = t.comments[0]
    const author = first ? '@' + first.author : ''
    const snippet = first ? first.body.split('\n')[0] : ''
    const stale = this.outdated.has(t.id)

    if (isCursor) {
      const bg = S.palette.cursorBg
      const row: TextChunk[] = [chunk('▶ ', { bg, fg: S.palette.accent, bold: true })]
      if (stale) row.push(chunk('[outdated] ', { bg, fg: S.palette.delFg }))
      row.push(
        chunk(loc + '  ', { bg }),
        chunk(author, withBg(S.mode, bg)),
        chunk('  ', { bg }),
        chunk(snippet, withBg(S.text, bg)),
      )
      return fitOverlayRow(row, w, { bg })
    }

    const row: TextChunk[] = [chunk('  ')]
    if (stale) row.push(chunk('[outdated] ', S.del))
    row.push(
      chunk(loc, S.dir),
      chunk('  '),
      chunk(author, S.mode),
      chunk('  '),
      chunk(snippet, S.text),
    )
    return clampRow(row, w)
  }

  private renderFinder(): void {
    const app = this.app
    if (!app.finder) {
      this.finderBox.visible = false
      this.finderInput.visible = false
      return
    }
    const outerW = Math.min(140, Math.max(50, Math.floor((app.width * 4) / 5)))
    const bodyH = Math.min(22, Math.max(6, app.height - 12))
    const rowW = Math.max(1, outerW - 6)

    this.finderTitle.content = new StyledText([
      chunk(`Find file (${app.finder.matches.length}/${app.files.length})`, S.appName),
    ])
    this.finderInput.visible = true
    this.finderInput.width = rowW

    const rows: TextChunk[][] = []
    rows.push([chunk('─'.repeat(rowW), S.dim)])

    if (app.finder.matches.length === 0) {
      rows.push([chunk('  no matches', S.dim)])
      for (let i = 0; i < bodyH - 1; i++) rows.push([])
    } else {
      let start = Math.max(0, app.finder.cursor - Math.floor(bodyH / 2))
      let end = start + bodyH
      if (end > app.finder.matches.length) {
        end = app.finder.matches.length
        start = Math.max(0, end - bodyH)
      }
      let shown = 0
      for (let i = start; i < end; i++) {
        rows.push(this.buildFinderRow(app.files[app.finder.matches[i]], i === app.finder.cursor, rowW))
        shown++
      }
      while (shown < bodyH) {
        rows.push([])
        shown++
      }
    }
    rows.push([
      chunk('↑↓', S.hotkey),
      chunk(' navigate · ', S.dim),
      chunk('enter', S.hotkey),
      chunk(' open · ', S.dim),
      chunk('esc', S.hotkey),
      chunk(' close', S.dim),
    ])

    this.finderText.content = rowsToStyledText(rows)
    // +1 title row, +1 input row, plus the border/padding chrome.
    const totalH = Math.min(app.height, rows.length + 2 + OVERLAY_CHROME_H)
    this.finderBox.width = outerW
    this.finderBox.height = totalH
    this.finderBox.left = Math.max(0, Math.floor((app.width - outerW) / 2))
    this.finderBox.top = Math.max(0, Math.floor((app.height - totalH) / 2))
    this.finderBox.visible = true
  }

  /**
   * Mirrors the tree's file row — same status badge colors, same staged and
   * comment cues — so the picker reads as "the tree, filtered" rather than a
   * different widget.
   */
  private buildFinderRow(
    f: { path: string; status: Status },
    isCursor: boolean,
    w: number,
  ): TextChunk[] {
    const app = this.app
    const staged = app.isFileFullyStaged(f.path)
    const hasThreads = app.fileHasThreads(f.path)

    if (isCursor) {
      const bg = S.palette.cursorBg
      return fitOverlayRow(
        [
          chunk('▶ ', { bg, fg: S.palette.accent, bold: true }),
          chunk(f.status, withBg(statusStyle(f.status), bg)),
          chunk('  ', { bg }),
          chunk(f.path, staged ? withBg(S.fileStaged, bg) : { bg }),
        ],
        w,
        { bg },
        hasThreads ? chunk('●', { bg, fg: S.palette.commentBg }) : null,
      )
    }

    return rightAlignMarker(
      [
        chunk('  '),
        chunk(f.status, statusStyle(f.status)),
        chunk('  '),
        chunk(f.path, staged ? S.fileStaged : S.text),
      ],
      w,
      hasThreads ? chunk('●', S.marker) : null,
    )
  }
}

// ---------------------------------------------------------------- helpers

/** Truncate a chunk list to `w` columns, preserving per-chunk styles. */
function truncateChunkList(chunks: TextChunk[], w: number): TextChunk[] {
  const out: TextChunk[] = []
  let acc = 0
  for (const c of chunks) {
    const cw = textWidth(c.text)
    if (acc + cw <= w) {
      out.push(c)
      acc += cw
      continue
    }
    const head = truncate(c.text, w - acc)
    if (head !== '') out.push({ ...c, text: head })
    break
  }
  return out
}

/** Truncate to `w` without padding — for rows that need no background fill. */
function clampRow(row: TextChunk[], w: number): TextChunk[] {
  return chunksWidth(row) > w ? truncateChunkList(row, w) : row
}

/**
 * Fit a highlighted row to exactly `w`, optionally reserving the last column for
 * a right-aligned marker so the highlight runs continuously behind it.
 */
function fitOverlayRow(
  row: TextChunk[],
  w: number,
  padStyle: Style,
  rightMarker: TextChunk | null = null,
): TextChunk[] {
  const reserved = rightMarker ? 1 : 0
  const bodyW = chunksWidth(row)
  if (bodyW + reserved > w) return truncateChunkList(row, w)
  if (bodyW + reserved < w) row.push(chunk(' '.repeat(w - bodyW - reserved), padStyle))
  if (rightMarker) row.push(rightMarker)
  return row
}

/**
 * Push `marker` against the right edge on an unhighlighted row, but only when
 * there is room for it; otherwise the row is simply clamped.
 */
function rightAlignMarker(
  row: TextChunk[],
  w: number,
  marker: TextChunk | null,
): TextChunk[] {
  if (marker) {
    const bodyW = chunksWidth(row)
    if (bodyW + 2 <= w) {
      row.push(chunk(' '.repeat(w - bodyW - 1)), marker)
      return row
    }
  }
  return clampRow(row, w)
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/** ISO timestamp → "YYYY-MM-DD HH:mm" in local time. */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
