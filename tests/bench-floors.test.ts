import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The benchmark floor checker (scripts/check-bench.mjs) and tests/bench/floors.json, which CI enforces on Linux.
interface Spec { title: string; unit: string; better: 'higher' | 'lower'; target: number; floor: number | null; live?: boolean }
interface Floors { metrics: Record<string, Spec> }
interface Result { harness: 'node' | 'e2e' | 'grid'; live?: boolean; view?: { width: number; height: number }; platform?: string; arch?: string; cpus?: number; cpu?: string; node?: string; metrics: Record<string, { value: number; unit: string }> }
interface Row { id: string; status: 'target' | 'floor' | 'below' | 'report' | 'missing'; required: boolean }
interface CheckBench { compare(floors: Floors, results: Result[]): Row[]; failed(rows: Row[]): Row[]; markdown(rows: Row[], results: Result[]): string }

interface Attempt { long: number[]; value: number; attempt: number }
interface BenchRules { measuresAgain(attempt: Attempt, floor: number | null): boolean; betterAttempt(first: Attempt, second: Attempt): Attempt }
const rules = (): Promise<BenchRules> => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/fixtures/bench.mjs')).href)
const checker = (): Promise<CheckBench> => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/check-bench.mjs')).href)
const floors = JSON.parse(readFileSync('tests/bench/floors.json', 'utf8')) as Floors
const sources = ['tests/bench/codec.bench.ts', 'tests/bench/backend.bench.ts', 'tests/bench/grid.bench.ts', 'tests/bench/chart.bench.ts', 'tests/bench/plans.bench.ts', 'tests/bench/search.bench.ts', 'scripts/ipc-bench.mjs', 'scripts/grid-bench.mjs'].map(path => readFileSync(path, 'utf8')).join('\n')

