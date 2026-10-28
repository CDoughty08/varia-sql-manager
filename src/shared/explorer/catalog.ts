// The Object Explorer tree: node kinds, folders, icons, filters and limits. It is the only declaration of the tree's
// structure: main's zod schemas, the renderer and docs/object-explorer.md read it, and the backend embeds
// explorerCatalogJson() as Explorer/explorer-catalog.json (a vitest file snapshot keeps that copy in sync).
// Erasable TypeScript (no enums), so Node's type stripping can load it as well.
import type { CodiconId, IconId } from '../icons.ts'
import { maxIdentifierLength } from '../sql/identifiers.ts'

/** What a node is, independent of the folder showing it. Folders are not a kind. */
export const nodeKinds = [
  'server',
  'login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'backupDevice', 'linkedServer', 'serverTrigger',
  'database',
  'user', 'databaseRole', 'applicationRole', 'schema', 'assembly', 'asymmetricKey', 'certificate', 'symmetricKey', 'columnMasterKey', 'columnEncryptionKey',
  'databaseAuditSpecification', 'databaseTrigger', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist', 'partitionScheme',
  'partitionFunction', 'searchPropertyList', 'planGuide',
  'table', 'view', 'synonym', 'procedure', 'function', 'sequence', 'type', 'tableType', 'xmlSchemaCollection', 'rule', 'default', 'securityPolicy',
  'column', 'key', 'constraint', 'trigger', 'index', 'statistic', 'parameter', 'returnValue',
  'ssisCatalog', 'ssisFolder', 'ssisProject', 'ssisPackage', 'ssisEnvironment'
] as const
export type NodeKind = typeof nodeKinds[number]

/**
 * Which identity fields a kind's refs carry (`scopeFields`). The `ssis*` scopes name SSIS Catalog objects by folder and
 * project (SSISDB names, not database objects): the catalog itself, a folder, a folder's project or environment, and a
 * project's package.
 */
export const kindScopes = ['server', 'serverObject', 'database', 'databaseObject', 'schemaObject', 'child', 'childUnnamed', 'ssisCatalog', 'ssisFolder', 'ssisFolderObject', 'ssisProjectObject'] as const
export type KindScope = typeof kindScopes[number]
export const refFields = ['database', 'schema', 'name', 'parent', 'ssisFolder', 'ssisProject'] as const
export type RefField = typeof refFields[number]
const ssisFields = ['ssisFolder', 'ssisProject'] as const
export const scopeFields: { readonly [S in KindScope]: { readonly required: readonly RefField[]; readonly forbidden: readonly RefField[] } } = {
  server: { required: [], forbidden: ['database', 'schema', 'name', 'parent', ...ssisFields] },
  serverObject: { required: ['name'], forbidden: ['database', 'schema', 'parent', ...ssisFields] },
  database: { required: ['name'], forbidden: ['database', 'schema', 'parent', ...ssisFields] },
  databaseObject: { required: ['database', 'name'], forbidden: ['schema', 'parent', ...ssisFields] },
  schemaObject: { required: ['database', 'schema', 'name'], forbidden: ['parent', ...ssisFields] },
  child: { required: ['database', 'parent', 'name'], forbidden: ['schema', ...ssisFields] },
  childUnnamed: { required: ['database', 'parent'], forbidden: ['schema', 'name', ...ssisFields] },
  ssisCatalog: { required: ['name'], forbidden: ['database', 'schema', 'parent', ...ssisFields] },
  ssisFolder: { required: ['name'], forbidden: ['database', 'schema', 'parent', ...ssisFields] },
  ssisFolderObject: { required: ['ssisFolder', 'name'], forbidden: ['database', 'schema', 'parent', 'ssisProject'] },
  ssisProjectObject: { required: ['ssisFolder', 'ssisProject', 'name'], forbidden: ['database', 'schema', 'parent'] }
}
/** The kinds that own child folders, and so can be a child ref's `parent`. */
export const parentKinds = ['table', 'view', 'tableType', 'procedure', 'function'] as const
export type ParentKind = typeof parentKinds[number]

/** Every folder PR4 serves, globally unique (`serverSecurity` is not `databaseSecurity`). Planned folders are in `laterFolders`. */
export const folderIds = [
  'databases', 'systemDatabases', 'databaseSnapshots',
  'serverSecurity', 'logins', 'serverRoles', 'credentials', 'cryptographicProviders', 'audits', 'serverAuditSpecifications',
  'serverObjects', 'backupDevices', 'linkedServers', 'serverTriggers',
  'tables', 'systemTables', 'fileTables', 'externalTables', 'graphTables', 'droppedLedgerTables',
  'views', 'systemViews', 'droppedLedgerViews',
  'externalResources', 'externalDataSources', 'externalFileFormats',
  'synonyms',
  'programmability', 'storedProcedures', 'systemStoredProcedures', 'functions', 'tableValuedFunctions', 'scalarValuedFunctions', 'aggregateFunctions',
  'databaseTriggers', 'assemblies', 'types', 'userDefinedDataTypes', 'userDefinedTableTypes', 'userDefinedTypes', 'xmlSchemaCollections', 'rules', 'defaults',
  'planGuides', 'sequences',
  'storage', 'fullTextCatalogs', 'partitionSchemes', 'partitionFunctions', 'fullTextStoplists', 'searchPropertyLists',
  'databaseSecurity', 'users', 'roles', 'databaseRoles', 'applicationRoles', 'schemas', 'asymmetricKeys', 'certificates', 'symmetricKeys',
  'alwaysEncryptedKeys', 'columnMasterKeys', 'columnEncryptionKeys', 'databaseAuditSpecifications', 'securityPolicies',
  'columns', 'keys', 'constraints', 'tableTriggers', 'indexes', 'statistics', 'parameters',
  'integrationServicesCatalogs', 'ssisProjects', 'ssisEnvironments', 'ssisPackages'
] as const
export type FolderId = typeof folderIds[number]

