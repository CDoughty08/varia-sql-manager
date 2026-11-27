// Varia's own completion from the Search Objects index (docs/language-services.md, Completion from the index): the parts
// every engine shares. An engine's grammar reads a statement into this model (src/shared/googlesql/scope.ts for BigQuery)
// and its dialect says how names are written and how a written name becomes an index path; complete.ts and hover.ts do the
// rest from language.lookup's answers. Nothing here knows an engine.
import type { LanguageLookupAnswer, LanguageLookupItem, LanguageLookupObject, LanguageLookupPath } from '../language-lookup'

/** A span of the text: `end` is exclusive. */
export interface TextSpan { readonly start: number; readonly end: number }

/** What a query block's columns are, as far as the reader can tell: named columns, plus every column of some sources (`*`, `t.*`). */
export interface QueryShape {
  readonly columns: readonly string[]
  /** Sources whose columns a `*` (or `alias.*`) brings in. */
  readonly stars: readonly ScopeSource[]
}

/**
 * A table-like source a statement reads, named by `name` in the statement (its alias, else its last name part).
 * - object: an indexed object by its written name parts, unquoted (`['my-proj', 'sales', 'orders']`).
 * - cte: a WITH name, resolved through the scope's `ctes`.
 * - derived: a subquery, with the columns its select list gives.
 * - unnest: the elements of an array column or field (`UNNEST(o.items) AS item`): `path` is the expression's written parts;
 *   a STRUCT element's fields are its columns.
 */
export type ScopeSource =
  | { readonly kind: 'object'; readonly name: string; readonly parts: readonly string[]; readonly span?: TextSpan }
  | { readonly kind: 'cte'; readonly name: string; readonly cte: string; readonly shape?: QueryShape; readonly span?: TextSpan }
  | { readonly kind: 'derived'; readonly name?: string; readonly shape: QueryShape }
  | { readonly kind: 'unnest'; readonly name?: string; readonly path: readonly string[] }

/** A WITH name and the columns its query gives. */
export interface CteScope { readonly name: string; readonly shape: QueryShape }

/** The names a position can see: its query block's sources (nearest first, then enclosing blocks') and the WITH names in reach. */
export interface QueryScope { readonly sources: readonly ScopeSource[]; readonly ctes: readonly CteScope[] }

/**
 * What the caret completes:
 * - none: nothing (a string, comment or number; a new alias after AS).
 * - object: a name where a table goes (FROM, JOIN, UPDATE, INTO): `qualifier` holds the parts written before the one typed.
 * - member: a name after dots in an expression (`o.address.ci`): an alias, table or column, then fields.
 * - expression: a bare name in an expression: columns, aliases, functions and keywords.
 * - afterFromTable: after a FROM/JOIN table, subquery, CTE or alias: only valid FROM-clause continuations.
 * - statementStart: the start of a statement or parenthesized query block.
 * - castType: inside `CAST(... AS |)` or `SAFE_CAST(... AS |)` (and type arguments).
 * - datePart: a granularity argument in `EXTRACT`, `DATE_TRUNC`, `DATE_DIFF`, etc.
 * - systemVar: a `@@` system variable (`@@project_id`, `@@script.bytes_billed`, ...).
 * - infoSchema: after `INFORMATION_SCHEMA.`, qualified by `qualifier` (dataset, project.dataset, or region).
 * - joinCondition: inside a `JOIN ... ON` or `USING` condition.
 * - unnestArg: inside `UNNEST(...)`, where array-typed columns rank ahead of scalars.
 */
export type CompletionSite =
  | { readonly kind: 'none' }
  | { readonly kind: 'object'; readonly qualifier: readonly string[] }
  | { readonly kind: 'member'; readonly qualifier: readonly string[] }
  | { readonly kind: 'expression' }
  | { readonly kind: 'afterFromTable'; readonly hasAlias?: boolean; readonly inJoin?: boolean; readonly mergeUsing?: boolean }
  | { readonly kind: 'statementStart' }
  | { readonly kind: 'castType' }
  | { readonly kind: 'datePart'; readonly functionName?: string }
  | { readonly kind: 'systemVar'; readonly qualifier?: readonly string[] }
  | { readonly kind: 'infoSchema'; readonly qualifier: readonly string[] }
  | { readonly kind: 'joinCondition'; readonly clause?: 'on' | 'using' }
  | { readonly kind: 'unnestArg' }

/**
 * The word being completed: where it starts (the replace range runs from `start` to the caret, and on to `end`, the end of the
 * name part under the caret), what is typed of it, and whether it sits inside an open or closed quoted identifier, whose
 * insert text is the bare name (the quotes are already there).
 */
export interface CompletionWord extends TextSpan {
  readonly typed: string
  readonly quoted: boolean
  /** True when `(` already follows the word on the same line, so call completions skip inserting `($0)`. */
  readonly parenAhead?: boolean
  /** True when `<` already follows the word on the same line, so generic types skip inserting `<$0>`. */
  readonly angleAhead?: boolean
}

/** A grammar's reading of one position: what to complete, the scope, and the word. */
export interface CompletionRead {
  readonly site: CompletionSite
  readonly scope: QueryScope
  readonly word: CompletionWord
  /** Start offset of an unquoted dotted qualifier chain immediately before `word` (e.g. `o` in `o.items.`). */
  readonly qualifierStart?: number
  /** True when the caret is inside an `UNNEST(...)` argument (including `UNNEST(o.|)`), prioritizing ARRAY columns. */
  readonly preferArray?: boolean
}

