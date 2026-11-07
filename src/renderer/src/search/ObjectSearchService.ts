import type { VariaApi } from '../../../shared/contracts'
import { belowSchema, folderSpecs, kindSpecs, type FolderId } from '../../../shared/explorer/catalog.ts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import { objectSearchLimits, type ObjectIndexProgress, type ObjectIndexStatus, type ObjectSearchHit, type ObjectSearchResult, type SearchScope, type SearchType, searchTypeKinds } from '../../../shared/explorer/search.ts'
import type { SettingKey, SettingValue } from '../../../shared/settings/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { ConnectionService, LiveConnection } from '../services/connections'
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
  readonly status?: ObjectIndexStatus
  readonly error?: string
}
/** What a Search Objects tab asks and shows. */
export interface SearchQueryState {
  readonly text: string
  readonly caseSensitive: boolean
  readonly wholeWord: boolean
  readonly regex: boolean
  readonly scope: SearchScope
  /** The type filters chosen (searchTypes); none searches every kind. */
  readonly types: readonly SearchType[]
}
export interface SearchDocumentState extends SearchQueryState {
  readonly id: string
  readonly connectionId: string
  /** The search on its way. */
  readonly requestId?: string
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
/** Object Explorer as Reveal uses it: its seek, and whether it groups objects by schema (the paths differ). */
export interface RevealHost {
  seek(connectionId: string, paths: readonly RevealPath[]): Promise<SeekOutcome>
  readonly groupBySchema?: boolean
}
export interface ObjectSearchOptions {
  readonly api: Pick<VariaApi, 'explorerIndex' | 'explorerSearch' | 'explorerCancel' | 'onExplorerIndexProgress'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot'>
  readonly connections: Pick<ConnectionService, 'getSnapshot' | 'subscribe' | 'get'>
  readonly settings: { get<K extends SettingKey>(key: K): SettingValue<K> }
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

export const searchTitle = 'Search Objects'
/** The search Object Explorer's box runs: the same search as a tab's, on the server of the explorer's selection. */
export const explorerSearchId = 'explorer'
/** A list's selected hit: its search, the search's server, and the hit's index in the result. */
export interface FocusedHit { readonly searchId: string; readonly connectionId: string; readonly index: number; readonly hit: ObjectSearchHit }

/** The folders from the owner down to `folder`, outermost first (Programmability › Functions › Scalar-valued Functions). */
function folderChain(owner: ObjectRef, folder: FolderId): ExplorerNodeRef[] {
  const chain: ExplorerNodeRef[] = []
  for (let at: FolderId | undefined = folder; at; at = folderSpecs[at].parent) chain.unshift({ type: 'folder', owner, folder: at })
  return chain
}
const systemDatabases = new Set(['master', 'model', 'msdb'])
/** Where a child's parent may be listed when the hit does not say: under its kind's folder, then the System one. */
const parentFolders: { readonly [K in 'table' | 'view' | 'tableType' | 'procedure' | 'function']: readonly FolderId[] } = {
  table: ['tables', 'systemTables'], view: ['views', 'systemViews'], tableType: ['userDefinedTableTypes'],
  procedure: ['storedProcedures', 'systemStoredProcedures'], function: ['tableValuedFunctions', 'scalarValuedFunctions', 'aggregateFunctions', 'functions']
}
/**
 * Where a hit is in Object Explorer, from the server down. A server object is in its folder below the server (Security ›
 * Logins), and a database in its Databases folder. Anything else is in its database, under Databases (or System Databases,
 * tried first for master, model and msdb, and second for the rest: a distribution database is a system one too): the folders
 * above its listing, a child's parent in the folder the hit names (or, when it names none, under its kind's folders, then
 * their System ones), and the object. A temporal or ledger history table (or a child of one) is below the table whose history
 * row shows it. With Group by Schema on (`grouped`), a schema-scoped listing hangs below its schema's row (the object's, its
 * parent's or its history table's schema) rather than below the database.
 */
export function revealPaths(hit: ObjectSearchHit, grouped = false): RevealPath[] {
  const server: ObjectRef = { kind: 'server' }
  const scope = kindSpecs[hit.object.kind].scope
  if (scope === 'serverObject' || scope === 'database') return [[...folderChain(server, hit.folder), { type: 'object', object: hit.object }]]
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
  const belowOwner: ExplorerNodeRef[] = owner ? [{ type: 'object', object: owner }, ...folderChain(owner, hit.folder)] : []
  const belows: ExplorerNodeRef[][] = hit.via
    ? [[...listing(hit.via.folder, hit.via.schema), { type: 'object', object: { kind: 'table', database: name, schema: hit.via.schema, name: hit.via.name } }, ...belowOwner]]
    : parent
      ? (hit.parentFolder ? [hit.parentFolder] : parentFolders[parent.kind]).map(folder => [...listing(folder, parent.schema), ...belowOwner])
      : [listing(hit.folder, hit.object.schema)]
  const under = (folder: FolderId): RevealPath[] => belows.map(below => [...folderChain(server, folder), { type: 'object', object: database }, ...below, { type: 'object', object: hit.object }])
  return systemDatabases.has(name.toLowerCase()) ? [...under('systemDatabases'), ...under('databases')] : [...under('databases'), ...under('systemDatabases')]
}
/** The hit's identity across answers: its object and the folder that lists it, as the list keys its rows. */
export const hitKey = (hit: ObjectSearchHit): string => JSON.stringify([hit.object, hit.folder])
/**
 * Where the selected hit is in a new answer to the same query (a build's end runs it again, as may the user: Enter, or text
 * typed and taken back), so the selection, and the focus on it, survive while the user walks the hits; undefined after any
 * other query, or when the hit is gone.
 */
function keptHit(document: SearchDocumentState, asked: SearchQueryState, hits: readonly ObjectSearchHit[]): number | undefined {
  const selected = document.current === undefined ? undefined : document.result?.hits[document.current]
  if (!selected || JSON.stringify(document.asked) !== JSON.stringify(asked)) return undefined
  const key = hitKey(selected), at = hits.findIndex(hit => hitKey(hit) === key)
  return at < 0 ? undefined : at
}
const emptyQuery: SearchQueryState = { text: '', caseSensitive: false, wholeWord: false, regex: false, scope: 'all', types: [] }
const live = (connection: LiveConnection | undefined): connection is LiveConnection => !!connection && !connection.lost

/**
 * Search Objects: builds each connected server's object index in the backend (explorer.index: names, and module definitions
 * unless Options says not to), shows its progress in the status bar, and runs each Search Objects tab's searches
 * (explorer.search) as the user types. The index itself lives only in the backend's memory; the page keeps the hits of the
 * last search per tab. A build starts when a server connects (Options › Index objects when a server connects), or when a
 * tab first searches a server that has none.
 */
export class ObjectSearchService extends SnapshotStore<ObjectSearchSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'objectSearch' as const
  readonly saves = false
  readonly inSaveAll = false
  private readonly timers: Timers
  private readonly newId: () => string
  private readonly typing = new Map<string, unknown>()
  private focusedList: string | undefined
  private readonly registrations: Disposable[] = []
  private known = new Set<string>()
  private disposed = false
  private paneFocusTaken = 0

