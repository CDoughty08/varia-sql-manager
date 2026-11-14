// npm run check: the type check, the offline .NET checks, vitest and the production build, as concurrent lanes.
// They used to run one after another (about 205 s in CI, 137 s on a 24-core desktop); only the vitest files that start the
// Release backend wait for its build, and nothing reads out/. Each lane's output is held and printed whole when it ends, so
// logs stay readable, and the summary's per-lane seconds show which lane to look at when the check grows (docs/ci.md). A
// check stopped by a signal (CI's step timeout) prints what its running lanes held first, so a hang still shows where it was.
//
// With 8 or more CPUs every lane runs at once. CI's runners have 3 or 4, where that starved the time-bounded tests (tsc took
// 66 s instead of 5 on macOS, and polls of 1 to 3 s missed), so there the lanes run as two chains side by side: tsc and
// vitest; and the .NET build, the offline checks, the vitest files that need the Release backend, then the electron-vite
// build, which balances the two chains (vitest is the longest lane). VARIA_CHECK_CPUS=<n> overrides the CPU count, to try
// either layout. VARIA_CHECK_SKIP=typecheck leaves out the type check: CI's Windows and macOS jobs, since Linux's proves it.
//
// Off CI the check first takes the machine lock's shared tier (scripts/machine-lock.mjs), so parallel sessions' checks wait
// rather than pile up, and plans for its share of the machine: the CPUs divided among the shared slots, which also caps
// each vitest lane's workers (vitestWorkers). Two checks at once then about fill the machine rather than oversubscribe it;
// VARIA_CHECK_CPUS and VITEST_MAX_WORKERS still win.
//
//   node scripts/check.mjs          the whole check
//   node scripts/check.mjs --build  npm run build:smoke: the Release backend and electron-vite build, side by side
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { pathToFileURL } from 'node:url'
import { acquire, lockEnabled, sharedSlots } from './machine-lock.mjs'
// The vitest files that start backend/Varia.Backend/bin/Release: tests/backend-sidecar.test.ts, and the live files when
// VARIA_TEST_SQL_SERVER is set. A new file that spawns the Release backend belongs here.
export const needsBackend = readdirSync('tests').filter(name => name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')).map(name => `tests/${name}`)

export const steps = {
  'Type check': 'npx tsc --noEmit',
  // Then main and preload must load nothing but Electron and Node's own modules (scripts/packaged-contents.mjs).
  'electron-vite build': 'npx electron-vite build && node scripts/packaged-contents.mjs',
  vitest: `npx vitest run ${needsBackend.map(file => `--exclude ${file}`).join(' ')}`,
  'Release build (.NET)': 'dotnet build backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release --nologo -v q',
  'Offline .NET checks': 'dotnet run --no-build --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release',
  'vitest (Release backend)': `npx vitest run ${needsBackend.join(' ')}`,
  'Release backend': 'dotnet build backend/Varia.Backend/Varia.Backend.csproj --configuration Release --nologo -v q'
}

/**
 * The check's layout: a step name, `{ all }` (side by side), `{ chain }` (one after another, each whatever the last one's
 * outcome, so one failure hides nothing) or `{ gate, then }` (`then` only if `gate` passed: nothing runs on a failed build).
 */
export function plan({ cpus, build = false, skip = [] }) {
  if (build) return { all: ['Release backend', 'electron-vite build'] }
  const wide = cpus >= 8
  const typecheck = skip.includes('typecheck') ? [] : ['Type check']
  const dotnet = { gate: 'Release build (.NET)', then: wide ? { all: ['Offline .NET checks', 'vitest (Release backend)'] } : { chain: ['Offline .NET checks', 'vitest (Release backend)'] } }
  return wide
    ? { all: [...typecheck, 'electron-vite build', 'vitest', dotnet] }
    : { all: [{ chain: [...typecheck, 'vitest'] }, { chain: [dotnet, 'electron-vite build'] }] }
}

/**
 * The CPUs the check plans for: VARIA_CHECK_CPUS when set, otherwise the machine's, divided among the machine lock's shared
 * slots when the lock applies (each check gets its share, so concurrent checks never oversubscribe the machine).
 */
export function cpuBudget(env = process.env, machine = availableParallelism()) {
  if (Number(env.VARIA_CHECK_CPUS)) return Number(env.VARIA_CHECK_CPUS)
  return lockEnabled(env) ? Math.max(1, Math.floor(machine / sharedSlots(env))) : machine
}

/**
 * The vitest workers each vitest lane gets within a CPU budget. In the wide layout both run beside the type check, the
 * build and the .NET lanes, so the main lane leaves room for those and the Release-backend files (one file without a server)
 * get two; vitest's own default (every CPU but one, per lane) would put one check at about twice its budget.
 */
export function vitestWorkers(cpus) {
  return { vitest: Math.max(1, cpus - 3), 'vitest (Release backend)': Math.min(2, Math.max(1, cpus - 1)) }
}

/** Each lane's extra environment: set in the main block when the machine lock applies. */
const laneEnv = {}

/** The lanes VARIA_CHECK_SKIP may leave out, by the name it takes. */
export const skippable = { typecheck: 'Type check' }

/**
 * VARIA_CHECK_SKIP's entries, trimmed. Any name other than the skippable ones is refused, so a typo cannot skip nothing
 * while the summary reports it skipped.
 */
export function parseSkip(value = '') {
  const skip = value.split(',').map(entry => entry.trim()).filter(Boolean)
  const unknown = skip.filter(entry => !Object.hasOwn(skippable, entry))
  if (unknown.length) throw new Error(`VARIA_CHECK_SKIP: unknown ${unknown.length > 1 ? 'names' : 'name'} ${unknown.map(entry => `'${entry}'`).join(', ')}; it takes a comma-separated list of ${Object.keys(skippable).join(', ')}`)
  return skip
}

/** The summary's note of the lanes left out: only those the layout actually dropped. */
export function skippedNote(layout, skip) {
  const names = new Set()
  const walk = node => { if (typeof node === 'string') names.add(node); else if (node.all) node.all.forEach(walk); else if (node.chain) node.chain.forEach(walk); else { walk(node.gate); walk(node.then) } }
  walk(layout)
  const left = [...new Set(skip)].filter(entry => !names.has(skippable[entry]))
  return left.length ? ` (skipped: ${left.join(', ')}, VARIA_CHECK_SKIP)` : ''
}

/** The lanes still running, so a signal can print what they held. */
export const running = new Set()

export const run = (name, command, write = text => process.stdout.write(text), env = {}) => new Promise(resolve => {
  const started = performance.now(), output = []
  const child = spawn(command, { shell: true, env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', ...env } })
  const lane = { name, started, output, child }
  running.add(lane)
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  child.on('close', code => {
    running.delete(lane)
    const seconds = (performance.now() - started) / 1000
    write(`\n::group::${name} (${seconds.toFixed(1)} s${code ? `, exit ${code}` : ''})\n${Buffer.concat(output).toString()}\n::endgroup::\n`)
    resolve({ name, code: code ?? 1, seconds })
  })
})

/** Prints every running lane's output so far and stops it: what a timed-out step would otherwise lose. */
export function flushRunning(write = text => process.stdout.write(text)) {
  for (const lane of [...running]) {
    running.delete(lane)
    lane.child.removeAllListeners('close')
    write(`\n::group::${lane.name} (still running after ${((performance.now() - lane.started) / 1000).toFixed(1)} s)\n${Buffer.concat(lane.output).toString()}\n::endgroup::\n`)
    lane.child.kill()
  }
}

const execute = node => {
  if (typeof node === 'string') return run(node, steps[node], undefined, laneEnv[node]).then(result => [result])
  if (node.all) return Promise.all(node.all.map(execute)).then(results => results.flat())
  if (node.chain) return (async () => { const results = []; for (const item of node.chain) results.push(...await execute(item)); return results })()
  return execute(node.gate).then(async results => results.some(result => result.code) ? results : [...results, ...await execute(node.then)])
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cpus = cpuBudget()
  let skip
  try { skip = parseSkip(process.env.VARIA_CHECK_SKIP) } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const build = process.argv.includes('--build')
  const { others } = await acquire('shared', { label: build ? 'npm run build:smoke' : 'npm run check' })
  if (lockEnabled() && !process.env.VITEST_MAX_WORKERS) for (const [lane, workers] of Object.entries(vitestWorkers(cpus))) laneEnv[lane] = { VITEST_MAX_WORKERS: String(workers) }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    console.log(`\nCheck stopped by ${signal}; the lanes still running held:`)
    flushRunning()
    process.exit(1)
  })
  const started = performance.now()
  const layout = plan({ cpus, build, skip })
  const results = await execute(layout)
  const failed = results.filter(result => result.code)
  const skipped = build ? '' : skippedNote(layout, skip)
  console.log(`
${failed.length ? 'Check failed' : 'Check passed'} in ${((performance.now() - started) / 1000).toFixed(1)} s (${cpus} CPUs, ${cpus >= 8 ? 'every lane at once' : 'two chains'}${others ? `, beside ${others} other ${others > 1 ? 'checks' : 'check'}` : ''})${skipped}: ` + results.map(({ name, seconds, code }) => `${name} ${seconds.toFixed(1)} s${code ? ' FAILED' : ''}`).join(', '))
  process.exitCode = failed.length ? 1 : 0
}
