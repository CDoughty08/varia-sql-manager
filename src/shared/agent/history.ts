// SQL Server Agent's Log File Viewer for job history (AG-5a, docs/sql-server-agent.md): the `agent.history` live source's args, the
// viewer's filters and commands, Delete History's request with its bounds (zod here, C# in ActionService.ValidateAgentHistory) and the
// pure rules the viewer follows. The backend reads and groups the runs (Agent/AgentHistoryReader.cs); this decides only what the
// renderer sends and shows. AG-5b adds the Agent error logs to the same viewer. No React here.
import { z } from 'zod'
import { actionErrorCodes, actionLimits, type ActionErrorCode } from '../actions/catalog.ts'
import { agentLimits } from './catalog.ts'
import type { AgentRole } from './profile.ts'

export const agentHistorySource = 'agent.history' as const
export const agentHistoryProbe = 'agent.history.list' as const

/** A run's outcome as the viewer filters it: msdb's run statuses of its job outcome row, or, for step rows with no job outcome row,
 *  In progress (the job runs now) and Unknown (Agent stopped or crashed mid-run, or its running state cannot be read). */
export const historyOutcomes = ['failed', 'succeeded', 'retry', 'canceled', 'inProgress', 'unknown'] as const
export type HistoryOutcome = typeof historyOutcomes[number]
export const historyOutcomeLabels: { readonly [O in HistoryOutcome]: string } = {
  failed: 'Failed', succeeded: 'Succeeded', retry: 'Retry', canceled: 'Canceled', inProgress: 'In progress', unknown: 'Unknown (no job outcome)'
}
/** The date windows the toolbar offers (days back from the server's clock); All reads every row the cap allows. */
export const historyWindows: readonly { readonly days?: number; readonly label: string }[] = [
  { days: 1, label: '24 h' }, { days: 7, label: 'Last 7 days' }, { days: 30, label: '30 days' }, { label: 'All' }
]
export const historyDefaultDays = 7
/** The widest date window args may name, in days. */
export const historyMaxDays = 3650
/** The highest step id the step filter takes (msdb's own steps are numbered from 1). */
export const historyMaxStep = 1000

/** A run by its job and an instance_id: its job outcome row's, or the first step row's of a run with none. */
export interface HistoryRunKey { readonly job: string; readonly instance: number }
export const historyRunKeySchema = z.object({ job: z.guid(), instance: z.number().int().min(1).max(2_147_483_647) }).strict()
/** The runs table's key column text for a run: `<job id>:<instance>`. */
export const historyRunKeyText = (key: HistoryRunKey): string => `${key.job.toLowerCase()}:${key.instance}`
export function parseHistoryRunKey(text: string): HistoryRunKey | undefined {
  const match = /^([0-9a-fA-F-]{36}):([0-9]{1,10})$/.exec(text)
  if (!match) return undefined
  const parsed = historyRunKeySchema.safeParse({ job: match[1].toLowerCase(), instance: Number(match[2]) })
  return parsed.success ? parsed.data : undefined
}

/** `agent.history`'s args, the viewer's filters: the checked jobs (absent: every job; empty: none, so no history is read), the date
 *  window in days, the run outcome, the message text (any row of the run), a step id (runs with a row of that step) and the selected
 *  run whose steps the second table lists. Each args replaces the last whole. The backend checks them again (AgentHistoryArgs.Check). */
export const agentHistoryArgsSchema = z.object({
  jobs: z.array(z.guid()).max(agentLimits.historyJobs).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'A job is checked once.').optional(),
  days: z.number().int().min(1).max(historyMaxDays).optional(),
  outcome: z.enum(historyOutcomes).optional(),
  text: z.string().min(1).max(agentLimits.searchChars).optional(),
  step: z.number().int().min(0).max(historyMaxStep).optional(),
  run: historyRunKeySchema.optional(),
  // The job document's History (AG-6d): the fourth table, its one job's usual durations.
  usual: z.literal(true).optional()
}).strict().refine(args => !args.usual || args.jobs?.length === 1, 'Usual durations are read for one checked job.')
export type AgentHistoryArgs = z.infer<typeof agentHistoryArgsSchema>

