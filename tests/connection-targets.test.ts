import { describe, expect, it } from 'vitest'
import type { ConnectionOptions } from '../src/shared/contracts'
import { connectionDefaults } from '../src/shared/connections'
import {
  backendConnectionHandleSchema, changedConnectionDetails, connectionAuthenticationSchema, connectionCredentialReferenceSchema, connectionDetailsConfirmation,
  connectionDetailsSchema, connectionFailureReasonSchema, connectionLifecycleSchema, connectionTargetLimits, connectionTargetOptions,
  connectionTargetOptionsSchema, connectionWorkspaceSchema, effectiveAutoReconnect, expectedConnectionPrincipalSchema, isConnectedTarget,
  persistedConnectionTargetSchema, queryConnectionAssociationSchema, shouldAutoReconnect, type PersistedConnectionTarget
} from '../src/shared/connection-targets'

const id = () => crypto.randomUUID()
const sql: ConnectionOptions = { ...connectionDefaults('linux'), server: 'sql-prod', database: 'Sales', authentication: 'sql', username: 'reader' }
const target = (patch: Partial<PersistedConnectionTarget> = {}): PersistedConnectionTarget => persistedConnectionTargetSchema.parse({
  id: id(), options: sql, details: {}, inExplorer: true, resumeWanted: true, ...patch
})

