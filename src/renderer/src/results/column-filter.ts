import type { ResolvedViewFilter, ViewFilter } from '../../../shared/contracts'
import type { DistinctList } from './ResultClient'
import { formatCount } from './status'

/**
 * What the header funnel's popover applies to a column: the values its checklist ticks (a `groups` filter by its distinct
 * snapshot, `list`, which the grid then keeps), and by base rows, each row standing for its value as the column's
 * collation compares it, one value or not it, between two values, NULL or not NULL; `all` takes the checklist's filter
 * off, `clear` every filter of the column.
 */
export type ColumnCondition =
  | { readonly kind: 'list'; readonly list: DistinctList }
  | { readonly kind: 'equals' | 'notEquals'; readonly row: number }
  | { readonly kind: 'between'; readonly rows: readonly [number, number] }
  | { readonly kind: 'null' | 'notNull' }
  | { readonly kind: 'all' | 'clear' }

/** Which of a column's filters a condition replaces: its value list (in, notIn, equals, NULL), its range, or its not-NULL.
 *  The checklist lists NULL as a value, so a value list and a not-NULL replace each other (`sameFilterFamily`). */
export type ColumnFilterKind = 'values' | 'between' | 'notNull'

/** A notIn of no rows with NULL: Exclude NULLs. */
export const isNotNullFilter = (filter: ViewFilter | ResolvedViewFilter) => filter.op === 'notIn' && 'rows' in filter && filter.rows.length === 0 && !!filter.nulls

/** The kind of a grid filter on `column`, or undefined when it is not one of that column's (duplicates span columns, and
 *  Keep Selected Rows names none). */
export function columnFilterKind(filter: ViewFilter | ResolvedViewFilter, column: number): ColumnFilterKind | undefined {
  if (filter.op === 'duplicates' || filter.op === 'keepRows' || filter.column !== column) return undefined
  if (filter.op === 'between') return 'between'
  return isNotNullFilter(filter) ? 'notNull' : 'values'
}

/** Whether a filter of kind `own` is the one a condition of kind `kind` replaces: the same kind, or a value list and a
 *  not-NULL, which the checklist shows as one list. */
export const sameFilterFamily = (own: ColumnFilterKind, kind: ColumnFilterKind) => own === kind || (own !== 'between' && kind !== 'between')

export function conditionKind(condition: ColumnCondition): ColumnFilterKind | undefined {
  switch (condition.kind) {
    case 'between': return 'between'
    case 'notNull': return 'notNull'
    case 'clear': return undefined
    default: return 'values'
  }
}

/** The view filter a condition asks for (undefined for `all` and `clear`, which only take filters off). */
export function conditionFilter(condition: ColumnCondition, column: number): ViewFilter | undefined {
  switch (condition.kind) {
    case 'list': return { op: 'groups', column, snapshotId: condition.list.snapshotId }
    case 'equals': return { op: 'in', column, rows: [condition.row], nulls: false }
    case 'notEquals': return { op: 'notIn', column, rows: [condition.row], nulls: false }
    case 'between': return { op: 'between', column, rows: [...condition.rows] }
    case 'null': return { op: 'in', column, rows: [], nulls: true }
    case 'notNull': return { op: 'notIn', column, rows: [], nulls: true }
    default: return undefined
  }
}

/** What the checklist's OK does, or why it cannot: nothing ticked. */
export type ChecklistOutcome = { readonly condition: ColumnCondition } | { readonly error: string }

/**
 * The checklist as a condition, from its snapshot's ticks: `checked` of its `distinct` values, and NULL's tick when the
 * column has NULLs. Nothing ticked cannot filter; everything ticked takes the filter off; anything else filters by the
 * snapshot, whose rows the backend names as it likes (it keeps or drops whichever are fewer, and drops while rows still
 * arrive, so their values stay shown).
 */
