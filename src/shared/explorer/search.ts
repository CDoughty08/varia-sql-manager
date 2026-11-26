// Search Objects: the object index's requests, answers, progress and limits (backend/Varia.Backend/Search/). The index lives
// only in the backend's memory, per connection, and is dropped on disconnect; nothing about it reaches disk.
import { z } from 'zod'
import { maxIdentifierLength } from '../sql/identifiers.ts'
import { bracketName, scriptName } from '../designer/catalog.ts'
import { bigQueryFieldText, bigQueryPath, isBigQueryName } from '../bigquery/names.ts'
import { bigQueryDryRunResultSchema, type BigQueryDryRunResult } from '../bigquery/dry-run.ts'
import type { ProviderId } from '../providers.ts'
import type { ObjectRef } from './refs.ts'
import type { FolderId, NodeKind, NodeSubtype } from './catalog.ts'

/** Mirrors ObjectSearchService and ObjectIndexLimits (tests/object-search.test.ts compares them). */
export const objectSearchLimits = {
  /** The longest search text, in UTF-16 code units. */
  text: 1000,
  /** The most hits one search answers. */
  hits: 1000,
  /** The hits a search answers when it names no limit. */
  defaultHits: 200,
  /** Databases a status lists as skipped. */
  skipped: 256,
  /** How long one search may work before it answers what it found, marked partial, in ms. */
  searchMs: 5000,
  /** How long one database's read may take before it is skipped as TIMEOUT, in ms. */
  databaseMs: 120_000,
  /** The longest part of one definition the index keeps, in characters. */
  definitionChars: 1_000_000,
  /** The memory every connection's index holds together, in bytes (records, names and definitions, each charged once): a
   *  database that would pass it is kept without its children (CHILDREN_LEFT_OUT), or skipped as TOO_LARGE. */
  memoryBytes: 512 * 1024 * 1024,
  /** The part of `memoryBytes` definitions leave to names: a definition is left out once less than this is free. */
  namesReserveBytes: 128 * 1024 * 1024,
  /** Index progress pushed to the window, at most, per second. */
  progressPerSecond: 4,
  /** How long the Search Objects box waits after a key before it searches, in ms. */
  typingMs: 200,
  /** The most kinds one search may name. */
  kinds: 64,
  /** The most words a Fuzzy Match search may have; one with more matches exactly only (FuzzyName.MaxWords). */
  fuzzyWords: 8,
  /** The longest word Fuzzy Match compares, in UTF-16 code units; a search with a longer one matches exactly only. */
  fuzzyWordChars: 64,
  /** BigQuery's index (BigQueryIndexLimits): pages one listing reads (1,000 items each), datasets listed at once, details read at
   *  once, columns kept per table, the longest column description or routine signature kept, default and maximum discovered projects,
   *  projects whose datasets are listed at once, and max starred projects passed per build. */
  bigQuery: { listPages: 500, datasets: 4, details: 8, columns: 10_000, factChars: 1024, maxProjects: 500, maxProjectsCap: 5000, projects: 4, starredProjects: 200 }
} as const

/** The kinds the index holds, as Object Explorer names them: every kind it lists but the server, return values and the SSIS
 *  Catalog's (tests/object-search.test.ts checks this against the catalogue). */
export const searchKinds = [
  'table', 'view', 'procedure', 'function', 'synonym', 'sequence', 'trigger', 'type', 'tableType', 'databaseTrigger',
  'login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'backupDevice', 'linkedServer', 'serverTrigger',
  'database', 'user', 'databaseRole', 'applicationRole', 'schema', 'assembly', 'asymmetricKey', 'certificate', 'symmetricKey', 'columnMasterKey',
  'columnEncryptionKey', 'databaseAuditSpecification', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist', 'partitionScheme',
  'partitionFunction', 'searchPropertyList', 'planGuide', 'xmlSchemaCollection', 'rule', 'default', 'securityPolicy',
  'column', 'key', 'constraint', 'index', 'statistic', 'parameter', 'agentJob', 'agentAlert', 'agentOperator'
] as const satisfies readonly NodeKind[]
/** BigQuery's indexed kinds (ObjectSearchService.BigQueryKinds): every kind Object Explorer lists for BigQuery but the project. */
export const bigQuerySearchKinds = ['bqDataset', 'bqTable', 'bqView', 'bqMaterializedView', 'bqExternalTable', 'bqRoutine', 'bqModel', 'bqColumn'] as const satisfies readonly NodeKind[]
/** BigQuery kinds split by subtype, each a filter of its own (SearchQuery.Variants): a plain kind then keeps only its objects
 *  without one of these subtypes (`bqTable` is a table that is neither a snapshot nor a clone). */
