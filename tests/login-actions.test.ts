import { afterEach, describe, expect, it, vi } from 'vitest'
import { unknownOutcomeMessage } from '../src/shared/actions/catalog'
import { loginMessages, type LoginFacts } from '../src/shared/actions/logins'
import { actionPromptRequestSchema, promptLimits } from '../src/shared/actions/prompts'
import type { ActionDescribeResult, ActionExecuteResult } from '../src/shared/actions/schema'
import type { ApiResult, ExplorerChildrenResult, ExplorerNode } from '../src/shared/contracts'
import type { NodeStatus, NodeSubtype } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams } from '../src/shared/explorer/refs'
import { clipUnits, loginActionMessages, renameMessages } from '../src/renderer/src/actions/ObjectActionService'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, explorerAnswer, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

interface Login { readonly name: string; readonly subtype: NodeSubtype; readonly status?: NodeStatus }
const facts = (changes: Partial<LoginFacts> = {}): LoginFacts => ({
  principalId: 300, type: 'S', subtype: 'sql', disabled: false, sid: '01', created: '2026-01-01T00:00:00.000', connectDenied: false, own: false, sysadmin: false, sessions: 0,
  ownedDatabases: 0, ownedDatabaseNames: [], ownedServerObjects: 0, canAlter: true, canControlServer: true, nameInUse: false, ...changes
})
const done = (title: string, changes: Partial<ActionExecuteResult> = {}): ApiResult<ActionExecuteResult> => ({ ok: true, value: { steps: [{ status: 'done', title }], messages: [], elapsedMs: 1, ...changes } })

/** A connected workbench (signed in as `admin`) whose Logins folder lists `logins`, expanded down to it. */
async function setup() {
  const fixture = workbenchFixture()
  cleanups.push(fixture.dispose)
  let logins: Login[] = [{ name: 'AppUser', subtype: 'sql' }, { name: 'Retired', subtype: 'sql', status: 'disabled' }, { name: 'CONTOSO\\Ops', subtype: 'windowsGroup' }, { name: 'sa', subtype: 'sa' }]
  fixture.api.explorerChildren.mockImplementation(async (params: ExplorerChildrenParams): Promise<ApiResult<ExplorerChildrenResult>> => {
    const answer = explorerAnswer(params)
    if (params.node.type !== 'folder' || params.node.folder !== 'logins') return { ok: true, value: answer }
    const nodes: ExplorerNode[] = logins.map(login => ({ ref: { type: 'object', object: { kind: 'login', name: login.name } }, label: login.name, icon: 'login', hasChildren: false, subtype: login.subtype, ...login.status ? { status: login.status } : {} }))
    return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
  })
  fixture.api.push(readyBackend())
  fixture.connections.add({ ...connectionInfo('server-a'), login: 'admin' }, connectionOptions)
  const find = async (label: string) => {
    let id: number | undefined
    await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label)?.id; expect(id, label).toBeDefined() })
    return id!
  }
  for (const label of ['Security', 'Logins']) fixture.explorer.expand(await find(label))
  const describeAs = (value: LoginFacts) => fixture.api.describeObject.mockResolvedValue({ ok: true, value: { elapsedMs: 1, login: value } })
  const notices = () => fixture.notifications.getSnapshot().visible.map(toast => [toast.severity, toast.message])
  return { ...fixture, find, describeAs, notices, setLogins: (next: Login[]) => { logins = next }, node: (id: number) => fixture.explorer.menuNode(id)! }
}