/** A name chain under the caret for hover: its parts, which part the caret is on, its span, whether it names a table (FROM), and
 *  whether a parenthesis follows it outside FROM (`call`: a function, which Go To Definition looks up as a routine). */
export interface HoverRead { readonly parts: readonly string[]; readonly at: number; readonly span: TextSpan; readonly object: boolean; readonly call?: boolean; readonly scope: QueryScope }

/** A function the dialect knows, for completion and hover. */
export interface DialectFunction { readonly name: string; readonly summary: string; readonly signatures: readonly string[]; readonly niladic?: boolean }

/** A dialect-synthesized column (such as BigQuery `_TABLE_SUFFIX`, `_PARTITIONTIME`, `_PARTITIONDATE`, `_FILE_NAME`). */
export interface DialectColumn { readonly name: string; readonly type: string; readonly description?: string; readonly pseudo?: boolean }

/** An extra object completion item synthesized alongside an index entry (such as a date-sharded wildcard `events_*`). */
export interface ObjectVariant {
  readonly label: string
  readonly kind?: CompletionKind
  readonly insertName?: string
  readonly detail?: string
  readonly documentation?: string
  readonly filterText?: string
  readonly before?: boolean
}

/** What an object site's qualifier may name: the index paths whose children complete it. */
export interface ContainerQuery { readonly path: readonly string[] }

/** How an engine writes names and maps them onto the index (src/shared/googlesql/dialect.ts for BigQuery). */
export interface CompletionDialect {
  /** An object's written name parts as the index path of the object (defaults filled in), or undefined when they cannot name one. */
  objectPath(parts: readonly string[]): readonly string[] | undefined
  /** The containers whose children complete an object name written after `qualifier`, nearest first. */
  containers(qualifier: readonly string[]): readonly ContainerQuery[]
  /** A name as an unquoted word when it can be one, else quoted. */
  quote(name: string): string
  /** An index entry's completion kind, and the detail its item shows (its kind, a routine's signature, a sharded group). */
  itemKind(item: LanguageLookupItem): CompletionKind
  itemDetail(item: LanguageLookupItem): string | undefined
  /** Synthesized variants for an index object entry (e.g. `events_*` wildcard ahead of the latest concrete shard). */
  objectVariants?(item: LanguageLookupItem): readonly ObjectVariant[]
  /** Engine-specific pseudo-columns for a resolved object (excluded from `SELECT *` expansion). */
  pseudoColumns?(object: LanguageLookupObject, writtenParts: readonly string[]): readonly DialectColumn[]
  /** Whether a column type is an ARRAY type (for `UNNEST` ranking and blocking direct field access on `ARRAY<STRUCT>`). */
  isArrayType?(type: string | undefined): boolean
  /** Actionable replacement suggestion when the user attempts direct `.` field access on an `ARRAY<STRUCT>` expression. */
  arrayMemberHint?(targetParts: readonly string[], childFields: readonly string[], qualifierSpan?: TextSpan): CompletionItem | undefined
  /** Deduplication identity for completion items (default: case-insensitive `kind:label`). */
  itemKey?(kind: CompletionKind, label: string): string
  /** An object's kind as hover names it (Table, View). */
  objectLabel(kind: string, subtype?: string): string
  /** An object's index path as the editor writes it in hover (`project.dataset.table`). */
  pathText(path: readonly string[]): string
  readonly keywords: readonly string[]
  /** Context-specific keywords for clause sites (e.g. `afterFromTable`, `statementStart`, `castType`). */
  keywordsFor?(site: CompletionSite): readonly string[]
  /** Engine-specific completion items for specialized sites (`castType`, `datePart`, `systemVar`, `infoSchema`). */
  siteItems?(site: CompletionSite, word: CompletionWord, insert: (name: string) => string): readonly CompletionItem[] | undefined
  readonly functions: readonly DialectFunction[]
  /** The function a written name calls, if the dialect knows it. */
  functionNamed(name: string): DialectFunction | undefined
  /** Function namespaces (`NET`) whose members complete after a dot, and prefixes that take any function (`SAFE`). */
  readonly functionNamespaces: readonly string[]
  readonly anyFunctionPrefixes: readonly string[]
}

/** The neutral kinds of a completion item; the editor maps them onto its own icons. */
export type CompletionKind = 'keyword' | 'function' | 'container' | 'table' | 'view' | 'routine' | 'model' | 'column' | 'field' | 'alias' | 'cte'
export interface CompletionItem {
  readonly label: string
  readonly kind: CompletionKind
  readonly insertText: string
  readonly detail?: string
  readonly documentation?: string
  /** Orders the list ahead of the editor's fuzzy score among equals. */
  readonly sortText: string
  /** What the editor matches the typed text against, when not the label. */
  readonly filterText?: string
  /** True when `insertText` uses snippet tabstop syntax (e.g. `DATE_TRUNC($0)`). */
  readonly insertTextIsSnippet?: boolean
  /** True when accepting the item should open Signature Help (`editor.action.triggerParameterHints`). */
  readonly triggerParameterHints?: boolean
  /** Optional span to delete atomically when accepting the item (e.g. replacing `o.items.` with `UNNEST(o.items)`). */
  readonly additionalDeleteSpan?: TextSpan
}
/** `incomplete`: more names exist than came back, so the editor asks again as the word grows. */
export interface CompletionList { readonly items: readonly CompletionItem[]; readonly incomplete: boolean }

/** language.lookup as the pipeline calls it: one answer per request, in order; undefined when the index could not answer. */
export type IndexLookup = (requests: readonly LanguageLookupPath[]) => Promise<readonly LanguageLookupAnswer[] | undefined>
