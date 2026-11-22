// The SQL Server Agent proxy document and the Credential document (AG-8b, docs/agent-plan.md › Alerts, operators, proxies, credentials,
// docs/agent-ui-rethink.md › rx-proxy, rx-credential). What their describes read, the drafts the documents edit, what Save sends, the problems
// they show and their commands. A proxy is one screen (General, Subsystems, Principals, References were SSMS's pages) whose credential can be
// created in place: Save runs CREATE CREDENTIAL, then sp_add_proxy or sp_update_proxy, then the subsystem grants and revokes, in one
// transaction, and then the principal grants and revokes without one (msdb's principal check dooms a user transaction). A credential's secret never enters a model, a draft or a snapshot: it lives in the renderer's secret slot, travels only in
// actions.execute's `secrets.secret`, and Script writes <secret>. ALTER CREDENTIAL resets the secret when it is sent without one, so an existing
// credential's Save always sends the identity and the secret together. Bounds are zod here and C# in ActionService.ValidateAgentProxy and
// ValidateCredential. No React here.
import { z } from 'zod'
import { agentLimits, subsystems, type AgentPlatform } from '../agent/catalog.ts'
import { ident } from '../explorer/schema.ts'
import { wellFormed } from '../ssis/schema.ts'

// --- Proxy model ---------------------------------------------------------------------------------------------------------

/** Who may use a proxy besides sysadmin: a login, a fixed server role, or an msdb database role (sysproxylogin). */
export type ProxyPrincipalKind = 'login' | 'serverRole' | 'msdbRole'
export const proxyPrincipalKinds = ['login', 'serverRole', 'msdbRole'] as const satisfies readonly ProxyPrincipalKind[]
export interface ProxyPrincipal { readonly name: string; readonly kind: ProxyPrincipalKind }
export const proxyPrincipalKindLabel: { readonly [K in ProxyPrincipalKind]: string } = { login: 'SQL Login', serverRole: 'Server Role', msdbRole: 'MSDB Role' }
/** A subsystem a proxy can be active to: `syssubsystems`' id and name (every one but TSQL, which runs as the job's owner). */
export interface ProxySubsystem { readonly id: number; readonly name: string }
/** A credential the proxy can run as, with the identity it holds (never its secret, which SQL Server does not return). */
export interface ProxyCredentialChoice { readonly name: string; readonly identity: string }
/** A job step that runs as the proxy (sysjobsteps joined to sysproxies; sysadmin reads them). */
export interface ProxyReference { readonly job: string; readonly stepId: number; readonly step: string; readonly subsystem: string }
/** The proxy as msdb holds it. `id` is the identity Save, Rename and Delete check the name against (sysproxies.proxy_id). */
export interface AgentProxyRecord {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  readonly description: string
  readonly credential: string
  readonly credentialIdentity?: string
  /** The `syssubsystems` ids it is active to. */
  readonly subsystems: readonly number[]
  readonly principals: readonly ProxyPrincipal[]
}
export interface AgentProxyDocumentModel {
  /** Absent for New Proxy. */
  readonly proxy?: AgentProxyRecord
  readonly platform: AgentPlatform
  readonly subsystems: readonly ProxySubsystem[]
  readonly credentials: readonly ProxyCredentialChoice[]
  readonly credentialsTruncated: boolean
  /** Whether the login may create a credential in place (ALTER ANY CREDENTIAL; sysadmin has it). */
  readonly canCreateCredential: boolean
  /** Logins, fixed server roles and msdb roles the principal picker offers; a name can still be typed. */
  readonly principalChoices: readonly ProxyPrincipal[]
  /** Job steps that run as this proxy; absent for New Proxy. */
  readonly references?: readonly ProxyReference[]
  readonly referencesTruncated?: boolean
  /** The proxy has more principals than the document lists (agentLimits.proxyPrincipals); the rest are not shown. */
  readonly principalsTruncated?: boolean
}

export const agentProxyFields = ['name', 'enabled', 'description', 'credential', 'subsystems', 'principals'] as const
export type AgentProxyField = typeof agentProxyFields[number]

