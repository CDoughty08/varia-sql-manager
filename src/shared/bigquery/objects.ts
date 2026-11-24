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
/** Columns and nested fields bigquery.properties answers at most in the flat details-pane list (BigQueryService.MaxColumnFacts). */
export const bigQueryMaxColumnFacts = 1000

/**
 * Bounds for `bigquery.properties` (BigQueryPropertiesLimits in C#).
 *
 * Protocol v2 caps MessagePack container depth at 16 (docs/ipc.md). Inside `{ result: { schema: [...] } }`, each nested
 * `BigQuerySchemaField` level uses two containers (the field map and its `fields` array), so seven field levels use all 16
 * containers (0-based depth 15 in `JsonBridge.FromJson`), leaving no headroom for a 7th-level `fields` array; deeper STRUCT
 * fields are omitted and set `schemaTruncated: true`.
 */
export const bigQueryPropertiesLimits = {
  name: 1024,
  type: 64,
  fullName: 2200,
  location: 64,
  timestamp: 64,
  factTitle: 64,
  factLabel: 64,
  factValue: 2000,
  groups: 8,
  factsPerGroup: 16,
  partitioning: 512,
  clusteringFields: 16,
  columnName: 300,
  columnType: 64,
  columnMode: 32,
  columnDescription: 2000,
  schemaDepth: 7,
  schemaFields: 10_000,
  labels: 64,
  labelKey: 128,
  labelValue: 256,
  definitionChars: bigQueryMaxDefinition
} as const

export interface BigQueryPropertiesRequest { connectionId: string; requestId: string; kind: BigQueryDetailKind; project: string; dataset: string; name: string }
export interface BigQueryFact { label: string; value: string }
export interface BigQueryFactGroup { title: string; facts: BigQueryFact[] }
/** A column or nested field by its path, as the search index and Search Objects details pane list it. */
export interface BigQueryColumnFact { name: string; type: string; description?: string }
export interface BigQueryStorageInfo { rows?: number; logicalBytes?: number; longTermLogicalBytes?: number; physicalBytes?: number }
export interface BigQueryLayoutInfo { partitioning?: string; requirePartitionFilter?: boolean; clustering?: string[] }
export interface BigQuerySchemaField { name: string; type: string; mode?: string; description?: string; fields?: BigQuerySchemaField[] }
export interface BigQueryLabel { key: string; value: string }
/**
 * Groups: Table, Storage, Layout and History (a routine's: Routine and History), each left out when it has no facts.
 * Definition: a view's or materialized view's query or a routine's body (`definitionCut` / `definitionTruncated` when cut).
 * Columns: the first 1,000 flattened columns and nested fields for Search Objects' details pane (`columnsCut`).
 * Structured fields (`storage`, `layout`, `schema`, `labels`, identity/timestamps) come from the same free `tables.get` call.
 */
export interface BigQueryProperties {
  name: string
  type: string
  groups: BigQueryFactGroup[]
  elapsedMs: number
  definition?: string
  definitionCut?: boolean
  definitionTruncated?: boolean
  columns?: BigQueryColumnFact[]
  columnsCut?: boolean
  fullName?: string
  location?: string
  description?: string
  baseTable?: string
  createdUtc?: string
  modifiedUtc?: string
  expiresUtc?: string
  snapshotTimeUtc?: string
  storage?: BigQueryStorageInfo
  layout?: BigQueryLayoutInfo
  schema?: BigQuerySchemaField[]
  schemaTruncated?: boolean
  labels?: BigQueryLabel[]
}

export const bigQueryPropertiesRequestSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), kind: z.enum(bigQueryDetailKinds), project: name('project'), dataset: name('dataset'), name: z.string().min(1).max(1024)
}).strict().refine(request => isBigQueryName(request.kind === 'bqRoutine' ? 'routine' : 'table', request.name), { message: 'This is not a BigQuery object name.', path: ['name'] }) satisfies z.ZodType<BigQueryPropertiesRequest>
const line = (max: number) => z.string().max(max)
const nonEmpty = (max: number) => z.string().min(1).max(max)
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const bigQueryStorageInfoSchema = z.object({
  rows: safeCount.optional(),
  logicalBytes: safeCount.optional(),
  longTermLogicalBytes: safeCount.optional(),
  physicalBytes: safeCount.optional()
}).strict() satisfies z.ZodType<BigQueryStorageInfo>

