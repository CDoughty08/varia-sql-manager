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
