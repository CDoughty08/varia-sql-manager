// Object Explorer's Peek: the kinds it describes, the properties it shows for each (grouped as SSMS's Properties pages
// group them), where each kind's definition comes from, and its limits. explorer.peek reads one constant batch per kind
// (backend Explorer/PeekSql.cs) whose result columns are these facts' ids, in this order; the backend takes the list from
// the `peek` block of the embedded Explorer/explorer-catalog.json, which explorerCatalogJson writes.
import type { ExplorerError } from '../contracts.ts'
import type { NodeKind } from './catalog.ts'
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
 * `module`: the definition is the module's text from sys.sql_modules, read with the facts. `script`: the kind has no stored
 * text, so the card asks Script As (scripting.script, CREATE) for it.
 */
export interface PeekKindSpec { readonly kind: PeekKind; readonly definition: 'module' | 'script'; readonly groups: readonly PeekGroup[] }

const fact = (id: string, label: string, format: PeekFormat, since?: number): PeekFact => since === undefined ? { id, label, format } : { id, label, format, since }
const owned = [fact('schema', 'Schema', 'text'), fact('created', 'Created', 'date'), fact('modified', 'Last modified', 'date'), fact('systemObject', 'System object', 'bool')]
const sqlOptions = [fact('ansiNulls', 'ANSI NULLs', 'bool'), fact('quotedIdentifier', 'Quoted identifier', 'bool')]

export const peekSpecs: { readonly [K in PeekKind]: PeekKindSpec } = {
  table: {
    kind: 'table', definition: 'script', groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('replicated', 'Replicated', 'bool'), fact('lockEscalation', 'Lock escalation', 'text'),
        fact('memoryOptimized', 'Memory optimized', 'bool'), fact('temporal', 'Temporal', 'text', 13), fact('ledger', 'Ledger', 'text', 16)] },
      { id: 'storage', title: 'Storage', facts: [fact('rowCount', 'Row count', 'count'), fact('dataSpace', 'Data space', 'kb'), fact('indexSpace', 'Index space', 'kb'),
        fact('filegroup', 'Filegroup', 'text'), fact('textFilegroup', 'Text filegroup', 'text'), fact('partitioned', 'Partitioned', 'bool'), fact('compression', 'Data compression', 'text')] }
    ]
  },
  view: {
    kind: 'view', definition: 'module', groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('schemaBound', 'Schema bound', 'bool'), fact('indexed', 'Indexed', 'bool'), ...sqlOptions] }
    ]
  },
  procedure: {
    kind: 'procedure', definition: 'module', groups: [
      { id: 'general', title: 'General', facts: owned },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('recompile', 'Recompile', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'), ...sqlOptions] }
    ]
  },
  function: {
    kind: 'function', definition: 'module', groups: [
      { id: 'general', title: 'General', facts: [...owned, fact('functionType', 'Function type', 'text')] },
      { id: 'options', title: 'Options', facts: [fact('executeAs', 'Execute as', 'text'), fact('schemaBound', 'Schema bound', 'bool'), fact('nativelyCompiled', 'Natively compiled', 'bool'),
        fact('nullOnNullInput', 'Returns NULL on NULL input', 'bool'), ...sqlOptions] }
    ]
  }
}

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
  backgroundScripts: 2
} as const

export type PeekValue = string | number | boolean | null
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

/** The block explorerCatalogJson embeds for the backend. */
export const peekCatalogBlock = () => ({
  kinds: peekKinds.map(kind => ({ kind, definition: peekSpecs[kind].definition, facts: peekFacts(kind).map(({ id, format, since }) => ({ id, format, since: since ?? null })) })),
  definitionChars: peekLimits.definitionChars,
  budgetMs: peekLimits.budgetMs
})
