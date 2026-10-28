import { sqlScopes, type ColorKey, type SqlScope } from './registry'

/**
 * A foreground drawn on a stack of backgrounds (bottom first). Translucent layers are composited over the layer below;
 * a translucent bottom layer over `editor.background`.
 */
export interface ContrastPair { foreground: ColorKey | `syntax:${SqlScope}`; background: readonly ColorKey[]; minimum: number }

const editor: ColorKey[] = ['editor.background'], sideBar: ColorKey[] = ['sideBar.background'], panel: ColorKey[] = ['panel.background']
const widget: ColorKey[] = ['editorWidget.background'], toolbar: ColorKey[] = ['toolbar.background'], input: ColorKey[] = ['input.background']
const striped: ColorKey[] = ['panel.background', 'resultsGrid.alternateRowBackground']
const hover: ColorKey[] = ['toolbar.background', 'button.secondaryHoverBackground'], sideBarHover: ColorKey[] = ['sideBar.background', 'button.secondaryHoverBackground']
const activeSelection: ColorKey[] = ['editorWidget.background', 'list.activeSelectionBackground']
const inactiveSelection: ColorKey[] = ['sideBar.background', 'list.inactiveSelectionBackground']
const panelTitle: ColorKey[] = ['panelTitle.background'], titleBar: ColorKey[] = ['titleBar.activeBackground']
const quickInput: ColorKey[] = ['quickInput.background'], quickInputActive: ColorKey[] = ['quickInput.background', 'quickInputList.focusBackground']
const quickInputHover: ColorKey[] = ['quickInput.background', 'list.hoverBackground']
const treeActive: ColorKey[] = ['sideBar.background', 'list.activeSelectionBackground'], treeInactive: ColorKey[] = ['sideBar.background', 'list.inactiveSelectionBackground']
const treeHover: ColorKey[] = ['sideBar.background', 'list.hoverBackground'], treeServer: ColorKey[] = ['sideBar.background', 'objectExplorer.activeConnectionBackground']
const strip: ColorKey[] = ['documentTabs.background'], statusBar: ColorKey[] = ['statusBar.background']
const statusBarStates: ColorKey[][] = [['statusBar.executingBackground'], ['statusBar.disconnectedBackground'], ['statusBar.errorBackground']]
const statusBars: ColorKey[][] = [statusBar, ...statusBarStates, ['queryStatusBar.background'], ['queryStatusBar.executingBackground'], ['queryStatusBar.errorBackground']]
const dockTabs = (tab: ColorKey): ColorKey[] => ['editorGroupHeader.tabsBackground', tab]
/** A secondary button's hover fill over the surface it sits on. */
const hovered = (...surface: ColorKey[]): ColorKey[] => [...surface, 'button.secondaryHoverBackground']
const dock: ColorKey[] = ['dock.background'], grid: ColorKey[] = ['resultsGrid.background']
const widgetInactiveSelection: ColorKey[] = ['editorWidget.background', 'list.inactiveSelectionBackground']
const suggestFocus: ColorKey[] = ['editorWidget.background', 'quickInputList.focusBackground']
const headerHover: ColorKey[] = ['resultsGrid.headerBackground', 'resultsGrid.hoverBackground']
const dockTabBackgrounds: ColorKey[] = ['tab.activeBackground', 'tab.inactiveBackground', 'tab.unfocusedActiveBackground', 'tab.unfocusedInactiveBackground']
/** Monaco paints every matched bracket in these by depth, over the delimiter and identifier.quote scopes. */
const brackets: ColorKey[] = ['editorBracketHighlight.foreground1', 'editorBracketHighlight.foreground2', 'editorBracketHighlight.foreground3', 'editorBracketHighlight.foreground4',
  'editorBracketHighlight.foreground5', 'editorBracketHighlight.foreground6', 'editorBracketHighlight.unexpectedBracket.foreground']
