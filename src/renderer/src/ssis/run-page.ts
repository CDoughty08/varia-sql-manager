// What the Integration Services document's package and run pages draw, as pure data its view and tests share: the core grids'
// tables (messages, runs, parameters), the run's details, the run strip's bars and the task timeline's rows. Display text only;
// Copy and Save write the tables as shown.
import { displayText } from '../../../shared/explorer/refs.ts'
import type { LocalTableData } from '../../../shared/results/local-table.ts'
import { parameterObjectTypes } from '../../../shared/ssis/catalog.ts'
import { durationText, executionRunning, executionSeconds, messageColumns, secondsBetween, statusLabel, usualSeconds } from '../../../shared/ssis/execution.ts'
import type { SsisExecutionMessage, SsisExecutionModel, SsisExecutionOverview, SsisExecutionParameter, SsisExecutionTask, SsisPackageRun } from '../../../shared/ssis/schema.ts'
import { ssisTime } from './properties-view'

/** A message's text as a cell shows and copies it: line breaks and tabs kept (a package's error spans lines), other control
 *  characters named, as every local table names them. */
export const messageCell = (text: string): string => text.split(/(\r\n|\r|\n|\t)/).map((part, index) => index % 2 ? part : displayText(part)).join('')

/** The messages as the grid shows them, newest first (the read's order). */
export function messagesTable(messages: readonly SsisExecutionMessage[]): LocalTableData {
  return { columns: messageColumns.map(column => ({ name: column.title })), rows: messages.map(message => messageColumns.map(column => messageCell(column.value(message)))) }
}

const count = (value: number | undefined) => value === undefined ? null : String(value)
/** A package's runs as the package page's grid shows them, newest first. */
export function runsTable(runs: readonly SsisPackageRun[]): LocalTableData {
  return {
    columns: [{ name: 'ID', kind: 'number' }, { name: 'Status' }, { name: 'Started' }, { name: 'Duration' }, { name: 'Errors', kind: 'number' }, { name: 'Warnings', kind: 'number' }, { name: 'Caller' }],
    rows: runs.map(run => [String(run.id), statusLabel(run.status), ssisTime(run.started ?? run.created), durationText(secondsBetween(run.started, run.ended)), count(run.errors), count(run.warnings), run.caller === undefined ? null : displayText(run.caller)])
  }
}

/** Task rows the run page's timeline shows before Show all (failed tasks and the chosen one always show). */
export const timelineRows = 8

/** Where a parameter's value came from, in SSMS's words. */
export const parameterSource = (parameter: SsisExecutionParameter): string =>
  parameter.runtimeOverride ? 'Set for this run' : parameter.valueSet ? 'Configured' : 'Default'
/** The value a parameter shows: a sensitive one's is never read, so it says so. */
export const parameterValue = (parameter: SsisExecutionParameter): string | null =>
  parameter.sensitive ? 'Sensitive (not shown)' : parameter.value === undefined ? null : displayText(parameter.value)
/** The parameters the run used, as the details' grid shows them. */
export function parametersTable(parameters: readonly SsisExecutionParameter[]): LocalTableData {
  return {
    columns: [{ name: 'Parameter' }, { name: 'Value' }, { name: 'Type' }, { name: 'Scope' }, { name: 'From' }, { name: 'Required' }],
    rows: parameters.map(parameter => [displayText(parameter.name), parameterValue(parameter), parameter.dataType, parameterObjectTypes.find(type => type.code === parameter.objectType)?.label ?? `Type ${parameter.objectType}`,
      parameterSource(parameter), parameter.required ? 'Yes' : 'No'])
  }
}

/** The run's details: what SSMS's Overview report lists about it, beyond the facts in the header. */
export function overviewRows(overview: SsisExecutionOverview, usual?: number): readonly (readonly [string, string])[] {
  const environment = overview.environment ? `${overview.environmentFolder ? `${overview.environmentFolder}\\` : '.\\'}${overview.environment}` : ''
  const duration = durationText(executionSeconds(overview))
  return [
    ['Execution', String(overview.id)], ['Status', statusLabel(overview.status)], ['Folder', overview.folder], ['Project', overview.project], ['Package', overview.package],
    ['Environment', environment], ['Created', ssisTime(overview.created)], ['Started', ssisTime(overview.started)], ['Ended', ssisTime(overview.ended)],
    ['Duration', duration && usual !== undefined ? `${duration} (usual ${durationText(usual)})` : duration], ['Executed as', overview.executedAs], ['Caller', overview.caller],
    ['Stopped by', overview.stoppedBy ?? ''], ['32-bit runtime', overview.use32bit ? 'Yes' : 'No'], ['Server', overview.server ?? ''], ['Machine', overview.machine ?? '']
  ]
}

