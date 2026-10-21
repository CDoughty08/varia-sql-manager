// The table designer's design, its describe model and its createTable request: types, strict zod schemas, and
// designProblems, which both the designer (a cell's error glyph, the first problem on Save) and the zod superRefine use,
// so the renderer refuses exactly what main and the backend refuse.
import { z } from 'zod'
import { ident } from '../explorer/schema.ts'
import { designerLimits, typeBounds, typeSpec } from './catalog.ts'
import { identityAllowed, typeProblem, type DesignType } from './type-text.ts'

export type { DesignType } from './type-text.ts'
/** An identity column's seed and increment: whole numbers of at most 38 digits, the increment not 0. */
export interface DesignIdentity { readonly seed: string; readonly increment: string }
export interface DesignColumn {
  readonly name: string
  readonly type: DesignType
  readonly allowNulls: boolean
  readonly identity?: DesignIdentity
}
/** A new table: its schema and name, its columns in order, and the primary key as column indexes in key order. */
export interface TableDesign {
  readonly schema: string
  readonly name: string
  readonly columns: readonly DesignColumn[]
  readonly primaryKey: readonly number[]
}
/** What the designer needs of the database: its schemas (dbo by default), the default filegroup, the band, and how its
 *  catalog compares names (column names are unique as the catalog collation compares them). */
export interface TableDesignerModel {
  readonly database: string
  /** The version band (13 = SQL Server 2016 … 17 = 2025): json and vector need 17. */
  readonly band: number
  readonly schemas: readonly string[]
  readonly schemasTruncated: boolean
  /** dbo when the database has it, else its first schema. */
  readonly defaultSchema: string
  readonly defaultFilegroup: string
  /** Whether the catalog collation tells Id from ID, and e from é. */
  readonly caseSensitiveNames: boolean
  readonly accentSensitiveNames: boolean
  /** HAS_PERMS_BY_NAME(CREATE TABLE): advisory; absent when SQL Server could not say. */
  readonly canCreate?: boolean
}
/** Save (actions.execute) and Generate Change Script (actions.script): the target is the database the table goes in. */
export interface CreateTableRequest {
  readonly action: 'createTable'; readonly connectionId: string; readonly requestId: string; readonly target: { readonly kind: 'database'; readonly name: string }; readonly design: TableDesign
}

/** One problem: the column it is about (by index) and the property, or the table's. */
export interface DesignProblem { readonly column?: number; readonly property?: 'name' | 'dataType' | 'allowNulls' | 'identity' | 'primaryKey' | 'tableName' | 'schema'; readonly message: string }

const wholeNumber = new RegExp(`^-?[0-9]{1,${designerLimits.identityDigits}}$`)
/** A seed or increment as SQL Server writes it: no leading zeros, and 0 for -0. */
export const canonicalNumber = (text: string): string => {
  const negative = text.startsWith('-'), digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, '')
  return negative && digits !== '0' ? '-' + digits : digits
}
const nameProblem = (name: string, what: string): string | undefined =>
  name.length === 0 ? `${what} cannot be empty.` : name.length > 128 ? `${what} is longer than 128 characters.` : name.includes('\u0000') ? `${what} cannot contain U+0000.` : undefined
/** SQL Server makes a table whose name starts with # a temporary table in tempdb, whatever schema it is given, so the
 *  designer refuses it (SSMS's designer cannot create temporary tables either). */
export const tempTableMessage = 'A table name cannot start with #: that would make it a temporary table, which the table designer cannot create.'
/** Why a table name cannot be saved (Choose Name, Properties and Save), or undefined. */
export const tableNameProblem = (name: string): string | undefined => nameProblem(name, 'The table name') ?? (name.startsWith('#') ? tempTableMessage : undefined)
/** How the catalog compares column names. Trailing spaces never count (SQL Server pads); case and accents only as its
 *  collation says. Without the database's answer only trailing spaces are ignored, as main and the backend check, and
 *  SQL Server refuses the rest (2705) inside the save's transaction, which rolls back. */
export interface NameComparison { readonly caseSensitive: boolean; readonly accentSensitive: boolean }
export function columnNameKey(name: string, comparison: NameComparison = { caseSensitive: true, accentSensitive: true }): string {
  let key = name.replace(/ +$/, '')
  if (!comparison.caseSensitive) key = key.toLowerCase()
  if (!comparison.accentSensitive) key = key.normalize('NFD').replace(/\p{M}/gu, '')
  return key
}
/** Every string of the design together, in UTF-16 units: bounded by `designerLimits.designChars`. */
export const designChars = (design: TableDesign): number => design.schema.length + design.name.length
  + design.columns.reduce((sum, column) => sum + column.name.length + column.type.system.length + (column.identity ? column.identity.seed.length + column.identity.increment.length : 0), 0)

