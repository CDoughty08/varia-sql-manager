/** Where a key is applied: workbench CSS, Monaco, the native window (main process), or renderer code. */
export type ColorConsumer = 'css' | 'monaco' | 'native' | 'script'
/** `$slot`, `$slot/pct`, `@key`, or a literal (docking compass only); a `{dark, light}` pair when the types differ. */
export type ColorDefault = string | { readonly dark: string; readonly light: string }
export interface ColorKeyInfo {
  readonly default: ColorDefault
  readonly description: string
  /** `vscode` keys mean the same as the VS Code key of that name. */
  readonly origin: 'vscode' | 'varia'
  readonly group: string
  readonly consumers: readonly ColorConsumer[]
  /** Defined, resolved and contrast-checked now; applied by the named feature later. */
  readonly reserved?: string
  /** Composited to opaque #rrggbb over this key, or over black (Dark) / white (Light) when `base`. */
  readonly opaqueOver?: string
}

type Entry = readonly [origin: 'V' | 'X', fallback: ColorDefault, description: string, consumers: string, extra?: { reserved?: string; opaqueOver?: string }]
const pair = (dark: string, light: string) => ({ dark, light })
const menus = 'custom menus and the title bar', tree = 'the Object Explorer tree', grid = 'the results grid', toasts = 'notifications'
const searchable = 'the command palette and the Object Explorer tree'

