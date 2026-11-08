import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findConflicts, isBlockingConflict, refusalReasons, validateShortcut, type RefusalReason, type ShortcutDraft } from '../src/shared/commands/conflicts'
import { effectiveRules } from '../src/shared/commands/effective'
import { intrinsicChords, intrinsicKeys } from '../src/shared/commands/intrinsic'
import { defaultRules, keyNames, parseKeySpec, platforms, resolveKeybinding, type KeyEventLike, type Platform, type ResolvedRule } from '../src/shared/commands/keybindings'
import { osKeys, osKeyVerdict } from '../src/shared/commands/os-keys'
import { scopeIds, scopeOfWhen } from '../src/shared/commands/scopes'
import { shortcutLock } from '../src/shared/commands/shortcut-rules'
import { emptyShortcutFile, type ShortcutBinding } from '../src/shared/commands/shortcut-schema'
import { gridKeyAction } from '../src/renderer/src/grid/keyboard'
import { treeKeyOf } from '../src/renderer/src/explorer/tree-model'

const defaults = (platform: Platform) => effectiveRules(platform).rules
const check = (draft: ShortcutDraft, platform: Platform = 'win32', rules: readonly ResolvedRule[] = defaults(platform)) => validateShortcut(rules, draft, platform)
const removing = (platform: Platform, ...bindings: ShortcutBinding[]) => effectiveRules(platform, { ...emptyShortcutFile, bindings }).rules
const refused = new Set<RefusalReason>()
const expectRefused = (reason: RefusalReason, draft: ShortcutDraft, platform: Platform = 'win32', rules?: readonly ResolvedRule[]) => {
  const verdict = check(draft, platform, rules)
  expect(verdict, `${platform} ${draft.command} ${draft.key} ${draft.scope ?? ''}`).toMatchObject({ verdict: 'refused', reason })
  expect(verdict.rule).toBeUndefined()
  refused.add(reason)
  return verdict
}

