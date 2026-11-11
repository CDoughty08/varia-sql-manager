import { describe, expect, it } from 'vitest'
import { readAudit, retryAfterSeconds } from '../scripts/audit.mjs'

// scripts/audit.mjs tells an advisory from an advisory endpoint that gave no report: a bare `npm audit` exits non-zero for
// both, which failed every pull request on an npm outage (#310).

const report = (counts: Record<string, number>, vulnerabilities: Record<string, unknown> = {}) =>
  JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts } } })

describe('dependency audit', () => {
  it('fails on a high or critical advisory and names the package and the advisory', () => {
    const result = readAudit(report({ high: 1, moderate: 1, total: 2 }, {
      undici: { name: 'undici', severity: 'high', via: [{ title: 'Request smuggling', url: 'https://github.com/advisories/GHSA-4w7w-5xrc-9h26', severity: 'high' }] },
      '@electron/get': { name: '@electron/get', severity: 'high', via: ['undici'] },
      minimatch: { name: 'minimatch', severity: 'moderate', via: [{ title: 'ReDoS', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249' }] }
    }))
    expect(result).toMatchObject({ kind: 'report', failed: true })
    expect(result.kind === 'report' && result.failing).toEqual([
      { name: 'undici', severity: 'high', advisories: ['https://github.com/advisories/GHSA-4w7w-5xrc-9h26'] },
      { name: '@electron/get', severity: 'high', advisories: ['through undici'] }
    ])
    expect(readAudit(report({ critical: 2, total: 2 }))).toMatchObject({ kind: 'report', failed: true })
  })
  it('passes with only moderate and low advisories, or none', () => {
    expect(readAudit(report({ moderate: 3, low: 1, total: 4 }))).toMatchObject({ kind: 'report', failed: false, failing: [] })
    expect(readAudit(report({}))).toMatchObject({ kind: 'report', failed: false })
  })
  it('reads an endpoint error, an empty reply or a partial report as no report, never as a pass or an advisory', () => {
    expect(readAudit(JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.', detail: '' } })))
      .toEqual({ kind: 'unavailable', reason: 'Your configured registry does not support audit requests.' })
    expect(readAudit(JSON.stringify({ error: { code: 'ETIMEDOUT' } }))).toEqual({ kind: 'unavailable', reason: 'ETIMEDOUT' })
    expect(readAudit('')).toMatchObject({ kind: 'unavailable' })
    expect(readAudit('<html>503 Service Unavailable</html>')).toMatchObject({ kind: 'unavailable' })
    expect(readAudit('null')).toMatchObject({ kind: 'unavailable' })
    expect(readAudit(JSON.stringify({ metadata: { vulnerabilities: { moderate: 1 } } }))).toMatchObject({ kind: 'unavailable' })
    expect(readAudit(JSON.stringify({ error: { summary: 'x'.repeat(1000) } }))).toEqual({ kind: 'unavailable', reason: 'x'.repeat(300) })
  })
  it('retries a missing report within the step\'s five minutes', () => {
    expect(retryAfterSeconds.length).toBeGreaterThan(0)
    // Each attempt is bounded at 60 s (scripts/audit.mjs).
    expect(retryAfterSeconds.reduce((sum, seconds) => sum + seconds, 0) + 60 * (retryAfterSeconds.length + 1)).toBeLessThan(300)
  })
})
