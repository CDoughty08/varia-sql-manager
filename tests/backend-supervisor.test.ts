import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { BackendState, QueryEvent } from '../src/shared/contracts'
import { FrameKind } from '../src/shared/ipc/wire/frames'
import { BackendSupervisor, type SupervisorDeps } from '../src/main/backend/supervisor'
import { BackendError, sentences } from '../src/main/backend/errors'
import { backendSpawnSpec } from '../src/main/backend/spawn-spec'
import { fakeSpawn, manualClock, settle, type FakeBackend } from './fixtures/fake-process'

const supervisors: BackendSupervisor[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(value => value.stop()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const fakeNode = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs')], cwd: process.cwd() }

/** A supervisor over the real fake backend process (tests/fixtures/backend.mjs). */
function supervisor(mode: string, packaged = false): BackendSupervisor {
  const value = new BackendSupervisor({ ...fakeNode, args: [...fakeNode.args, mode], packaged })
  supervisors.push(value)
  return value
}
/** A supervisor over in-process FakeBackends on a manual clock, with every state it publishes. */
function simulated(o: { configure?: (backend: FakeBackend, index: number) => void; deps?: SupervisorDeps } = {}) {
  const { clock, advance, jump, now } = manualClock()
  const processes = fakeSpawn(o.configure)
  const value = new BackendSupervisor({ command: 'fake', args: [], cwd: process.cwd(), packaged: false }, { clock, spawn: processes.spawn, ...o.deps })
  supervisors.push(value)
  const states: BackendState[] = []
  value.onState(state => states.push(state))
  const statuses = () => states.map(state => state.status === 'failed' ? `failed:${state.reason}` : state.status === 'stopped' ? 'stopped' : `${state.status}:${state.generation}`)
  return { value, clock, advance, jump, now, states, statuses, backends: processes.backends, last: processes.last }
}

const pidOf = async (value: BackendSupervisor) => (await value.request('system.health', {}) as unknown as { pid: number }).pid
const exited = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('The request succeeded.')
}
const options = { server: 'sql.example', database: '', authentication: 'sql' as const, username: 'reader', password: 'secret', trustServerCertificate: true }
const query = (sessionId: string) => ({ connectionId: 'c', sessionId, database: 'master', sql: 'SELECT 1', queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 0 })

describe('BackendSupervisor over the fake backend process', () => {
  it('starts once and queues requests made while the backend starts', async () => {
    const value = supervisor('echo')
    value.start()
    value.start()
    expect(value.state).toEqual({ status: 'starting', generation: 1 })
    const pids = await Promise.all([pidOf(value), pidOf(value)])
    expect(value.state).toMatchObject({ status: 'ready', generation: 1, pid: value.current!.pid })
    expect(pids).toEqual([value.current!.pid, value.current!.pid])
  })
  it('a reload ends the old process and starts the next generation at once', async () => {
    const value = supervisor('echo')
    const before = await pidOf(value)
    await value.restart('reload')
    expect(exited(before)).toBe(true)
    const after = await pidOf(value)
    expect(after).not.toBe(before)
    expect(value.current!.generation).toBe(2)
  })
  it('fails requests pending on the reloaded generation and never re-sends them', async () => {
    const value = supervisor('silent')
    const abandoned = failure(value.request('system.health', {}))
    await value.current!.ready
    await value.restart('reload')
    expect(await abandoned).toMatchObject({ code: 'BACKEND_LOST', message: sentences.reloaded })
    await value.current!.ready
    expect(value.current!.pendingCount).toBe(0)
  })
  it('explains a backend that cannot be started, in development and packaged wording, without retrying', async () => {
    for (const packaged of [false, true]) {
      const value = new BackendSupervisor({ command: 'varia-command-that-does-not-exist', args: [], cwd: process.cwd(), packaged })
      supervisors.push(value)
      const message = packaged ? sentences.spawnPackaged : sentences.spawnDevelopment
      expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message })
      expect(value.state).toMatchObject({ status: 'failed', reason: 'spawn', message })
      expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message })
      expect(value.current).toBeUndefined()
    }
  })
  it('explains a missing development build without starting dotnet, and starts once it is built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varia-no-build-'))
    directories.push(root)
    const spec = backendSpawnSpec({ packaged: false, root, resourcesPath: root, platform: process.platform, smokeTest: false })
    // dotnet without the dll starts, prints to stdout and exits: before the check that read as three crashes.
    const processes = fakeSpawn()
    const value = new BackendSupervisor(spec, { spawn: processes.spawn })
    supervisors.push(value)
    const statuses: string[] = []
    value.onState(state => statuses.push(state.status))
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: sentences.spawnDevelopment })
    expect(value.state).toMatchObject({ status: 'failed', reason: 'spawn', message: sentences.spawnDevelopment })
    expect((value.state as { details: string }).details).toContain('Last loss: generation 1, spawn (ENOENT (Varia.Backend.dll))')
    expect(statuses).toEqual(['failed'])
    expect(processes.backends).toHaveLength(0)
    await mkdir(dirname(spec.requires!), { recursive: true })
    await writeFile(spec.requires!, '')
    await value.restart('manual')
    await expect.poll(() => value.state.status).toBe('ready')
    expect(processes.backends).toHaveLength(1)
  })
  it('explains a backend from a different build without retrying', async () => {
    const value = supervisor('v1')
    const message = 'The SQL backend is from a different build (protocol 1, expected 2). Run npm run backend:build, then restart.'
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message })
    expect(value.state).toMatchObject({ status: 'failed', reason: 'incompatible', message })
    expect((value.state as { details: string }).details).toContain('Last loss: generation 1, incompatible (protocol 1, expected 2)')
  })
  it('stop fails pending and later requests with the closing sentence', async () => {
    const value = supervisor('silent')
    const pending = failure(value.request('system.health', {}))
    await value.current!.ready
    const pid = value.current!.pid!
    await value.stop()
    expect(await pending).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: sentences.closing })
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: sentences.closing })
    expect(exited(pid)).toBe(true)
    expect(value.state).toEqual({ status: 'stopped' })
  })
})

