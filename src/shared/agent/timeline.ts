// The Schedules Timeline (AG-14, docs/agent-ui-rethink.md › rx-timeline): when jobs run over the next 24 hours or 7 days, each run drawn
// for the job's usual duration (the median of its last successful runs, AG-6c/AG-6d), with overlaps between jobs flagged and explained, and
// a job whose usual run outlasts the gap to its next start called out (Agent skips a start while the job still runs). Rows are jobs when
// the login may read which job uses which schedule (sysadmin); below that, rows are the schedules themselves, each run lasting a minute.
// Bounded: at most `timelineLimits.rows` rows, `runsPerRow` runs a row and `runs` in all, each cut said in words. Pure and erasable
// TypeScript: no React, no I/O; times are the server's wall clock as seconds (schedule.ts momentSeconds).
import type { AgentSchedulesModel } from '../actions/agent-schedule.ts'
import type { AgentScheduleTiming, AgentMoment } from './schedule.ts'
import { formatTime, freq, linkAnchor, momentOfSeconds, momentSeconds, scheduleRuns, scheduleWhen, unmeasuredSeconds } from './schedule.ts'

export const timelineSpans = [
  { id: 'day', label: 'Next 24 hours', seconds: 86_400 },
  { id: 'week', label: 'Next 7 days', seconds: 7 * 86_400 }
] as const
export type TimelineSpan = typeof timelineSpans[number]['id']
export const timelineLimits = {
  /** Rows drawn; more are left out, and said. */
  rows: 200,
  /** Runs a row draws (an every-10-seconds schedule makes 60,480 in a week); the rest are left out, and said. */
  runsPerRow: 2_000,
  /** Runs the whole Timeline draws. */
  runs: 40_000,
  /** Overlap notes listed under the Timeline; the rest are counted. */
  notes: 20,
  /** Row checks the overlap sweep makes (about runs × rows still running); past it the sweep stops, and says so. */
  overlapChecks: 2_000_000
} as const

export interface TimelineScheduleInput {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  readonly timing: AgentScheduleTiming
  /** The next run Agent last wrote for this job and schedule (sysjobschedules): an every-n cycle counts from it. */
  readonly nextRun?: AgentMoment
}
export interface TimelineJobInput {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** Seconds; undefined when the job has no successful run to measure. */
  readonly usualSeconds?: number
  readonly schedules: readonly TimelineScheduleInput[]
}
export interface TimelineRun {
  /** Seconds from the window's start. */
  readonly start: number
  /** How long it is drawn: the usual duration, or a minute when unmeasured; at least a second. */
  readonly seconds: number
  readonly scheduleId: number
  /** The job or the schedule is disabled: drawn dashed, never part of an overlap. */
  readonly off: boolean
  /** It overlaps another row's run. */
  readonly overlap: boolean
}
export interface TimelineRow {
  /** `j:<job id>` or `s:<schedule id>`. */
  readonly key: string
  readonly kind: 'job' | 'schedule'
  readonly jobId?: string
  readonly name: string
  readonly enabled: boolean
  readonly usualSeconds?: number
  /** Its schedules, in order (one for a schedule row). */
  readonly schedules: readonly { readonly id: number; readonly name: string; readonly enabled: boolean }[]
  /** "Every day at 02:30 · ~18 min", as the row's name column shows it. */
  readonly label: string
  readonly runs: readonly TimelineRun[]
  /** More runs fell in the window than the row draws. */
  readonly truncated: boolean
}
export interface TimelineOverlap {
  /** Seconds from the window's start. */
  readonly start: number
  readonly end: number
  /** The run the others start during, and its row. */
  readonly row: string
  readonly name: string
  readonly scheduleId: number
  /** The other rows that start during it, with how many times. */
  readonly others: readonly { readonly row: string; readonly name: string; readonly count: number }[]
}
/** A job whose usual run is longer than the gap to its next start. */
export interface TimelineSelfOverlap { readonly row: string; readonly name: string; readonly usualSeconds: number; readonly gapSeconds: number }
export interface TimelineModel {
  /** The window: from the server's now, for `seconds`. */
  readonly start: AgentMoment
  readonly seconds: number
  readonly rows: readonly TimelineRow[]
  readonly overlaps: readonly TimelineOverlap[]
  /** Overlaps beyond timelineLimits.notes. */
  readonly moreOverlaps: number
  /** The overlap sweep stopped at timelineLimits.overlapChecks: later runs were not checked. */
  readonly overlapsCut: boolean
  readonly selfOverlaps: readonly TimelineSelfOverlap[]
  /** Rows left out past timelineLimits.rows. */
  readonly rowsLeftOut: number
  /** Whether any row's runs were cut, or the total ran out. */
  readonly runsCut: boolean
  /** Whether rows are jobs or schedules. */
  readonly kind: 'job' | 'schedule'
}

