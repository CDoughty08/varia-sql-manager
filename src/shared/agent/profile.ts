// agent.profile: what this login may do with SQL Server Agent, read once per connection (docs/agent-plan.md › Permissions
// and how the UI degrades), and the Agent role the menus and the tree branch on (context keys `agentRole` and
// `explorerSelectionAgentRole`). The backend reads it in one constant batch run in msdb (Agent/AgentProfile.cs).
import { z } from 'zod'
import { explorerErrorCodes, type ExplorerError } from '../contracts'
import { agentPlatforms, type AgentPlatform } from './catalog.ts'

export interface AgentProfileRequest { readonly connectionId: string; readonly requestId: string }

/** One login's Agent facts on one server. A fact the login cannot read is false (or null for a server option), never a guess. */
export interface AgentProfile {
  /** Where the server runs, from its engine edition and path separator (`agentPlatform`). */
  readonly platform: AgentPlatform
  readonly engineEdition: number
  /** False when msdb refused the login (error 916, only where msdb's guest CONNECT was revoked): every role fact is then false. */
  readonly msdbAccess: boolean
  readonly sysadmin: boolean
  /** Membership of msdb's Agent roles (`IS_ROLEMEMBER`, nested membership included). False for sysadmin, who is dbo in msdb and so no role's member: `sysadmin` outranks them. */
  readonly userRole: boolean
  readonly readerRole: boolean
  readonly operatorRole: boolean
  /** EXECUTE on `msdb.dbo.sp_purge_jobhistory` (Delete History below Operator). */
  readonly purgeHistory: boolean
  /** `sys.dm_server_services` answers this login: VIEW SERVER STATE, or on SQL Server 2022 and later VIEW SERVER SECURITY STATE or VIEW SERVER PERFORMANCE STATE. */
  readonly serverServices: boolean
  /** `sys.dm_exec_sessions` shows other logins' sessions (Agent's): VIEW SERVER STATE, or on 2022 and later VIEW SERVER PERFORMANCE STATE. */
  readonly sessions: boolean
  readonly alterAnyCredential: boolean
  /** `SERVERPROPERTY('IsClustered')`: a failover cluster instance, whose cluster owns the Agent service. */
  readonly clustered: boolean
  /** `Agent XPs` in use (`sys.configurations` 16384, `value_in_use`); absent when unreadable (msdb refused the login). */
  readonly agentXps?: boolean
  /** `Database Mail XPs` in use (`sys.configurations` 16386); absent when unreadable. */
  readonly databaseMailXps?: boolean
  /** EXECUTE on `msdb.dbo.sysmail_help_profile_sp`: Database Mail's profiles can be read. */
  readonly databaseMail: boolean
}

export interface AgentProfileResult {
  readonly profile?: AgentProfile
  readonly elapsedMs: number
  /** NOT_SUPPORTED where the server has no Agent (Express, the cloud editions), else Object Explorer's codes. */
  readonly error?: ExplorerError
}

export const agentProfileSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid() }).strict() satisfies z.ZodType<AgentProfileRequest>
const fact = z.boolean()
/** The answer as main checks it before the renderer sees it (the backend is trusted; the shape is still pinned). */
export const agentProfileResultSchema = z.object({
  profile: z.object({
    platform: z.enum(agentPlatforms), engineEdition: z.number().int().min(0).max(255), msdbAccess: fact, sysadmin: fact, userRole: fact, readerRole: fact, operatorRole: fact,
    purgeHistory: fact, serverServices: fact, sessions: fact, alterAnyCredential: fact, clustered: fact, agentXps: fact.optional(), databaseMailXps: fact.optional(), databaseMail: fact
  }).strict().optional(),
  elapsedMs: z.number().int().min(0),
  error: z.object({ code: z.enum(explorerErrorCodes), message: z.string().max(512), retryable: z.boolean(), action: z.enum(['retry', 'refreshParent']).optional() }).strict().optional()
}).strict() satisfies z.ZodType<AgentProfileResult>

/**
 * The login's Agent role for menus and the tree, highest first. `unknown` until the profile is read (Properties and the
 * service verbs wait, with "Reading this login's Agent role…"), `profileFailed` when the read failed (Refresh retries it),
 * and `none` for a login with no Agent role, msdb refusing it included. '' in the context keys means "not an Agent node".
 */
export const agentRoleValues = ['sysadmin', 'operator', 'reader', 'user', 'none', 'unknown', 'profileFailed'] as const
export type AgentRole = typeof agentRoleValues[number]

/** A connection's profile as the renderer holds it. */
export type AgentProfileState =
  | { readonly status: 'unknown' }
  | { readonly status: 'ready'; readonly profile: AgentProfile }
  | { readonly status: 'failed'; readonly error: ExplorerError }

export function agentRoleOf(state: AgentProfileState | undefined): AgentRole {
  if (!state || state.status === 'unknown') return 'unknown'
  if (state.status === 'failed') return 'profileFailed'
  const { profile } = state
  if (profile.sysadmin) return 'sysadmin'
  if (!profile.msdbAccess) return 'none'
  return profile.operatorRole ? 'operator' : profile.readerRole ? 'reader' : profile.userRole ? 'user' : 'none'
}

/** The reason a verb waits on the role, or cannot be offered because the read failed; undefined once the role is known. */
export function agentRoleReason(state: AgentProfileState | undefined): string | undefined {
  if (!state || state.status === 'unknown') return 'Reading this login\'s Agent role…'
  if (state.status === 'failed') return `Could not read this login's Agent role: ${state.error.message} Refresh to retry.`
  return undefined
}
