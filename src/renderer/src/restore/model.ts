// Restore Database's draft and what follows from it (D1e): the plan the grid checks, the files the Files page relocates,
// the problems that mark sections, and the request actions.script takes. Pure, so the document answers a checkbox, a
// Timeline drag or a typed path at once, and vitest holds each rule.
import {
  backupSetTypeSpecs, pathFileName, restoreAsPath, restoreLimits, restoreMessages, restoreTargetProblem, standbyFile, tailLogFile, type BackupFileRow, type BackupSetRow, type RestoreDestination,
  type RestoreMove, type RestoreOptions, type RestorePlanSet, type RestoreRecovery, type RestoreServerFacts
} from '../../../shared/actions/restore.ts'
import { dependants, lastBackupTaken, orderSelection, planRestore, reachesPoint, selectionProblem, usableSet } from '../../../shared/actions/restore-plan.ts'
import { restoreOptionsProblems, type RestoreRequest } from '../../../shared/actions/restore-schema.ts'
import { folderPath, sameServerPath, serverPathKey, serverPathProblem } from '../../../shared/actions/files.ts'
import type { RestoreFilesDraft } from './files'

export type RestoreSourceKind = 'database' | 'device'
/** What the person chose on the three pages; everything else (the plan, the moves) follows from it and the describe. */
export interface RestoreDraft {
  readonly source: RestoreSourceKind
  /** Source › Database: a database msdb has backups of. */
  readonly database: string
  /** Source › Device: the backup files, in the order Select backup devices lists them. */
  readonly devices: readonly string[]
  /** Source › Device › Database: which database's sets on the media restore (the first the media hold until one is chosen). */
  readonly deviceDatabase?: string
  /** Destination › Database: typed, or one of the server's. */
  readonly destination: string
  /** Restore to: undefined for the last backup taken, else the Timeline's point (the server's local time). */
  readonly stopAt?: string
  /** Manual Selection, while it is checked: the grid's checked sets, in any order. Unchecking it brings the planner's plan back. */
  readonly manual?: readonly string[]
  /** Files: Relocate all files to folder, with its two folders. */
  readonly relocate: boolean
  readonly dataFolder: string
  readonly logFolder: string
  /** Files: a Restore As the person typed, by logical name. */
  readonly restoreAs: Readonly<Record<string, string>>
  readonly replace: boolean
  readonly keepReplication: boolean
  readonly restrictedUser: boolean
  readonly recovery: RestoreRecovery
  readonly standbyFile: string
  /** Tail-Log backup: Take tail-log backup before restore, and Leave source database in the restoring state. */
  readonly tailLog: boolean
  readonly leaveRestoring: boolean
  readonly tailLogFile: string
  readonly closeConnections: boolean
  /** Restore Files and Filegroups (mode 'files'): the checked files and Varia's log backup. */
  readonly files?: RestoreFilesDraft
}
/** What the describes answered: the server, msdb's databases, the sets of the source, and the files of the plan's full backup. */
export interface RestoreFacts {
  readonly server?: RestoreServerFacts
  readonly historyDatabases: readonly string[]
  readonly sets: readonly BackupSetRow[]
  readonly setsTruncated: boolean
  /** The files of `filesFor` (a set id), the plan's full backup. */
  readonly files: readonly BackupFileRow[]
  readonly filesFor?: string
  /** Restore Files and Filegroups: the files of each of the newest full and file backups, by set id, as they are read. */
  readonly setFiles?: Readonly<Record<string, readonly BackupFileRow[]>>
}

export function initialDraft(database: string, facts: RestoreFacts, at: Date): RestoreDraft {
  const server = facts.server, separator = server?.separator ?? '\\'
  return {
    source: 'database', database, devices: [], destination: database, relocate: false, dataFolder: server?.dataPath ?? '', logFolder: server?.logPath ?? '', restoreAs: {},
    replace: false, keepReplication: false, restrictedUser: false, recovery: 'recovery', standbyFile: standbyFile(server?.backupPath, separator, database, at),
    tailLog: false, leaveRestoring: true, tailLogFile: tailLogFile(server?.backupPath, separator, database, at), closeConnections: false
  }
}

/** The destination as the server has it, when it exists. Names compare as typed (a case-insensitive server matches them too). */
export function destinationOf(facts: RestoreFacts, name: string): RestoreDestination | undefined {
  return facts.server?.destinations.find(item => item.name === name) ?? facts.server?.destinations.find(item => item.name.toLowerCase() === name.toLowerCase())
}
/** The databases the media hold, in the order their sets are on them (Source › Device › Database). */
export function deviceDatabases(facts: RestoreFacts): string[] {
  return [...new Set(facts.sets.map(set => set.database))]
}
/** The database the backups are of: Source › Database, or Source › Device › Database (the first the media hold until one is chosen). */
export function sourceDatabase(draft: RestoreDraft, facts: RestoreFacts): string {
  if (draft.source === 'database') return draft.database
  const names = deviceDatabases(facts)
  return draft.deviceDatabase !== undefined && names.includes(draft.deviceDatabase) ? draft.deviceDatabase : names[0] ?? ''
}
/** The sets the grid lists and the planner plans: the history's (one database's already), or the chosen database's on the media,
 *  whose sets of other databases would chain by LSN alone. */
