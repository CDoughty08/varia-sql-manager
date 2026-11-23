// How the completion pipeline finds the columns a scope can see: each source's columns from the index (an object), its WITH
// query's or subquery's select list (cte, derived), or an array's element fields (unnest). One language.lookup asks for every
// object the scope names; nothing here knows an engine.
import { languageLookupLimits, type LanguageLookupAnswer, type LanguageLookupObject, type LanguageLookupPath } from '../language-lookup'
import type { CompletionDialect, IndexLookup, QueryScope, QueryShape, ScopeSource } from './model'

/** A column or nested field a source gives: its full path (address.city), with what the index knows of it. */
export interface ScopeColumn { readonly path: string; readonly type?: string; readonly nullable?: boolean; readonly description?: string }
/** A source's columns as far as they are known; `truncated` when the index holds more than came back. */
export interface SourceColumns { readonly columns: readonly ScopeColumn[]; readonly truncated: boolean; readonly object?: LanguageLookupObject; readonly path?: readonly string[] }

/** Names compare as GoogleSQL compares column names and aliases: without case. */
export const sameName = (left: string, right: string): boolean => left === right || left.toLowerCase() === right.toLowerCase()

/** A source by the name the statement calls it, nearest first. */
export function sourceNamed(scope: QueryScope, name: string): ScopeSource | undefined {
  return scope.sources.find(source => source.name !== undefined && sameName(source.name, name))
}

/** The direct children of `parent` (a field path, empty for the top level) among full column paths. */
export function childrenOf(columns: readonly ScopeColumn[], parent: readonly string[]): ScopeColumn[] {
  const prefix = parent.length ? parent.join('.').toLowerCase() + '.' : ''
  return columns.filter(column => {
    const path = column.path.toLowerCase()
    return path.startsWith(prefix) && !column.path.slice(prefix.length).includes('.') && column.path.length > prefix.length
  })
}

/** The column at a field path, case ignored. */
export function columnAt(columns: readonly ScopeColumn[], path: readonly string[]): ScopeColumn | undefined {
  const wanted = path.join('.')
  return columns.find(column => sameName(column.path, wanted))
}

/** One lookup per completion or hover: the objects the scope reads, by path, each asked once. */
export class ScopeResolver {
  private readonly answers = new Map<string, LanguageLookupAnswer>()
  private readonly cache = new Map<ScopeSource, Promise<SourceColumns>>()
  /** Sources being read: one met again while it is read (a WITH query that reads itself) gives no columns. */
  private readonly reading = new Set<ScopeSource>()
  failed = false

  constructor(private readonly scope: QueryScope, private readonly dialect: CompletionDialect, private readonly lookup: IndexLookup) {}

  /** Asks the index for every object source in reach (and the objects WITH queries and subqueries read through `*`), plus `extra`,
   *  whose answers it returns; `details` adds columns' descriptions (hover). */
  async load(extra: readonly LanguageLookupPath[] = [], details = false): Promise<readonly LanguageLookupAnswer[]> {
    const paths = new Map<string, LanguageLookupPath>()
    const seen = new Set<ScopeSource | QueryShape>()
    const visit = (source: ScopeSource) => {
      if (seen.has(source)) return
      seen.add(source)
      if (source.kind === 'object') {
        const path = this.dialect.objectPath(source.parts)
        if (path) paths.set(key(path), { path: [...path], limit: languageLookupLimits.items, ...details ? { details } : {} })
      } else if (source.kind === 'cte' || source.kind === 'derived') {
        const shape = source.kind === 'cte' ? this.cte(source.cte) : source.shape
        if (shape && !seen.has(shape)) { seen.add(shape); shape.stars.forEach(visit) }
      }
    }
    this.scope.sources.forEach(visit)
    const wanted = [...paths.values()].slice(0, languageLookupLimits.requests - extra.length)
    const requests = [...extra, ...wanted]
    if (!requests.length) return []
    const answers = await this.lookup(requests)
    if (!answers) { this.failed = true; return [] }
    wanted.forEach((request, index) => { const answer = answers[extra.length + index]; if (answer) this.answers.set(key(request.path), answer) })
    return answers.slice(0, extra.length)
  }

  cte(name: string): QueryShape | undefined { return this.scope.ctes.find(cte => sameName(cte.name, name))?.shape }

  /** A source's columns: the index's for an object, the select list's (with `*` expanded) for a WITH query or subquery. The grammar
   *  has already said which names are WITH queries (kind cte); an object is always the index's. */
  columns(source: ScopeSource): Promise<SourceColumns> {
    if (this.reading.has(source)) return Promise.resolve({ columns: [], truncated: false })
    let found = this.cache.get(source)
    if (!found) {
      this.reading.add(source)
      found = this.read(source).finally(() => this.reading.delete(source))
      this.cache.set(source, found)
    }
    return found
  }

  private async read(source: ScopeSource): Promise<SourceColumns> {
    switch (source.kind) {
      case 'object': {
        const path = this.dialect.objectPath(source.parts)
        const answer = path ? this.answers.get(key(path)) : undefined
        if (!answer?.object) return { columns: [], truncated: false, path }
        return { path: answer.path, object: answer.object, truncated: answer.truncated,
          columns: answer.items.map(item => ({ path: item.name, type: item.type, nullable: item.nullable, description: item.description })) }
      }
      case 'cte': { const shape = this.cte(source.cte); return shape ? this.shape(shape) : { columns: [], truncated: false } }
      case 'derived': return this.shape(source.shape)
      case 'unnest': {
        const field = await this.field(source.path)
        if (!field) return { columns: [], truncated: false }
        const prefix = field.path.length
        return { truncated: field.columns.truncated, columns: childrenAndBelow(field.columns.columns, field.path).map(column => ({ ...column, path: column.path.split('.').slice(prefix).join('.') })) }
      }
    }
  }

  /** A select list's columns: its named ones, then every column its `*` sources give (their top level and below). */
  private async shape(shape: QueryShape): Promise<SourceColumns> {
    const columns: ScopeColumn[] = shape.columns.map(path => ({ path }))
    let truncated = false
    for (const star of shape.stars) {
      const given = await this.columns(star)
      truncated ||= given.truncated
      for (const column of given.columns) if (!columns.some(known => sameName(known.path, column.path))) columns.push(column)
    }
    return { columns, truncated }
  }

  /** What a written chain names, for member completion, UNNEST and hover: a source by its name then a field path in it, else a
   *  column (and fields) of a source in reach, nearest first. */
  async field(parts: readonly string[]): Promise<{ source: ScopeSource; path: string[]; columns: SourceColumns } | undefined> {
    if (!parts.length) return
    const named = sourceNamed(this.scope, parts[0])
    if (named) return { source: named, path: parts.slice(1), columns: await this.columns(named) }
    for (const source of this.scope.sources) {
      const columns = await this.columns(source)
      if (columnAt(columns.columns, [parts[0]])) return { source, path: [...parts], columns }
    }
  }
}

/** Every column at or below `parent`, excluding `parent` itself. */
function childrenAndBelow(columns: readonly ScopeColumn[], parent: readonly string[]): ScopeColumn[] {
  const prefix = parent.join('.').toLowerCase() + '.'
  return columns.filter(column => column.path.toLowerCase().startsWith(prefix))
}

const key = (path: readonly string[]) => JSON.stringify(path)