/** Why the design cannot be saved, in order: the table, then each column, then the key. `band` gates json and vector, and
 *  `comparison` is the database's way of comparing names (the designer has it from the describe). */
export function designProblems(design: TableDesign, band = Number.POSITIVE_INFINITY, comparison?: NameComparison): DesignProblem[] {
  const problems: DesignProblem[] = []
  const table = tableNameProblem(design.name), schema = nameProblem(design.schema, 'The schema name')
  if (table) problems.push({ property: 'tableName', message: table })
  if (schema) problems.push({ property: 'schema', message: schema })
  if (design.columns.length === 0) problems.push({ message: 'Add at least one column before saving the table.' })
  if (design.columns.length > designerLimits.columns) problems.push({ message: `A table has at most ${designerLimits.columns} columns.` })
  if (designChars(design) > designerLimits.designChars) problems.push({ message: 'The design is too large.' })
  const seen = new Set<string>()
  let identities = 0, timestamps = 0
  design.columns.forEach((column, index) => {
    const name = nameProblem(column.name, 'A column name')
    if (name) problems.push({ column: index, property: 'name', message: name })
    else if (seen.has(columnNameKey(column.name, comparison))) problems.push({ column: index, property: 'name', message: `The column name ${column.name} is used twice.` })
    seen.add(columnNameKey(column.name, comparison))
    const type = typeProblem(column.type, band)
    if (type) problems.push({ column: index, property: 'dataType', message: type })
    if (typeSpec(column.type.system)?.onePerTable && ++timestamps === 2) problems.push({ column: index, property: 'dataType', message: 'A table can have only one timestamp column.' })
    if (column.identity) {
      if (++identities === 2) problems.push({ column: index, property: 'identity', message: 'A table can have only one identity column.' })
      if (!type && !identityAllowed(column.type)) problems.push({ column: index, property: 'identity', message: 'An identity column must be tinyint, smallint, int, bigint, or decimal or numeric with scale 0.' })
      if (!wholeNumber.test(column.identity.seed)) problems.push({ column: index, property: 'identity', message: 'The identity seed must be a whole number.' })
      if (!wholeNumber.test(column.identity.increment)) problems.push({ column: index, property: 'identity', message: 'The identity increment must be a whole number.' })
      else if (canonicalNumber(column.identity.increment) === '0') problems.push({ column: index, property: 'identity', message: 'The identity increment cannot be 0.' })
      if (column.allowNulls) problems.push({ column: index, property: 'allowNulls', message: 'An identity column cannot allow nulls.' })
    }
  })
  const key = new Set<number>()
  if (design.primaryKey.length > designerLimits.keyColumns) problems.push({ property: 'primaryKey', message: `A primary key has at most ${designerLimits.keyColumns} columns.` })
  for (const index of design.primaryKey) {
    if (!Number.isInteger(index) || index < 0 || index >= design.columns.length) { problems.push({ property: 'primaryKey', message: 'The primary key names a column that does not exist.' }); continue }
    if (key.has(index)) problems.push({ property: 'primaryKey', message: 'The primary key names a column twice.' })
    key.add(index)
    if (design.columns[index].allowNulls) problems.push({ column: index, property: 'allowNulls', message: 'A primary key column cannot allow nulls.' })
  }
  return problems
}

const whole = (min: number, max: number) => z.number().int().min(min).max(max)
const typeSchema = z.object({
  system: z.string().min(1).max(32), length: whole(typeBounds.length.min, 8000).optional(), max: z.literal(true).optional(), precision: whole(typeBounds.precision.min, typeBounds.precision.max).optional(),
  scale: whole(0, typeBounds.precision.max).optional(), dimensions: whole(typeBounds.dimensions.min, typeBounds.dimensions.max).optional()
}).strict()
const number = z.string().regex(wholeNumber, 'A whole number of at most 38 digits.')
export const designColumnSchema = z.object({ name: ident, type: typeSchema, allowNulls: z.boolean(), identity: z.object({ seed: number, increment: number }).strict().optional() }).strict()
export const tableDesignSchema = z.object({
  schema: ident, name: ident, columns: z.array(designColumnSchema).min(1).max(designerLimits.columns), primaryKey: z.array(z.number().int().min(0).max(designerLimits.columns - 1)).max(designerLimits.keyColumns)
}).strict().superRefine((design, context) => {
  for (const problem of designProblems(design)) context.addIssue({ code: 'custom', path: problem.column === undefined ? [] : ['columns', problem.column], message: problem.message })
}) satisfies z.ZodType<TableDesign>
const databaseTarget = z.object({ kind: z.literal('database'), name: ident }).strict()
export const createTableSchema = z.object({ action: z.literal('createTable'), connectionId: z.uuid(), requestId: z.uuid(), target: databaseTarget, design: tableDesignSchema }).strict()
