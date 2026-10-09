import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuCommand, ContextMenuRequest } from '../src/shared/commands/menus'
import { contextMenuRequestSchema } from '../src/shared/commands/menus'
import type { ApiResult } from '../src/shared/contracts'
import type { FocusAdapter } from '../src/renderer/src/core/focus'
import { MenuService } from '../src/renderer/src/menus/MenuService'
import { NativeMenuPresenter, nativeChoiceWindow, nativeMenuRequest, type NativeMenuHandlers } from '../src/renderer/src/menus/native'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { MenuTargetService } from '../src/renderer/src/menus/targets'
import { fakeDocument, FakeElement } from './fixtures/elements'
import { connectionInfo, connectionOptions, manualTimers, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })

/** Main's side of native menus: each request waits for the test to close its menu, and choices are sent by hand. */
function fakeMain() {
  const requests: { request: ContextMenuRequest; close: (result?: ApiResult<void>) => void; fail: (error: Error) => void }[] = []
  let listener: ((command: ContextMenuCommand) => void) | undefined
  const api = {
    showContextMenu: vi.fn(async (request: ContextMenuRequest) => {
      return new Promise<ApiResult<void>>((resolve, reject) => { requests.push({ request, close: (result = { ok: true, value: undefined }) => resolve(result), fail: reject }) })
    }),
    onContextMenuCommand: vi.fn((callback: (command: ContextMenuCommand) => void) => { listener = callback; return () => { listener = undefined } })
  }
  const choose = (command: unknown) => listener?.(command as ContextMenuCommand)
  return { api, requests, choose, subscribed: () => listener !== undefined }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const handlers = (): NativeMenuHandlers & { calls: string[] } => {
  const calls: string[] = []
  return { calls, closed: () => calls.push('closed'), failed: () => calls.push('failed') }
}

describe('native menu requests', () => {
  it('list a resolved menu\'s commands through its submenus, which are disabled and checked, and a whole-pixel point', () => {
    const fixture = workbenchFixture({ platform: 'darwin' })
    cleanups.push(fixture.dispose)
    const tab = fixture.documents.create('one.sql', 'SELECT 1', 'master', 'server-a')
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const items = fixture.menus.resolve('editor.context', { kind: 'editor', tabId: tab.id })
    const request = nativeMenuRequest(3, 'editor.context', items, { x: 10.6, y: -4 })
    expect(request).toEqual({
      token: 3, menu: 'editor.context', x: 11, y: 0,
      visible: ['connection.connect', 'query.disconnect', 'query.disconnectAll', 'query.changeConnection', 'query.execute', 'query.cancel', 'edit.cut', 'edit.copy', 'edit.paste', 'workbench.showCommands'],
      disabled: ['connection.connect', 'query.cancel'], checked: []
    })
    expect(contextMenuRequestSchema.safeParse(request).success).toBe(true)
    expect(nativeMenuRequest(1, 'editor.context', items, { x: 40000, y: Number.NaN })).toMatchObject({ x: 32767, y: 0 })
    // A toggle's check goes along; a theme choice's radio mark is not a command state.
    const toggles: ResolvedMenuItem[] = [
      { kind: 'command', key: 'a', id: 'editor.toggleWordWrap', title: 'Word Wrap', mnemonic: -1, enabled: true, checked: true },
      { kind: 'command', key: 'b', id: 'preferences.setTheme', title: 'Dark', mnemonic: -1, enabled: true, checked: true, radio: true },
      { kind: 'command', key: 'c', id: 'editor.toggleWordWrap', title: 'Word Wrap', mnemonic: -1, enabled: false, checked: false }
    ]
    expect(nativeMenuRequest(1, 'editor.context', toggles, { x: 0, y: 0 })).toMatchObject({ visible: ['editor.toggleWordWrap', 'preferences.setTheme'], disabled: [], checked: ['editor.toggleWordWrap'] })
  })
})

describe('native menu presenter', () => {
  function setup() {
    const main = fakeMain(), { timers, advance, pending } = manualTimers()
    const commands = { execute: vi.fn(async () => true) }
    const presenter = new NativeMenuPresenter({ api: main.api, commands, timers })
    cleanups.push(() => presenter.dispose())
    const items: ResolvedMenuItem[] = [
      { kind: 'command', key: 'explorer.copyName', id: 'explorer.copyName', title: 'Copy Name', mnemonic: 5, enabled: true, args: { tabId: 'copy' } },
      { kind: 'separator', key: 'sep:0' },
      { kind: 'submenu', key: 'explorer.scriptTableAs', title: 'Script Table as', mnemonic: 0, items: [
        { kind: 'command', key: 'explorer.scriptCreateToClipboard', id: 'explorer.scriptCreateToClipboard', title: 'Clipboard', mnemonic: 1, enabled: false, args: { tabId: 'script' } }
      ] }
    ]
    return { main, presenter, commands, items, advance, pending }
  }

  it('runs the chosen command with its own arguments, once, whether the choice comes before or after the close', async () => {
    const { main, presenter, commands, items } = setup()
    const first = handlers()
    presenter.show('explorer.context', items, { x: 5, y: 6 }, first)
    expect(main.requests[0].request).toEqual({ token: 1, menu: 'explorer.context', x: 5, y: 6, visible: ['explorer.copyName', 'explorer.scriptCreateToClipboard'], disabled: ['explorer.scriptCreateToClipboard'], checked: [] })
    // Linux reports the choice first; the command still re-checks that it can run.
    main.choose({ token: 1, id: 'explorer.scriptCreateToClipboard' })
    main.choose({ token: 1, id: 'explorer.copyName' })
    expect(commands.execute.mock.calls).toEqual([['explorer.scriptCreateToClipboard', { tabId: 'script' }, 'menu']])
    main.requests[0].close()
    await settle()
    expect(first.calls).toEqual(['closed'])
    // macOS reports the close first.
    presenter.show('explorer.context', items, { x: 5, y: 6 }, handlers())
    main.requests[1].close()
    await settle()
    main.choose({ token: 2, id: 'explorer.copyName' })
    expect(commands.execute.mock.calls.at(-1)).toEqual(['explorer.copyName', { tabId: 'copy' }, 'menu'])
    expect(main.requests[1].request.token).toBe(2)
  })
  it('ignores choices for another menu, for commands it did not show, malformed ones, and late ones', async () => {
    const { main, presenter, commands, items, advance, pending } = setup()
    presenter.show('explorer.context', items, { x: 0, y: 0 }, handlers())
    for (const command of [{ token: 2, id: 'explorer.copyName' }, { token: '1', id: 'explorer.copyName' }, { token: 1, id: 'explorer.refresh' }, { token: 1, id: 'nope' },
      { token: 1, id: '__proto__' }, { token: 1 }, null, 'explorer.copyName', 1]) main.choose(command)
    main.requests[0].close()
    await settle()
    advance(nativeChoiceWindow)
    main.choose({ token: 1, id: 'explorer.copyName' })
    expect(commands.execute).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    // A newer menu replaces an older one that is still open or just closed.
    presenter.show('explorer.context', items, { x: 0, y: 0 }, handlers())
    presenter.show('explorer.context', items, { x: 0, y: 0 }, handlers())
    main.choose({ token: 2, id: 'explorer.copyName' })
    advance(nativeChoiceWindow - 1)
    expect(commands.execute).not.toHaveBeenCalled()
    main.choose({ token: 3, id: 'explorer.copyName' })
    expect(commands.execute).toHaveBeenCalledTimes(1)
  })
  it('falls back when main cannot show the menu, unless a newer menu has replaced it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { main, presenter, commands, items } = setup()
    const refused = handlers(), rejected = handlers(), replaced = handlers()
    presenter.show('explorer.context', items, { x: 0, y: 0 }, refused)
    main.requests[0].close({ ok: false, error: 'Native context menus are not in use.' })
    await settle()
    main.choose({ token: 1, id: 'explorer.copyName' })
    presenter.show('explorer.context', items, { x: 0, y: 0 }, rejected)
    main.requests[1].fail(new Error('No window.'))
    await settle()
    presenter.show('explorer.context', items, { x: 0, y: 0 }, replaced)
    presenter.show('explorer.context', items, { x: 0, y: 0 }, handlers())
    main.requests[2].close({ ok: false, error: 'Replaced.' })
    await settle()
    expect([refused.calls, rejected.calls, replaced.calls]).toEqual([['failed'], ['failed'], ['closed']])
    expect(commands.execute).not.toHaveBeenCalled()
    // An API that throws instead of rejecting falls back too.
    main.api.showContextMenu.mockImplementationOnce(() => { throw new Error('Gone.') })
    const thrown = handlers()
    presenter.show('explorer.context', items, { x: 0, y: 0 }, thrown)
    await settle()
    expect(thrown.calls).toEqual(['failed'])
  })
  it('stops listening and forgets its menu when disposed', () => {
    const { main, presenter, commands, items } = setup()
    presenter.show('explorer.context', items, { x: 0, y: 0 }, handlers())
    presenter.dispose()
    expect(main.subscribed()).toBe(false)
    main.choose({ token: 1, id: 'explorer.copyName' })
    expect(commands.execute).not.toHaveBeenCalled()
  })
})

