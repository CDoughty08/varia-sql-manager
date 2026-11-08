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
  // A suite killed at its limit used to leave its Electron app (a grandchild, under cmd.exe on Windows) running beside the
  // shard's later suites.
  it('kill a suite past its limit with its whole process tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'varia-hung-suite-')), pidFile = join(dir, 'grandchild.pid')
    let pid = 0
    try {
      const result = await runSuite('tests/fixtures/hung-suite.mjs', 4000, { graceMs: 500, stdio: 'ignore', args: [pidFile] })
      expect(result.timedOut).toBe(true)
      expect(existsSync(pidFile), 'the grandchild started before the limit').toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8'))
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 })
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
  it('let a suite that ends in time end by itself', async () => {
    expect(await runSuite('tests/fixtures/hung-suite.mjs', 15000, { stdio: 'ignore', args: ['--exit', '3'] })).toEqual({ status: 3, signal: null, timedOut: false })
  }, 20000)
})
