import type { BackendConnectionHandle } from '../../../shared/connection-targets'
import type { VariaApi } from '../../../shared/contracts'
import { isQueryDocument, type QueryDocument } from '../documents'
import type { DisconnectPromptService } from '../disconnect/DisconnectPromptService'
import type { ConnectionTargetService } from './connection-targets'
import { DisconnectCoordinator } from './disconnect'
import type { DocumentService } from './documents'
import type { FileService, PreparedQueryClose } from './files'
import type { LongRunService } from './long-runs'
import type { QueryService } from './queries'

export interface DisconnectWorkbenchOptions {
  readonly connectionTargets: ConnectionTargetService
  readonly documents: Pick<DocumentService, 'getSnapshot' | 'revision' | 'runTask' | 'connectionBusy' | 'endSession'>
  readonly queries: Pick<QueryService, 'getSnapshot' | 'isRunning' | 'prepareSessions' | 'cancelPreparedSessions' | 'sessionNote'> & Partial<Pick<QueryService, 'failedAborts' | 'executionVersion'>>
  readonly files: Pick<FileService, 'prepareQueryClose' | 'validateQueryClose'>
  readonly longRuns: Pick<LongRunService, 'disconnectRefusal'>
  readonly prompts: DisconnectPromptService
  readonly api: Pick<VariaApi, 'disconnect'>
  /** Persistence's exact-target detach: clear live fields, retain target/database/attach intent, notify custom owners. */
  readonly detached: (targetId: string, handle: BackendConnectionHandle) => void
  /** Local close without another session RPC; all reviewed models are validated before the first closes. */
  readonly closeQueries: (plan: PreparedQueryClose) => void
}

/** Wiring only: lifecycle remains in ConnectionTargetService and associations remain in the existing document owner. */
export function createDisconnectCoordinator(options: DisconnectWorkbenchOptions): DisconnectCoordinator {
  const { connectionTargets, documents, queries, files, longRuns, prompts, api } = options
  return new DisconnectCoordinator({
    targets: connectionTargets,
    documents: () => {
      const querySnapshot = queries.getSnapshot()
      return documents.getSnapshot().documents.map(document => {
        const runningConnectionIds = querySnapshot[document.id]?.running?.connectionIds
        return {
          id: document.id, name: document.name, targetId: (document as QueryDocument & { readonly targetId?: string }).targetId,
          connectionId: document.connectionId, database: document.database, revision: documents.revision(document.id),
          dirty: document.dirty, query: isQueryDocument(document), running: queries.isRunning(document.id),
          ...document.multiMode ? { multiMode: document.multiMode } : {},
          ...document.multiTargets ? { multiTargets: document.multiTargets } : {},
          ...runningConnectionIds ? { runningConnectionIds } : {},
          executionVersion: queries.executionVersion?.(document.id) ?? 0
        }
      })
    },
    busy: () => documents.getSnapshot().busy,
    runTask: action => documents.runTask(action),
    refusal: (_targetId, handle) => longRuns.disconnectRefusal(handle.id) ?? documents.connectionBusy(handle.id),
    confirm: request => prompts.request(request),
    prepareClose: ids => files.prepareQueryClose(ids),
    validateClose: plan => files.validateQueryClose(plan),
    prepareSessions: ids => queries.prepareSessions('disconnect', ids),
    cancelSessions: plan => queries.cancelPreparedSessions(plan),
    endSession: (id, transaction) => documents.endSession(id, transaction),
    sessionNote: (id, note, name) => queries.sessionNote(id, note, name),
    disconnect: async handle => {
      const response = await api.disconnect(handle.id)
      if (!response.ok) throw new Error(response.error)
      // Idle BigQuery sessions whose end failed: their temp tables and any transaction stay until BigQuery ends them.
      if (response.value.failedAborts) queries.failedAborts?.(response.value.failedAborts)
    },
    detached: options.detached,
    closeQueries: options.closeQueries
  })
}
