import { commandDescriptor, commandIds, isCommandId, type CommandId } from '../../../shared/commands/catalog'
import type { ObjectSearchHit } from '../../../shared/explorer/search.ts'
import { commandTitle } from '../../../shared/settings/catalog'
import { onUnexpectedError } from '../core/errors'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { CommandHistory } from '../quickinput/history'
import type { QuickInputAnchor, QuickInputMessage, QuickPickAnswerItem, QuickPickItem, QuickPickOptions } from '../quickinput/QuickInputService'
import { hitIcon } from '../search/hit-actions'
import { quickSearchId, serverGroups, serverHitKey } from '../search/ObjectSearchService'

/**
 * Quick access modes by prefix: commands, help, and no prefix, which is Go to Query, or Search when the header's search
 * box opened the widget. '@', '#', and ':' are reserved and stay plain text.
 */
export type QuickAccessMode = '>' | '?' | ''
export const quickAccessMode = (value: string): QuickAccessMode => value.startsWith('>') ? '>' : value.startsWith('?') ? '?' : ''
const recentLimit = 10
/**
 * Commands that leave an open quick input alone: its own keys, and the Edit commands that act on the focused text field.
 * On macOS ⌘Z and ⌘A in the input arrive as the Edit menu's Undo and Select All (as does Edit › Delete), and closing
 * first would act on the editor instead.
 */
const keepsQuickInput: ReadonlySet<CommandId> = new Set(['workbench.showCommands', 'workbench.quickOpen', 'workbench.search', 'edit.undo', 'edit.redo', 'edit.selectAll', 'edit.delete'])
type Picker = Omit<QuickPickOptions<QuickPickItem>, 'value' | 'prefix' | 'anchor' | 'onDidChangeValue' | 'onDidHide'>
export type PaletteWorkbench = Pick<Workbench, 'commands' | 'keybindings' | 'quickInput' | 'documents' | 'connections' | 'events'> & Partial<Pick<Workbench, 'settings' | 'explorer' | 'objectSearch'>>
/** What no prefix searches: open queries (Go to Query), or open queries, commands and the servers' objects (Search). */
type Scope = 'queries' | 'search'
/** The groups Search lists, in this order. */
export const searchGroups = { queries: 'open queries', commands: 'commands', objects: 'objects' } as const
/** Search's last row: the same text in a Search Objects tab, with every hit, definitions and the filters. */
export const seeAllObjects = 'See all in Search Objects'
const seeAllId = 'objects:all'
const count = (value: number) => value.toLocaleString('en-US')

/**
 * The command palette (F1, mod+Shift+P), Go to Query (mod+P) and Search (the header's search box): one quick input whose
 * provider follows the prefix the user types. Any other command closes it first, so focus is back where it was when that
 * command runs.
 */
