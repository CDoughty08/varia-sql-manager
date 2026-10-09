import type { LayoutLoad, LayoutState, WorkspaceLayout } from './layouts'
import type { ConnectionLibrary, ConnectionProfileInput } from './connections'
import type { ResolvedTheme, ThemePreferencePatch, ThemePreview, ThemeState } from './theme/types'
import type { CommandId, RendererRole } from './commands/catalog'
import type { ContextMenuCommand, ContextMenuRequest, MenuState } from './commands/menus'
import type { MenuStyle } from './menu-style'
import type { ErrorCode } from './ipc/wire/protocol'
import type { ExplorerChildrenParams, ExplorerNodeRef } from './explorer/refs.ts'
import type { ExplorerIcon, NodeStatus, NodeSubtype } from './explorer/catalog.ts'
import type { ScriptRequest, ScriptResult } from './scripting/schema.ts'

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
  authentication: 'windows' | 'sql'
  username?: string
  password?: string
  trustServerCertificate: boolean
  encrypt?: 'optional' | 'mandatory' | 'strict'
  hostNameInCertificate?: string
  displayName?: string
  color?: string
  advanced?: Partial<AdvancedConnectionOptions>
}

/**
 * `generation` is the backend generation that holds the connection (stamped by main); a later generation cannot use it.
 * `productVersion` (≤ 32 characters), `login` (≤ 128) and `engineEdition` come from the server profile probed at connect,
 * and are absent when the probe failed.
 */
