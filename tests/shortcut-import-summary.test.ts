import { describe, expect, it, vi } from 'vitest'
import { commandIds } from '../src/shared/commands/catalog'
import { emptyShortcutFile, shortcutLimits, type ShortcutBinding } from '../src/shared/commands/shortcut-schema'
import { importSummary } from '../src/renderer/src/settings/shortcuts/shortcut-draft'

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
})
