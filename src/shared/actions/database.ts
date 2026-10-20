// Database Properties' option data: every row of SSMS's Options page (labels as Microsoft Learn's "Database Properties
// (Options Page)" words them), which ones Varia changes, how SQL Server spells each value, the order SMO's
// Database.ScriptAlter writes them in, and the system databases SQL Server refuses them on. The renderer builds the page
// from it, zod validates requests against it, and the backend embeds it (actionsCatalogJson's databaseOptions and
// scopedConfigurations), so C# holds no option rules of its own. Erasable TypeScript, loadable by Node's type stripping.

export type OptionCategory = 'header' | 'Automatic' | 'Containment' | 'Cursor' | 'Database Scoped Configurations' | 'FILESTREAM' | 'Ledger' | 'Miscellaneous' | 'Recovery'
  | 'Service Broker' | 'State'
export type SystemDatabase = 'master' | 'model' | 'msdb' | 'tempdb'
export interface OptionChoice { readonly token: string; readonly label: string }
/**
 * How C# writes a change. 'set': `ALTER DATABASE [db] SET <keyword> <=?><sql text>`, with SMO's termination when
 * `termination`; 'compat', 'collate', 'autoCreateStats' (with Auto Create Incremental Statistics), 'snapshotIsolation'
 * (SSMS's SetSnapshotIsolation, after everything else), 'filestream' (NON_TRANSACTED_ACCESS) and 'scoped' (ALTER DATABASE
 * SCOPED CONFIGURATION in the database) have their own forms. `seconds` appends SMO's " SECONDS" to an integer. A scoped
 * configuration's ON, OFF and PRIMARY are written as SMO's DatabaseScopedConfigurationOnOff names (On, Off, Primary), as
 * its LegacyCardinalityEstimation, ParameterSniffing and QueryOptimizerHotfixes properties do.
 */
export type OptionSql =
  | { readonly kind: 'set'; readonly keyword: string; readonly eq: boolean; readonly tokens?: Readonly<Record<string, string>>; readonly termination: boolean; readonly seconds?: boolean }
  | { readonly kind: 'compat' | 'collate' | 'autoCreateStats' | 'snapshotIsolation' | 'filestream' }
  | { readonly kind: 'scoped'; readonly name: string; readonly secondary: boolean; readonly tokens?: Readonly<Record<string, string>> }
export interface DatabaseOptionDef {
  readonly key: string
  readonly label: string
  readonly category: OptionCategory
  readonly description: string
  /** 'bool' shows True and False; 'text' is read-only text. */
  readonly control: 'bool' | 'choice' | 'integer' | 'text'
  readonly choices?: readonly OptionChoice[]
  /** An integer's bounds; with choices too ('PRIMARY' or a number), either is accepted. */
  readonly range?: { readonly min: number; readonly max: number }
  /** Whether Varia changes it; the rest show read-only, as SSMS shows some, or until a follow-up. */
  readonly settable: boolean
  /** The version band (13 = SQL Server 2016 … 17 = 2025) it appears from. */
  readonly since?: number
  /** System databases SQL Server refuses the change on, per Learn's master, model, msdb and tempdb pages ("Can be modified: No"). */
  readonly notOn?: readonly SystemDatabase[]
  /** SSMS closes other connections to change it (its Open Connections prompt). */
  readonly exclusive?: true
  readonly sql?: OptionSql
  /** Where SMO's ScriptAlter writes it: a strict total order over every option. */
  readonly smoOrder: number
}

const bool: readonly OptionChoice[] = [{ token: 'true', label: 'True' }, { token: 'false', label: 'False' }]
const onOff: Readonly<Record<string, string>> = { true: 'ON', false: 'OFF' }
const set = (keyword: string, tokens = onOff, eq = false): OptionSql => ({ kind: 'set', keyword, eq, tokens, termination: true })
const choices = (...items: (readonly [string, string])[]): readonly OptionChoice[] => items.map(([token, label]) => ({ token, label }))
const keywords = (items: readonly OptionChoice[]): Readonly<Record<string, string>> => Object.fromEntries(items.map(item => [item.token, item.token]))
const all: readonly SystemDatabase[] = ['master', 'model', 'msdb', 'tempdb']

