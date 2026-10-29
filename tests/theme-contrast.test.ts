import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chartSeriesColors, chartStatusColors, chartSurfaces } from '../src/shared/theme/charts'
import { composite, contrast, hexColor, type Rgba } from '../src/shared/theme/color'
import { contrastExemptions, contrastPairs, hoverPairs, type ContrastPair } from '../src/shared/theme/contrast-pairs'
import { parseThemeSource } from '../src/shared/theme/format'
import { colorKeys, cssVariable, sqlScopes, type ColorKey, type SqlScope } from '../src/shared/theme/registry'
import { resolveBuiltin, resolveTheme } from '../src/shared/theme/resolve'
import type { ResolvedTheme, ThemeType } from '../src/shared/theme/types'

const types: ThemeType[] = ['dark', 'light']
const foregroundOf = (theme: ResolvedTheme, target: ContrastPair['foreground']) =>
  hexColor(target.startsWith('syntax:') ? theme.syntax[target.slice('syntax:'.length) as SqlScope].foreground : theme.colors[target as ColorKey])
function backgroundOf(theme: ResolvedTheme, layers: readonly ColorKey[]): Rgba {
  const [first, ...rest] = layers.map(key => hexColor(theme.colors[key]))
  const bottom = first.a < 255 ? composite(first, hexColor(theme.colors['editor.background'])) : first
  return rest.reduce((below, layer) => composite(layer, below), bottom)
}
const ratio = (theme: ResolvedTheme, pair: ContrastPair) => contrast(foregroundOf(theme, pair.foreground), backgroundOf(theme, pair.background))
const describePair = (type: ThemeType, pair: ContrastPair, value: number) => `${type}: ${pair.foreground} on ${pair.background.join(' > ')} is ${value.toFixed(2)}, needs ${pair.minimum}`