export function checklistCondition(o: { list: DistinctList; checked: number; distinct: number; hasNull: boolean; nullChecked: boolean }): ChecklistOutcome {
  const nullIn = o.hasNull && o.nullChecked
  if (o.checked === 0 && !nullIn) return { error: 'Select at least one value.' }
  if (o.checked === o.distinct && (!o.hasNull || nullIn)) return { condition: { kind: 'all' } }
  return { condition: { kind: 'list', list: o.list } }
}

/** The checklist's tallest scroll space in px at a pixel ratio of 1: Chromium clamps layout sizes near 33.5 million device
 *  px, so a longer list maps its scroll bar onto its rows instead of giving each row its own pixels. The popover passes the
 *  grid's `scrollCap` for the window's pixel ratio as `maxSpace`, which is lower. */
export const maxListSpace = 30_000_000

/** The rows of a virtual list of fixed-height rows drawn for a scroll position (with `overscan` rows past each edge), its
 *  scroll space, and each row's place in it. Within `maxListSpace` a row sits at `row × rowHeight`; past it the scroll bar's
 *  range spans the rows, and the rows in view are placed around the scroll position, so every row stays reachable.
 *  `viewHeight` is the list's client height, padding included; `pad` is the padding above and below the rows. */
export function listWindow(o: { scrollTop: number; viewHeight: number; rowHeight: number; rows: number; overscan: number; maxSpace?: number; pad?: number }): { space: number; first: number; last: number; offset(row: number): number } {
  const { scrollTop, viewHeight, rowHeight, rows, overscan } = o, maxSpace = o.maxSpace ?? maxListSpace, pad = o.pad ?? 0
  const full = rows * rowHeight, space = Math.min(full, maxSpace), visible = Math.max(viewHeight, rowHeight) / rowHeight
  // Mapped, the scroll range (the space and both paddings, less the view) spans the rows but those the end shows whole
  // between the paddings, so the last row ends at the bottom padding.
  const top = full <= maxSpace ? scrollTop / rowHeight
    : Math.min(1, Math.max(0, scrollTop / Math.max(1, space + 2 * pad - viewHeight))) * Math.max(0, rows - (viewHeight - 2 * pad) / rowHeight)
  // Mapped, the rows past the view's bottom stop at the space's end: each starts inside it, and the space clips the part of
  // the last that would hang past it (overflow: hidden), so no row grows the scroll range.
  const fits = full <= maxSpace ? rows : Math.ceil(top + (space - scrollTop) / rowHeight - 1e-6)
  return {
    space,
    first: Math.max(0, Math.floor(top) - overscan),
    last: Math.max(0, Math.min(rows, fits, Math.ceil(top + visible) + overscan)),
    offset: row => full <= maxSpace ? row * rowHeight : scrollTop + (row - top) * rowHeight
  }
}

/** Pixels of slack `scrollToShow` and `rowsInView` allow: Chromium snaps scrollTop to device pixels (1102 reads back
 *  1102.4 at 125% scaling), and mapped, offset() adds a scroll position near 3e7 that is taken off again. */
const slack = 1

/**
 * The scroll position that shows `row` of a virtual list (`listWindow`'s rows, below the list's top padding `pad`, which
 * scrolls with them) by the least move: aligned to the top when it is above the view, to the bottom when below; undefined
 * when it is already wholly in view. Past `maxSpace` the scroll bar spans the rows, so the position is the row's share of
 * the scroll range.
 */
