// Create Job Like This (AG-6e, docs/agent-plan.md › Lanes, docs/agent-ui-rethink.md › Create from…, mock rx-create-from): a New Job
// filled from another job's describe, with a Changes from source section first. This holds the parts that are not React: each source
// schedule's Share, Copy or Leave out; Replace across the copy (one find and replace over names, step commands, which hold SSIS package
// paths, and output file paths, previewed match by match); each step's key fields and whether they differ from the source; and Compare
// with source, every difference as a row. The copy saves through New Job's own save (agentJobSave, one transaction, no new backend write).
// Create several (AG-6f) builds its rows on these functions, so none of them knows about a document.
import { agentJobFieldLabels, agentJobFieldText, initialAgentJobDraft, type AgentJobDocumentModel, type AgentJobDraft, type AgentJobField } from '../actions/agent-job.ts'
import { jobScheduleText, scheduleFieldsOf, scheduleKey, type AgentScheduleRecord, type JobScheduleEntry } from '../actions/agent-schedule.ts'
import { agentLimits } from './catalog.ts'
import { scheduleWhen } from './schedule.ts'
import { parseSsisCommand, ssisPackagePath } from './ssis-step.ts'
import { stepActionLabel, stepTypeShort, type AgentStepDraft } from './steps.ts'

export const createFromLimits = {
  /** Replace across the copy lists and applies at most this many matches at once; the preview says when there are more. */
  replaceMatches: 500,
  /** The find and replacement texts' length (a job or step name is at most 128; a path or command fragment may be longer). */
  replaceChars: 4_000,
  /** Characters of context the preview shows on each side of a match. */
  contextChars: 40
} as const

/** A copied job's origin: the source's describe and the source as a draft, which the changed marks and Compare with source measure from. */
export interface JobCopySource {
  readonly model: AgentJobDocumentModel
  readonly base: AgentJobDraft
}
export const jobCopySource = (model: AgentJobDocumentModel): JobCopySource => ({ model, base: initialAgentJobDraft(model) })

export const createFromText = {
  section: 'Changes from source',
  banner: (name: string) => `Copy of ${name}. Steps, flow, notifications and step settings are copied; history is not. Not saved yet.`,
  compare: 'Compare with source',
  compareHide: 'Hide the comparison',
  compareNone: 'Nothing differs from the source yet.',
  replaceTitle: 'Replace across the copy',
  replaceScope: 'names, commands, file paths and package paths',
  replaceFind: 'Find',
  replaceWith: 'Replace with',
  matchCase: 'Match case',
  preview: (count: number, more: boolean) => count === 0 ? 'No match' : `Preview ${more ? 'the first ' : ''}${count} ${count === 1 ? 'match' : 'matches'}`,
  previewHint: 'Each match is shown before it is applied, and stays editable afterwards.',
  apply: (count: number) => `Replace ${count} ${count === 1 ? 'match' : 'matches'}`,
  applied: (count: number) => `Replaced ${count} ${count === 1 ? 'match' : 'matches'}.`,
  replaceTooMany: `Only the first ${createFromLimits.replaceMatches} matches are listed; apply them, then preview again for the rest.`,
  replaceStale: 'The copy changed since the preview: preview again.',
  ownerYou: 'The copy is yours. Only sysadmin can keep the source\'s owner.',
  ownerSource: (owner: string) => `The source's owner is ${owner}.`,
  enableWhenSaved: 'Enable when saved',
  enableHint: 'Off by default, so the copy cannot run alongside the source by accident.',
  editCommand: 'Edit command',
  changePackage: 'Change package',
  setItNow: 'Set it now',
  noSteps: 'The source has no steps.',
  schedulesTitle: 'Schedules',
  /** The group's name, apart from the Schedules section's own. */
  schedulesGroup: 'Schedules from source',
  schedulesNone: 'The source has no schedules, so the copy runs only when started.',
  share: 'Share',
  copy: 'Copy',
  leave: 'Leave out',
  scheduleHint: 'Share attaches the same schedule (the copy then runs with the source). Copy makes a new schedule for this job, edited on Schedules. Leave out saves the job without it.',
  shareUnguarded: 'Its version could not be read, so it cannot be shared: copy it instead.',
  editSchedule: 'Edit on Schedules',
  alsoCopied: 'Also copied',
  notCopied: 'Not copied',
  notCopiedText: (alerts: readonly string[]) => alerts.length
    ? `history · ${alerts.length === 1 ? `the alert that runs the source (${alerts[0]})` : `the ${alerts.length} alerts that run the source`}: an alert runs one job, so it stays with the source`
    : 'history',
  stepsTruncated: `The source has more than ${agentLimits.stepsPerJob} steps and Varia read only the first ${agentLimits.stepsPerJob}, so the copy cannot be saved from here. Script Job As › CREATE copies it whole.`,
  changed: 'changed',
  removed: '(removed)',
  added: '(added)',
  none: '(none)'
} as const

