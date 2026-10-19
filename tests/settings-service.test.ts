import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VariaApi } from '../src/shared/contracts'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { EditorOptionsService } from '../src/renderer/src/services/editor-options'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import type { SettingsState } from '../src/shared/settings/schema'
import { deferred, TestEditor } from './fixtures/documents'
import { createTestWorkbench, settingsApi } from './fixtures/workbench'
import { settingsDocumentOptions } from '../src/renderer/src/services/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers() })

type Loaded = Awaited<ReturnType<VariaApi['getSettings']>>
type Updated = Awaited<ReturnType<VariaApi['updateSettings']>>
const stored: SettingsValues = { ...defaultSettings, 'textEditor.sql.wordWrap': true, 'queryExecution.executionTimeout': 30 }
function setup(get?: () => Promise<Loaded>) {
  const api = settingsApi({ 'textEditor.sql.wordWrap': true, 'queryExecution.executionTimeout': 30 })
  if (get) api.getSettings.mockImplementation(get)
  const reports: [string, string][] = []
  const service = new SettingsService(api)
  service.setReporter((message, kind) => reports.push([message, kind]))
  cleanups.push(() => service.dispose())
  return { api, service, reports }
}

describe('settings service', () => {
  it('holds the defaults until main\'s settings arrive, and reads them once', async () => {
    const { api, service, reports } = setup()
    expect(service.getSnapshot()).toEqual({ values: defaultSettings, revision: 0, loaded: false })
    await Promise.all([service.load(), service.load()])
    await service.load()
    expect(api.getSettings).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toEqual({ values: stored, revision: 1, loaded: true })
    expect(service.get('queryExecution.executionTimeout')).toBe(30)
    expect(reports).toEqual([])
  })
  it('resolves create with the defaults when main is slow, and applies main\'s values when they arrive', async () => {
    vi.useFakeTimers()
    const answer = deferred<Loaded>()
    const api = settingsApi()
    api.getSettings.mockImplementation(() => answer.promise)
    const creating = SettingsService.create(api, { timeout: 1500 })
    await vi.advanceTimersByTimeAsync(1500)
    const service = await creating
    cleanups.push(() => service.dispose())
    expect(service.getSnapshot()).toMatchObject({ values: defaultSettings, loaded: false })
    answer.resolve({ ok: true, value: { revision: 1, values: stored } })
    await vi.waitFor(() => expect(service.getSnapshot()).toMatchObject({ values: stored, revision: 1, loaded: true }))
  })
  it('publishes main\'s warning once, reported as a warning, even before the workbench sets a reporter', async () => {
    const warning = 'Settings were invalid (not valid JSON) and were reset; the original file was kept.'
    const api = settingsApi()
    api.getSettings.mockResolvedValue({ ok: true, value: { revision: 1, values: defaultSettings, warning } })
    const service = await SettingsService.create(api)
    cleanups.push(() => service.dispose())
    const reports: string[] = []
    service.setReporter((message, kind) => reports.push(kind + ': ' + message))
    await service.load()
    expect(service.getSnapshot()).toEqual({ values: defaultSettings, revision: 1, loaded: true, warning })
    expect(reports).toEqual(['warning: ' + warning])
  })
  it('keeps the defaults and reports a failed read once, then reads again on the next load', async () => {
    const cases: [() => Promise<Loaded>, string][] = [
      [async () => ({ ok: false, error: 'Expected a regular file.' }), 'Expected a regular file.'],
      [async () => { throw new Error('IPC failed.') }, 'IPC failed.'],
      [async () => ({ ok: true, value: { revision: 1, values: { ...defaultSettings, 'textEditor.sql.tabSize': 0 } } }), 'Main sent settings this version does not support.']
    ]
    for (const [get, error] of cases) {
      const { api, service, reports } = setup(get)
      expect(await Promise.all([service.load(), service.load()])).toEqual([false, false])
      expect(service.getSnapshot()).toEqual({ values: defaultSettings, revision: 0, loaded: true })
      expect(reports).toEqual([[`Settings could not be loaded, so the defaults are used: ${error}`, 'error']])
      api.getSettings.mockResolvedValue({ ok: true, value: { revision: 1, values: stored } })
      expect(await service.load()).toBe(true)
      expect(service.getSnapshot().values).toEqual(stored)
      expect(reports).toHaveLength(1)
    }
  })
  it('ignores pushes that are invalid or no newer than what it holds', async () => {
    const { api, service } = setup()
    const push = api.onSettingsChanged.mock.calls[0][0]
    await service.load()
    const newer: SettingsState = { revision: 3, values: { ...stored, 'textEditor.sql.tabSize': 2 } }
    push(newer)
    expect(service.getSnapshot()).toMatchObject(newer)
    push({ revision: 2, values: defaultSettings })
    push({ revision: 3, values: defaultSettings })
    push({ revision: 9, values: { ...defaultSettings, 'textEditor.sql.tabSize': 'two' } } as unknown as SettingsState)
    push({ revision: 9 } as unknown as SettingsState)
    expect(service.getSnapshot()).toMatchObject(newer)
  })
  it('publishes main\'s answer to an update, and leaves the snapshot as it was when main refuses it', async () => {
    const { api, service } = setup()
    await service.load()
    await service.update({ 'textEditor.sql.tabSize': 2, 'queryExecution.executionTimeout': null })
    expect(api.updateSettings).toHaveBeenCalledWith({ 'textEditor.sql.tabSize': 2, 'queryExecution.executionTimeout': null })
    expect(service.getSnapshot()).toMatchObject({ revision: 2, values: { ...stored, 'textEditor.sql.tabSize': 2, 'queryExecution.executionTimeout': 0 } })
    const before = service.getSnapshot()
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: 'Settings could not be read, so changes are not saved.' })
    await expect(service.update({ 'textEditor.sql.tabSize': 3 })).rejects.toThrow('Settings could not be read, so changes are not saved.')
    await expect(service.update({ 'textEditor.unknown': true } as never)).rejects.toThrow()
    await expect(service.update({})).rejects.toThrow()
    expect(service.getSnapshot()).toBe(before)
    expect(api.updateSettings).toHaveBeenCalledTimes(2)
  })
  it('keeps a toggle whose save failed for this session, warns once, and drops it after a later save', async () => {
    const { api, service, reports } = setup()
    await service.load()
    api.updateSettings.mockResolvedValue({ ok: false, error: 'Disk full.' })
    await service.toggle('textEditor.sql.wordWrap')
    expect(service.get('textEditor.sql.wordWrap')).toBe(false)
    await service.toggle('textEditor.sql.wordWrap')
    expect(service.get('textEditor.sql.wordWrap')).toBe(true)
    await service.toggle('textEditor.sql.wordWrap')
    expect(reports).toEqual([['Settings could not be saved: Disk full. The change applies until you close Varia SQL Manager.', 'warning']])
    expect(service.get('textEditor.sql.wordWrap')).toBe(false)
    // Main's newer state does not undo the session's value; a save of the key does.
    api.onSettingsChanged.mock.calls[0][0]({ revision: 2, values: { ...stored, 'textEditor.sql.tabSize': 2 } })
    expect(service.getSnapshot()).toMatchObject({ revision: 2, values: { 'textEditor.sql.wordWrap': false, 'textEditor.sql.tabSize': 2 } })
    api.updateSettings.mockImplementation(async patch => ({ ok: true, value: { revision: 3, values: { ...stored, 'textEditor.sql.tabSize': 2, ...patch } as SettingsValues } }))
    await service.toggle('textEditor.sql.wordWrap')
    expect(service.get('textEditor.sql.wordWrap')).toBe(true)
    expect(api.updateSettings).toHaveBeenLastCalledWith({ 'textEditor.sql.wordWrap': true })
  })
  it('flips a second toggle pressed while the first is being saved', async () => {
    const { api, service } = setup()
    await service.load()
    // As over IPC, main's answer comes later, and nothing has changed before it does.
    const answers: ReturnType<typeof deferred<Updated>>[] = []
    api.updateSettings.mockImplementation(() => { const answer = deferred<Updated>(); answers.push(answer); return answer.promise })
    const first = service.toggle('textEditor.sql.wordWrap'), second = service.toggle('textEditor.sql.wordWrap')
    expect(api.updateSettings.mock.calls.map(call => call[0])).toEqual([{ 'textEditor.sql.wordWrap': false }, { 'textEditor.sql.wordWrap': true }])
    answers[0].resolve({ ok: true, value: { revision: 2, values: { ...stored, 'textEditor.sql.wordWrap': false } } })
    answers[1].resolve({ ok: true, value: { revision: 3, values: stored } })
    await Promise.all([first, second])
    expect(service.get('textEditor.sql.wordWrap')).toBe(true)
  })
  it('closes only the dialog whose OK saved, once main has the changes', async () => {
    const { api, service } = setup()
    await service.load()
    const answer = deferred<Updated>()
    api.updateSettings.mockImplementationOnce(() => answer.promise)
    service.openDialog()
    const saving = service.saveDialog({ 'textEditor.sql.tabSize': 2 })
    expect(service.dialog.getSnapshot().open).toBe(true)
    // Closed and opened again before the answer: the new dialog stays open.
    service.closeDialog()
    service.openDialog('objectExplorer.scripting')
    answer.resolve({ ok: true, value: { revision: 2, values: { ...stored, 'textEditor.sql.tabSize': 2 } } })
    expect(await saving).toBe(false)
    expect(service.dialog.getSnapshot()).toEqual({ open: true, page: 'objectExplorer.scripting' })
    expect(await service.saveDialog({ 'textEditor.sql.tabSize': 3 })).toBe(true)
    expect(service.dialog.getSnapshot()).toEqual({ open: false })
    // A refused save leaves the dialog open, with main's error to show.
    service.openDialog()
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: 'Disk full.' })
    await expect(service.saveDialog({ 'textEditor.sql.tabSize': 4 })).rejects.toThrow('Disk full.')
    expect(service.dialog.getSnapshot().open).toBe(true)
  })
  it('opens the dialog on a page, else the page last shown, else Environment › General', () => {
    const { service } = setup()
    service.openDialog()
    expect(service.dialog.getSnapshot()).toEqual({ open: true, page: 'environment.general' })
    service.showedPage('textEditor.transactSql.tabs')
    service.closeDialog()
    expect(service.dialog.getSnapshot()).toEqual({ open: false })
    service.openDialog()
    expect(service.dialog.getSnapshot()).toEqual({ open: true, page: 'textEditor.transactSql.tabs' })
    service.openDialog('objectExplorer.scripting')
    expect(service.dialog.getSnapshot()).toEqual({ open: true, page: 'objectExplorer.scripting' })
  })
  it('unsubscribes from main on dispose and ignores answers after it', async () => {
    const answer = deferred<Loaded>()
    const { api, service } = setup(() => answer.promise)
    const loading = service.load()
    service.dispose()
    expect(api.onSettingsChanged).toHaveBeenCalledTimes(1)
    answer.resolve({ ok: true, value: { revision: 1, values: stored } })
    expect(await loading).toBe(false)
    expect(service.getSnapshot().values).toEqual(defaultSettings)
    // The fixture's listener set is empty again.
    await api.updateSettings({ 'textEditor.sql.tabSize': 2 })
    expect(service.getSnapshot().revision).toBe(0)
  })
})

