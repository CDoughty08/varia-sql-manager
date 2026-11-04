// Attach Databases (D1d): its draft, the Add…, Remove, "…" and path-check operations its page runs, the request OK sends
// and Script scripts, and each row's Status as the reply's steps tell it. No React here, so the operations and their tests
// stay in Node; ObjectDialogService runs the dialog and pages/AttachDatabasePage.tsx renders it.
import { actionLimits, serverFilePurposeSpecs } from '../../../shared/actions/catalog.ts'
import { serverPathProblem } from '../../../shared/actions/files.ts'
import type { ActionDescribeRequest, ActionDescribeResult, ActionStep, AttachDatabaseInfo, AttachRequest, AttachServerFacts } from '../../../shared/actions/schema.ts'
import type { ApiResult } from '../../../shared/contracts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { ServerFilePick } from '../server-files/ServerFilePickerService'
import type { DialogPhase } from './ObjectDialogService'

/** A file of a row's database: as its primary file records it, where it is now, and whether the server finds it there
 *  (undefined: unknown, as SQL Server 2016 answers a login outside sysadmin, or a share the file names, which is never probed).
 *  `unchecked`: typed since the last check, which Enter or leaving the field runs; `checking`: that check is running. */
export interface AttachFileRow { readonly original: string; readonly type: 'data' | 'log'; readonly current: string; readonly found?: boolean; readonly unchecked?: boolean; readonly checking?: boolean }
/** One database to attach: its .mdf, its database's name, Attach As, Owner (undefined: <default>, the attaching login) and files. */
export interface AttachRow { readonly key: number; readonly mdf: string; readonly databaseName: string; readonly name: string; readonly owner?: string; readonly files: readonly AttachFileRow[] }
export interface AttachDraft {
  readonly rows: readonly AttachRow[]
  /** The selected row's key: its files show under the grid. */
  readonly selected?: number
  /** The selected file's index in the selected row. */
  readonly selectedFile?: number
  /** Add… is reading a file. */
  readonly adding?: boolean
  /** Why the last Add… or path check did not work. */
  readonly problem?: string
  readonly nextKey: number
}

export const ownerDefault = '<default>'
/** The page's words: SSMS's as recalled (unverified against SSMS 22), and Learn's for the rebuilt log. */
export const attachMessages = {
  notFound: 'Not found',
  /** Learn, Attach a database: a log file that is not found; with every log file removed, SQL Server rebuilds one. */
  rebuildLog: 'No log file is listed, so SQL Server will rebuild the log (FOR ATTACH_REBUILD_LOG). This breaks the log backup chain, needs the database to have been shut down cleanly, and needs all of its data files.',
  missingData: (name: string) => `A data file of ${displayText(name)} is not found. Correct its Current File Path, or remove the database.`,
  /** OK waits for Add… and for the path checks, whose answers it would otherwise drop. */
  reading: 'Reading the file…',
  checking: (name: string) => `Checking the files of ${displayText(name)}…`,
  unchecked: (name: string) => `Press Enter in a Current File Path of ${displayText(name)}, or leave it, to check the file.`,
  duplicate: (name: string) => `Two databases cannot be attached as ${displayText(name)}.`,
  listed: (path: string) => `${displayText(path)} is already listed.`,
  limit: `At most ${actionLimits.attachDatabases} databases can be attached at once.`,
  name: 'Enter a name in Attach As (1 to 128 characters).',
  /** SSMS's Rolled Back message (Learn). */
  rolledBack: 'The attach succeeded but was rolled back because another database failed to attach.',
  keptAttached: (message: string) => `Attached, but it could not be detached again: ${message}`,
  unknown: 'SQL Server 2016 does not tell a login outside sysadmin whether this file exists.'
} as const

export const initialAttachDraft = (): AttachDraft => ({ rows: [], nextKey: 1 })

