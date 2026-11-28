import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { BigQueryIndexScope, ObjectIndexProgress, ObjectIndexResult, ObjectIndexStatus } from '../src/shared/explorer/search'
import { languageHydrateLimits, type LanguageHydrateRequest, type LanguageHydrateResult, type LanguageLookupAnswer, type LanguageLookupPath, type LanguageLookupResult } from '../src/shared/language-lookup'
import type { SettingKey, SettingValue } from '../src/shared/settings/catalog'
import { googleSqlLanguageId } from '../src/renderer/src/languages/googlesql'
import { extractBigQueryRefreshScopes, formatBigQueryProjectDetail, hydrateTableCommandId, IndexCompletionService, starProjectCommandId } from '../src/renderer/src/languages/IndexCompletionService'
import { ObjectSearchService } from '../src/renderer/src/search/ObjectSearchService'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred, documentFixture } from './fixtures/documents'
// @ts-expect-error Monaco ships its internals without declarations; the suggest widget scores with this function.
import { fuzzyScore } from 'monaco-editor/base/common/filters.js'

type Scorer = (pattern: string, patternLow: string, patternStart: number, word: string, wordLow: string, wordStart: number) => [number] | undefined
const labelText = (label: string | Monaco.languages.CompletionItemLabel): string => typeof label === 'string' ? label : label.label
function monacoOrder(suggestions: Monaco.languages.CompletionItem[], typed: string): string[] {
  return suggestions.flatMap(item => {
    const text = labelText(item.label)
    const filter = item.filterText ?? text
    const score = (fuzzyScore as Scorer)(typed, typed.toLowerCase(), 0, filter, filter.toLowerCase(), 0)
    return score ? [{ label: text, score: score[0], sortText: item.sortText ?? '' }] : []
  }).sort((a, b) => b.score - a.score || (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0)).map(item => item.label)
}

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks() })

const token = (): Monaco.CancellationToken => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
function cancellationSource() {
  let cancelled = false
  const listeners = new Set<() => void>()
  return {
    token: {
      get isCancellationRequested() { return cancelled },
      onCancellationRequested: (listener: () => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } }
    } satisfies Monaco.CancellationToken,
    cancel: () => { if (cancelled) return; cancelled = true; for (const listener of listeners) listener() }
  }
}

const bqConnId = '11111111-1111-4111-8111-111111111111'
const bqConnId2 = '22222222-2222-4222-8222-222222222222'

function makeStatus(overrides: Partial<ObjectIndexStatus> = {}): ObjectIndexStatus {
  return {
    state: 'ready',
    builtAt: '2026-11-27T00:00:00Z',
    databases: 1,
    indexed: 1,
    objects: 4,
    modules: 0,
    cut: 0,
    skipped: [],
    definitions: true,
    ...overrides
  }
}

