// Global setup for npm run bench: starts from an empty metrics log and, after the run, writes artifacts/bench/node.json
// with the machine it ran on, for scripts/check-bench.mjs.
import { cpus, totalmem } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { acquire } from '../../scripts/machine-lock.mjs'
import { metricsLog, nodeResults, type Metric } from './harness'

export default async function setup(): Promise<() => void> {
  // Benchmarks measure only themselves: they wait for the machine lock's exclusive tier (scripts/machine-lock.mjs).
  const lock = await acquire('exclusive', { label: 'npm run bench' })
  mkdirSync(dirname(metricsLog), { recursive: true })
  rmSync(metricsLog, { force: true })
  rmSync(nodeResults, { force: true })
  return () => {
    const lines = existsSync(metricsLog) ? readFileSync(metricsLog, 'utf8').split('\n').filter(Boolean) : []
    const metrics: Record<string, Omit<Metric, 'id'>> = {}
    for (const line of lines) {
      const { id, ...rest } = JSON.parse(line) as Metric
      metrics[id] = rest
    }
    writeFileSync(nodeResults, JSON.stringify({
      harness: 'node', date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
      cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), metrics
    }, null, 2) + '\n')
    rmSync(metricsLog, { force: true })
    lock.release()
  }
}
