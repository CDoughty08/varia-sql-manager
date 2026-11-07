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
 * Seconds each suite took in CI's smoke jobs (PR #99's run: Linux under xvfb with SQL Server, Windows without), to balance the
 * shards on each platform; macOS uses Linux's. Every suite in `test:smoke` needs one on each platform
 * (tests/smoke-shards.test.ts); rough is fine, and each shard's summary prints the times to copy from.
 */
export const suiteSeconds = {
  linux: {
    'scripts/live-plan-smoke.mjs': 25,
    'scripts/electron-smoke.mjs': 20, 'scripts/layout-smoke.mjs': 15, 'scripts/popout-smoke.mjs': 12, 'scripts/connections-smoke.mjs': 22,
    'scripts/theme-smoke.mjs': 5, 'scripts/palette-smoke.mjs': 10, 'scripts/backend-smoke.mjs': 51,
    'scripts/live-smoke.mjs': 40, 'scripts/chart-smoke.mjs': 45, 'scripts/live-grid-smoke.mjs': 36,
    'scripts/activity-monitor-smoke.mjs': 51, 'scripts/menus-smoke.mjs': 79, 'scripts/explorer-smoke.mjs': 35,
    'scripts/scripting-smoke.mjs': 23, 'scripts/object-actions-smoke.mjs': 36, 'scripts/results-smoke.mjs': 83,
    'scripts/options-resize-smoke.mjs': 2, 'scripts/options-smoke.mjs': 11, 'scripts/files-smoke.mjs': 14, 'scripts/hot-exit-smoke.mjs': 9,
    'scripts/editor-smoke.mjs': 21, 'scripts/table-designer-smoke.mjs': 5, 'scripts/document-frame-smoke.mjs': 18,
    'scripts/ssis-smoke.mjs': 6, 'scripts/ssis-operations-smoke.mjs': 18, 'scripts/updates-smoke.mjs': 20
  },
  windows: {
    'scripts/live-plan-smoke.mjs': 2,
    'scripts/electron-smoke.mjs': 19, 'scripts/layout-smoke.mjs': 13, 'scripts/popout-smoke.mjs': 12, 'scripts/connections-smoke.mjs': 20,
    'scripts/theme-smoke.mjs': 6, 'scripts/palette-smoke.mjs': 6, 'scripts/backend-smoke.mjs': 48,
    'scripts/live-smoke.mjs': 39, 'scripts/chart-smoke.mjs': 45, 'scripts/live-grid-smoke.mjs': 36,
    'scripts/activity-monitor-smoke.mjs': 44, 'scripts/menus-smoke.mjs': 94, 'scripts/explorer-smoke.mjs': 25,
    'scripts/scripting-smoke.mjs': 15, 'scripts/object-actions-smoke.mjs': 68, 'scripts/results-smoke.mjs': 55,
    'scripts/options-resize-smoke.mjs': 2, 'scripts/options-smoke.mjs': 8, 'scripts/files-smoke.mjs': 15, 'scripts/hot-exit-smoke.mjs': 9,
    'scripts/editor-smoke.mjs': 19, 'scripts/table-designer-smoke.mjs': 4, 'scripts/document-frame-smoke.mjs': 14,
    'scripts/ssis-smoke.mjs': 6, 'scripts/ssis-operations-smoke.mjs': 18, 'scripts/updates-smoke.mjs': 20
  }
}

/**
 * The most one CI shard's suites may take on either platform, so a slow new suite fails tests/ci-workflow.test.ts instead of
 * quietly lengthening every run: speed it up, or add a shard to ci.yml's matrix (and its command).
 */
export const shardBudgetSeconds = 360

/** This machine's weights: Windows's on Windows, Linux's elsewhere. */
export const platformSeconds = (platform = process.platform) => suiteSeconds[platform === 'win32' ? 'windows' : 'linux']

/** Splits `suites` into `count` shards of similar time (longest first, each to the lightest shard), each in suite order. */
export function shardSuites(suites, count, seconds = platformSeconds()) {
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
