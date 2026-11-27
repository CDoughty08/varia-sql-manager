import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { savedIndexesCleared, searchContribution } from '../src/renderer/src/contributions/search'
import { CommandService } from '../src/renderer/src/core/commands'
import { NotificationService } from '../src/renderer/src/core/notifications'
import { indexStorageNote } from '../src/renderer/src/settings/index-storage-note'
import { commandCatalog } from '../src/shared/commands/catalog'
import type { IndexStoreCleared, VariaApi } from '../src/shared/contracts'
import { stylesheetRules } from './fixtures/css-rules'

describe('Clear Saved Search Indexes', () => {
  it('is a palette command of its own, for both engines, with no key and no menu', () => {
    expect(commandCatalog['explorer.clearSavedIndexes']).toEqual({
      providers: ['sqlserver', 'bigquery'], title: 'Clear Saved Search Indexes', category: 'Object Explorer', icon: 'trash',
      keywords: ['search', 'index', 'saved', 'disk', 'cache', 'delete', 'remove'], methods: ['explorer.indexStore.clear']
    })
  })
  it('says how much went, that there was nothing, and what could not be deleted', () => {
    const MB = 1048576
    expect(savedIndexesCleared({ files: 1204, bytes: 312 * MB, kept: 0 })).toBe('Saved search indexes cleared: 1,204 files, 312 MB.')
    expect(savedIndexesCleared({ files: 1, bytes: 10, kept: 0 })).toBe('Saved search indexes cleared: 1 file, <1 MB.')
    expect(savedIndexesCleared({ files: 0, bytes: 0, kept: 0 })).toBe('There were no saved search indexes to clear.')
    expect(savedIndexesCleared({ files: 3, bytes: 4 * MB, kept: 1 })).toBe('Saved search indexes cleared: 3 files, 4 MB. 1 file could not be deleted.')
    expect(savedIndexesCleared({ files: 0, bytes: 0, kept: 2 })).toBe('There were no saved search indexes to clear. 2 files could not be deleted.')
  })
  it('asks main to clear, says it is done in an info notification, a file left behind as a warning, and a failure as an error', async () => {
    const run = async (answer: Awaited<ReturnType<VariaApi['clearSavedSearchIndexes']>>) => {
      const commands = new CommandService(), notifications = new NotificationService()
      const api = { writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(), clearSavedSearchIndexes: vi.fn(async () => answer) }
      // The command needs no other service: the rest of the workbench is never touched.
      const contribution = searchContribution({ commands, notifications } as never, api)
      const ran = await commands.execute('explorer.clearSavedIndexes', undefined, 'palette')
      const shown = commands.getSnapshot(), toasts = notifications.getSnapshot().visible
      contribution.dispose()
      notifications.dispose()
      return { ran, shown, toasts, api }
    }
    const cleared = await run({ ok: true, value: { files: 2, bytes: 3 * 1048576, kept: 0 } satisfies IndexStoreCleared })
    expect(cleared.ran).toBe(true)
    expect(cleared.api.clearSavedSearchIndexes).toHaveBeenCalledWith()
    expect(cleared.toasts).toMatchObject([{ severity: 'info', message: 'Saved search indexes cleared: 2 files, 3 MB.' }])
    expect(cleared.shown.error).toBeFalsy()
    const partly = await run({ ok: true, value: { files: 2, bytes: 3 * 1048576, kept: 1 } })
    expect(partly.shown).toMatchObject({ error: 'Saved search indexes cleared: 2 files, 3 MB. 1 file could not be deleted.', kind: 'warning' })
    expect(partly.toasts).toEqual([])
    const failed = await run({ ok: false, error: 'The SQL backend is restarting.' })
    expect(failed.ran).toBe(false)
    expect(failed.shown.error).toContain('The SQL backend is restarting.')
    expect(failed.shown.kind).toBeUndefined()
  })
})

describe('Options › Object Explorer › Commands where the system has no key store', () => {
  it('says nothing while a key store is available, while it is not known, or while saving is off', () => {
    expect(indexStorageNote(undefined, true, false)).toBe('')
    expect(indexStorageNote({ available: true }, true, false)).toBe('')
    expect(indexStorageNote({ available: true }, true, true)).toBe('')
    expect(indexStorageNote({ available: false, reason: 'no-keyring' }, false, false)).toBe('')
    expect(indexStorageNote({ available: false, reason: 'no-keyring' }, false, true)).toBe('')
  })
  it('says that nothing is being saved and how to opt in, by the reason', () => {
    expect(indexStorageNote({ available: false, reason: 'no-keyring' }, true, false))
      .toBe('Search Objects indexes are not being saved on this system: it needs a system keyring (GNOME Keyring or KWallet) to hold the index’s key, and none was found. To save them without encryption, turn on “Save index unencrypted when there is no key store” below.')
    expect(indexStorageNote({ available: false, reason: 'unknown-backend' }, true, false)).toContain('the operating system has no key store to hold the index’s key')
  })
  it('says a key store that is not reachable yet holds saving back, with no opt-in advice and no claim of clear text', () => {
    // Main sends nothing then (IndexStoreConfig), whatever the opt-in says, so neither note may suggest otherwise.
    const waiting = 'Search Objects indexes are not being saved yet: the operating system’s key store, which holds the index’s key, is not reachable (it may be locked). They are saved, encrypted, once it answers.'
    for (const unencrypted of [false, true]) {
      expect(indexStorageNote({ available: false, reason: 'unavailable' }, true, unencrypted)).toBe(waiting)
      expect(indexStorageNote({ available: false }, true, unencrypted)).toBe(waiting)
    }
  })
  it('says the index is saved unencrypted, and what that exposes, once the user opted in', () => {
    expect(indexStorageNote({ available: false, reason: 'no-keyring' }, true, true))
      .toBe('Search Objects indexes are saved unencrypted on this system, as chosen below: it needs a system keyring (GNOME Keyring or KWallet) to hold the index’s key, and none was found. Any program or person that can read your files can read the saved object names and definitions.')
  })
  it('names the setting by its catalogue label, and shows on its page only, as a note with a warning icon', () => {
    const label = 'Save index unencrypted when there is no key store'
    expect(readFileSync(join('src', 'shared', 'settings', 'object-explorer.ts'), 'utf8')).toContain(`label: '${label}'`)
    expect(indexStorageNote({ available: false, reason: 'no-keyring' }, true, false)).toContain(`“${label}”`)
    const dialog = readFileSync(join('src', 'renderer', 'src', 'settings', 'OptionsDialog.tsx'), 'utf8')
    expect(dialog).toContain(`{form.page.id === 'objectExplorer.commands' && indexStorageText && <p className="options-note" data-tone="warning" role="note"><Icon name="warning" /><span>{indexStorageText}</span></p>}`)
    expect(dialog).toContain("const indexStorageText = indexStorageNote(indexStorage, draft['objectExplorer.search.saveIndex'] === true, draft['objectExplorer.search.saveUnencrypted'] === true)")
    const rules = stylesheetRules().filter(rule => rule.selector.includes('.options-note[data-tone="warning"]'))
    expect(rules).toHaveLength(2)
    for (const rule of rules) for (const { property, value } of rule.declarations) if (property.includes('color')) expect(value).toMatch(/^var\(--varia-/)
  })
})
