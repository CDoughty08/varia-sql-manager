// The job document's Steps section (AG-6b, docs/agent-plan.md › Job document sections › Steps, docs/agent-ui-rethink.md › rx-job-steps,
// rx-step-*): a step as the describe reads it (sp_help_jobstep), the draft the section edits (go-to targets name steps by key, so they
// follow a move), the draft's operations (add, move, delete with what it changed for Undo's banner), the problems it shows, the
// More options sentence, and the save planner, pure and table-tested: msdb renumbers as it goes, so step numbers are never sent as they
// stand. No React here.
import { z } from 'zod'
import { agentLimits, stepActions, stepFlagMask, stepFlags, subsystems } from './catalog.ts'

/** sysjobsteps.on_success_action / on_fail_action: quit reporting success, quit reporting failure, go to the next step, go to a step. */
export type StepAction = 1 | 2 | 3 | 4
const stepActionCodes = [1, 2, 3, 4] as const

/** A step as sp_help_jobstep reads it. AG-6a's describe carried only id, name and subsystem; the rest default as sp_add_jobstep does. */
export interface AgentJobStepRecord {
  readonly id: number
  readonly name: string
  readonly subsystem: string
  readonly command?: string
  readonly flags?: number
  readonly cmdexecSuccessCode?: number
  readonly onSuccessAction?: number
  readonly onSuccessStepId?: number
  readonly onFailAction?: number
  readonly onFailStepId?: number
  /** Not modelled (a remote server for old subsystems); passed back as read. */
  readonly server?: string
  readonly databaseName?: string
  readonly databaseUserName?: string
  readonly retryAttempts?: number
  readonly retryInterval?: number
  /** Not modelled (-15, -1, 0, 1, 15); passed back as read. */
  readonly osRunPriority?: number
  readonly outputFileName?: string
  /** 0: SQL Server Agent Service Account (no proxy). */
  readonly proxyId?: number
}

/** A proxy the Run as picker offers, with the step types it is active for (sp_help_proxy @subsystem_name; below sysadmin only the proxies
 *  granted to the login). */
export interface AgentJobProxy {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  /** The credential's identity (the account the step runs as). */
  readonly identity?: string
  readonly subsystems: readonly string[]
}

/** One step of the draft. `key` is stable for the document's life; `from` is the step's id as described (absent for a new step). A go-to
 *  target is a key: it follows the step it names through moves. A target that named no described step keeps `s<id>`, dangling. */
export interface AgentStepDraft {
  readonly key: string
  readonly from?: number
  readonly name: string
  readonly subsystem: string
  readonly command: string
  readonly databaseName: string
  readonly databaseUserName: string
  readonly onSuccess: StepAction
  readonly onSuccessTarget?: string
  readonly onFail: StepAction
  readonly onFailTarget?: string
  readonly retryAttempts: number
  readonly retryInterval: number
  readonly outputFileName: string
  /** The whole sysjobsteps.flags value: the bits the section edits and the ones it carries (32, 64). */
  readonly flags: number
  readonly cmdexecSuccessCode: number
  readonly proxyId: number
  readonly server: string
  readonly osRunPriority: number
}

/** The steps part of the job draft: the steps in order and the key of the Start step (undefined when there are none). */
export interface AgentStepsDraft { readonly steps: readonly AgentStepDraft[]; readonly startKey?: string }

const action = (value: number | undefined, fallback: StepAction): StepAction => stepActionCodes.includes(value as StepAction) ? value as StepAction : fallback
const keyOf = (id: number) => `s${id}`
/** The id a dangling or described key names (`s<id>`), else undefined. */
const describedId = (key: string): number | undefined => /^s[1-9][0-9]*$/.test(key) ? Number(key.slice(1)) : undefined

/** A described step as the draft holds it. */
export function stepDraftOf(step: AgentJobStepRecord): AgentStepDraft {
  const onSuccess = action(step.onSuccessAction, 1), onFail = action(step.onFailAction, 2)
  return {
    key: keyOf(step.id), from: step.id, name: step.name, subsystem: step.subsystem, command: step.command ?? '', databaseName: step.databaseName ?? '', databaseUserName: step.databaseUserName ?? '',
    onSuccess, ...onSuccess === 4 && step.onSuccessStepId ? { onSuccessTarget: keyOf(step.onSuccessStepId) } : {},
    onFail, ...onFail === 4 && step.onFailStepId ? { onFailTarget: keyOf(step.onFailStepId) } : {},
    retryAttempts: step.retryAttempts ?? 0, retryInterval: step.retryInterval ?? 0, outputFileName: step.outputFileName ?? '', flags: step.flags ?? 0,
    cmdexecSuccessCode: step.cmdexecSuccessCode ?? 0, proxyId: step.proxyId ?? 0, server: step.server ?? '', osRunPriority: step.osRunPriority ?? 0
  }
}
/** The described steps as the draft opens with them; the Start step is the job's start_step_id when it names a step, else the first. */
export function initialStepsDraft(steps: readonly AgentJobStepRecord[], startStepId: number | undefined): AgentStepsDraft {
  const drafted = [...steps].sort((a, b) => a.id - b.id).map(stepDraftOf)
  const start = drafted.find(step => step.from === startStepId) ?? drafted[0]
  return { steps: drafted, ...start ? { startKey: start.key } : {} }
}

