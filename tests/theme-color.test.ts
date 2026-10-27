import { describe, expect, it } from 'vitest'
import { alpha, canonical, composite, contrast, deltaEOK, ensureContrast, hexColor, nativeOverlay, parseHex } from '../src/shared/theme/color'
import { connectionAccent, connectionAccentSurfaces, connectionPresets } from '../src/shared/theme/connection-colors'
import { isColorText, parseThemeValue, themePatterns } from '../src/shared/theme/format'
import { builtinPalettes } from '../src/shared/theme/palette'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import type { ThemeType } from '../src/shared/theme/types'

const types: ThemeType[] = ['dark', 'light']

describe('theme color math', () => {
  it('parses every hex length, doubles short nibbles, and rebuilds canonical lowercase output', () => {
    expect(parseHex('#fA0')).toEqual({ r: 255, g: 170, b: 0, a: 255 })
    expect(parseHex('#fA08')).toEqual({ r: 255, g: 170, b: 0, a: 136 })
    expect(parseHex('#11151C')).toEqual({ r: 17, g: 21, b: 28, a: 255 })
    expect(parseHex('#11151c80')).toEqual({ r: 17, g: 21, b: 28, a: 128 })
    expect(canonical(hexColor('#ABCDEFFF'))).toBe('#abcdef')
    expect(canonical(hexColor('#0009'))).toBe('#00000099')
    expect(canonical({ r: 300, g: -4, b: 12.6, a: 254.6 })).toBe('#ff000d')
    for (const bad of ['', '#', '#12', '#12345', '#1234567', '#123456789', '#ggg', '＃fff', ' #fff', '#fff ', '#fff\n', 'fff']) expect(parseHex(bad), bad).toBeUndefined()
  })
  it('rounds alpha percentages and composites in 8-bit sRGB', () => {
    const accent = hexColor('#8fb7ff')
    expect(canonical(alpha(accent, 6))).toBe('#8fb7ff0f')
    expect(canonical(alpha(accent, 20))).toBe('#8fb7ff33')
    expect(canonical(alpha(hexColor('#8a9cb3'), 70))).toBe('#8a9cb3b3')
    expect(canonical(alpha(hexColor('#d9e1ec'), 3))).toBe('#d9e1ec08')
    expect(canonical(alpha(hexColor('#00000080'), 50))).toBe('#00000040')
    expect(canonical(composite(alpha(accent, 6), hexColor('#11151c')))).toBe('#181f29')
    expect(canonical(composite(alpha(hexColor('#005fb8'), 6), hexColor('#ffffff')))).toBe('#f0f6fb')
    expect(canonical(composite(alpha(hexColor('#8a9cb3'), 80), hexColor('#11151c')))).toBe('#728195')
    expect(canonical(composite(hexColor('#ff000080'), hexColor('#0000ff80')))).toBe('#aa0055c0')
    expect(composite(hexColor('#00000000'), hexColor('#00000000')).a).toBe(0)
  })
  it('computes WCAG contrast, compositing translucent colors first', () => {
    expect(contrast(hexColor('#000'), hexColor('#fff'))).toBeCloseTo(21, 6)
    expect(contrast(hexColor('#767676'), hexColor('#fff'))).toBeCloseTo(4.54, 2)
    expect(contrast(hexColor('#fff'), hexColor('#fff'))).toBe(1)
    expect(contrast(hexColor('#00000080'), hexColor('#fff'))).toBeCloseTo(contrast(hexColor('#7f7f7f'), hexColor('#fff')), 6)
    expect(contrast(hexColor('#fff'), hexColor('#00000080'), hexColor('#fff'))).toBeCloseTo(contrast(hexColor('#fff'), hexColor('#7f7f7f')), 6)
    expect(() => contrast(hexColor('#fff'), hexColor('#00000080'))).toThrow('opaque surface')
  })
  it('measures OKLab distance', () => {
    expect(deltaEOK(hexColor('#fff'), hexColor('#fff'))).toBe(0)
    expect(deltaEOK(hexColor('#000'), hexColor('#fff'))).toBeCloseTo(1, 3)
    expect(deltaEOK(hexColor('#11151c'), hexColor('#11151d'))).toBeLessThan(0.01)
  })
})