export const nodeSubtypes = [
  'system', 'snapshot',
  'systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'ledgerHistory', 'graphNode', 'graphEdge', 'fileTable', 'external', 'droppedLedger',
  'ledger',
  'sql', 'clr', 'extended', 'replicationFilter',
  'inline', 'tableValued', 'clrTableValued', 'scalar', 'clrScalar', 'aggregate',
  'primary', 'unique', 'foreign',
  'check', 'default', 'edge',
  'clustered', 'nonclustered', 'clusteredColumnstore', 'nonclusteredColumnstore', 'xml', 'spatial', 'hash', 'other',
  'alias',
  'input', 'output',
  'entryPoint', 'child'
] as const
export type NodeSubtype = typeof nodeSubtypes[number]

/** The backend's catalog queries: one per listing folder, plus the history row of temporal and ledger tables. */
export const queryIds = [
  'userDatabases', 'systemDatabases', 'databaseSnapshots',
  'logins', 'serverRoles', 'credentials', 'cryptographicProviders', 'audits', 'serverAuditSpecifications', 'backupDevices', 'linkedServers', 'serverTriggers',
  'tables', 'systemTables', 'fileTables', 'externalTables', 'graphTables', 'droppedLedgerTables', 'historyTable',
  'views', 'systemViews', 'droppedLedgerViews', 'externalDataSources', 'externalFileFormats', 'synonyms',
  'procedures', 'systemProcedures', 'tableValuedFunctions', 'scalarFunctions', 'aggregateFunctions', 'databaseTriggers', 'assemblies',
  'aliasTypes', 'tableTypes', 'clrTypes', 'xmlSchemaCollections', 'rules', 'defaults', 'planGuides', 'sequences',
  'fullTextCatalogs', 'partitionSchemes', 'partitionFunctions', 'fullTextStoplists', 'searchPropertyLists',
  'users', 'databaseRoles', 'applicationRoles', 'schemas', 'asymmetricKeys', 'certificates', 'symmetricKeys', 'columnMasterKeys', 'columnEncryptionKeys',
  'databaseAuditSpecifications', 'securityPolicies',
  'columns', 'keys', 'constraints', 'tableTriggers', 'indexes', 'statistics', 'parameters',
  'ssisCatalogs', 'ssisFolders', 'ssisProjects', 'ssisPackages', 'ssisEnvironments'
] as const
export type QueryId = typeof queryIds[number]

/** Every icon a node may carry, by its id in the icon registry (`src/shared/icons.ts`); the backend sends these ids as they are. */
export const explorerIcons = [
  'server', 'database', 'table', 'view', 'procedure', 'key', 'role', 'login', 'shield',
  'folder', 'folder-opened', 'device-camera', 'history', 'verified', 'type-hierarchy', 'git-compare', 'file', 'cloud', 'trash',
  'symbol-field', 'references', 'symbol-operator', 'symbol-key', 'pass', 'symbol-constant', 'link', 'zap', 'list-ordered', 'layers', 'graph',
  'symbol-function', 'symbol-parameter', 'arrow-left', 'package', 'symbol-structure', 'code', 'law', 'symbol-numeric', 'milestone',
  'person', 'symbol-namespace', 'workspace-trusted', 'circuit-board', 'file-code', 'book', 'circle-slash', 'list-flat', 'split-horizontal',
  'symbol-ruler', 'archive', 'remote', 'folder-library', 'project', 'symbol-variable', 'symbol-file'
] as const satisfies readonly IconId[]
export type ExplorerIcon = typeof explorerIcons[number]
/** Folders show `folder`, or `folder-opened` while expanded. */
export const folderIcon = 'folder', folderOpenedIcon = 'folder-opened'
export const nodeStatuses = ['disabled', 'unavailable', 'readOnly', 'noAccess'] as const
export type NodeStatus = typeof nodeStatuses[number]
/** Codicons of the status badge at a row icon's bottom right; `readOnly` has none, because the sublabel says it. */
export const statusBadges = { disabled: 'arrow-small-down', unavailable: 'arrow-small-down', noAccess: 'circle-slash', error: 'error', loading: 'loading' } as const satisfies Record<string, CodiconId>

export const filterProperties = ['name', 'schema', 'owner', 'created'] as const
export type FilterProperty = typeof filterProperties[number]
/** SSMS's Filter Settings names. */
export const filterPropertyLabels: { readonly [P in FilterProperty]: string } = { name: 'Name', schema: 'Schema', owner: 'Owner', created: 'Creation Date' }
export const textFilterOps = ['contains', 'equals', 'notContains'] as const
export const dateFilterOps = ['equals', 'lessThan', 'lessOrEqual', 'greaterThan', 'greaterOrEqual', 'between', 'notBetween'] as const

/** The kind of SQL Server: `cloud` is EngineEdition 5, 6, 9, 11 or 12 (Azure SQL Database, Synapse, Edge, Fabric). */
export type Engine = 'box' | 'cloud'
export const engines: readonly Engine[] = ['box', 'cloud']
export const cloudEngineEditions = [5, 6, 9, 11, 12] as const
/**
 * The version band a server's queries and folders are chosen by: 12 below SQL Server 2016, else its major version up to 17.
 * The backend raises it to the band of the catalog columns the server has, since Azure SQL Database and Managed Instance
 * report 12.
 */
export const minBand = 12, maxBand = 17
export const bandOf = (major: number): number => major < 13 ? minBand : Math.min(major, maxBand)
export const engineOf = (edition: number): Engine => (cloudEngineEditions as readonly number[]).includes(edition) ? 'cloud' : 'box'
export interface ExplorerProfile { readonly band: number; readonly engine: Engine }

