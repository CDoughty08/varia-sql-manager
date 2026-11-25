// The job document's History section and its live run view (AG-6d, docs/sql-server-agent.md › Job document › History): the args its
// agent.history view sends, and the pure rules it draws by: durations, the usual time, the sparkline's bars, what a run's outcome
// message says (who invoked it, its last step), an SSIS step's catalog execution, and each step's state while the job runs. The backend
// reads and groups the runs and works out the usual durations (Agent/AgentHistoryReader.cs); nothing here reads a server. No React here.
import { historyRunKeyText, type AgentHistoryArgs, type HistoryRunKey } from './history.ts'

/** How many of the newest runs the sparkline draws, and how many runs the list shows. */
export const jobHistoryLimits = { sparkRuns: 14, listRuns: 50, messageRows: 200 } as const

/** The History section's args: its one job, its usual durations, the Failed filter and the selected run. */
export function jobHistoryArgs(jobId: string, options: { readonly failedOnly?: boolean; readonly run?: HistoryRunKey } = {}): AgentHistoryArgs {
  return {
    jobs: [jobId.toLowerCase()], usual: true, ...options.failedOnly ? { outcome: 'failed' } : {},
    ...options.run ? { run: { job: options.run.job.toLowerCase(), instance: options.run.instance } } : {}
  }
}

