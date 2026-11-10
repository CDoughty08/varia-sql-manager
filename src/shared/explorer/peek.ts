// Object Explorer's Peek: the kinds it describes, the properties it shows for each (grouped as SSMS's Properties pages
// group them), where each kind's definition comes from, and its limits. explorer.peek reads one constant batch per kind
// (backend Explorer/PeekSql.cs) whose result columns are these facts' ids, in this order; the backend takes the list from
// the `peek` block of the embedded Explorer/explorer-catalog.json, which explorerCatalogJson writes.
import type { ExplorerError } from '../contracts.ts'
import type { NodeKind, NodeSubtype } from './catalog.ts'
import type { ObjectRef } from './refs.ts'

export const peekKinds = ['table', 'view', 'procedure', 'function', 'index', 'trigger', 'databaseTrigger', 'serverTrigger', 'database', 'login', 'synonym', 'sequence', 'type',
  'tableType'] as const satisfies readonly NodeKind[]
export type PeekKind = typeof peekKinds[number]
export const isPeekKind = (kind: string): kind is PeekKind => (peekKinds as readonly string[]).includes(kind)

/**
 * How a fact's value travels and shows: `text` a string, `code` a catalog code (`NON_TEMPORAL_TABLE`, `PAGE`) shown in words
 * as SSMS shows it, `date` the server's local time as `yyyy-mm-ddThh:mm:ss`, `bool` a boolean, `count` a whole number, `kb`
 * a whole number of kilobytes.
 */
export const peekFormats = ['text', 'code', 'date', 'bool', 'count', 'kb'] as const
export type PeekFormat = typeof peekFormats[number]
/** `since`: the first version band whose catalog has the fact; on older servers the reply leaves it out. */
export interface PeekFact { readonly id: string; readonly label: string; readonly format: PeekFormat; readonly since?: number }
/**
 * `subtypes`: the card shows the group only for these subtypes of the kind (an alias type's base type, a CLR type's assembly).
 * `refused`: the group is read by a statement of its own, last in the batch, which a login may be refused (a DMV that needs
 * VIEW SERVER STATE): the reply then names the group in `refused`, the other facts still come, and the card shows these words.
 */
export interface PeekGroup { readonly id: string; readonly title: string; readonly facts: readonly PeekFact[]; readonly subtypes?: readonly NodeSubtype[]; readonly refused?: string }
/**
 * Lists a peek reads with its facts, in the same batch, each on a tab of its own: an index's key and included columns, a
 * trigger's events, a database's files, a login's server roles, and its user mapping (one statement in each database it can
 * read, after the batch). Each keeps at most `peekLimits.listRows` rows, in the order the backend reads them.
 */
export const peekListIds = ['indexColumns', 'events', 'files', 'serverRoles', 'userMapping'] as const
export type PeekListId = typeof peekListIds[number]
export interface PeekListColumn { readonly id: string; readonly label: string; readonly format: PeekFormat }
export interface PeekListSpec { readonly id: PeekListId; readonly title: string; readonly columns: readonly PeekListColumn[]; readonly empty: string }
const column = (id: string, label: string, format: PeekFormat): PeekListColumn => ({ id, label, format })
export const peekLists: { readonly [L in PeekListId]: PeekListSpec } = {
  indexColumns: {
    id: 'indexColumns', title: 'Columns', empty: 'No columns.',
    columns: [column('name', 'Column', 'text'), column('included', 'Included', 'bool'), column('descending', 'Descending', 'bool'), column('type', 'Type', 'text')]
  },
  events: { id: 'events', title: 'Events', empty: 'No events.', columns: [column('event', 'Event', 'code'), column('first', 'First', 'bool'), column('last', 'Last', 'bool')] },
  files: {
    id: 'files', title: 'Files', empty: 'None the login can see (that needs VIEW ANY DEFINITION, CREATE DATABASE or ALTER ANY DATABASE).',
    columns: [column('name', 'Logical name', 'text'), column('type', 'Type', 'code'), column('size', 'Size', 'kb'), column('growth', 'Autogrowth / Maxsize', 'text'), column('path', 'Path', 'text')]
  },
  serverRoles: { id: 'serverRoles', title: 'Server roles', empty: 'Only public.', columns: [column('role', 'Role', 'text'), column('fixed', 'Fixed role', 'bool')] },
  userMapping: {
    id: 'userMapping', title: 'User mapping', empty: 'No user in the databases the login can read.',
    columns: [column('database', 'Database', 'text'), column('user', 'User', 'text'), column('defaultSchema', 'Default schema', 'text')]
  }
}
/**
 * Peek's tabs (the card's and a promoted tab's): `definition` the object's text, `members` its Columns or Parameters folder
 * (explorer.children, as the tree lists it), `dependencies` what the object uses and what uses it (explorer.peekDependencies),
 * `rows` its first rows (Select Top N Rows' script through query.execute, shown in the results grid), and the kind's lists
 * (`peekLists`), which come with the facts. Members, Dependencies and Top rows are read the first time their tab is chosen,
 * never with the facts: Dependencies stays its own request so that a login refused sys.sql_expression_dependencies still sees
 * the properties.
 */
