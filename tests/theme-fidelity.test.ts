import { describe, expect, it } from 'vitest'
import { composite, deltaEOK, hexColor } from '../src/shared/theme/color'
import { colorKeys, type ColorKey, type SqlScope } from '../src/shared/theme/registry'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import { legacyOther, legacyStyles, type LegacyColor, type LegacyTarget } from './fixtures/theme-legacy'

const dark = resolveBuiltin('dark')
const resolved = (target: LegacyTarget) => target.startsWith('syntax:') ? dark.syntax[target.slice('syntax:'.length) as SqlScope].foreground : dark.colors[target as ColorKey]
// Both colors are compared as painted: translucent ones over the surface they sit on.
function distance(entry: LegacyColor, target: LegacyTarget): number {
  const surface = hexColor(dark.colors[entry.over ?? 'editor.background'])
  return deltaEOK(composite(hexColor(entry.value), surface), composite(hexColor(resolved(target)), surface))
}
const limit = 0.06

describe('Varia Dark fidelity', () => {
  const all = [...legacyStyles, ...legacyOther]
  it('maps all 148 legacy stylesheet colors (117 distinct) in file order', () => {
    expect(legacyStyles).toHaveLength(148)
    expect(new Set(legacyStyles.map(entry => hexColor(entry.value)).map(color => JSON.stringify(color))).size).toBe(117)
    for (const entry of all) for (const key of entry.keys) if (!key.startsWith('syntax:')) expect(colorKeys, `${entry.source} ${entry.value}`).toContain(key)
  })
  it(`keeps every unlisted legacy color within OKLab ΔE ${limit} of today`, () => {
    const drift = all.flatMap(entry => entry.change ? [] : entry.keys.map(key => [entry, key, distance(entry, key)] as const))
      .filter(([, , value]) => value > limit).map(([entry, key, value]) => `${entry.source}${entry.line ? ':' + entry.line : ''} ${entry.value} -> ${key} ${resolved(key)}: ΔE ${value.toFixed(3)}`)
    expect(drift, drift.join('\n')).toEqual([])
    const close = all.filter(entry => !entry.change && entry.keys.every(key => distance(entry, key) <= 0.025)).length
    console.info(`Fidelity: ${close} of ${all.filter(entry => !entry.change).length} unchanged legacy colors are within ΔE 0.025.`)
  })
  it('gives a reason for every deliberate change and points it at a real difference', () => {
    const changes = all.filter(entry => entry.change)
    expect(changes.map(entry => entry.keys[0]).sort()).toEqual([
      'badge.foreground', 'breadcrumb.separatorForeground', 'button.border', 'button.border', 'button.border', 'button.border', 'button.border', 'button.border', 'button.border', 'dock.background', 'editorBracketHighlight.unexpectedBracket.foreground', 'editorGroup.dropBackground', 'editorGroupHeader.tabsBackground',
      'editorLineNumber.foreground', 'editorWidget.border', 'editorWidget.border', 'focusBorder', 'focusBorder', 'input.border', 'input.border', 'input.placeholderForeground', 'resultsGrid.headerDescriptionForeground',
      'resultsGrid.rowNumberForeground', 'scrollbarSlider.background', 'statusBar.separatorForeground', 'syntax:comment', 'syntax:string',
      'tab.border', 'tab.inactiveForeground', 'tab.unfocusedActiveForeground', 'tab.unfocusedInactiveForeground', 'widget.border'
    ])
    for (const entry of changes) {
      expect(entry.change!.length).toBeGreaterThan(10)
      expect(distance(entry, entry.keys[0]), `${entry.source} ${entry.value}`).toBeGreaterThan(0.01)
    }
  })
})
