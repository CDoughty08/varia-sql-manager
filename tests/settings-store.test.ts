import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { salvageWarning, SettingsStore, unreadableSettings } from '../src/main/settings-store'
import { scriptLimits } from '../src/shared/scripting/catalog'
import { defaultScriptingOptions } from '../src/shared/scripting/options'
import { defaultSettings, settingsLimits, type SettingsValues } from '../src/shared/settings/catalog'
import type { SettingsState } from '../src/shared/settings/schema'

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'settings-test-'))
})
afterEach(async () => {
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

const path = () => join(directory, 'settings.json')
const legacyPath = () => join(directory, 'scripting-options.json')
const store = () => new SettingsStore(path(), legacyPath())
const file = (values: Record<string, unknown>) => JSON.stringify({ version: 1, values })
const onDisk = async () => JSON.parse(await readFile(path(), 'utf8')) as { version: number; values: Record<string, unknown> }
const values = (overrides: Partial<Record<keyof SettingsValues, unknown>>) => ({ ...defaultSettings, ...overrides })
const quarantined = async (name: string) => (await readdir(directory)).filter(entry => entry.startsWith(name + '.invalid-'))

describe('settings file', () => {
  it('uses the defaults for a missing file without writing one', async () => {
    expect(await store().load()).toEqual({ revision: 1, values: defaultSettings })
    expect(await readdir(directory)).toEqual([])
  })
  it('reads overrides and keeps a newer version\'s keys through an update', async () => {
    await writeFile(path(), file({ 'textEditor.sql.tabSize': 2, 'future.flag': true }))
    const settings = store()
    expect((await settings.load()).values).toEqual(values({ 'textEditor.sql.tabSize': 2 }))
    await settings.update({ 'queryExecution.executionTimeout': 7 })
    expect(await onDisk()).toEqual({ version: 1, values: { 'future.flag': true, 'queryExecution.executionTimeout': 7, 'textEditor.sql.tabSize': 2 } })
  })
  it('quarantines invalid files, keeps their bytes, and warns only the readers that show it, once', async () => {
    const cases: [string | Buffer, string][] = [
      ['{"version":1,', 'not valid JSON'], [Buffer.from([0xff, 0xfe, 0x7b]), 'not UTF-8'], [' '.repeat(settingsLimits.fileBytes + 1), 'larger than 128 KiB'],
      [JSON.stringify({ version: 2, values: {} }), 'unsupported values'], [JSON.stringify({ version: 1, values: null }), 'unsupported values'], ['[]', 'unsupported values']
    ]
    for (const [content, reason] of cases) {
      await rm(directory, { recursive: true, force: true }); await mkdir(directory)
      await writeFile(path(), content)
      const settings = store()
      // Main's own read at startup does not use the warning up.
      expect(await settings.load()).toEqual({ revision: 1, values: defaultSettings })
      expect(await settings.load({ showsWarning: true })).toEqual({ revision: 1, values: defaultSettings, warning: `Settings were invalid (${reason}) and were reset; the original file was kept.` })
      const [kept, ...rest] = await readdir(directory)
      expect(rest).toEqual([])
      expect(kept).toMatch(/^settings\.json\.invalid-[0-9a-f-]{36}\.json$/)
      expect(await readFile(join(directory, kept))).toEqual(Buffer.from(content))
      // A reloaded window asks again: nothing is read again, and the warning is not repeated.
      expect(await settings.load({ showsWarning: true })).toEqual({ revision: 1, values: defaultSettings })
      expect(await readdir(directory)).toEqual([kept])
    }
  })
  it('salvages a file with unsupported values: the original is kept, the rest written back', async () => {
    const content = file({ 'textEditor.sql.tabSize': 0, 'queryExecution.executionTimeout': 30, 'textEditor.sql.tabs': 'both', 'future.flag': 'kept' })
    await writeFile(path(), content)
    const loaded = await store().load({ showsWarning: true })
    expect(loaded.values).toEqual(values({ 'queryExecution.executionTimeout': 30 }))
    expect(loaded.warning).toBe('Some settings had values this version does not support (Tab size, Tab characters) and were reset to their defaults; the original file was kept.')
    const [kept] = await quarantined('settings.json')
    expect(await readFile(join(directory, kept), 'utf8')).toBe(content)
    expect(await onDisk()).toEqual({ version: 1, values: { 'future.flag': 'kept', 'queryExecution.executionTimeout': 30 } })
    expect(salvageWarning(['textEditor.sql.tabSize', 'textEditor.sql.indentSize', 'textEditor.sql.tabs', 'queryExecution.executionTimeout', 'textEditor.sql.wordWrap']))
      .toBe('Some settings had values this version does not support (Tab size, Indent size, Tab characters and 2 more) and were reset to their defaults; the original file was kept.')
  })
  it('gives callers that ask at the same time one read and one quarantine', async () => {
    await writeFile(path(), '{')
    const settings = store()
    const [first, second] = await Promise.all([settings.load({ showsWarning: true }), settings.load({ showsWarning: true })])
    expect([first.warning, second.warning].filter(Boolean)).toHaveLength(2)
    expect(await readdir(directory)).toHaveLength(1)
  })
  it('does not cache a read that failed, and the next load reads again', async () => {
    for (const blocked of [path, legacyPath]) {
      await rm(directory, { recursive: true, force: true }); await mkdir(directory)
      await mkdir(blocked())
      const settings = store()
      await expect(settings.load()).rejects.toThrow('Expected a regular file')
      await rm(blocked(), { recursive: true })
      await writeFile(path(), file({ 'textEditor.sql.wordWrap': true }))
      expect((await settings.load()).values['textEditor.sql.wordWrap']).toBe(true)
    }
  })
})

describe('migration from scripting-options.json', () => {
  const legacy = JSON.stringify({ version: 1, options: { ...defaultScriptingOptions, scriptUseDatabase: false, targetServerVersion: '130' } })
  it('writes only the options that differ, and leaves the legacy file byte for byte', async () => {
    await writeFile(legacyPath(), legacy)
    const loaded = await store().load()
    expect(loaded.values).toEqual(values({ 'objectExplorer.scripting.scriptUseDatabase': false, 'objectExplorer.scripting.targetServerVersion': '130' }))
    expect(await onDisk()).toEqual({ version: 1, values: { 'objectExplorer.scripting.scriptUseDatabase': false, 'objectExplorer.scripting.targetServerVersion': '130' } })
    expect(await readFile(legacyPath(), 'utf8')).toBe(legacy)
  })
  it('does not run once settings.json exists', async () => {
    await writeFile(legacyPath(), legacy)
    await writeFile(path(), file({ 'textEditor.sql.wordWrap': true }))
    expect((await store().load()).values).toEqual(values({ 'textEditor.sql.wordWrap': true }))
    expect(await onDisk()).toEqual({ version: 1, values: { 'textEditor.sql.wordWrap': true } })
  })
  it('quarantines an invalid legacy file with the scripting options warning, and writes nothing', async () => {
    await writeFile(legacyPath(), '{"version":1,')
    expect(await store().load({ showsWarning: true })).toEqual({ revision: 1, values: defaultSettings, warning: 'Scripting options were invalid (not valid JSON) and were reset; the original file was kept.' })
    expect(await quarantined('scripting-options.json')).toHaveLength(1)
    expect((await readdir(directory)).length).toBe(1)
    await rm(directory, { recursive: true, force: true }); await mkdir(directory)
    await writeFile(legacyPath(), ' '.repeat(scriptLimits.prefsBytes + 1))
    expect((await store().load({ showsWarning: true })).warning).toBe('Scripting options were invalid (larger than 16 KiB) and were reset; the original file was kept.')
  })
  it('imports the legacy file into an update made while settings.json is missing', async () => {
    const settings = store()
    await settings.load()
    await writeFile(legacyPath(), legacy)
    await settings.update({ 'textEditor.sql.wordWrap': true })
    expect(Object.keys((await onDisk()).values)).toEqual(['objectExplorer.scripting.scriptUseDatabase', 'objectExplorer.scripting.targetServerVersion', 'textEditor.sql.wordWrap'])
  })
})

describe('settings updates', () => {
  it('merges into what the file holds now, resets with null, and writes sorted overrides only', async () => {
    const settings = store()
    await settings.load()
    await settings.update({ 'textEditor.sql.wordWrap': true, 'queryExecution.executionTimeout': 7 })
    // Changed by hand after main read it.
    await writeFile(path(), file({ 'textEditor.sql.wordWrap': true, 'queryExecution.executionTimeout': 7, 'textEditor.sql.tabSize': 2 }))
    const state = await settings.update({ 'queryExecution.executionTimeout': null, 'environment.fonts.editorFontSize': 16, 'textEditor.sql.lineNumbers': true })
    expect(state.values).toEqual(values({ 'textEditor.sql.wordWrap': true, 'textEditor.sql.tabSize': 2, 'environment.fonts.editorFontSize': 16 }))
    const text = await readFile(path(), 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, values: { 'environment.fonts.editorFontSize': 16, 'textEditor.sql.tabSize': 2, 'textEditor.sql.wordWrap': true } })
    expect(Object.keys(JSON.parse(text).values)).toEqual(['environment.fonts.editorFontSize', 'textEditor.sql.tabSize', 'textEditor.sql.wordWrap'])
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(settingsLimits.fileBytes)
    expect(await readdir(directory)).toEqual(['settings.json'])
  })
  it('rejects unknown keys, wrong types and empty patches before touching anything', async () => {
    const settings = store()
    for (const invalid of [{}, { 'textEditor.unknown': true }, { 'textEditor.sql.tabSize': 0 }, { 'textEditor.sql.wordWrap': 'yes' }, null, []]) expect(() => settings.update(invalid)).toThrow()
    expect(await readdir(directory)).toEqual([])
  })
  it('writes nothing for an update that changes nothing, and notifies once per change with increasing revisions', async () => {
    const settings = store(), seen: SettingsState[] = []
    settings.onDidChange(state => seen.push(state))
    const first = await settings.load()
    expect(await settings.update({ 'textEditor.sql.wordWrap': false })).toEqual(first)
    expect(await readdir(directory)).toEqual([])
    const results = await Promise.all([2, 3, 5].map(tabSize => settings.update({ 'textEditor.sql.tabSize': tabSize })))
    expect(results.map(state => [state.revision, state.values['textEditor.sql.tabSize']])).toEqual([[2, 2], [3, 3], [4, 5]])
    expect(seen.map(state => state.revision)).toEqual([2, 3, 4])
    expect(settings.current()['textEditor.sql.tabSize']).toBe(5)
    expect((await onDisk()).values).toEqual({ 'textEditor.sql.tabSize': 5 })
    expect((await new SettingsStore(path(), legacyPath()).load()).values['textEditor.sql.tabSize']).toBe(5)
  })
  it('quarantines content a load would reject before an update replaces it', async () => {
    const settings = store()
    await settings.load()
    await writeFile(path(), '{"version":1,')
    await settings.update({ 'textEditor.sql.wordWrap': true })
    const [kept, ...rest] = await quarantined('settings.json')
    expect(rest).toEqual([])
    expect(await readFile(join(directory, kept), 'utf8')).toBe('{"version":1,')
    expect(await onDisk()).toEqual({ version: 1, values: { 'textEditor.sql.wordWrap': true } })
  })
  it('keeps the values it last stored when a later write fails', async () => {
    const settings = store()
    await settings.update({ 'textEditor.sql.wordWrap': true })
    await rm(path()); await mkdir(path()); await writeFile(join(path(), 'keep'), '')
    await expect(settings.update({ 'textEditor.sql.wordWrap': false })).rejects.toThrow(unreadableSettings)
    expect((await settings.load()).values['textEditor.sql.wordWrap']).toBe(true)
    expect(settings.current()['textEditor.sql.wordWrap']).toBe(true)
  })
  it('never replaces a file it cannot read, even after a failed load', async () => {
    // Every read of a link to a folder fails, as it does for a file without read permission; a rename would replace the link.
    await mkdir(join(directory, 'elsewhere'))
    await symlink(join(directory, 'elsewhere'), path(), 'junction')
    const settings = store()
    await expect(settings.load()).rejects.toThrow()
    await expect(settings.update({ 'textEditor.sql.wordWrap': true })).rejects.toThrow(unreadableSettings)
    expect((await lstat(path())).isSymbolicLink()).toBe(true)
    expect((await readdir(directory)).sort()).toEqual(['elsewhere', 'settings.json'])
    expect(await readdir(join(directory, 'elsewhere'))).toEqual([])
  })
})
