# Varia SQL Manager

A starting point for an SSMS-style SQL Server workbench: **Electron + React + TypeScript + Monaco**, backed by a **.NET 10** process using **SQL Management Objects (SMO)** and **Microsoft.Data.SqlClient**.

## Run

Prerequisites: Node.js 24 or newer and the .NET 10 SDK. Windows, Linux, and macOS are development targets, and CI builds and tests on all three. Windows authentication is Windows-only for now; on Linux and macOS, connect with SQL authentication until Kerberos support lands. On Ubuntu 24.04 and later, AppArmor blocks the unprivileged user namespaces that Electron's Chromium sandbox needs when it is installed through npm; allow them (for example `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`) rather than disabling the sandbox.

```powershell
npm install
npm run dev
```

The dev command builds the backend and launches Electron with renderer hot reload. After changing C# code, stop and restart it. Changes to main/preload code restart Electron through electron-vite.

```powershell
npm run check           # Type check, Release backend/parser tests, bridge tests, production UI build
npm run test:smoke      # Hidden Electron workbench/layout/connection-dialog/theme/palette/menu tests (after check)
npm run test:electron   # Both of the above
npm run build
npm start               # Launch the built workbench using the local .NET runtime
```

Without a desktop session on Linux, run the Electron tests under a virtual display: `xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke`. Screenshots go to `artifacts/`. The tests keep Chromium's sandbox on unless they run as root, so the AppArmor note above applies to them too.

The .NET SDK is selected through `global.json`. npm and NuGet lockfiles pin resolved dependencies. This bootstrap runs locally; installers, code signing, and bundled .NET distribution are future work.

## First workflow

