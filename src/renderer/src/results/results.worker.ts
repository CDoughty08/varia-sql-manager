// The results worker: owns the results port to main and decodes pages off the UI thread (worker-core.ts).
import type { PortMessage } from '../../../shared/ipc/port-messages'
import { ResultsWorkerCore } from './worker-core'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

const scope = self as unknown as { postMessage(message: WorkerResponse, transfer: Transferable[]): void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null }
const core = new ResultsWorkerCore({ post: (message, transfer = []) => scope.postMessage(message, transfer) })

scope.onmessage = event => {
  const request = event.data
  if (request.type === 'attach') {
    const port = request.port
    port.onmessage = (message: MessageEvent<PortMessage>) => core.receive(message.data)
    port.start()
    core.attach(port)
    return
  }
  core.handle(request)
}