// --- Operations on the draft --------------------------------------------------------------------------------------------

/** A key no step of the draft has: `n1`, `n2`, … */
export function newStepKey(steps: readonly AgentStepDraft[]): string {
  const used = steps.map(step => /^n([0-9]+)$/.exec(step.key)?.[1]).filter((value): value is string => !!value).map(Number)
  return `n${(used.length ? Math.max(...used) : 0) + 1}`
}
/** A unique name for a new step: "Step n", counting up past names in use. */
export function newStepName(steps: readonly AgentStepDraft[]): string {
  const names = new Set(steps.map(step => step.name.toLowerCase()))
  for (let at = steps.length + 1; ; at++) if (!names.has(`step ${at}`)) return `Step ${at}`
}
/** A new step of `subsystem` as SSMS's New Step opens it (go to the next step on success, quit reporting failure on failure). */
export function newStepDraft(steps: readonly AgentStepDraft[], subsystem = 'TSQL', databaseName = 'master'): AgentStepDraft {
  return {
    key: newStepKey(steps), name: newStepName(steps), subsystem, command: '', databaseName: subsystem === 'TSQL' ? databaseName : '', databaseUserName: '',
    onSuccess: 3, onFail: 2, retryAttempts: 0, retryInterval: 0, outputFileName: '', flags: 0, cmdexecSuccessCode: 0, proxyId: 0, server: '', osRunPriority: 0
  }
}
/** Adds `step` at `index` (the end by default); the first step becomes the Start step. The previous last step's "next step" now reaches it. */
export function addStep(draft: AgentStepsDraft, step: AgentStepDraft, index = draft.steps.length): AgentStepsDraft {
  const steps = [...draft.steps]
  steps.splice(Math.max(0, Math.min(index, steps.length)), 0, step)
  return { steps, startKey: draft.startKey ?? step.key }
}
/** Moves the step `key` to `index` (its position after the move). Go-to targets are keys, so they follow; the Start step stays the same step. */
export function moveStep(draft: AgentStepsDraft, key: string, index: number): AgentStepsDraft {
  const from = draft.steps.findIndex(step => step.key === key)
  if (from < 0) return draft
  const to = Math.max(0, Math.min(index, draft.steps.length - 1))
  if (to === from) return draft
  const steps = [...draft.steps]
  const [moved] = steps.splice(from, 1)
  steps.splice(to, 0, moved!)
  return { ...draft, steps }
}
/** What a delete changed, for the banner and Undo: the steps (by key) that went to it and now quit reporting failure, and whether it was the
 *  Start step (the first remaining step is now). */
export interface StepDeletion { readonly deleted: AgentStepDraft; readonly position: number; readonly retargeted: readonly string[]; readonly startMoved: boolean; readonly before: AgentStepsDraft }
/** Deletes the step `key`, as SSMS does: a step that went to it now quits reporting failure. Returns the draft and what changed (undefined when
 *  no such step). */
export function deleteStep(draft: AgentStepsDraft, key: string): { readonly draft: AgentStepsDraft; readonly deletion: StepDeletion } | undefined {
  const position = draft.steps.findIndex(step => step.key === key)
  if (position < 0) return undefined
  const deleted = draft.steps[position]!
  const retargeted: string[] = []
  const steps = draft.steps.filter(step => step.key !== key).map(step => {
    const success = step.onSuccess === 4 && step.onSuccessTarget === key, fail = step.onFail === 4 && step.onFailTarget === key
    if (!success && !fail) return step
    retargeted.push(step.key)
    const { onSuccessTarget, onFailTarget, ...rest } = step
    return { ...rest, onSuccess: success ? 2 : step.onSuccess, onFail: fail ? 2 : step.onFail, ...success ? {} : onSuccessTarget ? { onSuccessTarget } : {}, ...fail ? {} : onFailTarget ? { onFailTarget } : {} } as AgentStepDraft
  })
  const startMoved = draft.startKey === key
  const startKey = startMoved ? steps[0]?.key : draft.startKey
  return { draft: { steps, ...startKey ? { startKey } : {} }, deletion: { deleted, position, retargeted, startMoved, before: draft } }
}
/** Undo of a delete: the step back at its position, the steps it retargeted going to it again (each side only while it still quits reporting
 *  failure, as the delete left it), and the Start step back when it moved. Edits made since the delete are kept. */
