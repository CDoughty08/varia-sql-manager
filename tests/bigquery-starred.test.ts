import { describe, expect, it, vi } from 'vitest'
import type { BigQueryStarredProjectsView } from '../src/shared/bigquery-connections'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { BigQueryStarredService, bigQueryReferenceScanLimits, bindBigQueryExplorerSync, referencedBigQueryProjects } from '../src/renderer/src/services/bigquery-starred'

const ada = 'bigquery:user:ada@example.com'
const grace = 'bigquery:user:grace@example.com'
const connAda = '00000000-0000-4000-8000-000000000001'
const connGrace = '00000000-0000-4000-8000-000000000002'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('BigQueryStarredService', () => {
  it('loads starred projects per connection/principal, tracks per-principal load state, and notifies subscribers', async () => {
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async input => {
        const byPrincipal: Record<string, readonly string[]> = input?.connectionId === connGrace
          ? { [grace]: ['varia-gamma'] }
          : { [ada]: ['varia-beta', 'bigquery-public-data'] }
        return { ok: true as const, value: { byPrincipal } }
      }),
      setBigQueryProjectStar: vi.fn()
    }
    const service = new BigQueryStarredService({ api })
    const listener = vi.fn()
    const stop = service.subscribe(listener)
    expect(service.starredFor(ada)).toEqual([])
    expect(service.starredFor(undefined)).toEqual([])
    expect(service.isStarred(ada, 'varia-beta')).toBe(false)
    expect(service.isLoadedFor(ada)).toBe(false)
    await service.load(connAda, ada)
    expect(api.loadBigQueryStarredProjects).toHaveBeenCalledWith({ connectionId: connAda })
    expect(service.isLoadedFor(ada)).toBe(true)
    expect(service.isLoadedFor(grace)).toBe(false)
    expect(service.starredFor(ada)).toEqual(['varia-beta', 'bigquery-public-data'])
    expect(service.isStarred(ada, 'varia-beta')).toBe(true)
    expect(service.isConfirmedStarred(ada, 'varia-beta')).toBe(true)
    expect(service.isStarred(grace, 'varia-beta')).toBe(false)
    // Loading a second connection merges its principal without erasing the first principal.
    await service.load(connGrace, grace)
    expect(service.starredFor(ada)).toEqual(['varia-beta', 'bigquery-public-data'])
    expect(service.starredFor(grace)).toEqual(['varia-gamma'])
    expect(service.isLoadedFor(grace)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    service.dispose()
  })

  it('applies optimistic updates on setStarred (distinguishing confirmed vs pending) and rolls back on persistence failure', async () => {
    const save = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [ada]: ['varia-beta'] } } })),
      setBigQueryProjectStar: vi.fn(() => save.promise)
    }
    const service = new BigQueryStarredService({ api })
    await service.load(connAda, ada)
    const pending = service.setStarred(connAda, ada, 'bigquery-public-data', true)
    expect(api.setBigQueryProjectStar).toHaveBeenCalledWith({ connectionId: connAda, project: 'bigquery-public-data', starred: true })
    // Optimistically visible immediately before IPC settles, but not yet confirmed persisted.
    expect(service.starredFor(ada)).toEqual(['varia-beta', 'bigquery-public-data'])
    expect(service.isStarred(ada, 'bigquery-public-data')).toBe(true)
    expect(service.isConfirmedStarred(ada, 'bigquery-public-data')).toBe(false)
    expect(service.isConfirmedStarred(ada, 'varia-beta')).toBe(true)
    save.resolve({ ok: false, error: 'Disk full.' })
    expect(await pending).toEqual({ ok: false, error: 'Disk full.' })
    // Rolled back on error.
    expect(service.starredFor(ada)).toEqual(['varia-beta'])
    expect(service.isStarred(ada, 'bigquery-public-data')).toBe(false)

    // Successful unstar removes the project and reconciles with main's authoritative snapshot.
    api.setBigQueryProjectStar = vi.fn(async () => ({ ok: true as const, value: { byPrincipal: {} } }))
    const unstar = await service.setStarred(connAda, ada, 'varia-beta', false)
    expect(unstar).toEqual({ ok: true, value: { byPrincipal: {} } })
    expect(service.starredFor(ada)).toEqual([])
    expect(service.isConfirmedStarred(ada, 'varia-beta')).toBe(false)
    service.dispose()
  })

  it('does not let an earlier load overwrite a newer optimistic mutation', async () => {
    const initialLoad = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(() => initialLoad.promise),
      setBigQueryProjectStar: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [ada]: ['bigquery-public-data'] } } }))
    }
    const service = new BigQueryStarredService({ api })
    const loading = service.load(connAda, ada)
    await service.setStarred(connAda, ada, 'bigquery-public-data', true)
    initialLoad.resolve({ ok: true, value: { byPrincipal: {} } })
    await loading
    expect(service.starredFor(ada)).toEqual(['bigquery-public-data'])
    expect(service.isConfirmedStarred(ada, 'bigquery-public-data')).toBe(true)
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
    await service.load(connAda, ada)
    expect(service.isLoadedFor(ada)).toBe(true)
    expect(service.starredFor('toString')).toEqual([])
    expect(service.isStarred('toString', 'x')).toBe(false)

    const p1 = service.setStarred(connAda, ada, 'proj-alpha', true)
    const p2 = service.setStarred(connAda, ada, 'proj-beta', true)
    expect(service.starredFor(ada)).toEqual(['proj-alpha', 'proj-beta'])
    first.resolve({ ok: false, error: 'Fail 1' })
    second.resolve({ ok: false, error: 'Fail 2' })
    expect(await p1).toEqual({ ok: false, error: 'Fail 1' })
    expect(await p2).toEqual({ ok: false, error: 'Fail 2' })
    // Neither mutation persisted: both rolled back cleanly with no ghost entry.
    expect(service.starredFor(ada)).toEqual([])
    service.dispose()
  })

  it('prevents out-of-order setStarred resolutions from overwriting newer authoritative state', async () => {
    const first = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const second = deferred<ApiResult<BigQueryStarredProjectsView>>()
    let call = 0
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: {} } })),
      setBigQueryProjectStar: vi.fn(() => (++call === 1 ? first.promise : second.promise))
    }
    const service = new BigQueryStarredService({ api })
    await service.load(connAda, ada)
    const p1 = service.setStarred(connAda, ada, 'proj-alpha', true)
    const p2 = service.setStarred(connAda, ada, 'proj-beta', true)
    // Newer request settles first with both projects; older response arrives late with only proj-alpha.
    second.resolve({ ok: true, value: { byPrincipal: { [ada]: ['proj-alpha', 'proj-beta'] } } })
    await p2
    expect(service.starredFor(ada)).toEqual(['proj-alpha', 'proj-beta'])
    first.resolve({ ok: true, value: { byPrincipal: { [ada]: ['proj-alpha'] } } })
    await p1
    expect(service.starredFor(ada)).toEqual(['proj-alpha', 'proj-beta'])
    service.dispose()
  })

  it('notifies subscribers when load flips loaded on error and holds loaded until the latest load settles', async () => {
    const first = deferred<ApiResult<BigQueryStarredProjectsView>>()
    const second = deferred<ApiResult<BigQueryStarredProjectsView>>()
    let call = 0
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(() => (++call === 1 ? first.promise : second.promise)),
      setBigQueryProjectStar: vi.fn()
    }
    const service = new BigQueryStarredService({ api })
    const listener = vi.fn()
    service.subscribe(listener)
    const l1 = service.load(connAda, ada)
    const l2 = service.load(connAda, ada)
    // First load resolves while second is still in flight: isLoadedFor must remain false until l2 settles.
    first.resolve({ ok: true, value: { byPrincipal: { [ada]: ['proj-old'] } } })
    await l1
    expect(service.isLoadedFor(ada)).toBe(false)
    // Second load fails: isLoadedFor transitions to true and subscribers are notified so deferred Explorer restores release.
    second.resolve({ ok: false, error: 'Failed to read' })
    await l2
    expect(service.isLoadedFor(ada)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
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

  it('skips comments, string literals, struct field access, LIKE patterns, array literals in JOIN ON and EXTRACT(… FROM …)', () => {
    const sql = [
      '-- FROM `comment-dash-proj.ds.tbl`',
      '# FROM `comment-hash-proj.ds.tbl`',
      '/* JOIN `comment-block-proj.ds.tbl` */',
      "SELECT 'FROM `single-str-proj.ds.tbl`',",
      '  "FROM `double-str-proj.ds.tbl`",',
      "  r'''FROM `triple-str-proj.ds.tbl`''',",
      '  customer.address.city,',
      '  EXTRACT(YEAR FROM orders.placed.ts)',
      'FROM `real-project-1.sales.orders` t1',
      'JOIN t2 ON t1.arr = [t2.first, array-false-pos.profile.val]',
      'WHERE t1.email LIKE like-false-pos.profile.pattern',
      '  AND t1.code IS NOT DISTINCT FROM distinct-false-pos.profile.code;',
      'SELECT t1.x IS DISTINCT FROM t2.y, select-false-pos.address.city FROM `real-project-2.sales.orders` t1;',
      'SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS;',
      'SELECT * FROM analytics.INFORMATION_SCHEMA.TABLES;',
      'FROM `pipe-project-1.sales.orders` |> EXTEND 1 AS x, pipe-false-pos.address.city AS c;',
      'SELECT * FROM t1 JOIN t2 USING (id), using-comma-proj.sales.orders;',
      'SELECT * FROM order-service-prod.sales.orders JOIN options.sales.items ON true;',
      'CREATE OR REPLACE TEMP TABLE dst-create-proj.sales.copy LIKE like-src-proj.sales.orders;',
      'CREATE TABLE cluster-prod.sales.copy LIKE cluster-like-src.sales.orders;',
      'CREATE TABLE options-prod.sales.copy LIKE options-like-src.sales.orders;',
      'CREATE TABLE options LIKE opt-like-src.sales.orders;',
      'SELECT * FROM my_table options, opt-comma-proj.sales.orders;',
      "SELECT * FROM t1 PIVOT (SUM(sales) FOR quarter IN ('Q1', 'Q2')) AS p, comma-pivot-proj.sales.orders;",
      'SELECT * FROM t1 UNPIVOT (val FOR col IN (q1, q2)) AS u, comma-unpivot-proj.sales.orders;',
      "EXECUTE IMMEDIATE 'SELECT ?' USING payload.customer.email;",
      'MERGE merge-dst-proj.sales.t USING merge-src-proj.sales.s ON true WHEN MATCHED THEN DELETE;',
      'DELETE del-direct-proj.sales.orders WHERE id = 1;'
    ].join('\n')
    expect(referencedBigQueryProjects(sql)).toEqual([
      'real-project-1',
      'real-project-2',
      'pipe-project-1',
      'using-comma-proj',
      'order-service-prod',
      'options',
      'dst-create-proj',
      'like-src-proj',
      'cluster-prod',
      'cluster-like-src',
      'options-prod',
      'options-like-src',
      'opt-like-src',
      'opt-comma-proj',
      'comma-pivot-proj',
      'comma-unpivot-proj',
      'merge-dst-proj',
      'merge-src-proj',
      'del-direct-proj'
    ])
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

  it('excludes earlier FROM table aliases used in comma-FROM and correlated JOIN implicit UNNEST paths from referenced projects', () => {
    const sql = [
      'SELECT item',
      'FROM `billing-proj.sales.orders` AS orders, orders.payload.items AS item;',
      'SELECT i FROM `billing-proj-2.sales.orders`, orders.payload.items AS i;',
      'SELECT t FROM `billing-proj-3.sales.orders` order_rows, UNNEST(order_rows.items) AS line_items, line_items.nested.tags AS t;',
      'SELECT item FROM `billing-proj-5.sales.orders` AS orders CROSS JOIN orders.payload.items AS item LEFT JOIN item.nested.tags AS tag;',
      'SELECT * FROM `billing-proj-4.sales.orders` AS orders, `real-other-proj.sales.customers` AS customers;'
    ].join('\n')
    expect(referencedBigQueryProjects(sql)).toEqual([
      'billing-proj',
      'billing-proj-2',
      'billing-proj-3',
      'billing-proj-5',
      'billing-proj-4',
      'real-other-proj'
    ])
  })
})

describe('bindBigQueryExplorerSync', () => {
  it('loads starred projects per verified live connection and detects newly typed project references while editing', () => {
    vi.useFakeTimers()
    try {
      const connListeners = new Set<() => void>()
      const docListeners = new Set<() => void>()
      const eventListeners = new Set<(event: { readonly type: string; readonly tabId?: string }) => void>()
      let contentListeners = new Set<() => void>()
      let sql = 'SELECT '
      let version = 1
      let live = true
      const model = {
        getValue: () => sql,
        getAlternativeVersionId: () => version,
        onDidChangeContent: (listener: () => void) => {
          contentListeners.add(listener)
          return { dispose: () => { contentListeners.delete(listener) } }
        }
      }
      const doc = { id: 'tab-1', kind: 'sql', connectionId: connAda }
      const syncBigQueryReferencedProjects = vi.fn()
      const loadStarred = vi.fn()
      const binding = bindBigQueryExplorerSync({
        connections: {
          liveBigQuery: () => live ? [{ id: connAda, principalId: ada }] : [],
          isLiveBigQuery: id => live && id === connAda,
          subscribe: listener => { connListeners.add(listener); return () => connListeners.delete(listener) }
        },
        documents: {
          getSnapshot: () => ({ documents: [doc] }),
          get: id => id === doc.id ? doc : undefined,
          getModel: id => id === doc.id ? model : undefined,
          subscribe: listener => { docListeners.add(listener); return () => docListeners.delete(listener) }
        },
        events: {
          subscribe: listener => { eventListeners.add(listener); return { dispose: () => { eventListeners.delete(listener) } } }
        },
        explorer: { syncBigQueryReferencedProjects },
        loadStarred,
        debounceMs: 400
      })

      // Initial connection triggers verified per-connection starred load and initial scan of 'SELECT ' (no projects yet).
      for (const listener of connListeners) listener()
      expect(loadStarred).toHaveBeenCalledExactlyOnceWith(connAda, ada)
      expect(syncBigQueryReferencedProjects).not.toHaveBeenCalled()

      // Typing a 3-part reference later triggers a debounced rescan without requiring query execution.
      sql = 'SELECT * FROM `edited-project-1.sales.orders`'
      version = 2
      for (const listener of contentListeners) listener()
      vi.advanceTimersByTime(399)
      expect(syncBigQueryReferencedProjects).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(syncBigQueryReferencedProjects).toHaveBeenCalledExactlyOnceWith(connAda, ['edited-project-1'])

      // Disposing cleans up the content listener and any pending timer.
      sql = 'SELECT * FROM `after-dispose-proj.sales.orders`'
      version = 3
      for (const listener of contentListeners) listener()
      binding.dispose()
      expect(contentListeners.size).toBe(0)
      vi.advanceTimersByTime(500)
      expect(syncBigQueryReferencedProjects).toHaveBeenCalledTimes(1)
      live = false
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets a disconnected principal so reconnecting waits for its fresh star load even after another account mutates stars', async () => {
    const reconnectLoad = deferred<ApiResult<BigQueryStarredProjectsView>>()
    let loadCalls = 0
    const api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'> = {
      loadBigQueryStarredProjects: vi.fn(async input => {
        loadCalls++
        if (input?.connectionId === connAda && loadCalls > 1) return reconnectLoad.promise
        return { ok: true as const, value: { byPrincipal: { [ada]: ['varia-beta'] } } }
      }),
      setBigQueryProjectStar: vi.fn(async () => ({ ok: true as const, value: { byPrincipal: { [grace]: ['varia-gamma'] } } }))
    }
    const starred = new BigQueryStarredService({ api })
    // 1. Account A connects and loads its starred project.
    await starred.load(connAda, ada)
    expect(starred.isLoadedFor(ada)).toBe(true)
    expect(starred.starredFor(ada)).toEqual(['varia-beta'])
    // 2. Account A disconnects (forgetPrincipal clears readiness and stale cache) and Account B stars a project.
    starred.forgetPrincipal(ada)
    expect(starred.isLoadedFor(ada)).toBe(false)
    await starred.setStarred(connGrace, grace, 'varia-gamma', true)
    expect(starred.isLoadedFor(grace)).toBe(true)
    expect(starred.isLoadedFor(ada)).toBe(false)
    // 3. Account A reconnects: isLoadedFor(ada) stays false until its new load settles, then restores its stars.
    const loading = starred.load(connAda, ada)
    expect(starred.isLoadedFor(ada)).toBe(false)
    reconnectLoad.resolve({ ok: true, value: { byPrincipal: { [ada]: ['varia-beta'] } } })
    await loading
    expect(starred.isLoadedFor(ada)).toBe(true)
    expect(starred.starredFor(ada)).toEqual(['varia-beta'])
    starred.dispose()
  })
})
