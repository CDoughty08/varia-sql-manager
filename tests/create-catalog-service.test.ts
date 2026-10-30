import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { SsisCatalogSetup, SsisCatalogSetupResult, SsisExecuteResult } from '../src/shared/ssis/schema'
import { createCatalogMessages, CreateCatalogService } from '../src/renderer/src/ssis/CreateCatalogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { LongRunService } from '../src/renderer/src/services/long-runs'
import { longRunMessages } from '../src/shared/long-runs'
import { deferred } from './fixtures/documents'
import { contextRecord } from '../src/shared/commands/context-keys'
import { resolveMenu } from '../src/renderer/src/menus/resolve'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const folder = (id = 4, connectionId = 'server-a'): ExplorerMenuNode => ({
  id, connectionId, ref: { type: 'folder', owner: { kind: 'server' }, folder: 'integrationServicesCatalogs' }, kind: 'folder', folder: 'integrationServicesCatalogs', label: 'Integration Services Catalogs', lost: false
})
const setupOf = (changes: Partial<SsisCatalogSetup> = {}): ApiResult<SsisCatalogSetupResult> => ({
  ok: true, value: { setup: { catalog: 'SSISDB', clrEnabled: false, startupDefault: true, backupFile: 'C:\\DTS\\Binn\\SSISDBBackup.bak', dataFile: 'C:\\Data\\SSISDB.mdf', logFile: 'C:\\Data\\SSISDB.ldf', ...changes }, elapsedMs: 1 }
})
const titles = ['Enable CLR integration', 'Restore the catalog database', 'Create the master key', 'Register the Integration Services assembly and startup procedure', 'Create the maintenance job']
const created: ApiResult<SsisExecuteResult> = { ok: true, value: { steps: titles.map(message => ({ status: 'done', message })), elapsedMs: 1 } }
const secret = "Pa'ss]--w0rd-marker"

