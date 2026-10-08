import { describe, expect, it } from 'vitest'
import { parseThemeFile } from '../src/shared/theme/format'
import { builtinPalettes, paletteSlots, isPaletteSlot } from '../src/shared/theme/palette'
import { colorKeyOrder, colorKeys, colorRegistry, cssVariable, defaultFor, isColorKey, sqlScopes, syntaxDefaults, type ColorKey } from '../src/shared/theme/registry'
import { isResolvedTheme, resolveBuiltin, resolveTheme } from '../src/shared/theme/resolve'
import type { ParsedTheme, ThemeType } from '../src/shared/theme/types'

const types: ThemeType[] = ['dark', 'light']
function parsed(file: Record<string, unknown>, name = 'test.json'): ParsedTheme {
  const result = parseThemeFile({ kind: 'varia-color-theme', version: 1, name: 'Test', type: 'dual', ...file }, name)
  expect(result.problems.filter(problem => problem.severity === 'error')).toEqual([])
  return result.theme!
}
const resolve = (file: Record<string, unknown>, variant: ThemeType = 'dark') => resolveTheme([parsed(file)], variant)

// Spec B1-B11 "Dark" and "Light" columns, transcribed independently of the registry defaults.
const specValues = `
foreground #d9e1ec #1f2733|descriptionForeground #8a9cb3 #525e72|disabledForeground #8a9cb3 #525e72|errorForeground #f39c9f #ae2117
warningForeground #dfbd82 #8a5300|successForeground #8addac #146c38|infoForeground #8fb7ff #005fb8|focusBorder #76acff #005fb8
icon.foreground #8aa9d4 #3e6696|widget.shadow #00000099 #0000002e|widget.border #40516b #c3ccd8|textPreformat.foreground #c3cddd #2f3a49
sash.hoverBorder #76acff #005fb8|scrollbarSlider.background #8a9cb366 #525e7266|scrollbarSlider.hoverBackground #8a9cb38c #525e728c
scrollbarSlider.activeBackground #8a9cb3b3 #525e72b3|titleBar.activeBackground #181f2a #e9edf2|titleBar.activeForeground #9eafc5 #465366
titleBar.inactiveBackground #181f2a #e9edf2|titleBar.inactiveForeground #9eafc5 #465366|titleBar.border #2b3443 #d3d9e2
titleBar.iconForeground #a3bbdc #2a4f7f|titleBar.controlsForeground #d9e1ec #1f2733|menubar.selectionBackground #2e3c51 #ccd6e3
menubar.selectionForeground #ffffff #0b1220|menu.background #1a2230 #ffffff|menu.foreground #d9e1ec #1f2733|menu.selectionBackground #2e4058 #c4daf4
menu.selectionForeground #ffffff #0b1220|menu.separatorBackground #354359 #cdd4de|menu.border #40516b #c3ccd8|toolbar.background #181f2a #e9edf2
toolbar.border #2b3443 #d3d9e2|toolbar.hoverBackground #d9e1ec1f #1f27331f|toolbar.separatorBackground #354359 #cdd4de|toolbar.labelForeground #9eafc5 #465366
keybindingLabel.foreground #8a9cb3 #525e72|keybindingLabel.border #354359 #cdd4de|button.background #8fb7ff #005fb8|button.foreground #101b2d #ffffff
button.hoverBackground #accaff #004c94|button.border #40516b #8792a2|button.secondaryForeground #c3cddd #2f3a49
button.secondaryHoverBackground #263041 #d0d8e3|button.secondaryHoverForeground #ffffff #0b1220|input.background #111721 #ffffff
input.foreground #d9e1ec #1f2733|input.border #364357 #8792a2|input.placeholderForeground #8a9cb3 #525e72
inputValidation.errorBackground #48242d #fbe4e6|inputValidation.errorForeground #f3bac0 #8a1c25|sideBar.background #151b24 #f3f5f8
sideBarTitle.foreground #9eafc5 #465366|sideBarSectionHeader.border #252f3d #e3e7ed|list.hoverBackground #263041 #d0d8e3
list.activeSelectionBackground #2e4058 #c4daf4|list.activeSelectionForeground #d9e1ec #1f2733|list.inactiveSelectionBackground #24324a #d6e3f3
list.inactiveSelectionForeground #bcd4fa #0b4f99|list.focusOutline #76acff #005fb8|list.highlightForeground #8fb7ff #005fb8
list.filterMatchBackground #8fb7ff33 #005fb833|tree.indentGuidesStroke #252f3d #e3e7ed|objectExplorer.activeConnectionBackground #1d2b40 #e3ebf5
objectExplorer.headingForeground #c3cddd #2f3a49|objectExplorer.countForeground #8a9cb3 #525e72|objectExplorer.chevronForeground #7e93b1 #637189
objectExplorer.folderIconForeground #d9b370 #9a6700|objectExplorer.objectIconForeground #a3bbdc #2a4f7f|objectExplorer.actionForeground #8a9cb3 #525e72
editorGroupHeader.tabsBackground #181f2a #e9edf2|tab.activeBackground #24324a #d6e3f3|tab.inactiveBackground #181f2a #e9edf2
tab.unfocusedActiveBackground #202a39 #e1e7ee|tab.unfocusedInactiveBackground #181f2a #e9edf2|tab.activeForeground #ffffff #0b1220
tab.inactiveForeground #8a9cb3 #525e72|tab.unfocusedActiveForeground #9eafc5 #465366|tab.unfocusedInactiveForeground #8a9cb3 #525e72
tab.border #2b3443 #d3d9e2|tab.activeBorderTop #8fb7ff #005fb8|editorGroup.border #303b4c #c3ccd8|editorGroup.dropBackground #76acff4d #005fb84d
dock.background #11151c #ffffff|dock.guideBackground #edf4fb #edf4fb|dock.guideForeground #2777c7 #2777c7|dock.guideBorder #aac4de #aac4de
dock.guideShadow #00000088 #00000088|dock.guideActiveBackground #b9d9f7 #b9d9f7|dock.guideActiveBorder #247adb #247adb
dock.guideActiveRing #78b9ff #78b9ff|dock.previewBackground #3288d94d #3288d94d|dock.previewBorder #64b2ff #64b2ff
dock.previewInnerBorder #badfff66 #badfff66|documentTabs.background #181f2a #e9edf2|documentTabs.activeBackground #11151c #ffffff
documentTabs.activeForeground #d9e1ec #1f2733|documentTabs.inactiveForeground #8a9cb3 #525e72|documentTabs.border #2b3443 #d3d9e2
documentTabs.closeForeground #8a9cb3 #525e72|documentTabs.iconForeground #dfbd82 #8a5300|documentTabs.modifiedIndicator #8a9cb3 #525e72
breadcrumb.foreground #8a9cb3 #525e72|breadcrumb.separatorForeground #8a9cb3 #525e72|editor.background #11151c #ffffff
editor.foreground #d4d4d4 #1f2733|editor.lineHighlightBackground #181f29 #f0f6fb|editor.selectionBackground #264f78 #add6ff
editorLineNumber.foreground #728195 #525e72|editorLineNumber.activeForeground #c3cddd #2f3a49
editorBracketHighlight.foreground1 #ffd700 #0431fa|editorBracketHighlight.foreground2 #da70d6 #287a28|editorBracketHighlight.foreground3 #179fff #7b3814
editorBracketHighlight.foreground4 #ffd700 #0431fa|editorBracketHighlight.foreground5 #da70d6 #287a28|editorBracketHighlight.foreground6 #179fff #7b3814
editorBracketHighlight.unexpectedBracket.foreground #f39c9f #ae2117|editorWidget.background #1a2230 #ffffff
editorWidget.foreground #d9e1ec #1f2733|editorWidget.border #40516b #c3ccd8|emptyState.foreground #8a9cb3 #525e72
emptyState.titleForeground #9eafc5 #465366|emptyState.iconForeground #7e93b199 #63718999|panel.background #141a23 #fafbfc
panel.border #2b3443 #d3d9e2|panelTitle.background #181f2a #e9edf2|panelTitle.activeForeground #bcd4fa #0b4f99
panelTitle.inactiveForeground #8a9cb3 #525e72|panelTitle.activeBorder #8fb7ff #005fb8|badge.background #2e3c51 #ccd6e3
badge.foreground #c3cddd #2f3a49|resultsGrid.background #141a23 #fafbfc|resultsGrid.foreground #d9e1ec #1f2733
resultsGrid.headerBackground #202a39 #e1e7ee|resultsGrid.headerForeground #c3cddd #2f3a49|resultsGrid.headerDescriptionForeground #8a9cb3 #525e72
resultsGrid.gridlines #252f3d #e3e7ed|resultsGrid.alternateRowBackground #d9e1ec08 #1f273308|resultsGrid.rowNumberForeground #8a9cb3 #525e72
resultsGrid.nullForeground #dfbd82b3 #8a5300|resultsGrid.truncationForeground #dfbd82 #8a5300|resultsGrid.selectionBackground #2e4058 #c4daf4
resultsGrid.selectionForeground #d9e1ec #1f2733|resultsGrid.inactiveSelectionBackground #24324a #d6e3f3|resultsGrid.activeCellBorder #76acff #005fb8
resultsGrid.hoverBackground #263041 #d0d8e3|resultsMessages.foreground #a3bbdc #1f2733|statusBar.background #1d2b40 #e3ebf5
statusBar.foreground #a3bbdc #2a4f7f|statusBar.separatorForeground #8a9cb3 #525e72|statusBar.onlineIndicator #8addac #146c38
statusBar.idleIndicator #8a9cb3 #525e72|statusBar.executingBackground #1d2b40 #e3ebf5|statusBar.executingForeground #a3bbdc #2a4f7f
statusBar.disconnectedBackground #1d2b40 #e3ebf5|statusBar.disconnectedForeground #a3bbdc #2a4f7f|statusBar.errorBackground #48242d #fbe4e6
statusBar.errorForeground #f3bac0 #8a1c25|banner.errorBackground #48242d #fbe4e6|banner.errorForeground #f3bac0 #8a1c25
banner.warningBackground #3d3322 #fff3d6|banner.warningForeground #f0d49b #6b4400|dialog.backdropBackground #080c14bf #1f273366
dialog.separatorBackground #354359 #cdd4de|dialog.labelForeground #c3cddd #2f3a49|dialog.descriptionForeground #9eafc5 #465366
settings.headerForeground #a3bbdc #2a4f7f|notifications.background #1a2230 #ffffff|notifications.foreground #d9e1ec #1f2733
notifications.border #40516b #c3ccd8|notificationsErrorIcon.foreground #f39c9f #ae2117|notificationsWarningIcon.foreground #dfbd82 #8a5300
notificationsInfoIcon.foreground #8fb7ff #005fb8|quickInput.background #1a2230 #ffffff|quickInput.foreground #d9e1ec #1f2733
quickInputTitle.background #202a39 #e1e7ee|quickInputList.focusBackground #2e4058 #c4daf4|quickInputList.focusForeground #d9e1ec #1f2733
pickerGroup.foreground #8fb7ff #005fb8|pickerGroup.border #354359 #cdd4de|connection.red #e66b73 #c42b3c|connection.orange #e6a15c #b45309
connection.yellow #dec766 #8f6b00|connection.green #79bb8b #2e7d4f|connection.blue #71a7df #2563a8|connection.purple #ad8bd8 #7a4bbf
connection.default #8b9bb0 #6b7789|connection.favoriteForeground #dec766 #8f6b00`
const specSyntax = { keyword: ['#569cd6', '#0000ff'], operator: ['#778899', '#5e6875'], predefined: ['#ff00ff', '#b000b0'], string: ['#ff4040', '#c41a16'],
  number: ['#b5cea8', '#097a50'], comment: ['#6a9955', '#008000'], identifier: ['#d4d4d4', '#1f2733'], delimiter: ['#dcdcdc', '#1f2733'] }

