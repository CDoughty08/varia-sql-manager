import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { platforms } from '../src/shared/commands/keybindings'
import type { DatabaseInfo } from '../src/shared/contracts'
import { CommandHistory, historyKey } from '../src/renderer/src/quickinput/history'
import { QuickInputService, type QuickPickItem, type QuickPickOptions } from '../src/renderer/src/quickinput/QuickInputService'
import { deferred } from './fixtures/documents'
import { connectionInfo, fakeFocus, manualTimers, memoryStorage, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function controller(focused: unknown = 'editor') {
  const focus = fakeFocus(focused), clock = manualTimers()
  const service = new QuickInputService(focus.adapter, clock.timers)
  cleanups.push(() => service.dispose())
  const view = () => service.getSnapshot()
  const labels = () => view().rows.map(row => row.item.label)
  const active = () => view().rows[view().activeIndex]?.item.id
  return { service, focus: focus.state, clock, view, labels, active }
}
const items = (...labels: string[]): QuickPickItem[] => labels.map(label => ({ id: label, label }))
function options(overrides: Partial<QuickPickOptions<QuickPickItem>> = {}): QuickPickOptions<QuickPickItem> {
  return { ariaLabel: 'Pick', placeholder: 'Type', noun: 'items', items: items('alpha', 'beta', 'gamma'), onDidAccept: () => {}, ...overrides }
}

describe('quick input sessions', () => {
  it('returns focus on accept and cancel, before the accept runs, and not on blur', () => {
    const { service, focus } = controller(), log: string[] = []
    const show = () => {
      focus.focused = 'editor'
      service.show(options({ onDidAccept: item => { log.push(`accept ${item.id} in ${String(focus.focused)}`) }, onDidHide: reason => { log.push(`hide ${reason}`) } }))
      // The view focuses its input.
      focus.focused = 'quick input'
    }
    show()
    service.accept()
    expect(log).toEqual(['hide accept', 'accept alpha in editor'])
    show()
    service.hide('cancel')
    expect(focus.focused).toBe('editor')
    show()
    service.hide('blur')
    expect(focus.focused).toBe('quick input')
    expect(focus.restored).toEqual(['editor', 'editor'])
    expect(log.slice(2)).toEqual(['hide cancel', 'hide blur'])
    expect(service.visible).toBe(false)
    service.hide('cancel')
    expect(log).toHaveLength(4)
  })
  it('replaces an open picker but still returns focus to where it was before the first', () => {
    const { service, focus, view } = controller('grid'), hidden: string[] = []
    service.show(options({ ariaLabel: 'First', onDidHide: reason => { hidden.push(`first ${reason}`) } }))
    focus.focused = 'quick input'
    service.show(options({ ariaLabel: 'Second', onDidHide: reason => { hidden.push(`second ${reason}`) } }))
    expect(hidden).toEqual(['first replace'])
    expect(view()).toMatchObject({ visible: true, ariaLabel: 'Second' })
    service.hide('cancel')
    expect(focus.restored).toEqual(['grid'])
    expect(hidden).toEqual(['first replace', 'second cancel'])
  })
  it('moves through rows with wrapping, paging, first, and last', () => {
    const { service, active } = controller()
    service.show(options({ items: items('a', 'b', 'c', 'd', 'e', 'f'), sort: 'none' }))
    expect(active()).toBe('a')
    service.move('previous'); expect(active()).toBe('f')
    service.move('next'); expect(active()).toBe('a')
    service.move('next'); expect(active()).toBe('b')
    service.move('pageNext', 3); expect(active()).toBe('d')
    service.move('pageNext', 3); expect(active()).toBe('f')
    service.move('pagePrevious', 4); expect(active()).toBe('c')
    service.move('pagePrevious', 4); expect(active()).toBe('a')
    service.move('last'); expect(active()).toBe('f')
    service.move('first'); expect(active()).toBe('a')
    service.setActive(99); expect(active()).toBe('f')
    service.filter('zzz')
    service.move('next')
    expect(service.getSnapshot().activeIndex).toBe(-1)
  })
  it('shows the hint of a disabled row and stays open', () => {
    const { service, view } = controller(), accept = vi.fn()
    service.show(options({ items: [{ id: 'x', label: 'Execute', disabled: true, disabledHint: 'Connect first.' }, { id: 'y', label: 'Other', disabled: true }, { id: 'z', label: 'Fine' }], sort: 'none', onDidAccept: accept }))
    service.accept()
    expect(view().message).toEqual({ text: 'Connect first.', severity: 'info' })
    service.accept(1)
    expect(view().message?.text).toBe('“Other” is not available right now.')
    service.move('next')
    expect(view().message).toBeUndefined()
    expect(view().visible).toBe(true)
    expect(accept).not.toHaveBeenCalled()
    service.accept(2)
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: 'z' }))
  })
  it('ignores an accept that began in an earlier picker', () => {
    const { service, view } = controller(), picked = vi.fn()
    service.show(options({ onDidAccept: () => service.show(options({ items: items('server-a'), onDidAccept: picked })) }))
    const first = view().session
    service.accept(0, first)
    expect(view()).toMatchObject({ visible: true, rows: [{ item: { id: 'server-a' } }] })
    // The second click of a double-click, or a press that began in the first picker.
    service.accept(0, first)
    expect(picked).not.toHaveBeenCalled()
    expect(service.visible).toBe(true)
    service.accept(0, view().session)
    expect(picked).toHaveBeenCalledOnce()
  })
  it('reports failing callbacks without breaking the widget', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service } = controller()
    service.show(options({ onDidAccept: () => { throw new Error('sync') }, onDidHide: () => { throw new Error('hide') }, onDidChangeValue: () => { throw new Error('value') } }))
    service.filter('a')
    service.accept()
    service.show(options({ onDidAccept: async () => { throw new Error('async') } }))
    service.accept()
    await settle()
    expect(error.mock.calls.map(call => (call[1] as Error).message)).toEqual(['value', 'hide', 'sync', 'async'])
    expect(service.visible).toBe(false)
  })
  it('writes the input only when asked, and keeps a typed mode switch as it is', () => {
    const { service, view } = controller()
    service.show(options({ value: '>', prefix: '>' }))
    const opened = view().input
    expect(opened).toMatchObject({ value: '>', selection: 'end' })
    service.filter('>al')
    expect(view().input).toBe(opened)
    service.setValue('>al', 'afterPrefix')
    expect(view().input).toMatchObject({ value: '>al', selection: 'afterPrefix', version: opened.version + 1 })
    // A provider switch that keeps the typed value leaves the input alone.
    const typed = view().input
    service.show(options({ value: '>al', prefix: '>' }))
    expect(view().input).toBe(typed)
    service.show(options({ value: '' }))
    expect(view().input).toMatchObject({ value: '', selection: 'end', version: typed.version + 1 })
    service.setValue('x'.repeat(300), 'all')
    expect(view().input.value).toHaveLength(256)
    expect(service.value).toHaveLength(256)
  })
  it('resolves pick with the accepted item, or undefined', async () => {
    const { service } = controller(), hidden = vi.fn()
    const picked = service.pick({ ariaLabel: 'Pick', placeholder: '', noun: 'items', items: items('one', 'two'), onDidHide: hidden })
    service.move('next')
    service.accept()
    await expect(picked).resolves.toMatchObject({ id: 'two' })
    const cancelled = service.pick({ ariaLabel: 'Pick', placeholder: '', noun: 'items', items: items('one') })
    service.hide('cancel')
    await expect(cancelled).resolves.toBeUndefined()
    expect(hidden).toHaveBeenCalledWith('accept')
  })
  it('hides on dispose without returning focus, and ignores later requests', async () => {
    const { service, focus } = controller(), hidden = vi.fn()
    let signal: AbortSignal | undefined
    service.show(options({ items: value => { signal = value; return new Promise(() => {}) }, onDidHide: hidden }))
    service.dispose()
    expect(hidden).toHaveBeenCalledWith('cancel')
    expect(signal?.aborted).toBe(true)
    expect(focus.restored).toEqual([])
    service.show(options())
    expect(service.visible).toBe(false)
    await expect(service.pick(options())).resolves.toBeUndefined()
  })
  it('publishes visibility separately, only when the widget opens or closes', () => {
    const { service } = controller(), changes = vi.fn()
    service.visibility.subscribe(changes)
    service.show(options())
    service.filter('a'); service.move('next'); service.show(options())
    expect(changes).toHaveBeenCalledTimes(1)
    expect(service.visibility.getSnapshot().visible).toBe(true)
    service.hide('blur')
    expect(changes).toHaveBeenCalledTimes(2)
    expect(service.visibility.getSnapshot().visible).toBe(false)
  })
})