describe('benchmark floors', () => {
  it('describe every metric the benchmarks record, and nothing else', () => {
    const recorded = new Set([...sources.matchAll(/\b(?:id: |record\()'((?:node|e2e|grid)\.[\w.]+)'/g)].map(match => match[1]))
    expect([...recorded].sort()).toEqual(Object.keys(floors.metrics).sort())
    for (const [id, spec] of Object.entries(floors.metrics)) {
      expect(spec.title, id).toMatch(/\S/)
      expect(['higher', 'lower'], id).toContain(spec.better)
      expect(Number.isFinite(spec.target), id).toBe(true)
      // A floor never asks for more than the target.
      if (spec.floor !== null) expect(spec.better === 'higher' ? spec.floor <= spec.target : spec.floor >= spec.target, id).toBe(true)
    }
  })

  // A jump's main-thread task time is measured around the wait for its paint. A wait that looked at the view every
  // animation frame made that time follow how long the tiles took to read: the transposed jump read 1.5 to 2.7 times the
  // 300-column one on CI with less work in the grid, and crossed its floor on a slow runner.
  it('wait for a jump to paint on the grid\'s own writes, never every animation frame or on a timer loop', () => {
    const bench = readFileSync('scripts/grid-bench.mjs', 'utf8')
    const jump = /\nconst jump = [\s\S]*?\n(?=\/\*\*|const |function |async function )/.exec(bench)?.[0] ?? ''
    expect(jump).toContain('new MutationObserver(')
    expect(jump).not.toMatch(/setInterval|for \(|while \(|await /)
    // One animation frame, after the view is complete, to time its paint: never one per look.
    expect(jump.match(/requestAnimationFrame\(/g)).toHaveLength(1)
    expect(jump).toMatch(/finish\(\(\) => requestAnimationFrame\(/)
    // The one timer is the failure's: it rejects, and is cleared when the jump paints.
    expect(jump.match(/setTimeout\(/g)).toHaveLength(1)
    expect(jump).toMatch(/clearTimeout\(timer\)/)
  })

  // One unlucky run on a shared runner must not fail a pull request, and a slow build must still fail: the floor stays
  // where it is, and a figure near it is measured twice.
  it('measure a jump segment once more when it had a long task or reads over half its floor, and count the better attempt', async () => {
    const { measuresAgain, betterAttempt } = await rules()
    const attempt = (value: number, long: number[] = [], at = 1): Attempt => ({ value, long, attempt: at })
    expect(measuresAgain(attempt(85), 170)).toBe(false)
    expect(measuresAgain(attempt(85.1), 170)).toBe(true)
    expect(measuresAgain(attempt(20, [61]), 170)).toBe(true)
    // A metric without a floor is measured again only for a long task.
    expect(measuresAgain(attempt(5000), null)).toBe(false)
    expect(measuresAgain(attempt(5000, [80]), null)).toBe(true)
    // The lower figure counts, whichever attempt it was; a build slow both times stays over its floor.
    expect(betterAttempt(attempt(172, [], 1), attempt(96, [], 2)).attempt).toBe(2)
    expect(betterAttempt(attempt(96, [], 1), attempt(172, [], 2)).attempt).toBe(1)
    expect(betterAttempt(attempt(180, [], 1), attempt(176, [], 2)).value).toBe(176)
    // Long tasks come first: an attempt without one counts over a faster one with one.
    expect(betterAttempt(attempt(60, [70], 1), attempt(90, [], 2)).attempt).toBe(2)
    expect(betterAttempt(attempt(90, [], 1), attempt(60, [70, 55], 2)).attempt).toBe(1)
    // Every jump segment names a metric of its own that has a floor, so the rule has one to go by.
    const bench = readFileSync('scripts/grid-bench.mjs', 'utf8')
    const named = [...bench.matchAll(/jumpSegment\('[^']+', \d+, '([\w.]+)'\)/g)].map(match => match[1])
    expect(named).toEqual(['grid.x1.jumpTaskP95Ms', 'grid.x2.jumpTaskP95Ms', 'grid.transposed.jumpTaskP95Ms', 'grid.transposed.narrow.jumpTaskP95Ms'])
    for (const id of named) expect(floors.metrics[id].floor, id).toBeGreaterThan(0)
    expect(bench.match(/await jumpSegment\(/g)).toHaveLength(named.length)
  })

  it('pass values at or past their floor and fail values worse than it, in either direction', async () => {
    const { compare, failed } = await checker()
    const specs: Floors = { metrics: {
      fast: { title: 'Fast', unit: 'ops/s', better: 'higher', target: 100, floor: 25 },
      quick: { title: 'Quick', unit: 'ms', better: 'lower', target: 1, floor: 5 },
      spread: { title: 'Spread', unit: 'ms', better: 'lower', target: 2, floor: null }
    } }
    const run = (fast: number, quick: number, spread: number) => compare(specs, [{ harness: 'node', metrics: { fast: { value: fast, unit: 'ops/s' }, quick: { value: quick, unit: 'ms' }, spread: { value: spread, unit: 'ms' } } }])
    expect(run(100, 1, 2).map(row => row.status)).toEqual(['target', 'target', 'target'])
    expect(run(25, 5, 9).map(row => row.status)).toEqual(['floor', 'floor', 'report'])
    const below = run(24.9, 5.1, 1000)
    expect(below.map(row => row.status)).toEqual(['below', 'below', 'report'])
    expect(failed(below).map(row => row.id)).toEqual(['fast', 'quick'])
  })

  it('fail unmeasured metrics that have a floor, and live ones only after their own harness ran live', async () => {
    const { compare, failed } = await checker()
    const specs: Floors = { metrics: {
      'e2e.offline': { title: 'Offline', unit: 'ms', better: 'lower', target: 1, floor: 5 },
      'e2e.live': { title: 'Live', unit: 'rows/s', better: 'higher', target: 10, floor: 5, live: true },
      'e2e.reported': { title: 'Reported', unit: 'ms', better: 'lower', target: 1, floor: null },
      'grid.live': { title: 'Grid live', unit: 'ms', better: 'lower', target: 1, floor: 5, live: true }
    } }
    const offline = compare(specs, [{ harness: 'e2e', live: false, metrics: {} }])
    expect(offline.map(row => [row.status, row.required])).toEqual([['missing', true], ['missing', false], ['missing', false], ['missing', false]])
    expect(failed(compare(specs, [{ harness: 'e2e', live: true, metrics: { 'e2e.offline': { value: 1, unit: 'ms' } } }])).map(row => row.id)).toEqual(['e2e.live'])
    // A live e2e run does not make the grid's live metrics required, nor the other way round.
    const gridLive = compare(specs, [{ harness: 'e2e', live: false, metrics: { 'e2e.offline': { value: 1, unit: 'ms' } } }, { harness: 'grid', live: true, metrics: {} }])
    expect(failed(gridLive).map(row => row.id)).toEqual(['grid.live'])
  })

  it('summarise the machine, values, targets and floors as a markdown table', async () => {
    const { compare, markdown } = await checker()
    const results: Result[] = [
      { harness: 'node', platform: 'linux', arch: 'x64', cpus: 4, cpu: 'Test CPU', node: 'v24.0.0', metrics: { 'node.health.p50Ms': { value: 0.123, unit: 'ms' }, 'node.w1.rowsPerSecond': { value: 123_456.7, unit: 'rows/s' } } },
      { harness: 'grid', live: false, view: { width: 1600, height: 1000 }, platform: 'linux', arch: 'x64', cpus: 2, cpu: 'Test CPU', node: 'v24.0.0', metrics: { 'grid.wheel.frameP95Ms': { value: 2.5, unit: 'ms' } } }
    ]
    const table = markdown(compare(floors, results), results)
    expect(table).toContain('- node: linux x64, 4 × Test CPU, Node v24.0.0')
    expect(table).toContain('- grid: linux x64, 2 × Test CPU, Node v24.0.0, 1600 × 1000 window, no live SQL')
    expect(table).toMatch(/\| Grid: frame\(\) during a 3 s wheel scroll over 1,000,000 rows, p95 \| 2\.5 ms \| ≤ 3 ms \| ≤ 8 ms \| meets target \|/)
    expect(table).toContain('| main ↔ backend system.health round trip, p50 | 0.123 ms | ≤ 0.3 ms | ≤ 2 ms | meets target |')
    expect(table).toContain('| 123,457 rows/s | ≥ 1,000,000 rows/s | ≥ 250,000 rows/s | **below floor** |')
    expect(table).toContain('| Frame parse, 64 KiB chunks, mixed sizes | — | ≥ 1,000 MB/s | ≥ 250 MB/s | not measured |')
  })
})
