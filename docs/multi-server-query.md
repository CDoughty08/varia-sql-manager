# Multi-server and Cross-Engine queries

Varia can run one query across up to 32 SQL Server instances or up to 32 BigQuery projects at once, and run read-only **Cross-Engine SELECT** queries across SQL Server and BigQuery side by side (up to 32 targets in total, with at least one SQL Server and one BigQuery project). This page describes how multi-target selection, execution modes, Cross-Engine editing, composited results, and lifecycle work. See [BigQuery](bigquery.md) for single-project BigQuery sign-in, cost prompts, and windowed results, [Result grid tools](results-tools.md) for sorting, filtering, Pivot, Transpose, and Compare, and [IPC protocol v2](ipc.md) for `query.executeMulti` and `results.combine` wire details.

## Selecting multiple servers in Object Explorer

- **Pointer and keyboard selection.** Hold **Ctrl** (**⌘** on macOS) and click top-level connected server rows in Object Explorer (`explorer.addToSelection` in [Mouse gestures](gestures.md)), or press **Space** (or **Ctrl+Space** on Windows/Linux) on a focused server row (`explorer.toggleMultiSelect`). Only connected top-level servers participate; **Ctrl/⌘+click** on a child object opens a Peek tab as usual and clears multi-selection.
- **Engine-homogeneity lock.** The first selected server locks multi-selection to that engine (SQL Server or BigQuery). Incompatible rows dim with a **SQL only** or **BQ only** pill and cannot be added to a same-engine selection; use **New Cross-Engine SELECT…** to query both engines together.
- **Selection bar and context menu.** Once two or more servers are selected, a selection bar appears under Object Explorer's search box with the selected count, **New Query**, and **Clear selection** (**×**, returning focus to the tree). Right-clicking any selected server opens the multi-select context menu (**New Multi-Server Query**, **New Cross-Engine SELECT…**, **Refresh Selected**, **Clear Selection**, **Disconnect Selected**). Right-clicking a single connected server when multiple servers of that engine are connected also offers **Select All SQL Servers** or **Select All BigQuery Projects**.
- **Escape order.** Pressing **Escape** in Object Explorer clears type-ahead first, closes an open Peek card second, and clears multi-selection third.

## Managing targets on a query tab

- **Target picker.** Multi-server tabs replace the single server/database dropdowns in the query bar and classic toolbar with a target summary trigger (for example `3 SQL Servers` with a `2 PROD` tag, announced as `Targets: 3 SQL Servers (2 PROD)`). Opening it displays the **Query Targets** (or **Cross-Engine Targets**) popover with:
  - checkboxes to enable or disable any connected server of the matching engine (or both engines in Cross-Engine tabs),
  - per-server database or default dataset selectors (lazy-loaded with bounded concurrency and locked while executing),
  - **Apply database to all** (or **Apply `<database>` to all** when only one database matches) whenever all enabled live SQL Server targets (two or more) share a database name,
  - quick search when more than 8 targets are listed, and
  - one-click **Reconnect** for disconnected tab targets.
- **Drag and drop.** Dragging a server from Object Explorer onto a same-engine multi-server tab or onto the matching dialect pane of a Cross-Engine tab adds that server to the tab; holding **Ctrl** (**⌥** on macOS) over an editor inserts the server name instead.
- **Tab and status bar cues.** Multi-server tabs display stacked server colour swatches, a target summary sublabel (`3 SQL Servers`, `2 BigQuery projects`, or `1 SQL + 2 BQ`), and a top accent border (`PROD` red when any enabled target is Production). The status bar mirrors the active target summary and environment count.
- **Single-server controls.** Single-server-only commands (execution plans, Client Statistics, Change Connection…, Change Database…, Query › Connection › Disconnect) are disabled while a multi-server tab is active.

## Run mode prompt and execution modes

Pressing **Execute** (`F5`) on a same-engine tab with two or more enabled targets opens the run mode dialog (**Execute across N SQL Servers** / **Execute across N BigQuery Projects**) before anything runs. If you uncheck targets down to **1** enabled target, Execute skips the run mode dialog and runs directly as an ephemeral single-target execution (still applying BigQuery cost prompts when applicable).

### SQL Server modes

- **Coordinated Transaction (All succeed or all roll back).** Opens an unpooled ephemeral connection per server with `SET XACT_ABORT ON; BEGIN TRANSACTION` (no MSDTC required), verifies `XACT_STATE()`, `@@TRANCOUNT`, and `CURRENT_TRANSACTION_ID()` (on SQL Server 2016+ and Azure SQL) after every batch, waits at a two-stage barrier, and commits all servers only when every server succeeds. If any server fails, times out, disconnects, or is cancelled, all peers roll back.
  - **Pre-flight guards:** Rejects duplicate connections pointing to the same physical SQL Server instance (preventing self-deadlock), explicit `COMMIT` statements, `ROLLBACK` statements without a literal savepoint name, and non-transactional statements (`CREATE/ALTER/DROP DATABASE`, `BACKUP`/`RESTORE`, `DBCC`, `RECONFIGURE`, Full-Text/Availability Group/Resource Pool DDL, `ALTER SERVER CONFIGURATION`, `SHUTDOWN`, `KILL`).
  - **Commit in doubt:** A target that drops during the final `COMMIT` phase or commits its own transaction out-of-band during Phase 1 is reported as **Commit in doubt** rather than falsely claiming rollback.
