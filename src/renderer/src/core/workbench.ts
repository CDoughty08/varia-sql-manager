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
import { ResultsService } from '../results/ResultsService'
import { ResultMemoryService } from '../results/memory'
import ResultsWorker from '../results/results.worker.ts?worker'
import { GridStats } from '../grid/stats'
import { PaneService } from '../services/panes'
import { ExplorerService } from '../explorer/ExplorerService'
import { DatabaseListService } from '../services/database-list'
import { ResultSelectionService } from '../services/result-selection'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { filesContribution } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { paletteContribution } from '../contributions/palette'
import { themeContribution } from '../contributions/theme'
import { backendContribution } from '../contributions/backend'
import { editContribution } from '../contributions/edit'
import { windowContribution } from '../contributions/window'
import { menusContribution } from '../contributions/menus'
import { explorerContribution } from '../contributions/explorer'
import { outputContribution } from '../contributions/output'
import { scriptingContribution } from '../contributions/scripting'
import { ScriptingOptionsService } from '../scripting/ScriptingOptionsService'
import { ScriptingService } from '../scripting/ScriptingService'
import { MenuService } from '../menus/MenuService'
import { trackWindowFocus } from '../menus/menubar'
import { MenuTargetService } from '../menus/targets'
import { QuickInputService } from '../quickinput/QuickInputService'
import { CommandService } from './commands'
import { ContextKeyService } from './contextkeys'
import { EventBus } from './events'
import { domFocusAdapter } from './focus'
import { KeybindingService } from './keybindings'
import { MenuStatePublisher } from './menu-state'
import { modalOpen } from './modal'
import { nextFrame as frame } from './frame'
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
  /** What context menus are for: components register their elements with `useMenuTarget`. */
  readonly menuTargets: MenuTargetService
  readonly quickInput: QuickInputService
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly backend: BackendStateService
  /** Stored query results, read through the results worker. */
  readonly resultClient: ResultClient
  /** Each query tab's results: its result sets, Messages, view state, and copy jobs. */
  readonly results: ResultsService
  /** What the backend holds for results, for the status bar. */
  readonly resultMemory: ResultMemoryService
  /** Test mode only: the grids' frame times and counters (`window.__variaGrid`). */
  readonly gridStats?: GridStats
  readonly files: FileService
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  readonly panes: PaneService
  /** Object Explorer's tree: its nodes, loads, selection, and context keys. */
  readonly explorer: ExplorerService
  /** The databases of each connected server, for the toolbar's database picker. */
  readonly databaseList: DatabaseListService
  /** The cells selected in each query's results grid. */
  readonly resultSelection: ResultSelectionService
  /** Tools › Options › Scripting: the options every Script As request carries, and the Options dialog. */
  readonly scriptingOptions: ScriptingOptionsService
  /** Script As requests: their status, cancellation, and destinations. */
  readonly scripting: ScriptingService
  readonly theme: ThemeService
}
/**
 * The next animation frame, or 50 ms when frames are throttled: a hidden window (the smoke tests') gets one a second,
 * which would hold every Object Explorer update back that long.
 */
