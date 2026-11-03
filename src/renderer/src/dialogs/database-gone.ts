// What the workbench does when Varia deletes a database (D3 §8): its Properties documents turn orphan, and a toast counts
// the query windows that were using it, which stay open on a database that no longer exists. No React here.
import { displayText } from '../../../shared/explorer/refs.ts'
import { isQueryDocument, type QueryDocument } from '../documents'
import type { DatabaseGone } from './ObjectDialogService'

/** The query windows on `connectionId` whose database is `database`. */
export const queryWindowsOn = (documents: readonly Pick<QueryDocument, 'kind' | 'connectionId' | 'database'>[], connectionId: string, database: string): number =>
  documents.filter(document => isQueryDocument(document) && document.connectionId === connectionId && document.database === database).length

/** The toast after a database is deleted: "3 query windows were using SalesDb." */
export const queryWindowsNotice = (windows: number, database: string): string =>
  `${windows.toLocaleString('en-US')} ${windows === 1 ? 'query window was' : 'query windows were'} using ${displayText(database)}.`

export interface DatabaseGoneDeps {
  readonly documents: { getSnapshot(): { readonly documents: readonly Pick<QueryDocument, 'kind' | 'connectionId' | 'database'>[] } }
  readonly properties: { databaseGone(connectionId: string, database: string): void }
  readonly notify: (toast: { readonly severity: 'info'; readonly message: string; readonly key: string }) => void
}

/** ObjectDialogService's `databaseGone`: orphans the database's Properties documents, then counts its query windows in a toast. */
export const databaseGoneHandler = (deps: DatabaseGoneDeps) => (gone: DatabaseGone): void => {
  deps.properties.databaseGone(gone.connectionId, gone.database)
  const windows = queryWindowsOn(deps.documents.getSnapshot().documents, gone.connectionId, gone.database)
  if (windows > 0) deps.notify({ severity: 'info', message: queryWindowsNotice(windows, gone.database), key: `database-gone:${gone.connectionId}:${gone.database}` })
}
