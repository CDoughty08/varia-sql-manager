# Activity Monitor

<!-- Generated from src/shared/activity/catalog.ts. Regenerate with: npx vitest run tests/activity-catalog.test.ts -u -->

The Activity Monitor's probes, panes, columns, tiles, filters, wait categories and limits are data in
`src/shared/activity/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Activity/activity-catalog.json`
and runs constant SQL from `backend/Varia.Backend/Activity/ActivitySql.cs`. Unlike SSMS, a failing query never pauses
the monitor: each probe fails alone, its panes keep their last data and say why, and the others go on. The Activity
Monitor document shows the overview's tiles and charts; the grids of its panes arrive in stages (Panes, below), and this
page also covers what its catalogue declares for them and the SQL and rules the backend already has.

## The document

Open it with **Tools: Activity Monitor** in the command palette, **View › Activity Monitor**, the toolbar's Activity
Monitor button, or **Activity Monitor** on a connected server's Object Explorer menu. It monitors the server the menu was opened on, else the active document's server,
else the server selected in Object Explorer, else the one connected server; with several it asks which, and with none it
opens the Connect dialog and then the monitor of the new connection. Each connection has one monitor, a tab named
"{server} - Activity Monitor": opening it again shows that tab. A lost connection is refused until it is reconnected, and
Reconnect moves the monitor to a new connection to the same server. Nothing in it is saved: File › Save is not offered,
and it is neither kept by AutoRecover nor restored with the workspace.

Under the title, a fact line names the server, its version, the login and, on Managed Instance, the kind of server:
only what the connection reported, nothing a probe has not produced.

The header says what the monitor is doing ("Live · every 2 s", "Live · slowed to 4 s", "Paused", "Paused while hidden",
"Stopped · backend unavailable") and how old the data is, then the refresh interval, the chart window (1, 5, 15 or 60
minutes, 15 by default; charts reach back as far as Environment › Live Data keeps history), what a sample costs on the server (the sum
of the running probes' last statement times, each listed in its tooltip), and **Pause**, **Refresh Now** and **Split View**,
which show only their icons (named in their tooltips) in a document narrower than 1,040 px, so the title and its state
keep their room in the one header row.
Pause stops collecting, as SSMS's does: no SQL runs, the charts keep their history and show a gap, and Resume starts a
new baseline. A monitor whose tab is not showing pauses by itself after the Live Data delay. A monitor keeps its
interval, window, panes and charts while other tabs show; Tools › Options › Activity Monitor sets what a new one starts
with, and the tiles' thresholds.

The eight tiles (below) show their value, unit and secondary figures over a sparkline of the window. A tile's button (or a
click on the tile) expands its chart under the tiles; at most 2 are expanded, a third replacing the oldest, and the first two
are expanded on first open, so SSMS's view is there at once. An expanded chart draws the tile's value and its secondary
series that share its unit, with axes, a crosshair shared by the charts and "View as table" (its last 60 samples). A tile
past a threshold is outlined in its tone with a glyph, and the crossing is announced once. Without the server-state
permission the document still opens: it says which permission it needs (VIEW SERVER PERFORMANCE STATE from SQL Server
2022, VIEW SERVER STATE before it and on Managed Instance), offers **Copy GRANT statement** when it knows the login
(quoted as one name, never run by Varia) and **Retry**, and the tiles say "No permission"; the same holds when the
permission goes while the monitor runs (the overview then stops for good). A sample that fails for another reason
(blocked, timed out) keeps the tiles' last values, and a note above them gives the reason until a sample succeeds; the
probe retries by itself. A monitor that stops because none of its probes can run on the server (NOT_SUPPORTED) says the
server is not covered and offers no Retry; one that stops for the permission shows the permission message, whose Retry
helps once the GRANT has run.

The panes sit in one slot, or two with Split View: side by side when the document is at least 1,400 px wide, stacked
below that, each then at least 200 px tall, with a splitter (arrow keys, Home and End). The tiles keep their height and
the expanded charts give way down to a floor, so the panes keep theirs; only a document too short for all of them
scrolls. Each slot has a tab per pane; choosing in one slot the pane the
other shows swaps them. The Blocking tab counts blocked sessions. A pane whose grid has not arrived says so, and its
probe stays paused: no SQL runs for a pane nobody can read.

| Pane | Now |
| --- | --- |
| Processes | Processes is not shown yet; it arrives in a later version of Varia. |
| Blocking | Blocking is not shown yet; it arrives in a later version of Varia. |
| Resource Waits | Resource Waits is not shown yet; it arrives in a later version of Varia. |
| Data File I/O | Data File I/O is not shown yet; it arrives in a later version of Varia. |
| Recent Expensive Queries | Recent Expensive Queries is not shown yet; it arrives in a later version of Varia. |
| Active Expensive Queries | Active Expensive Queries is not shown yet; it arrives in a later version of Varia. |

| Command | Id | Windows and Linux | macOS |
| --- | --- | --- | --- |
| Activity Monitor | `activity.open` | — | ⌥⌘A |
| Pause | `activity.togglePause` | — | — |
| Refresh Now | `activity.refresh` | F5 | F5 |
| Set Refresh Interval… | `activity.setInterval` | — | — |
| Set Chart Window… | `activity.setChartWindow` | — | — |
| Split View | `activity.toggleSplit` | — | — |
| Next Panel | `activity.nextPane` | F6 | F6 |
| Previous Panel | `activity.previousPane` | Shift+F6 | ⇧F6 |
| Close Activity Monitor | `activity.close` | Shift+Escape | ⇧⎋ |

SSMS opens Activity Monitor with Ctrl+Alt+A. On Windows and Linux, Ctrl+Alt+letter is AltGr, which types characters on
many layouts (Polish ą among them), so Varia leaves it unbound there; macOS has ⌥⌘A.

## Sampling

One monitor is one live subscription to the source `activity`, with four probes. They run on their own pool, the
connection's program name plus " - Activity Monitor", under READ UNCOMMITTED with LOCK_TIMEOUT 1000 and DEADLOCK_PRIORITY LOW,
so a probe waiting on a lock answers BLOCKED within a second and tries again. Rates are computed from SQL Server's own
clock (`ms_ticks`) in backend memory; no temp table, tempdb write or metadata function is used, and a probe whose panes
are not shown is paused (no SQL).

| Probe | Kind | Tables | Default | Lowest | At least | Budget | Refresh Now gap | Filters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `activity.overview` | metrics | — | 2 s | 1 s | 1 s | 5 s | — | — |
| `activity.sessions` | snapshot | `sessions`, `blocking`, `activeQueries` | 2 s | 1 s | 1 s | 5 s | — | In memory |
| `activity.resources` | snapshot | `waitCategories`, `waitTypes`, `files` | 5 s | 2 s | 5 s | 5 s | — | In memory |
| `activity.queries` | snapshot | `recentQueries` | 30 s | 15 s | 30 s | 10 s, MAXDOP 1 | 15 s | In memory |

The monitor has one interval: 1 s, 2 s, 3 s, 5 s, 10 s, 15 s, 30 s, 60 s (default 2 s). Each probe uses it raised
to its "At least" value; query statistics use their own setting (15 to 60 s, default 30 s), because reading the plan cache
costs more. SSMS's 5, 30 and 60 minute intervals are left out: the charts keep history. When a probe's sample costs more
than 20 % of its interval 3 times in a row, its interval doubles (up to 60 s) and the header says so; it steps back
after 10 cheap samples. Pause stops collecting (no SQL); the charts show a gap and Resume starts a new baseline.

