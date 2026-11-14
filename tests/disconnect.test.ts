import { describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions } from '../src/shared/connection-targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { DisconnectCoordinator, type DisconnectDocument, type DisconnectHost } from '../src/renderer/src/services/disconnect'
import { deferred } from './fixtures/documents'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture() {
  const targets = new ConnectionTargetService(), handle = { id: id(50), generation: 1 }
  targets.markLostBefore(1)
  targets.add({ id: id(1), options: connectionTargetOptions({ server: 'same-server', database: 'Sales', authentication: 'sql', username: 'alex', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
  targets.completeConnect(targets.beginConnect(id(1), 1, id(10))!, handle, { principal: { provider: 'sqlServer', authentication: 'sql', id: 'alex' } })
  const state = { docs: [
    { id: 'query-1', name: 'dirty.sql', targetId: id(1), connectionId: handle.id, database: 'Sales', revision: 1, dirty: true, query: true, running: false },
    { id: 'query-2', name: 'results.sql', targetId: id(1), connectionId: handle.id, database: 'Accounts', revision: 2, dirty: false, query: true, running: false },
    { id: 'designer', name: 'draft table', targetId: id(1), connectionId: handle.id, database: 'Sales', revision: 4, dirty: true, query: false, running: false }
  ] as DisconnectDocument[] }
  const order: string[] = [], plan = { plan: new Map<'query-1', 'commit'>([['query-1', 'commit']]), stopping: [], current: vi.fn(() => true) }
  const host = {
    targets, documents: () => state.docs, busy: vi.fn(() => false),
    runTask: vi.fn<DisconnectHost['runTask']>(async action => { await action() }),
    refusal: vi.fn<DisconnectHost['refusal']>(() => undefined),
    confirm: vi.fn<DisconnectHost['confirm']>(async () => { order.push('confirm'); return 'close-query-tabs' }),
    prepareClose: vi.fn<DisconnectHost['prepareClose']>(async () => { order.push('saves'); return { documents: [] } }),
    validateClose: vi.fn<DisconnectHost['validateClose']>(),
    prepareSessions: vi.fn<DisconnectHost['prepareSessions']>(async () => { order.push('sessions'); return plan }),
    cancelSessions: vi.fn<DisconnectHost['cancelSessions']>(async () => { order.push('cancel') }),
    endSession: vi.fn<DisconnectHost['endSession']>(async () => { order.push('transaction') }),
    disconnect: vi.fn<DisconnectHost['disconnect']>(async () => { order.push('disconnect') }),
    detached: vi.fn<DisconnectHost['detached']>(() => { order.push('detach'); state.docs = state.docs.map(doc => doc.targetId === id(1) ? { ...doc, connectionId: undefined } : doc) }),
    closeQueries: vi.fn<DisconnectHost['closeQueries']>(() => { order.push('close'); state.docs = state.docs.filter(doc => !doc.query) })
  }
  return { targets, handle, state, host, plan, order, coordinator: new DisconnectCoordinator(host, () => id(11)) }
}

describe('server disconnect coordinator', () => {
  it('reviews every choice before mutation, disconnects before local close and preserves custom drafts', async () => {
    const f = fixture(), result = await f.coordinator.disconnect(id(1))
    expect(result).toEqual({ status: 'disconnected', closed: ['query-1', 'query-2'], removed: false })
    expect(f.order).toEqual(['confirm', 'saves', 'sessions', 'cancel', 'transaction', 'disconnect', 'close', 'detach'])
    expect(f.host.prepareClose).toHaveBeenCalledWith(['query-1', 'query-2'])
    expect(f.state.docs).toEqual([expect.objectContaining({ id: 'designer', targetId: id(1), database: 'Sales', dirty: true, connectionId: undefined })])
    expect(f.targets.get(id(1))).toMatchObject({ inExplorer: true, resumeWanted: false, lifecycle: { state: 'disconnected' } })
  })
  it('keeps tabs and databases without asking to save drafts or releasing output', async () => {
    const f = fixture(), before = f.state.docs
    f.host.confirm.mockResolvedValue('keep-tabs')
    expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'disconnected', closed: [] })
    expect(f.host.prepareClose).not.toHaveBeenCalled()
    expect(f.host.closeQueries).not.toHaveBeenCalled()
    expect(f.state.docs).toEqual(before.map(doc => ({ ...doc, connectionId: undefined })))
  })
  it('does not prompt for or close a remembered query that was already disconnected on purpose', async () => {
    const f = fixture()
    f.state.docs = [...f.state.docs, { ...f.state.docs[0], id: 'remembered-only', connectionId: undefined }]
    f.host.closeQueries.mockImplementation(() => { f.state.docs = f.state.docs.filter(document => !['query-1', 'query-2'].includes(document.id)) })
    await f.coordinator.disconnect(id(1))
    expect(f.host.confirm.mock.calls[0][0].tabs.map(tab => tab.id)).toEqual(['query-1', 'query-2'])
    expect(f.host.prepareClose).toHaveBeenCalledWith(['query-1', 'query-2'])
    expect(f.state.docs.some(document => document.id === 'remembered-only')).toBe(true)
  })
  it('still revalidates remembered query references while save choices change only the actual close plan', async () => {
    const f = fixture()
    f.state.docs = [...f.state.docs, { ...f.state.docs[0], id: 'remembered-only', connectionId: undefined }]
    f.host.prepareClose.mockImplementationOnce(async () => {
      f.state.docs = f.state.docs.map(document => document.id === 'remembered-only' ? { ...document, revision: document.revision + 1 } : document)
      return { documents: [] }
    })
    expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'failed', error: expect.stringContaining('dependent document changed') })
    expect(f.host.disconnect).not.toHaveBeenCalled()
    expect(f.host.closeQueries).not.toHaveBeenCalled()
  })
  it.each(['choice', 'save', 'session'] as const)('cancellation at %s leaves connection and every tab present', async stage => {
    const f = fixture(), before = f.state.docs
    if (stage === 'choice') f.host.confirm.mockResolvedValue('cancel')
    if (stage === 'save') f.host.prepareClose.mockResolvedValue(undefined)
    if (stage === 'session') f.host.prepareSessions.mockResolvedValue(undefined)
    expect(await f.coordinator.disconnect(id(1))).toEqual({ status: 'cancelled' })
    expect(f.state.docs).toBe(before)
    expect(f.targets.get(id(1))).toMatchObject({ resumeWanted: true, lifecycle: { state: 'connected' } })
    expect(f.host.cancelSessions).not.toHaveBeenCalled()
    expect(f.host.endSession).not.toHaveBeenCalled()
    expect(f.host.disconnect).not.toHaveBeenCalled()
  })
  it.each(['prepareClose', 'cancelSessions', 'endSession', 'disconnect'] as const)('%s failure never closes a tab', async step => {
    const f = fixture(), before = f.state.docs
    f.host[step].mockRejectedValueOnce(new Error(`${step} failed`))
    expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'failed', error: expect.stringContaining(`${step} failed`) })
    expect(f.state.docs).toBe(before)
    expect(f.host.closeQueries).not.toHaveBeenCalled()
    expect(f.targets.get(id(1))?.lifecycle.state).toBe('connected')
  })
  it('reports already completed transactions if a later commit fails without claiming a rollback', async () => {
    const f = fixture()
    f.plan.plan.set('query-2' as 'query-1', 'commit')
    f.host.endSession.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Commit failed; transaction remains open.'))
    const result = await f.coordinator.disconnect(id(1))
    expect(result).toMatchObject({ error: expect.stringContaining('1 query session already ended as selected; those changes cannot be undone.') })
    expect(f.host.disconnect).not.toHaveBeenCalled()
    expect(f.host.closeQueries).not.toHaveBeenCalled()
    expect(f.state.docs).toHaveLength(3)
  })
  it('rejects edits, new documents, and changed associations during the prompt', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.state.docs = f.state.docs.map(doc => doc.id === 'query-1' ? { ...doc, revision: 2 } : doc) },
      (f: ReturnType<typeof fixture>) => { f.state.docs = [...f.state.docs, { ...f.state.docs[0], id: 'new-query' }] },
      (f: ReturnType<typeof fixture>) => { f.state.docs = f.state.docs.map(doc => doc.id === 'query-1' ? { ...doc, database: 'other' } : doc) }
    ]) {
      const f = fixture()
      f.host.confirm.mockImplementation(async () => { mutate(f); return 'close-query-tabs' })
      expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'failed' })
      expect(f.host.disconnect).not.toHaveBeenCalled()
      expect(f.host.closeQueries).not.toHaveBeenCalled()
    }
  })
  it('rechecks management blockers after the prompt and after session cancellation', async () => {
    for (const step of ['confirm', 'cancelSessions'] as const) {
      const f = fixture()
      if (step === 'confirm') f.host.confirm.mockImplementationOnce(async () => { f.host.refusal.mockReturnValue('Stop Restore Database first.'); return 'close-query-tabs' })
      else f.host.cancelSessions.mockImplementationOnce(async () => { f.host.refusal.mockReturnValue('Stop Restore Database first.') })
      expect(await f.coordinator.disconnect(id(1))).toMatchObject({ error: 'Stop Restore Database first.' })
      expect(f.host.disconnect).not.toHaveBeenCalled()
      expect(f.host.closeQueries).not.toHaveBeenCalled()
    }
  })
  it('rejects backend loss during a prompt or during teardown without touching tabs or a replacement generation', async () => {
    for (const step of ['confirm', 'disconnect'] as const) {
      const f = fixture()
      if (step === 'confirm') f.host.confirm.mockImplementationOnce(async () => { f.targets.markLostBefore(2); return 'keep-tabs' })
      else f.host.disconnect.mockImplementationOnce(async () => { f.targets.markLostBefore(2) })
      expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'stale' })
      expect(f.host.closeQueries).not.toHaveBeenCalled()
      expect(f.host.detached).not.toHaveBeenCalled()
      expect(f.targets.get(id(1))?.lifecycle.state).toBe('lost')
    }
  })
  it('joins identical requests across popouts and refuses a different removal intent', async () => {
    const f = fixture(), answer = deferred<'keep-tabs'>()
    f.host.confirm.mockReturnValue(answer.promise)
    const first = f.coordinator.disconnect(id(1))
    expect(f.coordinator.disconnect(id(1))).toBe(first)
    expect(await f.coordinator.disconnect(id(1), 'remove-from-explorer')).toEqual({ status: 'busy' })
    answer.resolve('keep-tabs')
    await first
    expect(f.host.disconnect).toHaveBeenCalledTimes(1)
  })
  it('revalidates edits after backend teardown and retains every query if any changed', async () => {
    const f = fixture()
    f.host.disconnect.mockImplementation(async () => { f.state.docs = f.state.docs.map(doc => doc.id === 'query-2' ? { ...doc, revision: 3 } : doc) })
    expect(await f.coordinator.disconnect(id(1))).toMatchObject({ status: 'disconnected', closed: [], warning: expect.stringContaining('all query tabs stayed open') })
    expect(f.host.closeQueries).not.toHaveBeenCalled()
    expect(f.host.detached).toHaveBeenCalled()
  })
  it('removes only Explorer membership after success and retains hidden references', async () => {
    const f = fixture()
    f.host.confirm.mockResolvedValue('keep-tabs')
    expect(await f.coordinator.disconnect(id(1), 'remove-from-explorer')).toMatchObject({ status: 'disconnected', removed: true })
    expect(f.targets.get(id(1))).toMatchObject({ inExplorer: false, resumeWanted: false })
    expect(f.state.docs).toHaveLength(3)
  })
  it('does not close tabs or remove a newer reconnect operation started as disconnect completes', async () => {
    const f = fixture()
    const stop = f.targets.subscribe(() => {
      if (f.targets.get(id(1))?.lifecycle.state === 'disconnected') f.targets.beginConnect(id(1), 1, id(12))
    })
    expect(await f.coordinator.disconnect(id(1), 'remove-from-explorer')).toMatchObject({ status: 'disconnected', closed: [], removed: false, warning: expect.stringContaining('target changed again') })
    expect(f.host.closeQueries).not.toHaveBeenCalled()
    expect(f.targets.get(id(1))).toMatchObject({ inExplorer: true, resumeWanted: true, lifecycle: { state: 'connecting' } })
    expect(f.targets.operation(id(1))?.attemptId).toBe(id(12))
    stop()
  })
  it('does not include another exact target even when its stale transport field matches', async () => {
    const f = fixture()
    f.state.docs = [...f.state.docs, { ...f.state.docs[0], id: 'another-account', targetId: id(2) }]
    f.host.confirm.mockResolvedValue('keep-tabs')
    await f.coordinator.disconnect(id(1))
    expect(f.host.prepareSessions).toHaveBeenCalledWith(['query-1', 'query-2'])
    expect(f.state.docs.find(doc => doc.id === 'another-account')?.connectionId).toBe(f.handle.id)
  })
  it('blocks active management operations before asking and does nothing while file work is busy', async () => {
    const f = fixture()
    f.host.busy.mockReturnValueOnce(true)
    expect(await f.coordinator.disconnect(id(1))).toEqual({ status: 'busy' })
    f.host.refusal.mockReturnValue('Stop Apply first.')
    expect(await f.coordinator.disconnect(id(1))).toEqual({ status: 'blocked', error: 'Stop Apply first.' })
    expect(f.host.confirm).not.toHaveBeenCalled()
  })
})
