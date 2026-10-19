import { describe, expect, it } from 'vitest'
import { defaultSettings, settingKeys, settingsLimits } from '../src/shared/settings/catalog'
import { parseStoredSettings, settingsPatchSchema, settingsStateSchema, settingsValuesSchema, storedSettings, withDefaults } from '../src/shared/settings/schema'

const patch = (value: unknown) => settingsPatchSchema.safeParse(value).success

describe('settings schemas', () => {
  it('accepts the defaults as a complete, strict value set', () => {
    expect(settingsValuesSchema.safeParse(defaultSettings).success).toBe(true)
    const { 'textEditor.sql.tabSize': _missing, ...partial } = defaultSettings
    expect(settingsValuesSchema.safeParse(partial).success).toBe(false)
    expect(settingsValuesSchema.safeParse({ ...defaultSettings, 'textEditor.unknown': true }).success).toBe(false)
    expect(settingsStateSchema.safeParse({ revision: 1, values: defaultSettings }).success).toBe(true)
    expect(settingsStateSchema.safeParse({ revision: -1, values: defaultSettings }).success).toBe(false)
  })
  it('accepts a patch of known keys with values in range, and null to reset', () => {
    expect(patch({ 'queryExecution.executionTimeout': 7, 'textEditor.sql.wordWrap': true, 'textEditor.sql.tabs': 'spaces' })).toBe(true)
    expect(patch({ 'queryExecution.executionTimeout': null })).toBe(true)
    expect(patch({ 'objectExplorer.scripting.targetServerVersion': '170' })).toBe(true)
  })
  it('rejects unknown keys, wrong types, out-of-range or fractional integers, unknown enum values, and an empty patch', () => {
    for (const value of [
      {}, { 'textEditor.unknown': true }, { 'textEditor.sql.wordWrap': 'true' }, { 'queryExecution.executionTimeout': 86_401 }, { 'queryExecution.executionTimeout': -1 },
      { 'textEditor.sql.tabSize': 2.5 }, { 'textEditor.sql.tabSize': '2' }, { 'textEditor.sql.tabs': 'both' }, [], null, 'x'
    ]) expect(patch(value), JSON.stringify(value)).toBe(false)
  })
})

describe('parseStoredSettings', () => {
  it('reads overrides, dropping those equal to their defaults, and fills in the rest', () => {
    const parsed = parseStoredSettings({ version: 1, values: { 'textEditor.sql.tabSize': 2, 'textEditor.sql.wordWrap': false } })
    expect(parsed).toEqual({ overrides: { 'textEditor.sql.tabSize': 2 }, unknown: {}, invalidKeys: [] })
    const values = withDefaults(parsed!.overrides)
    expect(values['textEditor.sql.tabSize']).toBe(2)
    expect(values['queryExecution.executionTimeout']).toBe(0)
    expect(Object.keys(values)).toEqual(settingKeys)
  })
  it('puts a known key with a value its schema rejects in invalidKeys and drops it', () => {
    expect(parseStoredSettings({ version: 1, values: { 'textEditor.sql.tabSize': 0, 'queryExecution.executionTimeout': 30 } }))
      .toEqual({ overrides: { 'queryExecution.executionTimeout': 30 }, unknown: {}, invalidKeys: ['textEditor.sql.tabSize'] })
  })
  it('keeps a newer version\'s keys within bounds and drops anything else', () => {
    const long = 'x'.repeat(settingsLimits.unknownStringChars)
    const parsed = parseStoredSettings({ version: 1, values: {
      'future.flag': true, 'future.count': 3, 'future.text': long, 'future.tooLong': long + 'x', 'future.object': { a: 1 }, 'future.list': [1], 'future.nothing': null,
      'Future.badKey': true, 'future': true, ['future.' + 'k'.repeat(settingsLimits.keyChars)]: true
    } })
    expect(parsed?.unknown).toEqual({ 'future.flag': true, 'future.count': 3, 'future.text': long })
    const many = Object.fromEntries(Array.from({ length: settingsLimits.unknownKeys + 10 }, (_, index) => [`future.key${index}`, index]))
    expect(Object.keys(parseStoredSettings({ version: 1, values: many })!.unknown)).toHaveLength(settingsLimits.unknownKeys)
  })
  it('reads only own properties, so __proto__ is an unknown key that pollutes nothing', () => {
    const parsed = parseStoredSettings(JSON.parse('{"version":1,"values":{"__proto__":{"textEditor.sql.wordWrap":true},"constructor":{"x":1}}}'))
    expect(parsed).toEqual({ overrides: {}, unknown: {}, invalidKeys: [] })
    expect(Object.getPrototypeOf(parsed!.overrides)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['textEditor.sql.wordWrap']).toBeUndefined()
  })
  it('rejects files whose top level is not version 1 with a values object', () => {
    for (const value of [null, [], 'x', { version: 2, values: {} }, { version: 1 }, { version: 1, values: null }, { version: 1, values: [] }, { version: 1, values: {}, extra: 1 }, { values: {} }])
      expect(parseStoredSettings(value), JSON.stringify(value)).toBeUndefined()
  })
  it('stores overrides and unknown keys together, sorted by key', () => {
    const stored = storedSettings({ 'textEditor.sql.tabSize': 2, 'environment.fonts.editorFontSize': 16 }, { 'future.flag': true })
    expect(Object.keys(stored.values)).toEqual(['environment.fonts.editorFontSize', 'future.flag', 'textEditor.sql.tabSize'])
    expect(stored.version).toBe(1)
  })
})
