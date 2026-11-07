import type { ApiResult, RestoredSession, SessionDocumentWrite, SessionWrite, SqlFile, VariaApi } from '../../../shared/contracts'
import { sessionLimits } from '../../../shared/files/session'
import { isCustomKind, type QueryDocument } from '../documents'
import type { DocumentService } from './documents'
import type { FileService } from './files'
import type { EditorGroupService } from './editor-groups'

/** What hot exit keeps of the open tabs, and the tabs it keeps: a tab left out is asked about as without hot exit. */
export interface KeptSession { readonly session: SessionWrite; readonly kept: ReadonlySet<string> }
export function requireKeptPins(documents: readonly QueryDocument[], kept: ReadonlySet<string>): void {
  const missing = documents.find(tab => tab.pinned && !kept.has(tab.id))
  if (missing) throw new Error(`Pinned tab “${missing.name}” could not fit in the session restore limits. Unpin or close some tabs, or save large queries, and try again.`)
}
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/**
 * The open text tabs as hot exit keeps them, in strip order, within its caps: 64 tabs and 64 MB as main writes them (the
 * file's path, which main adds, counted too). An untitled tab or one with unsaved changes keeps its text; a clean tab with
 * a file keeps only the file. Table designers, Database Properties, monitors and the other custom tabs are not kept (a
 * designer with unsaved changes asks as before), and neither is a value still being appended or a tab past the caps.
 * With editor groups, the documents are in group order, and the groups they are in are kept by each one's place.
 */
export function keptSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'>, server: (connectionId: string) => string | undefined,
  { budget = sessionLimits.totalBytes - sessionLimits.slackBytes, pinnedOnly = false, groups }: { budget?: number; pinnedOnly?: boolean; groups?: Pick<EditorGroupService, 'capture'> } = {}): KeptSession {
  const { documents: tabs, activeId } = documents.getSnapshot(), written: SessionDocumentWrite[] = [], kept = new Set<string>()
  let used = 0, activeIndex = -1
  for (const document of tabs) {
    const model = documents.getModel(document.id)
    if (written.length >= sessionLimits.documents) break
    if ((pinnedOnly && !document.pinned) || !model || isCustomKind(document.kind) || documents.isFilling(document.id)) continue
    const kind = document.kind && !isCustomKind(document.kind) ? document.kind : 'sql', connected = document.connectionId ? server(document.connectionId) : document.lastServer
    const at = kind === 'sql' && connected ? connected.slice(0, sessionLimits.serverChars) : undefined
    const entry: SessionDocumentWrite = {
      name: document.name.slice(0, sessionLimits.nameChars), ...document.baseName ? { baseName: document.baseName.slice(0, sessionLimits.nameChars) } : {}, kind,
      eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf', dirty: document.dirty, ...document.file ? { fileId: document.file.id } : {},
      ...document.pinned ? { pinned: true } : {},
      ...at ? { server: at } : {}, ...at && document.database ? { database: document.database.slice(0, sessionLimits.databaseChars) } : {},
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
  return { session: { documents: written, activeIndex, ...layout ? { groups: layout } : {} }, kept }
}

export interface SessionRestoreOptions {
  readonly api: Pick<VariaApi, 'hotExit' | 'takeSession' | 'finishSessionRestore'>
  readonly documents: Pick<DocumentService, 'getSnapshot' | 'reopen' | 'activate' | 'setPinned'>
  readonly files: Pick<FileService, 'later' | 'release' | 'reportError'>
  /** Where the reopened tabs go back into their editor groups. */
  readonly groups?: Pick<EditorGroupService, 'restore'>
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
export async function restoreSession({ api, documents, files, groups, resumeRecovery, otherwise }: SessionRestoreOptions): Promise<number> {
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
