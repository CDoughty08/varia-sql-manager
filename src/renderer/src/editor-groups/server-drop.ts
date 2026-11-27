// Dragging a server or database from Object Explorer onto a query (its tab or its editor) moves the query there, through
// the same path as Query › Change Connection…; dropping on a tab strip's empty space opens a new query on it. On
// multi-server and Cross-Engine tabs, drops add targets (or update a target's database/dataset) while enforcing engine
// and Cross-Engine dialect pane compatibility. docs/connections-explorer.md describes the behaviour.
import type { ProviderId } from '../../../shared/providers'
import { isQueryDocument, type MultiDocumentTarget, type QueryDocument } from '../documents'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import type { ConnectionService } from '../services/connections'
import type { DocumentService } from '../services/documents'
import type { QueryService } from '../services/queries'
import type { TargetService } from '../services/targets'
import { SnapshotStore } from '../core/store'

const maxMultiTargets = 32

/** The drag type a server or database row carries while it can retarget a query. Its data is empty: the drag lives here. */
export const explorerTargetDragType = 'application/x-varia-explorer-target'

/** The server (and, for a database row, the database) being dragged. */
export interface ServerDrag {
  readonly connectionId: string
  readonly database?: string
  /** What the card and the flying chip show: the server's display name, or the database's. */
  readonly label: string
  readonly server: string
}

/** What dropping the drag on a document would do. */
export type DropVerdict =
  | { readonly accept: true; readonly action: 'move' | 'database' | 'addTarget' | 'updateTargetDatabase' }
  | { readonly accept: false; readonly reason: 'notQuery' | 'running' | 'same' | 'disconnected' | 'busy' | 'wrongEngine' | 'wrongDialectPane' | 'targetLimit' }

