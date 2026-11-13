import type { ApiResult, ReloadPins, RestoredSession, SessionDocumentWrite, SessionWrite, SqlFile, VariaApi } from '../../../shared/contracts'
import { sessionLimits } from '../../../shared/files/session'
import { isCustomKind, type QueryDocument } from '../documents'
import type { DocumentService } from './documents'
import type { FileService } from './files'
import type { EditorGroupService } from './editor-groups'
import type { ConnectionTargetService } from './connection-targets'

/** What hot exit keeps of the open tabs, and the tabs it keeps: a tab left out is asked about as without hot exit. */
export interface KeptSession {
  readonly session: SessionWrite
  readonly kept: ReadonlySet<string>
  /** Revalidate after main writes: a background connect or changed target details must not leave an older checkpoint. */
  readonly checkpointCurrent: () => boolean
}
export function requireKeptPins(documents: readonly QueryDocument[], kept: ReadonlySet<string>): void {
  const missing = documents.find(tab => tab.pinned && !kept.has(tab.id))
  if (missing) throw new Error(`Pinned tab “${missing.name}” could not fit in the session restore limits. Unpin or close some tabs, or save large queries, and try again.`)
}
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length
const associations = (documents: readonly QueryDocument[]) => JSON.stringify(documents.map(document => [
  document.id, document.targetId, document.database, document.attachWanted, document.connectionId
]))

/**
 * The open text tabs as hot exit keeps them, in strip order, within its caps: 64 tabs and 64 MB as main writes them (the
 * file's path, which main adds, counted too). An untitled tab or one with unsaved changes keeps its text; a clean tab with
 * a file keeps only the file. Table designers, Database Properties, monitors and the other custom tabs are not kept (a
 * designer with unsaved changes asks as before), and neither is a value still being appended or a tab past the caps.
 * With editor groups, the documents are in group order, and the groups they are in are kept by each one's place.
 */
export function keptSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'>, server: (connectionId: string) => string | undefined,
  { budget = sessionLimits.totalBytes - sessionLimits.slackBytes, pinnedOnly = false, groups, connectionTargets }: {
    budget?: number; pinnedOnly?: boolean; groups?: Pick<EditorGroupService, 'capture'>; connectionTargets?: Pick<ConnectionTargetService, 'exportWorkspace'>
  } = {}): KeptSession {
  const { documents: tabs, activeId } = documents.getSnapshot(), written: SessionDocumentWrite[] = [], kept = new Set<string>()
  const workspace = connectionTargets?.exportWorkspace(), targetIds = new Set(workspace?.targets.map(target => target.id))
  const capturedAssociations = associations(tabs), capturedWorkspace = JSON.stringify(workspace)
  let used = workspace ? bytes(workspace) : 0, activeIndex = -1
  for (const document of tabs) {
    const model = documents.getModel(document.id)
    if (written.length >= sessionLimits.documents) break
    if ((pinnedOnly && !document.pinned) || !model || isCustomKind(document.kind) || documents.isFilling(document.id)) continue
    const kind = document.kind && !isCustomKind(document.kind) ? document.kind : 'sql', connected = document.connectionId ? server(document.connectionId) : document.lastServer
    const at = kind === 'sql' && connected ? connected.slice(0, sessionLimits.serverChars) : undefined
    const targetId = kind === 'sql' && document.targetId && targetIds.has(document.targetId) ? document.targetId : undefined
    if (kind === 'sql' && document.targetId && !targetId) throw new Error('A query connection target could not be kept. Try again after the connection workspace is ready.')
    const entry: SessionDocumentWrite = {
      name: document.name.slice(0, sessionLimits.nameChars), ...document.baseName ? { baseName: document.baseName.slice(0, sessionLimits.nameChars) } : {}, kind,
      eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf', dirty: document.dirty, ...document.file ? { fileId: document.file.id } : {},
      ...document.pinned ? { pinned: true } : {},
      ...at ? { server: at } : {}, ...(targetId || at) && document.database !== undefined ? { database: document.database.slice(0, sessionLimits.databaseChars) } : {},
      ...targetId ? { targetId, attachWanted: document.attachWanted ?? !!document.connectionId } : {},
      ...!document.file || document.dirty ? { text: model.getValue() } : {}
    }
    const size = bytes(entry) + (document.file ? bytes(document.file.path) : 0) + 2
    if (used + size > budget) continue
    used += size
    if (document.id === activeId) activeIndex = written.length
    written.push(entry)
    kept.add(document.id)
  }
  const places = new Map([...kept].map((id, index) => [id, index]))
  const layout = groups?.capture(id => places.get(id))
  const checkpointCurrent = () => {
    try { return associations(documents.getSnapshot().documents) === capturedAssociations && JSON.stringify(connectionTargets?.exportWorkspace()) === capturedWorkspace }
    catch { return false }
  }
  return { session: { documents: written, activeIndex, ...layout ? { groups: layout } : {}, ...workspace ? { workspace } : {} }, kept, checkpointCurrent }
}

