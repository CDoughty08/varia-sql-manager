# Settings

<!-- Generated from src/shared/settings/. Regenerate with: npx vitest run tests/settings-catalog.test.ts -u -->

Tools › Options, as SSMS 22 lays it out. Every setting is declared once in `src/shared/settings/` (pages in
`pages.ts`, one file per area, aggregated by `catalog.ts`); defaults, bounds and the zod schemas main and the renderer
validate with are built from those declarations. Settings marked "Not in SSMS" sit on the nearest SSMS page. Where
SSMS's default differs, the SSMS default column gives it; "not verified" means SSMS 22's default could not be confirmed
from Microsoft's documentation, so Varia keeps its own.

## Pages

- Environment
  - General (`environment.general`)
  - Fonts and Colors (`environment.fontsAndColors`)
  - Keyboard (`environment.keyboard`)
- Text Editor
  - General (`textEditor.general`)
  - Transact-SQL
    - General (`textEditor.transactSql.general`)
    - Tabs (`textEditor.transactSql.tabs`)
- Query Execution
  - SQL Server
    - General (`queryExecution.sqlServer.general`)
    - Advanced (`queryExecution.sqlServer.advanced`)
- Query Results
  - SQL Server
    - Results to Grid (`queryResults.sqlServer.grid`)
- SQL Server Object Explorer
  - Commands (`objectExplorer.commands`)
  - Scripting (`objectExplorer.scripting`)

A node without a page id is a category: selecting it shows its first page. The search box (Ctrl+E, ⌘E on macOS) matches
page titles, setting labels, descriptions and keywords.

## Settings

### Environment › General

Its first row is a note: Color theme: View › Theme (stored in `appearance.json`).

_No settings yet._

### Environment › Fonts and Colors

Colors come from the color theme (View › Theme).

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.fonts.editorFontSize` | Size | Integer 8–72 px | 14 px | 10 pt Consolas (SSMS 18–20; SSMS 22 not verified) | All | At once | The query editor's font size, in CSS pixels. |

### Environment › Keyboard

Shortcuts follow SSMS's defaults and cannot be changed yet. The command palette (F1) shows each command's shortcut.

_No settings yet._

### Text Editor › General

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.dragAndDrop` | Enable mouse click to perform drag-and-drop text editing | Boolean | True |  | All | At once | Selected text can be dragged to move it, or copied with Ctrl held (Option on macOS). |
| `textEditor.delimiterHighlighting` | Automatic delimiter highlighting | Boolean | True |  | All | At once | Highlights the bracket or parenthesis that matches the one at the caret. Large values opened from the results never match brackets. |
| `textEditor.highlightCurrentLine` | Highlight current line | Boolean | True |  | All | At once | Highlights the line that holds the caret. |

### Text Editor › Transact-SQL › General

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.sql.wordWrap` | Word wrap | Boolean | False |  | All | At once | Wraps long lines at the edge of the editor instead of scrolling. Edit › Advanced › Word Wrap changes it too (Alt+Z on Windows and Linux). |
| `textEditor.sql.viewWhiteSpace` | View white space | Boolean | False |  | All | At once | Shows spaces as dots and tabs as arrows. Edit › Advanced › View White Space changes it; as in SSMS, Options has no row for it. Not shown in Options. |
| `textEditor.sql.lineNumbers` | Line numbers | Boolean | True | False (SSMS 18–20; SSMS 22 not verified) | All | At once | Shows line numbers beside the query text. |

### Text Editor › Transact-SQL › Tabs

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.sql.tabSize` | Tab size | Integer 1–60 | 4 |  | All | At once | The number of columns a tab character takes. |
| `textEditor.sql.indentSize` | Indent size | Integer 1–60 | 4 |  | All | At once | The number of columns Tab and automatic indentation indent by. |
| `textEditor.sql.tabs` | Tab characters | One of `spaces` (Insert spaces), `tabs` (Keep tabs) | Keep tabs |  | All | At once | Whether Tab and indentation insert spaces or tab characters, as SSMS's Insert spaces and Keep tabs. The indentation already in a query is not detected. |

### Query Execution › SQL Server › General

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `queryExecution.executionTimeout` | Execution time-out | Integer 0–86,400 seconds | 0 seconds |  | All | Next execution | The number of seconds to wait before cancelling a query. 0 waits indefinitely. A connection whose Advanced properties set a command timeout uses that instead. |

### Query Execution › SQL Server › Advanced

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `queryExecution.stopOnError` | Stop the script at the first batch that raises an error | Boolean | False |  | All | Next execution | Skips the remaining batches of a script after a batch fails. Otherwise every batch runs, as in SSMS. Not in SSMS. |

