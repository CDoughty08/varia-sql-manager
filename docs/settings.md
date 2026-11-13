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
  - Shortcuts (`environment.shortcuts`)
  - Product Updates (`environment.productUpdates`)
  - Live Data (`environment.liveData`)
  - Object Explorer (`environment.objectExplorer`)
- Text Editor
  - General (`textEditor.general`)
  - Editor Tab and Status Bar (`textEditor.editorTabAndStatusBar`)
  - Transact-SQL
    - General (`textEditor.transactSql.general`)
    - IntelliSense (`textEditor.transactSql.intelliSense`)
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
- Activity Monitor (`activityMonitor`)
- SQL Server Integration Services (`integrationServices`)

A node without a page id is a category: selecting it shows its first page. The search box (Ctrl+E, ⌘E on macOS) matches
page titles, setting labels, descriptions and keywords.

## Settings

### Environment › General

Its first row is a note: Color theme: View › Theme (stored in `appearance.json`).

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.layout.classicToolbar` | Show the classic toolbar | Boolean | False |  | All | At once | Shows the text toolbar of earlier versions below the header: Connect, New query, Open, Save, Save All, Execute, Cancel and Layouts, with the active query's Server and Database boxes. The header then keeps only the menus and the search box, and query tabs show no query bar of their own. This option will be removed in a later release. Not in SSMS. |
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
| `environment.documents.hotExit` | Restore open queries on startup | Boolean | True |  | All | At once | Closing Varia SQL Manager keeps open queries, including unsaved text, tab names and tab order, in your profile folder. The next start reopens them disconnected. While it is False, only pinned tabs reopen, and closing asks about unsaved changes in unpinned queries. Results, connections and passwords are never kept. |
| `environment.documents.detectExternalChanges` | Detect when file is changed outside the environment | Boolean | True |  | All | At once | When the window gets focus, checks whether another program changed or deleted an open file, and asks whether to reload a changed one. Save also asks before replacing such changes. |
| `environment.documents.autoReload` | Reload modified files unless there are unsaved changes | Boolean | False |  | All | At once | Reloads a file changed outside Varia SQL Manager without asking when its query has no unsaved changes. A query with unsaved changes still asks. Greyed while `environment.documents.detectExternalChanges` is False. |
| `environment.documents.saveWithSpecificEncoding` | Save files with a specific encoding | Boolean | False |  | All | At once | Saves every file in Save encoding, converting files read in another encoding. While it is False, a file keeps the encoding it was opened in, and a new query is saved as UTF-8 without a byte order mark: SSMS 22 starts a new query from an empty template that has none. |
| `environment.documents.saveEncoding` | Save encoding | One of `utf8bom` (Unicode (UTF-8 with signature)), `utf8` (Unicode (UTF-8 without signature)), `utf16le` (Unicode), `utf16be` (Unicode (Big-Endian)) | Unicode (UTF-8 with signature) |  | All | At once | The encoding every file is saved in while Save files with a specific encoding is True. Unicode is UTF-16 little-endian. Greyed while `environment.documents.saveWithSpecificEncoding` is False. |

### Environment › Fonts and Colors

Colors come from the color theme (View › Theme).

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.fonts.editorFontSize` | Size | Integer 8–72 px | 13 px | 10 pt Consolas (SSMS 18–20; SSMS 22 not verified) | All | At once | The query editor's font size, in CSS pixels. |

### Environment › Shortcuts

Keyboard and mouse shortcuts: SSMS's defaults, your changes, and the scope each works in. Changes apply when you choose OK. Not settings: a table of the shortcuts of every command above an inspector, with mouse gestures beside them. They are stored in `shortcuts.json`, not `settings.json` (docs/commands.md lists the defaults).

_No settings yet._

### Environment › Product Updates

