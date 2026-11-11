import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { codiconClass } from '../../../shared/icons'
import type { LiveFacet } from '../../../shared/live/schema'
import { formatCount, plural } from '../results/status'
import { trapFocus } from '../trap-focus'
import { liveFilterOutcome, liveFilterTicks, type LiveValueFilter } from './live-filter'

const width = 300
const maxSearch = 128

/**
 * A live grid's header funnel popover: the results grid's popover (ColumnFilterPopover: the same card, search, Select
 * all and Select none, checklist with counts, OK and Cancel) over a live source's facets, the most frequent values of
 * the column in the last sample. OK hands the filter to the owner, which sends it to the backend as the source's args;
 * Cancel, Escape or a press outside closes it unchanged.
 */
export function LiveColumnFilterPopover({ caption, anchor, grid, facet, filter, maxValues, onApply, onClose }: {
  caption: string
  anchor: DOMRect
  /** The grid it filters: the popover opens in that grid's window. */
  grid: HTMLElement
  facet: LiveFacet | undefined
  filter: LiveValueFilter | undefined
  maxValues: number
  /** OK: the column's new filter, or undefined to take it off. */
  onApply(filter: LiveValueFilter | undefined): void
  onClose(refocus?: boolean): void
}) {
  const card = useRef<HTMLFormElement>(null), searchBox = useRef<HTMLInputElement>(null), titleId = useId()
  // The ticks start from the filter on when it opened; the facets that arrive with later samples update the counts only.
  const [initial] = useState(() => liveFilterTicks(facet, filter))
  const [ticked, setTicked] = useState<ReadonlySet<string>>(initial.ticked)
  const [blanks, setBlanks] = useState(initial.blanks)
  const [order, setOrder] = useState<'count' | 'value'>('count')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string>()
  const counts = useMemo(() => new Map((facet?.values ?? []).map(value => [value.text, value.count])), [facet])
  const entries = useMemo(() => {
    const listed = initial.entries.map(entry => ({ text: entry.text, count: counts.get(entry.text) }))
    const needle = search.trim().toLocaleLowerCase()
    const shown = needle ? listed.filter(entry => entry.text.toLocaleLowerCase().includes(needle)) : listed
    return order === 'value' ? [...shown].sort((a, b) => a.text.localeCompare(b.text)) : [...shown].sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
  }, [initial, counts, search, order])
  const showBlanks = !search.trim()

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

  const toggle = (text: string) => {
    setError(undefined)
    setTicked(current => { const next = new Set(current); if (!next.delete(text)) next.add(text); return next })
  }
  /** Select all and Select none act on the values the search shows, and on (Blanks) while it is listed. */
  const setAll = (on: boolean) => {
    setError(undefined)
    setTicked(current => { const next = new Set(current); for (const entry of entries) { if (on) next.add(entry.text); else next.delete(entry.text) } return next })
    if (showBlanks) setBlanks(on)
  }
  const apply = () => {
    const outcome = liveFilterOutcome({ entries: initial.entries, ticked, blanks }, maxValues)
    if ('error' in outcome) return setError(outcome.error)
    onApply('clear' in outcome ? undefined : outcome.filter)
    onClose()
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }

  const view = grid.ownerDocument.defaultView ?? window, innerWidth = view.innerWidth, innerHeight = view.innerHeight
  const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))
  const below = innerHeight - anchor.bottom - 10, above = anchor.top - 10, down = below >= 360 || below >= above
  const place = down ? { left, width, top: anchor.bottom + 2, maxHeight: Math.max(160, below) } : { left, width, bottom: innerHeight - anchor.top + 2, maxHeight: above }
  const tickedCount = initial.entries.filter(entry => ticked.has(entry.text)).length
  const filtered = !!filter && (!!filter.values?.length || !!filter.blanks || !!filter.nonBlanks)

  return createPortal(<form ref={card} className="column-filter" role="dialog" aria-labelledby={titleId} style={place}
    onKeyDown={keyDown} onSubmit={event => { event.preventDefault(); apply() }}>
    <div className="column-filter-head">
      <span className={codiconClass('filter')} aria-hidden="true" />
      <h2 id={titleId}>Filter <bdi>{caption}</bdi></h2>
      <select aria-label="Order values by" value={order} onChange={event => setOrder(event.target.value as 'count' | 'value')}>
        <option value="count">Most frequent</option>
        <option value="value">Value</option>
      </select>
    </div>
    <div className="column-filter-search">
      <span className={codiconClass('search')} aria-hidden="true" />
      <input ref={searchBox} type="search" aria-label="Search values" placeholder="Search values" value={search} maxLength={maxSearch}
        onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
    </div>
    <div className="column-filter-bulk">
      <button type="button" onClick={() => setAll(true)}>Select all</button>
      <button type="button" onClick={() => setAll(false)}>Select none</button>
    </div>
    <div className="column-filter-list" role="group" aria-label="Values">
      <div className="column-filter-space flow">
        {showBlanks && <label className="column-filter-item null">
          <input type="checkbox" checked={blanks} onChange={() => { setError(undefined); setBlanks(value => !value) }} aria-label="(Blanks)" />
          <span className="column-filter-text">(Blanks)</span>
        </label>}
        {entries.map(entry => <label key={entry.text} className="column-filter-item" title={entry.count === undefined ? 'Chosen, but no row shown now has this value' : entry.text}>
          <input type="checkbox" checked={ticked.has(entry.text)} onChange={() => toggle(entry.text)} aria-label={`${entry.text} (${entry.count === undefined ? 'none now' : formatCount(entry.count)})`} />
          <bdi className="column-filter-text">{entry.text}</bdi><span className="column-filter-count" aria-hidden="true">{entry.count === undefined ? '—' : formatCount(entry.count)}</span>
        </label>)}
      </div>
      {!facet && initial.entries.length === 0 && <p className="column-filter-note" role="status">No values yet: they arrive with the next sample.</p>}
      {search.trim() && entries.length === 0 && <p className="column-filter-note">No values match.</p>}
    </div>
    <p className="column-filter-note">
      {formatCount(initial.entries.length)} {plural(initial.entries.length, 'value')} in the last sample. {formatCount(tickedCount)} ticked.
      {facet?.more ? ` Only the ${formatCount(facet.values.length)} most frequent are listed; a filter by values leaves the others out.` : ''}
    </p>
    {error && <p className="column-filter-note error" role="alert">{error}</p>}
    <div className="column-filter-actions">
      {filtered && <button type="button" onClick={() => { onApply(undefined); onClose() }}>Clear filter</button>}
      <span className="column-filter-gap" />
      <button type="submit" className="primary">OK</button>
      <button type="button" onClick={() => onClose()}>Cancel</button>
    </div>
  </form>, grid.ownerDocument.body)
}