export const bigQuerySearchVariants = ['bqTable:snapshot', 'bqTable:clone', 'bqRoutine:procedure', 'bqRoutine:tableValued'] as const
export type SearchKind = typeof searchKinds[number] | typeof bigQuerySearchKinds[number]
/** What a search's `kinds` may name: a kind, or a BigQuery kind's subtype variant. */
export type SearchKindFilter = SearchKind | typeof bigQuerySearchVariants[number]
/** Every value `kinds` accepts, in the order the backend lists them. */
export const searchKindFilters = [...searchKinds, ...bigQuerySearchKinds, ...bigQuerySearchVariants] as const satisfies readonly SearchKindFilter[]
/** The filters of `kinds` an index of `provider` holds, in order; with none given, every filter it holds (each engine's search
 *  is sent only its own kinds, so a type chosen for the other engine never reaches it). */
export function providerSearchKinds(provider: ProviderId, kinds?: readonly SearchKindFilter[]): SearchKindFilter[] {
  const own = provider === 'bigquery' ? (value: string) => value.startsWith('bq') : (value: string) => !value.startsWith('bq')
  return (kinds ?? searchKindFilters).filter(own)
}
/** SQL Server Agent's indexed kinds (SQL Server only), under Search Objects' Other type. */
export const agentSearchKinds = ['agentJob', 'agentAlert', 'agentOperator'] as const satisfies readonly SearchKind[]
/** Kinds Object Explorer lists that the index does not hold (ObjectSearchService.Unindexed): Agent's proxies, their
 *  subsystems and error logs, which only a sysadmin may read. */
export const unindexedKinds = ['agentProxySubsystem', 'agentProxy', 'agentErrorLog'] as const satisfies readonly NodeKind[]
export const searchScopes = ['all', 'names', 'definitions'] as const
export type SearchScope = typeof searchScopes[number]
/** exact: the text as typed (with Match Case, Whole Word, wildcards or Regex); fuzzy: names also match approximately, word by
 *  word, within a few typos or by sound, ranked below exact hits. Definitions always match exactly; fuzzy cannot go with Regex. */
export const searchMatches = ['exact', 'fuzzy'] as const
export type SearchMatch = typeof searchMatches[number]

const sqlServer = ['sqlserver'] as const satisfies readonly ProviderId[]
const bigQuery = ['bigquery'] as const satisfies readonly ProviderId[]
const both = ['sqlserver', 'bigquery'] as const satisfies readonly ProviderId[]
/** Search Objects' type filters, in the order the chips show: each names a set of kinds (and BigQuery subtype variants), and
 *  together they name every value `kinds` accepts exactly once (tests/object-search.test.ts). A chip shows when a server of one of
 *  its `providers` is searched: Tables, Views, Columns and Procedures serve both engines, the rest one. A search with none chosen
 *  searches every kind; with some, each server is sent the kinds of its own engine those name (providerSearchKinds), and a server
 *  left with none answers no hits without being asked. */
