// The Activity Monitor documents (docs/activity-monitor.md): one per connection, each a renderer-only tab whose content
// is one live subscription to the `activity` source. The service keeps each monitor's choices (interval, chart window,
// panes, expanded charts, Pause) outside React, so a tab switch remounts the view without losing them, and keeps the
// subscription in step with them: a probe runs only while a pane that reads it is shown, and the live layer pauses the
// whole view while its tab is hidden.
import {
  activityLiveProbes, activityPanes, chartWindowsMinutes, defaultChartWindowMinutes, defaultPanes, paneProbes, probeIntervalMs, tileSpecs,
  activityIntervalsSeconds, activityIntervalDefaults, activityLimits, probeSpecs, sessionToggles, viewChips, type ActivityPane, type ActivityProbe, type ActivityTable, type ChartWindowMinutes, type ViewChip
} from '../../../shared/activity/catalog'
import type { ActivityColumnFilter, ActivityDetailsResult } from '../../../shared/activity/schema'
import type { VariaApi } from '../../../shared/contracts'
import type { LiveRowActions } from '../menus/targets'
import { killOffer, killReport, sameSession, type KillReport, type SessionRef } from './session-actions'
import type { LiveFacet, LiveArgs } from '../../../shared/live/schema'

/** The activity source's args as the live layer sends them (src/shared/activity/schema.ts's ActivityLiveArgs, mutable). */
type ActivityArgs = Extract<LiveArgs, { focusSession?: number }>
type ActivityFilterArgs = NonNullable<ActivityArgs['filters']>[number]
import type { LiveGridState } from '../live/LiveGrid'
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { ActivityContextState } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { AppliedTick, LiveHandle, LiveOwner, LiveSpec } from '../live/LiveService'
import type { ConnectionService } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { TileTone } from '../../../shared/theme/tones'
import { crossings, type TileReading } from './tiles'

/** A monitor's two pane slots: the first, and the one split view adds. */
export type PaneSlot = 'primary' | 'secondary'
export interface MonitorState {
  readonly id: string
  /** The server it was opened on: a reconnect moves it only to a connection to that server. */
  readonly server: string
  readonly intervalSeconds: number
  readonly windowMinutes: ChartWindowMinutes
  /** Pause: no SQL until Resume (SSMS's meaning); the charts keep their history and show a gap. */
  readonly paused: boolean
  readonly split: boolean
  readonly primary: ActivityPane
  readonly secondary: ActivityPane
  /** The first pane's share of the panes area in split view. */
  readonly splitRatio: number
  /** Tiles whose chart is expanded (tileSpecs indexes), in the order they were expanded; any number of them. */
  readonly expanded: readonly number[]
  /** Bumps when the monitor subscribes again (Retry), so the view takes the new handle. */
  readonly generation: number
  /** Sessions' view chip, Show chips, filter box and column value filters, sent as the source's args (the backend filters). */
  readonly processes: ProcessesFilter
  /** The Details flyout, while it is open (nonmodal: the monitor goes on sampling beside it). */
  readonly details?: DetailsPanel
  /** Kill Process's confirm, while it asks or runs. */
  readonly kill?: KillPanel
  /** What the last Kill Process answered, until dismissed or the next Kill. */
  readonly killReport?: KillReport & { readonly id: number }
}
/** The Details flyout's session and what its last read answered. */
export interface DetailsPanel {
  readonly session: SessionRef
  /** loading: a read (the first, Refresh or Load locks) runs; ready: `result` came back (its state may say the session
   *  left); failed: the request itself failed (`error`). */
  readonly status: 'loading' | 'ready' | 'failed'
  readonly result?: ActivityDetailsResult
  readonly error?: string
  /** Load locks: the costly read the user asks for. */
  readonly locks: 'none' | 'loading' | 'loaded'
  /** Bumps on each read, so an older answer never replaces a newer one. */
  readonly read: number
}
export interface KillPanel {
  readonly session: SessionRef
  readonly phase: 'confirm' | 'running'
}
export interface ProcessesFilter {
  readonly view: ViewChip
  readonly showSystem: boolean
  readonly showVaria: boolean
  readonly text: string
  /** One per facet column, each with at least one choice. */
  readonly columnFilters: readonly ActivityColumnFilter[]
}
export const defaultProcessesFilter: ProcessesFilter = { view: 'all', showSystem: sessionToggles.showSystem.default, showVaria: sessionToggles.showVaria.default, text: '', columnFilters: [] }

