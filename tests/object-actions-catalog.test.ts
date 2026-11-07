import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  actionCommandEntries, actionContextKey, actionContextValues, actionDialog, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenuState, actionOffered, actionRow,
  actionsCatalogJson, actionStatuses, actionVerb, createActionSpecs, databaseActionState, databaseStateOf, dialogIds, dialogSpecs, dialogTitle, factDescribeSpecs, isCreateAction, isKindDialogAction, isModalDialog,
  kindDialogActionSpecs, objectActions, objectActionSpecs, offeredOnEngine, overlayRow, isServerAction, newDatabaseCommandEntries, pageIds, propertiesCommandEntries, serverActionCommandEntries, serverActions,
  serverActionSpecs, scriptActionTitles, unknownOutcomeMessage, type ActionCommandId, type DatabaseActionRule, type ModalDialogId, type PageId
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
import { kindSpecs, nodeKinds, nodeStatuses, type NodeKind, type NodeStatus, type NodeSubtype } from '../src/shared/explorer/catalog'
import { loginSubtypes } from '../src/shared/actions/logins'
import { scriptDestinations } from '../src/shared/scripting/catalog'

const every = (kind: NodeKind) => [undefined, ...kindSpecs[kind].subtypes ?? []] as (NodeSubtype | undefined)[]
/** The context menu's row actions (Select Top, Rename, Delete, Properties, and a login's Disable and Enable); a folder's actions (Attach, Restore Database) are not a
 *  row's own items, and a database's Tasks (Detach…, Take Offline, Bring Online, and Restore › Database… and Files and Filegroups…, the restores' `rows`) are `tasks`. */
const states = (kind: NodeKind, subtype?: NodeSubtype, status?: NodeStatus) => objectActions.filter(action => !objectActionSpecs[action].folder && !objectActionSpecs[action].menu).map(action => actionMenuState({ kind, subtype, status })[action] || '-').join(' ')
const tasks = (kind: NodeKind, subtype?: NodeSubtype) => (['detach', 'takeOffline', 'bringOnline', 'restore', 'restoreFiles'] as const).map(action => actionMenuState({ kind, subtype })[action] || '-').join(' ')
const none = { selectTop: '', rename: '', delete: '', properties: '', attach: '', takeOffline: '', bringOnline: '', detach: '', restore: '', restoreFiles: '', disable: '', enable: '', unlock: '' }
const online = { state: 0, userAccess: 0, readOnly: false, standby: false }

