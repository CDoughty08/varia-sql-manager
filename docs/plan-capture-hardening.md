# Actual-plan collector recovery and integration validation

This addresses **Q9 only** in [issue #159](https://github.com/CDoughty08/varia-sql-manager/issues/159), re-verified against main at `da4efcc96c2844018ba722f4d5ff0aee5f56e0f4`. That revision created randomly named Extended Events collectors and had no recovery sweep. SQL Server before major 17 had no collector `MAX_DURATION`. The issue's separate XML allocation and per-row allocation findings are outside this change.

## Recovery

Actual and Live toolbar capture use the same observer-owned collector. After the existing create/enable/read/drop permission preflight, a server-scoped observer records the query and observer **physical SQL Server connection IDs**. The server collector name is `VariaActual_<client GUID N>_<query physical GUID N>_<observer physical GUID N>` (110 characters). The first GUID still binds the event predicate to SqlClient's `ClientConnectionId`; the other two identify DMV liveness. ClientConnectionId and the server's connection_id are different identifiers. Physical roots, rather than transient MARS request connections, protect sessions that use Multiple Active Result Sets. Database-scoped capture retains its random GUID names and does not acquire additional DMV permissions.

Before creating a new server-scoped collector, recovery selects at most 17 abandoned-looking definitions and checks at most 16. It has a one-second slice **inside** the existing five-second setup budget. A collector is eligible only when both physical connections are absent, its canonical name parses, its batch/plan predicates exactly match the named client GUID and same valid SPID, and its event/action/target shape matches Varia's collector. A prefix, program name, host process, reused SPID or elapsed execution time alone never authorizes removal. Idle connections are live connections.

The scan rotates: each server (by data source) keeps the id of the last definition a capture examined, and the next capture's candidates start after it and wrap around. Definitions that are refused, fail to drop or block until the slice ends therefore cannot keep later orphans from every capture ([#258](https://github.com/CDoughty08/varia-sql-manager/issues/258)). A DROP the server refuses (a lock timeout, a concurrent change) marks the pass incomplete and goes on to the next definition; a lost connection or the end of the slice ends the pass.

Server-scoped collectors named by earlier builds (`VariaActual_` plus 32 hex digits: a random GUID, or the query connection's ID) cannot prove their observer is gone; this build names only database-scoped collectors that way, and those are never swept. A legacy name is therefore swept only when it is clearly abandoned ([#233](https://github.com/CDoughty08/varia-sql-manager/issues/233)): its event/action/target shape matches Varia's collector, and it is stopped (in `sys.server_event_sessions` but not `sys.dm_xe_sessions`) or `sys.dm_xe_sessions.create_time` is more than a day old. A running legacy collector younger than a day may belong to an older build that is still capturing, and stays.

Immediately before each DROP, SQL Server rechecks the definition ID, name, both predicates (or, for a legacy name, that it is still stopped or a day old), event/action/target shape and both connection identities. It builds the identifier with `QUOTENAME` on the server. All values in the creation and cleanup DDL are parameters. Every statement is rendered once per scope and version variant and held to `ActualPlanSql.Lint`: dynamic SQL only through `sys.sp_executesql` of text built from literals, `QUOTENAME(@name)` and server-side `CONVERT`s of typed parameters, only known variables, and no DDL but event sessions'. Normal cleanup still removes the current collector, even after a failed start or read. The existing independent five-second read and cleanup deadlines remain. No recovery SQL runs on the user's query connection; ordinary execution's cross-run `@@ROWCOUNT` and `@@ERROR` semantics are preserved. Statistics start after capture setup and finish before observer collection.

Recovery inspection, permission or DROP failure produces a bounded notice and is retried on a later capture. Optional capture can still fail without preventing ordinary SQL execution or Client Statistics. SQL Server 2025 and database-scoped sessions retain their existing `MAX_DURATION` backstop; recovery also removes stopped collector definitions. Recovery runs when a later authorized capture starts, rather than on a background timer.

## Deliberate limitations

- Legacy single-GUID collector names (random GUIDs or the query connection's GUID) do not identify their observer. Recovery removes them only once stopped or a day old; a running one younger than that waits, since it cannot be told apart from an active legacy collector finishing collection after its query connection closed. Sessions of any other shape under such a name are left alone.
- Azure SQL database-scoped connection DMVs cannot prove global absence after `USE` moves a query to another database. Database-scoped collectors keep normal cleanup and `MAX_DURATION`, but do not use the server sweep. No Azure tenant was available for live validation.
- Unknown or modified ownership/predicate shapes are left alone. A permission failure or delayed server observation of a disconnected connection defers recovery. Large backlogs require subsequent capture attempts. An application that never starts another capture cannot run client recovery.
- SQL Server 2016 remains unsupported for lightweight Actual/Live capture. Execution remains available.

## Validation coverage

Local real-server validation uses Windows integrated authentication against SQL Server **2025 Developer, 17.0.1000.7**, engine edition 3. Recovery tests create uniquely named collectors on fresh unpooled connections, scope every sweep to an exact test-created name, use bounded work, and drop only their own definitions in `finally` with a fresh teardown budget. The no-`MAX_DURATION` branch is executed on that real server using the pre-17 DDL variant; this is **not** a claim of a live SQL Server 2017/2019/2022 run. Those versions and Azure need their own matrix/tenant runs. Both MARS and ordinary connections are exercised.

| Workflow | Regression coverage |
| --- | --- |
| Collector ownership and recovery | Exact client predicate; independent physical IDs; active/idle query and observer protection; final DROP recheck; both connections lost; next StartAsync recovery; modified definition; denied inspection; permission preflight; setup cancellation; normal cleanup; no-MAX_DURATION DDL; sixteen refused definitions ahead of an orphan (live) and refused, failing and legacy backlogs (offline); running and stopped legacy collectors; the collector SQL lint |
| Actual / Live | Existing Execution live suite: batch ordering, GO repetitions, grid limits, manual STATISTICS XML deduplication, read failure, cancellation/timeout, temp objects, transactions, cross-run row count; changing live counters and incremental topology, observer isolation, credit, unsupported/denied sampling |
| Isolated / session-aware Estimated | EstimatedPlans live suite and Electron toolbar/shortcut/selection paths: compile errors, guards, permission failures, busy tabs, cancellation/timeout, capture cleanup failure, disconnect, temp objects, SET/database restoration and ordinary/actual execution afterward |
| Session-aware estimation semantics | Explicitly checks `@@ROWCOUNT=0` and `@@ERROR=0` after cleanup, preserved transaction/data under normal compilation and cancellation with XACT_ABORT OFF, and SQL Server attention rolling back the pre-existing transaction with XACT_ABORT ON while retaining the option and usable session |
| Client Statistics | Backend and Electron checks: GO aggregation, optional capture, per-run labels, cancellations/errors, disabled collection, backend loss/restart and unavailable samples; observer setup/read/recovery excluded from ordinary query counters |
| Retained Plans | Fake and SQL-backed Electron launches: pin/save original XML, re-execution and result release, Close Results, selected SQL and source line, session-aware acquisition label/SPID, partial cancellation, close all tabs, backend loss, reopen, remove and window reset |
| Diagnostics / saved plans | Real parameterized seek, repeated GO, worker totals, constrained-memory spills; saved diagnostic XML through File Open, predicates/parameters/missing indexes/rankings/source; large saved-plan canvas and selection |
| Preparation and viewer lifecycle | Full unit suite: independent parse/layout/retained budgets, cancellation, release, backend generations, late completions, immutable snapshots and stable source/statement/operator identities; Electron hide/show, Graph/XML, popout/dock/resize/close and window restart |

The Live Plan Electron suite additionally kills the real sidecar while one query tab profiles, inspects only that run's collector from another tab, verifies partial live data and unavailable statistics, reconnects through the normal palette/dialog, and confirms the next toolbar Actual capture removes the abandoned collector. No renderer hook starts capture or estimation. The existing backend-kill smoke hook supplies the failure; direct bounded requests are used only for failed-test teardown.

Adversarial review focused on accidentally dropping active sessions, confusing client/server IDs, MARS child lifetimes, concurrent sweeps/definition changes, permission failures, optional-capture availability and deadline inflation. The real-server regressions exposed and corrected the client/server ID mismatch and predicate XML empty-element serialization before delivery. Renderer navigation/comparison code and plan contracts are unchanged by this track.

Run the required `npm run check` before committing. Focused live and Electron commands:

```powershell
$env:VARIA_TEST_SQL_SERVER='localhost'
dotnet run --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release -- --live-suite Execution
dotnet run --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release -- --live-suite EstimatedPlans
dotnet run --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release -- --live-suite ClientStatistics
node scripts/live-plan-smoke.mjs
node scripts/estimated-plans-smoke.mjs
node scripts/retained-plans-smoke.mjs
node scripts/client-statistics-check.mjs
node scripts/popout-smoke.mjs
```
