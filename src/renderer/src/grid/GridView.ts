import type { Platform } from '../../../shared/commands/keybindings'
import type { ResultDescriptor } from '../../../shared/contracts'
import { liveTones, type LiveTone } from '../../../shared/live/catalog'
import { codiconClass } from '../../../shared/icons'
import { nextFrame } from '../core/frame'
import { gesturesFor } from '../core/gestures'
import { observeResize, windowOf, windows } from '../core/windows'
import { typeScale } from '../../../shared/theme/metrics'
import { monoFontFamily, uiFontFamily } from '../fonts'
import type { ResultHandle, RowWindow } from '../results/ResultClient'
import type { GridViewState } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { FLAG_ERROR, FLAG_NULL, FLAG_TRUNCATED } from '../results/worker-protocol'
import { registerGridAnchor, registerGridTarget, type GridTarget } from './anchor'
import { gridLimits as g } from './constants'
import { GridData, portBusy } from './data'
import { gridKeyAction, pageStep } from './keyboard'
import { cellKey, type GridMarks } from './marks'
import { ColumnLayout, frozenColumn, hitTest, rowHeaderWidth, visibleRange, type ColumnAxis, type VisibleRange } from './layout'
import { UniformLayout } from './uniform-layout'
import { fitWidth, initialWidth, measureCharWidth, sqlTypeLabel, typeHintChars } from './measure'
import { freshRing, ringStep, rotation, slotOf, type RowRing } from './ring'
import { RowSizes } from './row-sizes'
import { applyWheel, ensureVisible, normalizeWheel, offsetsDropped, onNativeScroll, rebaseRow, remap, rowsContainerY, rowTop, scrollCap, scrollModel, topRowOf, type ScrollModel } from './scroll'
import { columnTitle, covered, dragSelection, navigate, pressButton, pressSelection, rotateSelection, selectAll, windowRanges, type CellRange, type GridHit, type GridSelection, withinCap } from './selection'
import type { GridStats } from './stats'
import { remapSelection, remapTop, sameSelection, type RowMap } from './swap'
import { colorAt, highlightColors, type RowHighlights } from './highlights'
import { tableTiles, tileKey, transposedTiles, type TileShape } from './tiles'
import { whitespaceRuns, type WhitespaceMode } from './whitespace'
import { displayText } from '../../../shared/ipc/wire/cells'
import { limits as wire } from '../../../shared/ipc/wire/protocol'

// A cell's look is one of 4,096 class strings, picked by these bits.
// HIT, CUR and DIM are search in results' marks (marks.ts): a matched cell, the active match, a column the search leaves out.
// CHG and SOFT mark a diff's differing cell (results.diff): a value that changed, and one equal only by collation.
const NULL = 1, TRUNC = 2, ERR = 4, LINK = 8, SEL = 16, ACT = 32, LOAD = 64, HIT = 128, CUR = 256, DIM = 512, CHG = 1024, SOFT = 2048
const classes = Array.from({ length: 4096 }, (_, bits) => 'rg-c' + (bits & NULL ? ' is-null' : '') + (bits & TRUNC ? ' is-trunc' : '') + (bits & ERR ? ' is-err' : '')
  + (bits & LINK ? ' is-link' : '') + (bits & SEL ? ' is-sel' : '') + (bits & ACT ? ' is-act' : '') + (bits & LOAD ? ' is-load' : '')
  + (bits & HIT ? ' is-hit' : '') + (bits & CUR ? ' is-cur' : '') + (bits & DIM ? ' is-dim' : '') + (bits & CHG ? ' is-chg' : '') + (bits & SOFT ? ' is-soft' : ''))
/** A header's search mark: 0 none, 1 matched, 2 the active match, 3 dimmed. */
const headerMarks = ['', 'hit', 'cur', 'dim'] as const
const truncatedAt: Record<string, string> = { binary: '32,766 bytes', document: '2,097,152 characters', text: '65,535 characters' }
// A row's look is one class string too: odd or even, and its tone (none, one of liveTones, or a diff's added or removed
// row); the row number's likewise.
const rowTones = [...liveTones, 'added', 'removed'] as const
const toneIndex = new Map<string, number>(rowTones.map((tone, index) => [tone, index + 1]))
/** What a screen reader hears on a diff's added or removed row. */
const diffLabels: Readonly<Record<string, string>> = { added: 'added row', removed: 'removed row' }
// A highlight (highlights.ts) adds its colour's class to both: 0 for none, else 1 + its index in highlightColors.
const highlightClass = ['', ...highlightColors.map(color => ' hl hl-' + color)]
const rowClasses = [false, true].map(odd => ['', ...rowTones].map(tone => highlightClass.map(hl => 'rg-row' + (odd ? ' odd' : '') + (tone ? ' tone-' + tone : '') + hl)))
const markClasses = [false, true].map(sel => ['', ...rowTones].map(tone => highlightClass.map(hl => 'rg-rn' + (sel ? ' sel' : '') + (tone ? ' tone-' + tone : '') + hl)))
let nextGridId = 1
/** What a screen reader hears on a highlighted row's header. */
const highlightLabel = (highlight: number): string => 'Highlighted ' + highlightColors[highlight - 1]

/** `mode` is the white space mode `value` was written under; `marked`, that the cell shows marks (runs of nodes) in place of `text` alone. */
interface CellSlot { readonly el: HTMLDivElement; readonly text: Text; column: number; bits: number; value: string; mode: WhitespaceMode; marked: boolean; label: string; shown: boolean; left: number; width: number }
/**
 * A pooled row. `header` is its row header for screen readers, inside the row; `mark` draws the number in the sticky
 * row-number column (one composited layer for every row, where a sticky header in each row made a layer per row). The
 * active row's spare slot has no mark: it is out of view.
 */
interface RowSlot {
  /** `size` is what the mark's row-size bar shows ('' for none), so it is written only when it changes. */
  readonly el: HTMLDivElement; readonly header: HTMLDivElement; readonly number: Text; readonly mark?: SizeMark & { readonly text: Text } & NameParts
  readonly cells: CellSlot[]; readonly pin: CellSlot
  row: number; top: number; width: number; odd: boolean; headerSel: boolean; shown: boolean
  /** 0 for none, else 1 + the tone's index in rowTones. */
  tone: number
  /** The tone text last parsed, and its tone (0 for none, else 1 + its index in rowTones). */
  toneText: string
  toneOf: number
  /** A diff row's differing cells, as its tone column lists them after the tone (column numbers, a soft one with "~"), and
   *  their bits (CHG or SOFT) by column, parsed with the tone text. */
  cellMarks: ReadonlyMap<number, number> | undefined
  /** 0 for none, else 1 + the highlight's index in highlightColors. */
  highlight: number
}
/** What shows a row-size bar (a row's number). `size` is what the bar shows now. */
interface SizeMark { readonly el: HTMLElement; size: string }
interface SortButton { readonly el: HTMLSpanElement; readonly glyph: HTMLSpanElement; readonly order: Text; state: string }
interface FunnelButton { readonly el: HTMLSpanElement; readonly glyph: HTMLSpanElement; on: boolean }
/** A transposed grid's row mark is a name cell: it holds a column's name where a row number goes, with the type, sort
 *  button and funnel a header has. `look` is the class string it shows now (selected, unnamed, filterable, its search mark). */
interface NameParts { readonly type?: Text; readonly sort?: SortButton; readonly funnel?: FunnelButton; look?: string }
/** A highlighted row drawn as a column (transposed): one pooled band over its cells, since a cell's class has no bit left. */
interface BandSlot { readonly el: HTMLDivElement; color: number; left: number; width: number; height: number; shown: boolean }
/** A pooled column header: the name, then the SQL type (`type`, in muted small text and hidden from screen readers, which read it in the tooltip). Each is
 *  in its own bidi isolate (.rg-cn, .rg-ct), so a name with an unterminated override cannot reorder the type after it. */
interface HeaderSlot {
  readonly el: HTMLDivElement; readonly text: Text; readonly type: Text; column: number; sel: boolean; mark: number; shown: boolean; left: number; width: number
  /** The sort button (grids with `onSort`): its glyph, its place among several keys, and what it shows now ('' unsorted). */
  readonly sort?: SortButton
  /** The funnel button (grids with `onFilter`), filled while its column has a filter. */
  readonly funnel?: FunnelButton
  /** Transposed, where a header stands for a row: the text it shows ("Row 3", or the header column's value once read),
   *  the row's highlight (as RowSlot's) and its row-size bar. */
  label: string; highlight: number; size: string
}
/** A sorted column as its header shows it: its place among the sort's keys and its direction. */
export interface HeaderSortKey { readonly column: number; readonly descending: boolean }
interface Drag { readonly pointerId: number; readonly x0: number; readonly y0: number; x: number; y: number; dragging: boolean; readonly hit: GridHit; readonly modifiers: boolean }
/** A column border being dragged: the width follows the pointer once a frame, and Escape puts `width0` back. */
interface Resize { readonly pointerId: number; readonly column: number; readonly x0: number; readonly width0: number; readonly wasUserSized: boolean; x: number; applied: number }
/** What the React shell shows under the grid: a failed tile read, or a grid that stopped after repeated failures. */
export interface GridStatus { readonly tileError?: string; readonly renderError?: boolean }
/** What a frame showed: the first and last rows in the body, the rows available, and whether the view is at the end. */
export interface GridViewport { readonly firstRow: number; readonly lastRow: number; readonly rows: number; readonly atEnd: boolean }

export interface GridViewOptions {
  /** The grid's root (`role="grid"`) and its scroller, both rendered by the React shell; the view owns the scroller's children. */
  readonly root: HTMLElement
  readonly scroller: HTMLElement
  readonly handle: ResultHandle
  readonly client: { readonly windowsInFlight: number }
  readonly descriptor: ResultDescriptor
  readonly state: GridViewState
  /** What the grid's selection belongs to: a result's entry key (a live grid has one of its own). A selection made for
   *  another counts as none. */
  readonly entry: string
  /** The number the result is named by, and how many the run shows: "Result 2 of 3". */
  readonly resultNumber: number
  readonly resultCount: number
  /** The grid's name, which its accessible label starts with (a live grid's "Sessions"); "Result N of M" otherwise. */
  readonly label?: string
  readonly platform: Platform
  readonly stats?: GridStats
  /** Whether headers show each column's SQL type after its name (Tools › Options › Query Results › Results to Grid). */
  readonly showTypes?: boolean
  /** How cells show spaces, tabs and line breaks (queryResults.grid.whitespace); `none` by default. */
  readonly whitespace?: WhitespaceMode
  /** A bar behind each row number shows the row's bytes (queryResults.grid.rowSize); off by default. */
  readonly rowSize?: boolean
  onSelection(selection: GridSelection): void
  /** Edit › Copy (the copy event), and a live grid's Ctrl+C (with `headers`, its Ctrl+Shift+C): runs Copy. */
  onCopy(headers?: boolean): void
  /**
   * The grid serves Ctrl+A, Ctrl+C and Ctrl+Shift+C (⌘ on macOS) itself: a live grid with its own menu. A results grid, and a
   * live grid in Query Output's menu, leave them to the catalogue's output.selectAll and output.copy, which KeybindingService
   * dispatches, so they can be remapped.
   */
  readonly clipboardKeys?: boolean
  /** Escape outside a drag or resize: cancels the tab's copy or save; false when there was none. */
  onEscape(): boolean
  onStatus(status: GridStatus): void
  /** Whether the columns are wider than the grid, so it shows a horizontal scroll bar when it has no vertical one; reported on change. */
  onWide?(wide: boolean): void
  onError(error: unknown): void
  /** Opens an XML, JSON or plan value; without it no cell is a link. */
  onOpenValue?(row: number, column: number): void
  /** A live table's log (LiveGrid): when the view is at the last row as rows arrive, it stays at the last row. */
  readonly followTail?: boolean
  /** After a frame that changed what it showed (LiveGrid: follow tail, tracked rows). */
  onViewport?(viewport: GridViewport): void
  /** What a screen reader hears for a toned row's active cell ("blocked"); nothing when it returns undefined. */
  toneLabel?(tone: LiveTone): string | undefined
  /** The columns the grid is sorted by, in order; their headers show it. */
  readonly sort?: readonly HeaderSortKey[]
  /** A header's sort button was clicked (`add`: grid.addSortKey's modifier was held); without it headers have none. */
  onSort?(column: number, add: boolean): void
  /** The columns with a filter of their own; their funnels show it. */
  readonly filtered?: ReadonlySet<number>
  /** A header's funnel was clicked: the popover opens under `anchor`. Without it headers have none. */
  onFilter?(column: number, anchor: DOMRect): void
  /** The columns whose headers have a funnel, when not every column's: a live source filters only some (its facets). */
  readonly filterable?: ReadonlySet<number>
  /**
   * Draws the result transposed: its columns as rows, named in a frozen first column, and its first
   * `limits.transpose.maxRows` rows as columns. Only what is drawn turns: the selection in the state, the marks, the
   * highlights and every callback stay in the result's own rows and columns. Fixed for the view's life (the shell builds
   * another to change it); the transposed view's scroll offsets and widths are kept apart, in the state's `transposed`.
   * Not for a result with a tone column (a comparison, a live table).
   */
  readonly transposed?: boolean
  /** Transposed: the column whose value heads each drawn column, in place of "Row N" (Using Column as Headers). */
  readonly headerColumn?: number
  /** Transposed: a search match to reveal is in a row past those drawn, so nothing moved. */
  onBeyondCap?(row: number): void
}

/**
 * One result set's grid: an imperative view over pooled DOM nodes, so each frame costs only the cells that enter the
 * view. Rows and cells live in slots reused by index (row r in slot r mod n); a cell's look is one class string and its
 * text a persistent Text node, written only when they change. Up to the scroll cap the scroller is native; past it the
 * view maps a cap-tall scroller onto the rows (scroll.ts). Exactly one animation frame is pending at a time; a frame
 * reads the scroller first and writes after. Widths live in the grid's saved state: the first rows size the columns
 * once, and after that only the user does, by dragging a header's border or double-clicking it to fit. Every frame and
 * listener is contained: after 3 failures in a row the grid stops and its shell offers Retry.
 */
