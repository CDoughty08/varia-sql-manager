// Object Explorer's live status chips (docs/object-explorer.md, Live status): one background live view of the `explorer`
// source per connected server while Object Explorer shows. The backend samples; this service reads each new table
// revision's few rows (only databases that are not plainly online and open, running restores, availability groups),
// turns them into chips (src/shared/explorer/status.ts) and publishes them by server and database. It never reloads the
// tree, and never samples by itself: LiveService pauses the views while the pane or the window is hidden.
import { statusChipKinds } from '../../../shared/explorer/catalog'
import { databaseChips, serverChips, type DatabaseStatusRow, type GroupRow, type ProgressRow, type StatusChip } from '../../../shared/explorer/status'
import type { LiveProbeId } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { LiveHandle, LiveOwner, LiveService, LiveSettingsSource, LiveSnapshot, LiveTable } from '../live/LiveService'
import type { ConnectionService } from '../services/connections'
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
  readonly connectionId: string
  /** The server row's chips (running Agent jobs, availability group health); undefined while none are known. */
  readonly server: RowStatus | undefined
  /** Database rows' status by name, while the database probe samples (`live`); undefined otherwise. */
  readonly databases: ReadonlyMap<string, RowStatus> | undefined
}
export interface ExplorerStatusSnapshot { readonly servers: ReadonlyMap<string, ServerStatus> }

const probes = [...statusChipKinds.database, ...statusChipKinds.server] as LiveProbeId[]
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

/** Reads a status table's rows as cell texts (null for NULL). */
async function readRows(table: LiveTable): Promise<(string | null)[][]> {
  const columns = table.descriptor.columns.length, count = Math.min(maxRows, table.descriptor.rowsAvailable)
  if (count === 0) return []
  const window = await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns })
  return Array.from({ length: window.count }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const at = row * columns + column
    return window.flags[at] & 1 ? null : window.text[at]
  }))
}

/** One server's view and what it last read. */
class ServerView {
  readonly handle: LiveHandle
  private subscriptionId: string | undefined
  private databases: Map<string, DatabaseStatusRow> | undefined
  private progress: Map<string, ProgressRow> | undefined
  private groups: GroupRow[] | undefined
  private jobs: number | null | undefined
  /** The newest read per probe: an older read that finishes later is dropped. */
  private readonly reads = new Map<LiveProbeId, number>()
  private readSeq = 0
  private readonly stops: (() => void)[] = []
  private closed = false
  /** What was published last, so unchanged rows keep their objects (rows are memoised on them). */
  private published: ServerStatus

  constructor(readonly connectionId: string, live: LiveService, owner: LiveOwner, private readonly changed: () => void) {
    this.published = { connectionId, server: undefined, databases: undefined }
    this.handle = live.open({ connectionId, source: 'explorer', probes: probes.map(probe => ({ probe })), background: true }, owner)
    const disposeTick = this.handle.onTick(({ subscriptionId, tick }) => {
      this.follow(subscriptionId)
      for (const sample of tick.samples) {
        if (sample.probe === 'explorer.agent') { this.jobs = sample.metrics?.[0] ?? null; continue }
        const entry = sample.tables?.find(table => table.table === 0)
        if (!entry) continue
        // An unchanged revision needs no read: its rows are the ones already read.
        if (entry.diff && entry.diff.added + entry.diff.removed + entry.diff.changed === 0 && this.has(sample.probe)) continue
        this.read(sample.probe, subscriptionId)
      }
      this.update()
    })
    this.stops.push(() => disposeTick.dispose(), this.handle.subscribe(() => this.handleChanged()))
  }

  get snapshot(): ServerStatus { return this.published }
  get ended(): boolean { const status = this.handle.getSnapshot().status; return status === 'ended' || status === 'lost' }

  /** An ended view (the server refused it, or it failed) is disposed at once, so it holds no slot; the service opens a new
   *  one when Object Explorer shows again. */
  private handleChanged(): void {
    if (this.ended && !this.closed) { this.closed = true; this.handle.dispose() }
    this.update()
  }

  private has(probe: LiveProbeId): boolean {
    return probe === 'explorer.databases' ? this.databases !== undefined : probe === 'explorer.progress' ? this.progress !== undefined : this.groups !== undefined
  }

  /** A new subscription (out of dormancy, after a slot came back) starts from nothing. */
  private follow(subscriptionId: string): void {
    if (subscriptionId === this.subscriptionId) return
    this.subscriptionId = subscriptionId
    this.databases = this.progress = this.groups = undefined
    this.jobs = undefined
    this.reads.clear()
  }

  private read(probe: LiveProbeId, subscriptionId: string): void {
    const table = this.handle.table(probe)
    if (!table) return
    const seq = ++this.readSeq
    this.reads.set(probe, seq)
    readRows(table).then(rows => {
      if (this.reads.get(probe) !== seq || this.subscriptionId !== subscriptionId) return
      if (probe === 'explorer.databases') this.databases = new Map(rows.filter(row => row[0] !== null).map(row => [row[0]!, { name: row[0]!, state: integer(row[1] ?? '0'), userAccess: integer(row[2] ?? '0'), readOnly: bit(row[3] ?? ''), standby: bit(row[4] ?? '') }]))
      else if (probe === 'explorer.progress') this.progress = new Map(rows.filter(row => row[0] !== null).map(row => [row[0]!, { name: row[0]!, command: row[1] ?? '', percent: integer(row[2] ?? '0') }]))
      else this.groups = rows.filter(row => row[0] !== null).map(row => ({ name: row[0]!, health: integer(row[1] ?? '0'), role: integer(row[2] ?? '0') }))
      this.update()
    }, () => {
      // A revision released before it was read (the view moved on, or ended): the next one is read instead.
    })
  }

