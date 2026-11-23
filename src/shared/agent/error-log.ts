// SQL Server Agent's error logs in the Log File Viewer (AG-5b, docs/sql-server-agent.md): the `agent.errorLog` live source's args, the
// `agent.errorLogs` method that lists the logs for the viewer's sources, Recycle's request (actions.execute's recycleAgentErrorLog), its
// confirmation and when it is offered, and the commands on Object Explorer's Error Logs folder and its logs. The backend reads the logs
// (Agent/AgentErrorLogReader.cs, Actions/AgentErrorLogs.cs); this decides only what the renderer sends and shows. No React here.
import { z } from 'zod'
import { actionErrorCodes, actionLimits, type ActionErrorCode } from '../actions/catalog.ts'
import { agentLimits } from './catalog.ts'
import { historyMaxDays } from './history.ts'
import type { AgentRole } from './profile.ts'

export const agentErrorLogSource = 'agent.errorLog' as const
export const agentErrorLogProbe = 'agent.errorLog.read' as const

/** SQL Server Agent keeps at most 99 archives besides the current log (0). */
export const errorLogMaxArchive = 99

/** `agent.errorLog`'s args: the checked logs by archive number (0 is Current), the date window in days and the message text, which the
 *  backend passes to xp_readerrorlog as its search argument. The backend checks them again (AgentErrorLogArgs.Check). */
export const agentErrorLogArgsSchema = z.object({
  logs: z.array(z.number().int().min(0).max(errorLogMaxArchive)).min(1).max(errorLogMaxArchive + 1).refine(logs => new Set(logs).size === logs.length, 'A log is checked once.'),
  days: z.number().int().min(1).max(historyMaxDays).optional(),
  text: z.string().min(1).max(agentLimits.searchChars).optional()
}).strict()
export type AgentErrorLogArgs = z.infer<typeof agentErrorLogArgsSchema>

/** The args the viewer's checked logs and its shared window and text filters send (undefined with no log checked: nothing is read). */
export function errorLogArgs(logs: readonly number[], filters: { readonly days?: number; readonly text: string }): AgentErrorLogArgs | undefined {
  if (!logs.length) return undefined
  const text = filters.text.trim().slice(0, agentLimits.searchChars)
  return { logs: [...logs].sort((a, b) => a - b), ...filters.days !== undefined ? { days: filters.days } : {}, ...text ? { text } : {} }
}

// --- agent.errorLogs ----------------------------------------------------------------------------------------------------

/** One SQL Server Agent error log: its archive number (0 is Current) and, where listed, its date (server time) and size. */
export interface AgentErrorLog { readonly archive: number; readonly date?: string; readonly bytes?: number }
export interface AgentErrorLogsRequest { readonly connectionId: string; readonly requestId: string }
/** The logs in archive order. `archives` is false where the server lists none (SQL Server on Linux): Current alone. */
export interface AgentErrorLogsResult {
  readonly logs: readonly AgentErrorLog[]; readonly archives: boolean; readonly elapsedMs: number
  readonly error?: { readonly code: ActionErrorCode; readonly message: string; readonly retryable: boolean }
}
export const agentErrorLogsSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid() }).strict() satisfies z.ZodType<AgentErrorLogsRequest>
const serverTime = z.string().max(19).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/)
export const agentErrorLogsResultSchema = z.object({
  logs: z.array(z.object({ archive: z.number().int().min(0).max(errorLogMaxArchive), date: serverTime.optional(), bytes: z.number().int().min(0).optional() }).strict()).max(errorLogMaxArchive + 1),
  archives: z.boolean(), elapsedMs: z.number().int().min(0),
  error: z.object({ code: z.enum(actionErrorCodes), message: z.string().max(actionLimits.messageChars), retryable: z.boolean() }).strict().optional()
}).strict() satisfies z.ZodType<AgentErrorLogsResult>

