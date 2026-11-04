// What the workbench does when Varia deletes or detaches a database (D3 §8, D3b): its Properties documents turn orphan, and a
// toast counts the query windows that were using it, which stay open on a database that no longer exists. A detached
// database's toast says so whatever the count, and offers Copy paths for the files it left on the server. No React here.
import type { DatabaseFileRef } from '../../../shared/actions/schema.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { isQueryDocument, type QueryDocument } from '../documents'
import type { DatabaseGone } from './ObjectDialogService'

/** The query windows on `connectionId` whose database is `database`. */
export const queryWindowsOn = (documents: readonly Pick<QueryDocument, 'kind' | 'connectionId' | 'database'>[], connectionId: string, database: string): number =>
  documents.filter(document => isQueryDocument(document) && document.connectionId === connectionId && document.database === database).length

/** The toast after a database is deleted: "3 query windows were using SalesDb." */
export const queryWindowsNotice = (windows: number, database: string): string =>
  `${windows.toLocaleString('en-US')} ${windows === 1 ? 'query window was' : 'query windows were'} using ${displayText(database)}.`

/** The toast after a database is detached: "SalesDb was detached. Its 2 files stay on the server." */
export const detachedNotice = (database: string, files: number): string =>
  `${displayText(database)} was detached. ${files === 0 ? 'Its files stay on the server.' : `Its ${files === 1 ? 'file stays' : `${files.toLocaleString('en-US')} files stay`} on the server.`}`

/** Copy paths: one path per line, as the server names them, for an Attach later. */
export const filePathsText = (files: readonly Pick<DatabaseFileRef, 'path'>[]): string => files.map(file => file.path).join('\n')

export interface DatabaseGoneDeps {
  readonly documents: { getSnapshot(): { readonly documents: readonly Pick<QueryDocument, 'kind' | 'connectionId' | 'database'>[] } }
  readonly properties: { databaseGone(connectionId: string, database: string): void }
  readonly notify: (toast: { readonly severity: 'info'; readonly message: string; readonly key: string; readonly actions?: readonly { readonly label: string; readonly run: () => void }[] }) => void
  /** Copy paths: writes the text to the clipboard (through main). */
  readonly copy?: (text: string) => void
}

/** ObjectDialogService's `databaseGone`: orphans the database's Properties documents, then counts its query windows in a toast. */
export const databaseGoneHandler = (deps: DatabaseGoneDeps) => (gone: DatabaseGone): void => {
  deps.properties.databaseGone(gone.connectionId, gone.database)
  const windows = queryWindowsOn(deps.documents.getSnapshot().documents, gone.connectionId, gone.database)
  const key = `database-gone:${gone.connectionId}:${gone.database}`
  if (gone.filesKept) {
    const files = gone.filesKept, copy = deps.copy
    const message = detachedNotice(gone.database, files.length) + (windows > 0 ? ' ' + queryWindowsNotice(windows, gone.database) : '')
    deps.notify({ severity: 'info', message, key, ...files.length && copy ? { actions: [{ label: 'Copy paths', run: () => copy(filePathsText(files)) }] } : {} })
    return
  }
  if (windows > 0) deps.notify({ severity: 'info', message: queryWindowsNotice(windows, gone.database), key })
}
