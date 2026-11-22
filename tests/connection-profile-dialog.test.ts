// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import ConnectDialog from '../src/renderer/src/ConnectDialog'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ConnectionLibrary, ConnectionProfile, ConnectionProfileInput } from '../src/shared/connections'
import type { ConnectionOptions, VariaApi } from '../src/shared/contracts'
import { connectionDefaults, connectionKey } from '../src/shared/connections'
import { readyBackend, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'
import { acceptConnectionReceipt } from '../src/renderer/src/services/connection-receipts'
import { detailsOf } from '../src/renderer/src/services/connections'
import { executePendingQuery, finishConnectionDetails, needsDetailsConfirmation, withChangedDetails, type OpenedConnection } from '../src/renderer/src/services/connection-opening'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks() })
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const profile = (name: string, value: number, autoReconnect?: ConnectionProfile['autoReconnect']): ConnectionProfile => ({ id: id(value), options: { ...connectionDefaults('win32'), server: `server-${value}`, displayName: name }, favorite: true, registered: false, autoReconnect })

async function mount(initialAutoReconnect?: 'inherit' | 'on' | 'off', setup: {
  initial?: ConnectionOptions; initialTargetId?: string; holdLibrary?: boolean
  profiles?: ConnectionProfile[]; savedPasswords?: string[]
  beforeRender?: (workbench: ReturnType<typeof workbenchFixture>) => Promise<void> | void
} = {}) {
  const workbench = workbenchFixture(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  workbench.api.push(readyBackend())
  await setup.beforeRender?.(workbench)
  let library: ConnectionLibrary = { version: 1, profiles: setup.profiles ?? [profile('Off profile', 1, 'off'), profile('On profile', 2, 'on'), profile('Older profile', 3), { ...profile('Local profile', 4, 'off'), options: connectionDefaults('win32') }] }
  const held = deferred<void>()
  const loadConnectionLibrary = vi.fn<VariaApi['loadConnectionLibrary']>(async () => {
    if (setup.holdLibrary) await held.promise
    return { ok: true, value: { library, savedPasswords: setup.savedPasswords ?? [], windowsIdentity: 'DOMAIN\\reader', passwordStorage: { available: true }, bigQuery: { profiles: [] } } }
  })
  const saveConnectionProfile = vi.fn<VariaApi['saveConnectionProfile']>(async value => {
    const input = value as ConnectionProfileInput
    // As main's upsert: without an id, the first entry with these settings.
    const target = input.id ?? library.profiles.find(value => connectionKey(value.options) === connectionKey(input.options))?.id
    library = { ...library, profiles: library.profiles.map(value => value.id === target ? { ...value, options: input.options, autoReconnect: input.autoReconnect, favorite: input.favorite ?? value.favorite, registered: input.registered ?? value.registered } : value) }
    return { ok: true, value: { library, savedPasswords: setup.savedPasswords ?? [] } }
  })
  workbench.api.connect.mockImplementation(async (value, context) => { const options = value as ConnectionOptions; return { ok: true, value: { id: id(100), targetId: context!.targetId, server: options.server, database: options.database, generation: 1, serverVersion: '17', authentication: { principal: { provider: 'sqlserver', authentication: options.authentication, id: 'sid:fixture' } } } } })
  const original = Object.getOwnPropertyDescriptor(window, 'varia')
  Object.defineProperty(window, 'varia', { configurable: true, value: { ...workbench.api, loadConnectionLibrary, saveConnectionProfile } })
  const onConnected = vi.fn<ComponentProps<typeof ConnectDialog>['onConnected']>(async () => {}), onClose = vi.fn()
  const theme = { ...workbench.theme, getSnapshot: () => workbench.theme.state, subscribe: () => () => {}, accent: (color?: string) => color }
  const renderer = { ...workbench, platform: 'win32', theme } as unknown as Workbench
  let key = 0
  const reopen = async (preference = initialAutoReconnect, extra: Partial<ComponentProps<typeof ConnectDialog>> = {}) => {
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: renderer, children: createElement(ConnectDialog, { key: extra.raise !== undefined || extra.reconnectSeq !== undefined ? key : ++key, initial: extra.initial ?? setup.initial ?? connectionDefaults('win32'), initialTargetId: extra.initialTargetId ?? setup.initialTargetId, initialAutoReconnect: preference, onConnected, onClose, ...extra }) })))
  }
  cleanups.push(() => {
    act(() => root.unmount()); workbench.dispose(); host.remove()
    if (original) Object.defineProperty(window, 'varia', original)
    else Reflect.deleteProperty(window, 'varia')
  })
  await reopen()
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find(value => value.textContent?.trim() === label || value.getAttribute('aria-label') === label)
    if (!found) throw new Error('Missing button: ' + label)
    return found
  }
  const choose = async (name: string) => {
    const found = [...host.querySelectorAll('button')].find(value => value.querySelector('strong')?.textContent === name)
    if (!found) throw new Error('Missing saved profile: ' + name)
    await act(async () => found.click())
  }
  const select = () => host.querySelector<HTMLSelectElement>('#connect-auto-reconnect')!
  const preference = async (value: 'inherit' | 'on' | 'off') => {
    await act(async () => { select().value = value; select().dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const releaseLibrary = async () => { await act(async () => held.resolve()) }
  return { ...workbench, host, button, choose, select, preference, reopen, saveConnectionProfile, onConnected, closed: onClose, releaseLibrary, profiles: () => library.profiles }
}

describe('saved profile startup reconnect preference', () => {
  const aliases = () => {
    const first = profile('First alias', 1, 'off'), second = { ...profile('Second alias', 2, 'on'), options: { ...first.options, displayName: 'Second alias' } }
    return [first, second]
  }

  it.each(['new', 'reuse'] as const)('keeps the selected Windows alias after Save for a %s transport', async mode => {
    const profiles = aliases(), targetId = id(50), handle = id(100), options = profiles[0].options
    const authentication = { principal: { provider: 'sqlserver' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
    const info = { id: handle, targetId, generation: 1, server: options.server, database: options.database, serverVersion: '17', authentication }
    const view = await mount(undefined, { profiles, beforeRender: workbench => {
      if (mode === 'reuse') {
        const attempt = workbench.connections.beginConnect(options, 1, targetId, detailsOf(options, 'off'))!
        workbench.connections.accept(info, options, targetId, authentication, attempt)
      }
    } })
    if (mode === 'reuse') view.api.connect.mockResolvedValue({ ok: true, value: info })
    view.onConnected.mockImplementation(async (receipt, chosen, preference, attempt, requestId) => {
      const opened = await acceptConnectionReceipt({ ...view, api: view.api, info: receipt, options: chosen, details: detailsOf(chosen, preference), attempt, requestId })
      expect(opened).toBeDefined()
      expect(needsDetailsConfirmation(opened!)).toBe(mode === 'reuse')
      finishConnectionDetails(view.connections, opened!, mode === 'reuse' ? 'current' : 'selected')
    })
    await view.choose('Second alias')
    await act(async () => view.button('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: profiles[1].id, autoReconnect: 'on' }))
    await act(async () => view.button('Connect').click())
    const context = view.api.connect.mock.calls[0]?.[1]
    expect(context).toMatchObject({ selectedProfileId: profiles[1].id, autoReconnect: 'on' })
    expect(context).not.toHaveProperty('profileId')
    expect(view.profiles().map(value => value.autoReconnect)).toEqual(['off', 'on'])
    expect(view.connectionTargets.getSnapshot()).toHaveLength(1)
    expect(view.connectionTargets.getSnapshot()[0].details.autoReconnect).toBe(mode === 'reuse' ? 'off' : 'on')
    expect(view.onConnected).toHaveBeenCalledOnce()
  })

  it.each(['connect', 'save'] as const)('hydrates the named initial alias and keeps its metadata owner through %s', async action => {
    const profiles = aliases(), view = await mount(undefined, { profiles, initial: profiles[1].options })
    expect(view.select().value).toBe('on')
    if (action === 'save') {
      await act(async () => view.button('Add favorite').click())
      expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: profiles[1].id, autoReconnect: 'on' }))
    }
    await act(async () => view.button('Connect').click())
    expect(view.api.connect.mock.calls[0]?.[1]).toMatchObject({ selectedProfileId: profiles[1].id, autoReconnect: 'on' })
    expect(view.profiles().map(value => value.autoReconnect)).toEqual(['off', 'on'])
  })

  it('clears both selected alias and credential-source hints on Reset', async () => {
    const profiles = aliases().map(value => ({ ...value, options: { ...value.options, authentication: 'sql' as const, username: 'reader' } }))
    const view = await mount(undefined, { profiles, savedPasswords: [profiles[0].id] })
    await view.choose('Second alias')
    await act(async () => view.button('Reset').click())
    expect(view.select().value).toBe('inherit')
    await act(async () => view.button('Connect').click())
    expect(view.api.connect.mock.calls[0]?.[1]).not.toHaveProperty('selectedProfileId')
    expect(view.api.connect.mock.calls[0]?.[1]).not.toHaveProperty('profileId')
    expect(view.api.connect.mock.calls[0]?.[1]).toMatchObject({ autoReconnect: 'inherit' })
  })

  it('keeps selected SQL alias metadata separate from another profile supplying its saved password', async () => {
    const profiles = aliases().map(value => ({ ...value, options: { ...value.options, authentication: 'sql' as const, username: 'reader' } }))
    const view = await mount(undefined, { profiles, savedPasswords: [profiles[0].id] })
    await view.choose('Second alias')
    expect(view.host.querySelector<HTMLInputElement>('#connect-password')?.placeholder).toBe('••••••••')
    await act(async () => view.button('Connect').click())
    expect(view.api.connect.mock.calls[0]?.[1]).toMatchObject({ selectedProfileId: profiles[1].id, profileId: profiles[0].id, autoReconnect: 'on', remember: true })
    expect((view.api.connect.mock.calls[0]?.[0] as ConnectionOptions).password).toBe('')
    expect(view.profiles().map(value => value.autoReconnect)).toEqual(['off', 'on'])
  })

  it.each(['on', 'off'] as const)('hydrates the ordinary matching initial form from saved %s policy before Connect or save', async policy => {
    const selected = profile(policy === 'off' ? 'Off profile' : 'On profile', policy === 'off' ? 1 : 2, policy)
    const view = await mount(undefined, { initial: selected.options })
    expect(view.select().value).toBe(policy)
    await act(async () => view.button('Add favorite').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ autoReconnect: policy }))
    await act(async () => view.button('Connect').click())
    expect(view.api.connect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ autoReconnect: policy }))
    expect(view.onConnected.mock.calls[0]?.[2]).toBe(policy)
  })

  it.each(['edit', 'reset', 'target', 'explicit-inherit'] as const)('does not let a late matching profile overwrite %s ownership', async owner => {
    const view = await mount(owner === 'explicit-inherit' ? 'inherit' : undefined, { initial: profile('Off profile', 1, 'off').options, initialTargetId: owner === 'target' ? id(50) : undefined, holdLibrary: true })
    if (owner === 'edit') await view.preference('on')
    if (owner === 'reset') await act(async () => view.button('Reset').click())
    await view.releaseLibrary()
    expect(view.select().value).toBe(owner === 'edit' ? 'on' : 'inherit')
  })
  it('saves the displayed preference and restores it when reopening and selecting that profile', async () => {
    const view = await mount('on')
    expect(view.select().value).toBe('on')
    await view.choose('Off profile')
    expect(view.select().value).toBe('off')
    await view.preference('on')
    await act(async () => view.button('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: id(1), autoReconnect: 'on' }))
    await view.reopen('inherit')
    await view.choose('Off profile')
    expect(view.select().value).toBe('on')
  })

  it('uses each selected profile policy, defaults older profiles to inherit, and Reset clears target-specific policy', async () => {
    const view = await mount('off')
    expect(view.select().value).toBe('off')
    await view.choose('On profile')
    expect(view.select().value).toBe('on')
    await view.choose('Older profile')
    expect(view.select().value).toBe('inherit')
    await view.preference('off')
    await view.choose('On profile')
    expect(view.select().value).toBe('on')
    await act(async () => view.button('Reset').click())
    expect(view.select().value).toBe('inherit')
  })

  it('preserves another profile policy when favoriting its row and sends the selected policy on form registration and Connect', async () => {
    const view = await mount()
    await view.choose('On profile')
    await act(async () => view.button('Unfavorite Off profile').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: id(1), autoReconnect: 'off', favorite: false }))
    expect(view.select().value).toBe('on')
    await view.preference('off')
    await act(async () => view.button('Register server').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: id(2), autoReconnect: 'off', registered: true }))
    await act(async () => view.button('Connect').click())
    expect(view.api.connect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'interactive', autoReconnect: 'off' }))
    expect(view.onConnected).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'off', expect.anything(), expect.any(String), expect.any(AbortSignal), [])
  })

  it('keeps a matching profile policy on ordinary live reuse while Keep Current preserves the target policy', async () => {
    const options = profile('Off profile', 1, 'off').options, targetId = id(50), handle = id(100)
    const authentication = { principal: { provider: 'sqlserver' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
    const info = { id: handle, targetId, generation: 1, server: options.server, database: options.database, serverVersion: '17', authentication }
    const view = await mount(undefined, { initial: options, beforeRender: workbench => {
      const attempt = workbench.connections.beginConnect(options, 1, targetId, detailsOf(options, 'on'))!
      workbench.connections.accept(info, options, targetId, authentication, attempt)
    } })
    view.api.connect.mockResolvedValue({ ok: true, value: info })
    view.onConnected.mockImplementation(async (receipt, chosen, preference, attempt, requestId) => {
      const opened = await acceptConnectionReceipt({ ...view, api: view.api, info: receipt, options: chosen, details: detailsOf(chosen, preference), attempt, requestId })
      expect(opened).toBeDefined()
      expect(needsDetailsConfirmation(opened!)).toBe(true)
      finishConnectionDetails(view.connections, opened!, 'current')
    })
    await act(async () => view.button('Connect').click())
    expect(view.api.connect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ autoReconnect: 'off' }))
    expect(view.connectionTargets.get(targetId)?.details.autoReconnect).toBe('on')
    expect(view.onConnected).toHaveBeenCalledOnce()
  })

  it('submits explicit main reuse after query-only Disconnect and F5, then reattaches and executes only that query', async () => {
    const options = profile('Off profile', 1, 'off').options, targetId = id(50), handle = id(100), requested: string[] = []
    const authentication = { principal: { provider: 'sqlserver' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
    const info = { id: handle, targetId, generation: 1, server: options.server, database: options.database, serverVersion: '17', authentication }
    let pendingId = '', siblingId = ''
    const view = await mount('on', { initial: options, initialTargetId: targetId, beforeRender: async workbench => {
      const attempt = workbench.connections.beginConnect(options, 1, targetId, detailsOf(options, 'on'))!
      workbench.connections.accept(info, options, targetId, authentication, attempt)
      pendingId = workbench.documents.create('pending.sql', 'SELECT 1', 'Sales', handle).id
      siblingId = workbench.documents.create('sibling.sql', 'SELECT 2', 'Archive', handle).id
      await workbench.targets.changeConnection(pendingId, undefined)
      await workbench.targets.changeConnection(siblingId, undefined)
      workbench.documents.activate(pendingId)
      workbench.events.subscribe(event => { if (event.type === 'query.connectRequested') requested.push(event.tabId) })
      expect(await workbench.commands.execute('query.execute', undefined, 'keybinding')).toBe(true)
    } })
    expect(requested).toEqual([pendingId])
    const execute = vi.spyOn(view.queries, 'execute').mockResolvedValue()
    view.api.connect.mockResolvedValue({ ok: true, value: info })
    view.onConnected.mockImplementation(async (receipt, chosen, preference, attempt, requestId) => {
      const opened = await acceptConnectionReceipt({ ...view, api: view.api, info: receipt, options: chosen, details: detailsOf(chosen, preference), attempt, requestId })
      expect(opened?.targetId).toBe(targetId)
      view.targets.attachTarget(targetId, handle, true)
      await executePendingQuery({ ...view, tabId: pendingId, opened: opened! })
    })
    await act(async () => view.button('Connect').click())
    expect(view.api.connect).toHaveBeenCalledOnce()
    expect(view.api.connect.mock.calls[0][1]).toMatchObject({ mode: 'interactive', expectedPrincipal: authentication.principal })
    expect(view.api.connect.mock.calls[0][1]?.targetId).not.toBe(targetId)
    expect(view.connectionTargets.getSnapshot()).toHaveLength(1)
    expect(execute).toHaveBeenCalledExactlyOnceWith(pendingId)
    expect(view.documents.get(pendingId)).toMatchObject({ connectionId: handle, targetId, attachWanted: true, database: 'Sales' })
    expect(view.documents.get(siblingId)).toMatchObject({ connectionId: undefined, targetId, attachWanted: false, database: 'Archive' })
  })
})

