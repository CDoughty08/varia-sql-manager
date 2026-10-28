import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, ExplorerNode } from '../src/shared/contracts'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { folderSpecs, kindSpecs, nodeKinds, type FolderId, type NodeKind } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../src/shared/explorer/refs'
import { ssisDefaultVerb, ssisDocumentSpecs, ssisVerbs, ssisVerbSpecs } from '../src/shared/ssis/catalog'
import type { SsisDescribeRequest, SsisDescribeResult, SsisEnvironmentModel, SsisFolderModel, SsisPackageModel, SsisProjectModel } from '../src/shared/ssis/schema'
import { isCustomKind, isTextDocument, kindInfo } from '../src/renderer/src/documents'

import { parameterSource, parameterValue, referenceFolder, sensitiveMask, ssisCrumbs, ssisFacts, ssisHeaderState, ssisSectionViews, ssisTime, truncatedNote, validationLabel } from '../src/renderer/src/ssis/properties-view'
import type { SsisPropertiesState } from '../src/renderer/src/ssis/SsisPropertiesService'
import { SsisNotice } from '../src/renderer/src/ssis/SsisProperties'
import { listLimits, listWindow, maskedLabel, noneLabel } from '../src/renderer/src/ssis/PropertiesList'
import { ssisFocuser, type SsisFocusHost } from '../src/renderer/src/ssis/focus'
import { initialFrameState, toggleSection } from '../src/renderer/src/kit/document-frame'
import { deferred } from './fixtures/documents'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const time = '2026-10-21T14:05:06.1234567+02:00'
const folder: SsisFolderModel = { view: 'folder', id: 1, name: 'Finance', description: 'Nightly loads', createdBy: 'CONTOSO\\etl', created: time, projects: 3, environments: 1 }
const project: SsisProjectModel = {
  view: 'project', id: 3, folder: 'Finance', name: 'Loads', formatVersion: 1, deployedBy: 'CONTOSO\\etl', deployed: time, created: time, versionLsn: 42, validationStatus: 'N',
  packages: [{ name: 'Daily.dtsx', entryPoint: true, version: '1.0.7' }, { name: 'Child.dtsx', entryPoint: false, version: '1.0.2', description: 'Called by Daily' }],
  parameters: [
    { name: 'Server', dataType: 'String', required: true, sensitive: false, designDefault: 'localhost', value: 'sql01', valueType: 'V', valueSet: true },
    { name: 'Password', dataType: 'String', required: false, sensitive: true, valueType: 'V', valueSet: true },
    { name: 'Port', dataType: 'Int32', required: false, sensitive: false, valueType: 'R', valueSet: true, variable: 'PortVariable' },
    { name: 'Timeout', dataType: 'Int32', required: false, sensitive: false, designDefault: '30', valueType: 'V', valueSet: false }
  ],
  references: [{ id: 7, type: 'R', environment: 'Test', validationStatus: 'N' }, { id: 8, type: 'A', folder: 'Shared', environment: 'Prod', validationStatus: 'V' }], truncated: false
}
const pkg: SsisPackageModel = { view: 'package', id: 11, folder: 'Finance', project: 'Loads', name: 'Daily.dtsx', formatVersion: 8, version: '1.0.7', entryPoint: true, validationStatus: 'N', parameters: [], truncated: false }
const environment: SsisEnvironmentModel = {
  view: 'environment', id: 5, folder: 'Finance', name: 'Test', createdBy: 'CONTOSO\\etl', created: time,
  variables: [{ name: 'Port', type: 'Int32', sensitive: false, value: '1433' }, { name: 'Secret', type: 'String', sensitive: true }], truncated: false
}
const targets: Record<'ssisFolder' | 'ssisProject' | 'ssisPackage' | 'ssisEnvironment', ObjectRef> = {
  ssisFolder: { kind: 'ssisFolder', name: 'Finance' },
  ssisProject: { kind: 'ssisProject', ssisFolder: 'Finance', name: 'Loads' },
  ssisPackage: { kind: 'ssisPackage', ssisFolder: 'Finance', ssisProject: 'Loads', name: 'Daily.dtsx' },
  ssisEnvironment: { kind: 'ssisEnvironment', ssisFolder: 'Finance', name: 'Test' }
}
const models = { folder, project, package: pkg, environment } as const
const html = (element: ReactElement) => renderToStaticMarkup(element)
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

