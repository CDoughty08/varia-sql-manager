import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, OpenSqlFile, VariaApi } from '../src/shared/contracts'
import { FileService } from '../src/renderer/src/services/files'
import type { QueryService } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import { filesContribution } from '../src/renderer/src/contributions/files'
import { deferred, documentFixture, type SaveResponse } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'
import { contextRecord } from '../src/shared/commands/context-keys'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const openedFile = (id = 'opened', path = 'C:/opened.sql'): OpenSqlFile => ({ id, path, name: path.split('/').at(-1)!, content: 'SELECT 1', encoding: 'utf8', readOnly: false, eol: 'lf', mixedEol: false })
function fixture() {
  const doc = documentFixture()
  const api = {
    ...doc.api,
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {}),
    closeWindowCancelled: vi.fn<VariaApi['closeWindowCancelled']>()
  }
  // Nothing to ask about unless a test says otherwise: every session ends plainly.
  const queries = { isRunning: vi.fn<(id: string) => boolean>(() => false), mayHaveTransaction: vi.fn<(id: string) => Promise<boolean>>(async () => false), confirmSessions: vi.fn<QueryService['confirmSessions']>(async () => new Map()) }
  const files = new FileService(doc.documents, queries, api), commands = new CommandService()
  // Focus is in Object Explorer when `explorer.panel` says so; its selection is `explorer.target`.
  const explorer: { panel: '' | 'explorer'; target?: { connectionId: string; database?: string } } = { panel: '' }
  const context = { get: () => contextRecord('win32', { activePanel: explorer.panel }) }
  const connections = { get: (id: string) => id === 'server-b' ? { ...connectionInfo('server-b'), options: connectionOptions, database: 'sales' } : undefined }
  const contribution = filesContribution({ files, commands, documents: doc.documents, context, connections, explorer: { queryTarget: () => explorer.target } }, { writeClipboardText: async () => ({ ok: true, value: undefined }), revealSqlFile: async () => ({ ok: true, value: undefined }) })
  doc.documents.create('SQLQuery1.sql', '', 'master', 'server-a')
  cleanups.push(() => { contribution.dispose(); commands.dispose(); files.dispose(); doc.documents.dispose() })
  return { ...doc, api, queries, files, commands, contribution, explorer }
}