export const searchTypes = [
  { id: 'tables', label: 'Tables', kinds: ['table', 'bqTable'], providers: both },
  { id: 'views', label: 'Views', kinds: ['view', 'bqView'], providers: both },
  { id: 'columns', label: 'Columns', kinds: ['column', 'bqColumn'], providers: both },
  { id: 'procedures', label: 'Procedures', kinds: ['procedure', 'bqRoutine:procedure'], providers: both },
  { id: 'functions', label: 'Functions', kinds: ['function'], providers: sqlServer },
  { id: 'bqMaterializedViews', label: 'Materialized views', kinds: ['bqMaterializedView'], providers: bigQuery },
  { id: 'bqExternalTables', label: 'External tables', kinds: ['bqExternalTable'], providers: bigQuery },
  { id: 'bqSnapshots', label: 'Snapshots', kinds: ['bqTable:snapshot'], providers: bigQuery },
  { id: 'bqClones', label: 'Clones', kinds: ['bqTable:clone'], providers: bigQuery },
  { id: 'bqRoutines', label: 'Routines', kinds: ['bqRoutine'], providers: bigQuery },
  { id: 'bqTableFunctions', label: 'Table functions', kinds: ['bqRoutine:tableValued'], providers: bigQuery },
  { id: 'bqModels', label: 'Models', kinds: ['bqModel'], providers: bigQuery },
  { id: 'bqDatasets', label: 'Datasets', kinds: ['bqDataset'], providers: bigQuery },
  { id: 'parameters', label: 'Parameters', kinds: ['parameter'], providers: sqlServer },
  { id: 'triggers', label: 'Triggers', kinds: ['trigger', 'databaseTrigger', 'serverTrigger'], providers: sqlServer },
  { id: 'indexes', label: 'Keys and indexes', kinds: ['key', 'constraint', 'index', 'statistic'], providers: sqlServer },
  { id: 'schemas', label: 'Schemas', kinds: ['schema'], providers: sqlServer },
  { id: 'types', label: 'Types', kinds: ['type', 'tableType', 'xmlSchemaCollection', 'rule', 'default'], providers: sqlServer },
  { id: 'security', label: 'Security', kinds: [
    'login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'user', 'databaseRole', 'applicationRole', 'asymmetricKey',
    'certificate', 'symmetricKey', 'columnMasterKey', 'columnEncryptionKey', 'databaseAuditSpecification', 'securityPolicy'
  ], providers: sqlServer },
  { id: 'other', label: 'Other', kinds: [
    'synonym', 'sequence', 'database', 'assembly', 'backupDevice', 'linkedServer', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist',
    'partitionScheme', 'partitionFunction', 'searchPropertyList', 'planGuide', 'agentJob', 'agentAlert', 'agentOperator'
  ], providers: sqlServer }
] as const satisfies readonly { readonly id: string; readonly label: string; readonly kinds: readonly SearchKindFilter[]; readonly providers: readonly ProviderId[] }[]
export type SearchType = typeof searchTypes[number]['id']
/** The type filters a search over servers of `providers` shows. */
export function searchTypesFor(providers: ReadonlySet<ProviderId>): readonly typeof searchTypes[number][] {
  return searchTypes.filter(type => type.providers.some(provider => providers.has(provider)))
}

/** A result's kind badge: its tone (a theme key, `searchKind.<tone>Background`) and a letter, as Search Objects' mock draws
 *  T, V, P and F (the tone and the path tell kinds that share a letter apart); tests/object-search.test.ts checks every kind has one. */
export const searchKindTones = ['table', 'view', 'procedure', 'function', 'column', 'key', 'security', 'database', 'other'] as const
export type SearchKindTone = typeof searchKindTones[number]
const typeTones: Record<SearchType, SearchKindTone> = {
  tables: 'table', views: 'view', columns: 'column', procedures: 'procedure', functions: 'function', parameters: 'column', triggers: 'procedure',
  indexes: 'key', schemas: 'database', types: 'other', security: 'security', other: 'other',
  bqMaterializedViews: 'view', bqExternalTables: 'table', bqSnapshots: 'table', bqClones: 'table', bqRoutines: 'function',
  bqTableFunctions: 'function', bqModels: 'other', bqDatasets: 'database'
}
const kindLetters: Record<SearchKind, string> = {
  table: 'T', view: 'V', procedure: 'P', function: 'F', synonym: 'S', sequence: 'Q', trigger: 'G', type: 'Y', tableType: 'Y', databaseTrigger: 'G',
  login: 'L', serverRole: 'R', credential: 'C', cryptographicProvider: 'P', audit: 'A', serverAuditSpecification: 'A', backupDevice: 'B', linkedServer: 'L',
  serverTrigger: 'G', database: 'D', user: 'U', databaseRole: 'R', applicationRole: 'R', schema: 'S', assembly: 'A', asymmetricKey: 'K', certificate: 'C',
  symmetricKey: 'K', columnMasterKey: 'K', columnEncryptionKey: 'K', databaseAuditSpecification: 'A', externalDataSource: 'E', externalFileFormat: 'E',
  fullTextCatalog: 'X', fullTextStoplist: 'X', partitionScheme: 'P', partitionFunction: 'P', searchPropertyList: 'X', planGuide: 'G',
  xmlSchemaCollection: 'X', rule: 'R', default: 'D', securityPolicy: 'P', column: 'C', key: 'K', constraint: 'K', index: 'I', statistic: 'S', parameter: 'A',
  agentJob: 'J', agentAlert: 'A', agentOperator: 'O',
  // BigQuery, as Search Objects' mock draws them: M a materialized view, R a routine, ML a model.
  bqDataset: 'D', bqTable: 'T', bqView: 'V', bqMaterializedView: 'M', bqExternalTable: 'E', bqRoutine: 'R', bqModel: 'ML', bqColumn: 'C'
}
/** A kind the renderer does not know (a newer backend's) still gets a badge, so one row can never take the list down. */
export const unknownKindBadge = { letters: '?', tone: 'other' } as const satisfies { readonly letters: string; readonly tone: SearchKindTone }
export function searchKindBadge(kind: SearchKind | string): { readonly letters: string; readonly tone: SearchKindTone } {
  const type = searchTypes.find(item => (item.kinds as readonly string[]).includes(kind))
  const letters = Object.hasOwn(kindLetters, kind) ? kindLetters[kind as SearchKind] : undefined
  if (!type || !letters) return unknownKindBadge
  return { letters, tone: kind === 'database' ? 'database' : typeTones[type.id] }
}

