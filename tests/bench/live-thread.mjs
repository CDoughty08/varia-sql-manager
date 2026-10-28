// The results worker for tests/bench/backend.bench.ts's live round trip, in its own thread as in the renderer:
// ResultsWorkerCore relays a live subscription's events from main's ResultsPortHost to the bench's thread (the page),
// and the page's acknowledgements back as port credit. Plain JavaScript, so it can teach Node to resolve the renderer's
// extensionless TypeScript imports before loading worker-core.ts through type stripping.
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

const { port, params } = workerData
// Events go to the page with the time they left the worker; everything else (the end, errors) too.
const core = new ResultsWorkerCore({ post: message => parentPort.postMessage(message.type === 'live' ? { type: 'live', bytes: message.bytes, seq: message.event.seq } : message) })
core.attach(port)
port.on('message', message => core.receive(message))
parentPort.on('message', message => {
  if (message.type === 'ack') core.handle({ type: 'liveAck', id: 1, bytes: message.bytes })
  else if (message.type === 'cancel') core.handle({ type: 'cancel', id: 1 })
})
core.handle({ type: 'live', id: 1, params })
parentPort.postMessage({ type: 'ready' })
