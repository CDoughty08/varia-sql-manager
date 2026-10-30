import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  actionCommandEntries, actionContextKey, actionContextValues, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenuState, actionOffered, actionRow,
  actionsCatalogJson, actionStatuses, databaseActionState, databaseStateOf, dialogIds, dialogSpecs, dialogTitle, isModalDialog, objectActions, objectActionSpecs, offeredOnEngine, overlayRow,
  pageIds, propertiesCommandEntries, scriptActionTitles, unknownOutcomeMessage, type ActionCommandId, type DatabaseActionRule, type ModalDialogId, type PageId
} from '../src/shared/actions/catalog'
import { currentDatabaseRuntime } from '../src/shared/explorer/status'
import { contextRecord } from '../src/shared/commands/context-keys'
import { resolveMenu, type ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import type { MenuEntry, MenuId } from '../src/shared/commands/menus'
import { maxScriptCharacters } from '../src/main/validation'
import { renderObjectActionsDocs } from '../src/shared/actions/docs'
import { commandDescriptor, commandIds, isCommandId } from '../src/shared/commands/catalog'
import { isIconId } from '../src/shared/icons'
import { whenProblems } from '../src/shared/commands/context-keys'
import { findConflicts } from '../src/shared/commands/conflicts'
import { defaultRules, platforms, reservedReason } from '../src/shared/commands/keybindings'
import { buildMenuModel, submenus } from '../src/shared/commands/menus'
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
  it('declares the Database Properties document\'s verbs as catalogue commands over its own state keys, with no keys or menus of their own', () => {
    const entries = propertiesCommandEntries()
    expect(Object.keys(entries)).toEqual(['databaseProperties.apply', 'databaseProperties.discard', 'databaseProperties.refresh', 'databaseProperties.stop'])
    for (const [id, entry] of Object.entries(entries)) {
      expect(isCommandId(id), id).toBe(true)
      expect(commandDescriptor(id as never)).toEqual(entry)
      expect(isIconId(entry.icon), id).toBe(true)
      expect(entry.precondition, id).toMatch(/^activeDocumentIsProperties && /)
      expect(whenProblems(entry.precondition, ['static', 'state']), id).toEqual([])
      expect(commandDescriptor(id as never).keybindings, id).toBeUndefined()
    }
    // Stop must work while the close prompt's Save (an Apply) holds the document task.
    expect(entries['databaseProperties.stop'].precondition).not.toContain('documentBusy')
    expect(entries['databaseProperties.apply']).toMatchObject({ title: 'Apply Changes', icon: 'check', precondition: 'activeDocumentIsProperties && propertiesApplicable' })
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
    // Properties is the last item, after Refresh in its own group, as in SSMS; an SSIS Catalog object's Properties takes its place.
    expect(ids.slice(at('explorer.refresh'))).toEqual(['explorer.refresh', '---', 'explorer.properties', 'ssis.folderProperties', 'ssis.projectProperties', 'ssis.packageProperties', 'ssis.environmentProperties'])
  })
  it('declares Delete Object and Database Properties with SSMS\'s titles, pages and Script button wording', () => {
    expect(dialogIds).toEqual(['deleteObject', 'databaseProperties'])
    expect(dialogSpecs.deleteObject).toEqual({ title: 'Delete Object', surface: 'modal', titleFormat: 'plain', size: 'compact', action: 'delete', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] })
    expect(dialogSpecs.databaseProperties).toMatchObject({ title: 'Database Properties', surface: 'document', titleFormat: 'withName', size: 'large', action: 'properties' })
    expect(dialogSpecs.databaseProperties.pages.map(page => [page.id, page.title, page.icon])).toEqual([['general', 'General', 'settings-gear'], ['files', 'Files', 'settings-gear'],
      ['filegroups', 'Filegroups', 'settings-gear'], ['options', 'Options', 'settings-gear']])
    expect([dialogTitle('databaseProperties', 'AppData'), dialogTitle('deleteObject', 'dbo.Orders')]).toEqual(['Database Properties - AppData', 'Delete Object'])
    for (const dialog of dialogIds) expect(objectActionSpecs[dialogSpecs[dialog].action].dialog).toBe(dialog)
    // Delete Object is a confirmation, so it stays modal; Database Properties opens as a document (U1 D2).
    expect(dialogIds.filter(isModalDialog)).toEqual(['deleteObject'])
    expect(scriptDestinations.map(destination => scriptActionTitles[destination])).toEqual(['Script Action to New Query Window', 'Script Action to File', 'Script Action to Clipboard'])
    expect(unknownOutcomeMessage).toBe('The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('derives the action command, modal dialog and page ids from the catalogue, with registry icons on every page', () => {
    expectTypeOf<ActionCommandId>().toEqualTypeOf<'explorer.selectTopRows' | 'explorer.rename' | 'explorer.delete' | 'explorer.properties'>()
    expectTypeOf<ModalDialogId>().toEqualTypeOf<'deleteObject'>()
    expectTypeOf<PageId>().toEqualTypeOf<'general' | 'files' | 'filegroups' | 'options'>()
    expect(pageIds).toEqual(['general', 'files', 'filegroups', 'options'])
    for (const dialog of dialogIds) for (const page of dialogSpecs[dialog].pages) {
      expect(isIconId(page.icon), `${dialog}: ${page.id}`).toBe(true)
      expect(pageIds, dialog).toContain(page.id)
    }
    expect(new Set(objectActions.map(action => objectActionSpecs[action].command)).size).toBe(objectActions.length)
  })
  it('overlays a status\'s row on the subtype\'s: named actions take its state, and \'\' takes one away', () => {
    expect(overlayRow({ rename: 'enabled', delete: 'enabled' }, { delete: '', properties: 'enabled' })).toEqual({ rename: 'enabled', properties: 'enabled' })
    expect(overlayRow({ rename: 'enabled' }, { rename: 'disabled' })).toEqual({ rename: 'disabled' })
    expect(overlayRow({ rename: 'enabled' }, undefined)).toEqual({ rename: 'enabled' })
    // As a kind will declare one: the overlay applies to the subtype's row, for that status only.
    const specs = { database: { row: { rename: 'enabled', delete: 'enabled' }, subtypes: { system: { rename: 'disabled' } }, statuses: { unavailable: { delete: 'disabled', properties: '' }, readOnly: { properties: 'enabled' } } } } as const
    expect(actionRow('database', undefined, 'unavailable', specs)).toEqual({ rename: 'enabled', delete: 'disabled' })
    expect(actionRow('database', 'system', 'readOnly', specs)).toEqual({ rename: 'disabled', properties: 'enabled' })
    expect(actionRow('database', undefined, 'noAccess', specs)).toEqual({ rename: 'enabled', delete: 'enabled' })
    // No kind has an overlay yet, so a status leaves every row as it is, and the menu keys with it.
    for (const kind of nodeKinds) {
      expect(actionStatuses(kind), kind).toEqual([])
      for (const status of ['disabled', 'unavailable', 'readOnly', 'noAccess'] as const) expect(actionRow(kind, undefined, status), kind).toEqual(actionRow(kind))
    }
    expect(actionMenuState({ kind: 'database', status: 'unavailable' })).toEqual(actionMenuState({ kind: 'database' }))
    expect(actionMenuState({ kind: 'database', status: 'bogus' as never })).toEqual(actionMenuState({ kind: 'database' }))
  })
  it('narrows a database\'s row by its runtime state with the first rule that applies, and leaves it when the state is unknown', () => {
    const rules: DatabaseActionRule[] = [
      { action: 'rename', states: ['offline', 'restoring'], reason: 'The database must be online to be renamed.' },
      { action: 'delete', states: ['restoring'], hide: true, reason: 'Wait until it finishes restoring.' },
      { action: 'delete', readOnly: true, reason: 'Read-only.' },
      { action: 'properties', access: ['single'], reason: 'Single user.' },
      { action: 'properties', states: ['other'], reason: 'Unknown state.' }
    ]
    const row = { rename: 'enabled', delete: 'enabled', properties: 'enabled', selectTop: 'disabled' } as const
    const online = { state: 0, userAccess: 0, readOnly: false, standby: false }
    expect(databaseActionState(row, undefined, rules)).toEqual({ row, reasons: {} })
    expect(databaseActionState(row, online, rules)).toEqual({ row, reasons: {} })
    expect(databaseActionState(row, { ...online, state: 6 }, rules)).toEqual({ row: { ...row, rename: 'disabled' }, reasons: { rename: 'The database must be online to be renamed.' } })
    // A hidden action leaves the row; a disabled one stays as it is, with no reason.
    expect(databaseActionState(row, { ...online, state: 1 }, rules).row).toEqual({ rename: 'disabled', properties: 'enabled', selectTop: 'disabled' })
    expect(databaseActionState(row, { ...online, standby: true }, rules).row).toMatchObject({ delete: 'disabled' })
    expect(databaseActionState(row, { ...online, userAccess: 1, state: 42 }, rules).reasons).toEqual({ properties: 'Single user.' })
    expect([0, 1, 2, 3, 4, 5, 6, 7, 10, 8, 99].map(databaseStateOf)).toEqual(['online', 'restoring', 'recovering', 'recoveryPending', 'suspect', 'emergency', 'offline', 'copying', 'offlineSecondary', 'other', 'other'])
    // With no rules yet, a runtime changes nothing.
    expect(actionMenuState({ kind: 'database', database: { ...online, state: 6 } })).toEqual(actionMenuState({ kind: 'database' }))
  })
  it('offers an action with engines only on those servers, and everywhere when the engine is unknown', () => {
    expect(offeredOnEngine(undefined, 'cloud')).toBe(true)
    expect(offeredOnEngine(['box', 'managedInstance'], undefined)).toBe(true)
    expect(offeredOnEngine(['box', 'managedInstance'], 'managedInstance')).toBe(true)
    expect(offeredOnEngine(['box'], 'cloud')).toBe(false)
    for (const engine of ['box', 'managedInstance', 'cloud'] as const) expect(actionMenuState({ kind: 'table', engine }), engine).toEqual(actionMenuState({ kind: 'table' }))
  })
  it('takes a live sample over the listing only when it is newer, and reads a newer sample without a row as plainly online', () => {
    const listed = { state: 6, userAccess: 0, readOnly: false, standby: false }
    const row = { name: 'Sales', state: 1, userAccess: 1, readOnly: true, standby: false }
    expect(currentDatabaseRuntime(listed, 1_000)).toBe(listed)
    expect(currentDatabaseRuntime(listed, 1_000, { at: 1_000, row })).toBe(listed)
    expect(currentDatabaseRuntime(listed, 1_000, { at: 1_001, row })).toEqual({ state: 1, userAccess: 1, readOnly: true, standby: false })
    expect(currentDatabaseRuntime(listed, 1_000, { at: 2_000, row: undefined })).toEqual({ state: 0, userAccess: 0, readOnly: false, standby: false })
    expect(currentDatabaseRuntime(undefined, undefined, { at: 5, row })).toMatchObject({ state: 1 })
    expect(currentDatabaseRuntime(undefined, undefined)).toBeUndefined()
  })
  it('declares the database node\'s Tasks and Tasks › Restore submenus, hidden while nothing is placed in them', () => {
    const state = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionKind: 'database', ...actionContextValues(actionMenuState({ kind: 'database' })) })
    const commands = { isEnabled: () => true, isToggled: () => false }, keybindings = { lookup: () => undefined }
    const titles = (items: readonly ResolvedMenuItem[]): string[] => items.flatMap(item => item.kind === 'submenu' ? [item.title + ' >', ...titles(item.items).map(title => '  ' + title)] : item.kind === 'command' ? [item.title] : [])
    const resolve = (model?: (menu: MenuId) => readonly MenuEntry[], lost = false) =>
      titles(resolveMenu('explorer.context', { platform: 'win32', state, target: { explorerNode: 'database', explorerServerLost: lost }, commands, keybindings, ...model ? { model } : {} }))
    expect(resolve().some(title => title.startsWith('Tasks'))).toBe(false)
    // A later PR places Restore › Database… in it: Tasks › Restore › appears on a database, not on a lost server's.
    const item: MenuEntry = { kind: 'command', id: 'explorer.properties', nativeId: 'test.restoreDatabase', title: 'Database…', mnemonic: 'd', toggle: false }
    const model = (menu: MenuId) => menu === 'explorer.tasks.restore' ? [item] : buildMenuModel(menu, 'win32')
    const shown = resolve(model)
    expect(shown.slice(shown.indexOf('Tasks >'), shown.indexOf('Tasks >') + 3)).toEqual(['Tasks >', '  Restore >', '    Database…'])
    expect(resolve(model, true).some(title => title.startsWith('Tasks'))).toBe(false)
    // docs/object-actions.md names them as the menus do (its generator loads in plain Node, without menus.ts).
    expect(renderObjectActionsDocs()).toContain(`${submenus['explorer.tasks'].title} (\`explorer.tasks\`) and ${submenus['explorer.tasks'].title} › ${submenus['explorer.tasks.restore'].title} (\`explorer.tasks.restore\`)`)
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
