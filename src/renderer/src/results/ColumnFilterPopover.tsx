import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DistinctValue, ResultsDistinctTickParams } from '../../../shared/contracts'
import { codiconClass } from '../../../shared/icons'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { scrollCap } from '../grid/scroll'
import { trapFocus } from '../trap-focus'
import { useWorkbench } from '../core/WorkbenchContext'
import type { GestureEvent } from '../core/gestures'
import { addRange, blocksToDrop, checklistActions, checklistCondition, clampPopoverSize, columnFilterKind, isSelected, keepsSide, listWindow, maxListSpace, popoverBounds, popoverNaturalHeight, popoverPlace, popoverRoom, rowAtTop, rowsInView, scrollForRowAtTop, scrollToShow, selectedCount, selectionTicks, selectRange, toggleRow, type ChecklistAction, type ColumnCondition, type PopoverPlace, type RowSelection } from './column-filter'
import type { DistinctList } from './ResultClient'
import type { EntryKey, ResultsService } from './ResultsService'
import { formatCount, plural } from './status'

/** The column the popover filters, and its band (`GridView.filterAnchor`): the popover opens beside it, never over it. */
export interface ColumnFilterTarget { readonly column: number; readonly anchor: DOMRect }
/** The popover's size (queryResults.grid.filterPopupWidth and filterPopupHeight); a height of 0 fits its contents. */
export interface ColumnFilterSize { readonly width: number; readonly height: number }

/** The custom conditions beside the checklist (`list`): one value, not it, between two, NULL, not NULL. */
export type Condition = 'list' | 'equals' | 'notEquals' | 'between' | 'null' | 'notNull'
const conditions: readonly (readonly [Condition, string])[] = [
  ['list', 'Values ticked in the list'], ['equals', 'Equals'], ['notEquals', 'Does not equal'], ['between', 'Between'], ['null', 'Is NULL'], ['notNull', 'Is not NULL']
]
type Load = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly list: DistinctList }
interface Ticks { readonly checked: number; readonly nullChecked: boolean }

/** The width before the setting is read (the setting's default). */
const defaultSize: ColumnFilterSize = { width: 440, height: 0 }
/** A search asks the backend once typing pauses; clearing it shows every value at once. */
const searchPauseMs = 200
/** Values one window read asks for, and rows drawn past each edge of the list's viewport. */
const blockSize = 128
const overscan = 8
/** Blocks kept while scrolling (4,096 values): the farthest from view go first, so a long scroll holds no more. */
const maxBlocks = 32
/** The list's row height before the theme's `--varia-row` is read. */
const fallbackRow = 22
/** The list's top padding, which the rows start below. */
const padOf = (element: HTMLElement) => parseFloat((element.ownerDocument.defaultView ?? window).getComputedStyle(element).paddingTop) || 0
const shown = (value: DistinctValue) => value.text === '' ? '(empty)' : value.text
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback

/** What a row of the checklist's listbox needs to be one of its options: its id (the listbox's active descendant), its
 *  place among all the rows (the list draws only some), whether it is the active row, and whether it is selected. */
interface RowPlace { readonly id: string; readonly row: number; readonly rows: number; readonly active: boolean; readonly selected: boolean; readonly top: number; readonly height: number }
/** A press on a row makes it the active one and keeps the focus on the listbox (the box drawn inside a row takes none);
 *  the grid's Add to Selection gesture (Ctrl, ⌘) adds it to the selection or takes it out, Extend Selection (Shift)
 *  selects the rows from the anchor. */
type RowPick = (row: number, event: GestureEvent) => void

/** One checklist row: an option of the listbox at its place, its tick as `aria-checked` and the highlight as
 *  `aria-selected`. A plain click ticks it, as Space does the selection; Ctrl and Shift clicks only select. The box inside
 *  is drawn only. */
function Row({ place, label, checked, disabled, className, onToggle, onPick, children }: {
  place: RowPlace; label: string; checked: boolean; disabled: boolean; className: string; onToggle(event: GestureEvent): void; onPick: RowPick; children: ReactNode
}) {
  return <div id={place.id} role="option" aria-checked={checked} aria-selected={place.selected} aria-disabled={disabled || undefined} aria-posinset={place.row + 1} aria-setsize={place.rows} aria-label={label}
    className={'column-filter-item ' + className + (place.active ? ' active' : '') + (place.selected ? ' selected' : '')} style={{ top: place.top, height: place.height }}
    onMouseDown={event => { event.preventDefault(); onPick(place.row, event) }} onClick={event => { if (!disabled) onToggle(event) }}>
    <input type="checkbox" tabIndex={-1} aria-hidden="true" disabled={disabled} checked={checked} readOnly />
    {children}
  </div>
}

/** Two places of a row are the same place (a new object each render). */
const samePlace = (a: RowPlace, b: RowPlace) => a.id === b.id && a.row === b.row && a.rows === b.rows && a.active === b.active && a.selected === b.selected && a.top === b.top && a.height === b.height

/** One value of the checklist; a tick or a move of the active row re-renders only the entries it changes. */
const Item = memo(function Item({ value, place, checked, disabled, onToggle, onPick }: { value: DistinctValue; place: RowPlace; checked: boolean; disabled: boolean; onToggle(value: DistinctValue, event: GestureEvent): void; onPick: RowPick }) {
  return <Row place={place} label={`${shown(value)} (${formatCount(value.count)})`} checked={checked} disabled={disabled} className={value.text === '' ? 'empty' : ''} onToggle={event => onToggle(value, event)} onPick={onPick}>
    <bdi className="column-filter-text" title={value.text}>{shown(value)}</bdi><span className="column-filter-count" aria-hidden="true">{formatCount(value.count)}</span>
  </Row>
}, (a, b) => a.value === b.value && a.checked === b.checked && a.disabled === b.disabled && a.onToggle === b.onToggle && a.onPick === b.onPick && samePlace(a.place, b.place))