describe('theme value grammar', () => {
  it('accepts exactly hex colors and palette references', () => {
    for (const good of ['#fff', '#ffff', '#ffffff', '#ffffff80', '#ABCDEF', '$accent', '$accent/0', '$accent/7', '$accent/20', '$accent/100', '$nord0', '$a' + 'b'.repeat(31)]) expect(isColorText(good), good).toBe(true)
  })
  it.each([
    'url(x)', 'var(--a)', 'expression(1)', '#fff;}body{', 'red', 'rgb(0,0,0)', 'hsl(0 0% 0%)', '#12345', '＃fff', ' #fff', '#fff ', '#fff\n',
    '$a/101', '$a/01', '$a/-1', '$a/', '$__proto__', '$Accent', '$a-b', '$a' + 'b'.repeat(32), '@editor.background', 'transparent', ''
  ])('rejects %j', value => {
    expect(isColorText(value)).toBe(false)
    expect(parseThemeValue(value, 'dual')).toMatchObject({ ok: false, code: 'W_VALUE' })
  })
  // Kept out of the table above, whose titles would carry the whole megabyte.
  it('rejects a 1 MB string', () => {
    expect(isColorText('x'.repeat(1_000_000))).toBe(false)
    expect(parseThemeValue('x'.repeat(1_000_000), 'dual')).toMatchObject({ ok: false, code: 'W_VALUE' })
  })
  it('rejects non-strings and malformed variant objects', () => {
    for (const value of [null, 1, true, ['#fff'], {}, { dark: '#fff', other: '#000' }, { dark: 'red' }, { dark: { dark: '#fff' } }]) expect(parseThemeValue(value, 'dual').ok, JSON.stringify(value)).toBe(false)
    expect(parseThemeValue({ dark: '#fff' }, 'dual')).toEqual({ ok: true, value: { dark: '#fff' } })
    expect(parseThemeValue({ light: '$accent/20', dark: '#000' }, 'dual')).toEqual({ ok: true, value: { light: '$accent/20', dark: '#000' } })
    expect(parseThemeValue({ dark: '#fff' }, 'dark')).toMatchObject({ ok: false, code: 'W_VARIANT_NOT_DUAL' })
  })
  it('rejects a long input before running any pattern', () => {
    const started = performance.now()
    expect(isColorText('#'.repeat(1_000_000))).toBe(false)
    expect(isColorText('$' + 'a'.repeat(1_000_000))).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
    expect(themePatterns.hex.startsWith('^') && themePatterns.hex.endsWith('$')).toBe(true)
  })
})