describe('quick input loading', () => {
  it('shows busy only after 150 ms, then the loaded rows with the requested active row', async () => {
    const { service, clock, view, labels, active } = controller(), load = deferred<readonly QuickPickItem[]>()
    service.show(options({ items: () => load.promise, activeId: 'beta' }))
    expect(view()).toMatchObject({ loading: true, busy: false, rows: [] })
    service.accept()
    clock.advance(149)
    expect(view().busy).toBe(false)
    clock.advance(1)
    expect(view().busy).toBe(true)
    load.resolve(items('alpha', 'beta'))
    await settle()
    expect(view()).toMatchObject({ loading: false, busy: false })
    expect(labels()).toEqual(['alpha', 'beta'])
    expect(active()).toBe('beta')
    expect(clock.pending.size).toBe(0)
  })
  it('filters loaded rows with what was typed while loading', async () => {
    const { service, labels } = controller(), load = deferred<readonly QuickPickItem[]>()
    service.show(options({ items: () => load.promise }))
    service.filter('ga')
    load.resolve(items('alpha', 'gamma'))
    await settle()
    expect(labels()).toEqual(['gamma'])
  })
  it('aborts on hide and drops results that arrive after a hide or a replace', async () => {
    const { service, view, labels } = controller(), first = deferred<readonly QuickPickItem[]>(), second = deferred<readonly QuickPickItem[]>()
    let signal: AbortSignal | undefined
    service.show(options({ items: value => { signal = value; return first.promise } }))
    service.hide('cancel')
    expect(signal?.aborted).toBe(true)
    first.resolve(items('late'))
    await settle()
    expect(view()).toMatchObject({ visible: false, rows: [] })
    service.show(options({ items: () => second.promise }))
    service.show(options({ items: items('current') }))
    second.resolve(items('stale'))
    await settle()
    expect(labels()).toEqual(['current'])
  })
  it('reports a timeout, a rejection, or a throwing provider as a message with no rows, and Enter does nothing', async () => {
    const { service, clock, view } = controller(), accept = vi.fn(), late = deferred<readonly QuickPickItem[]>()
    service.show(options({ noun: 'databases', items: () => late.promise, onDidAccept: accept }))
    clock.advance(30_000)
    expect(view()).toMatchObject({ loading: false, busy: false, rows: [], activeIndex: -1, message: { text: 'Could not load databases: It took longer than 30 seconds.', severity: 'error' } })
    late.resolve(items('late'))
    await settle()
    expect(view().rows).toEqual([])
    service.accept()
    service.filter('anything')
    expect(view()).toMatchObject({ visible: true, rows: [] })
    service.show(options({ noun: 'databases', items: async () => { throw new Error('Login failed for user.') }, onDidAccept: accept }))
    await settle()
    expect(view().message).toEqual({ text: 'Could not load databases: Login failed for user.', severity: 'error' })
    service.show(options({ noun: 'servers', items: () => { throw new Error('Boom.') } }))
    await settle()
    expect(view().message?.text).toBe('Could not load servers: Boom.')
    service.accept()
    expect(accept).not.toHaveBeenCalled()
  })
  it('drops malformed provider rows, and reports a result it cannot read as a failed load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, clock, view } = controller()
    const malformed = [{ id: 'a', label: null }, { id: 'b', label: 'Sales', description: 7 }, { id: 3, label: 'x' }, null, { id: 'c', label: 'Ok', description: 'fine' }] as unknown as QuickPickItem[]
    service.show(options({ noun: 'databases', items: async () => malformed }))
    await settle()
    expect(view().rows.map(row => [row.item.id, row.item.description])).toEqual([['b', undefined], ['c', 'fine']])
    expect(view()).toMatchObject({ loading: false, message: undefined })
    const unreadable = { id: 'x', get label(): string { throw new Error('Unreadable row.') } }
    service.show(options({ noun: 'databases', items: async () => [unreadable] }))
    await settle()
    clock.advance(31_000)
    expect(view()).toMatchObject({ visible: true, loading: false, busy: false, rows: [], message: { text: 'Could not load databases: Unreadable row.', severity: 'error' } })
    service.show(options({ items: [unreadable] }))
    expect(view()).toMatchObject({ visible: true, rows: [], message: { text: 'Could not load items: Unreadable row.', severity: 'error' } })
    expect(error).toHaveBeenCalledTimes(2)
    service.filter('x')
    expect(view()).toMatchObject({ visible: true, rows: [] })
  })
  it('caps items, labels, and descriptions, and accepts the original item', () => {
    const { service, view } = controller(), accept = vi.fn()
    const many = Array.from({ length: 5001 }, (_, index) => ({ id: String(index), label: index ? `item ${index}` : 'x'.repeat(600), description: 'd'.repeat(300) }))
    service.show(options({ items: many, sort: 'none', onDidAccept: accept }))
    expect(view().rows).toHaveLength(5000)
    expect(view().message).toEqual({ text: 'Showing the first 5,000 items; type to narrow the list', severity: 'info' })
    expect(view().rows[0].item.label).toHaveLength(512)
    expect(view().rows[0].item.description).toHaveLength(256)
    service.accept()
    expect(accept.mock.calls[0][0]).toBe(many[0])
  })
})