describe('Reset and the form environment', () => {
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  it('forgets the environment the user set before Reset, so typing that server again shows and keeps its saved label', async () => {
    const saved: ConnectionProfile = { id: id(9), options: { ...connectionDefaults('win32'), server: 'sql-prod-01', environment: 'Production' }, favorite: false, registered: false }
    const view = await mount(undefined, { profiles: [saved] })
    const server = () => view.host.querySelector<HTMLInputElement>('#connect-server')!
    const environment = () => view.host.querySelector<HTMLSelectElement>('#connect-environment')!
    await type(server(), 'sql-prod-01')
    expect(environment().value).toBe('Production')
    await act(async () => { environment().value = 'Staging'; environment().dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => view.button('Reset').click())
    // Typed again after Reset, the server shows its saved label once more, and Connect does not claim the form set one.
    await type(server(), 'sql-prod-01')
    expect(environment().value).toBe('Production')
    await act(async () => view.button('Connect').click())
    expect(view.api.connect).toHaveBeenCalledTimes(1)
    expect(view.api.connect.mock.calls[0]?.[1]).not.toHaveProperty('setsEnvironment')
  })
})

const pick = async (view: Awaited<ReturnType<typeof mount>>, selector: string, value: string) => {
  const field = view.host.querySelector<HTMLSelectElement | HTMLInputElement>(selector)!
  await act(async () => {
    if (field instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    else field.value = value
    field.dispatchEvent(new Event(field instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }))
  })
}
const prompt = () => document.body.querySelector<HTMLElement>('.sub-dialog')
const promptButton = (label: string) => [...prompt()!.querySelectorAll('button')].find(value => value.textContent === label)!
describe('saving connection details', () => {
  const live = (options: ConnectionOptions, details = detailsOf(options, 'off')) => (workbench: ReturnType<typeof workbenchFixture>) => {
    const authentication = { principal: { provider: 'sqlserver' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
    const attempt = workbench.connections.beginConnect(options, 1, id(50), details)!
    workbench.connections.accept({ id: id(100), targetId: id(50), generation: 1, server: options.server, database: options.database, serverVersion: '17', authentication }, options, id(50), authentication, attempt)
  }

  it('applies a saved name, color and environment to the live Explorer connection at once', async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved], beforeRender: live(saved.options) })
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    await pick(view, 'input[type="color"]', '#e51400')
    await pick(view, '#connect-environment', 'Production')
    await pick(view, '#connect-auto-reconnect', 'on')
    expect(view.connections.get(id(50))).toMatchObject({ displayName: 'Off profile' })
    await act(async () => view.button('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: saved.id, autoReconnect: 'on' }))
    expect(view.connections.get(id(50))).toMatchObject({ displayName: 'Renamed', color: '#e51400', environment: 'Production' })
    expect(view.connectionTargets.get(id(50))?.details).toEqual({ displayName: 'Renamed', color: '#e51400', environment: 'Production', autoReconnect: 'on' })
  })

  it('leaves Explorer connections for another server alone', async () => {
    const saved = profile('Off profile', 1, 'off'), other = profile('Other', 2, 'off')
    const view = await mount(undefined, { profiles: [saved, other], beforeRender: live(other.options) })
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    await act(async () => view.button('Save').click())
    expect(view.connections.get(id(50))).toMatchObject({ displayName: 'Other' })
  })

  it('asks before Cancel, Close or Escape drops edits to a saved connection', async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved] })
    await view.choose('Off profile')
    await pick(view, '#connect-environment', 'Production')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save changes to Off profile?')
    // Cancel in the prompt keeps editing; the form keeps its edit.
    await act(async () => promptButton('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.host.querySelector<HTMLSelectElement>('#connect-environment')!.value).toBe('Production')
    await act(async () => view.host.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(prompt()).not.toBeNull()
    await act(async () => promptButton('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: saved.id, options: expect.objectContaining({ environment: 'Production' }) }))
    expect(view.closed).toHaveBeenCalledOnce()
  })

  it("closes without saving on Don't Save, and without asking when nothing changed or the edits are saved", async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved] })
    await view.choose('Off profile')
    await act(async () => view.button('Close connection dialog').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledTimes(1)
    await pick(view, '#connect-name', 'Renamed')
    await act(async () => view.button('Close connection dialog').click())
    await act(async () => promptButton("Don't Save").click())
    expect(view.closed).toHaveBeenCalledTimes(2)
    expect(view.saveConnectionProfile).not.toHaveBeenCalled()
    await pick(view, '#connect-name', 'Saved name')
    await act(async () => view.button('Save').click())
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledTimes(3)
  })

  it('leaves a live connection-only label alone when a save changes no labels', async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved], beforeRender: live(saved.options, { ...detailsOf(saved.options, 'off'), environment: 'Staging' }) })
    await view.choose('Off profile')
    await act(async () => view.button('Register server').click())
    await act(async () => view.button('Unfavorite Off profile').click())
    expect(view.saveConnectionProfile).toHaveBeenCalledTimes(2)
    expect(view.connections.get(id(50))).toMatchObject({ environment: 'Staging' })
  })

  it('asks about edits to an alias the form found by its labels, and saves them to that alias', async () => {
    const first = profile('First alias', 1, 'off'), second = { ...profile('Second alias', 2, 'on'), options: { ...first.options, displayName: 'Second alias' } }
    const view = await mount(undefined, { profiles: [first, second], initial: second.options })
    await pick(view, '#connect-name', 'Renamed alias')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save changes to Second alias?')
    await act(async () => promptButton('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: second.id, options: expect.objectContaining({ displayName: 'Renamed alias' }) }))
  })

  it('keeps the environment main kept when Connect saves edited details from a form without one', async () => {
    const plain = profile('First alias', 1, 'off'), first = { ...plain, options: { ...plain.options, environment: 'Production' } }, second = { ...profile('Second alias', 2, 'on'), options: { ...first.options, displayName: 'Second alias' } }
    const view = await mount(undefined, { profiles: [first, second], initial: { ...first.options, displayName: '', environment: undefined } })
    view.api.connect.mockImplementation(async (value, context) => { const options = value as ConnectionOptions; return { ok: true, value: { id: id(100), targetId: context!.targetId, server: options.server, database: options.database, generation: 1, serverVersion: '17', environment: 'Production', authentication: { principal: { provider: 'sqlserver', authentication: options.authentication, id: 'sid:fixture' } } } } })
    await pick(view, '#connect-name', 'Named now')
    await act(async () => view.button('Connect').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ displayName: 'Named now', environment: 'Production' }) }))
  })

  const aliasPair = () => {
    const first = profile('First alias', 1, 'off'), second = { ...profile('Second alias', 2, 'on'), options: { ...first.options, displayName: 'Second alias' } }
    return [first, second] as const
  }

  it('saves other settings on a prefilled form as a new entry instead of overwriting the one it began from', async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved], initial: saved.options })
    await pick(view, '#connect-database', 'OtherDb')
    await act(async () => view.button('Add favorite').click())
    expect(view.saveConnectionProfile.mock.calls.at(-1)?.[0].id).toBeUndefined()
  })

  it('forgets label edits when the server changes, so Connect asks again for the new server', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Edited')
    await pick(view, '#connect-server', 'server-2')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toEqual([])
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
  })

  it('does not treat a name typed back to where it began as a change', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Edited')
    await pick(view, '#connect-name', 'Off profile')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toEqual([])
  })

  it('tracks the alias when Reconnect on startup is the first edit, and Connect saves to that alias', async () => {
    const [first, second] = aliasPair(), view = await mount(undefined, { profiles: [first, second], initial: second.options })
    await pick(view, '#connect-auto-reconnect', 'off')
    await pick(view, '#connect-name', 'Renamed alias')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save changes to Second alias?')
    await act(async () => promptButton('Cancel').click())
    await act(async () => view.button('Connect').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: second.id, options: expect.objectContaining({ displayName: 'Renamed alias' }) }))
  })

  it('does not ask when only a password changed on a form that began unlike its entry', async () => {
    const saved: ConnectionProfile = { ...profile('Saved name', 1, 'off'), options: { ...profile('Saved name', 1).options, authentication: 'sql', username: 'reader' } }
    const view = await mount(undefined, { profiles: [saved], initial: { ...saved.options, displayName: 'Connection name' } })
    await pick(view, '#connect-password', 'secret')
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledOnce()
  })

  it('applies only the labels a save changed, keeping a connection-only environment', async () => {
    const saved = profile('Off profile', 1, 'off'), view = await mount(undefined, { profiles: [saved], beforeRender: live(saved.options, { ...detailsOf(saved.options, 'off'), environment: 'Staging' }) })
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    await act(async () => view.button('Save').click())
    expect(view.connections.get(id(50))).toMatchObject({ displayName: 'Renamed', environment: 'Staging' })
  })

  it('saves labels from Connect to the entry main recorded, not a chosen entry whose settings changed', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-database', 'OtherDb')
    await pick(view, '#connect-name', 'Other database')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toEqual(['displayName'])
    expect(view.saveConnectionProfile.mock.calls.at(-1)?.[0]).toMatchObject({ id: undefined, options: expect.objectContaining({ database: 'OtherDb', displayName: 'Other database' }) })
  })

  it('reports a failed History save after Connect where Connect reports history warnings', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    view.saveConnectionProfile.mockResolvedValueOnce({ ok: false, error: 'The settings file is locked.' })
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[0]).toMatchObject({ historyWarning: 'Connected, but the changed name, color or environment could not be saved to History.' })
  })

  it('does not offer to save edits onto another entry the changed settings now match', async () => {
    const first = profile('First', 1, 'off'), other = { ...profile('Other', 2, 'off'), options: { ...first.options, database: 'OtherDb', displayName: 'Other' } }
    const view = await mount(undefined, { profiles: [first, other], initial: first.options })
    await pick(view, '#connect-database', 'OtherDb')
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
  })

  it('counts only labels the user edited, not an entry label filled in after editing began', async () => {
    const master = profile('Master', 1, 'off'), sales = { ...profile('Sales', 2, 'off'), options: { ...master.options, database: 'sales', displayName: 'Sales', environment: 'Production' } }
    const view = await mount(undefined, { profiles: [master, sales], initial: master.options })
    await pick(view, '#connect-database', 'sales')
    expect(view.host.querySelector<HTMLSelectElement>('#connect-environment')!.value).toBe('Production')
    await pick(view, '#connect-name', 'Sales reporting')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toEqual(['displayName'])
  })

  it("saves only the changed labels from Connect, keeping the entry's others", async () => {
    const saved = profile('Saved name', 1, 'off'), view = await mount(undefined, { profiles: [saved], initial: { ...saved.options, displayName: 'Connection name' } })
    await pick(view, 'input[type="color"]', '#e51400')
    await act(async () => view.button('Connect').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: saved.id, options: expect.objectContaining({ displayName: 'Saved name', color: '#e51400' }), autoReconnect: 'off' }))
  })

  it('asks about and saves to the same alias when the labels are retyped to match another', async () => {
    const [first, second] = aliasPair(), view = await mount(undefined, { profiles: [first, second], initial: second.options })
    await pick(view, '#connect-name', 'First alias')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save changes to Second alias?')
    await act(async () => promptButton('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: second.id }))
  })

  it('applies only the changed labels when a save without an id updates the entry with these settings', async () => {
    const first = profile('First', 1, 'off'), other = { ...profile('Other', 2, 'off'), options: { ...first.options, database: 'OtherDb', displayName: 'Other' } }
    const view = await mount(undefined, { profiles: [first, other], initial: first.options, beforeRender: live(other.options, { ...detailsOf(other.options, 'off'), environment: 'Staging' }) })
    await pick(view, '#connect-name', 'Renamed other')
    await pick(view, '#connect-database', 'OtherDb')
    await act(async () => view.button('Save').click())
    expect(view.saveConnectionProfile.mock.calls.at(-1)?.[0].id).toBeUndefined()
    expect(view.connections.get(id(50))).toMatchObject({ displayName: 'Renamed other', environment: 'Staging' })
  })

  it('sends main the alias the edits began on, so the reconnect policy lands with the labels', async () => {
    const [first, second] = aliasPair(), view = await mount(undefined, { profiles: [first, second], initial: second.options })
    await pick(view, '#connect-name', 'Renamed alias')
    await act(async () => view.button('Connect').click())
    expect(view.api.connect.mock.calls[0]?.[1]).toMatchObject({ selectedProfileId: second.id })
  })

  it('keeps nothing in History when Stop ends a connect that main then answers', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    const answer = deferred<Awaited<ReturnType<VariaApi['connect']>>>()
    view.api.connect.mockImplementationOnce(() => answer.promise)
    await act(async () => view.button('Connect').click())
    await act(async () => view.button('Stop').click())
    await act(async () => answer.resolve({ ok: true, value: { id: id(100), server: 'server-1', database: '', generation: 1, serverVersion: '17', authentication: { principal: { provider: 'sqlserver', authentication: 'windows', id: 'sid:fixture' } } } }))
    expect(view.saveConnectionProfile).not.toHaveBeenCalled()
  })

  it('holds Stop and Escape while Connect writes the changed labels to History', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await pick(view, '#connect-name', 'Renamed')
    const write = deferred<Awaited<ReturnType<VariaApi['saveConnectionProfile']>>>()
    view.saveConnectionProfile.mockImplementationOnce(() => write.promise)
    await act(async () => { view.button('Connect').click() })
    expect(view.saveConnectionProfile).toHaveBeenCalledOnce()
    expect(view.button('Stop').disabled).toBe(true)
    const cancels = view.api.cancelConnectionRequests.mock.calls.length
    await act(async () => view.host.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(view.api.cancelConnectionRequests.mock.calls.length).toBe(cancels)
    await act(async () => write.resolve({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [] } }))
    expect(view.onConnected).toHaveBeenCalledOnce()
  })

  it('gives a new connection the same labels Connect records in History', async () => {
    const chosen = profile('Chosen', 1, 'on'), reporting = { ...profile('Reporting', 2, 'off'), options: { ...chosen.options, database: 'OtherDb', displayName: 'Reporting', color: '#00aa00' } }
    const view = await mount(undefined, { profiles: [chosen, reporting] })
    await view.choose('Chosen')
    await pick(view, '#connect-database', 'OtherDb')
    await pick(view, 'input[type="color"]', '#e51400')
    await act(async () => view.button('Connect').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: reporting.id, options: expect.objectContaining({ displayName: 'Reporting', color: '#e51400' }), autoReconnect: 'off' }))
    expect(view.onConnected.mock.calls[0]?.[1]).toMatchObject({ displayName: 'Reporting', color: '#e51400' })
    expect(view.onConnected.mock.calls[0]?.[2]).toBe('off')
  })

  it('tells Connect which details the user edited, so a reused connection takes them without asking again', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toEqual([])
    expect(view.saveConnectionProfile).not.toHaveBeenCalled()
    await view.choose('On profile')
    await pick(view, 'input[type="color"]', '#e51400')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[1]?.[6]).toEqual(['color'])
    // Main records no labels when it reuses a live connection: the dialog saves them to that History entry itself.
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: id(2), options: expect.objectContaining({ color: '#e51400' }), autoReconnect: 'on' }))
  })
})

