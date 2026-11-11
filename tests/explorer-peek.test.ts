import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { explorerCatalogJson, maxBand, minBand } from '../src/shared/explorer/catalog'
import { isPeekKind, isPeekListTab, peekCatalogBlock, peekFacts, peekFormats, peekHas, peekKinds, peekLimits, peekLists, peekListsOf, peekSpecs, peekTabsOf, peekTabTitle, type PeekDefinitionResult, type PeekDependenciesResult, type PeekResult } from '../src/shared/explorer/peek'
import { explorerChildrenParamsSchema, peekDefinitionParamsSchema, peekDependenciesParamsSchema, peekParamsSchema } from '../src/shared/explorer/schema'
import { requestSchemas } from '../src/main/validation'
import { methodPolicies } from '../src/shared/ipc/methods'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { definitionLoading, PeekBoundary, PeekListView, Properties } from '../src/renderer/src/explorer/PeekCard'
import { formatPeekValue, placePeek, cardWidth } from '../src/renderer/src/explorer/peek-format'
import { copyableDefinition, PeekService, type PeekChange } from '../src/renderer/src/explorer/PeekService'
import { maxClipboardText, type ApiResult, type ExplorerChildrenResult, type QueryResult } from '../src/shared/contracts'
import { fakeResults, summary } from './fixtures/peek-results'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import type { ScriptingOptions } from '../src/shared/scripting/options'

const connectionId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222'
const node = (kind: 'table' | 'procedure' | 'login' | 'user', id = 1, name = 'Customer'): ExplorerMenuNode => ({
  id, connectionId, kind, label: name, lost: false,
  ref: { type: 'object', object: kind === 'login' ? { kind, name } : kind === 'user' ? { kind, database: 'Sales', name } : { kind, database: 'Sales', schema: 'dbo', name } }
})

describe('Peek catalogue', () => {
  it('describes each kind with distinct fact ids and labels, known formats, and bands the tree serves', () => {
    expect(peekKinds).toEqual(['table', 'view', 'procedure', 'function', 'index', 'trigger', 'databaseTrigger', 'serverTrigger', 'database', 'login', 'synonym', 'sequence', 'type', 'tableType'])
    for (const kind of peekKinds) {
      const facts = peekFacts(kind)
      expect(new Set(facts.map(fact => fact.id)).size, kind).toBe(facts.length)
      expect(new Set(facts.map(fact => fact.label)).size, kind).toBe(facts.length)
      for (const fact of facts) {
        expect(peekFormats, fact.id).toContain(fact.format)
        expect(fact.id, fact.id).toMatch(/^[a-z][A-Za-z]+$/)
        if (fact.since !== undefined) expect(fact.since > minBand && fact.since <= maxBand, fact.id).toBe(true)
      }
    }
    // Schema-scoped objects start as SSMS's General page does.
    for (const kind of ['table', 'view', 'procedure', 'function', 'synonym', 'sequence'] as const) expect(peekFacts(kind).slice(0, 4).map(fact => fact.id), kind).toEqual(['schema', 'created', 'modified', 'systemObject'])
    // Kinds with stored text read it from sys.sql_modules; Script As writes the others' definition.
    expect(peekKinds.filter(kind => peekSpecs[kind].definition === 'module')).toEqual(['view', 'procedure', 'function', 'trigger', 'databaseTrigger', 'serverTrigger'])
  })
  it('embeds the facts in reply order for the backend', () => {
    const embedded = JSON.parse(explorerCatalogJson()) as { peek: ReturnType<typeof peekCatalogBlock> }
    expect(embedded.peek).toEqual(JSON.parse(JSON.stringify(peekCatalogBlock())))
    expect(embedded.peek.kinds.find(kind => kind.kind === 'table')?.facts.find(fact => fact.id === 'ledger')).toEqual({ id: 'ledger', format: 'code', since: 16, optional: false })
    expect(embedded.peek.budgetMs).toBe(peekLimits.budgetMs)
  })
})