/** "~18 min", "~2 s", "~1 h 05 min". */
export function usualText(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3_600) return `~${Math.round(seconds / 60)} min`
  const minutes = Math.round(seconds / 60)
  return `~${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const times = (count: number) => count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`

/** Seconds from the window's start as the axis and notes read them: "01:00", or "Tue 01:00" when the window spans days. */
export function timelineClock(model: Pick<TimelineModel, 'start' | 'seconds'>, offset: number): string {
  const at = momentOfSeconds(momentSeconds(model.start) + offset)
  const time = formatTime(at.time - at.time % 100)
  if (model.seconds <= 86_400) return time
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Math.floor((momentSeconds(model.start) + offset) / 86_400) * 86_400_000).getUTCDay()]
  return `${weekday} ${time}`
}

interface RowInput { readonly key: string; readonly kind: 'job' | 'schedule'; readonly jobId?: string; readonly name: string; readonly enabled: boolean; readonly usualSeconds?: number; readonly schedules: readonly TimelineScheduleInput[] }

/**
 * The Timeline over `seconds` from `now`. `jobs` (sysadmin's links resolved) makes job rows; without it, `schedules` make one row each.
 * Runs come from schedule.ts scheduleRuns from the server's now, each every-n cycle counted from Agent's own next run when known.
 */
