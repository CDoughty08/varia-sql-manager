// The job document's History section (AG-6d, docs/sql-server-agent.md › Job document › History; mocks rx-job-history and rx-job-running):
// the run durations' sparkline with the usual time, the runs (All or Failed), and the selected run's detail: who started it, its outcome,
// its steps with an SSIS execution link, and the failed step's whole message with Copy, Edit step and Start at step. While the job runs,
// the run view comes first: this run against the usual time and each step's state, with Stop. JobHistoryService and JobDocumentService
// keep every state; this only draws it.
import { useEffect } from 'react'
import type { AgentJobDocumentModel } from '../../../shared/actions/agent-job.ts'
import { historyRunKeyText } from '../../../shared/agent/history.ts'
import {
  durationText, durationWords, elapsedSeconds, invokedBy, jobHistoryLimits, lastStepOf, runIsInProgress, runningSteps, runProgress, runSummary, sameRun, sparkBars, ssisExecutionId,
  type JobHistoryRun, type JobHistoryStep, type JobUsual
} from '../../../shared/agent/job-history.ts'
import { stampText } from '../../../shared/agent/jobs.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import InlineError from '../kit/InlineError'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'
import { jobHistoryText } from './JobHistoryService'

const runTone = (tone: string): StatusTone => tone === 'error' ? 'critical' : tone === 'running' || tone === 'accent' ? 'running' : tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'neutral'
const runGlyph = (run: JobHistoryRun) => runIsInProgress(run) ? 'play' : run.tone === 'error' ? 'error' : run.tone === 'success' ? 'pass' : run.tone === 'warning' ? 'warning' : 'circle-outline'

export const jobHistoryCopy = {
  intro: 'The usual time is the median of the last 10 successful runs. It is a guide, not a promise.',
  running: (since?: string) => `Running${since ? ` since ${since} (server time)` : ''}. You can keep editing: saved changes apply from the next run.`,
  stopHint: 'Stop sends sp_stop_job; the current step is cancelled and the run is recorded as Canceled.',
  ssisHint: 'For an SSIS step, its execution link opens that execution\'s overview and catalog messages, where the real error usually is.',
  none: 'This job has no history yet. Runs show here as SQL Server Agent records them.',
  noneFailed: 'No failed runs in the history SQL Server Agent keeps.',
  logViewer: "All jobs' history in Log File Viewer",
  runningUnknown: "The other steps' states show once History has read this run, with it selected under All.",
  disconnected: "The job's history is read once the connection is back.",
  stepsCut: (rows: number) => `Showing this run's first ${rows} rows.`
} as const

/** The run durations as bars, newest last, with the usual time as a line: plain elements with one accessible name (not a ChartView: runs are not samples over time). */
function Sparkline({ runs, usual }: { readonly runs: readonly JobHistoryRun[]; readonly usual?: number }) {
  const { bars, usualAt } = sparkBars(runs, usual)
  if (!bars.length) return null
  const failed = bars.filter(bar => bar.failed).length
  const label = `Durations of the last ${bars.length} ${bars.length === 1 ? 'run' : 'runs'}${failed ? `, ${failed} failed` : ''}${usual !== undefined ? `; usual ${durationWords(usual)}` : ''}`
  return <div className="agent-history-spark" role="img" aria-label={label}>
    {bars.map(bar => <i key={bar.key} title={bar.label} data-failed={bar.failed || undefined} style={{ height: `${Math.max(4, Math.round(bar.height * 100))}%` }} />)}
    {usualAt !== undefined && <b aria-hidden="true" style={{ bottom: `${Math.round(usualAt * 100)}%` }} />}
  </div>
}