const nameProblem = (name: string) => name.length === 0 || name.length > 128 || name.includes('\u0000') ? attachMessages.name : undefined

/**
 * Why OK cannot run the rows as they are (the first reason), or undefined. A data file that is not found disables OK, as in
 * SSMS, and so does one typed and not yet checked; OK also waits while Add… reads a file or any path is checked, since the
 * dialog takes no answer while OK runs.
 */
export function attachBlocked(draft: AttachDraft): string | undefined {
  if (draft.adding) return attachMessages.reading
  const names = new Set<string>()
  for (const row of draft.rows) {
    const named = nameProblem(row.name)
    if (named) return named
    if (names.has(row.name)) return attachMessages.duplicate(row.name)
    names.add(row.name)
    if (row.files.some(file => file.checking)) return attachMessages.checking(row.name)
    const data = row.files.filter(file => file.type === 'data')
    if (data.some(file => file.found === false || serverPathProblem(file.current) !== undefined)) return attachMessages.missingData(row.name)
    if (data.some(file => file.unchecked)) return attachMessages.unchecked(row.name)
  }
  return undefined
}

/** OK's and Script's request: nothing to do with no rows (OK closes, as SSMS's does), the reason it cannot run, or the attach. */
export function attachRequest(draft: AttachDraft): Omit<AttachRequest, 'connectionId' | 'requestId'> | { readonly problem: string } | undefined {
  if (!draft.rows.length) return undefined
  const blocked = attachBlocked(draft)
  if (blocked) return { problem: blocked }
  const pathProblem = draft.rows.flatMap(row => row.files).map(file => serverPathProblem(file.current)).find(Boolean)
  if (pathProblem) return { problem: pathProblem }
  return {
    action: 'attach', target: { kind: 'server' },
    databases: draft.rows.map(row => ({ name: row.name, ...row.owner !== undefined ? { owner: row.owner } : {}, files: row.files.map(file => file.current), rebuildLog: !row.files.some(file => file.type === 'log') }))
  }
}

/** A row's Status column (SSMS's words) and Message. */
export interface AttachRowState { readonly status: '' | 'In progress' | 'Success' | 'Error' | 'Stopped' | 'Rolled Back'; readonly message: string }
/**
 * Each row's Status from the run: In progress while OK runs; afterwards, from the reply's steps, which name their database
 * (its attach, its owner, and the detach that undoes it). A row renamed since shows no status.
 */
export function attachRowStates(rows: readonly AttachRow[], phase: DialogPhase, steps: readonly ActionStep[] | undefined): AttachRowState[] {
  if (phase === 'executing') return rows.map(() => ({ status: 'In progress', message: '' }))
  if (!steps || (phase !== 'failed' && phase !== 'stopped')) return rows.map(() => ({ status: '', message: '' }))
  return rows.map(row => {
    const own = steps.filter(step => !step.compensates && step.detail === row.name)
    const undo = steps.find(step => step.compensates && step.detail === row.name)
    const failed = own.find(step => step.status === 'failed')
    if (failed) return { status: 'Error', message: failed.message ?? '' }
    if (own.some(step => step.status === 'cancelled')) return { status: 'Stopped', message: '' }
    if (undo?.status === 'done') return { status: 'Rolled Back', message: attachMessages.rolledBack }
    if (undo) return { status: 'Success', message: attachMessages.keptAttached(undo.message ?? undo.status) }
    if (own.length && own.every(step => step.status === 'done')) return { status: 'Success', message: '' }
    return { status: '', message: '' }
  })
}

