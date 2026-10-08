import type { Disposable, WorkbenchEvent } from './types'
import { onUnexpectedError } from './errors'

export class EventBus implements Disposable {
  private listeners = new Set<(event: WorkbenchEvent) => void>()
  subscribe(listener: (event: WorkbenchEvent) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  // One failing listener must not skip the others or abort the emitter's state transition.
  emit(event: WorkbenchEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch (error) { onUnexpectedError(error) }
    }
  }
  dispose(): void { this.listeners.clear() }
}
