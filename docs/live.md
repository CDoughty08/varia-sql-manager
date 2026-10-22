# Live data

<!-- Generated from src/shared/live/catalog.ts. Regenerate with: npx vitest run tests/live-catalog.test.ts -u -->

Periodic data (the Activity Monitor, SSIS monitoring, later Object Explorer status) flows through one stream method,
`live.subscribe`, and one control method, `live.update` ([docs/ipc.md](ipc.md#live-subscriptions)). A subscription
names one source and up to 8 of its probes; the backend schedules every probe and sends one `live.tick` per
scheduler wake, only after the renderer has applied the previous one. This page lists the sources and probes the
catalogue declares, and what each probe emits. Sources marked test only are accepted only by an unpackaged smoke run
(main's test schemas) and a backend started with `VARIA_BACKEND_TEST_HOOKS=1`.

## Sources

While a source's view is hidden it pauses (no SQL), or, with the statusOnly policy, keeps only its probes without tables at
30 s or slower.

| Source | Scope | Probes | Test only | Hidden | Description |
| --- | --- | --- | --- | --- | --- |
| `debug.synthetic` | none | `debug.synthetic.metrics`, `debug.synthetic.table`, `debug.synthetic.status`, `debug.synthetic.grid`, `debug.synthetic.log`, `debug.synthetic.wide` | yes | pause | Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it. |
| `activity` | server | `activity.overview` | no | pause | SQL Server's own activity, read from server DMVs on the connection's " - Activity Monitor" pool (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). |

## Probes

A probe's statement budget is 0.8 × its interval within the range shown. The series kinds say how the backend turns
raw values into samples: `gauge` as read, `rate` and `msPerSecond` as change per second of the server's own clock,
`ratio` as change over a base counter's change, `cpuPercent` as CPU time over elapsed time across the schedulers; every
kind but `gauge` is null in a sample marked `baseline` or `resumed` and after a restart (`reset`); a single counter
that went down (cleared) is null alone, also marked `reset`, and the others keep their rates.

A snapshot table is a new stored result each sample (two revisions alive), sorted as asked with its key breaking ties,
cut at its row cap; one that keeps departed rows keeps a tracked row that left for one more revision. An append table
grows one stored result (a segment) by the rows above the highest id it has settled, rolling to a new segment at
200,000 rows or 32 MiB (2 segments' worth kept, in at most 8 results).
A probe whose filter mode is memory filters the stored cell text;
restart starts its append tables again under the new predicate.

| Probe | Interval (default, min, max) | Schedule | Runs on | Emits | Description |
| --- | --- | --- | --- | --- | --- |
| `debug.synthetic.metrics` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | series `counter` (count, gauge), `wave` (percent, gauge), `rate` (perSecond, gauge) | Three series: the sample number, a wave between 0 and 100, and a rate that follows it. |
| `debug.synthetic.table` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | snapshot table 0 `rows`: `id` int, `label` nvarchar, `value` int; key `id`; at most 10,000 rows | A snapshot table whose rows move on by one id per sample, so rows leave at the top and arrive at the bottom. |
| `debug.synthetic.status` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | status `phase`, `samples` | The phase (even or odd) and the sample count. |
| `debug.synthetic.grid` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval; views `even`; filter memory | wherever its source runs | snapshot table 0 `items`: `itemId` int, `group` nvarchar, `name` nvarchar, `amount` int; key `itemId`; at most 10,000 rows, keeps departed rows, facets `group`; snapshot table 1 `groups`: `groupName` nvarchar, `items` int; key `groupName`; at most 10 rows | Two snapshot tables from one sample. Items move on by one id per sample, as the table probe's rows do, in five groups, with group facets and departed rows; the even view keeps the items with an even id. Groups count the items of each group, built from the source's own state rather than read from SQL Server. |
| `debug.synthetic.log` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval; filter restart | wherever its source runs | append table 0 `messages`: `messageId` bigint, `level` int, `text` nvarchar; key `messageId`; keyset `messageId`, settles after 2 ticks and 0 s, at most 5,000 new rows a tick | An append table that grows by logRows messages a sample (levels 0 to 3). With lateEvery, one message of every n-th sample becomes visible a sample late, after higher ids, as a slow writer's commit would. A filter or a new logLevel (the lowest level shown) starts the table again under the new predicate, and start picks its first row. |
| `debug.synthetic.wide` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | snapshot table 0 `rows`: `rowId` int, `c1` nvarchar, `c2` bigint, `c3` datetime2, `c4` float, `c5` bit, `c6` int, `c7` nvarchar, `c8` bigint, `c9` datetime2, `c10` float, `c11` bit, `c12` int, `c13` nvarchar, `c14` bigint, `c15` datetime2, `c16` float, `c17` bit, `c18` int, `c19` nvarchar, `c20` bigint, `c21` datetime2, `c22` float; key `rowId`; at most 10,000 rows; status `gen2` | A snapshot of rows rows of 23 columns, the shape of a session list, for the snapshot churn benchmark. Its status reports how many gen2 collections the backend has run. |
| `activity.overview` | 2 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 20 % of its interval | SQL Server 13 and later; editions 1 (Personal), 2 (Standard), 3 (Enterprise), 4 (Express), 8 (Managed Instance); needs VIEW SERVER PERFORMANCE STATE (2022 and later) or VIEW SERVER STATE | series `cpuPercent` (percent, cpuPercent), `runnableTasks` (count, gauge), `batchRequests` (perSecond, rate), `compilations` (perSecond, rate), `recompilations` (perSecond, rate), `userSessions` (count, gauge) | The server at a glance, in one DMV query: SQL Server's CPU (its schedulers' non-preemptive time), runnable tasks, batch requests, compilations and re-compilations per second, and user sessions. Rates use the server's own clock (ms_ticks), and a restart starts them again. |

## Limits

| Item | Value |
| --- | --- |
| Subscriptions | 16 per results port (main), 32 per backend, 8 per SQL Server (by the server a connection reaches) |
| Probes | 8 per subscription; 4 snapshot and 4 append tables per probe, 8 tables per tick |
| Interval | 1 s to 3,600 s requested, then clamped to the probe's own minimum and maximum |
| Frames | one unacknowledged per subscription; initial credit 64 KiB; at most 256 KiB each, and the catalogue's worst case at most 192 KiB |
| Series, status values, errors | 64 series per probe; 16 status values of 128 characters; 8 probe errors of 2,000 characters per tick |
| Sort, filter, tracking | 4 sort columns; filter text 400 characters on 8 columns; 64 tracked keys of 512 characters per table |
| Resume token, kept results | 256 base64url characters; 64 results kept when a source ends |
| Tables | a snapshot revision at most 10,000 rows (a table's own cap may be lower); an append segment 200,000 rows or 32 MiB, 2 segments' worth kept in at most 8 results a table; at most 10,000 new append rows a tick |
| Table memory | 64 MiB per subscription, all live tables at most 25 % of the result budget; past either, a sample stores what fits and reports BUDGET |
| Facets, departed rows | 7 columns of 100 values of 128 characters, at most 32 KiB of text a tick; 64 departed rows per table |
| Live statements | 2 at once per connection and 8 in the backend (shared with unary methods on lane live); a statement waits for its turn at most its budget, then the probe reports BUSY |
| Statement budget | 0.8 × the probe's interval, within the probe's range and 500 ms to 10 s |
| Back-off | a failing or costly probe slows to at most 60 s (or its asked interval, when longer) |
| Idle connection | returned to the pool while every probe is paused, when the next sample is at least 30 s away, and between samples when every running probe's interval in force is at least 30 s |