export interface AgentProxyDraft {
  readonly name: string
  readonly enabled: boolean
  readonly description: string
  /** Use an existing credential, or create one when the proxy is saved (its secret is in the secret slot). */
  readonly credentialMode: 'existing' | 'new'
  readonly credential: string
  readonly newCredentialName: string
  readonly newCredentialIdentity: string
  readonly subsystems: readonly number[]
  readonly principals: readonly ProxyPrincipal[]
}

/** The draft a describe opens with: the proxy as read, or New Proxy's blank (enabled, active to `subsystem` when opened from its folder). */
export function initialAgentProxyDraft(model: Pick<AgentProxyDocumentModel, 'proxy' | 'subsystems' | 'credentials' | 'canCreateCredential'>, subsystem?: string): AgentProxyDraft {
  const proxy = model.proxy
  if (!proxy) {
    const preset = subsystem === undefined ? undefined : model.subsystems.find(item => item.name.toLowerCase() === subsystem.toLowerCase())
    return {
      name: '', enabled: true, description: '', credentialMode: model.credentials.length || !model.canCreateCredential ? 'existing' : 'new', credential: '', newCredentialName: '', newCredentialIdentity: '',
      subsystems: preset ? [preset.id] : [], principals: []
    }
  }
  return {
    name: proxy.name, enabled: proxy.enabled, description: proxy.description, credentialMode: 'existing', credential: proxy.credential, newCredentialName: '', newCredentialIdentity: '',
    subsystems: [...proxy.subsystems].sort((a, b) => a - b), principals: proxy.principals
  }
}

const principalKey = (principal: ProxyPrincipal) => `${principal.kind}:${principal.name}`
const sortedIds = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(',')
function proxyFieldValue(draft: AgentProxyDraft, field: AgentProxyField): string {
  switch (field) {
    case 'name': return draft.name
    case 'enabled': return String(draft.enabled)
    case 'description': return draft.description
    case 'credential': return draft.credentialMode === 'new' ? `new:${draft.newCredentialName}\n${draft.newCredentialIdentity}` : `existing:${draft.credential}`
    case 'subsystems': return sortedIds(draft.subsystems)
    case 'principals': return draft.principals.map(principalKey).sort().join('\n')
  }
}
/** The fields the draft changed from `base` (the proxy as read; New Proxy's blank). */
export function changedAgentProxyFields(base: AgentProxyDraft, draft: AgentProxyDraft): AgentProxyField[] {
  return agentProxyFields.filter(field => proxyFieldValue(base, field) !== proxyFieldValue(draft, field))
}
/** "Save · n changes": each changed field, each subsystem and each principal granted or revoked. */
export function agentProxyChangeCount(base: AgentProxyDraft, draft: AgentProxyDraft): number {
  return changedAgentProxyFields(base, draft).reduce((count, field) => {
    if (field === 'subsystems') return count + draft.subsystems.filter(id => !base.subsystems.includes(id)).length + base.subsystems.filter(id => !draft.subsystems.includes(id)).length
    if (field === 'principals') {
      const before = new Set(base.principals.map(principalKey)), after = new Set(draft.principals.map(principalKey))
      return count + [...after].filter(key => !before.has(key)).length + [...before].filter(key => !after.has(key)).length
    }
    return count + 1
  }, 0)
}

// --- What a proxy's Save sends -----------------------------------------------------------------------------------------------

/** A credential the proxy save creates first: its name and identity; the secret goes in the request's `secrets.secret`. */
export interface NewCredentialSpec { readonly name: string; readonly identity: string }
/** What Save sends. An existing proxy's names only what changed, under its id (the request's `proxyId`); New Proxy's has a name and a
 *  credential (an existing one, or `newCredential`), and grants only. */
export interface AgentProxySave {
  readonly name?: string
  readonly enabled?: boolean
  readonly description?: string
  readonly credential?: string
  readonly newCredential?: NewCredentialSpec
  readonly grantSubsystems?: readonly number[]
  readonly revokeSubsystems?: readonly number[]
  readonly grantPrincipals?: readonly ProxyPrincipal[]
  /** Revoked by name, as sp_revoke_login_from_proxy takes them. */
  readonly revokePrincipals?: readonly string[]
}

