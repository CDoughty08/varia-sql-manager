import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  actionCommandEntries, actionContextKey, actionContextValues, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenuState, actionOffered, actionRow,
  actionsCatalogJson, dialogIds, dialogSpecs, dialogTitle, objectActions, objectActionSpecs, scriptActionTitles, unknownOutcomeMessage
} from '../src/shared/actions/catalog'
import { maxScriptCharacters } from '../src/main/validation'
import { renderObjectActionsDocs } from '../src/shared/actions/docs'
import { commandDescriptor, commandIds, isCommandId } from '../src/shared/commands/catalog'
import { isIconId } from '../src/shared/icons'
import { whenProblems } from '../src/shared/commands/context-keys'
import { findConflicts } from '../src/shared/commands/conflicts'
import { defaultRules, platforms, reservedReason } from '../src/shared/commands/keybindings'
import { buildMenuModel } from '../src/shared/commands/menus'
import { kindSpecs, nodeKinds, type NodeKind, type NodeSubtype } from '../src/shared/explorer/catalog'
import { scriptDestinations } from '../src/shared/scripting/catalog'

const every = (kind: NodeKind) => [undefined, ...kindSpecs[kind].subtypes ?? []] as (NodeSubtype | undefined)[]
const states = (kind: NodeKind, subtype?: NodeSubtype) => objectActions.map(action => actionMenuState({ kind, subtype })[action] || '-').join(' ')

