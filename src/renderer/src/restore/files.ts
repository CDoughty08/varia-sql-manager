// Restore Files and Filegroups (D1g), pure: the grid's rows (the files of the newest full and file backups, or their filegroups
// under Restore as filegroup, then the log backups that follow the chosen one), the request actions.script and actions.execute
// take, the problems that mark the two sections, the steps RestoreFilesRun.cs takes, the confirm bar's lines, and the run's
// words. The document is Restore Database's (RestoreService, mode 'files'); vitest holds each rule.
import {
  backupSetTypeSpecs, restoreFilesRecoveryLabels, restoreLimits, restoreMessages, restoreStepTitles, restoreTargetProblem, pathFileName, type BackupFileRow, type BackupSetRow,
  type RestoreFilesOptions, type RestoreFilesSet, type RestoreMove
} from '../../../shared/actions/restore.ts'
import { fileBaseSets, fileRestoreLogs } from '../../../shared/actions/restore-plan.ts'
import { restoreFilesOptionsProblems, type RestoreFilesRequest } from '../../../shared/actions/restore-schema.ts'
import type { RestoredDatabase } from '../../../shared/actions/schema.ts'
import { sameServerPath, serverPathKey, serverPathProblem } from '../../../shared/actions/files.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { destinationOf, sourceSets, type RestoreDraft, type RestoreFacts } from './model'
import { setWhere, type PlannedStep } from './run'

/** What Restore Files and Filegroups adds to the draft. */
export interface RestoreFilesDraft {
  /** The backup set the checked rows restore from: one per restore, so checking a row of another set starts again from it. */
  readonly set?: string
  /** The checked rows: logical file names, or filegroup names under Restore as filegroup. */
  readonly chosen: readonly string[]
  /** Options › Restore as filegroup: the grid lists filegroups, and the restore names them (FILEGROUP =). */
  readonly asFilegroup: boolean
  /** Varia's last steps: back up the log (COPY_ONLY) once the files are restored, and restore that backup WITH RECOVERY. */
  readonly logBackup: boolean
  readonly logBackupFile: string
}

const show = (text: string) => displayText(text)
const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

/** A database a file restore can restore into: it must exist, so the To database list is the server's user databases. */
export const filesDestination = (draft: RestoreDraft, facts: RestoreFacts) => destinationOf(facts, draft.destination)
/** Whether the destination is online: an online file restore leaves the rest of the database in use. */
const online = (draft: RestoreDraft, facts: RestoreFacts) => filesDestination(draft, facts)?.state === 'ONLINE'
/** Whether the destination keeps a log (FULL or BULK_LOGGED): its file restores roll forward through log backups. */
const keepsLog = (draft: RestoreDraft, facts: RestoreFacts) => { const destination = filesDestination(draft, facts); return !!destination && destination.recoveryModel !== 'SIMPLE' }
/**
 * Whether Varia's log backup can end the restore: the destination is online and keeps a log, and the files are restored WITH
 * RECOVERY. Under FULL or BULK_LOGGED an online file restore stays RESTORING until a log backup taken after it is restored (probed
 * on 2025), so the document checks it by default there.
 */
export function logBackupPossible(draft: RestoreDraft, facts: RestoreFacts): boolean {
  return online(draft, facts) && keepsLog(draft, facts) && draft.recovery === 'recovery'
}
/** Whether STANDBY is offered: SQL Server refuses it on an online database's file restore (4302, probed on 2025). */
export const standbyPossible = (draft: RestoreDraft, facts: RestoreFacts): boolean => !online(draft, facts)

/** The sets whose files the document reads: the newest full and file backups of the source, at most restoreLimits.fileSets. */
export function filesBaseSets(draft: RestoreDraft, facts: RestoreFacts): BackupSetRow[] {
  return fileBaseSets(sourceSets(draft, facts), restoreLimits.fileSets)
}
/** The set the checked rows restore from: the one chosen, else the newest whose files are read. */
export function filesBase(draft: RestoreDraft, facts: RestoreFacts): BackupSetRow | undefined {
  const sets = filesBaseSets(draft, facts)
  return sets.find(set => set.id === draft.files?.set) ?? sets.find(set => facts.setFiles?.[set.id])
}
/** A base set's files a restore can name: the ones it holds, no log file (the log backups after it restore the log). */
export function restorableFiles(facts: RestoreFacts, set: BackupSetRow): BackupFileRow[] {
  return (facts.setFiles?.[set.id] ?? []).filter(file => !file.absent && file.type !== 'log')
}

