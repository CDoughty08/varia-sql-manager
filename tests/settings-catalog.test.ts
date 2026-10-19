import { describe, expect, it } from 'vitest'
import { requestSchemas } from '../src/main/validation'
import { limits } from '../src/shared/ipc/wire/protocol'
import { defaultScriptingOptions, scriptingOptionDefs, scriptingOptionGroupLabels } from '../src/shared/scripting/options'
import { selectTopRowsScript } from '../src/shared/sql/identifiers'
import {
  commandTitle, defaultSettings, pageById, pagePath, scriptingOptionsFrom, settingDef, settingDefs, settingKeyPattern, settingKeys, settingPages, settingsLimits,
  visibleSettings, type SettingDef
} from '../src/shared/settings/catalog'
import { renderSettingsDocs } from '../src/shared/settings/docs'
import { valueSchema } from '../src/shared/settings/schema'

/**
 * The Options tree, in SSMS 22's names and order: `title` (page id). Later PRs add their pages here, where SSMS has them.
 */
const expectedTree = [
  'Environment',
  '  General (environment.general)',
  '  Fonts and Colors (environment.fontsAndColors)',
  '  Keyboard (environment.keyboard)',
  'Text Editor',
  '  General (textEditor.general)',
  '  Transact-SQL',
  '    General (textEditor.transactSql.general)',
  '    Tabs (textEditor.transactSql.tabs)',
  'Query Execution',
  '  SQL Server',
  '    General (queryExecution.sqlServer.general)',
  '    Advanced (queryExecution.sqlServer.advanced)',
  'Query Results',
  '  SQL Server',
  '    Results to Grid (queryResults.sqlServer.grid)',
  'SQL Server Object Explorer',
  '  Commands (objectExplorer.commands)',
  '  Scripting (objectExplorer.scripting)'
]
function treeLines(): string[] {
  const lines: string[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const page of settingPages.filter(node => node.parent === parent)) {
      lines.push('  '.repeat(depth) + page.title + (page.layout ? ` (${page.id})` : ''))
      walk(page.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return lines
}

describe('settings catalogue', () => {
  it('has unique dotted keys within the length limit', () => {
    expect(new Set(settingKeys).size).toBe(settingKeys.length)
    for (const key of settingKeys) {
      expect(key, key).toMatch(settingKeyPattern)
      expect(key.length, key).toBeLessThanOrEqual(settingsLimits.keyChars)
    }
  })
  it('lays out exactly SSMS\'s tree, every page id unique and every parent a category before it', () => {
    expect(treeLines()).toEqual(expectedTree)
    expect(new Set(settingPages.map(page => page.id)).size).toBe(settingPages.length)
    settingPages.forEach((page, index) => {
      if (!page.parent) return
      const parent = pageById(page.parent)
      expect(parent?.layout, page.id).toBeUndefined()
      expect(settingPages.indexOf(parent!), page.id).toBeLessThan(index)
    })
    expect(pagePath('queryExecution.sqlServer.general').map(page => page.title)).toEqual(['Query Execution', 'SQL Server', 'General'])
  })
  it('puts every setting on a page with a layout, with a default its own schema accepts', () => {
    for (const def of settingDefs) {
      expect(pageById(def.page)?.layout, def.key).toBeDefined()
      expect(valueSchema(def).safeParse(def.default).success, def.key).toBe(true)
      if (def.type === 'integer') {
        for (const bound of [def.min, def.default, def.max]) expect(Number.isSafeInteger(bound), def.key).toBe(true)
        expect(def.min <= def.default && def.default <= def.max, def.key).toBe(true)
      }
      if (def.type === 'enum') expect(new Set(def.values.map(item => item.value)).size, def.key).toBe(def.values.length)
    }
    expect(Object.isFrozen(defaultSettings)).toBe(true)
  })
  it('bounds integers as their consumers do', () => {
    const execute = (patch: Record<string, unknown>) => requestSchemas['query.execute'].safeParse({
      connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1', queryId: crypto.randomUUID(), maxRows: 0, timeoutSeconds: 0, ...patch
    }).success
    const timeout = settingDef('queryExecution.executionTimeout'), resultSets = settingDef('queryResults.grid.maxResultSets'), top = settingDef('objectExplorer.selectTopRows')
    if (timeout.type !== 'integer' || resultSets.type !== 'integer' || top.type !== 'integer') throw new Error('Expected integer settings.')
    expect([execute({ timeoutSeconds: timeout.min }), execute({ timeoutSeconds: timeout.max }), execute({ timeoutSeconds: timeout.max + 1 })]).toEqual([true, true, false])
    expect([resultSets.min, resultSets.max]).toEqual([limits.maxResultSets.min, limits.maxResultSets.max])
    expect(execute({ maxResultSets: resultSets.max })).toBe(true)
    const source = { database: 'd', schema: 's', name: 'n', columns: [], truncated: false }
    expect(top.min).toBe(1)
    expect(selectTopRowsScript(source, top.min)).toContain('TOP (1)')
    expect(selectTopRowsScript(source, top.max)).toContain('TOP (2147483647)')
    expect(() => selectTopRowsScript(source, top.min - 1)).toThrow()
  })
  it('greys rows only after a boolean setting on the same page', () => {
    for (const def of settingDefs) {
      for (const key of [def.disabledWhen, def.enabledBy]) {
        if (key === undefined) continue
        const other = settingDefs.find(item => item.key === key)
        expect(other?.type, def.key).toBe('boolean')
        expect(other?.page, def.key).toBe(def.page)
      }
    }
  })
  it('hosts the 36 scripting options one-to-one, in order, from src/shared/scripting/options.ts', () => {
    const entries = settingDefs.filter(def => def.page === 'objectExplorer.scripting')
    expect(entries.map(def => def.key)).toEqual(scriptingOptionDefs.map(def => 'objectExplorer.scripting.' + def.key))
    entries.forEach((entry, index) => {
      const def = scriptingOptionDefs[index]
      expect([entry.label, entry.description, entry.default, entry.group, entry.type]).toEqual([def.label, def.description, def.default, scriptingOptionGroupLabels[def.group], def.type])
      expect(entry.ssmsDefault).toBe('docsDefault' in def ? def.docsDefault : undefined)
      expect(entry.disabledWhen).toBe('disabledWhen' in def ? 'objectExplorer.scripting.' + def.disabledWhen : undefined)
    })
    expect(scriptingOptionsFrom(defaultSettings)).toEqual(defaultScriptingOptions)
    expect(scriptingOptionsFrom({ ...defaultSettings, 'objectExplorer.scripting.scriptUseDatabase': false }).scriptUseDatabase).toBe(false)
  })
  it('shows a setting only on its platforms, and never a hidden one', () => {
    const base = { page: 'environment.general', label: 'Fixture', description: 'A fixture.', type: 'boolean', default: false } as const
    const fixtures: SettingDef[] = [{ ...base, key: 'fixture.everywhere' }, { ...base, key: 'fixture.windows', platforms: ['win32'] }, { ...base, key: 'fixture.hidden', hidden: true }]
    expect(visibleSettings('win32', fixtures).map(def => def.key)).toEqual(['fixture.everywhere', 'fixture.windows'])
    expect(visibleSettings('darwin', fixtures).map(def => def.key)).toEqual(['fixture.everywhere'])
    expect(visibleSettings('linux').length).toBe(settingDefs.length)
  })
  it('names a key or modifier in a description shown on every platform only with what macOS uses', () => {
    // macOS has no Alt+Z for Word Wrap, and its Monaco copies a drag with Option, not Ctrl.
    const keyed = [...settingDefs, ...settingPages].filter(item => /\b(Ctrl|Alt)\b/.test(item.description ?? '') && !('platforms' in item && item.platforms))
    expect(keyed.filter(item => !/macOS|Windows and Linux/.test(item.description ?? '')).map(item => 'key' in item ? item.key : item.id)).toEqual([])
    expect(keyed.length).toBeGreaterThan(0)
  })
  it('titles Select Top Rows from its setting, and leaves other commands and invalid values alone', () => {
    expect(commandTitle('explorer.selectTopRows')).toBe('Select Top 1000 Rows')
    expect(commandTitle('explorer.selectTopRows', { ...defaultSettings, 'objectExplorer.selectTopRows': 50 })).toBe('Select Top 50 Rows')
    expect(commandTitle('explorer.selectTopRows', { ...defaultSettings, 'objectExplorer.selectTopRows': 'x' as unknown as number })).toBe('Select Top 1000 Rows')
    expect(commandTitle('file.save', { ...defaultSettings, 'objectExplorer.selectTopRows': 50 })).toBe('Save')
  })
  it('keeps docs/settings.md in sync', async () => {
    await expect(renderSettingsDocs()).toMatchFileSnapshot('../docs/settings.md')
  })
})
