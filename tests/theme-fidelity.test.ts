import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrast, hexColor, oklab, type Rgba } from '../src/shared/theme/color'
import { builtinPalettes, type PaletteSlot } from '../src/shared/theme/palette'
import { colorKeys, defaultFor } from '../src/shared/theme/registry'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import type { ThemeType } from '../src/shared/theme/types'

const types: ThemeType[] = ['dark', 'light']
const slot = (type: ThemeType, name: PaletteSlot) => hexColor(builtinPalettes[type][name])
const chroma = (color: Rgba) => { const [, a, b] = oklab(color); return Math.hypot(a, b) }
const hue = (color: Rgba) => { const [, a, b] = oklab(color); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 }
const hueDistance = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y))
const deltaE = (x: Rgba, y: Rgba) => { const [l1, a1, b1] = oklab(x), [l2, a2, b2] = oklab(y); return Math.hypot(l1 - l2, a1 - a2, b1 - b2) }

// Machado, Oliveira and Fernandes (2009) at full severity, applied to linear RGB.
const deficiencies = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]]
}
const toLinear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const toSrgb = (value: number) => { const c = Math.min(1, Math.max(0, value)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255) }
function simulate(color: Rgba, matrix: readonly (readonly number[])[]): Rgba {
  const linear = [toLinear(color.r), toLinear(color.g), toLinear(color.b)]
  const [r, g, b] = matrix.map(row => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]).map(toSrgb)
  return { r, g, b, a: 255 }
}

/** The shell's slots: graphite, so the accent is the only hue the chrome shows. */
const neutralSlots: PaletteSlot[] = ['canvas', 'panel', 'sideBar', 'chrome', 'raised', 'overlay', 'input', 'hover', 'active', 'text', 'textStrong', 'textSecondary',
  'textTertiary', 'textMuted', 'border', 'borderSubtle', 'borderStrong', 'separator', 'icon', 'iconMuted', 'neutral', 'syntaxIdentifier', 'syntaxOperator',
  'syntaxDelimiter', 'syntaxComment']
const accentSlots: PaletteSlot[] = ['accent', 'accentHover', 'focus', 'textAccent', 'onAccent', 'accentSurface', 'selection', 'selectionStrong', 'textSelection']
const chartSlots: PaletteSlot[] = ['chart1', 'chart2', 'chart3', 'chart4', 'chart5']