function createFixture(options: {
  lookup?: (requests: LanguageLookupPath[]) => Promise<ApiResult<LanguageLookupResult>>
  hydrate?: (params: LanguageHydrateRequest) => Promise<ApiResult<LanguageHydrateResult>>
  refreshScopes?: (connectionId: string, scopes: readonly BigQueryIndexScope[]) => Promise<boolean>
  withSearch?: boolean
  jitHydrateEnabled?: () => boolean
  starProject?: (connectionId: string, project: string) => Promise<boolean>
  reportError?: (message: string) => void
} = {}) {
  const connections = new ConnectionService()
  connections.add(
    { id: bqConnId, providerId: 'bigquery', generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery' },
    { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', authentication: 'gcloud' }
  )
  const { documents, events, model } = documentFixture({ provider: id => connections.get(id)?.providerId })
  let completionProvider: Monaco.languages.CompletionItemProvider | undefined
  let hoverProvider: Monaco.languages.HoverProvider | undefined
  const registeredCommands = new Map<string, (...args: unknown[]) => void>()
  const triggerCalls: string[] = []
  const monaco = {
    editor: {
      registerCommand: (id: string, handler: (...args: unknown[]) => void) => {
        registeredCommands.set(id, handler)
        return { dispose: () => { registeredCommands.delete(id) } }
      },
      getEditors: () => [{
        hasWidgetFocus: () => true,
        hasTextFocus: () => true,
        trigger: (_source: string, handlerId: string) => { triggerCalls.push(handlerId) }
      }]
    },
    languages: {
      CompletionItemKind: {
        Keyword: 14, Function: 1, Module: 8, Class: 6, Interface: 7, Method: 2, Value: 12, Field: 4, Property: 9, Variable: 5, Reference: 17
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_id: string, provider: Monaco.languages.CompletionItemProvider) => {
        completionProvider = provider
        return { dispose: () => {} }
      },
      registerHoverProvider: (_id: string, provider: Monaco.languages.HoverProvider) => {
        hoverProvider = provider
        return { dispose: () => {} }
      }
    }
  }

  const defaultLookup = async (requests: LanguageLookupPath[]): Promise<ApiResult<LanguageLookupResult>> => ({
    ok: true,
    value: {
      index: 'ready',
      answers: requests.map((request): LanguageLookupAnswer => {
        const key = request.path.join('.')
        if (key === 'varia-alpha.sales') {
          return {
            state: 'ready',
            path: [...request.path],
            truncated: false,
            items: [
              { name: 'orders', kind: 'bqTable' },
              { name: 'daily', kind: 'bqView' },
              { name: 'test_summary', kind: 'bqTable' },
              { name: 'TEST_archive', kind: 'bqTable' },
              { name: 'test', kind: 'bqTable' },
              { name: 'to_cents', kind: 'bqRoutine', subtype: 'scalar', detail: '(x NUMERIC) RETURNS INT64' }
            ]
          }
        }
        if (key === 'varia-alpha') {
          return { state: 'ready', path: [...request.path], truncated: false, items: [{ name: 'sales', kind: 'bqDataset' }, { name: 'staging', kind: 'bqDataset' }] }
        }
        if (key === '') {
          return { state: 'ready', path: [], truncated: false, items: [{ name: 'varia-alpha', kind: 'bqProject', detail: 'names' }] }
        }
        if (key === 'varia-alpha.sales.orders') {
          return {
            state: 'ready',
            path: [...request.path],
            truncated: false,
            items: [
              { name: 'id', kind: 'bqColumn', type: 'INT64', nullable: false },
              { name: 'customer', kind: 'bqColumn', type: 'STRING' }
            ]
          }
        }
        return { state: 'ready', path: [...request.path], truncated: false, items: [] }
      })
    }
  })

  const languageLookup = vi.fn(async (params: { connectionId: string; requests: LanguageLookupPath[] }) => (options.lookup ?? defaultLookup)(params.requests))
  const languageHydrate = options.hydrate ? vi.fn(options.hydrate) : undefined
  const ensureIndex = vi.fn()
  const progressListeners = new Set<(progress: ObjectIndexProgress) => void>()
  const explorerIndex = vi.fn<VariaApi['explorerIndex']>(async () => ({ ok: true, value: { elapsedMs: 1, status: makeStatus() } }))
  const explorerCancel = vi.fn<VariaApi['explorerCancel']>(async () => ({ ok: true, value: { cancelled: 0 } }))
  const explorerSearch = vi.fn<VariaApi['explorerSearch']>(async () => ({
    ok: true,
    value: { hits: [], total: 0, truncated: false, partial: false, elapsedMs: 1, index: makeStatus() }
  }))

  let objectSearch: ObjectSearchService | undefined
  if (options.withSearch) {
    let nextSeq = 0
    objectSearch = new ObjectSearchService({
      api: {
        explorerIndex,
        explorerSearch,
        explorerCancel,
        onExplorerIndexProgress: listener => { progressListeners.add(listener); return () => { progressListeners.delete(listener) } }
      },
      documents,
      connections,
      settings: {
        get: <K extends SettingKey>(key: K): SettingValue<K> => {
          if (key === 'objectExplorer.search.indexOnConnect') return false as SettingValue<K>
          if (key === 'objectExplorer.search.definitions') return true as SettingValue<K>
          if (key === 'objectExplorer.search.memoryLimitMiB') return 512 as SettingValue<K>
          return undefined as never
        }
      },
      events,
      newId: () => `req-${++nextSeq}`
    })
    cleanups.push(() => objectSearch?.dispose())
  }

  const service = new IndexCompletionService(
    monaco as never,
    { languageLookup, ...languageHydrate ? { languageHydrate } : {} },
    documents,
    connections,
    {
      ensureIndex,
      ...(options.refreshScopes
        ? { refreshScopes: options.refreshScopes }
        : objectSearch
          ? {
              refreshScopes: (id, scopes) => objectSearch.refreshBigQueryScopes(id, scopes),
              refreshScopesOutcome: (id, scopes) => objectSearch.refreshBigQueryScopesOutcome(id, scopes)
            }
          : {}),
      ...(objectSearch ? { indexState: objectSearch } : {}),
      ...(options.jitHydrateEnabled ? { jitHydrateEnabled: options.jitHydrateEnabled } : {}),
      ...(options.starProject ? { starProject: options.starProject } : {}),
      ...(options.reportError ? { reportError: options.reportError } : {})
    }
  )
  cleanups.push(() => service.dispose())

  async function completeAt(docId: string, sourceWithCaret: string, cancelToken?: Monaco.CancellationToken) {
    const caret = sourceWithCaret.indexOf('|')
    const text = sourceWithCaret.slice(0, caret) + sourceWithCaret.slice(caret + 1)
    const m = model(docId)
    m.edit(text)
    const pos = m.getPositionAt(caret) as Monaco.Position
    const result = await completionProvider!.provideCompletionItems(m.asModel(), pos, { triggerKind: 0 }, cancelToken ?? token())
    return result as Monaco.languages.CompletionList
  }

  async function hoverAt(docId: string, sourceWithCaret: string) {
    const caret = sourceWithCaret.indexOf('|')
    const text = sourceWithCaret.slice(0, caret) + sourceWithCaret.slice(caret + 1)
    const m = model(docId)
    m.edit(text)
    const pos = m.getPositionAt(caret) as Monaco.Position
    return hoverProvider!.provideHover(m.asModel(), pos, token())
  }

  return {
    service,
    documents,
    connections,
    events,
    model,
    languageLookup,
    languageHydrate,
    ensureIndex,
    objectSearch,
    explorerIndex,
    emitProgress: (progress: ObjectIndexProgress) => { for (const l of progressListeners) l(progress) },
    completeAt,
    hoverAt,
    registeredCommands,
    triggerCalls,
    completionProvider: () => completionProvider!
  }
}

describe('IndexCompletionService', () => {
  it('emits structured CompletionItemLabel without label.detail (F5)', async () => {
    const f = createFixture()
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)
    expect(f.model(tab.id).getLanguageId()).toBe(googleSqlLanguageId)

    const list = await f.completeAt(tab.id, 'SELECT * FROM |')
    const orders = list.suggestions.find(s => labelText(s.label) === 'orders')!
    const daily = list.suggestions.find(s => labelText(s.label) === 'daily')!
    const routine = list.suggestions.find(s => labelText(s.label) === 'to_cents')!
    expect(orders.label).toEqual({ label: 'orders', description: 'Table' })
    expect((orders.label as Monaco.languages.CompletionItemLabel).detail).toBeUndefined()
    expect(orders.detail).toBe('Table')
    expect(daily.label).toEqual({ label: 'daily', description: 'View' })
    expect(routine.label).toEqual({ label: 'to_cents', description: 'Function (x NUMERIC) RETURNS INT64' })
    expect(routine.detail).toBe('Function (x NUMERIC) RETURNS INT64')

    const kwList = await f.completeAt(tab.id, '|')
    const select = kwList.suggestions.find(s => labelText(s.label) === 'SELECT')!
    expect(select.label).toEqual({ label: 'SELECT' })
    expect((select.label as Monaco.languages.CompletionItemLabel).detail).toBeUndefined()
  })

  it('boosts case- and backtick-insensitive exact matches and re-ranks on growing words with 0 extra IPCs (F7)', async () => {
    const f = createFixture()
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)

    // Initial prefix `te`: incomplete is true so Monaco re-invokes as the user types `s` -> `t`.
    const initial = await f.completeAt(tab.id, 'SELECT * FROM te|')
    expect(initial.incomplete).toBe(true)
    expect(f.languageLookup).toHaveBeenCalledTimes(1)

    // Typing `test` hits LookupCache in-memory (0 extra IPCs) and boosts exact `test` to #1 ahead of `test_summary` & `TEST_archive`.
    const exact = await f.completeAt(tab.id, 'SELECT * FROM test|')
    expect(exact.incomplete).toBe(true)
    expect(f.languageLookup).toHaveBeenCalledTimes(1)
    expect(monacoOrder(exact.suggestions, 'test')[0]).toBe('test')
    const exactItem = exact.suggestions.find(s => labelText(s.label) === 'test')!
    expect(exactItem.sortText?.startsWith('0:')).toBe(true)
    expect(exactItem.filterText).toBe('test')
    const summaryItem = exact.suggestions.find(s => labelText(s.label) === 'test_summary')!
    expect(summaryItem.sortText?.startsWith('1:')).toBe(true)

    // Mixed-case `TEST` and backticked `` `varia-alpha.sales.TEST|` `` also boost `test` to #1.
    const upper = await f.completeAt(tab.id, 'SELECT * FROM TEST|')
    expect(monacoOrder(upper.suggestions, 'TEST')[0]).toBe('test')
    const backticked = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sales.TEST|`')
    expect(monacoOrder(backticked.suggestions, 'TEST')[0]).toBe('test')
  })

  it('consumes auto-closed trailing backtick on leaf accepts and stays inside on container accepts (F8)', async () => {
    const f = createFixture()
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)

    // Closed backtick at leaf end: `SELECT * FROM `varia-alpha.sales.or|` -> consumes closing ` and appends ` to insertText.
    const leaf = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sales.or|`')
    const orders = leaf.suggestions.find(s => labelText(s.label) === 'orders')!
    expect(orders.insertText).toBe('orders`')
    expect(orders.range).toEqual({
      insert: { startLineNumber: 1, startColumn: 34, endLineNumber: 1, endColumn: 37 },
      replace: { startLineNumber: 1, startColumn: 34, endLineNumber: 1, endColumn: 37 }
    })

    // Container inside closed backticks: `SELECT * FROM `varia-alpha.sa|` -> keeps caret inside (no ` consumed).
    const container = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sa|`')
    const sales = container.suggestions.find(s => labelText(s.label) === 'sales')!
    expect(sales.insertText).toBe('sales')
    expect(sales.range).toEqual({
      insert: { startLineNumber: 1, startColumn: 28, endLineNumber: 1, endColumn: 30 },
      replace: { startLineNumber: 1, startColumn: 28, endLineNumber: 1, endColumn: 30 }
    })

    // Open unclosed backtick: no trailing ` appended.
    const open = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sales.or|')
    expect(open.suggestions.find(s => labelText(s.label) === 'orders')!.insertText).toBe('orders')

    // Mid-path before `.orders`: next char is `.`, no trailing ` appended.
    const midPath = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sa|.orders`')
    expect(midPath.suggestions.find(s => labelText(s.label) === 'sales')!.insertText).toBe('sales')

    // Mid-word before `d` in `or|d`: offset < word.end, no trailing ` appended.
    const midWord = await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sales.or|d`')
    expect(midWord.suggestions.find(s => labelText(s.label) === 'orders')!.insertText).toBe('orders')

    // Escaped backtick and backslash inside names keep exact-match boosting, partial prefix filtering, and closing backtick exit.
    const seenPrefixes: (string | undefined)[] = []
    const special = createFixture({
      lookup: async requests => {
        for (const r of requests) seenPrefixes.push(r.prefix)
        const allItems = [
          { name: 'a`b', kind: 'bqTable' },
          { name: 'a`b_extra', kind: 'bqTable' },
          { name: '`raw', kind: 'bqTable' },
          { name: 'c\\d', kind: 'bqTable' }
        ]
        return {
          ok: true,
          value: {
            index: 'ready',
            answers: requests.map(request => {
              const prefix = (request.prefix ?? '').toLowerCase()
              return {
                state: 'ready',
                path: [...request.path],
                truncated: false,
                items: allItems.filter(item => item.name.toLowerCase().startsWith(prefix))
              }
            })
          }
        }
      }
    })
    const specialTab = special.documents.create('q2.sql', '', 'sales', bqConnId)
    const specialList = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.a\\`b|`')
    const exactEscaped = specialList.suggestions.find(s => labelText(s.label) === 'a`b')!
    expect(exactEscaped.insertText).toBe('a\\`b`')
    expect(exactEscaped.sortText?.startsWith('0:')).toBe(true)
    expect(exactEscaped.filterText).toBe('a\\`b')
    expect(monacoOrder(specialList.suggestions, 'a\\`b')[0]).toBe('a`b')

    const leadingTickList = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.\\`raw|`')
    const leadingTick = leadingTickList.suggestions.find(s => labelText(s.label) === '`raw')!
    expect(leadingTick.sortText?.startsWith('0:')).toBe(true)
    expect(leadingTick.filterText).toBe('\\`raw')
    expect(leadingTick.insertText).toBe('\\`raw`')

    // Partial escaped prefixes keep unescaped lookup prefix and escaped Monaco filterText so fuzzyScore matches.
    const partialTick = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.a\\`|')
    expect(seenPrefixes.at(-1)).toBe('a`')
    expect(monacoOrder(partialTick.suggestions, 'a\\`')).toEqual(['a`b', 'a`b_extra'])
    expect(partialTick.suggestions.find(s => labelText(s.label) === 'a`b')).toMatchObject({ filterText: 'a\\`b', insertText: 'a\\`b' })

    const partialLeadingTick = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.\\`ra|')
    expect(seenPrefixes.at(-1)).toBe('`ra')
    expect(monacoOrder(partialLeadingTick.suggestions, '\\`ra')).toEqual(['`raw'])
    expect(partialLeadingTick.suggestions.find(s => labelText(s.label) === '`raw')).toMatchObject({ filterText: '\\`raw', insertText: '\\`raw' })

    const partialBackslash = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.c\\\\|')
    expect(seenPrefixes.at(-1)).toBe('c\\')
    expect(monacoOrder(partialBackslash.suggestions, 'c\\\\')).toEqual(['c\\d'])
    expect(partialBackslash.suggestions.find(s => labelText(s.label) === 'c\\d')).toMatchObject({ filterText: 'c\\\\d', insertText: 'c\\\\d' })

    const partialClosedTick = await special.completeAt(specialTab.id, 'SELECT * FROM `varia-alpha.sales.a\\`|`')
    expect(monacoOrder(partialClosedTick.suggestions, 'a\\`')).toEqual(['a`b', 'a`b_extra'])
    expect(partialClosedTick.suggestions.find(s => labelText(s.label) === 'a`b')?.insertText).toBe('a\\`b`')
  })

  it('does not treat keyword-only clause sites as needing index-building incomplete flags (F9)', async () => {
    const f = createFixture({
      lookup: async requests => ({ ok: true, value: { index: 'building', answers: requests.map(r => ({ state: 'building', path: [...r.path], items: [], truncated: false })) } })
    })
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)
    // Seed LookupCache.index = 'building' via an object lookup.
    const obj = await f.completeAt(tab.id, 'SELECT * FROM |')
    expect(obj.incomplete).toBe(true)

    // `afterFromTable` does not ask the index, so `building` is false (only `list.items.length > 0` drives exact re-ranking).
    const afterTable = await f.completeAt(tab.id, 'SELECT * FROM sales.orders t|')
    const labels = afterTable.suggestions.map(s => labelText(s.label))
    expect(labels).toContain('TABLESAMPLE')
    expect(labels).not.toContain('TABLE')
  })

  it('extracts validated BigQuery refresh scopes (F10)', () => {
    expect(extractBigQueryRefreshScopes('SELECT * FROM orders', 'varia-alpha', 'sales')).toEqual([
      { project: 'varia-alpha', dataset: 'sales' }
    ])
    expect(extractBigQueryRefreshScopes(
      'SELECT * FROM other_ds.t1; SELECT * FROM `ext-project.ext_ds.t2`; SELECT * FROM `varia-alpha.INFORMATION_SCHEMA.TABLES`; SELECT * FROM `pub-project.pub_ds.',
      'varia-alpha',
      'sales'
    )).toEqual([
      { project: 'varia-alpha', dataset: 'sales' },
      { project: 'varia-alpha', dataset: 'other_ds' },
      { project: 'ext-project', dataset: 'ext_ds' },
      { project: 'pub-project', dataset: 'pub_ds' }
    ])
    expect(extractBigQueryRefreshScopes('', 'varia-alpha')).toEqual([{ project: 'varia-alpha' }])
    // Trailing literals, parameters, system variables, semicolons, comments, subqueries, non-star CTEs, and domain-scoped projects.
    for (const sql of [
      'SELECT * FROM ds_1.t WHERE id = 1',
      'SELECT * FROM ds_1.t LIMIT 10',
      'SELECT * FROM ds_1.t LIMIT 10;',
      "SELECT * FROM ds_1.t WHERE name = 'abc'",
      'SELECT * FROM ds_1.t WHERE id = @p',
      'SELECT * FROM ds_1.t WHERE p = @@project_id',
      'SELECT * FROM ds_1.t -- trailing comment'
    ]) {
      expect(extractBigQueryRefreshScopes(sql, 'varia-alpha'), sql).toEqual([{ project: 'varia-alpha', dataset: 'ds_1' }])
    }
    expect(extractBigQueryRefreshScopes('SELECT * FROM ds_1.t WHERE id IN (SELECT id FROM ds_2.t2)', 'varia-alpha')).toEqual([
      { project: 'varia-alpha', dataset: 'ds_1' },
      { project: 'varia-alpha', dataset: 'ds_2' }
    ])
    expect(extractBigQueryRefreshScopes('WITH c1 AS (SELECT id FROM other_ds.t1) SELECT * FROM c1', 'varia-alpha')).toEqual([
      { project: 'varia-alpha', dataset: 'other_ds' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM `example.com:my-proj.my_ds.my_tbl` LIMIT 10', 'varia-alpha')).toEqual([
      { project: 'example.com:my-proj', dataset: 'my_ds' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-project-123456.2024_sales.orders', 'varia-alpha')).toEqual([
      { project: 'my-project-123456', dataset: '2024_sales' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-project-123456.2024_sales.', 'varia-alpha')).toEqual([
      { project: 'my-project-123456', dataset: '2024_sales' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-project-123456.2024e1.orders', 'varia-alpha')).toEqual([
      { project: 'my-project-123456', dataset: '2024e1' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-project-123456.2024e1.', 'varia-alpha')).toEqual([
      { project: 'my-project-123456', dataset: '2024e1' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM gcp-123abc.2024_01.2024_01-2b', 'varia-alpha')).toEqual([
      { project: 'gcp-123abc', dataset: '2024_01' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM gcp-123abc.2024_01.', 'varia-alpha')).toEqual([
      { project: 'gcp-123abc', dataset: '2024_01' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT a-1.5 FROM t', 'varia-alpha')).toEqual([{ project: 'varia-alpha' }])
    expect(extractBigQueryRefreshScopes('SELECT a-1.5e2 FROM t', 'varia-alpha')).toEqual([{ project: 'varia-alpha' }])
    expect(extractBigQueryRefreshScopes('SELECT 10-2.5', 'varia-alpha')).toEqual([{ project: 'varia-alpha' }])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-proj-1.my_ds.`my-table`', 'varia-alpha')).toEqual([
      { project: 'my-proj-1', dataset: 'my_ds' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM `my-project-123456`.`2024e1`.orders', 'varia-alpha')).toEqual([
      { project: 'my-project-123456', dataset: '2024e1' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM my-proj-1.`2024_sales`.orders', 'varia-alpha')).toEqual([
      { project: 'my-proj-1', dataset: '2024_sales' }
    ])
    expect(extractBigQueryRefreshScopes('SELECT * FROM `example.com:my-proj-1`.2024e1.`orders`', 'varia-alpha')).toEqual([
      { project: 'example.com:my-proj-1', dataset: '2024e1' }
    ])
  })

  it('shows IntelliSense refreshing during refreshCache, deduplicates, and settles cleanly on cancel/close/switch (F10)', async () => {
    const firstRefresh = deferred<boolean>()
    const refreshScopes = vi.fn(async () => firstRefresh.promise)
    const f = createFixture({ refreshScopes })
    const tab1 = f.documents.create('q1.sql', 'SELECT * FROM orders', 'sales', bqConnId)
    const tab2 = f.documents.create('q2.sql', 'SELECT 1', 'sales', bqConnId)

    // Seed cache before refresh.
    await f.completeAt(tab1.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(1)

    const p1 = f.service.refreshCache(tab1.id)
    const p2 = f.service.refreshCache(tab1.id)
    expect(refreshScopes).toHaveBeenCalledTimes(1)
    expect(refreshScopes).toHaveBeenCalledWith(bqConnId, [{ project: 'varia-alpha', dataset: 'sales' }])
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense refreshing')

    // Switching active tab to tab2 keeps tab1 refreshing until settled.
    f.documents.activate(tab2.id)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense refreshing')
    expect(f.service.availability(tab2.id)?.label).toBe('IntelliSense')

    firstRefresh.resolve(true)
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense')

    // Cache was cleared so next completion re-asks languageLookup.
    await f.completeAt(tab1.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(2)

    // Token cancellation settles false cleanly when it is the only caller.
    const secondRefresh = deferred<boolean>()
    refreshScopes.mockImplementationOnce(async () => secondRefresh.promise)
    const cts = cancellationSource()
    const cancelled = f.service.refreshCache(tab1.id, cts.token)
    cts.cancel()
    expect(await cancelled).toBe(false)
    secondRefresh.resolve(true)
    await Promise.resolve()

    // Concurrent callers sharing a deduplicated refresh: cancelling one caller does not cancel the other or clear refreshing status.
    const sharedRefresh = deferred<boolean>()
    refreshScopes.mockImplementationOnce(async () => sharedRefresh.promise)
    const cts1 = cancellationSource()
    const caller1 = f.service.refreshCache(tab1.id, cts1.token)
    const caller2 = f.service.refreshCache(tab1.id)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense refreshing')
    cts1.cancel()
    expect(await caller1).toBe(false)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense refreshing')
    sharedRefresh.resolve(true)
    expect(await caller2).toBe(true)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense')

    // Closing a tab mid-refresh cancels cleanly without throwing.
    const thirdRefresh = deferred<boolean>()
    refreshScopes.mockImplementationOnce(async () => thirdRefresh.promise)
    const onClose = f.service.refreshCache(tab1.id)
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense refreshing')
    await f.documents.close(tab1.id)
    expect(await onClose).toBe(false)
    thirdRefresh.resolve(true)
  })

  it('ignores stale languageLookup failures after a tab switches connections', async () => {
    const firstLookup = deferred<ApiResult<LanguageLookupResult>>()
    const secondLookup = deferred<ApiResult<LanguageLookupResult>>()
    let call = 0
    const f = createFixture({
      lookup: async () => (++call === 1 ? firstLookup.promise : secondLookup.promise)
    })
    f.connections.add(
      { id: bqConnId2, providerId: 'bigquery', generation: 1, server: 'varia-beta', database: 'census', serverVersion: 'BigQuery' },
      { provider: 'bigquery', project: 'varia-beta', dataset: 'census', authentication: 'gcloud' }
    )
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)

    const staleCompletion = f.completeAt(tab.id, 'SELECT * FROM |')
    f.documents.update(tab.id, { connectionId: bqConnId2, database: 'census' })
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')

    firstLookup.resolve({ ok: false, code: 'TIMEOUT', error: 'conn1 exploded' })
    await staleCompletion
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')
    expect(f.service.getSnapshot().errors.get(tab.id)).toBeUndefined()

    const freshCompletion = f.completeAt(tab.id, 'SELECT * FROM |')
    secondLookup.resolve({ ok: true, value: { index: 'ready', answers: [{ state: 'ready', path: ['varia-beta', 'census'], truncated: false, items: [] }] } })
    await freshCompletion
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')
  })

  it('clears only the affected connection LookupCache at 0 ms on ObjectSearchService build, refresh and DDL stale updates (F11)', async () => {
    const f = createFixture({ withSearch: true })
    f.connections.add(
      { id: bqConnId2, providerId: 'bigquery', generation: 1, server: 'varia-beta', database: 'census', serverVersion: 'BigQuery' },
      { provider: 'bigquery', project: 'varia-beta', dataset: 'census', authentication: 'gcloud' }
    )
    const tab1 = f.documents.create('q1.sql', '', 'sales', bqConnId)
    const tab2 = f.documents.create('q2.sql', '', 'census', bqConnId2)

    const build1 = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => build1.promise)

    // Start a build on conn1: Snapshot.indexes moves to 'building' at 0 ms.
    f.objectSearch!.build(bqConnId)
    expect(f.service.getSnapshot().indexes.get(`${bqConnId}:1`)).toBe('building')
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense indexing')

    // Seed caches on both connections before completing conn1's build.
    await f.completeAt(tab1.id, 'SELECT * FROM |')
    await f.completeAt(tab2.id, 'SELECT * FROM |')
    const callsBeforeFinish = f.languageLookup.mock.calls.length

    // Progress ticks with the same requestId do not trigger spurious invalidations.
    f.emitProgress({ requestId: 'req-1', done: 1, total: 2, objects: 3, phase: 'details' })
    await f.completeAt(tab2.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(callsBeforeFinish)

    // Completing conn1's build clears conn1's LookupCache at 0 ms (and NOT conn2's), and sets index to 'ready'.
    build1.resolve({ ok: true, value: { elapsedMs: 1, status: makeStatus() } })
    await vi.waitFor(() => expect(f.service.getSnapshot().indexes.get(`${bqConnId}:1`)).toBe('ready'))
    expect(f.service.availability(tab1.id)?.label).toBe('IntelliSense')

    // Conn2 still hits cache (0 new IPCs); conn1 re-asks languageLookup immediately (1 new IPC).
    await f.completeAt(tab2.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(callsBeforeFinish)
    await f.completeAt(tab1.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(callsBeforeFinish + 1)

    // DDL-stale event triggers stale refresh and invalidates conn1's LookupCache again upon completion.
    const staleBuild = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => staleBuild.promise)
    f.events.emit({ type: 'query.finished', tabId: tab1.id, queryId: 'query-1', summary: { indexStale: 1 } as never })
    expect(f.service.getSnapshot().indexes.get(`${bqConnId}:1`)).toBe('building')
    staleBuild.resolve({ ok: true, value: { elapsedMs: 1, status: makeStatus({ staleMark: 1, objects: 5 }) } })
    await vi.waitFor(() => expect(f.service.getSnapshot().indexes.get(`${bqConnId}:1`)).toBe('ready'))
    await f.completeAt(tab1.id, 'SELECT * FROM |')
    expect(f.languageLookup).toHaveBeenCalledTimes(callsBeforeFinish + 2)

    // Disposing IndexCompletionService unsubscribes from ObjectSearchService cleanly.
    f.service.dispose()
    const callsAfterDispose = f.languageLookup.mock.calls.length
    f.objectSearch!.build(bqConnId)
    expect(f.languageLookup).toHaveBeenCalledTimes(callsAfterDispose)
  })

  it('surfaces explorer.index failures on both initial build and scoped refresh while keeping cancel/disconnect silent', async () => {
    const f = createFixture({ withSearch: true })
    const tab = f.documents.create('q1.sql', 'SELECT * FROM orders', 'sales', bqConnId)

    // 1. Initial build fails during Ctrl+Shift+R: refreshCache rejects with real index error & availability shows IntelliSense unavailable.
    f.explorerIndex.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', error: 'BigQuery metadata timed out.' })
    await expect(f.service.refreshCache(tab.id)).rejects.toThrow('BigQuery metadata timed out.')
    expect(f.service.availability(tab.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'BigQuery metadata timed out.' })

    // 2. Subsequent build succeeds: clears error back to IntelliSense.
    f.explorerIndex.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, status: makeStatus() } })
    expect(await f.service.refreshCache(tab.id)).toBe(true)
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')

    // 3. Scoped refresh on ready index fails: refreshCache rejects with scoped error & availability shows IntelliSense unavailable.
    f.explorerIndex.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', error: 'Dataset refresh timed out.' })
    await expect(f.service.refreshCache(tab.id)).rejects.toThrow('Dataset refresh timed out.')
    expect(f.service.availability(tab.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Dataset refresh timed out.' })

    // 4. Token-backed refresh rejects if not cancelled, and settles false if token cancelled before failure.
    const errScope = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => errScope.promise)
    const activeToken = cancellationSource()
    const failingWithToken = f.service.refreshCache(tab.id, activeToken.token)
    errScope.resolve({ ok: false, code: 'PERMISSION_DENIED', error: 'Access denied.' })
    await expect(failingWithToken).rejects.toThrow('Access denied.')

    // Recover before testing deliberate cancellation / stopBuild / disconnect.
    f.explorerIndex.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, status: makeStatus() } })
    expect(await f.service.refreshCache(tab.id)).toBe(true)
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')

    // 5. Deliberate stopBuild (CANCELLED) settles false cleanly without throwing or marking unavailable.
    const stopped = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => stopped.promise)
    const stopPromise = f.service.refreshCache(tab.id)
    f.objectSearch!.stopBuild(bqConnId)
    stopped.resolve({ ok: false, code: 'CANCELLED', error: 'Cancelled' })
    expect(await stopPromise).toBe(false)
    expect(f.service.availability(tab.id)?.label).toBe('IntelliSense')

    // 6. Disconnect mid-refresh settles false cleanly without throwing.
    const disconnected = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => disconnected.promise)
    const disconnectPromise = f.service.refreshCache(tab.id)
    f.connections.remove(bqConnId)
    expect(await disconnectPromise).toBe(false)
    disconnected.resolve({ ok: false, code: 'CONNECTION_LOST', error: 'Disconnected' })
  })

  it('clears stale refresh errors on Search Objects rebuild while preserving languageLookup errors until lookup succeeds', async () => {
    const f = createFixture({ withSearch: true })
    const tabRefresh = f.documents.create('q1.sql', 'SELECT * FROM orders', 'sales', bqConnId)
    const tabLookup = f.documents.create('q2.sql', 'SELECT * FROM orders', 'sales', bqConnId)

    // 1. Seed a ready index, then fail Ctrl+Shift+R (scoped refresh timeout) on tabRefresh.
    f.explorerIndex.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, status: makeStatus() } })
    expect(await f.service.refreshCache(tabRefresh.id)).toBe(true)
    f.explorerIndex.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', error: 'Dataset refresh timed out.' })
    await expect(f.service.refreshCache(tabRefresh.id)).rejects.toThrow('Dataset refresh timed out.')
    expect(f.service.availability(tabRefresh.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Dataset refresh timed out.' })

    // Switching tabs must not drop the refresh error before recovery.
    f.documents.activate(tabLookup.id)
    expect(f.service.availability(tabRefresh.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Dataset refresh timed out.' })

    // Also record a languageLookup-sourced error on tabLookup.
    f.languageLookup.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', error: 'Lookup IPC timed out.' })
    await f.completeAt(tabLookup.id, 'SELECT * FROM |')
    expect(f.service.availability(tabLookup.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Lookup IPC timed out.' })

    // 2. Subsequent Search Objects full rebuild starts and succeeds: tabRefresh flips to indexing -> IntelliSense immediately,
    // while tabLookup's languageLookup-sourced error remains until languageLookup succeeds.
    const rebuild = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => rebuild.promise)
    f.objectSearch!.build(bqConnId)
    expect(f.service.availability(tabRefresh.id)?.label).toBe('IntelliSense indexing')
    expect(f.service.availability(tabLookup.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Lookup IPC timed out.' })

    rebuild.resolve({ ok: true, value: { elapsedMs: 1, status: makeStatus({ builtAt: '2026-11-27T01:00:00Z' }) } })
    await vi.waitFor(() => expect(f.service.getSnapshot().indexes.get(`${bqConnId}:1`)).toBe('ready'))
    expect(f.service.availability(tabRefresh.id)?.label).toBe('IntelliSense')
    expect(f.service.availability(tabLookup.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Lookup IPC timed out.' })

    // Initial-build Ctrl+Shift+R failure also clears cleanly on subsequent Search Objects rebuild.
    const failedInitial = deferred<ApiResult<ObjectIndexResult>>()
    // Simulate a fresh connection whose index has no ready state yet.
    f.connections.add(
      { id: bqConnId2, providerId: 'bigquery', generation: 1, server: 'varia-beta', database: 'census', serverVersion: 'BigQuery' },
      { provider: 'bigquery', project: 'varia-beta', dataset: 'census', authentication: 'gcloud' }
    )
    const tabInitial = f.documents.create('q3.sql', 'SELECT * FROM pop', 'census', bqConnId2)
    f.explorerIndex.mockImplementationOnce(async () => failedInitial.promise)
    const initialRefresh = f.service.refreshCache(tabInitial.id)
    failedInitial.resolve({ ok: false, code: 'TIMEOUT', error: 'Initial build timed out.' })
    await expect(initialRefresh).rejects.toThrow('Initial build timed out.')
    expect(f.service.availability(tabInitial.id)).toEqual({ label: 'IntelliSense unavailable', detail: 'Initial build timed out.' })

    const recoveryBuild = deferred<ApiResult<ObjectIndexResult>>()
    f.explorerIndex.mockImplementationOnce(async () => recoveryBuild.promise)
    f.objectSearch!.build(bqConnId2)
    expect(f.service.availability(tabInitial.id)?.label).toBe('IntelliSense indexing')
    recoveryBuild.resolve({ ok: true, value: { elapsedMs: 1, status: makeStatus({ builtAt: '2026-11-27T02:00:00Z' }) } })
    await vi.waitFor(() => expect(f.service.getSnapshot().indexes.get(`${bqConnId2}:1`)).toBe('ready'))
    expect(f.service.availability(tabInitial.id)?.label).toBe('IntelliSense')

    // Next successful languageLookup clears tabLookup's lookup-sourced error.
    await f.completeAt(tabLookup.id, 'SELECT * FROM |')
    expect(f.service.availability(tabLookup.id)?.label).toBe('IntelliSense')
  })

  it('formats PR #738 project tiers and preserves Billing -> Starred -> Recent -> Discovered ordering in Monaco', async () => {
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'billing' })).toBe('Billing')
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'starred' })).toBe('★ Starred')
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'discovered', recent: true })).toBe('Recent')
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'discovered' })).toBe('Discovered')
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'discovered', namesOnly: true })).toBe('Discovered · Names only · memory cap')
    expect(formatBigQueryProjectDetail({ name: 'p', kind: 'bqProject', tier: 'discovered', indexing: true })).toBe('Discovered · Wave 3 indexing…')

    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.path.length === 0) {
              return {
                state: 'ready',
                path: [],
                truncated: false,
                items: [
                  { name: 'varia-alpha', kind: 'bqProject', tier: 'billing' },
                  { name: 'zzz-starred-dw', kind: 'bqProject', tier: 'starred' },
                  { name: 'mmm-recent-proj', kind: 'bqProject', tier: 'discovered', recent: true },
                  { name: 'aaa-discovered-cap', kind: 'bqProject', tier: 'discovered', namesOnly: true, detail: 'names' },
                  { name: 'aab-discovered-wave3', kind: 'bqProject', tier: 'discovered', indexing: true }
                ]
              }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      })
    })
    const tab = f.documents.create('tiers.sql', '', '', bqConnId)
    const list = await f.completeAt(tab.id, 'SELECT * FROM |')
    const projectItems = list.suggestions
      .filter(s => ['varia-alpha', 'zzz-starred-dw', 'mmm-recent-proj', 'aaa-discovered-cap', 'aab-discovered-wave3'].includes(labelText(s.label)))
      .sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))
    expect(projectItems.map(item => labelText(item.label))).toEqual([
      'varia-alpha', 'zzz-starred-dw', 'mmm-recent-proj', 'aaa-discovered-cap', 'aab-discovered-wave3'
    ])
    expect(projectItems.map(item => (item.label as Monaco.languages.CompletionItemLabel).description)).toEqual([
      'Billing', '★ Starred', 'Recent', 'Discovered · Names only · memory cap', 'Discovered · Wave 3 indexing…'
    ])
  })

  it('batches cross-project fuzzy table jump on FROM <2+ chars>, formats compact vs backticked paths, and caches growing prefixes', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.mode === 'jump') {
              return {
                state: 'ready',
                path: [],
                truncated: false,
                items: [
                  { name: 'daily_revenue', kind: 'bqTable', tier: 'billing', project: 'varia-alpha', dataset: 'finance' },
                  { name: 'daily_revenue_v2', kind: 'bqTable', tier: 'starred', project: 'dw-shared', dataset: 'gold' },
                  { name: 'daily_rev_raw', kind: 'bqTable', tier: 'discovered', namesOnly: true, project: 'org-raw-09', dataset: 'landing' }
                ]
              }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      })
    })
    // Tab with <no default dataset> (empty database string).
    const tab = f.documents.create('jump.sql', '', '', bqConnId)
    const first = await f.completeAt(tab.id, 'SELECT * FROM daily_rev|')
    // Batched into the exact same single languageLookup IPC call!
    expect(f.languageLookup).toHaveBeenCalledTimes(1)
    expect(f.languageLookup.mock.calls[0][0].requests.some(r => r.mode === 'jump' && r.prefix === 'daily_rev')).toBe(true)

    const order = monacoOrder(first.suggestions, 'daily_rev')
    expect(order.slice(0, 3)).toEqual(['daily_revenue', 'daily_revenue_v2', 'daily_rev_raw'])
    const billingHit = first.suggestions.find(s => labelText(s.label) === 'daily_revenue')!
    const starredHit = first.suggestions.find(s => labelText(s.label) === 'daily_revenue_v2')!
    const discHit = first.suggestions.find(s => labelText(s.label) === 'daily_rev_raw')!
    expect(billingHit.insertText).toBe('finance.daily_revenue')
    expect((billingHit.label as Monaco.languages.CompletionItemLabel).description).toBe('finance · Table')
    expect(starredHit.insertText).toBe('`dw-shared.gold.daily_revenue_v2`')
    expect((starredHit.label as Monaco.languages.CompletionItemLabel).description).toBe('dw-shared.gold · ★ Starred · Table')
    expect(discHit.insertText).toBe('`org-raw-09.landing.daily_rev_raw`')
    expect((discHit.label as Monaco.languages.CompletionItemLabel).description).toBe('org-raw-09.landing · Names only · Table')

    // Growing prefix `daily_revenue` hits jump cache in RAM with 0 extra IPC calls!
    const second = await f.completeAt(tab.id, 'SELECT * FROM daily_revenue|')
    expect(f.languageLookup).toHaveBeenCalledTimes(1)
    expect(second.suggestions.map(s => labelText(s.label))).toContain('daily_revenue')
    expect(second.suggestions.map(s => labelText(s.label))).toContain('daily_revenue_v2')
    expect(second.suggestions.map(s => labelText(s.label))).not.toContain('daily_rev_raw')
  })

  it('auto-hydrates namesOnly / Wave-3-pending tables on SELECT p.| when enabled and completes columns immediately', async () => {
    let hydrated = false
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.path.join('.') === 'discovered-proj.web.sessions') {
              return hydrated
                ? {
                    state: 'partial',
                    path: ['discovered-proj', 'web', 'sessions'],
                    truncated: false,
                    object: { name: 'sessions', kind: 'bqTable', detailed: true },
                    items: [
                      { name: 'session_id', kind: 'bqColumn', type: 'STRING', nullable: false },
                      { name: 'started_at', kind: 'bqColumn', type: 'TIMESTAMP', nullable: true }
                    ]
                  }
                : {
                    state: 'partial',
                    path: ['discovered-proj', 'web', 'sessions'],
                    truncated: false,
                    object: { name: 'sessions', kind: 'bqTable', detailed: false },
                    items: []
                  }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      }),
      hydrate: async params => {
        hydrated = true
        return {
          ok: true,
          value: { outcomes: params.targets.map(t => ({ project: t.project, dataset: t.dataset, name: t.name, status: 'hydrated' as const })) }
        }
      },
      jitHydrateEnabled: () => true
    })

    const tab = f.documents.create('jit.sql', '', 'sales', bqConnId)
    const list = await f.completeAt(tab.id, 'SELECT p.| FROM `discovered-proj.web.sessions` p')
    expect(f.languageHydrate).toHaveBeenCalledTimes(1)
    expect(f.languageHydrate).toHaveBeenCalledWith({
      connectionId: bqConnId,
      targets: [{ project: 'discovered-proj', dataset: 'web', name: 'sessions', allowExternal: false }]
    })
    expect(list.suggestions.map(s => labelText(s.label))).toEqual(['session_id', 'started_at'])
  })

  it('shows actionable Fetch schema (free) and ★ Star project prompts in completion and hover for unstarred external projects', async () => {
    let externalHydrated = false
    const starProject = vi.fn(async () => true)
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.path.join('.') === 'bigquery-public-data.samples.shakespeare') {
              return externalHydrated
                ? {
                    state: 'partial',
                    path: ['bigquery-public-data', 'samples', 'shakespeare'],
                    truncated: false,
                    object: { name: 'shakespeare', kind: 'bqTable', detailed: true },
                    items: [{ name: 'word', kind: 'bqColumn', type: 'STRING', nullable: false }]
                  }
                : { state: 'absent', path: ['bigquery-public-data', 'samples', 'shakespeare'], truncated: false, items: [] }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      }),
      hydrate: async params => {
        externalHydrated = true
        return {
          ok: true,
          value: { outcomes: params.targets.map(t => ({ project: t.project, dataset: t.dataset, name: t.name, status: 'hydrated' as const })) }
        }
      },
      jitHydrateEnabled: () => true,
      starProject
    })

    const tab = f.documents.create('public.sql', '', 'sales', bqConnId)
    // Auto-hydration MUST NOT fire automatically for unstarred external projects.
    const list = await f.completeAt(tab.id, 'SELECT s.| FROM `bigquery-public-data.samples.shakespeare` s')
    expect(f.languageHydrate).not.toHaveBeenCalled()
    expect(list.suggestions.map(s => labelText(s.label))).toEqual(['Fetch schema (free)', '★ Star bigquery-public-data'])
    expect(list.suggestions[0].command?.id).toBe(hydrateTableCommandId)
    expect(list.suggestions[1].command?.id).toBe(starProjectCommandId)

    // Hover on unstarred external table separates untrusted metadata from strictly allowlisted action links.
    const hover = await f.hoverAt(tab.id, 'SELECT * FROM `bigquery-public-data.samples.shake|speare` s')
    expect(hover).toBeTruthy()
    expect(hover!.contents).toHaveLength(2)
    expect(hover!.contents[0]).toMatchObject({ isTrusted: false, supportHtml: false })
    expect(hover!.contents[1]).toMatchObject({ isTrusted: { enabledCommands: [hydrateTableCommandId, starProjectCommandId] }, supportHtml: false })
    expect((hover!.contents[1] as { value: string }).value).toContain('Fetch schema (free)')
    expect((hover!.contents[1] as { value: string }).value).toContain('★ Star bigquery-public-data')

    // One-click Fetch schema (free) command hydrates with allowExternal: true and re-triggers suggest.
    const hydrateCmd = f.registeredCommands.get(hydrateTableCommandId)!
    hydrateCmd(undefined, bqConnId, 'bigquery-public-data', 'samples', 'shakespeare')
    await vi.waitFor(() => expect(f.languageHydrate).toHaveBeenCalledTimes(1))
    expect(f.languageHydrate).toHaveBeenCalledWith({
      connectionId: bqConnId,
      targets: [{ project: 'bigquery-public-data', dataset: 'samples', name: 'shakespeare', allowExternal: true }]
    })
    await vi.waitFor(() => expect(f.triggerCalls).toContain('editor.action.triggerSuggest'))
    const afterHydrate = await f.completeAt(tab.id, 'SELECT s.| FROM `bigquery-public-data.samples.shakespeare` s')
    expect(afterHydrate.suggestions.map(s => labelText(s.label))).toEqual(['word'])

    // One-click ★ Star command invokes starProject wired to BigQueryStarredService.
    const starCmd = f.registeredCommands.get(starProjectCommandId)!
    starCmd(undefined, bqConnId, 'bigquery-public-data')
    await vi.waitFor(() => expect(starProject).toHaveBeenCalledWith(bqConnId, 'bigquery-public-data'))
  })

  it('respects jitHydrateEnabled: false by offering manual Fetch schema (free) without auto-hydrating', async () => {
    const hydrate = vi.fn(async () => ({ ok: true as const, value: { outcomes: [] } }))
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer =>
            req.path.join('.') === 'discovered-proj.web.sessions'
              ? { state: 'partial', path: ['discovered-proj', 'web', 'sessions'], truncated: false, object: { name: 'sessions', kind: 'bqTable', detailed: false }, items: [] }
              : { state: 'ready', path: [...req.path], truncated: false, items: [] }
          )
        }
      }),
      hydrate,
      jitHydrateEnabled: () => false
    })
    const tab = f.documents.create('manual.sql', '', 'sales', bqConnId)
    const list = await f.completeAt(tab.id, 'SELECT p.| FROM `discovered-proj.web.sessions` p')
    expect(hydrate).not.toHaveBeenCalled()
    expect(list.suggestions.map(s => labelText(s.label))).toEqual(['Fetch schema (free)', '★ Star discovered-proj'])
  })

  it('preserves typed text on action items and never hijacks expression keywords when joining an external table (#1)', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.path.join('.') === 'varia-alpha.sales.orders') {
              return {
                state: 'ready',
                path: [...req.path],
                truncated: false,
                object: { name: 'orders', kind: 'bqTable', detailed: true },
                items: [{ name: 'amount', kind: 'bqColumn', type: 'NUMERIC' }]
              }
            }
            if (req.path.join('.') === 'bigquery-public-data.samples.shakespeare') {
              return { state: 'absent', path: [...req.path], truncated: false, items: [] }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      })
    })
    const tab = f.documents.create('expr.sql', '', 'sales', bqConnId)

    // 1. Typing `SELECT s.wo|` keeps Fetch schema visible on empty member site AND preserves `wo` in insertText.
    const memberTyped = await f.completeAt(tab.id, 'SELECT s.wo| FROM `bigquery-public-data.samples.shakespeare` s')
    expect(memberTyped.suggestions.map(s => labelText(s.label))).toEqual(['Fetch schema (free)', '★ Star bigquery-public-data'])
    expect(memberTyped.suggestions[0].insertText).toBe('wo')
    expect(memberTyped.suggestions[1].insertText).toBe('wo')

    // 2. Typing `SELECT MAX|` in an expression site with a joined external table MUST NOT emit Fetch schema or hijack MAX.
    const exprTyped = await f.completeAt(tab.id, 'SELECT MAX| FROM `varia-alpha.sales.orders` o JOIN `bigquery-public-data.samples.shakespeare` s ON 1=1')
    expect(exprTyped.suggestions.map(s => labelText(s.label))).not.toContain('Fetch schema (free)')
    expect(exprTyped.suggestions.map(s => labelText(s.label))).not.toContain('★ Star bigquery-public-data')
    expect(monacoOrder(exprTyped.suggestions, 'MAX')[0]).toBe('MAX')

    // 3. Empty-prefix `SELECT |` sorts action items AFTER real columns/keywords with literal filterText.
    const exprEmpty = await f.completeAt(tab.id, 'SELECT | FROM `varia-alpha.sales.orders` o JOIN `bigquery-public-data.samples.shakespeare` s ON 1=1')
    const fetchItem = exprEmpty.suggestions.find(s => labelText(s.label) === 'Fetch schema (free)')!
    const colItem = exprEmpty.suggestions.find(s => labelText(s.label) === 'amount' || labelText(s.label) === 'o.amount')!
    const kwItem = exprEmpty.suggestions.find(s => labelText(s.label) === 'MAX')!
    expect(fetchItem).toBeTruthy()
    expect(colItem).toBeTruthy()
    expect(kwItem).toBeTruthy()
    expect(fetchItem.filterText).toBe('Fetch schema (free)')
    expect((fetchItem.sortText ?? '').localeCompare(colItem.sortText ?? '')).toBeGreaterThan(0)
    expect((fetchItem.sortText ?? '').localeCompare(kwItem.sortText ?? '')).toBeGreaterThan(0)
  })

  it('invalidates LookupCache and coalesces in-flight auto-hydration even when rapid typing cancels the first completion (#2)', async () => {
    let hydrated = false
    const gate = deferred<ApiResult<LanguageHydrateResult>>()
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.path.join('.') === 'discovered-proj.web.sessions') {
              return hydrated
                ? {
                    state: 'partial',
                    path: ['discovered-proj', 'web', 'sessions'],
                    truncated: false,
                    object: { name: 'sessions', kind: 'bqTable', detailed: true },
                    items: [{ name: 'amount', kind: 'bqColumn', type: 'NUMERIC' }, { name: 'account_id', kind: 'bqColumn', type: 'STRING' }]
                  }
                : { state: 'partial', path: ['discovered-proj', 'web', 'sessions'], truncated: false, object: { name: 'sessions', kind: 'bqTable', detailed: false }, items: [] }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      }),
      hydrate: async () => gate.promise,
      jitHydrateEnabled: () => true
    })
    const tab = f.documents.create('rapid.sql', '', 'sales', bqConnId)

    // Completion #1 starts auto-hydration, then gets cancelled by rapid typing.
    const cts1 = cancellationSource()
    const first = f.completeAt(tab.id, 'SELECT p.| FROM `discovered-proj.web.sessions` p', cts1.token)
    await vi.waitFor(() => expect(f.languageHydrate).toHaveBeenCalledTimes(1))
    cts1.cancel()

    // Completion #2 fires while hydrate #1 is still in flight — coalesces onto the same in-flight hydrate (no 2nd hydrate IPC!).
    const second = f.completeAt(tab.id, 'SELECT p.a| FROM `discovered-proj.web.sessions` p')
    hydrated = true
    gate.resolve({ ok: true, value: { outcomes: [{ project: 'discovered-proj', dataset: 'web', name: 'sessions', status: 'hydrated' }] } })

    expect((await first).suggestions).toEqual([])
    const secondRes = await second
    expect(f.languageHydrate).toHaveBeenCalledTimes(1)
    expect(secondRes.suggestions.map(s => labelText(s.label))).toEqual(['amount', 'account_id'])
  })

  it('trims backticked cross-project jump prefixes and skips whitespace-only short prefixes (#3)', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer => {
            if (req.mode === 'jump') {
              return {
                state: 'ready',
                path: [],
                truncated: false,
                items: [{ name: 'daily_revenue', kind: 'bqTable', tier: 'billing', project: 'varia-alpha', dataset: 'finance' }]
              }
            }
            return { state: 'ready', path: [...req.path], truncated: false, items: [] }
          })
        }
      })
    })
    const tab = f.documents.create('trim.sql', '', '', bqConnId)

    // Auto-closed backticked ` a|` has trimmed length 1 (< minPrefixChars 2): must NOT send a jump request.
    await f.completeAt(tab.id, 'SELECT * FROM ` a|`')
    expect(f.languageLookup.mock.calls.flatMap(call => call[0].requests).some(r => r.mode === 'jump')).toBe(false)

    // Auto-closed backticked ` daily_rev |` trims to `daily_rev` before sending jump request.
    const res = await f.completeAt(tab.id, 'SELECT * FROM ` daily_rev |`')
    const jumpReq = f.languageLookup.mock.calls.flatMap(call => call[0].requests).find(r => r.mode === 'jump')
    expect(jumpReq?.prefix).toBe('daily_rev')
    expect(res.suggestions.map(s => labelText(s.label))).toContain('daily_revenue')
  })

  it('awaits a consumed batchedJump slot across overlapping completions instead of dropping jump hits (#7)', async () => {
    const firstLookupGate = deferred<ApiResult<LanguageLookupResult>>()
    const secondLookupGate = deferred<ApiResult<LanguageLookupResult>>()
    let callNum = 0
    const f = createFixture({
      lookup: async requests => {
        callNum++
        if (callNum === 1) {
          const res = await firstLookupGate.promise
          return res
        }
        return {
          ok: true,
          value: {
            index: 'ready',
            answers: requests.map((req): LanguageLookupAnswer => req.mode === 'jump'
              ? { state: 'ready', path: [], truncated: false, items: [{ name: 'daily_orders', kind: 'bqTable', tier: 'starred', project: 'dw-shared', dataset: 'gold' }] }
              : { state: 'ready', path: [...req.path], truncated: false, items: [] })
          }
        }
      }
    })
    const tab = f.documents.create('race.sql', '', '', bqConnId)
    const p1 = f.completeAt(tab.id, 'SELECT * FROM da|')
    await vi.waitFor(() => expect(f.languageLookup).toHaveBeenCalledTimes(1))
    // Second completion runs while first is still in flight; its jump slot gets resolved cleanly via the deferred promise.
    const p2 = f.completeAt(tab.id, 'SELECT * FROM dai|')
    firstLookupGate.resolve({
      ok: true,
      value: {
        index: 'ready',
        answers: f.languageLookup.mock.calls[0][0].requests.map((req): LanguageLookupAnswer => req.mode === 'jump'
          ? { state: 'ready', path: [], truncated: false, items: [{ name: 'daily_orders', kind: 'bqTable', tier: 'starred', project: 'dw-shared', dataset: 'gold' }] }
          : { state: 'ready', path: [...req.path], truncated: false, items: [] })
      }
    })
    secondLookupGate.resolve({ ok: true, value: { index: 'ready', answers: [] } })
    await p1
    const r2 = await p2
    expect(r2.suggestions.map(s => labelText(s.label))).toContain('daily_orders')
  })

  it('keeps external Fetch schema / ★ Star prompts across repeated keystrokes and hover after hydrate returns external (#8)', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer =>
            req.path.join('.') === 'bigquery-public-data.samples.second_table'
              ? { state: 'partial', path: [...req.path], truncated: false, items: [] }
              : { state: 'ready', path: [...req.path], truncated: false, items: [] }
          )
        }
      }),
      hydrate: async params => ({
        ok: true,
        value: { outcomes: params.targets.map(t => ({ project: t.project, dataset: t.dataset, name: t.name, status: 'external' as const })) }
      }),
      jitHydrateEnabled: () => true
    })
    const tab = f.documents.create('ext2.sql', '', 'sales', bqConnId)

    const first = await f.completeAt(tab.id, 'SELECT s.| FROM `bigquery-public-data.samples.second_table` s')
    expect(f.languageHydrate).toHaveBeenCalledTimes(1)
    expect(first.suggestions.map(s => labelText(s.label))).toEqual(['Fetch schema (free)', '★ Star bigquery-public-data'])

    // Second keystroke must NOT re-call languageHydrate and MUST still show Fetch schema / ★ Star.
    const second = await f.completeAt(tab.id, 'SELECT s.w| FROM `bigquery-public-data.samples.second_table` s')
    expect(f.languageHydrate).toHaveBeenCalledTimes(1)
    expect(second.suggestions.map(s => labelText(s.label))).toEqual(['Fetch schema (free)', '★ Star bigquery-public-data'])

    // Hover also recognises the cached external status and shows the actionable card.
    const hover = await f.hoverAt(tab.id, 'SELECT * FROM `bigquery-public-data.samples.sec|ond_table` s')
    expect(hover).toBeTruthy()
    expect((hover!.contents[1] as { value: string }).value).toContain('Fetch schema (free)')
  })

  it('bounds hydrateAttempted per connection to maxNegativeEntries so long sessions never leak memory (#9)', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((req): LanguageLookupAnswer =>
            req.path.length === 3
              ? { state: 'partial', path: [...req.path], truncated: false, object: { name: req.path[2], kind: 'bqTable', detailed: false }, items: [] }
              : { state: 'ready', path: [...req.path], truncated: false, items: [] }
          )
        }
      }),
      hydrate: async params => ({
        ok: true,
        value: { outcomes: params.targets.map(t => ({ project: t.project, dataset: t.dataset, name: t.name, status: 'notFound' as const, code: 'NOT_FOUND' })) }
      }),
      jitHydrateEnabled: () => true
    })
    const tab = f.documents.create('cap.sql', '', 'sales', bqConnId)
    const cap = languageHydrateLimits.maxNegativeEntries

    await f.completeAt(tab.id, 'SELECT t.| FROM `discovered-proj.ds.tbl_0` t')
    // Repeated lookup of tbl_0 is suppressed while within cap.
    await f.completeAt(tab.id, 'SELECT t.| FROM `discovered-proj.ds.tbl_0` t')
    expect(f.languageHydrate).toHaveBeenCalledTimes(1)

    // Filling maxNegativeEntries other tables evicts tbl_0 from the bounded set.
    for (let i = 1; i <= cap; i++) {
      await f.completeAt(tab.id, `SELECT t.| FROM \`discovered-proj.ds.tbl_${i}\` t`)
    }
    expect(f.languageHydrate).toHaveBeenCalledTimes(1 + cap)

    // tbl_0 was evicted, so asking again attempts hydration once more.
    await f.completeAt(tab.id, 'SELECT t.| FROM `discovered-proj.ds.tbl_0` t')
    expect(f.languageHydrate).toHaveBeenCalledTimes(2 + cap)
  })

  it('reports user-visible errors via reportError when one-click hydrateExternal fails (#11)', async () => {
    const reportError = vi.fn()
    const responses: Array<ApiResult<LanguageHydrateResult>> = [
      { ok: true, value: { outcomes: [{ project: 'bigquery-public-data', dataset: 'samples', name: 'shakespeare', status: 'forbidden', code: 'PERMISSION_DENIED' }] } },
      { ok: true, value: { outcomes: [{ project: 'bigquery-public-data', dataset: 'samples', name: 'shakespeare', status: 'notFound', code: 'NOT_FOUND' }] } },
      { ok: true, value: { outcomes: [{ project: 'bigquery-public-data', dataset: 'samples', name: 'shakespeare', status: 'budget', code: 'TOO_LARGE' }] } },
      { ok: true, value: { outcomes: [{ project: 'bigquery-public-data', dataset: 'samples', name: 'shakespeare', status: 'throttled', code: 'RATE_LIMIT' }] } },
      { ok: false, code: 'TIMEOUT', error: 'Hydration request timed out.' }
    ]
    let idx = 0
    const f = createFixture({
      hydrate: async () => responses[idx++],
      reportError
    })

    for (let i = 0; i < responses.length; i++) {
      expect(await f.service.hydrateExternal(bqConnId, 'bigquery-public-data', 'samples', 'shakespeare')).toBe(false)
    }
    expect(reportError).toHaveBeenCalledTimes(5)
    expect(reportError.mock.calls[0][0]).toContain('Permission denied')
    expect(reportError.mock.calls[1][0]).toContain('was not found')
    expect(reportError.mock.calls[2][0]).toContain('RAM cap')
    expect(reportError.mock.calls[3][0]).toContain('rate-limited')
    expect(reportError.mock.calls[4][0]).toBe('Hydration request timed out.')
  })

  it('wires snippets, parameter hints, @ trigger, ARRAY<STRUCT> additionalTextEdits and wildcard ordering in Monaco', async () => {
    const f = createFixture({
      lookup: async requests => ({
        ok: true,
        value: {
          index: 'ready',
          answers: requests.map((request): LanguageLookupAnswer => {
            const key = request.path.join('.')
            if (key === 'varia-alpha.sales') {
              return {
                state: 'ready',
                path: [...request.path],
                truncated: false,
                items: [
                  { name: 'events_20261124', kind: 'bqTable', shards: { prefix: 'events_', count: 90, first: '20260827', last: '20261124' } },
                  { name: 'orders', kind: 'bqTable' },
                  { name: 'to_cents', kind: 'bqRoutine', subtype: 'scalar', detail: '(x NUMERIC) RETURNS INT64' }
                ]
              }
            }
            if (key === 'varia-alpha.sales.orders') {
              return {
                state: 'ready',
                path: [...request.path],
                truncated: false,
                object: { name: 'orders', kind: 'bqTable', detailed: true },
                items: [
                  { name: 'id', kind: 'bqColumn', type: 'INT64', nullable: false },
                  { name: 'items', kind: 'bqColumn', type: 'ARRAY<STRUCT>', subtype: 'struct' },
                  { name: 'items.sku', kind: 'bqColumn', type: 'STRING' }
                ]
              }
            }
            return { state: 'ready', path: [...request.path], truncated: false, items: [] }
          })
        }
      })
    })
    const tab = f.documents.create('q1.sql', '', 'sales', bqConnId)

    // `@` is registered as a trigger character; single `@` stays quiet while `@@` lists BigQuery system variables.
    expect(f.completionProvider().triggerCharacters).toEqual(['.', '`', '@'])
    expect((await f.completeAt(tab.id, 'SELECT @|')).suggestions).toEqual([])
    const sys = await f.completeAt(tab.id, 'SELECT @@|')
    const proj = sys.suggestions.find(s => labelText(s.label) === '@@project_id')!
    expect(proj.insertText).toBe('@@project_id')
    expect(proj.label).toEqual({ label: '@@project_id', description: 'STRING · Read-only' })

    // Non-niladic functions and routines emit ($0) snippets + triggerParameterHints; niladic and paren-ahead stay bare.
    const expr = await f.completeAt(tab.id, 'SELECT DATE_TR|')
    const dateTrunc = expr.suggestions.find(s => labelText(s.label) === 'DATE_TRUNC')!
    expect(dateTrunc.insertText).toBe('DATE_TRUNC($0)')
    expect(dateTrunc.insertTextRules).toBe(4)
    expect(dateTrunc.command).toEqual({ id: 'editor.action.triggerParameterHints', title: 'Trigger Parameter Hints' })

    const niladic = (await f.completeAt(tab.id, 'SELECT CURRENT_TIME|')).suggestions.find(s => labelText(s.label) === 'CURRENT_TIMESTAMP')!
    expect(niladic.insertText).toBe('CURRENT_TIMESTAMP')
    expect(niladic.insertTextRules).toBeUndefined()
    expect(niladic.command).toBeUndefined()

    const parenAhead = (await f.completeAt(tab.id, 'SELECT DATE_TR|(placed, DAY)')).suggestions.find(s => labelText(s.label) === 'DATE_TRUNC')!
    expect(parenAhead.insertText).toBe('DATE_TRUNC')
    expect(parenAhead.insertTextRules).toBeUndefined()
    expect(parenAhead.command).toBeUndefined()

    const backtickRoutine = (await f.completeAt(tab.id, 'CALL `varia-alpha.sales.to_c|`')).suggestions.find(s => labelText(s.label) === 'to_cents')!
    expect(backtickRoutine.insertText).toBe('to_cents`($0)')
    expect(backtickRoutine.insertTextRules).toBe(4)
    expect(backtickRoutine.command).toEqual({ id: 'editor.action.triggerParameterHints', title: 'Trigger Parameter Hints' })

    // ARRAY<STRUCT> direct member access returns UNNEST(o.items) with atomic additionalTextEdits deleting `o.items.`.
    const arrMember = await f.completeAt(tab.id, 'SELECT o.items.| FROM sales.orders o')
    expect(arrMember.suggestions).toHaveLength(1)
    expect(labelText(arrMember.suggestions[0].label)).toBe('UNNEST(o.items)')
    expect(arrMember.suggestions[0].additionalTextEdits).toEqual([
      { range: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 16 }, text: '' }
    ])

    // Date-sharded wildcard ranks ahead of the latest concrete shard in Monaco and exits backticks cleanly.
    const shards = await f.completeAt(tab.id, 'SELECT * FROM sales.ev|')
    expect(monacoOrder(shards.suggestions, 'ev').slice(0, 2)).toEqual(['events_*', 'events_20261124'])
    const quotedWildcard = (await f.completeAt(tab.id, 'SELECT * FROM `varia-alpha.sales.ev|`')).suggestions.find(s => labelText(s.label) === 'events_*')!
    expect(quotedWildcard.insertText).toBe('events_*`')
  })
})