/** The save the draft asks for: undefined when an existing proxy's draft changes nothing. */
/** The title of a proxy save's second step (the backend's ActionService.ProxyPrincipalsStep): its principal grants and revokes, without a transaction. */
export const proxyPrincipalsStep = 'Grant and revoke principals'
export function agentProxySave(model: AgentProxyDocumentModel, draft: AgentProxyDraft): AgentProxySave | undefined {
  const proxy = model.proxy
  const base = initialAgentProxyDraft(model)
  const fields = proxy ? changedAgentProxyFields(base, draft) : agentProxyFields
  if (proxy && fields.length === 0) return undefined
  const save: { -readonly [K in keyof AgentProxySave]: AgentProxySave[K] } = {}
  for (const field of fields) {
    switch (field) {
      // msdb keeps a proxy's name as given; a name cannot be blank, so surrounding blanks go.
      case 'name': save.name = draft.name.trim(); break
      case 'enabled': if (proxy || !draft.enabled) save.enabled = draft.enabled; break
      case 'description': if (proxy || draft.description) save.description = draft.description; break
      case 'credential':
        if (draft.credentialMode === 'new') save.newCredential = { name: draft.newCredentialName.trim(), identity: draft.newCredentialIdentity }
        else save.credential = draft.credential
        break
      case 'subsystems': {
        const grant = draft.subsystems.filter(id => !base.subsystems.includes(id)), revoke = base.subsystems.filter(id => !draft.subsystems.includes(id))
        if (grant.length) save.grantSubsystems = [...grant].sort((a, b) => a - b)
        if (revoke.length) save.revokeSubsystems = [...revoke].sort((a, b) => a - b)
        break
      }
      case 'principals': {
        const before = new Set(base.principals.map(principalKey)), after = new Set(draft.principals.map(principalKey))
        const grant = draft.principals.filter(principal => !before.has(principalKey(principal)))
        const revoke = base.principals.filter(principal => !after.has(principalKey(principal))).map(principal => principal.name)
        if (grant.length) save.grantPrincipals = grant
        if (revoke.length) save.revokePrincipals = revoke
        break
      }
    }
  }
  return save
}
/** A new credential goes with a secret (`secrets.secret`); nothing else in a proxy save does. */
export const agentProxySaveSendsSecret = (save: AgentProxySave): boolean => save.newCredential !== undefined

const nameSchema = ident
const description = z.string().max(agentLimits.descriptionChars).refine(value => !value.includes('\u0000'), 'A description cannot contain U+0000.')
const credentialIdentity = z.string().min(1).max(agentLimits.credentialIdentityChars).refine(value => !value.includes('\u0000'), 'An identity cannot contain U+0000.')
  .refine(wellFormed, 'The identity holds a broken character (half of a surrogate pair).')
const subsystemIds = z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(agentLimits.proxySubsystems)
const principalSchema = z.object({ name: nameSchema, kind: z.enum(proxyPrincipalKinds) }).strict() satisfies z.ZodType<ProxyPrincipal>
export const newCredentialSpecSchema = z.object({ name: nameSchema, identity: credentialIdentity }).strict() satisfies z.ZodType<NewCredentialSpec>
export const agentProxySaveSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  description: description.optional(),
  credential: nameSchema.optional(),
  newCredential: newCredentialSpecSchema.optional(),
  grantSubsystems: subsystemIds.optional(),
  revokeSubsystems: subsystemIds.optional(),
  grantPrincipals: z.array(principalSchema).min(1).max(agentLimits.proxyPrincipals).optional(),
  revokePrincipals: z.array(nameSchema).min(1).max(agentLimits.proxyPrincipals).optional()
}).strict() satisfies z.ZodType<AgentProxySave>
/** A proxy id (sysproxies.proxy_id). */
export const proxyIdSchema = z.number().int().min(1).max(2_147_483_647)