describe('a login\'s Disable and Enable', () => {
  it('offers Disable for an enabled login and Enable for a disabled one, never both, and neither for a Windows group', async () => {
    const { commands, explorer, find, node } = await setup()
    // The context keys describe the selection, which a node's menu selects first.
    const enabled = (id: string, label: number) => { explorer.select(label); return commands.isEnabled(id as never, { target: { kind: 'explorer', node: node(label) } }) }
    const [app, retired, group, sa] = [await find('AppUser'), await find('Retired'), await find('CONTOSO\\Ops'), await find('sa')]
    expect([enabled('explorer.disable', app), enabled('explorer.enable', app)]).toEqual([true, false])
    expect([enabled('explorer.disable', retired), enabled('explorer.enable', retired)]).toEqual([false, true])
    expect([enabled('explorer.disable', group), enabled('explorer.enable', group), enabled('explorer.rename', group)]).toEqual([false, false, true])
    expect([enabled('explorer.disable', sa), enabled('explorer.rename', sa)]).toEqual([true, true])
  })
  it('reads the login\'s facts, asks, disables it as a status-bar job, reloads the folder with it selected, and notes its sessions', async () => {
    const { api, commands, explorer, find, describeAs, notices, setLogins } = await setup()
    describeAs(facts({ sessions: 3 }))
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'disable' })
    api.executeObjectAction.mockImplementationOnce(async () => { setLogins([{ name: 'AppUser', subtype: 'sql', status: 'disabled' }]); return done('Disable the login', { sessions: 3 }) })
    explorer.select(await find('AppUser'))
    expect(await commands.execute('explorer.disable', undefined, 'menu')).toBe(true)
    await vi.waitFor(() => expect(notices()).toEqual([['info', 'Disabled the login AppUser. Its 3 open sessions stay connected.']]))
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ connectionId: 'server-a', dialog: 'loginFacts', target: { kind: 'login', name: 'AppUser' } })
    expect(api.confirmAction.mock.calls).toEqual([[{ prompt: 'disableLogin', facts: { login: 'AppUser', sysadmin: false, sessions: 3 } }]])
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'disable', connectionId: 'server-a', requestId: expect.any(String), target: { kind: 'login', name: 'AppUser' } })
    // The reconcile shows the new state: the row's status changes, and it stays selected.
    await vi.waitFor(() => expect(explorer.getSnapshot().rows.nodes.find(node => node?.label === 'AppUser')).toMatchObject({ status: 'disabled' }))
    await vi.waitFor(async () => expect(explorer.getSnapshot().selected).toBe(await find('AppUser')))
    expect(commands.getSnapshot().error).toBe('')
  })
  it('sends nothing when the prompt is cancelled, closed or fails', async () => {
    const { actions, api, commands, find, node, describeAs, notices } = await setup()
    describeAs(facts())
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    await actions.changeLoginState(node(await find('AppUser')), 'disable')
    api.confirmAction.mockResolvedValueOnce({ ok: false, error: 'The window went away.' })
    await actions.changeLoginState(node(await find('AppUser')), 'disable')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(commands.getSnapshot().error).toBe('The window went away.')
    expect(notices()).toEqual([])
  })
  it('refuses by the rules the facts give, before any prompt: the login this connection uses, permissions, and SQL Server\'s own', async () => {
    const { actions, api, commands, find, node, describeAs } = await setup()
    const app = node(await find('AppUser'))
    for (const [changes, message] of [
      [{ own: true }, loginMessages.own], [{ canAlter: false }, loginMessages.alterAnyLogin], [{ sysadmin: true, canControlServer: false }, loginMessages.controlServer],
      [{ subtype: 'system' }, loginMessages.system]
    ] as const) {
      describeAs(facts(changes))
      await actions.changeLoginState(app, 'disable')
      expect(commands.getSnapshot().error).toBe(message)
    }
    expect(api.confirmAction).not.toHaveBeenCalled()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
  it('names the service, a sysadmin member, and Varia\'s other connections that sign in as the login in the prompt', async () => {
    const { actions, api, connections, find, node, describeAs } = await setup()
    // Another connection to the same server as this login (by name, without case), one to another server, and a lost one.
    connections.add({ ...connectionInfo('server-b'), server: 'SERVER-A.example', login: 'appuser', displayName: 'Reporting' }, connectionOptions)
    connections.add({ ...connectionInfo('server-c'), login: 'AppUser' }, connectionOptions)
    describeAs(facts({ type: 'U', subtype: 'windowsUser', sysadmin: true, sessions: 1, service: 'SQL Server Agent (MSSQLSERVER)' }))
    await actions.changeLoginState(node(await find('AppUser')), 'disable')
    expect(api.confirmAction.mock.calls[0][0]).toEqual({ prompt: 'disableLogin', facts: { login: 'AppUser', sysadmin: true, sessions: 1, service: 'SQL Server Agent (MSSQLSERVER)', connections: ['Reporting (SERVER-A.example)'] } })
  })
  it('enables without asking, and says when permission to connect is still denied', async () => {
    const { actions, api, find, node, describeAs, notices } = await setup()
    describeAs(facts({ disabled: true, connectDenied: true }))
    api.executeObjectAction.mockResolvedValueOnce(done('Enable the login'))
    await actions.changeLoginState(node(await find('Retired')), 'enable')
    expect(api.confirmAction).not.toHaveBeenCalled()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'enable', target: { kind: 'login', name: 'Retired' } })
    expect(notices()).toEqual([['info', loginActionMessages.enabled('Retired', true)]])
    expect(loginActionMessages.enabled('Retired', true)).toBe('Enabled the login Retired. Permission to connect is still denied.')
    expect(loginActionMessages.disabled('AppUser', 1)).toBe('Disabled the login AppUser. Its open session stays connected.')
    expect(loginActionMessages.disabled('AppUser', 0)).toBe('Disabled the login AppUser.')
  })
  it('reports a failed describe or statement in the banner, a lost backend as an unknown outcome, and an unconfirmed Stop', async () => {
    const { actions, api, commands, find, node, describeAs } = await setup()
    const app = node(await find('AppUser'))
    api.describeObject.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'The login AppUser no longer exists. Refresh Object Explorer.', retryable: false } } })
    await actions.changeLoginState(app, 'disable')
    expect(commands.getSnapshot().error).toBe('The login AppUser no longer exists. Refresh Object Explorer.')
    describeAs(facts())
    api.confirmAction.mockResolvedValue({ ok: true, value: 'disable' })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed', title: 'Disable the login' }], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Cannot alter the login.', retryable: false } } })
    await actions.changeLoginState(app, 'disable')
    expect(commands.getSnapshot().error).toBe('Disable failed for AppUser: Cannot alter the login.')
    api.executeObjectAction.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await actions.changeLoginState(app, 'disable')
    expect(commands.getSnapshot().error).toBe(unknownOutcomeMessage)
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const running = actions.changeLoginState(app, 'disable')
    // The statement's job, after the facts' own (which names its step).
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalledTimes(3))
    expect(actions.getSnapshot().jobs).toEqual([expect.objectContaining({ verb: 'disable', label: 'AppUser' })])
    expect(actions.getSnapshot().jobs[0].step).toBeUndefined()
    actions.stopJobs([actions.getSnapshot().jobs[0].id])
    pending.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await running
    expect(commands.getSnapshot().error).toBe('The disable was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('runs one action per login: a second Disable while the first asks says so, and the server going ends it', async () => {
    const { actions, api, commands, connections, find, node, describeAs } = await setup()
    describeAs(facts())
    const answer = deferred<ApiResult<'disable' | 'cancel'>>()
    api.confirmAction.mockReturnValueOnce(answer.promise)
    const app = node(await find('AppUser'))
    const first = actions.changeLoginState(app, 'disable')
    await vi.waitFor(() => expect(api.confirmAction).toHaveBeenCalledOnce())
    await actions.changeLoginState(app, 'disable')
    expect(api.describeObject).toHaveBeenCalledOnce()
    expect(commands.getSnapshot().error).toBe('An action on AppUser is waiting for your answer.')
    connections.remove('server-a')
    answer.resolve({ ok: true, value: 'disable' })
    await first
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
})

