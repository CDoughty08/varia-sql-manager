import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BigQueryProperties } from '../src/shared/bigquery/objects'
import type { ApiResult } from '../src/shared/contracts'
import type { ObjectSearchHit } from '../src/shared/explorer/search'
import type { ScriptingOptions } from '../src/shared/scripting/options'
import { PeekService } from '../src/renderer/src/explorer/PeekService'
import { bigQueryColumnsTable, bigQueryFacts, hitProperties, Properties } from '../src/renderer/src/search/SearchDetails'
import { bigQueryDetailKind, columnsOf, SearchDetailsService } from '../src/renderer/src/search/SearchDetailsService'

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const connectionId = 'bq'
const table: ObjectSearchHit = { object: { kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'orders' }, folder: 'bqTables', label: 'sales.orders' }
const view: ObjectSearchHit = { object: { kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }, folder: 'bqViews', label: 'sales.daily' }
const routine: ObjectSearchHit = { object: { kind: 'bqRoutine', project: 'varia-alpha', dataset: 'sales', name: 'to_cents' }, folder: 'bqRoutines', label: 'sales.to_cents' }
const model: ObjectSearchHit = { object: { kind: 'bqModel', project: 'varia-alpha', dataset: 'sales', name: 'forecast' }, folder: 'bqModels', label: 'sales.forecast' }
const tableFacts: BigQueryProperties = {
  name: 'orders', type: 'table', elapsedMs: 4,
  groups: [
    { title: 'Table', facts: [{ label: 'Full name', value: 'varia-alpha.sales.orders' }, { label: 'Type', value: 'table' }, { label: 'Labels', value: 'env: dev, team: sales' }] },
    { title: 'Storage', facts: [{ label: 'Rows', value: '1,234,567' }, { label: 'Logical size', value: '5.00 GiB' }] },
    { title: 'Layout', facts: [{ label: 'Partitioning', value: 'DAY on placed' }, { label: 'Clustering', value: 'customer, region' }] }
  ],
  columns: [{ name: 'id', type: 'INT64' }, { name: 'customer', type: 'STRING', description: 'Who placed it.' }]
}

function setup(options: { gate?: boolean } = {}) {
  const pending: { properties: ((value: ApiResult<BigQueryProperties>) => void)[]; script: ((value: ApiResult<unknown>) => void)[] } = { properties: [], script: [] }
  const api = {
    explorerPeek: vi.fn(),
    explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
    scriptObjects: vi.fn(() => new Promise(resolve => { pending.script.push(resolve as never) })),
    cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
    bigQueryProperties: vi.fn(() => new Promise<ApiResult<BigQueryProperties>>(resolve => { pending.properties.push(resolve) }))
  }
  let live = [{ id: connectionId }]
  const connectionListeners = new Set<() => void>()
  const connections = { getSnapshot: () => live, subscribe: (listener: () => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener) } }
  const searches = { getSnapshot: () => ({ documents: { tab: {} } }), subscribe: () => () => {} }
  const scriptingOptions = { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} }
  let ids = 0
  const newId = () => `id-${++ids}`
  const gates: { estimate: unknown; signal: AbortSignal; answer: (value: { run: boolean; maximumBytesBilled?: number }) => void; fail: (error: Error) => void }[] = []
  const billedGate = (_connection: string, estimate: unknown, signal: AbortSignal) => new Promise<{ run: boolean; maximumBytesBilled?: number }>((resolve, reject) => { gates.push({ estimate, signal, answer: resolve, fail: reject }) })
  let timer: (() => void) | undefined
  const peek = new PeekService({ api: api as never, connections, scriptingOptions, newId })
  const service = new SearchDetailsService({ api: api as never, peek, connections, searches, scriptingOptions, newId, timers: { setTimeout: (callback: () => void) => { timer = callback; return 1 }, clearTimeout: () => { timer = undefined } }, ...options.gate === false ? {} : { billedGate: billedGate as never } })
  // Shows a hit and lets its selection settle.
  const show = (hit: ObjectSearchHit) => { service.show('tab', connectionId, hit); const settle = timer; timer = undefined; settle?.() }
  return { service, show, api, pending, gates, lose: () => { live = []; for (const listener of connectionListeners) listener() } }
}

