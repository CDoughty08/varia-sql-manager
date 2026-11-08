import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { methodPolicies } from '../src/shared/ipc/methods'
import { requestSchemas } from '../src/main/validation'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { indexProgressRelay } from '../src/main/index-progress'
import {
  childrenLeftOut, objectIndexParamsSchema, objectIndexProgressEventSchema, objectSearchLimits, objectSearchParamsSchema, searchKindBadge, searchKinds, searchKindTones, searchTypeKinds, searchTypes,
  type ObjectIndexProgress, type ObjectIndexResult, type ObjectIndexStatus, type ObjectSearchHit, type ObjectSearchResult
} from '../src/shared/explorer/search'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Timers } from '../src/renderer/src/core/timers'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { explorerSearchId, hitServer, mergeAnswers, ObjectSearchService, revealPaths, serverGroups, type ObjectSearchOptions, type RevealHost } from '../src/renderer/src/search/ObjectSearchService'
import { indexSummary, searchHitPath } from '../src/renderer/src/search/ObjectSearch'
import { allIndexesSummary, allServersSummary, groupNote, moreMatches } from '../src/renderer/src/search/SearchPanel'
import { kindSpecs, nodeKinds } from '../src/shared/explorer/catalog'
import { colorKeys } from '../src/shared/theme/registry'
import { layoutFilters, minimumChips } from '../src/renderer/src/search/filter-layout'
import { searchFilterSummary, toggleSearchType } from '../src/renderer/src/search/SearchFilters'
import { clampPaneBand, paneBandDrag, paneBandKey, paneBandLimits } from '../src/renderer/src/search/pane-band'

const csharp = (file: string) => readFileSync(new URL('../backend/Varia.Backend/Search/' + file, import.meta.url), 'utf8')

describe('object search contracts', () => {
  it('mirrors the backend\'s limits and kinds', () => {
    const service = csharp('ObjectSearchService.cs'), index = csharp('ObjectIndex.cs')
    expect(service).toContain(`public const int MaxText = ${objectSearchLimits.text};`)
    expect(service).toContain(`public const int MaxLimit = ${objectSearchLimits.hits};`)
    expect(service).toContain(`public const int DefaultLimit = ${objectSearchLimits.defaultHits};`)
    expect(service).toContain(`public const int MaxSkipped = ${objectSearchLimits.skipped};`)
    expect(service).toContain(`Kinds = [${searchKinds.map(kind => `"${kind}"`).join(', ')}]`)
    expect(service).toContain(`public const int MaxKinds = ${objectSearchLimits.kinds};`)
    const fuzzy = csharp('FuzzyName.cs')
    expect(fuzzy).toContain(`public const int MaxWords = ${objectSearchLimits.fuzzyWords};`)
    expect(fuzzy).toContain(`public const int MaxWordChars = ${objectSearchLimits.fuzzyWordChars};`)
    expect(service).toContain(`public const string ChildrenLeftOut = "${childrenLeftOut}";`)
    expect(index).toContain(`SearchBudget { get; set; } = TimeSpan.FromSeconds(${objectSearchLimits.searchMs / 1000});`)
    expect(index).toContain(`DatabaseBudget { get; set; } = TimeSpan.FromSeconds(${objectSearchLimits.databaseMs / 1000});`)
    expect(index).toContain(`DefinitionChars { get; init; } = ${objectSearchLimits.definitionChars.toLocaleString('en-US').replaceAll(',', '_')};`)
    expect(index).toContain('MemoryBytes { get; init; } = 512L * 1024 * 1024;')
    expect(objectSearchLimits.memoryBytes).toBe(512 * 1024 * 1024)
    expect(index).toContain('NamesReserveBytes { get; init; } = 128L * 1024 * 1024;')
    expect(objectSearchLimits.namesReserveBytes).toBe(128 * 1024 * 1024)
  })

  it('indexes every kind Object Explorer lists but the server, return values and the SSIS Catalog\'s', () => {
    const listed = nodeKinds.filter(kind => !['server', 'childUnnamed'].includes(kindSpecs[kind].scope) && !kindSpecs[kind].scope.startsWith('ssis'))
    expect([...searchKinds].sort()).toEqual([...listed].sort())
    expect(searchKinds.length).toBeLessThanOrEqual(objectSearchLimits.kinds)
    // The type filters name every kind the index holds exactly once, so a kind can neither be unreachable nor in two chips.
    const typed = searchTypes.flatMap(type => [...type.kinds])
    expect([...typed].sort()).toEqual([...searchKinds].sort())
    expect(new Set(searchTypes.map(type => type.id)).size).toBe(searchTypes.length)
  })

  it('gives every kind a one-letter badge in a tone the theme colours', () => {
    expect(searchKinds.map(kind => searchKindBadge(kind)).every(badge => /^[A-Z]$/.test(badge.letters) && searchKindTones.includes(badge.tone))).toBe(true)
    expect((['table', 'view', 'procedure', 'function', 'column', 'login', 'index', 'database', 'synonym'] as const).map(kind => Object.values(searchKindBadge(kind)).join(' ')))
      .toEqual(['T table', 'V view', 'P procedure', 'F function', 'C column', 'L security', 'I key', 'D database', 'S other'])
    // Every tone has its theme key, and the stylesheet draws each one.
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    for (const tone of searchKindTones) {
      expect(colorKeys, tone).toContain(`searchKind.${tone}Background`)
      expect(css, tone).toContain(`.object-search-kind[data-tone="${tone}"] { background: var(--varia-searchKind-${tone}Background); }`)
    }
  })

  it('validates requests strictly, in both directions of every bound', () => {
    const ids = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    expect(objectIndexParamsSchema.safeParse({ ...ids, definitions: false }).success).toBe(true)
    expect(objectIndexParamsSchema.safeParse({ ...ids, extra: 1 }).success).toBe(false)
    const ok = (params: object) => objectSearchParamsSchema.safeParse({ ...ids, text: 'x', ...params }).success
    expect(ok({ caseSensitive: true, wholeWord: true, regex: true, in: 'definitions', kinds: ['procedure'], database: 'Sales', limit: objectSearchLimits.hits })).toBe(true)
    expect(ok({ text: 'x'.repeat(objectSearchLimits.text) })).toBe(true)
    expect(ok({ text: 'x'.repeat(objectSearchLimits.text + 1) })).toBe(false)
    // Code units, as the backend counts them: 500 astral characters are 1000 units.
    expect(ok({ text: '😀'.repeat(500) })).toBe(true)
    expect(ok({ text: '😀'.repeat(501) })).toBe(false)
    expect(ok({ kinds: [...searchKinds] })).toBe(true)
    // Fuzzy Match: an enum, never with a regular expression.
    expect(ok({ match: 'fuzzy', wholeWord: true, caseSensitive: true })).toBe(true)
    expect(ok({ match: 'exact', regex: true })).toBe(true)
    expect(ok({ match: 'fuzzy', regex: false })).toBe(true)
    expect(ok({ match: 'fuzzy', regex: true })).toBe(false)
    expect(ok({ match: 'soundex' })).toBe(false)
    expect(ok({ match: true })).toBe(false)
    for (const bad of [{ text: '' }, { text: 'a\u0000' }, { in: 'columns' }, { kinds: [] }, { kinds: ['ssisPackage'] }, { kinds: Array(objectSearchLimits.kinds + 1).fill('table') }, { limit: 0 }, { limit: objectSearchLimits.hits + 1 }, { database: 'd'.repeat(129) }, { columns: true }])
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
    expect(requestSchemas['explorer.index']).toBe(objectIndexParamsSchema)
    expect(requestSchemas['explorer.search']).toBe(objectSearchParamsSchema)
  })

  it('runs both methods on the explorer lane, cancellable through varia:explorer-cancel', () => {
    expect(methodPolicies['explorer.index']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 0 })
    expect(methodPolicies['explorer.search']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 15_000 })
    const channels = { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' }
    expect(cancellableRequests('explorer.index', channels)).toBe('explorer')
    expect(cancellableRequests('explorer.search', channels)).toBe('explorer')
  })

  it('accepts only well-formed progress EVENTs', () => {
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 1, total: 2, objects: 30 }).success).toBe(true)
    for (const bad of [{ done: 3, total: 2, objects: 0 }, { done: -1, total: 2, objects: 0 }, { done: 1, total: 2, objects: 1.5 }, { done: 1, total: 2, objects: 0, database: 'x' }])
      expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', ...bad }).success).toBe(false)
  })
})

