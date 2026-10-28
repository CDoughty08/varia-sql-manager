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
  /** Opens the Connection Environment dialog for a connected server. */
  editEnvironment(connectionId: string): void
  /** Closes a panel as its × button does: its content and state are kept for when it is shown again. */
  closePane(pane: PaneId): void
  paneLocation(pane: PaneId): PaneLocation
  floatPane(pane: PaneId): void
  /** Returns a floating panel to where it was docked. */
  dockPane(pane: PaneId): void
  /** Docks a panel at a side of the query editor (of Object Explorer, for the editor itself), as the old Move list did. */
  dockPaneAt(pane: PaneId, side: DockSide): void
  /** Moves a panel into another panel's group, as a tab beside it. */
  tabPaneWith(pane: PaneId, other: PaneId): void
}
export type DockSide = 'left' | 'right' | 'top' | 'bottom'

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
  // A table designer has no text to undo: its fields undo their own text above.
  if (modal || !documents.getSnapshot().documents.length || documents.isCustom(documents.getSnapshot().activeId)) return
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
export function shellContribution({ commands, documents, files, quickInput, connections, queries, panes, shellOptions }: Pick<Workbench, 'commands' | 'documents' | 'files' | 'quickInput' | 'connections' | 'queries' | 'panes' | 'shellOptions'>, host: ShellHost): Disposable {
  const located = (args: CommandArgs | undefined, location: PaneLocation) => { const pane = paneOf(args); return !!pane && host.paneLocation(pane) === location }
  const open = (args: CommandArgs | undefined) => { const pane = paneOf(args); return !!pane && host.paneLocation(pane) !== 'closed' }
  const dockAt = (side: DockSide) => ({ when: open, run: onPane(pane => host.dockPaneAt(pane, side)) })
  // Beside another open panel, never itself.
  const tabWith = (other: PaneId) => ({ when: (args?: CommandArgs) => open(args) && paneOf(args) !== other && host.paneLocation(other) !== 'closed', run: onPane(pane => host.tabPaneWith(pane, other)) })
  /** The lost server a menu was opened for (undefined without one); null when the menu's node is not one, or no longer. */
  const lostNode = (args: CommandArgs | undefined) => {
    const node = explorerNodeOf(args)
    if (!node) return undefined
    return node.kind === 'server' && node.lost && connections.get(node.connectionId)?.lost ? node : null
  }
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
      if (documents.getSnapshot().documents.length) documents.focusActive()
    } }),
    // SSMS's F6: from Query Output back to the editor; from anywhere else to the results (DockWorkspace focuses the grid
    // that last had focus, else the first grid, else Messages).
    commands.register('window.switchPane', { run: () => {
      if (typeof document !== 'undefined' && document.activeElement?.closest('[data-pane="output"]')) {
        host.reveal('editor')
        documents.focusActive()
        return
      }
      host.reveal('output', { focus: true })
    } }),
    commands.register('layout.save', { run: () => host.manageLayouts('save') }),
    commands.register('layout.load', { run: () => host.manageLayouts('load') }),
    commands.register('layout.reset', { run: () => host.resetLayout() }),
    commands.register('edit.undo', { when: args => inputOf(args)?.canUndo ?? true, run: args => edit(documents, 'undo', args) }),
    commands.register('edit.redo', { when: args => inputOf(args)?.canRedo ?? true, run: args => edit(documents, 'redo', args) }),
    commands.register('connection.connect', { run: () => host.showConnect() }),
    // From a server node's menu, that server; otherwise the user picks one.
    commands.register('connection.disconnect', {
      when: args => { const node = explorerNodeOf(args); return node?.kind !== 'server' || (!node.lost && connections.isLive(node.connectionId) && !queries.isConnectionRunning(node.connectionId)) },
      run: args => {
        const node = explorerNodeOf(args)
        if (node?.kind === 'server') return host.disconnect(node.connectionId)
        quickInput.show({
          ariaLabel: 'Disconnect from Server', placeholder: 'Select a server to disconnect', noun: 'servers',
          items: serverItems(connections.live(), id => queries.isConnectionRunning(id)), onDidAccept: item => host.disconnect(item.id)
        })
      }
    }),
    // A server node's menu labels that server; otherwise the active query's server, else the user picks a connected one.
    commands.register('connection.environment', {
      when: args => { const node = explorerNodeOf(args); return node?.kind !== 'server' || (!node.lost && connections.isLive(node.connectionId)) },
      run: args => {
        const node = explorerNodeOf(args)
        if (node?.kind === 'server') return host.editEnvironment(node.connectionId)
        const active = documents.active?.connectionId
        if (active && connections.isLive(active)) return host.editEnvironment(active)
        quickInput.show({
          ariaLabel: 'Set Connection Environment', placeholder: 'Select a server to label', noun: 'servers',
          items: serverItems(connections.live()), onDidAccept: item => host.editEnvironment(item.id)
        })
      }
    }),
    // A lost server's menu reconnects that server; otherwise the active query's lost connection, else the user picks
    // among the lost ones.
    commands.register('connection.reconnect', {
      when: args => lostNode(args) !== null,
      run: args => {
        const node = lostNode(args)
        if (node) return host.reconnect(node.connectionId)
        const active = documents.active?.connectionId ? connections.get(documents.active.connectionId) : undefined
        if (active?.lost) return host.reconnect(active.id)
        quickInput.show({
          ariaLabel: 'Reconnect', placeholder: 'Select a lost connection to reconnect', noun: 'servers',
          items: serverItems(connections.getSnapshot().filter(connection => connection.lost)), onDidAccept: item => host.reconnect(item.id)
        })
      }
    }),
    // A lost server's menu removes that server, as its Remove button does; otherwise the user picks among the lost ones.
    commands.register('connection.removeLost', {
      when: args => lostNode(args) !== null,
      run: args => {
        const node = lostNode(args)
        if (node) return host.disconnect(node.connectionId)
        quickInput.show({
          ariaLabel: 'Remove Lost Connection', placeholder: 'Select a lost connection to remove', noun: 'servers',
          items: serverItems(connections.getSnapshot().filter(connection => connection.lost)), onDidAccept: item => host.disconnect(item.id)
        })
      }
    }),
    commands.register('pane.float', { when: args => located(args, 'grid'), run: onPane(pane => host.floatPane(pane)) }),
    commands.register('pane.dock', { when: args => located(args, 'floating'), run: onPane(pane => host.dockPane(pane)) }),
    commands.register('pane.close', { when: args => !!paneOf(args) && !located(args, 'closed'), run: onPane(pane => host.closePane(pane)) }),
    commands.register('pane.dockLeft', dockAt('left')),
    commands.register('pane.dockRight', dockAt('right')),
    commands.register('pane.dockTop', dockAt('top')),
    commands.register('pane.dockBottom', dockAt('bottom')),
    commands.register('pane.tabWithExplorer', tabWith('explorer')),
    commands.register('pane.tabWithEditor', tabWith('editor')),
    commands.register('pane.tabWithOutput', tabWith('output')),
    commands.register('window.togglePanelTabs', { run: () => shellOptions.togglePanelTabs() })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
