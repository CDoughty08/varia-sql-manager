import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { displayText } from '../../../shared/explorer/refs.ts'
import { liveProbes } from '../../../shared/live/catalog'
import type { LocalTableData } from '../../../shared/results/local-table.ts'
import { messageTypeOf, operationKinds, operationKindSpecs, operationStatuses, operationTiles, runCountTypes } from '../../../shared/ssis/catalog'
import {
  durationText, executionRunning, executionSeconds, executionText, firstError, isProblems, messageEventName, problemCount, problemTypes, statusLabel, statusTone,
  toggleType, totalMessages, typeCounts, usualSeconds
} from '../../../shared/ssis/execution.ts'
import { canGoBack, canGoForward, placeName, type SsisExecutionPlace, type SsisPackagePlace, type SsisPlace } from '../../../shared/ssis/navigation.ts'
import { operationStatusOrder, operationsPresetSpecs, operationsTitle, operationsWindows, windowLabel } from '../../../shared/ssis/operations'
import type { SsisExecutionModel, SsisPackageRun } from '../../../shared/ssis/schema.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import type { CommandId } from '../core/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { LocalGrid } from '../grid/LocalGrid'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame, { type Fact, type Verb } from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError, { type ErrorAction } from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Tile, { tileName } from '../kit/Tile'
import { LiveGridPane } from '../live/LiveGridPane'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import { useMenuTarget } from '../menus/useMenuTarget'
import { gridTarget } from '../grid/anchor'
import { formatCount } from '../results/status'
import {
  filterBounds, filtered, operationsProbe, operationsText, tilePressed, toggleKind, toggleStatus, toggleTile, withText,
  type SsisOperationsEnd, type SsisOperationsFilters, type SsisOperationsState, type TextFilter
} from './SsisOperationsService'
import type { SsisPackageState, SsisPlaceError, SsisRunState } from './SsisPlacesService'
import { ssisTime } from './properties-view'
import { messagesTable, overviewRows, parametersTable, runStrip, runsTable, timeline } from './run-page'

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
 * The list: the header (where, what opened it, the live pill and the verbs), the tiles, the filter bar and the live grid of
 * operations, newest first. An execution's row opens its run page here (Open, a double-click).
 */