/** What the attach operations need of ObjectDialogService (a fake in tests). */
export interface AttachHost {
  readonly current?: { readonly phase: DialogPhase; readonly model?: unknown; readonly draft?: unknown }
  updateDraft(patch: (draft: AttachDraft) => Partial<AttachDraft>): void
  pickServerFile(request: Omit<ServerFilePick, 'connectionId'>): Promise<string | undefined>
  describeMore(request: Pick<ActionDescribeRequest, 'attach' | 'files'> & { readonly dialog?: ActionDescribeRequest['dialog'] }): Promise<ApiResult<ActionDescribeResult> | undefined>
}
const draftOf = (host: AttachHost) => host.current?.draft as AttachDraft | undefined
const editable = (host: AttachHost) => !!draftOf(host) && (host.current?.phase === 'ready' || host.current?.phase === 'failed' || host.current?.phase === 'stopped')
const update = (host: AttachHost, change: (draft: AttachDraft) => Partial<AttachDraft>) => host.updateDraft(draft => change(draft))
const rowUpdate = (key: number, change: (row: AttachRow) => AttachRow) => (draft: AttachDraft): Partial<AttachDraft> => ({ rows: draft.rows.map(row => row.key === key ? change(row) : row) })
const folderOf = (path: string, separator: string) => path.slice(0, path.lastIndexOf(separator) + 1)

/** The row a describe answer adds: Attach As starts as the database's name, Owner as <default>. */
export function attachRowOf(key: number, info: AttachDatabaseInfo): AttachRow {
  return { key, mdf: info.mdf, databaseName: info.databaseName, name: info.databaseName, files: info.files.map(file => ({ original: file.original, type: file.type, current: file.current, ...file.found !== undefined ? { found: file.found } : {} })) }
}

/** Add…: Locate Database Files (.mdf) from the last added file's folder or the default data folder, then reads the file. */
export async function addAttachDatabase(host: AttachHost): Promise<void> {
  const draft = draftOf(host), server = host.current?.model as AttachServerFacts | undefined
  if (!draft || !server || !editable(host) || draft.adding) return
  if (draft.rows.length >= actionLimits.attachDatabases) { update(host, () => ({ problem: attachMessages.limit })); return }
  const last = draft.rows.at(-1)
  update(host, () => ({ adding: true, problem: undefined }))
  const initialPath = last ? folderOf(last.mdf, server.separator) : server.dataPath
  const mdf = await host.pickServerFile({ purpose: 'database', ...initialPath ? { initialPath } : {}, mustExist: true })
  if (!mdf) { update(host, () => ({ adding: false })); return }
  if (draftOf(host)?.rows.some(row => row.mdf === mdf)) { update(host, () => ({ adding: false, problem: attachMessages.listed(mdf) })); return }
  const result = await host.describeMore({ attach: { mdf } })
  if (!result) return
  const info = result.ok ? result.value.attachDatabase?.database : undefined
  if (!result.ok || result.value.error || !info) {
    update(host, () => ({ adding: false, problem: !result.ok ? result.error : result.value.error?.message ?? 'The file could not be read.' }))
    return
  }
  update(host, current => current.rows.length >= actionLimits.attachDatabases
    ? { adding: false, problem: attachMessages.limit }
    : { adding: false, rows: [...current.rows, attachRowOf(current.nextKey, info)], selected: current.nextKey, selectedFile: undefined, nextKey: current.nextKey + 1 })
}

/** Remove under the databases grid: the selected row. */
export function removeAttachDatabase(host: AttachHost): void {
  const draft = draftOf(host)
  if (!draft || !editable(host) || draft.selected === undefined) return
  update(host, current => {
    const at = current.rows.findIndex(row => row.key === current.selected)
    const rows = current.rows.filter(row => row.key !== current.selected)
    return { rows, selected: rows[Math.min(at, rows.length - 1)]?.key, selectedFile: undefined, problem: undefined }
  })
}

/** Remove under the details grid: a log file only (SSMS); with none left, SQL Server rebuilds the log. */
export function removeAttachFile(host: AttachHost, key: number, index: number): void {
  if (!editable(host)) return
  update(host, rowUpdate(key, row => row.files[index]?.type === 'log' ? { ...row, files: row.files.filter((_, at) => at !== index) } : row))
  update(host, () => ({ selectedFile: undefined }))
}