describe('editor options from settings', () => {
  it('gives a new editor the Monaco options of the settings, and every bound editor each change', async () => {
    const { api, service } = setup()
    const options = new EditorOptionsService(service)
    cleanups.push(() => options.dispose())
    expect(options.monacoOptions()).toEqual({ wordWrap: 'off', lineNumbers: 'on', fontSize: 14, dragAndDrop: true, renderLineHighlight: 'line' })
    const applied: unknown[] = []
    options.bindEditor({ updateOptions: value => applied.push(value) })
    await service.load()
    api.onSettingsChanged.mock.calls[0][0]({ revision: 2, values: { ...stored, 'textEditor.sql.lineNumbers': false, 'environment.fonts.editorFontSize': 18, 'textEditor.dragAndDrop': false, 'textEditor.highlightCurrentLine': false } })
    expect(applied).toEqual([
      { wordWrap: 'off', lineNumbers: 'on', fontSize: 14, dragAndDrop: true, renderLineHighlight: 'line' },
      { wordWrap: 'on', lineNumbers: 'on', fontSize: 14, dragAndDrop: true, renderLineHighlight: 'line' },
      { wordWrap: 'on', lineNumbers: 'off', fontSize: 18, dragAndDrop: false, renderLineHighlight: 'none' }
    ])
    // A change to a setting the editor does not use leaves it alone.
    api.onSettingsChanged.mock.calls[0][0]({ revision: 3, values: { ...service.getSnapshot().values, 'queryExecution.executionTimeout': 5 } })
    expect(applied).toHaveLength(3)
  })
})

