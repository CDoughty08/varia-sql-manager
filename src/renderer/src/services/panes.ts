import { outputPaneIds, paneIds, type OutputPaneId, type PaneId } from '../../../shared/layouts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export type PaneVisibility = Readonly<Record<PaneId, boolean>>
/** Where a panel is: docked in the grid, floating inside the window, or closed. */
export type PaneLocation = 'grid' | 'floating' | 'closed'
/** For each open output panel, the output panels in its group in tab order (itself included); a closed one has none. */
export type OutputPeers = Readonly<Record<OutputPaneId, readonly OutputPaneId[]>>

const record = <T>(value: (id: PaneId) => T) => Object.fromEntries(paneIds.map(id => [id, value(id)])) as Record<PaneId, T>
const noPeers: OutputPeers = { results: [], messages: [], plan: [] }

/** The peers store: which output panels share a group, which their toolbars tab between. */
class OutputPeerStore extends SnapshotStore<OutputPeers> {
  constructor() { super(noPeers) }
  set(peers: OutputPeers): void {
    const current = this.getSnapshot()
    if (outputPaneIds.some(id => current[id].join() !== peers[id].join())) this.publish(peers)
  }
  dispose(): void { this.clearListeners() }
}

/**
 * Which panels are showing, as the dock workspace reports it; context keys and the pane toggles read it. Where each
 * panel is (docked, floating or closed) is kept beside it without notifying: a panel's ⋯ menu reads it when it opens.
 */
export class PaneService extends SnapshotStore<PaneVisibility> implements Disposable {
  private locations: Readonly<Record<PaneId, PaneLocation>> = record(() => 'closed')
  readonly peers = new OutputPeerStore()
  constructor() { super(record(() => false)) }
  set(visible: PaneVisibility, locations?: Readonly<Record<PaneId, PaneLocation>>, peers?: OutputPeers): void {
    if (locations) this.locations = record(id => locations[id])
    if (peers) this.peers.set(peers)
    const current = this.getSnapshot()
    if (paneIds.some(id => current[id] !== visible[id])) this.publish(record(id => visible[id]))
  }
  location(id: PaneId): PaneLocation { return this.locations[id] }
  private selector?: (id: OutputPaneId) => void
  /** The dock workspace's way to show an output panel's tab in its group (`select`), set while it is mounted. */
  bindSelector(selector: (id: OutputPaneId) => void): Disposable {
    this.selector = selector
    return { dispose: () => { if (this.selector === selector) this.selector = undefined } }
  }
  /**
   * Shows an output panel in place of the output panel its group shows: an output toolbar's tab, or the active query's
   * view changing. A group that shows another kind of panel (one the output panel was tabbed with) is left as it is.
   */
  select(id: OutputPaneId): void { this.selector?.(id) }
  /** Whether any output panel is showing. */
  outputShowing(): boolean { const visible = this.getSnapshot(); return outputPaneIds.some(id => visible[id]) }
  dispose(): void { this.clearListeners(); this.peers.dispose() }
}
