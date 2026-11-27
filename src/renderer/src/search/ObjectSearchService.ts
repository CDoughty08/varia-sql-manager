import type { VariaApi } from '../../../shared/contracts'
import { belowSchema, folderSpecs, kindSpecs, type FolderId } from '../../../shared/explorer/catalog.ts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import type { BigQueryDryRunResult } from '../../../shared/bigquery/dry-run.ts'
import { objectSearchLimits, type BigQueryBulkIndex, type BigQueryIndexScope, type ObjectIndexProgress, type ObjectIndexSkip, type ObjectIndexStatus, type ObjectSearchHit, type ObjectSearchResult, type SearchScope, type SearchType, providerSearchKinds, searchTypeKinds } from '../../../shared/explorer/search.ts'
import type { WorkbenchEvent } from '../core/types'
import type { SettingKey, SettingValue } from '../../../shared/settings/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { ConnectionService, LiveConnection } from '../services/connections'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { RevealPath, SeekOutcome } from '../explorer/ExplorerService'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { clampPaneBand } from './pane-band'

/** One connection's index as the page knows it: a build running (with its progress) or the last build's status. */
export interface IndexEntry {
  readonly connectionId: string
  /** The running build's request. */
  readonly requestId?: string
  readonly done: number
  readonly total: number
  readonly objects: number
  /** A BigQuery build's pass: projects (discovering accessible projects), names, then details; `estimate` while the billed bulk path's estimate and cost prompts come first. */
  readonly phase?: 'estimate' | 'projects' | 'names' | 'details'
  /** BigQuery names pass: the total can still grow while projects are being listed. */
  readonly growing?: true
  /** BigQuery: its rate limit is refusing calls, which retry. */
  readonly throttled?: true
  /** BigQuery, while building: when the oldest dataset loaded from the saved index that the build has not checked yet was read. */
  readonly savedAt?: string
  readonly status?: ObjectIndexStatus
  readonly error?: string
}
/** What a Search Objects tab asks and shows. */
export interface SearchQueryState {
  readonly text: string
  readonly caseSensitive: boolean
  readonly wholeWord: boolean
  readonly regex: boolean
  /** Fuzzy Match: names also match approximately (typos, sound-alikes); off in effect while Regex is on. */
  readonly fuzzy: boolean
  readonly scope: SearchScope
  /** The type filters chosen (searchTypes); none searches every kind. */
  readonly types: readonly SearchType[]
  /** A database-menu search is scoped until its chip is cleared or its server changes. */
  readonly database?: string
  /** A BigQuery project- or dataset-menu search is scoped until its chip is cleared or its server changes. */
  readonly project?: string
  readonly dataset?: string
  /** The most hits each server answers, when fewer than the backend's default will do. */
  readonly limit?: number
}
/** A scope passed to `open`: a SQL Server database name (string for backwards compatibility), or an object naming one engine's scope. */
export type SearchScopeTarget = string | { readonly database?: string; readonly project?: string; readonly dataset?: string }
/** One server's part of an All servers search: its answer, or why it has none. */
export interface ServerAnswer {
  readonly connectionId: string
  /** The server's name as it was searched, so a server that leaves can still be named. */
  readonly label: string
  readonly result?: ObjectSearchResult
  readonly error?: string
  /** Its answer to the search is still on its way: `result`, if any, is its answer to the same query before (a build's end or a
   *  server joining asks it again), kept so the list and the selection stay put until the new one lands. */
  readonly pending?: boolean
}
export interface SearchDocumentState extends SearchQueryState {
  readonly id: string
  /** The server searched; with `allServers`, the one the tab opened on (searches go to every connected server). */
  readonly connectionId: string
  /** The search on its way (with `allServers`, the whole fan-out's). */
  readonly requestId?: string
  /** All servers: the search runs on every connected server, each with its own index, and its hits are grouped by server. */
  readonly allServers?: boolean
  /** All servers: the search on its way whose landings `servers` shows. Until `requestId`'s first landing they differ, and
   *  `servers` and `result` are still the search before's, kept in view. */
  readonly landed?: string
  /** All servers: each server's answer, in Object Explorer's order; `result` merges them, so a hit's index runs across groups. */
  readonly servers?: readonly ServerAnswer[]
  /** All servers: the servers the last search had that have since disconnected, by name. */
  readonly left?: readonly string[]
  /** All servers: the groups collapsed in the list, by connection. */
  readonly collapsed?: readonly string[]
  /** The answer to the last search, and what it asked. */
  readonly result?: ObjectSearchResult
  readonly asked?: SearchQueryState
  readonly error?: string
  /** The selected hit, by index in the result: the one Enter in the box revealed last, or the list's selection. A new result
   *  forgets it, unless it answers the same query again (the build's end runs it again, or the user searches it again) and the
   *  hit is still there. */
  readonly current?: number
}
export interface ObjectSearchSnapshot {
  readonly indexes: Readonly<Record<string, IndexEntry>>
  /** Each Search Objects tab's search, by document id, and Object Explorer's box's under `explorerSearchId`. */
  readonly documents: Readonly<Record<string, SearchDocumentState>>
  /** Changes when Search in Object Explorer asks the box to take focus. */
  readonly paneFocus: number
  /** Object Explorer's search band's share of the pane, once its splitter was moved (pane-band.ts); until then it sizes by content. */
  readonly paneSize?: number
}
/** Object Explorer as Reveal uses it: its seek, whether it groups objects by schema (the paths differ), and ensuring a BigQuery session project before seeking. */
export interface RevealHost {
  seek(connectionId: string, paths: readonly RevealPath[]): Promise<SeekOutcome>
  ensureBigQueryProject?(connectionId: string, project: string): boolean | void
  readonly groupBySchema?: boolean
}
export interface ObjectSearchOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'explorerIndex' | 'explorerSearch' | 'explorerCancel' | 'onExplorerIndexProgress'> & Partial<Pick<VariaApi, 'bigQueryIndexEstimate' | 'explorerIndexStatus'>>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot'> & Partial<Pick<DocumentService, 'update' | 'subscribe'>>
  readonly connections: Pick<ConnectionService, 'getSnapshot' | 'subscribe' | 'get'>
  readonly settings: { get<K extends SettingKey>(key: K): SettingValue<K> }
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
  /** The workbench's events: a BigQuery query's result names the newest stale mark its connection's index holds (`indexStale`), and a
   *  new one re-reads the datasets DDL marked (`stale`). */
  readonly events?: { subscribe(listener: (event: WorkbenchEvent) => void): Disposable }
  /** BigQuery's cost prompts before a full build's billed bulk path runs (BigQueryCostService.beforeScript); without it the bulk path never runs. */
  readonly billedGate?: (connectionId: string, estimate: BigQueryDryRunResult, signal: AbortSignal) => Promise<{ readonly run: boolean; readonly maximumBytesBilled?: number }>
  /** Per-connection BigQuery starred projects to include in Search Objects index builds and bulk estimates. */
  readonly starredProjects?: (connectionId: string) => readonly string[]
}
/** A BigQuery refresh: one project or dataset re-read whole (Object Explorer's Refresh), or only if missing/unindexed, the datasets DDL marked, or everything
 *  (Refresh on the server's node). */
export type BigQueryRefresh = { readonly scope: BigQueryIndexScope; readonly missingOnly?: true } | { readonly stale: true } | { readonly full: true }

/** Whether any reported skip covers `scope` (a project-level failure, any dataset failure in a project scope, or the matching dataset). */
function scopeHasSkip(skipped: readonly ObjectIndexSkip[], scope: BigQueryIndexScope): boolean {
  return skipped.some(skip => skip.project === scope.project && (skip.database === '' || scope.dataset === undefined || skip.database === scope.dataset))
}

export const searchTitle = 'Search Objects'
/** The search Object Explorer's box runs: the same search as a tab's, on the server of the explorer's selection. */
export const explorerSearchId = 'explorer'
/** The header's Search (Ctrl+Q): the same search again, by name on every connected server, while its widget is open with text. */
export const quickSearchId = 'quick'
/** The hits each server answers the header's Search: the rest are a Search Objects tab away. */
export const quickSearchHits = 50
/** A list's selected hit: its search, the search's server, and the hit's index in the result. */
export interface FocusedHit { readonly searchId: string; readonly connectionId: string; readonly index: number; readonly hit: ObjectSearchHit }

/** The folders from the owner down to `folder`, outermost first (Programmability › Functions › Scalar-valued Functions). */
function folderChain(owner: ObjectRef, folder: FolderId): ExplorerNodeRef[] {
  const chain: ExplorerNodeRef[] = []
  for (let at: FolderId | undefined = folder; at; at = folderSpecs[at].parent) chain.unshift({ type: 'folder', owner, folder: at })
  return chain
}
/** A server singleton's node (SQL Server Agent) and its folder chain, for a folder that singleton owns; the server's folder
 *  chain otherwise. */
