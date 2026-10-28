// Object Explorer's live status chips (docs/object-explorer.md, Live status): one background live view of the `explorer`
// source per connected server and login while Object Explorer shows. The backend samples; this service reads each new
// table revision's few rows (only databases that are not plainly online and open, running restores, availability groups),
// turns them into chips (src/shared/explorer/status.ts) and publishes them for every connection the view serves. It never
// reloads the tree, and never samples by itself: LiveService pauses the views while Object Explorer or the window is hidden.
import { statusChipKinds } from '../../../shared/explorer/catalog'
import { databaseChips, serverChips, type DatabaseStatusRow, type GroupRow, type ProgressRow, type StatusChip } from '../../../shared/explorer/status'
import type { LiveProbeId } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { LiveHandle, LiveOwner, LiveService, LiveSettingsSource, LiveSnapshot, LiveTable } from '../live/LiveService'
import type { ConnectionService, LiveConnection } from '../services/connections'
import type { PaneService } from '../services/panes'
import type { TreeNode } from './tree-model'

/** A row's live status: its chips, and whether they stand for the row's state (a database's sublabel then gives way). */
export interface RowStatus {
  readonly chips: readonly StatusChip[]
  /** The database probe is sampling: no chip means the database is online, writable and open to everyone. */
  readonly live: boolean
  /** What the chips say, for the row's accessible name and tooltip ("Restoring 42 %, Single user"). */
  readonly words: string
  /** A database's state as the row's status shows it (dimmed and badged when unavailable); undefined when it is usable
   *  and writable. */
  readonly state?: 'unavailable' | 'readOnly'
}
export interface ServerStatus {
  /** The server row's chips (running Agent jobs, availability group health); undefined while none are known. */
  readonly server: RowStatus | undefined
  /** Database rows' status by name, while the database probe samples; undefined otherwise. */
  readonly databases: ReadonlyMap<string, RowStatus> | undefined
  /** The database probe listed every database that is not plainly online, so one it does not list is online. False when
   *  its table was cut at its row cap: a database past the cut says nothing. */
  readonly complete: boolean
}
export interface ExplorerStatusSnapshot { readonly servers: ReadonlyMap<string, ServerStatus> }
/** Whether Object Explorer's tree can be seen. Today the explorer pane; once the rail puts other containers in that pane,
 *  the Object Explorer container's own visibility. */
export interface StatusVisibility { get(): boolean; subscribe(listener: () => void): () => void }

const probes = [...statusChipKinds.database, ...statusChipKinds.server] as LiveProbeId[]
type TableProbe = 'explorer.databases' | 'explorer.progress' | 'explorer.availability'
/** At most this many rows of a status table are read: the catalogue caps them at 1,000, a window at 4,096. */
const maxRows = 1000
const noChips: readonly StatusChip[] = []
/** A database the probe does not list: online, writable and open to everyone. */
export const onlineStatus: RowStatus = { chips: noChips, live: true, words: '' }
const usable = new Set(['fresh', 'stale'])

const statusOf = (chips: readonly StatusChip[], state?: RowStatus['state']): RowStatus => chips.length ? { chips, live: true, words: chips.map(chip => chip.words).join(', '), ...state ? { state } : {} } : onlineStatus
/** Usable as Object Explorer's listing says it: online or in emergency mode (sys.databases.state 0 or 5). */
const stateOf = (row: DatabaseStatusRow): RowStatus['state'] => row.state !== 0 && row.state !== 5 ? 'unavailable' : row.readOnly || row.standby ? 'readOnly' : undefined
const sameChips = (left: readonly StatusChip[] | undefined, right: readonly StatusChip[]) => !!left && left.length === right.length && left.every((chip, at) => {
  const other = right[at]
  return chip.id === other.id && chip.tone === other.tone && chip.label === other.label && chip.title === other.title && chip.words === other.words && chip.icon === other.icon
})
const bit = (text: string) => text === '1' || text.toLowerCase() === 'true'
const integer = (text: string) => { const value = Number.parseInt(text, 10); return Number.isFinite(value) ? value : 0 }

/** Which connections share one view: the same server, as typed, and the same login. The view reads from master, so the
 *  connection's database does not matter; another login may see other databases and hold other permissions, so it gets a
 *  view of its own. A connection whose login is unknown gets its own. */
