# Client Statistics

Use **Query → Include Client Statistics** (Shift+Alt+S on Windows/Linux), the command palette, or the SQL editor/classic toolbar. The toggle belongs to the query tab. Execute normally with F5 or Execute; open **Client Statistics** beside Results and Messages, or through **Window → Client Statistics**.

Each included execution gets its own sample. Choose an execution to compare it with the preceding included attempt in the same context. Change is the selected value minus the previous value. Average includes only successful, available samples in that context, and each metric's mean uses only the samples supplying that metric. Zero is a measured zero; **Unavailable** means no usable measurement. Errors, cancellation and timeouts retain partial counters but do not contribute to averages. An execution with no returned summary, including a backend crash, has an unavailable sample.

The history holds at most ten attempts per query tab, including the running attempt. It lives in renderer memory, separate from result buffers. Re-execution and Close Results retain it; closing the query tab, Reset Statistics, or closing/reloading the app clears it. Reset does not change SQL Server state or the toggle. Disabling collection retains existing history. Connection/database changes, session loss or closure, reconnects, and changing actual-plan capture or live sampling start another comparison context. Live sampling is kept separate from actual capture alone. Completed samples survive backend restarts; an interrupted execution cannot recover counters from a terminated process. Histories are never combined across tabs.

## Measurement boundary

The collector enables and resets `SqlConnection` statistics after opening the exclusively held query session, applying its prologue, changing database, and configuring the optional actual-plan observer. It retrieves counters after every reader closes, on success and on error, then disables collection before observer collection and session cleanup. All GO batches/repetitions belong to the same sample. No additional SQL is sent on the user's connection. The feature preserves `@@ROWCOUNT`, `@@ERROR`, SET options, temporary objects and open transactions.

Background monitoring uses separate connections. Actual-plan setup, reads and cleanup also use another connection, so their traffic is excluded. Server profiling can still change the query's performance. User-requested `STATISTICS XML` output is query traffic and is included. Concurrent query tabs use different connections and collectors.

## Metrics and limitations

The pane defines each metric beside its values. Bytes and buffers are SqlClient TDS traffic, including metadata and messages; buffers are not TCP packets. Round trips count command/reply exchanges, not packets or statements. Provider statement, row and transaction counters follow completion tokens rather than parsing SQL. `SET NOCOUNT ON` can suppress provider row counts even when Varia receives and displays rows. Counts can also omit interrupted statements. Display/storage limits do not stop reading the SQL response, so provider counters include rows beyond those limits.

`NetworkServerTime` is provider reply-wait time. It includes network latency and server work and cannot separate them. Collection wall time is a Varia backend stopwatch covering batch execution, reading, formatting and storing results. It excludes connection setup, observer work, IPC delivery and renderer painting. Millisecond resolution permits zero for short operations. Neither timer is SQL Server CPU time or pure server execution time. Rendering is not measured here.

`ExecutionTime` is deliberately unavailable. With the installed Microsoft.Data.SqlClient 7.1.1, asynchronous `ExecuteReaderAsync` returned **0 ms** for a batch that waited approximately 150 ms, while `NetworkServerTime` measured the wait. Some synchronous reads can contribute to this counter, making a nonzero value incomplete too. Connection lifetime (`ConnectionTime`) is not an execution timer and is omitted. Missing, negative, saturated/unsafe or wrongly typed provider counters are omitted, never replaced with zero.

See Microsoft's [provider statistics reference](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/provider-statistics-sql-server) for the underlying keys. The installed-provider behavior above was established with Varia's actual asynchronous execution path, not inferred from that reference's synchronous examples.

## Regression checks

`ClientStatisticsChecks` runs through the existing .NET live harness: `VARIA_TEST_SQL_SERVER=localhost` with Windows integrated authentication, then `dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --live-suite ClientStatistics`. It checks session/prologue exclusion, independent resets across measured and unmeasured runs, GO repetition, discarded sets and display limits, NOCOUNT, DML rows, async wait timing, failure, event-triggered cancellation, timeout, and actual-plan observer exclusion. Objects are session-local temporary tables only.

TypeScript checks cover history bounds, partial/unavailable samples, comparison contexts, missing-metric averages, reset races, tab cleanup, query integration, optional request compatibility, strict payload validation and layout compatibility. The results Electron suite reuses its existing isolated-profile launches for toolbar/output-tab comparison and reset checks, with both an old-style stub summary and real SQL Server. `node scripts/client-statistics-check.mjs` runs those focused checks directly; set `VARIA_TEST_SQL_SERVER` to include SQL Server. Screenshots stay under `artifacts/`.
