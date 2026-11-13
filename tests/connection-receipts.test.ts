import { describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'
import { ConnectionService, detailsOf } from '../src/renderer/src/services/connections'
import { acceptConnectionReceipt } from '../src/renderer/src/services/connection-receipts'
import { deferred } from './fixtures/documents'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const options: ConnectionOptions = { server: 'sql-prod-01', database: 'Sales', authentication: 'sql', username: 'alex', password: 'sample', trustServerCertificate: false }
const info = (targetId: string, handle = id(50)): ConnectionInfo => ({ id: handle, targetId, generation: 1, server: 'sql-prod-01', database: 'Sales', serverVersion: '17', authentication: { principal: { provider: 'sqlServer', authentication: 'sql', id: 'alex' } } })
function fixture() {
  const connections = new ConnectionService()
  const attempt = connections.beginConnect(options, 1, id(1))!
  const api = { acceptConnectionRequest: vi.fn(async (_id: string) => ({ ok: true as const, value: { accepted: true, retained: true } })), cancelConnectionRequests: vi.fn(async (_ids: string[]) => ({ ok: true })) }
  return { connections, attempt, api, info: info(id(1)), options, details: detailsOf(options), requestId: id(100) }
}

describe('authenticated connection receipt adoption', () => {
  it('waits for ownership acknowledgement without applying selected details or executing a query', async () => {
    const setup = fixture(), pending = deferred<Awaited<ReturnType<typeof setup.api.acceptConnectionRequest>>>()
    setup.api.acceptConnectionRequest.mockImplementation(() => pending.promise)
    const accepting = acceptConnectionReceipt(setup)
    expect(setup.connections.isLive(setup.info.id)).toBe(true)
    pending.resolve({ ok: true, value: { accepted: true, retained: true } })
    expect(await accepting).toMatchObject({ targetId: id(1), id: setup.info.id })
    expect(setup.api.cancelConnectionRequests).not.toHaveBeenCalled()
  })

  it('rejects a legacy or stale UI receipt through its request owner instead of disconnecting its handle', async () => {
    const setup = fixture()
    expect(await acceptConnectionReceipt({ ...setup, info: { ...setup.info, authentication: undefined } })).toBeUndefined()
    expect(setup.api.acceptConnectionRequest).not.toHaveBeenCalled()
    expect(setup.api.cancelConnectionRequests).toHaveBeenCalledWith([setup.requestId])
    expect(setup.connections.getSnapshot()).toEqual([])
    const stale = fixture()
    expect(await acceptConnectionReceipt({ ...stale, current: () => false })).toBeUndefined()
    expect(stale.api.cancelConnectionRequests).toHaveBeenCalledWith([stale.requestId])
  })

  it('marks loss only when main proves the returned handle was not retained', async () => {
    const setup = fixture()
    setup.api.acceptConnectionRequest.mockResolvedValue({ ok: true, value: { accepted: false, retained: false } })
    expect(await acceptConnectionReceipt(setup)).toBeUndefined()
    expect(setup.connections.get(id(1))?.lifecycle).toEqual({ state: 'lost', reason: 'cancelled' })
    expect(setup.connections.connectionTargets.get(id(1))?.resumeWanted).toBe(true)
    const shared = fixture()
    shared.api.acceptConnectionRequest.mockResolvedValue({ ok: true, value: { accepted: false, retained: true } })
    expect(await acceptConnectionReceipt(shared)).toBeUndefined()
    expect(shared.connections.isLive(shared.info.id)).toBe(true)
  })

  it('does not infer shared handle loss from a failed or unknown acknowledgement', async () => {
    const setup = fixture()
    const api = { ...setup.api, acceptConnectionRequest: vi.fn(async () => ({ ok: false as const, error: 'Receipt response unavailable.' })) }
    await expect(acceptConnectionReceipt({ ...setup, api })).rejects.toThrow('Receipt response unavailable.')
    expect(setup.connections.isLive(setup.info.id)).toBe(true)
  })

  it('persists explicit Stop only when main proves the adopted transport had no retaining caller', async () => {
    const setup = fixture(), pending = deferred<Awaited<ReturnType<typeof setup.api.acceptConnectionRequest>>>()
    setup.api.acceptConnectionRequest.mockImplementation(() => pending.promise)
    let stopped = false
    const accepting = acceptConnectionReceipt({ ...setup, current: () => !stopped, explicitlyCancelled: () => stopped })
    stopped = true
    pending.resolve({ ok: true, value: { accepted: false, retained: false } })
    expect(await accepting).toBeUndefined()
    expect(setup.connections.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: false, inExplorer: false, lifecycle: { state: 'disconnected' } })
    const joined = fixture(), accepted = deferred<Awaited<ReturnType<typeof joined.api.acceptConnectionRequest>>>()
    joined.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
    stopped = false
    const sharing = acceptConnectionReceipt({ ...joined, current: () => !stopped, explicitlyCancelled: () => stopped })
    stopped = true
    accepted.resolve({ ok: true, value: { accepted: false, retained: true } })
    expect(await sharing).toBeUndefined()
    expect(joined.connections.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: true, inExplorer: true, lifecycle: { state: 'connected' } })
  })

  it('cannot continue after backend loss or a document-close lock changes while acknowledgement awaits', async () => {
    const setup = fixture(), pending = deferred<Awaited<ReturnType<typeof setup.api.acceptConnectionRequest>>>()
    setup.api.acceptConnectionRequest.mockImplementation(() => pending.promise)
    let current = true
    const accepting = acceptConnectionReceipt({ ...setup, current: () => current })
    current = false
    setup.connections.markLostBefore(2)
    pending.resolve({ ok: true, value: { accepted: true, retained: true } })
    expect(await accepting).toBeUndefined()
    expect(setup.connections.get(id(1))?.lifecycle?.state).toBe('lost')
  })

  it('updates remembered credential references on already-live reuse only with main explicit proof', async () => {
    const setup = fixture()
    await acceptConnectionReceipt(setup)
    const first = setup.connections.connectionTargets.get(id(1))!
    const reference = { profileId: id(200), revision: id(201) }
    const attempt = setup.connections.beginConnect(options, 1, id(2))!
    const changed = { ...info(id(1)), authentication: { ...setup.info.authentication!, credential: reference }, credentialUpdated: true as const }
    expect(await acceptConnectionReceipt({ ...setup, attempt, info: changed })).toMatchObject({ targetId: id(1), reused: true })
    expect(setup.connections.connectionTargets.get(id(1))?.credential).toEqual(reference)
    expect(first.credential).toBeUndefined()
    const unchanged = setup.connections.beginConnect(options, 1, id(3))!
    expect(await acceptConnectionReceipt({ ...setup, attempt: unchanged, info: { ...changed, credentialUpdated: undefined, authentication: { ...changed.authentication, credential: null } } })).toBeDefined()
    expect(setup.connections.connectionTargets.get(id(1))?.credential).toEqual(reference)
  })

  it('uses verified offline affinity to retain the old target while reconciling an explicit vault change', async () => {
    const setup = fixture(), before = { profileId: id(200), revision: id(201) }, after = { profileId: id(200), revision: id(202) }
    await acceptConnectionReceipt({ ...setup, info: { ...setup.info, login: 'Friendly account', authentication: { ...setup.info.authentication!, credential: before } } })
    setup.connections.disconnected(setup.info.id)
    const attempt = setup.connections.beginConnect(options, 1, id(3))!
    const changed = { ...info(id(1), id(51)), login: 'Friendly account', authentication: { ...setup.info.authentication!, credential: after }, credentialUpdated: true as const }
    expect(await acceptConnectionReceipt({ ...setup, attempt, info: changed })).toMatchObject({ targetId: id(1), reused: true, sourceTargetId: id(3) })
    expect(setup.connections.connectionTargets.getSnapshot()).toHaveLength(1)
    expect(setup.connections.connectionTargets.get(id(1))?.credential).toEqual(after)
    expect(setup.connections.get(id(1))?.login).toBe('Friendly account')
  })
})
