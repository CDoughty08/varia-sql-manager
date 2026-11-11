// Where Varia's surfaces are, for the smoke suites and the Electron benches. Suites find a surface by its ARIA role and
// accessible name, through the locators here, so a restyle or a reshuffled shell changes this file rather than every
// suite. The parts with no role or name of their own (layout probes, decorative marks, a strip's text) are the class
// names in `part`, `gridPart` and `queryFacts`, used only from here and from page code that receives them as arguments.
// tests/smoke-selectors.test.ts keeps Varia's class names out of the suites and checks that each one here still exists
// in the renderer.
import { expect } from '@playwright/test'

/**
 * CSS selectors for page code (pass them in as arguments: they are plain strings) and for the parts without a role or
 * name. The first ones are the surfaces by role and name, which page code cannot reach through a locator.
 */
export const part = {
  menubar: '[role="menubar"][aria-label="Application menu"]',
  toolbar: '[role="toolbar"][aria-label="Standard"]',
  queryBar: '[role="toolbar"][aria-label="SQL Editor"]',
  queryScope: '.query-scope',
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
  titleBarMenus: '.title-bar-menus',
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
  /** The tab's bounded name, environment and live-session area, before Pin and Close. */
  tabSelect: '.tab-select',
  /** The filename/state row and the environment/session row below it. */
  tabTitle: '.tab-title',
  tabMetadata: '.tab-metadata',
  /** Editor groups (src/renderer/src/editor-groups/): Dockview's groups inside the query editor panel, and the active one. */
  /** The editor area in the Query editor panel: every editor group, under the active query's bar. */
  editorArea: '.editor-groups-root',
  editorGroup: '.editor-groups .dv-groupview',
  activeEditorGroup: '.editor-groups .dv-groupview.dv-active-group',
  floatingEditorGroup: '.editor-groups .dv-resize-container .dv-groupview',
  /** A floating editor group's right-edge resize handle, beside the group rather than inside it. */
  floatingEditorResizeRight: '.editor-groups .dv-resize-container .dv-resize-handle-right',
  tabSid: '.tab-sid',
  /** The kind icon before a tab's name (kindIcon finds it by name; page code needs its box and stroke). */
  tabIcon: '.tab-icon',
  // Query output
  outputPanel: 'section[data-output-panel]',
  outputAnnouncer: '[data-output-announcer]',
  resultsSearchIcon: '.results-search-icon',
  /** The results search box's count, drawn only: the toolbar's live region says the settled count (resultsSearchAnnouncer). */
  resultsSearchCount: '.results-search-count',
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
  /** An InlineError's sentence (the live region) and the note read with it. */
  inlineErrorMessage: '.inline-error-message',
  inlineErrorNote: '.inline-error-note',
  errorMessage: '.msg.error',
  errorCount: '.error-count',
  resultItem: '.rs-item',
  /** A set's caption above its grid: Collapse and its name, its rows and columns, its batch, and Save Results As. */
  resultCaption: '.rs-caption',
  resultStack: '.rs-stack',
  /** A live grid's frame (LiveGridPane), which holds the grid and its strips. */
  liveGrid: '.live-grid',
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
  /** The tree's own box and rows, for page code that builds a probe tree to read the row styles. */
  explorerTreeView: '.explorer-tree',
  explorerRow: '.explorer-row',
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
  /** Object Explorer's search (SearchPanel's pane layout) and the field around its input. */
  explorerSearch: '.object-search-pane',
  /** A Search Objects tab's document. */
  objectSearchTab: '[data-object-search]',
  explorerSearchField: '.object-search-pane .object-search-field',
  /** The pane's footer: the selection's listing and its freshness, then the connected servers. */
  explorerFooter: '.explorer-footer',
  explorerFreshness: '.explorer-freshness',
  explorerFreshnessScope: '.explorer-freshness-scope',
  explorerServers: '.explorer-servers',
  /** The states kit's "Updated …" or, with data-stale, "Stale since …" (src/renderer/src/kit/LivePill.tsx). */
  staleBadge: '.stale-badge',
  // Menus and the quick input
  menu: '.menu',
  menuLayer: '.menu-layer',
  // Toasts (src/renderer/src/kit/Toasts.tsx): the layer holds the stack and the two live regions that announce them.
  toastLayer: '.toast-layer',
  toastMessage: '.toast-message',
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
  /** The states kit's live label (kit/LivePill.tsx): "Live · every 2 s", "Paused", "Stopped · backend unavailable". */
  livePill: '.live-pill',
  statusPillLabel: '.status-pill-label',
  /** A pill's number (StatusPill `value`: a percentage, a count), which never gives way to the label beside it. */
  statusPillValue: '.status-pill-value',
  /** The spans that hold the tag with its visually hidden prefix: the query bar's, the classic query status bar's, and the window status bar's. */
  queryEnvironment: '.query-bar-environment',
  queryStatusEnvironment: '.query-status-environment',
  statusEnvironment: '.status-environment',
  // Dialogs
  connectionChoice: '.connection-choice',
  /** The Connect dialog's failure: its InlineError and the Error details under it. */
  connectFailure: '.connect-failure',
  // Connect v2's layout, for the probes that measure it: the two panes, the form's own scroll, and at its bottom the
  // outcome (busy, notices, the failure) above the footer with Connect.
  connectPanes: '.connect-panes',
  connectSourcesPane: '.connect-sources-pane',
  connectFormPane: '.connect-form-pane',
  connectFormScroll: '.connect-form-scroll',
  connectActions: '.connect-actions',
  connectOutcome: '.connect-outcome',
  connectionFooter: '.connection-footer',
  /** The saved connections' list, one of its rows (the entry with its star and ×), and a connection's colour dot. */
  connectionSources: '.connection-sources',
  connectionListRow: '.connection-list-row',
  connectionSwatch: '.connection-swatch',
  visuallyHidden: '.visually-hidden',
  /** The Connect and Connection Environment dialogs' scrolling form, and the Environment field's preview of the tag. */
  connectionScroll: '.connection-scroll',
  environmentPreview: '.environment-preview',
  optionsNote: '.options-note',
  // Object dialogs (Delete Object): the column beside the page list, the page shown in it, and a run's Steps panel
  objectDialogMain: '.object-dialog-main',
  objectDialogPage: '.object-dialog-page:not([hidden])',
  objectDialogSteps: '.object-dialog-steps',
  objectDialogCaption: '.object-dialog-caption',
  // Attach Databases: a path cell's file name, which stays visible while its folder gives way
  attachPathName: '.attach-path-name',
  stepList: '.step-list',
  stepListText: '.step-list-text',
  optionsDescription: '.options-description',
  optionsForm: '.options-form',
  optionsPage: '.options-page',
  optionsRow: '.options-row',
  recoveryGrid: '.recovery-grid',
  modalBackdrop: '.modal-backdrop',
  // Table designer and the editor
  tableDesigner: '.table-designer',
  // The document frame
  documentHeader: '.document-header',
  /** The header's kind of document ("Folder Properties") and the fact line. */
  documentSubtitle: '.document-subtitle',
  documentFacts: '.document-facts',
  /** The states kit's pill (src/renderer/src/kit/StatusPill.tsx), as a document header shows its state. */
  statusPill: '.status-pill',
  documentBanner: '.document-banner',
  // Property sheets in documents (src/renderer/src/kit/PropertyField.tsx)
  propertyField: '.property-field',
  propertyFact: '.property-fact',
  fieldHint: '.field-hint',
  /** The frame's scrolling content under the header and fact line. */
  documentContent: '.document-content',
  // The Activity Monitor (src/renderer/src/activity): a banner (the kit's InlineError in a box), and a tile's caption, which
  // assistive technology hears in the tile's name instead.
  activityBanner: '.activity-banner',
  tileCaption: '.tile-caption-text',
  designerText: '.designer-text',
  bookmarkGlyph: '.varia-bookmark',
  dropCaret: '.dnd-target',
  // Docking
  /** The shown compass: the workspace and the editor area each have one, hidden while no drag is over it. */
  dockingGuides: '.docking-guides:not([hidden])',
  dockingGuideCell: '.docking-guide-cell',
  activeDockingGuideCell: '.docking-guide-cell.active',
  dockingPreview: '.docking-preview:not([hidden])',
  /** Varia's class on Dockview's shell, next to Dockview's theme class: the dock's colours hang off it. */
  dockShell: '.varia-dock',
  // Live charts (src/renderer/src/live/LiveChart.tsx): the crosshair's tooltip (hidden from assistive technology, as the
  // status region says the same), the legend's line samples, and the scroll box that holds View as table.
  chartTooltip: '.live-chart-tip',
  chartSwatch: '.live-chart-swatch',
  chartTableWrap: '.live-chart-table-wrap',
  // Restore Database's Backup Timeline (src/renderer/src/restore/BackupTimeline.tsx): a backup's mark on the track (full,
  // differential or log, by kind) and the legend's samples, which draw the same shapes.
  restoreTimelineFull: '.restore-timeline-track .restore-timeline-full',
  restoreTimelineDifferential: '.restore-timeline-track .restore-timeline-differential',
  restoreTimelineLog: '.restore-timeline-track .restore-timeline-log',
  restoreTimelineCovered: '.restore-timeline-track .restore-timeline-covered',
  restoreTimelineSwatch: '.restore-timeline-swatch',
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
  /** The SQL type after a header's name, drawn only (screen readers read it in the tooltip). */
  columnType: '.rg-ct',
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
  /** White space marks (results toolbar › White space), drawn only and hidden from screen readers; a badge names one character (CR, LF, NBSP…). */
  whitespaceMark: '.rg-ws',
  whitespaceBadge: '.rg-wsb',
  /** A header's sort button and its place among several keys, hidden from screen readers (the header's aria-sort says it). */
  sortButton: '.rg-cs',
  sortedButton: '.rg-cs.on',
  sortOrder: '.rg-co',
  /** A header's funnel (results grids), hidden from screen readers (Filter Column Values, Alt+Down, opens the same
   *  popover); filled while its column has a filter. */
  funnelButton: '.rg-cf',
  funnelOn: '.rg-cf.on',
  /** Search in results' marks (GridView's marks), drawn only: a matched cell, the active match, a column header a
   *  column-name search matches, and cells and headers it leaves out. The active cell's label says "search match". */
  searchMatch: '.rg-c.is-hit',
  searchCurrent: '.rg-c.is-cur',
  searchColumn: '.rg-ch.hit, .rg-ch.cur',
  searchDimmedHeader: '.rg-ch.dim',
  borderHover: '.rg-border-hover',
  /** A highlighted row (Highlight Rows), drawn in its colour; its row header's aria-description names the colour. */
  highlightedRow: '[role="rowgroup"] > [role="row"][aria-rowindex].hl',
  /** A result diff's rows (Compare with Previous Result): added (+) and removed (−), and its differing cells: a changed
   *  value, and one equal to the other only by collation. */
  addedRow: '[role="rowgroup"] > [role="row"][aria-rowindex].tone-added',
  removedRow: '[role="rowgroup"] > [role="row"][aria-rowindex].tone-removed',
  changedCell: '[role="gridcell"].is-chg',
  softCell: '[role="gridcell"].is-soft',
  /** A live grid's row tones (LiveGrid), drawn with no ARIA of their own: the active cell's label names the tone. */
  toneError: '.tone-error',
  toneWarning: '.tone-warning',
  toneRunning: '.tone-running',
  toneMuted: '.tone-muted'
}
/** A live grid's row tones by name, for page code that reads which tone a row has. */
export const gridTones = { error: gridPart.toneError, warning: gridPart.toneWarning, running: gridPart.toneRunning, muted: gridPart.toneMuted }
/** The data cell at a row and column, both from 0, inside a results grid. */
export const gridCellSelector = (row, column) => `[role="rowgroup"] > [role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${column + 2}"]`

