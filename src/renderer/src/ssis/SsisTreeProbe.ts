// The SSIS Catalog's live tree (D-ssis 6.1): while a connection's SSISDB node is open and shown in Object Explorer, one
// `ssis.catalogProbe` view per connection fingerprints the catalog, and a fingerprint that changed reconciles only the
// expanded or listed nodes that show that view, in the background, keeping expansion and selection. The first sample of
// a connection is a baseline, unless it came late (see `late`); a later view of the same connection (the node closed and
// opened again, a pause, a new subscription) compares with the last fingerprints seen, so what changed meanwhile still
// reloads. The probe pauses with Object Explorer (the view's owner) and the window, as every live view does, and nothing
// here polls. A view that ends is opened again after a growing back-off (the server or the window had no room for it, the
// backend restarted it), unless it ended for good (`catalogProbeFinalCodes`: no access, a refused sign-in, a catalog
// without what the probe reads): SSISDB then says why, and a Refresh of SSISDB or above tries again.
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { LiveTick } from '../../../shared/live/schema'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { catalogFingerprints, catalogProbeFinalCodes, catalogProbeRetryMs, type CatalogFingerprint } from '../../../shared/ssis/catalog'
import { onUnexpectedError } from '../core/errors'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, WorkbenchEvent } from '../core/types'
import type { ExplorerService, NodeNote, ReconcileOptions, TreeNode } from '../explorer/ExplorerService'
import type { LiveHandle, LiveOwner, LiveService } from '../live/LiveService'

const probe: LiveProbeId = 'ssis.catalogProbe'
const background: ReconcileOptions = { background: true }
const finalCodes: ReadonlySet<string> = new Set(catalogProbeFinalCodes)

/** Whether a catalog's row shows in Object Explorer: every node above it, up to its server, is expanded. */
export function shownInExplorer(explorer: Pick<ExplorerService, 'node'>, catalog: TreeNode): boolean {
  for (let node = explorer.node(catalog.parent); node; node = node.parent ? explorer.node(node.parent) : undefined) if (!node.expanded) return false
  return true
}

export interface SsisTreeProbeOptions {
  readonly explorer: Pick<ExplorerService, 'getSnapshot' | 'subscribe' | 'rootIds' | 'node' | 'reconcile' | 'setNote'>
  readonly live: Pick<LiveService, 'open'>
  /** Whether Object Explorer shows: the views pause while it does not. */
  readonly explorerVisible: { visible(): boolean; subscribe(listener: () => void): () => void }
  /**
   * Whether an open SSISDB row shows, so its connection's view runs: `shownInExplorer` by default. A container that shows
   * the same ExplorerService tree scoped to the catalogs (F7's Integration Services) passes one that is true while either
   * shows the row, and an `explorerVisible` that is true while either is visible. It is asked on every change of the tree.
   */
  readonly shown?: (catalog: TreeNode) => boolean
  readonly settings: { getSnapshot(): { readonly values: SettingsValues }; subscribe(listener: () => void): () => void }
  /** The user's refreshes: one of SSISDB, of anything in it or of a node above it opens a view that stopped again. */
  readonly events: { subscribe(listener: (event: WorkbenchEvent) => void): Disposable }
  readonly timers?: Timers
}

interface View { readonly handle: LiveHandle; readonly ticks: Disposable; readonly stopStatus: () => void }
/** A connection whose view ended: when it opens again (after `timer`), or why it will not (`final`). */
interface Stopped { attempts: number; timer: unknown; final?: NodeNote }

export class SsisTreeProbe implements Disposable {
  private readonly views = new Map<string, View>()
  /** The last fingerprints seen per connection (status id → value), kept while its server stays in the tree. */
  private readonly seen = new Map<string, ReadonlyMap<string, number | string>>()
  private readonly stopped = new Map<string, Stopped>()
  /**
   * Connections whose first sample may come long after the listings it would be the baseline of: SSISDB was listed before
   * its view opened (a view refused or ended and opened again, live updates turned on while browsing), or the view failed
   * or paused before it sampled. What changed in between would never reload, so that sample reloads SSISDB deeply instead.
   */
  private readonly late = new Set<string>()
  /** Nodes to reload whose listing, or one above or below them, was on its way when a change was seen: it may predate the change. */
  private readonly settling = new Map<number, ReconcileOptions>()
  private readonly stops: (() => void)[]
  private readonly timers: Timers
  private values: SettingsValues
  private syncing = false
  private again = false
  private disposed = false