How Varia SQL Manager finds, downloads and installs new releases.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `environment.updates.checkAutomatically` | Automatically check for updates | Boolean | True |  | All | At once | Checks Varia SQL Manager's releases on GitHub shortly after start-up and every four hours while it runs. Help › Check for Updates checks at any time. The check reads one small file from github.com through the system's proxy settings and sends nothing about you or your servers. |
| `environment.updates.downloadAutomatically` | Automatically download updates | Boolean | True |  | All | At once | Downloads a new release in the background as soon as a check finds it, and verifies it against the release's checksum; the status bar shows its progress. Nothing installs until you choose Restart to Update. While it is False, the status bar offers the update and Help › Download Update downloads it. macOS builds do not download updates (they are not code signed): there a check only says that a release exists, whatever this is set to. Not in SSMS. Greyed while `environment.updates.checkAutomatically` is False. |

### Environment › Live Data

Live views, such as the Activity Monitor: when they pause while hidden, and how much chart history they keep. Not in SSMS.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `liveData.pauseWhenHidden` | Pause live views that are hidden | Boolean | True |  | All | At once | Stops a live view's queries on the server while its tab is not the one showing, or the window is minimized or hidden, and starts them again as soon as it shows. Charts show the gap. While it is False, hidden views keep querying at their usual intervals. Not in SSMS. |
| `liveData.pauseAfterSeconds` | Pause after hidden for | Integer 1–60 seconds | 2 seconds |  | All | At once | How long a live view stays hidden before its queries stop, so switching tabs for a moment loses no samples. Not in SSMS. Greyed while `liveData.pauseWhenHidden` is False. |
| `liveData.stopAfterHiddenMinutes` | Stop after hidden for | Integer 1–60 minutes | 5 minutes |  | All | At once | How long a paused, hidden live view keeps its subscription before it ends it and frees what the backend holds for it. Showing the view again starts a new subscription; its history is kept. Not in SSMS. Greyed while `liveData.pauseWhenHidden` is False. |
| `liveData.explorerStatus` | Show live status in Object Explorer | Boolean | True |  | All | At once | While Object Explorer shows, reads each connected server's database states, restore progress, running SQL Server Agent jobs and availability group health every few seconds, on one session of its own per server, and shows them as chips on the nodes. It pauses while Object Explorer or the window is hidden, and never reloads the tree. While it is False, nodes show only what their list said when it loaded. Not in SSMS. |
| `liveData.historyMinutes` | Keep chart history for | Integer 5–120 minutes | 60 minutes |  | All | At once | How far back each live view's charts reach. History is kept in memory only (at most 7,200 samples a chart, 4 MiB a view and 32 MiB in all; the newest samples are kept), never on disk, and is lost when the window reloads. Not in SSMS. |

### Environment › Object Explorer

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `objectExplorer.followActiveQuery` | Follow active query | Boolean | True |  | All | At once | When switching query tabs, bring the server into view if its header is off-screen. Not in SSMS. |
| `objectExplorer.pinnedServerHeadersTop` | Pinned server headers at top | Integer 0–10 | 2 |  | All | At once | Maximum number of off-screen server headers to show at the top of the tree. Choose 0 to hide this edge. A short pane may fit fewer headers. Not in SSMS. |
| `objectExplorer.pinnedServerHeadersBottom` | Pinned server headers at bottom | Integer 0–10 | 2 |  | All | At once | Maximum number of off-screen server headers to show at the bottom of the tree. Choose 0 to hide this edge. A short pane may fit fewer headers. Not in SSMS. |

