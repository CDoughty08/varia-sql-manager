import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionMenuReasons, actionMenuState, agentServiceRules, type ActionTarget } from '../src/shared/actions/catalog'
import { actionExecuteRequestSchema, type AgentJobFacts } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import type { ActionExecuteResult } from '../src/shared/actions/schema'
import { jobActionMessages } from '../src/renderer/src/actions/ObjectActionService'
import { agentDialogText, restartAgentDefinition, startJobAtStepDefinition, startJobBlocked, stopAgentDefinition } from '../src/renderer/src/dialogs/agent-dialogs'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { deleteObjectDefinition } from '../src/renderer/src/dialogs/definitions'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'
import { actionsContribution } from '../src/renderer/src/contributions/actions'
import { CommandService } from '../src/renderer/src/core/commands'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const agent = (facts: Partial<NonNullable<ActionTarget['agent']>> = {}, target: Partial<ActionTarget> = {}): ActionTarget => ({ kind: 'agent', engine: 'box', agent: { windowsClient: true, ...facts }, ...target })
const service = (target: ActionTarget) => { const state = actionMenuState(target); return [state.startAgent, state.stopAgent, state.restartAgent] }

describe('the release gate', () => {
  it('registers no Agent command without VARIA_AGENT_PREVIEW=1, so the palette offers none', () => {
    const ids = ['explorer.startJob', 'explorer.stopJob', 'explorer.startAgent', 'explorer.stopAgent', 'explorer.restartAgent'] as const
    const registered = (agentEnabled: boolean) => {
      const commands = new CommandService()
      const contribution = actionsContribution({ commands } as never, { agentEnabled })
      const has = ids.map(id => commands.has(id))
      contribution.dispose()
      return has
    }
    expect(registered(false)).toEqual(ids.map(() => false))
    expect(registered(true)).toEqual(ids.map(() => true))
  })
})

describe('the palette\'s Enable and Disable (AG-10)', () => {
  it('names the shared verbs by the selected object, with a greyed row saying what to select', () => {
    let selected: Partial<ExplorerMenuNode> | undefined
    const commands = new CommandService()
    const contribution = actionsContribution({ commands, explorer: { menuNode: () => selected, getSnapshot: () => ({ selected: 1 }) }, actions: { canRun: () => false, unavailable: () => undefined } } as never, { agentEnabled: true })
    cleanups.push(() => contribution.dispose())
    const shown = (kind?: string) => {
      selected = kind ? { id: 1, connectionId: 'c1', lost: false, ref: { type: 'object', object: { kind, name: 'x' } } } as never : undefined
      return [commands.titleFor('explorer.enable'), commands.titleFor('explorer.disable'), commands.unavailableReason('explorer.enable')]
    }
    expect(shown('agentJob')).toEqual(['Enable Job', 'Disable Job', 'Select a disabled job in Object Explorer.'])
    expect(shown('agentAlert')).toEqual(['Enable Alert', 'Disable Alert', 'Select a disabled alert in Object Explorer.'])
    expect(shown('agentOperator')).toEqual(['Enable Operator', 'Disable Operator', 'Select a disabled operator in Object Explorer.'])
    // A login keeps the catalogue's words and hint; anything else, or nothing selected, keeps the catalogue's title.
    expect(shown('login')).toEqual(['Enable Login', 'Disable Login', undefined])
    expect(shown('database')).toEqual([undefined, undefined, undefined])
    expect(shown()).toEqual([undefined, undefined, undefined])
  })
})

