import { describe, expect, it, vi } from 'vitest'
import { gridOperation, phaseText, ResultOperations } from '../src/renderer/src/results/operations'
import { gridLimits as g } from '../src/renderer/src/grid/constants'
import type { EntryKey } from '../src/renderer/src/results/ResultsService'
import { manualTimers } from './fixtures/workbench'

const e1 = 'e1' as EntryKey, e2 = 'e2' as EntryKey

function fixture() {
  const timers = manualTimers(), clock = { now: 0 }
  const operations = new ResultOperations({ timers: timers.timers, now: () => clock.now })
  const tick = (ms: number) => { clock.now += ms; timers.advance(ms) }
  return { operations, timers, tick, tab: (id = 't1') => operations.getSnapshot()[id] }
}

describe('result operations', () => {
  it('keeps one busy state: only a sort or filter holds a grid off, and only until it ends', () => {
    const { operations, tab } = fixture()
    const cancel = vi.fn()
    const profile = operations.begin('t1', { kind: 'profile', target: 'Result 1', entry: e1, cancel })
    expect(operations.building('t1', e1)).toBeUndefined()
    expect(operations.anyBuilding()).toBe(false)
    const sort = operations.begin('t1', { kind: 'sort', target: 'Result 1', entry: e1, column: 2, cancel })
    expect(operations.building('t1', e1)?.id).toBe(sort.id)
    expect(operations.building('t1', e2)).toBeUndefined()
    expect(operations.building('t2', e1)).toBeUndefined()
    expect(operations.anyBuilding()).toBe(true)
    // A grid shows its sort or filter before anything else reading it.
    expect(gridOperation(tab()?.items, e1)?.kind).toBe('sort')
    sort.end()
    expect(gridOperation(tab()?.items, e1)?.kind).toBe('profile')
    expect(operations.anyBuilding()).toBe(false)
    profile.end('dropped')
    expect(tab()).toBeUndefined()
  })

  it('takes the backend figure only when it does not go back, and drops it for a phase with no total', () => {
    const { operations, tick, tab } = fixture()
    const ticket = operations.begin('t1', { kind: 'compare', target: 'Result 1 → Result 2', cancel: () => {} })
    tick(g.operationShowDelayMs)
    ticket.progress('identify', undefined)
    expect(tab()?.items[0]).toMatchObject({ phase: 'identify' })
    expect(tab()?.items[0]?.percent).toBeUndefined()
    expect(phaseText('identify')).toBe('Finding row keys')
    ticket.progress('match', 45)
    ticket.progress('match', 30)
    expect(tab()?.items[0]?.percent).toBe(45)
    // The same phase reporting no figure keeps the last; the strip never goes blank mid-phase.
    ticket.progress('match', undefined)
    expect(tab()?.items[0]?.percent).toBe(45)
    ticket.end()
    ticket.progress('align', 90)
    expect(tab()?.items[0]).toMatchObject({ ending: true, percent: 100 })
  })

  it('pulses every building operation on a refusal (Sort Text By names none), and says why once it shows', () => {
    const { operations, tab } = fixture()
    operations.begin('t1', { kind: 'sort', target: 'Result 1', entry: e1, cancel: () => {} })
    operations.begin('t2', { kind: 'filter', target: 'Result 4', entry: e2, cancel: () => {} })
    operations.begin('t2', { kind: 'pivot', target: 'Result 4', entry: e2, cancel: () => {} })
    operations.refused(undefined)
    expect(tab('t1')?.items[0]).toMatchObject({ shown: true, pulse: 1 })
    expect(tab('t2')?.items.map(item => [item.kind, item.pulse])).toEqual([['filter', 1], ['pivot', 0]])
    expect(tab('t2')?.announcement).toBe('Filtering Result 4. Sorting and filtering wait until it finishes; Cancel stops it.')
    operations.refused('t1', e1)
    expect(tab('t1')?.items[0]?.pulse).toBe(2)
    expect(tab('t2')?.items[0]?.pulse).toBe(1)
  })

  it('cancels one operation or every one of a tab, leaves a notice that goes after a while, and forgets a closed tab', () => {
    const { operations, tick, tab } = fixture()
    const first = vi.fn(), second = vi.fn()
    let a = operations.begin('t1', { kind: 'sort', target: 'Result 1', entry: e1, cancel: () => { first(); a.end('cancelled') } })
    const b = operations.begin('t1', { kind: 'profile', target: 'Result 2', entry: e2, cancel: () => { second(); b.end('cancelled') } })
    // Escape (no id) cancels only what shows; a strip's Cancel names its operation.
    expect(operations.cancellable('t1')).toBe(false)
    tick(g.operationShowDelayMs)
    expect(operations.cancellable('t1')).toBe(true)
    operations.cancel('t1', a.id)
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 0])
    expect(tab()?.notice).toBe('Sort cancelled. The grid kept its previous order.')
    operations.cancel('t1')
    expect(second).toHaveBeenCalledOnce()
    expect(tab()?.notice).toBe('Profile cancelled.')
    expect(operations.cancellable('t1')).toBe(false)
    tick(g.operationNoticeMs)
    expect(tab()?.notice).toBe('')
    // A new operation clears the notice at once; a closed tab takes what it said with it.
    a = operations.begin('t1', { kind: 'sort', target: 'Result 1', entry: e1, cancel: () => a.end('cancelled') })
    operations.cancel('t1', a.id)
    operations.begin('t1', { kind: 'filter', target: 'Result 1', entry: e1, cancel: () => {} })
    expect(tab()?.notice).toBe('')
    operations.dispose()
    expect(() => tick(10_000)).not.toThrow()
  })

  it('drops a superseded or failed operation without a word', () => {
    const { operations, tick, tab } = fixture()
    const ticket = operations.begin('t1', { kind: 'filter', target: 'Result 1', entry: e1, cancel: () => {} })
    tick(g.operationShowDelayMs)
    const announced = tab()?.announced
    ticket.end('dropped')
    expect(tab()).toMatchObject({ items: [], notice: '', announced })
    operations.forget('t1')
    expect(tab()).toBeUndefined()
  })

  it('reads a repeated sentence out again, tells the tab a refused Sort Text By came from, and marks only shown work held', () => {
    const { operations, tick, tab } = fixture()
    operations.begin('t1', { kind: 'sort', target: 'Result 1', entry: e1, cancel: () => {} })
    // Not on screen yet: it holds clicks off, but the toolbar does not mark Sort Text By held (a quick one never flashes).
    expect([operations.anyBuilding(), operations.anyBuilding(true)]).toEqual([true, false])
    tick(g.operationShowDelayMs)
    expect(operations.anyBuilding(true)).toBe(true)
    operations.refused('t1', e1)
    const first = tab('t1')?.announcement
    operations.refused('t1', e1)
    expect(tab('t1')?.announcement).not.toBe(first)
    expect(tab('t1')?.announcement?.replace('​', '')).toBe(first)
    operations.refused(undefined, undefined, 't2')
    expect(tab('t2')?.announcement).toBe('Sorting Result 1. Sort Text By waits until it finishes.')
  })

  it('says what a cancel kept when it was not the previous view', () => {
    const { operations, tab } = fixture()
    const ticket = operations.begin('t1', { kind: 'filter', target: 'Result 1', entry: e1, cancel: () => ticket.end('cancelled'), cancelled: 'Kept the rows that had arrived.' })
    operations.cancel('t1', ticket.id)
    expect(tab()?.notice).toBe('Kept the rows that had arrived.')
  })
})
