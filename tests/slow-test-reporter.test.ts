import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { slowTestLine, slowTestMs } from './fixtures/slow-test-reporter'

// Windows CI's vitest timeouts left only "Test timed out in 20000ms": nothing said what else ran on the runner meanwhile.
describe('slow-test report', () => {
  it('says when a slow test ran on the check clock', () => {
    expect(slowTestMs).toBe(5000)
    expect(slowTestLine('tests/menu-commands.test.ts', 'Object Explorer commands > refresh', 19_700, 1_000_300_000, 1_000_000_000))
      .toBe('Slow test (19.7 s at 280.3-300.0 s): tests/menu-commands.test.ts > Object Explorer commands > refresh')
    expect(slowTestLine('tests/a.test.ts', 'b', 6000, 10_000, undefined)).toBe('Slow test (6.0 s): tests/a.test.ts > b')
  })
  it('runs in every vitest run, and check.mjs gives every lane the clock and prints when each lane ran', async () => {
    expect(readFileSync('vitest.config.ts', 'utf8')).toContain("reporters: ['default', './tests/fixtures/slow-test-reporter.ts']")
    const { run, checkStarted } = await import('../scripts/check.mjs')
    const printed: string[] = []
    await run('clock lane', 'node -e "console.log(process.env.VARIA_CHECK_STARTED)"', (text: string) => printed.push(text))
    expect(printed.join('')).toMatch(new RegExp(`::group::clock lane \\([\\d.]+ s, [\\d.]+-[\\d.]+ s into the check\\)\\s+${checkStarted}\\s`))
  })
})
