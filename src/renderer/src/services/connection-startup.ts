import type { VariaApi } from '../../../shared/contracts'
import type { ConnectionFailureReason } from '../../../shared/connection-targets'
import type { BackendStateService } from './backend'
import type { ConnectionService } from './connections'
import { acceptConnectionReceipt } from './connection-receipts'
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
  const scheduler = new StartupReconnectService(registry, async (target, pending) => {
    if (disposed || pending.signal.aborted || documents.getSnapshot().busy) return {}
    const { autoReconnect: _autoReconnect, ...presentation } = target.details
    const options = { ...target.options, ...presentation }, requestId = crypto.randomUUID()
    const attempt = connections.beginConnect(options, pending.generation, target.id, target.details)
    if (!attempt) return {}
    const abort = () => {
      // Foreground preemption is not the user's Disconnect intent. An older abort cannot cancel a newer operation.
      registry.failConnect(attempt.operation, 'cancelled')
      void api.cancelConnectionRequests([requestId]).catch(() => {})
    }
    pending.signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await api.connect(options, { targetId: target.id, requestId, mode: 'background', credentialPolicy: 'preserve', credentialIntent: 'preserve', credential: target.credential, expectedPrincipal: target.expectedPrincipal })
      if (!result.ok) {
        connections.failAttempt(attempt, result.connectionFailure ?? failureReason(result.code))
        return result.credentialRejected ? { credentialRejected: true as const } : {}
      }
      const opened = await acceptConnectionReceipt({ api, connections, info: result.value, options, details: target.details, attempt, requestId,
        current: () => !disposed && !pending.signal.aborted && !documents.getSnapshot().busy })
      if (!opened?.targetId) return {}
      if (opened.sourceTargetId && opened.sourceTargetId !== opened.targetId) {
        targets.coalesceTarget(opened.sourceTargetId, opened.targetId, opened.id)
        registry.removeFromExplorer(opened.sourceTargetId)
      }
      targets.rememberConnection(opened.id, opened.targetId)
      targets.attachTarget(opened.targetId, opened.id)
      return {}
    } catch {
      connections.failAttempt(attempt)
      return {}
    } finally {
      pending.signal.removeEventListener('abort', abort)
      connections.failAttempt(attempt, pending.signal.aborted ? 'cancelled' : 'unknown')
    }
  }, () => settings.get('environment.connections.autoReconnect'))
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
  const stopDocuments = documents.subscribe(start)
  void ready.then(() => { if (!disposed) { restored = true; start() } })
  return { scheduler, dispose: () => { disposed = true; stopBackend(); stopSettings(); stopDocuments(); scheduler.dispose() } }
}
