import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ToastInput } from '../core/notifications'
import { documentInfo, documentProvider, type QueryDocument } from '../documents'

type LanguageMonaco = { readonly editor: Pick<typeof Monaco.editor, 'getModelMarkers' | 'setModelMarkers' | 'setModelLanguage'> }

/**
 * Puts a query's model in another engine's language. Its markers go first: they were found in the old language (SQL
 * Server's error checking), and the new one's own checks start from nothing. Nothing is checked or sent anywhere here.
 */
export function switchModelLanguage(monaco: LanguageMonaco, model: Monaco.editor.ITextModel, language: string): void {
  const owners = new Set(monaco.editor.getModelMarkers({ resource: model.uri }).map(marker => marker.owner))
  for (const owner of owners) monaco.editor.setModelMarkers(model, owner, [])
  monaco.editor.setModelLanguage(model, language)
}

/** Keyed by document, so connecting a tab back and forth replaces its toast rather than stacking them. */
export const providerSwitchKey = (documentId: string): string => `query-language:${documentId}`

/** What the editor says when a query with text changes language with its connection's engine. */
export function providerSwitchToast(document: QueryDocument): ToastInput {
  const now = documentInfo(document).label, before = documentProvider(document) === 'bigquery' ? 'Transact-SQL' : 'GoogleSQL'
  const engine = documentProvider(document) === 'bigquery' ? 'BigQuery' : 'SQL Server'
  return { severity: 'info', key: providerSwitchKey(document.id), message: `${document.name} is now ${now}, the language of its ${engine} connection. Its ${before} is unlikely to run as is.` }
}