describe('durable connection target snapshots', () => {
  it('whitelists nonsecret settings from a live request without retaining presentation or changing execution policy', () => {
    const request = { ...sql, password: 'secret-marker', displayName: 'Production', color: '#abcdef', environment: 'Production', advanced: { commandTimeout: 0, connectTimeout: 12 } }
    const snapshot = connectionTargetOptions(request)
    expect(snapshot).toEqual({ ...sql, advanced: { commandTimeout: 0, connectTimeout: 12 } })
    expect(JSON.stringify(snapshot)).not.toContain('secret-marker')
    expect(snapshot).not.toHaveProperty('displayName')
    expect(snapshot).not.toHaveProperty('environment')
    expect(snapshot).not.toHaveProperty('color')
    expect(connectionTargetOptions(sql).advanced).toBeUndefined()
    request.advanced.connectTimeout = 20
    expect(snapshot.advanced?.connectTimeout).toBe(12)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.advanced)).toBe(true)
  })

  it('rejects secret, presentation and unknown fields on persisted options rather than silently removing them', () => {
    for (const extra of [{ password: 'secret-marker' }, { password: undefined }, { connectionString: 'Password=secret-marker' }, { accessToken: 'token-marker' }, { displayName: 'Other' }, { color: '#abcdef' }, { environment: 'Production' }]) {
      expect(connectionTargetOptionsSchema.safeParse({ ...sql, ...extra }).success).toBe(false)
      expect(persistedConnectionTargetSchema.safeParse({ ...target(), options: { ...sql, ...extra } }).success).toBe(false)
    }
    expect(connectionTargetOptionsSchema.safeParse({ ...sql, advanced: { passwordHash: 'hash-marker' } }).success).toBe(false)
    expect(() => connectionTargetOptions({ ...sql, connectionString: 'server=other' } as ConnectionOptions)).toThrow()
  })

  it('keeps the integrated account separate from the settings snapshot', () => {
    for (const authentication of ['windows', 'entraIntegrated'] as const) {
      const options = { ...sql, authentication, username: 'DOMAIN\\reader' }
      expect(connectionTargetOptions(options)).not.toHaveProperty('username')
      expect(connectionTargetOptionsSchema.safeParse(options).success).toBe(false)
    }
    expect(connectionTargetOptionsSchema.safeParse({ ...sql, username: ' ' }).success).toBe(false)
  })

  it('validates independent target, profile and credential-revision identifiers without accepting secret fingerprints', () => {
    const profileId = id(), credential = { profileId, revision: id() }
    const expectedPrincipal = { provider: 'sqlServer', authentication: 'sql', id: 'reader' }
    const parsed = persistedConnectionTargetSchema.parse({ ...target(), profileId, credential, expectedPrincipal })
    expect(parsed).toMatchObject({ profileId, credential, expectedPrincipal })
    for (const record of [parsed, parsed.details, parsed.credential, parsed.expectedPrincipal]) expect(Object.isFrozen(record)).toBe(true)
    for (const invalid of [{ ...credential, revision: 'password-hash' }, { ...credential, hash: 'password-hash' }, { ...credential, password: 'secret-marker' }]) expect(connectionCredentialReferenceSchema.safeParse(invalid).success).toBe(false)
    expect(persistedConnectionTargetSchema.safeParse({ ...target(), expectedPrincipal: { ...expectedPrincipal, authentication: 'entraDefault' } }).success).toBe(false)
    expect(persistedConnectionTargetSchema.safeParse({ ...target(), options: connectionTargetOptions({ ...sql, authentication: 'windows' }), credential }).success).toBe(false)
    for (const principal of ['', ' ', 'x'.repeat(connectionTargetLimits.principalChars + 1), 'reader\nother', 'reader\u202e']) expect(expectedConnectionPrincipalSchema.safeParse({ ...expectedPrincipal, id: principal }).success).toBe(false)
  })

  it('bounds and versions the workspace and rejects duplicate logical targets without deduplicating by server name', () => {
    const first = target(), second = target()
    const workspace = connectionWorkspaceSchema.parse({ version: 1, targets: [first, second] })
    expect(workspace.targets).toHaveLength(2)
    expect(Object.isFrozen(workspace.targets)).toBe(true)
    expect(connectionWorkspaceSchema.safeParse({ version: 1, targets: [first, first] }).success).toBe(false)
    expect(connectionWorkspaceSchema.safeParse({ version: 2, targets: [] }).success).toBe(false)
    expect(connectionWorkspaceSchema.safeParse({ version: 1, targets: Array.from({ length: connectionTargetLimits.targets + 1 }, () => target()) }).success).toBe(false)
    for (const extra of [{ handle: { id: id(), generation: 1 } }, { state: 'connected' }, { password: 'secret-marker' }, { favorite: true }]) expect(persistedConnectionTargetSchema.safeParse({ ...first, ...extra }).success).toBe(false)
  })

  it('bounds an authentication completion without treating omission as an instruction to forget credentials', () => {
    const principal = { provider: 'sqlServer', authentication: 'sql', id: 'reader' }
    const credential = { profileId: id(), revision: id() }
    const authenticated = connectionAuthenticationSchema.parse({ principal, credential })
    expect(authenticated).toEqual({ principal, credential })
    for (const record of [authenticated, authenticated.principal, authenticated.credential]) expect(Object.isFrozen(record)).toBe(true)
    expect(connectionAuthenticationSchema.parse({ principal })).not.toHaveProperty('credential')
    expect(connectionAuthenticationSchema.parse({ principal, credential: null })).toEqual({ principal, credential: null })
    for (const completion of [{ credential }, { principal, accessToken: 'token-marker' }, { principal: { ...principal, token: 'token-marker' } }, { principal, credential: { ...credential, password: 'secret-marker' } }]) expect(connectionAuthenticationSchema.safeParse(completion).success).toBe(false)
  })
})