export const peekTabs = ['definition', 'members', 'dependencies', 'rows', ...peekListIds] as const
export type PeekTab = typeof peekTabs[number]
/**
 * `module`: the definition is the module's text from sys.sql_modules (sys.server_sql_modules for a server trigger), read with
 * the facts. `script`: the kind has no stored text, so the card asks Script As (scripting.script, CREATE) for it. `tabs`: the
 * card's tabs in order, Definition first. `members`: the folder the Columns or Parameters tab lists, for kinds with that tab.
 */
export interface PeekKindSpec {
  readonly kind: PeekKind
  readonly definition: 'module' | 'script'
  readonly tabs: readonly PeekTab[]
  readonly members?: 'columns' | 'parameters'
  readonly groups: readonly PeekGroup[]
}

const fact = (id: string, label: string, format: PeekFormat, since?: number): PeekFact => since === undefined ? { id, label, format } : { id, label, format, since }
const dated = [fact('created', 'Created', 'date'), fact('modified', 'Last modified', 'date')]
const owned = [fact('schema', 'Schema', 'text'), ...dated, fact('systemObject', 'System object', 'bool')]
const sqlOptions = [fact('ansiNulls', 'ANSI NULLs', 'bool'), fact('quotedIdentifier', 'Quoted identifier', 'bool')]
const triggerGeneral = [...dated, fact('systemObject', 'System object', 'bool'), fact('disabled', 'Disabled', 'bool'), fact('clr', 'CLR', 'bool')]
const triggerOptions = [fact('executeAs', 'Execute as', 'text'), ...sqlOptions]

