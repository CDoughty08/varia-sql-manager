import { describe, expect, it } from 'vitest'
import {
  defaultScriptingOptions, parseStoredScriptingOptions, scriptingOptionDef, scriptingOptionDefs, scriptingOptionGroupLabels, scriptingOptionGroups, scriptingOptionKeys,
  scriptingOptionsSchema, storedScriptingOptions, type ScriptingOptionDef
} from '../src/shared/scripting/options'

// Spec B7: group, key, label, default; a second value is the docs page's default where SSMS's Script As differs.
const b7: readonly (readonly [string, string, string, boolean | string, boolean?])[] = [
  ['general', 'delimitStatements', 'Delimit individual statements', true, false],
  ['general', 'includeHeaders', 'Include descriptive headers', true],
  ['general', 'includeVarDecimal', 'Include enabling vardecimal compression', false],
  ['general', 'scriptChangeTracking', 'Script change tracking', false],
  ['general', 'scriptFullTextCatalogs', 'Script full-text catalogs', false],
  ['general', 'scriptUseDatabase', 'Script USE <database>', true],
  ['object', 'checkExistence', 'Check for object existence', false],
  ['object', 'generateDependentObjects', 'Generate script for dependent objects', false],
  ['object', 'schemaQualify', 'Schema qualify object names', true, false],
  ['object', 'scriptDataCompression', 'Script data compression options', false],
  ['object', 'scriptExtendedProperties', 'Script extended properties', true, false],
  ['object', 'scriptOwner', 'Script owner', false],
  ['object', 'scriptPermissions', 'Script permissions', false, true],
  ['tableView', 'convertUserDefinedDataTypes', 'Convert user-defined data types to base types', false],
  ['tableView', 'generateAnsiPadding', 'Generate SET ANSI PADDING commands', true],
  ['tableView', 'includeCollation', 'Include collation', false, true],
  ['tableView', 'includeIdentity', 'Include IDENTITY property', true],
  ['tableView', 'schemaQualifyForeignKeys', 'Schema qualify foreign key references', true],
  ['tableView', 'scriptBindings', 'Script bound defaults and rules', true],
  ['tableView', 'scriptCheckConstraints', 'Script CHECK constraints', true],
  ['tableView', 'scriptDefaults', 'Script defaults', true, false],
  ['tableView', 'scriptFileGroups', 'Script file groups', true, false],
  ['tableView', 'scriptForeignKeys', 'Script foreign keys', true, false],
  ['tableView', 'scriptFullTextIndexes', 'Script full-text indexes', false],
  ['tableView', 'scriptIndexes', 'Script indexes', true],
  ['tableView', 'scriptPartitionSchemes', 'Script partition schemes', false],
  ['tableView', 'scriptPrimaryKeys', 'Script primary keys', true],
  ['tableView', 'scriptStatistics', 'Script statistics', false],
  ['tableView', 'scriptTriggers', 'Script triggers', false],
  ['tableView', 'scriptUniqueKeys', 'Script unique keys', true, false],
  ['tableView', 'scriptViewColumns', 'Script view columns', false],
  ['tableView', 'includeDriSystemNames', 'Include DRI system names', false],
  ['version', 'matchSourceSettings', 'Match script settings to source', true],
  ['version', 'targetEngineEdition', 'Script for database engine edition', 'enterprise'],
  ['version', 'targetEngineType', 'Script for database engine type', 'standalone'],
  ['version', 'targetServerVersion', 'Script for server version', '160']
]
const defs = scriptingOptionDefs as readonly ScriptingOptionDef[]
const valid = (value: unknown) => scriptingOptionsSchema.safeParse(value).success