describe('quick input filtering', () => {
  it('narrows incrementally to the same rows as a full filter', () => {
    const words = ['save', 'execute', 'query', 'file', 'layout', 'reset', 'database', 'change', 'server', 'connect', 'Cancel', 'next', 'Word', 'wrap']
    let seed = 7
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const pool = Array.from({ length: 300 }, (_, index) => ({ id: String(index), label: Array.from({ length: 1 + Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)]).join(index % 3 ? ' ' : ': '), keywords: index % 5 ? [] : ['go'], description: `server ${index}` }))
    for (const typed of ['exe', 'sa q', 'change data', 'go', 'cw', 'res lay', 'ser 1', 'qq']) for (const matchOnDescription of [false, true]) {
      const incremental = controller(), full = controller()
      incremental.service.show(options({ items: pool, matchOnDescription }))
      for (let length = 1; length <= typed.length; length++) incremental.service.filter(typed.slice(0, length))
      full.service.show(options({ items: pool, matchOnDescription }))
      full.service.filter(typed)
      expect(incremental.view().rows, typed).toEqual(full.view().rows)
      // Deleting a character widens the search again.
      incremental.service.filter(typed.slice(0, -1)); full.service.filter(typed.slice(0, -1))
      expect(incremental.view().rows, typed).toEqual(full.view().rows)
    }
  })
  it('orders by score, or keeps the provided order and its groups', () => {
    const { service, labels, view } = controller()
    const list: QuickPickItem[] = [{ id: '1', label: 'Cancel Executing Query', group: 'query' }, { id: '2', label: 'Execute', group: 'query' }, { id: '3', label: 'Save', group: 'file' }, { id: '4', label: 'Save As', group: 'file' }]
    service.show(options({ items: list }))
    expect(view().rows.map(row => row.group)).toEqual(['query', undefined, 'file', undefined])
    service.filter('exe')
    expect(labels()).toEqual(['Execute', 'Cancel Executing Query'])
    expect(view().rows[0].ranges).toEqual([[0, 3]])
    // Ranked rows would repeat group labels, so they go.
    expect(view().rows.map(row => row.group)).toEqual([undefined, undefined])
    service.show(options({ items: list, sort: 'none' }))
    service.filter('e')
    expect(labels()).toEqual(['Cancel Executing Query', 'Execute', 'Save', 'Save As'])
    expect(view().rows.map(row => row.group)).toEqual(['query', undefined, 'file', undefined])
  })
  it('puts recently used rows first while the filter is empty, and prefers them on ties', () => {
    const { service, labels, view } = controller()
    service.show(options({ noun: 'commands', items: items('Load Layout', 'Reset Layout', 'Save Layout', 'Zoom'), recentIds: ['Zoom', 'Save Layout', 'gone', 'Zoom'] }))
    expect(labels()).toEqual(['Zoom', 'Save Layout', 'Load Layout', 'Reset Layout'])
    expect(view().rows.map(row => row.group)).toEqual(['recently used', undefined, 'other commands', undefined])
    service.filter('layout')
    expect(labels()).toEqual(['Save Layout', 'Load Layout', 'Reset Layout'])
    expect(view().rows.every(row => row.group === undefined)).toBe(true)
    service.show(options({ items: items('b', 'a'), recentIds: ['none'] }))
    expect(view().rows.map(row => [row.item.label, row.group])).toEqual([['b', undefined], ['a', undefined]])
  })
  it('matches descriptions when asked, below label matches', () => {
    const { service, view } = controller()
    const list = [{ id: '1', label: 'SQLQuery1.sql', description: 'server-a · AppData' }, { id: '2', label: 'AppData.sql', description: 'server-b · master' }]
    service.show(options({ items: list }))
    service.filter('appdata')
    expect(view().rows.map(row => row.item.id)).toEqual(['2'])
    service.show(options({ items: list, matchOnDescription: true }))
    service.filter('appdata')
    expect(view().rows.map(row => [row.item.id, row.ranges, row.descriptionRanges])).toEqual([['2', [[0, 7]], []], ['1', [], [[11, 18]]]])
  })
  it('filters after the prefix, makes the first row active, and reports the active item', () => {
    const { service, active } = controller(), changes: (string | undefined)[] = []
    service.show(options({ prefix: '>', value: '>', activeId: 'gamma', onDidChangeActive: item => { changes.push(item?.id) } }))
    expect(active()).toBe('gamma')
    service.filter('>a')
    expect(active()).toBe('alpha')
    service.move('next')
    service.filter('>zz')
    service.filter('>zzz')
    expect(changes).toEqual(['gamma', 'alpha', 'beta', undefined])
  })
})