export function undoStepDeletion(draft: AgentStepsDraft, deletion: StepDeletion): AgentStepsDraft {
  if (draft.steps.some(step => step.key === deletion.deleted.key)) return draft
  const original = new Map(deletion.before.steps.map(step => [step.key, step]))
  const steps = draft.steps.map(step => {
    const was = deletion.retargeted.includes(step.key) ? original.get(step.key) : undefined
    if (!was) return step
    const success = was.onSuccess === 4 && was.onSuccessTarget === deletion.deleted.key && step.onSuccess === 2
    const fail = was.onFail === 4 && was.onFailTarget === deletion.deleted.key && step.onFail === 2
    return { ...step, ...success ? { onSuccess: 4 as const, onSuccessTarget: deletion.deleted.key } : {}, ...fail ? { onFail: 4 as const, onFailTarget: deletion.deleted.key } : {} }
  })
  steps.splice(Math.min(deletion.position, steps.length), 0, deletion.deleted)
  const startKey = deletion.startMoved && draft.startKey === deletion.before.steps.find(step => step.key !== deletion.deleted.key)?.key ? deletion.deleted.key : draft.startKey ?? deletion.deleted.key
  return { steps, startKey }
}
/** Changes a step's type, dropping what the new type cannot keep (msdb refuses flag 4 outside T-SQL and 64 outside CmdExec, and clears a
 *  CmdExec step's database and a non-T-SQL step's database user). */
export function withSubsystem(step: AgentStepDraft, subsystem: string): AgentStepDraft {
  if (step.subsystem === subsystem) return step
  let flags = step.flags
  const tsql = subsystem === 'TSQL'
  if (step.subsystem === 'TSQL' && !tsql && (flags & stepFlags.includeStepOutputInHistory)) flags = (flags & ~stepFlags.includeStepOutputInHistory) | includeAllOutput
  else if (step.subsystem !== 'TSQL' && tsql && (flags & includeAllOutput)) flags = (flags & ~includeAllOutput) | stepFlags.includeStepOutputInHistory
  if (subsystem !== 'CmdExec') flags &= ~cmdExecAbortEvent
  if (!tableLogSubsystems.has(subsystem)) flags &= ~(stepFlags.logToTable | stepFlags.logToTableAppend)
  return { ...step, subsystem, flags, databaseName: tsql ? step.databaseName || 'master' : subsystem === 'CmdExec' ? '' : step.databaseName, databaseUserName: tsql ? step.databaseUserName : '' }
}

// --- Flags (docs/agent-plan.md › Step dialog Advanced) ----------------------------------------------------------------------

/** "Include step output in history" outside T-SQL: msdb takes 4 only for T-SQL steps, and SSMS sets 32 (all output) for the others. */
const includeAllOutput = 32
/** CmdExec's abort event bit, carried as read; msdb refuses it on any other type. */
const cmdExecAbortEvent = 64
/** The types msdb lets log to a table or an output file. */
const tableLogSubsystems = new Set(['TSQL', 'CmdExec', 'ANALYSISQUERY', 'ANALYSISCOMMAND', 'SSIS', 'PowerShell'])
export const stepOutputSubsystems: ReadonlySet<string> = tableLogSubsystems
/** The More options checkboxes as `flags` holds them. */
export interface StepFlagChoices { readonly appendOutput: boolean; readonly includeOutput: boolean; readonly logToTable: boolean; readonly appendTable: boolean }
export function stepFlagChoices(step: Pick<AgentStepDraft, 'flags' | 'subsystem'>): StepFlagChoices {
  const include = step.subsystem === 'TSQL' ? stepFlags.includeStepOutputInHistory : includeAllOutput
  return {
    appendOutput: (step.flags & stepFlags.appendOutputFile) !== 0, includeOutput: (step.flags & include) !== 0,
    logToTable: (step.flags & (stepFlags.logToTable | stepFlags.logToTableAppend)) !== 0, appendTable: (step.flags & stepFlags.logToTableAppend) !== 0
  }
}
/** `flags` with the choices applied, as SSMS scripts them: Log to table alone is 8, with Append 16 (never 24); every other bit is kept. */
export function stepFlagsWith(step: Pick<AgentStepDraft, 'flags' | 'subsystem'>, choices: Partial<StepFlagChoices>): number {
  const next = { ...stepFlagChoices(step), ...choices }
  const include = step.subsystem === 'TSQL' ? stepFlags.includeStepOutputInHistory : includeAllOutput
  let flags = step.flags & ~stepFlagMask & ~include
  if (next.appendOutput) flags |= stepFlags.appendOutputFile
  if (next.includeOutput) flags |= include
  if (next.logToTable) flags |= next.appendTable ? stepFlags.logToTableAppend : stepFlags.logToTable
  return flags
}

