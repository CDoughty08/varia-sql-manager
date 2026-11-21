import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { BigQueryProperties } from '../src/shared/bigquery/objects'
import { BigQueryPropertiesService } from '../src/renderer/src/explorer/BigQueryPropertiesService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { deferred } from './fixtures/documents'

// BigQuery's Properties tab (docs/bigquery.md, Properties): one tables.get per read, an older read's answer dropped, a closed tab forgotten.
const node = (kind: string, patch: Partial<ExplorerMenuNode> = {}): ExplorerMenuNode =>
  ({ id: 1, connectionId: 'bq-1', lost: false, kind, label: 'orders', ref: { type: 'object', object: { kind, project: 'varia-alpha', dataset: 'sales', name: 'orders' } }, ...patch }) as ExplorerMenuNode
const facts = (rows: string): BigQueryProperties => ({ name: 'orders', type: 'table', elapsedMs: 1, groups: [{ title: 'Storage', facts: [{ label: 'Rows', value: rows }] }] })

function setup() {
  const replies: ReturnType<typeof deferred<ApiResult<BigQueryProperties>>>[] = []
  const api = { bigQueryProperties: vi.fn<VariaApi['bigQueryProperties']>(() => { replies.push(deferred()); return replies.at(-1)!.promise }) }
  let ids = 0
  const documents = { openCustom: vi.fn(() => ({ id: `doc-${++ids}` })), registerProvider: vi.fn(() => ({ dispose: vi.fn() })) }
  const service = new BigQueryPropertiesService({ api, documents: documents as never })
  return { service, api, documents, replies }
}

describe('BigQuery Properties', () => {
  it('opens for table-like objects only, live, and reads tables.get for the object', async () => {
    const { service, api, documents } = setup()
    expect(service.canOpen(node('bqTable'))).toBe(true)
    expect(service.canOpen(node('bqExternalTable'))).toBe(true)
    expect(service.canOpen(node('bqRoutine'))).toBe(false)
    expect(service.canOpen(node('bqTable', { lost: true }))).toBe(false)
    expect(service.canOpen(node('table'))).toBe(false)
    expect(service.open(node('bqRoutine'))).toBeUndefined()
    const id = service.open(node('bqView'))!
    expect(documents.openCustom).toHaveBeenCalledWith('bigQueryProperties', 'orders', 'bq-1', 'sales')
    expect(api.bigQueryProperties).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'bq-1', kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'orders' }))
    expect(service.view(id)).toMatchObject({ loading: true })
  })

  it('keeps only the newest read, shows a failure, and forgets a closed tab', async () => {
    const { service, replies } = setup()
    const id = service.open(node('bqTable'))!
    void service.refresh(id)
    // The newer read answers first; the older one's late answer is dropped.
    replies[1].resolve({ ok: true, value: facts('2') })
    await Promise.resolve(); await Promise.resolve()
    replies[0].resolve({ ok: true, value: facts('1') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toMatchObject({ loading: false, value: facts('2') })
    void service.refresh(id)
    replies[2].resolve({ ok: false, error: 'Access Denied', code: 'PERMISSION_DENIED' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toMatchObject({ loading: false, error: 'Access Denied', value: facts('2') })
    // A tab closed while its read runs is not brought back by the answer.
    void service.refresh(id)
    service.closed(id)
    replies[3].resolve({ ok: true, value: facts('3') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.view(id)).toBeUndefined()
  })
})
