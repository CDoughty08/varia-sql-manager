// How the completion pipeline finds the columns a scope can see: each source's columns from the index (an object), its WITH
// query's or subquery's select list (cte, derived), or an array's element fields (unnest). One language.lookup asks for every
// object the scope names; nothing here knows an engine.
import { languageLookupLimits, type LanguageLookupAnswer, type LanguageLookupObject, type LanguageLookupPath } from '../language-lookup'
import type { CompletionDialect, IndexLookup, QueryScope, QueryShape, ScopeSource } from './model'

/** A column or nested field a source gives: its full path (address.city), with what the index knows of it. */
export interface ScopeColumn { readonly path: string; readonly type?: string; readonly nullable?: boolean; readonly description?: string }
/** A source's columns as far as they are known; `truncated` when the index holds more than came back. */
export interface SourceColumns {
  readonly columns: readonly ScopeColumn[]; readonly truncated: boolean; readonly object?: LanguageLookupObject; readonly path?: readonly string[]
  /** Cut by the star budget: kept only for readers as deep or deeper, so a nearer reader of the same source or select list reads
   *  it again, with more of its columns. */
  readonly budget?: true
}

/** A source's or select list's columns as read `hops` stars deep; `budget` once known. */
interface Kept { found: Promise<SourceColumns>; readonly hops: number; budget?: boolean }
/** Whether a kept read serves a reader `hops` deep: any whole read, and one the budget cut for readers at least as deep (which it
 *  would cut as much or more). Each item is read again at most once per smaller depth, so a WITH query met many times costs at
 *  most starHops reads of it. */
const serves = (kept: Kept | undefined, hops: number): kept is Kept => !!kept && (kept.budget !== true || hops >= kept.hops)

/** Each column set's top-level names (address for address.city), lowercased: a bare name is looked for once per set, not per path. */
const heads = new WeakMap<SourceColumns, ReadonlySet<string>>()
function headsOf(columns: SourceColumns): ReadonlySet<string> {
  let found = heads.get(columns)
  if (!found) {
    found = new Set(columns.columns.map(column => column.path.split('.', 1)[0].toLowerCase()))
    heads.set(columns, found)
  }
  return found
}

/** What a source met again while it is read gives: one value, so callers that skip repeats skip it, and no cache keeps it. */
const unread: SourceColumns = Object.freeze({ columns: Object.freeze([] as ScopeColumn[]), truncated: false })

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

/** How many select-list reads, `*` columns merged and columns an UNNEST reads through one resolver does: past it the rest come
 *  back cut short (a web of WITH queries over wide tables, or thousands of UNNESTs of a wide one, could otherwise take seconds). */
const work = 1_000_000

/** starHops: how many WITH queries or subqueries deep a `*` is followed for columns: past it a source gives none (a long chain of
 *  WITH queries, each reading the last through `*`, would otherwise recurse once per query); unnestHops: how many UNNESTs deep a prefix is mapped; narrowPrefixes: prefixes per object in one second ask (each is a request);
 *  narrowUnnests: UNNEST sources whose element fields a second ask covers; fieldSources: sources a bare column name is looked for
 *  in (an UNNEST of a bare name reads them, and each may be an UNNEST of a bare name). */
export const resolverLimits = { starHops: 64, unnestHops: 8, narrowPrefixes: 4, narrowUnnests: 16, fieldSources: 64, work } as const

/** The column at a field path, case ignored. */
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

/** Prefixes to ask again by, per object (its path's key), when the first answer for it was cut short. */
export type Narrowing = ReadonlyMap<string, readonly string[]>

/** The same prefixes for every object in `paths`; an empty prefix would only repeat the first ask. */
export function narrowing(paths: ReadonlySet<string>, prefixes: readonly string[]): Narrowing {
  const kept = [...new Set(prefixes.filter(prefix => prefix.length > 0))]
  return new Map([...paths].map(path => [path, kept]))
}

/** Two answers for one object (asked by different prefixes) as one. */
function merged(had: LanguageLookupAnswer, more: LanguageLookupAnswer): LanguageLookupAnswer {
  const names = new Set(had.items.map(item => item.name))
  return { ...had, object: had.object ?? more.object, path: had.object ? had.path : more.path, truncated: had.truncated || more.truncated,
    items: [...had.items, ...more.items.filter(item => !names.has(item.name))] }
}

/** One lookup per completion or hover: the objects the scope reads, by path, each asked once. */
export class ScopeResolver {
  private readonly answers = new Map<string, LanguageLookupAnswer>()
  private readonly cache = new Map<ScopeSource, Kept>()
  /** A select list's columns, shared by every source that reads it (each name of a WITH query). */
  private readonly shapes = new Map<QueryShape, Kept>()
  private readonly shaping = new Set<QueryShape>()
  /** The scope's sources by name (lowercased), nearest first. */
  private named?: Map<string, ScopeSource[]>
  /** Select-list reads and columns merged so far (resolverLimits.work). */
  private spent = 0