const recovery = choices(['FULL', 'Full'], ['BULK_LOGGED', 'Bulk-logged'], ['SIMPLE', 'Simple'])
const containment = choices(['NONE', 'None'], ['PARTIAL', 'Partial'])
const cursor = choices(['GLOBAL', 'GLOBAL'], ['LOCAL', 'LOCAL'])
const durability = choices(['DISABLED', 'Disabled'], ['ALLOWED', 'Allowed'], ['FORCED', 'Forced'])
const parameterization = choices(['SIMPLE', 'Simple'], ['FORCED', 'Forced'])
const pageVerify = choices(['CHECKSUM', 'CHECKSUM'], ['TORN_PAGE_DETECTION', 'TORN_PAGE_DETECTION'], ['NONE', 'NONE'])
const access = choices(['MULTI_USER', 'MULTI_USER'], ['RESTRICTED_USER', 'RESTRICTED_USER'], ['SINGLE_USER', 'SINGLE_USER'])
const filestreamAccess = choices(['OFF', 'Off'], ['READ_ONLY', 'ReadOnly'], ['FULL', 'Full'])
const dscOnOff = choices(['ON', 'ON'], ['OFF', 'OFF'])
const dscSecondary = choices(['PRIMARY', 'PRIMARY'], ['ON', 'ON'], ['OFF', 'OFF'])
const smoOnOff: Readonly<Record<string, string>> = { ON: 'On', OFF: 'Off', PRIMARY: 'Primary' }

/** SQL Server's compatibility levels from SQL Server 2008's, the oldest a 2016 server accepts (Learn, ALTER DATABASE Compatibility Level). */
export const compatibilityLevels = [100, 110, 120, 130, 140, 150, 160, 170] as const
const products: Readonly<Record<number, string>> = { 100: '2008', 110: '2012', 120: '2014', 130: '2016', 140: '2017', 150: '2019', 160: '2022', 170: '2025' }
/** SSMS's label for a compatibility level: "SQL Server 2022 (160)"; an older level shows its number only. */
export const compatibilityLabel = (level: number): string => products[level] ? `SQL Server ${products[level]} (${level})` : `(${level})`
/** The levels a server of `major` version offers: 100 up to its own (Major × 10, capped at 170). */
export const compatibilityLevelsFor = (major: number): number[] => compatibilityLevels.filter(level => level <= Math.min(major * 10, 170))