/** A row of Select the backup sets to restore: a file (or filegroup) of a base set, or a log backup that follows the chosen one. */
export interface FilesGridRow {
  readonly key: string
  readonly set: BackupSetRow
  /** The file's or filegroup's name, for a base set's row; absent for a log row. */
  readonly name?: string
  readonly fileType: string
  readonly logicalName: string
  readonly checked: boolean
  /** A log row: checked with the files, and never by itself (restoreMessages.logsFollow). */
  readonly log: boolean
}
const fileTypes: Readonly<Record<BackupFileRow['type'], string>> = { data: 'Rows Data', log: 'Log', filestream: 'FILESTREAM Data', fulltext: 'Full-text', other: 'Other' }

/** The grid's rows: newest base set first, each with its files (or filegroups), then the logs that follow the chosen set. */
export function filesGridRows(draft: RestoreDraft, facts: RestoreFacts): FilesGridRow[] {
  const files = draft.files, base = filesBase(draft, facts), rows: FilesGridRow[] = []
  for (const set of filesBaseSets(draft, facts)) {
    const listed = restorableFiles(facts, set)
    const names = files?.asFilegroup ? [...new Set(listed.map(file => file.filegroup ?? ''))].filter(Boolean) : listed.map(file => file.logical)
    for (const name of names) {
      const members = files?.asFilegroup ? listed.filter(file => file.filegroup === name) : listed.filter(file => file.logical === name)
      const kinds = [...new Set(members.map(file => fileTypes[file.type]))]
      rows.push({
        key: `${set.id}\u0000${name}`, set, name, fileType: kinds.join(', '), logicalName: members.map(file => file.logical).join(', '),
        checked: files?.set === set.id && files.chosen.includes(name), log: false
      })
    }
  }
  const any = !!files?.chosen.length
  if (base) for (const log of fileRestoreLogs(sourceSets(draft, facts), base)) rows.push({ key: log.id, set: log, fileType: 'Log', logicalName: '', checked: any, log: true })
  return rows
}
/** A grid checkbox: checking a row of another set starts again from that set, as one restore restores from one backup set. */
export function toggleFile(draft: RestoreDraft, facts: RestoreFacts, set: string, name: string, checked: boolean): Partial<RestoreDraft> {
  const files = draft.files!, same = (files.set ?? filesBase(draft, facts)?.id) === set
  const chosen = checked ? (same ? [...new Set([...files.chosen, name])] : [name]) : same ? files.chosen.filter(item => item !== name) : files.chosen
  return { files: { ...files, set, chosen } }
}
/** SSMS's grid columns (spec D1 §8, Learn's list), in order. */
export const filesSetColumns = ['Restore', 'Name', 'File Type', 'Type', 'Server', 'File Logical Name', 'Database', 'Start Date', 'Finish Date', 'Size', 'User Name'] as const
export function filesSetCells(row: FilesGridRow): string[] {
  const set = row.set, spec = backupSetTypeSpecs[set.type]
  const size = set.sizeBytes >= 1024 * 1024 ? `${(set.sizeBytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(set.sizeBytes / 1024))} KB`
  return [set.name, row.fileType, `${spec.component} ${spec.type}`, set.server, row.logicalName, set.database, set.start.replace('T', ' '), set.finish.replace('T', ' '), size, set.userName]
}

/** The files the restore writes: the checked ones, or every file of the checked filegroups, of the chosen set. */
export function restoredFiles(draft: RestoreDraft, facts: RestoreFacts): BackupFileRow[] {
  const files = draft.files, base = filesBase(draft, facts)
  if (!files || !base || files.set !== base.id) return []
  return restorableFiles(facts, base).filter(file => files.chosen.includes(files.asFilegroup ? file.filegroup ?? '' : file.logical))
}
/** One row of Restore the database files as: a restored file, where it goes (where it is, unless typed), and why it cannot. */
export interface FilesMoveRow { readonly file: BackupFileRow; readonly restoreAs: string; readonly typed: boolean; readonly problem?: string }
export function filesMoveRows(draft: RestoreDraft, facts: RestoreFacts): FilesMoveRow[] {
  const separator = facts.server?.separator ?? '\\'
  const key = (path: string) => serverPathKey(path, separator) ?? path
  const taken = new Map<string, string>()
  for (const file of facts.server?.files ?? []) if (file.database.toLowerCase() !== draft.destination.toLowerCase()) taken.set(key(file.path), file.database)
  const rows = restoredFiles(draft, facts).map(file => {
    const typed = draft.restoreAs[file.logical]
    const restoreAs = typed ?? file.physical
    const other = taken.get(key(restoreAs))
    const problem = serverPathProblem(restoreAs) ?? (other ? `The file is in use by the database ${other}.` : undefined)
    return { file, restoreAs, typed: typed !== undefined, ...problem ? { problem } : {} }
  })
  return rows.map(row => !row.problem && rows.some(other => other !== row && sameServerPath(other.restoreAs, row.restoreAs, separator)) ? { ...row, problem: 'Another file is restored to this path.' } : row)
}