export interface ConnectionInfo {
  id: string; server: string; database: string; serverVersion: string; displayName?: string; color?: string; commandTimeout?: number; historyWarning?: string; generation: number
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
/** The query.execute summary: the rows stay in the backend (ResultClient reads them). */
export interface QueryResult {
  resultSets: ResultDescriptor[]
  discardedResultSets: number
  messages: string[]
  recordsAffected: number
  elapsedMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'timedOut'
  error?: { code: string; message: string; batchNumber: number; iteration: number }
  completedBatches: number
  totalBatches: number
  database: string
  messagesTruncated: boolean
  budget: { usedBytes: number; globalBytes: number; queryBytes: number }
}
/** A result set materialised for the PR6 results table (results/legacy.ts): display text, null for NULL. */
export interface DisplayResultSet {
  columns: { name: string; dataType: string }[]
  rows: (string | null)[][]
  truncated: boolean
  incomplete?: boolean
  batchNumber?: number
  iteration?: number
  kind?: 'rows' | 'executionPlan'
}
export interface DisplayQueryResult extends Omit<QueryResult, 'resultSets' | 'budget' | 'discardedResultSets'> { resultSets: DisplayResultSet[] }
/** Rows read so far for one result set of a running script. */
export interface ResultProgress { resultId: number; rowsRead: number; rowsStored: number; rowsAvailable: number; bytesStored: number }
/** Pushed while a script runs (EVENT frames, then the results port). The summary is authoritative once it arrives. */
export type QueryEvent =
  | { type: 'resultSet.opened'; descriptor: ResultDescriptor }
  | { type: 'resultSet.closed'; descriptor: ResultDescriptor }
  | { type: 'progress'; completedBatches: number; totalBatches: number; batchNumber: number; iteration: number; results: ResultProgress[] }
  | { type: 'messages'; messages: string[] }
export interface ResultsReadParams { resultId: number; firstRow: number; maxRows: number }
/** `nextRow` follows the last row sent; `complete` means no rows remain to be read. */
export interface ResultsReadResult { nextRow: number; rowsAvailable: number; complete: boolean; pages: number; rows: number }
export interface ResultsCloseResult { closed: number; usedBytes: number }
/** The backend's descriptor, before main stamps its generation. */
export type BackendResultDescriptor = Omit<ResultDescriptor, 'generation'>
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
export const explorerErrorCodes = ['PERMISSION_DENIED', 'NO_DB_ACCESS', 'DATABASE_UNAVAILABLE', 'NOT_FOUND', 'BLOCKED', 'TIMEOUT', 'CONNECTION_LOST', 'SQL_ERROR'] as const
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
export interface RpcMethods {
  'system.health': { params: Record<string, never>; result: BackendHealth }
  'connections.connect': { params: ConnectionOptions; result: ConnectionInfo }
  'connections.databases': { params: ConnectionOptions; result: DatabaseInfo[] }
  'connections.discover': { params: { scope: 'local' | 'network' }; result: { servers: DiscoveredServer[]; warning?: string } }
  'connections.preview': { params: ConnectionOptions; result: { connectionString: string } }
  'connections.disconnect': { params: { connectionId: string }; result: { disconnected: boolean } }
  'databases.list': { params: { connectionId: string }; result: DatabaseInfo[] }
  'tables.script': { params: { connectionId: string; database: string; schema: string; name: string }; result: { sql: string } }
  'tables.columns': { params: { connectionId: string; database: string; schema: string; name: string }; result: TableColumns }
  'query.execute': { params: QueryOptions; result: QueryResult }
  'query.cancel': { params: { queryId: string }; result: { cancelled: boolean } }
  'query.session.close': { params: { sessionId: string }; result: { closed: boolean } }
  'explorer.children': { params: ExplorerChildrenParams; result: ExplorerChildrenResult }
  'scripting.script': { params: ScriptRequest; result: ScriptResult }
}
export type RpcMethod = keyof RpcMethods
/** Methods the renderer reaches only through the results port (validated by portRequestSchema, never by invoke). */
export interface PortMethods {
  'results.read': { params: ResultsReadParams; result: ResultsReadResult }
  'results.close': { params: { resultIds: number[] }; result: ResultsCloseResult }
}
/** Test-only methods: the backend offers them with VARIA_BACKEND_TEST_HOOKS=1, and no renderer schema accepts them. */
export interface DebugMethods {
  'debug.results.synthesize': { params: { shape: 'W1' | 'B1' | 'N1'; rows: number }; result: BackendResultDescriptor }
}
/** Every method main sends to the backend. */
export interface BackendMethods extends RpcMethods, PortMethods, DebugMethods {}
export type BackendMethod = keyof BackendMethods
/** Backend failures carry a code (docs/ipc.md); the message is always a complete sentence to show as is. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: ErrorCode }

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

export interface SqlFile { id: string; name: string; path: string }
export interface OpenSqlFile extends SqlFile { content: string }
export interface SaveSqlFile { fileId?: string; name: string; content: string; saveAs: boolean }

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
  connect(options: ConnectionOptions): Promise<ApiResult<ConnectionInfo>>
  discoverDatabases(options: ConnectionOptions): Promise<ApiResult<DatabaseInfo[]>>
  discoverServers(scope: 'local' | 'network'): Promise<ApiResult<{ servers: DiscoveredServer[]; warning?: string }>>
  previewConnection(options: ConnectionOptions): Promise<ApiResult<{ connectionString: string }>>
  loadConnectionLibrary(): Promise<ApiResult<{ library: ConnectionLibrary; windowsIdentity: string; warning?: string }>>
  saveConnectionProfile(profile: ConnectionProfileInput): Promise<ApiResult<ConnectionLibrary>>
  removeConnectionProfile(id: string): Promise<ApiResult<ConnectionLibrary>>
  disconnect(connectionId: string): Promise<ApiResult<{ disconnected: boolean }>>
  databases(connectionId: string): Promise<ApiResult<DatabaseInfo[]>>
  scriptTable(connectionId: string, database: string, schema: string, name: string): Promise<ApiResult<{ sql: string }>>
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
  execute(options: QueryOptions): Promise<ApiResult<QueryResult>>
  cancel(queryId: string): Promise<ApiResult<{ cancelled: boolean }>>
  closeQuerySession(sessionId: string): Promise<ApiResult<{ closed: boolean }>>
  getBackendState(): Promise<ApiResult<BackendState>>
  onBackendState(callback: (state: BackendState) => void): () => void
  /** Ends the current backend generation and starts the next one; main asks first when servers are connected.
   *  Resolves to false when the user cancels. */
  restartBackend(): Promise<ApiResult<boolean>>
  /** Asks main for this page's results port. It arrives as a window message { type: 'varia:results-port' } carrying one
   *  MessagePort, which ResultClient hands to the results worker. */
  openResultsPort(): Promise<ApiResult<void>>
  /** True only in unpackaged smoke runs (main passed --varia-test-mode). */
  readonly testMode: boolean
  openSqlFiles(): Promise<ApiResult<OpenSqlFile[]>>
  saveSqlFile(options: SaveSqlFile): Promise<ApiResult<SqlFile | null>>
  releaseSqlFile(fileId: string): Promise<ApiResult<void>>
  /** Shows an open query's saved file in the file manager; main looks its path up by id. */
  revealSqlFile(fileId: string): Promise<ApiResult<void>>
  /** Writes text to the clipboard through main, which works while the window is unfocused; there is no read. */
  writeClipboardText(text: string): Promise<ApiResult<void>>
  confirmClose(name: string): Promise<ApiResult<'save' | 'discard' | 'cancel'>>
  closeWindow(): Promise<void>
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
