import type { DocumentKind, SqlFile } from '../../shared/contracts'
import type { IconId } from '../../shared/icons'
import type { ProviderContext, ProviderId } from '../../shared/providers'
import { ssisDocumentKinds, ssisDocumentSpecs, type SsisDocumentKind } from '../../shared/ssis/catalog.ts'

export interface MultiDocumentTarget {
  readonly targetId?: string
  readonly connectionId?: string
  readonly database: string
  readonly enabled: boolean
  readonly provider: ProviderId
  readonly attachWanted?: boolean
  readonly lastServer?: string
}

export interface QueryDocument {
  readonly id: string
  readonly name: string
  readonly dirty: boolean
  readonly pinned?: boolean
  readonly savedVersionId: number | null
  readonly connectionId?: string
  /** Durable identity; a backend connectionId belongs only to its current process generation. */
  readonly targetId?: string
  /** False after query-only Disconnect; reconnecting the target must then leave this query disconnected. */
  readonly attachWanted?: boolean
  readonly database: string
  readonly includeActualPlan?: boolean
  readonly includeLivePlan?: boolean
  readonly includeClientStatistics?: boolean
  readonly file?: SqlFile
  /** The query's session ended without the user ending it (a Reconnect after the backend restarted, or a session found
   *  lost); its next execution says so before its own messages. */
  readonly sessionNotice?: SessionNotice
  /** Set while the user has renamed the tab (Rename Tab): the name it would show otherwise, its file's name once saved.
   *  `name` is then the user's name, which every prompt and Save As's suggested file name use. */
  readonly baseName?: string
  /** A legacy server hint only. It never establishes identity or authorizes reassociation. */
  readonly lastServer?: string
  /** Absent for a query; an XML, JSON or plan value opened from the results has no connection and never executes; a table
   *  designer, Database Properties, an SSIS Catalog object's properties and an Activity Monitor have no text at all. */
  readonly kind?: Exclude<WorkbenchDocumentKind, 'sql'>
  /** A query's engine, absent for SQL Server: its connection's, or the one it last had (a query keeps it when it
   *  disconnects, and hot exit and AutoRecover keep it). Its editor language follows it (`documentInfo`). */
  readonly provider?: ProviderId
  /** A BigQuery query's job key (docs/bigquery.md, Re-attaching to jobs): main records its jobs under it, and hot exit and
   *  AutoRecover keep it, so a restored tab re-attaches to them. Given at its first BigQuery execution. */
  readonly jobKey?: string
  /** Absent for single-server queries; 'same' for Same-Engine Multi-Server, 'cross' for Cross-Engine SELECT. */
  readonly multiMode?: 'same' | 'cross'
  /** Participating servers and databases/datasets for a multi-server or cross-engine query tab. */
  readonly multiTargets?: readonly MultiDocumentTarget[]
  /** Cross-Engine view mode: dual-dialect split editor ('split', default) or canonical single-file editor ('file'). */
  readonly crossView?: 'split' | 'file'
  /** Cross-Engine Split focused pane: 'primary' (Transact-SQL) or 'secondary' (GoogleSQL). */
  readonly activePane?: 'primary' | 'secondary'
}
/** What a tab holds: a shared DocumentKind (its text crosses IPC to be saved and kept by AutoRecover), or a table designer,
 *  Database Properties, New Database, an SSIS Catalog object's properties, an Activity Monitor, Integration Services Operations or Restore Database, which live only in the renderer. */
export type WorkbenchDocumentKind = DocumentKind | 'tableDesigner' | 'databaseProperties' | 'tableProperties' | 'newDatabase' | SsisDocumentKind | 'activityMonitor' | 'ssisOperations' | 'restoreDatabase' | 'objectSearch' | 'peek' | 'releaseNotes' | 'help' | 'agentJobActivity' | 'agentLogViewer' | 'bigQueryProperties' | 'bigQueryJobs' | 'agentJob' | 'agentAlert' | 'agentOperator' | 'agentOperators' | 'agentSchedules' | 'agentProxy' | 'credential' | 'agentOverview'
/** Documents whose content is not text in the editor: a provider saves and closes them (DocumentService.registerProvider). */
export type CustomDocumentKind = Exclude<WorkbenchDocumentKind, DocumentKind>

// Presentation projection; results are owned by ResultsService.
export type QueryTab = QueryDocument

