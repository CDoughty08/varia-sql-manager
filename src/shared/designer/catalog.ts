// The Table Designer (New › Table): SSMS's data types with their lengths, precision and scale, the column and table
// properties, the designer's commands, its strings and its limits. It is the only declaration of what a design may hold:
// the grid, the property grids, the palette and docs/table-designer.md read it, and the backend embeds
// designerCatalogJson() as Designer/designer-catalog.json (a vitest file snapshot keeps that copy in sync), so C# holds
// no type rules of its own. Erasable TypeScript (no enums), so Node's type stripping can load it too.
/** How a type takes parameters: none, a length in bytes or characters (n for Unicode), precision and scale, a fractional
 *  seconds scale, or a vector's dimensions. */
export type TypeParams = 'none' | 'length' | 'nlength' | 'precisionScale' | 'scale' | 'dimensions'
export interface SystemTypeSpec {
  readonly name: string
  readonly params: TypeParams
  /** The parameters a new column of the type gets, and the Data Type list shows. */
  readonly length?: number
  readonly precision?: number
  readonly scale?: number
  readonly dimensions?: number
  /** The largest length, or (for nlength) characters; MAX is allowed where `max` is true. */
  readonly maxLength?: number
  readonly max?: boolean
  /** The Data Type list also offers the (MAX) form (SSMS lists nvarchar(MAX) beside nvarchar(50)). */
  readonly listMax?: boolean
  /** Typed only: SSMS 22's list does not offer it (vector). */
  readonly unlisted?: boolean
  /** The first version band with the type (17 = SQL Server 2025). */
  readonly since?: number
  /** Stored off-row (text, image, xml, the (MAX) forms, large CLR types): the table gets TEXTIMAGE_ON. */
  readonly lob?: boolean
  /** Can be an identity column (decimal and numeric only with scale 0). */
  readonly identity?: boolean
  /** At most one per table (timestamp, SQL Server's rowversion). */
  readonly onePerTable?: boolean
}

/**
 * SSMS's Data Type list, in its order, then the typed-only types. The list's defaults (nchar(10), nvarchar(50),
 * decimal(18, 0), datetime2(7)) are what SSMS shows; that they are SSMS 22's exact list is not verified.
 */
export const systemTypes: readonly SystemTypeSpec[] = [
  { name: 'bigint', params: 'none', identity: true },
  { name: 'binary', params: 'length', length: 50, maxLength: 8000 },
  { name: 'bit', params: 'none' },
  { name: 'char', params: 'length', length: 10, maxLength: 8000 },
  { name: 'date', params: 'none' },
  { name: 'datetime', params: 'none' },
  { name: 'datetime2', params: 'scale', scale: 7 },
  { name: 'datetimeoffset', params: 'scale', scale: 7 },
  { name: 'decimal', params: 'precisionScale', precision: 18, scale: 0, identity: true },
  { name: 'float', params: 'none' },
  { name: 'geography', params: 'none', lob: true },
  { name: 'geometry', params: 'none', lob: true },
  { name: 'hierarchyid', params: 'none' },
  { name: 'image', params: 'none', lob: true },
  { name: 'int', params: 'none', identity: true },
  { name: 'json', params: 'none', since: 17, lob: true },
  { name: 'money', params: 'none' },
  { name: 'nchar', params: 'nlength', length: 10, maxLength: 4000 },
  { name: 'ntext', params: 'none', lob: true },
  { name: 'numeric', params: 'precisionScale', precision: 18, scale: 0, identity: true },
  { name: 'nvarchar', params: 'nlength', length: 50, maxLength: 4000, max: true, listMax: true },
  { name: 'real', params: 'none' },
  { name: 'smalldatetime', params: 'none' },
  { name: 'smallint', params: 'none', identity: true },
  { name: 'smallmoney', params: 'none' },
  { name: 'sql_variant', params: 'none' },
  { name: 'sysname', params: 'none' },
  { name: 'text', params: 'none', lob: true },
  { name: 'time', params: 'scale', scale: 7 },
  { name: 'timestamp', params: 'none', onePerTable: true },
  { name: 'tinyint', params: 'none', identity: true },
  { name: 'uniqueidentifier', params: 'none' },
  { name: 'varbinary', params: 'length', length: 50, maxLength: 8000, max: true, listMax: true },
  { name: 'varchar', params: 'length', length: 50, maxLength: 8000, max: true, listMax: true },
  { name: 'vector', params: 'dimensions', dimensions: 3, since: 17, unlisted: true },
  { name: 'xml', params: 'none', lob: true }
]
export const systemTypeNames: readonly string[] = systemTypes.map(type => type.name)
/** A type by its name as SQL Server spells it (lowercase). */
export const typeSpec = (name: string): SystemTypeSpec | undefined => systemTypes.find(type => type.name === name)

