import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { LanguageDiagnosticResult } from '../src/shared/language-service'
import type { ConnectionInfo } from '../src/shared/contracts'
import type { BackendSnapshot } from '../src/renderer/src/services/backend'
import type { SqlLanguageService } from '../src/renderer/src/languages/SqlLanguageService'
import { SqlDiagnosticsService, sqlDiagnosticDebounceMs, sqlDiagnosticOwner } from '../src/renderer/src/languages/SqlDiagnosticsService'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { deferred, documentFixture } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers() })
const error = { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } }, message: 'Invalid column.', severity: 1, code: '207', source: 'SQL Tools Service' }
const warning = { ...error, message: 'A provider warning.', severity: 2 }
class Backend extends SnapshotStore<BackendSnapshot> { set(state: BackendSnapshot['state']) { this.publish({ state }) } }
function fixture() {
  vi.useFakeTimers()
  const docs = documentFixture(), connections = new ConnectionService(), languageListeners = new Set<() => void>(), settingListeners = new Set<() => void>()
  const original = docs.documents.getModel.bind(docs.documents)
  docs.documents.getModel = id => {
    const model = original(id)
    if (!model) return
    const test = docs.model(id)
    return Object.assign(model, { getLanguageId: () => test.language, isDisposed: () => test.disposed })
  }
  let enabled = true, epoch = 0
  let snapshot: ReturnType<SqlLanguageService['getSnapshot']> = { checking: false,
    status: { providers: [{ id: 'sqlserver', configured: true, completion: true, hover: true, refresh: true, diagnostics: true }] }, documentErrors: new Map(), activities: new Map() }
  const language = {
    diagnostics: vi.fn<SqlLanguageService['diagnostics']>(async model => ({ version: model.getVersionId(), items: [error, warning], isIncomplete: false })),
    diagnosticsEpoch: () => epoch, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { languageListeners.add(listener); return () => languageListeners.delete(listener) },
    availability: () => ({ label: 'IntelliSense', detail: 'SQL language service unavailable.' })
  }
  const setModelMarkers = vi.fn(), monaco = { editor: { setModelMarkers }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 } } as unknown as typeof Monaco
  const backend = new Backend({ state: { status: 'ready', generation: 1, pid: 1, runtime: 'test', platform: 'test' } })
  const service = new SqlDiagnosticsService(monaco, language, docs.documents, connections,
    { enabled: () => enabled, subscribe: listener => { settingListeners.add(listener); return () => settingListeners.delete(listener) } }, backend)
  const notifyLanguage = () => languageListeners.forEach(listener => listener())
  const markers = (id: string) => setModelMarkers.mock.calls.filter(call => call[0] === docs.documents.getModel(id)).at(-1)?.[2] ?? []
  const addConnection = (id: string, generation = 1) => connections.add(
    { id, providerId: 'sqlserver', generation, server: id, database: 'master', serverVersion: 'test' } satisfies ConnectionInfo,
    { server: id, database: 'master', authentication: 'windows', trustServerCertificate: false })
  cleanups.push(() => { service.dispose(); docs.documents.dispose(); connections.dispose() })
  return { ...docs, connections, language, setModelMarkers, markers, backend, service, addConnection,
    setEnabled: (value: boolean) => { enabled = value; settingListeners.forEach(listener => listener()) },
    replaceLanguage: (value: typeof snapshot) => { snapshot = value; notifyLanguage() },
    refresh: (refreshing: boolean) => { if (refreshing) epoch++; snapshot = { ...snapshot, activities: refreshing ? new Map([[docs.documents.active!.id, 'refreshing']]) : new Map() }; notifyLanguage() },
    tick: () => vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs) }
}

