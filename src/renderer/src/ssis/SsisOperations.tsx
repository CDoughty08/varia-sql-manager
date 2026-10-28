import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { liveProbes } from '../../../shared/live/catalog'
import { operationKinds, operationKindSpecs, operationStatuses, operationTiles } from '../../../shared/ssis/catalog'
import { operationStatusOrder, operationsPresetSpecs, operationsTitle, operationsWindows, windowLabel } from '../../../shared/ssis/operations'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import Tile, { tileName } from '../kit/Tile'
import { LiveGridPane } from '../live/LiveGridPane'
import type { LiveSnapshot } from '../live/LiveService'
import { pillStatus } from '../live/status'
import { useMenuTarget } from '../menus/useMenuTarget'
import { formatCount } from '../results/status'
import {
  filterBounds, filtered, operationsProbe, operationsText, tilePressed, toggleKind, toggleStatus, toggleTile, withText,
  type SsisOperationsEnd, type SsisOperationsFilters, type SsisOperationsState, type TextFilter
} from './SsisOperationsService'

const probeSpec = liveProbes[operationsProbe]
const textFields: readonly { readonly field: TextFilter; readonly label: string }[] = [
  { field: 'folder', label: 'Folder' }, { field: 'project', label: 'Project' }, { field: 'package', label: 'Package' }, { field: 'caller', label: 'Caller' }
]
const statusChips = operationStatusOrder.map(code => operationStatuses.find(status => status.code === code)!)
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const windowFieldId = (documentId: string) => `${documentId}-filter-window`

/**
 * A name filter: typing changes nothing until Enter or leaving the field (each change reads the window again on the
 * server); Escape puts back what applies.
 */
function TextField({ id, field, label, value, onCommit }: { readonly id: string; readonly field: TextFilter; readonly label: string; readonly value: string; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `${id}-filter-${field}`
  return <span className="ssis-filter-field">
    <label htmlFor={inputId}>{label}</label>
    <input id={inputId} type="text" spellCheck={false} value={draft} maxLength={filterBounds[field]} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

/** A row of chips under a label drawn for sight; the group carries the same name for assistive technology. */
function ChipRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className="ssis-filter-row">
    <span className="ssis-filter-label" aria-hidden="true">{label}</span>
    <ChipGroup label={label}>{children}</ChipGroup>
  </div>
}

/** The filter bar: kinds and statuses as chips (statuses in the tiles' order, open ones first), the names, the window and Clear filters. */
function Filters({ state, onChange, onClear }: { readonly state: SsisOperationsState; readonly onChange: (change: (filters: SsisOperationsFilters) => SsisOperationsFilters) => void; readonly onClear: () => void }) {
  const { filters, id } = state
  const windowId = windowFieldId(id)
  const windows = operationsWindows.some(choice => choice.hours === filters.windowHours) ? operationsWindows : [...operationsWindows, { hours: filters.windowHours, label: windowLabel(filters.windowHours) }].sort((a, b) => a.hours - b.hours)
  return <div className="ssis-filters" role="group" aria-label="Filters">
    <ChipRow label="Kind">
      {operationKinds.map(kind => <Chip key={kind} label={operationKindSpecs[kind].label} pressed={!!filters.kinds?.includes(kind)} onToggle={() => onChange(current => toggleKind(current, kind))} />)}
    </ChipRow>
    <ChipRow label="Status">
      {statusChips.map(status => <Chip key={status.code} label={status.label} pressed={!!filters.statuses?.includes(status.code)} onToggle={() => onChange(current => toggleStatus(current, status.code))} />)}
    </ChipRow>
    <div className="ssis-filter-fields">
      {textFields.map(({ field, label }) => <TextField key={field} id={id} field={field} label={label} value={filters[field] ?? ''} onCommit={text => onChange(current => withText(current, field, text))} />)}
      <label className="checkbox-label ssis-filter-prefix"><input type="checkbox" checked={!!filters.prefix} onChange={event => onChange(current => ({ ...current, prefix: event.target.checked }))} />Names start with</label>
      <span className="ssis-filter-field">
        <label htmlFor={windowId}>Window</label>
        <select id={windowId} value={filters.windowHours} onChange={event => { const hours = Number(event.target.value); onChange(current => ({ ...current, windowHours: hours })) }}>
          {windows.map(choice => <option key={choice.hours} value={choice.hours}>{choice.label}</option>)}
        </select>
      </span>
      <button type="button" className="ssis-filter-clear" disabled={!filtered(filters)} onClick={onClear}><Icon name="clear-all" />Clear filters</button>
    </div>
  </div>
}

/** Stop Operation's question, in the document: Escape or Keep running leaves the operation alone. */
function StopConfirm({ state, onAnswer }: { readonly state: SsisOperationsState; readonly onAnswer: (stop: boolean) => void }) {
  const keep = useRef<HTMLButtonElement>(null)
  // The safe answer has focus, so a stray Enter never stops a package.
  useEffect(() => keep.current?.focus(), [state.confirm?.id])
  if (!state.confirm) return null
  const textId = `${state.id}-stop-question`
  return <div className="ssis-confirm" role="alertdialog" aria-label="Stop Operation" aria-describedby={textId}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onAnswer(false) } }}>
    <Icon name="warning" />
    <p id={textId}>{operationsText.stopQuestion(state.confirm.name)}</p>
    <button type="button" className="danger" onClick={() => onAnswer(true)}>Stop Operation</button>
    <button type="button" ref={keep} onClick={() => onAnswer(false)}>Keep running</button>
  </div>
}

