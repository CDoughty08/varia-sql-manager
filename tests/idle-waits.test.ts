import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Time CI spent waiting rather than working (docs/ci.md): timers that outlived the app they raced, offline checks that
// waited out a refused connection, and check lanes that waited for a build they did not need.

const scripts = ['scripts', 'scripts/fixtures'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => join(dir, name)))

describe('idle waits', () => {
  // A suite that races app.close() or a process exit against a bare timer keeps Node alive for the timer's full length
  // after the app has gone: 10 to 30 s per suite, about 2 minutes of each OS's smoke run, before within() replaced them.
  it('never race a close or an exit against a timer that outlives it', () => {
    const offenders = scripts.flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
      if (!/Promise\.race\(/.test(line) || !/close\(\)|exit|exited/.test(line)) return []
      const timer = /setTimeout\(|\bsleep\(|\bwait\(|\bdelay\(/.test(line)
      return timer && !/ref: false/.test(line) ? [`${file}:${index + 1}`] : []
    }))
    expect(offenders).toEqual([])
    expect(scripts.filter(file => /within\(/.test(readFileSync(file, 'utf8'))).length).toBeGreaterThanOrEqual(10)
  })
  // Windows retries a refused TCP connection for about a second; a missing named pipe fails at once (Unreachable.cs).
  it('fail the offline checks\' connections without a real TCP address', () => {
    const dir = 'backend/Varia.Backend.Tests'
    const offenders = readdirSync(dir).filter(name => name.endsWith('.cs') && name !== 'Unreachable.cs' && /tcp:127\.0\.0\.1,1\b/.test(readFileSync(join(dir, name), 'utf8')))
    expect(offenders).toEqual([])
  })
  // A test that builds 50,000 or more rows ran past vitest's 20 s default on a shared Windows runner (3 to 4 s locally):
  // it passes heavyTimeout (tests/fixtures/work-meter.ts) and bounds its work with the meter, not a clock.
  it('give every test that builds 50,000 rows or more the heavy timeout', () => {
    const offenders = readdirSync('tests').filter(name => name.endsWith('.test.ts')).flatMap(name => {
      const lines = readFileSync(join('tests', name), 'utf8').split('\n')
      return lines.flatMap((line, index) => {
        const size = /\blength: ([\d_]+)/.exec(line)
        if (!size || Number(size[1].replace(/_/g, '')) < 50_000) return []
        let start = index
        while (start > 0 && !/^\s*it\(/.test(lines[start])) start--
        const indent = /^\s*/.exec(lines[start])![0]
        const end = lines.findIndex((candidate, at) => at > start && candidate.startsWith(indent + '}') && /^\}(\)|, )/.test(candidate.slice(indent.length)))
        return end >= 0 && lines[end].trim() === '}, heavyTimeout)' ? [] : [`tests/${name}:${index + 1}`]
      })
    })
    expect(offenders).toEqual([])
  })
  // check.mjs runs vitest beside the .NET build, and only its needsBackend files after it.
  it('run every vitest file that starts the Release backend after the build', () => {
    const source = readFileSync('scripts/check.mjs', 'utf8')
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts.check).toBe('node scripts/check.mjs')
    const startsBackend = readdirSync('tests').filter(name => name.endsWith('.test.ts') && /bin\/Release/.test(readFileSync(join('tests', name), 'utf8')))
    const listed = (name: string) => name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')
    expect(source).toContain("name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')")
    expect(startsBackend.filter(name => !listed(name))).toEqual([])
  })
})
