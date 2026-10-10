// Script As: the verbs, destinations, menu titles, and which verbs each Object Explorer kind and subtype offers, with
// the SMO URN type and preflight that script it. It is the only declaration of what can be scripted: menus, context keys,
// the palette and docs/scripting.md read it, and the backend embeds scriptingCatalogJson() as
// Scripting/scripting-catalog.json (a vitest file snapshot keeps that copy in sync), so a stale tree cannot request a
// verb the backend would not offer. Erasable TypeScript (no enums), so Node's type stripping can load it as well.
import { kindSpecs, nodeKinds, type NodeKind, type NodeSubtype, type ParentKind } from '../explorer/catalog.ts'
import { scriptingOptionDefs } from './options.ts'

export const scriptVerbs = ['create', 'alter', 'createOrAlter', 'drop', 'dropAndCreate', 'select', 'insert', 'update', 'delete', 'execute'] as const
export type ScriptVerb = typeof scriptVerbs[number]
/** Where a script goes. SSMS's Agent Job… destination waits for SQL Server Agent in Object Explorer. */
export const scriptDestinations = ['newQuery', 'file', 'clipboard'] as const
export type ScriptDestination = typeof scriptDestinations[number]

/** `ddl` verbs run SMO's Scripter; `dml` and `execute` verbs are SSMS's templates, built from the preflight's rows. */
export type VerbClass = 'ddl' | 'dml' | 'execute'
export interface ScriptVerbSpec {
  /** As in titles and messages: 'CREATE', 'DROP And CREATE'. Its submenu is "<name> To". */
  readonly name: string
  readonly mnemonic: string
  readonly group: string
  readonly order: number
  readonly class: VerbClass
  /** The SMO `ScriptingOptions` flag a DDL verb sets; every other verb flag stays false. */
  readonly smoFlag?: 'ScriptForAlter' | 'ScriptForCreateOrAlter' | 'ScriptDrops' | 'ScriptForCreateDrop'
}
export const scriptVerbSpecs: { readonly [V in ScriptVerb]: ScriptVerbSpec } = {
  create: { name: 'CREATE', mnemonic: 'c', group: '1_ddl', order: 1, class: 'ddl' },
  alter: { name: 'ALTER', mnemonic: 'a', group: '1_ddl', order: 2, class: 'ddl', smoFlag: 'ScriptForAlter' },
  createOrAlter: { name: 'CREATE OR ALTER', mnemonic: 'r', group: '1_ddl', order: 3, class: 'ddl', smoFlag: 'ScriptForCreateOrAlter' },
  drop: { name: 'DROP', mnemonic: 'd', group: '1_ddl', order: 4, class: 'ddl', smoFlag: 'ScriptDrops' },
  dropAndCreate: { name: 'DROP And CREATE', mnemonic: 'n', group: '1_ddl', order: 5, class: 'ddl', smoFlag: 'ScriptForCreateDrop' },
  select: { name: 'SELECT', mnemonic: 's', group: '2_dml', order: 1, class: 'dml' },
  insert: { name: 'INSERT', mnemonic: 'i', group: '2_dml', order: 2, class: 'dml' },
  update: { name: 'UPDATE', mnemonic: 'u', group: '2_dml', order: 3, class: 'dml' },
  delete: { name: 'DELETE', mnemonic: 'e', group: '2_dml', order: 4, class: 'dml' },
  execute: { name: 'EXECUTE', mnemonic: 'x', group: '3_execute', order: 1, class: 'execute' }
}
export const scriptVerbTitle = (verb: ScriptVerb): string => scriptVerbSpecs[verb].name + ' To'

export interface ScriptDestinationSpec {
  readonly title: string
  readonly mnemonic: string
  readonly order: number
  readonly icon: 'file-code' | 'save-as' | 'clippy'
  /** It opens or saves a document, so it waits while a document task runs (`documentBusy`). */
  readonly documentTask: boolean
}
export const scriptDestinationSpecs: { readonly [D in ScriptDestination]: ScriptDestinationSpec } = {
  newQuery: { title: 'New Query Editor Window', mnemonic: 'n', order: 1, icon: 'file-code', documentTask: true },
  file: { title: 'File…', mnemonic: 'f', order: 2, icon: 'save-as', documentTask: true },
  clipboard: { title: 'Clipboard', mnemonic: 'l', order: 3, icon: 'clippy', documentTask: false }
}

