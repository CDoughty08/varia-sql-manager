import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { methodAllows, methodPolicies, optionsAllow } from '../src/shared/ipc/methods'
import { backendDescriptorSchema } from '../src/shared/ipc/descriptors'
import { queryEventSchema, resultMemoryDetailSchema } from '../src/shared/ipc/port-messages'
import { resultRows, rowsFact } from '../src/renderer/src/results/status'
import { nerdMetrics } from '../src/renderer/src/results/memory-details'
import type { ResultMemoryDetail } from '../src/shared/contracts'

// Remote BigQuery results (docs/bigquery.md, Residence): results.remoteQuery's contract in main, the residence settings
// main refuses for SQL Server, the descriptor's residence fields and the resultSet.residence event, the caption, and the
// window cache in the Memory panel. The backend's own checks are BigQueryExecutionChecks.Residence.cs.
describe('BigQuery remote results', () => {
  const load = { queryId: crypto.randomUUID(), resultId: 7, generation: 1, kind: 'load' }

  it('takes results.remoteQuery strictly: a query id, an owned result and its generation, and only the load kind', () => {
    expect(validateRequest('results.remoteQuery', load)).toEqual(load)
    for (const patch of [{ kind: 'view' }, { kind: 'sample' }, { queryId: 'not-a-uuid' }, { resultId: 0 }, { generation: 0 }, { generation: 2 ** 31 }, { extra: true }])
      expect(() => validateRequest('results.remoteQuery', { ...load, ...patch }), JSON.stringify(patch)).toThrow('Invalid request')
    expect(() => validateRequest('results.remoteQuery', { queryId: load.queryId, resultId: 7, kind: 'load' })).toThrow('Invalid request')
  })

  it('serves results.remoteQuery for BigQuery only, on the query lane, as long as it takes', () => {
    expect(methodPolicies['results.remoteQuery']).toMatchObject({ kind: 'unary', lane: 'query', deadlineMs: 0, providers: ['bigquery'] })
    expect(methodAllows('results.remoteQuery', 'bigquery')).toBe(true)
    expect(methodAllows('results.remoteQuery', 'sqlserver')).toBe(false)
  })

  it('checks the result is owned in its generation before sending a remote query (index.ts)', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const owned = source.indexOf("if (remote && !results.owns(remote.generation, remote.resultId)) return failure(new BackendError('RESULT_UNAVAILABLE'")
    const sent = source.indexOf('result = await backend.request(method as RpcMethod')
    expect(owned).toBeGreaterThan(0)
    expect(owned).toBeLessThan(sent)
    // Its events and summary go the way query.execute's do, pinned to the generation named.
    expect(source).toContain("const queryId = method === 'query.execute' ? (validated as RpcMethods['query.execute']['params']).queryId : remote?.queryId")
    expect(source).toContain('remote ? { generation: remote.generation }')
  })

  it('sends the residence settings only with BigQuery queries, within their bounds', () => {
    const base = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), sql: 'SELECT 1', maxRows: 0, timeoutSeconds: 0 }
    expect(validateRequest('query.execute', { ...base, residence: 'windowed', windowCacheMiB: 64 })).toMatchObject({ residence: 'windowed', windowCacheMiB: 64 })
    for (const patch of [{ residence: 'disk' }, { windowCacheMiB: 15 }, { windowCacheMiB: 4097 }, { windowCacheMiB: 64.5 }])
      expect(() => validateRequest('query.execute', { ...base, ...patch }), JSON.stringify(patch)).toThrow('Invalid request')
    expect(optionsAllow('query.execute', 'bigquery', { ...base, residence: 'memory', windowCacheMiB: 128 })).toBe(true)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, residence: 'memory' })).toBe(false)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, windowCacheMiB: 128 })).toBe(false)
  })

  it('reads the residence fields of a descriptor and the residence event, strictly', () => {
    const descriptor = {
      resultId: 3, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [{ name: 'n', dataType: 'INT64', wire: 'text', nullable: true }],
      rowsRead: 500, rowsStored: 0, rowsAvailable: 2_147_483_647, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false
    }
    const remote = { ...descriptor, residence: 'remote', rowsTotal: 3_000_000_000, revision: 1 }
    expect(backendDescriptorSchema.safeParse(descriptor).success).toBe(true)
    expect(backendDescriptorSchema.safeParse(remote).success).toBe(true)
    expect(backendDescriptorSchema.safeParse({ ...remote, residence: 'disk' }).success).toBe(false)
    expect(backendDescriptorSchema.safeParse({ ...remote, revision: -1 }).success).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'resultSet.residence', descriptor: remote }).success).toBe(true)
    // The event always says where the rows now are and under which revision.
    expect(queryEventSchema.safeParse({ type: 'resultSet.residence', descriptor }).success).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'resultSet.residence', descriptor: { ...remote, revision: undefined } }).success).toBe(false)
  })

  it('says in the caption that a result is windowed in BigQuery', () => {
    expect(rowsFact({ rowsAvailable: 5_000_000, state: 'complete', residence: 'remote' })).toBe('5,000,000 rows · windowed in BigQuery')
    expect(rowsFact({ rowsAvailable: 1, state: 'complete', residence: 'memory' })).toBe('1 row')
    expect(rowsFact({ rowsAvailable: 2, state: 'open' })).toBe('2 rows')
  })

  it('shows the window cache in the Memory panel, apart from the rows as read', () => {
    const MB = 1048576
    const off = { pagesPacked: 0, pagesUnpacked: 0, packInputBytes: 0, packMicroseconds: 0, unpackOutputBytes: 0, unpackMicroseconds: 0, cacheHits: 0, cacheLookups: 0, lastUnpackMicroseconds: 0 }
    const detail: ResultMemoryDetail = {
      logicalBytes: 100 * MB, storedBytes: 100 * MB, compressedBytes: 0, packedLogicalBytes: 0, cacheBytes: 0, largest: [], codec: off,
      heap: { committedBytes: 512 * MB, freeBytes: 40 * MB }, windowCacheBytes: 64 * MB
    }
    expect(resultMemoryDetailSchema.safeParse(detail).success).toBe(true)
    expect(resultMemoryDetailSchema.safeParse({ ...detail, windowCacheBytes: -1 }).success).toBe(false)
    const model = nerdMetrics(detail, () => ({ result: 'Result 1' }))
    expect(model.memoryBytes).toBe(164 * MB)
    expect(model.givenBack).toBe(0)
    expect(model.bars[1].segments.map(segment => [segment.part, segment.label, segment.bytes])).toEqual([['raw', 'Raw pages', 100 * MB], ['window', 'Window cache', 64 * MB]])
    expect(model.legend.map(segment => segment.part)).toEqual(['raw', 'window'])
    // Beside rows compression gave back, the bar's parts still fit its width: "Given back" is never cut off.
    const packed = nerdMetrics({ ...detail, storedBytes: 30 * MB, compressedBytes: 30 * MB, packedLogicalBytes: 100 * MB, windowCacheBytes: 20 * MB }, () => ({ result: 'Result 1' }))
    const now = packed.bars[1].segments
    expect(now.map(segment => [segment.part, segment.bytes])).toEqual([['packed', 30 * MB], ['window', 20 * MB], ['returned', 70 * MB]])
    expect(now.reduce((sum, segment) => sum + segment.share, 0)).toBeLessThanOrEqual(1 + 1e-9)
    expect(packed.bars[0].segments.reduce((sum, segment) => sum + segment.share, 0)).toBeLessThanOrEqual(1 + 1e-9)
    // A backend without windowed results reports none, and nothing changes.
    const { windowCacheBytes: _, ...plain } = detail
    expect(nerdMetrics(plain, () => ({ result: 'Result 1' })).bars[1].segments.map(segment => segment.part)).toEqual(['raw'])
    // Only windowed results open: no rows in pages, but the window cache holds blocks, and the Saved tile says so.
    const windowedOnly = nerdMetrics({ ...detail, logicalBytes: 0, storedBytes: 0 }, () => ({ result: 'Result 1' }))
    expect(windowedOnly.tiles[2].note).toBe('Only windowed results\' blocks held')
    expect(nerdMetrics({ ...detail, logicalBytes: 0, storedBytes: 0, windowCacheBytes: 0 }, () => ({ result: 'Result 1' })).tiles[2].note).toBe('No rows held')
  })
})

