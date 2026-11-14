import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquire, entryMode, lockEnabled, sharedSlots, staleMs, type Held } from '../scripts/machine-lock.mjs'
import { cpuBudget, vitestWorkers } from '../scripts/check.mjs'

// Parallel agent sessions each ran npm run check, the benchmarks and the smoke suites at once and overloaded the machine:
// time-bounded tests missed their deadlines and smoke suites overwrote each other's clipboard. The machine lock queues them.

let dir: string
const held: Held[] = []
// Each acquire gets its own environment, as separate processes would: the test's own (under npm run check) holds the lock.
const env = (): Record<string, string | undefined> => ({})
const take = async (mode: 'shared' | 'exclusive', options: { logs?: string[], slots?: number, isAlive?: (pid: number) => boolean, beatMs?: number } = {}) => {
  const lock = await acquire(mode, { env: env(), dir, slots: options.slots ?? 2, pollMs: 10, beatMs: options.beatMs, log: text => options.logs?.push(text), isAlive: options.isAlive, label: mode })
  held.push(lock)
  return lock
}
const waiting = (logs: string[]) => vi.waitFor(() => expect(logs.join('\n')).toMatch(/Waiting for the machine lock/), { timeout: 10_000, interval: 10 })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'varia-lock-test-')) })
afterEach(() => {
  for (const lock of held.splice(0)) lock.release()
  rmSync(dir, { recursive: true, force: true })
})

