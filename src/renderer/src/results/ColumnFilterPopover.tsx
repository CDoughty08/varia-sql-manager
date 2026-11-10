import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DistinctValue, ResultsDistinctTickParams } from '../../../shared/contracts'
import { codiconClass } from '../../../shared/icons'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useWorkbench } from '../core/WorkbenchContext'
import { trapFocus } from '../trap-focus'
import { blocksToDrop, checklistCondition, columnFilterKind, listWindow, type ColumnCondition } from './column-filter'
import type { DistinctList } from './ResultClient'
import { formatCount, plural } from './status'

export interface ColumnFilterTarget { readonly column: number; readonly anchor: DOMRect }

/** The custom conditions beside the checklist (`list`): one value, not it, between two, NULL, not NULL. */
type Condition = 'list' | 'equals' | 'notEquals' | 'between' | 'null' | 'notNull'
const conditions: readonly (readonly [Condition, string])[] = [
  ['list', 'Values ticked in the list'], ['equals', 'Equals'], ['notEquals', 'Does not equal'], ['between', 'Between'], ['null', 'Is NULL'], ['notNull', 'Is not NULL']
]
type Load = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly list: DistinctList }
interface Ticks { readonly checked: number; readonly nullChecked: boolean }

const width = 300
/** A search asks the backend once typing pauses; clearing it shows every value at once. */
const searchPauseMs = 200
/** Values one window read asks for, and rows drawn past each edge of the list's viewport. */
const blockSize = 128
const overscan = 8
/** Blocks kept while scrolling (4,096 values): the farthest from view go first, so a long scroll holds no more. */
const maxBlocks = 32
/** The list's row height before the theme's `--varia-row` is read. */
const fallbackRow = 22
const shown = (value: DistinctValue) => value.text === '' ? '(empty)' : value.text
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback

/** One checklist entry, placed at its row; a tick re-renders only the entries it changes. */
const Item = memo(function Item({ value, top, height, checked, disabled, onToggle }: { value: DistinctValue; top: number; height: number; checked: boolean; disabled: boolean; onToggle(value: DistinctValue): void }) {
  return <label className={'column-filter-item' + (value.text === '' ? ' empty' : '')} style={{ top, height }}>
    <input type="checkbox" disabled={disabled} checked={checked} onChange={() => onToggle(value)} aria-label={`${shown(value)} (${formatCount(value.count)})`} />
    <bdi className="column-filter-text" title={value.text}>{shown(value)}</bdi><span className="column-filter-count" aria-hidden="true">{formatCount(value.count)}</span>
  </label>
})

/**
 * The header funnel's popover (results.distinct): the column's distinct values with their counts as a checklist with a
 * search, Select all and Select none, NULL as an entry of its own, and custom conditions. The values stay in the backend
 * as a snapshot, however many: the list draws only the rows in view (a fixed row height) and reads windows of them as it
 * scrolls, a search narrows the snapshot in the backend, and the ticks live there too, so Select all over a million values
 * is one request. OK filters the grid by the snapshot (a `groups` filter, which the grid then keeps) or by the custom
 * condition (ResultsService.applyColumnFilter, replacing the column's filter of the same kind); Cancel, Escape or a press
 * outside closes it unchanged and closes the snapshot. It lists the values of the rows the grid's other filters keep, so
 * values the column's own filter dropped can be ticked again.
 */
