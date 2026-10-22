# Live data

<!-- Generated from src/shared/live/catalog.ts. Regenerate with: npx vitest run tests/live-catalog.test.ts -u -->

Periodic data (the Activity Monitor, SSIS monitoring, later Object Explorer status) flows through one stream method,
`live.subscribe`, and one control method, `live.update` ([docs/ipc.md](ipc.md#live-subscriptions)). A subscription
names one source and up to 8 of its probes; the backend schedules every probe and sends one `live.tick` per
scheduler wake, only after the renderer has applied the previous one. This page lists the sources and probes the
catalogue declares, and what each probe emits. Sources marked test only are accepted only by an unpackaged smoke run
(main's test schemas) and a backend started with `VARIA_BACKEND_TEST_HOOKS=1`.

## Sources

| Source | Scope | Probes | Test only | Description |
| --- | --- | --- | --- | --- |
| `debug.synthetic` | none | `debug.synthetic.metrics`, `debug.synthetic.table`, `debug.synthetic.status` | yes | Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it. |
| `activity` | server | `activity.overview` | no | SQL Server's own activity, read from server DMVs on the connection's " - Activity Monitor" pool (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). |

## Probes

A probe's statement budget is 0.8 × its interval within the range shown. The series kinds say how the backend turns
raw values into samples: `gauge` as read, `rate` and `msPerSecond` as change per second of the server's own clock,
`ratio` as change over a base counter's change, `cpuPercent` as CPU time over elapsed time across the schedulers; every
kind but `gauge` is null in a sample marked `baseline` or `resumed` and after a restart (`reset`); a single counter
that went down (cleared) is null alone, also marked `reset`, and the others keep their rates.

| Probe | Interval (default, min, max) | Schedule | Runs on | Emits | Description |
| --- | --- | --- | --- | --- | --- |
| `debug.synthetic.metrics` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | series `counter` (count, gauge), `wave` (percent, gauge), `rate` (perSecond, gauge) | Three series: the sample number, a wave between 0 and 100, and a rate that follows it. |
| `debug.synthetic.table` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | snapshot table 0 `rows`: `id` int, `label` nvarchar, `value` int; key `id` | A snapshot table whose rows move on by one id per sample, so rows leave at the top and arrive at the bottom. |
| `debug.synthetic.status` | 1 s, 1 s, 3,600 s | budget 500 ms to 5 s; slows above 25 % of its interval | wherever its source runs | status `phase`, `samples` | The phase (even or odd) and the sample count. |
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
| Live statements | 2 at once per connection and 8 in the backend (shared with unary methods on lane live); a statement waits for its turn at most its budget, then the probe reports BUSY |
| Statement budget | 0.8 × the probe's interval, within the probe's range and 500 ms to 10 s |
| Back-off | a failing or costly probe slows to at most 60 s (or its asked interval, when longer) |
| Idle connection | returned to the pool while every probe is paused, when the next sample is at least 30 s away, and between samples when every running probe's interval in force is at least 30 s |
