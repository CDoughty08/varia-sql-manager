import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { bigQueryFieldPathMax, bigQueryFieldText, bigQueryPath, isBigQueryFieldPath, isBigQueryName, quoteBigQuery } from '../src/shared/bigquery/names'
import { bigQueryMaxColumnFacts, bigQueryMaxDefinition, bigQueryPreviewTargetSchema, bigQueryPropertiesLimits, bigQueryPropertiesRequestSchema, bigQueryPropertiesSchema, type BigQueryProperties, type BigQuerySchemaField } from '../src/shared/bigquery/objects'
import type { BigQueryStarredProjectsView } from '../src/shared/bigquery-connections'
import type { ApiResult, ExplorerChildrenResult, VariaApi } from '../src/shared/contracts'
import { decodeControl, encodeControl } from '../src/shared/ipc/wire/msgpack'
import { validateRequest, validateResult } from '../src/main/validation'
import { contextRecord } from '../src/shared/commands/context-keys'
import { optionsAllow } from '../src/shared/ipc/methods'
import { CommandService } from '../src/renderer/src/core/commands'
import { EventBus } from '../src/renderer/src/core/events'
import { explorerContribution } from '../src/renderer/src/contributions/explorer'
import ExplorerRow, { rowClick, type RowActions } from '../src/renderer/src/explorer/ExplorerRow'
import { ExplorerService, sessionProjectDetail } from '../src/renderer/src/explorer/ExplorerService'
import { RowKind, type TreeNode } from '../src/renderer/src/explorer/tree-model'
import { resolveMenu } from '../src/renderer/src/menus/resolve'
import { argsFor, targetKeys, type MenuTarget } from '../src/renderer/src/menus/targets'
import { QuickInputService } from '../src/renderer/src/quickinput/QuickInputService'
import { BigQueryStarredService } from '../src/renderer/src/services/bigquery-starred'
import { ConnectionService, type LiveConnection } from '../src/renderer/src/services/connections'

// BigQuery's Object Explorer names and requests (docs/bigquery.md, Object Explorer); BqNames (C#) checks the same rules again.
const hostile = ['a`b', 'a\\b', 'a.b', 'a\nb', 'a;b', 'a"b', '']
const uuid = '9b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e'

describe('BigQuery names', () => {
  it('keeps each kind to its rule and refuses what could leave a quoted identifier', () => {
    expect(isBigQueryName('project', 'varia-alpha')).toBe(true)
    expect(isBigQueryName('project', 'example.com:varia-alpha')).toBe(true)
    expect(isBigQueryName('project', 'Varia_Alpha')).toBe(false)
    expect(isBigQueryName('dataset', 'sales_2024')).toBe(true)
    expect(isBigQueryName('dataset', 'sales-2024')).toBe(false)
    expect(isBigQueryName('table', 'Ünïcode table-1')).toBe(true)
    expect(isBigQueryName('column', "a&b%c=d+e:f'g<h>i#j|k")).toBe(true)
    for (const kind of ['dataset', 'table', 'routine', 'model', 'column'] as const)
      for (const name of hostile) expect(isBigQueryName(kind, name), `${kind} ${JSON.stringify(name)}`).toBe(false)
  })

  it('bounds lengths, a table in UTF-8 bytes', () => {
    expect(isBigQueryName('table', 'a'.repeat(1024))).toBe(true)
    expect(isBigQueryName('table', 'é'.repeat(513))).toBe(false)
    expect(isBigQueryName('routine', 'a'.repeat(257))).toBe(false)
    expect(isBigQueryName('column', 'a'.repeat(301))).toBe(false)
    expect(bigQueryFieldPathMax).toBe(15 * 300 + 14)
    expect(isBigQueryFieldPath(Array(15).fill('a').join('.'))).toBe(true)
    expect(isBigQueryFieldPath(Array(16).fill('a').join('.'))).toBe(false)
    expect(isBigQueryFieldPath('a..b')).toBe(false)
  })

  it('quotes paths and field paths with backticks, escaping as GoogleSQL reads them', () => {
    expect(quoteBigQuery('a`b\\c')).toBe('`a\\`b\\\\c`')
    expect(bigQueryPath('varia-alpha', 'sales', 'my table')).toBe('`varia-alpha.sales.my table`')
    expect(bigQueryFieldText('address.geo.lat')).toBe('`address`.`geo`.`lat`')
  })
})

