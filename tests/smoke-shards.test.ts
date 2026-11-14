import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { platformSeconds, runSuite, shardSuites, smokeSuites, suiteSeconds } from '../scripts/smoke-shards.mjs'
import { acquire } from '../scripts/machine-lock.mjs'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('smoke shards', () => {
  it('weighs every suite in test:smoke on each platform, and only those', () => {
    for (const seconds of Object.values(suiteSeconds)) expect(Object.keys(seconds).sort()).toEqual([...smokeSuites()].sort())
    expect(platformSeconds('win32')).toBe(suiteSeconds.windows)
    expect(platformSeconds('linux')).toBe(suiteSeconds.linux)
    expect(platformSeconds('darwin')).toBe(suiteSeconds.linux)
  })
  it('splits the suites into shards of similar time, each in test:smoke order', () => {
    const suites = smokeSuites()
    for (const seconds of Object.values(suiteSeconds)) {
      const total = suites.reduce((sum, suite) => sum + seconds[suite], 0)
      for (const count of [1, 2, 3, 4]) {
        const shards = shardSuites(suites, count, seconds)
        expect(shards).toHaveLength(count)
        expect(shards.flat().sort()).toEqual([...suites].sort())
        for (const shard of shards) {
          expect(shard).toEqual(suites.filter(suite => shard.includes(suite)))
          // Longest first to the lightest shard stays within the longest suite of an even split.
          expect(shard.reduce((sum, suite) => sum + seconds[suite], 0)).toBeLessThanOrEqual(total / count + Math.max(...Object.values(seconds)))
        }
      }
    }
    expect(shardSuites(['b', 'a', 'c'], 2, { a: 5, b: 5, c: 9 })).toEqual([['c'], ['b', 'a']])
    expect(shardSuites(['new'], 1, {})).toEqual([['new']])
  })
  // Runs the hung suite, stopped by `stop`, and waits for its grandchild to have gone. On POSIX the grandchild leads its own
  // process group and the suite ignores SIGINT and SIGTERM, as Playwright's Electron and a suite whose close hangs do.
  async function stopHung(limitMs: number, signal?: AbortSignal, started?: (pidFile: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'varia-hung-suite-')), pidFile = join(dir, 'grandchild.pid')
    let pid = 0
    try {
      started?.(pidFile)
      const result = await runSuite('tests/fixtures/hung-suite.mjs', limitMs, { graceMs: 500, stdio: 'ignore', args: [pidFile], signal })
      expect(existsSync(pidFile), 'the grandchild started before the suite was stopped').toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8'))
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 })
      return result
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // A suite killed at its limit used to leave its Electron app (a grandchild, under cmd.exe on Windows, in a process group of
  // its own on POSIX) running beside the shard's later suites.
  it('kill a suite past its limit with its whole process tree', async () => {
    expect(await stopHung(4000)).toMatchObject({ timedOut: true, interrupted: false })
  }, 20000)
  // A suite leads its own process group on POSIX, so Ctrl+C at the terminal no longer reached it: the shard runner forwards it.
  it('stop a suite and its whole process tree when the shard is interrupted', async () => {
    const interrupt = new AbortController()
    const result = await stopHung(60_000, interrupt.signal, pidFile => {
      const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); interrupt.abort() } }, 50)
    })
    expect(result).toMatchObject({ timedOut: false, interrupted: true })
    const source = readFileSync('scripts/smoke-shards.mjs', 'utf8')
    expect(source).toMatch(/for \(const name of \['SIGINT', 'SIGTERM'\]\) process\.on\(name, \(\) => interrupt\.abort\(\)\)/)
    expect(source).toContain('await runSuite(suite, limit * 1000, { signal: interrupt.signal })')
  }, 20000)
  it('let a suite that ends in time end by itself', async () => {
    expect(await runSuite('tests/fixtures/hung-suite.mjs', 15000, { stdio: 'ignore', args: ['--exit', '3'] })).toEqual({ status: 3, signal: null, timedOut: false, interrupted: false })
  }, 20000)

  function queuedFixture() {
    mkdirSync('artifacts', { recursive: true })
    const dir = mkdtempSync(resolve('artifacts', 'suite-lock-')), lockDir = join(dir, 'lock'), marker = join(dir, 'started')
    const env = { ...process.env, CI: 'false', VARIA_LOCK: 'on', VARIA_LOCK_HELD: undefined, VARIA_LOCK_DIR: lockDir }
    return { dir, lockDir, marker, env }
  }

  it('queues before arming the execution watchdog, then passes and releases only its own inherited lease', async () => {
    const { dir, lockDir, marker, env } = queuedFixture()
    const blocker = await acquire('shared', { env: {}, dir: lockDir })
    const parentFlag = process.env.VARIA_LOCK_HELD, timer = vi.spyOn(globalThis, 'setTimeout'), limitMs = 9973
    const running = runSuite('tests/fixtures/queued-smoke.mjs', limitMs, { stdio: 'ignore', args: [marker, '3'], env })
    try {
      await vi.waitFor(() => expect(existsSync(join(lockDir, 'exclusive.lock'))).toBe(true))
      expect(timer.mock.calls.some(([, ms]) => ms === limitMs)).toBe(false)
      expect(existsSync(marker)).toBe(false)
      expect(env.VARIA_LOCK_HELD).toBeUndefined()
      blocker.release()
      expect(await running).toEqual({ status: 3, signal: null, timedOut: false, interrupted: false })
      expect(timer.mock.calls.filter(([, ms]) => ms === limitMs)).toHaveLength(1)
      expect(readFileSync(marker, 'utf8')).toBe('exclusive')
      expect(readdirSync(lockDir)).toEqual([])
      expect(process.env.VARIA_LOCK_HELD).toBe(parentFlag)
      expect(env.VARIA_LOCK_HELD).toBeUndefined()
    } finally { blocker.release(); await running; timer.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('interrupts a queued suite without launching it or removing the shared holder', async () => {
    const { dir, lockDir, marker, env } = queuedFixture()
    const blocker = await acquire('shared', { env: {}, dir: lockDir }), shared = join(lockDir, 'shared-0.lock')
    const originalHolder = readFileSync(shared, 'utf8'), listeners = process.listenerCount('exit'), interrupt = new AbortController()
    const running = runSuite('tests/fixtures/queued-smoke.mjs', 9973, { stdio: 'ignore', args: [marker], env, signal: interrupt.signal })
    try {
      await vi.waitFor(() => expect(existsSync(join(lockDir, 'exclusive.lock'))).toBe(true))
      interrupt.abort()
      expect(await running).toEqual({ status: null, signal: null, timedOut: false, interrupted: true })
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(lockDir, 'exclusive.lock'))).toBe(false)
      expect(readFileSync(shared, 'utf8')).toBe(originalHolder)
      expect(process.listenerCount('exit')).toBe(listeners)
    } finally { interrupt.abort(); await running; blocker.release(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports pre-start interruption and acquisition errors without aborting subsequent suites', async () => {
    const { dir, lockDir, marker, env } = queuedFixture(), interrupt = new AbortController()
    try {
      interrupt.abort()
      expect(await runSuite('tests/fixtures/queued-smoke.mjs', 9973, { stdio: 'ignore', args: [marker], env, signal: interrupt.signal }))
        .toEqual({ status: null, signal: null, timedOut: false, interrupted: true })
      expect(existsSync(lockDir)).toBe(false)
      expect(existsSync(marker)).toBe(false)
      writeFileSync(lockDir, 'not a directory')
      const failed = await runSuite('tests/fixtures/queued-smoke.mjs', 9973, { stdio: 'ignore', args: [marker], env })
      expect(failed).toMatchObject({ status: null, timedOut: false, interrupted: false, error: expect.any(Error) })
      rmSync(lockDir)
      expect(await runSuite('tests/fixtures/queued-smoke.mjs', 9973, { stdio: 'ignore', args: [marker], env }))
        .toEqual({ status: 0, signal: null, timedOut: false, interrupted: false })
      expect(readFileSync(marker, 'utf8')).toBe('exclusive')
      expect(readdirSync(lockDir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