/** The service over fakes: the setup answers at once unless a test holds it, and Create waits for the test to answer. */
function setup(answer: ApiResult<SsisCatalogSetupResult> = setupOf()) {
  const execute = deferred<ApiResult<SsisExecuteResult>>()
  const api = {
    catalogSetupSsis: vi.fn<VariaApi['catalogSetupSsis']>(async () => answer),
    executeSsis: vi.fn<VariaApi['executeSsis']>(() => execute.promise),
    cancelSsis: vi.fn<VariaApi['cancelSsis']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  const explorer = { refresh: vi.fn() }
  const longRuns = new LongRunService()
  let ids = 0
  const service = new CreateCatalogService({ api, connections, explorer, longRuns, newId: () => `id-${++ids}` })
  cleanups.push(() => service.dispose(), () => longRuns.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { service, api, connections, explorer, execute, settle, longRuns }
}

describe('CreateCatalogService', () => {
  it('reads the server for Integration Services Catalogs, with SSMS\'s defaults: CLR as in use, the startup box as scan for startup procs', async () => {
    const { service, api, settle } = setup()
    service.open(folder())
    expect(service.current).toMatchObject({ phase: 'loading', server: 'server-a.example', login: 'sa', nodeId: 4 })
    expect(api.catalogSetupSsis.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-1' }]])
    expect(() => service.open(folder())).toThrow('Close the open dialog first.')
    await settle()
    expect(service.current).toMatchObject({ phase: 'ready', enableClr: false, startupProcedure: true, setup: { catalog: 'SSISDB', backupFile: 'C:\\DTS\\Binn\\SSISDBBackup.bak' } })
  })
  it('opens only for Integration Services Catalogs on a live server', () => {
    const { service, connections } = setup()
    expect(() => service.open({ ...folder(), folder: 'databases', ref: { type: 'folder', owner: { kind: 'server' }, folder: 'databases' } })).toThrow('Select Integration Services Catalogs on a connected server.')
    connections.remove('server-a')
    expect(() => service.open(folder())).toThrow('Select Integration Services Catalogs on a connected server.')
    expect(service.current).toBeUndefined()
  })
  it('cancels its setup read when the dialog closes while it loads, so the read frees its SSIS gate at once', async () => {
    const { service, api, settle } = setup()
    const reading = deferred<ApiResult<SsisCatalogSetupResult>>()
    api.catalogSetupSsis.mockImplementationOnce(() => reading.promise)
    service.open(folder())
    expect(service.current?.phase).toBe('loading')
    expect(service.close()).toBe(true)
    expect(api.cancelSsis.mock.calls).toEqual([[['id-1']]])
    expect(service.current).toBeUndefined()
    // The late answer changes nothing, and a new dialog reads again.
    reading.resolve(setupOf())
    await settle()
    expect(service.current).toBeUndefined()
    service.open(folder())
    expect(api.catalogSetupSsis).toHaveBeenCalledTimes(2)
  })
  it('refuses a password that holds half of a surrogate pair before anything runs', async () => {
    const { service, api, settle } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    await service.create('ab\uD800', 'ab\uD800')
    expect(service.current?.problem).toBe(createCatalogMessages.broken)
    expect(api.executeSsis).not.toHaveBeenCalled()
  })
  it('shows why a server cannot have a catalog, and offers no Create', async () => {
    const { service, settle } = setup({ ok: true, value: { elapsedMs: 1, error: { code: 'CATALOG_EXISTS', message: 'There already exists a catalog (SSISDB), and only one catalog is supported on a server.', retryable: false } } })
    service.open(folder())
    await settle()
    expect(service.current).toMatchObject({ phase: 'loadFailed', error: { code: 'CATALOG_EXISTS' } })
    expect(service.current?.setup).toBeUndefined()
  })
  it('fixes the CLR box when CLR is in use, and checks the form as SSMS does before anything runs', async () => {
    const { service, api, settle } = setup()
    service.open(folder())
    await settle()
    await service.create(secret, secret)
    expect(service.current?.problem).toBe(createCatalogMessages.clr)
    service.setEnableClr(true)
    expect(service.current).toMatchObject({ enableClr: true })
    expect(service.current?.problem).toBeUndefined()
    await service.create('', '')
    expect(service.current?.problem).toBe(createCatalogMessages.empty)
    await service.create(secret, secret + 'x')
    expect(service.current?.problem).toBe(createCatalogMessages.mismatch)
    expect(api.executeSsis).not.toHaveBeenCalled()
    // Already in use: checked, and the box cannot clear it.
    const other = setup(setupOf({ clrEnabled: true, startupDefault: false }))
    other.service.open(folder())
    await other.settle()
    other.service.setEnableClr(false)
    expect(other.service.current).toMatchObject({ enableClr: true, startupProcedure: false })
  })
  it('creates the catalog with the password only in its request, then reloads the folder and closes', async () => {
    const { service, api, explorer, execute, settle } = setup()
    const seen: string[] = []
    service.subscribe(() => { seen.push(JSON.stringify(service.getSnapshot())) })
    service.open(folder())
    await settle()
    service.setEnableClr(true)
    service.setStartupProcedure(false)
    const running = service.create(secret, secret)
    expect(service.current).toMatchObject({ phase: 'executing' })
    expect(api.executeSsis.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-2', action: { verb: 'createCatalog', password: secret, enableClr: true, startupProcedure: false } }]])
    expect(service.close()).toBe(false)
    execute.resolve(created)
    await running
    expect(service.current).toBeUndefined()
    expect(explorer.refresh).toHaveBeenCalledWith(4)
    // The snapshot (what React and every subscriber read) never held the password.
    expect(seen.length).toBeGreaterThan(3)
    expect(seen.some(snapshot => snapshot.includes('marker'))).toBe(false)
  })
  it('shows a failure with its steps, and the folder reloads when a step completed', async () => {
    const { service, explorer, execute, settle } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    const running = service.create(secret, secret)
    const message = 'Msg 15118: Password validation failed. Varia removed what Create Catalog had created, so the catalog does not exist.'
    execute.resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'SQL_ERROR', message, retryable: true }, steps: [
      { status: 'done', message: titles[1] }, { status: 'failed', message }, { status: 'skipped', message: titles[3] }, { status: 'skipped', message: titles[4] }, { status: 'done', message: 'Remove the incomplete catalog' }
    ] } })
    await running
    expect(service.current).toMatchObject({ phase: 'failed', error: { code: 'SQL_ERROR', message } })
    expect(service.current?.steps?.map(step => step.status)).toEqual(['done', 'failed', 'skipped', 'skipped', 'done'])
    expect(explorer.refresh).toHaveBeenCalledWith(4)
    // The form stays usable: another try runs again.
    expect(service.close()).toBe(true)
  })
  it('stops once, waits for the backend\'s answer, and reports Stopped', async () => {
    const { service, api, execute, settle } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    const running = service.create(secret, secret)
    service.stop()
    service.stop()
    expect(service.current).toMatchObject({ phase: 'executing', stopping: true })
    expect(api.cancelSsis.mock.calls).toEqual([[['id-2']]])
    execute.resolve({ ok: true, value: { elapsedMs: 1, steps: [], error: { code: 'CANCELLED', message: 'Create Catalog was stopped before its restore. Nothing changed.', retryable: true } } })
    await running
    expect(service.current).toMatchObject({ phase: 'stopped', error: { code: 'CANCELLED' } })
    expect(service.current?.stopping).toBeUndefined()
  })
  it('sends the startup box as the user leaves it: checked by SSMS\'s default (scan for startup procs) or by hand', async () => {
    const { service, api, execute, settle } = setup(setupOf({ clrEnabled: true, startupDefault: true }))
    service.open(folder())
    await settle()
    expect(service.current?.startupProcedure).toBe(true)
    const running = service.create(secret, secret)
    expect(api.executeSsis.mock.calls[0][0].action).toEqual({ verb: 'createCatalog', password: secret, enableClr: true, startupProcedure: true })
    execute.resolve(created)
    await running
    const other = setup(setupOf({ clrEnabled: true, startupDefault: false }))
    other.service.open(folder())
    await other.settle()
    other.service.setStartupProcedure(true)
    void other.service.create(secret, secret)
    expect(other.api.executeSsis.mock.calls[0][0].action).toMatchObject({ startupProcedure: true })
  })
  it('alerts, as a failure does, when Stop\'s removal of what Create Catalog made failed, and says Stopped only when it succeeded', async () => {
    const { service, execute, settle } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    const running = service.create(secret, secret)
    service.stop()
    const message = 'Create Catalog was stopped at "Create the maintenance job"; SQL Server cancelled that statement. Removing what Create Catalog had created failed too (Lock request time out period exceeded.): delete the SSISDB database before you try again.'
    execute.resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'CANCELLED', message, retryable: true }, steps: [
      { status: 'done', message: titles[1] }, { status: 'done', message: titles[2] }, { status: 'done', message: titles[3] }, { status: 'cancelled', message: titles[4] },
      { status: 'failed', message: 'Remove the incomplete catalog: Lock request time out period exceeded.' }
    ] } })
    await running
    expect(service.current).toMatchObject({ phase: 'failed', error: { code: 'CANCELLED', message } })
    expect(service.current?.stopping).toBeUndefined()
  })
  it('is a long run while Create Catalog runs, and only then, so the window, its server and the backend stay up', async () => {
    const { service, execute, settle, longRuns } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    expect(longRuns.getSnapshot().runs).toEqual([])
    const running = service.create(secret, secret)
    expect(longRuns.getSnapshot().runs).toMatchObject([{ kind: 'createCatalog', connectionId: 'server-a', server: 'server-a.example' }])
    expect(longRuns.closeRefusal()).toBe(longRunMessages.close({ kind: 'createCatalog', server: 'server-a.example' }))
    execute.resolve(created)
    await running
    expect(longRuns.getSnapshot().runs).toEqual([])
  })
  it('ends its long run when the request fails too', async () => {
    const { service, api, settle, longRuns } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    api.executeSsis.mockRejectedValueOnce(new Error('IPC lost'))
    await service.create(secret, secret)
    expect(longRuns.getSnapshot().runs).toEqual([])
  })
  it('says the outcome is unknown when the server goes away while it runs, and cancels it', async () => {
    const { service, api, connections, execute, settle } = setup(setupOf({ clrEnabled: true }))
    service.open(folder())
    await settle()
    const running = service.create(secret, secret)
    connections.remove('server-a')
    expect(service.current).toMatchObject({ phase: 'disconnected', error: { code: 'CONNECTION_LOST', message: createCatalogMessages.unknown } })
    expect(api.cancelSsis).toHaveBeenCalledWith(['id-2'])
    execute.resolve(created)
    await running
    expect(service.current?.phase).toBe('disconnected')
    expect(service.close()).toBe(true)
  })
})

