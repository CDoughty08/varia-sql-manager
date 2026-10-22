import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderFakeSchema, typeText, type Manifest } from './fixtures/ssisdb/render'

// PR S0: the SSIS catalog fixtures. manifest.json is written by the .NET checks from a real catalog (or the Integration
// Services feature's catalog backup); schema.sql is generated from it here; procedures.sql is hand-written and must keep the
// real signatures; docs/integration-services.md records what the manifest proves, and must keep saying only that.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const column = z.strictObject({ name: z.string().min(1), type: z.string().min(1), maxLength: z.number().int(), precision: z.number().int(), scale: z.number().int(), nullable: z.boolean() })
const parameter = z.strictObject({ name: z.string(), type: z.string().min(1), maxLength: z.number().int(), output: z.boolean() })
const shape = z.strictObject({
  band: z.number().int().min(13).max(17),
  source: z.enum(['backup', 'catalog']),
  productVersion: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
  schemaVersion: z.string().min(1),
  schemaBuild: z.string().min(1),
  database: z.strictObject({ compatibilityLevel: z.number().int(), readCommittedSnapshot: z.boolean(), collation: z.string().min(1) }),
  properties: z.record(z.string(), z.string()),
  views: z.record(z.string(), z.array(column).min(1)),
  procedures: z.record(z.string(), z.array(parameter)),
  functions: z.record(z.string(), z.array(parameter)),
  identities: z.array(z.string().regex(/^internal\.\w+\.\w+$/)),
  indexes: z.array(z.strictObject({ table: z.string(), name: z.string(), type: z.enum(['CLUSTERED', 'NONCLUSTERED']), primaryKey: z.boolean(), unique: z.boolean(), keys: z.array(z.string()).min(1) })),
  foreignKeys: z.array(z.strictObject({ name: z.string(), child: z.string(), parent: z.string(), onDelete: z.string(), columns: z.array(z.string().regex(/^\w+ -> \w+$/)).min(1) })),
  sqlAuthRefused: z.array(z.string()),
  typeMapping: z.record(z.string(), z.array(z.string())),
  errors: z.record(z.string().regex(/^27\d{3}$/), z.string().min(1))
})
const manifestSchema = z.strictObject({ comment: z.string().min(1), catalogs: z.array(shape).min(1) })
const manifest: Manifest = manifestSchema.parse(JSON.parse(read('./fixtures/ssisdb/manifest.json')))
const newest = manifest.catalogs.at(-1)!

function stubs(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const match of text.matchAll(/CREATE PROCEDURE \[catalog\]\.\[(\w+)\]\n([\s\S]*?)\nAS\n/g)) {
    const parameters = match[2].split(',\n').map((line) => line.trim().replace(/ = .*$/, '').replace(/ OUTPUT$/, ' OUTPUT')).filter(Boolean)
    found.set(match[1], parameters)
  }
  return found
}

