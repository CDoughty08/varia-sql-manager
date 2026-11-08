import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformSeconds, runSuite, shardSuites, smokeSuites, suiteSeconds } from '../scripts/smoke-shards.mjs'

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
})