export function timelineModel(input: { readonly now: AgentMoment; readonly seconds: number; readonly jobs?: readonly TimelineJobInput[]; readonly schedules?: readonly TimelineScheduleInput[] }): TimelineModel {
  const { now, seconds } = input
  const kind = input.jobs ? 'job' : 'schedule'
  const inputs: RowInput[] = input.jobs
    ? input.jobs.filter(job => job.schedules.length).map(job => ({ key: `j:${job.id.toLowerCase()}`, kind: 'job', jobId: job.id, name: job.name, enabled: job.enabled, ...job.usualSeconds !== undefined ? { usualSeconds: job.usualSeconds } : {}, schedules: job.schedules }))
    : (input.schedules ?? []).map(schedule => ({ key: `s:${schedule.id}`, kind: 'schedule', name: schedule.name, enabled: schedule.enabled, schedules: [schedule] }))
  const from = momentSeconds(now), until = from + seconds
  const runsOf = (row: RowInput, count: number) => row.schedules.flatMap(schedule =>
    // Disabled jobs and schedules are drawn too, dashed: where they would run if enabled.
    scheduleRuns({ ...schedule.timing, enabled: true }, now, count, until - 1, schedule.nextRun ?? now).map(run => ({ schedule, start: momentSeconds(run) - from })))
  // Rows in the order they next run (rows without a run in the window last, by name), cut to the row limit before any run is collected,
  // so the run budget goes only to rows drawn, shared out so that no row is left looking as if it never runs: rows needing less than an
  // even share get what they need, and the rest is split among the busier ones (at most runsPerRow each).
  const ordered = inputs.map(row => ({ row, first: Math.min(Infinity, ...runsOf(row, 1).map(run => run.start)) }))
    .sort((a, b) => a.first - b.first || a.row.name.localeCompare(b.row.name))
  const rowsLeftOut = Math.max(0, ordered.length - timelineLimits.rows)
  const found = ordered.slice(0, timelineLimits.rows).map(({ row }) => ({ row, runs: runsOf(row, timelineLimits.runsPerRow + 1).sort((a, b) => a.start - b.start || a.schedule.id - b.schedule.id) }))
  const shares = new Array<number>(found.length)
  let left: number = timelineLimits.runs
  found.map((entry, index) => ({ index, need: Math.min(timelineLimits.runsPerRow, entry.runs.length) })).sort((a, b) => a.need - b.need)
    .forEach(({ index, need }, rank) => { shares[index] = Math.min(need, Math.floor(left / (found.length - rank))); left -= shares[index] })
  let runsCut = false
  const shown = found.map(({ row, runs: all }, index) => {
    const drawn = Math.max(1, row.usualSeconds ?? unmeasuredSeconds)
    const truncated = all.length > shares[index]
    if (truncated) runsCut = true
    const runs = all.slice(0, shares[index]).map(run => ({ start: run.start, seconds: drawn, scheduleId: run.schedule.id, off: !row.enabled || !run.schedule.enabled }))
    return { row, runs, truncated, drawn }
  })

  // Overlaps between rows: a sweep over every run that is on, in start order. A row's runs all last the same, so the ones still going
  // when a run starts are a contiguous stretch of that row's runs (a queue, head to tail); each run is flagged once, and each start is
  // counted against the earliest run still going in each other row, so the work stays near runs × rows drawn, and is capped besides.
  const on = shown.map(entry => entry.runs.flatMap((run, index) => run.off ? [] : [index]))
  const flat: { readonly row: number; readonly start: number; readonly end: number }[] = []
  shown.forEach((entry, row) => on[row].forEach(index => flat.push({ row, start: entry.runs[index].start, end: entry.runs[index].start + entry.runs[index].seconds })))
  // Longer runs first at the same start, so a short run starting with a long one is counted as starting during it.
  flat.sort((a, b) => a.start - b.start || b.end - a.end || a.row - b.row)
  const head = on.map(() => 0), tail = on.map(() => 0), flaggedTo = on.map(() => 0)
  const flagged = shown.map(entry => new Uint8Array(entry.runs.length))
  const hosts = new Map<number, { readonly row: number; readonly run: number; readonly others: Map<number, number> }>()
  const going = new Set<number>()
  let checks = 0, overlapsCut = false
  const endOf = (row: number, at: number) => { const run = shown[row].runs[on[row][at]]; return run.start + run.seconds }
  for (const item of flat) {
    if (checks > timelineLimits.overlapChecks) { overlapsCut = true; break }
    // Two schedules starting a job at the same moment are one start to Agent: flagged like the first, counted once.
    const twin = tail[item.row] > 0 && shown[item.row].runs[on[item.row][tail[item.row] - 1]].start === item.start
    let met = false
    for (const row of going) {
      checks++
      while (head[row] < tail[row] && endOf(row, head[row]) <= item.start) head[row]++
      if (head[row] === tail[row]) { going.delete(row); continue }
      if (row === item.row) continue
      met = true
      for (let at = Math.max(head[row], flaggedTo[row]); at < tail[row]; at++) flagged[row][on[row][at]] = 1
      flaggedTo[row] = tail[row]
      if (twin) continue
      const run = on[row][head[row]], key = row * timelineLimits.runsPerRow + run
      const note = hosts.get(key) ?? { row, run, others: new Map<number, number>() }
      note.others.set(item.row, (note.others.get(item.row) ?? 0) + 1)
      hosts.set(key, note)
    }
    if (met) flagged[item.row][on[item.row][tail[item.row]]] = 1
    tail[item.row]++
    going.add(item.row)
  }
  const notes = [...hosts.values()].sort((a, b) => shown[a.row].runs[a.run].start - shown[b.row].runs[b.run].start || a.row - b.row)
  const overlaps: TimelineOverlap[] = notes.slice(0, timelineLimits.notes).map(({ row, run, others }) => {
    const entry = shown[row], host = entry.runs[run]
    return {
      start: host.start, end: host.start + host.seconds, row: entry.row.key, name: entry.row.name, scheduleId: host.scheduleId,
      others: [...others].map(([other, count]) => ({ row: shown[other].row.key, name: shown[other].row.name, count }))
    }
  })
  // A row whose usual run is longer than a gap between two of its starts (measured only: an unmeasured minute says nothing).
  const selfOverlaps: TimelineSelfOverlap[] = []
  for (const entry of shown) {
    if (entry.row.usualSeconds === undefined || !entry.row.enabled) continue
    const live = entry.runs.filter(run => !run.off)
    let gap = Infinity
    // Two schedules starting the job at the same moment are one run to Agent, not a gap of nothing.
    for (let index = 1; index < live.length; index++) { const step = live[index].start - live[index - 1].start; if (step > 0) gap = Math.min(gap, step) }
    if (gap < entry.drawn) selfOverlaps.push({ row: entry.row.key, name: entry.row.name, usualSeconds: entry.drawn, gapSeconds: gap })
  }
  const rows: TimelineRow[] = shown.map((entry, row) => ({
    key: entry.row.key, kind: entry.row.kind, ...entry.row.jobId ? { jobId: entry.row.jobId } : {}, name: entry.row.name, enabled: entry.row.enabled,
    ...entry.row.usualSeconds !== undefined ? { usualSeconds: entry.row.usualSeconds } : {},
    schedules: entry.row.schedules.map(schedule => ({ id: schedule.id, name: schedule.name, enabled: schedule.enabled })),
    label: rowLabel(entry.row), runs: entry.runs.map((run, index) => ({ ...run, overlap: flagged[row][index] === 1 })), truncated: entry.truncated
  }))
  return { start: now, seconds, rows, overlaps, moreOverlaps: Math.max(0, notes.length - timelineLimits.notes), overlapsCut, selfOverlaps, rowsLeftOut, runsCut, kind }
}

