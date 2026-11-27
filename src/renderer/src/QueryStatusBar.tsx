import type { CSSProperties } from 'react'
import type { QueryMultiStatus } from '../../shared/contracts'
import { documentKind, kindInfo, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useTicker } from './core/useTicker'
import { environmentPreset, environmentTag } from '../../shared/environments'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import { resolveMultiTargets } from './MultiTargetPopover'
import { queryStatusModel, type MultiQueryStatusTarget } from './results/query-status'
import type { TabResults } from './results/ResultsService'
import type { LiveConnection } from './services/connections'
import { liveQuerySession, type QueryState } from './services/queries'
import { queryConnectionPresentation } from './query-connection'

/** Derives the settled multi-server status so local failures (e.g. refuseReadOnly), backend loss, cancel, and timeout never show stale summaries. */
export function deriveMultiStatus(
  running: boolean,
  run: (Pick<TabResults, 'status' | 'closedFrom' | 'summary'> & { readonly multiSummary?: { readonly status: QueryMultiStatus } }) | undefined,
  query: (Pick<QueryState, 'error'> & { readonly multiSummary?: { readonly status: QueryMultiStatus } }) | undefined
): QueryMultiStatus | undefined {
  if (running) return undefined
  if (run) {
    const ended = run.status === 'closed' ? (run.closedFrom ?? run.summary?.status) : run.status
    if (ended === 'lost') return 'failed'
    if (run.multiSummary) return run.multiSummary.status
    if (ended === 'failed') return 'failed'
    if (ended === 'cancelled') return 'cancelled'
    if (ended === 'timedOut') return 'timedOut'
  }
  if (query?.error && !query?.multiSummary) return 'failed'
  return query?.multiSummary?.status
}

interface Props {
  readonly tab: QueryTab
  readonly connection?: LiveConnection
  /** SMO and SqlClient versions, for the tooltip. */
  readonly versions?: string
  /**
   * 'segment' (the default): the active query's facts in the window's status bar. 'bar': SSMS's query window status bar,
   * below the query (or above it: Tools › Options › Text Editor › Editor Tab and Status Bar), with the connection's
   * colour as a 3px edge on the side facing the query.
   */
  readonly variant?: 'segment' | 'bar'
  /**
   * When true on 'segment', collapses the redundant plug icon and "Connected." label visually (keeping the status text
   * accessible for screen readers) so the online backend dot and connection facts read as one calm segment.
   */
  readonly compact?: boolean
}

/**
 * The query's state sentence and its facts (server, login and SPID, database, time, rows), as SSMS's query window status
 * bar shows them; in the window's status bar, only the connection's (the results head says how the run went). A value
 * opened from the results names its kind only. Elapsed time and rows change while a query runs, so only the state
 * sentence is announced. In the bar, the connection's environment tag (PROD) leads the server segment; as a segment it
 * is left out, because the window's status bar already shows it just before, after the backend's state.
 */