describe('built-in themes', () => {
  it('reproduce every value of the spec tables', () => {
    const rows = specValues.trim().split(/[|\n]/).map(row => row.split(' '))
    expect(rows.map(([key]) => key)).toEqual(colorKeys)
    for (const [key, darkValue, lightValue] of rows) {
      expect(resolveBuiltin('dark').colors[key as ColorKey], key).toBe(darkValue)
      expect(resolveBuiltin('light').colors[key as ColorKey], key).toBe(lightValue)
    }
    for (const scope of sqlScopes) {
      const [darkValue, lightValue] = specSyntax[scope.split('.')[0] as keyof typeof specSyntax]
      expect(resolveBuiltin('dark').syntax[scope]).toEqual({ foreground: darkValue, fontStyle: '' })
      expect(resolveBuiltin('light').syntax[scope]).toEqual({ foreground: lightValue, fontStyle: '' })
    }
  })
  it('resolve with zero problems and match the committed snapshots', async () => {
    for (const type of types) {
      const result = resolveTheme([], type)
      expect(result.problems).toEqual([])
      expect(result.theme).toEqual(resolveBuiltin(type))
      expect(result.theme).toMatchObject({ id: 'varia-' + type, name: type === 'dark' ? 'Varia Dark' : 'Varia Light', type })
      await expect(JSON.stringify(result.theme, null, 2) + '\n').toMatchFileSnapshot(`fixtures/themes/varia-${type}.resolved.json`)
    }
  })
  it('have 61 slots, 188 keys and 16 scopes, with an acyclic and complete reference graph', () => {
    expect(paletteSlots).toHaveLength(61)
    expect(colorKeys).toHaveLength(188)
    expect(new Set(colorKeys).size).toBe(188)
    expect(sqlScopes).toHaveLength(16)
    expect([...colorKeyOrder].sort()).toEqual([...colorKeys].sort())
    for (const key of colorKeys) {
      for (const type of types) {
        const value = defaultFor(key, type)
        if (value.startsWith('@')) {
          expect(isColorKey(value.slice(1)), `${key} -> ${value}`).toBe(true)
          expect(colorKeyOrder.indexOf(value.slice(1) as ColorKey)).toBeLessThan(colorKeyOrder.indexOf(key))
        } else if (value.startsWith('$')) expect(isPaletteSlot(value.slice(1).split('/')[0]), `${key} -> ${value}`).toBe(true)
        else expect(value, `${key}: only the docking compass uses literals`).toMatch(/^#/)
        if (!value.startsWith('$') && !value.startsWith('@')) expect(key.startsWith('dock.guide') || key.startsWith('dock.preview')).toBe(true)
      }
      expect(key.includes('-'), key).toBe(false)
      expect(cssVariable(key)).toBe('--varia-' + key.split('.').join('-'))
    }
    expect(new Set(colorKeys.map(cssVariable)).size).toBe(188)
    for (const value of Object.values(syntaxDefaults)) expect(isPaletteSlot(value!.slice(1))).toBe(true)
    for (const type of types) for (const slot of paletteSlots) {
      const value = builtinPalettes[type][slot]
      expect(slot === 'info' ? value === '$accent' : /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value), `${type} ${slot}`).toBe(true)
    }
  })
})

