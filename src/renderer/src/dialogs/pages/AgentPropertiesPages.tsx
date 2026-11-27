import { useEffect, useRef } from 'react'
import {
  agentPropertiesText, agentPurgeUnitLabels, agentPurgeUnits, draftPurge, keptFor, purgeCutoff, purgeRowsEstimate, rateText, retentionLimits, serverClock, serverTimeDiffers,
  type AgentPropertiesDraft, type AgentPropertiesModel, type AgentPurgeUnit
} from '../../../../shared/actions/agent-properties.ts'
import { agentLimits } from '../../../../shared/agent/catalog.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import FactGrid from '../../kit/FactGrid'
import PropertyField from '../../kit/PropertyField'
import RatioBar from '../../kit/RatioBar'
import StatusPill from '../../kit/StatusPill'
import Switch from '../../kit/Switch'
import { agentPurgeRequest } from '../agent-properties'
import type { PageProps } from '../ObjectDialog'

const loading = (open: PageProps['open']) => <p className="field-note" role="status">{open.phase === 'loading' ? 'Loading…' : ''}</p>
const count = (value: number) => value.toLocaleString('en-US')

/** SQL Server Agent Properties › General (AG-8a): the service's account and start mode as msdb reports them, SSMS's two auto restart switches,
 *  and the error log, read-only for now. */
export function AgentGeneralPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as AgentPropertiesModel | undefined, draft = open.draft as AgentPropertiesDraft | undefined
  if (!model || !draft) return loading(open)
  const { settings } = model
  const settingsDisabled = !editable || !!model.settingsNote
  return <div className="agent-properties">
    {model.settingsNote && <p className="field-note">{model.settingsNote}</p>}
    <section className="agent-props-section" role="group" aria-labelledby="agent-props-service-heading">
      <h3 className="agent-eyebrow" id="agent-props-service-heading">Agent service</h3>
      <FactGrid className="agent-props-facts" facts={[
        { id: 'account', label: 'Service account', value: settings.startupAccount ? displayText(settings.startupAccount) : '', mono: !!settings.startupAccount },
        {
          id: 'autoStart',
          label: 'Starts automatically',
          content: settings.autoStart === undefined ? undefined : <StatusPill size="small" tone={settings.autoStart ? 'success' : 'neutral'} label={settings.autoStart ? 'Yes' : 'No'} />,
          value: settings.autoStart === undefined ? '' : settings.autoStart ? 'Yes' : 'No',
          copyable: false
        }
      ]} />
      <div className="properties-fields">
        <PropertyField id="agent-props-sqlserver-restart" label="Auto restart SQL Server if it stops unexpectedly" changed={draft.sqlserverRestart !== settings.sqlserverRestart}>
          <Switch id="agent-props-sqlserver-restart" checked={draft.sqlserverRestart} disabled={settingsDisabled} changed={draft.sqlserverRestart !== settings.sqlserverRestart}
            onChange={checked => dialogs.updateDraft({ sqlserverRestart: checked })} />
        </PropertyField>
        <PropertyField id="agent-props-monitor-autostart" label="Auto restart SQL Server Agent if it stops unexpectedly" changed={draft.monitorAutostart !== settings.monitorAutostart}>
          <Switch id="agent-props-monitor-autostart" checked={draft.monitorAutostart} disabled={settingsDisabled} changed={draft.monitorAutostart !== settings.monitorAutostart}
            onChange={checked => dialogs.updateDraft({ monitorAutostart: checked })} />
        </PropertyField>
      </div>
    </section>
    <section className="agent-props-section" aria-labelledby="agent-props-errorlog-heading">
      <h3 className="agent-eyebrow" id="agent-props-errorlog-heading">Error log</h3>
      <FactGrid className="agent-props-facts" facts={[
        { id: 'errorLog', label: 'File name', value: settings.errorLogFile ?? '', mono: !!settings.errorLogFile },
        { id: 'trace', label: 'Execution trace messages', value: ((settings.errorLoggingLevel ?? 0) & 4) !== 0 ? 'On' : 'Off', copyable: false }
      ]} />
    </section>
    <p className="field-note">The error log is read-only here for now. Advanced, Alert System, Job System and Connection come later; set them in SSMS.</p>
  </div>
}