/** Why a proxy save cannot run whatever the server says (C#'s ValidateAgentProxy refuses the same). `create`: New Proxy (target the Agent
 *  node, no proxy id). New Proxy's has a name and exactly one credential and revokes nothing; an existing proxy's changes something. A
 *  subsystem or principal appears once, in one list. */
export function agentProxySaveProblems(save: AgentProxySave, create: boolean): string[] {
  const problems: string[] = []
  if (save.credential !== undefined && save.newCredential !== undefined) problems.push('A proxy runs as one credential.')
  if (create) {
    if (save.name === undefined) problems.push('A new proxy needs a name.')
    if (save.credential === undefined && save.newCredential === undefined) problems.push('A new proxy needs a credential.')
    if (save.revokeSubsystems !== undefined || save.revokePrincipals !== undefined) problems.push('A new proxy has nothing to revoke.')
  } else if (!Object.values(save).some(value => value !== undefined)) problems.push('There is nothing to change.')
  const ids = [...save.grantSubsystems ?? [], ...save.revokeSubsystems ?? []]
  if (new Set(ids).size !== ids.length) problems.push('A subsystem is granted or revoked twice.')
  const names = [...(save.grantPrincipals ?? []).map(principal => principal.name.toLowerCase()), ...(save.revokePrincipals ?? []).map(name => name.toLowerCase())]
  if (new Set(names).size !== names.length) problems.push('A principal is granted or revoked twice.')
  return problems
}

// --- Credential model -------------------------------------------------------------------------------------------------------

/** A credential as sys.credentials holds it. `modified` (to the millisecond) is what the STALE guard compares; the secret is never read. */
export interface CredentialRecord {
  readonly id: number
  readonly name: string
  readonly identity: string
  /** `yyyy-mm-ddThh:mm:ss`, server time. */
  readonly created: string
  /** `yyyy-mm-ddThh:mm:ss.fff`, server time. */
  readonly modified: string
  /** The cryptographic provider of an EKM credential. */
  readonly provider?: string
}
/** A proxy that runs as the credential, the subsystems it is active to, and the job steps that run as it. */
export interface CredentialUse { readonly proxy: string; readonly subsystems: readonly string[]; readonly steps: readonly { readonly job: string; readonly stepId: number; readonly step: string }[] }
export interface CredentialDocumentModel {
  /** Absent for New Credential. */
  readonly credential?: CredentialRecord
  readonly platform: 'box' | 'managedInstance'
  /** Why nothing can change: the login lacks ALTER ANY CREDENTIAL. The document opens read-only. */
  readonly readOnly?: string
  /** `sys.cryptographic_providers`' enabled providers; the Provider field is hidden when there are none. */
  readonly providers: readonly string[]
  /** Proxies (and their steps) that use the credential; absent when the login may not read msdb's proxy tables (below sysadmin). */
  readonly usedBy?: readonly CredentialUse[]
  readonly usedByTruncated?: boolean
}

export interface CredentialDraft {
  readonly name: string
  readonly identity: string
  /** "Change identity and password": an existing credential's identity and secret are read-only until it is checked, and Save sends both. */
  readonly change: boolean
  /** New Credential only: the cryptographic provider, '' for none. */
  readonly provider: string
}
export const credentialFields = ['name', 'identity', 'secret', 'provider'] as const
export type CredentialField = typeof credentialFields[number]

export function initialCredentialDraft(model: Pick<CredentialDocumentModel, 'credential'>): CredentialDraft {
  const credential = model.credential
  return credential ? { name: credential.name, identity: credential.identity, change: false, provider: credential.provider ?? '' } : { name: '', identity: '', change: true, provider: '' }
}

/** What a credential's Save sends besides the secret (`secrets.secret`, always): New Credential's name, identity and provider; an existing
 *  credential's id and modified date (the STALE guard) with its identity, which ALTER CREDENTIAL sends with the secret every time. */
