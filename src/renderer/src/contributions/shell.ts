import type { PaneId } from '../../../shared/layouts'
import { modalOpen } from '../core/modal'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, inputOf } from '../menus/targets'
import type { PaneLocation } from '../services/panes'
import { serverItems } from './query'

/** What the shell commands need from the React app: the dock workspace, the Connect dialog, and Object Explorer. */
export interface ShellHost {
  /** Ends a server connection and moves its queries to Disconnected, as Object Explorer's Disconnect button does. */
  disconnect(connectionId: string): Promise<void>
  /** Shows a pane; `focus` also moves keyboard focus into it, as SSMS's F8 does for Object Explorer. */
  reveal(pane: PaneId, options?: { focus?: boolean }): void
  manageLayouts(mode: 'save' | 'load'): void
  resetLayout(): void
  flushLayout(): Promise<void>
  showConnect(): void
  /** Opens the Connect dialog filled in from a lost connection; connecting replaces it and retargets its queries. */
  reconnect(connectionId: string): void
  /** Closes a panel as its × button does: its content and state are kept for when it is shown again. */
  closePane(pane: PaneId): void
  paneLocation(pane: PaneId): PaneLocation
  floatPane(pane: PaneId): void
  /** Returns a floating panel to where it was docked. */
  dockPane(pane: PaneId): void
}

/**
 * Undo and Redo act on the focused text field outside the editor, otherwise on the query editor. While a dialog is open
 * they act only on its text fields: the editor behind it must neither change nor take focus out of the dialog. From a
 * text field's context menu they act on that field.
 */
function edit(documents: Workbench['documents'], command: 'undo' | 'redo', args?: CommandArgs): void {
  // The menu has put focus back in the field, which may be one of the editor's find inputs.
  if (inputOf(args)) { document.execCommand(command); return }
  const focused = document.activeElement, modal = modalOpen()
  const textInput = focused instanceof HTMLElement && (focused.matches('input, textarea') || focused.isContentEditable)
  if (textInput && !focused.closest('.monaco-editor')) {
    if (!modal || focused.closest('[aria-modal="true"]')) document.execCommand(command)
    return
  }
  if (modal || !documents.getSnapshot().documents.length) return
  documents.boundEditor?.focus()
  documents.boundEditor?.trigger('menu', command, null)
}

const paneOf = (args?: CommandArgs): PaneId | undefined => args?.target?.kind === 'dockTab' ? args.target.pane : undefined
const onPane = (action: (pane: PaneId) => void) => (args?: CommandArgs) => { const pane = paneOf(args); if (pane) action(pane) }

/**
 * Commands the React shell carries out. App registers them in the same effect that subscribes to main's commands, so
 * main's exit flow (which waits for that subscription) always finds a `window.close` handler. The panel commands act on
 * the panel whose tab menu runs them.
 */
export function shellContribution({ commands, documents, files, quickInput, connections, queries, panes }: Pick<Workbench, 'commands' | 'documents' | 'files' | 'quickInput' | 'connections' | 'queries' | 'panes'>, host: ShellHost): Disposable {
  const located = (args: CommandArgs | undefined, location: PaneLocation) => { const pane = paneOf(args); return !!pane && host.paneLocation(pane) === location }
  const registrations = [
    // Remembering the layout is best-effort; a failed preferences write must never prevent exit.
    commands.register('window.close', { run: () => files.closeWindow(async () => { await host.flushLayout().catch(() => {}) }) }),
    // Focus moves there too, so the F5 that follows refreshes Object Explorer rather than executing the query.
    commands.register('window.explorer', { run: () => host.reveal('explorer', { focus: true }) }),
    commands.register('window.editor', { run: () => host.reveal('editor') }),
    commands.register('window.output', { run: () => host.reveal('output') }),
    // SSMS's Ctrl+R: hiding the results puts focus in the query editor; showing them leaves focus where it is.
    commands.register('view.toggleResultsPane', { run: () => {
      if (!panes.getSnapshot().output) { host.reveal('output'); return }
      host.closePane('output')
      if (documents.getSnapshot().documents.length) documents.boundEditor?.focus()
    } }),
    commands.register('layout.save', { run: () => host.manageLayouts('save') }),
    commands.register('layout.load', { run: () => host.manageLayouts('load') }),
    commands.register('layout.reset', { run: () => host.resetLayout() }),
    commands.register('edit.undo', { when: args => inputOf(args)?.canUndo ?? true, run: args => edit(documents, 'undo', args) }),
    commands.register('edit.redo', { when: args => inputOf(args)?.canRedo ?? true, run: args => edit(documents, 'redo', args) }),
    commands.register('connection.connect', { run: () => host.showConnect() }),
    // From a server node's menu, that server; otherwise the user picks one.
    commands.register('connection.disconnect', {
      when: args => { const node = explorerNodeOf(args); return node?.kind !== 'server' || (connections.isLive(node.connectionId) && !queries.isConnectionRunning(node.connectionId)) },
      run: args => {
        const node = explorerNodeOf(args)
        if (node?.kind === 'server') return host.disconnect(node.connectionId)
        quickInput.show({
          ariaLabel: 'Disconnect from Server', placeholder: 'Select a server to disconnect', noun: 'servers',
          items: serverItems(connections.live(), id => queries.isConnectionRunning(id)), onDidAccept: item => host.disconnect(item.id)
        })
      }
    }),
    // The active query's lost connection first; otherwise the user picks among the lost ones.
    commands.register('connection.reconnect', { run: () => {
      const active = documents.active?.connectionId ? connections.get(documents.active.connectionId) : undefined
      if (active?.lost) return host.reconnect(active.id)
      quickInput.show({
        ariaLabel: 'Reconnect', placeholder: 'Select a lost connection to reconnect', noun: 'servers',
        items: serverItems(connections.getSnapshot().filter(connection => connection.lost)), onDidAccept: item => host.reconnect(item.id)
      })
    } }),
    commands.register('pane.float', { when: args => located(args, 'grid'), run: onPane(pane => host.floatPane(pane)) }),
    commands.register('pane.dock', { when: args => located(args, 'floating'), run: onPane(pane => host.dockPane(pane)) }),
    commands.register('pane.close', { when: args => !!paneOf(args) && !located(args, 'closed'), run: onPane(pane => host.closePane(pane)) })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
