// Steps › Flow's run overlays (docs/sql-server-agent.md › Steps › Flow; mocks rx-flow-lastrun, rx-flow-running): what the graph draws for
// a run and the side panel beside it. Both read the History section's own view (JobHistoryService), which runs while an overlay shows, and
// the job header's live state; nothing here polls. Last run's run box and History's list share one selected run.
import { useEffect } from 'react'
import { currentStepSeconds, lastRunDrawing, liveRunDrawing, nextWords, runPasses, type FlowPass, type FlowRunDrawing } from '../../../shared/agent/flow-run.ts'
import type { StepsFlow } from '../../../shared/agent/flow.ts'
import { historyRunKeyText } from '../../../shared/agent/history.ts'
import { durationText, elapsedSeconds, failedStep, invokedBy, runIsInProgress, runProgress, runSummary, sameRun, type JobHistoryRun, type JobHistoryStep } from '../../../shared/agent/job-history.ts'
import type { AgentStepsDraft } from '../../../shared/agent/steps.ts'
import type { AgentJobDocumentModel } from '../../../shared/actions/agent-job.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import InlineError from '../kit/InlineError'
import { jobHistoryCopy } from './JobHistory'
import { jobHistoryText } from './JobHistoryService'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'

export type FlowOverlay = 'last' | 'live'
/** What an overlay knows: its run and rows, the passes over the draft, what the canvas draws, and (Live run) the current step. */
export interface FlowRun {
  readonly overlay: FlowOverlay
  readonly run?: JobHistoryRun
  readonly rows: readonly JobHistoryStep[]
  readonly passes: readonly FlowPass[]
  readonly drawing: FlowRunDrawing
  /** The rows are being read (or the run's are not the ones read yet). */
  readonly reading: boolean
  readonly known: boolean
  readonly current?: { readonly at: number; readonly seconds?: number; readonly usual?: number; readonly retrying: boolean }
}

/** The overlay's run, read from History's view: it opens History's view if the section never showed, and Live run follows the running run. */
export function useFlowRun(state: JobDocumentState, model: AgentJobDocumentModel, draft: AgentStepsDraft, flow: StepsFlow, service: JobDocumentService): FlowRun | undefined {
  const history = service.history
  const { documents } = useServiceSnapshot(history)
  const overlay = service.flowOverlayOf(state.id)
  const jobId = model.job?.jobId
  useEffect(() => { if (overlay && jobId) history.attach(state.id, jobId) }, [history, overlay, state.id, jobId])
  // Live run reads the running run's rows, so History's list follows the newest run (All, unpinned) once per run while Live run shows here,
  // never for a run nobody draws: History's own filter and pick stay as they were in List and in other sections.
  const started = state.live?.running ? state.live.started ?? 0 : undefined
  useEffect(() => { if (overlay === 'live' && started !== undefined) history.followNewest(state.id) }, [history, overlay, state.id, started])
  const view = documents[state.id]
  if (!overlay || !view) return undefined
  const steps = draft.steps.map(step => ({ ...step.from !== undefined ? { from: step.from } : {}, name: step.name }))
  if (overlay === 'last') {
    const run = view.runs.find(item => sameRun(item.key, view.selected))
    const rows = run && view.stepsFor === historyRunKeyText(run.key) ? view.steps : []
    const passes = runPasses(rows, steps)
    return { overlay, ...run ? { run } : {}, rows, passes, drawing: lastRunDrawing(flow, passes, !!run && !runIsInProgress(run), !!view.stepsCut), reading: !view.loaded || (!!run && !rows.length), known: true }
  }
  const live = state.live
  const { run, rows, known } = history.running(state.id, live?.step)
  const passes = runPasses(rows, steps)
  const at = live?.step ? draft.steps.findIndex(step => step.from === live.step) : -1
  const seconds = currentStepSeconds(rows, live?.started, live?.now, known, live?.step)
  const usual = live?.step ? view.usual?.bySteps[live.step] : undefined
  const current = { at, retrying: !!live?.retrying, ...seconds !== undefined ? { seconds } : {}, ...usual !== undefined ? { usual } : {} }
  return { overlay, ...run ? { run } : {}, rows, passes, drawing: liveRunDrawing(flow, passes, current, known), reading: !view.loaded, known, current }
}

const toneClass = { ok: 'agent-step-ok', bad: 'agent-step-bad', muted: 'field-note' } as const
const passWords = (pass: FlowPass) => `${pass.outcome}${pass.retries ? `, ${pass.retries} ${pass.retries === 1 ? 'retry' : 'retries'}` : ''}`
/** A history row's step as the graph numbers it (its place in the draft), else the id History recorded. */
const placed = (at: number, stepId: number) => at >= 0 ? at + 1 : stepId
/** Why the panel cannot place a step: past the steps Varia reads, or gone from the job. */
const unplacedWords = (count: number, truncated: boolean) => truncated
  ? `${count} ${count === 1 ? 'pass is' : 'passes are'} of a step past the ones Varia reads, so the graph cannot draw ${count === 1 ? 'it' : 'them'}.`
  : `${count} ${count === 1 ? 'pass is' : 'passes are'} of a step the job no longer has, so the graph cannot draw ${count === 1 ? 'it' : 'them'}.`