// --- Words --------------------------------------------------------------------------------------------------------------

export const stepTypeLabel = (subsystem: string): string => subsystems.find(entry => entry.id.toLowerCase() === subsystem.toLowerCase())?.label ?? subsystem
/** The list's short type names (rx-job-steps). */
export const stepTypeShort = (subsystem: string): string => ({ TSQL: 'T-SQL', CmdExec: 'CmdExec', PowerShell: 'PowerShell', SSIS: 'SSIS' } as Record<string, string>)[subsystem] ?? stepTypeLabel(subsystem)
export const stepActionLabel = (code: StepAction): string => stepActions.find(entry => entry.code === code)?.label ?? 'Go to step'

/** Where a step goes on success or failure, as the list shows it (✓ / ✗): "Next step", "Quit, success", "Step 4". */
export function stepTargetShort(draft: AgentStepsDraft, step: AgentStepDraft, which: 'success' | 'fail'): string {
  const code = which === 'success' ? step.onSuccess : step.onFail, target = which === 'success' ? step.onSuccessTarget : step.onFailTarget
  if (code === 1) return 'Quit, success'
  if (code === 2) return 'Quit, failure'
  if (code === 3) return draft.steps[draft.steps.length - 1]?.key === step.key ? 'Next step (none: quits)' : 'Next step'
  const at = target ? draft.steps.findIndex(item => item.key === target) : -1
  return at >= 0 ? `Step ${at + 1}` : `Step ${target ? describedId(target) ?? '?' : '?'} (missing)`
}
/** The More options fold's one line (rx-job-steps): retries, output file, history, run as user. */
export function stepOptionsSummary(step: AgentStepDraft): string {
  const parts: string[] = []
  parts.push(step.retryAttempts ? `Retry ${step.retryAttempts} ${step.retryAttempts === 1 ? 'time' : 'times'}, ${step.retryInterval} ${step.retryInterval === 1 ? 'minute' : 'minutes'} apart` : 'No retries')
  const choices = stepFlagChoices(step)
  if (step.outputFileName) parts.push(`output to ${step.outputFileName} (${choices.appendOutput ? 'append' : 'overwrite'})`)
  if (choices.logToTable) parts.push(`log to table${choices.appendTable ? ' (append)' : ''}`)
  parts.push(choices.includeOutput ? 'include step output in history' : 'step output not kept in history')
  if (step.subsystem === 'TSQL' && step.databaseUserName) parts.push(`run as ${step.databaseUserName}`)
  return parts.join(' · ')
}

