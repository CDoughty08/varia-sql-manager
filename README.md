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
- Use the Table Designer, Activity Monitor, live data views, and Integration Services Catalog tools.
- Split query tabs into editor groups side by side or floating, as in VS Code, and keep them across restarts with hot exit.
- Customize themes and workspace layouts, and access commands through the command palette.

Varia targets SQL Server 2016 through 2025 and runs on Windows, Linux, and macOS. Some features require specific server versions or permissions; see the [documentation](#documentation) for details.

## Getting started

Download a build from [GitHub Releases](https://github.com/CDoughty08/varia-sql-manager/releases): the Windows x64 Setup or Portable executable, Linux x64 AppImage, or macOS DMG or ZIP for Apple Silicon or Intel. These builds include the .NET backend and do not require the SDK. They are currently unsigned; macOS builds are also not notarized, so the operating system may warn or block them. On Linux, the AppImage requires FUSE and an available desktop/keyring for encrypted remembered passwords.

The Windows Setup opens a wizard where you choose installation for your account or all users and confirm the installation. For unattended deployment, run `Varia-SQL-Manager-<version>-Windows-x64-Setup.exe --silent` (the standard NSIS `/S` flag also works). Silent installations default to the current user for a fresh install; `/allusers` requests an all-users installation and may require elevation. The Portable executable runs without an installation; it extracts the application to a temporary directory and uses the normal user profile for settings and saved connections. The Linux AppImage and extracted macOS ZIP can likewise run without an installer.

Installed, portable, AppImage and macOS builds check GitHub for new releases, download them in the background with their progress in the status bar, verify each file's SHA-512, and install on **Restart to Update** (macOS opens the new disk image instead). Behind a corporate proxy or filter, a failed check says why (proxy, certificate, DNS, blocked) and what to ask IT to allow: `github.com` and `release-assets.githubusercontent.com`. See [updates](docs/updates.md); **Tools › Options › Environment › Product Updates** turns automatic checks and downloads off.

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

Certificate validation is enabled by default. For a trusted server with a self-signed certificate, enable **Trust server certificate** in the connection dialog. On Linux and macOS, Windows authentication requires the system Kerberos library, a valid ticket from `kinit`, and a server name or SPN configured for Kerberos. Entra Integrated authentication is available on Windows only. Remembered passwords are encrypted using the operating system's credential storage; on Linux this requires an available keyring.

Press **F1** or **Ctrl+Shift+P** (**⌘Shift+P** on macOS) for the command palette. See the [command reference](docs/commands.md) for shortcuts and available commands.

## Current limitations

- Turn on **Include Live Execution Plan** in the query toolbar or Query menu before executing a query in Varia. The same **Execution Plan** output tab shows **Live** operator row counts and activity during execution, then switches to **Actual** captured data. Camera, statement and operator selection survive counter updates and matching actual plans. Completed statements and `GO` repetitions stay distinct; cancellation or a lost backend retains explicitly partial live data. Hidden views follow the live-data pause settings and are never polled by the renderer.
  Live profiling uses a separate observer and requires SQL Server 2017 CU14 or later (or Azure SQL), lightweight profiling, and `VIEW SERVER STATE` through 2019 or `VIEW SERVER PERFORMANCE STATE` from 2022; Azure SQL requires database-state access or an administrator for its tier. Actual completion capture additionally needs the Extended Events permissions described below. Unsupported capture leaves query execution available. Live sampling is at most once a second, slows under load, and waits for renderer credit. Short statements can finish between samples. Live samples are limited to 1,048,576 XML characters, 2,000 operators and a 192 KiB payload; a run retains up to 512 statements, 10,000 operators and 4 MiB of parsed live data, with at most eight live snapshots retained per window. Completed actual plans use the existing larger limits. See [Live Plan implementation and validation](docs/live-plans.md).
- **Display Estimated Execution Plan** in the Query menu or toolbar (**Ctrl+L**, **⌘L** on macOS) compiles the query or selection without execution and labels it **Estimated** in the existing plan viewer. Estimation uses an isolated connection with the selected database and Varia defaults; the query tab's existing temporary objects, SET options and uncommitted changes are unavailable. See [estimated plans](docs/estimated-plans.md) for GO/USE handling, limits and session behavior.
- Turn on **Include Actual Execution Plan** in the query toolbar or Query menu before executing. The toggle applies to the current query tab. SQL Server's captured plans appear after execution in the **Execution Plan** output pane, with data grids in **Results**. Plans returned by manual `SET SHOWPLAN_XML` or `SET STATISTICS XML` and opened `.sqlplan` files use the same GPU canvas. Drag or scroll to pan, pinch or Ctrl-scroll to zoom, and use **Fit statement**, **Fit batch**, the searchable operator outline, and the properties inspector. The graph shows runtime statistics, operator warnings and missing-index notices when SQL Server supplies them, and labels estimated costs. **XML source** in a plan document opens the editable XML for saving and recovery.
  Automatic capture uses lightweight Extended Events and requires permission to create, start, read and drop its event session. Varia runs the query normally and reports unavailable capture in **Messages**. Use the **XML source** picker in **Execution Plan** to open a captured document even if its graph is unavailable.
- The plan viewer accepts at most 8,388,608 XML characters (2 MiB compressed), 10,000 operators, 512 statements and 256 XML levels. Open accepts `.sqlplan` and Showplan `.xml` files up to 16 MiB. Ordinary SQL files keep their 5 MB limit. The canvas graphs up to the first 64 plan documents within twice the per-document character budget. Further retained plans can be opened as XML. Shortened properties are reported. Query-returned plans keep the 2,097,152-character result-cell cap. Truncated plans can be opened as XML.
- Plan properties expose structured predicates, output columns, parameters, memory grants, spills, warning details, missing-index columns and worker counters when supplied. The outline ranks available CPU, elapsed time and row-estimate discrepancy, including measured zeros. Costs remain estimates; unavailable counters stay unavailable. See [diagnostic scopes and limits](docs/plan-diagnostics.md).
- SQLCMD mode, schema-aware IntelliSense, backup, security management, and job management are not yet available. Restore Database restores from backups already taken.
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

Release builds run on pull requests and can also be run manually from the **Release builds** Actions workflow. Their installers are available as workflow artifacts for seven days. After merging the desired changes, update the version in `package.json` and `package-lock.json` together, then push a matching tag (for example, `v0.1.0` for version `0.1.0`). The tag triggers all platform builds; once they and their packaged-app smoke checks pass, the workflow publishes a GitHub Release with the installers, the update manifest (`varia-update.json`, which installed copies check) and GitHub-generated release notes. A version with a prerelease suffix (such as `v0.2.0-beta.1`) is published as a prerelease. Existing releases are not overwritten: resolve or remove an existing release before rerunning its release job.

## Architecture

The Electron application uses React, TypeScript, Monaco, and Dockview. A .NET sidecar handles SQL connections and management through Microsoft.Data.SqlClient and SQL Management Objects (SMO). The processes communicate over a MessagePack-based protocol; see the [IPC reference](docs/ipc.md).

The workbench page is treated as untrusted: it runs sandboxed with context isolation, no Node.js integration and a strict Content Security Policy, and reaches the system only through a small preload API whose every call main verifies. Built pages load from Varia's own `app://varia/` origin, never a `file:` URL, so page script cannot read local files. Packaged builds set Electron's fuses (`build/fuses.cjs`): `file:` pages get no extra privileges, the executable cannot run as Node.js or honour `NODE_OPTIONS` and `--inspect`, and the application loads only from its integrity-checked `app.asar`.

## Documentation

- [Commands and shortcuts](docs/commands.md)
- [Mouse gestures](docs/gestures.md)
- [Editor groups](docs/editor-groups.md), [hot exit](docs/hot-exit.md) and [popout windows](docs/popout-windows.md)
- [Object Explorer](docs/object-explorer.md), [object actions](docs/object-actions.md) and [Search Objects](docs/object-search.md)
- [Scripting](docs/scripting.md) and [Table Designer](docs/table-designer.md)
- [Activity Monitor](docs/activity-monitor.md), [live data](docs/live.md), and [Integration Services](docs/integration-services.md)
- [Settings](docs/settings.md) and [themes](docs/themes/README.md)
- [Updates](docs/updates.md)
- [IPC and benchmarks](docs/ipc.md)