// --- Schedules: Share, Copy or Leave out ------------------------------------------------------------------------------------

export type CopyScheduleChoice = 'share' | 'copy' | 'leave'
export const copyScheduleChoices = ['share', 'copy', 'leave'] as const satisfies readonly CopyScheduleChoice[]
/** The key of a source schedule's copy, so its choice reads back from the draft. */
export const copiedScheduleKey = (id: number) => `n:copy:${id}`
/** A schedule can be shared only when its guard was read: attaching it names its version (agent-schedule.ts › jobSchedulesSave). */
export const canShareSchedule = (record: Pick<AgentScheduleRecord, 'version' | 'modified'>) => record.version !== undefined && !!record.modified

/** The entry a choice puts on the copy: the source's schedule attached, a new schedule with its timing, or nothing. */
export function copyScheduleEntry(record: AgentScheduleRecord, choice: CopyScheduleChoice): JobScheduleEntry | undefined {
  if (choice === 'share') return canShareSchedule(record) ? { key: scheduleKey(record.id), id: record.id, attached: true, base: record, fields: scheduleFieldsOf(record) } : undefined
  if (choice === 'copy') return { key: copiedScheduleKey(record.id), fields: { ...scheduleFieldsOf(record), name: jobScheduleText.copyName(record.name) } }
  return undefined
}
/** What the copy does with a source schedule now: read from the draft, so the Schedules section's own edits show here. */
export function copyScheduleChoice(schedules: readonly JobScheduleEntry[], record: Pick<AgentScheduleRecord, 'id'>): CopyScheduleChoice {
  if (schedules.some(entry => entry.id === record.id && entry.attached && !entry.remove)) return 'share'
  if (schedules.some(entry => entry.key === copiedScheduleKey(record.id))) return 'copy'
  return 'leave'
}
/** The copy's schedules with `record` switched to `choice`, in the source's order; schedules the user added stay after them. */
export function withCopyScheduleChoice(schedules: readonly JobScheduleEntry[], records: readonly AgentScheduleRecord[], record: AgentScheduleRecord, choice: CopyScheduleChoice): readonly JobScheduleEntry[] {
  if (copyScheduleChoice(schedules, record) === choice) return schedules
  const own = (entry: JobScheduleEntry, item: AgentScheduleRecord) => (entry.id === item.id && entry.attached) || entry.key === copiedScheduleKey(item.id)
  const next = copyScheduleEntry(record, choice)
  // Copy while a copy is already there (beside a share) keeps that copy and what was typed into it.
  const kept = choice === 'copy' ? schedules.find(entry => entry.key === copiedScheduleKey(record.id)) : undefined
  const sourced = records.flatMap(item => {
    if (item.id === record.id) return next ? [kept ?? next] : []
    return schedules.filter(entry => own(entry, item))
  })
  const rest = schedules.filter(entry => !records.some(item => own(entry, item)))
  return [...sourced, ...rest]
}
/** The copy's first schedules: each shared where the login can attach it (the owner's 2026-11-18 decision: Share is the default), else copied. */
export const initialCopySchedules = (records: readonly AgentScheduleRecord[]): JobScheduleEntry[] =>
  records.map(record => copyScheduleEntry(record, canShareSchedule(record) ? 'share' : 'copy')!)

