import type { LayoutLoad, LayoutState, WorkspaceLayout } from './layouts'
import type { EstimatedPlanRequest, EstimatedPlanResult } from './estimated-plans'
import type { ConnectContext, ConnectionEnvironmentInput, ConnectionLibraryView, ConnectionProfileInput, SecretStorageState } from './connections'
import type { ResolvedTheme, ThemePreferencePatch, ThemePreview, ThemeState } from './theme/types'
import type { CommandId, RendererRole } from './commands/catalog'
import type { ContextMenuCommand, ContextMenuRequest, MenuState } from './commands/menus'
import type { MenuStyle } from './menu-style'
import type { ErrorCode, ErrorReason } from './ipc/wire/protocol'
import type { AuthenticationMode } from './auth'
import type { ExplorerChildrenParams, ExplorerNodeRef } from './explorer/refs.ts'
import type { ObjectIndexParams, ObjectIndexProgress, ObjectIndexResult, ObjectSearchParams, ObjectSearchResult } from './explorer/search.ts'
import type { ExplorerIcon, NodeStatus, NodeSubtype } from './explorer/catalog.ts'
import type { PeekDependenciesParams, PeekDependenciesResult, PeekParams, PeekResult } from './explorer/peek.ts'
import type { DatabaseRuntime } from './explorer/status.ts'
import type { ActionPromptAnswer, ActionPromptRequest } from './actions/prompts.ts'
import type { LongRunState } from './long-runs.ts'
import type { ScriptRequest, ScriptResult } from './scripting/schema.ts'
import type { ActionDescribeRequest, ActionDescribeResult, ActionExecuteRequest, ActionExecuteResult, ActionProgress, ActionScriptRequest, ActionScriptResult } from './actions/schema.ts'
import type { SsisCatalogSetupRequest, SsisCatalogSetupResult, SsisDescribeRequest, SsisDescribeResult, SsisExecuteRequest, SsisExecuteResult } from './ssis/schema.ts'
import type { SettingsLoad, SettingsPatch, SettingsState } from './settings/schema'
import type { SessionAnswer, SessionEnd, SessionPromptRequest } from './sessions.ts'
import type { RecentFile } from './files/recent'
import type { UpdateState } from './updates'
import type { RecoveredDocument, RecoveryEntry, RecoveryWrite } from './files/recovery'
import type { ReloadPins, RestoredSession, SessionWrite } from './files/session'
import type { LiveEnd, LiveSubscribeParams, LiveUpdateParams, LiveUpdateResult } from './live/schema'
import type { ActivityDetailsRequest, ActivityDetailsResult, ActivityKillRequest, ActivityKillResult } from './activity/schema.ts'
import type { PlanDocument } from './plans'
import type { ShortcutFile } from './commands/shortcut-schema'
import type { DatabaseProviderId, LanguageRequest, LanguageCompletions, LanguageHover, LanguageStatus, LanguageRefreshRequest, LanguageRefreshResult } from './language-service'

export interface AdvancedConnectionOptions {
  commandTimeout: number
  connectTimeout: number
  columnEncryption: boolean
  secureEnclaves: boolean
  attestationProtocol: 'None' | 'HGS' | 'AAS'
  enclaveAttestationUrl: string
  multipleActiveResultSets: boolean
  networkProtocol: 'default' | 'tcp' | 'np' | 'lpc'
  packetSize: number
  transactionBinding: 'Implicit Unbind' | 'Explicit Unbind'
  typeSystemVersion: 'Latest' | 'SQL Server 2008' | 'SQL Server 2005' | 'SQL Server 2000'
  connectRetryCount: number
  connectRetryInterval: number
  applicationName: string
  workstationId: string
  applicationIntent: 'ReadWrite' | 'ReadOnly'
  currentLanguage: string
  replication: boolean
  ipAddressPreference: 'IPv4First' | 'IPv6First' | 'UsePlatformDefault'
  serverCertificate: string
  attachDbFilename: string
  failoverPartner: string
  failoverPartnerSpn: string
  multiSubnetFailover: boolean
  serverSpn: string
  userInstance: boolean
}

export interface ConnectionOptions {
  server: string
  database: string
  /** src/shared/auth.ts lists the types and what each needs. */
  authentication: AuthenticationMode
  username?: string
  password?: string
  trustServerCertificate: boolean
  encrypt?: 'optional' | 'mandatory' | 'strict'
  hostNameInCertificate?: string
  displayName?: string
  color?: string
  /** None when absent; a preset (Production, Staging, Test, Development) or a custom label of 1–32 characters (src/shared/environments.ts). */
  environment?: string
  advanced?: Partial<AdvancedConnectionOptions>
}

/**
 * `generation` is the backend generation that holds the connection (stamped by main); a later generation cannot use it.
 * `productVersion` (≤ 32 characters), `login` (≤ 128), `engineEdition` and `linux` (SQL Server on Linux) come from the
 * server profile probed at connect, and are absent when the probe failed.
 */
export interface ConnectionInfo {
  /** Older SQL Server connections omit this. Language features default those connections to sqlserver. */
  providerId?: DatabaseProviderId
  id: string; server: string; database: string; serverVersion: string; displayName?: string; color?: string; commandTimeout?: number; historyWarning?: string; generation: number
  /** Set by main: the saved entry's environment label, which a connect without one kept. */
  environment?: string
  productVersion?: string; login?: string; engineEdition?: number; linux?: boolean
}
export interface DiscoveredServer { server: string; version: string; source: 'local' | 'network' }
export interface DatabaseInfo { name: string; isSystem: boolean; isSnapshot: boolean }
/** A table's columns in order; `truncated` means it has more than the 4,096 returned. */
export interface TableColumns { columns: { name: string; dataType: string }[]; truncated: boolean }
export interface BackendHealth {
  protocolVersion: number
  runtime: string
  platform: string
  smoVersion: string
  sqlClientVersion: string
}
export interface QueryOptions {
  connectionId: string
  sessionId: string
  database: string
  sql: string
  queryId: string
  /** Rows stored across the script's result sets, 0..2,147,483,647; 0 stores up to the memory budget only. */
  maxRows: number
  timeoutSeconds: number
  startLine?: number
  /** Result sets kept per script, 1..1000 (default 10); later ones are counted, not stored. */
  maxResultSets?: number
  /** Stop at the first batch that raises an error (SQLCMD's `:on error exit`). By default the next GO batch still runs, as in SSMS. */
  stopOnError?: boolean
  /** Collect actual execution plans for the statements that run. */
  includeActualPlan?: boolean
  includeLivePlan?: boolean
  includeClientStatistics?: boolean
}
/** `text` cells carry their SSMS display text; `binary` cells are shown as 0x plus hexadecimal. */
export type WireKind = 'text' | 'binary'
export interface ResultColumn {
  name: string
  dataType: string
  wire: WireKind
  /** `tone`: a live table's row tone (src/shared/live/catalog.ts), hidden by the grid and left out of Copy and Save. */
  role?: 'xml' | 'json' | 'plan' | 'udt' | 'vector' | 'tone'
  maxLength?: number
  precision?: number
  scale?: number
  nullable: boolean
  /** char, varchar, text, nchar, nvarchar and ntext: the collation SqlClient read from the result's metadata, when it could. */
  collation?: ResultCollation
}
/**
 * A character column's collation (docs/ipc.md, Cell lengths): its Windows locale id, SQL sort id (non-zero for SQL_
 * collations), the code page char and varchar values use (0 for a _UTF8 collation), whether it is a _UTF8 collation, and
 * its comparison flags as SqlCompareOptions bits: IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16,
 * BinarySort2 16384, BinarySort 32768.
 */
