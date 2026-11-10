// The Processes pane (docs/activity-monitor.md, Processes): one row per session from the sessions probe, through
// LiveGridPane (no React per row). Its toolbar sets the monitor's Processes filter (view chip, toggles, filter box, column
// value filters), which ActivityMonitorService sends as the source's args; the backend filters the sample in memory.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
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
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneWaiting } from './PaneState'

const probe = 'activity.sessions'
const sessions = tableSpecs.sessions
/** What a screen reader hears for a toned row: Processes' tones (blocked, blocking, rollback, departed, system) as words. */
const toneWords: Partial<Record<LiveTone, string>> = { error: 'blocked', warning: 'blocking others', running: 'rolling back', muted: 'system or ended session' }
export const processesToneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
export const columnCaption = (column: string): string => sessions.columns.find(item => item.id === column)?.caption ?? column
/** How many filters the toolbar has on besides the toggles: what Clear filters clears. */
export const activeFilters = (filter: ProcessesFilter): number => (filter.view === 'all' ? 0 : 1) + (filter.text.trim() ? 1 : 0) + filter.columnFilters.length

/** The status line's words: rows shown, and why the list may be short. */
export function processesStatus(rows: number | undefined, truncated: boolean, filter: ProcessesFilter, waiting: PaneWaiting = 'loading'): string {
  if (rows === undefined) return paneWaitingText[waiting]
  const hidden = [!filter.showSystem && 'system sessions', !filter.showVaria && 'Varia\'s own'].filter(Boolean).join(' and ')
  const parts = [`${formatCount(rows)} ${plural(rows, 'session')}`]
  if (activeFilters(filter) > 0) parts.push(`${activeFilters(filter)} ${plural(activeFilters(filter), 'filter')} on`)
  if (hidden) parts.push(`${hidden} hidden`)
  if (truncated) parts.push(`at most ${formatCount(sessions.rowCap)} kept; idle sessions were dropped first`)
  return parts.join(' · ')
}

export interface ValueChoice { readonly text: string; readonly count?: number; readonly checked: boolean; readonly disabled: boolean }
/**
 * A column's value checkboxes: the facet's values with their counts, then any chosen value the facets no longer list (the
 * view chip or a toggle hid its rows, or it fell out of the most frequent), so a filter on is always visible and can be
 * turned off. Past the limit of values a column filter carries, the unchosen ones are disabled rather than dropped.
 */
export function valueChoices(facet: LiveFacet | undefined, chosen: readonly string[] = []): readonly ValueChoice[] {
  const full = chosen.length >= activityLimits.columnFilterValues
  const listed = (facet?.values ?? []).map(value => ({ text: value.text, count: value.count, checked: chosen.includes(value.text), disabled: full && !chosen.includes(value.text) }))
  const unlisted = chosen.filter(text => !listed.some(value => value.text === text)).map(text => ({ text, checked: true, disabled: false }))
  return [...listed, ...unlisted]
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
  const waiting = paneWaiting(snapshot, probe)
  // A draft in the filter box counts for Clear filters, so its click is not lost to the blur that commits the draft.
  const [drafting, setDrafting] = useState(false)
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
      <FilterBox id={state.id} value={filter.text} onCommit={text => set({ text })} onDraft={setDrafting} />
      <button type="button" className="activity-tool" disabled={activeFilters(filter) === 0 && !drafting} onClick={() => activity.clearProcessesFilter(state.id)} title="Clear the view, the filter box and the column filters">
        <Icon name="clear-all" /><span>Clear filters</span>
      </button>
    </div>
    <PaneState problem={problem} hasRows={!!table} waiting={waiting}>
      <LiveGridPane live={handle} probe={probe} table={0} label="Processes" toneLabel={processesToneLabel} state={activity.gridState(state.id, 'processes')} />
    </PaneState>
    {/* Not a live region: the count changes with every sample on a busy server, and re-announcing it would be noise. */}
    <p className="activity-pane-status" aria-labelledby={labelledBy}>{processesStatus(table?.descriptor.rowsAvailable, !!table?.descriptor.truncated, filter, waiting)}</p>
  </div>
}