  constructor(private readonly o: ObjectSearchOptions) {
    super({ indexes: {}, documents: {}, paneFocus: 0 })
    this.timers = o.timers ?? browserTimers
    this.newId = o.newId ?? (() => crypto.randomUUID())
    this.registrations.push(o.documents.registerProvider(this))
    const unsubscribe = o.connections.subscribe(() => this.sync())
    const unlisten = o.api.onExplorerIndexProgress(progress => this.progress(progress))
    this.registrations.push({ dispose: unsubscribe }, { dispose: unlisten })
    this.sync()
  }

  /** Builds (or rebuilds) a connection's index; a build already running is superseded and answers CANCELLED. */
  build(connectionId: string): void {
    if (this.disposed || !live(this.o.connections.get(connectionId))) return
    const requestId = this.newId()
    const previous = this.getSnapshot().indexes[connectionId]
    this.putIndex({ connectionId, requestId, done: 0, total: 0, objects: previous?.status?.objects ?? 0, ...previous?.status ? { status: previous.status } : {} })
    void this.o.api.explorerIndex({ connectionId, requestId, definitions: this.o.settings.get('objectExplorer.search.definitions') }).then(result => {
      const entry = this.getSnapshot().indexes[connectionId]
      if (this.disposed || entry?.requestId !== requestId) return
      if (result.ok) {
        this.putIndex({ connectionId, done: result.value.status.databases, total: result.value.status.databases, objects: result.value.status.objects, status: result.value.status })
        this.refresh(connectionId)
      } else this.putIndex({ connectionId, done: entry.done, total: entry.total, objects: entry.objects, ...entry.status ? { status: entry.status } : {}, ...result.code === 'CANCELLED' ? {} : { error: result.error } })
    }, onUnexpectedError)
  }

