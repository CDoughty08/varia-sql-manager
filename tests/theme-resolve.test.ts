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

// The Calm Pro design's resolved Dark and Light values (its contrast-checked proposal), transcribed independently of the
// registry defaults. Where they depart: the active connection row keeps its tint, the only mark of the active query's
// server; accentSurface is deeper, so the executing tint reaches 1.2:1 on the chrome and canvas; the status bar has a top
// line (statusBar.border) to set it apart from Object Explorer's fill; and the disconnected text follows the status
// bar's text, so a theme that recolors the bar keeps it readable. The states kit takes the design's pill tints and live
// colors, but pill text uses the status surface texts (and a successText slot), which stay readable over selected rows and
// tinted status bars where the plain status colors do not; skeleton bars use the pressed fill, as the hover fill is too
// faint on dialogs.
const specValues = `
foreground #d9dce3 #1c1f26|descriptionForeground #9298a4 #5c6370|disabledForeground #9298a4 #5c6370|errorForeground #f39a9a #b42229
warningForeground #e4bb6a #875800|successForeground #74d19c #146f3b|infoForeground #8f9cff #4453d0|focusBorder #8f9cff #4453d0
icon.foreground #a3a9b5 #4d5461|widget.shadow #00000085 #10182824|widget.border #6b7286 #d4d8df|textPreformat.foreground #bcc1cb #3a404b
sash.hoverBorder #8f9cff #4453d0|scrollbarSlider.background #9298a466 #5c637066|scrollbarSlider.hoverBackground #9298a48c #5c63708c
scrollbarSlider.activeBackground #9298a4b3 #5c6370b3|titleBar.activeBackground #111317 #f7f8fa|titleBar.activeForeground #9298a4 #5c6370
titleBar.inactiveBackground #111317 #f7f8fa|titleBar.inactiveForeground #9298a4 #5c6370|titleBar.border #262a31 #e3e6eb
titleBar.iconForeground #8f9cff #4453d0|titleBar.controlsForeground #d9dce3 #1c1f26|menubar.selectionBackground #30343e #d6dae0
menubar.selectionForeground #f5f6f8 #0a0c10|menubar.selectionBorder #8f9cff00 #4453d000|menu.background #1d2026 #ffffff
menu.foreground #d9dce3 #1c1f26|menu.selectionBackground #30343e #d6dae0|menu.selectionForeground #f5f6f8 #0a0c10
menu.selectionBorder #8f9cff00 #4453d000|menu.separatorBackground #30343c #dcdfe5|menu.border #6b7286 #d4d8df|toolbar.background #111317 #f7f8fa
toolbar.border #262a31 #e3e6eb|toolbar.hoverBackground #d9dce31f #1c1f261f|toolbar.separatorBackground #30343c #dcdfe5
toolbar.labelForeground #a3a9b5 #4d5461|keybindingLabel.foreground #9298a4 #5c6370|keybindingLabel.border #30343c #dcdfe5
button.background #8f9cff #4453d0|button.foreground #0e1230 #ffffff|button.hoverBackground #a8b2ff #3744b8|button.border #6b7286 #878e9b
button.secondaryForeground #bcc1cb #3a404b|button.secondaryHoverBackground #262a32 #dfe2e7|button.secondaryHoverForeground #f5f6f8 #0a0c10
input.background #101216 #ffffff|input.foreground #d9dce3 #1c1f26|input.border #6a7184 #878e9b|input.placeholderForeground #9298a4 #5c6370
inputValidation.errorBackground #3a1d22 #fdecec|inputValidation.errorForeground #f6bcc1 #8f1d24|sideBar.background #111317 #f7f8fa
sideBarTitle.foreground #a3a9b5 #4d5461|sideBarSectionHeader.border #1f2228 #eceef2|list.hoverBackground #262a32 #dfe2e7
list.activeSelectionBackground #29314f #d9e0fb|list.activeSelectionForeground #d9dce3 #1c1f26|list.inactiveSelectionBackground #21273b #e7ebfc
list.inactiveSelectionForeground #d9dce3 #1c1f26|list.focusOutline #8f9cff #4453d0|list.highlightForeground #8f9cff #4453d0
list.focusHighlightForeground #d9dce3 #1c1f26|list.filterMatchBackground #8f9cff33 #4453d033|tree.indentGuidesStroke #1f2228 #eceef2
objectExplorer.activeConnectionBackground #232842 #dde1f9|objectExplorer.headingForeground #d9dce3 #1c1f26
objectExplorer.sublabelForeground #bcc1cb #3a404b|objectExplorer.countForeground #9298a4 #5c6370|objectExplorer.chevronForeground #7f8694 #6b7280
objectExplorer.folderIconForeground #bfa878 #7d6532|objectExplorer.objectIconForeground #a3a9b5 #4d5461
objectExplorer.actionForeground #a3a9b5 #4d5461|editorGroupHeader.tabsBackground #111317 #f7f8fa|tab.activeBackground #16181d #ffffff
tab.inactiveBackground #111317 #f7f8fa|tab.unfocusedActiveBackground #16181d #ffffff|tab.unfocusedInactiveBackground #111317 #f7f8fa
tab.activeForeground #f5f6f8 #0a0c10|tab.inactiveForeground #9298a4 #5c6370|tab.unfocusedActiveForeground #a3a9b5 #4d5461
tab.unfocusedInactiveForeground #9298a4 #5c6370|tab.border #262a31 #e3e6eb|tab.activeBorderTop #8f9cff #4453d0|editorGroup.border #262a31 #e3e6eb
editorGroup.dropBackground #8f9cff4d #4453d04d|dock.background #16181d #ffffff|dock.guideBackground #1d2026 #ffffff
dock.guideForeground #8f9cff #4453d0|dock.guideBorder #6b7286 #878e9b|dock.guideShadow #00000085 #10182824|dock.guideActiveBackground #29314f #d9e0fb
dock.guideActiveBorder #8f9cff #4453d0|dock.guideActiveRing #8f9cff99 #4453d099|dock.previewBackground #8f9cff2e #4453d02e
dock.previewBorder #8f9cff #4453d0|dock.previewInnerBorder #8f9cff59 #4453d059|documentTabs.background #111317 #f7f8fa
documentTabs.activeBackground #16181d #ffffff|documentTabs.activeForeground #d9dce3 #1c1f26|documentTabs.inactiveForeground #9298a4 #5c6370
documentTabs.border #262a31 #e3e6eb|documentTabs.closeForeground #9298a4 #5c6370|documentTabs.iconForeground #a3a9b5 #4d5461
documentTabs.modifiedIndicator #9298a4 #5c6370|breadcrumb.foreground #9298a4 #5c6370|breadcrumb.separatorForeground #9298a4 #5c6370
editor.background #16181d #ffffff|editor.foreground #d9dce3 #1c1f26|editor.lineHighlightBackground #1e2025 #f6f6f6
editor.selectionBackground #2f3b66 #c8d2fa|editorLineNumber.foreground #9298a4 #5c6370|editorLineNumber.activeForeground #bcc1cb #3a404b
editorWhitespace.foreground #9298a480 #5c637080|editorBookmark.foreground #8f9cff #4453d0|editorBracketHighlight.foreground1 #dcc06a #7a5c00
editorBracketHighlight.foreground2 #cd9ff0 #8338b4|editorBracketHighlight.foreground3 #74b4ef #1d68ad
editorBracketHighlight.foreground4 #dcc06a #7a5c00|editorBracketHighlight.foreground5 #cd9ff0 #8338b4
editorBracketHighlight.foreground6 #74b4ef #1d68ad|editorBracketHighlight.unexpectedBracket.foreground #f39a9a #b42229
editorWidget.background #1d2026 #ffffff|editorWidget.foreground #d9dce3 #1c1f26|editorWidget.border #6b7286 #d4d8df
emptyState.foreground #9298a4 #5c6370|emptyState.titleForeground #a3a9b5 #4d5461|emptyState.iconForeground #7f869499 #6b728099
panel.background #16181d #ffffff|panel.border #262a31 #e3e6eb|panelTitle.background #16181d #ffffff|panelTitle.activeForeground #f5f6f8 #0a0c10
panelTitle.inactiveForeground #9298a4 #5c6370|panelTitle.activeBorder #8f9cff #4453d0|badge.background #30343e #d6dae0
badge.foreground #bcc1cb #3a404b|resultsGrid.background #16181d #ffffff|resultsGrid.foreground #d9dce3 #1c1f26
resultsGrid.headerBackground #16181d #ffffff|resultsGrid.headerForeground #a3a9b5 #4d5461|resultsGrid.headerDescriptionForeground #9298a4 #5c6370
resultsGrid.gridlines #1f2228 #eceef2|resultsGrid.alternateRowBackground #d9dce305 #1c1f2605|resultsGrid.rowNumberForeground #9298a4 #5c6370
resultsGrid.nullForeground #9298a4 #5c6370|resultsGrid.nullBackground #d9dce300 #1c1f2600|resultsGrid.truncationForeground #e4bb6a #875800
resultsGrid.selectionBackground #29314f #d9e0fb|resultsGrid.selectionForeground #d9dce3 #1c1f26
resultsGrid.inactiveSelectionBackground #21273b #e7ebfc|resultsGrid.activeCellBorder #8f9cff #4453d0|resultsGrid.hoverBackground #262a32 #dfe2e7
resultsGrid.headerSelectionBackground #21273b #e7ebfc|resultsGrid.headerSelectionForeground #bcc5ff #3240b0|resultsGrid.linkForeground #8f9cff #4453d0
resultsGrid.splitterBackground #6b7286 #878e9b|resultsMessages.foreground #d9dce3 #1c1f26|statusBar.background #111317 #f7f8fa
statusBar.foreground #a3a9b5 #4d5461|statusBar.border #262a31 #e3e6eb|statusBar.separatorForeground #9298a4 #5c6370
statusBar.onlineIndicator #74d19c #146f3b|statusBar.idleIndicator #9298a4 #5c6370|statusBar.executingBackground #232842 #dde1f9|statusBar.executingForeground #bcc5ff #3240b0
statusBar.disconnectedBackground #111317 #f7f8fa|statusBar.disconnectedForeground #a3a9b5 #4d5461|statusBar.errorBackground #3a1d22 #fdecec
statusBar.errorForeground #f6bcc1 #8f1d24|queryStatusBar.background #16181d #ffffff|queryStatusBar.foreground #a3a9b5 #4d5461
queryStatusBar.executingBackground #232842 #dde1f9|queryStatusBar.executingForeground #bcc5ff #3240b0|queryStatusBar.errorBackground #3a1d22 #fdecec
queryStatusBar.errorForeground #f6bcc1 #8f1d24|banner.errorBackground #3a1d22 #fdecec|banner.errorForeground #f6bcc1 #8f1d24
banner.warningBackground #33291a #fff5dc|banner.warningForeground #f0d49e #6b4400|dialog.backdropBackground #0a0c10b3 #1c1f2652
dialog.separatorBackground #30343c #dcdfe5|dialog.labelForeground #bcc1cb #3a404b|dialog.descriptionForeground #a3a9b5 #4d5461
settings.headerForeground #f5f6f8 #0a0c10|notifications.background #1d2026 #ffffff|notifications.foreground #d9dce3 #1c1f26
notifications.border #6b7286 #d4d8df|notificationsErrorIcon.foreground #f39a9a #b42229|notificationsWarningIcon.foreground #e4bb6a #875800
notificationsInfoIcon.foreground #8f9cff #4453d0|quickInput.background #1d2026 #ffffff|quickInput.foreground #d9dce3 #1c1f26
quickInputTitle.background #1c1f25 #f1f3f6|quickInputList.focusBackground #29314f #d9e0fb|quickInputList.focusForeground #d9dce3 #1c1f26
pickerGroup.foreground #bcc5ff #3240b0|pickerGroup.border #30343c #dcdfe5
statusPill.runningBackground #232842 #dde1f9|statusPill.runningForeground #bcc5ff #3240b0|statusPill.successBackground #74d19c24 #146f3b24
statusPill.successForeground #a6e8bf #0f5a2f|statusPill.warningBackground #e4bb6a24 #87580024|statusPill.warningForeground #f0d49e #6b4400
statusPill.criticalBackground #f39a9a24 #b4222924|statusPill.criticalForeground #f6bcc1 #8f1d24|statusPill.infoBackground #8f9cff24 #4453d024
statusPill.infoForeground #bcc5ff #3240b0|statusPill.neutralBackground #30343e #d6dae0|statusPill.neutralForeground #bcc1cb #3a404b
chip.background #d9dce300 #1c1f2600|chip.foreground #bcc1cb #3a404b|chip.border #6b728673 #878e9b73|chip.activeBackground #21273b #e7ebfc
chip.activeForeground #bcc5ff #3240b0|chip.activeBorder #8f9cff #4453d0|live.indicator #74d19c #146f3b|live.pausedForeground #9298a4 #5c6370
live.staleForeground #f0d49e #6b4400|live.staleBackground #e4bb6a24 #87580024|tile.background #16181d #ffffff|tile.border #262a31 #e3e6eb
tile.warningBorder #e4bb6a #875800|tile.criticalBorder #f39a9a #b42229|skeleton.background #30343e #d6dae0
connection.red #e66767 #c42b3c|connection.orange #e09358 #b45309
connection.yellow #d8bf5e #8f6b00|connection.green #6fbf8a #2e7d4f|connection.blue #6ea4ea #2563a8|connection.purple #ab95ea #7a4bbf
connection.default #8d939f #6b7280|connection.favoriteForeground #d8bf5e #8f6b00`
const specSyntax = { keyword: ['#93a4ff', '#3442c2'], operator: ['#9ea6b4', '#575e6b'], predefined: ['#d4a9f2', '#8338b4'], string: ['#9fd4a9', '#2c7440'],
  number: ['#e8b97d', '#965700'], comment: ['#868e9b', '#636a76'], identifier: ['#d9dce3', '#1c1f26'], delimiter: ['#9ea6b4', '#575e6b'] }

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
      const fontStyle = scope.startsWith('comment') ? 'italic' : ''
      expect(resolveBuiltin('dark').syntax[scope]).toEqual({ foreground: darkValue, fontStyle })
      expect(resolveBuiltin('light').syntax[scope]).toEqual({ foreground: lightValue, fontStyle })
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
  it('have 67 slots, 233 keys and 16 scopes, with an acyclic and complete reference graph', () => {
    expect(paletteSlots).toHaveLength(67)
    expect(colorKeys).toHaveLength(233)
    expect(new Set(colorKeys).size).toBe(233)
    expect(sqlScopes).toHaveLength(16)
    expect([...colorKeyOrder].sort()).toEqual([...colorKeys].sort())
    for (const key of colorKeys) {
      for (const type of types) {
        const value = defaultFor(key, type)
        if (value.startsWith('@')) {
          expect(isColorKey(value.slice(1)), `${key} -> ${value}`).toBe(true)
          expect(colorKeyOrder.indexOf(value.slice(1) as ColorKey)).toBeLessThan(colorKeyOrder.indexOf(key))
        } else if (value.startsWith('$')) expect(isPaletteSlot(value.slice(1).split('/')[0]), `${key} -> ${value}`).toBe(true)
        else expect.fail(`${key}: a default refers to a slot or a key, never a literal (${value})`)
      }
      expect(key.includes('-'), key).toBe(false)
      expect(cssVariable(key)).toBe('--varia-' + key.split('.').join('-'))
    }
    expect(new Set(colorKeys.map(cssVariable)).size).toBe(233)
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
    expect(theme.colors['dock.guideForeground']).toBe('#ffb000')
    expect(theme.colors['dock.previewBackground']).toBe('#ffb0002e')
    expect(theme.colors['editorGroup.dropBackground']).toBe('#ffb0004d')
  })
  it('puts the user key ahead of the default, and a broken key falls back to the default', () => {
    const { theme, problems } = resolve({ palette: { deepSea: '#0b3d4a' }, colors: { 'statusBar.background': '$deepSea', 'focusBorder': '$nope', 'menu.border': '$deepSea/50' } })
    expect(theme.colors['statusBar.background']).toBe('#0b3d4a')
    expect(theme.colors['statusBar.disconnectedBackground']).toBe('#0b3d4a')
    // The disconnected state's text follows a recolored bar's text as its fill follows the bar's.
    expect(resolve({ colors: { 'statusBar.background': '#0b3d4a', 'statusBar.foreground': '#cfeff2' } }).theme.colors['statusBar.disconnectedForeground']).toBe('#cfeff2')
    expect(theme.colors['focusBorder']).toBe('#8f9cff')
    expect(theme.colors['menu.border']).toBe('#0b3d4a80')
    expect(problems).toEqual([expect.objectContaining({ code: 'W_REF_UNKNOWN', file: 'test.json', path: '/colors/focusBorder', severity: 'warning' })])
  })
  it('projects dual values per variant, and partial variants inherit', () => {
    const theme = parsed({ palette: { canvas: { dark: '#0f1419', light: '#fbfcfd' }, accent: { light: '#0f766e' } }, colors: { 'editorLineNumber.foreground': { dark: '#7b8794' }, 'list.inactiveSelectionBackground': '$accent/20' } })
    const dark = resolveTheme([theme], 'dark'), light = resolveTheme([theme], 'light')
    expect([dark.problems, light.problems]).toEqual([[], []])
    expect([dark.theme.colors['editor.background'], light.theme.colors['editor.background']]).toEqual(['#0f1419', '#fbfcfd'])
    expect([dark.theme.colors['button.background'], light.theme.colors['button.background']]).toEqual(['#8f9cff', '#0f766e'])
    expect([dark.theme.colors['editorLineNumber.foreground'], light.theme.colors['editorLineNumber.foreground']]).toEqual(['#7b8794', '#5c6370'])
    expect([dark.theme.colors['list.inactiveSelectionBackground'], light.theme.colors['list.inactiveSelectionBackground']]).toEqual(['#8f9cff33', '#0f766e33'])
    expect([dark.theme.type, light.theme.type, dark.theme.id, dark.theme.name]).toEqual(['dark', 'light', 'test', 'Test'])
    expect(dark.palette.get('canvas')).toBe('#0f1419')
  })
  it('falls back to the built-in slot for reference cycles, unknown slots, and long chains', () => {
    const cycle = resolve({ type: 'dark', palette: { accent: '$focus', focus: '$accent' } })
    expect(cycle.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/focus' })])
    expect(cycle.theme.colors['focusBorder']).toBe('#8f9cff')
    expect(cycle.theme.colors['button.background']).toBe('#8f9cff')
    const viaBuiltin = resolve({ type: 'dark', palette: { accent: '$info' } })
    expect(viaBuiltin.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/accent' })])
    expect(viaBuiltin.theme.colors['button.background']).toBe('#8f9cff')
    expect(viaBuiltin.theme.colors['infoForeground']).toBe('#8f9cff')
    const unknown = resolve({ type: 'dark', palette: { accent: '$nothing', mine: '$alsoNothing' }, colors: { 'tab.border': '$mine' } })
    expect(unknown.problems.map(problem => [problem.code, problem.path])).toEqual([['W_REF_UNKNOWN', '/palette/accent'], ['W_REF_UNKNOWN', '/palette/mine'], ['W_REF_UNKNOWN', '/colors/tab.border']])
    expect(unknown.theme.colors['button.background']).toBe('#8f9cff')
    expect(unknown.theme.colors['tab.border']).toBe('#262a31')
    expect(unknown.palette.has('mine')).toBe(false)
    const chain = { a: '$b', b: '$c', c: '$d', d: '$e', e: '#123456' }
    expect(resolve({ type: 'dark', palette: { ...chain, accent: '$b' } }).theme.colors['button.background']).toBe('#123456')
    const long = resolve({ type: 'dark', palette: { ...chain, accent: '$a' } })
    expect(long.problems).toEqual([expect.objectContaining({ code: 'W_REF_CYCLE', path: '/palette/accent' })])
    expect(long.theme.colors['button.background']).toBe('#8f9cff')
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
    expect(theme.syntax['keyword']).toEqual({ foreground: '#8b0c0e', fontStyle: 'bold' })
    expect(theme.syntax['keyword.try']).toEqual({ foreground: '#8b0c0e', fontStyle: 'bold' })
    expect(theme.syntax['keyword.block']).toEqual({ foreground: '#8b0c0e', fontStyle: 'italic' })
    expect(theme.syntax['comment.quote']).toEqual({ foreground: '#868e9b', fontStyle: 'italic' })
    expect(theme.syntax['string']).toEqual({ foreground: '#9fd4a9', fontStyle: '' })
    expect(problems).toEqual([expect.objectContaining({ code: 'W_REF_UNKNOWN', path: '/tokenColors/3/settings/foreground' })])
    // Comments are italic by default: a color-only rule keeps that, and an empty fontStyle removes it.
    const plain = resolve({ tokenColors: [{ scope: 'comment', settings: { foreground: '#808080' } }, { scope: 'comment.quote', settings: { fontStyle: '' } }] }).theme
    expect([plain.syntax['comment'], plain.syntax['comment.quote']]).toEqual([{ foreground: '#808080', fontStyle: 'italic' }, { foreground: '#808080', fontStyle: '' }])
    // A rule naming every scope is one entry of the file, so a broken color in it is one problem, not sixteen.
    const wide = resolve({ tokenColors: [{ scope: [...sqlScopes], settings: { foreground: '$missing' } }] })
    expect(wide.problems.map(problem => [problem.code, problem.path])).toEqual([['W_REF_UNKNOWN', '/tokenColors/0/settings/foreground']])
  })
  it('emits only canonical colors and rejects tampered payloads', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type)
      expect(isResolvedTheme(theme)).toBe(true)
      expect(Object.keys(theme.colors)).toHaveLength(233)
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