export const stepText = {
  deleted: (position: number, name: string) => `Deleted step ${position} '${name}'.`,
  retargeted: (numbers: readonly number[]) => numbers.length === 0 ? '' : `${numbers.length === 1 ? 'Step' : 'Steps'} ${listed(numbers)} went to it; ${numbers.length === 1 ? 'it now quits' : 'they now quit'} reporting failure.`,
  startMoved: 'It was the Start step; the first step is the Start step now.',
  notYet: 'Nothing changes on the server until you save.',
  undo: 'Undo',
  dragHint: 'Drag to reorder, or use Move up and Move down. The check is where the job goes on success, the cross on failure; targets follow a move, and one that no longer exists is flagged.',
  none: 'This job has no steps yet, so it does nothing when it runs. Add a step to give it work.',
  tsqlContext: (database: string) => `Completion and errors come from ${database}, as in a query window. Open in query window runs it there to test, not as the job.`,
  cmdExecHelp: (server: string, account: string) => `Runs on ${server} as ${account}, not on your computer. Paths are the server's.`,
  powerShellHelp: (server: string, account: string) => `Runs in the SQL Server Agent PowerShell host on ${server}, as ${account}.`,
  successCode: 'Any other exit code fails the step.',
  serviceAccount: 'SQL Server Agent Service Account',
  serviceAccountSysadmin: 'Only sysadmin can run a step as the SQL Server Agent service account; pick a proxy.',
  proxyInactive: (name: string, type: string) => `${name} is not active for ${type}.`,
  tableLogMoves: "This step logs to a table, whose rows stay with the step's position: after the move they belong to the step now in that position.",
  outputSysadmin: 'Only sysadmin can set an output file; msdb refuses to save this step for other logins.',
  runAsUserSysadmin: 'Only sysadmin can set Run as user; msdb ignores it for other logins.',
  unmodelled: 'Varia cannot lay this command out field by field, so it is kept as text.',
  parseOk: 'Commands completed successfully. (Parsed only; nothing ran.)',
  parseUnavailable: 'Parse is not available: the SQL backend is not running.'
} as const
const listed = (numbers: readonly number[]) => numbers.length < 2 ? numbers.join('') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`

// --- Problems: on the step, its field, the Steps tab and the header; only what msdb would refuse outright is an error -------

export type AgentStepField = 'name' | 'type' | 'command' | 'database' | 'runAs' | 'onSuccess' | 'onFail' | 'output' | 'runAsUser' | 'package'
export interface AgentStepProblem { readonly key: string; readonly field: AgentStepField; readonly severity: 'error' | 'warning'; readonly message: string }
export interface AgentStepContext {
  readonly sysadmin: boolean
  /** Undefined when the login may not read proxies: nothing is said about them. */
  readonly proxies?: readonly AgentJobProxy[]
  /** Problems the SSIS section found (a required parameter without a value), by step key. */
  readonly ssis?: ReadonlyMap<string, readonly string[]>
}
/** The steps' problems. Errors (Save cannot send them): a missing, duplicate or reserved name, a go-to to itself, a too long command or path.
 *  Warnings: a target that no longer exists, a proxy not active for the type, an output file or run-as user only sysadmin may set, SSIS. */
export function agentStepProblems(draft: AgentStepsDraft, context: AgentStepContext): AgentStepProblem[] {
  const problems: AgentStepProblem[] = []
  const names = new Map<string, number>()
  for (const step of draft.steps) names.set(step.name.trim().toLowerCase(), (names.get(step.name.trim().toLowerCase()) ?? 0) + 1)
  const keys = new Set(draft.steps.map(step => step.key))
  let commandChars = 0
  for (const step of draft.steps) {
    const push = (field: AgentStepField, severity: 'error' | 'warning', message: string) => problems.push({ key: step.key, field, severity, message })
    const name = step.name.trim()
    if (!name) push('name', 'error', 'The step needs a name.')
    else if (name.length > agentLimits.nameChars) push('name', 'error', `A step name holds at most ${agentLimits.nameChars} characters.`)
    else if (name.toLowerCase().startsWith(temporaryStepPrefix)) push('name', 'error', `A step name cannot start with ${temporaryStepPrefix}: Save uses it while it renumbers.`)
    else if ((names.get(name.toLowerCase()) ?? 0) > 1) push('name', 'error', `Another step is also named '${name}'; step names are unique within a job.`)
    for (const which of ['onSuccess', 'onFail'] as const) {
      const target = which === 'onSuccess' ? step.onSuccessTarget : step.onFailTarget
      if (step[which] !== 4) continue
      if (target === step.key) push(which, 'error', 'A step cannot go to itself.')
      else if (!target || !keys.has(target)) push(which, 'warning', `It goes to step ${target ? describedId(target) ?? '?' : '?'}, which no longer exists: choose where it goes.`)
    }
    if (step.command.length > agentLimits.stepCommandChars) push('command', 'error', `A step's command holds at most ${agentLimits.stepCommandChars.toLocaleString('en-US')} characters.`)
    commandChars += step.command.length
    if (step.outputFileName.length > agentLimits.stepOutputChars) push('output', 'error', `An output file path holds at most ${agentLimits.stepOutputChars} characters.`)
    if (step.outputFileName.trim() && !context.sysadmin) push('output', 'warning', stepText.outputSysadmin)
    if (step.databaseUserName.trim() && step.subsystem === 'TSQL' && !context.sysadmin) push('runAsUser', 'warning', stepText.runAsUserSysadmin)
    if (step.proxyId && context.proxies) {
      const proxy = context.proxies.find(item => item.id === step.proxyId)
      if (proxy && !proxy.subsystems.some(subsystem => subsystem.toLowerCase() === step.subsystem.toLowerCase())) push('runAs', 'warning', stepText.proxyInactive(proxy.name, stepTypeShort(step.subsystem)))
    }
    if (!step.proxyId && !context.sysadmin && step.subsystem !== 'TSQL') push('runAs', 'warning', stepText.serviceAccountSysadmin)
    for (const message of context.ssis?.get(step.key) ?? []) push('package', 'warning', message)
  }
  if (commandChars > agentLimits.stepCommandTotalChars) problems.push({ key: draft.steps[0]?.key ?? '', field: 'command', severity: 'error', message: `The steps' commands hold at most ${agentLimits.stepCommandTotalChars.toLocaleString('en-US')} characters together.` })
  return problems
}