/** The "Script … as" menu titles, by key; native menus receive the key, never text. */
export const scriptAsTitleKeys = [
  'table', 'view', 'procedure', 'function', 'trigger', 'databaseTrigger', 'serverTrigger',
  'database', 'index', 'key', 'constraint', 'statistic', 'synonym', 'sequence',
  'userDefinedDataType', 'userDefinedType', 'tableType', 'xmlSchemaCollection', 'rule', 'default', 'securityPolicy',
  'schema', 'user', 'databaseRole', 'applicationRole', 'login', 'serverRole', 'credential', 'linkedServer', 'backupDevice',
  'audit', 'serverAuditSpecification', 'databaseAuditSpecification', 'fullTextCatalog', 'fullTextStoplist', 'searchPropertyList',
  'partitionScheme', 'partitionFunction', 'planGuide'
] as const
export type ScriptAsTitleKey = typeof scriptAsTitleKeys[number]
/** The object noun of each title, as in "Script Table as" and in the backend's messages. */
export const scriptObjectTitles: { readonly [K in ScriptAsTitleKey]: string } = {
  table: 'Table', view: 'View', procedure: 'Stored Procedure', function: 'Function', trigger: 'Trigger', databaseTrigger: 'Database Trigger', serverTrigger: 'Server Trigger',
  database: 'Database', index: 'Index', key: 'Key', constraint: 'Constraint', statistic: 'Statistics', synonym: 'Synonym', sequence: 'Sequence',
  userDefinedDataType: 'User-Defined Data Type', userDefinedType: 'User-Defined Type', tableType: 'User-Defined Table Type', xmlSchemaCollection: 'XML Schema Collection',
  rule: 'Rule', default: 'Default', securityPolicy: 'Security Policy',
  schema: 'Schema', user: 'User', databaseRole: 'Role', applicationRole: 'Application Role', login: 'Login', serverRole: 'Server Role', credential: 'Credential',
  linkedServer: 'Linked Server', backupDevice: 'Backup Device', audit: 'Audit', serverAuditSpecification: 'Server Audit Specification',
  databaseAuditSpecification: 'Database Audit Specification', fullTextCatalog: 'Full-Text Catalog', fullTextStoplist: 'Full-Text Stoplist',
  searchPropertyList: 'Search Property List', partitionScheme: 'Partition Scheme', partitionFunction: 'Partition Function', planGuide: 'Plan Guide'
}
export const scriptAsTitles = Object.fromEntries(scriptAsTitleKeys.map(key => [key, `Script ${scriptObjectTitles[key]} as`])) as { readonly [K in ScriptAsTitleKey]: string }

/**
 * The URN segment SMO finds an object by. `Column/Default` is a default constraint, reached through the column the
 * preflight names.
 */
export const smoUrnTypes = [
  'Database',
  'Table', 'View', 'StoredProcedure', 'UserDefinedFunction', 'UserDefinedAggregate', 'Synonym', 'Sequence', 'UserDefinedDataType', 'UserDefinedType',
  'UserDefinedTableType', 'XmlSchemaCollection', 'Rule', 'Default', 'SecurityPolicy',
  'Trigger', 'Index', 'ForeignKey', 'Check', 'EdgeConstraint', 'Column/Default', 'Statistic',
  'Schema', 'User', 'Role', 'ApplicationRole', 'DdlTrigger', 'DatabaseAuditSpecification', 'FullTextCatalog', 'FullTextStopList', 'SearchPropertyList',
  'PartitionScheme', 'PartitionFunction', 'PlanGuide',
  'Login', 'Credential', 'LinkedServer', 'BackupDevice', 'Audit', 'ServerAuditSpecification'
] as const
export type SmoUrnType = typeof smoUrnTypes[number]
/** The backend's one catalog query per job, by what it reads. */
export const preflightIds = ['module', 'table', 'child', 'type', 'schemaObject', 'databaseObject', 'database', 'serverObject'] as const
export type PreflightId = typeof preflightIds[number]

