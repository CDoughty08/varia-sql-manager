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
  // The page-side watcher stops on any refusal the panel states, whatever its words, so no refusal waits for the watchdog:
  // the panel's error is a status holding only its sentence, the waiting note a status holding a note.
  expect(pivot).toContain(`[...panel.querySelectorAll('[role="status"]')].filter(node => node.childElementCount === 0)`)
  const panel = readFileSync(join(root, 'src', 'renderer', 'src', 'results', 'PivotPanel.tsx'), 'utf8')
  expect(panel).toMatch(/\{state\.error && <div [^>]*role="status">\{state\.error\}<\/div>\}/)
  expect(panel).toMatch(/<div role="status">\{waiting && <div [^>]*>\{waiting\}<\/div>\}<\/div>/)
  expect(grid.match(/await stopIfLowMemory\(page, 'live (?:copy|save)'\)/g)).toHaveLength(2)
})
