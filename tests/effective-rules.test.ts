import { describe, expect, it } from 'vitest'
import { findConflicts } from '../src/shared/commands/conflicts'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import { effectiveRules } from '../src/shared/commands/effective'
import { bridgeRules, defaultRules, nativeChordPrefixes, platforms, primaryRule, workbenchRules, type Platform, type ResolvedRule } from '../src/shared/commands/keybindings'
import { buildMenuModel, menuAccelerator, type MenuEntry } from '../src/shared/commands/menus'
import { shortcutSchemes } from '../src/shared/commands/schemes'
import { customScope, scopeOfWhen, scopeWhen, shortcutScope, shortcutScopes } from '../src/shared/commands/scopes'
import { emptyShortcutFile, shortcutFileSchema, type ShortcutBinding, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { evaluateWhen } from '../src/shared/commands/when'
import { whenProblems } from '../src/shared/commands/context-keys'

const file = (bindings: ShortcutBinding[], rest: Partial<ShortcutFile> = {}): ShortcutFile => ({ ...emptyShortcutFile, bindings, ...rest })
/** The command a key press runs in `context`, as `KeybindingService` dispatches it. */
const dispatch = (rules: readonly ResolvedRule[], chord: string, context: Partial<ContextKeys>, platform: Platform = 'win32') =>
  workbenchRules(rules).get(chord)?.find(rule => !rule.when || evaluateWhen(rule.when, contextRecord(platform, context)))?.command
const editor: Partial<ContextKeys> = { editorFocus: true, editorTextFocus: true, textInputFocus: true, activePanel: 'editor' }
const grid: Partial<ContextKeys> = { activePanel: 'output', outputGridFocus: true }

describe('scope presets', () => {
  it('are ordered, Global first and broadest, with clauses that use only declared focus keys', () => {
    expect(shortcutScopes.map(scope => scope.id)).toEqual(['global', 'queryEditor', 'resultsGrid', 'messages', 'objectExplorer', 'tableDesigner', 'activityMonitor', 'documentTabs'])
    expect(shortcutScopes.map(scope => scope.title)).toEqual(['Global', 'SQL Query Editor', 'Results Grid', 'Messages', 'Object Explorer', 'Table Designer', 'Activity Monitor', 'Document Tabs'])
    expect(shortcutScope('global').rank).toBe(0)
    expect(shortcutScope('global').when).toBeUndefined()
    for (const scope of shortcutScopes.slice(1)) {
      expect(scope.rank, scope.id).toBeGreaterThan(0)
      expect(whenProblems(scope.when!, ['static', 'state', 'focus']), scope.id).toEqual([])
      expect(whenProblems(scopeWhen(scope.id, true)!, ['static', 'state', 'focus']), scope.id).toEqual([])
    }
  })
  it('name the scope of a catalogue rule, or Custom when its clause is no preset', () => {
    const scopes = new Map(defaultRules('win32').map(rule => [`${rule.command} ${rule.chords.join(' ')}`, scopeOfWhen(rule.whenSource).id]))
    expect(scopes.get('query.execute f5')).toBe('queryEditor')
    expect(scopes.get('output.saveResultsAs ctrl+s')).toBe('resultsGrid')
    expect(scopes.get('explorer.refresh f5')).toBe('objectExplorer')
    expect(scopes.get('file.close delete')).toBe('documentTabs')
    expect(scopes.get('file.new ctrl+n')).toBe('global')
    expect(scopes.get('file.save ctrl+s')).toBe('custom')
    expect(scopeOfWhen(scopeWhen('resultsGrid', true))).toBe(shortcutScope('resultsGrid'))
    expect(scopeOfWhen('isMac')).toBe(customScope)
  })
})

describe('effective rules', () => {
  it.each(platforms)('are the catalogue defaults with no user file on %s', platform => {
    const effective = effectiveRules(platform)
    expect(effective.rules).toEqual(defaultRules(platform))
    expect(effective).toMatchObject({ userRules: [], removed: [], problems: [], gestures: {} })
    expect(effective.scheme.title).toBe('SQL Server (default)')
    expect(shortcutSchemes.map(scheme => scheme.id)).toEqual(['default'])
    expect(findConflicts(effective.rules, platform)).toEqual([])
  })
  it('remove a default by command and key, and add user shortcuts that labels and menus show first', () => {
    const user = file([{ command: 'query.execute', key: 'f5', remove: true }, { command: 'query.execute', key: 'mod+shift+e', scope: 'queryEditor' }])
    for (const platform of platforms) {
      const { rules, userRules, removed, problems } = effectiveRules(platform, user)
      expect(problems, platform).toEqual([])
      expect(removed.map(rule => rule.chords.join(' ')), platform).toEqual(['f5'])
      expect(userRules.map(rule => [rule.chords[0], rule.whenSource]), platform).toEqual([[platform === 'darwin' ? 'shift+meta+e' : 'ctrl+shift+e', 'editorFocus || queryBarFocus']])
      expect(rules.some(rule => rule.command === 'query.execute' && rule.chords[0] === 'f5'), platform).toBe(false)
      expect(primaryRule('query.execute', platform, rules)).toBe(userRules[0])
      expect(dispatch(rules, userRules[0].chords[0], editor, platform), platform).toBe('query.execute')
    }
    const { rules } = effectiveRules('win32', user)
    expect(menuAccelerator('query.execute', 'win32')).toBe('F5')
    expect(menuAccelerator('query.execute', 'win32', rules)).toBe('Ctrl+Shift+E')
    const execute = (entries: MenuEntry[]) => entries.find((entry): entry is Extract<MenuEntry, { kind: 'command' }> => entry.kind === 'command' && entry.id === 'query.execute')
    expect(execute(buildMenuModel('query', 'win32'))?.accelerator).toBe('F5')
    expect(execute(buildMenuModel('query', 'win32', rules))?.accelerator).toBe('Ctrl+Shift+E')
    expect(dispatch(rules, 'f5', editor)).toBeUndefined()
  })
  it('apply a removal without a platform where its default exists, and stay quiet where it does not', () => {
    const user = file([{ command: 'file.close', key: 'ctrl+f4', remove: true }])
    expect(effectiveRules('win32', user).removed.map(rule => rule.chords[0])).toEqual(['ctrl+f4'])
    expect(effectiveRules('darwin', user)).toMatchObject({ removed: [], problems: [] })
  })
  it('apply platform entries only on their platform, and keep them for the others', () => {
    const user = file([{ command: 'file.new', key: 'shift+alt+f9', platform: 'linux' }])
    expect(effectiveRules('linux', user).userRules.map(rule => rule.chords[0])).toEqual(['shift+alt+f9'])
    for (const platform of ['win32', 'darwin'] as const) expect(effectiveRules(platform, user)).toMatchObject({ userRules: [], problems: [] })
    expect(shortcutFileSchema.safeParse(user).success).toBe(true)
  })
  it('let a narrower scope shadow a Global shortcut in either order, and dispatch the narrower one there', () => {
    // A Global F4 runs everywhere but the table designer, whose Properties key is narrower.
    const global = effectiveRules('win32', file([{ command: 'file.new', key: 'f4' }]))
    expect(global.problems).toEqual([])
    expect(dispatch(global.rules, 'f4', { activePanel: 'editor', designerFocus: true })).toBe('tableDesigner.properties')
    expect(dispatch(global.rules, 'f4', grid)).toBe('file.new')
    expect(dispatch(global.rules, 'f4', editor)).toBe('file.new')
    expect(findConflicts(global.rules, 'win32')).toMatchObject([{ kind: 'shadow', chord: 'f4', commands: ['tableDesigner.properties', 'file.new'] }])
    // Only preset scopes shadow: the SSIS documents' F5 has a clause of its own (Custom), so a Global F5 conflicts.
    expect(effectiveRules('win32', file([{ command: 'file.new', key: 'f5' }])).problems).toMatchObject([{ code: 'conflict' }])
    // A narrower Ctrl+P beats Quick Open's Global one in the grid only.
    const narrow = effectiveRules('win32', file([{ command: 'file.new', key: 'ctrl+p', scope: 'resultsGrid' }]))
    expect(narrow.problems).toEqual([])
    expect(dispatch(narrow.rules, 'ctrl+p', grid)).toBe('file.new')
    expect(dispatch(narrow.rules, 'ctrl+p', editor)).toBe('workbench.quickOpen')
    expect(findConflicts(narrow.rules, 'win32')).toMatchObject([{ kind: 'shadow', chord: 'ctrl+p' }])
    // A Global typing key carries the typing guard and is still Global: Object Explorer's own X wins there, in either order.
    for (const bindings of [[{ command: 'file.new', key: 'x' }, { command: 'file.open', key: 'x', scope: 'objectExplorer' }], [{ command: 'file.open', key: 'x', scope: 'objectExplorer' }, { command: 'file.new', key: 'x' }]] as ShortcutBinding[][]) {
      const typed = effectiveRules('win32', file(bindings))
      expect(typed.problems).toEqual([])
      expect(dispatch(typed.rules, 'x', { activePanel: 'explorer' })).toBe('file.open')
      expect(dispatch(typed.rules, 'x', grid)).toBe('file.new')
      expect(dispatch(typed.rules, 'x', editor)).toBeUndefined()
      expect(findConflicts(typed.rules, 'win32').map(conflict => conflict.kind)).toEqual(['shadow'])
    }
  })
  it('report additions that conflict or are refused, and removals that match nothing or a locked key, without applying them', () => {
    const user = file([
      { command: 'file.new', key: 'mod+o' },
      { command: 'file.new', key: 'mod+c' },
      { command: 'edit.copy', key: 'mod+c', remove: true },
      { command: 'file.new', key: 'f7', remove: true },
      { command: 'file.open', key: 'f9' },
      { command: 'file.new', key: 'f9' }
    ])
    const { rules, userRules, removed, problems } = effectiveRules('win32', user)
    expect(problems.map(problem => [problem.index, problem.code])).toEqual([[2, 'locked'], [3, 'unmatched'], [0, 'conflict'], [1, 'reserved'], [5, 'conflict']])
    expect(problems.every(problem => problem.source === 'user' && problem.message.length > 0)).toBe(true)
    expect(userRules.map(rule => `${rule.command} ${rule.chords[0]}`)).toEqual(['file.open f9'])
    expect(removed).toEqual([])
    expect(rules.length).toBe(defaultRules('win32').length + 1)
    expect(findConflicts(rules, 'win32')).toEqual([])
  })
  it('guard typing keys, make two-part editor keys bridge rules and role keys native', () => {
    const user = file([
      { command: 'file.new', key: 'x', scope: 'objectExplorer' },
      { command: 'edit.toggleBookmark', key: 'mod+k mod+k', remove: true },
      { command: 'edit.toggleBookmark', key: 'mod+k mod+b', scope: 'queryEditor' },
      { command: 'view.zoomIn', key: 'mod+f12' }
    ])
    const { rules, userRules, problems } = effectiveRules('win32', user)
    expect(problems).toEqual([])
    expect(userRules.find(rule => rule.command === 'file.new')?.whenSource).toBe("(activePanel == 'explorer' && !inputFocus) && !textInputFocus")
    expect(dispatch(rules, 'x', { activePanel: 'explorer' })).toBe('file.new')
    expect(dispatch(rules, 'x', { activePanel: 'explorer', inputFocus: true, textInputFocus: true })).toBeUndefined()
    expect(bridgeRules('win32', rules).find(rule => rule.command === 'edit.toggleBookmark')?.chords).toEqual(['ctrl+k', 'ctrl+b'])
    expect(bridgeRules('win32', rules).filter(rule => rule.chords[1] === 'ctrl+k')).toEqual([])
    expect(nativeChordPrefixes('win32', rules)).toEqual(new Set(['ctrl+k']))
    expect(userRules.find(rule => rule.command === 'view.zoomIn')).toMatchObject({ native: true, bridge: false, chords: ['ctrl+f12'] })
    expect(menuAccelerator('view.zoomIn', 'win32', rules)).toBe('Ctrl+F12')
  })
  it('list narrower user shortcuts first, fall back to the default scheme, keep gestures, and memoise per file', () => {
    const user = file([{ command: 'file.new', key: 'f9' }, { command: 'file.open', key: 'f9', scope: 'resultsGrid' }], { scheme: 'vsCode', gestures: { 'grid.addToSelection': 'ctrl' } })
    const effective = effectiveRules('linux', user)
    expect(effective.userRules.map(rule => rule.command)).toEqual(['file.open', 'file.new'])
    expect(effective.problems).toMatchObject([{ index: -1, code: 'scheme' }])
    expect(effective.scheme.id).toBe('default')
    expect(effective.gestures).toEqual({ 'grid.addToSelection': 'ctrl' })
    expect(effectiveRules('linux', user)).toBe(effective)
    expect(effectiveRules('win32', user)).not.toBe(effective)
    expect(Object.isFrozen(effective.rules)).toBe(true)
  })
  it('never throw, whatever the bindings hold', () => {
    const odd = file([{ command: 'file.new', key: 'ctrl+nope' } as ShortcutBinding, { command: 'nope' as never, key: 'f9' }, { command: 'file.new', key: 'f9', scope: 'nowhere' as never }, { command: 'file.new', key: 'bad key spec', remove: true }])
    expect(effectiveRules('win32', odd).problems.map(problem => problem.code)).toEqual(['parse', 'parse', 'unknownCommand', 'scope'])
  })
})
