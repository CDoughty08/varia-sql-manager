import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectionOpenService } from '../src/main/connection-open'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { ConnectionStore } from '../src/main/connection-store'
import { SavedPasswordStore } from '../src/main/saved-passwords'
import { BigQueryConnectionStore } from '../src/main/bigquery-connection-store'
import { BigQueryKeyFiles } from '../src/main/bigquery-credentials'
import { connectionHistory } from '../src/main/connection-history'
import { BackendError } from '../src/main/backend/errors'
import { testCipher } from '../src/main/secret-cipher'
import type { BackendConnectionHandle } from '../src/shared/connection-targets'
import type { BigQueryConnectionOptions, ConnectionInfo } from '../src/shared/contracts'

const options: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', authentication: 'gcloud' }
const ada = 'bigquery:user:ada@example.com'
const directories: string[] = []
const services: ConnectionOpenService[] = []
afterEach(async () => {
  services.splice(0).forEach(service => service.reset())
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const answer = (generation: number, principalId: string | null): ConnectionInfo => ({ id: randomUUID(), generation, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', login: 'ada@example.com', providerId: 'bigquery', ...principalId ? { principalId } : {} })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-bigquery-open-'))
  directories.push(directory)
  const authentication = new ConnectionAuthenticationGuard(), savedPasswords = new SavedPasswordStore(join(directory, 'saved.json'), testCipher())
  const bigQuery = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
  const connections = connectionHistory(new ConnectionStore(join(directory, 'connections.json')), bigQuery)
  let principal: string | null = ada
  const open = vi.fn(async (_params: unknown, generation: number, _signal: AbortSignal) => answer(generation, principal))
  const close = vi.fn(async (_handle: BackendConnectionHandle) => ({ disconnected: true }))
  const service = new ConnectionOpenService({ authentication, savedPasswords, connections, open, close, generation: () => 1, bindingsChanged: () => {} })
  services.push(service)
  const request = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), targetId: randomUUID(), credentialPolicy: 'preserve', ...extra })
  return { service, open, close, authentication, bigQuery, request, signInAs: (value: string | null) => { principal = value } }
}

describe('BigQuery connections through the connection owner', () => {
  it('opens a BigQuery target, pins the verified Google account to it, and records the connect in BigQuery\'s history', async () => {
    const { service, open, authentication, bigQuery, request } = await fixture()
    const context = request()
    const result = await service.connect(options, context)
    expect(result).toMatchObject({ ok: true, value: { providerId: 'bigquery', authentication: { principal: { provider: 'bigquery', project: 'varia-alpha', principal: ada } } } })
    expect(open).toHaveBeenCalledTimes(1)
    // The backend got BigQuery's options as validated (main adds the credential material where it sends them).
    expect(open.mock.calls[0]![0]).toMatchObject(options)
    expect(authentication.resolve(context.targetId)?.expectedPrincipal).toEqual({ provider: 'bigquery', project: 'varia-alpha', principal: ada })
    expect((await bigQuery.load()).library.profiles).toEqual([expect.objectContaining({ options, lastConnected: expect.any(String) })])
  })

  it('refuses another account on a pinned target and closes the handle it opened', async () => {
    const { service, close, request, signInAs } = await fixture()
    const context = request()
    expect(await service.connect(options, context)).toMatchObject({ ok: true })
    await service.accept(context.requestId)
    service.reset({ replaceRenderer: true })
    service.retainTargets([context.targetId])
    signInAs('bigquery:user:grace@example.com')
    const again = await service.connect(options, { ...request(), targetId: context.targetId, mode: 'background', expectedPrincipal: { provider: 'bigquery', project: 'varia-alpha', principal: ada } })
    expect(again).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    expect(close).toHaveBeenCalled()
  })

  it('refuses an answer whose Google account could not be verified', async () => {
    const { service, close, request, signInAs } = await fixture()
    signInAs(null)
    const result = await service.connect(options, request())
    expect(result).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps no password for BigQuery: Remember password and a credential reference are refused before signing in', async () => {
    const { service, open, request } = await fixture()
    expect(await service.connect(options, request({ remember: true }))).toMatchObject({ ok: false, connectionFailure: 'credentials-required' })
    expect(await service.connect(options, request({ credentialPolicy: 'remember' }))).toMatchObject({ ok: false, connectionFailure: 'credentials-required' })
    // A background reconnect needs the account it is pinned to.
    expect(await service.connect(options, request({ mode: 'background' }))).toMatchObject({ ok: false })
    // An expected account of another project is another connection.
    expect(await service.connect(options, request({ expectedPrincipal: { provider: 'bigquery', project: 'varia-beta', principal: ada } }))).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    expect(open).not.toHaveBeenCalled()
  })

  it('maps BigQuery\'s failures to the target lifecycle: Google unreachable is a network failure, not backend loss', async () => {
    const { service, open, request } = await fixture()
    open.mockRejectedValueOnce(new BackendError('CONNECTION_LOST', 'BigQuery could not be reached.'))
    expect(await service.connect(options, request())).toMatchObject({ ok: false, connectionFailure: 'network' })
    open.mockRejectedValueOnce(new BackendError('AUTH_EXPIRED', 'Your Google sign-in has expired.'))
    expect(await service.connect(options, request())).toMatchObject({ ok: false, connectionFailure: 'sign-in-required' })
    open.mockRejectedValueOnce(new BackendError('AUTH_KEY_FILE', 'The key file could not be read.'))
    expect(await service.connect(options, request())).toMatchObject({ ok: false, connectionFailure: 'credentials-required' })
  })

  it('loads the project\'s datasets through the owner with BigQuery\'s options', async () => {
    const { service, request } = await fixture()
    const load = vi.fn(async (_options: unknown) => [{ name: 'sales', isSystem: false, isSnapshot: false, location: 'EU' }])
    const result = await service.databases(options, request(), load)
    expect(result).toMatchObject({ ok: true, value: [{ name: 'sales', location: 'EU' }] })
    expect(load.mock.calls[0]![0]).toMatchObject(options)
  })

  it('deduplicates equivalent live BigQuery connections and auto-claims migrated projects on verified connect', async () => {
    const { service, open, close, bigQuery, request } = await fixture()
    await bigQuery.addMigratedProjects(['varia-beta', 'bigquery-public-data'])
    const first = request()
    const firstResult = await service.connect(options, first)
    expect(firstResult).toMatchObject({ ok: true })
    await service.accept(first.requestId)
    // Migrated projects were claimed into starredProjects for the verified principal on connect.
    expect(await bigQuery.loadStarredProjects()).toEqual({ byPrincipal: { [ada]: ['varia-beta', 'bigquery-public-data'] } })
    expect((await bigQuery.load()).library.migratedProjects).toBeUndefined()
    // Connecting again with identical BigQuery settings and principal reuses the live handle and disposes the duplicate.
    const second = request()
    const secondResult = await service.connect(options, second)
    expect(secondResult).toMatchObject({ ok: true, value: { id: (firstResult as { ok: true; value: ConnectionInfo }).value.id, targetId: first.targetId } })
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