/** What the samples told a monitor beyond its rows: each table's facets (column → values with counts, merged as they
 *  change) and the sessions probe's status values (serverState, canKill), until it subscribes again. */
export interface MonitorFacts {
  readonly facets: { readonly [T in ActivityTable]?: Readonly<Record<string, LiveFacet>> }
  readonly status: Readonly<Record<string, number | string>>
}
export interface ActivityFactsSnapshot { readonly byMonitor: Readonly<Record<string, MonitorFacts>> }
const noFacts: MonitorFacts = { facets: {}, status: {} }

/** A Sessions filter as the backend's `ActivityFilter` (src/shared/activity/schema.ts), bounded as the schema bounds it. */
export function processesActivityFilter(filter: ProcessesFilter): ActivityFilterArgs {
  const text = filter.text.trim().slice(0, activityLimits.filterText)
  const columnFilters = filter.columnFilters.filter(column => column.values?.length || column.blanks || column.nonBlanks).slice(0, activityLimits.columnFilters)
    .map(column => ({
      column: column.column,
      ...column.values?.length ? { values: column.values.slice(0, activityLimits.columnFilterValues).map(value => value.slice(0, activityLimits.columnFilterChars)) } : {},
      ...column.blanks ? { blanks: true } : {}, ...column.nonBlanks ? { nonBlanks: true } : {},
      // An excluding filter names the values it leaves out; without them it would exclude nothing, so it is never sent bare.
      ...column.exclude && column.values?.length && !column.nonBlanks ? { exclude: true } : {}
    }))
  return { table: 'sessions', view: filter.view, showSystem: filter.showSystem, showVaria: filter.showVaria, ...text ? { text } : {}, ...columnFilters.length ? { columnFilters } : {} }
}
/** The monitor's live args: Sessions' filter (the other tables keep the catalogue's defaults until their panes filter). */
export const monitorArgs = (state: Pick<MonitorState, 'processes'>): ActivityArgs => ({ filters: [processesActivityFilter(state.processes)] })

/** Merges a sample's facets (only the columns whose values changed come) into what the monitor knew. */
export function mergeFacets(known: Readonly<Record<string, LiveFacet>> | undefined, changed: readonly LiveFacet[]): Readonly<Record<string, LiveFacet>> {
  const next: Record<string, LiveFacet> = { ...known }
  for (const facet of changed) next[facet.column] = facet
  return next
}
export interface ActivityMonitorSnapshot { readonly monitors: Readonly<Record<string, MonitorState>> }

export const splitLimits = { minimum: 0.25, maximum: 0.75, default: 0.55, step: 0.05 } as const
const clampRatio = (ratio: number) => Number.isFinite(ratio) ? Math.round(Math.min(splitLimits.maximum, Math.max(splitLimits.minimum, ratio)) * 100) / 100 : splitLimits.default
export const monitorTitle = (server: string) => `${server} - Activity Monitor`

export interface ActivityMonitorServiceOptions {
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot'>
  readonly connections: Pick<ConnectionService, 'get'>
  readonly live: { open(spec: LiveSpec, owner: LiveOwner): LiveHandle }
  /** What a monitor's subscription follows: its tab (documentOwner in the app). */
  readonly owner: (documentId: string) => LiveOwner
  readonly settings: () => SettingsValues
  /** Puts focus in the monitor's view once it has rendered. */
  readonly focus?: (documentId: string) => void
  /** Details and Kill Process (activity.details, activity.kill, varia:activity-cancel); without it they say they are unavailable. */
  readonly api?: Pick<VariaApi, 'activityDetails' | 'activityKill' | 'cancelActivity'>
  readonly newId?: () => string
}