export interface ResultCollation { lcid: number; sortId: number; codePage: number; utf8: boolean; options: number }
/** Why a result stopped storing rows: execution always continues. */
export type TruncationReason = 'rowLimit' | 'queryBudget' | 'globalBudget' | 'systemMemory'
/**
 * A result set kept in the backend's memory. Rows are read in pages through the results port; `rowsAvailable` counts the
 * rows in sealed pages, which is what can be read now. A result belongs to one backend generation.
 */
export interface ResultDescriptor {
  generation: number
  resultId: number
  index: number
  batchNumber: number
  iteration: number
  kind: 'rows' | 'executionPlan'
  columns: ResultColumn[]
  rowsRead: number
  rowsStored: number
  rowsAvailable: number
  bytesStored: number
  truncatedCells: number
  state: 'open' | 'complete' | 'released'
  truncated?: TruncationReason
  incomplete: boolean
}
/**
 * One line of the Messages tab: SQL errors, cancellation and timeout are `error` entries (red, in order); what the script
 * printed (PRINT, RAISERROR with severity 10 or less) is `print`, which opens the Messages strip under the results; SQL
 * Server's other informational messages (warnings such as 8153, SET STATISTICS output, DBCC) are `server`, which show in the
 * strip without opening it; Varia's own lines (row counts, notes) are `info`.
 */
export interface MessageEntry { text: string; kind: 'info' | 'server' | 'print' | 'error' }
export type QueryStatus = 'completed' | 'completedWithErrors' | 'failed' | 'cancelled' | 'timedOut'
/** The query.execute summary: the rows stay in the backend (ResultClient reads them). `completedAt` is the backend's
 *  local time with 7 fractional digits, for SSMS's "Completion time:" line. */
export interface QueryResult {
  resultSets: ResultDescriptor[]
  /** Toolbar-captured plans are kept separately from the data grids. */
  planSets?: ResultDescriptor[]
  /** Result IDs with a known order across toolbar and SQL-returned plans. */
  planOrder?: number[]
  discardedResultSets: number
  messages: MessageEntry[]
  recordsAffected: number
  elapsedMs: number
  /** `completedWithErrors`: every batch ran and at least one raised an error (`error` names the first such batch).
   *  `failed`: an error stopped execution (before the first batch, with `stopOnError`, or by closing the session). */
  status: QueryStatus
  error?: { code: string; message: string; batchNumber: number; iteration: number }
  completedBatches: number
  totalBatches: number
  database: string
  messagesTruncated: boolean
  budget: { usedBytes: number; globalBytes: number; queryBytes: number } & MemoryOrder
  completedAt: string
  /** The session's SPID and login (SUSER_SNAME(), ≤ 128 characters), read once when it opened; both are present while it
   *  is still open after the script. Its open transaction is read only when it is about to end (`query.session.state`). */
  spid?: number
  login?: string
  /** Per-script provider counters. Absent unless requested; separate from elapsedMs and rendering. */
  clientStatistics?: import('./client-statistics').ClientStatisticsSample
}
/** An idle session's open transaction as `query.session.state` read it: `checked` is false when its SET options (SHOWPLAN_*,
 *  NOEXEC, PARSEONLY or FMTONLY ON) kept the SELECT from returning @@TRANCOUNT, so it may hold one. */
export interface SessionState { transactionCount: number; checked: boolean }
/** Orders each feature's memory reports. Results events and summaries share a sequence within a backend generation. */
export interface MemoryOrder { generation: number; seq: number }
/** Rows read so far for one result set of a running script. */
export interface ResultProgress { resultId: number; rowsRead: number; rowsStored: number; rowsAvailable: number; bytesStored: number }
/** Pushed while a script runs (EVENT frames, then the results port). The summary is authoritative once it arrives. */
export type QueryEvent =
  | { type: 'session.opened'; spid: number; login?: string }
  | { type: 'resultSet.opened'; descriptor: ResultDescriptor }
  | { type: 'resultSet.closed'; descriptor: ResultDescriptor }
  | { type: 'progress'; completedBatches: number; totalBatches: number; batchNumber: number; iteration: number; results: ResultProgress[] }
  | { type: 'messages'; messages: MessageEntry[] }
/** `viewId` reads through a view of the result (results.view); `firstRow` then counts view positions. */
export interface ResultsReadParams { resultId: number; firstRow: number; maxRows: number; viewId?: number }
/** `nextRow` follows the last row sent; `complete` means no rows remain to be read. */
export interface ResultsReadResult { nextRow: number; rowsAvailable: number; complete: boolean; pages: number; rows: number }
export interface ResultsCloseResult { closed: number; usedBytes: number }
/** Up to `limits.rowSizes.maxRows` rows' byte sizes from `firstRow`. */
export interface ResultsRowBytesParams { resultId: number; firstRow: number; count: number; viewId?: number }
/** How a sort key compares a column: by value (its SQL type and collation, NULL lowest), or, for text and binary
 *  columns, by each cell's characters or bytes (other columns sort by value). */
