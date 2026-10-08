import type { LayoutLoad, LayoutState, WorkspaceLayout } from './layouts'
import type { ConnectionLibrary, ConnectionProfileInput } from './connections'
import type { ResolvedTheme, ThemePreferencePatch, ThemePreview, ThemeState } from './theme/types'
import type { CommandId, RendererRole } from './commands/catalog'
import type { MenuState } from './commands/menus'

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

export interface ConnectionInfo { id: string; server: string; database: string; serverVersion: string; displayName?: string; color?: string; commandTimeout?: number; historyWarning?: string }
export interface DiscoveredServer { server: string; version: string; source: 'local' | 'network' }
export interface DatabaseInfo { name: string; isSystem: boolean; isSnapshot: boolean }
export const serverObjectKinds = ['logins', 'serverRoles', 'credentials', 'cryptographicProviders', 'audits', 'serverAuditSpecifications'] as const
export type ServerObjectKind = typeof serverObjectKinds[number]
export interface ServerObjectInfo { name: string; description: string }
export interface TableInfo { schema: string; name: string }
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
  'tables.columns': { params: { connectionId: string; database: string; schema: string; name: string }; result: TableColumns }
  'query.execute': { params: QueryOptions; result: QueryResult }
  'query.cancel': { params: { queryId: string }; result: { cancelled: boolean } }
  'query.session.close': { params: { sessionId: string }; result: { closed: boolean } }
}
export type RpcMethod = keyof RpcMethods
export type RpcResponse =
  | { id: string | null; result: unknown; error?: never }
  | { id: string | null; error: { code: string; message: string }; result?: never }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SqlFile { id: string; name: string; path: string }
export interface OpenSqlFile extends SqlFile { content: string }
export interface SaveSqlFile { fileId?: string; name: string; content: string; saveAs: boolean }

export interface VariaApi {
  readonly platform: string
  /** Which native menu items are disabled and checked; main validates the ids against its own catalogue. */
  setMenuState(state: MenuState): void
  /** Runs an Electron role (Cut, Zoom In, Reload, …) on the window, for custom menus and the palette. */
  runRole(role: RendererRole): Promise<ApiResult<void>>
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
  tableColumns(connectionId: string, database: string, schema: string, name: string): Promise<ApiResult<TableColumns>>
  execute(options: QueryOptions): Promise<ApiResult<QueryResult>>
  cancel(queryId: string): Promise<ApiResult<{ cancelled: boolean }>>
  closeQuerySession(sessionId: string): Promise<ApiResult<{ closed: boolean }>>
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
