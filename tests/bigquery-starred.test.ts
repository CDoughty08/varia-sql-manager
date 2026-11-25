import { describe, expect, it, vi } from 'vitest'
import type { BigQueryStarredProjectsView } from '../src/shared/bigquery-connections'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { BigQueryStarredService, bigQueryReferenceScanLimits, referencedBigQueryProjects } from '../src/renderer/src/services/bigquery-starred'

const ada = 'bigquery:user:ada@example.com'
const grace = 'bigquery:user:grace@example.com'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('BigQueryStarredService', () => {
  it('loads starred projects per principal and notifies subscribers', async () => {
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [ada]: ['varia-beta', 'bigquery-public-data'] } } })),
      setBigQueryProjectStar: vi.fn()
    }
    const service = new BigQueryStarredService({ api })
    const listener = vi.fn()
    const stop = service.subscribe(listener)
    expect(service.starredFor(ada)).toEqual([])
    expect(service.starredFor(undefined)).toEqual([])
    expect(service.isStarred(ada, 'varia-beta')).toBe(false)
    await service.load()
    expect(service.starredFor(ada)).toEqual(['varia-beta', 'bigquery-public-data'])
    expect(service.isStarred(ada, 'varia-beta')).toBe(true)
    expect(service.isStarred(grace, 'varia-beta')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    service.dispose()
  })

  it('applies optimistic updates on setStarred and rolls back on persistence failure', async () => {
    const save = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [ada]: ['varia-beta'] } } })),
      setBigQueryProjectStar: vi.fn(() => save.promise)
    }
    const service = new BigQueryStarredService({ api })
    await service.load()
    const pending = service.setStarred(ada, 'bigquery-public-data', true)
    // Optimistically visible immediately before IPC settles.
    expect(service.starredFor(ada)).toEqual(['varia-beta', 'bigquery-public-data'])
    expect(service.isStarred(ada, 'bigquery-public-data')).toBe(true)
    save.resolve({ ok: false, error: 'Disk full.' })
    expect(await pending).toEqual({ ok: false, error: 'Disk full.' })
    // Rolled back on error.
    expect(service.starredFor(ada)).toEqual(['varia-beta'])
    expect(service.isStarred(ada, 'bigquery-public-data')).toBe(false)

    // Successful unstar removes the project and reconciles with main's authoritative snapshot.
    api.setBigQueryProjectStar = vi.fn(async () => ({ ok: true as const, value: { byPrincipal: {} } }))
    const unstar = await service.setStarred(ada, 'varia-beta', false)
    expect(unstar).toEqual({ ok: true, value: { byPrincipal: {} } })
    expect(service.starredFor(ada)).toEqual([])
    service.dispose()
  })

  it('does not let an earlier load overwrite a newer optimistic mutation', async () => {
    const initialLoad = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(() => initialLoad.promise),
      setBigQueryProjectStar: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [ada]: ['bigquery-public-data'] } } }))
    }
    const service = new BigQueryStarredService({ api })
    const loading = service.load()
    await service.setStarred(ada, 'bigquery-public-data', true)
    initialLoad.resolve({ ok: true, value: { byPrincipal: {} } })
    await loading
    expect(service.starredFor(ada)).toEqual(['bigquery-public-data'])
    service.dispose()
  })
  it('does not leave ghost starred projects when concurrent mutations both fail and tolerates IPC rejections', async () => {
    const first = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const second = deferred<ApiResult<BigQueryStarredProjectsView>>()
    let call = 0
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => { throw new Error('IPC offline') }),
      setBigQueryProjectStar: vi.fn(() => (++call === 1 ? first.promise : second.promise))
    }
    const service = new BigQueryStarredService({ api })
    await service.load()
    expect(service.loaded).toBe(true)
    expect(service.starredFor('toString')).toEqual([])
    expect(service.isStarred('toString', 'x')).toBe(false)

    const p1 = service.setStarred(ada, 'proj-alpha', true)
    const p2 = service.setStarred(ada, 'proj-beta', true)
    expect(service.starredFor(ada)).toEqual(['proj-alpha', 'proj-beta'])
    first.resolve({ ok: false, error: 'Fail 1' })
    second.resolve({ ok: false, error: 'Fail 2' })
    expect(await p1).toEqual({ ok: false, error: 'Fail 1' })
    expect(await p2).toEqual({ ok: false, error: 'Fail 2' })
    // Neither mutation persisted: both rolled back cleanly with no ghost entry.
    expect(service.starredFor(ada)).toEqual([])
    service.dispose()
  })
})