/**
 * What a funnel's popover filters: a column's distinct values as a snapshot (`DistinctList`), and the grid's filter it
 * applies. A results grid's source is the backend's snapshot of the result (results.distinct) and ResultsService's view
 * filters (`resultsFilterSource`); a live grid's is the live source's facets, filtered by the source's args (LiveGridPane).
 */
export interface ColumnFilterSource {
  columnValues(column: number, o: { signal?: AbortSignal }): Promise<DistinctList>
  /** OK's condition, or `clear`; false when it does not fit, or why (the popover stays open and says so). */
  apply(column: number, condition: ColumnCondition): boolean | string
  /** The column's own range limits the values Equals and Between can choose. */
  ranged?(column: number): boolean
  /** The conditions it can filter by; all of them by default. */
  readonly conditions?: readonly Condition[]
  /** What the list calls NULL's entry ("NULL"; a live source's blanks are "(Blanks)"). */
  readonly nullText?: string
  /** Its own words for some conditions (a live source's "Is blank" for "Is NULL"). */
  readonly conditionLabels?: Partial<Record<Condition, string>>
  /** A note under the list (a live source lists only its most frequent values). */
  note?(column: number): string | undefined
}

/** A results grid's funnel source: the backend's distinct snapshot of the result and ResultsService's view filters. */
export function resultsFilterSource(results: Pick<ResultsService, 'columnValues' | 'applyColumnFilter' | 'sortOf'>, tabId: string, entry: EntryKey): ColumnFilterSource {
  return {
    columnValues: (column, o) => results.columnValues(tabId, entry, column, o),
    apply: (column, condition) => results.applyColumnFilter(tabId, entry, column, condition),
    ranged: column => !!results.sortOf(tabId, entry)?.filters.some(item => columnFilterKind(item.filter, column) === 'between')
  }
}

/**
 * The header funnel's popover (results.distinct, or a live source's facets): the column's distinct values with their counts as a checklist with a
 * search, an action list beside it (`checklistActions`: tick or untick every value, a search's matches or the selected
 * rows), NULL as an entry of its own, and custom conditions. Rows are selected apart from their ticks (Ctrl and Shift
 * clicks, Shift with the arrows, Ctrl+A), and Space ticks the selection. The values stay in the backend as a snapshot,
 * however many: the list draws only the rows in view (a fixed row height) and reads windows of them as it scrolls, a
 * search narrows the snapshot in the backend, and the ticks live there too, so Tick all over a million values, or a
 * selection Shift+End made, is one request. OK filters the grid by the snapshot (a `groups` filter, which the grid then keeps) or by the custom
 * condition (ResultsService.applyColumnFilter, replacing the column's filter of the same kind); Cancel, Escape or a press
 * outside closes it unchanged and closes the snapshot. It lists the values of the rows the grid's other filters keep, so
 * values the column's own filter dropped can be ticked again.
 */