export const peekSpecs: { readonly [K in PeekKind]: PeekKindSpec } = {
  table: {
    kind: 'table', definition: 'script', tabs: ['definition', 'members', 'dependencies', 'rows'], members: 'columns', groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('replicated', 'Replicated', 'bool'), fact('lockEscalation', 'Lock escalation', 'code'),
        fact('memoryOptimized', 'Memory optimized', 'bool'), fact('temporal', 'Temporal', 'code', 13), fact('ledger', 'Ledger', 'code', 16)] },
      { id: 'storage', title: 'Storage', facts: [fact('rowCount', 'Row count', 'count'), fact('dataSpace', 'Data space', 'kb'), fact('indexSpace', 'Index space', 'kb'),
        fact('filegroup', 'Filegroup', 'text'), fact('textFilegroup', 'Text filegroup', 'text'), fact('partitioned', 'Partitioned', 'bool'), fact('compression', 'Data compression', 'code')] }
    ]
  },
  view: {
    kind: 'view', definition: 'module', tabs: ['definition', 'members', 'dependencies', 'rows'], members: 'columns', groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('schemaBound', 'Schema bound', 'bool'), fact('indexed', 'Indexed', 'bool'), ...sqlOptions] }
    ]
  },
  procedure: {
    kind: 'procedure', definition: 'module', tabs: ['definition', 'members', 'dependencies'], members: 'parameters', groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('recompile', 'Recompile', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'), ...sqlOptions] }
    ]
  },
  function: {
    kind: 'function', definition: 'module', tabs: ['definition', 'members', 'dependencies'], members: 'parameters', groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('functionType', 'Function type', 'text')] },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('schemaBound', 'Schema bound', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'),
        fact('nullOnNullInput', 'Returns NULL on NULL input', 'bool'), ...sqlOptions] }
    ]
  },
  // Index Properties' General, Options and Storage pages, and the usage sys.dm_db_index_usage_stats has kept since the server started.
  index: {
    kind: 'index', definition: 'script', tabs: ['definition', 'indexColumns'], groups: [
      { id: 'general', title: 'General', facts: [fact('indexType', 'Index type', 'text'), fact('unique', 'Unique', 'bool'), fact('primaryKey', 'Primary key', 'bool'),
        fact('uniqueConstraint', 'Unique constraint', 'bool'), fact('disabled', 'Disabled', 'bool'), fact('filter', 'Filter', 'text')] },
      { id: 'options', title: 'Options', facts: [fact('fillFactor', 'Fill factor', 'count'), fact('padIndex', 'Pad index', 'bool'), fact('ignoreDupKey', 'Ignore duplicate values', 'bool'),
        fact('allowRowLocks', 'Allow row locks', 'bool'), fact('allowPageLocks', 'Allow page locks', 'bool'), fact('noRecompute', 'Statistics not recomputed', 'bool'),
        fact('optimizeForSequentialKey', 'Optimize for sequential key', 'bool', 15)] },
      { id: 'storage', title: 'Storage', facts: [fact('rowCount', 'Row count', 'count'), fact('space', 'Space used', 'kb'), fact('filegroup', 'Filegroup', 'text'),
        fact('partitionScheme', 'Partition scheme', 'text'), fact('partitions', 'Partitions', 'count'), fact('compression', 'Data compression', 'code')] },
      { id: 'usage', title: 'Usage since the server started', refused: 'The login cannot read index usage (that needs VIEW SERVER STATE).', facts: [
        fact('userSeeks', 'User seeks', 'count'), fact('userScans', 'User scans', 'count'), fact('userLookups', 'User lookups', 'count'), fact('userUpdates', 'User updates', 'count'),
        fact('lastSeek', 'Last seek', 'date'), fact('lastScan', 'Last scan', 'date'), fact('lastLookup', 'Last lookup', 'date'), fact('lastUpdate', 'Last update', 'date')] }
    ]
  },
  trigger: {
    kind: 'trigger', definition: 'module', tabs: ['definition', 'events', 'dependencies'], groups: [
      { id: 'general', title: 'General', facts: [...triggerGeneral, fact('insteadOf', 'Instead of', 'bool')] },
      { id: 'options', title: 'Options', facts: [fact('notForReplication', 'Not for replication', 'bool'), ...triggerOptions] }
    ]
  },
  databaseTrigger: {
    kind: 'databaseTrigger', definition: 'module', tabs: ['definition', 'events'], groups: [
      { id: 'general', title: 'General', facts: triggerGeneral },
      { id: 'options', title: 'Options', facts: triggerOptions }
    ]
  },
  serverTrigger: {
    kind: 'serverTrigger', definition: 'module', tabs: ['definition', 'events'], groups: [
      { id: 'general', title: 'General', facts: triggerGeneral },
      { id: 'options', title: 'Options', facts: triggerOptions }
    ]
  },
  // Database Properties' General and Options pages, from sys.databases and sys.master_files on the server, so a database that is
  // offline or restoring still peeks.
  database: {
    kind: 'database', definition: 'script', tabs: ['definition', 'files'], groups: [
      { id: 'general', title: 'General', facts: [fact('status', 'Status', 'code'), fact('owner', 'Owner', 'text'), fact('created', 'Date created', 'date'), fact('size', 'Size', 'kb'),
        fact('dataSize', 'Data files', 'kb'), fact('logSize', 'Log files', 'kb'), fact('userAccess', 'Restrict access', 'code'), fact('readOnly', 'Read only', 'bool')] },
      { id: 'options', title: 'Options', facts: [fact('recoveryModel', 'Recovery model', 'code'), fact('compatibilityLevel', 'Compatibility level', 'count'), fact('collation', 'Collation', 'text'),
        fact('containment', 'Containment type', 'code'), fact('pageVerify', 'Page verify', 'text'), fact('autoClose', 'Auto close', 'bool'), fact('autoShrink', 'Auto shrink', 'bool'),
        fact('autoCreateStats', 'Auto create statistics', 'bool'), fact('autoUpdateStats', 'Auto update statistics', 'bool'), fact('autoUpdateStatsAsync', 'Auto update statistics asynchronously', 'bool'),
        fact('snapshotIsolation', 'Snapshot isolation', 'code'), fact('readCommittedSnapshot', 'Read committed snapshot', 'bool'), fact('encrypted', 'Encryption enabled', 'bool'),
        fact('queryStore', 'Query Store', 'bool', 13), fact('acceleratedRecovery', 'Accelerated database recovery', 'bool', 15), fact('ledger', 'Ledger', 'bool', 16)] }
    ]
  },
  // Login Properties' General and Status pages. Nothing reads LOGINPROPERTY or a password hash (CatalogSql.SecretUses), so
  // Must change and Locked out are not shown.
  login: {
    kind: 'login', definition: 'script', tabs: ['definition', 'serverRoles', 'userMapping'], groups: [
      { id: 'general', title: 'General', facts: [fact('loginType', 'Login type', 'text'), ...dated, fact('defaultDatabase', 'Default database', 'text'),
        fact('defaultLanguage', 'Default language', 'text')] },
      { id: 'status', title: 'Status', facts: [fact('disabled', 'Disabled', 'bool'), fact('connectDenied', 'Connect denied', 'bool'), fact('enforcePolicy', 'Enforce password policy', 'bool'),
        fact('enforceExpiration', 'Enforce password expiration', 'bool')] }
    ]
  },
  synonym: {
    kind: 'synonym', definition: 'script', tabs: ['definition', 'dependencies'], groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'base', title: 'Base object', facts: [fact('baseObject', 'Base object', 'text'), fact('baseServer', 'Server', 'text'), fact('baseDatabase', 'Database', 'text'),
        fact('baseSchema', 'Object schema', 'text'), fact('baseName', 'Object name', 'text')] }
    ]
  },
  sequence: {
    kind: 'sequence', definition: 'script', tabs: ['definition', 'dependencies'], groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'sequence', title: 'Sequence', facts: [fact('dataType', 'Data type', 'text'), fact('startValue', 'Start value', 'text'), fact('increment', 'Increment by', 'text'),
        fact('minimum', 'Minimum value', 'text'), fact('maximum', 'Maximum value', 'text'), fact('cycle', 'Cycle', 'bool'), fact('cache', 'Cache', 'text'),
        fact('currentValue', 'Current value', 'text'), fact('lastUsedValue', 'Last used value', 'text', 14), fact('exhausted', 'Exhausted', 'bool')] }
    ]
  },
  type: {
    kind: 'type', definition: 'script', tabs: ['definition', 'dependencies'], groups: [
      { id: 'general', title: 'General', facts: [fact('schema', 'Schema', 'text'), fact('allowNulls', 'Allow NULLs', 'bool'), fact('maxLength', 'Bytes', 'count')] },
      { id: 'alias', title: 'Alias type', subtypes: ['alias'], facts: [fact('baseType', 'Data type', 'text'), fact('collation', 'Collation', 'text'), fact('default', 'Default', 'text'),
        fact('rule', 'Rule', 'text')] },
      { id: 'clr', title: 'CLR type', subtypes: ['clr'], facts: [fact('assembly', 'Assembly', 'text'), fact('className', 'Class', 'text'), fact('binaryOrdered', 'Binary ordered', 'bool'),
        fact('fixedLength', 'Fixed length', 'bool')] }
    ]
  },
  tableType: {
    kind: 'tableType', definition: 'script', tabs: ['definition', 'members', 'dependencies'], members: 'columns', groups: [
      { id: 'general', title: 'General', facts: [fact('schema', 'Schema', 'text'), ...dated, fact('memoryOptimized', 'Memory optimized', 'bool')] }
    ]
  }
}

