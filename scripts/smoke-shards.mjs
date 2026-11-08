// Runs one CI shard of the smoke suites: `node scripts/smoke-shards.mjs <shard>/<count>`, for example 2/3. The suites are
// package.json's `test:smoke` list, so a suite added there runs locally and in exactly one shard. Every suite of the shard
// runs even after one fails, so one run reports them all.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The smoke suites in `test:smoke` order. */
export function smokeSuites() {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return scripts['test:smoke'].match(/scripts\/[\w-]+\.mjs/g)
}

/**
 * Seconds each suite took in CI's smoke jobs (PR #166's run, 2026-11-08, after within() stopped the idle timers: Linux under xvfb with SQL Server, Windows without), to balance the
 * shards on each platform; macOS uses Linux's. Every suite in `test:smoke` needs one on each platform
 * (tests/smoke-shards.test.ts); rough is fine, and each shard's summary prints the times to copy from.
 */
export const suiteSeconds = {
  linux: {
    'scripts/retained-plans-smoke.mjs': 20,
    'scripts/live-plan-smoke.mjs': 64,
    'scripts/electron-smoke.mjs': 20, 'scripts/layout-smoke.mjs': 9, 'scripts/popout-smoke.mjs': 7,
    'scripts/connections-smoke.mjs': 19, 'scripts/theme-smoke.mjs': 5, 'scripts/palette-smoke.mjs': 9,
    'scripts/backend-smoke.mjs': 34, 'scripts/live-smoke.mjs': 28, 'scripts/chart-smoke.mjs': 31,
    'scripts/live-grid-smoke.mjs': 21, 'scripts/activity-monitor-smoke.mjs': 38, 'scripts/menus-smoke.mjs': 70,
    'scripts/explorer-smoke.mjs': 54, 'scripts/scripting-smoke.mjs': 19, 'scripts/object-actions-smoke.mjs': 106,
    'scripts/results-smoke.mjs': 85, 'scripts/estimated-plans-smoke.mjs': 12, 'scripts/options-resize-smoke.mjs': 3, 'scripts/options-smoke.mjs': 12,
    'scripts/files-smoke.mjs': 15, 'scripts/hot-exit-smoke.mjs': 18, 'scripts/editor-smoke.mjs': 21,
    'scripts/table-designer-smoke.mjs': 5, 'scripts/document-frame-smoke.mjs': 16, 'scripts/ssis-smoke.mjs': 5,
    'scripts/ssis-operations-smoke.mjs': 18, 'scripts/updates-smoke.mjs': 6
  },
  windows: {
    'scripts/retained-plans-smoke.mjs': 20,
    'scripts/live-plan-smoke.mjs': 2,
    'scripts/electron-smoke.mjs': 18, 'scripts/layout-smoke.mjs': 8, 'scripts/popout-smoke.mjs': 15,
    'scripts/connections-smoke.mjs': 18, 'scripts/theme-smoke.mjs': 5, 'scripts/palette-smoke.mjs': 10,
    'scripts/backend-smoke.mjs': 30, 'scripts/live-smoke.mjs': 25, 'scripts/chart-smoke.mjs': 32,
    'scripts/live-grid-smoke.mjs': 21, 'scripts/activity-monitor-smoke.mjs': 29, 'scripts/menus-smoke.mjs': 73,
    'scripts/explorer-smoke.mjs': 42, 'scripts/scripting-smoke.mjs': 18, 'scripts/object-actions-smoke.mjs': 149,
    'scripts/results-smoke.mjs': 66, 'scripts/estimated-plans-smoke.mjs': 12, 'scripts/options-resize-smoke.mjs': 2, 'scripts/options-smoke.mjs': 13,
    'scripts/files-smoke.mjs': 13, 'scripts/hot-exit-smoke.mjs': 13, 'scripts/editor-smoke.mjs': 25,
    'scripts/table-designer-smoke.mjs': 7, 'scripts/document-frame-smoke.mjs': 22, 'scripts/ssis-smoke.mjs': 4,
    'scripts/ssis-operations-smoke.mjs': 18, 'scripts/updates-smoke.mjs': 6
  }
}

/**
 * The most one CI shard's suites may take on either platform, so a slow new suite fails tests/ci-workflow.test.ts instead of
 * quietly lengthening every run: speed it up, or add a shard to ci.yml's matrix (and its command).
 */
export const shardBudgetSeconds = 360

/** This machine's weights: Windows's on Windows, Linux's elsewhere. */
export const platformSeconds = (platform = process.platform) => suiteSeconds[platform === 'win32' ? 'windows' : 'linux']

