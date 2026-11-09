import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ApiResult, BackendState, ConnectionInfo, VariaApi } from '../src/shared/contracts'
import { languageLimits, type LanguageCompletions, type LanguageHover, type LanguageStatus } from '../src/shared/language-service'
import { limits as ipcLimits } from '../src/shared/ipc/wire/protocol'
import { SqlLanguageService } from '../src/renderer/src/languages/SqlLanguageService'
import { SqlDiagnosticsService, sqlDiagnosticDebounceMs } from '../src/renderer/src/languages/SqlDiagnosticsService'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { BackendStateService } from '../src/renderer/src/services/backend'
import { documentFixture, deferred, TestModel } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks() })
const position = { lineNumber: 1, column: 4 } as Monaco.Position
const configured: LanguageStatus = { providers: [{ id: 'sqlserver', configured: true, completion: true, hover: true, refresh: true, diagnostics: true }] }
const completions: LanguageCompletions = { items: [{ label: 'Customer', kind: 7 }], isIncomplete: false }
const token = (): Monaco.CancellationToken => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
function cancellationSource() {
  let cancelled = false
  const listeners = new Set<() => void>()
  return {
    token: { get isCancellationRequested() { return cancelled }, onCancellationRequested: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    } } satisfies Monaco.CancellationToken,
    cancel: () => { if (cancelled) return; cancelled = true; for (const listener of listeners) listener() },
    listenerCount: () => listeners.size
  }
}