- **Fire and Forget (Independent execution, no rollback).** Runs independently across targets (in parallel up to 8 at a time by default) with optional **Sequential rollout (stop on first error)** and **Stop on first batch error per server**. If an ephemeral connection still has an open transaction after the last batch, Varia rolls it back before closing the connection and logs a notice in Messages.

### BigQuery modes and inline cost estimates

- **Coordinated Transaction (Session DML).** Opens an ephemeral BigQuery session with `BEGIN TRANSACTION` per project, verifies transaction state after Phase 1, commits all projects only if every project succeeds, and aborts all sessions on failure or cancellation. Unavailable in emulator mode and rejects permanent DDL, `EXECUTE IMMEDIATE`, `CALL`, `EXPORT DATA`, `EXPORT TABLE METADATA`, `EXPORT MODEL`, `LOAD DATA`, `GRANT`, `REVOKE`, and explicit transaction statements. BigQuery still bills bytes processed on rolled-back jobs.
- **Fire and Forget.** Runs independently across projects as sessionless jobs, with optional **Sequential rollout (stop on first error)**. **Pre-flight Dry Run (free)** is available (and checked by default outside emulator mode) for both BigQuery modes; when the query contains permanent DDL (`CREATE`/`ALTER`/`DROP`), Coordinated Transaction is disabled and **Pre-flight Dry Run (free)** + **Sequential rollout** are pre-selected so syntax or schema errors stop before any project is modified.
- **Unified cost breakdown.** On same-engine BigQuery runs, the Run Mode dialog performs free per-project dry runs and shows each project's estimated bytes, on-demand cost, and any per-connection `costThreshold`, `maximumBytesBilled`, or incomplete-estimate warning inline before you confirm.

## Cross-Engine SELECT (SQL Server + BigQuery)

Open a Cross-Engine tab from Object Explorer's context menu (**New Cross-Engine SELECT…**), the Command Palette (`F1`), or by opening a `.sql` file formatted with canonical `-- #Dialect` markers.

- **Dual-Dialect Split and `-- #Dialect` File view.** By default, Cross-Engine tabs open in **Dual-Dialect Split** with a **Transact-SQL** pane on the left and a **GoogleSQL** pane on the right, each with its own server chips, `+ Add / Change` picker, bookmarks, and per-dialect IntelliSense (resolved from the first enabled live target of that dialect). Narrow editor groups (`<= 680 px`) auto-stack vertically, and a toolbar button toggles **Stack vertically** manually. Switching to **-- #Dialect File** edits the single canonical `.sql` representation:

  ```sql
  -- #Dialect="sqlserver"
  SELECT TOP 100 OrderId, Region, TotalAmount FROM dbo.Orders;

  -- #Dialect="bigquery"
  SELECT order_id AS OrderId, region AS Region, total_amount AS TotalAmount
  FROM `sales_prod.orders`
  LIMIT 100;
  ```

  Save, Save As, Hot Exit, AutoRecover, Reload, and Reopen Closed Query all persist this single `.sql` format. Switching between Split and File syncs edits through undo-safe edit operations. In File mode, T-SQL diagnostics and T-SQL-only transforms pause while live read-only checks and BigQuery cost estimates remain active.
- **Full-pane execution.** Cross-Engine Execute always runs both dialect panes (`Both dialects` scope pill) and refuses locally if either pane is empty. Any BigQuery target exceeding its cost threshold opens a single aggregated multi-project BigQuery cost confirmation dialog.
- **Three-layer read-only guard (`SELECT` / `WITH` only).**
  1. **Live editor diagnostics:** Debounced (150 ms) allowlist scanning marks blocked statements (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `EXEC`, `SELECT INTO`, `OPENROWSET`, `OPENQUERY`, `OPENXML`, `NEXT VALUE FOR`, etc.) with red squiggles (`varia-cross-engine-guard`) and one summary strip per pane offering **Next blocked** and **Open in SQL Server / BigQuery tab**.
  2. **Pre-execute refusal:** Pressing Execute with violations sends zero IPC, reveals the offending line, and logs a clickable `READ_ONLY_VIOLATION` entry in Messages.
  3. **Backend enforcement:** T-SQL is verified with a full `TSql180Parser` AST visitor allowlist; BigQuery is verified with `GoogleSqlScanner` and a free `dryRun` requiring `statementType == "SELECT"` (so Cross-Engine BigQuery queries must be a single `SELECT` / `WITH` statement, since multi-statement scripts report `statementType == "SCRIPT"`).

## Composited results, Combined, Compare, and Messages