describe('versioned SQL diagnostics markers', () => {
  it('debounces edits and maps severities, UTF-16 ranges and literal messages into its own marker owner', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    f.model(tab.id).edit('SELECT Missing1'); f.model(tab.id).edit('SELECT Missing2')
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs - 1)
    expect(f.language.diagnostics).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.language.diagnostics).toHaveBeenCalledOnce()
    expect(f.markers(tab.id)).toEqual([
      expect.objectContaining({ startLineNumber: 1, startColumn: 8, endColumn: 15, severity: 8, code: '207', modelVersionId: 3 }),
      expect.objectContaining({ message: warning.message, severity: 4 })
    ])
    expect(f.setModelMarkers.mock.calls.every(call => call[1] === sqlDiagnosticOwner)).toBe(true)
    expect(f.service.status(tab.id)?.label).toBe('SQL: 1 error, 1 warning')
  })
  it('clears markers immediately on edit and never applies an older response', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master'), old = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(old.promise)
    await f.tick()
    f.model(tab.id).edit('SELECT Corrected')
    expect(f.markers(tab.id)).toEqual([])
    old.resolve({ version: 1, items: [error], isIncomplete: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.markers(tab.id)).toEqual([])
    f.language.diagnostics.mockResolvedValueOnce({ version: 2, items: [], isIncomplete: false })
    await f.tick()
    expect(f.service.status(tab.id)?.label).toBe('SQL: no issues')
  })
  it('rejects wrong-version diagnostics and invalid ranges instead of drawing stale or out-of-document markers', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    f.language.diagnostics.mockResolvedValueOnce({ version: 2, items: [error], isIncomplete: false })
    await f.tick()
    expect(f.markers(tab.id)).toEqual([])
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis unavailable')
    f.model(tab.id).edit('SELECT MissingX')
    f.language.diagnostics.mockResolvedValueOnce({ version: 2, items: [warning,
      { ...error, range: { start: { line: 7, character: 0 }, end: { line: 7, character: 1 } } }], isIncomplete: false })
    await f.tick()
    expect(f.markers(tab.id)).toHaveLength(1)
    expect(f.service.getSnapshot().documents.get(tab.id)?.isIncomplete).toBe(true)
  })
  it('keeps two model results separate when responses arrive in reverse order', async () => {
    const f = fixture(), a = f.documents.create('a.sql', 'SELECT MissingA', 'master'), b = f.documents.create('b.sql', 'SELECT MissingB', 'master')
    const workA = deferred<LanguageDiagnosticResult | undefined>(), workB = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockImplementation(model => model === f.documents.getModel(a.id) ? workA.promise : workB.promise)
    await f.tick()
    workB.resolve({ version: 1, items: [warning], isIncomplete: false }); await vi.advanceTimersByTimeAsync(0)
    workA.resolve({ version: 1, items: [error], isIncomplete: false }); await vi.advanceTimersByTimeAsync(0)
    expect(f.markers(a.id)[0].severity).toBe(8)
    expect(f.markers(b.id)[0].severity).toBe(4)
  })
  it('bounds concurrency and coalesces queued edits instead of issuing one request per keystroke', async () => {
    const f = fixture(), tabs = Array.from({ length: 4 }, (_, at) => f.documents.create(`${at}.sql`, 'SELECT Missing', 'master'))
    const first = deferred<LanguageDiagnosticResult | undefined>(), second = deferred<LanguageDiagnosticResult | undefined>(), third = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    f.model(tabs[2].id).edit('SELECT NewColumn'); f.model(tabs[2].id).edit('SELECT NewestColumn')
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    first.resolve({ version: 1, items: [], isIncomplete: false }); await vi.advanceTimersByTimeAsync(0)
    expect(f.language.diagnostics).toHaveBeenCalledTimes(3)
    expect((f.language.diagnostics.mock.calls[2][0]).getValue()).toBe('SELECT NewestColumn')
    second.resolve({ version: 1, items: [], isIncomplete: false }); third.resolve({ version: 3, items: [], isIncomplete: false }); await vi.advanceTimersByTimeAsync(0)
  })
  it('clears on disable and rechecks on enable without editing SQL', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    await f.tick(); expect(f.markers(tab.id)).toHaveLength(2)
    f.setEnabled(false)
    expect(f.markers(tab.id)).toEqual([])
    await f.tick(); expect(f.language.diagnostics).toHaveBeenCalledOnce()
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis paused')
    f.setEnabled(true); await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
  })
  it('clears while refreshing and rechecks the unchanged query after refresh', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    await f.tick(); f.refresh(true)
    expect(f.markers(tab.id)).toEqual([])
    await f.tick(); expect(f.language.diagnostics).toHaveBeenCalledOnce()
    f.refresh(false); await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
  })
  it('does not invalidate ready markers on unrelated backend health updates in the same generation', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    await f.tick()
    f.backend.set({ status: 'ready', generation: 1, pid: 2, runtime: 'test', platform: 'test' })
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledOnce()
    expect(f.markers(tab.id)).toHaveLength(2)
  })
  it('suppresses pending results after close or disposal and removes only its own markers', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master'), work = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick(); f.service.dispose()
    work.resolve({ version: 1, items: [error], isIncomplete: false }); await vi.advanceTimersByTimeAsync(0)
    expect(f.markers(tab.id)).toEqual([])
    expect(f.service.getSnapshot().documents.has(tab.id)).toBe(false)
  })
  it('cancels a closed document, clears its owned markers, and never writes to its disposed model again', async () => {
    const f = fixture(), tab = f.documents.create('closed.sql', 'SELECT Missing', 'master')
    await f.tick()
    const model = f.documents.getModel(tab.id)!, work = deferred<LanguageDiagnosticResult | undefined>()
    f.model(tab.id).edit('SELECT MissingX')
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick()
    const token = f.language.diagnostics.mock.calls.at(-1)![1]
    await f.documents.close(tab.id)
    expect(token.isCancellationRequested).toBe(true)
    expect(f.service.status(tab.id)).toBeUndefined()
    expect(f.setModelMarkers.mock.calls.filter(call => call[0] === model).at(-1)?.[2]).toEqual([])
    const writes = f.setModelMarkers.mock.calls.length
    work.resolve({ version: 2, items: [error], isIncomplete: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.setModelMarkers).toHaveBeenCalledTimes(writes)
    expect(f.service.getSnapshot().documents.has(tab.id)).toBe(false)
  })
  it('drops a same-version result after its database changes away and back, then rechecks the current context', async () => {
    const f = fixture(), tab = f.documents.create('database.sql', 'SELECT Missing', 'master'), work = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick()
    const oldToken = f.language.diagnostics.mock.calls[0][1]
    f.documents.update(tab.id, { database: 'other' }); f.documents.update(tab.id, { database: 'master' })
    expect(oldToken.isCancellationRequested).toBe(true)
    work.resolve({ version: 1, items: [error], isIncomplete: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.markers(tab.id)).toEqual([])
    f.language.diagnostics.mockResolvedValueOnce({ version: 1, items: [], isIncomplete: false })
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    expect(f.service.status(tab.id)?.label).toBe('SQL: no issues')
  })
  it('pauses on connection loss and clears pending results before checking a reconnected query', async () => {
    const f = fixture(); f.addConnection('original')
    const tab = f.documents.create('connection.sql', 'SELECT Missing', 'master', 'original'), work = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick()
    f.connections.markLostBefore(2)
    expect(f.language.diagnostics.mock.calls[0][1].isCancellationRequested).toBe(true)
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis paused')
    work.resolve({ version: 1, items: [error], isIncomplete: false })
    await f.tick()
    expect(f.markers(tab.id)).toEqual([])
    expect(f.language.diagnostics).toHaveBeenCalledOnce()
    f.addConnection('reconnected', 2); f.documents.update(tab.id, { connectionId: 'reconnected' })
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    expect(f.markers(tab.id)).toHaveLength(2)
  })
  it('drops results from a lost backend generation and resumes unchanged SQL when the backend becomes ready', async () => {
    const f = fixture(), tab = f.documents.create('generation.sql', 'SELECT Missing', 'master'), work = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick()
    f.backend.set({ status: 'starting', generation: 2 })
    expect(f.language.diagnostics.mock.calls[0][1].isCancellationRequested).toBe(true)
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis paused')
    work.resolve({ version: 1, items: [error], isIncomplete: false })
    await f.tick()
    expect(f.markers(tab.id)).toEqual([])
    expect(f.language.diagnostics).toHaveBeenCalledOnce()
    f.backend.set({ status: 'ready', generation: 2, pid: 2, runtime: 'test', platform: 'test' })
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    expect(f.markers(tab.id)).toHaveLength(2)
  })
  it.each(['disable', 'refresh'] as const)('ignores a pending same-version result during %s and rechecks when it ends', async pause => {
    const f = fixture(), tab = f.documents.create('pending.sql', 'SELECT Missing', 'master'), work = deferred<LanguageDiagnosticResult | undefined>()
    f.language.diagnostics.mockReturnValueOnce(work.promise)
    await f.tick()
    if (pause === 'disable') f.setEnabled(false); else f.refresh(true)
    expect(f.language.diagnostics.mock.calls[0][1].isCancellationRequested).toBe(true)
    work.resolve({ version: 1, items: [error], isIncomplete: false })
    await f.tick()
    expect(f.markers(tab.id)).toEqual([])
    expect(f.language.diagnostics).toHaveBeenCalledOnce()
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis paused')
    if (pause === 'disable') f.setEnabled(true); else f.refresh(false)
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(2)
    expect(f.markers(tab.id)).toHaveLength(2)
  })
  it('tracks at most 128 documents, includes the active overflow document, and releases evicted model work', async () => {
    const f = fixture(), tabs = Array.from({ length: 129 }, (_, at) => f.documents.create(`${at}.sql`, 'SELECT Missing', 'master'))
    await f.tick()
    expect(f.service.getSnapshot().documents.size).toBe(128)
    expect(f.language.diagnostics).toHaveBeenCalledTimes(128)
    expect(f.service.status(tabs[128].id)?.label).toBe('SQL: 1 error, 1 warning')
    expect(f.service.status(tabs[127].id)).toBeUndefined()
    f.documents.activate(tabs[127].id)
    await f.tick()
    expect(f.service.getSnapshot().documents.size).toBe(128)
    expect(f.service.status(tabs[127].id)?.label).toBe('SQL: 1 error, 1 warning')
    expect(f.service.status(tabs[128].id)).toBeUndefined()
    expect(f.markers(tabs[128].id)).toEqual([])
    expect(f.language.diagnostics).toHaveBeenCalledTimes(129)
    f.model(tabs[128].id).edit('SELECT Untracked')
    await f.tick()
    expect(f.language.diagnostics).toHaveBeenCalledTimes(129)
  })
  it('leaves large documents and non-SQL models without diagnostics requests', async () => {
    const f = fixture(), tab = f.documents.create('large.sql', 'x'.repeat(250_001), 'master')
    f.documents.openText({ name: 'value.xml', text: '<value/>', kind: 'xml' })
    await f.tick()
    expect(f.language.diagnostics).not.toHaveBeenCalled()
    expect(f.service.status(tab.id)?.label).toBe('SQL analysis paused')
  })
  it('reports provider failures without claiming the query has no issues and retries on the next edit', async () => {
    const f = fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    f.language.diagnostics.mockRejectedValueOnce(new Error('Metadata unavailable.'))
    await f.tick()
    expect(f.service.status(tab.id)).toEqual({ label: 'SQL analysis unavailable', detail: 'Metadata unavailable.' })
    f.model(tab.id).edit('SELECT MissingX'); await f.tick()
    expect(f.markers(tab.id)).toHaveLength(2)
  })
})
