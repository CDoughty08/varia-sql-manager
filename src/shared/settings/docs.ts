// Renders docs/settings.md from the settings catalogue; tests/settings-catalog.test.ts keeps the file in sync.
import { pagePath, settingDefs, settingPages, settingsLimits } from './catalog'
import type { SettingDef, SettingPage } from './types'

// `<` outside code spans would start an HTML tag ("Select Top <n> Rows").
const cell = (value: string) => value.replaceAll('|', '\\|').split('`').map((part, index) => index % 2 ? part : part.replaceAll('<', '&lt;')).join('`')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'

function valueText(def: SettingDef, value: boolean | number | string): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (def.type === 'enum') return def.values.find(item => item.value === value)?.label ?? String(value)
  if (typeof value === 'number') return value.toLocaleString('en-US') + (def.type === 'integer' && def.unit ? ' ' + def.unit : '')
  return value
}
function typeText(def: SettingDef): string {
  if (def.type === 'boolean') return 'Boolean'
  if (def.type === 'integer') return `Integer ${def.min.toLocaleString('en-US')}–${def.max.toLocaleString('en-US')}${def.unit ? ' ' + def.unit : ''}`
  return 'One of ' + def.values.map(item => `${code(item.value)} (${item.label})`).join(', ')
}
const applies = { immediately: 'At once', nextExecution: 'Next execution', newConnections: 'New connections' } as const
function notes(def: SettingDef): string {
  const parts = [def.description]
  if (def.varia) parts.push('Not in SSMS.')
  if (def.hidden) parts.push('Not shown in Options.')
  if (def.disabledWhen) parts.push(`Greyed while ${code(def.disabledWhen)} is True.`)
  if (def.enabledBy) parts.push(`Greyed while ${code(def.enabledBy)} is False.`)
  return parts.join(' ')
}
const breadcrumb = (page: SettingPage) => pagePath(page.id).map(node => node.title).join(' › ')

function pageSection(page: SettingPage): string {
  const defs = settingDefs.filter(def => def.page === page.id)
  const intro = [page.description, page.provider === 'theme' ? 'Its first row is a note: Color theme: View › Theme (stored in `appearance.json`).' : '',
    page.layout === 'propertyGrid' ? 'A property grid: True/False lists, values that differ from their default in bold.' : ''].filter(Boolean).join(' ')
  const rows = defs.map(def => [code(def.key), def.label, typeText(def), valueText(def, def.default), def.ssmsDefault === undefined ? '' : valueText(def, def.ssmsDefault),
    def.platforms ? def.platforms.join(', ') : 'All', applies[def.applies ?? 'immediately'], notes(def)])
  return [`### ${breadcrumb(page)}`, intro, rows.length ? table(['Setting key', 'Label', 'Type and bounds', 'Default', 'SSMS default', 'Platforms', 'Applies', 'What it changes'], rows) : '_No settings yet._']
    .filter(Boolean).join('\n\n')
}

function tree(): string {
  const lines: string[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const page of settingPages.filter(node => node.parent === parent)) {
      lines.push(`${'  '.repeat(depth)}- ${page.title}${page.layout ? ` (${code(page.id)})` : ''}`)
      walk(page.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return lines.join('\n')
}

const limitNotes: Readonly<Record<keyof typeof settingsLimits, string>> = {
  fileBytes: 'Bytes in `settings.json`, read and written',
  unknownKeys: 'Unknown keys kept from a newer version',
  keyChars: 'Characters in a setting key',
  unknownStringChars: 'Characters in a kept unknown string value',
  searchChars: 'Characters in the Options search box',
  warningLabels: 'Setting labels a salvage warning names before "and N more"'
}

export function renderSettingsDocs(): string {
  return `# Settings

<!-- Generated from src/shared/settings/. Regenerate with: npx vitest run tests/settings-catalog.test.ts -u -->

Tools › Options, as SSMS 22 lays it out. Every setting is declared once in \`src/shared/settings/\` (pages in
\`pages.ts\`, one file per area, aggregated by \`catalog.ts\`); defaults, bounds and the zod schemas main and the renderer
validate with are built from those declarations. Settings marked "Not in SSMS" sit on the nearest SSMS page. Where
SSMS's default differs, the SSMS default column gives it; "not verified" means SSMS 22's default could not be confirmed
from Microsoft's documentation, so Varia keeps its own.

## Pages

${tree()}

A node without a page id is a category: selecting it shows its first page. The search box (Ctrl+E, ⌘E on macOS) matches
page titles, setting labels, descriptions and keywords.

## Settings

${settingPages.filter(page => page.layout).map(pageSection).join('\n\n')}

## Storage

- \`<userData>/settings.json\` holds \`{ "version": 1, "values": { ... } }\`: only the values that differ from their
  defaults, sorted by key. Keys this version does not know (a newer version's) are kept verbatim, up to
  ${settingsLimits.unknownKeys}, when they hold a boolean, a finite number or a string of at most ${settingsLimits.unknownStringChars} characters.
- Only main reads and writes it (\`SettingsStore\`). Every change is a patch of changed keys (\`null\` resets one), validated
  strictly; main reads the file again before each write, merges, and writes atomically. A change that changes nothing
  writes nothing.
- An invalid file (too large, not UTF-8, not JSON, or not that shape) is renamed to
  \`settings.json.invalid-<uuid>.json\` and the defaults apply, with a warning. A file with values this version does not
  support is salvaged: the original is kept the same way, the other values are written back, and the warning names the
  reset settings. A file that cannot be read (permissions, a folder at the path) is never replaced: Options does not
  open, and changes are refused.
- Migration: when \`settings.json\` does not exist, a \`scripting-options.json\` from an earlier version is imported into
  the \`objectExplorer.scripting.*\` keys and left untouched; it is not read again once \`settings.json\` exists.
- The color theme stays in \`appearance.json\` (View › Theme); connection profiles keep their own Advanced properties.

## Limits

${table(['Limit', 'Value', 'What it bounds'], Object.entries(settingsLimits).map(([key, value]) => [code(key), value.toLocaleString('en-US'), limitNotes[key as keyof typeof settingsLimits]]))}

A patch holds at most one entry per setting (${settingDefs.length} today).
`
}
