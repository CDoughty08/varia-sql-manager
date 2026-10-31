import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  function window() {
    const value = {
      destroyed: false,
      pushed: [] as ActionProgress[],
      isDestroyed: () => value.destroyed,
      send: (channel: string, progress: ActionProgress) => { expect(channel).toBe('varia:actions-progress'); value.pushed.push(progress) }
    }
    return value
  }
  const gap = 1000 / actionLimits.progressPerSecond
  beforeEach(() => { vi.useFakeTimers({ now: 0 }) })
  afterEach(() => { vi.useRealTimers() })

  it('pushes a request\'s progress only to the window that sent it, and nothing once it is gone or the request ended', () => {
    const [a, b] = [window(), window()]
    const relayA = actionProgressRelay('ra', a)
    const relayB = actionProgressRelay('rb', b)
    relayA.event({ type: 'action.progress', step: 0, percent: 5 })
    relayB.event({ type: 'action.progress', step: 3, percent: 0 })
    expect(a.pushed).toEqual([{ requestId: 'ra', step: 0, percent: 5 }])
    expect(b.pushed).toEqual([{ requestId: 'rb', step: 3, percent: 0 }])
    a.destroyed = true
    relayA.event({ type: 'action.progress', step: 1, percent: 0 })
    vi.advanceTimersByTime(gap)
    relayB.close()
    relayB.event({ type: 'action.progress', step: 4, percent: 0 })
    expect(a.pushed).toHaveLength(1)
    expect(b.pushed).toHaveLength(1)
  })

  it('pushes at most progressPerSecond a second, each step\'s start at once, and the latest held percent when the interval ends', () => {
    const target = window()
    const relay = actionProgressRelay('r', target)
    const event = (step: number, percent: number) => relay.event({ type: 'action.progress', step, percent })
    event(0, 0)
    vi.advanceTimersByTime(gap - 10); event(0, 95)
    vi.advanceTimersByTime(5); event(0, 100)
    expect(target.pushed.map(value => value.percent)).toEqual([0])
    // The step's last percent arrives by itself when the interval ends, though nothing follows it (a long log zeroing, a lock).
    vi.advanceTimersByTime(5)
    expect(target.pushed).toEqual([{ requestId: 'r', step: 0, percent: 0 }, { requestId: 'r', step: 0, percent: 100 }])
    vi.advanceTimersByTime(1); event(1, 0)
    vi.advanceTimersByTime(1); event(1, 10)
    // A new step goes at once and drops what the step before still held.
    vi.advanceTimersByTime(1); event(2, 0)
    vi.advanceTimersByTime(10 * gap)
    expect(target.pushed.slice(2)).toEqual([{ requestId: 'r', step: 1, percent: 0 }, { requestId: 'r', step: 2, percent: 0 }])
    // Backend EVENTs spaced by its own clock can reach main a little closer together: the later one is held, not lost.
    target.pushed.length = 0
    event(2, 40)
    vi.advanceTimersByTime(gap - 10); event(2, 45)
    vi.advanceTimersByTime(gap)
    expect(target.pushed.map(value => value.percent)).toEqual([40, 45])
    // A second of events every 50 ms reaches the page at most progressPerSecond times, ending on the latest.
    target.pushed.length = 0
    for (let at = 0; at < 1000; at += 50) { event(2, at / 10); vi.advanceTimersByTime(50) }
    vi.advanceTimersByTime(gap)
    expect(target.pushed.length).toBeLessThanOrEqual(actionLimits.progressPerSecond + 1)
    expect(target.pushed.at(-1)).toEqual({ requestId: 'r', step: 2, percent: 95 })
    // A request that ended drops what it held.
    target.pushed.length = 0
    vi.advanceTimersByTime(gap)
    event(2, 96)
    event(2, 97)
    relay.close()
    vi.advanceTimersByTime(gap)
    expect(target.pushed).toEqual([{ requestId: 'r', step: 2, percent: 96 }])
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