/** Parameter bounds: decimal and numeric precision 1–38 and scale 0–precision, fractional seconds 0–7, vector 1–1,998. */
export const typeBounds = { precision: { min: 1, max: 38 }, scale: { min: 0, max: 7 }, dimensions: { min: 1, max: 1998 }, length: { min: 1 } } as const
/** A new row's type: SSMS's nchar(10) (not verified). */
export const defaultNewType = { system: 'nchar', length: 10 } as const

/** Bounds of a design. Strings: names are sysnames; `designChars` bounds every string together, so the request stays far
 *  below the 4 MiB body and the script under `scriptChars`. */
export const designerLimits = {
  /** SQL Server's columns per table that is not wide. */
  columns: 1_024,
  /** SQL Server's key columns of a clustered index. */
  keyColumns: 32,
  designChars: 400_000,
  /** Equal to main's maxScriptCharacters, so Generate Change Script's text can always run in a query window. */
  scriptChars: 1_000_000,
  /** Schemas the describe lists; more set `schemasTruncated`. */
  schemas: 2_048,
  /** An identity seed or increment: a whole number of at most 38 digits (decimal(38, 0)). */
  identityDigits: 38,
  /** Tab captions are clipped so main's close prompt (512 characters) always takes them. */
  captionChars: 400
} as const

/** The describe and request ids the designer adds to the object-action path; they live here, not in actions-catalog.json. */
export const designerDescribeIds = ['tableDesigner'] as const
export const designerRequestActions = ['createTable'] as const

// --- Properties --------------------------------------------------------------------------------------------------------

export type ColumnPropertyId = 'name' | 'allowNulls' | 'dataType' | 'length' | 'precision' | 'scale' | 'identitySpecification' | 'isIdentity' | 'identityIncrement' | 'identitySeed'
export interface PropertySpec<I extends string> {
  readonly id: I
  /** SSMS's label (learn.microsoft.com: Column Properties (SQL Server Management Studio)). */
  readonly label: string
  readonly category: string
  readonly description: string
  /** A child row of an expandable parent. */
  readonly parent?: I
}
/** Column Properties, in SSMS's categorized order. Default Value or Binding, Collation, Computed Column Specification,
 *  Condensed Data Type, Description, RowGuid and the other Table Designer rows are follow-ups (PR-G2). */
export const columnPropertySpecs: readonly PropertySpec<ColumnPropertyId>[] = [
  { id: 'name', label: '(Name)', category: 'General', description: 'The name of the column.' },
  { id: 'allowNulls', label: 'Allow Nulls', category: 'General', description: 'Whether the column accepts NULL. A primary key or identity column never does.' },
  { id: 'dataType', label: 'Data Type', category: 'General', description: 'The data type of the column, as the grid shows it.' },
  { id: 'length', label: 'Length', category: 'General', description: 'The number of characters (or bytes for binary types) the column holds; MAX for the (MAX) types.' },
  { id: 'precision', label: 'Precision', category: 'General', description: 'The total number of digits a decimal or numeric column holds.' },
  { id: 'scale', label: 'Scale', category: 'General', description: 'The digits after the decimal point, or the fractional seconds of a time, datetime2 or datetimeoffset column.' },
  { id: 'identitySpecification', label: 'Identity Specification', category: 'Table Designer', description: 'Whether the column is the table\'s identity column, and its seed and increment.' },
  { id: 'isIdentity', label: '(Is Identity)', category: 'Table Designer', parent: 'identitySpecification', description: 'Whether SQL Server numbers new rows in this column. A table has at most one identity column.' },
  { id: 'identityIncrement', label: 'Identity Increment', category: 'Table Designer', parent: 'identitySpecification', description: 'What each new row adds to the last identity value. It cannot be 0.' },
  { id: 'identitySeed', label: 'Identity Seed', category: 'Table Designer', parent: 'identitySpecification', description: 'The identity value of the first row.' }
]
export type TablePropertyId = 'tableName' | 'databaseName' | 'schema' | 'serverName' | 'identityColumn' | 'dataSpace'
/** The Properties window (F4) for the table: SSMS's (Identity) and Table Designer categories, Name and Schema editable. */
export const tablePropertySpecs: readonly PropertySpec<TablePropertyId>[] = [
  { id: 'tableName', label: '(Name)', category: '(Identity)', description: 'The name of the table. Save asks for it the first time.' },
  { id: 'databaseName', label: 'Database Name', category: '(Identity)', description: 'The database the table is created in.' },
  { id: 'schema', label: 'Schema', category: '(Identity)', description: 'The schema that contains the table.' },
  { id: 'serverName', label: 'Server Name', category: '(Identity)', description: 'The server the table is created on.' },
  { id: 'identityColumn', label: 'Identity Column', category: 'Table Designer', description: 'The table\'s identity column, set in Column Properties.' },
  { id: 'dataSpace', label: 'Regular Data Space Specification', category: 'Table Designer', description: 'The filegroup the table is created on: the database\'s default filegroup.' }
]

