import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The benchmark floor checker (scripts/check-bench.mjs) and tests/bench/floors.json, which CI enforces on Linux.
interface Spec { title: string; unit: string; better: 'higher' | 'lower'; target: number; floor: number | null; live?: boolean }
interface Floors { metrics: Record<string, Spec> }
interface Result { harness: 'node' | 'e2e'; live?: boolean; platform?: string; arch?: string; cpus?: number; cpu?: string; node?: string; metrics: Record<string, { value: number; unit: string }> }
interface Row { id: string; status: 'target' | 'floor' | 'below' | 'report' | 'missing'; required: boolean }
interface CheckBench { compare(floors: Floors, results: Result[]): Row[]; failed(rows: Row[]): Row[]; markdown(rows: Row[], results: Result[]): string }

const checker = (): Promise<CheckBench> => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/check-bench.mjs')).href)
const floors = JSON.parse(readFileSync('tests/bench/floors.json', 'utf8')) as Floors
const sources = ['tests/bench/codec.bench.ts', 'tests/bench/backend.bench.ts', 'tests/bench/grid.bench.ts', 'scripts/ipc-bench.mjs'].map(path => readFileSync(path, 'utf8')).join('\n')

describe('benchmark floors', () => {
  it('describe every metric the benchmarks record, and nothing else', () => {
    const recorded = new Set([...sources.matchAll(/\b(?:id: |record\()'((?:node|e2e)\.[\w.]+)'/g)].map(match => match[1]))
    expect([...recorded].sort()).toEqual(Object.keys(floors.metrics).sort())
    for (const [id, spec] of Object.entries(floors.metrics)) {
      expect(spec.title, id).toMatch(/\S/)
      expect(['higher', 'lower'], id).toContain(spec.better)
      expect(Number.isFinite(spec.target), id).toBe(true)
      // A floor never asks for more than the target.
      if (spec.floor !== null) expect(spec.better === 'higher' ? spec.floor <= spec.target : spec.floor >= spec.target, id).toBe(true)
    }
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

  it('fail unmeasured metrics that have a floor, and live ones only after a live run', async () => {
    const { compare, failed } = await checker()
    const specs: Floors = { metrics: {
      offline: { title: 'Offline', unit: 'ms', better: 'lower', target: 1, floor: 5 },
      live: { title: 'Live', unit: 'rows/s', better: 'higher', target: 10, floor: 5, live: true },
      reported: { title: 'Reported', unit: 'ms', better: 'lower', target: 1, floor: null }
    } }
    const offline = compare(specs, [{ harness: 'e2e', live: false, metrics: {} }])
    expect(offline.map(row => [row.status, row.required])).toEqual([['missing', true], ['missing', false], ['missing', false]])
    expect(failed(compare(specs, [{ harness: 'e2e', live: true, metrics: { offline: { value: 1, unit: 'ms' } } }])).map(row => row.id)).toEqual(['live'])
  })

  it('summarise the machine, values, targets and floors as a markdown table', async () => {
    const { compare, markdown } = await checker()
    const results: Result[] = [{ harness: 'node', platform: 'linux', arch: 'x64', cpus: 4, cpu: 'Test CPU', node: 'v24.0.0', metrics: { 'node.health.p50Ms': { value: 0.123, unit: 'ms' }, 'node.w1.rowsPerSecond': { value: 123_456.7, unit: 'rows/s' } } }]
    const table = markdown(compare(floors, results), results)
    expect(table).toContain('- node: linux x64, 4 × Test CPU, Node v24.0.0')
    expect(table).toContain('| main ↔ backend system.health round trip, p50 | 0.123 ms | ≤ 0.3 ms | ≤ 2 ms | meets target |')
    expect(table).toContain('| 123,457 rows/s | ≥ 1,000,000 rows/s | ≥ 250,000 rows/s | **below floor** |')
    expect(table).toContain('| Frame parse, 64 KiB chunks, mixed sizes | — | ≥ 1,000 MB/s | ≥ 250 MB/s | not measured |')
  })
})