export class GridView {
  private readonly o: GridViewOptions
  private get gestures() { return gesturesFor(this.o.platform) }
  private readonly root: HTMLElement
  private readonly scroller: HTMLElement
  private readonly spacer: HTMLDivElement
  private readonly head: HTMLDivElement
  private readonly corner: HTMLDivElement
  private readonly rowsEl: HTMLDivElement
  /** The sticky row-number column (hidden from screen readers, which read each row's own header) and its rows. */
  private readonly marks: HTMLDivElement
  private readonly marksRows: HTMLDivElement
  private data: GridData
  private handle: ResultHandle
  private descriptor: ResultDescriptor
  private stopHandle: () => void = () => {}
  private readonly layout: ColumnAxis
  /** Transposed (the option): what is drawn is turned, and `layout` is `uniform`. */
  private readonly rotated: boolean
  private readonly uniform: UniformLayout | undefined
  /** The size of the tiles the grid reads and looks cells up in. */
  private readonly tiles: TileShape
  /** Where the view's scroll offsets are kept: the grid's saved state, or its `transposed` part. */
  private readonly offsets: { topRow: number; virtualTop: number; scrollLeft: number }
  /** Transposed: the column that heads the drawn columns, the state's selection and the same as drawn (turned once per
   *  change), the frozen name column's width, the highlight bands and the first drawn column of the last frame. */
  private headerColumn: number | undefined
  private turnedFrom: GridSelection | undefined
  private turnedTo: GridSelection | undefined
  private nameWidth = 0
  /** The state's saved name width when a drag of its border began, for Escape. */
  private nameWidthBefore: number | undefined
  private readonly bandsEl: HTMLDivElement | undefined
  private bands: BandSlot[] = []
  private lastFirstColumn = 0
  /** The columns shown: all but a live table's hidden tone column (its last, at `tone`; -1 when it has none). */
  private readonly columns: number
  private readonly tone: number
  /** Rows a live revision lists as departed: muted, whatever their tone column says. */
  private muted: ReadonlySet<number> = new Set()
  /** Highlighted rows (setHighlights); only those of the handle shown are drawn. */
  private highlights: RowHighlights | undefined
  private highlightSets: readonly RowHighlights[] = []
  /** Search in results' marks, while the tab has a search. */
  private searchMarks: GridMarks | undefined
  /** A search match revealed in this grid, to bring into view in the panes around it (the results stack) once painted. */
  private outerReveal: { readonly row: number; readonly column: number; frames: number } | undefined
  private links: Uint8Array
  private readonly gid = nextGridId++
  private readonly slots = new WeakMap<Element, { row?: RowSlot; cell?: CellSlot; header?: HeaderSlot }>()
  private readonly cleanup: (() => void)[] = []
  private rowSlots: RowSlot[] = []
  /** How rows map to `rowSlots` (ring.ts); undefined until the pool has rows to show. */
  private ring: RowRing | undefined
  /** The slot the DOM's rotation of row slots starts with: it catches up with the ring's once the rows stop moving. */
  private domStart = 0
  /** The first row the last frame showed, to tell a frame that scrolled from one that did not. */
  private shownFirst = Number.NaN
  private pinSlot: RowSlot
  /** Whether the active row's spare slot comes before the ring in the DOM (its row is above the rows shown). */
  private pinFirst = true
  private headerSlots: HeaderSlot[] = []
  private cellsPerRow = 0
  private model: ScrollModel | undefined
  private cap: number
  private capOverride: number | undefined
  private charWidth: number
  private headerWidth: (text: string) => number
  private typeWidth: (text: string) => number
  /** Each column's SQL type as its header shows it (of the result shown: a swap takes the new descriptor's). */
  private types: readonly string[]
  private showTypes: boolean
  private whitespace: WhitespaceMode
  /** Each sorted column's place among the keys and direction. */
  private sortKeys: ReadonlyMap<number, { readonly at: number; readonly descending: boolean }>
  private filtered: ReadonlySet<number>
  private filterable: ReadonlySet<number> | undefined
  /** The row-size bar's sizes for the handle shown, while the bar is on. */
  private sizes: RowSizes | undefined
  private rowHeader = 0
  private width = -1
  private spacerHeight = -1
  private containerY = Number.NaN
  private baseRow = 0
  private written: number | undefined
  private pendingTop: number | undefined
  private pendingLeft: number | undefined
  /** Whether a scroll event came since the last frame, and the scroller's offsets that frame left (offsetsDropped). */
  private scrolled = false
  /** The panes changed since the last frame (panesChanged), so offsets found at 0 may be a DOM move's reset. */
  private moved = false
  private lastTop = 0
  private lastLeft = 0
  private viewportWidth = 0
  /** The scroller's width with its vertical scroll bar: a grid sized to its rows has none. */
  private outerWidth = 0
  private wide: boolean | undefined
  private viewportHeight = 0
  private lastTopRow = 0
  private cancelFrame: (() => void) | undefined
  private failures = 0
  private stopped = false
  private disposed = false
  private wheelAttached = false
  private drag: Drag | undefined
  private resizing: Resize | undefined
  private resizeHover = false
  private fitting: AbortController | undefined
  private lastRange: VisibleRange | undefined
  private activeEl: HTMLElement | undefined
  private hovered: HTMLElement | undefined
  private ariaAt = Number.NEGATIVE_INFINITY
  private ariaRows = -1
  private ariaLabel = ''
  private ariaTimer: ReturnType<typeof setTimeout> | undefined
  private resultCount: number
  private measuring = false
  private measureAfter = 0
  /** The click count of the last press (a double-click's second press opens no second value tab). */
  private clicks = 0
  private status: GridStatus = {}
  /** Whether the last frame showed the last row (a view with no rows counts as at the end): follow tail starts from it. */
  private atEnd = true
  private viewport: GridViewport | undefined

  constructor(o: GridViewOptions) {
    this.o = o
    this.root = o.root
    this.scroller = o.scroller
    this.handle = o.handle
    this.descriptor = o.descriptor
    this.tone = toneColumnOf(o.descriptor)
    this.columns = o.descriptor.columns.length - (this.tone >= 0 ? 1 : 0)
    this.resultCount = o.resultCount
    // A follow-tail grid built over a kept state that had left the tail opens where it was, not at the newest rows.
    this.atEnd = o.state.following ?? true
    this.links = this.linksOf(o.descriptor)
    const measure = fontMeasure()
    this.charWidth = measure.charWidth
    this.headerWidth = measure.header
    this.typeWidth = measure.type
    this.types = o.descriptor.columns.map(sqlTypeLabel)
    this.showTypes = o.showTypes ?? true
    this.whitespace = o.whitespace ?? 'none'
    this.sortKeys = sortMap(o.sort)
    this.filtered = o.filtered ?? new Set()
    this.filterable = o.filterable
    if (o.rowSize) this.sizes = this.sizesFor(o.handle)
    this.capOverride = o.stats?.scrollCap
    this.cap = this.capOverride ?? scrollCap(windowOf(o.root).devicePixelRatio)
    this.rotated = !!o.transposed
    this.tiles = this.rotated ? transposedTiles : tableTiles
    this.headerColumn = this.rotated ? this.validHeaderColumn(o.headerColumn) : undefined
    if (this.rotated) {
      // One width for every drawn column, from the widest type hint until the first rows are measured.
      const kept: NonNullable<GridViewState['transposed']> = o.state.transposed ??= { topRow: 0, virtualTop: 0, scrollLeft: 0, width: this.sharedWidth(Math.max(1, ...o.descriptor.columns.slice(0, this.columns).map(typeHintChars))), overrides: new Map(), sized: false }
      this.nameWidth = kept.nameWidth === undefined ? this.fittedNameWidth(g.nameColumnMaxWidth) : this.boundedNameWidth(kept.nameWidth)
      this.offsets = kept
      this.layout = this.uniform = new UniformLayout(kept, this.cap - this.nameWidth)
      this.uniform.setCount(this.drawnColumns())
      this.root.dataset.orientation = 'transposed'
    } else {
      // Widths belong to the grid's saved state; they are allocated on first mount, from the declared types.
      if (!o.state.widths || o.state.widths.length !== this.columns) {
        o.state.widths = Float64Array.from(o.descriptor.columns.slice(0, this.columns), (column, index) => initialWidth(this.headerTextWidth(index), typeHintChars(column), this.charWidth))
        o.state.sized = false
      } else if (o.state.widths.some(Number.isNaN)) {
        // A rebuilt Pivot keeps the widths of the columns it shares with the old one by name; the rest start as new.
        o.state.widths = o.state.widths.map((width, index) => Number.isNaN(width) ? initialWidth(this.headerTextWidth(index), typeHintChars(o.descriptor.columns[index]), this.charWidth) : width)
      }
      this.offsets = o.state
      this.layout = new ColumnLayout(o.state.widths, this.cap - rowHeaderWidth(0, this.charWidth))
    }
    const doc = this.scroller.ownerDocument
    const div = (className: string, role?: string) => { const element = doc.createElement('div'); element.className = className; if (role) element.setAttribute('role', role); return element }
    this.spacer = div('rg-spacer')
    this.head = div('rg-head', 'row')
    this.head.setAttribute('aria-rowindex', '1')
    this.corner = div('rg-corner', 'columnheader')
    this.corner.setAttribute('aria-colindex', '1')
    this.corner.setAttribute('aria-label', 'Select all')
    const { batchNumber, iteration } = o.descriptor
    this.corner.title = batchNumber > 1 || iteration > 1 ? `Select all · Batch ${batchNumber}${iteration > 1 ? ' / repeat ' + iteration : ''}` : 'Select all'
    this.head.append(this.corner)
    this.rowsEl = div('rg-rows', 'rowgroup')
    this.marks = div('rg-rhs')
    this.marks.setAttribute('aria-hidden', 'true')
    this.marksRows = div('rg-rhs-rows')
    this.marks.append(this.marksRows)
    this.spacer.append(this.marks, this.head, this.rowsEl)
    if (this.rotated) {
      this.bandsEl = div('rg-bands')
      this.bandsEl.setAttribute('aria-hidden', 'true')
      this.spacer.append(this.bandsEl)
    }
    this.pinSlot = this.createRow(false)
    this.scroller.replaceChildren(this.spacer)
    this.root.setAttribute('aria-colcount', String(this.drawnColumns() + 1))
    this.data = this.dataFor(o.handle)
    this.listen()
    this.stopHandle = o.handle.subscribe(() => this.schedule())
    this.cleanup.push(() => this.stopHandle(), registerGridAnchor(this.root, () => this.menuAnchor()), registerGridTarget(this.root, element => this.targetOf(element)))
    if (this.rotated) this.cleanup.push(() => { delete this.root.dataset.orientation })
    if (o.stats) this.cleanup.push(o.stats.add({ counters: () => this.data.counters, nodes: () => this.root.getElementsByTagName('*').length + 1, setScrollCap: px => { this.capOverride = px; this.updateCap() } }))
    this.viewportWidth = this.scroller.clientWidth
    this.outerWidth = this.scroller.offsetWidth
    this.viewportHeight = this.scroller.clientHeight
    // The first frame is drawn now, not a frame later: the rows of a tile already cached show at once, and the others are
    // requested a frame sooner.
    this.runFrame()
  }

  /** A key from the shell's onKeyDown; true when the grid handled it (and the caller prevents its default). */
  key(event: KeyboardEvent): boolean {
    if (this.disposed || event.isComposing || event.altKey) return false
    const action = gridKeyAction(event, this.o.platform, !!this.o.clipboardKeys)
    if (!action) return false
    try {
      switch (action.type) {
        case 'copy': this.o.onCopy(); return true
        case 'copyHeaders': this.o.onCopy(true); return true
        case 'escape':
          if (this.resizing) { this.endResize(true); return true }
          if (this.drag) { this.endDrag(); return true }
          return this.o.onEscape()
        case 'open': {
          // A held Enter opens one tab, not one per repeat.
          if (event.repeat) return true
          const active = this.o.state.selection?.active
          if (!active || !this.links[active.column] || active.row >= (this.rotated ? this.drawnColumns() : this.rows())) return false
          this.o.onOpenValue?.(active.row, active.column)
          return true
        }
        default: {
          // The keys move over what is drawn: in a transposed grid Right is the result's next row, and Ctrl+End the last
          // column's value in the last row drawn.
          const rows = this.drawnRows(), columns = this.drawnColumns()
          if (rows <= 0 || columns <= 0) return true
          const current = this.selection() ?? firstCell(this.o.entry)
          const next = navigate(current, action, { rows, columns, pageRows: pageStep(this.viewportHeight - g.headerHeight) })
          this.select(next)
          this.reveal(next.active.row, next.active.column)
          return true
        }
      }
    } catch (error) { this.o.onError(error); return true }
  }

  /** Select All (Ctrl+A and the command): an open-ended block that grows as rows stream in. */
  selectAll(): void { this.select(selectAll(this.o.entry, this.selection()?.active)) }
  /** The selection changed elsewhere (a command): paint it. */
  repaint(): void { this.schedule() }
  /** The active cell's box, which keyboard-opened menus open below. */
  activeCellRect(): DOMRect | undefined { return this.menuAnchor().getBoundingClientRect() }
  /** Retry after failed tile reads or a stopped grid. */
  retry(): void {
    this.failures = 0
    this.stopped = false
    this.data.retry()
    this.setStatus({})
    this.schedule()
  }
  /** `headerColumn` (a transposed grid's): a column, or null for none; absent leaves it as it is. */
  update(o: { resultCount: number; showTypes?: boolean; whitespace?: WhitespaceMode; sort?: readonly HeaderSortKey[]; rowSize?: boolean; filtered?: ReadonlySet<number>; filterable?: ReadonlySet<number>; headerColumn?: number | null }): void {
    if (this.rotated && o.headerColumn !== undefined && this.validHeaderColumn(o.headerColumn) !== this.headerColumn) {
      // Its tile is read with the rows from the next frame on, and each header shows its value once read.
      this.headerColumn = this.data.also = this.validHeaderColumn(o.headerColumn)
      this.schedule()
    }
    if (o.filtered && !sameSet(o.filtered, this.filtered)) { this.filtered = o.filtered; this.schedule() }
    if (o.filterable && (!this.filterable || !sameSet(o.filterable, this.filterable))) {
      this.filterable = o.filterable
      // Each header shows or hides its funnel again (a transposed grid's name cells do each frame).
      for (const header of this.headerSlots) header.column = -1
      this.schedule()
    }
    const showTypes = o.showTypes ?? this.showTypes, whitespace = o.whitespace ?? this.whitespace
    if (o.rowSize !== undefined && o.rowSize !== !!this.sizes) {
      this.sizes?.dispose()
      this.sizes = o.rowSize ? this.sizesFor(this.handle) : undefined
      this.schedule()
    }
    if ('sort' in o) {
      const sortKeys = sortMap(o.sort)
      if (!sameSortMap(sortKeys, this.sortKeys)) { this.sortKeys = sortKeys; this.schedule() }
    }
    if (o.resultCount === this.resultCount && showTypes === this.showTypes && whitespace === this.whitespace) return
    this.resultCount = o.resultCount
    // Each cell compares its mode with this one as it paints, and writes its value again.
    this.whitespace = whitespace
    if (showTypes !== this.showTypes) {
      // Widths stay as they are; every header writes its type again.
      this.showTypes = showTypes
      for (const header of this.headerSlots) header.column = -1
      // A transposed grid shows the types after the names, down its name column, which fits them unless it was sized by hand.
      if (this.rotated) {
        for (const slot of this.rowSlots) slot.row = -1
        if (this.o.state.transposed!.nameWidth === undefined) this.nameWidth = this.fittedNameWidth(g.nameColumnMaxWidth)
      }
    }
    this.schedule()
  }
  invalidate(): void { this.schedule() }
  /** Search in results' marks for this grid (undefined: none). Cells marks name by row are drawn only while the grid shows
   *  the rows they number (`marks.handle`). */
  setMarks(marks: GridMarks | undefined): void {
    if (marks === this.searchMarks) return
    this.searchMarks = marks
    this.schedule()
  }
  /** Scrolls the active match into view: its cell, or in columns mode its column at the rows in view. False when the marks
   *  number rows this grid does not show (a sort it has not swapped to yet). `select` (F3 in a grid): the match also becomes
   *  the active cell and this grid takes the focus, so the cell is announced and Copy copies it; only while the focus is
   *  still in one of the run's grids, so a reveal that waited (for the match's rows, a sort's swap or a search again) never
   *  takes it from the editor or the search box. */
  revealMark(select = false): boolean {
    const marks = this.searchMarks
    select &&= this.focusInRun()
    if (marks?.current && marks.handle === this.handle) {
      // Transposed, a match in a row past those drawn has no cell to show: the owner is told, and nothing moves.
      if (this.rotated && marks.current.row >= wire.transpose.maxRows) { this.o.onBeyondCap?.(marks.current.row); return true }
      const at = this.rotated ? { row: marks.current.column, column: marks.current.row } : marks.current
      // A hidden column (a diff's or live table's tone) is never the active cell.
      if (select && marks.current.column < this.columns) this.selectCell(at.row, at.column)
      this.reveal(at.row, at.column)
      this.outerReveal = { row: at.row, column: at.column, frames: 10 }
      return true
    }
    if (this.rotated && marks?.currentColumn !== undefined && marks.currentColumn < this.columns) {
      // A matched column is a drawn row: it scrolls into view vertically, at the drawn columns in view.
      const columns = this.drawnColumns()
      if (select && columns > 0) this.selectCell(marks.currentColumn, Math.min(columns - 1, this.firstColumnInView()))
      this.reveal(marks.currentColumn, -1)
      return true
    }
    if (marks?.currentColumn !== undefined && marks.currentColumn < this.columns) {
      const rows = this.rows()
      const row = Math.min(Math.max(0, rows - 1), this.viewport?.firstRow ?? this.selection()?.active.row ?? 0)
      if (select && rows > 0) this.selectCell(row, marks.currentColumn)
      this.reveal(row, marks.currentColumn)
      return true
    }
    return false
  }
  private focusInRun(): boolean { return focusInRun(this.root, this.root.ownerDocument.activeElement) }
  /** The first drawn column in the body now (not the overscan before it). */
  private firstColumnInView(): number { return Math.max(0, Math.min(this.layout.count - 1, this.layout.columnAt(this.offsets.scrollLeft))) }
  /** Makes a cell, named as drawn, the selection and the active cell. */
  private selectCell(row: number, column: number): void {
    this.select(cellSelection(this.o.entry, row, column))
    this.root.focus({ preventScroll: true })
  }