/** One bar of the run strip, oldest first: its height against the longest run, and whether it is this run. */
export interface RunBar { readonly id: number; readonly height: number; readonly failed: boolean; readonly running: boolean; readonly current: boolean; readonly label: string }
/** The run strip: the package's recent runs (this one and those before it), oldest first, and the usual duration's line. */
export function runStrip(runs: readonly SsisPackageRun[], current: number, now?: string): { readonly bars: readonly RunBar[]; readonly usual?: number; readonly usualAt?: number } {
  const seconds = (run: SsisPackageRun) => secondsBetween(run.started, run.ended ?? (executionRunning(run.status) ? now : undefined))
  const usual = usualSeconds(runs, current)
  const top = Math.max(1, usual ?? 0, ...runs.map(run => seconds(run) ?? 0))
  const bars = runs.slice().reverse().map(run => {
    const length = seconds(run)
    return {
      id: run.id, height: (length ?? 0) / top, failed: run.status === 4 || run.status === 6, running: executionRunning(run.status), current: run.id === current,
      label: `Execution ${run.id}: ${statusLabel(run.status)}${length === undefined ? '' : `, ${durationText(length)}`}${run.started ? `, started ${ssisTime(run.started)}` : ''}`
    }
  })
  return { bars, ...usual !== undefined ? { usual, usualAt: usual / top } : {} }
}

/** One row of the task timeline: where its bar starts and how wide it is (fractions of the run), where the usual end falls,
 *  and its duration against its usual one. A task the run never reached has no bar. */
export interface TimelineRow {
  readonly path: string
  readonly name: string
  /** Containers' depth under the package (the package itself is 0). */
  readonly depth: number
  readonly left?: number
  readonly width?: number
  readonly usualEnd?: number
  readonly duration: string
  /** "+40 s", "−12 s", "failed", or nothing. */
  readonly delta: string
  readonly slower: boolean
  readonly failed: boolean
  readonly runs: number
}
const instant = (iso?: string) => { const ms = iso ? Date.parse(iso) : NaN; return Number.isFinite(ms) ? ms : undefined }
/** The task timeline over the run: from its start to the last end among its tasks, its own end and the usual ends. */
export function timeline(model: Pick<SsisExecutionModel, 'overview' | 'tasks'>): readonly TimelineRow[] {
  const starts = model.tasks.map(task => instant(task.started)).filter((value): value is number => value !== undefined)
  const origin = instant(model.overview.started) ?? (starts.length ? Math.min(...starts) : undefined)
  const ends = model.tasks.flatMap(task => {
    const start = instant(task.started)
    return [instant(task.ended), start !== undefined && task.usualMs !== undefined ? start + task.usualMs : undefined]
  }).filter((value): value is number => value !== undefined)
  const finish = Math.max(origin ?? 0, instant(model.overview.ended) ?? 0, ...ends)
  const span = origin === undefined ? 0 : Math.max(1, finish - origin)
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - origin!) / span))
  return model.tasks.map((task: SsisExecutionTask) => {
    const start = instant(task.started), end = instant(task.ended)
    const depth = Math.max(0, task.path.split('\\').filter(Boolean).length - 1)
    const placed = origin !== undefined && start !== undefined
    const delta = task.durationMs !== undefined && task.usualMs !== undefined ? Math.round((task.durationMs - task.usualMs) / 1000) : undefined
    return {
      path: task.path, name: task.name, depth, runs: task.runs, failed: task.failed,
      ...placed ? { left: at(start), width: Math.max(0, at(end ?? start + (task.durationMs ?? 0)) - at(start)) } : {},
      ...placed && task.usualMs !== undefined ? { usualEnd: at(start + task.usualMs) } : {},
      duration: task.durationMs === undefined ? '' : durationText(Math.round(task.durationMs / 1000)),
      delta: task.failed ? 'failed' : delta === undefined || delta === 0 ? '' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} s`,
      slower: delta !== undefined && delta > 0
    }
  })
}