// --- Names -------------------------------------------------------------------------------------------------------------

/** T-SQL's reserved keywords (learn.microsoft.com: Reserved Keywords (Transact-SQL), SQL Server's column). The change
 *  script brackets a name that is one, as SSMS does. */
export const reservedKeywords: readonly string[] = [
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUTHORIZATION', 'BACKUP', 'BEGIN', 'BETWEEN', 'BREAK', 'BROWSE', 'BULK', 'BY', 'CASCADE', 'CASE', 'CHECK',
  'CHECKPOINT', 'CLOSE', 'CLUSTERED', 'COALESCE', 'COLLATE', 'COLUMN', 'COMMIT', 'COMPUTE', 'CONSTRAINT', 'CONTAINS', 'CONTAINSTABLE', 'CONTINUE', 'CONVERT', 'CREATE',
  'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURSOR', 'DATABASE', 'DBCC', 'DEALLOCATE', 'DECLARE', 'DEFAULT', 'DELETE',
  'DENY', 'DESC', 'DISK', 'DISTINCT', 'DISTRIBUTED', 'DOUBLE', 'DROP', 'DUMP', 'ELSE', 'END', 'ERRLVL', 'ESCAPE', 'EXCEPT', 'EXEC', 'EXECUTE', 'EXISTS', 'EXIT', 'EXTERNAL',
  'FETCH', 'FILE', 'FILLFACTOR', 'FOR', 'FOREIGN', 'FREETEXT', 'FREETEXTTABLE', 'FROM', 'FULL', 'FUNCTION', 'GOTO', 'GRANT', 'GROUP', 'HAVING', 'HOLDLOCK', 'IDENTITY',
  'IDENTITY_INSERT', 'IDENTITYCOL', 'IF', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'KILL', 'LEFT', 'LIKE', 'LINENO', 'LOAD', 'MERGE',
  'NATIONAL', 'NOCHECK', 'NONCLUSTERED', 'NOT', 'NULL', 'NULLIF', 'OF', 'OFF', 'OFFSETS', 'ON', 'OPEN', 'OPENDATASOURCE', 'OPENQUERY', 'OPENROWSET', 'OPENXML', 'OPTION',
  'OR', 'ORDER', 'OUTER', 'OVER', 'PERCENT', 'PIVOT', 'PLAN', 'PRECISION', 'PRIMARY', 'PRINT', 'PROC', 'PROCEDURE', 'PUBLIC', 'RAISERROR', 'READ', 'READTEXT', 'RECONFIGURE',
  'REFERENCES', 'REPLICATION', 'RESTORE', 'RESTRICT', 'RETURN', 'REVERT', 'REVOKE', 'RIGHT', 'ROLLBACK', 'ROWCOUNT', 'ROWGUIDCOL', 'RULE', 'SAVE', 'SCHEMA',
  'SECURITYAUDIT', 'SELECT', 'SEMANTICKEYPHRASETABLE', 'SEMANTICSIMILARITYDETAILSTABLE', 'SEMANTICSIMILARITYTABLE', 'SESSION_USER', 'SET', 'SETUSER', 'SHUTDOWN', 'SOME',
  'STATISTICS', 'SYSTEM_USER', 'TABLE', 'TABLESAMPLE', 'TEXTSIZE', 'THEN', 'TO', 'TOP', 'TRAN', 'TRANSACTION', 'TRIGGER', 'TRUNCATE', 'TRY_CONVERT', 'TSEQUAL', 'UNION',
  'UNIQUE', 'UNPIVOT', 'UPDATE', 'UPDATETEXT', 'USE', 'USER', 'VALUES', 'VARYING', 'VIEW', 'WAITFOR', 'WHEN', 'WHERE', 'WHILE', 'WITH', 'WRITETEXT'
]
/** A name the change script may leave bare: a regular identifier that is neither a reserved keyword nor GO. Anything else
 *  is bracketed, ]] doubled, as QUOTENAME does. */
