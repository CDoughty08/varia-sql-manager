import { useEffect, useRef } from 'react'
import {
  agentPropertiesText, agentPurgeUnitLabels, agentPurgeUnits, draftLimits, draftPurge, keptFor, purgeCutoff, purgeRowsEstimate, rateText, serverTimeDiffers,
  type AgentPropertiesDraft, type AgentPropertiesModel, type AgentPurgeUnit
} from '../../../../shared/actions/agent-properties.ts'
import { agentLimits } from '../../../../shared/agent/catalog.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import { agentPurgeRequest } from '../agent-properties'
import type { PageProps } from '../ObjectDialog'

const loading = (open: PageProps['open']) => <p className="field-note" role="status">{open.phase === 'loading' ? 'Loading…' : ''}</p>
const count = (value: number) => value.toLocaleString('en-US')

/** SQL Server Agent Properties › General (AG-8a): the service's account and start mode as msdb reports them, SSMS's two auto restart boxes,
 *  and the error log, read-only for now. */
export function AgentGeneralPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as AgentPropertiesModel | undefined, draft = open.draft as AgentPropertiesDraft | undefined
  if (!model || !draft) return loading(open)
  const { settings } = model
  return <div className="agent-properties">
    <fieldset className="object-dialog-options" disabled={!editable}>
      <legend className="object-dialog-caption">Agent service</legend>
      <dl className="agent-service-facts">
        <dt>Service account:</dt><dd>{settings.startupAccount ? displayText(settings.startupAccount) : '—'}</dd>
        <dt>Starts automatically:</dt><dd>{settings.autoStart === undefined ? '—' : settings.autoStart ? 'Yes' : 'No'}</dd>
      </dl>
      <label className="checkbox-label"><input type="checkbox" checked={draft.sqlserverRestart} onChange={event => dialogs.updateDraft({ sqlserverRestart: event.target.checked })} />
        Auto restart SQL Server if it stops unexpectedly</label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.monitorAutostart} onChange={event => dialogs.updateDraft({ monitorAutostart: event.target.checked })} />
        Auto restart SQL Server Agent if it stops unexpectedly</label>
    </fieldset>
    <fieldset className="object-dialog-options property-grid" disabled>
      <legend className="object-dialog-caption">Error log</legend>
      <div className="property-row"><label htmlFor="agent-properties-errorlog">File name</label>
        <input id="agent-properties-errorlog" type="text" readOnly value={settings.errorLogFile ?? ''} /></div>
      <label className="checkbox-label"><input type="checkbox" checked={((settings.errorLoggingLevel ?? 0) & 4) !== 0} readOnly />Include execution trace messages</label>
    </fieldset>
    <p className="field-note">The error log is read-only here for now. Advanced, Alert System, Job System and Connection come later; set them in SSMS.</p>
  </div>
}

/** "What this keeps": each job's rate over the last days and how long its history lasts under the limits now, and under the draft's when it
 *  differs. Sysadmin only (other logins cannot read sysjobhistory); the note says why it is missing otherwise. */
function RetentionTable({ model, draft }: { readonly model: AgentPropertiesModel; readonly draft: AgentPropertiesDraft }) {
  const history = model.history
  if (!history) return model.historyNote ? <p className="field-note">{model.historyNote}</p> : null
  if (!history.jobs.length) return <p className="field-note">No job has history on this server yet.</p>
  const now = { maxRows: model.settings.historyMaxRows, maxRowsPerJob: model.settings.historyMaxRowsPerJob || undefined }
  const asked = draftLimits(draft)
  const after = 'problem' in asked || (asked.maxRows === now.maxRows && asked.maxRowsPerJob === now.maxRowsPerJob) ? undefined : asked
  const kept = history.jobs.map(job => ({ job, now: keptFor(job, history, now), after: after && keptFor(job, history, after) }))
  const tighter = kept.some(row => (row.after ?? row.now).server)
  const limit = after?.maxRows ?? now.maxRows
  return <section className="agent-retention" aria-labelledby="agent-retention-caption">
    <div className="object-dialog-caption" id="agent-retention-caption">What this keeps <span className="field-note">(rates from the last {agentLimits.retentionDays} days)</span></div>
    <table className="object-dialog-grid" aria-labelledby="agent-retention-caption">
      <thead><tr><th scope="col">Job</th><th scope="col">Rows written</th><th scope="col">Kept now</th>{after && <th scope="col">Kept after OK</th>}</tr></thead>
      <tbody>{kept.map(row => <tr key={row.job.name}>
        <td title={displayText(row.job.name)}>{displayText(row.job.name)}</td><td>{rateText(row.job.recent)}</td>
        <td className={row.now.server ? 'agent-retention-server' : undefined}>{row.now.text}</td>
        {after && <td className={row.after?.server ? 'agent-retention-server' : undefined}>{row.after?.text}</td>}
      </tr>)}</tbody>
    </table>
    {history.jobsTruncated && <p className="field-note">Only the {count(history.jobs.length)} jobs with the most history are listed.</p>}
    {tighter && limit !== -1 && <ul className="object-dialog-warnings" aria-label="Notes"><li><Icon name="warning" /><span>{agentPropertiesText.serverTighter(limit)}</span></li></ul>}
  </section>
}

