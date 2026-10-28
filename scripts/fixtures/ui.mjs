// Where Varia's surfaces are, for the smoke suites and the Electron benches. Suites find a surface by its ARIA role and
// accessible name, through the locators here, so a restyle or a reshuffled shell changes this file rather than every
// suite. The parts with no role or name of their own (layout probes, decorative marks, a strip's text) are the class
// names in `part`, `gridPart` and `queryFacts`, used only from here and from page code that receives them as arguments.
// tests/smoke-selectors.test.ts keeps Varia's class names out of the suites and checks that each one here still exists
// in the renderer.

/**
 * CSS selectors for page code (pass them in as arguments: they are plain strings) and for the parts without a role or
 * name. The first ones are the surfaces by role and name, which page code cannot reach through a locator.
 */
export const part = {
  menubar: '[role="menubar"][aria-label="Application menu"]',
  toolbar: '[role="toolbar"][aria-label="Standard"]',
  documentTabs: '[role="tablist"][aria-label="Query documents"]',
  statusBar: 'footer[aria-label="Status bar"]',
  queryStatus: '[role="status"][aria-label="Query status"]',
  explorerToolbar: '[role="toolbar"][aria-label="Object Explorer toolbar"]',
  /** The tree by role and name: it waits for nothing, so page code can look for a tree that is not there yet. */
  explorerTree: '[role="tree"][aria-label="Object Explorer"]',
  // Shell
  titleBar: '.title-bar',
  titleBarContent: '.title-bar-content',
  titleBarCaption: '.title-bar-caption',
  /** The Varia mark at the title bar's start. */
  titleBarBrand: '.title-bar-brand',
  /** The banners above the workspace: command, file and theme notices and the backend's. */
  banner: '.global-error',
  backendBanner: '.backend-banner',
  themeNotice: '.theme-notice',
  workbench: '.workbench',
  explorerPane: '.explorer',
  editorPane: '.editor-container',
  // Status bar and query status
  editorStatus: '.editor-status',
  memory: '.memory-indicator',
  statusSegment: '.status-scripting',
  statusSegmentText: '.status-scripting-text',
  statusSegmentMore: '.status-scripting-more',
  /** The state sentence and its icon. */
  queryState: '.query-status-state',
  queryStatusText: '.query-status-text',
  /** The login and SPID of the query's session. */
  querySession: '.status-session',
  querySegment: '.query-status-segment',
  // Document tabs
  tabName: '.tab-name',
  /** The kind icon before a tab's name (kindIcon finds it by name; page code needs its box and stroke). */
  tabIcon: '.tab-icon',
  // Query output
  outputToolbar: '.output-toolbar',
  outputStatus: '.output-status',
  jobProgress: '.job-strip:not(.job-notice)',
  jobNotice: '.job-notice',
  outputEmpty: '.output-empty',
  // The states kit's empty view (src/renderer/src/kit/EmptyState.tsx) and the surfaces that place one.
  emptyState: '.empty-state',
  emptyStateIcon: '.empty-state-icon',
  emptyStateTitle: '.empty-state-title',
  emptyStateDetail: '.empty-state-detail',
  /** The filled action of an empty view; a view has at most one. */
  primaryAction: 'button.primary',
  explorerEmpty: '.explorer-empty',
  workspaceEmpty: '.workspace-empty',
  dockEmpty: '.dock-empty',
  /** Object Explorer's fault view (an InlineError) and the outcome line of its Copy details. */
  explorerFault: '.explorer-fault',
  inlineErrorStatus: '.inline-error-status',
  errorMessage: '.msg.error',
  errorCount: '.error-count',
  resultItem: '.rs-item',
  resultStack: '.rs-stack',
  // Object Explorer
  explorerLabel: '.oe-label',
  explorerText: '.oe-text',
  /** A row's label, or a synthetic row's text. */
  explorerRowText: '.oe-label, .oe-text',
  explorerSublabel: '.oe-sublabel',
  explorerFiltered: '.oe-filtered',
  explorerTwistie: '.oe-twistie',
  explorerIcon: '.oe-icon',
  explorerBadge: '.oe-badge',
  explorerAccent: '.oe-accent',
  explorerProgressRow: '.explorer-row.progress',
  explorerErrorRow: '.explorer-row.error',
  explorerSyntheticRow: '.explorer-row.synthetic',
  explorerError: '.explorer-error',
  /** A row's end (RowEnd): indicators (live state chips, the environment tag), the item count, the connection dot. */
  explorerEnd: '.oe-end',
  /** A row's live status chips (ExplorerStatusService), hidden from screen readers: the row's name says them. */
  explorerChips: '.oe-chips',
  explorerCount: '.oe-count',
  /** A server's connection dot; data-state says online, error or lost (the row's name and tooltip say it in words). */
  explorerDot: '.oe-dot',
  /** The glyph that marks the active query's server. */
  explorerActive: '.oe-active',
  /** The part of a label that matches the Filter loaded objects text. */
  explorerMatch: '.oe-match',
  /** The Filter loaded objects field around its input, and the line under it when nothing matches. */
  explorerFilter: '.explorer-filter',
  explorerNoMatch: '.explorer-no-match',
  /** The pane's footer: the selection's listing and its freshness, then the connected servers. */
  explorerFooter: '.explorer-footer',
  explorerFreshness: '.explorer-freshness',
  explorerFreshnessScope: '.explorer-freshness-scope',
  explorerServers: '.explorer-servers',
  /** The states kit's "Updated …" or, with data-stale, "Stale since …" (src/renderer/src/kit/LivePill.tsx). */
  staleBadge: '.stale-badge',
  // Menus and the quick input
  menuLayer: '.menu-layer',
  menuMnemonic: '.menu-mnemonic',
  menuKeybinding: '.menu-keybinding',
  quickInput: '.quick-input',
  quickInputTitle: '.quick-input-title',
  quickInputLabel: '.quick-input-label',
  quickInputHighlight: '.quick-input-hl',
  quickInputGroup: '.quick-input-group',
  quickInputEmpty: '.quick-input-empty',
  // Connection environment labels (src/renderer/src/EnvironmentTag.tsx): the kit's tag, in a wrapper that bounds it per
  // place (data-place: explorer, tab, query, status or list), and the kit's pill and its label inside it.
  environmentTag: '.environment-tag',
  statusPill: '.status-pill',
  statusPillLabel: '.status-pill-label',
  /** The status bars' spans that hold the tag with its visually hidden prefix. */
  queryEnvironment: '.query-status-environment',
  statusEnvironment: '.status-environment',
  // Dialogs
  connectionChoice: '.connection-choice',
  /** The Connect and Connection Environment dialogs' scrolling form, and the Environment field's preview of the tag. */
  connectionScroll: '.connection-scroll',
  environmentPreview: '.environment-preview',
  optionsNote: '.options-note',
  optionsDescription: '.options-description',
  optionsForm: '.options-form',
  optionsPage: '.options-page',
  optionsRow: '.options-row',
  recoveryGrid: '.recovery-grid',
  modalBackdrop: '.modal-backdrop',
  // Table designer and the editor
  tableDesigner: '.table-designer',
  designerText: '.designer-text',
  bookmarkGlyph: '.varia-bookmark',
  dropCaret: '.dnd-target',
  // Docking
  dockingGuides: '.docking-guides',
  dockingGuideCell: '.docking-guide-cell',
  activeDockingGuideCell: '.docking-guide-cell.active',
  dockingPreview: '.docking-preview',
  /** Varia's class on Dockview's shell, next to Dockview's theme class: the dock's colours hang off it. */
  dockShell: '.varia-dock',
  // Stand-ins: page code gives a probe element these classes to read what the stylesheet gives that surface (a menu's
  // entrance, a selected tree row, the current dialog page, an open menu-bar button) without opening one.
  menu: '.menu',
  explorerTreeBox: '.explorer-tree',
  explorerRow: '.explorer-row',
  explorerServerRow: '.explorer-row.server',
  activeDocumentTab: '.query-tab.active',
  dialogPages: '.object-dialog-pages',
  titleBarMenus: '.title-bar-menus'
}

