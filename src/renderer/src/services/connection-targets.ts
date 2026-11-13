import {
  backendConnectionHandleSchema, connectionAuthenticationSchema, connectionDetailsSchema, connectionLifecycleSchema, connectionTargetLimits,
  connectionWorkspaceSchema, persistedConnectionTargetSchema,
  type BackendConnectionHandle, type ConnectionAuthentication, type ConnectionDetails, type ConnectionFailureReason, type ConnectionLifecycle,
  type ConnectionTarget, type ConnectionWorkspace, type PersistedConnectionTarget
} from '../../../shared/connection-targets'
import { SnapshotStore } from '../core/store'
import { connectionBindingsChangedSchema, type ConnectionBindingsChanged } from '../../../shared/connection-bindings'

/** An operation epoch is distinct from a backend generation and is never written to the workspace. */
interface ConnectionOperationBase {
  readonly targetId: string
  readonly attemptId: string
  readonly generation: number
  readonly revision: number
}
export type ConnectionCredentialIntent = 'preserve' | 'update-credentials'
export type ConnectionOperation = ConnectionOperationBase & (
  { readonly kind: 'connect'; readonly credentialIntent: ConnectionCredentialIntent } | { readonly kind: 'disconnect' }
)
export type ConnectionCompletion =
  | { readonly status: 'accepted' | 'already-current' }
  | { readonly status: 'in-use'; readonly targetId: string }
  | { readonly status: 'stale'; readonly dispose: BackendConnectionHandle }
  | { readonly status: 'rejected'; readonly reason: ConnectionFailureReason; readonly dispose: BackendConnectionHandle }

const validGeneration = (value: number) => Number.isSafeInteger(value) && value >= 0
const persisted = ({ lifecycle: _lifecycle, ...target }: ConnectionTarget): PersistedConnectionTarget => target
const entry = (target: PersistedConnectionTarget, lifecycle: ConnectionLifecycle): ConnectionTarget => Object.freeze({
  ...persistedConnectionTargetSchema.parse(target), lifecycle: connectionLifecycleSchema.parse(lifecycle)
})

/**
 * Target metadata and lifecycle only. Main owns credential-sensitive equivalence and all backend calls. A stale
 * successful completion returns its handle for that owner to release; dropping the reply alone would leak a connection.
 */
export class ConnectionTargetService extends SnapshotStore<readonly ConnectionTarget[]> {
  private generation = 0
  private revision = 0
  private operations = new Map<string, ConnectionOperation>()
  private readonly bindingRevisions = new Map<string, { readonly id: string; readonly generation: number; readonly revision: number }>()

  constructor() { super(Object.freeze([])) }
  get(id: string): ConnectionTarget | undefined { return this.getSnapshot().find(target => target.id === id) }
  operation(id: string): ConnectionOperation | undefined { return this.operations.get(id) }
  bindingRevision(handle: BackendConnectionHandle): number {
    const target = this.getSnapshot().find(value => (value.lifecycle.state === 'connected' || value.lifecycle.state === 'disconnecting') && value.lifecycle.handle.id === handle.id && value.lifecycle.handle.generation === handle.generation)
    const current = target ? this.bindingRevisions.get(target.id) : undefined
    return current?.id === handle.id && current.generation === handle.generation ? current.revision : 0
  }

  /** Restore does not authenticate, deduplicate or open anything, and cannot discard a live transport. */
  restore(workspace: ConnectionWorkspace): boolean {
    const parsed = connectionWorkspaceSchema.parse(workspace)
    if (this.getSnapshot().some(target => !['disconnected', 'lost'].includes(target.lifecycle.state))) return false
    this.operations.clear()
    this.bindingRevisions.clear()
    this.publish(Object.freeze(parsed.targets.map(target => entry(target, { state: 'disconnected' }))))
    return true
  }

  add(target: PersistedConnectionTarget): boolean {
    const parsed = persistedConnectionTargetSchema.parse(target)
    if (this.get(parsed.id) || this.getSnapshot().length >= connectionTargetLimits.targets) return false
    this.publish(Object.freeze([...this.getSnapshot(), entry(parsed, { state: 'disconnected' })]))
    return true
  }

  exportWorkspace(): ConnectionWorkspace {
    return connectionWorkspaceSchema.parse({ version: 1, targets: this.getSnapshot().map(persisted) })
  }

  setDetails(id: string, details: ConnectionDetails): boolean {
    const parsed = connectionDetailsSchema.parse(details), target = this.get(id)
    if (!target) return false
    this.replace(id, { ...persisted(target), details: parsed }, target.lifecycle)
    return true
  }