describe('Calm Pro fidelity', () => {
  it('keeps the neutrals graphite in both themes', () => {
    // These reach OKLCH chroma 0.024; the navy palette they replaced reached 0.046.
    const tinted = types.flatMap(type => neutralSlots.filter(name => chroma(slot(type, name)) > 0.025).map(name => `${type} ${name} ${builtinPalettes[type][name]}: chroma ${chroma(slot(type, name)).toFixed(4)}`))
    expect(tinted, tinted.join('\n')).toEqual([])
  })
  it('has one accent hue, and keeps status colors well away from it', () => {
    for (const type of types) {
      const accent = hue(slot(type, 'accent'))
      for (const name of accentSlots.filter(name => chroma(slot(type, name)) > 0.01)) expect(hueDistance(hue(slot(type, name)), accent), `${type} ${name}`).toBeLessThanOrEqual(10)
      for (const name of ['error', 'warning', 'success'] as const) expect(hueDistance(hue(slot(type, name)), accent), `${type} ${name}`).toBeGreaterThanOrEqual(60)
    }
  })
  it('gives charts five categorical colors that stay apart with color-vision deficiencies and read on their surfaces', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type), series = chartSlots.map(name => slot(type, name))
      for (let i = 0; i < series.length; i++) {
        for (const surface of ['editor.background', 'editorWidget.background', 'panel.background'] as const) {
          expect(contrast(series[i], hexColor(theme.colors[surface])), `${type} ${chartSlots[i]} on ${surface}`).toBeGreaterThanOrEqual(3)
        }
        for (let j = i + 1; j < series.length; j++) expect(deltaE(series[i], series[j]), `${type} ${chartSlots[i]} and ${chartSlots[j]}`).toBeGreaterThanOrEqual(0.09)
      }
      // Neighbouring series meet in stacked and multi-line charts, so they must differ for every viewer.
      for (let i = 0; i + 1 < series.length; i++) {
        expect(deltaE(series[i], series[i + 1]), `${type} ${chartSlots[i]} next to ${chartSlots[i + 1]}`).toBeGreaterThanOrEqual(0.15)
        for (const [name, matrix] of Object.entries(deficiencies)) {
          expect(deltaE(simulate(series[i], matrix), simulate(series[i + 1], matrix)), `${type} ${name}: ${chartSlots[i]} next to ${chartSlots[i + 1]}`).toBeGreaterThanOrEqual(0.075)
        }
      }
    }
    // Series colors never stand for state or a connection: no status or connection key refers to them.
    const users = colorKeys.filter(key => types.some(type => chartSlots.some(name => defaultFor(key, type).startsWith('$' + name))))
    expect(users.filter(key => !key.startsWith('charts.'))).toEqual([])
  })
  it('draws NULL as muted italic text without a fill', () => {
    for (const type of types) {
      const theme = resolveBuiltin(type)
      expect(theme.colors['resultsGrid.nullForeground']).toBe(builtinPalettes[type].textMuted)
      expect(hexColor(theme.colors['resultsGrid.nullBackground']).a).toBe(0)
    }
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).toMatch(/^\.rg-c\.is-null \{[^}]*\bfont-style: italic;[^}]*\}$/m)
  })
  it('tints the status bar only while a query runs or the backend is down', () => {
    for (const type of types) {
      const { colors } = resolveBuiltin(type)
      expect(colors['statusBar.background']).toBe(colors['titleBar.activeBackground'])
      expect(colors['statusBar.disconnectedBackground']).toBe(colors['statusBar.background'])
      expect(colors['statusBar.executingBackground']).not.toBe(colors['statusBar.background'])
      expect(colors['statusBar.errorBackground']).not.toBe(colors['statusBar.background'])
    }
  })
  it('marks a value that could not be read with more than color, apart from NULL', () => {
    // Both read "NULL"; hue alone would leave them alike for color-blind readers and in screenshots.
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const rule = (selector: string) => {
      const body = css.split('\n').find(line => line.startsWith(selector + ' {')) ?? ''
      return { fontStyle: body.match(/font-style: ([^;]+);/)?.[1] ?? 'normal', decoration: body.match(/text-decoration: ([^;]+);/)?.[1] ?? 'none' }
    }
    const nulls = rule('.rg-c.is-null'), errors = rule('.rg-c.is-err')
    expect(nulls).toEqual({ fontStyle: 'italic', decoration: 'none' })
    expect(errors.fontStyle).not.toBe(nulls.fontStyle)
    expect(errors.decoration).not.toBe(nulls.decoration)
  })
  it('separates the neutral status bar from the panes above it, and makes its executing tint noticeable', () => {
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).toMatch(/^\.status-bar \{[^}]*\bborder-top: 1px solid var\(--varia-statusBar-border\);[^}]*\}$/m)
    for (const type of types) {
      const { colors } = resolveBuiltin(type), color = (key: keyof typeof colors) => hexColor(colors[key])
      // As noticeable as the other chrome borders, which pass 1.15:1 on the surfaces they divide.
      for (const surface of ['statusBar.background', 'editor.background', 'sideBar.background', 'panel.background'] as const) {
        expect(contrast(color('statusBar.border'), color(surface)), `${type} statusBar.border on ${surface}`).toBeGreaterThanOrEqual(1.15)
      }
      // The tint is the only change of fill that says a query runs, so it is held to the hover floor at least.
      expect(contrast(color('statusBar.executingBackground'), color('statusBar.background')), `${type} status bar`).toBeGreaterThanOrEqual(1.2)
      expect(contrast(color('queryStatusBar.executingBackground'), color('queryStatusBar.background')), `${type} query status bar`).toBeGreaterThanOrEqual(1.2)
    }
  })
})
