import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DistinctValue, ResultsDistinctResult } from '../../../shared/contracts'
import { codiconClass } from '../../../shared/icons'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useWorkbench } from '../core/WorkbenchContext'
import { trapFocus } from '../trap-focus'
import { checklistCondition, unlistedValues, type ColumnCondition } from './column-filter'
import { ColumnValuesScope } from './ResultsService'
import { formatCount, plural } from './status'

export interface ColumnFilterTarget { readonly column: number; readonly anchor: DOMRect }

/** The custom conditions beside the checklist (`list`): one value, not it, between two, NULL, not NULL. */
type Condition = 'list' | 'equals' | 'notEquals' | 'between' | 'null' | 'notNull'
const conditions: readonly (readonly [Condition, string])[] = [
  ['list', 'Values ticked in the list'], ['equals', 'Equals'], ['notEquals', 'Does not equal'], ['between', 'Between'], ['null', 'Is NULL'], ['notNull', 'Is not NULL']
]
type Load = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly result: ResultsDistinctResult }

const width = 300
/** A search over a truncated list asks the backend once typing pauses (a short list filters what it has). */
const searchPauseMs = 200
const shown = (value: DistinctValue) => value.text === '' ? '(empty)' : value.text

/** One checklist entry; a tick or a search re-renders only the entries it changes, not every one of up to 4,096. */
const Item = memo(function Item({ value, checked, disabled, onToggle }: { value: DistinctValue; checked: boolean; disabled: boolean; onToggle(row: number): void }) {
  return <label className={'column-filter-item' + (value.text === '' ? ' empty' : '')}>
    <input type="checkbox" disabled={disabled} checked={checked} onChange={() => onToggle(value.row)} aria-label={`${shown(value)} (${formatCount(value.count)})`} />
    <bdi className="column-filter-text" title={value.text}>{shown(value)}</bdi><span className="column-filter-count" aria-hidden="true">{formatCount(value.count)}</span>
  </label>
})

/**
 * The header funnel's popover (results.distinct): the column's distinct values with their counts as a checklist with a
 * search, Select all and Select none, NULL as an entry of its own, and custom conditions. OK filters the grid by the
 * values ticked (ResultsService.applyColumnFilter, replacing the column's filter of the same kind); Cancel, Escape or a
 * press outside closes it unchanged. It lists the values of the rows the grid's other filters keep, so values the column's
 * own filter dropped can be ticked again.
 */
