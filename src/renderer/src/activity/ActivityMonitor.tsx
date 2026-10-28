// The Activity Monitor document: a header (state, interval, chart window, cost, Pause, Refresh, Split View), eight tiles
// with sparklines, up to two expanded charts, and the panes in one or two slots. Everything it shows comes from its live
// handle and from ActivityMonitorService, which keeps the monitor's choices across tab switches; it draws, and runs
// catalogue commands or service methods, nothing else.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  activityIntervalsSeconds, activityPanes, chartWindowsMinutes, grantStatement, paneSpecs, pendingPaneNote, pendingPanes, probeSpecs, serverStatePermission, seriesSpecs, tileSpecs,
  type ActivityPane
} from '../../../shared/activity/catalog'
import type { LiveProbeId } from '../../../shared/live/catalog'
import { chartSeriesColors } from '../../../shared/theme/charts'
import type { TileTone } from '../../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { useTicker } from '../core/useTicker'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import { formatInterval } from '../kit/format'
import InlineError, { type ErrorAction } from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import StatusPill from '../kit/StatusPill'
import Tile from '../kit/Tile'
import { ChartLink, type ChartSeries, type ChartSource } from '../live/ChartView'
import { LiveChart } from '../live/LiveChart'
import type { LiveHandle, LiveSnapshot } from '../live/LiveService'
import { scaledRing, type RingReader } from '../live/ring'
import { freshness, pillStatus } from '../live/status'
import { splitLimits, type MonitorState, type PaneSlot } from './ActivityMonitorService'
import { chartScaleOf, latestValue, monitorFacts, overviewNotice, overviewProbe, seriesIndex, tileReadings, toneAnnouncement, type TileReading } from './tiles'

const noHandle = { subscribe: () => () => {}, getSnapshot: () => undefined }
/** Where the panes sit side by side: below it they stack (D-am §3.2). */
export const sideBySideWidth = 1400

