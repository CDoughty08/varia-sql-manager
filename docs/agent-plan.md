# SQL Server Agent plan (0.10.0)

Status: **agreed with the owner on 2026-11-15** (decisions below), revised after adversarial review. Nothing here is
implemented yet. This page is the plan of record for the Agent lanes; each lane's PR updates the area's own page (a new
docs/sql-server-agent.md, generated below a marker like docs/integration-services.md) and moves the lane's row here to Done.

0.10.0 ships two headline features: SQL Server Agent (this page) and BigQuery (docs/bigquery-plan.md, in
CDoughty08/varia-sql-manager#528, not yet on main). SSMS 2022/22 is the parity target for names, menus, keys and
behaviour; visuals follow Calm Pro.

Mocks of every new or changed surface: [docs/mockups/sql-server-agent.html](mockups/sql-server-agent.html) (open it in a
browser; Dark and Light, a picker per surface, design notes as dashed boxes). Each lane's PR builds what its mock shows, or
updates the mock in the same PR when the design changes.

## Owner decisions (2026-11-15)

- **Plan home**: this docs page plus the mocks, in a docs-only PR (as docs/bigquery-plan.md), pushed only with mocks for
  all new and changed UI in Varia's style.
- **Agent service control**: Start, Stop and Restart in 0.10.0 through `master.dbo.xp_servicecontrol`, behind a
  confirmation, sysadmin and Windows servers only, hidden on Linux and Managed Instance. **Must ship** (lane AG-2).
- **Proxies and credentials**: full dialogs in 0.10.0: New and Properties for proxies (General, Principals, References),
  New Credential **and** Credential Properties (lane AG-8b).
- **Log File Viewer**: master/detail (runs grid, the selected run's steps below, details pane); no tree mode in `GridView`.
- **Local live checks**: the owner's local MSSQLSERVER runs Agent (Automatic, running since 2026-11-15 18:13), so
  `VARIA_TEST_SQL_AGENT=1` checks (CmdExec, PowerShell and SSIS steps included) run locally; tests never start or stop the
  service themselves.
- **Running-jobs chip**: shown on both the server row (as today) and the Agent node, so a collapsed server still says jobs
  are running.
- **Role reads**: Agent gets its own reader (`AgentReader`, like `ActivityReader`) whose lint lets a statement `EXEC` only
  named read-only msdb procedures with parameter arguments. Job Activity Monitor, history and both chips then work for
  every Agent role, showing the jobs that login may see.
- **Write path**: Agent writes run inside ActionService, templates in `AgentSql` with a lint chained from `ActionSql.Lint`.
- **SSIS package steps** stay in the must-ship steps lane (AG-6b).
- **Scope cut if 0.10.0 runs long**: must ship AG-0 to AG-6c; may slip AG-7 (operators and alerts dialogs), AG-8a (Agent
  Properties) and AG-8b (proxy and credential dialogs). Operators, alerts and proxies stay listable and scriptable from
  AG-1 and AG-4.

## What exists today

- Object Explorer lists `SQL Server Agent` only as a planned folder (`laterFolders`, order 9, in
  `src/shared/explorer/catalog.ts`).
- The live `explorer.agent` probe (`Live/LiveSql.cs`, around line 218) counts running jobs from `msdb.dbo.sysjobactivity`
  for the Agent's newest session, and the server row shows "n Agent jobs running" (`src/shared/explorer/status.ts`). Only
  sysadmin can read `sysjobactivity`; others get `PERMISSION_DENIED`, which `ExplorerStatusLiveChecks` asserts. The
  catalogue comment says the chip lives on the server row only until the Agent node is served; the owner chose to keep it
  there as well, so that comment changes, not the chip.
- `ScratchDatabase` already owns a scratch Agent job (`Job`, `JobMarker = "varia.scratch"` in its description,
  `IsScratchJob`, a stale-job sweep) for the Object Explorer status checks.
- Icon `agent-job` exists (`src/shared/icons.ts`), marked "jobs (planned)".
- Script As's destinations leave out SSMS's "Agent Job…" until Agent exists (`src/shared/scripting/catalog.ts`).
  `UrnBuilder` builds one-level server URNs only for its `ServerTypes`.
- SSIS is the closest precedent: its own catalogue (`src/shared/ssis/catalog.ts`), tree kinds in the explorer catalogue, a
  live change probe that reloads only changed tree parts, a live Operations document with filters as args, and writes that
  call only catalog procedures. Activity Monitor's `ActivityReader` is the precedent for a reader whose statements fail
  alone and whose lint differs from `LiveSql.Lint`.
- Object Explorer has single selection only; multi-select verbs live in Job Activity Monitor's grid.

## Facts checked on a real server

Read-only probes of the owner's local SQL Server 2025 Developer (17.0.1000.7, EngineEdition 3) on 2026-11-15:

- First probe: `sys.dm_server_services` listed `SQL Server Agent (MSSQLSERVER)` as Stopped, Manual while `Agent XPs` was
  still 1, so `Agent XPs` alone does not mean "running". Later the owner set it Automatic and started it: the DMV, three
  `SQLAgent - %` sessions and a new `msdb.dbo.syssessions` row all agreed.
- The Agent service account is `NT Service\SQLSERVERAGENT`; the engine's is `NT Service\MSSQLSERVER`.
  `xp_servicecontrol N'QueryState', N'SQLServerAgent'` answered "Running." as sysadmin. Start and Stop were not tried.
- `msdb.dbo.syssubsystems` lists TSQL, CmdExec, Snapshot, LogReader, Distribution, Merge, QueueReader, ANALYSISQUERY,
  ANALYSISCOMMAND, SSIS, PowerShell. Step types are read from this table, never assumed per platform.
- `SQLAgentUserRole` has SELECT only on `sysjobs_view`, `sysschedules_localserver_view` and `syscategories`, and EXECUTE on
  the `sp_help_*`, `sp_add_*`, `sp_update_*`, `sp_delete_*`, `sp_start_job` and `sp_stop_job` procedures. It has **no
  SELECT on `sysjobactivity`, `sysjobhistory` or `sysjobsteps`**. `SQLAgentOperatorRole` adds SELECT on `sysalerts`,
  `sysoperators`, `sysnotifications` and EXECUTE on `sp_help_alert`, `sp_help_notification`, `sp_purge_jobhistory`,
  `sp_enum_login_for_proxy`. Reader and Operator are members of User.
- `sp_help_job` with no arguments returns one result set of 32 columns per visible job, including `date_modified`,
  `version_number`, `current_execution_status` (1 executing, 2 waiting for thread, 3 between retries, 4 idle, 5 suspended,
  7 performing completion actions), `current_execution_step` (`"0 (unknown)"` when idle) and `next_run_date`/`next_run_time`
  as integers. Given `@job_id` it returns several result sets (job, steps, schedules, target servers).
- `Database Mail XPs` is 0 (Database Mail not set up).

Still to verify in AG-0, on a disposable server (never by stopping the owner's Agent): what `sp_help_job` and
`xp_sqlagent_enum_jobs` return while Agent is stopped; whether `xp_servicecontrol N'Start'|N'Stop'` works under the
default virtual accounts and for a named instance; and what the Linux container's `sys.dm_server_services` lists.

## Servers and platform gates

| Server | Agent node | Notes |
| --- | --- | --- |
| SQL Server 2016-2025, Windows (EngineEdition 1-3) | Shown | Full feature set. Start/Stop/Restart only here. |
| SQL Server on Linux | Shown | Agent must be enabled (`MSSQL_AGENT_ENABLED=true` or `mssql-conf set sqlagent.enabled true`). No service control from T-SQL. Feature gates below. |
| Express (EngineEdition 4) | Hidden | No Agent service; SSMS hides the node too. |
| Azure SQL Managed Instance (8) | Shown | Agent always runs; no Start/Stop/Restart. Feature gates below. |
| Azure SQL Database, Synapse, Fabric, Edge (`cloud`) | Hidden | No Agent. Elastic Jobs is a different product and out of scope. |

Platform feature gates live in the Agent catalogue (`agentPlatformGates`), one row per feature: Proxies folder, alert
types (event, performance condition, WMI), schedule types (CPU idle), notification kinds (e-mail, pager, net send), event
log notification, error logs, service control. Initial values from Microsoft's documentation (Linux: no proxies, no
CmdExec/PowerShell/SSIS steps, no WMI alerts, no event log; Managed Instance: no proxies' non-SSIS subsystems, no CPU-idle
schedules, e-mail only through Database Mail, no pager or net send) are **verified in AG-1**, Linux against the CI
container, Managed Instance from its documentation, and recorded in docs/sql-server-agent.md. The tree, dialogs and menus
read the gates; nothing hard-codes a platform.

Edition gating is new plumbing: `ExplorerProfile` (TS `src/shared/explorer/catalog.ts`, C# `ExplorerCatalog.cs`) gains the
engine edition and a host platform (`windows | linux`, from `host_platform` in `sys.dm_os_host_info`), and `FolderSpec`
gains `editions`/`platforms` gates that `folderServed` and its C# mirror check. Agent nodes are SQL Server only; when
BigQuery's BQ-0 adds `providers` to catalogue entries, Agent's take the default `['sqlserver']`, and a BigQuery handle on an
Agent method answers BQ-0's `UNSUPPORTED_PROVIDER` (planned in #528).

## Permissions and how the UI degrades

A capability read (one constant batch, msdb through `msdb.sys.sp_executesql`, as the explorer's per-database batches; the
same built-ins the SSIS profile and live session probe already use) reads `IS_SRVROLEMEMBER(N'sysadmin')`,
`IS_ROLEMEMBER` for the three Agent roles, `HAS_PERMS_BY_NAME` for VIEW SERVER STATE, and whether Database Mail can be
read. It is cached per connection and re-read on Refresh, and drives the tree, the menus (target-scoped context key
`agentRole`: `sysadmin | operator | reader | user | none`, plus `explorerSelectionAgentRole`) and the reader path.

| Login | Tree shows | Can do |
| --- | --- | --- |
| sysadmin | Everything | Everything, incl. any job owner, Agent properties, error logs, service control. |
| SQLAgentOperatorRole | Jobs (all), Job Activity Monitor, Alerts, Operators, Proxies (read-only) | Start/Stop/Enable/Disable any local job; delete history; edit only own jobs. |
| SQLAgentReaderRole | Jobs (all, others' read-only), Job Activity Monitor | View all jobs and history; edit only own jobs. |
| SQLAgentUserRole | Jobs (own only), Job Activity Monitor (own) | Create and manage own jobs; T-SQL steps, or other subsystems only through a proxy granted to the login. |
| No msdb access / no role | Agent node with `noAccess` status | Nothing; the node says why. |

Rules: hide what SSMS hides (Alerts/Operators/Proxies below Operator; Error Logs sysadmin only), disable rather than hide
verbs on objects the login can see but not change (others' jobs for Reader), and treat every refusal the server still
returns as a value (`PERMISSION_DENIED`) with the dialog staying open and saying which step was refused. The owner picker
is read-only for non-sysadmin, as in SSMS. A state the login cannot read is unknown, never a guess: Agent state without
VIEW SERVER STATE shows no state chip; Database Mail readiness without access shows no warning.

## Object Explorer

Tree (SSMS order). New kinds use the existing `serverObject` scope (a server-level object named by name alone; job,
alert, operator and proxy names are unique per server), so no new scope or ref field is needed:

```
SQL Server Agent                (agent node: "Stopped" sublabel and chip when stopped; "Agent XPs disabled" sublabel
                                 when that option is 0; running-jobs chip)
  Jobs                          (job rows, filter by name/owner/category/created; disabled status badge; state chips)
  Job Activity Monitor          (leaf: opens the document)
  Alerts                        (alert rows, disabled badge)
  Operators                     (operator rows, disabled badge)
  Proxies
    <one folder per subsystem in syssubsystems>, Unassigned Proxies
  Error Logs                    (Current - <date>, Archive #1 - <date> ...)
```

- `laterFolders` loses `SQL Server Agent`; folders and kinds (`agent`, `agentJob`, `agentAlert`, `agentOperator`,
  `agentProxy`, `agentErrorLog`) go in the explorer catalogue with icons registered in `icons.ts` (Agent, alert, operator,
  proxy, error log, schedule; `agent-job` reused).
- Listings, sysadmin path: `CatalogSql` queries over msdb tables/views, keyset-paged and filtered in SQL as every listing.
  Role path: Agent kinds list through `AgentReader` (`sp_help_job`, `sp_help_operator`, `sp_help_alert`, `sp_help_proxy`),
  which reads the whole result into backend memory up to `agentLimits.listRows`, marks truncation explicitly, and pages and
  filters it there; `CatalogSql` stays free of `EXEC`. Error logs list through `xp_enumerrorlogs 2` (sysadmin).
- Agent state: a new `explorer.agentService` probe in the `explorer` live source (added to `liveProbeIds` and the source's
  probe list), `permission: 'serverState'`, reads `sys.dm_server_services` and, where the DMV has no Agent row (Linux, to
  verify), an Agent session (`program_name LIKE N'SQLAgent - %'`) in `sys.dm_exec_sessions`. Without VIEW SERVER STATE the
  state is unknown and no state chip shows. Managed Instance is always running.
- Chips: `statusChipKinds` gains `agent: ['explorer.agentService', 'explorer.agent']`; `server` keeps `explorer.agent`.
  Both running-jobs chips read the one sample. `explorer.agent` gains a role band: sysadmin keeps today's direct
  statement; other logins are served by `AgentReader` (`sp_help_job`, counting `current_execution_status` in 1, 2, 3, 7), so
  the count is the jobs the login may see. Job rows show state chips (Running · step n/m, Failed, Between retries) from
  `agent.jobs` while the Jobs folder is open. Chips never reload the tree.
- A live change probe (`agent.treeProbe`, like `ssis.catalogProbe`: row count and checksum of the columns the tree shows,
  on the role-appropriate path) reloads only changed folders, keeping expansion and selection, while an Agent folder is open.
- Search Objects indexes Agent kinds in a separate server batch (`ObjectSearchSql.Agent`, through `AgentReader` for the
  role path), so a refusal skips only Agent kinds; Ctrl+Q finds a job and opens its Properties.
- Menus (SSMS names, catalogue entries in `src/shared/commands/catalog.ts`): Agent node: Start, Stop, Restart, Job
  Activity Monitor, View History, Properties, Refresh. Jobs folder: New Job…, Manage Schedules, View History, Filter,
  Refresh. Job: New Job…, Start Job at Step…, Stop Job, Script Job as ›, View History, Enable, Disable, Rename, Delete,
  Refresh, Properties. Alerts, Operators: New…, Enable/Disable, Script as ›, Rename, Delete, Refresh, Properties. Proxies: New
  Proxy…, Script as ›, Rename, Delete, Properties. Error Logs: View Agent Log, Recycle, Refresh. Palette: "SQL Server Agent:
  Job Activity Monitor", "SQL Server Agent: New Job".

## Jobs

Identity and concurrency: refs carry the name. Describe returns `job_id`, `date_created`, `date_modified` and
`version_number`. Every write binds `@job_id` and first checks, in its batch, that the job still has that name and
creation date (else `NOT_FOUND`, as Delete Database's check answers). Properties saves also check `version_number` and
`date_modified` are unchanged, else a new action error `STALE` ("Changed by someone else since it was opened. Reload to see
the changes."), retryable, added to `actionErrorRetryable`, its C# mapping and docs/ipc.md; the dialog offers Reload.
Guards read `sysjobs_view` (readable by every Agent role). Alerts, operators and proxies are unique by name; their writes
check by id the same way. Schedules are identified by `schedule_id` (names are not unique).

Verbs (all via ActionService, see SQL rules):

| Verb | msdb procedure | Notes |
| --- | --- | --- |
| Start Job at Step… | `sp_start_job @job_id, @step_name` | Dialog lists steps when the job has more than one, as SSMS. From Job Activity Monitor with several jobs selected, SSMS's Start Jobs progress dialog lists one line per job. |
| Stop Job | `sp_stop_job @job_id` | Several selected: one line per job, as Start. |
| Enable / Disable | `sp_update_job @job_id, @enabled` | Multi-select in Job Activity Monitor; single in the tree. |
| Rename | `sp_update_job @job_id, @new_name` | Inline rename like other kinds. |
| Delete | `sp_delete_job @job_id, @delete_history, @delete_unused_schedule` | Delete Object dialog; both options shown and on by default, as SSMS passes both as 1. |
| New Job / Properties | `sp_add_job`, `sp_update_job`, `sp_add_jobstep`, `sp_update_jobstep`, `sp_delete_jobstep`, `sp_add_jobschedule` / `sp_attach_schedule` / `sp_detach_schedule`, `sp_add_jobserver`, `sp_update_job` notification arguments | One transaction, each call's return code checked (SQL rules); Script Action shows SSMS's `BEGIN TRANSACTION … QuitWithRollback` shape with literals, as Login's does. |
| Script Job as › CREATE / DROP / DROP And CREATE To › New Query, File, Clipboard | SMO `Server/JobServer/Job[@Name and @CategoryID]` through `ScriptPipeline` | Also Alert, Operator and `ProxyAccount`. Never executes. |

Status bar: a job this window started shows "Index maintenance: running step 2 of 4" with Stop in the status bar until it
ends, fed by a background `agent.jobs` view (`LiveService`, the Object Explorer status chips' slot rules) filtered to those
jobs and held only while one runs; it never polls and does not depend on Job Activity Monitor being open.

Job dialog pages (`ObjectDialog` with pages, as Login and Database Properties; describe through `actions.describe`):

- **General**: Name, Owner (picker; sysadmin only), Category (from `sp_help_category`; Manage Job Categories is later),
  Description, Enabled, plus the read-only Created / Modified / Last executed facts.
- **Steps**: grid of steps (order, name, type, on success, on failure), New / Insert / Edit / Delete / Move up / Move down,
  Start step. Deleting a step another step jumps to asks first and changes those to "Quit the job reporting failure", as
  SSMS does.
  - Step dialog **General**: Step name, Type (from `syssubsystems`, filtered by the platform gates and what the login can
    run), Run as (proxies granted for that subsystem through `sp_enum_proxy_for_subsystem`; "SQL Server Agent Service
    Account" for sysadmin), Database (T-SQL), Command in a Monaco editor (T-SQL gets the query editor's language features;
    Parse uses the language service's parse, never executes), Open… loads a local file through main's dialog.
  - Step dialog **Advanced**: On success / On failure action (next step, quit reporting success/failure, go to step n),
    Retry attempts and interval, Output file (server path through the server file picker) and Append, Log to table, Include
    step output in history, Run as user (T-SQL). SSMS's View buttons for the output file and the table log are later.
  - SSIS steps (in AG-6b): package source (SSIS Catalog / SQL Server / file system), the SSIS Catalog tree reused for picking
    a package, environment reference and parameter overrides as a command line the backend builds; Configuration tab
    subset. CmdExec: command and process exit code. PowerShell: script. A step whose command Varia cannot model keeps it
    as text.
- **Schedules**: the job's schedules (ID, name, enabled, description, jobs in schedule), New…, Pick… (shared schedules from
  `sp_help_schedule`), Edit…, Remove (detach; delete when no other job uses it, asked as SSMS).
  - Schedule dialog: Name, type (Recurring, One time, Start automatically when SQL Server Agent starts, Start whenever the
    CPUs become idle where the gates allow), frequency (daily / weekly days / monthly day-or-relative), daily frequency
    (once / every n hours-minutes-seconds between times), duration, Jobs in Schedule, and SSMS's live **Description**
    sentence. The sentence and the `sysschedules` encoding live in `src/shared/agent/schedule.ts`, pure, with table tests
    against SSMS's own sentences.
- **Alerts**: alerts that run this job (Add opens New Alert with the job preset, Edit, Remove).
- **Notifications**: E-mail / Page / Net send operator with When (succeeds, fails, completes), Write to the Windows
  Application event log, Automatically delete job. Kinds the platform gates refuse are disabled with the reason.
- **Targets**: "Target local server" only in 0.10.0; multi-server (MSX/TSX) targets are later and shown disabled.

## Job Activity Monitor and history

**Job Activity Monitor** is its own document (as SSMS), opened from its tree node, either running-jobs chip, the Agent
node's menu and the palette.

- Live source `agent.jobs` (scope server, the " - Activity Monitor" pool in master, its prologue and gates), probe
  `agent.jobs.list`, run by `AgentReader`: one snapshot table keyed by `job_id` with SSMS's columns (Name, Enabled,
  Status, Last Run Outcome, Last Run, Next Run, Category, Runnable, Scheduled, Category ID) plus the current step, and a
  tone column (failed → error, executing → accent, between retries → warning, disabled → muted). Series: running, failed in
  the last 24 h. Read through `sp_help_job` with no arguments (one result set, role-filtered); a sysadmin path over
  `sysjobs`/`sysjobactivity`/`sysjobservers` only if measurement shows `sp_help_job` too slow.
- Agent stopped (from `explorer.agentService`): Status reads "Agent stopped" for every row, Next Run is marked as not
  current (Agent refreshes `sysjobschedules` about every 20 minutes and not while stopped), and a warning banner offers
  Start Agent… to sysadmin; never an error banner. What `sp_help_job` returns while stopped is verified in AG-0.
- Rendered through `LiveGrid` (the same grid components as Results), with view chips (All, Running, Failed, Disabled), the
  filter box, column value filters (in backend memory over the sample, as Activity's), row actions and multi-select (Start,
  Stop, Enable, Disable, View History, Properties). SSMS's Filter Settings dialog maps onto these filters; refresh interval
  comes from the live catalogue's interval bounds. `LiveService` pauses it while hidden.
- Times are SQL Server's local time, as `sysjobhistory` and `sysschedules` store them: the catalogue decodes `run_date`
  (yyyymmdd), `run_time` (hhmmss) and `run_duration` (hhmmss with hours past 99) with table tests, and column headers say
  "(server time)" when the server's offset differs from this computer's.
- Relation to Activity Monitor: separate document, shared machinery. Later: the Sessions pane names the job behind
  `SQLAgent - TSQL JobStep (Job 0x… : Step n)` with a "Go to job" link.

**View History / Log File Viewer** is one document for job history and Agent error logs (later also SQL Server logs and
Database Mail logs, which SSMS shows there).

- Left: log sources with checkboxes (Job History › each job; SQL Server Agent › Current, Archive #n). Right: the runs grid,
  the selected run's steps grid, then a details pane (the full message).
- Runs: `sysjobhistory` has no run id. Agent writes each step's row as the step ends and the job outcome (step 0) row last,
  with the highest `instance_id` of the run. A run is a job's step 0 row plus the step rows with `instance_id` after that
  job's previous step 0 row; step rows after the job's latest step 0 row form an **In progress** run (outcome "In progress",
  no duration yet) while the job runs. The grouping is one pure function with table tests and a live check against a
  running `WAITFOR` job.
- Live source `agent.history`, run by `AgentReader`, modelled on `ssis.operations`: args are the filters (jobs, outcome,
  date window, message text, step; bounded: at most `agentLimits.historyJobs` job ids, text at most
  `agentLimits.searchChars`), rows newest first. Sysadmin path: `sysjobhistory` above an `instance_id` watermark with the
  same settle rule (an identity is assigned before its row commits) and departed rows when history is purged. Role path:
  `sp_help_jobhistory` (which has no `instance_id` lower bound) re-reads the window each sample at a slower interval, capped
  at `agentLimits.historyRows` with explicit truncation. Message text in the grid is cut to a catalogue limit; the details
  pane reads the full text through `agent.historyMessage`.
- Delete history: `sp_purge_jobhistory` (Operator or sysadmin) from the Log File Viewer and the job's menu, behind a
  confirmation naming the job(s) and that it cannot be undone.
- Agent error logs: `xp_readerrorlog <n>, 2` with the search text as its parameters, sysadmin only. It cannot page, so
  `AgentReader` reads at most `agentLimits.logRows` rows, cancels the rest and says so. Same grid, filters and export (Copy
  / Save through `ResultTextWriter`). Recycle: `sp_cycle_agent_errorlog`, behind a confirmation.
- Empty states: "No history for the selected jobs in this window", "This job has never run", "Agent keeps no history" (when
  history is off in Agent Properties).

## Alerts, operators, proxies, credentials, schedules, error logs, Database Mail

| Area | 0.10.0 | Later |
| --- | --- | --- |
| Shared schedules | Schedule dialog, Pick, Jobs in Schedule, Manage Schedules (delete unused) | |
| Job categories | Category picker | Manage Job Categories dialog |
| Operators | List, New / Properties (General: name, enabled, e-mail, pager and on-duty schedule; Notifications: alerts and jobs; History), Enable/Disable, Rename, Delete, Script As | Fail-safe operator (Agent Properties › Alert System) |
| Alerts | List, New / Properties (General: SQL Server event by error number or severity with database and message text; performance condition with object, counter and instance from `sys.dm_os_performance_counters` when the login has VIEW SERVER STATE, typed otherwise; Response: run job, notify operators; Options: include error text, delay between responses), Enable/Disable, Rename, Delete, Script As | WMI event alerts editable (shown read-only) |
| Proxies | List by subsystem, New / Properties (General: name, credential, description, subsystems from `syssubsystems`; Principals; References), Rename, Delete, Script As | |
| Credentials | New Credential and Credential Properties on the existing Security › Credentials folder (kind `credential`) and from the Proxy dialog: name, identity, secret, encryption provider | |
| Error logs | List, view in Log File Viewer, Recycle | Configure (log path, level) via Agent Properties › General |
| SQL Server Agent Properties | General (auto restart SQL Server, auto restart Agent, error log file read-only), History (max rows, per job, remove older than) | Advanced, Alert System (mail profile, fail-safe), Job System, Connection |
| Agent service | State and chips; Start / Stop / Restart | |
| Database Mail | Readiness from `Database Mail XPs` and `sysmail_profile` (sysadmin or DatabaseMailUserRole; others see no warning): warn on e-mail notifications when not set up | Configuration wizard and Database Mail log |
| Multi-server (MSX/TSX) | Targets page shows local only | Multi-server administration |
| Script Action to Job | | The "Agent Job…" Script As destination and dialogs' "Script Action to Job" |

## SQL rules

- **Reads** (tree, describe, history, Job Activity Monitor, chips): constant text per query, band and role path, values as
  parameters, `READ UNCOMMITTED`, each pool's `LOCK_TIMEOUT`, no metadata built-ins beyond the capability read's.
  `AgentReader` (`Agent/AgentReader.cs`) runs Agent's live probes and role-path listings statement by statement (a
  statement the login may not run fails alone), and its lint, `AgentSql.LintRead`, is a new rule: it is `LiveSql.Lint`'s
  rules plus one exemption, a statement may be exactly `EXEC msdb.dbo.<procedure> @arg = @param, …` for a procedure in
  `AgentSql.ReadProcedures` (`sp_help_job`, `sp_help_jobhistory`, `sp_help_jobstep`, `sp_help_jobschedule`,
  `sp_help_schedule`, `sp_help_category`, `sp_help_operator`, `sp_help_alert`, `sp_help_notification`, `sp_help_proxy`,
  `sp_enum_proxy_for_subsystem`, `sp_enum_login_for_proxy`, `sp_help_jobs_in_schedule`) or `master.dbo.xp_enumerrorlogs` /
  `xp_readerrorlog`. `LiveSql.Lint`, `CatalogSql.Lint` and `ActivitySql`'s lint stay as they are. `INSERT … EXEC` is never
  used (`sp_help_job` nests one itself); results are read into backend memory, capped, and paged or filtered there. Describe
  reads go through `actions.describe` on the action read connection (`LOCK_TIMEOUT 10000`), as other object dialogs.
- **Writes**: inside `ActionService` (its own unpooled, never-retried connection, preflight in the same connection, Stop,
  `LOCK_TIMEOUT -1`, reader-only execution, no logging), templates in `Agent/AgentSql.cs` checked by
  `AgentSql.LintExecutable`, which `ActionSql.Lint` chains as it does `LoginSql`. Every call is
  `EXEC @rc = msdb.dbo.<allowlisted procedure> @arg = @param, …;` followed by
  `IF @@ERROR <> 0 OR @rc <> 0 THROW 50xxx, N'<constant>', 1;`: msdb's Agent procedures mostly fail with `RAISERROR` and
  `RETURN 1`, which `XACT_ABORT` does not stop, so without the check a failed `sp_add_jobstep` would let the batch commit
  a half-made job. A job save runs in one transaction; a live check makes a middle step fail and proves nothing commits.
  Names never enter SQL text, so no `QUOTENAME` is needed; no dynamic SQL; no literals but constants. Live checks prove
  hostile names (`]`, `'`, `--`, Unicode, 128-character names) round-trip, and that Script Action's script, run, builds the
  same job as the action (as Login's checks phrase it).
- **Credentials** are server DDL, not msdb procedures: `CREATE CREDENTIAL` and `ALTER CREDENTIAL` templates in
  `Actions/CredentialSql.cs`, checked by its own lint chained from `ActionSql.Lint`, built as LoginSql builds logins: the
  name through server-side `QUOTENAME`, identity as a parameter quoted on the server, the secret only as `@secret` behind a
  NULL guard through a binary-collation `REPLACE`, never a literal. The secret lives only in `ObjectDialogService`'s secret
  slot (its `SecretState` generalised from New Login's to a named secret), travels only in the sensitive
  `actions.execute`, is scrubbed from replies, and Script writes `<secret>`.
- **Service control**: `EXEC @rc = master.dbo.xp_servicecontrol @action, @service;` with `@action` in `N'Start'`, `N'Stop'`
  and `@service` the Agent's service name read from `sys.dm_server_services` (`SQLSERVERAGENT`, or `SQLAgent$<instance>`
  for a named instance) and passed as a parameter. Restart is Stop, a wait for the state probe to read stopped (bounded,
  Stop-able), then Start. Sysadmin and Windows box servers only, confirmation first, through ActionService. "Access is
  denied" (the engine's virtual account may lack the right on the Agent service) is a `PERMISSION_DENIED` value with a
  sentence naming the account. AG-0's spike proves it on default virtual accounts and a named instance; if it cannot work
  there, the lane comes back to the owner.
- **Script As**: SMO through `ScriptPipeline`. `UrnBuilder` gains JobServer children (`Server/JobServer/Job[@Name=… and
  @CategoryID=…]`, `Alert`, `Operator`, `ProxyAccount`), the scripting catalogue gains rows and preflight ids (the job
  preflight reads `category_id` from `sysjobs_view`), never executing, `HeaderGuard` applied. AG-4 verifies SMO can script a
  job for a SQLAgentUserRole login, and if not, Script As is sysadmin/Operator-only for Agent kinds with the reason shown.
- Never log job, step, schedule, operator, alert, proxy or credential names, commands, messages, secrets or SQL.

## Backend methods (the five places)

Each new method goes in `RpcMethods`, a strict zod schema, `methodPolicies`, the preload, and `SqlService.DispatchAsync` with
its `MethodNames` entry and C# record; string inputs get max lengths in both zod and C#.

| Method | Purpose | Policy notes |
| --- | --- | --- |
| `agent.profile` | Capability read (roles, server state, Database Mail access, platform, Agent state) | Metadata slot, short deadline |
| `agent.historyMessage` | One history row's full message (`instance_id`) | Metadata slot |
| `agent.errorLogs` | Error log list (`xp_enumerrorlogs 2`) for the Log File Viewer's sources | Metadata slot |
| Existing `actions.describe` / `actions.execute` | Job, alert, operator, proxy, credential, schedule, Agent Properties describes and every write, service control included | As other object actions; credential execute is sensitive |
| Existing `explorer.*`, `live.subscribe` | Agent kinds and the `agent.jobs`, `agent.history`, `agent.treeProbe`, `explorer.agentService` sources | Live args bounded in the live catalogue's schemas |

Error codes: new action code `STALE`; everything else reuses `NOT_FOUND`, `PERMISSION_DENIED`, `NOT_SUPPORTED`,
`NAME_IN_USE`, `IN_USE`. docs/ipc.md lists them (its lint checks).

## Catalogue

`src/shared/agent/catalog.ts`, the single declaration of Agent semantics: code tables (run status, execution status,
step subsystems and their SSMS names, on-success/failure actions, schedule frequency types and intervals, notify levels,
alert types), platform gates, time and duration decoding, Job Activity Monitor and history columns and tones, history run
grouping, `AgentSql.ReadProcedures`, documents, limits (`agentLimits`), embedded by the backend as
`Agent/agent-catalog.json` and generating the reference part of docs/sql-server-agent.md with
`npx vitest run tests/agent-catalog.test.ts -u` (a new row in CLAUDE.md's generated-files table). Tree kinds stay in the
explorer catalogue; verbs and dialogs in the actions catalogue (regenerated with its test); live sources in the live
catalogue; commands in the commands catalogue; icons in `icons.ts`.

## Testing

- **CI**: add `MSSQL_AGENT_ENABLED: 'true'` to the three `mssql/server:2022-latest` services in `.github/workflows/ci.yml`
  (pinned by `tests/ci-workflow.test.ts`) and to `.claude/hooks/session-start.sh`'s `docker run`, and set
  `VARIA_TEST_SQL_AGENT=1` in both. Agent starts after the container's `SELECT 1` health check passes, so Agent suites wait
  on a condition (a `SQLAgent - %` session or a new `syssessions` row) with a generous timeout that returns early, then
  fail if Agent never came up. The existing `ExplorerStatusLiveChecks` Agent check gates on `sys.dm_server_services`; AG-0
  makes it use the same Agent-up condition so it stops skipping silently on Linux. Linux Agent runs T-SQL steps only, so
  CmdExec, PowerShell and SSIS steps are covered by offline lint and script tests in CI and by live checks on the owner's
  Windows server.
- **`VARIA_TEST_SQL_AGENT=1`** (new, docs/testing.md): Agent live suites require Agent and fail if it does not come up;
  without the variable they skip with one line saying why. Tests never start or stop the service, except an opt-in
  `VARIA_TEST_SQL_AGENT_SERVICE=1` check of service control on a disposable server.
- **Scratch objects**: Agent objects are server-level, in msdb. Scratch jobs, schedules, operators, alerts and proxies are
  named `VariaScratch_<run>_…`, carry `ScratchDatabase.JobMarker` (description) where the object has one, are dropped in
  `finally`, and are swept by name pattern, marker and age through `ScratchDatabase`'s existing job sweep, extended to the
  other Agent kinds (no second mechanism). No scratch category is created (a shared category could not be dropped while
  another run uses it). Credentials and their logins are dropped with their run; a role check drops jobs its login owns,
  then its msdb user, then the login. A check of Agent Properties' writes (server-wide) restores the old values in
  `finally`. Scratch job runs add rows to Agent's server-wide history cap (default 1,000), pushing out the oldest rows of
  real jobs on a shared server: suites keep runs few (one `WAITFOR` job per suite), and docs/testing.md says so.
- **Live suites** (each with its seconds in `LiveGroups.Suites` and docs/ci.md's table): `Agent` (tree, capability, both
  read paths with low-privilege SQL logins in each Agent role), `AgentJobs` (a scratch job with a `WAITFOR DELAY` T-SQL
  step: start at step, stop, enable/disable, status transitions through the live source, the In progress run and its
  grouping, waits on conditions only), `AgentActions` (every write template against hostile names, Script Action's script
  builds the same object, identity and `STALE` guards with two sessions editing one job, a failing middle step commits
  nothing), `AgentScripting` (SMO scripts vs SSMS goldens in `tests/fixtures/scripting/`), `AgentCredentials` (secret never
  in a reply or script, hostile names).
- **Offline**: `AgentSql.LintRead`, `LintExecutable` and `CredentialSql` lints render every variant; schedule encoding and
  sentence table tests; history grouping and time decoding table tests; catalogue snapshot; zod/C# limit mirrors.
- **Renderer vitest** with fixtures for states the live smoke cannot reach: each Agent role, Managed Instance, Linux,
  Express, Agent stopped, state unknown, `PERMISSION_DENIED` mid-dialog, `STALE`, empty history.
- **Smoke**: `scripts/agent-smoke.mjs` on the fake backend (tree, Job Activity Monitor grid, job dialog round trip, Log File
  Viewer), surfaces found by ARIA role and name through `scripts/fixtures/ui.mjs`, added to `test:smoke`,
  `smoke-shards.mjs`'s times and docs/ci.md's table. Shards with a SQL Server gain the Agent node in their trees; AG-1
  updates the explorer smoke's expectations.

## Lanes

Ordered; lanes on the same line can run in parallel once their dependency lands. Sizes are rough (S < 1 day of agent
work, M, L). **Every lane's definition of done** includes its part of docs/sql-server-agent.md, README where users see a
change, CHANGELOG.md's Unreleased summary, and its Getting Started guide/sample impact or a concrete no-impact reason, as
CLAUDE.md requires.

| Lane | Scope | Depends on | Size |
| --- | --- | --- | --- |
| AG-0 | Foundations: `src/shared/agent/catalog.ts` (code tables, gates, decoding, limits, docs generation), `agent.profile` and `agentRole` keys, `AgentReader` + `AgentSql.LintRead`, CI `MSSQL_AGENT_ENABLED` and the Agent-up wait, `VARIA_TEST_SQL_AGENT`, scratch sweep extension, Agent live suite skeleton; spikes on a disposable server: `sp_help_job` while stopped, `xp_servicecontrol` on virtual accounts and a named instance, Linux DMV | — | M |
| AG-1 | Object Explorer: Agent node and folders, both listing paths, edition and platform gates (`ExplorerProfile` edition and platform), platform-gate verification, `explorer.agentService`, Agent node chips and the role band of `explorer.agent`, `agent.treeProbe`, Search Objects batch, icons, menus with not-yet verbs hidden | AG-0 | M |
| AG-2 | Job verbs: Start Job at Step (single and multi with Start Jobs progress), Stop, Enable/Disable, Rename, Delete; `AgentSql.LintExecutable` with return-code checks and the identity guard; Agent service Start / Stop / Restart; status-bar running job | AG-1 | M |
| AG-3 | Job Activity Monitor: `agent.jobs` live source, document with LiveGrid, tiles, view chips, filters, multi-select row actions, Agent-stopped state, server-time labels | AG-1 (AG-2 for actions) | M |
| AG-4 | Script As for Job, Alert, Operator, ProxyAccount (UrnBuilder JobServer children, scripting catalogue rows, goldens, role check) | AG-1 | S |
| AG-5a | Log File Viewer: `agent.history` live source (both paths), run grouping with In progress, master/detail grids, details pane, `agent.historyMessage`, purge history | AG-1 | M |
| AG-5b | Agent error logs in the Log File Viewer: `agent.errorLogs`, `xp_readerrorlog` capped reads, Recycle | AG-5a | S |
| AG-6a | Job dialog shell: describe, General, Notifications, Targets (local), Alerts list, one-transaction save with `STALE`, Script Action, New Job | AG-2 | M |
| AG-6b | Steps page and step dialog (T-SQL with editor features and Parse, CmdExec, PowerShell, SSIS package, Advanced) | AG-6a | L |
| AG-6c | Schedules: `schedule.ts` encoding and sentences, schedule dialog, Pick, Jobs in Schedule, Manage Schedules | AG-6a | M |
| AG-7 | Operators and Alerts: dialogs (all pages), Enable/Disable, Rename, Delete; performance counter picker; Database Mail readiness warning | AG-1, AG-6a (shared dialog parts) | M |
| AG-8a | SQL Server Agent Properties (General, History) | AG-1 | S |
| AG-8b | Proxies: New / Properties (General, Principals, References), Rename, Delete; New Credential and Credential Properties (`CredentialSql`, generalised secret slot) | AG-1, AG-6a | M |
| AG-9 | Getting Started guide and sample for Agent, parity re-check of the Agent rows | all | S |
| Later | Manage Job Categories, multi-server targets, Script Action to Job, output file and table log viewers, Activity Monitor job links, SQL Server Logs and Database Mail in the Log File Viewer, Agent Properties' remaining pages and fail-safe operator, WMI alert editing, Elastic Jobs | | |

Suggested waves: AG-0 → AG-1 → {AG-2, AG-4, AG-5a, AG-8a} → {AG-3, AG-5b, AG-6a} → {AG-6b, AG-6c, AG-7, AG-8b} → AG-9.
Lanes that touch the Agent tree menus or the actions catalogue (AG-2, AG-6a, AG-7, AG-8a, AG-8b) merge main in after each
lands, as the Activity Monitor lanes did.

Coordination with BigQuery: AG-1 and BQ-5 both extend `src/shared/explorer/catalog.ts` and its generated
docs/object-explorer.md and `explorer-catalog.json`. Land AG-1 before BQ-5 starts, or rebase whichever is second; neither
needs the other. BQ-0's `providers` default covers Agent's entries whichever lands first.

## Questions still open

None blocking. AG-0's spikes (`sp_help_job` while stopped, `xp_servicecontrol` on default accounts and named instances,
the Linux DMV) and AG-1's platform-gate verification report back in their PRs; if service control cannot work on default
accounts, that comes back to the owner before AG-2 merges.