/** Why the view stopped, in place of its tiles, filters and rows: no catalog (nothing to retry here), or a failure Retry may get past. */
function Ended({ end, onRetry }: { readonly end: SsisOperationsEnd; readonly onRetry: () => void }) {
  return <div className="ssis-operations-ended">
    {end.missing
      ? <div role="status"><EmptyState icon="warning" title="No SSIS Catalog" detail={end.message} /></div>
      : <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: onRetry }]} />}
  </div>
}

/**
 * An Integration Services Operations document: the header (where, what opened it, the live pill and the verbs), the tiles,
 * the filter bar and the live grid of operations, newest first. Its service keeps every state; this only draws it.
 */
export default function SsisOperations({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.operations
  const { documents } = useServiceSnapshot(service)
  useServiceSnapshot(service.context)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  const menuTarget = useMenuTarget<HTMLDivElement>(() => ({ kind: 'ssisOperations', tabId: documentId }))
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="pulse" title={operationsTitle} detail="This document has closed." />
  const probe = live.probes[operationsProbe]
  const table = handle.table(operationsProbe, 0)
  const rows = table?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  const failure = !end && probe?.state === 'failing' ? probe.error?.message : undefined
  const unavailable = probe?.state === 'unavailable' ? probe.note ?? 'Integration Services Operations is not available on this server.' : undefined
  const verbs = [
    { command: 'ssis.stopOperation' as const, args: { tabId: documentId }, emphasis: 'danger' as const },
    { command: 'ssis.refreshOperations' as const, args: { tabId: documentId }, label: 'Refresh' },
    { command: 'ssis.pauseOperations' as const, args: { tabId: documentId }, label: 'Pause' }
  ]
  // The pill says the view is live; the badge speaks only while its data is out of date, so the header keeps room for where it is.
  const stale = !end && (probe?.state === 'stale' || probe?.state === 'failing') ? { since: probe.lastSampleAt ?? Date.now() } : undefined
  const isFiltered = filtered(state.filters)
  return <DocumentFrame id={`ssis-operations-${documentId}`} title={operationsTitle} subtitle={operationsPresetSpecs[state.preset].title}
    crumbs={[{ label: state.label }, { label: 'SSISDB', title: 'SSISDB, the Integration Services Catalog' }]}
    state={<LivePill {...pillStatus(live, operationsProbe, probeSpec.intervalMs.default)} />}
    tools={stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />} verbs={verbs} attributes={{ 'data-ssis-operations': documentId }}>
    <div className="ssis-operations">
      <StopConfirm state={state} onAnswer={stop => service.answerStop(documentId, stop)} />
      {state.notice && (state.notice.tone === 'error'
        ? <InlineError message={state.notice.text} code={state.notice.code} actions={[{ label: 'Dismiss', run: () => service.dismissNotice(documentId) }]} />
        : <div className="ssis-notice" role="status"><Icon name="info" /><span className="ssis-notice-text">{state.notice.text}</span><button type="button" aria-label="Dismiss notice" onClick={() => service.dismissNotice(documentId)}><Icon name="close" /></button></div>)}
      {end ? <Ended end={end} onRetry={() => service.refresh(documentId)} /> : <>
        {failure && <InlineError role="status" message={failure} code={probe?.error?.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
        <div className="ssis-tiles" role="group" aria-label="Operation counts">
          {operationTiles.map((tile, index) => {
            const count = state.counts?.[index]
            const value = count === null || count === undefined ? undefined : formatCount(count)
            const context = tile.lastHours ? `Last ${tile.lastHours} hours` : 'Now'
            const pressed = tilePressed(state.filters, tile)
            return <button key={tile.series} type="button" className="ssis-tile" aria-pressed={pressed} aria-label={tileName({ caption: tile.label, value, context })}
              title={pressed ? `Show every status` : `Show only ${tile.label.toLowerCase()} operations`} onClick={() => service.update(documentId, filters => toggleTile(filters, tile))}>
              <Tile caption={tile.label} value={value} context={context} />
            </button>
          })}
        </div>
        <Filters state={state} onChange={change => service.update(documentId, change)} onClear={() => service.clearFilters(documentId)} />
        <div className="ssis-operations-grid" ref={menuTarget}>
          {unavailable ? <EmptyState icon="pulse" title="Operations are not available" detail={unavailable} />
            : <>
              <LiveGridPane live={handle} probe={operationsProbe} label="Operations" state={service.gridState(documentId)} onGrid={grid => service.attachGrid(documentId, grid)} />
              {rows === 0 && <EmptyState className="ssis-operations-empty" icon="pulse"
                title={isFiltered ? 'No operations match the filters' : `No operations in the ${windowLabel(state.filters.windowHours).toLowerCase()}`}
                detail="The catalog shows each login only the operations it has permission to read."
                actions={isFiltered ? [{ label: 'Clear filters', run: () => service.clearFilters(documentId), primary: true }]
                  : [{ label: 'Choose window', run: () => document.getElementById(windowFieldId(documentId))?.focus() }]} />}
            </>}
        </div>
      </>}
    </div>
  </DocumentFrame>
}
