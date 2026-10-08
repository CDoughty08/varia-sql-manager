import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { RpcMethod, RpcMethods, RpcResponse } from '../shared/contracts'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

/** The sidecar rejects longer lines before reading them (Program.cs). */
export const maxRequestLineLength = 1_100_000
const maxPending = 256
// Cancellation and session cleanup must stay available however many requests are outstanding.
const controlMethods: ReadonlySet<RpcMethod> = new Set(['query.cancel', 'query.session.close'])

/** Owns one backend lifetime. No ports, shell invocation, or credentials in argv. */
export class BackendClient {
  private process: ChildProcessWithoutNullStreams | undefined
  private pending = new Map<string, Pending>()
  private failure: Error | undefined

  constructor(private command: string, private args: string[], private cwd: string) {}

  start(): void {
    if (this.process || this.failure) return
    const child = spawn(this.command, this.args, { cwd: this.cwd, windowsHide: true, stdio: 'pipe' })
    this.process = child
    const owns = () => this.process === child
    // crlfDelay: a CR and LF split across pipe reads must never produce an extra empty line.
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => { if (owns()) this.receive(line) })
    // Drain diagnostics without logging SQL text, credentials, or connection strings.
    child.stderr.resume()
    child.on('error', () => { if (owns()) this.fail(new Error('Could not start the .NET backend. Install .NET 10 and run npm run backend:build.')) })
    child.on('exit', () => { if (owns()) this.fail(new Error('The .NET backend stopped. Restart the application.')) })
    child.stdin.on('error', () => { if (owns()) this.fail(new Error('The .NET backend connection closed.')) })
  }

  request<M extends RpcMethod>(method: M, params: RpcMethods[M]['params'], timeoutMs = 30_000): Promise<RpcMethods[M]['result']> {
    this.start()
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.size >= maxPending && !controlMethods.has(method)) return Promise.reject(new Error('Too many pending backend requests.'))
    const id = randomUUID()
    const line = JSON.stringify({ id, method, params })
    // JSON escaping can push a script that passed validation over the sidecar's line limit.
    if (line.length > maxRequestLineLength) return Promise.reject(new Error('The request is too large to send to the backend. Execute a smaller script or selection.'))
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The backend request timed out.'))
        if (method === 'query.execute') {
          const queryId = (params as RpcMethods['query.execute']['params']).queryId
          void this.request('query.cancel', { queryId }, 5000).catch(() => {})
        }
      }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as RpcMethods[M]['result']), reject, timer })
      const child = this.process!
      child.stdin.write(line + '\n', error => {
        // A write still flushing to a process that restart() replaced must not fail the new one.
        if (error && this.process === child) this.fail(new Error('Could not send a request to the .NET backend.'))
      })
    })
  }

  /** Ends this backend process; the next request starts a fresh one with no connections or sessions. */
  restart(): void {
    const child = this.process
    this.fail(new Error('The workbench was reloaded.'))
    this.process = undefined
    this.failure = undefined
    child?.stdin.end()
    child?.kill()
  }

  stop(): void {
    this.fail(new Error('The application is closing.'))
    this.process?.stdin.end()
    this.process?.kill()
  }

  private receive(line: string): void {
    if (!line.trim()) return
    let response: RpcResponse
    try { response = JSON.parse(line) as RpcResponse }
    catch { this.fail(new Error('The backend returned an invalid protocol message.')); this.process?.kill(); return }
    const pending = response && typeof response.id === 'string' ? this.pending.get(response.id) : undefined
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.id!)
    if (response.error) pending.reject(new Error(response.error.message))
    else if (Object.hasOwn(response, 'result')) pending.resolve(response.result)
    else pending.reject(new Error('The backend returned an incomplete response.'))
  }

  private fail(error: Error): void {
    // Keep the first failure; a later 'exit' must not replace a more specific startup or protocol error.
    this.failure ??= error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}