function ListPage({ documentId, state }: { readonly documentId: string; readonly state: SsisOperationsState }) {
  const workbench = useWorkbench()
  const service = workbench.operations
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  const menuTarget = useMenuTarget<HTMLDivElement>(() => ({ kind: 'ssisOperations', tabId: documentId }))
  if (!handle) return <EmptyState className="workspace-empty" icon="pulse" title={operationsTitle} detail="This document has closed." />
  const probe = live.probes[operationsProbe]
  const table = handle.table(operationsProbe, 0)
  const rows = table?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  const failure = !end && probe?.state === 'failing' ? probe.error?.message : undefined
  const unavailable = probe?.state === 'unavailable' ? probe.note ?? 'Integration Services Operations is not available on this server.' : undefined
  const verbs = [
    { command: 'ssis.stopOperation' as const, args: { tabId: documentId }, emphasis: 'danger' as const },
    { command: 'ssis.openExecution' as const, args: { tabId: documentId }, label: 'Open' },
    { command: 'ssis.refreshOperations' as const, args: { tabId: documentId }, label: 'Refresh' },
    { command: 'ssis.pauseOperations' as const, args: { tabId: documentId }, label: 'Pause' }
  ]
  // The pill says the view is live; the badge speaks only while its data is out of date, so the header keeps room for where it is.
  const stale = !end && (probe?.state === 'stale' || probe?.state === 'failing') ? { since: probe.lastSampleAt ?? Date.now() } : undefined
  const isFiltered = filtered(state.filters)
  return <DocumentFrame id={`ssis-operations-${documentId}`} title={operationsTitle} subtitle={operationsPresetSpecs[state.preset].title}
    state={<LivePill {...probePillStatus(live, operationsProbe, probeSpec.intervalMs.default)} />}
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
        <div className="ssis-operations-grid" ref={menuTarget} onDoubleClick={event => {
          // An execution's row opens its run page; only a row (GridView's own hit test, through its pointer layer), not a header or the area below.
          const root = (event.target as Element).closest('[role="grid"]')
          const onRow = !!root && root.ownerDocument.elementsFromPoint(event.clientX, event.clientY).some(element => root.contains(element) && gridTarget(root, element).target?.row !== undefined)
          if (onRow) void workbench.commands.execute('ssis.openExecution', { tabId: documentId }, 'toolbar')
        }}>
          {unavailable ? <EmptyState icon="pulse" title="Operations are not available" detail={unavailable} />
            : <>
              <LiveGridPane live={handle} probe={operationsProbe} label="Operations" contextMenu={false} sortable={false} state={service.gridState(documentId)} onGrid={grid => service.attachGrid(documentId, grid)} />
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

// --- Navigation --------------------------------------------------------------------------------------------------------

const runTone = (status: number): StatusTone => executionRunning(status) ? 'running' : statusTone(status) === 'error' ? 'critical' : statusTone(status) === 'warning' ? 'warning' : statusTone(status) === 'muted' ? 'neutral' : 'success'
const pathText = (...parts: readonly string[]) => parts.map(part => displayText(part)).join(' \\ ')

/**
 * Back and Forward, and where the document is: SSISDB, the package (its folder and project as text) and the run. A step
 * before the shown one is a button that goes there, as a new step after it.
 */
function NavBar({ documentId, state, run }: { readonly documentId: string; readonly state: SsisOperationsState; readonly run?: SsisExecutionModel }) {
  const { operations, commands } = useWorkbench()
  const { trail } = state
  const place = trail.places[trail.at]!
  const previous = canGoBack(trail) ? trail.places[trail.at - 1] : undefined, next = canGoForward(trail) ? trail.places[trail.at + 1] : undefined
  const step = (command: CommandId) => { void commands.execute(command, { tabId: documentId }, 'toolbar') }
  const crumb = (key: string, label: string, title: string, go?: () => void) => <li key={key} title={title}>
    {go ? <button type="button" className="link-button ssis-crumb" onClick={go}>{label}</button> : <span className="ssis-crumb" aria-current={key === 'here' ? 'page' : undefined}>{label}</span>}
  </li>
  const crumbs = [crumb('server', displayText(state.label), state.server)]
  crumbs.push(place.kind === 'list' ? crumb('here', 'SSISDB', 'SSISDB, the Integration Services Catalog') : crumb('catalog', 'SSISDB', 'Go to the catalog\'s operations', () => operations.go(documentId, { kind: 'list' })))
  const where = place.kind === 'package' ? place : run ? { folder: run.overview.folder, project: run.overview.project, package: run.overview.package } : undefined
  if (where) {
    crumbs.push(crumb('folder', displayText(where.folder), where.folder), crumb('project', displayText(where.project), where.project))
    crumbs.push(place.kind === 'package' ? crumb('here', displayText(where.package), where.package)
      : crumb('package', displayText(where.package), `Go to ${where.package}'s runs`, () => operations.go(documentId, { kind: 'package', folder: where.folder, project: where.project, package: where.package })))
  }
  if (place.kind === 'execution') crumbs.push(crumb('here', `Execution ${place.executionId}`, `Execution ${place.executionId}`))
  return <nav className="ssis-navbar" aria-label="Integration Services history">
    <button type="button" className="ssis-nav-button" aria-label="Back" disabled={!previous} title={previous ? `Back to ${placeName(previous)}` : 'Back'} onClick={() => step('ssis.goBack')}><Icon name="arrow-left" /></button>
    <button type="button" className="ssis-nav-button" aria-label="Forward" disabled={!next} title={next ? `Forward to ${placeName(next)}` : 'Forward'} onClick={() => step('ssis.goForward')}><Icon name="arrow-right" /></button>
    <ol className="ssis-crumbs" aria-label="Location">{crumbs.flatMap((item, index) => index === 0 ? [item] : [<li key={`sep-${index}`} className="ssis-crumb-separator" aria-hidden="true"><Icon name="chevron-right" /></li>, item])}</ol>
    <span className="ssis-nav-position">{trail.at + 1} of {trail.places.length}</span>
  </nav>
}

/** A page's scroll position, kept as the user leaves it and put back when Back or Forward returns to it. */
function usePageScroll(key: string) {
  const { ssisPlaces } = useWorkbench()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = ssisPlaces.scrollOf(key) }, [ssisPlaces, key])
  return { ref, onScroll: () => { if (ref.current) ssisPlaces.keepScroll(key, ref.current.scrollTop) } }
}

