import type { VariaApi } from '../../../shared/contracts'
import { belowSchema, folderSpecs, type FolderId } from '../../../shared/explorer/catalog.ts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import { objectSearchLimits, type ObjectIndexProgress, type ObjectIndexStatus, type ObjectSearchHit, type ObjectSearchResult, type SearchScope } from '../../../shared/explorer/search.ts'
import type { SettingKey, SettingValue } from '../../../shared/settings/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { ConnectionService, LiveConnection } from '../services/connections'
import type { RevealPath, SeekOutcome } from '../explorer/ExplorerService'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

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
}
export interface ObjectSearchSnapshot {
  readonly indexes: Readonly<Record<string, IndexEntry>>
  /** Each Search Objects tab's search, by document id, and Object Explorer's box's under `explorerSearchId`. */
  readonly documents: Readonly<Record<string, SearchDocumentState>>
  /** Changes when Search in Object Explorer asks the box to take focus. */
  readonly paneFocus: number
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

/** The folders from the owner down to `folder`, outermost first (Programmability › Functions › Scalar-valued Functions). */
function folderChain(owner: ObjectRef, folder: FolderId): ExplorerNodeRef[] {
  const chain: ExplorerNodeRef[] = []
  for (let at: FolderId | undefined = folder; at; at = folderSpecs[at].parent) chain.unshift({ type: 'folder', owner, folder: at })
  return chain
}
const systemDatabases = new Set(['master', 'model', 'msdb'])
/**
 * Where a hit is in Object Explorer, from the server down: its database under Databases (or System Databases, tried first
 * for master, model and msdb, and second for the rest: a distribution database is a system one too), the folders above its
 * listing, a trigger's table or view (under Tables or Views, then under their System folders), and the object. With Group
 * by Schema on (`grouped`), a schema-scoped listing hangs below its schema's row, the object's (or the trigger's table's)
 * schema, rather than below the database.
 */
export function revealPaths(hit: ObjectSearchHit, grouped = false): RevealPath[] {
  const name = hit.object.database ?? ''
  const database: ObjectRef = { kind: 'database', name }
  /** The folders down to `folder` below the database, or below the schema row when grouped and the folder moved there. */
  const listing = (folder: FolderId, schema: string | undefined): ExplorerNodeRef[] => {
    if (!grouped || schema === undefined || !belowSchema(folder)) return folderChain(database, folder)
    const row: ObjectRef = { kind: 'schema', database: name, name: schema }
    return [{ type: 'object', object: row }, ...folderChain(row, folder)]
  }
  const parent = hit.object.parent
  const belows: ExplorerNodeRef[][] = parent
    ? (() => {
        const owner: ObjectRef = { kind: parent.kind, database: name, schema: parent.schema, name: parent.name }
        const folders: FolderId[] = parent.kind === 'view' ? ['views', 'systemViews'] : ['tables', 'systemTables']
        return folders.map(folder => [...listing(folder, parent.schema), { type: 'object' as const, object: owner }, ...folderChain(owner, hit.folder)])
      })()
    : [listing(hit.folder, hit.object.schema)]
  const via = (folder: FolderId): RevealPath[] => belows.map(below => [...folderChain({ kind: 'server' }, folder), { type: 'object', object: database }, ...below, { type: 'object', object: hit.object }])
  return systemDatabases.has(name.toLowerCase()) ? [...via('systemDatabases'), ...via('databases')] : [...via('databases'), ...via('systemDatabases')]
}
const emptyQuery: SearchQueryState = { text: '', caseSensitive: false, wholeWord: false, regex: false, scope: 'all' }
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
    if (text) this.search(document.id)
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

  /** Changes what a tab asks; text changes search after a short pause, option changes at once. */
  setQuery(id: string, patch: Partial<SearchQueryState>): void {
    const document = this.getSnapshot().documents[id]
    if (!document) return
    this.putDocument({ ...document, ...patch })
    const pending = this.typing.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.typing.delete(id)
    if (patch.text !== undefined && patch.text.trim()) this.typing.set(id, this.timers.setTimeout(() => { this.typing.delete(id); this.search(id) }, objectSearchLimits.typingMs))
    else this.search(id)
  }

  /** Points a tab at another connected server. */
  setConnection(id: string, connectionId: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document || document.connectionId === connectionId || !live(this.o.connections.get(connectionId))) return
    this.cancelSearch(document)
    this.putDocument({ id, connectionId, text: document.text, caseSensitive: document.caseSensitive, wholeWord: document.wholeWord, regex: document.regex, scope: document.scope })
    const entry = this.getSnapshot().indexes[connectionId]
    if (!entry?.status && !entry?.requestId) this.build(connectionId)
    this.search(id)
  }

  /** Runs a tab's search now (Enter); a search still on its way is cancelled. */
  search(id: string): void {
    const document = this.getSnapshot().documents[id]
    if (!document || this.disposed) return
    this.cancelSearch(document)
    const asked: SearchQueryState = { text: document.text, caseSensitive: document.caseSensitive, wholeWord: document.wholeWord, regex: document.regex, scope: document.scope }
    if (!asked.text.trim()) { this.putDocument({ ...this.query(document), id, connectionId: document.connectionId }); return }
    if (!live(this.o.connections.get(document.connectionId))) { this.putDocument({ ...document, requestId: undefined, error: 'The server is not connected.' }); return }
    const requestId = this.newId()
    this.putDocument({ ...document, requestId, error: undefined })
    void this.o.api.explorerSearch({
      connectionId: document.connectionId, requestId, text: asked.text, caseSensitive: asked.caseSensitive, wholeWord: asked.wholeWord, regex: asked.regex, in: asked.scope
    }).then(result => {
      const current = this.getSnapshot().documents[id]
      if (this.disposed || current?.requestId !== requestId) return
      const { requestId: _done, ...rest } = current
      if (result.ok) this.putDocument({ ...rest, result: result.value, asked, error: undefined })
      else if (result.code !== 'CANCELLED') this.putDocument({ ...rest, error: result.error })
      else this.putDocument(rest)
    }, onUnexpectedError)
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
    return { text: document.text, caseSensitive: document.caseSensitive, wholeWord: document.wholeWord, regex: document.regex, scope: document.scope }
  }

  private cancelSearch(document: SearchDocumentState): void {
    if (document.requestId) void this.o.api.explorerCancel([document.requestId]).catch(onUnexpectedError)
  }

  /** Re-runs the searches of a connection's tabs once its build ends, so they see the whole index. */
  private refresh(connectionId: string): void {
    for (const document of Object.values(this.getSnapshot().documents)) if (document.connectionId === connectionId && document.text.trim()) this.search(document.id)
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