/** The editor's public provider boundary, without loading Monaco's UI or implementation internals. */
async function fixture(status = configured, withBackend = false) {
  const docs = documentFixture(), connections = new ConnectionService()
  const api = {
    languageStatus: vi.fn<VariaApi['languageStatus']>(async () => ({ ok: true, value: status })),
    languageComplete: vi.fn<VariaApi['languageComplete']>(async () => ({ ok: true, value: completions })),
    languageHover: vi.fn<VariaApi['languageHover']>(async () => ({ ok: true, value: { contents: 'Customer table' } })),
    languageDiagnostics: vi.fn<VariaApi['languageDiagnostics']>(async request => ({ ok: true, value: { version: request.version, items: [], isIncomplete: false } })),
    languageRefresh: vi.fn<VariaApi['languageRefresh']>(async () => ({ ok: true, value: { refreshed: true } })),
    languageClose: vi.fn<VariaApi['languageClose']>(async () => ({ ok: true, value: { closed: true } }))
  }
  let completion!: Monaco.languages.CompletionItemProvider, hover!: Monaco.languages.HoverProvider
  const unregisterCompletion = vi.fn(), unregisterHover = vi.fn()
  const monaco = { languages: {
    // Distinct values catch accidentally treating LSP's numeric kind as Monaco's numeric kind.
    CompletionItemKind: { Text: 100, Function: 300, Field: 500, Variable: 600, Class: 700, Property: 1000, Keyword: 1400 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: vi.fn((_id: string, provider: Monaco.languages.CompletionItemProvider) => { completion = provider; return { dispose: unregisterCompletion } }),
    registerHoverProvider: vi.fn((_id: string, provider: Monaco.languages.HoverProvider) => { hover = provider; return { dispose: unregisterHover } })
  } } as unknown as typeof Monaco
  const backendApi = {
    getBackendState: vi.fn<VariaApi['getBackendState']>(async () => ({ ok: true, value: { status: 'ready', generation: 1, pid: 1, runtime: 'test', platform: 'test' } })),
    onBackendState: vi.fn<VariaApi['onBackendState']>(() => () => {}),
    restartBackend: vi.fn<VariaApi['restartBackend']>(async () => ({ ok: true, value: true }))
  }
  const backend = withBackend ? new BackendStateService(backendApi, connections) : undefined
  const service = new SqlLanguageService(monaco, api, docs.documents, connections, backend)
  cleanups.push(() => { service.dispose(); docs.documents.dispose(); connections.dispose(); backend?.dispose() })
  await service.refresh()
  const model = (id: string) => {
    const value = docs.model(id)
    return Object.assign(value, {
      getLanguageId: () => value.language,
      isDisposed: () => value.disposed,
      getWordUntilPosition: (at: Monaco.Position) => {
        const word = value.getWordAtPosition(at)
        return { word: word?.word ?? '', startColumn: word?.startColumn ?? at.column, endColumn: at.column }
      }
    }).asModel()
  }
  const getModel = docs.documents.getModel.bind(docs.documents)
  docs.documents.getModel = id => getModel(id) ? model(id) : undefined
  const complete = async (id: string, at = position, cancel = token()) =>
    await completion.provideCompletionItems(model(id), at, { triggerKind: 0 }, cancel) as Monaco.languages.CompletionList
  const getHover = async (id: string, at = position, cancel = token()) => await hover.provideHover(model(id), at, cancel)
  const addConnection = (id: string, providerId: ConnectionInfo['providerId'] = 'sqlserver', generation = 1) => connections.add(
    { id, providerId, generation, server: id, database: 'master', serverVersion: 'test' },
    { server: id, database: 'master', authentication: 'windows', trustServerCertificate: false })
  return { ...docs, documentApi: docs.api, api, connections, service, completion, hover, complete, getHover, model, addConnection, monaco, unregisterCompletion, unregisterHover, backend }
}

describe('SQL language editor integration', () => {
  it('invalidates diagnostics in sibling queries sharing a successfully refreshed connection and database', async () => {
    const f = await fixture()
    f.addConnection('connection-a')
    const a = f.documents.create('a.sql', 'SELECT 1', 'first', 'connection-a'), b = f.documents.create('b.sql', 'SELECT 2', 'first', 'connection-a')
    const c = f.documents.create('c.sql', 'SELECT 3', 'other', 'connection-a')
    const before = f.service.diagnosticsEpoch(b.id), unrelated = f.service.diagnosticsEpoch(c.id)
    expect(await f.service.refreshCache(a.id)).toBe(true)
    expect(f.service.diagnosticsEpoch(b.id)).toBeGreaterThan(before)
    expect(f.service.diagnosticsEpoch(c.id)).toBe(unrelated)
  })
  it('rechecks sibling markers when refresh succeeds after its initiating query was edited', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.addConnection('connection-a')
    const a = f.documents.create('a.sql', 'SELECT Missing', 'first', 'connection-a'), b = f.documents.create('b.sql', 'SELECT Missing', 'first', 'connection-a')
    const setModelMarkers = vi.fn()
    const diagnostics = new SqlDiagnosticsService({ editor: { setModelMarkers }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 } } as unknown as typeof Monaco,
      f.service, f.documents, f.connections, { enabled: () => true, subscribe: () => () => {} })
    cleanups.push(() => diagnostics.dispose())
    const markers = (id: string) => setModelMarkers.mock.calls.filter(call => call[0] === f.model(id)).at(-1)?.[2] ?? []
    f.api.languageDiagnostics.mockImplementation(async request => ({ ok: true, value: { version: request.version,
      items: [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } }, message: 'Invalid column.', severity: 1 }], isIncomplete: false } }))
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs)
    expect(markers(b.id)).toHaveLength(1)
    const answer = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const refresh = f.service.refreshCache(a.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.api.languageRefresh).toHaveBeenCalledOnce()
    f.models.get(`varia-sql://query/${a.id}`)!.edit('SELECT Corrected')
    expect(await refresh).toBe(false)
    f.api.languageDiagnostics.mockImplementation(async request => ({ ok: true, value: { version: request.version, items: [], isIncomplete: false } }))
    answer.resolve({ ok: true, value: { refreshed: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(markers(b.id)).toEqual([])
    expect(diagnostics.status(b.id)?.label).toBe('Checking SQL')
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs)
    expect(diagnostics.status(b.id)?.label).toBe('SQL: no issues')
    expect(f.api.languageDiagnostics.mock.calls.filter(([request]) => request.documentId === b.id)).toHaveLength(2)
  })
  it.each(['context', 'close', 'cancel'] as const)('invalidates the refreshed context after its initiating query changes by %s', async change => {
    const f = await fixture()
    f.addConnection('connection-a')
    const a = f.documents.create('a.sql', 'SELECT 1', 'first', 'connection-a'), b = f.documents.create('b.sql', 'SELECT 2', 'first', 'connection-a')
    const c = f.documents.create('c.sql', 'SELECT 3', 'other', 'connection-a'), cancel = cancellationSource()
    const before = f.service.diagnosticsEpoch(b.id), unrelated = f.service.diagnosticsEpoch(c.id), changed = vi.fn()
    const unsubscribe = f.service.subscribe(changed)
    cleanups.push(unsubscribe)
    const answer = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const refresh = f.service.refreshCache(a.id, cancel.token)
    await vi.waitFor(() => expect(f.api.languageRefresh).toHaveBeenCalledOnce())
    if (change === 'context') f.documents.update(a.id, { database: 'other' })
    if (change === 'close') await f.documents.close(a.id)
    if (change === 'cancel') cancel.cancel()
    expect(await refresh).toBe(false)
    changed.mockClear()
    answer.resolve({ ok: true, value: { refreshed: true } })
    await vi.waitFor(() => expect(f.service.diagnosticsEpoch(b.id)).toBeGreaterThan(before))
    expect(f.service.diagnosticsEpoch(c.id)).toBe(unrelated)
    expect(changed).toHaveBeenCalled()
  })
  it.each(['backend', 'dispose'] as const)('ignores late refresh invalidation after %s changes', async change => {
    const f = await fixture(configured, true)
    f.addConnection('connection-a')
    const a = f.documents.create('a.sql', 'SELECT 1', 'first', 'connection-a'), b = f.documents.create('b.sql', 'SELECT 2', 'first', 'connection-a')
    const answer = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const refresh = f.service.refreshCache(a.id)
    await vi.waitFor(() => expect(f.api.languageRefresh).toHaveBeenCalledOnce())
    if (change === 'backend') f.backend!.receive({ status: 'unresponsive', generation: 1, silentMs: 1 })
    else f.service.dispose()
    expect(await refresh).toBe(false)
    const before = f.service.diagnosticsEpoch(b.id), changed = vi.fn(), unsubscribe = f.service.subscribe(changed)
    cleanups.push(unsubscribe)
    answer.resolve({ ok: true, value: { refreshed: true } })
    for (let count = 0; count < 5; count++) await Promise.resolve()
    expect(f.service.diagnosticsEpoch(b.id)).toBe(before)
    expect(changed).not.toHaveBeenCalled()
  })
  it('closes again after diagnostics queued behind metadata work settle, preventing an orphaned analysis document', async () => {
    const f = await fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    const answer = deferred<Awaited<ReturnType<VariaApi['languageDiagnostics']>>>()
    f.api.languageDiagnostics.mockReturnValueOnce(answer.promise)
    const pending = f.service.diagnostics(f.model(tab.id), token())
    await vi.waitFor(() => expect(f.api.languageDiagnostics).toHaveBeenCalledOnce())
    expect(f.api.languageDiagnostics.mock.calls[0][0]).toEqual({ documentId: tab.id, version: 1, text: 'SELECT Missing', context: { providerId: 'sqlserver', database: 'master' } })
    await f.documents.close(tab.id)
    expect(f.api.languageClose).toHaveBeenCalledWith(tab.id)
    answer.resolve({ ok: true, value: { version: 1, items: [], isIncomplete: false } })
    expect(await pending).toBeUndefined()
    await vi.waitFor(() => expect(f.api.languageClose).toHaveBeenCalledTimes(2))
  })
  it('waits for the old diagnostic context cleanup before analyzing the same model in another database', async () => {
    const f = await fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'first')
    const answer = deferred<Awaited<ReturnType<VariaApi['languageDiagnostics']>>>()
    f.api.languageDiagnostics.mockReturnValueOnce(answer.promise)
    const first = f.service.diagnostics(f.model(tab.id), token())
    await vi.waitFor(() => expect(f.api.languageDiagnostics).toHaveBeenCalledOnce())
    f.documents.update(tab.id, { database: 'second' })
    const second = f.service.diagnostics(f.model(tab.id), token())
    await Promise.resolve()
    expect(f.api.languageDiagnostics).toHaveBeenCalledOnce()
    answer.resolve({ ok: true, value: { version: 1, items: [], isIncomplete: false } })
    expect(await first).toBeUndefined()
    expect(await second).toMatchObject({ version: 1, items: [] })
    expect(f.api.languageDiagnostics.mock.calls[1][0].context.database).toBe('second')
  })
  it('routes a split editor model using its own connection and database while another tab is active', async () => {
    const f = await fixture()
    f.addConnection('connection-a'); f.addConnection('connection-b')
    const a = f.documents.create('a.sql', 'SELECT a', 'catalog-a', 'connection-a')
    const b = f.documents.create('b.sql', 'SELECT b', 'catalog-b', 'connection-b')
    expect(f.documents.active?.id).toBe(b.id)
    const result = await f.complete(a.id)
    expect(f.api.languageComplete).toHaveBeenCalledWith({ documentId: a.id, version: 1, text: 'SELECT a',
      context: { providerId: 'sqlserver', connectionId: 'connection-a', database: 'catalog-a' }, position: { line: 0, character: 3 } })
    expect(result.suggestions[0]).toMatchObject({ label: 'Customer', kind: 700 })
  })

  it('maps UTF-16 positions, snippets and text edits, dropping invalid server ranges', async () => {
    const f = await fixture(), tab = f.documents.create('emoji.sql', '-- 😀\nCus', 'master')
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: true, items: [
      { label: 'Customer', kind: 14, insertTextFormat: 2, textEdit: { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: '${1:Customer}' } },
      { label: 'bad line', textEdit: { range: { start: { line: 8, character: 0 }, end: { line: 8, character: 1 } }, newText: 'x' } },
      { label: 'bad column', textEdit: { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'x' } }
    ] } })
    const result = await f.complete(tab.id, { lineNumber: 2, column: 4 } as Monaco.Position)
    expect(f.api.languageComplete.mock.calls[0][0].position).toEqual({ line: 1, character: 3 })
    expect(result).toEqual({ incomplete: true, suggestions: [{ label: 'Customer', kind: 1400, detail: undefined, documentation: undefined,
      sortText: '1:Customer', filterText: undefined,
      insertText: '${1:Customer}', insertTextRules: 4, range: { startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 4 } }] })
    await f.complete(tab.id, { lineNumber: 1, column: 6 } as Monaco.Position)
    expect(f.api.languageComplete.mock.calls[1][0].position).toEqual({ line: 0, character: 5 })
  })

  it('ranks fields before general SQL names for equal matches while preserving provider order and bare-name filtering', async () => {
    const f = await fixture(), tab = f.documents.create('columns.sql', 'hi', 'master')
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [
      { label: 'hiFunction', kind: 3, sortText: '001-function' },
      { label: '@@hiGlobal', kind: 6, filterText: 'hiGlobal', sortText: '002-global' },
      { label: 'hiKeyword', kind: 14 },
      { label: 't.hiColumn', kind: 5, filterText: 'hiColumn', sortText: '999-column' },
      { label: 'hiProperty', kind: 10, sortText: '998-property' },
      { label: 'hiOtherColumn', kind: 5 }
    ] } })
    const result = await f.complete(tab.id, { lineNumber: 1, column: 3 } as Monaco.Position)
    const sorted = [...result.suggestions].sort((a, b) => a.sortText! < b.sortText! ? -1 : 1)
    expect(sorted.map(item => item.label)).toEqual(['hiProperty', 't.hiColumn', 'hiOtherColumn', 'hiFunction', '@@hiGlobal', 'hiKeyword'])
    expect(result.suggestions.find(item => item.label === 't.hiColumn')).toMatchObject({ filterText: 'hiColumn', sortText: '0:999-column', kind: 500 })
    expect(result.suggestions.find(item => item.label === '@@hiGlobal')).toMatchObject({ filterText: 'hiGlobal', kind: 600 })
  })

  it('renders hover as untrusted Markdown without HTML and rejects invalid hover ranges', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    f.api.languageHover.mockResolvedValueOnce({ ok: true, value: { contents: '[run](command:doThing)<img src=x>', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } })
    expect(await f.getHover(tab.id)).toEqual({ contents: [{ value: '[run](command:doThing)<img src=x>', isTrusted: false, supportHtml: false }],
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 } })
    f.api.languageHover.mockResolvedValueOnce({ ok: true, value: { contents: 'invalid', range: { start: { line: 0, character: 4 }, end: { line: 0, character: 3 } } } })
    expect(await f.getHover(tab.id)).toBeNull()
  })

  it.each(['edit', 'database', 'round trip', 'lost', 'close'] as const)('discards a completion after %s changes its document context', async change => {
    const f = await fixture(); f.addConnection('connection-a')
    const tab = f.documents.create('a.sql', 'SELECT a', 'master', 'connection-a')
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const result = f.complete(tab.id)
    if (change === 'edit') f.models.get(`varia-sql://query/${tab.id}`)!.edit('SELECT b')
    if (change === 'database' || change === 'round trip') f.documents.update(tab.id, { database: 'other' })
    if (change === 'round trip') f.documents.update(tab.id, { database: 'master' })
    if (change === 'lost') f.connections.markLostBefore(2)
    if (change === 'close') await f.documents.close(tab.id)
    answer.resolve({ ok: true, value: completions })
    expect((await result).suggestions).toEqual([])
  })

  it('discards a hover after cancellation and skips already cancelled requests', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const answer = deferred<ApiResult<LanguageHover>>()
    f.api.languageHover.mockReturnValueOnce(answer.promise)
    const cancelled = { ...token(), isCancellationRequested: false }
    const result = f.getHover(tab.id, position, cancelled)
    cancelled.isCancellationRequested = true
    answer.resolve({ ok: true, value: { contents: 'old hover' } })
    expect(await result).toBeNull()
    expect(await f.getHover(tab.id, position, cancelled)).toBeNull()
    expect((await f.complete(tab.id, position, cancelled)).suggestions).toEqual([])
    expect(f.api.languageHover).toHaveBeenCalledTimes(1)
    expect(f.api.languageComplete).not.toHaveBeenCalled()
  })

  it('drops pending responses when the backend changes generation', async () => {
    const f = await fixture(configured, true), tab = f.documents.create('a.sql', 'Customer', 'master')
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const result = f.complete(tab.id)
    f.backend!.receive({ status: 'starting', generation: 2 } satisfies BackendState)
    answer.resolve({ ok: true, value: completions })
    expect((await result).suggestions).toEqual([])
  })

  it('does not request language support for non-SQL, unmanaged, oversized or unsupported models', async () => {
    const f = await fixture()
    const xml = f.documents.openText({ name: 'value.xml', text: '<xml/>', kind: 'xml' })
    const large = f.documents.create('large.sql', 'x'.repeat(languageLimits.documentCharacters + 1), 'master')
    f.addConnection('postgres', 'postgresql')
    const unsupported = f.documents.create('postgres.sql', 'SELECT 1', 'postgres', 'postgres')
    for (const id of [xml.id, large.id, unsupported.id]) {
      expect((await f.complete(id)).suggestions).toEqual([])
      expect(await f.getHover(id)).toBeNull()
    }
    const unmanaged = Object.assign(new TestModel('SELECT 1', 'other://model'), { getLanguageId: () => 'sql' }).asModel()
    expect(await f.completion.provideCompletionItems(unmanaged, position, { triggerKind: 0 }, token())).toEqual({ suggestions: [] })
    expect(f.api.languageComplete).not.toHaveBeenCalled()
    expect(f.api.languageHover).not.toHaveBeenCalled()
  })

  it('does not send a request using a missing or lost connection', async () => {
    const f = await fixture(), missing = f.documents.create('missing.sql', 'SELECT 1', 'master', 'missing')
    f.addConnection('connection-a')
    const lost = f.documents.create('lost.sql', 'SELECT 1', 'master', 'connection-a')
    f.connections.markLostBefore(2)
    for (const id of [missing.id, lost.id]) {
      expect((await f.complete(id)).suggestions).toEqual([])
      expect(await f.getHover(id)).toBeNull()
    }
    expect(f.api.languageComplete).not.toHaveBeenCalled()
    expect(f.api.languageHover).not.toHaveBeenCalled()
    expect(f.service.availability(lost.id).label).toBe('IntelliSense disconnected')
  })

  it('gates unconfigured or disabled capabilities and reports an actionable unavailable reason', async () => {
    const f = await fixture({ providers: [{ id: 'sqlserver', configured: false, completion: true, hover: true, reason: 'Set the service path.' }] })
    const tab = f.documents.create('a.sql', 'SELECT 1', 'master')
    expect((await f.complete(tab.id)).suggestions).toEqual([])
    expect(f.service.availability(tab.id)).toEqual({ label: 'IntelliSense off', detail: 'Set the service path.' })
    f.api.languageStatus.mockResolvedValue({ ok: true, value: { providers: [{ id: 'sqlserver', configured: true, completion: false, hover: false }] } })
    await f.service.refresh()
    expect((await f.complete(tab.id)).suggestions).toEqual([])
    expect(await f.getHover(tab.id)).toBeNull()
    expect(f.api.languageComplete).not.toHaveBeenCalled()
    expect(f.api.languageHover).not.toHaveBeenCalled()
  })

  it('bounds concurrent work, reports request failures, and clears errors after recovery', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const first = f.complete(tab.id)
    expect(await f.complete(tab.id)).toEqual({ suggestions: [], incomplete: true })
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    answer.resolve({ ok: false, error: 'Service stopped.' })
    expect((await first).suggestions).toEqual([])
    expect(f.service.availability(tab.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Service stopped.' })
    expect((await f.complete(tab.id)).suggestions).toHaveLength(1)
    expect(f.service.availability(tab.id).label).toBe('IntelliSense')
  })

  it('waits for canceled quick suggestions and then delivers the latest cursor request without another keystroke', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const oldAnswer = deferred<ApiResult<LanguageCompletions>>(), latestAnswer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(latestAnswer.promise)
    const oldToken = cancellationSource(), latestToken = cancellationSource()
    const old = f.complete(tab.id, { lineNumber: 1, column: 3 } as Monaco.Position, oldToken.token)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    oldToken.cancel()
    const latest = f.complete(tab.id, { lineNumber: 1, column: 7 } as Monaco.Position, latestToken.token)
    let latestSettled = false
    void latest.then(() => { latestSettled = true })
    await Promise.resolve()
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    expect(latestSettled).toBe(false)
    oldAnswer.resolve({ ok: true, value: { items: [{ label: 'Old suggestion' }], isIncomplete: false } })
    expect((await old).suggestions).toEqual([])
    await vi.waitFor(() => expect(f.api.languageComplete).toHaveBeenCalledTimes(2))
    expect(f.api.languageComplete.mock.calls[1][0].position).toEqual({ line: 0, character: 6 })
    // The older finally must not release the newer request's slot while its own backend reply is pending.
    expect(await f.complete(tab.id)).toEqual({ suggestions: [], incomplete: true })
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    latestAnswer.resolve({ ok: true, value: { items: [{ label: 'Latest suggestion' }], isIncomplete: false } })
    expect((await latest).suggestions.map(item => item.label)).toEqual(['Latest suggestion'])
    expect(latestToken.listenerCount()).toBe(0)
  })

  it('retains the actual in-flight barrier when a canceled queued request is replaced again', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const oldAnswer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(oldAnswer.promise)
    const oldToken = cancellationSource(), middleToken = cancellationSource()
    const old = f.complete(tab.id, position, oldToken.token)
    oldToken.cancel()
    const middle = f.complete(tab.id, { lineNumber: 1, column: 5 } as Monaco.Position, middleToken.token)
    middleToken.cancel()
    expect((await middle).suggestions).toEqual([])
    expect(middleToken.listenerCount()).toBe(0)
    const latest = f.complete(tab.id, { lineNumber: 1, column: 8 } as Monaco.Position)
    await Promise.resolve()
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    oldAnswer.resolve({ ok: true, value: completions })
    await old
    expect((await latest).suggestions).toHaveLength(1)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    expect(f.api.languageComplete.mock.calls[1][0].position).toEqual({ line: 0, character: 7 })
  })

  it.each(['cancellation', 'disposal'] as const)('releases a queued hover immediately on %s while an older backend reply is still pending', async change => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const oldAnswer = deferred<ApiResult<LanguageHover>>()
    f.api.languageHover.mockReturnValueOnce(oldAnswer.promise)
    const oldToken = cancellationSource(), latestToken = cancellationSource()
    const old = f.getHover(tab.id, position, oldToken.token)
    oldToken.cancel()
    const latest = f.getHover(tab.id, { lineNumber: 1, column: 6 } as Monaco.Position, latestToken.token)
    if (change === 'cancellation') latestToken.cancel()
    else f.service.dispose()
    expect(await latest).toBeNull()
    expect(latestToken.listenerCount()).toBe(0)
    expect(f.api.languageHover).toHaveBeenCalledTimes(1)
    oldAnswer.resolve({ ok: true, value: { contents: 'Old hover' } })
    expect(await old).toBeNull()
  })

  it('keeps the eight-request limit while a canceled request has a queued replacement', async () => {
    const f = await fixture(), tabs = Array.from({ length: 9 }, (_, index) => f.documents.create(`${index}.sql`, 'Customer', 'master'))
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockImplementation(() => answer.promise)
    const oldToken = cancellationSource()
    const pending = tabs.slice(0, 8).map((tab, index) => f.complete(tab.id, position, index === 0 ? oldToken.token : token()))
    oldToken.cancel()
    const replacement = f.complete(tabs[0].id)
    expect(await f.complete(tabs[8].id)).toEqual({ suggestions: [], incomplete: true })
    expect(f.api.languageComplete).toHaveBeenCalledTimes(8)
    answer.resolve({ ok: true, value: completions })
    await Promise.all(pending)
    expect((await replacement).suggestions).toHaveLength(1)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(9)
  })

  it('closes used documents, unregisters providers once, and discards responses after disposal', async () => {
    const f = await fixture(), a = f.documents.create('a.sql', 'Customer', 'master'), b = f.documents.create('b.sql', 'Customer', 'master')
    await f.complete(a.id)
    await f.documents.close(a.id)
    expect(f.api.languageClose).toHaveBeenCalledWith(a.id)
    const answer = deferred<ApiResult<LanguageHover>>()
    f.api.languageHover.mockReturnValueOnce(answer.promise)
    const result = f.getHover(b.id)
    f.service.dispose(); f.service.dispose()
    answer.resolve({ ok: true, value: { contents: 'late' } })
    expect(await result).toBeNull()
    await vi.waitFor(() => expect(f.api.languageClose.mock.calls.map(([id]) => id)).toEqual([a.id, b.id, b.id]))
    expect(f.unregisterCompletion).toHaveBeenCalledTimes(1)
    expect(f.unregisterHover).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['completion', 'close'], ['completion', 'dispose'], ['hover', 'close'], ['hover', 'dispose'], ['refresh', 'close'], ['refresh', 'dispose']
  ] as const)('cleans up a delayed %s dispatch after %s overtakes it', async (feature, change) => {
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('late.sql', 'Customer', 'master', 'a'), dispatch = deferred<void>()
    let backendDocumentOpen = false
    const open = async () => { await dispatch.promise; backendDocumentOpen = true }
    f.api.languageComplete.mockImplementationOnce(async () => { await open(); return { ok: true, value: completions } })
    f.api.languageHover.mockImplementationOnce(async () => { await open(); return { ok: true, value: { contents: 'Customer table' } } })
    f.api.languageRefresh.mockImplementationOnce(async () => { await open(); return { ok: true, value: { refreshed: true } } })
    f.api.languageClose.mockImplementation(async () => {
      const closed = backendDocumentOpen
      backendDocumentOpen = false
      return { ok: true, value: { closed } }
    })
    const request = feature === 'completion' ? f.complete(tab.id).then(result => { expect(result.suggestions).toEqual([]) })
      : feature === 'hover' ? f.getHover(tab.id).then(result => { expect(result).toBeNull() })
      : f.service.refreshCache(tab.id).then(result => { expect(result).toBe(false) })
    const apiRequest = feature === 'completion' ? f.api.languageComplete : feature === 'hover' ? f.api.languageHover : f.api.languageRefresh
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1))
    if (change === 'close') await f.documents.close(tab.id)
    else f.service.dispose()
    // The control-lane close runs immediately, before the queued request has created any backend state.
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(backendDocumentOpen).toBe(false)
    dispatch.resolve()
    await request
    await vi.waitFor(() => expect(f.api.languageClose).toHaveBeenCalledTimes(2))
    expect(backendDocumentOpen).toBe(false)
  })

  it('finishes delayed old-context cleanup before opening its replacement binding', async () => {
    const f = await fixture(), tab = f.documents.create('late.sql', 'Customer', 'master')
    const dispatch = deferred<void>(), oldToken = cancellationSource(), events: string[] = []
    let backendDatabase: string | undefined
    f.api.languageComplete.mockImplementation(async request => {
      if (request.context.database === 'master') await dispatch.promise
      backendDatabase = request.context.database
      events.push(`open:${backendDatabase}`)
      return { ok: true, value: { items: [{ label: backendDatabase! }], isIncomplete: false } }
    })
    f.api.languageClose.mockImplementation(async () => {
      events.push(`close:${backendDatabase}`)
      const closed = backendDatabase !== undefined
      backendDatabase = undefined
      return { ok: true, value: { closed } }
    })
    const old = f.complete(tab.id, position, oldToken.token)
    f.documents.update(tab.id, { database: 'other' })
    oldToken.cancel()
    const latest = f.complete(tab.id)
    expect(events).toEqual(['close:undefined'])
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    dispatch.resolve()
    expect((await old).suggestions).toEqual([])
    expect((await latest).suggestions.map(item => item.label)).toEqual(['other'])
    expect(events).toEqual(['close:undefined', 'open:master', 'close:master', 'open:other'])
    expect(backendDatabase).toBe('other')
  })

  it('drains forty cached documents after disposal without exhausting the reserved control capacity', async () => {
    const f = await fixture(), acceptedCloses: (() => void)[] = [], backendDocuments = new Set<string>()
    let pendingRequests: number = ipcLimits.pending.requests, peakPending = pendingRequests, releaseCloses = false
    f.api.languageComplete.mockImplementation(async request => {
      backendDocuments.add(request.documentId)
      return { ok: true, value: completions }
    })
    f.api.languageClose.mockImplementation(documentId => {
      if (pendingRequests >= ipcLimits.pending.requests + ipcLimits.pending.control)
        return Promise.resolve({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
      pendingRequests++
      peakPending = Math.max(peakPending, pendingRequests)
      const close = () => { backendDocuments.delete(documentId); pendingRequests--; return { ok: true as const, value: { closed: true } } }
      return releaseCloses ? Promise.resolve(close()) : new Promise(resolve => acceptedCloses.push(() => { resolve(close()) }))
    })
    const tabs = Array.from({ length: 40 }, (_, index) => f.documents.create(`${index}.sql`, 'Customer', 'master'))
    for (const tab of tabs) await f.complete(tab.id)
    f.service.dispose()
    expect(acceptedCloses).toHaveLength(4)
    releaseCloses = true
    acceptedCloses.forEach(finish => finish())
    await vi.waitFor(() => expect(backendDocuments.size).toBe(0))
    expect(f.api.languageClose).toHaveBeenCalledTimes(40)
    expect(peakPending - ipcLimits.pending.requests).toBe(4)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('releases cleanup RPC slots while older document requests still wait for dispatch', async () => {
    const f = await fixture(), dispatch = deferred<void>()
    f.api.languageComplete.mockImplementationOnce(() => dispatch.promise.then(() => ({ ok: true, value: completions })))
      .mockImplementationOnce(() => dispatch.promise.then(() => ({ ok: true, value: completions })))
      .mockImplementationOnce(() => dispatch.promise.then(() => ({ ok: true, value: completions })))
      .mockImplementationOnce(() => dispatch.promise.then(() => ({ ok: true, value: completions })))
    const waiting = Array.from({ length: 4 }, (_, index) => f.documents.create(`waiting-${index}.sql`, 'Customer', 'master'))
    const requests = waiting.map(tab => f.complete(tab.id))
    const cached = f.documents.create('cached.sql', 'Customer', 'master')
    await f.complete(cached.id)
    f.service.dispose()
    await vi.waitFor(() => expect(f.api.languageClose).toHaveBeenCalledWith(cached.id))
    dispatch.resolve()
    await Promise.all(requests)
    await vi.waitFor(() => expect(f.api.languageClose).toHaveBeenCalledTimes(9))
  })

  it('retries explicit predispatch refusals before allowing a new context to bind', async () => {
    vi.useFakeTimers()
    const f = await fixture(), tab = f.documents.create('retry.sql', 'Customer', 'master')
    await f.complete(tab.id)
    f.api.languageClose.mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
      .mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
    f.documents.update(tab.id, { database: 'other' })
    const latest = f.complete(tab.id)
    await vi.advanceTimersByTimeAsync(249)
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(501)
    expect((await latest).suggestions).toHaveLength(1)
    expect(f.api.languageClose).toHaveBeenCalledTimes(3)
    expect(f.api.languageComplete.mock.calls[1][0].context.database).toBe('other')
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it.each(['TIMEOUT', 'BACKEND_LOST'] as const)('does not replay cleanup after %s leaves dispatch uncertain or its backend ended', async code => {
    vi.useFakeTimers()
    const f = await fixture(), tab = f.documents.create('once.sql', 'Customer', 'master')
    await f.complete(tab.id)
    f.api.languageClose.mockResolvedValueOnce({ ok: false, code, error: 'The request could not be confirmed.' })
    await f.documents.close(tab.id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('bounds persistent refusals and keeps their actionable warning until the backend generation ends', async () => {
    vi.useFakeTimers()
    const f = await fixture(configured, true), tab = f.documents.create('busy.sql', 'Customer', 'master')
    const remaining = f.documents.create('remaining.sql', '', 'master')
    await f.complete(tab.id)
    f.api.languageClose.mockResolvedValue({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
    await f.documents.close(tab.id)
    await vi.advanceTimersByTimeAsync(5001)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
    await vi.advanceTimersByTimeAsync(25_000)
    const attempts = f.api.languageClose.mock.calls.length, warning = f.service.getSnapshot().cleanupError
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThanOrEqual(16)
    expect(warning).toContain('Restart SQL Backend when it is safe to stop queries')
    await vi.advanceTimersByTimeAsync(60_000)
    await f.service.refresh()
    expect(f.api.languageClose).toHaveBeenCalledTimes(attempts)
    expect(f.service.availability(remaining.id)).toEqual({ label: 'IntelliSense unavailable', detail: warning })
    f.backend!.receive({ status: 'unresponsive', generation: 1, silentMs: 20_000 })
    f.backend!.receive({ status: 'ready', generation: 1, pid: 1, runtime: 'test', platform: 'test' })
    expect(f.service.getSnapshot().cleanupError).toBe(warning)
    f.backend!.receive({ status: 'starting', generation: 2 })
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('abandons refused cleanup after its backend generation releases the document', async () => {
    vi.useFakeTimers()
    const f = await fixture(configured, true), tab = f.documents.create('old-generation.sql', 'Customer', 'master')
    await f.complete(tab.id)
    f.api.languageClose.mockResolvedValue({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
    await f.documents.close(tab.id)
    await vi.advanceTimersByTimeAsync(249)
    f.backend!.receive({ status: 'starting', generation: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('does not send final cleanup to a replacement backend when an old document request settles', async () => {
    vi.useFakeTimers()
    const f = await fixture(configured, true), tab = f.documents.create('old-request.sql', 'Customer', 'master')
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const completing = f.complete(tab.id)
    await f.documents.close(tab.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    f.backend!.receive({ status: 'ready', generation: 2, pid: 2, runtime: 'test', platform: 'test' })
    f.api.languageClose.mockResolvedValue({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
    answer.resolve({ ok: true, value: completions })
    expect((await completing).suggestions).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('drops obsolete cleanup queued behind occupied RPC slots before dispatch to a replacement backend', async () => {
    vi.useFakeTimers()
    const f = await fixture(configured, true)
    const tabs = Array.from({ length: 5 }, (_, index) => f.documents.create(`old-queued-${index}.sql`, 'Customer', 'master'))
    for (const tab of tabs) await f.complete(tab.id)
    const release = deferred<ApiResult<{ closed: boolean }>>()
    f.api.languageClose.mockReturnValue(release.promise)
    for (const tab of tabs) await f.documents.close(tab.id)
    expect(f.api.languageClose).toHaveBeenCalledTimes(4)
    f.backend!.receive({ status: 'ready', generation: 2, pid: 2, runtime: 'test', platform: 'test' })
    f.api.languageClose.mockResolvedValue({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' })
    release.resolve({ ok: true, value: { closed: true } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.languageClose).toHaveBeenCalledTimes(4)
    expect(f.api.languageClose).not.toHaveBeenCalledWith(tabs[4].id)
    expect(f.service.getSnapshot().cleanupError).toBeUndefined()
  })

  it('counts time waiting for a cleanup RPC slot against an explicitly refused retry budget', async () => {
    vi.useFakeTimers()
    const f = await fixture(), refused = f.documents.create('refused.sql', 'Customer', 'master')
    const occupied = Array.from({ length: 4 }, (_, index) => f.documents.create(`occupied-${index}.sql`, 'Customer', 'master'))
    for (const tab of [refused, ...occupied]) await f.complete(tab.id)
    const release = deferred<ApiResult<{ closed: boolean }>>()
    f.api.languageClose.mockImplementation(id => id === refused.id
      ? Promise.resolve({ ok: false, code: 'TOO_MANY_REQUESTS', error: 'Too many pending backend requests.' }) : release.promise)
    await f.documents.close(refused.id)
    for (const tab of occupied) await f.documents.close(tab.id)
    await vi.advanceTimersByTimeAsync(30_001)
    release.resolve({ ok: true, value: { closed: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.api.languageClose.mock.calls.filter(([id]) => id === refused.id)).toHaveLength(1)
    expect(f.service.getSnapshot().cleanupError).toContain('Some IntelliSense connections could not close')
  })

  it('closes a used document even if its connection context changed before closing', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    await f.complete(tab.id)
    f.documents.update(tab.id, { database: 'other' })
    await f.documents.close(tab.id)
    expect(f.api.languageClose).toHaveBeenCalledWith(tab.id)
  })

  it('waits for the old context to close before requesting suggestions in the new database', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    await f.complete(tab.id)
    const closing = deferred<ApiResult<{ closed: boolean }>>()
    f.api.languageClose.mockReturnValueOnce(closing.promise)
    f.documents.update(tab.id, { database: 'other' })
    const result = f.complete(tab.id)
    await Promise.resolve()
    expect(f.api.languageClose).toHaveBeenCalledWith(tab.id)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    closing.resolve({ ok: true, value: { closed: true } })
    expect((await result).suggestions).toHaveLength(1)
    expect(f.api.languageComplete.mock.calls[1][0].context.database).toBe('other')
  })

  it('lets Monaco cancel a request waiting for the previous database to close', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    await f.complete(tab.id)
    const closing = deferred<ApiResult<{ closed: boolean }>>()
    f.api.languageClose.mockReturnValueOnce(closing.promise)
    f.documents.update(tab.id, { database: 'other' })
    const cancel = cancellationSource(), result = f.complete(tab.id, position, cancel.token)
    cancel.cancel()
    expect((await result).suggestions).toEqual([])
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    expect(cancel.listenerCount()).toBe(0)
    closing.resolve({ ok: true, value: { closed: true } })
  })

  it('recovers a failed status probe on a later completion in the same backend generation', async () => {
    vi.useFakeTimers()
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    f.api.languageStatus.mockResolvedValueOnce({ ok: false, error: 'Provider check failed.' })
    await f.service.refresh()
    const probes = f.api.languageStatus.mock.calls.length
    expect(f.service.availability(tab.id).label).toBe('IntelliSense unavailable')
    const completion = f.complete(tab.id), hover = f.getHover(tab.id)
    await vi.advanceTimersByTimeAsync(999)
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes)
    await vi.advanceTimersByTimeAsync(2)
    expect((await completion).suggestions).toHaveLength(1)
    expect(await hover).toBeTruthy()
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes + 1)
    expect(f.service.availability(tab.id).label).toBe('IntelliSense')
  })

  it('deduplicates an in-flight status retry shared by completion, hover and an explicit probe', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    f.api.languageStatus.mockRejectedValueOnce(new Error('Temporary status error.'))
    await f.service.refresh()
    const answer = deferred<ApiResult<LanguageStatus>>()
    f.api.languageStatus.mockReturnValueOnce(answer.promise)
    const probe = f.service.refresh(), probes = f.api.languageStatus.mock.calls.length
    const completion = f.complete(tab.id), hover = f.getHover(tab.id), duplicate = f.service.refresh()
    await Promise.resolve()
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes + 1)
    expect(f.api.languageComplete).not.toHaveBeenCalled()
    expect(f.api.languageHover).not.toHaveBeenCalled()
    answer.resolve({ ok: true, value: configured })
    await Promise.all([probe, duplicate])
    expect((await completion).suggestions).toHaveLength(1)
    expect(await hover).toBeTruthy()
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes + 1)
  })

  it('releases a status-recovery waiter on disposal without starting its delayed retry', async () => {
    vi.useFakeTimers()
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    f.api.languageStatus.mockResolvedValueOnce({ ok: false, error: 'Temporary probe failure.' })
    await f.service.refresh()
    const probes = f.api.languageStatus.mock.calls.length, pending = f.complete(tab.id)
    f.service.dispose()
    expect((await pending).suggestions).toEqual([])
    await vi.advanceTimersByTimeAsync(1001)
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes)
    expect(f.api.languageComplete).not.toHaveBeenCalled()
  })

  it('shows delayed language loading and clears it when the response settles', async () => {
    vi.useFakeTimers()
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    const answer = deferred<ApiResult<LanguageCompletions>>()
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const result = f.complete(tab.id)
    expect(f.service.availability(tab.id).label).toBe('IntelliSense')
    await vi.advanceTimersByTimeAsync(151)
    expect(f.service.availability(tab.id).label).toBe('IntelliSense loading')
    answer.resolve({ ok: true, value: completions })
    await result
    expect(f.service.availability(tab.id).label).toBe('IntelliSense')
  })

  it('refreshes the requested query rather than the active editor and deduplicates repeated actions', async () => {
    const f = await fixture(); f.addConnection('a'); f.addConnection('b')
    const a = f.documents.create('a.sql', 'SELECT a', 'catalog-a', 'a'), b = f.documents.create('b.sql', 'SELECT b', 'catalog-b', 'b')
    const answer = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const refresh = f.service.refreshCache(a.id)
    await vi.waitFor(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
    expect(f.api.languageRefresh).toHaveBeenCalledWith({ documentId: a.id, version: 1, text: 'SELECT a', context: { providerId: 'sqlserver', connectionId: 'a', database: 'catalog-a' } })
    expect(f.service.availability(a.id).label).toBe('IntelliSense refreshing')
    expect(f.service.availability(b.id).label).toBe('IntelliSense')
    const duplicate = f.service.refreshCache(a.id)
    answer.resolve({ ok: true, value: { refreshed: true } })
    expect(await refresh).toBe(true); expect(await duplicate).toBe(true)
    expect(f.api.languageRefresh).toHaveBeenCalledTimes(1)
    expect(f.model(a.id).getValue()).toBe('SELECT a')
    expect(f.documents.active?.id).toBe(b.id)
    expect(f.documentApi.closeQuerySession).not.toHaveBeenCalled()
    expect(f.service.availability(a.id).label).toBe('IntelliSense')
  })

  it('invalidates older suggestions and holds new suggestions until metadata refresh finishes', async () => {
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('a.sql', 'Customer', 'master', 'a')
    const oldAnswer = deferred<ApiResult<LanguageCompletions>>(), refreshed = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageComplete.mockReturnValueOnce(oldAnswer.promise)
    f.api.languageRefresh.mockReturnValueOnce(refreshed.promise)
    const old = f.complete(tab.id), refresh = f.service.refreshCache(tab.id)
    await vi.waitFor(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
    oldAnswer.resolve({ ok: true, value: { items: [{ label: 'Old schema' }], isIncomplete: false } })
    expect((await old).suggestions).toEqual([])
    const latest = f.complete(tab.id)
    await Promise.resolve()
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    refreshed.resolve({ ok: true, value: { refreshed: true } })
    expect(await refresh).toBe(true)
    expect((await latest).suggestions).toHaveLength(1)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
  })

  it('waits for the previous database to close before refreshing the new database', async () => {
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('a.sql', 'Customer', 'master', 'a')
    await f.complete(tab.id)
    const close = deferred<ApiResult<{ closed: boolean }>>()
    f.api.languageClose.mockReturnValueOnce(close.promise)
    f.documents.update(tab.id, { database: 'other' })
    const refresh = f.service.refreshCache(tab.id)
    await Promise.resolve()
    expect(f.api.languageRefresh).not.toHaveBeenCalled()
    close.resolve({ ok: true, value: { closed: true } })
    expect(await refresh).toBe(true)
    expect(f.api.languageRefresh.mock.calls[0][0].context.database).toBe('other')
  })

  it.each(['edit', 'context', 'close', 'dispose', 'cancel'] as const)('drops a refreshing action promptly after %s and ignores its late error', async change => {
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('a.sql', 'Customer', 'master', 'a'), cancel = cancellationSource()
    const answer = deferred<ApiResult<{ refreshed: boolean }>>()
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const result = f.service.refreshCache(tab.id, cancel.token)
    await vi.waitFor(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
    if (change === 'edit') f.models.get(`varia-sql://query/${tab.id}`)!.edit('Changed')
    if (change === 'context') f.documents.update(tab.id, { database: 'other' })
    if (change === 'close') await f.documents.close(tab.id)
    if (change === 'dispose') f.service.dispose()
    if (change === 'cancel') cancel.cancel()
    expect(await result).toBe(false)
    expect(cancel.listenerCount()).toBe(0)
    expect(f.service.getSnapshot().activities.has(tab.id)).toBe(false)
    answer.resolve({ ok: false, error: 'Old refresh failed.' })
    for (let count = 0; count < 5; count++) await Promise.resolve()
    expect(f.service.getSnapshot().documentErrors.has(tab.id)).toBe(false)
  })

  it('reports a refresh failure and permits another refresh to recover without reconnecting', async () => {
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('a.sql', 'Customer', 'master', 'a')
    f.api.languageRefresh.mockResolvedValueOnce({ ok: false, error: 'Metadata refresh failed.' })
    await expect(f.service.refreshCache(tab.id)).rejects.toThrow('Metadata refresh failed.')
    expect(f.service.availability(tab.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Metadata refresh failed.' })
    expect(await f.service.refreshCache(tab.id)).toBe(true)
    expect(f.api.languageRefresh).toHaveBeenCalledTimes(2)
    expect(f.service.availability(tab.id).label).toBe('IntelliSense')
  })

  it('forces a fresh status probe for manual refresh despite a previous probe cooldown', async () => {
    vi.useFakeTimers()
    const f = await fixture(); f.addConnection('a')
    const tab = f.documents.create('a.sql', 'Customer', 'master', 'a')
    f.api.languageStatus.mockResolvedValueOnce({ ok: false, error: 'Temporary probe failure.' })
    await f.service.refresh()
    const probes = f.api.languageStatus.mock.calls.length
    const completion = f.complete(tab.id)
    expect(await f.service.refreshCache(tab.id)).toBe(true)
    await completion
    expect(f.api.languageStatus).toHaveBeenCalledTimes(probes + 1)
    expect(f.api.languageRefresh).toHaveBeenCalledTimes(1)
  })

  it('guards disconnected queries and providers without refresh support', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    await expect(f.service.refreshCache(tab.id)).rejects.toThrow('Connect this query')
    f.addConnection('a'); f.documents.update(tab.id, { connectionId: 'a' })
    f.api.languageStatus.mockResolvedValue({ ok: true, value: { providers: [{ id: 'sqlserver', configured: true, completion: true, hover: true, refresh: false }] } })
    await f.service.refresh()
    await expect(f.service.refreshCache(tab.id)).rejects.toThrow('does not support refreshing')
    expect(f.api.languageRefresh).not.toHaveBeenCalled()
  })
})
