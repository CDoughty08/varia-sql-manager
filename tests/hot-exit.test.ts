import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestoredSession, SessionWrite, SqlFile, VariaApi } from '../src/shared/contracts'
import { sessionLimits } from '../src/shared/files/session'
import { FileService } from '../src/renderer/src/services/files'
import type { QueryService } from '../src/renderer/src/services/queries'
import { keptSession, reloadSession, restoreSession } from '../src/renderer/src/services/session'
import { TabRenameService } from '../src/renderer/src/services/tab-rename'
import { TargetService } from '../src/renderer/src/services/targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { connectionDefaults } from '../src/shared/connections'
import { connectionWorkspaceSchema } from '../src/shared/connection-targets'
import { documentFixture } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const file = (name: string, id = name): SqlFile => ({ id, name, path: `C:/q/${name}`, encoding: 'utf8', readOnly: false })

function fixture(options: { hotExit?: boolean; budget?: number } = {}) {
  const doc = documentFixture()
  const kept: SessionWrite[] = []
  const api = {
    ...doc.api,
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {}),
    closeWindowCancelled: vi.fn<VariaApi['closeWindowCancelled']>(),
    keepSession: vi.fn<VariaApi['keepSession']>(async session => { kept.push(session); return { ok: true, value: undefined } })
  }
  const queries = { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions: vi.fn<QueryService['confirmSessions']>(async () => new Map()) }
  const servers: Record<string, string> = { 'server-a': 'sql01' }
  const state = { hotExit: options.hotExit ?? true }
  const files = new FileService(doc.documents, queries, api, { hotExit: () => state.hotExit || doc.documents.getSnapshot().documents.some(tab => tab.pinned)
    ? keptSession(doc.documents, id => servers[id], { budget: options.budget, pinnedOnly: !state.hotExit }) : undefined })
  cleanups.push(() => { files.dispose(); doc.documents.dispose() })
  return { ...doc, api, files, kept, state, queries }
}