describe('BigQuery Object Explorer requests', () => {
  it('validates Preview Rows targets and refuses them for SQL Server', () => {
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'orders' }).success).toBe(true)
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'or`ders' }).success).toBe(false)
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'orders', extra: 1 }).success).toBe(false)
    const preview = { project: 'varia-alpha', dataset: 'sales', table: 'orders' }
    expect(optionsAllow('query.execute', 'bigquery', { preview })).toBe(true)
    expect(optionsAllow('query.execute', 'sqlserver', { preview })).toBe(false)
  })

  it('validates bigquery.properties for table-like kinds and routines, and bounds its answer', () => {
    const request = { connectionId: uuid, requestId: uuid, kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }
    expect(() => validateRequest('bigquery.properties', request)).not.toThrow()
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqRoutine', name: 'to_cents' }).success).toBe(true)
    // A routine name is checked by the routine rule (letters, digits and underscores), a table name by the table rule, and a dataset must match dataset === name.
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqRoutine', name: 'daily view' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqDataset', dataset: 'sales', name: 'sales' }).success).toBe(true)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqDataset', dataset: 'sales', name: 'other' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqDataset', dataset: 'bad-ds', name: 'bad-ds' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, name: 'daily view' }).success).toBe(true)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqModel' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, name: 'a\\b' }).success).toBe(false)
    const facts = { name: 'daily', type: 'view', elapsedMs: 3, groups: [{ title: 'Table', facts: [{ label: 'Type', value: 'view' }] }] }
    expect(bigQueryPropertiesSchema.safeParse(facts).success).toBe(true)
    expect(bigQueryPropertiesSchema.safeParse({ ...facts, groups: [{ title: 'Table', facts: [{ label: 'Description', value: 'x'.repeat(2001) }] }] }).success).toBe(false)
    const detailed = { ...facts, definition: 'SELECT 1', columns: [{ name: 'day', type: 'DATE', description: 'The day.' }, { name: 'n', type: 'INT64' }] }
    expect(bigQueryPropertiesSchema.safeParse(detailed).success).toBe(true)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, definition: 'x'.repeat(bigQueryMaxDefinition + 1) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columns: Array.from({ length: bigQueryMaxColumnFacts + 1 }, (_, i) => ({ name: 'c' + i, type: 'INT64' })) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columns: [{ name: 'day', type: 'DATE', description: 'x'.repeat(1025) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columnsCut: false }).success).toBe(false)
  })

  it('accepts structured BigQuery properties through MessagePack and rejects over-limit or malformed payloads', () => {
    const nest = (levels: number): BigQuerySchemaField => {
      let node: BigQuerySchemaField = { name: `l${levels}`, type: 'INT64' }
      for (let i = levels - 1; i >= 1; i--) node = { name: `l${i}`, type: 'STRUCT', mode: 'REPEATED', fields: [node] }
      return node
    }
    const rich: BigQueryProperties = {
      name: 'orders',
      type: 'table',
      elapsedMs: 12,
      groups: [{ title: 'Table', facts: [{ label: 'Type', value: 'table' }] }],
      fullName: 'varia-alpha.sales.orders',
      location: 'US',
      description: 'Orders placed online.',
      createdUtc: '2023-11-14 22:13:20 UTC',
      modifiedUtc: '2023-11-15 22:13:20 UTC',
      storage: { rows: 1_234_567, logicalBytes: Number.MAX_SAFE_INTEGER, longTermLogicalBytes: 0, physicalBytes: 1_073_741_824 },
      layout: { partitioning: 'DAY on placed', requirePartitionFilter: true, clustering: ['customer', 'region'] },
      columns: [{ name: 'id', type: 'INT64', description: 'Primary identifier' }],
      schema: [
        { name: 'id', type: 'INT64', mode: 'REQUIRED', description: 'Primary identifier' },
        nest(bigQueryPropertiesLimits.schemaDepth)
      ],
      schemaTruncated: false,
      labels: [{ key: 'env', value: 'prod' }, { key: 'empty_ok', value: '' }],
      definition: 'SELECT 1',
      definitionTruncated: false
    }
    expect(bigQueryPropertiesSchema.safeParse(rich).success).toBe(true)
    // A 7-level nested schema tree inside { result } must round-trip within protocol v2's 16-container depth limit.
    const decoded = decodeControl(encodeControl({ result: rich })) as { result: unknown }
    expect(validateResult('bigquery.properties', decoded.result)).toEqual(rich)

    // Depth over schemaDepth (7), even with an empty fields array on level 7, is rejected.
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [nest(bigQueryPropertiesLimits.schemaDepth + 1)] }).success).toBe(false)
    let level7EmptyFields: BigQuerySchemaField = { name: 'l7', type: 'STRUCT', fields: [] }
    for (let i = 6; i >= 1; i--) level7EmptyFields = { name: `l${i}`, type: 'STRUCT', fields: [level7EmptyFields] }
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [level7EmptyFields] }).success).toBe(false)

    // Total field count over 10,000 is rejected both flat and nested.
    const flatTooMany = Array.from({ length: bigQueryPropertiesLimits.schemaFields + 1 }, (_, i) => ({ name: `c${i}`, type: 'STRING' }))
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: flatTooMany }).success).toBe(false)
    const nestedTooMany = Array.from({ length: 100 }, (_, i) => ({
      name: `s${i}`, type: 'STRUCT',
      fields: Array.from({ length: 100 }, (_, j) => ({ name: `f${j}`, type: 'INT64' }))
    }))
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: nestedTooMany }).success).toBe(false)

    // String length, array length, storage count and strictness bounds.
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: '', type: 'STRING' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a'.repeat(301), type: 'STRING' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'T'.repeat(65) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', mode: 'M'.repeat(33) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', description: 'd'.repeat(2001) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: Array.from({ length: 65 }, (_, i) => ({ key: `k${i}`, value: 'v' })) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: '', value: 'v' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'k'.repeat(129), value: 'v' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'k', value: 'v'.repeat(257) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, layout: { clustering: Array.from({ length: 17 }, (_, i) => `c${i}`) } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { rows: -1 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { logicalBytes: 1.5 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { physicalBytes: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, definition: 'x'.repeat(bigQueryPropertiesLimits.definitionChars + 1) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, unknown: true }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { rows: 1, extra: 2 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, layout: { requirePartitionFilter: true, extra: 2 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'a', value: 'b', extra: 1 }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', extra: 1 }] }).success).toBe(false)

    // Structured routine and dataset payloads round-trip cleanly and enforce bounds + strictness.
    const routinePayload: BigQueryProperties = {
      name: 'to_cents',
      type: 'function',
      elapsedMs: 4,
      groups: [],
      fullName: 'varia-alpha.sales.to_cents',
      definition: 'CAST(x * 100 AS INT64)',
      routine: {
        routineType: 'SCALAR_FUNCTION',
        language: 'SQL',
        determinism: 'DETERMINISTIC',
        returnType: 'INT64',
        signature: '(x NUMERIC) RETURNS INT64',
        arguments: [{ name: 'x', type: 'NUMERIC', mode: 'IN', kind: 'FIXED_TYPE' }]
      }
    }
    expect(validateResult('bigquery.properties', (decodeControl(encodeControl({ result: routinePayload })) as { result: unknown }).result)).toEqual(routinePayload)
    expect(bigQueryPropertiesSchema.safeParse({
      ...routinePayload,
      routine: { ...routinePayload.routine, arguments: Array.from({ length: bigQueryPropertiesLimits.routineArguments + 1 }, (_, i) => ({ name: `a${i}`, type: 'INT64' })) }
    }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({
      ...routinePayload,
      routine: { ...routinePayload.routine, returnType: 'T'.repeat(bigQueryPropertiesLimits.routineTypeText + 1) }
    }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...routinePayload, routine: { ...routinePayload.routine, extra: 1 } }).success).toBe(false)

    const datasetPayload: BigQueryProperties = {
      name: 'sales',
      type: 'dataset',
      elapsedMs: 3,
      groups: [],
      fullName: 'varia-alpha.sales',
      location: 'US',
      labels: [{ key: 'env', value: 'prod' }],
      dataset: {
        friendlyName: 'Sales Data',
        defaultTableExpirationMs: 7_776_000_000,
        defaultPartitionExpirationMs: 2_592_000_000,
        kmsKeyName: 'projects/varia-alpha/locations/us/keyRings/r/cryptoKeys/k',
        defaultCollation: 'und:ci',
        isCaseInsensitive: true,
        maxTimeTravelHours: 168,
        storageBillingModel: 'PHYSICAL'
      }
    }
    expect(validateResult('bigquery.properties', (decodeControl(encodeControl({ result: datasetPayload })) as { result: unknown }).result)).toEqual(datasetPayload)
    expect(bigQueryPropertiesSchema.safeParse({
      ...datasetPayload,
      dataset: { ...datasetPayload.dataset, kmsKeyName: 'k'.repeat(bigQueryPropertiesLimits.kmsKeyName + 1) }
    }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...datasetPayload, dataset: { ...datasetPayload.dataset, extra: 1 } }).success).toBe(false)
  })
})

