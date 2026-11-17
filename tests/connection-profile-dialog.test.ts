// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import ConnectDialog from '../src/renderer/src/ConnectDialog'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ConnectionLibrary, ConnectionProfile } from '../src/shared/connections'
import type { ConnectionOptions, VariaApi } from '../src/shared/contracts'
import { connectionDefaults } from '../src/shared/connections'
import { readyBackend, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'
import { acceptConnectionReceipt } from '../src/renderer/src/services/connection-receipts'
import { detailsOf } from '../src/renderer/src/services/connections'
import { executePendingQuery, finishConnectionDetails, needsDetailsConfirmation } from '../src/renderer/src/services/connection-opening'

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
    return { ok: true, value: { library, savedPasswords: setup.savedPasswords ?? [], windowsIdentity: 'DOMAIN\\reader', passwordStorage: { available: true } } }
  })
  const saveConnectionProfile = vi.fn<VariaApi['saveConnectionProfile']>(async input => {
    library = { ...library, profiles: library.profiles.map(value => value.id === input.id ? { ...value, options: input.options, autoReconnect: input.autoReconnect, favorite: input.favorite ?? value.favorite, registered: input.registered ?? value.registered } : value) }
    return { ok: true, value: { library, savedPasswords: setup.savedPasswords ?? [] } }
  })
  workbench.api.connect.mockImplementation(async (options, context) => ({ ok: true, value: { id: id(100), targetId: context!.targetId, server: options.server, database: options.database, generation: 1, serverVersion: '17', authentication: { principal: { provider: 'sqlServer', authentication: options.authentication, id: 'sid:fixture' } } } }))
  const original = Object.getOwnPropertyDescriptor(window, 'varia')
  Object.defineProperty(window, 'varia', { configurable: true, value: { ...workbench.api, loadConnectionLibrary, saveConnectionProfile } })
  const onConnected = vi.fn<ComponentProps<typeof ConnectDialog>['onConnected']>(async () => {}), onClose = vi.fn()
  const theme = { ...workbench.theme, getSnapshot: () => workbench.theme.state, subscribe: () => () => {}, accent: (color?: string) => color }
  const renderer = { ...workbench, platform: 'win32', theme } as unknown as Workbench
  let key = 0
  const reopen = async (preference = initialAutoReconnect) => {
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: renderer, children: createElement(ConnectDialog, { key: ++key, initial: setup.initial ?? connectionDefaults('win32'), initialTargetId: setup.initialTargetId, initialAutoReconnect: preference, onConnected, onClose }) })))
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
    if (button('Custom Properties').getAttribute('aria-expanded') !== 'true') await act(async () => button('Custom Properties').click())
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
    const authentication = { principal: { provider: 'sqlServer' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
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
    expect(view.api.connect.mock.calls[0]?.[0].password).toBe('')
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
    expect(view.onConnected).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'off', expect.anything(), expect.any(String), expect.any(AbortSignal), true)
  })

  it('keeps a matching profile policy on ordinary live reuse while Keep Current preserves the target policy', async () => {
    const options = profile('Off profile', 1, 'off').options, targetId = id(50), handle = id(100)
    const authentication = { principal: { provider: 'sqlServer' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
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
    const authentication = { principal: { provider: 'sqlServer' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
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
    await act(async () => view.button('Custom Properties').click())
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

describe('saving connection details', () => {
  const live = (options: ConnectionOptions, details = detailsOf(options, 'off')) => (workbench: ReturnType<typeof workbenchFixture>) => {
    const authentication = { principal: { provider: 'sqlServer' as const, authentication: 'windows' as const, id: 'sid:fixture' } }
    const attempt = workbench.connections.beginConnect(options, 1, id(50), details)!
    workbench.connections.accept({ id: id(100), targetId: id(50), generation: 1, server: options.server, database: options.database, serverVersion: '17', authentication }, options, id(50), authentication, attempt)
  }
  const pick = async (view: Awaited<ReturnType<typeof mount>>, selector: string, value: string) => {
    if (view.button('Custom Properties').getAttribute('aria-expanded') !== 'true') await act(async () => view.button('Custom Properties').click())
    const field = view.host.querySelector<HTMLSelectElement | HTMLInputElement>(selector)!
    await act(async () => {
      if (field instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      else field.value = value
      field.dispatchEvent(new Event(field instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }))
    })
  }
  const prompt = () => document.body.querySelector<HTMLElement>('.sub-dialog')
  const promptButton = (label: string) => [...prompt()!.querySelectorAll('button')].find(value => value.textContent === label)!

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
    const first = profile('First alias', 1, 'off'), second = { ...profile('Second alias', 2, 'on'), options: { ...first.options, displayName: 'Second alias' } }
    const view = await mount(undefined, { profiles: [first, second], initial: { ...first.options, displayName: '' } })
    view.api.connect.mockImplementation(async (options, context) => ({ ok: true, value: { id: id(100), targetId: context!.targetId, server: options.server, database: options.database, generation: 1, serverVersion: '17', environment: 'Production', authentication: { principal: { provider: 'sqlServer', authentication: options.authentication, id: 'sid:fixture' } } } }))
    await pick(view, '#connect-name', 'Named now')
    await act(async () => view.button('Connect').click())
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ displayName: 'Named now', environment: 'Production' }) }))
  })

  it('tells Connect which details the user edited, so a reused connection takes them without asking again', async () => {
    const view = await mount()
    await view.choose('Off profile')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[0]?.[6]).toBe(false)
    expect(view.saveConnectionProfile).not.toHaveBeenCalled()
    await view.choose('On profile')
    await pick(view, 'input[type="color"]', '#e51400')
    await act(async () => view.button('Connect').click())
    expect(view.onConnected.mock.calls[1]?.[6]).toBe(true)
    // Main records no labels when it reuses a live connection: the dialog saves them to that History entry itself.
    expect(view.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: id(2), options: expect.objectContaining({ color: '#e51400' }), autoReconnect: 'on' }))
  })
})
