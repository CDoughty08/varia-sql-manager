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
  `VARIA_TEST_SQL_AGENT=1` checks (CmdExec, PowerShell and SSIS steps included) run locally. That instance exists only
  for testing Varia, so checks may also stop and start its Agent (opt-in `VARIA_TEST_SQL_AGENT_SERVICE=1`).
- **Service control in CI**: a Windows CI job installs SQL Server with Agent and checks Start, Stop and Restart for real,
  but runs **only when needed**: on pull requests and main pushes that touch the service-control paths, and on manual
  runs, never on unrelated PRs (Testing).
- **Parity additions** (round 2): the Agent node's **New ›** submenu (Job, Operator, Alert, Proxy, Schedule), and
  Delete History's **"older than"** option, both must-ship.
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
- `sys.dm_server_services.servicename` holds the display name only ("SQL Server Agent (MSSQLSERVER)"); no column holds
  the service key. The Agent service account is `NT Service\SQLSERVERAGENT`; the engine's is `NT Service\MSSQLSERVER`.
  `xp_servicecontrol N'QueryState', N'SQLServerAgent'` answered "Running." as sysadmin: the constant name, not a key read
  from the DMV, is what service control passes. Start and Stop were not tried.
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

From Microsoft's documentation (re-checked in AG-0 and AG-1, never assumed):

- `ALTER CREDENTIAL` resets both the identity and the secret: a statement without `SECRET` sets the stored secret to NULL.
- `sys.dm_os_host_info` does not exist on SQL Server 2016; Varia's existing Linux flag (from the path separator) is used
  instead.
- Managed Instance does not support Agent alerts, proxies, CPU-idle schedules, enabling or disabling Agent, or changing
  Agent properties; credentials cannot use a Windows identity; e-mail notifications need the Database Mail profile named
  `AzureManagedInstance_dbmail_profile`; Microsoft points to `sp_readmierrorlog` for its error log.
- `sp_purge_jobhistory` with no job argument purges every job's history on the server.
- On SQL Server 2022 and later `sys.dm_server_services` may need VIEW SERVER SECURITY STATE rather than VIEW SERVER STATE
  (AG-0 probes it with a low-privilege login).

Still to verify in AG-0 on the owner's test instance (its Agent may be stopped by checks) and in the Windows CI job: what
`sp_help_job` and `xp_sqlagent_enum_jobs` return while Agent is stopped; that `xp_servicecontrol N'Start'|N'Stop',
N'SQLServerAgent'` works under the default virtual accounts and for a named instance (the CI job installs one); the error
number of its "Access is denied"; which msdb calls bump `sysjobs.version_number` and `sysschedules.version_number`; the
msdb error numbers the action mapping needs; and what the Linux container's `sys.dm_server_services` lists.

## Servers and platform gates

| Server | Agent node | Notes |
| --- | --- | --- |
| SQL Server 2016-2025, Windows (EngineEdition 1-3) | Shown | Full feature set. Start/Stop/Restart only here, and not on a failover cluster instance (`SERVERPROPERTY('IsClustered') = 1`), where the cluster owns the service. |
| SQL Server on Linux | Shown | Agent must be enabled (`MSSQL_AGENT_ENABLED=true` or `mssql-conf set sqlagent.enabled true`). No service control from T-SQL. Feature gates below. |
| Express (EngineEdition 4) | Hidden | No Agent service; SSMS hides the node too. |
| Azure SQL Managed Instance (8) | Shown | Agent always runs; no Start/Stop/Restart. No Alerts or Proxies folders. Feature gates below. |
| Azure SQL Database, Synapse, Fabric, Edge (`cloud`) | Hidden | No Agent. Elastic Jobs is a different product and out of scope. |

Platform feature gates live in the Agent catalogue (`agentPlatformGates`), one row per feature: Alerts folder and the job
dialog's Alerts page, Proxies folder, alert types (event, performance condition, WMI), schedule types (CPU idle),
notification kinds (e-mail, pager, net send), event log notification, error logs (and which reader), Agent Properties
writes, Windows-identity credentials, service control. Initial values from Microsoft's documentation:

- **Linux**: no proxies, no CmdExec/PowerShell/SSIS steps, no WMI alerts, no event log notification, no service control.
- **Managed Instance**: no alerts (folder, job Alerts page, notifications from alerts), no proxies, no CPU-idle schedules,
  Agent Properties read-only, no Windows-identity credentials, e-mail only through Database Mail with the profile
  `AzureManagedInstance_dbmail_profile` (the readiness warning checks for that name), no pager or net send, error log through
  `sp_readmierrorlog` (an allowlisted read) instead of `xp_readerrorlog`.

They are **verified in AG-1**, Linux against the CI container, Managed Instance from its documentation, and recorded in
docs/sql-server-agent.md. The tree, dialogs and menus read the gates; nothing hard-codes a platform.

Edition gating reuses what exists: C# `ExplorerProfile` already carries `Linux` and `ManagedInstance`, `ServerProfile`
detects Linux from the path separator (so 2016 works), and the connection info already carries `EngineEdition` and
`Linux`. The TS `ExplorerProfile` gains only the engine edition, and `FolderSpec` gains `editions`/`platforms` gates that
`folderServed` and its C# mirror (`Served`) check; docs.ts's literal profile passed to `folderServed` gains the field.
`IsClustered` joins the capability read. Agent nodes are SQL Server only; when
BigQuery's BQ-0 adds `providers` to catalogue entries, Agent's take the default `['sqlserver']`, and a BigQuery handle on an
Agent method answers BQ-0's `UNSUPPORTED_PROVIDER` (planned in #528).