export function ColumnFilterPopover({ source, columnName, target, filtered, grid, size = defaultSize, onResized, onClose }: {
  source: ColumnFilterSource; columnName: string; target: ColumnFilterTarget; filtered: boolean
  /** The grid it filters: the popover opens in that grid's window (the main one, or a popout's). */
  grid: HTMLElement
  /** Its remembered size; a drag of its corner grip shows the new size at once and hands it to `onResized` when it ends. */
  size?: ColumnFilterSize
  onResized?(size: ColumnFilterSize): void
  onClose(refocus?: boolean): void
}) {
  const nullText = source.nullText ?? 'NULL', titleId = useId(), rowId = useId()
  const { gestures } = useWorkbench()
  const offered = (source.conditions ? conditions.filter(([value]) => source.conditions!.includes(value)) : conditions).map(([value, label]) => [value, source.conditionLabels?.[value] ?? label] as const)
  const { column, anchor } = target
  /** The size shown: the remembered one, or the one a drag of the grip is setting. */
  const [sized, setSizedState] = useState<ColumnFilterSize>(size), sizedNow = useRef(size)
  const setSized = (next: ColumnFilterSize) => { sizedNow.current = next; setSizedState(next) }
  const resizing = useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined)
  /** The side a drag of the grip started on, kept from then on so the popover never jumps across the column as it grows. */
  const keptSide = useRef<PopoverPlace['side'] | undefined>(undefined)
  useEffect(() => { if (!resizing.current) { sizedNow.current = size; setSizedState(size) } }, [size.width, size.height])
  const card = useRef<HTMLFormElement>(null), searchBox = useRef<HTMLInputElement>(null), viewport = useRef<HTMLDivElement>(null)
  const [order, setOrder] = useState<'count' | 'value'>('count')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [search, setSearch] = useState('')
  const [needle, setNeedle] = useState('')
  const [condition, setCondition] = useState<Condition>('list')
  const [first, setFirst] = useState<DistinctValue | undefined>()
  const [second, setSecond] = useState<DistinctValue | undefined>()
  const [error, setError] = useState<string | undefined>()
  /** The snapshot's ticks, kept in a ref as well so OK reads them once the last tick is answered. */
  const [ticks, setTicksState] = useState<Ticks>({ checked: 0, nullChecked: true }), ticksNow = useRef(ticks)
  const setTicks = useCallback((next: Ticks) => { ticksNow.current = next; setTicksState(next) }, [])
  /** Ticks go one at a time, in order; reads wait while any is unanswered (`ticking`), since one could cross it. */
  const chain = useRef<Promise<void>>(Promise.resolve()), epoch = useRef(0)
  const [ticking, setTicking] = useState(0)
  /** The snapshot passed to the grid's filter (OK): the grid closes it from then on. */
  const handed = useRef(false)
  /** False once the popover is gone: an OK still waiting on its ticks then applies nothing (its snapshot was closed). */
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  /** A tick failed: the ticks shown are a guess until the snapshot's own are read again. */
  const ticksStale = useRef(false)
  const list = load.status === 'ready' ? load.list : undefined
  const summary = list?.summary

  // The snapshot, built once; closed with the popover unless OK handed it to the grid.
  useEffect(() => {
    const abort = new AbortController()
    let opened: DistinctList | undefined
    handed.current = false
    setLoad({ status: 'loading' })
    source.columnValues(column, { signal: abort.signal }).then(answer => {
      if (abort.signal.aborted) { void answer.close(); return }
      opened = answer
      setTicks({ checked: answer.summary.checked, nullChecked: answer.summary.nullsChecked })
      setLoad({ status: 'ready', list: answer })
    }, (failure: unknown) => {
      if (!abort.signal.aborted) setLoad({ status: 'error', message: message(failure, 'The column\'s values could not be listed.') })
    })
    return () => {
      abort.abort()
      if (opened && !handed.current) void opened.close()
    }
  }, [source, column, setTicks])

  // A search narrows the list in the backend once typing pauses.
  useEffect(() => {
    const text = search.trim().slice(0, wire.search.maxText)
    if (!text) { setNeedle(''); return }
    const timer = setTimeout(() => setNeedle(text), searchPauseMs)
    return () => clearTimeout(timer)
  }, [search])

  // Windows of the list in this order and search, by block; a new order or search starts again from the top.
  const blocks = useRef(new Map<number, readonly DistinctValue[]>()), reading = useRef(new Map<number, AbortController>())
  const [version, setVersion] = useState(0)
  const [total, setTotal] = useState<number | undefined>()
  const [readError, setReadError] = useState<string | undefined>()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(0)
  const [listPad, setListPad] = useState(0)
  const [maxSpace, setMaxSpace] = useState(maxListSpace)
  const [rowHeight, setRowHeight] = useState(fallbackRow)
  /** The listbox's active row (NULL's first when it is listed): the arrow keys move it and Space ticks it. Focus stays
   *  on the listbox (`aria-activedescendant`), so a row scrolled out of the rows drawn takes no focus with it. */
  const [active, setActive] = useState(0)
  /** The selected rows (`RowSelection`) and the row Shift extends them from. */
  const [selection, setSelection] = useState<RowSelection>([]), selectFrom = useRef(0)
  /** A press on a row is choosing the selection itself: focusing the list then selects nothing for it. */
  const picking = useRef(false)
  /** The action list's highlighted action, among all its actions. */
  const [act, setAct] = useState(0)
  const actionsBox = useRef<HTMLDivElement>(null)
  /** Typing in a list goes on in the search, with the caret at its end. */
  const caretToEnd = useRef(false)
  const keyAbort = useRef<AbortController | undefined>(undefined)
  useLayoutEffect(() => {
    keyAbort.current?.abort()
    keyAbort.current = new AbortController()
    blocks.current = new Map()
    for (const read of reading.current.values()) read.abort()
    reading.current = new Map()
    setTotal(needle ? undefined : summary?.distinct)
    setReadError(undefined)
    setScrollTop(0)
    setActive(0)
    setSelection([])
    selectFrom.current = 0
    keepTop.current = undefined
    if (viewport.current) viewport.current.scrollTop = 0
    setVersion(value => value + 1)
  }, [list, summary, order, needle])
  useEffect(() => () => { keyAbort.current?.abort(); for (const read of reading.current.values()) read.abort() }, [])

  // The viewport's height and the theme's row height, measured in the grid's own window.
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const view = element.ownerDocument.defaultView ?? window
    const row = parseFloat(view.getComputedStyle(element).getPropertyValue('--varia-row'))
    if (row > 0) setRowHeight(row)
    const measure = () => { setViewHeight(element.clientHeight); setListPad(padOf(element)) }
    measure()
    const observer = new view.ResizeObserver(measure)
    observer.observe(element)
    // Chromium clamps layout near 33.5 million device pixels, so the space a list may lay out shrinks as the pixel ratio
    // (display scaling and zoom) grows; the grid's cap, watched as the grid watches it. A new cap changes what a scroll
    // position shows, so the row at the top stays there (the layout effect on maxSpace below).
    let media: MediaQueryList | undefined
    const cap = () => Math.min(maxListSpace, scrollCap(view.devicePixelRatio))
    const watchRatio = () => {
      media = view.matchMedia?.(`(resolution: ${view.devicePixelRatio}dppx)`)
      media?.addEventListener('change', onRatio, { once: true })
    }
    const onRatio = () => {
      // The scroll position drawn at the old cap, not the element's: at the new ratio Chromium may already have clamped it.
      const next = cap(), now = geometry.current
      if (next !== now.maxSpace && now.rows * now.rowHeight > Math.min(next, now.maxSpace)) keepTop.current = rowAtTop(now)
      setMaxSpace(next)
      watchRatio()
    }
    setMaxSpace(cap())
    watchRatio()
    return () => { observer.disconnect(); media?.removeEventListener('change', onRatio) }
  }, [])

  const showNull = !!summary && summary.nulls > 0 && (!needle || nullText.toLowerCase().includes(needle.toLowerCase()))
  const nullRows = showNull ? 1 : 0
  const valueRows = total ?? 0
  const win = listWindow({ scrollTop, viewHeight, rowHeight, rows: nullRows + valueRows, overscan, pad: listPad, maxSpace })
  const firstRow = win.first, lastRow = win.last
  const firstBlock = Math.floor(Math.max(0, firstRow - nullRows) / blockSize)
  const lastBlock = Math.floor(Math.max(0, lastRow - nullRows - 1) / blockSize)
  const inView = useRef({ firstBlock, lastBlock })
  inView.current = { firstBlock, lastBlock }
  /** The list's geometry as last drawn, and the row a new scroll cap keeps at the top. */
  const geometry = useRef({ rows: 0, rowHeight, viewHeight, pad: listPad, maxSpace, scrollTop })
  geometry.current = { rows: nullRows + valueRows, rowHeight, viewHeight, pad: listPad, maxSpace, scrollTop }
  /** The fractional row at the view's top to keep there across a new scroll cap (only a mapped list's rows move). */
  const keepTop = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    const element = viewport.current, row = keepTop.current
    keepTop.current = undefined
    if (!element || row === undefined) return
    const now = geometry.current
    element.scrollTop = scrollForRowAtTop({ ...now, row, maxSpace })
    setScrollTop(element.scrollTop)
  }, [maxSpace])

  // Reads the blocks in view that it lacks, and gives up those scrolled away from, so a fast scroll never queues reads of
  // rows no longer shown ahead of those in view; an answer read while a tick was on its way is read again after it.
  useEffect(() => {
    const signal = keyAbort.current?.signal
    if (!list || !signal) return
    const own = reading.current
    for (const [block, read] of own) if (block < firstBlock - 1 || block > lastBlock + 1) { read.abort(); own.delete(block) }
    if (ticking > 0) return
    for (let block = firstBlock; block <= lastBlock; block++) {
      if (blocks.current.has(block) || own.has(block) || (total !== undefined && block * blockSize >= total) || (total === undefined && block > 0)) continue
      const read = new AbortController()
      own.set(block, read)
      const sent = epoch.current
      list.read({ order, offset: block * blockSize, count: blockSize, ...needle ? { search: needle } : {}, signal: read.signal }).then(answer => {
        if (signal.aborted || read.signal.aborted || reading.current !== own) return
        own.delete(block)
        setReadError(undefined)
        if (epoch.current === sent) {
          blocks.current.set(block, answer.values)
          for (const drop of blocksToDrop(blocks.current.keys(), inView.current.firstBlock, inView.current.lastBlock, maxBlocks)) blocks.current.delete(drop)
          setTotal(answer.total)
          ticksStale.current = false
          setTicks({ checked: answer.checked, nullChecked: answer.nullsChecked })
        }
        setVersion(value => value + 1)
      }, (failure: unknown) => {
        if (signal.aborted || read.signal.aborted || reading.current !== own) return
        own.delete(block)
        setReadError(message(failure, 'The column\'s values could not be listed.'))
      })
    }
  }, [list, order, needle, total, firstBlock, lastBlock, ticking, version, setTicks])

  /** Sends a tick after those before it; a failure reads the list again, which carries the snapshot's true ticks. */
  const send = useCallback((tick: Omit<ResultsDistinctTickParams, 'resultId' | 'snapshotId'>, reread = false) => {
    if (!list) return
    epoch.current++
    setTicking(value => value + 1)
    chain.current = chain.current.then(() => list.tick(tick)).then(answer => {
      setTicks({ checked: answer.checked, nullChecked: answer.nullsChecked })
      // A toggle over rows not read decided in the backend: the rows shown are read again with their ticks.
      if (reread) { blocks.current = new Map(); setVersion(value => value + 1) }
    }, (failure: unknown) => {
      setError(message(failure, 'The value could not be ticked.'))
      ticksStale.current = true
      blocks.current = new Map()
      setVersion(value => value + 1)
    }).finally(() => setTicking(value => value - 1))
  }, [list, setTicks])

  /** Shows a tick at once, in every block that holds the values it changes; `change` has each value and its list row. */
  const patch = (change: (value: DistinctValue, row: number) => boolean | undefined) => {
    const next = new Map<number, readonly DistinctValue[]>()
    for (const [block, values] of blocks.current) next.set(block, values.map((value, at) => { const checked = change(value, nullRows + block * blockSize + at); return checked === undefined || checked === value.checked ? value : { ...value, checked } }))
    blocks.current = next
    setVersion(value => value + 1)
  }
  const toggle = useCallback((value: DistinctValue) => {
    const checked = !value.checked
    patch(item => item.group === value.group ? checked : undefined)
    setTicks({ ...ticksNow.current, checked: ticksNow.current.checked + (checked ? 1 : -1) })
    send({ checked, groups: [value.group] })
  }, [send, setTicks])
  const toggleNull = () => {
    const checked = !ticksNow.current.nullChecked
    setTicks({ ...ticksNow.current, nullChecked: checked })
    send({ checked, nulls: checked })
  }
  /** Ticks or unticks the selected rows (the active row when none is), or, with `checked` undefined, toggles them as Space
   *  does: all ticked when any is unticked, else all unticked. Rows not read decide in the backend (`toggle`). */
  const tickSelection = (checked: boolean | undefined) => {
    if (!listing || !summary || listRows === 0) return
    const chosen = selection.length ? selection : selectRange(active, active)
    const { nulls, ranges } = selectionTicks(chosen, nullRows)
    // One row: tick it by its group, as a click does.
    if (checked === undefined && selectedCount(chosen) === 1) {
      const row = chosen[0][0]
      moveTo(row)
      if (row < nullRows) return toggleNull()
      const value = blocks.current.get(Math.floor((row - nullRows) / blockSize))?.[(row - nullRows) % blockSize]
      if (value) return toggle(value)
      // Not read yet (End, then Space before its block arrives): the backend decides, and the rows are read again.
      return send({ checked: true, order, ...needle ? { search: needle } : {}, ranges: [[row - nullRows, 1]], toggle: true }, true)
    }
    // The selected values read so far: how many, and how many are ticked.
    let seen = 0, seenTicked = 0
    for (const [block, values] of blocks.current) values.forEach((value, at) => {
      if (!isSelected(chosen, nullRows + block * blockSize + at)) return
      seen++
      if (value.checked) seenTicked++
    })
    const values = ranges.reduce((sum, [, count]) => sum + count, 0), allSeen = seen === values
    let on = checked
    if (on === undefined) on = (nulls && !ticksNow.current.nullChecked) || seenTicked < seen ? true : allSeen ? false : undefined
    const where = { order, ...needle ? { search: needle } : {} }
    if (on === undefined) return send({ checked: true, ...where, ranges, toggle: true, ...nulls ? { nulls: true } : {} }, true)
    const set = on
    patch((_, row) => isSelected(chosen, row) ? set : undefined)
    // The note's count moves at once when every selected value was read; otherwise the answer sets it.
    const now = ticksNow.current
    setTicks({ checked: allSeen ? now.checked + (set ? seen - seenTicked : -seenTicked) : now.checked, nullChecked: nulls ? set : now.nullChecked })
    if (ranges.length) send({ checked: set, ...where, ranges, ...nulls ? { nulls: set } : {} })
    else if (nulls) send({ checked: set, nulls: set })
  }
  /** Runs an entry of the action list. Every value includes NULL; a search's matches include it when it is listed. */
  const runAction = (action: ChecklistAction) => {
    if (!listing || !summary) return
    setError(undefined)
    const hasNull = summary.nulls > 0, now = ticksNow.current
    if (action.kind === 'invert') {
      patch(value => !value.checked)
      setTicks({ checked: summary.distinct - now.checked, nullChecked: hasNull ? !now.nullChecked : now.nullChecked })
      return send({ checked: true, invert: true, ...hasNull ? { nulls: !now.nullChecked } : {} })
    }
    const everything = (checked: boolean) => {
      patch(() => checked)
      setTicks({ checked: checked ? summary.distinct : 0, nullChecked: hasNull ? checked : ticksNow.current.nullChecked })
      send({ checked, all: true, ...hasNull ? { nulls: checked } : {} })
    }
    if (action.kind === 'all') return everything(action.checked)
    if (action.only) everything(false)
    if (action.kind === 'selected') return tickSelection(action.checked)
    if (!needle) return
    patch(() => action.checked)
    // After unticking everything, the matches are exactly what is ticked; otherwise the answer sets the count.
    setTicks({ checked: action.only && total !== undefined ? total : ticksNow.current.checked, nullChecked: showNull ? action.checked : ticksNow.current.nullChecked })
    send({ checked: action.checked, all: true, search: needle, ...showNull ? { nulls: action.checked } : {} })
  }

  // Equals and Between choose among the values in value order, the first window of a search's matches.
  const choosing = condition === 'equals' || condition === 'notEquals' || condition === 'between'
  const [choices, setChoices] = useState<{ values: readonly DistinctValue[]; total: number } | undefined>()
  useEffect(() => {
    if (!list || !choosing) return
    const abort = new AbortController()
    list.read({ order: 'value', offset: 0, count: wire.distinct.maxWindow, ...needle ? { search: needle } : {}, signal: abort.signal }).then(answer => {
      if (!abort.signal.aborted) setChoices({ values: answer.values, total: answer.total })
    }, (failure: unknown) => { if (!abort.signal.aborted) setError(message(failure, 'The column\'s values could not be listed.')) })
    return () => abort.abort()
  }, [list, choosing, needle])

  useLayoutEffect(() => { searchBox.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const doc = grid.ownerDocument
    // A press on one of this grid's funnels is the grid's to answer: its own column's closes, another's opens that one.
    const press = (event: PointerEvent) => {
      const at = event.target as Element | null
      if (card.current?.contains(at) || (grid.contains(at) && at?.closest('.rg-cf'))) return
      onClose(false)
    }
    doc.addEventListener('pointerdown', press, true)
    return () => doc.removeEventListener('pointerdown', press, true)
  }, [grid, onClose])

  /** OK is on its way (waiting for the ticks before it): Enter held down or OK pressed again applies nothing more. */
  const applying = useRef(false)
  const apply = async () => {
    if (applying.current) return
    applying.current = true
    try { await applyNow() } finally { applying.current = false }
  }
  const applyNow = async () => {
    let chosen: ColumnCondition | undefined
    if (condition === 'list') {
      if (!list || !summary) return
      // The last tick decides what OK filters by; after a failed one, the snapshot's own ticks do.
      await chain.current
      if (!alive.current) return
      if (ticksStale.current) {
        try {
          const answer = await list.read({ order: 'value', offset: 0, count: 1 })
          ticksStale.current = false
          setTicks({ checked: answer.checked, nullChecked: answer.nullsChecked })
        } catch (failure) {
          if (alive.current) setError(message(failure, 'The column\'s values could not be listed.'))
          return
        }
        if (!alive.current) return
      }
      const outcome = checklistCondition({ list, checked: ticksNow.current.checked, distinct: summary.distinct, hasNull: summary.nulls > 0, nullChecked: ticksNow.current.nullChecked })
      if ('error' in outcome) return setError(outcome.error)
      chosen = outcome.condition
    } else if (condition === 'null' || condition === 'notNull') chosen = { kind: condition }
    else if (!first || (condition === 'between' && !second)) return setError(condition === 'between' ? 'Choose the lowest and the highest value.' : 'Choose a value.')
    else chosen = condition === 'between' ? { kind: 'between', rows: [first.row, second!.row] } : { kind: condition, row: first.row }
    const applied = source.apply(column, chosen)
    if (applied !== true) { if (typeof applied === 'string') setError(applied); return }
    if (chosen.kind === 'list') handed.current = true
    onClose()
  }
  const clear = () => { if (source.apply(column, { kind: 'clear' }) === true) onClose() }

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    // Ctrl+Enter is OK from anywhere in the popover (Enter is OK in the values list).
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.defaultPrevented) { event.preventDefault(); void apply() }
  }

  const valueSelect = (label: string, value: DistinctValue | undefined, set: (value: DistinctValue | undefined) => void) => {
    const options = [...value && !choices?.values.some(choice => choice.group === value.group) ? [value] : [], ...choices?.values ?? []]
    return <select aria-label={label} value={value?.group ?? ''} onChange={event => { setError(undefined); set(options.find(choice => String(choice.group) === event.target.value)) }}>
      <option value="">Choose a value…</option>
      {options.map(choice => <option key={choice.group} value={choice.group}>{shown(choice)}</option>)}
    </select>
  }

  // The rows in view: NULL first when it is listed, then the values, a placeholder for those still being read.
  const listing = condition === 'list'
  const rows = useMemo(() => {
    const drawn: { index: number; value?: DistinctValue }[] = []
    for (let row = firstRow; row < lastRow; row++) {
      if (row < nullRows) { drawn.push({ index: row }); continue }
      const at = row - nullRows, values = blocks.current.get(Math.floor(at / blockSize))
      drawn.push({ index: row, value: values?.[at % blockSize] })
    }
    return drawn
  }, [firstRow, lastRow, nullRows, version])

  // Beside the column, not over it (popoverPlace), at its remembered size; measured in the grid's own window.
  const view = grid.ownerDocument.defaultView ?? window, screen = { width: view.innerWidth, height: view.innerHeight }
  const box = clampPopoverSize(sized, screen)
  const at = popoverPlace({ band: anchor, width: box.width, height: box.height || popoverNaturalHeight, view: screen, ...keptSide.current ? { side: keptSide.current } : {} })
  const place = { left: at.left, width: at.width, maxHeight: at.maxHeight, ...at.top !== undefined ? { top: at.top } : { bottom: at.bottom }, ...box.height ? { height: Math.min(box.height, at.maxHeight) } : {} }
  // The grip sits at the corner away from the column (and from the band above it), so dragging it never covers the column.
  const gripX = at.side === 'left' ? -1 : 1, gripY = at.side === 'above' ? -1 : 1
  const gripDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !card.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const shown = card.current.getBoundingClientRect()
    resizing.current = { x: event.clientX, y: event.clientY, width: shown.width, height: shown.height }
    if (!at.over && keepsSide(anchor, screen, at.side)) keptSide.current = at.side
  }
  const gripMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizing.current
    if (!start) return
    // Within the room on its side, so the size saved is the size shown, but never below the settings' least (a narrow
    // window shows it smaller all the same).
    const room = keptSide.current ? popoverRoom(anchor, screen, keptSide.current) : screen
    const next = clampPopoverSize({ width: start.width + (event.clientX - start.x) * gripX, height: Math.max(1, start.height + (event.clientY - start.y) * gripY) }, screen)
    setSized({
      width: Math.max(popoverBounds.minWidth, Math.min(next.width, Math.floor(room.width))),
      height: Math.max(popoverBounds.minHeight, Math.min(next.height, Math.floor(room.height)))
    })
  }
  const gripUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing.current) return
    resizing.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onResized?.(sizedNow.current)
  }
  // The column's own range limits the values listed, so Equals and Between can choose only within it.
  const ranged = !!source.ranged?.(column)
  const sourceNote = source.note?.(column)
  const selectedRows = selectedCount(selection)
  const note = !summary ? undefined
    : (needle && total !== undefined ? `${formatCount(total)} of ${formatCount(summary.distinct)} ${plural(summary.distinct, 'value')} match. ${formatCount(ticks.checked)} ticked`
      : `${formatCount(summary.distinct)} ${plural(summary.distinct, 'value')} in ${formatCount(summary.rows)} ${plural(summary.rows, 'row')}. ${formatCount(ticks.checked)} ticked`)
      + (selectedRows > 1 ? `, ${formatCount(selectedRows)} selected.` : '.')
  const empty = !!summary && total === 0 && !showNull
  const listRows = nullRows + valueRows

  /** Makes `row` the active row and scrolls the list by the least that shows it. */
  const moveTo = (row: number) => {
    const element = viewport.current
    if (listRows === 0) return
    const next = Math.max(0, Math.min(listRows - 1, row))
    setActive(next)
    if (!element) return
    const scroll = scrollToShow({ row: next, rows: listRows, rowHeight, viewHeight: element.clientHeight || viewHeight, scrollTop: element.scrollTop, pad: padOf(element), maxSpace })
    if (scroll === undefined) return
    element.scrollTop = scroll
    setScrollTop(element.scrollTop)
  }
  /** Focus entering the list (Down from the search, Tab) with its active row scrolled out of view makes the first row in
   *  view the active one, so a screen reader has an option to announce. */
  const listFocused = () => {
    const element = viewport.current
    if (!element || listRows === 0 || !summary) return
    const inView = rowsInView({ rows: listRows, rowHeight, viewHeight: element.clientHeight || viewHeight, scrollTop: element.scrollTop, pad: padOf(element), maxSpace })
    const moved = active < inView.first || active > inView.last, row = moved ? inView.first : active
    setActive(row)
    // Arriving with nothing selected, or with the active row scrolled away, selects the active row, so Space and the
    // selection's actions act on what is in view.
    if (!picking.current && (moved || selection.length === 0)) { setSelection(selectRange(row, row)); selectFrom.current = row }
  }
  /** A key typed in a list goes on in the search. */
  const typeIntoSearch = (key: string) => {
    if (condition === 'null' || condition === 'notNull') return
    caretToEnd.current = true
    setSearch(text => (text + key).slice(0, wire.search.maxText))
    searchBox.current?.focus({ preventScroll: true })
  }
  const typed = (event: KeyboardEvent) => event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
  /**
   * The values list's keys: the arrows, Page Up and Down, Home and End move the active row and select it; with Shift they
   * select from the anchor, with Ctrl they only move. Space ticks the selection, Ctrl+Space adds the active row to it or
   * takes it out, Ctrl+A selects every row listed. Left goes to the action list, Up from the first row to the search,
   * typing to the search; Enter is OK.
   */
  const listKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey) return
    const mod = event.ctrlKey || event.metaKey
    const page = Math.max(1, Math.floor((viewport.current?.clientHeight || viewHeight) / rowHeight) - 1)
    const moves: Partial<Record<string, number>> = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + page, PageUp: active - page, Home: 0, End: listRows - 1 }
    const target = moves[event.key]
    if (target !== undefined) {
      event.preventDefault()
      if (listRows === 0) return
      if (event.key === 'ArrowUp' && active === 0 && !event.shiftKey && !mod) { searchBox.current?.focus({ preventScroll: true }); return }
      const next = Math.max(0, Math.min(listRows - 1, target))
      moveTo(next)
      if (event.shiftKey) setSelection(selectRange(selectFrom.current, next))
      else if (!mod) { setSelection(selectRange(next, next)); selectFrom.current = next }
    } else if (event.key === ' ') {
      event.preventDefault()
      if (!mod) tickSelection(undefined)
      else if (listRows > 0) { setSelection(now => toggleRow(now, active)); selectFrom.current = active }
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      if (listRows > 0) setSelection(selectRange(0, listRows - 1))
    } else if (mod) return
    else if (event.key === 'ArrowLeft') { event.preventDefault(); actionsBox.current?.focus({ preventScroll: true }) }
    else if (event.key === 'Enter') { event.preventDefault(); void apply() }
    else if (typed(event)) { event.preventDefault(); typeIntoSearch(event.key) }
  }
  // Focus first: focusing the list from elsewhere runs listFocused, which may pick the first row in view; the clicked row wins.
  const pick = useCallback<RowPick>((row, event) => {
    const how = { add: gestures.matches('grid.addToSelection', event), range: gestures.matches('grid.extendSelection', event) }
    picking.current = true
    viewport.current?.focus({ preventScroll: true })
    picking.current = false
    setActive(row)
    setSelection(now => how.range ? (how.add ? addRange(now, selectFrom.current, row) : selectRange(selectFrom.current, row)) : how.add ? toggleRow(now, row) : selectRange(row, row))
    if (!how.range) selectFrom.current = row
  }, [gestures])
  /** A click that only selects (Add to Selection, Extend Selection) ticks nothing; a plain click ticks its row. */
  const plainClick = useCallback((event: GestureEvent) => !gestures.matches('grid.addToSelection', event) && !gestures.matches('grid.extendSelection', event), [gestures])
  const clickToggle = useCallback((value: DistinctValue, event: GestureEvent) => { if (plainClick(event)) toggle(value) }, [plainClick, toggle])

  // The action list: by context (checklistActions), one highlighted action that Enter or Space runs.
  const matches = needle ? (total ?? 0) + nullRows : undefined
  const everyValue = summary ? summary.distinct + (summary.nulls > 0 ? 1 : 0) : 0
  const actionGroups = checklistActions({ selected: selectedCount(selection), matches, total: everyValue })
  const actionList = actionGroups.flatMap(group => group.actions)
  const actHere = Math.max(0, Math.min(actionList.length - 1, act))
  const acting = listing && !!summary
  const runAt = (at: number) => { const item = actionList[at]; if (item) runAction(item.action) }
  /** The action list's keys: Up and Down, Home and End move the highlight (Up from the first goes to the search); Enter or
   *  Space runs it and the focus stays; Right goes back to the values; typing goes to the search. */
  const actionsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const last = actionList.length - 1
    if (event.key === 'ArrowDown') { event.preventDefault(); setAct(Math.min(last, actHere + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (actHere === 0) searchBox.current?.focus({ preventScroll: true }); else setAct(actHere - 1) }
    else if (event.key === 'Home') { event.preventDefault(); setAct(0) }
    else if (event.key === 'End') { event.preventDefault(); setAct(last) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (summary && listRows > 0) viewport.current?.focus({ preventScroll: true }) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (acting) runAt(actHere) }
    else if (typed(event)) { event.preventDefault(); typeIntoSearch(event.key) }
  }
  /** Scrolls the highlighted action into view while the action list has the focus (it stays on the list, which does not
   *  scroll for its active descendant): as the arrows move it, and when the focus arrives on it. */
  const showAction = () => {
    const box = actionsBox.current
    if (!box || box.ownerDocument.activeElement !== box) return
    box.ownerDocument.getElementById(`${rowId}-act-${actHere}`)?.scrollIntoView?.({ block: 'nearest' })
  }
  useLayoutEffect(showAction, [actHere, rowId])
  useLayoutEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const box = searchBox.current
    if (box) box.setSelectionRange(box.value.length, box.value.length)
  }, [search])

  return createPortal(<form ref={card} className={'column-filter' + (box.height ? ' sized' : '')} role="dialog" aria-labelledby={titleId} style={place} data-side={at.side}
    onKeyDown={keyDown} onSubmit={event => { event.preventDefault(); void apply() }}>
    <div className="column-filter-head">
      <span className={codiconClass('filter')} aria-hidden="true" />
      <h2 id={titleId}>Filter <bdi>{columnName}</bdi></h2>
      <select aria-label="Order values by" value={order} onChange={event => setOrder(event.target.value as 'count' | 'value')}>
        <option value="count">Most frequent</option>
        <option value="value">Value</option>
      </select>
    </div>
    <div className="column-filter-search">
      <span className={codiconClass('search')} aria-hidden="true" />
      <input ref={searchBox} type="search" aria-label="Search values" placeholder="Search values" value={search} maxLength={wire.search.maxText} disabled={condition === 'null' || condition === 'notNull'}
        onChange={event => setSearch(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) event.preventDefault()
          // Down from the search goes to the list, as in Excel's filter list.
          else if (event.key === 'ArrowDown' && summary && listRows > 0) { event.preventDefault(); viewport.current?.focus({ preventScroll: true }) }
        }} />
    </div>
    {load.status === 'loading' && <p className="column-filter-note" role="status">Listing values…</p>}
    {load.status === 'error' && <p className="column-filter-note error" role="alert">{load.message}</p>}
    {readError && <p className="column-filter-note error" role="alert">{readError}</p>}
    {empty && <p className="column-filter-note">No values match.</p>}
    <div className="column-filter-body">
    {/* Reached with Left from the values (no Tab stop of its own, so Tab still goes from the search to the values). */}
    <div ref={actionsBox} className="column-filter-actionlist" role="listbox" aria-label="Actions" tabIndex={-1} aria-disabled={!acting || undefined}
      aria-activedescendant={actionList.length ? `${rowId}-act-${actHere}` : undefined} onKeyDown={actionsKeyDown} onFocus={showAction}>
      {(() => {
        let at = -1
        return actionGroups.map((group, index) => <div key={group.label ?? 'every'} role="group" aria-label={group.label} className="column-filter-actiongroup">
          {group.label && <div className="column-filter-actionhead" aria-hidden="true">{group.label}</div>}
          {group.actions.map(item => {
            const mine = ++at
            return <div key={item.label} id={`${rowId}-act-${mine}`} role="option" aria-selected={mine === actHere} aria-disabled={!acting || undefined}
              aria-label={item.count === undefined ? item.label : `${item.label} (${formatCount(item.count)})`} className={'column-filter-action' + (mine === actHere ? ' active' : '')}
              onMouseDown={event => { event.preventDefault(); actionsBox.current?.focus({ preventScroll: true }); setAct(mine) }} onClick={() => { if (acting) runAt(mine) }}>
              <span className="column-filter-text">{item.label}</span>{item.count !== undefined && <span className="column-filter-count" aria-hidden="true">{formatCount(item.count)}</span>}
            </div>
          })}
          {index < actionGroups.length - 1 && <div className="column-filter-actionsep" role="presentation" />}
        </div>)
      })()}
    </div>
    {/* One Tab stop: the arrows move the active row inside it (aria-activedescendant), so focus never sits on a row the
        list may stop drawing. */}
    <div ref={viewport} className="column-filter-list" role="listbox" aria-multiselectable="true" aria-label="Values" aria-busy={load.status === 'loading' || (!!summary && total === undefined)}
      tabIndex={summary && listRows > 0 ? 0 : -1} aria-activedescendant={summary && active >= firstRow && active < lastRow ? `${rowId}-${active}` : undefined}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onKeyDown={listKeyDown} onFocus={event => { if (event.target === event.currentTarget) listFocused() }}>
      {summary && <div className="column-filter-space" role="presentation" style={{ height: win.space }}>
        {rows.map(({ index: row, value }) => {
          const spot: RowPlace = { id: `${rowId}-${row}`, row, rows: listRows, active: row === active, selected: isSelected(selection, row), top: win.offset(row), height: rowHeight }
          return row < nullRows
            ? <Row key="null" place={spot} label={`${nullText} (${formatCount(summary.nulls)})`} checked={ticks.nullChecked} disabled={!listing} className="null" onToggle={event => { if (plainClick(event)) toggleNull() }} onPick={pick}>
              <span className="column-filter-text">{nullText}</span><span className="column-filter-count" aria-hidden="true">{formatCount(summary.nulls)}</span>
            </Row>
            : value ? <Item key={value.group} value={value} place={spot} checked={value.checked} disabled={!listing} onToggle={clickToggle} onPick={pick} />
              : <div key={'row' + row} id={spot.id} role="option" aria-checked={false} aria-selected={spot.selected} aria-disabled="true" aria-label="Reading values…" aria-posinset={row + 1} aria-setsize={listRows}
                className={'column-filter-item pending' + (spot.active ? ' active' : '') + (spot.selected ? ' selected' : '')} style={{ top: spot.top, height: rowHeight }} />
        })}
      </div>}
    </div>
    </div>
    {note && <p className="column-filter-note">{note}{!summary?.complete ? ' Values in rows still arriving will be shown.' : ''}{summary?.approximate ? ' Long values were compared by their first characters.' : ''}{sourceNote ? ' ' + sourceNote : ''}</p>}
    <div className="column-filter-condition">
      <select aria-label="Condition" value={condition} onChange={event => { setError(undefined); setCondition(event.target.value as Condition) }}>
        {offered.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {(condition === 'equals' || condition === 'notEquals') && valueSelect('Value', first, setFirst)}
      {condition === 'between' && <>{valueSelect('Lowest value', first, setFirst)}{valueSelect('Highest value', second, setSecond)}</>}
    </div>
    {choosing && choices && choices.total > choices.values.length && <p className="column-filter-note">Choosing among the first {formatCount(choices.values.length)} of {formatCount(choices.total)} values. Search to find others.</p>}
    {ranged && choosing && <p className="column-filter-note">The column's range limits the values listed. Clear filter to choose others.</p>}
    {error && <p className="column-filter-note error" role="alert">{error}</p>}
    <div className="column-filter-actions">
      {filtered && <button type="button" onClick={clear}>Clear filter</button>}
      <span className="column-filter-gap" />
      <button type="submit" className="primary" disabled={!summary}>OK</button>
      <button type="button" onClick={() => onClose()}>Cancel</button>
    </div>
    {/* Pointer only: Options › Query Results sets the same size from the keyboard. */}
    <div className={'column-filter-grip' + (gripX < 0 ? ' start' : '') + (gripY < 0 ? ' top' : '')} aria-hidden="true" title="Drag to resize"
      onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={gripUp} />
  </form>, grid.ownerDocument.body)
}
