import { z } from 'zod'
import { isBigQueryName, type BigQueryNameKind } from './names'

/**
 * BigQuery's Object Explorer reads beyond the tree (docs/bigquery.md, Object Explorer): Preview Rows (query.execute's `preview`
 * target, read with tabledata.list) and Properties (bigquery.properties, from tables.get). Both are free and run no job.
 * BigQueryService (C#) checks the same names with BqNames.
 */
const name = (kind: BigQueryNameKind) => z.string().min(1).max(kind === 'project' ? 128 : 1024).refine(value => isBigQueryName(kind, value), `This is not a BigQuery ${kind} name.`)

/** The rows Preview Rows reads at most (SqlService.BigQueryPreviewRows). */
export const bigQueryPreviewRows = 1000

/** Preview Rows' table: tabledata.list lists stored rows, so only tables, snapshots and clones have any. */
export interface BigQueryPreviewTarget { project: string; dataset: string; table: string }
export const bigQueryPreviewTargetSchema = z.object({ project: name('project'), dataset: name('dataset'), table: name('table') }).strict() satisfies z.ZodType<BigQueryPreviewTarget>

/** The kinds Properties describes: tables.get's objects. */
export const bigQueryPropertyKinds = ['bqTable', 'bqView', 'bqMaterializedView', 'bqExternalTable'] as const
export type BigQueryPropertyKind = typeof bigQueryPropertyKinds[number]

export interface BigQueryPropertiesRequest { connectionId: string; requestId: string; kind: BigQueryPropertyKind; project: string; dataset: string; name: string }
export interface BigQueryFact { label: string; value: string }
export interface BigQueryFactGroup { title: string; facts: BigQueryFact[] }
/** Groups: Table, Storage, Layout and History, each left out when it has no facts. */
export interface BigQueryProperties { name: string; type: string; groups: BigQueryFactGroup[]; elapsedMs: number }

export const bigQueryPropertiesRequestSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), kind: z.enum(bigQueryPropertyKinds), project: name('project'), dataset: name('dataset'), name: name('table')
}).strict() satisfies z.ZodType<BigQueryPropertiesRequest>
const line = (max: number) => z.string().max(max)
export const bigQueryPropertiesSchema = z.object({
  name: line(1024), type: line(64), elapsedMs: z.number().int().min(0),
  groups: z.array(z.object({ title: line(64), facts: z.array(z.object({ label: line(64), value: line(2000) }).strict()).max(16) }).strict()).max(8)
}).strict() satisfies z.ZodType<BigQueryProperties>