/** Reload uses the same eligibility as hot exit and takes its last checkpoint as the old page unloads. */
export function reloadSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'>, server: (connectionId: string) => string | undefined,
  { restoreQueries, recoveryId, ...options }: Parameters<typeof keptSession>[2] & {
    restoreQueries: boolean; recoveryId: (tabId: string) => string | undefined
  }): ReloadPins | undefined {
  const { documents: tabs, busy } = documents.getSnapshot()
  if (busy) throw new Error('Wait for the current document operation to finish before reloading.')
  const kept = keptSession(documents, server, { ...options, pinnedOnly: !restoreQueries })
  requireKeptPins(tabs, kept.kept)
  if (!kept.session.documents.length && !kept.session.workspace?.targets.length) return
  return { session: kept.session, recoveryIds: [...kept.kept].map(id => recoveryId(id) ?? null) }
}

export interface SessionRestoreOptions {
  readonly api: Pick<VariaApi, 'hotExit' | 'takeSession' | 'finishSessionRestore'>
  readonly documents: Pick<DocumentService, 'getSnapshot' | 'reopen' | 'activate' | 'setPinned'>
  readonly files: Pick<FileService, 'later' | 'release' | 'reportError'>
  /** Where the reopened tabs go back into their editor groups. */
  readonly groups?: Pick<EditorGroupService, 'restore'>
  readonly connectionTargets?: Pick<ConnectionTargetService, 'restore'>
  readonly resumeRecovery?: (tabId: string, recoveryId: string) => void
  /** Runs inside the restore's own file task when it reopened nothing (also when it failed): the welcome query, which
   *  must come before a file the command line hands over meanwhile, since that open waits for this task. */
  readonly otherwise?: () => void
}
/**
 * The start's restore: the tabs the last close kept, in order, with the active one active again. A file already open in
 * a tab (one a second instance handed over first) is not opened twice. Resolves with how many tabs it opened; a failure
 * goes to the file banner, and files that are gone are named there as a warning.
 */
export async function restoreSession({ api, documents, files, groups, connectionTargets, resumeRecovery, otherwise }: SessionRestoreOptions): Promise<number> {
  if (!api.hotExit) return 0
  let opened = 0
  await files.later(async () => {
    try { await restore() } finally { if (!opened) otherwise?.() }
  })
  return opened
  async function restore(): Promise<void> {
    let restored: RestoredSession
    try { restored = unwrap(await api.takeSession()) } catch (error) { throw new Error(`The queries open when Varia SQL Manager last closed could not be reopened: ${error instanceof Error ? error.message : 'The operation failed.'}`) }
    const registered: SqlFile[] = [], ids: string[] = []
    let active: string | undefined
    try {
      if (restored.workspace && connectionTargets && !connectionTargets.restore(restored.workspace)) throw new Error('The connection workspace cannot be restored while a connection is active.')
      for (const [index, document] of restored.documents.entries()) {
        if (document.file) registered.push(document.file)
        const open = document.file ? documents.getSnapshot().documents.find(tab => tab.file?.id === document.file?.id) : undefined
        const id = open?.id ?? documents.reopen(document).id
        if (open && document.pinned) documents.setPinned(id, true)
        if (!open && document.recoveryId) resumeRecovery?.(id, document.recoveryId)
        if (!open) opened++
        ids[index] = id
        if (index === restored.activeIndex) active = id
      }
      // The groups first, then the active tab, which also makes its group the active one.
      if (restored.groups && groups) groups.restore(restored.groups, place => ids[place])
      if (active) documents.activate(active)
      if (restored.restoreGeneration !== undefined) unwrap(await api.finishSessionRestore(restored.restoreGeneration))
    } finally { await files.release(registered) }
    if (restored.problems.length) files.reportError(restored.problems.join(' '), 'warning')
  }
}