describe('BackendSupervisor restarts', () => {
  it('replaces an exited backend after 0, 1 and 2 s, losing its connections and running scripts', async () => {
    const { value, advance, statuses, states, backends } = simulated({ deps: { policy: { breakerLosses: 10 } } })
    const connection = await value.request('connections.connect', options)
    expect(connection).toMatchObject({ id: 'connection-1-1', generation: 1 })
    expect(value.connectionCount()).toBe(1)
    backends[0].answer = false
    const script = failure(value.request('query.execute', { ...query('tab-1'), connectionId: connection.id }))
    await settle()
    backends[0].exit(1)
    expect(await script).toMatchObject({ code: 'BACKEND_LOST', message: sentences.lostQuery })
    expect(states.at(-1)).toEqual({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'exit', connections: 1, queries: 1 } })
    expect(value.connectionCount()).toBe(0)
    expect(value.isLostConnection(connection.id)).toBe(true)
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 2 })
    // The lost id is refused before anything is written; cleanup for it is answered locally.
    expect(await failure(value.request('databases.list', { connectionId: connection.id }))).toMatchObject({ code: 'CONNECTION_LOST', message: sentences.connectionLost })
    await expect(value.request('connections.disconnect', { connectionId: connection.id })).resolves.toEqual({ disconnected: false })
    await expect(value.request('query.session.close', { sessionId: 'tab-1' })).resolves.toEqual({ closed: false })
    expect(backends[1].requests).toEqual([])
    for (const [index, delay] of [[1, 1000], [2, 2000], [3, 2000]] as const) {
      backends[index].exit(null, 'SIGKILL')
      await settle()
      expect(value.state).toMatchObject({ status: 'restarting', generation: index + 1, retryInMs: delay })
      await advance(delay - 1)
      expect(value.state.status).toBe('restarting')
      await advance(1)
      expect(value.state).toMatchObject({ status: 'ready', generation: index + 2 })
    }
    expect(statuses().slice(0, 6)).toEqual(['starting:1', 'ready:1', 'restarting:1', 'starting:2', 'ready:2', 'restarting:2'])
  })
  it('trips the breaker on the third unexpected loss within 120 s; a manual restart resets it', async () => {
    const { value, advance, backends, last } = simulated()
    await value.request('system.health', {})
    for (const delay of [0, 1000]) { last().exit(1); await advance(delay) }
    expect(value.state).toMatchObject({ status: 'ready', generation: 3 })
    last().stderr.write(Array.from({ length: 40 }, (_, index) => `varia-backend: line ${index}`).join('\n') + '\n' + 'x'.repeat(600) + '\n')
    await settle()
    last().exit(70)
    await settle()
    expect(value.state).toMatchObject({ status: 'failed', reason: 'crashLoop', message: sentences.crashLoop, lost: { generation: 3, reason: 'exit', connections: 0, queries: 0 } })
    const details = (value.state as { details: string }).details
    expect(details).toContain('Status: failed (crashLoop)')
    expect(details).toContain('Exit code: 70; signal: none')
    expect(details).toContain('Losses in the last 120 s: 3')
    expect(details).toContain('Runtime: .NET fake')
    // The stderr ring keeps the last 32 lines of at most 512 characters.
    expect(details).not.toContain('line 8\n')
    expect(details).toContain('varia-backend: line 9\n')
    expect(details.endsWith('  ' + 'x'.repeat(512))).toBe(true)
    expect(details).not.toContain('x'.repeat(513))
    await advance(60_000)
    expect(backends).toHaveLength(3)
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: sentences.unavailable })
    await expect(value.request('connections.disconnect', { connectionId: 'any' })).resolves.toEqual({ disconnected: false })
    await expect(value.request('query.session.close', { sessionId: 'any' })).resolves.toEqual({ closed: false })
    expect(await failure(value.request('query.session.state', { sessionId: 'any' }))).toMatchObject({ code: 'SESSION_LOST', message: sentences.sessionEnded })
    await value.restart('reload')
    expect(value.state.status).toBe('failed')
    await value.restart('manual')
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 4 })
    last().exit(1)
    await settle()
    expect(value.state).toMatchObject({ status: 'restarting', retryInMs: 0 })
  })
  it('counts only unexpected losses inside the window, and forgets them after 300 s ready', async () => {
    const { value, advance, last } = simulated()
    await value.request('system.health', {})
    for (let reload = 0; reload < 4; reload++) await value.restart('reload')
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 5 })
    last().exit(1)
    await advance(130_000)
    last().exit(1)
    await settle()
    // The first loss left the window, so this is the second inside it, with the second delay.
    expect(value.state).toMatchObject({ status: 'restarting', retryInMs: 1000 })
    await advance(1000)
    await advance(300_000)
    last().exit(1)
    await settle()
    expect(value.state).toMatchObject({ status: 'restarting', retryInMs: 0 })
  })
  it('never writes a request to a generation other than the one it was bound to', async () => {
    const { value, advance, backends } = simulated({ configure: (backend, index) => { backend.hello = index !== 0 } })
    // Generation 1 never says HELLO, so these wait in its queue and must die with it.
    const queued = [failure(value.request('databases.list', { connectionId: 'x' })), failure(value.request('system.health', {}))]
    await settle()
    backends[0].exit(1)
    expect((await Promise.all(queued)).map(error => error.code)).toEqual(['BACKEND_LOST', 'BACKEND_LOST'])
    await advance(0)
    await value.request('system.health', {})
    // Generation 2 ends; requests made while the restart is pending are bound to generation 3.
    backends[1].exit(1)
    await settle()
    expect(value.state).toMatchObject({ status: 'restarting', retryInMs: 1000 })
    const later = value.request('databases.list', { connectionId: 'y' })
    await advance(1000)
    await expect(later).resolves.toEqual({ method: 'databases.list' })
    expect(backends[0].requests).toEqual([])
    expect(backends[1].requests.map(request => request.method)).toEqual(['system.health'])
    expect(backends[2].requests.map(request => [request.generation, request.method])).toEqual([[3, 'databases.list']])
  })
  it('restarts on request: the old generation closes and its sessions are answered locally', async () => {
    const { value, advance, backends, states } = simulated()
    const connection = await value.request('connections.connect', options)
    await value.request('query.execute', { ...query('tab-1'), connectionId: connection.id })
    await value.restart('manual')
    expect(backends[0].alive).toBe(false)
    expect(states.find(state => state.status === 'restarting')).toEqual({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'manual', connections: 1, queries: 0 } })
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 2 })
    // Its transaction ended with it: reading its state answers locally that the session was lost.
    expect(await failure(value.request('query.session.state', { sessionId: 'tab-1' }))).toMatchObject({ code: 'SESSION_LOST', message: sentences.sessionEnded })
    await expect(value.request('query.session.close', { sessionId: 'tab-1' })).resolves.toEqual({ closed: false })
    await value.request('query.execute', { ...query('tab-1'), connectionId: 'new' })
    await value.request('query.session.close', { sessionId: 'tab-1' })
    expect(backends[1].requests.map(request => request.method)).toEqual(['query.execute', 'query.session.close'])
  })
  it('stop closes stdin, then kills a backend that does not exit within the grace period', async () => {
    const { value, advance, last } = simulated({ configure: backend => { backend.exitOnEnd = false } })
    await value.request('system.health', {})
    const stopping = value.stop()
    // Quitting stops it again (window closed, then will-quit): the second call waits for the same kill.
    let again = false
    void value.stop().then(() => { again = true })
    await advance(1999)
    expect(last().alive).toBe(true)
    expect(again).toBe(false)
    await advance(1)
    await stopping
    expect(last().signals).toEqual(['SIGKILL'])
    expect(again).toBe(true)
    expect(value.state).toEqual({ status: 'stopped' })
  })
  it('stop also waits for a generation that a restart is still closing, and kills it', async () => {
    // Restart now is offered when a backend is wedged; quitting right after must not leave that backend running.
    const { value, advance, backends } = simulated({ configure: (backend, index) => { backend.exitOnEnd = index !== 0 } })
    await value.request('system.health', {})
    const restarting = value.restart('manual')
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 2 })
    let stopped = false
    const stopping = value.stop().then(() => { stopped = true })
    await advance(1999)
    expect(backends[1].alive).toBe(false)
    expect(backends[0].alive).toBe(true)
    expect(stopped).toBe(false)
    await advance(1)
    await stopping
    await restarting
    expect(backends[0].signals).toEqual(['SIGKILL'])
  })
  it('Copy details includes a crash line that reaches stderr after the GOAWAY', async () => {
    const { value, advance, last, states } = simulated()
    await value.request('system.health', {})
    for (const delay of [0, 1000]) { last().exit(1); await advance(delay) }
    const backend = last()
    // The backend writes the line before its GOAWAY, but on another pipe: main reads it only after the loss.
    backend.stderr.pause()
    backend.stderr.write('varia-backend: unhandled InvalidOperationException at SqlService.Run\n')
    backend.send(FrameKind.GOAWAY, 0, 0, { code: 'BACKEND_CRASH', message: 'InvalidOperationException' })
    backend.stderr.resume()
    await settle()
    expect(value.state).toMatchObject({ status: 'failed', reason: 'crashLoop', lost: { generation: 3, reason: 'crash' } })
    const failed = states.filter(state => state.status === 'failed') as { details: string }[]
    expect(failed[0].details).not.toContain('InvalidOperationException')
    expect((value.state as { details: string }).details).toContain('  varia-backend: unhandled InvalidOperationException at SqlService.Run')
  })
})