describe('main\'s index progress relay', () => {
  const gap = 1000 / objectSearchLimits.progressPerSecond
  beforeEach(() => { vi.useFakeTimers({ now: 0 }) })
  afterEach(() => { vi.useRealTimers() })
  function window() {
    const value = { destroyed: false, pushed: [] as ObjectIndexProgress[], isDestroyed: () => value.destroyed,
      send: (channel: string, progress: ObjectIndexProgress) => { expect(channel).toBe('varia:explorer-index-progress'); value.pushed.push(progress) } }
    return value
  }
  const event = (done: number, total = 10) => ({ type: 'explorer.index.progress' as const, done, total, objects: done * 100 })

  it('pushes at most progressPerSecond a second, the latest held one when the interval ends, and nothing after close', () => {
    const target = window(), relay = indexProgressRelay('r', target)
    relay.event(event(0))
    relay.event(event(1))
    relay.event(event(2))
    expect(target.pushed.map(value => value.done)).toEqual([0])
    vi.advanceTimersByTime(gap)
    expect(target.pushed.map(value => value.done)).toEqual([0, 2])
    expect(target.pushed[1]).toEqual({ requestId: 'r', done: 2, total: 10, objects: 200 })
    relay.event(event(3))
    relay.close()
    vi.advanceTimersByTime(gap * 2)
    relay.event(event(4))
    expect(target.pushed).toHaveLength(2)
  })

  it('pushes nothing to a window that is gone', () => {
    const target = window(), relay = indexProgressRelay('r', target)
    target.destroyed = true
    relay.event(event(1))
    expect(target.pushed).toHaveLength(0)
  })
})

