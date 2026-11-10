import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Time CI spent waiting rather than working (docs/ci.md): timers that outlived the app they raced, offline checks that
// waited out a refused connection, and check lanes that waited for a build they did not need.

// The lines of every Promise.race( whose whole span, to its matching parenthesis, races a close or an exit against a timer
// that keeps Node alive. Quotes are skipped so a parenthesis inside a string does not end the span.
function raceOffenders(text: string): number[] {
  const offenders: number[] = []
  for (const match of text.matchAll(/Promise\.race\(/g)) {
    let depth = 0, at = match.index! + match[0].length - 1, quote = ''
    for (; at < text.length; at++) {
      const char = text[at]
      if (quote) { if (char === '\\') at++; else if (char === quote) quote = ''; continue }
      if (char === "'" || char === '"' || char === '`') quote = char
      else if (char === '(') depth++
      else if (char === ')' && --depth === 0) break
    }
    const own = text.slice(match.index, at + 1)
    // A close or a timer assigned earlier (`const closing = app.close()`) races through its name: each name the race reads
    // brings the rest of the line that declared it.
    const declared = [...new Set(own.match(/[A-Za-z_$][\w$]*/g) ?? [])].flatMap(name => {
      const declaration = [...text.slice(0, match.index).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=(?!=)([^\\n]*)`, 'g'))].at(-1)
      return declaration ? [declaration[1]] : []
    })
    const span = [own, ...declared].join('\n')
    if (!/close\(\)|exit|exited/.test(span)) continue
    if (/setTimeout\(|\bsleep\(|\bwait\(|\bdelay\(/.test(span) && !/ref: false/.test(span)) offenders.push(text.slice(0, match.index).split('\n').length)
  }
  return offenders
}

// The helpers `text` defines that build an array or loop: functions, and arrows with or without generics, a return type or async.
function builderNames(text: string): Set<string> {
  const lines = text.split('\n')
  return new Set([...text.matchAll(/function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(|const\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=\n]+?)?\s*=>/g)].filter(match => {
    // The helper's own body: its line, or up to the brace that closes a body opened at the line's end.
    const at = text.slice(0, match.index).split('\n').length - 1, indent = /^\s*/.exec(lines[at])![0]
    const close = /\{\s*$/.test(lines[at]) ? lines.findIndex((candidate, index) => index > at && candidate.startsWith(indent + '}')) : at
    return /Array\.from|\blength:|new Array|\bfor \(/.test(lines.slice(at, (close < 0 ? at : close) + 1).join('\n'))
  }).map(match => match[1] ?? match[2]))
}

// The local names of the builders a test file imports from tests/fixtures.
function importedBuilders(text: string): Set<string> {
  const found = new Set<string>()
  for (const [, names, module] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/fixtures\/([\w-]+)(?:\.ts)?'/g)) {
    let source: string
    try { source = readFileSync(join('tests/fixtures', `${module}.ts`), 'utf8') } catch { continue }
    const builders = builderNames(source)
    for (const name of names.split(',')) {
      const [original, local = original] = name.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)
      if (original && builders.has(original)) found.add(local)
    }
  }
  return found
}

// The lines of every test that builds 50,000 rows or more (a literal length:, or a call whose first argument is a number to a
// helper the file defines or imports from tests/fixtures that builds an array or loops), and those among them whose test does
// not pass heavyTimeout.
function heavyTests(text: string, imported: ReadonlySet<string> = new Set()): { matched: number[], offenders: number[] } {
  const lines = text.split('\n'), matched: number[] = [], offenders: number[] = []
  const builders = new Set([...builderNames(text), ...imported])
  lines.forEach((line, index) => {
    const literal = [...line.matchAll(/\blength:\s*([\d_]{5,})\b/g)].map(match => match[1])
    const helped = [...line.matchAll(/(?<![.\w])(\w+)\(\s*([\d_]{5,})\s*[,)]/g)].filter(call => builders.has(call[1])).map(call => call[2])
    if (![...literal, ...helped].some(size => Number(size.replace(/_/g, '')) >= 50_000)) return
    // The test's own line: it( or test(, through any modifiers and their arguments (it.skipIf(win)(, it.each([…])(, it.only().
    let start = index
    while (start > 0 && !/^\s*(?:it|test)\b(?:\.\w+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*\(/.test(lines[start])) start--
    const indent = /^\s*/.exec(lines[start])![0]
    const end = lines.findIndex((candidate, at) => at > start && candidate.startsWith(indent + '}') && /^\}(\)|, )/.test(candidate.slice(indent.length)))
    matched.push(index + 1)
    if (!(end >= 0 && lines[end].trim() === '}, heavyTimeout)')) offenders.push(index + 1)
  })
  return { matched, offenders }
}

const scripts = ['scripts', 'scripts/fixtures'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => join(dir, name)))

describe('idle waits', () => {
  // A suite that races app.close() or a process exit against a bare timer keeps Node alive for the timer's full length
  // after the app has gone: 10 to 30 s per suite, about 2 minutes of each OS's smoke run, before within() replaced them.
  it('never race a close or an exit against a timer that outlives it', () => {
    const offenders = scripts.flatMap(file => raceOffenders(readFileSync(file, 'utf8')).map(line => `${file}:${line}`))
    expect(offenders).toEqual([])
    expect(scripts.filter(file => /within\(/.test(readFileSync(file, 'utf8'))).length).toBeGreaterThanOrEqual(10)
  })
  // The project keeps races on one line, but a formatter or a long race wrapped by hand must not hide one.
  it('find a close race wrapped over several lines', () => {
    const wrapped = ['const a = 1', 'await Promise.race([', '  app.close(),', '  delay(30000),', '])', 'const b = 2'].join('\n')
    expect(raceOffenders(wrapped)).toEqual([2])
    expect(raceOffenders(wrapped.replace('delay(30000)', "delay(30000, false, { ref: false })"))).toEqual([])
    expect(raceOffenders(['await Promise.race([', '  app.close(),', '  stream.done', '])', 'setTimeout(done, 30000)'].join('\n'))).toEqual([])
    expect(raceOffenders("await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 1000, ')'))])")).toEqual([1])
  })
  it('find a close or a timer raced through a name assigned earlier', () => {
    expect(raceOffenders('const closing = app.close()\nawait Promise.race([closing, delay(30000)])')).toEqual([2])
    expect(raceOffenders('const exited = once(child, \'exit\')\nconst idle = delay(30000)\nawait Promise.race([exited, idle])')).toEqual([3])
    expect(raceOffenders('const closing = app.close()\nconst idle = delay(30000, false, { ref: false })\nawait Promise.race([closing, idle])')).toEqual([])
    expect(raceOffenders('const answer = page.evaluate(read)\nawait Promise.race([answer, delay(3000)])')).toEqual([])
  })
  // Windows retries a refused TCP connection for about a second; a malformed named-pipe address fails at once (Unreachable.cs).
  it('fail the offline checks\' connections without a real TCP address', () => {
    const dir = 'backend/Varia.Backend.Tests'
    const offenders = readdirSync(dir).filter(name => name.endsWith('.cs') && name !== 'Unreachable.cs' && /tcp:127\.0\.0\.1,1\b/.test(readFileSync(join(dir, name), 'utf8')))
    expect(offenders).toEqual([])
  })
  // A test that builds 50,000 or more rows ran past vitest's 20 s default on a shared Windows runner (3 to 4 s locally):
  // it passes heavyTimeout (tests/fixtures/work-meter.ts) and bounds its work with the meter, not a clock.
  it('give every test that builds 50,000 rows or more the heavy timeout', () => {
    const found = readdirSync('tests').filter(name => name.endsWith('.test.ts') && name !== 'idle-waits.test.ts').map(name => {
      const text = readFileSync(join('tests', name), 'utf8')
      return { name, text, ...heavyTests(text, importedBuilders(text)) }
    })
    expect(found.flatMap(({ name, offenders }) => offenders.map(line => `tests/${name}:${line}`))).toEqual([])
    // A floor, so a pattern that stops matching cannot pass vacuously: rows built inline and through each kind of helper.
    const lines = (name: string) => found.find(file => file.name === name)!.matched
    const tree = found.find(file => file.name === 'explorer-tree-model.test.ts')!
    expect(lines('explorer-tree-model.test.ts').map(line => tree.text.split('\n')[line - 1].trim())).toContain('const t = sample(250_000)')
    expect(lines('explorer-service.test.ts').length).toBeGreaterThanOrEqual(4)
    expect(lines('shortcut-store.test.ts').length).toBeGreaterThanOrEqual(1)
  })
  it('find heavy tests built through helpers, under test( and it.each(', () => {
    const helper = 'const makeRows = (count: number) => Array.from({ length: count }, (_, at) => at)\n'
    expect(heavyTests(helper + "test('builds', () => {\n  makeRows(200_000)\n})").offenders).toEqual([3])
    expect(heavyTests(helper + "it.each([1, 2])('builds %i', () => {\n  makeRows(200_000)\n})").offenders).toEqual([3])
    expect(heavyTests(helper + "function sample(count = 3) {\n  for (let at = 0; at < count; at++) add(at)\n}\nit('builds', () => {\n  makeRows(200_000)\n  sample(60_000)\n}, heavyTimeout)")).toEqual({ matched: [6, 7], offenders: [] })
    // A return type, generics, more arguments, a modified test (it.skipIf(…)(, it.concurrent(), a helper from tests/fixtures.
    const typed = 'const makeRows = <T>(count: number, width: number): Row<T>[] => Array.from({ length: count }, () => row(width))\n'
    expect(heavyTests(typed + "it('first', () => {}, heavyTimeout)\nit.skipIf(win)('builds', () => {\n  makeRows(300_000, 2)\n})").offenders).toEqual([4])
    expect(heavyTests(typed + "it('first', () => {}, heavyTimeout)\nit.concurrent('builds', () => {\n  makeRows( 300_000 )\n})").offenders).toEqual([4])
    expect(heavyTests(typed + "it('first', () => {})\nit.skipIf(process.platform === 'win32')('builds', () => {\n  makeRows(300_000, 2)\n}, heavyTimeout)").offenders).toEqual([])
    expect(heavyTests("it('builds', () => {\n  fixtureRows(80_000)\n})", new Set(['fixtureRows'])).offenders).toEqual([2])
    expect(builderNames('export function sampleRows(count: number) {\n  return Array.from({ length: count }, (_, at) => at)\n}\nexport const label = (n: number) => `#${n}`')).toEqual(new Set(['sampleRows']))
    // A numeric argument to anything that builds no rows (a timer, a format helper, String.repeat) is not a heavy test.
    expect(heavyTests("const advance = (ms: number) => vi.advanceTimersByTime(ms)\nit('waits', () => {\n  advance(60_000)\n  'x'.repeat(1_000_000)\n})").matched).toEqual([])
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
    expect(readFileSync('scripts/smoke-shards.mjs', 'utf8')).toContain('await runSuite(suite, limit * 1000, ')
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
  // VARIA_CHECK_SKIP=tsc used to skip nothing while the summary reported it skipped.
  it('refuse an unknown VARIA_CHECK_SKIP name and report only the lanes left out', async () => {
    const { parseSkip, plan, skippedNote } = await import('../scripts/check.mjs')
    expect(parseSkip('')).toEqual([])
    expect(parseSkip(undefined)).toEqual([])
    expect(parseSkip(' typecheck , ')).toEqual(['typecheck'])
    expect(() => parseSkip('tsc')).toThrow(/unknown name 'tsc'.*typecheck/)
    expect(() => parseSkip('typecheck,vitest')).toThrow(/'vitest'/)
    expect(skippedNote(plan({ cpus: 4, skip: ['typecheck'] }), ['typecheck'])).toBe(' (skipped: typecheck, VARIA_CHECK_SKIP)')
    expect(skippedNote(plan({ cpus: 4 }), ['typecheck'])).toBe('')
    expect(skippedNote(plan({ cpus: 24 }), [])).toBe('')
    const source = readFileSync('scripts/check.mjs', 'utf8')
    expect(source).toMatch(/parseSkip\(process\.env\.VARIA_CHECK_SKIP\)[\s\S]{0,80}process\.exit\(2\)/)
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
      const lines = readFileSync(file, 'utf8').split('\n').filter(line => /once\('exit'/.test(line) && /ref: false|\bwithin\(/.test(line))
      expect(lines.length, file).toBeGreaterThan(0)
      for (const line of lines) expect(line, file).toMatch(/exitCode !== null \|\| child\.signalCode !== null \|\|/)
    }
  })
})