  /** Main confirmed a runtime mutation. Settings and credential evidence move together on this exact current binding. */
  applyBindings(update: ConnectionBindingsChanged): readonly ConnectionBindingsChanged['changes'][number][] {
    const parsed = connectionBindingsChangedSchema.safeParse(update)
    if (!parsed.success || parsed.data.generation !== this.generation) return []
    const targets = [...this.getSnapshot()], accepted: ConnectionBindingsChanged['changes'][number][] = []
    for (const change of parsed.data.changes) {
      const index = targets.findIndex(target => target.id === change.targetId), target = targets[index], lifecycle = target?.lifecycle
      if (!target || (lifecycle?.state !== 'connected' && lifecycle?.state !== 'disconnecting')
        || lifecycle.handle.id !== change.handle.id || lifecycle.handle.generation !== change.handle.generation) continue
      const previous = this.bindingRevisions.get(target.id), expected = target.expectedPrincipal, actual = change.authentication.principal
      if (previous?.id === change.handle.id && previous.generation === change.handle.generation && previous.revision >= change.revision) continue
      if (!expected || expected.provider !== actual.provider || expected.authentication !== actual.authentication || expected.id !== actual.id) continue
      const { database: _oldDatabase, ...oldSettings } = target.options, { database: _newDatabase, ...newSettings } = change.options
      if (JSON.stringify(oldSettings) !== JSON.stringify(newSettings)) continue
      const { credential: oldCredential, ...rest } = persisted(target)
      const credential = change.authentication.credential === undefined ? oldCredential : change.authentication.credential ?? undefined
      const replacement = persistedConnectionTargetSchema.safeParse({ ...rest, options: change.options, ...credential ? { credential } : {} })
      if (!replacement.success) continue
      targets[index] = entry(replacement.data, lifecycle)
      this.bindingRevisions.set(target.id, { ...change.handle, revision: change.revision })
      accepted.push(change)
    }
    if (accepted.length) this.publish(Object.freeze(targets))
    return Object.freeze(accepted)
  }

  /** Main explicitly changed remembered credentials for this same authenticated, already-live transport. */
  reconcileAuthentication(handle: BackendConnectionHandle, authentication: ConnectionAuthentication): boolean {
    const parsedHandle = backendConnectionHandleSchema.safeParse(handle), proof = connectionAuthenticationSchema.safeParse(authentication)
    if (!parsedHandle.success || !proof.success) return false
    const target = this.getSnapshot().find(value => value.lifecycle.state === 'connected' && value.lifecycle.handle.id === parsedHandle.data.id && value.lifecycle.handle.generation === parsedHandle.data.generation)
    const expected = target?.expectedPrincipal, actual = proof.data.principal
    if (!target || !expected || expected.provider !== actual.provider || expected.authentication !== actual.authentication || expected.id !== actual.id) return false
    if (proof.data.credential === undefined) return true
    const { credential: _credential, ...rest } = persisted(target)
    const replacement = persistedConnectionTargetSchema.safeParse({ ...rest, ...proof.data.credential ? { credential: proof.data.credential } : {} })
    if (!replacement.success) return false
    this.replace(target.id, replacement.data, target.lifecycle)
    return true
  }

  /** Only authoritative loss of this exact transport may invalidate its binding; unrelated targets stay live. */
  markHandleLost(handle: BackendConnectionHandle, reason: ConnectionFailureReason = 'network'): boolean {
    const parsed = backendConnectionHandleSchema.safeParse(handle)
    if (!parsed.success) return false
    const lifecycle = connectionLifecycleSchema.parse({ state: 'lost', reason })
    const target = this.getSnapshot().find(value => (value.lifecycle.state === 'connected' || value.lifecycle.state === 'disconnecting') && value.lifecycle.handle.id === parsed.data.id && value.lifecycle.handle.generation === parsed.data.generation)
    if (!target) return false
    this.operations.delete(target.id)
    this.replace(target.id, persisted(target), lifecycle)
    return true
  }

