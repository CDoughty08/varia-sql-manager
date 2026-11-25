import type { BigQueryStarredProjectsView } from '../../../shared/bigquery-connections'
import { bigQueryDatasetSchema, bigQueryProjectSchema } from '../../../shared/connections'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { scanGoogleSql, type GoogleSqlToken } from '../../../shared/googlesql/lexer'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

const emptyProjects: readonly string[] = []
/** Bounds for `referencedBigQueryProjects`: scan at most 256 KiB per query tab and extract at most 20 project IDs. */
export const bigQueryReferenceScanLimits = { maxChars: 256 * 1024, maxProjects: 20 } as const

export interface BigQueryStarredServiceOptions {
  readonly api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'>
}

function copyByPrincipal(source: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const copy: Record<string, string[]> = Object.create(null)
  for (const [principal, projects] of Object.entries(source)) copy[principal] = [...projects]
  return copy
}

/**
 * Per-principal BigQuery Starred Projects store (mirrors BigQuery Studio's explorer starring UX without altering
 * connection identity). Loads from main (`bigquery-connections.json`) and layers optimistic mutations cleanly on top
 * of the last authoritative snapshot so concurrent mutations never corrupt rollback state.
 */
export class BigQueryStarredService extends SnapshotStore<BigQueryStarredProjectsView> implements Disposable {
  private readonly api: BigQueryStarredServiceOptions['api']
  private disposed = false
  private _loaded = false
  private readonly loadedPrincipals = new Set<string>()
  private authoritative: Record<string, string[]> = Object.create(null)
  /** Monotonic dispatch sequence shared across `load()` and `setStarred()`, compared against `appliedSeq` so out-of-order responses never overwrite newer authoritative state. */
  private requestSeq = 0
  private appliedSeq = 0
  private latestLoadSeq = 0
  private readonly latestPrincipalLoadSeq = new Map<string, number>()
  private mutationSeq = 0
  private readonly pending = new Map<string, { readonly principal: string; readonly project: string; readonly starred: boolean; readonly seq: number }>()

  constructor(options: BigQueryStarredServiceOptions) {
    super({ byPrincipal: Object.create(null) })
    this.api = options.api
  }

  /** Whether a global load from main has settled. */
  get loaded(): boolean { return this._loaded }

  /** Whether starred projects for `principalId` have settled (used to hold per-connection Explorer tree restore until that principal's stars arrive). */
  isLoadedFor(principalId: string | undefined): boolean {
    if (!principalId || principalId.startsWith('bigquery:anonymous:')) return true
    return this._loaded || this.loadedPrincipals.has(principalId)
  }

  private compose(): BigQueryStarredProjectsView {
    const byPrincipal = copyByPrincipal(this.authoritative)
    const ordered = [...this.pending.values()].sort((a, b) => a.seq - b.seq)
    for (const op of ordered) {
      const current = byPrincipal[op.principal] ?? []
      if (op.starred) {
        if (!current.includes(op.project)) byPrincipal[op.principal] = [...current, op.project]
      } else {
        const next = current.filter(item => item !== op.project)
        if (next.length) byPrincipal[op.principal] = next
        else delete byPrincipal[op.principal]
      }
    }
    return { byPrincipal }
  }