## The live source

The live catalogue ([docs/live.md](live.md)) declares `activity.overview`, `activity.sessions`, `activity.resources`, built from this catalogue: the same tables, columns (in
the same order, with the captions as column names, so Copy with Headers and Save write them), keys, facets and series.
`activity.resources` opens unavailable: Resource Waits and Data File I/O are not sampled yet; they arrive in a later version of Varia.
`activity.queries` joins the live catalogue with Recent Expensive Queries.

Each probe runs its statements one at a time on the live connection, within one budget. A statement the login may not run
(PERMISSION_DENIED) or the server lacks (NOT_SUPPORTED) fails alone: the sample goes on, an error beside it names the tables
and series that statement feeds, and it is not run again on that connection, only reported; a new connection runs it
again, since its login may since hold the permission or it reach another server. A lock wait or any other error stops
the probe's statements: what was read arrives and the error names the rest; a probe that read nothing backs off. Each
new connection first runs the capability probe: its session id, and whether the login reads server state, may end
sessions and sees every file's name. The sessions probe sends what it found with its first sample on that connection:

| Status | Value 1 means |
| --- | --- |
| `serverState` | The login reads server state (VIEW SERVER PERFORMANCE STATE from SQL Server 2022, VIEW SERVER STATE before): without it, Processes shows only the monitor's own session and Blocking and Active Expensive Queries report PERMISSION_DENIED. |
| `canKill` | The login holds ALTER ANY CONNECTION, which Kill Process needs. |

Without server state the overview opens unavailable (PERMISSION_DENIED), or, when the capability probe could not run as
the monitor opened (it opened paused, say), stops at its first sample with that error, running nothing. The sessions
probe runs: SQL Server shows such a login only its own session, so Processes holds the monitor's session (not hidden as
Varia's then), and Blocking and Active Expensive Queries are PERMISSION_DENIED values beside each sample, read without SQL.

The live layer sorts and filters a probe's tables by column id, so ids are unique within a probe: its first table keeps
this catalogue's ids and the others take a prefix, so sorting Processes never reorders the Blocking tree.

| Table | Prefix | Key in the live layer |
| --- | --- | --- |
| `sessions` | (none) | `sessionId` |
| `blocking` | `chain` | `chainSessionId` |
| `activeQueries` | `active` | `activeSessionId`, `activeRequestId` |
| `waitCategories` | (none) | `categoryId` |
| `waitTypes` | `type` | `typeWaitType` |
| `files` | `io` | `ioDatabaseId`, `ioFileId` |
| `recentQueries` | (none) | `queryHash` |

Filters travel as the source's args: one per table (the view chip, the toggles, the filter box, column value filters, Hide
benign waits), each replacing that table's, and a table without one shows the defaults. Processes' facets count the rows
its view chip and toggles show, before the filter box and column value filters, so they never offer a value only hidden
sessions have, and a column's own value filter never empties its list. Processes arrives in Session ID order when no sort
is set; the sessions statement ranks sessions only for its cap (sessions in a blocking wait, then sessions with a request).
The two `focus.*` series follow the Details flyout's session (`focusSession`, 0 for none); the first sample after it
names another session is marked `reset`, so a chart starts them again. Every sessions sample carries the status values
`serverState` and `canKill`.

Per-session rates key a session by its login time and a request by its id and start time, so a reused id never yields a
rate across two sessions. The sessions statement returns each of a session's requests as its own row (MARS sessions run
several), ranked as Processes shows them, and its cap counts sessions. A session's own CPU and reads take in a request's
work only when the request ends, and SQL Server takes it in on a smaller scale than the request reported (a 1.2 s CPU loop
on SQL Server 2025: 813 ms against 1,096 ms), so session plus request falls at every batch end. CPU (ms/s) therefore
counts each running request by its own change, a new one whole, and the ones that ended only beyond what they had
counted: never negative, nothing counted twice, whichever request ranks first; the last moments of a request that ended
between two samples may be missed. Every baseline keeps the time it was read at on the probe's own clock (the server's
`ms_ticks` between samples that read it, else the schedule's), so a row missing from a sample (cut by a TOP, or its
statement failed) gets a rate over its own span when it returns, never two intervals divided by one.

Catalog views joined for names (`sys.databases`) do not wait on a database's `ALTER DATABASE`: under READ UNCOMMITTED
with LOCK_TIMEOUT 1000, reads of `sys.databases` and `sys.master_files` returned at once (80 to 150 ms) while SET
READ_COMMITTED_SNAPSHOT ON, SET SINGLE_USER, SET OFFLINE, MODIFY NAME and MODIFY FILE waited on a scratch database's
exclusive database lock (SQL Server 2025). A wait that does happen is a BLOCKED value for that statement, as above.

## Panes

| Pane | Id | Probe | Tables | Badge counts |
| --- | --- | --- | --- | --- |
| Processes | `processes` | `activity.sessions` | `sessions` | Rows shown |
| Blocking | `blocking` | `activity.sessions` | `blocking` | Blocked sessions |
| Resource Waits | `waits` | `activity.resources` | `waitCategories`, `waitTypes` | Rows shown |
| Data File I/O | `fileIo` | `activity.resources` | `files` | Rows shown |
| Recent Expensive Queries | `recentQueries` | `activity.queries` | `recentQueries` | Rows shown |
| Active Expensive Queries | `activeQueries` | `activity.sessions` | `activeQueries` | Rows shown |

Split view shows two panes; on first open Processes and Resource Waits. Nothing is collapsed,
and no pane needs expanding to show data.

## Tiles

Eight tiles, the first four SSMS's four charts with SSMS's names. Activating a tile expands its chart; at most 2 are
expanded, and the first two are expanded on first open.

| Tile | Value | Secondary | Tint | Parity | Expanded first |
| --- | --- | --- | --- | --- | --- |
| % Processor Time | SQL Server CPU (%, rate over the interval) | Scheduler delay | SQL Server CPU: warning ≥ 80, error ≥ 95 (`activityMonitor.cpuWarningPercent`) | Fixed | Yes |
| Waiting Tasks | Waiting tasks (tasks, rate over the interval) | — | — | Fixed | Yes |
| Database I/O | Database I/O (MB/s, rate over the interval) | Read latency, Write latency | Read latency: warning ≥ 20, error ≥ 50 (`activityMonitor.fileLatencyWarningMs`, `activityMonitor.fileLatencyErrorMs`); Write latency: warning ≥ 20, error ≥ 50 (`activityMonitor.fileLatencyWarningMs`, `activityMonitor.fileLatencyErrorMs`) | SSMS |  |
| Batch Requests/sec | Batch requests (/s, rate over the interval) | Compilations, Recompilations | — | SSMS |  |
| Blocked Sessions | Blocked sessions (count, now) | Longest block | Longest block: warning ≥ 5,000, error ≥ 30,000 while blocked sessions > 0 (`activityMonitor.blockedWarningSeconds`, `activityMonitor.blockedErrorSeconds`, in seconds) | New |  |
| Active Requests | Active requests (count, now) | User sessions, Logins | — | New |  |
| CPU Pressure | Runnable tasks (per scheduler, now) | Work queue | Runnable tasks: warning ≥ 1; Work queue: error ≥ 1 | New |  |
| Memory Grants Pending | Memory grants pending (count, now) | Page life expectancy, Deadlocks | Memory grants pending: warning ≥ 1 | New |  |

### Series

