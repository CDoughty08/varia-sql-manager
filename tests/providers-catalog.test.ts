import { describe, expect, it, vi } from 'vitest'
import { commandAllowsProvider, commandDescriptor, commandIds, commandProviderKey, commandProviders, type CommandId } from '../src/shared/commands/catalog'
import { contextKeyValues, contextRecord, type ContextKey } from '../src/shared/commands/context-keys'
import { submenuIds, submenus } from '../src/shared/commands/menus'
import { comparisons, parseWhen } from '../src/shared/commands/when'
import { kindSpecs, nodeKinds } from '../src/shared/explorer/catalog'
import { objectActionSpecs, serverActionSpecs } from '../src/shared/actions/catalog'
import { liveSources } from '../src/shared/live/catalog'
import { scriptKindSpecs } from '../src/shared/scripting/catalog'
import { settingPages } from '../src/shared/settings/catalog'
import { methodProviders } from '../src/shared/ipc/methods'
import { providerIds, providersOf, type ProviderId } from '../src/shared/providers'
import type { BackendMethod } from '../src/shared/contracts'
import { resolveMenu } from '../src/renderer/src/menus/resolve'
import { KeybindingService } from '../src/renderer/src/core/keybindings'
import { CommandService } from '../src/renderer/src/core/commands'
import { argsFor, type ExplorerMenuNode } from '../src/renderer/src/menus/targets'

const providerKeys: readonly ContextKey[] = ['activeDocumentProvider', 'explorerProvider', 'explorerSelectionProvider']
/** The providers a when clause compares a provider key with; an entry naming one must declare it. */
function providersNamed(source: string | undefined): ProviderId[] {
  if (source === undefined) return []
  return comparisons(parseWhen(source)).filter(({ key }) => (providerKeys as readonly string[]).includes(key)).map(({ value }) => value).filter((value): value is ProviderId => (providerIds as readonly unknown[]).includes(value))
}
interface Entry { readonly name: string; readonly providers: readonly ProviderId[]; readonly when: readonly (string | undefined)[]; readonly methods: readonly BackendMethod[] }
/** Every catalogue entry with providers, the when clauses it shows under, and the methods it runs. */
const entries: Entry[] = [
  ...commandIds.map(id => {
    const command = commandDescriptor(id)
    return { name: `command ${id}`, providers: commandProviders(id), when: [command.precondition, command.toggled, ...(command.menus ?? []).map(placement => placement.when), ...(command.keybindings ?? []).map(binding => binding.when)], methods: command.methods ?? [] }
  }),
  ...submenuIds.map(id => ({ name: `submenu ${id}`, providers: providersOf(submenus[id]), when: submenus[id].placements.map(placement => placement.when), methods: [] })),
  ...nodeKinds.map(kind => ({ name: `Explorer kind ${kind}`, providers: providersOf(kindSpecs[kind]), when: [], methods: ['explorer.children'] as BackendMethod[] })),
  ...Object.entries(objectActionSpecs).map(([action, spec]) => ({ name: `object action ${action}`, providers: providersOf(spec), when: [], methods: ['actions.describe', 'actions.script', 'actions.execute'] as BackendMethod[] })),
  ...Object.entries(serverActionSpecs).map(([action, spec]) => ({ name: `server action ${action}`, providers: providersOf(spec), when: [], methods: ['actions.describe', 'actions.execute'] as BackendMethod[] })),
  ...Object.entries(liveSources).map(([source, spec]) => ({ name: `live source ${source}`, providers: providersOf(spec), when: [], methods: ['live.subscribe', 'live.update'] as BackendMethod[] })),
  ...Object.values(scriptKindSpecs).map(spec => ({ name: `Script As kind ${spec.kind}`, providers: providersOf('providers' in spec ? spec : undefined), when: [], methods: ['scripting.script'] as BackendMethod[] })),
  ...settingPages.map(page => ({ name: `settings page ${page.id}`, providers: providersOf(page), when: [], methods: [] }))
]