export interface DropRect { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
export type DropPlace = 'tab' | 'strip' | 'editor'
export interface DropHover {
  readonly place: DropPlace
  /** The document under the pointer; none over a tab strip's empty space. */
  readonly tabId?: string
  /** In Cross-Engine Split mode, which dialect pane the pointer is over (`sqlserver` or `bigquery`). */
  readonly dialect?: ProviderId
  readonly verdict: DropVerdict
  /** Ctrl (⌥ on macOS) over the editor: the editor's own drop inserts the name instead. */
  readonly insert: boolean
  /** The tab, strip or editor, in viewport pixels. */
  readonly rect: DropRect
}
/**
 * A drop on a query: the chip flies from `from` into its tab at once; once the query has moved (`arrived`, after any
 * transaction prompt), the tab plays its swap. A cancelled or failed move drops the landing.
 */
export interface DropLanding { readonly seq: number; readonly tabId: string; readonly from: DropRect; readonly label: string; readonly connectionId: string; readonly arrived: boolean }
export interface ServerDropSnapshot {
  readonly drag?: ServerDrag
  readonly hover?: DropHover
  readonly landing?: DropLanding
}

type Documents = Pick<DocumentService, 'get' | 'activate' | 'newQuery' | 'getSnapshot'> & Partial<Pick<DocumentService, 'setMultiTargets' | 'updateMultiTarget'>>
export interface ServerDropOptions {
  readonly documents: Documents
  readonly queries: Pick<QueryService, 'isRunning'>
  readonly targets: Pick<TargetService, 'changeConnection' | 'changeDatabase'> & Partial<Pick<TargetService, 'targetForConnection'>>
  readonly connections: Pick<ConnectionService, 'get'>
}

// One object per verdict, so a hover that did not change publishes nothing while the pointer moves.
export const verdicts = Object.freeze({
  move: Object.freeze({ accept: true, action: 'move' }),
  database: Object.freeze({ accept: true, action: 'database' }),
  addTarget: Object.freeze({ accept: true, action: 'addTarget' }),
  updateTargetDatabase: Object.freeze({ accept: true, action: 'updateTargetDatabase' }),
  notQuery: Object.freeze({ accept: false, reason: 'notQuery' }),
  running: Object.freeze({ accept: false, reason: 'running' }),
  same: Object.freeze({ accept: false, reason: 'same' }),
  disconnected: Object.freeze({ accept: false, reason: 'disconnected' }),
  busy: Object.freeze({ accept: false, reason: 'busy' }),
  wrongEngine: Object.freeze({ accept: false, reason: 'wrongEngine' }),
  wrongDialectPane: Object.freeze({ accept: false, reason: 'wrongDialectPane' }),
  targetLimit: Object.freeze({ accept: false, reason: 'targetLimit' })
} satisfies Record<string, DropVerdict>)

export interface DropContext {
  readonly dragProvider?: ProviderId
  readonly dropDialect?: ProviderId
}

/** What a drop of `drag` on `document` does: refused for non-queries, running queries, wrong engine/dialect pane, or duplicates. */
export function dropVerdict(
  document: Pick<QueryDocument, 'kind' | 'connectionId' | 'database' | 'provider' | 'multiMode' | 'multiTargets'> | undefined,
  drag: ServerDrag,
  state: { readonly running: boolean; readonly live: boolean; readonly busy: boolean },
  context: DropContext = {}
): DropVerdict {
  if (!document || !isQueryDocument(document)) return verdicts.notQuery
  if (!state.live) return verdicts.disconnected
  if (state.running) return verdicts.running
  if (state.busy) return verdicts.busy
  if (document.multiMode) {
    const dragProvider: ProviderId = context.dragProvider ?? 'sqlserver'
    if (document.multiMode === 'same') {
      const tabProvider: ProviderId = document.provider ?? document.multiTargets?.[0]?.provider ?? 'sqlserver'
      if (dragProvider !== tabProvider) return verdicts.wrongEngine
    } else if (context.dropDialect && dragProvider !== context.dropDialect) {
      return verdicts.wrongDialectPane
    }
    const targets = document.multiTargets ?? []
    const existing = targets.find(target => target.connectionId === drag.connectionId)
    if (existing) {
      if (!existing.enabled) return verdicts.addTarget
      return drag.database && drag.database !== existing.database ? verdicts.updateTargetDatabase : verdicts.same
    }
    if (targets.length >= maxMultiTargets) return verdicts.targetLimit
    return verdicts.addTarget
  }
  if (document.connectionId === drag.connectionId) return drag.database && drag.database !== document.database ? verdicts.database : verdicts.same
  return verdicts.move
}

/** The server drag in flight, what is under it, and the landing a drop plays. */
export class ServerDropService extends SnapshotStore<ServerDropSnapshot> {
  private seq = 0
  constructor(private readonly options: ServerDropOptions) { super({}) }

  start(drag: ServerDrag): void { this.publish({ drag }) }
  /** The drag ended (dropped anywhere, or cancelled); a landing already started keeps playing. */
  end(): void {
    const { landing } = this.getSnapshot()
    this.publish(landing ? { landing } : {})
  }
  get drag(): ServerDrag | undefined { return this.getSnapshot().drag }

  private providerOf(connectionId: string): ProviderId {
    const connection = this.options.connections.get(connectionId)
    return connection && isBigQueryConnection(connection) ? 'bigquery' : 'sqlserver'
  }

  verdict(tabId: string | undefined, drag = this.drag, dropDialect?: ProviderId): DropVerdict {
    if (!drag || tabId === undefined) return verdicts.notQuery
    const { documents, queries, connections } = this.options
    const connection = connections.get(drag.connectionId)
    return dropVerdict(
      documents.get(tabId),
      drag,
      { running: queries.isRunning(tabId), live: isLiveConnection(connection), busy: documents.getSnapshot().busy },
      { dragProvider: this.providerOf(drag.connectionId), dropDialect }
    )
  }
  /** Over a strip's empty space: a new query can open while the server is connected. */
  stripVerdict(drag = this.drag): DropVerdict {
    return drag && isLiveConnection(this.options.connections.get(drag.connectionId)) ? verdicts.move : verdicts.disconnected
  }

