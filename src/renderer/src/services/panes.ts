import { paneIds, type PaneId } from '../../../shared/layouts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export type PaneVisibility = Readonly<Record<PaneId, boolean>>
/** Where a panel is: docked in the grid, floating inside the window, or closed. */
export type PaneLocation = 'grid' | 'floating' | 'closed'

/**
 * Which panels are showing, as the dock workspace reports it; context keys and the pane toggles read it. Where each
 * panel is (docked, floating or closed) is kept beside it without notifying: a panel's ⋯ menu reads it when it opens.
 */
export class PaneService extends SnapshotStore<PaneVisibility> implements Disposable {
  private locations: Readonly<Record<PaneId, PaneLocation>> = { explorer: 'closed', editor: 'closed', output: 'closed' }
  constructor() { super({ explorer: false, editor: false, output: false }) }
  set(visible: PaneVisibility, locations?: Readonly<Record<PaneId, PaneLocation>>): void {
    if (locations) this.locations = { explorer: locations.explorer, editor: locations.editor, output: locations.output }
    const current = this.getSnapshot()
    if (paneIds.some(id => current[id] !== visible[id])) this.publish({ explorer: visible.explorer, editor: visible.editor, output: visible.output })
  }
  location(id: PaneId): PaneLocation { return this.locations[id] }
  dispose(): void { this.clearListeners() }
}