/** The query status facts by key (QueryStatusSegment's keys), each in its own segment. */
export const queryFacts = {
  server: '.query-status-server',
  login: '.query-status-login',
  database: '.query-status-database',
  time: '.query-status-time',
  rows: '.query-status-rows'
}

/** GridView's parts inside a results grid (`[data-result-grid]`), by role where the grid has one. */
export const gridPart = {
  scroller: '.rg-scroll',
  frame: '.rg-frame',
  strip: '.rg-strip',
  overlay: '.rg-overlay',
  head: '.rg-head',
  corner: '.rg-corner',
  columnHeader: '.rg-ch',
  selectedColumnHeader: '.rg-ch.sel',
  row: '[role="rowgroup"] > [role="row"]',
  rowHeader: '[role="rowheader"]',
  /** The drawn row numbers (screen readers read each row's own header instead). */
  rowNumber: '.rg-rn',
  cell: '[role="gridcell"]',
  selectedCell: '[role="gridcell"][aria-selected="true"]',
  loadingCell: '.rg-c.is-load',
  /** Drawn states with no ARIA of their own: the current cell, a value stored cut, an XML or JSON link, a column border under the pointer. */
  activeCell: '.rg-c.is-act',
  truncatedCell: '.rg-c.is-trunc',
  linkCell: '.rg-c.is-link',
  borderHover: '.rg-border-hover'
}
/** The data cell at a row and column, both from 0, inside a results grid. */
export const gridCellSelector = (row, column) => `[role="rowgroup"] > [role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${column + 2}"]`