export type ViewSortMode = 'value' | 'chars' | 'bytes'
export interface ViewSortKey { column: number; descending: boolean; mode: ViewSortMode }
/** results.view: 1 to `limits.views.maxKeys` keys on distinct columns; `replaces` names a view of the same result that
 *  this one supersedes. */
export interface ResultsViewParams { resultId: number; sort: ViewSortKey[]; replaces?: number }
/** `rows` is the view's row count (the rows sealed when it was built), `complete` that they were all the result's rows,
 *  `approximate` that a key compared a truncated value's stored prefix or an estimated length. */
export interface ResultsViewResult { viewId: number; rows: number; complete: boolean; approximate: boolean }
export interface ResultsViewCloseParams { resultId: number; viewIds: number[] }
export interface ResultsViewCloseResult { closed: number }
/** results.profile: up to `limits.profile.maxColumns` distinct columns of a result, through its view when `viewId` is
 *  given; no columns answers only the rows' byte sizes. */
export interface ResultsProfileParams { resultId: number; columns: number[]; viewId?: number }
/** Lowest, highest and average of a length (characters, DATALENGTH or a row's bytes); `exact` is false when an estimate
 *  took part. */
export interface ProfileLengths { min: number; max: number; average: number; exact: boolean }
/** What a histogram buckets: values (numbers), instants (date and time types, in .NET ticks), characters (text) or bytes
 *  (binary). */
export type ProfileBasis = 'value' | 'time' | 'chars' | 'bytes'
/** `limits.profile.bins` equal buckets from `low` to `high`, both included. */
export interface ProfileHistogram { basis: ProfileBasis; low: number; high: number; counts: number[] }
/** One column's aggregates: `values` non-NULL cells, `nulls` the rest; `distinct` by the column's collation, an estimate
 *  when `distinctExact` is false; `min` and `max` as display text (binary as 0x hex, at most `limits.profile.valueChars`
 *  characters and "…"; absent without values); `approximate` when a truncated cell's stored prefix took part. `chars` and
 *  `bytes` only for text and binary columns, `histogram` only for columns with something to bucket. */
export interface ColumnProfile {
  column: number; values: number; nulls: number; distinct: number; distinctExact: boolean; min?: string; max?: string; approximate: boolean
  chars?: ProfileLengths; bytes?: ProfileLengths; histogram?: ProfileHistogram
}
/** `rows` profiled (the view's, or the rows sealed when it ran) and whether that was all of them; the rows' byte sizes
 *  (absent without rows); the columns asked for, in order. */
export interface ResultsProfileResult { rows: number; complete: boolean; rowBytes?: ProfileLengths; columns: ColumnProfile[] }
/** `bytes[k]` is row `firstRow + k`'s sum of DATALENGTH over its cells (NULL counts 0; xml and json as their
 *  text, some sql_variant base types estimated: docs/ipc.md, Cell lengths and row sizes); it stops at the rows sealed so
 *  far (`rowsAvailable`), as results.read does. */
export interface ResultsRowBytesResult { firstRow: number; bytes: number[]; rowsAvailable: number; /** Rows, in order, whose sum includes an estimate. */ estimated: number[] }
/** Inclusive row indexes; a last row of 2^53 − 1 runs to the end of the result. */
export type RowRange = readonly [first: number, last: number]
/** Inclusive column indexes, 0..4095. */
export type ColumnRange = readonly [first: number, last: number]
/** One rectangle-like piece of a copy: 1..64 ascending, disjoint row ranges by 1..64 column ranges. */
export interface CopyPart { rows: readonly RowRange[]; columns: readonly ColumnRange[] }
/** The backend's descriptor, before main stamps its generation. */
export type BackendResultDescriptor = Omit<ResultDescriptor, 'generation'>
/** Save Results As formats: CSV, tab-delimited text (.txt, .tsv, .tab) and JSON. */
export type ResultsFormat = 'csv' | 'tsv' | 'json'
/** Copy a grid selection: main runs results.copy and writes the text to the clipboard. `jobId` names the job for
 *  cancellation and progress. */
/** `viewId` copies through a sorted view (results.view): rows are then view positions. */
export interface ResultsCopyRequest { jobId: string; generation: number; resultId: number; headers: boolean; parts: readonly CopyPart[]; viewId?: number }
/** Save Results As: main shows the save dialog (the renderer never supplies a path) and runs results.export. */
export interface ResultsSaveRequest { jobId: string; generation: number; resultId: number; format?: ResultsFormat; suggestedName: string; viewId?: number }
/** `partial`: the set was still open, so open-ended selections ended at the rows stored then. */
export interface ResultsJobResult { rows: number; bytes: number; truncatedCells: number; partial: boolean }
/** Only the file's name returns to the renderer, never its path. */
export interface SavedResults extends ResultsJobResult { fileName: string; format: ResultsFormat }
/** Pushed on `varia:results-job` at most 4 times a second per job. A save reports once as soon as its file is chosen;
 *  its reports carry the file's name (never its path). */
export interface ResultsJobProgress { jobId: string; kind: 'copy' | 'save'; rowsDone: number; rowsTotal: number; bytes: number; fileName?: string }
export interface ResultsCopyParams { resultId: number; parts: readonly CopyPart[]; headers: boolean; eol: 'crlf' | 'lf'; maxBytes: number; viewId?: number }
/** `temporaryId` (32 hex digits) names the file written beside the target, `.varia-{temporaryId}.tmp`, which main removes
 *  if the backend dies before it does. */
export interface ResultsExportParams { resultId: number; path: string; format: ResultsFormat; headers: boolean; nullText: 'empty' | 'NULL'; temporaryId: string; viewId?: number }
/** One Object Explorer node. Labels are SSMS's text (≤ 300), sublabels the "(…)" part (≤ 200), detail tooltip-only facts
 *  (≤ 512); `created` is server local time, `yyyy-MM-ddTHH:mm:ss`; `database`, a database node's runtime state as listed;
 *  `connectDenied`, a login denied CONNECT SQL (its status says `disabled` when it is disabled too). */