/** History's Delete old history now: the cut-off from the server's clock, about how many rows go, and the inline confirmation, which sends the
 *  purge apart from OK. */
function PurgeSection({ open, model, draft, editable }: { readonly open: PageProps['open']; readonly model: AgentPropertiesModel; readonly draft: AgentPropertiesDraft; readonly editable: boolean }) {
  const { dialogs } = useWorkbench()
  const cancel = useRef<HTMLButtonElement>(null)
  // The confirmation's default is Cancel, as every destructive confirmation's is.
  useEffect(() => { if (draft.purgeConfirming) cancel.current?.focus() }, [draft.purgeConfirming])
  const purge = draftPurge(draft), valid = !('problem' in purge)
  const cutoff = valid ? purgeCutoff(model.serverNow, purge) : undefined
  const estimate = valid ? purgeRowsEstimate(model, purge) : undefined
  const serverTime = serverTimeDiffers(model.serverOffsetMinutes)
  const usable = editable && !model.readOnly
  const run = () => {
    const request = agentPurgeRequest(open.target, draft)
    dialogs.updateDraft({ purgeConfirming: false })
    if (request) void dialogs.runInline(request)
  }
  return <fieldset className="object-dialog-options agent-purge" disabled={!usable}>
    <legend className="object-dialog-caption">Delete old history now</legend>
    <div className="agent-purge-row">
      <label htmlFor="agent-purge-count">Older than</label>
      <input id="agent-purge-count" type="text" inputMode="numeric" className="agent-purge-count" value={draft.purgeCount} aria-invalid={!valid}
        onChange={event => dialogs.updateDraft({ purgeCount: event.target.value, purgeConfirming: false })} />
      <select aria-label="Unit" value={draft.purgeUnit} onChange={event => dialogs.updateDraft({ purgeUnit: Number(event.target.value) as AgentPurgeUnit, purgeConfirming: false })}>
        {agentPurgeUnits.map(unit => <option key={unit} value={unit}>{agentPurgeUnitLabels[unit]}</option>)}
      </select>
      <button type="button" disabled={!valid || draft.purgeConfirming} onClick={() => dialogs.updateDraft({ purgeConfirming: true })}>Delete history…</button>
    </div>
    <p className="field-note" id="agent-purge-hint">{valid ? [cutoff && `Before ${cutoff}${serverTime ? ', server time' : ''}`, estimate !== undefined && `about ${count(estimate)} ${estimate === 1 ? 'row' : 'rows'}`].filter(Boolean).join(' · ') : purge.problem}</p>
    <p className="field-note">{agentPropertiesText.purgeNote}</p>
    {draft.purgeConfirming && valid && <div className="agent-purge-confirm" role="group" aria-label="Confirm Delete old history now">
      <Icon name="warning" /><span>{agentPropertiesText.purgeConfirm(displayText(open.server), cutoff ?? '', serverTime)}</span>
      <span className="agent-purge-actions">
        <button ref={cancel} type="button" onClick={() => dialogs.updateDraft({ purgeConfirming: false })}>Cancel</button>
        <button type="button" className="danger" onClick={run}>Delete history</button>
      </span>
    </div>}
    {open.inline?.state === 'done' && <p className="field-note" role="status"><Icon name="pass" />{[agentPropertiesText.purged, ...open.inline.messages].join(' ')}</p>}
    {open.inline?.state === 'failed' && <p className="field-note" role="alert"><Icon name="warning" />{open.inline.error.message}</p>}
  </fieldset>
}

/** SQL Server Agent Properties › History (AG-8a): SSMS's job history log limits, what they keep for each job, and Delete old history now. */
export function AgentHistoryPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as AgentPropertiesModel | undefined, draft = open.draft as AgentPropertiesDraft | undefined
  if (!model || !draft) return loading(open)
  return <div className="agent-properties">
    <fieldset className="object-dialog-options property-grid" disabled={!editable}>
      <legend className="object-dialog-caption">Job history log</legend>
      <label className="checkbox-label"><input type="checkbox" checked={draft.limit} onChange={event => dialogs.updateDraft({ limit: event.target.checked })} />{agentPropertiesText.limit}</label>
      <div className="property-row"><label htmlFor="agent-history-max">{agentPropertiesText.maxRows}</label>
        <span className="agent-history-input"><input id="agent-history-max" type="text" inputMode="numeric" disabled={!draft.limit} value={draft.maxRows} onChange={event => dialogs.updateDraft({ maxRows: event.target.value })} />
          {model.history && <span className="field-note">now {count(model.history.total)} rows</span>}</span></div>
      <div className="property-row"><label htmlFor="agent-history-per-job">{agentPropertiesText.maxRowsPerJob}</label>
        <input id="agent-history-per-job" type="text" inputMode="numeric" disabled={!draft.limit} value={draft.maxRowsPerJob} onChange={event => dialogs.updateDraft({ maxRowsPerJob: event.target.value })} /></div>
    </fieldset>
    <RetentionTable model={model} draft={draft} />
    <PurgeSection open={open} model={model} draft={draft} editable={editable} />
  </div>
}
