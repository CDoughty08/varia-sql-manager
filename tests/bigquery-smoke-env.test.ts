import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A smoke suite that points the app at a loopback REST fake must not pass on a developer's local
// VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT: main forwards it, and the app would then read results from an emulator the fake
// knows nothing about. connections-smoke runs against the real emulator, whose Storage Read endpoint belongs with it.
describe('BigQuery smoke suites on a REST fake', () => {
  it('drop a local Storage Read endpoint from the app\'s environment', () => {
    const suites = readdirSync('scripts').filter(name => name.startsWith('bigquery-') && name.endsWith('-smoke.mjs'))
    expect(suites.length).toBeGreaterThanOrEqual(3)
    for (const suite of suites) {
      const text = readFileSync(`scripts/${suite}`, 'utf8')
      expect(text, suite).toMatch(/VARIA_TEST_BIGQUERY_ENDPOINT: /)
      expect(text, suite).toContain('delete env.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT')
    }
  })
})