describe('referencedBigQueryProjects', () => {
  it('extracts 3-part BigQuery project IDs across backticked, unquoted, dashed, domain-scoped, digit-dataset, SAFE., DML, DDL and comma-FROM forms', () => {
    const sql = [
      'SELECT a.id, `udf-project-1`.funcs.normalize(a.name), SAFE.safe-proj-9.funcs.parse(a.name)',
      'FROM `bigquery-public-data.samples.shakespeare` AS a',
      'JOIN `example.com:domain-proj.sales.orders` o ON o.id = a.id',
      'LEFT JOIN `other-proj-2`.analytics.events e ON e.id = a.id',
      'INNER JOIN `partial-proj.ds`.items i ON i.id = a.id',
      ', comma-proj-3.metrics.daily d',
      'JOIN dashed-proj-4.raw.logs l ON l.id = a.id;',
      'SELECT * FROM UNNEST(arr) AS x, unnest-proj-8.2026_sales.orders;',
      'SELECT * FROM digit-proj-1.2026_sales.orders;',
      'INSERT insert-proj-10.staging.out VALUES (1);',
      'INSERT INTO `target-proj-5.staging.out` SELECT * FROM `bigquery-public-data.samples.shakespeare`;',
      'CALL `proc-proj-6.ops.refresh`();',
      'SELECT * FROM `info-proj-7`.region-us.INFORMATION_SCHEMA.TABLES;'
    ].join('\n')
    expect(referencedBigQueryProjects(sql)).toEqual([
      'udf-project-1',
      'safe-proj-9',
      'bigquery-public-data',
      'example.com:domain-proj',
      'other-proj-2',
      'partial-proj',
      'comma-proj-3',
      'dashed-proj-4',
      'unnest-proj-8',
      'digit-proj-1',
      'insert-proj-10',
      'target-proj-5',
      'proc-proj-6',
      'info-proj-7'
    ])
  })

  it('skips comments, string literals, struct field access and EXTRACT(… FROM …)', () => {
    const sql = [
      '-- FROM `comment-dash-proj.ds.tbl`',
      '# FROM `comment-hash-proj.ds.tbl`',
      '/* JOIN `comment-block-proj.ds.tbl` */',
      "SELECT 'FROM `single-str-proj.ds.tbl`',",
      '  "FROM `double-str-proj.ds.tbl`",',
      "  r'''FROM `triple-str-proj.ds.tbl`''',",
      '  customer.address.city,',
      '  EXTRACT(YEAR FROM orders.placed.ts)',
      'FROM `real-project-1.sales.orders`;'
    ].join('\n')
    expect(referencedBigQueryProjects(sql)).toEqual(['real-project-1'])
  })

  it('bounds scanning to 256 KiB and at most 20 unique valid projects', () => {
    const many = Array.from({ length: 30 }, (_, index) => `SELECT * FROM \`proj-num-${String(index).padStart(2, '0')}.ds.t\`;`).join('\n')
    const found = referencedBigQueryProjects(many)
    expect(found).toHaveLength(bigQueryReferenceScanLimits.maxProjects)
    expect(found[0]).toBe('proj-num-00')
    expect(found[19]).toBe('proj-num-19')

    const padding = ' '.repeat(bigQueryReferenceScanLimits.maxChars)
    expect(referencedBigQueryProjects(`${padding}SELECT * FROM \`beyond-cap-proj.ds.t\`;`)).toEqual([])
    expect(referencedBigQueryProjects('SELECT * FROM `Invalid_Project.ds.t` JOIN `short.ds.t`;')).toEqual([])
  })
})