/**
 * The copy as it opens: the source's General, Notifications and steps (with their flow, retries, output and logging) under the name
 * "Copy of …" (cut to fit), saved disabled unless Enable when saved is ticked, owned by the login unless sysadmin keeps the source's owner,
 * each schedule shared where it can be. Not copied: history and the alerts that run the source (an alert runs one job). Steps keep the
 * source's keys, so the changed marks find their source step, but no `from`: every one is new to msdb (planAgentSteps writes them all).
 */
export function createFromDraft(source: AgentJobDocumentModel, login: string, sysadmin: boolean): AgentJobDraft {
  const from = initialAgentJobDraft(source)
  const steps = from.steps.steps.map(({ from: _from, ...step }) => step)
  return {
    ...from, name: `Copy of ${from.name}`.slice(0, agentLimits.nameChars), owner: sysadmin ? from.owner : login, enabled: false, removeAlerts: [],
    steps: { steps, ...from.steps.startKey ? { startKey: from.steps.startKey } : {} }, schedules: initialCopySchedules(source.schedules ?? [])
  }
}

// --- Replace across the copy ------------------------------------------------------------------------------------------------

/** Where a match is: the job's name, a step's name, command or output file (by step key), or a copied schedule's name (by entry key). */
export type ReplaceField = 'name' | 'stepName' | 'stepCommand' | 'stepOutput' | 'scheduleName'
export interface ReplaceMatch {
  /** Stable for one draft and find text: the field, its key and the match's place among that field's matches. */
  readonly id: string
  readonly field: ReplaceField
  readonly key?: string
  /** Where it is, in words ("Step 2 'Load' · command"). */
  readonly label: string
  readonly start: number
  readonly length: number
  /** The text around the match, as the preview shows it: before, the match, after. */
  readonly before: string
  readonly match: string
  readonly after: string
}
export interface ReplaceOptions { readonly matchCase?: boolean }

interface ReplaceTarget { readonly field: ReplaceField; readonly key?: string; readonly label: string; readonly text: string }
function replaceTargets(draft: AgentJobDraft): ReplaceTarget[] {
  const targets: ReplaceTarget[] = [{ field: 'name', label: 'Job name', text: draft.name }]
  draft.steps.steps.forEach((step, at) => {
    const where = `Step ${at + 1} '${step.name}'`
    targets.push({ field: 'stepName', key: step.key, label: `${where} · name`, text: step.name })
    targets.push({ field: 'stepCommand', key: step.key, label: `${where} · ${step.subsystem === 'SSIS' ? 'package and command' : 'command'}`, text: step.command })
    targets.push({ field: 'stepOutput', key: step.key, label: `${where} · output file`, text: step.outputFileName })
  })
  // Only schedules this job creates: a shared schedule is the source's too, so renaming it would rename the source's schedule.
  for (const entry of draft.schedules) if (entry.id === undefined && !entry.remove) targets.push({ field: 'scheduleName', key: entry.key, label: `Schedule '${entry.fields.name}' · name`, text: entry.fields.name })
  return targets
}
/** Where `find` occurs in `text`, as offsets into `text` itself: a case-insensitive search runs on the original string (a RegExp), since
 *  lower-casing can change a string's length ('İ' becomes two code units) and would shift every later offset. */
