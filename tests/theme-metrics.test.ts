import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { explorerLimits } from '../src/shared/explorer/catalog'
import { defaultDensity, densities, densityUse, minimumFontSize, motion, radii, reducedMotion, renderMetricDocs, shadows, spaceScale, typeScale, typeScalePending, type DensityMetrics, type TypeStepName } from '../src/shared/theme/metrics'
import { cssRules, stylesheetRules, type CssRule } from './fixtures/css-rules'

const rules = stylesheetRules()
const all = rules.flatMap(rule => rule.declarations.map(declaration => ({ ...declaration, selector: rule.selector, at: rule.at, where: `${[...rule.at, rule.selector].join(' ')} { ${declaration.property}: ${declaration.value} }` })))
const ascending = (values: readonly number[]) => values.every((value, index) => index === 0 || value > values[index - 1])
const reducedAt = '@media (prefers-reduced-motion: reduce)'
/** A selector list's parts; commas inside :has() and :not() stay in their part. */
const parts = (selector: string) => selector.split(/,(?![^(]*\))/).map(part => part.trim())
/** The compound a selector part styles (`button.active` in `.title-bar-menus button.active`). */
const subject = (part: string) => part.split(/\s*[\s>+~]\s*(?![^(]*\))/).pop() ?? ''

// Codicon and text glyphs sized as icons, not text. They move to the icon registry's sizes with the icon system.
const glyphSizes: Readonly<Record<string, string>> = {
  '.oe-icon .codicon': '15px', '.oe-icon .oe-badge': '9px', '.oe-actions .codicon': '14px', '.query-status-state .codicon': '12px',
  '.output-empty-icon': '25px', '.memory-indicator .codicon': '12px', '.editor-status .codicon': '12px', '.favorite-button': '18px'
}
// A 3 px connection colour edge keeps its own rounding.
const indicatorRadii: Readonly<Record<string, string>> = { '.connection-swatch': '1px' }
// Monaco's own shadow for its find and hover widgets, as VS Code defines it (theme-smoke checks the computed value).
const shadowShims = new Set(['--vscode-shadow-lg'])

const sizeToken = /^var\(--varia-size-(xs|sm|md|lg|xl)\)$/
/** The size of a `font` shorthand, which comes before the family: `var(--varia-size-sm)/19px var(--varia-font-mono)`. */
const shorthandSize = (value: string) => value.match(/^(?:(?:italic|normal|bold|[1-9]00)\s+)*(var\([^)]*\)|[^\s/]+)/)?.[1] ?? ''
/** The type step a top-level rule sizes its text with. */
const stepOf = (selector: string) => {
  const entry = all.find(entry => entry.selector === selector && !entry.at.length && (entry.property === 'font-size' || entry.property === 'font'))
  return entry && (entry.property === 'font' ? shorthandSize(entry.value) : entry.value).match(sizeToken)?.[1] as TypeStepName | undefined
}
const lengths = (shadow: string) => shadow.replace(/var\([^)]*\)/g, ' ').match(/-?\d*\.?\d+(?:px)?\b/g) ?? []

