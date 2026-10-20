// Renders docs/table-designer.md from the designer catalogue; tests/table-designer-catalog.test.ts keeps the file in sync.
import { unknownOutcomeMessage } from '../actions/catalog.ts'
import {
  columnPropertySpecs, defaultNewType, designerCommandEntries, designerLimits, designerStrings, reservedKeywords, systemTypes, tablePropertySpecs, type DesignerCommandId, type SystemTypeSpec
} from './catalog.ts'
import { defaultType, formatTypeText } from './type-text.ts'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const yes = (value: boolean | undefined) => value ? 'Yes' : ''

const paramText: Readonly<Record<SystemTypeSpec['params'], (type: SystemTypeSpec) => string>> = {
  none: () => '',
  length: type => `length 1–${type.maxLength?.toLocaleString('en-US')}${type.max ? ' or MAX' : ''}`,
  nlength: type => `length 1–${type.maxLength?.toLocaleString('en-US')} characters${type.max ? ' or MAX' : ''}`,
  precisionScale: () => 'precision 1–38, scale 0–precision',
  scale: () => 'scale 0–7',
  dimensions: () => 'dimensions 1–1,998'
}
const listed = (type: SystemTypeSpec) => type.unlisted ? 'typed only' : [formatTypeText(defaultType(type)), ...type.listMax ? [formatTypeText({ system: type.name, max: true })] : []].join(', ')
const limitNotes: Readonly<Record<keyof typeof designerLimits, string>> = {
  columns: 'Columns in a table (SQL Server\'s limit for a table that is not wide)',
  keyColumns: 'Columns in the primary key (SQL Server\'s limit for a clustered index)',
  designChars: 'UTF-16 code units of every string in a design together',
  scriptChars: 'Characters in a change script: main\'s limit for a query, so the script can run in a query window',
  schemas: 'Schemas the Schema list offers; more are listed as truncated',
  identityDigits: 'Digits in an identity seed or increment (decimal(38, 0))',
  captionChars: 'Characters in a designer tab\'s caption, so main\'s close prompt always takes it'
}