export interface ExplorerNode {
  readonly ref: ExplorerNodeRef
  readonly label: string
  readonly icon: ExplorerIcon
  readonly hasChildren: boolean
  readonly sublabel?: string
  readonly detail?: string
  readonly subtype?: NodeSubtype
  readonly status?: NodeStatus
  readonly created?: string
  readonly database?: DatabaseRuntime
  readonly connectDenied?: boolean
}
// AUTH_KERBEROS and AUTH_UNSUPPORTED: a pool connection off Windows could not sign in with Kerberos (an expired ticket: run kinit, then Retry).
// AUTH_ENTRA: a pool connection's Microsoft Entra sign-in expired or was revoked (connect again to sign in).
// NOT_SUPPORTED: the server cannot have what the folder lists (the SSIS Catalog on SQL Server on Linux); the row says why.
export const explorerErrorCodes = ['PERMISSION_DENIED', 'NO_DB_ACCESS', 'DATABASE_UNAVAILABLE', 'NOT_FOUND', 'BLOCKED', 'TIMEOUT', 'CONNECTION_LOST', 'SQL_ERROR', 'AUTH_KERBEROS', 'AUTH_UNSUPPORTED', 'AUTH_ENTRA', 'NOT_SUPPORTED'] as const
export type ExplorerErrorCode = typeof explorerErrorCodes[number]
/** A catalog failure, returned as a value so the tree can branch on its code; `refreshParent` means the node itself is gone. */
export interface ExplorerError { readonly code: ExplorerErrorCode; readonly message: string; readonly retryable: boolean; readonly action?: 'retry' | 'refreshParent' }
/**
 * A page of children: on the first page the static folders, then rows. `cursor` asks for the next page, even after a page
 * that came back short or empty (Tables reads candidate keys, some of which another folder lists); `total` (first page
 * only) counts static folders, rows and a Parameters folder's return row. With `error`, `nodes` holds at most the static
 * folders that did not need the failed query.
 */
export interface ExplorerChildrenResult {
  readonly nodes: readonly ExplorerNode[]
  readonly elapsedMs: number
  readonly cursor?: string
  readonly total?: number
  readonly error?: ExplorerError
}
/** The Kerberos principal (such as alice@CONTOSO.COM, at most 256 characters) that integrated authentication would use off
 *  Windows, while the default credential cache holds a valid ticket; absent on Windows and without a ticket or GSSAPI. */
export interface IntegratedIdentity { principal?: string }
export interface RpcMethods {
  'language.status': { params: Record<string, never>; result: LanguageStatus }
  'language.complete': { params: LanguageRequest; result: LanguageCompletions }
  'language.hover': { params: LanguageRequest; result: LanguageHover }
  'language.refresh': { params: LanguageRefreshRequest; result: LanguageRefreshResult }
  'language.close': { params: { documentId: string }; result: { closed: boolean } }
  'plans.parse': { params: { xml: string }; result: PlanDocument }
  'plans.estimate': { params: EstimatedPlanRequest; result: EstimatedPlanResult }
  'system.health': { params: Record<string, never>; result: BackendHealth }
  'connections.connect': { params: ConnectionOptions; result: ConnectionInfo }
  'connections.databases': { params: ConnectionOptions; result: DatabaseInfo[] }
  'connections.discover': { params: { scope: 'local' | 'network' }; result: { servers: DiscoveredServer[]; warning?: string } }
  'connections.preview': { params: ConnectionOptions; result: { connectionString: string } }
  'connections.disconnect': { params: { connectionId: string }; result: { disconnected: boolean } }
  'connections.identity': { params: Record<string, never>; result: IntegratedIdentity }
  'databases.list': { params: { connectionId: string }; result: DatabaseInfo[] }
  'tables.columns': { params: { connectionId: string; database: string; schema: string; name: string }; result: TableColumns }
  'query.execute': { params: QueryOptions; result: QueryResult }
  'query.cancel': { params: { queryId: string }; result: { cancelled: boolean } }
  /** `transaction` ends the session's open transaction first; a failed commit leaves the session open. */
  'query.session.close': { params: { sessionId: string; transaction?: SessionEnd }; result: { closed: boolean } }
  /** An idle session's @@TRANCOUNT, read before it ends; see SessionState. */
  'query.session.state': { params: { sessionId: string }; result: SessionState }
  'explorer.children': { params: ExplorerChildrenParams; result: ExplorerChildrenResult }
  /** (Re)builds the connection's object index in backend memory; progress EVENTs, and Stop is varia:explorer-cancel. */
  'explorer.index': { params: ObjectIndexParams; result: ObjectIndexResult }
  /** Searches the connection's object index (names and module definitions), in backend memory. */
  'explorer.search': { params: ObjectSearchParams; result: ObjectSearchResult }
  /** Peek: a table's, view's or module's properties (and a module's text), on the Object Explorer pool; Stop is varia:explorer-cancel. */
  'explorer.peek': { params: PeekParams; result: PeekResult }
  /** Peek's Dependencies: what the object uses and what uses it (sys.sql_expression_dependencies and foreign keys), read apart from the facts when the tab is chosen, on Peek's slot; Stop is varia:explorer-cancel. */
  'explorer.peekDependencies': { params: PeekDependenciesParams; result: PeekDependenciesResult }
  'scripting.script': { params: ScriptRequest; result: ScriptResult }
  /** What an object dialog shows (Delete Object's row and warnings), read in the action's own connection. */
  'actions.describe': { params: ActionDescribeRequest; result: ActionDescribeResult }
  /** An action's script, for the dialog's Script button; it runs nothing. */
  'actions.script': { params: ActionScriptRequest; result: ActionScriptResult }
  /** Runs an action's DDL after a preflight; never re-sent, and only Stop (varia:actions-cancel) ends a lock wait. */
  'actions.execute': { params: ActionExecuteRequest; result: ActionExecuteResult }
  /** What an SSIS Catalog object is (a properties document's read), on the SSIS read pool; Stop is varia:ssis-cancel. */
  'ssis.describe': { params: SsisDescribeRequest; result: SsisDescribeResult }
  /** Changes the SSIS Catalog (Stop Operation, Create Catalog) on its own unpooled connection after a preflight; never re-sent,
   *  and only Stop (varia:ssis-cancel) ends a lock wait. Sensitive: its frame is zeroed once written. */
  'ssis.execute': { params: SsisExecuteRequest; result: SsisExecuteResult }
  /** What Create Catalog would do on the server (its dialog's read), on the SSIS read pool; it changes nothing. */
  'ssis.catalogSetup': { params: SsisCatalogSetupRequest; result: SsisCatalogSetupResult }
  /** One session's Details flyout, read on the Activity Monitor's pool under the live gates; closing it cancels the read (varia:activity-cancel). */
  'activity.details': { params: ActivityDetailsRequest; result: ActivityDetailsResult }
  /** Kill Process: each session's identity is checked and KILL runs in one guarded batch on the object actions' own connection; never re-sent. */
  'activity.kill': { params: ActivityKillRequest; result: ActivityKillResult }
}
export type RpcMethod = keyof RpcMethods
/** Methods the renderer reaches only through the results port (validated by portRequestSchema, never by invoke). */
export interface PortMethods {
  'results.read': { params: ResultsReadParams; result: ResultsReadResult }
  'results.close': { params: { resultIds: number[] }; result: ResultsCloseResult }
  /** Each row's bytes for a range of a stored result, from the lengths the backend recorded as it read the rows. */
  'results.rowBytes': { params: ResultsRowBytesParams; result: ResultsRowBytesResult }
  'results.view': { params: ResultsViewParams; result: ResultsViewResult }
  'results.viewClose': { params: ResultsViewCloseParams; result: ResultsViewCloseResult }
  /** Aggregates over a result's rows or a view's, for the column profile panel: never rows. */
  'results.profile': { params: ResultsProfileParams; result: ResultsProfileResult }
  /** A live subscription (docs/ipc.md): its EVENTs are credited, one unacknowledged at a time, and it ends only by CANCEL,
   *  a disconnect, a backend shutdown, a failure or its source ending. */
  'live.subscribe': { params: LiveSubscribeParams; result: LiveEnd }
  'live.update': { params: LiveUpdateParams; result: LiveUpdateResult }
}
/** Methods only main sends (results jobs): no renderer or port schema accepts them. */
export interface JobMethods {
  'results.copy': { params: ResultsCopyParams; result: ResultsJobResult }
  'results.export': { params: ResultsExportParams; result: ResultsJobResult }
}
/** Microsoft Entra methods only main sends: no renderer schema accepts them. `entra.cache.clear` empties the backend's
 *  token cache (Help › Clear Entra ID Token Cache). */