describe('command history', () => {
  it('reads only valid, known, unique ids within the limits', () => {
    const read = (value: string) => new CommandHistory(memoryStorage({ [historyKey]: value })).ids
    expect(read(JSON.stringify(['file.new', 'nope', 'layout.reset', 'file.new', 42, '__proto__']))).toEqual(['file.new', 'layout.reset'])
    expect(read('{not json')).toEqual([])
    expect(read(JSON.stringify({ 0: 'file.new' }))).toEqual([])
    expect(read(JSON.stringify(['file.new', ...'x'.repeat(4100).split('')]))).toEqual([])
    expect(read(JSON.stringify(Array.from({ length: 60 }, (_, index) => index % 2 ? 'file.new' : 'file.open')))).toEqual(['file.open', 'file.new'])
    expect(new CommandHistory(undefined).ids).toEqual([])
    expect(new CommandHistory({ getItem: () => { throw new Error('blocked') }, setItem: () => {} }).ids).toEqual([])
  })
  it('records the latest first, keeps 50, and survives a failing write', () => {
    const storage = memoryStorage(), history = new CommandHistory(storage)
    history.record('file.new'); history.record('layout.reset'); history.record('file.new')
    history.record('bogus' as CommandId)
    expect(history.ids).toEqual(['file.new', 'layout.reset'])
    expect(JSON.parse(storage.values.get(historyKey)!)).toEqual(['file.new', 'layout.reset'])
    const failing = new CommandHistory({ getItem: () => null, setItem: () => { throw new Error('quota') } })
    failing.record('file.save')
    expect(failing.ids).toEqual(['file.save'])
    expect(new CommandHistory(storage).ids).toEqual(['file.new', 'layout.reset'])
  })
})