/** Last run's panel: the run's summary, every pass in order, and the selected (at first the failed) step's whole message. */
export function LastRunPanel({ state, model, run, service, select }: { readonly state: JobDocumentState; readonly model: AgentJobDocumentModel; readonly run: FlowRun; readonly service: JobDocumentService; readonly select: (at: number) => void }) {
  const history = service.history
  const view = history.get(state.id)
  const ended = history.ended(state.id)
  const failure = ended && <InlineError message={ended.message} code={ended.code} context={`History of ${model.job?.name ?? 'the job'} on ${state.server}`} actions={ended.code === 'PERMISSION_DENIED' ? [] : [{ label: 'Retry', run: () => history.refresh(state.id) }]} />
  if (!view?.loaded) return <section className="agent-flow-sec">{failure || <p className="document-status" role="status"><Icon name="loading" spin />Reading the job's history…</p>}</section>
  if (!run.run) return <section className="agent-flow-sec">{failure}<p className="field-note">{view.failedOnly ? `${jobHistoryCopy.noneFailed} History lists failed runs only; turn Failed off there to draw another run.` : 'This job has no runs in its history yet, so there is nothing to draw over the graph.'}</p></section>
  const selected = run.run
  const outcomeRow = run.rows.find(row => row.stepId === 0)
  const failed = failedStep(run.rows)
  const by = invokedBy(outcomeRow?.message ?? selected.message)
  const usual = view.usual?.job
  const chosen = run.rows.find(row => row.instance === view.step)
  const chosenNo = chosen ? placed(run.passes.find(pass => pass.rows.includes(chosen))?.at ?? -1, chosen.stepId) : 0
  const text = history.messageText(state.id)
  return <>
    <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-run`}>
      <h4 id={`agent-flow-${state.id}-run`}>Run<span className="agent-flow-sec-right">
        <button type="button" className="link-button" onClick={() => service.openHistory(state.id)}><Icon name="history" />Open in History</button></span></h4>
      <dl className="agent-flow-facts">
        <div className="agent-flow-fact"><dt>Started</dt><dd>{selected.started || '—'} (server time)</dd></div>
        <div className="agent-flow-fact"><dt>Duration</dt><dd>{selected.duration || (runIsInProgress(selected) ? 'In progress' : '—')}{usual !== undefined && ` · usual ${durationText(usual)}`}</dd></div>
        {by && <div className="agent-flow-fact"><dt>Invoked by</dt><dd>{by}</dd></div>}
        <div className="agent-flow-fact"><dt>Outcome</dt><dd data-tone={selected.tone || undefined}>
          {selected.tone === 'error' && failed ? <span className="agent-step-bad">{`Failed at step ${placed(run.passes.find(pass => pass.rows.includes(failed))?.at ?? -1, failed.stepId)} (${failed.name})`}</span> : runSummary(selected)}
          {(outcomeRow?.message || selected.message) && <span className="field-note agent-flow-agent-message">{`Agent: ${outcomeRow?.message || selected.message}`}</span>}
        </dd></div>
      </dl>
    </section>
    {run.reading ? <p className="document-status" role="status"><Icon name="loading" spin />Reading the run's steps…</p>
      : run.passes.length > 0 && <table className="properties-table agent-flow-passes" aria-label="Steps of the run, in the order they ran">
        <thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Outcome</th><th scope="col">Duration</th></tr></thead>
        <tbody>{run.passes.map((pass, index) => {
          const last = pass.rows[pass.rows.length - 1]!
          return <tr key={last.instance} aria-selected={last.instance === view.step}>
            <td>{index + 1}</td>
            <td><button type="button" className="link-button" aria-pressed={last.instance === view.step} onClick={() => { history.selectStep(state.id, last.instance); if (pass.at >= 0) select(pass.at) }}>{`${placed(pass.at, pass.stepId)} · ${pass.name}`}</button></td>
            <td className={toneClass[pass.tone]}>{passWords(pass)}</td>
            <td className="mono">{pass.seconds !== undefined ? durationText(pass.seconds) : ''}</td>
          </tr>
        })}</tbody>
      </table>}
    {view.stepsCut && <p className="field-note">{`The run has more rows than History reads; the first ${run.rows.length} are drawn, and the steps after them show —.`}</p>}
    {run.drawing.unplaced > 0 && <p className="field-note">{unplacedWords(run.drawing.unplaced, !!model.stepsTruncated)}</p>}
    {view.failedOnly && <p className="field-note">History lists failed runs only, so the run box does too.</p>}
    {chosen && <section className="agent-flow-sec" aria-label={`Step ${chosenNo} message`}>
      <h4>{`Step ${chosenNo} message`}<span className="agent-flow-sec-right">
        <button type="button" disabled={text === undefined} onClick={() => void history.copyMessage(state.id)}><Icon name="copy" />Copy</button></span></h4>
      {view.message?.state === 'reading' && <p className="document-status" role="status"><Icon name="loading" spin />Reading the whole message…</p>}
      {view.message?.state === 'failed' && <p className="field-note"><Icon name="warning" />{jobHistoryText.messageFailed}</p>}
      <pre className="agent-history-message-text">{text}</pre>
      {view.notice && <p className="document-status" role="status">{view.notice}</p>}
    </section>}
    <p className="field-note">Numbers on the edges are the order the run took them; a step that ran more than once shows {'×'}N and each pass. The box above the graph and History's list share one selected run.</p>
  </>
}

/** Live run's panel: this run against its usual time, the current step and where it can go next, and Stop. */
export function LiveRunPanel({ state, model, run, flow, service }: { readonly state: JobDocumentState; readonly model: AgentJobDocumentModel; readonly run: FlowRun; readonly flow: StepsFlow; readonly service: JobDocumentService }) {
  const { commands } = useWorkbench()
  const live = state.live
  const view = service.history.get(state.id)
  const progress = runProgress(elapsedSeconds(live?.started, live?.now), view?.usual?.job)
  const current = run.current
  const step = current && current.at >= 0 ? current.at : undefined
  return <>
    <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-live`}>
      <h4 id={`agent-flow-${state.id}-live`}>This run<span className="agent-flow-sec-right">{progress.text}</span></h4>
      {progress.share !== undefined && <div className="agent-history-progress" role="progressbar" aria-label="This run against the usual time" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progress.share * 100)} aria-valuetext={progress.text}><i style={{ width: `${Math.round(progress.share * 100)}%` }} /></div>}
    </section>
    <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-current`}>
      <h4 id={`agent-flow-${state.id}-current`}>Current step</h4>
      {step === undefined ? <p className="field-note">{live?.step ? model.stepsTruncated ? `Agent runs step ${live.step}, past the steps Varia reads.` : `Agent runs step ${live.step}, which this draft no longer has.` : 'Waiting for SQL Server Agent to report the step it runs.'}</p> : <>
        <p className="agent-flow-name"><span className="agent-flow-no">{step + 1}</span>{flow.count ? (service.get(state.id)?.draft?.steps.steps[step]?.name || 'Unnamed step') : ''}</p>
        <dl className="agent-flow-facts">
          <div className="agent-flow-fact"><dt>State</dt><dd className="agent-flow-running">{`${current!.retrying ? 'Between retries' : 'Executing'}${current!.seconds !== undefined ? ` · ${durationText(current!.seconds)}` : ''}${current!.usual !== undefined ? ` of usual ${durationText(current!.usual)}` : ''}`}
            {current!.seconds !== undefined && current!.usual !== undefined && current!.seconds > current!.usual && <span className="agent-step-tag" data-tone="warning">Longer than usual</span>}</dd></div>
          <div className="agent-flow-fact"><dt>On success</dt><dd><span className="agent-step-ok"><Icon name="check" /></span>{` ${nextWords(flow, step, 'success')}`}</dd></div>
          <div className="agent-flow-fact"><dt>On failure</dt><dd><span className="agent-step-bad"><Icon name="close" /></span>{` ${nextWords(flow, step, 'fail')}`}</dd></div>
        </dl>
      </>}
      {run.reading ? <p className="document-status" role="status"><Icon name="loading" spin />Reading the run's steps…</p> : !run.known && <p className="field-note">{jobHistoryCopy.runningUnknown}</p>}
    </section>
    <p className="agent-history-actions">
      <button type="button" className="danger" disabled={!service.canStop(state.id)} onClick={() => void commands.execute('agentJob.stop', { tabId: state.id }, 'toolbar')}><Icon name="debug-stop" />Stop job</button>
      <span className="field-note">Stop sends sp_stop_job; the run is recorded as Canceled.</span>
    </p>
    <p className="field-note">{`Live run turns on when the job starts and goes back to the view you had when it ends.${view?.usual?.job !== undefined ? ` The job usually takes ${durationText(view.usual.job)}.` : ''}`}</p>
  </>
}

/** The run box: the runs History lists, newest first; picking one picks it in History too. */
export function RunPicker({ state, service }: { readonly state: JobDocumentState; readonly service: JobDocumentService }) {
  const view = service.history.get(state.id)
  const runs = view?.runs ?? []
  const selected = view?.selected ? historyRunKeyText(view.selected) : ''
  return <select className="property-input agent-flow-run" aria-label="Run to draw" value={selected} disabled={!runs.length}
    onChange={event => { const run = runs.find(item => historyRunKeyText(item.key) === event.target.value); if (run) service.history.selectRun(state.id, run.key) }}>
    {!runs.length && <option value="">{view?.loaded ? view.failedOnly ? 'No failed runs' : 'No runs yet' : 'Reading runs…'}</option>}
    {runs.map(run => <option key={historyRunKeyText(run.key)} value={historyRunKeyText(run.key)}>{`${run.started} · ${runIsInProgress(run) ? 'In progress' : run.outcome}${run.duration ? ` · ${run.duration}` : ''}`}</option>)}
  </select>
}