describe('Rename Tab', () => {
  it('names a tab without a file, takes the rename away for an empty name, and keeps it through Save and owners\' renames', async () => {
    const { documents, api } = fixture()
    const tab = documents.create('SQLQuery2.sql', 'SELECT 1', 'master')
    expect(documents.rename(tab.id, '  Month end\n')).toBe(true)
    expect(documents.get(tab.id)).toMatchObject({ name: 'Month end', baseName: 'SQLQuery2.sql' })
    expect(documents.rename(tab.id, 'Month end')).toBe(false)
    // Save As suggests the tab's name; the saved file's name goes under the rename.
    await documents.save(tab.id, true)
    expect(api.saveSqlFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Month end', saveAs: true }))
    expect(documents.get(tab.id)).toMatchObject({ name: 'Month end', baseName: 'saved.sql', file: { name: 'saved.sql' } })
    documents.update(tab.id, { name: 'other.sql' })
    expect(documents.get(tab.id)).toMatchObject({ name: 'Month end', baseName: 'other.sql' })
    // Empty, or the name it would have anyway, takes the rename away.
    expect(documents.rename(tab.id, '   ')).toBe(true)
    expect(documents.get(tab.id)).toMatchObject({ name: 'other.sql', baseName: undefined })
    expect(documents.rename(tab.id, 'other.sql')).toBe(false)
    documents.rename(tab.id, 'x')
    expect(documents.rename(tab.id, 'other.sql')).toBe(true)
    expect(documents.get(tab.id)?.name).toBe('other.sql')
    // At most 128 characters.
    documents.rename(tab.id, 'y'.repeat(300))
    expect(documents.get(tab.id)?.name).toHaveLength(128)
  })
  it('edits one tab at a time in the strip: Enter or blur keeps the name, Escape the old one', () => {
    const { documents } = fixture()
    const tab = documents.create('SQLQuery2.sql', '', 'master'), rename = new TabRenameService(documents)
    expect(rename.start('missing')).toBe(false)
    expect(rename.start(tab.id)).toBe(true)
    expect(rename.getSnapshot().id).toBe(tab.id)
    rename.cancel()
    expect(rename.getSnapshot().id).toBe('')
    expect(documents.get(tab.id)?.name).toBe('SQLQuery2.sql')
    rename.start(tab.id)
    rename.commit(tab.id, 'Totals')
    expect(rename.getSnapshot().id).toBe('')
    expect(documents.get(tab.id)?.name).toBe('Totals')
    // A blur after Enter's commit does nothing more.
    rename.commit(tab.id, 'Ignored')
    expect(documents.get(tab.id)?.name).toBe('Totals')
  })
})

describe('hot exit', () => {
  it('revalidates captured query associations and target details by value after a checkpoint write', () => {
    const { documents } = fixture(), connectionTargets = new ConnectionTargetService(), targetId = crypto.randomUUID()
    const details = { displayName: 'Production', autoReconnect: 'inherit' as const }
    connectionTargets.add({ id: targetId, options: { ...connectionDefaults('win32'), server: 'sql01' }, details, inExplorer: true, resumeWanted: true })
    const tab = documents.create('Draft.sql', 'SELECT 1', 'Sales', 'handle-a')
    documents.update(tab.id, { targetId, attachWanted: true })
    const checkpoint = keptSession(documents, () => 'sql01', { connectionTargets })
    expect(checkpoint.checkpointCurrent()).toBe(true)
    // Registry exports are immutable new values; unchanged data does not invalidate the checkpoint.
    expect(connectionTargets.exportWorkspace()).not.toBe(checkpoint.session.workspace)
    expect(checkpoint.checkpointCurrent()).toBe(true)
    connectionTargets.setDetails(targetId, { ...details, displayName: 'Renamed production' })
    expect(checkpoint.checkpointCurrent()).toBe(false)
    connectionTargets.setDetails(targetId, details)
    expect(checkpoint.checkpointCurrent()).toBe(true)
    for (const patch of [{ database: 'Reports' }, { attachWanted: false }, { connectionId: 'handle-b' }, { targetId: crypto.randomUUID() }]) {
      documents.update(tab.id, patch)
      expect(checkpoint.checkpointCurrent()).toBe(false)
      documents.update(tab.id, { database: 'Sales', targetId, attachWanted: true, connectionId: 'handle-a' })
      expect(checkpoint.checkpointCurrent()).toBe(true)
    }
  })

  it('uses hot-exit eligibility for Reload Window, including unpinned queries only while query restore is enabled', () => {
    const { documents } = fixture()
    const first = documents.create('Draft.sql', 'SELECT 1', 'Sales')
    const pinned = documents.create('Pinned.sql', 'SELECT 2', 'Reports')
    documents.setPinned(pinned.id, true)
    const recoveryId = (id: string) => id === first.id ? 'draft-copy' : undefined
    const enabled = reloadSession(documents, () => undefined, { restoreQueries: true, recoveryId })!
    expect(enabled.session).toEqual(keptSession(documents, () => undefined).session)
    expect(enabled.session.documents.map(tab => tab.name)).toEqual(['Pinned.sql', 'Draft.sql'])
    expect(enabled.recoveryIds).toEqual([null, 'draft-copy'])
    const disabled = reloadSession(documents, () => undefined, { restoreQueries: false, recoveryId })!
    expect(disabled.session.documents.map(tab => tab.name)).toEqual(['Pinned.sql'])
    documents.setPinned(pinned.id, false)
    expect(reloadSession(documents, () => undefined, { restoreQueries: false, recoveryId })).toBeUndefined()
  })

  it('captures a target-only reload checkpoint and rejects a pin left outside the byte budget', () => {
    const { documents } = fixture(), connectionTargets = new ConnectionTargetService()
    connectionTargets.add({ id: crypto.randomUUID(), options: { ...connectionDefaults('win32'), server: 'sql01' }, details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: false })
    const checkpoint = reloadSession(documents, () => undefined, { restoreQueries: false, recoveryId: () => undefined, connectionTargets })!
    expect(checkpoint.session.documents).toEqual([])
    expect(checkpoint.session.workspace?.targets).toHaveLength(1)
    const pinned = documents.create('Large.sql', 'x'.repeat(1000), 'Sales')
    documents.setPinned(pinned.id, true)
    expect(() => reloadSession(documents, () => undefined, { restoreQueries: true, recoveryId: () => undefined, budget: 100 })).toThrow('Pinned tab “Large.sql”')
  })

  it('keeps and restores exact targets before queries, with each database and attachment preference unchanged', async () => {
    const { documents, files } = fixture(), connectionTargets = new ConnectionTargetService()
    const workspace = connectionWorkspaceSchema.parse({ version: 1, targets: [
      { id: crypto.randomUUID(), options: { ...connectionDefaults('win32'), server: 'sql01' }, details: { environment: 'Production' }, inExplorer: true, resumeWanted: true },
      { id: crypto.randomUUID(), options: { ...connectionDefaults('win32'), server: 'sql01' }, details: {}, inExplorer: false, resumeWanted: false }
    ] })
    const restored: RestoredSession = { activeIndex: 1, problems: [], workspace, documents: [
      { name: 'sales.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 1', targetId: workspace.targets[0].id, database: 'Sales', attachWanted: true },
      { name: 'reports.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 2', targetId: workspace.targets[0].id, database: 'Reports', attachWanted: false },
      { name: 'default.sql', kind: 'sql', eol: 'lf', dirty: false, text: 'SELECT 3', targetId: workspace.targets[1].id, database: '', attachWanted: true }
    ] }
    const original = documents.reopen.bind(documents)
    vi.spyOn(documents, 'reopen').mockImplementation(document => {
      expect(connectionTargets.get(document.targetId!)?.lifecycle.state).toBe('disconnected')
      return original(document)
    })
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: true, value: restored })), finishSessionRestore: vi.fn<VariaApi['finishSessionRestore']>() }
    expect(await restoreSession({ api, documents, files, connectionTargets })).toBe(3)
    expect(documents.getSnapshot().documents.map(tab => [tab.targetId, tab.database, tab.attachWanted, tab.connectionId, tab.sessionNotice])).toEqual([
      [workspace.targets[0].id, 'Sales', true, undefined, 'restarted'],
      [workspace.targets[0].id, 'Reports', false, undefined, 'restarted'],
      [workspace.targets[1].id, '', true, undefined, 'restarted']
    ])
    const kept = keptSession(documents, () => undefined, { connectionTargets })
    expect(kept.session.workspace).toEqual(workspace)
    expect(kept.session.documents.map(tab => [tab.targetId, tab.database, tab.attachWanted])).toEqual(restored.documents.map(tab => [tab.targetId, tab.database, tab.attachWanted]))
    expect(JSON.stringify(kept.session)).not.toMatch(/connectionId|sessionNotice|lifecycle/)
  })

  it('keeps every text tab in order, with text unless a clean file reopens it, its rename, and the server it was on', () => {
    const { documents, model } = fixture()
    const untitled = documents.create('SQLQuery2.sql', '', 'Sales', 'server-a')
    model(untitled.id).edit('SELECT 2')
    const saved = documents.create('orders.sql', 'SELECT 3', 'master', undefined, false, file('orders.sql'))
    const edited = documents.create('edited.sql', 'SELECT 4', 'master', undefined, false, file('edited.sql'))
    model(edited.id).edit('SELECT 44')
    const value = documents.openText({ name: 'value.xml', text: '<a/>', kind: 'xml' })
    documents.rename(saved.id, 'Orders')
    documents.activate(saved.id)
    const { session, kept } = keptSession(documents, id => id === 'server-a' ? 'sql01' : undefined)
    expect(session).toEqual({
      activeIndex: 1,
      documents: [
        { name: 'SQLQuery2.sql', kind: 'sql', eol: 'lf', dirty: true, server: 'sql01', database: 'Sales', text: 'SELECT 2' },
        { name: 'Orders', baseName: 'orders.sql', kind: 'sql', eol: 'lf', dirty: false, fileId: 'orders.sql' },
        { name: 'edited.sql', kind: 'sql', eol: 'lf', dirty: true, fileId: 'edited.sql', text: 'SELECT 44' },
        { name: 'value.xml', kind: 'xml', eol: 'lf', dirty: false, text: '<a/>' }
      ]
    })
    expect([...kept]).toEqual([untitled.id, saved.id, edited.id, value.id])
    expect(JSON.stringify(session)).not.toMatch(/password|connectionId/i)
  })
  it('leaves out a tab past its byte budget, which is then asked about as before', async () => {
    const { documents, model, api, files, kept } = fixture({ budget: 400 })
    const small = documents.create('SQLQuery2.sql', '', 'master')
    model(small.id).edit('SELECT 1')
    const large = documents.create('SQLQuery3.sql', '', 'master')
    model(large.id).edit('x'.repeat(1000))
    await files.closeWindow(async () => {})
    expect(api.confirmClose.mock.calls).toEqual([['SQLQuery3.sql']])
    // The active tab was the one left out, so none is active when they reopen.
    expect(kept).toEqual([{ activeIndex: -1, documents: [expect.objectContaining({ name: 'SQLQuery2.sql', text: 'SELECT 1' })] }])
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('closes without asking about unsaved queries, keeping them, and still asks about open transactions', async () => {
    const { documents, model, api, files, kept, queries } = fixture()
    const tab = documents.create('SQLQuery2.sql', '', 'master')
    model(tab.id).edit('SELECT unsaved')
    await files.closeWindow(async () => {})
    expect(api.confirmClose).not.toHaveBeenCalled()
    expect(queries.confirmSessions).toHaveBeenCalledWith('exit', [tab.id])
    expect(kept).toHaveLength(1)
    expect(kept[0].documents[0]).toMatchObject({ name: 'SQLQuery2.sql', dirty: true, text: 'SELECT unsaved' })
    expect(api.keepSession.mock.invocationCallOrder[0]).toBeLessThan(api.closeWindow.mock.invocationCallOrder[0])
  })
  it('keeps the window open when a kept query changes while its session is written', async () => {
    const { documents, model, api, files, kept } = fixture()
    const tab = documents.create('SQLQuery2.sql', '', 'master')
    model(tab.id).edit('SELECT unsaved')
    let resolve!: () => void
    api.keepSession.mockImplementationOnce(session => new Promise(done => { kept.push(session); resolve = () => done({ ok: true, value: undefined }) }))
    const closing = files.closeWindow(async () => {})
    await vi.waitFor(() => expect(api.keepSession).toHaveBeenCalled())
    model(tab.id).edit('SELECT typed while kept')
    resolve(); await closing
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toContain('changed while closing the window')
    // Closing again keeps the latest text.
    await files.closeWindow(async () => {})
    expect(kept.at(-1)?.documents[0]).toMatchObject({ text: 'SELECT typed while kept' })
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('asks as before while Restore open queries on startup is off', async () => {
    const { documents, model, api, files, kept, state } = fixture()
    state.hotExit = false
    const tab = documents.create('SQLQuery2.sql', '', 'master')
    model(tab.id).edit('SELECT unsaved')
    await files.closeWindow(async () => {})
    expect(api.confirmClose).toHaveBeenCalledWith('SQLQuery2.sql')
    expect(kept).toEqual([])
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('keeps pinned tabs when startup restore is off and still asks about unpinned edits', async () => {
    const { documents, api, files, kept } = fixture({ hotExit: false })
    const unpinned = documents.create('Draft.sql', 'SELECT 1', 'master', undefined, true)
    const pinned = documents.create('Keep.sql', 'SELECT 2', 'master', undefined, true)
    expect(documents.setPinned(pinned.id, true)).toBe(true)
    expect(documents.move(pinned.id, 1)).toBe(false)
    expect(documents.getSnapshot().documents.map(tab => tab.id)).toEqual([pinned.id, unpinned.id])
    await files.closeWindow(async () => {})
    expect(api.confirmClose.mock.calls).toEqual([['Draft.sql']])
    expect(kept).toEqual([{ activeIndex: 0, documents: [{ name: 'Keep.sql', kind: 'sql', eol: 'lf', dirty: true, pinned: true, text: 'SELECT 2' }] }])
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it.each(['count', 'bytes'])('refuses to quit when the %s limit would drop a clean pin', async limit => {
    const { documents, api, files, kept } = fixture({ hotExit: false, budget: limit === 'bytes' ? 200 : undefined })
    const count = limit === 'count' ? sessionLimits.documents : 1
    for (let index = 0; index < count; index++) {
      const tab = documents.create(`Pinned ${index}.sql`, 'SELECT 1', 'master')
      documents.setPinned(tab.id, true)
    }
    const extra = documents.create('Overflow.sql', 'x'.repeat(limit === 'bytes' ? 500 : 8), 'master')
    documents.setPinned(extra.id, true)
    await files.closeWindow(async () => {})
    expect(kept).toEqual([])
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
    expect(files.getSnapshot().error).toContain('Pinned tab “Overflow.sql”')
    documents.setPinned(extra.id, false)
    await files.closeWindow(async () => {})
    expect(kept[0].documents).toHaveLength(count)
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('keeps the window open, losing nothing, when main cannot keep the session', async () => {
    const { documents, model, api, files } = fixture()
    const tab = documents.create('SQLQuery2.sql', '', 'master')
    model(tab.id).edit('SELECT unsaved')
    api.keepSession.mockResolvedValueOnce({ ok: false, error: 'The disk is full.' })
    await files.closeWindow(async () => {})
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
    expect(files.getSnapshot().error).toContain('The open queries could not be kept for the next start: The disk is full.')
    expect(documents.get(tab.id)?.dirty).toBe(true)
  })

  it('reopens the kept tabs in order, the active one active, disconnected, numbering new queries after them', async () => {
    const { documents, files } = fixture()
    const restored: RestoredSession = {
      activeIndex: 1, problems: ['gone.sql could not be reopened: The file does not exist.'],
      documents: [
        { name: 'SQLQuery7.sql', kind: 'sql', eol: 'crlf', dirty: true, text: 'SELECT 7', server: 'sql01', database: 'Sales' },
        { name: 'Month end', baseName: 'orders.sql', kind: 'sql', eol: 'lf', dirty: false, text: 'SELECT 3', file: file('orders.sql') },
        { name: 'value.xml', kind: 'xml', eol: 'lf', dirty: false, text: '<a/>' }
      ]
    }
    const finishSessionRestore = vi.fn<VariaApi['finishSessionRestore']>(async () => {
      expect(documents.getSnapshot().documents.map(tab => tab.name)).toEqual(['SQLQuery7.sql', 'Month end', 'value.xml'])
      return { ok: true, value: undefined }
    })
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: true, value: { ...restored, restoreGeneration: 7 } })), finishSessionRestore }
    expect(await restoreSession({ api, documents, files })).toBe(3)
    expect(finishSessionRestore).toHaveBeenCalledExactlyOnceWith(7)
    const tabs = documents.getSnapshot().documents
    expect(tabs.map(tab => [tab.name, tab.dirty, tab.connectionId, tab.database])).toEqual([['SQLQuery7.sql', true, undefined, 'Sales'], ['Month end', false, undefined, 'master'], ['value.xml', false, undefined, '']])
    expect(tabs[0]).toMatchObject({ lastServer: 'sql01' })
    expect(tabs[1]).toMatchObject({ baseName: 'orders.sql', file: { id: 'orders.sql' } })
    expect(documents.getSnapshot().activeId).toBe(tabs[1].id)
    expect(documents.getModel(tabs[0].id)?.getEOL()).toBe('\r\n')
    expect(files.getSnapshot()).toEqual({ error: 'gone.sql could not be reopened: The file does not exist.', kind: 'warning' })
    expect(documents.newQuery().name).toBe('SQLQuery8.sql')
    // Nothing more to reopen, and nothing at all in runs that keep the close prompts.
    expect(await restoreSession({ api: { ...api, hotExit: false }, documents, files })).toBe(0)
    expect(api.takeSession).toHaveBeenCalledTimes(1)
  })
  it('keeps and restores the editor groups by the place of each kept tab', async () => {
    const { documents, files } = fixture()
    const first = documents.create('SQLQuery2.sql', 'SELECT 2', 'master')
    const second = documents.create('SQLQuery3.sql', 'SELECT 3', 'master')
    const layout = { root: { type: 'branch' as const, children: [{ type: 'leaf' as const, views: [0] }, { type: 'leaf' as const, views: [1] }] }, orientation: 'HORIZONTAL' as const, width: 800, height: 600 }
    const capture = vi.fn((place: (id: string) => number | undefined) => { expect([place(first.id), place(second.id), place('other')]).toEqual([0, 1, undefined]); return layout })
    expect(keptSession(documents, () => undefined, { groups: { capture } }).session.groups).toEqual(layout)
    expect(keptSession(documents, () => undefined).session).not.toHaveProperty('groups')
    const restored: RestoredSession = { activeIndex: 1, problems: [], groups: layout, documents: [
      { name: 'SQLQuery7.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 7' },
      { name: 'SQLQuery8.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 8' }
    ] }
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: true, value: restored })), finishSessionRestore: vi.fn<VariaApi['finishSessionRestore']>() }
    const restore = vi.fn()
    expect(await restoreSession({ api, documents, files, groups: { restore } })).toBe(2)
    const reopened = documents.getSnapshot().documents.slice(2)
    expect(restore).toHaveBeenCalledWith(layout, expect.any(Function))
    expect([0, 1, 2].map(restore.mock.calls[0][1])).toEqual([reopened[0].id, reopened[1].id, undefined])
  })
  it('does not open a second tab for a file already open, and releases what no tab holds', async () => {
    const { documents, files, api: fileApi } = fixture()
    documents.create('orders.sql', 'SELECT 3', 'master', undefined, false, file('orders.sql'))
    const finishSessionRestore = vi.fn<VariaApi['finishSessionRestore']>()
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: true, value: { activeIndex: 0, problems: [], documents: [{ name: 'orders.sql', kind: 'sql' as const, eol: 'lf' as const, dirty: false, text: 'SELECT 3', file: file('orders.sql') }] } })), finishSessionRestore }
    expect(await restoreSession({ api, documents, files })).toBe(0)
    expect(finishSessionRestore).not.toHaveBeenCalled()
    expect(documents.getSnapshot().documents).toHaveLength(1)
    expect(fileApi.releaseSqlFile).not.toHaveBeenCalled()
  })
  it('opens the welcome query inside its own file task, before a file the command line hands over during the restore', async () => {
    const { documents, files } = fixture()
    let release!: (value: Awaited<ReturnType<VariaApi['takeSession']>>) => void
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(() => new Promise(resolve => { release = resolve })), finishSessionRestore: vi.fn<VariaApi['finishSessionRestore']>() }
    const welcome = vi.fn(() => { documents.create('SQLQuery1.sql', 'SELECT 1', 'master') })
    const restoring = restoreSession({ api, documents, files, otherwise: welcome })
    await vi.waitFor(() => expect(api.takeSession).toHaveBeenCalled())
    const adopting = files.adopt({ files: [{ ...file('orders.sql'), content: 'SELECT 2', eol: 'lf', mixedEol: false }], errors: [] })
    release({ ok: true, value: { activeIndex: -1, problems: [], documents: [] } })
    expect(await restoring).toBe(0)
    await adopting
    expect(welcome).toHaveBeenCalledOnce()
    expect(documents.getSnapshot().documents.map(tab => tab.name)).toEqual(['SQLQuery1.sql', 'orders.sql'])
  })
  it('opens the welcome query when the restore fails, and not when it reopened tabs', async () => {
    const { documents, files } = fixture()
    const welcome = vi.fn()
    const failing = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: false, error: 'Access is denied.' })), finishSessionRestore: vi.fn<VariaApi['finishSessionRestore']>() }
    expect(await restoreSession({ api: failing, documents, files, otherwise: welcome })).toBe(0)
    expect(welcome).toHaveBeenCalledOnce()
    const reopening = { ...failing, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: true, value: { activeIndex: 0, problems: [], documents: [{ name: 'SQLQuery7.sql', kind: 'sql' as const, eol: 'lf' as const, dirty: true, text: 'SELECT 7' }] } })) }
    expect(await restoreSession({ api: reopening, documents, files, otherwise: welcome })).toBe(1)
    expect(welcome).toHaveBeenCalledOnce()
  })
  it('reports a session that could not be read in the file banner', async () => {
    const { documents, files } = fixture()
    const api = { hotExit: true, takeSession: vi.fn<VariaApi['takeSession']>(async () => ({ ok: false, error: 'Access is denied.' })), finishSessionRestore: vi.fn<VariaApi['finishSessionRestore']>() }
    expect(await restoreSession({ api, documents, files })).toBe(0)
    expect(files.getSnapshot().error).toBe('The queries open when Varia SQL Manager last closed could not be reopened: Access is denied.')
  })
  it('does not infer a legacy query target or database from a matching server name', async () => {
    const { documents, files } = fixture()
    const connections: Record<string, { server: string }> = { a: { server: 'SQL01 ' }, b: { server: 'other' } }
    const targets = new TargetService(documents, { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions: async () => new Map() }, { get: id => connections[id] as never }, files)
    const kept = documents.reopen({ name: 'SQLQuery2.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 1', server: 'sql01', database: 'Sales' })
    targets.update(kept.id, { connectionId: 'a', database: 'master' })
    expect(documents.get(kept.id)).toMatchObject({ connectionId: 'a', database: 'master' })
    const other = documents.reopen({ name: 'SQLQuery3.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 1', server: 'sql01', database: 'Sales' })
    targets.update(other.id, { connectionId: 'b', database: 'master' })
    expect(documents.get(other.id)).toMatchObject({ connectionId: 'b', database: 'master' })
  })
})
