// Search Objects: the object index's requests, answers, progress and limits (backend/Varia.Backend/Search/). The index lives
// only in the backend's memory, per connection, and is dropped on disconnect; nothing about it reaches disk.
import { z } from 'zod'
import { maxIdentifierLength } from '../sql/identifiers.ts'
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
  kinds: 64
} as const

/** The kinds the index holds, as Object Explorer names them: every kind it lists but the server, return values and the SSIS
 *  Catalog's (tests/object-search.test.ts checks this against the catalogue). */
export const searchKinds = [
  'table', 'view', 'procedure', 'function', 'synonym', 'sequence', 'trigger', 'type', 'tableType', 'databaseTrigger',
  'login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'backupDevice', 'linkedServer', 'serverTrigger',
  'database', 'user', 'databaseRole', 'applicationRole', 'schema', 'assembly', 'asymmetricKey', 'certificate', 'symmetricKey', 'columnMasterKey',
  'columnEncryptionKey', 'databaseAuditSpecification', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist', 'partitionScheme',
  'partitionFunction', 'searchPropertyList', 'planGuide', 'xmlSchemaCollection', 'rule', 'default', 'securityPolicy',
  'column', 'key', 'constraint', 'index', 'statistic', 'parameter'
] as const satisfies readonly NodeKind[]
export type SearchKind = typeof searchKinds[number]
export const searchScopes = ['all', 'names', 'definitions'] as const
export type SearchScope = typeof searchScopes[number]

/** Search Objects' type filters, in the order the chips show: each names a set of kinds, and together they name every kind the
 *  index holds exactly once (tests/object-search.test.ts). A search with none chosen searches every kind; with some, the kinds
 *  of those it names. */
export const searchTypes = [
  { id: 'tables', label: 'Tables', kinds: ['table'] },
  { id: 'views', label: 'Views', kinds: ['view'] },
  { id: 'columns', label: 'Columns', kinds: ['column'] },
  { id: 'procedures', label: 'Procedures', kinds: ['procedure'] },
  { id: 'functions', label: 'Functions', kinds: ['function'] },
  { id: 'parameters', label: 'Parameters', kinds: ['parameter'] },
  { id: 'triggers', label: 'Triggers', kinds: ['trigger', 'databaseTrigger', 'serverTrigger'] },
  { id: 'indexes', label: 'Keys and indexes', kinds: ['key', 'constraint', 'index', 'statistic'] },
  { id: 'schemas', label: 'Schemas', kinds: ['schema'] },
  { id: 'types', label: 'Types', kinds: ['type', 'tableType', 'xmlSchemaCollection', 'rule', 'default'] },
  { id: 'security', label: 'Security', kinds: [
    'login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'user', 'databaseRole', 'applicationRole', 'asymmetricKey',
    'certificate', 'symmetricKey', 'columnMasterKey', 'columnEncryptionKey', 'databaseAuditSpecification', 'securityPolicy'
  ] },
  { id: 'other', label: 'Other', kinds: [
    'synonym', 'sequence', 'database', 'assembly', 'backupDevice', 'linkedServer', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist',
    'partitionScheme', 'partitionFunction', 'searchPropertyList', 'planGuide'
  ] }
] as const satisfies readonly { readonly id: string; readonly label: string; readonly kinds: readonly SearchKind[] }[]
export type SearchType = typeof searchTypes[number]['id']

/** The kinds a search with these type filters names, in the index's order; undefined (every kind) when none is chosen. */
export function searchTypeKinds(types: readonly SearchType[]): SearchKind[] | undefined {
  if (!types.length) return undefined
  const chosen = new Set<SearchKind>(searchTypes.filter(type => types.includes(type.id)).flatMap(type => type.kinds))
  return searchKinds.filter(kind => chosen.has(kind))
}

/** Skip codes a status lists for a database the index still holds (ObjectSearchService.ChildrenLeftOut): its objects without
 *  their columns, indexes, statistics and parameters, which would have taken the index past its memory. */
export const childrenLeftOut = 'CHILDREN_LEFT_OUT'

export interface ObjectIndexParams { readonly connectionId: string; readonly requestId: string; readonly definitions?: boolean }
export interface ObjectIndexSkip { readonly database: string; readonly code: string; readonly message: string }
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
}
export interface ObjectIndexResult { readonly status: ObjectIndexStatus; readonly elapsedMs: number }

export interface ObjectSearchParams {
  readonly connectionId: string
  readonly requestId: string
  readonly text: string
  readonly caseSensitive?: boolean
  readonly wholeWord?: boolean
  readonly regex?: boolean
  readonly in?: SearchScope
  readonly kinds?: readonly SearchKind[]
  readonly database?: string
  readonly limit?: number
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
}
export interface ObjectSearchHit {
  readonly object: ObjectRef
  readonly folder: FolderId
  /** schema.name, parentSchema.parent.name for a child (a column, key or trigger), or the name alone. */
  readonly label: string
  /** The name match's [start, length] in label. */
  readonly range?: readonly [number, number]
  readonly modified?: string
  readonly definition?: DefinitionMatch
  /** The node's subtype, where the index knows it (a foreign key, an inline function, a SQL login). */
  readonly subtype?: NodeSubtype
  /** The folder that lists a child's parent (a graph table's columns are under Tables › Graph Tables). */
  readonly parentFolder?: FolderId
  /** The table (in the hit's database, listed in `folder`) whose history row is a temporal or ledger history table: the hit
   *  itself, or a child's parent. */
  readonly via?: { readonly schema: string; readonly name: string; readonly folder: FolderId }
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
  type: z.literal('explorer.index.progress'), done: z.number().int().min(0), total: z.number().int().min(0), objects: z.number().int().min(0)
}).strict().refine(value => value.done <= value.total, 'A build cannot have read more databases than it lists.')
export type ObjectIndexProgressEvent = z.infer<typeof objectIndexProgressEventSchema>
/** What main pushes on `varia:explorer-index-progress` to the window that started the build. */
export interface ObjectIndexProgress { readonly requestId: string; readonly done: number; readonly total: number; readonly objects: number }

// zod's max() counts code points; the backend counts UTF-16 code units.
const units = (max: number) => z.string().min(1).refine(value => value.length <= max, `At most ${max} UTF-16 code units.`)
export const objectIndexParamsSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), definitions: z.boolean().optional() }).strict() satisfies z.ZodType<ObjectIndexParams>
export const objectSearchParamsSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), text: units(objectSearchLimits.text).refine(value => !value.includes('\u0000'), 'The text cannot contain U+0000.'),
  caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), regex: z.boolean().optional(), in: z.enum(searchScopes).optional(),
  kinds: z.array(z.enum(searchKinds)).min(1).max(objectSearchLimits.kinds).optional(),
  database: units(maxIdentifierLength).refine(value => !value.includes('\u0000'), 'A name cannot contain U+0000.').optional(),
  limit: z.number().int().min(1).max(objectSearchLimits.hits).optional()
}).strict() satisfies z.ZodType<ObjectSearchParams>
