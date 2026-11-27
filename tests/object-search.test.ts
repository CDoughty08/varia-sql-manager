import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { methodPolicies } from '../src/shared/ipc/methods'
import { requestSchemas } from '../src/main/validation'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { indexProgressRelay } from '../src/main/index-progress'
import {
  childrenLeftOut, unknownKindBadge, objectIndexParamsSchema, objectIndexStatusParamsSchema, objectIndexProgressEventSchema, objectSearchLimits, objectSearchParamsSchema, searchKindBadge, searchKinds, searchKindTones, searchTypeKinds, searchTypes, unindexedKinds, agentSearchKinds,
  bigQuerySearchKinds, bigQuerySearchVariants, providerSearchKinds, searchHitNames, searchKindFilters,
  type ObjectIndexProgress, type ObjectIndexResult, type ObjectIndexStatus, type ObjectSearchHit, type ObjectSearchResult
} from '../src/shared/explorer/search'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Timers } from '../src/renderer/src/core/timers'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { explorerSearchId, hitServer, mergeAnswers, ObjectSearchService, quickSearchHits, quickSearchId, revealPaths, serverGroups, shownHits, unknownKindReveal, type ObjectSearchOptions, type RevealHost } from '../src/renderer/src/search/ObjectSearchService'
import { searchHitTarget } from '../src/renderer/src/search/hit-actions'
import { insertTextFor } from '../src/shared/explorer/refs'
import { indexSummary, searchHitPath, unindexedServers } from '../src/renderer/src/search/ObjectSearch'
import { allIndexesSummary, allServersSummary, bigQueryIndexSummary, BigQueryScope, DatabaseScope, groupNote, indexGap, indexIncomplete, indexMemoryNote, indexMemoryShort, indexedCount, KindBadge, listTabStop, moreMatches, searchHitLabel, searchProviders, stopForKey } from '../src/renderer/src/search/SearchPanel'
import { indexStatusText } from '../src/renderer/src/search/IndexStatus'
import { settingDef } from '../src/shared/settings/catalog'
import { kindSpecs, nodeKinds } from '../src/shared/explorer/catalog'
import { colorKeys } from '../src/shared/theme/registry'
import { layoutFilters, minimumChips } from '../src/renderer/src/search/filter-layout'
import { searchFilterSummary, shownSearchTypes, toggleSearchType } from '../src/renderer/src/search/SearchFilters'
import { clampPaneBand, paneBandDrag, paneBandKey, paneBandLimits } from '../src/renderer/src/search/pane-band'
import ServerPicker, { allServersValue, serverOptionName, serverPickerOptions, typeAheadMatch } from '../src/renderer/src/search/ServerPicker'

// The server picker draws each server's colour through the theme, which server rendering has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({ ...await original<object>(), useConnectionAccent: () => undefined }))

const csharp = (file: string) => readFileSync(new URL('../backend/Varia.Backend/Search/' + file, import.meta.url), 'utf8')

describe('object search contracts', () => {
  it('mirrors the backend\'s limits and kinds', () => {
    const service = csharp('ObjectSearchService.cs'), index = csharp('ObjectIndex.cs')
    expect(service).toContain(`public const int MaxText = ${objectSearchLimits.text};`)
    expect(service).toContain(`public const int MaxLimit = ${objectSearchLimits.hits};`)
    expect(service).toContain(`public const int DefaultLimit = ${objectSearchLimits.defaultHits};`)
    expect(service).toContain(`public const int MaxSkipped = ${objectSearchLimits.skipped};`)
    expect(service).toContain(`Kinds = [${searchKinds.map(kind => `"${kind}"`).join(', ')}]`)
    expect(csharp('ObjectSearchService.BigQuery.cs')).toContain(`BigQueryKinds = [${bigQuerySearchKinds.map(kind => `"${kind}"`).join(', ')}, .. SearchQuery.Variants]`)
    expect(index).toContain(`Variants = [${bigQuerySearchVariants.map(kind => `"${kind}"`).join(', ')}]`)
    const limits = readFileSync(new URL('../backend/Varia.Backend/Search/BigQueryIndex.cs', import.meta.url), 'utf8').replaceAll('_', '')
    for (const [name, value] of Object.entries(objectSearchLimits.bigQuery)) expect(limits).toContain(`public const int ${name[0].toUpperCase() + name.slice(1)} = ${value};`)
    expect(service).toContain(`Unindexed = [${unindexedKinds.map(kind => `"${kind}"`).join(', ')}]`)
    expect(service).toContain(`public const int MaxKinds = ${objectSearchLimits.kinds};`)
    const fuzzy = csharp('FuzzyName.cs')
    expect(fuzzy).toContain(`public const int MaxWords = ${objectSearchLimits.fuzzyWords};`)
    expect(fuzzy).toContain(`public const int MaxWordChars = ${objectSearchLimits.fuzzyWordChars};`)
    expect(service).toContain(`public const string ChildrenLeftOut = "${childrenLeftOut}";`)
    expect(index).toContain(`SearchBudget { get; set; } = TimeSpan.FromSeconds(${objectSearchLimits.searchMs / 1000});`)
    expect(index).toContain(`DatabaseBudget { get; set; } = TimeSpan.FromSeconds(${objectSearchLimits.databaseMs / 1000});`)
    expect(index).toContain(`DefinitionChars { get; init; } = ${objectSearchLimits.definitionChars.toLocaleString('en-US').replaceAll(',', '_')};`)
    // The memory limit is Options' (objectExplorer.search.memoryLimitMiB): its default and bounds, the names' reserve as a part
    // of it, and the floors BigQuery's reads keep free, in sixteenths of the limit (multiples of the reserve in C#).
    const memory = objectSearchLimits.memoryMiB
    expect(index).toContain(`public const int DefaultMemoryMiB = ${memory.default};`)
    expect(index).toContain(`public const int MinMemoryMiB = ${memory.min};`)
    expect(index.replaceAll('_', '')).toContain(`public const int MaxMemoryMiB = ${memory.max};`)
    expect(index).toContain(`public const int NamesReserveShare = ${objectSearchLimits.namesReserveShare};`)
    expect(index).toContain('MemoryBytes { get; set; } = DefaultMemoryMiB * 1024L * 1024;')
    expect(index).toContain('NamesReserveBytes { get; set; } = DefaultMemoryMiB * 1024L * 1024 / NamesReserveShare;')
    expect(objectSearchLimits.memoryBytes).toBe(memory.default * 1024 * 1024)
    expect(objectSearchLimits.namesReserveBytes).toBe(objectSearchLimits.memoryBytes / objectSearchLimits.namesReserveShare)
    expect(index).toContain('BigQueryNamesFloorBytes => NamesReserveBytes + NamesReserveBytes / 2;')
    expect(index).toContain('BigQueryDetailsFloorBytes => NamesReserveBytes + NamesReserveBytes / 4 * 3;')
    expect(index).toContain('BigQueryDiscoveredFloorBytes => NamesReserveBytes * 2;')
    const reserve16 = 16 / objectSearchLimits.namesReserveShare
    expect(objectSearchLimits.bigQueryFloors).toEqual({ names: reserve16 * 1.5, details: reserve16 * 1.75, discovered: reserve16 * 2 })
    // The setting offers exactly what the backend accepts.
    expect(settingDef('objectExplorer.search.memoryLimitMiB')).toMatchObject({ type: 'integer', min: memory.min, max: memory.max, default: memory.default, unit: 'MiB' })
  })

  it('indexes every kind Object Explorer lists but the server, return values and the SSIS Catalog\'s', () => {
    const listed = nodeKinds.filter(kind => !['server', 'childUnnamed'].includes(kindSpecs[kind].scope) && !kindSpecs[kind].scope.startsWith('ssis') && !kindSpecs[kind].scope.startsWith('bq') && !(unindexedKinds as readonly string[]).includes(kind))
    expect([...searchKinds].sort()).toEqual([...listed].sort())
    expect(searchKinds.length).toBeLessThanOrEqual(objectSearchLimits.kinds)
    // BigQuery: every kind Object Explorer lists but the project, which is the index's own unit.
    const bigQuery = nodeKinds.filter(kind => kindSpecs[kind].scope.startsWith('bq') && kind !== 'bqProject')
    expect([...bigQuerySearchKinds].sort()).toEqual([...bigQuery].sort())
    // Each variant names a kind and one of its subtypes in the catalogue.
    for (const variant of bigQuerySearchVariants) {
      const [kind, subtype] = variant.split(':') as [keyof typeof kindSpecs, string]
      expect((kindSpecs[kind].subtypes ?? []) as readonly string[], variant).toContain(subtype)
    }
    // Each engine's whole list fits one request.
    expect(providerSearchKinds('sqlserver').length).toBeLessThanOrEqual(objectSearchLimits.kinds)
    expect(providerSearchKinds('bigquery')).toEqual([...bigQuerySearchKinds, ...bigQuerySearchVariants])
    // The type filters name every kind and variant exactly once, so a kind can neither be unreachable nor in two chips.
    const typed = searchTypes.flatMap(type => [...type.kinds])
    expect([...typed].sort()).toEqual([...searchKindFilters].sort())
    expect(new Set(searchTypes.map(type => type.id)).size).toBe(searchTypes.length)
    // A chip's kinds are all of the engines it shows for.
    for (const type of searchTypes)
      for (const kind of type.kinds) expect(type.providers as readonly string[], `${type.id}: ${kind}`).toContain(kind.startsWith('bq') ? 'bigquery' : 'sqlserver')
  })

  it('gives every kind a one-letter badge in a tone the theme colours', () => {
    expect(searchKinds.map(kind => searchKindBadge(kind)).every(badge => /^[A-Z]$/.test(badge.letters) && searchKindTones.includes(badge.tone))).toBe(true)
    // BigQuery's, as its mock draws them: one letter, but ML for a model.
    expect(bigQuerySearchKinds.map(kind => searchKindBadge(kind).letters)).toEqual(['D', 'T', 'V', 'M', 'E', 'R', 'ML', 'C'])
    expect(bigQuerySearchKinds.every(kind => searchKindTones.includes(searchKindBadge(kind).tone))).toBe(true)
    expect((['table', 'view', 'procedure', 'function', 'column', 'login', 'index', 'database', 'synonym'] as const).map(kind => Object.values(searchKindBadge(kind)).join(' ')))
      .toEqual(['T table', 'V view', 'P procedure', 'F function', 'C column', 'L security', 'I key', 'D database', 'S other'])
    // A kind this build does not know (a newer backend's, or one missing from the type filters) still renders, as '?'.
    expect(searchKindBadge('futureKind')).toEqual(unknownKindBadge)
    expect(searchKindBadge('toString')).toEqual(unknownKindBadge)
    expect(renderToStaticMarkup(createElement(KindBadge, { kind: 'futureKind' }))).toBe('<span class="object-search-kind" data-tone="other" aria-hidden="true">?</span>')
    expect(renderToStaticMarkup(createElement(KindBadge, { kind: 'table' }))).toBe('<span class="object-search-kind" data-tone="table" aria-hidden="true">T</span>')
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
    // BigQuery's: a project and dataset (a dataset needs its project, and neither goes with a database), and the kinds' variants.
    expect(ok({ project: 'varia-alpha', dataset: 'sales', kinds: ['bqTable:clone', 'bqColumn'] })).toBe(true)
    expect(ok({ kinds: providerSearchKinds('bigquery') })).toBe(true)
    for (const bad of [{ dataset: 'sales' }, { project: 'varia-alpha', database: 'Sales' }, { project: 'Bad Project' }, { project: 'varia-alpha', dataset: 'bad-name' }, { kinds: ['bqTable:view'] }, { kinds: ['bqProject'] }])
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
    const index = (params: object) => objectIndexParamsSchema.safeParse({ ...ids, ...params }).success
    expect(index({ allProjects: false, starredProjects: ['varia-alpha', 'varia-beta'], scope: { project: 'varia-alpha', dataset: 'sales' } })).toBe(true)
    expect(index({ allProjects: true, maxProjects: 1, starredProjects: [] })).toBe(true)
    expect(index({ allProjects: true, maxProjects: objectSearchLimits.bigQuery.maxProjectsCap })).toBe(true)
    expect(index({ scope: { project: 'varia-alpha' } })).toBe(true)
    expect(index({ scope: { project: 'varia-alpha' }, missingOnly: true })).toBe(true)
    expect(index({ stale: true })).toBe(true)
    // The memory limit rides on either engine's build, within the setting's bounds.
    for (const memoryLimitMiB of [objectSearchLimits.memoryMiB.min, objectSearchLimits.memoryMiB.default, objectSearchLimits.memoryMiB.max]) expect(index({ memoryLimitMiB })).toBe(true)
    for (const memoryLimitMiB of [objectSearchLimits.memoryMiB.min - 1, objectSearchLimits.memoryMiB.max + 1, 0, -512, 512.5, '512', null])
      expect(index({ memoryLimitMiB }), String(memoryLimitMiB)).toBe(false)
    for (const bad of [
      { scope: { project: 'varia-alpha' }, stale: true }, { missingOnly: true }, { scope: { project: 'varia-alpha' }, missingOnly: false }, { stale: false }, { scope: { dataset: 'sales' } }, { scope: { project: 'varia-alpha', extra: 1 } }, { scope: { project: 'x' } },
      { extraDetails: true }, { allProjects: 'yes' }, { maxProjects: 0 }, { maxProjects: objectSearchLimits.bigQuery.maxProjectsCap + 1 }, { maxProjects: 1.5 }, { maxProjects: '500' },
      { starredProjects: ['Bad Project'] },
      { starredProjects: Array.from({ length: objectSearchLimits.bigQuery.starredProjects + 1 }, (_, i) => `varia-proj-${i}`) }
    ])
      expect(index(bad), JSON.stringify(bad)).toBe(false)
    expect(requestSchemas['explorer.index']).toBe(objectIndexParamsSchema)
    expect(requestSchemas['explorer.indexStatus']).toBe(objectIndexStatusParamsSchema)
    expect(objectIndexStatusParamsSchema.safeParse({ connectionId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true)
    for (const bad of [{}, { connectionId: 'x' }, { connectionId: '00000000-0000-4000-8000-000000000001', requestId: '00000000-0000-4000-8000-000000000002' }])
      expect(objectIndexStatusParamsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(requestSchemas['explorer.search']).toBe(objectSearchParamsSchema)
  })

  it('runs both methods on the explorer lane, cancellable through varia:explorer-cancel', () => {
    // Both engines: BigQuery's connections are indexed and searched through the same methods.
    expect(methodPolicies['explorer.index']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 0, providers: ['sqlserver', 'bigquery'] })
    expect(methodPolicies['explorer.search']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 15_000, providers: ['sqlserver', 'bigquery'] })
    expect(methodPolicies['explorer.indexStatus']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 5_000, providers: ['sqlserver', 'bigquery'] })
    const channels = { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', activity: 'activity', connections: 'connections' }
    expect(cancellableRequests('explorer.index', channels)).toBe('explorer')
    expect(cancellableRequests('explorer.search', channels)).toBe('explorer')
  })

  it('accepts only well-formed progress EVENTs', () => {
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 1, total: 2, objects: 30 }).success).toBe(true)
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 0, total: 0, objects: 0, phase: 'projects' }).success).toBe(true)
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 1, total: 2, objects: 30, phase: 'details' }).success).toBe(true)
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 1, total: 2, objects: 30, phase: 'names', growing: true, throttled: true }).success).toBe(true)
    for (const bad of [{ done: 3, total: 2, objects: 0 }, { done: -1, total: 2, objects: 0 }, { done: 1, total: 2, objects: 1.5 }, { done: 1, total: 2, objects: 0, database: 'x' }, { done: 1, total: 2, objects: 0, phase: 'columns' },
      { done: 1, total: 2, objects: 0, growing: false }, { done: 1, total: 2, objects: 0, throttled: 'yes' }, { done: 1, total: 2, objects: 0, throttled: null }])
      expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', ...bad }).success).toBe(false)
  })

  it('accepts a saved index age only as the backend writes it: UTC to the second', () => {
    expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 0, total: 0, objects: 9, phase: 'names', savedAt: '2026-11-24T08:05:09Z' }).success).toBe(true)
    for (const savedAt of ['2026-11-24', '2026-11-24T08:05:09.123Z', '2026-11-24T08:05:09+01:00', '', 42, null, 'saved yesterday'])
      expect(objectIndexProgressEventSchema.safeParse({ type: 'explorer.index.progress', done: 0, total: 0, objects: 0, savedAt }).success).toBe(false)
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

  it('carries the BigQuery pass to the window, so its status names datasets or objects', () => {
    const target = window(), relay = indexProgressRelay('r', target)
    relay.event({ ...event(1), phase: 'details' })
    expect(target.pushed[0]).toEqual({ requestId: 'r', done: 1, total: 10, objects: 100, phase: 'details' })
  })

  it('carries a growing total and BigQuery throttling to the window, and leaves both out when absent', () => {
    const target = window(), relay = indexProgressRelay('r', target)
    relay.event({ ...event(1), phase: 'names', growing: true, throttled: true })
    vi.advanceTimersByTime(gap)
    relay.event({ ...event(2), phase: 'names' })
    expect(target.pushed).toEqual([
      { requestId: 'r', done: 1, total: 10, objects: 100, phase: 'names', growing: true, throttled: true },
      { requestId: 'r', done: 2, total: 10, objects: 200, phase: 'names' }])
  })

  it('carries a saved index age to the window, and leaves it out once nothing loaded is unchecked', () => {
    const target = window(), relay = indexProgressRelay('r', target)
    relay.event({ ...event(0, 0), phase: 'names', savedAt: '2026-11-24T08:05:09Z' })
    vi.advanceTimersByTime(gap)
    relay.event({ ...event(1), phase: 'names' })
    expect(target.pushed).toEqual([
      { requestId: 'r', done: 0, total: 0, objects: 0, phase: 'names', savedAt: '2026-11-24T08:05:09Z' },
      { requestId: 'r', done: 1, total: 10, objects: 100, phase: 'names' }])
  })
})