export function scrollToShow(o: { row: number; rows: number; rowHeight: number; viewHeight: number; scrollTop: number; pad?: number; maxSpace?: number }): number | undefined {
  const { row, rows, rowHeight, viewHeight, scrollTop } = o, pad = o.pad ?? 0, maxSpace = o.maxSpace ?? maxListSpace
  const at = listWindow({ scrollTop, viewHeight, rowHeight, rows, overscan: 0, maxSpace, pad })
  const position = at.offset(row) + pad - scrollTop
  if (position >= -slack && position + rowHeight <= viewHeight + slack) return undefined
  const above = position < -slack
  if (above) return scrollToTop({ row, rows, rowHeight, viewHeight, pad, maxSpace })
  if (rows * rowHeight <= maxSpace) return Math.max(0, (row + 1) * rowHeight + pad - viewHeight)
  // Mapped: listWindow puts the row `top` rows down at scrollTop / range × span; the row whose bottom meets the view's
  // bottom (less the padding above the rows) solves for it.
  const range = Math.max(1, at.space + 2 * pad - viewHeight), span = Math.max(1, rows - (viewHeight - 2 * pad) / rowHeight)
  // Whole pixels, up: the row ends at or above the bottom.
  const exact = Math.max(0, row + 1 - (viewHeight - pad) / rowHeight) / span * range
  return Math.min(range, Math.max(0, Math.ceil(exact)))
}

/** The scroll position that puts `row` at the top of the view, below the top padding (the padding too for the first row):
 *  within the space its pixels, past it its share of the mapped range, rounded down so it starts at or below the top. */
export function scrollToTop(o: { row: number; rows: number; rowHeight: number; viewHeight: number; pad?: number; maxSpace?: number }): number {
  const { row, rows, rowHeight, viewHeight } = o, pad = o.pad ?? 0, maxSpace = o.maxSpace ?? maxListSpace
  if (row <= 0) return 0
  if (rows * rowHeight <= maxSpace) return row * rowHeight + pad
  const space = Math.min(rows * rowHeight, maxSpace)
  const range = Math.max(1, space + 2 * pad - viewHeight), span = Math.max(1, rows - (viewHeight - 2 * pad) / rowHeight)
  return Math.min(range, Math.max(0, Math.floor(row / span * range)))
}

/** The list's geometry for `rowAtTop` and `scrollForRowAtTop`. */
export interface ListGeometry { rows: number; rowHeight: number; viewHeight: number; pad?: number; maxSpace?: number }

/** The row, fractional, at the top edge of the view at a scroll position (`listWindow`'s placement, padding included). */
export function rowAtTop(o: ListGeometry & { scrollTop: number }): number {
  const { rows, rowHeight, viewHeight, scrollTop } = o, pad = o.pad ?? 0, maxSpace = o.maxSpace ?? maxListSpace
  if (rows * rowHeight <= maxSpace) return (scrollTop - pad) / rowHeight
  const range = Math.max(1, Math.min(rows * rowHeight, maxSpace) + 2 * pad - viewHeight), span = Math.max(0, rows - (viewHeight - 2 * pad) / rowHeight)
  return Math.min(1, Math.max(0, scrollTop / range)) * span - pad / rowHeight
}

/** The scroll position that puts the fractional row `row` at the top edge of the view: `rowAtTop`'s inverse. */
export function scrollForRowAtTop(o: ListGeometry & { row: number }): number {
  const { rows, rowHeight, viewHeight, row } = o, pad = o.pad ?? 0, maxSpace = o.maxSpace ?? maxListSpace
  if (rows * rowHeight <= maxSpace) return Math.max(0, row * rowHeight + pad)
  const range = Math.max(1, Math.min(rows * rowHeight, maxSpace) + 2 * pad - viewHeight), span = Math.max(1, rows - (viewHeight - 2 * pad) / rowHeight)
  return Math.min(range, Math.max(0, (row + pad / rowHeight) / span * range))
}

/** The rows of the list fully in view at a scroll position (with its top padding): the first and the last. */
export function rowsInView(o: { rows: number; rowHeight: number; viewHeight: number; scrollTop: number; pad?: number; maxSpace?: number }): { first: number; last: number } {
  const { rows, rowHeight, viewHeight, scrollTop } = o, pad = o.pad ?? 0
  const at = listWindow({ scrollTop, viewHeight, rowHeight, rows, overscan: 0, maxSpace: o.maxSpace, pad })
  let first = at.first
  while (first < rows - 1 && at.offset(first) + pad - scrollTop < -slack) first++
  let last = first
  while (last + 1 < rows && at.offset(last + 1) + pad - scrollTop + rowHeight <= viewHeight + slack) last++
  return { first, last }
}