/** A page read's state in the header: reading, gone, failed, out of date, or what it shows (`shown`). */
function readState(read: SsisRunState | SsisPackageState | undefined, connected: boolean, shown?: ReactNode): ReactNode {
  if (!read || (read.loading && !read.model)) return <StatusPill tone="running" label="Loading" />
  if (read.loading) return <StatusPill tone="running" label="Refreshing" />
  if (read.gone) return <StatusPill tone="critical" label={read.error?.code === 'CATALOG_MISSING' ? 'Catalog missing' : read.error?.code === 'NOT_SUPPORTED' ? 'Not supported' : 'Not found'} title={read.error?.message} />
  if (!connected) return <StatusPill tone="warning" label="Disconnected" />
  if (read.error && read.model && read.loadedAt !== undefined) return <StaleBadge updatedAt={read.loadedAt} stale={{ since: read.loadedAt }} />
  if (read.error) return <StatusPill tone="critical" label="Failed" title={read.error.message} />
  return shown
}
/** Why a page has nothing (or old rows) to show, with Retry where a second read may get past it and Back where it cannot. */
function ReadProblem({ error, gone, connected, server, context, onRetry, onBack }: {
  readonly error?: SsisPlaceError; readonly gone: boolean; readonly connected: boolean; readonly server: string; readonly context: string; readonly onRetry: () => void; readonly onBack?: () => void
}) {
  if (!connected) return <p className="ssis-properties-note" role="status">{executionText.disconnected(server)}</p>
  if (!error) return null
  const actions: ErrorAction[] = gone ? onBack ? [{ label: 'Back', run: onBack }] : [] : error.retryable ? [{ label: 'Retry', run: onRetry }] : []
  return <InlineError message={error.code === 'CATALOG_MISSING' ? executionText.noCatalog : error.message} code={error.code} details={error.details} context={context} actions={actions} role="status" />
}

// --- The run strip and the task timeline -------------------------------------------------------------------------------

/** The package's recent runs as bars, oldest first, with the usual duration's line; a bar opens its run here. */
function RunStrip({ runs, current, now, label, onOpen }: { readonly runs: readonly SsisPackageRun[]; readonly current?: number; readonly now?: string; readonly label: string; readonly onOpen: (id: number) => void }) {
  const { bars, usual, usualAt } = runStrip(runs, current ?? -1, now)
  if (bars.length === 0) return null
  return <div className="ssis-run-strip">
    <span className="ssis-strip-label">{label}</span>
    <div className="ssis-spark" role="group" aria-label="Recent runs">
      {bars.map(bar => <button key={bar.id} type="button" className="ssis-spark-bar" title={bar.label} aria-label={bar.label} aria-current={bar.current ? 'true' : undefined} disabled={bar.current}
        data-failed={bar.failed ? '' : undefined} data-running={bar.running ? '' : undefined} style={{ height: `${Math.max(3, Math.round(bar.height * 40))}px` }} onClick={() => onOpen(bar.id)} />)}
      {usualAt !== undefined && <b className="ssis-spark-usual" aria-hidden="true" style={{ bottom: `${Math.round(usualAt * 40)}px` }} />}
    </div>
    <span className="ssis-strip-note">{usual === undefined ? 'No earlier run succeeded.' : `Usual ${durationText(usual)}, the median of the succeeded runs.`} Choose a bar to open that run.</span>
  </div>
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(2)}%`
/** The run's tasks against its time: each bar from its start to its end, the dashed tick at its usual end; a task's name
 *  filters the messages to it. */
function Timeline({ model, source, onTask }: { readonly model: SsisExecutionModel; readonly source?: string; readonly onTask: (name: string) => void }) {
  const rows = useMemo(() => timeline(model), [model])
  if (rows.length === 0) return <p className="ssis-properties-note">The catalog recorded no tasks for this run. Its logging level may be None.</p>
  return <div className="ssis-timeline" role="table" aria-label="Tasks">
    <div role="row" className="ssis-timeline-head">
      <span role="columnheader">Task</span><span role="columnheader">Timeline (dashed: usual end)</span><span role="columnheader">This run</span><span role="columnheader">Against usual</span>
    </div>
    {rows.map(row => <div key={row.path} role="row" className="ssis-timeline-row" data-failed={row.failed ? '' : undefined}>
      <span role="cell" className="ssis-task-cell" style={{ paddingInlineStart: `${row.depth * 12}px` }}>
        <button type="button" className="ssis-task" aria-pressed={source === row.name} title={source === row.name ? 'Show every task\'s messages' : `Show only ${row.name}'s messages`} onClick={() => onTask(row.name)}>
          {displayText(row.name)}{row.runs > 1 && <span className="ssis-task-runs" title={`Ran ${row.runs} times`}>{row.runs} runs</span>}
        </button>
      </span>
      <span role="cell" className="ssis-track">
        {row.left !== undefined && <i style={{ left: percent(row.left), width: percent(Math.max(row.width ?? 0, 0.004)) }} />}
        {row.usualEnd !== undefined && <b style={{ left: percent(row.usualEnd) }} />}
      </span>
      <span role="cell" className="ssis-task-duration">{row.left === undefined ? 'Not run' : row.duration}</span>
      <span role="cell" className="ssis-task-delta" data-tone={row.failed ? 'error' : row.slower ? 'warning' : undefined}>{row.delta}</span>
    </div>)}
  </div>
}