/** "What this keeps": each job's rate over the last days and how long its history lasts under the limits now, and under the draft's when it
 *  differs. Sysadmin only (other logins cannot read sysjobhistory); the note says why it is missing otherwise. */
function RetentionTable({ model, draft }: { readonly model: AgentPropertiesModel; readonly draft: AgentPropertiesDraft }) {
  const history = model.history
  if (!history) return model.historyNote ? <p className="field-note">{model.historyNote}</p> : null
  if (!history.jobs.length) return <p className="field-note">No job has history on this server yet.</p>
  const { now, after } = retentionLimits(model, draft)
  const kept = history.jobs.map(job => ({ job, now: keptFor(job, history, now), after: after && keptFor(job, history, after) }))
  const tighter = kept.some(row => (row.after ?? row.now).server)
  const limit = after?.maxRows ?? now.maxRows
  return <section className="agent-props-section agent-retention" aria-labelledby="agent-retention-caption">
    <h3 className="agent-eyebrow" id="agent-retention-caption">What this keeps <span className="field-note">(rates from the last {agentLimits.retentionDays} days)</span></h3>
    <table className="agent-table agent-retention-table" aria-labelledby="agent-retention-caption">
      <thead><tr><th scope="col">Job</th><th scope="col" className="num">Rows written</th><th scope="col" className="num">Kept now</th>{after && <th scope="col" className="num">Kept after OK</th>}</tr></thead>
      <tbody>{kept.map(row => <tr key={row.job.name}>
        <td title={displayText(row.job.name)}>{displayText(row.job.name)}</td><td className="num">{rateText(row.job.recent)}</td>
        <td className={row.now.server ? 'num agent-retention-server' : 'num'} data-tone={row.now.server ? 'warning' : undefined}>{row.now.text}</td>
        {after && <td className={row.after?.server ? 'num agent-retention-server' : 'num'} data-tone={row.after?.server ? 'warning' : row.now.server && !row.after?.server ? 'success' : undefined}>{row.after?.text}</td>}
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
  const cancel = useRef<HTMLButtonElement>(null), ask = useRef<HTMLButtonElement>(null)
  // The confirmation's default is Cancel, as every destructive confirmation's is.
  useEffect(() => { if (draft.purgeConfirming) cancel.current?.focus() }, [draft.purgeConfirming])
  // The server's clock as of this render: the confirmation shows the cut-off its request then carries, and the server deletes no later.
  const clock = serverClock(model)
  const purge = draftPurge(draft), valid = !('problem' in purge)
  const cutoff = valid ? purgeCutoff(clock, purge) : undefined
  const estimate = valid ? purgeRowsEstimate(model, purge, clock) : undefined
  const serverTime = serverTimeDiffers(model.serverOffsetMinutes)
  const usable = editable && !model.readOnly
  const dismiss = () => { dialogs.updateDraft({ purgeConfirming: false }); queueMicrotask(() => ask.current?.focus()) }
  const run = () => {
    const request = agentPurgeRequest(open.target, draft, clock)
    dialogs.updateDraft({ purgeConfirming: false })
    if (request) void dialogs.runInline(request)
  }
  return <section className="agent-props-section agent-purge" role="group" aria-labelledby="agent-purge-caption">
    <h3 className="agent-eyebrow" id="agent-purge-caption">Delete old history now</h3>
    <div className="agent-purge-row">
      <label htmlFor="agent-purge-count">Older than</label>
      <input id="agent-purge-count" type="text" inputMode="numeric" className="ui-field agent-purge-count" value={draft.purgeCount} disabled={!usable} aria-invalid={!valid} aria-describedby="agent-purge-hint"
        onChange={event => dialogs.updateDraft({ purgeCount: event.target.value, purgeConfirming: false })}
        // Enter here asks to delete, as Delete history… does, rather than pressing OK, which would save the settings instead.
        onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); event.stopPropagation(); if (valid && usable) dialogs.updateDraft({ purgeConfirming: true }) }} />
      <select className="ui-field" aria-label="Unit" value={draft.purgeUnit} disabled={!usable} onChange={event => dialogs.updateDraft({ purgeUnit: Number(event.target.value) as AgentPurgeUnit, purgeConfirming: false })}>
        {agentPurgeUnits.map(unit => <option key={unit} value={unit}>{agentPurgeUnitLabels[unit]}</option>)}
      </select>
      <button ref={ask} type="button" disabled={!usable || !valid || draft.purgeConfirming} onClick={() => dialogs.updateDraft({ purgeConfirming: true })}>Delete history…</button>
    </div>
    <p className="field-note" id="agent-purge-hint">{valid ? [cutoff && `Before ${cutoff}${serverTime ? ', server time' : ''}`, estimate !== undefined && `about ${count(estimate)} ${estimate === 1 ? 'row' : 'rows'}`].filter(Boolean).join(' · ') : purge.problem}</p>
    <p className="field-note">{agentPropertiesText.purgeNote}</p>
    {draft.purgeConfirming && valid && <div className="agent-purge-confirm" role="group" aria-label="Confirm Delete old history now"
      // Escape answers the question (no), as Cancel does, instead of closing the dialog and its unsaved changes.
      onKeyDown={event => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); dismiss() }}>
      <Icon name="warning" /><span className="agent-purge-question">{agentPropertiesText.purgeConfirm(displayText(open.server), cutoff ?? '', serverTime)}</span>
      <span className="agent-purge-actions">
        <button ref={cancel} type="button" onClick={dismiss}>Cancel</button>
        <button type="button" className="danger" onClick={run}>Delete history</button>
      </span>
    </div>}
    {open.inline?.state === 'done' && <p className="field-note" role="status"><Icon name="pass" />{[agentPropertiesText.purged, ...open.inline.messages].join(' ')}</p>}
    {open.inline?.state === 'failed' && <p className="field-note" role="alert"><Icon name="warning" />{open.inline.error.message}</p>}
  </section>
}