function occurrences(text: string, find: string, matchCase: boolean): number[] {
  if (!find) return []
  const found: number[] = []
  if (matchCase) {
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) found.push(at)
    return found
  }
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) found.push(match.index)
  return found
}
/** Every match of `find` across the copy, in the document's order, at most createFromLimits.replaceMatches (`more` says there were others). */
export function replaceMatches(draft: AgentJobDraft, find: string, options: ReplaceOptions = {}): { readonly matches: readonly ReplaceMatch[]; readonly more: boolean } {
  const matches: ReplaceMatch[] = []
  if (!find || find.length > createFromLimits.replaceChars) return { matches, more: false }
  const context = createFromLimits.contextChars
  for (const target of replaceTargets(draft)) {
    for (const [index, start] of occurrences(target.text, find, !!options.matchCase).entries()) {
      if (matches.length === createFromLimits.replaceMatches) return { matches, more: true }
      const end = start + find.length
      matches.push({
        id: `${target.field}:${target.key ?? ''}:${index}`, field: target.field, ...target.key !== undefined ? { key: target.key } : {}, label: target.label, start, length: find.length,
        before: (start > context ? '…' : '') + target.text.slice(Math.max(0, start - context), start), match: target.text.slice(start, end),
        after: target.text.slice(end, end + context) + (end + context < target.text.length ? '…' : '')
      })
    }
  }
  return { matches, more: false }
}
const spliced = (text: string, matches: readonly ReplaceMatch[], replacement: string) =>
  [...matches].sort((a, b) => b.start - a.start).reduce((value, match) => value.slice(0, match.start) + replacement + value.slice(match.start + match.length), text)
/** The copy with the chosen matches (`ids`, from replaceMatches on this same draft) replaced. Names are cut to what msdb keeps. */
export function applyReplace(draft: AgentJobDraft, find: string, replacement: string, ids: ReadonlySet<string>, options: ReplaceOptions = {}): AgentJobDraft {
  const chosen = replaceMatches(draft, find, options).matches.filter(match => ids.has(match.id))
  if (!chosen.length) return draft
  const of = (field: ReplaceField, key?: string) => chosen.filter(match => match.field === field && match.key === key)
  const name = (text: string, field: ReplaceField, key?: string) => { const found = of(field, key); return found.length ? spliced(text, found, replacement).slice(0, agentLimits.nameChars) : text }
  const steps = draft.steps.steps.map(step => {
    const command = of('stepCommand', step.key), output = of('stepOutput', step.key)
    const next = { ...step, name: name(step.name, 'stepName', step.key), ...command.length ? { command: spliced(step.command, command, replacement) } : {}, ...output.length ? { outputFileName: spliced(step.outputFileName, output, replacement) } : {} }
    return JSON.stringify(next) === JSON.stringify(step) ? step : next
  })
  const schedules = draft.schedules.map(entry => {
    const found = entry.id === undefined ? of('scheduleName', entry.key) : []
    return found.length ? { ...entry, fields: { ...entry.fields, name: spliced(entry.fields.name, found, replacement).slice(0, agentLimits.nameChars) } } : entry
  })
  return { ...draft, name: name(draft.name, 'name'), steps: { ...draft.steps, steps }, schedules }
}

// --- Each step's key fields -------------------------------------------------------------------------------------------------

/** What usually differs between a job and one like it: a T-SQL step's database and command, an SSIS step's package and environment, a
 *  CmdExec or PowerShell step's command (and any other type's). */
export type StepKeyField = 'database' | 'command' | 'package' | 'environment'
export function stepKeyFields(step: Pick<AgentStepDraft, 'subsystem' | 'command'>): readonly StepKeyField[] {
  if (step.subsystem === 'TSQL') return ['database', 'command']
  if (step.subsystem === 'SSIS') return parseSsisCommand(step.command) ? ['package', 'environment'] : ['command']
  return ['command']
}
/** A key field's value as the copy compares it: the SSIS package as its catalog path, the environment as its reference id. */
export function stepKeyValue(step: Pick<AgentStepDraft, 'subsystem' | 'command' | 'databaseName'>, field: StepKeyField): string {
  switch (field) {
    case 'database': return step.databaseName
    case 'command': return step.command
    case 'package': { const parsed = parseSsisCommand(step.command); return parsed ? ssisPackagePath(parsed) : step.command }
    case 'environment': { const reference = parseSsisCommand(step.command)?.environmentReference; return reference === undefined ? '' : String(reference) }
  }
}
/** The source's step a copied step came from (the copy keeps the source's step keys), else undefined for a step the copy added. */
export const sourceStepOf = (source: JobCopySource, key: string): AgentStepDraft | undefined => source.base.steps.steps.find(step => step.key === key)
/** Whether a copied step's key field differs from its source step's; an added step's always does. */
export function stepKeyChanged(source: JobCopySource, step: AgentStepDraft, field: StepKeyField): boolean {
  const from = sourceStepOf(source, step.key)
  return !from || from.subsystem !== step.subsystem || stepKeyValue(from, field) !== stepKeyValue(step, field)
}
/** The SSIS steps whose package differs from the source's: the ones whose required parameters the section checks. */
export function changedPackages(source: JobCopySource, draft: AgentJobDraft): readonly AgentStepDraft[] {
  return draft.steps.steps.filter(step => step.subsystem === 'SSIS' && parseSsisCommand(step.command) && stepKeyChanged(source, step, 'package'))
}

