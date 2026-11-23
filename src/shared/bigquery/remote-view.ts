import { z } from 'zod'
import { limits } from '../ipc/wire/protocol'
import { jobKeySchema } from './jobs'

/**
 * results.remoteQuery's params (docs/ipc.md, docs/bigquery.md › Sort and filter in BigQuery): a query over a windowed
 * BigQuery result. `load` reads it into memory; `view` sorts and filters it in BigQuery; `distinct` lists a column's values;
 * `sample` reads a sample of it into a new result in memory (Load sample); `rerun` runs its own statement again in place.
 * BigQueryViewSql and SqlService.BigQueryViews.cs (C#) check the same limits.
 */
export const remoteViewLimits = { keys: 16, filters: 16, rows: 2, valueListCap: 100_000, sampleRows: 10_000_000 } as const

/** How Load sample picks its rows: the first rows (tabledata.list, free) or a random sample (TABLESAMPLE SYSTEM, billed). */
export type SampleMethod = 'first' | 'random'

export interface RemoteSortKey { column: number; descending: boolean }
/**
 * A remote filter: `in`/`notIn` keep or drop the values at `rows` of the value list `list` (a `distinct` result for this
 * column), and NULL when `nulls` says; with no rows they name no list. `between` keeps the values from `rows[0]`'s to
 * `rows[1]`'s; `groups` keeps what the ticks of the value list's snapshot `snapshotId` keep.
 */
export type RemoteFilter =
  | { op: 'in' | 'notIn'; column: number; list?: number; rows: number[]; nulls?: boolean }
  | { op: 'between'; column: number; list: number; rows: [number, number] }
  | { op: 'groups'; column: number; list: number; snapshotId: number }

export type RemoteQueryKind =
  /** `jobKey`: the tab's job key, under which main records the load's job for re-attaching (docs/bigquery.md). */
  | { kind: 'load'; jobKey?: string }
  | { kind: 'view'; sort?: RemoteSortKey[]; filters?: RemoteFilter[]; fallback?: boolean }
  | { kind: 'distinct'; column: number; filters?: RemoteFilter[]; kept?: RemoteFilter[]; fallback?: boolean }
  | { kind: 'sample'; rows: number; method: SampleMethod }
  | { kind: 'rerun' }

/** results.remoteQuery (docs/ipc.md): a query over a windowed BigQuery result this renderer owns in `generation`, run like
 *  query.execute under its own `queryId` (query.cancel stops it). */
export type ResultsRemoteQueryParams = { queryId: string; resultId: number; generation: number } & RemoteQueryKind

/** A view, distinct, sample or rerun request as bigquery.dryRun estimates it: no query id, and no fallback (the estimate says
 *  whether one is needed). */
export type RemoteDryRun = { resultId: number; generation: number } & (
  | { kind: 'view'; sort?: RemoteSortKey[]; filters?: RemoteFilter[] }
  | { kind: 'distinct'; column: number; filters?: RemoteFilter[]; kept?: RemoteFilter[] }
  | { kind: 'sample'; rows: number; method: SampleMethod }
  | { kind: 'rerun' })

/** The result ids a remote request names: its source and every value list its filters name, each checked for ownership. */
export function remoteResultIds(params: { resultId: number } & ({ filters?: readonly RemoteFilter[]; kept?: readonly RemoteFilter[] } | object)): number[] {
  const ids = new Set([params.resultId])
  const named = params as { filters?: readonly RemoteFilter[]; kept?: readonly RemoteFilter[] }
  for (const filter of [...named.filters ?? [], ...named.kept ?? []]) if ('list' in filter && filter.list !== undefined) ids.add(filter.list)
  return [...ids]
}

const resultId = z.number().int().min(1).max(0xffffffff)
const generation = z.number().int().min(1).max(2 ** 31 - 1)
const column = z.number().int().min(0).max(limits.page.maxColumns - 1)
const row = z.number().int().min(0).max(remoteViewLimits.valueListCap - 1)
const sortKey = z.object({ column, descending: z.boolean() }).strict()
const filter = z.discriminatedUnion('op', [
  z.object({ op: z.enum(['in', 'notIn']), column, list: resultId.optional(), rows: z.array(row).max(remoteViewLimits.rows), nulls: z.boolean().optional() }).strict()
    .refine(value => value.rows.length === 0 || value.list !== undefined, 'A filter\'s values need the column\'s value list.'),
  z.object({ op: z.literal('between'), column, list: resultId, rows: z.tuple([row, row]) }).strict(),
  z.object({ op: z.literal('groups'), column, list: resultId, snapshotId: z.number().int().min(1).max(0xffffffff) }).strict()
])
const filters = z.array(filter).max(remoteViewLimits.filters)
const sort = z.array(sortKey).max(remoteViewLimits.keys)
const distinctKeys = (keys: readonly { column: number }[]): boolean => new Set(keys.map(key => key.column)).size === keys.length
const viewFields = { kind: z.literal('view'), sort: sort.optional(), filters: filters.optional() }
const distinctFields = { kind: z.literal('distinct'), column, filters: filters.optional(), kept: filters.optional() }
const someClause = (value: { sort?: readonly unknown[]; filters?: readonly unknown[] }): boolean => (value.sort?.length ?? 0) + (value.filters?.length ?? 0) > 0
const head = { queryId: z.uuid(), resultId, generation }
const sampleFields = { kind: z.literal('sample'), rows: z.number().int().min(1).max(remoteViewLimits.sampleRows), method: z.enum(['first', 'random']) }

export const resultsRemoteQuerySchema = z.discriminatedUnion('kind', [
  z.object({ ...head, kind: z.literal('load'), jobKey: jobKeySchema.optional() }).strict(),
  z.object({ ...head, ...viewFields, fallback: z.boolean().optional() }).strict()
    .refine(someClause, 'A remote view takes a sort key or a filter.').refine(value => distinctKeys(value.sort ?? []), 'Each sort key must be a distinct column.'),
  z.object({ ...head, ...distinctFields, fallback: z.boolean().optional() }).strict(),
  z.object({ ...head, ...sampleFields }).strict(),
  z.object({ ...head, kind: z.literal('rerun') }).strict()
])

export const remoteDryRunSchema = z.discriminatedUnion('kind', [
  z.object({ resultId, generation, ...viewFields }).strict()
    .refine(someClause, 'A remote view takes a sort key or a filter.').refine(value => distinctKeys(value.sort ?? []), 'Each sort key must be a distinct column.'),
  z.object({ resultId, generation, ...distinctFields }).strict(),
  z.object({ resultId, generation, ...sampleFields }).strict(),
  z.object({ resultId, generation, kind: z.literal('rerun') }).strict()
])