/** The tabs a kind's card shows, in order. */
export const peekTabsOf = (kind: PeekKind): readonly PeekTab[] => peekSpecs[kind].tabs
/** Whether a kind's card has a tab. */
export const peekHas = (kind: PeekKind, tab: PeekTab): boolean => peekSpecs[kind].tabs.includes(tab)
/** A tab that shows one of the kind's lists. */
export const isPeekListTab = (tab: PeekTab): tab is PeekListId => (peekListIds as readonly string[]).includes(tab)
/** The lists a kind reads with its facts, in reply order. */
export const peekListsOf = (kind: PeekKind): readonly PeekListId[] => peekSpecs[kind].tabs.filter(isPeekListTab)
/** A tab's title for a kind. */
export const peekTabTitle = (kind: PeekKind, tab: PeekTab): string =>
  tab === 'definition' ? 'Definition' : tab === 'members' ? (peekSpecs[kind].members === 'parameters' ? 'Parameters' : 'Columns') : tab === 'dependencies' ? 'Dependencies'
    : tab === 'rows' ? 'Top rows' : peekLists[tab].title

/** A kind's facts in reply-column order. */
export const peekFacts = (kind: PeekKind): readonly PeekFact[] => peekSpecs[kind].groups.flatMap(group => group.facts)

