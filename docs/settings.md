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
  - AutoRecover (`environment.autoRecover`)
  - Documents (`environment.documents`)
  - Fonts and Colors (`environment.fontsAndColors`)
  - Keyboard (`environment.keyboard`)
- Text Editor
  - General (`textEditor.general`)
  - Editor Tab and Status Bar (`textEditor.editorTabAndStatusBar`)
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

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.layout.classicToolbar` | Show the classic toolbar | Boolean | False |  | All | At once | Shows the text toolbar of earlier versions below the header: Connect, New query, Open, Save, Save All, Execute, Cancel and Layouts, with the Server and Database boxes. The header then keeps only the menus and the search box. This option will be removed in a later release. Not in SSMS. |
| `environment.layout.panelTabs` | Show panel tabs | Boolean | False |  | All | At once | Window › Panel Tabs: a panel that is alone in its dock group shows its tab, which can be dragged to dock the panel elsewhere. Without it such a panel shows no tab and moves through its ⋯ menu. Panels that share a group, and floating panels, always show their tabs. Not in SSMS. Not shown in Options. |
| `environment.recentFiles.count` | Items shown in recently used file lists | Integer 1–24 | 10 |  | All | At once | How many files File › Recent Files lists. Varia SQL Manager remembers up to 50, so a larger number shows older files again. |

### Environment › AutoRecover

Copies of queries with unsaved changes, offered after Varia SQL Manager closes unexpectedly.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.autoRecover.enabled` | Save AutoRecover information | Boolean | True |  | All | At once | Keeps a copy of each query with unsaved changes in Varia SQL Manager's profile folder, readable only by you, so a crash, a forced close or a power loss loses at most the last few minutes. The next start offers the copies in Recover Unsaved Queries. Turning it off deletes this window's copies; copies left by earlier runs are still offered. |
| `environment.autoRecover.intervalMinutes` | Save AutoRecover information every | Integer 1–60 minutes | 5 minutes |  | All | At once | How often AutoRecover saves the queries whose text changed since it last saved them. Greyed while `environment.autoRecover.enabled` is False. |
| `environment.autoRecover.keepDays` | Keep AutoRecover information for | Integer 1–90 days | 7 days |  | All | At once | How long a copy that was not recovered is kept. Older copies are deleted when Varia SQL Manager starts. Greyed while `environment.autoRecover.enabled` is False. |

### Environment › Documents

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.documents.detectExternalChanges` | Detect when file is changed outside the environment | Boolean | True |  | All | At once | When the window gets focus, checks whether another program changed or deleted an open file, and asks whether to reload a changed one. Save also asks before replacing such changes. |
| `environment.documents.autoReload` | Reload modified files unless there are unsaved changes | Boolean | False |  | All | At once | Reloads a file changed outside Varia SQL Manager without asking when its query has no unsaved changes. A query with unsaved changes still asks. Greyed while `environment.documents.detectExternalChanges` is False. |
| `environment.documents.saveWithSpecificEncoding` | Save files with a specific encoding | Boolean | False |  | All | At once | Saves every file in Save encoding, converting files read in another encoding. While it is False, a file keeps the encoding it was opened in, and a new query is saved as UTF-8 without a byte order mark: SSMS 22 starts a new query from an empty template that has none. |
| `environment.documents.saveEncoding` | Save encoding | One of `utf8bom` (Unicode (UTF-8 with signature)), `utf8` (Unicode (UTF-8 without signature)), `utf16le` (Unicode), `utf16be` (Unicode (Big-Endian)) | Unicode (UTF-8 with signature) |  | All | At once | The encoding every file is saved in while Save files with a specific encoding is True. Unicode is UTF-16 little-endian. Greyed while `environment.documents.saveWithSpecificEncoding` is False. |

### Environment › Fonts and Colors

Colors come from the color theme (View › Theme).

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.fonts.editorFontSize` | Size | Integer 8–72 px | 13 px | 10 pt Consolas (SSMS 18–20; SSMS 22 not verified) | All | At once | The query editor's font size, in CSS pixels. |

### Environment › Keyboard

Shortcuts follow SSMS's defaults and cannot be changed yet. The command palette (F1) shows each command's shortcut.

_No settings yet._

### Text Editor › General

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.dragAndDrop` | Enable mouse click to perform drag-and-drop text editing | Boolean | True |  | All | At once | Selected text can be dragged to move it, or copied with Ctrl held (Option on macOS). |
| `textEditor.delimiterHighlighting` | Automatic delimiter highlighting | Boolean | True |  | All | At once | Highlights the bracket or parenthesis that matches the one at the caret. Large values opened from the results never match brackets. |
| `textEditor.highlightCurrentLine` | Highlight current line | Boolean | True |  | All | At once | Highlights the line that holds the caret. |

### Text Editor › Editor Tab and Status Bar

The query window's status bar: where it is, and what it shows. A property grid: True/False lists, values that differ from their default in bold.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.statusBar.executionTime` | Display execution time | One of `elapsed` (Elapsed), `end` (End), `none` (None) | Elapsed |  | All | At once | Select type of time display to include on the query window status bar: how long the query has run or ran (Elapsed), or the time its last execution ended (End). Without that bar the results head shows how long the query ran and when it ended. Greyed while `textEditor.statusBar.queryWindow` is False. |
| `textEditor.statusBar.showDatabase` | Include database name | Boolean | True |  | All | At once | Include the database name on the status bar. |
| `textEditor.statusBar.showLogin` | Include login name | Boolean | True |  | All | At once | Include login information on the status bar: the login and session id, `login (SPID)`, of the query's last execution. |
| `textEditor.statusBar.showRowCount` | Include row count | Boolean | True |  | All | At once | Include count of returned rows on the query window status bar. Without that bar the results head shows the rows. Greyed while `textEditor.statusBar.queryWindow` is False. |
| `textEditor.statusBar.showServer` | Include server name | Boolean | True |  | All | At once | Include server name on the status bar, with the server's major and minor version. |
| `textEditor.statusBar.queryWindow` | Show query window status bar | Boolean | False |  | All | At once | Shows SSMS's status bar in the query window again, below or above the query (Status bar location), with the query's state, server, login, database, time and rows. Without it the window's status bar shows the active query's server, login and database, and the results head how its last execution went, its time and its rows. This option will be removed in a later release. Not in SSMS. |
| `textEditor.statusBar.location` | Status bar location | One of `bottom` (Bottom), `top` (Top) | Bottom |  | All | At once | Select the location of the status bar for the editor: below the query text, or above it. Greyed while `textEditor.statusBar.queryWindow` is False. |

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
| `queryResults.grid.showColumnTypes` | Show column data types in the column headers | Boolean | True |  | All | At once | Each column header shows the column's SQL type after its name, in smaller text: int, nvarchar(50), decimal(18,2). The header's tooltip names the type either way. Column widths already set are kept when this changes. Not in SSMS. |

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

A patch holds at most one entry per setting (69 today).
