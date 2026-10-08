import { describe, expect, expectTypeOf, it } from 'vitest'
import { codicons, commandCatalog, commandDescriptor, commandIds, isCommandId, paletteLabel, type CommandId } from '../src/shared/commands/catalog'
import { findConflicts, focusSamples } from '../src/shared/commands/conflicts'
import { contextKeyNames, contextKeys, contextRecord, isContextKey, whenProblems } from '../src/shared/commands/context-keys'
import { defaultRules, platforms, resolveKeybinding, specForPlatform, type Platform, type ResolvedRule } from '../src/shared/commands/keybindings'
import { menubarIds } from '../src/shared/commands/menus'
import type { KeybindingSpec } from '../src/shared/commands/catalog'
import type { CommandId as RendererCommandId } from '../src/renderer/src/core/types'
import { workbenchFixture } from './fixtures/workbench'

const rule = (command: CommandId, spec: KeybindingSpec, platform: Platform = 'win32') => resolveKeybinding(command, spec, platform)!
const kinds = (rules: ResolvedRule[], platform: Platform = 'win32') => findConflicts(rules, platform).map(conflict => [conflict.kind, conflict.chord, ...conflict.commands])

describe('command catalogue', () => {
  it('is the renderer\'s command id type', () => {
    expectTypeOf<CommandId>().toEqualTypeOf<RendererCommandId>()
    expect(commandIds).toHaveLength(35)
  })
  it('has a handler for every command once all contributions have run', () => {
    const fixture = workbenchFixture()
    try { expect(commandIds.filter(id => !fixture.commands.has(id))).toEqual([]) }
    finally { fixture.dispose() }
  })
  it('uses dotted camelCase ids outside the theme menu namespace', () => {
    for (const id of commandIds) {
      expect(id, id).toMatch(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/)
      // PR1's theme.mode.*, theme.dark.*, theme.light.*, theme.create, theme.openFolder, and theme.reload are main-owned menu items.
      expect(id.startsWith('theme.'), id).toBe(false)
    }
  })
  it('has titles without mnemonics or stray whitespace, and distinct palette labels', () => {
    const labels = commandIds.filter(id => commandDescriptor(id).palette !== false).map(paletteLabel)
    expect(new Set(labels).size).toBe(labels.length)
    for (const id of commandIds) {
      const command = commandDescriptor(id)
      for (const title of [command.title, ...(command.menus ?? []).flatMap(placement => placement.title ?? [])]) {
        expect(title, id).toMatch(/^\S(.*\S)?$/)
        expect(title.includes('&'), id).toBe(false)
      }
      for (const keyword of command.keywords ?? []) expect(keyword, id).toMatch(/^[a-z]+$/)
    }
    expect(paletteLabel('file.new')).toBe('File: New Query')
    expect(paletteLabel('window.close')).toBe('Close Window')
  })
  it('accepts only its own ids', () => {
    expect(isCommandId('file.new')).toBe(true)
    for (const value of ['__proto__', 'toString', 'constructor', 'file.New', 'theme.mode.dark', '', 1, null, undefined, {}]) expect(isCommandId(value), String(value)).toBe(false)
  })
  it('uses codicons that exist in the bundled font', async () => {
    // Untyped Monaco internals: loading the library registers every codicon with codiconsUtil.
    const library = 'monaco-editor/base/common/codiconsLibrary.js', util = 'monaco-editor/base/common/codiconsUtil.js'
    await import(library)
    const { getCodiconFontCharacters } = await import(util) as { getCodiconFontCharacters(): Record<string, number> }
    const characters = getCodiconFontCharacters()
    for (const icon of codicons) expect(Object.hasOwn(characters, icon), icon).toBe(true)
  })
  it('lets exactly undo, redo, and window close run behind a modal', () => {
    expect(commandIds.filter(id => commandDescriptor(id).allowInModal)).toEqual(['window.close', 'edit.undo', 'edit.redo'])
  })
  it('uses only declared context keys, with state and static keys for enablement', () => {
    for (const id of commandIds) {
      const command = commandDescriptor(id)
      for (const source of [command.precondition, command.toggled]) if (source !== undefined) expect(whenProblems(source, ['static', 'state']), id).toEqual([])
      for (const spec of command.keybindings ?? []) if (spec.when !== undefined) expect(whenProblems(spec.when, ['static', 'state', 'focus']), id).toEqual([])
      for (const placement of command.menus ?? []) {
        if (menubarIds.includes(placement.menu as never) || placement.menu === 'theme') expect(placement.when, `${id} in ${placement.menu}`).toBeUndefined()
        else if (placement.when !== undefined) expect(whenProblems(placement.when, ['static', 'state', 'focus']), id).toEqual([])
      }
      if (command.unavailableHint) expect(command.precondition, `${id} has a hint but is always available`).toBeDefined()
    }
  })
  it('places commands in named groups, once per menu, in a fixed order', () => {
    for (const id of commandIds) {
      const placements = commandDescriptor(id).menus ?? []
      expect(new Set(placements.map(placement => placement.menu)).size, id).toBe(placements.length)
      for (const placement of placements) {
        expect(placement.group, id).toMatch(/^(\d|z)_[a-z]+$/)
        expect(Number.isInteger(placement.order) && placement.order > 0, id).toBe(true)
      }
    }
  })
  it('gives every keybinding a key on at least one platform, and unique keys per command', () => {
    for (const id of commandIds) for (const spec of commandDescriptor(id).keybindings ?? []) {
      expect(platforms.some(platform => specForPlatform(spec, platform) !== undefined), id).toBe(true)
    }
    for (const platform of platforms) {
      const keys = defaultRules(platform).map(resolved => `${resolved.command} ${resolved.chords.join(' ')} ${resolved.whenSource ?? ''}`)
      expect(new Set(keys).size, platform).toBe(keys.length)
    }
  })
  it.each(platforms)('has no keybinding conflicts or reserved keys on %s', platform => {
    expect(findConflicts(defaultRules(platform), platform)).toEqual([])
  })
  it('stays a plain data object', () => {
    expect(Object.getPrototypeOf(commandCatalog)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(commandCatalog))).toEqual(commandCatalog)
  })
})