  /** Whether reads went past the work cap: what they gave is not all there is. */
  get overBudget(): boolean { return this.spent > resolverLimits.work }

  /** Carries an earlier resolver's work over (a second ask is the same completion's, under the same cap). */
  inherit(from: ScopeResolver): this { this.spent = Math.max(this.spent, from.spent); return this }
  private readonly ctes = new Map<string, QueryShape>()
  /** Sources being read: one met again while it is read (a WITH query that reads itself) gives no columns. */
  private readonly reading = new Set<ScopeSource>()
  /** An object's columns by index path, shared by every source that names it. */
  private readonly objects = new Map<string, SourceColumns>()
  private readonly lookup: IndexLookup
  failed = false
  /** Objects past the request cap went unasked, so the scope's columns are not all here. */
  cut = false

  /** `narrow` asks again, for the objects it names only, the columns that start with its prefixes: a second ask when the first
   *  answer for them was cut short. The other objects are asked as before (the cache answers them). */
  constructor(private readonly scope: QueryScope, private readonly dialect: CompletionDialect, lookup: IndexLookup, private readonly narrow?: Narrowing) {
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
    // One request per object (by its first prefix when asked again), then the further prefixes: past the request cap those go
    // unasked before any object does.
    const asks: { path: string[]; prefix?: string }[] = []
    const more: { path: string[]; prefix: string }[] = []
    let dropped = false
    for (const path of paths.values()) {
      const all = this.narrow?.get(key(path)) ?? []
      dropped ||= all.length > resolverLimits.narrowPrefixes
      const prefixes = all.slice(0, resolverLimits.narrowPrefixes)
      asks.push(prefixes.length ? { path, prefix: prefixes[0] } : { path })
      for (const prefix of prefixes.slice(1)) more.push({ path, prefix })
    }
    asks.push(...more)
    const kept = asks.slice(0, Math.max(0, languageLookupLimits.requests - extra.length))
    this.cut = dropped || kept.length < asks.length
    // Each request gets its share of the answer's total, so a later one is not left with nothing.
    const share = Math.max(1, Math.min(languageLookupLimits.items, Math.floor((languageLookupLimits.totalItems - extra.reduce((sum, request) => sum + (request.limit ?? languageLookupLimits.defaultItems), 0)) / Math.max(1, kept.length))))
    const wanted: LanguageLookupPath[] = kept.map(ask => ({ path: ask.path, limit: share, ...ask.prefix !== undefined ? { prefix: ask.prefix } : {}, ...details ? { details } : {} }))
    const requests = [...extra, ...wanted]
    if (!requests.length) return []
    const answers = await this.lookup(requests)
    if (!answers) { this.failed = true; return [] }
    wanted.forEach((request, index) => {
      const answer = answers[extra.length + index]
      if (!answer) return
      const had = this.answers.get(key(request.path))
      this.answers.set(key(request.path), had ? merged(had, answer) : answer)
    })
    return answers.slice(0, extra.length)
  }

  cte(name: string): QueryShape | undefined { return this.ctes.get(name.toLowerCase()) }

  /** The objects (by the path asked) whose answer held fewer columns than the index has. */
  cutShort(): ReadonlySet<string> {
    return new Set([...this.answers].filter(([, answer]) => answer.truncated && answer.object).map(([path]) => path))
  }

  /** The prefix a field path written on `source` means on the object beneath it, and that object (its path's key) when known:
   *  through an UNNEST, the array's path first (i.alpha over UNNEST(w.zrec) is zrec.alpha; over UNNEST(zrec) not yet found, the
   *  same); through `*`, the same names. */
  async prefixThrough(source: ScopeSource, path: readonly string[], typed: string, depth = 0): Promise<{ prefix: string; object?: string }> {
    if (source.kind === 'unnest' && depth < resolverLimits.unnestHops) {
      const inner = await this.field(source.path, source)
      if (inner) return this.prefixThrough(inner.source, [...inner.path, ...path], typed, depth + 1)
      return { prefix: [...source.path, ...path, typed].join('.') }
    }
    const objectPath = source.kind === 'object' ? this.dialect.objectPath(source.parts) : undefined
    return { prefix: [...path, typed].join('.'), ...objectPath ? { object: key(objectPath) } : {} }
  }

  /** Every source's columns, read one after another: a source read while another is still being read would meet it in `reading`
   *  and get no columns (UNNEST(o.items) beside o). */
  async all(sources: readonly ScopeSource[]): Promise<SourceColumns[]> {
    const given: SourceColumns[] = []
    for (const source of sources) given.push(await this.columns(source))
    return given
  }