/** The cached blocks to drop so at most `max` stay: the farthest from those in view (`first` to `last`), never one in view. */
export function blocksToDrop(blocks: Iterable<number>, first: number, last: number, max: number): number[] {
  const held = [...blocks]
  if (held.length <= max) return []
  const distance = (block: number) => block < first ? first - block : block > last ? block - last : 0
  return held.filter(block => distance(block) > 0).sort((a, b) => distance(b) - distance(a)).slice(0, held.length - max)
}

/** The popover's size bounds in px; a size outside them (a small window, a hand-edited setting) is clamped. */
export const popoverBounds = { minWidth: 340, maxWidth: 900, minHeight: 240, maxHeight: 1200 } as const
/** The height the popover is placed for when it sizes to its contents (no remembered height). */
export const popoverNaturalHeight = 420
/** Room kept between the popover and the window's edges, and between it and the column. */
const edge = 8, gap = 2

/** The room beside the band on `side`, between the band and the window's edges. */
export function popoverRoom(band: { left: number; right: number; top: number; bottom: number }, view: { width: number; height: number }, side: 'right' | 'left' | 'below' | 'above'): { width: number; height: number } {
  switch (side) {
    case 'right': return { width: view.width - edge - (band.right + gap), height: view.height - 2 * edge }
    case 'left': return { width: band.left - gap - edge, height: view.height - 2 * edge }
    case 'below': return { width: view.width - 2 * edge, height: view.height - edge - (band.bottom + gap) }
    case 'above': return { width: view.width - 2 * edge, height: band.top - gap - edge }
  }
}

/** Where the popover opens: `top` or `bottom` (from the window's bottom edge), its width, and the height it may take. */
export interface PopoverPlace {
  readonly side: 'right' | 'left' | 'below' | 'above'; readonly left: number; readonly top?: number; readonly bottom?: number; readonly width: number; readonly maxHeight: number
  /** The last resort, over the column: no side of it is kept for a resize. */
  readonly over?: true
}

/**
 * Where the funnel's popover opens beside its column (`band`: the column's header and drawn cells, or a rotated grid's
 * row), so it never covers the values it filters: to the column's right when it fits there, else to its left, else below
 * or above the band (a rotated grid's row, or a column as wide as the window), else narrower on the roomier side that
 * takes the smallest popover, else over the column at its right end as a last resort. Beside the column it starts level with the header and moves up only as far as its height needs.
 * `height` is the remembered height, or `popoverNaturalHeight` when it sizes to its contents.
 */
