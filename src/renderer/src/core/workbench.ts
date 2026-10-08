import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { toPlatform, type Platform } from '../../../shared/commands/keybindings'
import { DocumentService } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { FileService } from '../services/files'
import { EditorOptionsService } from '../services/editor-options'
import { TargetService } from '../services/targets'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { filesContribution } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { CommandService } from './commands'
import { ContextKeyService } from './contextkeys'
import { EventBus } from './events'
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
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly files: FileService
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  readonly theme: ThemeService
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService): Workbench {
  const platform = toPlatform(api.platform)
  const events = new EventBus(), connections = new ConnectionService(), editorOptions = new EditorOptionsService()
  const documents = new DocumentService((sql, uri) => monaco.editor.createModel(sql, 'sql', monaco.Uri.parse(uri)), api, events)
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const targets = new TargetService(documents, queries, connections, files, api)
  const context = new ContextKeyService({ platform, documents, queries, connections, editorOptions, editor: () => documents.boundEditor })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, editorHasTextFocus: () => documents.boundEditor?.hasTextFocus() ?? false })
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = { platform, monaco, events, commands, context, keybindings, menuState, documents, queries, connections, files, targets, editorOptions, theme, dispose: () => {
    if (disposed) return
    disposed = true
    listener.dispose(); menuState.dispose(); keybindings.dispose()
    contributions.forEach(contribution => contribution.dispose())
    cleanup.dispose(); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); documents.dispose(); connections.dispose(); editorOptions.dispose(); theme.dispose(); events.dispose()
  } }
  const contributions = [queryContribution(workbench), filesContribution(workbench), editorContribution(workbench)]
  // Capture on window runs before Monaco's own listeners, the title bar's document listener, and React's handlers.
  const listener = keybindings.attach(window)
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  return workbench
}