/** The kinds a search with these type filters names, in the index's order; undefined (every kind) when none is chosen. */
export function searchTypeKinds(types: readonly SearchType[]): SearchKindFilter[] | undefined {
  if (!types.length) return undefined
  const chosen = new Set<SearchKindFilter>(searchTypes.filter(type => types.includes(type.id)).flatMap(type => type.kinds))
  return searchKindFilters.filter(kind => chosen.has(kind))
}

/** Skip codes a status lists for a database the index still holds (ObjectSearchService.ChildrenLeftOut): its objects without
 *  their columns, indexes, statistics and parameters, which would have taken the index past its memory. */
export const childrenLeftOut = 'CHILDREN_LEFT_OUT'

/** A BigQuery refresh's scope: one of the connection's projects, or one of its datasets. */
export interface BigQueryIndexScope { readonly project: string; readonly dataset?: string }
/** A project's location (US, EU, us-central1, …), whose region-scoped INFORMATION_SCHEMA the billed bulk path reads. */
export interface BigQueryIndexLocation { readonly project: string; readonly location: string }
/** The billed bulk path (docs/object-search.md, Bulk index): the locations bigquery.indexEstimate answered and the cost prompts
 *  let run, the cap every job carries (a connection's own wins), and the estimate shown, which the build's jobs together never bill more than. */
export interface BigQueryBulkIndex { readonly locations: readonly BigQueryIndexLocation[]; readonly maximumBytesBilled?: number; readonly budgetBytes: number }
/** bigquery.indexEstimate: what a full build's bulk path would bill, for the cost prompts. */
export interface BigQueryIndexEstimateRequest { readonly connectionId: string; readonly definitions?: boolean; readonly starredProjects?: readonly string[] }
/** The locations to read (at most 64; `cut` when there were more) and their queries' estimate, each query at least 10 MiB per view. */
export interface BigQueryIndexEstimateResult { readonly locations: readonly BigQueryIndexLocation[]; readonly estimate: BigQueryDryRunResult; readonly cut: boolean; readonly elapsedMs: number }
/** The last full build's bulk path: the locations read billed, and the first failure of those that fell back to free calls. */
export interface BigQueryBulkStatus { readonly locations: number; readonly failed: number; readonly code?: string; readonly message?: string }
/** The most locations one estimate or build covers (BigQueryBulkSql.MaxLocations). */
export const bigQueryBulkLocations = 64
/** BigQuery only (SQL Server refuses them): `starredProjects` names the user's starred projects (indexed with details even if
 *  projects.list does not return them, e.g. public or dataset-ACL projects), `allProjects` discovers every accessible project via
 *  projects.list (default true), `maxProjects` caps discovered projects (1..5000, default 500), `scope` re-reads one project or
 *  dataset whole (Object Explorer's Refresh), and `stale` re-reads only the datasets DDL run from a tab marked. */