/** The viewer's filters as it holds them: checked jobs (undefined: All jobs), the window, outcome, message text, step and selected run. */
export interface HistoryFilters {
  readonly checked?: readonly string[]
  readonly days?: number
  readonly outcome?: HistoryOutcome
  readonly text: string
  readonly step?: number
  readonly run?: HistoryRunKey
}
/** The args a viewer's filters send: only what applies, each within the schema's bounds (a text cut to searchChars, a step list
 *  past historyJobs is never sent: the viewer refuses checking more). */
export function historyArgs(filters: HistoryFilters): AgentHistoryArgs {
  const text = filters.text.trim().slice(0, agentLimits.searchChars)
  return {
    ...filters.checked !== undefined ? { jobs: filters.checked.slice(0, agentLimits.historyJobs).map(id => id.toLowerCase()) } : {},
    ...filters.days !== undefined ? { days: filters.days } : {},
    ...filters.outcome ? { outcome: filters.outcome } : {},
    ...text ? { text } : {},
    ...filters.step !== undefined ? { step: filters.step } : {},
    ...filters.run ? { run: { job: filters.run.job.toLowerCase(), instance: filters.run.instance } } : {}
  }
}
/** How many filters Clear filters resets: the window (from its default), the outcome, the text and the step. */
export const historyActiveFilters = (filters: HistoryFilters): number =>
  (filters.days === historyDefaultDays ? 0 : 1) + (filters.outcome ? 1 : 0) + (filters.text.trim() ? 1 : 0) + (filters.step !== undefined ? 1 : 0)

// --- One row's whole message ------------------------------------------------------------------------------------------

/** agent.historyMessage: one history row's whole message (the grids cut them at gridMessageChars), by its job and instance_id. */
export interface AgentHistoryMessageRequest { readonly connectionId: string; readonly requestId: string; readonly jobId: string; readonly instanceId: number }
export interface AgentHistoryMessageResult {
  readonly message?: string; readonly elapsedMs: number
  readonly error?: { readonly code: ActionErrorCode; readonly message: string; readonly retryable: boolean }
}
export const agentHistoryMessageSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), jobId: z.guid(), instanceId: z.number().int().min(1).max(2_147_483_647)
}).strict() satisfies z.ZodType<AgentHistoryMessageRequest>
/** msdb's message column is nvarchar(4000). */
export const historyMessageChars = 4000
export const agentHistoryMessageResultSchema = z.object({
  message: z.string().max(historyMessageChars).optional(), elapsedMs: z.number().int().min(0),
  error: z.object({ code: z.enum(actionErrorCodes), message: z.string().max(actionLimits.messageChars), retryable: z.boolean() }).strict().optional()
}).strict() satisfies z.ZodType<AgentHistoryMessageResult>

// --- Delete History ---------------------------------------------------------------------------------------------------

/** The cut-off's unit, as the backend's `CASE @unit` reads it (Agent Properties' purge shares it): 1 days, 2 weeks, 3 months. */
export type AgentPurgeUnit = 1 | 2 | 3
export const historyUnitLabels: { readonly [U in AgentPurgeUnit]: string } = { 1: 'days', 2: 'weeks', 3: 'months' }

/** Delete History's scope: all of the jobs' history, or only rows older than `count` days, weeks or months before the server's clock
 *  (`before` is the cut-off the confirmation showed, server time `yyyy-mm-ddThh:mm:ss`, which the server never deletes past). */
