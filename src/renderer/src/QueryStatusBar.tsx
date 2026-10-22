import type { CSSProperties } from 'react'
import { documentKind, kindInfo, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useTicker } from './core/useTicker'
import Icon from './Icon'
import { queryStatusModel } from './results/query-status'
import type { LiveConnection } from './services/connections'

interface Props {
  readonly tab: QueryTab
  readonly connection?: LiveConnection
  /** SMO and SqlClient versions, for the tooltip. */
  readonly versions?: string
}

/**
 * SSMS's query window status bar, below the query (or above it: Tools › Options › Text Editor › Editor Tab and Status
 * Bar). The connection's colour is a 3px edge on the side facing the query. A value opened from the results names its
 * kind only. Elapsed time and rows change while a query runs, so only the state sentence is announced.
 */
export default function QueryStatusBar({ tab, connection, versions }: Props) {
  const { settings, queries, results } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  const query = useServiceSnapshot(queries)[tab.id]
  const run = useServiceSnapshot(results)[tab.id]
  const running = !!query?.running
  const now = useTicker(running)
  const accent = useConnectionAccent(connection?.color)
  const top = values['textEditor.statusBar.location'] === 'top'
  const edge: CSSProperties | undefined = accent ? top ? { borderBottom: `3px solid ${accent}` } : { borderTop: `3px solid ${accent}` } : undefined
  const kind = documentKind(tab)
  if (kind !== 'sql') return <div className="query-context query-status-bar" data-tone="value" data-location={top ? 'top' : 'bottom'}><span>{kindInfo[kind].label}</span></div>
  const session = query?.session && connection && !connection.lost && query.session.connectionId === connection.id && query.session.spid !== undefined ? { login: query.session.login, spid: query.session.spid } : undefined
  const model = queryStatusModel({ connection, database: tab.database, session, run, running, now, settings: values })
  return <div className="query-context query-status-bar" role="status" data-tone={model.tone} data-location={top ? 'top' : 'bottom'} style={edge} title={[model.place, versions].filter(Boolean).join('\n')}>
    <span className="query-status-state"><Icon name={model.icon} spin={model.icon === 'loading'} /><span className="query-status-text">{model.text}</span></span>
    <span className="query-status-segments">{model.segments.map(segment => <span key={segment.key} className={`query-status-segment query-status-${segment.key}`} aria-live={segment.key === 'time' || segment.key === 'rows' ? 'off' : undefined}>
      <span className="visually-hidden">{segment.label}: </span>{segment.key === 'login' ? <span className="status-session">{segment.text}</span> : segment.text}
    </span>)}</span>
  </div>
}
