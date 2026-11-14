import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { lowMemoryStop, lowMemoryText } from '../scripts/fixtures/memory-load.mjs'

// The hand-run benchmarks that use the backend's own budget stop with a clear sentence at high memory load, which they
// recognise by the backend's own sentences: renaming one there must not leave them timing a paging machine again.
const root = join(__dirname, '..')
const service = readFileSync(join(root, 'backend', 'Varia.Backend', 'SqlService.cs'), 'utf8')
const constant = (name: string) => {
  const match = new RegExp(`const string ${name} = "([^"]+)";`).exec(service)
  if (!match) throw new Error(`SqlService.${name} was not found`)
  return match[1]
}

it('recognises every sentence the backend gives for low memory, and only those', () => {
  const truncated = /Note\("(Results were truncated because the computer is low on memory\.[^"]*)"\)/.exec(service)?.[1]
  expect(truncated).toBeDefined()
  for (const sentence of [constant('LowMemory'), constant('BudgetStoppedLowMemory'), truncated!]) expect(lowMemoryText.test(sentence), sentence).toBe(true)
  for (const sentence of [constant('BudgetStoppedFull'), constant('BudgetStoppedGlobal')]) expect(lowMemoryText.test(sentence), sentence).toBe(false)
  expect(lowMemoryStop('narrow200000: builds')).toMatch(/^narrow200000: builds: .*low on memory.*run the benchmark again\.$/)
})

it('stops pivot-bench and grid-bench --live on a low-memory refusal instead of timing it or waiting for a grid', () => {
  const pivot = readFileSync(join(root, 'scripts', 'pivot-bench.mjs'), 'utf8')
  const grid = readFileSync(join(root, 'scripts', 'grid-bench.mjs'), 'utf8')
  expect(pivot).toMatch(/const queryMs = await run\(sql\)\n\s+await stopIfLowMemory\(page, step\)/)
  expect(pivot).toMatch(/if \(marks\.refused\) throw new Error\(lowMemoryText\.test\(marks\.refused\) \? lowMemoryStop\(step\)/)
  // The panel's refusal as the page-side watcher matches it: low memory, and the pivot's own budget sentence.
  const watched = /\.match\((\/[^/]+\/i)\)/.exec(pivot)?.[1]
  expect(watched).toBeDefined()
  const pattern = new RegExp(watched!.slice(1, -2), 'i')
  expect(pattern.test(constant('LowMemory'))).toBe(true)
  expect(pattern.test('There is not enough result memory to pivot these rows. Close other results and try again.')).toBe(true)
  expect(service).toContain('There is not enough result memory to pivot these rows. Close other results and try again.')
  expect(grid.match(/await stopIfLowMemory\(page, 'live (?:copy|save)'\)/g)).toHaveLength(2)
})