export function sourceSets(draft: RestoreDraft, facts: RestoreFacts): readonly BackupSetRow[] {
  if (draft.source === 'database') return facts.sets
  const database = sourceDatabase(draft, facts)
  return facts.sets.filter(set => set.database === database)
}
/**
 * Whether the destination is the database the backups are of: the same name and, where both are known, the same backup family
 * (a database of that name from another server, or one dropped and created again, has another, and its changes are not in them).
 */
export function sameDatabase(draft: RestoreDraft, facts: RestoreFacts): boolean {
  const destination = destinationOf(facts, draft.destination)
  if (!destination || destination.name.toLowerCase() !== sourceDatabase(draft, facts).toLowerCase()) return false
  const full = sourceSets(draft, facts).find(set => set.id === draftPlan(draft, facts).ids[0])
  return !destination.familyGuid || !full?.familyGuid || destination.familyGuid.toLowerCase() === full.familyGuid.toLowerCase()
}
/**
 * Whether a tail-log backup can be taken (SSMS offers it, checked, in this case): the destination is the source database,
 * it exists online, and its recovery model keeps a log (FULL or BULK_LOGGED).
 */
export function tailLogPossible(draft: RestoreDraft, facts: RestoreFacts): boolean {
  const destination = destinationOf(facts, draft.destination)
  return !!destination && sameDatabase(draft, facts) && destination.state === 'ONLINE' && destination.recoveryModel !== 'SIMPLE'
}
/** Whether Close existing connections applies: it is checked, and the destination exists online (one a stopped restore left RESTORING has no connections, and SET SINGLE_USER fails on it). */
export function closesConnections(draft: RestoreDraft, facts: RestoreFacts): boolean {
  return draft.closeConnections && destinationOf(facts, draft.destination)?.state === 'ONLINE'
}

/** The plan the grid checks: the planner's, or Manual Selection's in restore order, with why it cannot restore. */
export interface DraftPlan { readonly ids: readonly string[]; readonly stopAt?: string; readonly problem?: string; readonly manual: boolean }
export function draftPlan(draft: RestoreDraft, facts: RestoreFacts): DraftPlan {
  const sets = sourceSets(draft, facts)
  if (draft.manual) {
    const ids = orderSelection(sets, draft.manual)
    let problem = selectionProblem(sets, ids), stopAt: string | undefined
    // A point the checked sets stop at takes STOPAT on their last log; one they cannot stop at is a problem, never dropped.
    const atBase = sets.find(set => set.id === ids.at(-1))?.type !== 'log' && lastBackupTaken(sets, ids) === draft.stopAt
    if (draft.stopAt && !atBase) {
      if (reachesPoint(sets, ids, draft.stopAt)) stopAt = draft.stopAt
      else problem ??= restoreMessages.notReached
    }
    return { ids, ...stopAt ? { stopAt } : {}, ...problem ? { problem } : {}, manual: true }
  }
  const plan = planRestore(sets, draft.stopAt ? { stopAt: draft.stopAt } : {})
  return { ids: plan.ids, ...plan.stopAt ? { stopAt: plan.stopAt } : {}, ...plan.problem ? { problem: plan.problem } : {}, manual: false }
}
/** Whether the grid may check a set: Manual Selection is on, and the planner could use the set (not striped, damaged or of a kind it does not plan). */
export const checkable = (draft: RestoreDraft, set: BackupSetRow): boolean => !!draft.manual && usableSet(set)
/** Why the planner never uses a set, or undefined: its problem (not on disk), damage, a copy-only log, or a kind it does not plan. */
export function setReason(set: BackupSetRow): string | undefined {
  if (set.problem) return set.problem
  if (set.damaged) return restoreMessages.damaged
  if (set.type === 'log' && set.copyOnly) return restoreMessages.copyOnlyLog
  return usableSet(set) ? undefined : restoreMessages.notPlanned
}
/** Manual Selection: checking it starts from the plan the grid shows; unchecking it brings the planner's plan back. */
export function setManual(draft: RestoreDraft, facts: RestoreFacts, on: boolean): Partial<RestoreDraft> {
  return on ? { manual: draftPlan(draft, facts).ids } : { manual: undefined }
}
/** A grid checkbox under Manual Selection: checking adds a set, unchecking removes it and every set after it in the plan, as SSMS does. */
export function toggleSet(draft: RestoreDraft, facts: RestoreFacts, id: string, checked: boolean): RestoreDraft {
  const current = draftPlan(draft, facts).ids
  const manual = checked ? [...new Set([...current, id])] : current.filter(item => item !== id && !dependants(current, id).includes(item))
  return { ...draft, manual }
}

