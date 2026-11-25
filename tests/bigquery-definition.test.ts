// Go To Definition in a BigQuery tab (docs/language-services.md, Go To Definition): the index lookup behind it
// (IndexCompletionService.definition) and F12's opener, which reads only bigquery.properties' free definition.
import { describe, expect, it, vi } from 'vitest'
import type { BigQueryProperties } from '../src/shared/bigquery/objects'
import type { ApiResult } from '../src/shared/contracts'
import type { LanguageLookupPath, LanguageLookupResult } from '../src/shared/language-lookup'
import { languageLimits } from '../src/shared/language-service'
import { indexDefinitionOpener } from '../src/renderer/src/languages/bigquery-definition'
import { definitionErrors } from '../src/renderer/src/languages/definition'
import { IndexCompletionService, type FoundIndexObject } from '../src/renderer/src/languages/IndexCompletionService'

const connectionId = '11111111-1111-4111-8111-111111111111'
const daily: FoundIndexObject = { connectionId, kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }

describe('F12\'s BigQuery definition opener', () => {
  function opener(answer: ApiResult<Partial<BigQueryProperties>>) {
    const api = { bigQueryProperties: vi.fn(async () => answer as ApiResult<BigQueryProperties>) }
    const documents = { newQuery: vi.fn() }
    const opened = vi.fn()
    const connections = { get: () => ({ server: 'varia-alpha', database: 'staging' }) }
    return { api, documents, opened, open: indexDefinitionOpener({ api, documents: documents as never, connections, newId: () => 'request-1', opened }) }
  }

  it('opens the free definition in a new query on the tab\'s connection, in the object\'s dataset', async () => {
    const f = opener({ ok: true, value: { definition: 'SELECT day, COUNT(*) AS n FROM sales.orders GROUP BY day' } })
    expect(await f.open(daily)).toBe('opened')
    expect(f.api.bigQueryProperties).toHaveBeenCalledWith({ connectionId, requestId: 'request-1', kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' })
    expect(f.documents.newQuery).toHaveBeenCalledWith('SELECT day, COUNT(*) AS n FROM sales.orders GROUP BY day', undefined, connectionId, 'sales', false)
    expect(f.opened).toHaveBeenCalledTimes(1)
    // An object in another project opens on the connection's own default dataset, as Properties' Open in New Query does.
    await f.open({ ...daily, project: 'varia-beta' })
    expect(f.documents.newQuery).toHaveBeenLastCalledWith(expect.any(String), undefined, connectionId, 'staging', false)
  })

  it('says when the text was cut, opens nothing without a stored definition, and throws a failed read', async () => {
    expect(await opener({ ok: true, value: { definition: 'SELECT 1', definitionTruncated: true } }).open(daily)).toBe('cut')
    expect(await opener({ ok: true, value: { definition: 'SELECT 1', definitionCut: true } }).open(daily)).toBe('cut')
    const none = opener({ ok: true, value: {} })
    expect(await none.open({ ...daily, kind: 'bqRoutine', name: 'remote_fn' })).toBe('none')
    expect(none.documents.newQuery).not.toHaveBeenCalled()
    await expect(opener({ ok: false, error: 'Not found: Table varia-alpha:sales.daily' }).open(daily)).rejects.toThrow('Not found: Table varia-alpha:sales.daily')
    // A kind bigquery.properties does not answer is never asked about.
    const model = opener({ ok: true, value: {} })
    expect(await model.open({ ...daily, kind: 'bqModel' })).toBe('none')
    expect(model.api.bigQueryProperties).not.toHaveBeenCalled()
  })
})

describe('IndexCompletionService.definition', () => {
  function service(options: { live?: boolean; text?: string } = {}) {
    const text = options.text ?? 'SELECT * FROM daily'
    const model = {
      getLanguageId: () => 'googlesql', getValue: () => text, getValueLength: () => text.length, getVersionId: () => 1, isDisposed: () => false,
      getOffsetAt: (position: { column: number }) => position.column - 1
    }
    const document = { id: 'q1', kind: 'sql', connectionId: options.live === false ? undefined : connectionId, database: 'sales' }
    const documents = { getSnapshot: () => ({ documents: [document] }), getModel: () => model, get: () => document, subscribe: () => () => {} }
    const connection = { id: connectionId, generation: 1, server: 'varia-alpha', providerId: 'bigquery' }
    const connections = { get: () => connection, getSnapshot: () => [connection], subscribe: () => () => {} }
    const requests: LanguageLookupPath[][] = []
    const api = {
      languageLookup: vi.fn(async ({ requests: asked }: { requests: LanguageLookupPath[] }): Promise<ApiResult<LanguageLookupResult>> => {
        requests.push(asked)
        return { ok: true, value: { index: 'ready', answers: asked.map(request => request.path.join('.') === 'varia-alpha.sales.daily'
          ? { state: 'ready' as const, path: [...request.path], items: [], truncated: false, object: { name: 'daily', kind: 'bqView', detailed: true } }
          : { state: 'ready' as const, path: request.path.slice(0, 2), items: [], truncated: false }) } }
      })
    }
    const monaco = { languages: { registerCompletionItemProvider: () => ({ dispose() {} }), registerHoverProvider: () => ({ dispose() {} }) } }
    const indexed = new IndexCompletionService(monaco as never, api as never, documents as never, connections as never, { ensureIndex: vi.fn() })
    return { indexed, model, api, requests }
  }

  it('resolves the name at the caret through the index, with the tab\'s default project and dataset', async () => {
    const f = service()
    expect(await f.indexed.definition(f.model as never, { lineNumber: 1, column: 17 } as never)).toEqual(daily)
    expect(f.requests.flat()).toContainEqual({ path: ['varia-alpha', 'sales', 'daily'], limit: 1 })
    const other = service({ text: 'SELECT * FROM nobody' })
    expect(await other.indexed.definition(other.model as never, { lineNumber: 1, column: 17 } as never)).toBeNull()
    // An answer no longer wanted is dropped.
    expect(await f.indexed.definition(f.model as never, { lineNumber: 1, column: 17 } as never, () => false)).toBeUndefined()
  })

  it('says the index could not answer when its lookup fails, rather than that nothing was found', async () => {
    const f = service()
    f.api.languageLookup.mockResolvedValueOnce({ ok: false, error: 'The backend is not running.' })
    await expect(f.indexed.definition(f.model as never, { lineNumber: 1, column: 17 } as never)).rejects.toThrow(definitionErrors.indexUnavailable)
  })

  it('refuses a disconnected tab or a query too large, before asking the index', async () => {
    const offline = service({ live: false })
    await expect(offline.indexed.definition(offline.model as never, { lineNumber: 1, column: 17 } as never)).rejects.toThrow(definitionErrors.connectBigQueryFirst)
    const large = service({ text: 'x'.repeat(languageLimits.documentCharacters + 1) })
    await expect(large.indexed.definition(large.model as never, { lineNumber: 1, column: 1 } as never)).rejects.toThrow(definitionErrors.tooLarge)
    for (const f of [offline, large]) expect(f.api.languageLookup).not.toHaveBeenCalled()
  })
})
