import { describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { bindStartupReconnect } from '../src/renderer/src/services/connection-startup'
import { acceptConnectionReceipt } from '../src/renderer/src/services/connection-receipts'
import { executePendingQuery, finishConnectionDetails, whenConnectionDocumentsIdle, yieldReviewToClose } from '../src/renderer/src/services/connection-opening'
import { keptSession, reloadSession } from '../src/renderer/src/services/session'
import { deferred } from './fixtures/documents'
import { connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const principal = { provider: 'sqlserver' as const, authentication: 'sql' as const, id: 'reader' }
const record = (value: number): PersistedConnectionTarget => ({ id: id(value), options: connectionTargetOptions(connectionOptions), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: principal, credential: { profileId: id(200), revision: id(201) } })

async function fixture() {
  const value = workbenchFixture(), canonical = { id: id(60), generation: 1, server: 'server.example', database: 'master', serverVersion: '17', targetId: id(2), authentication: { principal, credential: record(2).credential } }
  value.api.hotExit = true
  value.connectionTargets.restore({ version: 1, targets: [record(1), record(2)] })
  const existing = value.connections.beginConnect(connectionOptions, 1, id(2))!
  expect(value.connections.accept(canonical, connectionOptions, id(2), canonical.authentication, existing).status).toBe('accepted')
  const query = value.documents.create('source.sql', 'SELECT 1', 'Sales')
  value.documents.update(query.id, { targetId: id(1), attachWanted: true })
  await value.settings.load()
  const capture = () => keptSession(value.documents, key => value.connections.get(key)?.server, {
    connectionTargets: value.connectionTargets, assertConnectionsReady: () => value.connections.assertCheckpointReady()
  })
  const reload = () => reloadSession(value.documents, key => value.connections.get(key)?.server, {
    connectionTargets: value.connectionTargets, assertConnectionsReady: () => value.connections.assertCheckpointReady(), restoreQueries: true, recoveryId: () => undefined
  })
  const receipt = () => ({ api: value.api, connections: value.connections, info: canonical, options: connectionOptions, details: record(1).details,
    attempt: value.connections.beginConnect(connectionOptions, 1, id(1))!, requestId: id(100) })
  return { ...value, canonical, query, capture, reload, receipt }
}

describe('connection association checkpoints', () => {
  it('refuses real window close during background canonical adoption, then keeps the completed canonical affinity', async () => {
    const value = await fixture(), ready = deferred<void>(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>()
    const binding = bindStartupReconnect({ ...value, api: value.api, ready: ready.promise })
    try {
      value.api.connect.mockResolvedValue({ ok: true, value: value.canonical })
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      value.api.push(readyBackend(1))
      ready.resolve()
      await expect.poll(() => value.api.acceptConnectionRequest.mock.calls.length).toBe(1)
      expect(value.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: false, lifecycle: { state: 'disconnected' } })
      expect(value.documents.get(value.query.id)?.targetId).toBe(id(1))
      const assertReady = value.connections.assertCheckpointReady.bind(value.connections)
      const checked = vi.spyOn(value.connections, 'assertCheckpointReady').mockImplementation(() => {
        expect(value.documents.getSnapshot().busy).toBe(true)
        assertReady()
      })
      await value.files.closeWindow(async () => {})
      checked.mockRestore()
      expect(value.files.getSnapshot().error).toContain('Wait for query tabs to finish connecting')
      expect(value.api.keepSession).not.toHaveBeenCalled()
      expect(value.api.closeWindow).not.toHaveBeenCalled()
      expect(value.api.closeWindowCancelled).toHaveBeenCalledTimes(1)
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      await binding.scheduler.whenIdle()
      expect(value.documents.get(value.query.id)).toMatchObject({ targetId: id(2), connectionId: id(60), database: 'Sales', attachWanted: true })
      await value.files.closeWindow(async () => {})
      expect(value.api.closeWindow).toHaveBeenCalledTimes(1)
      expect(value.api.keepSession).toHaveBeenCalledTimes(1)
      const session = value.api.keepSession.mock.calls[0][0]
      expect(session.documents[0]).toMatchObject({ targetId: id(2), database: 'Sales', attachWanted: true })
      expect(session.workspace?.targets).toEqual([expect.objectContaining({ id: id(2), resumeWanted: true })])
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); binding.dispose(); value.dispose() }
  })

  it('keeps manual adoption guarded through acknowledgement and document-idle attachment, including reload', async () => {
    const value = await fixture(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>(), busy = deferred<void>(), signal = new AbortController()
    try {
      const before = value.capture(), setup = value.receipt()
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      let adopted = false
      const accepting = acceptConnectionReceipt({ ...setup, signal: signal.signal, current: () => !signal.signal.aborted && (adopted || !value.documents.getSnapshot().busy), onAdopted: () => { adopted = true } })
      expect(before.checkpointCurrent()).toBe(false)
      expect(value.reload).toThrow('Wait for query tabs to finish connecting')
      await value.files.closeWindow(async () => {})
      expect(value.api.keepSession).not.toHaveBeenCalled()
      const task = value.documents.runTask(() => busy.promise)
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      const opened = (await accepting)!
      expect(opened).toBeDefined()
      expect(value.capture).toThrow('Wait for query tabs to finish connecting')
      const idle = whenConnectionDocumentsIdle(value.documents, signal.signal)
      busy.resolve()
      await task
      expect(await idle).toBe(true)
      expect(finishConnectionDetails(value.connections, opened, 'current')?.id).toBe(id(60))
      value.targets.coalesceTarget(id(1), id(2), opened.id, true)
      value.connectionTargets.removeFromExplorer(id(1))
      value.targets.attachTarget(id(2), opened.id, true)
      opened.association!.complete()
      expect(value.reload()?.session.documents[0]).toMatchObject({ targetId: id(2), database: 'Sales', attachWanted: true })
      await value.files.closeWindow(async () => {})
      expect(value.api.closeWindow).toHaveBeenCalledTimes(1)
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { signal.abort(); accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); busy.resolve(); value.dispose() }
  })

  it.each(['ipc-error', 'not-accepted', 'backend-loss'] as const)('settles abandoned redirect intent before allowing capture after %s', async failure => {
    const value = await fixture(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>()
    try {
      const setup = value.receipt()
      const api = { ...setup.api, acceptConnectionRequest: async () => failure === 'ipc-error' ? { ok: false as const, error: 'Receipt unavailable.' } : accepted.promise }
      const accepting = acceptConnectionReceipt({ ...setup, api })
      if (failure === 'backend-loss') value.connections.markLostBefore(2)
      accepted.resolve({ ok: true, value: { accepted: failure === 'backend-loss', retained: true } })
      if (failure === 'ipc-error') await expect(accepting).rejects.toThrow('Receipt unavailable.')
      else expect(await accepting).toBeUndefined()
      expect(value.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: true, lifecycle: { state: 'disconnected', reason: 'cancelled' } })
      expect(value.reload()?.session.documents[0]).toMatchObject({ targetId: id(1), attachWanted: true })
      expect(value.capture().checkpointCurrent()).toBe(true)
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { accepted.resolve({ ok: true, value: { accepted: false, retained: true } }); value.dispose() }
  })

  it.each([false, true])('waits through a queued real file task before resuming explicit Execute, respecting Stop=%s', async stop => {
    const value = await fixture(), first = deferred<void>(), second = deferred<void>(), controller = new AbortController()
    try {
      const opened = (await acceptConnectionReceipt({ ...value.receipt(), signal: controller.signal, explicitlyCancelled: () => controller.signal.aborted }))!
      const firstTask = value.documents.runTask(() => first.promise)
      let secondStarted = false
      const queuedFile = value.files.later(() => { secondStarted = true; return second.promise })
      const observed: { ready: boolean; busy: boolean }[] = [], execute = vi.fn()
      const continued = whenConnectionDocumentsIdle(value.documents, controller.signal).then(async ready => {
        observed.push({ ready, busy: value.documents.getSnapshot().busy })
        if (!ready) return
        value.targets.coalesceTarget(id(1), id(2), opened.id)
        value.connectionTargets.removeFromExplorer(id(1))
        await executePendingQuery({ tabId: value.query.id, opened, ...value, queries: { isRunning: () => false, execute, holdsUnattachedJobs: () => false } })
        opened.association!.complete()
      })
      first.resolve()
      await firstTask
      await expect.poll(() => secondStarted).toBe(true)
      expect(observed).toEqual([])
      expect(value.capture).toThrow('Wait for query tabs to finish connecting')
      if (stop) controller.abort()
      second.resolve()
      await queuedFile
      await continued
      expect(observed).toEqual([expect.objectContaining({ ready: !stop })])
      if (!stop) expect(observed[0].busy).toBe(false)
      expect(execute).toHaveBeenCalledTimes(stop ? 0 : 1)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(stop ? false : undefined)
      expect(() => value.connections.assertCheckpointReady()).not.toThrow()
    } finally { controller.abort(); first.resolve(); second.resolve(); value.dispose() }
  })

  it.each(['stop', 'source-newer-stop', 'source-removal', 'canonical-disconnect', 'canonical-removal', 'canonical-disconnect-rollback'] as const)('does not resurrect old source intent after %s', async intent => {
    const value = await fixture(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>(), controller = new AbortController()
    try {
      const setup = value.receipt()
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      const accepting = acceptConnectionReceipt({ ...setup, signal: controller.signal, current: () => !controller.signal.aborted,
        explicitlyCancelled: () => controller.signal.aborted })
      if (intent === 'stop') controller.abort()
      if (intent === 'source-newer-stop') value.connections.cancelAttempt(value.connections.beginConnect(connectionOptions, 1, id(1))!)
      if (intent === 'source-removal') value.connectionTargets.removeFromExplorer(id(1))
      if (intent.startsWith('canonical-')) {
        const disconnect = value.connectionTargets.beginDisconnect(id(2), id(301))!
        if (intent === 'canonical-disconnect-rollback') value.connectionTargets.failDisconnect(disconnect)
        else value.connectionTargets.completeDisconnect(disconnect)
        if (intent === 'canonical-removal') value.connectionTargets.removeFromExplorer(id(2))
      }
      if (intent === 'stop') expect(value.capture().checkpointCurrent()).toBe(true)
      accepted.resolve({ ok: true, value: { accepted: false, retained: true } })
      expect(await accepting).toBeUndefined()
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(false)
      expect(() => value.connections.assertCheckpointReady()).not.toThrow()
    } finally { controller.abort(); accepted.resolve({ ok: true, value: { accepted: false, retained: true } }); value.dispose() }
  })

  it('releases an accepted details review on explicit cancellation or service disposal', async () => {
    const value = await fixture()
    try {
      const opened = (await acceptConnectionReceipt(value.receipt()))!
      expect(value.reload).toThrow('Wait for query tabs to finish connecting')
      opened.association!.abandon(true)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(false)
      expect(value.reload).not.toThrow()
      const next = (await acceptConnectionReceipt(value.receipt()))!
      expect(value.capture).toThrow('Wait for query tabs to finish connecting')
      value.connections.dispose()
      expect(() => value.connections.assertCheckpointReady()).not.toThrow()
      next.association!.abandon()
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(false)
    } finally { value.dispose() }
  })

  it('lets a window close (a Windows session end) cancel a pending details review only once the close goes ahead', async () => {
    const value = await fixture()
    try {
      const opened = (await acceptConnectionReceipt(value.receipt()))!
      const hidden = vi.fn()
      const unregister = yieldReviewToClose(opened, hidden)
      // A close stopped after its first look (a prompt cancelled, here the cleanup refusing) leaves the review open.
      await value.files.closeWindow(async () => { throw new Error('The user cancelled.') })
      expect(hidden).not.toHaveBeenCalled()
      expect(value.files.getSnapshot().error).not.toContain('Wait for query tabs to finish connecting')
      expect(() => value.connections.assertCheckpointReady(false)).not.toThrow()
      expect(hidden).not.toHaveBeenCalled()
      // Without a yield the handoff still refuses even a first look.
      unregister()
      expect(() => value.connections.assertCheckpointReady(false)).toThrow('Wait for query tabs to finish connecting')
      yieldReviewToClose(opened, hidden)
      // The close that goes ahead cancels it as Cancel would, keeps the session and closes.
      await value.files.closeWindow(async () => {})
      expect(hidden).toHaveBeenCalledTimes(1)
      expect(value.api.keepSession).toHaveBeenCalled()
      expect(value.api.closeWindow).toHaveBeenCalledTimes(1)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(false)
      value.connections.assertCheckpointReady()
      expect(hidden).toHaveBeenCalledTimes(1)
    } finally { value.dispose() }
  })

  it.each(['source-stop', 'canonical-disconnect-rollback', 'abort'] as const)('preserves %s made inside the synchronous adoption publication', async intent => {
    const value = await fixture(), controller = new AbortController()
    let applied = false
    const stop = value.connectionTargets.subscribe(() => {
      const source = value.connectionTargets.get(id(1))
      if (applied || source?.lifecycle.state !== 'disconnected' || source.lifecycle.reason !== 'cancelled') return
      applied = true
      expect(value.capture).toThrow('Wait for query tabs to finish connecting')
      if (intent === 'source-stop') value.connections.cancelAttempt(value.connections.beginConnect(connectionOptions, 1, id(1))!)
      if (intent === 'canonical-disconnect-rollback') value.connectionTargets.failDisconnect(value.connectionTargets.beginDisconnect(id(2), id(301))!)
      if (intent === 'abort') controller.abort()
    })
    try {
      value.api.acceptConnectionRequest.mockResolvedValue({ ok: true, value: { accepted: false, retained: true } })
      expect(await acceptConnectionReceipt({ ...value.receipt(), signal: controller.signal, explicitlyCancelled: () => controller.signal.aborted })).toBeUndefined()
      expect(applied).toBe(true)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(false)
      expect(value.capture().checkpointCurrent()).toBe(true)
      if (intent === 'abort') expect(value.api.acceptConnectionRequest).not.toHaveBeenCalled()
    } finally { stop(); value.dispose() }
  })

  it('repairs intent and releases its guard if synchronous adoption throws after redirecting', async () => {
    const value = await fixture()
    try {
      const accept = value.connections.accept.bind(value.connections)
      vi.spyOn(value.connections, 'accept').mockImplementation((...args) => { accept(...args); throw new Error('Adoption observer failed.') })
      await expect(acceptConnectionReceipt(value.receipt())).rejects.toThrow('Adoption observer failed.')
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(true)
      expect(value.capture().checkpointCurrent()).toBe(true)
      expect(value.api.acceptConnectionRequest).not.toHaveBeenCalled()
    } finally { value.dispose() }
  })
})
