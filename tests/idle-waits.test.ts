import { describe, expect, it, vi } from 'vitest'
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
  // A suite whose app.close() never finished (live-plan-smoke after a failed assertion) ran Smoke (Linux 3/3) to its
  // 25 minute timeout seven times on 2026-11-08, printing nothing: its error waited behind the close in its finally block.
  it('kill an app whose close does not finish, failing the suite without hiding its error', async () => {
    const { boundedClose } = await import('../scripts/fixtures/smoke.mjs')
    const kills: unknown[] = [], application = { process: () => ({ kill: (signal: unknown) => { kills.push(signal); return true } }) }
    const exitCode = process.exitCode, error = console.error
    console.error = () => {}
    try {
      await boundedClose(application, () => new Promise(() => {}), 20)
      expect(kills).toEqual(['SIGKILL'])
      expect(process.exitCode).toBe(1)
      process.exitCode = exitCode
      await boundedClose(application, async () => {}, 1000)
      expect(kills).toHaveLength(1)
      expect(process.exitCode).toBe(exitCode)
      await expect(boundedClose(application, async () => { throw new Error('closed badly') }, 1000)).rejects.toThrow('closed badly')
    } finally { process.exitCode = exitCode; console.error = error }
  })
  it('bound every smoke suite\'s run, so one hang cannot take its shard\'s later suites', async () => {
    const { platformSeconds, smokeSuites, suiteLimitSeconds } = await import('../scripts/smoke-shards.mjs')
    expect(readFileSync('scripts/smoke-shards.mjs', 'utf8')).toContain("timeout: limit * 1000, killSignal: 'SIGKILL'")
    for (const platform of ['linux', 'win32']) for (const suite of smokeSuites()) {
      const limit = suiteLimitSeconds(suite, platform)
      expect(limit, suite).toBeGreaterThanOrEqual(Math.max(300, 4 * platformSeconds(platform)[suite]))
      // A hung suite at its limit plus the shard's 360 s budget stays inside the smoke step's 25 minutes.
      expect(limit, suite).toBeLessThanOrEqual(25 * 60 - 360)
    }
  })
  // check.mjs runs vitest beside the .NET build, and only its needsBackend files after it.
  it('run every vitest file that starts the Release backend after the build', () => {
    const source = readFileSync('scripts/check.mjs', 'utf8')
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts.check).toBe('node scripts/check.mjs')
    // A fixture that starts it counts for every file that imports the fixture.
    const releaseFixtures = readdirSync('tests/fixtures').filter(name => name.endsWith('.ts') && /bin\/Release|Varia\.Backend\.dll/.test(readFileSync(join('tests/fixtures', name), 'utf8'))).map(name => name.replace(/\.ts$/, ''))
    const startsBackend = readdirSync('tests').filter(name => name.endsWith('.test.ts')).filter(name => {
      const text = readFileSync(join('tests', name), 'utf8')
      return /bin\/Release/.test(text) || releaseFixtures.some(fixture => text.includes(`from './fixtures/${fixture}`))
    })
    const listed = (name: string) => name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')
    expect(source).toContain("name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')")
    expect(startsBackend.filter(name => !listed(name))).toEqual([])
  })
  // CI's 3 and 4 vCPU runners take only the two-chain layout, so the wide one (8 CPUs or more, developers' machines) and
  // build:smoke's are held here: a step dropped from either would otherwise pass unnoticed.
  it('run every step of the check in each layout, the Release-backend steps only after the build', async () => {
    const { plan } = await import('../scripts/check.mjs')
    type Node = string | { all: Node[] } | { chain: Node[] } | { gate: Node, then: Node }
    const order = (node: Node): string[] => typeof node === 'string' ? [node] : 'all' in node ? node.all.flatMap(order) : 'chain' in node ? node.chain.flatMap(order) : [...order(node.gate), ...order(node.then)]
    const gated = (node: Node): string[] => typeof node === 'string' ? [] : 'all' in node ? node.all.flatMap(gated) : 'chain' in node ? node.chain.flatMap(gated) : node.gate === 'Release build (.NET)' ? order(node.then) : []
    const every = ['Type check', 'vitest', 'electron-vite build', 'Release build (.NET)', 'Offline .NET checks', 'vitest (Release backend)']
    for (const cpus of [3, 4, 8, 24]) {
      const layout = plan({ cpus }) as Node
      expect(order(layout).sort(), String(cpus)).toEqual([...every].sort())
      expect(gated(layout).sort(), String(cpus)).toEqual(['Offline .NET checks', 'vitest (Release backend)'])
      expect(order(plan({ cpus, skip: ['typecheck'] }) as Node).sort(), String(cpus)).toEqual(every.filter(step => step !== 'Type check').sort())
    }
    // Two chains: the build moved behind the .NET lanes balances them (vitest is the longest lane).
    expect(plan({ cpus: 4 })).toEqual({ all: [{ chain: ['Type check', 'vitest'] }, { chain: [{ gate: 'Release build (.NET)', then: { chain: ['Offline .NET checks', 'vitest (Release backend)'] } }, 'electron-vite build'] }] })
    expect(order(plan({ cpus: 4, build: true }) as Node).sort()).toEqual(['Release backend', 'electron-vite build'])
  })
  // A check stopped by CI's step timeout used to lose every running lane's held output: the hung suite left no trace.
  it('print what a running lane held when the check is stopped', async () => {
    const { run, running, flushRunning } = await import('../scripts/check.mjs')
    const closed: string[] = [], flushed: string[] = []
    void run('marker lane', `node -e "console.log('lane-marker'); setTimeout(() => {}, 20000)"`, (text: string) => closed.push(text))
    const held = () => [...running].some((lane: { output: Buffer[] }) => Buffer.concat(lane.output).includes('lane-marker'))
    await vi.waitFor(() => expect(held()).toBe(true), { timeout: 15000, interval: 20 })
    flushRunning((text: string) => flushed.push(text))
    expect(flushed.join('')).toMatch(/::group::marker lane \(still running after [\d.]+ s\)[\s\S]*lane-marker/)
    expect(running.size).toBe(0)
    expect(closed).toEqual([])
  }, 20000)
  // Without --live-group the .NET checks run every live suite when a server is configured: five copies at once against it,
  // killed at the deadline before their finally blocks drop their scratch databases and logins.
  it('stress only the offline checks, whatever server the environment names', () => {
    const source = readFileSync('scripts/offline-stress.mjs', 'utf8')
    expect(source).toContain('if (/^VARIA_TEST_(SQL|ENTRA|SSIS)/.test(name)) delete copy[name]')
    expect(source).toMatch(/spawn\(file, argv, \{ env: offlineEnv\(\)/)
  })
  // An app that exits before the exit listener is attached leaves nothing referenced: Node ended with 13 (an unsettled
  // top-level await) and skipped the suite's cleanup.
  it('check whether a process already exited before waiting for its exit', () => {
    for (const file of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs']) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(line => /once\('exit'/.test(line) && /ref: false/.test(line))
      expect(lines.length, file).toBeGreaterThan(0)
      for (const line of lines) expect(line, file).toMatch(/exitCode !== null \|\| child\.signalCode !== null \|\|/)
    }
  })
})
