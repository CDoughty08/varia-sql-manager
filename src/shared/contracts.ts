import type { LayoutLoad, LayoutState, WorkspaceLayout } from './layouts'
import type { ConnectionLibrary, ConnectionProfileInput } from './connections'
import type { ResolvedTheme, ThemePreferencePatch, ThemePreview, ThemeState } from './theme/types'
import type { CommandId } from './commands/catalog'
import type { MenubarId, MenuState } from './commands/menus'
import type { ErrorCode } from './ipc/wire/protocol'

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

/** `generation` is the backend generation that holds the connection (stamped by main); a later generation cannot use it. */
export interface ConnectionInfo { id: string; server: string; database: string; serverVersion: string; displayName?: string; color?: string; commandTimeout?: number; historyWarning?: string; generation: number }
export interface DiscoveredServer { server: string; version: string; source: 'local' | 'network' }
export interface DatabaseInfo { name: string; isSystem: boolean; isSnapshot: boolean }
export const serverObjectKinds = ['logins', 'serverRoles', 'credentials', 'cryptographicProviders', 'audits', 'serverAuditSpecifications'] as const
export type ServerObjectKind = typeof serverObjectKinds[number]
export interface ServerObjectInfo { name: string; description: string }
export interface TableInfo { schema: string; name: string }
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
  maxRows: number
  timeoutSeconds: number
  startLine?: number
}
export interface ResultSet {
  columns: { name: string; dataType: string }[]
  rows: (string | number | boolean | null)[][]
  truncated: boolean
  incomplete?: boolean
  batchNumber?: number
  iteration?: number
  kind?: 'rows' | 'executionPlan'
}
export interface QueryResult {
  resultSets: ResultSet[]
  messages: string[]
  recordsAffected: number
  elapsedMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'timedOut'
  error?: { code: string; message: string; batchNumber: number; iteration: number }
  completedBatches: number
  totalBatches: number
  database: string
  messagesTruncated: boolean
}
export interface RpcMethods {
  'system.health': { params: Record<string, never>; result: BackendHealth }
  'connections.connect': { params: ConnectionOptions; result: ConnectionInfo }
  'connections.databases': { params: ConnectionOptions; result: DatabaseInfo[] }
  'connections.discover': { params: { scope: 'local' | 'network' }; result: { servers: DiscoveredServer[]; warning?: string } }
  'connections.preview': { params: ConnectionOptions; result: { connectionString: string } }
  'connections.disconnect': { params: { connectionId: string }; result: { disconnected: boolean } }
  'databases.list': { params: { connectionId: string }; result: DatabaseInfo[] }
  'server.objects.list': { params: { connectionId: string; kind: ServerObjectKind }; result: ServerObjectInfo[] }
  'tables.list': { params: { connectionId: string; database: string }; result: TableInfo[] }
  'tables.script': { params: { connectionId: string; database: string; schema: string; name: string }; result: { sql: string } }
  'query.execute': { params: QueryOptions; result: QueryResult }
  'query.cancel': { params: { queryId: string }; result: { cancelled: boolean } }
  'query.session.close': { params: { sessionId: string }; result: { closed: boolean } }
}
export type RpcMethod = keyof RpcMethods
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

export interface MenuPopup { menu: MenubarId; x: number; y: number }
export interface SqlFile { id: string; name: string; path: string }
export interface OpenSqlFile extends SqlFile { content: string }
export interface SaveSqlFile { fileId?: string; name: string; content: string; saveAs: boolean }

export interface VariaApi {
  readonly platform: string
  showMenu(options: MenuPopup): Promise<ApiResult<void>>
  onMenuFocus(callback: (menu: MenubarId | null) => void): () => void
  /** Which native menu items are disabled and checked; main validates the ids against its own catalogue. */
  setMenuState(state: MenuState): void
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
  serverObjects(connectionId: string, kind: ServerObjectKind): Promise<ApiResult<ServerObjectInfo[]>>
  tables(connectionId: string, database: string): Promise<ApiResult<TableInfo[]>>
  scriptTable(connectionId: string, database: string, schema: string, name: string): Promise<ApiResult<{ sql: string }>>
  execute(options: QueryOptions): Promise<ApiResult<QueryResult>>
  cancel(queryId: string): Promise<ApiResult<{ cancelled: boolean }>>
  closeQuerySession(sessionId: string): Promise<ApiResult<{ closed: boolean }>>
  getBackendState(): Promise<ApiResult<BackendState>>
  onBackendState(callback: (state: BackendState) => void): () => void
  /** Ends the current backend generation and starts the next one; main asks first when servers are connected.
   *  Resolves to false when the user cancels. */
  restartBackend(): Promise<ApiResult<boolean>>
  openSqlFiles(): Promise<ApiResult<OpenSqlFile[]>>
  saveSqlFile(options: SaveSqlFile): Promise<ApiResult<SqlFile | null>>
  releaseSqlFile(fileId: string): Promise<ApiResult<void>>
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
