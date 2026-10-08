import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export interface EditorOptions { readonly wordWrap: boolean }
interface OptionsTarget { updateOptions(options: { wordWrap: 'on' | 'off' }): void }

/** Query editor options the user toggles with commands. Session-only until preferences persist them. */
export class EditorOptionsService extends SnapshotStore<EditorOptions> implements Disposable {
  constructor() { super({ wordWrap: false }) }
  toggleWordWrap(): void { this.publish({ ...this.getSnapshot(), wordWrap: !this.getSnapshot().wordWrap }) }
  /** Applies the options to an editor now and after every change. */
  bindEditor(editor: OptionsTarget): Disposable {
    const apply = () => editor.updateOptions({ wordWrap: this.getSnapshot().wordWrap ? 'on' : 'off' })
    apply()
    const unsubscribe = this.subscribe(apply)
    return { dispose: unsubscribe }
  }
  dispose(): void { this.clearListeners() }
}
