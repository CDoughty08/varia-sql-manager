import type { PaneId } from '../../../shared/layouts'
import { modalOpen } from '../core/modal'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
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
  refreshExplorer(): void
}

/**
 * Undo and Redo act on the focused text field outside the editor, otherwise on the query editor. While a dialog is open
 * they act only on its text fields: the editor behind it must neither change nor take focus out of the dialog.
 */
function edit(documents: Workbench['documents'], command: 'undo' | 'redo'): void {
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

/**
 * Commands the React shell carries out. App registers them in the same effect that subscribes to main's commands, so
 * main's exit flow (which waits for that subscription) always finds a `window.close` handler.
 */
export function shellContribution({ commands, documents, files, quickInput, connections, queries }: Pick<Workbench, 'commands' | 'documents' | 'files' | 'quickInput' | 'connections' | 'queries'>, host: ShellHost): Disposable {
  const registrations = [
    // Remembering the layout is best-effort; a failed preferences write must never prevent exit.
    commands.register('window.close', { run: () => files.closeWindow(async () => { await host.flushLayout().catch(() => {}) }) }),
    // Focus moves there too, so the F5 that follows refreshes Object Explorer rather than executing the query.
    commands.register('window.explorer', { run: () => host.reveal('explorer', { focus: true }) }),
    commands.register('window.editor', { run: () => host.reveal('editor') }),
    commands.register('window.output', { run: () => host.reveal('output') }),
    commands.register('layout.save', { run: () => host.manageLayouts('save') }),
    commands.register('layout.load', { run: () => host.manageLayouts('load') }),
    commands.register('layout.reset', { run: () => host.resetLayout() }),
    commands.register('edit.undo', { run: () => edit(documents, 'undo') }),
    commands.register('edit.redo', { run: () => edit(documents, 'redo') }),
    commands.register('connection.connect', { run: () => host.showConnect() }),
    commands.register('connection.disconnect', { run: () => quickInput.show({
      ariaLabel: 'Disconnect from Server', placeholder: 'Select a server to disconnect', noun: 'servers',
      items: serverItems(connections.live(), id => queries.isConnectionRunning(id)), onDidAccept: item => host.disconnect(item.id)
    }) }),
    // The active query's lost connection first; otherwise the user picks among the lost ones.
    commands.register('connection.reconnect', { run: () => {
      const active = documents.active?.connectionId ? connections.get(documents.active.connectionId) : undefined
      if (active?.lost) return host.reconnect(active.id)
      quickInput.show({
        ariaLabel: 'Reconnect', placeholder: 'Select a lost connection to reconnect', noun: 'servers',
        items: serverItems(connections.getSnapshot().filter(connection => connection.lost)), onDidAccept: item => host.reconnect(item.id)
      })
    } }),
    commands.register('explorer.refresh', { run: () => host.refreshExplorer() })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