const status = (overrides: Partial<ObjectIndexStatus> = {}): ObjectIndexStatus => ({ state: 'ready', databases: 2, indexed: 2, objects: 40, modules: 5, cut: 0, skipped: [], definitions: true, ...overrides })
const hit: ObjectSearchHit = { object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' }, folder: 'tables', label: 'dbo.Orders', range: [4, 6] }

class Connections extends SnapshotStore<readonly LiveConnection[]> {
  set(list: readonly LiveConnection[]) { this.publish(list) }
  get = (id: string) => this.getSnapshot().find(connection => connection.id === id)
}
const connection = (id: string, lost = false) => ({ id, server: 'srv-' + id, database: 'master', serverVersion: '16.0', options: {}, ...lost ? { lost: true } : {} }) as unknown as LiveConnection

function harness(settings: { indexOnConnect?: boolean; definitions?: boolean } = {}) {
  const calls = { index: [] as Parameters<VariaApi['explorerIndex']>[0][], search: [] as Parameters<VariaApi['explorerSearch']>[0][], cancel: [] as string[][] }
  const pendingIndex: ((result: ApiResult<ObjectIndexResult>) => void)[] = []
  const pendingSearch: ((result: ApiResult<ObjectSearchResult>) => void)[] = []
  let progress: ((value: ObjectIndexProgress) => void) | undefined
  const api: ObjectSearchOptions['api'] = {
    explorerIndex: vi.fn(params => { calls.index.push(params); return new Promise<ApiResult<ObjectIndexResult>>(resolve => pendingIndex.push(resolve)) }),
    explorerSearch: vi.fn(params => { calls.search.push(params); return new Promise<ApiResult<ObjectSearchResult>>(resolve => pendingSearch.push(resolve)) }),
    explorerCancel: vi.fn(async ids => { calls.cancel.push([...ids]); return { ok: true as const, value: { cancelled: ids.length } } }),
    onExplorerIndexProgress: vi.fn(listener => { progress = listener; return () => { progress = undefined } })
  }
  let tabs = 0
  const registered: unknown[] = []
  const documents = {
    openCustom: vi.fn(() => ({ id: 'tab' + ++tabs })),
    registerProvider: vi.fn(provider => { registered.push(provider); return { dispose: () => {} } }),
    get: vi.fn(), activate: vi.fn(), getSnapshot: vi.fn()
  } as unknown as ObjectSearchOptions['documents']
  const connections = new Connections([])
  const values: Record<string, boolean> = { 'objectExplorer.search.indexOnConnect': settings.indexOnConnect ?? true, 'objectExplorer.search.definitions': settings.definitions ?? true }
  const timers: Timers & { run(): void } = (() => {
    const queue = new Map<number, () => void>()
    let next = 0
    return { setTimeout: (callback: () => void) => { queue.set(++next, callback); return next }, clearTimeout: handle => { queue.delete(handle as number) },
      run: () => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(callback => callback()) } }
  })()
  let ids = 0
  const service = new ObjectSearchService({ api, documents, connections, settings: { get: (key => values[key]) as ObjectSearchOptions['settings']['get'] }, timers, newId: () => 'req' + ++ids })
  return { service, api, calls, pendingIndex, pendingSearch, connections, timers, registered, emit: (value: ObjectIndexProgress) => progress?.(value), hasListener: () => !!progress }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ObjectSearchService', () => {
  it('builds each server\'s index when it connects, with definitions as Options says, and drops it when the server goes', async () => {
    const { service, calls, pendingIndex, connections, emit } = harness({ definitions: false })
    connections.set([connection('a')])
    expect(calls.index).toEqual([{ connectionId: 'a', requestId: 'req1', definitions: false }])
    emit({ requestId: 'req1', done: 1, total: 3, objects: 12 })
    emit({ requestId: 'someone-else', done: 9, total: 9, objects: 9 })
    expect(service.getSnapshot().indexes.a).toMatchObject({ requestId: 'req1', done: 1, total: 3, objects: 12 })
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 5 } })
    await settle()
    expect(service.getSnapshot().indexes.a).toEqual({ connectionId: 'a', done: 2, total: 2, objects: 40, status: status() })
    connections.set([connection('a'), connection('b')])
    expect(calls.index.map(call => call.connectionId)).toEqual(['a', 'b'])
    connections.set([connection('a', true), connection('b')])
    expect(Object.keys(service.getSnapshot().indexes)).toEqual(['b'])
  })

  it('waits for the first search when Options turns indexing on connect off', () => {
    const { service, calls, connections } = harness({ indexOnConnect: false })
    connections.set([connection('a')])
    expect(calls.index).toHaveLength(0)
    service.open('a')
    expect(calls.index).toHaveLength(1)
  })

  it('keeps the previous status through a rebuild, ignores a superseded build, and a stopped one keeps what it had', async () => {
    const { service, calls, pendingIndex, connections } = harness()
    connections.set([connection('a')])
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    service.build('a')
    expect(service.getSnapshot().indexes.a).toMatchObject({ requestId: 'req2', status: status() })
    service.build('a')
    pendingIndex[1]({ ok: false, error: 'stopped', code: 'CANCELLED' })
    await settle()
    expect(service.getSnapshot().indexes.a.requestId).toBe('req3')
    service.stopBuild('a')
    expect(calls.cancel).toEqual([['req3']])
    pendingIndex[2]({ ok: false, error: 'stopped', code: 'CANCELLED' })
    await settle()
    expect(service.getSnapshot().indexes.a).toEqual({ connectionId: 'a', done: 0, total: 0, objects: 40, status: status() })
  })

  it('searches after a pause in typing, at once for an option, cancels the search it replaces, and drops stale answers', async () => {
    const { service, calls, pendingSearch, pendingIndex, connections, timers } = harness()
    connections.set([connection('a')])
    const id = service.open('a')!
    service.setQuery(id, { text: 'ord' })
    service.setQuery(id, { text: 'orders' })
    expect(calls.search).toHaveLength(0)
    timers.run()
    expect(calls.search).toEqual([expect.objectContaining({ connectionId: 'a', text: 'orders', caseSensitive: false, wholeWord: false, regex: false, in: 'all' })])
    expect(calls.search[0]).not.toHaveProperty('kinds')
    service.setQuery(id, { caseSensitive: true })
    expect(calls.search[1]).toMatchObject({ text: 'orders', caseSensitive: true })
    expect(calls.cancel).toContainEqual([calls.search[0].requestId])
    const answer = (hits: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits, total: hits.length, partial: false, elapsedMs: 1, index: status() } })
    pendingSearch[0](answer([]))
    pendingSearch[1](answer([hit]))
    await settle()
    const state = service.getSnapshot().documents[id]
    expect(state.result?.hits).toEqual([hit])
    expect(state.requestId).toBeUndefined()
    expect(state.asked).toMatchObject({ text: 'orders', caseSensitive: true })
    // The build's end searches the tab again, so it sees the whole index.
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.search).toHaveLength(3)
    // A type filter searches at once, naming the kinds of the types chosen; clearing them searches every kind again.
    service.setQuery(id, { types: ['columns', 'schemas'] })
    expect(calls.search[3]).toMatchObject({ text: 'orders', kinds: ['schema', 'column'] })
    service.setQuery(id, { types: [] })
    expect(calls.search[4]).not.toHaveProperty('kinds')
  })

  it('walks the hits with Enter: searching at once when the answer is not in, wrapping round, and starting over on a new answer', async () => {
    const { service, calls, pendingSearch, connections, timers } = harness()
    connections.set([connection('a')])
    const id = service.open('a')!
    const hits = ['A', 'B', 'C'].map(name => ({ ...hit, label: `dbo.${name}`, object: { ...hit.object, name } }))
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    // Enter before the typing pause ends searches now, once, and takes the first hit when the answer comes.
    const first = service.step(id, 1)
    timers.run()
    expect(calls.search).toHaveLength(1)
    pendingSearch[0](answer(hits))
    expect((await first)?.label).toBe('dbo.A')
    expect((await service.step(id, 1))?.label).toBe('dbo.B')
    expect((await service.step(id, 1))?.label).toBe('dbo.C')
    expect((await service.step(id, 1))?.label).toBe('dbo.A')
    expect((await service.step(id, -1))?.label).toBe('dbo.C')
    expect(service.getSnapshot().documents[id].current).toBe(2)
    expect(calls.search).toHaveLength(1)
    // A hit picked from the list is where the next Enter goes on from.
    service.pick(id, 0)
    expect((await service.step(id, 1))?.label).toBe('dbo.B')
    // New text: a new search, and Shift+Enter starts from the last hit.
    service.setQuery(id, { text: 'y' })
    const last = service.step(id, -1)
    pendingSearch[1](answer(hits.slice(0, 2)))
    expect((await last)?.label).toBe('dbo.B')
    service.setQuery(id, { text: 'z' })
    const none = service.step(id, 1)
    pendingSearch[2](answer([]))
    expect(await none).toBeUndefined()
  })

  it('keeps the selected hit when the same search runs again, and forgets it after another search or when the hit is gone', async () => {
    const { service, pendingSearch, pendingIndex, connections, timers } = harness()
    connections.set([connection('a')])
    const id = service.open('a')!
    const hits = ['A', 'B', 'C'].map(name => ({ ...hit, label: `dbo.${name}`, object: { ...hit.object, name } }))
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    pendingSearch[0](answer(hits))
    await settle()
    service.pick(id, 1)
    // The build ends and searches again: dbo.B is still selected, at its new place.
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    pendingSearch[1](answer([hits[2]!, hits[0]!, hits[1]!]))
    await settle()
    expect(service.getSnapshot().documents[id].current).toBe(2)
    // The same search again without dbo.B: nothing is selected.
    void service.search(id)
    pendingSearch[2](answer([hits[0]!, hits[2]!]))
    await settle()
    expect(service.getSnapshot().documents[id].current).toBeUndefined()
    // Another search forgets the selection even when the hit is in its answer.
    service.pick(id, 0)
    service.setQuery(id, { text: 'y' })
    timers.run()
    pendingSearch[3](answer(hits))
    await settle()
    expect(service.getSnapshot().documents[id].current).toBeUndefined()
  })

  it('selects a menu\'s hit where the answer has it now, and acts from keys only on the focused list\'s hit', async () => {
    const { service, pendingSearch, connections, timers } = harness()
    connections.set([connection('a')])
    const id = service.open('a')!
    const hits = ['A', 'B', 'C'].map(name => ({ ...hit, label: `dbo.${name}`, object: { ...hit.object, name } }))
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    pendingSearch[0](answer(hits))
    await settle()
    // A menu opened on dbo.B at index 1; the answer has since moved it to index 2.
    void service.search(id)
    pendingSearch[1](answer([hits[2]!, hits[0]!, hits[1]!]))
    await settle()
    service.pickHit(id, hits[1]!)
    expect(service.getSnapshot().documents[id].current).toBe(2)
    // A hit the answer no longer has selects nothing new.
    service.pickHit(id, { ...hit, object: { ...hit.object, name: 'Gone' } })
    expect(service.getSnapshot().documents[id].current).toBe(2)
    expect(service.focusedHit()).toBeUndefined()
    service.listFocused(id, true)
    expect(service.focusedHit()).toMatchObject({ searchId: id, connectionId: 'a', index: 2, hit: hits[1] })
    service.listFocused(id, false)
    expect(service.focusedHit()).toBeUndefined()
  })

  it('searches all servers at once, each on its own index, and merges their answers in Object Explorer\'s order', async () => {
    const { service, calls, pendingSearch, connections, timers, api } = harness({ indexOnConnect: false })
    connections.set([connection('a'), connection('b')])
    const id = service.open(undefined, undefined, true)!
    // The tab belongs to no server, and every server gets an index.
    expect(vi.mocked(api.explorerIndex).mock.calls.map(([params]) => params.connectionId)).toEqual(['a', 'b'])
    expect(service.getSnapshot().documents[id]).toMatchObject({ allServers: true, connectionId: 'a' })
    const hits = ['A', 'B'].map(name => ({ ...hit, label: `dbo.${name}`, object: { ...hit.object, name } }))
    const answer = (value: ObjectSearchHit[], extra: Partial<ObjectSearchResult> = {}): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status(), ...extra } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    expect(calls.search.map(call => [call.connectionId, call.requestId, call.text])).toEqual([['a', 'req4', 'x'], ['b', 'req5', 'x']])
    // A search that replaces it cancels it on every server.
    service.setQuery(id, { caseSensitive: true })
    expect(calls.cancel.at(-1)).toEqual(['req4', 'req5'])
    // Nothing shows until every server has answered; a's own server is first, then b's, the same object on both.
    pendingSearch[2](answer(hits, { elapsedMs: 3 }))
    await settle()
    expect(service.getSnapshot().documents[id].servers).toBeUndefined()
    pendingSearch[3](answer([hits[0]!], { elapsedMs: 7, total: 40 }))
    await settle()
    const answered = service.getSnapshot().documents[id]
    expect(answered.requestId).toBeUndefined()
    expect(answered.result).toMatchObject({ total: 42, elapsedMs: 7, hits: [hits[0], hits[1], hits[0]] })
    expect(serverGroups(answered).map(group => [group.connectionId, group.label, group.start, group.hits.length])).toEqual([['a', 'srv-a', 0, 2], ['b', 'srv-b', 2, 1]])
    expect([0, 1, 2, 3].map(index => hitServer(answered, index))).toEqual(['a', 'a', 'b', undefined])
    // The same object on two servers is two hits: a menu's hit and the keys act on the hit's own server.
    service.pickHit(id, hits[0]!, 'b')
    expect(service.getSnapshot().documents[id].current).toBe(2)
    service.listFocused(id, true)
    expect(service.focusedHit()).toMatchObject({ connectionId: 'b', index: 2, hit: hits[0] })
    // The selection follows its server's hit when the answer moves it.
    void service.search(id)
    pendingSearch[4](answer([hits[1]!, hits[0]!, { ...hit, label: 'dbo.C', object: { ...hit.object, name: 'C' } }]))
    pendingSearch[5](answer([hits[0]!]))
    await settle()
    expect(service.getSnapshot().documents[id].current).toBe(3)
    // A group collapses and expands.
    service.toggleGroup(id, 'a')
    expect(service.getSnapshot().documents[id].collapsed).toEqual(['a'])
    service.toggleGroup(id, 'a')
    expect(service.getSnapshot().documents[id].collapsed).toEqual([])
    service.dispose()
  })

  it('adds servers that connect to an All servers search, names the ones that leave, and shows a failed server in its group', async () => {
    const { service, calls, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a'), connection('b')])
    const id = service.open('a', undefined, true)!
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    pendingSearch[0](answer([hit]))
    pendingSearch[1](answer([hit]))
    await settle()
    // A server connects: it gets an index, and the search runs again on all three.
    connections.set([connection('a'), connection('b'), connection('c')])
    expect(calls.index.map(call => call.connectionId)).toEqual(['a', 'b', 'c'])
    expect(calls.search.slice(2).map(call => call.connectionId)).toEqual(['a', 'b', 'c'])
    pendingSearch[2](answer([hit]))
    pendingSearch[3](answer([hit]))
    pendingSearch[4]({ ok: false, error: 'The search timed out.', code: 'TIMEOUT' })
    await settle()
    const document = service.getSnapshot().documents[id]
    expect(serverGroups(document).map(group => [group.connectionId, group.hits.length, group.error])).toEqual([['a', 1, undefined], ['b', 1, undefined], ['c', 0, 'The search timed out.']])
    expect(groupNote(serverGroups(document)[2]!, undefined)).toBe('The search timed out.')
    expect(allServersSummary(document, {})).toBe('3 servers · 2 results · 1 ms · srv-c could not be searched')
    // A server is lost: the search runs again without it and names it.
    connections.set([connection('a'), connection('b', true), connection('c')])
    expect(calls.search.slice(5).map(call => call.connectionId)).toEqual(['a', 'c'])
    pendingSearch[5](answer([hit]))
    pendingSearch[6](answer([]))
    await settle()
    expect(service.getSnapshot().documents[id].left).toEqual(['srv-b'])
    expect(allServersSummary(service.getSnapshot().documents[id], { c: { connectionId: 'c', requestId: 'r', done: 1, total: 3, objects: 5 } }))
      .toBe('2 servers · 1 result · 1 ms · srv-c still indexing (1 of 3 databases) · srv-b disconnected')
    // Choosing one server ends the All servers search; choosing All again searches every server.
    service.setConnection(id, 'c')
    expect(service.getSnapshot().documents[id]).toMatchObject({ connectionId: 'c' })
    expect(service.getSnapshot().documents[id].allServers).toBeUndefined()
    expect(calls.search.at(-1)?.connectionId).toBe('c')
    service.setAllServers(id)
    expect(calls.search.slice(-2).map(call => call.connectionId)).toEqual(['a', 'c'])
    // Object Explorer's box never searches all servers.
    service.followExplorer('a')
    service.setAllServers(explorerSearchId)
    expect(service.getSnapshot().documents[explorerSearchId].allServers).toBeUndefined()
    service.dispose()
  })

  it('merges server answers: totals added, the slowest time, partial when any stopped early, and a problem only when every server had one', () => {
    const result = (overrides: Partial<ObjectSearchResult>): ObjectSearchResult => ({ hits: [hit], total: 1, partial: false, elapsedMs: 1, index: status(), ...overrides })
    expect(mergeAnswers([{ connectionId: 'a', label: 'a', error: 'down' }])).toBeUndefined()
    expect(mergeAnswers([{ connectionId: 'a', label: 'a', result: result({ partial: true, elapsedMs: 9 }) }, { connectionId: 'b', label: 'b', result: result({ problem: 'Too many matches.', hits: [], total: 0 }) }]))
      .toMatchObject({ total: 1, partial: true, elapsedMs: 9, hits: [hit] })
    expect(mergeAnswers([{ connectionId: 'a', label: 'a', result: result({ problem: 'The regular expression is not valid.', hits: [], total: 0 }) }]))
      .toMatchObject({ problem: 'The regular expression is not valid.' })
    expect(allIndexesSummary([])).toBe('No server has an index yet.')
    expect(allIndexesSummary([{ connectionId: 'a', done: 2, total: 2, objects: 40, status: status() }, { connectionId: 'b', requestId: 'r', done: 1, total: 4, objects: 7 }]))
      .toBe('Indexes: 47 objects on 2 servers · 1 indexing')
  })

  it('reports a failed search and clears results for empty text', async () => {
    const { service, pendingSearch, connections } = harness()
    connections.set([connection('a')])
    const id = service.open('a', 'x')!
    pendingSearch[0]({ ok: false, error: 'The backend is unavailable.' })
    await settle()
    expect(service.getSnapshot().documents[id].error).toBe('The backend is unavailable.')
    service.setQuery(id, { scope: 'names', text: '' })
    const cleared = service.getSnapshot().documents[id]
    expect(cleared).toMatchObject({ text: '', scope: 'names' })
    expect([cleared.error, cleared.result]).toEqual([undefined, undefined])
  })

  it('reveals a hit by its path from the server: the database, the folders above its listing, a trigger\'s table or view', async () => {
    const { service } = harness()
    const seeks: unknown[][] = []
    const host: RevealHost = { seek: async (connectionId, paths) => { seeks.push([connectionId, paths]); return { ok: true, nodeId: 9 } } }
    expect(await service.reveal(host, 'a', hit)).toEqual({ ok: true, nodeId: 9 })
    const server = { kind: 'server' }, sales = { kind: 'database', name: 'Sales' }
    const databases = { type: 'folder', owner: server, folder: 'databases' }, system = { type: 'folder', owner: server, folder: 'systemDatabases' }
    const tail = [{ type: 'object', object: sales }, { type: 'folder', owner: sales, folder: 'tables' }, { type: 'object', object: hit.object }]
    expect(seeks[0]).toEqual(['a', [[databases, ...tail], [databases, system, ...tail]]])
    // Nested folders come outermost first; master is looked for under System Databases first.
    const fn: ObjectSearchHit = { object: { kind: 'function', database: 'master', schema: 'dbo', name: 'f' }, folder: 'scalarValuedFunctions', label: 'dbo.f' }
    const master = { kind: 'database', name: 'master' }
    expect(revealPaths(fn)[0]).toEqual([databases, system, { type: 'object', object: master }, ...['programmability', 'functions', 'scalarValuedFunctions'].map(folder => ({ type: 'folder', owner: master, folder })), { type: 'object', object: fn.object }])
    const trigger: ObjectSearchHit = { object: { kind: 'trigger', database: 'Sales', name: 't', parent: { kind: 'view', schema: 'dbo', name: 'V' } }, folder: 'tableTriggers', label: 'dbo.V.t' }
    const view = { kind: 'view', database: 'Sales', schema: 'dbo', name: 'V' }
    expect(revealPaths(trigger)[0].slice(2)).toEqual([{ type: 'folder', owner: sales, folder: 'views' }, { type: 'object', object: view }, { type: 'folder', owner: view, folder: 'tableTriggers' }, { type: 'object', object: trigger.object }])
    // A trigger's table may be a system one (Tables › System Tables), tried after Tables, in each databases folder.
    const onTable: ObjectSearchHit = { object: { kind: 'trigger', database: 'msdb', name: 't', parent: { kind: 'table', schema: 'dbo', name: 'sysjobs' } }, folder: 'tableTriggers', label: 'dbo.sysjobs.t' }
    const msdb = { kind: 'database', name: 'msdb' }
    expect(revealPaths(onTable).map(path => path.filter(step => step.type === 'folder').map(step => step.type === 'folder' ? step.folder : ''))).toEqual([
      ['databases', 'systemDatabases', 'tables', 'tableTriggers'], ['databases', 'systemDatabases', 'tables', 'systemTables', 'tableTriggers'],
      ['databases', 'tables', 'tableTriggers'], ['databases', 'tables', 'systemTables', 'tableTriggers']
    ])
    expect(revealPaths(onTable)[1]).toContainEqual({ type: 'folder', owner: msdb, folder: 'systemTables' })
  })

  it('reveals a hit below its schema\'s row while Object Explorer groups by schema', async () => {
    const { service } = harness()
    const seeks: unknown[][] = []
    const host: RevealHost = { groupBySchema: true, seek: async (connectionId, paths) => { seeks.push([connectionId, paths]); return { ok: true, nodeId: 9 } } }
    await service.reveal(host, 'a', hit)
    const server = { kind: 'server' }, sales = { kind: 'database', name: 'Sales' }, dbo = { kind: 'schema', database: 'Sales', name: 'dbo' }
    const databases = { type: 'folder', owner: server, folder: 'databases' }
    expect((seeks[0][1] as unknown[][])[0]).toEqual([databases, { type: 'object', object: sales }, { type: 'object', object: dbo }, { type: 'folder', owner: dbo, folder: 'tables' }, { type: 'object', object: hit.object }])
    // Nested folders hang below the schema row too.
    const fn: ObjectSearchHit = { object: { kind: 'function', database: 'Sales', schema: 'calc', name: 'f' }, folder: 'scalarValuedFunctions', label: 'calc.f' }
    const calc = { kind: 'schema', database: 'Sales', name: 'calc' }
    expect(revealPaths(fn, true)[0].slice(1)).toEqual([{ type: 'object', object: sales }, { type: 'object', object: calc },
      ...['programmability', 'functions', 'scalarValuedFunctions'].map(folder => ({ type: 'folder', owner: calc, folder })), { type: 'object', object: fn.object }])
    // A trigger's table is found below the table's schema, then in that schema's System Tables.
    const trigger: ObjectSearchHit = { object: { kind: 'trigger', database: 'Sales', name: 't', parent: { kind: 'table', schema: 'hr', name: 'People' } }, folder: 'tableTriggers', label: 'hr.People.t' }
    const hr = { kind: 'schema', database: 'Sales', name: 'hr' }, people = { kind: 'table', database: 'Sales', schema: 'hr', name: 'People' }
    expect(revealPaths(trigger, true).slice(0, 2).map(path => path.slice(1))).toEqual([
      [{ type: 'object', object: sales }, { type: 'object', object: hr }, { type: 'folder', owner: hr, folder: 'tables' }, { type: 'object', object: people }, { type: 'folder', owner: people, folder: 'tableTriggers' }, { type: 'object', object: trigger.object }],
      [{ type: 'object', object: sales }, { type: 'object', object: hr }, { type: 'folder', owner: hr, folder: 'tables' }, { type: 'folder', owner: hr, folder: 'systemTables' }, { type: 'object', object: people },
        { type: 'folder', owner: people, folder: 'tableTriggers' }, { type: 'object', object: trigger.object }]
    ])
    // Database-scoped objects stay below the database, in its own Programmability folder.
    const ddl: ObjectSearchHit = { object: { kind: 'databaseTrigger', database: 'Sales', name: 'audit' }, folder: 'databaseTriggers', label: 'audit' }
    expect(revealPaths(ddl, true)[0].slice(1)).toEqual([{ type: 'object', object: sales }, ...['programmability', 'databaseTriggers'].map(folder => ({ type: 'folder', owner: sales, folder })), { type: 'object', object: ddl.object }])
    expect(revealPaths(ddl, true)).toEqual(revealPaths(ddl))
  })

  it('reveals server objects and databases below the server, and a child under the folder its hit names', () => {
    const server = { kind: 'server' }
    const login: ObjectSearchHit = { object: { kind: 'login', name: 'app' }, folder: 'logins', label: 'app', subtype: 'sql' }
    expect(revealPaths(login)).toEqual([[{ type: 'folder', owner: server, folder: 'serverSecurity' }, { type: 'folder', owner: server, folder: 'logins' }, { type: 'object', object: login.object }]])
    const database: ObjectSearchHit = { object: { kind: 'database', name: 'Sales' }, folder: 'databases', label: 'Sales' }
    expect(revealPaths(database)).toEqual([[{ type: 'folder', owner: server, folder: 'databases' }, { type: 'object', object: database.object }]])
    const snapshot: ObjectSearchHit = { object: { kind: 'database', name: 'Sales_snap' }, folder: 'databaseSnapshots', label: 'Sales_snap', subtype: 'snapshot' }
    expect(revealPaths(snapshot)[0].map(step => step.type === 'folder' ? step.folder : 'object')).toEqual(['databases', 'databaseSnapshots', 'object'])
    // A graph table's column: the hit names the table's folder, so only that path is walked.
    const column: ObjectSearchHit = { object: { kind: 'column', database: 'Sales', name: 'id', parent: { kind: 'table', schema: 'dbo', name: 'Person' } }, folder: 'columns', label: 'dbo.Person.id', parentFolder: 'graphTables' }
    const sales = { kind: 'database', name: 'Sales' }, table = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Person' }
    expect(revealPaths(column)[0].slice(2)).toEqual([{ type: 'folder', owner: sales, folder: 'tables' }, { type: 'folder', owner: sales, folder: 'graphTables' }, { type: 'object', object: table },
      { type: 'folder', owner: table, folder: 'columns' }, { type: 'object', object: column.object }])
    expect(revealPaths(column)).toHaveLength(2)
    // Without a parent folder a parameter's procedure is looked for under Stored Procedures, then System Stored Procedures.
    const parameter: ObjectSearchHit = { object: { kind: 'parameter', database: 'Sales', name: '@id', parent: { kind: 'procedure', schema: 'dbo', name: 'p' } }, folder: 'parameters', label: 'dbo.p.@id' }
    expect(revealPaths(parameter).slice(0, 2).map(path => path.flatMap(step => step.type === 'folder' ? [step.folder] : []))).toEqual([
      ['databases', 'programmability', 'storedProcedures', 'parameters'], ['databases', 'programmability', 'storedProcedures', 'systemStoredProcedures', 'parameters']
    ])
    // A temporal history table is the history row below its table, and its columns are below it.
    const prices = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Prices' }
    const history: ObjectSearchHit = { object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Prices_History' }, folder: 'tables', label: 'dbo.Prices_History', subtype: 'history',
      via: { schema: 'dbo', name: 'Prices', folder: 'tables' } }
    expect(revealPaths(history)[0].slice(2)).toEqual([{ type: 'folder', owner: sales, folder: 'tables' }, { type: 'object', object: prices }, { type: 'object', object: history.object }])
    const historyColumn: ObjectSearchHit = { object: { kind: 'column', database: 'Sales', name: 'valid_from', parent: { kind: 'table', schema: 'dbo', name: 'Prices_History' } }, folder: 'columns',
      label: 'dbo.Prices_History.valid_from', parentFolder: 'tables', via: { schema: 'dbo', name: 'Prices', folder: 'tables' } }
    expect(revealPaths(historyColumn)[0].slice(2)).toEqual([{ type: 'folder', owner: sales, folder: 'tables' }, { type: 'object', object: prices }, { type: 'object', object: history.object },
      { type: 'folder', owner: history.object, folder: 'columns' }, { type: 'object', object: historyColumn.object }])
    const user: ObjectSearchHit = { object: { kind: 'user', database: 'Sales', name: 'app' }, folder: 'users', label: 'app' }
    expect(revealPaths(user)[0].slice(2).map(step => step.type === 'folder' ? step.folder : 'object')).toEqual(['databaseSecurity', 'users', 'object'])
  })

  it('shows where a hit is: a server object\'s folders, else its database and folder', () => {
    expect(searchHitPath({ object: { kind: 'login', name: 'app' }, folder: 'logins', label: 'app' })).toBe('Security › Logins')
    expect(searchHitPath({ object: { kind: 'database', name: 'Sales' }, folder: 'systemDatabases', label: 'Sales' })).toBe('Databases › System Databases')
    expect(searchHitPath({ object: { kind: 'column', database: 'Sales', name: 'id', parent: { kind: 'table', schema: 'dbo', name: 'T' } }, folder: 'columns', label: 'dbo.T.id' })).toBe('Sales › Columns')
  })

  it('runs Object Explorer\'s box as one more search, on the selected server or the first connected one', () => {
    const { service, connections, calls } = harness({ indexOnConnect: false })
    service.followExplorer(undefined)
    expect(service.getSnapshot().documents[explorerSearchId]).toBeUndefined()
    connections.set([connection('a'), connection('b')])
    service.followExplorer(undefined)
    expect(service.getSnapshot().documents[explorerSearchId]).toMatchObject({ connectionId: 'a', text: '', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all', types: [] })
    expect(calls.index.map(call => call.connectionId)).toEqual(['a'])
    service.setQuery(explorerSearchId, { text: 'ord', wholeWord: true })
    service.search(explorerSearchId)
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'a', text: 'ord', wholeWord: true })
    expect(calls.search.at(-1)).not.toHaveProperty('match')
    // Fuzzy Match is sent as match: 'fuzzy', and not while Regex is on, which keeps the setting for when Regex goes off.
    service.setQuery(explorerSearchId, { fuzzy: true })
    service.search(explorerSearchId)
    expect(calls.search.at(-1)).toMatchObject({ text: 'ord', match: 'fuzzy' })
    service.setQuery(explorerSearchId, { regex: true })
    service.search(explorerSearchId)
    expect(calls.search.at(-1)).toMatchObject({ regex: true })
    expect(calls.search.at(-1)).not.toHaveProperty('match')
    expect(service.getSnapshot().documents[explorerSearchId]).toMatchObject({ fuzzy: true, regex: true })
    service.setQuery(explorerSearchId, { regex: false, fuzzy: false })
    // Selecting a node on another server moves the box there, keeping its text and options, and indexes that server.
    service.followExplorer('b')
    expect(service.getSnapshot().documents[explorerSearchId]).toMatchObject({ connectionId: 'b', text: 'ord', wholeWord: true })
    expect(calls.index.map(call => call.connectionId)).toEqual(['a', 'b'])
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'b', text: 'ord', wholeWord: true })
    // A lost server falls back to the first connected one.
    connections.set([connection('a'), connection('b', true)])
    service.followExplorer('b')
    expect(service.getSnapshot().documents[explorerSearchId]?.connectionId).toBe('a')
  })

  it('hands focus to the box once per Search in Object Explorer, even when the box mounts later', () => {
    const { service } = harness()
    expect(service.takePaneFocus()).toBe(false)
    service.focusPane()
    expect(service.takePaneFocus()).toBe(true)
    expect(service.takePaneFocus()).toBe(false)
  })

  it('sizes Object Explorer\'s search band by its splitter, within its limits, and back to its content', () => {
    const { service } = harness()
    expect(service.getSnapshot().paneSize).toBeUndefined()
    service.setPaneSize(0.4)
    expect(service.getSnapshot().paneSize).toBe(0.4)
    service.setPaneSize(2)
    expect(service.getSnapshot().paneSize).toBe(paneBandLimits.maximum)
    service.setPaneSize(-1)
    expect(service.getSnapshot().paneSize).toBe(paneBandLimits.minimum)
    service.setPaneSize(undefined)
    expect('paneSize' in service.getSnapshot()).toBe(false)
    expect(clampPaneBand(Number.NaN)).toBe(paneBandLimits.minimum)
    // A drag measures from the band's top over the whole pane: a pane 400 px tall, the band at its top + 40.
    expect(paneBandDrag(240, 140, 100, 500)).toBe(0.25)
    expect(paneBandDrag(600, 140, 100, 500)).toBe(paneBandLimits.maximum)
    expect(paneBandDrag(120, 140, 100, 100)).toBe(paneBandLimits.minimum)
    // Down moves the splitter down (a taller band), Up up; Home and End go to the ends; other keys do nothing.
    expect(paneBandKey(0.4, 'ArrowDown')).toBe(0.45)
    expect(paneBandKey(0.4, 'ArrowUp')).toBe(0.35)
    expect(paneBandKey(paneBandLimits.maximum, 'ArrowDown')).toBe(paneBandLimits.maximum)
    expect(paneBandKey(0.4, 'Home')).toBe(paneBandLimits.minimum)
    expect(paneBandKey(0.4, 'End')).toBe(paneBandLimits.maximum)
    expect(paneBandKey(0.4, 'PageDown')).toBeUndefined()
  })

  it('refuses a tab without a connected server, forgets a closed tab, and stops listening once disposed', () => {
    const { service, connections, hasListener, calls } = harness()
    expect(() => service.open()).toThrow('Connect to a server')
    connections.set([connection('a')])
    const id = service.open(undefined, 'x')!
    service.closed(id)
    expect(service.getSnapshot().documents[id]).toBeUndefined()
    expect(calls.cancel).toContainEqual([calls.search[0].requestId])
    service.dispose()
    expect(hasListener()).toBe(false)
  })
})