describe('row counts of a windowed result', () => {
  it('counts the rows its grid can read, in Compare and Pivot too', () => {
    expect(resultRows({ residence: 'remote', rowsStored: 0, rowsAvailable: 1_000_000 })).toBe(1_000_000)
    expect(resultRows({ residence: 'memory', rowsStored: 40, rowsAvailable: 30 })).toBe(40)
    expect(resultRows({ rowsStored: 40, rowsAvailable: 30 })).toBe(40)
    for (const panel of ['ComparePopover.tsx', 'PivotPanel.tsx']) {
      const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'results', panel), 'utf8')
      expect(source, panel).not.toMatch(/\.rowsStored\b/)
      expect(source, panel).toMatch(/resultRows\(entry\.handle\.getSnapshot\(\)\)/)
    }
  })
})

describe('Load into memory and the query that made the result', () => {
  it('waits for that query to end: its budget is marked executing until every set is final', () => {
    const execution = readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'SqlService.BigQueryExecution.cs'), 'utf8')
    expect(execution).toMatch(/budget = store\.BeginQuery\(args\.SessionId\);\n\s*budget\.Executing = true;/)
    expect(execution).toMatch(/set\.Complete\(\);\n\s*events\.Closed\(set\);\n\s*\}\n(?:\s*\/\/[^\n]*\n)*\s*if \(budget is not null\) budget\.Executing = false;/)
    const residence = readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'SqlService.BigQueryResidence.cs'), 'utf8')
    expect(residence.indexOf('if (set.Budget.Executing) throw new RequestException("BUSY"')).toBeGreaterThan(0)
    expect(residence.indexOf('if (set.Budget.Executing) throw new RequestException("BUSY"')).toBeLessThan(residence.indexOf('set.Promote(window.TotalRows)'))
  })
})

