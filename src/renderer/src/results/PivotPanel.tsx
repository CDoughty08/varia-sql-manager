import { useId, type ChangeEvent } from 'react'
import type { PivotAggregate, PivotValueSpec, ResultColumn } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import Icon from '../Icon'
import { aggregateFits, emptyDraft, fitDraft, isNumericColumn, pivotAggregates, pivotColumns, valueLabel, type PivotDraft } from './pivot'
import { pivotable } from './PivotService'
import type { TabResults } from './ResultsService'
import { formatCount, plural } from './status'

const nameOf = (column: ResultColumn | undefined) => column?.name || '(No column name)'

/**
 * The pivot panel, beside the stacked grids (as the column profile is): which set to pivot, its row groups (in order), its
 * column group and its values, then Build Pivot, which appends the pivot as the run's last set. It reads the set's rows as
 * its grid shows them, sorted and filtered. Only aggregates that suit a column are offered for it: Sum and Average need
 * numbers.
 */
export default function PivotPanel({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { pivot, results } = useWorkbench()
  const state = useServiceSnapshot(pivot).tabs[tabId]
  useServiceSnapshot(results)
  const ids = useId()
  if (!state) return null
  const sources = tab.sets.filter(pivotable)
  const entry = tab.sets[state.source]
  const columns = entry?.descriptor.columns ?? []
  const draft = entry ? fitDraft(state.draft, columns) : emptyDraft
  const usable = pivotColumns(columns)
  const viewed = !!entry && !!results.sortOf(tabId, entry.index)?.view
  const set = (next: Partial<PivotDraft>) => pivot.setDraft(tabId, { ...draft, ...next })
  const setValue = (at: number, value: PivotValueSpec) => set({ values: draft.values.map((item, index) => index === at ? value : item) })
  const chooseAggregate = (at: number, aggregate: PivotAggregate) => {
    const current = draft.values[at]
    const column = current.column !== undefined && aggregateFits(aggregate, columns[current.column]) ? current.column
      : aggregate === 'count' ? current.column : usable.find(index => aggregateFits(aggregate, columns[index]))
    setValue(at, column === undefined ? { aggregate: 'count' } : { aggregate, column })
  }
  const chooseColumn = (at: number, event: ChangeEvent<HTMLSelectElement>) => {
    const current = draft.values[at]
    if (event.target.value === '') return setValue(at, { aggregate: 'count' })
    const column = Number(event.target.value)
    setValue(at, { aggregate: aggregateFits(current.aggregate, columns[column]) ? current.aggregate : 'count', column })
  }
  const move = (at: number, by: number) => {
    const rows = [...draft.rows]
    const [moved] = rows.splice(at, 1)
    rows.splice(at + by, 0, moved)
    set({ rows })
  }
  const anyNumeric = usable.some(index => isNumericColumn(columns[index]))
  const can = !!entry && pivot.canPivot(tabId, entry.index)
  const facts = entry ? `${formatCount(entry.descriptor.rowsStored)} ${plural(entry.descriptor.rowsStored, 'row')}${viewed ? ' as sorted and filtered' : ''}` : ''
  return <aside className="profile-panel pivot-panel" aria-label="Pivot" aria-busy={state.running || undefined}>
    <div className="profile-head">
      <span className="profile-title">Pivot</span>
      <span className="profile-facts" title={facts}>{facts}</span>
      <button type="button" className="icon-button" aria-label="Close Pivot" title="Close Pivot" onClick={() => pivot.close(tabId)}><Icon name="close" /></button>
    </div>
    <div className="pivot-body">
      <label className="pivot-field">
        <span>Source</span>
        <select aria-label="Pivot source" value={state.source} onChange={event => pivot.setSource(tabId, Number(event.target.value))}>
          {!sources.includes(entry!) && <option value={state.source}>{entry?.label ?? `Result ${state.source + 1}`}</option>}
          {sources.map(item => <option key={item.index} value={item.index}>{item.label ?? `Result ${item.index + 1}`}</option>)}
        </select>
      </label>
      <section className="pivot-section" aria-labelledby={ids + 'rows'}>
        <h3 id={ids + 'rows'}>Rows</h3>
        {draft.rows.length === 0 && <div className="pivot-hint">No row groups: the pivot is one row.</div>}
        <ul className="pivot-list">
          {draft.rows.map((column, at) => <li key={column}>
            <span className="pivot-name" title={`${nameOf(columns[column])} (${sqlTypeLabel(columns[column])})`}>{nameOf(columns[column])}</span>
            <button type="button" className="icon-button" aria-label={`Move ${nameOf(columns[column])} up`} title="Move up" disabled={at === 0} onClick={() => move(at, -1)}><Icon name="arrow-up" /></button>
            <button type="button" className="icon-button" aria-label={`Move ${nameOf(columns[column])} down`} title="Move down" disabled={at === draft.rows.length - 1} onClick={() => move(at, 1)}><Icon name="arrow-down" /></button>
            <button type="button" className="icon-button" aria-label={`Remove row group ${nameOf(columns[column])}`} title="Remove" onClick={() => set({ rows: draft.rows.filter(item => item !== column) })}><Icon name="close" /></button>
          </li>)}
        </ul>
        <select aria-label="Add row group" value="" disabled={draft.rows.length >= wire.pivot.maxRowFields}
          onChange={event => { if (event.target.value !== '') set({ rows: [...draft.rows, Number(event.target.value)] }) }}>
          <option value="">{draft.rows.length >= wire.pivot.maxRowFields ? `At most ${wire.pivot.maxRowFields} row groups` : 'Add a row group…'}</option>
          {usable.filter(column => !draft.rows.includes(column) && column !== draft.column).map(column => <option key={column} value={column}>{nameOf(columns[column])}</option>)}
        </select>
      </section>
      <section className="pivot-section" aria-labelledby={ids + 'columns'}>
        <h3 id={ids + 'columns'}>Columns</h3>
        <select aria-label="Column group" value={draft.column ?? ''} onChange={event => set({ column: event.target.value === '' ? undefined : Number(event.target.value) })}>
          <option value="">(None)</option>
          {usable.filter(column => !draft.rows.includes(column)).map(column => <option key={column} value={column}>{nameOf(columns[column])}</option>)}
        </select>
        {draft.column !== undefined && <div className="pivot-hint">A column per distinct value (up to {formatCount(wire.pivot.maxColumnGroups)}), then a Total.</div>}
      </section>
      <section className="pivot-section" aria-labelledby={ids + 'values'}>
        <h3 id={ids + 'values'}>Values</h3>
        <ul className="pivot-list">
          {draft.values.map((value, at) => <li key={at} className="pivot-value" title={valueLabel(value, columns)}>
            <select aria-label={`Value ${at + 1} aggregate`} value={value.aggregate} onChange={event => chooseAggregate(at, event.target.value as PivotAggregate)}>
              {pivotAggregates.map(item => <option key={item.aggregate} value={item.aggregate} disabled={(item.aggregate === 'sum' || item.aggregate === 'avg') && !anyNumeric}>{item.label}</option>)}
            </select>
            <select aria-label={`Value ${at + 1} column`} value={value.column ?? ''} onChange={event => chooseColumn(at, event)}>
              {value.aggregate === 'count' && <option value="">(Rows)</option>}
              {usable.map(column => <option key={column} value={column} disabled={!aggregateFits(value.aggregate, columns[column])}>{nameOf(columns[column])}</option>)}
            </select>
            <button type="button" className="icon-button" aria-label={`Remove value ${at + 1}`} title="Remove" disabled={draft.values.length === 1}
              onClick={() => set({ values: draft.values.filter((_, index) => index !== at) })}><Icon name="close" /></button>
          </li>)}
        </ul>
        <button type="button" disabled={draft.values.length >= wire.pivot.maxValues} onClick={() => set({ values: [...draft.values, { aggregate: 'count' }] })}><Icon name="add" /> Add value</button>
      </section>
    </div>
    <div className="pivot-foot">
      {state.error && <div className="profile-note error" role="status">{state.error}</div>}
      {!entry ? <div className="profile-note">Choose a result to pivot.</div>
        : !pivotable(entry) && !state.running ? <div className="profile-note">{entry.handle.getSnapshot().state === 'complete' ? 'This result cannot be pivoted.' : 'Pivot this result after it finishes loading.'}</div> : null}
      {viewed && <div className="profile-note">The pivot reads the rows as the grid shows them, sorted and filtered.</div>}
      {state.running
        ? <button type="button" onClick={() => pivot.cancel(tabId)}>Cancel</button>
        : <button type="button" className="primary" disabled={!can} onClick={() => void pivot.run(tabId)}>Build Pivot</button>}
    </div>
  </aside>
}
