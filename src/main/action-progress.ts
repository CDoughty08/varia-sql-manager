import { actionLimits } from '../shared/actions/catalog.ts'
import type { ActionProgress, ActionProgressEvent } from '../shared/actions/schema.ts'

/**
 * Relays one actions.execute request's progress EVENTs (a long step's STATS percent, already validated) to the window that sent
 * it, at most actionLimits.progressPerSecond a second; the latest wins, as results jobs do. A new step is always sent, so the
 * page never shows a finished step's bar on the next one. Nothing is pushed once the window is gone.
 */
export function actionProgressRelay(requestId: string, push: (progress: ActionProgress) => void, now: () => number = Date.now): (event: ActionProgressEvent) => void {
  let last = Number.NEGATIVE_INFINITY
  let step = -1
  return event => {
    const at = now()
    if (event.step === step && at - last < 1000 / actionLimits.progressPerSecond) return
    last = at
    step = event.step
    push({ requestId, step: event.step, percent: event.percent })
  }
}