  /**
   * Loads starred projects from main, updating the authoritative base while preserving any in-flight optimistic edits.
   * When `connectionId` is given, main resolves its verified principal and returns only that principal's stars, which are
   * merged into `authoritative` without disturbing other live principals.
   */
  async load(connectionId?: string, principalId?: string): Promise<void> {
    if (this.disposed) return
    const seq = ++this.requestSeq
    if (principalId) this.latestPrincipalLoadSeq.set(principalId, seq)
    else this.latestLoadSeq = seq
    let result: ApiResult<BigQueryStarredProjectsView> | undefined
    try {
      result = await this.api.loadBigQueryStarredProjects(connectionId ? { connectionId } : undefined)
    } catch {
      result = undefined
    }
    if (this.disposed) return
    let becameLoaded = false
    if (principalId) {
      if (!this.loadedPrincipals.has(principalId) && seq === this.latestPrincipalLoadSeq.get(principalId)) {
        this.loadedPrincipals.add(principalId)
        becameLoaded = true
      }
    } else if (!this._loaded && seq === this.latestLoadSeq) {
      this._loaded = true
      becameLoaded = true
    }
    if (result?.ok && seq > this.appliedSeq) {
      this.appliedSeq = seq
      if (connectionId && principalId) {
        const incoming = result.value.byPrincipal
        if (Object.hasOwn(incoming, principalId) && incoming[principalId]!.length) {
          this.authoritative[principalId] = [...incoming[principalId]!]
        } else {
          delete this.authoritative[principalId]
        }
        for (const [principal, projects] of Object.entries(incoming)) {
          this.authoritative[principal] = [...projects]
          const latest = this.latestPrincipalLoadSeq.get(principal)
          if (latest === undefined || seq >= latest) this.loadedPrincipals.add(principal)
        }
      } else {
        this.authoritative = copyByPrincipal(result.value.byPrincipal)
        for (const principal of Object.keys(result.value.byPrincipal)) {
          const latest = this.latestPrincipalLoadSeq.get(principal)
          if (latest === undefined || seq >= latest) this.loadedPrincipals.add(principal)
        }
      }
      this.publish(this.compose())
      return
    }
    // Always notify subscribers when `loaded` transitions to true (even on error/stale load) so deferred Explorer restores release.
    if (becameLoaded) this.publish(this.compose())
  }

  /** Starred project IDs for `principalId`, in saved order. */
  starredFor(principalId: string | undefined): readonly string[] {
    if (!principalId) return emptyProjects
    const byPrincipal = this.getSnapshot().byPrincipal
    return Object.hasOwn(byPrincipal, principalId) ? byPrincipal[principalId]! : emptyProjects
  }

  /** Whether `project` is starred for `principalId` (including optimistic in-flight mutations). */
  isStarred(principalId: string | undefined, project: string): boolean {
    if (!principalId) return false
    const byPrincipal = this.getSnapshot().byPrincipal
    return Object.hasOwn(byPrincipal, principalId) ? byPrincipal[principalId]!.includes(project) : false
  }

  /** Whether `project` is confirmed persisted as starred in main for `principalId` (never true while a star write is only optimistic). */
  isConfirmedStarred(principalId: string | undefined, project: string): boolean {
    if (!principalId) return false
    return Object.hasOwn(this.authoritative, principalId) ? this.authoritative[principalId]!.includes(project) : false
  }

  /** Optimistically updates starred state for `principalId` and persists through main bound to the verified live `connectionId`. */
  async setStarred(connectionId: string, principalId: string, project: string, starred: boolean): Promise<ApiResult<BigQueryStarredProjectsView>> {
    if (this.disposed) return { ok: false, error: 'Service is disposed.' }
    const key = `${principalId}\u0000${project}`
    const seq = ++this.requestSeq
    const opSeq = ++this.mutationSeq
    this.pending.set(key, { principal: principalId, project, starred, seq: opSeq })
    this.publish(this.compose())
    let result: ApiResult<BigQueryStarredProjectsView>
    try {
      result = await this.api.setBigQueryProjectStar({ connectionId, project, starred })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'Could not update starred projects.' }
    }
    if (this.disposed) return result
    if (this.pending.get(key)?.seq === opSeq) this.pending.delete(key)
    if (result.ok && seq > this.appliedSeq) {
      this.appliedSeq = seq
      this.authoritative = copyByPrincipal(result.value.byPrincipal)
      for (const principal of Object.keys(result.value.byPrincipal)) this.loadedPrincipals.add(principal)
    }
    this.publish(this.compose())
    return result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending.clear()
    this.loadedPrincipals.clear()
    this.latestPrincipalLoadSeq.clear()
    this.clearListeners()
  }
}