describe('SQL Server Agent service verbs (AG-2)', () => {
  it('offers Start when stopped and Stop and Restart when running', () => {
    expect(service(agent({ state: 1 }))).toEqual(['enabled', 'disabled', 'disabled'])
    expect(service(agent({ state: 4 }))).toEqual(['disabled', 'enabled', 'enabled'])
    expect(actionMenuReasons(agent({ state: 4 })).startAgent).toBe('SQL Server Agent is running.')
    // Without a sample the state is unknown, so the dialog's own describe decides.
    expect(service(agent())).toEqual(['enabled', 'enabled', 'enabled'])
  })
  it('greys every verb with its reason off Windows, on Linux, on Managed Instance, on a cluster, while pending and when disabled', () => {
    const reason = (target: ActionTarget) => actionMenuReasons(target).stopAgent
    expect(service(agent({ windowsClient: false, state: 4 }))).toEqual(['disabled', 'disabled', 'disabled'])
    expect(reason(agent({ windowsClient: false, state: 4 }))).toBe('Starting and stopping SQL Server Agent needs Varia on Windows.')
    expect(reason(agent({ state: 4 }, { linux: true }))).toBe('On Linux, use systemctl on the server.')
    expect(reason(agent({ state: 4 }, { engine: 'managedInstance' }))).toBe('Azure SQL Managed Instance runs SQL Server Agent itself.')
    expect(reason(agent({ state: 4, clustered: true }))).toBe('Use Failover Cluster Manager for a clustered instance.')
    expect(reason(agent({ state: 3 }))).toBe('SQL Server Agent is changing state; try again when it settles.')
    expect(actionMenuReasons(agent({ state: 1, startup: 4 })).startAgent).toBe('The SQL Server Agent service is disabled.')
    // The client rule comes first: a Linux server seen from macOS says Varia needs Windows.
    expect(reason(agent({ windowsClient: false }, { linux: true }))).toBe(agentServiceRules[0]!.reason)
  })
  it('offers the job verbs on a job, Enable instead of Disable on a disabled one', () => {
    const job = (status?: 'disabled') => { const state = actionMenuState({ kind: 'agentJob', engine: 'box', ...status ? { status } : {} }); return [state.startJob, state.stopJob, state.disable, state.enable, state.rename, state.delete] }
    expect(job()).toEqual(['enabled', 'enabled', 'enabled', '', 'enabled', 'enabled'])
    expect(job('disabled')).toEqual(['enabled', 'enabled', '', 'enabled', 'enabled', 'enabled'])
  })
})

describe('the AG-2 request schema', () => {
  const base = { connectionId: '00000000-0000-4000-8000-0000000000aa', requestId: '00000000-0000-4000-8000-000000000001' }
  const job = { kind: 'agentJob', name: 'Nightly' } as const
  it('requires the identity of the job a verb read, in the tree\'s format', () => {
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'stopJob', target: job, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'startJob', target: job, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' }, stepName: 'Load' }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'disable', target: job }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'stopJob', target: job, agentIdentity: { jobId: '2026-02-30T00:00:00' } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'stopJob', target: job, agentIdentity: { created: '2026-01-01T00:00:00' } }).success).toBe(false)
    // A login's verb never carries a job's identity.
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'disable', target: { kind: 'login', name: 'AppUser' }, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } }).success).toBe(false)
  })
  it('takes the service verbs on the Agent node only', () => {
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'restartAgent', target: { kind: 'agent' } }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'restartAgent', target: { kind: 'agent', name: 'x' } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'startAgent', target: job }).success).toBe(false)
  })
})