describe('BackendSupervisor liveness', () => {
  it('reports a live but silent backend as unresponsive and never kills it', async () => {
    const { value, advance, backends, statuses } = simulated()
    await value.request('system.health', {})
    backends[0].pong = false
    await advance(14_000)
    expect(value.state.status).toBe('ready')
    await advance(2000)
    expect(value.state).toMatchObject({ status: 'unresponsive', generation: 1 })
    expect((value.state as { silentMs: number }).silentMs).toBeGreaterThanOrEqual(15_000)
    await advance(10 * 60_000)
    expect(value.state.status).toBe('unresponsive')
    expect(backends).toHaveLength(1)
    expect(backends[0].alive).toBe(true)
    expect(backends[0].signals).toEqual([])
    // Any frame shows it is alive again.
    backends[0].pong = true
    await advance(6000)
    expect(value.state).toMatchObject({ status: 'ready', generation: 1 })
    expect(statuses()).toEqual(['starting:1', 'ready:1', 'unresponsive:1', 'ready:1'])
  })
  it('lets the user replace an unresponsive backend', async () => {
    const { value, advance, backends } = simulated()
    await value.request('system.health', {})
    backends[0].pong = false
    await advance(16_000)
    expect(value.state.status).toBe('unresponsive')
    await value.restart('manual')
    await advance(0)
    expect(value.state).toMatchObject({ status: 'ready', generation: 2 })
    expect(backends[0].alive).toBe(false)
  })
  it('does not count time when main itself stalled', async () => {
    const { value, advance, jump, backends } = simulated()
    await value.request('system.health', {})
    backends[0].pong = false
    await advance(10_000)
    // A synchronous dialog blocks main for 30 s: no timer runs, then every overdue one runs late.
    jump(30_000)
    await advance(1)
    expect(value.state.status).toBe('ready')
    await advance(14_000)
    expect(value.state.status).toBe('ready')
    await advance(2000)
    expect(value.state.status).toBe('unresponsive')
  })
  it('keeps warning after a sleep or a stall until the backend sends a frame', async () => {
    const power = new EventEmitter()
    const { value, advance, jump, backends } = simulated({ deps: { power } })
    await value.request('system.health', {})
    backends[0].pong = false
    await advance(16_000)
    expect(value.state.status).toBe('unresponsive')
    power.emit('suspend')
    await advance(5000)
    power.emit('resume')
    await advance(1000)
    expect(value.state.status).toBe('unresponsive')
    jump(5000)
    await advance(1)
    expect(value.state.status).toBe('unresponsive')
    await advance(20_000)
    expect(value.state.status).toBe('unresponsive')
    backends[0].pong = true
    await advance(6000)
    expect(value.state).toMatchObject({ status: 'ready', generation: 1 })
  })
  it('pauses while the computer sleeps', async () => {
    const power = new EventEmitter()
    const { value, advance, backends } = simulated({ deps: { power } })
    await value.request('system.health', {})
    backends[0].pong = false
    power.emit('suspend')
    await advance(60_000)
    expect(value.state.status).toBe('ready')
    power.emit('resume')
    await advance(14_000)
    expect(value.state.status).toBe('ready')
    await advance(2000)
    expect(value.state.status).toBe('unresponsive')
  })
})

