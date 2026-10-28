import type { LayoutLoad, LayoutState, WorkspaceLayout } from './layouts'
import type { ConnectContext, ConnectionEnvironmentInput, ConnectionLibraryView, ConnectionProfileInput, SecretStorageState } from './connections'
import type { ResolvedTheme, ThemePreferencePatch, ThemePreview, ThemeState } from './theme/types'
import type { CommandId, RendererRole } from './commands/catalog'
import type { ContextMenuCommand, ContextMenuRequest, MenuState } from './commands/menus'
import type { MenuStyle } from './menu-style'
import type { ErrorCode, ErrorReason } from './ipc/wire/protocol'
import type { AuthenticationMode } from './auth'
import type { ExplorerChildrenParams, ExplorerNodeRef } from './explorer/refs.ts'
import type { ExplorerIcon, NodeStatus, NodeSubtype } from './explorer/catalog.ts'
import type { ScriptRequest, ScriptResult } from './scripting/schema.ts'
import type { ActionDescribeRequest, ActionDescribeResult, ActionExecuteResult, ActionRequest, ActionScriptResult } from './actions/schema.ts'
import type { SsisDescribeRequest, SsisDescribeResult, SsisExecuteRequest, SsisExecuteResult } from './ssis/schema.ts'
import type { SettingsLoad, SettingsPatch, SettingsState } from './settings/schema'
import type { SessionAnswer, SessionEnd, SessionPromptRequest } from './sessions.ts'
import type { RecentFile } from './files/recent'
import type { RecoveredDocument, RecoveryEntry, RecoveryWrite } from './files/recovery'
import type { LiveEnd, LiveSubscribeParams, LiveUpdateParams, LiveUpdateResult } from './live/schema'
import type { ActivityDetailsRequest, ActivityDetailsResult, ActivityKillRequest, ActivityKillResult } from './activity/schema.ts'

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
 * `productVersion` (≤ 32 characters), `login` (≤ 128) and `engineEdition` come from the server profile probed at connect,
 * and are absent when the probe failed.
 */
export interface ConnectionInfo {
  id: string; server: string; database: string; serverVersion: string; displayName?: string; color?: string; commandTimeout?: number; historyWarning?: string; generation: number
  /** Set by main: the saved entry's environment label, which a connect without one kept. */
  environment?: string
  productVersion?: string; login?: string; engineEdition?: number
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
}
/** `text` cells carry their SSMS display text; `binary` cells are shown as 0x plus hexadecimal. */
export type WireKind = 'text' | 'binary'
export interface ResultColumn {
  name: string
  dataType: string
  wire: WireKind
  role?: 'xml' | 'json' | 'plan' | 'udt' | 'vector'
  maxLength?: number
  precision?: number
  scale?: number
  nullable: boolean
}
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
/** One line of the Messages tab: SQL errors, cancellation and timeout are `error` entries (red, in order). */
export interface MessageEntry { text: string; kind: 'info' | 'error' }
export type QueryStatus = 'completed' | 'completedWithErrors' | 'failed' | 'cancelled' | 'timedOut'
/** The query.execute summary: the rows stay in the backend (ResultClient reads them). `completedAt` is the backend's
 *  local time with 7 fractional digits, for SSMS's "Completion time:" line. */
export interface QueryResult {
  resultSets: ResultDescriptor[]
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
}
/** An idle session's open transaction as `query.session.state` read it: `checked` is false when its SET options (SHOWPLAN_*,
 *  NOEXEC, PARSEONLY or FMTONLY ON) kept the SELECT from returning @@TRANCOUNT, so it may hold one. */
export interface SessionState { transactionCount: number; checked: boolean }
/** Orders what the backend reports about result memory (results.memory events and summaries): `seq` counts within the
 *  backend process that main numbered `generation`, so a figure overtaken by a newer one is never shown after it. */
export interface MemoryOrder { generation: number; seq: number }
/** Rows read so far for one result set of a running script. */
export interface ResultProgress { resultId: number; rowsRead: number; rowsStored: number; rowsAvailable: number; bytesStored: number }
/** Pushed while a script runs (EVENT frames, then the results port). The summary is authoritative once it arrives. */
export type QueryEvent =
  | { type: 'resultSet.opened'; descriptor: ResultDescriptor }
  | { type: 'resultSet.closed'; descriptor: ResultDescriptor }
  | { type: 'progress'; completedBatches: number; totalBatches: number; batchNumber: number; iteration: number; results: ResultProgress[] }
  | { type: 'messages'; messages: MessageEntry[] }
export interface ResultsReadParams { resultId: number; firstRow: number; maxRows: number }
/** `nextRow` follows the last row sent; `complete` means no rows remain to be read. */
export interface ResultsReadResult { nextRow: number; rowsAvailable: number; complete: boolean; pages: number; rows: number }
export interface ResultsCloseResult { closed: number; usedBytes: number }
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
export interface ResultsCopyRequest { jobId: string; generation: number; resultId: number; headers: boolean; parts: readonly CopyPart[] }
/** Save Results As: main shows the save dialog (the renderer never supplies a path) and runs results.export. */
export interface ResultsSaveRequest { jobId: string; generation: number; resultId: number; format?: ResultsFormat; suggestedName: string }
/** `partial`: the set was still open, so open-ended selections ended at the rows stored then. */
export interface ResultsJobResult { rows: number; bytes: number; truncatedCells: number; partial: boolean }
/** Only the file's name returns to the renderer, never its path. */
export interface SavedResults extends ResultsJobResult { fileName: string; format: ResultsFormat }
/** Pushed on `varia:results-job` at most 4 times a second per job. A save reports once as soon as its file is chosen;
 *  its reports carry the file's name (never its path). */
