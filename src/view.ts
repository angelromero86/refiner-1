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
import { App, fileModeLabel, Focus, ModalMode, ViewMode, viewModeLabel } from './app.ts'
import { KEYMAP } from './keymap.ts'
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
import { dirState, DirState, type FlatNode } from './tree.ts'

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

/** The rule between the panes, and the padding a pane spends on each side. */
const RULE_W = 1
const PANE_PAD_W = 2

/**
 * The rules, drawn as one family: the same light box-drawing lines the diff
 * already uses between its line numbers and its code, in the same muted tone,
 * meeting in a `┬` under the header.
 *
 * They are static. An earlier pass had the vertical rule lean toward whichever
 * pane held the focus, which made a permanent piece of furniture move on every
 * `←`/`→` — the focus is on the pane titles and the cursor row, where it belongs.
 */
const RULE_V = '│'
const RULE_H = '─'
/** Where the header's rule opens the divide, and where the titles' rule crosses it. */
const RULE_TEE = '┬'
const RULE_CROSS = '┼'

/** Border (2) + vertical padding (2) around an overlay's content rows. */
const OVERLAY_CHROME_H = 4
/** Rows the compose textarea occupies. */
const COMPOSE_H = 6

export class View {
  private app: App
  private renderer: CliRenderer

  private headerText!: TextRenderable
  private hRuleText!: TextRenderable
  private subRuleText!: TextRenderable
  private titleRow!: BoxRenderable
  private treeTitleBox!: BoxRenderable
  private treeTitleText!: TextRenderable
  private contentTitleText!: TextRenderable
  private ruleTitleBox!: BoxRenderable
  private ruleTitleText!: TextRenderable
  private treeBox!: BoxRenderable
  private treeText!: TextRenderable
  private ruleBox!: BoxRenderable
  private ruleText!: TextRenderable
  private contentBox!: BoxRenderable
  private contentText!: TextRenderable

  private helpBox!: BoxRenderable
  private helpText!: TextRenderable