describe('file commands', () => {
  it('creates numbered queries with the active target and respects the document lock', async () => {
    const { documents, commands } = fixture()
    documents.update(documents.active!.id, { database: 'analytics' })
    await commands.run('file.new')
    expect(documents.active).toMatchObject({ name: 'SQLQuery2.sql', database: 'analytics', connectionId: 'server-a', dirty: false })
    const pending = deferred<void>(), busy = documents.runTask(() => pending.promise)
    await commands.run('file.new')
    expect(documents.getSnapshot().documents).toHaveLength(2)
    pending.resolve(); await busy
    await commands.run('file.new')
    expect(documents.active?.name).toBe('SQLQuery3.sql')
  })
  it('opens New Query on the selected Object Explorer node\'s server and database while the tree has focus, as SSMS does', async () => {
    const { documents, commands, explorer } = fixture()
    explorer.target = { connectionId: 'server-b', database: 'AppData' }
    // Elsewhere, the active query's target, whatever Object Explorer has selected.
    await commands.run('file.new')
    expect(documents.active).toMatchObject({ name: 'SQLQuery2.sql', connectionId: 'server-a', database: 'master' })
    explorer.panel = 'explorer'
    await commands.run('file.new')
    expect(documents.active).toMatchObject({ name: 'SQLQuery3.sql', connectionId: 'server-b', database: 'AppData' })
    // A server node: its connection's database.
    explorer.target = { connectionId: 'server-b' }
    await commands.run('file.new')
    expect(documents.active).toMatchObject({ connectionId: 'server-b', database: 'sales' })
    // Nothing selected: as anywhere else.
    explorer.target = undefined
    await commands.run('file.new')
    expect(documents.active).toMatchObject({ connectionId: 'server-b', database: 'sales', name: 'SQLQuery5.sql' })
  })
  it('captures the open-dialog target and opens multiple clean documents', async () => {
    const { documents, api, commands } = fixture()
    documents.update(documents.active!.id, { database: 'analytics' })
    const pending = deferred<ApiResult<OpenSqlFile[]>>()
    api.openSqlFiles.mockReturnValueOnce(pending.promise)
    const opening = commands.run('file.open')
    documents.create('other.sql', '', 'other-database', 'server-b')
    pending.resolve({ ok: true, value: [openedFile('first', 'C:/first.sql'), openedFile('second', 'C:/second.sql')] })
    await opening
    const opened = documents.getSnapshot().documents.filter(document => document.file)
    expect(opened.map(document => [document.connectionId, document.database, document.dirty])).toEqual([['server-a', 'analytics', false], ['server-a', 'analytics', false]])
    expect(documents.active?.file?.id).toBe('second')
    expect(api.releaseSqlFile).not.toHaveBeenCalled()
  })
  it('reopens an existing document without overwriting edits, replacing its model, or releasing its file', async () => {
    const { documents, model, api, commands, events } = fixture()
    const file = openedFile()
    const tab = documents.create(file.name, file.content, 'master', 'server-a', false, file)
    model(tab.id).edit('SELECT unsaved')
    const activate = vi.fn()
    events.subscribe(event => { if (event.type === 'documents.activated') activate(event.tabId) })
    api.openSqlFiles.mockResolvedValueOnce({ ok: true, value: [file] })
    await commands.run('file.open')
    expect(documents.getSnapshot().documents).toHaveLength(2)
    expect(model(tab.id).getValue()).toBe('SELECT unsaved')
    expect(model(tab.id).disposed).toBe(false)
    expect(activate).toHaveBeenCalledWith(tab.id)
    expect(api.releaseSqlFile).not.toHaveBeenCalled()
  })
  it('finds an open file\'s tab by the id main gave it, whatever path spelling main returns', async () => {
    const { documents, api, commands, events } = fixture()
    const tab = documents.create('Orders.sql', 'SELECT 1', 'master', 'server-a', false, openedFile('orders', 'C:/Orders.sql'))
    const activate = vi.fn()
    events.subscribe(event => { if (event.type === 'documents.activated') activate(event.tabId) })
    api.openSqlFiles.mockResolvedValueOnce({ ok: true, value: [openedFile('orders', 'C:/ORDERS.SQL')] })
    await commands.run('file.open')
    expect(documents.getSnapshot().documents.filter(document => document.file?.id === 'orders')).toHaveLength(1)
    expect(activate).toHaveBeenCalledWith(tab.id)
  })
  it('saves an explicit document and keeps that target when activation changes during Save As', async () => {
    const { documents, model, api, commands } = fixture()
    const left = documents.active!
    model(left.id).edit('SELECT left')
    const right = documents.newQuery('SELECT right')
    const pending = deferred<SaveResponse>()
    api.saveSqlFile.mockReturnValueOnce(pending.promise)
    const saving = commands.run('file.saveAs', { tabId: left.id })
    expect(api.saveSqlFile).toHaveBeenCalledWith(expect.objectContaining({ content: 'SELECT left', saveAs: true }))
    pending.resolve({ ok: true, value: openedFile('saved', 'C:/left.sql') })
    await saving
    expect(documents.get(left.id)).toMatchObject({ dirty: false, name: 'left.sql' })
    expect(documents.active?.id).toBe(right.id)
    expect(documents.get(right.id)?.file).toBeUndefined()
  })
  it('closes the explicit inactive tab after confirmation and then releases its file', async () => {
    const { documents, model, api, commands } = fixture()
    const file = openedFile()
    const tab = documents.create(file.name, file.content, 'master', 'server-a', false, file)
    model(tab.id).edit('SELECT changed')
    const other = documents.newQuery()
    const pending = deferred<Awaited<ReturnType<VariaApi['confirmClose']>>>()
    api.confirmClose.mockReturnValueOnce(pending.promise)
    api.releaseSqlFile.mockImplementation(async id => {
      expect(id).toBe(file.id)
      expect(documents.get(tab.id)).toBeUndefined()
      expect(model(tab.id).disposed).toBe(true)
      return { ok: true, value: undefined }
    })
    const closing = commands.run('file.close', { tabId: tab.id })
    documents.activate(documents.getSnapshot().documents[0].id)
    const active = documents.active!.id
    pending.resolve({ ok: true, value: 'discard' }); await closing
    expect(api.confirmClose).toHaveBeenCalledWith(file.name)
    expect(api.closeQuerySession).toHaveBeenCalledWith(tab.id)
    expect(documents.active?.id).toBe(active)
    expect(model(other.id).disposed).toBe(false)
    expect(api.releaseSqlFile).toHaveBeenCalledTimes(1)
  })
  it('closes many queries in tab order, stops at Cancel, and releases their files', async () => {
    const { documents, model, api, commands, files } = fixture()
    const [first] = documents.getSnapshot().documents
    const saved = documents.create('saved.sql', 'SELECT 1', 'master', undefined, false, { id: 'saved-file', name: 'saved.sql', path: 'C:/saved.sql', encoding: 'utf8', readOnly: false })
    const dirty = documents.create('dirty.sql', '', 'master'), kept = documents.create('kept.sql', '', 'master'), last = documents.create('last.sql', '', 'master')
    model(dirty.id).edit('SELECT dirty')
    model(kept.id).edit('SELECT kept')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: 'discard' }).mockResolvedValueOnce({ ok: true, value: 'cancel' })
    await commands.run('file.closeAll')
    // Visual Studio's Close All: Cancel keeps that query and every one after it.
    expect(documents.getSnapshot().documents.map(document => document.id)).toEqual([kept.id, last.id])
    expect(api.confirmClose.mock.calls).toEqual([['dirty.sql'], ['kept.sql']])
    expect(api.releaseSqlFile.mock.calls).toEqual([['saved-file']])
    expect(api.closeQuerySession.mock.calls.map(call => call[0])).toEqual([first.id, saved.id, dirty.id])
    expect(files.getSnapshot().error).toBe('')
  })
  it('asks once about open transactions when closing many, ends each as its query closes, and closes nothing on Cancel', async () => {
    const { documents, queries, api, commands } = fixture()
    const [first] = documents.getSnapshot().documents
    const open = documents.create('open.sql', '', 'master'), busy = documents.create('busy.sql', '', 'master')
    queries.isRunning.mockImplementation(id => id === busy.id)
    queries.confirmSessions.mockResolvedValueOnce(undefined)
    await commands.run('file.closeAll')
    // Running queries stay open, as before, so they are not asked about here.
    expect(queries.confirmSessions).toHaveBeenCalledExactlyOnceWith('closeAll', [first.id, open.id])
    expect(documents.getSnapshot().documents).toHaveLength(3)
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    queries.confirmSessions.mockResolvedValueOnce(new Map([[open.id, 'rollback']]))
    await commands.run('file.closeAll')
    expect(api.closeQuerySession.mock.calls).toEqual([[first.id], [open.id, 'rollback']])
    expect(documents.getSnapshot().documents.map(document => document.id)).toEqual([busy.id])
  })
  it('keeps running queries open when closing many, and says how many', async () => {
    const { documents, queries, commands, files } = fixture()
    const running = [documents.create('a.sql', '', 'master'), documents.create('b.sql', '', 'master')]
    documents.create('c.sql', '', 'master')
    queries.isRunning.mockImplementation(id => running.some(document => document.id === id))
    await commands.run('file.closeAll')
    expect(documents.getSnapshot().documents.map(document => document.name)).toEqual(['a.sql', 'b.sql'])
    expect(files.getSnapshot().error).toBe('2 queries are still running and stayed open.')
    queries.isRunning.mockImplementation(id => id === running[0].id)
    await files.closeMany(running.map(document => document.id))
    expect(files.getSnapshot().error).toBe('1 query is still running and stayed open.')
    expect(documents.getSnapshot().documents.map(document => document.name)).toEqual(['a.sql'])
  })
  it('keeps open a query that finished with a transaction while Close All asked about the others', async () => {
    const { documents, queries, api, commands, files } = fixture()
    const [first] = documents.getSnapshot().documents
    const open = documents.create('open.sql', '', 'master'), late = documents.create('late.sql', '', 'master'), clean = documents.create('clean.sql', '', 'master')
    const running = new Set([late.id, clean.id])
    queries.isRunning.mockImplementation(id => running.has(id))
    // Both finish while the prompt about open.sql is open: late.sql with a transaction nobody was asked about.
    queries.confirmSessions.mockImplementationOnce(async () => {
      running.clear()
      queries.mayHaveTransaction.mockImplementation(async id => id === late.id || id === open.id)
      return new Map([[open.id, 'commit']])
    })
    await commands.run('file.closeAll')
    expect(queries.confirmSessions).toHaveBeenCalledExactlyOnceWith('closeAll', [first.id, open.id])
    expect(api.closeQuerySession.mock.calls).toEqual([[first.id], [open.id, 'commit'], [clean.id]])
    expect(documents.getSnapshot().documents.map(document => document.id)).toEqual([late.id])
    expect(files.getSnapshot().error).toBe('1 query finished with an open transaction while this ran and stayed open; run it again to be asked about it.')
    // Its session was read once it finished (only the queries the prompt did not cover are read again).
    expect(queries.mayHaveTransaction.mock.calls).toEqual([[late.id], [clean.id]])
  })
  it('saves a copy to a file the user picks without opening it, and saves nothing on Cancel', async () => {
    const { documents, api, files } = fixture()
    await files.saveCopy('dbo.Orders.sql', 'CREATE TABLE dbo.Orders (Id int);')
    expect(api.saveSqlFile.mock.calls).toEqual([[{ name: 'dbo.Orders.sql', content: 'CREATE TABLE dbo.Orders (Id int);', saveAs: true }]])
    // Main keeps a handle for each saved file; nothing holds this one, so it is released at once.
    expect(api.releaseSqlFile.mock.calls).toEqual([['file-id']])
    expect(documents.getSnapshot()).toMatchObject({ busy: false, documents: [{ name: 'SQLQuery1.sql' }] })
    api.saveSqlFile.mockResolvedValueOnce({ ok: true, value: null })
    await files.saveCopy('dbo.Orders.sql', 'x')
    expect(api.releaseSqlFile).toHaveBeenCalledOnce()
    api.saveSqlFile.mockResolvedValueOnce({ ok: false, error: 'Disk full.' })
    await files.saveCopy('dbo.Orders.sql', 'x')
    expect(files.getSnapshot().error).toBe('Disk full.')
  })
  it('asks before closing a running query: Keep Running keeps it, and cancelling it closes it with its work rolled back', async () => {
    const { documents, queries, api, commands } = fixture()
    const tab = documents.active!
    queries.isRunning.mockReturnValue(true)
    queries.confirmSessions.mockResolvedValueOnce(undefined)
    await commands.run('file.close')
    expect(queries.confirmSessions).toHaveBeenCalledExactlyOnceWith('close', [tab.id])
    expect(documents.getSnapshot().documents).toHaveLength(1)
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    queries.confirmSessions.mockResolvedValueOnce(new Map([[tab.id, 'rollback']]))
    await commands.run('file.close')
    expect(api.closeQuerySession.mock.calls).toEqual([[tab.id, 'rollback']])
    expect(documents.getSnapshot().documents).toHaveLength(0)
  })
  it('asks about unsaved changes before an open transaction, and commits it in the query\'s session as it closes', async () => {
    const { documents, model, queries, api, commands, files, events } = fixture()
    const tab = documents.active!
    model(tab.id).edit('SELECT dirty')
    const order: string[] = []
    api.confirmClose.mockImplementation(async () => { order.push('save?'); return { ok: true, value: 'discard' } })
    queries.confirmSessions.mockImplementation(async () => { order.push('transaction?'); return new Map([[tab.id, 'commit']]) })
    // A commit that fails keeps the query open, with its transaction, and says why.
    api.closeQuerySession.mockResolvedValueOnce({ ok: false, error: 'The transaction was not committed, and the query stays open.', code: 'SQL_ERROR' })
    const ended: string[] = []
    events.subscribe(event => { if (event.type === 'session.ended') ended.push(event.tabId) })
    await commands.run('file.close')
    expect(order).toEqual(['save?', 'transaction?'])
    expect(documents.get(tab.id)).toBeDefined()
    expect(files.getSnapshot().error).toBe('The transaction was not committed, and the query stays open.')
    expect(ended).toEqual([])
    await commands.run('file.close')
    expect(api.closeQuerySession.mock.calls).toEqual([[tab.id, 'commit'], [tab.id, 'commit']])
    expect(documents.get(tab.id)).toBeUndefined()
    expect(ended).toEqual([tab.id])
    // Cancel on the save prompt asks nothing more.
    const next = documents.newQuery('SELECT 2')
    model(next.id).edit('SELECT changed')
    api.confirmClose.mockImplementation(async () => ({ ok: true, value: 'cancel' }))
    await commands.run('file.close')
    expect(queries.confirmSessions).toHaveBeenCalledTimes(2)
  })
  it('counts a session found lost as ended, so its query is not asked about again', async () => {
    const { documents, api, files, events } = fixture()
    const tab = documents.active!, ended: string[] = []
    events.subscribe(event => { if (event.type === 'session.ended') ended.push(event.tabId) })
    api.closeQuerySession.mockResolvedValueOnce({ ok: false, error: 'The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed.', code: 'SESSION_LOST' })
    await documents.runTask(() => documents.close(tab.id, 'commit')).catch((error: Error) => files.reportError(error.message))
    expect(ended).toEqual([tab.id])
    expect(documents.get(tab.id)).toBeDefined()
    expect(files.getSnapshot().error).toContain('Nothing was committed.')
  })
  it.each(['cancel', 'save'] as const)('keeps the tab open when close %s is cancelled', async decision => {
    const { documents, model, api, commands, files } = fixture()
    const tab = documents.active!
    model(tab.id).edit('SELECT dirty')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: decision })
    api.saveSqlFile.mockResolvedValueOnce({ ok: true, value: null })
    await commands.run('file.close')
    expect(documents.get(tab.id)?.dirty).toBe(true)
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toBe('')
  })
  it('saves before releasing a query session when closing modified SQL', async () => {
    const { documents, model, api, commands } = fixture()
    const tab = documents.active!
    model(tab.id).edit('SELECT saved')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: 'save' })
    api.closeQuerySession.mockImplementation(async () => {
      expect(documents.get(tab.id)?.dirty).toBe(false)
      expect(api.saveSqlFile).toHaveBeenCalledWith(expect.objectContaining({ content: 'SELECT saved' }))
      return { ok: true, value: { closed: true } }
    })
    await commands.run('file.close')
    expect(documents.get(tab.id)).toBeUndefined()
    expect(api.releaseSqlFile).toHaveBeenCalledWith('file-id')
  })
  it('reports save failures and clears the error on a later successful command', async () => {
    const { documents, model, api, commands, files } = fixture()
    model(documents.active!.id).edit('SELECT dirty')
    api.saveSqlFile.mockResolvedValueOnce({ ok: false, error: 'Disk full' })
    await commands.run('file.save')
    expect(files.getSnapshot().error).toBe('Disk full')
    expect(documents.active?.dirty).toBe(true)
    await commands.run('file.save')
    expect(files.getSnapshot().error).toBe('')
    expect(documents.active?.dirty).toBe(false)
  })
  it('preserves edits made after the user was asked to discard them', async () => {
    const { documents, model, api, commands, files } = fixture()
    const tab = documents.active!
    model(tab.id).edit('SELECT before')
    const pending = deferred<Awaited<ReturnType<VariaApi['confirmClose']>>>()
    api.confirmClose.mockReturnValueOnce(pending.promise)
    const closing = commands.run('file.close')
    model(tab.id).edit('SELECT after')
    pending.resolve({ ok: true, value: 'discard' }); await closing
    expect(model(tab.id).disposed).toBe(false)
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toContain('changed while confirming close')
  })
  it('keeps a tab open when typing overlaps the save requested by close', async () => {
    const { documents, model, api, commands, files } = fixture()
    const tab = documents.active!
    model(tab.id).edit('SELECT before')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: 'save' })
    const pending = deferred<SaveResponse>()
    api.saveSqlFile.mockImplementationOnce(async () => { model(tab.id).edit('SELECT after'); return pending.promise })
    const closing = commands.run('file.close')
    pending.resolve({ ok: true, value: openedFile('saved') }); await closing
    expect(documents.get(tab.id)?.dirty).toBe(true)
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toContain('changed while saving')
  })
  it('does not flush or quit when a window-close confirmation is cancelled, and tells main the close ended', async () => {
    const { documents, model, api, files } = fixture()
    model(documents.active!.id).edit('SELECT dirty')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    const flush = vi.fn(async () => {})
    await files.closeWindow(flush)
    expect(flush).not.toHaveBeenCalled()
    expect(api.closeWindow).not.toHaveBeenCalled()
    // Main would otherwise hand the quit it asked for to the next page after a reload.
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
  })
  it('asks once about every open transaction before quitting, after the unsaved queries, and ends each before the window closes', async () => {
    const { documents, model, queries, api, files } = fixture()
    const [first] = documents.getSnapshot().documents
    const second = documents.create('second.sql', '', 'master', 'server-a')
    model(second.id).edit('SELECT dirty')
    const order: string[] = []
    api.confirmClose.mockImplementation(async name => { order.push('save ' + name); return { ok: true, value: 'discard' } })
    queries.confirmSessions.mockImplementation(async (action, ids) => { order.push(`${action} ${ids.length}`); return undefined })
    const flush = vi.fn(async () => {})
    await files.closeWindow(flush)
    expect(order).toEqual(['save second.sql', 'exit 2'])
    expect(flush).not.toHaveBeenCalled()
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
    // Yes: each session commits in turn before the window closes; one that fails keeps the window open.
    queries.confirmSessions.mockImplementation(async () => new Map([[first.id, 'commit'], [second.id, 'commit']]))
    api.closeQuerySession.mockResolvedValueOnce({ ok: true, value: { closed: true } }).mockResolvedValueOnce({ ok: false, error: 'The transaction was not committed, and the query stays open.' })
    await files.closeWindow(flush)
    expect(api.closeQuerySession.mock.calls).toEqual([[first.id, 'commit'], [second.id, 'commit']])
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toBe('The transaction was not committed, and the query stays open.')
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(2)
    queries.confirmSessions.mockImplementation(async () => new Map([[second.id, 'rollback']]))
    await files.closeWindow(flush)
    expect(api.closeQuerySession.mock.calls.at(-1)).toEqual([second.id, 'rollback'])
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('tells main when its close fails, but not when the window closes', async () => {
    const { api, files } = fixture()
    api.closeWindow.mockRejectedValueOnce(new Error('The window is gone.'))
    await files.closeWindow(async () => {})
    expect(files.exiting).toBe(false)
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
    await files.closeWindow(async () => {})
    expect(api.closeWindow).toHaveBeenCalledTimes(2)
    expect(api.closeWindowCancelled).toHaveBeenCalledTimes(1)
  })
  it('rechecks approved revisions after flushing the layout before quitting', async () => {
    const { documents, model, api, files } = fixture()
    const tab = documents.active!
    const pending = deferred<void>(), flush = vi.fn(() => pending.promise)
    const closing = files.closeWindow(flush)
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())
    model(tab.id).edit('SELECT late')
    pending.resolve(); await closing
    expect(api.closeWindow).not.toHaveBeenCalled()
    expect(files.getSnapshot().error).toContain('changed while closing the window')
    await files.closeWindow(async () => {})
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('serializes window-close requests and flushes before the final close', async () => {
    const { api, files, documents, model, commands } = fixture()
    model(documents.active!.id).edit('SELECT dirty')
    const pending = deferred<Awaited<ReturnType<VariaApi['confirmClose']>>>()
    api.confirmClose.mockReturnValueOnce(pending.promise)
    const flush = vi.fn(async () => { expect(api.closeWindow).not.toHaveBeenCalled() })
    const closing = files.closeWindow(flush)
    // A second request while the first asks is the same close, not a second round of prompts.
    expect(files.closeWindow(flush)).toBe(closing)
    await commands.run('file.new')
    expect(api.confirmClose).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, value: 'discard' }); await closing
    expect(flush).toHaveBeenCalledTimes(1)
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
    expect(api.closeWindowCancelled).not.toHaveBeenCalled()
    expect(documents.getSnapshot().documents).toHaveLength(1)
  })
  it('waits for a file task to end before closing the window, instead of dropping the close', async () => {
    const { api, files, documents, model } = fixture()
    model(documents.active!.id).edit('SELECT dirty')
    // A Script As File… whose save dialog waits in main's queue behind Save Grid Results.
    const save = deferred<SaveResponse>()
    api.saveSqlFile.mockReturnValueOnce(save.promise)
    const copy = files.saveCopy('dbo.Orders.sql', 'CREATE TABLE dbo.Orders (Id int);')
    await vi.waitFor(() => expect(documents.getSnapshot().busy).toBe(true))
    const flush = vi.fn(async () => {})
    const closing = files.closeWindow(flush)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.confirmClose).not.toHaveBeenCalled()
    save.resolve({ ok: true, value: { id: 'file-id', name: 'dbo.Orders.sql', path: 'C:/dbo.Orders.sql', encoding: 'utf8', readOnly: false } })
    await copy
    await closing
    expect(api.confirmClose).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
  })
  it('releases unclaimed file handles after a late open result without releasing an owned handle', async () => {
    const { api, files, documents, commands } = fixture()
    const owned = openedFile('owned')
    documents.create(owned.name, owned.content, 'master', undefined, false, owned)
    const pending = deferred<ApiResult<OpenSqlFile[]>>()
    api.openSqlFiles.mockReturnValueOnce(pending.promise)
    const opening = commands.run('file.open')
    files.dispose()
    pending.resolve({ ok: true, value: [owned, openedFile('unclaimed', 'C:/late.sql')] }); await opening
    expect(api.releaseSqlFile).toHaveBeenCalledExactlyOnceWith('unclaimed')
    expect(documents.getSnapshot().documents).toHaveLength(2)
  })
  it('unregisters file commands when the contribution is disposed', async () => {
    const { contribution, commands } = fixture()
    contribution.dispose()
    expect(commands.canRun('file.new')).toBe(false)
    await expect(commands.run('file.new')).rejects.toThrow('Unknown command')
  })
})