function palette(options: Parameters<typeof workbenchFixture>[0] = {}) {
  const fixture = workbenchFixture(options)
  cleanups.push(fixture.dispose)
  const view = () => fixture.quickInput.getSnapshot()
  const labels = () => view().rows.map(row => row.item.label)
  const row = (label: string) => view().rows.find(entry => entry.item.label === label)
  const key = (id: CommandId) => fixture.commands.execute(id, undefined, 'keybinding')
  return { ...fixture, view, labels, row, key }
}

describe('command palette', () => {
  it('opens on F1 with every palette command, its key, and why it is unavailable', async () => {
    const { key, view, labels, row, context } = palette()
    expect(context.getState().quickInputVisible).toBe(false)
    await key('workbench.showCommands')
    expect(view()).toMatchObject({ visible: true, ariaLabel: 'Command Palette', placeholder: 'Type the name of a command to run', prefix: '>', input: { value: '>', selection: 'end' } })
    expect(context.getState().quickInputVisible).toBe(true)
    expect(labels()).toEqual([...labels()].sort((a, b) => a.localeCompare(b, 'en')))
    expect(labels()).not.toContain('Show All Commands')
    expect(labels()).not.toContain('Close Window')
    expect(row('File: New Query')?.item).toMatchObject({ id: 'file.new', icon: 'new-file', keybinding: { text: 'Ctrl+N', aria: 'Control+N' } })
    expect(row('File: New Query')?.item.disabled).toBeUndefined()
    expect(row('Edit: Comment Selection')?.item.keybinding?.parts).toEqual(['Ctrl+K', 'Ctrl+C'])
    expect(row('Query: Execute')?.item).toMatchObject({ disabled: true, disabledHint: 'Connect this query to a server and wait for its running query to finish.' })
    expect(row('Query: Change Connection…')?.item).toMatchObject({ disabled: true, disabledHint: '“Query: Change Connection…” is not available right now.' })
    expect(row('Go to Query…')?.item).toMatchObject({ disabled: true, disabledHint: 'No queries are open.', keybinding: { text: 'Ctrl+P' } })
  })
  it('runs the accepted command from the palette after returning focus, and remembers it', async () => {
    const { key, quickInput, documents, history, focus, commands } = palette()
    const sources: string[] = []
    commands.onWillExecute(event => sources.push(`${event.id} ${event.source} focus ${String(focus.focused)}`))
    focus.focused = 'grid'
    await key('workbench.showCommands')
    focus.focused = 'quick input'
    quickInput.filter('>new query')
    expect(quickInput.getSnapshot().rows[0].item.label).toBe('File: New Query')
    quickInput.accept()
    await settle()
    expect(documents.getSnapshot().documents).toHaveLength(1)
    expect(quickInput.visible).toBe(false)
    expect(history.ids).toEqual(['file.new'])
    expect(sources).toEqual(['workbench.showCommands keybinding focus grid', 'file.new palette focus grid'])
  })
  it('switches mode by prefix, keeping the value, and returns to Go to Query when the prefix is deleted', async () => {
    const { key, quickInput, view, labels, documents, focus } = palette()
    documents.create('a.sql', '', 'master')
    await key('workbench.showCommands')
    focus.focused = 'quick input'
    quickInput.filter('')
    expect(view()).toMatchObject({ ariaLabel: 'Go to Query', prefix: '' })
    expect(labels()).toEqual(['a.sql'])
    quickInput.filter('?')
    expect(view()).toMatchObject({ ariaLabel: 'Quick Access Help', prefix: '?' })
    expect(view().rows.map(row => [row.item.label, row.item.description, row.item.keybinding?.text])).toEqual([['…', 'Go to Query', 'Ctrl+P'], ['>', 'Run Command', 'Ctrl+Shift+P']])
    quickInput.move('next')
    quickInput.accept()
    expect(view()).toMatchObject({ visible: true, ariaLabel: 'Command Palette', input: { value: '>', selection: 'end' } })
    quickInput.filter('?')
    quickInput.accept()
    expect(view()).toMatchObject({ visible: true, ariaLabel: 'Go to Query', input: { value: '' } })
    quickInput.filter('@sales')
    expect(view()).toMatchObject({ ariaLabel: 'Go to Query', rows: [] })
    quickInput.hide('cancel')
    // Every switch kept the original focus target.
    expect(focus.restored).toEqual(['editor'])
  })
  it('selects in place when its own key is pressed again, and switches modes with the other key', async () => {
    const { key, quickInput, view, documents } = palette()
    documents.create('a.sql', '', 'master')
    await key('workbench.showCommands')
    const session = view().session
    quickInput.filter('>exe')
    await key('workbench.showCommands')
    expect(view()).toMatchObject({ session, input: { value: '>exe', selection: 'afterPrefix' } })
    await key('workbench.quickOpen')
    expect(view()).toMatchObject({ ariaLabel: 'Go to Query', input: { value: '', selection: 'end' } })
    quickInput.filter('a.s')
    const goTo = view().session
    await key('workbench.quickOpen')
    expect(view()).toMatchObject({ session: goTo, input: { value: 'a.s', selection: 'all' } })
    await key('workbench.showCommands')
    expect(view()).toMatchObject({ ariaLabel: 'Command Palette', input: { value: '>' } })
  })
  it('closes before any other command runs, returning focus first', async () => {
    const { key, quickInput, focus, documents, commands, events } = palette()
    let focusWhenRun: unknown
    events.subscribe(event => { if (event.type === 'documents.activated') focusWhenRun = focus.focused })
    focus.focused = 'editor'
    await key('workbench.showCommands')
    focus.focused = 'quick input'
    await key('file.new')
    expect(quickInput.visible).toBe(false)
    expect(focusWhenRun).toBe('editor')
    expect(focus.restored).toEqual(['editor'])
    expect(documents.getSnapshot().documents).toHaveLength(1)
    await key('workbench.showCommands')
    await commands.execute('layout.reset', undefined, 'menu')
    expect(quickInput.visible).toBe(false)
  })
  it.each(platforms)('stays open for Undo and Redo from the menu on %s, so they act on its input and not the editor', async platform => {
    const { key, quickInput, focus, commands, documents } = palette({ platform })
    // shell.ts reads the DOM focus: the quick input's <input>, or Monaco's text area once focus returns to the editor.
    class FakeElement { isContentEditable = false; constructor(readonly inEditor: boolean) {} matches(selector: string) { return selector === 'input, textarea' } closest(selector: string) { return this.inEditor && selector === '.monaco-editor' ? this : null } }
    const field = new FakeElement(false), editorText = new FakeElement(true), execCommand = vi.fn()
    vi.stubGlobal('HTMLElement', FakeElement)
    vi.stubGlobal('document', { get activeElement() { return focus.focused === 'quick input' ? field : editorText }, execCommand })
    documents.create('a.sql', 'SELECT 7;', 'master')
    await key('workbench.showCommands')
    focus.focused = 'quick input'
    quickInput.filter('>abc')
    // ⌘Z in the input on macOS, or Edit › Undo clicked while the input keeps focus.
    await expect(commands.execute('edit.undo', undefined, 'menu')).resolves.toBe(true)
    await expect(commands.execute('edit.redo', undefined, 'menu')).resolves.toBe(true)
    expect(quickInput.visible).toBe(true)
    expect(focus.restored).toEqual([])
    expect(execCommand.mock.calls).toEqual([['undo'], ['redo']])
    await commands.execute('layout.reset', undefined, 'menu')
    expect(quickInput.visible).toBe(false)
  })
  it('does not open behind a modal dialog', async () => {
    let modal = true
    const { key, quickInput } = palette({ modal: () => modal })
    await expect(key('workbench.showCommands')).resolves.toBe(false)
    expect(quickInput.visible).toBe(false)
    modal = false
    await expect(key('workbench.showCommands')).resolves.toBe(true)
  })
  it('lists recently used commands first, newest first, at most ten', async () => {
    const recent: CommandId[] = ['layout.reset', 'file.new', 'window.output', 'window.editor', 'window.explorer', 'layout.save', 'layout.load', 'edit.undo', 'edit.redo', 'file.open', 'document.next']
    const { key, view, quickInput, history } = palette({ storage: memoryStorage({ [historyKey]: JSON.stringify(recent) }) })
    await key('workbench.showCommands')
    const rows = view().rows
    expect(rows.slice(0, 10).map(row => row.item.id)).toEqual(recent.slice(0, 10))
    expect(rows.map(row => row.group).filter(Boolean)).toEqual(['recently used', 'other commands'])
    expect(rows[10].group).toBe('other commands')
    quickInput.filter('>layout')
    expect(view().rows.map(row => row.item.id)).toEqual(['layout.reset', 'layout.save', 'layout.load'])
    quickInput.filter('>reset layout')
    quickInput.accept()
    await settle()
    expect(history.ids[0]).toBe('layout.reset')
  })
})