  /** The grid's highlighted rows, one set per handle it may show (its result's and a sorted view's): it draws the set of the
   *  handle it shows, now and after a swap. */
  setHighlights(sets: readonly RowHighlights[]): void {
    this.highlightSets = sets
    const shown = sets.find(set => set.handle === this.handle)
    if (shown === this.highlights) return
    this.highlights = shown
    this.schedule()
  }

  /**
   * Shows another result with the same columns in place of this one (a live table's next revision or segment): widths and
   * scroll stay, the first row shown, the active cell and each block move through `mapRow` (swap.ts), and `muted` rows
   * (departed) are muted until the next swap; `top` puts the view at that offset instead (a restarted live log). Reads of
   * the old result stop; the old result is not closed (its owner does).
   */
  swap(handle: ResultHandle, descriptor: ResultDescriptor, mapRow: RowMap, o: { readonly muted?: readonly number[]; readonly top?: number } = {}): void {
    if (this.disposed) return
    if (toneColumnOf(descriptor) !== this.tone || descriptor.columns.length !== this.descriptor.columns.length) throw new Error('A swapped result must have the grid\'s columns.')
    const state = this.o.state
    this.fitting?.abort()
    this.fitting = undefined
    this.stopHandle()
    this.data.dispose()
    this.handle = handle
    this.descriptor = descriptor
    this.types = descriptor.columns.map(sqlTypeLabel)
    this.links = this.linksOf(descriptor)
    this.data = this.dataFor(handle)
    if (this.sizes) { this.sizes.dispose(); this.sizes = this.sizesFor(handle) }
    this.stopHandle = handle.subscribe(() => this.schedule())
    this.muted = new Set(o.muted ?? [])
    this.highlights = this.highlightSets.find(set => set.handle === handle)
    const selection = this.sourceSelection()
    if (selection) {
      state.selection = remapSelection(selection, mapRow, handle.getSnapshot().rowsAvailable, this.columns)
      // The owner hears of a moved selection as of any other (a details pane, Kill, the active row's key).
      if (state.selection && !sameSelection(selection, state.selection)) this.o.onSelection(state.selection)
    }
    if (!this.rotated) this.pendingTop = o.top ?? remapTop(this.pendingTop ?? this.offsets.virtualTop, mapRow)
    // Transposed, the rows run across: a new order or other rows start at the first of them again, and the widths given to
    // positions that now hold other rows go. Which column was being read (the vertical offset) stays.
    else if (o.top !== undefined) { this.pendingLeft = 0; this.uniform!.clearOverrides() }
    // The orientation not shown keeps its own place in the state, which a new order or other rows put back at the start too.
    if (o.top !== undefined) {
      if (this.rotated) { state.virtualTop = Math.max(0, o.top); state.topRow = topRowOf(state.virtualTop) }
      else if (state.transposed) { state.transposed.scrollLeft = 0; state.transposed.overrides.clear() }
    }
    if (this.hovered) { this.hovered.removeAttribute('title'); this.hovered = undefined }
    this.schedule()
  }
  /**
   * Reads the tiles a swap to `handle` shows first (from `firstRow`, over the rows and columns in view now) into the window
   * cache, so the swap paints whole rows at once rather than a frame of empty cells. Failures are left to the swap's reads.
   */
  prepare(handle: ResultHandle, firstRow: number, signal?: AbortSignal): Promise<void> {
    const range = this.lastRange && this.sourceRange(this.lastRange), rows = handle.getSnapshot().rowsAvailable
    if (!range || rows <= 0 || this.disposed) return Promise.resolve()
    const first = Math.max(0, Math.min(firstRow, rows - 1)), last = Math.min(rows - 1, first + Math.max(0, range.lastRow - range.firstRow))
    const data = this.dataFor(handle)
    return Promise.allSettled(data.plan({ ...range, firstRow: first, lastRow: last }, rows).map(key => data.fetch(key, signal))).then(() => undefined)
  }
  /** Scrolls to the last row (a live log's "n new rows" button): follow tail goes on from there. */
  revealEnd(): void {
    this.pendingTop = Number.MAX_SAFE_INTEGER
    this.schedule()
  }
  /** The grid's selection, when it is in this grid. */
  currentSelection(): GridSelection | undefined { return this.sourceSelection() }
  /** What the last frame showed. */
  lastViewport(): GridViewport | undefined { return this.viewport }
  /**
   * The panes around the grid changed: closing and opening its pane within one frame moves the grid without resizing it,
   * and the move resets the scroller's offsets to 0 without a scroll event. Until the next frame writes the saved offsets
   * back, a press must take a reset to 0 for that move, not for a native scroll to the top.
   */
  panesChanged(): void {
    this.moved = true
    this.schedule()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fitting?.abort()
    this.resizing = undefined
    this.cancelFrame?.()
    this.cancelFrame = undefined
    this.data.dispose()
    this.sizes?.dispose()
    if (this.ariaTimer !== undefined) clearTimeout(this.ariaTimer)
    for (const dispose of this.cleanup.splice(0)) { try { dispose() } catch (error) { this.o.onError(error) } }
    this.scroller.replaceChildren()
  }

  private rows(): number { return this.handle.getSnapshot().rowsAvailable }
  /** The rows and columns drawn: the result's own, or turned, with at most `limits.transpose.maxRows` rows as columns. */
  private drawnRows(rows = this.rows()): number { return this.rotated ? this.columns : rows }
  private drawnColumns(rows = this.rows()): number { return this.rotated ? Math.min(rows, wire.transpose.maxRows) : this.columns }
  private sizesFor(handle: ResultHandle): RowSizes { return new RowSizes(handle, () => this.schedule()) }
  private dataFor(handle: ResultHandle): GridData {
    return new GridData({ handle, columns: this.columns, tone: this.tone, shape: this.tiles, also: this.headerColumn, clientInflight: () => this.o.client.windowsInFlight, changed: () => this.schedule() })
  }
  private linksOf(descriptor: ResultDescriptor): Uint8Array {
    return Uint8Array.from(descriptor.columns, column => this.o.onOpenValue && (column.role === 'xml' || column.role === 'json' || column.role === 'plan') ? 1 : 0)
  }
  // The seams between what the grid draws and the result's own rows and columns. Geometry, pools, scrolling, presses, drags
  // and keys work in drawn rows and columns; the state, the marks and every callback are in the result's. In a table the two
  // are the same and each seam is the identity; transposed, each swaps rows with columns: the selection read (`selection`)
  // and written (`select`), the range the reads are asked for (`sourceRange`), a cell's lookup (`paintCell`), and what is
  // reported out (`targetOf`, `buttonColumn`, Open Value, Fit).
  /** The grid's selection as its state keeps it: in the result's rows and columns. */
  private sourceSelection(): GridSelection | undefined {
    const selection = this.o.state.selection
    return selection?.entry === this.o.entry && selection.blocks.length > 0 ? selection : undefined
  }
  /** The selection as drawn, which presses, drags, keys and the frame work in: the state's, turned when transposed. */
  private selection(): GridSelection | undefined {
    const source = this.sourceSelection()
    if (!source || !this.rotated) return source
    if (source !== this.turnedFrom) { this.turnedFrom = source; this.turnedTo = withinCap(rotateSelection(source)) }
    return this.turnedTo
  }
  /** Takes a selection as drawn; the state and the owner get it in the result's rows and columns. */
  private select(selection: GridSelection): void {
    if (!this.rotated) {
      if (selection === this.o.state.selection) return
      this.o.state.selection = selection
    } else {
      if (selection === this.selection()) return
      this.turnedTo = selection
      this.o.state.selection = this.turnedFrom = rotateSelection(selection)
    }
    this.o.onSelection(this.o.state.selection)
    this.schedule()
  }
  /** A frame's range in the result's rows and columns, as the reads are asked for. */
  private sourceRange(range: VisibleRange): VisibleRange {
    return this.rotated ? { firstRow: range.firstColumn, lastRow: range.lastColumn, firstColumn: range.firstRow, lastColumn: range.lastRow } : range
  }
  /** Scrolls a cell into view on the next frame ('nearest', never smooth). */
  private reveal(row: number, column: number): void {
    const target = ensureVisible({
      virtualTop: this.pendingTop ?? this.offsets.virtualTop, scrollLeft: this.pendingLeft ?? this.offsets.scrollLeft, viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight, rowHeader: this.rowHeader, layout: this.layout, rows: this.drawnRows()
    }, row, column)
    this.pendingTop = target.virtualTop
    this.pendingLeft = target.scrollLeft
    this.schedule()
  }