// --- The save planner (docs/agent-plan.md › Steps › Save order) ---------------------------------------------------------------

/** The prefix of the names Save gives every surviving step while it renumbers (then a GUID's 32 hex digits): under 128 characters. */
export const temporaryStepPrefix = '__varia_step_'
export const temporaryStepPattern = /^__varia_step_[0-9a-f]{32}$/
/** One step's whole content written into step `id`: sp_update_jobstep (an existing job's) or sp_add_jobstep (New Job's). Go-to targets are
 *  final ids. A proxy of 0 is the service account (sp_update_jobstep's @proxy_name = N''). Strings are '' for none (msdb stores NULL). */
export interface AgentStepWrite {
  readonly id: number
  readonly name: string
  readonly subsystem: string
  readonly command: string
  readonly databaseName: string
  readonly databaseUserName: string
  readonly onSuccessAction: StepAction
  readonly onSuccessStepId: number
  readonly onFailAction: StepAction
  readonly onFailStepId: number
  readonly retryAttempts: number
  readonly retryInterval: number
  readonly outputFileName: string
  readonly flags: number
  readonly cmdexecSuccessCode: number
  readonly proxyId: number
  readonly server: string
  readonly osRunPriority: number
}
/** What Save sends for the steps, in the order the backend calls them: (1) `deletes`, described ids from the highest down (sp_delete_jobstep);
 *  (2) `temporary`, a unique temporary name for every surviving step at its id after the deletes (sp_update_jobstep @step_name); (3) `adds`,
 *  a new step at each final position in ascending order, also under a temporary name (sp_add_jobstep @step_id); (4) `writes`, each step's
 *  whole content into its final id; (5) `startStepId` (sp_update_job). New Job's has only `writes` (sp_add_jobstep in order, ids 1..n) and
 *  `startStepId`. With no add, delete, move or rename, only the changed steps' writes and a changed Start step go. */
export interface AgentStepsSave {
  readonly deletes?: readonly number[]
  readonly temporary?: readonly { readonly id: number; readonly name: string }[]
  readonly adds?: readonly { readonly id: number; readonly name: string }[]
  readonly writes?: readonly AgentStepWrite[]
  readonly startStepId?: number
}

/** Step `step`'s content at final id `id`, its targets resolved to final ids (a dangling target keeps the id it named). */
function writeOf(draft: AgentStepsDraft, step: AgentStepDraft, id: number): AgentStepWrite {
  const target = (code: StepAction, key: string | undefined) => {
    if (code !== 4 || !key) return 0
    const at = draft.steps.findIndex(item => item.key === key)
    return at >= 0 ? at + 1 : describedId(key) ?? 0
  }
  return {
    id, name: step.name.trim(), subsystem: step.subsystem, command: step.command, databaseName: step.subsystem === 'CmdExec' ? '' : step.databaseName.trim(),
    databaseUserName: step.subsystem === 'TSQL' ? step.databaseUserName.trim() : '', onSuccessAction: step.onSuccess, onSuccessStepId: target(step.onSuccess, step.onSuccessTarget),
    onFailAction: step.onFail, onFailStepId: target(step.onFail, step.onFailTarget), retryAttempts: step.retryAttempts, retryInterval: step.retryInterval,
    outputFileName: step.outputFileName.trim(), flags: step.flags, cmdexecSuccessCode: step.cmdexecSuccessCode, proxyId: step.proxyId, server: step.server, osRunPriority: step.osRunPriority
  }
}
const sameWrite = (a: AgentStepWrite, b: AgentStepWrite) => JSON.stringify(a) === JSON.stringify(b)

const hexGuid = () => crypto.randomUUID().replace(/-/g, '')
/**
 * The save of the steps: undefined when they change nothing. `described` are the steps as read with `startStepId` (undefined for New Job,
 * whose steps are all new). `guid` makes the temporary names' 32 hex digits (tests pass their own).
 */
