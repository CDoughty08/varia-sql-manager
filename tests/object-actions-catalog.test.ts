import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  actionCommandEntries, actionContextKey, actionContextValues, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenuState, actionOffered, actionRow,
  actionsCatalogJson, dialogIds, dialogSpecs, objectActions, objectActionSpecs, scriptActionTitles, unknownOutcomeMessage
} from '../src/shared/actions/catalog'
import { renderObjectActionsDocs } from '../src/shared/actions/docs'
import { codicons, commandDescriptor, commandIds, isCommandId } from '../src/shared/commands/catalog'
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
    expect(actionMenuState({ kind: 'folder' })).toEqual({ selectTop: '', rename: '', delete: '' })
    expect(actionMenuState({ kind: 'login' })).toEqual({ selectTop: '', rename: '', delete: '' })
  })
  it('offers SSMS\'s actions per kind, greying SQL Server\'s own objects and the subtypes that need more handling', () => {
    expect(states('table')).toBe('enabled enabled enabled')
    for (const subtype of ['graphNode', 'graphEdge'] as const) expect(states('table', subtype), subtype).toBe('enabled enabled enabled')
    for (const subtype of ['system', 'systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'ledgerHistory', 'fileTable', 'external'] as const) {
      expect(states('table', subtype), subtype).toBe('enabled disabled disabled')
    }
    expect(states('table', 'droppedLedger')).toBe('- disabled disabled')
    expect(states('view')).toBe('enabled enabled enabled')
    for (const subtype of ['system', 'ledger'] as const) expect(states('view', subtype), subtype).toBe('enabled disabled disabled')
    expect(states('view', 'droppedLedger')).toBe('- disabled disabled')
    for (const subtype of [undefined, 'sql', 'clr'] as const) expect(states('procedure', subtype), String(subtype)).toBe('- enabled enabled')
    for (const subtype of ['system', 'extended', 'replicationFilter'] as const) expect(states('procedure', subtype), subtype).toBe('- disabled disabled')
    for (const subtype of every('function').filter(subtype => subtype !== 'aggregate')) expect(states('function', subtype), String(subtype)).toBe('- enabled enabled')
    expect(states('function', 'aggregate')).toBe('- enabled disabled')
    expect([states('database'), states('database', 'system'), states('database', 'snapshot')]).toEqual(['- enabled enabled', '- disabled disabled', '- disabled enabled'])
    expect(actionOffered('database', 'rename') && actionOffered('function', 'delete') && !actionOffered('login', 'delete') && !actionOffered('procedure', 'selectTop')).toBe(true)
  })
  it('publishes one context key per action', () => {
    expect(objectActions.map(actionContextKey)).toEqual(['explorerActionSelectTop', 'explorerActionRename', 'explorerActionDelete'])
    expect(actionContextValues(actionMenuState({ kind: 'database', subtype: 'snapshot' }))).toEqual({ explorerActionSelectTop: '', explorerActionRename: 'disabled', explorerActionDelete: 'enabled' })
  })
  it('generates the three commands, keeping explorer.selectTopRows, with valid keys, preconditions and placements', () => {
    const entries = actionCommandEntries()
    expect(Object.keys(entries)).toEqual(objectActions.map(action => objectActionSpecs[action].command))
    expect(Object.keys(entries)).toContain('explorer.selectTopRows')
    expect(new Set(commandIds).size).toBe(commandIds.length)
    for (const [id, entry] of Object.entries(entries)) {
      expect(isCommandId(id), id).toBe(true)
      expect(commandDescriptor(id as never)).toEqual(entry)
      expect(codicons, id).toContain(entry.icon)
      expect(whenProblems(entry.precondition, ['static', 'state']), id).toEqual([])
      for (const placement of entry.menus) expect(whenProblems(placement.when, ['static', 'state', 'target']), id).toEqual([])
      for (const binding of entry.keybindings ?? []) expect(whenProblems(binding.when, ['static', 'state', 'focus']), id).toEqual([])
    }
    expect(entries['explorer.selectTopRows']).toMatchObject({ title: 'Select Top 1000 Rows', titleSetting: { setting: 'objectExplorer.selectTopRows', template: 'Select Top {n} Rows' },
      precondition: "backendReady && explorerActionSelectTop == 'enabled' && !documentBusy" })
    expect(entries['explorer.rename'].precondition).toBe("backendReady && explorerActionRename == 'enabled'")
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
  })
  it('declares the Delete Object dialog with SSMS\'s page and Script button wording', () => {
    expect(dialogIds).toEqual(['deleteObject'])
    expect(dialogSpecs.deleteObject).toEqual({ title: 'Delete Object', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] })
    expect(scriptDestinations.map(destination => scriptActionTitles[destination])).toEqual(['Script Action to New Query Window', 'Script Action to File', 'Script Action to Clipboard'])
    expect(unknownOutcomeMessage).toBe('The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.')
  })
  it('keeps the limits and error codes', () => {
    expect(actionLimits).toMatchObject({ describeMs: 40_000, scriptMs: 25_000, readPerConnection: 2, readTotal: 4, executePerConnection: 1, executeTotal: 2, registered: 128, cancelIds: 16, newName: 128 })
    expect(actionErrorCodes.filter(code => !actionErrorRetryable[code])).toEqual(['NOT_FOUND', 'NOT_SUPPORTED', 'DEPENDENTS', 'NAME_IN_USE', 'INVALID_NAME'])
  })
  it('loads in plain Node 24, as the fake backend and scripts load the other catalogues', () => {
    const files = ['catalog.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'actions', name))
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