describe('scripting options', () => {
  it('lists the 36 options of the docs page in its groups and order, with SSMS\'s Script As defaults', () => {
    expect(defs.map(def => [def.group, def.key, def.label, def.default, ...def.type === 'boolean' && def.docsDefault !== undefined ? [def.docsDefault] : []])).toEqual(b7)
    expect(scriptingOptionKeys).toEqual(b7.map(row => row[1]))
    expect(scriptingOptionGroups.map(group => scriptingOptionGroupLabels[group])).toEqual(['General scripting options', 'Object scripting options', 'Table/View options', 'Version options'])
    expect([...new Set(defs.map(def => def.group))]).toEqual([...scriptingOptionGroups])
    expect(Object.keys(defaultScriptingOptions)).toEqual(scriptingOptionKeys)
    expect(defaultScriptingOptions).toEqual(Object.fromEntries(b7.map(row => [row[1], row[3]])))
    expect(Object.isFrozen(defaultScriptingOptions)).toBe(true)
  })
  it('keeps the docs default beside each of the nine defaults that follow SSMS instead', () => {
    const changed = defs.filter(def => def.type === 'boolean' && def.docsDefault !== undefined)
    expect(changed.map(def => def.key)).toEqual(['delimitStatements', 'schemaQualify', 'scriptExtendedProperties', 'scriptPermissions', 'includeCollation', 'scriptDefaults',
      'scriptFileGroups', 'scriptForeignKeys', 'scriptUniqueKeys'])
    for (const def of changed) expect(def.type === 'boolean' && def.docsDefault, def.key).toBe(!def.default)
  })
  it('describes every option and offers SSMS\'s version choices, greyed while matching the source', () => {
    for (const def of defs) {
      expect(def.description, def.key).toMatch(/^[A-Z].*\.$/)
      expect(def.smo.length, def.key).toBeGreaterThan(0)
      expect(def.label, def.key).toMatch(/^\S(.*\S)?$/)
      if (def.disabledWhen) expect(scriptingOptionDef(def.disabledWhen as never).type, def.key).toBe('boolean')
      if (def.type !== 'enum') continue
      expect(def.values.map(item => item.value), def.key).toContain(def.default)
      expect(new Set(def.values.map(item => item.value)).size, def.key).toBe(def.values.length)
    }
    expect(defs.filter(def => def.disabledWhen).map(def => `${def.key} ${def.disabledWhen}`)).toEqual([
      'targetEngineEdition matchSourceSettings', 'targetEngineType matchSourceSettings', 'targetServerVersion matchSourceSettings'
    ])
    const values = (key: Parameters<typeof scriptingOptionDef>[0]) => { const def = scriptingOptionDef(key); return def.type === 'enum' ? def.values.map(item => `${item.value} ${item.label}`) : [] }
    expect(values('targetEngineEdition')).toEqual(['personal Microsoft SQL Server Personal Edition', 'standard Microsoft SQL Server Standard Edition',
      'enterprise Microsoft SQL Server Enterprise Edition', 'express Microsoft SQL Server Express Edition'])
    expect(values('targetEngineType')).toEqual(['standalone Stand-alone instance'])
    expect(values('targetServerVersion')).toEqual(['130 SQL Server 2016', '140 SQL Server 2017', '150 SQL Server 2019', '160 SQL Server 2022', '170 SQL Server 2025'])
  })
  it('validates a complete set strictly', () => {
    expect(valid(defaultScriptingOptions)).toBe(true)
    expect(valid({ ...defaultScriptingOptions, scriptUseDatabase: false, matchSourceSettings: false, targetEngineEdition: 'express', targetServerVersion: '130' })).toBe(true)
    for (const key of scriptingOptionKeys) {
      const { [key]: _, ...missing } = defaultScriptingOptions
      expect(valid(missing), key).toBe(false)
      expect(valid({ ...defaultScriptingOptions, [key]: null }), key).toBe(false)
      expect(valid({ ...defaultScriptingOptions, [key]: 'True' }), key).toBe(false)
    }
    expect(valid({ ...defaultScriptingOptions, scriptData: false })).toBe(false)
    expect(valid({ ...defaultScriptingOptions, targetServerVersion: 160 })).toBe(false)
    expect(valid({ ...defaultScriptingOptions, targetServerVersion: '120' })).toBe(false)
    expect(valid({ ...defaultScriptingOptions, targetEngineType: 'sqlAzureDatabase' })).toBe(false)
    expect(valid(null)).toBe(false)
    expect(valid([])).toBe(false)
  })
})

describe('stored scripting options', () => {
  const stored = (options: unknown, extra: object = {}) => ({ version: 1, options, ...extra })
  it('round-trips a valid file', () => {
    const options = { ...defaultScriptingOptions, scriptOwner: true, targetServerVersion: '170' as const }
    expect(storedScriptingOptions(options)).toEqual({ version: 1, options })
    expect(parseStoredScriptingOptions(JSON.parse(JSON.stringify(storedScriptingOptions(options))))).toEqual(options)
    expect(() => storedScriptingOptions({ ...options, scriptOwner: 'yes' } as never)).toThrow()
  })
  it('drops options it does not know and fills the ones a file lacks', () => {
    expect(parseStoredScriptingOptions(stored({ scriptOwner: true, scriptData: true, futureOption: 'x' }))).toEqual({ ...defaultScriptingOptions, scriptOwner: true })
    expect(parseStoredScriptingOptions(stored({}))).toEqual(defaultScriptingOptions)
    const parsed = parseStoredScriptingOptions(JSON.parse('{"version":1,"options":{"__proto__":{"scriptOwner":true},"constructor":1}}'))
    expect(parsed).toEqual(defaultScriptingOptions)
    expect(Object.keys(parsed!)).toEqual(scriptingOptionKeys)
  })
  it('rejects a file with a wrong value, version or shape', () => {
    expect(parseStoredScriptingOptions(stored({ scriptOwner: 'true' }))).toBeUndefined()
    expect(parseStoredScriptingOptions(stored({ targetServerVersion: '100' }))).toBeUndefined()
    expect(parseStoredScriptingOptions(stored({ scriptOwner: null }))).toBeUndefined()
    expect(parseStoredScriptingOptions(stored(defaultScriptingOptions, { extra: true }))).toBeUndefined()
    expect(parseStoredScriptingOptions({ version: 2, options: defaultScriptingOptions })).toBeUndefined()
    expect(parseStoredScriptingOptions({ options: defaultScriptingOptions })).toBeUndefined()
    for (const options of [null, [], 'x', 1, undefined]) expect(parseStoredScriptingOptions(stored(options)), JSON.stringify(options)).toBeUndefined()
    for (const value of [null, [], 'x', 1, undefined, defaultScriptingOptions]) expect(parseStoredScriptingOptions(value), JSON.stringify(value)).toBeUndefined()
  })
})