## Permissions and how the UI degrades

A capability read (one constant batch, msdb through `msdb.sys.sp_executesql`, as the explorer's per-database batches; the
same built-ins the SSIS profile and live session probe already use) reads `IS_SRVROLEMEMBER(N'sysadmin')`,
`IS_ROLEMEMBER` for the three Agent roles, `HAS_PERMS_BY_NAME` for VIEW SERVER STATE (and VIEW SERVER SECURITY STATE on
2022+, if AG-0 shows `sys.dm_server_services` needs it; the live catalogue then gains a matching permission kind for
`explorer.agentService`), `ALTER ANY CREDENTIAL`, `SERVERPROPERTY('IsClustered')`, the `Agent XPs` value from
`sys.configurations`, and whether Database Mail can be read. It is cached per connection and re-read on Refresh, and drives
the tree, the menus (target-scoped context key `agentRole`: `sysadmin | operator | reader | user | none`, plus
`explorerSelectionAgentRole`) and the read path.

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
VIEW SERVER STATE shows no state chip; Database Mail readiness without access shows no warning. Credential dialogs (AG-8b)
need `ALTER ANY CREDENTIAL` and only add verbs to the existing Security › Credentials folder; they never hide that folder,
whether AG-8b has landed or not.

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
  filters it there; `CatalogSql` stays free of `EXEC`. Error logs list through `xp_enumerrorlogs 2` (sysadmin; on Managed
  Instance the gate picks `sp_readmierrorlog`).
- `AgentReader` (`Agent/AgentReader.cs`) is a shared statement runner, not a service: given a connection it runs
  `AgentSql.LintRead`-checked statements one at a time (a statement the login may not run fails alone) and reads capped
  results into memory. Each caller keeps its own pool, connection and prologue: Object Explorer listings and Search
  Objects on theirs, `actions.describe` on the action read connection, and live sources through a thin `ILiveSqlReader`
  adapter.
- Agent state: a new `explorer.agentService` probe in the `explorer` live source (added to `liveProbeIds` and the source's
  probe list), `permission: 'serverState'` (or the 2022+ security-state kind, AG-0), reads `sys.dm_server_services`
  (`servicename LIKE N'SQL Server Agent%'`, as `ExplorerStatusLiveChecks` does) and, where the DMV has no Agent row (Linux,
  to verify), an Agent session (`program_name LIKE N'SQLAgent - %'`) in `sys.dm_exec_sessions`. Without the permission the
  state is unknown and no state chip shows. Managed Instance is always running.
- The `explorer` live source gains a reader: `LiveService.CreateSampler` today hands an `ILiveSqlReader` only to the
  Activity Monitor source, so it also gives the `explorer` source the `AgentReader` adapter for `explorer.agent`'s role
  path. `explorer.agent` gains a **role path** (not a version band): sysadmin keeps today's direct `LiveSql` statement;
  other logins run `sp_help_job` through the adapter, counting `current_execution_status` in 1, 2, 3, 7, so the count is
  the jobs the login may see. The session probe's role read picks the path.
- Chips: `statusChipKinds` gains `agent: ['explorer.agentService', 'explorer.agent']`; `server` keeps `explorer.agent`.
  Both running-jobs chips read the one sample. Job rows show state chips (Running · step n/m, Failed, Between retries) from
  `agent.jobs` while the Jobs folder is open. Chips never reload the tree.
- A live change source `agent.tree` with probe `agent.treeProbe` (as source `ssis.catalog` has probe `ssis.catalogProbe`):
  row count and checksum of the columns the tree shows. Sysadmin computes them in SQL; the role path cannot (`INSERT …
  EXEC` is never used), so the backend computes them from the capped `sp_help_job` read. It reloads only changed folders,
  keeping expansion and selection, while an Agent folder is open.
- Search Objects indexes Agent kinds in a separate server batch (`ObjectSearchSql.Agent`, through `AgentReader` for the
  role path), so a refusal skips only Agent kinds; Ctrl+Q finds a job and opens its Properties.
- Menus (SSMS names, catalogue entries in `src/shared/commands/catalog.ts`): Agent node: **New ›** (Job…, Operator…,
  Alert…, Proxy…, Schedule…; each item appears once its lane lands and where the gates and role allow), Start, Stop,
  Restart, Job Activity Monitor, View History, Properties, Refresh. Jobs folder: New Job…, Manage Schedules, View History,
  Filter, Refresh. Job: New Job…, Start Job at Step…, Stop Job, Script Job as ›, View History, Enable, Disable, Rename,
  Delete, Refresh, Properties (no Delete History, as SSMS; history is deleted from the Log File Viewer). Alerts, Operators:
  New…, Enable/Disable, Script as ›, Rename, Delete, Refresh, Properties. Proxies: New Proxy…, Script as ›, Rename, Delete,
  Properties. Error Logs: View Agent Log, Recycle, Refresh. Palette: "SQL Server Agent: Job Activity Monitor", "SQL Server
  Agent: New Job". Verbs a login cannot use on an object it sees are disabled with the reason; verbs of a lane not yet landed
  are hidden.

## Jobs

