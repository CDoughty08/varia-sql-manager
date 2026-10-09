import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { contextRecord } from '../src/shared/commands/context-keys'
import { menuCommandIds } from '../src/shared/commands/menus'
import { CommandService, type CommandSource } from '../src/renderer/src/core/commands'
import { computeContextKeys, focusFacts, type FocusElement } from '../src/renderer/src/core/contextkeys'
import { computeMenuState, MenuStatePublisher, type Timers } from '../src/renderer/src/core/menu-state'
import type { DocumentSnapshot } from '../src/renderer/src/services/documents'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })
function fixture(options: Parameters<typeof workbenchFixture>[0] = {}) {
  const value = workbenchFixture(options)
  cleanups.push(value.dispose)
  return value
}

describe('command execution', () => {
  it('runs enabled commands for every source and reports events in order', async () => {
    const commands = new CommandService(), seen: string[] = [], run = vi.fn()
    commands.register('layout.reset', { run: () => { seen.push('run'); run() } })
    commands.onWillExecute(event => seen.push(`will ${event.id} ${event.source}`))
    commands.onDidExecute(event => seen.push(`did ${event.id} ${event.source}`))
    for (const source of ['keybinding', 'menu', 'palette', 'toolbar', 'api'] as CommandSource[]) await expect(commands.execute('layout.reset', undefined, source)).resolves.toBe(true)
    expect(run).toHaveBeenCalledTimes(5)
    expect(seen.slice(0, 3)).toEqual(['will layout.reset keybinding', 'run', 'did layout.reset keybinding'])
  })
  it('refuses unknown ids and missing handlers, warning once per id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const commands = new CommandService()
    await expect(commands.execute('nope' as CommandId, undefined, 'menu')).resolves.toBe(false)
    await expect(commands.execute('__proto__' as CommandId, undefined, 'menu')).resolves.toBe(false)
    await expect(commands.execute('file.new', undefined, 'menu')).resolves.toBe(false)
    await expect(commands.execute('file.new', undefined, 'menu')).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(3)
  })
  it('refuses user paths behind a modal, except for modal-safe commands and the API', async () => {
    let modal = true
    const commands = new CommandService({ modalOpen: () => modal }), ran: string[] = []
    for (const id of ['file.new', 'edit.undo', 'window.close'] as const) commands.register(id, { run: () => { ran.push(id) } })
    for (const source of ['keybinding', 'menu', 'palette', 'toolbar'] as CommandSource[]) await expect(commands.execute('file.new', undefined, source)).resolves.toBe(false)
    await expect(commands.execute('edit.undo', undefined, 'menu')).resolves.toBe(true)
    await expect(commands.execute('window.close', undefined, 'menu')).resolves.toBe(true)
    await expect(commands.execute('file.new', undefined, 'api')).resolves.toBe(true)
    modal = false
    await expect(commands.execute('file.new', undefined, 'keybinding')).resolves.toBe(true)
    expect(ran).toEqual(['edit.undo', 'window.close', 'file.new', 'file.new'])
  })
  it('checks the precondition and the handler\'s own condition with its arguments', async () => {
    const { commands, documents, files, startQuery, connections } = fixture()
    const save = vi.spyOn(files, 'save'), close = vi.spyOn(files, 'close')
    // No document is open, so Save is unavailable from every path, while run() still honours only the handler.
    await expect(commands.execute('file.save', undefined, 'menu')).resolves.toBe(false)
    expect(save).not.toHaveBeenCalled()
    connections.add(connectionInfo('server-a'), connectionOptions)
    const first = documents.create('first.sql', 'SELECT 1', 'master', 'server-a'), second = documents.create('second.sql', '', 'master')
    documents.activate(first.id)
    const running = startQuery()
    // The active tab is running, so it cannot close; another tab can.
    expect(commands.isEnabled('file.close')).toBe(false)
    expect(commands.isEnabled('file.close', { tabId: second.id })).toBe(true)
    await expect(commands.execute('file.close', { tabId: first.id }, 'toolbar')).resolves.toBe(false)
    expect(close).not.toHaveBeenCalled()
    await running.finish()
    await expect(commands.execute('file.close', { tabId: second.id }, 'toolbar')).resolves.toBe(true)
    expect(close).toHaveBeenCalledWith(second.id)
  })
  it('turns a failing handler into the error banner and never rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandService({ modalOpen: () => { throw new Error('modal check') } })
    commands.register('layout.reset', { run: () => { throw new Error('x'.repeat(400)) } })
    commands.register('file.new', { run: async () => { throw new Error('No space left.') } })
    await expect(commands.execute('layout.reset', undefined, 'api')).resolves.toBe(false)
    expect([...commands.getSnapshot().error]).toHaveLength(300)
    expect(commands.getSnapshot().error.startsWith('Could not run “View: Reset Layout”: xxx')).toBe(true)
    await expect(commands.execute('file.new', undefined, 'api')).resolves.toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “File: New Query”: No space left.')
    // The modal check itself throws: the command does not run and nothing rejects.
    await expect(commands.execute('file.new', undefined, 'menu')).resolves.toBe(false)
    commands.clearError()
    expect(commands.getSnapshot().error).toBe('')
    expect(error).toHaveBeenCalledTimes(3)
  })
  it('treats a throwing condition as unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandService()
    commands.register('file.new', { when: () => { throw new Error('broken') }, run: vi.fn() })
    expect(commands.isEnabled('file.new')).toBe(false)
    expect(error).toHaveBeenCalledOnce()
  })
  it('keeps run and canRun as the programmatic path', async () => {
    const commands = new CommandService({ state: () => contextRecord('win32', { documentBusy: true }) }), run = vi.fn()
    await expect(commands.run('file.new')).rejects.toThrow('Unknown command: file.new')
    commands.register('file.new', { when: context => context?.tabId !== 'blocked', run })
    expect(() => commands.register('file.new', { run })).toThrow('Command already registered: file.new')
    expect(commands.canRun('file.new')).toBe(true)
    expect(commands.canRun('file.new', { tabId: 'blocked' })).toBe(false)
    // The precondition (!documentBusy) is false, but run() only asks the handler.
    expect(commands.isEnabled('file.new')).toBe(false)
    await commands.run('file.new')
    await commands.run('file.new', { tabId: 'blocked' })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('reports toggled state and handler changes', () => {
    let wrap = false
    const commands = new CommandService({ state: () => contextRecord('linux', { editorWordWrap: wrap }) }), changed = vi.fn()
    commands.onDidChangeHandlers(changed)
    const registration = commands.register('editor.toggleWordWrap', { run: () => { wrap = !wrap } })
    expect(commands.isToggled('editor.toggleWordWrap')).toBe(false)
    wrap = true
    expect(commands.isToggled('editor.toggleWordWrap')).toBe(true)
    expect(commands.isToggled('file.new')).toBe(false)
    registration.dispose(); registration.dispose()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(commands.has('editor.toggleWordWrap')).toBe(false)
  })
  it('switches between open queries in tab-strip order and toggles word wrap', async () => {
    const { commands, documents, editorOptions } = fixture()
    expect(commands.isEnabled('document.next')).toBe(false)
    const tabs = [documents.create('a.sql', '', 'master'), documents.create('b.sql', '', 'master'), documents.create('c.sql', '', 'master')]
    await commands.execute('document.next', undefined, 'keybinding')
    expect(documents.active?.id).toBe(tabs[0].id)
    await commands.execute('document.previous', undefined, 'keybinding')
    await commands.execute('document.previous', undefined, 'keybinding')
    expect(documents.active?.id).toBe(tabs[1].id)
    expect(commands.isToggled('editor.toggleWordWrap')).toBe(false)
    await commands.execute('editor.toggleWordWrap', undefined, 'menu')
    expect(editorOptions.getSnapshot().wordWrap).toBe(true)
    expect(commands.isToggled('editor.toggleWordWrap')).toBe(true)
  })
  it('runs the shell commands through the host', async () => {
    const { commands, host, connections, api } = fixture()
    expect(commands.isEnabled('connection.connect')).toBe(false)
    api.push(readyBackend())
    await commands.execute('connection.connect', undefined, 'menu')
    expect(commands.isEnabled('explorer.refresh')).toBe(false)
    connections.add(connectionInfo('server-a'), connectionOptions)
    await commands.execute('explorer.refresh', undefined, 'keybinding')
    for (const id of ['window.explorer', 'window.output', 'layout.save', 'layout.load', 'layout.reset'] as const) await commands.execute(id, undefined, 'menu')
    await commands.execute('window.close', undefined, 'menu')
    expect([host.showConnect, host.resetLayout, host.flushLayout].map(fn => vi.mocked(fn).mock.calls.length)).toEqual([1, 1, 1])
    // Object Explorer also takes focus (SSMS's F8), so a following F5 refreshes it.
    expect(vi.mocked(host.reveal).mock.calls).toEqual([['explorer', { focus: true }], ['output']])
    expect(vi.mocked(host.manageLayouts).mock.calls).toEqual([['save'], ['load']])
    expect(api.closeWindow).toHaveBeenCalledOnce()
  })
})