function ssis() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.api.explorerChildren.mockImplementation(async params => ({ ok: true, value: catalogTree(params) }))
  fixture.api.describeSsis.mockImplementation(async params => ({ ok: true, value: { model: models[params.view as keyof typeof models], revision: 'a'.repeat(64), elapsedMs: 1 } }))
  fixture.connect(connectionInfo('c1'))
  const requests = () => fixture.api.describeSsis.mock.calls.map(([request]) => request as SsisDescribeRequest)
  const state = (id: string) => fixture.ssisProperties.get(id)!
  /** Selects the kind's object in Object Explorer, expanding the catalog down to it, as a right-click selects its row. */
  const select = async (kind: keyof typeof targets, connectionId = 'c1', server = `${connectionId}.example`) => {
    const find = async (label: string) => {
      let id: number | undefined
      await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(item => item?.label === label && item.connectionId === connectionId)?.id; expect(id, label).toBeDefined() })
      return id!
    }
    for (const label of [server, ...paths[kind].slice(0, -1)]) {
      const id = await find(label)
      if (!fixture.explorer.getSnapshot().rows.nodes.find(item => item?.id === id)?.expanded) fixture.explorer.expand(id)
    }
    fixture.explorer.select(await find(paths[kind].at(-1)!))
    return fixture.explorer.menuNode(fixture.explorer.getSnapshot().selected)!
  }
  /** Its menu's item: the node's own menu target, with the selection's keys. */
  const run = async (command: Parameters<typeof fixture.commands.execute>[0], kind: keyof typeof targets, connectionId = 'c1', server?: string) =>
    fixture.commands.execute(command, { target: { kind: 'explorer', node: await select(kind, connectionId, server) } }, 'menu')
  return { ...fixture, requests, state, run, select }
}
/** The catalog below every server: SSISDB › Finance › Projects › Loads › Packages › Daily.dtsx, and Finance › Environments › Test. */
const paths: Record<keyof typeof targets, readonly string[]> = {
  ssisFolder: ['Integration Services Catalogs', 'SSISDB', 'Finance'],
  ssisProject: ['Integration Services Catalogs', 'SSISDB', 'Finance', 'Projects', 'Loads'],
  ssisPackage: ['Integration Services Catalogs', 'SSISDB', 'Finance', 'Projects', 'Loads', 'Packages', 'Daily.dtsx'],
  ssisEnvironment: ['Integration Services Catalogs', 'SSISDB', 'Finance', 'Environments', 'Test']
}
function catalogTree(params: ExplorerChildrenParams): ExplorerChildrenResult {
  const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
  const object = (value: ObjectRef, hasChildren: boolean): ExplorerNode => ({ ref: { type: 'object', object: value }, label: value.name!, icon: kindSpecs[value.kind].icon, hasChildren })
  const { node } = params
  const nodes = node.type === 'object'
    ? node.object.kind === 'server' ? [folder(node.object, 'integrationServicesCatalogs')]
      : node.object.kind === 'ssisCatalog' ? [object(targets.ssisFolder, true)]
        : node.object.kind === 'ssisFolder' ? [folder(node.object, 'ssisProjects'), folder(node.object, 'ssisEnvironments')]
          : node.object.kind === 'ssisProject' ? [folder(node.object, 'ssisPackages')] : []
    : node.folder === 'integrationServicesCatalogs' ? [object({ kind: 'ssisCatalog', name: 'SSISDB' }, true)]
      : node.folder === 'ssisProjects' ? [object(targets.ssisProject, true)]
        : node.folder === 'ssisEnvironments' ? [object(targets.ssisEnvironment, false)]
          : node.folder === 'ssisPackages' ? [object(targets.ssisPackage, false)] : []
  return { nodes, total: nodes.length, elapsedMs: 1 }
}
const viewState = (model: SsisPropertiesState['model'], extra: Partial<SsisPropertiesState> = {}): SsisPropertiesState => {
  const kind = (model ? `ssis${model.view[0].toUpperCase()}${model.view.slice(1)}` : 'ssisProject') as SsisPropertiesState['kind']
  return { id: 'd1', kind, target: targets[kind], connectionId: 'c1', server: 'sql01', serverLabel: 'Production SQL', loading: false, gone: false, disconnected: false, frame: initialFrameState(ssisDocumentSpecs[kind].sections), ...model ? { model, loadedAt: 1000 } : {}, ...extra }
}