describe('changed details on a reused connection', () => {
  const opened = (reused: boolean): OpenedConnection => ({
    id: 'handle', targetId: 'target', generation: 1, bindingRevision: 0, reused,
    current: { displayName: 'Old', color: '#111111', environment: 'Staging', autoReconnect: 'off' },
    selected: { displayName: 'New', color: '#222222', environment: 'Production', autoReconnect: 'on' }
  })
  it('applies only the changed fields to a reused connection and keeps its other labels', () => {
    expect(withChangedDetails(opened(true), ['displayName']).selected).toEqual({ displayName: 'New', color: '#111111', environment: 'Staging', autoReconnect: 'off' })
  })
  it('leaves a new connection with every selected detail', () => {
    expect(withChangedDetails(opened(false), ['displayName']).selected).toEqual(opened(false).selected)
  })
})

describe('Save and Test Connection', () => {
  const sqlProfile = (): ConnectionProfile => ({ ...profile('Sql profile', 7), options: { ...connectionDefaults('win32'), server: 'server-7', displayName: 'Sql profile', authentication: 'sql', username: 'reader' } })
  const type = async (view: Awaited<ReturnType<typeof mount>>, selector: string, value: string) => {
    const field = view.host.querySelector<HTMLInputElement>(selector)!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const discover = (answer: Awaited<ReturnType<VariaApi['discoverDatabases']>>) => {
    const fn = vi.fn<VariaApi['discoverDatabases']>(async () => answer)
    ;(window as unknown as { varia: VariaApi }).varia.discoverDatabases = fn
    return fn
  }
  const text = (view: Awaited<ReturnType<typeof mount>>) => view.host.textContent ?? ''
  const remember = (view: Awaited<ReturnType<typeof mount>>) => [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(box => box.parentElement?.textContent === 'Remember password')!

  it('checks a typed password with the server before Save remembers it, and saves nothing when the check fails', async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id] })
    await view.choose('Sql profile')
    expect(remember(view).checked).toBe(true)
    await type(view, '#connect-password', 'new-secret')
    expect(text(view)).toContain('Save checks this password with the server, then remembers it.')
    const failing = discover({ ok: false, error: 'Login failed.', code: 'SQL_ERROR', details: { number: 18456, state: 8, class: 14 } })
    view.saveConnectionProfile.mockClear()
    await act(async () => view.button('Save').click())
    expect(failing).toHaveBeenCalledWith(expect.objectContaining({ password: 'new-secret' }), expect.objectContaining({ remember: true }))
    expect(view.saveConnectionProfile).not.toHaveBeenCalled()
    expect(text(view)).toContain('Login failed.')
    const passing = discover({ ok: true, value: [] })
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [saved.id], passwordSaved: true, passwordReplaced: true } }))
    await act(async () => view.button('Save').click())
    expect(passing).toHaveBeenCalledOnce()
    expect(view.saveConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id, saved: true, rememberPassword: true, options: expect.objectContaining({ password: 'new-secret' }) }))
    expect(text(view)).toContain('Saved to History. The new password is remembered.')
    expect(view.host.querySelector<HTMLInputElement>('#connect-password')!.value).toBe('')
  })

  it('forgets the saved password when Remember password is unchecked and saved, as Connect does', async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id] })
    await view.choose('Sql profile')
    await act(async () => remember(view).click())
    expect(text(view)).toContain('Save or Connect forgets the saved password.')
    await type(view, '#connect-password', 'typed')
    expect(text(view)).toContain('Save keeps the settings and forgets the saved password; it does not keep this one either.')
    const check = discover({ ok: true, value: [] })
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [], passwordForgotten: true } }))
    await act(async () => view.button('Save').click())
    expect(check).not.toHaveBeenCalled()
    expect(view.saveConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id, forgetPassword: true }))
    expect(view.saveConnectionProfile.mock.calls.at(-1)?.[0]).not.toHaveProperty('rememberPassword')
    expect(text(view)).toContain('The saved password was forgotten, and the typed one was not kept.')
  })

  it('says Object Explorer connections using the old password will need the new one', async () => {
    const saved = sqlProfile(), targetId = id(60)
    const authentication = { principal: { provider: 'sqlserver' as const, authentication: 'sql' as const, id: 'sid:reader' }, credential: { profileId: saved.id, revision: id(61) } }
    const view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id], beforeRender: workbench => {
      const attempt = workbench.connections.beginConnect(saved.options, 1, targetId, detailsOf(saved.options, 'inherit'))!
      workbench.connections.accept({ id: id(62), targetId, generation: 1, server: saved.options.server, database: '', serverVersion: '17', authentication }, saved.options, targetId, authentication, attempt)
    } })
    await view.choose('Sql profile')
    await type(view, '#connect-password', 'new-secret')
    expect(text(view)).toContain('If it differs from the saved one, Object Explorer connections that use the saved one will need the new password entered when they next connect.')
    // After Save, the notice says they need it only when main replaced the password.
    discover({ ok: true, value: [] })
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [saved.id], passwordSaved: true, passwordReplaced: true } }))
    await act(async () => view.button('Save').click())
    expect(text(view)).toContain('Object Explorer connections that used the old one will need it entered when they next connect.')
    await type(view, '#connect-password', 'new-secret')
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [saved.id], passwordSaved: true, passwordReplaced: false } }))
    await act(async () => view.button('Save').click())
    expect(text(view)).toContain('Saved to History. The password is remembered.')
    expect(text(view)).not.toContain('will need it entered')
  })

  it("closes on the close prompt's Save when Remember password was the user's choice", async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved] })
    await view.choose('Sql profile')
    await pick(view, '#connect-name', 'Renamed')
    await type(view, '#connect-password', 'typed')
    await act(async () => view.button('Cancel').click())
    await act(async () => promptButton('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: saved.id, options: expect.objectContaining({ displayName: 'Renamed' }) }))
    expect(view.closed).toHaveBeenCalledOnce()
  })

  it("says when saving other certificate settings forgot the remembered password, and the close prompt's Save stays open", async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id] })
    await view.choose('Sql profile')
    await act(async () => [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(box => box.parentElement?.textContent === 'Trust server certificate')!.click())
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [] } }))
    await act(async () => view.button('Cancel').click())
    await act(async () => promptButton('Save').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: saved.id, options: expect.objectContaining({ trustServerCertificate: true }) }))
    expect(text(view)).toContain('The saved password was for the old settings, so it was forgotten')
    expect(view.closed).not.toHaveBeenCalled()
  })

  it('waits for a running Load databases before Test Connection signs in, and Stop ends both', async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id] })
    await view.choose('Sql profile')
    let answer!: (value: Awaited<ReturnType<VariaApi['discoverDatabases']>>) => void
    const calls = vi.fn<VariaApi['discoverDatabases']>(() => new Promise(resolve => { answer = resolve }))
    ;(window as unknown as { varia: VariaApi }).varia.discoverDatabases = calls
    await act(async () => view.button('Load databases').click())
    await act(async () => view.button('Test Connection').click())
    expect(calls).toHaveBeenCalledOnce()
    // Load databases finds the remembered password rejected: the form forgets it, and Test does not sign in again
    // without one (another failed login would count toward a lockout policy).
    await act(async () => answer({ ok: false, error: 'Login failed.', code: 'SQL_ERROR', passwordForgotten: true }))
    expect(calls).toHaveBeenCalledOnce()
    expect(remember(view).checked).toBe(false)
    expect(text(view)).toContain('The saved password was rejected, so it has been removed. Enter the password.')
    // With a typed password, Test signs in once Load databases has finished.
    await type(view, '#connect-password', 'typed')
    await act(async () => view.button('Load databases').click())
    await act(async () => view.button('Test Connection').click())
    expect(calls).toHaveBeenCalledTimes(2)
    await act(async () => answer({ ok: true, value: [] }))
    expect(calls).toHaveBeenCalledTimes(3)
    expect(calls.mock.calls[2][0]).toMatchObject({ password: 'typed' })
    await act(async () => answer({ ok: true, value: [] }))
    expect(text(view)).toContain('Connected to server-7')
    // Stop while Test waits cancels the Load databases quietly and sends no Test.
    await act(async () => view.button('Load databases').click())
    const loading = calls.mock.calls[3][1]?.requestId
    await act(async () => view.button('Test Connection').click())
    await act(async () => view.button('Stop').click())
    expect(view.api.cancelConnectionRequests).toHaveBeenCalledWith([loading])
    await act(async () => answer({ ok: false, error: 'Cancelled.', code: 'CANCELLED' }))
    expect(calls).toHaveBeenCalledTimes(4)
    expect(text(view)).toContain('Test cancelled.')
    expect(text(view)).not.toContain('Could not load databases')
  })

  it('says a remembered password was forgotten only when the saved settings changed', async () => {
    const saved = sqlProfile(), view = await mount(undefined, { profiles: [saved], savedPasswords: [saved.id] })
    await view.choose('Sql profile')
    await pick(view, '#connect-name', 'Renamed')
    // Storage unavailable after the dialog loaded lists no passwords; the settings are the same, so none was forgotten.
    view.saveConnectionProfile.mockImplementationOnce(async () => ({ ok: true, value: { library: { version: 1, profiles: view.profiles() }, savedPasswords: [] } }))
    await act(async () => view.button('Save').click())
    expect(text(view)).toContain('Saved to History.')
    expect(text(view)).not.toContain('was for the old')
  })

  it('offers to trust the certificate and test again after a failed test, without connecting', async () => {
    const view = await mount()
    await type(view, '#connect-server', 'cert-server')
    const failing = discover({ ok: false, error: 'The certificate chain was issued by an authority that is not trusted.', code: 'SQL_ERROR', details: { number: -2146893019, state: 0, class: 20, server: 'cert-server', reason: 'certificate' } })
    await act(async () => view.button('Test Connection').click())
    expect(failing).toHaveBeenCalledOnce()
    const passing = discover({ ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }] })
    await act(async () => view.button('Trust server certificate and test').click())
    expect(passing).toHaveBeenCalledWith(expect.objectContaining({ trustServerCertificate: true }), expect.anything())
    expect(view.api.connect).not.toHaveBeenCalled()
    expect(text(view)).toContain('Connected to cert-server')
  })

  it('tests again with the password remembered for the trusted settings after Trust server certificate', async () => {
    const trusted = { ...sqlProfile(), options: { ...sqlProfile().options, trustServerCertificate: true } }
    const view = await mount(undefined, { profiles: [trusted], savedPasswords: [trusted.id], initial: { ...trusted.options, displayName: '', trustServerCertificate: false } })
    discover({ ok: false, error: 'The certificate chain was issued by an authority that is not trusted.', code: 'SQL_ERROR', details: { number: -2146893019, state: 0, class: 20, server: 'server-7', reason: 'certificate' } })
    await act(async () => view.button('Test Connection').click())
    const passing = discover({ ok: true, value: [] })
    await act(async () => view.button('Trust server certificate and test').click())
    expect(passing).toHaveBeenCalledWith(expect.objectContaining({ trustServerCertificate: true, password: '' }), expect.objectContaining({ profileId: trusted.id }))
  })
})