export function ColumnFilterPopover({ tabId, index, columnName, target, filtered, grid, onClose }: {
  tabId: string; index: number; columnName: string; target: ColumnFilterTarget; filtered: boolean
  /** The grid it filters: the popover opens in that grid's window (the main one, or a popout's). */
  grid: HTMLElement
  onClose(refocus?: boolean): void
}) {
  const { results } = useWorkbench()
  const { column, anchor } = target
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
    results.columnValues(tabId, index, column, { signal: abort.signal }).then(answer => {
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
  }, [results, tabId, index, column, setTicks])

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
  const [rowHeight, setRowHeight] = useState(fallbackRow)
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
    const measure = () => setViewHeight(element.clientHeight)
    measure()
    const observer = new view.ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const showNull = !!summary && summary.nulls > 0 && (!needle || 'null'.includes(needle.toLowerCase()))
  const nullRows = showNull ? 1 : 0
  const valueRows = total ?? 0
  const win = listWindow({ scrollTop, viewHeight, rowHeight, rows: nullRows + valueRows, overscan })
  const firstRow = win.first, lastRow = win.last
  const firstBlock = Math.floor(Math.max(0, firstRow - nullRows) / blockSize)
  const lastBlock = Math.floor(Math.max(0, lastRow - nullRows - 1) / blockSize)
  const inView = useRef({ firstBlock, lastBlock })
  inView.current = { firstBlock, lastBlock }

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
  const send = useCallback((tick: Omit<ResultsDistinctTickParams, 'resultId' | 'snapshotId'>) => {
    if (!list) return
    epoch.current++
    setTicking(value => value + 1)
    chain.current = chain.current.then(() => list.tick(tick)).then(answer => setTicks({ checked: answer.checked, nullChecked: answer.nullsChecked }), (failure: unknown) => {
      setError(message(failure, 'The value could not be ticked.'))
      ticksStale.current = true
      blocks.current = new Map()
      setVersion(value => value + 1)
    }).finally(() => setTicking(value => value - 1))
  }, [list, setTicks])

  /** Shows a tick at once, in every block that holds the values it changes. */
  const patch = (change: (value: DistinctValue) => boolean | undefined) => {
    const next = new Map<number, readonly DistinctValue[]>()
    for (const [block, values] of blocks.current) next.set(block, values.map(value => { const checked = change(value); return checked === undefined || checked === value.checked ? value : { ...value, checked } }))
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
  /** Select all or none: every value the list shows (a search's, with one) and NULL when it is shown. */
  const setAll = (checked: boolean) => {
    if (!summary) return
    patch(() => checked)
    if (!needle) setTicks({ checked: checked ? summary.distinct : 0, nullChecked: showNull ? checked : ticksNow.current.nullChecked })
    else if (showNull) setTicks({ ...ticksNow.current, nullChecked: checked })
    send({ checked, all: true, ...needle ? { search: needle } : {}, ...showNull ? { nulls: checked } : {} })
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

  const apply = async () => {
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
    if (!results.applyColumnFilter(tabId, index, column, chosen)) return
    if (chosen.kind === 'list') handed.current = true
    onClose()
  }
  const clear = () => { if (results.applyColumnFilter(tabId, index, column, { kind: 'clear' })) onClose() }

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
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

  // Under the header when it has room (its usual height), else above it when there is more room there; measured in the
  // grid's own window.
  const view = grid.ownerDocument.defaultView ?? window, innerWidth = view.innerWidth, innerHeight = view.innerHeight
  const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))
  const below = innerHeight - anchor.bottom - 10, above = anchor.top - 10, down = below >= 420 || below >= above
  const place = down ? { left, width, top: anchor.bottom + 2, maxHeight: Math.max(160, below) } : { left, width, bottom: innerHeight - anchor.top + 2, maxHeight: above }
  // The column's own range limits the values listed, so Equals and Between can choose only within it.
  const ranged = !!results.sortOf(tabId, index)?.filters.some(item => columnFilterKind(item.filter, column) === 'between')
  const titleId = `column-filter-${tabId}-${index}-${column}`
  const note = !summary ? undefined
    : needle && total !== undefined ? `${formatCount(total)} of ${formatCount(summary.distinct)} ${plural(summary.distinct, 'value')} match. ${formatCount(ticks.checked)} ticked.`
      : `${formatCount(summary.distinct)} ${plural(summary.distinct, 'value')} in ${formatCount(summary.rows)} ${plural(summary.rows, 'row')}. ${formatCount(ticks.checked)} ticked.`
  const empty = !!summary && total === 0 && !showNull

  return createPortal(<form ref={card} className="column-filter" role="dialog" aria-labelledby={titleId} style={place}
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
        onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
    </div>
    <div className="column-filter-bulk">
      <button type="button" disabled={!listing || !summary} onClick={() => setAll(true)}>Select all</button>
      <button type="button" disabled={!listing || !summary} onClick={() => setAll(false)}>Select none</button>
    </div>
    <div ref={viewport} className="column-filter-list" role="group" aria-label="Values" aria-busy={load.status === 'loading' || (!!summary && total === undefined)}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {load.status === 'loading' && <p className="column-filter-note" role="status">Listing values…</p>}
      {load.status === 'error' && <p className="column-filter-note error" role="alert">{load.message}</p>}
      {readError && <p className="column-filter-note error" role="alert">{readError}</p>}
      {empty && <p className="column-filter-note">No values match.</p>}
      {summary && <div className="column-filter-space" style={{ height: win.space }}>
        {rows.map(({ index: row, value }) => row < nullRows
          ? <label key="null" className="column-filter-item null" style={{ top: win.offset(0), height: rowHeight }}>
            <input type="checkbox" disabled={!listing} checked={ticks.nullChecked} onChange={toggleNull} aria-label={`NULL (${formatCount(summary.nulls)})`} />
            <span className="column-filter-text">NULL</span><span className="column-filter-count" aria-hidden="true">{formatCount(summary.nulls)}</span>
          </label>
          : value ? <Item key={value.group} value={value} top={win.offset(row)} height={rowHeight} checked={value.checked} disabled={!listing} onToggle={toggle} />
            : <div key={'row' + row} className="column-filter-item pending" style={{ top: win.offset(row), height: rowHeight }} aria-hidden="true" />)}
      </div>}
    </div>
    {note && <p className="column-filter-note">{note}{!summary?.complete ? ' Values in rows still arriving will be shown.' : ''}{summary?.approximate ? ' Long values were compared by their first characters.' : ''}</p>}
    <div className="column-filter-condition">
      <select aria-label="Condition" value={condition} onChange={event => { setError(undefined); setCondition(event.target.value as Condition) }}>
        {conditions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
  </form>, grid.ownerDocument.body)
}
