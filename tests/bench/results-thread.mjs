// The results worker for tests/bench/backend.bench.ts, in its own thread as in the renderer: ResultsWorkerCore reads
// pages through the results port from main's ResultsPortHost and answers windows covering every row of a result, with
// every cell decoded. Plain JavaScript, so it can teach Node to resolve the renderer's extensionless TypeScript imports
// before loading worker-core.ts through type stripping.
import { registerHooks } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (!specifier.startsWith('.') || /\.[cm]?[jt]s$/.test(specifier)) throw error
      return next(specifier + '.ts', context)
    }
  }
})
const { ResultsWorkerCore } = await import('../../src/renderer/src/results/worker-core.ts')

const { port, key, wires, rows, windowRows, inFlight, maxCellChars, textBudget } = workerData
const answers = new Map()
const core = new ResultsWorkerCore({ post: message => { if ('id' in message) { answers.get(message.id)?.(message); answers.delete(message.id) } } })
core.attach(port)
port.on('message', message => core.receive(message))
let nextId = 1
const window = (first, count) => new Promise(resolve => {
  const id = nextId++
  answers.set(id, resolve)
  core.handle({ type: 'window', id, key, wires, first, count, colStart: 0, colEnd: wires.length, maxCellChars, textBudget })
})

parentPort.once('message', async () => {
  const started = performance.now()
  const totals = { rows: 0, cells: 0, characters: 0, nulls: 0, cut: 0, errors: [] }
  let next = 0
  // A few windows in flight, as a scrolling grid would have.
  async function lane() {
    while (next < rows && totals.errors.length === 0) {
      const first = next
      const count = Math.min(windowRows, rows - first)
      next += count
      const answer = await window(first, count)
      if (answer.type !== 'window') { totals.errors.push(`${answer.code}: ${answer.message}`); return }
      if (answer.count !== count) totals.errors.push(`window at ${first} has ${answer.count} of ${count} rows`)
      totals.rows += answer.count
      totals.cells += answer.text.length
      for (const text of answer.text) totals.characters += text.length
      for (const flag of answer.flags) { if (flag & 1) totals.nulls++; if (flag & 10) totals.cut++ }
    }
  }
  await Promise.all(Array.from({ length: inFlight }, lane))
  parentPort.postMessage({ ...totals, elapsedMs: performance.now() - started, cachedPages: core.cachedPages })
})
parentPort.postMessage('ready')