/** '' = not offered (hidden); 'disabled' = shown greyed, as SSMS shows verbs a kind does not support. */
export type VerbState = '' | 'disabled' | 'enabled'
export type VerbRow = Partial<Record<ScriptVerb, 'disabled' | 'enabled'>>
/** Kinds that carry key material, binaries or external integrations; their nodes show no Script submenu yet. */
export interface LaterKindSpec { readonly kind: NodeKind; readonly phase: 'later' }
export interface ScriptKindSpec {
  readonly kind: NodeKind
  readonly phase: 'pr5'
  readonly title: ScriptAsTitleKey
  readonly subtypeTitles?: Partial<Record<NodeSubtype, ScriptAsTitleKey>>
  readonly urn: SmoUrnType
  readonly subtypeUrns?: Partial<Record<NodeSubtype, SmoUrnType>>
  readonly preflight: PreflightId
  /** `sys.objects.type` codes a `module` preflight looks the object up by. They include deferred subtypes' codes, so
   *  the backend's own subtype answers NOT_SUPPORTED for them rather than NOT_FOUND. */
  readonly objectTypes?: readonly string[]
  /** The verbs of a node without a subtype, and of subtypes `subtypeVerbs` does not list. */
  readonly verbs: VerbRow
  /** 'later': the subtype shows no Script submenu yet, like a later kind. */
  readonly subtypeVerbs?: Partial<Record<NodeSubtype, VerbRow | 'later'>>
  /** Modify (ALTER to a new query) is offered: for every node of the kind, or for these subtypes. */
  readonly modifiable?: true | readonly NodeSubtype[]
  /** Child kinds: the parents whose children can be scripted (a table type's cannot). */
  readonly parents?: readonly ParentKind[]
}

function verbRow(enabled: readonly ScriptVerb[], disabled: readonly ScriptVerb[] = []): VerbRow {
  return Object.fromEntries([...enabled.map(verb => [verb, 'enabled']), ...disabled.map(verb => [verb, 'disabled'])])
}
const ddl = ['create', 'drop', 'dropAndCreate'] as const
const moduleVerbs = [...ddl, 'alter', 'createOrAlter'] as const
const dml = ['select', 'insert', 'update', 'delete'] as const
const createDrop = verbRow(ddl)
type Data = Omit<ScriptKindSpec, 'kind' | 'phase'>
const later = 'later' as const
const plain = (title: ScriptAsTitleKey, urn: SmoUrnType, preflight: PreflightId): Data => ({ title, urn, preflight, verbs: createDrop })
const trigger = (title: ScriptAsTitleKey, urn: SmoUrnType, preflight: PreflightId): Data => ({ title, urn, preflight, verbs: verbRow(moduleVerbs), modifiable: true })