describe('SSIS properties documents', () => {
  it('open from a node\'s Properties as a read-only tab named as SSMS names the dialog, and read the object', async () => {
    const { documents, ssisProperties, requests, state, run, context, api } = ssis()
    const first = deferred<ApiResult<SsisDescribeResult>>()
    api.describeSsis.mockReturnValueOnce(first.promise)
    await run('ssis.folderProperties', 'ssisFolder')
    const id = documents.getSnapshot().activeId
    expect(documents.active).toMatchObject({ id, kind: 'ssisFolder', name: 'Folder Properties - Finance', dirty: false, connectionId: 'c1', database: 'SSISDB' })
    expect(isTextDocument(documents.active) || !isCustomKind('ssisFolder')).toBe(false)
    expect(state(id)).toMatchObject({ loading: true, kind: 'ssisFolder', target: targets.ssisFolder, serverLabel: 'c1.example' })
    expect(context.getState().activeDocumentIsSsis).toBe(true)
    first.resolve({ ok: true, value: { model: folder, revision: 'a'.repeat(64), elapsedMs: 1 } })
    await settled()
    expect(requests()).toEqual([expect.objectContaining({ connectionId: 'c1', view: 'folder', target: targets.ssisFolder })])
    expect(state(id)).toMatchObject({ loading: false, model: folder, gone: false })
    expect(state(id).loadedAt).toBeGreaterThan(0)
    // Each kind opens its own document with its own view.
    for (const [command, kind, view] of [['ssis.projectProperties', 'ssisProject', 'project'], ['ssis.packageProperties', 'ssisPackage', 'package'], ['ssis.environmentProperties', 'ssisEnvironment', 'environment']] as const) {
      await run(command, kind)
      await settled()
      expect(documents.active?.kind).toBe(kind)
      expect(requests().at(-1)).toMatchObject({ view, target: targets[kind] })
      expect(ssisProperties.get(documents.getSnapshot().activeId)?.model?.view).toBe(view)
    }
    expect(documents.getSnapshot().documents.filter(document => document.kind?.startsWith('ssis')).map(document => document.name))
      .toEqual(['Folder Properties - Finance', 'Project Properties - Loads', 'Package Properties - Daily.dtsx', 'Environment Properties - Test'])
  })
  it('shows an open object\'s tab again and reads it again, but a second server\'s object gets its own', async () => {
    const { documents, requests, run, connect } = ssis()
    connect(connectionInfo('c2'))
    await run('ssis.projectProperties', 'ssisProject')
    await settled()
    const first = documents.getSnapshot().activeId
    documents.newQuery()
    await run('ssis.projectProperties', 'ssisProject')
    await settled()
    expect(documents.getSnapshot().activeId).toBe(first)
    expect(requests()).toHaveLength(2)
    await run('ssis.projectProperties', 'ssisProject', 'c2')
    expect(documents.getSnapshot().activeId).not.toBe(first)
    expect(documents.getSnapshot().documents.filter(document => document.kind === 'ssisProject')).toHaveLength(2)
  })
  it('offer each Properties only on its own kind, by the selection\'s keys, on a connected server, and open a package\'s and an environment\'s by default', async () => {
    const { commands, connections, select, context, explorer, documents } = ssis()
    const offered = () => ssisVerbs.filter(verb => commands.isEnabled(ssisVerbSpecs[verb].command)).map(verb => ssisVerbSpecs[verb].command)
    expect(offered()).toEqual([])
    await select('ssisFolder')
    expect(offered()).toEqual(['ssis.folderProperties'])
    expect(context.getState()).toMatchObject({ ssisVerbFolderProperties: 'enabled', ssisVerbProjectProperties: '', explorerActionProperties: '' })
    await select('ssisProject')
    expect(offered()).toEqual(['ssis.projectProperties'])
    // The catalog itself has no Properties yet (Catalog Properties is a later verb), nor does Object Explorer's own apply.
    const catalog = explorer.getSnapshot().rows.nodes.find(item => item?.label === 'SSISDB')!
    explorer.select(catalog.id)
    expect(offered()).toEqual([])
    expect(commands.isEnabled('explorer.properties')).toBe(false)
    // Enter and a double-click run the kind's default verb: a package's and an environment's Properties, as in SSMS.
    expect(nodeKinds.filter(kind => ssisDefaultVerb(kind)).map(kind => [kind, ssisDefaultVerb(kind)])).toEqual([['ssisPackage', 'packageProperties'], ['ssisEnvironment', 'environmentProperties']])
    expect(ssisDefaultVerb('folder')).toBeUndefined()
    await select('ssisPackage')
    expect(offered()).toEqual(['ssis.packageProperties'])
    // A menu opened for a node of a lost connection, or once the server is disconnected, offers nothing.
    const menuNode = explorer.menuNode(explorer.getSnapshot().selected)!
    expect(commands.isEnabled('ssis.packageProperties', { target: { kind: 'explorer', node: { ...menuNode, lost: true } } })).toBe(false)
    connections.remove('c1')
    expect(offered()).toEqual([])
    expect(documents.getSnapshot().documents.some(document => document.kind?.startsWith('ssis'))).toBe(false)
  })
  it('refreshes with F5 in the document, keeping the last model while it reads, and shows a failure over it', async () => {
    const { documents, api, state, run, keybindings, focused } = ssis()
    await run('ssis.packageProperties', 'ssisPackage')
    await settled()
    const id = documents.getSnapshot().activeId
    const prevented: string[] = []
    const f5 = () => keybindings.handleKeyDown({ key: 'F5', code: 'F5', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 116, defaultPrevented: false, preventDefault: () => prevented.push('F5'), stopPropagation: () => {} })
    // In Object Explorer, F5 refreshes the tree, not the document.
    focused.panel = 'explorer'
    f5()
    await settled()
    expect(api.describeSsis).toHaveBeenCalledTimes(1)
    const pending = deferred<ApiResult<SsisDescribeResult>>()
    api.describeSsis.mockReturnValueOnce(pending.promise)
    // A click on the document's text leaves focus on the page itself, where F5 still refreshes it.
    focused.panel = ''
    prevented.length = 0
    f5()
    await settled()
    expect(prevented).toEqual(['F5'])
    expect(api.describeSsis).toHaveBeenCalledTimes(2)
    expect(state(id)).toMatchObject({ loading: true, model: pkg })
    // A second Refresh while one reads does nothing.
    expect(await run('ssis.refreshProperties', 'ssisPackage')).toBe(false)
    pending.resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'BLOCKED', message: 'SSISDB is locked by another session.', retryable: true } } })
    await settled()
    expect(state(id)).toMatchObject({ loading: false, model: pkg, error: { code: 'BLOCKED' }, gone: false })
    // A failure of main's (the backend went away) is a value too.
    api.describeSsis.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await run('ssis.refreshProperties', 'ssisPackage')
    await settled()
    expect(state(id).error).toEqual({ code: 'BACKEND_LOST', message: 'The SQL backend stopped.', retryable: true })
    // A good read clears it.
    await run('ssis.refreshProperties', 'ssisPackage')
    await settled()
    expect(state(id).error).toBeUndefined()
  })
  it('says an object deleted elsewhere is gone, and the catalog\'s absence too', async () => {
    const { documents, api, state, run } = ssis()
    api.describeSsis.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'The folder Finance no longer exists.', retryable: false } } })
    await run('ssis.folderProperties', 'ssisFolder')
    await settled()
    const id = documents.getSnapshot().activeId
    expect(state(id)).toMatchObject({ gone: true, error: { code: 'NOT_FOUND' } })
    expect(state(id).model).toBeUndefined()
    expect(ssisHeaderState(state(id))).toMatchObject({ tone: 'critical', label: 'Not found' })
    expect(ssisHeaderState({ ...state(id), error: { code: 'CATALOG_MISSING', message: 'x', retryable: false } })).toMatchObject({ label: 'Catalog missing' })
  })
  it('cancels a read in flight when its tab closes, and ignores its late answer', async () => {
    const { documents, api, ssisProperties, run } = ssis()
    const pending = deferred<ApiResult<SsisDescribeResult>>()
    api.describeSsis.mockReturnValueOnce(pending.promise)
    await run('ssis.environmentProperties', 'ssisEnvironment')
    const id = documents.getSnapshot().activeId, requestId = api.describeSsis.mock.calls[0][0].requestId
    await documents.close(id)
    expect(api.cancelSsis).toHaveBeenCalledWith([requestId])
    expect(ssisProperties.get(id)).toBeUndefined()
    pending.resolve({ ok: true, value: { model: environment, elapsedMs: 1 } })
    await settled()
    expect(ssisProperties.getSnapshot().documents).toEqual({})
  })
  it('cancels a read when its server disconnects, cannot refresh until it reconnects, and reads again on the new connection', async () => {
    const { documents, api, state, run, connections, targets: retarget, commands, connect } = ssis()
    await run('ssis.folderProperties', 'ssisFolder')
    await settled()
    const id = documents.getSnapshot().activeId
    const pending = deferred<ApiResult<SsisDescribeResult>>()
    api.describeSsis.mockReturnValueOnce(pending.promise)
    await commands.execute('ssis.refreshProperties', { tabId: id }, 'toolbar')
    const requestId = api.describeSsis.mock.calls.at(-1)![0].requestId
    connections.markLostBefore(2)
    expect(api.cancelSsis).toHaveBeenCalledWith([requestId])
    expect(state(id)).toMatchObject({ loading: false, disconnected: true, model: folder })
    expect(commands.isEnabled('ssis.refreshProperties', { tabId: id })).toBe(false)
    expect(ssisHeaderState(state(id))).toMatchObject({ tone: 'warning', label: 'Disconnected' })
    pending.resolve({ ok: true, value: { model: { ...folder, description: 'stale' }, elapsedMs: 1 } })
    await settled()
    expect(state(id).model).toEqual(folder)
    // Reconnect to the same server moves the tab and reads it on the new connection; another server's would not.
    expect(documents.follows(id, 'C1.EXAMPLE ')).toBe(true)
    expect(documents.follows(id, 'other.example')).toBe(false)
    connect({ ...connectionInfo('c3', 2), server: 'c1.example' })
    retarget.retarget('c1', 'c3')
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c3', disconnected: false, loading: false })
    expect(api.describeSsis.mock.calls.at(-1)![0]).toMatchObject({ connectionId: 'c3', view: 'folder' })
  })
  it('reconnects on a new Connect to its server after a Disconnect or a removed lost server, and reads again there', async () => {
    const { documents, api, state, run, connections, targets: retarget, commands, connect } = ssis()
    await run('ssis.folderProperties', 'ssisFolder')
    await settled()
    const id = documents.getSnapshot().activeId
    // Disconnect, as App does: the connection goes, and a custom document keeps its connection id.
    connections.remove('c1')
    retarget.update(id, { connectionId: undefined })
    expect(state(id)).toMatchObject({ connectionId: 'c1', disconnected: true })
    // A connection to another server leaves it where it is.
    connect(connectionInfo('c2'))
    expect(state(id)).toMatchObject({ connectionId: 'c1', disconnected: true })
    connect({ ...connectionInfo('c3'), server: ' C1.EXAMPLE' })
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c3', disconnected: false, loading: false })
    expect(documents.get(id)?.connectionId).toBe('c3')
    expect(api.describeSsis.mock.calls.at(-1)![0]).toMatchObject({ connectionId: 'c3', view: 'folder' })
    expect(commands.isEnabled('ssis.refreshProperties', { tabId: id })).toBe(true)
    // Properties on the same object from the new connection shows this tab instead of opening a second.
    await run('ssis.folderProperties', 'ssisFolder', 'c3', ' C1.EXAMPLE')
    expect(documents.getSnapshot().activeId).toBe(id)
    expect(documents.getSnapshot().documents.filter(document => document.kind === 'ssisFolder')).toHaveLength(1)
    // A lost server removed (after a backend crash, say), then a fresh Connect instead of Reconnect.
    connections.markLostBefore(2)
    expect(state(id).disconnected).toBe(true)
    connections.remove('c3')
    connect({ ...connectionInfo('c4', 2), server: 'c1.example' })
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c4', disconnected: false })
    expect(api.describeSsis.mock.calls.at(-1)![0]).toMatchObject({ connectionId: 'c4' })
  })
  it('never moves to another connection to its server that was already open when it disconnected, which may be another login', async () => {
    const { documents, api, state, run, connections, targets: retarget, connect } = ssis()
    connect({ ...connectionInfo('c2'), server: 'c1.example', displayName: 'Other login' })
    await run('ssis.folderProperties', 'ssisFolder')
    await settled()
    const id = documents.getSnapshot().activeId
    connections.remove('c1')
    retarget.update(id, { connectionId: undefined })
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c1', disconnected: true, serverLabel: 'c1.example' })
    expect(api.describeSsis).toHaveBeenCalledTimes(1)
    // A Connect made afterwards is the way back, and the header then names that connection.
    connect({ ...connectionInfo('c3'), server: 'c1.example', displayName: 'Reconnected' })
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c3', disconnected: false, serverLabel: 'Reconnected' })
    expect(api.describeSsis.mock.calls.at(-1)![0]).toMatchObject({ connectionId: 'c3' })
    // Reconnect onto the other open connection is explicit, so it moves there.
    connections.remove('c3')
    retarget.retarget('c3', 'c2')
    await settled()
    expect(state(id)).toMatchObject({ connectionId: 'c2', disconnected: false, serverLabel: 'Other login' })
  })
  it('names its tab without drawing bidi overrides or control characters from the catalog name', async () => {
    const { documents, ssisProperties, select } = ssis()
    const node = await select('ssisFolder')
    const id = ssisProperties.open({ ...node, ref: { type: 'object', object: { kind: 'ssisFolder', name: 'Fin‮ecnan\nX' } } })
    expect(documents.get(id)?.name).toBe('Folder Properties - Fin⟨U+202E⟩ecnan⟨U+000A⟩X')
  })
  it('offers Retry after a failure of main\'s only where a second read can get past it', async () => {
    const { documents, api, state, run } = ssis()
    await run('ssis.packageProperties', 'ssisPackage')
    await settled()
    const id = documents.getSnapshot().activeId
    const retryable = async (result: ApiResult<SsisDescribeResult>) => {
      api.describeSsis.mockResolvedValueOnce(result)
      await run('ssis.refreshProperties', 'ssisPackage')
      await settled()
      return state(id).error?.retryable
    }
    // Main's schemas refusing the request (no code) or the answer fail the same way every time; so does a cancel.
    expect(await retryable({ ok: false, error: 'Invalid request. Check the connection or query settings.' })).toBe(false)
    expect(await retryable({ ok: false, error: 'The backend sent an invalid answer.' })).toBe(false)
    expect(await retryable({ ok: false, error: 'Cancelled.', code: 'CANCELLED' })).toBe(false)
    expect(await retryable({ ok: false, error: 'Unsupported.', code: 'INVALID_PARAMS' })).toBe(false)
    expect(await retryable({ ok: false, error: 'Too many.', code: 'TOO_MANY_REQUESTS' })).toBe(true)
    expect(await retryable({ ok: false, error: 'Slow.', code: 'TIMEOUT' })).toBe(true)
  })
  it('keeps each document\'s section list and collapsed sections across tab switches', async () => {
    const { documents, ssisProperties, run } = ssis()
    await run('ssis.projectProperties', 'ssisProject')
    await settled()
    const id = documents.getSnapshot().activeId
    expect(ssisProperties.get(id)?.frame).toEqual({ section: 'general', collapsed: [], scriptOpen: false, scriptSize: 0.35 })
    const frame = { ...toggleSection(ssisProperties.get(id)!.frame, 'parameters'), section: 'references' }
    ssisProperties.setFrame(id, frame)
    documents.newQuery()
    documents.activate(id)
    expect(ssisProperties.get(id)?.frame).toBe(frame)
  })
  it('are custom documents with their kind\'s icon and no text, which the provider never asks to save', async () => {
    const { documents, run } = ssis()
    for (const kind of ['ssisFolder', 'ssisProject', 'ssisPackage', 'ssisEnvironment'] as const) {
      expect(isCustomKind(kind)).toBe(true)
      expect(kindInfo[kind]).toMatchObject({ label: ssisDocumentSpecs[kind].title, blankName: ssisDocumentSpecs[kind].title, icon: ssisDocumentSpecs[kind].icon, language: '' })
    }
    await run('ssis.folderProperties', 'ssisFolder')
    const id = documents.getSnapshot().activeId
    expect(documents.isCustom(id)).toBe(true)
    expect(await documents.save(id)).toBe(true)
    expect(documents.closeRefusal(id)).toBeUndefined()
    expect(documents.get(id)?.dirty).toBe(false)
  })
})