export interface ObjectIndexParams {
  readonly connectionId: string
  readonly requestId: string
  readonly definitions?: boolean
  readonly starredProjects?: readonly string[]
  readonly allProjects?: boolean
  readonly maxProjects?: number
  readonly scope?: BigQueryIndexScope
  /** With `scope`: skip all BigQuery API calls when the requested project/dataset is already cleanly covered in the index, and reuse held details instead of forcing re-reads. */
  readonly missingOnly?: true
  readonly stale?: true
  /** A full build only: pass 2 reads these locations with the billed bulk queries. */
  readonly bulk?: BigQueryBulkIndex
}
/** `agent`: SQL Server Agent's objects were left out, not the database named (msdb, where they are read). `project`: a BigQuery
 *  dataset's project (`database` is the dataset, or empty when the project's listing failed). `details`: the dataset is indexed, but
 *  some of its objects' details (pass 2) could not be read. */
export interface ObjectIndexSkip { readonly database: string; readonly code: string; readonly message: string; readonly agent?: boolean; readonly project?: string; readonly details?: boolean }
/** none: never built; building: a build is reading; ready: the last build ended. `indexed` counts the databases read so far. */
export interface ObjectIndexStatus {
  readonly state: 'none' | 'building' | 'ready'
  readonly databases: number
  readonly indexed: number
  readonly objects: number
  readonly modules: number
  /** Definitions cut at the per-module limit or left out once the shared budget was spent. */
  readonly cut: number
  readonly skipped: readonly ObjectIndexSkip[]
  readonly definitions: boolean
  /** UTC, when the last build ended. */
  readonly builtAt?: string
  /** A BigQuery connection's index: `databases` and `indexed` count datasets. */
  readonly provider?: 'bigquery'
  /** BigQuery, while building: projects (discovering accessible projects), names (pass 1) or details (pass 2: schemas, view and routine text). */
  readonly phase?: 'projects' | 'names' | 'details'
  /** BigQuery: the projects indexed by name only (when memory budget stopped pass 2 early). */
  readonly namesOnly?: readonly string[]
  /** BigQuery: the last full build's billed bulk path, when it ran. */
  readonly bulk?: BigQueryBulkStatus
  /** BigQuery: how many distinct projects the index holds reads for. */
  readonly projects?: number
  /** BigQuery: the newest DDL stale mark no stale-only build has spent yet (absent when none is left). */
  readonly staleMark?: number
  /** The last full build was stopped before it finished: the index holds only what it read (absent otherwise). */
  readonly stopped?: true
}
export interface ObjectIndexResult { readonly status: ObjectIndexStatus; readonly elapsedMs: number }
/** explorer.indexStatus: what a connection's index holds now, without building or searching. */
export interface ObjectIndexStatusParams { readonly connectionId: string }

export interface ObjectSearchParams {
  readonly connectionId: string
  readonly requestId: string
  readonly text: string
  readonly caseSensitive?: boolean
  readonly wholeWord?: boolean
  readonly regex?: boolean
  readonly in?: SearchScope
  readonly kinds?: readonly SearchKindFilter[]
  /** SQL Server only. */
  readonly database?: string
  readonly limit?: number
  readonly match?: SearchMatch
  /** BigQuery only: one project, or with `dataset` one of its datasets. */
  readonly project?: string
  readonly dataset?: string
}
/** A definition's first match: line and column are 1-based; range is [start, length] in preview. */
export interface DefinitionMatch {
  readonly line: number
  readonly column: number
  readonly preview: string
  readonly range: readonly [number, number]
  readonly before: boolean
  readonly after: boolean
  readonly matches: number
  readonly cut: boolean
  /** The search ran past its budget before counting every match: matches is only a lower bound. */
  readonly uncounted?: boolean
}
/** A date-sharded table group (events_20260101, …) a BigQuery hit stands for: its prefix, shards and first and last date suffix. */
export interface BigQueryShards { readonly prefix: string; readonly count: number; readonly first: string; readonly last: string }
export interface ObjectSearchHit {
  readonly object: ObjectRef
  /** The folder that lists the object; '' for a BigQuery dataset, which its project lists directly. */
  readonly folder: FolderId | ''
  /** schema.name, parentSchema.parent.name for a child (a column, key or trigger), or the name alone. */
  readonly label: string
  /** The name match's [start, length] in label: for an approximate hit, from its first matched word to its last. */
  readonly range?: readonly [number, number]
  /** A Fuzzy Match hit whose name matched only approximately. */
  readonly approximate?: boolean
  readonly modified?: string
  readonly definition?: DefinitionMatch
  /** The node's subtype, where the index knows it (a foreign key, an inline function, a SQL login). */
  readonly subtype?: NodeSubtype
  /** The folder that lists a child's parent (a graph table's columns are under Tables › Graph Tables). */
  readonly parentFolder?: FolderId
  /** The table (in the hit's database, listed in `folder`) whose history row is a temporal or ledger history table: the hit
   *  itself, or a child's parent. */
  readonly via?: { readonly schema: string; readonly name: string; readonly folder: FolderId }
  /** A BigQuery column's type (INT64, ARRAY<STRING>, STRUCT). */
  readonly type?: string
  /** A BigQuery table that stands for its date-sharded group (it is the newest shard). */
  readonly shards?: BigQueryShards
}
/** A hit's name as its row shows it, with the match's range in it: a BigQuery object's or column's label without its dataset,
 *  which the path names (orders, orders.address.city). */
