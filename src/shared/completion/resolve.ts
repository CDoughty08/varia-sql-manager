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
/** How many WITH queries or subqueries deep a `*` is followed for columns: past it a source gives none (a long chain of WITH
 *  queries, each reading the last through `*`, would otherwise recurse once per query). */
export const resolverLimits = { starHops: 64 } as const

export function columnAt(columns: readonly ScopeColumn[], path: readonly string[]): ScopeColumn | undefined {
  const wanted = path.join('.')
  return columns.find(column => sameName(column.path, wanted))
}

/** Whether language.lookup takes a request: every path segment 1 to segmentChars long, a prefix up to prefixChars. A half-typed
 *  quoted name can give an empty segment; asking with it would refuse the whole batch. */
export function lookupTakes(request: LanguageLookupPath): boolean {
  return request.path.every(segment => segment.length >= 1 && segment.length <= languageLookupLimits.segmentChars) && (request.prefix?.length ?? 0) <= languageLookupLimits.prefixChars
}

/** `lookup` asked only for the requests it takes; the others answer as absent, with nothing. */
export function boundedLookup(lookup: IndexLookup): IndexLookup {
  return async requests => {
    const sent = requests.filter(lookupTakes)
    if (sent.length === requests.length) return lookup(requests)
    const answers = sent.length ? await lookup(sent) : []
    if (!answers) return undefined
    let next = 0
    return requests.map(request => lookupTakes(request) ? answers[next++] : { state: 'absent' as const, path: [], items: [], truncated: false })
  }
}

/** One lookup per completion or hover: the objects the scope reads, by path, each asked once. */
export class ScopeResolver {
  private readonly answers = new Map<string, LanguageLookupAnswer>()
  private readonly cache = new Map<ScopeSource, Promise<SourceColumns>>()
  private readonly ctes = new Map<string, QueryShape>()
  /** Sources being read: one met again while it is read (a WITH query that reads itself) gives no columns. */
  private readonly reading = new Set<ScopeSource>()
  /** An object's columns by index path, shared by every source that names it. */
  private readonly objects = new Map<string, SourceColumns>()
  private readonly lookup: IndexLookup
  failed = false
  /** Objects past the request cap went unasked, so the scope's columns are not all here. */
  cut = false

  /** `prefix` narrows every object's columns to those starting with it: a second ask when the first was cut short. */
  constructor(private readonly scope: QueryScope, private readonly dialect: CompletionDialect, lookup: IndexLookup, private readonly prefix?: string) {
    this.lookup = boundedLookup(lookup)
    for (const cte of scope.ctes) if (!this.ctes.has(cte.name.toLowerCase())) this.ctes.set(cte.name.toLowerCase(), cte.shape)
  }

  /** Asks the index for every object source in reach (and the objects WITH queries and subqueries read through `*`), plus `extra`,
   *  whose answers it returns; `details` adds columns' descriptions (hover). */
  async load(extra: readonly LanguageLookupPath[] = [], details = false): Promise<readonly LanguageLookupAnswer[]> {
    const paths = new Map<string, string[]>()
    const seen = new Set<ScopeSource | QueryShape>()
    // Breadth first without recursion, within the star budget columns() keeps to.
    let level: ScopeSource[] = [...this.scope.sources]
    for (let hop = 0; level.length && hop <= resolverLimits.starHops; hop++) {
      const next: ScopeSource[] = []
      for (const source of level) {
        if (seen.has(source)) continue
        seen.add(source)
        if (source.kind === 'object') {
          const path = this.dialect.objectPath(source.parts)
          if (path && !paths.has(key(path))) paths.set(key(path), [...path])
        } else if (source.kind === 'cte' || source.kind === 'derived') {
          const shape = source.kind === 'cte' ? this.cte(source.cte) : source.shape
          if (shape && !seen.has(shape)) { seen.add(shape); next.push(...shape.stars) }
        }
      }
      level = next
    }
    // Each object gets its share of the answer's total, so a later one is not left with nothing.
    const objects = [...paths.values()].slice(0, languageLookupLimits.requests - extra.length)
    this.cut = objects.length < paths.size
    const share = Math.max(1, Math.min(languageLookupLimits.items, Math.floor((languageLookupLimits.totalItems - extra.reduce((sum, request) => sum + (request.limit ?? languageLookupLimits.defaultItems), 0)) / Math.max(1, objects.length))))
    const wanted: LanguageLookupPath[] = objects.map(path => ({ path, limit: share, ...this.prefix ? { prefix: this.prefix } : {}, ...details ? { details } : {} }))
    const requests = [...extra, ...wanted]
    if (!requests.length) return []
    const answers = await this.lookup(requests)
    if (!answers) { this.failed = true; return [] }
    wanted.forEach((request, index) => { const answer = answers[extra.length + index]; if (answer) this.answers.set(key(request.path), answer) })
    return answers.slice(0, extra.length)
  }

