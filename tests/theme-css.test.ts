import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { colorKeys, colorRegistry, cssVariable, type ColorKey } from '../src/shared/theme/registry'
import { editorFontFamily, monoFontFamily, uiFontFamily } from '../src/renderer/src/fonts'

const rendererDir = 'src/renderer/src'
const stylesheet = readFileSync(join(rendererDir, 'styles.css'), 'utf8')
const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
const sources = readdirSync(rendererDir, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  .map(file => ({ file, code: readFileSync(join(rendererDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1') }))
const fontVariables = ['--varia-font-ui', '--varia-font-mono']
// CSS Color 4 named colors; `transparent` and `currentColor` stay allowed.
const namedColors = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral '
  + 'cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred '
  + 'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite '
  + 'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen '
  + 'lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
  + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue '
  + 'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon '
  + 'sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
  + 'whitesmoke yellow yellowgreen').split(' '))
const colorFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const hexLiteral = /#[0-9a-fA-F]{3,8}\b/
/** Every `prop: value` in the stylesheet, with its rule's selector. */
const declarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) => body.split(';').map(part => part.trim()).filter(Boolean).map(part => {
  const colon = part.indexOf(':')
  return { selector: selector.trim(), property: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() }
}))
const variablesIn = (text: string) => [...text.matchAll(/var\((--varia-[A-Za-z0-9-]+)\)/g)].map(match => match[1])
const keyByVariable = new Map(colorKeys.map(key => [cssVariable(key), key]))

describe('theme tokens in the renderer', () => {
  it('keeps color literals out of styles.css and renderer code', () => {
    const found: string[] = []
    for (const { selector, property, value } of declarations) {
      const words = value.replace(/'[^']*'|"[^"]*"/g, '').toLowerCase().match(/[a-z-]+/g) ?? []
      const named = words.filter(word => namedColors.has(word))
      if (hexLiteral.test(value) || colorFunction.test(value) || named.length) found.push(`styles.css ${selector} { ${property}: ${value} }`)
    }
    // In code, named colors are looked for where styles are written: style properties and SVG/JSX color attributes.
    const styleValues = /\b(?:color|background\w*|border\w*|outline\w*|fill|stroke|boxShadow|accentColor|caretColor|textDecorationColor|stopColor)\s*[:=]\s*\{?\s*(['"`])((?:(?!\1).)*)\1/gi
    for (const { file, code } of sources) {
      for (const match of code.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)) found.push(`${file}: ${match[0]}`)
      for (const match of code.matchAll(styleValues)) if ((match[2].toLowerCase().match(/[a-z]+/g) ?? []).some(word => namedColors.has(word))) found.push(`${file}: ${match[0]}`)
    }
    expect(found, 'Use var(--varia-*) and add a key to src/shared/theme/registry.ts instead:\n' + found.join('\n')).toEqual([])
  })
  it('refers only to registry keys and the font variables', () => {
    const unknown = [...variablesIn(css), ...sources.flatMap(({ code }) => variablesIn(code))].filter(name => !keyByVariable.has(name) && !fontVariables.includes(name))
    expect(unknown).toEqual([])
    // Colors are set at runtime from the registry; the stylesheet only defines the fixed font stacks.
    const defined = declarations.filter(({ property }) => property.startsWith('--varia-')).map(({ property }) => property)
    expect(defined).toEqual(fontVariables)
  })
  it('uses every key the registry assigns to CSS, and no others', () => {
    const used = new Set(variablesIn(css).map(name => keyByVariable.get(name)).filter((key): key is ColorKey => !!key))
    const declared = colorKeys.filter(key => colorRegistry[key].consumers.includes('css'))
    expect(declared.filter(key => !used.has(key)), 'keys with consumer css that styles.css never uses').toEqual([])
    expect([...used].filter(key => !colorRegistry[key].consumers.includes('css')), 'keys used by styles.css without consumer css').toEqual([])
    const scripted = new Set(sources.flatMap(({ code }) => variablesIn(code)).map(name => keyByVariable.get(name)))
    for (const key of scripted) if (key) expect(colorRegistry[key].consumers, key).toContain('script')
  })
  it('overrides every Dockview theme color on the shell, where floating groups inherit it', () => {
    const dockview = readFileSync('node_modules/dockview-react/dist/styles/dockview.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const colorValue = (value: string) => !value.startsWith('var(') && (hexLiteral.test(value) || colorFunction.test(value) || (value.toLowerCase().match(/[a-z-]+/g) ?? []).some(word => namedColors.has(word) || word === 'transparent'))
    // Tab-group chips are unused, and the floating title bar derives from the variables below.
    const excluded = (name: string) => name.startsWith('--dv-tab-group-color-') || name.startsWith('--dv-floating-titlebar-')
    const themed = new Set([...dockview.matchAll(/(?:^|\})\s*\.dockview-theme-(?:dark|light)\s*\{([^{}]*)\}/g)].flatMap(([, body]) => [...body.matchAll(/(--dv-[a-z0-9-]+)\s*:\s*([^;]+);/g)])
      .filter(([, name, value]) => !excluded(name) && colorValue(value.trim())).map(([, name]) => name))
    expect(themed.size).toBeGreaterThan(20)
    const shell = declarations.filter(({ selector }) => selector === '.varia-dock.dockview-theme-dark, .varia-dock.dockview-theme-light')
    const overridden = new Set(shell.map(({ property }) => property))
    expect([...themed].filter(name => !overridden.has(name))).toEqual([])
    for (const { property, value } of shell) expect(variablesIn(value).length, `${property}: ${value}`).toBeGreaterThan(0)
    // Only sizes stay on the workbench element; colors there would not reach floating groups.
    const workbench = declarations.filter(({ selector }) => selector === '.dock-workbench')
    expect(workbench.map(({ property }) => property).sort()).toEqual(['--dv-floating-titlebar-height', '--dv-paneview-header-height', '--dv-tab-font-size', '--dv-tabs-and-actions-container-height'])
  })
  it('matches the font stacks in fonts.ts and keeps the Windows fonts first', () => {
    const root = new Map(declarations.filter(({ selector }) => selector === ':root').map(({ property, value }) => [property, value]))
    expect(root.get('--varia-font-ui')).toBe(uiFontFamily)
    expect(root.get('--varia-font-mono')).toBe(monoFontFamily)
    expect(uiFontFamily.startsWith("'Segoe UI', ")).toBe(true)
    expect(monoFontFamily.startsWith('Consolas, ')).toBe(true)
    expect(editorFontFamily.startsWith("'Cascadia Code', Consolas, ")).toBe(true)
    for (const stack of [uiFontFamily, monoFontFamily, editorFontFamily]) expect(stack).toMatch(/, (sans-serif|monospace)$/)
    const families = declarations.filter(({ property, value }) => /^font(-family)?$/.test(property) && !value.includes('var(--varia-font-') && value !== 'inherit')
    expect(families.map(({ selector, value }) => `${selector} { ${value} }`)).toEqual([])
  })
})
