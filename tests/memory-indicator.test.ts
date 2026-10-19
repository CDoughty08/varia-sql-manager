import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/renderer/src/core/events'
import { memoryWarning, ResultMemoryService } from '../src/renderer/src/results/memory'
import type { MemoryReport } from '../src/renderer/src/results/ResultClient'
import { formatBytes } from '../src/renderer/src/results/status'
import { summaryOf } from './fixtures/results'

const MB = 1048576
describe('result memory', () => {
  it('shows bytes as the status bar does: under 1 MB, whole megabytes to 9,999, then gigabytes', () => {
    expect([0, MB - 1, MB, 1.4 * MB, 9999 * MB, 9999.4 * MB, 10_000 * MB, 1.25 * 1024 * MB * 10].map(formatBytes))
      .toEqual(['<1 MB', '<1 MB', '1 MB', '1 MB', '9,999 MB', '9,999 MB', '9.8 GB', '12.5 GB'])
  })
  it('follows the backend\'s pushes, each summary\'s budget, and closes; it warns from 90 %', () => {
    const listeners = new Set<(memory: MemoryReport) => void>()
    const events = new EventBus()
    const service = new ResultMemoryService({ onMemory: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } } }, events)
    const changes: unknown[] = []
    service.subscribe(() => changes.push(service.getSnapshot()))
    for (const listener of listeners) listener({ usedBytes: 10 * MB, globalBytes: 100 * MB, generation: 1, seq: 1 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 10 * MB, globalBytes: 100 * MB })
    expect(memoryWarning(service.getSnapshot())).toBe(false)
    events.emit({ type: 'query.finished', tabId: 't', queryId: 'q', summary: summaryOf([], { budget: { usedBytes: 92 * MB, globalBytes: 100 * MB, queryBytes: 50 * MB, generation: 1, seq: 2 } }) })
    expect(memoryWarning(service.getSnapshot())).toBe(true)
    // A close reports only what is used; the budget stays.
    service.update({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 3 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 0, globalBytes: 100 * MB })
    service.update({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 4 })
    expect(changes).toHaveLength(3)
    service.dispose()
    expect(listeners.size).toBe(0)
    expect(memoryWarning({ usedBytes: 1, globalBytes: 0 })).toBe(false)
  })
  it('never shows a figure older than the one it shows: a summary overtaken by a close, or a backend that was replaced', () => {
    const listeners = new Set<(memory: MemoryReport) => void>()
    const events = new EventBus()
    const service = new ResultMemoryService({ onMemory: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } } }, events)
    const push = (memory: MemoryReport) => { for (const listener of listeners) listener(memory) }
    const finish = (usedBytes: number, generation: number, seq: number) =>
      events.emit({ type: 'query.finished', tabId: 't', queryId: 'q', summary: summaryOf([], { budget: { usedBytes, globalBytes: 2048 * MB, queryBytes: 1024 * MB, generation, seq } }) })
    push({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 0 })
    finish(32 * MB, 1, 1)
    // Tab 2's summary took its figure (42 MB, #2), then tab 1's Close Results sent the fall (#3) before the summary went out.
    push({ usedBytes: 10 * MB, globalBytes: 2048 * MB, generation: 1, seq: 3 })
    finish(42 * MB, 1, 2)
    expect(service.getSnapshot()).toEqual({ usedBytes: 10 * MB, globalBytes: 2048 * MB })
    // The same report twice, or an older event, changes nothing; a later summary does.
    push({ usedBytes: 99 * MB, globalBytes: 2048 * MB, generation: 1, seq: 3 })
    push({ usedBytes: 99 * MB, globalBytes: 2048 * MB, generation: 1, seq: 1 })
    expect(service.getSnapshot().usedBytes).toBe(10 * MB)
    finish(11 * MB, 1, 4)
    expect(service.getSnapshot().usedBytes).toBe(11 * MB)
    // A new backend holds nothing, whatever the old one still sends; its own reports count from 1 again.
    push({ usedBytes: 0, globalBytes: 0, generation: 2, seq: 0 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 0, globalBytes: 2048 * MB })
    finish(50 * MB, 1, 9)
    push({ usedBytes: 60 * MB, globalBytes: 2048 * MB, generation: 1, seq: 10 })
    expect(service.getSnapshot().usedBytes).toBe(0)
    push({ usedBytes: 3 * MB, globalBytes: 2048 * MB, generation: 2, seq: 1 })
    expect(service.getSnapshot().usedBytes).toBe(3 * MB)
    // With no backend (generation 0) the last one's late reports are dropped too, until the next one reports.
    push({ usedBytes: 0, globalBytes: 0, generation: 0, seq: 0 })
    push({ usedBytes: 7 * MB, globalBytes: 2048 * MB, generation: 2, seq: 2 })
    expect(service.getSnapshot().usedBytes).toBe(0)
    push({ usedBytes: 0, globalBytes: 0, generation: 3, seq: 0 })
    finish(5 * MB, 3, 1)
    expect(service.getSnapshot().usedBytes).toBe(5 * MB)
    service.dispose()
  })
})