describe('Create Catalog command', () => {
  it('is offered on Integration Services Catalogs of a live server only, and not while its dialog is open', () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const target = { kind: 'explorer' as const, node: folder() }
    expect(fixture.commands.canRun('explorer.createCatalog', { target: { kind: 'explorer', node: { ...folder(), folder: 'databases' } } })).toBe(false)
    expect(fixture.commands.canRun('explorer.createCatalog', { target })).toBe(true)
    // The menu selects its node first, so the precondition reads the selection (the smoke suite opens it from the real menu).
    fixture.ssisCatalog.open(folder())
    expect(fixture.ssisCatalog.current).toMatchObject({ connectionId: 'server-a', nodeId: 4 })
    expect(fixture.commands.canRun('explorer.createCatalog', { target })).toBe(false)
  })
  it('keeps the window open, its server connected and the backend up while Create Catalog runs: each reports why, and main hears of the run', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const answer = deferred<ApiResult<SsisExecuteResult>>()
    fixture.api.executeSsis.mockImplementationOnce(() => answer.promise)
    fixture.ssisCatalog.open(folder())
    await new Promise(resolve => setTimeout(resolve, 0))
    fixture.ssisCatalog.setEnableClr(true)
    const running = fixture.ssisCatalog.create(secret, secret)
    expect(fixture.ssisCatalog.current?.phase).toBe('executing')
    await fixture.commands.execute('window.close', undefined, 'menu')
    expect(fixture.api.closeWindow).not.toHaveBeenCalled()
    expect(fixture.api.closeWindowCancelled).toHaveBeenCalledTimes(1)
    const run = { kind: 'createCatalog', server: 'server-a.example' } as const
    expect(fixture.files.getSnapshot().error).toBe(longRunMessages.close(run))
    expect(fixture.api.setLongRuns).toHaveBeenLastCalledWith({ runs: [run], total: 1 })
    // Disconnect's server picker greys the server, naming the run.
    const picker = async () => {
      await fixture.commands.execute('connection.disconnect', undefined, 'palette')
      const row = fixture.quickInput.getSnapshot().rows.find(item => item.item.id === 'server-a')?.item
      fixture.quickInput.hide('cancel')
      return row
    }
    expect(await picker()).toMatchObject({ disabled: true, disabledHint: longRunMessages.stop(run) })
    await fixture.commands.execute('backend.restart', undefined, 'menu')
    expect(fixture.api.restartBackend).not.toHaveBeenCalled()
    expect(fixture.commands.getSnapshot().error).toBe(longRunMessages.stop(run))
    expect(fixture.api.cancelSsis).not.toHaveBeenCalled()
    answer.resolve(created)
    await running
    expect(fixture.api.setLongRuns).toHaveBeenLastCalledWith({ runs: [], total: 0 })
    expect((await picker())?.disabled).toBeUndefined()
    await fixture.commands.execute('window.close', undefined, 'menu')
    expect(fixture.api.closeWindow).toHaveBeenCalledOnce()
    await fixture.commands.execute('backend.restart', undefined, 'menu')
    expect(fixture.api.restartBackend).toHaveBeenCalledOnce()
  })
  it('is hidden from the context menu of a lost server\'s Integration Services Catalogs', () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    const items = (lost: boolean) => resolveMenu('explorer.context', {
      platform: 'win32', state: contextRecord('win32', { explorerNode: 'folder', explorerFolder: 'integrationServicesCatalogs', explorerServerLost: lost }), commands: fixture.commands, keybindings: fixture.keybindings
    }).flatMap(item => item.kind === 'command' ? [item.id] : [])
    expect(items(false)).toContain('explorer.createCatalog')
    expect(items(true)).not.toContain('explorer.createCatalog')
  })
  it('is disabled for a lost node, and for a server whose backend generation ended', () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    expect(fixture.commands.canRun('explorer.createCatalog', { target: { kind: 'explorer', node: { ...folder(), lost: true } } })).toBe(false)
    expect(fixture.commands.canRun('explorer.createCatalog', { target: { kind: 'explorer', node: folder() } })).toBe(true)
    // A restarted backend: the node is still listed, but its connection is lost with the old generation.
    fixture.connections.markLostBefore(2)
    expect(fixture.commands.canRun('explorer.createCatalog', { target: { kind: 'explorer', node: folder() } })).toBe(false)
    fixture.connections.remove('server-a')
    expect(fixture.commands.canRun('explorer.createCatalog', { target: { kind: 'explorer', node: folder() } })).toBe(false)
  })
})