describe('BigQuery Starred & Session Projects in Object Explorer', () => {
  const ada = 'bigquery:user:ada@example.com'
  const connectionId = '9b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e'
  const liveBigQuery = (): LiveConnection => ({
    id: connectionId, generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', login: 'ada@example.com',
    providerId: 'bigquery', principalId: ada,
    authentication: { principal: { provider: 'bigquery', project: 'varia-alpha', principal: ada } },
    options: { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', authentication: 'gcloud' }
  })

  function setupExplorer(initialStarred: readonly string[] = []) {
    let stored: Record<string, string[]> = initialStarred.length ? { [ada]: [...initialStarred] } : {}
    const starredApi: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, [...v]])) } as BigQueryStarredProjectsView })),
      setBigQueryProjectStar: vi.fn(async input => {
        const list = stored[input.principal] ?? []
        const next = input.starred ? (list.includes(input.project) ? list : [...list, input.project]) : list.filter(item => item !== input.project)
        if (next.length) stored = { ...stored, [input.principal]: next }
        else { const copy = { ...stored }; delete copy[input.principal]; stored = copy }
        return { ok: true as const, value: { byPrincipal: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, [...v]])) } }
      })
    }
    const bigQueryStarred = new BigQueryStarredService({ api: starredApi })
    const connections = new ConnectionService()
    const conn = liveBigQuery()
    connections.add(conn, conn.options)
    const explorerApi: Pick<VariaApi, 'explorerChildren' | 'explorerCancel'> = {
      explorerChildren: vi.fn(async (params): Promise<{ ok: true; value: ExplorerChildrenResult }> => {
        const ref = params.node
        if (ref.type === 'object' && ref.object.kind === 'server') {
          return { ok: true, value: { nodes: [{ ref: { type: 'object', object: { kind: 'bqProject', name: 'varia-alpha' } }, label: 'varia-alpha', icon: 'project', hasChildren: true, sublabel: 'billing project' }], total: 1, elapsedMs: 1 } }
        }
        if (ref.type === 'object' && ref.object.kind === 'bqProject') {
          return { ok: true, value: { nodes: [{ ref: { type: 'object', object: { kind: 'bqDataset', project: ref.object.name, name: 'samples' } }, label: 'samples', icon: 'database', hasChildren: true }], total: 1, elapsedMs: 1 } }
        }
        return { ok: true, value: { nodes: [], total: 0, elapsedMs: 1 } }
      }),
      explorerCancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } }))
    }
    const events = new EventBus()
    const explorer = new ExplorerService({ api: explorerApi, connections, events, schedule: cb => cb(), bigQueryStarred })
    return { explorer, bigQueryStarred, connections, events, starredApi, explorerApi }
  }

  it('orders billing project first, then starred (deduplicated), then session-only projects, and reconciles live while preserving expansion', async () => {
    const { explorer, bigQueryStarred } = setupExplorer(['varia-alpha', 'varia-beta'])
    await bigQueryStarred.load()
    await Promise.resolve()
    await Promise.resolve()
    const root = explorer.node(explorer.rootIds[0]!)!
    // Server auto-expanded on connect and loaded billing + deduplicated starred projects.
    expect(root.children?.map(child => [child.label, child.bigQueryProjectRole, child.sublabel, child.detail])).toEqual([
      ['varia-alpha', 'billing', 'billing project', undefined],
      ['varia-beta', 'starred', undefined, undefined]
    ])
    expect(explorer.isBigQueryProjectBilling(connectionId, 'varia-alpha')).toBe(true)
    expect(explorer.isBigQueryProjectStarred(connectionId, 'varia-beta')).toBe(true)

    // ensureBigQueryProject adds a session-only project immediately so seek walks right into it.
    explorer.ensureBigQueryProject(connectionId, 'bigquery-public-data')
    expect(root.children?.map(child => [child.label, child.bigQueryProjectRole, child.detail])).toEqual([
      ['varia-alpha', 'billing', undefined],
      ['varia-beta', 'starred', undefined],
      ['bigquery-public-data', 'session', sessionProjectDetail]
    ])
    const revealOutcome = await explorer.seek(connectionId, [[
      { type: 'object', object: { kind: 'bqProject', name: 'bigquery-public-data' } },
      { type: 'object', object: { kind: 'bqDataset', project: 'bigquery-public-data', name: 'samples' } }
    ]])
    expect(revealOutcome.ok).toBe(true)
    const publicProject = root.children!.find(child => child.label === 'bigquery-public-data')!
    expect(publicProject.expanded).toBe(true)
    const publicId = publicProject.id

    // Starring the session-only project upgrades its role in place without disrupting expansion or node identity.
    await bigQueryStarred.setStarred(ada, 'bigquery-public-data', true)
    expect(root.children!.find(child => child.label === 'bigquery-public-data')).toMatchObject({ id: publicId, expanded: true, bigQueryProjectRole: 'starred', detail: undefined })

    // syncBigQueryReferencedProjects adds unstarred referenced projects and deduplicates billing & starred.
    explorer.syncBigQueryReferencedProjects(connectionId, ['varia-alpha', 'bigquery-public-data', 'session-ref-1'])
    expect(root.children?.map(child => [child.label, child.bigQueryProjectRole])).toEqual([
      ['varia-alpha', 'billing'],
      ['varia-beta', 'starred'],
      ['bigquery-public-data', 'starred'],
      ['session-ref-1', 'session']
    ])

    // removeBigQuerySessionProject removes session-only projects immediately.
    explorer.removeBigQuerySessionProject(connectionId, 'session-ref-1')
    expect(root.children?.map(child => child.label)).toEqual(['varia-alpha', 'varia-beta', 'bigquery-public-data'])
    explorer.dispose()
    bigQueryStarred.dispose()
  })

  it('registers Star a Project… (paging + verifying typed project IDs), Star/Unstar Project, and Remove from Explorer commands', async () => {
    const { explorer, bigQueryStarred, connections } = setupExplorer(['varia-beta'])
    await bigQueryStarred.load()
    await Promise.resolve()
    await Promise.resolve()
    explorer.ensureBigQueryProject(connectionId, 'session-only-1')

    const commands = new CommandService({ state: () => contextRecord('win32', { backendReady: true, hasConnection: true, explorerSelectionProvider: 'bigquery' }) })
    const quickInput = new QuickInputService({ capture: () => undefined, restore: () => {} })
    const bigQueryConnectionProjects = vi.fn<VariaApi['bigQueryConnectionProjects']>(async params => params.pageToken
      ? { ok: true, value: { projects: [{ id: 'varia-gamma', friendlyName: 'Gamma' }] } }
      : { ok: true, value: { projects: [{ id: 'varia-alpha', friendlyName: 'Alpha' }, { id: 'varia-beta' }], nextPageToken: 'p2' } })
    let holdPendingVerify: ((result: ApiResult<ExplorerChildrenResult>) => void) | undefined
    const explorerChildren = vi.fn<VariaApi['explorerChildren']>(async params => {
      const name = params.node.type === 'object' ? params.node.object.name : ''
      if (name === 'bobs-tacos') {
        return { ok: true, value: { nodes: [], elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'BigQuery project “bobs-tacos” was not found.', retryable: false } } }
      }
      if (name === 'secret-project') {
        return { ok: true, value: { nodes: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Permission denied on project “secret-project”.', retryable: false } } }
      }
      if (name === 'reject-project') {
        return Promise.reject(new Error('IPC channel closed'))
      }
      if (name === 'slow-project') {
        return new Promise<ApiResult<ExplorerChildrenResult>>(resolve => { holdPendingVerify = resolve })
      }
      return { ok: true, value: { nodes: [], elapsedMs: 1 } }
    })
    const explorerCancel = vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
    const refreshBigQuery = vi.fn()
    const contrib = explorerContribution(
      { commands, documents: {} as never, connections, explorer, quickInput, bigQueryStarred, objectSearch: { refreshNode: vi.fn(), refreshBigQuery } },
      { writeClipboardText: vi.fn(async () => ({ ok: true as const, value: undefined })), bigQueryConnectionProjects, explorerChildren, explorerCancel }
    )

    const root = explorer.node(explorer.rootIds[0]!)!
    const billingNode = explorer.menuNode(root.children![0]!.id)!
    const starredNode = explorer.menuNode(root.children![1]!.id)!
    const sessionNode = explorer.menuNode(root.children![2]!.id)!

    // Context menu resolves Star Project for session, Unstar Project for starred, and neither for billing.
    const menuFor = (node: typeof billingNode) => {
      const target: MenuTarget = { kind: 'explorer', node }
      return resolveMenu('explorer.context', { platform: 'win32', state: { backendReady: true, hasConnection: true }, target: targetKeys(target), args: argsFor(target), commands, keybindings: { lookup: () => undefined } })
    }
    const titles = (items: ReturnType<typeof menuFor>) => items.filter(item => item.kind === 'command').map(item => [item.id, item.title])
    expect(titles(menuFor(billingNode))).not.toContainEqual(['bigquery.starProject', expect.any(String)])
    expect(titles(menuFor(billingNode))).not.toContainEqual(['bigquery.unstarProject', expect.any(String)])
    expect(titles(menuFor(billingNode))).not.toContainEqual(['bigquery.removeSessionProject', expect.any(String)])
    expect(titles(menuFor(starredNode))).toContainEqual(['bigquery.unstarProject', 'Unstar Project'])
    expect(titles(menuFor(starredNode))).not.toContainEqual(['bigquery.starProject', expect.any(String)])
    expect(titles(menuFor(starredNode))).not.toContainEqual(['bigquery.removeSessionProject', expect.any(String)])
    expect(titles(menuFor(sessionNode))).toContainEqual(['bigquery.starProject', 'Star Project'])
    expect(titles(menuFor(sessionNode))).not.toContainEqual(['bigquery.unstarProject', expect.any(String)])
    expect(titles(menuFor(sessionNode))).toContainEqual(['bigquery.removeSessionProject', 'Remove from Explorer'])

    // Star a Project… loads all pages from bigQueryConnectionProjects.
    const serverNode = explorer.menuNode(root.id)!
    expect(await commands.execute('bigquery.starProjectPrompt', { target: { kind: 'explorer', node: serverNode } }, 'menu')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(bigQueryConnectionProjects).toHaveBeenCalledTimes(2)
    expect(quickInput.getSnapshot().rows.map(row => [row.item.id, !!row.item.disabled])).toEqual([
      ['varia-alpha', true],
      ['varia-beta', true],
      ['varia-gamma', false]
    ])

    // Typing a non-existent project ("bobs-tacos") verifies it via explorerChildren, refuses to star it, and keeps the picker open with an error.
    quickInput.filter('bobs-tacos')
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['bobs-tacos'])
    quickInput.accept(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(explorerChildren).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionId,
      node: { type: 'object', object: { kind: 'bqProject', name: 'bobs-tacos' } },
      pageSize: 1
    }))
    expect(bigQueryStarred.isStarred(ada, 'bobs-tacos')).toBe(false)
    expect(quickInput.visible).toBe(true)
    expect(quickInput.getSnapshot().message).toEqual({
      text: 'Could not star “bobs-tacos”: BigQuery project “bobs-tacos” was not found.',
      severity: 'error'
    })

    // Typing an inaccessible project ("secret-project") is also refused.
    quickInput.filter('secret-project')
    quickInput.accept(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(bigQueryStarred.isStarred(ada, 'secret-project')).toBe(false)
    expect(quickInput.visible).toBe(true)
    expect(quickInput.getSnapshot().message?.severity).toBe('error')

    // A rejected explorerChildren call resets busy and shows an error instead of wedging the picker.
    quickInput.filter('reject-project')
    quickInput.accept(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(quickInput.getSnapshot().busy).toBe(false)
    expect(quickInput.visible).toBe(true)
    expect(quickInput.getSnapshot().message).toEqual({ text: 'Could not verify “reject-project”: IPC channel closed', severity: 'error' })

    // Editing the input while a verification check is in flight cancels the in-flight check and ignores its late reply.
    quickInput.filter('slow-project')
    quickInput.accept(0)
    expect(quickInput.getSnapshot().busy).toBe(true)
    quickInput.filter('bigquery-public-data')
    expect(explorerCancel).toHaveBeenCalledTimes(1)
    holdPendingVerify?.({ ok: true, value: { nodes: [], elapsedMs: 1 } })
    await Promise.resolve()
    expect(bigQueryStarred.isStarred(ada, 'slow-project')).toBe(false)

    // Typing an accessible unlisted project ("bigquery-public-data") verifies it, closes the picker, stars it, and refreshes the index scope.
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['bigquery-public-data'])
    quickInput.accept(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(quickInput.visible).toBe(false)
    expect(bigQueryStarred.isStarred(ada, 'bigquery-public-data')).toBe(true)
    expect(refreshBigQuery).toHaveBeenCalledWith(connectionId, { scope: { project: 'bigquery-public-data' } })

    // Picking a project already listed by projects.list ("varia-gamma") stars immediately without calling explorerChildren again.
    const callsBeforeListed = explorerChildren.mock.calls.length
    expect(await commands.execute('bigquery.starProjectPrompt', { target: { kind: 'explorer', node: serverNode } }, 'menu')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const gammaIndex = quickInput.getSnapshot().rows.findIndex(row => row.item.id === 'varia-gamma')
    expect(gammaIndex).toBeGreaterThanOrEqual(0)
    quickInput.accept(gammaIndex)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(explorerChildren).toHaveBeenCalledTimes(callsBeforeListed)
    expect(quickInput.visible).toBe(false)
    expect(bigQueryStarred.isStarred(ada, 'varia-gamma')).toBe(true)
    expect(refreshBigQuery).toHaveBeenCalledWith(connectionId, { scope: { project: 'varia-gamma' } })

    // Remove from Explorer removes the session-only project.
    expect(await commands.execute('bigquery.removeSessionProject', { target: { kind: 'explorer', node: sessionNode } }, 'menu')).toBe(true)
    expect(root.children?.map(child => child.label)).not.toContain('session-only-1')

    // Unstar Project removes the starred project cleanly.
    expect(await commands.execute('bigquery.unstarProject', { target: { kind: 'explorer', node: starredNode } }, 'menu')).toBe(true)
    expect(bigQueryStarred.isStarred(ada, 'varia-beta')).toBe(false)
    expect(root.children?.map(child => child.label)).not.toContain('varia-beta')

    contrib.dispose()
    quickInput.dispose()
    explorer.dispose()
    bigQueryStarred.dispose()
  })

  it('renders a star toggle button on non-billing bqProject rows only and ignores clicks on it for row peek', () => {
    const base = (role: TreeNode['bigQueryProjectRole'], label: string): TreeNode => ({
      id: 2, parent: 1, connectionId, ref: { type: 'object', object: { kind: 'bqProject', name: label } }, kind: 'bqProject', folder: undefined,
      level: 2, label, lower: label, sublabel: role === 'billing' ? 'billing project' : undefined,
      detail: role === 'session' ? sessionProjectDetail : undefined, icon: 'project', subtype: undefined, status: undefined, created: undefined,
      hasChildren: true, expanded: false, children: undefined, staticCount: 0, total: undefined, cursor: undefined, load: 'none', more: 'none',
      error: undefined, connectionError: undefined, filtered: false, lost: false, showLoading: false, generation: 0, rev: 0, lastUsed: 0, descendants: 0,
      bigQueryProjectRole: role
    })
    const actions: RowActions = {
      select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), toggleProjectStar: vi.fn(),
      dragStart: () => false, dragOver: () => {}, dragEnd: () => {}, commitRename: async () => true, cancelRename: () => {}, peekHover: () => {}, click: vi.fn()
    }
    const renderRow = (node: TreeNode) => renderToStaticMarkup(createElement(ExplorerRow, {
      rowId: node.id, kind: RowKind.Node, top: 0, level: node.level, posinset: 1, setsize: 3, node, rev: node.rev, text: '',
      selected: false, draggable: false, active: false, color: undefined, actions, menuTarget: () => {}
    }))
    expect(renderRow(base('billing', 'varia-alpha'))).not.toContain('oe-star-button')
    const starredHtml = renderRow(base('starred', 'varia-beta'))
    expect(starredHtml).toContain('oe-star-button starred')
    expect(starredHtml).toContain('data-icon="star-full"')
    expect(starredHtml).toContain('aria-label="Star varia-beta"')
    expect(starredHtml).toContain('aria-pressed="true"')
    const sessionHtml = renderRow(base('session', 'bigquery-public-data'))
    expect(sessionHtml).toContain('oe-star-button')
    expect(sessionHtml).toContain('data-icon="star-empty"')
    expect(sessionHtml).toContain('aria-label="Star bigquery-public-data"')
    expect(sessionHtml).toContain('aria-pressed="false"')
    // Clicking the star button does not trigger rowClick (Open Peek as Tab).
    rowClick(actions, 2, { detail: 1, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { closest: (sel: string) => sel.includes('.oe-star-button') ? {} : null } as unknown as EventTarget })
    expect(actions.click).not.toHaveBeenCalled()
  })

  it('reclaims session project slots when session projects are starred', async () => {
    const { explorer, bigQueryStarred } = setupExplorer([])
    await bigQueryStarred.load()
    await Promise.resolve()
    await Promise.resolve()
    const root = explorer.node(explorer.rootIds[0]!)!
    // Fill all 50 session project slots.
    for (let i = 0; i < 50; i++) explorer.ensureBigQueryProject(connectionId, `session-proj-${String(i).padStart(2, '0')}`)
    // Cap blocks a 51st session project while 50 unstarred session projects exist.
    explorer.ensureBigQueryProject(connectionId, 'session-proj-50')
    expect(root.children?.map(child => child.label)).not.toContain('session-proj-50')
    // Starring one of the session projects reclaims its slot so a new session project can be revealed.
    await bigQueryStarred.setStarred(ada, 'session-proj-00', true)
    explorer.ensureBigQueryProject(connectionId, 'session-proj-50')
    expect(root.children?.map(child => child.label)).toContain('session-proj-50')
    explorer.dispose()
    bigQueryStarred.dispose()
  })
})