/** SSMS's duration text (HH:MM:SS, hours past 99 as they come) as seconds; undefined for anything else. */
export function durationSeconds(text: string | undefined): number | undefined {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)$/.exec(text?.trim() ?? '')
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined
}
/** Seconds as HH:MM:SS. */
export function durationText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`
}
/** A duration in words for "usual 18 min": seconds under a minute, minutes under an hour, else hours and minutes. */
export function durationWords(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${whole} s`
  const minutes = Math.round(whole / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** A run as the History list shows it, from the runs table's cells. */
export interface JobHistoryRun {
  readonly key: HistoryRunKey
  readonly started: string
  readonly outcome: string
  readonly seconds?: number
  readonly duration: string
  readonly message: string
  readonly tone: string
}
/** The selected run's rows, from the steps table's cells (the job outcome row is step 0). */
export interface JobHistoryStep {
  readonly instance: number
  readonly stepId: number
  readonly name: string
  readonly outcome: string
  readonly started: string
  readonly seconds?: number
  readonly duration: string
  readonly retries: number
  readonly message: string
  readonly tone: string
}
/** The job's usual durations by step id (0: the job), from the fourth table. */
export interface JobUsual { readonly bySteps: Readonly<Record<number, number>>; readonly job?: number; readonly runs: number }

export const inProgressTone = 'running'
export const runIsInProgress = (run: JobHistoryRun): boolean => run.tone === inProgressTone
export const sameRun = (a: HistoryRunKey | undefined, b: HistoryRunKey | undefined): boolean => !!a && !!b && historyRunKeyText(a) === historyRunKeyText(b)

/** One step of the sparkline's time axis: runs are drawn evenly spaced, oldest first, since they are runs and not samples over time. */
export const sparkStepMs = 1000
/**
 * The sparkline's samples for ChartView (AG-10): the newest finished runs with a duration, oldest first, each at `index × sparkStepMs`
 * with [its seconds, the usual time] (the usual time a line where known); the scale's top (the longest run or the usual time, at least 1 s);
 * and its accessible name, which says how many failed (status colours are never a series).
 */
export function sparkSamples(runs: readonly JobHistoryRun[], usual?: number): {
  readonly samples: readonly { readonly time: number; readonly values: readonly (number | null)[] }[]; readonly top: number; readonly label: string
} {
  const finished = runs.filter(run => run.seconds !== undefined && !runIsInProgress(run)).slice(0, jobHistoryLimits.sparkRuns).reverse()
  const failed = finished.filter(run => run.tone === 'error').length
  const label = finished.length ? `Durations of the last ${finished.length} ${finished.length === 1 ? 'run' : 'runs'}${failed ? `, ${failed} failed` : ''}${usual !== undefined ? `; usual ${durationWords(usual)}` : ''}` : ''
  return {
    samples: finished.map((run, at) => ({ time: at * sparkStepMs, values: [run.seconds!, usual ?? null] })),
    top: Math.max(1, usual ?? 0, ...finished.map(run => run.seconds!)),
    label
  }
}

/** Who started a run, from its job outcome message ("The Job was invoked by Schedule 4 (Nightly 02:30).  The last step to run was …"). */
export function invokedBy(message: string): string | undefined {
  const match = /invoked by (.+?)\.\s+The last step/i.exec(message) ?? /invoked by (.+?)\.(?:\s|$)/i.exec(message)
  return match?.[1].trim() || undefined
}
/** The last step a run ran, from its job outcome message ("The last step to run was step 3 (Merge facts)."). */
export function lastStepOf(message: string): { readonly id: number; readonly name: string } | undefined {
  const match = /last step to run was step (\d+) \((.*)\)\.?/i.exec(message)
  return match ? { id: Number(match[1]), name: match[2] } : undefined
}
/** The list's words for a run: "Failed at step 3", or the outcome as msdb names it. */
export function runSummary(run: JobHistoryRun): string {
  const last = run.tone === 'error' ? lastStepOf(run.message) : undefined
  return last ? `${run.outcome} at step ${last.id}` : run.outcome
}

/** The SSIS Catalog execution an SSIS step's message names ("Execution ID: 48213"); a failed catalog step names it, a successful one may not. */
export function ssisExecutionId(message: string): number | undefined {
  const match = /Execution ID:\s*(\d{1,19})\b/i.exec(message)
  const id = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}
/** The step a run's detail opens with its message: the last step that failed, else none. */
export function failedStep(steps: readonly JobHistoryStep[]): JobHistoryStep | undefined {
  return [...steps].reverse().find(step => step.stepId > 0 && step.tone === 'error')
}

/** A step of the job as the running view lists it: its state in this run, this run's time and its usual time. */
export interface RunningStep {
  readonly id: number
  readonly name: string
  readonly state: 'succeeded' | 'failed' | 'retry' | 'canceled' | 'executing' | 'retrying' | 'waiting' | 'unknown'
  readonly label: string
  readonly seconds?: number
  readonly usual?: number
}
const finishedState = (step: JobHistoryStep): RunningStep['state'] =>
  step.tone === 'error' ? 'failed' : step.outcome === 'Retry' ? 'retry' : step.outcome === 'Canceled' ? 'canceled' : 'succeeded'
/**
 * Each step of the job while it runs: the step Agent reports as current is Executing (Between retries while retrying), a step with rows in this
 * run has finished as its last row says, and the rest are Waiting. This run's time adds a step's rows up (its retries); the current step has
 * none yet, since msdb writes a step's row only when it ends. Without this run's rows (`known` false: another run is selected or filtered in)
 * only the current step is known; the rest are Unknown, never Waiting.
 */
export function runningSteps(steps: readonly { readonly id: number; readonly name: string }[], rows: readonly JobHistoryStep[], current: number | undefined, retrying: boolean, usual?: JobUsual, known = true): RunningStep[] {
  return steps.map(step => {
    const own = rows.filter(row => row.stepId === step.id)
    const seconds = own.length && own.every(row => row.seconds !== undefined) ? own.reduce((sum, row) => sum + row.seconds!, 0) : undefined
    const usualSeconds = usual?.bySteps[step.id]
    const base = { id: step.id, name: step.name, ...usualSeconds !== undefined ? { usual: usualSeconds } : {} }
    if (step.id === current) return { ...base, state: retrying ? 'retrying' : 'executing', label: retrying ? 'Between retries' : 'Executing' }
    if (own.length) { const last = own[own.length - 1]; return { ...base, state: finishedState(last), label: last.outcome, ...seconds !== undefined ? { seconds } : {} } }
    return known ? { ...base, state: 'waiting', label: 'Waiting' } : { ...base, state: 'unknown', label: '—' }
  })
}

/** yyyymmddhhmmss (server local time) to seconds since an epoch, for elapsed times between two server stamps. */
export function stampSeconds(stamp: number): number | undefined {
  const text = String(Math.trunc(stamp)).padStart(14, '0')
  const time = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)), Number(text.slice(8, 10)), Number(text.slice(10, 12)), Number(text.slice(12, 14)))
  return Number.isFinite(time) ? time / 1000 : undefined
}
/** How long a run has run: the server's clock less its start, both server stamps; undefined where either is unknown or the clock is behind. */
export function elapsedSeconds(started: number | undefined, now: number | undefined): number | undefined {
  if (!started || !now) return undefined
  const from = stampSeconds(started), to = stampSeconds(now)
  return from === undefined || to === undefined || to < from ? undefined : to - from
}
/** This run against the usual time: the progress bar's share (capped at 1) and the words beside it. */
export function runProgress(elapsed: number | undefined, usual: number | undefined): { readonly share?: number; readonly text: string } {
  if (elapsed === undefined) return { text: usual !== undefined ? `usual ${durationWords(usual)}` : 'No elapsed time: the start is not readable.' }
  const head = `${durationText(elapsed)} elapsed`
  if (usual === undefined || usual <= 0) return { text: `${head} · no usual time yet` }
  return { share: Math.min(1, elapsed / usual), text: `${head} · usual ${durationWords(usual)}${elapsed > usual ? ' · longer than usual' : ''}` }
}
