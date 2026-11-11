import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

// The audit workflow's one step (.github/workflows/audit.yml, docs/ci.md): npm audit on the lockfile, failing on high and
// critical advisories only. A bare `npm audit` exits non-zero for an advisory and for an outage of npm's advisory endpoint
// alike, which once turned every pull request red on either; here an endpoint that gives no report is retried, then reported
// as a warning without failing, so only an advisory fails the run.

const blocking = ['high', 'critical']
const command = 'npm audit --package-lock-only --json --audit-level=high'
/** Seconds to wait before each further attempt: an endpoint outage is retried, then reported. */
export const retryAfterSeconds = [10, 30]

/**
 * What one `npm audit --json` run said: the advisory counts with the packages that fail the audit, or that the endpoint
 * gave no report (an error object, or output that is not the report at all).
 */
export function readAudit(stdout) {
  let report
  try { report = JSON.parse(stdout) } catch { return { kind: 'unavailable', reason: 'npm audit printed no JSON report' } }
  const counts = report?.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object' || !blocking.every(severity => Number.isInteger(counts[severity]))) {
    const error = report?.error
    return { kind: 'unavailable', reason: String(error?.summary || error?.code || report?.message || 'npm audit returned no advisory counts').slice(0, 300) }
  }
  const failing = Object.values(report.vulnerabilities ?? {}).filter(entry => blocking.includes(entry.severity)).map(entry => ({
    name: entry.name,
    severity: entry.severity,
    // A string names the package this one inherits the advisory from; an object is the advisory itself.
    advisories: (entry.via ?? []).map(via => typeof via === 'string' ? `through ${via}` : via.url || via.title).filter(Boolean)
  }))
  return { kind: 'report', counts, failing, failed: blocking.some(severity => counts[severity] > 0) }
}

function run() {
  // npm is a .cmd on Windows, which Node starts only through a shell; the command is constant.
  const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  return result.error ? { kind: 'unavailable', reason: result.error.message } : readAudit(result.stdout)
}

const annotate = (level, message) => console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`)

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (let attempt = 0; ; attempt++) {
    const result = run()
    if (result.kind === 'report') {
      const { counts, failing } = result
      console.log(`npm audit: ${counts.critical} critical, ${counts.high} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low.`)
      for (const entry of failing) console.log(`  ${entry.severity}: ${entry.name}${entry.advisories.length ? ` (${entry.advisories.join(', ')})` : ''}`)
      if (result.failed) {
        annotate('error', 'npm audit reports high or critical advisories: upgrade or override the package and add its floor to tests/dependency-floors.test.ts.')
        process.exitCode = 1
      }
      break
    }
    if (attempt === retryAfterSeconds.length) {
      annotate('warning', `npm audit gave no report after ${attempt + 1} attempts (${result.reason}), so nothing was audited. The advisory endpoint may be down; the next run audits again.`)
      break
    }
    console.log(`npm audit gave no report (${result.reason}); retrying in ${retryAfterSeconds[attempt]} s.`)
    await delay(retryAfterSeconds[attempt] * 1000)
  }
}
