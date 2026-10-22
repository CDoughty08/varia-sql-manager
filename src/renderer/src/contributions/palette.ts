import { commandDescriptor, commandIds, isCommandId, type CommandId } from '../../../shared/commands/catalog'
import { commandTitle } from '../../../shared/settings/catalog'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { CommandHistory } from '../quickinput/history'
import type { QuickPickItem, QuickPickOptions } from '../quickinput/QuickInputService'

/** Quick access modes by prefix: commands, help, and (no prefix) Go to Query. '@', '#', and ':' are reserved and stay plain text. */
export type QuickAccessMode = '>' | '?' | ''
export const quickAccessMode = (value: string): QuickAccessMode => value.startsWith('>') ? '>' : value.startsWith('?') ? '?' : ''
const recentLimit = 10
/**
 * Commands that leave an open quick input alone: its own keys, and the Edit commands that act on the focused text field.
 * On macOS ⌘Z and ⌘A in the input arrive as the Edit menu's Undo and Select All (as does Edit › Delete), and closing
 * first would act on the editor instead.
 */
const keepsQuickInput: ReadonlySet<CommandId> = new Set(['workbench.showCommands', 'workbench.quickOpen', 'edit.undo', 'edit.redo', 'edit.selectAll', 'edit.delete'])
type Picker = Omit<QuickPickOptions<QuickPickItem>, 'value' | 'prefix' | 'onDidChangeValue' | 'onDidHide'>
export type PaletteWorkbench = Pick<Workbench, 'commands' | 'keybindings' | 'quickInput' | 'documents' | 'connections' | 'events'> & Partial<Pick<Workbench, 'settings'>>

/**
 * The command palette (F1, mod+Shift+P) and Go to Query (mod+P): one quick input whose provider follows the prefix the
 * user types. Any other command closes it first, so focus is back where it was when that command runs.
 */
export function paletteContribution(workbench: PaletteWorkbench, history = new CommandHistory()): Disposable {
  const { commands, keybindings, quickInput, documents, connections, events } = workbench
  // Most recently activated first, so Go to Query can offer the previous query.
  const initial = documents.getSnapshot()
  let recentDocuments = [initial.activeId, ...initial.documents.map(document => document.id)].filter((id, index, ids) => id && ids.indexOf(id) === index)
  let token = 0, mode: QuickAccessMode | undefined

  const commandPicker = (): Picker => ({
    ariaLabel: 'Command Palette', placeholder: 'Type the name of a command to run', noun: 'commands', sort: 'score', recentIds: history.ids.slice(0, recentLimit),
    items: commandIds.filter(id => commandDescriptor(id).palette !== false && commands.has(id)).map(id => {
      // Titles follow settings ("Select Top 50 Rows").
      const command = commandDescriptor(id), title = commandTitle(id, workbench.settings?.getSnapshot().values), label = command.category ? `${command.category}: ${title}` : title
      const unavailable = commands.isEnabled(id) ? {} : { disabled: true, disabledHint: command.unavailableHint ?? `“${label}” is not available right now.` }
      // The category ("Query: ") does not count as the start of the name, so a match there ranks no higher than one in the title.
      return { id, label, titleStart: label.length - title.length, icon: command.icon, keywords: command.keywords, keybinding: keybindings.lookup(id), ...unavailable }
    }).sort((a, b) => a.label.localeCompare(b.label, 'en')),
    onDidAccept: item => {
      if (!isCommandId(item.id)) return
      history.record(item.id)
      void commands.execute(item.id, undefined, 'palette')
    }
  })
  const queryPicker = (): Picker => {
    const { documents: open } = documents.getSnapshot(), live = connections.getSnapshot()
    const ordered = [...recentDocuments.flatMap(id => open.filter(document => document.id === id)), ...open.filter(document => !recentDocuments.includes(document.id))]
    const items: QuickPickItem[] = ordered.map(document => {
      const connection = live.find(value => value.id === document.connectionId)
      const server = connection ? connection.displayName || connection.server : 'Disconnected'
      return { id: document.id, label: document.name, icon: 'go-to-file', description: [...document.dirty ? ['unsaved'] : [], server, document.database].join(' · '), tooltip: document.file?.path }
    })
    return {
      ariaLabel: 'Go to Query', placeholder: 'Search open queries by name (type > for commands, ? for help)', noun: 'queries', sort: 'score', matchOnDescription: true, items,
      // The previous query is active, so mod+P then Enter switches between the last two.
      activeId: items[1]?.id ?? items[0]?.id,
      onDidAccept: item => { documents.activate(item.id); documents.focusActive() }
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
      helpItem('', '…', 'Go to Query', 'type a query name', 'workbench.quickOpen'),
      helpItem('>', '>', 'Run Command', 'type > and a command name', 'workbench.showCommands')
    ],
    onDidAccept: item => quickInput.setValue(item.id, 'end')
  })
  /** Opens (or switches to) the mode for `value`, keeping the value and where focus returns. */
  function open(value: string): void {
    const next = quickAccessMode(value), session = ++token
    mode = next
    const picker = next === '>' ? commandPicker() : next === '?' ? helpPicker() : queryPicker()
    quickInput.show({
      ...picker, value, prefix: next,
      onDidChangeValue: text => { if (quickAccessMode(text) !== next) open(text) },
      onDidHide: () => { if (session === token) mode = undefined }
    })
  }

  const registrations = [
    commands.register('workbench.showCommands', { run: () => { if (quickInput.visible && mode === '>') quickInput.setValue(quickInput.value, 'afterPrefix'); else open('>') } }),
    commands.register('workbench.quickOpen', { run: () => { if (quickInput.visible && mode === '') quickInput.setValue(quickInput.value, 'all'); else open('') } }),
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
