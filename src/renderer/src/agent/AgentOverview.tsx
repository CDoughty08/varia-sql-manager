// SQL Server Agent's overview (AG-15, mock `rx-agent-overview`): the header (service status pill, Properties, Check again, and FactLine
// for Service Account, Version, and Checked), clickable KPI tiles, and grouped health checks with object chips and fixed-column fixes.
import { useSyncExternalStore } from 'react'
import { agentOverviewProbe, agentOverviewTitle, detailParts, serviceWords, type OverviewCheck, type OverviewObject, type OverviewSeverity, type OverviewTile } from '../../../shared/agent/overview'
import { liveProbes } from '../../../shared/live/catalog'
import type { IconId } from '../../../shared/icons'
import type { StatusTone } from '../../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame, { type Fact } from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import StatusPill from '../kit/StatusPill'
import Tile, { tileName } from '../kit/Tile'
import { formatClock, liveLabel } from '../kit/format'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import type { AgentOverviewService } from './AgentOverviewService'

const spec = liveProbes[agentOverviewProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
/** The object links a check shows; past them the detail ("and N more") stays. */
const shownObjects = 12
const severityIcons: Readonly<Record<OverviewSeverity, IconId>> = { error: 'error', warning: 'warning', info: 'info', ok: 'check', unread: 'lock' }
const severityWords: Readonly<Record<OverviewSeverity, string>> = { error: 'Problem', warning: 'Warning', info: 'Note', ok: 'Passed', unread: 'Not checked' }

function tileHint(id: OverviewTile['id']): string {
  switch (id) {
    case 'jobs': return 'Open all jobs in Job Activity Monitor'
    case 'failed': return 'Open failed jobs in Job Activity Monitor'
    case 'running': return 'Open running jobs in Job Activity Monitor'
    case 'alerts': return 'Open Operators and Notifications'
  }
}

function Check({ check, documentId, service }: { readonly check: OverviewCheck; readonly documentId: string; readonly service: AgentOverviewService }) {
  // Each name links where the detail says it; the objects past its "and N more" follow as links, up to shownObjects in all.
  const { parts, rest } = detailParts(check.detail, check.objects)
  const link = (object: OverviewObject, key: string) => <button key={key} type="button" className="ov-obj-chip"
    title={object.kind === 'job' ? `Open the job ${object.name}` : `Open Schedules (${object.name})`} onClick={() => service.openObject(documentId, object)}>{object.name}</button>
  const more = rest.slice(0, Math.max(0, shownObjects - (check.objects.length - rest.length)))
  return <li className="ov-check" data-severity={check.severity} aria-label={`${severityWords[check.severity]}: ${check.title}`}>
    <span className="ov-check-icon" aria-hidden="true"><Icon name={severityIcons[check.severity]} /></span>
    <span className="ov-check-title">{check.title}</span>
    <span className="ov-check-fix">{check.fix && <button type="button" onClick={() => void service.fix(documentId, check.fix!.action)}>{check.fix.label}</button>}</span>
    {(parts.length > 0 || more.length > 0) && <span className="ov-check-detail">
      {parts.map((part, at) => typeof part === 'string' ? part : link(part, `${part.kind}:${at}:${part.name}`))}
      {more.length > 0 && <span className="ov-check-objects" role="list" aria-label={`${check.title}: more objects`}>
        {more.map((object, at) => <span key={`${object.kind}:${at}:${object.name}`} role="listitem">{link(object, 'link')}</span>)}
      </span>}
    </span>}
  </li>
}

function CheckGroup({ id, title, count, checks, compact, documentId, service }: {
  readonly id: string
  readonly title: string
  readonly count: string
  readonly checks: readonly OverviewCheck[]
  readonly compact?: boolean
  readonly documentId: string
  readonly service: AgentOverviewService
}) {
  return <section className="ov-group" aria-labelledby={id}>
    <div className="ov-group-head">
      <h3 id={id} className="agent-eyebrow">{title}</h3>
      <span className="ov-group-count">{count}</span>
    </div>
    <ul className={compact ? 'ov-check-list is-compact' : 'ov-check-list'}>
      {checks.map(check => <Check key={check.id} check={check} documentId={documentId} service={service} />)}
    </ul>
  </section>
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
  const probe = live.probes[agentOverviewProbe]
  const unavailable = probe?.state === 'unavailable' ? probe?.note ?? 'The Agent overview is not available on this server.' : undefined
  const facts = state.facts, checks = state.checks ?? []
  const words = facts ? serviceWords(facts) : undefined
  const serviceTone: StatusTone = words?.tone === 'ok' ? 'success' : words?.tone === 'error' ? 'critical' : 'neutral'
  const startupWord = words?.startup === 'Starts automatically' ? 'Automatic' : words?.startup === 'Starts manually' ? 'Manual' : words?.startup
  const statusLabel = words ? (startupWord ? `${words.state} · ${startupWord}` : words.state) : 'Reading…'
  const statusBadge = <span className="agent-overview-status" role="status" aria-label={`SQL Server Agent: ${words?.state ?? 'Reading…'}`}><StatusPill tone={serviceTone} label={statusLabel} /></span>
  const liveText = liveLabel(probePillStatus(live, agentOverviewProbe, spec.intervalMs.default))
  const checkedText = probe?.lastSampleAt !== undefined ? `${formatClock(probe.lastSampleAt)} · ${liveText}` : liveText
  const factItems: Fact[] = [
    ...facts?.serviceAccount ? [{ label: 'Service Account', value: facts.serviceAccount }] : [],
    { label: 'Version', value: facts?.productVersion ? `${state.label} (${facts.productVersion})` : state.label },
    { label: 'Checked', value: checkedText }
  ]
  const tools = <button type="button" className="document-verb outline" onClick={() => service.properties(documentId)}>
    <Icon name="settings-gear" /><span className="document-verb-label">Properties</span>
  </button>
  const verbs = [{ command: 'agent.refreshOverview' as const, args: { tabId: documentId }, label: 'Check again' }]
  const attentionChecks = checks.filter(check => check.severity === 'error' || check.severity === 'warning')
  const noteChecks = checks.filter(check => check.severity === 'info')
  const okChecks = checks.filter(check => check.severity === 'ok')
  const unreadChecks = checks.filter(check => check.severity === 'unread')
  return <DocumentFrame id={`agent-overview-${documentId}`} title="SQL Server Agent" subtitle="Overview"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={statusBadge} tools={tools} verbs={verbs} facts={factItems} attributes={{ 'data-agent-overview': documentId }}>
    <div className="agent-overview">
      {state.notice && <InlineError role="status" message={state.notice} />}
      {unavailable ? <EmptyState icon="agent" title="The Agent overview is not available" detail={unavailable} />
        : end ? <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
        : !facts ? <p className="agent-overview-reading" role="status">Checking SQL Server Agent…</p>
        : <>
          <div className="agent-tiles" role="group" aria-label="SQL Server Agent at a glance">
            {(state.tiles ?? []).map(tile => <button key={tile.id} type="button" className="agent-tile agent-overview-tile" data-tone={tile.tone}
              aria-label={tileName({ caption: tile.label, value: tile.value, context: tile.detail || undefined })}
              title={tileHint(tile.id)} onClick={() => service.openTile(documentId, tile.id)}>
              <Tile caption={tile.label} value={tile.value} {...tile.detail ? { context: tile.detail } : {}} />
            </button>)}
          </div>
          {attentionChecks.length > 0 && <CheckGroup id={`agent-checks-${documentId}`} title="Needs attention"
            count={`${attentionChecks.length} of ${checks.length} checks`} checks={attentionChecks} documentId={documentId} service={service} />}
          {noteChecks.length > 0 && <CheckGroup id={`agent-checks-notes-${documentId}`} title="Notes"
            count={String(noteChecks.length)} checks={noteChecks} documentId={documentId} service={service} />}
          {okChecks.length > 0 && <CheckGroup id={`agent-checks-passing-${documentId}`} title="Passing"
            count={String(okChecks.length)} checks={okChecks} compact documentId={documentId} service={service} />}
          {unreadChecks.length > 0 && <CheckGroup id={`agent-checks-unread-${documentId}`} title="Not checked"
            count={String(unreadChecks.length)} checks={unreadChecks} documentId={documentId} service={service} />}
          <p className="agent-checks-hint">Every check is a read; nothing changes until you choose a fix, which opens the usual editor or confirmation. Logins without sysadmin see the checks their role can read.</p>
        </>}
    </div>
  </DocumentFrame>
}
