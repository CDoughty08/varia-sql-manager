// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BigQueryProperties, BigQueryPropertyKind } from '../src/shared/bigquery/objects'
import type { ApiResult, QueryResult, VariaApi } from '../src/shared/contracts'
import type { ScriptingOptions } from '../src/shared/scripting/options'
import { defaultScriptingOptions } from '../src/shared/scripting/options'
import type { ScriptResult } from '../src/shared/scripting/schema'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import {
  activeLogicalBytes, allStructPaths, bigQueryCapabilities, bigQueryHeaderPills, bigQueryKpis,
  bigQueryStorageFacts, bigQueryVitalsStorageFacts, compressionRatio, countSchemaStats, flattenSchemaRows,
  formatBigQueryType, hasStorageOrLayout, partitionColumnName, schemaRowsToLocalTable, shortPartitionLabel,
  storageRatioSegments
} from '../src/renderer/src/explorer/bigquery-properties-format'
import { BigQueryPropertiesService } from '../src/renderer/src/explorer/BigQueryPropertiesService'
import BigQueryPropertiesTab from '../src/renderer/src/explorer/BigQueryPropertiesTab'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { deferred } from './fixtures/documents'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined, host: HTMLElement | undefined
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
})

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(element) })
  return host
}

const node = (kind: string, patch: Partial<ExplorerMenuNode> = {}): ExplorerMenuNode =>
  ({ id: 1, connectionId: 'bq-1', lost: false, kind, label: 'orders', ref: { type: 'object', object: { kind, project: 'varia-alpha', dataset: 'sales', name: 'orders' } }, ...patch }) as ExplorerMenuNode

const basicFacts = (rows: string): BigQueryProperties => ({ name: 'orders', type: 'table', elapsedMs: 1, groups: [{ title: 'Storage', facts: [{ label: 'Rows', value: rows }] }] })

const richTableProps: BigQueryProperties = {
  name: 'orders',
  type: 'table',
  elapsedMs: 18,
  fullName: 'analytics_prod.commerce.orders',
  location: 'US',
  description: 'Canonical order ledger synced hourly.',
  createdUtc: '2024-03-15 02:00:11 UTC',
  modifiedUtc: '2026-11-22 20:45:03 UTC',
  storage: {
    rows: 14_218_440,
    logicalBytes: 19_756_849_562,
    longTermLogicalBytes: 13_207_024_435,
    physicalBytes: 4_509_715_660
  },
  layout: {
    partitioning: 'DAY on order_date, partitions expire after 1095 days',
    requirePartitionFilter: true,
    clustering: ['region_code', 'customer_id']
  },
  schema: [
    { name: 'order_id', type: 'INT64', mode: 'REQUIRED', description: 'Unique order identifier' },
    { name: 'order_date', type: 'DATE', mode: 'REQUIRED', description: 'UTC calendar date' },
    { name: 'region_code', type: 'STRING', mode: 'REQUIRED', description: 'Sales region' },
    { name: 'customer_id', type: 'INT64', mode: 'REQUIRED', description: 'Customer reference' },
    {
      name: 'totals', type: 'STRUCT', mode: 'NULLABLE', description: 'Order monetary breakdown',
      fields: [
        { name: 'subtotal', type: 'NUMERIC', mode: 'REQUIRED', description: 'Pre-tax total' },
        { name: 'currency', type: 'STRING', mode: 'REQUIRED', description: 'ISO-4217 code' }
      ]
    },
    {
      name: 'line_items', type: 'STRUCT', mode: 'REPEATED', description: 'Nested order lines',
      fields: [
        { name: 'sku', type: 'STRING', mode: 'REQUIRED', description: 'Product SKU' },
        { name: 'qty', type: 'INT64', mode: 'REQUIRED', description: 'Units ordered' }
      ]
    }
  ],
  labels: [
    { key: 'domain', value: 'commerce' },
    { key: 'tier', value: 'gold' }
  ],
  groups: []
}