describe('validateShortcut', () => {
  it('says ok for a free key, and gives the rule it becomes', () => {
    expect(check({ command: 'file.new', key: 'f9' })).toMatchObject({ verdict: 'ok', message: 'F9 is not used.', conflicts: [], shadows: [], warnings: [] })
    expect(check({ command: 'file.new', key: 'f9', scope: 'resultsGrid' })).toMatchObject({ verdict: 'ok', message: 'F9 is not used in the Results Grid.', rule: { command: 'file.new', chords: ['f9'], whenSource: 'outputGridFocus', native: false } })
    expect(check({ command: 'file.new', key: 'mod+f9' }, 'darwin').rule?.chords).toEqual(['meta+f9'])
    // A command's own default key can always come back, even one the reserved list holds.
    expect(check({ command: 'query.execute', key: 'f5', scope: 'queryEditor' }, 'win32', removing('win32', { command: 'query.execute', key: 'f5', remove: true })).verdict).toBe('ok')
    expect(check({ command: 'view.zoomIn', key: 'mod+=' }, 'win32', removing('win32', { command: 'view.zoomIn', key: 'mod+=', remove: true }))).toMatchObject({ verdict: 'ok', rule: { native: true } })
    expect(check({ command: 'file.new', key: 'mod+k mod+j', scope: 'queryEditor' })).toMatchObject({ verdict: 'ok', rule: { native: true, bridge: true, chords: ['ctrl+k', 'ctrl+j'] } })
  })
  it('warns about keys the system may take, Linux Ctrl+Alt characters, and built-in widget keys', () => {
    expect(check({ command: 'file.new', key: 'ctrl+alt+t' }, 'linux')).toMatchObject({ verdict: 'warning', message: 'The system may take Ctrl+Alt+T: opens a terminal on many desktops.' })
    expect(check({ command: 'file.new', key: 'ctrl+alt+n' }, 'linux')).toMatchObject({ verdict: 'warning', warnings: ['The system may take Ctrl+Alt+N: some keyboard layouts or desktops use Ctrl+Alt with a character.'] })
    expect(check({ command: 'file.new', key: 'ctrl+alt+n' }, 'darwin').verdict).toBe('ok')
    expect(check({ command: 'file.new', key: 'meta+j' }, 'win32').verdict).toBe('warning')
    expect(check({ command: 'file.new', key: 'ctrl+space' }, 'darwin').verdict).toBe('warning')
    const rows = check({ command: 'file.new', key: 'shift+space', scope: 'resultsGrid' })
    expect(rows).toMatchObject({ verdict: 'warning', warnings: ['In the Results Grid, Shift+Space also does its own “Select whole rows”.'], rule: { whenSource: '(outputGridFocus) && !textInputFocus' } })
    expect(check({ command: 'file.new', key: 'mod+home' }).warnings).toEqual([
      'In the Results Grid, Ctrl+Home also does its own “Move to the edge of the results”.', 'In the Table Designer, Ctrl+Home also does its own “Move to the first or last row”.'
    ])
    expect(check({ command: 'file.new', key: 'mod+home', scope: 'activityMonitor' }).verdict).toBe('ok')
    // The workbench sees keys first, so a narrower shortcut may take an editor key where it applies, as Close does with Delete.
    expect(check({ command: 'file.new', key: 'delete', scope: 'objectExplorer' }, 'win32', removing('win32', { command: 'explorer.delete', key: 'delete', remove: true }))).toMatchObject({
      verdict: 'warning', warnings: ['Where this shortcut applies, it takes Delete from Delete.'], rule: { whenSource: "(activePanel == 'explorer' && !inputFocus) && !textInputFocus" }
    })
  })
  it('allows a narrower scope to shadow a Global shortcut, either way round', () => {
    const narrow = check({ command: 'file.new', key: 'ctrl+p', scope: 'resultsGrid' })
    expect(narrow).toMatchObject({ verdict: 'shadow', message: 'In the Results Grid this overrides Go to Query… (Global).', conflicts: [] })
    expect(narrow.shadows.map(shadow => [shadow.rule.command, shadow.overrides])).toEqual([['workbench.quickOpen', true]])
    const global = check({ command: 'file.new', key: 'f4' })
    expect(global).toMatchObject({ verdict: 'shadow', message: 'Properties overrides this in the Table Designer.' })
    expect(global.shadows.map(shadow => [shadow.rule.command, shadow.overrides])).toEqual([['tableDesigner.properties', false]])
  })
  it('lets a command’s key reach a wider scope, but not repeat where it already works', () => {
    expect(check({ command: 'query.execute', key: 'mod+e' })).toMatchObject({ verdict: 'ok', rule: { command: 'query.execute', chords: ['ctrl+e'] } })
    expect(check({ command: 'query.execute', key: 'mod+e' }).rule?.when).toBeUndefined()
    expectRefused('duplicate', { command: 'query.execute', key: 'mod+e', scope: 'queryEditor' })
    const widened = [check({ command: 'query.execute', key: 'mod+e' }).rule!, ...defaults('win32')]
    expectRefused('duplicate', { command: 'query.execute', key: 'mod+e', scope: 'resultsGrid' }, 'win32', widened)
  })
  it('reports conflicts with the narrower scopes that would avoid them', () => {
    const open = check({ command: 'file.new', key: 'mod+o' })
    expect(open).toMatchObject({ verdict: 'conflict', message: 'Ctrl+O is already used by Open File… (Global).' })
    expect(open.conflicts.map(rule => rule.command)).toEqual(['file.open'])
    expect(open.rule).toBeDefined()
    expect(open.narrowerScopes).toEqual(scopeIds.slice(1))
    const save = check({ command: 'file.new', key: 'mod+s', scope: 'resultsGrid' })
    expect(save.conflicts.map(rule => rule.command)).toEqual(['output.saveResultsAs'])
    expect(save.narrowerScopes).toEqual([])
    // Custom clauses are not presets, so they never shadow: a Global F5 conflicts with the SSIS documents' F5.
    expect(check({ command: 'file.new', key: 'f5' }).conflicts.map(rule => [rule.command, scopeOfWhen(rule.whenSource).id])).toEqual([['ssis.refreshOperations', 'custom'], ['ssis.refreshProperties', 'custom']])
    expect(check({ command: 'file.new', key: 'mod+k mod+k', scope: 'queryEditor' }).conflicts.map(rule => rule.command)).toEqual(['edit.toggleBookmark'])
  })
  it('refuses with a reason', () => {
    expectRefused('unknownCommand', { command: 'nope.command', key: 'f9' })
    expectRefused('scope', { command: 'file.new', key: 'f9', scope: 'custom' })
    expect(expectRefused('locked', { command: 'edit.copy', key: 'f9' }).message).toBe('The clipboard keys stay with the system.')
    expect(expectRefused('locked', { command: 'window.close', key: 'f9' }).message).toBe('Quit stays with the system.')
    expect(expectRefused('locked', { command: 'edit.find', key: 'f9' }).message).toBe('The editor or the browser handles this key, so it cannot be changed yet.')
    // A dialog's own key: a user shortcut would have no scope for it and run over every other dialog.
    expect(expectRefused('locked', { command: 'options.focusSearch', key: 'mod+shift+e' }).message).toBe('Search Options works only in the Options dialog, so its key stays with the dialog.')
    for (const key of ['', '   ', 'ctrl', 'ctrl+', 'ctrl+nope', 'a b c', 'ctrl+ctrl+a']) expectRefused('parse', { command: 'file.new', key })
    expectRefused('chord', { command: 'file.new', key: 'mod+k mod+j' })
    expectRefused('chord', { command: 'file.new', key: 'mod+j mod+k', scope: 'queryEditor' })
    expectRefused('role', { command: 'view.zoomIn', key: 'mod+f12', scope: 'queryEditor' })
    expectRefused('role', { command: 'view.zoomIn', key: 'pause' })
    expect(expectRefused('reserved', { command: 'file.new', key: 'ctrl+c' }).message).toBe('Ctrl+C is reserved: clipboard or text editing.')
    expectRefused('reserved', { command: 'file.new', key: 'ctrl+alt+n' }, 'win32')
    expectRefused('reserved', { command: 'file.new', key: 'alt+p' }, 'darwin')
    expect(expectRefused('system', { command: 'file.new', key: 'ctrl+shift+escape' }).message).toBe('The system takes Ctrl+Shift+Escape: opens Task Manager.')
    expectRefused('system', { command: 'file.new', key: 'ctrl+alt+1' }, 'win32')
    expectRefused('system', { command: 'file.new', key: 'ctrl+alt+f3' }, 'linux')
    expectRefused('system', { command: 'file.new', key: 'meta+tab' }, 'darwin')
    for (const key of ['enter', 'shift+enter', 'up', 'pagedown', 'insert', 'delete', 'contextmenu', 'pause']) expectRefused('navigation', { command: 'file.new', key })
    expect(check({ command: 'file.new', key: 'ctrl+enter', scope: 'resultsGrid' }).verdict).toBe('ok')
    expectRefused('typing', { command: 'file.new', key: 'x', scope: 'queryEditor' })
    expectRefused('typing', { command: 'file.new', key: 'shift+space', scope: 'queryEditor' })
    expect(expectRefused('taken', { command: 'file.new', key: 'mod+k mod+c', scope: 'queryEditor' }).message).toBe('Ctrl+K Ctrl+C belongs to Comment Selection, which cannot be changed.')
    expectRefused('duplicate', { command: 'query.execute', key: 'f5', scope: 'queryEditor' })
    // The default-key exemption holds only in the default's own scope: Close's Delete stays a tab key.
    const noTabDelete = removing('win32', { command: 'file.close', key: 'delete', remove: true })
    expectRefused('navigation', { command: 'file.close', key: 'delete' }, 'win32', noTabDelete)
    expect(check({ command: 'file.close', key: 'delete', scope: 'documentTabs' }, 'win32', noTabDelete).verdict).not.toBe('refused')
    const noZoom = removing('win32', { command: 'view.zoomIn', key: 'mod+=', remove: true })
    expect(check({ command: 'view.zoomIn', key: 'mod+=' }, 'win32', noZoom).verdict).toBe('ok')
    // macOS menus take only ⌘ keys from the page, and role keys work only through the menu.
    expectRefused('role', { command: 'view.zoomIn', key: 'f12' }, 'darwin')
    expect(check({ command: 'view.zoomIn', key: 'mod+f12' }, 'darwin').verdict).toBe('ok')
    expect(check({ command: 'view.zoomIn', key: 'f12' }, 'win32').verdict).toBe('ok')
    // findConflicts enumerates at most 12 state keys; a clause reading more cannot be checked.
    const busy = resolveKeybinding('file.open', { key: 'f9', when: 'queryRunning && hasConnection && hasResults && hasActiveDocument && documentBusy && multipleDocuments && editorWordWrap && editorWhitespace && editorLineNumbers && hasBookmarks && anyDocumentDirty && editorOvertype && hasRecentFiles' }, 'win32')!
    expectRefused('complex', { command: 'file.new', key: 'f9' }, 'win32', [busy])
    expect([...refused].sort()).toEqual([...refusalReasons].sort())
  })
  it('never throws, and never refuses a catalogue default against the catalogue on its own platform', () => {
    for (const draft of [{ command: '__proto__', key: 'f9' }, { command: 'file.new', key: 'x'.repeat(1000) }, { command: 'file.new', key: 'f9', scope: 'constructor' }]) expect(() => check(draft)).not.toThrow()
    for (const platform of platforms) for (const rule of defaultRules(platform)) {
      if (shortcutLock(rule.command)) continue
      // Against the catalogue without the rule itself, its own key comes back as it was: allowed, never refused.
      const others = defaultRules(platform).filter(other => other !== rule)
      const scope = rule.bridge ? 'queryEditor' : scopeOfWhen(rule.whenSource).id
      if (scope === 'custom') continue
      const key = rule.chords.join(' ')
      const verdict = check({ command: rule.command, key, scope }, platform, others)
      expect(verdict.verdict, `${platform} ${rule.command} ${key}`).not.toBe('refused')
      expect(verdict.verdict, `${platform} ${rule.command} ${key}`).not.toBe('conflict')
    }
  })
})

