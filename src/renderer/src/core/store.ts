import type { ExternalStore } from './types'
import { onUnexpectedError } from './errors'

export class SnapshotStore<T> implements ExternalStore<T> {
  private listeners = new Set<() => void>()
  constructor(private snapshot: T) {}
  getSnapshot = (): T => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  protected publish(snapshot: T): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { onUnexpectedError(error) }
    }
  }
  protected clearListeners(): void { this.listeners.clear() }
}
