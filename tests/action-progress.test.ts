import { describe, expect, it, vi } from 'vitest'
import { actionDrainMs, actionLimits, objectActionSpecs, objectActions } from '../src/shared/actions/catalog'
import { actionProgressEventSchema, actionProgressSchema, type ActionProgress } from '../src/shared/actions/schema'
import { methodPolicies } from '../src/shared/ipc/methods'
import { actionProgressRelay } from '../src/main/action-progress'
import { ActionProgressService, stepProgress } from '../src/renderer/src/actions/ActionProgressService'

describe('action progress schemas', () => {
  it('accept a step and a whole percent, and nothing else', () => {
    expect(actionProgressEventSchema.parse({ type: 'action.progress', step: 0, percent: 100 })).toEqual({ type: 'action.progress', step: 0, percent: 100 })
    for (const bad of [{ step: -1, percent: 5 }, { step: actionLimits.statements + 8, percent: 5 }, { step: 0, percent: 101 }, { step: 0, percent: 2.5 }, { step: 0, percent: 5, message: 'x' }])
      expect(actionProgressEventSchema.safeParse({ type: 'action.progress', ...bad }).success).toBe(false)
    expect(actionProgressEventSchema.safeParse({ type: 'progress', step: 0, percent: 5 }).success).toBe(false)
    const requestId = crypto.randomUUID()
    expect(actionProgressSchema.parse({ requestId, step: 1, percent: 40 })).toEqual({ requestId, step: 1, percent: 40 })
    expect(actionProgressSchema.safeParse({ requestId: 'r', step: 1, percent: 40 }).success).toBe(false)
    expect(actionProgressSchema.safeParse({ requestId, step: 1, percent: 40, type: 'action.progress' }).success).toBe(false)
  })
})

describe('main\'s action progress relay', () => {
  it('pushes at most progressPerSecond a second per step, the first of each step at once', () => {
    let now = 0
    const pushed: ActionProgress[] = []
    const relay = actionProgressRelay('r', value => pushed.push(value), () => now)
    const event = (step: number, percent: number) => relay({ type: 'action.progress', step, percent })
    const gap = 1000 / actionLimits.progressPerSecond
    event(0, 5)
    now = gap - 1; event(0, 10)
    now = gap; event(0, 15)
    now = gap + 1; event(1, 5)
    now = gap + 2; event(1, 10)
    expect(pushed).toEqual([{ requestId: 'r', step: 0, percent: 5 }, { requestId: 'r', step: 0, percent: 15 }, { requestId: 'r', step: 1, percent: 5 }])
    // A second of events every 50 ms reaches the page at most progressPerSecond times.
    pushed.length = 0
    for (let at = 10_000; at < 11_000; at += 50) { now = at; event(1, Math.min(100, (at - 10_000) / 10)) }
    expect(pushed.length).toBeLessThanOrEqual(actionLimits.progressPerSecond)
  })
})

describe('long-action drain', () => {
  it('lets a closing backend finish only a long action, for its Stop wait plus a margin', () => {
    expect(objectActions.filter(action => actionDrainMs(action) > 0)).toEqual(objectActions.filter(action => objectActionSpecs[action].long))
    const specs = { ...objectActionSpecs, delete: { ...objectActionSpecs.delete, long: true, cleanupMs: 20_000 } }
    expect(actionDrainMs('delete', specs)).toBe(actionLimits.stopGraceMs + 20_000 + actionLimits.drainMarginMs)
    expect(actionDrainMs('rename', { ...specs, rename: { ...objectActionSpecs.rename, long: true } })).toBe(actionLimits.stopGraceMs + actionLimits.cleanupMs + actionLimits.drainMarginMs)
    expect(actionDrainMs('createTable', specs)).toBe(0)
    expect(actionDrainMs('toString', specs)).toBe(0)
    const policy = methodPolicies['actions.execute']
    expect(policy.drainMs?.({ action: 'createTable' } as never)).toBe(0)
    expect(policy.drainMs?.({ action: 'delete' } as never)).toBe(actionDrainMs('delete'))
  })
})

describe('ActionProgressService', () => {
  function service() {
    let listener: ((progress: ActionProgress) => void) | undefined
    const unsubscribe = vi.fn()
    const value = new ActionProgressService({ onActionProgress: callback => { listener = callback; return unsubscribe } })
    return { value, unsubscribe, send: (progress: ActionProgress) => listener?.(progress) }
  }
  it('keeps the latest percent of each tracked request and ignores the others', () => {
    const { value, send } = service()
    const changes = vi.fn()
    value.subscribe(changes)
    send({ requestId: 'a', step: 0, percent: 5 })
    expect(value.latest('a')).toBeUndefined()
    expect(value.track('a')).toBe(true)
    send({ requestId: 'a', step: 0, percent: 5 })
    send({ requestId: 'a', step: 0, percent: 5 })
    send({ requestId: 'a', step: 1, percent: 20 })
    // A later step's bar never moves back to an earlier step.
    send({ requestId: 'a', step: 0, percent: 90 })
    expect(value.latest('a')).toEqual({ step: 1, percent: 20 })
    expect(changes).toHaveBeenCalledTimes(2)
    value.forget('a')
    expect(value.latest('a')).toBeUndefined()
    send({ requestId: 'a', step: 1, percent: 30 })
    expect(value.latest('a')).toBeUndefined()
  })
  it('tracks at most actionLimits.registered requests and unsubscribes on dispose', () => {
    const { value, unsubscribe } = service()
    for (let index = 0; index < actionLimits.registered; index++) expect(value.track(`r${index}`)).toBe(true)
    expect(value.track('one more')).toBe(false)
    expect(value.track('r0')).toBe(true)
    value.forget('r0')
    expect(value.track('one more')).toBe(true)
    value.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('fills the StepList progress slot of the step the progress names', () => {
    expect(stepProgress({ step: 1, percent: 38 }, 1)).toEqual({ progress: 38, progressText: '38 percent processed' })
    expect(stepProgress({ step: 1, percent: 38 }, 0)).toEqual({})
    expect(stepProgress(undefined, 0)).toEqual({})
  })
})
