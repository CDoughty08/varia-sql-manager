import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, OpenSqlFile, VariaApi } from '../src/shared/contracts'
import { FileService } from '../src/renderer/src/services/files'
import { CommandService } from '../src/renderer/src/core/commands'
import { filesContribution } from '../src/renderer/src/contributions/files'
import { deferred, documentFixture, type SaveResponse } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const openedFile = (id = 'opened', path = 'C:/opened.sql'): OpenSqlFile => ({ id, path, name: path.split('/').at(-1)!, content: 'SELECT 1' })
function fixture() {
  const doc = documentFixture()
  const api = {
    ...doc.api,
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {})
  }
  const queries = { isRunning: vi.fn<(id: string) => boolean>(() => false) }
  const files = new FileService(doc.documents, queries, api), commands = new CommandService()
  const contribution = filesContribution({ files, commands, documents: doc.documents }, { writeClipboardText: async () => ({ ok: true, value: undefined }), revealSqlFile: async () => ({ ok: true, value: undefined }) })
  doc.documents.create('SQLQuery1.sql', '', 'master', 'server-a')
  cleanups.push(() => { contribution.dispose(); commands.dispose(); files.dispose(); doc.documents.dispose() })
  return { ...doc, api, queries, files, commands, contribution }
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
    const saved = documents.create('saved.sql', 'SELECT 1', 'master', undefined, false, { id: 'saved-file', name: 'saved.sql', path: 'C:/saved.sql' })
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
  it('keeps a running tab open without prompting', async () => {
    const { documents, queries, api, commands } = fixture()
    queries.isRunning.mockReturnValue(true)
    await commands.run('file.close')
    expect(documents.getSnapshot().documents).toHaveLength(1)
    expect(api.confirmClose).not.toHaveBeenCalled()
    expect(api.closeQuerySession).not.toHaveBeenCalled()
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
  it('does not flush or quit when a window-close confirmation is cancelled', async () => {
    const { documents, model, api, files } = fixture()
    model(documents.active!.id).edit('SELECT dirty')
    api.confirmClose.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    const flush = vi.fn(async () => {})
    await files.closeWindow(flush)
    expect(flush).not.toHaveBeenCalled()
    expect(api.closeWindow).not.toHaveBeenCalled()
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
    await files.closeWindow(flush); await commands.run('file.new')
    expect(api.confirmClose).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, value: 'discard' }); await closing
    expect(flush).toHaveBeenCalledTimes(1)
    expect(api.closeWindow).toHaveBeenCalledTimes(1)
    expect(documents.getSnapshot().documents).toHaveLength(1)
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