  private quitBox!: BoxRenderable
  private quitText!: TextRenderable

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
      finderValue: () => this.finderInput.value,
      setFinderValue: (v) => {
        this.finderInput.value = v
      },
    }
  }

  /**
   * Keyboard focus follows state, applied after visibility has been settled for
   * this frame. Focusing a hidden renderable is a silent no-op, so doing this
   * imperatively when a modal opened meant the widget never actually received
   * focus and every keystroke vanished.
   */
  private syncWidgetFocus(): void {
    const app = this.app
    const wantCompose = app.modal !== null && app.modal.mode !== ModalMode.Browse
    if (wantCompose) this.composeInput.focus()
    else this.composeInput.blur()

    if (app.finder !== null) this.finderInput.focus()
    else this.finderInput.blur()
  }

  private build(): void {
    const ctx = this.renderer
    const root = this.renderer.root
    root.flexDirection = 'column'

    // No box around the header: a border would spend two more rows restating
    // what the row inside it already says. Same for the panes below — the whole
    // frame is one header row, one title row and one column of rule.
    const headerBox = new BoxRenderable(ctx, {
      paddingLeft: 1,
      paddingRight: 1,
      height: 1,
      flexShrink: 0,
    })
    this.headerText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    headerBox.add(this.headerText)

    // Both horizontal rules run the full width — no padding — so they meet the
    // vertical one below them on its own column instead of stopping short of it.
    const hRuleBox = new BoxRenderable(ctx, { height: 1, flexShrink: 0 })
    this.hRuleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    hRuleBox.add(this.hRuleText)

    const subRuleBox = new BoxRenderable(ctx, { height: 1, flexShrink: 0 })
    this.subRuleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    subRuleBox.add(this.subRuleText)

    // The title row is laid out as a flex row of the same three widths as the
    // panes underneath, so each title sits over its own pane without anyone
    // doing the column arithmetic by hand.
    this.titleRow = new BoxRenderable(ctx, {
      flexDirection: 'row',
      height: 1,
      flexShrink: 0,
    })
    this.treeTitleBox = new BoxRenderable(ctx, {
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    })
    this.treeTitleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.treeTitleBox.add(this.treeTitleText)

    this.ruleTitleBox = new BoxRenderable(ctx, { width: RULE_W, flexShrink: 0 })
    this.ruleTitleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.ruleTitleBox.add(this.ruleTitleText)

    const contentTitleBox = new BoxRenderable(ctx, {
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 1,
    })
    this.contentTitleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    contentTitleBox.add(this.contentTitleText)

    this.titleRow.add(this.treeTitleBox)
    this.titleRow.add(this.ruleTitleBox)
    this.titleRow.add(contentTitleBox)

    const middle = new BoxRenderable(ctx, { flexDirection: 'row', flexGrow: 1 })

    this.treeBox = new BoxRenderable(ctx, {
      // Opaque on purpose. A transparent cell emits no background change, so the
      // terminal keeps whatever the previous cell set — which let a highlighted
      // cursor row bleed across the pane divide and tint the whole diff row next
      // to it. Painting the panes gives every cell an explicit background.
      backgroundColor: S.palette.background,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    })
    this.treeText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.treeBox.add(this.treeText)

    // The divide between the panes, one column wide. It replaces four columns of
    // facing borders and, unlike them, says which side has the focus.
    this.ruleBox = new BoxRenderable(ctx, {
      width: RULE_W,
      backgroundColor: S.palette.background,
      flexShrink: 0,
    })
    this.ruleText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.ruleBox.add(this.ruleText)

    this.contentBox = new BoxRenderable(ctx, {
      backgroundColor: S.palette.background,
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 1,
    })
    this.contentText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.contentBox.add(this.contentText)

    middle.add(this.treeBox)
    middle.add(this.ruleBox)
    middle.add(this.contentBox)

    root.add(headerBox)
    root.add(hRuleBox)
    root.add(this.titleRow)
    root.add(subRuleBox)
    root.add(middle)

    // ---- overlays -------------------------------------------------------
    this.modalBox = this.overlayBox()
    this.modalText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.composeInput = new TextareaRenderable(ctx, {
      height: COMPOSE_H,
      placeholder: 'Write a comment… (markdown ok)',
      placeholderColor: S.palette.muted,
      textColor: S.palette.foreground,
      focusedTextColor: S.palette.foreground,
    })
    this.modalHint = new TextRenderable(ctx, { content: '', height: 1, wrapMode: 'none' })
    // Order matters: text, then the widget, then the hint underneath it.
    this.modalBox.add(this.modalText)
    this.modalBox.add(this.composeInput)
    this.modalBox.add(this.modalHint)

    this.listBox = this.overlayBox()
    this.listText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.listBox.add(this.listText)

    this.finderBox = this.overlayBox()
    this.finderTitle = new TextRenderable(ctx, { content: '', height: 1, wrapMode: 'none' })
    this.finderInput = new InputRenderable(ctx, {
      placeholder:
        'search files (space-separated terms — "con task" matches "Controllers/Task.ts")',
      placeholderColor: S.palette.muted,
      textColor: S.palette.foreground,
      focusedTextColor: S.palette.foreground,
    })
    this.finderText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.helpBox = this.overlayBox()
    this.helpText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.helpBox.add(this.helpText)

    this.quitBox = this.overlayBox()
    this.quitText = new TextRenderable(ctx, { content: '', wrapMode: 'none' })
    this.quitBox.add(this.quitText)

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
    root.add(this.helpBox)
    root.add(this.quitBox)
  }

  private overlayBox(): BoxRenderable {
    const b = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: 'rounded',
      borderColor: S.palette.primary,
      // Overlays must be opaque. The panes are transparent and let the terminal
      // through, but a modal floats over the diff — without a fill the code
      // underneath reads straight through the comment text.
      backgroundColor: S.palette.background,
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
    const overlayOpen = app.modal !== null || app.threadList !== null
    if (overlayOpen && !this.overlayWasOpen) this.refreshOutdated()
    this.overlayWasOpen = overlayOpen

    this.renderHeader()
    this.renderMiddle()
    this.renderThreadModal()
    this.renderThreadList()
    this.renderFinder()
    this.renderHelp()
    this.renderQuitConfirm()
    this.syncWidgetFocus()
  }

  private renderHeader(): void {
    const app = this.app
    // The file-list mode and the view mode used to ride here too. They moved
    // down to the title of the pane each one actually describes, which leaves
    // this row holding only what is true of the session as a whole.
    const left: TextChunk[] = [
      chunk(app.repoName, S.appName),
      chunk(' · ', S.dim),
      chunk(app.modeLabel(), S.mode),
    ]
    // Counts threads, and now says so. This used to read "N comments" while
    // counting threads — exactly the confusion this pass removes.
    const n = app.store.threads.length
    const counts = `${app.files.length} files · ${app.stagedFileCount()} staged · ${n} ${n === 1 ? 'thread' : 'threads'}`
    // The keymap lives behind `k` now, so the header has to advertise it — it is
    // the only thing on screen that tells you the app has more keys.
    const right: TextChunk[] = []
    // A store whose file could not be read shows an empty (or stale) thread
    // count, which is exactly the lie that makes the data loss invisible. Say so
    // right next to the count, where it costs no rows and hides nothing.
    //
    // Derived from the store on every frame rather than latched into `err`: the
    // error banner is dismissed by `r`, and `r` used to be the natural reaction
    // to it, which disarmed the only warning while the unwritable store stayed
    // loaded. This one goes away when — and only when — a load succeeds.
    if (app.store.readOnly) {
      right.push(chunk('store read-only', { ...S.del, bold: true }), chunk(' · ', S.dim))
    }
    right.push(
      chunk(counts, S.text),
      chunk('  ', S.dim),
      chunk('k', S.hotkey),
      chunk(' keys', S.dim),
    )

    // Only the header's own left/right padding is inside the row.
    const contentW = Math.max(1, app.width - PANE_PAD_W)
    const gap = Math.max(1, contentW - chunksWidth(left) - chunksWidth(right))
    this.headerText.content = new StyledText(
      clampRow([...left, chunk(' '.repeat(gap)), ...right], contentW),
    )
  }

  private renderMiddle(): void {
    const app = this.app
    const innerH = app.paneInnerHeight()
    const showTree = !app.treeHidden()
    const treeFocused = app.focus === Focus.Tree

    // A hidden tree takes its title and the rule with it, and the diff pane's
    // flexGrow claims the whole width.
    this.treeBox.visible = showTree
    this.treeTitleBox.visible = showTree
    this.ruleBox.visible = showTree
    this.ruleTitleBox.visible = showTree

    if (showTree) {
      const treeW = app.treePanelWidth()
      const treeInnerW = Math.max(1, treeW - PANE_PAD_W)
      this.treeBox.width = treeW
      this.treeTitleBox.width = treeW
      // The tree's title is the one piece of state that belongs to it: which
      // list `tab` is showing, CHANGES or ALL.
      this.treeTitleText.content = rowsToStyledText([
        clampRow(
          [chunk(fileModeLabel(app.fileMode), treeFocused ? S.paneTitleFocus : S.paneTitle)],
          treeInnerW,
        ),
      ])
      this.treeText.content = this.buildTree(treeInnerW, innerH)

      this.ruleTitleText.content = rowsToStyledText([[chunk(RULE_V, S.paneRule)]])
      this.ruleText.content = rowsToStyledText(
        Array.from({ length: innerH }, () => [chunk(RULE_V, S.paneRule)]),
      )
    }

    // Under the header, a `┬` opening the divide between the panes. Under the
    // titles, the divide simply carries on through a lighter rule — the pane
    // rules cross it rather than meet it, so the strong line stays continuous
    // from the junction all the way to the bottom of the screen.
    this.hRuleText.content = this.buildRuleRow(RULE_TEE, S.paneRule, S.paneRule)
    this.subRuleText.content = this.buildRuleRow(RULE_CROSS, S.paneRuleSoft, S.paneRule)

    const contentInnerW = Math.max(1, app.diffPanelWidth() - PANE_PAD_W)
    this.contentTitleText.content = this.buildContentTitle(contentInnerW)
    this.contentText.content = this.buildContent(contentInnerW, innerH)
  }

  /**
   * One full-width horizontal rule, with `junction` sitting on the exact column
   * the vertical rule occupies.
   *
   * Drawn from `treePanelWidth()` rather than from the panes' own boxes: it
   * spans them both, so it can't be assembled out of their widths, and it must
   * land the junction on the column the rule between them will use.
   */
  private buildRuleRow(junction: string, fill: Style, junctionStyle: Style): StyledText {
    const app = this.app
    if (app.treeHidden()) {
      return rowsToStyledText([[chunk(RULE_H.repeat(Math.max(0, app.width)), fill)]])
    }
    const treeW = app.treePanelWidth()
    const tail = Math.max(0, app.width - treeW - RULE_W)
    return rowsToStyledText([
      [
        chunk(RULE_H.repeat(treeW), fill),
        chunk(junction, junctionStyle),
        chunk(RULE_H.repeat(tail), fill),
      ],
    ])
  }

  /**
   * The diff pane's title row: the path on the left, and on the right what the
   * pane's borders used to carry — the view mode and the line readout.
   *
   * The view mode shows even with no file selected. `tab` is what cycles it, and
   * with the header no longer naming it this row is the only thing that does.
   */
  private buildContentTitle(w: number): StyledText {
    const app = this.app
    const focused = app.focus === Focus.Content

    const right: TextChunk[] = [
      chunk(viewModeLabel(app.effectiveViewMode()), { ...S.hotkey, bold: true }),
    ]
    if (app.selectedPath !== '') {
      right.push(chunk(' · ', S.dim), chunk(app.contentLineLabel(), S.dim))
    }
    const left: TextChunk[] =
      app.selectedPath === ''
        ? []
        : [chunk(app.selectedPath, focused ? S.paneTitleFocus : S.paneTitle)]

    return rowsToStyledText([pinRight(left, right, w)])
  }

  // -------------------------------------------------------------------- tree

  private buildTree(w: number, h: number): StyledText {
    const app = this.app
    if (app.loading) return rowsToStyledText([[chunk('Loading…', S.dim)]])
    if (app.err) {
      // Clipped to the pane: with wrapping off, an unclipped multi-line git error
      // would just vanish past the edge instead of telling the user anything.
      const msg = app.err.message.replaceAll('\n', ' ')
      return rowsToStyledText(
        wrapLine(`Error: ${msg}`, w)
          .slice(0, h)
          .map((line) => [chunk(line, S.del)]),
      )
    }
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

  /**
   * One row of the file tree, laid out as `guides + icon + name … ● status`.
   *
   * The status badge and the thread dot are pinned to the last columns rather than
   * following the name, so they line up down the pane whatever the nesting depth —
   * scanning "what changed" becomes reading one column instead of hunting along
   * ragged indentation.
   */
  private buildTreeRow(item: FlatNode, isCursor: boolean, w: number): TextChunk[] {
    const app = this.app
    // The cursor row is painted whether or not the tree has focus, at the idle
    // weight when it doesn't. It used to vanish entirely, which was survivable
    // while a lit border said "this pane is asleep" — without one, the pane just
    // lost the one thing the reader needs on the way back: where they were.
    const cursorHere = isCursor
    const bg = app.focus === Focus.Tree ? S.palette.cursorBg : S.palette.cursorBgIdle
    // On the cursor row every segment carries the highlight, including the gaps.
    const padStyle: Style | undefined = cursorHere ? { bg } : undefined
    const guideStyle = cursorHere ? { bg } : S.treeGuide

    if (item.node.type === 'dir') {
      const dir = item.node
      const icon = app.collapsed.has(dir.path) ? app.icons.folderClosed : app.icons.folderOpen
      // The glyph is the constant: always the accent, in every state, because it
      // is what says "folder" at a glance. The NAME is the variable, and what it
      // varies with is the work left under it — accent while anything down there
      // is unstaged, the staged tone once it is all in the index, and the plain
      // file color otherwise. That last case is most of ALL mode, where the whole
      // repo used to shout for attention.
      const state = dirState(dir)
      let base = state === DirState.Unstaged ? S.dir : state === DirState.Staged ? S.dirStaged : S.text
      let iconStyle = S.dirIcon
      if (cursorHere) {
        base = withBg(base, bg)
        iconStyle = withBg(iconStyle, bg)
      }
      return pinRight(
        [chunk(item.prefix, guideStyle), chunk(`${iconCell(icon)} `, iconStyle), chunk(`${dir.name}/`, base)],
        // Directories have no badge, but they still yield the channel so a long
        // folder name can't run through the column the statuses live in.
        [chunk(' '.repeat(TREE_GUTTER_W), padStyle)],
        w,
        padStyle,
      )
    }

    const file = item.node
    const status = file.file.status
    // "Selected file" = the one shown in the content pane. Underlined rather than
    // given a row background so it doesn't compete with the cursor row.
    const isSelectedFile = app.selectedPath === file.path
    const staged = app.isFileFullyStaged(file.path)
    const hasThreads = app.fileHasThreads(file.path)

    let nameStyle: Style = staged ? S.fileStaged : S.text
    if (cursorHere) nameStyle = withBg(nameStyle, bg)
    if (isSelectedFile) nameStyle = { ...nameStyle, underline: true }

    const threadStyle: Style = cursorHere
      ? { bg, fg: S.palette.threadMarker }
      : S.marker
    const badgeStyle = cursorHere ? withBg(statusStyle(status), bg) : statusStyle(status)

    return pinRight(
      [
        chunk(item.prefix, guideStyle),
        // Exactly one space, and no icon slot. Enough to keep the `─` from running
        // into the first letter, not enough to read as indentation — a folder's
        // glyph starts one column earlier, which is the intended difference.
        chunk(' ', padStyle),
        chunk(file.name, nameStyle),
      ],
      [
        chunk(hasThreads ? '●' : ' ', threadStyle),
        chunk(' ', padStyle),
        chunk(status, badgeStyle),
      ],
      w,
      padStyle,
    )
  }

  // ----------------------------------------------------------------- content

  private buildContent(w: number, h: number): StyledText {
    const app = this.app
    if (app.selectedPath === '') return rowsToStyledText([[]])
    const cached = app.cache.get(app.selectedPath)
    if (!cached) return rowsToStyledText([[chunk('Loading…', S.dim)]])

    // The scrollbar's column is reserved only when there is something to scroll.
    // A diff that fits on screen has nothing to say with it — its change bands
    // are all visible as the diff itself — so the column goes back to the code.
    const needsScrollbar = app.activeRowCount() > h
    const contentW = needsScrollbar ? Math.max(1, w - 1) : w
    const focused = app.focus === Focus.Content
    const [selStart, selEnd] = app.selectionRange()
    // Intent first, git second: a keypress repaints as staged in the same frame
    // rather than one git round-trip later.
    const stagedSet = app.stagedFor(app.selectedPath)
    // Deletions only exist in the pre-change document, additions and context in
    // the post-change one — so each row looks its runs up on the matching side.
    const hl = app.activeHighlights()

    const rows: TextChunk[][] = []
    const from = app.contentScroll

    switch (app.effectiveViewMode()) {
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
                hasComment: app.lineHasThread(app.selectedPath, row.newNum),
                oldStaged: row.oldSrcIdx >= 0 && stagedSet.has(row.oldSrcIdx),
                newStaged: row.newSrcIdx >= 0 && stagedSet.has(row.newSrcIdx),
              } satisfies RowState,
              sideW,
              contentW,
              hl.old.get(row.oldNum),
              hl.new.get(row.newNum),
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
                hasComment: app.lineHasThread(app.selectedPath, line.newNum),
                staged: stagedSet.has(cached.currentIdx[i]),
              } satisfies RowState,
              contentW,
              hl.new.get(line.newNum),
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
                hasComment: app.lineHasThread(app.selectedPath, line.newNum),
                staged: stagedSet.has(i),
              } satisfies RowState,
              contentW,
              line.kind === LineKind.Del ? hl.old.get(line.oldNum) : hl.new.get(line.newNum),
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

    if (needsScrollbar) {
      const scrollbar = this.buildScrollbar(h)
      for (let i = 0; i < h; i++) rows[i].push(scrollbar[i])
    }

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
    const stagedSet = app.stagedFor(app.selectedPath)

    const marks = Array.from({ length: h }, () => ({
      comment: false,
      staged: false,
      del: false,
      add: false,
    }))
    for (let i = 0; i < total; i++) {
      const l = lines[i]
      const row = Math.min(h - 1, Math.floor((i * h) / total))
      if (app.lineHasThread(app.selectedPath, l.newNum)) marks[row].comment = true
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
        ? S.palette.threadBg
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
    const threads = this.app.store.threads.slice()
    void Promise.all(
      threads.map(async (t) => [t.id, await this.app.isThreadOutdated(t)] as const),
    ).then((results) => {
      this.outdated = new Set(results.filter(([, stale]) => stale).map(([id]) => id))
      // Only re-render if an overlay is still open; overlayWasOpen is already
      // true by now, so this cannot loop.
      if (this.app.modal || this.app.threadList) this.render()
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
      const t = app.store.threads[modal.threadIdx]
      if (!t) {
        this.modalBox.visible = false
        return
      }
      rows.push([chunk(`Thread · ${t.file}:${t.range.start}-${t.range.end}`, S.appName)])
      const c = t.comments.length
      const meta: TextChunk[] = [
        chunk(`status: ${t.status} · ${c} ${c === 1 ? 'comment' : 'comments'} · id: ${t.id}`, S.dim),
      ]
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
      chunk(' comment · ', S.dim),
      chunk('⌃u/⌃d', S.hotkey),
      chunk(' scroll · ', S.dim),
    ]
    const t = threadIdx >= 0 ? app.store.threads[threadIdx] : null
    if (t && app.findFile(t.file) !== null) {
      hint.push(chunk('g', S.hotkey), chunk(' goto · ', S.dim))
    }
    hint.push(
      chunk('r', S.hotkey),
      chunk(' reply · ', S.dim),
      chunk('e', S.hotkey),
      chunk(' edit · ', S.dim),
      chunk('d/D', S.hotkey),
      chunk(' del comment/thread · ', S.dim),
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
    const t = app.store.threads[modal.threadIdx]
    if (!t) return { lines, selectedStartRow }

    const wrapW = Math.max(1, innerW - 4) // accounts for the 4-space body indent
    t.comments.forEach((msg, i) => {
      const selected = modal.mode === ModalMode.Browse && i === modal.selectedComment
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

  /**
   * renderQuitConfirm draws the "really quit?" box. Small and centered, with the
   * default action spelled out rather than implied by a highlighted button —
   * there is no pointer here, so the keys are the interface.
   */
  private renderQuitConfirm(): void {
    const app = this.app
    if (!app.quitConfirm) {
      this.quitBox.visible = false
      return
    }

    const rows: TextChunk[][] = [
      [chunk('Quit refiner?', S.appName)],
      [],
      [
        chunk('y', S.hotkey),
        chunk(' or ', S.dim),
        chunk('enter', S.hotkey),
        chunk('  quit', S.text),
      ],
      [
        chunk('n', S.hotkey),
        chunk(' or ', S.dim),
        chunk('esc', S.hotkey),
        chunk('    stay', S.text),
      ],
    ]

    const innerW = Math.max(...rows.map(chunksWidth))
    const outerW = Math.min(app.width, innerW + 6)
    const totalH = Math.min(app.height, rows.length + OVERLAY_CHROME_H)

    this.quitText.content = rowsToStyledText(rows)
    this.quitBox.width = outerW
    this.quitBox.height = totalH
    this.quitBox.left = Math.max(0, Math.floor((app.width - outerW) / 2))
    this.quitBox.top = Math.max(0, Math.floor((app.height - totalH) / 2))
    this.quitBox.visible = true
  }

  /**
   * renderHelp draws the keymap overlay. It is built from src/keymap.ts rather
   * than from a list kept here, so what it shows and what dispatch.ts binds can be
   * compared side by side instead of drifting.
   */
  private renderHelp(): void {
    const app = this.app
    const help = app.help
    if (!help) {
      this.helpBox.visible = false
      return
    }

    const outerW = Math.min(88, Math.max(46, app.width - 8))
    const innerW = outerW - 6
    // Two rows of chrome for the title and the footer hint, on top of the border.
    const bodyH = Math.max(4, Math.min(app.height - OVERLAY_CHROME_H - 3, 32))

    // One key column wide enough for every binding, so the descriptions line up.
    const keyW = Math.max(...KEYMAP.flatMap((sec) => sec.bindings.map((b) => textWidth(b.keys))))
    const descW = Math.max(1, innerW - keyW - 2)

    const lines: TextChunk[][] = []
    KEYMAP.forEach((section, i) => {
      if (i > 0) lines.push([])
      lines.push([chunk(section.title, { ...S.appName, fg: S.palette.accent })])
      for (const b of section.bindings) {
        lines.push([
          chunk(b.keys.padStart(keyW), S.hotkey),
          chunk('  '),
          chunk(truncate(b.what, descW), S.text),
        ])
      }
    })

    const maxScroll = Math.max(0, lines.length - bodyH)
    if (help.scrollY > maxScroll) help.scrollY = maxScroll
    if (help.scrollY < 0) help.scrollY = 0
    help.bodyHeight = bodyH

    const end = Math.min(lines.length, help.scrollY + bodyH)
    const body: TextChunk[][] = []
    for (let i = help.scrollY; i < end; i++) body.push(lines[i])
    while (body.length < bodyH) body.push([])

    if (help.scrollY > 0) body[0] = [chunk(`▲ ${help.scrollY} more above`, S.dim)]
    if (end < lines.length) {
      body[body.length - 1] = [chunk(`▼ ${lines.length - end} more below`, S.dim)]
    }

    const rows: TextChunk[][] = [[chunk('Keys', S.appName)], [], ...body, []]
    const hint: TextChunk[] = []
    if (maxScroll > 0) {
      hint.push(chunk('↑↓', S.hotkey), chunk(' scroll · ', S.dim))
    }
    hint.push(chunk('esc', S.hotkey), chunk(' or ', S.dim), chunk('k', S.hotkey), chunk(' close', S.dim))
    rows.push(hint)

    this.helpText.content = rowsToStyledText(rows)
    const totalH = Math.min(app.height, rows.length + OVERLAY_CHROME_H)
    this.helpBox.width = outerW
    this.helpBox.height = totalH
    this.helpBox.left = Math.max(0, Math.floor((app.width - outerW) / 2))
    this.helpBox.top = Math.max(0, Math.floor((app.height - totalH) / 2))
    this.helpBox.visible = true
  }

  private renderThreadList(): void {
    const app = this.app
    if (!app.threadList) {
      this.listBox.visible = false
      return
    }
    const threads = app.store.threads
    const contentW = Math.min(100, Math.max(40, Math.floor((app.width * 2) / 3)))
    const contentH = Math.min(20, Math.max(5, app.height - 8))
    const rowW = Math.max(1, contentW - 4)

    const rows: TextChunk[][] = []
    rows.push([chunk(`Threads (${threads.length})`, S.appName)])
    rows.push([])

    if (threads.length === 0) {
      rows.push([chunk('No threads yet. Select lines in the content and press enter.', S.dim)])
    } else {
      // Visible window centered on the cursor.
      let start = Math.max(0, app.threadList.cursor - Math.floor(contentH / 2))
      let end = start + contentH
      if (end > threads.length) {
        end = threads.length
        start = Math.max(0, end - contentH)
      }
      for (let i = start; i < end; i++) {
        rows.push(this.buildThreadListRow(threads[i], i === app.threadList.cursor, rowW))
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

  /**
   * One row per THREAD. The author and snippet come from its first comment, and a
   * `+N` tail says how many more are inside — without it the row reads as though a
   * thread were a single comment, which is the whole confusion to avoid.
   */
  private buildThreadListRow(t: StoredThread, isCursor: boolean, w: number): TextChunk[] {
    const loc = `${t.file}:${t.range.start}-${t.range.end}`
    const first = t.comments[0]
    const author = first ? '@' + first.author : ''
    const snippet = first ? first.body.split('\n')[0] : ''
    const replies = Math.max(0, t.comments.length - 1)
    const stale = this.outdated.has(t.id)

    if (isCursor) {
      const bg = S.palette.cursorBg
      const row: TextChunk[] = [chunk('▶ ', { bg, fg: S.palette.accent, bold: true })]
      if (stale) row.push(chunk('[outdated] ', { bg, fg: S.palette.delFg }))
      row.push(chunk(loc + '  ', { bg }), chunk(author, withBg(S.mode, bg)))
      if (replies > 0) row.push(chunk(` +${replies}`, withBg(S.hotkey, bg)))
      row.push(chunk('  ', { bg }), chunk(snippet, withBg(S.text, bg)))
      return fitOverlayRow(row, w, { bg })
    }

    const row: TextChunk[] = [chunk('  ')]
    if (stale) row.push(chunk('[outdated] ', S.del))
    row.push(chunk(loc, S.dir), chunk('  '), chunk(author, S.mode))
    if (replies > 0) row.push(chunk(` +${replies}`, S.hotkey))
    row.push(chunk('  '), chunk(snippet, S.text))
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
        hasThreads ? chunk('●', { bg, fg: S.palette.threadMarker }) : null,
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

/** Cells reserved for a tree row's folder glyph, so names align under each other. */
const ICON_CELL_W = 2

/** Cells reserved at the right of every tree row: thread dot, gap, status badge. */
const TREE_GUTTER_W = 3

/**
 * iconCell pads a glyph out to a fixed cell budget.
 *
 * Nerd Font glyphs are one cell, emoji are two, and the whole point of the tree's
 * alignment is that neither shifts the filenames — so the glyph is measured rather
 * than assumed, and the difference is made up with spaces.
 */
function iconCell(icon: string): string {
  const iw = textWidth(icon)
  return iw >= ICON_CELL_W ? icon : icon + ' '.repeat(ICON_CELL_W - iw)
}

/**
 * pinRight lays a row out as `left … right`, exactly `w` columns wide, with the
 * right group flush against the last column.
 *
 * `left` is truncated when it would collide with `right` — the pinned group always
 * wins, because it is the thing whose alignment the layout exists to guarantee.
 */
function pinRight(
  left: TextChunk[],
  right: TextChunk[],
  w: number,
  padStyle?: Style,
): TextChunk[] {
  const rightW = chunksWidth(right)
  const room = Math.max(0, w - rightW)
  const trimmed = chunksWidth(left) > room ? truncateChunkList(left, room) : left
  const gap = Math.max(0, room - chunksWidth(trimmed))
  const out = [...trimmed]
  if (gap > 0) out.push(chunk(' '.repeat(gap), padStyle))
  // A pane too narrow to hold the gutter drops it rather than overflowing.
  if (rightW <= w) out.push(...right)
  return out
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

/** ISO timestamp → "YYYY-MM-DD HH:mm" in local time. */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
