import { paneIds, type PaneId } from '../../../shared/layouts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export type PaneVisibility = Readonly<Record<PaneId, boolean>>

/** Which panels are showing, as the dock workspace reports it; context keys and the pane toggles read it. */
export class PaneService extends SnapshotStore<PaneVisibility> implements Disposable {
  constructor() { super({ explorer: false, editor: false, output: false }) }
  set(visible: PaneVisibility): void {
    const current = this.getSnapshot()
    if (paneIds.some(id => current[id] !== visible[id])) this.publish({ explorer: visible.explorer, editor: visible.editor, output: visible.output })
  }
  dispose(): void { this.clearListeners() }
}
