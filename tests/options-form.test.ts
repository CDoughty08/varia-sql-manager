import { describe, expect, it } from 'vitest'
import { optionCategories, optionDescription, optionDisabled, resetOptions, setOption, validateOptions, type OptionRow } from '../src/renderer/src/scripting/options-form'
import { defaultScriptingOptions, scriptingOptionDef, scriptingOptionDefs, scriptingOptionKeys, type ScriptingOptions } from '../src/shared/scripting/options'

const rows = (draft: ScriptingOptions) => optionCategories(draft).flatMap(category => category.rows)
const row = (draft: ScriptingOptions, key: string): OptionRow => rows(draft).find(item => item.key === key)!
const versionRows = ['targetEngineEdition', 'targetEngineType', 'targetServerVersion']

describe('Options dialog form', () => {
  it('lists the four categories and 36 rows in the docs page\'s order, with True/False or the enum\'s labels', () => {
    const categories = optionCategories(defaultScriptingOptions)
    expect(categories.map(category => [category.label, category.rows.length])).toEqual([
      ['General scripting options', 6], ['Object scripting options', 7], ['Table/View options', 19], ['Version options', 4]
    ])
    expect(rows(defaultScriptingOptions).map(item => item.key)).toEqual(scriptingOptionKeys)
    expect(row(defaultScriptingOptions, 'scriptUseDatabase')).toEqual({
      key: 'scriptUseDatabase', label: 'Script USE <database>', value: 'true', choices: [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }], changed: false, disabled: false
    })
    expect(row(defaultScriptingOptions, 'targetServerVersion')).toMatchObject({ value: '160', choices: [
      { value: '130', label: 'SQL Server 2016' }, { value: '140', label: 'SQL Server 2017' }, { value: '150', label: 'SQL Server 2019' }, { value: '160', label: 'SQL Server 2022' }, { value: '170', label: 'SQL Server 2025' }
    ] })
    expect(row(defaultScriptingOptions, 'targetEngineEdition').choices.map(choice => choice.label)).toEqual([
      'Microsoft SQL Server Personal Edition', 'Microsoft SQL Server Standard Edition', 'Microsoft SQL Server Enterprise Edition', 'Microsoft SQL Server Express Edition'
    ])
    expect(row(defaultScriptingOptions, 'targetEngineType').choices).toEqual([{ value: 'standalone', label: 'Stand-alone instance' }])
  })
  it('marks exactly the values that differ from their defaults, which the dialog shows in bold', () => {
    expect(rows(defaultScriptingOptions).filter(item => item.changed)).toEqual([])
    let draft = setOption(defaultScriptingOptions, 'scriptUseDatabase', 'false')
    draft = setOption(draft, 'scriptPermissions', 'true')
    draft = setOption(draft, 'targetServerVersion', '130')
    expect(rows(draft).filter(item => item.changed).map(item => item.key)).toEqual(['scriptUseDatabase', 'scriptPermissions', 'targetServerVersion'])
    // Back to its default, a row is no longer bold.
    expect(row(setOption(draft, 'scriptUseDatabase', 'true'), 'scriptUseDatabase').changed).toBe(false)
  })
  it('greys the three version rows exactly while Match script settings to source is True', () => {
    const greyed = (draft: ScriptingOptions) => rows(draft).filter(item => item.disabled).map(item => item.key)
    expect(greyed(defaultScriptingOptions)).toEqual(versionRows)
    const own = setOption(defaultScriptingOptions, 'matchSourceSettings', 'false')
    expect(greyed(own)).toEqual([])
    for (const def of scriptingOptionDefs) expect(optionDisabled(def, own), def.key).toBe(false)
    expect(optionDisabled(scriptingOptionDef('targetServerVersion'), defaultScriptingOptions)).toBe(true)
    // Greyed rows keep their values, which the request carries and the backend ignores.
    expect(setOption(own, 'targetServerVersion', '150').targetServerVersion).toBe('150')
  })
  it('sets values only from the row\'s own choices, without changing the draft it was given', () => {
    const draft = resetOptions()
    expect(setOption(draft, 'includeHeaders', 'false')).toEqual({ ...defaultScriptingOptions, includeHeaders: false })
    expect(draft).toEqual(defaultScriptingOptions)
    for (const [key, text] of [['includeHeaders', 'False'], ['includeHeaders', ''], ['targetServerVersion', '120'], ['targetEngineType', 'azure'], ['targetEngineEdition', 'enterprise ']] as const) {
      expect(setOption(draft, key, text), `${key} ${text}`).toBe(draft)
    }
  })
  it('resets to a fresh copy of the defaults, touching only the draft', () => {
    const reset = resetOptions()
    expect(reset).toEqual(defaultScriptingOptions)
    expect(reset).not.toBe(defaultScriptingOptions)
    expect(Object.isFrozen(defaultScriptingOptions)).toBe(true)
    expect(rows(reset).some(item => item.changed)).toBe(false)
  })
  it('validates the whole draft with the strict schema, naming the row that is wrong', () => {
    const changed = setOption(defaultScriptingOptions, 'checkExistence', 'true')
    expect(validateOptions(changed)).toEqual({ ok: true, options: changed })
    expect(validateOptions({ ...changed, targetServerVersion: '120' })).toEqual({ ok: false, error: 'Script for server version has a value that is not supported.' })
    expect(validateOptions({ ...changed, scriptOwner: 'yes' })).toEqual({ ok: false, error: 'Script owner has a value that is not supported.' })
    const { scriptOwner: _, ...missing } = changed
    expect(validateOptions(missing)).toEqual({ ok: false, error: 'Script owner has a value that is not supported.' })
    expect(validateOptions({ ...changed, extra: true })).toEqual({ ok: false, error: 'The scripting options are not valid.' })
    expect(validateOptions(null)).toEqual({ ok: false, error: 'The scripting options are not valid.' })
  })
  it('describes the focused row with its label and the docs text', () => {
    expect(optionDescription('scriptUseDatabase')).toEqual({ label: 'Script USE <database>', description: scriptingOptionDef('scriptUseDatabase').description })
    for (const key of scriptingOptionKeys) expect(optionDescription(key).description.length, key).toBeGreaterThan(10)
  })
})
