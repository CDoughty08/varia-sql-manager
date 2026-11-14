// @vitest-environment happy-dom
// The results strip names the result memory budget a query stopped at, not the figure in force now: the limit can be changed
// while the backend runs (results.setMemoryLimit), so a query that filled an 8 GiB budget must not say a 1 GiB one was full.
import { describe, expect, it } from 'vitest'
import { truncationText } from '../src/renderer/src/grid/ResultGrid'

const GiB = 1024 ** 3
const now = { usedBytes: 0, globalBytes: 1 * GiB, queryBytes: GiB / 2, generation: 1, seq: 4 }

describe('the truncation strip\'s budget figure', () => {
  it('names the figure the query stopped at when the summary has one', () => {
    const text = truncationText({ truncated: 'globalBudget', rowsStored: 10, rowsRead: 20, budget: { ...now, stoppedBytes: 8 * GiB } })
    expect(text).toContain('(8,192 MB)')
    expect(text).not.toContain('(1,024 MB)')
    expect(truncationText({ truncated: 'queryBudget', rowsStored: 10, rowsRead: 20, budget: { ...now, stoppedBytes: 4 * GiB } })).toContain('(4,096 MB)')
  })

  it('falls back to the current half or whole budget without one', () => {
    expect(truncationText({ truncated: 'globalBudget', rowsStored: 10, rowsRead: 20, budget: now })).toContain('(1,024 MB)')
    expect(truncationText({ truncated: 'queryBudget', rowsStored: 10, rowsRead: 20, budget: now })).toContain('(512 MB)')
    expect(truncationText({ truncated: 'queryBudget', rowsStored: 10, rowsRead: 20 })).toContain('the result memory budget is full')
  })
})
