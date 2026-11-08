import { describe, expect, it } from 'vitest'
import { parseKeySpec } from '../src/shared/commands/keybindings'
import { emptyShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { commandRows } from '../src/renderer/src/settings/shortcuts/shortcut-draft'
import { chipCounts, commandCount, filterShortcutRows, hasToken, parseShortcutQuery, shortcutSearchChars, showsKind, toggleToken } from '../src/renderer/src/settings/shortcuts/shortcuts-search'

const file = (bindings: ShortcutFile['bindings']): ShortcutFile => ({ ...emptyShortcutFile, bindings })
const rows = (draft: ShortcutFile = emptyShortcutFile) => commandRows(draft, 'win32')
/** The commands a search shows, in order. */
const found = (text: string, draft?: ShortcutFile, record?: readonly string[]) => filterShortcutRows(rows(draft), text, record).flatMap(group => group.rows.filter(row => row.first).map(row => row.row.id))

describe('Shortcuts search', () => {
  it('splits words from @ tokens, case-folded and cut at the box length', () => {
    expect(parseShortcutQuery('  Execute @Scope:Editor @modified  ')).toEqual({ words: ['execute'], tokens: [{ name: 'scope', value: 'editor' }, { name: 'modified', value: '' }] })
    expect(parseShortcutQuery('@')).toEqual({ words: ['@'], tokens: [] })
    expect(parseShortcutQuery('x'.repeat(shortcutSearchChars + 10)).words[0]).toHaveLength(shortcutSearchChars)
  })
  it('turns a chip\'s token on and off in the text, keeping the rest', () => {
    expect(toggleToken('exec', 'modified')).toBe('exec @modified ')
    expect(toggleToken('exec @modified ', 'modified')).toBe('exec')
    expect(toggleToken('@MODIFIED', 'modified')).toBe('')
    expect([hasToken('a @unbound', 'unbound'), hasToken('a @unboundx', 'unbound')]).toEqual([true, false])
  })
  it('matches every word against title, id, category and key label', () => {
    expect(found('new query file')).toEqual(['file.new'])
    expect(found('file.new')).toContain('file.new')
    // Words match labels as shown: Ctrl+N is New Query's, and Next Bookmark's Ctrl+K Ctrl+N has it too.
    expect(found('ctrl+n')).toEqual(['file.new', 'edit.nextBookmark'])
    expect(found('zzz-nothing')).toEqual([])
  })
  it('filters by source, scope, command, kind and the chips\' tokens', () => {
    expect(found('@source:system')).toContain('edit.copy')
    expect(found('@source:system')).not.toContain('file.new')
    expect(found('@scope:explorer')).toContain('explorer.refresh')
    expect(found('@scope:explorer')).not.toContain('file.new')
    expect(found('@command:file.save')).toEqual(expect.arrayContaining(['file.save', 'file.saveAs', 'file.saveAll']))
    expect(found('@unbound')).toContain('file.saveAs')
    expect(found('@unbound')).not.toContain('file.new')
    expect(found('@kind:mouse')).toEqual([])
    expect(showsKind(parseShortcutQuery('@kind:mouse'), 'mouse')).toBe(true)
    expect(showsKind(parseShortcutQuery('@kind:key'), 'mouse')).toBe(false)
    // A token the box does not know (or is still being typed) filters nothing.
    expect(found('@sco new query file')).toEqual(['file.new'])
  })
  it('lists a modified command\'s changed shortcut under @modified, and counts the chips', () => {
    const draft = file([{ command: 'file.saveAs', key: 'mod+shift+e' }, { command: 'file.new', key: 'mod+n', remove: true }])
    expect(found('@modified', draft)).toEqual(['file.new', 'file.saveAs'])
    const counts = chipCounts(rows(draft))
    expect(counts.modified).toBe(2)
    expect(counts.conflicts).toBe(0)
    // A removed default leaves its command unbound.
    expect(found('@unbound', draft)).toContain('file.new')
    expect(counts.unbound).toBe(chipCounts(rows()).unbound)
  })
  it('counts commands with an entry that does not apply as Conflicts', () => {
    // Ctrl+U is Change Database's in Global, so a second Global Ctrl+U is not applied.
    const draft = file([{ command: 'file.saveAs', key: 'mod+u' }])
    expect(chipCounts(rows(draft)).conflicts).toBe(1)
    expect(found('@conflicts', draft)).toEqual(['file.saveAs'])
  })
  it('Record Keys keeps only shortcuts with exactly the chords pressed', () => {
    const groups = filterShortcutRows(rows(), '', parseKeySpec('f5', 'win32'))
    const ids = groups.flatMap(group => group.rows.map(row => row.row.id))
    expect(ids).toEqual(expect.arrayContaining(['query.execute', 'explorer.refresh', 'activity.refresh']))
    expect(ids).not.toContain('file.new')
    expect(groups.flatMap(group => group.rows).every(row => row.binding?.label.text === 'F5')).toBe(true)
    // A command with two shortcuts counts once.
    expect(commandCount(filterShortcutRows(rows(), 'query.execute'))).toBe(1)
    expect(filterShortcutRows(rows(), '', parseKeySpec('ctrl+alt+shift+f12', 'win32'))).toEqual([])
  })
})
