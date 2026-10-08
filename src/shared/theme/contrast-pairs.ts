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
const strip: ColorKey[] = ['documentTabs.background'], statusBar: ColorKey[] = ['statusBar.background']
const dockTabs = (tab: ColorKey): ColorKey[] => ['editorGroupHeader.tabsBackground', tab]
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
  ...text(['menubar.selectionForeground'], ['titleBar.activeBackground', 'menubar.selectionBackground']),
  // Monaco's context menu highlights with the list hover colors and keeps menu.foreground on them.
  ...text(['menu.foreground'], ['menu.background'], ['menu.background', 'list.hoverBackground']),
  ...text(['menu.selectionForeground'], ['menu.background', 'menu.selectionBackground']),
  ...text(['input.foreground', 'input.placeholderForeground'], input),
  ...text(['badge.foreground', 'errorForeground'], ['panelTitle.background', 'badge.background']),
  ...text(['inputValidation.errorForeground'], ['editorWidget.background', 'inputValidation.errorBackground']),
  ...text(['banner.errorForeground'], ['editor.background', 'banner.errorBackground']),
  ...text(['banner.warningForeground'], ['editor.background', 'banner.warningBackground']),
  ...text(['statusBar.foreground'], statusBar),
  ...text(['statusBar.executingForeground'], ['statusBar.executingBackground']),
  ...text(['statusBar.disconnectedForeground'], ['statusBar.disconnectedBackground']),
  ...text(['statusBar.errorForeground'], ['statusBar.errorBackground']),
  ...text(['tab.activeForeground'], dockTabs('tab.activeBackground')),
  ...text(['tab.inactiveForeground'], dockTabs('tab.inactiveBackground')),
  ...text(['tab.unfocusedActiveForeground'], dockTabs('tab.unfocusedActiveBackground')),
  ...text(['tab.unfocusedInactiveForeground'], dockTabs('tab.unfocusedInactiveBackground')),
  ...text(['list.activeSelectionForeground', 'dialog.descriptionForeground'], activeSelection),
  ...text(['list.inactiveSelectionForeground'], inactiveSelection),
  ...text(['list.highlightForeground'], widget, sideBar),
  ...text(['quickInput.foreground'], ['quickInput.background']),
  ...text(['quickInputList.focusForeground'], ['quickInput.background', 'quickInputList.focusBackground']),
  ...text(['resultsGrid.foreground'], ['resultsGrid.background'], ['resultsGrid.background', 'resultsGrid.alternateRowBackground']),
  ...text(['resultsGrid.selectionForeground'], ['resultsGrid.background', 'resultsGrid.selectionBackground']),
  ...text(['editorWidget.foreground', 'dialog.descriptionForeground', 'dialog.labelForeground', 'settings.headerForeground', 'infoForeground', 'pickerGroup.foreground'], widget),
  ...text(['notifications.foreground'], ['notifications.background']),
  ...text(['keybindingLabel.foreground'], toolbar, hover),
  ...text(['toolbar.labelForeground', 'titleBar.controlsForeground', 'successForeground'], toolbar),
  ...text(['descriptionForeground'], sideBar, widget, panelTitle, editor),
  ...text(['sideBarTitle.foreground', 'objectExplorer.headingForeground', 'objectExplorer.countForeground', 'errorForeground'], sideBar),
  ...text(['objectExplorer.countForeground'], sideBarHover),
  ...text(['documentTabs.activeForeground'], ['documentTabs.background', 'documentTabs.activeBackground']),
  ...text(['documentTabs.inactiveForeground'], strip),
  ...text(['documentTabs.iconForeground'], strip, ['documentTabs.background', 'documentTabs.activeBackground']),
  ...text(['breadcrumb.foreground', 'breadcrumb.separatorForeground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'emptyState.foreground'], editor),
  ...text(['editor.foreground'], editor, ['editor.background', 'editor.lineHighlightBackground']),
  ...text(['emptyState.foreground', 'emptyState.titleForeground'], panel),
  ...text(['panelTitle.activeForeground', 'panelTitle.inactiveForeground'], panelTitle),
  ...text(['panelTitle.activeForeground'], widget),
  ...text(['resultsGrid.headerForeground', 'resultsGrid.headerDescriptionForeground'], ['resultsGrid.headerBackground']),
  ...text(['resultsGrid.rowNumberForeground', 'resultsGrid.nullForeground'], panel, striped),
  ...text(['resultsGrid.truncationForeground', 'resultsMessages.foreground', 'textPreformat.foreground', 'warningForeground'], panel),
  ...text([...sqlScopes.map(scope => `syntax:${scope}` as const), ...brackets], editor, ['editor.background', 'editor.lineHighlightBackground']),

  ...graphic(['focusBorder'], editor, sideBar, panel, toolbar, widget, hover, activeSelection, inactiveSelection, strip, input, ...dockTabBackgrounds.map(dockTabs)),
  ...graphic(['icon.foreground', 'objectExplorer.chevronForeground', 'objectExplorer.folderIconForeground', 'objectExplorer.objectIconForeground', 'objectExplorer.actionForeground'], sideBar),
  ...graphic(['icon.foreground', 'objectExplorer.chevronForeground', 'objectExplorer.folderIconForeground', 'objectExplorer.objectIconForeground'], sideBarHover),
  ...graphic(['titleBar.iconForeground'], titleBar),
  ...graphic(['connection.red', 'connection.orange', 'connection.yellow', 'connection.green', 'connection.blue', 'connection.purple'], sideBar, strip, editor, statusBar, widget),
  ...graphic(['connection.default'], widget, activeSelection),
  ...graphic(['connection.favoriteForeground'], widget),
  ...graphic(['tab.activeBorderTop', 'documentTabs.modifiedIndicator', 'documentTabs.closeForeground'], strip),
  ...graphic(['panelTitle.activeBorder'], panelTitle, widget),
  ...graphic(['statusBar.onlineIndicator', 'statusBar.idleIndicator'], statusBar),
  ...graphic(['button.background'], widget),
  ...graphic(['notificationsErrorIcon.foreground', 'notificationsWarningIcon.foreground', 'notificationsInfoIcon.foreground'], ['notifications.background']),
  ...graphic(['dock.guideForeground'], ['dock.guideBackground'], ['dock.guideActiveBackground'])
]

/**
 * Hover fills carry no information (WCAG asks nothing of them) but must still be noticeable on every surface they
 * appear on; 1.2:1 is what the Dockview hover gave Varia Dark before themes. Text on a hovered button is gated above.
 */
export const hoverPairs: readonly ContrastPair[] = [
  ...pairs(1.2, ['toolbar.hoverBackground'], ['editorGroupHeader.tabsBackground'], ...dockTabBackgrounds.map(dockTabs)),
  ...pairs(1.2, ['button.secondaryHoverBackground'], toolbar, titleBar, panelTitle, ['editorGroupHeader.tabsBackground'], strip, sideBar)
]

/** Reported, not enforced: the Dark control borders are below 3:1 until the owner decides on a heavier look. */
export const advisoryPairs: readonly ContrastPair[] = graphic(['input.border', 'button.border'], input, widget)

/** Foreground keys that are deliberately not checked, with the reason. */
export const contrastExemptions: Readonly<Partial<Record<ColorKey, string>>> = {
  'statusBar.separatorForeground': 'Decorative divider between status items; the items carry the meaning.',
  'emptyState.iconForeground': 'Decorative glyph beside text that says the same thing.',
  'disabledForeground': 'Disabled controls are exempt from WCAG 1.4.3 and 1.4.11.'
}