// --- Problems that belong to a copy -----------------------------------------------------------------------------------------

/** What stops a copy from saving beyond New Job's own problems: a source whose steps were not all read. */
export function createFromProblems(source: JobCopySource): readonly { readonly field: AgentJobField; readonly severity: 'error'; readonly message: string }[] {
  return source.model.stepsTruncated ? [{ field: 'steps', severity: 'error', message: createFromText.stepsTruncated }] : []
}

// --- Also copied ------------------------------------------------------------------------------------------------------------

/** "Also copied": what comes over unchanged, in one line. */
export function alsoCopiedText(source: JobCopySource): string {
  const base = source.base
  const parts = [base.description.trim() ? 'description' : undefined, `category ${base.category}`]
  const notify = (['email', 'page', 'netSend'] as const).filter(field => agentJobFieldText(base, field) !== 'Never').map(field => `${agentJobFieldLabels[field].toLowerCase()} ${agentJobFieldText(base, field)}`)
  parts.push(...notify)
  if (base.steps.steps.length) parts.push('flow, retries, output and logging on every step')
  return parts.filter((part): part is string => !!part).join(' · ')
}

// --- Compare with source ----------------------------------------------------------------------------------------------------

export interface CopyCompareRow {
  /** What the row is about: Job, Step n 'name', or Schedule 'name'. */
  readonly group: string
  readonly field: string
  readonly source: string
  readonly copy: string
}
const firstLine = (text: string) => { const line = text.split(/\r?\n/, 1)[0] ?? ''; return line.length > 120 || text.includes('\n') ? `${line.slice(0, 120)}…` : line || createFromText.none }
const stepSummary = (step: AgentStepDraft) => `${stepTypeShort(step.subsystem)} · ${firstLine(step.command)}`
const flowText = (steps: readonly AgentStepDraft[], step: AgentStepDraft, which: 'onSuccess' | 'onFail') => {
  const code = step[which], target = which === 'onSuccess' ? step.onSuccessTarget : step.onFailTarget
  if (code !== 4) return stepActionLabel(code)
  const at = steps.findIndex(item => item.key === target)
  return at >= 0 ? `Go to step ${at + 1} '${steps[at]!.name}'` : 'Go to a step that no longer exists'
}

/** Every difference between the copy and its source, field by field: the job's own fields, each step (added, removed, moved or edited)
 *  and each schedule (copied, left out, or new). Shared schedules are the same schedule, so they are no difference. */
