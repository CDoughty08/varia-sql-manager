import type { PaneId } from '../../../shared/layouts'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { serverItems } from './query'

/** What the shell commands need from the React app: the dock workspace, the Connect dialog, and Object Explorer. */
export interface ShellHost {
  /** Ends a server connection and moves its queries to Disconnected, as Object Explorer's Disconnect button does. */
  disconnect(connectionId: string): Promise<void>
  reveal(pane: PaneId): void
  manageLayouts(mode: 'save' | 'load'): void
  resetLayout(): void
  flushLayout(): Promise<void>
  showConnect(): void
  refreshExplorer(): void
}

/** Undo and Redo act on the focused text field outside the editor (dialogs included), otherwise on the query editor. */
function edit(documents: Workbench['documents'], command: 'undo' | 'redo'): void {
  const focused = document.activeElement
  const textInput = focused instanceof HTMLElement && (focused.matches('input, textarea') || focused.isContentEditable)
  if (textInput && !focused.closest('.monaco-editor')) { document.execCommand(command); return }
  if (!documents.getSnapshot().documents.length) return
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
    commands.register('window.explorer', { run: () => host.reveal('explorer') }),
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
      items: serverItems(connections.getSnapshot(), id => queries.isConnectionRunning(id)), onDidAccept: item => host.disconnect(item.id)
    }) }),
    commands.register('explorer.refresh', { run: () => host.refreshExplorer() })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
