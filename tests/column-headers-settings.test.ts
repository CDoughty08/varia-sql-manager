import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { saveHeaders } from '../src/main/results-jobs'
import { SettingsStore } from '../src/main/settings-store'
import { defaultSettings, settingDefs } from '../src/shared/settings/catalog'
import { parseStoredSettings, renamedSettings } from '../src/shared/settings/schema'

// Copy and Save Results As each have their own "include column headers" setting; earlier versions had one for both.
const copyKey = 'queryResults.grid.copyColumnHeaders', saveKey = 'queryResults.grid.saveColumnHeaders', oldKey = 'queryResults.grid.includeColumnHeaders'

describe('column header settings', () => {
  it('copy omits headers and save includes them by default, on the same page and group', () => {
    expect(defaultSettings[copyKey]).toBe(false)
    expect(defaultSettings[saveKey]).toBe(true)
    const defs = settingDefs.filter(def => def.key === copyKey || def.key === saveKey)
    expect(defs.map(def => [def.page, def.group, def.label])).toEqual([
      ['queryResults.sqlServer.grid', 'Copy and save', 'Include column headers when copying the results'],
      ['queryResults.sqlServer.grid', 'Copy and save', 'Include column headers when saving the results']
    ])
    expect(Object.hasOwn(defaultSettings, oldKey)).toBe(false)
  })

  it('save reads the save setting, not the copy one', () => {
    expect(saveHeaders({ ...defaultSettings, [copyKey]: true, [saveKey]: false })).toBe(false)
    expect(saveHeaders({ ...defaultSettings, [copyKey]: false, [saveKey]: true })).toBe(true)
  })

  it('carries a stored old value to both new keys and drops the old key', () => {
    expect(renamedSettings[oldKey]).toEqual([copyKey, saveKey])
    // On: copy differs from its default, save keeps its own.
    expect(parseStoredSettings({ version: 1, values: { [oldKey]: true } })).toEqual({ overrides: { [copyKey]: true }, unknown: {}, invalidKeys: [] })
    // Off (only a hand edit stores the old default): saving stays without headers, as before.
    expect(parseStoredSettings({ version: 1, values: { [oldKey]: false } })).toEqual({ overrides: { [saveKey]: false }, unknown: {}, invalidKeys: [] })
    // A new key the file sets wins over the old one.
    expect(parseStoredSettings({ version: 1, values: { [oldKey]: true, [copyKey]: false } })?.overrides).toEqual({})
    // An old value the new keys cannot hold is dropped without a salvage.
    expect(parseStoredSettings({ version: 1, values: { [oldKey]: 'yes' } })).toEqual({ overrides: {}, unknown: {}, invalidKeys: [] })
  })
})

describe('column header settings migration in settings.json', () => {
  let directory: string
  beforeEach(async () => {
    await mkdir('artifacts', { recursive: true })
    directory = await mkdtemp(join(resolve('artifacts'), 'column-headers-test-'))
  })
  afterEach(async () => {
    expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps an earlier version\'s choice for both, and the next write leaves the old key out', async () => {
    const path = join(directory, 'settings.json')
    await writeFile(path, JSON.stringify({ version: 1, values: { [oldKey]: true, 'queryResults.grid.sortText': 'bytes' } }))
    const store = new SettingsStore(path, join(directory, 'scripting-options.json'))
    const loaded = await store.load()
    expect([loaded.values[copyKey], loaded.values[saveKey]]).toEqual([true, true])
    // A read is not a write: the file still holds the old key until something changes.
    expect(JSON.parse(await readFile(path, 'utf8')).values[oldKey]).toBe(true)
    const updated = await store.update({ [copyKey]: null })
    expect([updated.values[copyKey], updated.values[saveKey]]).toEqual([false, true])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, values: { 'queryResults.grid.sortText': 'bytes' } })
    // Read again, the reset copy setting stays reset: nothing carries the old value back.
    const again = await new SettingsStore(path, join(directory, 'scripting-options.json')).load()
    expect([again.values[copyKey], again.values[saveKey]]).toEqual([false, true])
  })
})
