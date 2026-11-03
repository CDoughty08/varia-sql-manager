import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  actionCommandEntries, actionContextKey, actionContextValues, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenuState, actionOffered, actionRow,
  actionsCatalogJson, actionStatuses, createActionSpecs, databaseActionState, databaseStateOf, dialogIds, dialogSpecs, dialogTitle, isCreateAction, isModalDialog, objectActions, objectActionSpecs, offeredOnEngine, overlayRow,
  isServerAction, newDatabaseCommandEntries, pageIds, propertiesCommandEntries, serverActionCommandEntries, serverActions, serverActionSpecs, scriptActionTitles, unknownOutcomeMessage, type ActionCommandId, type DatabaseActionRule, type ModalDialogId, type PageId
} from '../src/shared/actions/catalog'
import { currentDatabaseRuntime } from '../src/shared/explorer/status'
import { contextRecord } from '../src/shared/commands/context-keys'
import { resolveMenu, type ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import type { MenuEntry, MenuId } from '../src/shared/commands/menus'
import { maxScriptCharacters } from '../src/main/validation'
import { serverFilesDeadlineMs } from '../src/shared/ipc/methods'
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
/** The context menu's row actions (Select Top, Rename, Delete and Properties); a folder's actions (Attach, Restore Database) are not a
 *  row's own items, and a database's Tasks (Take Offline, Bring Online, and Restore › Database…, Restore Database's `rows`) are `tasks`. */
const states = (kind: NodeKind, subtype?: NodeSubtype) => objectActions.filter(action => !objectActionSpecs[action].folder && !objectActionSpecs[action].menu).map(action => actionMenuState({ kind, subtype })[action] || '-').join(' ')
const tasks = (kind: NodeKind, subtype?: NodeSubtype) => (['takeOffline', 'bringOnline', 'restore'] as const).map(action => actionMenuState({ kind, subtype })[action] || '-').join(' ')
const none = { selectTop: '', rename: '', delete: '', properties: '', attach: '', takeOffline: '', bringOnline: '', restore: '' }
const online = { state: 0, userAccess: 0, readOnly: false, standby: false }

describe('object action catalogue', () => {
  it('declares rows only for kinds and subtypes Object Explorer has', () => {
    for (const kind of nodeKinds) {
      const spec = actionKindSpecs[kind]
      if (!spec) continue
      for (const subtype of Object.keys(spec.subtypes ?? {})) expect(kindSpecs[kind].subtypes, `${kind} ${subtype}`).toContain(subtype)
    }
    expect(Object.keys(actionKindSpecs).sort()).toEqual(['database', 'function', 'procedure', 'table', 'view'])
    expect(actionRow('table', 'clr' as NodeSubtype)).toBeUndefined()
    expect(actionMenuState({ kind: 'folder' })).toEqual(none)
    expect(actionMenuState({ kind: 'login' })).toEqual(none)
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
    // Tasks › Take Offline, Bring Online and Restore › Database…: user databases only; greyed on SQL Server's own (as SSMS for the
    // state changes; critic A19 for a restore, which takes T-SQL there), absent on a snapshot, which cannot be restored over.
    expect([tasks('database'), tasks('database', 'system'), tasks('database', 'snapshot')]).toEqual(['enabled enabled enabled', 'disabled disabled disabled', '- - -'])
    expect(actionMenuState({ kind: 'database', engine: 'managedInstance' }).restore).toBe('')
    expect(nodeKinds.filter(kind => actionOffered(kind, 'restore'))).toEqual(['database'])
    for (const action of ['takeOffline', 'bringOnline'] as const) expect(nodeKinds.filter(kind => actionOffered(kind, action)), action).toEqual(['database'])
    expect(actionOffered('database', 'rename') && actionOffered('function', 'delete') && !actionOffered('login', 'delete') && !actionOffered('procedure', 'selectTop')).toBe(true)
  })
  it('publishes one context key per action', () => {
    expect(objectActions.map(actionContextKey)).toEqual(['explorerActionSelectTop', 'explorerActionRename', 'explorerActionDelete', 'explorerActionProperties', 'explorerActionAttach', 'explorerActionTakeOffline', 'explorerActionBringOnline', 'explorerActionRestore'])
    expect(actionContextValues(actionMenuState({ kind: 'database', subtype: 'snapshot' }))).toEqual({
      explorerActionSelectTop: '', explorerActionRename: 'disabled', explorerActionDelete: 'enabled', explorerActionProperties: 'enabled', explorerActionAttach: '', explorerActionTakeOffline: '', explorerActionBringOnline: '', explorerActionRestore: ''
    })
  })
  it('generates the action commands, keeping explorer.selectTopRows, with valid keys, preconditions and placements', () => {
    const entries = actionCommandEntries()
    // Restore's row placement (Tasks › Restore › Database…) is a command of its own, out of the palette: a context menu shows each command once.
    expect(Object.keys(entries)).toEqual([...objectActions.map(action => objectActionSpecs[action].command), 'explorer.tasks.restoreDatabase'])
    expect(entries['explorer.tasks.restoreDatabase']).toMatchObject({ title: 'Restore Database…', palette: false, precondition: entries['explorer.restoreDatabase'].precondition })
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
    expect(dialogIds).toEqual(['deleteObject', 'databaseProperties', 'newDatabase', 'attachDatabase', 'newLogin', 'takeOffline', 'bringOnline'])
    for (const dialog of ['takeOffline', 'bringOnline'] as const) {
      expect(dialogSpecs[dialog]).toEqual({ title: dialog === 'takeOffline' ? 'Take Database Offline' : 'Bring Database Online', surface: 'modal', titleFormat: 'withName', size: 'compact', action: dialog,
        pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }], steps: true })
    }
    expect(dialogTitle('takeOffline', 'SalesDb')).toBe('Take Database Offline - SalesDb')
    expect(dialogSpecs.deleteObject).toEqual({ title: 'Delete Object', surface: 'modal', titleFormat: 'plain', size: 'compact', action: 'delete', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] })
    expect(dialogSpecs.databaseProperties).toMatchObject({ title: 'Database Properties', surface: 'document', titleFormat: 'withName', size: 'large', action: 'properties' })
    expect(dialogSpecs.databaseProperties.pages.map(page => [page.id, page.title, page.icon])).toEqual([['general', 'General', 'settings-gear'], ['files', 'Files', 'settings-gear'],
      ['filegroups', 'Filegroups', 'settings-gear'], ['options', 'Options', 'settings-gear']])
    expect([dialogTitle('databaseProperties', 'AppData'), dialogTitle('deleteObject', 'dbo.Orders')]).toEqual(['Database Properties - AppData', 'Delete Object'])
    expect(dialogSpecs.newLogin).toMatchObject({ title: 'Login - New', surface: 'modal', titleFormat: 'plain', size: 'large', action: 'createLogin', steps: true })
    expect(dialogSpecs.newLogin.pages.map(page => [page.id, page.title, page.keepMounted ?? false])).toEqual([['general', 'General', true], ['serverRoles', 'Server Roles', false], ['status', 'Status', false]])
    expect(dialogTitle('newLogin', 'ignored')).toBe('Login - New')
    for (const dialog of dialogIds) {
      const action = dialogSpecs[dialog].action
      expect(isServerAction(action) ? serverActionSpecs[action].dialog : isCreateAction(action) ? createActionSpecs[action].dialog : objectActionSpecs[action].dialog).toBe(dialog)
    }
    // Delete Object is a confirmation, and Attach, New Login, Take Offline and Bring Online are dialogs (wave 5 decisions 1), so they
    // are modal; Database Properties opens as a document (U1 D2).
    expect(dialogIds.filter(isModalDialog)).toEqual(['deleteObject', 'attachDatabase', 'newLogin', 'takeOffline', 'bringOnline'])
    expect(scriptDestinations.map(destination => scriptActionTitles[destination])).toEqual(['Script Action to New Query Window', 'Script Action to File', 'Script Action to Clipboard'])
    expect(unknownOutcomeMessage).toBe('The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('derives the action command, modal dialog and page ids from the catalogue, with registry icons on every page', () => {
    expectTypeOf<ActionCommandId>().toEqualTypeOf<'explorer.selectTopRows' | 'explorer.rename' | 'explorer.delete' | 'explorer.properties' | 'explorer.attachDatabase' | 'explorer.takeOffline' | 'explorer.bringOnline' | 'explorer.restoreDatabase' | 'explorer.tasks.restoreDatabase'>()
    expectTypeOf<ModalDialogId>().toEqualTypeOf<'deleteObject' | 'attachDatabase' | 'newLogin' | 'takeOffline' | 'bringOnline'>()
    expectTypeOf<PageId>().toEqualTypeOf<'general' | 'files' | 'filegroups' | 'options' | 'serverRoles' | 'status'>()
    expect(pageIds).toEqual(['general', 'files', 'filegroups', 'options', 'serverRoles', 'status'])
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
    expect(databaseActionState(row, undefined, rules)).toEqual({ row, reasons: {} })
    expect(databaseActionState(row, online, rules)).toEqual({ row, reasons: {} })
    expect(databaseActionState(row, { ...online, state: 6 }, rules)).toEqual({ row: { ...row, rename: 'disabled' }, reasons: { rename: 'The database must be online to be renamed.' } })
    // A hidden action leaves the row; a disabled one stays as it is, with no reason.
    expect(databaseActionState(row, { ...online, state: 1 }, rules).row).toEqual({ rename: 'disabled', properties: 'enabled', selectTop: 'disabled' })
    expect(databaseActionState(row, { ...online, standby: true }, rules).row).toMatchObject({ delete: 'disabled' })
    expect(databaseActionState(row, { ...online, userAccess: 1, state: 42 }, rules).reasons).toEqual({ properties: 'Single user.' })
    expect([0, 1, 2, 3, 4, 5, 6, 7, 10, 8, 99].map(databaseStateOf)).toEqual(['online', 'restoring', 'recovering', 'recoveryPending', 'suspect', 'emergency', 'offline', 'copying', 'offlineSecondary', 'other', 'other'])
  })
  it('greys Take Offline and Bring Online by the database\'s state, with the reason the menu shows', () => {
    const at = (state: number) => { const { row, reasons } = databaseActionState(actionRow('database')!, { ...online, state }); return [row.takeOffline, row.bringOnline, reasons.takeOffline ?? '', reasons.bringOnline ?? ''] }
    expect(at(0)).toEqual(['enabled', 'disabled', '', 'The database is online.'])
    expect(at(6)).toEqual(['disabled', 'enabled', 'The database is offline.', ''])
    for (const state of [1, 2, 7]) expect(at(state), String(state)).toEqual(['disabled', 'disabled', 'A database that is restoring or recovering cannot be taken offline.', 'A database that is restoring or recovering cannot be brought online.'])
    // Bring Online tries recovery on the states SQL Server lets SET ONLINE act on (owner default 7).
    for (const state of [3, 4, 5, 99]) expect(at(state).slice(0, 2), String(state)).toEqual(['enabled', 'enabled'])
    expect(at(10).slice(0, 2)).toEqual(['disabled', 'enabled'])
    // Access and read-only change neither; the other actions keep their rows.
    expect(databaseActionState(actionRow('database')!, { ...online, userAccess: 1, readOnly: true }).row).toEqual({ ...actionRow('database'), bringOnline: 'disabled' })
    // The menu keys read the runtime; an unknown one leaves both enabled for the preflight to decide.
    expect(actionMenuState({ kind: 'database', database: { ...online, state: 6 } })).toMatchObject({ takeOffline: 'disabled', bringOnline: 'enabled', rename: 'enabled' })
    expect(actionMenuState({ kind: 'database' })).toMatchObject({ takeOffline: 'enabled', bringOnline: 'enabled' })
    // SQL Server's own databases stay greyed whatever their state; Managed Instance and Azure SQL Database hide both.
    expect(actionMenuState({ kind: 'database', subtype: 'system', database: { ...online, state: 6 } })).toMatchObject({ takeOffline: 'disabled', bringOnline: 'disabled' })
    for (const engine of ['managedInstance', 'cloud'] as const) expect(actionMenuState({ kind: 'database', engine }), engine).toMatchObject({ takeOffline: '', bringOnline: '' })
  })
  it('keeps Take Offline and Bring Online alone in one Tasks group, as SSMS separates Detach… above them', () => {
    // SSMS's Tasks (Learn's SSMS 17 and 19 screenshots): Detach…, a separator, Take Offline and Bring Online, a separator. So
    // 1_state holds these two alone, first and second, and Detach… (D3b) needs a group of its own before it.
    const state = commandIds.flatMap(id => (commandDescriptor(id).menus ?? []).filter(place => place.menu === 'explorer.tasks' && place.group === '1_state').map(place => [place.order, id]))
    expect(state.sort(([a], [b]) => Number(a) - Number(b))).toEqual([[1, 'explorer.takeOffline'], [2, 'explorer.bringOnline']])
  })
  it('offers an action with engines only on those servers, and everywhere when the engine is unknown', () => {
    expect(offeredOnEngine(undefined, 'cloud')).toBe(true)
    expect(offeredOnEngine(['box', 'managedInstance'], undefined)).toBe(true)
    expect(offeredOnEngine(['box', 'managedInstance'], 'managedInstance')).toBe(true)
    expect(offeredOnEngine(['box'], 'cloud')).toBe(false)
    const unknown = actionMenuState({ kind: 'table' })
    for (const engine of ['box', 'managedInstance', 'cloud'] as const) {
      expect(actionMenuState({ kind: 'table', engine }), engine).toEqual(Object.fromEntries(objectActions.map(action => [action, objectActionSpecs[action].engines.includes(engine) ? unknown[action] : ''])))
    }
    // The catalogue's engines (A1): Azure SQL Database, out of wave 5, offers only Select Top 1000 Rows, so the menu hides
    // Rename and Delete there rather than offer what the backend refuses.
    expect(actionMenuState({ kind: 'table', engine: 'box' })).toEqual(unknown)
    expect(actionMenuState({ kind: 'table', engine: 'cloud' })).toEqual({ ...none, selectTop: 'enabled' })
  })
  it('offers the actions of a folder on that folder alone, on the engines they serve, and on rows only where they place themselves', () => {
    const none = actionMenuState(undefined)
    // SSMS: Databases › Attach…, on SQL Server's box editions only (decision 10: not on Managed Instance or Azure SQL Database).
    expect(objectActionSpecs.attach).toMatchObject({ title: 'Attach Database…', menuTitle: 'Attach…', mnemonic: 'a', group: '0_new', order: 2, folder: 'databases', engines: ['box'], dialog: 'attachDatabase' })
    // SSMS: Databases › Restore Database… (D1f), on SQL Server itself (critic A1: Managed Instance restores from URL only).
    expect(actionMenuState({ kind: 'folder', folder: 'databases', engine: 'box' })).toEqual({ ...none, attach: 'enabled', restore: 'enabled' })
    expect(actionMenuState({ kind: 'folder', folder: 'databases' })).toEqual({ ...none, attach: 'enabled', restore: 'enabled' })
    for (const engine of ['managedInstance', 'cloud'] as const) expect(actionMenuState({ kind: 'folder', folder: 'databases', engine }), engine).toEqual(none)
    for (const folder of ['tables', 'views', 'systemDatabases', 'logins'] as const) expect(actionMenuState({ kind: 'folder', folder, engine: 'box' }), folder).toEqual(none)
    // A database row never offers Attach, whatever its engine; it offers Restore Database only through its own placement (`rows`:
    // Tasks › Restore › Database…), on SQL Server itself, and not for SQL Server's own databases or a snapshot.
    expect(actionMenuState({ kind: 'database', engine: 'box' }).attach).toBe('')
    expect(actionMenuState({ kind: 'database', engine: 'box' }).restore).toBe('enabled')
    expect(actionMenuState({ kind: 'database', engine: 'managedInstance' }).restore).toBe('')
    expect([actionMenuState({ kind: 'database', subtype: 'system' }).restore, actionMenuState({ kind: 'database', subtype: 'snapshot' }).restore]).toEqual(['disabled', ''])
    // A test folder action without `rows` stays off rows that would enable it.
    expect(actionMenuState({ kind: 'database', engine: 'box' }, { actions: { restore: { folder: 'databases', engines: ['box'] } } }).restore).toBe('')
    expect(actionMenuState({ kind: 'server', engine: 'box' }).attach).toBe('')
    // A test folder action follows its own engines.
    expect(actionMenuState({ kind: 'folder', folder: 'tables', engine: 'cloud' }, { actions: { attach: { folder: 'tables', engines: ['cloud'] } } }).attach).toBe('enabled')
    expect(actionCommandEntries()['explorer.attachDatabase']).toMatchObject({ title: 'Attach Database…', icon: 'plug', precondition: "backendReady && explorerActionAttach == 'enabled'",
      menus: [{ menu: 'explorer.context', group: '0_new', order: 2, title: 'Attach…', mnemonic: 'a', when: "explorerActionAttach != '' && explorerNode == 'folder'" }] })
    expect(dialogSpecs.attachDatabase).toEqual({ title: 'Attach Databases', surface: 'modal', titleFormat: 'plain', size: 'large', action: 'attach', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] })
  })
  it('composes the menu state from the status overlay, the database rules and the engine gate, in that order', () => {
    // As later PRs may declare them: Delete for box servers only, an overlay for unavailable databases, and a rule.
    const actions = { delete: { engines: ['box'] } } as const
    const kinds = { database: { row: { rename: 'enabled', delete: 'enabled', properties: 'enabled' }, statuses: { readOnly: { rename: 'disabled' } } } } as const
    const rules: DatabaseActionRule[] = [{ action: 'properties', states: ['offline'], hide: true, reason: 'Offline.' }, { action: 'delete', states: ['restoring'], reason: 'Restoring.' }]
    const sources = { actions, kinds, rules }
    expect(actionMenuState({ kind: 'database' }, sources)).toEqual({ ...none, rename: 'enabled', delete: 'enabled', properties: 'enabled' })
    // The engine gate: hidden on Managed Instance and Azure SQL Database, kept on a box and where the engine is unknown.
    expect(actionMenuState({ kind: 'database', engine: 'managedInstance' }, sources).delete).toBe('')
    expect(actionMenuState({ kind: 'database', engine: 'cloud' }, sources).delete).toBe('')
    expect(actionMenuState({ kind: 'database', engine: 'box' }, sources).delete).toBe('enabled')
    expect(actionMenuState({ kind: 'database', engine: undefined }, sources).delete).toBe('enabled')
    expect(actionMenuState({ kind: 'database', engine: 'managedInstance' }, sources).rename).toBe('enabled')
    // The runtime narrowing: a rule greys an enabled action, or hides it.
    expect(actionMenuState({ kind: 'database', database: { ...online, state: 1 } }, sources)).toMatchObject({ delete: 'disabled', properties: 'enabled' })
    expect(actionMenuState({ kind: 'database', database: { ...online, state: 6 } }, sources)).toMatchObject({ delete: 'enabled', properties: '' })
    // The rules read only a database's runtime; another kind's is ignored.
    expect(actionMenuState({ kind: 'table', database: { ...online, state: 6 } }, { rules })).toEqual(actionMenuState({ kind: 'table' }))
    // The status overlay applies before the rules and the gate.
    expect(actionMenuState({ kind: 'database', status: 'readOnly', engine: 'cloud', database: { ...online, state: 6 } }, sources)).toEqual({ ...none, rename: 'disabled' })
  })
  it('takes a live sample over the listing only when it is newer, and reads a newer complete sample without a row as plainly online', () => {
    const listed = { state: 6, userAccess: 0, readOnly: false, standby: false }
    const row = { name: 'Sales', state: 1, userAccess: 1, readOnly: true, standby: false }
    expect(currentDatabaseRuntime(listed, 1_000)).toBe(listed)
    expect(currentDatabaseRuntime(listed, 1_000, { at: 1_000, row, complete: true })).toBe(listed)
    expect(currentDatabaseRuntime(listed, 1_000, { at: 1_001, row, complete: true })).toEqual({ state: 1, userAccess: 1, readOnly: true, standby: false })
    expect(currentDatabaseRuntime(listed, 1_000, { at: 2_000, row: undefined, complete: true })).toEqual({ state: 0, userAccess: 0, readOnly: false, standby: false })
    // A sample cut at the probe's 1,000 rows: a database past the cut keeps its listed state; a row it has still wins.
    expect(currentDatabaseRuntime(listed, 1_000, { at: 2_000, row: undefined, complete: false })).toBe(listed)
    expect(currentDatabaseRuntime(undefined, undefined, { at: 2_000, row: undefined, complete: false })).toBeUndefined()
    expect(currentDatabaseRuntime(listed, 1_000, { at: 2_000, row, complete: false })).toMatchObject({ state: 1 })
    expect(currentDatabaseRuntime(undefined, undefined, { at: 5, row, complete: true })).toMatchObject({ state: 1 })
    expect(currentDatabaseRuntime(undefined, undefined)).toBeUndefined()
  })
  it('offers New Database… first on the Databases folder and a database node of a SQL Server box, never on Azure or Managed Instance', () => {
    expect(serverActions).toEqual(['createDatabase'])
    expect(serverActionSpecs.createDatabase).toMatchObject({ title: 'New Database…', mnemonic: 'n', group: '0_new', order: 1, dialog: 'newDatabase', command: 'explorer.newDatabase',
      engines: ['box'], folders: ['databases'], kinds: ['database'], nodePlace: { command: 'explorer.newDatabaseOnDatabase', group: '1_query', order: 1 }, longRun: 'newDatabase' })
    expect(dialogSpecs.newDatabase).toMatchObject({ title: 'New Database', surface: 'document', titleFormat: 'plain', action: 'createDatabase' })
    expect(dialogSpecs.newDatabase.pages.map(page => page.id)).toEqual(['general', 'options', 'filegroups'])
    const entries = { ...serverActionCommandEntries(), ...newDatabaseCommandEntries() }
    expect(Object.keys(entries)).toEqual(['explorer.newDatabase', 'explorer.newDatabaseOnDatabase', 'newDatabase.ok', 'newDatabase.cancel', 'newDatabase.stop'])
    for (const [id, entry] of Object.entries(entries)) {
      expect(isCommandId(id), id).toBe(true)
      expect(commandDescriptor(id as never)).toEqual(entry)
      expect(isIconId(entry.icon), id).toBe(true)
      expect(whenProblems(entry.precondition, ['static', 'state']), id).toEqual([])
      for (const placement of 'menus' in entry ? entry.menus : []) expect(whenProblems(placement.when, ['static', 'state', 'target']), id).toEqual([])
    }
    // Stop must stay available while OK runs; Cancel is not.
    expect(entries['newDatabase.stop'].precondition).toBe('activeDocumentIsNewDatabase && newDatabaseCreating')
    expect(entries['newDatabase.cancel'].precondition).toContain('!newDatabaseCreating')
    const commands = { isEnabled: () => true, isToggled: () => false }, keybindings = { lookup: () => undefined }
    const titles = (target: Record<string, unknown>, engine: 'box' | 'cloud' | 'managedInstance' = 'box', folder?: 'databases') => {
      const state = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionServerEngine: engine, ...actionContextValues(actionMenuState({ kind: 'folder', folder, engine })) })
      return resolveMenu('explorer.context', { platform: 'win32', state, target: { explorerServerEngine: engine, explorerServerLost: false, ...target }, commands, keybindings })
        .flatMap(item => item.kind === 'command' ? [item.title] : item.kind === 'separator' ? ['---'] : [])
    }
    expect(titles({ explorerNode: 'folder', explorerFolder: 'databases' })[0]).toBe('New Database…')
    // SSMS's database menu opens with one group, New Database…, New Query, Script Database as (Microsoft Learn's SSMS 17 and 19
    // screenshots): no separator after New Database…. The Databases folder keeps it in 0_new, where Attach… joins it. Each place is
    // its own command, so a native macOS menu, which sees only command ids, shows it once; the palette offers only the first.
    expect(titles({ explorerNode: 'database' }).slice(0, 2)).toEqual(['New Database…', 'New Query'])
    expect(entries['explorer.newDatabase'].menus.map(placement => [placement.group, placement.order])).toEqual([['0_new', 1]])
    expect(entries['explorer.newDatabaseOnDatabase'].menus.map(placement => [placement.group, placement.order])).toEqual([['1_query', 1]])
    expect(entries['explorer.newDatabaseOnDatabase'].menus[0].when).not.toContain('explorerFolder')
    expect(entries['explorer.newDatabase'].menus[0].when).not.toContain("explorerNode == 'database'")
    expect(['palette' in entries['explorer.newDatabase'], entries['explorer.newDatabaseOnDatabase'].palette]).toEqual([false, false])
    expect(entries['explorer.newDatabaseOnDatabase'].precondition).toBe(entries['explorer.newDatabase'].precondition)
    expect(titles({ explorerNode: 'folder', explorerFolder: 'tables' })).not.toContain('New Database…')
    expect(titles({ explorerNode: 'folder', explorerFolder: 'databases', explorerServerLost: true })).not.toContain('New Database…')
    for (const engine of ['cloud', 'managedInstance'] as const) expect(titles({ explorerNode: 'folder', explorerFolder: 'databases' }, engine), engine).not.toContain('New Database…')
    // No row offers it. Attach… (D1d) and Restore Database… (D1f) follow it in 0_new, as in SSMS's Databases menu; Restore Files and
    // Filegroups… is a later PR.
    for (const kind of nodeKinds) expect(actionOffered(kind, 'createDatabase' as never), kind).toBe(false)
    expect(titles({ explorerNode: 'folder', explorerFolder: 'databases' }, 'box', 'databases').slice(0, 4)).toEqual(['New Database…', 'Attach…', 'Restore Database…', '---'])
    expect(commandIds.filter(id => /attach|restore/i.test(id)).sort()).toEqual(['explorer.attachDatabase', 'explorer.restoreDatabase', 'explorer.tasks.restoreDatabase', 'restoreDatabase.refresh', 'restoreDatabase.run', 'restoreDatabase.stop'])
    expect(renderObjectActionsDocs()).toContain('## New Database')
  })
  it('declares the database node\'s Tasks (Take Offline, Bring Online, Restore › Database…) and the Databases folder\'s Restore Database…, hidden where they do not apply', () => {
    const commands = { isEnabled: () => true, isToggled: () => false }, keybindings = { lookup: () => undefined }
    const titles = (items: readonly ResolvedMenuItem[]): string[] => items.flatMap(item => item.kind === 'submenu' ? [item.title + ' >', ...titles(item.items).map(title => '  ' + title)] : item.kind === 'command' ? [item.title] : [])
    const resolve = (model?: (menu: MenuId) => readonly MenuEntry[], lost = false, subtype?: NodeSubtype) => {
      const state = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionKind: 'database', ...actionContextValues(actionMenuState({ kind: 'database', subtype })) })
      return titles(resolveMenu('explorer.context', { platform: 'win32', state, target: { explorerNode: 'database', explorerServerLost: lost }, commands, keybindings, ...model ? { model } : {} }))
    }
    // D3a: Tasks › Take Offline and Bring Online on a user database (SSMS's order, recalled), then D1f's Restore › Database… after
    // the state group; never Restore Database… itself, which is the folder's.
    const shown = resolve()
    expect(shown.slice(shown.indexOf('Tasks >'), shown.indexOf('Tasks >') + 5)).toEqual(['Tasks >', '  Take Offline', '  Bring Online', '  Restore >', '    Database…'])
    expect(shown.filter(title => title.startsWith('  '))).toEqual(['  Take Offline', '  Bring Online', '  Restore >', '    Database…'])
    expect(shown).not.toContain('Restore Database…')
    // A snapshot offers no task: Tasks hides as a submenu of nothing; on a lost server it hides too.
    expect(resolve(undefined, false, 'snapshot').some(title => title.startsWith('Tasks'))).toBe(false)
    expect(resolve(undefined, true).some(title => title.startsWith('Tasks'))).toBe(false)
    // A submenu with nothing placed in it stays out: Restore hides, and Tasks keeps the state group.
    const model = (menu: MenuId) => menu === 'explorer.tasks.restore' ? [] as MenuEntry[] : buildMenuModel(menu, 'win32')
    expect(resolve(model).filter(title => title.startsWith('  '))).toEqual(['  Take Offline', '  Bring Online'])
    // The Databases folder's Restore Database… (R), and no Tasks there.
    const folderState = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionKind: 'folder', ...actionContextValues(actionMenuState({ kind: 'folder', folder: 'databases' })) })
    const folder = titles(resolveMenu('explorer.context', { platform: 'win32', state: folderState, target: { explorerNode: 'folder', explorerServerLost: false }, commands, keybindings }))
    expect(folder).toContain('Restore Database…')
    expect(folder.some(title => title.startsWith('Tasks'))).toBe(false)
    // docs/object-actions.md names them as the menus do (its generator loads in plain Node, without menus.ts).
    expect(renderObjectActionsDocs()).toContain(`${submenus['explorer.tasks'].title} (\`explorer.tasks\`) and ${submenus['explorer.tasks'].title} › ${submenus['explorer.tasks.restore'].title} (\`explorer.tasks.restore\`)`)
  })
  it('keeps the limits and error codes', () => {
    expect(actionLimits).toMatchObject({ describeMs: 40_000, scriptMs: 25_000, readPerConnection: 2, readTotal: 4, executePerConnection: 1, executeTotal: 2, registered: 128, cancelIds: 16, newName: 128,
      files: 1_024, filegroups: 256, logins: 1_024, collations: 8_192, statements: 512, scriptChars: 1_000_000 })
    // A scripted action always fits a query window, so Script Action to New Query Window can always run it.
    expect(actionLimits.scriptChars).toBeLessThanOrEqual(maxScriptCharacters)
    expect(actionErrorCodes.filter(code => !actionErrorRetryable[code])).toEqual(['NOT_FOUND', 'NOT_SUPPORTED', 'DEPENDENTS', 'NAME_IN_USE', 'PATH_NOT_FOUND', 'MEDIA', 'BACKUP_MISMATCH',
      'TAIL_LOG_NEEDED', 'RESTORE_SEQUENCE'])
    // The server file picker: a path fits sys.master_files.physical_name, and main's 15 s deadline outlasts the backend's budget.
    expect([actionLimits.serverPath, actionLimits.browseEntries, actionLimits.browseMs]).toEqual([260, 2_000, 10_000])
    expect(actionLimits.browseMs).toBeLessThan(serverFilesDeadlineMs)
  })
  it('lists only error codes the backend produces, so a renderer branch on one can be reached', () => {
    const backend = ['ActionService.cs', 'ActionErrors.cs', 'ServerFiles.cs', 'RestoreDescribe.cs'].map(name => readFileSync(join('backend', 'Varia.Backend', 'Actions', name), 'utf8')).join('\n')
    // Each code appears as a C# string literal: ActionErrors.Numbers, an Error(...) or Create(...) call, or (AUTH_*) the sign-in's codes.
    expect(actionErrorCodes.filter(code => !backend.includes(`"${code}"`))).toEqual([])
  })
  it('loads in plain Node 24, as the fake backend and scripts load the other catalogues', () => {
    const files = ['catalog.ts', 'database.ts', 'files.ts', 'schema.ts', 'docs.ts', 'restore.ts', 'restore-schema.ts', 'restore-plan.ts'].map(name => join('src', 'shared', 'actions', name))
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
