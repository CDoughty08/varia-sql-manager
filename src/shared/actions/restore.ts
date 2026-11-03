// Restore Database (D1e, D1f) and Restore Files and Filegroups (D1g): the describe id, request actions, limits, labels, step
// titles and messages, and the shapes of what the describe answers. The backend embeds restoreCatalog() in actions-catalog.json,
// so its limits, refusals and step titles are these. Their menu items and commands are objectActions' `restore` and
// `restoreFiles` (catalog.ts). Erasable TypeScript, so Node's type stripping can load it too.
import type { ServerEngine } from '../explorer/catalog.ts'
import type { ServerPathSeparator } from './files.ts'

/** actions.describe's id for both documents; its `restore` member says what to read. */
export const restoreDescribeId = 'restoreDatabase' as const
/** actions.script's and actions.execute's actions: a database restore, and a restore of some of a database's files. */
export const restoreRequestActions = ['restore', 'restoreFiles'] as const
export type RestoreRequestAction = typeof restoreRequestActions[number]
/** RESTORE FROM DISK runs only on SQL Server itself: Managed Instance restores from URL only, and Azure SQL Database has no RESTORE (critic A1). */
export const restoreEngines: readonly ServerEngine[] = ['box']
/** SQL Server's own databases. Restoring one needs single-user mode or a stopped Agent, so wave 5 refuses them (critic A19). */
export const restoreSystemDatabases = ['master', 'model', 'msdb', 'tempdb'] as const

export const restoreLimits = {
  /** The backend's budget for one describe: LABELONLY and HEADERONLY on a large striped set or a slow share. */
  mediaReadMs: 120_000,
  /** Main's deadline for a restore describe: the budget and time to answer (critic A2). */
  describeDeadlineMs: 130_000,
  /** Restore describes one connection runs at once, under their own gate: a media read on an unreachable share holds it past
   *  its budget until SQL Server's file call returns, so it never holds a gate Database Properties or Delete Object waits for. */
  mediaReadsPerConnection: 2,
  /** Learn: up to 64 devices that belong to one media set. */
  backupDevices: 64,
  /** Databases msdb's history lists (more set `historyTruncated`). */
  historyDatabases: 1_024,
  /** The newest backup sets one database's history, or the media, lists. */
  historySets: 1_024,
  /** Sets one restore runs: as many as the history lists. Each RESTORE is a statement of its own, so SQL Server's 2,100
   *  parameters bound one statement (its devices and moves), not the plan. */
  planSets: 1_024,
  /** 64 devices and 2 × 1000 MOVE parameters stay under SQL Server's 2,100 parameters. */
  restoreMoves: 1_000,
  /** Destination names (sys.databases minus master and tempdb) and other databases' files, for Restore As collisions. */
  destinations: 4_096,
  serverFiles: 8_192,
  /** backupset.name and user_name are nvarchar(128). */
  setName: 128,
  /** A set id: a backup_set_uuid (history) or <media set>:<position> (devices). */
  setId: 36,
  /** LSNs are numeric(25, 0), sent as decimal text. */
  lsnDigits: 25,
  /** A backup set's position in its media set (RESTORE … WITH FILE). */
  position: 32_767,
  /** SMO's restore plan writes STATS = 5, as SSMS asks. */
  stats: 5,
  /** SQL Server holds at most 32,767 databases: the run's preflight reads every id there is (a cleanup drops only one it created). */
  databases: 32_767,
  /** Restore's Script: every RESTORE repeats the moves, so a long log chain with many files outgrows the object actions' cap;
   *  Script As's cap, which the backend checks as it writes, before the text is whole. */
  scriptChars: 4_000_000,
  /** Restore Files and Filegroups: the FILE clauses, and the FILEGROUP clauses, one RESTORE names (form 4's @f1…@f256, @g1…@g256). */
  restoreFiles: 256,
  /** Restore Files and Filegroups: the newest full and file backups whose files the document reads, one describe each. */
  fileSets: 16,
  /** SQL Server's parameters per statement: a file restore's FILE, FILEGROUP, device and MOVE parameters (two each) stay under them. */
  parameters: 2_100
} as const