  cte(name: string): QueryShape | undefined { return this.ctes.get(name.toLowerCase()) }

  /** A source's columns: the index's for an object, the select list's (with `*` expanded) for a WITH query or subquery. The grammar
   *  has already said which names are WITH queries (kind cte); an object is always the index's. */
  columns(source: ScopeSource, hops = 0): Promise<SourceColumns> {
    if (this.reading.has(source)) return Promise.resolve({ columns: [], truncated: false })
    let found = this.cache.get(source)
    if (!found) {
      // Past the budget nothing is kept, so a nearer reader of the same source still gets its columns.
      if (hops > resolverLimits.starHops) return Promise.resolve({ columns: [], truncated: true })
      this.reading.add(source)
      found = this.read(source, hops).finally(() => this.reading.delete(source))
      this.cache.set(source, found)
    }
    return found
  }

  private async read(source: ScopeSource, hops: number): Promise<SourceColumns> {
    switch (source.kind) {
      case 'object': {
        const path = this.dialect.objectPath(source.parts)
        const answer = path ? this.answers.get(key(path)) : undefined
        if (!path || !answer?.object) return { columns: [], truncated: false, path }
        let shared = this.objects.get(key(path))
        if (!shared) {
          shared = { path: answer.path, object: answer.object, truncated: answer.truncated,
            columns: answer.items.map(item => ({ path: item.name, type: item.type, nullable: item.nullable, description: item.description })) }
          this.objects.set(key(path), shared)
        }
        return shared
      }
      case 'cte': { const shape = this.cte(source.cte); return shape ? this.shape(shape, hops) : { columns: [], truncated: false } }
      case 'derived': return this.shape(source.shape, hops)
      case 'unnest': {
        // UNNEST(hits) AS hits: the path names what the source reads, not the source itself.
        const field = await this.field(source.path, source)
        if (!field) return { columns: [], truncated: false }
        const prefix = field.path.length
        return { truncated: field.columns.truncated, columns: childrenAndBelow(field.columns.columns, field.path).map(column => ({ ...column, path: column.path.split('.').slice(prefix).join('.') })) }
      }
    }
  }

  /** A select list's columns: its named ones, then every column its `*` sources give (their top level and below). */
  private async shape(shape: QueryShape, hops: number): Promise<SourceColumns> {
    const columns: ScopeColumn[] = shape.columns.map(path => ({ path }))
    let truncated = false
    for (const star of shape.stars) {
      const given = await this.columns(star, hops + 1)
      truncated ||= given.truncated
      for (const column of given.columns) if (!columns.some(known => sameName(known.path, column.path))) columns.push(column)
    }
    return { columns, truncated }
  }

  /** What a written chain names, for member completion, UNNEST and hover: a source by its name then a field path in it, else a
   *  column (and fields) of a source in reach, nearest first. */
  async field(parts: readonly string[], except?: ScopeSource): Promise<{ source: ScopeSource; path: string[]; columns: SourceColumns } | undefined> {
    if (!parts.length) return
    const named = this.scope.sources.find(source => source !== except && source.name !== undefined && sameName(source.name, parts[0]))
    if (named) return { source: named, path: parts.slice(1), columns: await this.columns(named) }
    const seen = new Set<SourceColumns>()
    for (const source of this.scope.sources) {
      if (source === except) continue
      const columns = await this.columns(source)
      if (seen.has(columns)) continue
      seen.add(columns)
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
