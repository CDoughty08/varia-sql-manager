// Object Explorer node identity: what a node is, independent of the folder showing it. Refs carry names, never paths or
// object_ids, so they survive refresh, drop and recreate, and map to `[schema].[name]` for drag and copy and to SMO URNs.
import { quoteName } from '../sql/identifiers.ts'
import { kindSpecs, type dateFilterOps, type FolderId, type KindScope, type NodeKind, type NodeSubtype, type ParentKind, type textFilterOps } from './catalog.ts'

export { quoteName }
export type { FolderId, KindScope, NodeKind, NodeSubtype, ParentKind }

export interface ParentRef { readonly kind: ParentKind; readonly schema: string; readonly name: string }
/** Which fields are present follows the kind's scope (`scopeFields`); names are used verbatim, never trimmed. */
export interface ObjectRef {
  readonly kind: NodeKind
  /** databaseObject, schemaObject and child scopes. */
  readonly database?: string
  /** schemaObject scope. */
  readonly schema?: string
  /** Absent for `server` and `returnValue`. */
  readonly name?: string
  /** child scopes. */
  readonly parent?: ParentRef
}
/** A node: an object, or a folder below its nearest object (the server, a database, or a table, view, type or module). */
export type ExplorerNodeRef =
  | { readonly type: 'object'; readonly object: ObjectRef }
  | { readonly type: 'folder'; readonly owner: ObjectRef; readonly folder: FolderId }
/** What a command acts on: the selected node. */
export interface ExplorerTarget {
  readonly connectionId: string
  readonly ref: ExplorerNodeRef
  readonly kind: NodeKind | 'folder'
  readonly folder?: FolderId
  readonly subtype?: NodeSubtype
  readonly label: string
}

export type TextFilterOp = typeof textFilterOps[number]
export type DateFilterOp = typeof dateFilterOps[number]
export interface TextFilter { readonly op: TextFilterOp; readonly value: string }
/** Dates are `yyyy-mm-dd`; `value2` is present exactly for `between` and `notBetween`, and is not before `value`. */
export interface DateFilter { readonly op: DateFilterOp; readonly value: string; readonly value2?: string }
/** SSMS's Filter Settings: properties combine with AND, and only those `folderSpecs[folder].filter` allows. */
export interface ExplorerFilter { readonly name?: TextFilter; readonly schema?: TextFilter; readonly owner?: TextFilter; readonly created?: DateFilter }

export interface ExplorerChildrenParams {
  readonly connectionId: string
  /** The renderer's id for this load, which cancellation names. */
  readonly requestId: string
  readonly node: ExplorerNodeRef
  /** The expanded object's subtype: it picks the folder set and the history row (a table's). */
  readonly subtype?: NodeSubtype
  /** The previous page's opaque cursor: `v1.<queryId>.<payload>`. */
  readonly cursor?: string
  readonly pageSize?: number
  readonly filter?: ExplorerFilter
}
export interface ExplorerCancelParams { readonly requestIds: readonly string[] }

export const kindScope = (kind: NodeKind): KindScope => kindSpecs[kind].scope

/** A node's identity within the tree: case-sensitive, and distinct for any two refs, whatever characters names hold. */
export function refKey(connectionId: string, ref: ExplorerNodeRef): string {
  const object = ref.type === 'object' ? ref.object : ref.owner
  const { parent } = object
  return JSON.stringify([connectionId, ref.type, object.kind, object.database ?? null, object.schema ?? null, object.name ?? null,
    parent?.kind ?? null, parent?.schema ?? null, parent?.name ?? null, ref.type === 'folder' ? ref.folder : null])
}

/** What dragging the node into a query or Copy Name inserts: `[name]`, `[schema].[name]`, a parameter's `@name`, or nothing. */
export function insertTextFor(ref: ExplorerNodeRef): string | undefined {
  if (ref.type !== 'object') return undefined
  const { kind, schema, name } = ref.object
  if (name === undefined) return undefined
  switch (kindSpecs[kind].insert) {
    case 'onePart': return quoteName(name)
    case 'twoPart': return schema === undefined ? undefined : quoteName(schema) + '.' + quoteName(name)
    case 'raw': return name
    case 'none': return undefined
  }
}

// C0 and C1 controls (with DEL), line and paragraph separators, bidi embeddings, overrides and isolates, and the BOM.
const hidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g
/** A name as shown: characters that are invisible or reorder text become visible markers such as `⟨U+202E⟩`. Display only. */
export const displayText = (text: string): string => text.replace(hidden, char => `⟨U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`)