  /** Republishes what the probes that still sample say; a probe that fails, is unavailable or paused says nothing. */
  update(): void {
    const snapshot = this.handle.getSnapshot()
    const fresh = (probe: LiveProbeId) => snapshotUsable(snapshot, this.subscriptionId) && usable.has(snapshot.probes[probe]?.state ?? '')
    const previous = this.published
    const databases = fresh('explorer.databases') && this.databases ? this.databaseMap(previous.databases, fresh('explorer.progress') ? this.progress : undefined) : undefined
    const chips = serverChips(fresh('explorer.agent') ? this.jobs : undefined, fresh('explorer.availability') ? this.groups : undefined)
    const server = chips.length === 0 ? undefined : previous.server && sameChips(previous.server.chips, chips) ? previous.server : statusOf(chips)
    if (server === previous.server && databases === previous.databases) return
    this.published = { connectionId: this.connectionId, server, databases }
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

/** A row's live status: a server's chips, or a database's (online when the probe does not list it). The objects are the
 *  service's own and stay the same while the chips do, so memoised rows render again only when theirs change. */
export function rowStatus(server: ServerStatus | undefined, node: Pick<TreeNode, 'parent' | 'kind' | 'ref'>): RowStatus | undefined {
  if (!server) return undefined
  if (node.parent === 0) return server.server
  if (node.kind !== 'database' || node.ref.type !== 'object' || !server.databases) return undefined
  return server.databases.get(node.ref.object.name ?? '') ?? onlineStatus
}

/** Samples count only while the view runs the subscription they came from. */
function snapshotUsable(snapshot: LiveSnapshot, subscriptionId: string | undefined): boolean {
  return (snapshot.status === 'live' || snapshot.status === 'paused') && !!subscriptionId && snapshot.subscriptionId === subscriptionId
}

export class ExplorerStatusService extends SnapshotStore<ExplorerStatusSnapshot> implements Disposable {
  private readonly views = new Map<string, ServerView>()
  private readonly stops: (() => void)[] = []
  private shown: boolean
  private queued = false
  private disposed = false

  constructor(private readonly o: {
    live: LiveService
    connections: Pick<ConnectionService, 'getSnapshot' | 'subscribe' | 'get' | 'isLive'>
    panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
    settings: LiveSettingsSource
    /** Coalesces publications: an animation frame in the app. */
    schedule?: (callback: () => void) => void
  }) {
    super({ servers: new Map() })
    this.shown = o.panes.getSnapshot().explorer
    this.stops.push(o.connections.subscribe(() => this.sync()), o.settings.subscribe(() => this.sync()), o.panes.subscribe(() => this.panesChanged()))
    this.sync()
  }

  private get enabled(): boolean { return this.o.settings.getSnapshot().values['liveData.explorerStatus'] }

  /** A server's status, or undefined while it has none. */
  server(connectionId: string): ServerStatus | undefined { return this.getSnapshot().servers.get(connectionId) }

  /** Object Explorer's Refresh: the server's chips (every server's, with none named) sample at once too. */
  refresh(connectionId?: string): void {
    for (const [id, view] of this.views) if (connectionId === undefined || id === connectionId) view.handle.refresh()
  }

  /** Opens a view for every connected server (while the setting is on) and ends the others. A server connected while
   *  Object Explorer is hidden gets its view when the pane shows, so it runs no SQL before anyone can see it. */
  private sync(): void {
    if (this.disposed) return
    const wanted = new Set(this.enabled ? this.o.connections.getSnapshot().filter(connection => !connection.lost).map(connection => connection.id) : [])
    for (const [id, view] of [...this.views]) {
      if (wanted.has(id)) continue
      this.views.delete(id)
      view.dispose()
    }
    if (this.o.panes.getSnapshot().explorer) for (const id of wanted) if (!this.views.has(id)) this.views.set(id, new ServerView(id, this.o.live, this.owner(id), () => this.changed()))
    this.changed()
  }

  /** Shown again: a view that ended (the server refused it, or it failed) gets one more try. */
  private panesChanged(): void {
    const shown = this.o.panes.getSnapshot().explorer
    if (shown === this.shown) return
    this.shown = shown
    if (!shown) return
    for (const [id, view] of [...this.views]) {
      if (!view.ended) continue
      view.dispose()
      this.views.delete(id)
    }
    this.sync()
  }

  private owner(connectionId: string): LiveOwner {
    const { connections, panes } = this.o
    return {
      key: 'explorer:' + connectionId,
      visible: () => panes.getSnapshot().explorer,
      connectionId: () => connections.isLive(connectionId) ? connectionId : undefined,
      closed: () => !connections.get(connectionId),
      subscribe: listener => {
        const stopPanes = panes.subscribe(listener), stopConnections = connections.subscribe(listener)
        return () => { stopPanes(); stopConnections() }
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
      for (const [id, view] of this.views) servers.set(id, view.snapshot)
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