describe('system keys', () => {
  it('list canonical chords', () => {
    for (const platform of platforms) for (const [chord] of osKeys[platform]) expect(parseKeySpec(chord, platform), `${platform} ${chord}`).toEqual([chord])
  })
  it('do not block the rule sets validateShortcut allows', () => {
    const [shadow] = findConflicts(removing('win32', { command: 'file.new', key: 'f4' }), 'win32')
    expect(shadow.kind).toBe('shadow')
    expect(isBlockingConflict(shadow, 'win32')).toBe(false)
    const altGr = (platform: Platform) => findConflicts([resolveKeybinding('file.new', { key: 'ctrl+alt+n' }, platform)!], platform)
    expect(altGr('linux')).toMatchObject([{ kind: 'reserved', reason: 'AltGr types characters with Ctrl+Alt' }])
    expect(altGr('linux').filter(conflict => isBlockingConflict(conflict, 'linux'))).toEqual([])
    expect(altGr('win32').filter(conflict => isBlockingConflict(conflict, 'win32'))).toHaveLength(1)
    expect(findConflicts([resolveKeybinding('file.new', { key: 'ctrl+c' }, 'linux')!], 'linux').filter(conflict => isBlockingConflict(conflict, 'linux'))).toHaveLength(1)
  })
  it('refuse AltGr characters on Windows only', () => {
    for (const key of ['n', '1', '=', '[']) {
      expect(osKeyVerdict(`ctrl+alt+${key}`, 'win32')?.level, key).toBe('refused')
      expect(osKeyVerdict(`ctrl+alt+${key}`, 'linux')?.level, key).toBe('warning')
      expect(osKeyVerdict(`ctrl+alt+${key}`, 'darwin'), key).toBeUndefined()
    }
    expect(osKeyVerdict('ctrl+alt+t', 'linux')).toEqual({ level: 'warning', reason: 'opens a terminal on many desktops' })
    expect(osKeyVerdict('ctrl+alt+f5', 'win32')).toBeUndefined()
  })
})

