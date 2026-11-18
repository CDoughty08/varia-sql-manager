// Dragging a server or database from Object Explorer onto a query (its tab or its editor) moves the query there, through
// the same path as Query › Change Connection…; dropping on a tab strip's empty space opens a new query on it.
// docs/connections-explorer.md describes the behaviour.
import { isQueryDocument, type QueryDocument } from '../documents'
import { isLiveConnection } from '../services/connection-availability'
import type { ConnectionService } from '../services/connections'
import type { DocumentService } from '../services/documents'
import type { QueryService } from '../services/queries'
import type { TargetService } from '../services/targets'
import { SnapshotStore } from '../core/store'

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
  | { readonly accept: true; readonly action: 'move' | 'database' }
  | { readonly accept: false; readonly reason: 'notQuery' | 'running' | 'same' | 'disconnected' | 'busy' }

export interface DropRect { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
export type DropPlace = 'tab' | 'strip' | 'editor'
export interface DropHover {
  readonly place: DropPlace
  /** The document under the pointer; none over a tab strip's empty space. */
  readonly tabId?: string
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

type Documents = Pick<DocumentService, 'get' | 'activate' | 'newQuery' | 'getSnapshot'>
export interface ServerDropOptions {
  readonly documents: Documents
  readonly queries: Pick<QueryService, 'isRunning'>
  readonly targets: Pick<TargetService, 'changeConnection' | 'changeDatabase'>
  readonly connections: Pick<ConnectionService, 'get'>
}

// One object per verdict, so a hover that did not change publishes nothing while the pointer moves.
export const verdicts = Object.freeze({
  move: Object.freeze({ accept: true, action: 'move' }),
  database: Object.freeze({ accept: true, action: 'database' }),
  notQuery: Object.freeze({ accept: false, reason: 'notQuery' }),
  running: Object.freeze({ accept: false, reason: 'running' }),
  same: Object.freeze({ accept: false, reason: 'same' }),
  disconnected: Object.freeze({ accept: false, reason: 'disconnected' }),
  busy: Object.freeze({ accept: false, reason: 'busy' })
} satisfies Record<string, DropVerdict>)

/** What a drop of `drag` on `document` does: refused for non-queries, running queries and the place it already is. */
export function dropVerdict(document: Pick<QueryDocument, 'kind' | 'connectionId' | 'database'> | undefined, drag: ServerDrag, state: { readonly running: boolean; readonly live: boolean; readonly busy: boolean }): DropVerdict {
  if (!document || !isQueryDocument(document)) return verdicts.notQuery
  if (!state.live) return verdicts.disconnected
  if (state.running) return verdicts.running
  if (state.busy) return verdicts.busy
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

  verdict(tabId: string | undefined, drag = this.drag): DropVerdict {
    if (!drag || tabId === undefined) return verdicts.notQuery
    const { documents, queries, connections } = this.options
    return dropVerdict(documents.get(tabId), drag, { running: queries.isRunning(tabId), live: isLiveConnection(connections.get(drag.connectionId)), busy: documents.getSnapshot().busy })
  }
  /** Over a strip's empty space: a new query can open while the server is connected. */
  stripVerdict(drag = this.drag): DropVerdict {
    return drag && isLiveConnection(this.options.connections.get(drag.connectionId)) ? verdicts.move : verdicts.disconnected
  }

  hover(hover: DropHover | undefined): void {
    const current = this.getSnapshot()
    if (!current.drag) return
    const same = hover && current.hover && hover.place === current.hover.place && hover.tabId === current.hover.tabId && hover.insert === current.hover.insert
      && hover.verdict === current.hover.verdict && sameRect(hover.rect, current.hover.rect)
    if (same || (!hover && !current.hover)) return
    this.publish({ ...current, hover })
  }

  /**
   * Moves the query to the dragged server (Change Connection, which asks about an open transaction and may be cancelled),
   * then to the dragged database when there is one. Returns whether the query ended up there.
   */
  async moveQuery(tabId: string, from: DropRect, drag = this.drag): Promise<boolean> {
    const verdict = this.verdict(tabId, drag)
    this.end()
    if (!drag || !verdict.accept) return false
    const { documents, targets } = this.options
    const landing: DropLanding = { seq: ++this.seq, tabId, from, label: drag.label, connectionId: drag.connectionId, arrived: false }
    this.publish({ ...this.getSnapshot(), landing })
    try {
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
