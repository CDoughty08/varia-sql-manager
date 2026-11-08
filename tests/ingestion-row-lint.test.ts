import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Query execution reads every row through ColumnPlan.ReadRow. A capturing lambda written in its arguments allocates a delegate
// for every row (about 1–5% of ingestion on wide results), so the loop passes one made once per execution. No check can see that
// from the rows themselves; PageChecks covers the other per-row cost, PageBuilder.WorkingBytes, by measuring its allocations.
const root = join(__dirname, '..', 'backend', 'Varia.Backend')

it('passes ColumnPlan.ReadRow a warning delegate made once, not a lambda per row', () => {
  const source = readFileSync(join(root, 'SqlService.cs'), 'utf8')
  const calls = [...source.matchAll(/\.ReadRow\(([^;]*)\)/g)].map(match => match[1])
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.filter(args => args.includes('=>'))).toEqual([])
  expect(source).toMatch(/Action<string> warn = text => messages\.Add\(text\);/)
})