/** Every row of the Options page, in SSMS's order within each category. */
export const databaseOptionDefs: readonly DatabaseOptionDef[] = [
  // Header fields above the grid.
  { key: 'collation', label: 'Collation', category: 'header', control: 'choice', settable: true, notOn: all, sql: { kind: 'collate' }, smoOrder: 3,
    description: 'Specify the collation of the database by selecting from the list. For more information, see Set or Change the Database Collation.' },
  { key: 'recoveryModel', label: 'Recovery model', category: 'header', control: 'choice', choices: recovery, settable: true, notOn: ['tempdb'], sql: set('RECOVERY', keywords(recovery)), smoOrder: 29,
    description: 'Specify one of the following models for recovering the database: Full, Bulk-Logged, or Simple. For more information, see Recovery Models.' },
  { key: 'compatibilityLevel', label: 'Compatibility level', category: 'header', control: 'choice', choices: compatibilityLevels.map(level => ({ token: String(level), label: compatibilityLabel(level) })),
    settable: true, sql: { kind: 'compat' }, smoOrder: 2, description: 'Specify the latest version of SQL Server that the database supports.' },
  { key: 'containmentType', label: 'Containment type', category: 'header', control: 'choice', choices: containment, settable: true, notOn: ['tempdb'],
    sql: { kind: 'set', keyword: 'CONTAINMENT', eq: true, tokens: keywords(containment), termination: true }, smoOrder: 1,
    description: 'Specify none or partial to designate if this is a contained database. For more information, see Contained Databases.' },
  // Automatic.
  { key: 'autoClose', label: 'Auto Close', category: 'Automatic', control: 'bool', choices: bool, settable: true, notOn: ['master', 'tempdb'], sql: set('AUTO_CLOSE'), smoOrder: 9,
    description: 'Specify whether the database shuts down cleanly and frees resources after the last user exits.' },
  { key: 'autoCreateIncrementalStatistics', label: 'Auto Create Incremental Statistics', category: 'Automatic', control: 'bool', choices: bool, settable: true, sql: { kind: 'autoCreateStats' }, smoOrder: 12,
    description: 'Specify whether to use the incremental option when per-partition statistics are created.' },
  { key: 'autoCreateStatistics', label: 'Auto Create Statistics', category: 'Automatic', control: 'bool', choices: bool, settable: true, sql: { kind: 'autoCreateStats' }, smoOrder: 11,
    description: 'Specify whether the database automatically creates missing optimization statistics.' },
  { key: 'autoShrink', label: 'Auto Shrink', category: 'Automatic', control: 'bool', choices: bool, settable: true, notOn: ['master', 'tempdb'], sql: set('AUTO_SHRINK'), smoOrder: 10,
    description: 'Specify whether the database files are candidates for periodic shrinking.' },
  { key: 'autoUpdateStatistics', label: 'Auto Update Statistics', category: 'Automatic', control: 'bool', choices: bool, settable: true, sql: set('AUTO_UPDATE_STATISTICS'), smoOrder: 13,
    description: 'Specify whether the database automatically updates out-of-date optimization statistics.' },
  { key: 'autoUpdateStatisticsAsync', label: 'Auto Update Statistics Asynchronously', category: 'Automatic', control: 'bool', choices: bool, settable: true,
    sql: set('AUTO_UPDATE_STATISTICS_ASYNC'), smoOrder: 21,
    description: 'When True, queries that initiate an automatic update of out-of-date statistics will not wait for the statistics to be updated before compiling.' },
  // Containment: read-only here, shown for a partially contained database.
  { key: 'defaultFulltextLanguageLcid', label: 'Default Fulltext Language LCID', category: 'Containment', control: 'text', settable: false, smoOrder: 33,
    description: 'Specifies a default language value for full-text indexed columns.' },
  { key: 'defaultLanguage', label: 'Default Language', category: 'Containment', control: 'text', settable: false, smoOrder: 34,
    description: 'The default language for all new contained database users, unless otherwise specified.' },
  { key: 'nestedTriggersEnabled', label: 'Nested Triggers Enabled', category: 'Containment', control: 'bool', choices: bool, settable: false, smoOrder: 35,
    description: 'Allows triggers to fire other triggers. Triggers can be nested to a maximum of 32 levels.' },
  { key: 'transformNoiseWords', label: 'Transform Noise Words', category: 'Containment', control: 'bool', choices: bool, settable: false, smoOrder: 36,
    description: 'Suppress an error message if noise words, that is stopwords, cause a Boolean operation on a full-text query to return zero rows.' },
  { key: 'twoDigitYearCutoff', label: 'Two Digit Year Cutoff', category: 'Containment', control: 'text', settable: false, smoOrder: 37,
    description: 'Indicates the highest year number that can be entered as a two-digit year.' },
  // Cursor.
  { key: 'closeCursorOnCommit', label: 'Close Cursor on Commit Enabled', category: 'Cursor', control: 'bool', choices: bool, settable: true, sql: set('CURSOR_CLOSE_ON_COMMIT'), smoOrder: 14,
    description: 'Specify whether cursors close after the transaction opening the cursor has committed.' },
  { key: 'defaultCursor', label: 'Default Cursor', category: 'Cursor', control: 'choice', choices: cursor, settable: true,
    // SMO's option name carries a trailing space, so its script reads "SET CURSOR_DEFAULT  LOCAL".
    sql: set('CURSOR_DEFAULT ', keywords(cursor)), smoOrder: 15, description: 'Specify default cursor behavior. When True, cursor declarations default to LOCAL.' },
  // FILESTREAM.
  { key: 'filestreamDirectoryName', label: 'FILESTREAM Directory Name', category: 'FILESTREAM', control: 'text', settable: false, smoOrder: 39,
    description: 'Specify the directory name for the FILESTREAM data associated with the selected database.' },
  { key: 'filestreamNonTransactedAccess', label: 'FILESTREAM Non-Transacted Access', category: 'FILESTREAM', control: 'choice', choices: filestreamAccess, settable: true, exclusive: true,
    sql: { kind: 'filestream' }, smoOrder: 38,
    description: 'Specify one of the following options for non-transactional access through the file system to FILESTREAM data stored in FileTables: OFF, READ_ONLY, or FULL.' },
  // Ledger.
  { key: 'isLedgerDatabase', label: 'Is Ledger Database', category: 'Ledger', control: 'bool', choices: bool, settable: false, since: 16, smoOrder: 72,
    description: 'Whether all tables in the database are ledger tables. It is set when the database is created and cannot be changed.' },
  // Miscellaneous.
  { key: 'allowSnapshotIsolation', label: 'Allow Snapshot Isolation', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, notOn: ['master', 'msdb'],
    sql: { kind: 'snapshotIsolation' }, smoOrder: 60, description: 'Enables this feature.' },
  { key: 'ansiNullDefault', label: 'ANSI NULL Default', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('ANSI_NULL_DEFAULT'), smoOrder: 4,
    description: 'Allow null values for all user-defined data types or columns that are not explicitly defined as NOT NULL during a CREATE TABLE or ALTER TABLE statement (the default state).' },
  { key: 'ansiNulls', label: 'ANSI NULLS Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('ANSI_NULLS'), smoOrder: 5,
    description: 'Specify the behavior of the Equals (=) and Not Equal To (<>) comparison operators when used with null values. When True, all comparisons to a null value evaluate to UNKNOWN.' },
  { key: 'ansiPadding', label: 'ANSI Padding Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('ANSI_PADDING'), smoOrder: 6,
    description: 'Specify whether ANSI padding is on or off.' },
  { key: 'ansiWarnings', label: 'ANSI Warnings Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('ANSI_WARNINGS'), smoOrder: 7,
    description: 'Specify ISO standard behavior for several error conditions.' },
  { key: 'arithmeticAbort', label: 'Arithmetic Abort Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('ARITHABORT'), smoOrder: 8,
    description: 'Specify whether the database option for arithmetic abort is enabled or not. When True, an overflow or divide-by-zero error causes the query or batch to terminate.' },
  { key: 'concatNullYieldsNull', label: 'Concatenate Null Yields Null', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('CONCAT_NULL_YIELDS_NULL'), smoOrder: 16,
    description: 'Specify the behavior when null values are concatenated. When True, string + NULL returns NULL.' },
  { key: 'dbChaining', label: 'Cross-database Ownership Chaining Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: false, smoOrder: 32,
    description: 'This read-only value indicates if cross-database ownership chaining has been enabled.' },
  { key: 'dateCorrelationOptimization', label: 'Date Correlation Optimization Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, exclusive: true,
    sql: set('DATE_CORRELATION_OPTIMIZATION'), smoOrder: 22,
    description: 'When True, SQL Server maintains correlation statistics between any two tables in the database that are linked by a FOREIGN KEY constraint and have datetime columns.' },
  { key: 'delayedDurability', label: 'Delayed Durability', category: 'Miscellaneous', control: 'choice', choices: durability, settable: true, sql: set('DELAYED_DURABILITY', keywords(durability), true), smoOrder: 41,
    description: 'Enables this feature. For more information, see Control Transaction Durability.' },
  { key: 'readCommittedSnapshot', label: 'Is Read Committed Snapshot On', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, exclusive: true,
    notOn: ['master', 'msdb', 'tempdb'], sql: set('READ_COMMITTED_SNAPSHOT'), smoOrder: 26, description: 'Enables this feature.' },
  { key: 'numericRoundAbort', label: 'Numeric Round-Abort', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('NUMERIC_ROUNDABORT'), smoOrder: 17,
    description: 'Specify how the database handles rounding errors. When True, an error is generated when loss of precision occurs in an expression.' },
  { key: 'parameterization', label: 'Parameterization', category: 'Miscellaneous', control: 'choice', choices: parameterization, settable: true,
    sql: set('PARAMETERIZATION', keywords(parameterization)), smoOrder: 25,
    description: 'When SIMPLE, queries are parameterized based on the default behavior of the database. When FORCED, SQL Server parameterizes all queries in the database.' },
  { key: 'quotedIdentifiers', label: 'Quoted Identifiers Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('QUOTED_IDENTIFIER'), smoOrder: 18,
    description: 'Specify whether SQL Server keywords can be used as identifiers (an object or variable name) if enclosed in quotation marks.' },
  { key: 'recursiveTriggers', label: 'Recursive Triggers Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: true, sql: set('RECURSIVE_TRIGGERS'), smoOrder: 19,
    description: 'Specify whether triggers can be fired by other triggers.' },
  { key: 'trustworthy', label: 'Trustworthy', category: 'Miscellaneous', control: 'bool', choices: bool, settable: false, smoOrder: 23,
    description: 'When displaying True, this read-only option indicates that SQL Server allows access to resources outside the database under an impersonation context established within the database.' },
  { key: 'varDecimalStorageFormat', label: 'VarDecimal Storage Format Enabled', category: 'Miscellaneous', control: 'bool', choices: bool, settable: false, smoOrder: 73,
    description: 'This option is read-only. Starting with SQL Server 2008, all user databases are enabled for the vardecimal storage format.' },
  // Recovery.
  { key: 'pageVerify', label: 'Page Verify', category: 'Recovery', control: 'choice', choices: pageVerify, settable: true,
    // SMO writes the value with a trailing space: "SET PAGE_VERIFY CHECKSUM  WITH NO_WAIT".
    sql: set('PAGE_VERIFY', { CHECKSUM: 'CHECKSUM ', TORN_PAGE_DETECTION: 'TORN_PAGE_DETECTION ', NONE: 'NONE ' }), smoOrder: 31,
    description: 'Specify the option used to discover and report incomplete I/O transactions caused by disk I/O errors.' },
  { key: 'targetRecoveryTime', label: 'Target Recovery Time (Seconds)', category: 'Recovery', control: 'integer', range: { min: 0, max: 2_147_483_647 }, settable: true,
    sql: { kind: 'set', keyword: 'TARGET_RECOVERY_TIME', eq: true, termination: true, seconds: true }, smoOrder: 40,
    description: 'Specifies the maximum bound on the time, expressed in seconds, to recover the specified database in the event of a crash.' },
  // Service Broker.
  { key: 'brokerEnabled', label: 'Broker Enabled', category: 'Service Broker', control: 'bool', choices: bool, settable: true, notOn: ['master', 'model'],
    // No keyword: SMO's "SET  ENABLE_BROKER" has two spaces.
    sql: set('', { true: 'ENABLE_BROKER', false: 'DISABLE_BROKER' }), smoOrder: 20, description: 'Enable or disable Service Broker.' },
  { key: 'honorBrokerPriority', label: 'Honor Broker Priority', category: 'Service Broker', control: 'bool', choices: bool, settable: false, smoOrder: 27,
    description: 'Read-only Service Broker property.' },
  { key: 'serviceBrokerIdentifier', label: 'Service Broker Identifier', category: 'Service Broker', control: 'text', settable: false, smoOrder: 74,
    description: 'Read-only identifier.' },
  // State.
  { key: 'readOnly', label: 'Database Read-Only', category: 'State', control: 'bool', choices: bool, settable: true, exclusive: true, notOn: ['master', 'tempdb'],
    sql: set('', { true: 'READ_ONLY', false: 'READ_WRITE' }), smoOrder: 28,
    description: 'Specify whether the database is read only. When True, users can only read data in the database.' },
  { key: 'databaseState', label: 'Database State', category: 'State', control: 'text', settable: false, smoOrder: 70,
    description: 'View the current state of the database. It is not editable.' },
  { key: 'encryptionEnabled', label: 'Encryption Enabled', category: 'State', control: 'bool', choices: bool, settable: false, smoOrder: 71,
    description: 'When True, this database is enabled for database encryption. A Database Encryption Key is required for encryption.' },
  { key: 'restrictAccess', label: 'Restrict Access', category: 'State', control: 'choice', choices: access, settable: true, exclusive: true, notOn: ['master', 'tempdb'],
    sql: set('', keywords(access)), smoOrder: 30, description: 'Specify which users may access the database: MULTI_USER, SINGLE_USER or RESTRICTED_USER.' }
]