const snapshot = (patch: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({ documents: [], activeId: '', busy: false, ...patch })
const doc = (id: string, connectionId?: string) => ({ id, name: `${id}.sql`, database: 'master', connectionId, dirty: false, savedVersionId: 1 })
describe('context keys', () => {
  it('derive state keys from service snapshots', () => {
    const base = { platform: 'win32' as const, queries: {}, connections: [], quickInputVisible: false, wordWrap: false, backendStatus: 'starting' as const }
    expect(computeContextKeys({ ...base, documents: snapshot() })).toMatchObject({ isWindows: true, hasActiveDocument: false, multipleDocuments: false, documentBusy: false, hasConnection: false, activeDocumentConnected: false, queryRunning: false, editorFocus: false, activePanel: '' })
    const documents = snapshot({ documents: [doc('a', 'server-a'), doc('b', 'gone')], activeId: 'a', busy: true })
    const running = { a: { running: { queryId: 'q', connectionId: 'server-a' } } }
    expect(computeContextKeys({ ...base, documents, queries: running, connections: [connectionInfo('server-a')], quickInputVisible: true, wordWrap: true, backendStatus: 'ready' })).toMatchObject({
      hasActiveDocument: true, multipleDocuments: true, documentBusy: true, hasConnection: true, activeDocumentConnected: true, queryRunning: true, quickInputVisible: true, editorWordWrap: true, backendReady: true
    })
    // The active query's server was disconnected; a stale running entry for another tab does not count.
    expect(computeContextKeys({ ...base, documents: { ...documents, activeId: 'b' }, queries: running, connections: [connectionInfo('server-a')] })).toMatchObject({ activeDocumentConnected: false, queryRunning: false })
    expect(computeContextKeys({ ...base, documents: snapshot({ documents: [doc('a')], activeId: 'missing' }) })).toMatchObject({ hasActiveDocument: false })
  })
  it('derive focus keys from the focused element', () => {
    const element = (tag: 'input' | 'textarea' | 'button' | 'div', options: { pane?: string; editable?: boolean; grid?: boolean } = {}): FocusElement & { tag: string } => ({
      tag, matches: selector => selector.split(', ').includes(tag),
      closest: selector => selector === '[data-pane]' ? options.pane === undefined ? null : { getAttribute: () => options.pane! }
        : selector === '[data-result-grid]' ? options.grid ? { getAttribute: () => '' } : null : options.editable ? { getAttribute: () => 'true' } : null
    })
    const textArea = element('textarea', { pane: 'editor' }), findInput = element('input', { pane: 'editor' })
    const editor = (focusedText: boolean) => ({ getContainerDomNode: () => ({ contains: (node: FocusElement) => node === textArea || node === findInput }), hasTextFocus: () => focusedText })
    expect(focusFacts(textArea, editor(true))).toEqual({ editorFocus: true, editorTextFocus: true, inputFocus: false, activePanel: 'editor', outputGridFocus: false })
    expect(focusFacts(findInput, editor(false))).toEqual({ editorFocus: true, editorTextFocus: false, inputFocus: true, activePanel: 'editor', outputGridFocus: false })
    expect(focusFacts(element('button', { pane: 'explorer' }), editor(false))).toEqual({ editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: 'explorer', outputGridFocus: false })
    // Ctrl+Shift+C copies with headers only in a results grid, not in Messages.
    expect(focusFacts(element('div', { pane: 'output', grid: true }), editor(false))).toEqual({ editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: 'output', outputGridFocus: true })
    expect(focusFacts(element('div', { pane: 'output' }), editor(false))).toMatchObject({ activePanel: 'output', outputGridFocus: false })
    expect(focusFacts(element('div', { pane: 'output', editable: true }), undefined)).toMatchObject({ inputFocus: true, activePanel: 'output' })
    expect(focusFacts(element('input', { pane: 'floating' }), undefined)).toMatchObject({ inputFocus: true, activePanel: '' })
    expect(focusFacts(null, editor(true))).toEqual({ editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: '', outputGridFocus: false })
    const keys = computeContextKeys({ platform: 'darwin', focus: focusFacts(findInput, editor(false)), documents: snapshot(), queries: {}, connections: [], quickInputVisible: false, wordWrap: false, backendStatus: '' })
    expect(keys).toMatchObject({ isMac: true, editorFocus: true, inputFocus: true, textInputFocus: true })
  })
  it('cache state between snapshot changes and notify subscribers', () => {
    const { context, documents, connections, editorOptions, api } = fixture()
    const listener = vi.fn()
    const unsubscribe = context.subscribe(listener)
    const first = context.getState()
    expect(context.getState()).toBe(first)
    documents.create('a.sql', '', 'master')
    connections.add(connectionInfo('server-a'), connectionOptions)
    editorOptions.toggleWordWrap()
    api.push(readyBackend())
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4)
    const second = context.getState()
    expect(second).not.toBe(first)
    expect(second).toMatchObject({ hasActiveDocument: true, hasConnection: true, editorWordWrap: true, backendReady: true })
    expect(context.get()).toMatchObject({ hasActiveDocument: true, editorFocus: false })
    unsubscribe()
    const calls = listener.mock.calls.length
    documents.create('b.sql', '', 'master')
    expect(listener).toHaveBeenCalledTimes(calls)
  })
})