/** "<name> does not exist yet: the restore creates it.", for a valid destination the server does not have (the mockup's note). */
export function destinationNote(draft: RestoreDraft, facts: RestoreFacts): string | undefined {
  const name = draft.destination
  const valid = name.trim() !== '' && name.length <= 128 && !name.includes('\u0000') && !restoreTargetProblem(name)
  return facts.server && valid && !destinationOf(facts, name) ? `${name} does not exist yet: the restore creates it.` : undefined
}

/** "The last backup taken (date)", or the point (SSMS's Restore to:, recalled). */
export function restoreToText(draft: RestoreDraft, facts: RestoreFacts, plan: DraftPlan): string {
  if (draft.stopAt) return draft.stopAt.replace('T', ' ')
  const last = lastBackupTaken(sourceSets(draft, facts), plan.ids)
  return last ? `The last backup taken (${last.replace('T', ' ')})` : 'The last backup taken'
}

/** One row of the Files page: where the file goes, by default or as typed. */
export interface FileRow { readonly file: BackupFileRow; readonly restoreAs: string; readonly typed: boolean; readonly problem?: string }
export function fileRows(draft: RestoreDraft, facts: RestoreFacts): FileRow[] {
  const server = facts.server, separator = server?.separator ?? '\\', source = sourceDatabase(draft, facts)
  const taken = new Map<string, string>()
  // Paths compare as the files they name on the server's platform, as RestoreRun.cs compares them: '.', '..' and doubled
  // separators resolved, and on Windows without case.
  const key = (path: string) => serverPathKey(path, separator) ?? path
  for (const file of server?.files ?? []) if (file.database.toLowerCase() !== draft.destination.toLowerCase()) taken.set(key(file.path), file.database)
  const rows = facts.files.map(file => {
    const typed = draft.restoreAs[file.logical]
    const destination = draft.destination || source
    // Relocate all files to folder keeps each file's default name and changes only its folder.
    const relocated = draft.relocate ? (file.type === 'log' ? draft.logFolder : draft.dataFolder) : ''
    const restoreAs = typed ?? (relocated
      ? folderPath(relocated, separator) + pathFileName(restoreAsPath(file, source, destination, folderPath(relocated, separator), separator))
      : restoreAsPath(file, source, destination, file.type === 'log' ? server?.logPath : server?.dataPath, separator))
    const other = taken.get(key(restoreAs))
    const problem = serverPathProblem(restoreAs) ?? (other ? `The file is in use by the database ${other}.` : undefined)
    return { file, restoreAs, typed: typed !== undefined, ...problem ? { problem } : {} }
  })
  // Two files restored to one path.
  return rows.map(row => !row.problem && rows.some(other => other !== row && sameServerPath(other.restoreAs, row.restoreAs, separator)) ? { ...row, problem: 'Another file is restored to this path.' } : row)
}

/** Why the standby file or the tail-log backup cannot be written where the draft says: a bad path, a database's file (STANDBY
 *  overwrites its file; RestoreRun.cs's preflight refuses it too), or a database file's extension. */
function writtenFileProblem(path: string, facts: RestoreFacts): string | undefined {
  const problem = serverPathProblem(path)
  if (problem) return problem
  const separator = facts.server?.separator ?? '\\', key = serverPathKey(path, separator)
  if (!key) return 'Enter a path to a file.'
  const holder = facts.server?.files.find(file => serverPathKey(file.path, separator) === key)
  if (holder) return `The file is a file of the database ${holder.database}.`
  return /\.(mdf|ndf|ldf)$/i.test(key) ? 'Choose a file without a database file\'s extension (.mdf, .ndf or .ldf).' : undefined
}

