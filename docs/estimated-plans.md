# Estimated execution plans

Use **Query › Display Estimated Execution Plan**, the query or classic toolbar's **Estimated Plan**, the editor context menu, or **Ctrl+L** (**⌘L** on macOS). A selection takes precedence over the whole editor. Connect the query first. **Cancel** stops acquisition, including compilation waiting on schema locks.

The existing **Execution plan** pane labels these results **Estimated**. Its Pixi canvas, operator outline, search, statement selection, properties, zoom and fit controls work as for actual plans. Runtime rows and timings are unavailable. **Open plan document** opens a `.sqlplan` document; the normal Save, Save As, editable XML and recovery behavior applies. Estimation keeps the last ordinary data grids and does not change **Include Actual Execution Plan**. The next ordinary execution replaces the estimate.

The output view you select is preserved when you return to the query tab or restore the output with **Ctrl+R**. A new estimate opens its plan view again, without replacing the ordinary results or statistics history.

## Session and database context

Each request opens a fresh, unpooled SQL connection, with connection recovery disabled, using the query's credentials, selected database and Varia's query-window SET defaults. It never borrows the tab's SQL session. This deliberately protects existing transactions, temporary objects, SET options, database context, result handles and capture options when estimation succeeds, fails, times out or is cancelled.

Consequently an estimate cannot see the tab's local temporary tables, temporary procedures, table variables, prior SET changes, impersonation or uncommitted changes. Create-and-use temporary-object scripts can fail because creation is not executed. Compile the relevant statement against existing permanent/global temporary objects, or use an actual plan when session state is required. Do not execute setup SQL merely to obtain an estimate unless you intend its effects. Runtime SET changes in submitted SQL are not executed; parse-time settings still follow SQL Server's SHOWPLAN semantics.

The entire selection is validated before a connection opens. Existing GO parsing, repetitions, SQLCMD rejection and selection line offsets apply. A standalone `USE [database]` batch is applied through SqlClient's database-change API between compiled batches. Mixed `USE`/query batches are rejected with instructions to split at GO or choose the database in the toolbar; this prevents silently compiling in the wrong context. The query tab's database remains unchanged.

Varia turns `SHOWPLAN_XML` on in a separate batch before submitting SQL. Explicit SHOWPLAN, NOEXEC, PARSEONLY and FMTONLY tokens are conservatively rejected, even in nested statements, so a later capture toggle cannot allow submitted SQL to execute. Quoted string values and comments are ignored by this guard. A column or identifier named after one of these capture options can also be refused; estimate a selection without it. Dynamic SQL and stored procedures have SQL Server's ordinary estimated-plan limitations.

SQL Server requires the permissions needed to compile the SQL, including SHOWPLAN for referenced user databases (see [SET SHOWPLAN_XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql)). Unsupported engines, inaccessible databases, missing objects, syntax errors and permission errors are shown in the estimated pane. Varia does not fall back to executing the query. SQL Server compilation can still acquire schema locks and update optimizer statistics.

## Bounds and cleanup

`plans.estimate` is a unary request independent of plan streaming events and `query.execute` summaries. It has a fixed 30-second acquisition budget, a 35-second IPC deadline, at most two acquisitions in flight, 64 XML documents and 2,097,152 total XML characters. Limits fail the request with guidance to estimate a smaller selection. It does not store XML in ordinary result cells or use their truncation limits. Retained XML across tabs shares a 16,777,216-character renderer budget; older tabs report when an estimate was released and can request it again. Parsed graph limits remain those of the existing plan viewer.

Every completion attempts SHOWPLAN OFF using a separate two-second cleanup token. The unpooled physical connection is then disposed, including after a failed cleanup, so capture settings can never escape into a later query or pooled connection. Cancel uses the existing query-cancel control lane with the estimate request ID; early cancellation, disconnect, session close and backend shutdown share the existing request lifecycle.

Closing a tab during estimation still checks its ordinary session for an open transaction and offers the normal commit-or-rollback decision. Cancelling that prompt keeps the estimate running. Once closing proceeds, the isolated estimate is cancelled independently; it never forces rollback of the ordinary transaction.

Run `npm run check` and `npm run test:smoke` after `npm run build:smoke`. For focused live tests, set `VARIA_TEST_SQL_SERVER=localhost` using your shell and run `dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --live-suite EstimatedPlans` and `node scripts/estimated-plans-smoke.mjs`. The Electron suite uses isolated profiles and adds real SQL Server checks when `VARIA_TEST_SQL_SERVER` is set. The .NET suite covers isolation, GO/USE, no execution, compile/permission errors, blocked-compilation cancellation and timeout, retained results, and subsequent ordinary and actual-plan execution.
