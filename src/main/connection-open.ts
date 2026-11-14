import { randomUUID } from 'node:crypto'
import type { BackendState, ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { connectContextSchema } from '../shared/connections'
import { backendConnectionHandleSchema, connectionAuthenticationSchema, connectionTargetLimits, type BackendConnectionHandle, type ConnectionCredentialReference, type ConnectionFailureReason } from '../shared/connection-targets'
import { connectionBindingsChangedSchema, type ConnectionBindingsChanged } from '../shared/connection-bindings'
import type { ActionExecuteRequest, ActionExecuteResult } from '../shared/actions/schema'
import { BackendError } from './backend/errors'
import { ConnectionReuseCoordinator } from './connection-reuse'
import { verifiedConnectionAuthentication } from './connection-principal'
import { admitVerifiedCredentialReference, ConnectionPreparationError, hasPendingCredentialRequests, prepare, rejectCredentialReference, settle, settleReused, type ConnectionRequestDeps, type PreparedRequest, type Settled } from './connection-requests'
import { validateResult } from './validation'

export interface ConnectionReceiptResult { readonly accepted: boolean; readonly retained: boolean }
export interface ConnectionOpenDeps extends ConnectionRequestDeps {
  readonly generation: () => number | undefined
  readonly open: (options: unknown, generation: number, signal: AbortSignal) => Promise<ConnectionInfo>
  readonly close: (handle: BackendConnectionHandle) => Promise<{ disconnected: boolean }>
  readonly bindingsChanged?: (event: ConnectionBindingsChanged) => void
}
interface Receipt {
  readonly id: string
  readonly epoch: number
  readonly controller: AbortController
  state: 'pending' | 'delivered' | 'accepted' | 'cancelled'
  handle?: string
  targetId?: string
}
interface Owned {
  info: ConnectionInfo
  readonly receipts: Set<string>
  initialization?: Promise<ConnectionInfo>
  accepted: boolean
  closing?: Promise<boolean>
  cleanup?: Promise<void>
  fenced: boolean
  bindingEventRevision: number
}
interface Mutation { readonly id: string; readonly generation: number; readonly handles: readonly BackendConnectionHandle[]; readonly password?: string }
const handleKey = (handle: BackendConnectionHandle) => `${handle.generation}:${handle.id}`
const cancelled = () => new BackendError('CANCELLED', 'The connection request was cancelled.')

/** A failed native result check can still contain a newly registered handle. Clean up only a valid current handle. */
export async function validateOpenedConnection(value: unknown, generation: number, close: (handle: BackendConnectionHandle) => Promise<unknown>): Promise<ConnectionInfo> {
  try { return validateResult('connections.connect', value) as ConnectionInfo }
  catch (error) {
    const raw = value && typeof value === 'object' ? value as Partial<BackendConnectionHandle> : undefined
    const parsed = backendConnectionHandleSchema.safeParse({ id: raw?.id, generation: raw?.generation })
    if (parsed.success && parsed.data.generation === generation) await close(parsed.data).catch(() => {})
    throw error
  }
}
class OpenFailure { constructor(readonly result: Extract<Settled, { ok: false }>) {} }
function failureReason(error: unknown): ConnectionFailureReason {
  if (error instanceof ConnectionPreparationError) return error.reason
  if (!(error instanceof BackendError)) return 'unknown'
  if (error.code === 'CANCELLED') return 'cancelled'
  if (error.code === 'BACKEND_LOST' || error.code === 'CONNECTION_LOST') return 'backend-lost'
  if (error.code === 'AUTH_ENTRA') return 'sign-in-required'
  if (error.code === 'AUTH_IDENTITY') return 'identity-changed'
  if (error.code === 'AUTH_KERBEROS') return 'credentials-required'
  if (error.details?.reason === 'certificate') return 'certificate'
  if ([4060, 916, 911].includes(error.details?.number ?? 0)) return 'database-unavailable'
  if (error.details?.number === 18456) return 'credentials-required'
  return 'network'
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}

/** Main's connection owner. A delivered IPC reply is a receipt, not permission for that caller to close a shared handle. */
export class ConnectionOpenService {
  private reuse: ConnectionReuseCoordinator<ConnectionInfo>
  private readonly receipts = new Map<string, Receipt>()
  private readonly cancelledIds = new Set<string>()
  private readonly handles = new Map<string, Owned>()
  private readonly pendingPrunes = new Set<string>()
  private epoch = 0
  private generation = 0
  private mutation?: Mutation
  private mutationSettlements = 0

  get mutationPending(): boolean { return !!this.mutation || this.mutationSettlements > 0 }

  constructor(private readonly deps: ConnectionOpenDeps) { this.reuse = this.coordinator() }

  async connect(options: ConnectionOptions, contextValue: unknown): Promise<Settled> {
    let receipt: Receipt | undefined, prepared: PreparedRequest | undefined, ownsSettlement = false
    try {
      if (this.mutationPending) throw new BackendError('BUSY', 'Wait for the connection settings change to finish before connecting.')
      const context = connectContextSchema.parse(contextValue ?? {}), id = context.requestId ?? randomUUID()
      if (this.cancelledIds.delete(id)) throw cancelled()
      if (this.receipts.has(id)) throw new BackendError('DUPLICATE_REQUEST', 'This connection request already exists.')
      if ([...this.receipts.values()].filter(value => value.state === 'pending').length >= 8) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending connection requests.')
      this.pruneReceipts()
      receipt = { id, epoch: this.epoch, controller: new AbortController(), state: 'pending', targetId: context.targetId }
      this.receipts.set(id, receipt)
      const preparing = prepare('connections.connect', options, { ...context, requestId: id }, this.deps)
      void preparing.then(value => { if (receipt!.controller.signal.aborted) value.release?.() }, () => {})
      prepared = await abortable(preparing, receipt.controller.signal)
      receipt.targetId = prepared.context?.targetId
      const generation = this.deps.generation()
      if (generation === undefined) throw new BackendError('BACKEND_UNAVAILABLE', 'Wait for the SQL backend to become ready.')
      this.markLostBefore(generation)
      const active = receipt, request = prepared
      const { nonInteractive: _nonInteractive, ...comparisonOptions } = request.params as ConnectionOptions & { nonInteractive?: boolean }
      const result = await this.reuse.connect({
        targetId: request.context!.targetId!, generation, options: comparisonOptions,
        expectedPrincipal: request.context?.expectedPrincipal, credentialIntent: request.context?.credentialIntent,
        signal: active.controller.signal
      }, async signal => {
        const connection = await this.deps.open(request.params, generation, signal)
        if ((connection.bindingRevision ?? 0) !== 0) {
          await this.closeUnowned(connection)
          throw new BackendError('AUTH_IDENTITY', 'The connection settings changed during authentication. Reconnect explicitly.')
        }
        const proof = verifiedConnectionAuthentication(connection, options.authentication)
        if (!proof) {
          await this.closeUnowned(connection)
          throw new BackendError('AUTH_IDENTITY', 'The authenticated server account could not be verified. Reconnect explicitly.')
        }
        return { connection, principal: proof.principal }
      })
      if (result.status !== 'connected' && result.status !== 'reused') {
        if (result.status === 'failed') {
          const failure = await settle(request, { ok: false, error: result.error }, this.deps)
          return failure.ok ? failure : { ...failure, connectionFailure: failureReason(failure.error) }
        }
        if (result.status === 'cancelled') throw cancelled()
        throw new ConnectionPreparationError(result.status === 'identity-changed' ? 'identity-changed' : 'unknown', result.status === 'identity-changed'
          ? 'The authenticated account differs from this target. Choose a connection explicitly.' : 'This connection cannot be opened while its target is changing.')
      }
      if (active.epoch !== this.epoch) throw cancelled()
      const key = handleKey(result.connection)
      let owned = this.handles.get(key)
      if (!owned) {
        owned = { info: { ...result.connection, targetId: result.targetId }, receipts: new Set(), accepted: false, fenced: false, bindingEventRevision: 0 }
        this.handles.set(key, owned)
      }
      const owner = owned
      active.handle = key
      active.targetId = result.targetId
      owner.receipts.add(active.id)
      if (!owner.initialization) {
        ownsSettlement = true
        const { password: _password, ...nonsecret } = request.validated as ConnectionOptions
        const source = { ...request, validated: request.context?.targetId === result.targetId ? request.validated : nonsecret, context: { ...request.context, targetId: result.targetId } }
        owner.initialization = this.initialize(owner, source, request.context?.targetId !== result.targetId)
      }
      const initialized = await abortable(owner.initialization, active.controller.signal)
      let info = { ...initialized }
      if (!ownsSettlement) {
        ownsSettlement = true
        const outcome = await abortable(settleReused(request, info, this.deps), active.controller.signal)
        if (!outcome.ok) throw new OpenFailure(outcome)
        info = outcome.value as ConnectionInfo
      }
      if (active.controller.signal.aborted || active.epoch !== this.epoch || this.handles.get(key) !== owner || owner.fenced) throw cancelled()
      active.state = 'delivered'
      // Direct API callers without a request UUID have no asynchronous adoption step to acknowledge.
      if (!context.requestId) await this.accept(active.id)
      return { ok: true, value: info }
    } catch (error) {
      if (receipt) { receipt.state = 'cancelled'; this.release(receipt) }
      return error instanceof OpenFailure ? { ...error.result, connectionFailure: failureReason(error.result.error) } : { ok: false, error, connectionFailure: failureReason(error) }
    } finally { if (!ownsSettlement) prepared?.release?.(); this.flushPrunes() }
  }

  async accept(requestId: string): Promise<ConnectionReceiptResult> {
    const receipt = this.receipts.get(requestId)
    if (!receipt) throw new Error('This connection receipt is no longer available.')
    const owner = receipt.handle ? this.handles.get(receipt.handle) : undefined
    if (receipt.state === 'accepted') return { accepted: !!owner && !owner.fenced, retained: !!owner }
    if (receipt.state !== 'delivered' || !owner || owner.fenced || receipt.controller.signal.aborted || receipt.epoch !== this.epoch) {
      if (owner?.cleanup) await owner.cleanup
      if (owner?.closing) await owner.closing
      return { accepted: false, retained: !!receipt.handle && this.handles.has(receipt.handle) }
    }
    owner.accepted = true
    this.pendingPrunes.delete(owner.info.targetId!)
    owner.receipts.delete(requestId)
    receipt.state = 'accepted'
    return { accepted: true, retained: true }
  }

  /** Existing Stop also releases a reply that crossed cancellation, without touching another accepted caller. */
  cancel(requestIds: readonly string[]): number {
    let count = 0
    for (const id of requestIds) {
      const receipt = this.receipts.get(id)
      if (!receipt) {
        this.cancelledIds.add(id)
        if (this.cancelledIds.size > 64) this.cancelledIds.delete(this.cancelledIds.values().next().value!)
        continue
      }
      if (receipt.state === 'accepted' || receipt.state === 'cancelled') continue
      receipt.state = 'cancelled'
      receipt.controller.abort()
      this.release(receipt)
      count++
    }
    return count
  }

  pruneTargets(targetIds: readonly string[]): number {
    for (const id of targetIds) {
      if ([...this.handles.values()].some(owner => owner.info.targetId === id && owner.accepted)) continue
      if (this.pendingPrunes.size < connectionTargetLimits.targets) this.pendingPrunes.add(id)
    }
    return this.flushPrunes()
  }

  private flushPrunes(): number {
    let pruned = 0
    for (const id of this.pendingPrunes) {
      if (this.reuse.hasTarget(id) || [...this.receipts.values()].some(receipt => receipt.targetId === id && (receipt.state === 'pending' || receipt.state === 'delivered'))) continue
      if (this.reuse.removeTarget(id)) { this.deps.authentication.forget(id); this.pendingPrunes.delete(id); pruned++ }
    }
    return pruned
  }

  async disconnect(connectionId: string): Promise<{ disconnected: boolean }> {
    if (this.mutationPending) throw new BackendError('BUSY', 'Wait for the connection settings change to finish before disconnecting.')
    const generation = this.deps.generation(), owner = [...this.handles.values()].find(value => value.info.id === connectionId && value.info.generation === generation)
    if (!owner) return { disconnected: false }
    if (owner.closing || owner.fenced || !this.reuse.beginDisconnect(owner.info)) throw new Error('This connection is already being disconnected.')
    owner.fenced = true
    const closing = this.deps.close(owner.info)
    owner.closing = closing.then(() => true, () => false)
    try {
      const result = await closing
      this.reuse.finishDisconnect(owner.info, true)
      this.handles.delete(handleKey(owner.info))
      this.flushPrunes()
      return result
    } catch (error) {
      this.reuse.finishDisconnect(owner.info, false)
      owner.fenced = false
      throw error
    } finally { owner.closing = undefined }
  }

  beginBindingMutation(request: ActionExecuteRequest): string | undefined {
    const password = request.action === 'loginProperties' && request.loginChanges.password ? request.secrets?.password : undefined
    const database = 'target' in request && request.target.kind === 'database' && ['rename', 'delete', 'detach', 'restore', 'restoreFiles'].includes(request.action)
    if (password === undefined && !database) return undefined
    if (this.mutationPending || hasPendingCredentialRequests(this.deps.savedPasswords) || [...this.handles.values()].some(owner => owner.closing || owner.fenced) || [...this.receipts.values()].some(receipt => receipt.state === 'pending' || receipt.state === 'delivered') || !this.reuse.beginBindingMutation()) throw new BackendError('BUSY', 'Wait for the current connection operation to finish before changing connection settings.')
    const generation = this.deps.generation()
    if (generation === undefined) { this.reuse.endBindingMutation(); throw new BackendError('BACKEND_UNAVAILABLE', 'The SQL backend is not running.') }
    const id = randomUUID()
    this.mutation = { id, generation, password, handles: [...this.handles.values()].filter(owner => owner.accepted && owner.info.generation === generation).map(owner => ({ id: owner.info.id, generation })) }
    return id
  }

  async finishBindingMutation(id: string, result?: ActionExecuteResult): Promise<void> {
    const mutation = this.mutation
    if (!mutation || mutation.id !== id) return
    this.mutationSettlements++
    const changes: ConnectionBindingsChanged['changes'] = [], applied = new Set<string>()
    let warning: string | undefined
    try {
      if (this.deps.generation() !== mutation.generation) return
      // Project all confirmed durable changes before vault I/O: a generation loss must not leave later affected pins
      // claiming the old secret while one replacement write is draining.
      const plans = (result?.bindingChanges ?? []).flatMap(change => {
        const handle = { id: change.connectionId, generation: mutation.generation }, key = handleKey(handle), owner = this.handles.get(key), before = this.reuse.binding(handle)
        if (!owner?.accepted || !before) return []
        if (!this.reuse.applyBinding(handle, change, change.passwordChanged ? mutation.password : undefined)) {
          if (change.bindingRevision > before.bindingRevision) this.reuse.invalidateBinding(handle)
          return []
        }
        applied.add(key)
        const after = this.reuse.binding(handle)!, pin = this.deps.authentication.resolve(before.targetId)
        if (!pin?.expectedPrincipal) { this.reuse.invalidateBinding(handle); return [] }
        if (change.passwordChanged && pin.credential) rejectCredentialReference(this.deps.savedPasswords, pin.credential)
        const authentication = connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, credential: change.passwordChanged ? null : pin.credential ?? null })
        this.deps.authentication.rebind(before.targetId, before.options, after.options, authentication)
        return [{ change, handle, key, owner, before, after, principal: pin.expectedPrincipal, previousCredential: pin.credential }]
      })
      if (result?.bindingChangesComplete !== true) {
        for (const handle of mutation.handles) if (!applied.has(handleKey(handle))) this.reuse.invalidateBinding(handle)
      }
      for (const plan of plans) {
        const { change, handle, key, owner, before, after, principal, previousCredential } = plan
        let credential = previousCredential
        if (change.passwordChanged) {
          credential = undefined
          if (previousCredential) {
            try {
              credential = await this.replaceRememberedCredential(previousCredential, after.options, mutation.password)
            } catch {
              await this.deps.savedPasswords.forgetRejected(previousCredential, before.options).catch(() => {})
              warning = 'The password changed, but its saved credential could not be updated. Enter credentials to reconnect.'
            }
          }
        }
        if (!this.deps.authentication.resolve(before.targetId)) continue
        const authentication = connectionAuthenticationSchema.parse({ principal, credential: credential ?? null })
        this.deps.authentication.rebind(before.targetId, after.options, after.options, authentication)
        if (this.mutation !== mutation || this.deps.generation() !== mutation.generation || this.handles.get(key) !== owner) continue
        owner.info = Object.freeze({ ...owner.info, database: change.newDatabase ?? owner.info.database, authentication, bindingRevision: change.bindingRevision })
        owner.initialization = Promise.resolve(owner.info)
        changes.push({ targetId: before.targetId, handle, revision: ++owner.bindingEventRevision, options: after.options, authentication })
      }
      if (changes.length) this.deps.bindingsChanged?.(connectionBindingsChangedSchema.parse({ generation: mutation.generation, changes, ...warning ? { warning } : {} }))
    } catch (error) {
      for (const handle of mutation.handles) this.reuse.invalidateBinding(handle)
      throw error
    } finally {
      this.mutationSettlements--
      if (this.mutation === mutation) { this.mutation = undefined; this.reuse.endBindingMutation() }
    }
  }

  private async replaceRememberedCredential(previous: ConnectionCredentialReference, options: ConnectionOptions, password?: string): Promise<ConnectionCredentialReference> {
    if (password === undefined || !await this.deps.savedPasswords.storageAvailable()) throw new Error('The saved credential cannot be updated.')
    const current = await this.deps.savedPasswords.reference(previous.profileId, options)
    if (!current || current.revision !== previous.revision && await this.deps.savedPasswords.getReferenced(current, options) !== password) throw new Error('The saved credential revision changed.')
    if (current.revision === previous.revision) await this.deps.savedPasswords.set(previous.profileId, { ...options, password })
    const reference = await this.deps.savedPasswords.reference(previous.profileId, options)
    if (!reference || await this.deps.savedPasswords.getReferenced(reference, options) !== password) throw new Error('The replacement credential is unavailable.')
    admitVerifiedCredentialReference(this.deps.savedPasswords, reference)
    return reference
  }

  backendState(state: BackendState): void {
    if (state.status === 'stopped') { this.reset(); return }
    if ('generation' in state) this.markLostBefore(state.generation)
    if ('lost' in state && state.lost) this.markLostBefore(state.lost.generation + 1)
  }

  reset(): void {
    this.epoch++
    for (const receipt of this.receipts.values()) if (receipt.state !== 'accepted') receipt.controller.abort()
    this.receipts.clear()
    this.cancelledIds.clear()
    this.pendingPrunes.clear()
    this.handles.clear()
    this.mutation = undefined
    this.reuse.dispose()
    this.reuse = this.coordinator()
    this.generation = 0
  }

  private markLostBefore(generation: number): void {
    if (generation <= this.generation) return
    this.generation = generation
    this.reuse.markLostBefore(generation)
    for (const [key, owner] of this.handles) if (owner.info.generation < generation) this.handles.delete(key)
    for (const receipt of this.receipts.values()) if (receipt.handle && !this.handles.has(receipt.handle)) receipt.state = 'cancelled'
    this.flushPrunes()
  }

  private async initialize(owner: Owned, prepared: PreparedRequest, equivalentTarget: boolean): Promise<ConnectionInfo> {
    const outcome = await settle(prepared, { ok: true, value: { ...owner.info } }, { ...this.deps, disconnect: async () => { await this.close(owner) } })
    if (!outcome.ok) throw new OpenFailure(outcome)
    const info = outcome.value as ConnectionInfo
    if (!info.authentication || !info.targetId) {
      await this.close(owner)
      throw new OpenFailure({ ok: false, error: new Error('The authenticated connection receipt is incomplete.') })
    }
    if (equivalentTarget && prepared.context?.mode !== 'background' && (prepared.context?.credentialPolicy === 'remember' || prepared.context?.credentialPolicy === 'forget' || prepared.context?.remember !== undefined)) info.credentialUpdated = true
    owner.info = Object.freeze(info)
    return owner.info
  }

  private release(receipt: Receipt): void {
    const owner = receipt.handle ? this.handles.get(receipt.handle) : undefined
    if (!owner) return
    owner.receipts.delete(receipt.id)
    if (owner.cleanup) return
    owner.cleanup = (async () => {
      await owner.initialization?.catch(() => {})
      if (!owner.accepted && !owner.receipts.size && this.handles.get(handleKey(owner.info)) === owner) await this.close(owner)
    })().catch(() => {}).finally(() => { owner.cleanup = undefined })
  }

  private close(owner: Owned): Promise<boolean> {
    if (owner.closing) return owner.closing
    if (this.handles.get(handleKey(owner.info)) !== owner) return Promise.resolve(true)
    owner.fenced = true
    this.reuse.beginDisconnect(owner.info)
    owner.closing = (async () => {
      try {
        await this.deps.close(owner.info)
        this.reuse.finishDisconnect(owner.info, true)
        if (this.handles.get(handleKey(owner.info)) === owner) this.handles.delete(handleKey(owner.info))
        this.flushPrunes()
        return true
      } catch {
        this.reuse.finishDisconnect(owner.info, false)
        owner.fenced = false
        return false
      } finally { owner.closing = undefined }
    })()
    return owner.closing
  }

  private async closeUnowned(info: ConnectionInfo): Promise<void> {
    if (this.deps.generation() !== info.generation) return
    await this.deps.close(info).catch(() => {})
  }

  private coordinator(): ConnectionReuseCoordinator<ConnectionInfo> { return new ConnectionReuseCoordinator({ dispose: info => this.closeUnowned(info) }) }

  private pruneReceipts(): void {
    for (const [id, receipt] of this.receipts) {
      if (this.receipts.size < connectionTargetLimits.targets * 4) break
      if (receipt.state === 'accepted' || receipt.state === 'cancelled') this.receipts.delete(id)
    }
    if (this.receipts.size >= connectionTargetLimits.targets * 4) throw new BackendError('TOO_MANY_REQUESTS', 'Too many unaccepted connection receipts.')
  }
}
