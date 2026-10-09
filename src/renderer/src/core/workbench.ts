import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { toPlatform, type Platform } from '../../../shared/commands/keybindings'
import { DocumentService } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { FileService } from '../services/files'
import { EditorOptionsService } from '../services/editor-options'
import { TargetService } from '../services/targets'
import { BackendStateService } from '../services/backend'
import { ResultClient } from '../results/ResultClient'
import { legacyExecute } from '../results/legacy'
import ResultsWorker from '../results/results.worker.ts?worker'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { filesContribution } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { paletteContribution } from '../contributions/palette'
import { themeContribution } from '../contributions/theme'
import { backendContribution } from '../contributions/backend'
import { domFocusAdapter } from '../quickinput/focus'
import { QuickInputService } from '../quickinput/QuickInputService'
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
  readonly quickInput: QuickInputService
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly backend: BackendStateService
  /** Stored query results, read through the results worker. */
  readonly results: ResultClient
  readonly files: FileService
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  readonly theme: ThemeService
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService): Workbench {
  const platform = toPlatform(api.platform)
  const events = new EventBus(), connections = new ConnectionService(), editorOptions = new EditorOptionsService()
  const backend = new BackendStateService(api, connections)
  const documents = new DocumentService((sql, uri) => monaco.editor.createModel(sql, 'sql', monaco.Uri.parse(uri)), api, events)
  const results = new ResultClient({ api, createWorker: () => new ResultsWorker(), window })
  const queries = new QueryService(documents, { execute: (options, onProgress) => legacyExecute(api, results, options, onProgress), cancel: queryId => api.cancel(queryId) }, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const targets = new TargetService(documents, queries, connections, files, api)
  const quickInput = new QuickInputService(domFocusAdapter(documents))
  const context = new ContextKeyService({ platform, documents, queries, connections, backend, editorOptions, quickInput: quickInput.visibility, editor: () => documents.boundEditor })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, editorHasTextFocus: () => documents.boundEditor?.hasTextFocus() ?? false,
    editorContains: target => target instanceof Node && !!documents.boundEditor?.getContainerDomNode().contains(target) })
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = { platform, monaco, events, commands, context, keybindings, menuState, quickInput, documents, queries, connections, backend, results, files, targets, editorOptions, theme, dispose: () => {
    if (disposed) return
    disposed = true
    // Hiding the quick input first aborts its loads and ends any theme preview before the services they use go away.
    listener.dispose(); quickInput.dispose(); menuState.dispose(); keybindings.dispose()
    contributions.forEach(contribution => contribution.dispose())
    cleanup.dispose(); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); results.dispose(); documents.dispose(); backend.dispose(); connections.dispose(); editorOptions.dispose(); theme.dispose(); events.dispose()
  } }
  const contributions = [queryContribution(workbench, api), filesContribution(workbench), editorContribution(workbench), paletteContribution(workbench), themeContribution(workbench, api), backendContribution(workbench)]
  // Capture on window runs before Monaco's own listeners, the title bar's document listener, and React's handlers.
  const listener = keybindings.attach(window)
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  return workbench
}