export interface FolderSpec {
  readonly id: FolderId
  readonly label: string
  /** Who the folder hangs below: the server, a database, or an object whose kind lists it (`KindSpec.folders`). */
  readonly owner: 'server' | 'database' | 'object'
  /** A nested static folder, such as Tables › System Tables. */
  readonly parent?: FolderId
  /** SSMS order among its siblings, planned folders included. */
  readonly order: number
  /** The first ProductMajorVersion that has it. */
  readonly since?: number
  /** The engines that serve it; every engine when absent. */
  readonly engines?: readonly Engine[]
  /** Dynamic rows, listed after the static subfolders. */
  readonly list?: QueryId
  /** The kinds of the listed rows. */
  readonly rows?: readonly NodeKind[]
  readonly filter?: readonly FilterProperty[]
}
/** An SSMS folder Varia does not serve yet. It is documented so docs/object-explorer.md shows the whole tree. */
export interface LaterFolder {
  readonly label: string
  readonly owner: 'server' | 'database'
  readonly parent?: FolderId
  readonly order: number
  readonly since?: number
  /** Its own subfolders, by label. */
  readonly contents?: readonly string[]
}
export type InsertStyle = 'none' | 'onePart' | 'twoPart' | 'raw'
export interface KindSpec {
  readonly kind: NodeKind
  /** Singular, as in tooltips: 'Table'. */
  readonly title: string
  readonly scope: KindScope
  readonly icon: ExplorerIcon
  readonly subtypes?: readonly NodeSubtype[]
  readonly subtypeIcons?: Partial<Record<NodeSubtype, ExplorerIcon>>
  /** Icons for row variants that are not subtypes, such as a primary-key column. */
  readonly variantIcons?: Readonly<Record<string, ExplorerIcon>>
  /** Static child folders, in SSMS order. */
  readonly folders: readonly FolderId[]
  /** Dynamic rows listed directly below the node, after its static folders (SSMS lists an SSIS catalog's folders so). */
  readonly list?: QueryId
  /** The kinds of the listed rows. */
  readonly rows?: readonly NodeKind[]
  /** The longest name a ref of this kind may carry, in UTF-16 code units, when it is longer than sysname's 128. */
  readonly maxName?: number
  readonly subtypeFolders?: Partial<Record<NodeSubtype, readonly FolderId[]>>
  /** Table subtypes whose first page starts with the history table's row (query `historyTable`). */
  readonly historyLookup?: readonly NodeSubtype[]
  /** The SMO class (and URN segment) for scripting; `subtypeSmo` overrides it per subtype. */
  readonly smo?: string
  readonly subtypeSmo?: Partial<Record<NodeSubtype, string>>
  readonly scriptable: boolean
  /** What drag and Copy Name produce: `[name]`, `[schema].[name]`, or the name as is (parameters). */
  readonly insert: InsertStyle
}

const named = ['name'] as const, schemaNamed = ['name', 'schema'] as const
const full = ['name', 'schema', 'owner', 'created'] as const
const serverOnly: readonly Engine[] = ['box']