export default function ActivityMonitor({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const { activity, connections } = workbench
  const state = useServiceSnapshot(activity).monitors[documentId]
  const tab = useServiceSnapshot(workbench.documents).documents.find(item => item.id === documentId)
  const connectionList = useServiceSnapshot(connections)
  const { values: settings } = useServiceSnapshot(workbench.settings)
  // A new handle comes with Retry, which bumps the generation.
  const handle = useMemo(() => activity.handle(documentId), [activity, documentId, state?.generation]) // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = useSyncExternalStore(handle?.subscribe ?? noHandle.subscribe, handle?.getSnapshot ?? noHandle.getSnapshot)
  const now = useTicker(true)
  const link = useMemo(() => new ChartLink(), [handle])
  if (!state || !handle || !snapshot) return null
  const connection = connectionList.find(item => item.id === tab?.connectionId)
  const server = connection?.displayName || connection?.server || state.server
  const ring = handle.ring(overviewProbe)
  const readings = tileReadings(ring, settings)
  const fresh = freshness(snapshot, now), pill = pillStatus(snapshot)
  const verbs = [
    { command: 'activity.togglePause', args: { tabId: documentId } },
    { command: 'activity.refresh', args: { tabId: documentId } },
    { command: 'activity.toggleSplit', args: { tabId: documentId } }
  ] as const
  return <DocumentFrame id={`activity-${documentId}`} title="Activity Monitor" crumbs={[{ label: server, title: connection ? `${connection.server} · ${connection.serverVersion}` : state.server }]}
    state={pill && <><LivePill {...pill} /><StaleBadge updatedAt={fresh.updatedAt} stale={fresh.stale} now={now} /></>}
    tools={<HeaderTools state={state} snapshot={snapshot} />} verbs={verbs} facts={monitorFacts(connection)} attributes={{ 'data-activity-monitor': documentId }}>
    <div className="activity-body">
      <Banner snapshot={snapshot} documentId={documentId} login={connection?.login} version={connection?.productVersion ?? connection?.serverVersion} edition={connection?.engineEdition} />
      <Tiles documentId={documentId} state={state} handle={handle} readings={readings} snapshot={snapshot} />
      {state.expanded.length > 0 && <section className="activity-charts" aria-label="Charts" data-activity-region="charts">
        {state.expanded.map(index => <ExpandedChart key={index} index={index} handle={handle} state={state} link={link} />)}
      </section>}
      <Panes state={state} ring={ring} />
    </div>
  </DocumentFrame>
}

/** The interval picker, the chart window and what sampling costs. */
function HeaderTools({ state, snapshot }: { readonly state: MonitorState; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const running = Object.entries(snapshot.probes).filter(([, probe]) => probe.state !== 'paused' && probe.state !== 'unavailable')
  const costs = running.filter(([, probe]) => probe.costMs !== undefined)
  const cost = costs.reduce((sum, [, probe]) => sum + probe.costMs!, 0)
  const detail = running.map(([id, probe]) => `${probeSpecs[id as keyof typeof probeSpecs]?.title ?? id}: every ${formatInterval(probe.effectiveIntervalMs)}${probe.costMs === undefined ? '' : `, last ${Math.round(probe.costMs)} ms`}`).join('\n')
  return <>
    <span className="activity-interval">
      <select aria-label="Refresh interval" value={String(state.intervalSeconds)} onChange={event => activity.setInterval(state.id, Number(event.target.value))}>
        {activityIntervalsSeconds.map(seconds => <option key={seconds} value={String(seconds)}>Every {seconds} s</option>)}
      </select>
    </span>
    <ChipGroup label="Chart window">
      {chartWindowsMinutes.map(minutes => <Chip key={minutes} label={`${minutes} min`} pressed={state.windowMinutes === minutes} title={`Charts show the last ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`} onToggle={() => activity.setWindow(state.id, minutes)} />)}
    </ChipGroup>
    {costs.length > 0 && <span className="activity-cost" title={detail}>Cost {Math.round(cost)} ms a sample</span>}
  </>
}

/** Why the monitor cannot show the server now, and what to do: one document-level message, never a modal. */
function Banner({ snapshot, documentId, login, version, edition }: { readonly snapshot: LiveSnapshot; readonly documentId: string; readonly login?: string; readonly version?: string; readonly edition?: number }) {
  const { activity, commands } = useWorkbench()
  const [copied, setCopied] = useState<boolean>()
  const retry: ErrorAction = { label: 'Retry', run: () => activity.retry(documentId) }
  if (snapshot.status === 'lost') {
    return <InlineError className="activity-banner" message={snapshot.error?.message ?? 'The SQL backend stopped, so the monitor stopped with it.'} code={snapshot.error?.code}
      actions={[{ label: 'Reconnect…', run: () => void commands.execute('connection.reconnect', undefined, 'toolbar') }]} />
  }
  if (snapshot.status === 'ended') {
    if (snapshot.ended?.ended === 'disconnected') return <InlineError className="activity-banner" role="status" copy={false} message="The server was disconnected. Open the Activity Monitor again after connecting." />
    if (snapshot.error) return <InlineError className="activity-banner" message={snapshot.error.message} code={snapshot.error.code} actions={[retry]} />
    return null
  }
  const notice = snapshot.status === 'live' || snapshot.status === 'connecting' ? overviewNotice(snapshot) : undefined
  if (!notice) return null
  if (notice.kind === 'permission') {
    const major = version ? Number.parseInt(version, 10) : undefined, permission = serverStatePermission(Number.isFinite(major) ? major : undefined, edition)
    const copy: ErrorAction[] = login ? [{ label: 'Copy GRANT statement', run: () => { void window.varia.writeClipboardText(grantStatement(login, major, edition)).then(result => setCopied(result.ok), () => setCopied(false)) } }] : []
    return <div className="activity-banner">
      <InlineError role="status" code="PERMISSION_DENIED" message={`Activity Monitor needs ${permission} to show server activity and other sessions.`} actions={[...copy, retry]} />
      {copied !== undefined && <p className="activity-note" role="status">{copied ? 'GRANT statement copied. Varia never runs it.' : 'The statement could not be copied.'}</p>}
    </div>
  }
  // A failed sample: the tiles keep their last values and the probe retries by itself, so this only says why.
  if (notice.kind === 'failing') return <InlineError className="activity-banner" role="status" code={notice.code} message={notice.message} />
  return <InlineError className="activity-banner" role="status" copy={false} message={notice.message} />
}

/** The eight tiles: SSMS's four charts first. Activating one expands its chart below. */
function Tiles({ documentId, state, handle, readings, snapshot }: { readonly documentId: string; readonly state: MonitorState; readonly handle: LiveHandle; readonly readings: readonly TileReading[]; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const tones = useRef<(TileTone | undefined)[]>([])
  const [announcement, setAnnouncement] = useState('')
  // A crossing is said once, when it happens; a tile that calms down or stays says nothing.
  useEffect(() => {
    const said = readings.flatMap((reading, index) => toneAnnouncement(reading.caption, tones.current[index], reading.tone) ?? [])
    tones.current = readings.map(reading => reading.tone)
    if (said.length) setAnnouncement(said.join(' '))
  })
  const notice = overviewNotice(snapshot)
  const missing = notice?.kind === 'permission' ? 'No permission' : notice?.kind === 'unavailable' ? 'Not available' : undefined
  return <section className="activity-tiles" aria-label="Server overview" data-activity-region="tiles">
    {tileSpecs.map((tile, index) => {
      const reading = readings[index], expanded = state.expanded.includes(index)
      return <div key={tile.caption} className="activity-tile" data-expanded={expanded ? '' : undefined} onClick={event => { if (!(event.target as Element).closest('button')) activity.toggleTile(documentId, index) }}>
        <Tile caption={reading.caption} value={reading.value} unit={reading.unit} context={missing ?? reading.context} tone={reading.tone}>
          <Sparkline handle={handle} series={tile.series} title={tile.caption} windowMinutes={state.windowMinutes} />
        </Tile>
        <button type="button" className="activity-tile-toggle" aria-pressed={expanded} aria-label={`${tile.caption} chart`} title={expanded ? 'Hide the chart' : 'Show the chart'}
          data-activity-focus={index === 0 ? '' : undefined} onClick={() => activity.toggleTile(documentId, index)}>
          <Icon name={expanded ? 'chevron-up' : 'graph-line'} />
        </button>
      </div>
    })}
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
  </section>
}

/** A ring view for a series charted in another unit than it is sent in (wait ms per second as tasks). */
function useChartHandle(handle: LiveHandle, factor: number) {
  return useMemo(() => ({
    ring: (probe: LiveProbeId): RingReader | undefined => { const ring = handle.ring(probe); return ring && scaledRing(ring, factor) },
    onTick: handle.onTick.bind(handle),
    onRings: handle.onRings.bind(handle),
    getSnapshot: handle.getSnapshot.bind(handle),
    subscribe: handle.subscribe.bind(handle)
  }) satisfies ChartSource, [handle, factor])
}

function Sparkline({ handle, series, title, windowMinutes }: { readonly handle: LiveHandle; readonly series: string; readonly title: string; readonly windowMinutes: number }) {
  const { scale, factor } = chartScaleOf(series)
  const chartHandle = useChartHandle(handle, factor)
  const entries = useMemo<ChartSeries[]>(() => [{ index: seriesIndex(series), label: title, color: chartSeriesColors[0], style: 'area' }], [series, title])
  return <LiveChart handle={chartHandle} probe={overviewProbe} title={title} series={entries} scale={scale} window={{ spanMs: windowMinutes * 60_000, end: 'live' }} variant="sparkline" labels="none" surface="tile.background" className="activity-sparkline" />
}

/** A tile's chart, expanded: its value and secondary series over the window, with axes, the linked crosshair and "View as
 *  table" (its last 60 samples). */
function ExpandedChart({ index, handle, state, link }: { readonly index: number; readonly handle: LiveHandle; readonly state: MonitorState; readonly link: ChartLink }) {
  const { activity } = useWorkbench()
  const tile = tileSpecs[index]
  const { scale, factor } = chartScaleOf(tile.series)
  const chartHandle = useChartHandle(handle, factor)
  // Secondary series in the same unit share the axis (read and write latency do not share Database I/O's MB/s).
  const series = useMemo<ChartSeries[]>(() => [tile.series, ...tile.secondary.filter(id => chartScaleOf(id).scale.unit === scale.unit && chartScaleOf(id).factor === factor)]
    .map((id, at) => ({ index: seriesIndex(id), label: seriesSpecs[id]!.label, color: chartSeriesColors[at % chartSeriesColors.length], style: at === 0 ? 'area' : 'line' })), [tile, scale.unit, factor])
  return <div className="activity-chart">
    <div className="activity-chart-head">
      <h2 className="activity-chart-title">{tile.caption}</h2>
      <button type="button" className="activity-chart-close" aria-label={`Hide the ${tile.caption} chart`} title="Hide the chart" onClick={() => activity.toggleTile(state.id, index)}><Icon name="close" /></button>
    </div>
    <LiveChart handle={chartHandle} probe={overviewProbe} title={tile.caption} series={series} scale={scale} window={{ spanMs: state.windowMinutes * 60_000, end: 'live' }} labels="axes" surface="tile.background" link={link} tableRows={60} className="activity-chart-plot" />
  </div>
}

/** The panes: one slot, or two side by side (stacked in a narrow document) with a splitter between them. */
function Panes({ state, ring }: { readonly state: MonitorState; readonly ring: RingReader | undefined }) {
  const { activity } = useWorkbench()
  const box = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWide(element.clientWidth >= sideBySideWidth)
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const orientation = wide ? 'row' : 'column'
  const blocked = latestValue(ring, 'blockedSessions')
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = box.current
    if (!element || event.button !== 0) return
    event.preventDefault()
    const bounds = element.getBoundingClientRect(), target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) => activity.setSplitRatio(state.id, wide ? (moved.clientX - bounds.left) / bounds.width : (moved.clientY - bounds.top) / bounds.height)
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end) }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  const splitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === (wide ? 'ArrowLeft' : 'ArrowUp') ? -splitLimits.step : event.key === (wide ? 'ArrowRight' : 'ArrowDown') ? splitLimits.step : undefined
    const jump = event.key === 'Home' ? splitLimits.minimum : event.key === 'End' ? splitLimits.maximum : undefined
    if (step === undefined && jump === undefined) return
    event.preventDefault()
    activity.setSplitRatio(state.id, jump ?? state.splitRatio + step!)
  }
  const first = Math.round(state.splitRatio * 1000) / 10
  return <div ref={box} className="activity-panes" data-orientation={orientation} data-split={state.split ? '' : undefined}
    style={state.split ? { [wide ? 'gridTemplateColumns' : 'gridTemplateRows']: `minmax(0, ${first}fr) auto minmax(0, ${100 - first}fr)` } : undefined}>
    <Pane state={state} slot="primary" blocked={blocked} />
    {state.split && <>
      <div className="activity-splitter" role="separator" tabIndex={0} aria-orientation={wide ? 'vertical' : 'horizontal'} aria-label="Resize the panes"
        aria-valuemin={splitLimits.minimum * 100} aria-valuemax={splitLimits.maximum * 100} aria-valuenow={Math.round(state.splitRatio * 100)} onPointerDown={drag} onKeyDown={splitterKey} />
      <Pane state={state} slot="secondary" blocked={blocked} />
    </>}
  </div>
}

