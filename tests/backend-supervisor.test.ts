import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { BackendSupervisor } from '../src/main/backend/supervisor'
import { BackendError, sentences } from '../src/main/backend/errors'

const supervisors: BackendSupervisor[] = []
function supervisor(mode: string, packaged = false): BackendSupervisor {
  const value = new BackendSupervisor({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs'), mode], cwd: process.cwd(), packaged })
  supervisors.push(value)
  return value
}
afterEach(async () => { await Promise.all(supervisors.splice(0).map(value => value.stop())) })

const pidOf = async (value: BackendSupervisor) => (await value.request('system.health', {}) as unknown as { pid: number }).pid
const exited = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('The request succeeded.')
}

describe('BackendSupervisor', () => {
  it('starts once and queues requests made while the backend starts', async () => {
    const value = supervisor('echo')
    value.start()
    value.start()
    expect(value.status).toBe('starting')
    const pids = await Promise.all([pidOf(value), pidOf(value)])
    expect(value.status).toBe('ready')
    expect(pids).toEqual([value.current!.pid, value.current!.pid])
    expect(value.current!.generation).toBe(1)
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
  it('stays failed after the backend stops and answers disconnect and session close locally', async () => {
    const value = supervisor('exit')
    value.start()
    await value.current!.ready
    expect(await failure(value.request('databases.list', { connectionId: crypto.randomUUID() }))).toMatchObject({ code: 'BACKEND_LOST', message: sentences.lost })
    await expect.poll(() => value.status).toBe('failed')
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: sentences.stopped })
    await expect(value.request('connections.disconnect', { connectionId: crypto.randomUUID() })).resolves.toEqual({ disconnected: false })
    await expect(value.request('query.session.close', { sessionId: crypto.randomUUID() })).resolves.toEqual({ closed: false })
    await value.restart('reload')
    await value.current!.ready
    expect(value.status).toBe('ready')
  })
  it('explains a backend that cannot be started, in development and packaged wording', async () => {
    for (const packaged of [false, true]) {
      const value = new BackendSupervisor({ command: 'varia-command-that-does-not-exist', args: [], cwd: process.cwd(), packaged })
      supervisors.push(value)
      value.start()
      await expect.poll(() => value.status).toBe('failed')
      expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: packaged ? sentences.spawnPackaged : sentences.spawnDevelopment })
    }
  })
  it('explains a backend from a different build', async () => {
    const value = supervisor('v1')
    expect(await failure(value.request('system.health', {}))).toMatchObject({ code: 'BACKEND_LOST' })
    await expect.poll(() => value.status).toBe('failed')
    expect((await failure(value.request('system.health', {}))).message).toBe('The SQL backend is from a different build (protocol 1, expected 2). Run npm run backend:build, then restart.')
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
    expect(value.status).toBe('stopped')
  })
})