const named = (name, exact = true) => typeof name === 'string' ? { name, exact } : { name }

// The shell

export const titleBar = page => page.locator(part.titleBar)
/** Dockview's theme classes on its shell, and whether Varia's own class sits beside them. */
// The workspace's shell: the editor area nests a second Dockview inside it.
export const dockShell = page => page.locator('.dv-shell').first().evaluate((element, own) => ({ themes: [...element.classList].filter(name => name.startsWith('dockview-theme-')).sort(), varia: element.matches(own) }), part.dockShell)
export const menubar = page => page.getByRole('menubar', { name: 'Application menu', exact: true })
/**
 * The Standard toolbar: in the header, icon buttons named Connect, New query, Open, Save, Save All and Activity Monitor;
 * with the classic toolbar on, the same names as text buttons plus Execute, Cancel and Layouts, and the server and
 * database lists.
 */
export const toolbar = page => page.getByRole('toolbar', { name: 'Standard', exact: true })
export const toolbarButton = (page, name) => toolbar(page).getByRole('button', named(name))
/** A query's own bar (SSMS's SQL Editor toolbar): Execute, Cancel, and the Connection group with the server and database lists. */
export const queryBar = page => page.getByRole('toolbar', { name: 'SQL Editor', exact: true })
export const queryBarButton = (page, name) => queryBar(page).getByRole('button', named(name))
export const queryScope = page => queryBar(page).locator(part.queryScope)
export const queryConnection = page => queryBar(page).getByRole('group', { name: 'Connection', exact: true })
/** The active query's server and database lists: in its query bar, or in the classic toolbar when that is on. */
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
/**
 * The status bar's backend segment once the backend is ready: Ready, with the runtime in its tooltip ('fake' for the
 * fake backend; by default the real one's .NET).
 */