describe('closing with a new, unsaved connection', () => {
  const prompt = () => document.body.querySelector<HTMLElement>('.sub-dialog')
  const promptButton = (label: string) => [...prompt()!.querySelectorAll('button')].find(value => value.textContent === label)!
  const type = async (view: Awaited<ReturnType<typeof mount>>, selector: string, value: string) => {
    const field = view.host.querySelector<HTMLInputElement>(selector)!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('asks before dropping a filled-in connection; Don\'t Save closes and Cancel keeps editing', async () => {
    const view = await mount()
    await type(view, '#connect-server', 'brand-new')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save brand-new to History?')
    await act(async () => promptButton('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).not.toHaveBeenCalled()
    await act(async () => view.button('Cancel').click())
    await act(async () => promptButton("Don't Save").click())
    expect(view.closed).toHaveBeenCalledOnce()
  })

  it('asks after Trust server certificate changed an opened form the user did not otherwise edit', async () => {
    const view = await mount(undefined, { initial: { ...connectionDefaults('win32'), server: 'cert-server' } })
    const varia = (window as unknown as { varia: VariaApi }).varia
    varia.discoverDatabases = vi.fn<VariaApi['discoverDatabases']>(async () => ({ ok: false, error: 'The certificate chain was issued by an authority that is not trusted.', code: 'SQL_ERROR', details: { number: -2146893019, state: 0, class: 20, server: 'cert-server', reason: 'certificate' } }))
    await act(async () => view.button('Test Connection').click())
    varia.discoverDatabases = vi.fn<VariaApi['discoverDatabases']>(async () => ({ ok: true, value: [] }))
    await act(async () => view.button('Trust server certificate and test').click())
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save cert-server to History?')
  })

  it('asks for a new connection whose Custom environment label is still blank', async () => {
    // Opened blank, as on Linux and macOS, where the default server is empty.
    const view = await mount(undefined, { profiles: [], initial: { ...connectionDefaults('win32'), server: '' } })
    await type(view, '#connect-server', 'label-server')
    await pick(view, '#connect-environment', 'custom')
    await act(async () => view.button('Cancel').click())
    expect(prompt()?.textContent).toContain('Save label-server to History?')
  })

  it('does not ask for a typed password alone, a form typed back to how it opened, or settings a saved entry has', async () => {
    const initial = { ...connectionDefaults('win32'), server: 'fresh', authentication: 'sql' as const, username: 'reader' }
    let view = await mount(undefined, { initial })
    await type(view, '#connect-password', 'typed-only')
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledOnce()
    view = await mount(undefined, { initial })
    await type(view, '#connect-server', 'elsewhere')
    await type(view, '#connect-server', 'fresh')
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledOnce()
    // Several entries share these settings and the empty labels name none of them: their Save would overwrite one.
    const first = profile('First alias', 1), second = { ...profile('Second alias', 2), options: { ...first.options, displayName: 'Second alias' } }
    view = await mount(undefined, { profiles: [first, second] })
    await type(view, '#connect-server', first.options.server)
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledOnce()
  })

  it('does not offer to save back an entry the user removed while editing it', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await type(view, '#connect-name', 'Edited')
    const remaining = view.profiles().filter(value => value.options.displayName !== 'Off profile')
    ;(window as unknown as { varia: VariaApi }).varia.removeConnectionProfile = vi.fn<VariaApi['removeConnectionProfile']>(async () => ({ ok: true, value: { library: { version: 1, profiles: remaining }, savedPasswords: [] } }))
    await act(async () => view.button('Remove saved Off profile').click())
    await act(async () => view.button('Cancel').click())
    expect(prompt()).toBeNull()
    expect(view.closed).toHaveBeenCalledOnce()
  })
})

describe('Connect v2 sidebar deduplication, filter clear and Undo', () => {
  it('deduplicates Favorites out of Recent Connections, clears filter via the clear button, and restores removed profiles on Undo', async () => {
    const fav = { ...profile('Primary Prod', 10, 'inherit'), lastConnected: '2026-11-12T10:00:00.000Z' }
    const recentOnly = { ...profile('Staging Db', 11, 'inherit'), favorite: false, lastConnected: '2026-11-11T10:00:00.000Z' }
    const view = await mount(undefined, { profiles: [fav, recentOnly] })
    const choices = () => [...view.host.querySelectorAll('.connection-choice strong')].map(el => el.textContent)
    expect(choices()).toEqual(['Primary Prod', 'Staging Db'])
    const filter = view.host.querySelector<HTMLInputElement>('.connection-filter')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'Primary')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(choices()).toEqual(['Primary Prod'])
    await act(async () => view.button('Clear filter').click())
    expect(filter.value).toBe('')
    expect(choices()).toEqual(['Primary Prod', 'Staging Db'])
    ;(window as unknown as { varia: VariaApi }).varia.removeConnectionProfile = vi.fn<VariaApi['removeConnectionProfile']>(async () => ({ ok: true, value: { library: { version: 1, profiles: [fav] }, savedPasswords: [] } }))
    await act(async () => view.button('Remove saved Staging Db').click())
    expect(choices()).toEqual(['Primary Prod'])
    await act(async () => view.button('Undo').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ saved: true, registered: false, favorite: false, options: recentOnly.options }))
  })
  it('syncs open Connect dialog on explicit Reconnect without clobbering edits on plain raise, and clears typed passwords on connection string paste', async () => {
    const view = await mount()
    await pick(view, '#connect-server', 'in-progress-server')
    await view.reopen(undefined, { raise: 2, reconnectSeq: 0, initial: { ...connectionDefaults('win32'), server: 'ignored-on-raise' } })
    expect(view.host.querySelector<HTMLInputElement>('#connect-server')!.value).toBe('in-progress-server')
    await view.reopen('off', { raise: 3, reconnectSeq: 1, initial: { ...connectionDefaults('win32'), server: 'reconnected-server', authentication: 'sql', username: 'reader' } })
    expect(view.host.querySelector<HTMLInputElement>('#connect-server')!.value).toBe('reconnected-server')
    await pick(view, '#connect-password', 'old-secret')
    await act(async () => view.button('Connection String').click())
    const pasteBox = view.host.querySelector<HTMLTextAreaElement>('#connect-paste-string')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(pasteBox, 'Server=other-server;User ID=new_reader;')
      pasteBox.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => view.button('Parse & Fill Form').click())
    await act(async () => view.button('Connection Properties').click())
    expect(view.host.querySelector<HTMLInputElement>('#connect-server')!.value).toBe('other-server')
    expect(view.host.querySelector<HTMLInputElement>('#connect-password')!.value).toBe('')
  })
  it('keeps focus on a row star button after favoriting moves that row from Recent Connections into Favorites', async () => {
    const recent = { ...profile('Recent Move', 21, 'inherit'), favorite: false, lastConnected: '2026-11-11T10:00:00.000Z' }
    const view = await mount(undefined, { profiles: [recent] })
    const star = view.button('Favorite Recent Move')
    star.focus()
    expect(document.activeElement).toBe(star)
    await act(async () => star.click())
    const moved = view.button('Unfavorite Recent Move')
    expect(document.activeElement).toBe(moved)
  })
  it('parks focus on the dialog and restores it to Remove favorite after Add favorite completes asynchronously', async () => {
    const saved = { ...profile('Deferred Fav', 22, 'inherit'), favorite: false, saved: true }
    const view = await mount(undefined, { profiles: [saved] })
    await view.choose('Deferred Fav')
    const favButton = view.button('Add favorite')
    favButton.getClientRects = () => [{} as DOMRect] as unknown as DOMRectList
    favButton.focus()
    expect(document.activeElement).toBe(favButton)
    const pending = deferred<Awaited<ReturnType<VariaApi['saveConnectionProfile']>>>()
    view.saveConnectionProfile.mockImplementationOnce(() => pending.promise)
    await act(async () => favButton.click())
    const dialogEl = view.host.querySelector<HTMLElement>('[role="dialog"]')!
    expect(favButton.disabled).toBe(true)
    expect(document.activeElement).toBe(dialogEl)
    const updated = { ...saved, favorite: true }
    await act(async () => pending.resolve({ ok: true, value: { library: { version: 1, profiles: [updated] }, savedPasswords: [] } }))
    expect(document.activeElement).toBe(view.button('Remove favorite'))
  })
})