/** The running job's view: this run against the usual time, each step's state, and Stop. */
function RunningView({ state, model, rows, known, usual, service }: {
  readonly state: JobDocumentState; readonly model: AgentJobDocumentModel; readonly rows: readonly JobHistoryStep[]; readonly known: boolean; readonly usual?: JobUsual
  readonly service: JobDocumentService
}) {
  const { commands } = useWorkbench()
  const live = state.live!
  const elapsed = elapsedSeconds(live.started, live.now)
  const progress = runProgress(elapsed, usual?.job)
  const steps = runningSteps(model.steps.map(step => ({ id: step.id, name: step.name })), rows.filter(row => row.stepId > 0), live.step, !!live.retrying, usual, known)
  return <div className="agent-history-running" role="group" aria-label="This run">
    <p className="document-status" role="status"><Icon name="play" />{jobHistoryCopy.running(live.started ? stampText(live.started, live.now ? Math.trunc(live.now / 1_000_000) : undefined) : undefined)}</p>
    <div className="agent-history-progress-head"><strong>This run</strong><span>{progress.text}</span></div>
    {progress.share !== undefined && <div className="agent-history-progress" role="progressbar" aria-label="This run against the usual time" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.share * 100)} aria-valuetext={progress.text}>
      <i style={{ width: `${Math.round(progress.share * 100)}%` }} />
    </div>}
    <p className="field-note">{jobHistoryCopy.intro}</p>
    <table className="properties-table" aria-label="Steps of this run">
      <thead><tr><th scope="col">Step</th><th scope="col">State</th><th scope="col">This run</th><th scope="col">Usual</th></tr></thead>
      <tbody>{steps.map(step => <tr key={step.id} data-state={step.state} aria-current={step.state === 'executing' || step.state === 'retrying' ? 'step' : undefined}>
        <td>{step.id} · {step.name}</td>
        <td>{step.state === 'executing' || step.state === 'retrying' ? <StatusPill tone="running" label={step.label} size="small" /> : step.state === 'waiting' || step.state === 'unknown' ? <span className="field-note">{step.label}</span>
          : <StatusPill tone={step.state === 'failed' ? 'critical' : step.state === 'succeeded' ? 'success' : step.state === 'retry' ? 'warning' : 'neutral'} label={step.label} size="small" />}</td>
        <td className="mono">{step.seconds !== undefined ? durationText(step.seconds) : ''}</td>
        <td className="mono field-note">{step.usual !== undefined ? durationText(step.usual) : ''}</td>
      </tr>)}</tbody>
    </table>
    {!known && <p className="field-note">{jobHistoryCopy.runningUnknown}</p>}
    <p className="agent-history-actions">
      <button type="button" className="danger" disabled={!service.canStop(state.id)} onClick={() => void commands.execute('agentJob.stop', { tabId: state.id }, 'toolbar')}><Icon name="debug-stop" />Stop job</button>
      <span className="field-note">{jobHistoryCopy.stopHint}</span>
    </p>
  </div>
}