  /** Stops a running build: what it read so far stays searchable. */
  stopBuild(connectionId: string): void {
    const requestId = this.getSnapshot().indexes[connectionId]?.requestId
    if (requestId) void this.o.api.explorerCancel([requestId]).catch(onUnexpectedError)
  }

  /** Stops every running build (the status bar's Stop). */
  stopAll(): void {
    const ids = Object.values(this.getSnapshot().indexes).flatMap(entry => entry.requestId ? [entry.requestId] : [])
    if (ids.length) void this.o.api.explorerCancel(ids).catch(onUnexpectedError)
  }

  /** Opens a Search Objects tab on the server (the first connected one when none is named), with `text` if given. */
  open(connectionId?: string, text?: string): string | undefined {
    const connection = connectionId ? this.o.connections.get(connectionId) : this.o.connections.getSnapshot().find(live)
    if (!live(connection)) throw new Error('Connect to a server to search its objects.')
    const document = this.o.documents.openCustom('objectSearch', searchTitle, connection.id, 'master')
    this.putDocument({ id: document.id, connectionId: connection.id, ...emptyQuery, ...text ? { text } : {} })
    if (!this.getSnapshot().indexes[connection.id]?.status && !this.getSnapshot().indexes[connection.id]?.requestId) this.build(connection.id)
    if (text) void this.search(document.id)
    this.o.focus?.(document.id)
    return document.id
  }

  /**
   * Points Object Explorer's box at a server: the one its selection is on, or the first connected one. Its text and options
   * stay; a server with no index yet gets one. With no server connected the box keeps its text for the next one.
   */
  followExplorer(connectionId: string | undefined): void {
    if (this.disposed) return
    const target = connectionId && live(this.o.connections.get(connectionId)) ? connectionId : this.o.connections.getSnapshot().find(live)?.id
    if (!target) return
    const current = this.getSnapshot().documents[explorerSearchId]
    if (!current) {
      this.putDocument({ id: explorerSearchId, connectionId: target, ...emptyQuery })
      const entry = this.getSnapshot().indexes[target]
      if (!entry?.status && !entry?.requestId) this.build(target)
    } else this.setConnection(explorerSearchId, target)
  }

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
    if (!document || document.connectionId === connectionId || !live(this.o.connections.get(connectionId))) return
    this.cancelSearch(document)
    this.putDocument({ id, connectionId, ...this.query(document) })
    const entry = this.getSnapshot().indexes[connectionId]
    if (!entry?.status && !entry?.requestId) this.build(connectionId)
    void this.search(id)
  }

