// Table Properties (SSMS's "Table Properties - name"): its model, the changes its Apply makes, their limits and words. The
// describe reads the facts every page shows; Apply changes only what SSMS makes easy there: Lock escalation, Change Tracking
// and the table's extended properties. The backend embeds tablesCatalog() in Actions/actions-catalog.json, so C# validates
// the same tokens and limits. Erasable TypeScript (no enums), so Node's type stripping can load it too.

/** sys.tables.lock_escalation_desc, which ALTER TABLE … SET (LOCK_ESCALATION = …) takes as written, with SSMS's words. */
export const lockEscalationTokens = ['TABLE', 'AUTO', 'DISABLE'] as const
export type LockEscalation = typeof lockEscalationTokens[number]
export const lockEscalationLabels: { readonly [T in LockEscalation]: string } = { TABLE: 'Table', AUTO: 'Auto', DISABLE: 'Disable' }
/** What an extended property change does: sp_addextendedproperty, sp_updateextendedproperty or sp_dropextendedproperty. */
export const extendedPropertyOps = ['add', 'update', 'drop'] as const
export type ExtendedPropertyOp = typeof extendedPropertyOps[number]

/**
 * The describe's lists (more rows set a truncation flag) and the changes one Apply may make. An extended property's value is a
 * sql_variant of at most 7,500 bytes (Learn, sp_addextendedproperty): 3,750 UTF-16 code units of nvarchar.
 */
export const tableLimits = {
  permissions: 1_024, partitions: 1_000, securityPredicates: 256, extendedProperties: 256, extendedPropertyValue: 3_750, extendedPropertyChanges: 64,
  /** Characters of a security predicate's definition the describe returns (longer ones are cut, and say so). */
  predicateChars: 4_000
} as const

export const tableMessages = {
  readFailed: 'The table could not be read.',
  memoryOptimized: 'A memory-optimized table has no lock escalation.',
  trackingMemoryOptimized: 'A memory-optimized table has no change tracking.',
  databaseTracking: 'Change tracking is off for the database. Turn it on for the database first (ALTER DATABASE … SET CHANGE_TRACKING = ON).',
  primaryKey: 'Change tracking needs a primary key on the table.',
  trackingOff: 'Track columns updated applies only while change tracking is on.',
  nonStringValue: 'This value is not text (its type is shown); Varia changes only text values.',
  duplicateName: 'Another extended property has this name.',
  systemTable: "SQL Server's own tables cannot be changed here.",
  readOnlyDatabase: 'The database is read-only.',
  externalTable: "An external table's properties cannot be changed here.",
  droppedLedger: 'A dropped ledger table cannot be changed.',
  nothingToChange: 'The table already has these settings.',
  changed: 'The table changed since its properties were read. Discard Changes, then Refresh and apply again.',
  notTheTable: 'The table is not the one these properties were read from: it was renamed, dropped or replaced since. Discard Changes, then Refresh to read its properties again.',
  applied: 'The changes were applied.',
  rolledBack: 'SQL Server rolled back the transaction, so the table is as it was.'
} as const

/** The step titles Apply reports (C#: TableAlter.Title), so a reply's steps read the same in both. */
export const tableStepTitles = {
  lockEscalation: 'Set lock escalation', disableTracking: 'Turn off change tracking', enableTracking: 'Turn on change tracking',
  add: 'Add the extended property', update: 'Change the extended property', drop: 'Remove the extended property'
} as const

/** One extended property change: its name, and the text value an add or update writes (never for a drop). */
export interface ExtendedPropertyChange { readonly op: ExtendedPropertyOp; readonly name: string; readonly value?: string }
/** Table Properties' changes, only what differs from the describe. */
export interface TableChanges {
  readonly lockEscalation?: LockEscalation
  /** Change Tracking's switch, and Track columns updated (only with it on). */
  readonly changeTracking?: { readonly enabled: boolean; readonly trackColumnsUpdated?: boolean }
  readonly extendedProperties?: readonly ExtendedPropertyChange[]
}
/** How many statements the changes plan at most: lock escalation, change tracking off and on again, and one per extended property. */
export const tableStatements = (changes: TableChanges): number =>
  (changes.lockEscalation ? 1 : 0) + (changes.changeTracking ? 2 : 0) + (changes.extendedProperties?.length ?? 0)