  /** Calling this means the user has chosen to connect; startup checks shouldAutoReconnect before calling it. */
  beginConnect(id: string, generation: number, attemptId: string, credentialIntent: ConnectionCredentialIntent = 'preserve'): ConnectionOperation | undefined {
    const target = this.get(id)
    if (!target || !validGeneration(generation) || generation !== this.generation) return undefined
    if (target.lifecycle.state === 'connecting') {
      const current = this.operations.get(id)
      return current?.kind === 'connect' && current.credentialIntent === credentialIntent ? current : undefined
    }
    if (target.lifecycle.state === 'connected' || target.lifecycle.state === 'disconnecting') return undefined
    const lifecycle = connectionLifecycleSchema.parse({ state: 'connecting', attemptId })
    if (credentialIntent !== 'preserve' && credentialIntent !== 'update-credentials') return undefined
    const operation = this.begin(id, attemptId, generation, 'connect', credentialIntent)
    this.replace(id, { ...persisted(target), inExplorer: true, resumeWanted: true }, lifecycle)
    return operation
  }

  /** Authentication is main-verified evidence, never a request from an untrusted renderer or a form's username. */
  completeConnect(operation: ConnectionOperation, handle: BackendConnectionHandle, authentication: ConnectionAuthentication): ConnectionCompletion {
    const parsed = backendConnectionHandleSchema.parse(handle)
    const owner = this.getSnapshot().find(target => {
      const state = target.lifecycle
      return (state.state === 'connected' || state.state === 'disconnecting') && state.handle.id === parsed.id && state.handle.generation === parsed.generation
    })
    if (owner) return owner.id === operation.targetId ? { status: 'already-current' } : { status: 'in-use', targetId: owner.id }
    if (!this.matches(operation, 'connect') || operation.kind !== 'connect' || parsed.generation !== operation.generation) return { status: 'stale', dispose: parsed }
    const target = this.get(operation.targetId)!
    const proof = connectionAuthenticationSchema.safeParse(authentication)
    let reason: ConnectionFailureReason | undefined
    if (!proof.success) reason = 'unknown'
    else {
      const expected = target.expectedPrincipal, actual = proof.data.principal
      if (actual.authentication !== target.options.authentication || (expected && (expected.provider !== actual.provider || expected.authentication !== actual.authentication || expected.id !== actual.id))) reason = 'identity-changed'
      if (!reason && operation.credentialIntent === 'preserve' && proof.data.credential !== undefined) {
        const current = target.credential, next = proof.data.credential
        if ((current && (!next || current.profileId !== next.profileId || current.revision !== next.revision)) || (!current && target.expectedPrincipal && next)) reason = 'credentials-required'
      }
    }
    if (reason || !proof.success) {
      this.operations.delete(target.id)
      this.replace(target.id, persisted(target), { state: 'disconnected', reason: reason ?? 'unknown' })
      return { status: 'rejected', reason: reason ?? 'unknown', dispose: parsed }
    }
    const { credential: oldCredential, ...rest } = persisted(target)
    const credential = proof.data.credential === undefined ? oldCredential : operation.credentialIntent === 'update-credentials' || !target.expectedPrincipal ? proof.data.credential ?? undefined : oldCredential
    const replacement = persistedConnectionTargetSchema.safeParse({ ...rest, expectedPrincipal: proof.data.principal, ...credential ? { credential } : {} })
    if (!replacement.success) {
      this.operations.delete(target.id)
      this.replace(target.id, persisted(target), { state: 'disconnected', reason: 'unknown' })
      return { status: 'rejected', reason: 'unknown', dispose: parsed }
    }
    this.operations.delete(target.id)
    this.bindingRevisions.delete(target.id)
    this.replace(target.id, replacement.data, { state: 'connected', handle: parsed })
    return { status: 'accepted' }
  }

  failConnect(operation: ConnectionOperation, reason: ConnectionFailureReason): boolean {
    if (!this.matches(operation, 'connect')) return false
    const target = this.get(operation.targetId)!, lifecycle = connectionLifecycleSchema.parse({ state: 'disconnected', reason })
    this.operations.delete(target.id)
    this.replace(target.id, persisted(target), lifecycle)
    return true
  }

  cancelConnect(id: string): boolean {
    const target = this.get(id)
    if (!target || target.lifecycle.state !== 'connecting') return false
    this.operations.delete(id)
    this.replace(id, { ...persisted(target), resumeWanted: false }, { state: 'disconnected', reason: 'cancelled' })
    return true
  }

  /** The disconnect coordinator calls this only after its complete save/session preflight has succeeded. */
  beginDisconnect(id: string, attemptId: string): ConnectionOperation | undefined {
    const target = this.get(id)
    if (!target || target.lifecycle.state !== 'connected' || target.lifecycle.handle.generation !== this.generation) return undefined
    const lifecycle = connectionLifecycleSchema.parse({ state: 'disconnecting', attemptId, handle: target.lifecycle.handle })
    const operation = this.begin(id, attemptId, this.generation, 'disconnect')
    this.replace(id, { ...persisted(target), resumeWanted: false }, lifecycle)
    return operation
  }