Identity and concurrency: refs carry the name. Describe returns `job_id`, `date_created`, `date_modified` and
`version_number`. Every write binds `@job_id` and first checks, in its batch, that the job still has that name and
creation date (else `NOT_FOUND` through the existing THROW 50010, as Delete Database's check answers). Properties saves
also check that the job's `version_number` and `date_modified` are unchanged, and so are the `version_number` and
`date_modified` of every schedule the dialog edits (`sysschedules`; a shared schedule is its own row, which another job's
dialog can change), else they THROW 50011, which maps to action code `STALE` with the message "Changed by someone else since
it was opened. Reload to see the changes." `STALE` already names the shortcuts save in docs/ipc.md; the action code reuses
the name with its own message per context (docs/ipc.md's table gains the action row) and is **not retryable**, since the
same save always fails again and Reload is the only remedy. Which msdb calls bump which `version_number` is verified in
AG-0 by a live check; alert links (`sysalerts.job_id`) are outside the guard and the Alerts page re-reads them on save.
Guards read `sysjobs_view` and `sysschedules_localserver_view` (readable by every Agent role). Alerts, operators and
proxies are unique by name; their writes check by id the same way. Schedules are identified by `schedule_id` (names are
not unique).

Error mapping: `ActionErrors.CodeOf` maps the first error's number, and in a failed call that is msdb's own `RAISERROR`,
which arrives before the template's THROW. So `ActionErrors.Numbers` gains msdb's numbers, each probed in AG-0 and covered
by a mapping test: candidates are 14261 (name already exists → `NAME_IN_USE`), 14262 (does not exist → `NOT_FOUND`), the
ownership and proxy-access refusals such as 14525 (→ `PERMISSION_DENIED`), a schedule still in use (→ `IN_USE`), and
22022, "SQLServerAgent is not currently running" from `sp_start_job` (→ a new action code `AGENT_STOPPED`, "SQL Server Agent
is not running. Start it, then try again.", not retryable). Each THROW in a template carries the call's index as its
state (1-255, a constant), so C# reads the msdb number from the first error and the index from the THROW and the dialog
says which part was refused ("Saving step 2 'Rebuild' was refused: …").

Verbs (all via ActionService, see SQL rules):

| Verb | msdb procedure | Notes |
| --- | --- | --- |
| Start Job at Step… | `sp_start_job @job_id, @step_name` | Dialog lists steps when the job has more than one, as SSMS. From Job Activity Monitor with several jobs selected (AG-3), SSMS's Start Jobs progress dialog lists one line per job. |
| Stop Job | `sp_stop_job @job_id` | Several selected (AG-3): one line per job, as Start. |
| Enable / Disable | `sp_update_job @job_id, @enabled` | Multi-select in Job Activity Monitor; single in the tree. |
| Rename | `sp_update_job @job_id, @new_name` | Inline rename like other kinds. |
| Delete | `sp_delete_job @job_id, @delete_history, @delete_unused_schedule` | Delete Object dialog; both options shown and on by default, as SSMS passes both as 1. |
| New Job / Properties | `sp_add_job`, `sp_update_job`, `sp_add_jobstep`, `sp_update_jobstep`, `sp_delete_jobstep`, `sp_add_jobschedule` / `sp_attach_schedule` / `sp_detach_schedule`, `sp_add_jobserver`, `sp_update_job` notification arguments | One transaction, each call's return code checked (SQL rules); Script Action shows SSMS's `BEGIN TRANSACTION … QuitWithRollback` shape with literals, as Login's does. |
| Script Job as › CREATE / DROP / DROP And CREATE To › New Query, File, Clipboard | SMO `Server/JobServer/Job[@Name and @CategoryID]` through `ScriptPipeline` | Also Alert, Operator and `ProxyAccount`. Never executes. |

Status bar (AG-3): a job this window started shows "Index maintenance: running step 2 of 4" with Stop in the status bar
until it ends. Background views pause when Object Explorer or the window is hidden and yield their slot, and table probes
stop under `whileHidden: 'statusOnly'`, so this uses a table-less probe: `agent.jobs.watched`, one series per watched job
(execution status, current step, step count), args the watched job ids (at most `agentLimits.watchedJobs`). The status bar
owns the view (window-scoped, `whileHidden: 'statusOnly'`, as a running query's status is kept), holds it only while a
watched job runs, and never polls; it does not depend on Job Activity Monitor or Object Explorer being open.

Job dialog pages (`ObjectDialog` with pages, as Login and Database Properties; describe through `actions.describe`). Describe
reads use the role path where the login cannot read the tables: `sp_help_job @job_id` (several result sets),
`sp_help_jobstep`, `sp_help_jobschedule`, all in `AgentSql.ReadProcedures` and checked by `AgentSql.LintRead`; AG-6a has a
live check that a SQLAgentUserRole login opens and saves its own job:

- **General**: Name, Owner (picker; sysadmin only), Category (from `sp_help_category`; Manage Job Categories is later),
  Description, Enabled, plus the read-only Created / Modified / Last executed facts.
- **Steps**: grid of steps (order, name, type, on success, on failure), New / Insert / Edit / Delete / Move up / Move down,
  Start step. Deleting a step another step jumps to asks first and changes those to "Quit the job reporting failure", as
  SSMS does (mocked).
  - Step dialog **General**: Step name, Type (from `syssubsystems`, filtered by the platform gates and what the login can
    run), Run as (proxies the login may use for that subsystem through `sp_help_proxy @subsystem_name`, which for a
    non-sysadmin returns only proxies granted to it; sysadmin also gets "SQL Server Agent Service Account"), Database
    (T-SQL), Command in a Monaco editor (T-SQL gets the query editor's language features;
    Parse uses the language service's parse, never executes), Open… loads a local file through main's dialog.
  - Step dialog **Advanced**: On success / On failure action (next step, quit reporting success/failure, go to step n),
    Retry attempts and interval, Output file (server path through the server file picker) and Append, Log to table, Include
    step output in history, Run as user (T-SQL). SSMS's View buttons for the output file and the table log are later.
  - SSIS steps (in AG-6b): package source (SSIS Catalog / SQL Server / file system), the SSIS Catalog tree reused for picking
    a package, environment reference and parameter overrides as a command line the backend builds; Configuration tab
    subset. CmdExec: command and process exit code. PowerShell: script. A step whose command Varia cannot model keeps it
    as text.
- **Schedules**: the job's schedules (ID, name, enabled, description, jobs in schedule), New…, Pick… (shared schedules from
  `sp_help_schedule`), Edit…, Remove (detach, then offer to delete the schedule; mocked). `sp_help_jobs_in_schedule`
  lists only the login's own jobs for SQLAgentUserRole, so Varia never decides "unused" from it: the delete is
  `sp_delete_schedule` without `@force_delete`, which msdb refuses while any job uses the schedule (mapped to `IN_USE`).
  Jobs in Schedule says "Only your own jobs are listed" for those logins.
  - Schedule dialog: Name, type (Recurring, One time, Start automatically when SQL Server Agent starts, Start whenever the
    CPUs become idle where the gates allow, with a warning that the idle condition is set in Agent Properties › Advanced,
    which Varia does not edit yet), frequency (daily / weekly days / monthly day-or-relative), daily frequency
    (once / every n hours-minutes-seconds between times), duration, Jobs in Schedule, and SSMS's live **Description**
    sentence. The sentence and the `sysschedules` encoding live in `src/shared/agent/schedule.ts`, pure, with table tests
    against SSMS's own sentences.
- **Alerts** (hidden where the gates have no alerts, such as Managed Instance): alerts that run this job (Edit, Remove;
  Add opens New Alert with the job preset and is hidden until AG-7 lands, so the page ships with AG-6a either way).
- **Notifications**: E-mail / Page / Net send operator with When (succeeds, fails, completes), Write to the Windows
  Application event log, Automatically delete job. Kinds the platform gates refuse are disabled with the reason.
- **Targets**: "Target local server" only in 0.10.0; multi-server (MSX/TSX) targets are later and shown disabled.

## Job Activity Monitor and history

**Job Activity Monitor** is its own document (as SSMS), opened from its tree node, either running-jobs chip, the Agent
node's menu and the palette.

- Live source `agent.jobs` (scope server, the " - Activity Monitor" pool in master, its prologue and gates), probe
  `agent.jobs.list`, run by `AgentReader`: one snapshot table keyed by `job_id` with SSMS's columns (Name, Enabled,
  Status, Last Run Outcome, Last Run, Next Run, Category, Runnable, Scheduled, Category ID) plus the current step, and a
  tone column (failed → error, executing → accent, between retries → warning, disabled → muted). Series and tiles come
  from that one read, never from history: Running, Last run failed, Between retries, Disabled (counts of jobs). Read through
  `sp_help_job` with no arguments (one result set, role-filtered); a sysadmin path over
  `sysjobs`/`sysjobactivity`/`sysjobservers` only if measurement shows `sp_help_job` too slow. The table-less
  `agent.jobs.watched` probe (status bar) is in the same source.
- Loading: the grid's skeleton until the first sample. A failed sample keeps the last rows with the live indicator's error
  state and the reason (as Activity Monitor); `PERMISSION_DENIED` replaces the grid with the no-access state. Both mocked.
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
- Runs: `sysjobhistory` has no run id. Agent writes each step's row as the step ends (one row per retry attempt) and the
  job outcome (step 0) row last, with the highest `instance_id` of the run; step 0's `run_date`/`run_time` is the run's
  start. A run is a job's step 0 row plus the step rows with `instance_id` after that job's previous step 0 row **and** a
  start at or after the step 0 row's start. Step rows that match no step 0 row form:
  - an **In progress** run (outcome "In progress", no duration yet) when the job is executing now (from `agent.jobs`) and
    the rows started at or after the current execution's start;
  - otherwise an **Unknown (no job outcome)** run, which is what Agent leaves when it stops or crashes mid-job (Varia's own
    Stop and Restart included).

  The grouping is one pure function with table tests (normal runs, Agent stopped mid-run, a job started at step n, retries,
  two quick runs, a purge that removed a run's step 0 row) and a live check against a running `WAITFOR` job.
- Live source `agent.history`, run by `AgentReader`, modelled on `ssis.operations`: args are the filters (jobs, outcome,
  date window, message text, step; bounded: at most `agentLimits.historyJobs` job ids, text at most
  `agentLimits.searchChars`), rows newest first. Sysadmin path: `sysjobhistory` above an `instance_id` watermark with the
  same settle rule (an identity is assigned before its row commits) and departed rows when history is purged. Role path:
  `sp_help_jobhistory` (which has no `instance_id` lower bound) re-reads the window each sample at a slower interval, capped
  at `agentLimits.historyRows` with explicit truncation. Message text in the grid is cut to a catalogue limit; the details
  pane reads the full text through `agent.historyMessage`.
- Delete History (Operator or sysadmin) from the Log File Viewer's toolbar for the jobs checked in its sources: all their
  history, or only rows **older than** a date (SSMS's option; `@oldest_date`). One `sp_purge_jobhistory @job_id [,
  @oldest_date]` call per job in one transaction. Without a job argument msdb purges every job on the server, so zod and C#
  require 1 to `agentLimits.historyJobs` job ids and the template refuses a NULL `@job_id` before calling. The confirmation
  names the jobs, the cut-off and that it cannot be undone. Server-wide purges exist only in Agent Properties (AG-8a).
- Agent error logs: `xp_readerrorlog <n>, 2` with the search text as its parameters, sysadmin only (Managed Instance:
  `sp_readmierrorlog` per the gates). It cannot page, so `AgentReader` reads at most `agentLimits.logRows` rows, cancels
  the rest and shows a truncation notice (mocked). Same grid, filters and export (Copy / Save through `ResultTextWriter`).
  Recycle: `sp_cycle_agent_errorlog`, behind a confirmation.
- Empty, loading and error states (mocked): "No history for the selected jobs in this window", "This job has never run",
  a skeleton while loading, and a failed read shown in place with its reason and Retry. History is never "off" (an unlimited
  log is still a log), so there is no such state.

## Alerts, operators, proxies, credentials, schedules, error logs, Database Mail

| Area | 0.10.0 | Later |
| --- | --- | --- |
| Shared schedules | Schedule dialog, Pick, Jobs in Schedule, Manage Schedules (delete unused) | |
| Job categories | Category picker | Manage Job Categories dialog |
| Operators | List, New / Properties (General: name, enabled, e-mail, pager and on-duty schedule; Notifications: alerts and jobs; History), Enable/Disable, Rename, Delete, Script As | Fail-safe operator (Agent Properties › Alert System) |
| Alerts | List, New / Properties (General: SQL Server event by error number or severity with database and message text; performance condition with object, counter and instance from `sys.dm_os_performance_counters` when the login has VIEW SERVER STATE, typed otherwise; Response: run job, notify operators; Options: include error text, delay between responses), Enable/Disable, Rename, Delete, Script As | WMI event alerts editable (shown read-only) |
| Proxies | List by subsystem, New / Properties (General: name, credential, description, subsystems from `syssubsystems`; Principals; References), Rename, Delete, Script As | |
| Credentials | New Credential and Credential Properties on the existing Security › Credentials folder (kind `credential`) and from the Proxy dialog: name, identity, secret, encryption provider. `ALTER CREDENTIAL` resets the secret when `SECRET` is omitted, so in Properties the Identity and secret are read-only until "Change identity and secret" is checked, and every ALTER sends both | |
| Error logs | List, view in Log File Viewer, Recycle | Configure (log path, level) via Agent Properties › General |
| SQL Server Agent Properties | General (auto restart SQL Server, auto restart Agent, error log file read-only), History (max rows, per job) through `msdb.dbo.sp_set_sqlagent_properties` (undocumented, what SSMS calls; allowlisted; read-only on Managed Instance). History's "Remove agent history older than" is not a setting: as in SSMS it is a one-shot purge of **all** jobs' history on OK (`sp_purge_jobhistory @oldest_date`, sysadmin), behind its own destructive confirmation | Advanced, Alert System (mail profile, fail-safe), Job System, Connection |
| Agent service | State and chips; Start / Stop / Restart | |
| Database Mail | Readiness from `Database Mail XPs` and `sysmail_profile` (sysadmin or DatabaseMailUserRole; others see no warning; on Managed Instance the profile must be `AzureManagedInstance_dbmail_profile`): warn on e-mail notifications when not set up | Configuration wizard and Database Mail log |
| Multi-server (MSX/TSX) | Targets page shows local only | Multi-server administration |
| Script Action to Job | | The "Agent Job…" Script As destination and dialogs' "Script Action to Job" |

## SQL rules

- **Reads** (tree, describe, history, Job Activity Monitor, chips): constant text per query, version band and role path,
  values as parameters, no metadata built-ins beyond the capability read's. Isolation and lock timeout are each caller's
  own: live probes and listings use their pools' prologues (`READ UNCOMMITTED`); describe reads use the action read
  connection's (`READ COMMITTED`, `LOCK_TIMEOUT 10000`), as other object dialogs. `AgentReader` runs the role-path and
  procedure statements one by one, and every Agent read that `EXEC`s, in any caller (live, listing, Search Objects,
  describe), is checked by `AgentSql.LintRead`, a new rule: `LiveSql.Lint`'s rules plus one exemption, a statement may be
  exactly `EXEC msdb.dbo.<procedure> @arg = @param, …` for a procedure in `AgentSql.ReadProcedures` (`sp_help_job`,
  `sp_help_jobhistory`, `sp_help_jobstep`, `sp_help_jobschedule`, `sp_help_schedule`, `sp_help_category`,
  `sp_help_operator`, `sp_help_alert`, `sp_help_notification`, `sp_help_proxy`, `sp_enum_login_for_proxy`,
  `sp_help_jobs_in_schedule`, `sp_readmierrorlog`) or `master.dbo.xp_enumerrorlogs` / `xp_readerrorlog`.
  `sp_enum_proxy_for_subsystem` is not used: sysadmin reads `sysproxies`/`sysproxysubsystem` directly, others call
  `sp_help_proxy`. `LiveSql.Lint`, `CatalogSql.Lint` and `ActivitySql`'s lint stay as they are. `INSERT … EXEC` is never used
  (`sp_help_job` nests one itself); results are read into backend memory, capped, and paged or filtered there.
- **Writes**: inside `ActionService` (its own unpooled, never-retried connection, preflight in the same connection, Stop,
  `LOCK_TIMEOUT -1`, reader-only execution, no logging), templates in `Agent/AgentSql.cs` checked by
  `AgentSql.LintExecutable`, which `ActionSql.Lint` chains as it does `LoginSql`. Every call is
  `EXEC @rc = msdb.dbo.<allowlisted procedure> @arg = @param, …;` followed by
  `IF @@ERROR <> 0 OR @rc <> 0 THROW 50012, N'<constant>', <call index>;`: msdb's Agent procedures mostly fail with
  `RAISERROR` and `RETURN 1`, which `XACT_ABORT` does not stop (it does not apply to `RAISERROR`), so the `@rc` check is what
  forces the rollback; without it a failed `sp_add_jobstep` would let the batch commit a half-made job. A failure with
  msdb's own error maps by that number (Jobs › Error mapping); a bare `RETURN 1` leaves 50012 first, which maps to
  `SQL_ERROR` with the refused part named. A job save runs in one transaction; a live check makes a middle step fail
  deterministically (`sp_add_jobstep` with a `@database_name` that does not exist) and proves nothing commits. Names
  never enter SQL text, so no `QUOTENAME` is needed; `AgentSql` has no dynamic SQL; no literals but constants. Live checks
  prove hostile names (`]`, `'`, `--`, Unicode, 128-character names) round-trip, and that Script Action's script, run,
  builds the same job as the action (as Login's checks phrase it).
- **Credentials** are server DDL, not msdb procedures, and the one Agent-area exception to "no dynamic SQL":
  `CREATE CREDENTIAL` and `ALTER CREDENTIAL` templates in `Actions/CredentialSql.cs`, checked by its own lint chained from
  `ActionSql.Lint`, built as LoginSql builds logins: the outer batch is constant; it builds the statement on the server in
  `@stmt` with the name through `QUOTENAME` and the identity and the secret each spliced as a quoted literal through a
  binary-collation `REPLACE` of `'` (as LoginSql splices the password), behind NULL guards, and runs it through
  `EXEC @module @stmt`. Neither value ever appears in the text Varia sends. Every `ALTER CREDENTIAL` sends both identity
  and secret (the secret would otherwise be reset to NULL); the template refuses a NULL secret, and a live check proves an
  identity-only edit is refused before any SQL runs. Windows identities are refused where the gates say so (Managed
  Instance). The secret lives only in `ObjectDialogService`'s secret slot (its `SecretState` generalised from New Login's
  to a named secret), travels only in the sensitive `actions.execute`, is scrubbed from replies, and Script writes
  `<secret>`.
- **Service control**: `EXEC @rc = master.dbo.xp_servicecontrol @action, N'SQLServerAgent';` with `@action` in
  `N'Start'`, `N'Stop'`, `N'QueryState'` as a parameter. `xp_servicecontrol` maps the constant `SQLServerAgent` to the
  connected instance's Agent (`SQLSERVERAGENT` or `SQLAgent$<instance>`), as the QueryState fact showed; the Windows CI job
  proves it on a named instance. Restart is Stop, then the action itself re-reads `QueryState` (ActionService has no live
  probes) on its own connection under the `AgentSql` lint until it reads stopped, bounded by a catalogue deadline and
  Stop-able, then Start. Sysadmin and Windows servers only, not on a failover cluster instance; confirmation first, through
  ActionService. "Access is denied" (the engine's virtual account may lack the right on the Agent service) maps by its
  error number (AG-0) to a `PERMISSION_DENIED` value with a sentence naming the account. This deliberately differs from
  SSMS, which controls the service from the client computer through WMI: Varia goes through the engine so it needs no
  Windows rights or network path to the server, and works the same from Linux and macOS clients. If AG-0 finds it cannot
  work on default virtual accounts, the lane comes back to the owner.
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
| Existing `explorer.*`, `live.subscribe` | Agent kinds; new live sources `agent.jobs` (probes `agent.jobs.list`, `agent.jobs.watched`), `agent.history`, `agent.tree` (probe `agent.treeProbe`), and the new `explorer.agentService` probe in the existing `explorer` source | Each new source needs a `liveSourceIds` entry, probe ids in `liveProbeIds`, a `LiveService.CreateSampler` case and a C# args check; args bounded in the live catalogue's schemas |

Error codes: action code `STALE` (the name already exists for the shortcuts save; the action row adds its own message,
not retryable) and new action code `AGENT_STOPPED` (msdb 22022); msdb's 14xxx numbers join the existing `NOT_FOUND`,
`PERMISSION_DENIED`, `NAME_IN_USE` and `IN_USE` mappings. THROW numbers: 50010 (identity guard, existing), 50011 (`STALE`),
50012 (an msdb call returned non-zero). docs/ipc.md lists them (its lint checks).

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
  CmdExec and PowerShell steps are covered by offline lint and script tests in every CI run, live in the Windows
  service-control job when it runs, and on the owner's Windows test instance; SSIS steps live only on the owner's instance
  (the CI job installs no SSIS).
- **`VARIA_TEST_SQL_AGENT=1`** (new, docs/testing.md): Agent live suites require Agent and fail if it does not come up;
  without the variable they skip with one line saying why.
- **`VARIA_TEST_SQL_AGENT_SERVICE=1`** (new): the `AgentService` live suite really stops, starts and restarts Agent through
  the action, waiting on `QueryState` and an Agent session (conditions, generous timeouts), and always leaves Agent running
  in `finally` (Start, then a wait). It is set on the owner's test instance (which exists only for testing Varia) and in the
  Windows CI job, never in the Linux CI jobs, where the feature is hidden; there the suite asserts only that service control
  is refused as `NOT_SUPPORTED`. Other Agent suites never stop Agent, and the service suite runs alone (its own live group)
  so a stopped Agent cannot fail a neighbour.
- **Windows service-control CI job** (`agent-service`, AG-2): one `windows-latest` job that installs SQL Server Developer
  as a **named instance** with Agent (installer and caching settled and timed in AG-2, recorded in docs/ci.md), then runs
  `AgentService` and the Windows-only step checks (CmdExec, PowerShell) with `VARIA_TEST_SQL_AGENT=1` and
  `VARIA_TEST_SQL_AGENT_SERVICE=1`. It runs only when needed: `scripts/ci-scope.mjs` gains an `agentService` output, true
  when the change touches the service-control paths (`backend/Varia.Backend/Agent/**`, the Agent action templates, the
  `AgentService` suite, the job's own workflow lines and `ci-scope.mjs`; the list lives in `ci-scope.mjs` with a test), on
  main pushes with the same rule, and on manual runs (a new `regression-suite` choice, `agent-service`). The job joins
  `result`'s needs, and `ci-result.mjs` treats it as passed when scope skipped it, so the required "CI result" check
  still reports on every PR. `tests/ci-workflow.test.ts` pins the job, its condition and its path list; docs/ci.md's layout
  and measurements gain it.
- **Scratch objects**: Agent objects are server-level, in msdb. Scratch jobs, schedules, operators, alerts, proxies,
  credentials, logins and msdb users are named with the run prefix `VariaScratch_<yyyyMMddHHmmss>_<8 hex>_` followed by
  anything (hostile and 128-character names included), carry `ScratchDatabase.JobMarker` (description) where the object
  has one, and are dropped in `finally`. The sweep extends `ScratchDatabase`'s existing job sweep (no second mechanism): its
  exact `JobPattern` widens to the run prefix plus any suffix, and age comes from the prefix's timestamp, so kinds without a
  description or date (operators, credentials, logins) are swept too. Sweep order follows dependencies: proxies, then
  credentials, then jobs (and their owned schedules), alerts, operators, then msdb users, then logins. No scratch category
  is created (a shared category could not be dropped while another run uses it). A check of Agent Properties' writes
  (server-wide) restores the old values in `finally`. Scratch job runs add rows to Agent's server-wide history cap (default 1,000), pushing out the oldest rows of
  real jobs on a shared server: suites keep runs few (one `WAITFOR` job per suite), and docs/testing.md says so.
- **Live suites** (each with its seconds in `LiveGroups.Suites` and docs/ci.md's table): `Agent` (tree, capability, both
  read paths with low-privilege SQL logins in each Agent role), `AgentJobs` (a scratch job with a `WAITFOR DELAY` T-SQL
  step: start at step, stop, enable/disable, status transitions through the live source, the In progress run and its
  grouping, waits on conditions only), `AgentActions` (every write template against hostile names, Script Action's script
  builds the same object, identity and `STALE` guards with two sessions editing one job and with another job's dialog
  editing a shared schedule, which `version_number` bumps, a failing middle step commits nothing, each msdb error number
  maps to its code with the refused call's index, Delete History refuses an empty job list), `AgentRoles` (a
  SQLAgentUserRole login opens and saves its own job through the describe role path; Reader sees others' jobs read-only;
  Operator starts another's job), `AgentScripting` (SMO scripts vs SSMS goldens in `tests/fixtures/scripting/`),
  `AgentCredentials` (secret never in a reply or script, hostile names, an identity-only edit refused), `AgentService`
  (above).
- **Offline**: `AgentSql.LintRead`, `LintExecutable` and `CredentialSql` lints render every variant; schedule encoding and
  sentence table tests; history grouping (the cases above) and time decoding table tests; msdb error mapping; catalogue
  snapshot; zod/C# limit mirrors; the `ci-scope.mjs` path rule.
- **Renderer vitest** with fixtures for states the live smoke cannot reach: each Agent role, Managed Instance, Linux,
  Express, failover cluster, Agent stopped, Agent XPs disabled, state unknown, `PERMISSION_DENIED` mid-dialog, `STALE`,
  `AGENT_STOPPED`, empty, loading and failed history and Job Activity Monitor, error-log truncation.
- **Smoke**: `scripts/agent-smoke.mjs` on the fake backend (tree, Job Activity Monitor grid, job dialog round trip, Log File
  Viewer), surfaces found by ARIA role and name through `scripts/fixtures/ui.mjs`, added to `test:smoke`,
  `smoke-shards.mjs`'s times and docs/ci.md's table. Shards with a SQL Server gain the Agent node in their trees; AG-1
  updates the explorer smoke's expectations.

## Keyboard and accessibility

Smoke suites find surfaces by ARIA role and name, so these are part of the design:

- **Tree**: Agent rows are `treeitem`s whose accessible name includes the state chip text ("SQL Server Agent, Stopped",
  "Index maintenance, Running, step 2 of 4"); chips are not separate tab stops. Context menus as every tree kind.
- **Job Activity Monitor**: the grid is a `grid` with `aria-multiselectable="true"`; Up/Down move, Shift+Up/Down and
  Shift+click extend, Ctrl+click and Ctrl+Space toggle, Ctrl+A selects all visible rows; Enter opens Properties, Delete is
  not bound (jobs are deleted from Object Explorer, as SSMS), F5 refreshes now. View chips are a `radiogroup`; tiles are
  buttons that apply their chip. The live indicator is a `status` region announcing errors only, never each sample.
- **Log File Viewer**: the sources pane is a `tree` of checkbox `treeitem`s with `aria-checked` `true | false | mixed`
  (a parent with some jobs checked is mixed); Space toggles. Focus order is sources → toolbar → runs grid → steps grid →
  details pane, and F6 / Shift+F6 cycle the panes, as in the query editor. Selecting a run updates the steps grid without
  moving focus. F5 refreshes; Ctrl+C copies the selected rows through `ResultTextWriter`.
- **Dialogs**: `dialog` with the page list as a `tablist` (as Login Properties); the Start Jobs progress dialog lists one
  `listitem` per job with its result text, inside a `log` region; destructive confirmations are `alertdialog`s whose
  default button is Cancel.
- **Status bar job**: a `status` region announcing start and end, with Stop as a button.

## Lanes

Ordered; lanes on the same line can run in parallel once their dependency lands. Sizes are rough (S < 1 day of agent
work, M, L). **Every lane's definition of done** includes its part of docs/sql-server-agent.md, README where users see a
change, CHANGELOG.md's Unreleased summary, and its Getting Started guide/sample impact or a concrete no-impact reason, as
CLAUDE.md requires.

| Lane | Scope | Depends on | Size |
| --- | --- | --- | --- |
| AG-0 | Foundations: `src/shared/agent/catalog.ts` (code tables, gates, decoding, limits, docs generation), `agent.profile` and `agentRole` keys, `AgentReader` + `AgentSql.LintRead`, CI `MSSQL_AGENT_ENABLED` and the Agent-up wait, `VARIA_TEST_SQL_AGENT`, scratch prefix and sweep extension, Agent live suite skeleton; spikes on the owner's test instance: `sp_help_job` while stopped, `xp_servicecontrol` with `SQLServerAgent` on virtual accounts and its "Access is denied" number, `version_number` bumps, msdb error numbers, the `dm_server_services` permission on 2022+, the Linux DMV | — | M |
| AG-1 | Object Explorer: Agent node and folders, both listing paths, edition gate (`ExplorerProfile` edition; existing Linux and Managed Instance flags), platform-gate verification, `explorer.agentService`, Agent node chips, the `explorer` source's reader and the role path of `explorer.agent`, `agent.tree`, Search Objects batch, icons, menus (Agent node New › with Job… only until the other lanes land) with not-yet verbs hidden | AG-0 | M |
| AG-2 | Job verbs from the tree: Start Job at Step, Stop, Enable/Disable, Rename, Delete; `AgentSql.LintExecutable` with return-code checks, the identity guard and msdb error mapping (`AGENT_STOPPED` included); Agent service Start / Stop / Restart; the `AgentService` live suite and the path-gated Windows CI job | AG-1 | M |
| AG-3 | Job Activity Monitor: `agent.jobs` live source, document with LiveGrid, tiles, view chips, filters, multi-select row actions with Start Jobs / Stop Jobs progress, loading, error and Agent-stopped states, server-time labels; status-bar running job (`agent.jobs.watched`) | AG-1 (AG-2 for actions) | M |
| AG-4 | Script As for Job, Alert, Operator, ProxyAccount (UrnBuilder JobServer children, scripting catalogue rows, goldens, role check) | AG-1 | S |
| AG-5a | Log File Viewer: `agent.history` live source (both paths), run grouping with In progress and Unknown, master/detail grids, details pane, `agent.historyMessage`, Delete History for checked jobs (all or older than) | AG-1 | M |
| AG-5b | Agent error logs in the Log File Viewer: `agent.errorLogs`, `xp_readerrorlog` / `sp_readmierrorlog` capped reads with the truncation notice, Recycle | AG-5a | S |
| AG-6a | Job dialog shell: describe (both paths), General, Notifications, Targets (local), Alerts list (Add hidden until AG-7), one-transaction save with `STALE`, Script Action, New Job (also from the Agent node's New ›) | AG-2 | M |
| AG-6b | Steps page and step dialog (T-SQL with editor features and Parse, CmdExec, PowerShell, SSIS package, Advanced) | AG-6a | L |
| AG-6c | Schedules: `schedule.ts` encoding and sentences, schedule dialog (CPU-idle warning), Pick, Jobs in Schedule, Manage Schedules, Remove with delete offer; Agent node New › Schedule… | AG-6a | M |
| AG-7 | Operators and Alerts: dialogs (all pages), Enable/Disable, Rename, Delete; performance counter picker; Database Mail readiness warning; Agent node New › Operator… and Alert…; job dialog Alerts page Add | AG-1, AG-6a (shared dialog parts) | M |
| AG-8a | SQL Server Agent Properties (General, History) through `sp_set_sqlagent_properties`, read-only on Managed Instance; the one-shot "Remove agent history older than" purge with its confirmation | AG-1 | S |
| AG-8b | Proxies: New / Properties (General, Principals, References), Rename, Delete, Agent node New › Proxy…; New Credential and Credential Properties (`CredentialSql`, generalised secret slot, identity and secret always sent together) | AG-1, AG-6a | M |
| AG-9 | Getting Started guide and sample for Agent, parity re-check of the Agent rows | all | S |
| Later | Manage Job Categories, multi-server targets, Script Action to Job, output file and table log viewers, Activity Monitor job links, SQL Server Logs and Database Mail in the Log File Viewer, Agent Properties' remaining pages and fail-safe operator, WMI alert editing, Elastic Jobs | | |

Suggested waves: AG-0 → AG-1 → {AG-2, AG-4, AG-5a, AG-8a} → {AG-3, AG-5b, AG-6a} → {AG-6b, AG-6c, AG-7, AG-8b} → AG-9.
Lanes that touch the Agent tree menus or the actions catalogue (AG-2, AG-6a, AG-7, AG-8a, AG-8b) merge main in after each
lands, as the Activity Monitor lanes did.

Coordination with BigQuery: AG-1 and BQ-5 both extend `src/shared/explorer/catalog.ts` and its generated
docs/object-explorer.md and `explorer-catalog.json`. Land AG-1 before BQ-5 starts, or rebase whichever is second; neither
needs the other. BQ-0's `providers` default covers Agent's entries whichever lands first.

## Questions still open

None blocking. AG-0's spikes and AG-1's platform-gate verification report back in their PRs. If service control cannot
work on default virtual accounts or a named instance, or the Windows CI job cannot install SQL Server in a reasonable time,
that comes back to the owner before AG-2 merges.