function serverChain(folder: FolderId): ExplorerNodeRef[] {
  let top = folder
  while (folderSpecs[top].parent) top = folderSpecs[top].parent!
  const singleton = (kindSpecs.server.singletons ?? []).find(item => kindSpecs[item.kind].folders?.includes(top))
  if (!singleton) return folderChain({ kind: 'server' }, folder)
  const owner: ObjectRef = { kind: singleton.kind }
  return [{ type: 'object', object: owner }, ...folderChain(owner, folder)]
}
/**
 * Where a BigQuery hit is in Object Explorer: its project (listed below the server), its dataset, the dataset's folder, and the
 * object; a column below its table's (the folder the hit names its parent's), the table's Columns folder, and each record column
 * above it (address, then address.city).
 */
function bigQueryRevealPaths(hit: ObjectSearchHit): RevealPath[] {
  const object = hit.object, project = object.project!
  const steps: ExplorerNodeRef[] = [{ type: 'object', object: { kind: 'bqProject', name: project } }]
  if (object.kind === 'bqDataset' || object.dataset === undefined) return [[...steps, { type: 'object', object }]]
  const dataset: ObjectRef = { kind: 'bqDataset', project, name: object.dataset }
  steps.push({ type: 'object', object: dataset })
  if (object.kind !== 'bqColumn' || object.table === undefined) return hit.folder ? [[...steps, ...folderChain(dataset, hit.folder), { type: 'object', object }]] : []
  const parentFolder = hit.parentFolder
  const tableKind = parentFolder ? folderSpecs[parentFolder].rows?.[0] : undefined
  if (!parentFolder || !tableKind || !hit.folder) return []
  const table: ObjectRef = { kind: tableKind, project, dataset: object.dataset, name: object.table }
  const parts = (object.name ?? '').split('.'), records: ExplorerNodeRef[] = []
  for (let at = 1; at < parts.length; at++) records.push({ type: 'object', object: { kind: 'bqColumn', project, dataset: object.dataset, table: object.table, name: parts.slice(0, at).join('.') } })
  return [[...steps, ...folderChain(dataset, parentFolder), { type: 'object', object: table }, ...folderChain(table, hit.folder), ...records, { type: 'object', object }]]
}
/** Reveal's answer for a hit whose kind this build does not know. */
export const unknownKindReveal = 'This version of Varia cannot show that kind of object in Object Explorer.'
const systemDatabases = new Set(['master', 'model', 'msdb'])
/** Where a child's parent may be listed when the hit does not say: under its kind's folder, then the System one. */
const parentFolders: { readonly [K in 'table' | 'view' | 'tableType' | 'procedure' | 'function']: readonly FolderId[] } = {
  table: ['tables', 'systemTables'], view: ['views', 'systemViews'], tableType: ['userDefinedTableTypes'],
  procedure: ['storedProcedures', 'systemStoredProcedures'], function: ['tableValuedFunctions', 'scalarValuedFunctions', 'aggregateFunctions', 'functions']
}
/**
 * Where a hit is in Object Explorer, from the server down. A server object is in its folder below the server (Security ›
 * Logins), or below the server singleton that owns the folder (SQL Server Agent › Jobs), and a database in its Databases folder. Anything else is in its database, under Databases (or System Databases,
 * tried first for master, model and msdb, and second for the rest: a distribution database is a system one too): the folders
 * above its listing, a child's parent in the folder the hit names (or, when it names none, under its kind's folders, then
 * their System ones), and the object. A temporal or ledger history table (or a child of one) is below the table whose history
 * row shows it. With Group by Schema on (`grouped`), a schema-scoped listing hangs below its schema's row (the object's, its
 * parent's or its history table's schema) rather than below the database.
 */
export function revealPaths(hit: ObjectSearchHit, grouped = false): RevealPath[] {
  const server: ObjectRef = { kind: 'server' }
  // A kind this build does not know (a newer backend's) has no place in this build's tree.
  if (!Object.hasOwn(kindSpecs, hit.object.kind)) return []
  if (hit.object.project !== undefined) return bigQueryRevealPaths(hit)
  // Only a BigQuery dataset is listed in no folder.
  if (!hit.folder) return []
  const folder = hit.folder
  const scope = kindSpecs[hit.object.kind].scope
  if (scope === 'serverObject' || scope === 'database') return [[...serverChain(folder), { type: 'object', object: hit.object }]]
  const name = hit.object.database ?? ''
  const database: ObjectRef = { kind: 'database', name }
  /** The folders down to `folder` below the database, or below the schema row when grouped and the folder moved there. */
  const listing = (folder: FolderId, schema: string | undefined): ExplorerNodeRef[] => {
    if (!grouped || schema === undefined || !belowSchema(folder)) return folderChain(database, folder)
    const row: ObjectRef = { kind: 'schema', database: name, name: schema }
    return [{ type: 'object', object: row }, ...folderChain(row, folder)]
  }
  const parent = hit.object.parent
  const owner: ObjectRef | undefined = parent && { kind: parent.kind, database: name, schema: parent.schema, name: parent.name }
  // Below a parent: the parent's node, then the folders down to the hit's.
  const belowOwner: ExplorerNodeRef[] = owner ? [{ type: 'object', object: owner }, ...folderChain(owner, folder)] : []
  const belows: ExplorerNodeRef[][] = hit.via
    ? [[...listing(hit.via.folder, hit.via.schema), { type: 'object', object: { kind: 'table', database: name, schema: hit.via.schema, name: hit.via.name } }, ...belowOwner]]
    : parent
      ? (hit.parentFolder ? [hit.parentFolder] : parentFolders[parent.kind]).map(folder => [...listing(folder, parent.schema), ...belowOwner])
      : [listing(folder, hit.object.schema)]
  const under = (folder: FolderId): RevealPath[] => belows.map(below => [...folderChain(server, folder), { type: 'object', object: database }, ...below, { type: 'object', object: hit.object }])
  return systemDatabases.has(name.toLowerCase()) ? [...under('systemDatabases'), ...under('databases')] : [...under('databases'), ...under('systemDatabases')]
}
/** The hit's identity across answers: its object and the folder that lists it, as the list keys its rows. */
export const hitKey = (hit: ObjectSearchHit): string => JSON.stringify([hit.object, hit.folder])
/** A hit's identity across servers: the same object may be on several. */
export const serverHitKey = (connectionId: string, hit: ObjectSearchHit): string => JSON.stringify([connectionId, hit.object, hit.folder])

/** An All servers search's groups: each server's answer with where its hits start in the merged result. */
export interface ServerGroup extends ServerAnswer { readonly start: number; readonly hits: readonly ObjectSearchHit[] }
export function serverGroups(document: SearchDocumentState): readonly ServerGroup[] {
  let start = 0
  return (document.servers ?? []).map(answer => {
    const hits = answer.result?.hits ?? [], group = { ...answer, start, hits }
    start += hits.length
    return group
  })
}
/** The indexes of the hits the list shows: every hit, but with All servers none in a collapsed group. */
export function shownHits(document: SearchDocumentState): readonly number[] {
  if (!document.allServers) return (document.result?.hits ?? []).map((_hit, index) => index)
  const collapsed = new Set(document.collapsed ?? [])
  return serverGroups(document).filter(group => !collapsed.has(group.connectionId)).flatMap(group => group.hits.map((_hit, offset) => group.start + offset))
}
/** The server of the hit at `index` in the search's result: the search's own server, or with All servers its group's. */
export function hitServer(document: SearchDocumentState, index: number): string | undefined {
  if (!document.allServers) return document.connectionId
  return serverGroups(document).find(group => index >= group.start && index < group.start + group.hits.length)?.connectionId
}
/**
 * One result from each server's answer, in their order: their hits one group after another, totals added up, partial when
 * any stopped early, as slow as the slowest, and a problem only when every server that answered had one (the query itself,
 * such as an invalid regular expression); a server's own problem shows with its group.
 */
export function mergeAnswers(answers: readonly ServerAnswer[]): ObjectSearchResult | undefined {
  const results = answers.flatMap(answer => answer.result ? [answer.result] : [])
  if (!results.length) return undefined
  const asked = results.filter(result => !unasked.has(result))
  const problems = asked.flatMap(result => result.problem ? [result.problem] : [])
  return {
    hits: results.flatMap(result => result.hits), total: results.reduce((sum, result) => sum + result.total, 0), partial: results.some(result => result.partial),
    elapsedMs: Math.max(...results.map(result => result.elapsedMs)), index: results[0]!.index, ...asked.length && problems.length === asked.length ? { problem: problems[0]! } : {}
  }
}

