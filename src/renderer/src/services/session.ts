import type { ApiResult, ReloadPins, RestoredSession, SessionDocumentWrite, SessionWrite, SqlFile, VariaApi } from '../../../shared/contracts'
import { sessionLimits } from '../../../shared/files/session'
import { withExplorerExpansion } from '../../../shared/connection-targets'
import { isKeptAgentKind, keptAgentText } from '../../../shared/agent/kept'
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
export function keptSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'> & Partial<Pick<DocumentService, 'keepCustom' | 'closeRefusal'>>, server: (connectionId: string) => string | undefined,
  { budget = sessionLimits.totalBytes - sessionLimits.slackBytes, pinnedOnly = false, groups, connectionTargets, explorerExpansion, assertConnectionsReady }: {
    budget?: number; pinnedOnly?: boolean; groups?: Pick<EditorGroupService, 'capture'>; connectionTargets?: Pick<ConnectionTargetService, 'exportWorkspace'>
    /** Object Explorer's expanded nodes per target (`ExplorerService.savedExpansion`), kept with the workspace for the next start. */
    explorerExpansion?: () => ReadonlyMap<string, readonly string[] | null>
    assertConnectionsReady?: () => void
  } = {}): KeptSession {
  assertConnectionsReady?.()
  const { documents: tabs, activeId } = documents.getSnapshot(), written: SessionDocumentWrite[] = [], kept = new Set<string>()
  // The close's checkpoint compares the targets alone: the tree's expansion may change meanwhile without changing a target.
  const targetsNow = connectionTargets?.exportWorkspace(), capturedWorkspace = JSON.stringify(targetsNow)
  const workspace = targetsNow && explorerExpansion ? withExplorerExpansion(targetsNow, explorerExpansion()) : targetsNow, targetIds = new Set(workspace?.targets.map(target => target.id))
  const capturedAssociations = associations(tabs)
  let used = workspace ? bytes(workspace) : 0, activeIndex = -1
  for (const document of tabs) {
    const model = documents.getModel(document.id)
    if (written.length >= sessionLimits.documents) break
    if (pinnedOnly && !document.pinned) continue
    // A SQL Server Agent document with unsaved changes (AG-6g) keeps its state, without secrets, on its connection target; one whose target
    // is not kept, or whose state is past its limit, is left out and asked about. One still saving is left out too, so its close refusal stands.
    if (isKeptAgentKind(document.kind)) {
      const state = document.dirty && !documents.closeRefusal?.(document.id) ? documents.keepCustom?.(document.id) : undefined
      const targetId = document.targetId && targetIds.has(document.targetId) ? document.targetId : undefined
      if (state === undefined || !targetId) continue
      const entry: SessionDocumentWrite = {
        name: document.name.slice(0, sessionLimits.nameChars), kind: document.kind, eol: 'lf', dirty: true,
        targetId, attachWanted: true, database: document.database.slice(0, sessionLimits.databaseChars), text: state
      }
      const size = bytes(entry) + 2
      if (used + size > budget) continue
      used += size
      if (document.id === activeId) activeIndex = written.length
      written.push(entry)
      kept.add(document.id)
      continue
    }
    if (!model || isCustomKind(document.kind) || documents.isFilling(document.id)) continue
    const kind = document.kind && !isCustomKind(document.kind) ? document.kind : 'sql', connected = document.connectionId ? server(document.connectionId) : document.lastServer
    const at = kind === 'sql' && connected ? connected.slice(0, sessionLimits.serverChars) : undefined
    const targetId = kind === 'sql' && document.targetId && targetIds.has(document.targetId) ? document.targetId : undefined
    if (kind === 'sql' && document.targetId && !targetId) throw new Error('A query connection target could not be kept. Try again after the connection workspace is ready.')
    // A BigQuery query keeps its engine, and its dataset at BigQuery's length; SQL Server is the absence of one.
    const bigQuery = kind === 'sql' && document.provider === 'bigquery'
    const entry: SessionDocumentWrite = {
      name: document.name.slice(0, sessionLimits.nameChars), ...document.baseName ? { baseName: document.baseName.slice(0, sessionLimits.nameChars) } : {}, kind,
      eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf', dirty: document.dirty, ...document.file ? { fileId: document.file.id } : {},
      ...document.pinned ? { pinned: true } : {},
      ...at ? { server: at } : {}, ...(targetId || at) && document.database !== undefined ? { database: document.database.slice(0, bigQuery ? sessionLimits.datasetChars : sessionLimits.databaseChars) } : {},
      ...targetId ? { targetId, attachWanted: document.attachWanted ?? !!document.connectionId } : {}, ...bigQuery ? { provider: 'bigquery' as const, ...document.jobKey ? { jobKey: document.jobKey } : {} } : {},
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
    try { assertConnectionsReady?.(); return associations(documents.getSnapshot().documents) === capturedAssociations && JSON.stringify(connectionTargets?.exportWorkspace()) === capturedWorkspace }
    catch { return false }
  }
  return { session: { documents: written, activeIndex, ...layout ? { groups: layout } : {}, ...workspace ? { workspace } : {} }, kept, checkpointCurrent }
}

/** Reload uses the same eligibility as hot exit and takes its last checkpoint as the old page unloads. */
export function reloadSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'> & Partial<Pick<DocumentService, 'keepCustom' | 'closeRefusal'>>, server: (connectionId: string) => string | undefined,
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
  readonly documents: Pick<DocumentService, 'getSnapshot' | 'reopen' | 'activate' | 'setPinned'> & Partial<Pick<DocumentService, 'reopenKept'>>
  readonly files: Pick<FileService, 'later' | 'release' | 'reportError'>
  /** Where the reopened tabs go back into their editor groups. */
  readonly groups?: Pick<EditorGroupService, 'restore'>
  readonly connectionTargets?: Pick<ConnectionTargetService, 'restore'>
  readonly resumeRecovery?: (tabId: string, recoveryId: string) => void
  /** A reopened BigQuery tab's jobs, to re-attach to once it connects (QueryService.restoreJobs). */
  readonly restoredJobs?: (tabId: string, jobs: NonNullable<RestoredSession['documents'][number]['jobs']>) => void
  /** Runs inside the restore's own file task when it reopened nothing (also when it failed): the welcome query, which
   *  must come before a file the command line hands over meanwhile, since that open waits for this task. */
  readonly otherwise?: () => void
}
/**
 * The start's restore: the tabs the last close kept, in order, with the active one active again. A file already open in
 * a tab (one a second instance handed over first) is not opened twice. Resolves with how many tabs it opened; a failure
 * goes to the file banner, and files that are gone are named there as a warning.
 */