// Every row is an SSMS observation to confirm (spec G8).
const kindData: { readonly [K in NodeKind]?: Data | typeof later } = {
  login: plain('login', 'Login', 'serverObject'),
  serverRole: plain('serverRole', 'Role', 'serverObject'),
  credential: plain('credential', 'Credential', 'serverObject'),
  cryptographicProvider: later,
  audit: plain('audit', 'Audit', 'serverObject'),
  serverAuditSpecification: plain('serverAuditSpecification', 'ServerAuditSpecification', 'serverObject'),
  backupDevice: plain('backupDevice', 'BackupDevice', 'serverObject'),
  linkedServer: plain('linkedServer', 'LinkedServer', 'serverObject'),
  serverTrigger: trigger('serverTrigger', 'DdlTrigger', 'serverObject'),
  database: {
    title: 'database', urn: 'Database', preflight: 'database', verbs: verbRow(['create', 'alter', 'drop', 'dropAndCreate']),
    subtypeVerbs: { snapshot: verbRow(ddl, ['alter']) }
  },
  user: plain('user', 'User', 'databaseObject'),
  databaseRole: plain('databaseRole', 'Role', 'databaseObject'),
  applicationRole: plain('applicationRole', 'ApplicationRole', 'databaseObject'),
  schema: plain('schema', 'Schema', 'databaseObject'),
  assembly: later,
  asymmetricKey: later,
  certificate: later,
  symmetricKey: later,
  columnMasterKey: later,
  columnEncryptionKey: later,
  databaseAuditSpecification: plain('databaseAuditSpecification', 'DatabaseAuditSpecification', 'databaseObject'),
  databaseTrigger: trigger('databaseTrigger', 'DdlTrigger', 'databaseObject'),
  externalDataSource: later,
  externalFileFormat: later,
  fullTextCatalog: plain('fullTextCatalog', 'FullTextCatalog', 'databaseObject'),
  fullTextStoplist: plain('fullTextStoplist', 'FullTextStopList', 'databaseObject'),
  partitionScheme: plain('partitionScheme', 'PartitionScheme', 'databaseObject'),
  partitionFunction: plain('partitionFunction', 'PartitionFunction', 'databaseObject'),
  searchPropertyList: plain('searchPropertyList', 'SearchPropertyList', 'databaseObject'),
  planGuide: plain('planGuide', 'PlanGuide', 'databaseObject'),
  table: { title: 'table', urn: 'Table', preflight: 'table', verbs: verbRow([...ddl, ...dml], ['alter', 'createOrAlter', 'execute']), subtypeVerbs: { droppedLedger: later } },
  view: {
    title: 'view', urn: 'View', preflight: 'module', objectTypes: ['V'], verbs: verbRow([...moduleVerbs, ...dml], ['execute']),
    subtypeVerbs: { ledger: verbRow(['create', 'select'], ['alter', 'createOrAlter', 'drop', 'dropAndCreate', 'insert', 'update', 'delete', 'execute']), droppedLedger: later }
  },
  synonym: plain('synonym', 'Synonym', 'schemaObject'),
  procedure: {
    // The System Stored Procedures folder lists extended (X) and replication-filter (RF) procedures as `system`.
    title: 'procedure', urn: 'StoredProcedure', preflight: 'module', objectTypes: ['P', 'PC', 'X', 'RF'], verbs: verbRow([...moduleVerbs, 'execute']),
    subtypeVerbs: { extended: later, replicationFilter: later }, modifiable: ['sql']
  },
  // Without a subtype a function gets the table-valued row: the verbs every T-SQL function offers, with EXECUTE greyed.
  function: {
    title: 'function', urn: 'UserDefinedFunction', subtypeUrns: { aggregate: 'UserDefinedAggregate' }, preflight: 'module', objectTypes: ['FN', 'IF', 'TF', 'FS', 'FT', 'AF'],
    verbs: verbRow([...moduleVerbs, 'select'], ['execute']),
    subtypeVerbs: {
      scalar: verbRow([...moduleVerbs, 'select', 'execute']), clrScalar: verbRow([...moduleVerbs, 'select', 'execute']),
      aggregate: verbRow(ddl, ['alter', 'createOrAlter', 'select', 'execute'])
    },
    modifiable: ['inline', 'tableValued', 'scalar']
  },
  sequence: plain('sequence', 'Sequence', 'schemaObject'),
  type: { ...plain('userDefinedDataType', 'UserDefinedDataType', 'type'), subtypeTitles: { clr: 'userDefinedType' }, subtypeUrns: { clr: 'UserDefinedType' } },
  tableType: plain('tableType', 'UserDefinedTableType', 'type'),
  xmlSchemaCollection: plain('xmlSchemaCollection', 'XmlSchemaCollection', 'schemaObject'),
  rule: { ...plain('rule', 'Rule', 'module'), objectTypes: ['R'] },
  default: { ...plain('default', 'Default', 'module'), objectTypes: ['D'] },
  securityPolicy: plain('securityPolicy', 'SecurityPolicy', 'schemaObject'),
  key: { ...plain('key', 'Index', 'child'), subtypeUrns: { foreign: 'ForeignKey' }, parents: ['table'] },
  constraint: { ...plain('constraint', 'Check', 'child'), subtypeUrns: { default: 'Column/Default', edge: 'EdgeConstraint' }, parents: ['table'] },
  trigger: { ...trigger('trigger', 'Trigger', 'child'), parents: ['table', 'view'] },
  index: { ...plain('index', 'Index', 'child'), parents: ['table', 'view'] },
  statistic: { ...plain('statistic', 'Statistic', 'child'), parents: ['table', 'view'] }
}
/** One spec per kind Object Explorer marks scriptable; server, folders, columns, parameters and return values have none. */
export const scriptKindSpecs = Object.fromEntries(nodeKinds.flatMap(kind => {
  const data = kindData[kind]
  return data === undefined ? [] : [[kind, data === later ? { kind, phase: later } : { kind, phase: 'pr5', ...data }]]
})) as { readonly [K in NodeKind]?: ScriptKindSpec | LaterKindSpec }