/** One pane slot: a tab per pane (the badge on Blocking counts blocked sessions), and the chosen pane's body. */
function Pane({ state, slot, blocked }: { readonly state: MonitorState; readonly slot: PaneSlot; readonly blocked: number }) {
  const { activity } = useWorkbench()
  const list = useRef<HTMLDivElement>(null)
  const current = state[slot], base = `activity-${state.id}-${slot}`
  const choose = (pane: ActivityPane, focus: boolean) => {
    activity.setPane(state.id, slot, pane)
    if (focus) list.current?.querySelector<HTMLElement>(`[data-activity-pane="${pane}"]`)?.focus()
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = activityPanes.indexOf(current), last = activityPanes.length - 1
    const next = event.key === 'ArrowRight' ? Math.min(last, at + 1) : event.key === 'ArrowLeft' ? Math.max(0, at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined
    if (next === undefined) return
    event.preventDefault()
    choose(activityPanes[next], true)
  }
  return <section className="activity-pane" aria-label={slot === 'primary' ? 'First pane' : 'Second pane'} data-activity-region={slot}>
    <div ref={list} className="activity-pane-tabs" role="tablist" aria-label={slot === 'primary' ? 'First pane' : 'Second pane'} onKeyDown={keyDown}>
      {activityPanes.map(pane => <button key={pane} type="button" role="tab" id={`${base}-${pane}`} data-activity-pane={pane} aria-selected={pane === current} aria-controls={`${base}-panel`}
        tabIndex={pane === current ? 0 : -1} onClick={() => choose(pane, false)}>
        <span>{paneSpecs[pane].title}</span>
        {paneSpecs[pane].badge === 'blocked' && blocked > 0 && <StatusPill tone="critical" size="small" icon={null} label={String(Math.round(blocked))} title={`${Math.round(blocked)} blocked sessions`} />}
      </button>)}
    </div>
    <div className="activity-pane-body" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${current}`}>
      {pendingPanes.includes(current) && <EmptyState icon="pulse" title={paneSpecs[current].title} detail={pendingPaneNote(current)} />}
    </div>
  </section>
}