export interface ResultsJobProgress { jobId: string; kind: 'copy' | 'save'; rowsDone: number; rowsTotal: number; bytes: number; fileName?: string }
export interface ResultsCopyParams { resultId: number; parts: readonly CopyPart[]; headers: boolean; eol: 'crlf' | 'lf'; maxBytes: number }
/** `temporaryId` (32 hex digits) names the file written beside the target, `.varia-{temporaryId}.tmp`, which main removes
 *  if the backend dies before it does. */
export interface ResultsExportParams { resultId: number; path: string; format: ResultsFormat; headers: boolean; nullText: 'empty' | 'NULL'; temporaryId: string }
/** One Object Explorer node. Labels are SSMS's text (≤ 300), sublabels the "(…)" part (≤ 200), detail tooltip-only facts
 *  (≤ 512); `created` is server local time, `yyyy-MM-ddTHH:mm:ss`. */
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
  'scripting.script': { params: ScriptRequest; result: ScriptResult }
  /** What an object dialog shows (Delete Object's row and warnings), read in the action's own connection. */
  'actions.describe': { params: ActionDescribeRequest; result: ActionDescribeResult }
  /** An action's script, for the dialog's Script button; it runs nothing. */
  'actions.script': { params: ActionRequest; result: ActionScriptResult }
  /** Runs an action's DDL after a preflight; never re-sent, and only Stop (varia:actions-cancel) ends a lock wait. */
  'actions.execute': { params: ActionRequest; result: ActionExecuteResult }
  /** What an SSIS Catalog object is (a properties document's read), on the SSIS read pool; Stop is varia:ssis-cancel. */
  'ssis.describe': { params: SsisDescribeRequest; result: SsisDescribeResult }
  /** Changes the SSIS Catalog (Stop Operation) on its own unpooled connection after a preflight; never re-sent, and only Stop
   *  (varia:ssis-cancel) ends a lock wait. Sensitive: its frame is zeroed once written. */
  'ssis.execute': { params: SsisExecuteRequest; result: SsisExecuteResult }
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
export interface BackendMethods extends RpcMethods, PortMethods, JobMethods, AuthMethods, DebugMethods {}
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
export interface OpenSqlFile extends SqlFile { content: string; eol: LineEnding; mixedEol: boolean }
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
/** `kind` (default 'sql') picks the save dialog's filters and the size limit. */
export interface SaveSqlFile { fileId?: string; name: string; content: string; saveAs: boolean; kind?: DocumentKind }

export interface VariaApi {
  readonly platform: string
  /** Which native menu items are disabled and checked; main validates the ids against its own catalogue. */
  setMenuState(state: MenuState): void
  /** Runs an Electron role (Cut, Zoom In, Reload, …) on the window, for custom menus and the palette. */
  runRole(role: RendererRole): Promise<ApiResult<void>>
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
  /** Scripts one Object Explorer object (Script As). Failures the user can act on come back as `result.error`. */
  scriptObjects(params: ScriptRequest): Promise<ApiResult<ScriptResult>>
  /** Cancels scripting requests by their `requestId`s (1–64); `cancelled` counts those still running. A request
   *  cancelled this way answers `CANCELLED`. */
  cancelScripting(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Reads what an object dialog shows. Failures the user can act on come back as `result.error`. */
  describeObject(params: ActionDescribeRequest): Promise<ApiResult<ActionDescribeResult>>
  /** Scripts an object action (the dialog's Script button) without running it. */
  scriptObjectAction(params: ActionRequest): Promise<ApiResult<ActionScriptResult>>
  /** Runs an object action: Rename, or Delete Object's OK. Its steps report what ran; it is never re-sent. */
  executeObjectAction(params: ActionRequest): Promise<ApiResult<ActionExecuteResult>>
  /** Cancels object action requests by their `requestId`s (1–16); `cancelled` counts those still running. A request
   *  cancelled this way answers `CANCELLED`. */
  cancelObjectActions(requestIds: readonly string[]): Promise<ApiResult<{ cancelled: number }>>
  /** Reads an SSIS Catalog object (catalog, folder, project, package or environment). Failures come back as `result.error`. */
  describeSsis(params: SsisDescribeRequest): Promise<ApiResult<SsisDescribeResult>>
  /** Runs an SSIS Catalog action (Stop Operation). Refusals and failures come back as `result.error` with the steps that ran. */
  executeSsis(params: SsisExecuteRequest): Promise<ApiResult<SsisExecuteResult>>
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
  /** Writes text to the clipboard through main, which works while the window is unfocused; there is no read. */
  writeClipboardText(text: string): Promise<ApiResult<void>>
  confirmClose(name: string): Promise<ApiResult<'save' | 'discard' | 'cancel'>>
  /** Database Properties' Open Connections prompt in main's message box: true only for Yes (No is the default). */
  confirmOpenConnections(): Promise<ApiResult<boolean>>
  /** Asks, in main's message box, what to do with the open transactions and running queries of sessions that are about
   *  to end (src/shared/sessions.ts composes the prompt). */
  confirmSessions(request: SessionPromptRequest): Promise<ApiResult<SessionAnswer>>
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
}
