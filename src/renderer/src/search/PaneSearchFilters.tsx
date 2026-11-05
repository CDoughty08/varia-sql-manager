import { useId, useRef } from 'react'
import { searchTypes, type SearchScope, type SearchType } from '../../../shared/explorer/search.ts'
import Segmented from '../kit/Segmented'
import { searchScopeSegments, toggleSearchType } from './SearchFilters'
import SearchPopover from './SearchPopover'

interface Props {
  readonly id: string
  readonly scope: SearchScope
  readonly types: readonly SearchType[]
  readonly onScope: (scope: SearchScope) => void
  readonly onTypes: (types: SearchType[]) => void
}

/** Scope stays visible; the complete type list opens over the results rather than adding rows to a narrow sidebar. */
export default function PaneSearchFilters({ id, scope, types, onScope, onTypes }: Props) {
  const scopeLabel = useId()
  const root = useRef<HTMLDivElement>(null)
  const chosen = searchTypes.filter(type => types.includes(type.id))
  const summary = chosen.length > 2 ? `${chosen[0].label} + ${chosen.length - 1} more` : chosen.map(type => type.label).join(', ')
  const label = chosen.length ? `${chosen.length} ${chosen.length === 1 ? 'type' : 'types'}` : 'All types'
  return <div ref={root} className="object-search-pane-filters">
    <div className="object-search-pane-filter-row">
      <span id={scopeLabel} className="visually-hidden">Search in</span>
      <Segmented id={`${id}-scope`} labelledBy={scopeLabel} segments={searchScopeSegments} value={scope} onChange={value => onScope(value as SearchScope)} />
      <SearchPopover label={`Object types: ${chosen.length ? chosen.map(type => type.label).join(', ') : 'All types'}`} title="Object types" icon={chosen.length ? 'filter-filled' : 'filter'} active={!!chosen.length}
        trigger={<><span className="object-search-type-label">{label}</span><span className="object-search-type-short" aria-hidden>{chosen.length ? `Types · ${chosen.length}` : 'Types'}</span></>}>
        <label className="object-search-check object-search-all-types"><input type="checkbox" checked={!types.length} onChange={() => onTypes([])} /><span>All types</span></label>
        <div className="object-search-type-grid">
          {searchTypes.map(type => <label key={type.id} className="object-search-check"><input type="checkbox" checked={types.includes(type.id)} onChange={() => onTypes(toggleSearchType(types, type.id))} /><span>{type.label}</span></label>)}
        </div>
      </SearchPopover>
    </div>
    {!!chosen.length && <div className="object-search-chosen-types"><span title={chosen.map(type => type.label).join(', ')}>{summary}</span>
      <button type="button" aria-label="Clear object type filters" onClick={() => { root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.focus(); onTypes([]) }}>Clear</button>
    </div>}
  </div>
}
