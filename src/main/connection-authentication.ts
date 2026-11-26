import { randomUUID } from 'node:crypto'
import {
  bigQueryTargetOptions, connectionAuthenticationSchema, connectionTargetLimits, connectionTargetOptions, connectionWorkspaceSchema, targetOptionsOf,
  type ConnectionAuthentication, type ConnectionTargetOptions, type ConnectionWorkspace, type PersistedConnectionTarget
} from '../shared/connection-targets'
import type { ConnectContext } from '../shared/connections'
import type { ConnectionOptions, ProviderConnectionOptions } from '../shared/contracts'
import { advancedDefaults } from '../shared/connections'

type Pin = Pick<PersistedConnectionTarget, 'id' | 'options' | 'expectedPrincipal' | 'credential'>
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const settings = (options: ProviderConnectionOptions | ConnectionTargetOptions) => {
  // A BigQuery pin never matches SQL Server options: each provider's settings name the provider first, and BigQuery's
  // drop their labels in the schema's key order.
  if (options.provider === 'bigquery') return ['bigquery', bigQueryTargetOptions(options)]
  const clean = connectionTargetOptions(options as ConnectionOptions)
  return [clean.server, clean.database, clean.authentication, clean.username ?? '', clean.encrypt ?? 'mandatory', clean.trustServerCertificate,
    clean.hostNameInCertificate ?? '', Object.keys(advancedDefaults).sort().map(key => [key, clean.advanced?.[key as keyof typeof advancedDefaults] ?? advancedDefaults[key as keyof typeof advancedDefaults]]),
    clean.advanced?.commandTimeout === undefined ? ['inherit'] : ['explicit', clean.advanced.commandTimeout]]
}
const sameSettings = (left: ProviderConnectionOptions | ConnectionTargetOptions, right: ProviderConnectionOptions | ConnectionTargetOptions) => equal(settings(left), settings(right))
const different = () => new Error('The remembered target identity changed. Choose a connection explicitly.')

/** Security evidence only. The renderer registry remains the sole owner of lifecycle, intent and Explorer membership. */
export class ConnectionAuthenticationGuard {
  private readonly pins = new Map<string, Pin>()
  private version = 0

  get revision(): number { return this.version }

  /** Only main's strict disk checkpoint reader calls restore; renderer snapshots must go through project instead. */
  restore(workspace: ConnectionWorkspace): void {
    for (const target of connectionWorkspaceSchema.parse(workspace).targets) {
      if (this.pins.has(target.id)) continue
      if (this.pins.size >= connectionTargetLimits.targets) throw new Error('Too many remembered connection identities.')
      this.pins.set(target.id, Object.freeze({ id: target.id, options: target.options, ...(target.expectedPrincipal ? { expectedPrincipal: target.expectedPrincipal } : {}), ...(target.credential ? { credential: target.credential } : {}) }))
      this.version++
    }
  }

  resolve(id: string): Readonly<Pin> | undefined { return this.pins.get(id) }

  /** The reuse owner calls this only after pruning a target with no documents, live transport or pending attempt. */
  forget(id: string): void { if (this.pins.delete(id)) this.version++ }

  /** Main's restored workspace and current request owners define which previous-page pins are still reachable. */
  retain(targetIds: ReadonlySet<string>): void {
    for (const id of this.pins.keys()) if (!targetIds.has(id)) this.forget(id)
  }

  prepare(options: ProviderConnectionOptions, context: ConnectContext = {}): ConnectContext {
    const targetId = context.targetId ?? randomUUID(), pin = this.pins.get(targetId)
    if (!pin) {
      if (context.mode === 'background') throw new Error('Choose this target explicitly before reconnecting it.')
      return { ...context, targetId }
    }
    const password = options.provider === 'bigquery' ? undefined : options.password
    const typedUpdate = context.mode !== 'background' && context.credentialIntent === 'update-credentials' && !!password
    if (!sameSettings(pin.options, options)
      || context.expectedPrincipal && !equal(context.expectedPrincipal, pin.expectedPrincipal)
      || context.credential && !equal(context.credential, pin.credential) && !typedUpdate) throw different()
    if (pin.expectedPrincipal && password && context.credentialIntent !== 'update-credentials') throw new Error('Use Update Credentials to replace this target credential.')
    if (context.mode === 'background' && !pin.expectedPrincipal) throw new Error('Reconnect requires the previous authenticated account.')
    // A confirmed mutation may advance main's pin while a lost generation prevents the renderer update. An explicit
    // typed recovery uses that current pin; it never substitutes settings, principal evidence or a saved secret.
    return { ...context, targetId, expectedPrincipal: pin.expectedPrincipal, credential: pin.credential }
  }

  /** Called after main verified the server's actual account, before exposing its result to the renderer. */
  remember(id: string, options: ProviderConnectionOptions, value: ConnectionAuthentication, intent: ConnectContext['credentialIntent'] = 'preserve'): { established: boolean } {
    const authentication = connectionAuthenticationSchema.parse(value), pin = this.pins.get(id), clean = targetOptionsOf(options)

    if (pin && (!sameSettings(pin.options, clean) || pin.expectedPrincipal && !equal(pin.expectedPrincipal, authentication.principal))) throw different()
    if (pin?.expectedPrincipal && intent !== 'update-credentials' && authentication.credential !== undefined && !equal(authentication.credential, pin.credential)) throw different()
    if (!pin && this.pins.size >= connectionTargetLimits.targets) throw new Error('Too many remembered connection identities.')
    const credential = authentication.credential === undefined || pin?.credential && intent !== 'update-credentials' ? pin?.credential : authentication.credential ?? undefined
    const next = Object.freeze({ id, options: clean, expectedPrincipal: authentication.principal, ...(credential ? { credential } : {}) })
    if (!equal(pin, next)) { this.pins.set(id, next); this.version++ }
    return { established: !pin?.expectedPrincipal }
  }

  /** Only an exact-handle backend mutation receipt may change a pinned initial database or remembered reference. */
  rebind(id: string, previous: ConnectionOptions, options: ConnectionOptions, value: ConnectionAuthentication): void {
    const pin = this.pins.get(id), authentication = connectionAuthenticationSchema.parse(value), clean = connectionTargetOptions(options)
    if (!pin || !sameSettings(pin.options, previous) || !sameSettings({ ...clean, database: previous.database }, previous) || !equal(pin.expectedPrincipal, authentication.principal)) throw different()
    const next = Object.freeze({ id, options: clean, expectedPrincipal: authentication.principal, ...authentication.credential ? { credential: authentication.credential } : {} })
    if (!equal(pin, next)) { this.pins.set(id, next); this.version++ }
  }

  /** Renderer writes can change presentation and intent, never the destination or authenticated identity of a pin. */
  project(workspace: ConnectionWorkspace): ConnectionWorkspace {
    const parsed = connectionWorkspaceSchema.parse(workspace)
    return connectionWorkspaceSchema.parse({ ...parsed, targets: parsed.targets.map(target => {
      const pin = this.pins.get(target.id)
      const { expectedPrincipal: _principal, credential: _credential, ...other } = target
      return pin ? { ...other, options: pin.options, ...(pin.expectedPrincipal ? { expectedPrincipal: pin.expectedPrincipal } : {}), ...(pin.credential ? { credential: pin.credential } : {}) } : other
    }) })
  }
}
