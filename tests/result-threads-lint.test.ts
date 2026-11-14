import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Parallel work on results runs on a lease of the fair worker gate (`ViewSorter.Gate.Take(wanted)` then `threads.For`,
// Results/WorkerGate.cs), which shares the threads between the operations running and hands them back between items.
// Parallel.For with MaxDegreeOfParallelism = threads.Count still compiles and stays bounded, but keeps every thread it
// took to the end, so a second operation started meanwhile runs on what the first leaves.
const results = join(__dirname, '..', 'backend', 'Varia.Backend', 'Results')

it('runs every parallel step on results through the worker gate\'s lease, not Parallel', () => {
  const files = readdirSync(results).filter(name => name.endsWith('.cs'))
  expect(files).toContain('WorkerGate.cs')
  const offenders = files.flatMap(name => readFileSync(join(results, name), 'utf8').split('\n')
    .map((line, index) => ({ at: `${name}:${index + 1}`, code: line.replace(/\/\/.*$/, '') }))
    .filter(({ code }) => /\bParallel\.|\bMaxDegreeOfParallelism\b|\bParallelOptions\b|\.AsParallel\(/.test(code))
    .map(({ at }) => at))
  expect(offenders).toEqual([])
  // The lease is what they use instead.
  expect(files.filter(name => /\bthreads\.For\(/.test(readFileSync(join(results, name), 'utf8'))).length).toBeGreaterThan(5)
})