  /** A grid sized to its rows has nothing to scroll: its match may be below the stack's fold, so the painted cell is
   *  brought into view in its scrolling ancestors and its own scroller, as little as it takes. A grid the stack has just
   *  built has no size for its first frames and paints nothing: the reveal waits a few frames for its cell. */
  private revealOuter(): void {
    const target = this.outerReveal
    if (!target) return
    for (const slot of this.rowSlots) {
      if (!slot.shown || slot.row !== target.row) continue
      const cell = slot.cells.find(cell => cell.shown && cell.column === target.column)
      if (!cell) break
      this.outerReveal = undefined
      cell.el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
    if (--target.frames <= 0) this.outerReveal = undefined
    else this.schedule()
  }

  private schedule(): void {
    if (this.cancelFrame || this.disposed || this.stopped) return
    this.cancelFrame = nextFrame(() => {
      this.cancelFrame = undefined
      this.runFrame()
    })
  }

  private runFrame(): void {
    if (this.disposed || this.stopped) return
    const started = performance.now()
    try {
      this.render()
      this.revealOuter()
      this.failures = 0
    } catch (error) {
      this.o.onError(error)
      if (++this.failures >= 3) { this.stopped = true; this.setStatus({ ...this.status, renderError: true }) }
      else this.schedule()
    }
    this.o.stats?.frame(performance.now() - started)
  }

  /** Paints a frame that is still pending now, so the slots say what the next paint would show. */
  private flushFrame(): void {
    if (!this.cancelFrame) return
    this.cancelFrame()
    this.cancelFrame = undefined
    this.runFrame()
  }

  /**
   * What a keyboard-opened menu opens below: the active cell, else the first cell in view, else the header row. A frame
   * still pending (a click or key just moved the active cell) is painted first.
   */
  private menuAnchor(): Element {
    this.flushFrame()
    if (this.activeEl) return this.activeEl
    const range = this.lastRange
    if (range && this.rowSlots.length > 0 && this.ring) {
      const slot = this.rowSlots[slotOf(this.ring, range.firstRow, this.rowSlots.length)]
      const first = slot.shown && slot.row === range.firstRow ? slot.cells.find(cell => cell.shown && cell.column === range.firstColumn) : undefined
      if (first) return first.el
    }
    return this.head
  }

  private setStatus(status: GridStatus): void {
    if (status.tileError === this.status.tileError && status.renderError === this.status.renderError) return
    this.status = status
    this.o.onStatus(status)
  }

  private updateCap(): void {
    const cap = this.capOverride ?? scrollCap(windowOf(this.root).devicePixelRatio)
    if (cap === this.cap) return
    this.cap = cap
    this.layout.setMaxTotal(cap - this.rowHeader)
    this.schedule()
  }

  private listen(): void {
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      const guarded = (event: HTMLElementEventMap[K]) => { try { listener(event) } catch (error) { this.o.onError(error) } }
      target.addEventListener(type, guarded, options)
      this.cleanup.push(() => target.removeEventListener(type, guarded, options))
    }
    on(this.scroller, 'scroll', () => { this.scrolled = true; this.schedule() }, { passive: true })
    // A press on a scroll bar focuses the scroller, which has no name and no active cell: the grid keeps the focus.
    on(this.scroller, 'focus', () => this.root.focus({ preventScroll: true }))
    on(this.root, 'pointerdown', event => this.pointerDown(event))
    on(this.root, 'mousedown', event => this.mouseDown(event))
    on(this.root, 'pointermove', event => this.pointerMove(event))
    on(this.root, 'pointerup', event => this.pointerUp(event))
    on(this.root, 'lostpointercapture', () => { if (this.resizing) this.endResize(false); if (this.drag) this.endDrag() })
    on(this.root, 'dblclick', event => this.doubleClick(event))
    on(this.root, 'pointerover', event => this.hover(event.target))
    // Chromium enables Edit › Copy without a text selection only when beforecopy is cancelled; the copy event then runs Copy.
    const beforeCopy = (event: Event) => event.preventDefault()
    this.root.addEventListener('beforecopy', beforeCopy)
    this.cleanup.push(() => this.root.removeEventListener('beforecopy', beforeCopy))
    on(this.root, 'copy', event => { event.preventDefault(); this.o.onCopy() })
    // Observed from the window the grid is in, which changes when its panel pops out or docks back.
    const resize = observeResize(this.scroller, () => {
      try {
        this.viewportWidth = this.scroller.clientWidth
        this.outerWidth = this.scroller.offsetWidth
        this.viewportHeight = this.scroller.clientHeight
        this.updateCap()
        this.schedule()
      } catch (error) { this.o.onError(error) }
    })
    this.cleanup.push(() => resize.dispose())
    // The cap depends on the pixel ratio, which zoom and moving between displays change.
    // A popout on another display has its own ratio: the watch moves with the grid's window.
    let media: MediaQueryList | undefined
    const watchRatio = () => {
      media?.removeEventListener('change', onRatio)
      const view = windowOf(this.root)
      media = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`)
      media.addEventListener('change', onRatio, { once: true })
    }
    const onRatio = () => { if (this.disposed) return; this.updateCap(); watchRatio() }
    watchRatio()
    const adoption = windows.onDidAdopt(() => { if (!this.disposed) { this.updateCap(); watchRatio() } })
    this.cleanup.push(() => { media?.removeEventListener('change', onRatio); adoption.dispose() })
    const fonts = this.root.ownerDocument.fonts
    const onFonts = () => { if (this.disposed) return; this.charWidth = fontMeasure(true).charWidth; this.schedule() }
    fonts?.addEventListener('loadingdone', onFonts)
    this.cleanup.push(() => fonts?.removeEventListener('loadingdone', onFonts))
  }

  private readonly onWheel = (event: WheelEvent): void => {
    try {
      const model = this.model
      // Control+wheel (and a trackpad pinch) zooms the window, as Chromium does elsewhere.
      if (!model || model.mode !== 'virtual' || this.gestures.matches('global.wheelZoom', event)) return
      const dy = normalizeWheel(event.deltaY, event.deltaMode, this.viewportHeight)
      const step = applyWheel(model, this.pendingTop ?? this.offsets.virtualTop, dy)
      if (!step.handled) return
      event.preventDefault()
      this.pendingTop = step.virtualTop
      if (event.deltaX) this.pendingLeft = (this.pendingLeft ?? this.offsets.scrollLeft) + normalizeWheel(event.deltaX, event.deltaMode, this.viewportWidth)
      this.schedule()
    } catch (error) { this.o.onError(error) }
  }

  /** A point relative to the scroller's client box; not inside over its scroll bars. */
  private point(event: MouseEvent): { x: number; y: number; inside: boolean } {
    const box = this.scroller.getBoundingClientRect()
    const x = event.clientX - box.left, y = event.clientY - box.top
    return { x, y, inside: x >= 0 && y >= 0 && x < this.viewportWidth && y < this.viewportHeight && !this.overOverlayScrollBar(event, x, y) }
  }
  /**
   * Overlay scroll bars (macOS) take no room, so they lie over the cells, and a press on one targets the scroller itself
   * (a cell, row or header is the target anywhere else over the data). Classic bars sit outside the client box.
   */
  private overOverlayScrollBar(event: MouseEvent, x: number, y: number): boolean {
    const scroller = this.scroller
    if (event.target !== scroller) return false
    return (scroller.offsetWidth === scroller.clientWidth && scroller.scrollHeight > scroller.clientHeight && x >= this.viewportWidth - g.overlayScrollBar)
      || (scroller.offsetHeight === scroller.clientHeight && scroller.scrollWidth > scroller.clientWidth && y >= this.viewportHeight - g.overlayScrollBar)
  }
  private hitAt(x: number, y: number, clamp = false) {
    return hitTest(x, y, { viewport: { top: this.offsets.virtualTop, left: this.offsets.scrollLeft, width: this.viewportWidth, height: this.viewportHeight }, rows: this.drawnRows(), layout: this.layout, rowHeader: this.rowHeader, clamp, frozenResize: this.rotated })
  }

  /** Native scrolling (including a cell's scrollIntoView) can precede its scroll event and our next frame. A press must
   *  use the offsets and size now on screen, or it can select a neighbouring link and open the wrong value. */
  private syncPointerFrame(): void {
    const width = this.scroller.clientWidth, height = this.scroller.clientHeight
    const top = this.scroller.scrollTop, left = this.scroller.scrollLeft
    const scrolled = top !== this.lastTop || left !== this.lastLeft
    if (!scrolled && width === this.viewportWidth && height === this.viewportHeight) return
    this.viewportWidth = width
    this.viewportHeight = height
    // Even a native scroll back to 0 is real here: its queued scroll event has not marked it yet. Offsets at 0 after the
    // panes changed are the move's reset instead, which the frame restores (offsetsDropped).
    this.scrolled ||= scrolled && !(this.moved && top === 0 && left === 0)
    this.cancelFrame?.()
    this.cancelFrame = undefined
    this.runFrame()
  }

  /** Presses inside the cells keep focus on the grid itself, not its scroller, and select no text. */
  private mouseDown(event: MouseEvent): void {
    this.clicks = event.detail
    if (!this.point(event).inside) return
    event.preventDefault()
    this.root.focus({ preventScroll: true })
  }

  private pointerDown(event: PointerEvent): void {
    const press = pressButton(event, this.o.platform)
    if (!press) return
    this.syncPointerFrame()
    const point = this.point(event)
    let hit = point.inside ? this.hitAt(point.x, point.y) : undefined
    // A column's border stays a resize grip over the header buttons drawn at its right end.
    const onButton = press === 'primary' && hit?.kind !== 'resize'
    // A press on a header's funnel opens its popover; it selects nothing and starts no drag.
    const funnel = onButton && this.o.onFilter ? (event.target as Element | null)?.closest?.('.rg-cf') : null
    const filterColumn = funnel ? this.buttonColumn(funnel) : -1
    if (funnel && !this.canFilter(filterColumn)) { event.preventDefault(); return }
    if (filterColumn >= 0) {
      event.preventDefault()
      this.o.onFilter!(filterColumn, funnel!.getBoundingClientRect())
      return
    }
    // A press on a header's sort button sorts; it selects nothing and starts no drag.
    const button = onButton && this.o.onSort ? (event.target as Element | null)?.closest?.('.rg-cs') : null
    const column = button ? this.buttonColumn(button) : -1
    if (column >= 0) {
      event.preventDefault()
      this.o.onSort!(column, this.gestures.matches('grid.addSortKey', event))
      return
    }
    if (!hit) return
    if (hit.kind === 'resize') {
      if (press === 'primary') { this.startResize(event.pointerId, point.x, hit.column); return }
      // A right-press on a border is a press on its column, which the menu then acts on (on the corner, for the name column's).
      hit = hit.column === frozenColumn ? { kind: 'corner' } : { kind: 'column', column: hit.column }
    }
    const add = press === 'primary' && this.gestures.matches('grid.addToSelection', event), shift = this.gestures.matches('grid.extendSelection', event)
    this.select(pressSelection(this.selection(), hit, { entry: this.o.entry, shift, right: press === 'secondary', add, rows: this.drawnRows(), columns: this.drawnColumns() }))
    if (press !== 'primary' || hit.kind === 'corner') return
    this.drag = { pointerId: event.pointerId, x0: point.x, y0: point.y, x: point.x, y: point.y, dragging: false, hit, modifiers: shift || add }
    try { this.root.setPointerCapture(event.pointerId) } catch { /* A synthetic pointer has nothing to capture. */ }
  }

  private pointerMove(event: PointerEvent): void {
    const resize = this.resizing
    if (resize) {
      if (event.pointerId !== resize.pointerId) return
      resize.x = this.point(event).x
      this.schedule()
      return
    }
    const drag = this.drag
    if (!drag) { this.hoverBorder(event); return }
    if (event.pointerId !== drag.pointerId) return
    const point = this.point(event)
    drag.x = point.x
    drag.y = point.y
    if (!drag.dragging && Math.hypot(point.x - drag.x0, point.y - drag.y0) >= g.dragThreshold) drag.dragging = true
    if (drag.dragging) this.schedule()
  }

  private pointerUp(event: PointerEvent): void {
    if (this.resizing) { if (event.pointerId === this.resizing.pointerId) this.endResize(false); return }
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    this.endDrag()
    // A link opens on a single click: the second press of a double-click lands before the first one's tab has opened.
    if (drag.dragging || drag.modifiers || drag.hit.kind !== 'cell' || this.clicks > 1) return
    const row = this.rotated ? drag.hit.column : drag.hit.row, column = this.rotated ? drag.hit.row : drag.hit.column
    if (this.links[column]) this.o.onOpenValue?.(row, column)
  }

  private endDrag(): void {
    const drag = this.drag
    this.drag = undefined
    if (drag && this.root.hasPointerCapture?.(drag.pointerId)) { try { this.root.releasePointerCapture(drag.pointerId) } catch { /* Already released. */ } }
  }

  /** The column-resize cursor over a header's border. Only header moves read the layout, so moving over cells costs nothing. */
  private hoverBorder(event: PointerEvent): void {
    let over = false
    if ((event.target as Element | null)?.closest?.('.rg-head')) {
      const point = this.point(event)
      over = point.inside && point.y < g.headerHeight && this.hitAt(point.x, point.y)?.kind === 'resize'
    }
    if (over === this.resizeHover) return
    this.resizeHover = over
    this.root.classList.toggle('rg-border-hover', over)
  }

  /** The column a pressed sort button or funnel is for: that of the header it is in, or in a transposed grid the one its
   *  name cell names. */
  private buttonColumn(button: Element): number {
    const slot = this.slots.get(button.parentElement!)
    return this.rotated ? slot?.row?.row ?? -1 : slot?.header?.column ?? -1
  }

  /** A press on a header's right border: the column follows the pointer (a new resize stops a running fit). */
  private startResize(pointerId: number, x: number, column: number): void {
    this.fitting?.abort()
    this.fitting = undefined
    if (this.rotated) {
      // The name column's width is the state's once dragged; a drawn column's own width is one of the layout's overrides.
      const kept = this.o.state.transposed!
      // The name column is dragged from the width it is drawn at, which a narrow pane may hold under the saved one.
      this.nameWidthBefore = kept.nameWidth
      this.resizing = column === frozenColumn ? { pointerId, column, x0: x, width0: this.rowHeader, wasUserSized: kept.nameWidth !== undefined, x, applied: x }
        : { pointerId, column, x0: x, width0: this.layout.width(column), wasUserSized: true, x, applied: x }
    } else {
      const userSized = this.o.state.userSized ??= new Set()
      this.resizing = { pointerId, column, x0: x, width0: this.layout.width(column), wasUserSized: userSized.has(column), x, applied: x }
      userSized.add(column)
    }
    this.root.classList.add('rg-resizing')
    try { this.root.setPointerCapture(pointerId) } catch { /* A synthetic pointer has nothing to capture. */ }
  }
  /** Ends a resize; `restore` (Escape) puts the width back. A press that moved nothing does not count as sizing. */
  private endResize(restore: boolean): void {
    const resize = this.resizing
    if (!resize) return
    this.resizing = undefined
    this.root.classList.remove('rg-resizing')
    if (resize.column === frozenColumn) {
      // Escape puts back what was saved before the drag: the user's width, or none, and the names are fitted again.
      if (restore) {
        const kept = this.o.state.transposed!
        if (this.nameWidthBefore === undefined) { delete kept.nameWidth; this.nameWidth = this.fittedNameWidth(g.nameColumnMaxWidth) }
        else { kept.nameWidth = this.nameWidthBefore; this.nameWidth = this.boundedNameWidth(this.nameWidthBefore) }
      }
    } else {
      if (restore) this.layout.setWidth(resize.column, resize.width0)
      if (!this.rotated && !resize.wasUserSized && this.layout.width(resize.column) === resize.width0) this.o.state.userSized?.delete(resize.column)
    }
    if (this.root.hasPointerCapture?.(resize.pointerId)) { try { this.root.releasePointerCapture(resize.pointerId) } catch { /* Already released. */ } }
    this.schedule()
  }
  /** Once a frame while resizing: the dragged border's column takes the pointer's offset, within [32, 3,000]. */
  private resizeStep(): void {
    const resize = this.resizing
    if (!resize || resize.x === resize.applied) return
    resize.applied = resize.x
    if (resize.column === frozenColumn) this.setNameWidth(resize.width0 + resize.x - resize.x0)
    else this.layout.setWidth(resize.column, resize.width0 + resize.x - resize.x0)
  }
  /** A transposed grid's name column takes a width of the user's (a drag, a fit), kept in the state; the frame lays it out. */
  private setNameWidth(width: number): void {
    this.nameWidth = this.o.state.transposed!.nameWidth = this.boundedNameWidth(width)
  }
  /** A width for the name column: at least its minimum, and never so wide that no drawn column shows beside it. */
  private boundedNameWidth(width: number): number {
    const most = this.viewportWidth > 0 ? Math.max(g.nameColumnMinWidth, this.viewportWidth - g.columnMinWidth) : g.columnMaxWidth
    return Math.max(g.nameColumnMinWidth, Math.min(Math.round(Number.isFinite(width) ? width : g.nameColumnMinWidth), g.columnMaxWidth, most))
  }
  /** A header column the grid can read: one of its shown columns, or none. */
  private validHeaderColumn(column: number | null | undefined): number | undefined {
    return typeof column === 'number' && Number.isInteger(column) && column >= 0 && column < this.columns ? column : undefined
  }
  /** What the name column needs for its widest name (and type) and the two buttons, up to `most`. */
  private fittedNameWidth(most: number): number {
    let widest = 0
    for (let column = 0; column < this.columns; column++) widest = Math.max(widest, this.headerTextWidth(column))
    const buttons = (this.o.onSort ? g.sortButtonWidth : 0) + (this.o.onFilter ? g.funnelWidth : 0)
    return Math.min(most, Math.max(g.nameColumnMinWidth, Math.ceil(widest) + g.cellChrome + buttons))
  }

  /** A double-click on a header's border fits its column. */
  private doubleClick(event: MouseEvent): void {
    if (event.button !== 0) return
    const point = this.point(event)
    if (!point.inside || point.y >= g.headerHeight) return
    const hit = this.hitAt(point.x, point.y)
    if (hit?.kind !== 'resize' || !this.gestures.matches('grid.fitColumn', event)) return
    // Transposed, the corner's border fits the name column to its names, and a header's its drawn column, which is a row.
    if (hit.column === frozenColumn) this.fitNames()
    else if (this.rotated) this.fitRow(hit.column)
    else this.fitColumn(hit.column)
  }
  /**
   * Fits a column to its header and the widest display text of its first 4,096 rows and the rows in view, measured by
   * the worker; a resize or another fit started meanwhile wins.
   */
  fitColumn(column: number): void {
    // Transposed, a column is a drawn row, and rows have one height: Fit there is of a drawn column (fitRow).
    if (this.rotated || this.disposed || !Number.isInteger(column) || column < 0 || column >= this.columns) return
    this.fitting?.abort()
    const abort = this.fitting = new AbortController()
    const rows = this.rows(), top = Math.min(g.measureFitRows, rows), range = this.lastRange
    const measures = top > 0 ? [this.handle.measure(0, top, column, column + 1, abort.signal)] : []
    if (range && range.lastRow >= top) {
      const first = Math.max(top, range.firstRow)
      measures.push(this.handle.measure(first, range.lastRow - first + 1, column, column + 1, abort.signal))
    }
    const done = () => { if (this.fitting === abort) this.fitting = undefined }
    Promise.all(measures).then(results => {
      if (abort.signal.aborted || this.disposed) return
      done()
      let chars = 0
      for (const result of results) chars = Math.max(chars, result.widths[0] ?? 0)
      const userSized = this.o.state.userSized ??= new Set()
      userSized.add(column)
      this.layout.setWidth(column, fitWidth(this.headerTextWidth(column), chars, this.charWidth))
      this.schedule()
    }, error => {
      if (abort.signal.aborted || this.disposed) return
      done()
      // A full results port has room again shortly; a released or lost result is shown as such by its shell.
      if (portBusy(error)) setTimeout(() => { if (!this.disposed && !abort.signal.aborted && !this.fitting) this.fitColumn(column) }, g.busyRetryMs)
    })
  }

  /** Transposed: fits the name column to its names, past the width it takes on its own (the corner border's double-click,
   *  Fit Column on a name). Nothing in a table. */
  fitNames(): void {
    if (!this.rotated || this.disposed) return
    this.setNameWidth(this.fittedNameWidth(g.columnMaxWidth))
    this.schedule()
  }

  /**
   * Transposed: fits the drawn column that shows `row` to its header and that row's widest value, with one measure of a
   * single row across the columns. It becomes one of the layout's own widths. Nothing in a table, whose rows have one height.
   */
  fitRow(row: number): void {
    if (!this.rotated || this.disposed || !Number.isInteger(row) || row < 0 || row >= this.drawnColumns()) return
    this.fitting?.abort()
    const abort = this.fitting = new AbortController()
    const done = () => { if (this.fitting === abort) this.fitting = undefined }
    this.handle.measure(row, 1, 0, this.columns, abort.signal).then(({ widths }) => {
      if (abort.signal.aborted || this.disposed) return
      done()
      let chars = 0
      for (let index = 0; index < widths.length; index++) chars = Math.max(chars, widths[index])
      this.layout.setWidth(row, fitWidth(this.headerWidth(this.headerLabel(row, undefined)), chars, this.charWidth))
      this.schedule()
    }, error => {
      if (abort.signal.aborted || this.disposed) return
      done()
      if (portBusy(error)) setTimeout(() => { if (!this.disposed && !abort.signal.aborted && !this.fitting) this.fitRow(row) }, g.busyRetryMs)
    })
  }

  /** At most once a frame while dragging: extends the selection, and scrolls when the pointer is past the cells. */
  private dragStep(): void {
    const drag = this.drag
    if (!drag?.dragging) return
    const hit = this.hitAt(drag.x, drag.y, true)
    const selection = this.selection()
    if (hit && hit.kind !== 'resize' && selection) {
      const next = dragSelection(selection, hit)
      if (next !== selection) this.select(next)
    }
    const above = g.headerHeight - drag.y, below = drag.y - this.viewportHeight, before = this.rowHeader - drag.x, after = drag.x - this.viewportWidth
    let scrolled = false
    if (above > 0 || below > 0) {
      const rows = Math.min(40, 1 + Math.floor(Math.max(above, below) / 16)) * (above > 0 ? -1 : 1)
      this.pendingTop = Math.max(0, (this.pendingTop ?? this.offsets.virtualTop) + rows * g.rowHeight)
      scrolled = true
    }
    if (before > 0 || after > 0) {
      const px = Math.min(240, 16 + 2 * Math.max(before, after)) * (before > 0 ? -1 : 1)
      this.pendingLeft = Math.max(0, (this.pendingLeft ?? this.offsets.scrollLeft) + px)
      scrolled = true
    }
    if (scrolled) this.schedule()
  }

  /** Tooltips only on the hovered header, or a hovered truncated, failed or link cell (B8); transposed, on the hovered name
   *  cell (what a header says of its column) and on a drawn column's header (its row), unless that shows its row-size bar,
   *  whose own tooltip stays. */
  private hover(target: EventTarget | null): void {
    let element = (target as Element | null)?.closest?.(this.rotated ? '.rg-ch, .rg-c, .rg-rn' : '.rg-ch, .rg-c') as HTMLElement | null
    let slot = element ? this.slots.get(element) : undefined
    if (this.rotated && slot?.header?.size) { element = null; slot = undefined }
    if (element === this.hovered) return
    if (this.hovered) this.hovered.removeAttribute('title')
    this.hovered = element ?? undefined
    if (!element) return
    let title = ''
    if (slot?.header && slot.header.column >= 0) title = this.rotated ? this.rowTitle(slot.header.column, slot.header.label) : this.headerTitle(slot.header.column)
    else if (slot?.cell) {
      const bits = slot.cell.bits
      if (bits & ERR) title = 'This value could not be read and is shown as NULL.'
      else if (bits & TRUNC) title = `This value was truncated at ${this.truncationLimit(this.rotated ? Math.max(0, slot.row?.row ?? 0) : slot.cell.column)}.`
      else if (bits & LINK) title = 'Open in a new tab (Enter)'
    } else if (this.rotated && slot?.row && slot.row.row >= 0) title = this.headerTitle(slot.row.row)
    if (title) element.title = title
  }
  /** A column's tooltip: its whole name, its type and whether it takes NULL. */
  private headerTitle(column: number): string {
    const info = this.descriptor.columns[column]
    return `${columnTitle(info.name)} (${this.types[column]}, ${info.nullable ? 'null' : 'not null'})`
  }
  /** A transposed header's tooltip: the row it stands for, and the header column's value when that is what it shows. */
  private rowTitle(row: number, label: string): string {
    const name = 'Row ' + formatCount(row + 1)
    return label && label !== name ? `${name}: ${label}` : name
  }
  private truncationLimit(column: number): string {
    const info = this.descriptor.columns[column]
    return truncatedAt[info.wire === 'binary' ? 'binary' : info.role === 'xml' || info.role === 'json' || info.role === 'plan' ? 'document' : 'text']
  }

  private createRow(withCells = true): RowSlot {
    const doc = this.scroller.ownerDocument
    const el = doc.createElement('div'), header = doc.createElement('div'), number = doc.createTextNode('')
    el.className = 'rg-row'
    el.setAttribute('role', 'row')
    el.style.display = 'none'
    header.className = 'rg-rh'
    header.setAttribute('role', 'rowheader')
    header.setAttribute('aria-colindex', '1')
    header.append(number)
    el.append(header)
    let mark: RowSlot['mark']
    if (withCells) {
      mark = this.rotated ? this.nameMark() : { el: doc.createElement('div'), text: doc.createTextNode(''), size: '' }
      mark.el.className = 'rg-rn'
      mark.el.style.display = 'none'
      if (!this.rotated) mark.el.append(mark.text)
      this.marksRows.append(mark.el)
    }
    const slot: RowSlot = { el, header, number, ...mark ? { mark } : {}, cells: [], pin: this.createCell(el), row: -1, top: Number.NaN, width: -1, odd: false, headerSel: false, shown: false, tone: 0, highlight: 0, toneText: '', toneOf: 0, cellMarks: undefined }
    this.slots.set(el, { row: slot })
    // The active cell's spare slot and the row's number (a transposed grid's name cell) name their row too, for menu
    // targets and a name cell's buttons.
    this.slots.set(slot.pin.el, { cell: slot.pin, row: slot })
    if (mark) this.slots.set(mark.el, { row: slot })
    this.rowsEl.append(el)
    if (withCells) for (let index = 0; index < this.cellsPerRow; index++) slot.cells.push(this.createCell(el, slot))
    return slot
  }
  /** A transposed row's mark: its column's name and type, with the sort button and funnel a column header has. */
  private nameMark(): NonNullable<RowSlot['mark']> {
    const doc = this.scroller.ownerDocument
    const el = doc.createElement('div'), nameEl = doc.createElement('span'), text = doc.createTextNode(''), typeEl = doc.createElement('span'), type = doc.createTextNode('')
    nameEl.className = 'rg-cn'
    nameEl.append(text)
    typeEl.className = 'rg-ct'
    typeEl.append(type)
    el.append(nameEl, typeEl)
    const sort = this.o.onSort ? this.sortButton(el) : undefined, funnel = this.o.onFilter ? this.funnelButton(el) : undefined
    return { el, text, size: '', type, ...sort ? { sort } : {}, ...funnel ? { funnel } : {}, look: '' }
  }
  /** A sort button at the end of `parent` (a header, a name cell). Hidden from screen readers: aria-sort says how the
   *  column is sorted, and the menu's Sort commands sort it. */
  private sortButton(parent: HTMLElement): SortButton {
    const doc = parent.ownerDocument, button = doc.createElement('span'), glyph = doc.createElement('span'), orderEl = doc.createElement('span'), order = doc.createTextNode('')
    button.className = 'rg-cs'
    button.setAttribute('aria-hidden', 'true')
    glyph.className = codiconClass('arrow-up')
    orderEl.className = 'rg-co'
    orderEl.append(order)
    button.append(glyph, orderEl)
    button.title = 'Sort ascending'
    parent.append(button)
    return { el: button, glyph, order, state: '' }
  }
  /** A funnel at the end of `parent`. Hidden from screen readers like the sort button: Filter Column Values (Alt+Down)
   *  opens the same popover. */
  private funnelButton(parent: HTMLElement): FunnelButton {
    const doc = parent.ownerDocument, button = doc.createElement('span'), glyph = doc.createElement('span')
    button.className = 'rg-cf'
    button.setAttribute('aria-hidden', 'true')
    button.title = 'Filter column values'
    glyph.className = codiconClass('filter')
    button.append(glyph)
    parent.append(button)
    return { el: button, glyph, on: false }
  }
  private createCell(parent: HTMLElement, row?: RowSlot): CellSlot {
    const el = parent.ownerDocument.createElement('div'), text = parent.ownerDocument.createTextNode('')
    el.className = classes[0]
    el.setAttribute('role', 'gridcell')
    el.setAttribute('aria-selected', 'false')
    el.style.display = 'none'
    el.append(text)
    parent.append(el)
    const cell: CellSlot = { el, text, column: -1, bits: 0, value: '', mode: 'none', marked: false, label: '', shown: false, left: Number.NaN, width: -1 }
    this.slots.set(el, { cell, ...row ? { row } : {} })
    return cell
  }

  /** Grows the pools to cover the frame; shrinks them only when more than 25 % too large. */
  private pools(rowSlots: number, cellsPerRow: number): boolean {
    let changed = false
    if (cellsPerRow > this.cellsPerRow || cellsPerRow < this.cellsPerRow * (1 - g.poolSlack)) {
      for (const slot of this.rowSlots) {
        while (slot.cells.length < cellsPerRow) slot.cells.push(this.createCell(slot.el, slot))
        while (slot.cells.length > cellsPerRow) slot.cells.pop()!.el.remove()
        for (const cell of slot.cells) cell.column = -1
      }
      this.cellsPerRow = cellsPerRow
      changed = true
    }
    if (rowSlots > this.rowSlots.length || rowSlots < this.rowSlots.length * (1 - g.poolSlack)) {
      while (this.rowSlots.length < rowSlots) this.rowSlots.push(this.createRow())
      while (this.rowSlots.length > rowSlots) { const slot = this.rowSlots.pop()!; slot.el.remove(); slot.mark?.el.remove() }
      for (const slot of this.rowSlots) slot.row = -1
      // The ring starts again in slot order.
      this.ring = undefined
      this.rowsEl.prepend(this.pinSlot.el)
      this.pinFirst = true
      this.rowsEl.append(...this.rowSlots.map(slot => slot.el))
      changed = true
    }
    const headers = cellsPerRow
    if (headers > this.headerSlots.length || headers < this.headerSlots.length * (1 - g.poolSlack)) {
      while (this.headerSlots.length < headers) {
        const doc = this.head.ownerDocument, el = doc.createElement('div'), nameEl = doc.createElement('span'), text = doc.createTextNode(''), typeEl = doc.createElement('span'), type = doc.createTextNode('')
        el.className = 'rg-ch'
        el.setAttribute('role', 'columnheader')
        el.style.display = 'none'
        nameEl.className = 'rg-cn'
        nameEl.append(text)
        typeEl.className = 'rg-ct'
        typeEl.setAttribute('aria-hidden', 'true')
        typeEl.append(type)
        el.append(nameEl, typeEl)
        // A transposed grid's headers stand for rows, and there is nothing to sort or filter a row by: the buttons are in
        // its name cells.
        const sort = this.o.onSort && !this.rotated ? this.sortButton(el) : undefined
        const funnel = this.o.onFilter && !this.rotated ? this.funnelButton(el) : undefined
        if (funnel) el.classList.add('fb')
        this.head.append(el)
        const header: HeaderSlot = { el, text, type, column: -1, sel: false, mark: 0, shown: false, left: Number.NaN, width: -1, label: '', highlight: 0, size: '', ...sort ? { sort } : {}, ...funnel ? { funnel } : {} }
        this.slots.set(el, { header })
        this.headerSlots.push(header)
      }
      while (this.headerSlots.length > headers) this.headerSlots.pop()!.el.remove()
      for (const header of this.headerSlots) header.column = -1
      changed = true
    }
    return changed
  }

  /** The first frame after rows arrive sizes the columns the user has not sized from their first 128 rows. */
  private measureColumns(rows: number): void {
    const state = this.o.state
    if (this.rotated) { this.measureShared(rows); return }
    if (state.sized || this.measuring || rows <= 0 || this.columns === 0 || performance.now() < this.measureAfter) return
    this.measuring = true
    this.handle.measure(0, Math.min(g.measureInitialRows, rows), 0, this.columns).then(({ widths }) => {
      this.measuring = false
      if (this.disposed || state.sized) return
      for (let column = 0; column < this.columns; column++) {
        if (state.userSized?.has(column)) continue
        this.layout.setWidth(column, initialWidth(this.headerTextWidth(column), widths[column] ?? 0, this.charWidth))
      }
      state.sized = true
      this.schedule()
    }, error => {
      this.measuring = false
      if (this.disposed) return
      // A full results port has room again shortly.
      if (portBusy(error)) { this.measureAfter = performance.now() + g.busyRetryMs; setTimeout(() => this.schedule(), g.busyRetryMs); return }
      // The type hints stay; a released or lost result is shown as such by its shell.
      state.sized = true
      if ((error as Error)?.name !== 'AbortError') this.schedule()
    })
  }

  /** Transposed: the first frame after rows arrive sets the shared width from the widest value of their first 128 rows. */
  private measureShared(rows: number): void {
    const kept = this.o.state.transposed!
    if (kept.sized || this.measuring || rows <= 0 || this.columns === 0 || performance.now() < this.measureAfter) return
    this.measuring = true
    this.handle.measure(0, Math.min(g.measureInitialRows, rows), 0, this.columns).then(({ widths }) => {
      this.measuring = false
      if (this.disposed || kept.sized) return
      let chars = 0
      for (let index = 0; index < widths.length; index++) chars = Math.max(chars, widths[index])
      this.uniform!.setShared(this.sharedWidth(chars))
      kept.sized = true
      this.schedule()
    }, error => {
      this.measuring = false
      if (this.disposed) return
      if (portBusy(error)) { this.measureAfter = performance.now() + g.busyRetryMs; setTimeout(() => this.schedule(), g.busyRetryMs); return }
      kept.sized = true
      if ((error as Error)?.name !== 'AbortError') this.schedule()
    })
  }
  /** The shared width for values of `chars` characters: a header's ("Row 4,095") at least, and no wider than 240 px, since
   *  a drawn column holds a value of every column and the widest would size them all. */
  private sharedWidth(chars: number): number { return Math.min(g.transposedMaxWidth, initialWidth(this.headerWidth('Row ' + formatCount(wire.transpose.maxRows)), chars, this.charWidth)) }
  /** A transposed column's header: "Row N", or with a header column that column's value for the row, as a pivot names a
   *  column group (NULL, (blank), cut at 128 characters), once the tile that holds it has been read. `tile` is the frame's
   *  lookup; without it the cache is asked. */
  private headerLabel(row: number, tile: ((row: number, column: number) => RowWindow | null) | undefined): string {
    const fallback = 'Row ' + formatCount(row + 1), at = this.headerColumn
    if (at === undefined || at < 0 || at >= this.columns) return fallback
    const window = tile ? tile(row, at) : this.data.peek(tileKey(Math.floor(row / this.tiles.rows), Math.floor(at / this.tiles.columns)))
    if (!window || row - window.first >= window.count) return fallback
    const index = (row - window.first) * (window.colEnd - window.colStart) + at - window.colStart
    if (window.flags[index] & (FLAG_NULL | FLAG_ERROR)) return 'NULL'
    const text = displayText(window.text[index])
    return text === '' ? '(blank)' : text.length > g.headerValueChars ? text.slice(0, g.headerValueChars) : text
  }

  /** What a menu opened on `element` is for, in the result's rows and columns whatever the orientation (anchor.ts): a
   *  cell's row and column, a header's column, a row number's row (transposed: a header's row, a name cell's column);
   *  undefined on the corner and on a slot that shows nothing. A pending frame is painted first: until it runs, a slot
   *  marked to be written again (an update sets a shown header's column to -1) would read as showing nothing. */
  private targetOf(element: Element): GridTarget | undefined {
    this.flushFrame()
    for (let at: Element | null = element; at && at !== this.root; at = at.parentElement) {
      const slot = this.slots.get(at)
      if (!slot) continue
      if (slot.header) return slot.header.column < 0 ? undefined : this.rotated ? { row: slot.header.column } : { column: slot.header.column }
      const row = slot.row && slot.row.row >= 0 ? slot.row.row : undefined
      if (slot.cell) return row === undefined || slot.cell.column < 0 ? undefined : this.rotated ? { row: slot.cell.column, column: row } : { row, column: slot.cell.column }
      return row === undefined ? undefined : this.rotated ? { column: row } : { row }
    }
    return undefined
  }

  private render(): void {
    // A horizontal scroll bar that appears as columns widen shrinks the client box without resizing the scroller, and
    // ResizeObserver does not report it: a stale height hid the last row under the bar and undid scrolling to it. Read
    // in the frame's read phase, with the offsets below.
    this.viewportWidth = this.scroller.clientWidth
    this.viewportHeight = this.scroller.clientHeight
    const width = this.viewportWidth, height = this.viewportHeight
    // A hidden pane (Ctrl+R) or a background tab has no size: nothing to paint until it is shown.
    if (width <= 0 || height <= 0) return
    const state = this.o.state, snapshot = this.handle.getSnapshot()
    const rows = snapshot.rowsAvailable
    // What is drawn: the rows and columns themselves, or turned. A transposed grid's columns grow as rows arrive.
    const drawnRows = this.drawnRows(rows), drawnColumns = this.drawnColumns(rows)
    if (this.uniform && this.uniform.count !== drawnColumns) this.uniform.setCount(drawnColumns)
    // Reads first: the scroller's offsets.
    const scrollTop = this.scroller.scrollTop, scrollLeft = this.scroller.scrollLeft
    const previous = this.model
    // A scroller that lost its offsets shows the saved ones again, as a grid built afresh does.
    const restore = !previous || offsetsDropped({ scrolled: this.scrolled, scrollTop, scrollLeft, lastTop: this.lastTop, lastLeft: this.lastLeft })
    this.scrolled = false
    this.moved = false
    const model = scrollModel(drawnRows, height, this.cap)
    let virtualTop: number
    if (this.pendingTop !== undefined) virtualTop = this.pendingTop
    // Follow tail: a log opens at its newest rows, and a view at the end as rows arrive stays at the end.
    else if (this.o.followTail && this.atEnd && (!previous || rows !== previous.rows)) virtualTop = Number.MAX_SAFE_INTEGER
    else if (restore) virtualTop = this.offsets.virtualTop
    else virtualTop = onNativeScroll(previous, scrollTop, this.offsets.virtualTop, this.written)
    const mapped = remap(model, virtualTop)
    virtualTop = mapped.virtualTop
    this.pendingTop = undefined
    this.measureColumns(rows)

    // Then writes: sizes, scroll offsets, the row container.
    this.resizeStep()
    // A name column sized in a wider pane still leaves a drawn column in view in this one; the saved width is kept.
    const rowHeader = this.rotated ? Math.min(this.nameWidth, Math.max(g.nameColumnMinWidth, width - g.columnMinWidth)) : rowHeaderWidth(rows, this.charWidth)
    let columnsMoved = false
    if (rowHeader !== this.rowHeader) {
      this.rowHeader = rowHeader
      this.root.style.setProperty('--rg-rhw', rowHeader + 'px')
      this.layout.setMaxTotal(this.cap - rowHeader)
      columnsMoved = true
    }
    const total = rowHeader + this.layout.total
    if (total !== this.width) {
      this.width = total
      this.spacer.style.width = total + 'px'
      this.head.style.width = total + 'px'
      columnsMoved = true
    }
    const wide = total > this.outerWidth
    if (wide !== this.wide && this.outerWidth > 0) { this.wide = wide; this.o.onWide?.(wide) }
    if (model.spacerHeight !== this.spacerHeight) { this.spacerHeight = model.spacerHeight; this.spacer.style.height = model.spacerHeight + 'px' }
    if ((model.mode === 'virtual') !== this.wheelAttached) {
      this.wheelAttached = model.mode === 'virtual'
      if (this.wheelAttached) this.scroller.addEventListener('wheel', this.onWheel, { passive: false })
      else this.scroller.removeEventListener('wheel', this.onWheel)
    }
    let top = scrollTop
    if (Math.abs(mapped.scrollTop - scrollTop) >= 1 || (restore && mapped.scrollTop !== scrollTop)) {
      this.scroller.scrollTop = mapped.scrollTop
      top = mapped.scrollTop
    }
    this.written = model.mode === 'virtual' ? top : undefined
    const maxLeft = Math.max(0, total - width)
    const left = Math.min(maxLeft, Math.max(0, this.pendingLeft ?? (restore ? this.offsets.scrollLeft : scrollLeft)))
    this.pendingLeft = undefined
    if (Math.abs(left - scrollLeft) >= 1) this.scroller.scrollLeft = left
    this.lastTop = top
    this.lastLeft = left
    this.model = model
    const offsets = this.offsets
    offsets.virtualTop = virtualTop
    offsets.topRow = topRowOf(virtualTop)
    offsets.scrollLeft = left
    const baseRow = model.mode === 'virtual' ? rebaseRow(offsets.topRow) : 0
    const rebased = baseRow !== this.baseRow
    this.baseRow = baseRow
    const containerY = rowsContainerY(model, top, virtualTop, baseRow)
    if (containerY !== this.containerY) {
      this.containerY = containerY
      this.rowsEl.style.transform = this.marksRows.style.transform = `translateY(${containerY}px)`
    }
    // SSMS's current cell: once rows arrive, the first cell is selected until another is chosen, so Copy, Shift+click
    // and the keys start from it and screen readers hear it. It is not announced as a selection change.
    if (drawnRows > 0 && drawnColumns > 0 && !this.sourceSelection()) state.selection = firstCell(this.o.entry)
    if (this.rotated) this.keepActiveDrawn()

    this.dragStep()
    const viewport = { top: virtualTop, left, width, height }
    const bodyRows = Math.ceil(Math.max(0, height - g.headerHeight) / g.rowHeight)
    let overscan: { rows: number; columns: number } = { rows: g.overscanRows, columns: g.overscanColumns }
    let range = visibleRange(viewport, drawnRows, this.layout, rowHeader, overscan)
    // A very large view of narrow columns (a 4K screen) keeps less in reserve: every pooled cell costs style, layout and
    // paint when a jump rewrites them all.
    if ((bodyRows + 1 + 2 * overscan.rows) * (range.lastColumn - range.firstColumn + 1) > g.poolCells) {
      overscan = { rows: g.reducedOverscanRows, columns: g.reducedOverscanColumns }
      range = visibleRange(viewport, drawnRows, this.layout, rowHeader, overscan)
    }
    // A transposed result with no rows has no column to draw, and still names its columns down the frozen one.
    if (this.rotated && drawnColumns === 0) range = { ...visibleRange(viewport, drawnRows, oneColumn, rowHeader, overscan), firstColumn: 0, lastColumn: -1 }
    this.lastRange = range
    // An empty result still shows its column headers.
    const headerRange = drawnRows > 0 ? range : visibleRange({ top: 0, left, width, height }, 1, this.layout, rowHeader, overscan)
    if (snapshot.state !== 'lost' && snapshot.state !== 'released') {
      // The reads are asked for in the result's rows and columns. Transposed, the rows run across, so a scroll too fast to
      // read is one across them.
      const view = this.sourceRange(range)
      const moved = this.rotated ? range.firstColumn - this.lastFirstColumn : offsets.topRow - this.lastTopRow
      const again = this.data.ensure(view, rows, moved, Math.max(1, this.rotated ? range.lastColumn - range.firstColumn + 1 : bodyRows), state.selection?.active)
      if (again) this.schedule()
      if (!this.rotated || view.lastRow >= view.firstRow) this.sizes?.ensure(view.firstRow, view.lastRow)
    }
    this.lastTopRow = offsets.topRow
    this.lastFirstColumn = range.firstColumn
    const tileError = this.data.error
    if (tileError !== this.status.tileError) this.setStatus({ ...this.status, tileError })
    const visibleColumns = headerRange.lastColumn - headerRange.firstColumn + 1
    if (this.pools(bodyRows + 1 + 2 * overscan.rows, Math.max(1, visibleColumns))) columnsMoved = true
    this.paint(range, headerRange, drawnRows, drawnColumns, rebased, columnsMoved)
    if (this.rotated) this.paintBands(headerRange, Math.max(0, Math.min(height - g.headerHeight, drawnRows * g.rowHeight - virtualTop)))
    this.aria(snapshot.state, rows)
    this.report(model, virtualTop, drawnRows, height)
  }

  /** Transposed: an active cell in a row past those drawn (the selection was made in the table, or a swap moved it) moves
   *  to the same column in the last row drawn, and the owner hears of it as of a swap's move. The blocks stay: they select
   *  what they did, and show again when a filter or the table brings their rows back. */
  private keepActiveDrawn(): void {
    const selection = this.sourceSelection(), last = wire.transpose.maxRows - 1
    if (!selection || selection.active.row <= last) return
    this.o.state.selection = { ...selection, active: { row: last, column: selection.active.column } }
    this.o.onSelection(this.o.state.selection)
  }

  /** Tells the shell what the frame showed, when that changed. */
  private report(model: ScrollModel, virtualTop: number, rows: number, height: number): void {
    this.atEnd = virtualTop >= model.maxVirtual - 0.5
    if (this.o.followTail) this.o.state.following = this.atEnd
    const firstRow = rows > 0 ? Math.min(topRowOf(virtualTop), rows - 1) : 0
    const lastRow = Math.max(0, Math.min(rows - 1, Math.ceil((virtualTop + Math.max(0, height - g.headerHeight)) / g.rowHeight) - 1))
    const last = this.viewport
    if (last && last.firstRow === firstRow && last.lastRow === lastRow && last.rows === rows && last.atEnd === this.atEnd) return
    this.viewport = { firstRow, lastRow, rows, atEnd: this.atEnd }
    this.o.onViewport?.(this.viewport)
  }

  /** `rows` and `columns`, the ranges, the selection and the active cell here are as drawn; `tile` and the marks take the
   *  result's own rows and columns (paintCell is where a cell's place becomes the result's). */
  private paint(range: VisibleRange, headerRange: VisibleRange, rows: number, columns: number, rebased: boolean, columnsMoved: boolean): void {
    const selection = this.selection()
    const window: CellRange = { top: range.firstRow, bottom: range.lastRow, left: range.firstColumn, right: range.lastColumn }
    const ranges = selection ? windowRanges(selection, rows, columns, window) : []
    const active = selection && rows > 0 && columns > 0 ? { row: Math.min(selection.active.row, rows - 1), column: Math.min(selection.active.column, columns - 1) } : undefined
    const tiles = new Map<number, RowWindow | null>()
    const shape = this.tiles
    const tile = (row: number, column: number): RowWindow | null => {
      const key = tileKey(Math.floor(row / shape.rows), Math.floor(column / shape.columns))
      let found = tiles.get(key)
      if (found === undefined) tiles.set(key, found = this.data.peek(key) ?? null)
      return found
    }
    const count = this.rowSlots.length
    const used = new Set<RowSlot>()
    let activeCell: CellSlot | undefined
    if (range.lastRow >= range.firstRow) this.orderRows(range.firstRow)
    const ring = this.ring
    if (ring) {
      for (let row = range.firstRow; row <= range.lastRow; row++) {
        const slot = this.rowSlots[slotOf(ring, row, count)]
        used.add(slot)
        const cell = this.paintRow(slot, row, range, ranges, active, tile, rebased, columnsMoved)
        if (cell) activeCell = cell
      }
    }
    for (const slot of this.rowSlots) if (!used.has(slot)) this.hideRow(slot)
    // The active row always has a slot, so aria-activedescendant resolves even when it is scrolled out of view; it sits
    // before or after the rows shown, as its row does.
    if (active && (active.row < range.firstRow || active.row > range.lastRow)) {
      const first = active.row < range.firstRow
      if (first !== this.pinFirst) {
        this.pinFirst = first
        if (first) this.rowsEl.prepend(this.pinSlot.el)
        else this.rowsEl.append(this.pinSlot.el)
      }
      const cell = this.paintRow(this.pinSlot, active.row, { ...range, firstColumn: active.column, lastColumn: active.column - 1 }, ranges, active, tile, rebased, columnsMoved)
      if (cell) activeCell = cell
    } else this.hideRow(this.pinSlot)
    this.paintHeaders(headerRange, ranges, columnsMoved, tile)
    const activeEl = activeCell?.el
    if (activeEl !== this.activeEl) {
      if (this.activeEl) { this.activeEl.removeAttribute('id'); this.activeEl.removeAttribute('aria-label') }
      this.activeEl = activeEl
      if (activeEl && active) {
        activeEl.id = `rg-${this.gid}-r${active.row}c${active.column}`
        this.root.setAttribute('aria-activedescendant', activeEl.id)
      } else this.root.removeAttribute('aria-activedescendant')
      if (activeCell) activeCell.label = ''
    } else if (activeEl && active && activeEl.id !== `rg-${this.gid}-r${active.row}c${active.column}`) {
      activeEl.id = `rg-${this.gid}-r${active.row}c${active.column}`
      this.root.setAttribute('aria-activedescendant', activeEl.id)
    }
    if (activeCell) {
      // A NULL and a value that could not be read both show NULL, as does the text 'NULL': the label tells them apart.
      const bits = activeCell.bits
      // A cell whose rows are still being read says so: an empty name reads as "blank", and the value that follows is a
      // name change some screen readers do not read for the active cell.
      const toned = active && !this.rotated ? this.activeTone(active.row) : undefined
      const diff = bits & CHG ? ', changed' : bits & SOFT ? ', differs only by collation' : ''
      const label = bits & LOAD ? 'Loading' : displayText(activeCell.value) + (bits & ERR ? ', could not be read' : bits & NULL ? ', null value' : '') + (bits & TRUNC ? ', truncated' : '') + (bits & LINK ? ', link, press Enter to open' : '') + (bits & HIT ? ', search match' : '') + diff + (toned ? ', ' + toned : '')
      if (label !== activeCell.label) { activeCell.label = label; activeCell.el.setAttribute('aria-label', label) }
    }
  }

  /** The tone label of the active row (the toneLabel option), from the slot that painted it. */
  private activeTone(row: number): string | undefined {
    const slot = this.pinSlot.shown && this.pinSlot.row === row ? this.pinSlot : this.rowSlots.find(item => item.shown && item.row === row)
    if (!slot || slot.tone === 0) return undefined
    const tone = rowTones[slot.tone - 1]
    return tone === 'added' || tone === 'removed' ? diffLabels[tone] : this.o.toneLabel?.(tone)
  }

  /**
   * Keeps the slots of the rows shown in row order in the DOM, as browse-mode screen readers read them (ring.ts). A row
   * moved in the DOM is styled and laid out again, so while the rows scroll only the ring moves; the DOM catches up in
   * the first frame after they stop.
   */
  private orderRows(firstRow: number): void {
    const count = this.rowSlots.length
    if (count === 0) return
    const moving = firstRow !== this.shownFirst
    this.shownFirst = firstRow
    if (!this.ring) { this.ring = freshRing(firstRow); this.domStart = this.ring.start; return }
    this.ring = ringStep(this.ring, firstRow, count).ring
    if (this.ring.start === this.domStart) return
    if (moving) { this.schedule(); return }
    const step = rotation(this.domStart, this.ring.start, count)
    const end = this.pinFirst ? null : this.pinSlot.el
    for (const index of step.toEnd) this.rowsEl.insertBefore(this.rowSlots[index].el, end)
    let before = this.rowSlots[this.domStart].el
    for (const index of step.toFront) { const el = this.rowSlots[index].el; this.rowsEl.insertBefore(el, before); before = el }
    this.domStart = this.ring.start
  }

  /** Paints one row's cells over the frame's columns (and the active cell when it is out of them); returns the active cell. */
  private paintRow(slot: RowSlot, row: number, range: VisibleRange, ranges: readonly CellRange[], active: { row: number; column: number } | undefined,
    tile: (row: number, column: number) => RowWindow | null, rebased: boolean, columnsMoved: boolean): CellSlot | undefined {
    if (slot.row !== row || rebased || !slot.shown) {
      if (slot.row !== row) {
        slot.row = row
        // A transposed row is a column: its header and its mark show the name where a row has its number.
        const name = this.rotated ? columnTitle(this.descriptor.columns[row].name) : String(row + 1)
        slot.number.nodeValue = name
        if (slot.mark) {
          slot.mark.text.nodeValue = name
          if (slot.mark.type) slot.mark.type.nodeValue = this.showTypes ? this.types[row] : ''
          if (this.rotated && this.hovered === slot.mark.el) { this.hovered.removeAttribute('title'); this.hovered = undefined }
        }
        slot.el.setAttribute('aria-rowindex', String(row + 2))
        for (const cell of slot.cells) cell.column = -1
        slot.pin.column = -1
      }
      const top = slot === this.pinSlot && this.model?.mode === 'virtual' && Math.abs(row - this.baseRow) > 50_000 ? -1000 : rowTop(row, this.baseRow)
      if (top !== slot.top) { slot.top = top; slot.el.style.top = top + 'px'; if (slot.mark) slot.mark.el.style.top = top + 'px' }
      if (!slot.shown) { slot.shown = true; slot.el.style.display = ''; if (slot.mark) slot.mark.el.style.display = '' }
    }
    // A row's tone text is parsed only when it differs from the one the slot last painted (scrolling repaints rows).
    const toneText = this.rotated ? '' : this.toneOf(row, tile)
    if (toneText !== slot.toneText) {
      const space = toneText.indexOf(' ')
      slot.toneText = toneText
      slot.toneOf = toneIndex.get(space < 0 ? toneText : toneText.slice(0, space)) ?? 0
      slot.cellMarks = space < 0 ? undefined : cellMarksOf(toneText.slice(space + 1))
    }
    // A transposed row is a column, which no highlight names: a highlighted row tints its drawn column (paintBands).
    const odd = row % 2 === 1, tone = slot.toneOf, highlight = this.rotated ? 0 : colorAt(this.highlights, row)
    if (odd !== slot.odd || tone !== slot.tone || highlight !== slot.highlight) {
      slot.odd = odd
      slot.el.className = rowClasses[odd ? 1 : 0][tone][highlight]
      if (highlight !== slot.highlight) {
        if (highlight) slot.header.setAttribute('aria-description', highlightLabel(highlight))
        else slot.header.removeAttribute('aria-description')
      }
    }
    if (slot.width !== this.width) { slot.width = this.width; slot.el.style.width = this.width + 'px' }
    let headerSel = false
    for (const item of ranges) if (row >= item.top && row <= item.bottom) { headerSel = true; break }
    if (headerSel !== slot.headerSel || tone !== slot.tone || highlight !== slot.highlight) { slot.headerSel = headerSel; if (slot.mark && !this.rotated) slot.mark.el.className = markClasses[headerSel ? 1 : 0][tone][highlight] }
    if (slot.mark) { if (this.rotated) this.paintName(slot.mark, slot.header, row, headerSel); else this.paintSize(slot.mark, row) }
    slot.tone = tone
    slot.highlight = highlight
    let activeCell: CellSlot | undefined
    const perRow = slot.cells.length
    for (let column = range.firstColumn; column <= range.lastColumn; column++) {
      const cell = slot.cells[column % perRow]
      this.paintCell(cell, row, column, ranges, active, tile, columnsMoved, slot.cellMarks)
      if (cell.bits & ACT) activeCell = cell
    }
    for (const cell of slot.cells) if (cell.column < range.firstColumn || cell.column > range.lastColumn) this.hideCell(cell)
    if (active && active.row === row && (active.column < range.firstColumn || active.column > range.lastColumn)) {
      this.paintCell(slot.pin, row, active.column, ranges, active, tile, columnsMoved, slot.cellMarks)
      activeCell = slot.pin
    } else this.hideCell(slot.pin)
    return activeCell
  }

  /**
   * The row-size bar behind a row number (or whatever element stands for the row): its share of the largest row (--rg-rs), marked large over half of it
   * (data-large, which CSS draws in the warning colour), the number in italics when its size is an estimate, and the exact bytes in its tooltip. Written
   * only when what it shows changes; a row whose size is not read yet shows none.
   */
  private paintSize(mark: SizeMark, row: number): void {
    const size = this.sizes?.get(row)
    const share = size ? Math.round(size.share * 1000) / 1000 : 0
    const key = size ? `${row}|${share}|${size.large ? 1 : 0}|${size.estimated ? 1 : 0}|${size.bytes}` : ''
    if (key === mark.size) return
    mark.size = key
    // The tooltip is the bar's from here on (or gone with it): a hover that wrote one on this element no longer owns it.
    if (this.hovered === mark.el) this.hovered = undefined
    const style = mark.el.style
    if (!size) {
      style.removeProperty('--rg-rs')
      delete mark.el.dataset.large
      style.fontStyle = ''
      mark.el.removeAttribute('title')
      return
    }
    style.setProperty('--rg-rs', String(share))
    if (size.large) mark.el.dataset.large = ''
    else delete mark.el.dataset.large
    style.fontStyle = size.estimated ? 'italic' : ''
    mark.el.title = `Row ${formatCount(row + 1)}: ${size.estimated ? 'about ' : ''}${formatCount(size.bytes)} ${plural(size.bytes, 'byte')} (the sum of DATALENGTH over its columns)`
  }

  /** A transposed row's name cell: its column's sort button (with aria-sort on `header`, the row's own header) and funnel,
   *  and its look: selected, unnamed, whether it has a funnel, and a column-name search's mark (matched, active, left out). */
  private paintName(mark: NonNullable<RowSlot['mark']>, header: HTMLElement, column: number, selected: boolean): void {
    if (mark.sort) this.paintSort(header, mark.sort, column)
    if (mark.funnel) this.paintFunnel(mark.funnel, column)
    const columns = this.searchMarks?.columns, search = !columns ? 0 : !columns[column] ? 3 : this.searchMarks!.currentColumn === column ? 2 : 1
    const look = 'rg-rn' + (selected ? ' sel' : '') + (this.descriptor.columns[column].name ? '' : ' unnamed') + (mark.funnel && this.canFilter(column) ? ' fb' : '') + (search ? ' ' + headerMarks[search] : '')
    if (look !== mark.look) { mark.look = look; mark.el.className = look }
  }
  /** Transposed: a highlighted row is a drawn column, tinted by one pooled band over its cells in view (a frame costs one
   *  element per highlighted column in view); its header takes the colour as a row's number does (paintHeaders). The bands
   *  stay under the header row as the rows scroll, `height` tall: the rows in view. */
  private paintBands(range: VisibleRange, height: number): void {
    const marks = this.highlights, pool = this.bands
    let used = 0
    if (marks && this.bandsEl && height > 0) {
      for (let column = range.firstColumn; column <= range.lastColumn; column++) {
        const color = colorAt(marks, column)
        if (!color) continue
        let band = pool[used]
        if (!band) {
          const el = this.bandsEl.ownerDocument.createElement('div')
          this.bandsEl.append(el)
          pool.push(band = { el, color: 0, left: Number.NaN, width: -1, height: -1, shown: true })
        }
        used++
        if (color !== band.color) { band.color = color; band.el.className = 'rg-band hl-' + highlightColors[color - 1] }
        const left = this.rowHeader + this.layout.xOf(column), width = this.layout.width(column)
        if (left !== band.left) { band.left = left; band.el.style.left = left + 'px' }
        if (width !== band.width) { band.width = width; band.el.style.width = width + 'px' }
        if (height !== band.height) { band.height = height; band.el.style.height = height + 'px' }
        if (!band.shown) { band.shown = true; band.el.style.display = '' }
      }
    }
    for (let index = used; index < pool.length; index++) if (pool[index].shown) { pool[index].shown = false; pool[index].el.style.display = 'none' }
  }

  /** A row's tone text: muted when the revision lists it departed, else its tone column's ('' for none). A diff's tone may
   *  list the row's differing cells after its name. */
  private toneOf(row: number, tile: (row: number, column: number) => RowWindow | null): string {
    if (this.muted.has(row)) return 'muted'
    if (this.tone < 0) return ''
    const window = tile(row, this.tone)
    if (!window || row - window.first >= window.count || this.tone >= window.colEnd) return ''
    const index = (row - window.first) * (window.colEnd - window.colStart) + this.tone - window.colStart
    return window.flags[index] & (FLAG_NULL | FLAG_ERROR) ? '' : window.text[index]
  }

  private paintCell(cell: CellSlot, row: number, column: number, ranges: readonly CellRange[], active: { row: number; column: number } | undefined,
    tile: (row: number, column: number) => RowWindow | null, columnsMoved: boolean, cellMarks?: ReadonlyMap<number, number>): void {
    if (cell.column !== column || columnsMoved) {
      if (cell.column !== column) { cell.column = column; cell.el.setAttribute('aria-colindex', String(column + 2)) }
      const left = this.rowHeader + this.layout.xOf(column), width = this.layout.width(column)
      if (left !== cell.left) { cell.left = left; cell.el.style.left = left + 'px' }
      if (width !== cell.width) { cell.width = width; cell.el.style.width = width + 'px' }
    }
    if (!cell.shown) { cell.shown = true; cell.el.style.display = '' }
    let bits = 0, value = ''
    // The cell's place in the result: its text, link and marks are read there; the selection and the active cell are as drawn.
    const sourceRow = this.rotated ? column : row, sourceColumn = this.rotated ? row : column
    const window = tile(sourceRow, sourceColumn)
    if (!window || sourceRow - window.first >= window.count) bits = LOAD
    else {
      const index = (sourceRow - window.first) * (window.colEnd - window.colStart) + sourceColumn - window.colStart
      const flags = window.flags[index]
      if (flags & FLAG_ERROR) { value = 'NULL'; bits = ERR }
      else if (flags & FLAG_NULL) { value = 'NULL'; bits = NULL }
      else { value = window.text[index]; if (flags & FLAG_TRUNCATED) bits = TRUNC; if (this.links[sourceColumn]) bits |= LINK }
    }
    if (cellMarks && !(bits & LOAD)) bits |= cellMarks.get(sourceColumn) ?? 0
    if (covered(ranges, row, column)) bits |= SEL
    if (active && active.row === row && active.column === column) bits |= ACT
    const marks = this.searchMarks
    if (marks) {
      if (marks.cells && marks.handle === this.handle && marks.cells.has(cellKey(sourceRow, sourceColumn))) bits |= marks.current && marks.current.row === sourceRow && marks.current.column === sourceColumn ? HIT | CUR : HIT
      if (marks.columns && !marks.columns[sourceColumn]) bits |= DIM
    }
    if (bits !== cell.bits) {
      if ((bits ^ cell.bits) & SEL) cell.el.setAttribute('aria-selected', bits & SEL ? 'true' : 'false')
      cell.bits = bits
      cell.el.className = classes[bits]
    }
    if (value !== cell.value || this.whitespace !== cell.mode) {
      cell.value = value
      cell.mode = this.whitespace
      const runs = bits & (NULL | ERR | LOAD) ? undefined : whitespaceRuns(value, this.whitespace)
      if (runs) this.writeMarked(cell, runs)
      else {
        if (cell.marked) { cell.marked = false; cell.el.replaceChildren(cell.text) }
        // Tiles hold the value's own text; a cell shows it on one line, as SSMS does (line breaks and tabs as spaces).
        cell.text.nodeValue = displayText(value)
      }
    }
  }
  /**
   * Writes a value with its white space marked: its text as Text nodes, and the marks in spans hidden from screen readers,
   * which read the value itself in the active cell's label. Only cells with something to mark get more than one node.
   */
  private writeMarked(cell: CellSlot, runs: readonly { readonly kind: 'text' | 'mark' | 'badge'; readonly text: string }[]): void {
    const doc = cell.el.ownerDocument
    cell.marked = true
    cell.el.replaceChildren(...runs.map(run => {
      const text = doc.createTextNode('')
      text.nodeValue = run.text
      if (run.kind === 'text') return text
      const span = doc.createElement('span')
      span.className = run.kind === 'mark' ? 'rg-ws' : 'rg-ws rg-wsb'
      span.setAttribute('aria-hidden', 'true')
      span.append(text)
      return span
    }))
  }

  /** A slot out of use is hidden and forgets its position, so no stale row or column index stays in the DOM. */
  private hideRow(slot: RowSlot): void {
    if (!slot.shown) return
    slot.shown = false
    slot.row = -1
    slot.el.style.display = 'none'
    slot.el.removeAttribute('aria-rowindex')
    if (slot.mark) slot.mark.el.style.display = 'none'
  }
  private hideCell(cell: CellSlot): void {
    if (!cell.shown) return
    cell.shown = false
    cell.column = -1
    cell.el.style.display = 'none'
    cell.el.removeAttribute('aria-colindex')
  }

  private paintHeaders(range: VisibleRange, ranges: readonly CellRange[], columnsMoved: boolean, tile: (row: number, column: number) => RowWindow | null): void {
    const count = this.headerSlots.length
    if (count === 0) return
    const used = new Set<HeaderSlot>()
    for (let column = range.firstColumn; column <= range.lastColumn; column++) {
      const header = this.headerSlots[column % count]
      used.add(header)
      if (header.column !== column || columnsMoved) {
        if (header.column !== column) {
          header.column = column
          // A transposed header stands for a row: its text is written below, each frame.
          if (this.rotated) header.label = ''
          else {
            const name = this.descriptor.columns[column].name
            header.text.nodeValue = columnTitle(name)
            header.type.nodeValue = this.showTypes ? this.types[column] : ''
            header.el.classList.toggle('unnamed', !name)
          }
          header.el.setAttribute('aria-colindex', String(column + 2))
          if (header.funnel) header.el.classList.toggle('fb', this.canFilter(column))
          if (this.hovered === header.el) { this.hovered.removeAttribute('title'); this.hovered = undefined }
        }
        const left = this.rowHeader + this.layout.xOf(column), width = this.layout.width(column)
        if (left !== header.left) { header.left = left; header.el.style.left = left + 'px' }
        if (width !== header.width) {
          header.width = width
          header.el.style.width = width + 'px'
          if (header.sort || header.funnel) header.el.classList.toggle('narrow', width < g.sortButtonMinWidth)
        }
      }
      if (!header.shown) { header.shown = true; header.el.style.display = '' }
      if (this.rotated) {
        // Each frame: the header column's value may have been read since, and the row's highlight or size may have changed.
        const label = this.headerLabel(column, tile)
        if (label !== header.label) { header.label = label; header.text.nodeValue = label }
        const highlight = colorAt(this.highlights, column)
        if (highlight !== header.highlight) {
          if (header.highlight) header.el.classList.remove('hl', 'hl-' + highlightColors[header.highlight - 1])
          if (highlight) { header.el.classList.add('hl', 'hl-' + highlightColors[highlight - 1]); header.el.setAttribute('aria-description', highlightLabel(highlight)) }
          else header.el.removeAttribute('aria-description')
          header.highlight = highlight
        }
        if (this.sizes || header.size) this.paintSize(header, column)
      }
      let sel = false
      for (const item of ranges) if (column >= item.left && column <= item.right) { sel = true; break }
      if (sel !== header.sel) { header.sel = sel; header.el.classList.toggle('sel', sel) }
      // A transposed grid marks a matched name in its name cell (paintName).
      const columns = this.rotated ? undefined : this.searchMarks?.columns, mark = !columns ? 0 : !columns[column] ? 3 : this.searchMarks!.currentColumn === column ? 2 : 1
      if (mark !== header.mark) {
        if (header.mark) header.el.classList.remove(headerMarks[header.mark])
        if (mark) header.el.classList.add(headerMarks[mark])
        header.mark = mark
      }
      if (header.sort) this.paintSort(header.el, header.sort, column)
      if (header.funnel) this.paintFunnel(header.funnel, column)
    }
    for (const header of this.headerSlots) if (!used.has(header) && header.shown) { header.shown = false; header.column = -1; header.el.style.display = 'none'; header.el.removeAttribute('aria-colindex') }
  }

  /** A column's funnel, filled while the column has a filter. */
  private paintFunnel(funnel: FunnelButton, column: number): void {
    const on = this.filtered.has(column)
    if (on === funnel.on) return
    funnel.on = on
    funnel.el.classList.toggle('on', on)
    funnel.glyph.className = codiconClass(on ? 'filter-filled' : 'filter')
    funnel.el.title = on ? 'Filter column values (filtered)' : 'Filter column values'
  }

  /** Whether a column's header has a funnel. */
  canFilter(column: number): boolean { return !!this.o.onFilter && column >= 0 && column < this.columns && (!this.filterable || this.filterable.has(column)) }

  /** Where a column's funnel popover opens: under its header's right end, clamped to the grid (Alt+Down in a grid);
   *  transposed, under its name cell's right end, kept inside the rows in view. */
  filterAnchor(column: number): DOMRect {
    const box = this.scroller.getBoundingClientRect()
    if (this.rotated) {
      const first = box.top + g.headerHeight, top = first + column * g.rowHeight - this.offsets.virtualTop
      return new DOMRect(box.left + this.rowHeader - g.funnelWidth, Math.min(Math.max(first, box.bottom - g.rowHeight), Math.max(first, top)), g.funnelWidth, g.rowHeight)
    }
    const right = Math.min(box.right, Math.max(box.left + this.rowHeader, box.left + this.rowHeader + this.layout.xOf(column) + this.layout.width(column) - this.offsets.scrollLeft))
    return new DOMRect(right - 18, box.top, 18, g.headerHeight)
  }

  /** A column's sort button: the direction's arrow, its place when the grid sorts by several columns, and aria-sort on
   *  `target`, the element that heads the first key's column (ARIA allows one at a time). Unsorted, the button shows only
   *  while its header is hovered. */
  private paintSort(target: HTMLElement, sort: SortButton, column: number): void {
    const key = this.sortKeys.get(column)
    const state = key ? `${key.at}:${key.descending ? 1 : 0}:${this.sortKeys.size}` : ''
    if (state === sort.state) return
    sort.state = state
    sort.el.classList.toggle('on', !!key)
    sort.glyph.className = codiconClass(key?.descending ? 'arrow-down' : 'arrow-up')
    sort.order.nodeValue = key && this.sortKeys.size > 1 ? String(key.at + 1) : ''
    sort.el.title = !key ? 'Sort ascending' : key.descending ? 'Clear sort' : 'Sort descending'
    if (key && key.at === 0) target.setAttribute('aria-sort', key.descending ? 'descending' : 'ascending')
    else target.removeAttribute('aria-sort')
  }

  /** What a column's header needs for its text: the name, and the gap and type after it when types are shown. */
  private headerTextWidth(column: number): number {
    const name = this.headerWidth(columnTitle(this.descriptor.columns[column].name))
    return this.showTypes ? name + g.typeGap + this.typeWidth(this.types[column]) : name
  }

  /** The grid's own ARIA: counts change at most once a second while rows stream in. */
  private aria(state: string, rows: number): void {
    const open = state === 'open'
    const name = this.o.label ?? `Result ${this.o.resultNumber} of ${this.resultCount}`, drawnColumns = this.drawnColumns(rows)
    const label = this.rotated ? transposedLabel(name, rows, this.columns, drawnColumns, open) : gridLabel(name, rows, this.columns, open)
    if (label === this.ariaLabel) return
    const now = performance.now()
    if (open && rows !== this.ariaRows && now - this.ariaAt < g.ariaRowCountMs) {
      this.ariaTimer ??= setTimeout(() => { this.ariaTimer = undefined; this.schedule() }, g.ariaRowCountMs - (now - this.ariaAt))
      return
    }
    this.ariaAt = now
    this.ariaRows = rows
    this.ariaLabel = label
    // The counts describe what is drawn, which is what a screen reader walks.
    this.root.setAttribute('aria-rowcount', String(this.drawnRows(rows) + 1))
    if (this.rotated) this.root.setAttribute('aria-colcount', String(drawnColumns + 1))
    this.root.setAttribute('aria-busy', String(open))
    this.root.setAttribute('aria-label', label)
  }
}

/** A grid's accessible label: its name, then how many rows and shown columns it has, and whether more rows are coming. */
export function gridLabel(name: string, rows: number, columns: number, open: boolean): string {
  return `${name}, ${formatCount(rows)} ${plural(rows, 'row')}, ${formatCount(columns)} ${plural(columns, 'column')}${open ? ', still loading' : ''}`
}
/** A transposed grid's label: what is drawn, and how many of the result's rows that is when the cap leaves some out. */
export function transposedLabel(name: string, rows: number, columns: number, drawn: number, open: boolean): string {
  const shown = drawn < rows ? `the first ${formatCount(drawn)} of ${formatCount(rows)} rows as columns` : `${formatCount(rows)} ${plural(rows, 'row')} as columns`
  return `${name}, transposed, ${formatCount(columns)} ${plural(columns, 'column')} as rows, ${shown}${open ? ', still loading' : ''}`
}
export { withinCap }
/** A stand-in axis of one column, for the rows a transposed grid shows while it has no column to draw. */
const oneColumn: ColumnAxis = { count: 1, total: 1, width: () => 1, xOf: column => column <= 0 ? 0 : 1, columnAt: () => 0, setWidth: () => 1, setMaxTotal: () => {} }
const toneEntry = /^(~?)(\d{1,5})(?:-(\d{1,5}))?$/
/** A diff row's differing cells from its tone text's tail ("4 ~6-8": column 4 changed, columns 6 to 8 equal only by
 *  collation). Runs are ranges (UnifiedDiff.Tone); anything else, such as the "…" a cut tone ends with, is skipped, and no
 *  run reaches past the widest result. */
export function cellMarksOf(text: string): ReadonlyMap<number, number> | undefined {
  if (!text) return undefined
  const marks = new Map<number, number>()
  for (const token of text.split(' ')) {
    const entry = toneEntry.exec(token)
    if (!entry) continue
    const first = Number(entry[2]), last = entry[3] === undefined ? first : Number(entry[3])
    if (last < first || last >= wire.page.maxColumns) continue
    for (let column = first; column <= last; column++) marks.set(column, entry[1] ? SOFT : CHG)
  }
  return marks.size > 0 ? marks : undefined
}

/** A live table's hidden tone column: its last column, when that column's role is tone; else -1. */

export function toneColumnOf(descriptor: Pick<ResultDescriptor, 'columns'>): number {
  const last = descriptor.columns.length - 1
  return last >= 1 && descriptor.columns[last].role === 'tone' ? last : -1
}

/** The first cell, as the current cell of a grid nothing has been selected in. */
function firstCell(entry: string): GridSelection { return cellSelection(entry, 0, 0) }
/** One cell, selected and active. */
function cellSelection(entry: string, row: number, column: number): GridSelection {
  const cell = { row, column }
  return { entry, blocks: [{ kind: 'cells', anchor: cell, focus: cell }], active: cell }
}

let measureContext: CanvasRenderingContext2D | null | undefined
let measuredCharWidth: number | undefined
/** The grid font's digit width and header measurers (canvas measureText in the UI font, for names and the smaller types).
 *  One canvas serves every grid, and the digit width is measured once, again only when fonts finish loading (`fresh`). */
function fontMeasure(fresh = false): { charWidth: number; header: (text: string) => number; type: (text: string) => number } {
  const context = measureContext === undefined ? measureContext = document.createElement('canvas').getContext('2d') : measureContext
  if (!context) return { charWidth: 7.2, header: text => text.length * 7, type: text => text.length * 6 }
  if (fresh || measuredCharWidth === undefined) measuredCharWidth = measureCharWidth(text => { context.font = `${g.fontSize}px ${monoFontFamily}`; return context.measureText(text).width })
  const header = (text: string) => { context.font = `${g.fontSize}px ${uiFontFamily}`; return context.measureText(text).width }
  const type = (text: string) => { context.font = `${typeScale.xs.size}px ${uiFontFamily}`; return context.measureText(text).width }
  return { charWidth: measuredCharWidth, header, type }
}

const sortMap = (keys: readonly HeaderSortKey[] = []): ReadonlyMap<number, { readonly at: number; readonly descending: boolean }> =>
  new Map(keys.map((key, at) => [key.column, { at, descending: key.descending }]))
const sameSortMap = (a: ReadonlyMap<number, { readonly at: number; readonly descending: boolean }>, b: ReadonlyMap<number, { readonly at: number; readonly descending: boolean }>) =>
  a.size === b.size && [...a].every(([column, key]) => b.get(column)?.at === key.at && b.get(column)?.descending === key.descending)

/** Whether the focused element is in a grid of `root`'s run: results grids name their tab, and a live grid (no tab) never
 *  counts. A search step's reveal that waited selects only while this holds, so it never takes the focus from elsewhere. */
export function focusInRun(root: Pick<HTMLElement, 'dataset'>, active: Pick<Element, 'closest'> | null): boolean {
  const tabId = root.dataset.tabId
  return tabId !== undefined && active?.closest<HTMLElement>('[data-result-grid]')?.dataset.tabId === tabId
}
const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every(item => b.has(item))