  hover(hover: DropHover | undefined): void {
    const current = this.getSnapshot()
    if (!current.drag) return
    const same = hover && current.hover && hover.place === current.hover.place && hover.tabId === current.hover.tabId && hover.dialect === current.hover.dialect
      && hover.insert === current.hover.insert && hover.verdict === current.hover.verdict && sameRect(hover.rect, current.hover.rect)
    if (same || (!hover && !current.hover)) return
    this.publish({ ...current, hover })
  }

  /**
   * Moves a single-server query (via Change Connection), or additively adds/updates a target on a multi-server or
   * Cross-Engine query tab. Returns whether the drop applied.
   */
  async moveQuery(tabId: string, from: DropRect, drag = this.drag, dropDialect?: ProviderId): Promise<boolean> {
    const verdict = this.verdict(tabId, drag, dropDialect)
    this.end()
    if (!drag || !verdict.accept) return false
    const { documents, targets, connections } = this.options
    const landing: DropLanding = { seq: ++this.seq, tabId, from, label: drag.label, connectionId: drag.connectionId, arrived: false }
    this.publish({ ...this.getSnapshot(), landing })
    try {
      if (verdict.action === 'addTarget' || verdict.action === 'updateTargetDatabase') {
        const doc = documents.get(tabId)
        const connection = connections.get(drag.connectionId)
        if (!doc || !doc.multiMode || !connection || !isLiveConnection(connection)) {
          this.finishLanding(landing.seq)
          return false
        }
        const provider = this.providerOf(drag.connectionId)
        const existingTargets = doc.multiTargets ?? []
        const existingIndex = existingTargets.findIndex(item => item.connectionId === drag.connectionId || (!!connection.targetId && item.targetId === connection.targetId))
        const targetId = targets.targetForConnection?.(drag.connectionId) ?? connection.targetId
        const database = drag.database ?? (provider === 'bigquery' ? (connection.database || '') : (connection.database || 'master'))
        if (existingIndex >= 0) {
          documents.updateMultiTarget?.(tabId, existingIndex, item => ({
            ...item,
            connectionId: drag.connectionId,
            ...targetId ? { targetId, attachWanted: true } : {},
            enabled: true,
            database: drag.database ?? item.database
          }))
        } else {
          const added: MultiDocumentTarget = {
            ...targetId ? { targetId, attachWanted: true } : {},
            connectionId: drag.connectionId,
            database,
            enabled: true,
            provider
          }
          documents.setMultiTargets?.(tabId, [...existingTargets, added])
        }
        documents.activate(tabId)
        if (this.getSnapshot().landing?.seq === landing.seq) this.publish({ ...this.getSnapshot(), landing: { ...landing, arrived: true } })
        return true
      }
      if (verdict.action === 'move') await targets.changeConnection(tabId, drag.connectionId)
      const now = documents.get(tabId)
      if (!now || now.connectionId !== drag.connectionId) { this.finishLanding(landing.seq); return false }
      if (drag.database && now.database !== drag.database) targets.changeDatabase(tabId, drag.database)
      documents.activate(tabId)
      if (this.getSnapshot().landing?.seq === landing.seq) this.publish({ ...this.getSnapshot(), landing: { ...landing, arrived: true } })
      return true
    } catch (error) {
      this.finishLanding(landing.seq)
      throw error
    }
  }
  /** A new query on the dragged server (and database), in the active group. */
  openQuery(drag = this.drag): boolean {
    this.end()
    const connection = drag && this.options.connections.get(drag.connectionId)
    if (!drag || !isLiveConnection(connection)) return false
    this.options.documents.newQuery('', undefined, connection.id, drag.database ?? connection.database)
    return true
  }
  /** The landing finished playing (or the move did not happen). */
  finishLanding(seq: number): void {
    const current = this.getSnapshot()
    if (current.landing?.seq !== seq) return
    const { landing: _landing, ...rest } = current
    this.publish(rest)
  }
}

const sameRect = (a: DropRect, b: DropRect): boolean => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