export function renderTableDesignerDocs(): string {
  const commands = designerCommandEntries()
  const ids = Object.keys(commands) as DesignerCommandId[]
  return [
    '# Table Designer',
    '',
    '<!-- Generated from src/shared/designer/catalog.ts. Regenerate with: npx vitest run tests/table-designer-catalog.test.ts -u -->',
    '',
    'SSMS\'s Table Designer for a new table: Object Explorer › a database › Tables › right-click › New › Table… opens it as a',
    'document tab. Its types, properties, commands and limits are data in `src/shared/designer/catalog.ts`; the backend embeds',
    'the same data as `backend/Varia.Backend/Designer/designer-catalog.json` and re-validates every design before anything runs.',
    'SSMS 22 behaviour marked "not verified" could not be confirmed from Microsoft\'s documentation; Varia picks the closest',
    'documented behaviour.',
    '',
    '## The designer',
    '',
    '- The tab\'s caption is "<server>.<database> - <schema>.<table>" (not verified), with the dirty dot while it has unsaved',
    '  changes. A new table is named Table_1, Table_2… per session (not verified) in schema dbo (verified), or the database\'s',
    '  first schema when it has no dbo.',
    '- The grid has a row selector (a key glyph marks primary key columns), Column Name, Data Type and Allow Nulls, and an',
    `  empty last row: typing a name there adds a column of type ${code(formatTypeText(defaultNewType))} (not verified) that allows nulls.`,
    '- Keys in the grid: arrows, Home, End, Ctrl+Home, Ctrl+End, Page Up, Page Down, Tab and Shift+Tab (wrapping rows), F2 or',
    '  Enter to edit, typing to start editing, Escape to cancel an edit, Space to toggle Allow Nulls, and Alt+Down to edit the',
    '  Data Type with its list of types. Shift and Ctrl with a click on the row selector select several rows.',
    '- Column Properties shows the current column\'s properties by category, or alphabetically; Properties (F4) shows the',
    '  table\'s. Edit › Undo and Redo act on the text field being edited only; undoing grid changes is a follow-up.',
    '- Save (File › Save, Ctrl+S, ⌘S) asks Choose Name the first time (verified: learn.microsoft.com, Create tables), with',
    `  "${designerStrings.chooseNameLabel}" (not verified), then creates the table in one transaction. After a successful save the`,
    `  tab stays open, read-only, saying "${designerStrings.saved('<schema>.<table>')}", and Object Explorer`,
    '  reloads the Tables folder with the new table selected (SSMS asks for F5 there).',
    `- Generate Change Script… shows "${designerStrings.changeScriptTitle}": "${designerStrings.changeScriptPrompt}" (not verified), the`,
    '  script Save would run, Yes (save it to a file) and No.',
    '- Closing a designer with unsaved changes asks to save it, like a query; Save All and closing the window include',
    '  designers. AutoRecover does not keep designers yet. While a save runs, Stop cancels it and SQL Server rolls it back.',
    '',
    '## Data types',
    '',
    table(['Type', 'List entries', 'Parameters', 'Identity', 'Off-row (TEXTIMAGE_ON)', 'Since'], systemTypes.map(type => [code(type.name), listed(type), paramText[type.params](type),
      type.identity ? (type.params === 'precisionScale' ? 'Yes (scale 0)' : 'Yes') : '', yes(type.lob), type.since ? 'SQL Server 2025' : ''])),
    '',
    'The Data Type cell takes any case and spacing: `nvarchar(max)` becomes `nvarchar(MAX)`, `decimal(18,0)` becomes',
    '`decimal(18, 0)`, and a bare name takes the list\'s parameters. A table has at most one identity and one timestamp column.',
    'The list and its order follow SSMS (not verified as SSMS 22\'s exact list).',
    '',
    '## Column Properties',
    '',
    table(['Property', 'Category', 'Description'], columnPropertySpecs.map(spec => [(spec.parent ? '› ' : '') + spec.label, spec.category, spec.description])),
    '',
    'Names and categories are SSMS\'s (verified: learn.microsoft.com, Column Properties). Identity Specification\'s value mirrors',
    '(Is Identity); an empty Identity Seed or Increment means 1 (verified). Setting (Is Identity) clears Allow Nulls, as does',
    'Set Primary Key, which also greys it.',
    '',
    '## Properties (F4)',
    '',
    table(['Property', 'Category', 'Description'], tablePropertySpecs.map(spec => [spec.label, spec.category, spec.description])),
    '',
    '## Commands',
    '',
    table(['Command', 'Title', 'Key', 'Context menu'], ids.map(id => {
      const entry = commands[id]
      const menu = entry.menus?.map(placement => `${placement.menu} (${code(placement.group)}, ${placement.mnemonic.toUpperCase()})`).join(', ') ?? ''
      return [code(id), entry.title, entry.keybindings?.map(binding => binding.key.toUpperCase()).join(', ') ?? '', menu]
    })),
    '',
    'The designer\'s toolbar strip has Set Primary Key (Remove Primary Key when every selected row is a key column), Insert',
    'Column (above the current row), Delete Column and Generate Change Script…; the designer\'s context menu adds Properties.',
    'The Table Designer menubar menu is a follow-up.',
    '',
    '## Script',
    '',
    'The change script is SSMS\'s: its comment, the SET prologue in a transaction, `CREATE TABLE` with one column a line,',
    '`) ON [PRIMARY]` (the database\'s default filegroup) and `TEXTIMAGE_ON` when a column is stored off-row, the primary key',
    'as `ALTER TABLE … ADD CONSTRAINT PK_<table> PRIMARY KEY CLUSTERED … WITH( STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY =',
    'OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]`, `SET (LOCK_ESCALATION = TABLE)`, and `COMMIT` (the',
    'prologue, the key block and LOCK_ESCALATION are verified against SSMS change scripts; the IDENTITY and TEXTIMAGE_ON shapes',
    'and the order of the blocks are not). Names are bare when they are regular identifiers that are not reserved keywords',
    `(${reservedKeywords.length} of them) or GO, as SSMS writes them, and bracketed otherwise. PK_<table> is cut to 128 UTF-16 units`,
    'without splitting a surrogate pair (not verified). The goldens in `tests/fixtures/designer` are Varia\'s until the owner',
    'captures SSMS 22\'s.',
    '',
    '## SQL',
    '',
    'Save runs on the object-action connection (`actions.execute`\'s `createTable`), after a preflight in the same connection:',
    'the database is online and accessible, CREATE TABLE and ALTER on the schema are not denied (advisory), the schema',
    'exists, and neither the table\'s nor PK_<table>\'s name is taken. The renderer never sends SQL: the backend turns the',
    'validated design into one JSON parameter, and constant builder batches have SQL Server shred it with OPENJSON (so master',
    'needs compatibility level 130 or later) and compose each statement from `QUOTENAME`d names, `CONVERT`ed numbers and type',
    'keywords from a constant table generated from the catalogue, then run it in the database. CREATE TABLE, the primary key',
    'and LOCK_ESCALATION run in one transaction, committed only when all succeed; any failure, Stop or lost connection rolls',
    'it back. DDL waits for locks without a time-out, as the object actions do; Stop is always available.',
    '',
    `If the backend stops while a save runs: "${unknownOutcomeMessage}"`,
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof designerLimits)[]).map(key => [code(key), designerLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    '',
    '## Not yet',
    '',
    '- Design (changing an existing table), and the Table Designer menubar menu.',
    '- Default Value or Binding, Computed Column Specification, Collation, Description, Condensed Data Type, RowGuid, Not For',
    '  Replication, Size and the other read-only Table Designer rows, user-defined data types, and Lock Escalation (PR-G2).',
    '- Tools › Options › Designers (Table and Database Designers): the transaction time-out and Auto generate change scripts.',
    '- Relationships, indexes and keys other than the primary key, check constraints, and the Database Diagram.',
    '- Undo and Redo of grid changes, and AutoRecover for designers.',
    ''
  ].join('\n')
}
