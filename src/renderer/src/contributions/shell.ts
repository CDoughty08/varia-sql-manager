import { canPopOut, outputPaneIds, type PaneId } from '../../../shared/layouts'
import { isElement } from '../core/focus'
import { modalOpen } from '../core/modal'
import { windows } from '../core/windows'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, inputOf } from '../menus/targets'
import type { PaneLocation } from '../services/panes'
import { serverItems } from './query'

/** What the shell commands need from the React app: the dock workspace, the Connect dialog, and Object Explorer. */
export interface ShellHost {
  /** Ends a server connection and moves its queries to Disconnected, as Object Explorer's Disconnect button does. */
  disconnect(connectionId: string): Promise<void>
  /**
   * Shows a pane; `focus` also moves keyboard focus into it, as SSMS's F8 does for Object Explorer. `raise` brings the popout
   * window that holds it to the front.
   */
  reveal(pane: PaneId, options?: { focus?: boolean; raise?: boolean }): void
  /** Shows the query output: the active query's view, else the output panel showing; with all closed, reopens them. */
  revealOutput(options?: { focus?: boolean }): void
  /** SSMS's Ctrl+R: closes the output panels while one shows, else shows the output. */
  toggleOutput(): 'hidden' | 'shown'
  manageLayouts(mode: 'save' | 'load'): void
  resetLayout(): void
  /** The window's last layout write before it closes: popout windows the close takes leave the saved layout as it is. */
  flushLayout(): Promise<void>
  /** The close `flushLayout` prepared for did not happen. */
  layoutCloseCancelled(): void
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
  /** Moves a panel into a new OS window of its own. */
  movePaneToWindow(pane: PaneId): void
  /** Docks a popped-out panel back in the main window, where it was. */
  movePaneToMainWindow(pane: PaneId): void
}
export type DockSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Undo and Redo act on the focused text field outside the editor, otherwise on the query editor. While a dialog is open
 * they act only on its text fields: the editor behind it must neither change nor take focus out of the dialog. From a
 * text field's context menu they act on that field.
 */
function edit(documents: Workbench['documents'], command: 'undo' | 'redo', args?: CommandArgs): void {
  // The menu has put focus back in the field, which may be one of the editor's find inputs.
  // In the window the user is in: a popout's fields are in its own document.
  const surface = windows.activeDocument() ?? document
  if (inputOf(args)) { surface.execCommand(command); return }
  const focused = surface.activeElement, modal = modalOpen()
  const textInput = isElement(focused) && (focused.matches('input, textarea') || focused.isContentEditable)
  if (textInput && !focused.closest('.monaco-editor')) {
    if (!modal || focused.closest('[aria-modal="true"]')) surface.execCommand(command)
    return
  }
  // A table designer has no text to undo: its fields undo their own text above.
  if (modal || !documents.getSnapshot().documents.length || documents.isCustom(documents.getSnapshot().activeId)) return
  documents.boundEditor?.focus()
  documents.boundEditor?.trigger('menu', command, null)
}

const runningOnServer = 'A query is running on this server.'
const paneOf = (args?: CommandArgs): PaneId | undefined => args?.target?.kind === 'dockTab' ? args.target.pane : undefined
const onPane = (action: (pane: PaneId) => void) => (args?: CommandArgs) => { const pane = paneOf(args); if (pane) action(pane) }

/**
 * Commands the React shell carries out. App registers them in the same effect that subscribes to main's commands, so
 * main's exit flow (which waits for that subscription) always finds a `window.close` handler. The panel commands act on
 * the panel whose tab menu runs them.
 */