const folderData: { readonly [F in FolderId]: Omit<FolderSpec, 'id'> } = {
  databases: { label: 'Databases', owner: 'server', order: 1, list: 'userDatabases', rows: ['database'], filter: ['name', 'owner', 'created'] },
  systemDatabases: { label: 'System Databases', owner: 'server', parent: 'databases', order: 1, list: 'systemDatabases', rows: ['database'] },
  databaseSnapshots: { label: 'Database Snapshots', owner: 'server', parent: 'databases', order: 2, engines: serverOnly, list: 'databaseSnapshots', rows: ['database'], filter: ['name', 'created'] },
  serverSecurity: { label: 'Security', owner: 'server', order: 2, engines: serverOnly },
  logins: { label: 'Logins', owner: 'server', parent: 'serverSecurity', order: 1, list: 'logins', rows: ['login'], filter: ['name', 'created'] },
  serverRoles: { label: 'Server Roles', owner: 'server', parent: 'serverSecurity', order: 2, list: 'serverRoles', rows: ['serverRole'], filter: named },
  credentials: { label: 'Credentials', owner: 'server', parent: 'serverSecurity', order: 3, list: 'credentials', rows: ['credential'], filter: named },
  cryptographicProviders: { label: 'Cryptographic Providers', owner: 'server', parent: 'serverSecurity', order: 4, list: 'cryptographicProviders', rows: ['cryptographicProvider'] },
  audits: { label: 'Audits', owner: 'server', parent: 'serverSecurity', order: 5, list: 'audits', rows: ['audit'] },
  serverAuditSpecifications: { label: 'Server Audit Specifications', owner: 'server', parent: 'serverSecurity', order: 6, list: 'serverAuditSpecifications', rows: ['serverAuditSpecification'] },
  serverObjects: { label: 'Server Objects', owner: 'server', order: 3, engines: serverOnly },
  backupDevices: { label: 'Backup Devices', owner: 'server', parent: 'serverObjects', order: 1, list: 'backupDevices', rows: ['backupDevice'] },
  linkedServers: { label: 'Linked Servers', owner: 'server', parent: 'serverObjects', order: 3, list: 'linkedServers', rows: ['linkedServer'], filter: named },
  serverTriggers: { label: 'Triggers', owner: 'server', parent: 'serverObjects', order: 4, list: 'serverTriggers', rows: ['serverTrigger'] },

  tables: { label: 'Tables', owner: 'database', order: 2, list: 'tables', rows: ['table'], filter: full },
  systemTables: { label: 'System Tables', owner: 'database', parent: 'tables', order: 1, list: 'systemTables', rows: ['table'], filter: schemaNamed },
  fileTables: { label: 'FileTables', owner: 'database', parent: 'tables', order: 2, list: 'fileTables', rows: ['table'], filter: full },
  externalTables: { label: 'External Tables', owner: 'database', parent: 'tables', order: 3, since: 13, list: 'externalTables', rows: ['table'], filter: full },
  graphTables: { label: 'Graph Tables', owner: 'database', parent: 'tables', order: 4, since: 14, list: 'graphTables', rows: ['table'], filter: full },
  droppedLedgerTables: { label: 'Dropped Ledger Tables', owner: 'database', parent: 'tables', order: 5, since: 16, list: 'droppedLedgerTables', rows: ['table'], filter: schemaNamed },
  views: { label: 'Views', owner: 'database', order: 3, list: 'views', rows: ['view'], filter: full },
  systemViews: { label: 'System Views', owner: 'database', parent: 'views', order: 1, list: 'systemViews', rows: ['view'], filter: schemaNamed },
  droppedLedgerViews: { label: 'Dropped Ledger Views', owner: 'database', parent: 'views', order: 2, since: 16, list: 'droppedLedgerViews', rows: ['view'], filter: schemaNamed },
  externalResources: { label: 'External Resources', owner: 'database', order: 4, since: 13 },
  externalDataSources: { label: 'External Data Sources', owner: 'database', parent: 'externalResources', order: 1, since: 13, list: 'externalDataSources', rows: ['externalDataSource'], filter: named },
  externalFileFormats: { label: 'External File Formats', owner: 'database', parent: 'externalResources', order: 2, since: 13, list: 'externalFileFormats', rows: ['externalFileFormat'], filter: named },
  synonyms: { label: 'Synonyms', owner: 'database', order: 5, list: 'synonyms', rows: ['synonym'], filter: full },
  programmability: { label: 'Programmability', owner: 'database', order: 6 },
  storedProcedures: { label: 'Stored Procedures', owner: 'database', parent: 'programmability', order: 1, list: 'procedures', rows: ['procedure'], filter: full },
  systemStoredProcedures: { label: 'System Stored Procedures', owner: 'database', parent: 'storedProcedures', order: 1, list: 'systemProcedures', rows: ['procedure'], filter: schemaNamed },
  functions: { label: 'Functions', owner: 'database', parent: 'programmability', order: 2 },
  tableValuedFunctions: { label: 'Table-valued Functions', owner: 'database', parent: 'functions', order: 1, list: 'tableValuedFunctions', rows: ['function'], filter: full },
  scalarValuedFunctions: { label: 'Scalar-valued Functions', owner: 'database', parent: 'functions', order: 2, list: 'scalarFunctions', rows: ['function'], filter: full },
  aggregateFunctions: { label: 'Aggregate Functions', owner: 'database', parent: 'functions', order: 3, list: 'aggregateFunctions', rows: ['function'], filter: schemaNamed },
  databaseTriggers: { label: 'Database Triggers', owner: 'database', parent: 'programmability', order: 3, list: 'databaseTriggers', rows: ['databaseTrigger'], filter: named },
  assemblies: { label: 'Assemblies', owner: 'database', parent: 'programmability', order: 4, list: 'assemblies', rows: ['assembly'], filter: ['name', 'owner', 'created'] },
  types: { label: 'Types', owner: 'database', parent: 'programmability', order: 5 },
  userDefinedDataTypes: { label: 'User-Defined Data Types', owner: 'database', parent: 'types', order: 2, list: 'aliasTypes', rows: ['type'], filter: schemaNamed },
  userDefinedTableTypes: { label: 'User-Defined Table Types', owner: 'database', parent: 'types', order: 3, list: 'tableTypes', rows: ['tableType'], filter: schemaNamed },
  userDefinedTypes: { label: 'User-Defined Types', owner: 'database', parent: 'types', order: 4, list: 'clrTypes', rows: ['type'], filter: schemaNamed },
  xmlSchemaCollections: { label: 'XML Schema Collections', owner: 'database', parent: 'types', order: 5, list: 'xmlSchemaCollections', rows: ['xmlSchemaCollection'], filter: schemaNamed },
  rules: { label: 'Rules', owner: 'database', parent: 'programmability', order: 6, list: 'rules', rows: ['rule'], filter: schemaNamed },
  defaults: { label: 'Defaults', owner: 'database', parent: 'programmability', order: 7, list: 'defaults', rows: ['default'], filter: schemaNamed },
  planGuides: { label: 'Plan Guides', owner: 'database', parent: 'programmability', order: 8, list: 'planGuides', rows: ['planGuide'], filter: named },
  sequences: { label: 'Sequences', owner: 'database', parent: 'programmability', order: 9, list: 'sequences', rows: ['sequence'], filter: full },
  storage: { label: 'Storage', owner: 'database', order: 9 },
  fullTextCatalogs: { label: 'Full Text Catalogs', owner: 'database', parent: 'storage', order: 1, list: 'fullTextCatalogs', rows: ['fullTextCatalog'], filter: named },
  partitionSchemes: { label: 'Partition Schemes', owner: 'database', parent: 'storage', order: 2, list: 'partitionSchemes', rows: ['partitionScheme'], filter: named },
  partitionFunctions: { label: 'Partition Functions', owner: 'database', parent: 'storage', order: 3, list: 'partitionFunctions', rows: ['partitionFunction'], filter: ['name', 'created'] },
  fullTextStoplists: { label: 'Full Text Stoplists', owner: 'database', parent: 'storage', order: 4, list: 'fullTextStoplists', rows: ['fullTextStoplist'], filter: named },
  searchPropertyLists: { label: 'Search Property Lists', owner: 'database', parent: 'storage', order: 5, list: 'searchPropertyLists', rows: ['searchPropertyList'], filter: named },
  databaseSecurity: { label: 'Security', owner: 'database', order: 10 },
  users: { label: 'Users', owner: 'database', parent: 'databaseSecurity', order: 1, list: 'users', rows: ['user'], filter: ['name', 'created'] },
  roles: { label: 'Roles', owner: 'database', parent: 'databaseSecurity', order: 2 },
  databaseRoles: { label: 'Database Roles', owner: 'database', parent: 'roles', order: 1, list: 'databaseRoles', rows: ['databaseRole'], filter: ['name', 'owner'] },
  applicationRoles: { label: 'Application Roles', owner: 'database', parent: 'roles', order: 2, list: 'applicationRoles', rows: ['applicationRole'], filter: named },
  schemas: { label: 'Schemas', owner: 'database', parent: 'databaseSecurity', order: 3, list: 'schemas', rows: ['schema'], filter: ['name', 'owner'] },
  asymmetricKeys: { label: 'Asymmetric Keys', owner: 'database', parent: 'databaseSecurity', order: 4, list: 'asymmetricKeys', rows: ['asymmetricKey'], filter: named },
  certificates: { label: 'Certificates', owner: 'database', parent: 'databaseSecurity', order: 5, list: 'certificates', rows: ['certificate'], filter: named },
  symmetricKeys: { label: 'Symmetric Keys', owner: 'database', parent: 'databaseSecurity', order: 6, list: 'symmetricKeys', rows: ['symmetricKey'], filter: named },
  alwaysEncryptedKeys: { label: 'Always Encrypted Keys', owner: 'database', parent: 'databaseSecurity', order: 7, since: 13 },
  columnMasterKeys: { label: 'Column Master Keys', owner: 'database', parent: 'alwaysEncryptedKeys', order: 1, since: 13, list: 'columnMasterKeys', rows: ['columnMasterKey'], filter: named },
  columnEncryptionKeys: { label: 'Column Encryption Keys', owner: 'database', parent: 'alwaysEncryptedKeys', order: 2, since: 13, list: 'columnEncryptionKeys', rows: ['columnEncryptionKey'], filter: named },
  databaseAuditSpecifications: { label: 'Database Audit Specifications', owner: 'database', parent: 'databaseSecurity', order: 8, list: 'databaseAuditSpecifications', rows: ['databaseAuditSpecification'], filter: named },
  securityPolicies: { label: 'Security Policies', owner: 'database', parent: 'databaseSecurity', order: 9, since: 13, list: 'securityPolicies', rows: ['securityPolicy'], filter: schemaNamed },

  columns: { label: 'Columns', owner: 'object', order: 1, list: 'columns', rows: ['column'] },
  keys: { label: 'Keys', owner: 'object', order: 2, list: 'keys', rows: ['key'] },
  constraints: { label: 'Constraints', owner: 'object', order: 3, list: 'constraints', rows: ['constraint'] },
  tableTriggers: { label: 'Triggers', owner: 'object', order: 4, list: 'tableTriggers', rows: ['trigger'] },
  indexes: { label: 'Indexes', owner: 'object', order: 5, list: 'indexes', rows: ['index'] },
  statistics: { label: 'Statistics', owner: 'object', order: 6, list: 'statistics', rows: ['statistic'] },
  parameters: { label: 'Parameters', owner: 'object', order: 7, list: 'parameters', rows: ['parameter', 'returnValue'] },

  // The SSIS Catalog (D-ssis 3.2): SSISDB lists its folders directly below itself (KindSpec.list), as SSMS shows them.
  integrationServicesCatalogs: { label: 'Integration Services Catalogs', owner: 'server', order: 8, since: 13, list: 'ssisCatalogs', rows: ['ssisCatalog'] },
  ssisProjects: { label: 'Projects', owner: 'object', order: 1, list: 'ssisProjects', rows: ['ssisProject'], filter: named },
  ssisEnvironments: { label: 'Environments', owner: 'object', order: 2, list: 'ssisEnvironments', rows: ['ssisEnvironment'], filter: named },
  ssisPackages: { label: 'Packages', owner: 'object', order: 1, list: 'ssisPackages', rows: ['ssisPackage'], filter: named }
}
export const folderSpecs = Object.fromEntries(folderIds.map(id => [id, { id, ...folderData[id] }])) as { readonly [F in FolderId]: FolderSpec }

