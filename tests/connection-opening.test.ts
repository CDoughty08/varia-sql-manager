import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionOptions } from '../src/shared/contracts'
import type { ConnectionAuthentication, ConnectionDetails } from '../src/shared/connection-targets'
import { adoptConnection, finishConnectionDetails, needsDetailsConfirmation } from '../src/renderer/src/services/connection-opening'
import { ConnectionService, type ConnectionAttempt, type TargetConnectionInfo } from '../src/renderer/src/services/connections'
import { ConnectionTargetService, type ConnectionCompletion } from '../src/renderer/src/services/connection-targets'
import { connectionOptions, workbenchFixture } from './fixtures/workbench'

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const authentication: ConnectionAuthentication = { principal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' } }
const current: ConnectionDetails = { displayName: 'Reporting', color: '#123456', environment: 'Test', autoReconnect: 'inherit' }
const selected: ConnectionDetails = { displayName: 'Production reporting', color: '#abcdef', environment: 'Production', autoReconnect: 'off' }
const options: ConnectionOptions = { ...connectionOptions, displayName: current.displayName, color: current.color, environment: current.environment }
const receipt = (target = 1, handle = 101, generation = 1): TargetConnectionInfo => ({
  id: uuid(handle), targetId: uuid(target), generation, server: options.server, database: options.database, serverVersion: '17.0', authentication
})
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function fixture() {
  const targets = new ConnectionTargetService(), connections = new ConnectionService(targets)
  cleanups.push(() => { connections.dispose(); targets.dispose() })
  return { connections, targets }
}
function open(connections: ConnectionService, info = receipt(), chosen = options, details = current) {
  const previous = connections.get(info.targetId ?? info.id)
  const attempt = previous && connections.isLive(previous.id) ? undefined : connections.beginConnect(chosen, info.generation, info.targetId, details)
  return adoptConnection(connections, info, chosen, details, attempt)
}

describe('successful connection adoption', () => {
  it('uses the main target receipt to reuse the exact authenticated live handle without another root or details prompt', () => {
    const { connections, targets } = fixture(), info = receipt()
    const first = open(connections, info)!
    expect(first).toMatchObject({ id: info.id, targetId: info.targetId, generation: 1, reused: false })
    expect(needsDetailsConfirmation(first)).toBe(false)
    const before = targets.getSnapshot()
    const again = adoptConnection(connections, info, options)!
    expect(again).toMatchObject({ id: info.id, targetId: info.targetId, previousId: info.id, reused: true })
    expect(needsDetailsConfirmation(again)).toBe(false)
    expect(finishConnectionDetails(connections, again, 'current')?.id).toBe(info.id)
    expect(targets.getSnapshot()).toEqual(before)
    expect(connections.getSnapshot()).toHaveLength(1)
    expect(connections.get(info.targetId!)?.id).toBe(info.id)
    expect(JSON.stringify(targets.exportWorkspace())).not.toMatch(/password|never-keep-this|lifecycle|generation/)
  })

  it('keeps distinct main target IDs separate even when their nonsecret settings and account evidence are equal', () => {
    const { connections, targets } = fixture()
    const first = open(connections, receipt(1, 101))!, second = open(connections, receipt(2, 102))!
    expect([first.reused, second.reused]).toEqual([false, false])
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1), uuid(2)])
    expect(targets.get(uuid(1))?.options).toEqual(targets.get(uuid(2))?.options)
    expect(connections.getSnapshot().map(connection => connection.id)).toEqual([uuid(101), uuid(102)])
  })

  it('reconnects one stable target in its original position while replacing only its runtime handle', () => {
    const { connections, targets } = fixture()
    open(connections, receipt(1, 101))
    open(connections, receipt(2, 102))
    connections.disconnected(uuid(101))
    expect(connections.get(uuid(1))).toMatchObject({ id: uuid(101), targetId: uuid(1), lost: true, inExplorer: true })
    const reconnected = open(connections, receipt(1, 103))!
    expect(reconnected).toMatchObject({ id: uuid(103), targetId: uuid(1), previousId: uuid(101), reused: true })
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1), uuid(2)])
    expect(connections.getSnapshot().map(connection => connection.id)).toEqual([uuid(103), uuid(102)])
    expect(targets.get(uuid(1))?.details).toEqual(current)
    expect(connections.get(uuid(101))).toBeUndefined()
  })

  it('rejects an older-generation receipt without adopting it or replacing the remembered target', () => {
    const { connections, targets } = fixture()
    open(connections)
    connections.markLostBefore(2)
    const before = targets.getSnapshot()
    expect(adoptConnection(connections, receipt(1, 103, 1), options)).toBeUndefined()
    expect(targets.getSnapshot()).toBe(before)
    expect(connections.get(uuid(1))).toMatchObject({ id: uuid(101), lost: true })
  })

  it('rejects receipts without authoritative target and account evidence', () => {
    const { connections } = fixture()
    const { targetId: _targetId, authentication: _authentication, ...first } = receipt()
    expect(adoptConnection(connections, first, options)).toBeUndefined()
    expect(adoptConnection(connections, { ...first, targetId: uuid(1) }, options)).toBeUndefined()
    expect(adoptConnection(connections, { ...first, authentication }, options)).toBeUndefined()
    expect(adoptConnection(connections, first, options)).toBeUndefined()
    expect(connections.getSnapshot()).toEqual([])
  })
})