export function shellContribution({ commands, documents, files, quickInput, connections, queries, shellOptions, longRuns }: Pick<Workbench, 'commands' | 'documents' | 'files' | 'quickInput' | 'connections' | 'queries' | 'panes' | 'shellOptions' | 'longRuns'>, host: ShellHost): Disposable {
  const located = (args: CommandArgs | undefined, location: PaneLocation) => { const pane = paneOf(args); return !!pane && host.paneLocation(pane) === location }
  const open = (args: CommandArgs | undefined) => { const pane = paneOf(args); return !!pane && host.paneLocation(pane) !== 'closed' }
  const dockAt = (side: DockSide) => ({ when: open, run: onPane(pane => host.dockPaneAt(pane, side)) })
  // Beside another open panel in the main window, never itself.
  const tabWith = (other: PaneId) => ({ when: (args?: CommandArgs) => open(args) && paneOf(args) !== other && host.paneLocation(other) !== 'closed' && host.paneLocation(other) !== 'window', run: onPane(pane => host.tabPaneWith(pane, other)) })
  /** The lost server a menu was opened for (undefined without one); null when the menu's node is not one, or no longer. */
  const lostNode = (args: CommandArgs | undefined) => {
    const node = explorerNodeOf(args)
    if (!node) return undefined
    return node.kind === 'server' && node.lost && connections.get(node.connectionId)?.lost ? node : null
  }
  /**
   * Why a server cannot be disconnected now: a query running on it, a long run on it (a restore, Create Catalog), or a
   * document's DDL (an Apply, a Save) that a disconnect would cut short.
   */
  const disconnectRefusal = (id: string) => queries.isConnectionRunning(id) ? runningOnServer : longRuns.disconnectRefusal(id) ?? documents.connectionBusy(id)
  const registrations = [
    // Remembering the layout is best-effort; a failed preferences write must never prevent exit.
    // A long run (Create Catalog, a restore) would be stopped part way by the close (its request is cancelled as the page unloads), so the close is refused.
    commands.register('window.close', { run: async () => {
      try { await files.closeWindow(async () => { await host.flushLayout().catch(() => {}) }, () => longRuns.closeRefusal()) }
      finally { if (!files.exiting) host.layoutCloseCancelled() }
    } }),
    // Focus moves there too, so the F5 that follows refreshes Object Explorer rather than executing the query.
    commands.register('window.explorer', { run: () => host.reveal('explorer', { focus: true }) }),
    // The box asks for focus itself once shown, as revealing a hidden pane mounts it on a later render.
    commands.register('window.editor', { run: () => host.reveal('editor') }),
    // A panel in a popout window: its window comes to the front.
    commands.register('window.results', { run: () => host.reveal('results', { raise: true }) }),
    commands.register('window.messages', { run: () => host.reveal('messages', { raise: true }) }),
    commands.register('window.plan', { run: () => host.reveal('plan', { raise: true }) }),
    // SSMS's Ctrl+R: hiding the results puts focus in the query editor; showing them leaves focus where it is.
    commands.register('view.toggleResultsPane', { run: () => {
      if (host.toggleOutput() === 'hidden' && documents.getSnapshot().documents.length) documents.focusActive()
    } }),
    // SSMS's F6: from Query Output back to the editor; from anywhere else to the results (DockWorkspace focuses the grid
    // that last had focus, else the first grid, else Messages).
    commands.register('window.switchPane', { run: () => {
      if (typeof document !== 'undefined' && windows.activeElement()?.closest(outputPaneIds.map(id => `[data-pane="${id}"]`).join())) {
        host.reveal('editor')
        documents.focusActive()
        return
      }
      host.revealOutput({ focus: true })
    } }),
    commands.register('layout.save', { run: () => host.manageLayouts('save') }),
    commands.register('layout.load', { run: () => host.manageLayouts('load') }),
    commands.register('layout.reset', { run: () => host.resetLayout() }),
    commands.register('edit.undo', { when: args => inputOf(args)?.canUndo ?? true, run: args => edit(documents, 'undo', args) }),
    commands.register('edit.redo', { when: args => inputOf(args)?.canRedo ?? true, run: args => edit(documents, 'redo', args) }),
    commands.register('connection.connect', { run: () => host.showConnect() }),
    // From a server node's menu, that server; otherwise the user picks one.
    commands.register('connection.disconnect', {
      when: args => { const node = explorerNodeOf(args); return node?.kind !== 'server' || (!node.lost && connections.isLive(node.connectionId) && !disconnectRefusal(node.connectionId)) },
      run: args => {
        const node = explorerNodeOf(args)
        if (node?.kind === 'server') return host.disconnect(node.connectionId)
        quickInput.show({
          ariaLabel: 'Disconnect from Server', placeholder: 'Select a server to disconnect', noun: 'servers',
          items: serverItems(connections.live(), disconnectRefusal), onDidAccept: item => host.disconnect(item.id)
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
    commands.register('pane.moveToNewWindow', { when: args => { const pane = paneOf(args); return !!pane && canPopOut(pane) && (located(args, 'grid') || located(args, 'floating')) }, run: onPane(pane => host.movePaneToWindow(pane)) }),
    commands.register('pane.moveToMainWindow', { when: args => located(args, 'window'), run: onPane(pane => host.movePaneToMainWindow(pane)) }),
    commands.register('pane.close', { when: args => !!paneOf(args) && !located(args, 'closed'), run: onPane(pane => host.closePane(pane)) }),
    commands.register('pane.dockLeft', dockAt('left')),
    commands.register('pane.dockRight', dockAt('right')),
    commands.register('pane.dockTop', dockAt('top')),
    commands.register('pane.dockBottom', dockAt('bottom')),
    commands.register('pane.tabWithExplorer', tabWith('explorer')),
    commands.register('pane.tabWithEditor', tabWith('editor')),
    commands.register('pane.tabWithResults', tabWith('results')),
    commands.register('pane.tabWithMessages', tabWith('messages')),
    commands.register('pane.tabWithPlan', tabWith('plan')),
    commands.register('window.togglePanelTabs', { run: () => shellOptions.togglePanelTabs() })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