describe('SSIS properties view', () => {
  it('shows catalog times in their own offset, and codes in words', () => {
    expect(ssisTime(time)).toBe('2026-10-21 14:05:06 +02:00')
    expect(ssisTime('2026-10-21T14:05:06Z')).toBe('2026-10-21 14:05:06 +00:00')
    expect(ssisTime('2026-10-21T14:05:06-08:00')).toBe('2026-10-21 14:05:06 -08:00')
    expect([ssisTime(undefined), ssisTime('garbage')]).toEqual(['', 'garbage'])
    expect([validationLabel('N'), validationLabel('V')]).toEqual(['Not validated', 'V'])
    expect([referenceFolder(undefined), referenceFolder('Shared')]).toEqual(['.', 'Shared'])
  })
  it('never shows a sensitive value, and says where each parameter\'s value comes from', () => {
    const [server, password, port, timeout] = project.parameters
    expect([server, password, port, timeout].map(parameterValue)).toEqual(['sql01', sensitiveMask, 'PortVariable', '30'])
    expect([server, password, port, timeout].map(parameterSource)).toEqual(['Literal', 'Literal', 'Environment variable', 'Default'])
    // Even a sensitive value the backend sent by mistake stays masked.
    expect(parameterValue({ ...password, value: 'hunter2' })).toBe(sensitiveMask)
    const markup = html(createElement('div', null, ssisSectionViews(viewState(environment)).map(section => createElement('section', { key: section.id }, section.content))))
    expect(markup).toContain('1433')
    // The stars are drawn but not read: a screen reader hears that the value is hidden.
    expect(markup).toContain(`<td title="${maskedLabel}"><bdi><span aria-hidden="true">${sensitiveMask}</span><span class="visually-hidden">${maskedLabel}</span></bdi></td>`)
    const parameters = html(createElement('div', null, ssisSectionViews(viewState(project))[2].content))
    expect(parameters).toContain(`<span aria-hidden="true">${sensitiveMask}</span><span class="visually-hidden">${maskedLabel}</span>`)
    expect(parameters.split(maskedLabel)).toHaveLength(3)
  })
  it('lays a project out in General, Packages, Parameters and References, with counts after the lists\' titles', () => {
    const sections = ssisSectionViews(viewState(project))
    expect(sections.map(section => [section.id, section.title])).toEqual([['general', 'General'], ['packages', 'Packages'], ['parameters', 'Parameters'], ['references', 'References']])
    const markup = (id: string) => html(createElement('div', null, sections.find(section => section.id === id)!.content))
    // The count is part of the heading, named in words: "Packages (2 packages)".
    expect(sections.map(section => section.count)).toEqual([undefined, { text: '2', label: '2 packages' }, { text: '4', label: '4 parameters' }, { text: '2', label: '2 references' }])
    expect(sections.every(section => section.aside === undefined)).toBe(true)
    expect(ssisSectionViews(viewState({ ...environment, variables: environment.variables.slice(0, 1) }))[1].count).toEqual({ text: '1', label: '1 variable' })
    expect(markup('general')).toContain('<dt>Last deployed</dt><dd title="2026-10-21 14:05:06 +02:00"><bdi>2026-10-21 14:05:06 +02:00</bdi></dd>')
    expect(markup('general')).toContain('<dt>Validation status</dt><dd title="Not validated">')
    // An empty value shows a muted dash, not a blank, in General and in the lists alike, and is read as None.
    const none = `<bdi><span class="ssis-properties-none"><span aria-hidden="true">—</span><span class="visually-hidden">${noneLabel}</span></span></bdi>`
    expect(markup('general')).toContain(`<dt>Description</dt><dd title="">${none}</dd>`)
    expect(markup('general')).toContain(`<dt>Last validated</dt><dd title="">${none}</dd>`)
    expect(markup('packages')).toContain(`<td title="">${none}</td>`)
    expect(markup('packages')).not.toMatch(/<bdi><\/bdi>/)
    expect(markup('packages')).toContain('aria-label="Packages"')
    expect(markup('references')).toMatch(/<td[^>]*><bdi>Test<\/bdi><\/td><td[^>]*><bdi>\.<\/bdi><\/td><td[^>]*><bdi>Relative<\/bdi><\/td>/)
    expect(markup('references')).toContain('<bdi>Absolute</bdi>')
    // The header row and four parameters, each with its place in the list.
    expect(markup('parameters')).toContain('aria-rowcount="5"')
    expect(markup('parameters').match(/<tr aria-rowindex="\d+">/g)).toEqual(['<tr aria-rowindex="1">', '<tr aria-rowindex="2">', '<tr aria-rowindex="3">', '<tr aria-rowindex="4">', '<tr aria-rowindex="5">'])
    // A package without parameters says so.
    expect(html(createElement('div', null, ssisSectionViews(viewState(pkg))[1].content))).toContain('This package has no parameters.')
  })
  it('names control characters instead of drawing them, in the title path and the lists', () => {
    const state = viewState({ ...folder, name: 'Fin\u0007ance' }, { serverLabel: 'sql\u000a01' })
    expect(ssisCrumbs(state).map(crumb => crumb.label)).toEqual(['sql⟨U+000A⟩01', 'Integration Services Catalogs', 'SSISDB'])
    expect(ssisCrumbs(viewState(pkg)).map(crumb => crumb.label)).toEqual(['Production SQL', 'Integration Services Catalogs', 'SSISDB', 'Finance', 'Loads'])
    expect(html(createElement('div', null, ssisSectionViews(state)[0].content))).toContain('Fin⟨U+0007⟩ance')
  })
  it('says what the header shows: loading, refreshing, failures, disconnection, or the model\'s age', () => {
    expect(ssisHeaderState(viewState(undefined, { loading: true }))).toEqual({ kind: 'pill', tone: 'running', label: 'Loading' })
    expect(ssisHeaderState(viewState(folder, { loading: true }))).toEqual({ kind: 'pill', tone: 'running', label: 'Refreshing' })
    // A refresh that failed over a model (SSISDB locked) still says how old the model on screen is, as stale.
    expect(ssisHeaderState(viewState(folder, { error: { code: 'BLOCKED', message: 'Locked.', retryable: true } }))).toEqual({ kind: 'stale', since: 1000 })
    expect(ssisHeaderState(viewState(undefined, { error: { code: 'TIMEOUT', message: 'Slow.', retryable: true } }))).toMatchObject({ tone: 'critical', label: 'Failed' })
    expect(ssisHeaderState(viewState(folder))).toEqual({ kind: 'updated', at: 1000 })
    expect(ssisFacts(project).map(fact => [fact.label, fact.value])).toEqual([['Folder', 'Finance'], ['Last deployed', '2026-10-21 14:05:06 +02:00'], ['Validation', 'Not validated']])
    expect(ssisFacts(environment).map(fact => fact.value)).toEqual(['Finance', '2'])
  })
  it('says which lists stop short of a truncated answer', () => {
    expect(truncatedNote(viewState(project))).toBeUndefined()
    expect(truncatedNote(viewState({ ...project, truncated: true }))).toBe('This project has more packages, parameters or references than one read returns: each list shows its first 2,048.')
    expect(truncatedNote(viewState({ ...pkg, truncated: true }))).toBe('This package has more parameters than one read returns: the list shows its first 2,048.')
    expect(truncatedNote(viewState({ ...environment, truncated: true }))).toBe('This environment has more variables than one read returns: the list shows its first 2,048.')
  })
  it('keeps Retry over a failed read in place while it reads again, disabled but focusable, so focus on it stays', () => {
    const blocked = { code: 'BLOCKED', message: 'SSISDB is locked by another session.', retryable: true }
    const notice = (extra: Partial<SsisPropertiesState>) => html(createElement(SsisNotice, { state: viewState(pkg, { error: blocked, ...extra }), close: { label: 'Close', run: () => {} }, retry: () => {} }))
    expect(notice({})).toContain('<button type="button">Retry</button>')
    expect(notice({ loading: true })).toContain('<button type="button" aria-disabled="true">Retry</button>')
    expect(notice({ loading: true })).toContain('SSISDB is locked by another session.')
    expect(notice({ disconnected: true })).not.toContain('>Retry</button>')
    expect(notice({ gone: true, error: { code: 'NOT_FOUND', message: 'Gone.', retryable: false } })).toContain('>Close</button>')
  })
  it('draws only the rows near the view of a list at the cap, with spacers for the rest', () => {
    const many = { ...project, truncated: true, parameters: Array.from({ length: 2048 }, (_, index) => ({ ...project.parameters[0], name: `P${index}` })) }
    const markup = html(createElement('div', null, ssisSectionViews(viewState(many))[2].content))
    expect(markup).toContain('aria-rowcount="2049"')
    expect(markup.match(/<tr aria-rowindex=/g)).toHaveLength(listLimits.initialRows + 1)
    expect(markup.match(/class="ssis-properties-spacer"/g)).toHaveLength(1)
    // In view at the top: the first rows and the overscan, snapped out to a block.
    expect(listWindow(2048, 23, 0, 600)).toEqual({ start: 0, end: 64 })
    // Scrolled to row 1,000: from a block before it to a block past the view.
    expect(listWindow(2048, 23, -1000 * 23, 600)).toEqual({ start: 960, end: 1056 })
    expect(listWindow(2048, 23, -2048 * 23 + 300, 600)).toEqual({ start: 1984, end: 2048 })
    // A list far below the view draws nothing yet; before any measure it draws the first rows.
    expect(listWindow(2048, 23, 5000, 600)).toEqual({ start: 0, end: 0 })
    expect(listWindow(100, 23, 0, Number.NaN)).toEqual({ start: 0, end: 64 })
    expect(listWindow(0, 23, 0, 600)).toEqual({ start: 0, end: 0 })
    for (let top = -50000; top <= 1000; top += 997) {
      const { start, end } = listWindow(2048, 23, top, 600), first = Math.max(0, Math.floor(-top / 23)), last = Math.min(2048, Math.ceil((600 - top) / 23))
      if (first < last) expect(start <= first && end >= last, String(top)).toBe(true)
      expect(end - start).toBeLessThanOrEqual(Math.ceil(600 / 23) + 2 * (listLimits.overscan + listLimits.block))
    }
  })
  it('builds a model\'s sections once, so choosing a section does not rebuild lists of thousands of rows', () => {
    const many = { ...project, truncated: true, parameters: Array.from({ length: 2048 }, (_, index) => ({ ...project.parameters[0], name: `P${index}` })) }
    const first = ssisSectionViews(viewState(many)), again = ssisSectionViews(viewState(many, { frame: { ...initialFrameState(ssisDocumentSpecs.ssisProject.sections), section: 'references' } }))
    expect(again.map(section => section.content)).toEqual(first.map(section => section.content))
    again.forEach((section, index) => expect(section.content).toBe(first[index].content))
    // A new model (a Refresh) builds them again.
    expect(ssisSectionViews(viewState({ ...many }))[2].content).not.toBe(first[2].content)
  })
  it('focuses a document opened while its first read runs once that read ends, unless focus moved meanwhile', () => {
    let loading = true
    const listeners = new Set<() => void>(), frames: (() => void)[] = []
    const documents = { get: () => ({ loading }) as SsisPropertiesState, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const tree = { id: 'tree' } as unknown as Element, body = { id: 'body' } as unknown as Element, elsewhere = { id: 'other' } as unknown as Element
    let active: Element | null = tree
    const focused: string[] = []
    const control = { focus: () => { focused.push('refresh'); active = control as unknown as Element } }
    const root = { querySelector: (selector: string) => !loading && selector.startsWith('button') ? control : null } as unknown as HTMLElement
    const host: SsisFocusHost = { root: () => root, activeElement: () => active, body: () => body, modalOpen: () => false, frame: callback => { frames.push(callback); return () => {} } }
    const run = () => frames.splice(0).forEach(frame => frame())
    const finish = () => { loading = false; [...listeners].forEach(listener => listener()); run() }
    const focuser = ssisFocuser(documents, host)
    focuser.focus('d1')
    run()
    expect(focused).toEqual([])
    expect(listeners.size).toBe(1)
    finish()
    expect(focused).toEqual(['refresh'])
    expect(listeners.size).toBe(0)
    // Focus that moved on while the read ran stays where it went.
    loading = true
    active = tree
    focuser.focus('d1')
    run()
    active = elsewhere
    finish()
    expect(focused).toEqual(['refresh'])
    // Focus that fell to the page (the menu that opened it closed) is taken.
    loading = true
    active = tree
    focuser.focus('d1')
    run()
    active = body
    finish()
    expect(focused).toEqual(['refresh', 'refresh'])
    // A newer request replaces the wait, and dispose ends it.
    loading = true
    focuser.focus('d1')
    run()
    focuser.focus('d1')
    run()
    expect(listeners.size).toBe(1)
    focuser.dispose()
    expect(listeners.size).toBe(0)
  })
  it('keeps the Refresh key to the document, so a query\'s F5 still executes', () => {
    expect(commandDescriptor('ssis.refreshProperties').keybindings).toEqual([{ key: 'f5', when: "activeDocumentIsSsis && activePanel != 'explorer' && !editorFocus" }])
    expect(commandDescriptor('query.execute').keybindings?.[0]).toEqual({ key: 'f5', when: 'editorFocus' })
    const kinds: NodeKind[] = ['ssisFolder', 'ssisProject', 'ssisPackage', 'ssisEnvironment']
    expect(kinds.map(kind => ssisDocumentSpecs[kind as keyof typeof ssisDocumentSpecs].view)).toEqual(['folder', 'project', 'package', 'environment'])
  })
})