describe('object action catalogue', () => {
  it('declares rows only for kinds and subtypes Object Explorer has', () => {
    for (const kind of nodeKinds) {
      const spec = actionKindSpecs[kind]
      if (!spec) continue
      for (const subtype of Object.keys(spec.subtypes ?? {})) expect(kindSpecs[kind].subtypes, `${kind} ${subtype}`).toContain(subtype)
    }
    expect(Object.keys(actionKindSpecs).sort()).toEqual(['database', 'function', 'procedure', 'table', 'view'])
    expect(actionRow('table', 'clr' as NodeSubtype)).toBeUndefined()
    expect(actionMenuState({ kind: 'folder' })).toEqual({ selectTop: '', rename: '', delete: '', properties: '' })
    expect(actionMenuState({ kind: 'login' })).toEqual({ selectTop: '', rename: '', delete: '', properties: '' })
  })
  it('offers SSMS\'s actions per kind, greying SQL Server\'s own objects and the subtypes that need more handling', () => {
    expect(states('table')).toBe('enabled enabled enabled -')
    for (const subtype of ['graphNode', 'graphEdge'] as const) expect(states('table', subtype), subtype).toBe('enabled enabled enabled -')
    for (const subtype of ['system', 'systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'ledgerHistory', 'fileTable', 'external'] as const) {
      expect(states('table', subtype), subtype).toBe('enabled disabled disabled -')
    }
    expect(states('table', 'droppedLedger')).toBe('- disabled disabled -')
    expect(states('view')).toBe('enabled enabled enabled -')
    for (const subtype of ['system', 'ledger'] as const) expect(states('view', subtype), subtype).toBe('enabled disabled disabled -')
    expect(states('view', 'droppedLedger')).toBe('- disabled disabled -')
    for (const subtype of [undefined, 'sql', 'clr'] as const) expect(states('procedure', subtype), String(subtype)).toBe('- enabled enabled -')
    for (const subtype of ['system', 'extended', 'replicationFilter'] as const) expect(states('procedure', subtype), subtype).toBe('- disabled disabled -')
    for (const subtype of every('function').filter(subtype => subtype !== 'aggregate')) expect(states('function', subtype), String(subtype)).toBe('- enabled enabled -')
    expect(states('function', 'aggregate')).toBe('- enabled disabled -')
    // Properties opens for every database, SQL Server's own and snapshots included, as in SSMS.
    expect([states('database'), states('database', 'system'), states('database', 'snapshot')]).toEqual(['- enabled enabled enabled', '- disabled disabled enabled', '- disabled enabled enabled'])
    expect(nodeKinds.filter(kind => actionOffered(kind, 'properties'))).toEqual(['database'])
    expect(actionOffered('database', 'rename') && actionOffered('function', 'delete') && !actionOffered('login', 'delete') && !actionOffered('procedure', 'selectTop')).toBe(true)
  })
  it('publishes one context key per action', () => {
    expect(objectActions.map(actionContextKey)).toEqual(['explorerActionSelectTop', 'explorerActionRename', 'explorerActionDelete', 'explorerActionProperties'])
    expect(actionContextValues(actionMenuState({ kind: 'database', subtype: 'snapshot' }))).toEqual({ explorerActionSelectTop: '', explorerActionRename: 'disabled', explorerActionDelete: 'enabled', explorerActionProperties: 'enabled' })
  })
  it('generates the four commands, keeping explorer.selectTopRows, with valid keys, preconditions and placements', () => {
    const entries = actionCommandEntries()
    expect(Object.keys(entries)).toEqual(objectActions.map(action => objectActionSpecs[action].command))
    expect(Object.keys(entries)).toContain('explorer.selectTopRows')
    expect(new Set(commandIds).size).toBe(commandIds.length)
    for (const [id, entry] of Object.entries(entries)) {
      expect(isCommandId(id), id).toBe(true)
      expect(commandDescriptor(id as never)).toEqual(entry)
      expect(isIconId(entry.icon), id).toBe(true)
      expect(whenProblems(entry.precondition, ['static', 'state']), id).toEqual([])
      for (const placement of entry.menus) expect(whenProblems(placement.when, ['static', 'state', 'target']), id).toEqual([])
      for (const binding of entry.keybindings ?? []) expect(whenProblems(binding.when, ['static', 'state', 'focus']), id).toEqual([])
    }
    expect(entries['explorer.selectTopRows']).toMatchObject({ title: 'Select Top 1000 Rows', titleSetting: { setting: 'objectExplorer.selectTopRows', template: 'Select Top {n} Rows' },
      precondition: "backendReady && explorerActionSelectTop == 'enabled' && !documentBusy" })
    expect(entries['explorer.rename'].precondition).toBe("backendReady && explorerActionRename == 'enabled'")
    expect(entries['explorer.properties']).toMatchObject({ title: 'Properties', icon: 'settings-gear', unavailableHint: 'Select a database in Object Explorer.',
      precondition: "backendReady && explorerActionProperties == 'enabled'", menus: [{ menu: 'explorer.context', group: '9_properties', order: 1, mnemonic: 'p' }] })
  })
  it('binds Properties to ⌘I on macOS only: Alt+Enter stays reserved on Windows and Linux, where it has no key', () => {
    for (const platform of platforms) {
      const rules = defaultRules(platform).filter(rule => rule.command === 'explorer.properties')
      expect(rules.map(rule => rule.chords.join(' ')), platform).toEqual(platform === 'darwin' ? ['meta+i'] : [])
      for (const rule of rules) expect([rule.whenSource, reservedReason(rule.chords[0], platform)]).toEqual(["activePanel == 'explorer' && !textInputFocus", undefined])
      expect(reservedReason('alt+enter', platform) !== undefined, platform).toBe(platform !== 'darwin')
    }
  })
  it('binds F2 and Delete (⌘⌫ and Delete on macOS) only in Object Explorer, without conflicts, and no Alt+Enter', () => {
    for (const platform of platforms) {
      const rules = defaultRules(platform).filter(rule => rule.command === 'explorer.rename' || rule.command === 'explorer.delete')
      expect(rules.map(rule => [rule.command, rule.chords.join(' ')]), platform).toEqual(platform === 'darwin'
        ? [['explorer.rename', 'f2'], ['explorer.delete', 'meta+backspace'], ['explorer.delete', 'delete']]
        : [['explorer.rename', 'f2'], ['explorer.delete', 'delete']])
      for (const rule of rules) {
        expect(rule.whenSource).toBe("activePanel == 'explorer' && !textInputFocus")
        expect(reservedReason(rule.chords[0], platform), `${rule.chords[0]} on ${platform}`).toBeUndefined()
      }
      expect(findConflicts(defaultRules(platform), platform), platform).toEqual([])
      expect(defaultRules(platform).some(rule => rule.chords[0] === 'alt+enter' && !rule.native), platform).toBe(false)
    }
  })
  it('places Rename and Delete in their own group of Object Explorer\'s menu, and a submenu of nothing hidden stays out', () => {
    const model = buildMenuModel('explorer.context', 'win32')
    const ids = model.flatMap(entry => entry.kind === 'command' ? [entry.id] : entry.kind === 'separator' ? ['---'] : [])
    const at = (id: string) => ids.indexOf(id)
    expect(at('explorer.copyName') < at('explorer.rename') && at('explorer.rename') + 1 === at('explorer.delete') && ids[at('explorer.delete') + 1] === '---' && at('explorer.delete') < at('explorer.refresh')).toBe(true)
    expect(ids[at('explorer.newQuery') + 1]).toBe('explorer.selectTopRows')
    // Properties is the last item, after Refresh in its own group, as in SSMS.
    expect(ids.slice(at('explorer.refresh'))).toEqual(['explorer.refresh', '---', 'explorer.properties'])
  })
  it('declares Delete Object and Database Properties with SSMS\'s titles, pages and Script button wording', () => {
    expect(dialogIds).toEqual(['deleteObject', 'databaseProperties'])
    expect(dialogSpecs.deleteObject).toEqual({ title: 'Delete Object', titleFormat: 'plain', size: 'compact', action: 'delete', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] })
    expect(dialogSpecs.databaseProperties).toMatchObject({ title: 'Database Properties', titleFormat: 'withName', size: 'large', action: 'properties' })
    expect(dialogSpecs.databaseProperties.pages.map(page => [page.id, page.title, page.icon])).toEqual([['general', 'General', 'settings-gear'], ['files', 'Files', 'settings-gear'],
      ['filegroups', 'Filegroups', 'settings-gear'], ['options', 'Options', 'settings-gear']])
    expect([dialogTitle('databaseProperties', 'AppData'), dialogTitle('deleteObject', 'dbo.Orders')]).toEqual(['Database Properties - AppData', 'Delete Object'])
    for (const dialog of dialogIds) expect(objectActionSpecs[dialogSpecs[dialog].action].dialog).toBe(dialog)
    expect(scriptDestinations.map(destination => scriptActionTitles[destination])).toEqual(['Script Action to New Query Window', 'Script Action to File', 'Script Action to Clipboard'])
    expect(unknownOutcomeMessage).toBe('The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('keeps the limits and error codes', () => {
    expect(actionLimits).toMatchObject({ describeMs: 40_000, scriptMs: 25_000, readPerConnection: 2, readTotal: 4, executePerConnection: 1, executeTotal: 2, registered: 128, cancelIds: 16, newName: 128,
      files: 1_024, filegroups: 256, logins: 1_024, collations: 8_192, statements: 512, scriptChars: 1_000_000 })
    // A scripted action always fits a query window, so Script Action to New Query Window can always run it.
    expect(actionLimits.scriptChars).toBeLessThanOrEqual(maxScriptCharacters)
    expect(actionErrorCodes.filter(code => !actionErrorRetryable[code])).toEqual(['NOT_FOUND', 'NOT_SUPPORTED', 'DEPENDENTS', 'NAME_IN_USE'])
  })
  it('lists only error codes the backend produces, so a renderer branch on one can be reached', () => {
    const backend = ['ActionService.cs', 'ActionErrors.cs'].map(name => readFileSync(join('backend', 'Varia.Backend', 'Actions', name), 'utf8')).join('\n')
    // Each code appears as a C# string literal: ActionErrors.Numbers, an Error(...) or Create(...) call, or (AUTH_*) the sign-in's codes.
    expect(actionErrorCodes.filter(code => !backend.includes(`"${code}"`))).toEqual([])
  })
  it('loads in plain Node 24, as the fake backend and scripts load the other catalogues', () => {
    const files = ['catalog.ts', 'database.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'actions', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('keeps the backend\'s embedded copy and docs/object-actions.md in sync', async () => {
    await expect(actionsCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Actions/actions-catalog.json')
    await expect(renderObjectActionsDocs()).toMatchFileSnapshot('../docs/object-actions.md')
  })
})
