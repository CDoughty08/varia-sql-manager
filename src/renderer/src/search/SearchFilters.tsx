import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { searchTypes, type SearchScope, type SearchType } from '../../../shared/explorer/search.ts'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import Segmented from '../kit/Segmented'
import { layoutFilters, type FilterLayout } from './filter-layout'

export const searchScopeSegments: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'All' }, { value: 'names', label: 'Names' }, { value: 'definitions', label: 'Definitions' }]
const allTypes = 'All types'

/** The type filters after toggling one, in the chips' order (a query compares them as they are). */
export function toggleSearchType(types: readonly SearchType[], id: SearchType): SearchType[] {
  return searchTypes.map(type => type.id).filter(type => (type === id) !== types.includes(type))
}

/** What the Filters button says the search is narrowed to: "All", or the scope and the types chosen ("Names, Columns"). */
export function searchFilterSummary(scope: SearchScope, types: readonly SearchType[]): string {
  const parts = [...scope === 'all' ? [] : [searchScopeSegments.find(segment => segment.value === scope)!.label], ...searchTypes.filter(type => types.includes(type.id)).map(type => type.label)]
  return parts.length ? parts.join(', ') : 'All'
}

const moreLabel = (hidden: number) => `+${hidden} more`

interface Props {
  readonly id: string
  readonly scope: SearchScope
  readonly types: readonly SearchType[]
  readonly onScope: (scope: SearchScope) => void
  readonly onTypes: (types: SearchType[]) => void
  /** Controls after the scope (the tab's server picker). */
  readonly options?: ReactNode
}

/**
 * Search Objects' filters: Match in (names, definitions or both) and the type chips, which combine (none chosen: every kind).
 * They fit themselves to the row: every chip in one line when there is room, as many as fit before "+n more" when not, and in
 * a pane too narrow for the scope's segments one Filters button that names what is chosen and shows them all on demand. A
 * hidden copy of the controls is measured, so the layout follows fonts, density and the checks pressed chips draw.
 */
export default function SearchFilters({ id, scope, types, onScope, onTypes, options }: Props) {
  const scopeLabel = useId()
  const panel = useId()
  const row = useRef<HTMLDivElement>(null)
  const extra = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<FilterLayout>({ collapsed: false, shown: searchTypes.length + 1 })
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const element = row.current, copy = measure.current
    if (!element || !copy) return
    const fit = () => {
      const width = (selector: string) => [...copy.querySelectorAll<HTMLElement>(selector)].map(item => item.getBoundingClientRect().width)
      const group = copy.querySelector<HTMLElement>('.chip-group')
      const gap = group ? parseFloat(getComputedStyle(group).columnGap) || 0 : 0
      const options = extra.current ? extra.current.getBoundingClientRect().width + (parseFloat(getComputedStyle(element.firstElementChild!).columnGap) || 0) : 0
      const next = layoutFilters({ available: element.clientWidth, options, scope: width('.segmented')[0] ?? 0, chips: width('.chip-group > .chip'), more: width('[data-measure-more]')[0] ?? 0, gap })
      setLayout(current => current.collapsed === next.collapsed && current.shown === next.shown ? current : next)
    }
    fit()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    observer.observe(copy)
    if (extra.current) observer.observe(extra.current)
    return () => observer.disconnect()
  }, [scope, types, options])

  const chips = [
    <Chip key="all" label={allTypes} pressed={!types.length} title="Search every kind of object" onToggle={() => { if (types.length) onTypes([]) }} />,
    ...searchTypes.map(type => <Chip key={type.id} label={type.label} pressed={types.includes(type.id)} onToggle={() => onTypes(toggleSearchType(types, type.id))} />)
  ]
  const segmented = (key: string) => <Segmented id={`${id}-scope${key}`} labelledBy={scopeLabel} segments={searchScopeSegments} value={scope} onChange={value => onScope(value as SearchScope)} />
  const all = expanded || layout.collapsed
  const hidden = all ? 0 : chips.length - layout.shown
  const hiddenChosen = searchTypes.slice(Math.max(0, layout.shown - 1)).filter(type => types.includes(type.id)).length
  const summary = searchFilterSummary(scope, types)
  return <div ref={row} className="object-search-filters" data-collapsed={layout.collapsed ? '' : undefined}>
    <div className="object-search-options">
      <span id={scopeLabel} className="visually-hidden">Search in</span>
      {layout.collapsed
        ? <button type="button" className="object-search-filter-button" aria-expanded={expanded} aria-controls={panel} aria-label={`Filters: ${summary}`} title={`Filters: ${summary}`} onClick={() => setExpanded(value => !value)}>
          <Icon name={summary === 'All' ? 'filter' : 'filter-filled'} /><span className="object-search-filter-summary">{summary}</span><Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
        </button>
        : segmented('')}
      {options && <div ref={extra} className="object-search-extra">{options}</div>}
    </div>
    {(!layout.collapsed || expanded) && <div id={panel} className="object-search-types" data-wrap={all ? '' : undefined}>
      {layout.collapsed && segmented('-panel')}
      <ChipGroup label="Object types">
        {all ? chips : chips.slice(0, layout.shown)}
        {hidden > 0 && <button type="button" className="chip object-search-more-types" aria-expanded={false} aria-controls={panel} data-chosen={hiddenChosen ? '' : undefined}
          aria-label={`${moreLabel(hidden)}${hiddenChosen ? `, ${hiddenChosen} chosen` : ''}`} title={searchTypes.slice(layout.shown - 1).map(type => type.label).join(', ')} onClick={() => setExpanded(true)}>{moreLabel(hidden)}</button>}
        {expanded && !layout.collapsed && layout.shown < chips.length && <button type="button" className="chip object-search-more-types" aria-expanded aria-controls={panel} onClick={() => setExpanded(false)}>Fewer</button>}
      </ChipGroup>
    </div>}
    <div ref={measure} className="object-search-measure" aria-hidden inert>
      {segmented('-measure')}
      <ChipGroup label="">{chips}</ChipGroup>
      <button type="button" className="chip" data-measure-more>{moreLabel(chips.length)}</button>
    </div>
  </div>
}
