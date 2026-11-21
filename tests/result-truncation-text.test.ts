// @vitest-environment happy-dom
// The results strip names the result memory budget a query stopped at, not the figure in force now: the limit can be changed
// while the backend runs (results.setMemoryLimit), so a query that filled an 8 GiB budget must not say a 1 GiB one was full.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('says a windowed BigQuery result is capped at the rows a grid reads or the rows-kept limit, never that 0 rows are shown', () => {
    const text = truncationText({ truncated: 'rowLimit', rowsStored: 0, rowsRead: 3_000_000_000, residence: 'remote', rowsAvailable: 2_147_483_647 })
    expect(text).toBe('Only the first 2,147,483,647 of 3,000,000,000 rows can be shown: a grid reads at most 2,147,483,647 rows of a result windowed in BigQuery.')
    expect(truncationText({ rowsStored: 0, rowsRead: 500, residence: 'remote', rowsAvailable: 500 })).toBeUndefined()
    // Capped by Rows kept per execution instead: the strip names that limit, with the rows the grid can read.
    expect(truncationText({ truncated: 'rowLimit', rowsStored: 0, rowsRead: 1_000_000, residence: 'remote', rowsAvailable: 1000 }))
      .toBe('Only the first 1,000 of 1,000,000 rows are shown: the limit on rows kept per execution was reached (Tools › Options › Query Results › SQL Server › Results to Grid). Execution continued.')
    // The grid hands it the snapshot whole, so its residence and the rows it can read are never left out.
    const grid = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'grid', 'ResultGrid.tsx'), 'utf8')
    expect(grid.match(/truncationText\(/g)).toHaveLength(2)
    expect(grid).toContain('truncationText({ ...snapshot, budget })')
  })

  it('falls back to the current half or whole budget without one', () => {
    expect(truncationText({ truncated: 'globalBudget', rowsStored: 10, rowsRead: 20, budget: now })).toContain('(1,024 MB)')
    expect(truncationText({ truncated: 'queryBudget', rowsStored: 10, rowsRead: 20, budget: now })).toContain('(512 MB)')
    expect(truncationText({ truncated: 'queryBudget', rowsStored: 10, rowsRead: 20 })).toContain('the result memory budget is full')
  })
})