export interface AuthMethods {
  'entra.cache.clear': { params: Record<string, never>; result: { cleared: boolean } }
}
/** Synthetic result shapes (backend SyntheticRows, the fake backend's shapes.mjs). */
export type SyntheticShape = 'W1' | 'B1' | 'N1' | 'X1' | 'L1' | 'M1'
/** Test-only methods: the backend offers them with VARIA_BACKEND_TEST_HOOKS=1, and no renderer schema accepts them. */
export interface DebugMethods {
  'debug.results.synthesize': { params: { shape: SyntheticShape; rows: number }; result: BackendResultDescriptor }
}
/** Every method main sends to the backend. */
/** Main compresses plan input before the existing 4 MiB request boundary. Renderers can supply only raw XML. */
export interface PlanMethods { 'plans.parse': { params: { xml: string; encoding: 'gzip' }; result: PlanDocument } }
export interface BackendMethods extends Omit<RpcMethods, 'plans.parse'>, PlanMethods, PortMethods, JobMethods, AuthMethods, DebugMethods {}
export type BackendMethod = keyof BackendMethods
/** Facts about a failed connection for the Connect dialog: SQL Server's error number, state and class (level), the
 *  server that answered (at most 256 characters), and `reason` 'certificate' when the server's TLS certificate was not
 *  trusted. `exception` comes only with BACKEND_ERROR: the unexpected exception's types and HRESULTs (at most 512
 *  characters), for Copy details. Never the connection string, the password, or an exception's message. */
export interface ErrorDetails { number?: number; state?: number; class?: number; server?: string; reason?: ErrorReason; exception?: string }
/** Backend failures carry a code (docs/ipc.md); the message is always a complete sentence to show as is.
 *  `passwordForgotten`: SQL Server rejected the remembered password main filled in, so main forgot it. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: ErrorCode; details?: ErrorDetails; passwordForgotten?: true }

/** Why a backend generation ended: it exited, crashed, broke the protocol, never said HELLO, or main ended it. */
export type LossReason = 'exit' | 'protocol' | 'helloTimeout' | 'crash' | 'reload' | 'manual'
/** What ended with a generation: its connections and the scripts that were running on it. */
export interface LostSummary { generation: number; reason: LossReason; connections: number; queries: number }
/**
 * The backend as main sees it. `restarting` names the generation that ended; the next one starts after `retryInMs`.
 * A backend that is alive but silent is `unresponsive` and is never restarted automatically.
 */
export type BackendState =
  | { status: 'starting'; generation: number }
  | { status: 'ready'; generation: number; pid: number; runtime: string; platform: string }
  | { status: 'unresponsive'; generation: number; silentMs: number }
  | { status: 'restarting'; generation: number; lost?: LostSummary; retryInMs: number }
  | { status: 'failed'; reason: 'crashLoop' | 'spawn' | 'incompatible'; message: string; lost?: LostSummary; details: string }
  | { status: 'stopped' }
export type BackendStatus = BackendState['status']

/** How a file's text is stored: Unicode with or without a byte order mark (`utf16le` and `utf16be` have one), or the
 *  system's ANSI code page (`legacy`, read only). */
export const fileEncodings = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'utf16leNoBom', 'utf16beNoBom', 'legacy'] as const
export type FileEncoding = typeof fileEncodings[number]
export type LineEnding = 'crlf' | 'lf'
/** A file main registered: `codePage` names a `legacy` encoding ('Windows-1252'); `readOnly` is what the last read or save saw. */
export interface SqlFile { id: string; name: string; path: string; encoding: FileEncoding; codePage?: string; readOnly: boolean }
/** `eol` is the file's dominant line ending (the platform's when it has none); `mixedEol` says it had more than one. */
export interface OpenSqlFile extends SqlFile { content: string; eol: LineEnding; mixedEol: boolean; kind?: 'sqlplan' }
/** What a document tab holds: a query, or an XML, JSON or execution plan value opened from a results grid. */
export const documentKinds = ['sql', 'xml', 'json', 'sqlplan'] as const
export type DocumentKind = typeof documentKinds[number]
/** Files main opened for the page (the command line, a second instance, macOS's open-file, a drop, Recent Files), with
 *  what could not be opened: at most 32 errors, each "name: message". */
