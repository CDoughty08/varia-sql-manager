// Object Explorer's Peek: the kinds it describes, the properties it shows for each (grouped as SSMS's Properties pages
// group them), where each kind's definition comes from, and its limits. explorer.peek reads one constant batch per kind
// (backend Explorer/PeekSql.cs) whose result columns are these facts' ids, in this order; the backend takes the list from
// the `peek` block of the embedded Explorer/explorer-catalog.json, which explorerCatalogJson writes.
import type { ExplorerError } from '../contracts.ts'
import type { NodeKind, NodeSubtype } from './catalog.ts'
import type { ObjectRef } from './refs.ts'

export const peekKinds = ['table', 'view', 'procedure', 'function'] as const satisfies readonly NodeKind[]
export type PeekKind = typeof peekKinds[number]
export const isPeekKind = (kind: string): kind is PeekKind => (peekKinds as readonly string[]).includes(kind)

/**
 * How a fact's value travels and shows: `text` a string, `date` the server's local time as `yyyy-mm-ddThh:mm:ss`, `bool` a
 * boolean, `count` a whole number, `kb` a whole number of kilobytes.
 */
export const peekFormats = ['text', 'date', 'bool', 'count', 'kb'] as const
export type PeekFormat = typeof peekFormats[number]
/** `since`: the first version band whose catalog has the fact; on older servers the reply leaves it out. */
export interface PeekFact { readonly id: string; readonly label: string; readonly format: PeekFormat; readonly since?: number }
export interface PeekGroup { readonly id: string; readonly title: string; readonly facts: readonly PeekFact[] }
/**
 * The card's tabs beside Definition: `members` lists the object's Columns or Parameters folder (explorer.children, as the tree
 * lists it), `dependencies` what the object uses and what uses it (explorer.peekDependencies), and `rows` its first rows
 * (explorer.peekRows). Each is read the first time its tab is chosen, never with the facts: Dependencies stays its own request
 * so that a login refused sys.sql_expression_dependencies still sees the properties.
 */
export const peekTabs = ['definition', 'members', 'dependencies', 'rows'] as const
export type PeekTab = typeof peekTabs[number]
/**
 * `module`: the definition is the module's text from sys.sql_modules, read with the facts. `script`: the kind has no stored
 * text, so the card asks Script As (scripting.script, CREATE) for it. `members`: the folder the Columns or Parameters tab
 * lists. `rows`: whether the kind has rows to sample.
 */
export interface PeekKindSpec {
  readonly kind: PeekKind
  readonly definition: 'module' | 'script'
  readonly members: 'columns' | 'parameters'
  readonly rows: boolean
  readonly groups: readonly PeekGroup[]
}

const fact = (id: string, label: string, format: PeekFormat, since?: number): PeekFact => since === undefined ? { id, label, format } : { id, label, format, since }
const owned = [fact('schema', 'Schema', 'text'), fact('created', 'Created', 'date'), fact('modified', 'Last modified', 'date'), fact('systemObject', 'System object', 'bool')]
const sqlOptions = [fact('ansiNulls', 'ANSI NULLs', 'bool'), fact('quotedIdentifier', 'Quoted identifier', 'bool')]

export const peekSpecs: { readonly [K in PeekKind]: PeekKindSpec } = {
  table: {
    kind: 'table', definition: 'script', members: 'columns', rows: true, groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('replicated', 'Replicated', 'bool'), fact('lockEscalation', 'Lock escalation', 'text'),
        fact('memoryOptimized', 'Memory optimized', 'bool'), fact('temporal', 'Temporal', 'text', 13), fact('ledger', 'Ledger', 'text', 16)] },
      { id: 'storage', title: 'Storage', facts: [fact('rowCount', 'Row count', 'count'), fact('dataSpace', 'Data space', 'kb'), fact('indexSpace', 'Index space', 'kb'),
        fact('filegroup', 'Filegroup', 'text'), fact('textFilegroup', 'Text filegroup', 'text'), fact('partitioned', 'Partitioned', 'bool'), fact('compression', 'Data compression', 'text')] }
    ]
  },
  view: {
    kind: 'view', definition: 'module', members: 'columns', rows: true, groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('schemaBound', 'Schema bound', 'bool'), fact('indexed', 'Indexed', 'bool'), ...sqlOptions] }
    ]
  },
  procedure: {
    kind: 'procedure', definition: 'module', members: 'parameters', rows: false, groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('recompile', 'Recompile', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'), ...sqlOptions] }
    ]
  },
  function: {
    kind: 'function', definition: 'module', members: 'parameters', rows: false, groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('functionType', 'Function type', 'text')] },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('schemaBound', 'Schema bound', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'),
        fact('nullOnNullInput', 'Returns NULL on NULL input', 'bool'), ...sqlOptions] }
    ]
  }
}

