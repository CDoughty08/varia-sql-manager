import { alpha, canonical, composite, hexColor, opaqueHex, parseHex, type Rgba } from './color'
import { createProblem, isFontStyle, quote, themeLimits, themePatterns } from './format'
import { builtinPalettes, builtinThemes, isPaletteSlot, paletteSlots } from './palette'
import { colorKeyOrder, colorKeys, colorRegistry, defaultFor, parentScope, sqlScopes, syntaxDefaults, syntaxFontStyleDefaults, type ColorKey, type SqlScope } from './registry'
import type { ParsedTheme, ResolvedTheme, SyntaxStyle, ThemeProblem, ThemeResolution, ThemeType, ThemeValue } from './types'

type Evaluated = { ok: true; color: Rgba; hops: number } | { ok: false; code: 'W_REF_UNKNOWN' | 'W_REF_CYCLE'; message: string }
interface PaletteEntry { expression: string; layer?: ParsedTheme; path?: string }

const reference = /^\$([a-z][A-Za-z0-9]{0,31})(?:\/(\d{1,3}))?$/
const canonicalColor = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
const canonicalOpaque = /^#[0-9a-f]{6}$/
const themeIdPattern = new RegExp(themePatterns.themeId)
const black: Rgba = { r: 0, g: 0, b: 0, a: 255 }, white: Rgba = { r: 255, g: 255, b: 255, a: 255 }

function project(value: ThemeValue | undefined, variant: ThemeType): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return Object.hasOwn(value, variant) ? value[variant] : undefined
}

// The built-in palettes evaluated on their own; a broken user entry falls back to these.
const builtinSlotColors: Record<ThemeType, Map<string, Rgba>> = { dark: evaluateBuiltin('dark'), light: evaluateBuiltin('light') }
function evaluateBuiltin(variant: ThemeType): Map<string, Rgba> {
  const values = new Map<string, Rgba>(), visiting = new Set<string>()
  const evaluate = (slot: string): Rgba => {
    const known = values.get(slot)
    if (known) return known
    if (!isPaletteSlot(slot) || visiting.has(slot)) throw new Error(`Built-in ${variant} palette slot ${slot} is unknown or cyclic.`)
    visiting.add(slot)
    const expression = builtinPalettes[variant][slot]
    const match = reference.exec(expression)
    const color = match ? alpha(evaluate(match[1]), match[2] === undefined ? 100 : Number(match[2])) : hexColor(expression)
    visiting.delete(slot)
    values.set(slot, color)
    return color
  }
  paletteSlots.forEach(evaluate)
  return values
}

/**
 * Resolves one variant of a theme. `layers` is nearest-first: `[]` for a built-in, `[userTheme]` today. Every key and
 * scope comes out canonical; a broken user entry is reported and replaced by its default.
 */