export function searchHitLabel(hit: ObjectSearchHit): { readonly text: string; readonly range?: readonly [number, number] } {
  const dataset = hit.object.project !== undefined && hit.object.kind !== 'bqDataset' ? hit.object.dataset : undefined
  if (dataset === undefined || !hit.label.startsWith(dataset + '.')) return { text: hit.label, ...hit.range ? { range: hit.range } : {} }
  const cut = dataset.length + 1, text = hit.label.slice(cut)
  if (!hit.range) return { text }
  // A match inside the dataset name is not in the text shown: what is left of it, if any, is marked.
  const start = Math.max(0, hit.range[0] - cut), end = Math.max(0, hit.range[0] + hit.range[1] - cut)
  return end > start ? { text, range: [start, end - start] } : { text }
}

/** Whether a hit is a BigQuery object (its ref names a project). */
export const isBigQueryHit = (hit: ObjectSearchHit): boolean => hit.object.project !== undefined
/** A search hit's names as Copy gives them: `qualified` brackets only the parts that need it, `bracketed` every part. */
export interface SearchHitNames {
  readonly name: string
  /** In a schema (the object's, or its parent's for a column, key or trigger): schema, parent and name. */
  readonly schema?: string
  /** With the schema-qualified name, the database first; a BigQuery object's backtick-quoted path. */
  readonly qualified?: string
  /** Every part bracketed; none for a BigQuery object. */
  readonly bracketed?: string
}
/**
 * The names Copy offers for a hit's object, unescaped for display nowhere: Name is the name as SQL Server stores it; the
 * qualified forms join database, schema, parent and name with dots, bracketing a part (QUOTENAME's `]]`) that is not a regular
 * identifier or is a reserved keyword, as a query needs it; Bracketed brackets every part. An object outside a schema (a login,
 * a database, a database user) has only its name.
 */
export function searchHitNames(object: ObjectRef): SearchHitNames {
  const name = object.name ?? ''
  // BigQuery: the name, and the backtick-quoted full name (`project.dataset.table`, a column's table path then its field path) as
  // its fully qualified one; BigQuery has no schema-qualified or bracketed form.
  if (object.project !== undefined) {
    const full = object.kind === 'bqColumn' && object.dataset !== undefined && object.table !== undefined
      ? bigQueryPath(object.project, object.dataset, object.table) + '.' + bigQueryFieldText(name)
      : bigQueryPath(...[object.project, object.dataset, name].filter((part): part is string => part !== undefined))
    return { name, qualified: full }
  }
  const schema = object.parent ? object.parent.schema : object.schema
  if (!schema) return { name, bracketed: bracketName(name) }
  const parts = [schema, ...object.parent ? [object.parent.name] : [], name]
  const full = object.database === undefined ? parts : [object.database, ...parts]
  return { name, schema: parts.map(scriptName).join('.'), qualified: full.map(scriptName).join('.'), bracketed: full.map(bracketName).join('.') }
}
export interface ObjectSearchResult {
  readonly hits: readonly ObjectSearchHit[]
  readonly total: number
  readonly partial: boolean
  readonly elapsedMs: number
  readonly index: ObjectIndexStatus
  /** Why the pattern cannot be searched for. */
  readonly problem?: string
}

