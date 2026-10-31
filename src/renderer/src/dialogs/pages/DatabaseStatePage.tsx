import { useEffect, useState } from 'react'
import { actionLimits } from '../../../../shared/actions/catalog.ts'
import { promptTabFacts } from '../../../../shared/actions/prompts.ts'
import type { DatabaseStateModel } from '../../../../shared/actions/schema.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import type { StatusTone } from '../../../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import StatusPill from '../../kit/StatusPill'
import type { TakeOfflineDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'
import type { OpenObjectDialog } from '../ObjectDialogService'

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
/** At most this many of Varia's own query windows on the database have their open transaction read when the dialog opens. */
const ownTabReads = 16

/** The row's Status chip: SSMS's Ready and Not ready before OK, then the run's outcome. */
export function databaseStateStatus(open: Pick<OpenObjectDialog, 'phase' | 'model'>, blocked: boolean): { readonly tone: StatusTone; readonly label: string } {
  switch (open.phase) {
    case 'loading': return open.model ? { tone: 'running', label: 'Checking' } : { tone: 'running', label: 'Loading' }
    case 'executing': return { tone: 'running', label: 'In progress' }
    case 'succeeded': return { tone: 'success', label: 'Success' }
    case 'failed': case 'loadFailed': case 'disconnected': return { tone: 'critical', label: 'Error' }
    case 'stopped': return { tone: 'neutral', label: 'Stopped' }
    default: return blocked ? { tone: 'warning', label: 'Not ready' } : { tone: 'neutral', label: 'Ready' }
  }
}

/** The row's Message before OK: who is in the database, and how many of them have work that dropping them rolls back (A7). */
export function sessionsMessage(model: Pick<DatabaseStateModel, 'sessions' | 'withTransaction'>): string {
  if (model.sessions === undefined) return 'Sessions unknown (needs VIEW SERVER STATE).'
  if (model.sessions === 0) return 'No active connections.'
  const open = model.withTransaction ? ` (${count(model.withTransaction, 'with an open transaction', 'with open transactions')})` : ''
  return count(model.sessions, 'active connection', 'active connections') + open
}

/**
 * Varia's own query windows on the database whose session holds an open transaction, read once per describe (QueryService
 * reads each session's @@TRANCOUNT; one it could not read may hold one), so the dialog can name the work that Drop All
 * Active Connections rolls back (A7).
 */
function useOwnTransactions(open: OpenObjectDialog): readonly string[] {
  const { documents, queries } = useWorkbench()
  const [names, setNames] = useState<readonly string[]>([])
  const database = open.target.name, model = open.model
  useEffect(() => {
    if (!model || open.dialog !== 'takeOffline') return
    let current = true
    const tabs = documents.getSnapshot().documents.filter(tab => tab.connectionId === open.connectionId && tab.database === database).slice(0, ownTabReads)
    void Promise.all(tabs.map(async tab => {
      try { const state = await queries.transactionState(tab.id); return state.transactions > 0 || state.unchecked ? [tab.name] : [] } catch { return [] }
    })).then(found => { if (current) setNames(found.flat()) })
    return () => { current = false }
  }, [model, open.connectionId, open.dialog, database, documents, queries])
  return names
}

/**
 * Take Database Offline's and Bring Database Online's General page, as SSMS lays them out (recalled): the database grid
 * (Database Name, Drop All Active Connections for Take Offline, Status, Message), then, for Take Offline, the sessions in
 * the database, which of them have open transactions, and why OK waits for Drop All Active Connections.
 */
export default function DatabaseStatePage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  useServiceSnapshot(dialogs)
  const offline = open.dialog === 'takeOffline'
  const model = open.model as DatabaseStateModel | undefined, draft = open.draft as TakeOfflineDraft | undefined
  const ownTransactions = useOwnTransactions(open)
  const blocked = dialogs.blockedReason(open) !== undefined
  const status = databaseStateStatus(open, blocked)
  // SET OFFLINE waits for every other session to leave; once it has run a moment, the row says so (Stop gives up).
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (open.phase !== 'executing') { setWaiting(false); return }
    const timer = setTimeout(() => setWaiting(true), actionLimits.statusDelayMs)
    return () => clearTimeout(timer)
  }, [open.phase])
  const failed = open.steps?.find(step => step.status === 'failed')
  const message = open.phase === 'executing'
    ? offline
      ? draft?.dropConnections ? 'Closing connections and taking the database offline…' : waiting ? 'Waiting for other connections to leave the database. Stop to give up.' : 'Taking the database offline…'
      : 'Bringing the database online…'
    : open.phase === 'succeeded' ? offline ? 'The database is offline.' : 'The database is online.'
    : open.phase === 'failed' ? failed?.message ?? open.error?.message ?? ''
    : model && offline ? sessionsMessage(model) : ''
  const sessions = model?.sessions ?? 0
  const facts = promptTabFacts(ownTransactions)
  const name = model ? displayText(model.name) : open.label
  return <div className="object-dialog-state">
    <div className="object-dialog-caption" id="database-state-grid">Databases</div>
    <table className="object-dialog-grid" role="grid" aria-labelledby="database-state-grid">
      <thead><tr>
        <th scope="col">Database Name</th>
        {offline && <th scope="col">Drop All Active Connections</th>}
        <th scope="col">Status</th><th scope="col" className="object-dialog-col-message">Message</th>
      </tr></thead>
      <tbody><tr>
        <td><bdi>{name}</bdi></td>
        {offline && <td className="object-dialog-cell-check">{draft && <input type="checkbox" aria-label="Drop All Active Connections" checked={draft.dropConnections}
          disabled={!editable || !model || model.sessions === 0} onChange={event => dialogs.updateDraft({ dropConnections: event.target.checked })} />}</td>}
        <td><StatusPill tone={status.tone} label={status.label} size="small" /></td>
        <td className="object-dialog-cell-message">{message}</td>
      </tr></tbody>
    </table>
    {model && model.warnings.length > 0 && <ul className="object-dialog-warnings" aria-label="Warnings">
      {model.warnings.map((warning, index) => <li key={index}><Icon name="warning" /><span>{warning.text}</span></li>)}
    </ul>}
    {offline && model && model.sessionList.length > 0 && <details className="object-dialog-sessions" open>
      <summary>Sessions in <bdi>{name}</bdi> ({sessions.toLocaleString('en-US')})</summary>
      <table className="object-dialog-grid" role="grid" aria-label="Sessions">
        <thead><tr><th scope="col">Session</th><th scope="col">Login</th><th scope="col">Program</th><th scope="col">Host</th><th scope="col">Open transactions</th></tr></thead>
        <tbody>{model.sessionList.map(session => <tr key={session.sessionId}>
          <td>{session.sessionId}</td><td><bdi>{session.login ? displayText(session.login) : ''}</bdi></td><td><bdi>{session.program ? displayText(session.program) : ''}</bdi></td>
          <td><bdi>{session.host ? displayText(session.host) : ''}</bdi></td><td>{session.openTransactions}</td>
        </tr>)}</tbody>
      </table>
      {model.sessionsTruncated && <p className="field-note">Only the first {model.sessionList.length} sessions are listed.</p>}
    </details>}
    {offline && model && (!!model.withTransaction || facts.tabsWithTransactions.length > 0) && <p className="object-dialog-note warning" role="note">
      <Icon name="warning" /><span>{[
        model.withTransaction ? `Drop All Active Connections rolls back the open ${model.withTransaction === 1 ? 'transaction of 1 session' : `transactions of ${model.withTransaction.toLocaleString('en-US')} sessions`}.` : '',
        facts.tabsWithTransactions.length ? `Varia's query ${facts.tabsWithTransactions.length + (facts.moreTabsWithTransactions ?? 0) === 1 ? 'window' : 'windows'} with an open transaction here: ${facts.tabsWithTransactions.join(', ')}${facts.moreTabsWithTransactions ? ` and ${count(facts.moreTabsWithTransactions, 'more', 'more')}` : ''}.` : ''
      ].filter(Boolean).join(' ')}</span>
    </p>}
    {offline && model && sessions > 0 && !draft?.dropConnections && (open.phase === 'ready' || open.phase === 'loading') && <p className="object-dialog-note" role="note">
      <Icon name="info" /><span>OK stays disabled while sessions are connected: SET OFFLINE would wait for them indefinitely. Check Drop All Active Connections to roll back
        their work and disconnect them (WITH ROLLBACK IMMEDIATE), or wait for them to leave and Check Again.</span>
    </p>}
    {offline && model && (open.phase === 'ready' || open.phase === 'failed' || open.phase === 'stopped' || open.phase === 'loading') && <div className="object-dialog-actions">
      <button type="button" disabled={open.phase === 'loading'} onClick={() => dialogs.reload()}>Check Again</button>
    </div>}
  </div>
}
