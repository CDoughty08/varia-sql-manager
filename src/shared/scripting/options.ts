// Script As options: SSMS's Tools › Options › SQL Server Object Explorer › Scripting page, with its groups, labels and
// order. Defaults follow what SSMS's Script As produces; where the docs page says otherwise, `docsDefault` keeps its
// value. Every request carries a complete set, so the backend stays stateless. Erasable TypeScript, like catalog.ts.
import { z } from 'zod'

export const scriptingOptionGroups = ['general', 'object', 'tableView', 'version'] as const
export type ScriptingOptionGroup = typeof scriptingOptionGroups[number]
export const scriptingOptionGroupLabels: { readonly [G in ScriptingOptionGroup]: string } = {
  general: 'General scripting options', object: 'Object scripting options', tableView: 'Table/View options', version: 'Version options'
}

interface OptionBase {
  readonly key: string
  readonly group: ScriptingOptionGroup
  /** The docs page's label. */
  readonly label: string
  /** What the option does, for the Options dialog's description pane and docs/scripting.md. */
  readonly description: string
  /** How the backend applies it: SMO `ScriptingOptions` members, or the script formatter and templates. */
  readonly smo: string
  /** The option is greyed, and ignored, while this boolean option is True. */
  readonly disabledWhen?: string
}
export interface BooleanOptionDef extends OptionBase {
  readonly type: 'boolean'
  readonly default: boolean
  /** The docs page's default, where SSMS's Script As output follows a different one. */
  readonly docsDefault?: boolean
}
export interface EnumOptionDef extends OptionBase {
  readonly type: 'enum'
  readonly values: readonly { readonly value: string; readonly label: string }[]
  readonly default: string
}
export type ScriptingOptionDef = BooleanOptionDef | EnumOptionDef