/** What the document says where SSMS has no words of its own, and the refusals main and the backend share. */
export const restoreMessages = {
  systemDatabase: 'Restore system databases with T-SQL; it needs single-user mode or a stopped Agent.',
  /** Prompt before restoring each backup splits one restore into requests (critic A22), and Verify Backup Media (D1g). */
  notYetAvailable: 'Not yet available',
  invalidPlan: 'The selected backup sets do not form a valid restore plan.',
  noFullBackup: 'No full backup precedes the point to restore to.',
  afterLastBackup: 'The point to restore to is after the last log backup.',
  /** Manual Selection with a point the checked sets cannot stop at. */
  notReached: 'The checked backup sets do not reach the point to restore to: check the log backup that covers it, or restore to the last backup taken.',
  /** The plan's full backup changed and its files are not read yet (or could not be read). */
  filesNotRead: 'The files of the full backup to restore are not read yet.',
  noHistory: 'msdb has no backup history for this database. Choose Device to restore from backup files.',
  noSets: 'The backup media hold no backup sets.',
  notDisk: 'This backup set is not on a disk file; Varia restores from disk files only.',
  /** Why Manual Selection cannot check a set the planner never uses (the row's title and its checkbox's description). */
  damaged: 'This backup set is marked damaged.',
  copyOnlyLog: 'A copy-only log backup is not part of the log chain.',
  /** Stop reached SQL Server only as it finished the last RESTORE WITH RECOVERY: the run's reply says so ({database} shown through displayText). */
  finishedAtStop: 'Stop came as SQL Server finished the restore: {database} is restored and online.',
  notPlanned: 'File and partial backups restore with T-SQL.',
  /** Restore Files and Filegroups (Learn, restore-files-and-filegroups-sql-server, quoted). */
  simpleReadOnly: 'Under the simple recovery model, the file must belong to a read-only filegroup.',
  /** Restore Files and Filegroups: nothing is checked in the grid. */
  noFiles: 'Check the files or filegroups to restore.',
  /** Restore Files and Filegroups: the source holds no full or file backup to restore files from. */
  noFileBase: 'The backup sets hold no full or file backup to restore files from.',
  /** Restore Files and Filegroups: files restore only from the database's own backups (another family, SQL Server's 3154). */
  otherDatabase: 'These backups are of another database: files restore only from the database\'s own backups.',
  /** Restore Files and Filegroups: why the log rows are checked and cannot be unchecked. */
  logsFollow: 'The log backups after the chosen backup set restore with its files, to bring them forward.',
  /** Restore Files and Filegroups' Options page: under FULL or BULK_LOGGED an online file restore ends only with a log backup taken
   *  after it (probed on 2025: the files stay RESTORING after every earlier log, "Additional roll forward past LSN … is required"). */
  filesStayRestoring: 'Under the full or bulk-logged recovery model, restored files stay restoring until a log backup taken after they are restored is restored.',
  /** Restore Files and Filegroups: SQL Server refuses STANDBY on an online database's file restore (4302, probed on 2025), only once the files are restored. */
  standbyOnline: 'RESTORE WITH STANDBY conflicts with an online restore: choose another recovery state while the database is online.',
  /** Restore Files and Filegroups: a PRIMARY file restores only offline, which puts the whole database in RESTORING; with no tail-log
   *  backup its log since the last log backup is lost and it cannot recover (probed on 2025: 4303, then 927), so Varia refuses it on an
   *  online or offline database and leaves it to Restore Database, which backs up the tail of the log first. */
  primaryOnline: 'A file of the PRIMARY filegroup restores only offline, which takes the whole database out of use and, without a tail-log backup, loses the changes since the last log backup: restore the database with Restore Database, which backs up the tail of the log first.',
  /** Restore Files and Filegroups' preflight: the database's log was backed up after the plan's last set (sys.database_recovery_status),
   *  so the restored files would wait for a log backup the plan lacks, and Varia's log backup would not continue them (4305). */
  logChainAhead: 'The log has been backed up since the last backup set this restore plans, and restored files roll forward only through every log backup: Refresh to read the backup history again, or add the files of the newer log backups under From device.',
  /** Restore Files and Filegroups' run: a log backup was taken between the restore's steps and Back up the log. */
  logBackedUpDuring: 'The log was backed up during the restore, so a log backup taken now would not continue the restored files: restore that log backup, then back up the log and restore it WITH RECOVERY to bring the files online.'
} as const