describe('SSIS catalog fixtures', () => {
  it('holds one entry per band, in order, with SQL Server 2025 read from its catalog backup or catalog', () => {
    const bands = manifest.catalogs.map((entry) => entry.band)
    expect(bands).toEqual([...new Set(bands)].sort((a, b) => a - b))
    expect(bands).toContain(17)
    for (const entry of manifest.catalogs) {
      expect(entry.sqlAuthRefused.every((name) => name in entry.procedures)).toBe(true)
      expect(Object.keys(entry.views).length).toBeGreaterThan(20)
    }
  })

  it('generates schema.sql from the newest entry', async () => {
    await expect(renderFakeSchema(newest)).toMatchFileSnapshot('./fixtures/ssisdb/schema.sql')
  })

  it('gives identities, nullability and indexes from the manifest, and refuses a type it cannot render', () => {
    const schema = renderFakeSchema(newest)
    expect(schema).toContain('    [operation_id] bigint IDENTITY(1, 1) NOT NULL')
    expect(schema).toContain('    [operation_message_id] bigint IDENTITY(1, 1) NOT NULL')
    // catalog.event_messages reads operation_messages' id (a LEFT JOIN, so no identity of its own, and nullable through its UNION).
    expect(schema).toMatch(/CREATE TABLE \[catalog\]\.\[event_messages\] \(\n {4}\[event_message_id\] bigint NULL,/)
    expect(schema).toContain('CREATE NONCLUSTERED INDEX [IX_OperationMessages_Operation_id] ON [catalog].[operation_messages] ([operation_id]);')
    expect(schema).toContain('CREATE UNIQUE CLUSTERED INDEX [PK_Executions] ON [catalog].[executions] ([execution_id]);')
    expect(typeText({ type: 'nvarchar', maxLength: -1, precision: 0, scale: 0 })).toBe('nvarchar(max)')
    expect(typeText({ type: 'datetimeoffset', maxLength: 10, precision: 34, scale: 7 })).toBe('datetimeoffset(7)')
    expect(() => typeText({ type: 'geography', maxLength: -1, precision: 0, scale: 0 })).toThrow(/geography/)
    const broken = { ...newest, identities: [...newest.identities, 'internal.event_messages.event_message_id'] }
    expect(() => renderFakeSchema(broken)).toThrow(/identity but nullable/)
  })

  it('keeps the stub procedures to the real signatures', () => {
    const found = stubs(read('./fixtures/ssisdb/procedures.sql'))
    const real = [...found.keys()].filter((name) => !name.startsWith('varia_')).sort()
    expect(real).toEqual(['create_execution', 'set_execution_parameter_value', 'start_execution', 'stop_operation'])
    for (const name of real) {
      const expected = newest.procedures[name].map((item) => `${item.name} ${typeText({ ...item, precision: 0, scale: 0 })}${item.output ? ' OUTPUT' : ''}`)
      expect(found.get(name), name).toEqual(expected)
      expect(newest.sqlAuthRefused, name).toContain(name)
    }
  })

  // The facts docs/integration-services.md records as verified from SQL Server 2025's catalog; a manifest that stops
  // proving one fails here, so the page is corrected with it.
  it('proves what the Verified on section says', () => {
    const keys = new Map(newest.foreignKeys.map((key) => [key.name, key]))
    expect(keys.get('FK_EventMessages_OperationMessageId_OperationMessage')).toMatchObject({ child: 'internal.event_messages', parent: 'internal.operation_messages', columns: ['event_message_id -> operation_message_id'] })
    expect(keys.get('FK_Executions_ExecutionId_Operations')).toMatchObject({ child: 'internal.executions', parent: 'internal.operations', onDelete: 'CASCADE', columns: ['execution_id -> operation_id'] })
    expect(keys.get('FK_Validations_ValidationId_Operations')).toMatchObject({ child: 'internal.validations', parent: 'internal.operations', columns: ['validation_id -> operation_id'] })
    expect(newest.identities).toContain('internal.operation_messages.operation_message_id')
    expect(newest.identities.some((name) => name.startsWith('internal.event_messages.'))).toBe(false)
    const indexes = (table: string) => newest.indexes.filter((index) => index.table === `internal.${table}`).map((index) => `${index.name}(${index.keys.join(',')})`).sort()
    expect(indexes('operation_messages')).toEqual(['IX_OperationMessages_Operation_id(operation_id)', 'PK_Operation_Messages(operation_message_id)'])
    expect(indexes('event_messages')).toEqual(['IX_EventMessages_Operation_id(operation_id)', 'PK_Event_Messages(event_message_id)'])
    expect(indexes('executable_statistics')).toEqual(['IX_ExecutableStatistics_Execution_id(execution_id)', 'PK_Executable_statistics(statistics_id)'])
    expect(newest.views.event_messages.map((item) => item.name)).toContain('event_message_guid')
    expect(newest.database).toEqual({ compatibilityLevel: 170, readCommittedSnapshot: false, collation: 'SQL_Latin1_General_CP1_CI_AS' })
    expect(newest.properties).toMatchObject({ RETENTION_WINDOW: '365', MAX_PROJECT_VERSIONS: '10', SERVER_LOGGING_LEVEL: '1', OPERATION_CLEANUP_ENABLED: 'TRUE', VERSION_CLEANUP_ENABLED: 'TRUE', SCHEMA_VERSION: '8' })
    expect(newest.properties).not.toHaveProperty('VALIDATION_TIMEOUT')
    for (const name of ['create_execution', 'start_execution', 'stop_operation', 'validate_project', 'validate_package', 'deploy_project', 'create_folder', 'rename_folder',
      'set_object_parameter_value', 'create_environment', 'set_environment_variable_value', 'configure_catalog', 'grant_permission', 'get_project', 'restore_project']) {
      expect(newest.sqlAuthRefused, name).toContain(name)
    }
    for (const name of ['get_parameter_values', 'create_customized_logging_level', 'startup']) expect(newest.sqlAuthRefused, name).not.toContain(name)
    expect(newest.procedures.check_schema_version).toEqual([{ name: '@use32bitruntime', type: 'smallint', maxLength: 2, output: false }])
    expect(newest.functions.get_operation_log_size).toEqual([{ name: '', type: 'bigint', maxLength: 8, output: true }])
    expect(newest.typeMapping.String).toEqual(['char', 'nchar', 'nvarchar'])
    expect(newest.errors['27123']).toMatch(/SQL Server Authentication/)
  })

  it('documents every unverified item of D-ssis 14 in the Verified on section', () => {
    const docs = read('../docs/integration-services.md')
    const section = docs.slice(docs.indexOf('## Verified on'))
    expect(section.length).toBeGreaterThan(0)
    for (let item = 1; item <= 12; item++) expect(section, `14.${item}`).toMatch(new RegExp(`\\| 14\\.${item} \\|`))
    expect(docs).toContain(`schema version ${newest.schemaVersion}`)
    expect(docs).toContain(newest.productVersion)
  })
})