export function setAttachName(host: AttachHost, key: number, name: string): void { if (editable(host)) update(host, rowUpdate(key, row => ({ ...row, name }))) }
export function setAttachOwner(host: AttachHost, key: number, owner: string | undefined): void {
  if (editable(host)) update(host, rowUpdate(key, row => { const { owner: _, ...rest } = row; return owner === undefined ? rest : { ...rest, owner } }))
}
export function selectAttachRow(host: AttachHost, key: number): void { update(host, current => current.selected === key ? {} : { selected: key, selectedFile: undefined }) }
export function selectAttachFile(host: AttachHost, index: number): void { update(host, () => ({ selectedFile: index })) }

/** Typing in Current File Path: the path is unchecked (OK waits) until Enter or leaving the field checks it (checkAttachFile). */
export function setAttachFilePath(host: AttachHost, key: number, index: number, path: string): void {
  if (!editable(host)) return
  update(host, rowUpdate(key, row => ({ ...row, files: row.files.map((file, at) => at === index ? { original: file.original, type: file.type, current: path, unchecked: true } : file) })))
}

/** Enter in, or leaving, Current File Path: whether a file is at the typed path, as the server file picker checks one (`exists`). */
export async function checkAttachFile(host: AttachHost, key: number, index: number): Promise<void> {
  const file = draftOf(host)?.rows.find(row => row.key === key)?.files[index]
  if (!file?.unchecked || file.checking || !editable(host)) return
  const path = file.current
  if (serverPathProblem(path)) {
    update(host, rowUpdate(key, row => ({ ...row, files: row.files.map((item, at) => at === index && item.current === path ? { original: item.original, type: item.type, current: path, found: false } : item) })))
    return
  }
  const purpose = file.type === 'log' ? 'log' : 'database'
  update(host, rowUpdate(key, row => ({ ...row, files: row.files.map((item, at) => at === index && item.current === path ? { ...item, checking: true } : item) })))
  const result = await host.describeMore({ dialog: 'serverFiles', files: { purpose, path, exists: true } })
  if (!result) return
  const listing = result.ok && !result.value.error ? result.value.serverFiles : undefined
  // Unknown on SQL Server 2016 outside sysadmin (legacyEmpty), or when the check failed: OK stays possible, and SQL Server decides.
  const found = listing ? (listing.notice === 'legacyEmpty' ? undefined : listing.entries.some(entry => !entry.directory)) : undefined
  update(host, rowUpdate(key, row => ({
    ...row, files: row.files.map((item, at) => {
      if (at !== index || item.current !== path) return item
      const { checking: _, found: __, unchecked: ___, ...rest } = item
      return found === undefined ? rest : { ...rest, found }
    })
  })))
  if (result.ok && result.value.error) update(host, () => ({ problem: result.value.error?.message }))
}

/** The "…" button: Locate Database Files from the file's folder; the picker checked that the chosen file exists. */
export async function browseAttachFile(host: AttachHost, key: number, index: number): Promise<void> {
  const file = draftOf(host)?.rows.find(row => row.key === key)?.files[index]
  if (!file || !editable(host)) return
  const path = await host.pickServerFile({ purpose: file.type === 'log' ? 'log' : 'database', ...serverPathProblem(file.current) ? {} : { initialPath: file.current }, mustExist: true })
  if (!path) return
  update(host, rowUpdate(key, row => ({ ...row, files: row.files.map((item, at) => at === index ? { original: item.original, type: item.type, current: path, found: true } : item) })))
}

/** The details grid's File Type, as SSMS words it. */
export const attachFileType = (type: AttachFileRow['type']) => type === 'log' ? 'Log' : 'Data'
/** Locate Database Files' title (the server file picker's, for the purposes Attach opens it with). */
export const locateTitle = serverFilePurposeSpecs.database.title
