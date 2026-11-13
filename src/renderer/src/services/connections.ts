import type { ConnectionInfo, ConnectionOptions } from '../../../shared/contracts'
import { connectionAuthenticationSchema, connectionDetailsSchema, connectionTargetOptions, type ConnectionAuthentication, type ConnectionDetails, type ConnectionLifecycle, type ConnectionFailureReason } from '../../../shared/connection-targets'
import { SnapshotStore } from '../core/store'
import { ConnectionTargetService, type ConnectionCompletion, type ConnectionCredentialIntent, type ConnectionOperation } from './connection-targets'

/** Connection settings without the password, which the renderer never keeps: a reconnect asks for it again, unless main
 *  remembers one for the same credentials (Remember password) and fills it in itself. */
export type SavedOptions = Omit<ConnectionOptions, 'password'>
/** A connection Object Explorer shows. `lost` means its backend generation ended; only Reconnect replaces it. */
export interface LiveConnection extends ConnectionInfo {
  readonly options: SavedOptions
  readonly targetId?: string
  readonly inExplorer?: boolean
  readonly lost?: true
  readonly lifecycle?: ConnectionLifecycle
}
/** Main supplies both fields after authenticated adoption/reuse. No renderer equality key crosses this seam. */
export interface TargetConnectionInfo extends ConnectionInfo { readonly targetId?: string; readonly authentication?: ConnectionAuthentication }
export interface ConnectionAttempt { readonly operation: ConnectionOperation; readonly created: boolean; readonly targetEpochs: ReadonlyMap<string, number> }

function withoutPassword(options: ConnectionOptions): SavedOptions {
  const saved: ConnectionOptions = { ...options }
  delete saved.password
  return saved
}