/** What one kind and subtype offers, with everything resolved. */
export interface ScriptRow {
  readonly kind: NodeKind
  /** '' for a node without a subtype. */
  readonly subtype: NodeSubtype | ''
  readonly title: ScriptAsTitleKey
  readonly urn: SmoUrnType
  readonly preflight: PreflightId
  readonly verbs: VerbRow
  readonly modifiable: boolean
}
function resolveRow(spec: ScriptKindSpec, subtype: NodeSubtype | undefined): ScriptRow | undefined {
  const verbs = (subtype && spec.subtypeVerbs?.[subtype]) || spec.verbs
  if (verbs === 'later') return undefined
  return {
    kind: spec.kind, subtype: subtype ?? '', title: (subtype && spec.subtypeTitles?.[subtype]) || spec.title, urn: (subtype && spec.subtypeUrns?.[subtype]) || spec.urn,
    preflight: spec.preflight, verbs, modifiable: spec.modifiable === true || (!!subtype && !!spec.modifiable?.includes(subtype))
  }
}
/** The Script As row of a node, or undefined when it has no Script submenu (not scriptable, deferred, or an unknown subtype). */
export function scriptRow(kind: NodeKind, subtype?: NodeSubtype, parentKind?: ParentKind): ScriptRow | undefined {
  const spec = scriptKindSpecs[kind]
  if (spec?.phase !== 'pr5') return undefined
  if (spec.parents && (parentKind === undefined || !spec.parents.includes(parentKind))) return undefined
  if (subtype !== undefined && !kindSpecs[kind].subtypes?.includes(subtype)) return undefined
  return resolveRow(spec, subtype)
}

export interface ScriptMenuState { readonly title: ScriptAsTitleKey | ''; readonly verbs: Readonly<Record<ScriptVerb, VerbState>>; readonly modifiable: boolean }
/** What Object Explorer's selection is: a folder, or an object with its subtype and, for children, its parent's kind. */
export interface ScriptTarget { readonly kind: NodeKind | 'folder'; readonly subtype?: NodeSubtype; readonly parentKind?: ParentKind }
const noScript: ScriptMenuState = Object.freeze({ title: '', verbs: Object.freeze(Object.fromEntries(scriptVerbs.map(verb => [verb, '']))) as Record<ScriptVerb, VerbState>, modifiable: false })
/** The Script submenu of a node: its title key ('' hides it), each verb's state, and whether Modify is offered. */
export function scriptMenuState(target: ScriptTarget | undefined): ScriptMenuState {
  const row = target && target.kind !== 'folder' ? scriptRow(target.kind, target.subtype, target.parentKind) : undefined
  if (!row) return noScript
  return { title: row.title, verbs: Object.fromEntries(scriptVerbs.map(verb => [verb, row.verbs[verb] ?? ''])) as Record<ScriptVerb, VerbState>, modifiable: row.modifiable }
}
/** Whether any row of the kind (below an allowed parent) offers the verb enabled: what main checks before the backend re-derives the row. */
export function scriptVerbOffered(kind: NodeKind, verb: ScriptVerb, parentKind?: ParentKind): boolean {
  return [undefined, ...kindSpecs[kind].subtypes ?? []].some(subtype => scriptRow(kind, subtype, parentKind)?.verbs[verb] === 'enabled')
}

const pascal = <S extends string>(text: S) => (text.charAt(0).toUpperCase() + text.slice(1)) as Capitalize<S>
export type ScriptVerbContextKey = `explorerScript${Capitalize<ScriptVerb>}`
export const scriptVerbContextKey = (verb: ScriptVerb): ScriptVerbContextKey => `explorerScript${pascal(verb)}`
export type ScriptContextValues = { readonly explorerScriptTitle: ScriptAsTitleKey | ''; readonly explorerSelectionModifiable: boolean } & { readonly [K in ScriptVerbContextKey]: VerbState }
/** The state context keys a selection publishes: `explorerScriptTitle`, `explorerScript<Verb>` and `explorerSelectionModifiable`. */
export function scriptContextValues(state: ScriptMenuState): ScriptContextValues {
  return { explorerScriptTitle: state.title, ...Object.fromEntries(scriptVerbs.map(verb => [scriptVerbContextKey(verb), state.verbs[verb]])), explorerSelectionModifiable: state.modifiable } as ScriptContextValues
}