describe('connection intent and runtime lifecycle', () => {
  it('defaults reconnect to On while respecting global and per-target choices', () => {
    expect(connectionDetailsSchema.parse({})).toEqual({ autoReconnect: 'inherit' })
    expect(effectiveAutoReconnect('inherit')).toBe(true)
    expect(effectiveAutoReconnect('inherit', false)).toBe(false)
    expect(effectiveAutoReconnect('on', false)).toBe(true)
    expect(effectiveAutoReconnect('off', true)).toBe(false)
    expect(shouldAutoReconnect(target())).toBe(true)
    expect(shouldAutoReconnect(target(), false)).toBe(false)
    expect(shouldAutoReconnect(target({ details: { autoReconnect: 'on' } }), false)).toBe(true)
    expect(shouldAutoReconnect(target({ resumeWanted: false, details: { autoReconnect: 'on' } }))).toBe(false)
    expect(shouldAutoReconnect(target({ inExplorer: false, details: { autoReconnect: 'on' } }))).toBe(false)
  })

  it('preserves a deliberately detached query target and its exact selected database', () => {
    const association = { targetId: id(), database: 'CaseSensitiveDB', attachWanted: false }
    expect(queryConnectionAssociationSchema.parse(association)).toEqual(association)
    expect(queryConnectionAssociationSchema.parse({ ...association, database: '' }).database).toBe('')
    for (const patch of [{ targetId: 'server-name' }, { database: 'x'.repeat(129) }, { handle: { id: id(), generation: 1 } }, { password: 'secret-marker' }]) expect(queryConnectionAssociationSchema.safeParse({ ...association, ...patch }).success).toBe(false)
  })

  it('requires current backend handles only for connected and disconnecting states', () => {
    const handle = { id: id(), generation: 1 }, attemptId = id()
    for (const lifecycle of [{ state: 'disconnected' }, { state: 'connecting', attemptId }, { state: 'connected', handle }, { state: 'disconnecting', handle, attemptId }, { state: 'lost', reason: 'backend-lost' }]) expect(connectionLifecycleSchema.safeParse(lifecycle).success).toBe(true)
    for (const state of ['disconnected', 'connecting', 'connected', 'disconnecting', 'lost']) {
      const lifecycle = connectionLifecycleSchema.parse({ state, ...state === 'connecting' || state === 'disconnecting' ? { attemptId } : {}, ...state === 'connected' || state === 'disconnecting' ? { handle } : {} })
      expect(isConnectedTarget({ lifecycle }), state).toBe(state === 'connected')
    }
    expect(connectionLifecycleSchema.parse({ state: 'lost' })).toEqual({ state: 'lost', reason: 'backend-lost' })
    for (const lifecycle of [{ state: 'connected' }, { state: 'connecting', handle, attemptId }, { state: 'disconnected', handle }, { state: 'lost', handle }, { state: 'disconnecting', handle }, { state: 'disconnected', reason: 'Password=secret-marker' }]) expect(connectionLifecycleSchema.safeParse(lifecycle).success).toBe(false)
    for (const generation of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(backendConnectionHandleSchema.safeParse({ ...handle, generation }).success).toBe(false)
    expect(backendConnectionHandleSchema.parse({ ...handle, generation: 0 }).generation).toBe(0)
    expect(connectionFailureReasonSchema.safeParse('unknown').success).toBe(true)
  })
})

describe('connection details confirmation', () => {
  it('shows only changed details and normalizes empty labels and color case', () => {
    const current = connectionDetailsSchema.parse({ displayName: ' Reporting ', color: '#ABCDEF', environment: ' Production ', autoReconnect: 'inherit' })
    const selected = connectionDetailsSchema.parse({ displayName: 'Reporting', color: '#abcdef', environment: 'Production' })
    expect(changedConnectionDetails(current, selected)).toEqual([])
    expect(changedConnectionDetails(current, connectionDetailsSchema.parse({ displayName: 'Other', color: '#123456', autoReconnect: 'on' }))).toEqual(['displayName', 'color', 'environment', 'autoReconnect'])
    expect(changedConnectionDetails(connectionDetailsSchema.parse({ displayName: ' ', environment: '' }), connectionDetailsSchema.parse({}))).toEqual([])
    expect(connectionDetailsSchema.safeParse({ favorite: true }).success).toBe(false)
    expect(connectionDetailsSchema.safeParse({ displayName: 'name\nother' }).success).toBe(false)
  })

  it('uses the agreed confirmation copy for every differing detail', () => {
    expect(connectionDetailsConfirmation).toEqual({ title: 'Use selected connection details?', useSelected: 'Use Selected Details', keepCurrent: 'Keep Current Details', cancel: 'Cancel' })
    for (const patch of [{ displayName: 'Other' }, { color: '#abcdef' }, { environment: 'Production' }, { autoReconnect: 'off' }]) expect(changedConnectionDetails(connectionDetailsSchema.parse({}), connectionDetailsSchema.parse(patch))).toHaveLength(1)
  })
})