export function createFromCompare(source: JobCopySource, draft: AgentJobDraft, proxies: readonly { readonly id: number; readonly name: string }[] = []): CopyCompareRow[] {
  const base = source.base, rows: CopyCompareRow[] = []
  for (const field of ['name', 'owner', 'category', 'description', 'enabled', 'email', 'page', 'netSend', 'eventLog', 'delete'] as const) {
    const before = agentJobFieldText(base, field), after = agentJobFieldText(draft, field)
    if (before !== after) rows.push({ group: 'Job', field: agentJobFieldLabels[field], source: before, copy: after })
  }
  const proxyName = (id: number) => id === 0 ? 'SQL Server Agent Service Account' : proxies.find(proxy => proxy.id === id)?.name ?? `Proxy ${id}`
  const sourceSteps = base.steps.steps, steps = draft.steps.steps
  sourceSteps.forEach((from, at) => {
    if (!steps.some(step => step.key === from.key)) rows.push({ group: `Step ${at + 1} '${from.name}'`, field: 'Step', source: stepSummary(from), copy: createFromText.removed })
  })
  steps.forEach((step, at) => {
    const group = `Step ${at + 1} '${step.name}'`
    const from = sourceSteps.find(item => item.key === step.key)
    if (!from) { rows.push({ group, field: 'Step', source: createFromText.added, copy: stepSummary(step) }); return }
    const was = sourceSteps.indexOf(from)
    const pairs: [string, string, string][] = [
      ['Position', String(was + 1), String(at + 1)],
      ['Name', from.name, step.name],
      ['Type', stepTypeShort(from.subsystem), stepTypeShort(step.subsystem)],
      ['Database', from.databaseName, step.databaseName],
      ['Command', from.command, step.command],
      ['Output file', from.outputFileName, step.outputFileName],
      ['Run as', proxyName(from.proxyId), proxyName(step.proxyId)],
      ['Retries', `${from.retryAttempts}, ${from.retryInterval} min apart`, `${step.retryAttempts}, ${step.retryInterval} min apart`],
      ['On success', flowText(sourceSteps, from, 'onSuccess'), flowText(steps, step, 'onSuccess')],
      ['On failure', flowText(sourceSteps, from, 'onFail'), flowText(steps, step, 'onFail')]
    ]
    for (const [field, before, after] of pairs) if (before !== after) rows.push({ group, field, source: field === 'Command' ? firstLine(before) : before || createFromText.none, copy: field === 'Command' ? firstLine(after) : after || createFromText.none })
  })
  const startOf = (value: AgentJobDraft) => { const at = value.steps.steps.findIndex(step => step.key === value.steps.startKey); return at >= 0 ? `Step ${at + 1} '${value.steps.steps[at]!.name}'` : createFromText.none }
  if (startOf(base) !== startOf(draft)) rows.push({ group: 'Job', field: 'Start step', source: startOf(base), copy: startOf(draft) })
  for (const record of source.model.schedules ?? []) {
    const choice = copyScheduleChoice(draft.schedules, record)
    if (choice === 'share') continue
    const entry = draft.schedules.find(item => item.key === copiedScheduleKey(record.id))
    rows.push({ group: `Schedule '${record.name}'`, field: 'Schedule', source: `${record.name} · ${scheduleWhen(record)}`, copy: entry ? `New schedule ${entry.fields.name} · ${scheduleWhen(entry.fields)}` : 'Left out' })
  }
  for (const entry of draft.schedules) {
    if (entry.remove || (entry.id !== undefined && (source.model.schedules ?? []).some(record => record.id === entry.id)) || /^n:copy:/.test(entry.key)) continue
    rows.push({ group: `Schedule '${entry.fields.name}'`, field: 'Schedule', source: createFromText.none, copy: `${entry.id === undefined ? 'New schedule' : 'Shared'} ${entry.fields.name} · ${scheduleWhen(entry.fields)}` })
  }
  return rows
}

// --- Commands -----------------------------------------------------------------------------------------------------------------

export type CreateFromCommandId = 'agent.createJobLike'
export interface CreateFromCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'copy'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
/**
 * Create Job Like This…: on a job's menu (after New Job…), on Job Activity Monitor's bar for the one
 * job selected there, and in the palette, where it copies the job document that is active, else asks for a job (SSMS has no such
 * command; the rethink's "New Job from Existing…" is a keyword). It opens New Job filled from the job, with Changes from source first.
 */
export function createFromCommandEntries(): { readonly [K in CreateFromCommandId]: CreateFromCommandEntry } {
  return {
    'agent.createJobLike': {
      title: 'Create Job Like This…', category: 'SQL Server Agent', icon: 'copy',
      keywords: ['agent', 'job', 'new', 'existing', 'from', 'copy', 'duplicate', 'clone', 'similar', 'sqlserveragent'],
      precondition: 'backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{ menu: 'explorer.context', group: '0_new', order: 2, mnemonic: 'c', when: "explorerNode == 'agentJob' && !explorerServerLost" }]
    }
  }
}