describe('Go to Query', () => {
  it('lists open queries most recent first with the previous one active, so Enter switches back', async () => {
    const { key, quickInput, view, documents, connections } = palette()
    connections.add({ ...connectionInfo('server-a'), displayName: 'Production' })
    const a = documents.create('a.sql', 'SELECT 1', 'AppData', 'server-a', true), b = documents.create('b.sql', '', 'master', undefined, false, { id: 'f', name: 'b.sql', path: '/tmp/b.sql' })
    const c = documents.create('c.sql', '', 'master')
    documents.activate(a.id)
    await key('workbench.quickOpen')
    expect(view().rows.map(row => [row.item.label, row.item.description, row.item.tooltip])).toEqual([
      ['a.sql', 'unsaved · Production · AppData', undefined], ['c.sql', 'Disconnected · master', undefined], ['b.sql', 'Disconnected · master', '/tmp/b.sql']])
    expect(view().rows[view().activeIndex].item.id).toBe(c.id)
    quickInput.accept()
    expect(documents.getSnapshot().activeId).toBe(c.id)
    await key('workbench.quickOpen')
    expect(view().rows[view().activeIndex].item.id).toBe(a.id)
    quickInput.filter('produc')
    expect(view().rows.map(row => row.item.id)).toEqual([a.id])
    quickInput.hide('cancel')
    // Closing the active query activates its neighbour, which becomes the most recent.
    await documents.runTask(() => documents.close(c.id))
    await key('workbench.quickOpen')
    expect(view().rows.map(row => row.item.id)).toEqual([b.id, a.id])
  })
})

