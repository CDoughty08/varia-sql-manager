import { SnapshotStore } from '../core/store'
import type { DocumentService } from './documents'

/** The tab whose name is being edited in the strip ('' for none). */
export interface TabRenameSnapshot { readonly id: string }

/**
 * Rename Tab's inline edit: the command, F2 on a focused tab and a double-click start it, and the strip shows a text box
 * in that tab until it is committed (Enter, or focus leaving it) or cancelled (Escape). One tab at a time.
 */
export class TabRenameService extends SnapshotStore<TabRenameSnapshot> {
  constructor(private readonly documents: Pick<DocumentService, 'get' | 'rename'>) { super({ id: '' }) }
  start(id: string): boolean {
    if (!this.documents.get(id)) return false
    if (this.getSnapshot().id !== id) this.publish({ id })
    return true
  }
  /** Gives the tab `value` as its name (see DocumentService.rename) and ends the edit. */
  commit(id: string, value: string): void {
    if (this.getSnapshot().id !== id) return
    this.publish({ id: '' })
    this.documents.rename(id, value)
  }
  cancel(): void { if (this.getSnapshot().id) this.publish({ id: '' }) }
}
