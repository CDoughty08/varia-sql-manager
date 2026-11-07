import { describe, expect, it, vi } from 'vitest'
import { explorerCatalogJson, maxBand, minBand } from '../src/shared/explorer/catalog'
import { isPeekKind, peekCatalogBlock, peekFacts, peekFormats, peekKinds, peekLimits, peekSpecs, peekTabsOf, peekTabTitle, type PeekDependenciesResult, type PeekResult, type PeekRowsResult } from '../src/shared/explorer/peek'
import { peekParamsSchema, peekRowsParamsSchema } from '../src/shared/explorer/schema'
import { requestSchemas } from '../src/main/validation'
import { methodPolicies } from '../src/shared/ipc/methods'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { PeekBoundary } from '../src/renderer/src/explorer/PeekCard'
import { formatPeekValue, placePeek, cardWidth } from '../src/renderer/src/explorer/peek-format'
import { PeekService } from '../src/renderer/src/explorer/PeekService'
import type { ApiResult, ExplorerChildrenResult } from '../src/shared/contracts'
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
    expect(methodPolicies['explorer.peek']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    // Room for a peek that waits for the connection's peek slot, then runs its whole budget.
    expect((methodPolicies['explorer.peek'] as { deadlineMs: number }).deadlineMs).toBeGreaterThanOrEqual(2 * peekLimits.budgetMs)
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
      kept: () => (service as unknown as { scripts: Map<string, unknown> }).scripts.size }
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
    expect((service as unknown as { scripts: Map<string, unknown> }).scripts.size).toBe(0)
    expect(scriptsSent()).toBe(1)
  })
})

describe('Peek tabs', () => {
  const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
  function setup() {
    const peeks: ((value: ApiResult<PeekResult>) => void)[] = []
    const children: ((value: ApiResult<ExplorerChildrenResult>) => void)[] = []
    const rows: ((value: ApiResult<PeekRowsResult>) => void)[] = []
    const dependencies: ((value: ApiResult<PeekDependenciesResult>) => void)[] = []
    const api = {
      explorerPeekDependencies: vi.fn(() => new Promise<ApiResult<PeekDependenciesResult>>(resolve => { dependencies.push(resolve) })),
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { peeks.push(resolve) })),
      explorerChildren: vi.fn(() => new Promise<ApiResult<ExplorerChildrenResult>>(resolve => { children.push(resolve) })),
      explorerPeekRows: vi.fn(() => new Promise<ApiResult<PeekRowsResult>>(resolve => { rows.push(resolve) })),
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
    return { service, api, peeks, children, rows, dependencies, open: () => service.getSnapshot().open! }
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const facts = (extra: Partial<PeekResult> = {}): ApiResult<PeekResult> => ok({ facts: { schema: 'dbo', modified: '2024-01-02T03:04:05' }, elapsedMs: 1, ...extra })

  it('gives tables and views a Top rows tab and every kind Columns or Parameters and Dependencies, and only tables and views take a rows request', () => {
    expect(peekTabsOf('table')).toEqual(['definition', 'members', 'dependencies', 'rows'])
    expect(peekTabsOf('view')).toEqual(['definition', 'members', 'dependencies', 'rows'])
    expect(peekTabsOf('procedure')).toEqual(['definition', 'members', 'dependencies'])
    expect([peekTabTitle('table', 'members'), peekTabTitle('function', 'members'), peekTabTitle('view', 'rows')]).toEqual(['Columns', 'Parameters', 'Top rows'])
    const target = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' }
    expect(peekRowsParamsSchema.safeParse({ connectionId, requestId, target }).success).toBe(true)
    expect(peekRowsParamsSchema.safeParse({ connectionId, requestId, target: { ...target, kind: 'view' } }).success).toBe(true)
    expect(peekRowsParamsSchema.safeParse({ connectionId, requestId, target: { ...target, kind: 'procedure' } }).success).toBe(false)
    expect(peekRowsParamsSchema.safeParse({ connectionId, requestId, target, extra: 1 }).success).toBe(false)
    expect(requestSchemas['explorer.peekRows']).toBe(peekRowsParamsSchema)
    expect(requestSchemas['explorer.peekDependencies']).toBe(peekParamsSchema)
    expect(methodPolicies['explorer.peekDependencies']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    expect(methodPolicies['explorer.peekRows']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 30_000 })
    expect(cancellableRequests('explorer.peekRows', { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' })).toBe('explorer')
    const embedded = JSON.parse(explorerCatalogJson()) as { peek: { rows: number; kinds: { kind: string; rows: boolean }[] } }
    expect(embedded.peek.rows).toBe(peekLimits.rows)
    expect(embedded.peek.kinds.filter(kind => kind.rows).map(kind => kind.kind)).toEqual(['table', 'view'])
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
  it('reads Columns or Parameters and Top rows only once their tab is chosen, and each once per card', async () => {
    const { service, api, children, rows, open } = setup()
    service.peek(node('table'), 'hover')
    expect(api.explorerChildren).not.toHaveBeenCalled()
    expect(api.explorerPeekRows).not.toHaveBeenCalled()
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
    expect(api.explorerPeekRows).toHaveBeenCalledTimes(1)
    expect(api.explorerPeekRows).toHaveBeenCalledWith({ connectionId, requestId: 'id-4', target: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' } })
    rows[0]!(ok({ columns: [{ name: 'Id', type: 'int' }], rows: [['1'], [null]], elapsedMs: 2 }))
    await flush()
    expect(open().rows).toMatchObject({ status: 'ready', value: { rows: [['1'], [null]] } })
    // A procedure has no Top rows tab.
    service.peek(node('procedure', 2), 'menu')
    service.selectTab('rows')
    expect(open().tab).toBe('definition')
    expect(api.explorerPeekRows).toHaveBeenCalledTimes(1)
  })
  it('cancels the tabs\' reads with the peek\'s when the card closes, and drops their late answers', async () => {
    const { service, api, children, open } = setup()
    service.peek(node('table'), 'menu')
    service.selectTab('members')
    service.selectTab('rows')
    service.close()
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-1', 'id-3', 'id-4'])
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
    expect(service.canFollow({ ...view, database: 'Sales' })).toBe(true)
    expect(service.canFollow({ ...view, server: 'LINKED' })).toBe(false)
    expect(service.canFollow({ name: 'trg', schema: 'dbo' })).toBe(false)
    expect(service.canFollow({ ...view, kind: 'synonym' })).toBe(false)
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