export const bareNamePattern = /^[A-Za-z_][A-Za-z0-9_@#$]*$/
const reserved: ReadonlySet<string> = new Set([...reservedKeywords, 'GO'])
export const isBareName = (name: string): boolean => bareNamePattern.test(name) && !reserved.has(name.toUpperCase())
/** SSMS's minimal quoting in a change script. */
export const scriptName = (name: string): string => isBareName(name) ? name : `[${name.replaceAll(']', ']]')}]`
/** QUOTENAME's brackets, which the statements Save runs always use. */
export const bracketName = (name: string): string => `[${name.replaceAll(']', ']]')}]`

/** Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text
  const end = (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max
  return text.slice(0, end)
}
/** The primary key's constraint name: PK_<table>, within a sysname (truncation rule not verified). */
export const primaryKeyName = (table: string): string => clipUnits('PK_' + table, 128)
/** A new table's name: SSMS's Table_<n>, n counting from 1 per session (not verified). */
export const defaultTableName = (n: number): string => `Table_${n}`
/** The document tab: SSMS's "<server>.<database> - <schema>.<table>" (not verified), clipped for main's close prompt. */
export const designerCaption = (server: string, database: string, schema: string, table: string): string =>
  clipUnits(`${server}.${database} - ${schema}.${table}`, designerLimits.captionChars)

// --- Strings -------------------------------------------------------------------------------------------------------------

export const designerStrings = {
  chooseNameTitle: 'Choose Name',
  /** Not verified against SSMS 22. */
  chooseNameLabel: 'Enter a name for the table:',
  changeScriptTitle: 'Save Change Script',
  /** Not verified against SSMS 22. */
  changeScriptPrompt: 'Do you want to save this change script to a text file?',
  saved: (label: string) => `${label} was created. Changing an existing table in the designer is not available yet.`,
  stopped: 'The save was stopped. SQL Server rolled back the table; nothing was created.',
  stoppedUnknown: 'The save was stopped, but SQL Server did not confirm it in time, so whether the table was created is unknown. Refresh Object Explorer to check.',
  disconnected: 'The server was disconnected. Reconnect it to save this table.',
  saving: 'Wait for the table to be saved, or stop it first.',
  noColumns: 'Add at least one column before saving the table.',
  loadFailed: 'The table designer could not read the database.'
} as const

// --- Commands ------------------------------------------------------------------------------------------------------------

export type DesignerCommandId =
  | 'explorer.newTable'
  | 'tableDesigner.setPrimaryKey'
  | 'tableDesigner.removePrimaryKey'
  | 'tableDesigner.insertColumn'
  | 'tableDesigner.deleteColumn'
  | 'tableDesigner.generateChangeScript'
  | 'tableDesigner.properties'
  | 'tableDesigner.stop'
export interface DesignerCommandEntry {
  readonly title: string
  readonly category: 'Object Explorer' | 'Table Designer'
  readonly icon?: 'table' | 'key' | 'insert' | 'remove' | 'file-code' | 'settings-gear' | 'debug-stop'
  readonly keywords?: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'explorer.new' | 'tableDesigner.context'; readonly group: string; readonly order: number; readonly mnemonic: string; readonly title?: string; readonly when?: string }[]
}
const editable = 'activeDocumentIsDesigner && designerEditable'
const openDesigner = 'Open the table designer (New › Table) and select a column.'
/** The designer's commands; a designer document's toolbar strip and context menu run them, as does the palette. */
export function designerCommandEntries(): { readonly [K in DesignerCommandId]: DesignerCommandEntry } {
  return {
    // SSMS: right-click Tables › New › Table… (learn.microsoft.com: Create tables (Database Engine)).
    'explorer.newTable': {
      title: 'New Table…', category: 'Object Explorer', icon: 'table', keywords: ['create', 'designer', 'design'],
      precondition: "backendReady && explorerSelectionFolder == 'tables' && !documentBusy", unavailableHint: 'Select the Tables folder of a database in Object Explorer.',
      menus: [{ menu: 'explorer.new', group: '1_table', order: 1, title: 'Table…', mnemonic: 't' }]
    },
    'tableDesigner.setPrimaryKey': {
      title: 'Set Primary Key', category: 'Table Designer', icon: 'key', keywords: ['key', 'pk'], precondition: `${editable} && designerRowSelected && !designerPrimaryKeyRemovable`,
      unavailableHint: openDesigner, menus: [{ menu: 'tableDesigner.context', group: '1_key', order: 1, mnemonic: 'y', when: '!designerPrimaryKeyRemovable' }]
    },
    'tableDesigner.removePrimaryKey': {
      title: 'Remove Primary Key', category: 'Table Designer', icon: 'key', keywords: ['key', 'pk'], precondition: `${editable} && designerPrimaryKeyRemovable`,
      unavailableHint: 'Select primary key columns in the table designer.', menus: [{ menu: 'tableDesigner.context', group: '1_key', order: 2, mnemonic: 'v', when: 'designerPrimaryKeyRemovable' }]
    },
    'tableDesigner.insertColumn': {
      title: 'Insert Column', category: 'Table Designer', icon: 'insert', keywords: ['add', 'row'], precondition: `${editable} && designerRowSelected`,
      unavailableHint: openDesigner, menus: [{ menu: 'tableDesigner.context', group: '2_column', order: 1, mnemonic: 'i' }]
    },
    'tableDesigner.deleteColumn': {
      title: 'Delete Column', category: 'Table Designer', icon: 'remove', keywords: ['remove', 'drop', 'row'], precondition: `${editable} && designerRowSelected`,
      unavailableHint: openDesigner, menus: [{ menu: 'tableDesigner.context', group: '2_column', order: 2, mnemonic: 'n' }]
    },
    'tableDesigner.generateChangeScript': {
      title: 'Generate Change Script…', category: 'Table Designer', icon: 'file-code', keywords: ['script', 'create', 'sql'], precondition: `${editable} && backendReady`,
      unavailableHint: 'Open the table designer on a connected server.', menus: [{ menu: 'tableDesigner.context', group: '8_script', order: 1, mnemonic: 's' }]
    },
    // SSMS's Properties window key. The designer's own: elsewhere F4 stays free.
    'tableDesigner.properties': {
      title: 'Properties', category: 'Table Designer', icon: 'settings-gear', keywords: ['schema', 'name'], precondition: 'activeDocumentIsDesigner',
      unavailableHint: 'Open the table designer first.', keybindings: [{ key: 'f4', when: 'designerFocus' }],
      menus: [{ menu: 'tableDesigner.context', group: '9_properties', order: 1, mnemonic: 'r' }]
    },
    // No documentBusy: Stop must work while the close flow's save holds the document task.
    'tableDesigner.stop': {
      title: 'Stop', category: 'Table Designer', icon: 'debug-stop', keywords: ['cancel', 'save'], precondition: 'designerSaving', unavailableHint: 'The table is not being saved.'
    }
  }
}
/** Commands that change the design: what the toolbar strip shows. */
export const designerToolbar: readonly DesignerCommandId[] = ['tableDesigner.setPrimaryKey', 'tableDesigner.insertColumn', 'tableDesigner.deleteColumn', 'tableDesigner.generateChangeScript']

// --- Backend copy --------------------------------------------------------------------------------------------------------

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/** The catalogue as the backend embeds it, keys sorted: the types in list order (a type's index is its id in the request
 *  the builder batch reads), the reserved keywords, the bounds and limits, and the describe and request ids. */
export function designerCatalogJson(): string {
  return [
    '{',
    `  "bounds": ${line(typeBounds)},`,
    `  "describes": ${line(designerDescribeIds)},`,
    `  "limits": ${line(designerLimits)},`,
    `  "requests": ${line(designerRequestActions)},`,
    `  "reservedKeywords": ${line(reservedKeywords)},`,
    `  "types": ${block(systemTypes)},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
