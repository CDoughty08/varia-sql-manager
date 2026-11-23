import { z } from 'zod'
import { bigQueryFieldPathMax, isBigQueryName, type BigQueryNameKind } from './names'

/**
 * BigQuery's Object Explorer reads beyond the tree (docs/bigquery.md, Object Explorer): Preview Rows (query.execute's `preview`
 * target, read with tabledata.list) and Properties (bigquery.properties, from tables.get, or routines.get for Search Objects' details
 * pane). Both are free and run no job.
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
/** The kinds bigquery.properties answers: the Properties tab's, and routines for Search Objects' details pane. */
export const bigQueryDetailKinds = [...bigQueryPropertyKinds, 'bqRoutine'] as const
export type BigQueryDetailKind = typeof bigQueryDetailKinds[number]

/** The longest view text or routine body bigquery.properties answers (BigQueryService.MaxDefinition). */
export const bigQueryMaxDefinition = 1_000_000
/** Columns and nested fields bigquery.properties answers at most (BigQueryService.MaxColumnFacts). */
export const bigQueryMaxColumnFacts = 1000

export interface BigQueryPropertiesRequest { connectionId: string; requestId: string; kind: BigQueryDetailKind; project: string; dataset: string; name: string }
export interface BigQueryFact { label: string; value: string }
export interface BigQueryFactGroup { title: string; facts: BigQueryFact[] }
/** A column or nested field by its path, as the search index has it. */
export interface BigQueryColumnFact { name: string; type: string; description?: string }
/**
 * Groups: Table, Storage, Layout and History (a routine's: Routine and History), each left out when it has no facts. Definition: a
 * view's query or a routine's body (definitionCut when it was longer); columns: the first 1,000 columns and nested fields (columnsCut).
 */
export interface BigQueryProperties {
  name: string; type: string; groups: BigQueryFactGroup[]; elapsedMs: number
  definition?: string; definitionCut?: boolean; columns?: BigQueryColumnFact[]; columnsCut?: boolean
}

export const bigQueryPropertiesRequestSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), kind: z.enum(bigQueryDetailKinds), project: name('project'), dataset: name('dataset'), name: z.string().min(1).max(1024)
}).strict().refine(request => isBigQueryName(request.kind === 'bqRoutine' ? 'routine' : 'table', request.name), { message: 'This is not a BigQuery object name.', path: ['name'] }) satisfies z.ZodType<BigQueryPropertiesRequest>
const line = (max: number) => z.string().max(max)
export const bigQueryPropertiesSchema = z.object({
  name: line(1024), type: line(64), elapsedMs: z.number().int().min(0),
  groups: z.array(z.object({ title: line(64), facts: z.array(z.object({ label: line(64), value: line(2000) }).strict()).max(16) }).strict()).max(8),
  definition: line(bigQueryMaxDefinition).optional(), definitionCut: z.literal(true).optional(),
  columns: z.array(z.object({ name: line(bigQueryFieldPathMax), type: line(1024), description: line(1024).optional() }).strict()).max(bigQueryMaxColumnFacts).optional(),
  columnsCut: z.literal(true).optional()
}).strict() satisfies z.ZodType<BigQueryProperties>
