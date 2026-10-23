import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codiconClass, codiconIcons, iconIds, iconSpec, iconStroke, isIconId, renderIconDocs, svgIcons, type SvgIconId } from '../src/shared/icons'

const rendererDir = 'src/renderer/src'
const sources = readdirSync(rendererDir, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  .map(file => ({ file: file.replace(/\\/g, '/'), code: readFileSync(join(rendererDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1') }))

interface PathShape {
  /** Every point the outline can reach: ends, control points, and each arc's whole ellipse. */
  readonly extent: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
  /** The fixed coordinate of each horizontal or vertical line. */
  readonly axisLines: readonly number[]
  readonly problems: readonly string[]
}

/** Reads an SVG path's geometry (absolute and relative M, L, H, V, C, S, Q, T, A, Z), without rotated arcs. */
function readPath(d: string): PathShape {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const problems: string[] = [], axisLines: number[] = []
  if (tokens.join('').replace(/[\s,-]/g, '') !== d.replace(/[\s,-]/g, '')) problems.push('unreadable characters')
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const reach = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  let x = 0, y = 0, startX = 0, startY = 0, index = 0, command = ''
  const number = () => {
    const token = tokens[index++]
    if (token === undefined || /[A-Za-z]/.test(token)) { problems.push(`missing number after ${command}`); return 0 }
    return Number(token)
  }
  const lineTo = (nextX: number, nextY: number) => {
    if (nextX === x && nextY !== y) axisLines.push(x)
    else if (nextY === y && nextX !== x) axisLines.push(y)
    x = nextX; y = nextY; reach(x, y)
  }
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) command = tokens[index++]
    else if (!command || /[Zz]/.test(command)) { problems.push('a number without a command'); break }
    const relative = command === command.toLowerCase(), dx = relative ? x : 0, dy = relative ? y : 0
    switch (command.toUpperCase()) {
      case 'M': x = number() + dx; y = number() + dy; startX = x; startY = y; reach(x, y); command = relative ? 'l' : 'L'; break
      case 'L': { const nextX = number() + dx; lineTo(nextX, number() + dy); break }
      case 'H': lineTo(number() + dx, y); break
      case 'V': lineTo(x, number() + dy); break
      case 'C': for (let point = 0; point < 3; point++) { const px = number() + dx, py = number() + dy; reach(px, py); if (point === 2) { x = px; y = py } } break
      case 'S': case 'Q': for (let point = 0; point < 2; point++) { const px = number() + dx, py = number() + dy; reach(px, py); if (point === 1) { x = px; y = py } } break
      case 'T': x = number() + dx; y = number() + dy; reach(x, y); break
      case 'A': {
        let rx = Math.abs(number()), ry = Math.abs(number())
        const rotation = number(), large = number(), sweep = number(), endX = number() + dx, endY = number() + dy
        if (rotation !== 0) problems.push('a rotated arc')
        // The centre, as SVG 1.1's implementation notes (F.6.5) derive it, with radii scaled up when too small.
        const hx = (x - endX) / 2, hy = (y - endY) / 2, scale = hx * hx / (rx * rx) + hy * hy / (ry * ry)
        if (scale > 1) { rx *= Math.sqrt(scale); ry *= Math.sqrt(scale) }
        const sign = large === sweep ? -1 : 1
        const factor = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * hy * hy - ry * ry * hx * hx) / (rx * rx * hy * hy + ry * ry * hx * hx)))
        const cx = factor * rx * hy / ry + (x + endX) / 2, cy = -factor * ry * hx / rx + (y + endY) / 2
        // The ellipse's leftmost, topmost, rightmost and bottommost points that the arc sweeps through.
        const from = Math.atan2((y - cy) / ry, (x - cx) / rx)
        let turn = Math.atan2((endY - cy) / ry, (endX - cx) / rx) - from
        if (sweep && turn < 0) turn += 2 * Math.PI
        if (!sweep && turn > 0) turn -= 2 * Math.PI
        for (let quarter = -4; quarter <= 4; quarter++) {
          const along = (quarter * Math.PI / 2 - from) * Math.sign(turn)
          if (along > 0 && along < Math.abs(turn)) reach(cx + rx * Math.cos(quarter * Math.PI / 2), cy + ry * Math.sin(quarter * Math.PI / 2))
        }
        x = endX; y = endY; reach(x, y)
        break
      }
      case 'Z': lineTo(startX, startY); break
    }
  }
  return { extent: { minX, minY, maxX, maxY }, axisLines, problems }
}

describe('icon registry', () => {
  it('keeps docs/icons.md in sync', async () => {
    // Regenerate after changing icons.ts: npx vitest run tests/icons.test.ts -u
    await expect(renderIconDocs()).toMatchFileSnapshot('../docs/icons.md')
  })
  it('names each icon once, and only its own ids', () => {
    expect(new Set(iconIds).size).toBe(iconIds.length)
    // A Varia icon replaces the codicon of its name, so the codicon list must not name it as well.
    expect(codiconIcons.filter(id => Object.hasOwn(svgIcons, id))).toEqual([])
    for (const id of iconIds) expect(id, id).toMatch(/^[a-z]+(-[a-z]+)*$/)
    expect(iconSpec('server')?.source).toBe('svg')
    expect(iconSpec('folder')).toEqual({ source: 'codicon' })
    for (const value of ['__proto__', 'toString', 'constructor', 'svg:server', 'Server', '', 1, null, undefined]) {
      expect(isIconId(value), String(value)).toBe(false)
      if (typeof value === 'string') expect(iconSpec(value), value).toBeUndefined()
    }
    expect(codiconClass('loading')).toBe('codicon codicon-loading')
  })
  it('uses codicons that exist in the bundled font', async () => {
    // Untyped Monaco internals: loading the library registers every codicon with codiconsUtil.
    const library = 'monaco-editor/base/common/codiconsLibrary.js', util = 'monaco-editor/base/common/codiconsUtil.js'
    await import(library)
    const { getCodiconFontCharacters } = await import(util) as { getCodiconFontCharacters(): Record<string, number> }
    const characters = getCodiconFontCharacters()
    expect(codiconIcons.filter(id => !Object.hasOwn(characters, id))).toEqual([])
  })
  it('draws Varia\'s icons to codicon metrics: inside the 16 px grid\'s live area, with straight lines on half pixels', () => {
    expect(iconStroke).toBe(1)
    for (const id of Object.keys(svgIcons) as SvgIconId[]) {
      const { extent, axisLines, problems } = readPath(svgIcons[id].path)
      expect(problems, id).toEqual([])
      // With the stroke's half width, nothing is drawn outside 1-15 px.
      const inset = 1 + iconStroke / 2
      expect([extent.minX, extent.minY].every(value => value >= inset - 1e-9), `${id} starts at ${extent.minX}, ${extent.minY}`).toBe(true)
      expect([extent.maxX, extent.maxY].every(value => value <= 16 - inset + 1e-9), `${id} ends at ${extent.maxX}, ${extent.maxY}`).toBe(true)
      // A 1 px line centred on a half pixel covers whole pixels, so it stays sharp at 100 % zoom.
      expect(axisLines.filter(value => Math.abs((value % 1) - 0.5) > 1e-9), id).toEqual([])
    }
    // The reader itself: an arc counts as far as it sweeps, and a line off the half pixel is found.
    const round = (shape: PathShape) => Object.values(shape.extent).map(value => Math.round(value * 1000) / 1000)
    expect(round(readPath('M5 8a3 3 0 1 1 6 0 3 3 0 1 1-6 0Z'))).toEqual([5, 5, 11, 11])
    expect(round(readPath('M5 8a3 3 0 0 1 6 0'))).toEqual([5, 5, 11, 8])
    expect(readPath('M2 2h4').axisLines).toEqual([2])
    expect(readPath('M2 2x4').problems.length).toBeGreaterThan(0)
  })
  it('is the only way the renderer draws an icon', () => {
    // Icon.tsx renders the registry; codiconClass covers Monaco decorations and elements that are the glyph themselves.
    // The docking guides are drop-target diagrams, not icons.
    const own = new Set(['Icon.tsx']), diagrams = new Set(['docking-guides.ts'])
    const classes = sources.filter(({ file, code }) => !own.has(file) && /codicon-/.test(code)).map(({ file }) => file)
    expect(classes, 'use <Icon name> or codiconClass() from src/shared/icons.ts').toEqual([])
    const svgs = sources.filter(({ file, code }) => !own.has(file) && !diagrams.has(file) && /<svg\b|createElementNS\(/.test(code)).map(({ file }) => file)
    expect(svgs, 'add the icon to src/shared/icons.ts').toEqual([])
    // Text glyphs standing in for icons (stars, crosses, arrows, refresh) are icons too: the arrows, technical symbols,
    // geometric shapes, miscellaneous symbols and dingbats blocks, and ×. Key names (⌘ ⌥ ⇧ ⌃) are text.
    const symbol = /[×←-⇿⌀-⏿■-➿⟰-⟿⤀-⥿⬀-⯿]/u, keys = new Set(['⌘', '⌥', '⇧', '⌃'])
    const glyph = new RegExp(String.raw`>\s*\{?[^<>{}]*?['"]?(${symbol.source})['"]?`, 'gu')
    const glyphs = sources.flatMap(({ file, code }) => [...code.matchAll(glyph)].filter(match => !keys.has(match[1])).map(match => `${file}: ${match[1]}`))
    expect(glyphs).toEqual([])
    // The lint itself: the glyphs that slipped past it once are found.
    expect(['<button>↻</button>', "<button>{busy ? '…' : '⟳'}</button>", '<span>★</span>'].map(text => [...text.matchAll(glyph)].map(match => match[1]))).toEqual([['↻'], ['⟳'], ['★']])
  })
  it('loads in plain Node 24, as the catalogues that name icons do', () => {
    const file = join('src', 'shared', 'icons.ts')
    expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })).not.toThrow()
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)})`], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