const namedEventKeys: Record<string, string> = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp',
  pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pause: 'Pause', contextmenu: 'ContextMenu'
}
const punctuationCodes: Record<string, string> = { '/': 'Slash', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '-': 'Minus', '=': 'Equal', '`': 'Backquote' }
/** A US-layout key press for a canonical chord. */
function eventFor(chord: string): KeyEventLike {
  const parts = chord.split('+'), key = parts.pop()!
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : punctuationCodes[key] ?? (key === 'space' ? 'Space' : /^f\d+$/.test(key) ? key.toUpperCase() : namedEventKeys[key])
  const eventKey = namedEventKeys[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key)
  return { key: eventKey, code, ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt'), metaKey: parts.includes('meta') }
}
const modifierSets = Array.from({ length: 16 }, (_, bits) => ['ctrl', 'shift', 'alt', 'meta'].filter((_, index) => bits & (1 << index)))
const everyChord = [...keyNames].flatMap(key => modifierSets.map(modifiers => [...modifiers, key].join('+')))

describe('built-in widget keys', () => {
  it('hold only keys the grammar parses, in preset scopes', () => {
    for (const entry of intrinsicKeys) {
      expect(scopeIds, entry.title).toContain(entry.scope)
      if (entry.key !== undefined) for (const platform of platforms) expect(() => parseKeySpec(entry.key!, platform), entry.key).not.toThrow()
    }
  })
  it.each(['win32', 'darwin'] as const)('are the results grid’s own keys on %s (grid/keyboard.ts)', platform => {
    const intrinsic = intrinsicChords('resultsGrid', platform)
    const catalogue = new Set(defaultRules(platform).filter(rule => scopeOfWhen(rule.whenSource).id === 'resultsGrid').map(rule => rule.chords[0]))
    const handled = everyChord.filter(chord => gridKeyAction(eventFor(chord), platform) !== undefined)
    // The grid may also handle a catalogue key (Copy, Select All) until those move to the catalogue alone.
    expect(handled.filter(chord => !intrinsic.has(chord) && !catalogue.has(chord))).toEqual([])
    expect([...intrinsic.keys()].filter(chord => !handled.includes(chord))).toEqual([])
  })
  it('are Object Explorer’s tree keys (explorer/tree-model.ts)', () => {
    const intrinsic = intrinsicChords('objectExplorer', 'win32')
    const handled = everyChord.filter(chord => treeKeyOf(eventFor(chord)) !== undefined)
    expect(handled.sort()).toEqual([...intrinsic.keys()].sort())
    expect(treeKeyOf({ key: '+', code: 'NumpadAdd' })).toBe('expand')
    expect(treeKeyOf({ key: '-', code: 'NumpadSubtract' })).toBe('collapse')
    expect(treeKeyOf({ key: '*', code: 'NumpadMultiply' })).toBe('expandSiblings')
    expect(intrinsicKeys.filter(entry => entry.scope === 'objectExplorer' && entry.label).map(entry => entry.label)).toEqual(['Numpad +', 'Numpad −', '*'])
  })
  it('are the table designer’s grid keys (designer/DesignerGrid.tsx)', () => {
    const source = readFileSync(new URL('../src/renderer/src/designer/DesignerGrid.tsx', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('let handled = true'), source.indexOf('if (handled) event.preventDefault()'))
    const eventKeys = [...body.matchAll(/case '([^']+)':/g)].map(match => match[1])
    const names = new Map(Object.entries(namedEventKeys).map(([name, key]) => [key, name]))
    const handled = eventKeys.map(key => names.get(key) ?? key.toLowerCase()).sort()
    const plain = [...new Set([...intrinsicChords('tableDesigner', 'win32').keys()].filter(chord => !chord.includes('+')))].sort()
    expect(handled).toEqual(plain)
    // The combinations the switch reads from modifiers: Alt+Down on the type column, Ctrl+Home and Ctrl+End, Shift+Tab.
    expect(body).toContain("event.altKey && column === 'type'")
    expect(body).toMatch(/case 'Home': move\(mod \?/)
    expect(body).toMatch(/case 'End': move\(mod \?/)
    expect(body).toContain('event.shiftKey ? -1 : 1')
    for (const chord of ['alt+down', 'ctrl+home', 'ctrl+end', 'shift+tab']) expect(intrinsicChords('tableDesigner', 'win32').has(chord), chord).toBe(true)
  })
})