describe('contrast repair and window chrome', () => {
  // Deterministic LCG so failures reproduce.
  function random(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 }
  it('moves 300 seeded custom colors to 3:1 on both built-ins, always terminating', () => {
    const next = random(42)
    for (const type of types) {
      const theme = resolveBuiltin(type)
      const surfaces = connectionAccentSurfaces.map(key => theme.colors[key])
      for (let index = 0; index < 300; index++) {
        const color = canonical({ r: Math.floor(next() * 256), g: Math.floor(next() * 256), b: Math.floor(next() * 256), a: 255 })
        const repaired = ensureContrast(color, surfaces, 3, theme.colors.foreground)
        expect(repaired).toMatch(/^#[0-9a-f]{6}$/)
        for (const surface of surfaces) expect(contrast(hexColor(repaired), hexColor(surface)), `${type} ${color} -> ${repaired} on ${surface}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
  it('keeps a passing color, and returns the best step when 3:1 is unreachable', () => {
    expect(ensureContrast('#ffffff', ['#000000'], 3, '#000000')).toBe('#ffffff')
    // 21:1 against both black and white is impossible; 10% toward black has the best worst case (4.42:1).
    expect(ensureContrast('#808080', ['#000000', '#ffffff'], 21, '#000000')).toBe('#737373')
  })
  it('maps preset connection colors to theme variables and repairs custom ones', () => {
    expect(connectionPresets.map(preset => [preset.label, preset.stored])).toEqual([['Red', '#e66b73'], ['Orange', '#e6a15c'], ['Yellow', '#dec766'], ['Green', '#79bb8b'], ['Blue', '#71a7df'], ['Purple', '#ad8bd8']])
    // Saved profiles hold these first Varia Dark values; they must not follow later palette changes.
    for (const preset of connectionPresets) expect(builtinPalettes.dark[preset.name]).not.toBe(preset.stored)
    const light = resolveBuiltin('light'), dark = resolveBuiltin('dark')
    expect(connectionAccent('#E66B73', light)).toBe('var(--varia-connection-red)')
    expect(connectionAccent('#71a7df', dark)).toBe('var(--varia-connection-blue)')
    expect(connectionAccent(undefined, dark)).toBeUndefined()
    expect(connectionAccent('', dark)).toBeUndefined()
    expect(connectionAccent('red', dark)).toBeUndefined()
    expect(connectionAccent('#123456', dark)).not.toBe('#123456')
    const repaired = connectionAccent('#fafafa', light)!
    for (const key of connectionAccentSurfaces) expect(contrast(hexColor(repaired), hexColor(light.colors[key]))).toBeGreaterThanOrEqual(3)
    expect(connectionAccent('#e66b74', dark)).toBe('#e66b74')
  })
  it('repairs custom colors on every status bar state the connection edge is drawn on', () => {
    // The status bar's top border and the query status bar's edge stay while a query runs, fails or is disconnected.
    const drawnOn = ['statusBar.background', 'statusBar.executingBackground', 'statusBar.disconnectedBackground', 'statusBar.errorBackground',
      'queryStatusBar.background', 'queryStatusBar.executingBackground', 'queryStatusBar.errorBackground'] as const
    for (const key of drawnOn) expect(connectionAccentSurfaces).toContain(key)
    for (const [type, colors] of [['dark', ['#2a3460', '#202840']], ['light', ['#f0d8a0', '#9aa5ff', '#d0d4ff', '#a0a0a0']]] as const) {
      const theme = resolveBuiltin(type)
      for (const color of colors) {
        const repaired = connectionAccent(color, theme)!
        for (const key of drawnOn) expect(contrast(hexColor(repaired), hexColor(theme.colors[key])), `${type} ${color} -> ${repaired} on ${key}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
  it('only hands Electron opaque colors, and keeps window symbols readable', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type)
      expect(nativeOverlay(theme)).toEqual({ color: theme.colors['titleBar.activeBackground'], symbolColor: theme.colors['titleBar.controlsForeground'] })
    }
    expect(nativeOverlay(resolveBuiltin('light'))).toEqual({ color: '#f7f8fa', symbolColor: '#1c1f26' })
    const dark = resolveBuiltin('dark')
    const lowContrast = { ...dark, colors: { ...dark.colors, 'titleBar.activeBackground': '#202020', 'titleBar.controlsForeground': '#303030' } }
    expect(nativeOverlay(lowContrast)).toEqual({ color: '#202020', symbolColor: '#ffffff' })
    const pale = { ...dark, colors: { ...dark.colors, 'titleBar.activeBackground': '#f0f0f080', 'titleBar.controlsForeground': '#ffffff80' } }
    expect(nativeOverlay(pale)).toEqual({ color: '#f0f0f0', symbolColor: '#000000' })
  })
  it('colors the overlay like the inactive title bar while the window is inactive, keeping the symbols readable', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type)
      // Built-in themes keep one title bar color; a theme can give the inactive one its own.
      expect(nativeOverlay(theme, { active: false })).toEqual(nativeOverlay(theme))
      expect(theme.colors['titleBar.inactiveBackground']).toMatch(/^#[0-9a-f]{6}$/)
    }
    const dark = resolveBuiltin('dark')
    const inactive = { ...dark, colors: { ...dark.colors, 'titleBar.inactiveBackground': '#f4f4f4', 'titleBar.controlsForeground': '#d9e1ec' } }
    expect(nativeOverlay(inactive, { active: false })).toEqual({ color: '#f4f4f4', symbolColor: '#000000' })
    expect(nativeOverlay(inactive, { active: true })).toEqual({ color: dark.colors['titleBar.activeBackground'], symbolColor: '#d9e1ec' })
  })
})