function fakeTimers() {
  let next = 1
  const pending = new Map<number, () => void>()
  const timers: Timers = { setTimeout: callback => { pending.set(next, callback); return next++ }, clearTimeout: handle => { pending.delete(handle as number) } }
  const fire = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()) }
  return { timers, pending, fire }
}
describe('menu state publisher', () => {
  it('sends at once, then coalesces changes and sends only differences', () => {
    const { commands, context, documents, connections } = fixture()
    const { timers, pending, fire } = fakeTimers(), send = vi.fn()
    const publisher = new MenuStatePublisher({ commands, context, send, timers })
    const started = publisher.start()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0].disabled).toEqual(expect.arrayContaining(['file.save', 'query.execute', 'query.cancel', 'connection.connect', 'document.next']))
    expect(send.mock.calls[0][0].disabled).not.toContain('file.new')
    documents.create('a.sql', '', 'master')
    connections.add(connectionInfo('server-a'), connectionOptions)
    expect(pending.size).toBe(1)
    expect(send).toHaveBeenCalledOnce()
    fire()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.lastCall![0].disabled).not.toContain('file.save')
    // A change that leaves the menu as it was sends nothing.
    connections.add(connectionInfo('server-b'), connectionOptions)
    fire()
    expect(send).toHaveBeenCalledTimes(2)
    started.dispose()
    documents.create('b.sql', '', 'master')
    expect(pending.size).toBe(0)
    publisher.dispose()
  })
  it('flushes synchronously and recomputes when handlers change', () => {
    const { context, editorOptions } = fixture()
    const commands = new CommandService({ state: () => context.getState() })
    const { timers, pending, fire } = fakeTimers(), send = vi.fn()
    const publisher = new MenuStatePublisher({ commands, context, send, timers })
    cleanups.push(() => publisher.dispose())
    publisher.start()
    expect(send.mock.lastCall![0].disabled).toContain('layout.reset')
    const registration = commands.register('layout.reset', { run: vi.fn() })
    expect(pending.size).toBe(1)
    fire()
    expect(send.mock.lastCall![0].disabled).not.toContain('layout.reset')
    commands.register('editor.toggleWordWrap', { run: () => editorOptions.toggleWordWrap() })
    editorOptions.toggleWordWrap()
    expect(pending.size).toBe(1)
    publisher.flush()
    expect(pending.size).toBe(0)
    expect(send.mock.lastCall![0].checked).toEqual(['editor.toggleWordWrap'])
    registration.dispose()
    publisher.dispose()
    expect(pending.size).toBe(0)
  })
  it('lists every menu command without a handler as disabled', () => {
    const commands = new CommandService()
    expect(computeMenuState(commands)).toEqual({ disabled: [...menuCommandIds], checked: [] })
  })
})