/** A backup set's kind, from msdb's type letter or HEADERONLY's BackupType. Only full, differential and log sets are planned. */
export const backupSetTypes = ['full', 'differential', 'log', 'file', 'fileDifferential', 'partial', 'partialDifferential'] as const
export type BackupSetType = typeof backupSetTypes[number]
/** SSMS's Component and Type columns (recalled). */
export const backupSetTypeSpecs: { readonly [T in BackupSetType]: { readonly component: string; readonly type: string } } = {
  full: { component: 'Database', type: 'Full' },
  differential: { component: 'Database', type: 'Differential' },
  log: { component: 'Database', type: 'Transaction Log' },
  file: { component: 'File', type: 'Full' },
  fileDifferential: { component: 'File', type: 'Differential' },
  partial: { component: 'Partial', type: 'Full' },
  partialDifferential: { component: 'Partial', type: 'Differential' }
}
export const plannedSetTypes = ['full', 'differential', 'log'] as const
export type PlannedSetType = typeof plannedSetTypes[number]

/** SSMS's Recovery state choices (Options page). */
export const restoreRecoveryStates = ['recovery', 'norecovery', 'standby'] as const
export type RestoreRecovery = typeof restoreRecoveryStates[number]
export const restoreRecoveryLabels: { readonly [R in RestoreRecovery]: string } = {
  recovery: 'RESTORE WITH RECOVERY', norecovery: 'RESTORE WITH NORECOVERY', standby: 'RESTORE WITH STANDBY'
}

/** The Backup Timeline's Timeline Interval (recalled), each with the span the timeline shows. */
export const timelineIntervals = ['hour', 'sixHours', 'day', 'week'] as const
export type TimelineInterval = typeof timelineIntervals[number]
export const timelineIntervalSpecs: { readonly [I in TimelineInterval]: { readonly label: string; readonly ms: number } } = {
  hour: { label: 'Hour', ms: 3_600_000 }, sixHours: { label: 'Six Hours', ms: 21_600_000 }, day: { label: 'Day', ms: 86_400_000 }, week: { label: 'Week', ms: 604_800_000 }
}

/** Restore Files and Filegroups' Recovery state choices: SSMS's long labels, as Learn gives this dialog's Options page (Restore Files and
 *  Filegroups, both its current procedure and the 2008 R2 reference). They differ from Restore Database's old wording ("do not",
 *  "Undo … undo actions"), which matches this dialog's "Rollback undo file". */
export const restoreFilesRecoveryLabels: { readonly [R in RestoreRecovery]: string } = {
  recovery: 'Leave the database ready for use by rolling back the uncommitted transactions. Additional transaction logs cannot be restored. (RESTORE WITH RECOVERY)',
  norecovery: "Leave the database non-operational, and don't roll back the uncommitted transactions. Additional transaction logs can be restored. (RESTORE WITH NORECOVERY)",
  standby: 'Leave the database in read-only mode. Roll back the uncommitted transactions, but save the rollback operation in a file so the recovery effects can be undone. (RESTORE WITH STANDBY)'
}

/** The document's sections, SSMS's pages. */
export const restoreSections = [{ id: 'general', title: 'General' }, { id: 'files', title: 'Files' }, { id: 'options', title: 'Options' }] as const
export type RestoreSectionId = typeof restoreSections[number]['id']
/** Restore Files and Filegroups' sections: SSMS's dialog has a General and an Options page. */
export const restoreFilesSections = [{ id: 'general', title: 'General' }, { id: 'options', title: 'Options' }] as const

/** Which restore a Restore document makes: a whole database (Restore Database), or some of an existing database's files. */
export type RestoreMode = 'database' | 'files'
/** The documents' titles before a database is chosen, and their tabs' "<title> - <database>". */
export const restoreModeTitles: { readonly [M in RestoreMode]: string } = { database: 'Restore Database', files: 'Restore Files and Filegroups' }
/** The backup device picker's title (and its "…" button's name) per document: Learn's Restore Database procedure names it Select
 *  backup devices, and its Restore Files and Filegroups procedure (step 6) Specify backup devices. One sub-dialog, two names. */
export const restoreDevicePickerTitles: { readonly [M in RestoreMode]: string } = { database: 'Select backup devices', files: 'Specify backup devices' }

// --- Describe -----------------------------------------------------------------------------------------------------------

/**
 * What one restore describe reads: msdb's history (the databases it has backed up, and one database's sets), the headers
 * of backup files on the server (LABELONLY per device, HEADERONLY per media set), or the files of one backup set
 * (msdb's backupfile for a history set, FILELISTONLY for one on the media).
 */
