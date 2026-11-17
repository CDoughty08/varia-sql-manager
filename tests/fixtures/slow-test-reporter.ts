import type { Reporter, TestCase } from 'vitest/node'
import { cpus, tmpdir } from 'node:os'
import { readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Tests at least this long are listed; on a healthy runner almost every test takes well under a second. */
export const slowTestMs = 5000

/** One slow test's line: the file and name, its length, and when it ran in seconds from the check's start. */
export function slowTestLine(file: string, name: string, durationMs: number, endedAt: number, checkStarted: number | undefined): string {
  const span = checkStarted === undefined ? '' : ` at ${((endedAt - durationMs - checkStarted) / 1000).toFixed(1)}-${((endedAt - checkStarted) / 1000).toFixed(1)} s`
  return `Slow test (${(durationMs / 1000).toFixed(1)} s${span}): ${file} > ${name}`
}

/**
 * Lists the tests that took `slowTestMs` or more and when they ran. Windows CI's tests hit their 20 s bound after passing at
 * every length up to it, a starved worker rather than a hang; check.mjs prints when each lane ran on the same clock
 * (VARIA_CHECK_STARTED), so a timeout can be laid against the .NET build and offline checks running beside vitest.
 */
export default class SlowTestReporter implements Reporter {
  private readonly lines: string[] = []
  private readonly checkStarted = Number(process.env.VARIA_CHECK_STARTED) || undefined

  onTestCaseResult(test: TestCase): void {
    const { duration } = test.diagnostic() ?? { duration: 0 }
    if (duration >= slowTestMs) this.lines.push(slowTestLine(test.module.relativeModuleId, test.fullName, duration, Date.now(), this.checkStarted))
  }

  // TEMPORARY CI diagnostic: main's event-loop lag and the machine's idle CPU, every 2 s for the first 120 s or on a lag.
  private readonly diag: string[] = []
  onInit(): void {
    if (!process.env.CI) return
    // Which processes hold the CPU early in the check, when vitest workers stall.
    const ps = "Get-Counter '\Process(*)\% Processor Time' -SampleInterval 2 -MaxSamples 1 | ForEach-Object { $_.CounterSamples } | Sort-Object CookedValue -Descending | Select-Object -First 14 | ForEach-Object { '{0} {1:N0}' -f $_.InstanceName, $_.CookedValue }"
    for (const at of [12, 25, 35, 45]) setTimeout(() => {
      const since = ((Date.now() - (this.checkStarted ?? Date.now())) / 1000).toFixed(1)
      if (process.platform === 'win32') execFile('powershell', ['-NoProfile', '-Command', ps], (error, out) => this.diag.push(`processes at ${since} s: ${error ? error.message : out.trim().split(/\r?\n/).join(' | ')}`))
      else execFile('ps', ['-eo', 'pcpu,nice,comm', '--sort=-pcpu'], (error, out) => this.diag.push(`processes at ${since} s: ${error ? error.message : out.trim().split('\n').slice(0, 14).join(' | ')}`))
    }, at * 1000).unref()
    const idle = () => cpus().reduce((sum, cpu) => [sum[0] + cpu.times.idle, sum[1] + cpu.times.user + cpu.times.sys + cpu.times.idle + cpu.times.irq + cpu.times.nice], [0, 0])
    let last = performance.now(), before = idle(), cpu = process.cpuUsage(), ticks = 0
    setInterval(() => {
      const now = performance.now(), lag = now - last - 250, after = idle(), used = process.cpuUsage(cpu)
      const since = (Date.now() - (this.checkStarted ?? Date.now())) / 1000
      if (lag > 700 || (++ticks % 8 === 0 && since < 120)) this.diag.push(`main at ${since.toFixed(1)} s: lag ${lag.toFixed(0)} ms, machine idle ${(100 * (after[0] - before[0]) / Math.max(1, after[1] - before[1])).toFixed(0)}%, main cpu ${((used.user + used.system) / 1000).toFixed(0)} ms`)
      last = now; before = after; cpu = process.cpuUsage()
    }, 250).unref()
  }

  onTestRunEnd(): void {
    if (this.diag.length) console.log('\nDIAG\n' + this.diag.join('\n'))
    try { const dir = join(tmpdir(), 'varia-diag'); for (const name of readdirSync(dir)) console.log(readFileSync(join(dir, name), 'utf8').trimEnd()) } catch { /* none */ }
    if (this.lines.length) console.log('\n' + this.lines.join('\n'))
  }
}