/** The filter box: sent when typing pauses, on Enter, or when it loses focus; Escape puts back what was sent. */
function FilterBox({ id, value, onCommit, onDraft }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void; readonly onDraft: (drafting: boolean) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  useEffect(() => onDraft(draft !== value), [draft, value, onDraft])
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

/**
 * Column value filters: a column, then its values with their counts (the facets), (Blanks) and (Non-blanks). The panel is
 * a popover in Chromium's top layer, so a short pane cannot clip it, and it closes on Escape or a click outside.
 */
function ColumnFilters({ filter, facets, onChange }: { readonly filter: ProcessesFilter; readonly facets: Readonly<Record<string, LiveFacet>> | undefined; readonly onChange: (filters: readonly ActivityColumnFilter[]) => void }) {
  const columns = sessions.facetColumns ?? []
  const id = useId()
  const [open, setOpen] = useState(false)
  const [column, setColumn] = useState(columns[0] ?? '')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const place = () => {
    const invoker = button.current, popover = panel.current
    if (!invoker || !popover) return
    const box = invoker.getBoundingClientRect()
    if (!box.width) { popover.hidePopover(); return }
    const inset = 8, gap = 4, viewport = document.documentElement
    const width = Math.min(300, viewport.clientWidth - inset * 2)
    popover.style.width = `${width}px`
    popover.style.left = `${Math.max(inset, Math.min(box.right - width, viewport.clientWidth - width - inset))}px`
    const below = Math.max(0, viewport.clientHeight - box.bottom - gap - inset), above = Math.max(0, box.top - gap - inset)
    const up = popover.scrollHeight > below && above > below
    const room = Math.min(360, up ? above : below)
    popover.style.maxHeight = `${room}px`
    popover.style.top = `${up ? box.top - gap - Math.min(popover.scrollHeight + 2, room) : box.bottom + gap}px`
  }
  useLayoutEffect(() => {
    if (!open) return
    place()
    if (document.activeElement === button.current) panel.current?.querySelector<HTMLElement>('select')?.focus()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open])
  const current = filter.columnFilters.find(item => item.column === column)
  const close = () => { panel.current?.hidePopover(); button.current?.focus() }
  const update = (next: ActivityColumnFilter | undefined) => {
    const others = filter.columnFilters.filter(item => item.column !== column)
    onChange(next && (next.values?.length || next.blanks || next.nonBlanks) ? [...others, next] : others)
  }
  const toggleValue = (text: string, on: boolean) => {
    const values = (current?.values ?? []).filter(value => value !== text)
    if (on && values.length < activityLimits.columnFilterValues) values.push(text)
    update({ ...current, column, values })
  }
  const facet = facets?.[column]
  const choices = valueChoices(facet, current?.values)
  const count = filter.columnFilters.length
  return <span className="activity-column-filters">
    <button ref={button} type="button" className="activity-tool" aria-expanded={open} aria-haspopup="dialog" aria-controls={id} popoverTarget={id} data-filtered={count > 0 ? '' : undefined}>
      <Icon name="filter" /><span>Column filters{count > 0 ? ` (${count})` : ''}</span>
    </button>
    <div ref={panel} id={id} className="activity-popover" popover="auto" role="dialog" aria-label="Column filters"
      onBeforeToggle={event => { if (event.newState === 'open') place() }}
      onToggle={event => {
        const shown = event.currentTarget.matches(':popover-open')
        setOpen(shown)
        // Escape or a click outside: focus left in the closed panel, or dropped to the body, goes back to the button.
        if (!shown && (document.activeElement === document.body || event.currentTarget.contains(document.activeElement))) button.current?.focus()
      }}>
      {open && <>
        <label className="activity-popover-row">
          <span>Column</span>
          <select value={column} onChange={event => setColumn(event.target.value)}>
            {columns.map(item => <option key={item} value={item}>{columnCaption(item)}{filter.columnFilters.some(entry => entry.column === item) ? ' (filtered)' : ''}</option>)}
          </select>
        </label>
        <div className="activity-popover-values" role="group" aria-label={`${columnCaption(column)} values`}>
          <label className="checkbox-label"><input type="checkbox" checked={!!current?.blanks} onChange={event => update({ ...current, column, blanks: event.target.checked })} />(Blanks)</label>
          <label className="checkbox-label"><input type="checkbox" checked={!!current?.nonBlanks} onChange={event => update({ ...current, column, nonBlanks: event.target.checked })} />(Non-blanks)</label>
          {choices.map(choice => <label key={choice.text} className="checkbox-label" title={choice.count === undefined ? 'Chosen, but no session shown now has this value' : undefined}>
            <input type="checkbox" checked={choice.checked} disabled={choice.disabled} onChange={event => toggleValue(choice.text, event.target.checked)} />
            <span className="activity-popover-value">{choice.text}</span><span className="activity-popover-count">{choice.count === undefined ? '—' : formatCount(choice.count)}</span>
          </label>)}
          {!facet && !choices.length && <p className="activity-note">No values yet: they arrive with the next sample.</p>}
          {facet?.more && <p className="activity-note">Only the {formatCount(facet.values.length)} most frequent values are listed.</p>}
          {(current?.values?.length ?? 0) >= activityLimits.columnFilterValues && <p className="activity-note">A column filter holds at most {formatCount(activityLimits.columnFilterValues)} values.</p>}
        </div>
        <div className="activity-popover-actions">
          <button type="button" disabled={!current} onClick={() => update(undefined)}>Clear column</button>
          <button type="button" onClick={close}>Done</button>
        </div>
      </>}
    </div>
  </span>
}