  /** Runs a tab's search now; a search still on its way is cancelled. Settles once it has answered. */
  search(id: string): Promise<void> {
    const document = this.getSnapshot().documents[id]
    if (!document || this.disposed) return Promise.resolve()
    this.cancelSearch(document)
    const asked = this.query(document)
    if (!asked.text.trim()) { this.putDocument({ ...this.query(document), id, connectionId: document.connectionId }); return Promise.resolve() }
    if (!live(this.o.connections.get(document.connectionId))) { this.putDocument({ ...document, requestId: undefined, error: 'The server is not connected.' }); return Promise.resolve() }
    const requestId = this.newId()
    this.putDocument({ ...document, requestId, error: undefined })
    const kinds = searchTypeKinds(asked.types)
    return this.o.api.explorerSearch({
      connectionId: document.connectionId, requestId, text: asked.text, caseSensitive: asked.caseSensitive, wholeWord: asked.wholeWord, regex: asked.regex, in: asked.scope, ...kinds ? { kinds } : {}
    }).then(result => {
      const current = this.getSnapshot().documents[id]
      if (this.disposed || current?.requestId !== requestId) return
      const { requestId: _done, ...rest } = current
      if (result.ok) this.putDocument({ ...rest, result: result.value, asked, error: undefined, current: keptHit(current, asked, result.value.hits) })
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
  /** Selects `hit` wherever the search's current result has it: a menu's hit may have moved, or gone, since the menu opened. */
  pickHit(id: string, hit: ObjectSearchHit): void {
    const key = hitKey(hit), at = this.getSnapshot().documents[id]?.result?.hits.findIndex(other => hitKey(other) === key) ?? -1
    this.pick(id, at)
  }

  /** The search whose hits have keyboard focus, as SearchPanel's list reports it: the keys that act on a result (Ctrl+Shift+C) act on its selected hit. */
  listFocused(id: string, focused: boolean): void {
    if (focused) this.focusedList = id
    else if (this.focusedList === id) this.focusedList = undefined
  }
  /** The selected hit of the list that has focus, with its search's server. */
  focusedHit(): FocusedHit | undefined {
    const id = this.focusedList, document = id === undefined ? undefined : this.getSnapshot().documents[id]
    const index = document?.current ?? 0, hit = document?.result?.hits[index]
    return id !== undefined && document && hit ? { searchId: id, connectionId: document.connectionId, index, hit } : undefined
  }

  /** Reveal in Object Explorer: walks the hit's path from the server down, loading what it needs, and selects its node. */
  reveal(host: RevealHost, connectionId: string, hit: ObjectSearchHit): Promise<SeekOutcome> {
    return host.seek(connectionId, revealPaths(hit, !!host.groupBySchema))
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.o.focus?.(id) }
  follows(): boolean { return false }
  closed(id: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document) return
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
    for (const pending of this.typing.values()) this.timers.clearTimeout(pending)
    this.typing.clear()
    for (const registration of this.registrations.splice(0)) registration.dispose()
    this.clearListeners()
  }

  private query(document: SearchDocumentState): SearchQueryState {
    return { text: document.text, caseSensitive: document.caseSensitive, wholeWord: document.wholeWord, regex: document.regex, scope: document.scope, types: document.types }
  }

  private cancelSearch(document: SearchDocumentState): void {
    if (document.requestId) void this.o.api.explorerCancel([document.requestId]).catch(onUnexpectedError)
  }

  /** Re-runs the searches of a connection's tabs once its build ends, so they see the whole index. */
  private refresh(connectionId: string): void {
    for (const document of Object.values(this.getSnapshot().documents)) if (document.connectionId === connectionId && document.text.trim()) void this.search(document.id)
  }

  /** A new connection gets a build (when Options says so); a disconnected or lost one's entry goes, as its index went. */
  private sync(): void {
    if (this.disposed) return
    const connections = this.o.connections.getSnapshot()
    const ids = new Set(connections.filter(live).map(connection => connection.id))
    const { indexes } = this.getSnapshot()
    const gone = Object.keys(indexes).filter(id => !ids.has(id))
    if (gone.length) {
      const kept = { ...indexes }
      for (const id of gone) delete kept[id]
      this.publish({ ...this.getSnapshot(), indexes: kept })
    }
    for (const id of ids) if (!this.known.has(id) && this.o.settings.get('objectExplorer.search.indexOnConnect')) this.build(id)
    this.known = ids
  }

  private progress(progress: ObjectIndexProgress): void {
    const entry = Object.values(this.getSnapshot().indexes).find(value => value.requestId === progress.requestId)
    if (!entry) return
    this.putIndex({ ...entry, done: progress.done, total: progress.total, objects: progress.objects })
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
