import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ApiResult, BackendState, ConnectionInfo, VariaApi } from '../src/shared/contracts'
import { languageDefinitionSchema, languageLimits, languageRequestSchema, type LanguageCompletions, type LanguageDefinition, type LanguageHover, type LanguageStatus } from '../src/shared/language-service'
import { limits as ipcLimits } from '../src/shared/ipc/wire/protocol'
import { definitionScheme, pendingLimits, SqlLanguageService } from '../src/renderer/src/languages/SqlLanguageService'
import type { IndexStateEntry } from '../src/renderer/src/languages/IndexCompletionService'
import { definitionErrors } from '../src/renderer/src/languages/definition'
import { SqlDiagnosticsService, sqlDiagnosticDebounceMs } from '../src/renderer/src/languages/SqlDiagnosticsService'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { BackendStateService } from '../src/renderer/src/services/backend'
import { documentFixture, deferred, TestModel } from './fixtures/documents'
import { PeekEditor, peekModelContext } from '../src/renderer/src/explorer/peek-editor'
import type { QueryEditorInstance } from '../src/renderer/src/editor/create-editor'
// @ts-expect-error Monaco ships its internals without declarations; the suggest widget scores with this function.
import { fuzzyScore } from 'monaco-editor/base/common/filters.js'

type Scorer = (pattern: string, patternLow: string, patternStart: number, word: string, wordLow: string, wordStart: number) => [number] | undefined
const labelText = (label: string | Monaco.languages.CompletionItemLabel): string => typeof label === 'string' ? label : label.label
/** The suggest widget's order: fuzzy score of the typed word against filterText (else label), then sortText. */
function monacoOrder(suggestions: Monaco.languages.CompletionItem[], typed: string): string[] {
  return suggestions.flatMap(item => {
    const text = labelText(item.label)
    const filter = item.filterText ?? text
    const score = (fuzzyScore as Scorer)(typed, typed.toLowerCase(), 0, filter, filter.toLowerCase(), 0)
    return score ? [{ label: text, score: score[0], sortText: item.sortText ?? '' }] : []
  }).sort((a, b) => b.score - a.score || (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0)).map(item => item.label)
}

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks() })
// The work these waits watch is promise chains through mocks: no wall-clock bound means anything, and a starved CI worker
// has run them past vi.waitFor's default second.
const landed = (check: () => void) => vi.waitFor(check, { timeout: 15_000 })
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
    languageClose: vi.fn<VariaApi['languageClose']>(async () => ({ ok: true, value: { closed: true } })),
    languageDefinition: vi.fn<VariaApi['languageDefinition']>(async () => ({ ok: true, value: null })),
    languageLookup: vi.fn<VariaApi['languageLookup']>(async ({ requests }) => ({
      ok: true,
      value: { index: 'ready', answers: requests.map(request => ({ state: 'absent', path: [...request.path], items: [], truncated: false })) }
    }))
  }
  let completion!: Monaco.languages.CompletionItemProvider, hover!: Monaco.languages.HoverProvider, definition!: Monaco.languages.DefinitionProvider
  const unregisterCompletion = vi.fn(), unregisterHover = vi.fn(), unregisterDefinition = vi.fn()
  const monaco = { languages: {
    // Distinct values catch accidentally treating LSP's numeric kind as Monaco's numeric kind.
    CompletionItemKind: { Text: 100, Function: 300, Field: 500, Variable: 600, Class: 700, Property: 1000, Keyword: 1400 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: vi.fn((_id: string, provider: Monaco.languages.CompletionItemProvider) => { completion = provider; return { dispose: unregisterCompletion } }),
    registerHoverProvider: vi.fn((_id: string, provider: Monaco.languages.HoverProvider) => { hover = provider; return { dispose: unregisterHover } }),
    registerDefinitionProvider: vi.fn((_id: string, provider: Monaco.languages.DefinitionProvider) => { definition = provider; return { dispose: unregisterDefinition } })
  }, Uri: { from: (parts: object) => parts } } as unknown as typeof Monaco
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
  const getDefinition = async (id: string, at = position, cancel = token()) => await definition.provideDefinition(model(id), at, cancel)
  return { ...docs, documentApi: docs.api, api, connections, service, completion, hover, definition, complete, getHover, getDefinition, model, addConnection, monaco, unregisterCompletion, unregisterHover, unregisterDefinition, backend }
}