export interface TableGeneral {
  readonly name: string
  readonly schema: string
  /** sys.objects' create_date and modify_date (ISO 8601). */
  readonly created: string
  readonly modified?: string
  readonly systemObject: boolean
  readonly ansiNulls?: boolean
  readonly replicated: boolean
  readonly lockEscalation: string
  readonly memoryOptimized: boolean
  /** sys.tables.durability_desc of a memory-optimized table. */
  readonly durability?: string
  readonly fileTable: boolean
  readonly external: boolean
  /** A graph table's kind (band 14 and later). */
  readonly graph?: 'node' | 'edge'
  /** sys.objects.object_id: with `created`, which table was read (the request's identity). */
  readonly id: number
}
/** Storage: SSMS's Compression, Filegroups and Partitioning groups. Sizes in KB; absent is unknown. */
export interface TableStorage {
  readonly rowCount?: number
  readonly dataSpaceKb?: number
  readonly indexSpaceKb?: number
  /** One compression for every partition, or 'MIXED'. */
  readonly compression?: string
  readonly filegroup?: string
  readonly textFilegroup?: string
  readonly filestreamFilegroup?: string
  readonly partitioned: boolean
  readonly partitionScheme?: string
  readonly partitionColumn?: string
  readonly partitions: readonly TablePartition[]
  readonly partitionsTruncated: boolean
}
export interface TablePartition { readonly number: number; readonly rows: number; readonly compression: string; readonly filegroup?: string }
/** A system-versioned table, or the history table of one (band 13 and later). */
export interface TableTemporal {
  readonly type: string
  /** The history table of a system-versioned table, or the table a history table keeps. */
  readonly other?: string
  readonly periodStart?: string
  readonly periodEnd?: string
  /** HISTORY_RETENTION_PERIOD as SSMS words it ("6 MONTHS", "INFINITE"; band 14 and later). */
  readonly retention?: string
}
/** A ledger table, or a ledger table's history table (band 16 and later). */
export interface TableLedger {
  readonly type: string
  readonly view?: string
  readonly history?: string
  readonly dropped: boolean
}
export interface TableChangeTracking {
  readonly databaseEnabled: boolean
  readonly enabled: boolean
  readonly trackColumnsUpdated: boolean
  readonly primaryKey: boolean
}
/** One permission row: the principal, the permission's name and state (GRANT, GRANT_WITH_GRANT_OPTION, DENY), its grantor, and a column for a column permission. */
export interface TablePermission { readonly principal: string; readonly principalType: string; readonly permission: string; readonly state: string; readonly grantor: string; readonly column?: string }
/** One row-level security predicate on the table (band 13 and later). */
export interface TableSecurityPredicate {
  readonly policy: string
  readonly type: string
  readonly operation?: string
  readonly predicate: string
  readonly predicateTruncated?: boolean
  readonly enabled: boolean
}
/** One extended property: its name, its value as text, and the value's base type when it is not text (read-only then). */
export interface TableExtendedProperty { readonly name: string; readonly value: string; readonly type?: string }
/** What Table Properties shows. */
export interface TablePropertiesModel {
  readonly general: TableGeneral
  readonly storage: TableStorage
  readonly temporal?: TableTemporal
  readonly ledger?: TableLedger
  readonly changeTracking: TableChangeTracking
  readonly permissions: readonly TablePermission[]
  readonly permissionsTruncated: boolean
  /** Absent below band 13, which has no row-level security. */
  readonly securityPredicates?: readonly TableSecurityPredicate[]
  readonly securityPredicatesTruncated?: boolean
  readonly extendedProperties: readonly TableExtendedProperty[]
  readonly extendedPropertiesTruncated: boolean
  /** The version band (13 = SQL Server 2016 … 17 = 2025). */
  readonly level: number
  /** Why nothing can change: a system table, an external, FileTable, or ledger table, a database that is read-only. */
  readonly readOnlyReason?: string
}

/** What C# needs: the tokens, limits, messages and step titles. */
export function tablesCatalog() {
  return { lockEscalation: lockEscalationTokens, extendedPropertyOps, limits: tableLimits, messages: tableMessages, steps: tableStepTitles }
}