describe('document options from settings', () => {
  it('maps Tabs and delimiter highlighting: Keep tabs, SSMS\'s default, inserts tab characters', () => {
    let values: SettingsValues = defaultSettings
    const options = settingsDocumentOptions(() => values)
    expect(defaultSettings['textEditor.sql.tabs']).toBe('tabs')
    expect([options.modelOptions(), options.matchBrackets()]).toEqual([{ tabSize: 4, indentSize: 4, insertSpaces: false }, true])
    values = { ...defaultSettings, 'textEditor.sql.tabs': 'spaces', 'textEditor.sql.tabSize': 3, 'textEditor.sql.indentSize': 2, 'textEditor.delimiterHighlighting': false }
    expect([options.modelOptions(), options.matchBrackets()]).toEqual([{ tabSize: 3, indentSize: 2, insertSpaces: true }, false])
  })
  it('applies them through the workbench to new and open documents and to the bound editor', async () => {
    const workbench = createTestWorkbench()
    cleanups.push(() => workbench.dispose())
    const { documents, model, settings } = workbench
    const query = documents.create('a.sql', 'SELECT (1)', 'master')
    const editor = new TestEditor()
    const binding = documents.bindEditor(editor.asEditor())
    cleanups.push(() => binding.dispose())
    expect(model(query.id).options).toEqual({ tabSize: 4, indentSize: 4, insertSpaces: false })
    expect(editor.options).toEqual([])
    await settings.update({ 'textEditor.sql.tabs': 'spaces', 'textEditor.sql.tabSize': 8, 'textEditor.sql.indentSize': 2, 'textEditor.delimiterHighlighting': false })
    expect(model(query.id).options).toEqual({ tabSize: 8, indentSize: 2, insertSpaces: true })
    expect(editor.options).toEqual([{ matchBrackets: 'never' }])
    const next = documents.create('b.sql', '', 'master')
    expect(model(next.id).options).toEqual({ tabSize: 8, indentSize: 2, insertSpaces: true })
  })
})
