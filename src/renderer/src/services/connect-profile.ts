import type { VariaApi } from '../../../shared/contracts'
import { bigQueryTargetOptions } from '../../../shared/connection-targets'
import { liveGeneration, type BackendStateService } from './backend'
import { detailsOf, type ConnectionService } from './connections'
import { acceptConnectionReceipt } from './connection-receipts'
import { finishConnectionDetails, whenConnectionDocumentsIdle, type OpenedConnection } from './connection-opening'
import type { DocumentService } from './documents'
import type { StartupReconnectService } from './startup-reconnect'
import type { TargetService } from './targets'

export type ConnectProfileResult = { readonly ok: true; readonly connectionId: string } | { readonly ok: false; readonly error: string; readonly cancelled?: true }

/**
 * Connects a saved BigQuery connection by its id, with no Connect dialog (Show in Job History for a job whose project is
 * not connected; docs/bigquery.md, Job History). The connect is interactive, as Connect's is, so a sign-in it needs can
 * still be asked for; its target is the profile's own when one is disconnected, and main records it in that entry.
 */
export async function connectBigQueryProfile({ api, connections, targets, backend, documents, startupReconnect, signal }: {
  api: Pick<VariaApi, 'loadConnectionLibrary' | 'connect' | 'acceptConnectionRequest' | 'cancelConnectionRequests'>
  connections: ConnectionService
  targets: Pick<TargetService, 'rememberConnection' | 'attachTarget' | 'coalesceTarget'>
  backend: Pick<BackendStateService, 'getSnapshot'>
  documents: Pick<DocumentService, 'getSnapshot' | 'subscribe'>
  startupReconnect?: Pick<StartupReconnectService, 'beginManual' | 'cancel'>
  signal: AbortSignal
}, profileId: string): Promise<ConnectProfileResult> {
  const library = await api.loadConnectionLibrary().catch(() => undefined)
  if (!library?.ok) return { ok: false, error: library?.error ?? 'The saved BigQuery connections could not be read.' }
  const profile = library.value.bigQuery.profiles.find(item => item.id === profileId)
  if (!profile) return { ok: false, error: 'The saved BigQuery connection these jobs ran on was removed.' }
  const options = profile.options, wanted = JSON.stringify(bigQueryTargetOptions(options))
  const registry = connections.connectionTargets
  const prior = registry.getSnapshot().find(target => ['disconnected', 'lost'].includes(target.lifecycle.state) && JSON.stringify(target.options) === wanted)
  const foreground = startupReconnect?.beginManual()
  if (prior) startupReconnect?.cancel(prior.id)
  const details = detailsOf(options, profile.autoReconnect ?? 'inherit'), requestId = crypto.randomUUID()
  const attempt = connections.beginConnect(options, liveGeneration(backend.getSnapshot().state), prior?.id, details)
  if (!attempt) { foreground?.dispose(); return { ok: false, error: 'This connection is already changing. Try again once it has settled.' } }
  let opened: OpenedConnection | undefined
  try {
    const result = await api.connect(options, {
      targetId: attempt.operation.targetId, mode: 'interactive', credentialIntent: 'preserve', autoReconnect: profile.autoReconnect ?? 'inherit', requestId, selectedProfileId: profile.id,
      ...prior?.expectedPrincipal ? { expectedPrincipal: prior.expectedPrincipal } : {}
    })
    if (!result.ok) {
      connections.failAttempt(attempt, result.code === 'CANCELLED' ? 'cancelled' : result.connectionFailure ?? 'unknown')
      return { ok: false, error: result.error, ...result.code === 'CANCELLED' ? { cancelled: true as const } : {} }
    }
    const changed = { ok: false as const, error: 'This connection changed while connecting.' }
    while (documents.getSnapshot().busy) {
      if (!await whenConnectionDocumentsIdle(documents, signal)) {
        connections.failAttempt(attempt, signal.aborted ? 'cancelled' : 'unknown')
        void api.cancelConnectionRequests([requestId]).catch(() => {})
        return changed
      }
    }
    if (signal.aborted) {
      connections.failAttempt(attempt, 'cancelled')
      void api.cancelConnectionRequests([requestId]).catch(() => {})
      return changed
    }
    opened = await acceptConnectionReceipt({ api, connections, info: result.value, options, details, attempt, requestId, signal, current: () => !signal.aborted })
    if (!opened) return changed
    while (documents.getSnapshot().busy) if (!await whenConnectionDocumentsIdle(documents, signal)) return changed
    if (signal.aborted) return changed
    const info = finishConnectionDetails(connections, opened, 'current')
    if (!info) return changed
    if (info.targetId) {
      if (opened.sourceTargetId && opened.sourceTargetId !== info.targetId) {
        targets.coalesceTarget(opened.sourceTargetId, info.targetId, info.id, true)
        registry.removeFromExplorer(opened.sourceTargetId)
      }
      targets.rememberConnection(info.id, info.targetId)
      targets.attachTarget(info.targetId, info.id, true)
    }
    opened.association?.complete()
    return { ok: true, connectionId: info.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The connection could not be opened.' }
  } finally {
    opened?.association?.abandon()
    connections.failAttempt(attempt)
    foreground?.dispose()
  }
}