describe('Save All, line endings and file metadata', () => {
  const saved = (id: string, name: string): SaveResponse => ({ ok: true, value: { id, name, path: 'C:/' + name, encoding: 'utf8', readOnly: false } })
  it('saves the queries with unsaved changes in tab order, asking for an untitled query\'s file in turn', async () => {
    const { documents, api, commands, files, model } = fixture()
    const first = documents.active!
    const file = documents.create('saved.sql', 'SELECT 1', 'master', undefined, false, { id: 'file-1', name: 'saved.sql', path: 'C:/saved.sql', encoding: 'utf16le', readOnly: false })
    const clean = documents.create('clean.sql', 'SELECT 3', 'master', undefined, false, { id: 'file-3', name: 'clean.sql', path: 'C:/clean.sql', encoding: 'utf8', readOnly: false })
    expect(files.canSaveAll()).toBe(false)
    model(file.id).edit('SELECT 2')
    model(first.id).edit('SELECT 0')
    expect(files.canSaveAll()).toBe(true)
    api.saveSqlFile.mockImplementation(async options => saved(options.fileId ?? 'new-file', options.fileId ? 'saved.sql' : 'SQLQuery1.sql'))
    await commands.run('file.saveAll')
    // Tab order: the untitled first query (Save As, no file id), then the saved one; the clean one is left alone.
    expect(api.saveSqlFile.mock.calls.map(([options]) => [options.fileId, options.name, options.saveAs])).toEqual([[undefined, 'SQLQuery1.sql', false], ['file-1', 'saved.sql', false]])
    expect(documents.getSnapshot().documents.map(document => document.dirty)).toEqual([false, false, false])
    expect(documents.get(clean.id)?.file?.id).toBe('file-3')
    expect(files.canSaveAll()).toBe(false)
  })
  it('stops at a cancelled Save dialog, as SSMS does, and reports a failed save', async () => {
    const { documents, api, files, model } = fixture()
    const first = documents.active!, second = documents.newQuery('SELECT 2', undefined, undefined, 'master', true), third = documents.newQuery('SELECT 3', undefined, undefined, 'master', true)
    model(first.id).edit('SELECT 1')
    api.saveSqlFile.mockResolvedValueOnce({ ok: true, value: null })
    await files.saveAll()
    expect(api.saveSqlFile).toHaveBeenCalledTimes(1)
    expect([first, second, third].map(document => documents.get(document.id)?.dirty)).toEqual([true, true, true])
    api.saveSqlFile.mockResolvedValueOnce(saved('f1', 'one.sql')).mockResolvedValueOnce({ ok: false, error: 'Access is denied.' })
    await files.saveAll()
    expect(api.saveSqlFile).toHaveBeenCalledTimes(3)
    expect([first, second, third].map(document => documents.get(document.id)?.dirty)).toEqual([false, true, true])
    expect(files.getSnapshot()).toEqual({ error: 'Access is denied.', kind: 'error' })
  })
  it('opens a file with its line ending and keeps its encoding, and says when line endings were mixed', async () => {
    const { documents, api, commands, models } = fixture()
    const crlf = { ...openedFile('crlf', 'C:/crlf.sql'), content: 'SELECT 1\r\nGO\r\n', eol: 'crlf' as const, encoding: 'utf16be' as const, readOnly: true }
    const mixed = { ...openedFile('mixed', 'C:/mixed.sql'), content: 'SELECT 1\nGO\r\n', eol: 'lf' as const, mixedEol: true, encoding: 'legacy' as const, codePage: 'Windows-1252' }
    api.openSqlFiles.mockResolvedValueOnce({ ok: true, value: [crlf, mixed] })
    await commands.run('file.open')
    const [, first, second] = documents.getSnapshot().documents
    expect(first).toMatchObject({ dirty: false, file: { id: 'crlf', encoding: 'utf16be', readOnly: true } })
    expect(first.file).not.toHaveProperty('content')
    expect(second.file).toEqual({ id: 'mixed', name: 'mixed.sql', path: 'C:/mixed.sql', encoding: 'legacy', codePage: 'Windows-1252', readOnly: false })
    const modelOf = (id: string) => models.get(`varia-sql://query/${id}`)!
    expect([modelOf(first.id).getEOL(), modelOf(second.id).getEOL()]).toEqual(['\r\n', '\n'])
    // The line ending is set before the document counts as saved, so it opens clean and undoing an edit makes it clean
    // again; Monaco normalizes mixed text to it.
    expect(first.dirty).toBe(false)
    expect(second.dirty).toBe(false)
    modelOf(first.id).edit('SELECT 2\r\n')
    expect(documents.get(first.id)?.dirty).toBe(true)
    modelOf(first.id).undo()
    expect(documents.get(first.id)?.dirty).toBe(false)
    expect(documents.getSnapshot().busy).toBe(false)
  })
  it('shows the mixed line endings notice as a warning the next file task clears', async () => {
    const { api, commands, files } = fixture()
    api.openSqlFiles.mockResolvedValueOnce({ ok: true, value: [{ ...openedFile('mixed', 'C:/mixed.sql'), eol: 'crlf', mixedEol: true }] })
    await commands.run('file.open')
    expect(files.getSnapshot()).toEqual({ error: 'Line endings in mixed.sql were mixed; it will be saved with CRLF line endings.', kind: 'warning' })
    await commands.run('file.save')
    expect(files.getSnapshot()).toEqual({ error: '', kind: 'error' })
  })
  it('gives a new query the platform\'s line ending', () => {
    const windows = documentFixture({ newLineEnding: 'crlf' }), linux = documentFixture()
    const query = windows.documents.newQuery('SELECT 1\nGO')
    expect(windows.model(query.id).getEOL()).toBe('\r\n')
    expect(windows.model(query.id).getValue()).toBe('SELECT 1\r\nGO')
    expect(windows.documents.get(query.id)?.dirty).toBe(false)
    expect(linux.model(linux.documents.newQuery('SELECT 1').id).getEOL()).toBe('\n')
    // A value opened from the results keeps its own text.
    const value = windows.documents.openText({ name: 'v.xml', text: '<a>\n</a>', kind: 'xml' })
    expect(windows.model(value.id).getEOL()).toBe('\n')
    windows.documents.dispose(); linux.documents.dispose()
  })
})