/** Why a query's next execution opens a new session: the backend restarted, or its session was lost. */
export type SessionNotice = 'restarted' | 'lost'
export const documentKind = (document: Pick<QueryDocument, 'kind'> | undefined): WorkbenchDocumentKind => document?.kind ?? 'sql'
/** A query tab, as opposed to a value opened from the results: only queries connect, execute, and have results. */
export const isQueryDocument = (document: Pick<QueryDocument, 'kind'> | undefined): boolean => !!document && documentKind(document) === 'sql'
/** A query tab targeting multiple servers (Same-Engine Multi-Server or Cross-Engine SELECT). */
export const isMultiServerDocument = (document: Pick<QueryDocument, 'kind' | 'multiMode'> | undefined): boolean => isQueryDocument(document) && document?.multiMode !== undefined
/** A Cross-Engine SELECT query tab (SQL Server + BigQuery). */
export const isCrossEngineDocument = (document: Pick<QueryDocument, 'kind' | 'multiMode'> | undefined): boolean => isQueryDocument(document) && document?.multiMode === 'cross'
const customKinds: ReadonlySet<WorkbenchDocumentKind> = new Set<CustomDocumentKind>(['tableDesigner', 'databaseProperties', 'tableProperties', 'newDatabase', ...ssisDocumentKinds, 'activityMonitor', 'ssisOperations', 'restoreDatabase', 'objectSearch', 'peek', 'releaseNotes', 'help', 'agentJobActivity', 'agentLogViewer', 'bigQueryProperties', 'bigQueryJobs', 'agentJob', 'agentAlert', 'agentOperator', 'agentOperators', 'agentSchedules', 'agentProxy', 'credential', 'agentOverview'])
/** A kind whose provider owns its content (DocumentService.registerProvider): no text, no model, nothing AutoRecover keeps. */
export const isCustomKind = (kind: WorkbenchDocumentKind | undefined): kind is CustomDocumentKind => !!kind && customKinds.has(kind)
/** A document whose content is text in the editor (a query or a value), as opposed to a table designer, Database Properties,
 *  SSIS properties, an Activity Monitor or Integration Services Operations. */
export const isTextDocument = (document: Pick<QueryDocument, 'kind'> | undefined): boolean => !!document && !isCustomKind(documentKind(document))
type KindInfo = { readonly language: string; readonly icon: IconId; readonly label: string; readonly value: string; readonly blankName: string }
/**
 * Each kind's editor language, tab icon, the sentence that names it (the tab icon's name, the query context bar,
 * banners), what its value is called, and the file name a value of that kind gets when its column has none.
 */
