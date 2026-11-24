// SQL Server Agent's live Object Explorer node (AG-12, docs/sql-server-agent.md › Object Explorer): what the `agent.tree`
// change source's one probe fingerprints, what Object Explorer reloads when a value changes, and how a job row's live
// state chips are read from the `agent.jobs` list. The backend builds the probe's text (Live/LiveSql.AgentTree.cs, which
// mirrors `agentTreeFingerprints` and the checks compare); the renderer (src/renderer/src/agent/AgentTreeLive.ts) decides
// only what to reload and what a row shows. Erasable TypeScript, so Node's type stripping can load it too.
import type { FolderId } from '../explorer/catalog.ts'

export const agentTreeSource = 'agent.tree' as const
export const agentTreeProbe = 'agent.treeProbe' as const

/**
 * One msdb table the tree shows, sent as two status values, `<id>Count` (its rows the login may read) and `<id>Checksum` (a
 * checksum of the columns the tree shows), and the folders Object Explorer reloads when either changes. A table the login may
 * not read reads 0 and 0 (the Proxies folder is sysadmin only, Alerts and Operators SQLAgentOperatorRole and above).
 */
export interface AgentTreeFingerprint {
  readonly id: string
  readonly table: string
  readonly folders: readonly FolderId[]
}
export const agentTreeFingerprints: readonly AgentTreeFingerprint[] = [
  // A job row shows its name, enabled state, owner, description and creation date.
  { id: 'jobs', table: 'msdb.dbo.sysjobs_view', folders: ['agentJobs'] },
  { id: 'alerts', table: 'msdb.dbo.sysalerts', folders: ['agentAlerts'] },
  { id: 'operators', table: 'msdb.dbo.sysoperators', folders: ['agentOperators'] },
  { id: 'proxies', table: 'msdb.dbo.sysproxies', folders: ['agentProxies', 'agentUnassignedProxies'] },
  // Which subsystems a proxy is assigned to: the subsystem rows' proxy counts and the proxies listed below each.
  { id: 'assignments', table: 'msdb.dbo.sysproxysubsystem', folders: ['agentProxies', 'agentUnassignedProxies'] }
]
/**
 * The values that re-list the SQL Server Agent node itself (its folders): Agent XPs, which decides whether it lists any, and
 * the service's state (absent where the login may not read it, as `explorer.agentService` reads it).
 */
export const agentTreeStateValues = ['agentXps', 'serviceState'] as const
/** The status values of `agent.treeProbe`, in order: the node's state values, then each fingerprint's count and checksum. */
export const agentTreeStatus: readonly string[] = [...agentTreeStateValues, ...agentTreeFingerprints.flatMap(fingerprint => [fingerprint.id + 'Count', fingerprint.id + 'Checksum'])]

/** A tree view that ended for now (no room for it on the server or in the window, the backend restarted it) opens again after
 *  `first` ms, doubling to `max` while it keeps ending before a sample, as the SSIS Catalog's does. */
export const agentTreeRetryMs = { first: 2_000, max: 60_000 } as const
/** Why a live view of the Agent node ends for good, which no retry fixes: the login's access or sign-in, a request refused
 *  as malformed, or a workbench that closed. The user's Refresh of the node or above tries again. */
export const agentTreeFinalCodes = ['PERMISSION_DENIED', 'LOGIN_FAILED', 'NOT_SUPPORTED', 'INVALID_PARAMS', 'PORT_CLOSED'] as const

/** What changed between two samples: whether the Agent node re-lists, and the folders below it that reload. */
export interface AgentTreeChange { readonly node: boolean; readonly folders: readonly FolderId[] }
/**
 * What two `agent.treeProbe` samples (status id → value) say to reload: the node when Agent XPs or the service state
 * changed (a value that comes or goes counts), and the folders of every fingerprint whose count or checksum changed, each once.
 */
export function agentTreeChange(previous: ReadonlyMap<string, number | string>, next: ReadonlyMap<string, number | string>): AgentTreeChange {
  const node = agentTreeStateValues.some(id => previous.get(id) !== next.get(id))
  const folders = new Set<FolderId>()
  for (const fingerprint of agentTreeFingerprints)
    if ([fingerprint.id + 'Count', fingerprint.id + 'Checksum'].some(id => previous.get(id) !== next.get(id))) for (const folder of fingerprint.folders) folders.add(folder)
  return { node, folders: [...folders] }
}
/** Every folder the probe covers, for a sample that arrives with no baseline to compare with. */
export const agentTreeFolders: readonly FolderId[] = [...new Set(agentTreeFingerprints.flatMap(fingerprint => fingerprint.folders))]