describe('object action catalogue', () => {
  it('declares rows only for kinds and subtypes Object Explorer has', () => {
    for (const kind of nodeKinds) {
      const spec = actionKindSpecs[kind]
      if (!spec) continue
      for (const subtype of Object.keys(spec.subtypes ?? {})) expect(kindSpecs[kind].subtypes, `${kind} ${subtype}`).toContain(subtype)
    }
    for (const subtype of Object.keys(actionKindSpecs.login?.subtypeStatuses ?? {})) expect(kindSpecs.login.subtypes, subtype).toContain(subtype)
    expect(Object.keys(actionKindSpecs).sort()).toEqual(['database', 'function', 'login', 'procedure', 'table', 'view'])
    expect(actionRow('table', 'clr' as NodeSubtype)).toBeUndefined()
    expect(actionMenuState({ kind: 'folder' })).toEqual(none)
    // A login of a type the Logins folder does not list has no subtype, and no actions.
    expect(actionMenuState({ kind: 'login' })).toEqual(none)
  })
  it('offers SSMS\'s actions per kind, greying SQL Server\'s own objects and the subtypes that need more handling', () => {
    expect(states('table')).toBe('enabled enabled enabled - - - -')
    for (const subtype of ['graphNode', 'graphEdge'] as const) expect(states('table', subtype), subtype).toBe('enabled enabled enabled - - - -')
    for (const subtype of ['system', 'systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'ledgerHistory', 'fileTable', 'external'] as const) {
      expect(states('table', subtype), subtype).toBe('enabled disabled disabled - - - -')
    }
    expect(states('table', 'droppedLedger')).toBe('- disabled disabled - - - -')
    expect(states('view')).toBe('enabled enabled enabled - - - -')
    for (const subtype of ['system', 'ledger'] as const) expect(states('view', subtype), subtype).toBe('enabled disabled disabled - - - -')
    expect(states('view', 'droppedLedger')).toBe('- disabled disabled - - - -')
    for (const subtype of [undefined, 'sql', 'clr'] as const) expect(states('procedure', subtype), String(subtype)).toBe('- enabled enabled - - - -')
    for (const subtype of ['system', 'extended', 'replicationFilter'] as const) expect(states('procedure', subtype), subtype).toBe('- disabled disabled - - - -')
    for (const subtype of every('function').filter(subtype => subtype !== 'aggregate')) expect(states('function', subtype), String(subtype)).toBe('- enabled enabled - - - -')
    expect(states('function', 'aggregate')).toBe('- enabled disabled - - - -')
    // Properties opens for every database, SQL Server's own and snapshots included, as in SSMS.
    expect([states('database'), states('database', 'system'), states('database', 'snapshot')]).toEqual(['- enabled enabled enabled - - -', '- disabled disabled enabled - - -', '- disabled enabled enabled - - -'])
    // A login's Properties (D2c) opens Login Properties, a database's the Database Properties document.
    expect(nodeKinds.filter(kind => actionOffered(kind, 'properties'))).toEqual(['login', 'database'])
    // Tasks › Detach…, Take Offline, Bring Online and Restore › Database…: user databases only; greyed on SQL Server's own (as SSMS for
    // Detach and the state changes; critic A19 for a restore, which takes T-SQL there), absent on a snapshot, which cannot be restored over.
    expect([tasks('database'), tasks('database', 'system'), tasks('database', 'snapshot')]).toEqual(['enabled enabled enabled enabled enabled', 'disabled disabled disabled disabled disabled', '- - - - -'])
    expect(actionMenuState({ kind: 'database', engine: 'managedInstance' })).toMatchObject({ restore: '', restoreFiles: '' })
    for (const action of ['restore', 'restoreFiles'] as const) expect(nodeKinds.filter(kind => actionOffered(kind, action)), action).toEqual(['database'])
    for (const action of ['detach', 'takeOffline', 'bringOnline'] as const) expect(nodeKinds.filter(kind => actionOffered(kind, action)), action).toEqual(['database'])
    expect(actionOffered('database', 'rename') && actionOffered('function', 'delete') && !actionOffered('login', 'selectTop') && !actionOffered('procedure', 'selectTop')).toBe(true)
  })
  it('publishes one context key per action', () => {
    expect(objectActions.map(actionContextKey)).toEqual(['explorerActionSelectTop', 'explorerActionRename', 'explorerActionDelete', 'explorerActionProperties', 'explorerActionAttach', 'explorerActionTakeOffline', 'explorerActionBringOnline', 'explorerActionDetach', 'explorerActionRestore', 'explorerActionRestoreFiles',
      'explorerActionDisable', 'explorerActionEnable', 'explorerActionUnlock'])
    expect(actionContextValues(actionMenuState({ kind: 'database', subtype: 'snapshot' }))).toEqual({
      explorerActionSelectTop: '', explorerActionRename: 'disabled', explorerActionDelete: 'enabled', explorerActionProperties: 'enabled', explorerActionAttach: '', explorerActionTakeOffline: '', explorerActionBringOnline: '', explorerActionDetach: '', explorerActionRestore: '',
      explorerActionRestoreFiles: '', explorerActionDisable: '', explorerActionEnable: '', explorerActionUnlock: ''
    })
  })
  it('generates the action commands, keeping explorer.selectTopRows, with valid keys, preconditions and placements', () => {
    const entries = actionCommandEntries()
    // The restores' row placements (Tasks › Restore › Database… and Files and Filegroups…) are commands of their own, out of the palette:
    // a context menu shows each command once.
    expect(Object.keys(entries)).toEqual(['explorer.selectTopRows', 'explorer.rename', 'explorer.delete', 'explorer.properties', 'explorer.attachDatabase', 'explorer.takeOffline', 'explorer.bringOnline', 'explorer.detachDatabase', 'explorer.restoreDatabase', 'explorer.tasks.restoreDatabase',
      'explorer.restoreFiles', 'explorer.tasks.restoreFiles', 'explorer.disable', 'explorer.enable', 'explorer.unlock'])
    expect(entries['explorer.tasks.restoreDatabase']).toMatchObject({ title: 'Restore Database…', palette: false, precondition: entries['explorer.restoreDatabase'].precondition })
    expect(entries['explorer.tasks.restoreFiles']).toMatchObject({ title: 'Restore Files and Filegroups…', palette: false, precondition: entries['explorer.restoreFiles'].precondition })
    expect(entries['explorer.restoreFiles'].menus).toEqual([{ menu: 'explorer.context', group: '0_new', order: 4, mnemonic: 'e', when: "explorerActionRestoreFiles != '' && explorerNode == 'folder'" }])
    expect(entries['explorer.tasks.restoreFiles'].menus).toEqual([{ menu: 'explorer.tasks.restore', group: '1_restore', order: 2, title: 'Files and Filegroups…', mnemonic: 'f', when: "explorerActionRestoreFiles != '' && explorerNode != 'folder' && explorerNode != 'background'" }])
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
    expect(entries['explorer.properties']).toMatchObject({ title: 'Properties', icon: 'settings-gear', unavailableHint: 'Select a database or login in Object Explorer.',
      precondition: "backendReady && explorerActionProperties == 'enabled'", menus: [{ menu: 'explorer.context', group: '9_properties', order: 1, mnemonic: 'p' }] })
    // A login's Disable and Enable: the palette's title names the login, the menu's is SSMS's one word; no keys, as in SSMS.
    expect(entries['explorer.disable']).toEqual({ title: 'Disable Login', category: 'Object Explorer', icon: 'circle-slash', keywords: ['login', 'account', 'block', 'deactivate'],
      unavailableHint: 'Select an enabled login in Object Explorer.', precondition: "backendReady && explorerActionDisable == 'enabled'",
      menus: [{ menu: 'explorer.context', group: '6_state', order: 1, title: 'Disable', mnemonic: 'b', when: "explorerActionDisable != '' && explorerNode != 'background'" }] })
    expect(entries['explorer.enable']).toMatchObject({ title: 'Enable Login', icon: 'pass', unavailableHint: 'Select a disabled login in Object Explorer.', precondition: "backendReady && explorerActionEnable == 'enabled'",
      menus: [{ menu: 'explorer.context', group: '6_state', order: 1, title: 'Enable', mnemonic: 'b', when: "explorerActionEnable != '' && explorerNode != 'background'" }] })
    expect(entries['explorer.disable'].keybindings ?? entries['explorer.enable'].keybindings).toBeUndefined()
    // Unlock… (D4d): after Disable or Enable in the state group, U as its access key, a padlock, and no keys.
    expect(entries['explorer.unlock']).toEqual({ title: 'Unlock Login…', category: 'Object Explorer', icon: 'unlock', keywords: ['login', 'account', 'locked', 'lockout', 'password', 'policy'],
      unavailableHint: 'Select a SQL Server login in Object Explorer.', precondition: "backendReady && explorerActionUnlock == 'enabled'",
      menus: [{ menu: 'explorer.context', group: '6_state', order: 2, title: 'Unlock…', mnemonic: 'u', when: "explorerActionUnlock != '' && explorerNode != 'background'" }] })
  })
  it('derives a login\'s rows from logins.ts: Disable and Rename by subtype, and Enable in place of Disable while it is disabled', () => {
    // selectTop rename delete properties disable enable unlock. Properties (D2c) opens Login Properties on every login. Unlock is offered on SQL Server logins (sa included) whatever their state, greyed on SQL Server's own and
    // absent elsewhere.
    const open = ['- enabled enabled enabled enabled - -', '- enabled enabled enabled - enabled -'], sql = ['- enabled enabled enabled enabled - enabled', '- enabled enabled enabled - enabled enabled']
    const rows = Object.fromEntries(loginSubtypes.map(subtype => [subtype, [states('login', subtype), states('login', subtype, 'disabled')]]))
    expect(rows).toEqual({
      sql, windowsUser: open, certificateMapped: open, asymmetricKeyMapped: open,
      // SQL Server refuses to drop sa (15405 on a DROP LOGIN of it), so its Delete is greyed.
      sa: ['- enabled disabled enabled enabled - enabled', '- enabled disabled enabled - enabled enabled'],
      // Login Properties opens on SQL Server's own logins too, as in SSMS (D2 spec 1); the dialog says they never change.
      system: ['- disabled disabled enabled disabled - disabled', '- disabled disabled enabled - disabled disabled'],
      // A Windows group cannot be disabled (15151), so it never shows Enable either.
      windowsGroup: ['- enabled enabled enabled disabled - -', '- enabled enabled enabled - - -'],
      externalUser: ['- disabled enabled enabled enabled - -', '- disabled enabled enabled - enabled -'], externalGroup: ['- disabled enabled enabled enabled - -', '- disabled enabled enabled - enabled -']
    })
    // Disable and Enable never show together; a login whose CONNECT SQL is denied keeps Disable (ENABLE would not lift the DENY).
    for (const subtype of loginSubtypes) for (const status of [undefined, ...nodeStatuses]) {
      const state = actionMenuState({ kind: 'login', subtype, status })
      expect(!!state.disable && !!state.enable, `${subtype} ${status}`).toBe(false)
    }
    expect(states('login', 'sql', 'noAccess')).toBe(states('login', 'sql'))
    expect(actionStatuses('login')).toEqual(['disabled'])
    expect([actionOffered('login', 'disable'), actionOffered('login', 'enable'), actionOffered('login', 'unlock'), actionOffered('login', 'rename'), actionOffered('login', 'delete'), actionOffered('login', 'properties')]).toEqual([true, true, true, true, true, true])
    // C# reads the same rows, one per subtype and status.
    const json = JSON.parse(actionsCatalogJson()) as { rows: { kind: string; subtype: string; status?: string; enabled: string[]; disabled: string[] }[]; describes: unknown[] }
    expect(json.rows.filter(row => row.kind === 'login' && row.subtype === 'sa')).toEqual([{ kind: 'login', subtype: 'sa', enabled: ['rename', 'properties', 'disable', 'unlock'], disabled: ['delete'] }, { kind: 'login', subtype: 'sa', status: 'disabled', enabled: ['rename', 'properties', 'enable', 'unlock'], disabled: ['delete'] }])
    expect(json.rows.find(row => row.kind === 'login' && row.subtype === 'system' && row.status === 'disabled')).toMatchObject({ enabled: ['properties'], disabled: ['rename', 'delete', 'enable', 'unlock'] })
    expect(json.describes).toContainEqual({ action: 'disable', describe: 'loginFacts', kinds: ['login'] })
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
      for (const rule of rules) expect([rule.whenSource, reservedReason(rule.chords[0], platform)]).toEqual(["activePanel == 'explorer' && !textInputFocus && !searchHitsFocus", undefined])
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
        expect(rule.whenSource).toBe("activePanel == 'explorer' && !textInputFocus && !searchHitsFocus")
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
    // A login's Disable and Enable have their own group between Copy Name and Rename.
    expect(ids.slice(at('explorer.copyName') + 1, at('explorer.rename'))).toEqual(['---', 'explorer.disable', 'explorer.enable', 'explorer.unlock', '---'])
    // Properties is the last item, after Refresh in its own group, as in SSMS; an SSIS Catalog object's Properties takes its place.
    expect(ids.slice(at('explorer.refresh'))).toEqual(['explorer.refresh', '---', 'explorer.properties', 'ssis.folderProperties', 'ssis.projectProperties', 'ssis.packageProperties', 'ssis.environmentProperties'])
  })
  it('declares Delete Object and Database Properties with SSMS\'s titles, pages and Script button wording', () => {
    expect(dialogIds).toEqual(['deleteObject', 'databaseProperties', 'newDatabase', 'attachDatabase', 'newLogin', 'takeOffline', 'bringOnline', 'detachDatabase', 'unlockLogin', 'loginProperties'])
    // Learn's Detach Database dialog, as a modal (wave 5 decisions): its title names the database.
    expect(dialogSpecs.detachDatabase).toEqual({ title: 'Detach Database', surface: 'modal', titleFormat: 'withName', size: 'compact', action: 'detach',
      pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }], steps: true })
    expect(dialogTitle('detachDatabase', 'AppData')).toBe('Detach Database - AppData')
    // Unlock Login (D4d) is Varia's own modal: its run's steps show when the transaction fails or is stopped.
    expect(dialogSpecs.unlockLogin).toEqual({ title: 'Unlock Login', surface: 'modal', titleFormat: 'withName', size: 'compact', action: 'unlock', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }], steps: true })
    expect(dialogTitle('unlockLogin', 'Locked')).toBe('Unlock Login - Locked')
    for (const dialog of ['takeOffline', 'bringOnline'] as const) {
      expect(dialogSpecs[dialog]).toEqual({ title: dialog === 'takeOffline' ? 'Take Database Offline' : 'Bring Database Online', surface: 'modal', titleFormat: 'withName', size: 'compact', action: dialog,
        pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }], steps: true })
    }
    expect(dialogTitle('takeOffline', 'SalesDb')).toBe('Take Database Offline - SalesDb')
    expect(dialogSpecs.deleteObject).toEqual({ title: 'Delete Object', surface: 'modal', titleFormat: 'plain', size: 'compact', action: 'delete', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }], steps: true })
    expect(dialogSpecs.databaseProperties).toMatchObject({ title: 'Database Properties', surface: 'document', titleFormat: 'withName', size: 'large', action: 'properties' })
    expect(dialogSpecs.databaseProperties.pages.map(page => [page.id, page.title, page.icon])).toEqual([['general', 'General', 'settings-gear'], ['files', 'Files', 'settings-gear'],
      ['filegroups', 'Filegroups', 'settings-gear'], ['options', 'Options', 'settings-gear']])
    expect([dialogTitle('databaseProperties', 'AppData'), dialogTitle('deleteObject', 'dbo.Orders')]).toEqual(['Database Properties - AppData', 'Delete Object'])
    expect(dialogSpecs.newLogin).toMatchObject({ title: 'Login - New', surface: 'modal', titleFormat: 'plain', size: 'large', action: 'createLogin', steps: true })
    expect(dialogSpecs.newLogin.pages.map(page => [page.id, page.title, page.keepMounted ?? false])).toEqual([['general', 'General', true], ['serverRoles', 'Server Roles', false], ['userMapping', 'User Mapping', true], ['securables', 'Securables', true], ['status', 'Status', false]])
    expect(dialogTitle('newLogin', 'ignored')).toBe('Login - New')
    // Login Properties (D2c): New Login's pages on a login, opened by a login's Properties; its OK runs loginProperties, not properties.
    expect(dialogSpecs.loginProperties).toMatchObject({ title: 'Login Properties', surface: 'modal', titleFormat: 'withName', size: 'large', action: 'loginProperties', steps: true })
    expect(dialogSpecs.loginProperties.pages).toEqual(dialogSpecs.newLogin.pages)
    expect(dialogTitle('loginProperties', 'CONTOSO\\alice')).toBe('Login Properties - CONTOSO\\alice')
    for (const dialog of dialogIds) {
      const action = dialogSpecs[dialog].action
      expect(isServerAction(action) ? serverActionSpecs[action].dialog : isCreateAction(action) ? createActionSpecs[action].dialog : isKindDialogAction(action) ? kindDialogActionSpecs[action].dialog : objectActionSpecs[action].dialog).toBe(dialog)
    }
    expect(actionDialog('login', 'properties')).toBe('loginProperties')
    expect(actionDialog('database', 'properties')).toBe('databaseProperties')
    expect(actionDialog('login', 'delete')).toBe('deleteObject')
    expect(kindDialogActionSpecs.loginProperties).toEqual({ title: 'Login Properties', dialog: 'loginProperties', kind: 'login', verb: 'properties', engines: ['box', 'managedInstance'] })
    expect([actionVerb('loginProperties'), actionVerb('properties'), actionVerb('createLogin')]).toEqual(['properties', 'properties', undefined])
    // Delete Object is a confirmation, and Attach, New Login, Take Offline, Bring Online, Detach, Unlock and Login Properties are dialogs (wave 5 decisions 1), so
    // they are modal; Database Properties opens as a document (U1 D2).
    expect(dialogIds.filter(isModalDialog)).toEqual(['deleteObject', 'attachDatabase', 'newLogin', 'takeOffline', 'bringOnline', 'detachDatabase', 'unlockLogin', 'loginProperties'])
    expect(scriptDestinations.map(destination => scriptActionTitles[destination])).toEqual(['Script Action to New Query Window', 'Script Action to File', 'Script Action to Clipboard'])
    expect(unknownOutcomeMessage).toBe('The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('derives the action command, modal dialog and page ids from the catalogue, with registry icons on every page', () => {
    expectTypeOf<ActionCommandId>().toEqualTypeOf<'explorer.selectTopRows' | 'explorer.rename' | 'explorer.delete' | 'explorer.properties' | 'explorer.attachDatabase' | 'explorer.takeOffline' | 'explorer.bringOnline' | 'explorer.detachDatabase' | 'explorer.restoreDatabase' | 'explorer.tasks.restoreDatabase'
      | 'explorer.restoreFiles' | 'explorer.tasks.restoreFiles' | 'explorer.disable' | 'explorer.enable' | 'explorer.unlock'>()
    expectTypeOf<ModalDialogId>().toEqualTypeOf<'deleteObject' | 'attachDatabase' | 'newLogin' | 'takeOffline' | 'bringOnline' | 'detachDatabase' | 'unlockLogin' | 'loginProperties'>()
    expectTypeOf<PageId>().toEqualTypeOf<'general' | 'files' | 'filegroups' | 'options' | 'serverRoles' | 'userMapping' | 'securables' | 'status'>()
    expect(pageIds).toEqual(['general', 'files', 'filegroups', 'options', 'serverRoles', 'userMapping', 'securables', 'status'])
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
    // Only logins have an overlay (D4b), so a status leaves every other kind's row as it is, and the menu keys with it.
    for (const kind of nodeKinds.filter(kind => kind !== 'login')) {
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
  it('greys a database\'s Rename unless it is online, as MODIFY NAME opens the database (D3c)', () => {
    const at = (state: number) => { const { row, reasons } = databaseActionState(actionRow('database')!, { ...online, state }); return [row.rename, reasons.rename ?? ''] }
    expect(at(0)).toEqual(['enabled', ''])
    for (const state of [1, 2, 3, 4, 5, 6, 7, 10, 99]) expect(at(state), String(state)).toEqual(['disabled', 'The database must be online to be renamed.'])
    // Access leaves it: MODIFY NAME renames a SINGLE_USER or RESTRICTED_USER database. A read-only or standby one fails with 902.
    expect(databaseActionState(actionRow('database')!, { ...online, userAccess: 1 }).row.rename).toBe('enabled')
    expect(databaseActionState(actionRow('database')!, { ...online, userAccess: 2 }).row.rename).toBe('enabled')
    for (const runtime of [{ readOnly: true }, { standby: true }]) {
      expect(databaseActionState(actionRow('database')!, { ...online, ...runtime })).toMatchObject({ row: { rename: 'disabled' }, reasons: { rename: 'A read-only database cannot be renamed.' } })
    }
    // Offline wins: the first rule that applies gives the reason.
    expect(databaseActionState(actionRow('database')!, { ...online, state: 6, readOnly: true }).reasons.rename).toBe('The database must be online to be renamed.')
    // The fact describes serve Rename, on databases only, and a login's Disable, on logins only, and the backend's copy names them.
    expect(factDescribeSpecs).toEqual({ renameDatabase: { action: 'rename', kinds: ['database'] }, loginFacts: { action: 'disable', kinds: ['login'] } })
    expect(JSON.parse(actionsCatalogJson()).describes).toEqual([{ action: 'rename', describe: 'renameDatabase', kinds: ['database'] }, { action: 'disable', describe: 'loginFacts', kinds: ['login'] }])
  })
  it('greys Take Offline and Bring Online by the database\'s state, with the reason the menu shows', () => {
    const at = (state: number) => { const { row, reasons } = databaseActionState(actionRow('database')!, { ...online, state }); return [row.takeOffline, row.bringOnline, reasons.takeOffline ?? '', reasons.bringOnline ?? ''] }
    expect(at(0)).toEqual(['enabled', 'disabled', '', 'The database is online.'])
    expect(at(6)).toEqual(['disabled', 'enabled', 'The database is offline.', ''])
    for (const state of [1, 2, 7]) expect(at(state), String(state)).toEqual(['disabled', 'disabled', 'A database that is restoring or recovering cannot be taken offline.', 'A database that is restoring or recovering cannot be brought online.'])
    // Bring Online tries recovery on the states SQL Server lets SET ONLINE act on (owner default 7).
    for (const state of [3, 4, 5, 99]) expect(at(state).slice(0, 2), String(state)).toEqual(['enabled', 'enabled'])
    expect(at(10).slice(0, 2)).toEqual(['disabled', 'enabled'])
    // Access and read-only change neither; the other actions keep their rows, except Rename, which read-only greys.
    expect(databaseActionState(actionRow('database')!, { ...online, userAccess: 1, readOnly: true }).row).toEqual({ ...actionRow('database'), bringOnline: 'disabled', rename: 'disabled' })
    // The menu keys read the runtime; an unknown one leaves both enabled for the preflight to decide.
    expect(actionMenuState({ kind: 'database', database: { ...online, state: 6 } })).toMatchObject({ takeOffline: 'disabled', bringOnline: 'enabled', rename: 'disabled', properties: 'enabled' })
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
    expect(actionMenuState({ kind: 'folder', folder: 'databases', engine: 'box' })).toEqual({ ...none, attach: 'enabled', restore: 'enabled', restoreFiles: 'enabled' })
    expect(actionMenuState({ kind: 'folder', folder: 'databases' })).toEqual({ ...none, attach: 'enabled', restore: 'enabled', restoreFiles: 'enabled' })
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
    // No row offers it. Attach… (D1d), Restore Database… (D1f) and Restore Files and Filegroups… (D1g) follow it in 0_new, as in SSMS's
    // Databases menu.
    for (const kind of nodeKinds) expect(actionOffered(kind, 'createDatabase' as never), kind).toBe(false)
    expect(titles({ explorerNode: 'folder', explorerFolder: 'databases' }, 'box', 'databases').slice(0, 5)).toEqual(['New Database…', 'Attach…', 'Restore Database…', 'Restore Files and Filegroups…', '---'])
    expect(commandIds.filter(id => /attach|restore/i.test(id)).sort()).toEqual(['explorer.attachDatabase', 'explorer.restoreDatabase', 'explorer.restoreFiles', 'explorer.tasks.restoreDatabase', 'explorer.tasks.restoreFiles', 'restoreDatabase.refresh', 'restoreDatabase.run', 'restoreDatabase.stop'])
    expect(renderObjectActionsDocs()).toContain('## New Database')
  })
  it('declares the database node\'s Tasks (Take Offline, Bring Online, Restore › Database… and Files and Filegroups…) and the Databases folder\'s Restore Database… and Restore Files and Filegroups…, hidden where they do not apply', () => {
    const commands = { isEnabled: () => true, isToggled: () => false }, keybindings = { lookup: () => undefined }
    const titles = (items: readonly ResolvedMenuItem[]): string[] => items.flatMap(item => item.kind === 'submenu' ? [item.title + ' >', ...titles(item.items).map(title => '  ' + title)] : item.kind === 'command' ? [item.title] : [])
    const resolve = (model?: (menu: MenuId) => readonly MenuEntry[], lost = false, subtype?: NodeSubtype) => {
      const state = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionKind: 'database', ...actionContextValues(actionMenuState({ kind: 'database', subtype })) })
      return titles(resolveMenu('explorer.context', { platform: 'win32', state, target: { explorerNode: 'database', explorerServerLost: lost }, commands, keybindings, ...model ? { model } : {} }))
    }
    // D3a and D3b: Tasks › Detach…, then Take Offline and Bring Online on a user database (SSMS's order, recalled), then D1f's Restore › Database… and
    // D1g's Files and Filegroups… after the state group; never Restore Database… or Restore Files and Filegroups… itself, which are the folder's.
    const shown = resolve()
    expect(shown.slice(shown.indexOf('Tasks >'), shown.indexOf('Tasks >') + 7)).toEqual(['Tasks >', '  Detach…', '  Take Offline', '  Bring Online', '  Restore >', '    Database…', '    Files and Filegroups…'])
    expect(shown.filter(title => title.startsWith('  '))).toEqual(['  Detach…', '  Take Offline', '  Bring Online', '  Restore >', '    Database…', '    Files and Filegroups…'])
    expect(shown).not.toContain('Restore Database…')
    expect(shown).not.toContain('Restore Files and Filegroups…')
    // Detach… sits in a group of its own before the state group (L5 C2): a separator parts it from Take Offline.
    const tasksMenu = buildMenuModel('explorer.tasks', 'win32').map(entry => entry.kind === 'command' ? entry.id : entry.kind === 'separator' ? '---' : '')
    expect(tasksMenu.slice(0, 4)).toEqual(['explorer.detachDatabase', '---', 'explorer.takeOffline', 'explorer.bringOnline'])
    // A snapshot offers no task: Tasks hides as a submenu of nothing; on a lost server it hides too.
    expect(resolve(undefined, false, 'snapshot').some(title => title.startsWith('Tasks'))).toBe(false)
    expect(resolve(undefined, true).some(title => title.startsWith('Tasks'))).toBe(false)
    // A submenu with nothing placed in it stays out: Restore hides, and Tasks keeps Detach… and the state group.
    const model = (menu: MenuId) => menu === 'explorer.tasks.restore' ? [] as MenuEntry[] : buildMenuModel(menu, 'win32')
    expect(resolve(model).filter(title => title.startsWith('  '))).toEqual(['  Detach…', '  Take Offline', '  Bring Online'])
    // The Databases folder's Restore Database… (R) and Restore Files and Filegroups… (E), and no Tasks there.
    const folderState = contextRecord('win32', { backendReady: true, hasConnection: true, explorerHasSelection: true, explorerSelectionKind: 'folder', ...actionContextValues(actionMenuState({ kind: 'folder', folder: 'databases' })) })
    const folder = titles(resolveMenu('explorer.context', { platform: 'win32', state: folderState, target: { explorerNode: 'folder', explorerServerLost: false }, commands, keybindings }))
    expect(folder).toContain('Restore Database…')
    expect(folder).toContain('Restore Files and Filegroups…')
    expect(folder.some(title => title.startsWith('Tasks'))).toBe(false)
    // docs/object-actions.md names them as the menus do (its generator loads in plain Node, without menus.ts).
    expect(renderObjectActionsDocs()).toContain(`${submenus['explorer.tasks'].title} (\`explorer.tasks\`) and ${submenus['explorer.tasks'].title} › ${submenus['explorer.tasks.restore'].title} (\`explorer.tasks.restore\`)`)
  })
  it('keeps the limits and error codes', () => {
    expect(actionLimits).toMatchObject({ describeMs: 40_000, scriptMs: 25_000, readPerConnection: 2, readTotal: 4, executePerConnection: 1, executeTotal: 2, registered: 128, cancelIds: 16, newName: 128,
      files: 1_024, filegroups: 256, logins: 1_024, collations: 8_192, statements: 512, scriptChars: 1_000_000, detachFiles: 256, filePath: 260 })
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
