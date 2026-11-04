import { actionLimits } from '../shared/actions/catalog.ts'
import type { ActionProgress, ActionProgressEvent } from '../shared/actions/schema.ts'

/** The window that sent an actions.execute request (its `event.sender`): the only one its progress may reach. */
export interface ActionProgressTarget {
  isDestroyed(): boolean
  send(channel: 'varia:actions-progress', value: ActionProgress): void
}

export interface ActionProgressRelay {
  /** Takes one validated progress EVENT of the request. */
  event(event: ActionProgressEvent): void
  /** The request ended: nothing more is pushed, and a held percent is dropped (the reply carries every step's last one). */
  close(): void
}

/**
 * Relays one actions.execute request's progress EVENTs (a long step's start and STATS percent, already validated) to the window
 * that sent it, as `varia:actions-progress`, at most actionLimits.progressPerSecond a second. The latest wins: an EVENT inside
 * the interval is held and pushed when the interval ends unless a later one replaced it, so a step's last percent is not lost.
 * A new step is pushed at once (and drops what the step before still held), so the page never shows a finished step's bar on
 * the next one. Nothing is pushed once the window is gone or the request ended.
 */
export function actionProgressRelay(requestId: string, target: ActionProgressTarget): ActionProgressRelay {
  const gap = 1000 / actionLimits.progressPerSecond
  let last = Number.NEGATIVE_INFINITY
  let step = -1
  let held: ActionProgressEvent | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const push = (event: ActionProgressEvent) => {
    last = Date.now()
    step = event.step
    held = undefined
    if (!target.isDestroyed()) target.send('varia:actions-progress', { requestId, step: event.step, percent: event.percent })
  }
  const flush = () => {
    timer = undefined
    if (held && !closed) push(held)
  }
  return {
    event: event => {
      if (closed) return
      const wait = last + gap - Date.now()
      if (event.step !== step || wait <= 0) {
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