const rendererDir = 'src/renderer/src'
const sources = readdirSync(rendererDir, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  .map(file => ({ file, code: readFileSync(join(rendererDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1') }))

/** Specificity as one number (ids, then classes, attributes and pseudo-classes, then types and pseudo-elements). */
function specificity(part: string): number {
  const ids = part.match(/#[\w-]+/g)?.length ?? 0
  const classes = (part.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length
  const types = (part.match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/g) ?? []).length
  return ids * 10000 + classes * 100 + types
}
/** Whether `stop` reaches every element Monaco's `loop` part does, and outranks it. */
function outranks(stop: string, loop: string): boolean {
  const classes = (part: string) => new Set(subject(part).match(/\.[\w-]+/g) ?? [])
  const pseudo = (part: string) => part.match(/::[\w-]+$/)?.[0] ?? ''
  const own = classes(loop)
  return [...classes(stop)].every(name => own.has(name) || name === '.codicon') && pseudo(stop) === pseudo(loop) && specificity(stop) > specificity(loop)
}

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
        if (!sizeToken.test(shorthandSize(value))) found.push(where)
      }
    }
    expect(found, 'use var(--varia-size-*) from src/shared/theme/metrics.ts').toEqual([])
    for (const [selector, size] of Object.entries(glyphSizes)) expect(all.some(entry => entry.selector === selector && entry.property === 'font-size' && entry.value === size), selector).toBe(true)
  })
  it('keeps literal font sizes out of renderer code', () => {
    // Inline styles, canvas fonts and style.setProperty calls take their sizes from metrics.ts too.
    const literals = [/\bfontSize\s*[:=]\s*\{?\s*['"`]?\d/g, /\bfont\s*[:=]\s*['"`](?:[^'"`]*\s)?\d*\.?\d+(?:px|pt|em|rem)\b/g, /['"]font(?:-size)?['"]\s*,\s*['"`](?:[^'"`]*\s)?\d*\.?\d+(?:px|pt|em|rem)\b/g]
    const found = sources.flatMap(({ file, code }) => literals.flatMap(pattern => [...code.matchAll(pattern)].map(match => `${file}: ${match[0]}`)))
    expect(found, 'use typeScale from src/shared/theme/metrics.ts').toEqual([])
  })
  it('keeps the surfaces still waiting for their planned step at their current one', () => {
    for (const entry of typeScalePending) {
      expect(entry.now, entry.what).not.toBe(entry.planned)
      for (const selector of entry.selectors) expect(stepOf(selector), `${entry.what}: ${selector}`).toBe(entry.now)
    }
  })
  it('measures grid columns at the size the grid draws its text', () => {
    // GridView measures digits and headers on a canvas at gridLimits.fontSize; the CSS must draw at that size.
    for (const selector of ['.rg', '.rg-ch, .rg-corner']) {
      const step = stepOf(selector)
      expect(step && typeScale[step].size, selector).toBe(gridLimits.fontSize)
    }
  })
  it('takes radii and shadows from the tokens', () => {
    const found: string[] = []
    // A shadow with a blur is elevation and takes a token; one without (rings, insets, indicator edges) is a border.
    const elevation = (shadow: string, token: RegExp) => { const blur = lengths(shadow)[2]; return !token.test(shadow) && blur !== undefined && parseFloat(blur) !== 0 }
    for (const { property, value, selector, where } of all) {
      if (/^border(?:-[a-z]+)*-radius$/.test(property)) {
        if (!/^var\(--varia-radius-(?:sm|lg|pill)\)$/.test(value) && value !== '0' && value !== '50%' && indicatorRadii[selector] !== value) found.push(where)
      } else if (property === 'box-shadow' || (property.startsWith('--') && property.endsWith('shadow'))) {
        if (shadowShims.has(property) || value === 'none') continue
        if (value.split(/,(?![^(]*\))/).some(shadow => elevation(shadow, /var\(--varia-shadow-(?:menu|popover|dialog)\)/))) found.push(where)
      } else if (/^(?:-webkit-)?(?:backdrop-)?filter$/.test(property)) {
        if ([...value.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].some(([, shadow]) => elevation(shadow, /var\(--varia-shadow-(?:menu|popover|dialog)\)/))) found.push(where)
      }
    }
    expect(found, 'use var(--varia-radius-*) and var(--varia-shadow-*) from src/shared/theme/metrics.ts').toEqual([])
    expect(all.some(({ property }) => shadowShims.has(property))).toBe(true)
  })
  it('times every transition and animation with the motion tokens, and stops them under reduced motion', () => {
    const timed = all.filter(({ property }) => /^(?:transition|animation)(?:-[a-z-]+)?$/.test(property) && property !== 'animation-name')
    expect(timed.filter(({ value }) => /\d(?:ms|s)\b/.test(value)).map(({ where }) => where), 'use var(--varia-motion-*)').toEqual([])
    const loops = timed.filter(({ value }) => /\binfinite\b/.test(value))
    // Transitions run once and use fast or base, which reduced motion sets to 0, in every rule but the ones that turn
    // motion off; loops use their own periods.
    expect(timed.filter(({ value, at }) => !at.includes(reducedAt) && value !== 'none' && !loops.some(loop => loop.value === value) && !/var\(--varia-motion-(?:fast|base)\)/.test(value)).map(({ where }) => where)).toEqual([])
    expect(loops.filter(({ value }) => !/var\(--varia-motion-(?:spin|pulse)\)/.test(value)).map(({ where }) => where)).toEqual([])
    const stopped = (selector: string) => rules.some((rule: CssRule) => rule.at.includes(reducedAt) && parts(rule.selector).includes(selector)
      && rule.declarations.some(({ property, value }) => property === 'animation' && value === 'none'))
    expect(loops.length).toBeGreaterThan(0)
    expect(loops.filter(({ selector }) => !stopped(selector)).map(({ where }) => where), 'a looping animation needs animation: none under prefers-reduced-motion').toEqual([])
    expect(reducedMotion).toEqual(['fast', 'base'])
    // Hover fills and surfaces that appear use the motion (the 80/120 ms of the design language).
    const uses = (selector: string, token: string) => all.some(entry => entry.selector === selector && !entry.at.length && /^(?:transition|animation)$/.test(entry.property) && entry.value.includes(`var(--varia-motion-${token})`))
    for (const selector of ['button:hover:not(:disabled)', '.explorer-row:hover']) expect(uses(selector, 'fast'), selector).toBe(true)
    for (const selector of ['.menu', '.quick-input', '.connection-modal', '.layout-dialog']) expect(uses(selector, 'base'), selector).toBe(true)
  })
  it('stops Monaco\'s codicon spinners under reduced motion, with rules that outrank Monaco\'s', () => {
    // codicon-modifiers.css is bundled with Monaco's styles; the query status bar and the tree's Loading rows use it.
    const monaco = cssRules(readFileSync('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css', 'utf8'))
    const spinning = monaco.filter(rule => !rule.at.length && rule.declarations.some(({ property, value }) => /^animation/.test(property) && /\binfinite\b/.test(value))).flatMap(rule => parts(rule.selector))
    expect(spinning).toEqual(expect.arrayContaining(['.codicon-loading.codicon-modifier-spin', '.codicon-loading']))
    const stops = rules.filter(rule => rule.at.includes(reducedAt) && rule.declarations.some(({ property, value }) => property === 'animation' && value === 'none')).flatMap(rule => parts(rule.selector))
    expect(spinning.filter(loop => !stops.some(stop => outranks(stop, loop))), 'add a stronger animation: none under prefers-reduced-motion').toEqual([])
  })
  it('fades only hover and pressed fills, so selection and other states change at once', () => {
    const fast = all.filter(({ property, value }) => property.startsWith('transition') && value.includes('var(--varia-motion-fast)'))
    expect(fast.length).toBeGreaterThan(0)
    expect(fast.filter(({ selector }) => !parts(selector).every(part => /:hover\b/.test(part))).map(({ where }) => where), 'only :hover rules carry the fast transition').toEqual([])
    // A rule that colours a selected, current, pressed, expanded or focused button or row while it may be hovered.
    const state = /\[aria-(?:selected|current|expanded|pressed|checked)=|\.active(?:-connection)?(?![\w-])|:focus-visible|\[data-active\]/
    const coloured = /^(?:background(?:-color)?|color|border(?:-[a-z]+)*-color)$/
    const instant = new Set(rules.filter(rule => !rule.at.includes(reducedAt) && rule.declarations.some(({ property, value }) => property === 'transition' && value === 'none')).flatMap(rule => parts(rule.selector)))
    const states = rules.filter(rule => !rule.at.includes(reducedAt) && rule.declarations.some(({ property }) => coloured.test(property))).flatMap(rule => parts(rule.selector))
      .filter(part => !/:hover\b/.test(part) && state.test(subject(part)) && /^(?:button|\.icon-button|\.explorer-row)(?![\w-])/.test(subject(part)))
    expect(states).toEqual(expect.arrayContaining(['.explorer-row[aria-selected="true"]', '.object-dialog-pages > button[aria-current="page"]', '.title-bar-menus button[aria-expanded="true"]']))
    expect([...new Set(states.filter(part => !instant.has(part)))], 'set transition: none on the state rule').toEqual([])
  })
  it('sizes rows and bars from the density tokens as densityUse lists them, and keeps the tree in step', () => {
    for (const name of Object.keys(densityUse) as (keyof DensityMetrics)[]) {
      const token = `var(--varia-${name})`
      expect([...new Set(all.filter(({ property, value }) => property === 'height' && value === token).map(({ selector }) => selector))].sort(), name).toEqual([...densityUse[name]].sort())
      // In every at-rule too: a media query must not resize what the token sizes.
      for (const selector of densityUse[name]) expect(all.filter(entry => entry.selector === selector && /^(?:min-|max-)?height$/.test(entry.property)).map(({ value }) => value), selector).toEqual([token])
    }
    expect(all.find(entry => entry.selector === '.icon-button' && entry.property === 'width')?.value).toBe('var(--varia-control)')
    // The tree places its rows by explorerLimits.rowHeight, so the two must agree.
    expect(explorerLimits.rowHeight).toBe(densities[defaultDensity].row)
  })
  it('draws numbers that change with tabular figures', () => {
    for (const selector of ['.rg', '.status-bar', '.query-status-bar']) {
      expect(all.some(entry => entry.selector === selector && entry.property === 'font-variant-numeric' && entry.value === 'tabular-nums'), selector).toBe(true)
    }
  })
})
