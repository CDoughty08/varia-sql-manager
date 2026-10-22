// The fake SSIS catalog's tables, generated from manifest.json (D-ssis 12.2): one table in schema [catalog] per catalog view,
// with the view's columns, types and nullability, an identity where the view's column is its internal table's identity, and
// the internal table's indexes where the view has their key columns. tests/ssisdb-fixtures.test.ts writes schema.sql with -u.

export interface ShapeColumn { name: string, type: string, maxLength: number, precision: number, scale: number, nullable: boolean }
export interface ShapeParameter { name: string, type: string, maxLength: number, output: boolean, default?: string }
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

// The catalog views the real catalog builds as a base view LEFT JOIN an internal table, and the fake builds the same way, so a
// reader sees what the real view shows while the second row is missing: catalog.event_messages is operation_messages LEFT
// JOIN internal.event_messages on event_message_id = operation_message_id, and internal.append_event_message commits the two
// rows in separate statements (docs/integration-services.md 14.3). The fake's internal table is catalog.varia_<view>, which
// holds the id, operation_id and the columns the base view lacks.
export const joinedViews: Record<string, { base: string, id: string, baseId: string }> = {
  event_messages: { base: 'operation_messages', id: 'event_message_id', baseId: 'operation_message_id' }
}

export function renderFakeSchema(shape: CatalogShape): string {
  const identities = new Set(shape.identities)
  const lines = [
    `-- Generated from manifest.json (band ${shape.band}, ${shape.source} ${shape.productVersion}, schema version ${shape.schemaVersion}) by`,
    '-- tests/ssisdb-fixtures.test.ts; regenerate with npx vitest run tests/ssisdb-fixtures.test.ts -u, never by hand. The fake catalog:',
    '-- one table per catalog view with its columns, an identity where the view reads its internal table\'s identity, and that',
    '-- table\'s indexes where the view has their keys; catalog.event_messages is a view of operation_messages LEFT JOIN the',
    '-- fake\'s varia_event_messages, as the real view is. No row-level security, no internal schema, no CLR.',
    'CREATE SCHEMA [catalog];',
    'GO'
  ]
  const index = (internal: string, table: string, names: Set<string>) => {
    const indexes = shape.indexes.filter((item) => item.table === `internal.${internal}` && item.keys.every((key) => names.has(key)))
    for (const item of [...indexes].sort((a, b) => ordinal(a.type, b.type) || ordinal(a.name, b.name))) {
      lines.push(`CREATE ${item.unique ? 'UNIQUE ' : ''}${item.type} INDEX ${bracket(item.name)} ON [catalog].${bracket(table)} (${item.keys.map(bracket).join(', ')});`)
    }
  }
  const views: string[] = []
  for (const view of Object.keys(shape.views).sort(ordinal)) {
    const joined = joinedViews[view]
    if (joined) {
      const base = new Set((shape.views[joined.base] ?? []).map((column) => column.name))
      const key = shape.views[view].find((column) => column.name === joined.id)
      const operation = shape.views[view].find((column) => column.name === 'operation_id')
      if (!base.has(joined.baseId) || !key || !operation) throw new Error(`catalog.${view} cannot be built on catalog.${joined.base}`)
      const own = shape.views[view].filter((column) => !base.has(column.name) && column.name !== joined.id)
      lines.push(`CREATE TABLE [catalog].${bracket(`varia_${view}`)} (`, [
        `    ${bracket(key.name)} ${typeText(key)} NOT NULL`,
        `    ${bracket(operation.name)} ${typeText(operation)} NOT NULL`,
        ...own.map((column) => `    ${bracket(column.name)} ${typeText(column)} NULL`)
      ].join(',\n'), ');')
      index(view, `varia_${view}`, new Set([key.name, operation.name, ...own.map((column) => column.name)]))
      views.push(view)
      continue
    }
    const columns = shape.views[view].map((column) => {
      const identity = identities.has(`internal.${view}.${column.name}`)
      if (identity && column.nullable) throw new Error(`catalog.${view}.${column.name} is an identity but nullable`)
      return `    ${bracket(column.name)} ${typeText(column)}${identity ? ' IDENTITY(1, 1)' : ''} ${column.nullable ? 'NULL' : 'NOT NULL'}`
    })
    lines.push(`CREATE TABLE [catalog].${bracket(view)} (`, columns.join(',\n'), ');')
    index(view, view, new Set(shape.views[view].map((column) => column.name)))
  }
  lines.push('GO')
  // A view's column keeps the nullability of the column it selects, and CONVERT makes it nullable. Only nullable columns may
  // come from the joined table, whose row can be missing.
  for (const view of views) {
    const joined = joinedViews[view]
    const base = new Map(shape.views[joined.base].map((column) => [column.name, column]))
    const columns = shape.views[view].map((column) => {
      const from = base.get(column.name === joined.id ? joined.baseId : column.name)
      if (!from) {
        if (!column.nullable) throw new Error(`catalog.${view}.${column.name} comes from the joined table but is not nullable`)
        return `    e.${bracket(column.name)}`
      }
      if (typeText(from) !== typeText(column)) throw new Error(`catalog.${view}.${column.name} is ${typeText(column)} but catalog.${joined.base}.${from.name} is ${typeText(from)}`)
      if (!column.nullable && from.nullable) throw new Error(`catalog.${view}.${column.name} is not nullable but catalog.${joined.base}.${from.name} is`)
      const source = `m.${bracket(from.name)}`
      if (column.nullable !== from.nullable) return `    CONVERT(${typeText(column)}, ${source}) AS ${bracket(column.name)}`
      return `    ${source}${from.name === column.name ? '' : ` AS ${bracket(column.name)}`}`
    })
    lines.push(`CREATE VIEW [catalog].${bracket(view)}`, 'AS', 'SELECT', columns.join(',\n'),
      `FROM [catalog].${bracket(joined.base)} AS m LEFT JOIN [catalog].${bracket(`varia_${view}`)} AS e ON e.${bracket(joined.id)} = m.${bracket(joined.baseId)};`, 'GO')
  }
  return `${lines.join('\n')}\n`
}