export const peekLimits = {
  /**
   * Module text per reply, in UTF-16 code units: explorer.peek answers the first page with the facts, and a longer text comes in
   * further pages (explorer.peekDefinition), put together by the renderer. Text is never cut; pages only keep each reply far
   * under the protocol's 16 MiB (a page is at most 3 MB of UTF-8).
   */
  definitionPageChars: 1_000_000,
  /**
   * The longest module text Peek reads, in UTF-16 code units: 2^27 (256 MB as a JavaScript string, held by the view and its
   * editor's model). A bound on the renderer's memory, not SQL Server's: a module that long only comes from dynamic SQL or a
   * very large batch. A longer one says so instead of showing part of it.
   */
  definitionMaxChars: 134_217_728,
  /** The backend's own budget for a peek; past it the reply is a TIMEOUT value. */
  budgetMs: 15_000,
  /** How long the pointer rests on a row with Ctrl (Cmd on macOS) held before the card opens. */
  hoverMs: 350,
  /**
   * A table's CREATE scripts the window keeps (in memory only), and their UTF-16 code units in all: a script is reused while
   * the table's modified time is the one it was made at, so peeking a table again starts no SMO job.
   */
  scriptCacheEntries: 32,
  scriptCacheChars: 4_000_000,
  /**
   * How long a kept script is good for. The modified time misses changes a script can include (extended properties, triggers,
   * permissions) and counts whole seconds, so a kept script also expires; Refresh scripts the table again at once.
   */
  scriptCacheMs: 120_000,
  /** Table scripts a replaced card leaves running so they can be cached; one more cancels the oldest. */
  backgroundScripts: 2,
  /** Rows of the Columns or Parameters folder the tab lists; a folder with more says so. */
  members: 1024,
  /** Objects listed each way on the Dependencies tab; more are marked `usesTruncated` or `usedByTruncated`. */
  dependencies: 200,
  /** Rows the Top rows tab reads: Select Top N Rows' script with this N, in no order, as SSMS's Select Top rows. */
  rows: 10,
  /** Cards Back remembers when dependencies are followed one after another. */
  backSteps: 16,
  /** Rows each of a kind's lists keeps (`peekLists`); a list with more is marked `truncated`. */
  listRows: 1024,
  /** Databases a login's User mapping reads, in name order; more are counted as `unread`. */
  mappingDatabases: 256
} as const

export type PeekValue = string | number | boolean | null
/**
 * One object on the Dependencies tab. `database` and `server` name another database or a linked server (references only, so
 * the object may not exist); `kind` is its Object Explorer kind when it is in this database and of a kind the tree lists by
 * name, and absent otherwise (a trigger, a column-less reference). `foreignKey`: a foreign key, not code, makes the link.
 */
export interface PeekDependency {
  readonly name: string
  readonly schema?: string
  readonly database?: string
  readonly server?: string
  readonly kind?: NodeKind
  /** The subtype the tree lists it with, so a followed dependency offers the same Script As verbs and folders. */
  readonly subtype?: NodeSubtype
  readonly foreignKey?: true
}
export interface PeekParams {
  readonly connectionId: string
  /** The renderer's id for this read, which cancellation (varia:explorer-cancel) names. */
  readonly requestId: string
  /** An object of a kind Peek describes (`peekKinds`); explorer.peekDependencies only one whose card has that tab. */
  readonly target: ObjectRef
}
/**
 * One of a kind's lists: rows of the list's columns, in order. `truncated`: there were more than `peekLimits.listRows`.
 * `unread`: databases a login's User mapping could not read (gone, offline, refused, or past `peekLimits.mappingDatabases`).
 */