describe('context keys', () => {
  it('build complete records without a prototype', () => {
    const record = contextRecord('darwin', { queryRunning: true, activePanel: 'explorer' })
    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(Object.keys(record).sort()).toEqual([...contextKeyNames].sort())
    expect(record).toMatchObject({ isMac: true, isWindows: false, isLinux: false, queryRunning: true, activePanel: 'explorer', editorFocus: false })
    expect(contextRecord('win32')).toMatchObject({ isWindows: true, activePanel: '', hasActiveDocument: false })
    expect(isContextKey('__proto__')).toBe(false)
    expect(isContextKey('constructor')).toBe(false)
  })
  it('keep focus samples consistent with the key definitions', () => {
    for (const sample of focusSamples) {
      const record = contextRecord('linux', sample.keys)
      expect(record.textInputFocus, sample.name).toBe(record.editorTextFocus || record.inputFocus)
      if (record.editorTextFocus) expect(record.editorFocus, sample.name).toBe(true)
      expect(Object.keys(sample.keys).every(key => contextKeys[key as keyof typeof contextKeys].scope === 'focus'), sample.name).toBe(true)
    }
  })
  it('report clauses that use unknown keys, the wrong scope, or impossible values', () => {
    expect(whenProblems('hasConnection && !queryRunning', ['state'])).toEqual([])
    expect(whenProblems('editorFocus', ['static', 'state'])).toEqual(['"editorFocus": focus key "editorFocus" is not allowed here'])
    expect(whenProblems('nope || isMac', ['static'])).toEqual(['"nope || isMac": unknown context key "nope"'])
    expect(whenProblems("activePanel == 'explorer'", ['focus'])).toEqual([])
    expect(whenProblems("activePanel == 'grid'", ['focus'])).toEqual([`"activePanel == 'grid'": "activePanel" is never "grid"`])
    expect(whenProblems("queryRunning == 'true'", ['state'])).toEqual([`"queryRunning == 'true'": "queryRunning" is never "true"`])
    expect(whenProblems('queryRunning != false', ['state'])).toEqual([])
    expect(whenProblems('a &&', ['state'])).toEqual(['"a &&": Expected a context key.'])
  })
})