/** The settings' choices for a new monitor, each kept to what the catalogue offers. */
export function initialMonitor(id: string, server: string, values: SettingsValues): MonitorState {
  const interval = Number(values['activityMonitor.refreshIntervalSeconds']), window = Number(values['activityMonitor.chartWindowMinutes'])
  const pane = (value: string): ActivityPane | undefined => (activityPanes as readonly string[]).includes(value) ? value as ActivityPane : undefined
  const primary = pane(values['activityMonitor.primaryPane']) ?? defaultPanes.primary
  const second = values['activityMonitor.secondaryPane']
  // A second pane equal to the first, or none, starts unsplit; Split View then offers the default second pane.
  const secondary = pane(second) ?? defaultPanes.secondary
  return {
    id, server, primary, secondary: secondary === primary ? activityPanes.find(item => item !== primary)! : secondary, split: second !== 'none' && secondary !== primary,
    intervalSeconds: (activityIntervalsSeconds as readonly number[]).includes(interval) ? interval : activityIntervalDefaults.refreshIntervalSeconds,
    windowMinutes: (chartWindowsMinutes as readonly number[]).includes(window) ? window as ChartWindowMinutes : defaultChartWindowMinutes,
    processes: defaultProcessesFilter, paused: false, splitRatio: splitLimits.default, expanded: tileSpecs.flatMap((tile, index) => tile.defaultExpanded ? [index] : []), generation: 0
  }
}

/** The panes a monitor shows: the first, and the second in split view. */
export const shownPanes = (state: Pick<MonitorState, 'primary' | 'secondary' | 'split'>): ActivityPane[] => state.split ? [state.primary, state.secondary] : [state.primary]
/** Every live probe of the source, with the monitor's interval and paused unless a shown pane reads it. */
export function probeSettings(state: MonitorState): { probe: LiveProbeId; intervalMs: number; paused: boolean }[] {
  const running = new Set<ActivityProbe>(paneProbes(shownPanes(state)))
  return activityLiveProbes.map(probe => ({ probe, intervalMs: probeIntervalMs(probe, state.intervalSeconds), paused: !running.has(probe) }))
}

