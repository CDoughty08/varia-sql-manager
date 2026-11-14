import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Parallel work on results runs on a lease of the fair worker gate (`ViewSorter.Gate.Take(wanted)` then `threads.For`,
// Results/WorkerGate.cs), which shares the threads between the operations running and hands them back between items.
// Parallel.For with MaxDegreeOfParallelism = threads.Count still compiles and stays bounded, but keeps every thread it
// took to the end, so a second operation started meanwhile runs on what the first leaves.
const backend = join(__dirname, '..', 'backend', 'Varia.Backend')
const results = join(backend, 'Results')
// Parallel by name, or imported under another (`using static ...Parallel;` then a bare For, or an alias).
const parallel = /\bParallel\.|\bMaxDegreeOfParallelism\b|\bParallelOptions\b|\.AsParallel\(|\bSystem\.Threading\.Tasks\.Parallel\b/

/** The lines of `code` that use Parallel, comments excluded. */
const offending = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, '')).split('\n').flatMap((line, index) => parallel.test(line.replace(/\/\/.*$/, '')) ? [index + 1] : [])

it('runs every parallel step on results through the worker gate\'s lease, not Parallel', () => {
  const files = readdirSync(results).filter(name => name.endsWith('.cs'))
  expect(files).toContain('WorkerGate.cs')
  // The results' files, and SqlService, which drives the operations on them.
  const scanned = [...files.map(name => join(results, name)), join(backend, 'SqlService.cs')]
  const offenders = scanned.flatMap(path => offending(readFileSync(path, 'utf8')).map(line => `${path}:${line}`))
  expect(offenders).toEqual([])
  // The lease is what they use instead.
  expect(files.filter(name => /\bthreads\.For\(/.test(readFileSync(join(results, name), 'utf8'))).length).toBeGreaterThan(5)
})

it('sees Parallel however it is written', () => {
  expect(offending('using static System.Threading.Tasks.Parallel;\nFor(0, n, body);')).toEqual([1])
  expect(offending('using P = System.Threading.Tasks.Parallel;')).toEqual([1])
  expect(offending('Parallel.For(0, n, body);\n// Parallel.For(0, n, body);\n/* Parallel.For */')).toEqual([1])
})