export function resolveTheme(layers: readonly ParsedTheme[], variant: ThemeType): ThemeResolution {
  for (const layer of layers) if (layer.type !== 'dual' && layer.type !== variant) throw new Error(`Theme ${layer.id} has no ${variant} variant.`)
  const problems: ThemeProblem[] = [], warned = new Set<string>()
  // A rule naming 16 scopes is 16 entries with one path; reporting it once keeps problems proportional to the file.
  const warn = (layer: ParsedTheme, path: string, failure: Extract<Evaluated, { ok: false }>) => {
    const identity = layer.fileName + path
    if (warned.has(identity)) return
    warned.add(identity)
    problems.push(createProblem(failure.code, layer.fileName, path, failure.message))
  }

  const entries = new Map<string, PaletteEntry>(paletteSlots.map(slot => [slot, { expression: builtinPalettes[variant][slot] }]))
  for (const layer of [...layers].reverse()) {
    for (const [slot, value] of layer.palette) {
      const expression = project(value, variant)
      if (expression !== undefined) entries.set(slot, { expression, layer, path: '/palette/' + slot + (typeof value === 'string' ? '' : '/' + variant) })
    }
  }

  const memo = new Map<string, Evaluated>(), visiting = new Set<string>()
  function evaluateSlot(slot: string): Evaluated {
    const known = memo.get(slot)
    if (known) return known
    const entry = entries.get(slot)
    if (!entry) return { ok: false, code: 'W_REF_UNKNOWN', message: `${quote('$' + slot)} is not a palette slot; the default is used.` }
    if (visiting.has(slot)) return { ok: false, code: 'W_REF_CYCLE', message: `${quote('$' + slot)} is part of a reference cycle; the default is used.` }
    visiting.add(slot)
    let result = evaluateExpression(entry.expression)
    if (result.ok && entry.layer && result.hops > themeLimits.hops) result = { ok: false, code: 'W_REF_CYCLE', message: `${quote('$' + slot)} needs more than ${themeLimits.hops} reference hops; the default is used.` }
    visiting.delete(slot)
    if (!result.ok) {
      const fallback = builtinSlotColors[variant].get(slot)
      if (entry.layer) {
        warn(entry.layer, entry.path!, result)
        if (fallback) result = { ok: true, color: fallback, hops: 0 }
      } else if (visiting.size) return result // a built-in entry inside a cycle: the user entry above it falls back and warns
      else result = { ok: true, color: fallback!, hops: 0 }
    }
    memo.set(slot, result)
    return result
  }
  function evaluateExpression(expression: string): Evaluated {
    const match = reference.exec(expression)
    if (!match) {
      const color = parseHex(expression)
      return color ? { ok: true, color, hops: 0 } : { ok: false, code: 'W_REF_UNKNOWN', message: `${quote(expression)} is not a color.` }
    }
    const target = evaluateSlot(match[1])
    if (!target.ok) return entries.has(match[1]) && !visiting.has(match[1]) ? { ...target, message: `${quote('$' + match[1])} could not be resolved; the default is used.` } : target
    return { ok: true, color: alpha(target.color, match[2] === undefined ? 100 : Number(match[2])), hops: target.hops + 1 }
  }

  const values = new Map<ColorKey, Rgba>()
  const colors = {} as Record<ColorKey, string>
  for (const key of colorKeyOrder) {
    let value: Rgba | undefined
    for (const layer of layers) {
      const raw = layer.colors.get(key)
      const expression = project(raw, variant)
      if (expression === undefined) continue
      const result = evaluateExpression(expression)
      if (result.ok) { value = result.color; break }
      warn(layer, '/colors/' + key + (typeof raw === 'string' ? '' : '/' + variant), result)
    }
    if (!value) {
      const fallback = defaultFor(key, variant)
      if (fallback.startsWith('@')) value = values.get(fallback.slice(1) as ColorKey)
      else {
        const result = evaluateExpression(fallback)
        if (result.ok) value = result.color
      }
      if (!value) throw new Error(`The default of ${key} could not be resolved.`)
    }
    const over = colorRegistry[key].opaqueOver
    if (over) value = composite(value, over === 'base' ? variant === 'dark' ? black : white : values.get(over as ColorKey)!)
    values.set(key, value)
  }
  for (const key of colorKeys) colors[key] = canonical(values.get(key)!)

  const editorBackground = values.get('editor.background')!
  const styles = new Map<SqlScope, { foreground?: Rgba; fontStyle?: string }>()
  for (const scope of sqlScopes) {
    const fallback = syntaxDefaults[scope]
    if (!fallback) continue
    const result = evaluateExpression(fallback)
    if (!result.ok) throw new Error(`The default of the ${scope} scope could not be resolved.`)
    styles.set(scope, { foreground: result.color, fontStyle: syntaxFontStyleDefaults[scope] })
  }
  for (const layer of [...layers].reverse()) {
    for (const rule of layer.rules) {
      const style = { ...styles.get(rule.scope) }
      const expression = project(rule.foreground, variant)
      if (expression !== undefined) {
        const result = evaluateExpression(expression)
        if (result.ok) style.foreground = result.color
        else warn(layer, rule.path + '/settings/foreground' + (typeof rule.foreground === 'string' ? '' : '/' + variant), result)
      }
      if (rule.fontStyle !== undefined) style.fontStyle = rule.fontStyle
      styles.set(rule.scope, style)
    }
  }
  const syntax = {} as Record<SqlScope, SyntaxStyle>
  for (const scope of sqlScopes) {
    let foreground: Rgba | undefined, fontStyle: string | undefined
    for (let current: SqlScope | undefined = scope; current && (!foreground || fontStyle === undefined); current = parentScope(current)) {
      const style = styles.get(current)
      foreground ??= style?.foreground
      fontStyle ??= style?.fontStyle
    }
    syntax[scope] = { foreground: opaqueHex(composite(foreground!, editorBackground)), fontStyle: fontStyle ?? '' }
  }

  const palette = new Map<string, string>()
  for (const slot of entries.keys()) {
    const result = evaluateSlot(slot)
    if (result.ok) palette.set(slot, canonical(result.color))
  }
  const nearest = layers[0]
  const theme: ResolvedTheme = { id: nearest?.id ?? builtinThemes[variant].id, name: nearest?.name ?? builtinThemes[variant].name, type: variant, colors, syntax }
  if (!isResolvedTheme(theme)) throw new Error('Theme resolution produced an incomplete theme.')
  return { theme, palette, problems }
}

const builtinCache = new Map<ThemeType, ResolvedTheme>()
/** Varia Dark or Varia Light, resolved once. */
export function resolveBuiltin(variant: ThemeType): ResolvedTheme {
  let theme = builtinCache.get(variant)
  if (!theme) { theme = resolveTheme([], variant).theme; builtinCache.set(variant, theme) }
  return theme
}

/** Checks an untrusted payload: every registry key and scope present and canonical; nothing else is read. */
export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  if (typeof value !== 'object' || value === null) return false
  const theme = value as Record<string, unknown>
  const field = (key: string) => Object.hasOwn(theme, key) ? theme[key] : undefined
  const colors = field('colors'), syntax = field('syntax'), id = field('id'), name = field('name'), type = field('type')
  if (typeof id !== 'string' || !themeIdPattern.test(id) || typeof name !== 'string' || [...name].length > themeLimits.name || (type !== 'dark' && type !== 'light')) return false
  if (typeof colors !== 'object' || colors === null || typeof syntax !== 'object' || syntax === null) return false
  const colorMap = colors as Record<string, unknown>, syntaxMap = syntax as Record<string, unknown>
  for (const key of colorKeys) {
    const color = Object.hasOwn(colorMap, key) ? colorMap[key] : undefined
    if (typeof color !== 'string' || !canonicalColor.test(color)) return false
  }
  for (const scope of sqlScopes) {
    const style = Object.hasOwn(syntaxMap, scope) ? syntaxMap[scope] : undefined
    if (typeof style !== 'object' || style === null) return false
    const foreground = Object.hasOwn(style, 'foreground') ? (style as SyntaxStyle).foreground : undefined
    const fontStyle = Object.hasOwn(style, 'fontStyle') ? (style as SyntaxStyle).fontStyle : undefined
    if (typeof foreground !== 'string' || !canonicalOpaque.test(foreground) || !isFontStyle(fontStyle)) return false
  }
  return true
}