/** Why a file the restore writes (the rollback undo file, the log backup) cannot go where the draft says. */
function writtenProblem(path: string, facts: RestoreFacts): string | undefined {
  const problem = serverPathProblem(path)
  if (problem) return problem
  const separator = facts.server?.separator ?? '\\', key = serverPathKey(path, separator)
  if (!key) return 'Enter a path to a file.'
  const holder = facts.server?.files.find(file => serverPathKey(file.path, separator) === key)
  if (holder) return `The file is a file of the database ${holder.database}.`
  return /\.(mdf|ndf|ldf)$/i.test(key) ? 'Choose a file without a database file\'s extension (.mdf, .ndf or .ldf).' : undefined
}

/** The problems that keep Script from writing the file restore, by the section that shows them. */
export interface FilesProblems { readonly general: readonly string[]; readonly options: readonly string[] }
export function filesProblems(draft: RestoreDraft, facts: RestoreFacts): FilesProblems {
  const general: string[] = [], options: string[] = []
  const name = draft.destination
  if (!name) general.push('Choose the database whose files to restore.')
  else if (facts.server && !filesDestination(draft, facts)) general.push(`The database ${name} is not on the server: files restore only into an existing database.`)
  const target = name ? restoreTargetProblem(name) : undefined
  if (target) general.push(target)
  if (draft.source === 'device' && draft.devices.length === 0) general.push('Add the backup files to restore from.')
  if (facts.sets.length > 0 && filesBaseSets(draft, facts).length === 0) general.push(restoreMessages.noFileBase)
  else if (facts.sets.length > 0 && !draft.files?.chosen.length) general.push(restoreMessages.noFiles)
  const base = filesBase(draft, facts)
  if (base && draft.files?.set === base.id && !facts.setFiles?.[base.id]) general.push(restoreMessages.filesNotRead)
  const chosen = draft.files?.chosen.length ?? 0
  if (chosen > restoreLimits.restoreFiles) general.push(`A restore names at most ${restoreLimits.restoreFiles} files or filegroups.`)
  if (base && 1 + fileRestoreLogs(sourceSets(draft, facts), base).length > restoreLimits.planSets) general.push(`A restore runs at most ${restoreLimits.planSets} backup sets.`)
  for (const row of filesMoveRows(draft, facts)) if (row.problem) options.push(`${row.file.logical}: ${row.problem}`)
  if (draft.recovery === 'standby') {
    if (!standbyPossible(draft, facts)) options.push(restoreMessages.standbyOnline)
    const problem = draft.standbyFile ? writtenProblem(draft.standbyFile, facts) : 'Choose a rollback undo file.'
    if (problem) options.push(`Rollback undo file: ${problem}`)
  }
  if (draft.files?.logBackup && logBackupPossible(draft, facts)) {
    const problem = draft.files.logBackupFile ? writtenProblem(draft.files.logBackupFile, facts) : 'Choose the log backup file.'
    if (problem) options.push(`Log backup file: ${problem}`)
  }
  return { general, options }
}

/** The file restore actions.script and actions.execute take, or why there is none yet. */
export function restoreFilesRequest(draft: RestoreDraft, facts: RestoreFacts, ids: { readonly connectionId: string; readonly requestId: string }): RestoreFilesRequest | { readonly problem: string } {
  const problems = filesProblems(draft, facts)
  const first = [...problems.general, ...problems.options][0]
  if (first) return { problem: first }
  if (facts.sets.length === 0) return { problem: draft.source === 'device' ? restoreMessages.noSets : restoreMessages.noHistory }
  const destination = filesDestination(draft, facts), base = filesBase(draft, facts), files = draft.files
  if (!destination || !base || !files) return { problem: restoreMessages.noFiles }
  const set = (row: BackupSetRow, type: RestoreFilesSet['type']): RestoreFilesSet => ({ id: row.id, devices: row.devices, file: row.position, type, ...row.name ? { name: row.name.slice(0, restoreLimits.setName) } : {} })
  const sets: RestoreFilesSet[] = [set(base, base.type === 'file' ? 'file' : 'full'), ...fileRestoreLogs(sourceSets(draft, facts), base).map(log => set(log, 'log'))]
  const separator = facts.server?.separator ?? '\\'
  const relocate: RestoreMove[] = filesMoveRows(draft, facts).filter(row => !sameServerPath(row.restoreAs, row.file.physical, separator)).map(row => ({ logical: row.file.logical, physical: row.restoreAs }))
  const options: RestoreFilesOptions = {
    sets, files: files.asFilegroup ? [] : files.chosen, filegroups: files.asFilegroup ? files.chosen : [], relocate, replace: draft.replace, restrictedUser: draft.restrictedUser, recovery: draft.recovery,
    ...draft.recovery === 'standby' ? { standbyFile: draft.standbyFile } : {}, ...files.logBackup && logBackupPossible(draft, facts) ? { logBackup: { file: files.logBackupFile } } : {}
  }
  const shape = restoreFilesOptionsProblems(options)[0]
  if (shape) return { problem: shape.message }
  return { action: 'restoreFiles', ...ids, target: { kind: 'database', name: destination.name }, identity: { id: destination.id, created: destination.created }, restoreFiles: options }
}