/** The problems that keep Script from writing the restore, by the section that shows them. */
export interface DraftProblems { readonly general: readonly string[]; readonly files: readonly string[]; readonly options: readonly string[] }
export function draftProblems(draft: RestoreDraft, facts: RestoreFacts, plan = draftPlan(draft, facts)): DraftProblems {
  const general: string[] = [], files: string[] = [], options: string[] = []
  const name = draft.destination
  if (!name.trim()) general.push('Type the name of the database to restore to.')
  else if (name.length > 128 || name.includes('\u0000')) general.push('A database name is 1 to 128 characters.')
  const target = restoreTargetProblem(name)
  if (target) general.push(target)
  if (draft.source === 'device' && draft.devices.length === 0) general.push('Add the backup files to restore from.')
  if (facts.sets.length > 0 && plan.problem) general.push(plan.problem)
  if (facts.sets.length > 0 && plan.ids.length === 0 && !plan.problem) general.push(restoreMessages.invalidPlan)
  if (plan.ids.length > restoreLimits.planSets) general.push(`A restore runs at most ${restoreLimits.planSets} backup sets.`)
  // The Files page's rows are the plan's full backup's: until they are read, they are another full's.
  if (plan.ids.length > 0 && facts.filesFor !== plan.ids[0]) files.push(restoreMessages.filesNotRead)
  for (const row of fileRows(draft, facts)) if (row.problem) files.push(`${row.file.logical}: ${row.problem}`)
  if (draft.relocate) for (const [label, folder] of [['Data file folder', draft.dataFolder], ['Log file folder', draft.logFolder]] as const) {
    const problem = folder ? serverPathProblem(folder) : 'Choose a folder.'
    if (problem) files.push(`${label}: ${problem}`)
  }
  if (draft.recovery === 'standby') { const problem = draft.standbyFile ? writtenFileProblem(draft.standbyFile, facts) : 'Choose a standby file.'; if (problem) options.push(`Standby file: ${problem}`) }
  if (draft.keepReplication && draft.recovery === 'norecovery') options.push('Preserve the replication settings cannot be used with RESTORE WITH NORECOVERY.')
  if (draft.tailLog && tailLogPossible(draft, facts)) { const problem = draft.tailLogFile ? writtenFileProblem(draft.tailLogFile, facts) : 'Choose the tail-log backup file.'; if (problem) options.push(`Backup file: ${problem}`) }
  return { general, files, options }
}

/** The restore actions.script takes, or why there is none yet. */
export function restoreRequest(draft: RestoreDraft, facts: RestoreFacts, ids: { readonly connectionId: string; readonly requestId: string }): RestoreRequest | { readonly problem: string } {
  const plan = draftPlan(draft, facts)
  const problems = draftProblems(draft, facts, plan)
  const first = [...problems.general, ...problems.files, ...problems.options][0]
  if (first) return { problem: first }
  if (facts.sets.length === 0) return { problem: draft.source === 'device' ? restoreMessages.noSets : restoreMessages.noHistory }
  if (plan.ids.length > 0 && facts.filesFor !== plan.ids[0]) return { problem: restoreMessages.filesNotRead }
  const byId = new Map(sourceSets(draft, facts).map(set => [set.id, set]))
  const sets: RestorePlanSet[] = plan.ids.map(id => {
    const set = byId.get(id)!
    return { id: set.id, devices: set.devices, file: set.position, type: set.type as RestorePlanSet['type'], ...set.name ? { name: set.name.slice(0, restoreLimits.setName) } : {} }
  })
  const relocate: RestoreMove[] = fileRows(draft, facts).filter(row => !sameServerPath(row.restoreAs, row.file.physical, facts.server?.separator ?? '\\')).map(row => ({ logical: row.file.logical, physical: row.restoreAs }))
  const destination = destinationOf(facts, draft.destination)
  const tail = draft.tailLog && tailLogPossible(draft, facts)
  const options: RestoreOptions = {
    sets, relocate, replace: draft.replace, keepReplication: draft.keepReplication, restrictedUser: draft.restrictedUser, recovery: draft.recovery,
    ...plan.stopAt ? { stopAt: plan.stopAt } : {}, ...draft.recovery === 'standby' ? { standbyFile: draft.standbyFile } : {},
    ...tail ? { tailLog: { file: draft.tailLogFile, noRecovery: draft.leaveRestoring } } : {}, closeConnections: closesConnections(draft, facts)
  }
  const shape = restoreOptionsProblems(options)[0]
  if (shape) return { problem: shape.message }
  return {
    action: 'restore', ...ids, target: { kind: 'database', name: draft.destination },
    ...destination ? { identity: { id: destination.id, created: destination.created } } : {}, restore: options
  }
}

/** A set as the grid's sixteen columns show it (SSMS's, recalled), in order. */
export const setColumns = ['Restore', 'Name', 'Component', 'Type', 'Server', 'Database', 'Position', 'First LSN', 'Last LSN', 'Checkpoint LSN', 'Full LSN', 'Start Date', 'Finish Date', 'Size', 'User Name', 'Expiration'] as const
export function setCells(set: BackupSetRow): string[] {
  const spec = backupSetTypeSpecs[set.type]
  const size = set.sizeBytes >= 1024 * 1024 ? `${(set.sizeBytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(set.sizeBytes / 1024))} KB`
  return [set.name, spec.component, spec.type, set.server, set.database, String(set.position), set.firstLsn, set.lastLsn, set.checkpointLsn, set.databaseBackupLsn,
    set.start.replace('T', ' '), set.finish.replace('T', ' '), size, set.userName, set.expiration?.replace('T', ' ') ?? '']
}
