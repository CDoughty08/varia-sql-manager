# Varia SQL Manager

[Client Statistics](docs/client-statistics.md) compares per-execution SqlClient traffic, counters and reply-wait timings in its own output tab.

[Retained Plans](docs/retained-plans.md) keeps bounded in-memory XML history with pinning, original execution/SQL context, reopening and explicit `.sqlplan`/XML saving. Open **Window › Execution Plan › Plan history**; snapshots survive re-execution, closed results/tabs and backend loss until this workbench window closes.

[Plan Comparison](docs/plan-comparison.md) pairs two retained snapshots or saved-plan documents, highlights structural/property changes and compares available counters, estimates, parameters, grants and warnings. Open **Plan history › Compare plans** for linked or independent side-by-side views; inputs are frozen until compared again.

Varia is a cross-platform desktop workbench for Microsoft SQL Server. It combines a SQL editor, query results, and database management tools in one application. It is under active development.

## Features

- Connect to multiple servers using SQL Server, Windows, or Microsoft Entra ID authentication.
- Write and execute T-SQL in a Monaco-based editor, with separate connections and sessions for query tabs. `GO` batches and repetitions are supported.
- Browse databases and server objects in Object Explorer, generate scripts, and perform supported object actions.
- Search every object on a server by name or inside definitions, with Match Case, Whole Word, regular expressions and filters by object type.
- View, copy, and export query results as CSV, tab-delimited text, or JSON. The results toolbar's **White space** shows spaces and tabs, or every white space character (line breaks, no-break and zero-width spaces), without changing what is copied or saved.
- Sort a results grid in memory, without running the query again: a column header's sort button sorts ascending, then descending, then back to SQL Server's order, Shift+click adds further columns, and the grid's menu has Sort Ascending, Sort Descending, Then Sort and Clear Sort. Text sorts by the column's collation, NULL first, or, with the results toolbar's **Sort text by**, by length in characters or bytes. Copy and Save Results As follow the order shown.
- Filter a results grid in memory from the grid's menu (Filter): to the selected cells' values, other values, the range from the lowest to the highest selected value, no NULLs in a column, or the rows that repeat in the selected columns or in every column. Values match as the column's collation says (case and trailing spaces ignored under a CI collation). **Keep Selected Rows** keeps exactly the rows the selection covers, whatever their values (up to 4,095 rows in 256 separate runs; more says so and changes nothing): its filter reads "12 selected rows", a grid has one, and keeping a new selection replaces it (after a duplicates filter that followed the old one, so the grid shows exactly the rows selected). Rows that arrive after it was applied to a running query are not kept. Filters stack with each other and with a sort; the result's caption counts the rows kept ("34 of 100 rows") and lists each filter with a Remove button, and Clear filters shows every row again. Search, the column profile, highlights, Copy and Save Results As follow the filtered rows. Each column header's funnel (or **Filter Column Values…**, Alt+Down in a grid) lists every distinct value of the column (a million or more, as the result's memory allows) with its count, most frequent first or by value, as a checklist with a search, Select all and Select none, and NULL as an entry; OK keeps the values ticked. It also filters by a custom condition (equals, does not equal, between, is NULL, is not NULL), and the funnel stays filled while its column has a filter.
- Highlight rows of a results grid in yellow, green, blue, purple or red from the grid menu's **Highlight** submenu, or with Ctrl+Shift+H in the last colour picked. A highlight follows its row by a unique key column Varia finds in the results (or the whole row when there is none, compared by each column's collation) through sorting and through running the query again in the same tab. When a re-run no longer returns the key column (or returns several columns of that name, none where it was), the grid says so and **Clear All Highlights** starts again. Highlights are kept only while the tab is open.
- Compare two results of one query: **Compare with Previous Result** in a results grid's menu adds a unified, git-style diff of that result against the one before it, as another result: each changed row as its old row (−) and its new one (+) with the changed values marked, added and removed rows, and one unchanged row of context around each change, with each row's number in both results. Rows are matched by a key column unique in both (or by whole rows), and text compares by its collation, so values differing only in case or trailing spaces are underlined rather than changed; **Compare with Previous Result (Exact Text)** in the command palette compares every character. A column whose type or collation changed between the two results still compares (by the earlier result's rules); one that holds binary in one and text in the other is listed as not compared. When long values were compared by the part Varia keeps, the strip says so.
- Search every results grid of a run from the results toolbar (Ctrl+F in a grid): the matching cells are found in memory, without running the query again, and marked, Enter and Shift+Enter (or F3 and Shift+F3 in a grid) step through them in the order each grid shows, and text compares by its column's collation. **Columns** searches column names instead, fading the columns that do not match.
- Transpose a result: the results toolbar's **Transpose** (or **Transpose › All Rows** on the grid's menu) adds a result whose rows are the grid's columns and whose columns are its rows, as the grid shows them sorted and filtered, so a wide row reads top to bottom. **Transpose › Selected Rows** takes only the selected rows (a record view of one or a few rows), and **Using Column as Headers** names the new columns by the selected column's values instead of Row 1, Row 2…. Every value keeps its text, NULL and truncation marks, and the new columns are text. At most 4,095 rows become columns; past that the grid says it took the first ones, so filter or select rows to see others.
- Pivot a result: the results toolbar's **Pivot** (or **Pivot Results…** on the grid's menu) opens a panel where you pick row groups, an optional column group and values (Count, Distinct Count, Sum, Average, Min or Max; Sum and Average for numeric columns only). **Build Pivot** groups the rows the grid shows, sorted and filtered, in the backend and adds the pivot as another result, with a column per column-group value and a Total, so it sorts, filters, copies and saves like any result. Text groups by the column's collation and NULL is a group of its own; decimal sums keep all 38 digits; a pivot of more than 256 column groups, 100,000 row groups or 4,000,000 figures is refused with a message saying which, rather than shown in part.
- Profile a result's columns: the results toolbar's **Profile** (or **Column Profile** on the grid's menu) opens a panel with each column's NULLs, distinct values (exact up to 16,384, then estimated; equal under the column's collation), lowest and highest values, lengths in characters and bytes, and a histogram, computed in the backend over the rows the grid shows. **Row size** draws a bar behind each row number for the row's size (the sum of DATALENGTH over its columns); hover it for the bytes.
- Use the Table Designer, Activity Monitor, live data views, and Integration Services Catalog tools.
- Split query tabs into editor groups side by side or floating, as in VS Code, and keep them across restarts with hot exit.
- Query tabs show the filename above their environment and live session ID, leaving short names readable without widening the tab.
- Customize themes and workspace layouts, and access commands through the command palette.

Varia targets SQL Server 2016 through 2025 and runs on Windows, Linux, and macOS. Some features require specific server versions or permissions; see the [documentation](#documentation) for details.

## Getting started

See the [changelog](CHANGELOG.md) for release highlights and upgrade notes.

Download a build from [GitHub Releases](https://github.com/CDoughty08/varia-sql-manager/releases): the Windows x64 Setup or Portable executable, Linux x64 AppImage, or macOS DMG or ZIP for Apple Silicon or Intel. These builds include the .NET backend and do not require the SDK. They are currently unsigned; macOS builds are also not notarized, so the operating system may warn or block them. On Linux, the AppImage requires FUSE and an available desktop/keyring for encrypted remembered passwords.

The Windows Setup opens a wizard where you choose installation for your account or all users and confirm the installation. For unattended deployment, run `Varia-SQL-Manager-<version>-Windows-x64-Setup.exe --silent` (the standard NSIS `/S` flag also works). Silent installations default to the current user for a fresh install; `/allusers` requests an all-users installation and may require elevation. The Portable executable runs without an installation; it extracts the application to a temporary directory and uses the normal user profile for settings and saved connections. The Linux AppImage and extracted macOS ZIP can likewise run without an installer.

Installed, portable and AppImage builds check GitHub for new releases, download them in the background with their progress in the status bar, verify each file's SHA-512, and install on **Restart to Update**. An installed Windows copy also unpacks the release beside itself while you work, so the restart only swaps it in. macOS builds are not code signed, so they tell you about a release and open the releases page instead of installing it. Behind a corporate proxy or filter, a failed check says why (proxy, certificate, DNS, blocked) and what to ask IT to allow: `github.com` and `release-assets.githubusercontent.com`. See [updates](docs/updates.md); **Tools › Options › Environment › Product Updates** turns automatic checks and downloads off.

To run from source:

Prerequisites: Node.js 24 or newer and the .NET 10 SDK. The SDK version is configured in `global.json`.

```sh
npm ci
npm run dev
```

The development command builds the backend and starts Electron with renderer hot reload. Restart it after changing C# code. To build and run the application without the development server:

```sh
npm run build
npm start
```

On Ubuntu 24.04 and later, AppArmor may block the unprivileged user namespaces needed by Electron's Chromium sandbox. Configure AppArmor to permit them if Electron cannot start.

## Connecting and running queries

1. Select **Connect**, enter a server and database, and choose an authentication method.
2. Open a new query, write SQL, and select **Execute** or press **F5**. A selection runs instead of the full document.
3. Inspect the results and messages, or browse and script objects in Object Explorer.

The Execute button says **Execute selection** with its line range when text is selected; **Entire query** means the
whole document will run. Click the status bar's **Ln/Col** to go to a line, or **INS/OVR** to switch insert/overtype mode.
Each editor group's **+**, or a double-click on empty tab-strip space, opens a query in that group. **Reopen Closed Query**
(Ctrl+Shift+T; Cmd+Shift+T on macOS) restores a bounded, in-memory unsaved copy without its old connection or saved-file
association; see [editor groups](docs/editor-groups.md).

In Connect, single-click or Space selects a saved connection for editing; Enter or double-click connects. Object
Explorer's recovery rows offer **Retry**, **Continue loading**, and **Filter** actions. Search Objects opened from a
database starts with that database's visible, removable scope.

The [result grid tools](docs/results-tools.md) include **Copy Column Name**, keyboard-accessible **Fit Column**, and
**Close Results** beside the results. Located SQL errors offer **Go to line** while the source text is unchanged.

Certificate validation is enabled by default. For a trusted server with a self-signed certificate, enable **Trust server certificate** in the connection dialog. On Linux and macOS, Windows authentication requires the system Kerberos library, a valid ticket from `kinit`, and a server name or SPN configured for Kerberos. Entra Integrated authentication is available on Windows only. Remembered passwords are encrypted using the operating system's credential storage; on Linux this requires an available keyring.

Press **F1** or **Ctrl+Shift+P** (**⌘Shift+P** on macOS) for the command palette. See the [command reference](docs/commands.md) for shortcuts and available commands.

Open **Help > About Varia** for the running version, update status and copyable version details for support. The macOS
app menu opens the same dialog. It works without a server connection; see [About Varia](docs/about.md).

**Help > Getting Started** opens searchable offline connection, query and results guides. References follow your
applied shortcuts, mouse gestures and options; interactive examples use fictional data. See [Getting Started](docs/getting-started.md).

**Help > Release Notes** opens curated, offline notes for the running version, with a picker for bundled release
history. Update notifications request their exact advertised version; missing notes are reported clearly. **Release
Downloads** remains a separate browser action. See [Release Notes](docs/release-notes.md).

## Current limitations

- Turn on **Include Live Execution Plan** in the query toolbar or Query menu before executing a query in Varia. The same **Execution Plan** output tab shows **Live** operator row counts and activity during execution, then switches to **Actual** captured data. Camera, statement and operator selection survive counter updates and matching actual plans. Completed statements and `GO` repetitions stay distinct; cancellation or a lost backend retains explicitly partial live data. Hidden views follow the live-data pause settings and are never polled by the renderer.
  Live profiling uses a separate observer and requires SQL Server 2017 CU14 or later (or Azure SQL), lightweight profiling, and `VIEW SERVER STATE` through 2019 or `VIEW SERVER PERFORMANCE STATE` from 2022; Azure SQL requires database-state access or an administrator for its tier. Actual completion capture additionally needs the Extended Events permissions described below. Unsupported capture leaves query execution available. Live sampling is at most once a second, slows under load, and waits for renderer credit. Short statements can finish between samples. Live samples are limited to 1,048,576 XML characters, 2,000 operators and a 192 KiB payload; a run retains up to 512 statements, 10,000 operators and 4 MiB of parsed live data, with at most eight live snapshots retained per window. Completed actual plans use the existing larger limits. See [Live Plan implementation and validation](docs/live-plans.md).
- **Display Estimated Execution Plan** in the Query menu or toolbar (**Ctrl+L**, **⌘L** on macOS) compiles the query or selection without execution and labels it **Estimated** in the existing plan viewer. Estimation uses an isolated connection with the selected database and Varia defaults; the query tab's existing temporary objects, SET options and uncommitted changes are unavailable. See [estimated plans](docs/estimated-plans.md) for GO/USE handling, limits and session behavior.
- Turn on **Include Actual Execution Plan** in the query toolbar or Query menu before executing. The toggle applies to the current query tab. SQL Server's captured plans appear after execution in the **Execution Plan** output pane, with data grids in **Results**. Plans returned by manual `SET SHOWPLAN_XML` or `SET STATISTICS XML` and opened `.sqlplan` files use the same GPU canvas. Drag or scroll to pan, pinch or Ctrl-scroll to zoom, and use **Fit statement**, **Fit batch**, the searchable operator outline, and the properties inspector. The graph shows runtime statistics, operator warnings and missing-index notices when SQL Server supplies them, and labels estimated costs. **XML source** in a plan document opens the editable XML for saving and recovery.
  Automatic capture uses lightweight Extended Events and requires permission to create, start, read and drop its event session. Varia runs the query normally and reports unavailable capture in **Messages**. Use the **XML source** picker in **Execution Plan** to open a captured document even if its graph is unavailable.
  A later server-scoped capture also recovers abandoned collectors created by this version after application or backend failure, using ownership and physical-connection checks within the setup deadline. See [collector recovery and integration coverage](docs/plan-capture-hardening.md) for legacy/database-scoped limitations and verified server versions.
- The plan viewer accepts at most 8,388,608 XML characters (2 MiB compressed), 10,000 operators, 512 statements and 256 XML levels. Open accepts `.sqlplan` and Showplan `.xml` files up to 16 MiB. Ordinary SQL files keep their 5 MB limit. The canvas graphs up to the first 64 plan documents within twice the per-document character budget. Further retained plans can be opened as XML. Shortened properties are reported. Query-returned plans keep the 2,097,152-character result-cell cap. Truncated plans can be opened as XML.
- Plan properties expose structured predicates, output columns, parameters, memory grants, spills, warning details, missing-index columns and worker counters when supplied. The outline ranks available CPU, elapsed time and row-estimate discrepancy, including measured zeros. Costs remain estimates; unavailable counters stay unavailable. See [diagnostic scopes and limits](docs/plan-diagnostics.md).
- SQL Server [IntelliSense](docs/language-services.md) includes a bundled language server for completion, hover and query diagnostics with SQL Login and Windows authentication. **Ctrl+Shift+R** refreshes the current query's metadata cache after schema changes. Entra IntelliSense, SQLCMD mode, backup, security management, and job management remain future work. Restore Database restores from backups already taken.
- Results are held in memory and subject to size limits; truncation is indicated in the application. Results to Text and Results to File are not yet available, though grid results can be exported.
- Review generated scripts before executing them. Some management and Integration Services operations are still limited; see the relevant documentation below.

## Development and testing

```sh
npm run check          # Typecheck, backend and UI tests, production UI build
npm run test:smoke     # Electron smoke tests; run check first
npm run test:electron  # check followed by smoke tests
npm run bench          # IPC benchmarks; run check first
```

The default checks do not require a database. On headless Linux, run the smoke tests under a virtual display:

```sh
xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke
```

To run optional live tests, set `VARIA_TEST_SQL_SERVER` and, for SQL authentication, `VARIA_TEST_SQL_USER` and `VARIA_TEST_SQL_PASSWORD`, then run `npm run backend:test`. The smoke tests also use these settings. Use a disposable development server: live tests can create and remove test objects, and `VARIA_TEST_SQL_SCRATCH=1` enables additional tests that create and drop databases and server objects. `VARIA_TEST_SSIS_CREATE=1` enables a destructive SSIS Catalog creation test; see the [Integration Services documentation](docs/integration-services.md) before using it.

## Creating a release

Release builds package and smoke-test every push to main, and pull requests that change packaging (docs/ci.md). To get installers without a release, run the **Release builds** Actions workflow manually: its installers are available as workflow artifacts for seven days. Prepare a release by updating `package.json` and `package-lock.json` together and recording the changes in [CHANGELOG.md](CHANGELOG.md). After merging those changes, push a matching tag (for example, `v0.7.0` for version `0.7.0`). The tag triggers all platform builds; once they and their packaged-app smoke checks pass, the workflow publishes a GitHub Release with the installers, the update manifests (`varia-update-v2.json`, which installed copies check, and `varia-update.json` for copies up to 0.7.0) and GitHub-generated release notes. Prepend the changelog's release highlights to the published notes. A version with a prerelease suffix (such as `v0.7.0-beta.1`) is published as a prerelease. Existing releases are not overwritten: resolve or remove an existing release before rerunning its release job.

## Architecture

The Electron application uses React, TypeScript, Monaco, and Dockview. electron-vite bundles every npm package into the app, so `package.json` lists them all under devDependencies and the package holds no `node_modules`, but those devDependencies ship: zod, React, Monaco (with its DOMPurify), Dockview, PixiJS and elkjs run in every copy, so audit dependencies without `--omit=dev` and treat their advisories as production ones. A .NET sidecar handles SQL connections and management through Microsoft.Data.SqlClient and SQL Management Objects (SMO). The processes communicate over a MessagePack-based protocol; see the [IPC reference](docs/ipc.md).

The workbench page is treated as untrusted: it runs sandboxed with context isolation, no Node.js integration and a strict Content Security Policy, and reaches the system only through a small preload API whose every call main verifies. Built pages load from Varia's own `app://varia/` origin, never a `file:` URL, so page script cannot read local files. Packaged builds set Electron's fuses (`build/fuses.cjs`): `file:` pages get no extra privileges, the executable cannot run as Node.js or honour `NODE_OPTIONS` and `--inspect`, and the application loads only from its integrity-checked `app.asar`.

## Documentation

- [SQL language services and IntelliSense](docs/language-services.md)
- [Commands and shortcuts](docs/commands.md)
- [Mouse gestures](docs/gestures.md)
- [Editor groups](docs/editor-groups.md), [hot exit](docs/hot-exit.md) and [popout windows](docs/popout-windows.md)
- [Object Explorer](docs/object-explorer.md), [object actions](docs/object-actions.md) and [Search Objects](docs/object-search.md)
- [Scripting](docs/scripting.md) and [Table Designer](docs/table-designer.md)
- [Activity Monitor](docs/activity-monitor.md), [live data](docs/live.md), and [Integration Services](docs/integration-services.md)
- [Settings](docs/settings.md) and [themes](docs/themes/README.md)
- [Updates](docs/updates.md)
- [IPC and benchmarks](docs/ipc.md)