- **Summary view.** Multi-server runs always include a **Summary** tab in Tabs layout and a collapsible summary band in Stacked layout, showing the execution mode, overall outcome, elapsed time, and one status card per target (batches, rows affected, result sets, duration, bytes processed, or error). Pure-DDL and DML runs with zero `SELECT` result sets still default to **Summary** instead of leaving Results blank.
- **Automatic `Combined (k/N)` view.** After Phase 2 settles, whenever two or more targets return in-memory rows for a statement slot and the merged set fits within the remaining query memory budget without evicting individual server results, the backend builds a `combined` result set with a prepended trusted `_server` column.
  - Duplicate column names align by `(name, occurrence)` order. Compatible types widen safely (`integer` + `decimal` → `decimal` with widened scale and `WideDecimal` promotion up to 77 digits when needed, keeping `BigNumeric` when a source is `BIGNUMERIC`; numeric + `float` → `float` keeping exact float sidecars; `boolean` + numeric → numeric; `date` + `datetime` → `datetime`; `binary` + `text` → `0x`-prefixed hex text). Merging an unzoned `date`/`datetime`/`time` with a zoned `timestamp` widens to `text` so workstation timezones are never fabricated.
  - Sort, Filter, Column Profile, Search, Pivot, Transpose, Copy, and Save Results As all work on `Combined`. Windowed BigQuery results are skipped with a notice instructing you to load them into memory (using **Load into memory** on that server's result grid strip or the results toolbar `⋯` menu); closing a source server's result marks `Combined` stale with **Rebuild** / **Close** actions (`results.combine`).
- **Rolled-back preview.** If a Coordinated Transaction rolls back after streaming earlier `SELECT` rows, those rows remain inspectable under an amber **"Rolled back — preview only (not committed)"** banner, inherited by any Pivot, Comparison, or rebuilt Combined view made from them.
- **Compare across servers.** Opening **Compare…** from **Summary** or **Combined** defaults to pairing the first two targets (or SQL Server → BigQuery) for the active statement slot. Cross-engine comparisons default to exact text comparison so swapping sides is symmetric.
- **Filtered Messages and error navigation.** Messages renders a sibling server filter bar (**All**, **Coordinator**, and per-server pills — or a compact `<select>` when targeting more than 6 servers or inside the narrow Messages strip) outside the message log so **Ctrl+A** copies only log lines. Error links (`Go to line`) navigate to the matching dialect pane and line even in Cross-Engine Split view.

## Lifecycle, Disconnect, Hot Exit, and AutoRecover

- **Ephemeral sessions and cancellation.** Multi-server runs open fresh ephemeral SQL Server connections (capped globally at 8 concurrent runs and 64 ephemeral connections) or, in BigQuery Coordinated Transaction mode, ephemeral BigQuery sessions (BigQuery Fire and Forget and Cross-Engine runs submit sessionless jobs), and close them when the run finishes. **Cancel** (`query.cancel`) cancels all active targets. Multi-target tabs do not persist `jobKey` and do not offer **Leave it running** on close, disconnect, or quit so coordinated transactions are never abandoned open; unexpected crash orphans still surface in Varia's existing orphaned-job review grouped by project.
- **Disconnect.** Disconnecting a server keeps idle multi-target tabs open with only that server marked **Disconnected** (offering one-click **Reconnect**). Disconnecting a server with a running multi-target query prompts to cancel the run first, and **Disconnect Selected** disconnects every server in Object Explorer's multi-selection cleanly.
- **Hot Exit and AutoRecover.** Session files (`v4`) persist multi-target associations (excluding runtime handles and secrets) and canonical `-- #Dialect` text; AutoRecover (`v3`) persists hint-only target metadata (`provider`, `database`, `lastServer`, `enabled`) that round-trips safely back through Hot Exit.

## Testing

- **Offline .NET checks:** `MultiQuerySql`, `MultiQueryBigQuery`, `ResultCombiner`, and `Packed ResultCombiner` in `backend/Varia.Backend.Tests/`.
- **Live SQL Server checks:** `MultiQuery` in `backend/Varia.Backend.Tests/MultiQuerySqlChecks.cs` (fire-and-forget fan-out + `autoCombine` + `results.combine`, sequential stop-on-first-error, duplicate-physical-server self-deadlock pre-flight refusal, and coordinated transaction commit & rollback with `rolledBackPreview`).
- **Unit and UI tests:** `tests/multi-query-contracts.test.ts`, `tests/multi-query-classifier.test.ts`, `tests/explorer-multiselect.test.ts`, `tests/multi-query-lifecycle.test.ts`, `tests/cross-engine-guard.test.ts`, `tests/multi-execute-dialog.test.ts`, `tests/multi-query-execution.test.ts`, `tests/multi-results-compositing.test.ts`, and `tests/multi-query-integration.test.ts`.
- **Electron smoke suite:** `scripts/multi-server-query-smoke.mjs` (registered in `npm run test:smoke` and `scripts/smoke-shards.mjs`).