describe('SQL language editor integration', () => {
  it('pauses background analysis immediately until overlapping foreground IPC really settles, then restores markers', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const tab = f.documents.create('foreground.sql', 'SELECT Missing', 'master')
    const oldAnalysis = deferred<Awaited<ReturnType<VariaApi['languageDiagnostics']>>>()
    const completion = deferred<Awaited<ReturnType<VariaApi['languageComplete']>>>()
    const hover = deferred<Awaited<ReturnType<VariaApi['languageHover']>>>()
    const issue = { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } }, message: 'Invalid column.', severity: 1 }
    f.api.languageDiagnostics.mockReturnValueOnce(oldAnalysis.promise).mockImplementation(async request => ({ ok: true,
      value: { version: request.version, items: [issue], isIncomplete: false } }))
    f.api.languageComplete.mockReturnValueOnce(completion.promise)
    f.api.languageHover.mockReturnValueOnce(hover.promise)
    const setModelMarkers = vi.fn()
    const diagnostics = new SqlDiagnosticsService({ editor: { setModelMarkers }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 } } as unknown as typeof Monaco,
      f.service, f.documents, f.connections, { enabled: () => true, subscribe: () => () => {} })
    cleanups.push(() => diagnostics.dispose())
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs)
    expect(f.api.languageDiagnostics).toHaveBeenCalledOnce()
    const cancel = cancellationSource(), busy: boolean[] = []
    const unsubscribe = f.service.subscribe(() => { const value = f.service.isForegroundBusy(tab.id); if (busy.at(-1) !== value) busy.push(value) })
    cleanups.push(unsubscribe)
    const completed = f.complete(tab.id, position, cancel.token), hovered = f.getHover(tab.id)
    expect(f.service.isForegroundBusy(tab.id)).toBe(true)
    expect(diagnostics.status(tab.id)?.label).toBe('SQL analysis paused')
    expect(f.api.languageComplete).toHaveBeenCalledOnce()
    expect(f.api.languageHover).toHaveBeenCalledOnce()
    cancel.cancel()
    oldAnalysis.resolve({ ok: false, error: 'Foreground request superseded analysis.', code: 'STALE' })
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs)
    expect(diagnostics.status(tab.id)?.label).toBe('SQL analysis paused')
    expect(f.api.languageDiagnostics).toHaveBeenCalledOnce()
    completion.resolve({ ok: true, value: completions })
    expect((await completed).suggestions).toEqual([])
    expect(f.service.isForegroundBusy(tab.id)).toBe(true)
    hover.resolve({ ok: true, value: { contents: 'SQL hover' } })
    await hovered
    expect(f.service.isForegroundBusy(tab.id)).toBe(false)
    expect(busy).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(sqlDiagnosticDebounceMs)
    expect(f.api.languageDiagnostics).toHaveBeenCalledTimes(2)
    expect(diagnostics.status(tab.id)?.label).toBe('SQL: 1 error')
    expect(setModelMarkers.mock.calls.filter(call => call[0] === f.model(tab.id)).at(-1)?.[2]).toHaveLength(1)
  })
  it('keeps canceled refresh work foreground until its actual IPC finishes', async () => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<VariaApi['languageRefresh']>>>(), cancel = cancellationSource()
    vi.useFakeTimers()
    f.addConnection('connection-a')
    const tab = f.documents.create('refresh.sql', 'SELECT 1', 'master', 'connection-a')
    f.api.languageRefresh.mockReturnValueOnce(answer.promise)
    const refresh = f.service.refreshCache(tab.id, cancel.token)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.isForegroundBusy(tab.id)).toBe(true)
    cancel.cancel()
    expect(await refresh).toBe(false)
    expect(f.service.isForegroundBusy(tab.id)).toBe(true)
    answer.resolve({ ok: true, value: { refreshed: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.isForegroundBusy(tab.id)).toBe(false)
  })
  it.each(['close', 'dispose'] as const)('releases foreground accounting after %s and a late IPC response', async change => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<VariaApi['languageComplete']>>>()
    const tab = f.documents.create('late.sql', 'SEL', 'master')
    f.api.languageComplete.mockReturnValueOnce(answer.promise)
    const work = f.complete(tab.id)
    expect(f.service.isForegroundBusy(tab.id)).toBe(true)
    if (change === 'close') await f.documents.close(tab.id)
    else { f.service.dispose(); expect(f.service.isForegroundBusy(tab.id)).toBe(false) }
    answer.resolve({ ok: true, value: completions })
    expect((await work).suggestions).toEqual([])
    expect(f.service.isForegroundBusy(tab.id)).toBe(false)
  })
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
    await landed(() => expect(f.api.languageRefresh).toHaveBeenCalledOnce())
    if (change === 'context') f.documents.update(a.id, { database: 'other' })
    if (change === 'close') await f.documents.close(a.id)
    if (change === 'cancel') cancel.cancel()
    expect(await refresh).toBe(false)
    changed.mockClear()
    answer.resolve({ ok: true, value: { refreshed: true } })
    await landed(() => expect(f.service.diagnosticsEpoch(b.id)).toBeGreaterThan(before))
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
    await landed(() => expect(f.api.languageRefresh).toHaveBeenCalledOnce())
    if (change === 'backend') f.backend!.receive({ status: 'unresponsive', generation: 1, silentMs: 1 })
    else f.service.dispose()
    expect(await refresh).toBe(false)
    const before = f.service.diagnosticsEpoch(b.id)
    answer.resolve({ ok: true, value: { refreshed: true } })
    for (let count = 0; count < 5; count++) await Promise.resolve()
    expect(f.service.diagnosticsEpoch(b.id)).toBe(before)
    expect(f.service.isForegroundBusy(a.id)).toBe(false)
  })
  it('closes again after diagnostics queued behind metadata work settle, preventing an orphaned analysis document', async () => {
    const f = await fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'master')
    const answer = deferred<Awaited<ReturnType<VariaApi['languageDiagnostics']>>>()
    f.api.languageDiagnostics.mockReturnValueOnce(answer.promise)
    const pending = f.service.diagnostics(f.model(tab.id), token())
    await landed(() => expect(f.api.languageDiagnostics).toHaveBeenCalledOnce())
    expect(f.api.languageDiagnostics.mock.calls[0][0]).toEqual({ documentId: tab.id, version: 1, text: 'SELECT Missing', context: { providerId: 'sqlserver', database: 'master' } })
    await f.documents.close(tab.id)
    expect(f.api.languageClose).toHaveBeenCalledWith(tab.id)
    answer.resolve({ ok: true, value: { version: 1, items: [], isIncomplete: false } })
    expect(await pending).toBeUndefined()
    await landed(() => expect(f.api.languageClose).toHaveBeenCalledTimes(2))
  })
  it('waits for the old diagnostic context cleanup before analyzing the same model in another database', async () => {
    const f = await fixture(), tab = f.documents.create('query.sql', 'SELECT Missing', 'first')
    const answer = deferred<Awaited<ReturnType<VariaApi['languageDiagnostics']>>>()
    f.api.languageDiagnostics.mockReturnValueOnce(answer.promise)
    const first = f.service.diagnostics(f.model(tab.id), token())
    await landed(() => expect(f.api.languageDiagnostics).toHaveBeenCalledOnce())
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
    expect(result.suggestions[0]).toMatchObject({ label: { label: 'Customer' }, kind: 700 })
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
    expect(result).toEqual({ incomplete: true, suggestions: [{ label: { label: 'Customer' }, kind: 1400, detail: undefined, documentation: undefined,
      sortText: '11:Customer', filterText: undefined,
      insertText: '${1:Customer}', insertTextRules: 4, range: { startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 4 } }] })
    await f.complete(tab.id, { lineNumber: 1, column: 6 } as Monaco.Position)
    expect(f.api.languageComplete.mock.calls[1][0].position).toEqual({ line: 0, character: 5 })
  })

  it('emits structured CompletionItemLabel with right-aligned description from detail and omits label.detail', async () => {
    const f = await fixture(), tab = f.documents.create('labels.sql', 'Ord', 'master')
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [
      { label: 'Orders', kind: 7, detail: 'Table' },
      { label: 'SELECT', kind: 14, detail: '   ' },
      { label: 'Customer', kind: 7 }
    ] } })
    const result = await f.complete(tab.id)
    expect(result.suggestions[0]).toMatchObject({ label: { label: 'Orders', description: 'Table' }, detail: 'Table' })
    expect((result.suggestions[0]!.label as Monaco.languages.CompletionItemLabel).detail).toBeUndefined()
    expect(result.suggestions[1]!.label).toEqual({ label: 'SELECT' })
    expect(result.suggestions[2]!.label).toEqual({ label: 'Customer' })
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
    expect(sorted.map(item => labelText(item.label))).toEqual(['hiProperty', 't.hiColumn', 'hiOtherColumn', 'hiFunction', '@@hiGlobal', 'hiKeyword'])
    expect(result.suggestions.find(item => labelText(item.label) === 't.hiColumn')).toMatchObject({ filterText: 'hiColumn', sortText: '10:999-column', kind: 500 })
    expect(result.suggestions.find(item => labelText(item.label) === '@@hiGlobal')).toMatchObject({ filterText: 'hiGlobal', kind: 600 })
  })

  it('puts a case-insensitive exact match first, above case-matching prefixes, system objects and fuzzy matches', async () => {
    const f = await fixture(), tab = f.documents.create('exact.sql', 'SELECT * FROM orderdetails', 'master')
    const range = { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } }
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [
      { label: 'orderdetails_old', kind: 7, textEdit: { range, newText: 'orderdetails_old' } },
      { label: 'sysorderdetails', kind: 7, textEdit: { range, newText: 'sysorderdetails' } },
      { label: 'o_r_d_e_r_details', kind: 7, textEdit: { range, newText: 'o_r_d_e_r_details' } },
      { label: '[OrderDetails]', kind: 7, filterText: 'OrderDetails', textEdit: { range, newText: '[OrderDetails]' } }
    ] } })
    const result = await f.complete(tab.id, { lineNumber: 1, column: 27 } as Monaco.Position)
    expect(result.incomplete).toBe(true)
    expect(result.suggestions.find(item => labelText(item.label) === '[OrderDetails]')).toMatchObject({ filterText: 'orderdetails', sortText: '01:[OrderDetails]' })
    expect(monacoOrder(result.suggestions, 'orderdetails')[0]).toBe('[OrderDetails]')
  })

  it('re-ranks a complete answer as the word grows, without asking the backend again', async () => {
    const f = await fixture(), tab = f.documents.create('grow.sql', 'SELECT * FROM o', 'master')
    const item = (label: string, end: number) => ({ label, kind: 7, filterText: label, textEdit: { range: { start: { line: 0, character: 14 }, end: { line: 0, character: end } }, newText: label } })
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [item('orders_archive', 15), item('sysorders', 15), item('Orders', 15)] } })
    const first = await f.complete(tab.id, { lineNumber: 1, column: 16 } as Monaco.Position)
    expect(first.incomplete).toBe(true)
    expect(first.suggestions.every(suggestion => suggestion.sortText!.startsWith('1'))).toBe(true)
    f.model(tab.id).applyEdits([{ range: { startLineNumber: 1, startColumn: 16, endLineNumber: 1, endColumn: 16 }, text: 'rders' }])
    const grown = await f.completion.provideCompletionItems(f.model(tab.id), { lineNumber: 1, column: 21 } as Monaco.Position, { triggerKind: 2 }, token()) as Monaco.languages.CompletionList
    expect(f.api.languageComplete).toHaveBeenCalledOnce()
    expect(grown.suggestions.find(suggestion => labelText(suggestion.label) === 'Orders')).toMatchObject({ filterText: 'orders', sortText: '01:Orders',
      range: { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 21 } })
    expect(monacoOrder(grown.suggestions, 'orders')[0]).toBe('Orders')
    // Anything but identifier characters typed at the cursor, or a newer epoch, asks the backend.
    f.model(tab.id).applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: ' ' }])
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [] } })
    await f.completion.provideCompletionItems(f.model(tab.id), { lineNumber: 1, column: 22 } as Monaco.Position, { triggerKind: 2 }, token())
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
  })

  it('asks the backend again after a refresh, on another line and after a context change', async () => {
    const f = await fixture()
    f.addConnection('connection-a')
    const tab = f.documents.create('reuse.sql', 'SELECT * FROM o\nSELECT 1', 'master', 'connection-a')
    f.api.languageComplete.mockResolvedValue({ ok: true, value: { isIncomplete: false, items: [{ label: 'Orders', kind: 7 }] } })
    const grow = async (column: number, text: string, line = 1) => {
      f.model(tab.id).applyEdits([{ range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text }])
      return await f.completion.provideCompletionItems(f.model(tab.id), { lineNumber: line, column: column + text.length } as Monaco.Position, { triggerKind: 2 }, token()) as Monaco.languages.CompletionList
    }
    await f.complete(tab.id, { lineNumber: 1, column: 16 } as Monaco.Position)
    await grow(16, 'r')
    expect(f.api.languageComplete).toHaveBeenCalledTimes(1)
    await f.service.refreshCache(tab.id)
    await grow(17, 'd')
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    await grow(9, 'x', 2)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(3)
    f.documents.update(tab.id, { database: 'other' })
    await grow(10, 'y', 2)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(4)
  })

  it('filters a typed bracket against a name the provider sends without filter text', async () => {
    const f = await fixture(), tab = f.documents.create('bracket-table.sql', 'SELECT * FROM [Cust', 'master')
    const range = { start: { line: 0, character: 14 }, end: { line: 0, character: 19 } }
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [{ label: 'Customers', kind: 7, textEdit: { range, newText: 'Customers' } }] } })
    const result = await f.complete(tab.id, { lineNumber: 1, column: 20 } as Monaco.Position)
    expect(result.suggestions[0]).toMatchObject({ label: { label: 'Customers' }, filterText: '[Customers' })
    expect(monacoOrder(result.suggestions, '[Cust')).toEqual(['Customers'])
  })

  it('asks the backend again while its answer was truncated', async () => {
    const f = await fixture(), tab = f.documents.create('truncated.sql', 'SELECT * FROM o', 'master')
    f.api.languageComplete.mockResolvedValue({ ok: true, value: { isIncomplete: true, items: [{ label: 'orders_archive', kind: 7 }] } })
    await f.complete(tab.id, { lineNumber: 1, column: 16 } as Monaco.Position)
    f.model(tab.id).applyEdits([{ range: { startLineNumber: 1, startColumn: 16, endLineNumber: 1, endColumn: 16 }, text: 'r' }])
    await f.completion.provideCompletionItems(f.model(tab.id), { lineNumber: 1, column: 17 } as Monaco.Position, { triggerKind: 2 }, token())
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
  })

  it('shows and inserts the same bracketed column name, and filters a typed bracket against it', async () => {
    const f = await fixture(), tab = f.documents.create('brackets.sql', 'SELECT [col FROM dbo.T AS [bob]', 'master')
    const range = { start: { line: 0, character: 7 }, end: { line: 0, character: 11 } }
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [
      { label: '[bob].[columnName]', kind: 5, filterText: 'columnName', insertText: '[bob].[columnName]', textEdit: { range, newText: '[bob].[columnName]' } }
    ] } })
    const result = await f.complete(tab.id, { lineNumber: 1, column: 12 } as Monaco.Position)
    expect(result.suggestions[0]).toMatchObject({ label: { label: '[bob].[columnName]' }, insertText: '[bob].[columnName]', filterText: '[columnName' })
    expect(monacoOrder(result.suggestions, '[col')).toEqual(['[bob].[columnName]'])
  })

  it('renders hover as untrusted Markdown without HTML and rejects invalid hover ranges', async () => {
    const f = await fixture(), tab = f.documents.create('a.sql', 'Customer', 'master')
    f.api.languageHover.mockResolvedValueOnce({ ok: true, value: { contents: '[run](command:doThing)<img src=x>', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } })
    expect(await f.getHover(tab.id)).toEqual({ contents: [{ value: '[run](command:doThing)<img src=x>', isTrusted: false, supportHtml: false }],
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 } })
    f.api.languageHover.mockResolvedValueOnce({ ok: true, value: { contents: 'invalid', range: { start: { line: 0, character: 4 }, end: { line: 0, character: 3 } } } })
    expect(await f.getHover(tab.id)).toBeNull()
  })

  it('resolves a definition on the query’s own connection and database, as a location naming the object', async () => {
    const f = await fixture(); f.addConnection('connection-a')
    const tab = f.documents.create('a.sql', 'SELECT * FROM dbo.Customer', 'Sales', 'connection-a')
    const found: LanguageDefinition = { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range: { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } } }
    expect(languageDefinitionSchema.safeParse(found).success).toBe(true)
    f.api.languageDefinition.mockResolvedValueOnce({ ok: true, value: found })
    const at = { lineNumber: 1, column: 20 } as Monaco.Position
    expect(await f.getDefinition(tab.id, at)).toEqual({ uri: { scheme: definitionScheme, authority: 'connection-a', path: '/Sales/dbo/Customer', query: 'table' },
      range: { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 27 } })
    const request = f.api.languageDefinition.mock.calls[0]![0]
    expect(request).toMatchObject({ documentId: tab.id, text: 'SELECT * FROM dbo.Customer', position: { line: 0, character: 19 }, context: { providerId: 'sqlserver', connectionId: 'connection-a', database: 'Sales' } })
    // Nothing matched is null; a failure throws its message to the command, and the provider answers nothing.
    expect(await f.service.definition(f.model(tab.id), at)).toBeNull()
    f.api.languageDefinition.mockResolvedValueOnce({ ok: false, error: 'NOT_CONNECTED' })
    await expect(f.service.definition(f.model(tab.id), at)).rejects.toThrow('NOT_CONNECTED')
    f.api.languageDefinition.mockResolvedValueOnce({ ok: false, error: 'NOT_CONNECTED' })
    expect(await f.getDefinition(tab.id, at)).toBeNull()
    // A range outside the model is not believed.
    f.api.languageDefinition.mockResolvedValueOnce({ ok: true, value: { ...found, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } } } })
    expect(await f.service.definition(f.model(tab.id), at)).toBeNull()
    // Definition opens no backend document to close, but it needs a connection.
    expect(f.api.languageClose).not.toHaveBeenCalled()
    const offline = f.documents.create('b.sql', 'SELECT * FROM dbo.Customer', 'master')
    await expect(f.service.definition(f.model(offline.id), at)).rejects.toThrow(definitionErrors.connectFirst)
    expect(await f.getDefinition(offline.id, at)).toBeNull()
    expect(f.api.languageDefinition).toHaveBeenCalledTimes(5)
  })

  it('lets a newer Go to Definition on a document supersede one still waiting, and refuses a query too large to send', async () => {
    const f = await fixture(); f.addConnection('connection-a')
    const tab = f.documents.create('a.sql', 'SELECT * FROM dbo.Customer', 'Sales', 'connection-a')
    const found: LanguageDefinition = { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range: { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } } }
    const first = deferred<ApiResult<LanguageDefinition>>()
    f.api.languageDefinition.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, value: found })
    const at = { lineNumber: 1, column: 20 } as Monaco.Position
    const slow = f.service.definition(f.model(tab.id), at)
    await landed(() => expect(f.api.languageDefinition).toHaveBeenCalledTimes(1))
    // A second press is not dropped: it waits for the first request to settle, then asks again; the first answers nothing.
    const fresh = f.service.definition(f.model(tab.id), at)
    first.resolve({ ok: true, value: found })
    expect(await slow).toBeUndefined()
    expect(await fresh).toEqual({ connectionId: 'connection-a', definition: found })
    expect(f.api.languageDefinition).toHaveBeenCalledTimes(2)
    const large = f.documents.create('c.sql', 'x'.repeat(languageLimits.documentCharacters + 1), 'Sales', 'connection-a')
    await expect(f.service.definition(f.model(large.id), at)).rejects.toThrow(definitionErrors.tooLarge)
    expect(f.api.languageDefinition).toHaveBeenCalledTimes(2)
  })

  it('serves definition without a configured language provider, and drops an answer an edit made stale', async () => {
    const f = await fixture({ providers: [{ id: 'sqlserver', configured: false, completion: false, hover: false, reason: 'not installed' }] }); f.addConnection('connection-a')
    const tab = f.documents.create('a.sql', 'EXEC dbo.Load', 'Sales', 'connection-a')
    const answer = deferred<ApiResult<LanguageDefinition>>()
    f.api.languageDefinition.mockReturnValueOnce(answer.promise)
    const result = f.service.definition(f.model(tab.id), { lineNumber: 1, column: 10 } as Monaco.Position)
    f.models.get(`varia-sql://query/${tab.id}`)!.edit('EXEC dbo.Other')
    answer.resolve({ ok: true, value: { database: 'Sales', schema: 'dbo', name: 'Load', kind: 'procedure', subtype: 'sql', range: { start: { line: 0, character: 5 }, end: { line: 0, character: 13 } } } })
    expect(await result).toBeUndefined()
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
    f.addConnection('postgres', 'bigquery')
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
    await landed(() => expect(f.api.languageComplete).toHaveBeenCalledTimes(2))
    expect(f.api.languageComplete.mock.calls[1][0].position).toEqual({ line: 0, character: 6 })
    // The older finally must not release the newer request's slot while its own backend reply is pending.
    expect(await f.complete(tab.id)).toEqual({ suggestions: [], incomplete: true })
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    latestAnswer.resolve({ ok: true, value: { items: [{ label: 'Latest suggestion' }], isIncomplete: false } })
    expect((await latest).suggestions.map(item => labelText(item.label))).toEqual(['Latest suggestion'])
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
    await landed(() => expect(f.api.languageClose.mock.calls.map(([id]) => id)).toEqual([a.id, b.id, b.id]))
    expect(f.unregisterCompletion).toHaveBeenCalledTimes(1)
    expect(f.unregisterHover).toHaveBeenCalledTimes(1)
    expect(f.unregisterDefinition).toHaveBeenCalledTimes(1)
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
    await landed(() => expect(apiRequest).toHaveBeenCalledTimes(1))
    if (change === 'close') await f.documents.close(tab.id)
    else f.service.dispose()
    // The control-lane close runs immediately, before the queued request has created any backend state.
    expect(f.api.languageClose).toHaveBeenCalledTimes(1)
    expect(backendDocumentOpen).toBe(false)
    dispatch.resolve()
    await request
    await landed(() => expect(f.api.languageClose).toHaveBeenCalledTimes(2))
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
    expect((await latest).suggestions.map(item => labelText(item.label))).toEqual(['other'])
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
    await landed(() => expect(backendDocuments.size).toBe(0))
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
    await landed(() => expect(f.api.languageClose).toHaveBeenCalledWith(cached.id))
    dispatch.resolve()
    await Promise.all(requests)
    await landed(() => expect(f.api.languageClose).toHaveBeenCalledTimes(9))
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
    await landed(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
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
    await landed(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
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
    await landed(() => expect(f.api.languageRefresh).toHaveBeenCalledTimes(1))
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

const peekConnection = '7b0c4a5e-1d2f-4c3b-9a8e-6f5d4c3b2a10'
/** A Peek view's editor as PeekCard makes it, with test models that report their disposal as Monaco's do. */
function peekFixture() {
  const models: TestModel[] = []
  const monaco = { Uri: { parse: (value: string) => value }, editor: { createModel: (value: string, language: string, uri: unknown) => {
    const model = new TestModel(value, String(uri), language), dispose = model.dispose.bind(model), willDispose = new Set<() => void>()
    Object.assign(model, {
      getLanguageId: () => model.language,
      isDisposed: () => model.disposed,
      onWillDispose: (listener: () => void) => { willDispose.add(listener); return { dispose: () => { willDispose.delete(listener) } } },
      dispose: () => { for (const listener of [...willDispose]) listener(); dispose() },
      willDisposeCount: () => willDispose.size
    })
    models.push(model)
    return model.asModel()
  } } }
  let shown: unknown = null
  const create = (): QueryEditorInstance => ({ instance: { getId: () => 'peek-editor', getModel: () => shown, setModel: (model: unknown) => { shown = model } } as never,
    contains: () => false, setVisible: () => {}, dispose: () => {} })
  const element = () => ({ parentElement: null as unknown, className: '', setAttribute() {}, remove() {} })
  const slot = { ownerDocument: { createElement: element }, append(child: { parentElement: unknown }) { child.parentElement = slot } }
  const editor = new PeekEditor({ monaco, create })
  const show = (key: string, text: string) => { editor.show(slot as never, { key, text, connectionId: peekConnection, database: 'Sales' }); return models.at(-1)!.asModel() }
  return { editor, models, show, willDisposeListeners: (model: TestModel) => (model as unknown as { willDisposeCount(): number }).willDisposeCount() }
}
/** The service's per-document bookkeeping, which must hold nothing for a model that is gone. */
const bookkeeping = (service: SqlLanguageService) => {
  const inner = service as unknown as Record<'peekModels' | 'contexts' | 'epochs' | 'used', { size: number; has(id: string): boolean }>
  return { peekModels: inner.peekModels, contexts: inner.contexts, epochs: inner.epochs, used: inner.used }
}
describe('SQL language features in Peek', () => {
  it('serves hover on a Peek model with its connection, database and own UUID, and keeps completion and diagnostics off', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const model = peek.show('1', 'CREATE PROCEDURE dbo.P AS SELECT * FROM dbo.Customer')
    const id = peekModelContext(model)!.documentId
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await f.hover.provideHover(model, position, token())).toEqual({ contents: [{ value: 'Customer table', isTrusted: false, supportHtml: false }], range: undefined })
    // The request is one the backend's schema accepts: Peek's UUID, its text and version, and its connection and database.
    const request = f.api.languageHover.mock.calls[0]![0]
    expect(languageRequestSchema.safeParse(request).success).toBe(true)
    expect(request).toMatchObject({ documentId: id, version: model.getVersionId(), text: model.getValue(), context: { providerId: 'sqlserver', connectionId: peekConnection, database: 'Sales' } })
    expect(f.documents.getSnapshot().documents.map(document => document.id)).not.toContain(id)
    // Read-only: nothing to complete, and no markers on a definition.
    expect(await f.completion.provideCompletionItems(model, position, { triggerKind: 0 }, token())).toEqual({ suggestions: [] })
    expect(f.api.languageComplete).not.toHaveBeenCalled()
    expect(await f.service.diagnostics(model, token())).toBeUndefined()
    expect(f.api.languageDiagnostics).not.toHaveBeenCalled()
    // A model that is not Peek's or a query's is still not served.
    const stray = new TestModel('SELECT 1', 'varia-sql://other/1')
    expect(await f.hover.provideHover(Object.assign(stray, { getLanguageId: () => 'sql' }).asModel(), position, token())).toBeNull()
    expect(f.api.languageHover).toHaveBeenCalledOnce()
  })

  it('resolves a definition in a Peek model with its connection and database, under Peek’s own cap', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const model = peek.show('1', 'CREATE PROCEDURE dbo.P AS SELECT * FROM dbo.Customer')
    const found: LanguageDefinition = { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range: { start: { line: 0, character: 40 }, end: { line: 0, character: 52 } } }
    f.api.languageDefinition.mockResolvedValueOnce({ ok: true, value: found })
    expect(await f.service.definition(model, { lineNumber: 1, column: 48 } as Monaco.Position)).toEqual({ connectionId: peekConnection, definition: found })
    const request = f.api.languageDefinition.mock.calls[0]![0]
    expect(languageRequestSchema.safeParse(request).success).toBe(true)
    expect(request).toMatchObject({ documentId: peekModelContext(model)!.documentId, context: { connectionId: peekConnection, database: 'Sales' } })
    expect(bookkeeping(f.service).used.has(request.documentId)).toBe(false)
    // Two Peek requests in flight fill Peek's cap; query tabs keep theirs.
    const stalled = [deferred<ApiResult<LanguageDefinition>>(), deferred<ApiResult<LanguageDefinition>>()]
    f.api.languageDefinition.mockReturnValueOnce(stalled[0]!.promise).mockReturnValueOnce(stalled[1]!.promise)
    // Each view keeps one model, so three views hold three live Peek models.
    const views = [peekFixture(), peekFixture(), peekFixture()]
    cleanups.push(() => views.forEach(view => view.editor.dispose()))
    const [second, third, fourth] = views.map((view, index) => view.show(String(index), 'SELECT * FROM dbo.A'))
    const pending = [f.service.definition(second!, position), f.service.definition(third!, position)]
    expect(await f.service.definition(fourth!, position)).toBeUndefined()
    expect(f.api.languageDefinition).toHaveBeenCalledTimes(3)
    for (const answer of stalled) answer.resolve({ ok: true, value: null })
    await Promise.all(pending)
  })

  it('closes a Peek model’s backend document with the model, leaving no context, epoch or listener behind', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    const first = peek.show('1', 'CREATE VIEW dbo.V AS SELECT 1 AS One')
    const firstId = peekModelContext(first)!.documentId
    await f.hover.provideHover(first, position, token())
    await f.hover.provideHover(first, position, token())
    expect(peek.willDisposeListeners(peek.models[0]!)).toBe(1)
    expect(bookkeeping(f.service).peekModels.has(firstId)).toBe(true)
    // Another object: Peek disposes the first model, and the service closes its document at once.
    const second = peek.show('2', 'CREATE VIEW dbo.W AS SELECT 2 AS Two')
    const secondId = peekModelContext(second)!.documentId
    expect(secondId).not.toBe(firstId)
    expect(f.api.languageClose).toHaveBeenCalledWith(firstId)
    expect(peek.willDisposeListeners(peek.models[0]!)).toBe(0)
    for (const map of Object.values(bookkeeping(f.service))) expect(map.has(firstId)).toBe(false)
    // A disposed model's late request is not served.
    expect(await f.hover.provideHover(first, position, token())).toBeNull()
    // A model never asked about is never opened, so closing it sends nothing.
    peek.editor.keep(undefined)
    expect(f.api.languageClose.mock.calls.map(([id]) => id)).toEqual([firstId])
    // The view closes after a hover: its last model closes too, and nothing is left.
    const third = peek.show('3', 'CREATE VIEW dbo.X AS SELECT 3 AS Three')
    const thirdId = peekModelContext(third)!.documentId
    await f.hover.provideHover(third, position, token())
    peek.editor.dispose()
    expect(f.api.languageClose.mock.calls.map(([id]) => id)).toEqual([firstId, thirdId])
    for (const map of Object.values(bookkeeping(f.service))) expect(map.size).toBe(0)
  })

  it('keeps Peek hovers still in flight from taking the request slots query tabs need', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const replies: ReturnType<typeof deferred<Awaited<ReturnType<VariaApi['languageHover']>>>>[] = []
    f.api.languageHover.mockImplementation(() => { const reply = deferred<Awaited<ReturnType<VariaApi['languageHover']>>>(); replies.push(reply); return reply.promise })
    // A slow server: each Peek hover hangs, and the user moves on (another object, Back, F5), so each is cancelled and its
    // model disposed while its IPC is still pending.
    const hovers: Promise<unknown>[] = []
    for (let index = 0; index < pendingLimits.documents + 2; index++) {
      const model = peek.show(String(index), `CREATE VIEW dbo.V${index} AS SELECT ${index} AS N`)
      const cancel = cancellationSource()
      hovers.push(Promise.resolve(f.hover.provideHover(model, position, cancel.token)))
      await Promise.resolve()
      cancel.cancel()
    }
    await landed(() => expect(f.api.languageHover).toHaveBeenCalledTimes(pendingLimits.peek))
    // Peek's own cap holds: the rest never reached the backend.
    expect(f.api.languageHover).toHaveBeenCalledTimes(pendingLimits.peek)
    // A query tab still gets completion and hover.
    const tab = f.documents.create('query.sql', 'SELECT Cus', 'master')
    expect((await f.complete(tab.id)).suggestions.map(item => labelText(item.label))).toEqual(['Customer'])
    const queryHover = f.getHover(tab.id)
    await landed(() => expect(f.api.languageHover).toHaveBeenCalledTimes(pendingLimits.peek + 1))
    replies.at(-1)!.resolve({ ok: true, value: { contents: 'Customer table' } })
    expect(await queryHover).toMatchObject({ contents: [{ value: 'Customer table' }] })
    // Once Peek's requests settle, a new Peek model is served again.
    for (const reply of replies.slice(0, pendingLimits.peek)) reply.resolve({ ok: true, value: null })
    await Promise.all(hovers)
    const next = peek.show('next', 'CREATE VIEW dbo.Next AS SELECT 1 AS N')
    const nextHover = f.hover.provideHover(next, position, token())
    await landed(() => expect(f.api.languageHover).toHaveBeenCalledTimes(pendingLimits.peek + 2))
    replies.at(-1)!.resolve({ ok: true, value: { contents: 'Next' } })
    expect(await nextHover).toMatchObject({ contents: [{ value: 'Next' }] })
  })

  it('drops a hover still in flight when Peek moves on, and closes the document again once that request settles', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const first = peek.show('1', 'CREATE VIEW dbo.V AS SELECT 1 AS One')
    const id = peekModelContext(first)!.documentId
    const reply = deferred<Awaited<ReturnType<VariaApi['languageHover']>>>()
    f.api.languageHover.mockReturnValueOnce(reply.promise)
    const hover = f.hover.provideHover(first, position, token())
    await landed(() => expect(f.api.languageHover).toHaveBeenCalledOnce())
    peek.show('2', 'CREATE VIEW dbo.W AS SELECT 2 AS Two')
    expect(f.api.languageClose).toHaveBeenCalledWith(id)
    reply.resolve({ ok: true, value: { contents: 'stale' } })
    expect(await hover).toBeNull()
    // The close raced the request, so it goes again once the request is done, as for a closed query.
    await landed(() => expect(f.api.languageClose.mock.calls.map(([closed]) => closed)).toEqual([id, id]))
    for (const map of Object.values(bookkeeping(f.service))) expect(map.has(id)).toBe(false)
  })

  it('closes a Peek document when its connection is reconnected, and opens it again on the new connection', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const model = peek.show('1', 'CREATE VIEW dbo.V AS SELECT 1 AS One')
    const id = peekModelContext(model)!.documentId
    await f.hover.provideHover(model, position, token())
    // Reconnect: the old generation's connection is lost, and a new one takes its place under the same id.
    f.connections.markLostBefore(2)
    f.connections.replace(peekConnection, { id: peekConnection, providerId: 'sqlserver', generation: 2, server: peekConnection, database: 'master', serverVersion: 'test' },
      { server: peekConnection, database: 'master', authentication: 'windows', trustServerCertificate: false })
    expect(f.api.languageClose.mock.calls.map(([closed]) => closed)).toEqual([id])
    // The same model is served again under the same id, on the new connection's binding.
    expect(await f.hover.provideHover(model, position, token())).toMatchObject({ contents: [{ value: 'Customer table' }] })
    expect(f.api.languageHover).toHaveBeenCalledTimes(2)
    expect(f.api.languageHover.mock.calls[1]![0]).toMatchObject({ documentId: id, context: { connectionId: peekConnection, database: 'Sales' } })
    expect(bookkeeping(f.service).contexts.has(id)).toBe(true)
    // Disposing it afterwards closes the reopened document too.
    peek.editor.keep(undefined)
    await landed(() => expect(f.api.languageClose.mock.calls.map(([closed]) => closed)).toEqual([id, id]))
    for (const map of Object.values(bookkeeping(f.service))) expect(map.has(id)).toBe(false)
  })

  it('stops serving a Peek model whose connection is lost, and closes what it opened', async () => {
    const f = await fixture()
    f.addConnection(peekConnection)
    const peek = peekFixture()
    cleanups.push(() => peek.editor.dispose())
    const model = peek.show('1', 'CREATE VIEW dbo.V AS SELECT 1 AS One')
    const id = peekModelContext(model)!.documentId
    await f.hover.provideHover(model, position, token())
    f.connections.markLostBefore(2)
    expect(f.api.languageClose).toHaveBeenCalledWith(id)
    expect(await f.hover.provideHover(model, position, token())).toBeNull()
    expect(f.api.languageHover).toHaveBeenCalledOnce()
  })

  it('R5 D1 #1: rejects definition() with Split-view guidance in Cross-Engine File mode instead of connectFirst', async () => {
    const f = await fixture()
    f.addConnection('sql-1')
    f.addConnection('bq-1', 'bigquery')
    const tab = f.documents.openMultiQuery({
      mode: 'cross',
      crossView: 'file',
      name: 'Cross.sql',
      sql: 'SELECT * FROM dbo.Customer',
      bigQuerySql: 'SELECT 1',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'Sales', enabled: true },
        { connectionId: 'bq-1', provider: 'bigquery', database: 'analytics', enabled: true }
      ]
    })

    await expect(f.service.definition(f.model(tab.id), position)).rejects.toThrow('Switch to Split view for per-dialect IntelliSense and syntax checking.')
    expect(f.api.languageDefinition).not.toHaveBeenCalled()

    // Switching back to Split view restores Go to Definition on the SQL Server pane.
    expect(f.documents.setCrossView(tab.id, 'split')).toEqual({ ok: true })
    const found: LanguageDefinition = { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range: { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } } }
    f.api.languageDefinition.mockResolvedValueOnce({ ok: true, value: found })
    expect(await f.service.definition(f.model(tab.id), { lineNumber: 1, column: 20 } as Monaco.Position)).toEqual({ connectionId: 'sql-1', definition: found })
    expect(f.api.languageDefinition).toHaveBeenCalledOnce()
    expect(f.api.languageDefinition.mock.calls[0]![0]).toMatchObject({ context: { connectionId: 'sql-1', database: 'Sales' } })
  })
})