const groups = {
  'Base': {
    'foreground': ['V', '$text', 'Default text color of the workbench.', 'css'],
    'descriptionForeground': ['V', '$textMuted', 'Secondary text: hints, captions, and explanations.', 'css'],
    'disabledForeground': ['V', '$textMuted', 'Text of disabled controls, such as unavailable commands in the command palette.', 'css monaco'],
    'errorForeground': ['V', '$error', 'Error text.', 'css monaco'],
    'warningForeground': ['X', '$warning', 'Warning text.', ''],
    'successForeground': ['X', '$success', 'Success text, such as the Execute button and confirmations.', 'css'],
    'infoForeground': ['X', '$info', 'Information text.', '', { reserved: toasts }],
    'focusBorder': ['V', '$focus', 'Focus ring around the focused control.', 'css monaco'],
    'icon.foreground': ['V', '$icon', 'Default glyph color.', 'css monaco'],
    'widget.shadow': ['V', '$shadow', 'Shadow of dialogs, floating dock groups, and editor widgets.', 'css monaco'],
    'widget.border': ['V', '@editorWidget.border', 'Border of floating dock groups and widgets.', 'css monaco'],
    'textPreformat.foreground': ['V', '$textSecondary', 'Preformatted text such as execution plan XML.', 'css monaco'],
    'sash.hoverBorder': ['V', '$focus', 'Dock splitter while it is hovered or dragged.', 'css'],
    'scrollbarSlider.background': ['V', '$textMuted/40', 'Scrollbar thumb.', 'css monaco'],
    'scrollbarSlider.hoverBackground': ['V', '$textMuted/55', 'Scrollbar thumb when hovered.', 'monaco'],
    'scrollbarSlider.activeBackground': ['V', '$textMuted/70', 'Scrollbar thumb while it is dragged.', 'monaco']
  },
  'Title bar, menus, and toolbar': {
    'titleBar.activeBackground': ['V', '$chrome', 'Title bar, and the native window-controls overlay on Windows and Linux.', 'css native', { opaqueOver: 'editor.background' }],
    'titleBar.activeForeground': ['V', '$textTertiary', 'Window caption in the title bar.', 'css'],
    'titleBar.inactiveBackground': ['V', '@titleBar.activeBackground', 'Title bar while the window is inactive.', '', { reserved: menus }],
    'titleBar.inactiveForeground': ['V', '@titleBar.activeForeground', 'Window caption while the window is inactive.', '', { reserved: menus }],
    'titleBar.border': ['V', '$border', 'Line below the title bar.', 'css'],
    'titleBar.iconForeground': ['X', '$accentMuted', 'Application icon in the title bar.', 'css'],
    'titleBar.controlsForeground': ['X', '$text', 'Minimize, maximize, and close symbols on Windows and Linux. Replaced by black or white when it is unreadable.', 'native', { opaqueOver: 'titleBar.activeBackground' }],
    'menubar.selectionBackground': ['V', '$active', 'Open title-bar menu.', 'css'],
    'menubar.selectionForeground': ['V', '$textStrong', 'Label of the open title-bar menu.', 'css'],
    'menu.background': ['V', '$overlay', 'Editor and dock context menus.', 'css monaco'],
    'menu.foreground': ['V', '$text', 'Context menu text.', 'css monaco'],
    'menu.selectionBackground': ['V', '$selectionStrong', 'Highlighted menu item. The editor context menu highlights with list.hoverBackground instead.', '', { reserved: menus }],
    'menu.selectionForeground': ['V', '$textStrong', 'Text of the highlighted menu item.', '', { reserved: menus }],
    'menu.separatorBackground': ['V', '$separator', 'Context menu separators.', 'monaco'],
    'menu.border': ['V', '@editorWidget.border', 'Context menu border.', 'monaco'],
    'toolbar.background': ['X', '@titleBar.activeBackground', 'Main toolbar.', 'css'],
    'toolbar.border': ['X', '@titleBar.border', 'Line below the main toolbar.', 'css'],
    'toolbar.hoverBackground': ['V', '$text/12', 'Icon actions when hovered, such as the close button of dock tabs. Translucent, so it shows on every tab color.', 'css monaco'],
    'toolbar.separatorBackground': ['X', '$separator', 'Dividers between toolbar groups.', 'css'],
    'toolbar.labelForeground': ['X', '$textTertiary', 'Labels of the toolbar server and database fields.', 'css'],
    'keybindingLabel.foreground': ['V', '$textMuted', 'Keyboard shortcut hints.', 'css monaco'],
    'keybindingLabel.border': ['V', '$separator', 'Outline of keyboard shortcut hints.', 'css monaco']
  },
  'Buttons and inputs': {
    'button.background': ['V', '$accent', 'Primary button; also the checkbox accent.', 'css monaco'],
    'button.foreground': ['V', '$onAccent', 'Primary button text.', 'css monaco'],
    'button.hoverBackground': ['V', '$accentHover', 'Primary button when hovered.', 'css monaco'],
    'button.border': ['V', '$controlBorder', 'Outline of secondary buttons.', 'css monaco'],
    'button.secondaryForeground': ['V', '$textSecondary', 'Text of secondary and toolbar buttons.', 'css monaco'],
    'button.secondaryHoverBackground': ['V', '$hover', 'Secondary and toolbar buttons when hovered.', 'css monaco'],
    'button.secondaryHoverForeground': ['X', '$textStrong', 'Secondary button text when hovered.', 'css'],
    'input.background': ['V', '$input', 'Inputs and selects.', 'css monaco'],
    'input.foreground': ['V', '$text', 'Input and select text.', 'css monaco'],
    'input.border': ['V', '$inputBorder', 'Input and select border.', 'css monaco'],
    'input.placeholderForeground': ['V', '$textMuted', 'Placeholder text.', 'css monaco'],
    'inputValidation.errorBackground': ['V', '$errorSurface', 'Connection error message.', 'css monaco'],
    'inputValidation.errorForeground': ['V', '$errorSurfaceText', 'Connection error message text.', 'css monaco']
  },
  'Side bar, lists, and Object Explorer': {
    'sideBar.background': ['V', '$sideBar', 'Object Explorer.', 'css'],
    'sideBarTitle.foreground': ['V', '$textTertiary', 'Object Explorer heading.', 'css'],
    'sideBarSectionHeader.border': ['V', '$borderSubtle', 'Lines around the Object Explorer heading and footer.', 'css'],
    'list.hoverBackground': ['V', '$hover', 'Hovered list row (command palette rows included), and the highlighted item of the editor context menu.', 'css monaco'],
    'list.activeSelectionBackground': ['V', '$selectionStrong', 'Selected row of a focused list.', 'css monaco'],
    'list.activeSelectionForeground': ['V', '$text', 'Text of the selected row of a focused list.', 'css monaco'],
    'list.inactiveSelectionBackground': ['V', '$selection', 'Selected row of an unfocused list, and the selected result set.', 'css monaco'],
    'list.inactiveSelectionForeground': ['V', '$textAccent', 'Text of the selected row of an unfocused list.', 'css monaco'],
    'list.focusOutline': ['V', '@focusBorder', 'Outline of the focused list row.', '', { reserved: tree }],
    'list.highlightForeground': ['V', '$accent', 'Characters that match a filter, such as in the command palette.', 'css monaco'],
    'list.filterMatchBackground': ['V', '$accent/20', 'Rows that match a filter.', '', { reserved: searchable }],
    'tree.indentGuidesStroke': ['V', '$borderSubtle', 'Tree indent guides.', '', { reserved: tree }],
    'objectExplorer.activeConnectionBackground': ['X', '$accentSurface', 'Row of the selected server.', 'css'],
    'objectExplorer.headingForeground': ['X', '$textSecondary', 'Folder headings.', 'css'],
    'objectExplorer.countForeground': ['X', '$textMuted', 'Item counts next to folder headings.', 'css'],
    'objectExplorer.chevronForeground': ['X', '$iconMuted', 'Expand and collapse chevrons.', 'css'],
    'objectExplorer.folderIconForeground': ['X', '$iconFolder', 'Folder glyphs.', 'css'],
    'objectExplorer.objectIconForeground': ['X', '$accentMuted', 'Glyphs of tables and other objects.', 'css'],
    'objectExplorer.actionForeground': ['X', '$textMuted', 'Row actions such as Disconnect.', 'css']
  },
  'Dock and docking compass': {
    'editorGroupHeader.tabsBackground': ['V', '$chrome', 'Tab strip of dock groups, including floating groups.', 'css'],
    'tab.activeBackground': ['V', '$selection', 'Visible tab of the focused dock group.', 'css'],
    'tab.inactiveBackground': ['V', '@editorGroupHeader.tabsBackground', 'Hidden tabs of the focused dock group.', 'css'],
    'tab.unfocusedActiveBackground': ['V', '$raised', 'Visible tab of an unfocused dock group.', 'css'],
    'tab.unfocusedInactiveBackground': ['V', '@tab.inactiveBackground', 'Hidden tabs of an unfocused dock group.', 'css'],
    'tab.activeForeground': ['V', '$textStrong', 'Label of the visible tab of the focused dock group.', 'css'],
    'tab.inactiveForeground': ['V', '$textMuted', 'Labels of hidden tabs of the focused dock group.', 'css'],
    'tab.unfocusedActiveForeground': ['V', '$textTertiary', 'Label of the visible tab of an unfocused dock group.', 'css'],
    'tab.unfocusedInactiveForeground': ['V', '$textMuted', 'Labels of hidden tabs of an unfocused dock group.', 'css'],
    'tab.border': ['V', '$border', 'Dividers between dock tabs.', 'css'],
    'tab.activeBorderTop': ['V', '$accent', 'Top border of the active query tab.', 'css'],
    'editorGroup.border': ['V', '$borderStrong', 'Dock splitters and group separators.', 'css'],
    'editorGroup.dropBackground': ['V', '$focus/30', 'Drop target while a panel is dragged.', 'css'],
    'dock.background': ['X', '@editor.background', 'Dock groups.', 'css'],
    'dock.guideBackground': ['X', '#edf4fb', 'Docking compass cells. The compass looks the same in every theme by default.', 'css'],
    'dock.guideForeground': ['X', '#2777c7', 'Docking compass arrows.', 'css'],
    'dock.guideBorder': ['X', '#aac4de', 'Border of docking compass cells.', 'css'],
    'dock.guideShadow': ['X', '#00000088', 'Shadow of docking compass cells.', 'css'],
    'dock.guideActiveBackground': ['X', '#b9d9f7', 'Docking compass cell under the pointer.', 'css'],
    'dock.guideActiveBorder': ['X', '#247adb', 'Border of the docking compass cell under the pointer.', 'css'],
    'dock.guideActiveRing': ['X', '#78b9ff', 'Ring around the docking compass cell under the pointer.', 'css'],
    'dock.previewBackground': ['X', '#3288d94d', 'Area a dragged panel will occupy.', 'css'],
    'dock.previewBorder': ['X', '#64b2ff', 'Border of the docking preview.', 'css'],
    'dock.previewInnerBorder': ['X', '#badfff66', 'Inner line of the docking preview.', 'css']
  },
  'Query tabs and context': {
    'documentTabs.background': ['X', '@editorGroupHeader.tabsBackground', 'Query tab strip.', 'css'],
    'documentTabs.activeBackground': ['X', '@editor.background', 'Active query tab.', 'css'],
    'documentTabs.activeForeground': ['X', '$text', 'Label of the active query tab.', 'css'],
    'documentTabs.inactiveForeground': ['X', '$textMuted', 'Labels of inactive query tabs.', 'css'],
    'documentTabs.border': ['X', '$border', 'Dividers between query tabs.', 'css'],
    'documentTabs.closeForeground': ['X', '$textMuted', 'Close buttons of query tabs.', 'css'],
    'documentTabs.iconForeground': ['X', '$warning', 'SQL badge of query tabs.', 'css'],
    'documentTabs.modifiedIndicator': ['X', '$textMuted', 'Dot that marks a query with unsaved changes.', 'css'],
    'breadcrumb.foreground': ['V', '$textMuted', 'Query context line (server and database).', 'css'],
    'breadcrumb.separatorForeground': ['X', '@breadcrumb.foreground', 'Separator in the query context line.', 'css']
  },
  'Editor, widgets, and empty states': {
    'editor.background': ['V', '$canvas', 'Editor and application background; also the native window background.', 'css monaco native', { opaqueOver: 'base' }],
    'editor.foreground': ['V', '$syntaxIdentifier', 'Default editor text.', 'monaco'],
    'editor.lineHighlightBackground': ['V', '$accent/6', 'Highlight of the current line.', 'monaco', { opaqueOver: 'editor.background' }],
    'editor.selectionBackground': ['V', '$textSelection', 'Selected text in the editor.', 'monaco'],
    'editorLineNumber.foreground': ['V', pair('$textMuted/80', '$textMuted'), 'Line numbers.', 'monaco', { opaqueOver: 'editor.background' }],
    'editorLineNumber.activeForeground': ['V', '$textSecondary', 'Line number of the current line.', 'monaco'],
    'editorBracketHighlight.foreground1': ['V', '$syntaxBracket1', 'Matched brackets at the outermost level: parentheses, braces, and square brackets, including those around identifiers. Deeper levels take the next color, cycling through all six.', 'monaco'],
    'editorBracketHighlight.foreground2': ['V', '$syntaxBracket2', 'Brackets one level in.', 'monaco'],
    'editorBracketHighlight.foreground3': ['V', '$syntaxBracket3', 'Brackets two levels in.', 'monaco'],
    'editorBracketHighlight.foreground4': ['V', '@editorBracketHighlight.foreground1', 'Brackets three levels in. The defaults repeat the first three colors; a transparent value leaves a level out of the cycle.', 'monaco'],
    'editorBracketHighlight.foreground5': ['V', '@editorBracketHighlight.foreground2', 'Brackets four levels in.', 'monaco'],
    'editorBracketHighlight.foreground6': ['V', '@editorBracketHighlight.foreground3', 'Brackets five levels in.', 'monaco'],
    'editorBracketHighlight.unexpectedBracket.foreground': ['V', '$error', 'A closing bracket without a matching opening one.', 'monaco'],
    'editorWidget.background': ['V', '$overlay', 'Dialogs and editor widgets such as find, suggest, and hover.', 'css monaco'],
    'editorWidget.foreground': ['V', '$text', 'Text of dialogs and editor widgets.', 'css monaco'],
    'editorWidget.border': ['V', pair('$controlBorder', '$borderStrong'), 'Border of dialogs and editor widgets.', 'css monaco'],
    'emptyState.foreground': ['X', '$textMuted', 'Text of empty views (no query, no results, empty dock).', 'css'],
    'emptyState.titleForeground': ['X', '$textTertiary', 'Heading of empty views.', 'css'],
    'emptyState.iconForeground': ['X', '$iconMuted/60', 'Decorative glyph of empty views.', 'css']
  },
  'Output panel and results grid': {
    'panel.background': ['V', '$panel', 'Output panel.', 'css'],
    'panel.border': ['V', '$border', 'Lines inside the output panel.', 'css'],
    'panelTitle.background': ['X', '$chrome', 'Output panel tab bar.', 'css'],
    'panelTitle.activeForeground': ['V', '$textAccent', 'Active output tab, and the selected tab of the connection dialog.', 'css'],
    'panelTitle.inactiveForeground': ['V', '$textMuted', 'Inactive output tabs.', 'css'],
    'panelTitle.activeBorder': ['V', '$accent', 'Underline of the active output tab.', 'css'],
    'badge.background': ['V', '$active', 'Count badges on output tabs.', 'css'],
    'badge.foreground': ['V', '$textSecondary', 'Count badge text.', 'css'],
    'resultsGrid.background': ['X', '@panel.background', 'Results grid.', '', { reserved: grid }],
    'resultsGrid.foreground': ['X', '@foreground', 'Results grid cells.', '', { reserved: grid }],
    'resultsGrid.headerBackground': ['X', '$raised', 'Column headers.', 'css'],
    'resultsGrid.headerForeground': ['X', '$textSecondary', 'Column names.', 'css'],
    'resultsGrid.headerDescriptionForeground': ['X', '$textMuted', 'Column data types below the names.', 'css'],
    'resultsGrid.gridlines': ['X', '$borderSubtle', 'Cell borders.', 'css'],
    'resultsGrid.alternateRowBackground': ['X', '$text/3', 'Tint of every other row.', 'css'],
    'resultsGrid.rowNumberForeground': ['X', '$textMuted', 'Row numbers.', 'css'],
    'resultsGrid.nullForeground': ['X', pair('$warning/70', '$warning'), 'NULL values.', 'css'],
    'resultsGrid.truncationForeground': ['X', '@warningForeground', 'Notice that results were truncated.', 'css'],
    'resultsGrid.selectionBackground': ['X', '@list.activeSelectionBackground', 'Selected cells.', '', { reserved: grid }],
    'resultsGrid.selectionForeground': ['X', '@list.activeSelectionForeground', 'Text of selected cells.', '', { reserved: grid }],
    'resultsGrid.inactiveSelectionBackground': ['X', '@list.inactiveSelectionBackground', 'Selected cells while the grid is not focused.', '', { reserved: grid }],
    'resultsGrid.activeCellBorder': ['X', '@focusBorder', 'Outline of the active cell.', '', { reserved: grid }],
    'resultsGrid.hoverBackground': ['X', '@list.hoverBackground', 'Hovered row.', '', { reserved: grid }],
    'resultsMessages.foreground': ['X', pair('$accentMuted', '$text'), 'Text of the Messages tab.', 'css']
  },
  'Status bar': {
    'statusBar.background': ['V', '$accentSurface', 'Status bar when connected and idle.', 'css'],
    'statusBar.foreground': ['V', '$accentMuted', 'Status bar text when connected and idle.', 'css'],
    'statusBar.separatorForeground': ['X', '$textMuted', 'Dividers between status bar items.', 'css'],
    'statusBar.onlineIndicator': ['X', '$success', 'Dot shown while connected.', 'css'],
    'statusBar.idleIndicator': ['X', '$textMuted', 'Dot shown while not connected.', 'css'],
    'statusBar.executingBackground': ['X', '@statusBar.background', 'Status bar while a query runs.', 'css'],
    'statusBar.executingForeground': ['X', '@statusBar.foreground', 'Status bar text while a query runs.', 'css'],
    'statusBar.disconnectedBackground': ['X', '@statusBar.background', 'Status bar without a connection.', 'css'],
    'statusBar.disconnectedForeground': ['X', '@statusBar.foreground', 'Status bar text without a connection.', 'css'],
    'statusBar.errorBackground': ['X', '$errorSurface', 'Status bar when the backend is unavailable.', 'css'],
    'statusBar.errorForeground': ['X', '$errorSurfaceText', 'Status bar text when the backend is unavailable.', 'css']
  },
  'Banners, dialogs, notifications, and quick input': {
    'banner.errorBackground': ['X', '$errorSurface', 'Error banner.', 'css'],
    'banner.errorForeground': ['X', '$errorSurfaceText', 'Error banner text.', 'css'],
    'banner.warningBackground': ['X', '$warningSurface', 'Warning banner, such as theme problems.', 'css'],
    'banner.warningForeground': ['X', '$warningSurfaceText', 'Warning banner text.', 'css'],
    'dialog.backdropBackground': ['X', '$backdrop', 'Scrim behind modal dialogs.', 'css'],
    'dialog.separatorBackground': ['X', '$separator', 'Separators inside dialogs.', 'css'],
    'dialog.labelForeground': ['X', '$textSecondary', 'Field labels in dialogs.', 'css'],
    'dialog.descriptionForeground': ['X', '$textTertiary', 'Secondary text in dialogs.', 'css'],
    'settings.headerForeground': ['V', '$accentMuted', 'Section headings in dialogs.', 'css'],
    'notifications.background': ['V', '@editorWidget.background', 'Notification toasts.', '', { reserved: toasts }],
    'notifications.foreground': ['V', '@editorWidget.foreground', 'Notification text.', '', { reserved: toasts }],
    'notifications.border': ['V', '@widget.border', 'Notification border.', '', { reserved: toasts }],
    'notificationsErrorIcon.foreground': ['V', '@errorForeground', 'Error notification icon.', '', { reserved: toasts }],
    'notificationsWarningIcon.foreground': ['V', '@warningForeground', 'Warning notification icon.', '', { reserved: toasts }],
    'notificationsInfoIcon.foreground': ['V', '@infoForeground', 'Information notification icon.', '', { reserved: toasts }],
    'quickInput.background': ['V', '@editorWidget.background', 'Command palette and pickers (quick input).', 'css'],
    'quickInput.foreground': ['V', '@editorWidget.foreground', 'Command palette text.', 'css'],
    'quickInputTitle.background': ['V', '$raised', 'Title row of pickers that have one.', 'css'],
    'quickInputList.focusBackground': ['V', '@list.activeSelectionBackground', 'Active command palette row.', 'css'],
    'quickInputList.focusForeground': ['V', '@list.activeSelectionForeground', 'Text of the active command palette row.', 'css'],
    'pickerGroup.foreground': ['V', '$accent', 'Command palette group labels, such as "recently used".', 'css'],
    'pickerGroup.border': ['V', '$separator', 'Line above each command palette group.', 'css']
  },
  'Connection colors': {
    'connection.red': ['X', '$red', 'Red connection color.', 'script'],
    'connection.orange': ['X', '$orange', 'Orange connection color.', 'script'],
    'connection.yellow': ['X', '$yellow', 'Yellow connection color.', 'script'],
    'connection.green': ['X', '$green', 'Green connection color.', 'script'],
    'connection.blue': ['X', '$blue', 'Blue connection color.', 'script'],
    'connection.purple': ['X', '$purple', 'Purple connection color.', 'script'],
    'connection.default': ['X', '$neutral', 'Swatch of connections without a color.', 'script'],
    'connection.favoriteForeground': ['X', '$yellow', 'Favorite star in the connection dialog.', 'css']
  }
} as const satisfies Record<string, Record<string, Entry>>

