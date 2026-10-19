import type { RecentFile, VariaApi } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

type RecentApi = Pick<VariaApi, 'recentFiles' | 'onRecentFiles'>

/**
 * File › Recent Files as main last sent it: names and paths to show, and the ids main opens them by. Main pushes every
 * change (an open, a save under a new name, Clear, Options' count); the first list is asked for once.
 */
export class RecentFilesService extends SnapshotStore<readonly RecentFile[]> implements Disposable {
  private readonly unsubscribe: () => void
  private pushed = false
  constructor(api: RecentApi) {
    super([])
    this.unsubscribe = api.onRecentFiles(files => { this.pushed = true; this.publish(files) })
    // A push that arrives before the answer is newer than it.
    api.recentFiles().then(result => { if (result.ok && !this.pushed) this.publish(result.value) }, () => {})
  }
  dispose(): void {
    this.unsubscribe()
    this.clearListeners()
  }
}
