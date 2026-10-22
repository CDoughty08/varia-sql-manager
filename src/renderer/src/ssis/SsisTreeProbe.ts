// The SSIS Catalog's live tree (D-ssis 6.1): while a connection's SSISDB node is open in Object Explorer, one
// `ssis.catalogProbe` view per connection fingerprints the catalog, and a fingerprint that changed reconciles only the
// expanded or listed nodes that show that view, in the background, keeping expansion and selection. The first sample of
// a connection is a baseline; a later view of the same connection (the node closed and opened again, a pause, a new
// subscription) compares with the last fingerprints seen, so what changed meanwhile still reloads. The probe pauses with
// Object Explorer (the view's owner) and the window, as every live view does, and nothing here polls.
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { LiveTick } from '../../../shared/live/schema'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { catalogFingerprints, type CatalogFingerprint } from '../../../shared/ssis/catalog'
import { onUnexpectedError } from '../core/errors'
import type { Disposable } from '../core/types'
import type { ExplorerService, ReconcileOptions, TreeNode } from '../explorer/ExplorerService'
import type { LiveHandle, LiveOwner, LiveService } from '../live/LiveService'

const probe: LiveProbeId = 'ssis.catalogProbe'
const background: ReconcileOptions = { background: true }

export interface SsisTreeProbeOptions {
  readonly explorer: Pick<ExplorerService, 'getSnapshot' | 'subscribe' | 'rootIds' | 'node' | 'reconcile'>
  readonly live: Pick<LiveService, 'open'>
  /** Whether Object Explorer shows: the views pause while it does not. */
  readonly explorerVisible: { visible(): boolean; subscribe(listener: () => void): () => void }
  readonly settings: { getSnapshot(): { readonly values: SettingsValues }; subscribe(listener: () => void): () => void }
}

interface View { readonly handle: LiveHandle; readonly ticks: Disposable }

export class SsisTreeProbe implements Disposable {
  private readonly views = new Map<string, View>()
  /** The last fingerprints seen per connection (status id → value), kept while its server stays in the tree. */
  private readonly seen = new Map<string, ReadonlyMap<string, number | string>>()
  private readonly stops: (() => void)[]
  private values: SettingsValues
  private disposed = false

  constructor(private readonly o: SsisTreeProbeOptions) {
    this.values = o.settings.getSnapshot().values
    this.stops = [
      o.explorer.subscribe(() => this.guard(() => this.sync())),
      o.settings.subscribe(() => this.guard(() => this.settingsChanged()))
    ]
    this.sync()
  }

  /** Connections with a view open (test mode and the checks). */
  get connections(): readonly string[] { return [...this.views.keys()] }
  handle(connectionId: string): LiveHandle | undefined { return this.views.get(connectionId)?.handle }

  /**
   * Reloads what shows these fingerprints on a connection, now: after Varia's own change to the catalog (a later PR's
   * writes), so the tree need not wait for the next sample. The probe's next sample then finds the same fingerprints
   * again only if nothing else changed.
   */
  reload(connectionId: string, fingerprints: readonly CatalogFingerprint[]): void {
    const kinds = new Set<string>(fingerprints.flatMap(fingerprint => fingerprint.reloads.kinds ?? []))
    const folders = new Set<string>(fingerprints.flatMap(fingerprint => fingerprint.reloads.folders ?? []))
    if (!kinds.size && !folders.size) return
    for (const catalog of this.catalogs(connectionId)) {
      if (catalog.children === undefined) continue
      // One reconcile per subtree: a node to reload above another reloads deeply, which covers the one below.
      if (kinds.has(catalog.kind)) { this.o.explorer.reconcile(catalog.id, { ...background, deep: true }); continue }
      const visit = (node: TreeNode): void => {
        for (const child of node.children ?? []) {
          if (child.children === undefined) continue
          if (child.kind === 'folder' && child.folder && folders.has(child.folder)) {
            const deep = [...folders].some(folder => folder !== child.folder && this.below(child, folder))
            this.o.explorer.reconcile(child.id, deep ? { ...background, deep } : background)
          } else if (kinds.has(child.kind)) this.o.explorer.reconcile(child.id, { ...background, deep: true })
          else visit(child)
        }
      }
      visit(catalog)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const connectionId of [...this.views.keys()]) this.close(connectionId)
    this.seen.clear()
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

  /** Opens a view for each connection with an open SSISDB node, and closes the others. */
  private sync(): void {
    const servers = new Set<string>()
    const open = new Set<string>()
    for (const id of this.o.explorer.rootIds) {
      const root = this.o.explorer.node(id)
      if (!root || root.lost) continue
      servers.add(root.connectionId)
      if (this.enabled && this.catalogs(root.connectionId, root).some(catalog => catalog.expanded || (catalog.load === 'loaded' && catalog.children?.length === 0))) open.add(root.connectionId)
    }
    for (const connectionId of [...this.views.keys()]) if (!open.has(connectionId)) this.close(connectionId)
    for (const connectionId of [...this.seen.keys()]) if (!servers.has(connectionId)) this.seen.delete(connectionId)
    for (const connectionId of open) if (!this.views.has(connectionId)) this.open(connectionId)
  }

  private open(connectionId: string): void {
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
    this.views.set(connectionId, { handle, ticks })
  }

  private close(connectionId: string): void {
    const view = this.views.get(connectionId)
    if (!view) return
    this.views.delete(connectionId)
    view.ticks.dispose()
    view.handle.dispose()
  }

  private applied(connectionId: string, tick: LiveTick): void {
    // The catalog is gone (dropped elsewhere): its server's Integration Services Catalogs folder lists it no longer.
    if (tick.errors?.some(error => error.probe === probe && error.code === 'CATALOG_MISSING')) {
      this.seen.delete(connectionId)
      for (const folder of this.catalogsFolders(connectionId)) this.o.explorer.reconcile(folder.id, background)
      return
    }
    const status = tick.samples.find(sample => sample.probe === probe)?.status
    if (!status) return
    const next = new Map(status.map(value => [value.id, value.value]))
    const previous = this.seen.get(connectionId)
    this.seen.set(connectionId, next)
    if (!previous) return
    const changed = catalogFingerprints.filter(fingerprint => [fingerprint.id + 'Count', fingerprint.id + 'Checksum'].some(id => previous.get(id) !== next.get(id)))
    if (changed.length) this.reload(connectionId, changed)
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
