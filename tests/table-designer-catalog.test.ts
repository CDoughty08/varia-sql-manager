import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commandDescriptor, isCommandId } from '../src/shared/commands/catalog'
import { isIconId } from '../src/shared/icons'
import { whenProblems } from '../src/shared/commands/context-keys'
import { findConflicts } from '../src/shared/commands/conflicts'
import { defaultRules, platforms } from '../src/shared/commands/keybindings'
import { buildMenuModel } from '../src/shared/commands/menus'
import {
  bracketName, columnPropertySpecs, defaultNewType, defaultTableName, designerCaption, designerCatalogJson, designerCommandEntries, designerDescribeIds, designerLimits, designerRequestActions,
  designerToolbar, isBareName, primaryKeyName, reservedKeywords, scriptName, systemTypes, tablePropertySpecs, type DesignerCommandId
} from '../src/shared/designer/catalog'
import { renderTableDesignerDocs } from '../src/shared/designer/docs'
import { describeIds } from '../src/shared/actions/schema'
import { dialogIds } from '../src/shared/actions/catalog'
import { maxScriptCharacters } from '../src/main/validation'

describe('table designer catalogue', () => {
  it('lists SSMS\'s data types in order with their list defaults, json and vector from SQL Server 2025', () => {
    expect(systemTypes.filter(type => !type.unlisted).map(type => type.name)).toEqual([
      'bigint', 'binary', 'bit', 'char', 'date', 'datetime', 'datetime2', 'datetimeoffset', 'decimal', 'float', 'geography', 'geometry', 'hierarchyid', 'image', 'int', 'json', 'money', 'nchar', 'ntext',
      'numeric', 'nvarchar', 'real', 'smalldatetime', 'smallint', 'smallmoney', 'sql_variant', 'sysname', 'text', 'time', 'timestamp', 'tinyint', 'uniqueidentifier', 'varbinary', 'varchar', 'xml'
    ])
    expect(systemTypes.filter(type => type.since !== undefined).map(type => [type.name, type.since])).toEqual([['json', 17], ['vector', 17]])
    expect(systemTypes.filter(type => type.unlisted).map(type => type.name)).toEqual(['vector'])
    expect(systemTypes.filter(type => type.listMax).map(type => type.name)).toEqual(['nvarchar', 'varbinary', 'varchar'])
    expect(systemTypes.filter(type => type.identity).map(type => type.name)).toEqual(['bigint', 'decimal', 'int', 'numeric', 'smallint', 'tinyint'])
    expect(systemTypes.filter(type => type.lob).map(type => type.name)).toEqual(['geography', 'geometry', 'image', 'json', 'ntext', 'text', 'xml'])
    expect(defaultNewType).toEqual({ system: 'nchar', length: 10 })
  })
  it('labels Column Properties and Properties as SSMS does, children under their parent', () => {
    expect(columnPropertySpecs.map(spec => `${spec.category}: ${spec.label}`)).toEqual([
      'General: (Name)', 'General: Allow Nulls', 'General: Data Type', 'General: Length', 'General: Precision', 'General: Scale', 'Table Designer: Identity Specification',
      'Table Designer: (Is Identity)', 'Table Designer: Identity Increment', 'Table Designer: Identity Seed'
    ])
    expect(columnPropertySpecs.filter(spec => spec.parent).every(spec => spec.parent === 'identitySpecification')).toBe(true)
    expect(tablePropertySpecs.map(spec => spec.label)).toEqual(['(Name)', 'Database Name', 'Schema', 'Server Name', 'Identity Column', 'Regular Data Space Specification'])
  })
  it('brackets reserved keywords, GO and irregular names in scripts, as SSMS does', () => {
    expect(reservedKeywords).toContain('SELECT')
    expect(reservedKeywords).toContain('TABLE')
    expect(reservedKeywords).not.toContain('GO')
    expect(['dbo', '_x1', 'a$', 'Table_1', 'x@y#'].every(isBareName)).toBe(true)
    expect(['select', 'Select', 'GO', 'go', 'a b', '1a', '@x', '#t', 'a]b', 'Ünïcode', '', 'TRY_CONVERT'].some(isBareName)).toBe(false)
    expect(scriptName('a]b')).toBe('[a]]b]')
    expect(bracketName('dbo')).toBe('[dbo]')
    expect(primaryKeyName('Orders')).toBe('PK_Orders')
    expect(primaryKeyName('t'.repeat(125) + '\u{1F600}')).toBe('PK_' + 't'.repeat(125))
    expect(defaultTableName(3)).toBe('Table_3')
    expect(designerCaption('srv', 'AppData', 'dbo', 'Table_1')).toBe('srv.AppData - dbo.Table_1')
    expect(designerCaption('s'.repeat(600), 'db', 'dbo', 'T').length).toBe(designerLimits.captionChars)
  })
  it('keeps its describe and request ids out of the object-action catalogue but in the describe schema', () => {
    expect(designerDescribeIds).toEqual(['tableDesigner'])
    expect(designerRequestActions).toEqual(['createTable'])
    expect(describeIds).toEqual([...dialogIds, 'tableDesigner'])
    expect(designerLimits.scriptChars).toBe(maxScriptCharacters)
  })
  it('generates commands with valid preconditions, menus and keys, F4 only inside a designer', () => {
    const entries = designerCommandEntries()
    for (const [id, entry] of Object.entries(entries) as [DesignerCommandId, ReturnType<typeof designerCommandEntries>[DesignerCommandId]][]) {
      expect(isCommandId(id), id).toBe(true)
      expect(commandDescriptor(id).title).toBe(entry.title)
      expect(whenProblems(entry.precondition, ['static', 'state']), id).toEqual([])
      for (const menu of entry.menus ?? []) if (menu.when) expect(whenProblems(menu.when, ['static', 'state', 'target']), id).toEqual([])
      for (const binding of entry.keybindings ?? []) expect(whenProblems(binding.when, ['static', 'state', 'focus']), id).toEqual([])
      if (entry.icon) expect(isIconId(entry.icon), id).toBe(true)
    }
    expect(entries['tableDesigner.properties'].keybindings).toEqual([{ key: 'f4', when: 'designerFocus' }])
    expect(entries['tableDesigner.stop'].precondition).toBe('designerSaving')
    expect(designerToolbar.every(id => entries[id].category === 'Table Designer')).toBe(true)
    for (const platform of platforms) expect(findConflicts(defaultRules(platform), platform).filter(conflict => conflict.chord.includes('f4'))).toEqual([])
  })
  it('places New › Table… only on the Tables folder, and the designer menu\'s access keys are unique', () => {
    for (const platform of platforms) {
      const context = buildMenuModel('tableDesigner.context', platform).flatMap(entry => entry.kind === 'command' ? [entry] : [])
      expect(context.map(entry => entry.id)).toEqual(['tableDesigner.setPrimaryKey', 'tableDesigner.removePrimaryKey', 'tableDesigner.insertColumn', 'tableDesigner.deleteColumn', 'tableDesigner.generateChangeScript', 'tableDesigner.properties'])
      // Set and Remove Primary Key share Y, one shown at a time, as SSMS's one item toggles.
      expect(new Set(context.filter(entry => !entry.when).map(entry => entry.mnemonic)).size).toBe(context.filter(entry => !entry.when).length)
      expect(buildMenuModel('explorer.new', platform).map(entry => entry.kind === 'command' ? [entry.id, entry.title, entry.mnemonic] : [])).toEqual([['explorer.newTable', 'Table…', 't']])
    }
  })
  it('loads in plain Node 24, as the fake backend loads the other catalogues', () => {
    const files = ['catalog.ts', 'schema.ts', 'type-text.ts', 'docs.ts'].map(name => join('src', 'shared', 'designer', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('keeps the backend\'s embedded copy and docs/table-designer.md in sync', async () => {
    await expect(designerCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Designer/designer-catalog.json')
    await expect(renderTableDesignerDocs()).toMatchFileSnapshot('../docs/table-designer.md')
  })
})