const richViewProps: BigQueryProperties = {
  name: 'active_orders',
  type: 'view',
  elapsedMs: 12,
  fullName: 'analytics_prod.commerce.active_orders',
  location: 'US',
  description: 'Open orders for the last 30 days.',
  createdUtc: '2025-01-10 10:00:00 UTC',
  definition: 'SELECT order_id, order_date\nFROM `analytics_prod.commerce.orders`\nWHERE order_date >= CURRENT_DATE() - 30;',
  schema: [
    { name: 'order_id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'order_date', type: 'DATE', mode: 'REQUIRED' }
  ],
  groups: []
}

class ConnectionsStore extends SnapshotStore<readonly { readonly id: string; readonly lost?: true }[]> {
  set(next: readonly { readonly id: string; readonly lost?: true }[]) { this.publish(next) }
}

function setupService(options: { withBilledGate?: boolean; withPreview?: boolean } = {}) {
  const replies: ReturnType<typeof deferred<ApiResult<BigQueryProperties>>>[] = []
  const scriptReplies: ReturnType<typeof deferred<ApiResult<ScriptResult>>>[] = []
  const executeReplies: ReturnType<typeof deferred<ApiResult<QueryResult>>>[] = []
  const connections = new ConnectionsStore([{ id: 'bq-1' }])
  const scriptingOptions = new SnapshotStore<{ readonly options: ScriptingOptions }>({ options: defaultScriptingOptions })
  const results = {
    begin: vi.fn(),
    finish: vi.fn(() => Promise.resolve()),
    release: vi.fn()
  }
  const api = {
    bigQueryProperties: vi.fn<VariaApi['bigQueryProperties']>(() => { replies.push(deferred()); return replies.at(-1)!.promise }),
    scriptObjects: vi.fn<VariaApi['scriptObjects']>(() => { scriptReplies.push(deferred()); return scriptReplies.at(-1)!.promise }),
    cancelScripting: vi.fn<VariaApi['cancelScripting']>(() => Promise.resolve({ ok: true, value: { cancelled: 1 } })),
    execute: vi.fn<VariaApi['execute']>(() => { executeReplies.push(deferred()); return executeReplies.at(-1)!.promise }),
    cancel: vi.fn<VariaApi['cancel']>(() => Promise.resolve({ ok: true, value: { cancelled: true } }))
  }
  const billedGate = vi.fn(async () => ({ run: true as boolean, maximumBytesBilled: 10_485_760 as number | undefined }))
  let ids = 0
  const documents = { openCustom: vi.fn(() => ({ id: `doc-${++ids}` })), registerProvider: vi.fn(() => ({ dispose: vi.fn() })) }
  const service = new BigQueryPropertiesService({
    api,
    documents: documents as never,
    connections,
    scriptingOptions,
    ...(options.withPreview === false ? {} : { results }),
    ...(options.withBilledGate === false ? {} : { billedGate })
  })
  return { service, api, documents, replies, scriptReplies, executeReplies, connections, results, billedGate }
}

describe('BigQuery Properties pure formatters & schema tree', () => {
  it('computes active/long-term ratios, compression ratio, KPIs, and header pills', () => {
    expect(activeLogicalBytes(richTableProps.storage)).toBe(19_756_849_562 - 13_207_024_435)
    expect(compressionRatio(richTableProps.storage)).toBe('4.4×')
    expect(compressionRatio({ logicalBytes: 100, physicalBytes: 0 })).toBeUndefined()
    expect(storageRatioSegments(richTableProps.storage)).toHaveLength(2)
    expect(storageRatioSegments(richViewProps.storage)).toEqual([])

    const kpis = bigQueryKpis(richTableProps)
    expect(kpis.map(k => k.id)).toEqual(['rows', 'logical', 'physical', 'columns', 'location'])
    expect(kpis.find(k => k.id === 'logical')?.ratio).toHaveLength(2)
    expect(kpis.find(k => k.id === 'physical')?.sub).toBe('4.4×')
    expect(kpis.find(k => k.id === 'columns')?.sub).toBe('2 STRUCT')

    // Views omit storage KPIs.
    const viewKpis = bigQueryKpis(richViewProps)
    expect(viewKpis.map(k => k.id)).toEqual(['columns', 'location'])

    const pills = bigQueryHeaderPills('bqTable', richTableProps)
    expect(pills.map(p => p.label)).toEqual(['Partitioned · DAY', 'Require partition filter', 'Clustered (2)'])

    const storageFacts = bigQueryStorageFacts(richTableProps)
    expect(storageFacts.map(f => f.label)).toEqual([
      'Rows', 'Logical size', 'Active logical size', 'Long-term logical size', 'Physical size',
      'Compression ratio', 'Partitioning', 'Require partition filter', 'Clustering'
    ])
    expect(bigQueryCapabilities('bqTable', richTableProps).filter(c => c.notable).length).toBeGreaterThanOrEqual(4)
  })

  it('extracts partition column, computes PART/CLUST/REP badges, and flattens/expands/filters nested STRUCT rows', () => {
    expect(partitionColumnName('DAY on order_date, partitions expire after 1095 days')).toBe('order_date')
    expect(partitionColumnName('DAY on _PARTITIONTIME')).toBeUndefined()
    expect(partitionColumnName('integer range on bucket_id')).toBe('bucket_id')
    expect(countSchemaStats(richTableProps.schema)).toEqual({ topLevel: 6, total: 10, structCount: 2 })
    expect(allStructPaths(richTableProps.schema)).toEqual(['totals', 'line_items'])

    const collapsed = flattenSchemaRows(richTableProps.schema!, {
      filter: '', expanded: new Set(), partitioning: richTableProps.layout?.partitioning, clustering: richTableProps.layout?.clustering
    })
    expect(collapsed).toHaveLength(6)
    expect(collapsed.find(r => r.path === 'order_date')?.badges).toEqual(['PART'])
    expect(collapsed.find(r => r.path === 'region_code')?.badges).toEqual(['CLUST #1'])
    expect(collapsed.find(r => r.path === 'customer_id')?.badges).toEqual(['CLUST #2'])
    expect(collapsed.find(r => r.path === 'line_items')?.badges).toEqual(['REP'])

    // Expanding `totals` reveals its 2 nested fields inline right beneath it.
    const expanded = flattenSchemaRows(richTableProps.schema!, {
      filter: '', expanded: new Set(['totals']), partitioning: richTableProps.layout?.partitioning, clustering: richTableProps.layout?.clustering
    })
    expect(expanded.map(r => r.path)).toEqual([
      'order_id', 'order_date', 'region_code', 'customer_id', 'totals', 'totals.subtotal', 'totals.currency', 'line_items'
    ])
    const table = schemaRowsToLocalTable(expanded, false)
    expect(table.rows[4][0]).toBe('▾ totals (2 fields)')
    expect(table.rows[5][0]).toBe('  subtotal')
    expect(table.rows[7][0]).toBe('▸ line_items (2 fields)')

    // Filtering by a nested child auto-expands its parent STRUCT and shows the full path.
    const filtered = flattenSchemaRows(richTableProps.schema!, {
      filter: 'sku', expanded: new Set(), partitioning: richTableProps.layout?.partitioning, clustering: richTableProps.layout?.clustering
    })
    expect(filtered.map(r => r.path)).toEqual(['line_items', 'line_items.sku'])
    expect(filtered[0].expanded).toBe(true)
    expect(schemaRowsToLocalTable(filtered, true).rows[1][0]).toBe('  line_items.sku')
  })

  it('handles empty/zero-byte tables, empty storage/layout objects, clamped percentages, and columns fallback', () => {
    const zeroTable: BigQueryProperties = {
      name: 'empty_tbl', type: '  custom  ', elapsedMs: 1,
      storage: { rows: 0, logicalBytes: 0, longTermLogicalBytes: 0 },
      columns: [{ name: 'id', type: 'INT64' }],
      schema: [],
      groups: []
    }
    expect(formatBigQueryType('bqTable', zeroTable.type)).toBe('Custom')
    expect(shortPartitionLabel('FOOBAR on col')).toBe('Partitioned')
    expect(shortPartitionLabel('MONTH on created_at')).toBe('Partitioned · MONTH')
    expect(storageRatioSegments(zeroTable.storage)).toEqual([])
    const vitals = bigQueryVitalsStorageFacts(zeroTable)
    expect(vitals.find(f => f.id === 'logical')?.value).toBe('0 B')
    expect(vitals.find(f => f.id === 'columns')?.value).toBe('1')

    const emptyObjects: BigQueryProperties = { name: 'sparse', type: 'table', elapsedMs: 1, storage: {}, layout: { clustering: [] }, groups: [] }
    expect(hasStorageOrLayout(emptyObjects)).toBe(false)

    const skewed: BigQueryProperties = {
      name: 'skewed', type: 'table', elapsedMs: 1,
      storage: { logicalBytes: 1000, longTermLogicalBytes: 1500 },
      groups: []
    }
    expect(bigQueryCapabilities('bqTable', skewed).find(c => c.id === 'longTermStorage')?.value).toBe('100% (1000 B)')
    expect(bigQueryStorageFacts(skewed).find(f => f.id === 'longTermLogical')?.value).toBe('1000 B (100%)')
  })
})

describe('BigQueryPropertiesService', () => {
  it('opens for tables, views, routines and datasets, live, deduplicates open tabs, and preserves promoted tab', async () => {
    const { service, api, documents, replies } = setupService()
    const datasetNode: ExplorerMenuNode = {
      id: 2, connectionId: 'bq-1', lost: false, kind: 'bqDataset', label: 'sales',
      ref: { type: 'object', object: { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' } }
    } as ExplorerMenuNode
    expect(service.canOpen(node('bqTable'))).toBe(true)
    expect(service.canOpen(node('bqExternalTable'))).toBe(true)
    expect(service.canOpen(node('bqRoutine'))).toBe(true)
    expect(service.canOpen(datasetNode)).toBe(true)
    expect(service.canOpen(node('bqModel'))).toBe(false)
    expect(service.canOpen(node('bqTable', { lost: true }))).toBe(false)
    expect(service.canOpen(node('table'))).toBe(false)
    expect(service.open(node('bqModel'))).toBeUndefined()
    const id = service.open(node('bqView'))!
    expect(documents.openCustom).toHaveBeenCalledWith('bigQueryProperties', 'orders', 'bq-1', 'sales')
    expect(api.bigQueryProperties).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'bq-1', kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'orders' }))
    expect(service.view(id)).toMatchObject({ loading: true, activeTab: 'overview' })
    // Re-opening the same object focuses/reuses the existing tab and switches to the requested canonical tab.
    expect(service.open(node('bqView'), 'definition')).toBe(id)
    expect(service.view(id)?.activeTab).toBe('definition')
    expect(documents.openCustom).toHaveBeenCalledTimes(1)

    // Opening a dataset calls bigquery.properties with dataset === name and refuses definition tab.
    const dsId = service.open(datasetNode, 'definition')!
    expect(api.bigQueryProperties).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'bqDataset', project: 'varia-alpha', dataset: 'sales', name: 'sales' }))
    expect(service.view(dsId)?.activeTab).toBe('overview')
    replies[1].resolve({ ok: true, value: { name: 'sales', type: 'dataset', elapsedMs: 2, groups: [], location: 'US', labels: [{ key: 'env', value: 'prod' }] } })
    await Promise.resolve(); await Promise.resolve()
    expect(service.canLoadDdl(dsId)).toBe(false)
    expect(service.open(datasetNode, 'labels')).toBe(dsId)
    expect(service.view(dsId)?.activeTab).toBe('labels')

    // Promoting onto an already-open failed tab does not switch to an unrendered data-dependent tab.
    const failedNode = node('bqTable', { label: 'broken', ref: { type: 'object', object: { kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'broken' } } })
    const failedId = service.open(failedNode)!
    replies[2].resolve({ ok: false, error: 'Not found' })
    await Promise.resolve(); await Promise.resolve()
    expect(service.open(failedNode, 'columns')).toBe(failedId)
    expect(service.view(failedId)?.activeTab).toBe('overview')

    // Never runs billed DDL or Preview Rows automatically on open.
    expect(api.scriptObjects).not.toHaveBeenCalled()
    expect(api.execute).not.toHaveBeenCalled()
  })

  it('keeps only the newest read, shows a failure, and forgets a closed tab', async () => {
    const { service, replies } = setupService()
    const id = service.open(node('bqTable'))!
    void service.refresh(id)
    replies[1].resolve({ ok: true, value: basicFacts('2') })
    await Promise.resolve(); await Promise.resolve()
    replies[0].resolve({ ok: true, value: basicFacts('1') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toMatchObject({ loading: false, value: basicFacts('2') })
    void service.refresh(id)
    replies[2].resolve({ ok: false, error: 'Access Denied', code: 'PERMISSION_DENIED' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toMatchObject({ loading: false, error: 'Access Denied', value: basicFacts('2') })
    void service.refresh(id)
    service.closed(id)
    replies[3].resolve({ ok: true, value: basicFacts('3') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toBeUndefined()
  })

  it('never runs billed DDL on selecting Definition, and runs estimate -> billedGate -> scriptObjects on explicit loadDdl', async () => {
    const { service, api, replies, scriptReplies, billedGate } = setupService()
    const id = service.open(node('bqTable'))!
    replies[0].resolve({ ok: true, value: richTableProps })
    await new Promise(resolve => setTimeout(resolve, 0))

    // Selecting the Definition tab does NOT run billed SQL.
    service.selectTab(id, 'definition')
    expect(api.scriptObjects).not.toHaveBeenCalled()
    expect(service.view(id)?.ddl).toBeUndefined()

    // Declining the cost prompt returns DDL state back to idle without executing the billed query.
    billedGate.mockResolvedValueOnce({ run: false, maximumBytesBilled: undefined })
    const declined = service.loadDdl(id)
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    expect(api.scriptObjects).toHaveBeenLastCalledWith(expect.objectContaining({ estimateOnly: true, verb: 'create' }))
    scriptReplies[0].resolve({ ok: true, value: { database: 'sales', commands: 0, elapsedMs: 5, warnings: [], estimate: { bytesProcessed: 10_485_760, statementType: 'SELECT' } } })
    await declined
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    expect(service.view(id)?.ddl).toBeUndefined()

    // Approving the cost prompt runs the billed CREATE statement with maximumBytesBilled.
    const approved = service.loadDdl(id)
    scriptReplies[1].resolve({ ok: true, value: { database: 'sales', commands: 0, elapsedMs: 5, warnings: [], estimate: { bytesProcessed: 10_485_760, statementType: 'SELECT' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.scriptObjects).toHaveBeenCalledTimes(3)
    expect(api.scriptObjects).toHaveBeenLastCalledWith(expect.objectContaining({ verb: 'create', maximumBytesBilled: 10_485_760 }))
    scriptReplies[2].resolve({ ok: true, value: { database: 'sales', commands: 1, elapsedMs: 12, warnings: [], text: 'CREATE TABLE `analytics_prod.commerce.orders` (...);' } })
    await approved
    expect(service.view(id)?.ddl).toEqual({ status: 'ready', text: 'CREATE TABLE `analytics_prod.commerce.orders` (...);', warnings: [] })
  })

  it('lazy-loads free Preview Rows via tabledata.list only when selected and releases results on close', async () => {
    const { service, api, replies, executeReplies, results } = setupService()
    const id = service.open(node('bqTable'))!
    replies[0].resolve({ ok: true, value: richTableProps })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(api.execute).not.toHaveBeenCalled()
    service.selectTab(id, 'columns')
    expect(api.execute).not.toHaveBeenCalled()

    service.selectTab(id, 'preview')
    expect(api.execute).toHaveBeenCalledTimes(1)
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'bq-1',
      preview: { project: 'varia-alpha', dataset: 'sales', table: 'orders' }
    }))
    expect(results.begin).toHaveBeenCalledWith(expect.any(String), expect.any(String), undefined, { bare: true })
    expect(service.view(id)?.preview).toEqual({ status: 'loading' })

    executeReplies[0].resolve({
      ok: true,
      value: {
        resultSets: [{ resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', generation: 1, columns: [{ name: 'order_id', dataType: 'INT64', nullable: false, wire: 'text' }], rowsRead: 5, rowsAvailable: 5, rowsStored: 5, bytesStored: 128, truncatedCells: 0, state: 'complete', incomplete: false }],
        discardedResultSets: 0, recordsAffected: 0, messages: [], elapsedMs: 10, status: 'completed',
        completedBatches: 1, totalBatches: 1, database: 'sales', messagesTruncated: false,
        budget: { usedBytes: 128, globalBytes: 1024 * 1024, queryBytes: 1024 * 1024, generation: 1, seq: 1 },
        completedAt: '2026-04-01T00:00:00.0000000'
      }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)?.preview).toMatchObject({ status: 'ready', rowsRead: 5 })
    const previewKey = (service.view(id)?.preview as { readonly key: string }).key

    // Switching away and back does not re-fetch ready preview rows.
    service.selectTab(id, 'overview')
    service.selectTab(id, 'preview')
    expect(api.execute).toHaveBeenCalledTimes(1)

    // Closing releases the bare ResultsService entry.
    service.closed(id)
    expect(results.release).toHaveBeenCalledWith(previewKey)
  })

  it('blocks loadDdl while metadata is loading, cancels in-flight DDL/preview, handles finish failure, and cleans up on disconnect', async () => {
    const { service, api, replies, scriptReplies, executeReplies, connections, results } = setupService({ withBilledGate: true, withPreview: true })
    const id = service.open(node('bqTable'))!

    // While tables.get is still in flight, loadDdl is blocked (even for a table or view).
    expect(service.canLoadDdl(id)).toBe(false)
    await service.loadDdl(id)
    expect(api.scriptObjects).not.toHaveBeenCalled()

    // Disconnect while metadata is loading fails the pending request and blocks refresh().
    connections.set([])
    expect(service.view(id)?.loading).toBe(false)
    expect(service.view(id)?.error).toBe('The connection is no longer open.')
    const callsBeforeRefresh = api.bigQueryProperties.mock.calls.length
    await service.refresh(id)
    expect(api.bigQueryProperties.mock.calls.length).toBe(callsBeforeRefresh)

    // Reconnect, refresh to load richTableProps, switch to labels, then refresh to payload without labels -> normalizes to overview.
    connections.set([{ id: 'bq-1' }])
    const p1 = service.refresh(id)
    replies[replies.length - 1].resolve({ ok: true, value: richTableProps })
    await p1
    service.selectTab(id, 'labels')
    expect(service.view(id)?.activeTab).toBe('labels')

    const p2 = service.refresh(id)
    replies[replies.length - 1].resolve({ ok: true, value: { ...richTableProps, labels: [] } })
    await p2
    expect(service.view(id)?.activeTab).toBe('overview')

    // Start DDL and cancel it.
    const ddlRun = service.loadDdl(id)
    expect(service.view(id)?.ddl).toEqual({ status: 'loading', phase: 'estimating' })
    service.cancelDdl(id)
    expect(service.view(id)?.ddl).toBeUndefined()
    expect(api.cancelScripting).toHaveBeenCalledTimes(1)
    scriptReplies[0].resolve({ ok: false, error: 'cancelled' })
    await ddlRun

    // Start preview, cancel it, then test results.finish throwing without sticking in loading.
    service.selectTab(id, 'preview')
    expect(service.view(id)?.preview).toEqual({ status: 'loading' })
    service.cancelPreview(id)
    expect(service.view(id)?.preview).toEqual({ status: 'error', message: 'Preview cancelled.' })
    executeReplies[0].resolve({ ok: false, error: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 0))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    results.finish.mockRejectedValueOnce(new Error('worker disposed'))
    const reload = service.reloadPreview(id)
    executeReplies[1].resolve({ ok: false, error: 'boom' })
    await reload
    expect(service.view(id)?.preview).toEqual({ status: 'error', message: 'worker disposed' })

    // Disconnect updates preview once and does not republish on subsequent unrelated connection store ticks.
    const listener = vi.fn()
    const unsub = service.subscribe(listener)
    connections.set([])
    expect(listener).toHaveBeenCalledTimes(1)
    connections.set([{ id: 'other-conn' }])
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })
})

describe('BigQueryPropertiesTab UI', () => {
  function setupUi(kind: BigQueryPropertyKind, props: BigQueryProperties) {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    const writeClipboardText = vi.fn(async () => ({ ok: true as const, value: undefined }))
    ;(window as unknown as { varia?: unknown }).varia = { writeClipboardText }
    fixture.connections.add({ id: 'bq-1', server: 'analytics_prod', displayName: 'bq-analytics (ADC)', database: 'commerce', login: 'user@example.com', serverVersion: 'BigQuery', providerId: 'bigquery', generation: 1 }, { provider: 'bigquery', project: 'analytics_prod', authentication: 'gcloud' })
    const bigQueryProperties = new BigQueryPropertiesService({
      api: {
        bigQueryProperties: vi.fn(async () => ({ ok: true as const, value: props })),
        scriptObjects: vi.fn(async () => ({ ok: true as const, value: { database: 'commerce', commands: 1, elapsedMs: 5, warnings: [], text: 'CREATE TABLE `analytics_prod.commerce.orders` (order_id INT64);' } })),
        cancelScripting: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } })),
        execute: vi.fn(async () => ({ ok: false as const, error: 'not called' })),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } }))
      },
      documents: fixture.documents,
      connections: fixture.connections,
      results: fixture.results,
      billedGate: vi.fn(async () => ({ run: true }))
    })
    const createdModels: { text: string; language: string; disposed: boolean }[] = []
    const fakeMonaco = {
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      editor: {
        createModel: vi.fn((text: string, language: string) => {
          const record = { text, language, disposed: false }
          createdModels.push(record)
          return { updateOptions: vi.fn(), dispose: vi.fn(() => { record.disposed = true }) }
        }),
        create: vi.fn(() => ({
          getId: () => 'fake-editor-1',
          getDomNode: () => document.createElement('div'),
          onDidChangeModel: () => ({ dispose: () => {} }),
          getModel: () => null,
          setModel: vi.fn(),
          updateOptions: vi.fn(),
          createContextKey: vi.fn(),
          getContribution: () => undefined,
          onMouseUp: () => ({ dispose: () => {} }),
          onMouseMove: () => ({ dispose: () => {} }),
          onMouseLeave: () => ({ dispose: () => {} }),
          dispose: vi.fn()
        }))
      }
    }
    const wb = Object.assign(Object.create(null), fixture, { bigQueryProperties, monaco: fakeMonaco }) as unknown as Workbench
    const objectRef = kind === 'bqDataset'
      ? { kind, project: 'analytics_prod', name: props.name }
      : { kind, project: 'analytics_prod', dataset: 'commerce', name: props.name }
    const docId = bigQueryProperties.open(node(kind, { label: props.name, ref: { type: 'object', object: objectRef } }))!
    const cleanup = () => { bigQueryProperties.dispose(); fixture.dispose() }
    return { wb, bigQueryProperties, docId, writeClipboardText, createdModels, cleanup }
  }

  it('renders unified ObjectInspectorFrame with KPIs, Vitals rail, canonical tabs, STRUCT expansion, on-demand table DDL, and lazy Preview Rows', async () => {
    const { wb, bigQueryProperties, docId, writeClipboardText, cleanup } = setupUi('bqTable', richTableProps)
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      const el = mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryPropertiesTab, { documentId: docId }) }))

      // Shell & Chrome: breadcrumbs, engine badge, semantic pills, Hero KPIs, Vitals rail.
      expect(el.querySelector('[data-bigquery-properties]')?.getAttribute('data-inspector-surface')).toBe('full')
      expect(el.textContent).toContain('bq-analytics (ADC)')
      expect(el.textContent).toContain('analytics_prod')
      expect(el.textContent).toContain('commerce')
      expect(el.textContent).toContain('BigQuery')
      expect(el.textContent).toContain('Partitioned · DAY')
      expect(el.textContent).toContain('Require partition filter')
      expect(el.querySelector('.inspector-kpi-strip')?.textContent).toContain('14,218,440')
      expect(el.querySelector('.inspector-kpi-strip')?.textContent).toContain('4.4×')
      expect(el.querySelector('.inspector-vitals-rail')).not.toBeNull()
      expect(el.querySelector('.inspector-vitals-rail .ratio-bar.flat')).not.toBeNull()

      // Canonical tab order for a rich native table.
      const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map(t => t.dataset.inspectorTab)).toEqual(['overview', 'definition', 'storage', 'columns', 'labels', 'preview'])

      // Arrowing across tabs to Preview Rows moves focus without loading Preview Rows!
      act(() => { tabs[0].focus() })
      act(() => { tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
      expect(document.activeElement).toBe(tabs[5])
      expect(bigQueryProperties.view(docId)?.preview).toBeUndefined()

      // Overview shows Identity & Lifecycle FactGrid + CapabilityChips + Description.
      expect(el.textContent).toContain('Canonical order ledger synced hourly.')
      expect(el.querySelector('.cap-chips')).not.toBeNull()

      // Definition tab for a native table shows explicit Load DDL prompt (no automatic billed SQL).
      act(() => { tabs[1].click() })
      expect(el.textContent).toContain('Load CREATE statement on demand')
      expect(el.querySelector('[data-bq-definition-editor]')).toBeNull()
      const loadDdlBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent?.includes('Load DDL'))
      expect(loadDdlBtn).toBeDefined()

      // Storage & Layout tab renders card-mode RatioBar and storage facts.
      act(() => { tabs[2].click() })
      expect(el.querySelector('.inspector-pane-flow .ratio-bar:not(.flat)')).not.toBeNull()
      expect(el.textContent).toContain('Compression ratio')
      expect(el.textContent).toContain('4.4×')

      // Columns tab renders filterable full-bleed LocalGrid with Expand all / Collapse all for nested STRUCTs.
      act(() => { tabs[3].click() })
      expect(el.querySelector('[role="tabpanel"]')?.className).toBe('inspector-pane-fill')
      expect(el.querySelector('input[aria-label="Filter columns"]')).not.toBeNull()
      const expandAllBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent?.includes('Expand all'))!
      expect(expandAllBtn).toBeDefined()
      expect(el.textContent).toContain('6 columns')
      act(() => { expandAllBtn.click() })
      expect(el.textContent).toContain('10 rows (6 top-level)')

      // Labels tab renders chips with copy support.
      act(() => { tabs[4].click() })
      expect(el.querySelectorAll('.bq-label-chip')).toHaveLength(2)
      const copyDomain = el.querySelector<HTMLButtonElement>('button[aria-label="Copy label domain"]')!
      await act(async () => { copyDomain.click(); await Promise.resolve() })
      expect(writeClipboardText).toHaveBeenCalledWith('domain=commerce')

      // Definition tab explicit Load DDL loads Monaco GoogleSQL editor on click.
      act(() => { tabs[1].click() })
      const loadBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent?.includes('Load DDL'))!
      await act(async () => { loadBtn.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(el.querySelector('[data-bq-definition-editor]')).not.toBeNull()
      expect(el.textContent).toContain('Copy')
      expect(el.textContent).toContain('Open in New Query')
    } finally {
      cleanup()
    }
  })

  it('renders free GoogleSQL definition immediately for views and omits Storage & Layout, Labels, and Preview Rows when N/A', async () => {
    const { wb, docId, createdModels, cleanup } = setupUi('bqView', { ...richViewProps, definitionTruncated: true, schemaTruncated: true })
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      const el = mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryPropertiesTab, { documentId: docId }) }))

      const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map(t => t.dataset.inspectorTab)).toEqual(['overview', 'definition', 'columns'])
      // Hero KPIs omit storage metrics on a view.
      expect(el.querySelector('.inspector-kpi-strip')?.textContent).not.toContain('Rows')
      expect(el.querySelector('.inspector-kpi-strip')?.textContent).toContain('US')

      // Definition tab renders the free Monaco GoogleSQL editor immediately without Load DDL + shows truncation notice.
      act(() => { tabs[1].click() })
      expect(el.querySelector('[data-bq-definition-editor]')).not.toBeNull()
      expect(createdModels.some(m => m.language === 'googlesql' && m.text.includes('SELECT order_id'))).toBe(true)
      expect(el.textContent).toContain('Free · tables.get')
      expect(el.textContent).toContain('truncated at 1,000,000 characters')
      expect(el.textContent).not.toContain('Load DDL')

      // Columns tab shows schema truncation notice.
      act(() => { tabs[2].click() })
      expect(el.textContent).toContain('past the display limit were omitted')
    } finally {
      cleanup()
    }
  })

  it('omits Preview Rows for external tables and renders External semantic pill', async () => {
    const extProps: BigQueryProperties = {
      ...richTableProps,
      type: 'external table',
      storage: undefined,
      layout: undefined
    }
    const { wb, docId, cleanup } = setupUi('bqExternalTable', extProps)
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      const el = mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryPropertiesTab, { documentId: docId }) }))
      expect(el.textContent).toContain('External')
      const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map(t => t.dataset.inspectorTab)).not.toContain('preview')
    } finally {
      cleanup()
    }
  })

  it('shows loading state instead of Load DDL while view metadata is pending, falls back to value.columns when schema is [], and scopes heading IDs', async () => {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    fixture.connections.add({ id: 'bq-1', server: 'analytics_prod', displayName: 'bq-analytics (ADC)', database: 'commerce', login: 'user@example.com', serverVersion: 'BigQuery', providerId: 'bigquery', generation: 1 }, { provider: 'bigquery', project: 'analytics_prod', authentication: 'gcloud' })
    const pendingView = deferred<ApiResult<BigQueryProperties>>()
    const bigQueryProperties = new BigQueryPropertiesService({
      api: {
        bigQueryProperties: vi.fn((params: { name: string }) => params.name === 'pending_view'
          ? pendingView.promise
          : Promise.resolve({ ok: true as const, value: { ...richTableProps, name: params.name, schema: [], columns: [{ name: 'legacy_col', type: 'STRING' }] } })),
        scriptObjects: vi.fn(async () => ({ ok: true as const, value: { database: 'commerce', commands: 1, elapsedMs: 5, warnings: [], text: '' } })),
        cancelScripting: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } })),
        execute: vi.fn(async () => ({ ok: false as const, error: 'not called' })),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } }))
      },
      documents: fixture.documents,
      connections: fixture.connections,
      results: fixture.results,
      billedGate: vi.fn(async () => ({ run: true }))
    })
    const wb = {
      ...fixture,
      bigQueryProperties,
      menus: { open: vi.fn() }
    } as unknown as Workbench
    const viewId = bigQueryProperties.open(node('bqView', { label: 'pending_view', ref: { type: 'object', object: { kind: 'bqView', project: 'analytics_prod', dataset: 'commerce', name: 'pending_view' } } }))!
    const tbl1 = bigQueryProperties.open(node('bqTable', { label: 'tbl_a', ref: { type: 'object', object: { kind: 'bqTable', project: 'analytics_prod', dataset: 'commerce', name: 'tbl_a' } } }))!
    const tbl2 = bigQueryProperties.open(node('bqTable', { label: 'tbl_b', ref: { type: 'object', object: { kind: 'bqTable', project: 'analytics_prod', dataset: 'commerce', name: 'tbl_b' } } }))!
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      const el = mount(createElement(WorkbenchProvider, {
        workbench: wb,
        children: createElement('div', null,
          createElement(BigQueryPropertiesTab, { documentId: viewId }),
          createElement(BigQueryPropertiesTab, { documentId: tbl1 }),
          createElement(BigQueryPropertiesTab, { documentId: tbl2 })
        )
      }))
      // Pending view: clicking Definition shows loading metadata, NOT Load DDL.
      const viewRoot = el.querySelector(`[data-bigquery-properties="${viewId}"]`)!
      const viewDefTab = viewRoot.querySelector<HTMLButtonElement>('[data-inspector-tab="definition"]')!
      act(() => { viewDefTab.click() })
      expect(viewRoot.textContent).toContain('Loading object metadata')
      expect(viewRoot.textContent).not.toContain('Load DDL')

      // Fallback to value.columns when schema is [].
      const tbl1Root = el.querySelector(`[data-bigquery-properties="${tbl1}"]`)!
      act(() => { tbl1Root.querySelector<HTMLButtonElement>('[data-inspector-tab="columns"]')!.click() })
      expect(tbl1Root.textContent).toContain('1 column')
      expect(tbl1Root.textContent).not.toContain('This object has no columns')

      // No duplicate heading IDs across simultaneously mounted tabs.
      const ids = [...el.querySelectorAll('h2[id]')].map(h => h.id)
      expect(new Set(ids).size).toBe(ids.length)
    } finally {
      bigQueryProperties.dispose()
      pendingView.resolve({ ok: true, value: richViewProps })
      fixture.dispose()
    }
  })

  it('renders BigQuery Routine Properties with free routines.get definition, Parameters grid, pills and KPIs', async () => {
    const routineProps: BigQueryProperties = {
      name: 'to_cents',
      type: 'function',
      elapsedMs: 6,
      fullName: 'analytics_prod.commerce.to_cents',
      description: 'Convert dollars to integer cents.',
      createdUtc: '2025-02-01 09:00:00 UTC',
      modifiedUtc: '2026-06-01 14:30:00 UTC',
      definition: 'CAST(ROUND(amount * 100) AS INT64)',
      routine: {
        routineType: 'SCALAR_FUNCTION',
        language: 'SQL',
        determinism: 'DETERMINISTIC',
        returnType: 'INT64',
        signature: '(amount NUMERIC) RETURNS INT64',
        arguments: [
          { name: 'amount', type: 'NUMERIC', mode: 'IN', kind: 'FIXED_TYPE' },
          { name: 'currency', type: 'STRING', mode: 'IN', kind: 'FIXED_TYPE' }
        ]
      },
      groups: []
    }
    const { wb, docId, cleanup } = setupUi('bqRoutine', routineProps)
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      const el = mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryPropertiesTab, { documentId: docId }) }))
      const tabIds = [...el.querySelectorAll('[role="tab"]')].map(t => t.getAttribute('data-inspector-tab'))
      expect(tabIds).toEqual(['overview', 'definition', 'parameters'])
      expect(el.textContent).toContain('BigQuery Function')
      expect(el.textContent).toContain('Deterministic')
      expect(el.textContent).toContain('INT64')

      // Definition displays free routines.get SQL immediately with zero billed queries.
      act(() => { el.querySelector<HTMLButtonElement>('[data-inspector-tab="definition"]')!.click() })
      expect(el.textContent).toContain('Free · routines.get')
      expect(el.querySelector('[data-bq-definition-editor]')).not.toBeNull()

      // Parameters tab renders filterable LocalGrid with count.
      act(() => { el.querySelector<HTMLButtonElement>('[data-inspector-tab="parameters"]')!.click() })
      expect(el.textContent).toContain('2 parameters')
      expect(el.querySelector('input[aria-label="Filter parameters"]')).not.toBeNull()
    } finally {
      cleanup()
    }
  })

  it('renders BigQuery Dataset Properties without Definition or Script As, with 2-level crumbs, KMS, expiration and Labels', async () => {
    const datasetProps: BigQueryProperties = {
      name: 'commerce',
      type: 'dataset',
      elapsedMs: 5,
      fullName: 'analytics_prod.commerce',
      location: 'EU',
      description: 'Core commerce warehouse dataset.',
      createdUtc: '2024-01-05 00:00:00 UTC',
      modifiedUtc: '2026-11-20 12:00:00 UTC',
      labels: [{ key: 'domain', value: 'commerce' }, { key: 'pii', value: 'restricted' }],
      dataset: {
        friendlyName: 'Commerce Warehouse',
        defaultTableExpirationMs: 86_400_000 * 90,
        defaultPartitionExpirationMs: 86_400_000 * 30,
        kmsKeyName: 'projects/analytics_prod/locations/eu/keyRings/bq/cryptoKeys/main',
        defaultCollation: 'und:ci',
        isCaseInsensitive: true,
        maxTimeTravelHours: 168,
        storageBillingModel: 'PHYSICAL'
      },
      groups: []
    }
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    const bigQueryProperties = new BigQueryPropertiesService({
      api: { bigQueryProperties: vi.fn(async () => ({ ok: true as const, value: datasetProps })) },
      documents: fixture.documents,
      connections: new ConnectionsStore([{ id: 'bq-1' }])
    })
    const wb = Object.assign(Object.create(null), fixture, { bigQueryProperties }) as unknown as Workbench
    const dsNode: ExplorerMenuNode = {
      id: 9, connectionId: 'bq-1', lost: false, kind: 'bqDataset', label: 'commerce',
      ref: { type: 'object', object: { kind: 'bqDataset', project: 'analytics_prod', name: 'commerce' } }
    } as ExplorerMenuNode
    const docId = bigQueryProperties.open(dsNode)!
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      const el = mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryPropertiesTab, { documentId: docId }) }))
      const tabIds = [...el.querySelectorAll('[role="tab"]')].map(t => t.getAttribute('data-inspector-tab'))
      expect(tabIds).toEqual(['overview', 'labels'])
      expect(el.textContent).toContain('BigQuery Dataset')
      expect(el.textContent).toContain('CMEK')
      expect(el.textContent).toContain('90 days')
      expect(el.textContent).toContain('projects/analytics_prod/locations/eu/keyRings/bq/cryptoKeys/main')
      // Dataset has no Script As button and 2-level crumbs (connection › project, not repeating dataset).
      expect(el.textContent).not.toContain('Script As')
      expect(el.querySelectorAll('.document-crumb')).toHaveLength(2)

      act(() => { el.querySelector<HTMLButtonElement>('[data-inspector-tab="labels"]')!.click() })
      expect(el.textContent).toContain('domain')
      expect(el.textContent).toContain('restricted')
    } finally {
      bigQueryProperties.dispose()
      fixture.dispose()
    }
  })
})
