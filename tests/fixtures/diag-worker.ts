// TEMPORARY CI diagnostic: event-loop lag and CPU time of each worker.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
const dir = join(tmpdir(), 'varia-diag'); mkdirSync(dir, { recursive: true })
const started = Number(process.env.VARIA_CHECK_STARTED) || Date.now()
const g = globalThis as { __variaDiag?: boolean }
if (!g.__variaDiag) {
  g.__variaDiag = true
  let last = performance.now(), cpu = process.cpuUsage()
  setInterval(() => {
    const now = performance.now(), lag = now - last - 200, used = process.cpuUsage(cpu)
    last = now; cpu = process.cpuUsage()
    if (lag > 700) appendFileSync(join(dir, `w-${process.pid}.log`), `worker ${process.pid} at ${((Date.now() - started) / 1000).toFixed(1)} s: lag ${lag.toFixed(0)} ms, cpu user ${(used.user / 1000).toFixed(0)} sys ${(used.system / 1000).toFixed(0)} ms, rss ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB, test ${expect.getState().currentTestName ?? '-'} (${expect.getState().testPath?.split(/[\/]/).pop()})\n`)
  }, 200).unref()
}