  constructor(private readonly o: SsisTreeProbeOptions) {
    this.values = o.settings.getSnapshot().values
    this.timers = o.timers ?? browserTimers
    const events = o.events.subscribe(event => this.guard(() => { if (event.type === 'explorer.refreshed') this.refreshed(event.connectionId, event.nodeId) }))
    this.stops = [
      o.explorer.subscribe(() => this.guard(() => { this.sync(); this.settled() })),
      o.settings.subscribe(() => this.guard(() => this.settingsChanged())),
      () => events.dispose()
    ]
    this.sync()
  }

  /** Connections with a view open (test mode and the checks). */
  get connections(): readonly string[] { return [...this.views.keys()] }
  handle(connectionId: string): LiveHandle | undefined { return this.views.get(connectionId)?.handle }
  /**
   * The last fingerprints seen on a connection (status id → value, `catalogFingerprintStatus`'s ids) while its server stays
   * in the tree, and `handle(connectionId)` the view that samples them. That view runs only while the tree needs it: SSISDB
   * open and shown, `integrationServices.treeLive` on, and it pauses while Object Explorer hides. A document that shows what
   * a fingerprint covers (references, parameters, catalog properties) may read the last values here when it opens, but must
   * hold its own LiveService view of `ssis.catalog`, owned by the document, to follow changes while it shows.
   */
  fingerprints(connectionId: string): ReadonlyMap<string, number | string> | undefined { return this.seen.get(connectionId) }

