import { objectSearchLimits, type ObjectIndexProgress, type ObjectIndexProgressEvent } from '../shared/explorer/search.ts'

/** The window that started an explorer.index build (its `event.sender`): the only one its progress may reach. */
export interface IndexProgressTarget {
  isDestroyed(): boolean
  send(channel: 'varia:explorer-index-progress', value: ObjectIndexProgress): void
}

export interface IndexProgressRelay {
  /** Takes one validated progress EVENT of the build. */
  event(event: ObjectIndexProgressEvent): void
  /** The build ended: nothing more is pushed (the reply carries the final status). */
  close(): void
}

/**
 * Relays one explorer.index build's progress EVENTs to the window that started it, as `varia:explorer-index-progress`, at
 * most objectSearchLimits.progressPerSecond a second. The latest wins: an EVENT inside the interval is held and pushed when the
 * interval ends unless a later one replaced it. Nothing is pushed once the window is gone or the build ended.
 */
export function indexProgressRelay(requestId: string, target: IndexProgressTarget, now: () => number = Date.now): IndexProgressRelay {
  const gap = 1000 / objectSearchLimits.progressPerSecond
  let last = Number.NEGATIVE_INFINITY
  let held: ObjectIndexProgressEvent | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const push = (event: ObjectIndexProgressEvent) => {
    last = now()
    held = undefined
    if (!target.isDestroyed()) target.send('varia:explorer-index-progress', { requestId, done: event.done, total: event.total, objects: event.objects })
  }
  const flush = () => {
    timer = undefined
    if (held && !closed) push(held)
  }
  return {
    event: event => {
      if (closed) return
      const wait = last + gap - now()
      if (wait <= 0) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        return push(event)
      }
      held = event
      timer ??= setTimeout(flush, wait)
    },
    close: () => {
      closed = true
      held = undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
  }
}
