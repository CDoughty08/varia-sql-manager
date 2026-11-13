import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export type DisconnectChoice = 'keep-tabs' | 'close-query-tabs' | 'cancel'
export interface DisconnectPromptTab { readonly id: string; readonly name: string; readonly dirty: boolean; readonly running: boolean }
export interface DisconnectPromptRequest { readonly targetId: string; readonly name: string; readonly tabs: readonly DisconnectPromptTab[] }
export interface DisconnectPrompt extends DisconnectPromptRequest { readonly promptId: number }
interface PendingPrompt { readonly prompt: DisconnectPrompt; readonly resolve: (choice: DisconnectChoice) => void }

/** One workbench owns this service, including when a command originates in a popout. No connection state lives here. */
export class DisconnectPromptService extends SnapshotStore<DisconnectPrompt | undefined> implements Disposable {
  private readonly queue: PendingPrompt[] = []
  private sequence = 0
  private disposed = false
  constructor() { super(undefined) }

  request(request: DisconnectPromptRequest): Promise<DisconnectChoice> {
    if (this.disposed) return Promise.resolve('cancel')
    const prompt = Object.freeze({ ...request, promptId: ++this.sequence, tabs: Object.freeze(request.tabs.map(tab => Object.freeze({ ...tab }))) })
    return new Promise(resolve => {
      this.queue.push({ prompt, resolve })
      if (this.queue.length === 1) this.publish(prompt)
    })
  }

  /** A delayed event from a dismissed dialog cannot answer the next prompt. */
  answer(promptId: number, choice: DisconnectChoice): boolean {
    const pending = this.queue[0]
    if (!pending || pending.prompt.promptId !== promptId) return false
    this.queue.shift()
    this.publish(this.queue[0]?.prompt)
    pending.resolve(choice)
    return true
  }

  dispose(): void {
    this.disposed = true
    const pending = this.queue.splice(0)
    this.publish(undefined)
    for (const item of pending) item.resolve('cancel')
    this.clearListeners()
  }
}