  completeDisconnect(operation: ConnectionOperation): boolean {
    if (!this.matches(operation, 'disconnect')) return false
    const target = this.get(operation.targetId)!
    this.operations.delete(target.id)
    this.replace(target.id, persisted(target), { state: 'disconnected' })
    return true
  }

  failDisconnect(operation: ConnectionOperation): boolean {
    if (!this.matches(operation, 'disconnect')) return false
    const target = this.get(operation.targetId)!
    if (target.lifecycle.state !== 'disconnecting') return false
    this.operations.delete(target.id)
    this.replace(target.id, persisted(target), { state: 'connected', handle: target.lifecycle.handle })
    return true
  }

  /** A live target must be disconnected before removal. Pending connects are cancelled without forgetting query refs. */
  removeFromExplorer(id: string): boolean {
    const target = this.get(id)
    if (!target || target.lifecycle.state === 'connected' || target.lifecycle.state === 'disconnecting') return false
    this.operations.delete(id)
    const lifecycle: ConnectionLifecycle = target.lifecycle.state === 'connecting' ? { state: 'disconnected', reason: 'cancelled' } : target.lifecycle
    this.replace(id, { ...persisted(target), inExplorer: false, resumeWanted: false }, lifecycle)
    return true
  }

  reveal(id: string): boolean {
    const target = this.get(id)
    if (!target) return false
    this.replace(id, { ...persisted(target), inExplorer: true }, target.lifecycle)
    return true
  }

  /** Call with every document's remembered target, including deliberately disconnected queries and custom drafts. */
  pruneUnreferenced(references: ReadonlySet<string>): readonly string[] {
    const removed = this.getSnapshot().filter(target => !target.inExplorer && !references.has(target.id) && ['disconnected', 'lost'].includes(target.lifecycle.state)).map(target => target.id)
    if (removed.length) {
      const ids = new Set(removed)
      for (const id of ids) { this.operations.delete(id); this.bindingRevisions.delete(id) }
      this.publish(Object.freeze(this.getSnapshot().filter(target => !ids.has(target.id))))
    }
    return Object.freeze(removed)
  }

  markLostBefore(generation: number): void {
    if (!validGeneration(generation) || generation <= this.generation) return
    this.generation = generation
    let changed = false
    const targets = this.getSnapshot().map(target => {
      const lifecycle = target.lifecycle, operation = this.operations.get(target.id)
      const handle = lifecycle.state === 'connected' || lifecycle.state === 'disconnecting' ? lifecycle.handle : undefined
      if (!(handle && handle.generation < generation) && !(operation && operation.generation < generation)) return target
      this.operations.delete(target.id)
      changed = true
      return entry(persisted(target), { state: 'lost', reason: 'backend-lost' })
    })
    if (changed) this.publish(Object.freeze(targets))
  }

  dispose(): void {
    this.clearListeners()
    this.operations.clear()
    this.bindingRevisions.clear()
    this.publish(Object.freeze([]))
  }

  private begin(targetId: string, attemptId: string, generation: number, kind: ConnectionOperation['kind'], credentialIntent: ConnectionCredentialIntent = 'preserve'): ConnectionOperation {
    const base = { targetId, attemptId, generation, revision: ++this.revision }
    const operation: ConnectionOperation = kind === 'connect' ? Object.freeze({ ...base, kind, credentialIntent }) : Object.freeze({ ...base, kind })
    this.operations.set(targetId, operation)
    return operation
  }

  private matches(operation: ConnectionOperation, kind: ConnectionOperation['kind']): boolean {
    const current = this.operations.get(operation.targetId), state = this.get(operation.targetId)?.lifecycle.state
    return !!current && current.kind === kind && operation.kind === kind && current.revision === operation.revision &&
      current.attemptId === operation.attemptId && current.generation === operation.generation && operation.generation === this.generation &&
      (current.kind !== 'connect' || (operation.kind === 'connect' && current.credentialIntent === operation.credentialIntent)) &&
      state === (kind === 'connect' ? 'connecting' : 'disconnecting')
  }

  private replace(id: string, target: PersistedConnectionTarget, lifecycle: ConnectionLifecycle): void {
    const replacement = entry(target, lifecycle)
    this.publish(Object.freeze(this.getSnapshot().map(current => current.id === id ? replacement : current)))
  }
}
