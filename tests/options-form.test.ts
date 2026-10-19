import { describe, expect, it } from 'vitest'
import {
  ancestorIds, draftFrom, firstPage, pageForm, patchFrom, resetPage, rowDisabled, rowNotes, setDraftValue, treeRows, validateDraft, type OptionsDraft, type SettingRow
} from '../src/renderer/src/settings/options-form'
import { highlightParts, normalizeQuery, searchPages } from '../src/renderer/src/settings/search'
import { scriptingOptionKeys } from '../src/shared/scripting/options'
import { defaultSettings, settingDef, settingDefs, settingsLimits, type SettingDef, type SettingKey, type SettingsValues } from '../src/shared/settings/catalog'

const draft: OptionsDraft = draftFrom(defaultSettings)
const scripting = (value: OptionsDraft) => pageForm('objectExplorer.scripting', value, 'win32').groups.flatMap(group => group.rows)
const row = (value: OptionsDraft, key: string): SettingRow => scripting(value).find(item => item.key === 'objectExplorer.scripting.' + key)!
const set = (value: OptionsDraft, key: string, text: string) => setDraftValue(value, key as SettingKey, text)
const versionRows = ['targetEngineEdition', 'targetEngineType', 'targetServerVersion'].map(key => 'objectExplorer.scripting.' + key)
const fixture = (patch: Partial<SettingDef> & Pick<SettingDef, 'key'>): SettingDef =>
  ({ page: 'environment.general', label: 'Fixture', description: 'A fixture.', type: 'boolean', default: false, ...patch }) as SettingDef

describe('Options page tree', () => {
  it('shows top-level categories collapsed, and a category\'s children once expanded', () => {
    expect(treeRows(new Set()).map(row => row.page.title)).toEqual(['Environment', 'Text Editor', 'Query Execution', 'Query Results', 'SQL Server Object Explorer'])
    const open = treeRows(new Set(['textEditor', 'textEditor.transactSql']))
    expect(open.map(row => `${row.level}:${row.page.title}:${row.expandable ? row.expanded : '-'}`)).toEqual([
      '1:Environment:false', '1:Text Editor:true', '2:General:-', '2:Transact-SQL:true', '3:General:-', '3:Tabs:-', '1:Query Execution:false', '1:Query Results:false', '1:SQL Server Object Explorer:false'
    ])
  })
  it('shows a category\'s first page when it is selected, with the path to it expanded', () => {
    expect(firstPage('queryExecution')).toBe('queryExecution.sqlServer.general')
    expect(firstPage('textEditor.transactSql')).toBe('textEditor.transactSql.general')
    expect(firstPage('objectExplorer.scripting')).toBe('objectExplorer.scripting')
    expect(ancestorIds('queryExecution.sqlServer.general')).toEqual(['queryExecution', 'queryExecution.sqlServer'])
  })
})

describe('Options search', () => {
  it('filters the tree to matching pages and their ancestors, matching labels case-insensitively', () => {
    const found = searchPages('  TIME-out ', 'win32')!
    expect(found.pages).toEqual(['queryExecution.sqlServer.general'])
    expect(treeRows(new Set(), found.shown).map(row => row.page.title)).toEqual(['Query Execution', 'SQL Server', 'General'])
    expect(highlightParts('Execution time-out', ' TIME-out')).toEqual([{ text: 'Execution ', match: false }, { text: 'time-out', match: true }])
  })
  it('matches descriptions, keywords, page paths, the theme note and the Keyboard page\'s words', () => {
    expect(searchPages('waits indefinitely', 'win32')!.pages).toEqual(['queryExecution.sqlServer.general'])
    expect(searchPages('csv', 'win32')!.pages).toEqual(['queryResults.sqlServer.grid'])
    expect(searchPages('transact-sql', 'win32')!.pages).toEqual(['textEditor.transactSql.general', 'textEditor.transactSql.tabs'])
    expect(searchPages('color theme', 'win32')!.pages).toContain('environment.general')
    expect(searchPages('shortcut', 'win32')!.pages).toEqual(['environment.keyboard'])
  })
  it('finds nothing for text nothing has, and filters nothing for an empty query', () => {
    expect(searchPages('zzz-no-such-setting', 'win32')).toEqual({ pages: [], shown: new Set() })
    expect(searchPages('   ', 'win32')).toBeUndefined()
    expect(normalizeQuery('x'.repeat(settingsLimits.searchChars + 10))).toHaveLength(settingsLimits.searchChars)
  })
  it('never matches a setting Options does not show on this platform, or a hidden one', () => {
    const defs = [fixture({ key: 'fixture.mac', label: 'Unicorn option', platforms: ['darwin'] }), fixture({ key: 'fixture.hidden', label: 'Unicorn hidden', hidden: true })]
    expect(searchPages('unicorn', 'win32', defs)!.pages).toEqual([])
    expect(searchPages('unicorn', 'darwin', defs)!.pages).toEqual(['environment.general'])
  })
})

