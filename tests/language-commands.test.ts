import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchFixture, connectionInfo, readyBackend } from './fixtures/workbench'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { defaultRules } from '../src/shared/commands/keybindings'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })
function fixture() {
  const value = workbenchFixture()
  cleanups.push(value.dispose)
  value.api.push(readyBackend())
  value.connect(connectionInfo('server-a'))
  return value
}

describe('IntelliSense refresh command', () => {
  it('refreshes the chosen query without changing its text, connection, or execution session', async () => {
    const f = fixture(), first = f.documents.create('a.sql', 'SELECT 1', 'AppData', 'server-a')
    const second = f.documents.create('b.sql', 'SELECT 2', 'master', 'server-a')
    expect(await f.commands.execute('edit.refreshIntelliSense', { tabId: first.id }, 'api')).toBe(true)
    expect(f.sqlLanguage.refreshCache).toHaveBeenCalledExactlyOnceWith(first.id)
    expect(f.documents.getModel(first.id)?.getValue()).toBe('SELECT 1')
    expect(f.documents.get(first.id)).toMatchObject({ connectionId: 'server-a', database: 'AppData' })
    expect(f.documents.active?.id).toBe(second.id)
    expect(f.api.execute).not.toHaveBeenCalled()
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
  })
  it('uses the active query for keyboard/menu/palette requests and reports refresh errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fixture(), tab = f.documents.create('a.sql', 'SELECT 1', 'master', 'server-a')
    f.sqlLanguage.refreshCache.mockRejectedValueOnce(new Error('The metadata refresh timed out.'))
    expect(await f.commands.execute('edit.refreshIntelliSense', undefined, 'palette')).toBe(false)
    expect(f.sqlLanguage.refreshCache).toHaveBeenCalledWith(tab.id)
    expect(f.commands.getSnapshot().error).toContain('The metadata refresh timed out.')
  })
  it('uses an explicit query target even when the active document is disconnected or XML', async () => {
    const f = fixture(), target = f.documents.create('connected.sql', 'SELECT 1', 'master', 'server-a')
    f.documents.create('disconnected.sql', '', 'master')
    expect(f.commands.isEnabled('edit.refreshIntelliSense')).toBe(false)
    expect(await f.commands.execute('edit.refreshIntelliSense', { tabId: target.id }, 'api')).toBe(true)
    f.documents.openText({ name: 'value.xml', text: '<value/>', kind: 'xml' })
    expect(f.commands.isEnabled('edit.refreshIntelliSense')).toBe(false)
    expect(await f.commands.execute('edit.refreshIntelliSense', { tabId: target.id }, 'api')).toBe(true)
    expect(f.sqlLanguage.refreshCache.mock.calls).toEqual([[target.id], [target.id]])
  })
  it('refuses disconnected, lost, and non-SQL documents', async () => {
    const f = fixture(), disconnected = f.documents.create('a.sql', '', 'master')
    expect(f.commands.isEnabled('edit.refreshIntelliSense')).toBe(false)
    expect(await f.commands.execute('edit.refreshIntelliSense', { tabId: disconnected.id }, 'api')).toBe(false)
    f.documents.create('b.sql', '', 'master', 'server-a')
    f.connections.markLostBefore(2)
    expect(f.commands.isEnabled('edit.refreshIntelliSense')).toBe(false)
    f.documents.openText({ name: 'value.xml', text: '<value/>', kind: 'xml' })
    expect(f.commands.isEnabled('edit.refreshIntelliSense')).toBe(false)
    expect(f.sqlLanguage.refreshCache).not.toHaveBeenCalled()
  })
  it.each([['win32', 'ctrl+shift+r'], ['linux', 'ctrl+shift+r'], ['darwin', 'shift+meta+r']] as const)('exposes the refresh key on %s and the IntelliSense menu', (platform, chord) => {
    const rules = defaultRules(platform).filter(rule => rule.command === 'edit.refreshIntelliSense')
    expect(rules.map(rule => rule.chords)).toEqual([[chord]])
    expect(commandDescriptor('edit.refreshIntelliSense').menus).toContainEqual({ menu: 'edit.intellisense', group: '2_cache', order: 1, mnemonic: 'r' })
  })
})
