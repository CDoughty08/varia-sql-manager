import { themeFormatVersion, themeKind, themeLimits, themePatterns } from './format'
import { builtinPalettes, paletteDescriptions, paletteSlots, type PaletteSlot } from './palette'
import { colorGroups, colorKeys, colorRegistry, cssVariable, parentScope, scopeAliases, scopeDescriptions, sqlScopes, syntaxDefaults, syntaxFontStyleDefaults, type ColorKey, type ColorKeyInfo } from './registry'
import { resolveBuiltin, resolveTheme } from './resolve'
import type { ThemeType } from './types'

const code = (value: string) => '`' + value + '`'
const dark = () => resolveBuiltin('dark'), light = () => resolveBuiltin('light')
const builtinValues = new Map<ThemeType, ReadonlyMap<string, string>>()
function slotValue(type: ThemeType, slot: PaletteSlot): string {
  if (!builtinValues.has(type)) builtinValues.set(type, resolveTheme([], type).palette)
  return builtinValues.get(type)!.get(slot)!
}
const slotText = (slot: PaletteSlot) => paletteDescriptions[slot] + (builtinPalettes.dark[slot].startsWith('$') ? ` Follows ${code(builtinPalettes.dark[slot])}.` : '')
const defaultText = (info: ColorKeyInfo) => typeof info.default === 'string' ? code(info.default) : `Dark ${code(info.default.dark)}, Light ${code(info.default.light)}`
const keyNotes = (info: ColorKeyInfo) => [
  info.opaqueOver && (info.opaqueOver === 'base' ? 'Made opaque over black (Dark) or white (Light).' : `Made opaque over ${code(info.opaqueOver)}.`),
  info.reserved && `Not used yet; reserved for ${info.reserved}.`
].filter(Boolean).join(' ')
function keyDescription(key: ColorKey): string {
  const info = colorRegistry[key]
  return [`(${info.origin === 'vscode' ? 'VS Code' : 'Varia'}) ${info.description}`, keyNotes(info),
    `Default ${defaultText(info)} (Dark ${code(dark().colors[key])}, Light ${code(light().colors[key])}).`].filter(Boolean).join(' ')
}
const plain = (markdown: string) => markdown.replaceAll('`', '')

/** The draft-07 JSON Schema for theme files, generated from the palette and registry. */
export function buildThemeJsonSchema() {
  const described = (markdown: string) => ({ $ref: '#/definitions/value', description: plain(markdown), markdownDescription: markdown })
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'varia-theme.schema.json',
    title: `Varia SQL Manager color theme (format ${themeFormatVersion})`,
    type: 'object', additionalProperties: false,
    required: ['kind', 'version', 'name', 'type'],
    properties: {
      $schema: { type: 'string', maxLength: themeLimits.schema },
      kind: { const: themeKind },
      version: { const: themeFormatVersion },
      name: { type: 'string', minLength: 1, maxLength: themeLimits.name, description: 'Shown in View > Theme.' },
      description: { type: 'string', maxLength: themeLimits.description },
      author: { type: 'string', maxLength: themeLimits.author },
      type: {
        enum: ['dark', 'light', 'dual'],
        markdownEnumDescriptions: ['Overrides Varia Dark.', 'Overrides Varia Light.', 'Overrides both; values may be `{"dark": …, "light": …}` objects.']
      },
      palette: {
        type: 'object', maxProperties: themeLimits.palette,
        description: 'Palette slots. Every color key defaults to a slot, so overriding a slot changes every key that uses it. You may add your own slots.',
        propertyNames: { pattern: themePatterns.slot },
        properties: Object.fromEntries(paletteSlots.map(slot => [slot, described(`${slotText(slot)} Varia Dark ${code(slotValue('dark', slot))} · Varia Light ${code(slotValue('light', slot))}`)])),
        additionalProperties: { $ref: '#/definitions/value' }
      },
      colors: {
        type: 'object', maxProperties: themeLimits.colors, additionalProperties: false,
        description: 'Color keys. Values are colors or $slot references.',
        properties: Object.fromEntries(colorKeys.map(key => [key, described(keyDescription(key))]))
      },
      tokenColors: { type: 'array', maxItems: themeLimits.tokenRules, description: 'SQL syntax colors.', items: { $ref: '#/definitions/tokenRule' } }
    },
    definitions: {
      hex: { type: 'string', format: 'color-hex', maxLength: 9, pattern: themePatterns.hex },
      ref: { type: 'string', maxLength: themeLimits.valueLength, pattern: themePatterns.ref, description: 'A palette slot, optionally with an opacity percentage: $accent or $accent/20.' },
      color: { anyOf: [{ $ref: '#/definitions/hex' }, { $ref: '#/definitions/ref' }] },
      value: { anyOf: [{ $ref: '#/definitions/color' }, {
        type: 'object', minProperties: 1, additionalProperties: false,
        properties: { dark: { $ref: '#/definitions/color' }, light: { $ref: '#/definitions/color' } }
      }] },
      scope: { type: 'string', maxLength: themeLimits.scopeLength, examples: [...sqlScopes, ...scopeAliases.keys()] },
      tokenRule: {
        type: 'object', required: ['scope', 'settings'], additionalProperties: false, properties: {
          name: { type: 'string', maxLength: themeLimits.ruleName },
          scope: { anyOf: [{ $ref: '#/definitions/scope' }, { type: 'array', maxItems: themeLimits.scopesPerRule, items: { $ref: '#/definitions/scope' } }] },
          settings: { type: 'object', additionalProperties: false, properties: {
            foreground: { $ref: '#/definitions/value' },
            fontStyle: { type: 'string', pattern: themePatterns.fontStyle }
          } }
        }
      }
    }
  }
}

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: string[]) => '| ' + cells.map(cell).join(' | ') + ' |'