describe('Options pages', () => {
  it('lists the Scripting page\'s four categories and 36 rows in the docs page\'s order', () => {
    const groups = pageForm('objectExplorer.scripting', draft, 'win32').groups
    expect(groups.map(group => [group.label, group.rows.length])).toEqual([
      ['General scripting options', 6], ['Object scripting options', 7], ['Table/View options', 19], ['Version options', 4]
    ])
    expect(scripting(draft).map(item => item.key)).toEqual(scriptingOptionKeys.map(key => 'objectExplorer.scripting.' + key))
    expect(row(draft, 'scriptUseDatabase')).toMatchObject({ value: 'true', choices: [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }], changed: false, disabled: false })
    expect(row(draft, 'targetServerVersion').choices?.map(choice => choice.value)).toEqual(['130', '140', '150', '160', '170'])
  })
  it('marks exactly the values that differ from their defaults, which a property grid shows in bold', () => {
    expect(scripting(draft).filter(item => item.changed)).toEqual([])
    let next = set(draft, 'objectExplorer.scripting.scriptUseDatabase', 'false')
    next = set(next, 'objectExplorer.scripting.targetServerVersion', '130')
    expect(scripting(next).filter(item => item.changed).map(item => item.key)).toEqual(['objectExplorer.scripting.scriptUseDatabase', 'objectExplorer.scripting.targetServerVersion'])
    expect(row(set(next, 'objectExplorer.scripting.scriptUseDatabase', 'true'), 'scriptUseDatabase').changed).toBe(false)
  })
  it('greys rows while a disabledWhen setting is True or an enabledBy setting is False', () => {
    const greyed = (value: OptionsDraft) => scripting(value).filter(item => item.disabled).map(item => item.key)
    expect(greyed(draft)).toEqual(versionRows)
    expect(greyed(set(draft, 'objectExplorer.scripting.matchSourceSettings', 'false'))).toEqual([])
    const interval = fixture({ key: 'environment.fixtureInterval', enabledBy: 'objectExplorer.scripting.matchSourceSettings' })
    expect(rowDisabled(interval, draft)).toBe(false)
    expect(rowDisabled(interval, set(draft, 'objectExplorer.scripting.matchSourceSettings', 'false'))).toBe(true)
  })
  it('renders a provider page\'s note first, then its own settings; hides hidden settings and other platforms\'', () => {
    const defs = [fixture({ key: 'environment.everywhere' }), fixture({ key: 'environment.mac', platforms: ['darwin'] }), fixture({ key: 'environment.hidden', hidden: true })]
    const general = pageForm('environment.general', draft, 'win32', defs)
    expect(general.provider).toBe('theme')
    expect(general.groups.flatMap(group => group.rows.map(item => item.key))).toEqual(['environment.everywhere'])
    expect(pageForm('environment.general', draft, 'darwin', defs).groups.flatMap(group => group.rows.map(item => item.key))).toEqual(['environment.everywhere', 'environment.mac'])
    expect(pageForm('textEditor.transactSql.tabs', draft, 'win32').groups.map(group => group.label)).toEqual(['Tab'])
  })
  it('sets values only from a row\'s own choices, and keeps an integer field\'s text until OK checks it', () => {
    expect(set(draft, 'textEditor.sql.wordWrap', 'true')['textEditor.sql.wordWrap']).toBe(true)
    for (const [key, text] of [['textEditor.sql.wordWrap', 'True'], ['textEditor.sql.tabs', 'both'], ['textEditor.unknown', 'true']] as const) expect(set(draft, key, text), `${key} ${text}`).toBe(draft)
    expect(set(draft, 'textEditor.sql.tabSize', ' 2 ')['textEditor.sql.tabSize']).toBe(2)
    expect(set(draft, 'textEditor.sql.tabSize', '2.5')['textEditor.sql.tabSize']).toBe('2.5')
    expect(set(draft, 'textEditor.sql.tabSize', '')['textEditor.sql.tabSize']).toBe('')
  })
  it('resets only the shown page, in the draft', () => {
    let next = set(draft, 'textEditor.sql.tabSize', '2')
    next = set(next, 'queryExecution.executionTimeout', '7')
    const reset = resetPage(next, 'textEditor.transactSql.tabs', 'win32')
    expect(reset['textEditor.sql.tabSize']).toBe(4)
    expect(reset['queryExecution.executionTimeout']).toBe(7)
    expect(next['textEditor.sql.tabSize']).toBe(2)
  })
})