/** Database Scoped Configurations SSMS lists (SQL Server 2016 and later), primary then secondary, in name order:
 *  SMO writes them as its DatabaseScopedConfigurations collection lists them, which sorts by name. */
export const scopedConfigurationDefs: readonly DatabaseOptionDef[] = [
  { key: 'legacyCardinalityEstimation', label: 'Legacy Cardinality Estimation', category: 'Database Scoped Configurations', control: 'choice', choices: dscOnOff, settable: true, since: 13,
    sql: { kind: 'scoped', name: 'LEGACY_CARDINALITY_ESTIMATION', secondary: false, tokens: smoOnOff }, smoOrder: 50,
    description: 'Sets the query optimizer cardinality estimation model for the primary independent of the database compatibility level.' },
  { key: 'legacyCardinalityEstimationForSecondary', label: 'Legacy Cardinality Estimation for Secondary', category: 'Database Scoped Configurations', control: 'choice',
    choices: dscSecondary, settable: true, since: 13, sql: { kind: 'scoped', name: 'LEGACY_CARDINALITY_ESTIMATION', secondary: true, tokens: smoOnOff }, smoOrder: 51,
    description: 'Sets the query optimizer cardinality estimation model for secondaries, if any.' },
  { key: 'maxDop', label: 'Max DOP', category: 'Database Scoped Configurations', control: 'integer', range: { min: 0, max: 32_767 }, settable: true, since: 13,
    sql: { kind: 'scoped', name: 'MAXDOP', secondary: false }, smoOrder: 52, description: 'The default MAXDOP setting for the primary that statements in this database use.' },
  { key: 'maxDopForSecondary', label: 'Max DOP for Secondary', category: 'Database Scoped Configurations', control: 'integer', choices: choices(['PRIMARY', 'PRIMARY']),
    range: { min: 0, max: 32_767 }, settable: true, since: 13, sql: { kind: 'scoped', name: 'MAXDOP', secondary: true }, smoOrder: 53,
    description: 'The MAXDOP setting for secondary replicas: PRIMARY uses the primary\'s value.' },
  { key: 'parameterSniffing', label: 'Parameter Sniffing', category: 'Database Scoped Configurations', control: 'choice', choices: dscOnOff, settable: true, since: 13,
    sql: { kind: 'scoped', name: 'PARAMETER_SNIFFING', secondary: false, tokens: smoOnOff }, smoOrder: 54, description: 'Enables or disables parameter sniffing on the primary.' },
  { key: 'parameterSniffingForSecondary', label: 'Parameter Sniffing for Secondary', category: 'Database Scoped Configurations', control: 'choice', choices: dscSecondary, settable: true,
    since: 13, sql: { kind: 'scoped', name: 'PARAMETER_SNIFFING', secondary: true, tokens: smoOnOff }, smoOrder: 55, description: 'Enables or disables parameter sniffing on secondaries, if any.' },
  { key: 'queryOptimizerFixes', label: 'Query Optimizer Fixes', category: 'Database Scoped Configurations', control: 'choice', choices: dscOnOff, settable: true, since: 13,
    sql: { kind: 'scoped', name: 'QUERY_OPTIMIZER_HOTFIXES', secondary: false, tokens: smoOnOff }, smoOrder: 56,
    description: 'Enables or disables query optimization hotfixes on the primary regardless of the compatibility level of the database.' },
  { key: 'queryOptimizerFixesForSecondary', label: 'Query Optimizer Fixes for Secondary', category: 'Database Scoped Configurations', control: 'choice', choices: dscSecondary, settable: true,
    since: 13, sql: { kind: 'scoped', name: 'QUERY_OPTIMIZER_HOTFIXES', secondary: true, tokens: smoOnOff }, smoOrder: 57,
    description: 'Enables or disables query optimization hotfixes on secondaries, if any.' }
]