export type ScriptCommandId = `explorer.script${Capitalize<ScriptVerb>}To${Capitalize<ScriptDestination>}`
/** `explorer.scriptCreateToNewQuery` and so on; the three CREATE ids are the ones the table-only menu had. */
export const scriptCommandId = (verb: ScriptVerb, destination: ScriptDestination): ScriptCommandId => `explorer.script${pascal(verb)}To${pascal(destination)}`
export const scriptCommandIds: readonly ScriptCommandId[] = scriptVerbs.flatMap(verb => scriptDestinations.map(destination => scriptCommandId(verb, destination)))
export const scriptAsSubmenuId = 'explorer.scriptAs'
export type ScriptVerbSubmenuId = `explorer.scriptAs.${ScriptVerb}`
export const scriptVerbSubmenuId = (verb: ScriptVerb): ScriptVerbSubmenuId => `explorer.scriptAs.${verb}`
/** The Script submenu, then one submenu per verb: three menu levels below Object Explorer's context menu. */
export const scriptSubmenuIds: readonly (typeof scriptAsSubmenuId | ScriptVerbSubmenuId)[] = [scriptAsSubmenuId, ...scriptVerbs.map(scriptVerbSubmenuId)]
/** "Script as CREATE to New Query Editor Window" (the palette's title); its quick pick shows the part after "Script as ". */
export const scriptCommandTitle = (verb: ScriptVerb, destination: ScriptDestination): string => `Script as ${scriptVerbSpecs[verb].name} to ${scriptDestinationSpecs[destination].title}`

/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface ScriptCommandEntry {
  readonly title: string
  readonly category: 'Object Explorer'
  readonly icon: ScriptDestinationSpec['icon']
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly palette: false
  readonly menus: readonly [{ readonly menu: ScriptVerbSubmenuId; readonly group: string; readonly order: number; readonly title: string; readonly mnemonic: string }]
}
export const scriptUnavailableHint = 'Select an object in Object Explorer that can be scripted.'
/**
 * The 30 verb × destination commands. Each sits only in its verb's submenu, so its native item id is the bare id, and
 * stays out of the palette, whose Script As… pick lists the enabled ones instead.
 */
export function scriptCommandEntries(): { readonly [K in ScriptCommandId]: ScriptCommandEntry } {
  return Object.fromEntries(scriptVerbs.flatMap(verb => scriptDestinations.map(destination => {
    const target = scriptDestinationSpecs[destination]
    const entry: ScriptCommandEntry = {
      title: scriptCommandTitle(verb, destination), category: 'Object Explorer', icon: target.icon, keywords: ['script'],
      precondition: `backendReady && ${scriptVerbContextKey(verb)} == 'enabled'` + (target.documentTask ? ' && !documentBusy' : ''), unavailableHint: scriptUnavailableHint, palette: false,
      menus: [{ menu: scriptVerbSubmenuId(verb), group: '1_destination', order: target.order, title: target.title, mnemonic: target.mnemonic }]
    }
    return [scriptCommandId(verb, destination), entry]
  }))) as { readonly [K in ScriptCommandId]: ScriptCommandEntry }
}
/** A submenu entry, in the shape of `SubmenuDescriptor`; `dynamicTitle` shows `scriptAsTitles[explorerScriptTitle]` instead of the title. */
export interface ScriptSubmenuEntry {
  readonly title: string
  readonly nativeId: string
  readonly dynamicTitle?: 'scriptAs'
  readonly placements: readonly [{ readonly menu: 'explorer.context' | typeof scriptAsSubmenuId; readonly group: string; readonly order: number; readonly mnemonic: string; readonly when: string }]
}
export function scriptSubmenuEntries(): { readonly [K in typeof scriptAsSubmenuId | ScriptVerbSubmenuId]: ScriptSubmenuEntry } {
  const verbs = scriptVerbs.map(verb => {
    const spec = scriptVerbSpecs[verb], id = scriptVerbSubmenuId(verb)
    const entry: ScriptSubmenuEntry = {
      title: scriptVerbTitle(verb), nativeId: id,
      placements: [{ menu: scriptAsSubmenuId, group: spec.group, order: spec.order, mnemonic: spec.mnemonic, when: `${scriptVerbContextKey(verb)} != ''` }]
    }
    return [id, entry] as const
  })
  const scriptAs: ScriptSubmenuEntry = {
    title: 'Script as', nativeId: scriptAsSubmenuId, dynamicTitle: 'scriptAs',
    // The keys describe the selection, which a node's menu has just selected; the empty area's menu keeps it, so it opts out.
    placements: [{ menu: 'explorer.context', group: '2_script', order: 1, mnemonic: 's', when: "explorerScriptTitle != '' && explorerNode != 'background'" }]
  }
  return Object.fromEntries([[scriptAsSubmenuId, scriptAs], ...verbs]) as { readonly [K in typeof scriptAsSubmenuId | ScriptVerbSubmenuId]: ScriptSubmenuEntry }
}