export const laterFolders: readonly LaterFolder[] = [
  { label: 'Replication', owner: 'server', order: 4 },
  { label: 'PolyBase', owner: 'server', order: 5, since: 15 },
  { label: 'Always On High Availability', owner: 'server', order: 6 },
  {
    label: 'Management', owner: 'server', order: 7,
    contents: ['Policy Management', 'Data Collection', 'Resource Governor', 'Extended Events', 'Maintenance Plans', 'SQL Server Logs', 'Database Mail',
      'Distributed Transaction Coordinator', 'Legacy']
  },
  { label: 'SQL Server Agent', owner: 'server', order: 9 },
  { label: 'XEvent Profiler', owner: 'server', order: 10 },
  { label: 'Endpoints', owner: 'server', parent: 'serverObjects', order: 2, contents: ['System Endpoints', 'Database Mirroring', 'Service Broker', 'TSQL'] },
  { label: 'Providers', owner: 'server', parent: 'linkedServers', order: 1 },
  { label: 'Database Diagrams', owner: 'database', order: 1 },
  { label: 'Query Store', owner: 'database', order: 7, since: 13 },
  { label: 'Service Broker', owner: 'database', order: 8 },
  { label: 'External Libraries', owner: 'database', parent: 'externalResources', order: 3 },
  { label: 'External Languages', owner: 'database', parent: 'externalResources', order: 4 },
  { label: 'External Models', owner: 'database', parent: 'externalResources', order: 5 },
  { label: 'System Functions', owner: 'database', parent: 'functions', order: 4 },
  { label: 'System Data Types', owner: 'database', parent: 'types', order: 1 },
  { label: 'Database Scoped Credentials', owner: 'database', parent: 'databaseSecurity', order: 10, since: 13 }
]

