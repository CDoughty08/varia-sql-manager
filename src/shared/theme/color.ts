import { themePatterns } from './format'
import type { ResolvedTheme } from './types'

/** 8-bit sRGB channels and alpha, 0-255. */
export interface Rgba { r: number; g: number; b: number; a: number }

const hexDigits = new RegExp(themePatterns.hex)
const black: Rgba = { r: 0, g: 0, b: 0, a: 255 }
const white: Rgba = { r: 255, g: 255, b: 255, a: 255 }

/** Parses #rgb, #rgba, #rrggbb and #rrggbbaa (ASCII hex only); anything else is undefined. */
export function parseHex(value: string): Rgba | undefined {
  if (typeof value !== 'string' || value.length > 9 || !hexDigits.test(value)) return undefined
  let digits = value.slice(1)
  if (digits.length <= 4) digits = [...digits].map(digit => digit + digit).join('')
  const channel = (index: number) => parseInt(digits.slice(index * 2, index * 2 + 2), 16)
  return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? channel(3) : 255 }
}

export function hexColor(value: string): Rgba {
  const color = parseHex(value)
  if (!color) throw new Error('Not a hex color: ' + value)
  return color
}

const byte = (value: number) => Math.min(255, Math.max(0, Math.round(value)))
const pair = (value: number) => byte(value).toString(16).padStart(2, '0')

/** Lowercase #rrggbb, or #rrggbbaa below full alpha, rebuilt from the numbers rather than copied from input. */
export function canonical(color: Rgba): string {
  return '#' + pair(color.r) + pair(color.g) + pair(color.b) + (byte(color.a) < 255 ? pair(color.a) : '')
}

export function opaqueHex(color: Rgba): string { return canonical({ ...color, a: 255 }) }

export function alpha(color: Rgba, percent: number): Rgba { return { ...color, a: Math.round(color.a * percent / 100) } }

/** Source-over in 8-bit sRGB, as Chromium paints it. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const f = fg.a / 255
  if (bg.a === 255) return { r: byte(fg.r * f + bg.r * (1 - f)), g: byte(fg.g * f + bg.g * (1 - f)), b: byte(fg.b * f + bg.b * (1 - f)), a: 255 }
  const b = bg.a / 255, out = f + b * (1 - f)
  if (out === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mixChannel = (x: number, y: number) => byte((x * f + y * b * (1 - f)) / out)
  return { r: mixChannel(fg.r, bg.r), g: mixChannel(fg.g, bg.g), b: mixChannel(fg.b, bg.b), a: byte(out * 255) }
}

export function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  const lerp = (x: number, y: number) => byte(x + (y - x) * amount)
  return { r: lerp(from.r, to.r), g: lerp(from.g, to.g), b: lerp(from.b, to.b), a: lerp(from.a, to.a) }
}

const linear = (channel: number) => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of an opaque color. */
export function luminance(color: Rgba): number { return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b) }

/**
 * WCAG 2.x contrast ratio. A translucent foreground is composited over the background first; a translucent background
 * needs the opaque surface it is painted on.
 */
export function contrast(fg: Rgba, bg: Rgba, surface?: Rgba): number {
  let base = bg
  if (base.a < 255) {
    if (!surface || surface.a < 255) throw new Error('A translucent background needs an opaque surface.')
    base = composite(base, surface)
  }
  const a = luminance(composite(fg, base)), b = luminance(base)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** OKLab coordinates of an opaque color (L in 0-1). */
export function oklab(color: Rgba): [number, number, number] {
  const r = linear(color.r), g = linear(color.g), b = linear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/** Euclidean distance in OKLab between two opaque colors. */
export function deltaEOK(x: Rgba, y: Rgba): number {
  const [l1, a1, b1] = oklab(x), [l2, a2, b2] = oklab(y)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/**
 * Moves a custom color toward `toward` in 5% steps (at most 20) until it reaches `minimum` contrast against every
 * opaque surface. Returns the first passing step, otherwise the step with the best worst-case contrast.
 */
export function ensureContrast(color: string, surfaces: readonly string[], minimum: number, toward: string): string {
  const start = { ...hexColor(color), a: 255 }, target = { ...hexColor(toward), a: 255 }
  const backgrounds = surfaces.map(hexColor)
  let best = start, bestScore = -1
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(start, target, step / 20)
    const score = Math.min(...backgrounds.map(surface => contrast(candidate, surface)))
    if (score >= minimum) return opaqueHex(candidate)
    if (score > bestScore) { best = candidate; bestScore = score }
  }
  return opaqueHex(best)
}

/**
 * The native title-bar overlay, in the inactive title bar's color while the window is inactive. Electron reads 8-digit
 * hex as ARGB, so only opaque #rrggbb is returned, and the symbol color falls back to black or white when the theme's
 * choice is unreadable.
 */
export function nativeOverlay(theme: ResolvedTheme, options: { active?: boolean } = {}): { color: string; symbolColor: string } {
  const background = { ...hexColor(theme.colors[options.active === false ? 'titleBar.inactiveBackground' : 'titleBar.activeBackground']), a: 255 }
  const symbol = composite(hexColor(theme.colors['titleBar.controlsForeground']), background)
  const readable = contrast(symbol, background) >= 4.5 ? symbol : contrast(white, background) >= contrast(black, background) ? white : black
  return { color: opaqueHex(background), symbolColor: opaqueHex(readable) }
}