/** How many tabs the restore reopened, or -1 when it failed. */
export async function restoreSession({ api, documents, files, groups, connectionTargets, resumeRecovery, restoredJobs, otherwise }: SessionRestoreOptions): Promise<number> {
  if (!api.hotExit) return 0
  let opened = 0, failed = false
  await files.later(async () => {
    try { await restore() } catch (error) { failed = true; throw error } finally { if (!opened) otherwise?.() }
  })
  // -1: the restore failed (shown in the file banner), so the tabs it would reopen may still come back from previous.json.
  return failed ? -1 : opened
  async function restore(): Promise<void> {
    let restored: RestoredSession
    try { restored = unwrap(await api.takeSession()) } catch (error) { throw new Error(`The queries open when Varia SQL Manager last closed could not be reopened: ${error instanceof Error ? error.message : 'The operation failed.'}`) }
    const registered: SqlFile[] = [], ids: (string | undefined)[] = [], problems = [...restored.problems]
    let active: string | undefined
    try {
      if (restored.workspace && connectionTargets && !connectionTargets.restore(restored.workspace)) throw new Error('The connection workspace cannot be restored while a connection is active.')
      for (const [index, document] of restored.documents.entries()) {
        // A kept SQL Server Agent document (AG-6g) reopens through its own service; one that cannot is named.
        if (isKeptAgentKind(document.kind)) {
          if (!documents.reopenKept) { problems.push(keptAgentText.notReopened(document.name)); continue }
          let id: string
          try { id = documents.reopenKept(document.kind, { name: document.name, state: document.text, targetId: document.targetId, database: document.database }).id } catch { problems.push(keptAgentText.unreadable(document.name)); continue }
          if (document.recoveryId) resumeRecovery?.(id, document.recoveryId)
          opened++
          ids[index] = id
          if (index === restored.activeIndex) active = id
          continue
        }
        if (document.file) registered.push(document.file)
        const open = document.file ? documents.getSnapshot().documents.find(tab => tab.file?.id === document.file?.id) : undefined
        const id = open?.id ?? documents.reopen(document).id
        if (open && document.pinned) documents.setPinned(id, true)
        if (!open && document.recoveryId) resumeRecovery?.(id, document.recoveryId)
        if (!open && document.jobs?.length) restoredJobs?.(id, document.jobs)
        if (!open) opened++
        ids[index] = id
        if (index === restored.activeIndex) active = id
      }
      // The groups first, then the active tab, which also makes its group the active one.
      if (restored.groups && groups) groups.restore(restored.groups, place => ids[place])
      if (active) documents.activate(active)
      if (restored.restoreGeneration !== undefined) unwrap(await api.finishSessionRestore(restored.restoreGeneration))
    } finally { await files.release(registered) }
    if (problems.length) files.reportError(problems.join(' '), 'warning')
  }
}
