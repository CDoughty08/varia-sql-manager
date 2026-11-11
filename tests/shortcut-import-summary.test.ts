import { describe, expect, it, vi } from 'vitest'
import { commandIds } from '../src/shared/commands/catalog'
import { emptyShortcutFile, shortcutLimits, type ShortcutBinding, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { importRefusal, importSummary, replaceImport, storable } from '../src/renderer/src/settings/shortcuts/shortcut-draft'

// Counts every parse the summary makes (through any module), so the check bounds work rather than a machine's speed.
const parsed = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/shared/commands/keybindings', async original => {
  const actual = await original<typeof import('../src/shared/commands/keybindings')>()
  return { ...actual, parseKeySpec: (...args: Parameters<typeof actual.parseKeySpec>) => { parsed.count++; return actual.parseKeySpec(...args) } }
})

describe('Import preview', () => {
  it('counts a full file\'s same-keys clashes in one pass', () => {
    // #291: comparing each entry with every earlier one parsed about a million keys for a 1,024-entry file.
    const modifiers = ['mod+shift+alt', 'mod+alt', 'alt+shift', 'mod+shift', 'mod', 'alt', 'shift', 'meta+alt', 'meta+shift', 'meta+mod']
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789'].concat(Array.from({ length: 12 }, (_, index) => `f${index + 1}`))
    const single = modifiers.flatMap(modifier => keys.map(key => `${modifier}+${key}`))
    const distinct = [...single, ...single.map(key => `mod+shift+j ${key}`), ...single.map(key => `mod+shift+l ${key}`)]
    const bindings: ShortcutBinding[] = distinct.slice(0, shortcutLimits.bindings - 2).map((key, index) => ({ command: commandIds[index % commandIds.length], key, platform: 'win32' }))
    // One clash: the first key again in Global (written this time) for another command; the same key in a narrower scope is not one.
    bindings.push({ command: commandIds[1], key: bindings[0].key, scope: 'global', platform: 'win32' }, { command: commandIds[2], key: bindings[0].key, scope: 'queryEditor', platform: 'win32' })
    expect(bindings).toHaveLength(shortcutLimits.bindings)
    parsed.count = 0
    const summary = importSummary(emptyShortcutFile, { ...emptyShortcutFile, bindings }, 'win32')
    expect(summary.added).toBe(shortcutLimits.bindings)
    expect(summary.clashes).toBe(1)
    // Linear: a handful of parses an entry (the preview, its validation and Merge's dry run), never one per pair.
    expect(parsed.count).toBeLessThan(shortcutLimits.bindings * 20)
  })
  it('counts an entry the file lists twice as repeated, not as the same as yours', () => {
    // #292: the draft has neither copy, so "Same as yours" must stay 0.
    const entry: ShortcutBinding = { command: 'file.saveAs', key: 'mod+shift+e' }
    const twice = { ...emptyShortcutFile, bindings: [entry, { ...entry, scope: 'global' as const }] }
    const fresh = importSummary(emptyShortcutFile, twice, 'win32')
    expect([fresh.shortcuts, fresh.added, fresh.same, fresh.repeated]).toEqual([2, 1, 0, 1])
    // Both copies of an entry the draft has are the same as the user's.
    const mine = importSummary({ ...emptyShortcutFile, bindings: [entry] }, twice, 'win32')
    expect([mine.added, mine.same, mine.repeated]).toEqual([0, 2, 0])
  })
  it('words a refusal by its cause, and never asks the user to remove records the page cannot remove', () => {
    // #292: Replace is over the limit only through unreadable records, the draft's beside the file's.
    const records = (from: number) => Array.from({ length: 200 }, (_, index) => ({ record: from + index }))
    const draft: ShortcutFile = { ...emptyShortcutFile, unknown: records(0) }, incoming: ShortcutFile = { ...emptyShortcutFile, unknown: records(1000) }
    const unreadable = importSummary(draft, incoming, 'win32')
    expect(unreadable.over).toEqual({ merge: 'unknown', replace: 'unknown' })
    expect(unreadable.fits).toEqual({ merge: false, replace: false })
    for (const mode of ['merge', 'replace'] as const) {
      expect(importRefusal(unreadable, mode)).toMatch(/records this version cannot read.*cannot be removed here, so this file cannot be imported\.$/)
      expect(importRefusal(unreadable, mode)).not.toMatch(/remove some/i)
    }
    // Unreadable records can also make Replace too large without being too many.
    const large = (name: string) => Array.from({ length: 100 }, (_, index) => ({ [name]: index, text: 'x'.repeat(900) }))
    const bulky = importSummary({ ...emptyShortcutFile, unknown: large('mine') }, { ...emptyShortcutFile, unknown: large('theirs') }, 'win32')
    expect(bulky.over.replace).toBe('size')
    expect(importRefusal(bulky, 'replace')).toMatch(/larger than the 128 KiB.*cannot be imported\.$/)
    // Too many shortcuts together is the user's to fix: Replace fits, and so would Merge with fewer of theirs.
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    const some = (command: ShortcutBinding['command']): ShortcutBinding[] => Array.from({ length: 600 }, (_, index) => ({ command, key: `mod+alt+${letters[index % 26]} mod+${letters[Math.floor(index / 26)]}`, platform: 'win32' }))
    const yours = { ...emptyShortcutFile, bindings: some(commandIds[0]) }, theirs = { ...emptyShortcutFile, bindings: some(commandIds[1]) }
    expect(storable(replaceImport(yours, theirs))).toBe(true)
    const many = importSummary(yours, theirs, 'win32')
    expect(many.over).toEqual({ merge: 'shortcuts', replace: undefined })
    expect(importRefusal(many, 'merge')).toBe('Together they would be more than the 1,024 shortcuts a file may hold. Choose Replace, or remove some of yours first.')
    expect(importRefusal(many, 'replace')).toBeUndefined()
    expect(importRefusal(importSummary(emptyShortcutFile, theirs, 'win32'), 'merge')).toBeUndefined()
  })
})
