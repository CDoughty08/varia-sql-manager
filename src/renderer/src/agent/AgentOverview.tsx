// SQL Server Agent's overview (AG-15, mock `rx-agent-overview`): the header (the service's state, startup type, account and server, with
// Check again and Properties), the tiles (jobs, failed in the last 24 hours, running, alerts) and the health checks, each with its
// severity, the objects it names (links) and its fix. AgentOverviewService keeps every state; this only draws it.
import { useSyncExternalStore } from 'react'
import { agentOverviewProbe, agentOverviewTitle, namesText, needsAttention, serviceWords, type OverviewCheck, type OverviewSeverity } from '../../../shared/agent/overview'
import { liveProbes } from '../../../shared/live/catalog'
import type { IconId } from '../../../shared/icons'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill } from '../kit/LivePill'
import Tile from '../kit/Tile'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import type { AgentOverviewService } from './AgentOverviewService'

const spec = liveProbes[agentOverviewProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const severityIcons: Readonly<Record<OverviewSeverity, IconId>> = { error: 'error', warning: 'warning', info: 'info', ok: 'check', unread: 'lock' }
const severityWords: Readonly<Record<OverviewSeverity, string>> = { error: 'Problem', warning: 'Warning', info: 'Note', ok: 'Passed', unread: 'Not checked' }

function Check({ check, documentId, service }: { readonly check: OverviewCheck; readonly documentId: string; readonly service: AgentOverviewService }) {
  // A detail that only lists the objects is left out: their links below say the same.
  const namesOnly = check.objects.length > 0 && check.detail === `${namesText(check.objects.map(object => object.name), 5)}.`
  return <li className="agent-check" data-severity={check.severity} aria-label={`${severityWords[check.severity]}: ${check.title}`}>
    <span className="agent-check-icon" aria-hidden="true"><Icon name={severityIcons[check.severity]} /></span>
    <span className="agent-check-title">{check.title}</span>
    <span className="agent-check-fix">{check.fix && <button type="button" onClick={() => void service.fix(documentId, check.fix!.action)}>{check.fix.label}</button>}</span>
    <span className="agent-check-detail">{namesOnly ? null : check.detail}
      {check.objects.length > 0 && <span className="agent-check-objects" role="list" aria-label={`${check.title}: objects`}>
        {check.objects.slice(0, 12).map(object => <span key={`${object.kind}:${object.name}`} role="listitem">
          <button type="button" className="link-button agent-check-object" title={object.kind === 'job' ? `Open the job ${object.name}` : `Open Schedules (${object.name})`}
            onClick={() => service.openObject(documentId, object)}><Icon name={object.kind === 'job' ? 'agent-job' : 'agent-schedule'} />{object.name}</button></span>)}
      </span>}
    </span>
  </li>
}

/** An Agent overview document. */
export default function AgentOverview({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.agentOverview
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="agent" title={agentOverviewTitle} detail="This document has closed." />
  const end = service.ended(documentId)
  const unavailable = live.probes[agentOverviewProbe]?.state === 'unavailable' ? live.probes[agentOverviewProbe]?.note ?? 'The Agent overview is not available on this server.' : undefined
  const facts = state.facts, checks = state.checks ?? []
  const words = facts ? serviceWords(facts) : undefined
  const attention = needsAttention(checks)
  const verbs = [{ command: 'agent.refreshOverview' as const, args: { tabId: documentId }, label: 'Check again' }]
  const meta = [words?.startup, facts?.serviceAccount, facts?.productVersion ? `${state.label} (${facts.productVersion})` : state.label].filter(Boolean)
  return <DocumentFrame id={`agent-overview-${documentId}`} title="SQL Server Agent" subtitle="Overview"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={<LivePill {...probePillStatus(live, agentOverviewProbe, spec.intervalMs.default)} />} verbs={verbs} attributes={{ 'data-agent-overview': documentId }}>
    <div className="agent-overview">
      <div className="agent-overview-head">
        {words && <span className="agent-overview-state" data-tone={words.tone} role="status" aria-label={`SQL Server Agent: ${words.state}`}>{words.state}</span>}
        <span className="agent-overview-meta">{meta.map(item => <span key={item}>{item}</span>)}</span>
        <button type="button" onClick={() => service.properties(documentId)}><Icon name="settings-gear" />Properties</button>
      </div>
      {state.notice && <InlineError role="status" message={state.notice} />}
      {unavailable ? <EmptyState icon="agent" title="The Agent overview is not available" detail={unavailable} />
        : end ? <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
        : !facts ? <p className="agent-overview-reading" role="status">Checking SQL Server Agent…</p>
        : <>
          <div className="agent-tiles" role="group" aria-label="SQL Server Agent at a glance">
            {(state.tiles ?? []).map(tile => <div key={tile.id} className="agent-overview-tile" data-tone={tile.tone}>
              <Tile caption={tile.label} value={tile.value} {...tile.detail ? { context: tile.detail } : {}} /></div>)}
          </div>
          <section className="agent-checks" aria-labelledby={`agent-checks-${documentId}`}>
            <div className="agent-checks-head">
              <h3 id={`agent-checks-${documentId}`}>{attention ? 'Needs attention' : 'Health checks'}</h3>
              <span>{attention ? `${attention} of ${checks.length} checks` : `${checks.length} checks`}</span>
            </div>
            <ul className="agent-check-list">{checks.map(check => <Check key={check.id} check={check} documentId={documentId} service={service} />)}</ul>
            <p className="agent-checks-hint">Every check is a read; nothing changes until you choose a fix, which opens the usual editor or confirmation. Logins without sysadmin see the checks their role can read.</p>
          </section>
        </>}
    </div>
  </DocumentFrame>
}