| Series | Label | Unit | Sent as | Kind | Notes |
| --- | --- | --- | --- | --- | --- |
| `cpuPercent` | SQL Server CPU | % | `percent` | cpuPercent | CPU used by SQL Server's schedulers (non-preemptive work), from sys.dm_os_schedulers; no WMI. |
| `schedulerDelay` | Scheduler delay | ms/s | `msPerSecond` | msPerSecond | Time tasks waited to be scheduled, per second. |
| `waitingTasks` | Waiting tasks | tasks | `msPerSecond` | msPerSecond | Average tasks waiting: wait time less signal wait of every type that counts as waiting (not benign: neither Varia's benign list nor Query Store's Idle category), per second, divided by 1,000. |
| `ioMegabytes` | Database I/O | MB/s | `bytesPerSecond` | rate | Bytes read and written by every database file, per second. |
| `readLatency` | Read latency | ms | `ms` | ratio | Read stall per read in the interval. |
| `writeLatency` | Write latency | ms | `ms` | ratio | Write stall per write in the interval. |
| `batchRequests` | Batch requests | /s | `perSecond` | rate | Batch Requests/sec, a cumulative counter. |
| `compilations` | Compilations | /s | `perSecond` | rate | SQL Compilations/sec. |
| `recompilations` | Recompilations | /s | `perSecond` | rate | SQL Re-Compilations/sec. |
| `blockedSessions` | Blocked sessions | count | `count` | gauge | Sessions waiting on another session now. |
| `longestBlock` | Longest block | ms | `ms` | gauge | The longest of those waits. |
| `activeRequests` | Active requests | count | `count` | gauge | User sessions with a request now (the monitor's own left out). |
| `userSessions` | User sessions | count | `count` | gauge | User sessions now (the monitor's own left out). |
| `logins` | Logins | /s | `perSecond` | rate | Logins/sec. |
| `runnablePerScheduler` | Runnable tasks | per scheduler | `count` | gauge | Tasks waiting for a CPU, per visible online scheduler. |
| `workQueue` | Work queue | count | `count` | gauge | Tasks waiting for a worker thread (THREADPOOL risk). |
| `grantsPending` | Memory grants pending | count | `count` | gauge | Queries waiting for a memory grant. |
| `grantsOutstanding` | Memory grants outstanding | count | `count` | gauge | Queries holding a memory grant. |
| `pageLifeExpectancy` | Page life expectancy | s | `seconds` | gauge | Buffer Manager's page life expectancy. |
| `deadlocks` | Deadlocks | /s | `perSecond` | rate | Number of Deadlocks/sec. |
| `lockWaits` | Lock waits | /s | `perSecond` | rate | Lock Waits/sec. |
| `focus.cpuRate` | Session CPU | ms/s | `msPerSecond` | msPerSecond | The Details flyout's session: its CPU per second. |
| `focus.logicalReadsRate` | Session logical reads | /s | `perSecond` | rate | The Details flyout's session: its logical reads per second. |
| `wait.signal` | Signal wait | ms/s | `msPerSecond` | msPerSecond | Signal wait of every type, per second (CPU pressure). |
| `wait.<category>` | Wait category | ms/s | `msPerSecond` | msPerSecond | One per wait category (24): wait time less signal wait, per second. |

Resource Waits charts the 5 largest categories, each in its own colour, and the rest as Other; benign waits (Idle) are never charted.
A rate has no value on the first sample, after Resume, after a reconnect, or when SQL Server restarted or its statistics
were cleared; charts draw a gap there.

## Tables

### Processes (`sessions`)

Probe `activity.sessions`; key `sessionId` (with `loginTime` for rates); at most 10,000 rows. Default order: Session ID ascending. Row tones: blocked (error), blocking (warning), rollback (running), departed (muted), system (muted). A selected row whose session ended stays one more sample, toned departed.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Session ID | `sessionId` | int | id | Yes | SSMS | session_id; one row per session. Of its MARS requests a blocked one, else the lowest, fills the request columns, and CPU and reads add them all. |
| Status | `status` | text | — | Yes | Fixed | The request's status, else the session's; "rolling back 42 %" during KILLED/ROLLBACK and "sleeping · 1 open tran" for an idle session with an open transaction. SSMS's Task State shows neither. |
| Login | `login` | text | — | Yes | SSMS | login_name. |
| Database | `database` | text | — | Yes | SSMS | The request's database, else the session's. |
| Command | `command` | text | — | Yes | SSMS | The request's command. |
| Application | `application` | text | — | Yes | SSMS | program_name. |
| Wait Type | `waitType` | text | — | Yes | SSMS | The request's wait type; for a parallel request, the longest blocking wait of its tasks. |
| Wait Time (ms) | `waitTimeMs` | bigint | ms | Yes | SSMS | The request's current wait. |
| Wait Resource | `waitResource` | text | — | Yes | SSMS | wait_resource, else the blocking task's resource description (512 characters). |
| Blocked By | `blockedBy` | int | id | Yes | Fixed | The session it waits on (its longest blocking wait); negative ids show their meaning. SSMS lists a session once per session it blocks. |
| Head Blocker | `headBlocker` | bool | — | Yes | Fixed | Blocks another session and waits on none. SSMS marks it on each duplicate row. |
| Blocking | `blocking` | int | count | Yes | New | Sessions downstream of it in its blocking chain. |
| CPU (ms/s) | `cpuRate` | decimal | ms/s | Yes | New | CPU per second over the interval: a running request's own CPU while it runs, one that started since the last sample whole, and for one that ended only what the session took in beyond what the request had counted (SQL Server takes it in on a smaller scale), so it is never negative and nothing counts twice. |
| Total CPU (ms) | `totalCpuMs` | bigint | ms | Yes | SSMS | The session's CPU since login. |
| Physical I/O (MB) | `physicalIoMb` | decimal | MB | Yes | SSMS | Pages read and written since login, in MB (cumulative). |
| Logical Reads/s | `logicalReadsRate` | decimal | /s | Yes | New | Logical reads per second over the interval, counted as CPU (ms/s) is. |
| Memory Use (KB) | `memoryKb` | bigint | KB | Yes | SSMS | memory_usage pages, in KB. |
| Open Transactions | `openTransactions` | int | count | Yes | Fixed | The session's open transactions. SSMS reads the request's count, so an idle session holding a transaction shows 0. |
| Elapsed (s) | `elapsedSeconds` | decimal | s | Yes | New | How long the current request has run. |
| Host Name | `hostName` | text | — | Yes | SSMS | host_name. |
| Net Address | `netAddress` | text | — |  | SSMS | client_net_address. |
| Login Time | `loginTime` | datetime | — |  | SSMS | login_time; with the session id it identifies the session. |
| Last Request Start Time | `lastRequestStart` | datetime | — |  | SSMS | last_request_start_time. |
| Request ID | `requestId` | text | — |  | SSMS | The lowest request id, with "+n" for more MARS requests. |
| DOP | `dop` | int | count |  | New | The request's degree of parallelism; replaces SSMS's one row per task (Execution Context ID). |
| Workload Group | `workloadGroup` | text | — |  | SSMS | The Resource Governor workload group. |
| Original Login | `originalLogin` | text | — |  | New | original_login_name. |
| Interface | `interface` | text | — |  | New | client_interface_name. |
| Isolation Level | `isolationLevel` | text | — |  | New | The session's transaction isolation level. |
| Encrypted | `encrypted` | bool | — |  | New | The connection is encrypted. |
| Auth Scheme | `authScheme` | text | — |  | New | SQL, NTLM or KERBEROS. |
| Host PID | `hostProcessId` | int | id |  | New | host_process_id. |
| Query Hash | `queryHash` | text | — |  | New | The current request's query_hash. |
| Varia | `varia` | text | — |  | New | What a Varia session is: this window's query tab, or one of its pools. |

### Blocking (`blocking`)

Probe `activity.sessions`; key `sessionId`; at most 2,000 rows. Order: lead blockers by sessions downstream, then longest wait, each followed by the sessions it blocks. Row tones: blocked (error), blocking (warning), departed (muted). A selected row whose session ended stays one more sample, toned departed.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Session | `session` | text | — | Yes | New | The session id indented by its depth in the chain; lead blockers at depth 0. |
| Session ID | `sessionId` | int | id |  | New | session_id. |
| Depth | `depth` | int | count |  | New | Depth in the chain (0 for a lead blocker). |
| Status | `status` | text | — | Yes | New | As in Processes. |
| Blocked Sessions | `blockedSessions` | int | count | Yes | New | Sessions downstream of it. |
| Wait Type | `waitType` | text | — | Yes | New | The wait on its parent in the chain. |
| Wait (ms) | `waitTimeMs` | bigint | ms | Yes | New | How long it has waited on its parent. |
| Wait Resource | `waitResource` | text | — | Yes | New | What it waits for. |
| Login | `login` | text | — | Yes | New | login_name. |
| Host | `hostName` | text | — | Yes | New | host_name. |
| Application | `application` | text | — | Yes | New | program_name. |
| Database | `database` | text | — | Yes | New | The request's database, else the session's. |
| Open Transactions | `openTransactions` | int | count | Yes | New | The session's open transactions. |
| Cycle | `cycle` | bool | — | Yes | New | Part of a cycle (a deadlock SQL Server has not resolved yet); the chain is cut at its lowest session id. |
| Last Batch | `lastBatch` | text | — | Yes | New | Lead blockers only: the start of the last batch it sent (sys.dm_exec_input_buffer). |

### Active Expensive Queries (`activeQueries`)

Probe `activity.sessions`; key `sessionId`, `requestId` (with `startTime` for rates); at most 100 rows. Default order: CPU (ms) descending. Row tones: blocked (error), rollback (running), departed (muted). A selected row whose session ended stays one more sample, toned departed.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Query | `query` | text | — | Yes | SSMS | The running statement, one line, 4,000 characters. |
| Session ID | `sessionId` | int | id | Yes | SSMS | session_id. |
| Request ID | `requestId` | int | id |  | New | request_id. |
| Start Time | `startTime` | datetime | — |  | New | When the request started; with the ids it identifies the request. |
| Status | `status` | text | — | Yes | SSMS | The request's status. |
| Database | `database` | text | — | Yes | SSMS | The request's database. |
| CPU (ms) | `cpuMs` | bigint | ms | Yes | Fixed | The request's CPU so far. SSMS captions this total "CPU (ms/sec)". |
| CPU (ms/s) | `cpuRate` | decimal | ms/s | Yes | New | CPU per second over the interval. |
| Elapsed (ms) | `elapsedMs` | bigint | ms | Yes | SSMS | total_elapsed_time. |
| Physical Reads | `physicalReads` | bigint | count | Yes | Fixed | Reads so far. SSMS captions this total "Physical Reads/sec". |
| Logical Reads | `logicalReads` | bigint | count | Yes | Fixed | Logical reads so far. SSMS captions this total "Logical Reads/sec". |
| Writes | `writes` | bigint | count | Yes | Fixed | Writes so far. SSMS captions this total "Logical Writes/sec". |
| Row Count | `rowCount` | bigint | count | Yes | SSMS | Rows returned so far. |
| DOP | `dop` | int | count | Yes | New | Degree of parallelism. |
| Requested Memory (KB) | `requestedMemoryKb` | bigint | KB |  | New | The memory grant requested. |
| Granted Memory (KB) | `grantedMemoryKb` | bigint | KB | Yes | SSMS | The memory grant (SSMS: Allocated Memory). |
| Required Memory (KB) | `requiredMemoryKb` | bigint | KB | Yes | SSMS | The minimum grant the query needs. |
| Used Memory (KB) | `usedMemoryKb` | bigint | KB | Yes | SSMS | Grant memory in use now. |
| Max Used Memory (KB) | `maxUsedMemoryKb` | bigint | KB |  | New | The most grant memory used so far. |
| Grant Wait (ms) | `grantWaitMs` | bigint | ms | Yes | New | How long it waited for its grant (RESOURCE_SEMAPHORE). |
| Wait Type | `waitType` | text | — | Yes | New | The request's wait type. |
| Blocked By | `blockedBy` | int | id | Yes | New | The session it waits on. |
| % Complete | `percentComplete` | decimal | % |  | New | For commands that report progress (BACKUP, RESTORE, DBCC, rollback). |
| Query Hash | `queryHash` | text | — |  | New | query_hash. |

### Wait categories (`waitCategories`)

Probe `activity.resources`; key `categoryId`; at most 24 rows. Default order: Wait Time (ms/sec) descending.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Category ID | `categoryId` | text | — |  | New | The category's id in this catalogue. |
| Wait Category | `category` | text | — | Yes | Fixed | Query Store's documented categories plus Varia's benign list, so every wait type counts. SSMS's 2008 table knows 241 of SQL Server 2025's 1,546 types and drops the rest. |
| Wait Time (ms/sec) | `waitRate` | decimal | ms/s | Yes | SSMS | Wait time less signal wait, per second over the interval. |
| Signal Wait (ms/sec) | `signalRate` | decimal | ms/s | Yes | New | Time runnable tasks waited for a CPU, per second (SSMS computes it but does not show it). |
| 1-Minute Average (ms/sec) | `minuteAverage` | decimal | ms/s | Yes | Fixed | The mean of the last 60 s. SSMS's Recent Wait Time is a weighted average over an unstated window. |
| Average Waiter Count | `averageWaiters` | decimal | count | Yes | SSMS | Wait time per second divided by 1,000. |
| Current Waiters | `currentWaiters` | int | count | Yes | New | Tasks waiting in the category now. |
| Cumulative Wait Time (sec) | `cumulativeSeconds` | decimal | s | Yes | SSMS | Since SQL Server started or the statistics were cleared. |
| Top Wait Type | `topWaitType` | text | — | Yes | New | The category's largest wait type in the interval. |

### Wait types (`waitTypes`)

Probe `activity.resources`; key `waitType`; at most 2,000 rows. Default order: Wait Time (ms/sec) descending.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Wait Type | `waitType` | text | — | Yes | New | Types with time in the interval or a task waiting now. |
| Category | `category` | text | — | Yes | New | Its wait category. |
| Wait Time (ms/sec) | `waitRate` | decimal | ms/s | Yes | New | Wait time less signal wait, per second. |
| Signal (ms/sec) | `signalRate` | decimal | ms/s | Yes | New | Signal wait per second. |
| Waits/sec | `waitsRate` | decimal | /s | Yes | New | Waits that ended per second. |
| Average Wait (ms) | `averageWaitMs` | decimal | ms | Yes | New | Wait time per wait in the interval. |
| Max Wait (ms) | `maxWaitMs` | bigint | ms | Yes | New | The longest wait since SQL Server started. |
| Current Waiters | `currentWaiters` | int | count | Yes | New | Tasks waiting on it now. |
| Cumulative (sec) | `cumulativeSeconds` | decimal | s | Yes | New | Since SQL Server started or the statistics were cleared. |
| Benign | `benign` | bool | — | Yes | New | A wait for work: on Varia's benign list or in Query Store's Idle category. It never counts in Waiting Tasks, and Hide benign waits hides it. |

### Data File I/O (`files`)

Probe `activity.resources`; key `databaseId`, `fileId`; at most 10,000 rows. Default order: MB/sec Total descending. Row tones: latencyWarning (warning), latencyError (error).

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Database ID | `databaseId` | int | id |  | New | database_id. |
| File ID | `fileId` | int | id |  | New | file_id. |
| Database | `database` | text | — | Yes | SSMS | The database's name, else "database 7" (names need VIEW ANY DEFINITION). |
| File | `file` | text | — | Yes | New | The logical file name, else "file 2". |
| Type | `type` | text | — | Yes | New | Rows, Log, FILESTREAM or Full-text. |
| File Name | `fileName` | text | — | Yes | SSMS | physical_name. |
| MB/sec Read | `readMbRate` | decimal | MB/s | Yes | SSMS | Bytes read per second, in MB. |
| MB/sec Written | `writeMbRate` | decimal | MB/s | Yes | SSMS | Bytes written per second, in MB. |
| MB/sec Total | `totalMbRate` | decimal | MB/s |  | New | Read and written per second, in MB: the default order. |
| Reads/sec | `readsRate` | decimal | /s | Yes | New | Reads per second. |
| Writes/sec | `writesRate` | decimal | /s | Yes | New | Writes per second. |
| Read Latency (ms) | `readLatencyMs` | decimal | ms | Yes | New | Read stall per read in the interval (blank with no reads). |
| Write Latency (ms) | `writeLatencyMs` | decimal | ms | Yes | New | Write stall per write in the interval (blank with no writes). |
| Response Time (ms) | `responseTimeMs` | decimal | ms | Yes | Fixed | Stall per I/O, reads and writes together, in the interval (SSMS parity); the latency columns keep them apart. |
| Throttled (ms/s) | `throttledRate` | decimal | ms/s |  | New | Resource Governor I/O queueing per second. |
| Size (MB) | `sizeMb` | decimal | MB | Yes | New | size_on_disk_bytes, in MB. |

### Recent Expensive Queries (`recentQueries`)

Probe `activity.queries`; key `queryHash`; at most 200 rows. Default order: CPU (ms/sec) descending.

| Column | Id | Type | Unit | Shown | Parity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Query | `query` | text | — | Yes | SSMS | A statement of the group (its most recent execution), 4,000 characters. |
| Executions/min | `executionsPerMinute` | decimal | /min | Yes | SSMS | Executions per minute over the sample window. |
| CPU (ms/sec) | `cpuRate` | decimal | ms/s | Yes | SSMS | Worker time per second over the sample window. |
| Avg CPU (ms) | `avgCpuMs` | decimal | ms | Yes | New | Worker time per execution. |
| Physical Reads/sec | `physicalReadsRate` | decimal | /s | Yes | SSMS | Per second over the sample window. |
| Logical Reads/sec | `logicalReadsRate` | decimal | /s | Yes | SSMS | Per second over the sample window. |
| Logical Writes/sec | `logicalWritesRate` | decimal | /s | Yes | SSMS | Per second over the sample window. |
| Average Duration (ms) | `averageDurationMs` | decimal | ms | Yes | SSMS | Elapsed time per execution in the sample window. |
| Max Duration (ms) | `maxDurationMs` | decimal | ms | Yes | New | The longest execution since the plan was cached. |
| Rows/Execution | `rowsPerExecution` | decimal | count | Yes | New | Rows per execution. |
| Avg Grant (KB) | `avgGrantKb` | decimal | KB |  | New | Memory grant per execution. |
| Spills | `spills` | bigint | count |  | New | Pages spilled in the window. Needs `totalSpills`. |
| Plan Count | `planCount` | int | count | Yes | SSMS | Distinct plans (query_plan_hash) in the group. |
| Database | `database` | text | — | Yes | SSMS | The plan's database. |
| Last Execution | `lastExecution` | datetime | — | Yes | New | The group's latest execution (server time). |
| Cached Since | `cachedSince` | datetime | — |  | New | The oldest plan's creation time. |
| Query Hash | `queryHash` | text | — |  | New | query_hash, which groups the statements. |

## Filters

Filters run in the backend over the sample; the SQL never changes.

| View | Id | Shows |
| --- | --- | --- |
| All | `all` | Every session the toggles allow. |
| Active | `active` | Sessions with a request. |
| Blocked | `blocked` | Sessions waiting on another session (a wait on a negative id, such as a latch owner, is not one). |
| Blocking | `blocking` | Sessions another session waits on. |
| Idle with open transaction | `idleOpenTransaction` | Sessions with no request and an open transaction: the classic forgotten transaction. |
| Rolling back | `rollingBack` | Sessions rolling back after KILL. |

Toggles: System sessions (`activityMonitor.showSystemSessions`, off by default), Varia's own (`activityMonitor.showVariaSessions`, off by default). The filter box matches
case-insensitively against Login, Database, Application, Host Name, Command, Wait Type, Status.
Column value filters (Alt+Down on a header) offer (All), (Blanks), (Non-blanks) and each value with its count for Login, Database, Application, Host Name, Wait Type, Command, Status.
Several values in one column match any of them; filters on several columns must all match.
Resource Waits has Hide benign waits (on by default), which leaves out benign wait types and the Idle category.

Recent Expensive Queries ranks by CPU, Duration, Logical Reads, Physical Reads, Writes, Executions, re-sorted from the last sample without new SQL.

## Blocking

The chain is built from `sys.dm_os_waiting_tasks` (task-level waits, a parallel query's waits on itself left out), plus a
request's `blocking_session_id` where no task wait names it. Each session appears once: SSMS lists a blocker once per
session it blocks. A session waiting on several sessions hangs under the one it has waited on longest. A lead blocker
blocks someone and waits on no one; an idle session holding a transaction is a lead blocker too, with its open
transactions from `sys.dm_exec_sessions` (SSMS shows 0). A cycle (a deadlock SQL Server has not resolved yet) is cut at its
lowest session id, and its sessions are marked. Chains deeper than 32 or longer than 2,000 rows are cut and marked truncated.

A wait on a negative id (below) is not a wait on a session: Processes shows its meaning in Blocked By, but the session
is not counted as blocked (the Blocked Sessions tile and the Blocking badge count waits on sessions only), is a Blocking
row only when it blocks someone, and a lead blocker waiting on a latch stays the head of its chain.

| Blocking session id | Shown as |
| --- | --- |
| -2 | Orphaned DTC |
| -3 | Deferred recovery |
| -4 | Latch owner unknown |
| -5 | Latch owner not tracked |

## Wait categories

Query Store's documented categories ([sys.query_store_wait_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql)),
matched in this order: Varia's benign list (counted in Idle), Query Store's exceptions and exact names, then prefixes in
the table's order. Anything else is Unknown, which is shown, never dropped: SSMS's 2008 table knows 241 of SQL Server
2025's 1,546 wait types and drops the rest. THREADPOOL (Worker Thread), CXPACKET and CXCONSUMER (Parallelism) and
SOS_SCHEDULER_YIELD (CPU) are shown. The numbers therefore differ from SSMS's Resource Waits.

A wait type is benign when it is on Varia's benign list or in the Idle category: a thread waiting for work. Benign
waits never count in Waiting Tasks and are never charted, and Hide benign waits hides them; every other type counts,
Unknown ones too.

| Value | Category | Id | Wait types |
| --- | --- | --- | --- |
| 0 | Unknown | `unknown` | (anything not matched) |
| 1 | CPU | `cpu` | `SOS_SCHEDULER_YIELD` |
| 2 | Worker Thread | `workerThread` | `THREADPOOL` |
| 3 | Lock | `lock` | `LCK_M_%` |
| 4 | Latch | `latch` | `LATCH_%` |
| 5 | Buffer Latch | `bufferLatch` | `PAGELATCH_%` |
| 6 | Buffer IO | `bufferIo` | `PAGEIOLATCH_%` |
| 7 | Compilation | `compilation` | `RESOURCE_SEMAPHORE_QUERY_COMPILE` |
| 8 | SQL CLR | `sqlClr` | `CLR%`, `SQLCLR%` |
| 9 | Mirroring | `mirroring` | `DBMIRROR%` |
| 10 | Transaction | `transaction` | `TRANSACTION_MUTEX`, `XACT%`, `DTC%`, `TRAN_MARKLATCH_%`, `MSQL_XACT_%` |
| 11 | Idle | `idle` | `LAZYWRITER_SLEEP`, `SQLTRACE_BUFFER_FLUSH`, `SQLTRACE_INCREMENTAL_FLUSH_SLEEP`, `SQLTRACE_WAIT_ENTRIES`, `FT_IFTS_SCHEDULER_IDLE_WAIT`, `XE_DISPATCHER_WAIT`, `REQUEST_FOR_DEADLOCK_SEARCH`, `LOGMGR_QUEUE`, `ONDEMAND_TASK_QUEUE`, `CHECKPOINT_QUEUE`, `XE_TIMER_EVENT`, `SLEEP_%` |
| 12 | Preemptive | `preemptive` | `PREEMPTIVE_%` |
| 13 | Service Broker | `serviceBroker` | `BROKER_%` |
| 14 | Tran Log IO | `tranLogIo` | `LOGMGR`, `LOGBUFFER`, `LOGMGR_RESERVE_APPEND`, `LOGMGR_FLUSH`, `LOGMGR_PMM_LOG`, `CHKPT`, `WRITELOG` |
| 15 | Network IO | `networkIo` | `ASYNC_NETWORK_IO`, `NET_WAITFOR_PACKET`, `PROXY_NETWORK_IO`, `EXTERNAL_SCRIPT_NETWORK_IO` |
| 16 | Parallelism | `parallelism` | `CXCONSUMER`, `CXPACKET`, `CXSYNC_CONSUMER`, `CXSYNC_PORT`, `EXCHANGE`, `HT%`, `BMP%`, `BP%` |
| 17 | Memory | `memory` | `RESOURCE_SEMAPHORE`, `CMEMTHREAD`, `CMEMPARTITIONED`, `EE_PMOLOCK`, `MEMORY_ALLOCATION_EXT`, `RESERVED_MEMORY_ALLOCATION_EXT`, `MEMORY_GRANT_UPDATE` |
| 18 | User Wait | `userWait` | `WAITFOR`, `WAIT_FOR_RESULTS`, `BROKER_RECEIVE_WAITFOR` |
| 19 | Tracing | `tracing` | `TRACEWRITE`, `SQLTRACE_LOCK`, `SQLTRACE_FILE_BUFFER`, `SQLTRACE_FILE_WRITE_IO_COMPLETION`, `SQLTRACE_FILE_READ_IO_COMPLETION`, `SQLTRACE_PENDING_BUFFER_WRITERS`, `SQLTRACE_SHUTDOWN`, `QUERY_TRACEOUT`, `TRACE_EVTNOTIFF` |
| 20 | Full Text Search | `fullTextSearch` | `FT_RESTART_CRAWL`, `FULLTEXT GATHERER`, `MSSEARCH`, `FT_METADATA_MUTEX`, `FT_IFTSHC_MUTEX`, `FT_IFTSISM_MUTEX`, `FT_IFTS_RWLOCK`, `FT_COMPROWSET_RWLOCK`, `FT_MASTER_MERGE`, `FT_PROPERTYLIST_CACHE`, `FT_MASTER_MERGE_COORDINATOR`, `PWAIT_RESOURCE_SEMAPHORE_FT_PARALLEL_QUERY_SYNC` |
| 21 | Other Disk IO | `otherDiskIo` | `ASYNC_IO_COMPLETION`, `IO_COMPLETION`, `BACKUPIO`, `WRITE_COMPLETION`, `IO_QUEUE_LIMIT`, `IO_RETRY` |
| 22 | Replication | `replication` | `REPLICA_WRITES`, `FCB_REPLICA_WRITE`, `FCB_REPLICA_READ`, `PWAIT_HADRSIM`, `SE_REPL_%`, `REPL_%`, `HADR_%`, `PWAIT_HADR_%` |
| 23 | Log Rate Governor | `logRateGovernor` | `LOG_RATE_GOVERNOR`, `POOL_LOG_RATE_GOVERNOR`, `HADR_THROTTLE_LOG_RATE_GOVERNOR`, `INSTANCE_LOG_RATE_GOVERNOR`, `RBIO_RG_%` |

Exceptions:

| Wait type | Category | Why |
| --- | --- | --- |
| `BROKER_RECEIVE_WAITFOR` | User Wait | Not Service Broker: a RECEIVE waiting for messages. |
| `HADR_THROTTLE_LOG_RATE_GOVERNOR` | Log Rate Governor | Not Replication: log rate governance. |

Varia's benign list:

| Wait type | Why it is benign |
| --- | --- |
| `AZURE_IMDS_VERSIONS` | SQL Server 2022 and later asking the Azure instance metadata service at startup. |
| `BROKER_EVENTHANDLER` | Service Broker's event handler waiting for work. |
| `BROKER_TASK_STOP` | An idle Service Broker task waiting to stop. |
| `BROKER_TO_FLUSH` | Service Broker's lazy flush of transmission objects. |
| `BROKER_TRANSMITTER` | Service Broker's transmitter waiting for messages to send. |
| `CLR_AUTO_EVENT` | A CLR background task waiting on an event. |
| `CLR_MANUAL_EVENT` | A CLR background task waiting on an event. |
| `CLR_SEMAPHORE` | A CLR background task waiting for work. |
| `DBMIRRORING_CMD` | Mirroring waiting for log records to flush. |
| `DBMIRROR_DBM_EVENT` | Database mirroring waiting for an event. |
| `DBMIRROR_EVENTS_QUEUE` | Database mirroring waiting for events to process. |
| `DBMIRROR_WORKER_QUEUE` | A mirroring worker waiting for work. |
| `DIRTY_PAGE_POLL` | The recovery writer polling for dirty pages. |
| `DISPATCHER_QUEUE_SEMAPHORE` | A dispatcher pool thread waiting for work. |
| `FSAGENT` | The FILESTREAM file I/O agent waiting for work. |
| `HADR_CLUSAPI_CALL` | An availability group thread waiting on the cluster API. |
| `HADR_FILESTREAM_IOMGR_IOCOMPLETION` | The FILESTREAM I/O manager waiting for I/O completions. |
| `HADR_LOGCAPTURE_WAIT` | Availability group log capture waiting for log to send. |
| `HADR_NOTIFICATION_DEQUEUE` | An availability group task waiting for notifications. |
| `HADR_TIMER_TASK` | An availability group timer task. |
| `HADR_WORK_QUEUE` | An availability group worker waiting for work. |
| `KSOURCE_WAKEUP` | The service control task waiting for requests. |
| `PARALLEL_REDO_DRAIN_WORKER` | Parallel redo waiting on a secondary replica. |
| `PARALLEL_REDO_LOG_CACHE` | Parallel redo waiting on a secondary replica. |
| `PARALLEL_REDO_TRAN_LIST` | Parallel redo waiting on a secondary replica. |
| `PARALLEL_REDO_WORKER_SYNC` | Parallel redo waiting on a secondary replica. |
| `PARALLEL_REDO_WORKER_WAIT_WORK` | A parallel redo worker waiting for log to redo. |
| `PREEMPTIVE_XE_GETTARGETSTATE` | Extended Events reading a target's state. |
| `PWAIT_ALL_COMPONENTS_INITIALIZED` | Startup waiting for its components. |
| `PWAIT_DIRECTLOGCONSUMER_GETNEXT` | A log consumer waiting for log records. |
| `PWAIT_EXTENSIBILITY_CLEANUP_TASK` | The external scripts cleanup task. |
| `QDS_ASYNC_QUEUE` | Query Store's background queue waiting for work. |
| `QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP` | Query Store's cleanup task sleeping. |
| `QDS_PERSIST_TASK_MAIN_LOOP_SLEEP` | Query Store's flush task sleeping. |
| `QDS_SHUTDOWN_QUEUE` | Query Store's shutdown queue. |
| `REDO_THREAD_PENDING_WORK` | A redo thread waiting for log to redo. |
| `SERVER_IDLE_CHECK` | The idle server check. |
| `SOS_WORK_DISPATCHER` | A dispatcher pool thread waiting for work; the largest wait on an idle SQL Server 2019 or later. |
| `SP_SERVER_DIAGNOSTICS_SLEEP` | sp_server_diagnostics sleeping between reports. |
| `UCS_SESSION_REGISTRATION` | A unified communication stack session waiting to register. |
| `VDI_CLIENT_OTHER` | A virtual device interface thread waiting for work (seeding). |
| `WAIT_XTP_CKPT_CLOSE` | In-Memory OLTP waiting for a checkpoint to close. |
| `WAIT_XTP_HOST_WAIT` | An In-Memory OLTP background task waiting. |
| `WAIT_XTP_OFFLINE_CKPT_NEW_LOG` | The In-Memory OLTP offline checkpoint waiting for new log. |
| `WAIT_XTP_RECOVERY` | In-Memory OLTP recovery of a database. |
| `XE_DISPATCHER_JOIN` | An Extended Events dispatcher thread waiting. |
| `XE_LIVE_TARGET_TVF` | An Extended Events live target waiting for events. |

## Varia's own sessions

A session whose host process is the backend, whose host name is the workstation its connections send (the Workstation ID,
else this machine's name) and whose program name is a connection's Application Name plus one of these suffixes may be
Varia's: a client sets all three at login, so a pool session must also be one whose session id Varia's own pooled or
Object Actions connection to that server was given when it opened, and that it may still hold: an Object Actions
session's until its connection closes, a pool session's while a connection holds it and for 10 minutes after the last
closes, past the 4 to 8 minutes SqlClient keeps an idle pooled connection (SQL Server gives a freed id to the next
client). A session that only claims them, under any other id, shows as itself. The ledger can be wrong for a while:
SqlClient's idle connection resiliency, which the Object Explorer and Scripting pools keep, can give a held connection a
new session id without opening it again, so that session shows as itself and its old id, which SQL Server may give to
another client, still counts. That only labels; ending a session (`VariaSessions.Protected`, for Kill) refuses every
session that may be Varia's: the monitor's, one whose id the ledger names, and one that claims a pool's process,
machine and program name under any id.
Pool sessions show only with Varia's own on. "Query tab" marks a plain-name session of this process, never hidden: a
query tab, which the document names by the tab that holds its session id, or a pooled connection of the Connect
dialog's database list or a column list, which no tab holds and which shows as "Query tab".

| Suffix | Kind | Label |
| --- | --- | --- |
| (none) | Query tab | Query tab |
| " - Object Explorer" | Pool | Varia Object Explorer |
| " - Scripting" | Pool | Varia Scripting |
| " - Object Actions" | Pool | Varia Object Actions |
| " - Activity Monitor" | Pool | Varia Activity Monitor |
| " - Integration Services" | Pool | Varia Integration Services |
| " - Integration Services Actions" | Pool | Varia Integration Services Actions |

## Servers and permissions

| Server | EngineEdition | Available |
| --- | --- | --- |
| SQL Server (Windows, Linux and containers) | 1, 2, 3, 4 | Yes |
| Azure SQL Managed Instance | 8 | Yes |
| Azure SQL Database | 5 | Later |

Its SQL is written for SQL Server 2016 (band 13) to SQL Server 2025 (band 17); Managed Instance uses the
catalog it has, not the version it reports. Any other server opens the document with "Activity Monitor isn't available for this kind of server."

Showing other sessions and server activity needs VIEW SERVER STATE (SQL Server 2019 and earlier, Managed Instance) or
VIEW SERVER PERFORMANCE STATE (SQL Server 2022 and later), named by the version the server reports, as the capability
probe checks it; a Managed Instance is asked for VIEW SERVER STATE even where it has the newer permission. Without it
the monitor still opens, shows the login's own
session, and offers the GRANT statement to copy (never runs it). File names need VIEW ANY DEFINITION; without it Data
File I/O shows ids. Kill Process needs ALTER ANY CONNECTION (sysadmin or processadmin), and server state to see the
session it checks (below).

## Session actions

Details and Kill Process act on a row of Processes, Blocking or Active Expensive Queries. Both name the session by its id
and its login time (`2026-10-22T06:50:12.347`: server local time, as `sys.dm_exec_sessions` has it, within `datetime`'s
range), because SQL Server reuses session ids.

**Details** (`activity.details`) reads the session on the monitor's pool (" - Activity Monitor", READ UNCOMMITTED,
LOCK_TIMEOUT 1000) under the live gates, within 10 s in all: a lock wait answers BLOCKED and the budget TIMEOUT, as
values; when the live views hold every gate for the whole budget it answers BUSY. It checks visibility and identity in `sys.dm_exec_sessions` alone before joining other DMVs. When no session has the id it answers `ended` (also when the login cannot see other
sessions), and when another session has it (its login time differs) `changed`, reading nothing more. The richer session read checks the identity again, and every later section reads only while the id still has that login time, so an id reused meanwhile reads nothing rather than another session's rows. Every other section
is a statement of its own, so a permission or a lock that stops one leaves the rest. The flyout shows each text's first
65,536 characters; asked for one text by name (`statement`, `batch`, `inputBuffer`), Details returns only that
text, whole up to 1,000,000 characters, for Open in Query Editor. Closing the flyout cancels the read (an attention
ends it in SQL Server).

| Section | Id | Reads |
| --- | --- | --- |
| Identity and Now | `session` | sys.dm_exec_sessions with sys.dm_exec_connections and its requests (a blocked one, else the lowest, gives the request columns; CPU and reads add them all) |
| Current statement | `statement` | sys.dm_exec_sql_text of that request, cut at its statement offsets |
| Batch | `batch` | sys.dm_exec_sql_text of that request, whole |
| Last batch | `inputBuffer` | sys.dm_exec_input_buffer: the event type, its parameter count and its text |
| Session waits | `waits` | sys.dm_exec_session_wait_stats, the 20 largest by wait time |
| Transactions | `transactions` | sys.dm_tran_session_transactions with sys.dm_tran_active_transactions and sys.dm_tran_database_transactions, one row per transaction and database |
| tempdb usage | `tempdb` | sys.dm_db_session_space_usage and sys.dm_db_task_space_usage: pages its objects and its work hold now |
| Locks | `locks` | sys.dm_tran_locks grouped by resource type, database, mode and status; only when asked (Load locks), as it is costly |

**Kill Process** (`activity.kill`, up to 64 sessions) runs on the object actions' own connection, so `sp_who2` shows the
kill as a session of the connection's program name plus " - Object Actions": unpooled, never retried, with LOCK_TIMEOUT
10000. For each session in order, one batch checks that the id is not its own session's, that the session exists, is a
user session, still has the login time and host process id the row showed, and is not one of this window's pool
sessions (those of every connection in the window, whatever Application Name each set); only then does it run KILL,
built on the server from the session id (an int parameter), never from text. One Kill runs at a time per connection and
two in the window; another waits up to 5 seconds, then answers BUSY. A request has 25 s in all; sessions not tried by then
are left alone and the answer says so. Rollback progress needs
no polling: Processes shows "rolling back n %" from the session's own request. Kill's checks need server state to see
the session too: without it every other session answers `ended`, and nothing is killed.

| Outcome | Meaning |
| --- | --- |
| `killed` | SQL Server accepted KILL. An open transaction rolls back, which can take as long as the work it undoes; Processes shows its progress. |
| `ended` | No session has that id any more. Nothing was killed. |
| `changed` | The id now belongs to another session (its login time or host process id differs). Nothing was killed. |
| `own` | The session Kill itself runs on. Nothing was killed. |
| `system` | A SQL Server system session: only user sessions can be killed. Nothing was killed. |
| `varia` | One of this window's own pool sessions (Object Explorer, Scripting, Object Actions, Activity Monitor or Integration Services). Nothing was killed. |
| `denied` | The login lacks ALTER ANY CONNECTION (sysadmin or processadmin). Nothing was killed. |
| `failed` | Another error, which the message gives; when the connection broke during KILL, whether the session ended is unknown. |

## Differences from SSMS

- A failing query never pauses the monitor; each probe fails alone and says why.
- CPU comes from SQL Server's schedulers, on every platform, never from WMI or performance counters of the host.
- Wait categories are Query Store's, so CPU, worker thread, parallelism and modern wait types are counted (above).
- Pause means stop collecting; the monitor never polls while its window is hidden.
- Copy keys are the results grid's (Ctrl+C the selection, Ctrl+Shift+C with headers; ⌘C and ⇧⌘C on macOS), not SSMS's copy-a-cell.

| Pane | Column | Varia |
| --- | --- | --- |
| Processes | Status | The request's status, else the session's; "rolling back 42 %" during KILLED/ROLLBACK and "sleeping · 1 open tran" for an idle session with an open transaction. SSMS's Task State shows neither. |
| Processes | Blocked By | The session it waits on (its longest blocking wait); negative ids show their meaning. SSMS lists a session once per session it blocks. |
| Processes | Head Blocker | Blocks another session and waits on none. SSMS marks it on each duplicate row. |
| Processes | Open Transactions | The session's open transactions. SSMS reads the request's count, so an idle session holding a transaction shows 0. |
| Active Expensive Queries | CPU (ms) | The request's CPU so far. SSMS captions this total "CPU (ms/sec)". |
| Active Expensive Queries | Physical Reads | Reads so far. SSMS captions this total "Physical Reads/sec". |
| Active Expensive Queries | Logical Reads | Logical reads so far. SSMS captions this total "Logical Reads/sec". |
| Active Expensive Queries | Writes | Writes so far. SSMS captions this total "Logical Writes/sec". |
| Wait categories | Wait Category | Query Store's documented categories plus Varia's benign list, so every wait type counts. SSMS's 2008 table knows 241 of SQL Server 2025's 1,546 types and drops the rest. |
| Wait categories | 1-Minute Average (ms/sec) | The mean of the last 60 s. SSMS's Recent Wait Time is a weighted average over an unstated window. |
| Data File I/O | Response Time (ms) | Stall per I/O, reads and writes together, in the interval (SSMS parity); the latency columns keep them apart. |
| Tiles | % Processor Time | CPU used by SQL Server's schedulers (non-preemptive work), from sys.dm_os_schedulers; no WMI. |
| Tiles | Waiting Tasks | Average tasks waiting: wait time less signal wait of every type that counts as waiting (not benign: neither Varia's benign list nor Query Store's Idle category), per second, divided by 1,000. |

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `monitorsPerConnection` | 1 | Activity Monitors per connection; opening another activates it |
| `probesPerMonitor` | 4 | Probes of the monitor's one subscription |
| `sessions` | 10,000 | Processes rows; more set `truncated` and drop idle sessions first (sessions in a blocking wait come first, then those with a request) |
| `blockingEdges` | 20,000 | Blocking waits read per sample |
| `blockingRows` | 2,000 | Blocking rows |
| `blockingDepth` | 32 | Depth of a blocking chain the Blocking pane shows |
| `activeQueries` | 100 | Active Expensive Queries rows |
| `waitTypes` | 2,000 | Wait types rows |
| `files` | 10,000 | Data File I/O rows |
| `queryStatsRows` | 20,000 | Query statistics rows read per sample |
| `queryDeltaKeys` | 20,000 | Statements whose totals are kept between samples (oldest dropped first) |
| `shownHashes` | 200 | Recent Expensive Queries rows |
| `textCache` | 2,000 | Statement texts kept for Recent Expensive Queries |
| `textBatch` | 50 | Statement texts fetched per statement |
| `textBatchesPerTick` | 4 | Text statements per sample |
| `leadBlockerBatches` | 20 | Lead blockers whose last batch is read per sample |
| `statementChars` | 4,000 | Characters of a statement in a grid |
| `inputBufferChars` | 4,000 | Characters of a lead blocker's last batch read per sample |
| `resourceChars` | 512 | Characters of a wait resource description |
| `lastBatchChars` | 200 | Characters of the last batch on a Blocking row |
| `facetColumns` | 7 | Columns with value filters |
| `facetValues` | 100 | Distinct values a column filter lists |
| `facetChars` | 128 | Characters of a listed value |
| `filterText` | 400 | Characters in the filter box |
| `columnFilters` | 8 | Column filters at once |
| `columnFilterValues` | 50 | Values chosen in one column filter |
| `columnFilterChars` | 256 | Characters of a chosen value |
| `columnsPerProjection` | 64 | Columns a pane asks for |
| `detailsChars` | 1,000,000 | Characters of a text Details returns whole when asked for it (Open in Query Editor) |
| `detailsPreviewChars` | 65,536 | Characters of each text (statement, batch, last batch) in the Details flyout |
| `detailsWaits` | 20 | Session waits in Details |
| `detailsTransactions` | 50 | Transaction rows (one per transaction and database) in Details |
| `detailsLocks` | 1,000 | Grouped lock rows in Details |
| `detailsBudgetMs` | 10,000 | Milliseconds a Details read may take, gate wait and connect included, before it answers TIMEOUT |
| `detailsRunning` | 32 | Details reads main tracks for cancellation at once |
| `killSessions` | 64 | Sessions one Kill Process request may end |
| `killBudgetMs` | 25,000 | Milliseconds a Kill Process request may take; past it, sessions not yet tried are left alone and reported so |
| `killMessageChars` | 2,000 | Characters of a Kill outcome's message |
| `cancelIds` | 16 | Details reads one cancel may name |
| `cancelTombstones` | 64 | Cancelled Details ids main remembers, so a read cancelled before it was sent is refused |
| `cancelTombstoneMs` | 60,000 | Milliseconds main remembers them |
| `sessionId` | 32,767 | The largest session id |