export function statusKey(connection: Pick<LiveConnection, 'id' | 'server' | 'login'>): string {
  return connection.login ? `${connection.server.trim().toLowerCase()}\u0000${connection.login.toLowerCase()}` : 'id\u0000' + connection.id
}

/** Reads a status table's rows as cell texts (null for NULL), and whether they are all of them. */
async function readRows(table: LiveTable): Promise<{ rows: (string | null)[][]; complete: boolean }> {
  const { descriptor } = table, columns = descriptor.columns.length, count = Math.min(maxRows, descriptor.rowsAvailable)
  const complete = !descriptor.truncated && descriptor.rowsAvailable <= maxRows && (descriptor.rowsRead ?? 0) <= descriptor.rowsAvailable
  if (count === 0) return { rows: [], complete }
  const window = await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns })
  return {
    rows: Array.from({ length: window.count }, (_, row) => Array.from({ length: columns }, (_, column) => {
      const at = row * columns + column
      return window.flags[at] & 1 ? null : window.text[at]
    })),
    complete: complete && window.count === descriptor.rowsAvailable
  }
}

/** One server's view and what it last read. */
class ServerView {
  readonly handle: LiveHandle
  private subscriptionId: string | undefined
  private databases: Map<string, DatabaseStatusRow> | undefined
  private complete = false
  private progress: Map<string, ProgressRow> | undefined
  private groups: GroupRow[] | undefined
  private jobs: number | null | undefined
  /** The newest read per probe: an older read that finishes later is dropped. */
  private readonly reads = new Map<LiveProbeId, number>()
  private readSeq = 0
  private readonly stops: (() => void)[] = []
  private closed = false
  /** What was published last, so unchanged rows keep their objects (rows are memoised on them). */
  private published: ServerStatus = { server: undefined, databases: undefined, complete: false }

  constructor(connectionId: string, live: LiveService, owner: LiveOwner, private readonly changed: () => void) {
    this.handle = live.open({ connectionId, source: 'explorer', probes: probes.map(probe => ({ probe })), background: true }, owner)
    const disposeTick = this.handle.onTick(({ subscriptionId, tick }) => {
      this.follow(subscriptionId)
      for (const sample of tick.samples) {
        if (sample.probe === 'explorer.agent') { this.jobs = sample.metrics?.[0] ?? null; continue }
        const entry = sample.tables?.find(table => table.table === 0)
        if (!entry) continue
        const probe = sample.probe as TableProbe
        // An unchanged revision needs no read: its rows are the ones already read.
        if (entry.diff && entry.diff.added + entry.diff.removed + entry.diff.changed === 0 && this.has(probe)) continue
        this.read(probe, subscriptionId)
      }
      this.update()
    })
    this.stops.push(() => disposeTick.dispose(), this.handle.subscribe(() => this.handleChanged()))
  }

  get snapshot(): ServerStatus { return this.published }
  get ended(): boolean { const status = this.handle.getSnapshot().status; return status === 'ended' || status === 'lost' }

  /** An ended view (it failed, or its connection went) is disposed at once, so it holds no slot; the service opens a new
   *  one on Refresh, or when Object Explorer shows again. */
  private handleChanged(): void {
    if (this.ended && !this.closed) { this.closed = true; this.handle.dispose() }
    this.update()
  }

  private has(probe: TableProbe): boolean {
    return probe === 'explorer.databases' ? this.databases !== undefined : probe === 'explorer.progress' ? this.progress !== undefined : this.groups !== undefined
  }

  private forget(probe: TableProbe): void {
    if (probe === 'explorer.databases') { this.databases = undefined; this.complete = false } else if (probe === 'explorer.progress') this.progress = undefined
    else this.groups = undefined
  }

  /** A new subscription (out of dormancy, after a slot came back, on another connection) starts from nothing. */
  private follow(subscriptionId: string): void {
    if (subscriptionId === this.subscriptionId) return
    this.subscriptionId = subscriptionId
    for (const probe of ['explorer.databases', 'explorer.progress', 'explorer.availability'] as const) this.forget(probe)
    this.jobs = undefined
    this.reads.clear()
  }