export interface OpenedFiles { files: OpenSqlFile[]; errors: string[] }
/** A registered file another program changed or deleted (`varia:files-check`). */
export interface FileChange { fileId: string; change: 'modified' | 'deleted' }
/** File changed's answer; the "All" answers apply to the rest of one check. */
export type ReloadAnswer = 'yes' | 'yesToAll' | 'no' | 'noToAll'
export interface ReloadPrompt { fileId: string; dirty: boolean; more: boolean }
export type { RecentFile }
export type { RecoveredDocument, RecoveryEntry, RecoveryWrite }
export type { ReloadPins, RestoredDocument, RestoredSession, SessionDocumentWrite, SessionWrite } from './files/session'
/** `kind` (default 'sql') picks the save dialog's filters and the size limit. */
export interface SaveSqlFile { fileId?: string; name: string; content: string; saveAs: boolean; kind?: DocumentKind }

/** The user's shortcuts as main last saved or read them (`<userData>/shortcuts.json`). `revision` counts the content main
 *  knows in this session; a save names the revision it started from. */
export interface ShortcutsSnapshot { file: ShortcutFile; revision: number }
/** `salvaged`: main set part or all of the file aside on reading it (the original is kept beside it) and `notice` says so,
 *  in fixed words; `notice` also explains a file from a newer version, which is applied as empty and never written. */
export interface ShortcutsLoad extends ShortcutsSnapshot {
  salvaged: boolean
  notice?: string
  /** Comes with `notice`: which notice it is. Main repeats a notice on every get until a save, across revisions, so the
   *  page shows each id once. */
  noticeId?: number
}
export interface ShortcutsSaved { revision: number }
/** A file chosen in main's open dialog, read and validated but not saved; `problems` lists what was left out, in fixed words. */
export type ShortcutsImport = { cancelled: true } | { file: ShortcutFile; problems: readonly string[] }
export interface ShortcutsExport { cancelled: boolean }
/** `window.varia.shortcuts`. Only main reads and writes the file, and it opens the import and export dialogs itself, so no
 *  path ever comes from the page. */
export interface ShortcutsApi {
  get(): Promise<ApiResult<ShortcutsLoad>>
  /** Fails with code `STALE` when the file changed since `baseRevision`: get it again, then save. */
  save(file: ShortcutFile, baseRevision: number): Promise<ApiResult<ShortcutsSaved>>
  importFile(): Promise<ApiResult<ShortcutsImport>>
  exportFile(file: ShortcutFile): Promise<ApiResult<ShortcutsExport>>
  /** Main sends every change it saves or notices; popouts share the page, so one subscription serves them. */
  onChanged(callback: (snapshot: ShortcutsSnapshot) => void): () => void
}