type Groups = typeof groups
export type ColorKey = { [G in keyof Groups]: keyof Groups[G] & string }[keyof Groups]

export const colorGroups: readonly { title: string; keys: readonly ColorKey[] }[] = Object.entries(groups).map(([title, entries]) => ({ title, keys: Object.keys(entries) as ColorKey[] }))
export const colorKeys: readonly ColorKey[] = colorGroups.flatMap(group => group.keys)
export const colorRegistry: Readonly<Record<ColorKey, ColorKeyInfo>> = Object.fromEntries(Object.entries(groups).flatMap(([group, entries]) =>
  Object.entries(entries as Record<string, Entry>).map(([key, [origin, fallback, description, consumers, extra]]): [string, ColorKeyInfo] => [key, {
    default: fallback, description, origin: origin === 'V' ? 'vscode' : 'varia', group,
    consumers: consumers ? consumers.split(' ') as ColorConsumer[] : [], ...extra
  }]))) as Record<string, ColorKeyInfo> as Record<ColorKey, ColorKeyInfo>
export const isColorKey = (key: string): key is ColorKey => Object.hasOwn(colorRegistry, key)
/** Renamed keys (old name to new); a renamed key still loads, with a warning. Empty in format 1. */
export const colorKeyAliases: ReadonlyMap<string, ColorKey> = new Map()