export function popoverPlace(o: { band: { left: number; right: number; top: number; bottom: number }; width: number; height: number; view: { width: number; height: number }; side?: PopoverPlace['side'] }): PopoverPlace {
  const { band, view } = o
  let width = Math.max(Math.min(popoverBounds.minWidth, view.width - 2 * edge), Math.min(o.width, view.width - 2 * edge))
  let height = Math.min(o.height, view.height - 2 * edge)
  const beside = (left: number, side: 'right' | 'left'): PopoverPlace => {
    const top = Math.max(edge, Math.min(band.top, view.height - edge - height))
    return { side, left, top, width, maxHeight: Math.max(0, view.height - edge - top) }
  }
  // A side kept (`popoverSide`, while and after its grip is dragged) holds whatever size fits there, so the popover never
  // jumps across the column as it grows or shrinks.
  if (o.side && keepsSide(band, view, o.side)) {
    const room = popoverRoom(band, view, o.side)
    width = Math.min(width, room.width)
    height = Math.min(height, room.height)
    if (o.side === 'right') return beside(band.right + gap, 'right')
    if (o.side === 'left') return beside(band.left - gap - width, 'left')
    const left = Math.max(edge, Math.min(band.left, view.width - edge - width))
    return o.side === 'below' ? { side: 'below', left, top: band.bottom + gap, width, maxHeight: room.height } : { side: 'above', left, bottom: view.height - band.top + gap, width, maxHeight: room.height }
  }
  if (view.width - edge - (band.right + gap) >= width) return beside(band.right + gap, 'right')
  if (band.left - gap - edge >= width) return beside(band.left - gap - width, 'left')
  const left = Math.max(edge, Math.min(band.left, view.width - edge - width))
  const below = view.height - edge - (band.bottom + gap), above = band.top - gap - edge
  const fits = Math.min(height, popoverBounds.minHeight)
  if (below >= fits && (below >= height || below >= above)) return { side: 'below', left, top: band.bottom + gap, width, maxHeight: below }
  if (above >= fits) return { side: 'above', left, bottom: view.height - band.top + gap, width, maxHeight: above }
  // Too wide for either side at its remembered width: narrower, beside the column on the roomier side that takes the
  // smallest popover, rather than over the values it filters.
  const roomRight = popoverRoom(band, view, 'right').width, roomLeft = popoverRoom(band, view, 'left').width
  const sides = (['right', 'left'] as const).filter(side => keepsSide(band, view, side))
  if (sides.length) {
    const side = sides.length === 2 ? (roomRight >= roomLeft ? 'right' : 'left') : sides[0]
    width = Math.min(width, side === 'right' ? roomRight : roomLeft)
    return side === 'right' ? beside(band.right + gap, 'right') : beside(band.left - gap - width, 'left')
  }
  // Nowhere clear of the column: over it, under its header, at its right end.
  const top = Math.max(edge, Math.min(band.top + gap, view.height - edge - height))
  return { side: 'right', left: Math.max(edge, Math.min(band.right - width, view.width - edge - width)), top, width, maxHeight: Math.max(0, view.height - edge - top), over: true }
}

/** Whether the popover can stay on `side` of the band: the room there takes its smallest size. A placement over the
 *  column (`over`) is never kept, whatever room its side has. */
export function keepsSide(band: { left: number; right: number; top: number; bottom: number }, view: { width: number; height: number }, side: PopoverPlace['side']): boolean {
  const room = popoverRoom(band, view, side)
  return room.width >= Math.min(popoverBounds.minWidth, view.width - 2 * edge) && room.height >= Math.min(popoverBounds.minHeight, view.height - 2 * edge)
}

/** A remembered popover size held within `popoverBounds` and the window; a height of 0 sizes it to its contents. */
export function clampPopoverSize(size: { width: number; height: number }, view: { width: number; height: number }): { width: number; height: number } {
  const width = Math.round(Math.max(popoverBounds.minWidth, Math.min(popoverBounds.maxWidth, view.width - 2 * edge, size.width)))
  const height = size.height <= 0 ? 0 : Math.round(Math.max(popoverBounds.minHeight, Math.min(popoverBounds.maxHeight, view.height - 2 * edge, size.height)))
  return { width, height }
}

/** The checklist's selected rows (the highlight, apart from the ticks): sorted, disjoint, inclusive ranges of list rows,
 *  so Shift+End over a million values is one range. */
export type RowSelection = readonly (readonly [first: number, last: number])[]
/** Separate ranges a selection keeps at most (the ranges one results.distinctTick names); a click past it adds nothing. */
export const maxSelectionRanges = 512

/** Rows `a` to `b`, either way round. */
export const selectRange = (a: number, b: number): RowSelection => [[Math.min(a, b), Math.max(a, b)]]

/** Whether `row` is selected. */
export function isSelected(selection: RowSelection, row: number): boolean {
  let low = 0, high = selection.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1, [first, last] = selection[mid]
    if (row < first) high = mid - 1
    else if (row > last) low = mid + 1
    else return true
  }
  return false
}

/** How many rows are selected. */
export const selectedCount = (selection: RowSelection) => selection.reduce((sum, [first, last]) => sum + last - first + 1, 0)

/** The selection with rows `a` to `b` added (ranges that touch merge), or as it was when that needs more ranges than
 *  `maxSelectionRanges`. */