const status = (overrides: Partial<ObjectIndexStatus> = {}): ObjectIndexStatus => ({ state: 'ready', databases: 2, indexed: 2, objects: 40, modules: 5, cut: 0, skipped: [], definitions: true, ...overrides })
const hit: ObjectSearchHit = { object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' }, folder: 'tables', label: 'dbo.Orders', range: [4, 6] }

class Connections extends SnapshotStore<readonly LiveConnection[]> {
  set(list: readonly LiveConnection[]) { this.publish(list) }
  get = (id: string) => this.getSnapshot().find(connection => connection.id === id)
}
const connection = (id: string, lost = false) => ({ id, server: 'srv-' + id, database: 'master', serverVersion: '16.0', options: {}, ...lost ? { lost: true } : {} }) as unknown as LiveConnection

function harness(settings: { indexOnConnect?: boolean; definitions?: boolean; allProjects?: boolean; maxProjects?: number; memoryLimitMiB?: number; starredProjects?: (connectionId: string) => readonly string[] } = {}) {
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
  // Read from `settings` each time, so a test can change one as Options would.
  const values: Record<string, boolean | number> = { get 'objectExplorer.search.indexOnConnect'() { return settings.indexOnConnect ?? true }, get 'objectExplorer.search.definitions'() { return settings.definitions ?? true },
    get 'objectExplorer.search.bigQueryAccessibleProjects'() { return settings.allProjects ?? true },
    get 'objectExplorer.search.bigQueryMaxProjects'() { return settings.maxProjects ?? objectSearchLimits.bigQuery.maxProjects },
    get 'objectExplorer.search.memoryLimitMiB'() { return settings.memoryLimitMiB as number } }
  const listeners = new Set<(event: WorkbenchEvent) => void>()
  const events = { subscribe: (listener: (event: WorkbenchEvent) => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } }, emit: (event: WorkbenchEvent) => listeners.forEach(listener => listener(event)) }
  const timers: Timers & { run(): void } = (() => {
    const queue = new Map<number, () => void>()
    let next = 0
    return { setTimeout: (callback: () => void) => { queue.set(++next, callback); return next }, clearTimeout: handle => { queue.delete(handle as number) },
      run: () => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(callback => callback()) } }
  })()
  let ids = 0
  const service = new ObjectSearchService({
    api, documents, connections, settings: { get: (key => values[key]) as ObjectSearchOptions['settings']['get'] }, timers, newId: () => 'req' + ++ids, events,
    ...settings.starredProjects ? { starredProjects: settings.starredProjects } : {}
  })
  return { service, api, calls, pendingIndex, pendingSearch, connections, timers, registered, documents, events, emit: (value: ObjectIndexProgress) => progress?.(value), hasListener: () => !!progress }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const bigQueryConnection = (id: string) => ({ ...connection(id), providerId: 'bigquery', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } }) as unknown as LiveConnection
const bigQueryHit: ObjectSearchHit = { object: { kind: 'bqModel', project: 'varia-alpha', dataset: 'sales', name: 'orders_forecast' }, folder: 'bqModels', label: 'sales.orders_forecast', range: [6, 6] }

