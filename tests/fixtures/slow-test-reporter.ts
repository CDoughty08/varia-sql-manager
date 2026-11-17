import type { Reporter, TestCase } from 'vitest/node'

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

  onTestRunEnd(): void {
    if (this.lines.length) console.log('\n' + this.lines.join('\n'))
  }
}