export function ColumnFilterPopover({ tabId, index, columnName, target, filtered, grid, onClose }: {
  tabId: string; index: number; columnName: string; target: ColumnFilterTarget; filtered: boolean
  /** The grid it filters: the popover opens in that grid's window (the main one, or a popout's). */
  grid: HTMLElement
  onClose(refocus?: boolean): void
}) {
  const { results } = useWorkbench()
  const { column, anchor } = target
  const card = useRef<HTMLFormElement>(null), searchBox = useRef<HTMLInputElement>(null)
  const [order, setOrder] = useState<'count' | 'value'>('count')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [searched, setSearched] = useState<{ text: string; result: ResultsDistinctResult } | undefined>()
  const [search, setSearch] = useState('')
  /** Values seen, by representative row: the list's and any a search found past it. */
  const [known, setKnown] = useState<ReadonlyMap<number, DistinctValue>>(new Map()), knownNow = useRef(known)
  const [unchecked, setUnchecked] = useState<ReadonlySet<number>>(new Set())
  const [nullChecked, setNullChecked] = useState(true)
  const [condition, setCondition] = useState<Condition>('list')
  const [first, setFirst] = useState<number | undefined>()
  const [second, setSecond] = useState<number | undefined>()
  const [error, setError] = useState<string | undefined>()
  const nullsSeen = useRef(false)
  // The view of the rows the other filters keep, shared by the list and its searches.
  const scope = useMemo(() => new ColumnValuesScope(), [results, tabId, index, column])
  useEffect(() => () => scope.release(), [scope])

  // A value seen for the first time starts ticked unless the column's filter drops it now (its kept mark); one seen
  // before keeps whatever the checklist says, so a new order or a search never undoes a tick.
  const remember = (result: ResultsDistinctResult) => {
    const fresh = result.values.filter(value => !knownNow.current.has(value.row))
    if (!nullsSeen.current && result.nullsKept !== undefined) { nullsSeen.current = true; setNullChecked(result.nullsKept) }
    if (!fresh.length) return
    const next = new Map(knownNow.current)
    for (const value of fresh) next.set(value.row, value)
    knownNow.current = next
    setKnown(next)
    const dropped = fresh.filter(value => value.kept === false)
    if (dropped.length) setUnchecked(current => new Set([...current, ...dropped.map(value => value.row)]))
  }

  // The list, again when its order changes.
  useEffect(() => {
    const abort = new AbortController()
    setLoad({ status: 'loading' })
    results.columnValues(tabId, index, column, { order, scope, signal: abort.signal }).then(answer => {
      if (abort.signal.aborted) return
      remember(answer.result)
      setLoad({ status: 'ready', result: answer.result })
    }, (failure: unknown) => {
      if (abort.signal.aborted) return
      setLoad({ status: 'error', message: failure instanceof Error ? failure.message : 'The column\'s values could not be listed.' })
    })
    return () => abort.abort()
  }, [results, tabId, index, column, order, scope])

  // A truncated list searches in the backend, which has every value.
  const full = load.status === 'ready' ? load.result : undefined
  const needle = search.trim()
  useEffect(() => {
    if (!full?.truncated || !needle) { setSearched(undefined); return }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      results.columnValues(tabId, index, column, { order, scope, search: needle.slice(0, wire.search.maxText), signal: abort.signal }).then(answer => {
        if (abort.signal.aborted) return
        remember(answer.result)
        setSearched({ text: needle, result: answer.result })
      }, () => { /* The full list stays shown, filtered by what it has. */ })
    }, searchPauseMs)
    return () => { clearTimeout(timer); abort.abort() }
  }, [results, tabId, index, column, order, scope, full, needle])

  const entries = useMemo(() => {
    if (!full) return []
    if (searched && searched.text === needle) return searched.result.values
    if (!needle) return full.values
    const lower = needle.toLocaleLowerCase()
    return full.values.filter(value => value.text.toLocaleLowerCase().includes(lower))
  }, [full, searched, needle])
  const showNull = !!full && full.nulls > 0 && (!needle || 'null'.includes(needle.toLowerCase()))

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

  const setAll = (checked: boolean) => {
    setUnchecked(current => {
      const next = new Set(current)
      for (const value of entries) { if (checked) next.delete(value.row); else next.add(value.row) }
      return next
    })
    if (showNull) setNullChecked(checked)
  }
  const toggle = useCallback((row: number) => setUnchecked(current => {
    const next = new Set(current)
    if (!next.delete(row)) next.add(row)
    return next
  }), [])

  const apply = () => {
    let chosen: ColumnCondition | undefined
    if (condition === 'list') {
      const outcome = checklistCondition({ rows: [...known.keys()], unchecked, hasNull: (full?.nulls ?? 0) > 0, nullChecked, ...unlisted ? { unlisted } : {} })
      if ('error' in outcome) return setError(outcome.error)
      chosen = outcome.condition
    } else if (condition === 'null' || condition === 'notNull') chosen = { kind: condition }
    else if (first === undefined || (condition === 'between' && second === undefined)) return setError(condition === 'between' ? 'Choose the lowest and the highest value.' : 'Choose a value.')
    else chosen = condition === 'between' ? { kind: 'between', rows: [first, second!] } : { kind: condition, row: first }
    if (results.applyColumnFilter(tabId, index, column, chosen)) onClose()
  }
  const clear = () => { if (results.applyColumnFilter(tabId, index, column, { kind: 'clear' })) onClose() }

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }

  const choices = [...known.values()]
  const valueSelect = (label: string, value: number | undefined, set: (row: number | undefined) => void) =>
    <select aria-label={label} value={value ?? ''} onChange={event => { setError(undefined); set(event.target.value === '' ? undefined : Number(event.target.value)) }}>
      <option value="">Choose a value…</option>
      {choices.map(choice => <option key={choice.row} value={choice.row}>{shown(choice)}</option>)}
    </select>

  // Under the header when it has room (its usual height), else above it when there is more room there; measured in the
  // grid's own window.
  const view = grid.ownerDocument.defaultView ?? window, innerWidth = view.innerWidth, innerHeight = view.innerHeight
  const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))
  const below = innerHeight - anchor.bottom - 10, above = anchor.top - 10, down = below >= 420 || below >= above
  const place = down ? { left, width, top: anchor.bottom + 2, maxHeight: Math.max(160, below) } : { left, width, bottom: innerHeight - anchor.top + 2, maxHeight: above }
  // A truncated list's values past it stay as the grid shows them, unless the grid's view names too many of them.
  const unlisted = full ? unlistedValues(full, known) : undefined
  const titleId = `column-filter-${tabId}-${index}-${column}`
  const list = condition === 'list'
  const note = !full ? undefined
    : full.truncated && !(searched && searched.text === needle) ? `Showing the first ${formatCount(full.values.length)} of ${formatCount(full.distinct)} values. Search to find others.`
      : searched?.result.truncated && searched.text === needle ? `Showing the first ${formatCount(searched.result.values.length)} of ${formatCount(searched.result.distinct)} matching values.`
        : `${formatCount(full.distinct)} ${plural(full.distinct, 'value')} in ${formatCount(full.rows)} ${plural(full.rows, 'row')}.`

  return createPortal(<form ref={card} className="column-filter" role="dialog" aria-labelledby={titleId} style={place}
    onKeyDown={keyDown} onSubmit={event => { event.preventDefault(); apply() }}>
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
      <input ref={searchBox} type="search" aria-label="Search values" placeholder="Search values" value={search} maxLength={wire.search.maxText} disabled={!list}
        onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
    </div>
    <div className="column-filter-bulk">
      <button type="button" disabled={!list || !full} onClick={() => setAll(true)}>Select all</button>
      <button type="button" disabled={!list || !full} onClick={() => setAll(false)}>Select none</button>
    </div>
    <div className="column-filter-list" role="group" aria-label="Values" aria-busy={load.status === 'loading'}>
      {load.status === 'loading' && <p className="column-filter-note" role="status">Listing values…</p>}
      {load.status === 'error' && <p className="column-filter-note error" role="alert">{load.message}</p>}
      {showNull && <label className="column-filter-item null">
        <input type="checkbox" disabled={!list} checked={nullChecked} onChange={() => setNullChecked(value => !value)} aria-label={`NULL (${formatCount(full!.nulls)})`} />
        <span className="column-filter-text">NULL</span><span className="column-filter-count" aria-hidden="true">{formatCount(full!.nulls)}</span>
      </label>}
      {entries.map(value => <Item key={value.row} value={value} checked={!unchecked.has(value.row)} disabled={!list} onToggle={toggle} />)}
      {full && !entries.length && !showNull && <p className="column-filter-note">No values match.</p>}
    </div>
    {note && <p className="column-filter-note">{note}{!unlisted ? '' : unlisted.exact ? ' Values not listed stay as the grid shows them.' : ' Values not listed will all be shown.'}{full?.approximate ? ' Long values were compared by their first characters.' : ''}</p>}
    <div className="column-filter-condition">
      <select aria-label="Condition" value={condition} onChange={event => { setError(undefined); setCondition(event.target.value as Condition) }}>
        {conditions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {(condition === 'equals' || condition === 'notEquals') && valueSelect('Value', first, setFirst)}
      {condition === 'between' && <>{valueSelect('Lowest value', first, setFirst)}{valueSelect('Highest value', second, setSecond)}</>}
    </div>
    {error && <p className="column-filter-note error" role="alert">{error}</p>}
    <div className="column-filter-actions">
      {filtered && <button type="button" onClick={clear}>Clear filter</button>}
      <span className="column-filter-gap" />
      <button type="submit" className="primary" disabled={!full}>OK</button>
      <button type="button" onClick={() => onClose()}>Cancel</button>
    </div>
  </form>, grid.ownerDocument.body)
}
