import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentPreviewArgument, agentPreviewEnabled, agentPreviewFromArgv } from '../src/shared/agent/gate'
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

describe('SQL Server Agent release gate', () => {
  it('opens only for VARIA_AGENT_PREVIEW=1, passed to the preload as one argument', () => {
    expect(agentPreviewEnabled({ VARIA_AGENT_PREVIEW: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', ' 1']) expect(agentPreviewEnabled({ VARIA_AGENT_PREVIEW: value })).toBe(false)
    expect(agentPreviewFromArgv(['electron', agentPreviewArgument])).toBe(true)
    expect(agentPreviewFromArgv(['electron', '--varia-agent-preview=0', '--varia-test-mode'])).toBe(false)
  })
  it('is read once in main, whatever the build, and smoke runs open it', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('const agentPreview = agentPreviewEnabled(process.env)')
    expect(main).toContain('...(agentPreview ? [agentPreviewArgument] : [])')
    expect(main.match(/VARIA_AGENT_PREVIEW|--varia-agent-preview/g)).toHaveLength(1)
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain('agentPreview: agentPreviewFromArgv(process.argv)')
    expect(readFileSync('scripts/fixtures/smoke.mjs', 'utf8')).toContain("env.VARIA_AGENT_PREVIEW ??= '1'")
  })
  it('is the static key agentEnabled, false unless the workbench was given the gate', () => {
    expect(contextKeys.agentEnabled).toMatchObject({ type: 'boolean', scope: 'static' })
    expect(contextRecord('win32').agentEnabled).toBe(false)
    const inputs = { platform: 'linux' as const, documents: { documents: [], activeId: undefined, busy: false }, queries: {}, connections: [], quickInputVisible: false, wordWrap: false } as unknown as Parameters<typeof computeContextKeys>[0]
    expect(computeContextKeys(inputs).agentEnabled).toBe(false)
    expect(computeContextKeys({ ...inputs, agentEnabled: true }).agentEnabled).toBe(true)
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
    expect(agentRoleReason(ready({ userRole: true }))).toBeUndefined()
  })
  it('is a target key of the Object Explorer menu and a selection key, each with every role and ""', () => {
    expect(contextKeys.agentRole).toMatchObject({ type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...agentRoleValues] })
    expect(contextKeys.explorerSelectionAgentRole).toMatchObject({ type: 'enum', scope: 'state', values: ['', ...agentRoleValues] })
    expect(contextRecord('linux')).toMatchObject({ agentRole: '', explorerSelectionAgentRole: '' })
  })
})