export interface CredentialSave {
  readonly id?: number
  readonly modified?: string
  readonly name?: string
  readonly identity: string
  readonly provider?: string
}
/** The save the draft asks for: undefined when an existing credential's "Change identity and password" is not checked (nothing changes). */
export function credentialSave(model: CredentialDocumentModel, draft: CredentialDraft): CredentialSave | undefined {
  const credential = model.credential
  if (credential) return draft.change ? { id: credential.id, modified: credential.modified, identity: draft.identity } : undefined
  return { name: draft.name.trim(), identity: draft.identity, ...draft.provider ? { provider: draft.provider } : {} }
}
/** "Save · n changes": a new credential counts once; an existing one's change counts the identity (if changed) and the secret. */
export function credentialChangeCount(model: CredentialDocumentModel, draft: CredentialDraft): number {
  if (!model.credential) return draft.name.trim() ? 1 : 0
  return draft.change ? 1 + (draft.identity !== model.credential.identity ? 1 : 0) : 0
}

const modifiedPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/
export const credentialSaveSchema = z.object({
  id: z.number().int().min(1).max(2_147_483_647).optional(),
  modified: z.string().max(23).regex(modifiedPattern).refine(text => { const date = new Date(text + 'Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === text }, 'not a date').optional(),
  name: nameSchema.optional(),
  identity: credentialIdentity,
  provider: nameSchema.optional()
}).strict() satisfies z.ZodType<CredentialSave>
/** A credential's secret: at most agentLimits.credentialSecretChars UTF-16 code units, no NUL, well formed; never blank (ALTER CREDENTIAL
 *  would store an empty secret where the user meant to keep one). */
export const credentialSecret = z.string().min(1, 'A credential needs its secret.').refine(value => value.length <= agentLimits.credentialSecretChars, `At most ${agentLimits.credentialSecretChars} UTF-16 code units.`)
  .refine(value => !value.includes('\0'), 'The secret cannot contain a NUL character.').refine(wellFormed, 'The secret holds a broken character (half of a surrogate pair).')
export const credentialSecretsSchema = z.object({ secret: credentialSecret }).strict()

/** Why a credential save cannot run (C#'s ValidateCredential refuses the same). `create`: New Credential (target the server). New's names
 *  the credential and no id; an existing one's names its id and modified date and no name or provider (ALTER CREDENTIAL changes neither). */
export function credentialSaveProblems(save: CredentialSave, create: boolean): string[] {
  const problems: string[] = []
  if (create) {
    if (save.name === undefined) problems.push('A new credential needs a name.')
    if (save.id !== undefined || save.modified !== undefined) problems.push('A new credential has no identity to check.')
  } else {
    if (save.id === undefined || save.modified === undefined) problems.push("A credential's save names the version it read.")
    if (save.name !== undefined || save.provider !== undefined) problems.push("ALTER CREDENTIAL changes neither a credential's name nor its provider.")
  }
  return problems
}

// --- Problems ------------------------------------------------------------------------------------------------------------

/** What the documents know of their secret fields (the renderer's secret slot): never the values. */
export interface SecretFacts { readonly secret: 'empty' | 'set'; readonly matches: boolean; readonly wellFormed: boolean; readonly tooLong: boolean }
export const emptySecretFacts: SecretFacts = { secret: 'empty', matches: true, wellFormed: true, tooLong: false }

export interface AgentProxyProblem { readonly field: AgentProxyField; readonly severity: 'error' | 'warning'; readonly message: string }
export interface CredentialProblem { readonly field: CredentialField; readonly severity: 'error' | 'warning'; readonly message: string }

export const agentProxyText = {
  nameRequired: 'The proxy needs a name.',
  credentialRequired: 'Choose the credential the proxy runs as, or create one.',
  newCredentialName: 'The new credential needs a name.',
  newCredentialTaken: 'A credential of this name exists already: choose it under Use an existing one.',
  newCredentialIdentity: 'The new credential needs an identity: the Windows account its job steps run as.',
  descriptionTooLong: `A description holds at most ${agentLimits.descriptionChars} characters.`,
  noSubsystem: 'No job step can run as this proxy until it is active to a subsystem.',
  principalsTruncated: (count: number) => `Only the first ${count.toLocaleString('en-US')} principals are listed; manage the rest in a query.`,
  tooManyPrincipals: `A proxy's document lists at most ${agentLimits.proxyPrincipals.toLocaleString('en-US')} principals.`,
  sysadminOnly: 'Only sysadmin can create or change SQL Server Agent proxies.',
  noCredentialRight: 'Creating a credential needs ALTER ANY CREDENTIAL; choose an existing one.',
  batchRight: (identity: string) => `For CmdExec and PowerShell steps, ${identity || 'this Windows account'} needs “Log on as a batch job” on the server.`,
  windowsOnlyIdentity: 'A Windows account (DOMAIN\\user) on Windows; SQL Server cannot check it until a step runs as it.',
  newCredentialHint: 'Created when you save, in the same transaction as the proxy.',
  principalsHint: 'Logins, msdb roles and server roles that may use this proxy besides sysadmin.',
  principalsNone: 'Only sysadmin may use this proxy.',
  principalTwice: 'This principal may use the proxy already.',
  referencesNew: 'Not used by any job step yet. Once saved, steps that run as this proxy are listed here.',
  referencesNone: 'No job step runs as this proxy.',
  referencesTruncated: (count: number) => `Only the first ${count.toLocaleString('en-US')} steps are listed.`,
  saved: 'The proxy was saved.',
  created: 'The proxy was created.',
  savedSecret: 'The proxy was created, and its credential with it; the password was sent once and is not kept.'
} as const

export const credentialText = {
  nameRequired: 'The credential needs a name.',
  identityRequired: 'The credential needs an identity.',
  secretRequired: 'Type the password (secret) the credential holds.',
  secretMismatch: 'The password and its confirmation differ.',
  secretBroken: 'The password holds a broken character (half of a surrogate pair).',
  secretTooLong: `A credential's secret holds at most ${agentLimits.credentialSecretChars.toLocaleString('en-US')} characters.`,
  identityTooLong: `An identity holds at most ${agentLimits.credentialIdentityChars.toLocaleString('en-US')} characters.`,
  windowsIdentityManagedInstance: 'On Managed Instance a credential cannot use a Windows identity.',
  readOnly: 'ALTER ANY CREDENTIAL is needed to change it.',
  neverRead: 'SQL Server never returns the secret, so the password starts empty behind “Change identity and password”. Changing it, or the identity, sends both together (ALTER CREDENTIAL); saving without it changes nothing.',
  changeBoth: 'Change identity and password',
  unchanged: 'Check “Change identity and password” to change this credential; ALTER CREDENTIAL always sets both.',
  providerHint: 'An Extensible Key Management provider; it cannot change after the credential is created.',
  usedByHint: 'A new password applies to these steps from their next run.',
  usedByNone: 'No proxy uses this credential.',
  usedByUnread: 'Only sysadmin can list the proxies and job steps that use this credential.',
  batchRight: (identity: string, server: string) => `For CmdExec and PowerShell steps, ${identity || 'this Windows account'} needs “Log on as a batch job” on ${server}. Varia cannot read that right; a failed step's message says so when it is missing.`,
  saved: 'The credential was saved; the password was sent once and is not kept.',
  created: 'The credential was created; the password was sent once and is not kept.',
  scriptSecret: 'Script writes <secret> in place of the password: replace it before running the script.'
} as const

/** A secret field's problems, on `field`: required, confirmed, well formed and within its bound. */
function secretProblems<F extends string>(field: F, secrets: SecretFacts): { field: F; severity: 'error'; message: string }[] {
  if (secrets.secret === 'empty') return [{ field, severity: 'error', message: credentialText.secretRequired }]
  if (secrets.tooLong) return [{ field, severity: 'error', message: credentialText.secretTooLong }]
  if (!secrets.wellFormed) return [{ field, severity: 'error', message: credentialText.secretBroken }]
  if (!secrets.matches) return [{ field, severity: 'error', message: credentialText.secretMismatch }]
  return []
}
/** DOMAIN\user, or user@domain: what a Windows identity looks like. */
const windowsIdentity = (identity: string) => /^[^\\\s]+\\[^\\]+$/.test(identity.trim())

/** The proxy draft's problems: errors on a missing name or credential, a new credential without its name, identity or secret, or a too long
 *  description (Save cannot send those), and a warning when the proxy is active to no subsystem. */
export function agentProxyProblems(model: AgentProxyDocumentModel, draft: AgentProxyDraft, secrets: SecretFacts = emptySecretFacts): AgentProxyProblem[] {
  const problems: AgentProxyProblem[] = []
  if (!draft.name.trim()) problems.push({ field: 'name', severity: 'error', message: agentProxyText.nameRequired })
  if (draft.description.length > agentLimits.descriptionChars) problems.push({ field: 'description', severity: 'error', message: agentProxyText.descriptionTooLong })
  if (draft.credentialMode === 'existing') {
    if (!draft.credential) problems.push({ field: 'credential', severity: 'error', message: agentProxyText.credentialRequired })
  } else {
    if (!model.canCreateCredential) problems.push({ field: 'credential', severity: 'error', message: agentProxyText.noCredentialRight })
    const name = draft.newCredentialName.trim()
    if (!name) problems.push({ field: 'credential', severity: 'error', message: agentProxyText.newCredentialName })
    else if (model.credentials.some(credential => credential.name.toLowerCase() === name.toLowerCase())) problems.push({ field: 'credential', severity: 'error', message: agentProxyText.newCredentialTaken })
    if (!draft.newCredentialIdentity.trim()) problems.push({ field: 'credential', severity: 'error', message: agentProxyText.newCredentialIdentity })
    else if (draft.newCredentialIdentity.length > agentLimits.credentialIdentityChars) problems.push({ field: 'credential', severity: 'error', message: credentialText.identityTooLong })
    problems.push(...secretProblems('credential' as const, secrets))
  }
  if (draft.subsystems.length === 0) problems.push({ field: 'subsystems', severity: 'warning', message: agentProxyText.noSubsystem })
  if (draft.principals.length > agentLimits.proxyPrincipals) problems.push({ field: 'principals', severity: 'error', message: agentProxyText.tooManyPrincipals })
  return problems
}
/** The credential draft's problems: a missing name or identity, a secret not typed, confirmed or well formed, a Windows identity where
 *  the platform refuses one. An existing credential's are checked only with "Change identity and password". */
export function credentialProblems(model: CredentialDocumentModel, draft: CredentialDraft, secrets: SecretFacts = emptySecretFacts): CredentialProblem[] {
  const problems: CredentialProblem[] = []
  if (!model.credential && !draft.name.trim()) problems.push({ field: 'name', severity: 'error', message: credentialText.nameRequired })
  if (model.credential && !draft.change) return problems
  if (!draft.identity.trim()) problems.push({ field: 'identity', severity: 'error', message: credentialText.identityRequired })
  else if (draft.identity.length > agentLimits.credentialIdentityChars) problems.push({ field: 'identity', severity: 'error', message: credentialText.identityTooLong })
  else if (model.platform === 'managedInstance' && windowsIdentity(draft.identity)) problems.push({ field: 'identity', severity: 'error', message: credentialText.windowsIdentityManagedInstance })
  problems.push(...secretProblems('secret' as const, secrets))
  return problems
}
export const savable = (problems: readonly { readonly severity: 'error' | 'warning' }[]) => !problems.some(problem => problem.severity === 'error')

/** A subsystem's SSMS name ("Operating system (CmdExec)"), else msdb's own. */
export const subsystemLabel = (name: string): string => subsystems.find(subsystem => subsystem.id.toLowerCase() === name.toLowerCase())?.label ?? name

// --- Commands ----------------------------------------------------------------------------------------------------------

export type AgentProxyCommandId = 'agent.newProxy' | 'agent.newProxyOnAgent' | 'agentProxy.save' | 'agentProxy.reload' | 'agent.newCredential' | 'credential.save' | 'credential.reload'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface AgentProxyCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent' | 'Object Explorer'
  readonly icon: 'add' | 'save' | 'refresh' | 'agent-proxy' | 'key'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly palette?: false
  readonly menus?: readonly { readonly menu: 'explorer.context' | 'explorer.new'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
const inProxy = 'agentEnabled && backendReady && activeDocumentIsAgentProxy'
const inCredential = 'agentEnabled && backendReady && activeDocumentIsCredential'
const proxyNodes = "((explorerNode == 'folder' && (explorerFolder == 'agentProxies' || explorerFolder == 'agentUnassignedProxies')) || explorerNode == 'agentProxySubsystem' || explorerNode == 'agentProxy')"
const credentialNodes = "((explorerNode == 'folder' && explorerFolder == 'credentials') || explorerNode == 'credential')"
const serverEngines = "(explorerServerEngine == 'box' || explorerServerEngine == 'managedInstance')"
/**
 * The proxy and credential documents' commands, all behind the release gate (agentEnabled; the renderer registers none without it): New
 * Proxy… on the Proxies folder, its subsystem folders, Unassigned Proxies and a proxy, and Proxy… in the SQL Server Agent node's New submenu
 * (SQL Server only: Managed Instance has no proxies); New Credential… on Security › Credentials and a credential; and each document's Save
 * and Reload, which act on the document whose header runs them (`tabId`), else the active one. Properties on a proxy or a credential opens
 * its document through the object actions' Properties.
 */
export function agentProxyCommandEntries(): { readonly [K in AgentProxyCommandId]: AgentProxyCommandEntry } {
  return {
    'agent.newProxy': {
      title: 'New Proxy…', category: 'SQL Server Agent', icon: 'agent-proxy', keywords: ['agent', 'proxy', 'create', 'credential', 'cmdexec', 'powershell', 'sqlserveragent'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server where you are sysadmin first.',
      menus: [{ menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: `${proxyNodes} && !explorerServerLost` }]
    },
    // The same document as New Proxy…: a command of its own because macOS context menus show placements by command id.
    'agent.newProxyOnAgent': {
      title: 'Proxy…', category: 'SQL Server Agent', icon: 'agent-proxy', keywords: ['agent', 'proxy', 'create'], palette: false,
      precondition: "agentEnabled && backendReady && explorerSelectionKind == 'agent'", unavailableHint: 'Select SQL Server Agent in Object Explorer.',
      menus: [{ menu: 'explorer.new', group: '2_agent', order: 4, mnemonic: 'p', when: "explorerNode == 'agent' && explorerServerEngine == 'box'" }]
    },
    'agentProxy.save': {
      title: 'Save Proxy', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'proxy', 'apply', 'ok', 'create'],
      precondition: inProxy, unavailableHint: 'Change the proxy first.'
    },
    'agentProxy.reload': {
      title: 'Reload Proxy', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'proxy', 'refresh', 'discard'],
      precondition: inProxy, unavailableHint: 'Open a proxy first (Properties on a proxy in Object Explorer).'
    },
    'agent.newCredential': {
      title: 'New Credential…', category: 'Object Explorer', icon: 'key', keywords: ['credential', 'security', 'secret', 'identity', 'create', 'proxy'],
      precondition: "agentEnabled && backendReady && (explorerSelectionFolder == 'credentials' || explorerSelectionKind == 'credential')",
      unavailableHint: 'Select Security › Credentials of a SQL Server or Managed Instance in Object Explorer.',
      menus: [{ menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: `${credentialNodes} && !explorerServerLost && ${serverEngines}` }]
    },
    'credential.save': {
      title: 'Save Credential', category: 'Object Explorer', icon: 'save', keywords: ['credential', 'apply', 'ok', 'password', 'secret'],
      precondition: inCredential, unavailableHint: 'Check “Change identity and password” first; a read-only credential cannot be saved.'
    },
    'credential.reload': {
      title: 'Reload Credential', category: 'Object Explorer', icon: 'refresh', keywords: ['credential', 'refresh', 'discard'],
      precondition: inCredential, unavailableHint: 'Open a credential first (Properties on a credential in Object Explorer).'
    }
  }
}
/** The tabs: SSMS's window titles, by name; New Proxy and New Credential until saved. */
export const agentProxyTabName = (name: string | undefined): string => name === undefined ? 'New Proxy' : `Proxy Account Properties - ${name}`
export const credentialTabName = (name: string | undefined): string => name === undefined ? 'New Credential' : `Credential Properties - ${name}`