describe('decoding a windowed result on several threads', () => {
  it('gives each block fetch and each load its own fork of the column plan, whose buffers are not shared', () => {
    const residence = readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'SqlService.BigQueryResidence.cs'), 'utf8')
    const fetch = residence.slice(residence.indexOf('private RemoteFetch BigQueryFetch('), residence.indexOf('};', residence.indexOf('private RemoteFetch BigQueryFetch(')))
    expect(fetch).toMatch(/var plan = context\.Plan\.Fork\(\);/)
    expect(fetch).not.toMatch(/context\.Plan\b(?!\.Fork\(\))/)
    // Outside the query's own thread (deciding residence and seeding run on it) the window's plan is only ever forked.
    expect(residence).not.toMatch(/window\.Plan, first, set,/)
    expect(residence).toMatch(/window\.Plan\.Fork\(\), first, set,/)
  })
})

describe('the backend comments that point into docs/bigquery.md', () => {
  it('name its headings or bold bullets ("docs/bigquery.md, Residence: Deciding"), so a renamed section is caught', () => {
    const docs = readFileSync(join(__dirname, '..', 'docs', 'bigquery.md'), 'utf8')
    const named = new Set([...docs.matchAll(/^#+ (.+)$/gm), ...docs.matchAll(/\*\*([^*]+?)\.\*\*/g)].map(match => match[1].trim()))
    const root = join(__dirname, '..', 'backend')
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.cs') && !/(^|[\\/])(bin|obj)[\\/]/.test(name))
    const missing = files.flatMap(name => [...readFileSync(join(root, name), 'utf8').matchAll(/docs\/bigquery\.md, ([^);\n]*)/g)]
      .flatMap(match => match[1].split(/[,:]\s*/).map(part => part.trim()).filter(part => part && !/^decision \d+$/.test(part)).filter(part => !named.has(part))
        .map(part => `${name.replaceAll('\\', '/')}: ${part}`)))
    expect(named.has('Residence') && named.has('Deciding') && named.has('Throughput')).toBe(true)
    expect(missing).toEqual([])
  })
  it('say tabledata.list leaves a rate limit to the block\'s own backoff', () => {
    const jobs = readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'BigQuery', 'BigQueryService.Jobs.cs'), 'utf8')
    expect(jobs).not.toMatch(/429 and 5xx are retried/)
    expect(jobs).toMatch(/return PageAsync\(service, request\.CreateRequest\(\), t\);\n\s*\}, token, rateLimits: false\);/)
  })
})