export const backendReady = (page, runtime = /\.NET \d+\./) => statusBar(page).getByTitle(new RegExp('^SQL backend: ' + (typeof runtime === 'string' ? runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : runtime.source)))
/** The header's search box (the command centre). */
export const searchBox = page => titleBar(page).getByRole('button', { name: 'Search', exact: true })
/** The status bar's Object Explorer segment (renames, scripting, notices), a live region. */
export const statusSegment = page => statusBar(page).locator(part.statusSegment)
export const editorStatus = page => statusBar(page).locator(part.editorStatus)
export const caretStatus = page => editorStatus(page).getByLabel(/^Line \d+, column \d+, character \d+$/)
export const inputModeStatus = page => editorStatus(page).getByTitle(/ mode \(Insert switches to/)
export const lineEndingStatus = page => editorStatus(page).getByTitle('Line endings', { exact: true })
export const encodingStatus = page => editorStatus(page).getByTitle('Encoding', { exact: true })
export const readOnlyStatus = page => editorStatus(page).getByText('Read-only', { exact: true })
export const memoryIndicator = page => statusBar(page).locator(part.memory)
export const memoryBreakdown = page => page.getByRole('region', { name: 'Memory usage', includeHidden: true })
export const memoryUsage = (page, feature) => page.locator(`.memory-details .memory-row[data-feature="${feature}"] .memory-usage`)
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
/** The active document's tab: the tab its group shows, in the active group (each group has a tab strip and a selected tab). */
export const activeDocument = page => page.locator(part.activeEditorGroup).getByRole('tablist', { name: 'Query documents', exact: true }).getByRole('tab', { selected: true })
export const activeDocumentName = page => activeDocument(page).getAttribute('aria-label')
/** The editor groups, the grid's in order and then the floating ones, and the tabs of one. */
export const editorGroups = page => page.locator(part.editorGroup)
/** The grid or floating editor group showing a particular query. Query editors stay in the main window. */
export const editorGroupForDocument = (page, name) => page.getByRole('region', { name: `Editor group: ${name}`, exact: true })
export const editorGroupTabs = group => group.getByRole('tablist', { name: 'Query documents', exact: true }).getByRole('tab')
export const documentTabFullyShown = tab => tab.evaluate(tab => {
  const box = tab.getBoundingClientRect(), view = tab.closest('[role="tablist"]').getBoundingClientRect()
  return box.left >= view.left - 1 && box.right <= view.right + 1 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1
})
/** The visible portion of a tab clipped at the right edge, for pointer selection without Playwright scrolling it first. */
export const partiallyVisibleDocumentTab = group => editorGroupTabs(group).evaluateAll(tabs => {
  const view = tabs[0].closest('[role="tablist"]').getBoundingClientRect()
  const tab = tabs.find(tab => { const box = tab.getBoundingClientRect(); return box.left < view.right - 24 && box.right > view.right + 24 })
  if (!tab) return undefined
  const box = tab.getBoundingClientRect()
  return { name: tab.getAttribute('aria-label'), x: view.right - 12, y: box.y + box.height / 2 }
})
export const newQueryInGroupButton = group => group.getByRole('button', { name: 'New query in this group', exact: true })
/** A visible empty part of a tab strip, excluding tabs and their shelf controls. */
export const emptyQueryStripPoint = group => group.getByRole('tablist', { name: 'Query documents', exact: true }).evaluate(strip => {
  const box = strip.getBoundingClientRect(), y = box.top + Math.min(12, box.height / 2)
  for (let x = box.right - 8; x > box.left + 8; x -= 12) {
    const hit = strip.ownerDocument.elementFromPoint(x, y)
    if (hit && strip.contains(hit) && !hit.closest('.dv-tab, button, input, [role="group"]')) return { x, y }
  }
  return null
})
/** One editor group's independent pinned or unpinned shelf and its row count. */
export const tabShelf = (scope, pinned = false) => scope.locator(`[data-shelf-controls="${pinned ? 'pinned' : 'unpinned'}"]`)
export const tabShelfRows = (scope, pinned = false) => tabShelf(scope, pinned).getAttribute('data-rows')
export const tabStackFeedback = scope => scope.getByRole('status', { name: 'Tab stack height', exact: true })
/** The visible native tab strip viewport, including its vertical scroll offset for stacks taller than the group. */
export const tabStackScrollTop = scope => documentTabs(scope).evaluate(strip => parseFloat(strip.style.getPropertyValue('--tab-stack-scroll-top')) || 0)
export const floatingEditorGroups = page => page.locator(part.floatingEditorGroup)
/** A document's tab with its Close button: the target of the tab's menu. */
export const documentTabSlots = page => documentTabs(page).locator('[data-tab-id]')
/** The tab (Dockview's tab element, which has the role, name, selection and focus) around a slot. */
export const slotTab = slot => slot.locator('xpath=ancestor::*[@role="tab"][1]')
/** Every open document's tab, in any group. */
export const openDocuments = documentTabSlots
export const openDocument = documentTab
/** Selects a document through its tab or its shelf's overflow list when the tab is outside the shown rows. */
export const selectOpenDocument = async (page, name) => {
  const tab = documentTab(page, name)
  // A close or resize can promote the tab after its overflow flag is read, disabling the old opener. Retry the whole
  // choice with short ordinary clicks, so Playwright re-reads the shelf instead of waiting on a now-obsolete button.
  await expect(async () => {
    if (await tab.getAttribute('data-tab-overflow') !== null) {
      const section = await tab.getAttribute('data-tab-shelf') === 'pinned' ? 'pinned' : 'query'
      const strip = tab.locator('xpath=ancestor::*[@role="tablist"][1]')
      const overflow = strip.getByRole('button', { name: new RegExp(`^Show \\d+ more ${section} tabs?$`) })
      const choice = strip.getByRole('group', { name: `More ${section} tabs`, exact: true }).getByRole('button', named(name))
      if (!await choice.isVisible()) await overflow.click({ timeout: 2000 })
      await choice.click({ timeout: 2000 })
    } else {
      if (!await documentTabFullyShown(tab)) await tab.evaluate(tab => tab.focus({ preventScroll: true }))
      await tab.click({ timeout: 2000 })
    }
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 2000 })
  }).toPass({ timeout: 15000, intervals: [100, 250, 500] })
}
export const pinDocumentButton = (page, name, pinned = false) => documentTabs(page).getByRole('button', { name: `${pinned ? 'Unpin' : 'Pin'} ${name}`, exact: true })
/** Rename Tab's text box, in the tab being renamed. */
export const tabNameBox = page => documentTabs(page).getByRole('textbox', { name: 'Tab name', exact: true })
export const closeDocumentButton = (page, name) => documentTabs(page).getByRole('button', { name: 'Close ' + name, exact: true })
/** The marks a document tab draws after its name. */
export const unsavedMark = scope => scope.getByRole('img', { name: 'Unsaved changes', exact: true })
export const readOnlyMark = scope => scope.getByRole('img', { name: 'Read-only', exact: true })
export const executingMark = scope => scope.getByRole('img', { name: 'Executing', exact: true })
/** A tab's kind icon, drawn before its name and named by the kind: Transact-SQL, XML document, JSON document, Execution plan or Table Designer. */
export const kindIcon = (tab, kind) => tab.getByRole('img', { name: kind, exact: true })
export const editorTextbox = page => page.locator('.monaco-editor [role="textbox"]')
export const editorText = page => page.locator('.monaco-editor .view-lines').innerText()
/** A real Monaco editor view, excluding the detached hosts that carry its overflow widgets. */
export const editorSurface = scope => scope.locator('.monaco-editor[role="code"]')
export const editorOverflowHosts = scope => scope.locator('.editor-overflow-widgets')
export const editorHover = (scope, contents) => scope.locator('.monaco-hover').filter({ hasText: contents })
/** Rendered Monaco marker spans, including the SVG underline paint applied by Monaco's theme. */
export const editorDiagnosticMarks = (scope, severity = 'error') => editorSurface(scope).locator(severity === 'warning' ? '.squiggly-warning' : '.squiggly-error')
export const sqlQueryIssues = page => page.getByRole('status', { name: 'SQL query issues', exact: true })
export const suggestionWidget = scope => scope.locator('[widgetid="editor.widget.suggestWidget"]:visible')
export const suggestionItems = scope => scope.getByRole('listbox', { name: 'Suggest', exact: true }).getByRole(process.platform === 'win32' ? 'listitem' : 'option')
/** Monaco uses listitem on Windows and option elsewhere for its Suggest entries. */
export const suggestionOption = (scope, label) => {
  const name = new RegExp('^' + label.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&') + '(?:,|$)')
  return scope.getByRole('listbox', { name: 'Suggest', exact: true }).getByRole(process.platform === 'win32' ? 'listitem' : 'option', { name })
}
/** The text of the active editor group's editor, where several groups each show a query. */
export const activeGroupEditorText = page => page.locator(part.activeEditorGroup).locator('.monaco-editor .view-lines').innerText()
/** The lines Monaco draws in the editor inside `scope`: a Peek card's or Peek tab's read-only definition editor. */
export const editorTextIn = scope => scope.locator('.monaco-editor .view-lines').innerText()
/** The active group's query editor text, where a Peek tab in the same group has a Monaco editor of its own. */
export const queryEditorText = page => page.locator(part.activeEditorGroup).locator('.editor-host .monaco-editor .view-lines').innerText()
/** Peek's definition editor (Monaco, read-only) inside a Peek card or tab, by its text's accessible name. */
export const peekDefinitionText = scope => scope.getByRole('textbox', { name: /^Definition text/ })
/** The body-level hosts of Peek editors' hover and message widgets in a window (createQueryEditor's widget host). */
export const peekEditorWidgetHosts = page => page.locator('.editor-overflow-widgets[data-peek-editor]')

// Panes: the dock's panels, each with a tab in its group's header

const paneTitles = { explorer: 'Object Explorer', editor: 'Query editor', results: 'Results', messages: 'Messages', plan: 'Execution plan', statistics: 'Client Statistics' }
/** The panel menu's names for the panels, in its Tab with items. */
const paneMenuTitles = { explorer: 'Object Explorer', editor: 'Query Editor', results: 'Results', messages: 'Messages', plan: 'Execution Plan' }
/** The output panels, which share one group by default, its toolbar tabbing between them. */
export const outputPaneIds = ['results', 'messages', 'plan']
const paneMoves = { left: 'Dock Left', right: 'Dock Right', top: 'Dock Top', bottom: 'Dock Bottom', float: 'Float', dock: 'Dock', close: 'Close', window: 'Move into New Window', main: 'Move Back into Main Window' }
export const pane = (page, id) => page.locator(`[data-pane="${id}"]`)
export const paneTab = (page, id) => page.locator(`[data-pane-tab="${id}"]`)
/** The close button on a panel's dock tab, which shows only while the tab does (a group of several panels, a floating one, or Window › Panel Tabs). */
export const closePaneButton = (page, id) => page.getByRole('button', { name: 'Close ' + paneTitles[id], exact: true })
/** The ⋯ button in a panel's own header, which opens the panel's menu. */
export const paneMenuButton = (page, id) => page.getByRole('button', { name: paneTitles[id] + ' panel menu', exact: true })
/** Moves a pane through its ⋯ menu: left, right, top, bottom, float, dock, close, or tab:<pane>. */
export const movePane = async (page, id, where) => {
  await paneMenuButton(page, id).click()
  const name = where.startsWith('tab:') ? 'Tab with ' + paneMenuTitles[where.slice(4)] : paneMoves[where]
  if (!name) throw new Error('No panel move ' + where)
  await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click()
}

// Popout windows: a popout's page holds its panels' tabs, the button that docks them all back, and the panels themselves.
/** A popout window's tabs: the panels it holds. */
export const popoutTabs = page => page.getByRole('tablist', { name: /^Panels in this window: / })
/** A panel's tab in a popout window, which drags back onto the main window. */
export const popoutTab = (page, id) => popoutTabs(page).locator(`[data-popout-tab="${id}"]`)
export const popoutDockButton = page => page.getByRole('button', { name: 'Move back into main window', exact: true })

// Query output

// Dockview names its active group's region after the panel too, so a panel's own region is its section.
/** The output panels showing (Results, Messages, Execution plan): in the default layout, the one their group shows. */
export const outputPane = page => page.locator(part.outputPanel).filter({ visible: true })
/** One output panel, shown or not: results, messages or plan. */
export const outputPanel = (page, id) => page.locator(`${part.outputPanel}[data-output-panel="${id}"]`)
/** The tabs of the output panels showing, each panel's toolbar listing the output panels of its group. */
export const outputViews = page => page.getByRole('tablist', { name: 'Query output views', exact: true })
export const outputView = (page, name) => outputViews(page).getByRole('tab', named(name))
/** The output's own live region, outside the dock, which announces how a run, a copy or a save ended. */
export const outputAnnouncer = page => page.locator(part.outputAnnouncer)
/** The strip above the output: the Results and Messages tabs, the status line and the copy and save strips. */
export const outputToolbar = page => outputPane(page).locator(part.outputToolbar)
/** The tools above a run's grids (White space, and the result tools that follow). */
export const resultsToolbar = page => page.getByRole('toolbar', { name: 'Results tools', exact: true })
/** The results search box's visible count, and its live region, which says only the settled count. */
export const resultsSearchCount = page => resultsToolbar(page).locator(part.resultsSearchCount)
export const resultsSearchAnnouncer = page => resultsToolbar(page).getByRole('status')
export const outputStatus = page => outputPane(page).locator(part.outputStatus)
/** The column profile panel beside a run's grids, and one column's card in it. */
export const columnProfile = page => page.getByRole('complementary', { name: 'Column profile', exact: true })
export const profileCard = (page, column) => columnProfile(page).getByRole('region', { name: column, exact: true })
/** The pivot panel beside the grids (PivotPanel): its source, row groups, column group and values, then Build Pivot. */
export const pivotPanel = page => page.getByRole('complementary', { name: 'Pivot', exact: true })
/** A profile card's figures, label to value ("NULLs" → "20 (20%)"). */
export const profileFigures = card => card.locator('dl > div').evaluateAll(items => Object.fromEntries(items.map(item => [item.querySelector('dt').textContent, item.querySelector('dd').textContent])))
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
/** A set's caption Collapse button, named by the set ("Result 2"). */
export const resultToggle = (page, index = 0) => outputPane(page).getByRole('button', { name: `Result ${index + 1}`, exact: true })
/** The Messages strip's line under the results, drawn "Messages · 2 · no errors" and named "Messages, 2 messages, no errors",
 *  a button that opens and closes it. */
export const messagesStrip = page => outputPane(page).getByRole('button', { name: /^Messages, [\d,]+ messages?, / })
/** The Execution plan view's unified graph and its accessible operator outline. */
export const planViewer = page => page.getByRole('region', { name: 'Execution plan viewer', exact: true })
export const planCanvas = page => planViewer(page).getByRole('region', { name: 'Query plan canvas', exact: true })
export const resultSplitters = page => page.getByRole('separator', { name: /^Resize Result \d+$/ })

// Live grids (LiveGridPane): a grid its owner names, in a frame with the overlay, the error strip and the new-rows button.

/** A live grid's own grid by the name its owner gives it, which its label starts with ("Processes, 12 rows, 9 columns"),
 *  for page code. */
export const liveGridSelector = name => `[role="grid"]:is([aria-label="${name}"], [aria-label^="${name}, "])`
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const liveGrid = (page, name) => page.getByRole('grid', { name: new RegExp(`^${escaped(name)}(?:, |$)`) })
export const liveGridFrame = (page, name) => page.locator(part.liveGrid).filter({ has: liveGrid(page, name) })
/** What the frame says over the rows once they are gone (stopped, lost). */
export const liveGridOverlay = frame => frame.locator(gridPart.overlay)
/** The error strip under the rows: a failed copy, rows that could not be drawn or loaded. */
export const liveGridStrip = frame => frame.locator(gridPart.strip)
/** The "n new rows · Jump to latest" button of a log scrolled up from its tail. */
export const liveGridNewRows = frame => frame.getByRole('button', { name: /new rows? · Jump to latest$/ })

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
/** A row's live status chips, in order; each one's text is its whole label ("RESTORING 42 %", "2 Agent jobs running"). */
export const statusChips = row => row.locator(`${part.explorerChips} ${part.statusPill}`)
/** The server rows marked as the active query's server (at most one). */
export const activeServerRows = page => serverRows(page).filter({ has: page.locator(part.explorerActive) })
export const explorerSearchBox = page => page.getByRole('textbox', { name: 'Search in Object Explorer', exact: true })
export const explorerSearchField = page => page.locator(part.explorerSearchField)
/** Object Explorer's search hits, the options of its results list. */
export const explorerSearchHits = page => page.locator(part.explorerSearch).getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')
/** The hit Enter in the box revealed last. */
export const explorerSearchCurrent = page => page.locator(part.explorerSearch).getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option', { selected: true })
/** The Search Objects tab's box, its hits (the options of its results list), and the selected hit. */
export const objectSearchBox = page => page.locator(part.objectSearchTab).getByRole('textbox', { name: 'Search objects', exact: true })
/** The Search Objects tab's server picker (shown with several servers): a server, or All servers. */
export const objectSearchServer = page => page.locator(part.objectSearchTab).getByRole('combobox', { name: 'Server', exact: true })
/** The server picker's options while it is open (its listbox, named Server too): each named by its server, environment and results. */
export const objectSearchServerOptions = page => page.locator(part.objectSearchTab).getByRole('listbox', { name: 'Server', exact: true }).getByRole('option')
/** An All servers search's hits on one server: a list of their own, named by the server. */
export const objectSearchGroup = (page, server) => page.locator(part.objectSearchTab).getByRole('listbox', { name: `Results on ${server}`, exact: true })
export const objectSearchHits = page => page.locator(part.objectSearchTab).getByRole('listbox', { name: 'Results', exact: true }).getByRole('option')
export const objectSearchSelected = page => page.locator(part.objectSearchTab).getByRole('listbox', { name: 'Results', exact: true }).getByRole('option', { selected: true })
export const explorerSearchSplitter = page => page.locator(part.explorerSearch).getByRole('separator', { name: 'Resize search results', exact: true })
export const explorerSearchToggle = (page, name) => page.locator(part.explorerSearch).getByRole('button', { name, exact: true })
export const explorerSearchOptions = page => page.locator(part.explorerSearch).getByRole('button', { name: /^Search options/ })
export const explorerSearchTypes = page => page.locator(part.explorerSearch).getByRole('button', { name: /^Object types:/ })
export const explorerSearchPopover = (page, name) => page.locator(part.explorerSearch).getByRole('dialog', { name, exact: true })
export const explorerSearchCheck = (page, name) => page.locator(part.explorerSearch).getByRole('checkbox', { name, exact: true })
/** A hit's name marked as an approximate (Fuzzy Match) match. */
export const searchHitApproximate = hit => hit.locator('mark[data-approximate]')
export const explorerSearchTypeSummary = page => page.locator(part.explorerSearch).locator('.object-search-chosen-types')
export const explorerFooter = page => page.locator(part.explorerFooter)
export const explorerFreshness = page => explorerFooter(page).locator(part.explorerFreshness)
export const explorerFreshnessScope = page => explorerFooter(page).locator(part.explorerFreshnessScope)
export const explorerServerCount = page => explorerFooter(page).locator(part.explorerServers)
export const staleBadge = scope => scope.locator(part.staleBadge)
/** The inline Rename box (F2) in a row. */
export const renameBox = page => explorerTree(page).getByRole('textbox', { name: /^Rename / })

// Dialogs

/** The Connect dialog's Error details expander under a failed connect, or under the database note (Load databases). */
export const connectErrorDetails = dialog => dialog.locator(`${part.connectFailure} > details`)
export const databaseErrorDetails = dialog => dialog.locator('[role="status"] + details')
/** The Connect dialog's failure box, and its sentence and note (the note is read with the sentence and lines up with it). */
export const connectFailure = dialog => dialog.locator(part.connectFailure)
export const connectFailureSentence = dialog => connectFailure(dialog).locator(part.inlineErrorMessage)
export const connectFailureNote = dialog => connectFailure(dialog).locator(part.inlineErrorNote)
/** The outcome line of the Connect failure's Copy details. */
export const connectFailureCopyStatus = dialog => connectFailure(dialog).locator(part.inlineErrorStatus)
/** What shows at Connect while it works or after it: busy, notices and the failure. */
export const connectOutcome = dialog => dialog.locator(part.connectOutcome)
/** An object dialog's Connection and Progress boxes (Delete Object, Database Properties). */
export const objectDialogConnection = dialog => dialog.getByRole('region', { name: 'Connection', exact: true })
export const objectDialogProgress = dialog => dialog.getByRole('region', { name: 'Progress', exact: true }).getByRole('status')
export const objectDialogWarnings = dialog => dialog.getByRole('list', { name: 'Warnings', exact: true }).getByRole('listitem')
/** Delete Object's list of the database users mapped to a login (D4c): one item per user, then "…and n more". */
export const objectDialogMappedUsers = dialog => dialog.getByRole('list', { name: 'Database users mapped to this login', exact: true }).getByRole('listitem')
/** The icons of Delete Object's warnings, named by kind: Error (why OK is greyed), Warning (what fails the DROP) and Note. */
export const objectDialogWarningIcons = dialog => dialog.getByRole('list', { name: 'Warnings', exact: true }).getByRole('img')
/** An object dialog's Steps panel: one item per step, its state words first ("Done: "). */
export const objectDialogStepItems = dialog => dialog.getByRole('list', { name: 'Steps', exact: true }).getByRole('listitem')
/** Delete Object's grid of the sessions using a database (D3d): its body rows, and the disclosure that shows it. */
export const objectDialogSessions = dialog => dialog.getByRole('table', { name: 'Sessions using the database', exact: true }).locator('tbody').getByRole('row')
export const objectDialogSessionsToggle = dialog => dialog.getByRole('button', { name: /^Sessions using / })
/** An object dialog's page tabs, where the dialog is narrow ("Select a page" is then a tablist), and the page it shows. */
export const objectDialogTabs = dialog => dialog.getByRole('tablist', { name: 'Select a page', exact: true }).getByRole('tab')
export const objectDialogPage = dialog => dialog.locator(part.objectDialogPage)
/** A masked password input by its label (New Login's Password and Confirm password): password inputs have no textbox role. */
export const passwordField = (scope, label) => scope.locator('input[type="password"]').and(scope.getByLabel(label, { exact: true }))
/**
 * For layout checks: puts a Steps panel of `count` done steps, marked up as StepsPanel draws one, above the dialog's page
 * (no modal dialog has steps yet), and returns a function that removes it. Remove it before the dialog renders again.
 */
export async function addObjectDialogSteps(dialog, count) {
  await dialog.evaluate((form, [steps, selectors]) => {
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node }
    const section = element('section', selectors.steps)
    section.dataset.smokeSteps = ''
    section.setAttribute('aria-labelledby', 'smoke-steps-caption')
    const caption = section.appendChild(element('div', selectors.caption, 'Steps'))
    caption.id = 'smoke-steps-caption'
    const list = section.appendChild(element('ol', selectors.list))
    for (let index = 0; index < steps; index++) list.appendChild(element('li')).appendChild(element('span', selectors.text, `Step ${index + 1} of a long run`))
    form.querySelector(selectors.main).insertBefore(section, form.querySelector(selectors.page))
  }, [count, Object.fromEntries(Object.entries({ main: part.objectDialogMain, page: part.objectDialogPage, steps: part.objectDialogSteps, caption: part.objectDialogCaption, list: part.stepList, text: part.stepListText })
    .map(([key, selector]) => [key, key === 'main' || key === 'page' ? selector : selector.slice(1)]))])
  return () => dialog.evaluate(form => form.querySelector('[data-smoke-steps]')?.remove())
}
/**
 * Whether an Attach Databases path cell shows its whole file name: its box is as wide as its text is laid out (scrollWidth
 * rounds, and a box a fraction of a pixel narrower already draws an ellipsis) and inside the cell's content box.
 */
