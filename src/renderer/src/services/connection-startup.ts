import type { VariaApi } from '../../../shared/contracts'
import type { ConnectionFailureReason } from '../../../shared/connection-targets'
import type { BackendStateService } from './backend'
import type { ConnectionService } from './connections'
import { acceptConnectionReceipt } from './connection-receipts'
import { whenConnectionDocumentsIdle, type OpenedConnection } from './connection-opening'
import type { DocumentService } from './documents'
import type { TargetService } from './targets'
import type { SettingsService } from '../settings/SettingsService'
import { StartupReconnectService } from './startup-reconnect'

const failureReason = (code?: string): ConnectionFailureReason => {
  if (code === 'CANCELLED') return 'cancelled'
  if (code === 'SIGN_IN_REQUIRED' || code === 'AUTH_INTERACTION_REQUIRED') return 'sign-in-required'
  if (code === 'CREDENTIALS_REQUIRED' || code === 'AUTHENTICATION_FAILED') return 'credentials-required'
  if (code === 'SECRET_STORAGE_UNAVAILABLE') return 'secret-storage-unavailable'
  if (code === 'IDENTITY_CHANGED') return 'identity-changed'
  return 'unknown'
}

/** The startup pass shares ordinary receipt adoption; its only actions are connect and exact wanted-query attachment. */
export function bindStartupReconnect({ api, connections, documents, targets, backend, settings, ready }: {
  api: Pick<VariaApi, 'connect' | 'cancelConnectionRequests' | 'acceptConnectionRequest'>
  connections: ConnectionService
  documents: Pick<DocumentService, 'getSnapshot' | 'subscribe'>
  targets: Pick<TargetService, 'rememberConnection' | 'attachTarget' | 'coalesceTarget'>
  backend: Pick<BackendStateService, 'getSnapshot' | 'subscribe'>
  settings: Pick<SettingsService, 'getSnapshot' | 'get' | 'subscribe'>
  ready: Promise<void>
}) {
  const registry = connections.connectionTargets
  let disposed = false, restored = false, started = false
  const whenDocumentsIdle = (signal: AbortSignal) => whenConnectionDocumentsIdle(documents, signal)
  const scheduler = new StartupReconnectService(registry, async (target, pending) => {
    if (disposed || pending.signal.aborted) return {}
    const { autoReconnect: _autoReconnect, ...presentation } = target.details
    const options = { ...target.options, ...presentation }, requestId = crypto.randomUUID()
    const attempt = connections.beginConnect(options, pending.generation, target.id, target.details)
    if (!attempt) return {}
    let cancellation: Promise<unknown> | undefined
    const abort = () => {
      // Foreground preemption is not the user's Disconnect intent. An older abort cannot cancel a newer operation.
      registry.failConnect(attempt.operation, 'cancelled')
      cancellation ??= api.cancelConnectionRequests([requestId]).catch(() => {})
    }
    pending.signal.addEventListener('abort', abort, { once: true })
    let opened: OpenedConnection | undefined
    try {
      if (pending.signal.aborted) { connections.failAttempt(attempt, 'cancelled'); return { interrupted: true } }
      const result = await api.connect(options, { targetId: target.id, requestId, mode: 'background', credentialPolicy: 'preserve', credentialIntent: 'preserve', credential: target.credential, expectedPrincipal: target.expectedPrincipal })
      if (!result.ok) {
        connections.failAttempt(attempt, result.connectionFailure ?? failureReason(result.code))
        return { ...result.credentialRejected ? { credentialRejected: true as const } : {}, ...result.code === 'CANCELLED' ? { interrupted: true as const } : {} }
      }
      while (documents.getSnapshot().busy) if (!await whenDocumentsIdle(pending.signal)) return { interrupted: true }
      if (!pending.beginAcceptance()) return { interrupted: true }
      opened = await acceptConnectionReceipt({ api, connections, info: result.value, options, details: target.details, attempt, requestId, signal: pending.signal,
        current: () => !disposed && !pending.signal.aborted,
        onAdopted: value => pending.adopted(value.targetId!, { id: value.id, generation: value.generation }) })
      if (!opened?.targetId) return {}
      while (documents.getSnapshot().busy) if (!await whenDocumentsIdle(pending.signal)) return {}
      if (disposed || pending.signal.aborted) return {}
      const current = connections.get(opened.id)
      if (!current || !connections.isLive(opened.id) || current.generation !== opened.generation || current.targetId !== opened.targetId || !pending.finishAttachment()) return {}
      if (opened.sourceTargetId && opened.sourceTargetId !== opened.targetId) {
        targets.coalesceTarget(opened.sourceTargetId, opened.targetId, opened.id)
        registry.removeFromExplorer(opened.sourceTargetId)
      }
      targets.rememberConnection(opened.id, opened.targetId)
      targets.attachTarget(opened.targetId, opened.id)
      opened.association?.complete()
      return {}
    } catch {
      connections.failAttempt(attempt)
      return {}
    } finally {
      opened?.association?.abandon()
      pending.signal.removeEventListener('abort', abort)
      connections.failAttempt(attempt, pending.signal.aborted ? 'cancelled' : 'unknown')
      // Main may have answered CANCELLED while the request's credential preparation was still draining.
      if (cancellation) await cancellation
    }
  }, () => settings.get('environment.connections.autoReconnect'), () => !documents.getSnapshot().busy)
  const start = () => {
    if (disposed || started || !restored || documents.getSnapshot().busy) return
    const configuration = settings.getSnapshot(), state = backend.getSnapshot().state
    // Failed/slow settings reads cannot briefly turn an unknown saved Off into the default On. Manual connect remains usable.
    if (!configuration.loaded || configuration.revision <= 0 || state.status !== 'ready') return
    started = true
    scheduler.start(state.generation)
  }
  const stopBackend = backend.subscribe(start)
  const stopSettings = settings.subscribe(() => { scheduler.refresh(); start() })
  const stopDocuments = documents.subscribe(() => { scheduler.refresh(); start() })
  void ready.then(() => { if (!disposed) { restored = true; start() } })
  return { scheduler, dispose: () => { disposed = true; stopBackend(); stopSettings(); stopDocuments(); scheduler.dispose() } }
}