const tableFolders = ['columns', 'keys', 'constraints', 'tableTriggers', 'indexes', 'statistics'] as const
const historyFolders = ['columns', 'indexes', 'statistics'] as const
const functionColumns = ['columns', 'parameters'] as const
type KindData = Omit<KindSpec, 'kind' | 'folders' | 'scriptable'> & { readonly folders?: readonly FolderId[]; readonly scriptable?: false }
// Most kinds are scriptable leaves; the data names only the exceptions.
const kindData: { readonly [K in NodeKind]: KindData } = {
  server: {
    title: 'Server', scope: 'server', icon: 'server', folders: ['databases', 'serverSecurity', 'serverObjects', 'integrationServicesCatalogs'], smo: 'Server', scriptable: false, insert: 'none'
  },
  login: { title: 'Login', scope: 'serverObject', icon: 'login', smo: 'Login', insert: 'onePart' },
  serverRole: { title: 'Server Role', scope: 'serverObject', icon: 'role', smo: 'ServerRole', insert: 'onePart' },
  credential: { title: 'Credential', scope: 'serverObject', icon: 'key', smo: 'Credential', insert: 'onePart' },
  cryptographicProvider: { title: 'Cryptographic Provider', scope: 'serverObject', icon: 'circuit-board', smo: 'CryptographicProvider', insert: 'onePart' },
  audit: { title: 'Audit', scope: 'serverObject', icon: 'shield', smo: 'Audit', insert: 'onePart' },
  serverAuditSpecification: { title: 'Server Audit Specification', scope: 'serverObject', icon: 'shield', smo: 'ServerAuditSpecification', insert: 'onePart' },
  backupDevice: { title: 'Backup Device', scope: 'serverObject', icon: 'archive', smo: 'BackupDevice', insert: 'onePart' },
  linkedServer: { title: 'Linked Server', scope: 'serverObject', icon: 'remote', smo: 'LinkedServer', insert: 'onePart' },
  serverTrigger: { title: 'Trigger', scope: 'serverObject', icon: 'zap', smo: 'ServerDdlTrigger', insert: 'onePart' },
  database: {
    title: 'Database', scope: 'database', icon: 'database', subtypes: ['system', 'snapshot'], subtypeIcons: { snapshot: 'device-camera' },
    folders: ['tables', 'views', 'externalResources', 'synonyms', 'programmability', 'storage', 'databaseSecurity'], smo: 'Database', insert: 'onePart'
  },
  user: { title: 'User', scope: 'databaseObject', icon: 'person', smo: 'User', insert: 'onePart' },
  databaseRole: { title: 'Database Role', scope: 'databaseObject', icon: 'role', smo: 'DatabaseRole', insert: 'onePart' },
  applicationRole: { title: 'Application Role', scope: 'databaseObject', icon: 'role', smo: 'ApplicationRole', insert: 'onePart' },
  schema: { title: 'Schema', scope: 'databaseObject', icon: 'symbol-namespace', smo: 'Schema', insert: 'onePart' },
  assembly: { title: 'Assembly', scope: 'databaseObject', icon: 'package', smo: 'SqlAssembly', insert: 'onePart' },
  asymmetricKey: { title: 'Asymmetric Key', scope: 'databaseObject', icon: 'key', smo: 'AsymmetricKey', insert: 'onePart' },
  certificate: { title: 'Certificate', scope: 'databaseObject', icon: 'workspace-trusted', smo: 'Certificate', insert: 'onePart' },
  symmetricKey: { title: 'Symmetric Key', scope: 'databaseObject', icon: 'key', smo: 'SymmetricKey', insert: 'onePart' },
  columnMasterKey: { title: 'Column Master Key', scope: 'databaseObject', icon: 'key', smo: 'ColumnMasterKey', insert: 'onePart' },
  columnEncryptionKey: { title: 'Column Encryption Key', scope: 'databaseObject', icon: 'key', smo: 'ColumnEncryptionKey', insert: 'onePart' },
  databaseAuditSpecification: { title: 'Database Audit Specification', scope: 'databaseObject', icon: 'shield', smo: 'DatabaseAuditSpecification', insert: 'onePart' },
  databaseTrigger: { title: 'Trigger', scope: 'databaseObject', icon: 'zap', smo: 'DatabaseDdlTrigger', insert: 'onePart' },
  externalDataSource: { title: 'External Data Source', scope: 'databaseObject', icon: 'cloud', smo: 'ExternalDataSource', insert: 'onePart' },
  externalFileFormat: { title: 'External File Format', scope: 'databaseObject', icon: 'file-code', smo: 'ExternalFileFormat', insert: 'onePart' },
  fullTextCatalog: { title: 'Full-Text Catalog', scope: 'databaseObject', icon: 'book', smo: 'FullTextCatalog', insert: 'onePart' },
  fullTextStoplist: { title: 'Full-Text Stoplist', scope: 'databaseObject', icon: 'circle-slash', smo: 'FullTextStopList', insert: 'onePart' },
  partitionScheme: { title: 'Partition Scheme', scope: 'databaseObject', icon: 'split-horizontal', smo: 'PartitionScheme', insert: 'onePart' },
  partitionFunction: { title: 'Partition Function', scope: 'databaseObject', icon: 'symbol-ruler', smo: 'PartitionFunction', insert: 'onePart' },
  searchPropertyList: { title: 'Search Property List', scope: 'databaseObject', icon: 'list-flat', smo: 'SearchPropertyList', insert: 'onePart' },
  planGuide: { title: 'Plan Guide', scope: 'databaseObject', icon: 'milestone', smo: 'PlanGuide', insert: 'onePart' },
  table: {
    title: 'Table', scope: 'schemaObject', icon: 'table',
    subtypes: ['systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'ledgerHistory', 'graphNode', 'graphEdge', 'fileTable', 'external', 'droppedLedger', 'system'],
    subtypeIcons: {
      history: 'history', ledgerHistory: 'history', updatableLedger: 'verified', appendOnlyLedger: 'verified', graphNode: 'type-hierarchy', graphEdge: 'git-compare',
      fileTable: 'file', external: 'cloud', droppedLedger: 'trash'
    },
    folders: tableFolders,
    subtypeFolders: { history: historyFolders, ledgerHistory: historyFolders, droppedLedger: historyFolders, external: ['columns', 'statistics'] },
    historyLookup: ['systemVersioned', 'updatableLedger'], smo: 'Table', insert: 'twoPart'
  },
  view: {
    title: 'View', scope: 'schemaObject', icon: 'view', subtypes: ['system', 'ledger', 'droppedLedger'], subtypeIcons: { ledger: 'verified', droppedLedger: 'trash' },
    folders: ['columns', 'tableTriggers', 'indexes', 'statistics'], smo: 'View', insert: 'twoPart'
  },
  synonym: { title: 'Synonym', scope: 'schemaObject', icon: 'link', smo: 'Synonym', insert: 'twoPart' },
  procedure: {
    title: 'Stored Procedure', scope: 'schemaObject', icon: 'procedure', subtypes: ['sql', 'clr', 'extended', 'replicationFilter', 'system'], folders: ['parameters'],
    smo: 'StoredProcedure', insert: 'twoPart'
  },
  function: {
    title: 'Function', scope: 'schemaObject', icon: 'symbol-function', subtypes: ['inline', 'tableValued', 'clrTableValued', 'scalar', 'clrScalar', 'aggregate'],
    folders: ['parameters'], subtypeFolders: { inline: functionColumns, tableValued: functionColumns, clrTableValued: functionColumns },
    smo: 'UserDefinedFunction', subtypeSmo: { aggregate: 'UserDefinedAggregate' }, insert: 'twoPart'
  },
  sequence: { title: 'Sequence', scope: 'schemaObject', icon: 'symbol-numeric', smo: 'Sequence', insert: 'twoPart' },
  type: {
    title: 'Type', scope: 'schemaObject', icon: 'symbol-structure', subtypes: ['alias', 'clr'], smo: 'UserDefinedDataType', subtypeSmo: { clr: 'UserDefinedType' }, insert: 'twoPart'
  },
  tableType: { title: 'Table Type', scope: 'schemaObject', icon: 'table', folders: ['columns', 'keys', 'constraints', 'indexes'], smo: 'UserDefinedTableType', insert: 'twoPart' },
  xmlSchemaCollection: { title: 'XML Schema Collection', scope: 'schemaObject', icon: 'code', smo: 'XmlSchemaCollection', insert: 'twoPart' },
  rule: { title: 'Rule', scope: 'schemaObject', icon: 'law', smo: 'Rule', insert: 'twoPart' },
  default: { title: 'Default', scope: 'schemaObject', icon: 'symbol-constant', smo: 'Default', insert: 'twoPart' },
  securityPolicy: { title: 'Security Policy', scope: 'schemaObject', icon: 'shield', smo: 'SecurityPolicy', insert: 'twoPart' },
  column: {
    title: 'Column', scope: 'child', icon: 'symbol-field', variantIcons: { primaryKey: 'key', foreignKey: 'references', computed: 'symbol-operator' },
    smo: 'Column', scriptable: false, insert: 'onePart'
  },
  key: {
    title: 'Key', scope: 'child', icon: 'key', subtypes: ['primary', 'unique', 'foreign'], subtypeIcons: { unique: 'symbol-key', foreign: 'references' },
    smo: 'Index', subtypeSmo: { foreign: 'ForeignKey' }, insert: 'onePart'
  },
  constraint: {
    title: 'Constraint', scope: 'child', icon: 'pass', subtypes: ['check', 'default', 'edge'], subtypeIcons: { default: 'symbol-constant', edge: 'link' },
    smo: 'Check', subtypeSmo: { default: 'DefaultConstraint', edge: 'EdgeConstraint' }, insert: 'onePart'
  },
  trigger: { title: 'Trigger', scope: 'child', icon: 'zap', smo: 'Trigger', insert: 'onePart' },
  index: {
    title: 'Index', scope: 'child', icon: 'list-ordered',
    subtypes: ['clustered', 'nonclustered', 'clusteredColumnstore', 'nonclusteredColumnstore', 'xml', 'spatial', 'hash', 'other'],
    subtypeIcons: { clusteredColumnstore: 'layers', nonclusteredColumnstore: 'layers' }, smo: 'Index', insert: 'onePart'
  },
  statistic: { title: 'Statistic', scope: 'child', icon: 'graph', smo: 'Statistic', insert: 'onePart' },
  parameter: { title: 'Parameter', scope: 'child', icon: 'symbol-parameter', subtypes: ['input', 'output'], smo: 'Parameter', scriptable: false, insert: 'raw' },
  returnValue: { title: 'Return value', scope: 'childUnnamed', icon: 'arrow-left', scriptable: false, insert: 'none' },
  // SSIS Catalog objects are named by folder and project, not by database and schema, and are not SQL objects: nothing
  // scripts or inserts them. A package that is not an entry point is the subtype `child`.
  ssisCatalog: { title: 'Integration Services Catalog', scope: 'ssisCatalog', icon: 'database', list: 'ssisFolders', rows: ['ssisFolder'], scriptable: false, insert: 'none' },
  ssisFolder: { title: 'Folder', scope: 'ssisFolder', icon: 'folder-library', folders: ['ssisProjects', 'ssisEnvironments'], scriptable: false, insert: 'none' },
  ssisProject: { title: 'Project', scope: 'ssisFolderObject', icon: 'project', folders: ['ssisPackages'], scriptable: false, insert: 'none' },
  ssisPackage: {
    title: 'Package', scope: 'ssisProjectObject', icon: 'package', subtypes: ['entryPoint', 'child'], subtypeIcons: { child: 'symbol-file' }, maxName: 260,
    scriptable: false, insert: 'none'
  },
  ssisEnvironment: { title: 'Environment', scope: 'ssisFolderObject', icon: 'symbol-variable', scriptable: false, insert: 'none' }
}
export const kindSpecs = Object.fromEntries(nodeKinds.map(kind => {
  const { folders = [], scriptable = true, ...rest } = kindData[kind]
  return [kind, { kind, ...rest, folders, scriptable }]
})) as { readonly [K in NodeKind]: KindSpec }

export const explorerLimits = {
  pageSize: 2000, folderCap: 100_000, nodeBudget: 250_000, inFlightPerConnection: 4, inFlightTotal: 8, queuePerConnection: 512,
  cancelBatch: 256, siblingLoads: 50, filters: 64, watchdogMs: 60_000, loadingRowDelayMs: 150, typeAheadMs: 1000,
  typeAheadMax: 64, rowHeight: 22, indent: 16, overscan: 10, deleteSlice: 10_000,
  cursorLength: 1650, label: 300, sublabel: 200, detail: 512, message: 512, maxName: 260
} as const
/** The name bound of a kind's refs: sysname's 128 UTF-16 code units unless the kind declares a longer one. */
export const maxNameOf = (spec: Pick<KindSpec, 'maxName'>): number => spec.maxName ?? maxIdentifierLength

const byOrder = (a: { readonly order: number }, b: { readonly order: number }) => a.order - b.order
const subfolderMap = new Map<FolderId, readonly FolderId[]>(folderIds.map(id => [id, folderIds.filter(child => folderSpecs[child].parent === id).map(child => folderSpecs[child]).sort(byOrder).map(spec => spec.id)]))
/** A folder's static subfolders, in SSMS order; its dynamic rows follow them. */
export const subfolders = (folder: FolderId): readonly FolderId[] => subfolderMap.get(folder) ?? []
/** The outermost folder above `folder` (itself when it has no parent): the one a kind's `folders` lists. */
export function rootFolder(folder: FolderId): FolderId {
  let id = folder
  while (folderSpecs[id].parent) id = folderSpecs[id].parent!
  return id
}
/** The static folders below a node of this kind and subtype. */
export const foldersFor = (kind: NodeKind, subtype?: NodeSubtype): readonly FolderId[] => (subtype && kindSpecs[kind].subtypeFolders?.[subtype]) || kindSpecs[kind].folders
const ownerMap = new Map<FolderId, readonly NodeKind[]>(folderIds.map(id => {
  const root = rootFolder(id)
  return [id, nodeKinds.filter(kind => [kindSpecs[kind].folders, ...Object.values(kindSpecs[kind].subtypeFolders ?? {})].some(set => set?.includes(root)))]
}))
/** The kinds a folder can hang below, whatever their subtype: a folder ref's `owner` must be one of them. */
export const folderOwnerKinds = (folder: FolderId): readonly NodeKind[] => ownerMap.get(folder) ?? []
const parentMap = new Map<NodeKind, readonly ParentKind[]>(nodeKinds.filter(kind => kindSpecs[kind].scope === 'child' || kindSpecs[kind].scope === 'childUnnamed').map(kind => [kind,
  parentKinds.filter(parent => folderIds.some(id => folderSpecs[id].rows?.includes(kind) && folderOwnerKinds(id).includes(parent)))]))
/** The kinds a child ref's `parent` may have: the owners of the folders that list it. Empty for other scopes. */
export const childParentKinds = (kind: NodeKind): readonly ParentKind[] => parentMap.get(kind) ?? []

/** A folder's gates combined with those of the folders above it. */
export function folderGates(folder: FolderId): { readonly since?: number; readonly engines: readonly Engine[] } {
  let since: number | undefined, allowed = engines
  for (let spec: FolderSpec | undefined = folderSpecs[folder]; spec; spec = spec.parent ? folderSpecs[spec.parent] : undefined) {
    const declared = spec.engines
    if (spec.since !== undefined) since = Math.max(since ?? spec.since, spec.since)
    if (declared) allowed = allowed.filter(engine => declared.includes(engine))
  }
  return { since, engines: allowed }
}
/** Served on this server: the folder and every folder above it are old enough and available on its engine. */
export function folderServed(folder: FolderId, profile: ExplorerProfile): boolean {
  const gates = folderGates(folder)
  return (gates.since ?? minBand) <= profile.band && gates.engines.includes(profile.engine)
}
/** The static folders the backend serves first: below an object, or below a folder (its subfolders). */
export function staticChildren(node: { readonly kind: NodeKind; readonly subtype?: NodeSubtype } | { readonly folder: FolderId }, profile: ExplorerProfile): readonly FolderId[] {
  const ids = 'folder' in node ? subfolders(node.folder) : foldersFor(node.kind, node.subtype)
  return ids.filter(id => folderServed(id, profile))
}

// Compact sorted-key JSON, so the embedded copy is stable and each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/**
 * The catalogue as the backend embeds it: `{"cloudEngineEditions", "folders", "kinds", "queries", "scopes", "version"}`,
 * keys sorted and everything derived spelled out, so C# needs no rules of its own: each folder's `since` and `engines`
 * include the gates of the folders above it, and kinds carry every collection and a child's `parents`.
 */
export function explorerCatalogJson(): string {
  const folders = folderIds.map(id => ({ ...folderSpecs[id], ...folderGates(id), filter: folderSpecs[id].filter ?? [] }))
  const kinds = nodeKinds.map(kind => {
    const spec = kindSpecs[kind]
    return {
      ...spec, subtypes: spec.subtypes ?? [], subtypeIcons: spec.subtypeIcons ?? {}, variantIcons: spec.variantIcons ?? {}, subtypeFolders: spec.subtypeFolders ?? {},
      historyLookup: spec.historyLookup ?? [], subtypeSmo: spec.subtypeSmo ?? {}, parents: childParentKinds(kind), rows: spec.rows ?? [], maxName: maxNameOf(spec)
    }
  })
  return [
    '{',
    `  "cloudEngineEditions": ${line(cloudEngineEditions)},`,
    `  "folders": ${block(folders)},`,
    `  "kinds": ${block(kinds)},`,
    `  "queries": ${line(queryIds)},`,
    `  "scopes": ${line(scopeFields)},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
