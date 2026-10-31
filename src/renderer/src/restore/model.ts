// Restore Database's draft and what follows from it (D1e): the plan the grid checks, the files the Files page relocates,
// the problems that mark sections, and the request actions.script takes. Pure, so the document answers a checkbox, a
// Timeline drag or a typed path at once, and vitest holds each rule.
import {
  backupSetTypeSpecs, pathFileName, restoreAsPath, restoreLimits, restoreMessages, restoreTargetProblem, standbyFile, tailLogFile, type BackupFileRow, type BackupSetRow, type RestoreDestination,
  type RestoreMove, type RestoreOptions, type RestorePlanSet, type RestoreRecovery, type RestoreServerFacts
} from '../../../shared/actions/restore.ts'
import { dependants, lastBackupTaken, orderSelection, planRestore, selectionProblem, tailSetId } from '../../../shared/actions/restore-plan.ts'
import { restoreOptionsProblems, type RestoreRequest } from '../../../shared/actions/restore-schema.ts'
import { folderPath, sameServerPath, serverPathProblem } from '../../../shared/actions/files.ts'

export type RestoreSourceKind = 'database' | 'device'
/** What the person chose on the three pages; everything else (the plan, the moves) follows from it and the describe. */
export interface RestoreDraft {
  readonly source: RestoreSourceKind
  /** Source › Database: a database msdb has backups of. */
  readonly database: string
  /** Source › Device: the backup files, in the order Select backup devices lists them. */
  readonly devices: readonly string[]
  /** Destination › Database: typed, or one of the server's. */
  readonly destination: string
  /** Restore to: undefined for the last backup taken, else the Timeline's point (the server's local time). */
  readonly stopAt?: string
  /** The grid's checkboxes, once the person changes one: the sets to restore, in any order. */
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
/** The database the backups are of: Source › Database, or the latest full backup's on the devices. */
export function sourceDatabase(draft: RestoreDraft, facts: RestoreFacts): string {
  if (draft.source === 'database') return draft.database
  const full = [...facts.sets].filter(set => set.type === 'full').sort((a, b) => a.finish < b.finish ? 1 : -1)[0]
  return full?.database ?? facts.sets[0]?.database ?? ''
}
/**
 * Whether a tail-log backup can be taken (SSMS offers it, checked, in this case): the destination is the source database,
 * it exists online, and its recovery model keeps a log (FULL or BULK_LOGGED).
 */
export function tailLogPossible(draft: RestoreDraft, facts: RestoreFacts): boolean {
  const destination = destinationOf(facts, draft.destination)
  return !!destination && destination.name.toLowerCase() === sourceDatabase(draft, facts).toLowerCase() && destination.state === 'ONLINE' && destination.recoveryModel !== 'SIMPLE'
}

/** The plan the grid checks: the planner's, or Manual Selection's in restore order, with why it cannot restore. */
export interface DraftPlan { readonly ids: readonly string[]; readonly stopAt?: string; readonly problem?: string; readonly manual: boolean }
export function draftPlan(draft: RestoreDraft, facts: RestoreFacts): DraftPlan {
  const tail = draft.tailLog && tailLogPossible(draft, facts)
  if (draft.manual) {
    const ids = orderSelection(facts.sets, draft.manual.filter(id => id !== tailSetId || tail))
    const problem = selectionProblem(facts.sets, ids)
    const lastLog = facts.sets.find(set => set.id === ids.filter(id => id !== tailSetId).at(-1))?.type === 'log'
    return { ids, ...draft.stopAt && lastLog ? { stopAt: draft.stopAt } : {}, ...problem ? { problem } : {}, manual: true }
  }
  const plan = planRestore(facts.sets, { ...draft.stopAt ? { stopAt: draft.stopAt } : {}, tailLog: tail })
  return { ids: plan.ids, ...plan.stopAt ? { stopAt: plan.stopAt } : {}, ...plan.problem ? { problem: plan.problem } : {}, manual: false }
}
/** A grid checkbox: checking adds a set, unchecking removes it and every set after it in the plan, as SSMS does. */
export function toggleSet(draft: RestoreDraft, facts: RestoreFacts, id: string, checked: boolean): RestoreDraft {
  const current = draftPlan(draft, facts).ids
  const manual = checked ? [...new Set([...current, id])] : current.filter(item => item !== id && !dependants(current, id).includes(item))
  return { ...draft, manual }
}

/** "The last backup taken (date)", or the point (SSMS's Restore to:, recalled). */
export function restoreToText(draft: RestoreDraft, facts: RestoreFacts, plan: DraftPlan): string {
  if (draft.stopAt) return draft.stopAt.replace('T', ' ')
  const last = lastBackupTaken(facts.sets, plan.ids)
  return last ? `The last backup taken (${last.replace('T', ' ')})` : 'The last backup taken'
}

/** One row of the Files page: where the file goes, by default or as typed. */
export interface FileRow { readonly file: BackupFileRow; readonly restoreAs: string; readonly typed: boolean; readonly problem?: string }
export function fileRows(draft: RestoreDraft, facts: RestoreFacts): FileRow[] {
  const server = facts.server, separator = server?.separator ?? '\\', source = sourceDatabase(draft, facts)
  const taken = new Map<string, string>()
  for (const file of server?.files ?? []) if (file.database.toLowerCase() !== draft.destination.toLowerCase()) taken.set(file.path.toLowerCase(), file.database)
  const rows = facts.files.map(file => {
    const typed = draft.restoreAs[file.logical]
    const destination = draft.destination || source
    // Relocate all files to folder keeps each file's default name and changes only its folder.
    const relocated = draft.relocate ? (file.type === 'log' ? draft.logFolder : draft.dataFolder) : ''
    const restoreAs = typed ?? (relocated
      ? folderPath(relocated, separator) + pathFileName(restoreAsPath(file, source, destination, folderPath(relocated, separator), separator))
      : restoreAsPath(file, source, destination, file.type === 'log' ? server?.logPath : server?.dataPath, separator))
    const other = taken.get(restoreAs.toLowerCase())
    const problem = serverPathProblem(restoreAs) ?? (other ? `The file is in use by the database ${other}.` : undefined)
    return { file, restoreAs, typed: typed !== undefined, ...problem ? { problem } : {} }
  })
  // Two files restored to one path.
  return rows.map(row => !row.problem && rows.some(other => other !== row && sameServerPath(other.restoreAs, row.restoreAs, separator)) ? { ...row, problem: 'Another file is restored to this path.' } : row)
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
  if (plan.ids.filter(id => id !== tailSetId).length > restoreLimits.planSets) general.push(`A restore runs at most ${restoreLimits.planSets} backup sets.`)
  for (const row of fileRows(draft, facts)) if (row.problem) files.push(`${row.file.logical}: ${row.problem}`)
  if (draft.relocate) for (const [label, folder] of [['Data file folder', draft.dataFolder], ['Log file folder', draft.logFolder]] as const) {
    const problem = folder ? serverPathProblem(folder) : 'Choose a folder.'
    if (problem) files.push(`${label}: ${problem}`)
  }
  if (draft.recovery === 'standby') { const problem = draft.standbyFile ? serverPathProblem(draft.standbyFile) : 'Choose a standby file.'; if (problem) options.push(`Standby file: ${problem}`) }
  if (draft.keepReplication && draft.recovery === 'norecovery') options.push('Preserve the replication settings cannot be used with RESTORE WITH NORECOVERY.')
  if (draft.tailLog && tailLogPossible(draft, facts)) { const problem = draft.tailLogFile ? serverPathProblem(draft.tailLogFile) : 'Choose the tail-log backup file.'; if (problem) options.push(`Backup file: ${problem}`) }
  return { general, files, options }
}

/** The restore actions.script takes, or why there is none yet. */
export function restoreRequest(draft: RestoreDraft, facts: RestoreFacts, ids: { readonly connectionId: string; readonly requestId: string }): RestoreRequest | { readonly problem: string } {
  const plan = draftPlan(draft, facts)
  const problems = draftProblems(draft, facts, plan)
  const first = [...problems.general, ...problems.files, ...problems.options][0]
  if (first) return { problem: first }
  if (facts.sets.length === 0) return { problem: draft.source === 'device' ? restoreMessages.noSets : restoreMessages.noHistory }
  const byId = new Map(facts.sets.map(set => [set.id, set]))
  const sets: RestorePlanSet[] = plan.ids.filter(id => id !== tailSetId).map(id => {
    const set = byId.get(id)!
    return { id: set.id, devices: set.devices, file: set.position, type: set.type as RestorePlanSet['type'], ...set.name ? { name: set.name.slice(0, restoreLimits.setName) } : {} }
  })
  const relocate: RestoreMove[] = fileRows(draft, facts).filter(row => !sameServerPath(row.restoreAs, row.file.physical, facts.server?.separator ?? '\\')).map(row => ({ logical: row.file.logical, physical: row.restoreAs }))
  const destination = destinationOf(facts, draft.destination)
  const tail = draft.tailLog && tailLogPossible(draft, facts)
  const options: RestoreOptions = {
    sets, relocate, replace: draft.replace, keepReplication: draft.keepReplication, restrictedUser: draft.restrictedUser, recovery: draft.recovery,
    ...plan.stopAt ? { stopAt: plan.stopAt } : {}, ...draft.recovery === 'standby' ? { standbyFile: draft.standbyFile } : {},
    ...tail ? { tailLog: { file: draft.tailLogFile, noRecovery: draft.leaveRestoring } } : {}, closeConnections: draft.closeConnections
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