const versionOptions = 'Used when Match script settings to source is False.'
/** The 36 options in the docs page's order. */
export const scriptingOptionDefs = [
  {
    key: 'delimitStatements', group: 'general', label: 'Delimit individual statements', type: 'boolean', default: true, docsDefault: false, smo: 'Formatter: `GO` after each batch',
    description: 'Separates the statements of the script with the batch separator, GO.'
  },
  {
    key: 'includeHeaders', group: 'general', label: 'Include descriptive headers', type: 'boolean', default: true, smo: '`IncludeHeaders` (left out when a name contains `/*` or `*/`)',
    description: 'Adds a comment before each object\'s script that names the object and the date the script was generated.'
  },
  {
    key: 'includeVarDecimal', group: 'general', label: 'Include enabling vardecimal compression', type: 'boolean', default: false, smo: '`NoVardecimal = !value`',
    description: 'Includes the statements that enable the vardecimal storage format on tables that use it.'
  },
  {
    key: 'scriptChangeTracking', group: 'general', label: 'Script change tracking', type: 'boolean', default: false, smo: '`ChangeTracking`',
    description: 'Includes the change tracking settings of tables and databases that use change tracking.'
  },
  {
    key: 'scriptFullTextCatalogs', group: 'general', label: 'Script full-text catalogs', type: 'boolean', default: false, smo: '`FullTextCatalogs`',
    description: 'Includes full-text catalogs.'
  },
  {
    key: 'scriptUseDatabase', group: 'general', label: 'Script USE <database>', type: 'boolean', default: true, smo: '`IncludeDatabaseContext`; templates add `USE`',
    description: 'Starts the script with a USE statement, so it runs in the object\'s database. Turn it off for a script meant for another database.'
  },
  {
    key: 'checkExistence', group: 'object', label: 'Check for object existence', type: 'boolean', default: false, smo: '`IncludeIfNotExists`',
    description: 'Runs each statement only when the object exists (for DROP and ALTER) or does not exist yet (for CREATE).'
  },
  {
    key: 'generateDependentObjects', group: 'object', label: 'Generate script for dependent objects', type: 'boolean', default: false, smo: '`WithDependencies`',
    description: 'Also scripts the objects that must exist before the selected object\'s script can run.'
  },
  {
    key: 'schemaQualify', group: 'object', label: 'Schema qualify object names', type: 'boolean', default: true, docsDefault: false, smo: '`SchemaQualify`; templates',
    description: 'Prefixes object names with their schema.'
  },
  {
    key: 'scriptDataCompression', group: 'object', label: 'Script data compression options', type: 'boolean', default: false, smo: '`ScriptDataCompression`, `ScriptXmlCompression`',
    description: 'Includes the data compression and XML compression settings of tables and indexes.'
  },
  {
    key: 'scriptExtendedProperties', group: 'object', label: 'Script extended properties', type: 'boolean', default: true, docsDefault: false, smo: '`ExtendedProperties`',
    description: 'Includes the object\'s extended properties.'
  },
  {
    key: 'scriptOwner', group: 'object', label: 'Script owner', type: 'boolean', default: false, smo: '`ScriptOwner`',
    description: 'Includes the object\'s owner.'
  },
  {
    key: 'scriptPermissions', group: 'object', label: 'Script permissions', type: 'boolean', default: false, docsDefault: true, smo: '`Permissions`',
    description: 'Includes the permissions granted or denied on the object.'
  },
  {
    key: 'convertUserDefinedDataTypes', group: 'tableView', label: 'Convert user-defined data types to base types', type: 'boolean', default: false, smo: '`ConvertUserDefinedDataTypesToBaseType`',
    description: 'Replaces user-defined data types with the base types they are built on.'
  },
  {
    key: 'generateAnsiPadding', group: 'tableView', label: 'Generate SET ANSI PADDING commands', type: 'boolean', default: true, smo: '`AnsiPadding`',
    description: 'Surrounds CREATE TABLE statements with SET ANSI_PADDING statements.'
  },
  {
    key: 'includeCollation', group: 'tableView', label: 'Include collation', type: 'boolean', default: false, docsDefault: true, smo: '`NoCollation = !value`',
    description: 'Includes each column\'s collation.'
  },
  {
    key: 'includeIdentity', group: 'tableView', label: 'Include IDENTITY property', type: 'boolean', default: true, smo: '`NoIdentities = !value`',
    description: 'Includes the IDENTITY property, with its seed and increment.'
  },
  {
    key: 'schemaQualifyForeignKeys', group: 'tableView', label: 'Schema qualify foreign key references', type: 'boolean', default: true, smo: '`SchemaQualifyForeignKeysReferences`',
    description: 'Prefixes the table a foreign key references with its schema.'
  },
  {
    key: 'scriptBindings', group: 'tableView', label: 'Script bound defaults and rules', type: 'boolean', default: true, smo: '`Bindings`',
    description: 'Includes the sp_bindefault and sp_bindrule statements of defaults and rules bound to columns.'
  },
  {
    key: 'scriptCheckConstraints', group: 'tableView', label: 'Script CHECK constraints', type: 'boolean', default: true, smo: '`DriChecks`',
    description: 'Includes CHECK constraints.'
  },
  {
    key: 'scriptDefaults', group: 'tableView', label: 'Script defaults', type: 'boolean', default: true, docsDefault: false, smo: '`DriDefaults`',
    description: 'Includes column default constraints.'
  },
  {
    key: 'scriptFileGroups', group: 'tableView', label: 'Script file groups', type: 'boolean', default: true, docsDefault: false, smo: '`NoFileGroup = !value`',
    description: 'Includes the ON <filegroup> clause of tables and indexes.'
  },
  {
    key: 'scriptForeignKeys', group: 'tableView', label: 'Script foreign keys', type: 'boolean', default: true, docsDefault: false, smo: '`DriForeignKeys`',
    description: 'Includes foreign keys.'
  },
  {
    key: 'scriptFullTextIndexes', group: 'tableView', label: 'Script full-text indexes', type: 'boolean', default: false, smo: '`FullTextIndexes`',
    description: 'Includes full-text indexes.'
  },
  {
    key: 'scriptIndexes', group: 'tableView', label: 'Script indexes', type: 'boolean', default: true, smo: '`Indexes` (clustered, nonclustered, XML, spatial and columnstore)',
    description: 'Includes clustered, nonclustered, XML, spatial and columnstore indexes.'
  },
  {
    key: 'scriptPartitionSchemes', group: 'tableView', label: 'Script partition schemes', type: 'boolean', default: false, smo: '`NoTablePartitioningSchemes = NoIndexPartitioningSchemes = !value`',
    description: 'Includes the partition scheme clause of partitioned tables and indexes.'
  },
  {
    key: 'scriptPrimaryKeys', group: 'tableView', label: 'Script primary keys', type: 'boolean', default: true, smo: '`DriPrimaryKey`',
    description: 'Includes primary keys.'
  },
  {
    key: 'scriptStatistics', group: 'tableView', label: 'Script statistics', type: 'boolean', default: false, smo: '`Statistics`; `OptimizerData = false`',
    description: 'Includes statistics, without their histograms.'
  },
  {
    key: 'scriptTriggers', group: 'tableView', label: 'Script triggers', type: 'boolean', default: false, smo: '`Triggers`',
    description: 'Includes the DML triggers of tables and views.'
  },
  {
    key: 'scriptUniqueKeys', group: 'tableView', label: 'Script unique keys', type: 'boolean', default: true, docsDefault: false, smo: '`DriUniqueKeys`',
    description: 'Includes unique keys.'
  },
  {
    key: 'scriptViewColumns', group: 'tableView', label: 'Script view columns', type: 'boolean', default: false, smo: '`NoViewColumns = !value`',
    description: 'Lists a view\'s column names in its CREATE VIEW header.'
  },
  {
    key: 'includeDriSystemNames', group: 'tableView', label: 'Include DRI system names', type: 'boolean', default: false, smo: '`DriIncludeSystemNames`',
    description: 'Includes the names of constraints whose names SQL Server generated.'
  },
  {
    key: 'matchSourceSettings', group: 'version', label: 'Match script settings to source', type: 'boolean', default: true,
    smo: 'True: `TargetServerVersion`, `TargetDatabaseEngineEdition` and `TargetDatabaseEngineType` follow the server',
    description: 'Scripts for the version, edition and engine type of the object\'s server. Turn it off to choose them below.'
  },
  {
    key: 'targetEngineEdition', group: 'version', label: 'Script for database engine edition', type: 'enum', default: 'enterprise', disabledWhen: 'matchSourceSettings',
    values: [
      { value: 'personal', label: 'Microsoft SQL Server Personal Edition' }, { value: 'standard', label: 'Microsoft SQL Server Standard Edition' },
      { value: 'enterprise', label: 'Microsoft SQL Server Enterprise Edition' }, { value: 'express', label: 'Microsoft SQL Server Express Edition' }
    ],
    smo: '`TargetDatabaseEngineEdition`', description: 'The database engine edition the script is for. ' + versionOptions
  },
  {
    key: 'targetEngineType', group: 'version', label: 'Script for database engine type', type: 'enum', default: 'standalone', disabledWhen: 'matchSourceSettings',
    values: [{ value: 'standalone', label: 'Stand-alone instance' }],
    smo: '`TargetDatabaseEngineType`', description: 'The database engine type the script is for. ' + versionOptions
  },
  {
    key: 'targetServerVersion', group: 'version', label: 'Script for server version', type: 'enum', default: '160', disabledWhen: 'matchSourceSettings',
    values: [
      { value: '130', label: 'SQL Server 2016' }, { value: '140', label: 'SQL Server 2017' }, { value: '150', label: 'SQL Server 2019' },
      { value: '160', label: 'SQL Server 2022' }, { value: '170', label: 'SQL Server 2025' }
    ],
    smo: '`TargetServerVersion = Version<value>`', description: 'The SQL Server version the script is for; features it lacks cannot be scripted. ' + versionOptions
  }
] as const satisfies readonly ScriptingOptionDef[]