describe('keybinding conflicts', () => {
  it('report two commands that can match the same key press', () => {
    expect(kinds([rule('file.new', { key: 'f6' }), rule('file.open', { key: 'f6' })])).toEqual([['overlap', 'f6', 'file.new', 'file.open']])
    expect(kinds([rule('file.new', { key: 'f6', when: 'queryRunning' }), rule('file.open', { key: 'f6', when: 'hasConnection' })])).toEqual([['overlap', 'f6', 'file.new', 'file.open']])
    expect(kinds([rule('file.new', { key: 'f6', when: 'editorTextFocus' }), rule('file.open', { key: 'f6', when: 'inputFocus' })])).toEqual([])
    expect(kinds([rule('file.new', { key: 'f6', when: 'queryRunning' }), rule('file.open', { key: 'f6', when: '!queryRunning' })])).toEqual([])
    expect(kinds([rule('file.new', { key: 'f6', when: 'editorFocus' }), rule('file.open', { key: 'f6', when: "activePanel == 'explorer' && !inputFocus" })])).toEqual([])
    expect(kinds([rule('file.new', { key: 'f6', when: 'editorFocus' }), rule('file.open', { key: 'f6', when: 'inputFocus' })])).toEqual([['overlap', 'f6', 'file.new', 'file.open']])
    expect(kinds([rule('file.new', { key: 'f6', when: 'isMac' }), rule('file.open', { key: 'f6' })], 'win32')).toEqual([])
    expect(kinds([rule('file.new', { key: 'f6', when: 'isMac' }), rule('file.open', { key: 'f6' })], 'darwin')).toEqual([['overlap', 'f6', 'file.new', 'file.open']])
    expect(kinds([rule('edit.undo', { key: 'f6', native: true }), rule('file.open', { key: 'f6' })])).toEqual([])
  })
  it('report reserved chords per platform', () => {
    expect(kinds([rule('file.new', { key: 'ctrl+c' })])).toEqual([['reserved', 'ctrl+c', 'file.new']])
    expect(kinds([rule('file.new', { key: 'ctrl+alt+n' }, 'linux')], 'linux')).toEqual([['reserved', 'ctrl+alt+n', 'file.new']])
    expect(kinds([rule('file.new', { key: 'ctrl+e' }, 'darwin')], 'darwin')).toEqual([['reserved', 'ctrl+e', 'file.new']])
    expect(kinds([rule('file.new', { key: 'ctrl+e' })])).toEqual([])
  })
  it('require !textInputFocus on keys that type', () => {
    for (const key of ['x', 'shift+x', '5', '/', 'space', 'enter', 'backspace', 'shift+delete', 'up']) {
      const chord = rule('file.new', { key }).chords[0]
      expect(kinds([rule('file.new', { key })]).filter(([kind]) => kind === 'typing'), key).toEqual([['typing', chord, 'file.new']])
      expect(kinds([rule('file.new', { key, when: "activePanel == 'explorer' && !textInputFocus" })]).filter(([kind]) => kind === 'typing'), key).toEqual([])
    }
    expect(kinds([rule('file.new', { key: 'x', when: "activePanel == 'explorer'" })])).toEqual([])
    expect(kinds([rule('file.new', { key: 'x', when: 'editorFocus' })])).toEqual([['typing', 'x', 'file.new']])
    for (const key of ['f6', 'ctrl+shift+x', 'alt+x', 'meta+x', 'pause']) expect(kinds([rule('file.new', { key })]), key).toEqual([])
  })
  it('keep workbench keys off commands that run behind a modal', () => {
    expect(kinds([rule('edit.undo', { key: 'f6' })])).toEqual([['modal', 'f6', 'edit.undo']])
    expect(kinds([rule('edit.undo', { key: 'f6', native: true })])).toEqual([])
  })
})