export type OptionKey = string
const byKey = new Map([...databaseOptionDefs, ...scopedConfigurationDefs].map(def => [def.key, def]))
export const optionDef = (key: string): DatabaseOptionDef | undefined => byKey.get(key)
export const settableOptionKeys = databaseOptionDefs.filter(def => def.settable).map(def => def.key)
export const settableScopedKeys = scopedConfigurationDefs.filter(def => def.settable).map(def => def.key)
/** Collation names as SQL Server's fn_helpcollations lists them; the backend checks the name against it again. */
export const collationPattern = /^[A-Za-z0-9_]{1,128}$/

/** Why `token` is not a value of `def` (undefined when it is): one of its choices, or a decimal integer in its range. */
export function tokenProblem(def: DatabaseOptionDef, token: string): string | undefined {
  if (def.key === 'collation') return collationPattern.test(token) ? undefined : 'Not a collation name.'
  if (def.choices?.some(choice => choice.token === token)) return undefined
  if (def.range && /^(0|[1-9][0-9]{0,10})$/.test(token) && Number(token) >= def.range.min && Number(token) <= def.range.max) return undefined
  return `Not a value of ${def.label}.`
}

/** SSMS's Autogrowth / Maxsize text of a file: "None", "By 64 MB, Unlimited", "By 10 percent, Limited to 2097152 MB". */
export type Growth = { readonly enabled: false } | { readonly enabled: true; readonly unit: 'mb' | 'percent'; readonly by: number; readonly maxMb?: number }
export function autogrowthText(growth: Growth, type: 'rows' | 'log' | 'filestream' = 'rows'): string {
  const max = growth.enabled ? growth.maxMb : undefined
  if (type === 'filestream') return max === undefined ? 'Unlimited' : `Limited to ${max} MB`
  if (!growth.enabled) return 'None'
  return `By ${growth.by} ${growth.unit === 'mb' ? 'MB' : 'percent'}, ${max === undefined ? 'Unlimited' : `Limited to ${max} MB`}`
}
export type FileType = 'rows' | 'log' | 'filestream'
export const fileTypeLabel: Readonly<Record<FileType, string>> = { rows: 'ROWS Data', log: 'LOG', filestream: 'FILESTREAM Data' }
/** The Filegroup cell of a log file. */
export const notApplicable = 'Not Applicable'