type Def = typeof scriptingOptionDefs[number]
export type ScriptingOptionKey = Def['key']
type ValueOf<D> = D extends { readonly type: 'enum'; readonly values: readonly { readonly value: infer V }[] } ? V : boolean
/** One value per option: a boolean, or one of an enum option's values. */
export type ScriptingOptions = { readonly [D in Def as D['key']]: ValueOf<D> }
export const scriptingOptionKeys: readonly ScriptingOptionKey[] = scriptingOptionDefs.map(def => def.key)
export const scriptingOptionDef = (key: ScriptingOptionKey): ScriptingOptionDef => scriptingOptionDefs.find(def => def.key === key)!

export const defaultScriptingOptions: ScriptingOptions = Object.freeze(Object.fromEntries(scriptingOptionDefs.map(def => [def.key, def.default])) as ScriptingOptions)

const valueSchema = (def: ScriptingOptionDef) => def.type === 'boolean' ? z.boolean() : z.enum(def.values.map(item => item.value) as [string, ...string[]])
/** Every option, and nothing else: requests to the backend and writes to the options file use it. */
export const scriptingOptionsSchema = z.object(Object.fromEntries(scriptingOptionDefs.map(def => [def.key, valueSchema(def)]))).strict() as unknown as z.ZodType<ScriptingOptions>

/** What `<userData>/scripting-options.json` holds. */
export interface StoredScriptingOptions { readonly version: 1; readonly options: ScriptingOptions }
export const storedScriptingOptions = (options: ScriptingOptions): StoredScriptingOptions => ({ version: 1, options: scriptingOptionsSchema.parse(options) })
const storedSchema = z.object({ version: z.literal(1), options: z.unknown() }).strict()
/**
 * The options in a stored file, or undefined when the file is invalid. Options a newer version added are dropped and
 * missing ones take their defaults, so files move between versions; a value of the wrong type is invalid.
 */
export function parseStoredScriptingOptions(value: unknown): ScriptingOptions | undefined {
  const stored = storedSchema.safeParse(value)
  const source = stored.success ? stored.data.options : undefined
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  const options: Record<string, unknown> = {}
  for (const def of scriptingOptionDefs) {
    // Own properties only, so a stored `__proto__` is just another unknown option.
    if (!Object.hasOwn(source, def.key)) { options[def.key] = def.default; continue }
    const parsed = valueSchema(def).safeParse((source as Record<string, unknown>)[def.key])
    if (!parsed.success) return undefined
    options[def.key] = parsed.data
  }
  return options as ScriptingOptions
}
