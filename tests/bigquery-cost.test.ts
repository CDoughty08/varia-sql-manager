import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { formatBytes, formatDollars, processedFact } from '../src/shared/bigquery/cost'
import { runSummary } from '../src/renderer/src/results/status'

// The backend's BigQueryCost reads the same file (BigQueryExecutionChecks), so both write the same text.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bigquery/cost.json', import.meta.url), 'utf8')) as { cases: { bytes: number; text: string; dollars: string }[] }

describe('BigQuery cost text', () => {
  it('writes bytes in binary units and on-demand dollars as the backend does', () => {
    expect(fixture.cases.length).toBeGreaterThan(10)
    for (const { bytes, text, dollars } of fixture.cases) {
      expect(formatBytes(bytes), String(bytes)).toBe(text)
      expect(formatDollars(bytes), String(bytes)).toBe(dollars)
    }
  })

  it('shows the bytes processed beside the row count in the Results status', () => {
    const base = { status: 'completed' as const, elapsedMs: 1200, rows: 3, completedBatches: 1, totalBatches: 1 }
    expect(runSummary(base).facts.some(fact => fact.includes('processed'))).toBe(false)
    const facts = runSummary({ ...base, bytesProcessed: 1331439862 }).facts
    expect(facts[1]).toBe(processedFact(1331439862))
    expect(facts[1]).toBe('1.24 GiB processed · < $0.01')
    expect(runSummary({ ...base, bytesProcessed: 0 }).facts[1]).toBe('0 B processed · $0.00')
  })
})