describe('server and database pickers', () => {
  it('disconnects the picked server, leaving busy servers unavailable', async () => {
    const { commands, quickInput, view, connections, documents, startQuery, host } = palette()
    connections.add({ ...connectionInfo('server-a'), displayName: 'Production' }); connections.add(connectionInfo('server-b'))
    documents.create('a.sql', 'SELECT 1', 'master', 'server-a')
    const running = startQuery()
    await commands.execute('connection.disconnect', undefined, 'menu')
    expect(view()).toMatchObject({ ariaLabel: 'Disconnect from Server', noun: 'servers' })
    expect(view().rows.map(row => [row.item.label, row.item.description, row.item.icon, row.item.disabled])).toEqual([
      ['Production', 'server-a.example · 17.0', 'server', true], ['server-b.example', '17.0', 'server', undefined]])
    quickInput.accept()
    expect(view().message?.text).toBe('A query is running on this server.')
    quickInput.move('next')
    quickInput.accept()
    expect(host.disconnect).toHaveBeenCalledWith('server-b')
    await running.finish()
  })
  it('moves the active query to another server or to Disconnected', async () => {
    const { commands, quickInput, view, connections, documents, api } = palette()
    connections.add(connectionInfo('server-a')); connections.add({ ...connectionInfo('server-b'), database: 'Sales' })
    const tab = documents.create('a.sql', '', 'AppData', 'server-a')
    await commands.execute('query.changeConnection', undefined, 'palette')
    expect(view().rows.map(row => row.item.label)).toEqual(['Disconnected', 'server-a.example', 'server-b.example'])
    expect(view().rows[view().activeIndex].item.id).toBe('server-a')
    // Enter on the current server keeps the query's session (and any open transaction).
    quickInput.accept()
    await settle()
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-a', database: 'AppData' })
    await commands.execute('query.changeConnection', undefined, 'palette')
    quickInput.filter('server-b')
    quickInput.accept()
    await settle()
    expect(api.closeQuerySession).toHaveBeenCalledWith(tab.id)
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-b', database: 'Sales' })
    await commands.execute('query.changeConnection', undefined, 'palette')
    expect(view().rows[view().activeIndex].item.id).toBe('server-b')
    quickInput.accept(0)
    await settle()
    expect(documents.get(tab.id)?.connectionId).toBeUndefined()
  })
  it('changes the database from a grouped list loaded from the server', async () => {
    const { commands, quickInput, view, connections, documents, api } = palette()
    const databases: DatabaseInfo[] = [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false },
      { name: 'AppData_snap', isSystem: false, isSnapshot: true }, { name: 'Sales', isSystem: false, isSnapshot: false }]
    api.databases.mockResolvedValue({ ok: true, value: databases })
    connections.add(connectionInfo('server-a'))
    const tab = documents.create('a.sql', '', 'master', 'server-a')
    const done = commands.execute('query.changeDatabase', undefined, 'keybinding')
    expect(view()).toMatchObject({ ariaLabel: 'Change Database', loading: true })
    await done
    await settle()
    expect(api.databases).toHaveBeenCalledWith('server-a')
    expect(view().rows.map(row => [row.item.label, row.group])).toEqual([['AppData', 'databases'], ['Sales', undefined], ['master', 'system databases'], ['AppData_snap', 'database snapshots']])
    expect(view().rows[view().activeIndex].item.label).toBe('master')
    quickInput.filter('AppD')
    expect(view().rows.map(row => row.item.label)).toEqual(['AppData', 'AppData_snap'])
    quickInput.accept()
    expect(documents.get(tab.id)?.database).toBe('AppData')
  })
  it('ignores a database picked after the query moved, and reports a failed load', async () => {
    const { commands, quickInput, view, connections, documents, api, targets } = palette()
    api.databases.mockResolvedValue({ ok: true, value: [{ name: 'Sales', isSystem: false, isSnapshot: false }] })
    connections.add(connectionInfo('server-a')); connections.add(connectionInfo('server-b'))
    const tab = documents.create('a.sql', '', 'master', 'server-a')
    await commands.execute('query.changeDatabase', undefined, 'keybinding')
    await settle()
    targets.update(tab.id, { connectionId: 'server-b' })
    quickInput.accept()
    expect(documents.get(tab.id)?.database).toBe('master')
    api.databases.mockResolvedValue({ ok: false, error: 'The server went away.' })
    await commands.execute('query.changeDatabase', undefined, 'keybinding')
    await settle()
    expect(view()).toMatchObject({ rows: [], message: { text: 'Could not load databases: The server went away.', severity: 'error' } })
  })
})