describe('smoke-test backends', () => {
  it('run only for unpackaged smoke tests, under an absolute node', () => {
    const base = { packaged: false, root: resolve('app'), resourcesPath: resolve('resources'), platform: process.platform }
    const env = { VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath }
    expect(backendSpawnSpec({ ...base, smokeTest: true, env })).toEqual({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', join(base.root, 'tests/fixtures/backend.mjs'), 'workbench'], cwd: base.root, packaged: false })
    expect(backendSpawnSpec({ ...base, smokeTest: true, env: { ...env, VARIA_TEST_BACKEND: 'crash-after:2' } }).args.slice(-2)).toEqual(['crash-after', '2'])
    expect(backendSpawnSpec({ ...base, smokeTest: false, env })).toMatchObject({ command: 'dotnet', requires: join(base.root, 'backend/Varia.Backend/bin/Debug/net10.0/Varia.Backend.dll') })
    expect(backendSpawnSpec({ ...base, packaged: true, smokeTest: true, env })).toMatchObject({ args: [], packaged: true })
    expect(() => backendSpawnSpec({ ...base, smokeTest: true, env: { ...env, VARIA_TEST_NODE: 'node' } })).toThrow('absolute VARIA_TEST_NODE')
  })
  it('passes the OS locale to the real backend, which dates script headers in it', () => {
    const base = { packaged: false, root: resolve('app'), resourcesPath: resolve('resources'), platform: process.platform, smokeTest: false, env: { PATH: '/bin', VARIA_BACKEND_TEST_HOOKS: '1' } }
    expect(backendSpawnSpec({ ...base, locale: 'de-DE' }).env).toEqual({ PATH: '/bin', VARIA_LOCALE: 'de-DE' })
    expect(backendSpawnSpec({ ...base, packaged: true, locale: 'ja-JP' }).env).toEqual({ PATH: '/bin', VARIA_LOCALE: 'ja-JP' })
    expect(backendSpawnSpec({ ...base, smokeTest: true, locale: 'tr-TR' }).env).toEqual({ PATH: '/bin', VARIA_BACKEND_TEST_HOOKS: '1', VARIA_LOCALE: 'tr-TR' })
    expect(backendSpawnSpec(base).env).toEqual({ PATH: '/bin' })
    // Without an explicit environment the backend still inherits main's, plus the locale.
    const inherited = backendSpawnSpec({ ...base, env: undefined, locale: 'en-GB' }).env!
    expect(inherited.VARIA_LOCALE).toBe('en-GB')
    expect(Object.keys(inherited).filter(key => key !== 'VARIA_LOCALE').length).toBeGreaterThan(0)
  })
  it('the workbench fake records calls by generation and crashes on request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varia-fake-backend-'))
    directories.push(directory)
    const value = new BackendSupervisor({ ...fakeNode, args: [...fakeNode.args, 'workbench'], env: { ...process.env, VARIA_TEST_BACKEND_DIR: directory }, packaged: false })
    supervisors.push(value)
    const connection = await value.request('connections.connect', options)
    expect(connection).toMatchObject({ server: 'sql.example', generation: 1 })
    await writeFile(join(directory, 'crash-next'), '')
    expect(await failure(value.request('query.execute', { ...query('tab-1'), connectionId: connection.id }))).toMatchObject({ code: 'BACKEND_LOST', message: sentences.lostQuery })
    expect(value.state).toMatchObject({ status: 'restarting', lost: { generation: 1, reason: 'crash', connections: 1, queries: 1 } })
    await expect.poll(() => value.state).toMatchObject({ status: 'ready', generation: 2 })
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { generation: number; method: string; params: { password?: string } })
    expect(calls.map(call => [call.generation, call.method])).toEqual([[1, 'connections.connect'], [1, 'query.execute']])
    expect(calls[0].params.password).toBe('<redacted>')
  })
})