// The registry owns adopted targets. The legacy lane remains until the connect IPC owner supplies verified receipts.
export class ConnectionService extends SnapshotStore<readonly LiveConnection[]> {
  /** Connections from generations before this one are lost. */
  private liveGeneration = 0
  private legacy: readonly LiveConnection[] = []
  private readonly metadata = new Map<string, ConnectionInfo>()
  private readonly legacyDetails = new Map<string, ConnectionDetails>()
  private readonly targetEpochs = new Map<string, number>()
  private readonly targetStates = new Map<string, string>()
  private targetRevision = 0
  private readonly unsubscribe: () => void
  constructor(readonly connectionTargets = new ConnectionTargetService()) {
    super([])
    this.unsubscribe = connectionTargets.subscribe(() => this.refresh())
  }
  get(id: string): LiveConnection | undefined { return this.getSnapshot().find(connection => connection.id === id || connection.targetId === id) }
  /** Connections that can still run queries. */
  live(): LiveConnection[] { return this.getSnapshot().filter(connection => this.isLive(connection.id)) }
  /** The connection is still there and was not lost with its backend generation. */
  isLive(id: string): boolean { const connection = this.get(id); return !!connection && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected') }
  add(info: ConnectionInfo, options: ConnectionOptions): void {
    if (this.getSnapshot().some(connection => connection.id === info.id && connection.generation === info.generation)) return
    this.legacy = [...this.legacy, { ...this.entry(info, options), targetId: crypto.randomUUID(), inExplorer: true }]
    this.refresh()
  }
  beginConnect(options: ConnectionOptions, generation: number, targetId: string = crypto.randomUUID(), details = detailsOf(options), credentialIntent: ConnectionCredentialIntent = 'preserve'): ConnectionAttempt | undefined {
    this.markLostBefore(generation)
    const registry = this.connectionTargets, created = !registry.get(targetId)
    if (created && !registry.add({ id: targetId, options: connectionTargetOptions(options), details, inExplorer: true, resumeWanted: true })) return undefined
    const operation = registry.beginConnect(targetId, generation, crypto.randomUUID(), credentialIntent)
    if (!operation && created) { registry.removeFromExplorer(targetId); registry.pruneUnreferenced(new Set(registry.getSnapshot().filter(target => target.id !== targetId).map(target => target.id))) }
    return operation ? { operation, created, targetEpochs: new Map(this.targetEpochs) } : undefined
  }
  cancelAttempt(attempt: ConnectionAttempt): void {
    const { operation } = attempt, registry = this.connectionTargets
    if (registry.operation(operation.targetId) !== operation) return
    registry.cancelConnect(operation.targetId)
    if (attempt.created) { registry.removeFromExplorer(operation.targetId); registry.pruneUnreferenced(new Set(registry.getSnapshot().filter(target => target.id !== operation.targetId).map(target => target.id))) }
  }
  failAttempt(attempt: ConnectionAttempt, reason: ConnectionFailureReason = 'unknown'): void {
    const registry = this.connectionTargets, { operation } = attempt
    if (registry.operation(operation.targetId) !== operation) return
    registry.failConnect(operation, reason)
    if (attempt.created) { registry.removeFromExplorer(operation.targetId); registry.pruneUnreferenced(new Set(registry.getSnapshot().filter(target => target.id !== operation.targetId).map(target => target.id))) }
  }
  /** Adopts only a main-verified target receipt; settings or a form's requested user never establish equivalence. */
  accept(info: ConnectionInfo, _options: ConnectionOptions, targetId: string, authentication: ConnectionAuthentication, attempt?: ConnectionAttempt): ConnectionCompletion {
    if (info.generation < this.liveGeneration) return { status: 'stale', dispose: { id: info.id, generation: info.generation } }
    this.markLostBefore(info.generation)
    const registry = this.connectionTargets
    const current = registry.get(targetId)
    const proof = connectionAuthenticationSchema.safeParse(authentication)
    if (!proof.success) {
      const owner = this.getSnapshot().find(value => this.isLive(value.id) && value.id === info.id && value.generation === info.generation)
      return owner?.targetId ? { status: 'in-use', targetId: owner.targetId } : { status: 'rejected', reason: 'unknown', dispose: { id: info.id, generation: info.generation } }
    }
    let operation = attempt?.operation
    const validAttempt = operation && registry.operation(operation.targetId) === operation && operation.generation === info.generation
    const lifecycle = current?.lifecycle
    if (attempt && !validAttempt) return lifecycle?.state === 'connected' && lifecycle.handle.id === info.id && lifecycle.handle.generation === info.generation
      ? { status: 'in-use', targetId } : { status: 'stale', dispose: { id: info.id, generation: info.generation } }
    if (lifecycle?.state === 'connected' && lifecycle.handle.id === info.id && lifecycle.handle.generation === info.generation) {
      if (attempt) this.cancelAttempt(attempt)
      registry.reveal(targetId)
      return { status: 'already-current' }
    }
    if (!current || !validAttempt || !operation) return { status: 'stale', dispose: { id: info.id, generation: info.generation } }
    if (operation.targetId !== targetId) {
      // Main found an offline equivalent. It must have existed when this caller started and stayed untouched by
      // lifecycle/removal operations. Presentation edits alone do not invalidate authentication.
      if (!attempt || attempt.targetEpochs.get(targetId) !== this.targetEpochs.get(targetId) || !['disconnected', 'lost'].includes(current.lifecycle.state)) return { status: 'stale', dispose: { id: info.id, generation: info.generation } }
      this.cancelAttempt(attempt)
      operation = registry.beginConnect(targetId, info.generation, crypto.randomUUID())
      if (!operation) return { status: 'stale', dispose: { id: info.id, generation: info.generation } }
    }
    // Main's explicit vault intent can update only the credential reference after the account/handle is accepted.
    // Omitting it from the first completion preserves the old reference until same-principal reconciliation succeeds.
    const result = registry.completeConnect(operation, { id: info.id, generation: info.generation }, info.credentialUpdated ? { principal: proof.data.principal } : proof.data)
    if (result.status === 'accepted' || result.status === 'already-current') {
      if (info.credentialUpdated) registry.reconcileAuthentication({ id: info.id, generation: info.generation }, proof.data)
      this.metadata.set(targetId, info)
      this.legacyDetails.delete(targetId)
      this.legacy = this.legacy.filter(connection => connection.targetId !== targetId && (connection.id !== info.id || connection.generation !== info.generation))
      registry.reveal(targetId)
      this.refresh()
    }
    return result
  }
  /** After a reconnect, the new connection takes the lost one's place in Object Explorer. */
  replace(oldId: string, info: ConnectionInfo, options: ConnectionOptions): void {
    const entry = { ...this.entry(info, options), targetId: this.get(oldId)?.targetId ?? crypto.randomUUID(), inExplorer: true }, current = this.legacy
    this.legacy = current.some(connection => connection.id === oldId) ? current.map(connection => connection.id === oldId ? entry : connection) : [...current, entry]
    this.refresh()
  }
  /** Labels this exact target. A saved profile is not proof that another target has the same credentials/settings. */
  relabel(id: string, environment: string | undefined): SavedOptions | undefined {
    const target = this.get(id)
    if (!target) return undefined
    const label = (options: SavedOptions): SavedOptions => { const next = { ...options }; if (environment) next.environment = environment; else delete next.environment; return next }
    if (target.targetId && this.connectionTargets.get(target.targetId)) this.connectionTargets.setDetails(target.targetId, { ...this.connectionTargets.get(target.targetId)!.details, environment })
    else {
      this.legacyDetails.set(target.targetId ?? target.id, { ...this.details(id)!, environment })
      this.legacy = this.legacy.map(connection => connection === target ? { ...connection, environment, options: label(connection.options) } : connection)
      this.refresh()
    }
    return label(target.options)
  }
  /**
   * A database was renamed: each of `ids` whose home database it was (compared as the backend's DatabaseChanged does, ignoring
   * case) now opens in `newName`, as the backend has moved it there. The saved options keep what the user connected with.
   */
  rehome(ids: ReadonlySet<string>, database: string, newName: string): void {
    const key = database.toLowerCase(), current = this.legacy
    if (current.some(connection => ids.has(connection.id) && connection.database.toLowerCase() === key))
      { this.legacy = current.map(connection => ids.has(connection.id) && connection.database.toLowerCase() === key ? { ...connection, database: newName } : connection); this.refresh() }
    for (const [targetId, info] of this.metadata) if (ids.has(info.id) && info.database.toLowerCase() === key) this.metadata.set(targetId, { ...info, database: newName })
    this.refresh()
  }
  /** Membership removal leaves hidden targets resolvable by their attached documents. */
  remove(id: string): void {
    const connection = this.get(id)
    if (connection?.targetId && this.connectionTargets.get(connection.targetId)) this.connectionTargets.removeFromExplorer(connection.targetId)
    else { this.legacyDetails.delete(connection?.targetId ?? id); this.legacy = this.legacy.filter(connection => connection.id !== id); this.refresh() }
  }
  disconnected(id: string): void {
    const connection = this.get(id)
    if (!connection) return
    if (connection.targetId && this.connectionTargets.get(connection.targetId)) {
      const operation = this.connectionTargets.beginDisconnect(connection.targetId, crypto.randomUUID())
      if (operation) this.connectionTargets.completeDisconnect(operation)
    } else { this.legacy = this.legacy.map(value => value === connection ? { ...value, lost: true } : value); this.refresh() }
  }
  setDetails(id: string, details: ConnectionDetails): boolean {
    const connection = this.get(id), parsed = connectionDetailsSchema.parse(details)
    if (!connection) return false
    if (connection.targetId && this.connectionTargets.get(connection.targetId)) return this.connectionTargets.setDetails(connection.targetId, parsed)
    this.legacyDetails.set(connection.targetId ?? connection.id, parsed)
    const presentation = { displayName: parsed.displayName, color: parsed.color, environment: parsed.environment }
    this.legacy = this.legacy.map(value => value === connection ? { ...value, ...presentation, options: { ...value.options, ...presentation } } : value)
    this.refresh()
    return true
  }
  details(id: string): ConnectionDetails | undefined {
    const connection = this.get(id)
    return connection ? (connection.targetId ? this.connectionTargets.get(connection.targetId)?.details : undefined) ?? this.legacyDetails.get(connection.targetId ?? connection.id) ?? detailsOf(connection.options) : undefined
  }
  /** The backend moved on to `generation`: every connection held by an earlier one is gone with its process. */
  markLostBefore(generation: number): void {
    if (generation <= this.liveGeneration) return
    this.liveGeneration = generation
    this.connectionTargets.markLostBefore(generation)
    const current = this.legacy
    if (current.some(connection => !connection.lost && connection.generation < generation)) {
      this.legacy = current.map(connection => !connection.lost && connection.generation < generation ? { ...connection, lost: true } : connection)
      this.refresh()
    }
  }
  private entry(info: ConnectionInfo, options: ConnectionOptions): LiveConnection {
    // An answer can arrive after the push that ended its generation.
    return { ...info, options: withoutPassword(options), ...info.generation < this.liveGeneration ? { lost: true } : {} }
  }
  private refresh(): void {
    const targets = this.connectionTargets.getSnapshot(), ids = new Set(targets.map(target => target.id))
    for (const id of this.targetStates.keys()) if (!ids.has(id)) { this.targetStates.delete(id); this.targetEpochs.delete(id); this.metadata.delete(id) }
    const adopted = targets.map(target => {
      const { details: _details, ...state } = target, encoded = JSON.stringify(state)
      if (this.targetStates.get(target.id) !== encoded) { this.targetStates.set(target.id, encoded); this.targetEpochs.set(target.id, ++this.targetRevision) }
      const info = this.metadata.get(target.id) ?? this.legacy.find(connection => connection.targetId === target.id), lifecycle = target.lifecycle
      const live = lifecycle.state === 'connected' || lifecycle.state === 'disconnecting'
      const { autoReconnect: _autoReconnect, ...presentation } = target.details
      return {
        ...info, id: live ? lifecycle.handle.id : info?.id ?? target.id, generation: live ? lifecycle.handle.generation : info?.generation ?? this.liveGeneration,
        server: info?.server ?? target.options.server, database: info?.database ?? target.options.database, serverVersion: info?.serverVersion ?? '',
        displayName: target.details.displayName, color: target.details.color, environment: target.details.environment,
        login: info?.login ?? target.options.username, options: { ...target.options, ...presentation }, targetId: target.id, inExplorer: target.inExplorer, lifecycle,
        ...live ? {} : { lost: true as const }
      }
    })
    this.publish([...this.legacy.filter(connection => !connection.targetId || !ids.has(connection.targetId)), ...adopted])
  }
  dispose(): void { this.unsubscribe(); this.clearListeners(); this.metadata.clear(); this.legacyDetails.clear(); this.targetEpochs.clear(); this.targetStates.clear(); this.legacy = []; this.publish([]) }
}

export function detailsOf(options: SavedOptions, autoReconnect: ConnectionDetails['autoReconnect'] = 'inherit'): ConnectionDetails {
  return connectionDetailsSchema.parse({ displayName: options.displayName, color: options.color, environment: options.environment, autoReconnect })
}