/** `list.activeSelectionBackground` becomes `--varia-list-activeSelectionBackground`; keys never contain `-`. */
export function cssVariable(key: ColorKey): string { return '--varia-' + key.replaceAll('.', '-') }

/** The default expression of a key for one type. */
export function defaultFor(key: ColorKey, type: 'dark' | 'light'): string {
  const value = colorRegistry[key].default
  return typeof value === 'string' ? value : value[type]
}

/** Keys ordered so every `@key` reference and opaque base comes before the keys that depend on it. */
export const colorKeyOrder: readonly ColorKey[] = (() => {
  const order: ColorKey[] = [], state = new Map<ColorKey, 'visiting' | 'done'>()
  const dependencies = (key: ColorKey): ColorKey[] => {
    const info = colorRegistry[key]
    const refs = [defaultFor(key, 'dark'), defaultFor(key, 'light'), info.opaqueOver === 'base' ? undefined : info.opaqueOver && '@' + info.opaqueOver]
    return refs.filter((ref): ref is string => !!ref?.startsWith('@')).map(ref => {
      const target = ref.slice(1)
      if (!isColorKey(target)) throw new Error(`Color key ${key} refers to unknown key ${target}.`)
      return target
    })
  }
  const visit = (key: ColorKey) => {
    if (state.get(key) === 'done') return
    if (state.get(key) === 'visiting') throw new Error('Color key references form a cycle at ' + key + '.')
    state.set(key, 'visiting')
    dependencies(key).forEach(visit)
    state.set(key, 'done')
    order.push(key)
  }
  colorKeys.forEach(visit)
  return order
})()