/** The selected run: when and how long, who started it, its outcome, its steps, and the chosen step's whole message. */
function RunDetail({ state, model, run, service }: { readonly state: JobDocumentState; readonly model: AgentJobDocumentModel; readonly run: JobHistoryRun; readonly service: JobDocumentService }) {
  const history = service.history
  const view = history.get(state.id)!
  // Rows read for another run (the one picked before) never describe this one.
  const rows = view.stepsFor === historyRunKeyText(run.key) ? view.steps : []
  const steps = rows.filter(step => step.stepId > 0)
  const outcomeRow = rows.find(step => step.stepId === 0)
  const by = invokedBy(outcomeRow?.message ?? run.message)
  const usual = view.usual?.job
  const chosen = rows.find(step => step.instance === view.step)
  const text = history.messageText(state.id)
  // Edit and Start at step act on the job as it is now: the step with the name history recorded, which a reorder may have moved.
  const current = chosen ? model.steps.find(step => step.name === chosen.name) : undefined
  return <div className="agent-history-detail" role="group" aria-label={`Run of ${run.started}`}>
    <dl className="agent-job-facts">
      <dt>Started</dt><dd>{run.started || '—'} (server time)</dd>
      <dt>Duration</dt><dd>{run.duration || (runIsInProgress(run) ? 'In progress' : '—')}{usual !== undefined && ` · usual ${durationText(usual)}`}</dd>
      {by && <><dt>Invoked by</dt><dd>{by}</dd></>}
      <dt>Outcome</dt><dd data-tone={run.tone || undefined}>{outcomeRow?.message || run.message || run.outcome}</dd>
    </dl>
    {view.stepsFor === historyRunKeyText(run.key) ? steps.length > 0 && <table className="properties-table agent-history-steps" aria-label="Steps of the selected run">
      <thead><tr><th scope="col">Step</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col">Retries</th><th scope="col">Details</th></tr></thead>
      <tbody>{steps.map(step => {
        const execution = ssisExecutionId(step.message)
        return <tr key={step.instance} aria-selected={step.instance === view.step}>
          <td><button type="button" className="link-button" aria-pressed={step.instance === view.step} onClick={() => history.selectStep(state.id, step.instance)}>{step.stepId} · {step.name}</button></td>
          <td><StatusPill tone={runTone(step.tone)} label={step.outcome} size="small" /></td>
          <td className="mono">{step.duration}</td>
          <td>{step.retries}</td>
          <td>{execution !== undefined && <button type="button" className="link-button" disabled={!history.canOpenSsisExecution(state.id)} title={jobHistoryCopy.ssisHint}
            onClick={() => history.openSsisExecution(state.id, execution)}><Icon name="link" />SSIS execution {execution}</button>}</td>
        </tr>
      })}</tbody>
    </table> : <Skeleton rows={2} label="Reading the run's steps" />}
    {rows.length > 0 && view.stepsCut && <p className="field-note">{jobHistoryCopy.stepsCut(rows.length)}</p>}
    {chosen && <section className="agent-history-message" aria-label={`Step ${chosen.stepId} message`}>
      <div className="agent-history-message-head"><strong>Step {chosen.stepId} message</strong>
        <button type="button" disabled={text === undefined} onClick={() => void history.copyMessage(state.id)}><Icon name="copy" />Copy</button></div>
      {view.message?.state === 'reading' && <p className="document-status" role="status"><Icon name="loading" spin />Reading the whole message…</p>}
      {view.message?.state === 'failed' && <p className="field-note"><Icon name="warning" />{jobHistoryText.messageFailed}</p>}
      <pre className="agent-history-message-text">{text}</pre>
      {view.notice && <p className="document-status" role="status">{view.notice}</p>}
      {current && <p className="agent-history-actions">
        <button type="button" onClick={() => { service.selectStep(state.id, `s${current.id}`); document.getElementById(`agent-job-${state.id}-section-steps`)?.scrollIntoView({ block: 'start' }) }}><Icon name="edit" />Edit step {current.id}</button>
        <button type="button" disabled={!service.canStart(state.id)} onClick={() => void service.start(state.id, current.name)}><Icon name="play" />Start at step {current.id}</button>
      </p>}
    </section>}
    {steps.some(step => ssisExecutionId(step.message) !== undefined) && <p className="field-note">{jobHistoryCopy.ssisHint}</p>}
  </div>
}