const pairs = (minimum: number, foregrounds: ContrastPair['foreground'][], ...backgrounds: ColorKey[][]): ContrastPair[] =>
  foregrounds.flatMap(foreground => backgrounds.map(background => ({ foreground, background, minimum })))
const text = (foregrounds: ContrastPair['foreground'][], ...backgrounds: ColorKey[][]) => pairs(4.5, foregrounds, ...backgrounds)
const graphic = (foregrounds: ContrastPair['foreground'][], ...backgrounds: ColorKey[][]) => pairs(3, foregrounds, ...backgrounds)

/** WCAG 2.x AA pairs every built-in theme must pass: 4.5:1 for text, 3:1 for focus rings, glyphs, and indicators. */
export const contrastPairs: readonly ContrastPair[] = [
  ...text(['foreground'], editor, sideBar, panel, widget, striped),
  ...text(['button.secondaryForeground'], toolbar, widget, sideBar, panel, editor, inactiveSelection),
  ...text(['button.secondaryHoverForeground'], hover),
  ...text(['button.foreground'], ['editorWidget.background', 'button.background'], ['editorWidget.background', 'button.hoverBackground']),
  ...text(['titleBar.activeForeground'], titleBar),
  ...text(['titleBar.inactiveForeground'], ['titleBar.inactiveBackground']),
  ...text(['sideBarTitle.foreground'], sideBar),
  ...text(['commandCenter.foreground'], ['titleBar.activeBackground', 'commandCenter.background'], ['titleBar.activeBackground', 'commandCenter.activeBackground']),
  ...text(['menubar.selectionForeground'], ['titleBar.activeBackground', 'menubar.selectionBackground']),
  ...text(['menu.foreground'], ['menu.background']),
  ...text(['menu.selectionForeground'], ['menu.background', 'menu.selectionBackground']),
  // Keybinding labels in menus; the highlighted item shows them in menu.selectionForeground.
  ...text(['descriptionForeground'], ['menu.background']),
  ...text(['input.foreground', 'input.placeholderForeground'], input),
  ...text(['badge.foreground', 'errorForeground'], ['panelTitle.background', 'badge.background']),
  ...text(['inputValidation.errorForeground'], ['editorWidget.background', 'inputValidation.errorBackground']),
  ...text(['banner.errorForeground'], ['editor.background', 'banner.errorBackground']),
  ...text(['banner.warningForeground'], ['editor.background', 'banner.warningBackground']),
  ...text(['statusBar.foreground'], statusBar),
  ...text(['statusBar.executingForeground'], ['statusBar.executingBackground']),
  ...text(['statusBar.disconnectedForeground'], ['statusBar.disconnectedBackground']),
  ...text(['statusBar.errorForeground'], ['statusBar.errorBackground']),
  ...text(['queryStatusBar.foreground'], ['queryStatusBar.background']),
  ...text(['queryStatusBar.executingForeground'], ['queryStatusBar.executingBackground']),
  ...text(['queryStatusBar.errorForeground'], ['queryStatusBar.errorBackground']),
  ...text(['tab.activeForeground'], dockTabs('tab.activeBackground')),
  ...text(['tab.inactiveForeground'], dockTabs('tab.inactiveBackground')),
  ...text(['tab.unfocusedActiveForeground'], dockTabs('tab.unfocusedActiveBackground')),
  ...text(['tab.unfocusedInactiveForeground'], dockTabs('tab.unfocusedInactiveBackground')),
  ...text(['list.activeSelectionForeground', 'dialog.descriptionForeground'], activeSelection),
  ...text(['list.inactiveSelectionForeground'], inactiveSelection),
  ...text(['list.highlightForeground'], widget, sideBar),
  ...text(['quickInput.foreground'], quickInput),
  ...text(['quickInputList.focusForeground'], quickInputActive),
  // On the active row these parts take quickInputList.focusForeground (styles.css), as in VS Code: $textMuted and $accent
  // fall below 4.5:1 on the focused row's fill.
  ...text(['list.highlightForeground', 'descriptionForeground', 'keybindingLabel.foreground', 'pickerGroup.foreground'], quickInput),
  // A hovered row keeps its muted parts; its matches and group label take quickInput.foreground (styles.css).
  ...text(['quickInput.foreground', 'descriptionForeground', 'keybindingLabel.foreground'], quickInputHover),
  ...text(['banner.warningForeground'], ['quickInput.background', 'banner.warningBackground']),
  ...text(['banner.errorForeground'], ['quickInput.background', 'banner.errorBackground']),
  ...text(['resultsGrid.foreground'], ['resultsGrid.background'], ['resultsGrid.background', 'resultsGrid.alternateRowBackground']),
  ...text(['resultsGrid.selectionForeground'], ['resultsGrid.background', 'resultsGrid.selectionBackground']),
  // Selected cells keep their text color while the grid is not focused (links, read errors and the truncation marker
  // too); NULL takes the grid's foreground there (styles.css), as its tint is too faint on that fill.
  ...text(['foreground', 'resultsGrid.foreground', 'resultsGrid.linkForeground', 'errorForeground', 'resultsGrid.truncationForeground'],
    ['panel.background', 'resultsGrid.inactiveSelectionBackground'], [...striped, 'resultsGrid.inactiveSelectionBackground']),
  ...text(['errorForeground'], ['resultsGrid.background'], ['resultsGrid.background', 'resultsGrid.alternateRowBackground']),
  ...text(['editorWidget.foreground', 'dialog.descriptionForeground', 'dialog.labelForeground', 'settings.headerForeground', 'infoForeground', 'pickerGroup.foreground'], widget),
  ...text(['notifications.foreground'], ['notifications.background']),
  ...text(['keybindingLabel.foreground'], toolbar, hover),
  ...text(['toolbar.labelForeground', 'titleBar.controlsForeground', 'successForeground'], toolbar),
  ...text(['descriptionForeground'], sideBar, widget, panelTitle, editor),
  // The failure screen's heading.
  ...text(['errorForeground'], editor),
  ...text(['sideBarTitle.foreground', 'objectExplorer.headingForeground', 'objectExplorer.countForeground', 'errorForeground'], sideBar),
  ...text(['objectExplorer.countForeground'], sideBarHover),
  // Object Explorer rows: labels and sublabels on hover, on the active query's server, and selected (labels then take
  // the selection's foreground; sublabels keep theirs).
  ...text(['foreground', 'objectExplorer.headingForeground', 'objectExplorer.countForeground', 'objectExplorer.sublabelForeground'], treeHover, treeServer),
  ...text(['objectExplorer.sublabelForeground'], sideBar, treeActive, treeInactive),
  ...text(['list.activeSelectionForeground'], treeActive),
  ...text(['list.inactiveSelectionForeground'], treeInactive),
  ...text(['documentTabs.activeForeground'], ['documentTabs.background', 'documentTabs.activeBackground']),
  ...text(['documentTabs.inactiveForeground'], strip),
  ...text(['documentTabs.iconForeground'], strip, ['documentTabs.background', 'documentTabs.activeBackground']),
  ...text(['breadcrumb.foreground', 'breadcrumb.separatorForeground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'emptyState.foreground'], editor),
  ...text(['editor.foreground'], editor, ['editor.background', 'editor.lineHighlightBackground']),
  ...text(['emptyState.foreground', 'emptyState.titleForeground'], panel),
  ...text(['panelTitle.activeForeground', 'panelTitle.inactiveForeground'], panelTitle),
  ...text(['panelTitle.activeForeground'], widget),
  ...text(['resultsGrid.headerForeground', 'resultsGrid.headerDescriptionForeground', 'resultsGrid.rowNumberForeground'], ['resultsGrid.headerBackground']),
  ...text(['resultsGrid.headerSelectionForeground'], ['resultsGrid.headerBackground', 'resultsGrid.headerSelectionBackground']),
  ...text(['resultsGrid.rowNumberForeground', 'resultsGrid.nullForeground'], panel, striped),
  // NULL cells are tinted, over the grid and over a striped row.
  ...text(['resultsGrid.nullForeground'], [...panel, 'resultsGrid.nullBackground'], [...striped, 'resultsGrid.nullBackground']),
  ...text(['resultsGrid.linkForeground'], ['resultsGrid.background'], ['resultsGrid.background', 'resultsGrid.alternateRowBackground']),
  ...text(['resultsGrid.truncationForeground', 'resultsMessages.foreground', 'textPreformat.foreground', 'warningForeground'], panel),
  ...text([...sqlScopes.map(scope => `syntax:${scope}` as const), ...brackets], editor, ['editor.background', 'editor.lineHighlightBackground']),
  // The readability audit: the remaining text each surface draws (styles.css and Monaco's widgets).
  // Title-bar menu labels at rest; a hovered button's text on every surface buttons sit on, banners and the status bar's
  // Script As buttons included.
  ...text(['button.secondaryForeground'], titleBar),
  ...text(['button.secondaryHoverForeground'], hovered(...widget), hovered(...sideBar), hovered(...panel), hovered(...panelTitle), hovered(...editor), hovered(...dock),
    hovered('editor.background', 'banner.errorBackground'), hovered('editor.background', 'banner.warningBackground'), hovered(...statusBar), hovered('statusBar.executingBackground'),
    hovered('statusBar.disconnectedBackground'), hovered('statusBar.errorBackground'), hovered(...activeSelection)),
  // A saved connection's row keeps its button text when selected; the dock's Move list sits on the tab strip.
  ...text(['button.secondaryForeground'], activeSelection),
  ...text(['input.foreground'], ['editorGroupHeader.tabsBackground']),
  // The query context bar, the empty workspace and the closed-panels note are drawn on the dock group.
  ...text(['breadcrumb.foreground', 'breadcrumb.separatorForeground', 'emptyState.foreground', 'button.secondaryForeground'], dock),
  // The Output title bar's Cancel; errors in Messages and the results strip; the grid's truncation marker and lost overlay.
  ...text(['foreground'], panelTitle),
  ...text(['errorForeground'], panel),
  ...text(['resultsGrid.truncationForeground', 'emptyState.foreground'], grid),
  // The results head's selected view, and the facts in set captions, the Messages strip and the Execution plan list.
  ...text(['panelTitle.activeForeground'], ['panelTitle.background', 'list.inactiveSelectionBackground']),
  ...text(['descriptionForeground', 'warningForeground', 'successForeground'], panel, panelTitle),
  // The results head's icon for a run that failed, timed out or was lost.
  ...text(['errorForeground'], panelTitle),
  // Hovered column and row headers.
  ...text(['resultsGrid.headerForeground', 'resultsGrid.headerDescriptionForeground', 'resultsGrid.rowNumberForeground'], headerHover),
  // Dialogs: the Filter dialog's problems, the layout notice, and Tools › Options' selected page and focused row.
  ...text(['inputValidation.errorForeground', 'successForeground'], widget),
  ...text(['list.inactiveSelectionForeground', 'editorWidget.foreground'], widgetInactiveSelection),
  // Monaco's widgets: suggestions (editor text; the focused row and its matches) and the find widget's No results.
  ...text(['editor.foreground', 'errorForeground'], widget),
  ...text(['quickInputList.focusForeground', 'list.focusHighlightForeground'], suggestFocus),

  // On the active quick input row it is the edge that marks the row.
  ...graphic(['focusBorder'], editor, sideBar, panel, toolbar, widget, hover, activeSelection, inactiveSelection, strip, input, quickInputActive, ...dockTabBackgrounds.map(dockTabs)),
  ...graphic(['icon.foreground', 'objectExplorer.chevronForeground', 'objectExplorer.folderIconForeground', 'objectExplorer.objectIconForeground', 'objectExplorer.actionForeground'], sideBar),
  ...graphic(['icon.foreground', 'objectExplorer.chevronForeground', 'objectExplorer.folderIconForeground', 'objectExplorer.objectIconForeground'], sideBarHover),
  ...graphic(['objectExplorer.chevronForeground', 'objectExplorer.folderIconForeground', 'objectExplorer.objectIconForeground'], treeHover, treeServer),
  ...graphic(['list.focusOutline'], sideBar, treeActive),
  ...graphic(['titleBar.iconForeground'], titleBar),
  // A connection's edge stays on both status bars, and the backend's dot on the main one, in every state.
  ...graphic(['connection.red', 'connection.orange', 'connection.yellow', 'connection.green', 'connection.blue', 'connection.purple'], sideBar, strip, editor, widget, ...statusBars),
  ...graphic(['connection.default'], widget, activeSelection),
  ...graphic(['connection.favoriteForeground'], widget),
  ...graphic(['tab.activeBorderTop', 'documentTabs.modifiedIndicator', 'documentTabs.closeForeground'], strip),
  ...graphic(['panelTitle.activeBorder'], panelTitle, widget),
  ...graphic(['resultsGrid.activeCellBorder'], panel, ['resultsGrid.background', 'resultsGrid.selectionBackground']),
  ...graphic(['resultsGrid.truncationForeground', 'resultsGrid.splitterBackground'], panel),
  ...graphic(['statusBar.onlineIndicator', 'statusBar.idleIndicator'], statusBar, ...statusBarStates),
  // A bookmark is the only sign of itself in the indicator margin.
  ...graphic(['editorBookmark.foreground'], editor),
  ...graphic(['button.background'], widget),
  // Control outlines (WCAG 1.4.11) on every surface the controls sit on: fields and dialogs; the toolbar's server and
  // database lists; Cancel on the Output toolbar; Object Explorer's buttons; the results grid's Retry; the empty
  // workspace's buttons; and the failure screen's details (panel) and Copy details (editor).
  ...graphic(['input.border'], input, widget, toolbar, panel),
  ...graphic(['button.border'], input, widget, panelTitle, sideBar, panel, editor),
  ...graphic(['notificationsErrorIcon.foreground', 'notificationsWarningIcon.foreground', 'notificationsInfoIcon.foreground'], ['notifications.background']),
  ...graphic(['dock.guideForeground'], ['dock.guideBackground'], ['dock.guideActiveBackground'])
]

/**
 * Hover fills carry no information (WCAG asks nothing of them) but must still be noticeable on every surface they
 * appear on; 1.2:1 is what the Dockview hover gave Varia Dark before themes. Text on a hovered button is gated above.
 */
export const hoverPairs: readonly ContrastPair[] = [
  ...pairs(1.2, ['toolbar.hoverBackground'], ['editorGroupHeader.tabsBackground'], ...dockTabBackgrounds.map(dockTabs)),
  ...pairs(1.2, ['button.secondaryHoverBackground'], toolbar, titleBar, panelTitle, ['editorGroupHeader.tabsBackground'], strip, sideBar),
  // The highlighted menu item follows the pointer and the keyboard alike.
  ...pairs(1.2, ['menu.selectionBackground'], ['menu.background']),
  // The search box stands out from the title bar by its outline, and shows the pointer by a fill that changes from its own.
  ...pairs(1.2, ['commandCenter.border'], titleBar),
  ...pairs(1.2, ['commandCenter.activeBackground'], titleBar, ['titleBar.activeBackground', 'commandCenter.background'])
]

/** Foreground keys that are deliberately not checked, with the reason. */
export const contrastExemptions: Readonly<Partial<Record<ColorKey, string>>> = {
  'statusBar.separatorForeground': 'Decorative divider between status items; the items carry the meaning.',
  'emptyState.iconForeground': 'Decorative glyph beside text that says the same thing.',
  'editorWhitespace.foreground': 'Decorative glyph beside the text: View White Space marks spaces and tabs the text already has.',
  'disabledForeground': 'Disabled controls are exempt from WCAG 1.4.3 and 1.4.11.'
}
