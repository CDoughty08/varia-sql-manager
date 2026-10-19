import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { RecoveryEntry } from '../src/shared/contracts'
import { savedAgo } from '../src/renderer/src/services/recovery'
import { deferred } from './fixtures/documents'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const minute = 60_000
const entry = (id: string, name: string, patch: Partial<RecoveryEntry> = {}): RecoveryEntry => ({ id, name, kind: 'sql', savedAt: '2026-10-19T09:00:00.000Z', characters: 10, ...patch })
/** A query with unsaved changes: opened clean, then edited. */
function dirtyQuery(fixture: ReturnType<typeof workbenchFixture>, text = 'SELECT 2', name = 'SQLQuery2.sql') {
  const document = fixture.documents.create(name, 'SELECT 1', 'master')
  fixture.model(document.id).edit(text)
  return document.id
}
/** The timer's flush and the calls queued behind it have finished: each awaits only answers that are already there. */
async function settled(_fixture: ReturnType<typeof workbenchFixture>) { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

describe('AutoRecover in the workbench', () => {
  it('saves, every 5 minutes, each query with unsaved changes whose text changed since its last copy', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, documents, recoveryTimers } = fixture
      fixture.connect(connectionInfo('c1'))
      documents.create('clean.sql', 'SELECT 0', 'master')
      const id = dirtyQuery(fixture, 'SELECT 2\r\nGO')
      fixture.targets.update(id, { connectionId: 'c1', database: 'Sales' })
      recoveryTimers.advance(5 * minute - 1)
      await settled(fixture)
      expect(api.writeRecovery).not.toHaveBeenCalled()
      recoveryTimers.advance(1)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(1)
      const [record] = api.writeRecovery.mock.calls[0]
      expect(record).toEqual({ id: expect.any(String), name: 'SQLQuery2.sql', kind: 'sql', eol: 'lf', server: 'c1.example', database: 'Sales', text: 'SELECT 2\r\nGO' })
      // Unchanged since: nothing is written again.
      recoveryTimers.advance(5 * minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(1)
      // Changed: the same copy is replaced.
      fixture.model(id).edit('SELECT 3')
      recoveryTimers.advance(5 * minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(2)
      expect(api.writeRecovery.mock.calls[1][0]).toMatchObject({ id: record.id, text: 'SELECT 3' })
      expect([...api.written.keys()]).toEqual([record.id])
    } finally { fixture.dispose() }
  })

  it('deletes a copy once its query is saved, changed back, or closed', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, documents, files } = fixture
      const saved = dirtyQuery(fixture), reverted = dirtyQuery(fixture), closed = dirtyQuery(fixture)
      await fixture.recovery.flush()
      expect(api.written.size).toBe(3)
      await files.save(saved)
      await settled(fixture)
      expect(api.written.size).toBe(2)
      fixture.model(reverted).undo()
      expect(documents.get(reverted)?.dirty).toBe(false)
      await settled(fixture)
      expect(api.written.size).toBe(1)
      await files.close(closed)
      expect(documents.get(closed)).toBeUndefined()
      await settled(fixture)
      expect(api.written.size).toBe(0)
      expect(api.discardRecovery).toHaveBeenCalledTimes(3)
    } finally { fixture.dispose() }
  })

  it('deletes a copy written while its query was being saved, after the write', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, files } = fixture
      const id = dirtyQuery(fixture)
      const write = deferred<Awaited<ReturnType<typeof api.writeRecovery>>>()
      api.writeRecovery.mockImplementationOnce(async record => { api.written.set(record.id, record); return write.promise })
      const flushing = fixture.recovery.flush()
      await files.save(id)
      expect(api.discardRecovery).not.toHaveBeenCalled()
      write.resolve({ ok: true, value: undefined })
      await flushing
      await settled(fixture)
      expect(api.discardRecovery).toHaveBeenCalledTimes(1)
      expect(api.written.size).toBe(0)
    } finally { fixture.dispose() }
  })

  it('writes nothing while Options turns it off, deletes this page\'s copies then, and follows a new interval', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, settings, recoveryTimers } = fixture
      const id = dirtyQuery(fixture)
      await fixture.recovery.flush()
      expect(api.written.size).toBe(1)
      await settings.update({ 'environment.autoRecover.enabled': false })
      await settled(fixture)
      expect(api.written.size).toBe(0)
      fixture.model(id).edit('SELECT 9')
      recoveryTimers.advance(60 * minute)
      await fixture.recovery.flush()
      expect(api.writeRecovery).toHaveBeenCalledTimes(1)
      expect(recoveryTimers.pending.size).toBe(0)
      // Back on, every minute: the interval counts from the change.
      await settings.update({ 'environment.autoRecover.enabled': true, 'environment.autoRecover.intervalMinutes': 1 })
      recoveryTimers.advance(minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(2)
      expect(recoveryTimers.pending.size).toBe(1)
      await settings.update({ 'environment.autoRecover.intervalMinutes': 10 })
      fixture.model(id).edit('SELECT 10')
      recoveryTimers.advance(9 * minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(2)
      recoveryTimers.advance(minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(3)
      expect(recoveryTimers.pending.size).toBe(1)
    } finally { fixture.dispose() }
  })

  it('reports the first failed write of a session as a warning, and keeps saving', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, commands, recoveryTimers } = fixture
      const id = dirtyQuery(fixture)
      api.writeRecovery.mockResolvedValueOnce({ ok: false, error: 'AutoRecover keeps at most 64 queries (256 MB).' }).mockResolvedValueOnce({ ok: false, error: 'Disk full.' })
      recoveryTimers.advance(5 * minute)
      await settled(fixture)
      expect(commands.getSnapshot()).toEqual({ error: 'AutoRecover could not save SQLQuery2.sql: AutoRecover keeps at most 64 queries (256 MB).', kind: 'warning' })
      commands.clearError()
      // The next try fails too, silently; the one after succeeds.
      recoveryTimers.advance(5 * minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(2)
      expect(api.written.size).toBe(0)
      recoveryTimers.advance(5 * minute)
      await settled(fixture)
      expect(api.writeRecovery).toHaveBeenCalledTimes(3)
      expect(commands.getSnapshot().error).toBe('')
      expect(api.written.size).toBe(1)
      fixture.model(id).edit('SELECT 4')
      api.writeRecovery.mockRejectedValueOnce(new Error('IPC closed.'))
      await fixture.recovery.flush()
      expect(commands.getSnapshot().error).toBe('')
    } finally { fixture.dispose() }
  })

  it('stops once the window is closing, and a page that unloads deletes nothing', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, documents, files } = fixture
      const id = dirtyQuery(fixture)
      await fixture.recovery.flush()
      files.exiting = true
      fixture.model(id).edit('SELECT 5')
      await fixture.recovery.flush()
      expect(api.writeRecovery).toHaveBeenCalledTimes(1)
      // A reload or a crash's reload disposes the workbench, closing its documents: the copies stay to be offered.
      fixture.recovery.dispose()
      documents.dispose()
      expect(api.discardRecovery).not.toHaveBeenCalled()
      expect(api.written.size).toBe(1)
    } finally { fixture.dispose() }
    // The workbench disposes AutoRecover before the documents, whose disposal closes every query.
    const workbench = readFileSync('src/renderer/src/core/workbench.ts', 'utf8')
    expect(workbench.indexOf('recovery.dispose()')).toBeGreaterThan(0)
    expect(workbench.indexOf('recovery.dispose()')).toBeLessThan(workbench.indexOf('documents.dispose()'))
  })

  it('offers what earlier pages left, opens the selected ones as unsaved queries, and discards the rest', async () => {
    const fixture = workbenchFixture({ recovery: [entry('r1', 'orders.sql', { path: 'C:\\Queries\\orders.sql' }), entry('r2', 'SQLQuery3.sql'), entry('r3', 'value.xml', { kind: 'xml' })] })
    try {
      const { api, documents, context, commands, recovery } = fixture
      const file = { id: crypto.randomUUID(), name: 'orders.sql', path: 'C:\\Queries\\orders.sql', encoding: 'utf16le' as const, readOnly: false }
      api.texts.set('r1', { text: 'SELECT 1\r\nGO', eol: 'crlf', file })
      expect(context.getState().hasRecoveryFiles).toBe(false)
      expect(commands.isEnabled('file.recoverUnsaved')).toBe(false)
      await recovery.start()
      expect(recovery.getSnapshot()).toMatchObject({ open: true, entries: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] })
      expect(context.getState().hasRecoveryFiles).toBe(true)
      recovery.closeDialog()
      await recovery.recover(['r1', 'r3'])
      const opened = documents.getSnapshot().documents
      expect(opened.map(document => [document.name, document.dirty, document.connectionId, document.kind, document.file?.id])).toEqual([
        ['orders.sql', true, undefined, undefined, file.id], ['value.xml', true, undefined, 'xml', undefined]
      ])
      expect(fixture.model(opened[0].id).getValue()).toBe('SELECT 1\r\nGO')
      expect(fixture.model(opened[0].id).getEOL()).toBe('\r\n')
      // The file stays registered for its tab.
      expect(api.releaseSqlFile).not.toHaveBeenCalled()
      expect(recovery.getSnapshot().entries.map(item => item.id)).toEqual(['r2'])
      // A recovered query keeps its copy until it is saved: the same record, not a new one.
      await fixture.recovery.flush()
      expect(api.writeRecovery).not.toHaveBeenCalled()
      fixture.model(opened[1].id).edit('<changed/>')
      await fixture.recovery.flush()
      expect(api.writeRecovery.mock.calls.map(([record]) => [record.id, record.kind])).toEqual([['r3', 'xml']])
      await fixture.files.save(opened[0].id)
      await settled(fixture)
      expect(api.discardRecovery).toHaveBeenCalledWith(['r1'])
      // File › Recover Unsaved Queries… lists again and shows the rest; Discard deletes them for good.
      expect(await commands.execute('file.recoverUnsaved', undefined, 'palette')).toBe(true)
      expect(recovery.getSnapshot().open).toBe(true)
      await recovery.discard(['r2'])
      expect(recovery.getSnapshot().entries).toEqual([])
      expect(context.getState().hasRecoveryFiles).toBe(false)
      expect(commands.isEnabled('file.recoverUnsaved')).toBe(false)
    } finally { fixture.dispose() }
  })

  it('opens what it can take, and reports the rest in the file banner', async () => {
    const fixture = workbenchFixture({ recovery: [entry('r1', 'a.sql'), entry('r2', 'b.sql')] })
    try {
      const { api, documents, files, recovery } = fixture
      await recovery.refresh()
      api.takeRecovery.mockResolvedValueOnce({ ok: false, error: 'The AutoRecover copy of this query could not be read.' })
      await recovery.recover(['r1', 'r2'])
      expect(documents.getSnapshot().documents.map(document => document.name)).toEqual(['b.sql'])
      expect(files.getSnapshot()).toEqual({ error: 'The AutoRecover copy of this query could not be read.', kind: 'error' })
    } finally { fixture.dispose() }
  })

  it('says when a copy was saved as SSMS-style relative time', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    expect(['2026-10-19T11:59:30Z', '2026-10-19T11:55:00Z', '2026-10-19T09:00:00Z', '2026-10-18T11:00:00Z', '2026-10-16T12:00:00Z', 'x'].map(at => savedAgo(at, now)))
      .toEqual(['just now', '5 minutes ago', '3 hours ago', 'yesterday', '3 days ago', ''])
  })
})