export const attachFileNameShown = cell => cell.evaluate((td, selector) => {
  const name = td.querySelector(selector)
  if (!name) return false
  const range = document.createRange()
  range.selectNodeContents(name)
  const text = range.getBoundingClientRect().width, own = name.getBoundingClientRect(), box = td.getBoundingClientRect()
  return own.width > 0 && own.width >= text - 0.01 && own.right <= box.right - parseFloat(getComputedStyle(td).paddingRight) + 0.01
}, part.attachPathName)
/** Whether a text input shows the end of its value (an Attach Databases path's file name) rather than its start. */
export const inputShowsEnd = input => input.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)
/** The Options dialog's page heading (Query Execution › SQL Server › General), notes, form and description pane. */
export const optionsHeading = dialog => dialog.getByRole('heading', { level: 3 })
export const optionsNotes = dialog => dialog.locator(part.optionsNote)
export const optionsForm = dialog => dialog.locator(part.optionsForm)
export const optionsDescription = dialog => dialog.locator(part.optionsDescription)
/** Options › Environment › Shortcuts: the table of commands' shortcuts, a command's first row, its inspector, and the page's sheets. */
export const shortcutsTable = dialog => dialog.getByRole('grid', { name: 'Shortcuts', exact: true })
/** A command's first row in the table, by its title. */
export const shortcutsRow = (dialog, title) => shortcutsTable(dialog).getByRole('row').filter({ has: dialog.page().getByText(title, { exact: true }) }).first()
export const shortcutsSearch = dialog => dialog.getByRole('searchbox', { name: 'Search shortcuts', exact: true })
export const shortcutsInspector = (dialog, title) => dialog.getByRole('region', { name: `Shortcuts for ${title}`, exact: true })
/** A sheet over the page (Reset All, Import, a conflict): a dialog, or an alert dialog when it refuses. */
export const shortcutsSheet = (dialog, title) => dialog.getByRole('dialog', { name: title, exact: true }).or(dialog.getByRole('alertdialog', { name: title, exact: true }))
/** Saved connections in the Connect dialog's history, by the text they show. */
export const savedConnections = (dialog, text) => dialog.locator(part.connectionChoice, { hasText: text })
/** A connection's environment tag (its pill) in a place: explorer, tab, query or status. */
export const environmentPill = (scope, place) => scope.locator(`${part.environmentTag}[data-place="${place}"] ${part.statusPill}`)