/** Failures come back as values in the result; `retryable` says whether trying again can help. */
export const scriptErrorRetryable = {
  NOT_FOUND: false, NOT_SUPPORTED: false, ENCRYPTED: false, NO_DEFINITION: false, PERMISSION_DENIED: true, DATABASE_UNAVAILABLE: true, TOO_LARGE: false,
  EMPTY: false, BLOCKED: true, TIMEOUT: true, CONNECTION_LOST: true, UNREPRESENTABLE: false, SMO_ERROR: true, SQL_ERROR: true
} as const satisfies Record<string, boolean>
export type ScriptErrorCode = keyof typeof scriptErrorRetryable
export const scriptErrorCodes = Object.keys(scriptErrorRetryable) as ScriptErrorCode[]

export const scriptLimits = {
  maxScriptChars: 4_000_000, maxDefinitionBytes: 8_000_000, maxColumns: 30_000, maxParameters: 2_100,
  requestMs: 60_000, budgetMs: 55_000, statementTimeoutS: 30, preflightTimeoutS: 30, lockTimeoutMs: 10_000,
  gatePerConnection: 2, gateTotal: 4, registered: 256, tombstones: 256, tombstoneMs: 60_000, cancelIds: 64,
  rendererJobs: 4, statusDelayMs: 300, noticeMs: 4_000, warningNoticeMs: 8_000, warnings: 8, warningChars: 512,
  messageChars: 2_048, prefsBytes: 16_384, fileNameChars: 200
} as const

// Compact sorted-key JSON, as in explorerCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'
const byVerb = (verbs: VerbRow, state: 'enabled' | 'disabled') => scriptVerbs.filter(verb => verbs[verb] === state)

/**
 * The catalogue as the backend embeds it, keys sorted and everything resolved, so C# needs no rules of its own:
 * `targets` has one row per scriptable kind and subtype ('' for none; deferred rows have phase 'later' and nothing
 * else), and `options` lists the option keys in request order with their types.
 */
export function scriptingCatalogJson(): string {
  const targets = nodeKinds.flatMap(kind => {
    const spec = scriptKindSpecs[kind]
    if (!spec) return []
    return [undefined, ...kindSpecs[kind].subtypes ?? []].map(subtype => {
      const row = spec.phase === 'pr5' ? resolveRow(spec, subtype) : undefined
      return {
        kind, subtype: subtype ?? '', phase: row ? 'pr5' : 'later', title: row?.title ?? '', urn: row?.urn ?? '', preflight: row?.preflight ?? '',
        objectTypes: row && spec.phase === 'pr5' ? spec.objectTypes ?? [] : [], parents: row && spec.phase === 'pr5' ? spec.parents ?? [] : [],
        enabled: row ? byVerb(row.verbs, 'enabled') : [], disabled: row ? byVerb(row.verbs, 'disabled') : [], modifiable: row?.modifiable ?? false
      }
    })
  })
  const verbs = scriptVerbs.map(verb => ({ verb, name: scriptVerbSpecs[verb].name, class: scriptVerbSpecs[verb].class, smoFlag: scriptVerbSpecs[verb].smoFlag ?? '' }))
  const options = scriptingOptionDefs.map(def => ({ key: def.key, type: def.type, values: def.type === 'enum' ? def.values.map(item => item.value) : [], default: def.default }))
  return [
    '{',
    `  "errors": ${block(scriptErrorCodes.map(code => ({ code, retryable: scriptErrorRetryable[code] })))},`,
    `  "limits": ${line(scriptLimits)},`,
    `  "options": ${block(options)},`,
    `  "targets": ${block(targets)},`,
    `  "titles": ${line(scriptObjectTitles)},`,
    `  "verbs": ${block(verbs)},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