  private read(probe: TableProbe, subscriptionId: string): void {
    const table = this.handle.table(probe)
    if (!table) return
    const seq = ++this.readSeq
    this.reads.set(probe, seq)
    const current = () => this.reads.get(probe) === seq && this.subscriptionId === subscriptionId
    readRows(table).then(({ rows, complete }) => {
      if (!current()) return
      if (probe === 'explorer.databases') {
        this.databases = new Map(rows.filter(row => row[0] !== null).map(row => [row[0]!, { name: row[0]!, state: integer(row[1] ?? '0'), userAccess: integer(row[2] ?? '0'), readOnly: bit(row[3] ?? ''), standby: bit(row[4] ?? '') }]))
        this.complete = complete
      } else if (probe === 'explorer.progress') this.progress = new Map(rows.filter(row => row[0] !== null).map(row => [row[0]!, { name: row[0]!, command: row[1] ?? '', percent: integer(row[2] ?? '0') }]))
      else this.groups = rows.filter(row => row[0] !== null).map(row => ({ name: row[0]!, health: integer(row[1] ?? '0'), role: integer(row[2] ?? '0') }))
      this.update()
    }, () => {
      // A revision released before it was read (the view moved on two samples, or ended): the rows read before it are out
      // of date, so they go, and the next revision is read whatever its diff says.
      if (!current()) return
      this.forget(probe)
      this.update()
    })
  }

  /** Republishes what the probes that still sample say; a probe that fails, is unavailable or paused says nothing. */
  update(): void {
    const snapshot = this.handle.getSnapshot()
    const fresh = (probe: LiveProbeId) => snapshotUsable(snapshot, this.subscriptionId) && usable.has(snapshot.probes[probe]?.state ?? '')
    const previous = this.published
    const databases = fresh('explorer.databases') && this.databases ? this.databaseMap(previous.databases, fresh('explorer.progress') ? this.progress : undefined) : undefined
    const complete = !!databases && this.complete
    const chips = serverChips(fresh('explorer.agent') ? this.jobs : undefined, fresh('explorer.availability') ? this.groups : undefined)
    const server = chips.length === 0 ? undefined : previous.server && sameChips(previous.server.chips, chips) ? previous.server : statusOf(chips)
    if (server === previous.server && databases === previous.databases && complete === previous.complete) return
    this.published = { server, databases, complete }
    this.changed()
  }

  /** Each listed database's status, reusing the previous objects of databases whose chips did not change. */
  private databaseMap(previous: ReadonlyMap<string, RowStatus> | undefined, progress: Map<string, ProgressRow> | undefined): ReadonlyMap<string, RowStatus> {
    const next = new Map<string, RowStatus>()
    let same = !!previous
    for (const row of this.databases!.values()) {
      const chips = databaseChips(row, progress?.get(row.name)), state = stateOf(row)
      const before = previous?.get(row.name)
      const status = before && before.state === state && sameChips(before.chips, chips) ? before : statusOf(chips, state)
      if (status !== before) same = false
      next.set(row.name, status)
    }
    return same && previous!.size === next.size ? previous! : next
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.closed = true
    this.handle.dispose()
  }
}

/** A row's live status: a server's chips, or a database's (online when a complete list does not name it). The objects are
 *  the service's own and stay the same while the chips do, so memoised rows render again only when theirs change. */
export function rowStatus(server: ServerStatus | undefined, node: Pick<TreeNode, 'parent' | 'kind' | 'ref'>): RowStatus | undefined {
  if (!server) return undefined
  if (node.parent === 0) return server.server
  if (node.kind !== 'database' || node.ref.type !== 'object' || !server.databases) return undefined
  return server.databases.get(node.ref.object.name ?? '') ?? (server.complete ? onlineStatus : undefined)
}

/** Samples count only while the view runs the subscription they came from. */
function snapshotUsable(snapshot: LiveSnapshot, subscriptionId: string | undefined): boolean {
  return (snapshot.status === 'live' || snapshot.status === 'paused') && !!subscriptionId && snapshot.subscriptionId === subscriptionId
}

export class ExplorerStatusService extends SnapshotStore<ExplorerStatusSnapshot> implements Disposable {
  /** The views by statusKey. */
  private readonly views = new Map<string, ServerView>()
  private readonly stops: (() => void)[] = []
  private readonly visibility: StatusVisibility
  private shown: boolean
  private queued = false
  private disposed = false