describe('theme resolution', () => {
  it('lets a palette override spread to every key that refers to the slot', () => {
    const { theme, problems } = resolve({ type: 'dark', palette: { accent: '#ffb000', accentHover: '#ffc54d', focus: '$accent' } })
    expect(problems).toEqual([])
    expect(theme.colors['button.background']).toBe('#ffb000')
    expect(theme.colors['button.hoverBackground']).toBe('#ffc54d')
    expect(theme.colors['focusBorder']).toBe('#ffb000')
    expect(theme.colors['panelTitle.activeBorder']).toBe('#ffb000')
    expect(theme.colors['infoForeground']).toBe('#ffb000')
    expect(theme.colors['notificationsInfoIcon.foreground']).toBe('#ffb000')
    expect(theme.colors['list.filterMatchBackground']).toBe('#ffb00033')
    expect(theme.colors['editor.lineHighlightBackground']).toBe('#1f1e1a')
    expect(theme.colors['editorGroup.dropBackground']).toBe('#ffb0004d')
  })
  it('puts the user key ahead of the default, and a broken key falls back to the default', () => {
    const { theme, problems } = resolve({ palette: { deepSea: '#0b3d4a' }, colors: { 'statusBar.background': '$deepSea', 'focusBorder': '$nope', 'menu.border': '$deepSea/50' } })
    expect(theme.colors['statusBar.background']).toBe('#0b3d4a')
    expect(theme.colors['statusBar.executingBackground']).toBe('#0b3d4a')
    expect(theme.colors['focusBorder']).toBe('#76acff')
    expect(theme.colors['menu.border']).toBe('#0b3d4a80')
    expect(problems).toEqual([expect.objectContaining({ code: 'W_REF_UNKNOWN', file: 'test.json', path: '/colors/focusBorder', severity: 'warning' })])
  })
  it('projects dual values per variant, and partial variants inherit', () => {
    const theme = parsed({ palette: { canvas: { dark: '#0f1419', light: '#fbfcfd' }, accent: { light: '#0f766e' } }, colors: { 'editorLineNumber.foreground': { dark: '#7b8794' }, 'list.inactiveSelectionBackground': '$accent/20' } })
    const dark = resolveTheme([theme], 'dark'), light = resolveTheme([theme], 'light')
    expect([dark.problems, light.problems]).toEqual([[], []])
    expect([dark.theme.colors['editor.background'], light.theme.colors['editor.background']]).toEqual(['#0f1419', '#fbfcfd'])
    expect([dark.theme.colors['button.background'], light.theme.colors['button.background']]).toEqual(['#8fb7ff', '#0f766e'])
    expect([dark.theme.colors['editorLineNumber.foreground'], light.theme.colors['editorLineNumber.foreground']]).toEqual(['#7b8794', '#525e72'])
    expect([dark.theme.colors['list.inactiveSelectionBackground'], light.theme.colors['list.inactiveSelectionBackground']]).toEqual(['#8fb7ff33', '#0f766e33'])
    expect([dark.theme.type, light.theme.type, dark.theme.id, dark.theme.name]).toEqual(['dark', 'light', 'test', 'Test'])
    expect(dark.palette.get('canvas')).toBe('#0f1419')
  })
  it('falls back to the built-in slot for reference cycles, unknown slots, and long chains', () => {
    const cycle = resolve({ type: 'dark', palette: { accent: '$focus', focus: '$accent' } })
    expect(cycle.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/focus' })])
    expect(cycle.theme.colors['focusBorder']).toBe('#76acff')
    expect(cycle.theme.colors['button.background']).toBe('#76acff')
    const viaBuiltin = resolve({ type: 'dark', palette: { accent: '$info' } })
    expect(viaBuiltin.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/accent' })])
    expect(viaBuiltin.theme.colors['button.background']).toBe('#8fb7ff')
    expect(viaBuiltin.theme.colors['infoForeground']).toBe('#8fb7ff')
    const unknown = resolve({ type: 'dark', palette: { accent: '$nothing', mine: '$alsoNothing' }, colors: { 'tab.border': '$mine' } })
    expect(unknown.problems.map(problem => [problem.code, problem.path])).toEqual([['W_REF_UNKNOWN', '/palette/accent'], ['W_REF_UNKNOWN', '/palette/mine'], ['W_REF_UNKNOWN', '/colors/tab.border']])
    expect(unknown.theme.colors['button.background']).toBe('#8fb7ff')
    expect(unknown.theme.colors['tab.border']).toBe('#2b3443')
    expect(unknown.palette.has('mine')).toBe(false)
    const chain = { a: '$b', b: '$c', c: '$d', d: '$e', e: '#123456' }
    expect(resolve({ type: 'dark', palette: { ...chain, accent: '$b' } }).theme.colors['button.background']).toBe('#123456')
    const long = resolve({ type: 'dark', palette: { ...chain, accent: '$a' } })
    expect(long.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/accent' })])
    expect(long.theme.colors['button.background']).toBe('#8fb7ff')
  })
  it('makes the opaque keys opaque whatever the theme supplies', () => {
    const { theme, problems } = resolve({ type: 'dark', colors: { 'editor.background': '#ff000080', 'titleBar.activeBackground': '#00ff0000', 'titleBar.controlsForeground': '#ffffff80', 'editorLineNumber.foreground': '#ffffff00' } })
    expect(problems).toEqual([])
    expect(theme.colors['editor.background']).toBe('#800000')
    expect(theme.colors['titleBar.activeBackground']).toBe('#800000')
    expect(theme.colors['titleBar.controlsForeground']).toBe('#c08080')
    expect(theme.colors['editorLineNumber.foreground']).toBe('#800000')
    expect(theme.colors['editor.lineHighlightBackground']).toMatch(/^#[0-9a-f]{6}$/)
    expect(resolve({ type: 'light', colors: { 'editor.background': '#00000080' } }, 'light').theme.colors['editor.background']).toBe('#7f7f7f')
    for (const type of types) for (const key of colorKeys.filter(key => colorRegistry[key].opaqueOver)) expect(resolveBuiltin(type).colors[key]).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('inherits syntax from parent scopes and merges foreground and fontStyle independently', () => {
    const { theme, problems } = resolve({
      type: 'dark', palette: { accent: '#ffb000' }, tokenColors: [
        { scope: ['keyword', 'storage.type'], settings: { foreground: '$accent', fontStyle: 'bold' } },
        { scope: 'keyword.block', settings: { fontStyle: 'italic' } },
        { scope: 'keyword', settings: { foreground: '#ff000080' } },
        { scope: 'comment.quote', settings: { foreground: '$missing' } }
      ]
    })
    expect(theme.syntax['keyword']).toEqual({ foreground: '#880a0e', fontStyle: 'bold' })
    expect(theme.syntax['keyword.try']).toEqual({ foreground: '#880a0e', fontStyle: 'bold' })
    expect(theme.syntax['keyword.block']).toEqual({ foreground: '#880a0e', fontStyle: 'italic' })
    expect(theme.syntax['comment.quote']).toEqual({ foreground: '#6a9955', fontStyle: '' })
    expect(theme.syntax['string']).toEqual({ foreground: '#ff4040', fontStyle: '' })
    expect(problems).toEqual([expect.objectContaining({ code: 'W_REF_UNKNOWN', path: '/tokenColors/3/settings/foreground' })])
    // A rule naming every scope is one entry of the file, so a broken color in it is one problem, not sixteen.
    const wide = resolve({ tokenColors: [{ scope: [...sqlScopes], settings: { foreground: '$missing' } }] })
    expect(wide.problems.map(problem => [problem.code, problem.path])).toEqual([['W_REF_UNKNOWN', '/tokenColors/0/settings/foreground']])
  })
  it('emits only canonical colors and rejects tampered payloads', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type)
      expect(isResolvedTheme(theme)).toBe(true)
      expect(Object.keys(theme.colors)).toHaveLength(188)
      for (const key of colorKeys) expect(theme.colors[key]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      for (const scope of sqlScopes) expect(theme.syntax[scope].foreground).toMatch(/^#[0-9a-f]{6}$/)
    }
    const theme = resolveBuiltin('dark')
    const tampered: unknown[] = [
      null, 'theme', { ...theme, type: 'hc' }, { ...theme, id: 7 }, { ...theme, colors: undefined },
      { ...theme, colors: { ...theme.colors, 'editor.background': 'red;}body{display:none' } },
      { ...theme, colors: { ...theme.colors, 'editor.background': '#FFFFFF' } },
      { ...theme, colors: { ...theme.colors, 'focusBorder': undefined } },
      { ...theme, syntax: { ...theme.syntax, keyword: { foreground: '#ffffff80', fontStyle: '' } } },
      { ...theme, syntax: { ...theme.syntax, keyword: { foreground: '#ffffff', fontStyle: 'bold bold' } } },
      { ...theme, syntax: { ...theme.syntax, string: undefined } },
      { ...theme, colors: Object.assign(Object.create({ focusBorder: '#ffffff' }), Object.fromEntries(Object.entries(theme.colors).filter(([key]) => key !== 'focusBorder'))) }
    ]
    for (const value of tampered) expect(isResolvedTheme(value)).toBe(false)
    expect(isResolvedTheme(JSON.parse(JSON.stringify({ ...theme, extra: 1, colors: { ...theme.colors, extra: 'url(x)' } })))).toBe(true)
  })
  it('refuses to resolve a single-type theme for the other variant', () => {
    expect(() => resolveTheme([parsed({ type: 'dark' })], 'light')).toThrow('no light variant')
  })
})
