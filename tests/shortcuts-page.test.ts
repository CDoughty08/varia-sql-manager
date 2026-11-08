// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveRules } from '../src/shared/commands/effective'
import { parseKeySpec, type Platform } from '../src/shared/commands/keybindings'
import { emptyShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { createFakeShortcutsService, type FakeShortcutsService } from '../src/renderer/src/core/ShortcutsService.fake'
import { commitOptions } from '../src/renderer/src/settings/options-form'
import type { CaptureSource } from '../src/renderer/src/settings/shortcuts/CaptureField'
import ShortcutsPage from '../src/renderer/src/settings/shortcuts/ShortcutsPage'
import {
  assignShortcut, commandRows, importSummary, mergeImport, removeRule, resetAll, resetAllCounts, resetCommand, restoreRule, stagedChanges, storedKey, verdictFor
} from '../src/renderer/src/settings/shortcuts/shortcut-draft'

const file = (bindings: ShortcutFile['bindings'], extra: Partial<ShortcutFile> = {}): ShortcutFile => ({ ...emptyShortcutFile, bindings, ...extra })
const chords = (spec: string, platform: Platform = 'win32') => parseKeySpec(spec, platform)
const rowOf = (draft: ShortcutFile, id: string, platform: Platform = 'win32') => commandRows(draft, platform).find(row => row.id === id)!
const ruleOf = (draft: ShortcutFile, id: string, key: string, platform: Platform = 'win32') => effectiveRules(platform, draft).rules.find(rule => rule.command === id && rule.chords.join(' ') === chords(key, platform).join(' '))!

describe('Shortcuts draft', () => {
  it('writes recorded keys with mod, and a platform only for a modifier one platform alone has', () => {
    expect(storedKey(chords('ctrl+shift+e'), 'win32')).toEqual({ key: 'mod+shift+e' })
    expect(storedKey(chords('meta+shift+e', 'darwin'), 'darwin')).toEqual({ key: 'mod+shift+e' })
    expect(storedKey(chords('ctrl+e', 'darwin'), 'darwin')).toEqual({ key: 'ctrl+e', platform: 'darwin' })
    expect(storedKey(chords('meta+e'), 'linux')).toEqual({ key: 'meta+e', platform: 'linux' })
    expect(storedKey(chords('ctrl+k ctrl+q'), 'win32')).toEqual({ key: 'mod+k mod+q' })
    expect(storedKey(chords('f5'), 'win32')).toEqual({ key: 'f5' })
  })
  it('stages an assignment as an entry, Global without a scope, and lists it as the user\'s', () => {
    const draft = assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+shift+e'), 'global', 'win32')
    expect(draft.bindings).toEqual([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    const scoped = assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+shift+e'), 'queryEditor', 'win32')
    expect(scoped.bindings).toEqual([{ command: 'file.saveAs', key: 'mod+shift+e', scope: 'queryEditor' }])
    const row = rowOf(draft, 'file.saveAs')
    expect(row.changed).toBe(true)
    expect(row.bindings.map(binding => [binding.label.text, binding.source, binding.scopeTitle, binding.entry])).toEqual([['Ctrl+Shift+E', 'user', 'Global', 0]])
    // The same entry works on macOS as ⌘⇧E.
    expect(rowOf(draft, 'file.saveAs', 'darwin').bindings[0].label.text).toBe('⇧⌘E')
  })
  it('removes a default with a removal entry, a user shortcut by dropping its entry, and restores either way', () => {
    const removed = removeRule(emptyShortcutFile, ruleOf(emptyShortcutFile, 'file.new', 'ctrl+n'), 'win32')
    expect(removed.bindings).toEqual([{ command: 'file.new', key: 'mod+n', remove: true }])
    const row = rowOf(removed, 'file.new')
    expect(row.bindings.map(binding => binding.source)).toEqual(['removed'])
    expect(restoreRule(removed, row.bindings[0].rule, 'win32').bindings).toEqual([])
    // Assigning a removed default back restores it rather than adding an entry.
    expect(assignShortcut(removed, 'file.new', chords('ctrl+n'), 'global', 'win32').bindings).toEqual([])
    const added = assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+shift+e'), 'global', 'win32')
    expect(removeRule(added, ruleOf(added, 'file.saveAs', 'ctrl+shift+e'), 'win32').bindings).toEqual([])
    // Locked keys cannot be removed.
    expect(removeRule(emptyShortcutFile, ruleOf(emptyShortcutFile, 'edit.copy', 'ctrl+c'), 'win32')).toBe(emptyShortcutFile)
  })
  it('reassigns a conflicting key by removing it from the other command, or offers a narrower scope', () => {
    const verdict = verdictFor(emptyShortcutFile, 'file.saveAs', chords('ctrl+u'), 'global', 'win32')
    expect(verdict.verdict).toBe('conflict')
    expect(verdict.conflicts.map(rule => rule.command)).toEqual(['query.changeDatabase'])
    expect(verdict.narrowerScopes).toContain('queryEditor')
    const draft = assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+u'), 'global', 'win32', verdict.conflicts)
    expect(draft.bindings).toEqual([{ command: 'query.changeDatabase', key: 'mod+u', remove: true }, { command: 'file.saveAs', key: 'mod+u' }])
    expect(effectiveRules('win32', draft).problems).toEqual([])
    // A narrower scope shadows the Global key instead.
    expect(verdictFor(emptyShortcutFile, 'file.saveAs', chords('ctrl+u'), 'queryEditor', 'win32').verdict).toBe('shadow')
  })
  it('counts staged changes, resets a command and resets all but other platforms\' entries', () => {
    const stored = file([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.closeAll', key: 'mod+shift+q' }, { command: 'file.closeAll', key: 'meta+q', platform: 'darwin' }], { gestures: { 'grid.addToSelection': 'alt' } })
    expect(stagedChanges(draft, stored)).toBe(3)
    expect(stagedChanges(stored, stored)).toBe(0)
    expect(resetCommand(draft, 'file.closeAll', 'win32').bindings).toEqual([stored.bindings[0], draft.bindings[2]])
    expect(resetAllCounts(draft, 'win32')).toEqual({ here: 2, elsewhere: 1, gestures: 1 })
    expect(resetAll(draft, 'win32')).toEqual({ ...draft, bindings: [draft.bindings[2]], gestures: {} })
    expect(resetAll(draft, 'win32', true).bindings).toEqual([])
  })
  it('previews an import and merges it, the file taking keys it conflicts on', () => {
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    const incoming = file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.closeAll', key: 'mod+u' }], { gestures: { 'grid.addToSelection': 'alt' }, unknown: [{ command: 'query.fromTheFuture', key: 'f9' }] })
    const summary = importSummary(draft, incoming, 'win32')
    expect([summary.shortcuts, summary.added, summary.same, summary.unknown, summary.gestures, summary.yours, summary.tooMany]).toEqual([2, 1, 1, 1, 1, 1, false])
    expect(summary.conflicts.map(conflict => [conflict.label.text, conflict.command, conflict.with])).toEqual([['Ctrl+U', 'Close All', ['Change Database…']]])
    const merged = mergeImport(draft, incoming, 'win32')
    expect(merged.bindings).toEqual([draft.bindings[0], { command: 'query.changeDatabase', key: 'mod+u', remove: true }, { command: 'file.closeAll', key: 'mod+u' }])
    expect(merged.gestures).toEqual({ 'grid.addToSelection': 'alt' })
    expect(merged.unknown).toEqual(incoming.unknown)
    expect(effectiveRules('win32', merged).problems).toEqual([])
  })
})

describe('Options OK', () => {
  const targets = (log: string[], { settings, shortcuts }: { settings?: Error; shortcuts?: { error: string; code?: string } } = {}) => ({
    update: async () => { log.push('settings'); if (settings) throw settings },
    saveShortcuts: async () => { log.push('shortcuts'); return shortcuts ? { ok: false as const, ...shortcuts } as never : { ok: true as const, value: { revision: 2 } } }
  })
  it('saves settings first, then shortcuts, and skips what did not change', async () => {
    const log: string[] = []
    expect(await commitOptions(targets(log), { 'textEditor.sql.tabSize': 2 } as never, emptyShortcutFile)).toEqual({ ok: true })
    expect(log).toEqual(['settings', 'shortcuts'])
    log.length = 0
    expect(await commitOptions(targets(log), {} as never, emptyShortcutFile)).toEqual({ ok: true })
    expect(await commitOptions(targets(log), {} as never, undefined)).toEqual({ ok: true })
    expect(log).toEqual(['shortcuts'])
  })
  it('stops at a settings failure, and says the settings were saved when only shortcuts fail', async () => {
    const log: string[] = []
    expect(await commitOptions(targets(log, { settings: new Error('Disk full.') }), { 'textEditor.sql.tabSize': 2 } as never, emptyShortcutFile)).toEqual({ ok: false, stage: 'settings', message: 'Disk full.' })
    expect(log).toEqual(['settings'])
    const stale = await commitOptions(targets([], { shortcuts: { error: 'Stale.', code: 'STALE' } }), { 'textEditor.sql.tabSize': 2 } as never, emptyShortcutFile)
    expect(stale).toEqual({ ok: false, stage: 'shortcuts', message: 'Your other settings were saved, but shortcuts were not: they changed in another window. Your changes are still here; choose OK to try again.' })
    const failed = await commitOptions(targets([], { shortcuts: { error: 'The file is read-only.' } }), {} as never, emptyShortcutFile)
    expect(failed).toEqual({ ok: false, stage: 'shortcuts', message: 'Shortcuts were not saved: The file is read-only. Your changes are still here; choose OK to try again.' })
  })
  it('keeps the draft through a STALE save of the fake service, and saves it on the next try', async () => {
    const service = createFakeShortcutsService()
    service.changeElsewhere(file([{ command: 'file.closeAll', key: 'mod+shift+q' }]))
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    service.failNextSave('The shortcuts changed in another window.', 'STALE')
    const first = await commitOptions({ update: async () => {}, saveShortcuts: next => service.save(next) }, {} as never, draft)
    expect(first.ok).toBe(false)
    expect(await commitOptions({ update: async () => {}, saveShortcuts: next => service.save(next) }, {} as never, draft)).toEqual({ ok: true })
    expect(service.stored().file).toEqual(draft)
  })
})

// The page in a DOM, over the fake service, with the draft held as OptionsDialog holds it.
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
describe('Shortcuts page', () => {
  let root: Root, host: HTMLElement, service: FakeShortcutsService, latest: ShortcutFile
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    service = createFakeShortcutsService()
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  function Harness({ initial, capture }: { initial: ShortcutFile; capture?: CaptureSource }) {
    const [draft, setDraft] = useState(initial)
    latest = draft
    return createElement(ShortcutsPage, { draft, stored: emptyShortcutFile, onChange: setDraft, platform: 'win32', files: service, capture })
  }
  const render = (initial: ShortcutFile = emptyShortcutFile, capture?: CaptureSource) => act(() => root.render(createElement(Harness, { initial, capture })))
  const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
  const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })
  const row = (id: string, index = 0) => q(`tr[data-row="${id}:${index}"]`)
  const press = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
  const search = (text: string) => act(() => {
    const input = q<HTMLInputElement>('input[aria-label="Search shortcuts"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  it('shows the heading, the views, the scheme row and the table with the first command selected', async () => {
    await render()
    expect(q('h4')?.textContent).toBe('Keyboard and mouse shortcuts')
    expect([...host.querySelectorAll('[role="radio"]')].map(item => [item.textContent, item.getAttribute('aria-checked')])).toEqual([['All', 'true'], ['Keyboard', 'false'], ['Mouse', 'false']])
    expect(q<HTMLSelectElement>('#shortcuts-scheme')!.selectedOptions[0].textContent).toBe('SQL Server (default)')
    expect(['Import…', 'Export…', 'Reset All…'].map(name => !!button(name))).toEqual([true, true, true])
    expect(q('table[role="grid"]')?.getAttribute('aria-label')).toBe('Shortcuts')
    expect(row('file.new')?.getAttribute('aria-selected')).toBe('true')
    expect(q('section')?.getAttribute('aria-label')).toBe('Shortcuts for New Query')
    expect(host.textContent).toContain('Shortcut currently used by:')
  })
  it('records a key, checks it as it is pressed, and stages it with Assign', async () => {
    await render()
    await search('file.saveAs')
    await click(row('file.saveAs', -1))
    const capture = q<HTMLInputElement>('#shortcuts-capture')!
    await press(capture, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })
    expect(capture.value).toBe('Ctrl+Shift+E')
    expect(q('.shortcuts-message')?.textContent).toContain('Ctrl+Shift+E is not used.')
    await click(button('Assign'))
    expect(latest.bindings).toEqual([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    expect(row('file.saveAs')?.querySelector('[aria-label="Changed"]')).not.toBeNull()
    expect(capture.value).toBe('')
    // Tab is never recorded: it leaves the box.
    await press(capture, { key: 'Tab', code: 'Tab' })
    expect(capture.value).toBe('')
    // The row's Reset drops the staged entry.
    await click(button('Reset Ctrl+Shift+E for Save As…'))
    expect(latest.bindings).toEqual([])
  })
  it('refuses a key Assign may not take, and opens the conflict sheet for one in use', async () => {
    await render()
    await search('file.saveAs')
    await click(row('file.saveAs', -1))
    const capture = q<HTMLInputElement>('#shortcuts-capture')!
    await press(capture, { key: 'Enter', code: 'Enter' })
    expect(q('.shortcuts-message[role="alert"]')?.textContent).toContain('cannot be a Global shortcut')
    expect(button('Assign')?.disabled).toBe(true)
    await press(capture, { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(host.textContent).toContain('Change Database…')
    await click(button('Assign'))
    const sheet = q('[role="alertdialog"]')!
    expect(sheet.querySelector('h4')?.textContent).toBe('Ctrl+U is already used')
    expect([...sheet.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Reassign', 'Use SQL Query Editor', 'Cancel'])
    // Escape cancels the sheet and nothing is staged.
    await press(sheet, { key: 'Escape', code: 'Escape' })
    expect(q('[role="alertdialog"]')).toBeNull()
    expect(latest.bindings).toEqual([])
    await click(button('Assign'))
    await click(button('Reassign'))
    expect(latest.bindings).toEqual([{ command: 'query.changeDatabase', key: 'mod+u', remove: true }, { command: 'file.saveAs', key: 'mod+u' }])
  })
  it('records through the workbench\'s capture when there is one, two-part chords included', async () => {
    let listener: ((chord: string) => void) | undefined, stopped = 0
    const capture: CaptureSource = onChord => { listener = onChord; return () => { stopped++; listener = undefined } }
    await render(emptyShortcutFile, capture)
    await search('file.saveAs')
    await click(row('file.saveAs', -1))
    const field = q<HTMLInputElement>('#shortcuts-capture')!
    await act(() => { field.focus() })
    expect(listener).toBeDefined()
    await act(() => listener!('ctrl+k ctrl+q'))
    expect(field.value).toBe('Ctrl+K Ctrl+Q')
    // A two-part shortcut works only in the query editor.
    expect(q('.shortcuts-message[role="alert"]')?.textContent).toContain('Two-part shortcuts must start with Ctrl+K')
    await act(() => { q<HTMLSelectElement>('#shortcuts-scope')!.value = 'queryEditor'; q('#shortcuts-scope')!.dispatchEvent(new Event('change', { bubbles: true })) })
    await click(button('Assign'))
    expect(latest.bindings).toEqual([{ command: 'file.saveAs', key: 'mod+k mod+q', scope: 'queryEditor' }])
    await act(() => { field.blur() })
    expect(stopped).toBe(1)
  })
  it('shows a locked command\'s reason and keeps it from being changed', async () => {
    await render()
    await search('edit.copy')
    await click(row('edit.copy'))
    expect(host.textContent).toContain('The clipboard keys stay with the system.')
    expect(q<HTMLFieldSetElement>('fieldset.shortcuts-new')!.disabled).toBe(true)
    expect(button('Remove Ctrl+C')).toBeUndefined()
  })
  it('refuses a file main could not read, and previews and merges one it could', async () => {
    await render()
    service.answerImport({ error: 'It is not a Varia shortcuts file, or it is larger than 128 KiB.' })
    await click(button('Import…'))
    await act(async () => {})
    expect(q('[role="alertdialog"] h4')?.textContent).toBe('This file cannot be imported')
    expect(q('[role="alertdialog"]')?.textContent).toContain('larger than 128 KiB. Nothing was changed.')
    await click(button('OK'))
    expect(latest).toBe(emptyShortcutFile)
    service.answerImport({ file: file([{ command: 'file.closeAll', key: 'mod+shift+q' }]) })
    await click(button('Import…'))
    await act(async () => {})
    expect(q('[role="dialog"] h4')?.textContent).toBe('Import shortcuts')
    await click(button('Import'))
    expect(latest.bindings).toEqual([{ command: 'file.closeAll', key: 'mod+shift+q' }])
    // Nothing is saved until OK.
    expect(service.saves).toEqual([])
  })
  it('exports the draft and resets all of it after asking', async () => {
    await render(file([{ command: 'file.closeAll', key: 'mod+shift+q' }, { command: 'file.closeAll', key: 'meta+q', platform: 'darwin' }]))
    await click(button('Export…'))
    await act(async () => {})
    expect(service.exports).toEqual([latest])
    expect(host.textContent).toContain('Exported 2 shortcuts and 0 gestures')
    await click(button('Reset All…'))
    expect(q('[role="alertdialog"]')?.textContent).toContain('1 entry for other platforms stay in the file')
    await click([...q('[role="alertdialog"]')!.querySelectorAll('button')].find(item => item.textContent === 'Reset All'))
    expect(latest.bindings).toEqual([{ command: 'file.closeAll', key: 'meta+q', platform: 'darwin' }])
  })
  it('lists entries that no longer apply, and removes them', async () => {
    await render(file([{ command: 'file.saveAs', key: 'mod+u' }]))
    expect(host.textContent).toContain('1 shortcut no longer applies.')
    await click(button('Remove'))
    expect(latest.bindings).toEqual([])
  })
})
