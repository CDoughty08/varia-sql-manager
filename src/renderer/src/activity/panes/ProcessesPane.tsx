// The Processes pane (docs/activity-monitor.md, Processes): one row per session from the sessions probe, through
// LiveGridPane (no React per row). Its toolbar sets the monitor's Processes filter (view chip, toggles, filter box, column
// value filters), which ActivityMonitorService sends as the source's args; the backend filters the sample in memory.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { activityLimits, sessionToggles, tableSpecs, viewChipNotes, viewChipTitles, viewChips } from '../../../../shared/activity/catalog'
import type { ActivityColumnFilter } from '../../../../shared/activity/schema'
import type { LiveTone } from '../../../../shared/live/catalog'
import type { LiveFacet } from '../../../../shared/live/schema'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import { Chip, ChipGroup } from '../../kit/Chip'
import { LiveGridPane } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount, plural } from '../../results/status'
import type { MonitorFacts, MonitorState, ProcessesFilter } from '../ActivityMonitorService'
import PaneState, { paneProblem } from './PaneState'

const probe = 'activity.sessions'
const sessions = tableSpecs.sessions
/** What a screen reader hears for a toned row: Processes' tones (blocked, blocking, rollback, departed, system) as words. */
const toneWords: Partial<Record<LiveTone, string>> = { error: 'blocked', warning: 'blocking others', running: 'rolling back', muted: 'system or ended session' }
export const processesToneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
export const columnCaption = (column: string): string => sessions.columns.find(item => item.id === column)?.caption ?? column
/** How many filters the toolbar has on besides the toggles: what Clear filters clears. */
export const activeFilters = (filter: ProcessesFilter): number => (filter.view === 'all' ? 0 : 1) + (filter.text.trim() ? 1 : 0) + filter.columnFilters.length

/** The status line's words: rows shown, and why the list may be short. */
export function processesStatus(rows: number | undefined, truncated: boolean, filter: ProcessesFilter): string {
  if (rows === undefined) return 'Waiting for the first sample…'
  const hidden = [!filter.showSystem && 'system sessions', !filter.showVaria && 'Varia\'s own'].filter(Boolean).join(' and ')
  const parts = [`${formatCount(rows)} ${plural(rows, 'session')}`]
  if (activeFilters(filter) > 0) parts.push(`${activeFilters(filter)} ${plural(activeFilters(filter), 'filter')} on`)
  if (hidden) parts.push(`${hidden} hidden`)
  if (truncated) parts.push(`at most ${formatCount(sessions.rowCap)} kept; idle sessions were dropped first`)
  return parts.join(' · ')
}

export default function ProcessesPane({ state, handle, snapshot, facts, labelledBy }: {
  readonly state: MonitorState
  readonly handle: LiveHandle
  readonly snapshot: LiveSnapshot
  readonly facts: MonitorFacts
  readonly labelledBy: string
}) {
  const { activity } = useWorkbench()
  const filter = state.processes
  const table = handle.table(probe, 0)
  const problem = paneProblem(snapshot.probes[probe], 0)
  const set = (change: Partial<ProcessesFilter>) => activity.setProcessesFilter(state.id, change)
  return <div className="activity-pane-content" data-activity-grid="processes">
    <div className="activity-pane-tools" role="toolbar" aria-label="Processes filters">
      <ChipGroup label="View">
        {viewChips.map(view => <Chip key={view} label={viewChipTitles[view]} title={viewChipNotes[view]} pressed={filter.view === view} onToggle={() => set({ view: filter.view === view ? 'all' : view })} />)}
      </ChipGroup>
      <span className="activity-tools-separator" aria-hidden="true" />
      <label className="checkbox-label"><input type="checkbox" checked={filter.showSystem} onChange={event => set({ showSystem: event.target.checked })} />{sessionToggles.showSystem.title}</label>
      <label className="checkbox-label"><input type="checkbox" checked={filter.showVaria} onChange={event => set({ showVaria: event.target.checked })} />{sessionToggles.showVaria.title}</label>
      <span className="activity-tools-spacer" />
      <ColumnFilters filter={filter} facets={facts.facets.sessions} onChange={columnFilters => set({ columnFilters })} />
      <FilterBox id={state.id} value={filter.text} onCommit={text => set({ text })} />
      <button type="button" className="activity-tool" disabled={activeFilters(filter) === 0} onClick={() => activity.clearProcessesFilter(state.id)} title="Clear the view, the filter box and the column filters">
        <Icon name="clear-all" /><span>Clear filters</span>
      </button>
    </div>
    <PaneState problem={problem} hasRows={!!table}>
      <LiveGridPane live={handle} probe={probe} table={0} label="Processes" toneLabel={processesToneLabel} state={activity.gridState(state.id, 'processes')} />
    </PaneState>
    <p className="activity-pane-status" role="status" aria-labelledby={labelledBy}>{processesStatus(table?.descriptor.rowsAvailable, !!table?.descriptor.truncated, filter)}</p>
  </div>
}

