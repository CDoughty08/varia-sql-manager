import { describe, expect, it } from 'vitest'
import { explorerLimits } from '../src/shared/explorer/catalog'
import { defaultDensity, densities, minimumFontSize, motion, radii, reducedMotion, renderMetricDocs, shadows, spaceScale, typeScale } from '../src/shared/theme/metrics'
import { stylesheetRules, type CssRule } from './fixtures/css-rules'

const rules = stylesheetRules()
const all = rules.flatMap(rule => rule.declarations.map(declaration => ({ ...declaration, selector: rule.selector, at: rule.at, where: `${[...rule.at, rule.selector].join(' ')} { ${declaration.property}: ${declaration.value} }` })))
const ascending = (values: readonly number[]) => values.every((value, index) => index === 0 || value > values[index - 1])

// Codicon and text glyphs sized as icons, not text. They move to the icon registry's sizes with the icon system.
const glyphSizes: Readonly<Record<string, string>> = {
  '.oe-icon .codicon': '15px', '.oe-icon .oe-badge': '9px', '.oe-actions .codicon': '14px', '.query-status-state .codicon': '12px',
  '.output-empty-icon': '25px', '.memory-indicator .codicon': '12px', '.editor-status .codicon': '12px', '.favorite-button': '18px'
}
// A 3 px connection colour edge keeps its own rounding.
const indicatorRadii: Readonly<Record<string, string>> = { '.connection-swatch': '1px' }
// Monaco's own shadow for its find and hover widgets, as VS Code defines it (theme-smoke checks the computed value).
const shadowShims = new Set(['--vscode-shadow-lg'])

const sizeToken = /^var\(--varia-size-(?:xs|sm|md|lg|xl)\)$/
const lengths = (shadow: string) => shadow.replace(/var\([^)]*\)/g, ' ').match(/-?\d*\.?\d+(?:px)?\b/g) ?? []

