# SQL Server Agent plan (0.10.0)

Status: **agreed with the owner on 2026-11-15** (decisions below). Nothing here is implemented yet. This page is the
plan of record for the Agent lanes; each lane's PR updates the area's own page (a new docs/sql-server-agent.md, generated
below a marker like docs/integration-services.md) and moves the lane's row here to Done.

0.10.0 ships two headline features: SQL Server Agent (this page) and BigQuery (docs/bigquery-plan.md, planned in parallel).
SSMS 2022/22 is the parity target for names, menus, keys and behaviour; visuals follow Calm Pro.

Mocks of every new or changed surface: [docs/mockups/sql-server-agent.html](mockups/sql-server-agent.html) (open it in a
browser; Dark and Light, a picker per surface, design notes as dashed boxes). Each lane's PR builds what its mock shows, or
updates the mock in the same PR when the design changes.

## Owner decisions (2026-11-15)

- **Plan home**: this docs page plus the mocks, in a docs-only PR (as docs/bigquery-plan.md), pushed only with mocks for
  all new and changed UI in Varia's style.
- **Agent service control**: Start, Stop and Restart in 0.10.0 through `master.dbo.xp_servicecontrol`, behind a
  confirmation, sysadmin and Windows servers only, hidden on Linux and Managed Instance.
- **Proxies and credentials**: full dialogs in 0.10.0: New and Properties for proxies (General, Principals, References)
  and a New Credential dialog (lane AG-8b).