export function planAgentSteps(described: readonly AgentJobStepRecord[] | undefined, draft: AgentStepsDraft, startStepId: number | undefined, guid: () => string = hexGuid): AgentStepsSave | undefined {
  const final = draft.steps.length
  const start = draft.startKey ? draft.steps.findIndex(step => step.key === draft.startKey) + 1 : 0
  const writes = draft.steps.map((step, at) => writeOf(draft, step, at + 1))
  if (!described) {
    if (final === 0) return undefined
    return { writes, ...start > 1 ? { startStepId: start } : {} }
  }
  const byId = new Map(described.map(step => [step.id, step]))
  const original = initialStepsDraft(described, startStepId)
  const survivors = draft.steps.filter(step => step.from !== undefined && byId.has(step.from))
  const kept = new Set(survivors.map(step => step.from!))
  const deletes = [...byId.keys()].filter(id => !kept.has(id)).sort((a, b) => b - a)
  const adds = draft.steps.map((step, at) => ({ step, at })).filter(({ step }) => step.from === undefined || !byId.has(step.from))
  const structural = deletes.length > 0 || adds.length > 0 || draft.steps.some((step, at) => step.from !== undefined && (step.from !== at + 1 || step.name.trim() !== byId.get(step.from)?.name))
  if (!structural) {
    const changed = writes.filter((write, at) => {
      const was = original.steps.find(step => step.from === draft.steps[at]!.from)
      return !was || !sameWrite(write, writeOf(original, was, write.id))
    })
    const startChanged = final > 0 && start !== (original.startKey ? original.steps.findIndex(step => step.key === original.startKey) + 1 : 0)
    if (changed.length === 0 && !startChanged) return undefined
    return { ...changed.length ? { writes: changed } : {}, ...startChanged ? { startStepId: start } : {} }
  }
  return {
    ...deletes.length ? { deletes } : {},
    ...survivors.length ? { temporary: survivors.map((_, at) => ({ id: at + 1, name: temporaryStepPrefix + guid() })) } : {},
    ...adds.length ? { adds: adds.map(({ at }) => ({ id: at + 1, name: temporaryStepPrefix + guid() })) } : {},
    ...final ? { writes } : {},
    ...final ? { startStepId: start || 1 } : {}
  }
}

/** The steps' share of "Save · n changes": each step added, deleted, moved, renamed or edited, and a changed Start step. */
export function agentStepChangeCount(described: readonly AgentJobStepRecord[] | undefined, draft: AgentStepsDraft, startStepId: number | undefined): number {
  return described ? agentStepChangeCountFrom(initialStepsDraft(described, startStepId), draft) : draft.steps.length
}
/** The same count from the steps as the document opened them. */
export function agentStepChangeCountFrom(original: AgentStepsDraft, draft: AgentStepsDraft): number {
  const deleted = original.steps.filter(step => !draft.steps.some(item => item.from === step.from)).length
  const changed = draft.steps.filter((step, at) => {
    const was = original.steps.find(item => item.from !== undefined && item.from === step.from)
    return !was || was.from !== at + 1 || !sameWrite(writeOf(draft, step, at + 1), writeOf(original, was, at + 1))
  }).length
  const startChanged = (draft.startKey ?? '') !== (original.startKey ?? '') && draft.steps.length > 0 ? 1 : 0
  return deleted + changed + startChanged
}

/** The steps as the compare shows them: "3 steps: Extract, Load, Notify". */
export function stepsText(draft: AgentStepsDraft): string {
  return draft.steps.length ? `${draft.steps.length} ${draft.steps.length === 1 ? 'step' : 'steps'}: ${draft.steps.map(step => step.name).join(', ')}` : 'No steps'
}
/** A comparable value of the steps (order, content, Start step). */
export function stepsValue(draft: AgentStepsDraft): string {
  return JSON.stringify([draft.steps.map((step, at) => writeOf(draft, step, at + 1)), draft.startKey ? draft.steps.findIndex(step => step.key === draft.startKey) : -1])
}
/** Reload and keep my changes: the user's steps over the job read now. A step whose described id the job no longer has with the same name
 *  becomes a new step, so the save never writes over another session's step by its number. */
export function rebaseSteps(opened: readonly AgentJobStepRecord[], current: readonly AgentJobStepRecord[], draft: AgentStepsDraft): AgentStepsDraft {
  const steps = draft.steps.map(step => {
    if (step.from === undefined) return step
    const was = opened.find(item => item.id === step.from), now = current.find(item => item.id === step.from)
    if (was && now && was.name === now.name) return step
    const { from: _from, ...rest } = step
    return rest
  })
  return { ...draft, steps }
}

// --- Bounds (zod here, C# in ActionService.ValidateAgentJob) -------------------------------------------------------------

