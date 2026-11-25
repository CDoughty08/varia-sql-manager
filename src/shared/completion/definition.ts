// Go To Definition from the index (docs/language-services.md, Completion from the index): the object a name under the caret
// stands for, resolved as completion and hover resolve it (the dialect's default project and dataset), from the Search Objects
// index through `lookup`. Nothing here knows an engine, and nothing is sent anywhere but the index.
import type { CompletionDialect, HoverRead, IndexLookup, TextSpan } from './model'
import { ScopeResolver } from './resolve'

/** The object a name stands for: its index path (container levels, then its name), its kind and subtype as the index has them. */
export interface IndexDefinition { readonly path: readonly string[]; readonly kind: string; readonly subtype?: string; readonly span: TextSpan }

/** Thrown when the index could not answer (busy or failed), which is not the same as answering that it holds no such object. */
export class IndexUnavailableError extends Error {}

/**
 * The object the name chain `read` (the hover reader's) names: a table, view or table function where a table is written (a WITH
 * name names none), a routine where it is called, or, in an expression, the object an alias or a column belongs to. Undefined
 * when the index holds no such object, or the name is a built-in function, a WITH query's or a subquery's. Throws
 * `IndexUnavailableError` when a lookup it needed got no answer.
 */
export async function definitionFromIndex(read: HoverRead, dialect: CompletionDialect, lookup: IndexLookup): Promise<IndexDefinition | undefined> {
  const { parts, at, span } = read
  const resolver = new ScopeResolver(read.scope, dialect, lookup)
  const object = async (written: readonly string[], routine: boolean): Promise<IndexDefinition | undefined> => {
    const path = dialect.objectPath(written)
    if (!path) return
    const [answer] = await resolver.load([{ path: [...path], limit: 1 }])
    if (resolver.failed) throw new IndexUnavailableError()
    const found = answer?.object
    if (!found || answer.path.length !== path.length) return
    if (routine !== (dialect.itemKind({ name: found.name, kind: found.kind }) === 'routine')) return
    return { path: [...answer.path.slice(0, -1), found.name], kind: found.kind, ...found.subtype ? { subtype: found.subtype } : {}, span }
  }
  if (read.call) {
    // `COUNT(`, `NET.HOST(`: the dialect's own functions are never the index's.
    if (dialect.functionNamed(parts.join('.'))) return
    return object(parts, true)
  }
  if (read.object) {
    if (parts.length === 1 && resolver.cte(parts[0])) return
    // A table function written where a table goes (`FROM ds.fn(…)`) is a routine there.
    return await object(parts, false) ?? object(parts, true)
  }
  await resolver.load()
  const field = await resolver.field(parts.slice(0, at + 1))
  if (resolver.failed) throw new IndexUnavailableError()
  if (!field || field.source.kind !== 'object' || !field.columns.object || !field.columns.path) return
  const owner = field.columns.object
  return { path: [...field.columns.path.slice(0, -1), owner.name], kind: owner.kind, ...owner.subtype ? { subtype: owner.subtype } : {}, span }
}
