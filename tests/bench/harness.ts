// Measurement helpers for the IPC benchmarks (npm run bench). Benchmarks only measure and check correctness; floors
// are compared afterwards by scripts/check-bench.mjs against tests/bench/floors.json, so a slow machine never fails
// `npm run bench` itself.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** One line per metric while the run lasts; the global setup's teardown gathers them into artifacts/bench/node.json. */
export const metricsLog = resolve('artifacts/bench/node.jsonl')
export const nodeResults = resolve('artifacts/bench/node.json')

export interface Metric { readonly id: string; readonly value: number; readonly unit: string; readonly detail?: string }

export function record(...metrics: Metric[]): void {
  mkdirSync(dirname(metricsLog), { recursive: true })
  for (const metric of metrics) {
    appendFileSync(metricsLog, JSON.stringify(metric) + '\n')
    console.log(`${metric.id}: ${format(metric.value)} ${metric.unit}${metric.detail ? ` (${metric.detail})` : ''}`)
  }
}

export function format(value: number): string {
  return Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : Number(value.toPrecision(3)).toString()
}

/** The p-th percentile (0–100) of `values`, by nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]
}

export const median = (values: readonly number[]): number => percentile(values, 50)

/** Runs `fn` in batches for `ms` after a warm-up and returns calls per second. */
export function rate(fn: () => void, o: { warmupMs?: number; ms?: number; batch?: number } = {}): number {
  const batch = o.batch ?? 100
  const run = (ms: number) => {
    let calls = 0
    const started = performance.now()
    let elapsed = 0
    while (elapsed < ms) {
      for (let i = 0; i < batch; i++) fn()
      calls += batch
      elapsed = performance.now() - started
    }
    return calls / elapsed * 1000
  }
  run(o.warmupMs ?? 300)
  return run(o.ms ?? 1500)
}

/** Megabytes (10^6 bytes) per second. */
export const mbPerSecond = (bytes: number, ms: number): number => bytes / 1e6 / (ms / 1000)

/** A W1-shaped row as the synthetic backend shape writes it: int, nvarchar(50), datetime2(7), decimal(18,2),
 *  uniqueidentifier, nvarchar(200) of 80 characters, bit, and an int that is NULL in every fifth row. */
export function w1Row(row: number): (string | null)[] {
  const name = row % 7 === 3 ? `Société ${String(row).padStart(10, '0')} SARL` : `Customer ${String(row).padStart(10, '0')} GmbH`
  const seconds = row + Math.floor(row * 1_234_567 % 10_000_000) / 1e7
  const created = new Date(Date.UTC(2026, 0, 1) + Math.floor(seconds * 1000)).toISOString().replace('T', ' ').slice(0, 19) + '.' + String(row * 1_234_567 % 10_000_000).padStart(7, '0')
  const cents = row * 7919 % 100_000_000
  const amount = (row % 11 === 5 && cents !== 0 ? '-' : '') + Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0')
  const key = `${(row >>> 0).toString(16).toUpperCase().padStart(8, '0')}-0000-4A1F-9C2E-00C04FC9${((row >>> 8) & 0xff).toString(16).toUpperCase().padStart(2, '0')}${(row & 0xff).toString(16).toUpperCase().padStart(2, '0')}`
  const prefix = `Note ${row}: `
  const note = prefix + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore'.slice(0, 80 - prefix.length)
  return [String(row), name, created, amount, key, note, row % 3 === 0 ? '1' : '0', row % 5 === 4 ? null : String(row * 31 % 1000)]
}
