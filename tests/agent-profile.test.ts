import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentProfileResultSchema, agentProfileSchema, agentRoleOf, agentRoleReason, agentRoleValues, type AgentProfile, type AgentProfileState } from '../src/shared/agent/profile'
import { agentLimits } from '../src/shared/agent/catalog'
import { methodPolicies, methodProviders } from '../src/shared/ipc/methods'
import { requestSchemas, resultSchemas } from '../src/main/validation'
import { contextKeys, contextRecord } from '../src/shared/commands/context-keys'
import { computeContextKeys } from '../src/renderer/src/core/contextkeys'

const profile: AgentProfile = {
  platform: 'windows', engineEdition: 3, msdbAccess: true, sysadmin: false, userRole: false, readerRole: false, operatorRole: false, purgeHistory: false,
  serverServices: false, sessions: false, alterAnyCredential: false, clustered: false, agentXps: true, databaseMailXps: false, databaseMail: false
}
const ready = (patch: Partial<AgentProfile>): AgentProfileState => ({ status: 'ready', profile: { ...profile, ...patch } })

// AG-9 removed SQL Server Agent's release gate: Agent is on for every SQL Server connection with no environment variable.
describe('SQL Server Agent ships without a release gate', () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules' ? [] : sources(path)
    return /\.(ts|tsx|mjs|cjs|js|cs|yml|sh)$/.test(entry.name) ? [path] : []
  })
  it('leaves no VARIA_AGENT_PREVIEW read, renderer argument or agentEnabled key in the code, scripts or CI', () => {
    const files = [...sources('src'), ...sources('backend'), ...sources('scripts'), ...sources('.github'), ...sources('.claude/hooks')]
    expect(files.length).toBeGreaterThan(100)
    const found = files.filter(file => /VARIA_AGENT_PREVIEW|varia-agent-preview|agentEnabled|agentPreview|AgentGate\.Enabled/.test(readFileSync(file, 'utf8')))
    expect(found).toEqual([])
  })
  it('has no agentEnabled context key, so no when clause can hide Agent', () => {
    expect(Object.keys(contextKeys)).not.toContain('agentEnabled')
    const inputs = { platform: 'linux' as const, documents: { documents: [], activeId: undefined, busy: false }, queries: {}, connections: [], quickInputVisible: false, wordWrap: false } as unknown as Parameters<typeof computeContextKeys>[0]
    expect(computeContextKeys(inputs)).not.toHaveProperty('agentEnabled')
    expect(contextRecord('win32')).not.toHaveProperty('agentEnabled')
  })
})

describe('agent.profile', () => {
  it('is registered as a SQL Server-only read on the explorer lane with a short deadline', () => {
    expect(methodPolicies['agent.profile']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 15_000 })
    expect(methodProviders('agent.profile')).toEqual(['sqlserver'])
    expect(agentLimits.profileMs).toBeLessThan(methodPolicies['agent.profile'].deadlineMs as number)
    expect(requestSchemas['agent.profile']).toBe(agentProfileSchema)
    expect(resultSchemas['agent.profile']).toBe(agentProfileResultSchema)
  })
  it('takes exactly a connection id and a request id', () => {
    const ids = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    expect(agentProfileSchema.safeParse(ids).success).toBe(true)
    expect(agentProfileSchema.safeParse({ ...ids, extra: 1 }).success).toBe(false)
    expect(agentProfileSchema.safeParse({ ...ids, connectionId: 'x' }).success).toBe(false)
    expect(agentProfileSchema.safeParse({ connectionId: ids.connectionId }).success).toBe(false)
  })
  it('checks the answer strictly, server options absent when unread', () => {
    expect(agentProfileResultSchema.safeParse({ profile, elapsedMs: 3 }).success).toBe(true)
    const { agentXps: _xps, databaseMailXps: _mail, ...unread } = profile
    expect(agentProfileResultSchema.safeParse({ profile: { ...unread, msdbAccess: false }, elapsedMs: 3 }).success).toBe(true)
    expect(agentProfileResultSchema.safeParse({ elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: "SQL Server Agent isn't available on SQL Server Express.", retryable: false } }).success).toBe(true)
    expect(agentProfileResultSchema.safeParse({ profile: { ...profile, extra: true }, elapsedMs: 3 }).success).toBe(false)
    expect(agentProfileResultSchema.safeParse({ profile: { ...profile, platform: 'mac' }, elapsedMs: 3 }).success).toBe(false)
    expect(agentProfileResultSchema.safeParse({ elapsedMs: 1, error: { code: 'NOPE', message: 'x', retryable: false } }).success).toBe(false)
  })
})

describe('agentRole', () => {
  it('is the highest Agent role, unknown before the read and profileFailed after a failed one', () => {
    expect(agentRoleOf(undefined)).toBe('unknown')
    expect(agentRoleOf({ status: 'unknown' })).toBe('unknown')
    expect(agentRoleOf({ status: 'failed', error: { code: 'TIMEOUT', message: 'Too slow.', retryable: true } })).toBe('profileFailed')
    expect(agentRoleOf(ready({ sysadmin: true, userRole: true, readerRole: true, operatorRole: true }))).toBe('sysadmin')
    expect(agentRoleOf(ready({ userRole: true, readerRole: true, operatorRole: true }))).toBe('operator')
    expect(agentRoleOf(ready({ userRole: true, readerRole: true }))).toBe('reader')
    expect(agentRoleOf(ready({ userRole: true }))).toBe('user')
    expect(agentRoleOf(ready({}))).toBe('none')
    expect(agentRoleOf(ready({ msdbAccess: false }))).toBe('none')
  })
  it('says why a verb waits on the role, and nothing once it is read', () => {
    expect(agentRoleReason(undefined)).toBe('Reading this login\'s Agent role…')
    expect(agentRoleReason({ status: 'failed', error: { code: 'TIMEOUT', message: 'Too slow.', retryable: true } })).toBe("Could not read this login's Agent role: Too slow. Refresh to retry.")
    // The backend's own wording leaves the retry hint to this reason, so it is said once.
    const timedOut = agentRoleReason({ status: 'failed', error: { code: 'TIMEOUT', message: "Reading this login's SQL Server Agent role took longer than 10 seconds.", retryable: true } })
    expect(timedOut).toBe("Could not read this login's Agent role: Reading this login's SQL Server Agent role took longer than 10 seconds. Refresh to retry.")
    expect(agentRoleReason(ready({ userRole: true }))).toBeUndefined()
  })
  it('is a target key of the Object Explorer menu and a selection key, each with every role and ""', () => {
    expect(contextKeys.agentRole).toMatchObject({ type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...agentRoleValues] })
    expect(contextKeys.explorerSelectionAgentRole).toMatchObject({ type: 'enum', scope: 'state', values: ['', ...agentRoleValues] })
    expect(contextRecord('linux')).toMatchObject({ agentRole: '', explorerSelectionAgentRole: '' })
  })
})