describe('Search Objects\' summary', () => {
  it('says what the index holds, or how far its build got', () => {
    expect(indexSummary({ connectionId: 'a', requestId: 'r', done: 1, total: 3, objects: 1200 }, undefined)).toBe('Indexing 1 of 3 databases (1,200 objects so far)…')
    expect(indexSummary(undefined, status({ skipped: [{ database: 'x', code: 'NO_DB_ACCESS', message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · 1 database skipped')
    expect(indexSummary(undefined, status({ definitions: false, indexed: 1 }))).toBe('Index: 40 objects (names only) in 1 database')
    expect(indexSummary(undefined, status({ skipped: [{ database: '', code: 'CATALOG_ERROR', message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · server objects skipped')
    expect(indexSummary(undefined, status({ skipped: [{ database: 'Big', code: childrenLeftOut, message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · columns and other children left out of 1 large database')
    expect(indexSummary(undefined, undefined)).toBe('This server has no index yet.')
    expect(indexSummary({ connectionId: 'a', done: 0, total: 0, objects: 0, error: 'Denied.' }, undefined)).toBe('The index could not be built: Denied.')
  })
})

describe('Search Objects type filters', () => {
  it('names the kinds of the types chosen, in the index’s order, and every kind when none is', () => {
    expect(searchTypeKinds([])).toBeUndefined()
    expect(searchTypeKinds(['columns'])).toEqual(['column'])
    expect(searchTypeKinds(['indexes', 'tables'])).toEqual(['table', 'key', 'constraint', 'index', 'statistic'])
    expect(searchTypeKinds(searchTypes.map(type => type.id))).toEqual([...searchKinds])
    expect(objectSearchParamsSchema.safeParse({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: 'x', kinds: searchTypeKinds(searchTypes.map(type => type.id)) }).success).toBe(true)
  })

  it('toggles a type in the chips’ order and sums up what is chosen', () => {
    expect(toggleSearchType([], 'schemas')).toEqual(['schemas'])
    expect(toggleSearchType(['schemas'], 'tables')).toEqual(['tables', 'schemas'])
    expect(toggleSearchType(['tables', 'schemas'], 'tables')).toEqual(['schemas'])
    expect(searchFilterSummary('all', [])).toBe('All')
    expect(searchFilterSummary('names', [])).toBe('Names')
    expect(searchFilterSummary('definitions', ['schemas', 'procedures'])).toBe('Definitions, Procedures, Schemas')
  })

  it('fits every chip, then as many as fit before "+n more", then collapses to the Filters button', () => {
    const base = { options: 0, scope: 180, chips: [60, 50, 50, 70], more: 64, gap: 4 }
    // 60 + 4 + 50 + 4 + 50 + 4 + 70 = 242.
    expect(layoutFilters({ ...base, available: 242 })).toEqual({ collapsed: false, shown: 4 })
    // Two chips and the more button: 60 + 4 + 50 + 4 + 64 = 182; a third would need 236.
    expect(layoutFilters({ ...base, available: 235 })).toEqual({ collapsed: false, shown: 2 })
    expect(layoutFilters({ ...base, available: 236 })).toEqual({ collapsed: false, shown: 3 })
    // Too narrow for the scope's segments, or for minimumChips chips before the more button.
    expect(layoutFilters({ ...base, available: 179 })).toEqual({ collapsed: true, shown: 0 })
    expect(minimumChips).toBe(2)
    expect(layoutFilters({ ...base, scope: 100, available: 181 })).toEqual({ collapsed: true, shown: 0 })
    // The tab's server picker takes its share of the scope row.
    expect(layoutFilters({ ...base, options: 100, available: 242 })).toEqual({ collapsed: true, shown: 0 })
    expect(layoutFilters({ ...base, available: 0 })).toEqual({ collapsed: true, shown: 0 })
  })
})

describe('definition match counts', () => {
  const match = (matches: number, uncounted?: boolean) => ({ line: 1, column: 1, preview: 'x', range: [0, 1] as const, before: false, after: false, matches, cut: false, ...(uncounted ? { uncounted } : {}) })
  it('shows a count cut short by the search budget as a lower bound', () => {
    expect(moreMatches(match(1))).toBeUndefined()
    expect(moreMatches(match(13))).toBe('+12 more')
    expect(moreMatches(match(999))).toBe('+998+ more')
    // Past the budget the backend stops counting: 13 counted may be 50 in the definition, and 1 counted may be more.
    expect(moreMatches(match(13, true))).toBe('+12+ more')
    expect(moreMatches(match(1, true))).toBe('more not counted')
  })
})