// --- The package page ----------------------------------------------------------------------------------------------------

const tables = new WeakMap<object, LocalTableData>()
const tableOf = (owner: object, build: () => LocalTableData): LocalTableData => {
  let table = tables.get(owner)
  if (!table) tables.set(owner, table = build())
  return table
}

/** One package's runs: its facts, the run strip and every run the catalog keeps in a core grid; a row opens its run here. */
function PackagePage({ documentId, state, place }: { readonly documentId: string; readonly state: SsisOperationsState; readonly place: SsisPackagePlace }) {
  const { operations, ssisPlaces } = useWorkbench()
  const read = ssisPlaces.package(place.key)
  const connected = operations.connected(documentId)
  const scroll = usePageScroll(place.key)
  const model = read?.model
  const open = (executionId: number) => operations.go(documentId, { kind: 'execution', executionId })
  const failed = model?.runs.filter(run => run.status === 4 || run.status === 6).length ?? 0
  const usual = model ? usualSeconds(model.runs) : undefined
  const last = model?.runs[0]
  const facts: Fact[] = model ? [
    { label: 'Runs', value: model.runs.length.toLocaleString('en-US') + (model.truncated ? '+' : '') }, { label: 'Failed', value: failed.toLocaleString('en-US') },
    { label: 'Usual duration', value: usual === undefined ? '—' : durationText(usual), title: 'The median of the succeeded runs' },
    ...last ? [{ label: 'Last execution', value: `${ssisTime(last.started ?? last.created)} ${statusLabel(last.status)}` }] : []
  ] : []
  const verbs: Verb[] = [{ command: 'ssis.refreshOperations', args: { tabId: documentId }, label: 'Refresh' }]
  const tools = last && <button type="button" className="ssis-tool" onClick={() => open(last.id)} title={`Open execution ${last.id}`}>Last execution<Icon name="arrow-right" /></button>
  const body = <div className="ssis-page" ref={scroll.ref} onScroll={scroll.onScroll} data-ssis-page="package">
    <ReadProblem error={read?.error} gone={!!read?.gone} connected={connected} server={state.label} context={`Reading ${place.package}'s runs on ${state.label}`}
      onRetry={() => operations.refreshPlace(documentId)} onBack={canGoBack(state.trail) ? () => operations.step(documentId, -1) : undefined} />
    {!model ? !read?.gone && <Skeleton rows={6} label={`Reading ${place.package}'s runs`} /> : <>
      <RunStrip runs={model.runs.slice(0, ssisRunStrip)} now={model.now} label={`The last ${Math.min(model.runs.length, ssisRunStrip)} runs of ${place.package}`} onOpen={open} />
      <div className="ssis-page-grid">
        <LocalGrid table={tableOf(model, () => runsTable(model.runs))} label="Runs" preset="page" filterable empty={operationsText.noRuns(place.package)} suggestedName={`${place.package}-Runs`}
          state={read!.grid} onActivateRow={row => { const run = model.runs[row]; if (!run) return false; open(run.id); return true }} />
      </div>
      {model.truncated && <p className="ssis-properties-note" role="status">Showing the newest {model.runs.length.toLocaleString('en-US')} runs; older ones are left out.</p>}
    </>}
  </div>
  return <DocumentFrame id={`ssis-operations-${documentId}`} title={place.package} subtitle={pathText(place.folder, place.project)} state={readState(read, connected)}
    tools={tools} verbs={verbs} facts={facts} body={body} attributes={{ 'data-ssis-operations': documentId }} />
}
/** The bars the package page's strip draws: as many as a run page's. */
const ssisRunStrip = 16