describe('SQL Server lazy schema preview drawer (resolveCompletionItem)', () => {
  it('enriches SQL Server table completion items from local IndexLookup via language.lookup with PK/UK/Identity, indexes, and FKs', async () => {
    const f = await fixture()
    f.addConnection('sql-1')
    const tab = f.documents.create('q.sql', 'SELECT * FROM dbo.Ord', 'SalesDB', 'sql-1')
    f.api.languageComplete.mockResolvedValueOnce({
      ok: true,
      value: {
        isIncomplete: false,
        items: [
          { label: '[Orders]', kind: 7, detail: 'Table', filterText: 'Orders', insertText: '[Orders]' },
          { label: 'ORDER', kind: 14, detail: 'Keyword' }
        ]
      }
    })
    f.api.languageLookup.mockResolvedValueOnce({
      ok: true,
      value: {
        index: 'ready',
        answers: [{
          state: 'ready',
          path: ['SalesDB', 'dbo', 'Orders'],
          truncated: false,
          object: { name: 'Orders', kind: 'table', detailed: true },
          items: [
            { name: 'OrderId', kind: 'column', type: 'int', nullable: false, detail: 'PK · IDENTITY' },
            { name: 'CustomerId', kind: 'column', type: 'int', nullable: false, detail: 'FK' },
            { name: 'PK_Orders', kind: 'key', subtype: 'primary', detail: '(OrderId)' },
            { name: 'IX_Orders_Customer', kind: 'index', subtype: 'nonclustered', detail: '(CustomerId)' },
            { name: 'FK_Orders_Customers', kind: 'foreignKey', subtype: 'outgoing', detail: '(CustomerId) → dbo.Customers(Id)' }
          ]
        }]
      }
    })

    const list = await f.complete(tab.id, { lineNumber: 1, column: 22 } as Monaco.Position)
    const orders = list.suggestions.find(s => (typeof s.label === 'string' ? s.label : s.label.label) === '[Orders]')!
    const keyword = list.suggestions.find(s => (typeof s.label === 'string' ? s.label : s.label.label) === 'ORDER')!

    const resolved = (await f.completion.resolveCompletionItem!(orders, token()))!
    expect(f.api.languageLookup).toHaveBeenCalledWith({
      connectionId: 'sql-1',
      requests: [{ path: ['SalesDB', 'dbo', 'Orders'], limit: 2000, details: true }]
    })
    expect(resolved.documentation).toMatchObject({ isTrusted: false, supportHtml: false })
    const md = (resolved.documentation as Monaco.IMarkdownString).value
    expect(md).toContain('**dbo\\.Orders** · Table')
    expect(md).toContain('\\[SalesDB\\]\\.\\[dbo\\]\\.\\[Orders\\]')
    expect(md).toContain('| OrderId | int · NOT NULL · PK · IDENTITY |')
    expect(md).toContain('FK\\_Orders\\_Customers'.replace('FK\\_Orders\\_Customers', '→ \\(CustomerId\\) → dbo\\.Customers\\(Id\\)'))

    // Second resolve hits LookupCache (0 extra IPC calls); keywords are never looked up.
    await f.completion.resolveCompletionItem!(orders, token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(1)
    expect(await f.completion.resolveCompletionItem!(keyword, token())).toBe(keyword)
    expect(f.api.languageLookup).toHaveBeenCalledTimes(1)

    // Refresh Local Cache invalidates the SQL Server lookup cache.
    await f.service.refreshCache(tab.id)
    f.api.languageLookup.mockResolvedValueOnce({
      ok: true,
      value: { index: 'ready', answers: [{ state: 'absent', path: ['SalesDB', 'dbo', 'Orders'], items: [], truncated: false }] }
    })
    const afterRefresh = await f.completion.resolveCompletionItem!(orders, token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(2)
    expect(afterRefresh).toBe(orders)
  })

  it('preserves existing provider documentation, filters non-object/mismatched kinds, splits bracketed/dotted/db.. names, and invalidates on indexState updates', async () => {
    const f = await fixture()
    f.addConnection('sql-1')
    type IndexStateSnap = { readonly indexes: Readonly<Record<string, { readonly requestId?: string; readonly status?: { readonly state: 'none' | 'building' | 'ready'; readonly builtAt?: string; readonly databases: number; readonly indexed: number; readonly objects: number; readonly modules: number; readonly cut: number; readonly skipped: readonly { readonly database: string; readonly code: string; readonly message: string }[]; readonly definitions: boolean } }>> }
    class MutableIndexStateStore extends SnapshotStore<IndexStateSnap> {
      set(next: IndexStateSnap): void { this.publish(next) }
    }
    const indexState = new MutableIndexStateStore({ indexes: {} })
    f.service.bindIndexState(indexState)

    const tab = f.documents.create('q2.sql', 'SELECT * FROM OtherDB..Ord', 'SalesDB', 'sql-1')
    f.api.languageComplete.mockResolvedValueOnce({
      ok: true,
      value: {
        isIncomplete: false,
        items: [
          { label: '[Orders]', kind: 7, detail: 'Table', documentation: 'Orders extended doc', insertText: '[Orders]' },
          { label: 'dbo', kind: 9, detail: 'Schema', documentation: 'Schema doc' },
          { label: 'PlainText', kind: 1, documentation: 'Text doc' },
          { label: 'MyEvent', kind: 23, documentation: 'Event doc' },
          { label: 'Orders', kind: 3, detail: 'Function', documentation: 'Built-in function doc' }
        ]
      }
    })
    f.api.languageLookup.mockResolvedValue({
      ok: true,
      value: {
        index: 'ready',
        answers: [{
          state: 'ready',
          path: ['OtherDB', 'dbo', 'Orders'],
          truncated: false,
          object: { name: 'Orders', kind: 'table', detailed: true },
          items: [{ name: 'Id', kind: 'column', type: 'int', nullable: false, detail: 'PK' }]
        }]
      }
    })

    const list = await f.complete(tab.id, { lineNumber: 1, column: 27 } as Monaco.Position)
    const byLabel = (name: string) => list.suggestions.find(s => (typeof s.label === 'string' ? s.label : s.label.label) === name)!

    // db..table qualifier resolves against OtherDB with schema '*', and preserves existing provider documentation.
    const resolved = (await f.completion.resolveCompletionItem!(byLabel('[Orders]'), token()))!
    expect(f.api.languageLookup).toHaveBeenCalledWith({
      connectionId: 'sql-1',
      requests: [{ path: ['OtherDB', '*', 'Orders'], limit: 2000, details: true }]
    })
    const md = (resolved.documentation as Monaco.IMarkdownString).value
    expect(md).toContain('**dbo\\.Orders** · Table')
    expect(md).toContain('---')
    expect(md).toContain('Orders extended doc')

    // Non-object kinds (1 Text, 9 Module, 23 Event) are skipped; kind 3 Function never clobbers when IndexLookup returns a table.
    expect(await f.completion.resolveCompletionItem!(byLabel('dbo'), token())).toBe(byLabel('dbo'))
    expect(await f.completion.resolveCompletionItem!(byLabel('PlainText'), token())).toBe(byLabel('PlainText'))
    expect(await f.completion.resolveCompletionItem!(byLabel('MyEvent'), token())).toBe(byLabel('MyEvent'))
    const fnItem = byLabel('Orders')
    expect(await f.completion.resolveCompletionItem!(fnItem, token())).toBe(fnItem)
    expect(fnItem.documentation).toBe('Built-in function doc')

    // Bracketed multi-part labels (`[dbo].[Orders]`) and dotted table names (`[Sales.Orders]`) split before unquoting.
    const tabMulti = f.documents.create('q3.sql', 'SELECT * FROM ', 'SalesDB', 'sql-1')
    f.api.languageComplete.mockResolvedValueOnce({
      ok: true,
      value: {
        isIncomplete: false,
        items: [
          { label: '[dbo].[Orders]', kind: 7 },
          { label: '[Sales.Orders]', kind: 7, filterText: 'Sales.Orders' }
        ]
      }
    })
    const multiList = await f.complete(tabMulti.id, { lineNumber: 1, column: 15 } as Monaco.Position)
    const callsBefore = f.api.languageLookup.mock.calls.length
    await f.completion.resolveCompletionItem!(multiList.suggestions[0], token())
    await f.completion.resolveCompletionItem!(multiList.suggestions[1], token())
    expect(f.api.languageLookup.mock.calls[callsBefore][0]).toEqual({
      connectionId: 'sql-1',
      requests: [{ path: ['SalesDB', 'dbo', 'Orders'], limit: 2000, details: true }]
    })
    expect(f.api.languageLookup.mock.calls[callsBefore + 1][0]).toEqual({
      connectionId: 'sql-1',
      requests: [{ path: ['SalesDB', '*', 'Sales.Orders'], limit: 2000, details: true }]
    })

    // Search Objects indexState update immediately clears lookupCaches for that connection.
    const callsAfterCache = f.api.languageLookup.mock.calls.length
    await f.completion.resolveCompletionItem!(multiList.suggestions[0], token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(callsAfterCache)
    indexState.set({
      indexes: {
        'sql-1': { status: { state: 'ready', builtAt: '2026-11-27T12:00:00Z', databases: 1, indexed: 1, objects: 5, modules: 0, cut: 0, skipped: [], definitions: true } }
      }
    })
    await f.completion.resolveCompletionItem!(multiList.suggestions[0], token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(callsAfterCache + 1)
  })

  it('registers @ trigger character and ranks !-prefixed FK JOIN ON suggestions ahead of individual columns', async () => {
    const f = await fixture()
    expect(f.completion.triggerCharacters).toEqual(['.', '@'])
    const tab = f.documents.create('fk.sql', 'SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON ', 'SalesDB')
    f.api.languageComplete.mockResolvedValueOnce({
      ok: true,
      value: {
        isIncomplete: false,
        items: [
          { label: 'o.[CustomerId]', kind: 5, filterText: 'CustomerId', sortText: '010000:CustomerId' },
          { label: 'o.[CustomerId] = c.[Id]', kind: 10, detail: 'FK · fk_orders_customers', sortText: '!00:o.[CustomerId] = c.[Id]', filterText: 'o.[CustomerId] = c.[Id]' }
        ]
      }
    })
    const list = await f.complete(tab.id, { lineNumber: 1, column: 52 } as Monaco.Position)
    const sorted = [...list.suggestions].sort((a, b) => (a.sortText! < b.sortText! ? -1 : a.sortText! > b.sortText! ? 1 : 0))
    expect(labelText(sorted[0].label)).toBe('o.[CustomerId] = c.[Id]')
    expect(labelText(sorted[1].label)).toBe('o.[CustomerId]')
  })

  it('re-queries cross-DB FROM jump when 0-1 char response is incomplete, excludes CTEs/built-ins from lookup, and syncs index status on Ctrl+Shift+R', async () => {
    const f = await fixture()
    f.addConnection('sql-1')
    const syncStatus = vi.fn()
    const indexState = new SnapshotStore<{ readonly indexes: Readonly<Record<string, IndexStateEntry | undefined>> }>({ indexes: {} })
    f.service.bindIndexState(Object.assign(indexState, { syncStatus }))

    // 1. Multi-keystroke FROM jump: initial 0-char completion returns isIncomplete: true, so typing `Da` re-queries backend!
    const jumpTab = f.documents.create('jump.sql', 'SELECT * FROM ', 'SalesDB', 'sql-1')
    f.api.languageComplete
      .mockResolvedValueOnce({ ok: true, value: { isIncomplete: true, items: [{ label: '[dbo].[Orders]', kind: 7, filterText: 'Orders' }] } })
      .mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [{ label: '[AnalyticsDB].[dbo].[DailyRevenue]', kind: 7, detail: 'Table', filterText: 'DailyRevenue' }] } })
    const first = await f.complete(jumpTab.id, { lineNumber: 1, column: 15 } as Monaco.Position)
    expect(first.incomplete).toBe(true)
    const model = f.model(jumpTab.id)
    model.applyEdits([{ range: { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 15 }, text: 'Da' }])
    const second = await f.completion.provideCompletionItems(model, { lineNumber: 1, column: 17 } as Monaco.Position, { triggerKind: 2 }, token()) as Monaco.languages.CompletionList
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    expect(second.suggestions.some(s => labelText(s.label) === '[AnalyticsDB].[dbo].[DailyRevenue]')).toBe(true)

    // 2. CTE shadowing physical table & built-in T-SQL function shadowing UDF must NOT fire language.lookup!
    const shadowTab = f.documents.create('shadow.sql', 'WITH Orders AS (SELECT 1 AS a) SELECT ', 'SalesDB', 'sql-1')
    f.api.languageLookup.mockResolvedValue({
      ok: true,
      value: {
        index: 'ready',
        answers: [{
          state: 'ready',
          path: ['SalesDB', 'dbo', 'Orders'],
          truncated: false,
          object: { name: 'Orders', kind: 'table', detailed: true },
          items: [{ name: 'Id', kind: 'column', type: 'int', nullable: false, detail: 'PK' }]
        }]
      }
    })
    f.api.languageComplete.mockResolvedValueOnce({
      ok: true,
      value: {
        isIncomplete: false,
        items: [
          { label: 'Orders', kind: 7, detail: 'CTE' },
          { label: 'FORMAT', kind: 3, detail: 'Function · nvarchar', documentation: 'Built-in FORMAT docs' },
          { label: '[dbo].[Orders]', kind: 7, detail: 'Table · SalesDB.dbo' },
          { label: '[dbo].[fn_ActiveOrders]', kind: 3, detail: 'Function · SalesDB.dbo' }
        ]
      }
    })
    const shadowList = await f.complete(shadowTab.id, { lineNumber: 1, column: 39 } as Monaco.Position)
    const lookupBefore = f.api.languageLookup.mock.calls.length
    const cteItem = shadowList.suggestions.find(s => labelText(s.label) === 'Orders')!
    const builtinItem = shadowList.suggestions.find(s => labelText(s.label) === 'FORMAT')!
    const tableItem = shadowList.suggestions.find(s => labelText(s.label) === '[dbo].[Orders]')!
    const tvfItem = shadowList.suggestions.find(s => labelText(s.label) === '[dbo].[fn_ActiveOrders]')!
    await f.completion.resolveCompletionItem!(cteItem, token())
    await f.completion.resolveCompletionItem!(builtinItem, token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(lookupBefore)
    expect(builtinItem.documentation).toBe('Built-in FORMAT docs')
    await f.completion.resolveCompletionItem!(tableItem, token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(lookupBefore + 1)
    await f.completion.resolveCompletionItem!(tvfItem, token())
    expect(f.api.languageLookup).toHaveBeenCalledTimes(lookupBefore + 2)
    expect(f.api.languageLookup.mock.calls.at(-1)![0]).toEqual({
      connectionId: 'sql-1',
      requests: [{ path: ['SalesDB', 'dbo', 'fn_ActiveOrders'], limit: 2000, details: true }]
    })

    // 3. Ctrl+Shift+R (refreshCache) calls indexState.syncStatus(connectionId) so popover updates from Not built to Ready.
    const refreshed = await f.service.refreshCache(shadowTab.id)
    expect(refreshed).toBe(true)
    expect(syncStatus).toHaveBeenCalledWith(shadowTab.connectionId)
  })

  it('retries empty completion and null hover at most once during initial index build, skips retry once ready, and honors cancellation', async () => {
    const f = await fixture()
    f.addConnection('sql-1')
    type Snap = { readonly indexes: Readonly<Record<string, IndexStateEntry | undefined>> }
    const backing = new SnapshotStore<Snap>({ indexes: { 'sql-1': { requestId: 'build-1' } } })
    const waiters: (() => void)[] = []
    let subCount = 0
    const indexState = {
      getSnapshot: () => backing.getSnapshot(),
      subscribe: (listener: () => void) => {
        subCount++
        const unsub = backing.subscribe(listener)
        for (const wake of waiters.splice(0)) wake()
        return () => { subCount--; unsub() }
      },
      set: (next: Snap) => { (backing as unknown as { publish(s: Snap): void }).publish(next) },
      waitForStepSubscriber: () => subCount >= 2 ? Promise.resolve() : new Promise<void>(resolve => { waiters.push(resolve) })
    }
    f.service.bindIndexState(indexState)

    const tab = f.documents.create('initial.sql', 'SELECT d.database_ FROM sys.databases AS d;', 'master', 'sql-1')

    // 1. Completion during initial build (requestId set, no status): retries once when index state steps forward.
    f.api.languageComplete
      .mockResolvedValueOnce({ ok: true, value: { isIncomplete: true, items: [] } })
      .mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [{ label: '[database_id]', kind: 5, filterText: 'database_id' }] } })
    const compPromise = f.complete(tab.id, { lineNumber: 1, column: 19 } as Monaco.Position)
    await indexState.waitForStepSubscriber()
    indexState.set({ indexes: { 'sql-1': { requestId: 'build-1', status: undefined } } })
    const comp = await compPromise
    expect(f.api.languageComplete).toHaveBeenCalledTimes(2)
    expect(comp.suggestions.some(s => labelText(s.label) === '[database_id]')).toBe(true)

    // 1b. Non-empty `isIncomplete: false` result while initial build is still running is NOT cached in `completionCache`.
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [{ label: '[database_id]', kind: 5, filterText: 'database_id' }] } })
    const retriggered = await f.completion.provideCompletionItems(
      f.model(tab.id),
      { lineNumber: 1, column: 19 } as Monaco.Position,
      { triggerKind: 2 },
      token()
    ) as Monaco.languages.CompletionList
    expect(f.api.languageComplete).toHaveBeenCalledTimes(3)
    expect(retriggered.suggestions.some(s => labelText(s.label) === '[database_id]')).toBe(true)

    // 2. Hover during initial build: null first answer retries once when index state steps forward.
    f.api.languageHover
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({ ok: true, value: { contents: '**sys\\.databases** · View' } })
    const hoverPromise = f.hover.provideHover(f.model(tab.id), { lineNumber: 1, column: 30 } as Monaco.Position, token())
    await indexState.waitForStepSubscriber()
    indexState.set({
      indexes: {
        'sql-1': {
          status: { state: 'ready', databases: 1, indexed: 1, objects: 10, modules: 0, cut: 0, skipped: [], definitions: true }
        }
      }
    })
    const hov = await hoverPromise
    expect(f.api.languageHover).toHaveBeenCalledTimes(2)
    expect(hov?.contents[0]).toMatchObject({ value: '**sys\\.databases** · View' })

    // 3. Once index is ready (status present), empty completion and null hover do NOT retry.
    const compCallsBefore = f.api.languageComplete.mock.calls.length
    const hoverCallsBefore = f.api.languageHover.mock.calls.length
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: true, items: [] } })
    f.api.languageHover.mockResolvedValueOnce({ ok: true, value: null })
    const emptyReady = await f.complete(tab.id, { lineNumber: 1, column: 19 } as Monaco.Position)
    const nullReady = await f.hover.provideHover(f.model(tab.id), { lineNumber: 1, column: 30 } as Monaco.Position, token())
    expect(emptyReady.suggestions).toHaveLength(0)
    expect(nullReady).toBeNull()
    expect(f.api.languageComplete).toHaveBeenCalledTimes(compCallsBefore + 1)
    expect(f.api.languageHover).toHaveBeenCalledTimes(hoverCallsBefore + 1)

    // 4. Cancellation while waiting during initial build aborts cleanly without issuing a retry RPC.
    indexState.set({ indexes: { 'sql-1': { requestId: 'build-2' } } })
    const compCancelBefore = f.api.languageComplete.mock.calls.length
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: false, items: [] } })
    const cancelSource = cancellationSource()
    const cancelledComp = f.completion.provideCompletionItems(f.model(tab.id), { lineNumber: 1, column: 19 } as Monaco.Position, { triggerKind: 0 }, cancelSource.token)
    await indexState.waitForStepSubscriber()
    cancelSource.cancel()
    const cancelledResult = await cancelledComp as Monaco.languages.CompletionList
    expect(cancelledResult.suggestions).toHaveLength(0)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(compCancelBefore + 1)

    // 5. Synchronous `onCancellationRequested` callback inside `waitForIndexStateStep` never throws TDZ and disposes cleanly.
    const syncCancelBefore = f.api.languageComplete.mock.calls.length
    let syncDisposed = false
    let syncCancelled = false
    const syncToken: Monaco.CancellationToken = {
      get isCancellationRequested() { return syncCancelled },
      onCancellationRequested: (listener: () => void) => {
        if (f.api.languageComplete.mock.calls.length > syncCancelBefore) {
          syncCancelled = true
          listener()
        }
        return { dispose: () => { syncDisposed = true } }
      }
    }
    f.api.languageComplete.mockResolvedValueOnce({ ok: true, value: { isIncomplete: true, items: [] } })
    const syncResult = await f.completion.provideCompletionItems(
      f.model(tab.id),
      { lineNumber: 1, column: 19 } as Monaco.Position,
      { triggerKind: 0 },
      syncToken
    ) as Monaco.languages.CompletionList
    expect(syncResult.suggestions).toHaveLength(0)
    expect(syncDisposed).toBe(true)
    expect(f.api.languageComplete).toHaveBeenCalledTimes(syncCancelBefore + 1)
  })
})
