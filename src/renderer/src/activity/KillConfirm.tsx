// Kill Process (docs/activity-monitor.md, Session actions): the confirm that names the session (its login, host and open
// transactions) and warns about rollback, and the report of what the backend answered. Cancel has focus, so a stray Enter
// never ends a session; Kill is disabled, with the reason, when the login may not end sessions or the session is Varia's own.
import { useSyncExternalStore } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import type { KillPanel, MonitorState } from './ActivityMonitorService'
import { killQuestion } from './session-actions'

export function KillConfirm({ monitorId, kill }: { readonly monitorId: string; readonly kill: KillPanel }) {
  const { activity } = useWorkbench()
  const { session, phase } = kill
  const question = killQuestion(session)
  // Read with the facts, so a permission the next sample takes away disables Kill while the confirm is open.
  useSyncExternalStore(activity.facts.subscribe, () => activity.factsOf(monitorId))
  const offer = activity.killOffer(monitorId, session)
  const running = phase === 'running'
  return <SubDialog title="Kill Process" okLabel={running ? 'Killing…' : 'Kill Process'} okDisabled={!offer.allowed || running} destructive className="activity-kill"
    onOk={() => { void activity.confirmKill(monitorId) }} onCancel={() => { if (!running) activity.cancelKill(monitorId) }}
    status={running ? <span role="status">Ending session {session.sessionId}…</span> : undefined}>
    <p className="activity-kill-question">{question.title}</p>
    <dl className="activity-kill-facts">
      <div><dt>Session</dt><dd>{session.sessionId}</dd></div>
      {question.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <p className="activity-kill-warning"><Icon name="warning" />{question.warning}</p>
    {!offer.allowed && <p className="activity-kill-refusal" role="alert"><Icon name="circle-slash" />{offer.reason}</p>}
  </SubDialog>
}

const toneIcons = { success: 'pass', info: 'info', warning: 'warning', error: 'error' } as const

/** What the last Kill Process answered, above the tiles until dismissed: each outcome in its own words. */
export function KillReportBanner({ state }: { readonly state: MonitorState }) {
  const { activity } = useWorkbench()
  const report = state.killReport
  if (!report) return null
  return <div className="activity-report" data-tone={report.tone} data-kill-report={report.tone}>
    <Icon name={toneIcons[report.tone]} />
    {/* Keyed by the report, so a second report with the same words is announced again. */}
    <p key={report.id} role={report.tone === 'error' ? 'alert' : 'status'}><strong>{report.title}</strong> {report.detail}</p>
    <button type="button" className="activity-tool icon-only" aria-label="Dismiss" title="Dismiss" onClick={() => activity.dismissKillReport(state.id)}><Icon name="close" /></button>
  </div>
}