describe('ObjectSearchService', () => {
  it('carries a database scope through searches and rebuilds, clears it explicitly, and drops it when the server changes', async () => {
    const { service, calls, pendingIndex, connections, timers } = harness()
    connections.set([connection('a'), connection('b')])
    const database = ' Sales ] 2024 '
    const id = service.open('a', 'orders', false, database)!
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'a', text: 'orders', database })
    service.setQuery(id, { text: 'customers' })
    timers.run()
    expect(calls.search.at(-1)).toMatchObject({ text: 'customers', database })
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.search.at(-1)).toMatchObject({ text: 'customers', database })
    service.setQuery(id, { database: undefined })
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    service.setQuery(id, { database })
    service.setConnection(id, 'b')
    expect(service.getSnapshot().documents[id].database).toBeUndefined()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'b', text: 'customers' })
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    service.setQuery(id, { database })
    service.setAllServers(id)
    expect(service.getSnapshot().documents[id].database).toBeUndefined()
    expect(calls.search.slice(-2).every(call => call.database === undefined)).toBe(true)
    const all = service.open('a', 'orders', true, database)!
    expect(service.getSnapshot().documents[all].database).toBeUndefined()
    service.dispose()
  })

  it('shows a removable database scope with hidden characters made visible', () => {
    const html = renderToStaticMarkup(createElement(DatabaseScope, { database: 'Sales\u202e', onClear: () => {} }))
    expect(html).toContain('aria-label="Database scope"')
    expect(html).toContain('aria-label="Clear database scope: Sales⟨U+202E⟩"')
    expect(html).toContain('<bdi>Sales⟨U+202E⟩</bdi>')
    expect(html).toContain('title="Search all databases"')
  })

  it('shows a removable BigQuery project or dataset scope with hidden characters made visible', () => {
    const projectHtml = renderToStaticMarkup(createElement(BigQueryScope, { project: 'varia-alpha\u202e', onClear: () => {} }))
    expect(projectHtml).toContain('aria-label="Project scope"')
    expect(projectHtml).toContain('<span>Project</span>')
    expect(projectHtml).toContain('aria-label="Clear project scope: varia-alpha⟨U+202E⟩"')
    expect(projectHtml).toContain('<bdi>varia-alpha⟨U+202E⟩</bdi>')
    expect(projectHtml).toContain('title="Search all projects"')
    expect(projectHtml).toContain('codicon-project')

    const datasetHtml = renderToStaticMarkup(createElement(BigQueryScope, { project: 'varia-alpha', dataset: 'sales\u202e', onClear: () => {} }))
    expect(datasetHtml).toContain('aria-label="Dataset scope"')
    expect(datasetHtml).toContain('<span>Dataset</span>')
    expect(datasetHtml).toContain('aria-label="Clear dataset scope: varia-alpha.sales⟨U+202E⟩"')
    expect(datasetHtml).toContain('<bdi>varia-alpha.sales⟨U+202E⟩</bdi>')
    expect(datasetHtml).toContain('title="Search all datasets and projects"')
    expect(datasetHtml).not.toContain('codicon-project')
  })

  it('carries BigQuery project and dataset scopes cleanly, strips them on server switch or All servers, and prevents cross-engine scope leakage', async () => {
    const { service, calls, pendingIndex, connections, timers } = harness()
    connections.set([bigQueryConnection('bq'), connection('a')])
    // Project-only scope on BigQuery.
    const projectTab = service.open('bq', 'orders', false, { project: 'varia-alpha' })!
    expect(service.getSnapshot().documents[projectTab]).toMatchObject({ project: 'varia-alpha' })
    expect(service.getSnapshot().documents[projectTab].dataset).toBeUndefined()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'bq', text: 'orders', project: 'varia-alpha' })
    expect(calls.search.at(-1)).not.toHaveProperty('dataset')
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    // Project + dataset scope carries through text changes and index rebuilds.
    const datasetTab = service.open('bq', 'orders', false, { project: 'varia-alpha', dataset: 'sales' })!
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'bq', text: 'orders', project: 'varia-alpha', dataset: 'sales' })
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    service.setQuery(datasetTab, { text: 'customers' })
    timers.run()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'bq', text: 'customers', project: 'varia-alpha', dataset: 'sales' })
    pendingIndex[0]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 3 }), elapsedMs: 1 } })
    await settle()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'bq', text: 'customers', project: 'varia-alpha', dataset: 'sales' })
    // Explicit clear removes both project and dataset.
    service.setQuery(datasetTab, { project: undefined, dataset: undefined })
    expect(calls.search.at(-1)).not.toHaveProperty('project')
    expect(calls.search.at(-1)).not.toHaveProperty('dataset')
    // Switching from BigQuery to SQL Server strips project and dataset.
    service.setQuery(datasetTab, { project: 'varia-alpha', dataset: 'sales' })
    service.setConnection(datasetTab, 'a')
    expect(service.getSnapshot().documents[datasetTab].project).toBeUndefined()
    expect(service.getSnapshot().documents[datasetTab].dataset).toBeUndefined()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'a', text: 'customers' })
    expect(calls.search.at(-1)).not.toHaveProperty('project')
    expect(calls.search.at(-1)).not.toHaveProperty('dataset')
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    // Enabling All servers from a scoped BigQuery tab strips project & dataset, so neither SQL Server nor BigQuery gets leaked scope.
    service.setConnection(datasetTab, 'bq')
    service.setQuery(datasetTab, { project: 'varia-alpha', dataset: 'sales' })
    const beforeAll = calls.search.length
    service.setAllServers(datasetTab)
    expect(service.getSnapshot().documents[datasetTab].project).toBeUndefined()
    expect(service.getSnapshot().documents[datasetTab].dataset).toBeUndefined()
    const allCalls = calls.search.slice(beforeAll)
    expect(allCalls.map(call => call.connectionId).sort()).toEqual(['a', 'bq'])
    for (const call of allCalls) {
      expect(call).not.toHaveProperty('database')
      expect(call).not.toHaveProperty('project')
      expect(call).not.toHaveProperty('dataset')
    }
    // Opening All servers ignores any passed scope.
    const allOpen = service.open('bq', 'orders', true, { project: 'varia-alpha', dataset: 'sales' })!
    expect(service.getSnapshot().documents[allOpen].project).toBeUndefined()
    expect(service.getSnapshot().documents[allOpen].dataset).toBeUndefined()
    // Strict provider isolation: SQL Server never receives project/dataset even if opened with them.
    const sqlWithBq = service.open('a', 'orders', false, { project: 'varia-alpha', dataset: 'sales' })!
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'a', text: 'orders' })
    expect(calls.search.at(-1)).not.toHaveProperty('project')
    expect(calls.search.at(-1)).not.toHaveProperty('dataset')
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    expect(service.getSnapshot().documents[sqlWithBq].project).toBe('varia-alpha')
    service.dispose()
  })

  it('sends Options\' index memory limit with every build, on either engine, as it is when the build starts', () => {
    const settings = { memoryLimitMiB: 1024 }
    const { service, calls, connections } = harness(settings)
    connections.set([connection('a'), { ...connection('bq'), providerId: 'bigquery', options: { provider: 'bigquery', project: 'varia-alpha' } } as unknown as LiveConnection])
    expect(calls.index.map(call => [call.connectionId, call.memoryLimitMiB])).toEqual([['a', 1024], ['bq', 1024]])
    // Changed in Options: nothing is sent until the next build, which carries it (a refresh of part of an index too).
    settings.memoryLimitMiB = 2048
    expect(calls.index).toHaveLength(2)
    service.build('a')
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'a', memoryLimitMiB: 2048 })
    service.dispose()
  })

  it('builds each server\'s index when it connects, with definitions as Options says, and drops it when the server goes', async () => {
    const { service, calls, pendingIndex, connections, emit } = harness({ definitions: false })
    connections.set([connection('a')])
    expect(calls.index).toEqual([{ connectionId: 'a', requestId: 'req1', definitions: false }])
    emit({ requestId: 'req1', done: 1, total: 3, objects: 12 })
    emit({ requestId: 'someone-else', done: 9, total: 9, objects: 9 })
    expect(service.getSnapshot().indexes.a).toMatchObject({ requestId: 'req1', done: 1, total: 3, objects: 12 })
    // A later event without the flags clears them: the build stopped being throttled and its total stopped growing.
    emit({ requestId: 'req1', done: 1, total: 3, objects: 12, phase: 'names', growing: true, throttled: true })
    expect(service.getSnapshot().indexes.a).toMatchObject({ growing: true, throttled: true })
    emit({ requestId: 'req1', done: 1, total: 3, objects: 12, phase: 'names', savedAt: '2026-11-24T08:05:09Z' })
    expect(service.getSnapshot().indexes.a).toMatchObject({ savedAt: '2026-11-24T08:05:09Z' })
    emit({ requestId: 'req1', done: 1, total: 3, objects: 12 })
    expect(service.getSnapshot().indexes.a).not.toHaveProperty('growing')
    expect(service.getSnapshot().indexes.a).not.toHaveProperty('throttled')
    expect(service.getSnapshot().indexes.a).not.toHaveProperty('savedAt')
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 5 } })
    await settle()
    expect(service.getSnapshot().indexes.a).toEqual({ connectionId: 'a', done: 2, total: 2, objects: 40, status: status() })
    connections.set([connection('a'), connection('b')])
    expect(calls.index.map(call => call.connectionId)).toEqual(['a', 'b'])
    connections.set([connection('a', true), connection('b')])
    expect(Object.keys(service.getSnapshot().indexes)).toEqual(['b'])
  })

  it('indexes BigQuery connections on connect, passing bigQueryAccessibleProjects, bigQueryMaxProjects and starredProjects to explorerIndex', async () => {
    const { service, calls, connections, pendingIndex } = harness({ allProjects: true, maxProjects: 1200, starredProjects: id => id === 'bq' ? ['varia-beta', 'bigquery-public-data'] : ['ignored'] })
    connections.set([bigQueryConnection('bq'), connection('a')])
    expect(calls.index).toEqual([
      { connectionId: 'bq', requestId: 'req1', definitions: true, allProjects: true, maxProjects: 1200, starredProjects: ['varia-beta', 'bigquery-public-data'] },
      { connectionId: 'a', requestId: 'req2', definitions: true }
    ])
    pendingIndex[0]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 3 }), elapsedMs: 1 } })
    await settle()
    expect(Object.keys(service.getSnapshot().indexes).sort()).toEqual(['a', 'bq'])
    // All servers spans it too.
    const id = service.open(undefined, 'orders', true)!
    expect(calls.search.filter(call => call.text === 'orders').map(call => call.connectionId).sort()).toEqual(['a', 'bq'])
    expect(service.getSnapshot().documents[id].allServers).toBe(true)
    // When allProjects is false and starredProjects is empty, maxProjects and starredProjects are omitted.
    const off = harness({ allProjects: false, maxProjects: 1200, starredProjects: () => [] })
    off.connections.set([bigQueryConnection('bq')])
    expect(off.calls.index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, allProjects: false }])
  })

  it('sends each engine only its own kinds, and a database scope only to SQL Server', async () => {
    const { service, calls, connections, pendingSearch } = harness()
    connections.set([bigQueryConnection('bq'), connection('a')])
    const id = service.open(undefined, 'orders', true)!
    const byServer = () => Object.fromEntries(calls.search.slice(-2).map(call => [call.connectionId, call]))
    // Every kind: neither search names any (each index holds only its own engine's kinds).
    expect(byServer().bq).not.toHaveProperty('kinds')
    expect(byServer().a).not.toHaveProperty('kinds')
    service.setQuery(id, { types: ['tables', 'columns'] })
    expect(byServer().bq.kinds).toEqual(['bqTable', 'bqColumn'])
    expect(byServer().a.kinds).toEqual(['table', 'column'])
    // A type only the other engine has: that server answers no hits without being asked.
    const before = calls.search.length
    service.setQuery(id, { types: ['bqModels'] })
    expect(calls.search.slice(before).map(call => call.connectionId)).toEqual(['bq'])
    expect(calls.search.at(-1)!.kinds).toEqual(['bqModel'])
    pendingSearch.at(-1)!({ ok: true, value: { hits: [bigQueryHit], total: 1, partial: false, elapsedMs: 3, index: status({ provider: 'bigquery' }) } })
    await settle()
    const groups = serverGroups(service.getSnapshot().documents[id])
    expect(groups.map(group => [group.connectionId, group.result?.total])).toEqual([['bq', 1], ['a', 0]])
    // The query's own problem (an invalid regular expression) is the merged answer's when every server asked has it: a server
    // that was not asked says nothing about it.
    service.setQuery(id, { text: '(' })
    service.setQuery(id, { types: ['bqModels'], regex: true })
    pendingSearch.at(-1)!({ ok: true, value: { hits: [], total: 0, partial: false, elapsedMs: 1, problem: 'Invalid regular expression.', index: status({ provider: 'bigquery' }) } })
    await settle()
    expect(service.getSnapshot().documents[id].result?.problem).toBe('Invalid regular expression.')
    // A database scope stays with SQL Server's search.
    const tab = service.open('bq', 'orders', false, 'Sales')!
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'bq', text: 'orders' })
    expect(calls.search.at(-1)).not.toHaveProperty('database')
    expect(service.getSnapshot().documents[tab].database).toBe('Sales')
  })

  it('re-reads part of a BigQuery index: a scope from Object Explorer\'s Refresh, the stale datasets after DDL, never cancelling a build', async () => {
    const { service, calls, connections, pendingIndex, documents, events } = harness()
    connections.set([bigQueryConnection('bq'), connection('a')])
    const [bq, sql] = [pendingIndex[0], pendingIndex[1]]
    // A build is running: the refresh waits for it.
    service.refreshNode('bq', { type: 'object', object: { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' } })
    expect(calls.index).toHaveLength(2)
    bq({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    expect(calls.index.at(-1)).toEqual({ connectionId: 'bq', requestId: 'req3', definitions: true, allProjects: true, maxProjects: 500, scope: { project: 'varia-alpha', dataset: 'sales' } })
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    // A project, a node below a dataset (its dataset), and the server's node (everything).
    service.refreshNode('bq', { type: 'object', object: { kind: 'bqProject', name: 'varia-beta' } })
    expect(calls.index.at(-1)).toMatchObject({ scope: { project: 'varia-beta' } })
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    service.refreshNode('bq', { type: 'folder', owner: { kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'orders' }, folder: 'bqColumns' })
    expect(calls.index.at(-1)).toMatchObject({ scope: { project: 'varia-alpha', dataset: 'sales' } })
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    service.refreshNode('bq', { type: 'object', object: { kind: 'server' } })
    expect(calls.index.at(-1)).toEqual({ connectionId: 'bq', requestId: expect.any(String), definitions: true, allProjects: true, maxProjects: 500 })
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    // SQL Server's nodes re-read nothing (its index has no scoped refresh).
    const count = calls.index.length
    service.refreshNode('a', { type: 'object', object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } })
    sql({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.index).toHaveLength(count)
    // A query tab's run whose result names a stale mark re-reads the datasets DDL marked; one naming none (whatever it ran), or a tab
    // on another server, re-reads nothing.
    vi.mocked(documents.get).mockImplementation(((tabId: string) => ({ id: tabId, connectionId: tabId === 'q1' ? 'bq' : 'a' })) as never)
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { job: { project: 'varia-alpha', jobId: 'j', statementType: 'CREATE_TABLE' } } as never })
    events.emit({ type: 'query.finished', tabId: 'q2', queryId: 'x', summary: { indexStale: 4 } as never })
    expect(calls.index).toHaveLength(count)
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { job: { project: 'varia-alpha', jobId: 'j', statementType: 'SELECT' }, indexStale: 4 } as never })
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'bq', stale: true })
    // Two refreshes asked during a build each run once after it, in order, and the same one twice runs once.
    service.refreshBigQuery('bq', { stale: true })
    service.refreshBigQuery('bq', { scope: { project: 'varia-alpha' } })
    service.refreshBigQuery('bq', { scope: { project: 'varia-alpha' } })
    const queued = calls.index.length
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    expect(calls.index.slice(queued)).toEqual([expect.objectContaining({ stale: true })])
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    expect(calls.index.slice(queued + 1)).toEqual([expect.objectContaining({ scope: { project: 'varia-alpha' } })])
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    expect(calls.index).toHaveLength(queued + 2)
    // A full rebuild drops the refreshes still waiting: it reads everything they would.
    service.build('bq')
    service.refreshBigQuery('bq', { stale: true })
    service.build('bq')
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    expect(calls.index.slice(queued + 2).map(call => call.stale ?? call.scope ?? 'full')).toEqual(['full', 'full'])
    // With no index yet, a refresh builds nothing: the first build reads everything.
    const fresh = harness({ indexOnConnect: false })
    fresh.connections.set([bigQueryConnection('bq')])
    fresh.service.refreshBigQuery('bq', { stale: true })
    expect(fresh.calls.index).toHaveLength(0)
  })

  it('asks one stale-only build per new stale mark, keeps a failed refresh off the index, queues the server\'s Refresh, and drops waiting refreshes on Stop', async () => {
    const { service, calls, connections, pendingIndex, pendingSearch, documents, events } = harness()
    const ok = { ok: true as const, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } }
    connections.set([bigQueryConnection('bq')])
    pendingIndex[0](ok)
    await settle()
    // A run that failed outright (no result) asks nothing: a mark its job leaves is named by the next result, search or build.
    vi.mocked(documents.get).mockImplementation(((tabId: string) => ({ id: tabId, connectionId: 'bq' })) as never)
    const before = calls.index.length
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', error: 'boom' } as never)
    expect(calls.index).toHaveLength(before)
    // A tab closed (or stopped) before its job finished: the job's mark comes later, and the next search's status names it.
    const id = service.open('bq', 'orders')!
    pendingSearch.at(-1)!({ ok: true, value: { hits: [], total: 0, partial: false, elapsedMs: 1, index: status({ provider: 'bigquery', staleMark: 7 }) } })
    await settle()
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'bq', stale: true })
    expect(calls.index).toHaveLength(before + 1)
    // A mark a failed read left keeps its number: neither the build's status nor the search it runs again asks another build.
    pendingIndex.at(-1)!({ ok: true, value: { status: status({ provider: 'bigquery', staleMark: 7 }), elapsedMs: 1 } })
    await settle()
    for (const answer of pendingSearch.splice(0)) answer({ ok: true, value: { hits: [], total: 0, partial: false, elapsedMs: 1, index: status({ provider: 'bigquery', staleMark: 7 }) } })
    await settle()
    expect(calls.index).toHaveLength(before + 1)
    // A newer mark (DDL while the build ran) asks once more.
    void service.search(id)
    pendingSearch.at(-1)!({ ok: true, value: { hits: [], total: 0, partial: false, elapsedMs: 1, index: status({ provider: 'bigquery', staleMark: 9 }) } })
    await settle()
    expect(calls.index).toHaveLength(before + 2)
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 9 } as never })
    expect(calls.index).toHaveLength(before + 2)
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 10 } as never })
    expect(calls.index).toHaveLength(before + 2)
    pendingIndex.at(-1)!(ok)
    await settle()
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'bq', stale: true })
    expect(calls.index).toHaveLength(before + 3)
    // That refresh failing leaves the index it refreshed searchable: no error on it.
    pendingIndex.at(-1)!({ ok: false, code: 'TIMEOUT', error: 'slow' })
    await settle()
    expect(service.getSnapshot().indexes.bq.error).toBeUndefined()
    expect(service.getSnapshot().indexes.bq.status?.state).toBe('ready')
    // A stale-only build that failed is asked again at the next hint of the same mark.
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 10 } as never })
    expect(calls.index).toHaveLength(before + 4)
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'bq', stale: true })
    pendingIndex.at(-1)!(ok)
    await settle()
    // The server's Refresh during a build waits for it, then reads everything.
    service.build('bq')
    service.refreshNode('bq', { type: 'object', object: { kind: 'server' } })
    const during = calls.index.length
    pendingIndex.at(-1)!(ok)
    await settle()
    expect(calls.index.slice(during)).toEqual([{ connectionId: 'bq', requestId: expect.any(String), definitions: true, allProjects: true, maxProjects: 500 }])
    pendingIndex.at(-1)!(ok)
    await settle()
    // Stop ends the refreshes waiting behind the build, and so does a build cancelled another way.
    service.build('bq')
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 11 } as never })
    service.stopBuild('bq')
    pendingIndex.at(-1)!({ ok: false, code: 'CANCELLED', error: 'stopped' })
    await settle()
    // A mark the user stopped reading is not asked again by the next hint of the same mark: only a newer one asks.
    const afterStop = calls.index.length
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 11 } as never })
    expect(calls.index).toHaveLength(afterStop)
    service.build('bq')
    service.refreshBigQuery('bq', { scope: { project: 'varia-alpha' } })
    const cancelled = calls.index.length
    pendingIndex.at(-1)!({ ok: false, code: 'CANCELLED', error: 'stopped' })
    await settle()
    expect(calls.index).toHaveLength(cancelled)
    // A build cancelled other than by Stop drops the refreshes behind it, and the mark is asked again at the next hint.
    events.emit({ type: 'query.finished', tabId: 'q1', queryId: 'x', summary: { indexStale: 11 } as never })
    expect(calls.index).toHaveLength(cancelled + 1)
    expect(calls.index.at(-1)).toMatchObject({ connectionId: 'bq', stale: true })
    pendingIndex.at(-1)!(ok)
    await settle()
    // A whole build's failure is the index's, and neither a refresh waiting behind it nor a later one hides it; a full one may.
    service.build('bq')
    service.refreshBigQuery('bq', { stale: true })
    const failing = calls.index.length
    pendingIndex.at(-1)!({ ok: false, code: 'TIMEOUT', error: 'slow' })
    await settle()
    expect(service.getSnapshot().indexes.bq.error).toBe('slow')
    service.refreshBigQuery('bq', { scope: { project: 'varia-alpha' } })
    expect(calls.index).toHaveLength(failing)
    service.refreshNode('bq', { type: 'object', object: { kind: 'server' } })
    expect(calls.index.at(-1)).not.toHaveProperty('stale')
    expect(calls.index).toHaveLength(failing + 1)
  })

  it('builds nothing until the user asks when Options turns indexing on connect off', () => {
    const { service, calls, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a'), connection('b')])
    // Opening a search, pointing it at another server or at all of them, Object Explorer's box, and searching: none builds.
    const id = service.open('a', 'orders')!
    service.setConnection(id, 'b')
    service.setAllServers(id)
    service.open(undefined, 'orders', true)
    service.followExplorer('a')
    service.followExplorer('b')
    connections.set([connection('a'), connection('b'), connection('c')])
    timers.run()
    expect(calls.search.length).toBeGreaterThan(0)
    expect(calls.index).toHaveLength(0)
    // Build index, and Rebuild Search Index.
    service.build('b')
    expect(calls.index.map(call => call.connectionId)).toEqual(['b'])
  })
  it('gives a server that has no index one when a search opens on it, while indexing on connect is on', () => {
    const values = { indexOnConnect: false }
    const { service, calls, connections } = harness(values)
    connections.set([connection('a'), connection('b')])
    expect(calls.index).toHaveLength(0)
    // Turned on after the servers connected.
    values.indexOnConnect = true
    service.open('a')
    expect(calls.index.map(call => call.connectionId)).toEqual(['a'])
    service.followExplorer('b')
    expect(calls.index.map(call => call.connectionId)).toEqual(['a', 'b'])
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

  it('reads the index status after a stopped first build, so what it read shows as a stopped index with Build index', async () => {
    const bq = (overrides: Partial<ObjectIndexStatus> = {}) => status({ provider: 'bigquery', ...overrides })
    const { service, api, pendingIndex, connections } = harness()
    const partial = bq({ indexed: 3, databases: 3, objects: 120, stopped: true })
    api.explorerIndexStatus = vi.fn(async () => ({ ok: true as const, value: { status: partial, elapsedMs: 0 } }))
    connections.set([bigQueryConnection('bq')])
    expect(service.getSnapshot().indexes.bq?.status).toBeUndefined()
    service.stopBuild('bq')
    pendingIndex[0]({ ok: false, code: 'CANCELLED', error: 'stopped' })
    await settle()
    expect(api.explorerIndexStatus).toHaveBeenCalledWith({ connectionId: 'bq' })
    const entry = service.getSnapshot().indexes.bq!
    expect(entry).toEqual({ connectionId: 'bq', done: 3, total: 3, objects: 120, status: partial })
    expect(indexSummary(entry, entry.status)).toBe('Index: 120 objects, 5 definitions in 3 datasets · build stopped')
    expect(indexIncomplete(entry, entry.status)).toBe(true)
    expect(unindexedServers(['bq'], service.getSnapshot().indexes)).toEqual(['bq'])
    expect(indexGap(entry)).toBe('build stopped')
    // A newer build that started before the status came back keeps its own entry, while it runs and after it finishes.
    let answer: (value: ApiResult<ObjectIndexResult>) => void = () => {}
    api.explorerIndexStatus = vi.fn(() => new Promise<ApiResult<ObjectIndexResult>>(resolve => { answer = resolve }))
    service.build('bq')
    service.stopBuild('bq')
    pendingIndex[1]({ ok: false, code: 'CANCELLED', error: 'stopped' })
    await settle()
    service.build('bq')
    const late = answer
    late({ ok: true, value: { status: bq({ state: 'none' }), elapsedMs: 0 } })
    await settle()
    expect(service.getSnapshot().indexes.bq).toMatchObject({ requestId: 'req3', status: partial })
    service.stopBuild('bq')
    pendingIndex[2]({ ok: false, code: 'CANCELLED', error: 'stopped' })
    await settle()
    const stale = answer
    service.build('bq')
    const complete = bq({ indexed: 9, databases: 9, objects: 900 })
    pendingIndex[3]({ ok: true, value: { status: complete, elapsedMs: 1 } })
    await settle()
    stale({ ok: true, value: { status: partial, elapsedMs: 0 } })
    await settle()
    expect(service.getSnapshot().indexes.bq?.status).toEqual(complete)
  })

  it('cancels a disconnected single-target search and typing task, retaining filters and completed hits while rejecting late replies', async () => {
    const { service, calls, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a')])
    const id = service.open('a', 'orders', false, 'Sales')!
    const completed = { hits: [hit], total: 1, partial: false, elapsedMs: 1, index: status() }
    pendingSearch[0]({ ok: true, value: completed })
    await settle()
    const reading = service.search(id)
    const requestId = calls.search.at(-1)!.requestId
    service.setQuery(id, { text: 'customer draft' })
    connections.set([connection('a', true)])
    expect(calls.cancel).toContainEqual([requestId])
    expect(service.getSnapshot().documents[id]).toMatchObject({ connectionId: 'a', text: 'customer draft', database: 'Sales', result: completed, error: 'The server is not connected.' })
    expect(service.getSnapshot().documents[id].requestId).toBeUndefined()
    timers.run()
    expect(calls.search).toHaveLength(2)
    // Even a new live handle with the same display name cannot accept the old handle's response.
    connections.set([{ ...connection('other'), server: 'srv-a' }])
    pendingSearch[1]({ ok: true, value: { ...completed, hits: [], total: 0 } })
    await reading
    expect(service.getSnapshot().documents[id].result).toEqual(completed)
    expect(service.getSnapshot().documents[id].connectionId).toBe('a')
    service.dispose()
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

  it('searches SQL Server Agent\'s kinds with no environment variable set (AG-9 removed the release gate)', () => {
    const { service, calls, connections, timers } = harness()
    connections.set([connection('a')])
    const id = service.open('a')!
    service.setQuery(id, { text: 'nightly' })
    timers.run()
    // Every kind when none is chosen; Other with its Agent kinds when it is.
    expect(calls.search[0]).not.toHaveProperty('kinds')
    service.setQuery(id, { types: ['other'] })
    expect(calls.search[1].kinds).toEqual(searchTypeKinds(['other']))
    expect(calls.search[1].kinds).toEqual(expect.arrayContaining([...agentSearchKinds]))
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
    const { service, calls, pendingSearch, connections, timers, api } = harness()
    connections.set([connection('a'), connection('b')])
    const id = service.open(undefined, undefined, true)!
    // The tab belongs to no server; each server has the index it got when it connected, and no second one.
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
    // Each server's group shows as its answer lands: a's hits while b's answer is still on its way, b's group marked pending.
    pendingSearch[2](answer(hits, { elapsedMs: 3 }))
    await settle()
    const landing = service.getSnapshot().documents[id]
    expect(landing.requestId).toBe('req6')
    expect(landing.result?.hits).toEqual(hits)
    expect(serverGroups(landing).map(group => [group.connectionId, group.hits.length, !!group.pending])).toEqual([['a', 2, false], ['b', 0, true]])
    expect(groupNote(serverGroups(landing)[1]!, undefined)).toBe('searching…')
    expect(allServersSummary(landing, {})).toBe('2 servers · 2 results · 3 ms · srv-b searching…')
    // The selection made while b is pending survives b's answer, which lands after a's group, the same object on both.
    service.pick(id, 1)
    pendingSearch[3](answer([hits[0]!], { elapsedMs: 7, total: 40 }))
    await settle()
    const answered = service.getSnapshot().documents[id]
    expect(answered.requestId).toBeUndefined()
    expect(answered.current).toBe(1)
    expect(answered.result).toMatchObject({ total: 42, elapsedMs: 7, hits: [hits[0], hits[1], hits[0]] })
    expect(serverGroups(answered).map(group => [group.connectionId, group.label, group.start, group.hits.length])).toEqual([['a', 'srv-a', 0, 2], ['b', 'srv-b', 2, 1]])
    expect([0, 1, 2, 3].map(index => hitServer(answered, index))).toEqual(['a', 'a', 'b', undefined])
    // The same object on two servers is two hits: a menu's hit and the keys act on the hit's own server.
    service.pickHit(id, hits[0]!, 'b')
    expect(service.getSnapshot().documents[id].current).toBe(2)
    service.listFocused(id, true)
    expect(service.focusedHit()).toMatchObject({ connectionId: 'b', index: 2, hit: hits[0] })
    // The selection follows its server's hit when the answer moves it, and survives while its server's answer is pending: b keeps
    // its answer to the same query until the new one lands.
    void service.search(id)
    pendingSearch[4](answer([hits[1]!, hits[0]!, { ...hit, label: 'dbo.C', object: { ...hit.object, name: 'C' } }]))
    await settle()
    const rerun = service.getSnapshot().documents[id]
    expect(serverGroups(rerun).map(group => [group.connectionId, group.hits.length, !!group.pending])).toEqual([['a', 3, false], ['b', 1, true]])
    expect(rerun.current).toBe(3)
    pendingSearch[5](answer([hits[0]!]))
    await settle()
    expect(service.getSnapshot().documents[id].current).toBe(3)
    expect(service.getSnapshot().documents[id].servers?.some(answer => answer.pending)).toBe(false)
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
    // A server connects: only it is searched; a's and b's answers stand. Indexing on connect is off, so none is indexed.
    connections.set([connection('a'), connection('b'), connection('c')])
    expect(calls.index).toHaveLength(0)
    expect(calls.search.slice(2).map(call => call.connectionId)).toEqual(['c'])
    expect(serverGroups(service.getSnapshot().documents[id]).map(group => [group.connectionId, !!group.pending])).toEqual([['a', false], ['b', false], ['c', true]])
    pendingSearch[2]({ ok: false, error: 'The search timed out.', code: 'TIMEOUT' })
    await settle()
    const document = service.getSnapshot().documents[id]
    expect(serverGroups(document).map(group => [group.connectionId, group.hits.length, group.error])).toEqual([['a', 1, undefined], ['b', 1, undefined], ['c', 0, 'The search timed out.']])
    expect(groupNote(serverGroups(document)[2]!, undefined)).toBe('The search timed out.')
    expect(allServersSummary(document, {})).toBe('3 servers · 2 results · 1 ms · srv-c could not be searched')
    // A server is lost: the search runs again without it and names it.
    connections.set([connection('a'), connection('b', true), connection('c')])
    expect(calls.search.slice(3).map(call => call.connectionId)).toEqual(['a', 'c'])
    pendingSearch[3](answer([hit]))
    pendingSearch[4](answer([]))
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

  it('asks each server that connects while an All servers search runs on its own, within that search: N joins cost N requests', async () => {
    const { service, calls, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a')])
    const id = service.open('a', undefined, true)!
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    expect(calls.search.map(call => call.connectionId)).toEqual(['a'])
    // Servers connect one by one, each before the search before has answered: each is asked alone, and a's request stands.
    connections.set([connection('a'), connection('b')])
    connections.set([connection('a'), connection('b'), connection('c')])
    connections.set([connection('a'), connection('b'), connection('c'), connection('d')])
    expect(calls.search.map(call => call.connectionId)).toEqual(['a', 'b', 'c', 'd'])
    expect(calls.cancel).toEqual([])
    expect(service.getSnapshot().documents[id].requestId).toBeDefined()
    // Every answer lands in its group, in Object Explorer's order, whatever order they come in.
    for (const index of [3, 1, 0, 2]) pendingSearch[index]!(answer([hit]))
    await settle()
    const document = service.getSnapshot().documents[id]
    expect(serverGroups(document).map(group => [group.connectionId, group.hits.length, !!group.pending])).toEqual(['a', 'b', 'c', 'd'].map(name => [name, 1, false]))
    expect(document.requestId).toBeUndefined()
    expect(calls.search).toHaveLength(4)
    service.dispose()
  })

  it('clears the pending marks of an All servers search when no server is left to answer it', async () => {
    const { service, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a'), connection('b')])
    const id = service.open('a', undefined, true)!
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    pendingSearch[0](answer([hit]))
    await settle()
    expect(serverGroups(service.getSnapshot().documents[id]).map(group => [group.connectionId, !!group.pending])).toEqual([['a', false], ['b', true]])
    // Every server goes (the backend was lost): nothing says it is still searching, and a's answer stays in view.
    connections.set([])
    const document = service.getSnapshot().documents[id]
    expect(document.error).toBe('No server is connected.')
    expect(document.requestId).toBeUndefined()
    expect(document.servers?.map(answer => [answer.connectionId, !!answer.pending])).toEqual([['a', false]])
    expect(allServersSummary(document, {})).not.toContain('searching')
    service.dispose()
  })

  it('walks an All servers list\'s headers and hits as one run of stops, the same from a header and from a hit', () => {
    // Two expanded groups: header a (0), its hits (1, 2), header b (3), its hits (4, 5). A page here is two stops.
    const count = 6, page = (at: number) => (direction: 1 | -1) => Math.max(0, Math.min(count - 1, at + direction * 2))
    const reach = (at: number, key: string) => stopForKey(count, at, key, page(at))
    // Home from a hit in the later group reaches the first group's header, not its first hit; End the last stop.
    expect([reach(4, 'Home'), reach(5, 'Home'), reach(3, 'Home'), reach(1, 'Home')]).toEqual([0, 0, 0, 0])
    expect([reach(1, 'End'), reach(0, 'End'), reach(3, 'End')]).toEqual([5, 5, 5])
    // The arrows and the Page keys count the headers too; ↑ above the first stop is the box, ↓ on the last stays.
    expect([reach(2, 'ArrowDown'), reach(4, 'ArrowUp'), reach(0, 'ArrowUp'), reach(5, 'ArrowDown')]).toEqual([3, 3, -1, 5])
    expect([reach(1, 'PageDown'), reach(3, 'PageDown'), reach(4, 'PageUp'), reach(1, 'PageUp')]).toEqual([3, 5, 2, 0])
    // Every other key is the header's or the hit's own.
    expect(['ArrowLeft', 'ArrowRight', 'Enter', 'Escape', ' ', 'a'].map(key => reach(2, key))).toEqual(Array(6).fill(undefined))
    // The panel walks through it on both: neither a header nor a hit keeps Home, End or a Page key of its own.
    const panel = readFileSync(new URL('../src/renderer/src/search/SearchPanel.tsx', import.meta.url), 'utf8')
    const headKeys = panel.slice(panel.indexOf('const onHeadKey'), panel.indexOf('const onListKey')), spanningKeys = panel.slice(panel.indexOf('if (spanning) {', panel.indexOf('const onListKey')), panel.indexOf('const next = '))
    expect(headKeys).toContain('walk(all, at, event.key)')
    expect(headKeys).not.toMatch(/'Home'|'End'|'Page/)
    expect(spanningKeys).toContain('walk(items, position, event.key)')
  })

  it('roves the All servers list\'s one tab stop to the group header that has focus, so Tab from a header leaves the list', () => {
    const heads = ['a', 'b', 'c']
    // The selected hit holds it, or the first shown when the selection is hidden or none.
    expect(listTabStop(heads, [0, 1, 4], 4, undefined)).toEqual({ hit: 4 })
    expect(listTabStop(heads, [0, 1, 4], 2, undefined)).toEqual({ hit: 0 })
    expect(listTabStop(heads, [0, 1, 4], undefined, undefined)).toEqual({ hit: 0 })
    // A focused header takes it from the selected hit, before or after it, and no hit keeps one.
    expect(listTabStop(heads, [0, 1, 4], 4, 'c')).toEqual({ head: 'c' })
    expect(listTabStop(heads, [0, 1, 4], 0, 'b')).toEqual({ head: 'b' })
    // A header whose group has gone holds nothing; with every group collapsed, the first header holds it.
    expect(listTabStop(heads, [0, 1, 4], 1, 'z')).toEqual({ hit: 1 })
    expect(listTabStop(heads, [], undefined, undefined)).toEqual({ head: 'a' })
    expect(listTabStop([], [], undefined, undefined)).toEqual({})
  })

  it('asks only the server whose build ended again in an All servers search: N builds ending cost N requests, not N²', async () => {
    const { service, calls, pendingSearch, pendingIndex, connections, timers } = harness()
    const servers = ['a', 'b', 'c', 'd']
    connections.set(servers.map(name => connection(name)))
    const id = service.open('a', undefined, true)!
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    expect(calls.search.map(call => call.connectionId)).toEqual(servers)
    // Two builds end while the search is on its way: each server is asked again within it, its first request cancelled.
    pendingIndex[0]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    pendingIndex[1]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.search.slice(4).map(call => call.connectionId)).toEqual(['a', 'b'])
    expect(calls.cancel.slice(-2)).toEqual([[calls.search[0]!.requestId], [calls.search[1]!.requestId]])
    for (const index of [0, 1, 2, 3, 4, 5]) pendingSearch[index]!(answer([hit]))
    await settle()
    const settled = service.getSnapshot().documents[id]
    expect(settled.requestId).toBeUndefined()
    expect(serverGroups(settled).map(group => [group.connectionId, group.hits.length, !!group.pending])).toEqual(servers.map(name => [name, 1, false]))
    // The other two builds end after the search answered: one request each, the other servers' answers kept.
    pendingIndex[2]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.search.slice(6).map(call => call.connectionId)).toEqual(['c'])
    expect(service.getSnapshot().documents[id].result?.hits).toHaveLength(4)
    pendingIndex[3]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    expect(calls.search.slice(7).map(call => call.connectionId)).toEqual(['d'])
    pendingSearch[6]!(answer([]))
    pendingSearch[7]!(answer([hit, { ...hit, label: 'dbo.B', object: { ...hit.object, name: 'B' } }]))
    await settle()
    const document = service.getSnapshot().documents[id]
    expect(serverGroups(document).map(group => [group.connectionId, group.hits.length])).toEqual([['a', 1], ['b', 1], ['c', 0], ['d', 2]])
    expect(document.requestId).toBeUndefined()
    // Four builds ended: eight requests in all, four for the search and one per build.
    expect(calls.search).toHaveLength(8)
    service.dispose()
  })

  it('moves the selection out of a group that collapses on it, so the copy keys never act on a hidden hit', async () => {
    const { service, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a'), connection('b'), connection('c')])
    const id = service.open('a', undefined, true)!
    const named = (name: string) => ({ ...hit, label: `dbo.${name}`, object: { ...hit.object, name } })
    const answer = (value: ObjectSearchHit[]): ApiResult<ObjectSearchResult> => ({ ok: true, value: { hits: value, total: value.length, partial: false, elapsedMs: 1, index: status() } })
    service.setQuery(id, { text: 'x' })
    timers.run()
    pendingSearch[0](answer([named('A1'), named('A2')]))
    pendingSearch[1](answer([named('B1')]))
    pendingSearch[2](answer([named('C1')]))
    await settle()
    service.listFocused(id, true)
    // b's hit is selected; collapsing b hands the selection to the next shown hit, c's.
    service.pick(id, 2)
    service.toggleGroup(id, 'b')
    expect(service.getSnapshot().documents[id].current).toBe(3)
    expect(shownHits(service.getSnapshot().documents[id])).toEqual([0, 1, 3])
    expect(service.focusedHit()).toMatchObject({ connectionId: 'c', index: 3 })
    // With nothing after it shown, the selection goes to the last shown hit before it.
    service.toggleGroup(id, 'c')
    expect(service.getSnapshot().documents[id].current).toBe(1)
    expect(service.focusedHit()).toMatchObject({ connectionId: 'a', index: 1 })
    // Expanding a group leaves the selection; collapsing every group clears it, and the keys act on nothing.
    service.toggleGroup(id, 'b')
    expect(service.getSnapshot().documents[id].current).toBe(1)
    service.toggleGroup(id, 'b')
    service.toggleGroup(id, 'a')
    expect(service.getSnapshot().documents[id].current).toBeUndefined()
    expect(shownHits(service.getSnapshot().documents[id])).toEqual([])
    expect(service.focusedHit()).toBeUndefined()
    // With no selection the keys act on the first shown hit, never on a hidden one.
    service.toggleGroup(id, 'c')
    expect(service.focusedHit()).toMatchObject({ connectionId: 'c', index: 3 })
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
    // A healthy first server does not hide a second whose index leaves objects out: the line (always shown in the tab) names it.
    const healthy = { connectionId: 'a', done: 2, total: 2, objects: 40, status: status() }
    const incomplete = { connectionId: 'b', done: 2, total: 2, objects: 30, status: status({ objects: 30, definitions: false, skipped: [{ database: 'x', code: 'NO_DB_ACCESS', message: 'm' }, { database: 'y', code: 'TIMEOUT', message: 'm' }] }) }
    const label = (id: string) => `srv-${id}`
    expect(indexGap(healthy)).toBeUndefined()
    expect(indexIncomplete(healthy, healthy.status)).toBe(false)
    expect(indexGap(incomplete)).toBe('2 databases skipped, names only')
    expect(indexIncomplete(incomplete, incomplete.status)).toBe(true)
    expect(allIndexesSummary([healthy, incomplete], label)).toBe('Indexes: 70 objects on 2 servers · srv-b: 2 databases skipped, names only')
    expect(allIndexesSummary([healthy, { connectionId: 'c', done: 0, total: 0, objects: 0, error: 'Denied.' }], label)).toBe('Indexes: 40 objects on 2 servers · srv-c: index could not be built')
    expect(indexGap({ connectionId: 'c', done: 0, total: 0, objects: 0, status: status({ skipped: [{ database: '', code: 'CATALOG_ERROR', message: 'm' }, { database: 'Big', code: childrenLeftOut, message: 'm' }] }) }))
      .toBe('server objects skipped, children left out of 1 database')
    expect(indexGap({ connectionId: 'c', done: 0, total: 0, objects: 0 })).toBe('no index yet')
    // Definitions left out because the indexes' memory ran out are a gap of their own, named per server.
    const starved = { connectionId: 'd', done: 2, total: 2, objects: 30, status: status({ objects: 30, modules: 0, cut: 1204, leftOut: 1204, leftOutIn: 2 }) }
    expect(indexGap(starved)).toBe('1,204 definitions left out (not enough index memory)')
    expect(allIndexesSummary([healthy, starved], label)).toBe('Indexes: 70 objects on 2 servers · srv-d: 1,204 definitions left out (not enough index memory)')
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

  it('handles a hit whose kind this build does not know without failing: no reveal path, no insert text, a menu target', async () => {
    const { service } = harness()
    const future = { object: { kind: 'futureKind', database: 'Sales', schema: 'dbo', name: 'X' }, folder: 'futureFolder', label: 'dbo.X' } as unknown as ObjectSearchHit
    expect(revealPaths(future)).toEqual([])
    const seek = vi.fn()
    expect(await service.reveal({ seek }, 'a', future)).toEqual({ ok: false, message: unknownKindReveal })
    expect(seek).not.toHaveBeenCalled()
    expect(insertTextFor({ type: 'object', object: future.object })).toBeUndefined()
    const explorer = { objectNode: (connectionId: string, object: ObjectSearchHit['object'], label: string) => ({ connectionId, ref: { type: 'object' as const, object }, kind: object.kind, label, linux: false, lost: false }) }
    expect(searchHitTarget(explorer as never, 'a', 'tab', 0, future, false)).toMatchObject({ kind: 'searchHit', hit: future })
    service.dispose()
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
    // An Agent job is below the SQL Server Agent node, in its Jobs folder (AG-1); a login stays in Security › Logins.
    const job: ObjectSearchHit = { object: { kind: 'agentJob', name: 'Nightly' }, folder: 'agentJobs', label: 'Nightly' }
    expect(revealPaths(job)).toEqual([[{ type: 'object', object: { kind: 'agent' } }, { type: 'folder', owner: { kind: 'agent' }, folder: 'agentJobs' }, { type: 'object', object: job.object }]])
    const login: ObjectSearchHit = { object: { kind: 'login', name: 'sa' }, folder: 'logins', label: 'sa' }
    expect(revealPaths(login)).toEqual([[{ type: 'folder', owner: server, folder: 'serverSecurity' }, { type: 'folder', owner: server, folder: 'logins' }, { type: 'object', object: login.object }]])
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

  it('ensures the BigQuery session project on the reveal host before seeking a BigQuery hit', async () => {
    const { service } = harness()
    const order: string[] = []
    const host: RevealHost = {
      ensureBigQueryProject: (connectionId, project) => { order.push(`ensure:${connectionId}:${project}`) },
      seek: async (connectionId, paths) => { order.push(`seek:${connectionId}:${paths.length}`); return { ok: true, nodeId: 7 } }
    }
    expect(await service.reveal(host, 'bq', bigQueryHit)).toEqual({ ok: true, nodeId: 7 })
    expect(order).toEqual(['ensure:bq:varia-alpha', 'seek:bq:1'])
    // SQL Server hits never invoke ensureBigQueryProject.
    order.length = 0
    expect(await service.reveal(host, 'a', hit)).toEqual({ ok: true, nodeId: 7 })
    expect(order).toEqual(['seek:a:2'])
    // When the 50-project session cap blocks ensureBigQueryProject, reveal returns a clear cap message without seeking.
    const cappedHost: RevealHost = {
      ensureBigQueryProject: () => false,
      seek: vi.fn(async () => ({ ok: true as const, nodeId: 7 }))
    }
    expect(await service.reveal(cappedHost, 'bq', bigQueryHit)).toEqual({
      ok: false,
      message: 'Object Explorer shows at most 50 session projects per connection. Star or remove one, then try again.'
    })
    expect(cappedHost.seek).not.toHaveBeenCalled()
    service.dispose()
  })

  it('syncBigQueryStarred only refreshes missing starred projects and retries if an earlier build failed', async () => {
    let starred: string[] = []
    const { service, calls, pendingIndex, connections } = harness({ starredProjects: () => starred })
    connections.set([bigQueryConnection('bq')])
    // Initial build started with no starred projects (e.g. before bigQueryStarred.load() resolved).
    expect(calls.index).toHaveLength(1)
    expect(calls.index[0]).not.toHaveProperty('starredProjects')
    // Suppose the initial build fails.
    pendingIndex[0]({ ok: false, error: 'Auth failed.' })
    await settle()
    // Starred projects arrive while the index is in a failed state: refreshBigQuery refuses, so syncBigQueryStarred must NOT mark them known.
    starred = ['varia-beta']
    service.syncBigQueryStarred('bq')
    expect(calls.index).toHaveLength(1)
    // User rebuilds now with varia-beta starred: build() records varia-beta in indexedStarred.
    service.build('bq')
    expect(calls.index).toHaveLength(2)
    expect(calls.index[1]).toMatchObject({ starredProjects: ['varia-beta'] })
    pendingIndex[1]({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    // syncBigQueryStarred skips varia-alpha (own billing project) and varia-beta (already built) and refreshes only varia-gamma.
    starred = ['varia-alpha', 'varia-beta', 'varia-gamma']
    service.syncBigQueryStarred('bq')
    expect(calls.index).toHaveLength(3)
    expect(calls.index[2]).toMatchObject({ scope: { project: 'varia-gamma' } })
    pendingIndex[2]({ ok: true, value: { status: status({ provider: 'bigquery' }), elapsedMs: 1 } })
    await settle()
    // Subsequent syncBigQueryStarred is a no-op since both varia-beta and varia-gamma are already tracked.
    service.syncBigQueryStarred('bq')
    expect(calls.index).toHaveLength(3)
    service.dispose()
  })

  it('triggers a scoped refresh when opening Search Objects on an unstarred, unindexed BigQuery project/dataset with discovery off', async () => {
    const { service, calls, pendingIndex, connections } = harness({ allProjects: false, starredProjects: () => ['varia-beta'] })
    connections.set([bigQueryConnection('bq')])
    expect(calls.index).toHaveLength(1)
    pendingIndex[0]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 2 }), elapsedMs: 1 } })
    await settle()
    // Opening Search Objects scoped to the billing project or an already-starred project does NOT trigger a redundant scoped refresh.
    service.open('bq', undefined, false, { project: 'varia-alpha', dataset: 'sales' })
    service.open('bq', undefined, false, { project: 'varia-beta', dataset: 'census' })
    expect(calls.index).toHaveLength(1)
    // Opening Search Objects scoped to an unstarred session project/dataset triggers a free missingOnly scoped refresh so matches are not falsely empty.
    service.open('bq', undefined, false, { project: 'session-only-1', dataset: 'adhoc' })
    expect(calls.index).toHaveLength(2)
    expect(calls.index[1]).toMatchObject({ connectionId: 'bq', allProjects: false, scope: { project: 'session-only-1', dataset: 'adhoc' }, missingOnly: true })
    // If the scoped refresh reports a QUOTA skip for that scope, it is NOT cached as indexed and re-opening retries it.
    pendingIndex[1]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 2, skipped: [{ project: 'session-only-1', database: '', code: 'QUOTA', message: 'Quota exceeded.' }] }), elapsedMs: 1 } })
    await settle()
    service.open('bq', undefined, false, { project: 'session-only-1', dataset: 'adhoc' })
    expect(calls.index).toHaveLength(3)
    pendingIndex[2]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 3 }), elapsedMs: 1 } })
    await settle()
    // Opening the same scope again after a clean read does not redundantly re-fetch it.
    service.open('bq', undefined, false, { project: 'session-only-1', dataset: 'adhoc' })
    expect(calls.index).toHaveLength(3)
    service.dispose()
  })

  it('carries open external BigQuery search scopes through Build index and full rebuilds when discovery is off', async () => {
    const { service, calls, pendingIndex, connections } = harness({ indexOnConnect: false, allProjects: false, starredProjects: () => [] })
    connections.set([bigQueryConnection('bq')])
    expect(calls.index).toHaveLength(0)
    // Open a scoped Search Objects tab on an unstarred external dataset with indexOnConnect off, then click Build index.
    const tabId = service.open('bq', 'orders', false, { project: 'ext-proj-1', dataset: 'adhoc' })!
    expect(tabId).toBeTruthy()
    expect(calls.index).toHaveLength(0)
    service.build('bq')
    expect(calls.index).toHaveLength(1)
    expect(calls.index[0]).toMatchObject({ connectionId: 'bq', allProjects: false })
    // Full build finishes -> ObjectSearchService automatically queues a missingOnly scope refresh for the open external tab.
    pendingIndex[0]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 1 }), elapsedMs: 1 } })
    await settle()
    expect(calls.index).toHaveLength(2)
    expect(calls.index[1]).toMatchObject({ connectionId: 'bq', allProjects: false, scope: { project: 'ext-proj-1', dataset: 'adhoc' }, missingOnly: true })
    pendingIndex[1]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 2 }), elapsedMs: 1 } })
    await settle()
    // Triggering a full rebuild later also carries the open external scope through instead of losing its results.
    service.build('bq')
    expect(calls.index).toHaveLength(3)
    pendingIndex[2]({ ok: true, value: { status: status({ provider: 'bigquery', projects: 1 }), elapsedMs: 1 } })
    await settle()
    expect(calls.index).toHaveLength(4)
    expect(calls.index[3]).toMatchObject({ connectionId: 'bq', scope: { project: 'ext-proj-1', dataset: 'adhoc' }, missingOnly: true })
    service.dispose()
  })

  it('reveals a BigQuery hit below its project and dataset, a column below its table and the record columns above it', () => {
    const project = { type: 'object', object: { kind: 'bqProject', name: 'varia-alpha' } }
    const dataset = { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' } as const
    const datasetHit: ObjectSearchHit = { object: dataset, folder: '', label: 'sales' }
    expect(revealPaths(datasetHit)).toEqual([[project, { type: 'object', object: dataset }]])
    const view: ObjectSearchHit = { object: { kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }, folder: 'bqViews', label: 'sales.daily' }
    expect(revealPaths(view)).toEqual([[project, { type: 'object', object: dataset }, { type: 'folder', owner: dataset, folder: 'bqViews' }, { type: 'object', object: view.object }]])
    const city: ObjectSearchHit = { object: { kind: 'bqColumn', project: 'varia-alpha', dataset: 'sales', table: 'daily', name: 'address.geo.city' }, folder: 'bqColumns', parentFolder: 'bqViews', label: 'sales.daily.address.geo.city' }
    const table = { kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }
    const column = (name: string) => ({ type: 'object', object: { kind: 'bqColumn', project: 'varia-alpha', dataset: 'sales', table: 'daily', name } })
    expect(revealPaths(city)).toEqual([[project, { type: 'object', object: dataset }, { type: 'folder', owner: dataset, folder: 'bqViews' }, { type: 'object', object: table },
      { type: 'folder', owner: table, folder: 'bqColumns' }, column('address'), column('address.geo'), { type: 'object', object: city.object }]])
    // Group by Schema has no say in BigQuery's tree, and a column whose table's folder is unknown has no path.
    expect(revealPaths(city, true)).toEqual(revealPaths(city))
    expect(revealPaths({ ...city, parentFolder: undefined })).toEqual([])
  })

  it('shows where a BigQuery hit is, its name without the dataset the path names, and its names to copy', () => {
    const table: ObjectSearchHit = { object: { kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'events_20260103' }, folder: 'bqTables', label: 'sales.events_20260103', range: [6, 6],
      shards: { prefix: 'events_', count: 3, first: '20260101', last: '20260103' } }
    expect(searchHitPath(table)).toBe('varia-alpha › sales › Tables · 3 shards, 20260101–20260103')
    expect(searchHitLabel(table)).toEqual({ text: 'events_20260103', range: [0, 6] })
    const column: ObjectSearchHit = { object: { kind: 'bqColumn', project: 'varia-alpha', dataset: 'sales', table: 'orders', name: 'address.city' }, folder: 'bqColumns', parentFolder: 'bqTables',
      label: 'sales.orders.address.city', range: [2, 6], type: 'STRING' }
    expect(searchHitPath(column)).toBe('varia-alpha › sales › Columns · STRING')
    // A match that runs into the dataset's name is cut to what the row shows of it ("les.or" marks "or"); one inside it marks nothing.
    expect(searchHitLabel(column)).toEqual({ text: 'orders.address.city', range: [0, 2] })
    expect(searchHitLabel({ ...column, range: [0, 5] })).toEqual({ text: 'orders.address.city' })
    expect(searchHitLabel({ ...column, range: [13, 4] })).toEqual({ text: 'orders.address.city', range: [7, 4] })
    expect(searchHitPath({ object: { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' }, folder: '', label: 'sales' })).toBe('varia-alpha')
    expect(searchHitLabel({ object: { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' }, folder: '', label: 'sales', range: [0, 5] })).toEqual({ text: 'sales', range: [0, 5] })
    // The name, and the backtick-quoted path as its fully qualified name; no schema-qualified or bracketed one.
    expect(searchHitNames(table.object)).toEqual({ name: 'events_20260103', qualified: '`varia-alpha.sales.events_20260103`' })
    expect(searchHitNames(column.object)).toEqual({ name: 'address.city', qualified: '`varia-alpha.sales.orders`.`address`.`city`' })
    expect(searchHitNames({ kind: 'bqDataset', project: 'varia-alpha', name: 'sales' })).toEqual({ name: 'sales', qualified: '`varia-alpha.sales`' })
  })

  it('says what a BigQuery index holds, in datasets, and which pass its build is in', () => {
    const bq = (overrides: Partial<ObjectIndexStatus> = {}) => status({ provider: 'bigquery', ...overrides })
    expect(indexSummary({ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' }, undefined)).toBe('Discovering accessible BigQuery projects…')
    expect(bigQueryIndexSummary({ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' }, undefined)).toBe('Discovering accessible BigQuery projects…')
    // What was loaded from the saved index is searchable while the build checks it: the line says how old it is, and the
    // band keeps it in view; an index whose build ended without checking it says so.
    const now = Date.parse('2026-11-26T10:05:09Z')
    expect(bigQueryIndexSummary({ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects', savedAt: '2026-11-26T08:05:09Z' }, undefined, now))
      .toBe('Discovering accessible BigQuery projects… Index saved 2 h ago, checking.')
    expect(indexSummary({ connectionId: 'b', requestId: 'r', done: 3, total: 12, objects: 900, phase: 'names', savedAt: '2026-11-23T10:05:09Z', throttled: true }, undefined, now))
      .toBe('Indexing 3 of 12 datasets (900 objects so far)… Index saved 3 d ago, checking. BigQuery is rate limiting the calls, which retry.')
    const unchecked = status({ provider: 'bigquery', indexed: 4, savedAt: '2026-11-26T10:04:09Z' })
    expect(bigQueryIndexSummary(undefined, unchecked, now)).toBe('Index: 40 objects, 5 definitions in 4 datasets · saved 1 min ago, not checked')
    expect(indexIncomplete({ connectionId: 'b', done: 4, total: 4, objects: 40, status: unchecked }, unchecked)).toBe(true)
    expect(indexGap({ connectionId: 'b', done: 4, total: 4, objects: 40, status: unchecked }, now)).toBe('saved 1 min ago, not checked')
    expect(bigQueryIndexSummary(undefined, status({ provider: 'bigquery', indexed: 4 }), now)).toBe('Index: 40 objects, 5 definitions in 4 datasets')
    // A malformed age (never sent: main's schema refuses it) says nothing rather than "NaN".
    expect(bigQueryIndexSummary(undefined, status({ provider: 'bigquery', indexed: 4, savedAt: 'soon' }), now)).toBe('Index: 40 objects, 5 definitions in 4 datasets')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' }])).toBe('Discovering BigQuery projects…')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' }, { connectionId: 'a', requestId: 'r2', done: 0, total: 0, objects: 0 }])).toBe('Discovering BigQuery projects on 2 servers…')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 2, total: 5, objects: 30, phase: 'names' }])).toBe('Listing BigQuery datasets 2 / 5')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 2, total: 480, objects: 30, phase: 'names', growing: true }])).toBe('Listing BigQuery datasets 2 / ~480')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 5300, total: 6624, objects: 30, phase: 'details', throttled: true }])).toBe('Reading BigQuery object details 5,300 / 6,624 (rate limited)')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects', throttled: true }])).toBe('Discovering BigQuery projects… (rate limited)')
    // SQL Server's label is unchanged, alone or across servers; builds counting different things are not summed.
    expect(indexStatusText([{ connectionId: 'a', requestId: 'r', done: 3, total: 12, objects: 30 }])).toBe('Indexing objects 3 / 12')
    expect(indexStatusText([{ connectionId: 'a', requestId: 'r', done: 3, total: 12, objects: 30 }, { connectionId: 'c', requestId: 'r2', done: 1, total: 4, objects: 3 }])).toBe('Indexing objects 4 / 16 on 2 servers')
    expect(indexStatusText([{ connectionId: 'a', requestId: 'r', done: 3, total: 12, objects: 30 }, { connectionId: 'b', requestId: 'r2', done: 7, total: 30, objects: 3, phase: 'details', throttled: true }])).toBe('Indexing objects on 2 servers… (rate limited)')
    expect(indexStatusText([{ connectionId: 'a', requestId: 'r', done: 3, total: 12, objects: 30 }, { connectionId: 'b', requestId: 'r2', done: 0, total: 0, objects: 0, phase: 'projects' }])).toBe('Indexing objects on 2 servers…')
    expect(indexStatusText([{ connectionId: 'b', requestId: 'r', done: 2, total: 5, objects: 30, phase: 'names' }, { connectionId: 'c', requestId: 'r2', done: 1, total: 4, objects: 3, phase: 'names' }])).toBe('Listing BigQuery datasets 3 / 9 on 2 servers')
    expect(indexSummary({ connectionId: 'b', requestId: 'r', done: 1, total: 40, objects: 120, phase: 'names', growing: true, throttled: true }, undefined)).toBe('Indexing 1 of about 40 datasets (120 objects so far)… BigQuery is rate limiting the calls, which retry.')
    expect(indexSummary({ connectionId: 'b', requestId: 'r', done: 1, total: 4, objects: 120, phase: 'names' }, undefined)).toBe('Indexing 1 of 4 datasets (120 objects so far)…')
    expect(indexSummary({ connectionId: 'b', requestId: 'r', done: 7, total: 30, objects: 120, phase: 'details' }, undefined)).toBe('Reading details of 7 of 30 objects…')
    expect(indexSummary(undefined, bq())).toBe('Index: 40 objects, 5 definitions in 2 datasets')
    expect(indexSummary(undefined, bq({ projects: 1 }))).toBe('Index: 40 objects, 5 definitions in 2 datasets')
    expect(indexSummary(undefined, bq({ objects: 4210, modules: 180, indexed: 62, projects: 14 }))).toBe('Index: 4,210 objects, 180 definitions in 62 datasets across 14 projects')
    expect(indexSummary(undefined, bq({ state: 'none' }))).toBe('This connection has no index yet.')
    expect(indexSummary(undefined, status({ indexed: 2, stopped: true }))).toMatch(/ in 2 databases · build stopped$/)
    expect(indexSummary(undefined, bq({ namesOnly: ['varia-beta'], skipped: [
      { database: 'census', project: 'varia-beta', code: 'PERMISSION_DENIED', message: 'm' }, { database: '', project: 'varia-gamma', code: 'API_DISABLED', message: 'm' },
      { database: 'sales', project: 'varia-alpha', code: 'CATALOG_ERROR', message: 'm', details: true }, { database: 'big', project: 'varia-alpha', code: childrenLeftOut, message: 'm' }
    ] }))).toBe('Index: 40 objects, 5 definitions in 2 datasets · 1 project skipped · 1 dataset skipped · details missing in 1 dataset · columns left out of 1 large dataset · names only in 1 project')
    expect(indexedCount(status({ provider: 'bigquery', indexed: 3 }))).toBe('3 datasets')
    expect(indexedCount(status({ indexed: 1 }))).toBe('1 database')
    expect(indexGap({ connectionId: 'b', done: 0, total: 0, objects: 0, status: bq({ skipped: [{ database: 'census', project: 'varia-beta', code: 'NOT_FOUND', message: 'm' }, { database: 'sales', project: 'varia-alpha', code: 'TIMEOUT', message: 'm', details: true }] }) }))
      .toBe('1 dataset skipped, details missing')
    expect(indexSummary(undefined, bq({ skipped: [{ database: '', project: '', code: 'TOO_LARGE', message: 'Indexing stopped early for auto-discovered projects: BigQuery leaves part of the index\'s 512 MiB memory limit to SQL Server, and the rest is in use.' }] })))
      .toContain('index memory limit reached')
    expect(indexGap({ connectionId: 'b', done: 0, total: 0, objects: 0, status: bq({ skipped: [{ database: '', project: '', code: 'TOO_LARGE', message: 'You have access to more than 500 projects; the index keeps the first 500.' }, { database: '', project: '', code: 'TOO_LARGE', message: 'Indexing stopped early for auto-discovered projects because the index reached its 512 MiB memory limit.' }] }) }))
      .toBe('project list truncated, index memory limit reached')
  })

  it('runs Object Explorer\'s box as one more search, on the selected server or the first connected one', () => {
    const { service, connections, calls } = harness({ indexOnConnect: false })
    service.followExplorer(undefined)
    expect(service.getSnapshot().documents[explorerSearchId]).toBeUndefined()
    connections.set([connection('a'), connection('b')])
    service.followExplorer(undefined)
    expect(service.getSnapshot().documents[explorerSearchId]).toMatchObject({ connectionId: 'a', text: '', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all', types: [] })
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
    expect(calls.index).toHaveLength(0)
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'b', text: 'ord', wholeWord: true })
    // A lost server falls back to the first connected one.
    connections.set([connection('a'), connection('b', true)])
    service.followExplorer('b')
    expect(service.getSnapshot().documents[explorerSearchId]?.connectionId).toBe('a')
  })

  it('runs the header\'s Search as one more search: by name, approximately too, a few hits from every connected server, until it ends', async () => {
    const { service, calls, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    // Nothing is asked, or built, with no server or no text.
    service.quickSearch('orders')
    connections.set([connection('a'), connection('b')])
    service.quickSearch('  ')
    expect(service.getSnapshot().documents[quickSearchId]).toBeUndefined()
    expect(calls.index).toHaveLength(0)
    service.quickSearch('ord')
    service.quickSearch('orders')
    expect(calls.search).toHaveLength(0)
    timers.run()
    expect(calls.search).toHaveLength(2)
    for (const [index, connectionId] of ['a', 'b'].entries()) {
      expect(calls.search[index]).toMatchObject({ connectionId, text: 'orders', in: 'names', match: 'fuzzy', limit: quickSearchHits, caseSensitive: false, wholeWord: false, regex: false })
      expect(calls.search[index]).not.toHaveProperty('kinds')
    }
    // The same text again asks nothing.
    service.quickSearch('orders')
    timers.run()
    expect(calls.search).toHaveLength(2)
    pendingSearch[0]({ ok: true, value: { hits: [hit], total: 1, partial: false, elapsedMs: 1, index: status() } })
    await settle()
    expect(serverGroups(service.getSnapshot().documents[quickSearchId]).map(group => [group.connectionId, group.hits.length, !!group.pending])).toEqual([['a', 1, false], ['b', 0, true]])
    // Emptied, it shows nothing; ended, the search still on its way is cancelled and it is forgotten.
    service.quickSearch('order')
    timers.run()
    service.endQuickSearch()
    expect(calls.cancel.at(-1)).toEqual(calls.search.slice(-2).map(call => call.requestId))
    expect(service.getSnapshot().documents[quickSearchId]).toBeUndefined()
    timers.run()
    expect(calls.search).toHaveLength(4)
    expect(calls.index).toHaveLength(0)
    // A tab's search names no limit: the backend's default stands. It opens exact, or with Fuzzy Match when asked.
    service.open('a', 'orders')
    expect(calls.search.at(-1)).not.toHaveProperty('limit')
    expect(calls.search.at(-1)).not.toHaveProperty('match')
    service.open('a', 'orders', false, undefined, true)
    expect(calls.search.at(-1)).toMatchObject({ text: 'orders', in: 'all', match: 'fuzzy' })
  })
  it('never builds an index for the header\'s Search, though it spans the servers as an All servers tab does', () => {
    // Indexing on connect is off, as its owner chose.
    const { service, calls, connections, timers } = harness({ indexOnConnect: false })
    connections.set([connection('a')])
    service.quickSearch('orders')
    timers.run()
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'a', text: 'orders' })
    // A server that connects while it is open is searched, and not indexed either.
    connections.set([connection('a'), connection('b')])
    expect(calls.search.at(-1)).toMatchObject({ connectionId: 'b', text: 'orders' })
    expect(calls.index).toHaveLength(0)
  })
  it('does not build for the header\'s Search with indexing on connect on either, where an All servers tab would', () => {
    const values = { indexOnConnect: false }
    const { service, calls, connections, timers } = harness(values)
    connections.set([connection('a')])
    values.indexOnConnect = true
    service.quickSearch('orders')
    timers.run()
    expect(calls.index).toHaveLength(0)
    service.open(undefined, undefined, true)
    expect(calls.index.map(call => call.connectionId)).toEqual(['a'])
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

describe('Search Objects\' server picker', () => {
  const live = [
    { ...connection('a'), displayName: 'Primary', color: 'red', options: { environment: 'Production' } },
    connection('b'),
    { ...connection('c'), options: { environment: 'QA lab' } }
  ] as unknown as LiveConnection[]
  const result = (total: number, extra: Partial<ObjectSearchResult> = {}): ObjectSearchResult => ({ hits: Array.from({ length: Math.min(total, 2) }, () => hit), total, partial: false, elapsedMs: 1, index: status(), ...extra })
  const base = { id: 'tab1', connectionId: 'a', text: 'x', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all' as const, types: [], asked: { text: 'x', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all' as const, types: [] } }

  it('labels All servers and each connected server with its colour, environment and its results for the current search', () => {
    const servers = [
      { connectionId: 'a', label: 'Primary', result: result(12) },
      { connectionId: 'b', label: 'srv-b', error: 'The search timed out.' },
      { connectionId: 'c', label: 'srv-c', pending: true }
    ]
    const options = serverPickerOptions({ ...base, allServers: true, servers, result: mergeAnswers(servers), requestId: 'r', landed: 'r' }, live)
    expect(options.map(option => [option.value, option.label, option.color, option.environment, option.count, !!option.pending])).toEqual([
      [allServersValue, 'All servers', undefined, undefined, 12, true],
      ['a', 'Primary', 'red', 'Production', 12, false],
      ['b', 'srv-b', undefined, undefined, undefined, false],
      ['c', 'srv-c', undefined, 'QA lab', undefined, true]
    ])
    expect(options.map(serverOptionName)).toEqual(['All servers, 12 results, searching', 'Primary, Production environment, 12 results', 'srv-b', 'srv-c, QA lab environment, searching'])
    // One server searched: only it has a count (the picker asks nothing of its own); with no search, none has.
    expect(serverPickerOptions({ ...base, result: result(1) }, live).map(option => option.count)).toEqual([undefined, 1, undefined, undefined])
    expect(serverPickerOptions({ ...base, result: result(0, { problem: 'The regular expression is not valid.' }) }, live).map(option => option.count)).toEqual([undefined, undefined, undefined, undefined])
    expect(serverPickerOptions({ ...base, text: '', asked: undefined }, live).every(option => option.count === undefined && !option.pending)).toBe(true)
  })

  it('marks every server and All servers as searching, with no count, while a new All servers search has yet to land', async () => {
    // The answers in view are the search before's (it keeps them until a server answers): its counts are not this search's.
    const servers = [{ connectionId: 'a', label: 'Primary', result: result(12) }, { connectionId: 'b', label: 'srv-b', result: result(3) }]
    const before = { ...base, allServers: true, servers, result: mergeAnswers(servers) }
    expect(serverPickerOptions(before, live).map(option => [option.count, !!option.pending])).toEqual([[15, false], [12, false], [3, false], [undefined, false]])
    const unlanded = serverPickerOptions({ ...before, text: 'y', requestId: 'r2' }, live)
    expect(unlanded.map(option => [option.count, !!option.pending])).toEqual([[undefined, true], [undefined, true], [undefined, true], [undefined, true]])
    expect(unlanded.map(serverOptionName)).toEqual(['All servers, searching', 'Primary, Production environment, searching', 'srv-b, searching', 'srv-c, QA lab environment, searching'])
    // The first landing is a server's error, so there is no result at all yet: the servers still on their way say so.
    const failed = [{ connectionId: 'a', label: 'Primary', error: 'The search timed out.' }, { connectionId: 'b', label: 'srv-b', pending: true }, { connectionId: 'c', label: 'srv-c', pending: true }]
    expect(serverPickerOptions({ ...base, allServers: true, servers: failed, landed: 'r2', requestId: 'r2' }, live).map(option => [option.count, !!option.pending]))
      .toEqual([[undefined, true], [undefined, false], [undefined, true], [undefined, true]])
    // A search cancelled as it landed leaves its pending marks on the answers in view: they are still not the new search's.
    const cancelled = [{ connectionId: 'a', label: 'Primary', result: result(12) }, { connectionId: 'b', label: 'srv-b', pending: true }]
    expect(serverPickerOptions({ ...before, servers: cancelled, result: mergeAnswers(cancelled), landed: 'r1', requestId: 'r2' }, live).map(option => [option.count, !!option.pending]))
      .toEqual([[undefined, true], [undefined, true], [undefined, true], [undefined, true]])

    // Through the service: the second query's picker shows no count of the first's until a server answers it.
    const { service, pendingSearch, connections, timers } = harness({ indexOnConnect: false })
    const two = [connection('a'), connection('b')]
    connections.set(two)
    const id = service.open('a', undefined, true)!
    const answer = (total: number): ApiResult<ObjectSearchResult> => ({ ok: true, value: result(total) })
    const shown = () => serverPickerOptions(service.getSnapshot().documents[id], two).map(option => [option.count, !!option.pending])
    service.setQuery(id, { text: 'orders' })
    timers.run()
    expect(shown()).toEqual([[undefined, true], [undefined, true], [undefined, true]])
    pendingSearch[0]!(answer(12))
    pendingSearch[1]!(answer(3))
    await settle()
    expect(shown()).toEqual([[15, false], [12, false], [3, false]])
    service.setQuery(id, { text: 'customer' })
    timers.run()
    expect(service.getSnapshot().documents[id].result?.total).toBe(15)
    expect(shown()).toEqual([[undefined, true], [undefined, true], [undefined, true]])
    pendingSearch[2]!(answer(4))
    await settle()
    expect(shown()).toEqual([[4, true], [4, false], [undefined, true]])
    pendingSearch[3]!(answer(1))
    await settle()
    expect(shown()).toEqual([[5, false], [4, false], [1, false]])
    expect(service.getSnapshot().documents[id].landed).toBeUndefined()
    service.dispose()
  })

  it('moves by type-ahead as a native select does: a prefix, or one letter typed again cycling', () => {
    const options = serverPickerOptions({ ...base, text: '' }, [connection('alpha'), connection('beta'), connection('bravo')])
    expect(options.map(option => option.label)).toEqual(['All servers', 'srv-alpha', 'srv-beta', 'srv-bravo'])
    expect(typeAheadMatch(options, 'a', 1)).toBe(0)
    expect(typeAheadMatch(options, 's', 0)).toBe(1)
    expect(typeAheadMatch(options, 's', 1)).toBe(2)
    expect(typeAheadMatch(options, 'ss', 1)).toBe(2)
    expect(typeAheadMatch(options, 'srv-br', 0)).toBe(3)
    expect(typeAheadMatch(options, 'SRV-B', 0)).toBe(2)
    expect(typeAheadMatch(options, 'zz', 0)).toBeUndefined()
  })

  it('renders a combobox named by its label, its listbox of options in the top layer, the chosen one selected', () => {
    const options = serverPickerOptions({ ...base, allServers: true, servers: [{ connectionId: 'a', label: 'Primary', result: result(3) }], result: result(3) }, live)
    const markup = renderToStaticMarkup(createElement(ServerPicker, { id: 'p', labelledBy: 'label', options, value: 'a', onChange: () => {} }))
    expect(markup).toMatch(/^<button type="button" role="combobox" id="p" class="object-search-server-button" aria-labelledby="label" aria-haspopup="listbox" aria-expanded="false" aria-controls="p-servers"/)
    expect(markup).toContain('<div id="p-servers" class="object-search-server-list" popover="manual" role="listbox" aria-labelledby="label">')
    expect([...markup.matchAll(/role="option" class="object-search-server-option" aria-selected="(\w+)" aria-label="([^"]*)"/g)].map(match => [match[1], match[2]]))
      .toEqual([['false', 'All servers, 3 results'], ['true', 'Primary, Production environment, 3 results'], ['false', 'srv-b'], ['false', 'srv-c, QA lab environment']])
    // The PROD tag and the count show in the rows; the closed combobox shows the chosen server without a count.
    expect(markup).toContain('<span class="object-search-server-count">3</span>')
    expect(markup.split('<div id="p-servers"')[0]).not.toContain('object-search-server-count')
    expect(markup.split('<div id="p-servers"')[0]).toContain('PROD')
  })
})

describe('Search Objects\' summary', () => {
  it('says what the index holds, or how far its build got', () => {
    expect(indexSummary({ connectionId: 'a', requestId: 'r', done: 1, total: 3, objects: 1200 }, undefined)).toBe('Indexing 1 of 3 databases (1,200 objects so far)…')
    expect(indexSummary(undefined, status({ skipped: [{ database: 'x', code: 'NO_DB_ACCESS', message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · 1 database skipped')
    expect(indexSummary(undefined, status({ definitions: false, indexed: 1 }))).toBe('Index: 40 objects (names only) in 1 database')
    expect(indexSummary(undefined, status({ skipped: [{ database: '', code: 'CATALOG_ERROR', message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · server objects skipped')
    // SQL Server Agent's objects, read in msdb, are their own gap: msdb itself was indexed, and a skipped msdb counts once.
    expect(indexSummary(undefined, status({ skipped: [{ database: 'msdb', code: 'TIMEOUT', message: 'm', agent: true }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · SQL Server Agent objects skipped')
    expect(indexSummary(undefined, status({ skipped: [{ database: 'msdb', code: 'NO_DB_ACCESS', message: 'm' }, { database: 'msdb', code: 'NO_DB_ACCESS', message: 'm', agent: true }] })))
      .toBe('Index: 40 objects, 5 definitions in 2 databases · 1 database skipped · SQL Server Agent objects skipped')
    expect(indexGap({ connectionId: 'c', done: 0, total: 0, objects: 0, status: status({ skipped: [{ database: 'msdb', code: 'TOO_LARGE', message: 'm', agent: true }] }) })).toBe('SQL Server Agent objects skipped')
    // BigQuery namesOnly, global discovery skips, and projects discovery phase in All servers summaries.
    expect(indexIncomplete(undefined, status({ provider: 'bigquery', namesOnly: ['disc-a', 'disc-b'] }))).toBe(true)
    expect(indexGap({ connectionId: 'bq', done: 0, total: 0, objects: 0, status: status({ provider: 'bigquery', namesOnly: ['disc-a', 'disc-b'] }) })).toBe('names only in 2 projects')
    expect(indexGap({ connectionId: 'bq', done: 0, total: 0, objects: 0, status: status({ provider: 'bigquery', skipped: [{ database: '', project: '', code: 'TOO_LARGE', message: 'cap' }] }) })).toBe('project list truncated')
    expect(bigQueryIndexSummary(undefined, status({ provider: 'bigquery', indexed: 2, projects: 2, skipped: [{ database: '', project: '', code: 'TOO_LARGE', message: 'cap' }] }))).toContain('project list truncated')
    expect(groupNote({ connectionId: 'bq', label: 'varia-alpha', start: 0, hits: [] }, { connectionId: 'bq', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' })).toBe('discovering projects…')
    expect(allServersSummary({ id: 's', connectionId: 'bq', allServers: true, text: 'x', caseSensitive: false, wholeWord: false, regex: false, fuzzy: false, scope: 'all', types: [], servers: [{ connectionId: 'bq', label: 'varia-alpha' }] },
      { bq: { connectionId: 'bq', requestId: 'r', done: 0, total: 0, objects: 0, phase: 'projects' } })).toContain('varia-alpha still discovering projects')
    expect(indexSummary(undefined, status({ skipped: [{ database: 'Big', code: childrenLeftOut, message: 'm' }] }))).toBe('Index: 40 objects, 5 definitions in 2 databases · columns and other children left out of 1 large database')
    expect(indexSummary(undefined, undefined)).toBe('This server has no index yet.')
    // Memory ran out: the line says how many definitions were left out, apart from the user's own names-only option
    // and from definitions only cut at their length (`cut` alone), and keeps the line in Object Explorer's band.
    const starved = status({ modules: 12, cut: 1206, leftOut: 1204, leftOutIn: 2 })
    expect(indexSummary(undefined, starved)).toBe('Index: 40 objects, 12 definitions in 2 databases · 1,204 definitions left out (not enough index memory)')
    expect(indexSummary(undefined, status({ cut: 1, leftOut: 1, leftOutIn: 1 }))).toBe('Index: 40 objects, 5 definitions in 2 databases · 1 definition left out (not enough index memory)')
    expect(indexSummary(undefined, status({ provider: 'bigquery', cut: 3, leftOut: 3, leftOutIn: 1 }))).toBe('Index: 40 objects, 5 definitions in 2 datasets · 3 definitions left out (not enough index memory)')
    // The count is the index's: some may be the server's own or the system objects', which are in no database.
    expect(indexSummary(undefined, status({ cut: 12, leftOut: 12 }))).toBe('Index: 40 objects, 5 definitions in 2 databases · 12 definitions left out (not enough index memory)')
    expect(indexIncomplete(undefined, starved)).toBe(true)
    expect(indexSummary(undefined, status({ cut: 2 }))).toBe('Index: 40 objects, 5 definitions in 2 databases')
    expect(indexIncomplete(undefined, status({ cut: 2 }))).toBe(false)
    expect(indexSummary(undefined, status({ definitions: false }))).not.toContain('memory')
    // What to do about it names the option by its label, and only an index short of memory gets the note: left-out
    // definitions, children left out, a database or dataset that did not fit, or BigQuery projects read by name only.
    const limit = settingDef('objectExplorer.search.memoryLimitMiB').label
    expect(indexMemoryNote([status(), starved])).toBe(`The index does not have enough memory, so a search inside definitions misses the ones left out. Raise ${limit} in Tools › Options › SQL Server Object Explorer › Commands, then rebuild the index.`)
    const partly = `The index does not have enough memory, so part of what could be indexed was left out. Raise ${limit} in Tools › Options › SQL Server Object Explorer › Commands, then rebuild the index.`
    expect(indexMemoryNote([status({ skipped: [{ database: 'Big', code: childrenLeftOut, message: 'm' }] })])).toBe(partly)
    expect(indexMemoryNote([status({ skipped: [{ database: 'Huge', code: 'TOO_LARGE', message: 'The database does not fit in the index\'s memory (512 MiB across every connection).' }] })])).toBe(partly)
    expect(indexMemoryNote([status({ provider: 'bigquery', namesOnly: ['disc-a'] })])).toBe(partly)
    // A BigQuery dataset that kept what it held while new objects' details did not fit: details missing, and the note.
    const partial = status({ provider: 'bigquery', skipped: [{ database: 'sales', project: 'varia-alpha', code: 'TOO_LARGE', details: true,
      message: 'The details of 3 objects were left out: BigQuery leaves part of the index\'s 512 MiB memory limit to SQL Server, and the rest does not hold them.' }] })
    expect(indexSummary(undefined, partial)).toBe('Index: 40 objects, 5 definitions in 2 datasets · details missing in 1 dataset')
    expect(indexGap({ connectionId: 'bq', done: 0, total: 0, objects: 0, status: partial })).toBe('details missing')
    // The same dataset with a failed read as well still counts once; another dataset counts too.
    const failedToo = { database: 'sales', project: 'varia-alpha', code: 'TIMEOUT', details: true, message: 'The details of 1 object could not be read: timed out.' } as const
    expect(indexSummary(undefined, { ...partial, skipped: [...partial.skipped, failedToo] })).toBe('Index: 40 objects, 5 definitions in 2 datasets · details missing in 1 dataset')
    expect(indexSummary(undefined, { ...partial, skipped: [...partial.skipped, { ...failedToo, project: 'varia-beta' }] })).toBe('Index: 40 objects, 5 definitions in 2 datasets · details missing in 2 datasets')
    // A dataset whose new names did not fit is left as it was read before: listed as skipped, with the note.
    const keptAsWas = status({ provider: 'bigquery', skipped: [{ database: 'sales', project: 'varia-alpha', code: 'TOO_LARGE',
      message: 'The dataset\'s changes did not fit, so it was kept as it was read before: BigQuery leaves part of the index\'s 512 MiB memory limit to SQL Server, and the rest is in use.' }] })
    expect(indexSummary(undefined, keptAsWas)).toBe('Index: 40 objects, 5 definitions in 2 datasets · 1 dataset skipped')
    expect(indexMemoryNote([keptAsWas])).toBe(partly)
    expect(indexMemoryNote([partial])).toBe(partly)
    expect(indexMemoryShort(starved)).toBe(true)
    for (const fine of [status(), status({ cut: 2 }), status({ definitions: false }), status({ skipped: [{ database: 'x', code: 'NO_DB_ACCESS', message: 'm' }] }),
      status({ provider: 'bigquery', skipped: [{ database: 'sales', project: 'p', code: 'TOO_LARGE', message: 'The dataset has more objects than the index lists; it keeps the first ones.' }] }),
      status({ state: 'none', leftOut: 1 }), undefined]) {
      expect(indexMemoryShort(fine), JSON.stringify(fine)).toBe(false)
      expect(indexMemoryNote([fine])).toBeUndefined()
    }
    // Build index is offered for the servers with no index and none building.
    const building = { connectionId: 'b', requestId: 'r', done: 0, total: 0, objects: 0 }, built = { connectionId: 'c', done: 1, total: 1, objects: 3, status: status() }
    expect(unindexedServers(['a', 'b', 'c', 'd'], { b: building, c: built, d: { connectionId: 'd', done: 0, total: 0, objects: 0, error: 'failed' } })).toEqual(['a', 'd'])
    expect(unindexedServers(['a'], {}, status())).toEqual([])
    expect(unindexedServers(['a'], {}, { ...status(), state: 'none' })).toEqual(['a'])
    expect(unindexedServers([], {})).toEqual([])
    expect(indexSummary({ connectionId: 'a', done: 0, total: 0, objects: 0, error: 'Denied.' }, undefined)).toBe('The index could not be built: Denied.')
  })
})

describe('Search Objects type filters', () => {
  it('names the kinds of the types chosen, in the index’s order, and every kind when none is', () => {
    expect(searchTypeKinds([])).toBeUndefined()
    expect(searchTypeKinds(['columns'])).toEqual(['column', 'bqColumn'])
    expect(searchTypeKinds(['indexes', 'tables'])).toEqual(['table', 'key', 'constraint', 'index', 'statistic', 'bqTable'])
    expect(searchTypeKinds(['bqSnapshots', 'procedures'])).toEqual(['procedure', 'bqTable:snapshot', 'bqRoutine:procedure'])
    expect(searchTypeKinds(searchTypes.map(type => type.id))).toEqual([...searchKindFilters])
    // Every type chosen: each engine's part fits one request.
    for (const provider of ['sqlserver', 'bigquery'] as const)
      expect(objectSearchParamsSchema.safeParse({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: 'x', kinds: providerSearchKinds(provider, searchTypeKinds(searchTypes.map(type => type.id))) }).success).toBe(true)
  })

  it('shows the chips of the engines searched, and any chosen that they lack', () => {
    const ids = (providers: readonly ('sqlserver' | 'bigquery')[], types: readonly typeof searchTypes[number]['id'][] = []) => shownSearchTypes(new Set(providers), types).map(type => type.id)
    expect(ids(['sqlserver'])).toEqual(searchTypes.filter(type => (type.providers as readonly string[]).includes('sqlserver')).map(type => type.id))
    expect(ids(['bigquery'])).toEqual(['tables', 'views', 'columns', 'procedures', 'bqMaterializedViews', 'bqExternalTables', 'bqSnapshots', 'bqClones', 'bqRoutines', 'bqTableFunctions', 'bqModels', 'bqDatasets'])
    expect(ids(['sqlserver', 'bigquery'])).toEqual(searchTypes.map(type => type.id))
    expect(ids(['sqlserver'], ['bqModels'])).toContain('bqModels')
    expect(ids([])).toEqual(ids(['sqlserver']))
    expect([...searchProviders([{ providerId: 'bigquery' }, { options: {} }, { options: { provider: 'bigquery' } }])].sort()).toEqual(['bigquery', 'sqlserver'])
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

describe('the search pickers in a popout', () => {
  it('place themselves against their own window and document, not the main window\'s', () => {
    for (const file of ['SearchPopover.tsx', 'ServerPicker.tsx']) {
      const source = readFileSync(new URL('../src/renderer/src/search/' + file, import.meta.url), 'utf8')
      // A popout's pane is portalled into the popout's document from this window: the global window and document are the
      // main window's, so a resize or scroll in the popout would never reach them.
      // A ResizeObserver made by the main window never fires for an element in a popout (core/windows.ts observeResize).
      expect(source, file).not.toMatch(/\bwindow\.(add|remove)EventListener|\bdocument\.(add|remove)EventListener|\bdocument\.(documentElement|activeElement)|\bnew ResizeObserver\(/)
      expect(source, file).toMatch(/ownerDocument/)
      expect(source, file).toMatch(/observeResize\(/)
    }
  })
})