describe('built-in theme contrast', () => {
  it('meets every declared WCAG pair in both built-ins', () => {
    const failures = types.flatMap(type => contrastPairs.map(pair => [pair, ratio(resolveBuiltin(type), pair)] as const)
      .filter(([pair, value]) => value < pair.minimum).map(([pair, value]) => describePair(type, pair, value)))
    expect(failures, failures.join('\n')).toEqual([])
  })
  it('keeps hover fills noticeable on every surface they appear on', () => {
    const failures = types.flatMap(type => hoverPairs.map(pair => [pair, ratio(resolveBuiltin(type), pair)] as const)
      .filter(([pair, value]) => value < pair.minimum).map(([pair, value]) => describePair(type, pair, value)))
    expect(hoverPairs.length).toBeGreaterThan(4)
    expect(failures, failures.join('\n')).toEqual([])
  })
  it('holds chart series to 3:1 and chart text to 4.5:1 on every surface a chart sits on', () => {
    // Series are the chart's data (WCAG 1.4.11); grid lines are decorative and exempt. A tile's sparkline sits on the tile.
    expect(chartSurfaces).toContain('tile.background')
    for (const surface of chartSurfaces) {
      for (const color of [...chartSeriesColors, ...chartStatusColors]) expect(contrastPairs).toContainEqual({ foreground: color, background: [surface], minimum: 3 })
      expect(contrastPairs).toContainEqual({ foreground: 'charts.foreground', background: [surface], minimum: 4.5 })
    }
    expect(contrastExemptions['charts.lines']).toBeDefined()
  })
  it('leaves the active query\'s server row untinted, as a tint near the selection and hover fills read as one of them', () => {
    // Its glyph (objectExplorer.activeConnectionForeground, paired above on every row state) marks it instead.
    for (const type of types) {
      const theme = resolveBuiltin(type)
      expect(backgroundOf(theme, ['sideBar.background', 'objectExplorer.activeConnectionBackground']), type).toEqual(backgroundOf(theme, ['sideBar.background']))
    }
  })
  it('holds input and button outlines to 3:1 on every surface the controls sit on', () => {
    const outlines = contrastPairs.filter(pair => pair.foreground === 'input.border' || pair.foreground === 'button.border')
    // Fields and dialogs; the toolbar's server and database lists; Cancel on the Output toolbar; Object Explorer's
    // buttons; the results grid's Retry; the empty workspace and the failure screen.
    const surfaces = {
      'input.border': ['input.background', 'editorWidget.background', 'toolbar.background', 'panel.background'],
      'button.border': ['input.background', 'editorWidget.background', 'panelTitle.background', 'sideBar.background', 'panel.background', 'editor.background']
    }
    for (const [foreground, backgrounds] of Object.entries(surfaces)) {
      for (const surface of backgrounds) expect(outlines).toContainEqual({ foreground, background: [surface], minimum: 3 })
    }
  })
  it('checks everything a toast draws over its own background, which a theme can set apart', () => {
    const toast = (foreground: string, ...background: string[]) => ({ foreground, background: ['notifications.background', ...background] })
    const expected = [
      ...['notifications.foreground', 'descriptionForeground', 'button.secondaryForeground'].map(key => ({ ...toast(key), minimum: 4.5 })),
      { ...toast('button.secondaryHoverForeground', 'button.secondaryHoverBackground'), minimum: 4.5 },
      ...['button.border', 'focusBorder', 'notificationsErrorIcon.foreground', 'notificationsWarningIcon.foreground', 'notificationsInfoIcon.foreground'].map(key => ({ ...toast(key), minimum: 3 }))
    ]
    for (const pair of expected) expect(contrastPairs).toContainEqual(pair)
  })
  it('checks every foreground key and every SQL scope, or exempts it with a reason', () => {
    const checked = new Set<string>(contrastPairs.map(pair => pair.foreground))
    // Indicators (status dots and rings) are glyphs: they need a pair as text colors do.
    const foregrounds = colorKeys.filter(key => /(?:[Ff]oreground|Indicator)$/.test(key))
    const missing = [...foregrounds.filter(key => !checked.has(key) && !contrastExemptions[key]), ...sqlScopes.filter(scope => !checked.has('syntax:' + scope))]
    expect(missing).toEqual([])
    for (const [key, reason] of Object.entries(contrastExemptions)) {
      expect(colorKeys).toContain(key)
      expect(checked.has(key), `${key} is both checked and exempt`).toBe(false)
      expect(reason!.length).toBeGreaterThan(10)
    }
    for (const pair of [...contrastPairs, ...hoverPairs]) {
      expect(pair.background.length).toBeGreaterThan(0)
      for (const key of pair.background) expect(colorKeys).toContain(key)
      if (!pair.foreground.startsWith('syntax:')) expect(colorKeys).toContain(pair.foreground)
    }
  })
  it('pairs every text color styles.css draws on a background of its own rule with that background', () => {
    // A rule that sets both is a surface and its text: the pair must be checked over that exact fill.
    const css = readFileSync('src/renderer/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const keyOf = new Map(colorKeys.map(key => [cssVariable(key), key]))
    const single = (value: string | undefined) => value?.match(/^var\((--varia-[A-Za-z0-9-]+)\)$/)?.[1]
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => {
      const declarations = new Map(body.split(';').map(part => part.split(':')).filter(parts => parts.length >= 2).map(([name, ...value]) => [name.trim(), value.join(':').trim()]))
      return { selector: selector.trim(), color: keyOf.get(single(declarations.get('color')) ?? ''), background: keyOf.get(single(declarations.get('background') ?? declarations.get('background-color')) ?? '') }
    }).filter(rule => rule.color && rule.background)
    expect(rules.length).toBeGreaterThan(30)
    const missing = rules.filter(({ color, background }) => !contrastExemptions[color!] && !contrastPairs.some(pair => pair.foreground === color && pair.background.at(-1) === background))
    expect(missing.map(rule => `${rule.selector}: ${rule.color} on ${rule.background}`)).toEqual([])
  })
  it('holds the documentation example themes to the same pairs', () => {
    // A key default that stops following an override the examples make (the status bar's, say) shows up here.
    const directory = join('docs', 'themes', 'examples')
    const files = readdirSync(directory).filter(file => file.endsWith('.json')).sort()
    expect(files.length).toBeGreaterThan(1)
    const failures = files.flatMap(file => {
      const theme = parseThemeSource(readFileSync(join(directory, file)), file).theme!
      return (theme.type === 'dual' ? types : [theme.type]).flatMap(type => {
        const resolved = resolveTheme([theme], type).theme
        return contrastPairs.map(pair => [pair, ratio(resolved, pair)] as const).filter(([pair, value]) => value < pair.minimum).map(([pair, value]) => `${file} ${describePair(type, pair, value)}`)
      })
    })
    expect(failures, failures.join('\n')).toEqual([])
  })
  it('composites translucent foregrounds and backgrounds before measuring', () => {
    const dark = resolveBuiltin('dark')
    const pair: ContrastPair = { foreground: 'emptyState.iconForeground', background: ['panel.background', 'resultsGrid.alternateRowBackground'], minimum: 3 }
    const striped = composite(hexColor('#d9dce305'), hexColor('#16181d'))
    expect(ratio(dark, pair)).toBeCloseTo(contrast(composite(hexColor('#7f869499'), striped), striped), 6)
  })
})