- **Log File Viewer**: master/detail (runs grid, the selected run's steps below, details pane); no tree mode in `GridView`.
- **Local live checks**: the owner sets the local MSSQLSERVER's Agent to Automatic, so `VARIA_TEST_SQL_AGENT=1` checks
  (CmdExec, PowerShell and SSIS steps included) run locally; tests never start or stop the service themselves.
- **Running-jobs chip**: shown on both the server row (as today) and the Agent node, so a collapsed server still says jobs
  are running.
- **Write path**: Agent writes run inside ActionService, templates in `AgentSql` with a lint chained from `ActionSql.Lint`.
- **Scope cut if 0.10.0 runs long**: must ship AG-0 to AG-6c; may slip AG-7 (operators and alerts dialogs), AG-8a
  (proxies read-only, Agent Properties) and AG-8b (proxy and credential dialogs). Operators, alerts and proxies stay
  listable and scriptable from AG-1 and AG-4.

## What exists today

- Object Explorer lists `SQL Server Agent` only as a planned folder (`laterFolders`, order 9, in
  `src/shared/explorer/catalog.ts`).
- The live `explorer.agent` probe (`Live/LiveSql.cs`) already counts running jobs from `msdb.dbo.sysjobactivity` for the
  Agent's current session, and the server row shows "n Agent jobs running" (`src/shared/explorer/status.ts`). The catalogue
  comment says the chip lives on the server row only until the Agent node is served; the owner chose to keep it there as
  well (decisions below), so that comment changes, not the chip.
- Icon `agent-job` exists (`src/shared/icons.ts`), marked "jobs (planned)".
- Script As's destinations leave out SSMS's "Agent Job…" until Agent exists (`src/shared/scripting/catalog.ts`).
- SSIS is the closest precedent: its own catalogue (`src/shared/ssis/catalog.ts`: code tables, describe views, verbs,
  documents, limits), tree kinds in the explorer catalogue, a live change probe that reloads only changed tree parts, a
  live Operations document with filters as args, and a write service whose steps call only catalog procedures. Agent
  follows the same shape.

## Facts checked on a real server

Read-only probe of the owner's local SQL Server 2025 Developer (17.0.1000.7, EngineEdition 3) on 2026-11-15:

- `sys.dm_server_services` lists `SQL Server Agent (MSSQLSERVER)` as **Stopped, Manual**. `Agent XPs` is still 1 while
  the service is stopped, so `Agent XPs` alone does not mean "running".
- `msdb.dbo.syssubsystems` lists TSQL, CmdExec, Snapshot, LogReader, Distribution, Merge, QueueReader, ANALYSISQUERY,
  ANALYSISCOMMAND, SSIS, PowerShell. Linux servers list fewer (T-SQL plus replication), so step types are read from this
  table, never assumed per platform.
- `SQLAgentUserRole` has SELECT only on `sysjobs_view`, `sysschedules_localserver_view` and `syscategories`, and EXECUTE on
  the `sp_help_*`, `sp_add_*`, `sp_update_*`, `sp_delete_*`, `sp_start_job` and `sp_stop_job` procedures. It has **no
  SELECT on `sysjobactivity`, `sysjobhistory` or `sysjobsteps`**. `SQLAgentOperatorRole` adds SELECT on `sysalerts`,
  `sysoperators`, `sysnotifications` and EXECUTE on `sp_help_alert`, `sp_help_notification`, `sp_purge_jobhistory`,
  `sp_enum_login_for_proxy`. Reader and Operator are members of User.
- `Database Mail XPs` is 0 (Database Mail not set up).

Consequence: anything a non-sysadmin should see must be read through msdb's own `sp_help_*` procedures, which also apply
Agent's ownership filtering exactly as SSMS shows it. Direct table reads are an optimisation for sysadmin only.

## Servers

| Server | Agent node | Notes |
| --- | --- | --- |
| SQL Server 2016-2025, Windows (EngineEdition 1-3) | Shown | Full feature set. Start/Stop/Restart only here. |
| SQL Server on Linux | Shown | Agent must be enabled (`mssql-conf set sqlagent.enabled true` or `MSSQL_AGENT_ENABLED=true`). Step types from `syssubsystems` (no CmdExec, PowerShell, SSIS). No service control from T-SQL. |
| Express (EngineEdition 4) | Hidden | No Agent service; SSMS hides the node too. |
| Azure SQL Managed Instance (8) | Shown | Agent always runs and cannot be stopped; no Start/Stop/Restart. Subsystems from `syssubsystems`; notifications by Database Mail only. Verify proxies and error-log reads on MI during AG-1. |
| Azure SQL Database, Synapse, Fabric, Edge (`cloud`) | Hidden | No Agent. Elastic Jobs is a different product and out of scope. |

The folder is `engines: ['box']` with an additional edition gate (Express out) mirrored in `ExplorerProfile`. Agent nodes
are SQL Server only; when BigQuery's BQ-0 adds `providers` to catalogue entries, Agent's entries take the default
`['sqlserver']`, and a BigQuery handle reaching an Agent method answers `UNSUPPORTED_PROVIDER`.

## Permissions and how the UI degrades

A capability probe (one constant batch in msdb through `msdb.sys.sp_executesql`, like the explorer's per-database
batches) reads `IS_SRVROLEMEMBER('sysadmin')` and `IS_ROLEMEMBER` for the three Agent roles, cached per connection and
re-read on Refresh. It drives the tree, menus (context keys `agentRole`: `sysadmin | operator | reader | user | none`)
and the reader path.

| Login | Tree shows | Can do |
| --- | --- | --- |
| sysadmin | Everything | Everything, incl. any job owner, Agent properties, error logs, service control. |
| SQLAgentOperatorRole | Jobs (all), Job Activity Monitor, Alerts, Operators, Proxies (read-only) | Start/Stop/Enable/Disable any local job; delete history; edit only own jobs. |
| SQLAgentReaderRole | Jobs (all, others' read-only), Job Activity Monitor | View all jobs and history; edit only own jobs. |
| SQLAgentUserRole | Jobs (own only), Job Activity Monitor (own) | Create and manage own jobs; T-SQL steps, or other subsystems only through a proxy granted to the login. |
| No msdb access / no role | Agent node with `noAccess` status | Nothing; the node says why. |

Rules: hide what SSMS hides (Alerts/Operators/Proxies/Error Logs below Operator; Error Logs sysadmin only), disable
rather than hide verbs on objects the login can see but not change (others' jobs for Reader), and treat every refusal the
server still returns as a value (`PERMISSION_DENIED`) with the dialog staying open. The owner picker in the job dialog is
read-only for non-sysadmin, as in SSMS.

## Object Explorer

Tree (SSMS order), all new kinds `scope: 'agentObject'` (name only; job names are unique per server):

```
SQL Server Agent                (agent node: state sublabel "Agent XPs disabled" / "Stopped"; chips)
  Jobs                          (job rows, filter by name/owner/category; enabled/disabled status badge)
  Job Activity Monitor          (leaf: opens the document)
  Alerts                        (alert rows, disabled badge)
  Operators                     (operator rows, disabled badge)
  Proxies
    <one folder per subsystem in syssubsystems that has proxies>, Unassigned Proxies
  Error Logs                    (Current - <date>, Archive #1 - <date> ...)
```

- `laterFolders` loses `SQL Server Agent`; folders and kinds (`agent`, `agentJob`, `agentAlert`, `agentOperator`,
  `agentProxy`, `agentErrorLog`) go in the explorer catalogue; listings are `CatalogSql` queries, constant text per band,
  linted as today. Sysadmin listings read the msdb tables/views; the role path calls `msdb.dbo.sp_help_job` /
  `sp_help_operator` / `sp_help_alert` / `sp_help_proxy` with parameters (needs a lint allowance for an allowlisted set of
  read-only msdb procedures in reads, see SQL rules below). Error logs list through `xp_enumerrorlogs 2` (sysadmin).
- Agent state: a new `explorer.agentService` probe (in the existing `explorer` live source) reads
  `sys.dm_server_services` where it answers, else the presence of an Agent session (`program_name LIKE N'SQLAgent - %'`)
  in `sys.dm_exec_sessions`. The Agent node gets chips of its own (`statusChipKinds.agent`): "Stopped" (warning) and the
  running-jobs chip. The server row **keeps** its running-jobs chip too, so a server collapsed (or scrolled to the top or
  bottom of Object Explorer) still shows that jobs are running; both chips read the one `explorer.agent` sample, so showing
  it twice costs no extra probe. The node never reloads the tree for a chip.
- A live change probe (`agent.treeProbe`, like `ssis.catalogProbe`: row count + checksum of the columns the tree shows
  for jobs, alerts, operators, proxies) reloads only changed folders, keeping expansion and selection, while an Agent
  folder is open.
- Search Objects indexes jobs, alerts, operators and proxies by name (sysadmin path; role path lists own jobs), so Ctrl+Q
  finds a job.
- Menus (SSMS names): Agent node: Start, Stop, Restart, Properties, View History, Refresh. Jobs folder: New Job…, Manage
  Job Categories, Manage Schedules, View History, Filter, Refresh. Job: Start Job at Step…, Stop Job, Script Job as ›,
  View History, Enable, Disable, Rename, Delete, Properties. Alerts/Operators/Proxies: New…, Enable/Disable, Script as ›,
  Rename, Delete, Properties. Error Logs: Configure, Recycle, View Agent Log.

## Jobs

Identity: refs carry the name; describe returns `job_id` and `date_created`, and every write binds `@job_id` and first
checks the name and creation date still match (as Delete Database binds `database_id` and `create_date`), answering
`OBJECT_CHANGED` otherwise. Schedules are identified by `schedule_id` (their names are not unique).

Verbs (all via ActionService, see below):

| Verb | msdb procedure | Notes |
| --- | --- | --- |
| Start Job at Step… | `sp_start_job @job_id, @step_name` | Dialog lists steps when the job has more than one, as SSMS. Status-bar progress follows the live JAM row, no polling. |
| Stop Job | `sp_stop_job @job_id` | |
| Enable / Disable | `sp_update_job @job_id, @enabled` | Multi-select in JAM and the tree. |
| Rename | `sp_update_job @job_id, @new_name` | Inline rename like other kinds. |
| Delete | `sp_delete_job @job_id, @delete_history` | Delete Object dialog, history option on by default as SSMS. |
| New Job / Properties | `sp_add_job`, `sp_update_job`, `sp_add_jobstep`, `sp_update_jobstep`, `sp_delete_jobstep`, `sp_add_jobschedule` / `sp_attach_schedule` / `sp_detach_schedule`, `sp_add_jobserver`, `sp_update_notification`… | One transaction per save, Script Action shows the exact batch (SSMS's `BEGIN TRANSACTION … QuitWithRollback` shape). |
| Script Job as › CREATE / DROP / DROP And CREATE | SMO `Server/JobServer/Job` through `ScriptPipeline` | Also Alert, Operator, Proxy. Never executes. |

Job dialog pages (`ObjectDialog` with pages, as Login and Database Properties):

- **General**: Name, Owner (picker; sysadmin only), Category (from `sp_help_category`), Description, Enabled, plus the
  read-only Created / Modified / Last executed facts.
- **Steps**: grid of steps (order, name, type, on success, on failure), New / Insert / Edit / Delete / Move up / Move down,
  Start step. Deleting a step another step jumps to warns as SSMS does.
  - Step dialog **General**: Step name, Type (from `syssubsystems`, filtered by what the login can run), Run as (proxies
    granted for that subsystem; "SQL Server Agent Service Account" for sysadmin), Database (T-SQL), Command in a Monaco
    editor (T-SQL gets the query editor's language features; Parse uses the language service's parse, never executes),
    Open… loads a file through main's dialog.
  - Step dialog **Advanced**: On success / On failure action (next step, quit reporting success/failure, go to step n),
    Retry attempts and interval, Output file (server path through the existing server file picker) and Append, Log to
    table, Include step output in history, Run as user (T-SQL).
  - SSIS steps: package source (SSIS Catalog / SQL Server / file system), the catalog tree reused from SSIS for picking a
    package, environment reference and parameter overrides as a command line the backend builds; Configuration tab subset.
    CmdExec: command and process exit code. PowerShell: script.
- **Schedules**: job's schedules (name, enabled, description), New…, Pick… (shared schedules from
  `sp_help_schedule`), Edit…, Remove (detach; delete when unused, asked as SSMS).
  - Schedule dialog: Name, type (Recurring, One time, Start automatically when SQL Server Agent starts, Start whenever the
    CPUs become idle), frequency (daily / weekly days / monthly day-or-relative), daily frequency (once / every n
    hours-minutes-seconds between times), duration, and SSMS's live **Description** sentence. The sentence and the
    `sysschedules` encoding live in `src/shared/agent/schedule.ts`, pure and covered by table tests against SSMS's own
    sentences.
- **Alerts**: alerts that run this job (Add opens New Alert with the job preset, Remove).
- **Notifications**: E-mail / Page / Net send operator with When (succeeds, fails, completes), Write to the Windows
  Application event log, Automatically delete job. Net send and Page shown as SSMS 22 shows them (deprecated).
- **Targets**: "Target local server" only in 0.10.0; multi-server (MSX/TSX) targets are later and shown disabled.

## Job Activity Monitor and history

**Job Activity Monitor** is its own document (as SSMS), opened from its tree node, either running-jobs chip (server row or
Agent node), and
the palette (`SQL Server Agent: Job Activity Monitor`).

- Live source `agent.jobs` (scope server, the " - Activity Monitor" pool in master, its prologue and gates), probe
  `agent.jobs.list`: one snapshot table keyed by `job_id` with SSMS's columns (Name, Enabled, Status, Last Run Outcome,
  Last Run, Next Run, Category, Runnable, Scheduled, Category ID) plus the current step while running, and a tone column
  (failed → error, running → accent, disabled → muted). Series: running, failed in the last 24 h. Read through
  `sp_help_job` (current execution status, step and next run, with role filtering for free); a sysadmin path over
  `sysjobs`/`sysjobactivity`/`sysjobservers` only if measurement shows `sp_help_job` too slow. Agent stopped: the table shows
  the last outcomes with Status "Agent stopped", never an error banner.
- Rendered through `LiveGrid` (the same grid components as Results, per the 2026-11-10 rule), with View filter chips
  (All, Running, Failed, Disabled), the filter box, column value filters (filters run in backend memory over the sample as
  Activity's do), row actions (Start Job at Step, Stop, Enable, Disable, View History, Properties) and multi-select.
  `LiveService` pauses it while hidden; the renderer never polls.
- Relation to Activity Monitor: separate document, shared machinery (live source, LiveGrid, filters, tones). Later: the
  Sessions pane decodes `SQLAgent - TSQL JobStep (Job 0x… : Step n)` program names into the job's name with a "Go to job"
  link.

**View History / Log File Viewer** is one document for job history and Agent error logs (and, later, SQL Server Logs and
Database Mail logs, which SSMS also shows there).

- Left: log sources with checkboxes (Job History › each job; SQL Server Agent › Current, Archive #n). Right: the grid,
  then a details pane for the selected row (the full message).
- Job history: live source `agent.history` modelled on `ssis.operations`: args are the filters (jobs, outcome, date
  window, message text, step), rows newest first by `instance_id` with the same settle rule (an identity is assigned
  before its row commits), departed rows when history is purged, a row cap with explicit truncation. Master/detail rather
  than tree rows: the grid lists runs (step 0 rows); selecting one fills a steps grid below with that run's steps, so
  `GridView` needs no tree mode. Message text in the grid is cut to a catalogue limit; the details pane reads the full
  text through `agent.describe`'s `historyMessage`.
- Reader path as JAM: `sp_help_jobhistory` (role-filtered) or `sysjobhistory` for sysadmin.
- Delete history: `sp_purge_jobhistory` (Operator or sysadmin), from the Log File Viewer and the job's menu.
- Agent error logs: `xp_readerrorlog <n>, 2` with the search text as its parameters, sysadmin only, read in pages; same
  grid, filters and export (Copy / Save through `ResultTextWriter`).

## Alerts, operators, proxies, schedules, error logs, Database Mail

| Area | 0.10.0 | Later |
| --- | --- | --- |
| Shared schedules | Schedule dialog, Pick, Manage Schedules list (jobs per schedule, delete unused) | |
| Job categories | Category picker | Manage Job Categories dialog |
| Operators | List, New / Properties (General: name, enabled, e-mail, pager and schedule; Notifications: alerts and jobs; History), Enable/Disable, Rename, Delete, Script As | |
| Alerts | List, New / Properties (General: SQL Server event by error number or severity with database and message text, performance condition; Response: run job, notify operators; Options: include text, delay), Enable/Disable, Delete, Script As | WMI event alerts (Windows only, shown read-only) |
| Proxies | List by subsystem, New / Properties (General: name, credential, description, subsystems from `syssubsystems`; Principals; References), Delete, Script As | |
| Credentials | New Credential (name, identity, secret, encryption provider) and Properties, its secret handled as New Login's password (secret slot only, one parameter, scrubbed, scripted as `<secret>`) | |
| Error logs | List, view in Log File Viewer, Recycle (`sp_cycle_agent_errorlog`) | Configure (log path, level) via Agent Properties |
| SQL Server Agent Properties | General (auto restart), History (max rows, per job, remove older than) | Advanced, Alert System (mail profile), Job System, Connection |
| Agent service | State and chips; Start / Stop / Restart (`xp_servicecontrol`, sysadmin, Windows) | |
| Database Mail | Read whether it is set up (`Database Mail XPs`, `sysmail_profile`) and warn on e-mail notifications when it is not | Database Mail configuration wizard and Database Mail log |
| Multi-server (MSX/TSX) | Targets page shows local only | Multi-server administration |
| Script Action to Job | | The "Agent Job…" Script As destination and dialogs' "Script Action to Job" |

## SQL rules

Agent adds no new DDL path; it extends two existing ones.

- **Reads** (tree, describe, history, JAM): constant text per query and band, values as parameters, `READ UNCOMMITTED`,
  `LOCK_TIMEOUT` as each pool already sets, no metadata built-ins. New: a read may `EXEC` a procedure only from
  `AgentSql.ReadProcedures` (an allowlist of read-only msdb `sp_help_*`, `xp_enumerrorlogs`, `xp_readerrorlog`), with
  arguments only as parameters; `CatalogSql.Lint` and the live lints refuse any other `EXEC`. The pool is the existing one
  for each surface (explorer pool for listings, " - Activity Monitor" for live, explorer pool for describes).
- **Writes**: inside `ActionService` (its own unpooled, never-retried connection, preflight in the same connection, Stop,
  `LOCK_TIMEOUT -1`, reader-only execution, no logging), with templates in `Agent/AgentSql.cs` checked by
  `AgentSql.LintExecutable`, which `ActionSql.Lint` chains as it does `LoginSql`: every statement is
  `EXEC msdb.dbo.<allowlisted procedure>` with named arguments bound only to parameters, guarded by the identity check;
  no dynamic SQL, no literals but constants, no `QUOTENAME` needed because names never enter SQL text. A job save is one
  transaction. Live checks prove that hostile names (`]`, `'`, `--`, Unicode, 128-character names) round-trip and that
  Script Action equals what runs. Why ActionService and not an `AgentActionService` like SSIS: SSIS needs an SSISDB
  connection of its own, while msdb procedures run from master with three-part names, and Agent's verbs are ordinary
  object actions (dialogs, Delete Object, Rename, Script Action) that ActionService already owns.
- **Service control**: `master.dbo.xp_servicecontrol N'Start'|N'Stop', N'SQLServerAgent'` as constant
  text, sysadmin and Windows box servers only, through ActionService with a confirmation.
- **Script As**: SMO through `ScriptPipeline` (`JobServer` URNs), never executing, `HeaderGuard` applied.
- Never log job, step, schedule, operator or alert names, commands, messages or SQL.

## Catalogue

`src/shared/agent/catalog.ts`, the single declaration of Agent semantics (code tables: run status, execution status,
step subsystems and their SSMS names, on-success/failure actions, schedule frequency types and intervals, notify levels,
alert types, JAM columns and tones, history columns, verbs, documents, error codes, limits), embedded by the backend as
`Agent/agent-catalog.json` and generating the reference part of docs/sql-server-agent.md with
`npx vitest run tests/agent-catalog.test.ts -u` (a new row in CLAUDE.md's generated-files table). Tree kinds stay in the
explorer catalogue; verbs and dialogs in the actions catalogue; live sources in the live catalogue.

## Testing

- **CI**: add `MSSQL_AGENT_ENABLED: 'true'` to the three `mssql/server:2022-latest` services in `.github/workflows/ci.yml`
  (pinned by `tests/ci-workflow.test.ts`) and to `.claude/hooks/session-start.sh`'s `docker run`, and set
  `VARIA_TEST_SQL_AGENT=1` there. Linux Agent runs T-SQL steps only, so CmdExec, PowerShell and SSIS steps are covered by
  offline lint and script tests in CI and by live checks on the owner's Windows server.
- **`VARIA_TEST_SQL_AGENT=1`** (new, docs/testing.md): Agent live suites require a running Agent and fail if it is not
  running; without the variable they skip with one line saying why. Tests never start or stop the service, except an
  opt-in `VARIA_TEST_SQL_AGENT_SERVICE=1` check of service control on a disposable server.
- **Scratch objects**: Agent objects are server-level, in msdb. Every job, schedule, operator, alert and category a
  check makes is named `VariaScratch_<run>_…`, created under a `VariaScratch` job category, dropped in `finally`, and
  swept by name prefix and age (`ScratchAgent.cs`, beside `ScratchDatabase.cs`). Checks never read, change or count
  non-scratch Agent objects except read-only listings, and tolerate other sessions' scratch jobs.
- **Live suites** (each with its seconds in `LiveGroups.Suites` and docs/ci.md's table): `Agent` (tree, capability,
  role paths with low-privilege SQL logins in each Agent role, made and dropped by the check), `AgentJobs` (a scratch job
  with a `WAITFOR DELAY` T-SQL step: start at step, stop, enable/disable, status transitions seen through the live source,
  history rows, waits on conditions only), `AgentActions` (every write template against hostile names, Script Action
  equals the batch run, identity guard), `AgentScripting` (SMO scripts vs SSMS goldens in `tests/fixtures/scripting/`).
- **Offline**: `AgentSql` lints render every variant; schedule encoding and description table tests (TS, plus a C#
  mirror check if the backend ever builds sentences); catalogue snapshot; zod/C# limit mirrors.
- **Smoke**: `scripts/agent-smoke.mjs` (tree, JAM grid, job dialog round trip, Log File Viewer), surfaces found by ARIA
  role and name through `scripts/fixtures/ui.mjs`.

## Lanes

Ordered; lanes on the same line can run in parallel once their dependency lands. Sizes are rough (S < 1 day of agent
work, M, L).

| Lane | Scope | Depends on | Size |
| --- | --- | --- | --- |
| AG-0 | Foundations: `src/shared/agent/catalog.ts` (code tables, limits, docs generation), capability probe and `agentRole` context key, `AgentSql` read allowlist + lint, CI `MSSQL_AGENT_ENABLED`, `VARIA_TEST_SQL_AGENT`, `ScratchAgent`, Agent live suite skeleton | — | M |
| AG-1 | Object Explorer: Agent node and folders, listings (both paths), edition gates, state probe, Agent node chips (the server row keeps its running-jobs chip), `agent.treeProbe`, Search Objects kinds, menus wired to "not yet" verbs hidden | AG-0 | M |
| AG-2 | Job verbs: Start Job at Step, Stop, Enable/Disable, Rename, Delete via ActionService + `AgentSql` write lint + identity guard | AG-1 | M |
| AG-3 | Job Activity Monitor: `agent.jobs` live source, document with LiveGrid, chips, filters, row actions (AG-2's verbs) | AG-1 (AG-2 for actions) | M |
| AG-4 | Script As for Job, Alert, Operator, Proxy (SMO, goldens) | AG-1 | S |
| AG-5 | Log File Viewer: `agent.history` live source, master/detail grids, details pane, purge history, Agent error logs (list, view, recycle) | AG-1 | L |
| AG-6a | Job dialog shell: describe, General, Notifications, Targets (local), Alerts list, one-transaction save, Script Action, New Job | AG-2 | M |
| AG-6b | Steps page and step dialog (T-SQL with editor features and Parse, CmdExec, PowerShell, SSIS basics, Advanced) | AG-6a | L |
| AG-6c | Schedules: `schedule.ts` encoding + Description sentences, schedule dialog, Pick, Manage Schedules | AG-6a | M |
| AG-7 | Operators and Alerts: dialogs, Enable/Disable, Delete; Database Mail readiness warning | AG-1, AG-6a (shared dialog parts) | M |
| AG-8a | SQL Server Agent Properties (General, History); Agent service Start / Stop / Restart | AG-1 | S |
| AG-8b | Proxies: New / Properties (General, Principals, References), Delete; New Credential and Credential Properties (secret slot as New Login) | AG-1, AG-6a | M |
| AG-9 | Getting Started guide and sample, README, CHANGELOG pass, parity re-check of the Agent rows | all | S |
| Later | Manage Job Categories, multi-server targets, Script Action to Job, Activity Monitor job links, SQL Server Logs and Database Mail in the Log File Viewer, Agent Properties' remaining pages, Elastic Jobs | | |

Suggested waves: AG-0 → AG-1 → {AG-2, AG-4, AG-5, AG-8a} → {AG-3, AG-6a} → {AG-6b, AG-6c, AG-7, AG-8b} → AG-9. Lanes that
touch the Agent tree menus or the actions catalogue (AG-2, AG-6a, AG-7, AG-8a, AG-8b) merge main in after each lands, as the Activity
Monitor lanes did.

Coordination with BigQuery: AG-1 and BQ-5 both extend `src/shared/explorer/catalog.ts` and its generated
docs/object-explorer.md and `explorer-catalog.json`. Land AG-1 before BQ-5 starts, or rebase whichever is second; neither
needs the other. BQ-0's `providers` default covers Agent's entries whichever lands first.

## Questions still open

None blocking. Lanes raise new questions in their PRs; verify on Managed Instance during AG-1 which proxy and error-log
reads it allows, and record the answer in docs/sql-server-agent.md.
