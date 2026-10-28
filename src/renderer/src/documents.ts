import type { DocumentKind, SqlFile } from '../../shared/contracts'
import type { IconId } from '../../shared/icons'

export interface QueryDocument {
  readonly id: string
  readonly name: string
  readonly dirty: boolean
  readonly savedVersionId: number | null
  readonly connectionId?: string
  readonly database: string
  readonly file?: SqlFile
  /** The query's session ended without the user ending it (a Reconnect after the backend restarted, or a session found
   *  lost); its next execution says so before its own messages. */
  readonly sessionNotice?: SessionNotice
  /** Absent for a query; an XML, JSON or plan value opened from the results has no connection and never executes; a table
   *  designer has no text at all. */
  readonly kind?: Exclude<WorkbenchDocumentKind, 'sql'>
}
/** What a tab holds: a shared DocumentKind (its text crosses IPC to be saved and kept by AutoRecover), or a table designer
 *  or Integration Services Operations, which live only in the renderer. */
export type WorkbenchDocumentKind = DocumentKind | 'tableDesigner' | 'ssisOperations'
/** Documents whose content is not text in the editor: a provider saves and closes them (DocumentService.registerProvider). */
export type CustomDocumentKind = Exclude<WorkbenchDocumentKind, DocumentKind>

// Presentation projection; results are owned by ResultsService.
export type QueryTab = QueryDocument

/** Why a query's next execution opens a new session: the backend restarted, or its session was lost. */
export type SessionNotice = 'restarted' | 'lost'
export const documentKind = (document: Pick<QueryDocument, 'kind'> | undefined): WorkbenchDocumentKind => document?.kind ?? 'sql'
/** A query tab, as opposed to a value opened from the results: only queries connect, execute, and have results. */
export const isQueryDocument = (document: Pick<QueryDocument, 'kind'> | undefined): boolean => !!document && documentKind(document) === 'sql'
/** A document a provider owns (DocumentService.registerProvider): a table designer or Integration Services Operations. */
export const isCustomKind = (kind: WorkbenchDocumentKind): kind is CustomDocumentKind => kind === 'tableDesigner' || kind === 'ssisOperations'
/** A document whose content is text in the editor (a query or a value), as opposed to a table designer or Operations. */
export const isTextDocument = (document: Pick<QueryDocument, 'kind'> | undefined): boolean => !!document && !isCustomKind(documentKind(document))
/**
 * Each kind's editor language, tab icon, the sentence that names it (the tab icon's name, the query context bar,
 * banners), what its value is called, and the file name a value of that kind gets when its column has none.
 */
export const kindInfo: Readonly<Record<WorkbenchDocumentKind, { readonly language: string; readonly icon: IconId; readonly label: string; readonly value: string; readonly blankName: string }>> = {
  sql: { language: 'sql', icon: 'database', label: 'Transact-SQL', value: 'SQL', blankName: 'SQL' },
  xml: { language: 'xml', icon: 'code', label: 'XML document', value: 'XML', blankName: 'XML' },
  json: { language: 'json', icon: 'json', label: 'JSON document', value: 'JSON', blankName: 'JSON' },
  sqlplan: { language: 'xml', icon: 'execution-plan', label: 'Execution plan', value: 'execution plan', blankName: 'PLAN' },
  tableDesigner: { language: '', icon: 'table', label: 'Table Designer', value: 'table', blankName: 'Table Designer' },
  ssisOperations: { language: '', icon: 'pulse', label: 'Integration Services Operations', value: 'operations', blankName: 'Operations' }
}

export function afterClose<T extends { id: string }>(tabs: readonly T[], activeId: string, closingId: string): { tabs: T[]; activeId: string } {
  const index = tabs.findIndex(tab => tab.id === closingId)
  const remaining = tabs.filter(tab => tab.id !== closingId)
  return { tabs: remaining, activeId: activeId === closingId ? remaining[Math.min(index, remaining.length - 1)]?.id ?? '' : activeId }
}