export type RestoreSource =
  | { readonly kind: 'history'; readonly database?: string }
  | { readonly kind: 'devices'; readonly devices: readonly string[] }
  | { readonly kind: 'historyFiles'; readonly setId: string }
  | { readonly kind: 'mediaFiles'; readonly devices: readonly string[]; readonly file: number }
export const restoreSourceKinds = ['history', 'devices', 'historyFiles', 'mediaFiles'] as const

/** One backup set as the history or the media describe it. Dates are the server's local time (yyyy-MM-ddTHH:mm:ss); LSNs are decimal text. */
export interface BackupSetRow {
  /** backup_set_uuid for a history set, <media set>:<position> for one read from the media. */
  readonly id: string
  readonly name: string
  readonly type: BackupSetType
  readonly server: string
  readonly database: string
  readonly position: number
  readonly firstLsn: string
  readonly lastLsn: string
  readonly checkpointLsn: string
  /** The full backup a differential or log is based on ('0' for none). */
  readonly databaseBackupLsn: string
  readonly start: string
  readonly finish: string
  readonly sizeBytes: number
  readonly userName: string
  readonly expiration?: string
  readonly copyOnly: boolean
  readonly damaged: boolean
  readonly recoveryModel?: string
  /** The recovery fork at the set's first LSN and at its last; they differ when a restore to a point in time forked the log inside it. */
  readonly firstForkGuid?: string
  readonly forkGuid?: string
  /** Where the fork happened when the two differ (msdb's fork_point_lsn, HEADERONLY's ForkPointLSN). */
  readonly forkPointLsn?: string
  /** The database's family: the same across its restores, different for another database of the same name. */
  readonly familyGuid?: string
  /** The media set's disk files, in family order. */
  readonly devices: readonly string[]
  /** Why the set cannot be restored as it is: a striped set with families missing, or one that is not on disk. */
  readonly problem?: string
}
export type BackupFileType = 'data' | 'log' | 'filestream' | 'fulltext' | 'other'
/** One file of a backup set (FILELISTONLY, or msdb's backupfile). */
export interface BackupFileRow {
  readonly logical: string
  readonly physical: string
  readonly type: BackupFileType
  readonly filegroup?: string
  readonly sizeBytes: number
  readonly fileId: number
  /** Not in this backup set: a file backup lists every file of the database and holds only some (msdb's is_present, FILELISTONLY's IsPresent). */
  readonly absent?: true
}
/** A database a restore can overwrite: sys.databases minus master and tempdb (and snapshots). */
export interface RestoreDestination {
  readonly name: string
  readonly id: number
  /** create_date as yyyy-MM-ddTHH:mm:ss.fff (DatabaseIdentity). */
  readonly created: string
  /** state_desc: ONLINE, RESTORING, OFFLINE… */
  readonly state: string
  /** FULL, BULK_LOGGED or SIMPLE. */
  readonly recoveryModel: string
  /** Sessions in it; absent without VIEW SERVER STATE. */
  readonly sessions?: number
  /** Of them, the sessions with an open transaction, which closing connections rolls back (critic A7); absent without VIEW SERVER STATE. */
  readonly withTransaction?: number
  /** Its backup family (sys.database_recovery_status): a database of the same name from elsewhere has another, and its backups are not this one's. */
  readonly familyGuid?: string
}
export interface RestoreServerFacts {
  readonly separator: ServerPathSeparator
  readonly dataPath?: string
  readonly logPath?: string
  readonly backupPath?: string
  /** CREATE ANY DATABASE, sysadmin or dbcreator: advisory, the run re-checks. */
  readonly canRestore: boolean
  readonly destinations: readonly RestoreDestination[]
  readonly destinationsTruncated: boolean
  /** Other databases' files (sys.master_files), so two databases never get one Restore As path. */
  readonly files: readonly { readonly database: string; readonly path: string }[]
  readonly filesTruncated: boolean
}
/** A restore describe's answer: `server` with history and devices; the databases with history; the sets; one set's files. */
export interface RestoreModel {
  readonly server?: RestoreServerFacts
  readonly historyDatabases?: readonly string[]
  readonly historyTruncated?: boolean
  readonly sets?: readonly BackupSetRow[]
  readonly setsTruncated?: boolean
  readonly files?: readonly BackupFileRow[]
  readonly filesTruncated?: boolean
}

