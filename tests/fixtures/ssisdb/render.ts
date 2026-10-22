// The fake SSIS catalog's tables, generated from manifest.json (D-ssis 12.2): one table in schema [catalog] per catalog view,
// with the view's columns, types and nullability, an identity where the view's column is its internal table's identity, and
// the internal table's indexes where the view has their key columns. tests/ssisdb-fixtures.test.ts writes schema.sql with -u.

export interface ShapeColumn { name: string, type: string, maxLength: number, precision: number, scale: number, nullable: boolean }
export interface ShapeParameter { name: string, type: string, maxLength: number, output: boolean }
export interface ShapeIndex { table: string, name: string, type: string, primaryKey: boolean, unique: boolean, keys: string[] }
export interface ShapeForeignKey { name: string, child: string, parent: string, onDelete: string, columns: string[] }
export interface CatalogShape {
  band: number
  source: string
  productVersion: string
  schemaVersion: string
  schemaBuild: string
  database: { compatibilityLevel: number, readCommittedSnapshot: boolean, collation: string }
  properties: Record<string, string>
  views: Record<string, ShapeColumn[]>
  procedures: Record<string, ShapeParameter[]>
  functions: Record<string, ShapeParameter[]>
  identities: string[]
  indexes: ShapeIndex[]
  foreignKeys: ShapeForeignKey[]
  sqlAuthRefused: string[]
  typeMapping: Record<string, string[]>
  errors: Record<string, string>
}
export interface Manifest { comment: string, catalogs: CatalogShape[] }

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`

export function typeText(column: Pick<ShapeColumn, 'type' | 'maxLength' | 'precision' | 'scale'>): string {
  const length = (units: number) => (column.maxLength === -1 ? 'max' : String(column.maxLength / units))
  switch (column.type) {
    case 'nvarchar': case 'nchar': return `${column.type}(${length(2)})`
    case 'varchar': case 'char': case 'varbinary': case 'binary': return `${column.type}(${length(1)})`
    case 'decimal': case 'numeric': return `${column.type}(${column.precision}, ${column.scale})`
    case 'datetimeoffset': case 'datetime2': case 'time': return `${column.type}(${column.scale})`
    case 'float': return column.precision === 53 ? 'float' : `float(${column.precision})`
    case 'bigint': case 'int': case 'smallint': case 'tinyint': case 'bit': case 'uniqueidentifier': case 'sql_variant': case 'sysname': case 'datetime':
    case 'smalldatetime': case 'date': case 'real': case 'money': case 'xml':
      return column.type
    default: throw new Error(`The fake catalog has no rendering for type ${column.type}`)
  }
}

export function renderFakeSchema(shape: CatalogShape): string {
  const identities = new Set(shape.identities)
  const lines = [
    `-- Generated from manifest.json (band ${shape.band}, ${shape.source} ${shape.productVersion}, schema version ${shape.schemaVersion}) by`,
    '-- tests/ssisdb-fixtures.test.ts; regenerate with npx vitest run tests/ssisdb-fixtures.test.ts -u, never by hand. The fake catalog:',
    '-- one table per catalog view with its columns, an identity where the view reads its internal table\'s identity, and that',
    '-- table\'s indexes where the view has their keys. No row-level security, no internal schema, no CLR.',
    'CREATE SCHEMA [catalog];',
    'GO'
  ]
  for (const view of Object.keys(shape.views).sort(ordinal)) {
    const columns = shape.views[view].map((column) => {
      const identity = identities.has(`internal.${view}.${column.name}`)
      if (identity && column.nullable) throw new Error(`catalog.${view}.${column.name} is an identity but nullable`)
      return `    ${bracket(column.name)} ${typeText(column)}${identity ? ' IDENTITY(1, 1)' : ''} ${column.nullable ? 'NULL' : 'NOT NULL'}`
    })
    lines.push(`CREATE TABLE [catalog].${bracket(view)} (`, columns.join(',\n'), ');')
    const names = new Set(shape.views[view].map((column) => column.name))
    const indexes = shape.indexes.filter((index) => index.table === `internal.${view}` && index.keys.every((key) => names.has(key)))
    for (const index of [...indexes].sort((a, b) => ordinal(a.type, b.type) || ordinal(a.name, b.name))) {
      lines.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}${index.type} INDEX ${bracket(index.name)} ON [catalog].${bracket(view)} (${index.keys.map(bracket).join(', ')});`)
    }
  }
  lines.push('GO')
  return `${lines.join('\n')}\n`
}