// --- The run page ------------------------------------------------------------------------------------------------------

const sum = (model: SsisExecutionModel, types: readonly number[]) => model.counts.filter(item => types.includes(item.type)).reduce((total, item) => total + item.count, 0)
const eventIcon = (type: number) => type === 120 || type === 130 ? 'error' as const : type === 110 ? 'warning' as const : undefined

/**
 * One run on one scroll: its facts; what failed; this run against the package's recent runs; the task timeline (a task filters
 * the messages); every message of the chosen SSIS events in a core grid, the first error pinned above it; and its details and
 * parameters folded at the end. The chips and the task are this step's, so Back shows the page as it was left.
 */
function RunPage({ documentId, state, place }: { readonly documentId: string; readonly state: SsisOperationsState; readonly place: SsisExecutionPlace }) {
  const { operations, ssisPlaces } = useWorkbench()
  const read = ssisPlaces.run(place.key)
  const connected = operations.connected(documentId)
  const scroll = usePageScroll(place.key)
  const model = read?.model
  const set = (change: { readonly types?: readonly number[] | null; readonly source?: string | null }) => operations.setRunFilters(documentId, change)
  const open = (executionId: number) => operations.go(documentId, { kind: 'execution', executionId })
  const messages = useMemo(() => model ? messagesTable(model.messages) : undefined, [model])
  const parameters = useMemo(() => model ? parametersTable(model.parameters) : undefined, [model])
  const verbs: Verb[] = [{ command: 'ssis.refreshOperations', args: { tabId: documentId }, label: 'Refresh' }]
  if (!model) {
    const body = <div className="ssis-page" data-ssis-page="execution">
      <ReadProblem error={read?.error} gone={!!read?.gone} connected={connected} server={state.label} context={`Reading execution ${place.executionId} on ${state.label}`}
        onRetry={() => operations.refreshPlace(documentId)} onBack={canGoBack(state.trail) ? () => operations.step(documentId, -1) : undefined} />
      {!read?.gone && <Skeleton rows={8} label={`Reading execution ${place.executionId}`} />}
    </div>
    return <DocumentFrame id={`ssis-operations-${documentId}`} title={`Execution ${place.executionId}`} state={readState(read, connected)} verbs={verbs} body={body} attributes={{ 'data-ssis-operations': documentId }} />
  }
  const { overview } = model
  const at = model.runs.findIndex(run => run.id === overview.id)
  const older = at >= 0 ? model.runs[at + 1] : undefined
  const usual = usualSeconds(model.runs, overview.id)
  const duration = durationText(executionSeconds(overview))
  const environment = overview.environment ? `${overview.environmentFolder ?? '.'}\\${overview.environment}` : ''
  const errors = sum(model, runCountTypes.errors), warnings = sum(model, runCountTypes.warnings)
  const facts: Fact[] = [
    { label: 'Started', value: ssisTime(overview.started ?? overview.created) || '—' },
    { label: 'Duration', value: (duration || '—') + (usual !== undefined && duration ? ` (usual ${durationText(usual)})` : '') },
    { label: 'Errors', value: errors.toLocaleString('en-US') }, { label: 'Warnings', value: warnings.toLocaleString('en-US') },
    { label: 'Caller', value: displayText(overview.caller), title: overview.caller },
    ...environment ? [{ label: 'Environment', value: displayText(environment), title: environment }] : []
  ]
  const tools = <>
    <button type="button" className="ssis-tool" disabled={!older} title={older ? `Execution ${older.id}, the run of ${overview.package} before this one` : 'No earlier run'} onClick={() => older && open(older.id)}><Icon name="arrow-left" />Older run</button>
    <button type="button" className="ssis-tool" disabled={model.newer === undefined} title={model.newer === undefined ? 'No later run' : `Execution ${model.newer}, the run of ${overview.package} after this one`} onClick={() => model.newer !== undefined && open(model.newer)}>Newer run<Icon name="arrow-right" /></button>
  </>
  const rows = timeline(model)
  const failedAt = rows.filter(row => row.failed && row.depth > 0).map(row => row.name)
  const notRun = rows.filter(row => row.left === undefined && row.depth > 0).map(row => row.name)
  const failedRun = overview.status === 4 || overview.status === 6
  const counts = typeCounts(model), total = totalMessages(model), problems = problemCount(model)
  const pinned = firstError(model.messages)
  const shown = model.messages.length
  const body = <div className="ssis-page" ref={scroll.ref} onScroll={scroll.onScroll} data-ssis-page="execution">
    <ReadProblem error={read!.error} gone={read!.gone} connected={connected} server={state.label} context={`Reading execution ${place.executionId} on ${state.label}`}
      onRetry={() => operations.refreshPlace(documentId)} onBack={canGoBack(state.trail) ? () => operations.step(documentId, -1) : undefined} />
    {failedRun && <div className="ssis-callout" role="note" data-tone="error">
      <Icon name="error" />
      <span><b>{failedAt.length ? `Failed at ${failedAt.join(', ')}` : statusLabel(overview.status)}</b>{duration && ` after ${duration}`} · {errors.toLocaleString('en-US')} {errors === 1 ? 'error' : 'errors'}{notRun.length > 0 && ` · ${notRun.join(', ')} did not run.`}</span>
    </div>}
    {executionRunning(overview.status) && <p className="ssis-properties-note" role="status">{executionText.running}</p>}
    <RunStrip runs={model.runs} current={overview.id} now={overview.now} label={`This run against the last ${model.runs.length} runs of ${overview.package}`} onOpen={open} />
    <h2 className="ssis-section-title">Tasks</h2>
    <Timeline model={model} source={place.source} onTask={name => set({ source: place.source === name ? null : name })} />
    {model.tasksTruncated && <p className="ssis-properties-note">Showing the first {model.tasks.length.toLocaleString('en-US')} tasks.</p>}
    <h2 className="ssis-section-title">Messages</h2>
    {pinned && <div className="ssis-callout" role="note" data-tone="error">
      <Icon name="error" />
      <span className="ssis-callout-text"><b>First error</b> · {ssisTime(pinned.time)} · {displayText(pinned.source ?? overview.package)}{pinned.path && <span className="ssis-callout-where"> {displayText(pinned.path)}</span>}<br />{displayText(pinned.message)}</span>
      {!(place.types?.length === 1 && place.types[0] === 120) && <button type="button" className="ssis-tool" onClick={() => set({ types: [120] })}>Show errors</button>}
    </div>}
    <div className="ssis-filter-row">
      <span className="ssis-filter-label" aria-hidden="true">Event</span>
      <ChipGroup label="Message events">
        <Chip label="All" count={total} pressed={place.types === undefined} disabled={!connected} onToggle={() => set({ types: null })} />
        {problems > 0 && <Chip label="Problems" count={problems} icon="warning" pressed={isProblems(place.types)} disabled={!connected} title="Warnings, errors and failed tasks"
          onToggle={() => set({ types: isProblems(place.types) ? null : problemTypes })} />}
        {counts.map(({ type, count }) => {
          const icon = eventIcon(type)
          return <Chip key={type} label={messageEventName(type)} count={count} {...icon ? { icon } : {}} pressed={place.types?.includes(messageTypeOf(type)) ?? false} disabled={!connected}
            title={`${messageEventName(type)} messages (message type ${type})`} onToggle={() => set({ types: toggleType(place.types, type) ?? null })} />
        })}
        {place.source && <Chip label={`Task: ${displayText(place.source)}`} pressed icon="close" disabled={!connected} title="Show every task's messages" onToggle={() => set({ source: null })} />}
      </ChipGroup>
    </div>
    <div className="ssis-run-messages">
      <LocalGrid table={messages!} label="Messages" preset="page" filterable empty={total === 0 ? executionText.noMessages : executionText.noMatch}
        suggestedName={`Execution ${overview.id}-Messages`} state={read!.grids.messages} />
    </div>
    <p className="ssis-properties-note" role="status">
      {model.truncated ? executionText.truncated(shown) : `${shown.toLocaleString('en-US')} ${shown === 1 ? 'message' : 'messages'}, newest first.`} {executionText.cut}
    </p>
    <details className="ssis-run-details">
      <summary className="ssis-section-title">Details: environment, executed as, server and the parameters used</summary>
      <dl className="ssis-properties ssis-execution-overview" aria-label="Details">
        {overviewRows(overview, usual).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}><bdi>{value === '' ? <span className="ssis-properties-none"><span aria-hidden="true">—</span><span className="visually-hidden">None</span></span> : displayText(value)}</bdi></dd></div>)}
      </dl>
      <h3 className="ssis-subsection-title">Parameters used</h3>
      {model.parameters.length === 0 ? <p className="ssis-properties-note">The catalog recorded no parameter values for this run.</p>
        : <LocalGrid table={parameters!} label="Parameters used" preset="page" fit filterable suggestedName={`Execution ${overview.id}-Parameters`} state={read!.grids.parameters} />}
    </details>
  </div>
  return <DocumentFrame id={`ssis-operations-${documentId}`} title={`Execution ${overview.id}`} subtitle={pathText(overview.folder, overview.project, overview.package)}
    state={readState(read, connected, <StatusPill tone={runTone(overview.status)} label={statusLabel(overview.status)} />)} tools={tools} verbs={verbs} facts={facts} body={body}
    attributes={{ 'data-ssis-operations': documentId }} />
}

