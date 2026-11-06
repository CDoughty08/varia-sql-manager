import { describe, expect, it, vi } from 'vitest'
import { explorerCatalogJson, maxBand, minBand } from '../src/shared/explorer/catalog'
import { isPeekKind, peekCatalogBlock, peekFacts, peekFormats, peekKinds, peekLimits, peekSpecs, type PeekResult } from '../src/shared/explorer/peek'
import { peekParamsSchema } from '../src/shared/explorer/schema'
import { requestSchemas } from '../src/main/validation'
import { methodPolicies } from '../src/shared/ipc/methods'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { PeekBoundary } from '../src/renderer/src/explorer/PeekCard'
import { formatPeekValue, placePeek, cardWidth } from '../src/renderer/src/explorer/peek-format'
import { PeekService } from '../src/renderer/src/explorer/PeekService'
import type { ApiResult } from '../src/shared/contracts'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import type { ScriptingOptions } from '../src/shared/scripting/options'

const connectionId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222'
const node = (kind: 'table' | 'procedure' | 'login', id = 1, name = 'Customer'): ExplorerMenuNode => ({
  id, connectionId, kind, label: name, lost: false,
  ref: { type: 'object', object: kind === 'login' ? { kind, name } : { kind, database: 'Sales', schema: 'dbo', name } }
})

describe('Peek catalogue', () => {
  it('describes each kind with distinct fact ids and labels, known formats, and bands the tree serves', () => {
    expect(peekKinds).toEqual(['table', 'view', 'procedure', 'function'])
    for (const kind of peekKinds) {
      const facts = peekFacts(kind)
      expect(new Set(facts.map(fact => fact.id)).size, kind).toBe(facts.length)
      expect(new Set(facts.map(fact => fact.label)).size, kind).toBe(facts.length)
      for (const fact of facts) {
        expect(peekFormats, fact.id).toContain(fact.format)
        expect(fact.id, fact.id).toMatch(/^[a-z][A-Za-z]+$/)
        if (fact.since !== undefined) expect(fact.since > minBand && fact.since <= maxBand, fact.id).toBe(true)
      }
      expect(facts.slice(0, 4).map(fact => fact.id), kind).toEqual(['schema', 'created', 'modified', 'systemObject'])
    }
    // Only tables have no stored text: Script As writes their definition.
    expect(peekKinds.filter(kind => peekSpecs[kind].definition === 'script')).toEqual(['table'])
  })
  it('embeds the facts in reply order for the backend', () => {
    const embedded = JSON.parse(explorerCatalogJson()) as { peek: ReturnType<typeof peekCatalogBlock> }
    expect(embedded.peek).toEqual(JSON.parse(JSON.stringify(peekCatalogBlock())))
    expect(embedded.peek.kinds.find(kind => kind.kind === 'table')?.facts.find(fact => fact.id === 'ledger')).toEqual({ id: 'ledger', format: 'text', since: 16 })
    expect(embedded.peek.budgetMs).toBe(peekLimits.budgetMs)
  })
})

describe('explorer.peek requests', () => {
  it('accepts a table, view, procedure or function and refuses any other kind or extra field', () => {
    const target = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' }
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, kind: 'procedure' } }).success).toBe(true)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { kind: 'login', name: 'sa' } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, schema: undefined } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target: { ...target, name: 'x'.repeat(129) } }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId, requestId, target, extra: 1 }).success).toBe(false)
    expect(peekParamsSchema.safeParse({ connectionId: 'nope', requestId, target }).success).toBe(false)
    expect(isPeekKind('index')).toBe(false)
  })
  it('is validated by main, runs on the explorer lane within its deadline, and is cancellable', () => {
    expect(requestSchemas['explorer.peek']).toBe(peekParamsSchema)
    expect(methodPolicies['explorer.peek']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 20_000 })
    expect((methodPolicies['explorer.peek'] as { deadlineMs: number }).deadlineMs).toBeGreaterThan(peekLimits.budgetMs)
    expect(cancellableRequests('explorer.peek', { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' })).toBe('explorer')
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
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { resolvePeek = resolve })),
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
    return { service, api, timers, resolvePeek: (value: ApiResult<PeekResult>) => resolvePeek(value), resolveScript: (text: string) => resolveScript(ok({ text, database: 'Sales', warnings: [], commands: 1, elapsedMs: 1 })),
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
    service.hover(node('login'))
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
  it('copies a definition only when the card has all of it', async () => {
    const { service, api, resolvePeek } = setup()
    service.peek(node('procedure'), 'menu')
    resolvePeek(ok({ facts: {}, definition: 'CREATE PROCEDURE dbo.Customer AS', definitionTruncated: true, elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().open?.definition).toMatchObject({ status: 'ready', value: { truncated: true } })
    await service.copyDefinition()
    expect(api.writeClipboardText).not.toHaveBeenCalled()
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