describe('BackendSupervisor results', () => {
  it('stamps the generation on a script\'s results and events, and reads them only from that generation', async () => {
    const value = supervisor('workbench')
    const info = await value.request('connections.connect', options)
    const events: QueryEvent[] = []
    const result = await value.request('query.execute', { ...query('tab-1'), connectionId: info.id }, { onEvent: event => { events.push(event) } })
    expect(result.resultSets).toEqual([expect.objectContaining({ generation: 1, resultId: 1, rowsAvailable: 1, state: 'complete' })])
    // The budget's seq orders it with this generation's results.memory events.
    expect(result.budget).toMatchObject({ generation: 1, seq: 1 })
    expect(events.map(event => event.type === 'resultSet.opened' || event.type === 'resultSet.closed' ? [event.type, event.descriptor.generation] : [event.type])).toEqual([['resultSet.opened', 1], ['resultSet.closed', 1]])
    const pages: ArrayBuffer[] = []
    let id = 0
    const params = { resultId: 1, firstRow: 0, maxRows: 10 }
    const read = await value.request('results.read', params, { generation: 1, credit: 65_536, stream: { data: (_seq, body) => { pages.push(body) } }, onSent: sent => { id = sent } })
    expect(read).toEqual({ nextRow: 1, rowsAvailable: 1, complete: true, pages: 1, rows: 1 })
    expect(pages).toHaveLength(1)
    expect(id).toBeGreaterThan(0)
    expect(await failure(value.request('results.read', params, { generation: 2, credit: 65_536, stream: { data: () => {} } }))).toMatchObject({ code: 'RESULT_UNAVAILABLE', message: sentences.resultUnavailable })
    await value.restart('manual')
    expect(await failure(value.request('results.close', { resultIds: [1] }, { generation: 1 }))).toMatchObject({ code: 'RESULT_UNAVAILABLE' })
  })
  it('fails a script whose summary or events are invalid, and stamps synthetic results', async () => {
    const { value, last } = simulated({ configure: backend => { backend.answer = false } })
    value.start()
    await settle(8)
    const events: QueryEvent[] = []
    const script = failure(value.request('query.execute', query('tab-1'), { onEvent: event => { events.push(event) } }))
    await settle(8)
    const request = last().requests.at(-1)!
    last().send(FrameKind.EVENT, request.id, 0, { type: 'messages', messages: [{ text: 'ok', kind: 'info' }] })
    last().send(FrameKind.RESPONSE, request.id, 0, { result: { resultSets: [], messages: [] } })
    expect(await script).toMatchObject({ code: 'BACKEND_ERROR', message: sentences.invalid })
    expect(events).toEqual([{ type: 'messages', messages: [{ text: 'ok', kind: 'info' }] }])
    const second = failure(value.request('query.execute', query('tab-2'), { onEvent: () => {} }))
    await settle(8)
    last().send(FrameKind.EVENT, last().requests.at(-1)!.id, 0, { type: 'progress', results: 'many' })
    expect(await second).toMatchObject({ code: 'STREAM_PROTOCOL' })
    const synthetic = value.request('debug.results.synthesize', { shape: 'W1', rows: 1 })
    await settle(8)
    const descriptor = { resultId: 4, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [], rowsRead: 1, rowsStored: 1, rowsAvailable: 1, bytesStored: 1, truncatedCells: 0, state: 'complete', incomplete: false }
    last().send(FrameKind.RESPONSE, last().requests.at(-1)!.id, 0, { result: descriptor })
    expect(await synthetic).toEqual({ ...descriptor, generation: 1 })
  })
})