/** The selected hit's identity, with its server when the search spans several. */
function selectedKey(document: SearchDocumentState): string | undefined {
  const index = document.current, hit = index === undefined ? undefined : document.result?.hits[index]
  return hit && index !== undefined ? serverHitKey(hitServer(document, index) ?? '', hit) : undefined
}
/**
 * Where the selected hit is in a new answer to the same query (a build's end runs it again, as may the user: Enter, or text
 * typed and taken back, or a server joining an All servers search), so the selection, and the focus on it, survive while the
 * user walks the hits; undefined after any other query, or when the hit is gone.
 */
function keptHit(document: SearchDocumentState, asked: SearchQueryState, next: SearchDocumentState): number | undefined {
  const key = selectedKey(document), hits = next.result?.hits ?? []
  if (key === undefined || JSON.stringify(document.asked) !== JSON.stringify(asked)) return undefined
  const at = hits.findIndex((hit, index) => serverHitKey(hitServer(next, index) ?? '', hit) === key)
  return at < 0 ? undefined : at
}
/** An All servers search on its way: one request per server still to answer, and the answers that have landed. */
interface Fanout {
  readonly requestId: string
  readonly asked: SearchQueryState
  /** The servers in the groups' order (Object Explorer's), with the names they are shown by; a server that joins as the search
   *  runs is added in its place. */
  order: readonly { readonly connectionId: string; readonly label: string }[]
  /** The requests still on their way, by server. */
  readonly requests: Map<string, string>
  /** The answers in, by server; null for a server whose search was cancelled (it disconnected as it ran), which drops out. */
  readonly answers: Map<string, ServerAnswer | null>
  /** The servers of the search before, to name those that have left since. */
  readonly previous: readonly ServerAnswer[]
  readonly done: Promise<void>
  readonly settle: () => void
}
const emptyQuery: SearchQueryState = { text: '', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all', types: [] }
/** A connected server Search Objects indexes: SQL Server's catalogs, or BigQuery's projects through its REST API. */
const live = (connection: LiveConnection | undefined): connection is LiveConnection => isLiveConnection(connection)
/** An index response with no hits, for a server none of a search's chosen types apply to (Models on a SQL Server). */
const noHits = (index: ObjectIndexStatus | undefined): ObjectSearchResult => {
  const result = { hits: [], total: 0, partial: false, elapsedMs: 0, index: index ?? { state: 'none' as const, databases: 0, indexed: 0, objects: 0, modules: 0, cut: 0, skipped: [], definitions: true } }
  unasked.add(result)
  return result
}
/** The no-hits answers made up for servers that were not asked: they say nothing about whether the query itself is valid. */
const unasked = new WeakSet<ObjectSearchResult>()

/**
 * Search Objects: builds each connected server's object index in the backend (explorer.index: names, and module definitions
 * unless Options says not to), shows its progress in the status bar, and runs each Search Objects tab's searches
 * (explorer.search) as the user types. The index itself lives only in the backend's memory; the page keeps the hits of the
 * last search per tab. A build starts when a server connects (Options › Index objects when a server connects), or when a
 * search is opened on a server that has none while that option is on. With it off nothing builds an index but the user:
 * Build index in the search, or Rebuild Search Index.
 */
export class ObjectSearchService extends SnapshotStore<ObjectSearchSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'objectSearch' as const
  readonly saves = false
  readonly inSaveAll = false
  private readonly timers: Timers
  private readonly newId: () => string
  private readonly typing = new Map<string, unknown>()
  /** An All servers search on its way, by search. */
  private readonly fanouts = new Map<string, Fanout>()
  private focusedList: string | undefined
  private readonly registrations: Disposable[] = []
  private known = new Set<string>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false
  private paneFocusTaken = 0
  /** BigQuery refreshes asked while a build ran, by connection: each runs once the build ends, so none cancels another. */
  private readonly refreshes = new Map<string, BigQueryRefresh[]>()
  /** Builds still at the bulk path's estimate or cost prompt, by request: Stop, a newer build or dispose closes the prompt. */
  private readonly estimating = new Map<string, AbortController>()
  /** The newest stale mark each BigQuery connection's stale-only build was asked for (staleHint). */
  private readonly staleAsked = new Map<string, number>()
  /** Builds the user stopped: their CANCELLED answer keeps the stale mark asked, so only a newer mark asks again. */
  private readonly stopping = new Set<string>()
  /** Each connection's last status read after a stopped build: a reply that is not the latest, or that a build started since, is dropped. */
  private readonly statusReads = new Map<string, number>()
  private statusSeq = 0

  constructor(private readonly o: ObjectSearchOptions) {
    super({ indexes: {}, documents: {}, paneFocus: 0 })
    this.targetBindings = new CustomDocumentTargets(o)
    this.timers = o.timers ?? browserTimers
    this.newId = o.newId ?? (() => crypto.randomUUID())
    this.registrations.push(o.documents.registerProvider(this))
    const unsubscribe = o.connections.subscribe(() => this.sync())
    const unlisten = o.api.onExplorerIndexProgress(progress => this.progress(progress))
    this.registrations.push({ dispose: unsubscribe }, { dispose: unlisten })
    const unlistenDocuments = o.documents.subscribe?.(() => this.syncDocuments())
    if (unlistenDocuments) this.registrations.push({ dispose: unlistenDocuments })
    if (o.events) this.registrations.push(o.events.subscribe(event => { if (event.type === 'query.finished') this.queryFinished(event.tabId, event.summary?.indexStale) }))
    this.sync()
  }

  /**
   * Builds (or rebuilds) a connection's index; a build already running is superseded and answers CANCELLED. A BigQuery index
   * discovers every accessible project when Options says to and always includes the connection's starred projects; `refresh`
   * re-reads part of it instead (refreshBigQuery).
   */
  build(connectionId: string, refresh?: BigQueryRefresh): void {
    const connection = this.o.connections.get(connectionId)
    if (this.disposed || !live(connection)) return
    const bigQuery = isBigQueryConnection(connection)
    const partial = refresh && !('full' in refresh) ? refresh : undefined
    if (!partial) this.refreshes.delete(connectionId)
    const requestId = this.newId()
    // A status read still in flight describes the index before this build: its reply must not land over this build's answer.
    this.statusReads.delete(connectionId)
    const previous = this.getSnapshot().indexes[connectionId]
    const definitions = this.o.settings.get('objectExplorer.search.definitions')
    // The limit every connection's index shares rides on each build, so a change in Options applies from the next one.
    const memoryLimitMiB = this.o.settings.get('objectExplorer.search.memoryLimitMiB')
    const allProjects = bigQuery ? this.o.settings.get('objectExplorer.search.bigQueryAccessibleProjects') : undefined
    const maxProjects = bigQuery && allProjects !== false ? this.o.settings.get('objectExplorer.search.bigQueryMaxProjects') : undefined
    const rawStarred = bigQuery ? this.o.starredProjects?.(connectionId) : undefined
    const starredProjects = rawStarred?.length ? [...rawStarred] : undefined
    if (bigQuery && !partial) {
      this.indexedStarred.set(connectionId, new Set(starredProjects ?? []))
      this.indexedScopes.delete(connectionId)
    }
    const scopeKeyOf = (scope: BigQueryIndexScope) => scope.dataset !== undefined ? `${scope.project}\u0000${scope.dataset}` : scope.project
    if (bigQuery && partial && 'scope' in partial) this.inFlightScope.set(connectionId, scopeKeyOf(partial.scope))
    else this.inFlightScope.delete(connectionId)
    // The billed bulk path: a full BigQuery build with the option on, only after its free estimate and the cost prompts.
    const bulk = bigQuery && !partial && this.o.settings.get('textEditor.googleSql.bulkIndex') && !!this.o.billedGate && !!this.o.api.bigQueryIndexEstimate
    // A newer build closes an older one's prompt. An older build already sent the backend supersedes when the new one is sent, which
    // the bulk path does only after its prompt: so it is stopped now, or Stop at the prompt would leave it running unseen.
    const prompt = previous?.requestId ? this.estimating.get(previous.requestId) : undefined
    if (prompt) prompt.abort()
    else if (bulk && previous?.requestId) void this.o.api.explorerCancel([previous.requestId]).catch(onUnexpectedError)
    this.putIndex({ connectionId, requestId, done: 0, total: 0, objects: previous?.status?.objects ?? 0, ...bulk ? { phase: 'estimate' as const } : {}, ...previous?.status ? { status: previous.status } : {} })
    const send = (billed: BigQueryBulkIndex | undefined) => {
      // Re-read current starred projects right before sending (stars may have changed while the async estimate/cost prompt ran).
      const liveStarred = bigQuery ? this.o.starredProjects?.(connectionId) : undefined
      const currentStarred = liveStarred?.length ? [...liveStarred] : undefined
      if (bigQuery && !partial) this.indexedStarred.set(connectionId, new Set(currentStarred ?? []))
      const billing = connection.options.provider === 'bigquery' ? connection.options.project : undefined
      let finalBulk = billed
      if (finalBulk && billing !== undefined) {
        const allowed = new Set([billing, ...currentStarred ?? []])
        const locations = finalBulk.locations.filter(item => allowed.has(item.project))
        finalBulk = locations.length ? { ...finalBulk, locations } : undefined
      }
      void this.o.api.explorerIndex({
        connectionId, requestId, definitions, memoryLimitMiB,
        ...allProjects !== undefined ? { allProjects } : {}, ...maxProjects !== undefined ? { maxProjects } : {}, ...currentStarred ? { starredProjects: currentStarred } : {},
        ...bigQuery && partial ? partial : {}, ...finalBulk ? { bulk: finalBulk } : {}
      }).then(result => {
        const entry = this.getSnapshot().indexes[connectionId]
        const stopped = this.stopping.delete(requestId)
        if (this.disposed || entry?.requestId !== requestId) return
        this.inFlightScope.delete(connectionId)
        if (result.ok) {
          if (bigQuery && partial && 'scope' in partial && !scopeHasSkip(result.value.status.skipped, partial.scope)) {
            const scopes = this.indexedScopes.get(connectionId) ?? new Set<string>()
            scopes.add(scopeKeyOf(partial.scope))
            this.indexedScopes.set(connectionId, scopes)
            if (partial.scope.dataset === undefined) {
              const known = this.indexedStarred.get(connectionId) ?? new Set<string>()
              known.add(partial.scope.project)
              this.indexedStarred.set(connectionId, known)
            }
          }
          this.putIndex({ connectionId, done: result.value.status.databases, total: result.value.status.databases, objects: result.value.status.objects, status: result.value.status })
          // After a full BigQuery build completes, carry any open scoped tabs (e.g. unstarred external datasets when discovery is off)
          // by queueing missingOnly scope reads before presenting their final results.
          const deferredProjects = bigQuery && !partial ? this.queueOpenBigQueryScopes(connectionId) : undefined
          this.refresh(connectionId, deferredProjects)
          // DDL that landed during the build (or a mark it did not reach) is read by a stale-only build after it.
          this.staleHint(connectionId, result.value.status.staleMark)
        } else {
          // A refresh that fails leaves the index it refreshed as it was, still searchable: only a whole build's failure is the index's.
          const failed = result.code !== 'CANCELLED' && !(partial && entry.status && entry.status.state !== 'none')
          this.putIndex({ connectionId, done: entry.done, total: entry.total, objects: entry.objects, ...entry.status ? { status: entry.status } : {}, ...failed ? { error: result.error } : {} })
          // Stop (or a disconnect) ends the refreshes waiting behind the build too, and so does a whole build's failure, whose error
          // they would otherwise hide.
          if (result.code === 'CANCELLED' || failed) this.refreshes.delete(connectionId)
          // A stale-only build that did not run its course is asked again at the next hint, unless the user stopped it: Stop waits
          // for a newer mark. A refresh queued behind a build that ended this way is dropped, and so is its mark.
          if (!stopped && (result.code === 'CANCELLED' || failed || (partial && 'stale' in partial))) this.staleAsked.delete(connectionId)
          // A stopped build keeps what it read, but its CANCELLED answer carries no status: ask for it, or a first build stopped
          // part way would still say there is no index while the search finds what it read.
          if (result.code === 'CANCELLED') this.readStatus(connectionId)
        }
        this.nextRefresh(connectionId)
      }, onUnexpectedError)
    }
    if (!bulk) { send(undefined); return }
    void this.bulkPath(connectionId, requestId, definitions, starredProjects).then(answer => {
      const entry = this.getSnapshot().indexes[connectionId]
      if (this.disposed || entry?.requestId !== requestId) return
      if (answer === 'stopped') {
        // Stopped at the estimate or the prompt: nothing was sent, and the index stays as it was.
        this.putIndex({ connectionId, done: entry.done, total: entry.total, objects: entry.objects, ...entry.status ? { status: entry.status } : {} })
        this.refreshes.delete(connectionId)
        this.stopping.delete(requestId)
        return
      }
      this.putIndex({ connectionId, requestId, done: 0, total: 0, objects: entry.objects, ...entry.status ? { status: entry.status } : {} })
      send(answer)
    }, onUnexpectedError)
  }

  /**
   * The bulk path's estimate (bigquery.indexEstimate, free) and the cost prompts on it: the locations to read billed and the cap,
   * or undefined for a build with the free calls only (the estimate failed or found nothing to read, or the prompt was declined),
   * or `stopped` when Stop, a newer build or a disconnect ended it first.
   */
  private async bulkPath(connectionId: string, requestId: string, definitions: boolean, starredProjects: readonly string[] | undefined): Promise<BigQueryBulkIndex | undefined | 'stopped'> {
    const controller = new AbortController()
    this.estimating.set(requestId, controller)
    const ended = () => controller.signal.aborted || this.disposed || this.getSnapshot().indexes[connectionId]?.requestId !== requestId || !live(this.o.connections.get(connectionId))
    try {
      const estimated = await this.o.api.bigQueryIndexEstimate!({ connectionId, definitions, ...starredProjects ? { starredProjects } : {} }).catch(() => undefined)
      if (ended()) return 'stopped'
      // The estimate is the build's budget: the backend runs a location's jobs one at a time, each capped so that together they
      // never bill more than what the prompts showed (a location the rest cannot cover is read with the free calls).
      const budgetBytes = estimated?.ok ? Math.ceil(estimated.value.estimate.bytesProcessed) : 0
      if (!estimated?.ok || !estimated.value.locations.length || !(budgetBytes >= 1 && budgetBytes <= Number.MAX_SAFE_INTEGER)) return undefined
      // A prompt that fails is no consent: the build goes ahead with the free calls rather than stay at Estimating.
      const answer = await this.o.billedGate!(connectionId, estimated.value.estimate, controller.signal).catch(() => undefined)
      if (ended()) return 'stopped'
      if (!answer?.run) return undefined
      return { locations: estimated.value.locations, budgetBytes, ...answer.maximumBytesBilled !== undefined ? { maximumBytesBilled: answer.maximumBytesBilled } : {} }
    } finally { this.estimating.delete(requestId) }
  }

  /** The starred projects cleanly indexed for each live BigQuery connection (by build or completed scoped refresh). */
  private readonly indexedStarred = new Map<string, Set<string>>()
  /** Scoped projects/datasets cleanly indexed (no skip for that scope) for each live BigQuery connection. */
  private readonly indexedScopes = new Map<string, Set<string>>()
  /** Currently running scoped refresh key per connection, kept separate from completed `indexedScopes`. */
  private readonly inFlightScope = new Map<string, string>()

  /**
   * Re-reads part of a BigQuery connection's index: a project or dataset whole (Object Explorer's Refresh on it), or the datasets
   * DDL from a query tab marked (`stale`). A connection with no index yet builds nothing (its first build reads everything); one
   * whose build is running re-reads once that build ends, so the refresh never cancels it.
   */
  /** Returns whether the refresh was sent or queued behind the running build. */
  refreshBigQuery(connectionId: string, refresh: BigQueryRefresh): boolean {
    const connection = this.o.connections.get(connectionId)
    if (this.disposed || !live(connection) || !isBigQueryConnection(connection)) return false
    const entry = this.getSnapshot().indexes[connectionId]
    if (entry?.requestId) {
      if ('scope' in refresh && refresh.missingOnly) {
        const key = refresh.scope.dataset !== undefined ? `${refresh.scope.project}\u0000${refresh.scope.dataset}` : refresh.scope.project
        if (this.inFlightScope.get(connectionId) === key) return true
      }
      const queued = this.refreshes.get(connectionId) ?? []
      if (!queued.some(item => JSON.stringify(item) === JSON.stringify(refresh))) this.refreshes.set(connectionId, [...queued, refresh])
      return true
    }
    // After a whole build failed, only another whole build clears its error: a partial one would hide it.
    if (entry?.error && !('full' in refresh)) return false
    if (!entry?.status || entry.status.state === 'none') return false
    this.build(connectionId, refresh)
    return true
  }

  /** Queues a `missingOnly` scoped refresh for an open BigQuery tab's project/dataset when it is not already covered by billing, stars, or a completed scope read. */
  private ensureBigQueryScope(connectionId: string, scope: BigQueryIndexScope): boolean {
    const connection = this.o.connections.get(connectionId)
    if (!live(connection) || !isBigQueryConnection(connection)) return false
    const billing = connection.options.provider === 'bigquery' ? connection.options.project : undefined
    const starred = this.o.starredProjects?.(connectionId) ?? []
    const entry = this.getSnapshot().indexes[connectionId]
    const scopes = this.indexedScopes.get(connectionId)
    const scopeIndexed = scopes?.has(scope.project) || (scope.dataset !== undefined && scopes?.has(`${scope.project}\u0000${scope.dataset}`))
    if (!(entry?.status?.state === 'ready' || entry?.requestId)
      || scope.project === billing || starred.includes(scope.project) || this.indexedStarred.get(connectionId)?.has(scope.project) || scopeIndexed) {
      return false
    }
    return this.refreshBigQuery(connectionId, { scope, missingOnly: true })
  }

  /** After a full BigQuery build ends, queues `missingOnly` scope reads for any open single-server Search tabs scoped to unstarred external projects/datasets. */
  private queueOpenBigQueryScopes(connectionId: string): Set<string> | undefined {
    const connection = this.o.connections.get(connectionId)
    if (!live(connection) || !isBigQueryConnection(connection)) return undefined
    const billing = connection.options.provider === 'bigquery' ? connection.options.project : undefined
    const starred = this.o.starredProjects?.(connectionId) ?? []
    const queued = this.refreshes.get(connectionId) ?? []
    const nextQueue = [...queued]
    let deferred: Set<string> | undefined
    for (const document of Object.values(this.getSnapshot().documents)) {
      if (document.allServers || document.connectionId !== connectionId || document.project === undefined) continue
      if (document.project === billing || starred.includes(document.project)) continue
      const scope: BigQueryIndexScope = document.dataset !== undefined ? { project: document.project, dataset: document.dataset } : { project: document.project }
      const refresh: BigQueryRefresh = { scope, missingOnly: true }
      if (!nextQueue.some(item => JSON.stringify(item) === JSON.stringify(refresh))) nextQueue.push(refresh)
      deferred ??= new Set<string>()
      deferred.add(document.project)
    }
    if (nextQueue.length !== queued.length) this.refreshes.set(connectionId, nextQueue)
    return deferred
  }

  /** Refreshes any starred project for `connectionId` that was not yet included when its index started (e.g. after startup/migration starred load). */
  syncBigQueryStarred(connectionId: string): void {
    if (this.disposed || !this.getSnapshot().indexes[connectionId]) return
    const connection = this.o.connections.get(connectionId)
    const billing = connection?.options.provider === 'bigquery' ? connection.options.project : undefined
    const starred = this.o.starredProjects?.(connectionId) ?? []
    for (const project of starred) {
      if (project === billing || this.indexedStarred.get(connectionId)?.has(project)) continue
      if (this.inFlightScope.get(connectionId) === project) continue
      this.refreshBigQuery(connectionId, { scope: { project } })
    }
  }


  /** Object Explorer's Refresh on a BigQuery node: its project, or its dataset (a node below one re-reads that dataset); the
   *  server's node re-reads every project. Other nodes leave the index as it is. */
  refreshNode(connectionId: string, ref: ExplorerNodeRef): void {
    const object = ref.type === 'object' ? ref.object : ref.owner
    if (object.kind === 'server') { this.refreshBigQuery(connectionId, { full: true }); return }
    if (object.kind === 'bqProject' && object.name) this.refreshBigQuery(connectionId, { scope: { project: object.name } })
    else if (object.kind === 'bqDataset' && object.project && object.name) this.refreshBigQuery(connectionId, { scope: { project: object.project, dataset: object.name } })
    else if (object.project && object.dataset) this.refreshBigQuery(connectionId, { scope: { project: object.project, dataset: object.dataset } })
  }

  /** Stops a running build: what it read so far stays searchable. */
  stopBuild(connectionId: string): void {
    this.refreshes.delete(connectionId)
    const requestId = this.getSnapshot().indexes[connectionId]?.requestId
    if (requestId) this.stopping.add(requestId)
    if (requestId) this.estimating.get(requestId)?.abort()
    if (requestId) void this.o.api.explorerCancel([requestId]).catch(onUnexpectedError)
  }

  /** Stops every running build (the status bar's Stop). */
  stopAll(): void {
    this.refreshes.clear()
    for (const controller of this.estimating.values()) controller.abort()
    const ids = Object.values(this.getSnapshot().indexes).flatMap(entry => entry.requestId ? [entry.requestId] : [])
    for (const id of ids) this.stopping.add(id)
    if (ids.length) void this.o.api.explorerCancel(ids).catch(onUnexpectedError)
  }

  /**
   * Opens a Search Objects tab on the server (the first connected one when none is named), with `text` if given; `allServers`
   * searches every connected server instead, and the tab belongs to none of them. `scope` narrows a single-server tab to a SQL
   * Server database or a BigQuery project (and optional dataset). `fuzzy` opens it with Fuzzy Match on.
   */
  open(connectionId?: string, text?: string, allServers = false, scope?: SearchScopeTarget, fuzzy = false): string | undefined {
    const connection = connectionId ? this.o.connections.get(connectionId) : this.o.connections.getSnapshot().find(live)
    if (!live(connection)) throw new Error('Connect to a server to search its objects.')
    const document = this.o.documents.openCustom('objectSearch', searchTitle, allServers ? undefined : connection.id, 'master')
    if (!allServers) this.targetBindings.bind(document.id, connection.id)
    const scoped = allServers || scope === undefined ? {}
      : typeof scope === 'string' ? { database: scope }
      : scope.database !== undefined ? { database: scope.database }
      : scope.project !== undefined ? { project: scope.project, ...scope.dataset !== undefined ? { dataset: scope.dataset } : {} }
      : {}
    this.putDocument({ id: document.id, connectionId: connection.id, ...emptyQuery, ...fuzzy ? { fuzzy } : {}, ...text ? { text } : {}, ...allServers ? { allServers: true } : scoped })
    for (const id of allServers ? this.liveIds() : [connection.id]) this.ensureIndex(id)
    // Searching a scoped unstarred BigQuery project/dataset whose connection already has a ready/building index
    // asks the backend to read it only if missing or previously skipped (0 API calls when already covered by discovery).
    if (!allServers && isBigQueryConnection(connection) && typeof scope === 'object' && scope.project !== undefined) {
      this.ensureBigQueryScope(connection.id, scope.dataset !== undefined ? { project: scope.project, dataset: scope.dataset } : { project: scope.project })
    }
    if (text) void this.search(document.id)
    this.o.focus?.(document.id)
    return document.id
  }

  /**
   * Points Object Explorer's box at a server: the one its selection is on, or the first connected one. Its text and options
   * stay; a server with no index yet gets one (ensureIndex). With no server connected the box keeps its text for the next one.
   */
  followExplorer(connectionId: string | undefined): void {
    if (this.disposed) return
    const target = connectionId && live(this.o.connections.get(connectionId)) ? connectionId : this.o.connections.getSnapshot().find(live)?.id
    if (!target) return
    const current = this.getSnapshot().documents[explorerSearchId]
    if (!current) {
      this.putDocument({ id: explorerSearchId, connectionId: target, ...emptyQuery })
      this.ensureIndex(target)
    } else this.setConnection(explorerSearchId, target)
  }

  /**
   * The header's Search asks for `text`: names only, approximately too (Fuzzy Match), on every connected server, after the
   * same pause in typing as a tab's. Nothing is asked before there is text, and it never builds an index: a server without
   * one answers no hits until the user builds it (Build index in Search Objects, or Rebuild Search Index).
   */
  quickSearch(text: string): void {
    if (this.disposed) return
    const current = this.getSnapshot().documents[quickSearchId]
    if (!current) {
      const connectionId = this.liveIds()[0]
      if (!text.trim() || !connectionId) return
      this.putDocument({ id: quickSearchId, connectionId, ...emptyQuery, scope: 'names', fuzzy: true, limit: quickSearchHits, allServers: true })
    } else if (current.text === text) return
    this.setQuery(quickSearchId, { text })
  }
  /** The header's Search closed: its search is cancelled and forgotten. */
  endQuickSearch(): void { this.closed(quickSearchId) }

  /** Search in Object Explorer: the box takes focus once it is shown. */
  focusPane(): void {
    if (!this.disposed) this.publish({ ...this.getSnapshot(), paneFocus: this.getSnapshot().paneFocus + 1 })
  }
  /** Whether the box should take focus now: once per request, so a box mounted later (the pane was hidden) still takes it. */
  takePaneFocus(): boolean {
    const { paneFocus } = this.getSnapshot()
    if (paneFocus === this.paneFocusTaken) return false
    this.paneFocusTaken = paneFocus
    return true
  }

  /** Sizes Object Explorer's search band (its splitter); undefined goes back to sizing by content. */
  setPaneSize(size: number | undefined): void {
    if (this.disposed) return
    const { paneSize: previous, ...rest } = this.getSnapshot()
    const next = size === undefined ? undefined : clampPaneBand(size)
    if (next !== previous) this.publish(next === undefined ? rest : { ...rest, paneSize: next })
  }

  /** Changes what a tab asks; text changes search after a short pause, option changes at once. */
  setQuery(id: string, patch: Partial<SearchQueryState>): void {
    const document = this.getSnapshot().documents[id]
    if (!document) return
    this.putDocument({ ...document, ...patch })
    const pending = this.typing.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.typing.delete(id)
    if (patch.text !== undefined && patch.text.trim()) this.typing.set(id, this.timers.setTimeout(() => { this.typing.delete(id); void this.search(id) }, objectSearchLimits.typingMs))
    else void this.search(id)
  }

  /** Points a tab at another connected server. */
  setConnection(id: string, connectionId: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document || (document.connectionId === connectionId && !document.allServers) || !live(this.o.connections.get(connectionId))) return
    this.cancelSearch(document)
    const { database: _database, project: _project, dataset: _dataset, ...query } = this.query(document)
    this.putDocument({ id, connectionId, ...query })
    if (this.o.documents.get(id)) {
      this.targetBindings.bind(id, connectionId)
      this.o.documents.update?.(id, { connectionId, targetId: this.o.targetIdOf?.(connectionId) })
    }
    this.ensureIndex(connectionId)
    void this.search(id)
  }

  /** Points a tab at every connected server: each gets an index if it has none, and servers that connect later join in. */
  setAllServers(id: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document || document.allServers || id === explorerSearchId) return
    this.cancelSearch(document)
    const { database: _database, project: _project, dataset: _dataset, ...query } = this.query(document)
    this.putDocument({ id, connectionId: document.connectionId, ...query, allServers: true })
    this.targetBindings.forget(id)
    if (this.o.documents.get(id)) this.o.documents.update?.(id, { connectionId: undefined, targetId: undefined })
    for (const connectionId of this.liveIds()) this.ensureIndex(connectionId)
    void this.search(id)
  }

  /**
   * Collapses or expands an All servers search's group. A group that collapses on the selected hit hands the selection to the
   * next shown hit (or the last one before it, or none), so the keys that act on the selection never act on a hidden hit.
   */
  toggleGroup(id: string, connectionId: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document?.allServers) return
    const collapsed = document.collapsed ?? [], collapsing = !collapsed.includes(connectionId)
    const next: SearchDocumentState = { ...document, collapsed: collapsing ? [...collapsed, connectionId] : collapsed.filter(other => other !== connectionId) }
    const current = document.current
    if (!collapsing || current === undefined || hitServer(document, current) !== connectionId) { this.putDocument(next); return }
    const shown = shownHits(next), after = shown.find(index => index > current), before = shown.filter(index => index < current).at(-1)
    const { current: _hidden, ...rest } = next, moved = after ?? before
    this.putDocument(moved === undefined ? rest : { ...rest, current: moved })
  }

  /** Runs a tab's search now; a search still on its way is cancelled. Settles once it has answered. */
  search(id: string): Promise<void> {
    const document = this.getSnapshot().documents[id]
    if (!document || this.disposed) return Promise.resolve()
    this.cancelSearch(document)
    const asked = this.query(document)
    const kept = { id, connectionId: document.connectionId, ...document.allServers ? { allServers: true as const, ...document.collapsed ? { collapsed: document.collapsed } : {} } : {} }
    if (!asked.text.trim()) { this.putDocument({ ...this.query(document), ...kept }); return Promise.resolve() }
    if (document.allServers) return this.searchAll(document, asked)
    if (!this.searchable(document)) { this.putDocument({ ...document, requestId: undefined, error: 'The server is not connected.' }); return Promise.resolve() }
    const requestId = this.newId()
    this.putDocument({ ...document, requestId, error: undefined })
    return this.ask(document.connectionId, requestId, asked).then(result => {
      const current = this.getSnapshot().documents[id]
      if (this.disposed || current?.requestId !== requestId || current.connectionId !== document.connectionId || !this.searchable(current)) return
      const { requestId: _done, ...rest } = current
      if (result.ok) { const next = { ...rest, result: result.value, asked, error: undefined }; this.putDocument({ ...next, current: keptHit(current, asked, next) }) }
      else if (result.code !== 'CANCELLED') this.putDocument({ ...rest, error: result.error })
      else this.putDocument(rest)
    }, onUnexpectedError)
  }

  /**
   * Enter in the box: the hit after the one Enter revealed last (Shift+Enter: the one before), wrapping round, so repeated
   * Enters walk the hits as Find Next walks matches. The first Enter after typing searches at once if the answer is not in yet,
   * and takes the first hit (Shift+Enter: the last). Undefined when the search has no hits.
   */
  async step(id: string, delta: 1 | -1): Promise<ObjectSearchHit | undefined> {
    const answered = (document: SearchDocumentState | undefined): document is SearchDocumentState & { readonly result: ObjectSearchResult } =>
      !!document?.result && !document.requestId && !this.typing.has(id) && !!document.asked && JSON.stringify(document.asked) === JSON.stringify(this.query(document))
    if (!answered(this.getSnapshot().documents[id])) {
      const pending = this.typing.get(id)
      if (pending !== undefined) this.timers.clearTimeout(pending)
      this.typing.delete(id)
      await this.search(id)
    }
    const document = this.getSnapshot().documents[id]
    if (!answered(document) || this.disposed) return undefined
    const hits = document.result.hits, count = hits.length
    if (!count) return undefined
    const current = document.current === undefined || document.current >= count ? (delta > 0 ? 0 : count - 1) : (document.current + delta + count) % count
    this.putDocument({ ...document, current })
    return hits[current]
  }

  /** The hit selected in the list (clicked, reached with the arrows, or revealed): the next Enter in the box goes on from it. */
  pick(id: string, current: number): void {
    const document = this.getSnapshot().documents[id]
    if (document?.result && current >= 0 && current < document.result.hits.length) this.putDocument({ ...document, current })
  }
  /**
   * Selects `hit` (on `connectionId`, which an All servers search needs, as the same object may be on several servers) wherever
   * the search's current result has it: a menu's hit may have moved, or gone, since the menu opened.
   */
  pickHit(id: string, hit: ObjectSearchHit, connectionId?: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document) return
    const key = hitKey(hit), spanning = document.allServers && connectionId !== undefined
    const at = document.result?.hits.findIndex((other, index) => hitKey(other) === key && (!spanning || hitServer(document, index) === connectionId)) ?? -1
    this.pick(id, at)
  }

  /** The search whose hits have keyboard focus, as SearchPanel's list reports it: the keys that act on a result (Ctrl+Shift+C) act on its selected hit. */
  listFocused(id: string, focused: boolean): void {
    if (focused) this.focusedList = id
    else if (this.focusedList === id) this.focusedList = undefined
  }
  /** The selected hit of the list that has focus (with none selected, the first one shown), with its search's server. */
  focusedHit(): FocusedHit | undefined {
    const id = this.focusedList, document = id === undefined ? undefined : this.getSnapshot().documents[id]
    const index = document?.current ?? (document ? shownHits(document)[0] : undefined), hit = index === undefined ? undefined : document?.result?.hits[index]
    const connectionId = document && index !== undefined ? hitServer(document, index) : undefined
    return id !== undefined && document && hit && index !== undefined && connectionId ? { searchId: id, connectionId, index, hit } : undefined
  }

  /** Reveal in Object Explorer: walks the hit's path from the server down, loading what it needs, and selects its node. */
  reveal(host: RevealHost, connectionId: string, hit: ObjectSearchHit): Promise<SeekOutcome> {
    const paths = revealPaths(hit, !!host.groupBySchema)
    if (!paths.length) return Promise.resolve({ ok: false, message: unknownKindReveal })
    if (hit.object.project !== undefined && host.ensureBigQueryProject?.(connectionId, hit.object.project) === false) {
      return Promise.resolve({ ok: false, message: 'Object Explorer shows at most 50 session projects per connection. Star or remove one, then try again.' })
    }
    return host.seek(connectionId, paths)
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.o.focus?.(id) }
  follows(): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document) return
    this.targetBindings.forget(id)
    this.cancelSearch(document)
    const pending = this.typing.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.typing.delete(id)
    const { [id]: _closed, ...documents } = this.getSnapshot().documents
    this.publish({ ...this.getSnapshot(), documents })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.indexedStarred.clear()
    this.indexedScopes.clear()
    this.inFlightScope.clear()
    for (const controller of this.estimating.values()) controller.abort()
    this.estimating.clear()
    this.targetBindings.clear()
    for (const pending of this.typing.values()) this.timers.clearTimeout(pending)
    this.typing.clear()
    for (const fanout of this.fanouts.values()) fanout.settle()
    this.fanouts.clear()
    for (const registration of this.registrations.splice(0)) registration.dispose()
    this.clearListeners()
  }

  private query(document: SearchDocumentState): SearchQueryState {
    return { text: document.text, caseSensitive: document.caseSensitive, wholeWord: document.wholeWord, regex: document.regex, fuzzy: document.fuzzy, scope: document.scope, types: document.types,
      ...document.database !== undefined ? { database: document.database } : {},
      ...document.project !== undefined ? { project: document.project, ...document.dataset !== undefined ? { dataset: document.dataset } : {} } : {},
      ...document.limit !== undefined ? { limit: document.limit } : {} }
  }

  /** Sends one server's search: only the kinds its engine holds (none chosen for it answers no hits without asking), and only
   *  that engine's scope (database for SQL Server; project and optional dataset for BigQuery). */
  private ask(connectionId: string, requestId: string, asked: SearchQueryState) {
    const connection = this.o.connections.get(connectionId)
    const bigQuery = !!connection && isBigQueryConnection(connection)
    const typed = searchTypeKinds(asked.types)
    const own = typed && providerSearchKinds(bigQuery ? 'bigquery' : 'sqlserver', typed)
    if (own && !own.length) return Promise.resolve({ ok: true as const, value: noHits(this.getSnapshot().indexes[connectionId]?.status) })
    const answer = this.o.api.explorerSearch({
      connectionId, requestId, text: asked.text, caseSensitive: asked.caseSensitive, wholeWord: asked.wholeWord, regex: asked.regex, in: asked.scope, ...own ? { kinds: own } : {},
      ...asked.fuzzy && !asked.regex ? { match: 'fuzzy' as const } : {},
      ...!bigQuery && asked.database !== undefined ? { database: asked.database } : {},
      ...bigQuery && asked.project !== undefined ? { project: asked.project, ...asked.dataset !== undefined ? { dataset: asked.dataset } : {} } : {},
      ...asked.limit !== undefined ? { limit: asked.limit } : {}
    })
    // A job that ended without its tab (closed, stopped, left running) marked datasets after its run's end: the next search finds them.
    if (bigQuery) void answer.then(result => { if (result.ok) this.staleHint(connectionId, result.value.index.staleMark) }, () => {})
    return answer
  }

  /** A BigQuery query tab's run ended: the newest stale mark its connection's index holds, if any, is read now. */
  private queryFinished(tabId: string, indexStale: number | undefined): void {
    const connectionId = this.o.documents.get(tabId)?.connectionId
    if (connectionId) this.staleHint(connectionId, indexStale)
  }

  /**
   * A BigQuery index holds a stale mark newer than the last one a stale-only build was asked for (a query's result, a search's or a
   * build's status names it): one stale-only build reads what DDL marked. A mark a failed read left keeps its number, so it asks no
   * build again; the next DDL's mark does.
   */
  private staleHint(connectionId: string, mark: number | undefined): void {
    if (mark === undefined || mark <= (this.staleAsked.get(connectionId) ?? 0)) return
    const connection = this.o.connections.get(connectionId)
    if (!live(connection) || !isBigQueryConnection(connection)) return
    // Recorded only once a build is sent or queued: a refresh refused now (a failed whole build) is asked again at the next hint.
    if (this.refreshBigQuery(connectionId, { stale: true })) this.staleAsked.set(connectionId, mark)
  }

  /** Runs the next BigQuery refresh asked while a build ran. */
  private nextRefresh(connectionId: string): void {
    const queued = this.refreshes.get(connectionId)
    const next = queued?.shift()
    if (!queued?.length) this.refreshes.delete(connectionId)
    if (next) this.refreshBigQuery(connectionId, next)
  }

  /**
   * An All servers search: one explorer.search per connected server, at once, each on its own index (so each server's limit is
   * its own, and one large server cannot crowd the others out). Each server's group shows as its answer lands, in Object
   * Explorer's order, so a slow server holds back only its own group; a server that fails shows its error in its group, and the
   * servers the last search had that are gone are named. `only` asks just those servers again (a build ended, or a server
   * joined) and keeps every other server's answer, when the tab already shows this query's answers.
   */
  private searchAll(document: SearchDocumentState, asked: SearchQueryState, only?: readonly string[]): Promise<void> {
    const id = document.id, servers = this.o.connections.getSnapshot().filter(live)
    if (!servers.length) {
      // No server is left to answer: a cancelled search's pending marks go (keeping any answer they showed), so no group or
      // picker entry still says it is searching.
      const settled = document.servers?.flatMap(({ pending: _pending, ...answer }): ServerAnswer[] => answer.result || answer.error ? [answer] : [])
      const { servers: _servers, landed: _landed, ...rest } = document
      this.putDocument({ ...rest, ...settled?.length ? { servers: settled } : {}, requestId: undefined, error: 'No server is connected.' })
      return Promise.resolve()
    }
    const requestId = this.newId()
    let settle = () => {}
    const done = new Promise<void>(resolve => { settle = resolve })
    const fanout: Fanout = {
      requestId, asked, order: servers.map(connection => ({ connectionId: connection.id, label: connection.displayName || connection.server })),
      requests: new Map(), answers: new Map(), previous: document.servers ?? [], done, settle
    }
    // Asking some servers again: every other server's answer to this query stands as it is.
    if (only) for (const answer of document.servers ?? []) if (!only.includes(answer.connectionId) && !answer.pending && servers.some(connection => connection.id === answer.connectionId)) fanout.answers.set(answer.connectionId, answer)
    this.fanouts.set(id, fanout)
    this.putDocument({ ...document, requestId, error: undefined })
    for (const { connectionId } of fanout.order) if (!fanout.answers.has(connectionId)) this.askServer(id, fanout, connectionId)
    // A whole search keeps the last answers in view until a server answers; asking some again marks just those pending now.
    if (only || !fanout.requests.size) this.land(id, fanout)
    return done
  }

  /** Sends one server's part of an All servers search; its answer lands in its group. */
  private askServer(id: string, fanout: Fanout, connectionId: string): void {
    const requestId = this.newId()
    fanout.requests.set(connectionId, requestId)
    fanout.answers.delete(connectionId)
    void this.ask(connectionId, requestId, fanout.asked).then(result => {
      if (this.disposed || this.fanouts.get(id) !== fanout || fanout.requests.get(connectionId) !== requestId) return
      fanout.requests.delete(connectionId)
      const label = fanout.order.find(server => server.connectionId === connectionId)?.label ?? connectionId
      fanout.answers.set(connectionId, result.ok ? { connectionId, label, result: result.value } : result.code === 'CANCELLED' ? null : { connectionId, label, error: result.error })
      this.land(id, fanout)
    }, onUnexpectedError)
  }

  /**
   * Shows an All servers search as far as it has got: the servers that answered, and the rest marked pending (with their answer
   * to the same query before, while the tab shows one). The selection stays on its server's hit across the landings.
   */
  private land(id: string, fanout: Fanout): void {
    const current = this.getSnapshot().documents[id]
    if (this.disposed || current?.requestId !== fanout.requestId) return
    const same = !!current.asked && JSON.stringify(current.asked) === JSON.stringify(fanout.asked)
    const before = new Map((same ? current.servers ?? [] : []).map(answer => [answer.connectionId, answer]))
    const servers = fanout.order.flatMap(({ connectionId, label }): ServerAnswer[] => {
      const answer = fanout.answers.get(connectionId)
      if (answer !== undefined) return answer ? [answer] : []
      const stale = before.get(connectionId)?.result
      return [{ connectionId, label, pending: true, ...stale ? { result: stale } : {} }]
    })
    const searched = new Set(servers.map(answer => answer.connectionId))
    const left = fanout.previous.filter(answer => !searched.has(answer.connectionId) && !live(this.o.connections.get(answer.connectionId))).map(answer => answer.label)
    const finished = !fanout.requests.size
    const { requestId: _request, landed: _landed, left: _left, result: _result, ...base } = current
    const next: SearchDocumentState = { ...base, ...finished ? {} : { requestId: fanout.requestId, landed: fanout.requestId }, servers, asked: fanout.asked, error: undefined, ...left.length ? { left } : {} }
    const merged = mergeAnswers(servers)
    const answered = merged ? { ...next, result: merged } : next
    this.putDocument({ ...answered, current: keptHit(current, fanout.asked, answered) })
    if (finished) { this.fanouts.delete(id); fanout.settle() }
  }

  private cancelSearch(document: SearchDocumentState): void {
    const fanout = this.fanouts.get(document.id)
    const ids = fanout ? [...fanout.requests.values()] : document.requestId ? [document.requestId] : []
    this.fanouts.delete(document.id)
    fanout?.settle()
    if (ids.length) void this.o.api.explorerCancel(ids).catch(onUnexpectedError)
  }

  /**
   * Asks some servers again in a tab's All servers search, once their index changed (a build ended) or they joined: only their
   * part, merged into the answers the tab shows, rather than the whole search on every server. A search on its way asks them
   * again within it; a tab that shows no answer to its query yet, or is waiting out a pause in typing, runs its whole search.
   */
  private searchServers(id: string, connectionIds: readonly string[]): void {
    const document = this.getSnapshot().documents[id]
    if (!document?.allServers || !document.text.trim() || this.typing.has(id) || this.disposed) return
    const asked = this.query(document), fanout = this.fanouts.get(id)
    const targets = connectionIds.filter(connectionId => live(this.o.connections.get(connectionId)))
    if (fanout && JSON.stringify(fanout.asked) === JSON.stringify(asked)) {
      // A server that joined as the search runs takes its place in Object Explorer's order within it, rather than the whole
      // search running again on every server (servers connecting one by one would cost N²/2 requests).
      const inOrder = (connectionId: string) => fanout.order.some(server => server.connectionId === connectionId)
      if (!targets.every(inOrder)) {
        fanout.order = this.o.connections.getSnapshot().filter(connection => live(connection) && (inOrder(connection.id) || targets.includes(connection.id)))
          .map(connection => ({ connectionId: connection.id, label: connection.displayName || connection.server }))
      }
      const superseded = targets.flatMap(connectionId => { const request = fanout.requests.get(connectionId); return request ? [request] : [] })
      if (superseded.length) void this.o.api.explorerCancel(superseded).catch(onUnexpectedError)
      for (const connectionId of targets) this.askServer(id, fanout, connectionId)
      this.land(id, fanout)
      return
    }
    if (fanout || JSON.stringify(document.asked) !== JSON.stringify(asked) || !document.servers) { void this.search(id); return }
    void this.searchAll(document, asked, targets)
  }

  private liveIds(): string[] { return this.o.connections.getSnapshot().filter(live).map(connection => connection.id) }

  /**
   * Builds a server's index when it has none and none is building, while Options › Index objects when a server connects is
   * on (a server that connected while it was off, say). With it off the user chose not to have builds start on their own,
   * so opening or pointing a search at a server builds nothing: the search says the server has no index and offers to build it.
   * BigQuery's completion calls it too, the first time it finds a connection with no index.
   */
  ensureIndex(connectionId: string): void {
    if (!this.o.settings.get('objectExplorer.search.indexOnConnect')) return
    const entry = this.getSnapshot().indexes[connectionId]
    if (!entry?.status && !entry?.requestId) this.build(connectionId)
  }

  /** Re-runs the searches of a connection's tabs once its build ends, so they see the whole index; an All servers tab asks only
   *  that server again, so N builds ending cost N requests, not N per connected server. */
  private refresh(connectionId: string, deferredProjects?: ReadonlySet<string>): void {
    for (const document of Object.values(this.getSnapshot().documents)) {
      if (!document.text.trim()) continue
      if (document.allServers) this.searchServers(document.id, [connectionId])
      else if (document.connectionId === connectionId && (!deferredProjects || document.project === undefined || !deferredProjects.has(document.project))) void this.search(document.id)
    }
  }

  private searchable(search: SearchDocumentState): boolean {
    if (!live(this.o.connections.get(search.connectionId))) return false
    const document = this.o.documents.get(search.id)
    return !document || document.connectionId === search.connectionId && this.targetBindings.matchesConnection(search.id, document.connectionId)
  }

  /** A custom search follows only its exact target; background reconnect leaves its runtime association detached. */
  private syncDocuments(): void {
    if (this.disposed) return
    for (const search of Object.values(this.getSnapshot().documents)) {
      if (search.allServers) continue
      const document = this.o.documents.get(search.id)
      if (!document) continue
      const connectionId = document.connectionId
      if (!this.targetBindings.matchesConnection(search.id, connectionId) || !connectionId || !live(this.o.connections.get(connectionId))) {
        const pending = this.typing.get(search.id)
        if (pending !== undefined) this.timers.clearTimeout(pending)
        this.typing.delete(search.id)
        if (search.requestId) this.cancelSearch(search)
        if (search.requestId || search.error !== 'The server is not connected.')
          this.putDocument({ ...search, requestId: undefined, error: 'The server is not connected.' })
      } else if (connectionId !== search.connectionId) {
        this.cancelSearch(search)
        this.putDocument({ ...search, connectionId, requestId: undefined, error: undefined })
        this.ensureIndex(connectionId)
        if (search.text.trim()) void this.search(search.id)
      }
    }
  }

  private sync(): void {
    if (this.disposed) return
    this.syncDocuments()
    const connections = this.o.connections.getSnapshot()
    const ids = new Set(connections.filter(live).map(connection => connection.id))
    const { indexes } = this.getSnapshot()
    const gone = Object.keys(indexes).filter(id => !ids.has(id))
    for (const id of [...this.refreshes.keys()]) if (!ids.has(id)) this.refreshes.delete(id)
    for (const id of [...this.staleAsked.keys()]) if (!ids.has(id)) this.staleAsked.delete(id)
    for (const id of [...this.indexedStarred.keys()]) if (!ids.has(id)) this.indexedStarred.delete(id)
    for (const id of [...this.indexedScopes.keys()]) if (!ids.has(id)) this.indexedScopes.delete(id)
    for (const id of [...this.inFlightScope.keys()]) if (!ids.has(id)) this.inFlightScope.delete(id)
    if (gone.length) {
      const kept = { ...indexes }
      // A disconnect closes a bulk build's estimate or cost prompt.
      for (const id of gone) { const requestId = indexes[id]?.requestId; if (requestId) this.estimating.get(requestId)?.abort() }
      for (const id of gone) delete kept[id]
      this.publish({ ...this.getSnapshot(), indexes: kept })
    }
    // A retained single-server tab keeps its filter and completed hits, but no old-handle reply may repopulate it.
    for (const document of Object.values(this.getSnapshot().documents)) {
      if (document.allServers || ids.has(document.connectionId)) continue
      const pending = this.typing.get(document.id)
      if (pending !== undefined) this.timers.clearTimeout(pending)
      this.typing.delete(document.id)
      if (document.requestId) this.cancelSearch(document)
      if (document.requestId || document.error !== 'The server is not connected.')
        this.putDocument({ ...document, requestId: undefined, error: 'The server is not connected.' })
    }
    for (const id of ids) if (!this.known.has(id) && this.o.settings.get('objectExplorer.search.indexOnConnect')) this.build(id)
    const joined = [...ids].filter(id => !this.known.has(id)), departed = [...this.known].some(id => !ids.has(id))
    this.known = ids
    if (!joined.length && !departed) return
    // A server that connects joins every All servers search (with an index if it has none), asked on its own; one that leaves
    // drops out of it, and the search runs again to name it.
    const spanning = Object.values(this.getSnapshot().documents).filter(document => document.allServers)
    // The header's Search spans the servers too, but builds nothing.
    if (spanning.some(document => document.id !== quickSearchId)) for (const id of ids) this.ensureIndex(id)
    for (const document of spanning) {
      if (!document.text.trim()) continue
      if (departed) void this.search(document.id)
      else this.searchServers(document.id, joined)
    }
  }

  /** Reads a connection's index status after a stopped build, unless a newer build or a disconnect came first. */
  private readStatus(connectionId: string): void {
    const read = this.o.api.explorerIndexStatus
    if (!read) return
    const seq = ++this.statusSeq
    this.statusReads.set(connectionId, seq)
    void read({ connectionId }).then(result => {
      if (this.statusReads.get(connectionId) !== seq) return
      this.statusReads.delete(connectionId)
      const entry = this.getSnapshot().indexes[connectionId]
      if (this.disposed || !result.ok || !entry || entry.requestId || !live(this.o.connections.get(connectionId))) return
      const { status } = result.value
      this.putIndex({ connectionId, done: status.indexed, total: status.databases, objects: status.objects, status, ...entry.error ? { error: entry.error } : {} })
    }, onUnexpectedError)
  }

  private progress(progress: ObjectIndexProgress): void {
    const entry = Object.values(this.getSnapshot().indexes).find(value => value.requestId === progress.requestId)
    if (!entry) return
    const { growing: _growing, throttled: _throttled, savedAt: _savedAt, ...rest } = entry
    this.putIndex({ ...rest, done: progress.done, total: progress.total, objects: progress.objects, ...progress.phase ? { phase: progress.phase } : {}, ...progress.growing ? { growing: true } : {}, ...progress.throttled ? { throttled: true } : {},
      ...progress.savedAt ? { savedAt: progress.savedAt } : {} })
  }

  private putIndex(entry: IndexEntry): void {
    if (this.disposed) return
    this.publish({ ...this.getSnapshot(), indexes: { ...this.getSnapshot().indexes, [entry.connectionId]: entry } })
  }

  private putDocument(document: SearchDocumentState): void {
    if (this.disposed) return
    this.publish({ ...this.getSnapshot(), documents: { ...this.getSnapshot().documents, [document.id]: document } })
  }
}