  /**
   * Reloads what shows these fingerprints on a connection, now: after Varia's own change to the catalog (a later PR's
   * writes), so the tree need not wait for the next sample. The connection's view samples at once too, so the fingerprints
   * after the change become the ones it compares with. That sample still differs from the ones seen before the change, so
   * it reloads the same nodes once more: a reload still listing starts again, and one that finds nothing new announces nothing.
   */
  reload(connectionId: string, fingerprints: readonly CatalogFingerprint[]): void {
    this.reconcileFor(connectionId, fingerprints)
    this.views.get(connectionId)?.handle.refresh()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const connectionId of [...this.views.keys()]) this.close(connectionId)
    for (const connectionId of [...this.stopped.keys()]) this.forget(connectionId)
    this.seen.clear()
    this.late.clear()
    this.settling.clear()
  }

  /** Reconciles, in the background, the listed nodes on a connection that show these fingerprints. */
  private reconcileFor(connectionId: string, fingerprints: readonly CatalogFingerprint[]): void {
    const kinds = new Set<string>(fingerprints.flatMap(fingerprint => fingerprint.reloads.kinds ?? []))
    const folders = new Set<string>(fingerprints.flatMap(fingerprint => fingerprint.reloads.folders ?? []))
    if (!kinds.size && !folders.size) return
    // A node whose listing is on its way (its first, the user's Refresh, an earlier reload), or one above or below it, may
    // have read the catalog before the change: it reconciles once they all settle. Reconciling it now would restart the
    // user's own load behind the background ones, or one below a Refresh, shallower than that Refresh asked for.
    const reload = (node: TreeNode, options: ReconcileOptions): void => {
      if (this.busy(node)) {
        const waiting = this.settling.get(node.id)
        this.settling.set(node.id, waiting?.deep ? waiting : options)
      } else if (node.children !== undefined) this.o.explorer.reconcile(node.id, options)
    }
    for (const catalog of this.catalogs(connectionId)) {
      // One reconcile per subtree: a node to reload above another reloads deeply, which covers the one below.
      if (kinds.has(catalog.kind)) { reload(catalog, { ...background, deep: true }); continue }
      const visit = (node: TreeNode): void => {
        for (const child of node.children ?? []) {
          if (child.kind === 'folder' && !!child.folder && folders.has(child.folder)) {
            const deep = [...folders].some(other => other !== child.folder && this.below(child, other))
            reload(child, deep ? { ...background, deep } : background)
          } else if (kinds.has(child.kind)) reload(child, { ...background, deep: true })
          else visit(child)
        }
      }
      visit(catalog)
    }
  }

  /** Whether a first page of the node, of a node above it or of a listed node below it is on its way. */
  private busy(node: TreeNode): boolean {
    for (let above = this.o.explorer.node(node.parent); above; above = above.parent ? this.o.explorer.node(above.parent) : undefined) if (above.load === 'loading') return true
    const within = (current: TreeNode): boolean => current.load === 'loading' || (current.children ?? []).some(within)
    return within(node)
  }

  /** Reconciles the nodes waiting for listings that have now settled; one that stopped or failed lists afresh anyway. */
  private settled(): void {
    for (const [id, options] of [...this.settling]) {
      const node = this.o.explorer.node(id)
      if (node && this.busy(node)) continue
      this.settling.delete(id)
      if (node?.load === 'loaded') this.o.explorer.reconcile(id, options)
    }
  }

  private guard(work: () => void): void {
    if (this.disposed) return
    try { work() } catch (error) { onUnexpectedError(error) }
  }

  private get enabled(): boolean { return this.values['integrationServices.treeLive'] }
  private get intervalMs(): number { return this.values['integrationServices.treeRefreshSeconds'] * 1000 }

  private settingsChanged(): void {
    const before = this.values
    this.values = this.o.settings.getSnapshot().values
    if (before['integrationServices.treeRefreshSeconds'] !== this.values['integrationServices.treeRefreshSeconds'])
      for (const view of this.views.values()) view.handle.setProbe(probe, { intervalMs: this.intervalMs })
    if (before['integrationServices.treeLive'] !== this.values['integrationServices.treeLive']) this.sync()
  }

  /** Opens a view for each connection with an open SSISDB node that shows, and closes the others. A sync that notes or
   *  opens something can cause another (the tree changed): it runs after this one rather than inside it. */
  private sync(): void {
    if (this.syncing) { this.again = true; return }
    this.syncing = true
    try {
      do { this.again = false; this.syncOnce() } while (this.again && !this.disposed)
    } finally { this.syncing = false }
  }

  private syncOnce(): void {
    const servers = new Set<string>()
    const open = new Set<string>()
    for (const id of this.o.explorer.rootIds) {
      const root = this.o.explorer.node(id)
      if (!root || root.lost) continue
      servers.add(root.connectionId)
      if (this.enabled && this.catalogs(root.connectionId, root).some(catalog => this.shown(catalog) && (catalog.expanded || (catalog.load === 'loaded' && catalog.children?.length === 0)))) open.add(root.connectionId)
    }
    for (const connectionId of [...this.views.keys()]) if (!open.has(connectionId)) this.close(connectionId)
    // A connection whose SSISDB closed or hid waits for nothing: opening it again tries at once.
    for (const connectionId of [...this.stopped.keys()]) if (!open.has(connectionId)) this.forget(connectionId)
    for (const connectionId of [...this.seen.keys()]) if (!servers.has(connectionId)) this.seen.delete(connectionId)
    for (const connectionId of [...this.late]) if (!servers.has(connectionId)) this.late.delete(connectionId)
    for (const connectionId of open) {
      const stopped = this.stopped.get(connectionId)
      if (stopped?.final) this.note(connectionId, stopped.final)
      else if (!this.views.has(connectionId) && stopped?.timer === undefined) this.open(connectionId)
    }
  }

  private shown(catalog: TreeNode): boolean { return this.o.shown ? this.o.shown(catalog) : shownInExplorer(this.o.explorer, catalog) }

  private open(connectionId: string): void {
    if (!this.seen.has(connectionId) && this.catalogs(connectionId).some(catalog => catalog.children !== undefined)) this.late.add(connectionId)
    const owner: LiveOwner = {
      key: 'explorer:ssis:' + connectionId,
      visible: () => this.o.explorerVisible.visible(),
      // A server that left the tree, or lost its backend, ends the view; closing the SSISDB node disposes it here.
      connectionId: () => this.o.explorer.rootIds.some(id => { const root = this.o.explorer.node(id); return root?.connectionId === connectionId && !root.lost }) ? connectionId : undefined,
      subscribe: listener => {
        const stopVisible = this.o.explorerVisible.subscribe(listener), stopExplorer = this.o.explorer.subscribe(listener)
        return () => { stopVisible(); stopExplorer() }
      }
    }
    const handle = this.o.live.open({ connectionId, source: 'ssis.catalog', probes: [{ probe, intervalMs: this.intervalMs }] }, owner)
    const ticks = handle.onTick(({ tick }) => this.guard(() => this.applied(connectionId, tick)))
    const view: View = { handle, ticks, stopStatus: handle.subscribe(() => this.guard(() => this.statusChanged(connectionId, view))) }
    this.views.set(connectionId, view)
    // LiveService answers a view it has no room for (too many in this window) as one that has already ended.
    this.statusChanged(connectionId, view)
  }

  private close(connectionId: string): void {
    const view = this.views.get(connectionId)
    if (!view) return
    this.views.delete(connectionId)
    view.stopStatus()
    view.ticks.dispose()
    view.handle.dispose()
  }

  /** A view ended or was lost: it opens again after the back-off or, ended for good, SSISDB says why. */
  private statusChanged(connectionId: string, view: View): void {
    if (this.views.get(connectionId) !== view) return
    const snapshot = view.handle.getSnapshot()
    if ((snapshot.status === 'paused' || snapshot.status === 'dormant') && !this.seen.has(connectionId)) this.late.add(connectionId)
    if (snapshot.status !== 'ended' && snapshot.status !== 'lost') return
    this.close(connectionId)
    const stopped = this.stopped.get(connectionId) ?? { attempts: 0, timer: undefined }
    this.stopped.set(connectionId, stopped)
    const code = snapshot.error?.code ?? snapshot.ended?.code
    if (code && finalCodes.has(code)) {
      const reason = snapshot.error?.message ?? snapshot.ended?.message ?? 'The SSIS Catalog could not be read.'
      stopped.final = { label: '(not updating)', sentence: 'Live updates stopped. ' + reason + ' Refresh SSISDB to try again.' }
    } else {
      const delay = Math.min(catalogProbeRetryMs.max, catalogProbeRetryMs.first * 2 ** Math.min(stopped.attempts, 16))
      stopped.attempts++
      stopped.timer = this.timers.setTimeout(() => this.guard(() => { stopped.timer = undefined; this.sync() }), delay)
    }
    this.sync()
  }

  /** The user refreshed a node: SSISDB, something in it or a node above it tries a view that stopped again, at once. */
  private refreshed(connectionId: string, nodeId: number): void {
    if (!this.stopped.has(connectionId)) return
    const node = this.o.explorer.node(nodeId)
    if (!node || node.connectionId !== connectionId) return
    let related = node.parent === 0 || (node.kind === 'folder' && node.folder === 'integrationServicesCatalogs')
    for (let current: TreeNode | undefined = node; current && !related; current = current.parent ? this.o.explorer.node(current.parent) : undefined) related = current.kind === 'ssisCatalog'
    if (!related) return
    this.forget(connectionId)
    this.sync()
  }

  /** Drops a stopped connection's back-off and note. */
  private forget(connectionId: string): void {
    const stopped = this.stopped.get(connectionId)
    if (!stopped) return
    this.stopped.delete(connectionId)
    if (stopped.timer !== undefined) this.timers.clearTimeout(stopped.timer)
    if (stopped.final) this.note(connectionId, undefined)
  }

  private note(connectionId: string, note: NodeNote | undefined): void {
    for (const catalog of this.catalogs(connectionId)) this.o.explorer.setNote(catalog.id, note)
  }

  private applied(connectionId: string, tick: LiveTick): void {
    // The catalog is gone (dropped elsewhere): its server's Integration Services Catalogs folder lists it no longer.
    if (tick.errors?.some(error => error.probe === probe && error.code === 'CATALOG_MISSING')) {
      this.seen.delete(connectionId)
      for (const folder of this.catalogsFolders(connectionId)) this.o.explorer.reconcile(folder.id, background)
      return
    }
    const status = tick.samples.find(sample => sample.probe === probe)?.status
    if (!status) {
      if (!this.seen.has(connectionId)) this.late.add(connectionId)
      return
    }
    // A view that samples has room: its next end starts the back-off over.
    this.stopped.delete(connectionId)
    const next = new Map(status.map(value => [value.id, value.value]))
    const previous = this.seen.get(connectionId)
    this.seen.set(connectionId, next)
    if (!previous) {
      if (this.late.delete(connectionId)) this.reconcileFor(connectionId, catalogFingerprints)
      return
    }
    const changed = catalogFingerprints.filter(fingerprint => [fingerprint.id + 'Count', fingerprint.id + 'Checksum'].some(id => previous.get(id) !== next.get(id)))
    if (changed.length) this.reconcileFor(connectionId, changed)
  }

  /** The connection's Integration Services Catalogs folders (one per server node). */
  private catalogsFolders(connectionId: string): TreeNode[] {
    const folders: TreeNode[] = []
    for (const id of this.o.explorer.rootIds) {
      const root = this.o.explorer.node(id)
      if (root?.connectionId !== connectionId) continue
      for (const child of root.children ?? []) if (child.kind === 'folder' && child.folder === 'integrationServicesCatalogs') folders.push(child)
    }
    return folders
  }

  /** The SSISDB nodes listed below a connection's server. */
  private catalogs(connectionId: string, root?: TreeNode): TreeNode[] {
    const folders = root ? (root.children ?? []).filter(child => child.kind === 'folder' && child.folder === 'integrationServicesCatalogs') : this.catalogsFolders(connectionId)
    return folders.flatMap(folder => (folder.children ?? []).filter(child => child.kind === 'ssisCatalog'))
  }

  /** Whether a listed folder of this id lies below the node. */
  private below(node: TreeNode, folder: string): boolean {
    for (const child of node.children ?? []) {
      if (child.children === undefined) continue
      if (child.kind === 'folder' && child.folder === folder) return true
      if (this.below(child, folder)) return true
    }
    return false
  }
}