export interface PeekList {
  readonly rows: readonly (readonly PeekValue[])[]
  readonly truncated?: true
  readonly unread?: number
}
export interface PeekResult {
  /** Fact id to value, for the kind's facts the server's band has; null where the catalog has no value (a heap's index space is 0, not null). */
  readonly facts: Readonly<Record<string, PeekValue>>
  /**
   * `module` kinds: the module's text, or its first page (`peekLimits.definitionPageChars`, never ending inside a surrogate
   * pair) when `definitionLength` is set; absent when it is encrypted or the login may not see it.
   */
  readonly definition?: string
  /** Only when `definition` is a first page: the whole text's length in UTF-16 code units, and its module's modify_date (ms). */
  readonly definitionLength?: number
  readonly definitionStamp?: number
  /** The kind's lists (`peekListsOf`), by id. */
  readonly lists?: Readonly<Partial<Record<PeekListId, PeekList>>>
  /** Groups with `refused` words whose statement the login was refused: their facts are absent. */
  readonly refused?: readonly string[]
  readonly elapsedMs: number
  /** Facts and definition are empty with an error. */
  readonly error?: ExplorerError
}

/**
 * explorer.peekDependencies: Peek's Dependencies tab, read only once the tab is chosen, on Peek's slot within its budget. It
 * reads sys.sql_expression_dependencies, which needs more than VIEW DEFINITION (db_owner by default), so its failure is the
 * tab's alone.
 */
export type PeekDependenciesParams = PeekParams
export interface PeekDependenciesResult {
  /** What the object references (sys.sql_expression_dependencies) and the tables its foreign keys point at, in name order. */
  readonly uses: readonly PeekDependency[]
  readonly usesTruncated?: true
  /** The objects whose code references it, and the tables whose foreign keys point at it, in name order. */
  readonly usedBy: readonly PeekDependency[]
  readonly usedByTruncated?: true
  readonly elapsedMs: number
  /** Both lists are empty with an error. */
  readonly error?: ExplorerError
}

/**
 * explorer.peekDefinition: a page of a module's text from `offset` (UTF-16 code units), after explorer.peek's first page, on
 * Peek's slot within its budget. Constant SQL, the object found as its peek finds it; `module` kinds only.
 */
export interface PeekDefinitionParams extends PeekParams {
  readonly offset: number
}
export interface PeekDefinitionResult {
  /**
   * At most `peekLimits.definitionPageChars` code units from `offset`, never ending inside a surrogate pair before the end;
   * absent when the module has no visible text now.
   */
  readonly text?: string
  /** The whole text's length and its module's modify_date (ms) now: the renderer checks both against the first page's. */
  readonly length: number
  readonly stamp: number
  readonly elapsedMs: number
  readonly error?: ExplorerError
}

/** The block explorerCatalogJson embeds for the backend. */
export const peekCatalogBlock = () => ({
  kinds: peekKinds.map(kind => ({
    kind, definition: peekSpecs[kind].definition, dependencies: peekHas(kind, 'dependencies'),
    optionalGroup: peekSpecs[kind].groups.find(group => group.refused !== undefined)?.id ?? null,
    facts: peekSpecs[kind].groups.flatMap(group => group.facts.map(({ id, format, since }) => ({ id, format, since: since ?? null, optional: group.refused !== undefined }))),
    lists: peekListsOf(kind).map(id => ({ id, columns: peekLists[id].columns.map(item => ({ id: item.id, format: item.format })) }))
  })),
  definitionPageChars: peekLimits.definitionPageChars,
  definitionMaxChars: peekLimits.definitionMaxChars,
  budgetMs: peekLimits.budgetMs,
  dependencies: peekLimits.dependencies,
  listRows: peekLimits.listRows,
  mappingDatabases: peekLimits.mappingDatabases
})
