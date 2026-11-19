# Execution plans and Client Statistics

Varia shows Actual, Live and Estimated execution plans in one **Execution Plan** output, keeps a per-window history of
plan XML, compares two plans side by side, and records per-execution SqlClient statistics. This page describes how each
works, what it needs from SQL Server, and its limits. The [Limits](#limits) section collects the numbers in one place.

## Viewing plans

The Execution Plan output and `.sqlplan` documents share one Pixi viewer. Open a captured Actual, Live or Estimated
plan in the output pane, or open a saved `.sqlplan` file. The original XML is never changed and stays available from
the plan document.

### Canvas

- Operator icons come from the workbench icon registry by family (seeks, scans, joins, sorts, aggregates, exchanges,
  spools and so on); unknown operators get a generic icon. Colours follow the theme.
- Row flow labels describe the **child's output into its consuming parent**; arrows point toward the parent. Actual
  values include measured zero; estimates say `Est.` (or `rows/exec` without estimated executions); live values say
  `Live partial`, even after a stopped execution. Line width is logarithmic and capped and does not show provenance.
- **Collapse inputs** and **Expand inputs** act on the selected branch, **Expand all** expands every collapsed branch; Left and Right collapse/expand
  before moving to the parent/first input. Collapsing selects the branch root. Selecting a hidden input from the
  outline, search or rankings expands only its ancestors.
- The minimap (at most 80 × 48 cells) centres the viewport on click or drag; when focused, arrow keys pan and Home fits
  the batch. It hides when the canvas is under 240 × 160 px.
- Outline and properties separators accept dragging, arrow keys, Home and End. Pane widths and visibility, minimap and
  row-flow visibility persist in settings. Camera, selection and collapsed branches live in a bounded in-memory view
  cache that survives Graph/XML switches, hidden views and layout moves, but not restarts.

### Navigation

- Drag or scroll to pan; pinch or Ctrl+scroll (⌘+scroll on macOS) to zoom, or use the toolbar's Zoom out, Zoom in and
  percentage (reset) buttons. Up/Down and Home/End select operators; Left/Right collapse or expand a branch, or move to the
  parent or first child. **Fit statement** and **Fit batch** fit the view to the active
  statement or the whole batch.
- The virtual outline lists every operator, including inputs hidden in the graph, and supplies the row-flow wording to
  assistive technology even when edge labels are hidden at low zoom. Its rows expose selection, position and expansion
  state.
- The outline's ranking selector ranks available CPU, elapsed time or row-estimate discrepancy, descending. Unreported
  values are excluded, measured zeros remain, and ties keep plan order. Search and warning filters work with rankings.
  Without a search or filter, rankings apply to the selected statement.
- **Statement SQL** shows compiler-supplied text for exactly the current statement; **Back to graph** keeps selection and
  camera. It does not guess a location in an edited query, a repeated statement, a procedure or dynamic SQL.
- **Go to XML** opens the source plan document at the operator, verified by NodeId and document revision; it is
  unavailable for live-only operators. Graph/XML switches keep the XML caret and the graph selection independently.
  Moving the XML caret or editing XML lets Graph select the containing operator. The lookup runs only on navigation and
  handles namespaces, nested statements, comments, CDATA and repeated NodeIds.
- Forced colours mode uses the outline/properties view without GPU preparation; Statement SQL remains available. Every
  pointer action has a toolbar or keyboard path.

### Properties and diagnostics

Select an operator in the canvas or outline. Hover shows a compact summary. The properties pane shows seek ranges and
residual predicates, output columns, compiled/runtime parameters, memory grants, warning attributes, missing-index
column usage, spill records, estimated execution mode, parallelism and per-thread runtime, when the plan supplies them.

Counter scopes:

- Rows, CPU milliseconds and executions sum every `RunTimeCountersPerThread` entry (already per entry, never multiplied
  by `ActualExecutions`). Repeated thread IDs stay separate, coordinator thread 0 stays visible, and worker execution
  counts are not statement execution counts.
- Elapsed milliseconds are the maximum cumulative `ActualElapsedms`, not query wall time. Operator times can include
  child work and overlap, so rankings are neither additive totals nor self time.
- A counter absent or invalid (negative, non-finite) on any entry makes that aggregate unavailable; a valid zero shows
  as zero; no runtime entries means no aggregate. Individual counters stay inspectable.
- Estimated rows are per execution. Estimated executions are `1 + EstimateRebinds + EstimateRewinds`, only when both
  attributes are valid. Estimated total rows multiply the two, never by actual worker executions.
- Discrepancy compares actual total rows with estimated total rows: larger divided by smaller, marked underestimate or
  overestimate. Both zero gives 1×; exactly one zero gives ∞×. Missing estimates or runtime rows make it unavailable.
  Live totals stay partial.
- Costs, estimated rows/executions, estimated execution mode and missing-index impact are optimizer estimates in every
  plan kind. Missing-index suggestions keep EQUALITY, INEQUALITY and INCLUDE groups; they are not actions.
- Parameters keep compiled and runtime values separately; an absent runtime value is unavailable, not the compiled one.
  Memory amounts are KiB and GrantWaitTime is milliseconds. Warning and spill attributes keep SQL Server's names and
  units, including unknown newer attributes.

The model follows Microsoft's [Showplan schemas](https://schemas.microsoft.com/sqlserver/2004/07/showplan/) and
[per-operator runtime counters](https://support.microsoft.com/en-us/servicing/sql/sql-server-2014/cumulative-update/kb3170113-3170113-update-to-expose-per-operator-query-execution-statistics-in-showplan-xml-and-exten).

## Actual plans and capture

**Include Actual Execution Plan** (Ctrl+M on Windows/Linux, query toolbar or Query menu, per query tab) captures completed plans through an observer-owned Extended Events collector on a
separate connection. No capture SQL runs on the user's query connection, so `@@ROWCOUNT` and `@@ERROR` behave as in
ordinary execution across runs. Statistics collection starts after capture setup and finishes before observer
collection.

Requirements:

- SQL Server 2017 CU14 or later (the `query_post_execution_plan_profile` event), or Azure SQL / Managed Instance. SQL
  Server 2016 is unsupported for Actual and Live capture; execution remains available.
- Permission to create, enable, read and drop the Extended Events session, checked by a preflight.

Capture is optional: a failure never prevents ordinary execution or Client Statistics. Setup, read and cleanup have
independent deadlines. Cleanup removes the collector even after a failed start or read; on SQL Server 2025 and for
database-scoped sessions, `MAX_DURATION` is a backstop.

### Collector recovery

If the application or backend dies mid-capture, its collector can be left on the server. A later server-scoped capture
removes such collectors; there is no background timer.

- Server-scoped collectors are named `VariaActual_<client GUID>_<query physical GUID>_<observer physical GUID>` (110
  characters): SqlClient's `ClientConnectionId` for the event predicate, then the query's and observer's **physical**
  server connection IDs (not MARS request connections) to prove liveness. Database-scoped collectors keep random GUID
  names and need no extra DMV permissions.
- Recovery runs in a slice of the setup budget (see [Limits](#limits)). A collector is removed only when both physical
  connections are absent, its name parses, its predicates exactly match the named client GUID and one valid SPID, and
  its event/action/target shape matches Varia's. A prefix, program name, host, reused SPID or age alone never
  authorises removal; idle connections count as live.
- The scan rotates per server, starting after the last definition the previous capture examined, so refused or
  blocking definitions cannot hide later orphans. A refused DROP moves on; a lost connection or the end of the slice
  ends the pass.
- Legacy names from earlier builds (`VariaActual_` plus 32 hex digits) cannot identify their observer. One is removed
  only if its shape and predicates (session id and client connection id) match Varia's and either it is stopped while no
  connection holds its watched session id, or its `sys.dm_xe_sessions.create_time` (server local time) is more than a
  day old. Running legacy collectors younger than a day, and stopped ones whose session id is held, are left alone.
- Immediately before each DROP, SQL Server rechecks the definition ID, name, predicates, shape and both connection
  identities. The identifier is built server-side with `QUOTENAME`; all DDL values are parameters, and the statements
  are held to `ActualPlanSql.Lint` (dynamic SQL only through `sys.sp_executesql` of literals, `QUOTENAME(@name)` and
  server-side `CONVERT`s; only known variables; no DDL but event sessions').
- Inspection, permission or DROP failures produce a bounded notice and are retried on a later capture.

Limitations: database-scoped collectors (including Azure SQL, whose database-scoped DMVs cannot prove global absence
after `USE`) are never swept and rely on normal cleanup and `MAX_DURATION`. Unknown or modified shapes are left alone.
A permission failure or a server that has not yet noticed a disconnect defers recovery. Large backlogs take several
captures. An installation that never starts another capture never recovers. Recovery is live-tested on SQL Server 2025
only (including the pre-2025 no-`MAX_DURATION` DDL); 2017-2022 and Azure have not been run live.

## Live plans

Enable **Include Live Execution Plan** for a query tab from its toolbar, the Query menu or the command palette, then
execute normally (F5, Execute or a selection). It applies to queries executed in Varia. The Execution Plan output shows
Live and Actual modes and switches to Actual on completion. A cancelled, timed out or failed statement can keep a
partial live snapshot beside completed captured statements; partial snapshots are labelled as such and never presented
as actual statistics.

Requirements:

- SQL Server 2017 or later, or Azure SQL / Managed Instance. Enabling Live also requests Actual capture, so the
  combined feature needs 2017 CU14+; SQL Server 2016 is reported unsupported.
- Lightweight profiling. It is on by default from 2019 but can be disabled per database. On 2017, starting the Actual
  capture event enables it. Varia never changes trace flags or database settings.
- `VIEW SERVER STATE` through 2019, `VIEW SERVER PERFORMANCE STATE` from 2022. Azure SQL needs `VIEW DATABASE STATE` or
  administrator access depending on tier. Without Actual capture rights, an already profiled query can still show
  transient data.
- Standard profiling and runtime parameter collection are never enabled; runtime parameter values appear only if SQL
  Server supplies them.

Behaviour:

- The user's batches run with their normal SET, transaction, temporary-table and row-count semantics. No profiling SET
  option, hint, trace flag or database configuration is injected.
- Sampling uses `live.subscribe`/`live.update` (`query.plan`), keyed only by the executing query UUID and resolved
  only for its owning connection. An observer on the monitor pool reads `sys.dm_exec_query_statistics_xml` and checks
  permissions in the same round trip. Each sample verifies the SPID and server connection ID and is discarded if the
  batch/GO-iteration changed during the read. Rows and CPU sum over threads; elapsed time uses the maximum.
- Sampling runs at most once a second, slowed by the scheduler's time budget, renderer acknowledgements and load
  backoff. Statements that finish between samples appear through Actual capture when available. SQL Server can return
  NULL when profiling is unavailable or the plan exceeds its XML nesting limit.
- The first sample (or a changed plan or batch) carries the parsed plan; later samples carry counters only. Live and
  completed statements match by StatementId, QueryHash, a SQL text hash, NodeId, batch and GO iteration. The text and
  literal-expression hashes together separate different SQL that reuses IDs and query hashes; a statement with an
  unknown batch identity is kept separate. Ambiguous snapshots stay partial, and repeated runs of an identical
  statement between samples cannot be told apart. A recompilation with a new structure gets a new layout; camera and
  matching selections persist.
- An operator is highlighted as active when its output rows increased since the previous sample. Blocked operators, or
  ones that consumed work without producing rows, are not shown as active.
- Live samples do not carry per-thread diagnostics, spill or grant details; those appear from the captured Actual XML.
- Closing results, replacing the run or closing the tab releases live data; finishing stops the subscription and keeps
  the last sample. Permission, version, budget and backend-loss problems appear as view states while execution keeps
  its own outcome.

References: [live XML API and permissions](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-statistics-xml-transact-sql),
[profiling infrastructure](https://learn.microsoft.com/en-us/sql/relational-databases/performance/query-profiling-infrastructure).

## Estimated plans

Use **Query › Display Estimated Execution Plan**, the toolbar's **Estimated Plan**, the editor context menu or
**Ctrl+L** (**⌘L** on macOS). A selection takes precedence over the whole editor. The query must be connected.
**Cancel** stops acquisition, including compilation waiting on schema locks.

Results appear in the Execution plan pane labelled **Estimated**, with the same canvas, outline, search, properties,
zoom and fit; runtime rows and timings are unavailable. **Open plan document** opens a `.sqlplan` document with the
normal save and recovery behaviour. Estimation keeps the last data grids, does not change **Include Actual Execution
Plan**, and is replaced by the next ordinary execution. The selected output view is kept when you return to the tab or
press **Ctrl+R**.

### Isolated and query-session modes

- **Isolated** (default; toolbar and Ctrl+L) opens a fresh, unpooled connection with connection recovery disabled,
  using the query's credentials, selected database and Varia's SET defaults. The tab's session, transactions,
  temporary objects and SET options are untouched whatever happens, but the estimate cannot see local temporary tables
  or procedures, earlier SET changes, impersonation or uncommitted changes.
- **Query session** (**Query › Display Estimated Plan in Query Session**, the context menu, or **Estimate in query
  session** in the pane) is opt-in for each acquisition. It borrows the tab's physical connection through its session
  gate, opening one with the normal defaults if needed; an existing session is never reinitialised or silently
  reconnected. Temporary objects, runtime SET options, impersonation and uncommitted data are visible to compilation.
  The toolbar database is applied temporarily and restored, as are standalone `USE` batches. The pane labels the mode
  and offers **Estimate in isolation**. The result reports the final compilation database and the borrowed session's
  SPID/login.

Neither mode executes anything. Create-then-use temporary-object scripts can fail; table and local variables from
earlier submissions are unavailable; SET, EXECUTE AS and transaction commands in the selection are not executed.
Dynamic SQL and stored procedures have SQL Server's usual estimated-plan limitations.

Query-session compilation has side effects:

- `@@ROWCOUNT` and `@@ERROR` are overwritten (both 0 after successful cleanup) and cannot be restored.
- SQL Server can take schema locks and update statistics. Cancelling blocked compilation with **XACT_ABORT ON** can roll
  back the open transaction. Check `@@TRANCOUNT`/`XACT_STATE()` after a cancellation or error.
- TEXTSIZE is raised temporarily so XML is not truncated, then restored with QUOTED_IDENTIFIER and the database. Other
  SET options stay in force. Scripts containing OFFSETS or FIPS_FLAGGER are refused in session mode.
- An existing SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY setting that stops a sentinel SELECT from running causes refusal;
  the setting is left unchanged.

### Batches and guards

The whole selection is validated before a connection opens, with normal GO parsing, repetitions, SQLCMD rejection and
line offsets. A standalone `USE [database]` batch switches database between compiled batches; batches mixing `USE` and
queries are rejected (split at GO or pick the database in the toolbar). The tab's database is not changed.

`SHOWPLAN_XML` is turned on in a separate batch. Explicit SHOWPLAN, NOEXEC, PARSEONLY and FMTONLY tokens are refused
anywhere in the SQL, ignoring strings and comments, so submitted SQL can never switch capture off and execute. An
identifier with one of those names can also be refused.

Compiling needs the permissions to compile the SQL, including SHOWPLAN in referenced user databases
([SET SHOWPLAN_XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql)). Errors
appear in the pane; Varia never falls back to executing the query and never retries it.

### Cleanup and tab lifecycle

Every capture turns SHOWPLAN off under its own cleanup budget, and isolated connections are always disposed. In
query-session mode, Varia then checks that a sentinel SELECT executes and restores context; after errors, cancellation
or timeouts the session stays open if cleanup succeeds, and the error text tells that apart from `SESSION_LOST`. If
cleanup or transport fails, the session is closed (SQL Server rolls back its transaction and drops its temporary
objects) and the next execution opens a new one. A previously unfinished commit keeps its unknown-outcome warning.

Nothing queues on a busy session gate: a running query blocks both modes, and a session estimate blocks state reads,
commits and execution until it settles. Closing a tab during an isolated estimate shows the normal commit-or-rollback
prompt; cancelling the prompt keeps the estimate running, and proceeding cancels it without forcing a rollback of the
ordinary transaction. During a session estimate, closing uses the **running query** prompt: **Keep Running** leaves
capture running, and proceeding cancels, waits, then closes with rollback.

## Plan history

Open **Window › Execution Plan** (or **Show Execution Plan** in the palette) and select **Plan history**. The window
copies the original XML of completed Actual captures, Showplan results returned by SQL, and successful estimates,
whether or not their viewer was opened. Transient live samples are not retained.

- Select a snapshot to view it. **Open snapshot document** opens an independent `.sqlplan` document. **Save plan as…**
  saves `.sqlplan` or `.xml` directly, including XML too large for an editor. Saved files contain only the original
  XML.
- **Pin snapshot** protects an entry from eviction. **Remove snapshot** removes it, pinned or not. **Clear unpinned**
  keeps pins; **Clear all snapshots** removes them too. Both cancel pending copies. Opened documents and saved files are
  unaffected, and editing a document does not change its snapshot.
- History belongs to the workbench window, across all its query tabs (popouts use their owner's). It survives
  re-execution, closing results or tabs, disconnecting, backend loss and closing the pane. Closing or reloading the
  window clears it, pins included; it is not part of hot exit or recovery.
- Each entry records, when known, its source, capture type, batch, tab, server, requested and final database, timing,
  SPID/login and the submitted SQL with its starting line. Metadata is copied at start and completion, so later edits do
  not rewrite it. SQL can contain sensitive literals; history stays in memory unless saved.
- Labels: toolbar captures are **Actual** (even with Live on). Estimates are **Estimated** with their **Isolated** or
  **Query session** mode. SQL-returned results are **SQL-returned (capture type unspecified)**, because the result does
  not say whether `SHOWPLAN_XML` or `STATISTICS XML` produced them. Completed statements from a cancelled, failed or
  lost run are **Partial execution**; incomplete or truncated XML is labelled separately. Full SET options, parameters
  and server environment are not reconstructed, and the final database does not identify each statement's database in a
  `USE` batch.
- Acquisition: a query stays reserved until its XML copy settles, so the next F5 cannot release XML before it is
  copied. Closing a tab before its execution completes creates no history. Backend loss keeps entries already copied;
  unread sources fail with a notice, and failures do not block later documents. Clearing invalidates pending reads.
  Excess concurrent completions are skipped with a notice rather than queued. The pane shows the latest retention issue,
  not a full log.
- Building a graph needs the backend parser; XML source and saving work without it.

## Comparing plans

Open **Window › Execution Plan › Plan history › Compare plans**, choose left and right inputs (retained snapshots or
open `.sqlplan` documents; **Open saved plan…** adds a file) and press **Compare selected plans**. The same input can
be chosen twice. Similar choices are told apart by folder, start time or a short identifier; the full path or capture
context is the tooltip. There is one comparison pane per window; closing it releases everything, and nothing is
persisted.

- Pressing Compare freezes both XML strings, including a document's unsaved edits. Later edits, saves, renames,
  closing or history eviction do not change the comparison; Compare again to refresh. A document still loading cannot
  be chosen. **Swap plans** reverses the sides and delta direction, reusing parses and layouts. **Open frozen XML** opens
  one side's exact input.
- Retained inputs keep capture type, estimation mode, batch/repetition, outcome and partial/incomplete/truncated flags.
  Saved XML has none of these, and they are shown as unavailable; runtime fields do not imply a capture type.

### Pairing

- Statements pair by unique exact trimmed text and type, then by unique query hash and type. Text is not case folded or
  whitespace normalised. Repeated statements are ambiguous; StatementId and order never decide. Hashes are hints, not
  proof of equivalence.
- Operators within a paired statement pair by unique physical/logical operation, object and normalised predicates;
  then operation and object; then logical operation and object (allowing a changed physical operator). Uniqueness is
  checked against the whole scope. Paired parents can disambiguate operators in different branches; identical repeated
  siblings stay ambiguous. NodeId, position, cost and runtime counters never decide identity. Matching is
  deterministic and conservative and can leave plausible counterparts unpaired.
- Values the parser shortened (`textShortened`, `identityShortened`, `detailsShortened`) never form an exact match on
  that field; where shortened values agree, the UI says equality is unverified instead of `Same`.

### Inspecting differences

- The statement selector lists paired, ambiguous and side-only statements. The **Pairing list** shows operator entries
  with reasons, 50 per page. Outlines mark side-only, ambiguous, structural changes (different paired parent or sibling
  position) and property changes (raw properties, predicates, outputs, warnings, spills). An unpaired parent makes the
  structural relationship unavailable.
- **Differences** shows the selected pair's estimates, counters, properties and diagnostics in the **Operator
  differences** grid, and, under **Statement estimates, parameters, memory grants and warnings**, the paired statements'
  in the **Statement differences** grid. Each row says what changed in its Delta / change column. Both are results grids:
  select cells or Ctrl+A, copy with Ctrl+C or Ctrl+Shift+C (with headers), sort by a header, or save through **Save
  Results As**. Each viewer's Properties pane remains available.
- **Link selection, zoom and pan** is on by default: selecting an operator selects its counterpart (or clears the other
  side), selecting a statement pair moves both outlines, and both canvases share camera coordinates. Turn it off for
  independent views; Differences still follows the last inspected pair.

### Units

- Deltas are **right minus left**; percentage is `(right − left) / left × 100`. Two zeros give 0 and 0%; a nonzero value
  against zero says **zero baseline**. Missing, invalid, negative, non-finite or overflowing values are unavailable.
- Counters and estimates use the scopes in [Properties and diagnostics](#properties-and-diagnostics). Operators are not
  summed into query totals, costs are optimizer cost units (not milliseconds), GO repetitions are separate inputs,
  and no per-worker normalisation or statistical significance is inferred. Partial captures stay partial.
- A reported empty parameter value is a measured empty string; missing is unavailable. Unavailable or omitted lists
  never become zero; an empty list says None reported.

Comparison does not cover live samples, semantic equivalence, manual pairing or per-worker matching.

## Client Statistics

Use **Query → Include Client Statistics** (Shift+Alt+S on Windows/Linux), the palette or the toolbar. The toggle
belongs to the query tab. Execute normally, then open **Client Statistics** beside Results and Messages or through
**Window → Client Statistics**.

- The comparison is a results grid in the report's order (it does not sort): select cells or press Ctrl+A, then Ctrl+C
  or Ctrl+Shift+C to copy with headers, ready to paste into a spreadsheet, or **Save Results As** to write CSV, TSV or
  JSON. Each measurement's definition is its last column.
- Each included execution is one sample, with all GO batches and repetitions combined. Choosing an execution compares it
  with the previous included attempt in the same context; Change is selected minus previous. Average uses only
  successful, available samples, per metric. Zero is measured; **Unavailable** means no usable measurement. Errors,
  cancellations and timeouts keep partial counters but are excluded from averages. An execution with no summary (for
  example a backend crash) has an unavailable sample.
- History holds ten attempts per tab, including the running one, in renderer memory. Re-execution and Close Results
  keep it; closing the tab, **Reset Statistics** (Query › Reset Client Statistics; touches neither SQL Server nor the toggle) or closing or
  reloading the window
  clears it; turning collection off keeps it. Changing connection or database, session loss or reconnect, and changing
  Actual or Live capture start a new comparison context. Completed samples survive backend restarts. Tabs never share
  history.
- SqlConnection statistics are reset after session setup (prologue, database change, plan observer) and read after
  every reader closes. No extra SQL runs on the user's connection, so `@@ROWCOUNT`, `@@ERROR`, SET options, temporary
  objects and transactions are preserved. Monitoring and plan capture use other connections and are excluded;
  user-requested `STATISTICS XML` output is included. Server profiling can still affect performance.
- Metrics (each is defined in the pane): bytes and buffers are SqlClient TDS traffic including metadata and messages,
  not TCP packets. Round trips are command/reply exchanges. Statement, row and transaction counts follow completion
  tokens; `SET NOCOUNT ON` can suppress row counts, interrupted statements may be missing, and rows beyond display
  limits are still counted.
- `NetworkServerTime` is reply-wait time, combining network latency and server work. Collection wall time is Varia's
  backend stopwatch for executing, reading, formatting and storing results, excluding connection setup, observer work,
  IPC and painting. Both have millisecond resolution and can be zero; neither is SQL Server CPU time.
- `ExecutionTime` is deliberately not shown: with Microsoft.Data.SqlClient 7.1 the asynchronous path reports 0 ms for a
  query that waited about 150 ms. `ConnectionTime` is not an execution timer and is omitted. Missing, negative, saturated
  or wrongly typed counters are omitted, never shown as zero. See Microsoft's [provider statistics
  reference](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/provider-statistics-sql-server).

## Limits

| Area | Limit |
| --- | --- |
| Live sample | 1,048,576 XML characters, 2,000 operators, 192 KiB serialized payload; at most one sample a second |
| Live retention | 512 statements, 10,000 operators and 4 MiB parsed live data per run; 8 live snapshots per window (older inactive ones released; their actual plans stay in the result store) |
| Actual-mode canvas | 512 statements, 10,000 operators; captured actual data takes priority over partial snapshots, which stay visible in Live mode |
| Plan document | 8,388,608 XML characters, 512 statements, 10,000 operators |
| Actual capture | 5 s setup (including a 1 s recovery slice: 17 candidates selected, 16 checked), 5 s read, 5 s cleanup |
| Estimate request | 30 s acquisition budget, 35 s IPC deadline, 2 in flight, 64 XML documents, 2,097,152 total XML characters; 2 s SHOWPLAN cleanup |
| Retained estimates (renderer) | 16,777,216 characters across tabs; older tabs say when an estimate was released and can request it again |
| Plan history | 32 entries and 64 MiB accounted payload (pins count; oldest unpinned evicted first; when pins fill it, new entries are rejected with a notice); 64 documents per execution; 2 acquisitions per window, 5 s deadline each |
| Comparison | 2 frozen inputs (up to 32 MiB UTF-16 XML); 35 s preparation deadline; up to 20,000 operator entries; 50 pairing entries per page; text cells show 4,096 characters (equality uses the full value) |
| Diagnostics | 64 items per structured list, 128 thread entries per operator, 16,384 structured entries per document, 1 Mi-character diagnostic text allowance |
| Parsed LRU | 64 entries, 20,000 operators, 16 Mi serialized text units; up to 64 outstanding backend parses |
| Layout LRU | 32 entries, 20,000 operators, 4 Mi weighted units |
| Labels | 128 reusable spare sprites; 2,048 fitted-text entries |
| Minimap | 80 × 48 cells |
| Client Statistics | 10 attempts per query tab |

Exceeding an estimate limit fails the request with advice to estimate a smaller selection. Diagnostic omissions produce
a notice; runtime aggregates still use every thread entry, and the original XML is the complete fallback.

## Implementation notes

Rendering and DPI:

- The canvas uses its window's full device pixel ratio with `autoDensity`. Text rasterises at `renderer.resolution ×
  camera.scale` with `roundPixels`; panning reuses textures and zooming regenerates visible labels. DPI changes and
  popout moves redraw. If full DPI exceeds WebGL limits or the browser allocates a smaller buffer, the highest fitting
  resolution is used; if none matches, the viewer falls back to outline and XML. `PlanCanvas` deletes the `null`
  text-cache entries Pixi 8 leaves for released keys after each frame.
- `npm run test:plan-text-quality -- --baseline <rev>` (default `origin/main`) (installed Chrome or `VARIA_BROWSER_EXECUTABLE`) renders the
  WebGL canvas at several zoom and DPI levels beside a baseline revision into `artifacts/plan-text-quality/`.

Deferral and caching:

- Parsing waits for pane visibility and viewer intersection; layout and Pixi also wait for a visible canvas. Hiding
  output releases Pixi; showing it reuses cached parses and layouts, as do Graph/XML and tab switches. GPU contexts are
  recreated on show. Pixi draws on demand, with no animation ticker, culls to the viewport and draws nothing while
  hidden.
- Parse cache keys include owner, source and document revision and hold parsed models, not XML. Concurrent readers
  share a parse; the last to leave cancels it, but a parse already sent to the backend cannot be cancelled, stays
  counted until it settles and is never retried. Failures are not cached. Layout keys use exact ordered
  statement/operator/parent identities, not runtime values. Result release, backend restarts, query replacement and
  document edits or close invalidate entries; late replies cannot repopulate them.
- Labels are pooled by statement/operator identity and role; only newly visible or changed labels get new text.

Layout and live updates:

- The layout worker uses iterative threaded tidy-tree contours in O(operators + edges), keeping SQL Server's input order
  and orthogonal parent/input ports and compacting irregular subtrees. It supports forests and rejects duplicate IDs,
  missing parents and cycles. A safety timeout, a layout worker that fails to start, or a GPU init or context failure falls back to the
  outline and XML. `tests/bench/plans.bench.ts` measures
  it against floors in `tests/bench/floors.json`.
- Live counter updates are linear in retained operators and invalidate one frame without rebuilding spatial indexes,
  the scene or the layout. Selection and camera survive an output panel unmount.

Parser model:

- Statements and operators carry optional `diagnostics` objects; older replies and saved XML without them still work.
  The parser is a streaming, Showplan-namespace collector with no schema validation or version gates; unknown operators
  keep their raw properties.
- Legacy raw fields take text-budget priority over diagnostics. If diagnostics would exceed the reply cap, they are
  dropped with a notice before a graph that fits without them is rejected. A parameter value cut by the budget is
  unavailable, not empty.

Viewer API for linked views:

- `PlanViewer` takes an optional `controllerRef` (`getCamera`, `setCamera`, `getSelectedOperator`, `selectOperator`)
  and `onCameraChanged`/`onSelectionChanged` callbacks. Unchanged cameras and selections emit nothing, so two viewers
  can forward to each other without looping; `selectOperator('')` clears and unknown IDs are ignored. Host-controlled
  `navigation` values and remote cameras apply without emitting. The viewer does not match operators: hosts pass exact
  viewer identities.
- Comparison matching runs in a terminable worker, linear in the bounded input (indexed equality and paired-parent
  queues, no edit-distance matrix). Changing, swapping or closing terminates workers so stale results cannot restore UI.

Tests: `tests/retained-plans.test.ts`, `tests/plan-comparison.test.ts`, `tests/plan-comparison-ui.test.ts`; the .NET
live suites `Execution`, `EstimatedPlans` and `ClientStatistics`; and `scripts/live-plan-smoke.mjs`,
`scripts/estimated-plans-smoke.mjs`, `scripts/retained-plans-smoke.mjs` (`npm run test:retained-plans`) and
`scripts/client-statistics-check.mjs`. Set `VARIA_TEST_SQL_SERVER` for the real-server lanes; see
[testing.md](testing.md).