describe('catalogue providers', () => {
  it('declares only known providers, each once, and defaults to SQL Server only', () => {
    for (const entry of entries) {
      expect(entry.providers.length, entry.name).toBeGreaterThan(0)
      expect(new Set(entry.providers).size, entry.name).toBe(entry.providers.length)
      for (const provider of entry.providers) expect(providerIds, entry.name).toContain(provider)
    }
    expect(commandProviders('query.estimatePlan')).toEqual(['sqlserver'])
    expect(commandProviders('activity.open')).toEqual(['sqlserver'])
    expect(providersOf(liveSources[Object.keys(liveSources)[0] as keyof typeof liveSources])).toEqual(['sqlserver'])
    for (const key of providerKeys) expect(contextKeyValues(key)).toEqual(['', 'sqlserver', 'bigquery'])
  })

  it('an entry whose when clause names a provider declares it', () => {
    const problems = entries.flatMap(entry => entry.when.flatMap(providersNamed).filter(provider => !entry.providers.includes(provider)).map(provider => `${entry.name} names ${provider} but declares ${entry.providers.join(', ')}`))
    expect(problems).toEqual([])
    // The lint reads comparisons in either order and through negation.
    expect(providersNamed("activeDocumentProvider == 'bigquery' && !explorerServerLost")).toEqual(['bigquery'])
    expect(providersNamed("explorerProvider != 'sqlserver'")).toEqual(['sqlserver'])
    expect(providersNamed('hasActiveDocument')).toEqual([])
  })

  it('an entry that declares BigQuery runs only methods that serve BigQuery', () => {
    const problems = entries.filter(entry => entry.providers.includes('bigquery'))
      .flatMap(entry => entry.methods.filter(method => !methodProviders(method).includes('bigquery')).map(method => `${entry.name} declares bigquery but runs ${method}`))
    expect(problems).toEqual([])
    // Job History's live source and Object Explorer's BigQuery chip are BigQuery's alone, and no other live source or
    // action is declared for BigQuery yet;
    // Object Explorer's and Script As' BigQuery kinds are BigQuery's alone, and the connection node serves both engines.
    for (const entry of entries.filter(entry => /^(live source|object action|server action) /.test(entry.name))) expect(entry.providers, entry.name).toEqual(['live source bigquery.jobs', 'live source bigquery.explorer'].includes(entry.name) ? ['bigquery'] : ['sqlserver'])
    for (const entry of entries.filter(entry => /^(Script As kind|Explorer kind) /.test(entry.name)))
      expect(entry.providers, entry.name).toEqual(/ bq[A-Z]/.test(entry.name) ? ['bigquery'] : entry.name === 'Explorer kind server' ? ['sqlserver', 'bigquery'] : ['sqlserver'])
    // The methods named are real methods with policies.
    for (const entry of entries) for (const method of entry.methods) expect(() => methodProviders(method), `${entry.name} ${method}`).not.toThrow()
  })

  it('declares both engines on the provider-neutral commands and keeps the SQL Server ones to SQL Server', () => {
    const both: CommandId[] = ['file.new', 'file.save', 'file.close', 'edit.undo', 'edit.find', 'edit.commentLines', 'output.copy', 'output.saveResultsAs', 'output.pivot', 'query.execute', 'query.cancel', 'layout.reset', 'workbench.showCommands', 'preferences.options', 'help.about', 'backend.restart', 'explorer.collapseAll',
      'explorer.refresh', 'explorer.scriptAs', 'explorer.scriptCreateToNewQuery', 'edit.goToDefinition', 'edit.peekDefinition', 'edit.openPeekTab', 'edit.commasToFront', 'edit.commasToEnd']
    const sqlServer: CommandId[] = ['query.newSpWho', 'query.estimatePlan', 'query.includeActualPlan', 'edit.toggleBrackets', 'edit.insertSnippet', 'window.plan', 'activity.open', 'explorer.modify', 'help.clearEntraTokenCache', 'connection.connect']
    // BigQuery's own Object Explorer commands.
    for (const id of ['explorer.previewRows', 'explorer.bigQueryProperties'] as const) expect(commandProviders(id), id).toEqual(['bigquery'])
    for (const id of both) expect(commandProviders(id), id).toEqual(['sqlserver', 'bigquery'])
    for (const id of sqlServer) expect(commandProviders(id), id).toEqual(['sqlserver'])
    expect(providersOf(submenus['edit.advanced'])).toEqual(['sqlserver', 'bigquery'])
    expect(providersOf(submenus['explorer.tasks'])).toEqual(['sqlserver'])
    expect(providersOf(settingPages.find(page => page.id === 'textEditor.general'))).toEqual(['sqlserver', 'bigquery'])
    expect(providersOf(settingPages.find(page => page.id === 'queryExecution.sqlServer.general'))).toEqual(['sqlserver'])
  })

  it("generates each object and server action's command with its spec's providers", () => {
    for (const spec of [...Object.values(objectActionSpecs), ...Object.values(serverActionSpecs)]) expect(commandProviders(spec.command), spec.command).toEqual(providersOf(spec))
    expect(commandDescriptor(objectActionSpecs.rename.command)).not.toHaveProperty('providers')
  })

  it('checks a command against the active document, or the Explorer selection for a command that acts on it', () => {
    const keys = (activeDocumentProvider: '' | ProviderId, explorerSelectionProvider: '' | ProviderId) => ({ activeDocumentProvider, explorerSelectionProvider })
    expect(commandProviderKey('query.estimatePlan')).toBe('activeDocumentProvider')
    expect(commandProviderKey('explorer.refresh')).toBe('explorerSelectionProvider')
    // A command of another category acts on the active document from the toolbar, keys and palette, and on the object its
    // menu was opened for from Object Explorer's or a search result's menu.
    for (const id of ['connection.disconnect', 'connection.reconnect', 'activity.open', 'ssis.folderProperties'] as const) {
      expect(commandProviderKey(id), id).toBe('activeDocumentProvider')
      expect(commandProviderKey(id, true), id).toBe('explorerSelectionProvider')
    }
    expect(commandAllowsProvider('activity.open', keys('bigquery', 'sqlserver'))).toBe(false)
    expect(commandAllowsProvider('activity.open', keys('bigquery', 'sqlserver'), true)).toBe(true)
    expect(commandAllowsProvider('activity.open', keys('sqlserver', 'bigquery'), true)).toBe(false)
    // Disconnect, New Query and the dataset box serve a BigQuery connection too.
    for (const id of ['connection.disconnect', 'connection.reconnect', 'explorer.newQuery', 'query.changeDatabase', 'query.disconnect'] as const) expect(commandAllowsProvider(id, keys('bigquery', 'bigquery'), true), id).toBe(true)
    // The comma commands read either language's tokens, so they serve both engines' queries; Toggle Brackets reads T-SQL's only.
    for (const id of ['edit.commasToFront', 'edit.commasToEnd'] as const) {
      expect(commandAllowsProvider(id, keys('bigquery', 'sqlserver')), id).toBe(true)
      expect(commandAllowsProvider(id, keys('sqlserver', 'bigquery')), id).toBe(true)
    }
    expect(commandAllowsProvider('edit.toggleBrackets', keys('bigquery', 'sqlserver'))).toBe(false)
    expect(commandAllowsProvider('edit.toggleBrackets', keys('sqlserver', 'bigquery'))).toBe(true)
    // Greyed in a BigQuery tab, its reason names the engine rather than asking for a query that is already open.
    expect(commandDescriptor('edit.toggleBrackets').unavailableHint).toBe('Open a SQL Server query first.')
    expect(commandAllowsProvider('query.estimatePlan', keys('sqlserver', ''))).toBe(true)
    expect(commandAllowsProvider('query.estimatePlan', keys('bigquery', 'sqlserver'))).toBe(false)
    expect(commandAllowsProvider('query.estimatePlan', keys('', 'bigquery'))).toBe(true)
    expect(commandAllowsProvider('query.execute', keys('bigquery', ''))).toBe(true)
    expect(commandAllowsProvider('explorer.modify', keys('sqlserver', 'bigquery'))).toBe(false)
    expect(commandAllowsProvider('explorer.refresh', keys('sqlserver', 'bigquery'))).toBe(true)
    expect(commandAllowsProvider('explorer.collapseAll', keys('', 'bigquery'))).toBe(true)
    expect(commandAllowsProvider('output.copy', keys('bigquery', ''))).toBe(true)
  })

  it('CommandService refuses a command for another engine, and SQL Server keeps every command', async () => {
    let state = contextRecord('win32', { activeDocumentProvider: 'sqlserver', hasActiveDocument: true, activeDocumentIsQuery: true, activeDocumentConnected: true, backendReady: true })
    const commands = new CommandService({ state: () => state })
    const ran: string[] = []
    for (const id of ['query.estimatePlan', 'edit.undo'] as const) commands.register(id, { run: () => { ran.push(id) } })
    expect(commands.isEnabled('query.estimatePlan') && commands.isEnabled('edit.undo')).toBe(true)
    state = contextRecord('win32', { ...state, activeDocumentProvider: 'bigquery' })
    expect(commands.isEnabled('query.estimatePlan')).toBe(false)
    expect(commands.isEnabled('edit.undo')).toBe(true)
    await expect(commands.execute('query.estimatePlan', undefined, 'keybinding')).resolves.toBe(false)
    expect(ran).toEqual([])
    // On a SQL Server node (its menu, row buttons or jump menu, selected or not), a command acts on the node whatever the active
    // document and the selection are; from the toolbar, on the document; from the empty area's menu, as from the toolbar.
    commands.register('activity.open', { run: () => {} })
    const server: ExplorerMenuNode = { id: 1, connectionId: 'c', kind: 'server', label: 'sql-prod-01', ref: { type: 'server' }, lost: false } as unknown as ExplorerMenuNode
    state = contextRecord('win32', { ...state, explorerSelectionProvider: 'bigquery' })
    expect(commands.isEnabled('activity.open', argsFor({ kind: 'explorer', node: server }))).toBe(true)
    expect(commands.isEnabled('activity.open')).toBe(false)
    expect(commands.isEnabled('activity.open', argsFor({ kind: 'explorer' }))).toBe(false)
    // A node's toolbar or row button passes the bare node, with no stand-in state: its own engine still counts.
    expect(commands.isEnabled('activity.open', { target: { kind: 'explorer', node: server } })).toBe(true)
    // Connect and clearing the Entra token cache stay available whatever document is active.
    expect(commandProviderKey('connection.connect')).toBeUndefined()
    expect(commandProviderKey('help.clearEntraTokenCache')).toBeUndefined()
    // A command that finds its own object (a Peek card, a search hit) is checked by neither key.
    commands.register('search.copyName', { run: () => {} })
    expect(commandProviderKey('search.copyName')).toBeUndefined()
    expect(commandAllowsProvider('peek.refresh', { activeDocumentProvider: 'bigquery', explorerSelectionProvider: 'bigquery' })).toBe(true)
  })

  it("Object Explorer's menu leaves out items its node's engine has no use for", () => {
    const platform = 'win32'
    const keybindings = new KeybindingService({ platform, commands: { execute: vi.fn() }, context: { get: () => contextRecord(platform) }, modalOpen: () => false, editorHasTextFocus: () => false })
    const shown = (explorerProvider: '' | ProviderId) => resolveMenu('explorer.context', {
      platform, state: contextRecord(platform), commands: { isEnabled: () => true, isToggled: () => false }, keybindings,
      target: { explorerNode: 'server', explorerServerEngine: 'box', explorerProvider }
    }).flatMap(item => item.kind === 'command' ? [item.id] : [])
    const sqlServer = shown('sqlserver')
    expect(sqlServer).toContain('explorer.refresh')
    expect(sqlServer).toEqual(shown(''))
    const bigQuery = shown('bigquery')
    // Refresh reloads a BigQuery tree too; Activity Monitor is SQL Server's.
    expect(bigQuery).toContain('explorer.refresh')
    expect(sqlServer).toContain('activity.open')
    expect(bigQuery).not.toContain('activity.open')
    expect(bigQuery.every(id => commandProviders(id).includes('bigquery'))).toBe(true)
  })
})