function nextFrame(callback: () => void): void {
  let done = false
  const run = () => { if (!done) { done = true; callback() } }
  requestAnimationFrame(run)
  setTimeout(run, 50)
}
/** The query editor's caret line in window coordinates, scrolled into view first: keyboard-opened editor menus open below it. */
function editorCaret(documents: DocumentService, monaco: typeof Monaco) {
  const editor = documents.boundEditor, position = editor?.getPosition()
  if (!editor || !position) return undefined
  editor.revealPosition(position, monaco.editor.ScrollType.Immediate)
  editor.render()
  const caret = editor.getScrolledVisiblePosition(position), box = editor.getContainerDomNode().getBoundingClientRect()
  if (!caret) return undefined
  const left = box.left + caret.left, top = box.top + caret.top
  return { left, top, right: left, bottom: top + caret.height }
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService): Workbench {
  const platform = toPlatform(api.platform)
  const events = new EventBus(), connections = new ConnectionService(), editorOptions = new EditorOptionsService(), panes = new PaneService()
  const explorer = new ExplorerService({ api, connections, events, schedule: nextFrame }), databaseList = new DatabaseListService(api, connections, events)
  const backend = new BackendStateService(api, connections)
  const documents = new DocumentService((text, uri, language) => monaco.editor.createModel(text, language, monaco.Uri.parse(uri)), api, events, callback => { frame(callback) })
  const resultClient = new ResultClient({ api, createWorker: () => new ResultsWorker(), window, schedule: callback => { frame(callback) } })
  const results = new ResultsService({ client: resultClient, api, events, documents, frame: callback => { frame(callback) } })
  const resultMemory = new ResultMemoryService(resultClient, events)
  const gridStats = api.testMode ? new GridStats() : undefined
  const queries = new QueryService(documents, api, id => connections.get(id), events, results)
  const files = new FileService(documents, queries, api)
  const resultSelection = new ResultSelectionService(results)
  const targets = new TargetService(documents, queries, connections, files)
  const focus = domFocusAdapter(documents)
  const quickInput = new QuickInputService(focus)
  const scriptingOptions = new ScriptingOptionsService(api, (message, kind) => kind === 'warning' ? commands.reportWarning(message) : commands.reportError(message))
  // A throttled frame (a hidden or background window) can come after a dialog opened; the dialog keeps focus then.
  const scripting = new ScriptingService({ api, documents, files, connections, options: scriptingOptions, focusEditor: () => nextFrame(() => { if (!modalOpen()) documents.boundEditor?.focus() }) })
  const context = new ContextKeyService({ platform, documents, queries, connections, backend, editorOptions, panes, quickInput: quickInput.visibility, explorer: explorer.context, results: results.context, scripting: scripting.running, editor: () => documents.boundEditor })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  const menuTargets = new MenuTargetService({ editor: () => {
    const editor = documents.boundEditor, tabId = documents.getSnapshot().activeId
    return editor && tabId ? { container: editor.getContainerDomNode(), tabId } : undefined
  } })
  // Menus label items with keys and the dispatcher routes keys to the menus; neither looks the other up before both exist.
  const menus = new MenuService({ platform, commands, context, keybindings: { lookup: id => keybindings.lookup(id) }, theme, focus, modalOpen,
    findWidgetFocused: () => !!document.activeElement?.closest('.monaco-editor .find-widget'),
    menubarRect: id => document.getElementById('menubar-' + id)?.getBoundingClientRect(), targets: menuTargets, editorCaret: () => editorCaret(documents, monaco),
    modalContains: element => [...document.querySelectorAll('[aria-modal="true"]')].at(-1)?.contains(element) ?? false, style: api.menuStyle, api })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, menus, editorHasTextFocus: () => documents.boundEditor?.hasTextFocus() ?? false,
    editorContains: target => target instanceof Node && !!documents.boundEditor?.getContainerDomNode().contains(target) })
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = { platform, monaco, events, commands, context, keybindings, menuState, menus, menuTargets, quickInput, documents, queries, connections, backend, resultClient, results, resultMemory, ...gridStats ? { gridStats } : {}, files, targets, editorOptions, panes, explorer, databaseList, resultSelection, scriptingOptions, scripting, theme, dispose: () => {
    if (disposed) return
    disposed = true
    // Hiding the quick input first aborts its loads and ends any theme preview before the services they use go away.
    listeners.forEach(listener => listener.dispose()); menus.dispose(); quickInput.dispose(); menuState.dispose(); keybindings.dispose()
    contributions.forEach(contribution => contribution.dispose())
    cleanup.dispose(); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); results.dispose(); resultMemory.dispose(); resultClient.dispose(); documents.dispose(); backend.dispose(); explorer.dispose(); databaseList.dispose(); scripting.dispose(); connections.dispose(); editorOptions.dispose(); panes.dispose(); resultSelection.dispose(); scriptingOptions.dispose(); theme.dispose(); events.dispose()
  } }
  const contributions = [queryContribution(workbench, api), filesContribution(workbench, api), editorContribution(workbench), editContribution(workbench, api), windowContribution(workbench, api),
    menusContribution(workbench), explorerContribution(workbench, api), outputContribution(workbench, api), paletteContribution(workbench), themeContribution(workbench, api), backendContribution(workbench), scriptingContribution(workbench)]
  // Capture on window runs before Monaco's own listeners and React's handlers.
  const listeners = [keybindings.attach(window), menus.attach(window), trackWindowFocus(window, document.documentElement)]
  // Requests carry the defaults until main's stored options arrive; a warning about the file shows in the command banner.
  void scriptingOptions.load()
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  return workbench
}