### Query Results › SQL Server › Results to Grid

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `queryResults.grid.includeColumnHeaders` | Include column headers when copying or saving the results | Boolean | False |  | All | At once | Copy and Save Results As (CSV and tab-delimited text) start with a row of column names. JSON always names its keys, and Copy with Headers always includes them. |
| `queryResults.grid.maxResultSets` | Maximum result sets kept per execution | Integer 1–1,000 | 1,000 |  | All | Next execution | Result sets after this many still run and are counted, but their rows are not kept; the Messages tab says so. Not in SSMS. |

### SQL Server Object Explorer › Commands

A property grid: True/False lists, values that differ from their default in bold.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `objectExplorer.selectTopRows` | Value for Select Top &lt;n> Rows command | Integer 1–2,147,483,647 | 1,000 |  | All | At once | How many rows Select Top Rows reads, and the number its menu item shows. |

### SQL Server Object Explorer › Scripting

A property grid: True/False lists, values that differ from their default in bold.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `objectExplorer.scripting.delimitStatements` | Delimit individual statements | Boolean | True | False | All | At once | Separates the statements of the script with the batch separator, GO. |
| `objectExplorer.scripting.includeHeaders` | Include descriptive headers | Boolean | True |  | All | At once | Adds a comment before each object's script that names the object and the date the script was generated. |
| `objectExplorer.scripting.includeVarDecimal` | Include enabling vardecimal compression | Boolean | False |  | All | At once | Includes the statements that enable the vardecimal storage format on tables that use it. |
| `objectExplorer.scripting.scriptChangeTracking` | Script change tracking | Boolean | False |  | All | At once | Includes the change tracking settings of tables and databases that use change tracking. |
| `objectExplorer.scripting.scriptFullTextCatalogs` | Script full-text catalogs | Boolean | False |  | All | At once | Includes full-text catalogs. |
| `objectExplorer.scripting.scriptUseDatabase` | Script USE &lt;database> | Boolean | True |  | All | At once | Starts the script with a USE statement, so it runs in the object's database. Turn it off for a script meant for another database. |
| `objectExplorer.scripting.checkExistence` | Check for object existence | Boolean | False |  | All | At once | Runs each statement only when the object exists (for DROP and ALTER) or does not exist yet (for CREATE). |
| `objectExplorer.scripting.generateDependentObjects` | Generate script for dependent objects | Boolean | False |  | All | At once | Also scripts the objects that must exist before the selected object's script can run. |
| `objectExplorer.scripting.schemaQualify` | Schema qualify object names | Boolean | True | False | All | At once | Prefixes object names with their schema. |
| `objectExplorer.scripting.scriptDataCompression` | Script data compression options | Boolean | False |  | All | At once | Includes the data compression and XML compression settings of tables and indexes. |
| `objectExplorer.scripting.scriptExtendedProperties` | Script extended properties | Boolean | True | False | All | At once | Includes the object's extended properties. |
| `objectExplorer.scripting.scriptOwner` | Script owner | Boolean | False |  | All | At once | Includes the object's owner. |
| `objectExplorer.scripting.scriptPermissions` | Script permissions | Boolean | False | True | All | At once | Includes the permissions granted or denied on the object. |
| `objectExplorer.scripting.convertUserDefinedDataTypes` | Convert user-defined data types to base types | Boolean | False |  | All | At once | Replaces user-defined data types with the base types they are built on. |
| `objectExplorer.scripting.generateAnsiPadding` | Generate SET ANSI PADDING commands | Boolean | True |  | All | At once | Surrounds CREATE TABLE statements with SET ANSI_PADDING statements. |
| `objectExplorer.scripting.includeCollation` | Include collation | Boolean | False | True | All | At once | Includes each column's collation. |
| `objectExplorer.scripting.includeIdentity` | Include IDENTITY property | Boolean | True |  | All | At once | Includes the IDENTITY property, with its seed and increment. |
| `objectExplorer.scripting.schemaQualifyForeignKeys` | Schema qualify foreign key references | Boolean | True |  | All | At once | Prefixes the table a foreign key references with its schema. |
| `objectExplorer.scripting.scriptBindings` | Script bound defaults and rules | Boolean | True |  | All | At once | Includes the sp_bindefault and sp_bindrule statements of defaults and rules bound to columns. |
| `objectExplorer.scripting.scriptCheckConstraints` | Script CHECK constraints | Boolean | True |  | All | At once | Includes CHECK constraints. |
| `objectExplorer.scripting.scriptDefaults` | Script defaults | Boolean | True | False | All | At once | Includes column default constraints. |
| `objectExplorer.scripting.scriptFileGroups` | Script file groups | Boolean | True | False | All | At once | Includes the ON &lt;filegroup> clause of tables and indexes. |
| `objectExplorer.scripting.scriptForeignKeys` | Script foreign keys | Boolean | True | False | All | At once | Includes foreign keys. |
| `objectExplorer.scripting.scriptFullTextIndexes` | Script full-text indexes | Boolean | False |  | All | At once | Includes full-text indexes. |
| `objectExplorer.scripting.scriptIndexes` | Script indexes | Boolean | True |  | All | At once | Includes clustered, nonclustered, XML, spatial and columnstore indexes. |
| `objectExplorer.scripting.scriptPartitionSchemes` | Script partition schemes | Boolean | False |  | All | At once | Includes the partition scheme clause of partitioned tables and indexes. |
| `objectExplorer.scripting.scriptPrimaryKeys` | Script primary keys | Boolean | True |  | All | At once | Includes primary keys. |
| `objectExplorer.scripting.scriptStatistics` | Script statistics | Boolean | False |  | All | At once | Includes statistics, without their histograms. |
| `objectExplorer.scripting.scriptTriggers` | Script triggers | Boolean | False |  | All | At once | Includes the DML triggers of tables and views. |
| `objectExplorer.scripting.scriptUniqueKeys` | Script unique keys | Boolean | True | False | All | At once | Includes unique keys. |
| `objectExplorer.scripting.scriptViewColumns` | Script view columns | Boolean | False |  | All | At once | Lists a view's column names in its CREATE VIEW header. |
| `objectExplorer.scripting.includeDriSystemNames` | Include DRI system names | Boolean | False |  | All | At once | Includes the names of constraints whose names SQL Server generated. |
| `objectExplorer.scripting.matchSourceSettings` | Match script settings to source | Boolean | True |  | All | At once | Scripts for the version, edition and engine type of the object's server. Turn it off to choose them below. |
| `objectExplorer.scripting.targetEngineEdition` | Script for database engine edition | One of `personal` (Microsoft SQL Server Personal Edition), `standard` (Microsoft SQL Server Standard Edition), `enterprise` (Microsoft SQL Server Enterprise Edition), `express` (Microsoft SQL Server Express Edition) | Microsoft SQL Server Enterprise Edition |  | All | At once | The database engine edition the script is for. Used when Match script settings to source is False. Greyed while `objectExplorer.scripting.matchSourceSettings` is True. |
| `objectExplorer.scripting.targetEngineType` | Script for database engine type | One of `standalone` (Stand-alone instance) | Stand-alone instance |  | All | At once | The database engine type the script is for. Used when Match script settings to source is False. Greyed while `objectExplorer.scripting.matchSourceSettings` is True. |
| `objectExplorer.scripting.targetServerVersion` | Script for server version | One of `130` (SQL Server 2016), `140` (SQL Server 2017), `150` (SQL Server 2019), `160` (SQL Server 2022), `170` (SQL Server 2025) | SQL Server 2022 |  | All | At once | The SQL Server version the script is for; features it lacks cannot be scripted. Used when Match script settings to source is False. Greyed while `objectExplorer.scripting.matchSourceSettings` is True. |