### Text Editor › General

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.dragAndDrop` | Enable mouse click to perform drag-and-drop text editing | Boolean | True |  | All | At once | Selected text can be dragged to move it, or copied with Ctrl held (Option on macOS). |
| `textEditor.multiCursorModifier` | Add a cursor with | One of `alt` (Alt+Click (Option on macOS)), `ctrlCmd` (Ctrl+Click (Command on macOS)) | Alt+Click (Option on macOS) |  | All | At once | The modifier that adds another cursor where you click in the query editor. The mouse gestures list shows it too. Not in SSMS. |
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

### Text Editor › Transact-SQL › IntelliSense

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `textEditor.sql.errorChecking` | Enable error checking | Boolean | True |  | All | At once | Checks query syntax and database object references while editing. Red underlines mark errors and yellow underlines mark warnings. Analysis does not execute the query. |

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
| `queryResults.plan.outline` | Show execution plan outline | Boolean | True |  | All | At once | Show the searchable, keyboard accessible operator outline. Not in SSMS. |
| `queryResults.plan.properties` | Show execution plan properties | Boolean | True |  | All | At once | Show properties for the selected statement or operator. Not in SSMS. |
| `queryResults.plan.minimap` | Show execution plan minimap | Boolean | True |  | All | At once | Show a bounded overview of the plan and its viewport. Not in SSMS. |
| `queryResults.plan.rowFlow` | Show execution plan row flow | Boolean | True |  | All | At once | Label edges with actual, estimated, unavailable or partial live rows. Not in SSMS. |
| `queryResults.plan.outlineWidth` | Execution plan outline width | Integer 120–600 | 220 |  | All | At once | Preferred outline width in pixels. The pane shrinks to fit a small window. Not in SSMS. |
| `queryResults.plan.propertiesWidth` | Execution plan properties width | Integer 140–600 | 260 |  | All | At once | Preferred properties width in pixels. The pane shrinks to fit a small window. Not in SSMS. |
| `queryResults.grid.includeColumnHeaders` | Include column headers when copying or saving the results | Boolean | False |  | All | At once | Copy and Save Results As (CSV and tab-delimited text) start with a row of column names. JSON always names its keys, and Copy with Headers always includes them. |
| `queryResults.grid.discardResults` | Discard results after execution | Boolean | False |  | All | Next execution | The query runs and every row is read from the server, but none is kept or shown: the Messages tab has the row counts and says how many result sets and rows were discarded. Execution plans and client statistics are still collected. For timing a large query without spending memory on its rows. |
| `queryResults.grid.maxResultSets` | Maximum result sets kept per execution | Integer 1–1,000 | 1,000 |  | All | Next execution | Result sets after this many still run and are counted, but their rows are not kept; the Messages tab says so. Not in SSMS. |
| `queryResults.grid.maxRows` | Maximum rows kept per execution (0: no limit) | Integer 0–2,147,483,647 | 0 |  | All | Next execution | Rows after this many, counted over every result set of one execution, are still read and counted, but not kept; the grid says how many of how many it shows. The query itself is not changed, so the server still returns every row. Not in SSMS. |
| `queryResults.grid.memoryLimitGiB` | Result memory limit in GiB (0: automatic) | Integer 0–1,024 | 0 |  | All | Next backend start | How much memory all query results may hold together; one query may use half of it. Automatic is a quarter of the computer's memory, at least 256 MiB and at most 16 GiB. A limit set here is used as it is, up to three quarters of the computer's memory. Rows past the limit are still read and counted, but not kept. Sorting, filtering, pivoting or profiling a result takes its working memory from the same limit, so a result that fills its share leaves no room for them. Not in SSMS. |
| `queryResults.grid.showColumnTypes` | Show column data types in the column headers | Boolean | True |  | All | At once | Each column header shows the column's SQL type after its name, in smaller text: int, nvarchar(50), decimal(18,2). The header's tooltip names the type either way. Column widths already set are kept when this changes. Not in SSMS. |
| `queryResults.grid.whitespace` | Show white space in results | One of `none` (Off), `spaces` (Spaces and tabs), `all` (All white space) | Off |  | All | At once | Spaces show as a raised dot (·) and tabs as an arrow (→) in the results grid. All white space also names line breaks (CR, LF, CRLF) and the invisible characters that make values look alike: no-break and zero-width spaces, BOM and the other Unicode spaces. The marks are only drawn: Copy and Save Results As write the values as they are. The results toolbar changes this too. Not in SSMS. |
| `queryResults.grid.sortText` | Sort text columns by | One of `value` (Value), `chars` (Length in characters), `bytes` (Length in bytes) | Value |  | All | At once | How a sorted results grid orders its text and binary columns. Value sorts as ORDER BY would, by the column's collation, with NULL first ascending. Length in characters counts every character, spaces included; length in bytes sorts by DATALENGTH. Other columns always sort by value. The results toolbar changes this too, and sorted grids sort again. Not in SSMS. |
| `queryResults.grid.rowSize` | Show row size behind row numbers | Boolean | True |  | All | At once | A bar behind each row number shows the row's size, the sum of DATALENGTH over its columns, scaled to the largest row of the result (or of its filtered rows); rows over half the largest stand out. Hover a row number for the exact bytes. The results toolbar changes this too. Not in SSMS. |
| `queryResults.grid.columnProfile` | Show the column profile panel | Boolean | False |  | All | At once | A panel beside the results describes each column of the result set that last had focus: its NULLs, distinct values (by the column's collation), lowest and highest values, lengths in characters and bytes, and a histogram. It describes the rows as the grid shows them, sorted or filtered, and is computed in the SQL backend. The results toolbar changes this too. Not in SSMS. |

### SQL Server Object Explorer › Commands

A property grid: True/False lists, values that differ from their default in bold.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `objectExplorer.selectTopRows` | Value for Select Top &lt;n> Rows command | Integer 1–2,147,483,647 | 1,000 |  | All | At once | How many rows Select Top Rows reads, and the number its menu item shows. |
| `objectExplorer.groupBySchema` | Group by Schema | Boolean | False |  | All | At once | Lists each database's schemas after its own folders, with the Tables, Views, Synonyms and Programmability folders of each schema below it; Database Triggers, Assemblies and Plan Guides stay in the database's Programmability folder. A filter below a schema applies to that schema's folder only. The Object Explorer toolbar's Group by Schema button turns it on and off. |
| `objectExplorer.search.indexOnConnect` | Index objects when a server connects | Boolean | True |  | All | At once | Reads the names of every object Object Explorer lists that you may see, from logins and databases down to columns and parameters, two databases at a time on a session of their own, so Search Objects finds them whether or not Object Explorer has loaded them. The index stays in memory and is dropped when the server disconnects. While it is False, a server is indexed only when you ask: Build index in Search Objects, or Rebuild Search Index. Not in SSMS. |
| `objectExplorer.search.definitions` | Index module definitions | Boolean | True |  | All | At once | Also keeps the text of procedures, functions, views and triggers you may VIEW DEFINITION of, so Search Objects can find text inside them (up to 1,000,000 characters of each, within the index’s 512 MiB). Applies to the next build. Not in SSMS. |

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

### Activity Monitor

What a new Activity Monitor starts with, and when its tiles warn. Not in SSMS.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `activityMonitor.refreshIntervalSeconds` | Refresh interval | One of `1` (1 second), `2` (2 seconds), `3` (3 seconds), `5` (5 seconds), `10` (10 seconds), `15` (15 seconds), `30` (30 seconds), `60` (60 seconds) | 2 seconds |  | All | At once | How often a new Activity Monitor samples the server. Resource waits and file I/O are read every 5 seconds at most, and the header changes an open monitor's interval. Not in SSMS. |
| `activityMonitor.queriesIntervalSeconds` | Query statistics interval | Integer 15–60 seconds | 30 seconds |  | All | At once | How often a new Activity Monitor reads the plan cache for Recent Expensive Queries, and the window its rates span. Reading the plan cache costs more than the other samples, so it has its own, longer interval; it runs only while that pane is shown. Not in SSMS. |
| `activityMonitor.chartWindowMinutes` | Chart window | One of `1` (1 minute), `5` (5 minutes), `15` (15 minutes), `60` (60 minutes) | 15 minutes |  | All | At once | How much time a new Activity Monitor's tiles and charts show. Charts reach back only as far as Environment › Live Data keeps history. Not in SSMS. |
| `activityMonitor.primaryPane` | First pane | One of `processes` (Sessions), `blocking` (Blocking), `waits` (Resource Waits), `fileIo` (Data File I/O), `recentQueries` (Recent Expensive Queries), `activeQueries` (Active Expensive Queries) | Sessions |  | All | At once | The pane a new Activity Monitor shows first (on the left, or on top in a narrow window). Not in SSMS. |
| `activityMonitor.secondaryPane` | Second pane | One of `processes` (Sessions), `blocking` (Blocking), `waits` (Resource Waits), `fileIo` (Data File I/O), `recentQueries` (Recent Expensive Queries), `activeQueries` (Active Expensive Queries), `none` (None (no split view)) | Resource Waits |  | All | At once | The pane a new Activity Monitor shows beside the first in split view. None opens it with one pane; Split View shows a second one again. Not in SSMS. |
| `activityMonitor.cpuWarningPercent` | Processor time warning | Integer 50–100 percent | 80 percent |  | All | At once | The % Processor Time tile is outlined as a warning from this much SQL Server CPU, and as an error from 95 %. Not in SSMS. |
| `activityMonitor.blockedWarningSeconds` | Blocking warning after | Integer 1–3,600 seconds | 5 seconds |  | All | At once | The Blocked Sessions tile is outlined as a warning once a session has waited on another this long. Not in SSMS. |
| `activityMonitor.blockedErrorSeconds` | Blocking error after | Integer 1–3,600 seconds | 30 seconds |  | All | At once | The Blocked Sessions tile is outlined as an error once a session has waited on another this long. Not in SSMS. |
| `activityMonitor.fileLatencyWarningMs` | I/O latency warning | Integer 1–10,000 ms | 20 ms |  | All | At once | The Database I/O tile is outlined as a warning, and Data File I/O tones a file as a warning, when reads or writes take this long on average over the interval. Not in SSMS. |
| `activityMonitor.fileLatencyErrorMs` | I/O latency error | Integer 1–10,000 ms | 50 ms |  | All | At once | The Database I/O tile is outlined as an error, and Data File I/O tones a file as an error, when reads or writes take this long on average over the interval. Below the warning threshold it acts as the warning one. Not in SSMS. |

### SQL Server Integration Services

How Varia follows the SSIS Catalog (SSISDB) as it changes. Not in SSMS.

| Setting key | Label | Type and bounds | Default | SSMS default | Platforms | Applies | What it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `integrationServices.treeLive` | Update the SSIS Catalog in Object Explorer as it changes | Boolean | True |  | All | At once | While a connection's SSISDB node is open in Object Explorer, Varia checks the catalog for changes made elsewhere, such as a deployment or a new folder, project or environment, and updates only the folders that changed, keeping what is expanded and selected. The check is one small query that pauses while Object Explorer is hidden. While it is False, the tree changes only on Refresh (F5) and after Varia's own changes. Not in SSMS. |
| `integrationServices.treeRefreshSeconds` | Check the catalog for changes every | Integer 10–300 seconds | 30 seconds |  | All | At once | How often an open SSISDB node checks the catalog for changes. Each check reads every catalog folder, project, package, environment, variable, reference and parameter the login may see, so a large catalog on a busy server may want a longer interval. Not in SSMS. Greyed while `integrationServices.treeLive` is False. |
| `integrationServices.operationsRefreshSeconds` | Update Operations every | Integer 1–60 seconds | 2 seconds |  | All | At once | How often an open Integration Services Operations document reads the catalog for new operations and the open ones' status. It pauses while the document is hidden. A busy catalog on a busy server may want a longer interval. Not in SSMS. |
| `integrationServices.operationsWindowHours` | Show operations created in the last | Integer 1–8,760 hours | 24 hours |  | All | At once | The window a new Operations document opens on. Its Window filter changes it for that document only. The catalog keeps operations for its own retention period (365 days by default), so a longer window shows nothing older than that. Not in SSMS. |
| `integrationServices.operationsLimit` | Show at most | Integer 100–10,000 operations | 1,000 operations |  | All | At once | The most operations an Operations document holds: the newest ones of its window that pass its filters, open ones first. Open documents read their window again with the new limit. The tiles count every operation the login may see, whatever this limit and the filters are. Not in SSMS. |
| `integrationServices.confirmStop` | Ask before Stop Operation | Boolean | True |  | All | At once | Asks before Stop Operation ends a running package or validation. The package stops after its current work; the catalog then lists it as Stopping, and Canceled once it has ended. While it is False, Stop Operation stops at once. Not in SSMS. |

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

A patch holds at most one entry per setting (114 today).