describe('menu service with native context menus', () => {
  /** Two query tabs and a text field in a dialog, over fake elements, with main's side faked. */
  function setup(options: { api?: boolean } = {}) {
    const state = { modal: false }
    const fixture = workbenchFixture({ platform: 'darwin', modal: () => state.modal })
    const main = fakeMain(), doc = fakeDocument()
    const first = fixture.documents.create('one.sql', 'SELECT 1', 'master'), second = fixture.documents.create('two.sql', 'SELECT 2', 'master')
    const tab = (id: string) => { const button = new FakeElement(doc, 'button', { className: 'tab-select' }); return { button, tab: new FakeElement(doc, 'div', { className: 'query-tab', attributes: { 'data-tab-id': id } }).append(button) } }
    const one = tab(first.id), two = tab(second.id)
    one.tab.rect = { left: 100, top: 40, right: 200, bottom: 68 }
    const field = new FakeElement(doc, 'input', { value: 'localhost', selectionStart: 0, selectionEnd: 5 })
    new FakeElement(doc, 'body').append(one.tab, two.tab, new FakeElement(doc, 'form', { attributes: { 'aria-modal': 'true' } }).append(field))
    const targets = new MenuTargetService({ commandEnabled: () => true })
    for (const element of [one.tab, two.tab]) targets.register(element.dom, registered => ({ kind: 'documentTab', tabId: (registered as unknown as FakeElement).dataset.tabId }))
    const focus: FocusAdapter = { capture: () => doc.activeElement ?? undefined, restore: target => { (target as FakeElement | undefined)?.focus() } }
    const menus = new MenuService({ platform: 'darwin', commands: fixture.commands, context: fixture.context, keybindings: fixture.keybindings, theme: fixture.theme, focus, modalOpen: () => state.modal,
      targets, modalContains: element => field.contains(element as unknown as FakeElement), style: 'native', ...(options.api === false ? {} : { api: main.api }) })
    cleanups.push(() => { menus.dispose(); fixture.dispose() })
    const event = (target: FakeElement, x = 10, y = 20) => ({ target: target as unknown as EventTarget, clientX: x, clientY: y, preventDefault: () => {} })
    return { fixture, main, menus, doc, one, two, field, state, event, first, second }
  }

  it('asks main for the menu at the pointer, outlining what it is for until it closes, and runs the choice on that target', async () => {
    const { main, menus, doc, one, event, fixture, first } = setup()
    menus.openFromEvent(event(one.button, 120.4, 50))
    expect(doc.activeElement).toBe(one.button)
    expect(menus.controller.view.levels).toEqual([])
    expect(main.requests[0].request).toEqual({
      token: 1, menu: 'documentTab.context', x: 120, y: 50,
      visible: ['file.save', 'file.saveAs', 'file.close', 'file.closeOthers', 'file.closeAll', 'file.copyPath', 'file.revealInFolder'], disabled: ['file.copyPath', 'file.revealInFolder'], checked: []
    })
    expect(one.tab.hasAttribute('data-menu-target')).toBe(true)
    main.choose({ token: 1, id: 'file.closeOthers' })
    main.requests[0].close()
    await vi.waitFor(() => expect(fixture.documents.getSnapshot().documents.map(document => document.id)).toEqual([first.id]))
    expect(one.tab.hasAttribute('data-menu-target')).toBe(false)
  })
  it('opens a keyboard menu below the focused element, and moves the outline to a newer menu', async () => {
    const { main, menus, one, two, doc, event } = setup()
    doc.activeElement = one.button
    expect(menus.openForElement(one.button.dom, { keyboard: true })).toBe(true)
    expect(main.requests[0].request).toMatchObject({ x: 108, y: 68 })
    menus.openFromEvent(event(two.button))
    expect([one.tab.hasAttribute('data-menu-target'), two.tab.hasAttribute('data-menu-target')]).toEqual([false, true])
    main.requests[0].close()
    await settle()
    expect(two.tab.hasAttribute('data-menu-target')).toBe(true)
  })
  it('shows the same menu itself when main cannot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { main, menus, one, event } = setup()
    menus.openFromEvent(event(one.button, 120, 50))
    main.requests[0].close({ ok: false, error: 'No window.' })
    await settle()
    expect(menus.controller.view).toMatchObject({ source: 'context', mnemonics: false })
    expect(menus.controller.view.levels[0]).toMatchObject({ label: 'Query tab', anchor: { kind: 'point', x: 120, y: 50 } })
    expect(menus.controller.view.levels[0].items.map(item => item.kind === 'separator' ? '-' : item.title)).toEqual(['Save', 'Save As…', '-', 'Close', 'Close All But This', 'Close All', '-', 'Copy Full Path', 'Reveal in Finder'])
    expect(one.tab.hasAttribute('data-menu-target')).toBe(true)
    menus.close('escape')
    expect(one.tab.hasAttribute('data-menu-target')).toBe(false)
  })
  it('keeps the dialog rule, and uses the workbench\'s own menus without main\'s API', () => {
    const { main, menus, one, field, state, event } = setup()
    state.modal = true
    menus.openFromEvent(event(one.button))
    expect(main.requests).toEqual([])
    menus.openFromEvent(event(field))
    expect(main.requests.map(request => request.request.menu)).toEqual(['input.context'])
    const custom = setup({ api: false })
    custom.menus.openFromEvent(custom.event(custom.one.button))
    expect(custom.menus.controller.view.levels[0]?.label).toBe('Query tab')
  })
})