describe('Start Job at Step and the service dialogs', () => {
  const facts = (steps: number, changes: Partial<AgentJobFacts> = {}): AgentJobFacts => ({
    name: 'Nightly', agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' }, enabled: true, running: false, stepsTruncated: false,
    steps: Array.from({ length: steps }, (_, index) => ({ id: index + 1, name: `Step ${index + 1}` })), ...changes
  })
  const target = { kind: 'agentJob', name: 'Nightly' } as const
  it('starts a one-step job as it opens, and always names the chosen step (the job\'s start step need not be the first)', () => {
    const runOnOpen = startJobAtStepDefinition.runOnOpen as (model: AgentJobFacts) => boolean
    expect([runOnOpen(facts(1)), runOnOpen(facts(3)), runOnOpen(facts(1, { running: true }))]).toEqual([true, false, false])
    expect(startJobAtStepDefinition.request(target, facts(3), { step: 1 }, undefined as never)).toEqual({ action: 'startJob', target, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' }, stepName: 'Step 1' })
    expect(startJobAtStepDefinition.request(target, facts(3), { step: 2 }, undefined as never)).toEqual({ action: 'startJob', target, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' }, stepName: 'Step 2' })
    expect([startJobBlocked(facts(0)), startJobBlocked(facts(2, { running: true })), startJobBlocked(facts(2))]).toEqual([agentDialogText.noSteps, agentDialogText.running, undefined])
  })
  it('refuses a job created since the tree listed the row, even one that would start as it opens', () => {
    expect(startJobBlocked(facts(1), { step: 1, listed: '00000000-1111-2222-3333-444444444440' })).toBe(agentDialogText.replaced)
    expect(startJobBlocked(facts(1), { step: 1, listed: '00000000-1111-2222-3333-444444444441' })).toBeUndefined()
    expect(startJobBlocked(facts(1), { step: 1 })).toBeUndefined()
  })
  it("samples the server's status again once a start, stop or restart ran, so the verbs do not wait for the next interval", () => {
    const effects = { refreshStatus: vi.fn() }
    stopAgentDefinition.afterSuccess(effects as never, undefined as never, undefined as never, undefined as never, {})
    expect(effects.refreshStatus).toHaveBeenCalledTimes(1)
    restartAgentDefinition.afterPartial?.(effects as never, undefined as never)
    expect(effects.refreshStatus).toHaveBeenCalledTimes(2)
  })
  it('deletes the job the tree listed, so one created since under the name is refused', () => {
    const job = { kind: 'agentJob', name: 'Nightly' } as const, model = { agentIdentity: { jobId: '00000000-1111-2222-3333-444444444442' } } as never
    const draft = { deleteHistory: true, closeConnections: false, dropMappedUsers: false }
    expect(deleteObjectDefinition.request(job, model, { ...draft, listed: '00000000-1111-2222-3333-444444444441' }, undefined as never)).toMatchObject({ agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } })
    expect(deleteObjectDefinition.request(job, model, draft, undefined as never)).toMatchObject({ agentIdentity: { jobId: '00000000-1111-2222-3333-444444444442' } })
  })
  it('keeps the service dialogs open on their steps, with no Script button, and asks as SSMS does', () => {
    expect([stopAgentDefinition.noScript, stopAgentDefinition.keepOpen, stopAgentDefinition.longRun]).toEqual([true, true, 'stopAgent'])
    expect(restartAgentDefinition.request({ kind: 'agent' } as never, undefined as never, {}, undefined as never)).toEqual({ action: 'restartAgent', target: { kind: 'agent' } })
    expect(agentDialogText.confirm('restartAgent', 'SQLAgent$SALES', 'DB01')).toBe('Are you sure you want to restart the SQLAgent$SALES service on DB01?')
  })
})

describe('a job\'s Stop, Disable, Enable and Rename', () => {
  const done = (changes: Partial<ActionExecuteResult> = {}): ApiResult<ActionExecuteResult> => ({ ok: true, value: { steps: [{ status: 'done', title: 'Stop the job' }], messages: [], elapsedMs: 1, ...changes } })
  function setup() {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const node = (changes: Partial<ExplorerMenuNode> = {}): ExplorerMenuNode => ({
      id: 9_999, connectionId: 'server-a', ref: { type: 'object', object: { kind: 'agentJob', name: 'Nightly' } }, kind: 'agentJob', label: 'Nightly', engine: 'box',
      jobId: '00000000-1111-2222-3333-444444444441', lost: false, ...changes
    })
    const notices = () => fixture.notifications.getSnapshot().visible.map(toast => toast.message)
    return { ...fixture, node, notices }
  }
  it('sends the job\'s ID with Stop Job and Disable, and says what it did', async () => {
    const { actions, api, node, notices } = setup()
    api.executeObjectAction.mockResolvedValue(done())
    await actions.changeJobState(node(), 'stopJob')
    await actions.changeJobState(node(), 'disable')
    expect(api.executeObjectAction.mock.calls.map(call => call[0])).toEqual([
      { action: 'stopJob', connectionId: 'server-a', requestId: expect.any(String), target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } },
      { action: 'disable', connectionId: 'server-a', requestId: expect.any(String), target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } }
    ])
    expect(notices()).toContain(jobActionMessages.disabled('Nightly'))
  })
  it('refuses a row without its ID, and reports SQL Server Agent\'s refusal', async () => {
    const { actions, api, commands, node } = setup()
    await actions.changeJobState(node({ jobId: undefined }), 'stopJob')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(commands.getSnapshot().error).toBe(jobActionMessages.unidentified)
    api.executeObjectAction.mockResolvedValueOnce(done({ error: { code: 'JOB_STATE', message: 'The job is not running.', retryable: false } }))
    await actions.changeJobState(node(), 'stopJob')
    expect(commands.getSnapshot().error).toBe('Stop Job failed for Nightly: The job is not running.')
  })
  it('sends the job\'s identity with a rename, and refuses a row without it', async () => {
    const { actions, api, commands, node } = setup()
    api.executeObjectAction.mockResolvedValue(done())
    await actions.commitRename(node({ jobId: undefined }), 'Nightly2')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(commands.getSnapshot().error).toBe(jobActionMessages.unidentified)
    await actions.commitRename(node(), 'Nightly2')
    expect(api.executeObjectAction.mock.calls[0]![0]).toMatchObject({ action: 'rename', newName: 'Nightly2', agentIdentity: { jobId: '00000000-1111-2222-3333-444444444441' } })
  })
})