/** The filter box: sent when typing pauses, on Enter, or when it loses focus; Escape puts back what was sent. */
function FilterBox({ id, value, onCommit }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  // Typing settles before a filter goes out, so each keystroke is not a live.update of its own.
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => commit.current(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `activity-${id}-processes-filter`
  return <span className="activity-filter-box">
    <Icon name="search" />
    <label htmlFor={inputId} className="visually-hidden">Filter sessions</label>
    <input id={inputId} type="search" spellCheck={false} placeholder="Filter sessions" value={draft} maxLength={activityLimits.filterText}
      title={`Matches ${(sessions.textColumns ?? []).map(columnCaption).join(', ')}`} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

/** Column value filters: a column, then its values with their counts (the facets), (Blanks) and (Non-blanks). */
function ColumnFilters({ filter, facets, onChange }: { readonly filter: ProcessesFilter; readonly facets: Readonly<Record<string, LiveFacet>> | undefined; readonly onChange: (filters: readonly ActivityColumnFilter[]) => void }) {
  const columns = sessions.facetColumns ?? []
  const [open, setOpen] = useState(false)
  const [column, setColumn] = useState(columns[0] ?? '')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>('select')?.focus() }, [open])
  const current = filter.columnFilters.find(item => item.column === column)
  const close = () => { setOpen(false); button.current?.focus() }
  const update = (next: ActivityColumnFilter | undefined) => {
    const others = filter.columnFilters.filter(item => item.column !== column)
    onChange(next && (next.values?.length || next.blanks || next.nonBlanks) ? [...others, next] : others)
  }
  const toggleValue = (text: string, on: boolean) => {
    const values = new Set(current?.values ?? [])
    if (on) values.add(text)
    else values.delete(text)
    update({ ...current, column, values: [...values].slice(0, activityLimits.columnFilterValues) })
  }
  const facet = facets?.[column]
  const count = filter.columnFilters.length
  return <span className="activity-column-filters">
    <button ref={button} type="button" className="activity-tool" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} data-filtered={count > 0 ? '' : undefined}>
      <Icon name="filter" /><span>Column filters{count > 0 ? ` (${count})` : ''}</span>
    </button>
    {open && <div ref={panel} className="activity-popover" role="dialog" aria-label="Column filters" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <label className="activity-popover-row">
        <span>Column</span>
        <select value={column} onChange={event => setColumn(event.target.value)}>
          {columns.map(id => <option key={id} value={id}>{columnCaption(id)}{filter.columnFilters.some(item => item.column === id) ? ' (filtered)' : ''}</option>)}
        </select>
      </label>
      <div className="activity-popover-values" role="group" aria-label={`${columnCaption(column)} values`}>
        <label className="checkbox-label"><input type="checkbox" checked={!!current?.blanks} onChange={event => update({ ...current, column, blanks: event.target.checked })} />(Blanks)</label>
        <label className="checkbox-label"><input type="checkbox" checked={!!current?.nonBlanks} onChange={event => update({ ...current, column, nonBlanks: event.target.checked })} />(Non-blanks)</label>
        {facet?.values.map(value => <label key={value.text} className="checkbox-label">
          <input type="checkbox" checked={!!current?.values?.includes(value.text)} onChange={event => toggleValue(value.text, event.target.checked)} />
          <span className="activity-popover-value">{value.text}</span><span className="activity-popover-count">{formatCount(value.count)}</span>
        </label>)}
        {!facet && <p className="activity-note">No values yet: they arrive with the next sample.</p>}
        {facet?.more && <p className="activity-note">Only the {formatCount(facet.values.length)} most frequent values are listed.</p>}
      </div>
      <div className="activity-popover-actions">
        <button type="button" disabled={!current} onClick={() => update(undefined)}>Clear column</button>
        <button type="button" onClick={close}>Done</button>
      </div>
    </div>}
  </span>
}