/** A log's name in Select logs, as SSMS names it: "Current - 2026-11-22 14:31", "Archive #1 - …" (the date in server time). */
export const errorLogName = (archive: number): string => archive === 0 ? 'Current' : `Archive #${archive}`
export const errorLogLabel = (log: AgentErrorLog): string => errorLogName(log.archive) + (log.date ? ` - ${log.date.slice(0, 16).replace('T', ' ')}` : '')

// --- Recycle -------------------------------------------------------------------------------------------------------------

export interface RecycleAgentErrorLogRequest {
  readonly action: 'recycleAgentErrorLog'; readonly connectionId: string; readonly requestId: string; readonly target: { readonly kind: 'agent'; readonly name?: undefined }
}
/** actions.execute's Recycle (no Script: SSMS's Recycle has none). */
export const recycleAgentErrorLogRequestSchema = z.object({
  action: z.literal('recycleAgentErrorLog'), connectionId: z.uuid(), requestId: z.uuid(), target: z.object({ kind: z.literal('agent') }).strict()
}).strict() satisfies z.ZodType<RecycleAgentErrorLogRequest>

export const recycleText = {
  title: 'Recycle SQL Server Agent Error Log',
  question: 'Close the current SQL Server Agent error log and start a new one? The current log becomes Archive #1 and the oldest archive is deleted.',
  done: 'Started a new SQL Server Agent error log; the previous one is now Archive #1.'
} as const

/** Why Recycle is not offered, or undefined when it is: sysadmin alone may run sp_cycle_agent_errorlog, and Managed Instance manages its log itself. */
export function recycleUnavailable(input: { readonly role: AgentRole; readonly live: boolean; readonly managedInstance?: boolean }): string | undefined {
  if (!input.live) return 'Connect to the server first.'
  if (input.managedInstance) return 'Azure SQL Managed Instance manages SQL Server Agent\'s error log itself: Recycle is not offered there.'
  if (input.role === 'unknown') return "Reading this login's SQL Server Agent role…"
  if (input.role !== 'sysadmin') return 'Only sysadmin can read and recycle the SQL Server Agent error log.'
  return undefined
}
/** Why the error logs are not listed in Select logs, or undefined when they are: xp_readerrorlog is sysadmin's alone, as SSMS shows the folder. */
export function errorLogsUnavailable(role: AgentRole): string | undefined {
  if (role === 'unknown') return "Reading this login's SQL Server Agent role…"
  return role === 'sysadmin' ? undefined : 'Only sysadmin can read the SQL Server Agent error log.'
}

// --- Commands ------------------------------------------------------------------------------------------------------------

export type ErrorLogCommandId = 'agent.viewAgentLog' | 'agent.recycleErrorLog'
export interface ErrorLogCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'output' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly title?: string; readonly mnemonic?: string; readonly when?: string }[]
}
const onErrorLogs = "((explorerNode == 'folder' && explorerFolder == 'agentErrorLogs') || explorerNode == 'agentErrorLog') && !explorerServerLost"
/**
 * The error logs' commands, behind the release gate (the renderer registers none without it): SSMS's Error Logs menu (View Agent Log,
 * Recycle, then Refresh, which every folder has), on the folder and on each log. View Agent Log opens the Log File Viewer with the log
 * checked (Current from the folder); Recycle opens it on Current with Recycle's confirmation, and from the palette acts on the active viewer.
 */
export function errorLogCommandEntries(): { readonly [K in ErrorLogCommandId]: ErrorLogCommandEntry } {
  return {
    'agent.viewAgentLog': {
      title: 'View Agent Log', category: 'SQL Server Agent', icon: 'output', keywords: ['agent', 'error', 'log', 'errorlog', 'view', 'viewer', 'current', 'archive'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 3, mnemonic: 'g', when: onErrorLogs }]
    },
    'agent.recycleErrorLog': {
      title: 'Recycle Agent Error Log…', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'error', 'log', 'errorlog', 'recycle', 'cycle', 'new', 'archive'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server as sysadmin first.',
      // Managed Instance manages its log itself: Recycle is offered on SQL Server (box) alone.
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 4, title: 'Recycle', mnemonic: 'y', when: `${onErrorLogs} && explorerServerEngine == 'box'` }]
    }
  }
}