## Storage

- `<userData>/settings.json` holds `{ "version": 1, "values": { ... } }`: only the values that differ from their
  defaults, sorted by key. Keys this version does not know (a newer version's) are kept verbatim, up to
  128, when they hold a boolean, a finite number or a string of at most 512 characters.
- Only main reads and writes it (`SettingsStore`). Every change is a patch of changed keys (`null` resets one), validated
  strictly; main reads the file again before each write, merges, and writes atomically. A change that changes nothing
  writes nothing.
- An invalid file (too large, not UTF-8, not JSON, or not that shape) is renamed to
  `settings.json.invalid-<uuid>.json` and an empty file replaces it, so the defaults apply, with a warning. A file with
  values this version does not support is salvaged: the original is kept the same way, the other values are written
  back, and the warning names the reset settings. When that write fails, the values stay in memory and the next change
  writes them. A file that cannot be read (permissions, a folder at the path) is never replaced: Options does not
  open, and changes are refused.
- Migration: when `settings.json` does not exist, a `scripting-options.json` from an earlier version is imported into
  the `objectExplorer.scripting.*` keys and left untouched; it is not read again once `settings.json` exists or was
  reset. When the import cannot be written, its values apply for the session and the next start imports again.
- The color theme stays in `appearance.json` (View › Theme); connection profiles keep their own Advanced properties.

## Limits

| Limit | Value | What it bounds |
| --- | --- | --- |
| `fileBytes` | 131,072 | Bytes in `settings.json`, read and written |
| `unknownKeys` | 128 | Unknown keys kept from a newer version |
| `keyChars` | 96 | Characters in a setting key |
| `unknownStringChars` | 512 | Characters in a kept unknown string value |
| `searchChars` | 256 | Characters in the Options search box |
| `warningLabels` | 3 | Setting labels a salvage warning names before "and N more" |

A patch holds at most one entry per setting (51 today).