export interface AgentHistoryDelete {
  readonly jobs: readonly string[]
  readonly all?: true
  readonly olderThan?: { readonly count: number; readonly unit: AgentPurgeUnit; readonly before?: string }
}
export interface DeleteJobHistoryRequest {
  readonly action: 'deleteJobHistory'; readonly connectionId: string; readonly requestId: string; readonly target: { readonly kind: 'agent'; readonly name?: undefined }
  readonly agentHistory: AgentHistoryDelete
}
const serverTime = z.string().max(19).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/)
export const agentHistoryDeleteSchema = z.object({
  // Without a job msdb purges every job on the server, so at least one is named (the template refuses a NULL @job_id too).
  jobs: z.array(z.guid()).min(1).max(agentLimits.historyJobs).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'A job is named once.'),
  all: z.literal(true).optional(),
  olderThan: z.object({
    count: z.number().int().min(1).max(agentLimits.purgeCount), unit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    before: serverTime.optional()
  }).strict().optional()
}).strict().refine(value => (value.all === undefined) !== (value.olderThan === undefined), 'Delete either all of the history or only the rows older than a cut-off.') satisfies z.ZodType<AgentHistoryDelete>
/** actions.execute's Delete History (no Script: SSMS's Delete History has none). */
export const deleteJobHistoryRequestSchema = z.object({
  action: z.literal('deleteJobHistory'), connectionId: z.uuid(), requestId: z.uuid(), target: z.object({ kind: z.literal('agent') }).strict(), agentHistory: agentHistoryDeleteSchema
}).strict() satisfies z.ZodType<DeleteJobHistoryRequest>

/** Why Delete History is not offered for the checked jobs, or undefined when it is: msdb lets sysadmin and SQLAgentOperatorRole purge any
 *  job's history, and a login with EXECUTE on sp_purge_jobhistory only its own jobs': msdb refuses the others (14392, PERMISSION_DENIED,
 *  rolled back), which the confirmation shows, since the viewer has no login name to compare owners with. */
export function deleteHistoryUnavailable(input: {
  readonly role: AgentRole; readonly purge?: boolean; readonly checked: number; readonly live: boolean
}): string | undefined {
  if (!input.live) return 'Connect to the server first.'
  if (input.checked === 0) return 'Check one or more jobs in Select logs first.'
  if (input.checked > agentLimits.historyJobs) return `Check at most ${agentLimits.historyJobs} jobs: each one is its own call in one transaction.`
  if (input.role === 'unknown') return "Reading this login's SQL Server Agent role…"
  if (input.role === 'sysadmin' || input.role === 'operator') return undefined
  if (!input.purge) return 'Only sysadmin and SQLAgentOperatorRole can delete job history (EXECUTE on msdb.dbo.sp_purge_jobhistory).'
  return undefined
}

// --- The document and its commands -------------------------------------------------------------------------------------

export const logViewerTitle = 'Log File Viewer'
export const logViewerTabName = (server: string): string => `${logViewerTitle} - ${server}`

export type LogViewerCommandId = 'agent.viewHistory' | 'agent.refreshHistory' | 'agent.deleteHistory'
export interface LogViewerCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'history' | 'refresh' | 'trash'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
const openViewer = 'Open Log File Viewer first (SQL Server Agent: View History).'
/**
 * The Log File Viewer's commands: View History on
 * the Agent node's, the Jobs folder's and a job's menus (SSMS's places, one placement) and in the palette, and the viewer's Refresh and Delete History.
 */
export function logViewerCommandEntries(): { readonly [K in LogViewerCommandId]: LogViewerCommandEntry } {
  return {
    'agent.viewHistory': {
      title: 'View History', category: 'SQL Server Agent', icon: 'history', keywords: ['agent', 'job', 'jobs', 'history', 'log', 'file', 'viewer', 'runs', 'outcome', 'failed'],
      precondition: 'backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{
        menu: 'explorer.context', group: '1_monitor', order: 2, mnemonic: 'h',
        when: "(explorerNode == 'agent' || (explorerNode == 'folder' && explorerFolder == 'agentJobs') || explorerNode == 'agentJob') && !explorerServerLost"
      }]
    },
    'agent.refreshHistory': {
      title: 'Refresh History', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'job', 'history', 'log', 'reload', 'now'],
      precondition: 'backendReady && activeDocumentIsLogViewer', unavailableHint: openViewer
    },
    'agent.deleteHistory': {
      title: 'Delete History…', category: 'SQL Server Agent', icon: 'trash', keywords: ['agent', 'job', 'history', 'purge', 'clear', 'remove'],
      precondition: 'backendReady && activeDocumentIsLogViewer', unavailableHint: openViewer
    }
  }
}