/** A build's progress EVENT, as the backend sends it. */
export const objectIndexProgressEventSchema = z.object({
  type: z.literal('explorer.index.progress'), done: z.number().int().min(0), total: z.number().int().min(0), objects: z.number().int().min(0),
  phase: z.enum(['projects', 'names', 'details']).optional()
}).strict().refine(value => value.done <= value.total, 'A build cannot have read more databases than it lists.')
export type ObjectIndexProgressEvent = z.infer<typeof objectIndexProgressEventSchema>
/** What main pushes on `varia:explorer-index-progress` to the window that started the build. */
export interface ObjectIndexProgress { readonly requestId: string; readonly done: number; readonly total: number; readonly objects: number; readonly phase?: 'projects' | 'names' | 'details' }

// zod's max() counts code points; the backend counts UTF-16 code units.
const units = (max: number) => z.string().min(1).refine(value => value.length <= max, `At most ${max} UTF-16 code units.`)
const bigQueryName = (kind: 'project' | 'dataset') => z.string().refine(value => isBigQueryName(kind, value), `Not a BigQuery ${kind} name.`)
// BigQuery's location ids (BigQueryLimits.LocationId).
const bigQueryLocation = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/)
const bigQueryIndexLocationSchema = z.object({ project: bigQueryName('project'), location: bigQueryLocation }).strict()
const starredProjectsSchema = z.array(bigQueryName('project')).max(objectSearchLimits.bigQuery.starredProjects)
export const objectIndexStatusParamsSchema = z.object({ connectionId: z.uuid() }).strict()

export const objectIndexParamsSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), definitions: z.boolean().optional(),
  starredProjects: starredProjectsSchema.optional(), allProjects: z.boolean().optional(),
  maxProjects: z.number().int().min(1).max(objectSearchLimits.bigQuery.maxProjectsCap).optional(),
  scope: z.object({ project: bigQueryName('project'), dataset: bigQueryName('dataset').optional() }).strict().optional(),
  missingOnly: z.literal(true).optional(), stale: z.literal(true).optional(),
  bulk: z.object({
    locations: z.array(bigQueryIndexLocationSchema).min(1).max(bigQueryBulkLocations), maximumBytesBilled: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    budgetBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  }).strict().optional()
}).strict().refine(value => !(value.scope && value.stale), 'A refresh is scoped or stale-only, not both.')
  .refine(value => !value.missingOnly || value.scope !== undefined, 'missingOnly requires a scope.')
  .refine(value => !(value.bulk && (value.scope || value.stale)), 'The bulk path reads a full build only.') satisfies z.ZodType<ObjectIndexParams>
export const bigQueryIndexEstimateRequestSchema = z.object({ connectionId: z.uuid(), definitions: z.boolean().optional(), starredProjects: starredProjectsSchema.optional() }).strict() satisfies z.ZodType<BigQueryIndexEstimateRequest>
export const bigQueryIndexEstimateResultSchema = z.object({
  locations: z.array(bigQueryIndexLocationSchema).max(bigQueryBulkLocations), estimate: bigQueryDryRunResultSchema, cut: z.boolean(), elapsedMs: z.number().int().min(0)
}).strict() satisfies z.ZodType<BigQueryIndexEstimateResult>
export const objectSearchParamsSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), text: units(objectSearchLimits.text).refine(value => !value.includes('\u0000'), 'The text cannot contain U+0000.'),
  caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), regex: z.boolean().optional(), in: z.enum(searchScopes).optional(),
  kinds: z.array(z.enum(searchKindFilters)).min(1).max(objectSearchLimits.kinds).optional(),
  database: units(maxIdentifierLength).refine(value => !value.includes('\u0000'), 'A name cannot contain U+0000.').optional(),
  limit: z.number().int().min(1).max(objectSearchLimits.hits).optional(), match: z.enum(searchMatches).optional(),
  project: bigQueryName('project').optional(), dataset: bigQueryName('dataset').optional()
}).strict().refine(value => !(value.match === 'fuzzy' && value.regex), 'Fuzzy Match cannot go with a regular expression.')
  .refine(value => value.dataset === undefined || value.project !== undefined, 'A dataset needs its project.')
  .refine(value => value.database === undefined || (value.project === undefined && value.dataset === undefined), 'A database is SQL Server\'s, a project and dataset BigQuery\'s.') satisfies z.ZodType<ObjectSearchParams>