/** The row's words beside its name: its first schedule's when (and how many more), its usual duration, and whether it is disabled. */
function rowLabel(row: RowInput): string {
  const first = row.schedules[0]
  const when = first ? scheduleWhen(first.timing) : ''
  const parts = [row.schedules.length > 1 ? `${when} +${row.schedules.length - 1} more` : when]
  if (row.usualSeconds !== undefined) parts.push(usualText(row.usualSeconds))
  if (!row.enabled) parts.push(row.kind === 'job' ? 'job disabled' : 'disabled')
  else if (row.schedules.length && row.schedules.every(schedule => !schedule.enabled)) parts.push('schedule disabled')
  return parts.filter(Boolean).join(' · ')
}

export const timelineText = {
  bars: (kind: 'job' | 'schedule') => kind === 'job'
    ? "Bars are each job's usual duration (the median of its last successful runs) at its scheduled starts; a job without one is drawn for a minute."
    : 'Which job uses which schedule needs sysadmin, so rows are schedules, each run drawn for a minute; schedules no job uses are left out.',
  overlap: (model: Pick<TimelineModel, 'start' | 'seconds'>, overlap: TimelineOverlap) => {
    const others = overlap.others.map(other => `${other.name} ${overlap.others.length === 1 && other.count > 1 ? `runs ${times(other.count)}` : `starts ${times(other.count)}`}`)
    return `Overlap ${timelineClock(model, overlap.start)}–${timelineClock(model, overlap.end)}: ${others.join(', ')} during ${overlap.name}.`
  },
  moreOverlaps: (count: number) => `${plural(count, 'more overlap')} not listed.`,
  overlapsCut: 'Too many runs overlap to check them all: later overlaps are not flagged.',
  self: (self: TimelineSelfOverlap) => `${self.name} usually runs ${usualText(self.usualSeconds).slice(1)}, longer than the ${usualText(self.gapSeconds).slice(1)} between two of its starts; SQL Server Agent skips a start while the job is still running.`,
  rowsLeftOut: (count: number) => `${plural(count, 'more row')} not drawn (the Timeline draws at most ${timelineLimits.rows}).`,
  runsCut: `Some rows have more runs in this window than the Timeline draws (at most ${timelineLimits.runsPerRow.toLocaleString('en-US')} a row, ${timelineLimits.runs.toLocaleString('en-US')} in all); their later runs are left out.`,
  none: 'No job runs on a schedule in this window.',
  /** A run as hover and the keyboard announce it. */
  run: (model: Pick<TimelineModel, 'start' | 'seconds'>, row: TimelineRow, run: TimelineRun) => {
    const schedule = row.schedules.find(item => item.id === run.scheduleId)
    const parts = [`${row.name}: ${timelineClock(model, run.start)} to ${timelineClock(model, run.start + run.seconds)}`]
    if (row.kind === 'job' && schedule) parts.push(`schedule ${schedule.name}`)
    parts.push(row.usualSeconds !== undefined ? `usual run ${usualText(row.usualSeconds).slice(1)}` : 'no measured run')
    if (run.off) parts.push(!row.enabled ? 'job disabled' : 'schedule disabled')
    if (run.overlap) parts.push(row.kind === 'job' ? 'overlaps another job' : 'overlaps another schedule')
    return parts.join(', ')
  }
} as const

