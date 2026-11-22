import type { BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import type { RemoteDryRun, RemoteFilter, RemoteQueryKind, RemoteSortKey } from '../../../shared/bigquery/remote-view'
import type { MessageEntry, QueryEvent, ResultColumn, ResultDescriptor, ResolvedViewFilter, VariaApi, ViewFilter, ViewSortKey } from '../../../shared/contracts'
import { ResultError, type DistinctList, type ResultClient, type ResultHandle, type ResultView } from './ResultClient'

/**
 * Sort, filter and value lists of a result windowed in BigQuery (docs/bigquery.md, Sort and filter in BigQuery): each runs a
 * billed query in BigQuery (results.remoteQuery) after its free estimate and the cost prompts, and its answer is a new
 * result of the same query, which the grid shows as the view. A value list is a small result in memory whose own snapshot
 * the funnel reads; a filter names its values by their rows in it.
 */

/** Why a filter or command is not available for a windowed result. */
export const remoteFilterRefusal = 'This filter names rows of the grid, which a result windowed in BigQuery does not hold. Filter by a column\'s values instead, or Load into memory.'
export const remoteSelectionText = 'Filters by selection, duplicates and Keep Selected Rows need the rows in memory. Filter by a column\'s values instead, or Load into memory.'

/** Whether BigQuery can order and group a column of this type (BigQueryViewSql.Orderable in C#): not ARRAY, STRUCT,
 *  GEOGRAPHY, JSON, RANGE or INTERVAL. */
export function remoteOrderable(column: Pick<ResultColumn, 'dataType'>): boolean {
  return !/^(ARRAY|STRUCT|GEOGRAPHY|JSON|RANGE|INTERVAL)\b/i.test(column.dataType.trim())
}

/** Why a column cannot be sorted or listed in BigQuery. */
export const unorderableText = (column: Pick<ResultColumn, 'dataType' | 'name'>): string =>
  `BigQuery cannot sort or group a ${column.dataType} column, so ${column.name || 'this column'} cannot be sorted or filtered by value here.`

export const isRemoteHandle = (handle: Pick<ResultHandle, 'getSnapshot'>): boolean => handle.getSnapshot().residence === 'remote'

/** The user declined a cost prompt, or the work was given up: nothing ran and nothing needs saying. */
export class RemoteDeclined extends Error {
  constructor() { super('The query over BigQuery was not run.') }
}

/** A grid filter as a remote filter, or undefined when it names rows rather than values (cells, keepRows, duplicates). */
export function remoteFilter(item: { readonly filter: ViewFilter | ResolvedViewFilter; readonly list?: DistinctList }): RemoteFilter | undefined {
  const filter = item.filter, list = item.list?.source ? item.list.resultId : undefined
  switch (filter.op) {
    case 'groups': return list === undefined ? undefined : { op: 'groups', column: filter.column, list, snapshotId: filter.snapshotId }
    case 'in':
    case 'notIn': {
      if (!('rows' in filter) || 'cells' in filter) return undefined
      const nulls = filter.nulls === true ? { nulls: true } : {}
      if (filter.rows.length === 0) return { op: filter.op, column: filter.column, rows: [], ...nulls }
      return list === undefined ? undefined : { op: filter.op, column: filter.column, list, rows: [...filter.rows], ...nulls }
    }
    case 'between':
      return 'rows' in filter && !('cells' in filter) && filter.rows.length === 2 && list !== undefined ? { op: 'between', column: filter.column, list, rows: [filter.rows[0], filter.rows[1]] } : undefined
    default: return undefined
  }
}

export interface RemoteViewDeps {
  readonly api: Pick<VariaApi, 'remoteQuery' | 'cancel'>
  readonly client: Pick<ResultClient, 'open' | 'onQueryEvent'>
  /** The free estimate and the cost prompts (BigQueryCostService.beforeRemote): the estimate when it may run, else undefined. */
  readonly estimate: (tabId: string, remote: RemoteDryRun, signal?: AbortSignal) => Promise<BigQueryDryRunResult | undefined>
  readonly newId?: () => string
  /** The query's messages (its job, rows and cost), for the tab's Messages. */
  readonly messages?: (tabId: string, messages: readonly MessageEntry[]) => void
}

export class RemoteViews {
  constructor(private readonly deps: RemoteViewDeps) {}

  /** A sort or filter of `source` in BigQuery, as a view the grid shows: the new result's own handle, which its close releases. */
  async view(tabId: string, source: ResultHandle, keys: readonly ViewSortKey[], filters: readonly { readonly filter: ViewFilter; readonly list?: DistinctList }[], signal: AbortSignal): Promise<ResultView> {
    const remote = filters.map(remoteFilter)
    if (remote.some(item => item === undefined)) throw new Error(remoteFilterRefusal)
    const sort = keys.map((key): RemoteSortKey => ({ column: key.column, descending: key.descending }))
    const handle = await this.run(tabId, source, { kind: 'view', ...sort.length ? { sort } : {}, ...remote.length ? { filters: remote as RemoteFilter[] } : {} }, signal)
    return remoteView(handle, source, keys, filters.map(item => item.filter as ResolvedViewFilter))
  }

  /** A column's value list in BigQuery under the other filters, its values ticked by the `kept` filters' rows (all of them
   *  without): the list result's snapshot, whose close releases the list too. */
  async values(tabId: string, source: ResultHandle, column: number, filters: readonly { readonly filter: ViewFilter; readonly list?: DistinctList }[],
    kept: readonly { readonly filter: ViewFilter; readonly list?: DistinctList }[] | undefined, signal?: AbortSignal): Promise<DistinctList> {
    const others = filters.map(remoteFilter), ticks = kept?.map(remoteFilter)
    if (others.some(item => item === undefined) || ticks?.some(item => item === undefined)) throw new Error(remoteFilterRefusal)
    const handle = await this.run(tabId, source, { kind: 'distinct', column, ...others.length ? { filters: others as RemoteFilter[] } : {}, ...ticks?.length ? { kept: ticks as RemoteFilter[] } : {} }, signal ?? new AbortController().signal)
    let list: DistinctList
    try { list = await handle.distinct(0, signal ? { signal } : {}) } catch (error) { void handle.close(); throw error }
    return {
      generation: list.generation, resultId: list.resultId, snapshotId: list.snapshotId, column, summary: list.summary, source: { resultId: source.key.resultId, values: handle },
      read: o => list.read(o), tick: o => list.tick(o),
      close: async () => { try { await list.close() } finally { await handle.close() } }
    }
  }

  /** Estimates, asks, runs and opens: the new result's handle. Stop (the signal) cancels the query. */
  private async run(tabId: string, source: ResultHandle, kind: Exclude<RemoteQueryKind, { kind: 'load' }>, signal: AbortSignal): Promise<ResultHandle> {
    const { resultId, generation } = source.key
    const estimate = await this.deps.estimate(tabId, { resultId, generation, ...kind } as RemoteDryRun, signal)
    if (!estimate || signal.aborted) throw new RemoteDeclined()
    const queryId = this.deps.newId?.() ?? crypto.randomUUID()
    let opened: ResultDescriptor | undefined
    const events = this.deps.client.onQueryEvent(queryId, (event: QueryEvent) => { if (event.type === 'resultSet.opened') opened = event.descriptor })
    const cancel = () => { void this.deps.api.cancel(queryId).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const answer = await this.deps.api.remoteQuery({ queryId, resultId, generation, ...kind, ...estimate.fallback ? { fallback: true } : {} })
      if (!answer.ok) throw new ResultError((answer.code ?? 'BACKEND_ERROR') as ResultError['code'], answer.error)
      const summary = answer.value
      // A stop's lines are information (the grid kept its view); only a failure's error opens Messages as an error.
      if (summary.messages.length) this.deps.messages?.(tabId, summary.status === 'failed' ? summary.messages : summary.messages.map(message => message.kind === 'error' ? { ...message, kind: 'info' as const } : message))
      if (signal.aborted) {
        for (const set of summary.resultSets) void this.deps.client.open(set).close()
        throw new RemoteDeclined()
      }
      const descriptor = summary.resultSets[0] ?? (summary.status === 'completed' ? opened : undefined)
      if (summary.status !== 'completed' || !descriptor) throw new ResultError((summary.error?.code ?? 'BACKEND_ERROR') as ResultError['code'], summary.error?.message ?? 'BigQuery did not answer the query.')
      return this.deps.client.open(descriptor)
    } finally {
      signal.removeEventListener('abort', cancel)
      events.dispose()
    }
  }
}

/** A remote result as the grid's view of its source: read, measured and closed as itself; `remote` marks it, so what would
 *  name it as a view of the source (by `viewId`) names its own result instead. */
export type RemoteView = ResultView & { readonly remote: true }

export function remoteView(handle: ResultHandle, base: ResultHandle, keys: readonly ViewSortKey[], filters: readonly ResolvedViewFilter[]): RemoteView {
  const view = Object.create(handle) as RemoteView
  Object.defineProperties(view, {
    viewId: { value: 0 }, base: { value: base }, keys: { value: keys }, filters: { value: filters }, rows: { get: () => handle.getSnapshot().rowsAvailable },
    baseRows: { value: base.getSnapshot().rowsAvailable }, complete: { value: true }, approximate: { value: false }, remote: { value: true }
  })
  return view
}

export const isRemoteView = (view: unknown): view is RemoteView => typeof view === 'object' && view !== null && (view as { remote?: unknown }).remote === true

/** A windowed result's header: tooltips that say its sort and funnels work in BigQuery, its columns BigQuery cannot order
 *  refused with why, and funnels only on the others. */
export function remoteHeader(columns: readonly ResultColumn[]): { readonly notes: { readonly where: string; readonly refused: ReadonlyMap<number, string> }; readonly filterable: ReadonlySet<number> } {
  const refused = new Map<number, string>(), filterable = new Set<number>()
  columns.forEach((column, at) => { if (remoteOrderable(column)) filterable.add(at); else refused.set(at, unorderableText(column)) })
  return { notes: { where: ' in BigQuery', refused }, filterable }
}