  /** A source's columns: the index's for an object, the select list's (with `*` expanded) for a WITH query or subquery. The grammar
   *  has already said which names are WITH queries (kind cte); an object is always the index's. */
  columns(source: ScopeSource, hops = 0): Promise<SourceColumns> {
    if (this.reading.has(source)) return Promise.resolve(unread)
    const kept = this.cache.get(source)
    if (serves(kept, hops)) return kept.found
    if (hops > resolverLimits.starHops) return Promise.resolve({ columns: [], truncated: true, budget: true })
    this.reading.add(source)
    const entry: Kept = { hops, found: Promise.resolve(unread) }
    entry.found = this.read(source, hops).then(given => {
      if (given !== unread) entry.budget = given.budget === true
      else if (this.cache.get(source) === entry) this.cache.delete(source)
      return given
    }).finally(() => this.reading.delete(source))
    this.cache.set(source, entry)
    return entry.found
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
        if (this.spent > resolverLimits.work) return { columns: [], truncated: true, budget: true }
        // UNNEST(hits) AS hits: the path names what the source reads, not the source itself.
        const field = await this.field(source.path, source)
        // Not found: it may lie past what a table cut short gave.
        if (!field) return { columns: [], truncated: this.overBudget || this.cutShort().size > 0 }
        this.spent += 1 + field.columns.columns.length
        const prefix = field.path.length
        return { truncated: field.columns.truncated, columns: childrenAndBelow(field.columns.columns, field.path).map(column => ({ ...column, path: column.path.split('.').slice(prefix).join('.') })) }
      }
    }
  }

  /** A select list's columns, read once however many sources name it; one met again while it is read gives none. */
  private shape(shape: QueryShape, hops: number): Promise<SourceColumns> {
    if (this.shaping.has(shape)) return Promise.resolve(unread)
    const kept = this.shapes.get(shape)
    if (serves(kept, hops)) return kept.found
    this.shaping.add(shape)
    const entry: Kept = { hops, found: Promise.resolve(unread) }
    entry.found = this.readShape(shape, hops).then(given => {
      entry.budget = given.budget === true
      return given
    }).finally(() => this.shaping.delete(shape))
    this.shapes.set(shape, entry)
    return entry.found
  }

  /** A select list's columns: its named ones, then every column its `*` sources give (their top level and below). */
  private async readShape(shape: QueryShape, hops: number): Promise<SourceColumns> {
    const columns: ScopeColumn[] = shape.columns.map(path => ({ path }))
    const known = new Set(columns.map(column => column.path.toLowerCase()))
    let truncated = false
    let budget = false
    this.spent++
    for (const star of shape.stars) {
      if (this.spent > resolverLimits.work) return { columns, truncated: true, budget: true }
      const given = await this.columns(star, hops + 1)
      this.spent += given.columns.length
      truncated ||= given.truncated
      budget ||= given.budget === true
      for (const column of given.columns) {
        const name = column.path.toLowerCase()
        if (known.has(name)) continue
        known.add(name)
        columns.push(column)
      }
    }
    return { columns, truncated, ...budget ? { budget: true as const } : {} }
  }

  /** What a written chain names, for member completion, UNNEST and hover: a source by its name then a field path in it, else a
   *  column (and fields) of a source in reach, nearest first. */
  async field(parts: readonly string[], except?: ScopeSource): Promise<{ source: ScopeSource; path: string[]; columns: SourceColumns } | undefined> {
    if (!parts.length) return
    if (!this.named) {
      this.named = new Map()
      for (const source of this.scope.sources) {
        if (source.name === undefined) continue
        const name = source.name.toLowerCase()
        const list = this.named.get(name)
        if (list) list.push(source)
        else this.named.set(name, [source])
      }
    }
    const named = this.named.get(parts[0].toLowerCase())?.find(source => source !== except)
    if (named) return { source: named, path: parts.slice(1), columns: await this.columns(named) }
    const seen = new Set<SourceColumns>()
    let looked = 0
    for (const source of this.scope.sources) {
      if (source === except) continue
      if (looked++ >= resolverLimits.fieldSources) break
      const columns = await this.columns(source)
      if (seen.has(columns)) continue
      seen.add(columns)
      // By its top-level name: a narrowed answer holds a STRUCT's fields (zrec.a) without the STRUCT itself.
      if (headsOf(columns).has(parts[0].toLowerCase())) return { source, path: [...parts], columns }
    }
  }
}

/** Every column at or below `parent`, excluding `parent` itself. */
function childrenAndBelow(columns: readonly ScopeColumn[], parent: readonly string[]): ScopeColumn[] {
  const prefix = parent.join('.').toLowerCase() + '.'
  return columns.filter(column => column.path.toLowerCase().startsWith(prefix))
}

const key = (path: readonly string[]) => JSON.stringify(path)