describe('Options OK', () => {
  it('names the bounds of an integer that is empty, not whole or out of range, first invalid field first in tree order', () => {
    let next = set(draft, 'objectExplorer.selectTopRows', '0')
    next = set(next, 'queryExecution.executionTimeout', '99999')
    next = set(next, 'textEditor.sql.tabSize', '')
    const result = validateDraft(next)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      { key: 'textEditor.sql.tabSize', page: 'textEditor.transactSql.tabs', message: 'Tab size must be a whole number from 1 to 60.' },
      { key: 'queryExecution.executionTimeout', page: 'queryExecution.sqlServer.general', message: 'Execution time-out must be a whole number from 0 to 86,400.' },
      { key: 'objectExplorer.selectTopRows', page: 'objectExplorer.commands', message: 'Value for Select Top <n> Rows command must be a whole number from 1 to 2,147,483,647.' }
    ])
    expect(validateDraft(set(draft, 'textEditor.sql.indentSize', '1.5')).ok).toBe(false)
    expect(validateDraft(draft)).toEqual({ ok: true, values: draft })
    // Areas registered out of tree order (a later area's pages early in the tree) still report in tree order.
    const reversed = [...settingDefs].reverse()
    const late = validateDraft(next, reversed)
    expect(late.ok ? [] : late.errors.map(error => error.key)).toEqual(['textEditor.sql.tabSize', 'queryExecution.executionTimeout', 'objectExplorer.selectTopRows'])
  })
  it('sends only the settings that differ from what main stored', () => {
    const stored: SettingsValues = { ...defaultSettings, 'textEditor.sql.wordWrap': true }
    let next = draftFrom(stored)
    expect(patchFrom(stored, next as SettingsValues)).toEqual({})
    next = set(next, 'textEditor.sql.wordWrap', 'false')
    next = set(next, 'queryExecution.executionTimeout', '7')
    expect(patchFrom(stored, next as SettingsValues)).toEqual({ 'textEditor.sql.wordWrap': false, 'queryExecution.executionTimeout': 7 })
  })
  it('notes when a change applies and whether SSMS has the option', () => {
    expect(rowNotes(settingDef('queryExecution.executionTimeout'))).toEqual(['Applies to the next execution.'])
    expect(rowNotes(settingDef('queryExecution.stopOnError'))).toEqual(['Applies to the next execution.', 'Not in SSMS.'])
    expect(rowNotes(settingDef('textEditor.sql.wordWrap'))).toEqual([])
  })
})