export interface VariaApi {
  languageStatus(): Promise<ApiResult<LanguageStatus>>
  languageComplete(request: LanguageRequest): Promise<ApiResult<LanguageCompletions>>
  languageHover(request: LanguageRequest): Promise<ApiResult<LanguageHover>>
  languageRefresh(request: LanguageRefreshRequest): Promise<ApiResult<LanguageRefreshResult>>
  languageClose(documentId: string): Promise<ApiResult<{ closed: boolean }>>
  parsePlan(xml: string): Promise<ApiResult<PlanDocument>>
  /** Compile only, on a bounded isolated connection; cancel with cancel(requestId). */
  estimatePlan(params: EstimatedPlanRequest): Promise<ApiResult<EstimatedPlanResult>>
  readonly platform: string
  /** Which native menu items are disabled and checked; main validates the ids against its own catalogue. */
  setMenuState(state: MenuState): void
  /** Runs an Electron role (Cut, Zoom In, Reload, …) on the window, for custom menus and the palette. */
  runRole(role: RendererRole, reloadPins?: ReloadPins): Promise<ApiResult<void>>
  /** Replaces an in-flight Reload Window checkpoint from the outgoing page's synchronous unload handler. */
  refreshReloadPins(capture: () => ReloadPins | undefined): ApiResult<void>
  /** Main's choice of context menus: 'native' (macOS) shows them through `showContextMenu`. */
  readonly menuStyle: MenuStyle
  /** Shows a native context menu of catalogue command ids; resolves when it closes. A chosen item arrives on `onContextMenuCommand`. */
  showContextMenu(request: ContextMenuRequest): Promise<ApiResult<void>>
  onContextMenuCommand(callback: (command: ContextMenuCommand) => void): () => void
  health(): Promise<ApiResult<BackendHealth>>
  /** `context` names the history entry whose remembered password main may use (when Password is empty), whether to
   *  remember the password once connected, and the `requestId` that cancelConnectionRequests stops it by. */
  connect(options: ConnectionOptions, context?: ConnectContext): Promise<ApiResult<ConnectionInfo>>
  discoverDatabases(options: ConnectionOptions, context?: ConnectContext): Promise<ApiResult<DatabaseInfo[]>>
  /** The Connect dialog's Stop: cancels connects and Load databases by their `requestId`s (1–16), including a Microsoft
   *  Entra sign-in waiting for the web browser; `cancelled` counts those still running. They answer `CANCELLED`. */
  cancelConnectionRequests(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Help › Clear Entra ID Token Cache: main asks first; resolves to false when the user cancels. */
  clearEntraTokenCache(): Promise<ApiResult<boolean>>
  discoverServers(scope: 'local' | 'network'): Promise<ApiResult<{ servers: DiscoveredServer[]; warning?: string }>>
  previewConnection(options: ConnectionOptions): Promise<ApiResult<{ connectionString: string }>>
  loadConnectionLibrary(): Promise<ApiResult<ConnectionLibraryView & { windowsIdentity: string; warning?: string; passwordStorage: SecretStorageState; passwordWarning?: string }>>
  /** Off Windows, the Kerberos principal Windows Authentication would sign in as (the dialog's User name). */
  integratedIdentity(): Promise<ApiResult<IntegratedIdentity>>
  saveConnectionProfile(profile: ConnectionProfileInput): Promise<ApiResult<ConnectionLibraryView>>
  removeConnectionProfile(id: string): Promise<ApiResult<ConnectionLibraryView>>
  /** Set Connection Environment: main changes only the label of the entry the options name (saving it again when it left
   *  history) and returns the library it wrote. */
  setConnectionEnvironment(input: ConnectionEnvironmentInput): Promise<ApiResult<ConnectionLibraryView>>
  disconnect(connectionId: string): Promise<ApiResult<{ disconnected: boolean }>>
  databases(connectionId: string): Promise<ApiResult<DatabaseInfo[]>>
  tableColumns(connectionId: string, database: string, schema: string, name: string): Promise<ApiResult<TableColumns>>
  /** One page of an Object Explorer node's children. */
  explorerChildren(params: ExplorerChildrenParams): Promise<ApiResult<ExplorerChildrenResult>>
  /** Cancels Object Explorer loads by their `requestId`s (1–256); `cancelled` counts those still running. A load cancelled
   *  this way answers `CANCELLED`. */
  explorerCancel(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Builds a connection's object index; it answers once every database was read or skipped. Stop it with explorerCancel. */
  explorerIndex(params: ObjectIndexParams): Promise<ApiResult<ObjectIndexResult>>
  /** Searches a connection's object index; a search replaced by a newer one is cancelled with explorerCancel. */
  explorerSearch(params: ObjectSearchParams): Promise<ApiResult<ObjectSearchResult>>
  /** Peek's read of one object; a card closed before it answers cancels it with explorerCancel. */
  explorerPeek(params: PeekParams): Promise<ApiResult<PeekResult>>
  explorerPeekDependencies(params: PeekDependenciesParams): Promise<ApiResult<PeekDependenciesResult>>
  /** A build's progress, at most 4 a second per build and only for builds this window started; droppable. Returns the unsubscribe. */
  onExplorerIndexProgress(listener: (progress: ObjectIndexProgress) => void): () => void
  /** Scripts one Object Explorer object (Script As). Failures the user can act on come back as `result.error`. */
  scriptObjects(params: ScriptRequest): Promise<ApiResult<ScriptResult>>
  /** Cancels scripting requests by their `requestId`s (1–64); `cancelled` counts those still running. A request
   *  cancelled this way answers `CANCELLED`. */
  cancelScripting(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Reads what an object dialog shows. Failures the user can act on come back as `result.error`. */
  describeObject(params: ActionDescribeRequest): Promise<ApiResult<ActionDescribeResult>>
  /** Scripts an object action (the dialog's Script button) without running it. */
  scriptObjectAction(params: ActionScriptRequest): Promise<ApiResult<ActionScriptResult>>
  /** Runs an object action: Rename, or Delete Object's OK. Its steps report what ran; it is never re-sent. */
  executeObjectAction(params: ActionExecuteRequest): Promise<ApiResult<ActionExecuteResult>>
  /** Cancels object action requests by their `requestId`s (1–16); `cancelled` counts those still running. A request
   *  cancelled this way answers `CANCELLED`. */
  cancelObjectActions(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** A long object action's progress (a restore or backup step's STATS percent), at most 4 a second per request and only
   *  for requests this window sent; droppable, so the latest value is all that counts. Returns the unsubscribe. */
  onActionProgress(listener: (progress: ActionProgress) => void): () => void
  /** Reads an SSIS Catalog object (catalog, folder, project, package or environment). Failures come back as `result.error`. */
  describeSsis(params: SsisDescribeRequest): Promise<ApiResult<SsisDescribeResult>>
  /** Runs an SSIS Catalog action (Stop Operation, Create Catalog). Refusals and failures come back as `result.error` with the
   *  steps that ran. */
  executeSsis(params: SsisExecuteRequest): Promise<ApiResult<SsisExecuteResult>>
  /** Reads what Create Catalog would do on a server, or why it cannot (`result.error`). */
  catalogSetupSsis(params: SsisCatalogSetupRequest): Promise<ApiResult<SsisCatalogSetupResult>>
  /** Cancels SSIS requests by their `requestId`s (1–64); `cancelled` counts those still running. A request cancelled this way
   *  answers `CANCELLED`. */
  cancelSsis(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Reads an Activity Monitor session's details (the flyout). Failures the user can act on come back as `result.error`. */
  activityDetails(params: ActivityDetailsRequest): Promise<ApiResult<ActivityDetailsResult>>
  /** Kills sessions (1–64) after checking each one's identity; every session gets an outcome or is reported untried. */
  activityKill(params: ActivityKillRequest): Promise<ApiResult<ActivityKillResult>>
  /** Cancels Details reads by their `requestId`s (1–16); `cancelled` counts those still running. A read cancelled this
   *  way answers `CANCELLED`. */
  cancelActivity(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Tools › Options as main stored it, complete; `warning` reports a file that was reset or salvaged (once). */
  getSettings(): Promise<ApiResult<SettingsLoad>>
  /** Changes settings: known keys only, `null` resets one. Main validates strictly and resolves to the new state. */
  updateSettings(patch: SettingsPatch): Promise<ApiResult<SettingsState>>
  /** Main's state after every change, complete and validated. */
  onSettingsChanged(callback: (state: SettingsState) => void): () => void
  shortcuts: ShortcutsApi
  execute(options: QueryOptions): Promise<ApiResult<QueryResult>>
  cancel(queryId: string): Promise<ApiResult<{ cancelled: boolean }>>
  /** Ends a query's session; `transaction` commits or rolls back its open transaction first. A commit that fails leaves
   *  the session open, with its transaction. */
  closeQuerySession(sessionId: string, transaction?: SessionEnd): Promise<ApiResult<{ closed: boolean }>>
  /** Reads an idle query session's open transaction before it ends. A busy, lost or unknown session is an error value. */
  querySessionState(sessionId: string): Promise<ApiResult<SessionState>>
  getBackendState(): Promise<ApiResult<BackendState>>
  onBackendState(callback: (state: BackendState) => void): () => void
  /** Ends the current backend generation and starts the next one; main asks first when servers are connected.
   *  Resolves to false when the user cancels. */
  restartBackend(): Promise<ApiResult<boolean>>
  /** Asks main for this page's results port. It arrives as a window message { type: 'varia:results-port' } carrying one
   *  MessagePort, which ResultClient hands to the results worker. */
  openResultsPort(): Promise<ApiResult<void>>
  /** Copies result rows to the clipboard; the text is formatted by the backend and written by main. */
  copyResults(request: ResultsCopyRequest): Promise<ApiResult<ResultsJobResult>>
  /** Save Results As; resolves to null when the dialog is cancelled. */
  saveResults(request: ResultsSaveRequest): Promise<ApiResult<SavedResults | null>>
  /** Cancels a running copy or save by its job id. */
  cancelResultsJob(jobId: string): Promise<ApiResult<{ cancelled: boolean }>>
  onResultsJob(listener: (progress: ResultsJobProgress) => void): () => void
  /** True only in unpackaged smoke runs (main passed --varia-test-mode). */
  readonly testMode: boolean
  openSqlFiles(): Promise<ApiResult<OpenSqlFile[]>>
  saveSqlFile(options: SaveSqlFile): Promise<ApiResult<SqlFile | null>>
  releaseSqlFile(fileId: string): Promise<ApiResult<void>>
  /** Shows an open query's saved file in the file manager; main looks its path up by id. */
  revealSqlFile(fileId: string): Promise<ApiResult<void>>
  /** Files main opened by itself: from the command line, a second instance, macOS, a drop on the window, or the macOS
   *  menu's Recent Files. The page adopts them as it does an Open's. */
  onFilesOpened(callback: (opened: OpenedFiles) => void): () => void
  /** The registered files changed or deleted outside Varia SQL Manager since main last looked. */
  checkSqlFiles(): Promise<ApiResult<FileChange[]>>
  /** Reads a registered file again, keeping its id. */
  reloadSqlFile(fileId: string): Promise<ApiResult<OpenSqlFile>>
  /** Visual Studio's "modified outside of the source editor" question about one file, in main's message box. */
  confirmReload(prompt: ReloadPrompt): Promise<ApiResult<ReloadAnswer>>
  /** File › Recent Files, most recent first, as many as Options shows; names and paths are for display only. */
  recentFiles(): Promise<ApiResult<RecentFile[]>>
  /** Opens a Recent Files entry by its id; a file that no longer opens asks whether to remove it. */
  openRecentFile(id: string): Promise<ApiResult<OpenedFiles>>
  clearRecentFiles(): Promise<ApiResult<void>>
  onRecentFiles(callback: (files: RecentFile[]) => void): () => void
  /** AutoRecover: keeps a copy of a query with unsaved changes (main adds its file's path), replacing its earlier copy. */
  writeRecovery(record: RecoveryWrite): Promise<ApiResult<void>>
  /** Deletes copies this page kept or was offered (1–256 ids). */
  discardRecovery(ids: readonly string[]): Promise<ApiResult<void>>
  /** The copies an earlier run or an earlier page left, newest first, without their text. */
  listRecovery(): Promise<ApiResult<RecoveryEntry[]>>
  /** One offered copy with its text, now this page's; its original file is registered again when it still exists. */
  takeRecovery(id: string): Promise<ApiResult<RecoveredDocument>>
  /** Hot exit: false only in smoke runs that keep the close prompts; Restore open queries on startup then does nothing. */
  readonly hotExit: boolean
  /** Hot exit: keeps the open tabs for the next start as this page's close goes ahead (main adds file paths). */
  keepSession(session: SessionWrite): Promise<ApiResult<void>>
  /** The tabs the last close kept, opened again; files that are gone are named in `problems`. */
  takeSession(): Promise<ApiResult<RestoredSession>>
  finishSessionRestore(generation: number): Promise<ApiResult<void>>
  /** Writes text to the clipboard through main, which works while the window is unfocused; there is no read. */
  writeClipboardText(text: string): Promise<ApiResult<void>>
  /** Brings one of the page's popout windows (by the `varia-popout-<uuid>` name it opened it with) to the top, restored, without
   *  activating it, so keyboard focus stays in the main window. */
  raisePopout(name: string): Promise<ApiResult<void>>
  confirmClose(name: string): Promise<ApiResult<'save' | 'discard' | 'cancel'>>
  /** Database Properties' Open Connections prompt in main's message box: true only for Yes (No is the default). */
  confirmOpenConnections(): Promise<ApiResult<boolean>>
  /** Asks, in main's message box, what to do with the open transactions and running queries of sessions that are about
   *  to end (src/shared/sessions.ts composes the prompt). */
  confirmSessions(request: SessionPromptRequest): Promise<ApiResult<SessionAnswer>>
  /** An object action's confirmation (src/shared/actions/prompts.ts) in main's message box: the chosen button's answer. */
  confirmAction(request: ActionPromptRequest): Promise<ApiResult<ActionPromptAnswer>>
  /** The page's long runs (src/shared/long-runs.ts), all of them, whenever they change: main's reload prompt names them. */
  setLongRuns(state: LongRunState): Promise<ApiResult<void>>
  closeWindow(): Promise<void>
  /** The page's close ended without closing (a prompt was cancelled, or a save failed). Main hands a close it asked for
   *  to the next page when this one reloads or crashes first, but not one that ended. */
  closeWindowCancelled(): void
  loadLayouts(): Promise<ApiResult<LayoutLoad>>
  saveLayouts(state: LayoutState): Promise<ApiResult<void>>
  importLayout(): Promise<ApiResult<WorkspaceLayout | null>>
  exportLayout(layout: WorkspaceLayout): Promise<ApiResult<boolean>>
  onCommand(callback: (command: CommandId) => void): () => void
  getThemeState(): Promise<ApiResult<ThemeState>>
  setThemePreference(patch: ThemePreferencePatch): Promise<ApiResult<ThemeState>>
  /** Resolves a catalogue theme for the palette's picker to show, and shows it in the window chrome; null ends that. */
  previewTheme(selection: ThemePreview | null): Promise<ApiResult<ResolvedTheme | null>>
  /** Writes a starter theme, selects it, and reveals it in the file manager. */
  createCustomTheme(): Promise<ApiResult<void>>
  reloadThemes(): Promise<ApiResult<ThemeState>>
  openThemesFolder(): Promise<ApiResult<void>>
  onThemeChanged(callback: (state: ThemeState) => void): () => void
  /** Updates (src/shared/updates.ts): main checks, downloads and installs; the page only asks and shows. */
  getUpdateState(): Promise<ApiResult<UpdateState>>
  /** Help › Check for Updates: resolves once the check (and any download it starts) has ended. */
  checkForUpdates(): Promise<ApiResult<UpdateState>>
  downloadUpdate(): Promise<ApiResult<UpdateState>>
  /** Restart to Update: main closes the app as File › Exit does (unsaved queries ask first), then installs. False when nothing is ready. */
  restartToUpdate(): Promise<ApiResult<boolean>>
  /** Opens the releases page in the browser; main names the page, never the renderer. */
  openReleasesPage(): Promise<ApiResult<void>>
  onUpdateState(callback: (state: UpdateState) => void): () => void
  /** Whether the main window is minimized or hidden, as main sees it: popouts turn its background throttling off, so the
   *  page's own visibility stays visible then. Sent on each change. */
  onMainWindowHidden(callback: (hidden: boolean) => void): () => void
}