export const kindInfo: Readonly<Record<WorkbenchDocumentKind, KindInfo>> = {
  sql: { language: 'sql', icon: 'database', label: 'Transact-SQL', value: 'SQL', blankName: 'SQL' },
  xml: { language: 'xml', icon: 'code', label: 'XML document', value: 'XML', blankName: 'XML' },
  json: { language: 'json', icon: 'json', label: 'JSON document', value: 'JSON', blankName: 'JSON' },
  sqlplan: { language: 'xml', icon: 'execution-plan', label: 'Execution plan', value: 'execution plan', blankName: 'PLAN' },
  tableDesigner: { language: '', icon: 'table', label: 'Table Designer', value: 'table', blankName: 'Table Designer' },
  databaseProperties: { language: '', icon: 'settings-gear', label: 'Database Properties', value: 'database properties', blankName: 'Database Properties' },
  tableProperties: { language: '', icon: 'settings-gear', label: 'Table Properties', value: 'table properties', blankName: 'Table Properties' },
  newDatabase: { language: '', icon: 'database', label: 'New Database', value: 'new database', blankName: 'New Database' },
  activityMonitor: { language: '', icon: 'pulse', label: 'Activity Monitor', value: 'activity monitor', blankName: 'Activity Monitor' },
  ssisOperations: { language: '', icon: 'pulse', label: 'Integration Services Operations', value: 'operations', blankName: 'Operations' },
  agentJobActivity: { language: '', icon: 'agent-activity', label: 'Job Activity Monitor', value: 'job activity', blankName: 'Job Activity Monitor' },
  agentJob: { language: '', icon: 'settings-gear', label: 'Job Properties', value: 'job', blankName: 'New Job' },
  agentAlert: { language: '', icon: 'bell', label: 'Alert Properties', value: 'alert', blankName: 'New Alert' },
  agentOperator: { language: '', icon: 'agent-operator', label: 'Operator Properties', value: 'operator', blankName: 'New Operator' },
  agentOperators: { language: '', icon: 'agent-operator', label: 'Operators and Notifications', value: 'notifications', blankName: 'Operators and Notifications' },
  agentSchedules: { language: '', icon: 'agent-schedule', label: 'Schedules', value: 'schedules', blankName: 'Schedules' },
  agentProxy: { language: '', icon: 'agent-proxy', label: 'Proxy Account Properties', value: 'proxy', blankName: 'New Proxy' },
  credential: { language: '', icon: 'key', label: 'Credential Properties', value: 'credential', blankName: 'New Credential' },
  agentLogViewer: { language: '', icon: 'history', label: 'Log File Viewer', value: 'job history', blankName: 'Log File Viewer' },
  agentOverview: { language: '', icon: 'agent', label: 'SQL Server Agent Overview', value: 'agent overview', blankName: 'Agent Overview' },
  restoreDatabase: { language: '', icon: 'history', label: 'Restore Database', value: 'restore', blankName: 'Restore Database' },
  objectSearch: { language: '', icon: 'search', label: 'Search Objects', value: 'search', blankName: 'Search Objects' },
  peek: { language: '', icon: 'eye', label: 'Peek', value: 'peek', blankName: 'Peek' },
  bigQueryProperties: { language: '', icon: 'info', label: 'BigQuery Properties', value: 'properties', blankName: 'Properties' },
  bigQueryJobs: { language: '', icon: 'history', label: 'BigQuery Job History', value: 'job history', blankName: 'Job History' },
  help: { language: '', icon: 'info', label: 'Getting Started', value: 'guide', blankName: 'Getting Started' },
  releaseNotes: { language: '', icon: 'info', label: 'Release Notes', value: 'release notes', blankName: 'Release Notes' },
  ...Object.fromEntries((Object.keys(ssisDocumentSpecs) as SsisDocumentKind[]).map(kind => [kind, { language: '', icon: ssisDocumentSpecs[kind].icon, label: ssisDocumentSpecs[kind].title, value: ssisDocumentSpecs[kind].noun, blankName: ssisDocumentSpecs[kind].title }])) as Record<SsisDocumentKind, KindInfo>
}

/** Each engine's query language in Monaco: Transact-SQL is Monaco's `sql`, GoogleSQL Varia's own (languages/googlesql.ts). */
export const queryLanguages: Readonly<Record<ProviderId, string>> = { sqlserver: 'sql', bigquery: 'googlesql' }
const googleSqlInfo: KindInfo = { ...kindInfo.sql, language: queryLanguages.bigquery, label: 'GoogleSQL' }
/** The active document's engine: a query's (SQL Server unless it says otherwise; Cross-Engine Split follows activePane), BigQuery for Job History, SQL Server for every
 *  other tab, '' with none open. */
export const documentProvider = (document: Pick<QueryDocument, 'kind' | 'provider' | 'multiMode' | 'crossView' | 'activePane'> | undefined): ProviderContext =>
  !document ? '' : isQueryDocument(document)
    ? document.multiMode === 'cross' && document.crossView !== 'file'
      ? document.activePane === 'secondary' ? 'bigquery' : 'sqlserver'
      : document.provider ?? 'sqlserver'
    : document.kind === 'bigQueryJobs' ? 'bigquery' : 'sqlserver'
/** `kindInfo` for a document: a BigQuery query is GoogleSQL, in its language, where every other query is Transact-SQL. */
export function documentInfo(document: Pick<QueryDocument, 'kind' | 'provider' | 'multiMode' | 'crossView' | 'activePane'>): KindInfo {
  return isQueryDocument(document) && documentProvider(document) === 'bigquery' ? googleSqlInfo : kindInfo[documentKind(document)]
}

export function afterClose<T extends { id: string }>(tabs: readonly T[], activeId: string, closingId: string): { tabs: T[]; activeId: string } {
  const index = tabs.findIndex(tab => tab.id === closingId)
  const remaining = tabs.filter(tab => tab.id !== closingId)
  return { tabs: remaining, activeId: activeId === closingId ? remaining[Math.min(index, remaining.length - 1)]?.id ?? '' : activeId }
}