export function addRange(selection: RowSelection, a: number, b: number): RowSelection {
  let first = Math.min(a, b), last = Math.max(a, b)
  const out: (readonly [number, number])[] = []
  for (const range of selection) {
    if (range[1] < first - 1 || range[0] > last + 1) out.push(range)
    else { first = Math.min(first, range[0]); last = Math.max(last, range[1]) }
  }
  out.push([first, last])
  out.sort((x, y) => x[0] - y[0])
  return out.length > maxSelectionRanges ? selection : out
}

/** The selection with `row` added, or taken out when it is selected (Ctrl+Click, Ctrl+Space). */
export function toggleRow(selection: RowSelection, row: number): RowSelection {
  if (!isSelected(selection, row)) return addRange(selection, row, row)
  const out: (readonly [number, number])[] = []
  for (const [first, last] of selection) {
    if (row < first || row > last) { out.push([first, last]); continue }
    if (first < row) out.push([first, row - 1])
    if (row < last) out.push([row + 1, last])
  }
  return out.length > maxSelectionRanges ? selection : out
}

/** A selection as results.distinctTick names it: NULL's entry (list row 0 when `nullRows` is 1) apart, the values as
 *  `[offset, count]` ranges of the list in its order and search. */
export function selectionTicks(selection: RowSelection, nullRows: number): { readonly nulls: boolean; readonly ranges: [offset: number, count: number][] } {
  const ranges: [number, number][] = []
  for (const [first, last] of selection) {
    const from = Math.max(first, nullRows) - nullRows, to = last - nullRows
    if (to >= from) ranges.push([from, to - from + 1])
  }
  return { nulls: nullRows > 0 && isSelected(selection, 0), ranges }
}

/** What an entry of the checklist's action list does (ColumnFilterPopover runs it): ticks for every value, the search's
 *  matches or the selected rows, `only` unticking everything else first; or flips every tick. */
export type ChecklistAction =
  | { readonly kind: 'all' | 'matches' | 'selected'; readonly checked: boolean; readonly only?: boolean }
  | { readonly kind: 'invert' }

/** An entry of the action list: a group's heading and its actions, each with its label and how many values it touches. */
export interface ActionGroup { readonly label?: string; readonly actions: readonly { readonly label: string; readonly count?: number; readonly action: ChecklistAction }[] }

/**
 * The action list beside the values, by context: with two or more rows selected, actions for them first; with a search,
 * actions for its matches, then for every value apart; Invert ticks only with no search. Each action names how many values
 * it touches, so a search never makes "untick" quietly mean "only these".
 */
export function checklistActions(o: { selected: number; matches: number | undefined; total: number }): ActionGroup[] {
  const groups: ActionGroup[] = []
  if (o.selected > 1) groups.push({
    label: `${formatCount(o.selected)} selected`,
    actions: [
      { label: 'Tick the selected', count: o.selected, action: { kind: 'selected', checked: true } },
      { label: 'Untick the selected', count: o.selected, action: { kind: 'selected', checked: false } },
      { label: 'Tick only the selected', count: o.selected, action: { kind: 'selected', checked: true, only: true } }
    ]
  })
  if (o.matches !== undefined) groups.push({
    label: `${formatCount(o.matches)} ${o.matches === 1 ? 'match' : 'matches'}`,
    actions: [
      { label: 'Tick the matches', count: o.matches, action: { kind: 'matches', checked: true } },
      { label: 'Tick only the matches', count: o.matches, action: { kind: 'matches', checked: true, only: true } },
      { label: 'Untick the matches', count: o.matches, action: { kind: 'matches', checked: false } }
    ]
  })
  groups.push({
    label: groups.length ? 'Every value' : undefined,
    actions: [
      { label: 'Tick all', count: o.total, action: { kind: 'all', checked: true } },
      { label: 'Untick all', count: o.total, action: { kind: 'all', checked: false } },
      ...o.matches === undefined ? [{ label: 'Invert ticks', action: { kind: 'invert' } as const }] : []
    ]
  })
  return groups
}