interface ScanTok extends GoogleSqlToken { readonly text: string; readonly upper: string }

/** Keywords immediately preceding a BigQuery table, view, routine or model reference. */
const objectLeadWords = new Set(['FROM', 'JOIN', 'INTO', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'MODEL', 'CALL', 'CLONE', 'COPY', 'EXISTS'])
/** Keywords that end a FROM clause's comma-separated table list (ON, USING, PIVOT and UNPIVOT stay inside FROM; non-reserved OPTIONS requires `(`). */
const fromEndWords = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'SET', 'SELECT', 'WHEN', 'UNION', 'INTERSECT', 'EXCEPT'])
/** Optional modifiers between CREATE and TABLE in GoogleSQL DDL. */
const createTableModifiers = new Set(['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'EXTERNAL', 'SNAPSHOT'])
/** Keywords that end a CREATE TABLE header before any subsequent query clauses (non-reserved OPTIONS requires `(` and CLUSTER requires `BY`). */
const createTableEndWords = new Set(['AS', 'SELECT', 'WHERE', 'PARTITION'])

/** Keywords that cannot be an implicit (no-AS) table alias in a FROM clause. */
const aliasStopWords = new Set([
  'ON', 'USING', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER', 'NATURAL', 'GROUP', 'HAVING',
  'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE', 'FOR',
  'WITH', 'SET', 'WHEN', 'VALUES', 'SELECT', 'FROM', 'INTO', 'OPTIONS', 'AND', 'OR', 'OFFSET'
])

/** Unquotes a single backticked alias token or returns a plain word token's text. */
function aliasName(token: ScanTok | undefined): string | undefined {
  if (!token) return undefined
  if (token.kind === 'quotedIdentifier') return token.open ? undefined : token.text.slice(1, -1).replace(/\\(.)/g, '$1')
  if (token.kind === 'word') return token.text
  return undefined
}

/** Splits a backtick-quoted identifier into dotted parts while keeping domain-scoped projects (`example.com:proj`) intact. */
function splitQuotedParts(token: ScanTok): string[] {
  if (token.open) return []
  const body = token.text.slice(1, -1).replace(/\\(.)/g, '$1')
  if (!body) return []
  const colon = body.indexOf(':')
  if (colon >= 0) {
    const firstDot = body.indexOf('.', colon + 1)
    if (firstDot < 0) return [body]
    return [body.slice(0, firstDot), ...body.slice(firstDot + 1).split('.')]
  }
  return body.split('.')
}

const isNameTok = (token: ScanTok | undefined): token is ScanTok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier')
const isNameOrNumTok = (token: ScanTok | undefined): token is ScanTok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier' || token.kind === 'number')
const isPunct = (token: ScanTok | undefined, value: string) => !!token && token.kind === 'punctuation' && token.text === value

/**
 * Pure, bounded scanner that extracts valid BigQuery project IDs explicitly referenced in 3-part object paths
 * (`project.dataset.table`, `` `project.dataset.table` ``, `` `project`.dataset.table ``, `INFORMATION_SCHEMA` paths,
 * or 3-part routine calls including `SAFE.project.dataset.fn(...)`) from GoogleSQL text, skipping comments and string literals.
 */
export function referencedBigQueryProjects(sql: string): string[] {
  if (!sql) return []
  const text = sql.length > bigQueryReferenceScanLimits.maxChars ? sql.slice(0, bigQueryReferenceScanLimits.maxChars) : sql
  const scanned = scanGoogleSql(text)
  // Split dotted number tokens adjacent to names or dashes (`my-proj-2.sales`, `my-proj.2026_sales`, `my-proj-1.2026_sales`).
  const dashedPiece = (index: number) => scanned[index - 1]?.kind === 'punctuation' && text[scanned[index - 1].start] === '-' && scanned[index - 1].end === scanned[index].start
  const touchesPrevName = (index: number) => {
    const before = scanned[index - 1]
    return !!before && before.end === scanned[index].start && (before.kind === 'word' || before.kind === 'quotedIdentifier' || before.kind === 'number')
  }
  const touchesNextName = (index: number) => {
    const after = scanned[index + 1]
    return !!after && scanned[index].end === after.start && (after.kind === 'word' || after.kind === 'quotedIdentifier')
  }
  const toks: ScanTok[] = []
  for (let index = 0; index < scanned.length; index++) {
    const token = scanned[index]
    if (token.kind === 'whitespace' || token.kind === 'comment' || token.kind === 'string') continue
    const raw = text.slice(token.start, token.end)
    if (token.kind === 'number' && raw.includes('.') && (touchesPrevName(index) || touchesNextName(index) || dashedPiece(index))) {
      const dot = raw.indexOf('.')
      if (dot > 0) toks.push({ kind: 'number', start: token.start, end: token.start + dot, text: raw.slice(0, dot), upper: '' })
      toks.push({ kind: 'punctuation', start: token.start + dot, end: token.start + dot + 1, text: '.', upper: '' })
      if (dot + 1 < raw.length) toks.push({ kind: 'number', start: token.start + dot + 1, end: token.end, text: raw.slice(dot + 1), upper: '' })
      continue
    }
    toks.push({ ...token, text: raw, upper: token.kind === 'word' ? raw.toUpperCase() : '' })
  }

  const projects: string[] = []
  const record = (parts: readonly string[]) => {
    if (parts.length < 3) return
    const [project, dataset, third] = parts
    if (!project || !dataset || !third) return
    // BigQuery reserves INFORMATION_SCHEMA; 2-part billing-project queries (`region-us.INFORMATION_SCHEMA.JOBS`, `analytics.INFORMATION_SCHEMA.TABLES`) have no project prefix.
    if (dataset.toUpperCase() === 'INFORMATION_SCHEMA') return
    const isInfoSchema = third.toUpperCase() === 'INFORMATION_SCHEMA' && (bigQueryDatasetSchema.safeParse(dataset).success || /^region-[a-z0-9-]+$/i.test(dataset))
    if (!isInfoSchema && !bigQueryDatasetSchema.safeParse(dataset).success) return
    if (!bigQueryProjectSchema.safeParse(project).success) return
    if (!projects.includes(project)) projects.push(project)
  }

  let inFrom = false
  let inMerge = false
  let createHeader: 'none' | 'create' | 'table' = 'none'
  // Per-delimiter-depth stack for `inFrom`, earlier FROM aliases (to exclude implicit UNNEST like `FROM t AS orders, orders.payload.items`),
  // and whether `(` belongs to EXTRACT(...), so `FROM UNNEST(a) x, proj.ds.tbl`, `FROM (SELECT 1) a, proj.ds.tbl`, and array literals work cleanly.
  const fromStack: boolean[] = []
  const fromAliasStack: Set<string>[] = []
  const parenExtract: boolean[] = []
  let fromAliases = new Set<string>()

  /** Records an explicit `[AS] alias` immediately following a FROM item (or `defaultName` when none is given). */
  const recordFromAlias = (after: number, defaultName?: string) => {
    const next = toks[after]
    if (next?.kind === 'word' && next.upper === 'AS') {
      const explicit = aliasName(toks[after + 1])
      if (explicit) { fromAliases.add(explicit.toLowerCase()); return }
    } else if (next && isNameTok(next) && !(next.kind === 'word' && aliasStopWords.has(next.upper))) {
      const explicit = aliasName(next)
      if (explicit) { fromAliases.add(explicit.toLowerCase()); return }
    }
    if (defaultName) fromAliases.add(defaultName.toLowerCase())
  }

  for (let index = 0; index < toks.length && projects.length < bigQueryReferenceScanLimits.maxProjects; index++) {
    const token = toks[index]
    const prev = toks[index - 1]

    if (isPunct(token, '(') || isPunct(token, '[')) {
      fromStack.push(inFrom)
      fromAliasStack.push(fromAliases)
      parenExtract.push(isPunct(token, '(') && prev?.kind === 'word' && prev.upper === 'EXTRACT')
      inFrom = false
      fromAliases = new Set<string>()
      continue
    }
    if (isPunct(token, ')') || isPunct(token, ']')) {
      parenExtract.pop()
      inFrom = fromStack.pop() ?? false
      fromAliases = fromAliasStack.pop() ?? new Set<string>()
      if (inFrom && isPunct(token, ')')) recordFromAlias(index + 1)
      continue
    }
    if (isPunct(token, ';')) {
      inFrom = false
      inMerge = false
      createHeader = 'none'
      fromStack.length = 0
      fromAliasStack.length = 0
      parenExtract.length = 0
      fromAliases = new Set<string>()
      continue
    }
    if (isPunct(token, '|') && isPunct(toks[index + 1], '>')) {
      inFrom = false
      fromAliases = new Set<string>()
      index++
      continue
    }

    const startsPath = isPunct(toks[index + 1], '.')
      || (isPunct(toks[index + 1], '-') && toks[index + 1].start === token.end
        && (toks[index + 2]?.kind === 'word' || toks[index + 2]?.kind === 'number')
        && toks[index + 2].start === toks[index + 1].end)
    if (token.kind === 'word' && !startsPath && !isPunct(prev, '.')) {
      const nextTok = toks[index + 1]
      const parenClause = isPunct(nextTok, '(')
      const byClause = nextTok?.kind === 'word' && nextTok.upper === 'BY'
      if (fromStack.length === 0) {
        if (token.upper === 'CREATE') createHeader = 'create'
        else if (createHeader === 'create') createHeader = token.upper === 'TABLE' ? 'table' : createTableModifiers.has(token.upper) ? 'create' : 'none'
        else if (createHeader === 'table' && (createTableEndWords.has(token.upper) || (token.upper === 'OPTIONS' && parenClause) || (token.upper === 'CLUSTER' && byClause))) createHeader = 'none'
        if (token.upper === 'MERGE') inMerge = true
        else if (token.upper === 'WHEN') inMerge = false
      }
      if (token.upper === 'FROM' && !parenExtract.at(-1) && !(prev?.kind === 'word' && prev.upper === 'DISTINCT')) { inFrom = true; fromAliases = new Set<string>(); continue }
      if (token.upper === 'JOIN') { inFrom = true; continue }
      if (fromEndWords.has(token.upper) || (token.upper === 'OPTIONS' && parenClause)) { inFrom = false; fromAliases = new Set<string>(); continue }
    }

    if (!isNameTok(token)) continue
    // Do not start mid-chain after a dot (already consumed as part of the preceding chain).
    if (isPunct(prev, '.')) continue

    const isDistinctFrom = prev?.kind === 'word' && prev.upper === 'FROM' && toks[index - 2]?.kind === 'word' && toks[index - 2].upper === 'DISTINCT'
    const isCreateTableLike = createHeader === 'table' && fromStack.length === 0 && prev?.kind === 'word' && prev.upper === 'LIKE'
    const isMergeUsing = inMerge && fromStack.length === 0 && prev?.kind === 'word' && prev.upper === 'USING'
    const isCommaFrom = inFrom && isPunct(prev, ',')
    const isObjectPos = (prev?.kind === 'word' && objectLeadWords.has(prev.upper) && !(prev.upper === 'FROM' && parenExtract.at(-1)) && !isDistinctFrom)
      || isCreateTableLike
      || isMergeUsing
      || isCommaFrom
    if (isCreateTableLike) createHeader = 'none'
    if (isMergeUsing) inMerge = false

    // Read a possibly dashed segment (`my-proj-2`, `region-us`), digit-leading segment (`2026_sales`), or backtick-quoted token.
    const readSegment = (at: number): { parts: string[]; next: number; singleMultiPart: boolean } => {
      const current = toks[at]
      if (current.kind === 'quotedIdentifier') {
        const quoted = splitQuotedParts(current)
        return { parts: quoted, next: at + 1, singleMultiPart: quoted.length >= 3 }
      }
      let textPart = current.text, end = current.end, next = at + 1
      // Glue adjacent number + word (`2026` + `_sales`) for digit-leading BigQuery datasets/tables.
      while (toks[next] && toks[next].start === end && (toks[next].kind === 'word' || toks[next].kind === 'number')) {
        textPart += toks[next].text
        end = toks[next].end
        next++
      }
      while (isPunct(toks[next], '-') && toks[next].start === end
        && (toks[next + 1]?.kind === 'word' || toks[next + 1]?.kind === 'number')
        && toks[next + 1].start === toks[next].end) {
        textPart += '-' + toks[next + 1].text
        end = toks[next + 1].end
        next += 2
        while (toks[next] && toks[next].start === end && (toks[next].kind === 'word' || toks[next].kind === 'number')) {
          textPart += toks[next].text
          end = toks[next].end
          next++
        }
      }
      return { parts: [textPart], next, singleMultiPart: false }
    }

    const first = readSegment(index)
    const parts: string[] = [...first.parts]
    const singleBacktickMultiPart = first.singleMultiPart
    let cursor = first.next

    while (isPunct(toks[cursor], '.') && isNameOrNumTok(toks[cursor + 1])) {
      const seg = readSegment(cursor + 1)
      parts.push(...seg.parts)
      cursor = seg.next
    }

    const followedByCall = isPunct(toks[cursor], '(')
    // `FROM orders AS o, o.payload.items AS item`: a comma-FROM path starting with an earlier FROM alias is an implicit UNNEST, not a project.
    const isImplicitUnnest = isCommaFrom && !singleBacktickMultiPart && parts.length >= 2 && fromAliases.has(parts[0].toLowerCase())
    if (inFrom && isObjectPos && !followedByCall) recordFromAlias(cursor, parts.at(-1))
    if (followedByCall && parts.length >= 4 && parts[0].toUpperCase() === 'SAFE') {
      record(parts.slice(1))
    } else if (parts.length >= 3 && !isImplicitUnnest && (singleBacktickMultiPart || isObjectPos || followedByCall)) {
      record(parts)
    }
    index = cursor - 1
  }

  return projects
}

export interface BigQuerySyncModel {
  getValue(): string
  getAlternativeVersionId?(): number
  onDidChangeContent?(listener: () => void): { dispose(): void }
}

export interface BigQuerySyncDocument {
  readonly id: string
  readonly kind?: string
  readonly connectionId?: string | null
}

export interface BigQuerySyncConnection {
  readonly id: string
  readonly principalId?: string
  readonly authentication?: { readonly principal: { readonly provider: string; readonly principal?: string } }
}

export interface BigQueryExplorerSyncDeps {
  readonly connections: {
    liveBigQuery(): readonly BigQuerySyncConnection[]
    isLiveBigQuery(id: string): boolean
    subscribe(listener: () => void): () => void
  }
  readonly documents: {
    getSnapshot(): { readonly documents: readonly BigQuerySyncDocument[] }
    get(id: string): BigQuerySyncDocument | undefined
    getModel(id: string): BigQuerySyncModel | undefined
    subscribe(listener: () => void): () => void
  }
  readonly events: {
    subscribe(listener: (event: { readonly type: string; readonly tabId?: string }) => void): { dispose(): void }
  }
  readonly explorer: {
    syncBigQueryReferencedProjects(connectionId: string, projects: readonly string[]): void
  }
  readonly loadStarred: (connectionId: string, principalId: string) => void
  readonly debounceMs?: number
}

/**
 * Keeps Object Explorer's BigQuery session projects and per-connection Starred Projects synchronized with live
 * connections and open query tabs — scanning on open/connect, debounced content edits, and query execution.
 */
export function bindBigQueryExplorerSync(deps: BigQueryExplorerSyncDeps): { sync(): void; dispose(): void } {
  const debounceMs = deps.debounceMs ?? 400
  const seenConnections = new Set<string>()
  const watchers = new Map<string, { connectionId: string; version: number; timer?: ReturnType<typeof setTimeout>; disposable: { dispose(): void } }>()
  let disposed = false

  const stopWatcher = (docId: string) => {
    const existing = watchers.get(docId)
    if (!existing) return
    if (existing.timer !== undefined) clearTimeout(existing.timer)
    existing.disposable.dispose()
    watchers.delete(docId)
  }

  const scanTab = (docId: string, connectionId: string, force = false) => {
    const model = deps.documents.getModel(docId)
    if (!model) return
    const watcher = watchers.get(docId)
    const version = typeof model.getAlternativeVersionId === 'function' ? model.getAlternativeVersionId() : -1
    if (!force && version >= 0 && watcher && watcher.connectionId === connectionId && watcher.version === version) return
    if (watcher && watcher.connectionId === connectionId) watcher.version = version
    const text = model.getValue()
    if (!text) return
    const referenced = referencedBigQueryProjects(text)
    if (referenced.length) deps.explorer.syncBigQueryReferencedProjects(connectionId, referenced)
  }

  const sync = () => {
    if (disposed) return
    const liveBqIds = new Set<string>()
    for (const connection of deps.connections.liveBigQuery()) {
      liveBqIds.add(connection.id)
      const principal = connection.authentication?.principal.provider === 'bigquery' ? connection.authentication.principal.principal : connection.principalId
      if (principal?.startsWith('bigquery:') && !principal.startsWith('bigquery:anonymous:') && !seenConnections.has(connection.id)) {
        seenConnections.add(connection.id)
        deps.loadStarred(connection.id, principal)
      }
    }
    for (const id of [...seenConnections]) if (!liveBqIds.has(id)) seenConnections.delete(id)

    const activeTabIds = new Set<string>()
    for (const doc of deps.documents.getSnapshot().documents) {
      const connectionId = doc.connectionId
      if ((doc.kind !== undefined && doc.kind !== 'sql') || !connectionId || !deps.connections.isLiveBigQuery(connectionId)) continue
      activeTabIds.add(doc.id)
      const existing = watchers.get(doc.id)
      if (existing?.connectionId === connectionId) continue
      stopWatcher(doc.id)
      const model = deps.documents.getModel(doc.id)
      if (!model) continue
      const entry: { connectionId: string; version: number; timer?: ReturnType<typeof setTimeout>; disposable: { dispose(): void } } = {
        connectionId,
        version: -1,
        disposable: typeof model.onDidChangeContent === 'function'
          ? model.onDidChangeContent(() => {
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            entry.timer = setTimeout(() => {
              entry.timer = undefined
              if (!disposed && deps.connections.isLiveBigQuery(connectionId)) scanTab(doc.id, connectionId)
            }, debounceMs)
          })
          : { dispose: () => {} }
      }
      watchers.set(doc.id, entry)
      scanTab(doc.id, connectionId, true)
    }
    for (const id of [...watchers.keys()]) if (!activeTabIds.has(id)) stopWatcher(id)
  }

  const offConnections = deps.connections.subscribe(sync)
  const offDocuments = deps.documents.subscribe(sync)
  const offEvents = deps.events.subscribe(event => {
    if (event.type !== 'query.started' || !event.tabId) return
    const doc = deps.documents.get(event.tabId)
    if (doc && (doc.kind === undefined || doc.kind === 'sql') && doc.connectionId && deps.connections.isLiveBigQuery(doc.connectionId)) scanTab(doc.id, doc.connectionId, true)
  })

  return {
    sync,
    dispose() {
      if (disposed) return
      disposed = true
      offConnections()
      offDocuments()
      offEvents.dispose()
      for (const id of [...watchers.keys()]) stopWatcher(id)
      seenConnections.clear()
    }
  }
}