const stepName = z.string().min(1).max(agentLimits.nameChars)
const noNul = (value: string) => !value.includes('\u0000')
const text = (max: number) => z.string().max(max).refine(noNul, 'Text cannot contain U+0000.')
const stepId = z.number().int().min(1).max(agentLimits.stepsPerJob)
export const agentStepWriteSchema = z.object({
  id: stepId,
  name: stepName.refine(noNul, 'A name cannot contain U+0000.').refine(value => !value.toLowerCase().startsWith(temporaryStepPrefix), 'A step name cannot use the temporary prefix.'),
  subsystem: z.enum(subsystems.map(entry => entry.id) as [string, ...string[]]),
  command: text(agentLimits.stepCommandChars),
  databaseName: text(agentLimits.nameChars),
  databaseUserName: text(agentLimits.nameChars),
  onSuccessAction: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  onSuccessStepId: z.number().int().min(0).max(agentLimits.stepsPerJob),
  onFailAction: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  onFailStepId: z.number().int().min(0).max(agentLimits.stepsPerJob),
  retryAttempts: z.number().int().min(0).max(agentLimits.stepRetries),
  retryInterval: z.number().int().min(0).max(agentLimits.stepRetryMinutes),
  outputFileName: text(agentLimits.stepOutputChars),
  flags: z.number().int().min(0).max(114),
  cmdexecSuccessCode: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  proxyId: z.number().int().min(0).max(2_147_483_647),
  server: text(agentLimits.nameChars),
  osRunPriority: z.union([z.literal(-15), z.literal(-1), z.literal(0), z.literal(1), z.literal(15)])
}).strict() satisfies z.ZodType<AgentStepWrite>
const temporaryName = z.object({ id: stepId, name: z.string().regex(temporaryStepPattern) }).strict()
export const agentStepsSaveSchema = z.object({
  deletes: z.array(stepId).min(1).max(agentLimits.stepsPerJob).optional(),
  temporary: z.array(temporaryName).min(1).max(agentLimits.stepsPerJob).optional(),
  adds: z.array(temporaryName).min(1).max(agentLimits.stepsPerJob).optional(),
  writes: z.array(agentStepWriteSchema).min(1).max(agentLimits.stepsPerJob).optional(),
  startStepId: stepId.optional()
}).strict() satisfies z.ZodType<AgentStepsSave>

/** Why a steps save is not in the planner's shape (C#'s ValidateAgentSteps refuses the same). `create`: New Job's. */
export function agentStepsSaveProblems(save: AgentStepsSave, create: boolean): string[] {
  const problems: string[] = []
  const deletes = save.deletes ?? [], temporary = save.temporary ?? [], adds = save.adds ?? [], writes = save.writes ?? []
  const ascending = (ids: readonly number[]) => ids.every((id, at) => at === 0 || id > ids[at - 1]!)
  if (create) {
    if (deletes.length || temporary.length || adds.length) problems.push('A new job has no steps to delete, rename or insert.')
    if (!writes.every((write, at) => write.id === at + 1)) problems.push("A new job's steps are added in order from 1.")
  } else if (deletes.length || temporary.length || adds.length) {
    if (!deletes.every((id, at) => at === 0 || id < deletes[at - 1]!)) problems.push('Steps are deleted from the highest id down.')
    if (!temporary.every((item, at) => item.id === at + 1)) problems.push('Every surviving step is renamed, at its id after the deletes.')
    if (!ascending(adds.map(item => item.id))) problems.push('New steps are inserted in ascending order.')
    const final = temporary.length + adds.length
    if (adds.some(item => item.id > final)) problems.push('A new step is inserted past the last step.')
    if (writes.length !== final || !writes.every((write, at) => write.id === at + 1)) problems.push('After renumbering, every step is written once, in order.')
    const names = [...temporary, ...adds].map(item => item.name)
    if (new Set(names).size !== names.length) problems.push('A temporary name is used twice.')
    if (final > 0 && save.startStepId === undefined) problems.push('After renumbering, the Start step is set.')
  } else {
    if (new Set(writes.map(write => write.id)).size !== writes.length) problems.push('A step is written twice.')
  }
  if (create || deletes.length || temporary.length || adds.length) {
    const names = writes.map(write => write.name.toLowerCase())
    if (new Set(names).size !== names.length) problems.push('Two steps have the same name.')
  }
  const count = create || deletes.length || temporary.length || adds.length ? writes.length : agentLimits.stepsPerJob
  for (const write of writes) {
    if (write.onSuccessAction === 4 && (write.onSuccessStepId < 1 || write.onSuccessStepId === write.id)) problems.push(`Step ${write.id} goes to an invalid step on success.`)
    if (write.onFailAction === 4 && (write.onFailStepId < 1 || write.onFailStepId === write.id)) problems.push(`Step ${write.id} goes to an invalid step on failure.`)
    if (write.onSuccessAction !== 4 && write.onSuccessStepId !== 0) problems.push(`Step ${write.id} names a target without going to it.`)
    if (write.onFailAction !== 4 && write.onFailStepId !== 0) problems.push(`Step ${write.id} names a target without going to it.`)
  }
  if (save.startStepId !== undefined && save.startStepId > count) problems.push('The Start step is past the last step.')
  if (writes.reduce((sum, write) => sum + write.command.length, 0) > agentLimits.stepCommandTotalChars) problems.push("The steps' commands are too long together.")
  return problems
}