/** Whether a schedule type ever has a run on the Timeline (Agent-start and CPU-idle schedules never do). */
export const drawsRuns = (timing: Pick<AgentScheduleTiming, 'freqType'>) => timing.freqType !== freq.agentStart && timing.freqType !== freq.idle

/** The Schedules describe as the Timeline's input: job rows from sysadmin's links (with each job's usual duration and each link's next run
 *  as Agent wrote it), else one row per schedule. */
export function timelineInputs(model: AgentSchedulesModel): { readonly jobs?: TimelineJobInput[]; readonly schedules?: TimelineScheduleInput[] } {
  const timingOf = (record: AgentSchedulesModel['schedules'][number]): AgentScheduleTiming => ({
    freqType: record.freqType, freqInterval: record.freqInterval, freqSubdayType: record.freqSubdayType, freqSubdayInterval: record.freqSubdayInterval,
    freqRelativeInterval: record.freqRelativeInterval, freqRecurrenceFactor: record.freqRecurrenceFactor, activeStartDate: record.activeStartDate,
    activeEndDate: record.activeEndDate, activeStartTime: record.activeStartTime, activeEndTime: record.activeEndTime
  })
  const schedule = (record: AgentSchedulesModel['schedules'][number], nextRun?: AgentMoment): TimelineScheduleInput =>
    ({ id: record.id, name: record.name, enabled: record.enabled, timing: timingOf(record), ...nextRun ? { nextRun } : {} })
  if (!model.links || !model.jobs) return { schedules: model.schedules.filter(record => record.jobCount > 0).map(record => schedule(record)) }
  const records = new Map(model.schedules.map(record => [record.id, record]))
  const usual = new Map((model.durations ?? []).map(duration => [duration.jobId.toLowerCase(), duration.seconds]))
  const byJob = new Map<string, TimelineScheduleInput[]>()
  for (const link of model.links) {
    const record = records.get(link.scheduleId)
    if (!record) continue
    const next = linkAnchor(model.links, link, timingOf(record))
    const key = link.jobId.toLowerCase()
    byJob.set(key, [...byJob.get(key) ?? [], schedule(record, next)])
  }
  return {
    jobs: model.jobs.map(job => {
      const seconds = usual.get(job.id.toLowerCase())
      return { id: job.id, name: job.name, enabled: job.enabled, ...seconds !== undefined ? { usualSeconds: seconds } : {}, schedules: (byJob.get(job.id.toLowerCase()) ?? []).sort((a, b) => a.id - b.id) }
    })
  }
}