  constructor(private readonly o: {
    live: LiveService
    connections: Pick<ConnectionService, 'getSnapshot' | 'subscribe'>
    panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
    settings: LiveSettingsSource
    /** Whether the tree can be seen; the explorer pane by default. */
    visibility?: StatusVisibility
    /** Coalesces publications: an animation frame in the app. */
    schedule?: (callback: () => void) => void
  }) {
    super({ servers: new Map() })
    this.visibility = o.visibility ?? { get: () => o.panes.getSnapshot().explorer, subscribe: listener => o.panes.subscribe(listener) }
    this.shown = this.visibility.get()
    this.stops.push(o.connections.subscribe(() => this.sync()), o.settings.subscribe(() => this.sync()), this.visibility.subscribe(() => this.visibilityChanged()))
    this.sync()
  }

  private get enabled(): boolean { return this.o.settings.getSnapshot().values['liveData.explorerStatus'] }

  /** A connection's status, or undefined while it has none. */
  server(connectionId: string): ServerStatus | undefined { return this.getSnapshot().servers.get(connectionId) }

  /** Object Explorer's Refresh: the connection's view (every view, with none named) samples at once, and one that ended
   *  (a sign-in that failed, every probe refused) is opened again. */
  refresh(connectionId?: string): void {
    const key = connectionId === undefined ? undefined : this.wanted().get(connectionId)
    if (connectionId !== undefined && key === undefined) return
    let reopen = false
    for (const [viewKey, view] of [...this.views]) {
      if (key !== undefined && viewKey !== key) continue
      if (view.ended) { view.dispose(); this.views.delete(viewKey); reopen = true } else view.handle.refresh()
    }
    if (reopen) this.sync()
  }

  /** The connections that want a view, by id, with their statusKey: every connection that is not lost, while the setting
   *  is on. */
  private wanted(): Map<string, string> {
    return new Map(this.enabled ? this.o.connections.getSnapshot().filter(connection => !connection.lost).map(connection => [connection.id, statusKey(connection)]) : [])
  }

  /** The live connections a view serves, oldest first: the first is the one it reads through. */
  private members(key: string): string[] {
    return [...this.wanted()].filter(([, other]) => other === key).map(([id]) => id)
  }

  /** Opens a view for every connected server and login (while the setting is on) and ends the others. A server connected
   *  while Object Explorer is hidden gets its view when the tree shows, so it runs no SQL before anyone can see it. */
  private sync(): void {
    if (this.disposed) return
    const keys = new Set(this.wanted().values())
    for (const [key, view] of [...this.views]) {
      if (keys.has(key)) continue
      this.views.delete(key)
      view.dispose()
    }
    if (this.visibility.get()) {
      for (const key of keys) {
        if (this.views.has(key)) continue
        const first = this.members(key)[0]
        if (first !== undefined) this.views.set(key, new ServerView(first, this.o.live, this.owner(key, first), () => this.changed()))
      }
    }
    this.changed()
  }

  /** Shown again: a view that ended gets one more try. */
  private visibilityChanged(): void {
    const shown = this.visibility.get()
    if (shown === this.shown) return
    this.shown = shown
    if (!shown) return
    for (const [key, view] of [...this.views]) {
      if (!view.ended) continue
      view.dispose()
      this.views.delete(key)
    }
    this.sync()
  }

  /** The view of a key, named after the connection it opened on (the key holds the login). */
  private owner(key: string, first: string): LiveOwner {
    const { connections } = this.o
    return {
      key: 'explorer:' + first,
      visible: () => this.visibility.get(),
      // The oldest live connection of the key: when it goes, the view moves to the next, as after a Reconnect.
      connectionId: () => this.members(key)[0],
      closed: () => this.members(key).length === 0,
      subscribe: listener => {
        const stopVisibility = this.visibility.subscribe(listener), stopConnections = connections.subscribe(listener)
        return () => { stopVisibility(); stopConnections() }
      }
    }
  }

  private changed(): void {
    if (this.queued || this.disposed) return
    this.queued = true
    const run = () => {
      this.queued = false
      if (this.disposed) return
      const servers = new Map<string, ServerStatus>()
      for (const [id, key] of this.wanted()) {
        const view = this.views.get(key)
        if (view) servers.set(id, view.snapshot)
      }
      this.publish({ servers })
    }
    try { (this.o.schedule ?? queueMicrotask)(run) } catch (error) { this.queued = false; onUnexpectedError(error) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops.splice(0)) stop()
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.clearListeners()
  }
}
