import { bigQueryMaxDefinition, isBigQueryPropertyKind } from '../../../shared/bigquery/objects.ts'
import type { VariaApi } from '../../../shared/contracts'
import type { DocumentService } from '../services/documents'
import type { FoundIndexObject } from './IndexCompletionService'

/** What F12 did with a BigQuery object: opened its definition (`cut` when longer than Varia reads), or found none stored. */
export type IndexDefinitionOutcome = 'opened' | 'cut' | 'none'

export interface IndexDefinitionOptions {
  readonly api: Pick<VariaApi, 'bigQueryProperties'>
  readonly documents: Pick<DocumentService, 'newQuery'>
  readonly connections: { get(connectionId: string): { readonly server: string; readonly database?: string } | undefined }
  readonly newId?: () => string
  /** Runs after the new query opens (the workbench focuses its editor). */
  readonly opened?: () => void
}

/** The definition text's limit, as `bigquery.properties` cuts it. */
export const indexDefinitionLimit = bigQueryMaxDefinition

/**
 * Go To Definition (F12) on a BigQuery view, materialized view or routine: its SQL from `bigquery.properties` (`tables.get` or
 * `routines.get`, free metadata reads, never a job), opened in a new query on the tab's connection, in the object's dataset when
 * it is in the billing project, as Properties' Open in New Query does. Throws when the read fails.
 */
export function indexDefinitionOpener(options: IndexDefinitionOptions): (found: FoundIndexObject) => Promise<IndexDefinitionOutcome> {
  const newId = options.newId ?? (() => crypto.randomUUID())
  return async found => {
    const { connectionId, kind, project, dataset, name } = found
    if (!isBigQueryPropertyKind(kind) || kind === 'bqDataset') return 'none'
    const result = await options.api.bigQueryProperties({ connectionId, requestId: newId(), kind, project, dataset, name })
    if (!result.ok) throw new Error(result.error)
    const text = result.value.definition
    if (!text) return 'none'
    const connection = options.connections.get(connectionId)
    options.documents.newQuery(text, undefined, connectionId, project === connection?.server ? dataset : (connection?.database ?? ''), false)
    options.opened?.()
    return result.value.definitionCut || result.value.definitionTruncated ? 'cut' : 'opened'
  }
}
