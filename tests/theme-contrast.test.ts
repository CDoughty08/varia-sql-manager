import { describe, expect, it } from 'vitest'
import { composite, contrast, hexColor, type Rgba } from '../src/shared/theme/color'
import { contrastExemptions, contrastPairs, hoverPairs, type ContrastPair } from '../src/shared/theme/contrast-pairs'
import { colorKeys, sqlScopes, type ColorKey, type SqlScope } from '../src/shared/theme/registry'
import { resolveBuiltin } from '../src/shared/theme/resolve'
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
  it('checks every foreground key and every SQL scope, or exempts it with a reason', () => {
    const checked = new Set<string>(contrastPairs.map(pair => pair.foreground))
    const foregrounds = colorKeys.filter(key => /[Ff]oreground$/.test(key))
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
  it('composites translucent foregrounds and backgrounds before measuring', () => {
    const dark = resolveBuiltin('dark')
    const pair: ContrastPair = { foreground: 'resultsGrid.nullForeground', background: ['panel.background', 'resultsGrid.alternateRowBackground'], minimum: 4.5 }
    const striped = composite(hexColor('#d9e1ec08'), hexColor('#141a23'))
    expect(ratio(dark, pair)).toBeCloseTo(contrast(composite(hexColor('#dfbd82b3'), striped), striped), 6)
  })
})