export const bigQueryLayoutInfoSchema = z.object({
  partitioning: nonEmpty(bigQueryPropertiesLimits.partitioning).optional(),
  requirePartitionFilter: z.boolean().optional(),
  clustering: z.array(nonEmpty(bigQueryPropertiesLimits.columnName)).max(bigQueryPropertiesLimits.clusteringFields).optional()
}).strict() satisfies z.ZodType<BigQueryLayoutInfo>

export const bigQueryLabelSchema = z.object({
  key: nonEmpty(bigQueryPropertiesLimits.labelKey),
  value: line(bigQueryPropertiesLimits.labelValue)
}).strict() satisfies z.ZodType<BigQueryLabel>

function schemaFieldSchema(depth: number): z.ZodType<BigQuerySchemaField> {
  const base = {
    name: nonEmpty(bigQueryPropertiesLimits.columnName),
    type: nonEmpty(bigQueryPropertiesLimits.columnType),
    mode: nonEmpty(bigQueryPropertiesLimits.columnMode).optional(),
    description: line(bigQueryPropertiesLimits.columnDescription).optional()
  }
  if (depth >= bigQueryPropertiesLimits.schemaDepth) return z.object(base).strict()
  return z.object({
    ...base,
    fields: z.array(schemaFieldSchema(depth + 1)).max(bigQueryPropertiesLimits.schemaFields).optional()
  }).strict()
}

export const bigQuerySchemaFieldSchema: z.ZodType<BigQuerySchemaField> = schemaFieldSchema(1)

function countSchemaFields(fields: readonly BigQuerySchemaField[], limit: number): number {
  let count = 0
  const stack: (readonly BigQuerySchemaField[])[] = [fields]
  while (stack.length > 0) {
    const list = stack.pop()!
    for (let i = 0; i < list.length; i++) {
      if (++count > limit) return count
      const nested = list[i].fields
      if (nested && nested.length > 0) stack.push(nested)
    }
  }
  return count
}

export const bigQueryPropertiesSchema = z.object({
  name: line(bigQueryPropertiesLimits.name),
  type: line(bigQueryPropertiesLimits.type),
  elapsedMs: safeCount,
  groups: z.array(z.object({
    title: line(bigQueryPropertiesLimits.factTitle),
    facts: z.array(z.object({ label: line(bigQueryPropertiesLimits.factLabel), value: line(bigQueryPropertiesLimits.factValue) }).strict()).max(bigQueryPropertiesLimits.factsPerGroup)
  }).strict()).max(bigQueryPropertiesLimits.groups),
  definition: line(bigQueryPropertiesLimits.definitionChars).optional(),
  definitionCut: z.literal(true).optional(),
  definitionTruncated: z.boolean().optional(),
  columns: z.array(z.object({ name: line(bigQueryFieldPathMax), type: line(1024), description: line(1024).optional() }).strict()).max(bigQueryMaxColumnFacts).optional(),
  columnsCut: z.literal(true).optional(),
  fullName: nonEmpty(bigQueryPropertiesLimits.fullName).optional(),
  location: nonEmpty(bigQueryPropertiesLimits.location).optional(),
  description: line(bigQueryPropertiesLimits.factValue).optional(),
  baseTable: nonEmpty(bigQueryPropertiesLimits.fullName).optional(),
  createdUtc: nonEmpty(bigQueryPropertiesLimits.timestamp).optional(),
  modifiedUtc: nonEmpty(bigQueryPropertiesLimits.timestamp).optional(),
  expiresUtc: nonEmpty(bigQueryPropertiesLimits.timestamp).optional(),
  snapshotTimeUtc: nonEmpty(bigQueryPropertiesLimits.timestamp).optional(),
  storage: bigQueryStorageInfoSchema.optional(),
  layout: bigQueryLayoutInfoSchema.optional(),
  schema: z.array(bigQuerySchemaFieldSchema).max(bigQueryPropertiesLimits.schemaFields).optional(),
  schemaTruncated: z.boolean().optional(),
  labels: z.array(bigQueryLabelSchema).max(bigQueryPropertiesLimits.labels).optional()
}).strict().refine(
  value => !value.schema || countSchemaFields(value.schema, bigQueryPropertiesLimits.schemaFields) <= bigQueryPropertiesLimits.schemaFields,
  'BigQuery properties schema exceeds the maximum total field count.'
) satisfies z.ZodType<BigQueryProperties>