// --- Request ------------------------------------------------------------------------------------------------------------

/** One set of the plan: its media set's disk files and its position there. `name` titles its step. */
export interface RestorePlanSet {
  readonly id: string
  readonly devices: readonly string[]
  readonly file: number
  readonly type: PlannedSetType
  readonly name?: string
}
export interface RestoreMove { readonly logical: string; readonly physical: string }
/** What a restore does: the sets in order, where the files go, and the options SSMS's pages set. */
export interface RestoreOptions {
  readonly sets: readonly RestorePlanSet[]
  /** STOPAT on the last log, the server's local time. */
  readonly stopAt?: string
  readonly relocate: readonly RestoreMove[]
  readonly replace: boolean
  readonly keepReplication: boolean
  readonly restrictedUser: boolean
  readonly recovery: RestoreRecovery
  readonly standbyFile?: string
  /** Back up the tail of the destination's log first, leaving it RESTORING when `noRecovery`. */
  readonly tailLog?: { readonly file: string; readonly noRecovery: boolean }
  /** SET SINGLE_USER WITH ROLLBACK IMMEDIATE first, on a destination that exists (`identity`). */
  readonly closeConnections: boolean
}

/** Restore Files and Filegroups' sets: a full or file backup to restore the files from, then the log backups after it. */
export const restoreFilesSetTypes = ['full', 'file', 'log'] as const
export interface RestoreFilesSet {
  readonly id: string
  readonly devices: readonly string[]
  readonly file: number
  readonly type: typeof restoreFilesSetTypes[number]
  readonly name?: string
}
/**
 * What a file restore does (D1g): the files (FILE) and filegroups (FILEGROUP) of an existing database to restore from the first
 * set, the log backups after it, where restored files go, SSMS's options, and Varia's own last step: a copy-only log backup taken
 * once the files are restored, restored at once, which an online file restore under FULL or BULK_LOGGED needs to end (probed).
 */
export interface RestoreFilesOptions {
  readonly sets: readonly RestoreFilesSet[]
  readonly files: readonly string[]
  readonly filegroups: readonly string[]
  readonly relocate: readonly RestoreMove[]
  readonly replace: boolean
  readonly restrictedUser: boolean
  readonly recovery: RestoreRecovery
  readonly standbyFile?: string
  /** BACKUP LOG … WITH COPY_ONLY to this new file after the sets, then RESTORE LOG from it with the recovery state (RECOVERY only). */
  readonly logBackup?: { readonly file: string }
}

/** Whether a name is one of SQL Server's own databases, in any case: a case-insensitive server, the default, matches MSDB too. */
export const isRestoreSystemDatabase = (name: string): boolean => (restoreSystemDatabases as readonly string[]).includes(name.toLowerCase())
/** Why a destination name cannot be restored to in wave 5, or undefined. */
export const restoreTargetProblem = (name: string): string | undefined => isRestoreSystemDatabase(name) ? restoreMessages.systemDatabase : undefined

/** The id form of a set: a history set's uuid, or <media set>:<position> from the media. */
export const restoreSetIdPattern = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9][0-9]?:[1-9][0-9]{0,4})$/
/** STOPAT's text: the server's local date and time to the second, as SMO writes it. */
export const restoreTimePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/

// --- Default names ------------------------------------------------------------------------------------------------------