/** The 16 SQL scopes, matching the `*.sql` tokens of Monaco's SQL tokenizer (`white` is not themed). */
export const sqlScopes = ['keyword', 'keyword.block', 'keyword.try', 'keyword.catch', 'keyword.choice', 'operator', 'predefined', 'string', 'number',
  'comment', 'comment.quote', 'identifier', 'identifier.quote', 'delimiter', 'delimiter.parenthesis', 'delimiter.square'] as const
export type SqlScope = typeof sqlScopes[number]
export const isSqlScope = (scope: string): scope is SqlScope => (sqlScopes as readonly string[]).includes(scope)
/** `keyword.block` inherits from `keyword` unless a rule names it. */
export function parentScope(scope: SqlScope): SqlScope | undefined {
  const dot = scope.lastIndexOf('.')
  return dot < 0 ? undefined : scope.slice(0, dot) as SqlScope
}
export const scopeDescriptions: Readonly<Record<SqlScope, string>> = {
  'keyword': 'Keywords.', 'keyword.block': 'BEGIN, END, and CASE.', 'keyword.try': 'BEGIN TRY and END TRY.', 'keyword.catch': 'BEGIN CATCH and END CATCH.',
  'keyword.choice': 'WHEN and THEN.', 'operator': 'Operators, including AND, OR, LIKE, and IN.', 'predefined': 'Built-in functions, @@ variables, and $ACTION-style pseudo columns.',
  'string': 'String literals.', 'number': 'Numeric and money literals.', 'comment': 'Comments.', 'comment.quote': 'The /* and */ of block comments.',
  'identifier': 'Names of objects, columns, and variables.', 'identifier.quote': 'Double quotes around identifiers; square brackets take the bracket colors (editorBracketHighlight.*).',
  'delimiter': 'Commas, semicolons, and dots.', 'delimiter.parenthesis': 'Parentheses. The editor draws brackets in the bracket colors (editorBracketHighlight.*) instead.',
  'delimiter.square': 'Square brackets. The editor draws brackets in the bracket colors (editorBracketHighlight.*) instead.'
}
/** Built-in syntax colors of the root scopes; sub-scopes inherit. */
export const syntaxDefaults: Readonly<Partial<Record<SqlScope, string>>> = {
  keyword: '$syntaxKeyword', operator: '$syntaxOperator', predefined: '$syntaxFunction', string: '$syntaxString',
  number: '$syntaxNumber', comment: '$syntaxComment', identifier: '$syntaxIdentifier', delimiter: '$syntaxDelimiter'
}
/** TextMate scope names accepted in `tokenColors` (exact match), so VS Code-style rules carry over. */
export const scopeAliases: ReadonlyMap<string, SqlScope> = new Map<string, SqlScope>([
  ['keyword.control', 'keyword'], ['keyword.other', 'keyword'], ['storage', 'keyword'], ['storage.type', 'keyword'], ['storage.modifier', 'keyword'],
  ['keyword.operator', 'operator'],
  ['support.function', 'predefined'], ['entity.name.function', 'predefined'], ['variable.language', 'predefined'], ['support.constant', 'predefined'],
  ['string.quoted', 'string'], ['string.quoted.single', 'string'], ['string.quoted.double', 'string'],
  ['constant.numeric', 'number'],
  ['comment.line', 'comment'], ['comment.block', 'comment'], ['punctuation.definition.comment', 'comment'],
  ['variable', 'identifier'], ['variable.other', 'identifier'], ['entity.name', 'identifier'],
  ['punctuation', 'delimiter'], ['punctuation.separator', 'delimiter'], ['meta.brace', 'delimiter']
])