/** SQL Server Agent Properties › History (AG-8a): SSMS's job history log limits, what they keep for each job, and Delete old history now. */
export function AgentHistoryPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as AgentPropertiesModel | undefined, draft = open.draft as AgentPropertiesDraft | undefined
  if (!model || !draft) return loading(open)
  const settingsDisabled = !editable || !!model.settingsNote
  const used = model.history?.total ?? 0
  const max = model.settings.historyMaxRows
  const pct = max > 0 ? (used / max) * 100 : 0
  const available = Math.max(0, max - used)
  return <div className="agent-properties">
    {model.settingsNote && <p className="field-note">{model.settingsNote}</p>}
    <section className="agent-props-section" role="group" aria-labelledby="agent-props-history-heading">
      <h3 className="agent-eyebrow" id="agent-props-history-heading">Job history log</h3>
      {model.history && max > 0 && <RatioBar
        title="Current log usage"
        totalLabel={`${count(used)} / ${count(max)} rows (${pct.toFixed(1)}%)`}
        segments={[
          { id: 'used', label: 'Used', value: used, displayValue: `${count(used)} rows`, series: pct >= 80 ? 2 : 1 },
          { id: 'available', label: 'Available', value: available, displayValue: `${count(available)} rows`, series: 3 }
        ]}
      />}
      <div className="properties-fields">
        <PropertyField id="agent-history-limit" label={agentPropertiesText.limit}>
          <Switch id="agent-history-limit" checked={draft.limit} disabled={settingsDisabled} onChange={checked => dialogs.updateDraft({ limit: checked })} />
        </PropertyField>
        <PropertyField id="agent-history-max" label={agentPropertiesText.maxRows}>
          <span className="agent-history-input">
            <input id="agent-history-max" className="ui-field" type="text" inputMode="numeric" disabled={settingsDisabled || !draft.limit} value={draft.maxRows} onChange={event => dialogs.updateDraft({ maxRows: event.target.value })} />
            {model.history && <span className="field-note">now {count(model.history.total)} rows</span>}
          </span>
        </PropertyField>
        <PropertyField id="agent-history-per-job" label={agentPropertiesText.maxRowsPerJob}>
          <span className="agent-history-input">
            <input id="agent-history-per-job" className="ui-field" type="text" inputMode="numeric" disabled={settingsDisabled || !draft.limit} value={draft.maxRowsPerJob} onChange={event => dialogs.updateDraft({ maxRowsPerJob: event.target.value })} />
          </span>
        </PropertyField>
      </div>
    </section>
    <RetentionTable model={model} draft={draft} />
    <PurgeSection open={open} model={model} draft={draft} editable={editable} />
  </div>
}