const two = (value: number) => String(value).padStart(2, '0')
/** SSMS's stamp in default file names: yyyy-MM-dd_HH-mm-ss, local time. */
export const fileStamp = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}_${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`
/** Characters a default file name cannot hold, which a database name can (SSMS's defaults keep the name; recalled): what Windows
 *  refuses, and on Linux the separator and what serverPathSchema refuses on every platform (files.ts). */
const unsafe = (separator: ServerPathSeparator) => separator === '\\' ? /[\\/:*?"<>|\u0000-\u001f]/g : /[/*?"<>|\u0000-\u001f]/g
export const fileNamePart = (name: string, separator: ServerPathSeparator): string => name.replace(unsafe(separator), '_')
const inFolder = (folder: string | undefined, separator: ServerPathSeparator, name: string) =>
  folder ? (folder.endsWith(separator) ? folder : folder + separator) + name : ''
/** The tail-log backup's default file: <backup folder><db>_LogBackup_<stamp>.bak (SSMS's, recalled). */
export const tailLogFile = (folder: string | undefined, separator: ServerPathSeparator, database: string, at: Date): string =>
  inFolder(folder, separator, `${fileNamePart(database, separator)}_LogBackup_${fileStamp(at)}.bak`)
/** STANDBY's default undo file: <backup folder><db>_RollbackUndo_<stamp>.bak (recalled). */
export const standbyFile = (folder: string | undefined, separator: ServerPathSeparator, database: string, at: Date): string =>
  inFolder(folder, separator, `${fileNamePart(database, separator)}_RollbackUndo_${fileStamp(at)}.bak`)
/** The name of a path's file, after its last separator (either kind: a backup taken on Windows names a Windows path). */
export const pathFileName = (path: string): string => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
/**
 * Where a file goes by default (Files page): its original path when restoring over the database it came from; otherwise
 * the default data or log folder and the destination's name with the original's suffix, as SSMS 2014 and later do
 * (recalled: AppData.mdf restored as Sales becomes Sales.mdf, AppData_log.ldf becomes Sales_log.ldf).
 */
export function restoreAsPath(file: BackupFileRow, source: string, destination: string, folder: string | undefined, separator: ServerPathSeparator): string {
  if (destination === source || !folder) return file.physical
  const name = pathFileName(file.physical)
  const renamed = name.startsWith(source) ? destination + name.slice(source.length) : `${destination}_${name}`
  return inFolder(folder, separator, fileNamePart(renamed, separator))
}

// --- Run ----------------------------------------------------------------------------------------------------------------

/**
 * The run's step titles (D1f), which the backend's reply and the document's step list share: the document lists the steps it
 * plans in these words before the reply comes, and the backend titles the reply's steps with the same. A log backup's step adds
 * "n of count" when the plan restores more than one. close and multiUser are the shared templates' titles (ActionService.StepTitle).
 */
export const restoreStepTitles = {
  close: 'Close existing connections',
  tailLog: 'Back up the tail of the log',
  full: 'Restore the full backup',
  differential: 'Restore the differential backup',
  log: 'Restore log backup',
  multiUser: 'Restore multi-user access',
  /** Compensation: the tail-log backup left the database RESTORING and no RESTORE started (critic A11d). */
  recover: 'Bring the database back online',
  /** Compensations: Close existing connections set SINGLE_USER and no RESTORE started. */
  multiUserBack: 'Restore multi-user access',
  restrictedUserBack: 'Restore restricted user access',
  /** Cleanup: the restore created the database and stopped or failed part way (critic A11a). */
  remove: 'Remove the partly restored database',
  /** Restore Files and Filegroups (D1g): the RESTORE DATABASE … FILE/FILEGROUP of the first set, then its logs (`log`), then Varia's
   *  copy-only log backup and its restore. */
  files: 'Restore the files',
  logBackup: 'Back up the log',
  logBackupRestore: 'Restore the log backup'
} as const

// --- Backend copy -------------------------------------------------------------------------------------------------------

/** The restore block of actions-catalog.json: ids, engines, limits, the system databases and the messages C# answers with. */
export function restoreCatalog() {
  return {
    describe: restoreDescribeId, requests: restoreRequestActions, engines: restoreEngines, limits: restoreLimits, systemDatabases: restoreSystemDatabases,
    sourceKinds: restoreSourceKinds, recoveryStates: restoreRecoveryStates, filesSetTypes: restoreFilesSetTypes,
    messages: {
      systemDatabase: restoreMessages.systemDatabase, notDisk: restoreMessages.notDisk, noSets: restoreMessages.noSets, invalidPlan: restoreMessages.invalidPlan,
      damaged: restoreMessages.damaged, copyOnlyLog: restoreMessages.copyOnlyLog, finishedAtStop: restoreMessages.finishedAtStop,
      simpleReadOnly: restoreMessages.simpleReadOnly, otherDatabase: restoreMessages.otherDatabase, filesStayRestoring: restoreMessages.filesStayRestoring,
      standbyOnline: restoreMessages.standbyOnline, primaryOnline: restoreMessages.primaryOnline, logChainAhead: restoreMessages.logChainAhead, logBackedUpDuring: restoreMessages.logBackedUpDuring
    },
    steps: restoreStepTitles
  }
}