// Toasts

/** The toast stack (a region named Notifications) and its toasts, each a group named by its severity. */
export const toastStack = page => page.getByRole('region', { name: 'Notifications', exact: true })
export const toasts = page => toastStack(page).getByRole('group')
export const toastMessage = toast => toast.locator(part.toastMessage)
/** The live region that reads toasts politely (info and warning), or at once (errors) with `assertive`. */
export const toastAnnouncer = (page, assertive = false) => page.locator(`${part.toastLayer} > [role="${assertive ? 'alert' : 'status'}"]`)

// Document frames (src/renderer/src/kit/DocumentFrame.tsx): Activity Monitor, SSIS documents, properties as documents

/** A document's frame, a region named by its title. */
export const documentFrame = (page, title) => page.getByRole('region', named(title))
/** The header row, for its height (it has no role of its own inside the frame's region). */
export const documentHeader = frame => frame.locator(part.documentHeader)
export const documentCrumbs = frame => frame.getByRole('navigation', { name: 'Location', exact: true }).getByRole('listitem')
/** The header's age of what it shows (a StaleBadge), beside its state pill (documentState). */
export const documentStaleBadge = frame => documentHeader(frame).locator(part.staleBadge)
/** The fact line's values, in order. */
export const documentFactValues = frame => frame.locator(part.documentFacts).locator('dd')
export const sectionList = frame => frame.getByRole('navigation', { name: 'Sections', exact: true })
/** A section's item in the list by the section's id (its name says when the section needs attention). */
export const sectionItem = (frame, id) => sectionList(frame).locator(`[data-section="${id}"]`)
export const currentSectionItem = frame => sectionList(frame).locator('[aria-current="location"]')
/** The one item the list's tab stop is on. */
export const sectionTabStop = frame => sectionList(frame).locator('[tabindex="0"]')
/** The scrolling column of sections, a tab stop named after the document. */
export const sectionColumn = (frame, title) => frame.getByRole('region', named(title + ' sections'))
/** A section in the column, a group named by its heading (not a landmark). */
export const frameSection = (frame, title) => frame.getByRole('group', named(title))
/** A collapsible section's heading button. */
export const sectionToggle = section => section.getByRole('heading', { level: 2 }).getByRole('button')
export const scriptDrawer = frame => frame.getByRole('region', { name: 'Script', exact: true })
export const scriptToggle = frame => scriptDrawer(frame).getByRole('button', { name: 'Script', exact: true })
export const scriptSplitter = frame => frame.getByRole('separator', { name: 'Resize Script', exact: true })
/** The drawer's ways out (Open in Query Window, Save Script As…, Copy), by name, or all of them. */
export const scriptActions = (frame, name) => scriptDrawer(frame).getByRole('group', { name: 'Script', exact: true }).getByRole('button', name === undefined ? {} : named(name))
export const scriptNotice = frame => scriptDrawer(frame).getByRole('status')
export const scriptText = frame => scriptDrawer(frame).getByRole('textbox', { name: 'Script text', exact: true })
/** Muted words after the title ("Database Properties"). */
export const documentSubtitle = frame => documentHeader(frame).locator(part.documentSubtitle)
/** The header's state pill ("Normal", "Restoring, Standby", Loading, Not found). */
export const documentState = frame => documentHeader(frame).locator(part.statusPill)
/** What the document says between its header and content: its last action's outcome, a failure with its actions, or a note. */
export const documentBanner = frame => frame.locator(part.documentBanner)
/** A verb in the header, whose group is named "<title> actions". */
export const documentVerb = (frame, title, name) => frame.getByRole('group', named(title + ' actions')).getByRole('button', named(name))
/** A property sheet's row (label, control, notes), by its control's label. */
export const propertyRow = (frame, label) => frame.locator(part.propertyField).filter({ has: frame.page().getByLabel(label, { exact: true }) })
const exactly = text => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
/** A read-only fact's value, by its label. */
export const propertyFact = (frame, label) => frame.locator(part.propertyFact).filter({ has: frame.page().getByRole('term').filter({ hasText: exactly(label) }) }).getByRole('definition')
/** The strip under a property sheet's sections that shows the hovered or focused row's whole description. */
export const fieldHint = frame => frame.locator(part.fieldHint)
/** A live document's label of what its view is doing, in its header (kit/LivePill.tsx). */
export const livePill = scope => scope.locator(part.livePill)
/** A document's title, its one level 1 heading. */
export const documentTitle = frame => frame.getByRole('heading', { level: 1 })
/** The header's controls and verbs, a group named after the document's title. */
export const documentActions = (frame, title) => frame.getByRole('group', named(title + ' actions'))
export const documentContent = frame => frame.locator(part.documentContent)
/** An Activity Monitor's banner, and its error glyph. */
export const activityBanner = frame => frame.locator(part.activityBanner)
export const bannerGlyph = banner => banner.locator(':scope > .codicon')
export const tileCaptions = frame => frame.locator(part.tileCaption)

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

// Live charts (src/renderer/src/live/LiveChart.tsx), inside the box a suite mounted one in.
export const chartTooltip = box => box.locator(part.chartTooltip)
/** The legend, named after the chart's title: shown only for two or more series. */
export const chartLegend = box => box.getByRole('list', { name: / series$/ })
export const chartSwatchLines = box => box.locator(part.chartSwatch).locator('line')
/** View as table's scroll box, a region named after the chart's title. */
export const chartTableRegion = box => box.getByRole('region', { name: / table$/ })