export function paletteContribution(workbench: PaletteWorkbench, history = new CommandHistory()): Disposable {
  const { commands, keybindings, quickInput, documents, connections, events } = workbench
  // Most recently activated first, so Go to Query can offer the previous query.
  const initial = documents.getSnapshot()
  let recentDocuments = [initial.activeId, ...initial.documents.map(document => document.id)].filter((id, index, ids) => id && ids.indexOf(id) === index)
  let token = 0, mode: QuickAccessMode | undefined, scope: Scope = 'queries'
  /** The search box, while the widget it opened is open: every mode stays below it. Keys open the widget centred. */
  let anchor: QuickInputAnchor | undefined
  /** What the open Search's object rows stand for, by row id, and the text they answer. */
  let found: { readonly text: string; readonly hits: ReadonlyMap<string, { readonly connectionId: string; readonly hit: ObjectSearchHit }> } = { text: '', hits: new Map() }

  const commandItems = (): QuickPickItem[] => commandIds.filter(id => commandDescriptor(id).palette !== false && commands.has(id)).map(id => {
      // Titles follow settings ("Select Top 50 Rows").
      const command = commandDescriptor(id), title = commandTitle(id, workbench.settings?.getSnapshot().values), label = command.category ? `${command.category}: ${title}` : title
      // The handler's own reason first (a greyed action's, such as an offline database's Rename), then the catalogue's.
      const unavailable = commands.isEnabled(id) ? {} : { disabled: true, disabledHint: commands.unavailableReason(id) ?? command.unavailableHint ?? `“${label}” is not available right now.` }
      // The category ("Query: ") does not count as the start of the name, so a match there ranks no higher than one in the title.
      return { id, label, titleStart: label.length - title.length, icon: command.icon, keywords: command.keywords, keybinding: keybindings.lookup(id), ...unavailable }
    }).sort((a, b) => a.label.localeCompare(b.label, 'en'))
  const runCommand = (id: string) => {
    if (!isCommandId(id)) return
    history.record(id)
    void commands.execute(id, undefined, 'palette')
  }
  const commandPicker = (): Picker => ({
    ariaLabel: 'Command Palette', placeholder: 'Type the name of a command to run', noun: 'commands', sort: 'score', recentIds: history.ids.slice(0, recentLimit),
    items: commandItems(), onDidAccept: item => runCommand(item.id)
  })
  const queryItems = (): QuickPickItem[] => {
    const { documents: open } = documents.getSnapshot(), live = connections.getSnapshot()
    const ordered = [...recentDocuments.flatMap(id => open.filter(document => document.id === id)), ...open.filter(document => !recentDocuments.includes(document.id))]
    return ordered.map(document => {
      const connection = live.find(value => value.id === document.connectionId)
      const server = connection ? connection.displayName || connection.server : 'Disconnected'
      return { id: document.id, label: document.name, icon: 'go-to-file', description: [...document.dirty ? ['unsaved'] : [], server, document.database].join(' · '), tooltip: document.file?.path }
    })
  }
  const queryPicker = (): Picker => {
    const items = queryItems()
    return {
      ariaLabel: 'Go to Query', placeholder: 'Search open queries by name (type > for commands, ? for help)', noun: 'queries', sort: 'score', matchOnDescription: true, items,
      // The previous query is active, so mod+P then Enter switches between the last two.
      activeId: items[1]?.id ?? items[0]?.id,
      onDidAccept: item => { documents.activate(item.id); documents.focusActive() }
    }
  }
  /**
   * Search's objects are Search Objects' own search (ObjectSearchService, on the backend's index), asked by name on every
   * connected server as the user types: nothing here matches an object's name, the tree is not read, and no index is built. The rows follow the
   * queries and commands as each server answers, with a last row that takes the text to a Search Objects tab.
   */
  function searchObjects(text: string): { search(text: string): void; dispose(): void } | undefined {
    const { objectSearch } = workbench
    if (!objectSearch) return undefined
    let shown: unknown, wasIndexing = false, latest = text, said: QuickInputMessage | undefined
    const push = () => {
      const snapshot = objectSearch.getSnapshot(), document = snapshot.documents[quickSearchId]
      const indexing = connections.getSnapshot().some(connection => snapshot.indexes[connection.id]?.requestId)
      // Index progress publishes several times a second; the rows change only with the search, or when a build starts or ends.
      if (document === shown && indexing === wasIndexing) return
      shown = document
      wasIndexing = indexing
      // With the last server gone the box is back to queries and commands, as it is before one connects.
      if (!document?.text.trim() || !connections.live().length) { found = { text: '', hits: new Map() }; said = undefined; quickInput.setAnswer({ items: [] }); return }
      // Only hits that answer the text as it is now: the answer to the text before is not offered while the new one is on
      // its way, or Enter would reveal an object the text no longer names.
      const current = document.asked?.text === document.text
      const hits = new Map<string, { connectionId: string; hit: ObjectSearchHit }>(), items: QuickPickAnswerItem[] = [], groups = current ? serverGroups(document) : []
      for (const group of groups) for (const hit of group.hits) {
        // The row is the object on its server, wherever it is in the list: a server that answers later moves the rows, and
        // the active one stays on its object.
        const id = 'object:' + serverHitKey(group.connectionId, hit)
        if (hits.has(id)) continue
        hits.set(id, { connectionId: group.connectionId, hit })
        items.push({
          id, label: hit.label, description: [group.label, hit.object.database].filter(Boolean).join(' › '), icon: hitIcon(hit), group: searchGroups.objects,
          ...hit.range ? { ranges: [[hit.range[0], hit.range[0] + hit.range[1]]] } : {}
        })
      }
      const total = current ? document.result?.total ?? 0 : 0
      items.push({ id: seeAllId, label: seeAllObjects, icon: 'search', group: searchGroups.objects, description: total > hits.size ? `Showing ${count(hits.size)} of ${count(total)} objects` : 'Names and definitions, with filters' })
      found = { text: document.text, hits }
      const failed = groups.find(group => group.error)
      // Search never builds an index: a server without one says so, with where to build it.
      const bare = groups.filter(group => group.result?.index.state === 'none' && !snapshot.indexes[group.connectionId]?.requestId)
      const message: QuickInputMessage | undefined = document.error ? { text: document.error, severity: 'error' }
        : failed ? { text: `${failed.label}: ${failed.error}`, severity: 'error' }
        : bare.length ? { text: `${bare.length === 1 ? `${bare[0]!.label} has` : `${count(bare.length)} servers have`} no search index: ${seeAllObjects} builds it`, severity: 'info' }
        : indexing ? { text: 'Indexing objects: more may be found when it finishes', severity: 'info' } : undefined
      // The same message is the same object, so the live region says it once, not with every key and every answer.
      if (message && !(said && said.text === message.text && said.severity === message.severity)) said = message
      quickInput.setAnswer({ items, busy: !(current && !document.requestId) && !document.error, ...message && said ? { message: said } : {} })
    }
    const unsubscribe = objectSearch.subscribe(push)
    // A server that connects while the box has text is searched too, though nothing was asked while there was none.
    const unfollow = connections.subscribe(() => { if (!objectSearch.getSnapshot().documents[quickSearchId]) objectSearch.quickSearch(latest) })
    objectSearch.quickSearch(text)
    return { search: value => { latest = value; objectSearch.quickSearch(value) }, dispose: () => { unsubscribe(); unfollow(); objectSearch.endQuickSearch() } }
  }
  /** Reveal in Object Explorer, as a Search Objects hit's: the tree loads and expands its way to the object, and takes focus as F8 gives it. */
  const revealObject = (connectionId: string, hit: ObjectSearchHit) => {
    const { objectSearch, explorer } = workbench
    if (!objectSearch || !explorer) return
    void commands.execute('window.explorer', undefined, 'palette')
    void objectSearch.reveal(explorer, connectionId, hit).then(outcome => { if (!outcome.ok && !outcome.cancelled) commands.reportError(outcome.message) }, onUnexpectedError)
  }
  const openSearchObjects = (text: string) => {
    const live = connections.live()
    // With Fuzzy Match, as the rows were found, so the tab has every hit they were the first of.
    try { workbench.objectSearch?.open(live.length > 1 ? undefined : live[0]?.id, text, live.length > 1, undefined, true) }
    catch (error) { commands.reportError(error instanceof Error ? error.message : 'Search Objects could not open.') }
  }
  // Each row's id says which list it is from.
  const searchPicker = (): Picker => {
    const queries = queryItems().map(item => ({ ...item, id: 'query:' + item.id, group: searchGroups.queries }))
    return {
      ariaLabel: 'Search', placeholder: 'Search open queries, commands and objects (type > for commands, ? for help)', noun: 'items', sort: 'grouped', matchOnDescription: true,
      items: [...queries, ...commandItems().map(item => ({ ...item, id: 'command:' + item.id, group: searchGroups.commands }))],
      // The previous query, as in Go to Query, so Enter switches back.
      activeId: queries[1]?.id,
      onDidAccept: item => {
        const at = item.id.indexOf(':'), kind = item.id.slice(0, at), id = item.id.slice(at + 1)
        if (kind === 'query') { documents.activate(id); documents.focusActive() }
        else if (kind === 'command') runCommand(id)
        else if (item.id === seeAllId) openSearchObjects(found.text)
        else if (kind === 'object') { const object = found.hits.get(item.id); if (object) revealObject(object.connectionId, object.hit) }
      }
    }
  }
  // The name replaces what the row shows (an option's children are not read), so it carries the key too.
  const helpItem = (id: string, label: string, description: string, hint: string, command: CommandId): QuickPickItem => {
    const keybinding = keybindings.lookup(command)
    return { id, label, description, keybinding, ariaLabel: [description, hint, keybinding?.aria].filter(Boolean).join(', ') }
  }
  const helpPicker = (): Picker => ({
    ariaLabel: 'Quick Access Help', placeholder: 'Select what to search', noun: 'modes', sort: 'none', matchOnDescription: true, hideOnAccept: false,
    items: [
      scope === 'search' ? helpItem('', '…', 'Search', 'type a query, command or object name', 'workbench.search') : helpItem('', '…', 'Go to Query', 'type a query name', 'workbench.quickOpen'),
      helpItem('>', '>', 'Run Command', 'type > and a command name', 'workbench.showCommands')
    ],
    onDidAccept: item => quickInput.setValue(item.id, 'end')
  })
  /** Opens (or switches to) the mode for `value`, keeping the value and where focus returns. */
  function open(value: string, nextScope: Scope = scope, from?: QuickInputAnchor): void {
    if (!quickInput.visible) anchor = from
    const next = quickAccessMode(value), session = ++token
    mode = next
    scope = nextScope
    const picker = next === '>' ? commandPicker() : next === '?' ? helpPicker() : scope === 'search' ? searchPicker() : queryPicker()
    let objects: ReturnType<typeof searchObjects>
    quickInput.show({
      ...picker, value, prefix: next, ...anchor ? { anchor } : {},
      onDidChangeValue: text => { if (quickAccessMode(text) !== next) open(text); else objects?.search(text) },
      onDidHide: () => { objects?.dispose(); if (session === token) mode = undefined }
    })
    // After the widget shows, so the mode this one replaced has ended its own search first.
    if (next === '' && scope === 'search' && quickInput.visible && session === token) objects = searchObjects(value)
  }

  const registrations = [
    // F1 while Search is open keeps Search for when the prefix is deleted; anything else starts from Go to Query.
    commands.register('workbench.showCommands', { run: () => { if (quickInput.visible && mode === '>') quickInput.setValue(quickInput.value, 'afterPrefix'); else open('>', quickInput.visible ? scope : 'queries') } }),
    commands.register('workbench.quickOpen', { run: () => { if (quickInput.visible && mode === '' && scope === 'queries') quickInput.setValue(quickInput.value, 'all'); else open('', 'queries') } }),
    // Only the search box passes itself; Ctrl+Q and View › Search open the widget where F1 does.
    commands.register('workbench.search', { run: args => { if (quickInput.visible && mode === '' && scope === 'search') quickInput.setValue(quickInput.value, 'all'); else open('', 'search', args?.anchor) } }),
    commands.onWillExecute(({ id, source }) => {
      if (quickInput.visible && source !== 'palette' && !keepsQuickInput.has(id)) quickInput.hide('cancel')
    }),
    events.subscribe(event => {
      if (event.type === 'documents.activated' && event.tabId) recentDocuments = [event.tabId, ...recentDocuments.filter(id => id !== event.tabId)]
      else if (event.type === 'documents.closed') recentDocuments = recentDocuments.filter(id => id !== event.tabId)
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
