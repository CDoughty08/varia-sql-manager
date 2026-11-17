import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { completeLines, parseCalls } from '../scripts/fixtures/call-log.mjs'

describe('the smoke suites\' call log reader', () => {
  const first = JSON.stringify({ generation: 1, method: 'query.execute', params: { sql: 'SELECT 1;' } })
  const second = JSON.stringify({ generation: 1, method: 'query.session.close', params: { sessionId: 'a' } })

  it('reads every complete line', () => {
    expect(parseCalls('')).toEqual([])
    expect(parseCalls(`${first}\n${second}\n`).map(call => call.method)).toEqual(['query.execute', 'query.session.close'])
    expect(completeLines(`${first}\n\n${second}\n`)).toEqual([first, second])
  })

  // Smoke (Linux 1/3) failed with "Unterminated string in JSON" when a poll read the log while the backend appended to it.
  it('leaves a line still being appended for the next read, at whatever byte the read caught it', () => {
    for (let cut = 0; cut < second.length; cut++) {
      expect(parseCalls(`${first}\n${second.slice(0, cut)}`), `cut at ${cut}`).toEqual([JSON.parse(first)])
    }
    // Complete but for its newline: still being written, and read once the newline is there.
    expect(parseCalls(`${first}\n${second}`)).toHaveLength(1)
    expect(parseCalls(first.slice(0, 20))).toEqual([])
  })

  it('is how electron-smoke.mjs reads the log its polls watch', () => {
    const source = readFileSync('scripts/electron-smoke.mjs', 'utf8')
    expect(source).toContain("import { parseCalls } from './fixtures/call-log.mjs'")
    expect(source).toContain("const calls = async () => parseCalls(await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => ''))")
    expect(source).not.toMatch(/calls\.jsonl.*JSON\.parse/)
  })

  // ssis-operations-smoke and options-smoke split calls.jsonl themselves and failed the same way.
  it('is how every smoke suite and fixture parses a log split into lines', () => {
    // A split on '\n' or /\n/ followed, within the same statement (across lines too), by a JSON.parse.
    const splitsAndParses = (text: string) => /split\((?:(['"])\\n\1|\/\\n\/)\)[^;]{0,200}?JSON\.parse/.test(text)
    expect(splitsAndParses("const calls = async () => (await readFile(log, 'utf8')).split('\\n').filter(Boolean).map(line => JSON.parse(line))")).toBe(true)
    expect(splitsAndParses('const calls = text.split(/\\n/)\n  .filter(Boolean)\n  .map(line => JSON.parse(line))')).toBe(true)
    expect(splitsAndParses("const calls = parseCalls(await readFile(log, 'utf8'))")).toBe(false)
    const offenders = ['scripts', 'scripts/fixtures'].flatMap(folder => readdirSync(folder).filter(name => name.endsWith('.mjs')).map(name => `${folder}/${name}`))
      .filter(path => path !== 'scripts/fixtures/call-log.mjs' && splitsAndParses(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
