import { describe, expect, it } from 'vitest'
import { themeLimits, themePatterns } from '../src/shared/theme/format'
import { paletteSlots } from '../src/shared/theme/palette'
import { colorKeys, scopeAliases, sqlScopes } from '../src/shared/theme/registry'
import { buildThemeJsonSchema, renderTokenDocs } from '../src/shared/theme/schema'

// Regenerate after changing the palette or registry: npx vitest run tests/theme-schema.test.ts -u
describe('generated theme documentation', () => {
  const schema = buildThemeJsonSchema()
  it('keeps docs/themes/varia-theme.schema.json and tokens.md in sync', async () => {
    await expect(JSON.stringify(schema, null, 2) + '\n').toMatchFileSnapshot('../docs/themes/varia-theme.schema.json')
    await expect(renderTokenDocs()).toMatchFileSnapshot('../docs/themes/tokens.md')
  })
  it('describes every slot and key with its defaults', () => {
    const { palette, colors } = schema.properties
    expect(Object.keys(palette.properties)).toEqual(paletteSlots)
    expect(Object.keys(colors.properties)).toEqual(colorKeys)
    for (const entry of [...Object.values(palette.properties), ...Object.values(colors.properties)]) {
      expect(entry.$ref).toBe('#/definitions/value')
      expect(entry.markdownDescription).toMatch(/\S.*Dark `#[0-9a-f]{6,8}`.*Light `#[0-9a-f]{6,8}`/)
      expect(entry.description).not.toContain('`')
    }
    expect(colors.properties['focusBorder'].markdownDescription).toBe('(VS Code) Focus ring around the focused control. Default `$focus` (Dark `#76acff`, Light `#005fb8`).')
    expect(colors.properties['statusBar.executingBackground'].markdownDescription).toContain('(Varia)')
    expect(colors.properties['notifications.background'].markdownDescription).toContain('Not used yet; reserved for notifications.')
    expect(colors.properties['resultsGrid.hoverBackground'].markdownDescription).not.toContain('Not used yet')
    const docs = renderTokenDocs()
    for (const name of [...paletteSlots, ...colorKeys, ...sqlScopes, ...scopeAliases.keys()]) expect(docs).toContain('| `' + name + '` |')
  })
  it('uses the same patterns and limits as the runtime parser', () => {
    const { definitions, properties } = schema
    expect(definitions.hex.pattern).toBe(themePatterns.hex)
    expect(definitions.ref.pattern).toBe(themePatterns.ref)
    expect(definitions.tokenRule.properties.settings.properties.fontStyle.pattern).toBe(themePatterns.fontStyle)
    expect(properties.palette.propertyNames.pattern).toBe(themePatterns.slot)
    expect([definitions.ref.maxLength, properties.palette.maxProperties, properties.colors.maxProperties, properties.tokenColors.maxItems, properties.name.maxLength])
      .toEqual([themeLimits.valueLength, themeLimits.palette, themeLimits.colors, themeLimits.tokenRules, themeLimits.name])
    for (const key of colorKeys) expect(new RegExp(themePatterns.colorKey).test(key) && key.length <= themeLimits.colorKeyLength, key).toBe(true)
    for (const slot of paletteSlots) expect(new RegExp(themePatterns.slot).test(slot), slot).toBe(true)
  })
  it('only refers to definitions it contains', () => {
    const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"#\/definitions\/([A-Za-z]+)"/g)].map(match => match[1])
    expect(refs.length).toBeGreaterThan(238)
    for (const ref of new Set(refs)) expect(Object.keys(schema.definitions)).toContain(ref)
  })
})
