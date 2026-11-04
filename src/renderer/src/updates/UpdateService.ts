import type { VariaApi } from '../../../shared/contracts'
import type { UpdateState } from '../../../shared/updates'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

type UpdateApi = Pick<VariaApi, 'getUpdateState' | 'onUpdateState'>

const initial: UpdateState = { status: 'idle', currentVersion: '', kind: 'unsupported', enabled: false }

/** The update check as main last sent it; main pushes every change (progress included), and the page never polls. */
export class UpdateService extends SnapshotStore<UpdateState> implements Disposable {
  private readonly unsubscribe: () => void
  private pushed = false
  constructor(api: UpdateApi) {
    super(initial)
    this.unsubscribe = api.onUpdateState(state => { this.pushed = true; this.publish(state) })
    // A push that arrives before the answer is newer than it.
    api.getUpdateState().then(result => { if (result.ok && !this.pushed) this.publish(result.value) }, () => {})
  }
  dispose(): void {
    this.unsubscribe()
    this.clearListeners()
  }
}