describe('the machine lock', () => {
  it('lets the shared slots run together and queues the next shared run until one ends', async () => {
    const first = await take('shared')
    const second = await take('shared')
    expect(second.others).toBe(1)
    const logs: string[] = []
    let third = false
    const pending = take('shared', { logs }).then(lock => { third = true; return lock })
    await waiting(logs)
    expect(third).toBe(false)
    expect(logs[0]).toContain('do not stop it')
    first.release()
    await pending
    expect(third).toBe(true)
    second.release()
  })

  it('runs an exclusive run alone, ahead of shared runs that arrive while it waits', async () => {
    const shared = await take('shared')
    const exclusiveLogs: string[] = [], laterLogs: string[] = []
    let exclusiveHeld = false, laterHeld = false
    const exclusive = take('exclusive', { logs: exclusiveLogs }).then(lock => { exclusiveHeld = true; return lock })
    await waiting(exclusiveLogs)
    // A free shared slot remains, but the waiting exclusive run goes first.
    const later = take('shared', { logs: laterLogs }).then(lock => { laterHeld = true; return lock })
    await waiting(laterLogs)
    expect(exclusiveHeld).toBe(false)
    shared.release()
    const lock = await exclusive
    expect(laterHeld).toBe(false)
    lock.release()
    await later
    expect(laterHeld).toBe(true)
  })

  it('queues one exclusive run behind another', async () => {
    const first = await take('exclusive')
    const logs: string[] = []
    let second = false
    const pending = take('exclusive', { logs }).then(lock => { second = true; return lock })
    await waiting(logs)
    expect(logs[0]).toMatch(/held by exclusive \(pid \d+/)
    expect(second).toBe(false)
    first.release()
    await pending
    expect(second).toBe(true)
  })

  it('clears a holder whose process is gone or that stopped refreshing its file', async () => {
    const record = (pid: number) => JSON.stringify({ pid, mode: 'exclusive', label: 'killed run', cwd: dir, started: Date.now() })
    writeFileSync(join(dir, 'exclusive.lock'), record(424242))
    await take('shared', { isAlive: pid => pid !== 424242 })
    for (const lock of held.splice(0)) lock.release()
    // A live pid (Windows reuses a dead holder's soon) with a file nobody touched for longer than staleMs.
    writeFileSync(join(dir, 'exclusive.lock'), record(process.pid))
    const old = new Date(Date.now() - staleMs - 5000)
    utimesSync(join(dir, 'exclusive.lock'), old, old)
    await take('shared')
    expect(readdirSync(dir).sort()).toEqual(['shared-0.lock'])
  })

  // Runs with different VARIA_LOCK_SHARED settings used to see only their own slots: an exclusive run started beside a check.
  it('waits for every shared holder, whatever slot count it took', async () => {
    const first = await take('shared', { slots: 3 })
    const second = await take('shared', { slots: 3 })
    const third = await take('shared', { slots: 3 })
    expect(readdirSync(dir)).toContain('shared-2.lock')
    // Only the holder of shared-2 remains, a slot a run with the default count does not have.
    first.release()
    second.release()
    const logs: string[] = []
    let exclusive = false
    const pending = take('exclusive', { slots: 2, logs }).then(lock => { exclusive = true; return lock })
    await waiting(logs)
    expect(exclusive).toBe(false)
    third.release()
    await pending
    expect(exclusive).toBe(true)
  })

  // A machine that slept past staleMs let a waiter clear a live holder's file, and the holder ran on without it.
  it('takes back a file cleared while it still holds the lock', async () => {
    await take('exclusive', { beatMs: 10 })
    rmSync(join(dir, 'exclusive.lock'))
    await vi.waitFor(() => expect(existsSync(join(dir, 'exclusive.lock'))).toBe(true), { timeout: 10_000, interval: 10 })
  })

  it('removes its own file on release and leaves another holder alone', async () => {
    const lock = await take('exclusive')
    expect(JSON.parse(readFileSync(join(dir, 'exclusive.lock'), 'utf8'))).toMatchObject({ pid: process.pid, mode: 'exclusive' })
    lock.release()
    expect(existsSync(join(dir, 'exclusive.lock'))).toBe(false)
    const other = await take('shared')
    writeFileSync(join(dir, 'shared-0.lock'), JSON.stringify({ pid: process.pid + 1, label: 'someone else' }))
    other.release()
    expect(existsSync(join(dir, 'shared-0.lock'))).toBe(true)
  })

  it('stops listening for exit once released', async () => {
    const before = process.listenerCount('exit')
    const lock = await take('shared')
    expect(process.listenerCount('exit')).toBe(before + 1)
    lock.release()
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('stays out of CI, VARIA_LOCK=off and processes started under a holder', async () => {
    for (const skipped of [{ CI: 'true' }, { VARIA_LOCK: 'off' }, { VARIA_LOCK_HELD: 'shared' }]) {
      await acquire('exclusive', { env: skipped, dir: join(dir, 'unused') })
      expect(existsSync(join(dir, 'unused')), JSON.stringify(skipped)).toBe(false)
    }
    expect(lockEnabled({ CI: 'true' })).toBe(false)
    expect(lockEnabled({})).toBe(true)
    // The holder marks its environment so the processes it starts (vitest under check) never wait on it.
    const own: Record<string, string | undefined> = {}
    held.push(await acquire('shared', { env: own, dir }))
    expect(own.VARIA_LOCK_HELD).toBe('shared')
  })

  it('takes the exclusive tier only for smoke suites and benchmarks', () => {
    expect(entryMode('C:\\repo\\scripts\\results-smoke.mjs')).toBe('exclusive')
    expect(entryMode('/repo/scripts/ipc-bench.mjs')).toBe('exclusive')
    expect(entryMode('/repo/node_modules/vitest/vitest.mjs')).toBe(null)
    expect(entryMode('/repo/scripts/smoke-shards.mjs')).toBe(null)
    expect(sharedSlots({})).toBe(2)
    expect(sharedSlots({ VARIA_LOCK_SHARED: '3' })).toBe(3)
    expect(sharedSlots({ VARIA_LOCK_SHARED: 'x' })).toBe(2)
  })

  it('plans each check for its share of the machine, and for the whole machine in CI', () => {
    expect(cpuBudget({}, 24)).toBe(12)
    expect(cpuBudget({ VARIA_LOCK_SHARED: '3' }, 24)).toBe(8)
    expect(cpuBudget({ CI: 'true' }, 4)).toBe(4)
    expect(cpuBudget({ VARIA_CHECK_CPUS: '24' }, 24)).toBe(24)
    expect(cpuBudget({}, 1)).toBe(1)
    // Both vitest lanes run at once beside the build and the .NET lanes: vitest's default of every CPU but one, per lane,
    // put one check at about twice its budget.
    expect(vitestWorkers(12)).toEqual({ vitest: 9, 'vitest (Release backend)': 2 })
    expect(vitestWorkers(2)).toEqual({ vitest: 1, 'vitest (Release backend)': 1 })
    const source = readFileSync('scripts/check.mjs', 'utf8')
    expect(source).toMatch(/laneEnv\[lane\] = \{ VITEST_MAX_WORKERS: String\(workers\) \}/)
    expect(source).toMatch(/run\(node, steps\[node\], undefined, laneEnv\[node\]\)/)
  })

  it('runs a command under the lock and passes on its exit code', () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, VARIA_LOCK_DIR: dir }
    for (const name of ['CI', 'VARIA_LOCK', 'VARIA_LOCK_HELD']) delete childEnv[name]
    const result = spawnSync(process.execPath, ['scripts/machine-lock.mjs', 'shared', process.execPath, '-e', 'console.log(process.env.VARIA_LOCK_HELD); process.exit(3)'], { env: childEnv, encoding: 'utf8' })
    expect(result.status).toBe(3)
    expect(result.stdout.trim()).toBe('shared')
    expect(readdirSync(dir)).toEqual([])
    expect(spawnSync(process.execPath, ['scripts/machine-lock.mjs', 'everything'], { encoding: 'utf8' }).status).toBe(2)
  })

  // Every heavy entry point takes it: a suite or Electron benchmark that skipped the shared fixture would run beside everything.
  it('is taken by npm run check, backend:test, every smoke suite and every benchmark', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(scripts['backend:test']).toMatch(/^node scripts\/machine-lock\.mjs shared dotnet run /)
    expect(readFileSync('scripts/check.mjs', 'utf8')).toMatch(/await acquire\('shared'/)
    expect(readFileSync('scripts/fixtures/smoke.mjs', 'utf8')).toMatch(/^await holdForEntry\(\)$/m)
    expect(readFileSync('tests/bench/setup.ts', 'utf8')).toMatch(/await acquire\('exclusive'/)
    expect(scripts['test:smoke'].match(/scripts\/[\w-]+\.mjs/g).every((entry: string) => entryMode(entry) === 'exclusive')).toBe(true)
    // Every suite and Electron benchmark, in test:smoke or not: through the smoke fixture, or holdForEntry itself.
    const entries = readdirSync('scripts').filter(name => /-(smoke|bench)\.mjs$/.test(name)).map(name => `scripts/${name}`)
    for (const entry of entries.filter(file => /_electron|fixtures\/(smoke|dialog-lifecycle|session-prompts)\.mjs/.test(readFileSync(file, 'utf8')))) {
      expect(entryMode(entry), entry).toBe('exclusive')
      expect(readFileSync(entry, 'utf8'), entry).toMatch(/from '\.\/fixtures\/smoke\.mjs'|^await holdForEntry\(\)$/m)
    }
  })
})