/**
 * The most one suite may run before the shard kills it: four times its weight, at least five minutes. A hung suite used to run
 * to the job's 25 minute timeout and take every later suite in its shard with it (seven Linux runs on 2026-11-08). The
 * fixture's bounded app.close() catches most hangs first; this is the backstop for a suite stuck anywhere else.
 */
export const suiteLimitSeconds = (suite, platform = process.platform) => Math.max(300, 4 * (platformSeconds(platform)[suite] ?? 75))

/**
 * Every process under `root` (POSIX), read from ps: Playwright starts Electron with `detached`, so the app leads its own
 * process group, beyond the reach of a kill of the suite's group.
 */
function descendants(root) {
  let table
  try { table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }) } catch { return [] }
  const children = new Map()
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid > 0 && ppid > 0) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const found = [], queue = [root]
  while (queue.length) for (const pid of children.get(queue.shift()) ?? []) { found.push(pid); queue.push(pid) }
  return found
}

/** SIGKILL for each pid and the group it leads, if it leads one (a group's id is its leader's pid, never reused while it lives). */
function killAll(pids) {
  for (const pid of pids) for (const target of [-pid, pid]) { try { process.kill(target, 'SIGKILL') } catch { /* Already gone, or leads no group. */ } }
}

/**
 * Runs one suite, killing its whole process tree if it runs past `limitMs` or `signal` aborts. Killing only the suite's
 * node process (what spawnSync's timeout did) left its Electron app and backend running beside the shard's later suites,
 * holding the clipboard on Windows and SQL sessions on Linux: on Windows Electron runs under cmd.exe, a grandchild, and the
 * fixture kills it only from its exit handler, which SIGKILL skips. Windows: taskkill /T /F on the suite's tree. POSIX: the
 * suite leads its own process group, which gets SIGINT first, since Playwright's SIGINT handler closes the app and then
 * exits, and its exit handler kills the app's own group (its SIGTERM handler only starts a close, which a wedged main never
 * finishes). After `graceMs`, or once the suite has gone, every process the suite started, read before the SIGINT and again
 * then, gets SIGKILL with any group it leads, and so does the suite's group.
 */
export function runSuite(suite, limitMs, { graceMs = 5000, stdio = 'inherit', args = [], signal } = {}) {
  return new Promise(resolve => {
    const posix = process.platform !== 'win32'
    const child = spawn(process.execPath, [suite, ...args], { stdio, detached: posix })
    let timedOut = false, interrupted = false, stopping = false, grace, seen = []
    const finish = () => killAll([...new Set([child.pid, ...seen])])
    const stop = () => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return
      stopping = true
      if (!posix) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Already gone. */ }
        return
      }
      seen = descendants(child.pid)
      try { process.kill(-child.pid, 'SIGINT') } catch { /* Already gone. */ }
      grace = setTimeout(() => { seen = [...seen, ...descendants(child.pid)]; finish() }, graceMs)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, limitMs)
    const abort = () => { interrupted = true; stop() }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.once('error', error => { settle(); resolve({ status: null, signal: null, timedOut, interrupted, error }) })
    child.once('exit', (status, exitSignal) => {
      settle()
      // The suite has gone; on POSIX whatever it started, reparented now, still gets the SIGKILL.
      if (posix && stopping) { clearTimeout(grace); finish() }
      resolve({ status, signal: exitSignal, timedOut, interrupted })
    })
  })
}

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
  // A suite leads its own process group on POSIX, out of the terminal's reach, so Ctrl+C or a SIGTERM stops it here, tree and
  // all, before the shard ends.
  const interrupt = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => interrupt.abort())
  for (const suite of suites) {
    if (interrupt.signal.aborted) break
    const started = Date.now()
    if (process.env.GITHUB_ACTIONS) console.log(`::group::${suite}`)
    const limit = suiteLimitSeconds(suite)
    const { status, signal, timedOut } = await runSuite(suite, limit * 1000, { signal: interrupt.signal })
    if (process.env.GITHUB_ACTIONS) console.log('::endgroup::')
    results.push({ suite, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), code: timedOut ? `timed out at ${limit} s` : signal ?? status })
    if (timedOut) console.error(`${suite} ran past its ${limit} s limit and was killed; the shard's later suites still run.`)
    else if (status !== 0) console.error(`${suite} failed (${signal ?? `exit ${status}`}).`)
  }
  console.log(results.map(({ suite, ok, seconds, code }) => `${ok ? 'passed' : `FAILED (${code})`} ${String(seconds).padStart(4)} s  ${suite}`).join('\n'))
  if (interrupt.signal.aborted) {
    console.error('Interrupted: the running suite was stopped with its app, and the shard\'s later suites did not run.')
    process.exit(130)
  }
  if (results.some(result => !result.ok)) process.exitCode = 1
}