export default function QueryStatusBar({ tab, connection, versions, variant = 'segment', compact = false }: Props) {
  const { settings, queries, results, targets, connections: connectionService } = useWorkbench()
  const rememberedTargets = useServiceSnapshot(targets)
  const allConnections = useServiceSnapshot(connectionService)
  const presentation = queryConnectionPresentation(tab, connection, rememberedTargets.find(target => target.id === tab.targetId))
  const values = useServiceSnapshot(settings).values
  const query = useServiceSnapshot(queries)[tab.id]
  const run = useServiceSnapshot(results)[tab.id]
  const running = !!query?.running
  const now = useTicker(running && variant === 'bar')

  const isMulti = !!tab.multiMode
  const multiResolved = isMulti ? resolveMultiTargets(tab, allConnections, rememberedTargets) : []
  const multiEnabled = multiResolved.filter(item => item.target.enabled)
  const multiProdTarget = multiEnabled.find(item => environmentPreset(item.environment) === 'Production')
  const multiProdCount = multiEnabled.filter(item => environmentPreset(item.environment) === 'Production').length
  const effectiveColor = isMulti
    ? (multiProdTarget ? (multiProdTarget.color ?? 'red') : tab.multiMode === 'cross' ? 'purple' : multiEnabled.find(item => item.color)?.color)
    : presentation.color
  const accent = useConnectionAccent(effectiveColor)

  const bar = variant === 'bar', top = values['textEditor.statusBar.location'] === 'top'
  const className = bar ? 'query-context query-status-bar' : 'query-status'
  const location = bar ? top ? 'top' : 'bottom' : undefined
  const edge: CSSProperties | undefined = bar && accent ? top ? { borderBottom: `3px solid ${accent}` } : { borderTop: `3px solid ${accent}` } : undefined
  const kind = documentKind(tab)
  if (kind !== 'sql') return <div className={className} role="status" aria-label="Query status" data-tone="value" data-location={location}><span>{kindInfo[kind].label}</span></div>

  let model
  if (isMulti) {
    const statusTargets: MultiQueryStatusTarget[] = multiResolved.map(item => {
      const liveState = item.target.connectionId
        ? query?.multiTargets?.find(state => state.connectionId === item.target.connectionId)
        : item.target.targetId
          ? query?.multiTargets?.find(state => state.targetKey === item.target.targetId)
          : undefined
      return {
        provider: item.target.provider,
        connected: item.live,
        enabled: item.target.enabled,
        ...item.environment ? { environment: item.environment } : {},
        label: item.name,
        ...liveState ? { phase: liveState.phase } : {}
      }
    })
    model = queryStatusModel({
      multiMode: tab.multiMode,
      multiTargets: statusTargets,
      multiStatus: deriveMultiStatus(running, run, query),
      database: tab.database,
      run,
      running,
      now,
      settings: values,
      variant
    })
  } else {
    const session = liveQuerySession(query, presentation.disconnected ? undefined : connection)
    const statusConnection = presentation.server ? { ...connection, server: presentation.server, displayName: presentation.displayName, disconnected: presentation.disconnected } : undefined
    model = queryStatusModel({ connection: statusConnection, database: tab.database, session, run, running, now, settings: values, variant })
  }

  const quietReady = !bar && compact && model.tone === 'ready'
  const visibleSegments = !quietReady && isMulti
    ? model.segments.filter(segment => !(segment.key === 'server' && segment.text === model.text))
    : model.segments
  const showBarEnvironment = bar && (isMulti ? multiProdCount > 0 : !!environmentTag(presentation.environment))
  const barEnvironment = isMulti ? 'Production' : presentation.environment
  const barEnvironmentAbout = isMulti ? `${multiProdCount} Production ${multiProdCount === 1 ? 'target' : 'targets'}` : undefined

  return <div className={className} role="status" aria-label="Query status" data-tone={model.tone} data-location={location} data-compact={quietReady ? 'true' : undefined} data-multi-server={isMulti ? 'true' : undefined} style={edge} title={[model.place, versions].filter(Boolean).join('\n')}>
    <span className={quietReady ? 'query-status-state visually-hidden' : 'query-status-state'}>{!quietReady && <Icon name={model.icon} spin={model.icon === 'loading'} />}<span className="query-status-text">{model.text}</span></span>
    <span className="query-status-segments">
      {showBarEnvironment && <span className="query-status-environment"><span className="visually-hidden">Environment: </span><EnvironmentTag environment={barEnvironment} place="queryStatus" about={barEnvironmentAbout} /></span>}
      {visibleSegments.map(segment => <span key={segment.key} className={`query-status-segment query-status-${segment.key}`} aria-live={segment.key === 'time' || segment.key === 'rows' ? 'off' : undefined}>
        <span className="visually-hidden">{segment.label}: </span>{segment.key === 'login' ? <span className="status-session">{segment.text}</span> : segment.text}
      </span>)}
    </span>
  </div>
}