export class ActivityMonitorService extends SnapshotStore<ActivityMonitorSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'activityMonitor' as const
  readonly saves = false
  /** Nothing to save, so Save All has nothing of it to save either. */
  readonly inSaveAll = false
  private readonly handles = new Map<string, LiveHandle>()
  private readonly ticks = new Map<string, Disposable>()
  private readonly gridStates = new Map<string, LiveGridState>()
  private readonly factsStore = new (class extends SnapshotStore<ActivityFactsSnapshot> { set(value: ActivityFactsSnapshot) { this.publish(value) } clear() { this.clearListeners() } })({ byMonitor: {} })
  /** Each monitor's tile tones as last shown, so a view remounted by a tab switch never repeats a crossing already said. */
  private readonly tones = new Map<string, readonly (TileTone | undefined)[]>()
  private readonly registration: Disposable
  private readonly contextStore = new (class extends SnapshotStore<ActivityContextState> { set(value: ActivityContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  /** Each monitor's session panes' row actions, the last focused first: what Details and Kill from the palette act on. */
  private readonly sessionRows = new Map<string, LiveRowActions[]>()
  /** Each monitor's Details read in flight, cancelled when the flyout closes or reads again. */
  private readonly detailsRequests = new Map<string, string>()
  private reports = 0
  private disposed = false

  constructor(private readonly options: ActivityMonitorServiceOptions) {
    super({ monitors: {} })
    this.registration = options.documents.registerProvider(this)
  }

  /** The monitors' context keys (activityPaused, activitySplit) for the active document. */
  get context(): ExternalStore<ActivityContextState> { return this.contextStore }
  get(id: string): MonitorState | undefined { return this.getSnapshot().monitors[id] }
  /** Facets and status values per monitor: a store of its own, so a sample that changes neither redraws nothing. */
  get facts(): ExternalStore<ActivityFactsSnapshot> { return this.factsStore }
  factsOf(id: string): MonitorFacts { return this.factsStore.getSnapshot().byMonitor[id] ?? noFacts }
  /** A pane grid's scroll, widths and selection, kept across tab switches and pane changes. */
  gridState(id: string, pane: ActivityPane): LiveGridState {
    const key = id + '/' + pane
    let state = this.gridStates.get(key)
    if (!state) this.gridStates.set(key, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
    return state
  }

  /** Changes Sessions' filter; the backend filters the next sample (live.update args), and the SQL stays the same. */
  setProcessesFilter(id: string, change: Partial<ProcessesFilter>): void {
    const state = this.get(id)
    if (!state) return
    const view = change.view !== undefined && (viewChips as readonly string[]).includes(change.view) ? change.view : state.processes.view
    const processes: ProcessesFilter = { ...state.processes, ...change, view }
    const before = JSON.stringify(monitorArgs(state)), after = JSON.stringify(monitorArgs({ processes }))
    if (before === after && processes.text === state.processes.text) return
    this.put({ ...state, processes })
    if (before !== after) this.handles.get(id)?.setArgs(monitorArgs({ processes }))
  }
  /** Clear filters: the view chip, the filter box and the column filters; the toggles stay as chosen. */
  clearProcessesFilter(id: string): void {
    const state = this.get(id)
    if (state) this.setProcessesFilter(id, { view: 'all', text: '', columnFilters: [] })
  }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  /** The open monitor of a connection: its document follows the connection, so a reconnect keeps it. */
  monitorOf(connectionId: string): string | undefined {
    return this.options.documents.getSnapshot().documents.find(document => document.kind === 'activityMonitor' && document.connectionId === connectionId && this.get(document.id))?.id
  }

  /** Opens the connection's monitor, or activates the one it has (one per connection, as in SSMS). */
  open(connectionId: string): string {
    if (this.disposed) throw new Error('The Activity Monitor is not available.')
    const existing = this.monitorOf(connectionId)
    if (existing) {
      this.options.documents.activate(existing)
      this.options.focus?.(existing)
      return existing
    }
    const connection = this.options.connections.get(connectionId)
    if (!connection) throw new Error('Connect to the server first.')
    if (connection.lost) throw new Error('This connection was lost when the SQL backend restarted. Reconnect it first.')
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('activityMonitor', monitorTitle(label), connection.id, 'master')
    this.put(initialMonitor(document.id, connection.server, this.options.settings()))
    this.startView(document.id)
    this.options.focus?.(document.id)
    return document.id
  }

  private startView(id: string): void {
    const state = this.get(id), connectionId = this.options.documents.get(id)?.connectionId
    if (!state || !connectionId) return
    // A paused monitor subscribes paused (Retry while paused): pausing after it opened would let a sample run first.
    const handle = this.options.live.open({ connectionId, source: 'activity', args: monitorArgs(state), probes: probeSettings(state), ...state.paused ? { paused: true } : {} }, this.options.owner(id))
    this.handles.set(id, handle)
    this.ticks.set(id, handle.onTick(applied => this.noteTick(id, applied)))
  }

  /** Keeps what a sample says beyond its rows: facets (merged per table, as only changed columns come) and status values. */
  private noteTick(id: string, { tick }: AppliedTick): void {
    let facts = this.factsOf(id), changed = false
    for (const sample of tick.samples) {
      const spec = probeSpecs[sample.probe as ActivityProbe] as (typeof probeSpecs)[ActivityProbe] | undefined
      if (!spec) continue
      for (const entry of sample.tables ?? []) {
        const table = spec.tables[entry.table] as ActivityTable | undefined
        if (!table || !entry.facets?.length) continue
        facts = { ...facts, facets: { ...facts.facets, [table]: mergeFacets(facts.facets[table], entry.facets) } }
        changed = true
      }
      // Every sessions sample carries its status values: only a value that changed publishes.
      if (sample.status?.some(entry => facts.status[entry.id] !== entry.value)) {
        facts = { ...facts, status: { ...facts.status, ...Object.fromEntries(sample.status.map(entry => [entry.id, entry.value])) } }
        changed = true
      }
    }
    if (changed) this.setFacts(id, facts)
  }
  private setFacts(id: string, facts: MonitorFacts | undefined): void {
    const byMonitor = { ...this.factsStore.getSnapshot().byMonitor }
    if (!facts && !(id in byMonitor)) return
    if (facts) byMonitor[id] = facts
    else delete byMonitor[id]
    this.factsStore.set({ byMonitor })
  }

  // --- Session actions: Details and Kill Process (docs/activity-monitor.md, Session actions) ----------------------------

  /** A session pane's row actions while it is mounted, for the palette's Details and Kill (the last focused pane's). */
  registerSessionRows(id: string, rows: LiveRowActions): Disposable {
    this.sessionRows.set(id, [...(this.sessionRows.get(id) ?? []).filter(item => item !== rows), rows])
    return {
      dispose: () => {
        const list = (this.sessionRows.get(id) ?? []).filter(item => item !== rows)
        if (list.length) this.sessionRows.set(id, list)
        else this.sessionRows.delete(id)
      }
    }
  }
  /** A session pane's grid took focus: the palette's Details and Kill act on its rows now. */
  focusSessionRows(id: string, rows: LiveRowActions): void {
    const list = this.sessionRows.get(id)
    if (list?.includes(rows) && list[0] !== rows) this.sessionRows.set(id, [rows, ...list.filter(item => item !== rows)])
  }
  activeSessionRows(id: string): LiveRowActions | undefined { return this.sessionRows.get(id)?.[0] }

  /** Opens the Details flyout on a session (or reads it again), cancelling a read still running. */
  openDetails(id: string, session: SessionRef): void {
    const details = this.get(id)?.details
    const same = sameSession(details?.session, session)
    this.readDetails(id, {
      session, status: 'loading', locks: same && details?.locks === 'loaded' ? 'loading' : 'none', read: (details?.read ?? 0) + 1,
      ...same && details?.result ? { result: details.result } : {}
    })
  }
  /** Refresh: reads the flyout's session again (with its locks when they were loaded). */
  refreshDetails(id: string): void {
    const details = this.get(id)?.details
    if (details) this.readDetails(id, { ...details, status: 'loading', locks: details.locks === 'none' ? 'none' : 'loading', read: details.read + 1 })
  }
  /** Load locks: reads every section again with the session's locks (costly, so only on request). */
  loadLocks(id: string): void {
    const details = this.get(id)?.details
    if (details && details.locks !== 'loading') this.readDetails(id, { ...details, status: 'loading', locks: 'loading', read: details.read + 1 })
  }
  /** Closing the flyout cancels its read (an attention ends it in SQL Server). */
  closeDetails(id: string): void {
    this.cancelDetails(id)
    const state = this.get(id)
    if (state?.details) this.put({ ...state, details: undefined })
  }
  private cancelDetails(id: string): void {
    const requestId = this.detailsRequests.get(id)
    this.detailsRequests.delete(id)
    if (requestId) this.options.api?.cancelActivity([requestId]).catch(onUnexpectedError)
  }
  private readDetails(id: string, details: DetailsPanel): void {
    const state = this.get(id), connectionId = this.options.documents.get(id)?.connectionId
    if (!state) return
    this.cancelDetails(id)
    const api = this.options.api
    if (!api || !connectionId) {
      this.put({ ...state, details: { ...details, status: 'failed', locks: 'none', error: 'Details is not available: the monitor has no connection.' } })
      return
    }
    const requestId = this.options.newId?.() ?? crypto.randomUUID()
    this.detailsRequests.set(id, requestId)
    this.put({ ...state, details })
    const withLocks = details.locks === 'loading'
    const settle = (change: Partial<DetailsPanel>) => {
      if (this.detailsRequests.get(id) === requestId) this.detailsRequests.delete(id)
      const now = this.get(id)
      // An answer to an older read (another session, Refresh since, the flyout closed) changes nothing.
      if (!now?.details || now.details.read !== details.read) return
      this.put({ ...now, details: { ...now.details, ...change } })
    }
    api.activityDetails({ requestId, connectionId, sessionId: details.session.sessionId, loginTime: details.session.loginTime, ...withLocks ? { locks: true } : {} }).then(result => {
      if (result.ok) settle({ status: 'ready', result: result.value, error: undefined, locks: withLocks ? 'loaded' : 'none' })
      else if (result.code !== 'CANCELLED') settle({ status: 'failed', error: result.error, locks: 'none' })
    }, (error: unknown) => settle({ status: 'failed', error: error instanceof Error ? error.message : 'Details could not be read.', locks: 'none' }))
  }

  /** Kill Process…: asks first; the confirm names the session and warns about rollback. */
  askKill(id: string, session: SessionRef): void {
    const state = this.get(id)
    if (!state || state.kill?.phase === 'running') return
    this.put({ ...state, kill: { session, phase: 'confirm' } })
  }
  cancelKill(id: string): void {
    const state = this.get(id)
    if (state?.kill?.phase === 'confirm') this.put({ ...state, kill: undefined })
  }
  /** Whether Kill may run on a session now (the login's ALTER ANY CONNECTION, never Varia's own pools), and why not. */
  killOffer(id: string, session: SessionRef | undefined): ReturnType<typeof killOffer> { return killOffer(session, this.factsOf(id).status.canKill) }
  /** The confirm's Kill: one session, which the backend checks against the row's login time and host process id. */
  async confirmKill(id: string): Promise<void> {
    const state = this.get(id), connectionId = this.options.documents.get(id)?.connectionId
    const session = state?.kill?.phase === 'confirm' ? state.kill.session : undefined
    if (!state || !session || !this.killOffer(id, session).allowed) return
    this.put({ ...state, kill: { session, phase: 'running' }, killReport: undefined })
    let report: KillReport
    const api = this.options.api
    if (!api || !connectionId) report = killReport(session, undefined, 'Kill Process is not available: the monitor has no connection.')
    else {
      try {
        const result = await api.activityKill({ connectionId, sessions: [{ sessionId: session.sessionId, loginTime: session.loginTime, hostProcessId: session.hostProcessId }] })
        report = result.ok ? killReport(session, result.value) : killReport(session, undefined, result.error)
      } catch (error) {
        report = killReport(session, undefined, error instanceof Error ? error.message : undefined)
      }
    }
    const now = this.get(id)
    if (!now) return
    this.put({ ...now, kill: undefined, killReport: { ...report, id: ++this.reports } })
    // The next sample shows the session gone, or rolling back, without waiting for the interval.
    if (report.tone === 'success') this.refresh(id)
  }
  dismissKillReport(id: string): void {
    const state = this.get(id)
    if (state?.killReport) this.put({ ...state, killReport: undefined })
  }

  /** Subscribes again (Retry after an error, or after the view ended): history starts over with a new handle. */
  retry(id: string): void {
    const state = this.get(id)
    if (!state) return
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.ticks.get(id)?.dispose()
    this.ticks.delete(id)
    // A new subscription sends its facets and status values again.
    this.setFacts(id, undefined)
    this.put({ ...state, generation: state.generation + 1 })
    this.startView(id)
  }

  setPaused(id: string, paused: boolean): void {
    const state = this.get(id)
    if (!state || state.paused === paused) return
    this.put({ ...state, paused })
    this.handles.get(id)?.setUserPaused(paused)
  }
  togglePause(id: string): void { const state = this.get(id); if (state) this.setPaused(id, !state.paused) }
  refresh(id: string): void { if (!this.get(id)?.paused) this.handles.get(id)?.refresh() }

  setInterval(id: string, seconds: number): void {
    const state = this.get(id)
    if (!state || state.intervalSeconds === seconds || !(activityIntervalsSeconds as readonly number[]).includes(seconds)) return
    this.update(state, { ...state, intervalSeconds: seconds })
  }
  setWindow(id: string, minutes: number): void {
    const state = this.get(id)
    if (!state || state.windowMinutes === minutes || !(chartWindowsMinutes as readonly number[]).includes(minutes)) return
    this.put({ ...state, windowMinutes: minutes as ChartWindowMinutes })
  }
  toggleSplit(id: string): void { const state = this.get(id); if (state) this.update(state, { ...state, split: !state.split }) }
  /** Shows a pane in a slot; the pane the other slot showed moves to this slot's old pane, so the two never match. */
  setPane(id: string, slot: PaneSlot, pane: ActivityPane): void {
    const state = this.get(id)
    if (!state || state[slot] === pane) return
    const other: PaneSlot = slot === 'primary' ? 'secondary' : 'primary'
    this.update(state, { ...state, [slot]: pane, ...state[other] === pane ? { [other]: state[slot] } : {} })
  }
  setSplitRatio(id: string, ratio: number): void {
    const state = this.get(id), next = clampRatio(ratio)
    if (state && state.splitRatio !== next) this.put({ ...state, splitRatio: next })
  }
  /** Expands or collapses a tile's chart; the others stay as they are. */
  toggleTile(id: string, index: number): void {
    const state = this.get(id)
    if (!state || !tileSpecs[index]) return
    const expanded = state.expanded.includes(index) ? state.expanded.filter(item => item !== index) : [...state.expanded, index]
    this.put({ ...state, expanded })
  }

  /** What the tiles' live region says for these readings: each threshold crossed upward since the monitor's last ones. */
  noteTones(id: string, readings: readonly Pick<TileReading, 'caption' | 'tone'>[]): string | undefined {
    if (!this.get(id)) return undefined
    const said = crossings(this.tones.get(id) ?? [], readings)
    this.tones.set(id, readings.map(reading => reading.tone))
    return said
  }

  /** A change of panes or interval: the probes whose settings moved are told, in one debounced live update. */
  private update(before: MonitorState, after: MonitorState): void {
    this.put(after)
    const handle = this.handles.get(after.id)
    if (!handle) return
    const old = new Map(probeSettings(before).map(entry => [entry.probe, entry]))
    for (const entry of probeSettings(after)) {
      const previous = old.get(entry.probe)!
      const patch = { ...previous.intervalMs !== entry.intervalMs ? { intervalMs: entry.intervalMs } : {}, ...previous.paused !== entry.paused ? { paused: entry.paused } : {} }
      if (Object.keys(patch).length) handle.setProbe(entry.probe, patch)
    }
  }

  private put(state: MonitorState): void {
    this.publish({ monitors: { ...this.getSnapshot().monitors, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    this.contextStore.set({ byDocument: Object.fromEntries(Object.values(this.getSnapshot().monitors).map(state => [state.id, { paused: state.paused, split: state.split }])) })
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  /** Nothing to save (`saves`): File › Save is disabled on a monitor, and a Save that reaches it saves nothing. */
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    const handle = this.handles.get(id)
    this.handles.delete(id)
    this.tones.delete(id)
    this.ticks.get(id)?.dispose()
    this.ticks.delete(id)
    for (const key of [...this.gridStates.keys()]) if (key.startsWith(id + '/')) this.gridStates.delete(key)
    this.setFacts(id, undefined)
    this.cancelDetails(id)
    this.sessionRows.delete(id)
    try { handle?.dispose() } catch (error) { onUnexpectedError(error) }
    if (!this.get(id)) return
    const monitors = { ...this.getSnapshot().monitors }
    delete monitors[id]
    this.publish({ monitors })
    this.publishContext()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.handles.values()) handle.dispose()
    this.handles.clear()
    for (const tick of this.ticks.values()) tick.dispose()
    this.ticks.clear()
    for (const id of [...this.detailsRequests.keys()]) this.cancelDetails(id)
    this.sessionRows.clear()
    this.factsStore.clear()
    this.registration.dispose()
    this.clearListeners()
    this.contextStore.clear()
  }
}
