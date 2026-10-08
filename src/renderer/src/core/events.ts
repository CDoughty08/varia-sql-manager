import type { Disposable, WorkbenchEvent } from './types'
import { onUnexpectedError } from './errors'

/** Listeners for one kind of event. One failing listener must not skip the others or abort the emitter's state transition. */
export class Emitter<T> implements Disposable {
  private listeners = new Set<(event: T) => void>()
  subscribe(listener: (event: T) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch (error) { onUnexpectedError(error) }
    }
  }
  dispose(): void { this.listeners.clear() }
}

export class EventBus extends Emitter<WorkbenchEvent> {}