describe('explorer.peek requests', () => {
  it('accepts the kinds the catalogue describes and refuses any other kind or extra field', () => {
    const target = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' }
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, kind: 'procedure' } }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'login', name: 'sa' } }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'database', name: 'Sales' } }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'index', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Customer' }, name: 'PK_Customer' } }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'user', database: 'Sales', name: 'app' } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, schema: undefined } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, name: 'x'.repeat(129) } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target, extra: 1 }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId: 'nope', requestId, target }).success).toBe(false)
    expect(isPeekKind('index')).toBe(true)
    expect(isPeekKind('column')).toBe(false)
  })
  it('is validated by main, runs on the explorer lane within its deadline, and is cancellable', () => {
    expect(requestSchemas['explorer.peek']).toBe(peekParamsSchema)
    expect(methodPolicies['explorer.peek']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    // Room for a peek that waits for the connection's peek slot, then runs its whole budget.
    expect((methodPolicies['explorer.peek'] as { deadlineMs: number }).deadlineMs).toBeGreaterThanOrEqual(2 * peekLimits.budgetMs)
    expect(cancellableRequests('explorer.peek', { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' })).toBe('explorer')
  })
  it('reads a later page of a module kind\'s text, past the first code unit and below the longest text Peek reads, on the explorer lane and cancellable', () => {
    const target = { kind: 'procedure', database: 'Sales', schema: 'dbo', name: 'Customer' }
    const page = (change: Record<string, unknown>) => peekDefinitionParamsSchema.safeParse({ connectionId, requestId, target, offset: peekLimits.definitionPageChars, ...change }).success
    expect(page({})).toBe(true)
    expect(page({ target: { kind: 'serverTrigger', name: 't' } })).toBe(true)
    expect(page({ offset: peekLimits.definitionMaxChars - 1 })).toBe(true)
    expect(page({ target: { ...target, kind: 'table' } })).toBe(false)
    expect(page({ target: { kind: 'login', name: 'sa' } })).toBe(false)
    expect(page({ offset: 0 })).toBe(false)
    expect(page({ offset: 1.5 })).toBe(false)
    expect(page({ offset: peekLimits.definitionMaxChars })).toBe(false)
    expect(page({ offset: undefined })).toBe(false)
    expect(page({ extra: 1 })).toBe(false)
    expect(requestSchemas['explorer.peekDefinition']).toBe(peekDefinitionParamsSchema)
    expect(methodPolicies['explorer.peekDefinition']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    expect(cancellableRequests('explorer.peekDefinition', { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' })).toBe('explorer')
    // A page is at most 3 bytes a code unit as UTF-8: far under the protocol's 16 MiB reply.
    expect(peekLimits.definitionPageChars * 3).toBeLessThan(16 * 1024 * 1024 / 4)
  })
})

describe('Peek card layout and values', () => {
  const table = peekSpecs.table.groups.flatMap(group => group.facts)
  const fact = (id: string) => table.find(item => item.id === id)!
  it('formats facts as SSMS shows them', () => {
    expect(formatPeekValue(fact('created'), '2023-05-08T12:07:41')).toBe('2023-05-08 12:07')
    expect(formatPeekValue(fact('systemObject'), false)).toBe('False')
    expect(formatPeekValue(fact('rowCount'), 19820)).toBe('19,820')
    expect(formatPeekValue(fact('dataSpace'), 512)).toBe('512 KB')
    expect(formatPeekValue(fact('dataSpace'), 1640)).toBe('1.60 MB')
    expect(formatPeekValue(fact('filegroup'), null)).toBe('—')
    expect(formatPeekValue(fact('filegroup'), 'PRIMARY')).toBe('PRIMARY')
    expect(formatPeekValue(fact('temporal'), 'SYSTEM_VERSIONED_TEMPORAL_TABLE')).toBe('System versioned temporal table')
    expect(formatPeekValue(fact('compression'), 'PAGE')).toBe('Page')
    expect(formatPeekValue(fact('lockEscalation'), 'odd value')).toBe('odd value')
  })
  it('opens beside the pane on the side with room, level with the row, and inside the window', () => {
    const view = { width: 1600, height: 900 }
    expect(placePeek({ top: 300, height: 22 }, { left: 0, right: 300 }, view)).toEqual({ left: 308, top: 263, width: cardWidth, height: 480 })
    // Object Explorer docked on the right: the card goes to its left.
    expect(placePeek({ top: 300, height: 22 }, { left: 1300, right: 1600 }, view).left).toBe(1300 - 8 - cardWidth)
    // No room on either side: it overlaps, inside the window.
    const narrow = placePeek({ top: 880, height: 22 }, { left: 200, right: 500 }, { width: 1000, height: 600 })
    expect(narrow.left).toBe(1000 - 8 - cardWidth)
    expect(narrow.top + narrow.height).toBeLessThanOrEqual(600 - 8)
    // A row scrolled out of view keeps the card where it was.
    expect(placePeek(undefined, { left: 0, right: 300 }, view, { left: 308, top: 120 }).top).toBe(120)
  })
})

describe('PeekService', () => {
  const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
  function setup(platform = 'win32') {
    let resolvePeek: (value: ApiResult<PeekResult>) => void = () => {}
    let resolveScript: (value: ApiResult<{ text?: string; database: string; warnings: string[]; commands: number; elapsedMs: number }>) => void = () => {}
    const pages: ((value: ApiResult<PeekDefinitionResult>) => void)[] = []
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { resolvePeek = resolve })),
      explorerPeekDefinition: vi.fn((_params: { requestId: string; offset: number }) => new Promise<ApiResult<PeekDefinitionResult>>(resolve => { pages.push(resolve) })),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(resolve => { resolveScript = resolve as never })),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    let live = [{ id: connectionId }]
    const listeners = new Set<() => void>()
    const connections = { getSnapshot: () => live, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const timers: { callback?: () => void; ms?: number } = {}
    let ids = 0
    const service = new PeekService({
      api: api as never, connections, scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: (callback, ms) => { timers.callback = callback; timers.ms = ms; return 1 }, clearTimeout: () => { timers.callback = undefined } },
      newId: () => `id-${++ids}`, platform
    })
    return { service, api, timers, pages, resolvePeek: (value: ApiResult<PeekResult>) => resolvePeek(value), resolveScript: (text: string) => resolveScript(ok({ text, database: 'Sales', warnings: [], commands: 1, elapsedMs: 1 })),
      lose: () => { live = []; for (const listener of listeners) listener() } }
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it('reads a module\'s facts and text in one request', async () => {
    const { service, api, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    expect(api.explorerPeek).toHaveBeenCalledWith({ connectionId, requestId: 'id-1', target: { kind: 'procedure', database: 'Sales', schema: 'dbo', name: 'Customer' } })
    expect(api.scriptObjects).not.toHaveBeenCalled()
    expect(service.getSnapshot().open).toMatchObject({ kind: 'procedure', source: 'menu', facts: { status: 'loading' }, definition: { status: 'loading' } })
    resolvePeek(ok({ facts: { schema: 'dbo', executeAs: 'CALLER' }, definition: 'CREATE PROCEDURE dbo.Customer AS SELECT 1', elapsedMs: 3 }))
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ facts: { status: 'ready', value: { executeAs: 'CALLER' } }, definition: { status: 'ready', value: { text: 'CREATE PROCEDURE dbo.Customer AS SELECT 1' } } })
    await service.copyDefinition()
    expect(api.writeClipboardText).toHaveBeenCalledWith('CREATE PROCEDURE dbo.Customer AS SELECT 1')
  })
  it('scripts a table\'s CREATE and shows a failure as a value', async () => {
    const { service, api, resolvePeek, resolveScript } = setup()
    service.peek(node('table'), 'keyboard')
    expect(api.scriptObjects).toHaveBeenCalledWith(expect.objectContaining({ connectionId, requestId: 'id-2', verb: 'create', targets: [{ kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' }] }))
    resolvePeek(ok({ facts: {}, elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'dbo.Customer was not found.', retryable: false } }))
    resolveScript('CREATE TABLE [dbo].[Customer]')
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ facts: { status: 'error', message: 'dbo.Customer was not found.' }, definition: { status: 'ready', value: { text: 'CREATE TABLE [dbo].[Customer]' } } })
  })
  it('cancels the reads still running when the card closes or another peek replaces it', async () => {
    const { service, api } = setup()
    service.peek(node('table', 1), 'menu')
    service.peek(node('procedure', 2, 'Ship'), 'menu')
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-1'])
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-2'])
    expect(service.getSnapshot().open?.rowId).toBe(2)
    service.close()
    expect(api.explorerCancel).toHaveBeenLastCalledWith(['id-3'])
    expect(service.getSnapshot().open).toBeUndefined()
  })
  it('drops an answer that comes after its card closed', async () => {
    const { service, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    service.close()
    resolvePeek(ok({ facts: { schema: 'dbo' }, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open).toBeUndefined()
  })
  it('opens on a Ctrl+hover only after the pointer rests, and never for other kinds', () => {
    const { service, api, timers } = setup()
    service.hover(node('user'))
    expect(timers.callback).toBeUndefined()
    service.hover(node('table'))
    expect(timers.ms).toBe(peekLimits.hoverMs)
    service.cancelHover()
    expect(timers.callback).toBeUndefined()
    service.hover(node('table'))
    timers.callback?.()
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().open?.source).toBe('hover')
    // Asking again from the keyboard keeps the read and focuses the card.
    service.peek(node('table'), 'keyboard')
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().open?.source).toBe('keyboard')
  })
  it('forgets a Ctrl+hover when Ctrl (⌘ on macOS) goes up before the card opens', () => {
    const { service, timers } = setup()
    service.hover(node('table'))
    service.keyUp('Meta')
    expect(timers.callback).toBeDefined()
    service.keyUp('Control')
    expect(timers.callback).toBeUndefined()
    const mac = setup('darwin')
    mac.service.hover(node('table'))
    mac.service.keyUp('Control')
    expect(mac.timers.callback).toBeDefined()
    mac.service.keyUp('Meta')
    expect(mac.timers.callback).toBeUndefined()
  })
  it('leaves a card the keyboard or the menu opened alone when Ctrl passes over another row', () => {
    const { service, api, timers } = setup()
    service.peek(node('table', 1), 'keyboard')
    service.hover(node('procedure', 2, 'Ship'))
    expect(timers.callback).toBeUndefined()
    expect(service.getSnapshot().open).toMatchObject({ rowId: 1, source: 'keyboard' })
    // A hover card gives way to the next row the pointer rests on.
    service.close()
    service.hover(node('table', 1))
    timers.callback?.()
    service.hover(node('procedure', 2, 'Ship'))
    timers.callback?.()
    expect(service.getSnapshot().open).toMatchObject({ rowId: 2, source: 'hover' })
    expect(api.explorerPeek).toHaveBeenCalledTimes(3)
  })
  it('reads a long module\'s text in pages, one at a time from where the last ended, and shows and copies it only once it is whole', async () => {
    const { service, api, pages, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    resolvePeek(ok({ facts: { schema: 'dbo' }, definition: 'CREATE PROC', definitionLength: 26, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ facts: { status: 'ready' }, definition: { status: 'loading', progress: 11 / 26 } })
    expect(definitionLoading(11 / 26)).toBe('Loading the definition… 42%')
    expect(definitionLoading()).toBe('Loading the definition…')
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(1)
    expect(api.explorerPeekDefinition).toHaveBeenLastCalledWith({ connectionId, requestId: 'id-2', target: { kind: 'procedure', database: 'Sales', schema: 'dbo', name: 'Customer' }, offset: 11 })
    await service.copyDefinition()
    expect(api.writeClipboardText).not.toHaveBeenCalled()
    pages[0]!(ok({ text: 'EDURE dbo.', length: 26, stamp: 7, elapsedMs: 1 }))
    await flush()
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(2)
    expect(api.explorerPeekDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'id-3', offset: 21 }))
    expect(service.getSnapshot().open?.definition).toEqual({ status: 'loading', progress: 21 / 26 })
    // A page shorter than a whole page (one that ended before a split pair) only moves the next offset along.
    pages[1]!(ok({ text: 'C AS', length: 26, stamp: 7, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open?.definition).toMatchObject({ status: 'loading' })
    expect(api.explorerPeekDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 }))
    pages[2]!(ok({ text: '1', length: 26, stamp: 7, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open?.definition).toEqual({ status: 'ready', value: { text: 'CREATE PROCEDURE dbo.C AS1' } })
    await service.copyDefinition()
    expect(api.writeClipboardText).toHaveBeenCalledWith('CREATE PROCEDURE dbo.C AS1')
    expect(api.explorerCancel).not.toHaveBeenCalled()
  })
  it('reads a long module only as far as a reader asks, telling the start with the whole length, even past what Peek reads', async () => {
    const { service, api, pages, resolvePeek } = setup()
    const target = { connectionId, object: { kind: 'procedure' as const, database: 'Sales', schema: 'dbo', name: 'Customer' }, kind: 'procedure' as const }
    const changes: PeekChange[] = []
    const reader = service.read(target, false, change => { changes.push(change) }, 15)
    resolvePeek(ok({ facts: {}, definition: 'CREATE PROC', definitionLength: 26, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    expect(changes.at(-1)).toEqual({ definition: { status: 'loading', progress: 11 / 14 } })
    pages[0]!(ok({ text: 'EDURE dbo.', length: 26, stamp: 7, elapsedMs: 1 }))
    await flush()
    expect(changes.at(-1)).toEqual({ definition: { status: 'ready', value: { text: 'CREATE PROCEDURE dbo.', length: 26 } } })
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(1)
    reader.release(false)
    // A first page as long as the reader wants asks for no more, nor one a code unit short of it (it ended before a pair it
    // would split); nor does a text longer than Peek reads, whose start shows.
    for (const [length, wants] of [[26, 5], [26, 12], [peekLimits.definitionMaxChars + 1, 5]] as const) {
      const told: PeekChange[] = []
      const short = service.read(target, false, change => { told.push(change) }, wants)
      resolvePeek(ok({ facts: {}, definition: 'CREATE PROC', definitionLength: length, definitionStamp: 7, elapsedMs: 1 }))
      await flush()
      expect(told.at(-1)).toEqual({ definition: { status: 'ready', value: { text: 'CREATE PROC', length } } })
      short.release(false)
    }
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(1)
  })
  it('cancels the page still being read when the card closes or moves on, and drops a late page', async () => {
    const { service, api, pages, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    resolvePeek(ok({ facts: {}, definition: 'CREATE', definitionLength: 12, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    service.close()
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-2'])
    pages[0]!(ok({ text: ' PROC', length: 12, stamp: 7, elapsedMs: 1 }))
    await flush()
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().open).toBeUndefined()
    // Another object replaces the read the same way.
    service.peek(node('procedure', 2, 'Ship'), 'menu')
    resolvePeek(ok({ facts: {}, definition: 'CREATE', definitionLength: 12, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    service.peek(node('procedure', 3, 'Bill'), 'menu')
    expect(api.explorerCancel).toHaveBeenLastCalledWith(['id-4'])
  })
  it('copies a whole definition only up to what the clipboard takes', async () => {
    expect(copyableDefinition('x'.repeat(maxClipboardText))).toBe(true)
    expect(copyableDefinition('x'.repeat(maxClipboardText + 1))).toBe(false)
    expect(copyableDefinition(undefined)).toBe(false)
    const { service, api, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    resolvePeek(ok({ facts: {}, definition: 'x'.repeat(maxClipboardText + 1), elapsedMs: 1 }))
    await flush()
    await service.copyDefinition()
    expect(api.writeClipboardText).not.toHaveBeenCalled()
  })
  it('keeps "not connected" on a tab whose server went while a page was read, instead of the cancelled page\'s answer', async () => {
    const { service, api, pages, resolvePeek, lose } = setup()
    const view = service.createView()
    view.show(node('procedure'))
    resolvePeek(ok({ facts: {}, definition: 'CREATE', definitionLength: 12, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    lose()
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-2'])
    expect(view.getSnapshot().open?.definition).toEqual({ status: 'error', message: 'The server is not connected.' })
    pages[0]!({ ok: false, error: 'The operation was cancelled.' })
    await flush()
    expect(view.getSnapshot().open?.definition).toEqual({ status: 'error', message: 'The server is not connected.' })
    expect(api.explorerPeekDefinition).toHaveBeenCalledTimes(1)
    view.dispose()
  })
  it('says the text changed when a page\'s length or stamp is not the first page\'s, shows a failed page as a value, and reads no text longer than Peek reads', async () => {
    const changed = async (page: Partial<PeekDefinitionResult>) => {
      const { service, pages, resolvePeek } = setup()
      service.peek(node('procedure'), 'menu')
      resolvePeek(ok({ facts: {}, definition: 'CREATE', definitionLength: 12, definitionStamp: 7, elapsedMs: 1 }))
      await flush()
      pages[0]!(ok({ text: ' PROC', length: 12, stamp: 7, elapsedMs: 1, ...page }))
      await flush()
      return service.getSnapshot().open?.definition
    }
    const message = 'The definition changed while Peek read it. Refresh to read it again.'
    expect(await changed({ stamp: 8 })).toEqual({ status: 'error', message })
    expect(await changed({ length: 13 })).toEqual({ status: 'error', message })
    expect(await changed({ text: undefined })).toEqual({ status: 'error', message })
    expect(await changed({ text: '' })).toEqual({ status: 'error', message })
    expect(await changed({ text: ' PROCEDURE  x' })).toEqual({ status: 'error', message })
    expect(await changed({ error: { code: 'NOT_FOUND', message: 'dbo.Customer was not found.', retryable: false } })).toEqual({ status: 'error', message: 'dbo.Customer was not found.' })
    const { service, api, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    resolvePeek(ok({ facts: {}, definition: 'CREATE', definitionLength: peekLimits.definitionMaxChars + 1, definitionStamp: 7, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open?.definition).toMatchObject({ status: 'error', message: expect.stringContaining('longer than Peek reads (134,217,728 characters)') })
    expect(api.explorerPeekDefinition).not.toHaveBeenCalled()
  })
  it('closes when its server disconnects, and refuses lost or disconnected nodes', () => {
    const { service, api, lose } = setup()
    expect(service.canPeek({ ...node('table'), lost: true })).toBe(false)
    service.peek(node('table'), 'menu')
    lose()
    expect(service.getSnapshot().open).toBeUndefined()
    service.peek(node('table'), 'menu')
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
  })
})

describe('PeekBoundary', () => {
  it('closes the peek when Object Explorer\'s pane goes away or the card fails to render, and draws again for the next peek', () => {
    const close = vi.fn()
    const boundary = new PeekBoundary({ peekId: 1, close, children: null })
    expect(PeekBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    boundary.componentDidCatch(new Error('render fault'))
    expect(close).toHaveBeenCalledTimes(1)
    report.mockRestore()
    boundary.state = { failed: true }
    const setState = vi.spyOn(boundary, 'setState').mockImplementation(() => {})
    boundary.componentDidUpdate({ peekId: 1 })
    expect(setState).not.toHaveBeenCalled()
    Object.assign(boundary, { props: { peekId: 2, close, children: null } })
    boundary.componentDidUpdate({ peekId: 1 })
    expect(setState).toHaveBeenCalledWith({ failed: false })
    boundary.componentWillUnmount()
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('PeekService script cache', () => {
  const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
  type ScriptReply = ApiResult<{ text?: string; database: string; warnings: string[]; commands: number; elapsedMs: number }>
  /** Every call's resolver, in order, so a test answers any request it chose. */
  function setup() {
    const peeks: ((value: ApiResult<PeekResult>) => void)[] = [], scripts: ((value: ScriptReply) => void)[] = []
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { peeks.push(resolve) })),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(resolve => { scripts.push(resolve as never) })),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    let live = [{ id: connectionId }]
    let options = { scriptExtendedProperties: true } as unknown as ScriptingOptions
    const clock = { now: 1_000_000 }
    const connectionListeners = new Set<() => void>(), optionListeners = new Set<() => void>()
    let ids = 0
    const service = new PeekService({
      api: api as never,
      connections: { getSnapshot: () => live, subscribe: listener => { connectionListeners.add(listener); return () => connectionListeners.delete(listener) } },
      // A fresh object per read, as the workbench's store gives, so only the values say whether the options changed.
      scriptingOptions: { getSnapshot: () => ({ options: { ...options } }), subscribe: listener => { optionListeners.add(listener); return () => optionListeners.delete(listener) } },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => `id-${++ids}`, now: () => clock.now
    })
    const facts = (index: number, modified: string) => peeks[index]!(ok({ facts: { schema: 'dbo', modified }, elapsedMs: 1 }))
    const script = (index: number, text: string) => scripts[index]!(ok({ text, database: 'Sales', warnings: [], commands: 1, elapsedMs: 1 }))
    const definition = () => { const part = service.getSnapshot().open?.definition; return part?.status === 'ready' ? part.value.text : part?.status }
    const announce = () => { for (const listener of optionListeners) listener() }
    return { service, api, facts, script, definition, clock, scriptsSent: () => scripts.length,
      lose: () => { live = []; for (const listener of connectionListeners) listener() },
      changeOptions: () => { options = { scriptExtendedProperties: false } as unknown as ScriptingOptions; announce() },
      changeOtherSetting: announce,
      kept: () => (service as unknown as { reads: { scripts: Map<string, unknown> } }).reads.scripts.size }
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it('lets a replaced card\'s table script finish, and reuses it while the table\'s modified time is unchanged', async () => {
    const { service, api, facts, script, definition, scriptsSent } = setup()
    service.peek(node('table', 1), 'hover')
    facts(0, '2024-01-02T03:04:05')
    await flush()
    // Replaced before its script came back: the script keeps running, so it can be kept.
    service.peek(node('procedure', 2, 'Ship'), 'hover')
    expect(api.cancelScripting).not.toHaveBeenCalled()
    script(0, 'CREATE TABLE [dbo].[Customer]')
    await flush()
    service.peek(node('table', 1), 'keyboard')
    expect(scriptsSent()).toBe(1)
    expect(definition()).toBe('loading')
    facts(2, '2024-01-02T03:04:05')
    await flush()
    expect(definition()).toBe('CREATE TABLE [dbo].[Customer]')
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
  })
  it('never keeps a login\'s script, whose role memberships and CONNECT permission its modified time misses', async () => {
    const { service, api, facts, script, definition } = setup()
    service.peek(node('login', 1, 'app'), 'keyboard')
    facts(0, '2024-01-02T03:04:05')
    script(0, 'CREATE LOGIN [app]')
    await flush()
    expect(definition()).toBe('CREATE LOGIN [app]')
    service.close()
    service.peek(node('login', 1, 'app'), 'keyboard')
    expect(api.scriptObjects).toHaveBeenCalledTimes(2)
  })
  it('scripts the table again when it changed, when its facts fail, and on Refresh', async () => {
    const { service, facts, script, definition, scriptsSent } = setup()
    service.peek(node('table', 1), 'menu')
    facts(0, '2024-01-02T03:04:05')
    script(0, 'CREATE TABLE v1')
    await flush()
    service.close()
    service.peek(node('table', 1), 'menu')
    facts(1, '2024-05-06T07:08:09')
    await flush()
    expect(scriptsSent()).toBe(2)
    script(1, 'CREATE TABLE v2')
    await flush()
    expect(definition()).toBe('CREATE TABLE v2')
    service.refresh()
    expect(scriptsSent()).toBe(3)
  })
  it('keeps at most backgroundScripts running for replaced cards, cancelling the oldest', async () => {
    const { service, api, facts } = setup()
    for (let index = 0; index <= peekLimits.backgroundScripts; index++) {
      service.peek(node('table', index + 1, `T${index}`), 'hover')
      facts(index, '2024-01-02T03:04:05')
      await flush()
    }
    service.close()
    // The first table's script (id-2) gave way to the newer ones.
    expect(api.cancelScripting).toHaveBeenCalledTimes(1)
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-2'])
  })
  it('cancels a replaced card\'s script whose facts are not in, and forgets kept scripts on disconnect or an options change', async () => {
    const { service, api, facts, script, scriptsSent, changeOptions } = setup()
    service.peek(node('table', 1), 'menu')
    service.peek(node('table', 2, 'Other'), 'menu')
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-2'])
    facts(1, '2024-01-02T03:04:05')
    script(1, 'CREATE TABLE [dbo].[Other]')
    await flush()
    changeOptions()
    service.close()
    service.peek(node('table', 2, 'Other'), 'menu')
    expect(scriptsSent()).toBe(3)
  })
  it('keeps its scripts when another setting changes, and never keeps one asked with options since changed', async () => {
    const { service, api, facts, script, changeOptions, changeOtherSetting, kept } = setup()
    service.peek(node('table', 1), 'menu')
    facts(0, '2024-01-02T03:04:05')
    script(0, 'CREATE TABLE a')
    await flush()
    service.peek(node('table', 2, 'Other'), 'hover')
    facts(1, '2024-01-02T03:04:05')
    await flush()
    service.peek(node('table', 3, 'Third'), 'menu')
    // The settings store announces every setting; only a Scripting change empties the cache and stops background scripts.
    changeOtherSetting()
    expect(kept()).toBe(1)
    expect(api.cancelScripting).not.toHaveBeenCalled()
    changeOptions()
    expect(kept()).toBe(0)
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-4'])
    // The open card's script, asked before the change, still shows but is not kept.
    facts(2, '2024-01-02T03:04:05')
    script(2, 'CREATE TABLE third WITH old options')
    await flush()
    expect(kept()).toBe(0)
  })
  it('takes over the script still running for a table the pointer comes back to', async () => {
    const { service, facts, script, definition, scriptsSent } = setup()
    service.peek(node('table', 1), 'hover')
    facts(0, '2024-01-02T03:04:05')
    await flush()
    service.peek(node('table', 2, 'Other'), 'hover')
    service.peek(node('table', 1), 'hover')
    expect(scriptsSent()).toBe(2)
    facts(2, '2024-01-02T03:04:05')
    script(0, 'CREATE TABLE [dbo].[Customer]')
    await flush()
    expect(definition()).toBe('CREATE TABLE [dbo].[Customer]')
    expect(scriptsSent()).toBe(2)
  })
  it('scripts again when a taken-over script began before the table changed', async () => {
    const { service, api, facts, scriptsSent } = setup()
    service.peek(node('table', 1), 'hover')
    facts(0, '2024-01-02T03:04:05')
    await flush()
    service.peek(node('table', 2, 'Other'), 'hover')
    service.peek(node('table', 1), 'hover')
    facts(2, '2024-05-06T07:08:09')
    await flush()
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-2'])
    expect(scriptsSent()).toBe(3)
  })
  it('lets a kept script expire, since the modified time misses some changes', async () => {
    const { service, facts, script, clock, scriptsSent } = setup()
    service.peek(node('table', 1), 'menu')
    facts(0, '2024-01-02T03:04:05')
    script(0, 'CREATE TABLE x')
    await flush()
    service.close()
    clock.now += peekLimits.scriptCacheMs + 1
    service.peek(node('table', 1), 'menu')
    expect(scriptsSent()).toBe(2)
  })
  it('drops what it kept for a server that disconnects', async () => {
    const { service, facts, script, scriptsSent, lose } = setup()
    service.peek(node('table', 1), 'menu')
    facts(0, '2024-01-02T03:04:05')
    script(0, 'CREATE TABLE x')
    await flush()
    lose()
    expect(service.getSnapshot().open).toBeUndefined()
    expect((service as unknown as { reads: { scripts: Map<string, unknown> } }).reads.scripts.size).toBe(0)
    expect(scriptsSent()).toBe(1)
  })
})

describe('Peek tabs', () => {
  const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
  function setup() {
    const results = fakeResults()
    const peeks: ((value: ApiResult<PeekResult>) => void)[] = []
    const children: ((value: ApiResult<ExplorerChildrenResult>) => void)[] = []
    const executes: ((value: ApiResult<QueryResult>) => void)[] = []
    const dependencies: ((value: ApiResult<PeekDependenciesResult>) => void)[] = []
    const api = {
      explorerPeekDependencies: vi.fn(() => new Promise<ApiResult<PeekDependenciesResult>>(resolve => { dependencies.push(resolve) })),
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { peeks.push(resolve) })),
      explorerChildren: vi.fn(() => new Promise<ApiResult<ExplorerChildrenResult>>(resolve => { children.push(resolve) })),
      tableColumns: vi.fn(async () => ok({ columns: [{ name: 'Id', dataType: 'int' }], truncated: false })),
      execute: vi.fn(() => new Promise<ApiResult<QueryResult>>(resolve => { executes.push(resolve) })),
      closeQuerySession: vi.fn(async () => ok({ closed: true })),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    let ids = 0
    const service = new PeekService({
      api: api as never, connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} }, newId: () => `id-${++ids}`, results
    })
    return { service, api, peeks, children, executes, dependencies, results, open: () => service.getSnapshot().open! }
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const facts = (extra: Partial<PeekResult> = {}): ApiResult<PeekResult> => ok({ facts: { schema: 'dbo', modified: '2024-01-02T03:04:05' }, elapsedMs: 1, ...extra })

  it('gives tables and views a Top rows tab and every kind Columns or Parameters and Dependencies, with no rows request of its own', () => {
    expect(peekTabsOf('table')).toEqual(['definition', 'members', 'dependencies', 'rows'])
    expect(peekTabsOf('view')).toEqual(['definition', 'members', 'dependencies', 'rows'])
    expect(peekTabsOf('procedure')).toEqual(['definition', 'members', 'dependencies'])
    expect([peekTabTitle('table', 'members'), peekTabTitle('function', 'members'), peekTabTitle('view', 'rows')]).toEqual(['Columns', 'Parameters', 'Top rows'])
    // Top rows runs through query.execute and the results port: explorer.peekRows is gone from main and the backend's catalogue.
    expect(Object.keys(requestSchemas)).not.toContain('explorer.peekRows')
    expect(Object.keys(methodPolicies)).not.toContain('explorer.peekRows')
    expect(requestSchemas['explorer.peekDependencies']).toBe(peekDependenciesParamsSchema)
    expect(methodPolicies['explorer.peekDependencies']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    expect(cancellableRequests('explorer.peekDependencies', { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' })).toBe('explorer')
    const embedded = JSON.parse(explorerCatalogJson()) as { peek: Record<string, unknown> & { kinds: Record<string, unknown>[] } }
    expect(Object.keys(embedded.peek).sort()).toEqual(['budgetMs', 'definitionMaxChars', 'definitionPageChars', 'dependencies', 'kinds', 'listRows', 'mappingDatabases'])
    expect(embedded.peek.kinds.every(kind => !('rows' in kind))).toBe(true)
  })
  it('reads dependencies apart from the properties, only once their tab is chosen, so that either can fail alone', async () => {
    const { service, api, peeks, dependencies, open } = setup()
    service.peek(node('procedure'), 'hover')
    peeks[0]!(facts())
    await flush()
    expect(api.explorerPeekDependencies).not.toHaveBeenCalled()
    expect(open()).toMatchObject({ tab: 'definition', facts: { status: 'ready' }, back: [] })
    expect(open().dependencies).toBeUndefined()
    service.selectTab('dependencies')
    expect(api.explorerPeekDependencies).toHaveBeenCalledWith({ connectionId, requestId: 'id-2', target: { kind: 'procedure', database: 'Sales', schema: 'dbo', name: 'Customer' } })
    // A login that may read the properties but not sys.sql_expression_dependencies keeps its properties.
    dependencies[0]!(ok({ uses: [], usedBy: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'denied', retryable: false } }))
    await flush()
    expect(open()).toMatchObject({ facts: { status: 'ready' }, dependencies: { status: 'error', message: 'denied' } })
    service.selectTab('dependencies')
    expect(api.explorerPeekDependencies).toHaveBeenCalledTimes(2)
    dependencies[1]!(ok({ uses: [{ name: 'Orders', schema: 'dbo', kind: 'table' }], usedBy: [], usedByTruncated: true, elapsedMs: 1 }))
    await flush()
    expect(open().dependencies).toEqual({ status: 'ready', value: { uses: [{ name: 'Orders', schema: 'dbo', kind: 'table' }], usesTruncated: false, usedBy: [], usedByTruncated: true } })
    service.selectTab('dependencies')
    expect(api.explorerPeekDependencies).toHaveBeenCalledTimes(2)
  })
  it('asks for the Columns of a subtyped table with a request the children schema accepts', () => {
    const { service, api } = setup()
    service.peek({ ...node('table'), subtype: 'systemVersioned' }, 'hover')
    service.selectTab('members')
    const [request] = api.explorerChildren.mock.calls[0] as unknown as [unknown]
    expect(explorerChildrenParamsSchema.safeParse({ ...(request as object), requestId }).success).toBe(true)
  })
  it('reads Columns or Parameters and Top rows only once their tab is chosen, and each once per card', async () => {
    const { service, api, children, executes, results, open } = setup()
    service.peek(node('table'), 'hover')
    expect(api.explorerChildren).not.toHaveBeenCalled()
    expect(api.execute).not.toHaveBeenCalled()
    service.selectTab('members')
    expect(api.explorerChildren).toHaveBeenCalledWith({ connectionId, requestId: 'id-3', node: { type: 'folder', owner: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' }, folder: 'columns' }, pageSize: peekLimits.members })
    const column = { ref: { type: 'object' as const, object: { kind: 'column' as const, database: 'Sales', parent: { kind: 'table' as const, schema: 'dbo', name: 'Customer' }, name: 'Id' } }, label: 'Id', sublabel: '(PK, int, not null)', icon: 'column' as never, hasChildren: false }
    children[0]!(ok({ nodes: [column], elapsedMs: 1, cursor: 'v1.columns.x' }))
    await flush()
    expect(open().members).toEqual({ status: 'ready', value: { nodes: [column], more: true } })
    service.selectTab('rows')
    service.selectTab('members')
    service.selectTab('rows')
    expect(api.explorerChildren).toHaveBeenCalledTimes(1)
    await flush()
    expect(api.execute).toHaveBeenCalledTimes(1)
    executes[0]!(ok(summary('id-4')))
    await flush()
    expect(open().rows).toEqual({ status: 'ready', value: { key: 'id-4' } })
    expect(results.held()).toEqual(['id-4'])
    // A procedure has no Top rows tab.
    service.peek(node('procedure', 2), 'menu')
    service.selectTab('rows')
    expect(open().tab).toBe('definition')
    expect(api.execute).toHaveBeenCalledTimes(1)
    // Peeking another object released the table's rows.
    expect(results.held()).toEqual([])
  })
  it('cancels the tabs\' reads with the peek\'s when the card closes, and drops their late answers', async () => {
    const { service, api, children, open, results } = setup()
    service.peek(node('table'), 'menu')
    service.selectTab('members')
    service.selectTab('rows')
    service.close()
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-1', 'id-3'])
    expect(results.released).toContain('id-4')
    children[0]!(ok({ nodes: [], elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open).toBeUndefined()
    service.peek(node('table'), 'menu')
    service.selectTab('members')
    children[1]!(ok({ nodes: [], elapsedMs: 1, error: { code: 'TIMEOUT', message: 'slow', retryable: true } }))
    await flush()
    expect(open().members).toEqual({ status: 'error', message: 'slow' })
    // Choosing a failed tab again reads it again; a ready one is kept.
    service.selectTab('members')
    expect(open().members).toEqual({ status: 'loading' })
    children[2]!(ok({ nodes: [], elapsedMs: 1 }))
    await flush()
    service.selectTab('members')
    expect(api.explorerChildren).toHaveBeenCalledTimes(3)
    expect(open().members).toEqual({ status: 'ready', value: { nodes: [], more: false } })
  })
  it('follows a dependency in the same card beside the same row, and Back returns to the tab it left', async () => {
    const { service, api, peeks, open } = setup()
    service.peek(node('table', 7), 'menu')
    service.selectTab('dependencies')
    const view = { name: 'vOrders', schema: 'Sales', kind: 'view' as const }
    expect(service.canFollow(view)).toBe(true)
    expect(service.canFollow({ ...view, database: 'Other' })).toBe(false)
    expect(service.canFollow({ ...view, database: 'Sales' })).toBe(false)
    expect(service.canFollow({ ...view, server: 'LINKED' })).toBe(false)
    expect(service.canFollow({ name: 'trg', schema: 'dbo' })).toBe(false)
    expect(service.canFollow({ ...view, kind: 'synonym' })).toBe(true)
    expect(service.canFollow({ ...view, kind: 'sequence' })).toBe(true)
    expect(service.canFollow({ ...view, kind: 'trigger' })).toBe(false)
    expect(service.canFollow({ ...view, kind: 'column' as never })).toBe(false)
    service.follow(view)
    expect(open()).toMatchObject({ rowId: 7, kind: 'view', tab: 'definition', node: { kind: 'view', label: 'Sales.vOrders', ref: { type: 'object', object: { kind: 'view', database: 'Sales', schema: 'Sales', name: 'vOrders' } } } })
    expect(open().back).toHaveLength(1)
    expect(api.explorerPeek).toHaveBeenLastCalledWith({ connectionId, requestId: expect.any(String), target: { kind: 'view', database: 'Sales', schema: 'Sales', name: 'vOrders' } })
    peeks[1]!(facts())
    await flush()
    service.refresh()
    expect(open()).toMatchObject({ rowId: 7, kind: 'view', back: [{ kind: 'table', tab: 'dependencies' }] })
    service.goBack()
    expect(open()).toMatchObject({ rowId: 7, kind: 'table', tab: 'dependencies', back: [] })
    // A followed dependency keeps the subtype the tree gives it, so Script As offers its own verbs.
    service.follow({ name: 'Median', schema: 'dbo', kind: 'function', subtype: 'aggregate' })
    expect(open().node).toMatchObject({ kind: 'function', subtype: 'aggregate', ref: { object: { kind: 'function', database: 'Sales', schema: 'dbo', name: 'Median' } } })
    service.goBack()
    // Peeking the row again from the tree while the card shows a followed object shows the row's own.
    service.follow(view)
    service.peek(node('table', 7), 'keyboard')
    expect(open()).toMatchObject({ kind: 'table', back: [], tab: 'definition' })
  })
})

describe('Peek kinds beyond modules', () => {
  const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const embedded = () => (JSON.parse(explorerCatalogJson()) as { peek: ReturnType<typeof peekCatalogBlock> }).peek

  it('declares each kind\'s tabs in the catalogue, Definition first, and lists only where the kind has them', () => {
    const tabs = Object.fromEntries(peekKinds.map(kind => [kind, peekTabsOf(kind)]))
    expect(tabs).toEqual({
      table: ['definition', 'members', 'dependencies', 'rows'], view: ['definition', 'members', 'dependencies', 'rows'],
      procedure: ['definition', 'members', 'dependencies'], function: ['definition', 'members', 'dependencies'],
      index: ['definition', 'indexColumns'], trigger: ['definition', 'events', 'dependencies'],
      databaseTrigger: ['definition', 'events'], serverTrigger: ['definition', 'events'],
      database: ['definition', 'files'], login: ['definition', 'serverRoles', 'userMapping'],
      synonym: ['definition', 'dependencies'], sequence: ['definition', 'dependencies'], type: ['definition', 'dependencies'],
      tableType: ['definition', 'members', 'dependencies']
    })
    // A synonym has no Top rows, a sequence no Parameters, a database or a login no Dependencies.
    expect([peekHas('synonym', 'rows'), peekHas('sequence', 'members'), peekHas('database', 'dependencies'), peekHas('login', 'dependencies')]).toEqual([false, false, false, false])
    for (const kind of peekKinds) {
      expect(peekTabsOf(kind)[0], kind).toBe('definition')
      expect(peekHas(kind, 'members'), kind).toBe(peekSpecs[kind].members !== undefined)
    }
    expect(peekTabTitle('login', 'userMapping')).toBe('User mapping')
    expect(peekTabTitle('index', 'indexColumns')).toBe(peekLists.indexColumns.title)
    expect(peekTabTitle('tableType', 'members')).toBe('Columns')
    expect(isPeekListTab('files')).toBe(true)
    expect(isPeekListTab('rows')).toBe(false)
    expect(peekListsOf('login')).toEqual(['serverRoles', 'userMapping'])
  })

  it('embeds tabs, lists and the optional usage group for the backend, the optional facts last', () => {
    const peek = embedded()
    const kind = (id: string) => peek.kinds.find(item => item.kind === id)!
    expect(peek.listRows).toBe(peekLimits.listRows)
    expect(peek.mappingDatabases).toBe(peekLimits.mappingDatabases)
    expect(peek.kinds.filter(item => !item.dependencies).map(item => item.kind)).toEqual(['index', 'databaseTrigger', 'serverTrigger', 'database', 'login'])
    expect(peek.kinds.filter(item => item.optionalGroup).map(item => item.kind)).toEqual(['index'])
    expect(kind('index').optionalGroup).toBe('usage')
    const facts = kind('index').facts
    const first = facts.findIndex(item => item.optional)
    expect(facts.slice(first).every(item => item.optional)).toBe(true)
    expect(facts.slice(first).map(item => item.id)).toEqual(peekSpecs.index.groups.find(group => group.id === 'usage')!.facts.map(item => item.id))
    expect(kind('login').lists.map(list => list.id)).toEqual(['serverRoles', 'userMapping'])
    expect(kind('database').lists[0]!.columns).toEqual(peekLists.files.columns.map(column => ({ id: column.id, format: column.format })))
    // Facts newer than the oldest band are gated.
    expect(facts.find(item => item.id === 'optimizeForSequentialKey')?.since).toBe(15)
    expect(kind('sequence').facts.find(item => item.id === 'lastUsedValue')?.since).toBe(14)
    for (const list of Object.values(peekLists)) expect(new Set(list.columns.map(column => column.label)).size, list.id).toBe(list.columns.length)
  })

  it('takes a dependencies request only for kinds with that tab', () => {
    const schemaObject = (kind: string) => ({ connectionId, requestId, target: { kind, database: 'Sales', schema: 'dbo', name: 'x' } })
    expect(peekDependenciesParamsSchema.safeParse(schemaObject('synonym')).success).toBe(true)
    expect(peekDependenciesParamsSchema.safeParse(schemaObject('sequence')).success).toBe(true)
    expect(peekDependenciesParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'login', name: 'sa' } }).success).toBe(false)
    expect(peekDependenciesParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'database', name: 'Sales' } }).success).toBe(false)
    expect(peekDependenciesParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'index', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'T' }, name: 'IX' } }).success).toBe(false)
  })

  it('words catalog codes for any fact or list column whose format is code', () => {
    expect(formatPeekValue({ format: 'code' }, 'ROWS')).toBe('Rows')
    expect(formatPeekValue({ format: 'code' }, 'CREATE_TABLE')).toBe('Create table')
    expect(formatPeekValue({ format: 'code' }, 'mixed Value')).toBe('mixed Value')
    expect(formatPeekValue({ format: 'text' }, 'ROWS')).toBe('ROWS')
    expect(formatPeekValue({ format: 'kb' }, 8192)).toBe('8.00 MB')
  })

  it('shows a list\'s rows in its columns, says when it is empty, cut or partly unread, and waits for the facts', () => {
    const ready = { status: 'ready' as const, value: {} }
    const markup = renderToStaticMarkup(createElement(PeekListView, { id: 'files', part: ready, list: { rows: [['Sales', 'ROWS', 8192, 'By 64 MB, unlimited', 'C:\\data\\Sales.mdf']], truncated: true } }))
    expect(markup).toContain('aria-label="Files"')
    expect(markup.match(/<th[^>]*>.*?<\/th>/g)).toHaveLength(peekLists.files.columns.length)
    expect(markup).toContain('<td title="Rows">Rows</td>')
    expect(markup).toContain('<td title="8.00 MB">8.00 MB</td>')
    expect(markup).toContain('There are more than the card lists.')
    const empty = renderToStaticMarkup(createElement(PeekListView, { id: 'userMapping', part: ready, list: { rows: [], unread: 3 } }))
    expect(empty).toContain(peekLists.userMapping.empty)
    expect(empty).toContain('3 databases could not be read.')
    expect(renderToStaticMarkup(createElement(PeekListView, { id: 'serverRoles', part: ready, list: undefined }))).toContain(peekLists.serverRoles.empty)
  })

  it('shows only the groups of the node\'s subtype, and says why a refused group is missing', () => {
    const open = (kind: 'type' | 'index', subtype: string | undefined, facts: Record<string, string | number | boolean | null>, refused?: string[]) => ({
      kind, ...(refused ? { refused } : {}), facts: { status: 'ready', value: facts },
      node: { id: 1, connectionId, kind, label: 'x', lost: false, ...(subtype ? { subtype } : {}), ref: { type: 'object', object: { kind, database: 'Sales', schema: 'dbo', name: 'x' } } }
    }) as never
    const alias = renderToStaticMarkup(createElement(Properties, { peek: open('type', 'alias', { schema: 'dbo', baseType: 'nvarchar(20)', assembly: 'Geo' }) }))
    expect(alias).toContain('aria-label="Alias type"')
    expect(alias).not.toContain('aria-label="CLR type"')
    const usage = peekSpecs.index.groups.find(group => group.id === 'usage')!
    expect(renderToStaticMarkup(createElement(Properties, { peek: open('index', undefined, { indexType: 'Clustered' }, ['usage']) }))).toContain(usage.refused)
    expect(renderToStaticMarkup(createElement(Properties, { peek: open('index', undefined, { indexType: 'Clustered' }) }))).not.toContain(usage.refused)
  })

  it('keeps a peek\'s lists and refused groups with its facts, reads nothing for a list tab, and tells children of different parents apart', async () => {
    const peeks: ((value: ApiResult<PeekResult>) => void)[] = []
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { peeks.push(resolve) })),
      explorerPeekDependencies: vi.fn(() => new Promise<never>(() => {})),
      explorerChildren: vi.fn(() => new Promise<never>(() => {})),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    let ids = 0
    const service = new PeekService({
      api: api as never, connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} }, newId: () => `id-${++ids}`
    })
    const target = (parent: string) => ({ kind: 'index' as const, database: 'Sales', parent: { kind: 'table' as const, schema: 'dbo', name: parent }, name: 'IX' })
    const index = (parent: string): ExplorerMenuNode => ({ id: 3, connectionId, kind: 'index', label: 'IX', lost: false, ref: { type: 'object', object: target(parent) } })
    service.peek(index('Orders'), 'menu')
    expect(api.explorerPeek).toHaveBeenCalledWith({ connectionId, requestId: 'id-1', target: target('Orders') })
    // An index has no stored text: Script As writes it.
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    peeks[0]!(ok({ facts: { indexType: 'Nonclustered' }, lists: { indexColumns: { rows: [['Id', false, false, 'int']] } }, refused: ['usage'], elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ lists: { indexColumns: { rows: [['Id', false, false, 'int']] } }, refused: ['usage'] })
    service.selectTab('indexColumns')
    expect(service.getSnapshot().open?.tab).toBe('indexColumns')
    expect(api.explorerChildren).not.toHaveBeenCalled()
    expect(api.explorerPeekDependencies).not.toHaveBeenCalled()
    // A tab the kind lacks is not chosen.
    service.selectTab('dependencies')
    expect(service.getSnapshot().open?.tab).toBe('indexColumns')
    // A list's Retry after the facts failed reads the object again, on the same tab.
    service.refresh()
    expect(api.explorerPeek).toHaveBeenCalledTimes(2)
    peeks[1]!(ok({ facts: {}, elapsedMs: 1, error: { code: 'TIMEOUT', message: 'Too slow.', retryable: true } }))
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ tab: 'indexColumns', facts: { status: 'error' } })
    service.selectTab('indexColumns')
    expect(api.explorerPeek).toHaveBeenCalledTimes(3)
    peeks[2]!(ok({ facts: { indexType: 'Nonclustered' }, lists: { indexColumns: { rows: [] } }, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open).toMatchObject({ tab: 'indexColumns', facts: { status: 'ready' } })
    // The same index name below another table is another object: it reads and scripts again.
    service.peek(index('Orders'), 'keyboard')
    expect(api.explorerPeek).toHaveBeenCalledTimes(3)
    service.peek(index('Returns'), 'keyboard')
    expect(api.explorerPeek).toHaveBeenCalledTimes(4)
    // An index of a table type: Script As cannot write it, so it is not asked, and the card says there is no definition.
    const typed: ExplorerMenuNode = { id: 5, connectionId, kind: 'index', subtype: 'nonclustered', label: 'IX', lost: false,
      ref: { type: 'object', object: { kind: 'index', database: 'Sales', parent: { kind: 'tableType', schema: 'dbo', name: 'Lines' }, name: 'IX' } } }
    const scripts = api.scriptObjects.mock.calls.length
    service.peek(typed, 'keyboard')
    expect(api.explorerPeek).toHaveBeenCalledTimes(5)
    expect(api.scriptObjects).toHaveBeenCalledTimes(scripts)
    peeks[4]!(ok({ facts: { indexType: 'Nonclustered' }, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open?.definition).toEqual({ status: 'ready', value: {} })
  })
})