/** docs/themes/tokens.md: every slot, key, and scope with its default and built-in values. */
export function renderTokenDocs(): string {
  const lines = [
    '# Varia theme tokens',
    '',
    '<!-- Generated by renderTokenDocs() in src/shared/theme/schema.ts. Update with: npx vitest run tests/theme-schema.test.ts -u -->',
    '',
    `Theme files (format ${themeFormatVersion}) override palette slots, color keys, and SQL token colors. Every key defaults to a palette slot`,
    '(`$slot`, optionally with an opacity percentage such as `$accent/20`) or to another key (`@key`), so overriding a slot changes every',
    'key that uses it. Keys marked (VS Code) mean the same as the VS Code key of that name. In CSS, a key is available as',
    `\`var(${cssVariable('editor.background')})\`: \`--varia-\` followed by the key with dots replaced by hyphens.`,
    '',
    `## Palette slots (${paletteSlots.length})`,
    '',
    row(['Slot', 'Drives', 'Varia Dark', 'Varia Light']),
    row(['---', '---', '---', '---']),
    ...paletteSlots.map(slot => row([code(slot), slotText(slot), code(slotValue('dark', slot)), code(slotValue('light', slot))])),
    '',
    `## Color keys (${colorKeys.length})`
  ]
  for (const group of colorGroups) {
    lines.push('', `### ${group.title}`, '', row(['Key', 'Source', 'Default', 'Varia Dark', 'Varia Light', 'Description']), row(['---', '---', '---', '---', '---', '---']))
    for (const key of group.keys) {
      const info = colorRegistry[key]
      lines.push(row([code(key), info.origin === 'vscode' ? 'VS Code' : 'Varia', defaultText(info), code(dark().colors[key]), code(light().colors[key]), [info.description, keyNotes(info)].filter(Boolean).join(' ')]))
    }
  }
  lines.push('', `## SQL syntax scopes (${sqlScopes.length})`, '',
    'Rules in `tokenColors` name these scopes. A sub-scope such as `keyword.block` inherits from its parent unless a rule names it.',
    'Colors are made opaque over `editor.background`; `fontStyle` defaults to `""` unless the Default column names one.', '',
    row(['Scope', 'Monaco token', 'Default', 'Varia Dark', 'Varia Light', 'Matches']), row(['---', '---', '---', '---', '---', '---']))
  for (const scope of sqlScopes) {
    const parent = parentScope(scope), fallback = syntaxDefaults[scope], fontStyle = syntaxFontStyleDefaults[scope]
    const defaults = fallback ? code(fallback) + (fontStyle ? ', ' + code(fontStyle) : '') : `inherits ${code(parent!)}`
    lines.push(row([code(scope), code(scope + '.sql'), defaults, code(dark().syntax[scope].foreground), code(light().syntax[scope].foreground), scopeDescriptions[scope]]))
  }
  lines.push('', '### Scope aliases', '', 'These TextMate scope names are accepted as exact matches, so rules copied from VS Code themes keep working.', '',
    row(['Alias', 'Scope']), row(['---', '---']), ...[...scopeAliases].map(([alias, scope]) => row([code(alias), code(scope)])), '')
  return lines.join('\n')
}