describe('metric tokens', () => {
  it('keeps docs/themes/metrics.md in sync', async () => {
    // Regenerate after changing metrics.ts: npx vitest run tests/theme-metrics.test.ts -u
    await expect(renderMetricDocs()).toMatchFileSnapshot('../docs/themes/metrics.md')
  })
  it('keeps the scales ordered and the type scale at or above the floor', () => {
    const steps = Object.values(typeScale)
    expect(minimumFontSize).toBe(11)
    expect(steps.every(step => step.size >= minimumFontSize && step.line >= step.size)).toBe(true)
    expect(ascending(steps.map(step => step.size))).toBe(true)
    expect(ascending(spaceScale)).toBe(true)
    expect(ascending(Object.values(radii).map(radius => radius.px))).toBe(true)
    expect(ascending(Object.values(shadows).map(shadow => shadow.blur))).toBe(true)
    expect([motion.fast.ms, motion.base.ms]).toEqual([80, 120])
    expect(defaultDensity).toBe('compact')
    for (const [name, value] of Object.entries(densities.compact)) expect(densities.comfortable[name as keyof typeof densities.compact], name).toBeGreaterThanOrEqual(value)
  })
  it('sizes all text from the type scale, so nothing is under 11 px', () => {
    const found: string[] = []
    for (const { property, value, selector, where } of all) {
      if (property === 'font-size' || property === '--dv-tab-font-size') {
        if (!sizeToken.test(value) && value !== 'inherit' && glyphSizes[selector] !== value) found.push(where)
      } else if (property === 'font' && value !== 'inherit') {
        // The shorthand's size comes before the family: `var(--varia-size-sm)/19px var(--varia-font-mono)`.
        const size = value.match(/^(?:(?:italic|normal|bold|[1-9]00)\s+)*(var\([^)]*\)|[^\s/]+)/)?.[1] ?? ''
        if (!sizeToken.test(size)) found.push(where)
      }
    }
    expect(found, 'use var(--varia-size-*) from src/shared/theme/metrics.ts').toEqual([])
    for (const [selector, size] of Object.entries(glyphSizes)) expect(all.some(entry => entry.selector === selector && entry.property === 'font-size' && entry.value === size), selector).toBe(true)
  })
  it('takes radii and shadows from the tokens', () => {
    const found: string[] = []
    for (const { property, value, selector, where } of all) {
      if (/^border(?:-[a-z]+)*-radius$/.test(property)) {
        if (!/^var\(--varia-radius-(?:sm|lg|pill)\)$/.test(value) && value !== '0' && value !== '50%' && indicatorRadii[selector] !== value) found.push(where)
      } else if (property === 'box-shadow' || (property.startsWith('--') && property.endsWith('shadow'))) {
        if (shadowShims.has(property) || value === 'none') continue
        // A shadow with a blur is elevation and takes a token; one without (rings, insets, indicator edges) is a border.
        for (const shadow of value.split(/,(?![^(]*\))/)) {
          const blur = lengths(shadow)[2]
          if (!/var\(--varia-shadow-(?:menu|popover|dialog)\)/.test(shadow) && blur !== undefined && parseFloat(blur) !== 0) found.push(where)
        }
      }
    }
    expect(found, 'use var(--varia-radius-*) and var(--varia-shadow-*) from src/shared/theme/metrics.ts').toEqual([])
    expect(all.some(({ property }) => shadowShims.has(property))).toBe(true)
  })
  it('times every transition and animation with the motion tokens, and stops them under reduced motion', () => {
    const timed = all.filter(({ property }) => /^(?:transition|animation)(?:-[a-z-]+)?$/.test(property) && property !== 'animation-name')
    expect(timed.filter(({ value }) => /\d(?:ms|s)\b/.test(value)).map(({ where }) => where), 'use var(--varia-motion-*)').toEqual([])
    const loops = timed.filter(({ value }) => /\binfinite\b/.test(value))
    // Transitions run once and use fast or base, which reduced motion sets to 0; loops use their own periods.
    expect(timed.filter(({ value, at }) => !at.length && value !== 'none' && !loops.some(loop => loop.value === value) && !/var\(--varia-motion-(?:fast|base)\)/.test(value)).map(({ where }) => where)).toEqual([])
    expect(loops.filter(({ value }) => !/var\(--varia-motion-(?:spin|pulse)\)/.test(value)).map(({ where }) => where)).toEqual([])
    const stopped = (selector: string) => rules.some((rule: CssRule) => rule.at.includes('@media (prefers-reduced-motion: reduce)') && rule.selector.split(',').map(part => part.trim()).includes(selector)
      && rule.declarations.some(({ property, value }) => property === 'animation' && value === 'none'))
    expect(loops.length).toBeGreaterThan(0)
    expect(loops.filter(({ selector }) => !stopped(selector)).map(({ where }) => where), 'a looping animation needs animation: none under prefers-reduced-motion').toEqual([])
    expect(reducedMotion).toEqual(['fast', 'base'])
    // Hover fills and surfaces that appear use the motion (the 80/120 ms of the design language).
    const uses = (selector: string, token: string) => all.some(entry => entry.selector === selector && !entry.at.length && /^(?:transition|animation)$/.test(entry.property) && entry.value.includes(`var(--varia-motion-${token})`))
    for (const selector of ['button', '.explorer-row']) expect(uses(selector, 'fast'), selector).toBe(true)
    for (const selector of ['.menu', '.quick-input', '.connection-modal', '.layout-dialog']) expect(uses(selector, 'base'), selector).toBe(true)
  })
  it('sizes rows and bars from the density tokens and keeps the tree in step with them', () => {
    const height = (selector: string) => all.find(entry => entry.selector === selector && entry.property === 'height' && !entry.at.length)?.value
    expect(height('.explorer-row')).toBe('var(--varia-row)')
    // The tree places its rows by explorerLimits.rowHeight, so the two must agree.
    expect(explorerLimits.rowHeight).toBe(densities[defaultDensity].row)
    expect(height('.status-bar')).toBe('var(--varia-status)')
    expect(height('.query-status-bar')).toBe('var(--varia-status)')
    expect(height('.query-tabs')).toBe('var(--varia-bar)')
    expect(height('.icon-button')).toBe('var(--varia-control)')
  })
  it('draws numbers that change with tabular figures', () => {
    for (const selector of ['.rg', '.status-bar', '.query-status-bar']) {
      expect(all.some(entry => entry.selector === selector && entry.property === 'font-variant-numeric' && entry.value === 'tabular-nums'), selector).toBe(true)
    }
  })
})