describe('registry connection attempt ownership', () => {
  it('keeps a new provisional root new and retains its selected reconnect preference after authentication', () => {
    const { connections, targets } = fixture()
    const attempt = connections.beginConnect(options, 1, uuid(1), selected)!
    expect(attempt.created).toBe(true)
    expect(targets.get(uuid(1))?.lifecycle.state).toBe('connecting')
    const opened = adoptConnection(connections, receipt(), options, selected, attempt)!
    expect(opened.reused).toBe(false)
    expect(opened.previousId).toBeUndefined()
    expect(needsDetailsConfirmation(opened)).toBe(false)
    expect(targets.get(uuid(1))?.details).toEqual(selected)
    expect(connections.get(uuid(1))).toMatchObject({ id: uuid(101), targetId: uuid(1), lifecycle: { state: 'connected' } })
  })

  it('requires a current operation before adopting a new authenticated handle', () => {
    const { connections, targets } = fixture()
    expect(connections.accept(receipt(), options, uuid(1), authentication)).toEqual({ status: 'stale', dispose: { id: uuid(101), generation: 1 } })
    expect(targets.getSnapshot()).toEqual([])
    expect(connections.getSnapshot()).toEqual([])
  })

  it.each(['cancel', 'remove', 'loss', 'replacement'] as const)('rejects a late authenticated handle after attempt %s without restoring its target', change => {
    const { connections, targets } = fixture()
    const attempt = connections.beginConnect(options, 1, uuid(1), current)!
    if (change === 'cancel') connections.cancelAttempt(attempt)
    if (change === 'remove') targets.removeFromExplorer(uuid(1))
    if (change === 'loss') connections.markLostBefore(2)
    let replacement: ConnectionAttempt | undefined
    if (change === 'replacement') {
      targets.cancelConnect(uuid(1))
      replacement = connections.beginConnect(options, 1, uuid(1), current)!
    }
    const before = targets.getSnapshot()
    expect(connections.accept(receipt(), options, uuid(1), authentication, attempt)).toEqual({ status: 'stale', dispose: { id: uuid(101), generation: 1 } })
    expect(targets.getSnapshot()).toBe(before)
    expect(connections.isLive(uuid(1))).toBe(false)
    if (change === 'remove') expect(targets.get(uuid(1))?.inExplorer).toBe(false)
    if (replacement) {
      expect(targets.operation(uuid(1))).toBe(replacement.operation)
      expect(connections.accept(receipt(1, 103), options, uuid(1), authentication, replacement)).toEqual({ status: 'accepted' })
      expect(connections.get(uuid(1))?.id).toBe(uuid(103))
    }
  })

  it('adopts the main owner of an equivalent connect and retires the caller\'s provisional root', () => {
    const { connections, targets } = fixture()
    open(connections)
    const ownerBefore = targets.get(uuid(1)), attempt = connections.beginConnect(options, 1, uuid(2), selected)!
    const opened = adoptConnection(connections, receipt(), options, selected, attempt)!
    expect(opened).toMatchObject({ id: uuid(101), targetId: uuid(1), reused: true, current, selected })
    expect(needsDetailsConfirmation(opened)).toBe(true)
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1)])
    expect(targets.get(uuid(1))?.lifecycle).toEqual(ownerBefore?.lifecycle)
    expect(connections.getSnapshot()).toHaveLength(1)
  })

  it('does not let a cancelled joining caller adopt or dispose an accepted owner\'s handle', () => {
    const { connections, targets } = fixture()
    open(connections)
    const attempt = connections.beginConnect(options, 1, uuid(2), selected)!
    connections.cancelAttempt(attempt)
    const before = targets.getSnapshot(), completions: ConnectionCompletion[] = []
    expect(adoptConnection(connections, receipt(), options, selected, attempt, completion => completions.push(completion))).toBeUndefined()
    expect(completions).toEqual([{ status: 'in-use', targetId: uuid(1) }])
    expect(targets.getSnapshot()).toBe(before)
    expect(connections.get(uuid(1))).toMatchObject({ id: uuid(101), lifecycle: { state: 'connected' } })
  })

  it('reuses an offline main-selected target in its original position and keeps its details until the user chooses', () => {
    const { connections, targets } = fixture()
    open(connections)
    open(connections, receipt(2, 102))
    connections.disconnected(uuid(101))
    const attempt = connections.beginConnect(options, 1, uuid(3), selected)!
    const opened = adoptConnection(connections, receipt(1, 103), options, selected, attempt)!
    expect(opened).toMatchObject({ id: uuid(103), targetId: uuid(1), previousId: uuid(101), reused: true, current, selected })
    expect(needsDetailsConfirmation(opened)).toBe(true)
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1), uuid(2)])
    expect(targets.get(uuid(1))?.details).toEqual(current)
    expect(connections.getSnapshot().map(connection => connection.id)).toEqual([uuid(103), uuid(102)])
    expect(finishConnectionDetails(connections, opened, 'current')?.id).toBe(uuid(103))
    expect(targets.get(uuid(1))?.details).toEqual(current)
  })

  it.each(['remove', 'remove-and-reveal', 'replacement'] as const)('rejects offline reuse after an intervening %s even if its final state looks the same', change => {
    const { connections, targets } = fixture()
    open(connections)
    connections.disconnected(uuid(101))
    const attempt = connections.beginConnect(options, 1, uuid(3), selected)!
    if (change === 'remove' || change === 'remove-and-reveal') expect(targets.removeFromExplorer(uuid(1))).toBe(true)
    if (change === 'remove-and-reveal') expect(targets.reveal(uuid(1))).toBe(true)
    if (change === 'replacement') {
      expect(open(connections, receipt(1, 104))).toBeDefined()
      connections.disconnected(uuid(104))
    }
    const before = targets.get(uuid(1)), completions: ConnectionCompletion[] = []
    expect(adoptConnection(connections, receipt(1, 103), options, selected, attempt, completion => completions.push(completion))).toBeUndefined()
    expect(completions).toEqual([{ status: 'stale', dispose: { id: uuid(103), generation: 1 } }])
    expect(targets.get(uuid(1))).toEqual(before)
    expect(targets.get(uuid(3))).toBeUndefined()
    expect(targets.get(uuid(1))?.lifecycle.state).toBe('disconnected')
    expect(targets.get(uuid(1))?.details).toEqual(current)
    expect(connections.isLive(uuid(1))).toBe(false)
    if (change === 'remove') expect(targets.get(uuid(1))?.inExplorer).toBe(false)
    if (change === 'replacement') expect(connections.get(uuid(1))?.id).toBe(uuid(104))
  })

  it('allows presentation edits during offline authentication and rejects a review made stale by another presentation edit', () => {
    const { connections, targets } = fixture()
    open(connections)
    connections.disconnected(uuid(101))
    const attempt = connections.beginConnect(options, 1, uuid(3), selected)!
    const renamed = { ...current, displayName: 'Renamed during authentication' }
    targets.setDetails(uuid(1), renamed)
    const opened = adoptConnection(connections, receipt(1, 103), options, selected, attempt)!
    expect(opened).toMatchObject({ id: uuid(103), targetId: uuid(1), reused: true, current: renamed })
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1)])
    expect(needsDetailsConfirmation(opened)).toBe(true)
    const editedAgain = { ...renamed, environment: 'Staging' }
    targets.setDetails(uuid(1), editedAgain)
    expect(finishConnectionDetails(connections, opened, 'selected')).toBeUndefined()
    expect(finishConnectionDetails(connections, opened, 'current')).toBeUndefined()
    expect(targets.get(uuid(1))?.details).toEqual(editedAgain)
    expect(connections.get(uuid(1))).toMatchObject({ id: uuid(103), lifecycle: { state: 'connected' } })
  })
  it('rejects a late offline receipt after its target was pruned and recreated with identical persisted details', () => {
    const { connections, targets } = fixture()
    open(connections)
    connections.disconnected(uuid(101))
    const original = targets.exportWorkspace().targets[0]
    const attempt = connections.beginConnect(options, 1, uuid(3), selected)!
    targets.removeFromExplorer(uuid(1))
    expect(targets.pruneUnreferenced(new Set([uuid(3)]))).toEqual([uuid(1)])
    targets.add(original)
    expect(adoptConnection(connections, receipt(1, 103), options, selected, attempt)).toBeUndefined()
    expect(targets.getSnapshot().map(target => target.id)).toEqual([uuid(1)])
    expect(targets.get(uuid(1))?.lifecycle.state).toBe('disconnected')
  })

  it('shadows a legacy entry when its stable target is provisionally registered, leaving exactly one Explorer root', () => {
    const { connections, targets } = fixture()
    const { targetId: _targetId, authentication: _authentication, ...legacy } = receipt()
    connections.add(legacy, options)
    const legacyTarget = connections.get(legacy.id)!.targetId!
    connections.disconnected(legacy.id)
    const attempt = connections.beginConnect(options, 1, legacyTarget, current)!
    expect(attempt.created).toBe(true)
    expect(connections.getSnapshot()).toHaveLength(1)
    expect(connections.getSnapshot()[0]).toMatchObject({ id: legacy.id, targetId: legacyTarget, lost: true, lifecycle: { state: 'connecting' } })
    const opened = adoptConnection(connections, { ...receipt(1, 103), targetId: legacyTarget }, options, current, attempt)!
    expect(opened).toMatchObject({ id: uuid(103), targetId: legacyTarget })
    expect(targets.getSnapshot()).toHaveLength(1)
    expect(connections.getSnapshot()).toHaveLength(1)
    expect(connections.getSnapshot()[0]).toMatchObject({ id: uuid(103), targetId: legacyTarget, lifecycle: { state: 'connected' } })
    expect(connections.get(legacy.id)).toBeUndefined()
    connections.disconnected(uuid(103))
    connections.remove(uuid(103))
    expect(targets.pruneUnreferenced(new Set())).toEqual([legacyTarget])
    expect(connections.getSnapshot()).toEqual([])
  })
})

