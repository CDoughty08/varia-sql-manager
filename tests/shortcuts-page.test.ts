// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveRules } from '../src/shared/commands/effective'
import { parseKeySpec, type Platform } from '../src/shared/commands/keybindings'
import { emptyShortcutFile, shortcutFileSchema, shortcutLimits, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { createFakeShortcutsService, type FakeShortcutsService } from '../src/renderer/src/core/ShortcutsService.fake'
import { commitOptions } from '../src/renderer/src/settings/options-form'
import type { CaptureSource } from '../src/renderer/src/settings/shortcuts/CaptureField'
import ShortcutsPage from '../src/renderer/src/settings/shortcuts/ShortcutsPage'
import OptionsDialog from '../src/renderer/src/settings/OptionsDialog'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { ShortcutsProvider } from '../src/renderer/src/core/ShortcutsContext'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { defaultSettings } from '../src/shared/settings/catalog'

const shortcutsPageId = 'environment.shortcuts'
import {
  assignShortcut, commandRows, followStored, importSummary, mergeImport, removeEntries, removeRule, replaceImport, storable, resetAll, resetAllCounts, resetCommand, restoreRule, saveRevision, shortcutsToSave,
  stagedChanges, startShortcutEdit, storedKey, verdictFor, gestureClash, type ShortcutEdit
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
    expect([summary.shortcuts, summary.added, summary.same, summary.unknown, summary.gestures, summary.yours, summary.clashes, summary.ignored, summary.fits]).toEqual([2, 1, 1, 1, 1, 1, 0, 0, { merge: true, replace: true }])
    expect(summary.conflicts.map(conflict => [conflict.label.text, conflict.command, conflict.with])).toEqual([['Ctrl+U', 'Close All', ['Change Database…']]])
    const merged = mergeImport(draft, incoming, 'win32')
    expect(merged.bindings).toEqual([draft.bindings[0], { command: 'query.changeDatabase', key: 'mod+u', remove: true }, { command: 'file.closeAll', key: 'mod+u' }])
    expect(merged.gestures).toEqual({ 'grid.addToSelection': 'alt' })
    expect(merged.unknown).toEqual(incoming.unknown)
    expect(effectiveRules('win32', merged).problems).toEqual([])
  })
  it('merges a platform-scoped entry\'s reassignment on that platform alone, and writes each removal once', () => {
    // #248: Close All takes Ctrl+U on Windows only, so Change Database keeps it on Linux and macOS.
    const scoped = mergeImport(emptyShortcutFile, file([{ command: 'file.closeAll', key: 'mod+u', platform: 'win32' }]), 'win32')
    expect(scoped.bindings).toEqual([{ command: 'query.changeDatabase', key: 'mod+u', platform: 'win32', remove: true }, { command: 'file.closeAll', key: 'mod+u', platform: 'win32' }])
    expect(effectiveRules('linux', scoped).rules.some(rule => rule.command === 'query.changeDatabase' && rule.chords.join(' ') === 'ctrl+u')).toBe(true)
    // #251: a removal the file already holds is not written again, so one Restore brings the key back.
    const both = mergeImport(emptyShortcutFile, file([{ command: 'query.changeDatabase', key: 'mod+u', remove: true }, { command: 'file.closeAll', key: 'mod+u' }]), 'win32')
    expect(both.bindings.filter(binding => binding.remove)).toHaveLength(1)
  })
  it('treats scope Global written or not as the same entry, and keeps the draft\'s scheme on Merge', () => {
    // #252
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }], { scheme: 'mine' })
    const incoming = file([{ command: 'file.saveAs', key: 'mod+shift+e', scope: 'global' }])
    expect([importSummary(draft, incoming, 'win32').added, importSummary(draft, incoming, 'win32').same]).toEqual([0, 1])
    const merged = mergeImport(draft, incoming, 'win32')
    expect(merged.bindings).toEqual(draft.bindings)
    // #220: the file's default scheme does not replace the user's; Replace takes the file's.
    expect(merged.scheme).toBe('mine')
    expect(replaceImport(draft, incoming).scheme).toBe('default')
  })
  it('previews entries that clash within the file and removals that will be ignored', () => {
    // #222 and #253
    const incoming = file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.closeAll', key: 'mod+shift+e' }, { command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'edit.copy', key: 'mod+c', remove: true }, { command: 'file.new', key: 'f12', remove: true }])
    const summary = importSummary(emptyShortcutFile, incoming, 'win32')
    expect([summary.added, summary.clashes, summary.ignored]).toEqual([4, 1, 2])
    expect(mergeImport(emptyShortcutFile, incoming, 'win32').bindings.filter(binding => binding.command === 'file.saveAs')).toHaveLength(1)
  })
  it('checks either mode against main\'s limits, Replace keeping the draft\'s unreadable records', () => {
    // #219 and #225
    const records = (from: number) => Array.from({ length: 200 }, (_, index) => ({ record: from + index }))
    const draft = file([], { unknown: records(0) }), incoming = file([], { unknown: records(1000) })
    expect(importSummary(draft, incoming, 'win32').fits).toEqual({ merge: false, replace: false })
    expect(storable(replaceImport(draft, incoming))).toBe(false)
    expect(importSummary(emptyShortcutFile, incoming, 'win32').fits).toEqual({ merge: true, replace: true })
  })
  it('keeps a key another platform refuses to this one, and Remove in the banner narrows an entry rather than deleting it', () => {
    // #249: macOS reserves ⌥ letters, so Alt+J recorded on Windows is written for Windows.
    expect(assignShortcut(emptyShortcutFile, 'file.saveAs', chords('alt+j'), 'global', 'win32').bindings).toEqual([{ command: 'file.saveAs', key: 'alt+j', platform: 'win32' }])
    expect(assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+shift+e'), 'global', 'win32').bindings).toEqual([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    const shared = file([{ command: 'file.saveAs', key: 'alt+j' }])
    expect(removeEntries(shared, [0], 'darwin').bindings).toEqual([{ command: 'file.saveAs', key: 'alt+j', platform: 'win32' }, { command: 'file.saveAs', key: 'alt+j', platform: 'linux' }])
    expect(removeEntries(file([{ command: 'file.saveAs', key: 'alt+j', platform: 'darwin' }]), [0], 'darwin').bindings).toEqual([])
  })
  it('finds a user rule by what it is when Reassign removes several', () => {
    // #221: the second conflict was resolved against the draft before the first removal.
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.closeAll', key: 'mod+shift+e', scope: 'queryEditor' }])
    const conflicts = [ruleOf(draft, 'file.saveAs', 'ctrl+shift+e'), ruleOf(draft, 'file.closeAll', 'ctrl+shift+e')]
    const next = assignShortcut(draft, 'file.saveAll', chords('ctrl+shift+e'), 'global', 'win32', conflicts)
    expect(next.bindings).toEqual([{ command: 'file.saveAll', key: 'mod+shift+e' }])
  })
  it('stages only files main can store: a key with both Ctrl and Win (⌃⌘) is written as pressed, for its platform', () => {
    expect(storedKey(chords('ctrl+meta+j'), 'win32')).toEqual({ key: 'ctrl+meta+j', platform: 'win32' })
    expect(storedKey(chords('ctrl+meta+f', 'darwin'), 'darwin')).toEqual({ key: 'ctrl+meta+f', platform: 'darwin' })
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      // Removing any default, macOS's ⌃⌘F full screen included, leaves a file the schema accepts.
      for (const rule of effectiveRules(platform, emptyShortcutFile).rules) {
        const removed = removeRule(emptyShortcutFile, rule, platform)
        expect(shortcutFileSchema.safeParse(removed).success, `${platform} ${rule.command} ${rule.chords.join(' ')}`).toBe(true)
      }
      const assigned = assignShortcut(emptyShortcutFile, 'file.saveAs', chords('ctrl+meta+j', platform), 'global', platform)
      expect(shortcutFileSchema.safeParse(assigned).success).toBe(true)
      expect(rowOf(assigned, 'file.saveAs', platform).bindings.filter(binding => binding.source === 'user')).toHaveLength(1)
    }
  })
  it('merges an import at the entry limit in one pass, not one effective-rules pass per entry', () => {
    const commands = ['file.saveAs', 'file.closeAll', 'file.saveAll', 'edit.nextBookmark', 'query.changeDatabase', 'view.toggleResultsPane', 'explorer.refresh', 'file.open', 'query.execute', 'file.new'] as const
    const keys = ['mod+alt', 'alt+shift', 'mod+alt+shift'].flatMap(mods => [...'abcdefghijklmnopqrstuvwxyz0123456789'].map(name => `${mods}+${name}`))
    const bindings = keys.flatMap(key => commands.map(command => ({ command, key }))).slice(0, shortcutLimits.bindings)
    const started = performance.now()
    const merged = mergeImport(file([{ command: 'file.saveAs', key: 'mod+shift+e' }]), file(bindings), 'win32')
    // It took about 100 s when each entry re-resolved the growing file; one pass takes well under a second.
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(merged.bindings.filter(binding => !binding.remove)).toHaveLength(shortcutLimits.bindings + 1)
  })
  it('keeps records this version cannot read when an import replaces the user\'s entries', () => {
    const future = { command: 'query.fromTheFuture', key: 'f9' }
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }], { unknown: [future] })
    const incoming = file([{ command: 'file.closeAll', key: 'mod+shift+q' }], { unknown: [{ gesture: 'later' }, future] })
    const replaced = replaceImport(draft, incoming)
    expect(replaced.bindings).toEqual(incoming.bindings)
    expect(replaced.unknown).toEqual([{ gesture: 'later' }, future])
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
    expect(stale).toEqual({ ok: false, stage: 'shortcuts', stale: true, message: 'Your other settings were saved, but shortcuts were not: they changed in another window. Choose OK again to replace them with yours, or Cancel to keep the other window\'s.' })
    const failed = await commitOptions(targets([], { shortcuts: { error: 'The file is read-only.' } }), {} as never, emptyShortcutFile)
    expect(failed).toEqual({ ok: false, stage: 'shortcuts', message: 'Shortcuts were not saved: The file is read-only. Your changes are still here; choose OK to try again.' })
  })
  it('never lets an edited draft overwrite another window\'s save unless the user chooses to replace it', async () => {
    const service = createFakeShortcutsService()
    let edit = startShortcutEdit(service.getSnapshot())
    edit = { ...edit, draft: file([{ command: 'file.saveAs', key: 'mod+shift+e' }]) }
    // Another window saves while the dialog is open; main pushes it and the service follows, but the edit keeps its base.
    const theirs = file([{ command: 'file.closeAll', key: 'mod+shift+q' }])
    service.changeElsewhere(theirs)
    edit = followStored(edit, service.getSnapshot())
    expect(edit.base.revision).toBe(0)
    const commit = () => commitOptions({ update: async () => {}, saveShortcuts: next => service.save(next, saveRevision(edit)) }, {} as never, shortcutsToSave(edit))
    const first = await commit()
    expect(first).toMatchObject({ ok: false, stale: true })
    expect(service.stored().file).toBe(theirs)
    // The message offers OK again to replace them: only then does the save start from the newer revision.
    edit = followStored({ ...edit, replace: service.getSnapshot().revision }, service.getSnapshot())
    expect(await commit()).toEqual({ ok: true })
    expect(service.stored().file).toEqual(edit.draft)
  })
  it('replaces only the revision the user was told about, and offers no replace to a draft begun before the file loaded', async () => {
    // #224: a third save after the warning is not overwritten without a new warning.
    const service = createFakeShortcutsService()
    service.changeElsewhere(file([{ command: 'file.closeAll', key: 'mod+shift+q' }]))
    let edit: ShortcutEdit = { ...startShortcutEdit({ file: emptyShortcutFile, revision: 0 }), draft: file([{ command: 'file.saveAs', key: 'mod+shift+e' }]), replace: service.getSnapshot().revision }
    const later = file([{ command: 'file.closeAll', key: 'mod+shift+w' }])
    service.changeElsewhere(later)
    edit = followStored(edit, service.getSnapshot())
    expect(edit.replace).toBeUndefined()
    expect(saveRevision(edit)).toBe(0)
    expect(await service.save(edit.draft, saveRevision(edit))).toMatchObject({ ok: false, code: 'STALE' })
    expect(service.stored().file).toBe(later)
    const early = startShortcutEdit({ file: emptyShortcutFile, revision: 0, loaded: false })
    expect(early.early).toBe(true)
    const result = await commitOptions({ update: async () => {}, saveShortcuts: async () => ({ ok: false, error: 'Stale.', code: 'STALE' }) as never }, {} as never, emptyShortcutFile, { early: true })
    expect(result).toEqual({ ok: false, stage: 'shortcuts', message: 'Shortcuts were not saved: your saved shortcuts finished loading after you began editing, so your changes were made to the defaults. Choose Cancel and open Options again to edit them.' })
  })
  it('finds a gesture clash OK must refuse, on the platform it is on', () => {
    // Blank-strip New Query and tab Rename share a double-click but are separate pointer targets, so Options can save.
    for (const platform of ['win32', 'linux', 'darwin'] as const) expect(gestureClash(emptyShortcutFile, platform), platform).toBeUndefined()
    // #213: no choice the Mouse view offers clashes today, so the check guards future choices; the validator stands in.
    expect(gestureClash(file([], { gestures: { 'grid.addToSelection': 'alt' } }), 'win32')).toBeUndefined()
    const clashing = (_platform: Platform, choices: ReadonlyMap<string, unknown>) => choices.size ? [{ id: 'grid.addToSelection' as const, severity: 'error' as const, code: 'clash' as const, message: 'One press would do both.' }] : []
    expect(gestureClash(file([], { gestures: { 'grid.addToSelection': 'alt' } }), 'win32', clashing)).toBe('One press would do both.')
    expect(gestureClash(emptyShortcutFile, 'win32', clashing)).toBeUndefined()
  })
  it('lets an untouched draft follow the stored file, so OK saves nothing and stages nothing', () => {
    const service = createFakeShortcutsService({ file: file([{ command: 'file.saveAs', key: 'mod+shift+e' }]), revision: 3 })
    const edit = startShortcutEdit(service.getSnapshot())
    expect(shortcutsToSave(edit)).toBeUndefined()
    service.changeElsewhere(file([{ command: 'file.closeAll', key: 'mod+shift+q' }]))
    const followed = followStored(edit, service.getSnapshot())
    expect([followed.base.revision, followed.draft]).toEqual([4, service.getSnapshot().file])
    expect(shortcutsToSave(followed)).toBeUndefined()
    expect(followStored(followed, service.getSnapshot())).toBe(followed)
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
  it('restarts the capture StrictMode stopped, keeps typed text out, and lets a Ctrl+K prompt lapse after 5 s', async () => {
    // #226, #184 and #256
    let listener: ((chord: string) => void) | undefined, prefix: ((chord: string) => void) | undefined
    const capture: CaptureSource = (onChord, options) => { listener = onChord; prefix = options.onPrefix; return () => { listener = undefined } }
    vi.useFakeTimers()
    try {
      await act(() => root.render(createElement(StrictMode, null, createElement(Harness, { initial: emptyShortcutFile, capture }))))
      await click(button('Record Keys'))
      const field = q<HTMLInputElement>('#shortcuts-record')!
      expect(document.activeElement).toBe(field)
      expect(listener).toBeDefined()
      const typed = new InputEvent('beforeinput', { data: 'é', inputType: 'insertCompositionText', bubbles: true, cancelable: true })
      field.dispatchEvent(typed)
      expect(typed.defaultPrevented).toBe(true)
      await act(() => prefix!('ctrl+k'))
      expect(field.value).toBe('Ctrl+K, …')
      await act(() => { vi.advanceTimersByTime(5000) })
      expect(field.value).toBe('')
    } finally { vi.useRealTimers() }
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
  it('keeps Enter on a sheet\'s radio from submitting Options, and gives focus back to the opener when a sheet closes', async () => {
    // #217 and #218
    await render()
    service.answerImport({ file: file([{ command: 'file.closeAll', key: 'mod+shift+q' }]) })
    const opener = button('Import…')!
    await act(async () => { opener.focus(); opener.click() })
    await act(async () => {})
    const radio = q<HTMLInputElement>('[role="dialog"] input[type="radio"]')!
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    await act(() => { radio.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    await press(radio, { key: 'Escape', code: 'Escape' })
    expect(q('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
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
  it('keeps the inspector\'s command highlighted when Show other platforms keeps one row a command', async () => {
    // #223
    // Keep both bindings free: Ctrl/⌘+Shift+R now belongs to Refresh Local Cache in the editor.
    await render(file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.saveAs', key: 'mod+shift+j' }]))
    await search('file.saveAs')
    await click(row('file.saveAs', 1))
    await click([...host.querySelectorAll('label')].find(item => item.textContent === 'Show other platforms')!.querySelector('input'))
    expect(row('file.saveAs', 0)?.getAttribute('aria-selected')).toBe('true')
    expect(q('section')?.getAttribute('aria-label')).toBe('Shortcuts for Save As…')
  })
  it('records keys without the search text it hides', async () => {
    // #228
    await render()
    await search('foo')
    await click(button('Record Keys'))
    expect([...host.querySelectorAll<HTMLButtonElement>('.chip')].every(chip => chip.disabled)).toBe(true)
    await press(q('#shortcuts-record')!, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(host.textContent).not.toContain('No shortcut uses those keys.')
    expect(row('file.save')).not.toBeNull()
  })
  it('stays on the command it just edited when the filter no longer matches it', async () => {
    // #229
    await render()
    await search('@unbound file.saveAs')
    await click(row('file.saveAs', -1))
    await press(q<HTMLInputElement>('#shortcuts-capture')!, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })
    await click(button('Assign'))
    expect(latest.bindings).toEqual([{ command: 'file.saveAs', key: 'mod+shift+e' }])
    expect(q('section')?.getAttribute('aria-label')).toBe('Shortcuts for Save As…')
    // A new filter lets it go.
    await search('@unbound')
    expect(q('section')?.getAttribute('aria-label')).not.toBe('Shortcuts for Save As…')
  })
  it('shows gesture rows without the empty message, and reaches them from the keyboard', async () => {
    // #254 and #255
    await render()
    await search('@kind:mouse')
    expect(host.textContent).not.toContain('No shortcuts match.')
    const gestures = [...host.querySelectorAll<HTMLElement>('tr.shortcuts-gesture')]
    expect(gestures.length).toBeGreaterThan(1)
    await act(() => { gestures[0].focus() })
    await press(gestures[0], { key: 'ArrowDown', code: 'ArrowDown' })
    expect(document.activeElement).toBe(gestures[1])
    // Enter opens the Mouse view, which reads the workbench's settings.
    const store = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
    const workbench = { settings: store({ values: defaultSettings }), keybindings: { ...store(0), getRevision: () => 0, lookup: () => undefined } } as unknown as Workbench
    await act(() => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(Harness, { initial: emptyShortcutFile }) })))
    await press(host.querySelectorAll<HTMLElement>('tr.shortcuts-gesture')[1], { key: 'Enter', code: 'Enter' })
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Mouse')
  })
  it('shows the Options draft\'s multi-cursor modifier in both views, not the saved one', async () => {
    // #214, page side: the saved setting is Alt+Click; the dialog's draft says Ctrl+Click.
    const store = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
    const workbench = { settings: store({ values: defaultSettings }), keybindings: { ...store(0), getRevision: () => 0, lookup: () => undefined } } as unknown as Workbench
    const page = createElement(ShortcutsPage, { draft: emptyShortcutFile, stored: emptyShortcutFile, onChange: () => {}, platform: 'win32', files: service, linked: { multiCursorModifier: 'ctrlCmd' } })
    await act(() => root.render(createElement(WorkbenchProvider, { workbench, children: page })))
    const addCursor = () => [...host.querySelectorAll('tr')].find(item => item.textContent?.includes('Add Cursor'))?.textContent
    expect(addCursor()).toContain('Ctrl+Click')
    await click([...host.querySelectorAll('[role="radio"]')].find(item => item.textContent === 'Mouse'))
    expect(addCursor()).toContain('Ctrl+Click')
  })
  it('lists entries that no longer apply, and removes them', async () => {
    await render(file([{ command: 'file.saveAs', key: 'mod+u' }]))
    expect(host.textContent).toContain('1 shortcut no longer applies.')
    await click(button('Remove'))
    expect(latest.bindings).toEqual([])
  })
})

// #250: the dialog itself, so dropping saveRevision, the followStored effect or the replace choice fails here.
describe('Options dialog over the shortcuts service', () => {
  let root: Root, host: HTMLElement
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  const mount = async (service: FakeShortcutsService) => {
    const settings = new SettingsService({
      getSettings: async () => ({ ok: true, value: { revision: 1, values: defaultSettings } }),
      updateSettings: async () => ({ ok: true, value: { revision: 1, values: defaultSettings } }),
      onSettingsChanged: () => () => {}
    } as never)
    settings.openDialog(shortcutsPageId)
    const workbench = { settings, platform: 'win32', keybindings: { capture: () => () => {} } } as unknown as Workbench
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ShortcutsProvider, { shortcuts: service, children: createElement(OptionsDialog, { page: shortcutsPageId }) }) })))
    return settings
  }
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)!
  const ok = () => act(async () => { button('OK').click() })
  const alert = () => host.querySelector('[role="alert"]')?.textContent ?? ''

  it('refuses to overwrite another window\'s save until the user chooses OK again, and then only that save', async () => {
    const service = createFakeShortcutsService()
    const settings = await mount(service)
    await act(async () => { button('Remove Ctrl+N').click() })
    const theirs = file([{ command: 'file.closeAll', key: 'mod+shift+q' }])
    await act(async () => service.changeElsewhere(theirs))
    await ok()
    expect(alert()).toContain('they changed in another window')
    expect(service.stored().file).toBe(theirs)
    // A third save after the warning is not the one the user agreed to replace: OK warns again.
    const later = file([{ command: 'file.closeAll', key: 'mod+shift+w' }])
    await act(async () => service.changeElsewhere(later))
    await ok()
    expect(service.stored().file).toBe(later)
    expect(settings.dialog.getSnapshot().open).toBe(true)
    await ok()
    expect(service.stored().file.bindings).toEqual([{ command: 'file.new', key: 'mod+n', remove: true }])
    expect(settings.dialog.getSnapshot().open).toBe(false)
  })
  it('lets an untouched draft follow another window\'s save, so OK saves nothing', async () => {
    const service = createFakeShortcutsService()
    await mount(service)
    const theirs = file([{ command: 'file.closeAll', key: 'mod+shift+q' }])
    await act(async () => service.changeElsewhere(theirs))
    const revision = service.stored().revision
    await ok()
    expect([service.stored().file, service.stored().revision]).toEqual([theirs, revision])
  })
})