/** The History section: opens its live view when it first shows, then draws what the view read. */
export default function JobHistory({ state, model, service }: { readonly state: JobDocumentState; readonly model: AgentJobDocumentModel; readonly service: JobDocumentService }) {
  const { logViewer, commands, documents: tabs } = useWorkbench()
  const history = service.history
  const { documents } = useServiceSnapshot(history)
  const jobId = model.job?.jobId
  useEffect(() => { if (jobId) history.attach(state.id, jobId) }, [history, state.id, jobId])
  const handle = history.handle(state.id)
  // The view's own state (an error ending it) redraws the section too.
  useServiceSnapshot<unknown>(handle ?? history)
  const view = documents[state.id]
  if (!jobId) return null
  if (!history.available()) return <p className="field-note">History is not available here.</p>
  const ended = history.ended(state.id)
  const running = !!state.live?.running
  const selected = view?.runs.find(run => sameRun(run.key, view.selected))
  const inProgress = view?.runs.find(runIsInProgress)
  const spanned = view ? Math.min(jobHistoryLimits.sparkRuns, view.spark.filter(run => run.seconds !== undefined && !runIsInProgress(run)).length) : 0
  // The running view knows each step's state only from this run's own rows: with another run selected (or Failed on) it holds none. A run
  // not listed yet (msdb writes a row only when a step ends) has no rows to hold, under All with the newest followed.
  // Once Agent has moved past step 1 a run with no rows read is not one with no rows, so its earlier steps are unknown until History reads them.
  const runningKnown = !!view && (inProgress
    ? sameRun(view.selected, inProgress.key) && view.stepsFor === historyRunKeyText(inProgress.key) && !view.stepsCut
    : !view.failedOnly && !view.pinned && (state.live?.step ?? 1) <= 1)
  const runningRows = running && inProgress && runningKnown ? view!.steps : []
  const openViewer = () => {
    const connectionId = tabs.get(state.id)?.connectionId
    try { if (connectionId) logViewer.open(connectionId, { jobs: [jobId] }) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'Log File Viewer could not open.') }
  }
  return <div className="agent-history" data-agent-history={state.id}>
    {running && <RunningView state={state} model={model} rows={runningRows} known={runningKnown} usual={view?.usual} service={service} />}
    {ended && <InlineError message={ended.message} code={ended.code} context={`History of ${model.job!.name} on ${state.server}`} actions={ended.code === 'PERMISSION_DENIED' ? [] : [{ label: 'Retry', run: () => history.refresh(state.id) }]} />}
    {!view?.loaded ? !ended && (history.connected(state.id) ? <Skeleton rows={3} label="Reading the job's history" /> : <p className="field-note">{jobHistoryCopy.disconnected}</p>) : <>
      <div className="agent-history-head">
        <strong>{spanned ? `Duration, last ${spanned} ${spanned === 1 ? 'run' : 'runs'}` : 'Duration'}</strong>
        <span className="field-note">{view.usual?.job !== undefined ? `usual ${durationWords(view.usual.job)}` : 'no usual time yet: no successful run'}</span>
      </div>
      <Sparkline runs={view.spark} usual={view.usual?.job} />
      <div className="agent-history-head">
        <strong>Runs</strong>
        <span className="agent-history-filter" role="radiogroup" aria-label="Runs to list">
          <button type="button" role="radio" aria-checked={!view.failedOnly} onClick={() => history.setFailedOnly(state.id, false)}>All</button>
          <button type="button" role="radio" aria-checked={view.failedOnly} onClick={() => history.setFailedOnly(state.id, true)}>Failed</button>
        </span>
      </div>
      <div className="agent-history-body">
        {view.runs.length === 0 ? !ended && <p className="field-note">{view.failedOnly ? jobHistoryCopy.noneFailed : jobHistoryCopy.none}</p>
          : <ul className="agent-history-runs" aria-label="Runs">{view.runs.map(run => {
            const by = invokedBy(run.message), last = lastStepOf(run.message)
            return <li key={historyRunKeyText(run.key)}>
              <button type="button" aria-pressed={sameRun(run.key, view.selected)} onClick={() => history.selectRun(state.id, run.key)}
                aria-label={`${run.started}, ${runSummary(run)}${run.duration ? `, ${run.duration}` : ''}`}>
                <Icon name={runGlyph(run)} /><span className="agent-history-run-when">{runIsInProgress(run) ? `${run.started} · in progress` : run.started}</span>
                <span className="agent-history-run-tag mono">{run.duration}</span>
                <span className="agent-history-run-note">{runSummary(run)}{by ? ` · ${by}` : last && run.tone !== 'error' ? ` · last step ${last.id}` : ''}</span>
              </button>
            </li>
          })}</ul>}
        {selected && <RunDetail state={state} model={model} run={selected} service={service} />}
      </div>
      {view.more && <p className="field-note">Showing the newest {view.runs.length} runs.</p>}
      <p><button type="button" className="link-button" onClick={openViewer}><Icon name="history" />{jobHistoryCopy.logViewer}</button></p>
    </>}
  </div>
}