1. Click **Connect**, enter a SQL Server and starting database, and choose Windows or SQL authentication.
2. For a trusted local server with a self-signed certificate, explicitly enable **Trust server certificate**. Encryption stays enabled. Certificate validation is enabled by default.
3. Connect additional servers with **Connect**. Each query retains its own server/database target; the toolbar selectors change the active query's target. Object Explorer keeps all connected servers visible.
4. Execute SQL with the Execute button or its keys (see [Commands and keyboard shortcuts](#commands-and-keyboard-shortcuts)). Selected text takes priority over the full document; a whitespace-only selection executes nothing.
5. Inspect result sets and Messages. Cancel stops the running script and skips its remaining batches. Earlier output remains available. The results grid selects cells as SSMS does: click a cell, a row number, or a column header (the corner selects everything), Shift+click or drag to extend, and **Ctrl+A** selects all. **Ctrl+C** copies the selection as tab-separated text (NULL for nulls, line breaks and tabs inside a value as spaces) and **Ctrl+Shift+C** copies it with column headers; unnamed columns show and copy as "(No column name)".
6. Click a table to generate its CREATE script through SMO in a new query tab, or right-click it for **Select Top 1000 Rows** and **Script Table as › CREATE To**.
7. Use **Open**, **Save**, and **File → Save As** for SQL files, and close a query with its × button. Modified queries show a dot and offer Save / Don't Save / Cancel on close or application exit. Arrow keys navigate the tab strip; Space/Enter activates a focused tab.

File operations use native dialogs and opaque file IDs, with atomic saves. UTF-8 and UTF-16 LE (with BOM) SQL files are supported, with a 5 MB file limit. Existing encoding is preserved when saving. Native Undo/Redo menu actions use Monaco's document history; Ctrl+Z/Ctrl+Y continue to work in the editor.

The window uses a single compact title bar with **File / Edit / View / Query / Window** menus and the current query name. Windows retains native minimize/maximize/close controls, while the empty title area can be dragged to move the window. The query action toolbar sits immediately below. On Windows and Linux the menus are drawn in the current theme. They show command keys and grey out commands that cannot run; **F10** or a tap of **Alt** focuses the menu bar, arrow keys move between menus, an underlined letter chooses an item, and **Alt+F / Alt+E / Alt+V / Alt+Q / Alt+W** open the menus (in the editor's find widget **Alt+W** still toggles Whole Word). **Escape** returns focus to the editor or input. macOS keeps its native menu bar. Right-clicking the query editor, a query tab, a panel tab, an Object Explorer node, the results grid, Messages, or a text field, or pressing **Shift+F10** or the context-menu key where it has focus, opens a context menu with the commands that apply there (themed on Windows and Linux, native on macOS); the query tab menu's items (Close All But This, Copy Full Path, Open Containing Folder) act on that tab. Right-clicking a cell outside the grid's selection selects it first, and the grid's menu offers Copy, Copy with Headers, and Select All; in Messages and the XML plan, Select All selects only their text. This uses Electron's [custom title bar and native controls overlay](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar).

Passwords are kept in memory only; application exit or disconnecting releases the backend connection profile and clears its connection pool. Closing a query tab ends its SQL session; tab sessions are not pooled, so an open transaction rolls back and releases its locks immediately. The UI clears the password after connecting, selecting another saved connection, or dismissing the dialog. Saved profiles contain server/login names and connection settings, with passwords omitted.

## Commands and keyboard shortcuts

**F1** or **Ctrl+Shift+P** (**⇧⌘P** on macOS) opens the command palette. Type any part of a command's name, or the first letters of its words (`fsa` finds **File: Save As…**). The arrow keys move through the list, **Enter** runs the command, and **Escape** closes the palette. Either way focus first returns to where it was, so a command such as Undo acts on the editor you came from. Recently used commands are listed first. Commands that cannot run right now are dimmed, and choosing one says why, for example that the query needs a connection. **Ctrl+P** (**⌘P**) opens **Go to Query**, which lists the open queries with the most recently used first, so **Ctrl+P** then **Enter** switches between the last two. In either list, type `>` to search commands or `?` for help.

The shortcuts follow SSMS where SSMS has one:

| Action | Windows and Linux | macOS |
| --- | --- | --- |
| Command palette | F1, Ctrl+Shift+P | F1, ⇧⌘P |
| Go to Query | Ctrl+P | ⌘P |
| Execute the selection, or the whole query (in the editor) | F5, Ctrl+Enter, Ctrl+E | F5, ⌘↩ |
| Cancel the executing query | Alt+Pause | Query menu |
| Change database | Ctrl+U | ⌘U |
| New query, Open, Save, Save As | Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S | ⌘N, ⌘O, ⌘S, ⇧⌘S |
| Close the query | Ctrl+W, Ctrl+F4 | ⌘W |
| Next or previous query | Ctrl+Tab or Ctrl+Shift+Tab, Ctrl+PageDown or Ctrl+PageUp | ⌃⇥ or ⌃⇧⇥ |
| Show Object Explorer and move focus to it | F8 | F8 |
| Hide or show the results pane (Window → Show Results Pane) | Ctrl+R | ⌘R |
| Refresh the focused Object Explorer node | F5 | F5 |
| Copy the selected result cells, or with column headers (in the results grid) | Ctrl+C, Ctrl+Shift+C | ⌘C, ⇧⌘C |
| Toggle word wrap | Alt+Z | View menu |
| Comment or uncomment the selection | Ctrl+K Ctrl+C or Ctrl+K Ctrl+U | ⌘K ⌘C or ⌘K ⌘U |
| Toggle line comment | Ctrl+/ | ⌘/ |

The [command reference](docs/commands.md) lists every command with its keys on each platform, the condition under which it can run, its menu items, and the keys Varia leaves to menus, the editor, and the operating system. It is generated from the command catalogue, so it always matches the app. On macOS, menu items show only shortcuts with ⌘: the menu bar would take any other key (F5, F8, ⌃⇥) before the focused pane saw it. Menus, the toolbar, the keyboard, and the palette run the same commands and agree on what is available. While a dialog is open, workbench shortcuts and menu commands do nothing and the dialog keeps its keys; Undo, Redo, and the clipboard commands still act on its text fields, whose context menu works inside the dialog. Holding a key down runs its command once, except Next and Previous Query. Custom keybindings are future work.

## Connection dialog

**History** contains searchable **Favorites** and the last 30 successful **Recent Connections**. Selecting an entry fills its properties; use its star to change favorite status or its × to remove it from the saved library. **Add favorite** and **Register server** save the current form before connecting. **Save changes** updates a selected entry. **Reset** resets the form without deleting the library. Up to 200 favorites/registered/recent entries are stored atomically in `connections.json` in Electron's user-data directory. Favorites, registered servers, custom names, colors, and advanced properties survive restart; passwords never enter that file. A failed connection does not enter history.

**Browse → Local** reads installed SQL Server instance registrations and per-user LocalDB registrations on Windows. **Network** uses SqlClient's SQL Server discovery, with Refresh to enumerate again; results depend on SQL Server Browser/firewall responses and may be incomplete. Server names can always be typed manually. **Registered Servers** lists servers registered in Varia on this computer; SSMS file import and Central Management Servers are future work. Azure/Fabric discovery is omitted. See Microsoft's [SQL Server enumeration documentation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sql.sqldatasourceenumerator.getdatasources?view=sqlclient-dotnet-core-6.1).

Focus **Database Name** or click its refresh button to load databases visible to the supplied login. Discovery uses a temporary connection to the login's default database, closes it without adding a connected server, and ignores stale results after credentials/settings change. Leave the field empty for **<default>**, pick a discovered database, or type a name when discovery is unavailable. Discovery has a 30-second deadline and preserves the form on failure.

Choose **Optional / Mandatory / Strict** encryption and certificate hostname settings. Mandatory is the default; Strict disables the Trust Server Certificate override. A custom **Name** labels the connected server. The palette or custom color picker marks that server in Object Explorer, its query tabs, and the active query context/status bar. **Connection String** previews the effective string produced by the actual SqlClient builder, with the password omitted; properties are edited through the form.

**Advanced…** groups properties similarly to SSMS: command/connect timeouts, Always Encrypted and secure enclave attestation, MARS, protocol, packet size, transaction binding, type system version, connection retries, application/workstation identity, application intent/language, replication, IP preference, certificate path, attached file, failover/SPNs, Multi Subnet Failover, and user instance. OK applies the draft; Cancel/Escape discards it. Command timeout defaults to **0 (no timeout)** and controls each submitted script's existing overall deadline/cancellation handling; finite values also cover all GO batches. Connect timeout defaults to 15 seconds. Network Library maps to a `tcp:`, `np:`, or `lpc:` server prefix because the .NET provider lacks the legacy keyword. These settings are validated and carried through to query sessions and metadata/SMO connections; capabilities such as Always Encrypted also require the corresponding server/key-provider configuration. Provider support follows [SqlClient's connection options](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlconnection.connectionstring?view=sqlclient-dotnet-7.1).

Object Explorer has an expandable **Databases** folder, with **System Databases** and **Database Snapshots** grouped separately and user databases listed directly beneath it. Database nodes expand independently; clicking a database selects the query target, and clicking a table creates its SMO script. Under **Security**, expand **Logins**, **Server Roles**, **Credentials**, **Cryptographic Providers**, **Audits**, or **Server Audit Specifications** to load a read-only list of names. Lists load on expansion and retain their contents when collapsed. The panel's **Refresh Object Explorer** button reloads every list; **F5** or a node's **Refresh** reloads only that node's lists (on a table or a login, the list it is in). Empty lists and catalog errors are shown within the affected folder. Creating, editing, and deleting these server objects is future work.

Right-click a node, or press **Shift+F10** where it has focus, for its commands. A server offers Connect…, Disconnect (that server, without asking which), New Query, Copy Name, and Refresh; a database offers New Query (on that database), Copy Name, and Refresh; folders offer Refresh. A table offers **Select Top 1000 Rows**, which opens SSMS's script with the table's columns listed (or `*` beyond 4,096 columns) on its database and runs it, **Script Table as › CREATE To** a new query, a `.sql` file, or the clipboard, and Copy Name. Copy Name copies a server's name as connected to, or an object's bracket-quoted name (`[dbo].[Orders]`). Scripting errors appear in the command banner.

Server catalog visibility follows the connected login's permissions; an empty list means no objects are visible to that login. Snapshot grouping uses `sys.databases.source_database_id`. See Microsoft's [server principal catalog](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-server-principals-transact-sql) and [database snapshot documentation](https://learn.microsoft.com/en-us/sql/relational-databases/databases/view-a-database-snapshot-sql-server).

## Workspace layouts

**Object Explorer**, **Query editor**, and **Query output** are independent dockable panels. Drag a panel header over another panel to display an SSMS-style docking compass. Its center creates a tab group; the four inner cells split the destination panel; the four outer cells dock against the whole workspace. A blue shaded preview shows the landing area. Releasing away from a guide floats the panel. Hold **Ctrl** while dragging to float without docking, or **Ctrl-double-click** a panel tab to toggle floating and its previous docked position. Floating panels redock by dragging their top handle onto a guide with an ordinary drag. This follows the guide/preview and Ctrl gestures described in [Visual Studio's docking documentation](https://learn.microsoft.com/en-us/visualstudio/ide/customizing-window-layouts-in-visual-studio?view=visualstudio).

Drag splitters to resize; window resizing keeps existing splitter positions where space permits. Each panel's **Move…** control also provides docking, tab grouping, floating, and closing without dragging; right-clicking a panel tab offers Float/Dock and Close. Floating panels resize from their edges/corners and stay inside the workspace viewport. Individual SQL documents remain tabs within the Query editor panel.

Close panels with their **×** buttons and reopen or activate them from **Window → Object Explorer / Query Editor / Query Output** (**Alt+W** opens the menu). Closing a panel hides its content while retaining query text/undo, server explorer state, result data, and running SQL sessions. Closed panels remain closed after restart; layouts with any subset of panels, including none, are valid. Reopening within the same app session uses the last docked location when it is available. Window also offers Save, Load, and Reset Window Layout.

The current panel arrangement, splitter sizes, active panel groups, and floating bounds are remembered automatically in `workspace-layouts.json` in Electron's user-data directory. Changes are debounced while dragging and flushed on normal application exit. Restoring a layout adapts to the available window size and reuses live panels, preserving Monaco models/undo, query output, Object Explorer state, and active SQL sessions.

Use **Layouts** in the query toolbar or **View → Save Layout… / Load Layout…** to open the layout manager. Give the current arrangement a name and select **Save layout**; saving an existing name replaces that preset. Select a saved layout and choose **Load layout**, or **Delete** to remove that preset. Up to 20 named layouts are supported. **Export current layout…** and **Import layout…** use native dialogs for portable `.json` layout files. **Reset default layout** (also **View → Reset Layout**) restores Explorer on the left and query output beneath the editor.

Layouts contain only open panel identities and their geometry/presentation. Query documents, result data, SQL targets, and credentials stay out of layout files. Imported files are versioned, validated, and limited to 200 KB; inconsistent references or unsupported components leave the current layout intact. Ordinary Dockview size constraints and visibility metadata are accepted. Validation errors identify the offending field rather than requiring every panel to exist. Preferences use atomic writes. Invalid preferences recover to the default layout while preserving the original file as an `.invalid-<id>.json` backup. Native detached windows and auto-hide tool strips are future work. Docking uses the MIT-licensed [Dockview React library](https://dockview.dev/docs/overview/introduction/) with application-owned guide controls.

Interface labels, menus, tabs, and status text disable browser text selection. Text editors and inputs, statistics/messages, XML plans, and error details remain selectable for copying; the results grid selects cells instead.

## Themes

**View → Theme** switches between **Dark** (the default), **Light**, and **Follow System**, and chooses the theme used in each mode. Switching is live: queries, undo history, connections, and the layout are untouched, and the native title bar and menus follow the mode (system dialogs such as file pickers follow it on macOS only). The choice is saved in `appearance.json` in Electron's user-data directory. **Color Theme…** (in that menu, or **Preferences: Color Theme…** in the command palette) lists the modes and every theme: each row previews as you move to it, Enter chooses it, and Escape puts the current theme back without saving anything.

Custom themes are JSON files in the `themes` folder there (**View → Theme → Open Themes Folder**). A theme overrides any of 61 named palette slots, 190 color keys (VS Code names where the meaning matches), and the SQL token colors, on top of Varia Dark or Varia Light; one file can provide both variants. **Create Custom Theme…** writes a starter seeded with the current accent colors; edit it, then choose **Reload Themes**. Theme files are validated strictly and never modified. Problems are listed in a banner with their JSON path, a bad entry keeps its default, and a theme that cannot be used falls back to the built-in theme of its type while keeping your choice. See the [theme guide](docs/themes/README.md), the [token reference](docs/themes/tokens.md), and the [JSON Schema](docs/themes/varia-theme.schema.json).

## Architecture

```text
Monaco / React renderer
        ↓ narrow typed window.varia API
Sandboxed Electron preload
        ↓ validated IPC from the application main frame only
Electron main process / BackendClient
        ↓ correlated newline-delimited JSON on stdin/stdout
.NET 10 sidecar
        ├── SqlClient: connections, metadata, queries, cancellation
        └── SMO: table CREATE scripts and future management operations
```

This is a Monaco-based workbench, not a fork of VS Code. No HTTP server, listening port, native Node ABI binding, or `edge-js` dependency is needed. .NET owns database behavior, which provides a straightforward place to add SMO services as management features grow. Electron owns sidecar startup and shutdown.

- `src/shared/contracts.ts`: typed operations, parameters, and results.
- `src/main/validation.ts`: allowlist and runtime validation before requests leave Electron.
- `src/main/backend-client.ts`: child process, request correlation, timeouts, and failure handling.
- `src/main/layout-store.ts` / `src/shared/layouts.ts`: atomic preferences, layout files, and bounded layout validation.
- `src/preload/index.ts`: explicit public methods; no generic IPC or shell API exposed.
- `backend/Varia.Backend`: independent C# console host and SQL services.
- `src/renderer/src`: workbench and locally bundled Monaco editor/worker.
- `src/shared/commands`: the command catalogue (ids, titles, keys, preconditions, and menu placements), the when-clause language, keybinding parsing and labels, the menu model main builds native menus from, and the generator for `docs/commands.md`.
- `src/renderer/src/core`: renderer command routing, context keys, the keybinding dispatcher, native menu state, typed events, stable service snapshots, and workbench lifetime outside React effects.
- `src/renderer/src/quickinput` / `src/renderer/src/contributions`: the DOM-free quick input controller and its view, and the commands that use it: the palette, Go to Query, and the server, database, and color theme pickers.
- `src/renderer/src/contributions/files.ts` / `src/renderer/src/services/files.ts`: file command registration, open/save/close workflows, dirty confirmations, and file errors. Tab-close commands carry the document ID, so a pending confirmation stays attached to its original query. Application exit confirms documents, flushes the shell's layout, and rechecks document revisions before closing.
- `src/renderer/src/services`: document-owned Monaco models/view state and query orchestration. Documents use `varia-sql://query/<tab-id>` URIs; tab changes and editor remounts retain undo history. SQL stays in models, while React subscribes to metadata and execution snapshots. Save records the revision actually written, so typing during a save remains dirty. Query commands share guards for running scripts and document transitions; the backend session ID remains the tab ID.
- `tests`: real sidecar health/error integration tests, bridge failure tests, and file/layout persistence checks. Electron scripts exercise docking gestures, layout file round trips, live editor preservation, the command palette, pickers, and keyboard paths, and a full app restart with isolated test profiles.

The renderer uses context isolation, sandboxing, no Node integration, a Content Security Policy, and blocked navigation/popups. Only local app assets are loaded. SQL credentials travel through the private pipe, never process arguments. Backend stdout is exclusively protocol messages; diagnostics and query text are not logged.

### Protocol

One UTF-8 JSON message per line. Responses may arrive out of order and are matched by request UUID. `system.health` returns protocol version 1 and loaded assembly versions. Methods are allowlisted in both the main process and .NET dispatcher.

```json
{"id":"db807cb6-d4d9-42d7-8d1a-cd0b8ea6a3de","method":"system.health","params":{}}
{"id":"db807cb6-d4d9-42d7-8d1a-cd0b8ea6a3de","result":{"protocolVersion":1,"runtime":".NET 10.x","platform":"...","smoVersion":"...","sqlClientVersion":"..."}}
```

Errors use `{"id":"...","error":{"code":"...","message":"..."}}`. At the preload boundary they become a typed `{ ok: false, error }` result, so the UI can display failures without losing the Electron process. A failed backend requires an application restart. Reloading the workbench (View → Reload Window, which has no shortcut) first asks when queries are unsaved or servers are connected, then restarts the backend so no SQL session or transaction outlives the page that owned it.

`query.execute` takes the query tab's UUID as `sessionId`, a separate execution UUID as `queryId`, and an optional selected-text `startLine`. Its result contains `status` (`completed`, `failed`, `cancelled`, or `timedOut`), any SQL error, completed/total batch counts, the resulting database context, and retained output. SQL execution failures return this result so earlier rows and messages survive. Validation errors and missing, busy, or invalid sessions/connections still use the protocol error envelope. `query.session.close` releases a tab's session; server retargeting closes that session before changing the target.

## Batches, sessions, and statistics

Each executed query tab owns one persistent SQL connection. `GO` ends the current batch; subsequent batches run serially on that same connection. Local variables end at a batch boundary, while temporary tables, SET options, database context, and explicit transactions persist. They also persist between F5 executions in the same tab. Other tabs and Object Explorer use separate sessions. Closing a tab, changing its server, disconnecting, or exiting releases its session, including rolling back outstanding transactions. Connections are opened lazily, with at most 32 tab sessions and one active script per tab.

The parser recognizes standalone, case-insensitive `GO` and `GO n`, with comments allowed around the delimiter. It understands escaped strings, quoted identifiers, and nested block comments, so `GO` inside those tokens remains SQL text. It validates the entire script before submitting any batch. Repeat counts must be positive integers; `GO 0`, `GO;`, malformed counts, and more than 1,000 total batch executions are rejected. SQLCMD directives such as `:r`, `:setvar`, and `!!` are rejected before execution; SQLCMD variable expansion is unavailable. See Microsoft's [GO reference](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/sql-server-utilities-statements-go).

Statement-level errors (severity 11–16) are reported without interrupting the batch, so SQL Server decides whether the rest of the batch runs, as in SSMS. The first batch that raised an error, a cancellation, or a timeout skips all later batches and repetitions. Earlier results and messages remain accessible, and errors identify the source line, batch, and repetition. A single deadline covers connection setup and the whole submitted script. **GO does not commit a transaction, and execution failure does not automatically undo earlier changes.** Transactions follow the submitted T-SQL; no automatic BEGIN/COMMIT/ROLLBACK is inserted. Automatic connection recovery and command retries are disabled. A lost session is reported, and the next explicit execution opens a new session with fresh state.

SET statements pass through unchanged to SQL Server, including combined `SET STATISTICS TIME, IO ON` and separate ON/OFF statements:

| Setting | Display |
| --- | --- |
| `SET STATISTICS TIME ON` | Server CPU and elapsed-time messages in **Messages**. |
| `SET STATISTICS IO ON` | Server scan/read statistics in **Messages**. |
| `SET STATISTICS XML ON` | Additional actual-plan result sets shown as escaped raw XML under **XML plan**. |
| `SET STATISTICS PROFILE ON` | Additional profile result sets shown in the results grid. |
| `SET SHOWPLAN_XML ON` | Estimated plans shown as raw XML; SQL Server does not execute the planned statements. Put the ON/OFF statements in their own GO-separated batches. |
| `SET SHOWPLAN_TEXT/SHOWPLAN_ALL ON` | SQL Server's textual/tabular estimated-plan result sets use the regular results grid. |

`PRINT`, informational SQL messages, statistics, and row counts are captured without treating them as query errors. Other SET options retain SQL Server's normal semantics and permissions. Plan collection requires the relevant SHOWPLAN permissions. A graphical execution-plan viewer is future work. References: [TIME](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-time-transact-sql), [IO](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-io-transact-sql), [XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-xml-transact-sql), [PROFILE](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-profile-transact-sql), [SHOWPLAN_XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql).

Try [examples/statistics-and-batches.sql](examples/statistics-and-batches.sql) on a development connection. It uses only a session-local temporary table.

## Current boundaries

- Multiple server connections and query documents, with independent persistent sessions and executions per tab. Disconnecting a server detaches only that server's queries. Review generated scripts before executing them.
- GO batches and repetitions are supported; SQLCMD mode is unavailable. The policy stops later batches on errors, which is intentionally stricter than some SSMS execution paths.
- Results are buffered, with a default 1,000 rows across result sets, ten retained result sets, 100,000 cells, and 4 million text characters. Ordinary cells retain up to 16,384 characters and XML plans up to 1 million. Messages retain at most 1,000 entries / 1 million characters. Truncation is explicit. Display limits do not stop SQL execution or skip later batches. Full streaming/virtualization is future work.
- Big integers and decimals are returned as strings to preserve precision. Dates use ISO strings, binary values use bounded hex, and SQL NULL is preserved. CLR types (hierarchyid, geometry, geography) are shown as their serialized hex, as in SSMS.
- Script timeout follows the connection's Advanced Command Timeout (0 means no deadline, with a maximum of 86,400 seconds). SMO operations use a separate 30-second statement timeout. Configured connection recovery retries apply to stateless connections; query tabs disable automatic recovery so a lost SQL session cannot silently replace persistent SET/temp/transaction state.
- Syntax highlighting and raw plan/profile output are available. Schema-aware IntelliSense, graphical plans, profiler, backup/restore, security management, and job management are future milestones.
- Default automated checks need no database. Optional live backend checks exercise GO, persistent sessions, statistics variants, transactions, errors, cancellation, timeout, display caps, and cleanup against a development instance.

For live checks on any OS, run a disposable SQL Server container and use SQL authentication. Give the server about 20 seconds to start (on Apple silicon, Docker Desktop runs the image through Rosetta emulation):

```sh
docker run -d --name varia-sql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Varia_Dev_Pw1!' -p 127.0.0.1:1433:1433 mcr.microsoft.com/mssql/server:2022-latest
VARIA_TEST_SQL_SERVER=localhost VARIA_TEST_SQL_USER=sa VARIA_TEST_SQL_PASSWORD='Varia_Dev_Pw1!' npm run backend:test
```

The `docker run` line works unchanged in PowerShell; set the variables there for one run like this:

```powershell
$env:VARIA_TEST_SQL_SERVER = 'localhost'; $env:VARIA_TEST_SQL_USER = 'sa'; $env:VARIA_TEST_SQL_PASSWORD = 'Varia_Dev_Pw1!'
try { npm run backend:test } finally { Remove-Item Env:VARIA_TEST_SQL_* }
```

On Windows, a development SQL Server with Windows authentication needs only the server variable:

```powershell
$env:VARIA_TEST_SQL_SERVER = 'localhost'
try { npm run backend:test } finally { Remove-Item Env:VARIA_TEST_SQL_SERVER }
```

These checks create only session-local temporary objects. The test harness explicitly trusts the development server's certificate; the application's certificate validation remains enabled by default. With the same variables set, `npm run test:smoke` also connects the connection dialog to that server. The password is never printed.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests (including ones stacked on another pull request), pushes to `main`, and manual dispatch. The Linux job runs every time: it starts SQL Server 2022 as a service container, runs `npm run check` with the live checks enabled, then the Electron tests under xvfb with Chromium's sandbox enabled. Windows and macOS run `npm run check` (without a database) for pushes, manual runs, and non-draft pull requests, and Windows also runs the Electron tests; the repository is private and those runners bill at 2x and 10x, so keep pull requests in draft while iterating. The Electron tests currently assume Windows/Linux window chrome, so macOS skips them until the macOS menu bar work lands. A new push cancels a pull request's earlier run, while every push to `main` runs to completion. Failed runs upload the screenshots in `artifacts/`.

## Direction

- **Goal:** SSMS 2022-level polish with a VS Code-style **F1** command palette. Core management first (connections, databases, objects); SSIS, replication, and credentials later. Windows, Linux, and macOS are equally important. The workbench must never freeze or crash, and error states must stay recoverable.
- **Roadmap:** CI and test foundations; theme tokens; command registry and F1 palette; context menus; Object Explorer v2 (backend node provider, virtualized keyboard tree); scripting (Script As…); binary IPC v2; a streaming, virtualized results grid.
- **IPC v2:** length-prefixed MessagePack frames for control messages and row pages, server push and streams with credit-based backpressure, and a MessagePort with transferable ArrayBuffers to the renderer.
- **Results:** memory-only, with a backend memory budget and explicit truncation. Results never spill to disk.
- **Menus:** custom-rendered, themed title-bar and context menus on Windows and Linux; the native global menu bar on macOS.
- **Servers and authentication:** SQL Server 2016 through 2025. SQL authentication and Integrated authentication (Windows SSPI; Kerberos on Linux/macOS) first, then Microsoft Entra ID.
- **Visuals:** SSMS layout, density, and behaviours. Icons are codicons (bundled with Monaco) plus custom SVGs, since Microsoft's SSMS icons cannot be reused. Dark and Light themes (plus following the system), customizable through a standardized palette system in the style of VS Code and opencode.

Reference documentation: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [electron-vite](https://electron-vite.org/guide/), [.NET support](https://dotnet.microsoft.com/en-us/platform/support/policy), [SMO](https://github.com/microsoft/sqlmanagementobjects), [SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/download-microsoft-sqlclient-data-provider).
