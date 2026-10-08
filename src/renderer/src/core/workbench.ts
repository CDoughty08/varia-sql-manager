import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { toPlatform, type Platform } from '../../../shared/commands/keybindings'
import { DocumentService } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { FileService } from '../services/files'
import { EditorOptionsService } from '../services/editor-options'
import { TargetService } from '../services/targets'
import { PaneService } from '../services/panes'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { filesContribution } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { paletteContribution } from '../contributions/palette'
import { themeContribution } from '../contributions/theme'
import { editContribution } from '../contributions/edit'
import { windowContribution } from '../contributions/window'
import { MenuService } from '../menus/MenuService'
import { trackWindowFocus } from '../menus/menubar'
import { QuickInputService } from '../quickinput/QuickInputService'
import { CommandService } from './commands'
import { ContextKeyService } from './contextkeys'
import { EventBus } from './events'
import { domFocusAdapter } from './focus'
import { KeybindingService } from './keybindings'
import { MenuStatePublisher } from './menu-state'
import { modalOpen } from './modal'
import type { Disposable } from './types'

export interface Workbench extends Disposable {
  readonly platform: Platform
  readonly monaco: typeof Monaco
  readonly events: EventBus
  readonly commands: CommandService
  readonly context: ContextKeyService
  readonly keybindings: KeybindingService
  readonly menuState: MenuStatePublisher
  readonly menus: MenuService
  readonly quickInput: QuickInputService
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly files: FileService
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  readonly panes: PaneService
  readonly theme: ThemeService
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService): Workbench {
  const platform = toPlatform(api.platform)
  const events = new EventBus(), connections = new ConnectionService(), editorOptions = new EditorOptionsService(), panes = new PaneService()
  const documents = new DocumentService((sql, uri) => monaco.editor.createModel(sql, 'sql', monaco.Uri.parse(uri)), api, events)
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const targets = new TargetService(documents, queries, connections, files, api)
  const focus = domFocusAdapter(documents)
  const quickInput = new QuickInputService(focus)
  const context = new ContextKeyService({ platform, documents, queries, connections, editorOptions, panes, quickInput: quickInput.visibility, editor: () => documents.boundEditor })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  // Menus label items with keys and the dispatcher routes keys to the menus; neither looks the other up before both exist.
  const menus = new MenuService({ platform, commands, context, keybindings: { lookup: id => keybindings.lookup(id) }, theme, focus, modalOpen,
    findWidgetFocused: () => !!document.activeElement?.closest('.monaco-editor .find-widget'),
    menubarRect: id => document.getElementById('menubar-' + id)?.getBoundingClientRect() })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, menus, editorHasTextFocus: () => documents.boundEditor?.hasTextFocus() ?? false,
    editorContains: target => target instanceof Node && !!documents.boundEditor?.getContainerDomNode().contains(target) })
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = { platform, monaco, events, commands, context, keybindings, menuState, menus, quickInput, documents, queries, connections, files, targets, editorOptions, panes, theme, dispose: () => {
    if (disposed) return
    disposed = true
    // Hiding the quick input first aborts its loads and ends any theme preview before the services they use go away.
    listeners.forEach(listener => listener.dispose()); menus.dispose(); quickInput.dispose(); menuState.dispose(); keybindings.dispose()
    contributions.forEach(contribution => contribution.dispose())
    cleanup.dispose(); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); documents.dispose(); connections.dispose(); editorOptions.dispose(); panes.dispose(); theme.dispose(); events.dispose()
  } }
  const contributions = [queryContribution(workbench, api), filesContribution(workbench), editorContribution(workbench), editContribution(workbench, api), windowContribution(workbench, api),
    paletteContribution(workbench), themeContribution(workbench, api)]
  // Capture on window runs before Monaco's own listeners and React's handlers.
  const listeners = [keybindings.attach(window), menus.attach(window), trackWindowFocus(window, document.documentElement)]
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  return workbench
}