const stateNames: Readonly<Record<string, string>> = {
  ONLINE: 'Normal', RESTORING: 'Restoring', RECOVERING: 'Recovering', RECOVERY_PENDING: 'Recovery Pending', SUSPECT: 'Suspect', EMERGENCY: 'Emergency', OFFLINE: 'Offline'
}
/** SMO's DatabaseStatus wording for sys.databases' state_desc: "Normal", "Restoring", … with ", Standby" and ", Read-Only". */
export function databaseStatusText(state: string, flags: { readonly standby?: boolean; readonly readOnly?: boolean } = {}): string {
  return [stateNames[state] ?? state, flags.standby ? 'Standby' : '', flags.readOnly ? 'Read-Only' : ''].filter(Boolean).join(', ')
}
/** System databases whose owner SQL Server keeps as sa (Learn: "Changing the database owner" cannot be performed). */
export const ownerNotOn: readonly SystemDatabase[] = ['master', 'model', 'tempdb']
/**
 * SSMS's Open Connections prompt before OK changes an option it closes other connections for. Its wording is recalled,
 * not verified. No is the default (Yes rolls back the other sessions' transactions), and Escape answers No.
 */
export const openConnectionsPrompt = {
  title: 'Open Connections',
  message: 'To change the database properties, SQL Server must close all other connections to the database. Are you sure you want to change the properties and close all other connections?',
  buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1
} as const
/** Script with nothing changed (SSMS 22's wording unverified). */
export const noScriptNotice = 'There is no action to be scripted.'