/**
 * The steps RestoreFilesRun.cs's RestoreFilesSteps takes for `request`, in its order, with its titles and details: "Restore the
 * files" from the first set, one "Restore log backup n of m" per log, then Varia's "Back up the log" and "Restore the log backup".
 * Every one is a RESTORE or the BACKUP, which report STATS progress, so each counts for the overall percent.
 */
export function plannedFileSteps(request: RestoreFilesRequest): PlannedStep[] {
  const options = request.restoreFiles, logs = options.sets.length - 1, steps: PlannedStep[] = []
  options.sets.forEach((set, index) => steps.push({
    title: index === 0 ? restoreStepTitles.files : restoreStepTitles.log + (logs > 1 ? ` ${index} of ${logs}` : ''), detail: `${setWhere(set)}, position ${set.file}`, set: true
  }))
  if (options.logBackup) {
    const detail = pathFileName(options.logBackup.file)
    steps.push({ title: restoreStepTitles.logBackup, detail, set: true }, { title: restoreStepTitles.logBackupRestore, detail, set: true })
  }
  return steps
}

/**
 * The confirm bar's lines before a file restore runs, each only when its fact applies (Varia's, as Restore Database's are):
 * WITH REPLACE, and files that would stay restoring because no log backup taken after them is restored.
 */
export function filesConfirmLines(draft: RestoreDraft, facts: RestoreFacts): string[] {
  const destination = filesDestination(draft, facts)
  if (!destination) return []
  const name = show(destination.name), lines: string[] = []
  if (draft.replace) lines.push(`Restoring files over ${name} WITH REPLACE skips SQL Server's safety checks. If the restore stops or fails part way, the files are left restoring and cannot be used until a restore finishes.`)
  if (online(draft, facts) && keepsLog(draft, facts) && draft.recovery === 'recovery' && !draft.files?.logBackup)
    lines.push(`No log backup is taken: ${restoreMessages.filesStayRestoring.charAt(0).toLowerCase()}${restoreMessages.filesStayRestoring.slice(1)}`)
  return lines
}

/** The Stop question: stopping leaves the files restoring (the database existed, so Varia never drops it). */
export function filesStopQuestion(database: string): string {
  return `Stop the restore? Stopping leaves the files being restored in ${show(database)} restoring and unusable until a restore finishes.`
}
/** The Run panel's note while a file restore runs. */
export function filesRunNote(database: string): string {
  return `${show(database)} stays on the server: if the restore stops or fails, the files it reached stay restoring until a restore finishes, and the steps completed are listed.`
}
/** The outcome's line for the files still restoring after the run, by logical name (restored.filesRestoring). */
export function filesRestoringText(database: string, restored: RestoredDatabase | undefined): string | undefined {
  const files = restored && !restored.absent ? restored.filesRestoring : undefined
  if (!files?.length) return undefined
  return `${files.length === 1 ? 'The file' : 'The files'} ${files.map(show).join(', ')} of ${show(database)} ${files.length === 1 ? 'is' : 'are'} restoring and cannot be used until a restore finishes.`
}

/** The sections' one-line summaries while a file restore runs. */
export function filesSectionSummaries(draft: RestoreDraft, facts: RestoreFacts): { readonly general: string; readonly options: string } {
  const base = filesBase(draft, facts), restored = restoredFiles(draft, facts)
  const logs = base ? fileRestoreLogs(sourceSets(draft, facts), base).length : 0
  const what = draft.files?.asFilegroup ? plural(draft.files.chosen.length, 'filegroup', 'filegroups') : plural(restored.length, 'file', 'files')
  const general = `${what} of ${show(draft.destination)} from ${base ? show(setWhere(base)) : 'no backup set'}${logs ? ` + ${plural(logs, 'log backup', 'log backups')}` : ''}`
  const moved = filesMoveRows(draft, facts).filter(row => row.typed).length
  const options = [...draft.replace ? ['WITH REPLACE'] : [], restoreFilesRecoveryLabels[draft.recovery].replace(/^.*\((RESTORE WITH \w+)\)$/, '$1'),
    ...draft.files?.logBackup && logBackupPossible(draft, facts) ? ['log backup on'] : [], ...moved ? [`${moved} moved`] : []].join(' · ')
  return { general, options }
}