// --- The document ------------------------------------------------------------------------------------------------------

/**
 * An Integration Services document: one per connection, drilling in place from the catalog's operations (the list) to a
 * package's runs and one run's page, under a bar with Back, Forward and where it is. Back and Forward also come from Alt+Left
 * and Alt+Right (Cmd+[ and Cmd+] on macOS) and the mouse's back and forward buttons. Its services keep every state; this only
 * draws it.
 */
export default function SsisOperations({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.operations
  const { documents } = useServiceSnapshot(service)
  useServiceSnapshot(service.context)
  useServiceSnapshot(workbench.ssisPlaces)
  const state = documents[documentId]
  if (!state) return <EmptyState className="workspace-empty" icon="pulse" title={operationsTitle} detail="This document has closed." />
  const place: SsisPlace = state.trail.places[state.trail.at]!
  const run = place.kind === 'execution' ? workbench.ssisPlaces.run(place.key)?.model : undefined
  // The mouse's back (3) and forward (4) buttons walk the history, as in a browser (gestures ssis.mouseBack, ssis.mouseForward).
  const mouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 3 && event.button !== 4) return
    event.preventDefault()
    void workbench.commands.execute(event.button === 3 ? 'ssis.goBack' : 'ssis.goForward', { tabId: documentId }, 'toolbar')
  }
  return <div className="ssis-document" data-ssis-place={place.kind} onMouseUp={mouseUp}>
    <NavBar documentId={documentId} state={state} run={run} />
    {place.kind === 'list' ? <ListPage documentId={documentId} state={state} />
      : place.kind === 'package' ? <PackagePage key={place.key} documentId={documentId} state={state} place={place} />
      : <RunPage key={place.key} documentId={documentId} state={state} place={place} />}
  </div>
}