/**
 * Before PR2 the toolbar and selects computed their own `disabled` flags, and the menu ran whatever was clicked through
 * `files` and `queries` guards. Enablement now comes from the catalogue; it must match in every state.
 */
describe('enablement parity with the pre-registry toolbar', () => {
  const cases = [0, 1, 2].flatMap(count => [false, true].flatMap(busy => [false, true].flatMap(connected => [false, true].flatMap(running =>
    count === 0 && running ? [] : !connected && running ? [] : [{ count, busy, connected, running }]))))
  it.each(cases)('%o', async ({ count, busy, connected, running }) => {
    const { commands, api, documents, connections, queries, files, startQuery } = fixture()
    api.push(readyBackend())
    for (let index = 0; index < count; index++) documents.create(`q${index}.sql`, 'SELECT 1', 'master', 'server-a')
    if (connected) connections.add(connectionInfo('server-a'), connectionOptions)
    const query = running ? startQuery() : undefined
    const hold = deferred<void>(), task = busy ? documents.runTask(() => hold.promise) : undefined
    const { activeId } = documents.getSnapshot(), activeRunning = queries.isRunning(activeId), connection = connections.get(documents.active?.connectionId ?? '')
    expect(activeRunning).toBe(running)
    const legacy: Partial<Record<CommandId, boolean>> = {
      'connection.connect': true,
      'file.new': !busy, 'file.open': !busy,
      'file.save': !(!activeId || busy), 'file.saveAs': !(!activeId || busy),
      'query.execute': !(!connection || activeRunning || busy),
      'query.cancel': activeRunning,
      'explorer.refresh': connections.getSnapshot().length > 0
    }
    for (const [id, expected] of Object.entries(legacy) as [CommandId, boolean][]) expect(commands.isEnabled(id), id).toBe(expected)
    expect(commands.isEnabled('file.new')).toBe(files.canRun())
    expect(commands.isEnabled('file.save')).toBe(files.canSave())
    expect(commands.isEnabled('file.close')).toBe(files.canClose())
    expect(commands.isEnabled('query.execute')).toBe(queries.canExecute())
    hold.resolve(); await task; await query?.finish()
  })
})