describe('Search Objects details pane for BigQuery', () => {
  it('reads a table\'s free facts and columns on selection, and never its billed CREATE statement', async () => {
    const { service, show, api, pending } = setup()
    expect(bigQueryDetailKind(table.object)).toBe('bqTable')
    expect(columnsOf(table.object) && columnsOf(view.object) && !columnsOf(routine.object)).toBe(true)
    show(table)
    expect(api.bigQueryProperties).toHaveBeenCalledWith(expect.objectContaining({ connectionId, kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'orders' }))
    expect(service.getSnapshot().documents.tab).toMatchObject({ bigQuery: { status: 'loading' }, definition: { status: 'loading' } })
    pending.properties[0]!(ok(tableFacts))
    await flush()
    expect(service.getSnapshot().documents.tab).toMatchObject({ bigQuery: { status: 'ready', value: tableFacts }, definition: { status: 'billed' } })
    // Selection bills nothing: no Script As request, no estimate, no prompt.
    expect(api.scriptObjects).not.toHaveBeenCalled()
    expect(api.explorerPeek).not.toHaveBeenCalled()
    expect(bigQueryFacts(tableFacts).map(fact => fact.label)).toEqual(['Labels', 'Rows', 'Logical size', 'Partitioning', 'Clustering'])
    expect(bigQueryColumnsTable(tableFacts)).toEqual({ columns: [{ name: 'Name' }, { name: 'Type' }, { name: 'Description' }], rows: [['id', 'INT64', null], ['customer', 'STRING', 'Who placed it.']] })
    expect(hitProperties(table)).toEqual([{ label: 'Type', value: expect.any(String) }, { label: 'Project', value: 'varia-alpha' }, { label: 'Dataset', value: 'sales' }])
    const html = renderToStaticMarkup(createElement(Properties, { details: service.getSnapshot().documents.tab! }))
    expect(html).toContain('DAY on placed')
    expect(html).toContain('customer, region')
    expect(html).toContain('1,234,567')
    expect(html).toContain('env: dev, team: sales')
    expect(html).not.toContain('Full name')
  })

  it('shows a view\'s text and a routine\'s body from the free facts', async () => {
    const { service, show, api, pending } = setup()
    show(view)
    pending.properties[0]!(ok({ name: 'daily', type: 'view', elapsedMs: 1, groups: [], definition: 'SELECT 1 AS n' }))
    await flush()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'ready', value: { text: 'SELECT 1 AS n' } })
    show(routine)
    expect(api.bigQueryProperties).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'bqRoutine', name: 'to_cents' }))
    pending.properties[1]!(ok({ name: 'to_cents', type: 'function', elapsedMs: 1, groups: [], definition: 'x * 100' }))
    await flush()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'ready', value: { text: 'x * 100' } })
    // A routine without a body (a remote function) has no definition to show, and still bills nothing.
    show({ ...routine, object: { ...routine.object, name: 'remote' } })
    pending.properties[2]!(ok({ name: 'remote', type: 'function', elapsedMs: 1, groups: [] }))
    await flush()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'ready', value: {} })
    expect(api.scriptObjects).not.toHaveBeenCalled()
  })

  it('reads a table\'s CREATE statement only when asked: estimate, prompt, then the run under the cap', async () => {
    const { service, show, api, pending, gates } = setup()
    show(table)
    pending.properties[0]!(ok(tableFacts))
    await flush()
    expect(service.canReadCreate('tab')).toBe(true)
    const read = service.readCreate('tab')
    expect(api.scriptObjects).toHaveBeenLastCalledWith(expect.objectContaining({ verb: 'create', targets: [table.object], estimateOnly: true }))
    const estimate = { bytesProcessed: 10_485_760, incomplete: [], statementType: 'SELECT' }
    pending.script[0]!(ok({ warnings: [], estimate }))
    await flush()
    expect(gates).toHaveLength(1)
    expect(gates[0]!.estimate).toEqual(estimate)
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    gates[0]!.answer({ run: true, maximumBytesBilled: 1_073_741_824 })
    await flush()
    expect(api.scriptObjects).toHaveBeenLastCalledWith(expect.not.objectContaining({ estimateOnly: true }))
    expect(api.scriptObjects).toHaveBeenLastCalledWith(expect.objectContaining({ verb: 'create', maximumBytesBilled: 1_073_741_824 }))
    pending.script[1]!(ok({ text: 'CREATE TABLE `varia-alpha.sales.orders` (id INT64);', warnings: [] }))
    await read
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'ready', value: { text: 'CREATE TABLE `varia-alpha.sales.orders` (id INT64);' } })
  })

  it('offers the CREATE statement again when the prompt is declined, and closes the prompt for a new hit', async () => {
    const { service, show, api, pending, gates } = setup()
    show(table)
    pending.properties[0]!(ok(tableFacts))
    await flush()
    const declined = service.readCreate('tab')
    pending.script[0]!(ok({ warnings: [], estimate: { bytesProcessed: 1, incomplete: [], statementType: 'SELECT' } }))
    await flush()
    gates[0]!.answer({ run: false })
    await declined
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'billed' })
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    const moved = service.readCreate('tab')
    pending.script[1]!(ok({ warnings: [], estimate: { bytesProcessed: 1, incomplete: [], statementType: 'SELECT' } }))
    await flush()
    show(view)
    expect(gates[1]!.signal.aborted).toBe(true)
    gates[1]!.answer({ run: true })
    await moved
    expect(api.scriptObjects).toHaveBeenCalledTimes(2)
    // A prompt that fails runs nothing billed and offers the button again.
    show(table)
    pending.properties.at(-1)!(ok(tableFacts))
    await flush()
    const broken = service.readCreate('tab')
    pending.script[2]!(ok({ warnings: [], estimate: { bytesProcessed: 1, incomplete: [], statementType: 'SELECT' } }))
    await flush()
    gates[2]!.fail(new Error('prompt lost'))
    await broken
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'billed' })
    expect(api.scriptObjects).toHaveBeenCalledTimes(3)
  })

  it('ends a CREATE read when the pane hides during its prompt or the server goes during its estimate', async () => {
    const hidden = setup()
    hidden.show(table)
    hidden.pending.properties[0]!(ok(tableFacts))
    await flush()
    const read = hidden.service.readCreate('tab')
    hidden.pending.script[0]!(ok({ warnings: [], estimate: { bytesProcessed: 1, incomplete: [], statementType: 'SELECT' } }))
    await flush()
    hidden.service.setHidden(true)
    expect(hidden.gates[0]!.signal.aborted).toBe(true)
    hidden.gates[0]!.answer({ run: true })
    await read
    expect(hidden.api.scriptObjects).toHaveBeenCalledTimes(1)
    const lost = setup()
    lost.show(table)
    lost.pending.properties[0]!(ok(tableFacts))
    await flush()
    const estimating = lost.service.readCreate('tab')
    lost.lose()
    expect(lost.api.cancelScripting).toHaveBeenCalledWith(['id-2'])
    lost.pending.script[0]!(ok({ warnings: [], estimate: { bytesProcessed: 1, incomplete: [], statementType: 'SELECT' } }))
    await estimating
    expect(lost.gates).toEqual([])
    expect(lost.api.scriptObjects).toHaveBeenCalledTimes(1)
    expect(lost.service.getSnapshot().documents.tab?.definition).toMatchObject({ status: 'error' })
  })

  it('offers no billed read without the cost prompts, for kinds Script As cannot write, or once the connection is lost', async () => {
    const ungated = setup({ gate: false })
    ungated.show(table)
    ungated.pending.properties[0]!(ok(tableFacts))
    await flush()
    expect(ungated.service.getSnapshot().documents.tab?.definition).toEqual({ status: 'none' })
    expect(ungated.service.canReadCreate('tab')).toBe(false)
    await ungated.service.readCreate('tab')
    expect(ungated.api.scriptObjects).not.toHaveBeenCalled()
    const { service, show, api, pending, lose } = setup()
    expect(bigQueryDetailKind(model.object)).toBeUndefined()
    show(model)
    expect(api.bigQueryProperties).not.toHaveBeenCalled()
    // Models are not scriptable: no billed CREATE either.
    expect(service.getSnapshot().documents.tab?.definition.status).toBe('none')
    show(table)
    pending.properties[0]!(ok(tableFacts))
    await flush()
    lose()
    expect(service.getSnapshot().documents.tab).toMatchObject({ lost: true, definition: { status: 'error' } })
    expect(service.canReadCreate('tab')).toBe(false)
  })

  it('says why the facts could not be read, and still offers the billed CREATE', async () => {
    const { service, show, pending } = setup()
    show(table)
    pending.properties[0]!({ ok: false, error: 'Table varia-alpha.sales.orders no longer exists.', code: 'NOT_FOUND' })
    await flush()
    expect(service.getSnapshot().documents.tab).toMatchObject({ bigQuery: { status: 'error', message: 'Table varia-alpha.sales.orders no longer exists.' }, definition: { status: 'billed' } })
  })
})