/** The tabs a kind's card shows, in order. */
export const peekTabsOf = (kind: PeekKind): readonly PeekTab[] => peekTabs.filter(tab => tab !== 'rows' || peekSpecs[kind].rows)
/** A tab's title for a kind. */
export const peekTabTitle = (kind: PeekKind, tab: PeekTab): string =>
  tab === 'definition' ? 'Definition' : tab === 'members' ? (peekSpecs[kind].members === 'columns' ? 'Columns' : 'Parameters') : tab === 'dependencies' ? 'Dependencies' : 'Top rows'

/** A kind's facts in reply-column order. */
export const peekFacts = (kind: PeekKind): readonly PeekFact[] => peekSpecs[kind].groups.flatMap(group => group.facts)

export const peekLimits = {
  /** Module text kept, in UTF-16 code units; longer text is cut and marked `definitionTruncated`. */
  definitionChars: 1_000_000,
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
  /** Rows the Top rows tab reads (SELECT TOP (n) *, in no order, as SSMS's Select Top rows). */
  rows: 10,
  /** Cards Back remembers when dependencies are followed one after another. */
  backSteps: 16,
  /** Columns the Top rows tab shows; wider objects say how many more they have. */
  rowColumns: 100,
  /** UTF-16 code units of a value the Top rows tab keeps; longer values are cut and marked. */
  rowCellChars: 256
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
  /** A table, view, procedure or function. */
  readonly target: ObjectRef
}
export interface PeekResult {
  /** Fact id to value, for the kind's facts the server's band has; null where the catalog has no value (a heap's index space is 0, not null). */
  readonly facts: Readonly<Record<string, PeekValue>>
  /** `module` kinds: the module's text; absent when it is encrypted or the login may not see it. */
  readonly definition?: string
  readonly definitionTruncated?: true
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

/** explorer.peekRows: a table's or view's first rows, on Peek's slot, within its budget. */
export interface PeekRowsParams {
  readonly connectionId: string
  readonly requestId: string
  /** A table or view. */
  readonly target: ObjectRef
}
export interface PeekRowsColumn { readonly name: string; readonly type: string }
export interface PeekRowsResult {
  /** The first `peekLimits.rowColumns` columns. */
  readonly columns: readonly PeekRowsColumn[]
  /** Columns past those, left out. */
  readonly moreColumns?: number
  /** Each value as the results grid shows it (docs/ipc.md, Display formats), null for NULL, cut to `peekLimits.rowCellChars`. */
  readonly rows: readonly (readonly (string | null)[])[]
  /** [row, column] of the values that were cut. */
  readonly cut?: readonly (readonly [number, number])[]
  /** [row, column] of the values that could not be read (null in `rows`; the results grid shows them as NULL with a warning). */
  readonly unread?: readonly (readonly [number, number])[]
  readonly elapsedMs: number
  readonly error?: ExplorerError
}

/** The block explorerCatalogJson embeds for the backend. */
export const peekCatalogBlock = () => ({
  kinds: peekKinds.map(kind => ({ kind, definition: peekSpecs[kind].definition, rows: peekSpecs[kind].rows, facts: peekFacts(kind).map(({ id, format, since }) => ({ id, format, since: since ?? null })) })),
  definitionChars: peekLimits.definitionChars,
  budgetMs: peekLimits.budgetMs,
  dependencies: peekLimits.dependencies,
  rows: peekLimits.rows,
  rowColumns: peekLimits.rowColumns,
  rowCellChars: peekLimits.rowCellChars
})
