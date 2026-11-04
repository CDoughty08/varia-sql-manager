// Runs one CI shard of the smoke suites: `node scripts/smoke-shards.mjs <shard>/<count>`, for example 2/3. The suites are
// package.json's `test:smoke` list, so a suite added there runs locally and in exactly one shard. Every suite of the shard
// runs even after one fails, so one run reports them all.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The smoke suites in `test:smoke` order. */
export function smokeSuites() {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return scripts['test:smoke'].match(/scripts\/[\w-]+\.mjs/g)
}

/**
 * Seconds each suite took on Windows with live SQL Server checks skipped (2026-11), to balance the shards. Every suite in
 * `test:smoke` needs one (tests/smoke-shards.test.ts); rough is fine.
 */
export const suiteSeconds = {
  'scripts/electron-smoke.mjs': 12, 'scripts/layout-smoke.mjs': 6, 'scripts/connections-smoke.mjs': 14, 'scripts/theme-smoke.mjs': 3,
  'scripts/palette-smoke.mjs': 5, 'scripts/backend-smoke.mjs': 40, 'scripts/live-smoke.mjs': 39, 'scripts/chart-smoke.mjs': 44,
  'scripts/live-grid-smoke.mjs': 38, 'scripts/activity-monitor-smoke.mjs': 43, 'scripts/menus-smoke.mjs': 80, 'scripts/explorer-smoke.mjs': 22,
  'scripts/scripting-smoke.mjs': 12, 'scripts/object-actions-smoke.mjs': 21, 'scripts/results-smoke.mjs': 50, 'scripts/options-resize-smoke.mjs': 3,
  'scripts/options-smoke.mjs': 6, 'scripts/files-smoke.mjs': 12, 'scripts/editor-smoke.mjs': 10, 'scripts/table-designer-smoke.mjs': 3,
  'scripts/document-frame-smoke.mjs': 13, 'scripts/ssis-smoke.mjs': 4, 'scripts/ssis-operations-smoke.mjs': 18, 'scripts/updates-smoke.mjs': 20
}

/** Splits `suites` into `count` shards of similar time (longest first, each to the lightest shard), each in suite order. */
export function shardSuites(suites, count, seconds = suiteSeconds) {
  const shards = Array.from({ length: count }, () => ({ total: 0, suites: new Set() }))
  const order = suites.map((suite, index) => ({ suite, index, weight: seconds[suite] ?? 30 })).sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const { suite, weight } of order) {
    const lightest = shards.reduce((best, shard) => shard.total < best.total ? shard : best)
    lightest.total += weight
    lightest.suites.add(suite)
  }
  return shards.map(shard => suites.filter(suite => shard.suites.has(suite)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '')
  const shard = Number(match?.[1]), count = Number(match?.[2])
  if (!match || shard < 1 || shard > count) {
    console.error('Usage: node scripts/smoke-shards.mjs <shard>/<count>, for example 2/3')
    process.exit(2)
  }
  const suites = shardSuites(smokeSuites(), count)[shard - 1], results = []
  console.log(`Smoke shard ${shard}/${count}: ${suites.join(', ')}`)
  for (const suite of suites) {
    const started = Date.now()
    if (process.env.GITHUB_ACTIONS) console.log(`::group::${suite}`)
    const { status, signal } = spawnSync(process.execPath, [suite], { stdio: 'inherit' })
    if (process.env.GITHUB_ACTIONS) console.log('::endgroup::')
    results.push({ suite, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), code: signal ?? status })
    if (status !== 0) console.error(`${suite} failed (${signal ?? `exit ${status}`}).`)
  }
  console.log(results.map(({ suite, ok, seconds, code }) => `${ok ? 'passed' : `FAILED (${code})`} ${String(seconds).padStart(4)} s  ${suite}`).join('\n'))
  if (results.some(result => !result.ok)) process.exitCode = 1
}