const named = (name, exact = true) => typeof name === 'string' ? { name, exact } : { name }

// The shell

export const titleBar = page => page.locator(part.titleBar)
/** Dockview's theme classes on its shell, and whether Varia's own class sits beside them. */
export const dockShell = page => page.locator('.dv-shell').evaluate((element, own) => ({ themes: [...element.classList].filter(name => name.startsWith('dockview-theme-')).sort(), varia: element.matches(own) }), part.dockShell)
export const menubar = page => page.getByRole('menubar', { name: 'Application menu', exact: true })
/** The Standard toolbar: Connect, New query, Open, Save, Execute, Cancel, Layouts, and the server and database pickers. */
export const toolbar = page => page.getByRole('toolbar', { name: 'Standard', exact: true })
export const toolbarButton = (page, name) => toolbar(page).getByRole('button', named(name))
export const queryServer = page => page.getByLabel('Query server', { exact: true })
export const queryDatabase = page => page.getByLabel('Query database', { exact: true })
export const banner = page => page.locator(part.banner)
/** The command and file banners: errors are alerts, warnings are statuses. */
export const errorBanner = page => page.locator(part.banner + '[role="alert"]')
export const warningBanner = page => page.locator(part.banner + '[role="status"]')
export const backendBanner = page => page.locator(part.backendBanner)
export const themeNotice = page => page.locator(part.themeNotice)
export const layoutError = page => banner(page).filter({ has: page.getByRole('button', { name: 'Dismiss layout error', exact: true }) })
export const statusBar = page => page.getByRole('contentinfo', { name: 'Status bar', exact: true })
/** The status bar's Object Explorer segment (renames, scripting, notices), a live region. */
export const statusSegment = page => statusBar(page).getByRole('status')
export const editorStatus = page => statusBar(page).locator(part.editorStatus)
export const caretStatus = page => editorStatus(page).getByLabel(/^Line \d+, column \d+, character \d+$/)
export const inputModeStatus = page => editorStatus(page).getByTitle(/ mode \(Insert switches to/)
export const lineEndingStatus = page => editorStatus(page).getByTitle('Line endings', { exact: true })
export const encodingStatus = page => editorStatus(page).getByTitle('Encoding', { exact: true })
export const readOnlyStatus = page => editorStatus(page).getByText('Read-only', { exact: true })
export const memoryIndicator = page => statusBar(page).locator(part.memory)
/** The active document's status: its state sentence and connection facts, or a value document's kind. */
export const queryStatus = page => page.getByRole('status', { name: 'Query status', exact: true })
/** One query status fact by key: server, login, database, time or rows. */
export const queryFact = (page, key) => {
  if (!Object.hasOwn(queryFacts, key)) throw new Error('No query status fact ' + key)
  return queryStatus(page).locator(queryFacts[key])
}
export const querySession = page => queryStatus(page).locator(part.querySession)

// Documents

export const documentTabs = page => page.getByRole('tablist', { name: 'Query documents', exact: true })
export const documentTab = (page, name) => documentTabs(page).getByRole('tab', named(name))
export const activeDocument = page => documentTabs(page).getByRole('tab', { selected: true })
export const activeDocumentName = page => activeDocument(page).getAttribute('aria-label')
/** A document's tab with its Close button: the target of the tab's menu. */
export const documentTabSlots = page => documentTabs(page).locator('[data-tab-id]')
export const closeDocumentButton = (page, name) => documentTabs(page).getByRole('button', { name: 'Close ' + name, exact: true })
/** The marks a document tab draws after its name. */
export const unsavedMark = scope => scope.getByRole('img', { name: 'Unsaved changes', exact: true })
export const readOnlyMark = scope => scope.getByRole('img', { name: 'Read-only', exact: true })
export const executingMark = scope => scope.getByRole('img', { name: 'Executing', exact: true })
/** A tab's kind icon, drawn before its name and named by the kind: Transact-SQL, XML document, JSON document, Execution plan or Table Designer. */
export const kindIcon = (tab, kind) => tab.getByRole('img', { name: kind, exact: true })
export const editorTextbox = page => page.locator('.monaco-editor [role="textbox"]')
export const editorText = page => page.locator('.monaco-editor .view-lines').innerText()

// Panes: the dock's panels, each with a tab in its group's header

const paneTitles = { explorer: 'Object Explorer', editor: 'Query editor', output: 'Query output' }
export const pane = (page, id) => page.locator(`[data-pane="${id}"]`)
export const paneTab = (page, id) => page.locator(`[data-pane-tab="${id}"]`)
export const closePaneButton = (page, id) => page.getByRole('button', { name: 'Close ' + paneTitles[id], exact: true })
/** Moves the pane its group shows: left, right, top, bottom, float, close, or tab:<pane>. */
export const movePane = (page, id, where) => page.getByLabel('Move ' + paneTitles[id], { exact: true }).selectOption(where)

// Query output

// Dockview names its active group's region after the panel too, so the pane's own region is the section.
export const outputPane = page => page.locator('section[aria-label="Query output"]')
export const outputViews = page => page.getByRole('tablist', { name: 'Query output views', exact: true })
export const outputView = (page, name) => outputViews(page).getByRole('tab', named(name))
/** The pane's own live region, which announces how a run, a copy or a save ended. */
export const outputAnnouncer = page => outputPane(page).locator(':scope > [role="status"]')
/** The strip above the output: the Results and Messages tabs, the status line and the copy and save strips. */
export const outputToolbar = page => outputPane(page).locator(part.outputToolbar)
export const outputStatus = page => outputPane(page).locator(part.outputStatus)
export const jobProgress = page => outputPane(page).locator(part.jobProgress)
export const jobNotice = page => outputPane(page).locator(part.jobNotice)
export const outputEmpty = page => outputPane(page).locator(part.outputEmpty)
/** A surface's empty view, matched only when it is the states kit's (so a hand-made one fails), and its parts. */
export const emptyState = surface => matching(surface, part.emptyState)
export const explorerEmpty = page => page.locator(part.explorerEmpty)
export const workspaceEmpty = page => page.locator(part.workspaceEmpty)
export const dockEmpty = page => page.locator(part.dockEmpty)
export const emptyStateIcon = view => view.locator(part.emptyStateIcon)
export const emptyStateTitle = view => view.locator(part.emptyStateTitle)
export const emptyStateDetail = view => view.locator(part.emptyStateDetail)
export const primaryAction = view => view.locator(part.primaryAction)
export const explorerFault = page => page.locator(part.explorerFault)
export const copyOutcome = view => view.locator(part.inlineErrorStatus)
export const messages = page => page.getByRole('log', { name: 'Messages', exact: true })
/** Each message and tail line; an error's differs only in its colour. */
export const messageLines = page => messages(page).locator('pre')
export const errorMessages = page => messages(page).locator(part.errorMessage)
export const resultGrid = (page, index = 0) => page.locator(`[data-result-grid][data-result-index="${index}"]`)
export const anyResultGrid = page => page.locator('[data-result-grid]')
export const gridCell = (grid, row, column) => grid.locator(gridCellSelector(row, column))
/** Whether a locator's element also matches a part's selector, for the drawn states (`gridPart.linkCell`). */
export const matching = (locator, selector) => locator.and(locator.page().locator(selector))
export const resultSplitters = page => page.getByRole('separator', { name: /^Resize Result \d+$/ })

// Object Explorer

export const explorerToolbar = page => page.getByRole('toolbar', { name: 'Object Explorer toolbar', exact: true })
export const explorerTree = page => page.getByRole('tree', { name: 'Object Explorer', exact: true })
/** The servers: the tree's first level. */
export const serverRows = page => explorerTree(page).locator('[role="treeitem"][aria-level="1"]')
export const lostServerRows = page => explorerTree(page).getByRole('treeitem', { name: /\(connection lost\)$/ })
export const explorerLabel = row => row.locator(part.explorerLabel)
export const explorerSublabel = row => row.locator(part.explorerSublabel)
export const itemCount = row => row.locator(part.explorerCount)
export const connectionDot = row => row.locator(part.explorerDot)
/** The labels of a row's live status chips, in order ("RESTORING 42 %", "2 jobs running"). */
export const statusChips = row => row.locator(`${part.explorerChips} ${part.statusPillLabel}`)
/** The server rows marked as the active query's server (at most one). */
export const activeServerRows = page => serverRows(page).filter({ has: page.locator(part.explorerActive) })
export const explorerMatches = page => explorerTree(page).locator(part.explorerMatch)
export const explorerFilterBox = page => page.getByRole('textbox', { name: 'Filter loaded objects', exact: true })
export const explorerFilterField = page => page.locator(part.explorerFilter)
export const explorerNoMatch = page => page.locator(part.explorerNoMatch)
export const explorerFooter = page => page.locator(part.explorerFooter)
export const explorerFreshness = page => explorerFooter(page).locator(part.explorerFreshness)
export const explorerFreshnessScope = page => explorerFooter(page).locator(part.explorerFreshnessScope)
export const explorerServerCount = page => explorerFooter(page).locator(part.explorerServers)
export const staleBadge = scope => scope.locator(part.staleBadge)
/** The inline Rename box (F2) in a row. */
export const renameBox = page => explorerTree(page).getByRole('textbox', { name: /^Rename / })

// Dialogs

/** The Connect dialog's Error details expander under a failed connect, or under the database note (Load databases). */
export const connectErrorDetails = dialog => dialog.locator('[role="alert"] + details')
export const databaseErrorDetails = dialog => dialog.locator('[role="status"] + details')
/** An object dialog's Connection and Progress boxes (Delete Object, Database Properties). */
export const objectDialogConnection = dialog => dialog.getByRole('region', { name: 'Connection', exact: true })
export const objectDialogProgress = dialog => dialog.getByRole('region', { name: 'Progress', exact: true }).getByRole('status')
export const objectDialogWarnings = dialog => dialog.getByRole('list', { name: 'Warnings', exact: true }).getByRole('listitem')
/** The Options dialog's page heading (Query Execution › SQL Server › General), notes, form and description pane. */
export const optionsHeading = dialog => dialog.getByRole('heading', { level: 3 })
export const optionsNotes = dialog => dialog.locator(part.optionsNote)
export const optionsForm = dialog => dialog.locator(part.optionsForm)
export const optionsDescription = dialog => dialog.locator(part.optionsDescription)
/** Saved connections in the Connect dialog's history, by the text they show. */
export const savedConnections = (dialog, text) => dialog.locator(part.connectionChoice, { hasText: text })
/** A connection's environment tag (its pill) in a place: explorer, tab, query or status. */
export const environmentPill = (scope, place) => scope.locator(`${part.environmentTag}[data-place="${place}"] ${part.statusPill}`)

// Menus and the quick input

export const openMenus = page => page.getByRole('menu')
/** The item the keyboard or pointer has made current in an open menu. */
export const activeMenuItem = page => openMenus(page).locator('[role^="menuitem"][data-active]')
/** A menu's items by the names screen readers read: their labels, without the drawn keys and chevrons. */
export const menuItemNames = (menu, { disabled } = {}) => menu.locator(`[role^="menuitem"]${disabled ? '[aria-disabled="true"]' : ''}`)
  .evaluateAll(items => items.map(item => [...item.children].filter(child => child.getAttribute('aria-hidden') !== 'true').map(child => child.textContent).join('')))
/** The command palette and the pickers that share its widget (a dialog named by its title or its input). */
export const quickInput = page => page.locator(part.quickInput)
export const quickInputBox = page => quickInput(page).getByRole('combobox')
export const quickInputRows = page => quickInput(page).getByRole('option')
/** The row the input's active descendant names. */
export const quickInputActive = page => quickInput(page).getByRole('option', { selected: true })
/** The live region for a hint or an error under the input; it stays in place while empty. */
export const quickInputMessage = page => quickInput(page).locator('[aria-live="polite"]')
