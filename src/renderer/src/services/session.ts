import type { ApiResult, RestoredSession, SessionDocumentWrite, SessionWrite, SqlFile, VariaApi } from '../../../shared/contracts'
import { sessionLimits } from '../../../shared/files/session'
import { isCustomKind } from '../documents'
import type { DocumentService } from './documents'
import type { FileService } from './files'

/** What hot exit keeps of the open tabs, and the tabs it keeps: a tab left out is asked about as without hot exit. */
export interface KeptSession { readonly session: SessionWrite; readonly kept: ReadonlySet<string> }
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/**
 * The open text tabs as hot exit keeps them, in strip order, within its caps: 64 tabs and 64 MB as main writes them (the
 * file's path, which main adds, counted too). An untitled tab or one with unsaved changes keeps its text; a clean tab with
 * a file keeps only the file. Table designers, Database Properties, monitors and the other custom tabs are not kept (a
 * designer with unsaved changes asks as before), and neither is a value still being appended or a tab past the caps.
 */
export function keptSession(documents: Pick<DocumentService, 'getSnapshot' | 'getModel' | 'isFilling'>, server: (connectionId: string) => string | undefined,
  budget: number = sessionLimits.totalBytes - sessionLimits.slackBytes): KeptSession {
  const { documents: tabs, activeId } = documents.getSnapshot(), written: SessionDocumentWrite[] = [], kept = new Set<string>()
  let used = 0, activeIndex = -1
  for (const document of tabs) {
    const model = documents.getModel(document.id)
    if (written.length >= sessionLimits.documents) break
    if (!model || isCustomKind(document.kind) || documents.isFilling(document.id)) continue
    const kind = document.kind && !isCustomKind(document.kind) ? document.kind : 'sql', connected = document.connectionId ? server(document.connectionId) : document.lastServer
    const at = kind === 'sql' && connected ? connected.slice(0, sessionLimits.serverChars) : undefined
    const entry: SessionDocumentWrite = {
      name: document.name.slice(0, sessionLimits.nameChars), ...document.baseName ? { baseName: document.baseName.slice(0, sessionLimits.nameChars) } : {}, kind,
      eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf', dirty: document.dirty, ...document.file ? { fileId: document.file.id } : {},
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
  return { session: { documents: written, activeIndex }, kept }
}

export interface SessionRestoreOptions {
  readonly api: Pick<VariaApi, 'hotExit' | 'takeSession'>
  readonly documents: Pick<DocumentService, 'getSnapshot' | 'reopen' | 'activate'>
  readonly files: Pick<FileService, 'later' | 'release' | 'reportError'>
}
/**
 * The start's restore: the tabs the last close kept, in order, with the active one active again. A file already open in
 * a tab (one a second instance handed over first) is not opened twice. Resolves with how many tabs it opened; a failure
 * goes to the file banner, and files that are gone are named there as a warning.
 */
export async function restoreSession({ api, documents, files }: SessionRestoreOptions): Promise<number> {
  if (!api.hotExit) return 0
  let opened = 0
  await files.later(async () => {
    let restored: RestoredSession
    try { restored = unwrap(await api.takeSession()) } catch (error) { throw new Error(`The queries open when Varia SQL Manager last closed could not be reopened: ${error instanceof Error ? error.message : 'The operation failed.'}`) }
    const registered: SqlFile[] = []
    let active: string | undefined
    try {
      for (const [index, document] of restored.documents.entries()) {
        if (document.file) registered.push(document.file)
        const open = document.file ? documents.getSnapshot().documents.find(tab => tab.file?.id === document.file?.id) : undefined
        const id = open?.id ?? documents.reopen(document).id
        if (!open) opened++
        if (index === restored.activeIndex) active = id
      }
    } finally { await files.release(registered) }
    if (active) documents.activate(active)
    if (restored.problems.length) files.reportError(restored.problems.join(' '), 'warning')
  })
  return opened
}
