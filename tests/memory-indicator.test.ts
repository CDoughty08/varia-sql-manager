import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/renderer/src/core/events'
import { memoryWarning, ResultMemoryService } from '../src/renderer/src/results/memory'
import { formatBytes } from '../src/renderer/src/results/status'
import { summaryOf } from './fixtures/results'

const MB = 1048576
describe('result memory', () => {
  it('shows bytes as the status bar does: under 1 MB, whole megabytes to 9,999, then gigabytes', () => {
    expect([0, MB - 1, MB, 1.4 * MB, 9999 * MB, 9999.4 * MB, 10_000 * MB, 1.25 * 1024 * MB * 10].map(formatBytes))
      .toEqual(['<1 MB', '<1 MB', '1 MB', '1 MB', '9,999 MB', '9,999 MB', '9.8 GB', '12.5 GB'])
  })
  it('follows the backend\'s pushes, each summary\'s budget, and closes; it warns from 90 %', () => {
    const listeners = new Set<(memory: { usedBytes: number; globalBytes: number }) => void>()
    const events = new EventBus()
    const service = new ResultMemoryService({ onMemory: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } } }, events)
    const changes: unknown[] = []
    service.subscribe(() => changes.push(service.getSnapshot()))
    for (const listener of listeners) listener({ usedBytes: 10 * MB, globalBytes: 100 * MB })
    expect(service.getSnapshot()).toEqual({ usedBytes: 10 * MB, globalBytes: 100 * MB })
    expect(memoryWarning(service.getSnapshot())).toBe(false)
    events.emit({ type: 'query.finished', tabId: 't', queryId: 'q', summary: summaryOf([], { budget: { usedBytes: 92 * MB, globalBytes: 100 * MB, queryBytes: 50 * MB } }) })
    expect(memoryWarning(service.getSnapshot())).toBe(true)
    // A close reports only what is used; the budget stays.
    service.update({ usedBytes: 0, globalBytes: 0 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 0, globalBytes: 100 * MB })
    service.update({ usedBytes: 0, globalBytes: 0 })
    expect(changes).toHaveLength(3)
    service.dispose()
    expect(listeners.size).toBe(0)
    expect(memoryWarning({ usedBytes: 1, globalBytes: 0 })).toBe(false)
  })
})