describe('selected connection details confirmation', () => {
  it.each(['selected', 'current', 'cancel'] as const)('%s changes only the chosen target details and preserves attached query sessions', choice => {
    const workbench = workbenchFixture(), { connections, connectionTargets, documents, queries, api, host } = workbench
    cleanups.push(workbench.dispose)
    const info = receipt()
    open(connections, info)
    documents.create('sales.sql', 'SELECT 1', 'Sales', info.id)
    documents.create('warehouse.sql', 'SELECT 2', 'Warehouse', info.id)
    const documentsBefore = documents.getSnapshot(), sessionsBefore = queries.getSnapshot(), handleBefore = connectionTargets.get(info.targetId!)!.lifecycle
    const opened = adoptConnection(connections, info, { ...options, displayName: selected.displayName, color: selected.color, environment: selected.environment }, selected)!
    expect(needsDetailsConfirmation(opened)).toBe(true)
    expect(connectionTargets.get(info.targetId!)?.details).toEqual(current)
    const answer = finishConnectionDetails(connections, opened, choice)
    expect(answer?.id).toBe(choice === 'cancel' ? undefined : info.id)
    expect(connectionTargets.get(info.targetId!)?.details).toEqual(choice === 'selected' ? selected : current)
    expect(connectionTargets.get(info.targetId!)?.lifecycle).toEqual(handleBefore)
    expect(documents.getSnapshot()).toBe(documentsBefore)
    expect(queries.getSnapshot()).toBe(sessionsBefore)
    expect(api.execute).not.toHaveBeenCalled()
    expect(host.disconnect).not.toHaveBeenCalled()
    expect(connectionTargets.getSnapshot()).toHaveLength(1)
  })

  it.each([
    { displayName: 'Another name' }, { color: '#654321' }, { environment: 'Production' }, { autoReconnect: 'on' }
  ] as const)('requires confirmation for each changed target detail: %j', change => {
    const { connections } = fixture()
    open(connections)
    const opened = adoptConnection(connections, receipt(), options, { ...current, ...change })!
    expect(needsDetailsConfirmation(opened)).toBe(true)
  })

  it.each(['disconnecting', 'disconnect', 'remove', 'loss', 'replacement'] as const)('does not apply a stale prompt after %s', change => {
    const { connections, targets } = fixture()
    open(connections)
    const opened = adoptConnection(connections, receipt(), options, selected)!
    if (change === 'disconnecting') expect(targets.beginDisconnect(uuid(1), uuid(201))).toBeDefined()
    if (change === 'disconnect' || change === 'remove' || change === 'replacement') connections.disconnected(uuid(101))
    if (change === 'remove') connections.remove(uuid(101))
    if (change === 'loss') connections.markLostBefore(2)
    if (change === 'replacement') open(connections, receipt(1, 103))
    const before = targets.getSnapshot()
    expect(finishConnectionDetails(connections, opened, 'selected')).toBeUndefined()
    expect(finishConnectionDetails(connections, opened, 'current')).toBeUndefined()
    expect(targets.getSnapshot()).toBe(before)
    expect(targets.get(uuid(1))?.details).toEqual(current)
    if (change === 'remove') expect(targets.get(uuid(1))?.inExplorer).toBe(false)
  })
})