describe('a login\'s Disable and Enable while the facts are read', () => {
  it('shows the read in the status bar with Stop, says so to a second request, and a Stop ends it without a word or a prompt', async () => {
    const { actions, api, commands, find, node } = await setup()
    const pending = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(pending.promise)
    const app = node(await find('AppUser'))
    const first = actions.changeLoginState(app, 'disable')
    await vi.waitFor(() => expect(actions.getSnapshot().jobs).toEqual([expect.objectContaining({ verb: 'disable', label: 'AppUser', step: 'Reading the login', visible: true })]))
    await actions.changeLoginState(app, 'disable')
    expect(commands.getSnapshot().error).toBe(renameMessages.running('AppUser', 'disable'))
    expect(api.describeObject).toHaveBeenCalledOnce()
    commands.clearError()
    const job = actions.getSnapshot().jobs[0]
    expect(job.id).toBe(api.describeObject.mock.calls[0][0].requestId)
    actions.stopJobs([job.id])
    expect(api.cancelObjectActions).toHaveBeenCalledWith([job.id])
    pending.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await first
    expect(actions.getSnapshot().jobs).toEqual([])
    expect(commands.getSnapshot().error).toBe('')
    expect(api.confirmAction).not.toHaveBeenCalled()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
  it('clips the labels of Varia\'s other connections to the prompt\'s bound in UTF-16 units, never inside a surrogate pair', async () => {
    const { actions, api, connections, find, node, describeAs } = await setup()
    // 64 astral characters are 128 UTF-16 units (the display name's limit) but only 64 code points.
    const grin = String.fromCodePoint(0x1F600)
    connections.add({ ...connectionInfo('server-b'), server: 'server-a.example', login: 'AppUser', displayName: grin.repeat(64) }, connectionOptions)
    connections.add({ ...connectionInfo('server-c'), server: 'server-a.example', login: 'AppUser', displayName: 'x' + grin.repeat(200) }, connectionOptions)
    // The service the prompt names is cut to its bound the same way.
    describeAs(facts({ service: 'S' + grin.repeat(200) }))
    await actions.changeLoginState(node(await find('AppUser')), 'disable')
    const request = api.confirmAction.mock.calls[0][0]
    expect(actionPromptRequestSchema.safeParse(request).success).toBe(true)
    const service = request.prompt === 'disableLogin' ? request.facts.service ?? '' : ''
    expect([service.length <= promptLimits.service, service.endsWith('…'), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(service)]).toEqual([true, true, false])
    const labels = request.prompt === 'disableLogin' ? request.facts.connections ?? [] : []
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.length).toBeLessThanOrEqual(promptLimits.connectionName)
      expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
    // The second is 221 code points but 401 units: a cut by code points would have left it over zod's bound.
    expect([labels[0].endsWith('…'), labels[1].endsWith('…')]).toEqual([false, true])
    expect([clipUnits('ab' + grin, 3), clipUnits('a' + grin + 'b', 4), clipUnits('a' + grin + 'bc', 4)]).toEqual(['ab…', 'a' + grin + 'b', 'a' + grin + '…'])
  })
  it('gives the palette the reason a login\'s verb is greyed: a Windows group\'s Disable, and SQL Server\'s own logins', async () => {
    const { commands, explorer, find, quickInput, setLogins } = await setup()
    setLogins([{ name: 'AppUser', subtype: 'sql' }, { name: 'CONTOSO\\Ops', subtype: 'windowsGroup' }, { name: '##MS_PolicyTsqlExecutionLogin##', subtype: 'system', status: 'disabled' }])
    explorer.select(await find('Logins'))
    await commands.execute('explorer.refresh', undefined, 'menu')
    const hint = async (label: string, id: string) => {
      explorer.select(await find(label))
      await commands.execute('workbench.showCommands', undefined, 'keybinding')
      const row = quickInput.getSnapshot().rows.find(entry => entry.item.id === id)
      quickInput.hide('cancel')
      return row?.item.disabledHint
    }
    expect(await hint('CONTOSO\\Ops', 'explorer.disable')).toBe(loginMessages.windowsGroupDisable)
    expect(await hint('##MS_PolicyTsqlExecutionLogin##', 'explorer.enable')).toBe(loginMessages.system)
    expect(await hint('##MS_PolicyTsqlExecutionLogin##', 'explorer.rename')).toBe(loginMessages.system)
    // A verb the login does not offer at all keeps the catalogue's hint.
    expect(await hint('AppUser', 'explorer.enable')).toBe('Select a disabled login in Object Explorer.')
  })
})

describe('a login\'s Rename', () => {
  it('keeps the box for a name in SQL Server\'s own form, and takes back the box\'s message when it closes', async () => {
    const { actions, api, commands, explorer, find, node, setLogins } = await setup()
    const app = await find('AppUser')
    explorer.beginRename(app)
    expect(await actions.commitRename(node(app), '##AppUser##')).toBe(false)
    expect(explorer.renaming.getSnapshot()).toBe(app)
    expect(commands.getSnapshot().error).toBe(loginMessages.systemName)
    // Escape takes the message back.
    actions.cancelRename()
    expect(commands.getSnapshot().error).toBe('')
    // But not a banner that replaced it while the box was open.
    explorer.beginRename(app)
    expect(await actions.commitRename(node(app), '##AppUser##')).toBe(false)
    commands.reportError('A refresh failed.')
    actions.cancelRename()
    expect(commands.getSnapshot().error).toBe('A refresh failed.')
    commands.clearError()
    // A corrected name takes it back too, and a later banner of something else stays.
    explorer.beginRename(app)
    expect(await actions.commitRename(node(app), 'CONTOSO\\AppUser')).toBe(false)
    api.executeObjectAction.mockImplementationOnce(async () => { setLogins([{ name: 'AppOwner', subtype: 'sql' }]); return done('Rename') })
    await actions.commitRename(node(app), 'AppOwner')
    expect(commands.getSnapshot().error).toBe('')
    commands.reportError('Something else failed.')
    actions.cancelRename()
    expect(commands.getSnapshot().error).toBe('Something else failed.')
    expect(api.executeObjectAction).toHaveBeenCalledOnce()
  })
  it('keeps the box for a SQL Server login\'s name with a backslash, and sends a Windows login\'s', async () => {
    const { actions, api, commands, explorer, find, node } = await setup()
    const app = await find('AppUser')
    explorer.beginRename(app)
    expect(await actions.commitRename(node(app), 'CONTOSO\\AppUser')).toBe(false)
    expect(explorer.renaming.getSnapshot()).toBe(app)
    expect(commands.getSnapshot().error).toBe("A SQL Server login's name cannot contain a backslash.")
    explorer.endRename()
    const windows = { ...node(app), subtype: 'windowsUser' as const }
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await actions.commitRename(windows, 'CONTOSO\\New')
    expect(api.executeObjectAction.mock.calls).toEqual([[{ action: 'rename', connectionId: 'server-a', requestId: expect.any(String), target: { kind: 'login', name: 'AppUser' }, newName: 'CONTOSO\\New' }]])
  })
  it('notes that mapped users keep their names, and warns about Varia\'s other connections that sign in as the login', async () => {
    const { actions, api, commands, connections, explorer, find, node, notices, setLogins } = await setup()
    connections.add({ ...connectionInfo('server-b'), server: 'server-a.example', login: 'AppUser' }, connectionOptions)
    api.executeObjectAction.mockImplementationOnce(async () => { setLogins([{ name: 'AppUser2', subtype: 'sql' }]); return done('Rename', { messages: [] }) })
    await actions.commitRename(node(await find('AppUser')), 'AppUser2')
    expect(notices()).toEqual([['info', 'Renamed the login AppUser to AppUser2. Database users mapped to it keep their names.']])
    expect(commands.getSnapshot()).toEqual({ error: "Varia's connection server-a.example signs in as this login, and cannot reconnect under the old name.", kind: 'warning' })
    await vi.waitFor(async () => expect(explorer.getSnapshot().selected).toBe(await find('AppUser2')))
  })
})
