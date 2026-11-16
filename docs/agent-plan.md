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
  but runs **only when needed**: on pull requests that touch the service-control paths, daily on main and on manual runs,
  never on unrelated PRs. It is its own workflow, not part of the required CI result (Testing).
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
- `ScratchDatabase` already names a scratch Agent job (`Job`, `JobMarker = "varia.scratch"` in its description,
  `IsScratchJob`, an exact `JobPattern`) for the Object Explorer status checks. Its stale-job sweep lives in
  `ExplorerStatusLiveChecks.AgentAsync`, not in `ScratchDatabase.SweepAsync`, so it runs only with that suite and ages jobs
  by `date_created`. Nothing sweeps credentials, operators or msdb users.
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

Still to verify in AG-0 on the owner's test instance (its Agent may be stopped by checks) and in the Windows CI job:
whether `sp_get_sqlagent_properties` returns values to a SQLAgentUserRole login (msdb grants that role EXECUTE and the
procedure has no sysadmin check, but it reads through `xp_instance_regread`, which may refuse non-sysadmin callers; until
then the plan treats it as sysadmin-only, and if it works the cap text, idle-CPU and mail facts show to every role that
can run it, with any refusal number mapped to "not read"); what
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

- **Linux**: no alerts at all (folder, job Alerts page, New › Alert…, operator Notifications › Alerts), step types without
  CmdExec, PowerShell, Queue Reader, SSIS, SSAS or merge replication; the Proxies folder shows (Microsoft's list does not
  exclude proxies) with the subsystems `syssubsystems` lists, which AG-1 checks against the CI container; no event log notification, no service
  control.
- **Managed Instance**: no alerts (folder, job Alerts page, New › Alert…, notifications from alerts), no proxies, step types
  limited to T-SQL, SSIS, log reader, snapshot and distributor (no CmdExec, PowerShell, Queue Reader, merge or SSAS), no
  event log notification, no CPU-idle schedules, Targets local only, Agent Properties read-only, no Windows-identity
  credentials, e-mail only through Database Mail with the profile `AzureManagedInstance_dbmail_profile` (the readiness
  warning checks for that name), no pager or net send, error log read through `sp_readmierrorlog` (its own master shape,
  below) instead of `xp_readerrorlog`; whether `xp_enumerrorlogs` lists archives there is checked in AG-0, otherwise the
  Error Logs folder shows Current only.

They are **verified in AG-1**, Linux against the CI container, Managed Instance from its documentation, and recorded in
docs/sql-server-agent.md (sources: Microsoft's "Editions and supported features of SQL Server 2022 on Linux" and "T-SQL
differences between SQL Server and Azure SQL Managed Instance"). Renderer fixtures cover each platform's tree, step types
and Notifications page. The tree, dialogs and menus read the gates; nothing hard-codes a platform.

Edition gating reuses what exists: C# `ExplorerProfile` already carries `Linux` and `ManagedInstance`, `ServerProfile`
detects Linux from the path separator (so 2016 works), and the connection info already carries `EngineEdition` and
`Linux`. Both profiles gain what the gates need: the TS `ExplorerProfile` gains the engine edition and `linux`; the C#
`ExplorerProfile(Band, Cloud, Linux, ManagedInstance)` gains the edition, which `Profile()` stops dropping. `FolderSpec`
gains `editions`/`platforms` gates that `folderServed` and its C# mirror (`Served`) check; docs.ts's literal profile passed
to `folderServed` gains the fields.
`IsClustered` joins the capability read. Agent nodes are SQL Server only; when
BigQuery's BQ-0 adds `providers` to catalogue entries, Agent's take the default `['sqlserver']`, and a BigQuery handle on an
Agent method answers BQ-0's `UNSUPPORTED_PROVIDER` (planned in #528).

## Permissions and how the UI degrades

A capability read (one constant batch, msdb through `msdb.sys.sp_executesql`, as the explorer's per-database batches; the
same built-ins the SSIS profile and live session probe already use) reads `IS_SRVROLEMEMBER(N'sysadmin')`,
`IS_ROLEMEMBER` for the three Agent roles, `HAS_PERMS_BY_NAME(N'msdb.dbo.sp_purge_jobhistory', N'OBJECT', N'EXECUTE')`
(Delete History below Operator), `HAS_PERMS_BY_NAME` for the permissions the state probe needs (on 2022+ the
live catalogue's `serverState` already means VIEW SERVER PERFORMANCE STATE, which the `sys.dm_exec_sessions` fallback
needs; `sys.dm_server_services` may need VIEW SERVER SECURITY STATE there, so AG-0 settles it and, if so, adds a
`serverSecurityState` permission kind and splits `explorer.agentService` into a DMV probe and a session-fallback probe, each
with one permission; before 2022 both are VIEW SERVER STATE), `ALTER ANY CREDENTIAL`, `SERVERPROPERTY('IsClustered')`, the `Agent XPs` value from
`sys.configurations`, and whether Database Mail can be read. It is cached per connection and re-read on Refresh, and drives
the tree, the menus (target-scoped context key `agentRole`: `sysadmin | operator | reader | user | none`, plus
`explorerSelectionAgentRole`) and the read path. It is a `CatalogSql` statement linted by `CatalogSql.Lint` with its own
exact per-statement `literals` set (as Peek's rows batch; the role names, `N'sysadmin'`, the `HAS_PERMS_BY_NAME` object
and permission names, `N'IsClustered'`); `Agent XPs` is read by `configuration_id = 16384`, so no option-name literal is
needed. The `msdb.sys.sp_executesql` wrapper stays outside the linted text, as `ModuleCall`'s does. ExplorerChecks
renders and lints it.

| Login | Tree shows | Can do |
| --- | --- | --- |
| sysadmin | Everything | Everything, incl. any job owner, Agent properties, error logs, service control. |
| SQLAgentOperatorRole | Jobs (all), Job Activity Monitor, Alerts, Operators, Proxies (read-only) | Start/Stop/Enable/Disable any local job; enable or disable any schedule (`sp_update_schedule @enabled` only; Manage Schedules shows Enable/Disable for them); delete history; edit only own jobs. |
| SQLAgentReaderRole | Jobs (all, others' read-only), Job Activity Monitor | View all jobs and history; edit only own jobs; no Delete History by default (needs EXECUTE on `sp_purge_jobhistory`). |
| SQLAgentUserRole | Jobs (own only), Job Activity Monitor (own) | Create and manage own jobs (no Delete History by default: needs EXECUTE on `sp_purge_jobhistory`); T-SQL steps, or other subsystems only through a proxy granted to the login. |
| No msdb access / no role | Agent node with `noAccess` status | Nothing; the node says why. |

Rules: hide what SSMS hides (Alerts/Operators/Proxies below Operator; Error Logs sysadmin only), disable rather than hide
verbs on objects the login can see but not change (others' jobs for Reader), and treat every refusal the server still
returns as a value (`PERMISSION_DENIED`) with the dialog staying open and saying which step was refused. The owner picker
is read-only for non-sysadmin, as in SSMS. A state the login cannot read is unknown, never a guess: Agent state without
VIEW SERVER STATE shows no state chip; Database Mail readiness without access shows no warning. Credential dialogs (AG-8b)
need `ALTER ANY CREDENTIAL` and only add verbs to the existing Security › Credentials folder; they never hide that folder,
whether AG-8b has landed or not.

## Object Explorer

Tree (SSMS order). Jobs, alerts, operators and proxies use the existing `serverObject` scope (a server-level object named
by name alone; their names are unique per server). Error logs are keyed by archive number (`0` is Current), never by their
"Current - <date>" label, which changes on Recycle.

Today kind rows appear only as a folder's listed `rows`, the server kind lists only folders, and a folder with no `list` is
an empty folder with no "opens" behaviour. Agent needs two new catalogue mechanisms, built in AG-1 with their C# `Served`
mirror, docs.ts output and catalogue tests:

- **Singleton children**: `KindSpec` gains `singletons` (kind, label, the same `editions`/`platforms` gates as folders), and an
  `order` that sorts with `FolderSpec.order` among the owner's children (the TS side is the catalogue, its docs and its tests; the children listing is C# only; catalogue
  tests assert SSMS's order, so Job Activity Monitor sits between Jobs and Alerts; `tests/explorer-catalog.test.ts`'s
  sibling-order uniqueness check, which today covers only `folderSpecs` and `laterFolders` and skips `owner === 'object'`,
  counts singletons as siblings, below kind owners too; a kind's children are merged by `order` rather than taken from its
  `folders` array; `ExplorerCatalog.cs`'s ordering and the generated catalogue JSON's kind reader (`CatalogKind`, not `CatalogFolder`) carry
  singletons with their `order`), with an unnamed `server`-style scope. The server kind's singleton is `agent`
  ("SQL Server Agent", so chips keyed by `NodeKind` work); the `agent` kind's singleton is `agentJobActivity` ("Job Activity
  Monitor", a leaf).
- **Opens a document**: `KindSpec` gains `opens` (a document id from the Agent catalogue); a leaf with it opens that document
  on Enter or double-click and shows no expander. `agentJobActivity` opens Job Activity Monitor.

Proxies' subsystem folders are dynamic, so they are a kind, `agentProxySubsystem` (`serverObject`, name = subsystem),
listed by the Proxies folder, plus a static "Unassigned Proxies" folder:

```
SQL Server Agent                (agent node: "Stopped" sublabel and chip when stopped; "Agent XPs disabled" sublabel
                                 when that option is 0 (see below); running-jobs chip)
  Jobs                          (job rows, filter by name/owner/category/created; disabled status badge; state chips)
  Job Activity Monitor          (singleton leaf kind agentJobActivity: opens the document)
  Alerts                        (alert rows, disabled badge)
  Operators                     (operator rows, disabled badge)
  Proxies
    <agentProxySubsystem rows: every subsystem except TSQL>, Unassigned Proxies (static folder)
  Error Logs                    (Current - <date>, Archive #1 - <date> ...)
```

- `laterFolders` loses `SQL Server Agent`; folders and kinds (`agent`, `agentJobActivity`, `agentJob`, `agentAlert`,
  `agentOperator`, `agentProxySubsystem`, `agentProxy`, `agentErrorLog`) go in the explorer catalogue with icons registered in `icons.ts` (Agent, alert, operator,
  proxy, error log, schedule; `agent-job` reused).
- Listings, sysadmin path: `CatalogSql` queries over msdb tables/views, keyset-paged and filtered in SQL as every listing.
  Role path: Agent kinds list through `AgentReader` (`sp_help_job`, `sp_help_operator`, `sp_help_alert`, `sp_help_proxy`),
  which reads the whole result into backend memory up to `agentLimits.listRows`, marks truncation explicitly, and pages and
  filters it there; `CatalogSql` stays free of `EXEC`. Error logs list through `xp_enumerrorlogs 2` (sysadmin; Managed
  Instance per the gates). Proxies list one `agentProxySubsystem` row per subsystem except TSQL (proxies cannot be assigned
  to it; a listing test checks no TSQL row appears): sysadmin reads `syssubsystems`, others `sp_enum_sqlagent_subsystems`
  (allowlisted; AG-0 checks which roles may run it, and below Operator the Proxies folder is hidden anyway).
- `AgentReader` (`Agent/AgentReader.cs`) is a shared statement runner, not a service: given a connection it runs
  `AgentSql.LintRead`-checked statements one at a time (a statement the login may not run fails alone) and reads capped
  results into memory. Each caller keeps its own pool, connection and prologue: Object Explorer listings and Search
  Objects on theirs, `actions.describe` on the action read connection, and live sources through a thin `ILiveSqlReader`
  adapter.
- Agent state: a new `explorer.agentService` probe in the `explorer` live source (added to `liveProbeIds` and the source's
  probe list). It declares **no** permission gate, because a gated probe opens unavailable without the permission and its
  ungated `Agent XPs` read (`sys.configurations`) would never run; instead its constant text guards the DMV and session
  parts with `HAS_PERMS_BY_NAME` (the 2022+ security or performance state, settled in AG-0) and returns NULL state when the
  login lacks it. It reads `sys.dm_server_services`
  (`servicename LIKE N'SQL Server Agent%'`, as `ExplorerStatusLiveChecks` does) and, where the DMV has no Agent row (Linux,
  to verify), an Agent session (`program_name LIKE N'SQLAgent - %'`) in `sys.dm_exec_sessions`. Without the permission the
  state is unknown and no state chip shows. Managed Instance is always running.
- Agent XPs and service state combine: XPs at 0 with Agent stopped shows the Stopped chip plus the "Agent XPs disabled"
  sublabel, lists no folders and no Job Activity Monitor singleton (msdb's procedures fail with error 15281), and still offers Start to sysadmin on Windows
  (starting Agent turns the option on, as SSMS does). XPs at 0 with Agent running (rare; AG-0 spikes the option's value
  after a clean Agent stop) shows the sublabel and no folders. Error 15281 from any Agent read maps to this state, never to
  a generic failure: a new explorer code `AGENT_DISABLED` joins `explorerErrorCodes` in `src/shared/contracts.ts` (C# has
  no code list; codes are strings in `ExplorerErrors`): `ExplorerErrors.Classify` gains `15281 => "AGENT_DISABLED"`, and
  `ExplorerErrors.Create` gains a platform-neutral `AGENT_DISABLED` message case (naming both `sp_configure` and
  `mssql-conf`; neither `Create`, `From` nor `LiveErrors.From` knows the platform) instead of the default `Msg n:` text,
  retryable (Refresh after Start succeeds); the renderer words the node's explanation and banners per platform from
  `agent.profile`. The Agent listing's own no-role `PERMISSION_DENIED` and `AGENT_DISABLED` are built as direct
  `new ExplorerError(...)` values with their Agent sentences, so `Create`'s fixed "You do not have permission to view …"
  text for `From`-classified 229 and friends is unchanged (an ExplorerChecks case asserts it still is). ExplorerChecks'
  Classify table gains 15281, and docs/ipc.md lists the code. The live path has its own list, so `AGENT_DISABLED` also joins
  `liveErrorCodes` (`src/shared/live/schema.ts`, validated by main's supervisor, which drops any tick that fails it):
  `LiveErrors.Classify` maps 15281 to it and `LiveErrors.From` gives the same sentence; docs/ipc.md's live code list and
  a `tests/live-schema.test.ts` case accepting an `AGENT_DISABLED` tick error cover it. It is deliberately not in `LiveErrors.IsTerminal`, so the probe retries
  with `LiveService`'s usual back-off (up to the larger of `backoffMs` and its interval); to recover promptly, a view
  showing `AGENT_DISABLED` sends `live.update` with `refresh: true` when `agent.jobs.service` or `explorer.agentService`
  reports XPs 0 → 1, or after its own Start succeeds, and a renderer vitest covers that recovery. Job Activity Monitor, the
  status-bar watched job and the Log File Viewer show it as the same warning banner as "Agent stopped", never the error
  state; the banner offers Start (sysadmin on Windows, not a failover cluster instance, startup type not Disabled) only
  while the service state is Stopped, and with Agent running it offers no Start, only the `sp_configure` /
  `mssql-conf` sentence; a C# offline check covers `LiveErrors.Classify(15281)` and `!LiveErrors.IsTerminal("AGENT_DISABLED")`,
  renderer fixtures assert which button shows for XPs 0 with Agent stopped and running, and a renderer
  vitest feeds Job Activity Monitor an `AGENT_DISABLED` sample. The node's explanation names `sp_configure` on Windows and `mssql-conf` on Linux. The XPs value is
  live, not cached: `explorer.agentService` also reads `Agent XPs` from `sys.configurations`, so after Start turns it on the
  next sample clears the sublabel. Whether the Agent folders are listed is a children-listing decision:
  the children listing is in C# only (`Explorer/ExplorerService.cs`), and the capability read is cached. Listing the
  `agent` kind runs no SQL today (static folders and singletons, no `list`, so `LoadAsync` returns before opening a
  connection), so AG-1 adds an explicit pre-folder step for `target.Kind == "agent"` beside `DatabaseProblemAsync` and
  `HistoryAsync`: one constant `CatalogSql` batch (linted with its own exact `literals` set, rendered by ExplorerChecks) run through `msdb.sys.sp_executesql` (as the capability read, so
  `IS_ROLEMEMBER` resolves in msdb rather than returning NULL in master) via `RunAsync` on the explorer pool, counted
  against `Budget` with the usual timeout and error mapping. It reads `Agent XPs` from `sys.configurations` by `configuration_id = 16384` (no
  permission needed), `IS_SRVROLEMEMBER(N'sysadmin')` and the three Agent role memberships. At XPs 0 it adds neither the
  folders nor the Job Activity Monitor singleton and returns the explorer error `AGENT_DISABLED` with the `sp_configure` /
  `mssql-conf` sentence, so the expanded node says why even when the status view is off; otherwise it gates folders by the role rules above (Alerts, Operators
  and Proxies need SQLAgentOperatorRole or sysadmin, Error Logs sysadmin; a login with no Agent role and no sysadmin gets
  no children and the explorer error `PERMISSION_DENIED` with an Agent-specific sentence, and a login without msdb access
  (only where msdb's guest CONNECT has been revoked) gets the existing 916 → `NO_DB_ACCESS` value, created with
  `database: "msdb"` so its message names msdb; the `noAccess` badge on the node comes from the cached capability read,
  the expanded node's message from these errors). Each Agent folder listing then picks the sysadmin path or the role path from an
  `IS_SRVROLEMEMBER(N'sysadmin')` column in its own batch, as the sampler chooses per sample, so no role fact is cached
  across listings. A re-list therefore always sees the current value and
  `explorer.children` gains no new param; `OwnsChildren` and `HasChildren` count singletons, so a kind with singletons
  reports children. C# offline checks cover both XPs values, each role's folder set (sysadmin, Operator, Reader, User,
  none), and that listing an XPs-1 `agent` node costs one round trip, and a renderer vitest feeds an `explorer.agentService` sample that flips XPs 0 → 1 (the
  `agent` node re-lists with its folders, keeping expansion and selection), then 1 → 0 (they go), and an unchanged value
  (no re-list). An `AgentStateSource` on the renderer's `src/renderer/src/explorer/ExplorerService.ts`
  (modelled on `DatabaseRuntimeSource`) carries `explorer.agentService`'s XPs value, and when it changes 0 → 1 or 1 → 0 it
  reconciles the `agent` node (re-lists its children, keeping expansion and selection), the one case where a status sample
  changes the tree. When the status view is not running (`liveData.explorerStatus` off or Object Explorer hidden), the
  fallback is the listing's own `AGENT_DISABLED` error (and 15281 → `AGENT_DISABLED` on any other Agent read) plus Refresh;
  a C# offline check covers both listing errors and a renderer vitest checks the expanded node's message with the status
  view off.
- The `explorer` live source gains a reader for one probe only. Today `LiveService.CreateSampler` hands an
  `ILiveSqlReader` to the Activity Monitor and `ssis.operations` sources, and `SqlSampler` then sends **every** ungated
  probe of that source to the reader and takes the session from the reader's `SessionAsync`. Routing is fixed when the
  sampler opens (`SqlSampler.OpenAsync`), often before the session has been read, so it cannot depend on the login. AG-1
  adds static per-probe routing (`ILiveSqlReader.Handles(probeId)`; probes it does not handle keep their `LiveSql` query and
  the session stays `LiveSql.Session`), and the `AgentReader` adapter always handles `explorer.agent` and **chooses per
  sample** from a sysadmin flag. That flag does not exist for the explorer today (`LiveSql.Session`'s admin column is
  SSISDB-only and 0 when `@catalog` is NULL, and `ILiveSqlReader.ReadAsync` receives no session facts), so AG-1 adds a
  column `CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0))` to `LiveSql.Session` independent of `@catalog`, keeps it
  in a sampler field, and passes it to the reader through a new session-facts argument of `ReadAsync`; the session-shape
  checks are updated. With that flag:
  sysadmin runs today's `LiveSql` Agent statement, other logins run `sp_help_job`, counting `current_execution_status` in
  1, 2, 3, 7, so the count is the jobs the login may see. No Agent-role columns go in `LiveSql.Session` (the explorer pool
  opens in master, where `IS_ROLEMEMBER` on msdb roles returns NULL); a login with no Agent role gets `PERMISSION_DENIED`
  from `sp_help_job` as today. The `agent.jobs` and `agent.tree` readers' own `SessionAsync` read the same flag.
  `ExplorerStatusLiveChecks` keeps its no-role `PERMISSION_DENIED` assertion and gains a check with a SQLAgentUserRole login
  that expects its own running job counted.
- `ExplorerStatusService` builds its probe list from `statusChipKinds.database` and `.server`; it adds `.agent` and builds
  the list through a `Set`, since `explorer.agent` appears in both `.server` and `.agent` and `live.update` refuses repeated
  probe ids (a vitest checks the list has no repeats).
- Chips: `statusChipKinds` gains `agent: ['explorer.agentService', 'explorer.agent']`; `server` keeps `explorer.agent`.
  Both running-jobs chips read the one sample. `statusChipKinds` only feeds the probe list and docs; rows get chips through
  `ExplorerStatusService.rowStatus`, which today serves only the server row and database rows, and its tick drops
  table-less samples other than `explorer.agent`. So AG-1 adds an `agent` field to `ServerStatus`, reads the
  `explorer.agentService` sample in `ServerView`, adds an `agentChips(...)` builder in `src/shared/explorer/status.ts` with
  its docs entry, and a `rowStatus` branch for `node.kind === 'agent'`; a vitest checks the Agent row's Stopped chip, XPs
  sublabel and running-jobs chip, and that unknown state shows no chip. Drawing them needs `ExplorerRow` changes too: `listedChips` returns `[]` for
  every kind but login, so `staticChips ?? status?.chips` never reaches a status chip on a non-root row; AG-1 makes it
  return `undefined` for kinds with no listed chips, adds a `sublabel` field to `RowStatus` rendered for the agent row (as
  `liveDatabase` does for databases), and puts the status words into the agent row's accessible name and tooltip (chips
  are `aria-hidden`; today only the root row's `serverWords` does this). The vitest renders the row and asserts its
  accessible name ("SQL Server Agent, Stopped, Agent XPs disabled"), not just `rowStatus`'s output. Job rows show state chips (Running · step n/m, Failed, Between retries) in AG-3,
  which builds `agent.jobs`: `ExplorerStatusService` opens a background `agent.jobs` view (`agent.jobs.list` is a
  table probe opened in a background view with no grid, counted against the background-view budget and paused
  with Object Explorer like the existing status view) while any Agent Jobs folder is expanded, and drops it when none is;
  `ServerStatus` gains a per-job map keyed by `job_id`; `rowStatus` gains an `agentJob` branch whose words go into the job
  row's accessible name and tooltip; a vitest checks a running job's chip and name and that collapsing the folder closes
  the view. Chips never reload the tree, except the Agent XPs change above.
- A live change source `agent.tree` with probe `agent.treeProbe` (as source `ssis.catalog` has probe `ssis.catalogProbe`):
  row count and checksum of the columns the tree shows. Sysadmin computes them in SQL; the role path cannot (`INSERT …
  EXEC` is never used), so the backend computes them from the capped `sp_help_job` read. It reloads only changed folders,
  keeping expansion and selection, while an Agent folder is open.
- Search Objects indexes Agent kinds in a separate server batch (`ObjectSearchSql.Agent`, through `AgentReader` for the
  role path), so a refusal skips only Agent kinds; Ctrl+Q finds a job and reveals it in Object Explorer (AG-1), and opens
  its Properties once the job dialog lands (AG-6a).
- Menus (SSMS names, catalogue entries in `src/shared/commands/catalog.ts`): Agent node: **New ›** (Job…, Alert…,
  Operator…, Proxy…, Schedule…, order verified against SSMS in AG-1; each item appears once its lane lands, Job… with AG-6a,
  and where the gates and role allow; the submenu is hidden while it has no items), Start, Stop,
  Restart, Job Activity Monitor, View History, Properties, Refresh. Jobs folder: New Job…, Manage Schedules, View History,
  Filter, Refresh. Job: New Job…, Start Job at Step…, Stop Job, Script Job as ›, View History, Enable, Disable, Rename,
  Delete, Refresh, Properties (no Delete History, as SSMS; history is deleted from the Log File Viewer). Alerts, Operators:
  New…, Enable/Disable, Script as ›, Rename, Delete, Refresh, Properties. Proxies: New Proxy…, Script as ›, Rename, Delete,
  Properties. Error Logs: View Agent Log, Recycle, Refresh. Palette: "SQL Server Agent: Job Activity Monitor", "SQL Server
  Agent: New Job". Verbs a login cannot use on an object it sees are disabled with the reason; verbs of a lane not yet landed
  are hidden.

## Jobs

Identity and concurrency: refs carry the name. Describe returns `job_id`, `date_created`, `date_modified` and
`version_number`, and `actions.execute` carries them in a new `AgentIdentityDto` (job id as a uuid string, created,
version, modified, and a list of at most `agentLimits.schedulesPerJob` schedule ids with their version and modified),
added to Contracts.cs, the strict zod schema and the C# bounds (`DatabaseIdentityDto` holds an int id and cannot). Tree
verbs with no dialog (Enable, Disable, Rename, Delete, Start, Stop) take the identity from the listing row, which carries
`job_id` and `date_created` (both paths return them), so the guard compares against what the user saw. Every write binds
`@job_id` and first checks, in its batch, that the job still has that name and
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
a schedule the caller does not own (→ `PERMISSION_DENIED`). Error 22022 is **not** mapped by number: `sp_start_job` and `sp_stop_job` raise it for
every refusal Agent returns ("not currently running", "already running", "not currently running so cannot be stopped"),
sometimes without a failing return code. After a 22022 the action re-reads, on its connection, the Agent state and the
job's `current_execution_status`, and answers `AGENT_STOPPED` ("SQL Server Agent is not running. Start it, then try
again."), `JOB_STATE` ("The job is already running." / "The job is not running.", the line Start Jobs shows), or
`SQL_ERROR` with msdb's text; live checks start a running job and stop an idle one. Error 15281 (Agent XPs off) maps to
`AGENT_STOPPED` with the XPs sentence. `STALE`, `AGENT_STOPPED` and `JOB_STATE` join `actionErrorRetryable` (all not
retryable; `ActionsCatalog.Retryable` throws on an unknown code) and `ActionErrors.Numbers` gains `["STALE"] = [50011]`.

Each THROW in a template carries the call's index as its state, a constant 1-255. A save's calls are bounded so they fit:
`agentLimits` caps steps and schedules per job (SSMS-sized, well under 255 calls in all), and zod and C# enforce it. C#
reads the msdb number from the first error and the index from the THROW, and the dialog says which part was refused
("Saving step 2 'Rebuild' was refused: …"). An error that aborts the batch before the THROW (a severe error under
`XACT_ABORT`, or error 266 from an msdb procedure that rolls back itself, which AG-0 probes) has no index; the dialog then
says the save failed and nothing was saved, without naming a part.

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
until it ends. Background views pause when Object Explorer or the window is hidden and yield their slot, and tables pause
under status-only, so this uses a table-less probe, `agent.jobs.watched`. Series are static catalogue ids, so it declares
fixed slot series (`job0Status`, `job0Step`, `job0Steps`, `job0Started` … up to `agentLimits.watchedJobs`, small), mapped to
the watched job ids by their order in the args. The `agent.jobs` source declares `hidden: 'statusOnly'` (the first
production source to use it; `tests/live-service.test.ts` is the only user today), so a view of it keeps its table-less
probes sampling while hidden. The status bar owns that view (window-scoped, the window-wide limit of 4 status-only views
applies; when none is free the status bar shows the job without live progress, never an error), holds it only while a
watched job runs, and never polls; it does not depend on Job Activity Monitor or Object Explorer being open. Elapsed time
shows only when the start is readable (below).

Start times: `sp_help_job` returns no start time for a running job. Sysadmin reads `sysjobactivity.start_execution_date` for the newest Agent session only
(`session_id = MAX(syssessions.session_id)`, the filter `LiveSql.Agent` and `sp_help_jobactivity` already use, since a
crashed session's row keeps a start with no stop);
other logins read `sp_help_jobactivity`, which joins `sysjobs_view` and so returns every job `sp_help_job` shows the login
(Reader and Operator see all jobs, User its own). Where no start time is readable (a NULL `start_execution_date`, or no
row for the current Agent session in `syssessions`), Varia shows no elapsed time (tiles, status bar, In progress run),
never a guess.

Job dialog pages (`ObjectDialog` with pages, as Login and Database Properties; describe through `actions.describe`). Describe
reads use the role path where the login cannot read the tables: `sp_help_job @job_id` (several result sets),
`sp_help_jobstep`, `sp_help_jobschedule`, all in `AgentSql.ReadProcedures` and checked by `AgentSql.LintRead`; AG-6a has a
live check that a SQLAgentUserRole login opens and saves its own job:

- **General**: Name, Owner (picker; sysadmin only), Category (from `sp_help_category`; Manage Job Categories is later),
  Description, Enabled, plus the read-only Created / Modified / Last executed facts.
- **Steps**: grid of steps (order, name, type, on success, on failure), New / Insert / Edit / Delete / Move up / Move down,
  Start step. Deleting a step another step jumps to asks first and changes those to "Quit the job reporting failure", as
  SSMS does (mocked).
  - **Save order**: msdb renumbers as it goes (`sp_delete_jobstep` lowers later step ids and rewrites go-tos that pointed at
    the deleted step; `sp_add_jobstep @step_id` shifts later steps up and moves their go-to targets), so the dialog's step
    numbers are never sent as they stand. msdb also keeps step names unique per job and checks a new name against every
    step, the one being updated included (`sp_verify_jobstep`, error 14261). The save is one pure planner in
    `src/shared/agent/steps.ts` with table tests: (1) delete removed steps from the highest id down; (2) whenever any step is added, deleted, moved or renamed, give
    **every** surviving step a unique temporary name (ids shift under inserts, so "unchanged" cannot be judged from the
    original id) (a constant prefix plus a GUID, under 128
    characters); (3) add new steps in ascending final position, also under temporary names; (4) one `sp_update_jobstep`
    per step writing its full content (name, subsystem, command, actions, go-to targets) into its final id; (5)
    `sp_update_job @start_step_id`. Move up/down are therefore changed final positions: content moves between ids, while
    history keeps the `step_id` and `step_name` recorded at run time (as SSMS's own reorder behaves; AG-0 confirms) and a
    step's `step_uid`, which only the "Log to table" output keys on, stays with the id; the step dialog says so when a step
    with table logging moves. Table tests cover a swap, a rotation, a move combined with an insert ahead of an unmoved step, a rename into another step's old name and an insert
    reusing a renamed step's name. An `AgentActions` live check runs those cases with steps that other steps jump to, then
    reads `sysjobsteps` back and compares with the dialog's model.
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
  `sp_help_schedule`), Edit…, Remove (detach, optionally deleting the schedule if unused; mocked). `sp_help_jobs_in_schedule`
  lists only the login's own jobs for SQLAgentUserRole, so Varia never decides "unused" itself: "detach and delete if
  unused" is `sp_detach_schedule @delete_unused_schedule = 1`, which deletes only when no job references the schedule and
  otherwise just detaches, so the one-transaction save never fails on it. msdb refuses that delete to a caller who does not
  own the schedule, so the option is offered only to the schedule's owner and sysadmin. Jobs in Schedule says "Only your
  own jobs are listed" for those logins.
  - Schedule dialog: Name, type (Recurring, One time, Start automatically when SQL Server Agent starts, Start whenever the
    CPUs become idle where the gates allow, with a warning that the idle condition is set in Agent Properties ›
    Advanced, which Varia does not edit yet, so set it in SSMS; sysadmin, whose `sp_get_sqlagent_properties` read shows
    whether a condition is defined, gets the specific sentence "No idle CPU condition is defined on <server>", and no
    warning once one is), frequency (daily / weekly days / monthly day-or-relative), daily frequency
    (once / every n hours-minutes-seconds between times), duration, Jobs in Schedule, and SSMS's live **Description**
    sentence. The sentence and the `sysschedules` encoding live in `src/shared/agent/schedule.ts`, pure, with table tests
    against SSMS's own sentences.
- **Alerts** (hidden below SQLAgentOperatorRole, which alone can read alerts, and where the gates have no alerts, such as
  Managed Instance): alerts that run this job (Edit, Remove;
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
- Agent stopped: Job Activity Monitor does not depend on Object Explorer's `explorer` view (which runs only while Object
  Explorer shows), so the `agent.jobs` source has its own table-less probe `agent.jobs.service` (the same constant
  service-state text as `explorer.agentService`, ungated, with the same `HAS_PERMS_BY_NAME` guard, plus `Agent XPs` from
  `sys.configurations`, which needs no permission).
  Status reads "Agent stopped" for every row, Next Run is marked as not
  current (Agent refreshes `sysjobschedules` about every 20 minutes and not while stopped), and a warning banner offers
  Start Agent… to sysadmin on a Windows server that is not a failover cluster instance; never an error banner. When the
  service's startup type is Disabled (`sys.dm_server_services.startup_type`), the banner says so and offers no Start
  (xp_servicecontrol cannot start a disabled service). What `sp_help_job` returns while stopped is verified in AG-0.
- Rendered through `LiveGrid` (the same grid components as Results), with view chips (All, Running, Failed, Disabled), the
  filter box, column value filters (in backend memory over the sample, as Activity's), row actions and multi-select (Start,
  Stop, Enable, Disable, View History, Properties). SSMS's Filter Settings dialog maps onto these filters; refresh interval
  comes from the live catalogue's interval bounds. `LiveService` pauses it while hidden.
- Times are SQL Server's local time, as `sysjobhistory` and `sysschedules` store them: the catalogue decodes `run_date`
  (yyyymmdd), `run_time` (hhmmss) and `run_duration` (hhmmss with hours past 99) with table tests, and column headers say
  "(server time)" when the server's offset differs from this computer's, on every time column alike (Last Run, Next Run,
  the Log File Viewer's Date). The offset is the capability read's `SYSDATETIMEOFFSET()`.
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
    the rows started at or after the current execution's start; where that start is not readable (a NULL
    `start_execution_date` or no current `syssessions` row), the rows after the job's last step 0 row;
  - otherwise an **Unknown (no job outcome)** run, which is what Agent leaves when it stops or crashes mid-job (Varia's own
    Stop and Restart included).

  The grouping is one pure function with table tests (normal runs, Agent stopped mid-run, a job started at step n, retries,
  two quick runs, a purge that removed a run's step 0 row) and a live check against a running `WAITFOR` job.
- Live source `agent.history`, run by `AgentReader`, modelled on `ssis.operations`: args are the filters (jobs, outcome,
  date window, message text, step; bounded: at most `agentLimits.historyJobs` job ids, text at most
  `agentLimits.searchChars`), rows newest first. Sysadmin path: `sysjobhistory` above an `instance_id` watermark with the
  same settle rule (an identity is assigned before its row commits) and departed rows when history is purged. Role path:
  `sp_help_jobhistory @mode = N'FULL'` (the default SUMMARY mode lacks `instance_id`, `step_id` and `message`; it has no
  `instance_id` lower bound) re-reads the window each sample at a slower interval, capped at `agentLimits.historyRows` with
  explicit truncation. Message text in the grid is cut to a catalogue limit. The details pane reads the full text through
  `agent.historyMessage` on the sysadmin path (`sysjobhistory.message`, up to 4,000 characters); `sp_help_jobhistory` has no
  `instance_id` filter and returns at most 1,024 characters, so on the role path the pane shows the captured row's message
  and says "msdb returns at most 1,024 characters to this login" when it is that long.
- History cap text ("Agent keeps 1,000 history rows, 100 per job") shows only when it was read: through
  `msdb.dbo.sp_get_sqlagent_properties` (undocumented, allowlisted read; sysadmin until AG-0's spike shows other roles get
  values). Other logins see no cap text.
- Delete History (sysadmin and Operator; other logins only when the capability read says they have EXECUTE on
  `sp_purge_jobhistory`, which msdb grants only to SQLAgentOperatorRole by default, and they own every checked job,
  because the procedure then raises 14392 for another owner's job; otherwise the button is disabled with the reason;
  229 and 14392 both map to `PERMISSION_DENIED`) from the Log File Viewer's toolbar for the jobs checked in its sources: all their
  history, or only rows **older than** a date (SSMS's option; `@oldest_date`). One `sp_purge_jobhistory @job_id [,
  @oldest_date]` call per job in one transaction. The cut-off is computed on the server, in the server's local time that
  `sysjobhistory` uses: the template sets `@oldest_date` by a constant `CASE @unit WHEN 1 THEN DATEADD(day, -@count,
  GETDATE()) WHEN 2 THEN DATEADD(week, …) WHEN 3 THEN DATEADD(month, …) END`, with count and unit as parameters, so a
  client in another time zone cannot shift it; the dialog shows the cut-off labelled "(server time)" when the offsets
  differ. The unit is bounded 1..3 in zod and C#, "all history" is its own explicit choice (not a NULL unit), and the
  template THROWs when a unit was given but `@oldest_date` came out NULL, since `sp_purge_jobhistory` treats a NULL
  `@oldest_date` as "all history". A renderer test covers the label and the live Delete History check covers the cut-off. Without a job argument msdb purges every job on the server, so zod and C#
  require 1 to `agentLimits.historyJobs` job ids and the template refuses a NULL `@job_id` before calling. The confirmation
  names the jobs, the cut-off and that it cannot be undone. Server-wide purges exist only in Agent Properties (AG-8a).
- Agent error logs: `xp_readerrorlog <n>, 2` with the search text as its parameters, sysadmin only (Managed Instance:
  `sp_readmierrorlog` per the gates). It cannot page, so it is read newest first (sort `N'desc'`) and `AgentReader`
  reads at most `agentLimits.logRows` rows, cancels the rest and shows a notice that only the newest rows were read
  (mocked). Same grid, filters and export (Copy / Save through `ResultTextWriter`).
  Recycle: `sp_cycle_agent_errorlog`, behind a confirmation.
- Empty, loading and error states (mocked): "No history for the selected jobs in this window", "This job has never run",
  a skeleton while loading, and a failed read shown in place with its reason and Retry. History is never "off" (an unlimited
  log is still a log), so there is no such state.

## Alerts, operators, proxies, credentials, schedules, error logs, Database Mail

| Area | 0.10.0 | Later |
| --- | --- | --- |
| Shared schedules | Schedule dialog, Pick, Jobs in Schedule, Manage Schedules: Delete offered for any schedule the login owns (sysadmin: any), never judged "unused" from Jobs in schedule counts; `sp_delete_schedule` without `@force_delete`, whose in-use refusal maps to `IN_USE` with msdb's message (an `AgentActions` check) | |
| Job categories | Category picker | Manage Job Categories dialog |
| Operators | List, New / Properties (General: name, enabled, e-mail, pager and on-duty schedule; Notifications: alerts and jobs; History), Enable/Disable, Rename, Delete, Script As | Fail-safe operator (Agent Properties › Alert System) |
| Alerts | List, New / Properties (General: SQL Server event by error number or severity with database and message text; performance condition with object, counter and instance from `sys.dm_os_performance_counters` when the login has VIEW SERVER STATE, typed otherwise; Response: run job, notify operators; Options: include error text, delay between responses), Enable/Disable, Rename, Delete, Script As | WMI event alerts editable (shown read-only) |
| Proxies | List by subsystem, New / Properties (General: name, credential, description, subsystems from `syssubsystems`; Principals; References), Rename, Delete, Script As | |
| Credentials | New Credential and Credential Properties on the existing Security › Credentials folder (kind `credential`) and from the Proxy dialog: name, identity, secret, encryption provider. `ALTER CREDENTIAL` resets the secret when `SECRET` is omitted, so in Properties the Identity and secret are read-only until "Change identity and password" is checked, and every ALTER sends both | |
| Error logs | List, view in Log File Viewer, Recycle | Configure (log path, level) via Agent Properties › General |
| SQL Server Agent Properties | General (auto restart SQL Server, auto restart Agent, error log file read-only), History (max rows, per job) through `msdb.dbo.sp_set_sqlagent_properties` (undocumented, what SSMS calls; allowlisted; read-only on Managed Instance). History's "Remove agent history older than" is not a setting: as in SSMS it is a one-shot purge of **all** jobs' history on OK (`sp_purge_jobhistory @oldest_date`, sysadmin), behind its own destructive confirmation; it is its own allowlisted template with its own lint entry (it passes no `@job_id`, which Delete History's template refuses) and shares only the server-computed `CASE @unit … DATEADD(…, GETDATE())` cut-off statement, its bounds and its NULL-date THROW, and the confirmation labels it "(server time)" when the offsets differ (renderer test; AG-8a's live check covers the cut-off) | Advanced, Alert System (mail profile, fail-safe), Job System, Connection |
| Agent service | State and chips; Start / Stop / Restart | |
| Database Mail | Readiness (in AG-6a, where the Notifications page shows it; AG-7 reuses it): `Database Mail XPs`, `sysmail_profile`, and for sysadmin also Agent's own mail settings from `sp_get_sqlagent_properties` (`use_databasemail`, `databasemail_profile`), because Agent sends nothing without a profile set in Alert System (a Later page, so the warning says to set it in SSMS) and a restart after setting it. Only sysadmin and DatabaseMailUserRole get a warning; others see none; on Managed Instance the profile must be `AzureManagedInstance_dbmail_profile`. Warn on e-mail notifications when not set up | Configuration wizard and Database Mail log |
| Multi-server (MSX/TSX) | Targets page shows local only | Multi-server administration |
| Script Action to Job | | The "Agent Job…" Script As destination and dialogs' "Script Action to Job" |

## SQL rules

- **Reads** (tree, describe, history, Job Activity Monitor, chips): constant text per query, version band and role path,
  values as parameters, no metadata built-ins beyond the capability read's. Isolation and lock timeout are each caller's
  own: live probes and listings use their pools' prologues (`READ UNCOMMITTED`); describe reads use the action read
  connection's (`READ COMMITTED`, `LOCK_TIMEOUT 10000`), as other object dialogs. `AgentReader` runs the role-path and
  procedure statements one by one, and every Agent read that `EXEC`s, in any caller (live, listing, Search Objects,
  describe), is checked by `AgentSql.LintRead`, a new rule: `LiveSql.Lint`'s rules plus two exemptions. A statement may
  be exactly `EXEC msdb.dbo.<procedure> @arg = @param, …` (named arguments, parameters or the constants the catalogue
  lists per procedure, such as `@mode = N'FULL'`) for a procedure in `AgentSql.ReadProcedures` (`sp_help_job`,
  `sp_help_jobhistory`, `sp_help_jobactivity`, `sp_help_jobstep`, `sp_help_jobschedule`, `sp_help_schedule`,
  `sp_help_category`, `sp_help_operator`, `sp_help_alert`, `sp_help_notification`, `sp_help_proxy`,
  `sp_enum_login_for_proxy`, `sp_help_jobs_in_schedule`, `sp_enum_sqlagent_subsystems`, and `sp_get_sqlagent_properties`, sysadmin-only unless AG-0's spike says otherwise).
  And the master procedures, which take positional arguments, each have a named shape: `EXEC master.dbo.xp_enumerrorlogs
  2;`, `EXEC master.dbo.xp_readerrorlog @p1, 2, @p2, @p3, NULL, NULL, N'desc';` and, on Managed Instance, `EXEC
  master.dbo.sp_readmierrorlog @p1, 2, @p2, @p3` (with the same sort arguments if it accepts them, which AG-0 checks;
  otherwise it caps from the oldest and the notice says so) (the only literals allowed are the log type `2`, `NULL` for
  the time bounds and `N'desc'`; AG-0 confirms on Managed Instance's documentation and,
  if one is available, an instance that log type 2 returns the Agent log there). Lint tests render every allowed shape and reject near misses.
  `sp_enum_proxy_for_subsystem` is not used: sysadmin reads `sysproxies`/`sysproxysubsystem` directly, others call
  `sp_help_proxy`. `LiveSql.Lint`, `CatalogSql.Lint` and `ActivitySql`'s lint stay as they are; new `CatalogSql` Agent statements use
  `CatalogSql.Lint`'s existing per-statement `literals` argument with exact lists. `INSERT … EXEC` is never used
  (`sp_help_job` nests one itself); results are read into backend memory, capped, and paged or filtered there.
- **Writes**: inside `ActionService` (its own unpooled, never-retried connection, preflight in the same connection, Stop,
  `LOCK_TIMEOUT -1`, reader-only execution, no logging), templates in `Agent/AgentSql.cs` checked by
  `AgentSql.LintExecutable`, which `ActionSql.Lint` chains as it does `LoginSql`. Besides the guard statements (identity
  and `STALE` checks, the purge cut-off's `SET @oldest_date = CASE … END` and its NULL-guard THROW, all constant text the
  lint admits by named shape), every call is
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
  `<secret>`. Backend side: `ActionService.SecretActions` (today createLogin and loginProperties) gains the two credential
  actions; the secrets record (`LoginSecretsDto`, Password and OldPassword) gains a `Secret` field with its own length
  limit (a credential secret is not a login password), mirrored in the zod secrets schema; `Secret()` picks the limit by
  field.
- **Service control**: `EXEC @rc = master.dbo.xp_servicecontrol @action, N'SQLServerAgent';` with `@action` in
  `N'Start'`, `N'Stop'`, `N'QueryState'` as a parameter; `LintExecutable` allows exactly this positional shape, with
  `N'SQLServerAgent'` its only literal, beside the `EXEC @rc = msdb.dbo.<proc> @arg = @param` shape. `xp_servicecontrol` maps the constant `SQLServerAgent` to the
  connected instance's Agent (`SQLSERVERAGENT` or `SQLAgent$<instance>`), as the QueryState fact showed; the Windows CI job
  proves it on a named instance. Restart is Stop, then the action itself re-reads `QueryState` (ActionService has no live
  probes) on its own connection under the `AgentSql` lint until it reads stopped, bounded by a catalogue deadline and
  Stop-able, then Start. Sysadmin and Windows servers only, not on a failover cluster instance; confirmation first, through
  ActionService. "Access is denied" (the engine's virtual account may lack the right on the Agent service) maps by its
  error number (AG-0) to a `PERMISSION_DENIED` value with a sentence naming the account. This deliberately differs from
  SSMS, which controls the service from the client computer through WMI: Varia goes through the engine so it needs no
  Windows rights or network path to the server, and works the same from Linux and macOS clients. If AG-0 finds it cannot
  work on default virtual accounts, the lane comes back to the owner. States, each mocked and in the renderer fixtures:
  Starting… / Stopping… on the node and in the dialog until `QueryState` agrees (the next `explorer.agentService` sample
  then takes over); "Access is denied" naming the engine's service account; a Restart whose Stop succeeded but whose Start
  failed or timed out, which says "SQL Server Agent was left stopped" and offers Start again; and Cancel restart (the
  dialog's button, never a bare "Stop"), which after Stop leaves Agent stopped and says so.
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
| Existing `explorer.*`, `live.subscribe` | Agent kinds; new live sources `agent.jobs` (probes `agent.jobs.list`, `agent.jobs.watched`, `agent.jobs.service`), `agent.history`, `agent.tree` (probe `agent.treeProbe`), and the new `explorer.agentService` probe in the existing `explorer` source | Each new source needs a `liveSourceIds` entry, probe ids in `liveProbeIds`, a `LiveService.CreateSampler` case and a C# args check; args bounded in the live catalogue's schemas |

Error codes: action code `STALE` (the name already exists for the shortcuts save; the action row adds its own message,
not retryable) and new action codes `AGENT_STOPPED` and `JOB_STATE` (decided after msdb 22022 by a re-read, and 15281);
msdb's 14xxx numbers join the existing `NOT_FOUND`,
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

- **CI**: add `MSSQL_AGENT_ENABLED: 'true'` to the live and smoke `mssql/server:2022-latest` services in `.github/workflows/ci.yml` (not bench-linux's, where Agent would add noise and no benchmark needs it)
  (pinned by `tests/ci-workflow.test.ts`) and to `.claude/hooks/session-start.sh`'s `docker run`, and set
  `VARIA_TEST_SQL_AGENT=1` in both. Agent starts after the container's `SELECT 1` health check passes, so Agent suites wait
  on a condition (a `SQLAgent - %` session or a new `syssessions` row) with a generous timeout that returns early, then
  fail if Agent never came up. The existing `ExplorerStatusLiveChecks` Agent check gates on `sys.dm_server_services`; AG-0
  makes it use the same Agent-up condition so it stops skipping silently on Linux. Linux Agent runs T-SQL steps only, so
  CmdExec and PowerShell steps are covered by offline lint and script tests in every CI run, live (`AgentSteps`) in the
  Windows service-control workflow when it runs and on the owner's Windows test instance; SSIS steps live only on the owner's instance
  (the CI job installs no SSIS), in `AgentSteps` behind its own opt-in `VARIA_TEST_SQL_AGENT_SSIS=1` (it needs SSISDB and a
  deployed scratch package, as the SSIS suites' existing opt-in does).
- **`VARIA_TEST_SQL_AGENT=1`** (new, docs/testing.md): Agent live suites require Agent and fail if it does not come up;
  without the variable they skip with one line saying why.
- **`VARIA_TEST_SQL_AGENT_SERVICE=1`** (new): the `AgentService` live suite really stops, starts and restarts Agent through
  the action, waiting on `QueryState` and an Agent session (conditions, generous timeouts), and always leaves Agent running
  in `finally` (Start, then a wait). It is set on the owner's test instance (which exists only for testing Varia) and in the
  Windows workflow below, never in the Linux CI jobs, where the feature is hidden; there the suite asserts only that service
  control is refused as `NOT_SUPPORTED` — that assertion lives in `AgentActions`, which runs everywhere. Other Agent suites
  never stop Agent. `backend:test` takes only a shared machine lock, so `AgentService` is excluded from the grouped and full
  live runs: `LiveGroups` gains an explicit excluded set (today every suite in `Suites` is split into groups), its
  `--live-suite` option accepts a comma-separated list, and the suite runs only through its own command
  (`npm run backend:test:agent-service`, running `--live-suite AgentService,AgentSteps` under `scripts/machine-lock.mjs
  exclusive`), so no other session's Agent checks run on the instance while Agent is stopped. `AgentSteps` holds the
  CmdExec and PowerShell step checks, which skip where the platform has no such subsystem. docs/testing.md says so.
- **Windows service-control workflow** (`.github/workflows/agent-service.yml`, AG-2), kept out of `ci.yml` on purpose:
  `ci.yml`'s rule that every code-changing PR runs every validation job (pinned by `tests/ci-workflow.test.ts`) stays as it
  is, and a path-gated job there would also be cancelled by a later unrelated main push. One `windows-latest` job installs
  SQL Server Developer as a **named instance** with Agent (installer and caching settled and timed in AG-2), then runs
  `AgentService` and the Windows-only step checks (CmdExec, PowerShell) with `VARIA_TEST_SQL_AGENT=1` and
  `VARIA_TEST_SQL_AGENT_SERVICE=1`. It runs only when needed: on pull requests whose changes touch its `paths:` list
  (`backend/Varia.Backend/Agent/**`, the Agent action templates and lint, the `AgentService` suite, the workflow itself),
  daily on main (as `bench-desktop.yml` runs), and by hand. It is not a required check (a `paths:` filter on a required
  check would block unrelated PRs), so the merge rule is stated in docs/ci.md: a PR on which it ran merges only when it is
  green. It has the PR-keyed concurrency group with `cancel-in-progress: true` that `tests/release-workflow.test.ts`
  requires of every workflow with a `pull_request` trigger. A new `tests/agent-service-workflow.test.ts` pins its triggers,
  paths, concurrency and job; docs/ci.md gains its measurements.
- **Scratch objects**: Agent objects are server-level, in msdb. Scratch jobs, schedules, operators, alerts, proxies,
  credentials, logins and msdb users are named with the run prefix `VariaScratch_<yyyyMMddHHmmss>_<8 hex>_` and an explicit
  kind tag (`_job`, `_sch`, `_op`, `_al`, `_px`, `_cr`, existing `_l` for logins), in the existing exact-pattern style, carry
  `ScratchDatabase.JobMarker` (description) where the object has one, and are dropped in `finally`. Hostile-name checks
  use fixed hostile suffixes after the tag, enumerated per kind in the existing style (as `_lr]' --` and `_ld]' --` are
  for logins), with the 128-character case as one more fixed literal, so every pattern stays an exact alternation; the
  offline checks in Program.cs that pin `JobPattern` and `LoginPattern` (rejecting `_job2`, `_x_job`, `_x`) keep passing
  and gain the new kinds' accepted and rejected names. The job sweep moves from `ExplorerStatusLiveChecks.AgentAsync` into `ScratchDatabase.SweepAsync`,
  which gains one sweep per kind; age comes from the prefix's timestamp, so kinds without a date (operators, credentials,
  logins) are swept too, except that logins keep today's `create_date` age so the existing "older than 6 hours" rule and
  its summary hold. Sweep order follows dependencies: proxies, then credentials, then jobs (and their owned schedules),
  alerts, operators, then msdb users, then logins; today's login sweep, which runs right after databases, moves after the
  Agent sweeps (a login that still owns a job fails `DROP LOGIN` with 15170). No scratch category is created (a shared category could not
  be dropped while another run uses it). A check of Agent Properties' writes (server-wide) restores the old values in
  `finally`.
- **Destructive paths**: Delete History is checked live with two scratch jobs, proving only the checked job's rows go and
  that "older than" keeps newer rows. The server-wide purge (AG-8a) never deletes real history in a test: offline tests
  render its template, and its live check passes the largest allowed count with unit 3 (months; the count bound in zod
  and C# is 1,200, far before any history and far from `DATEADD` overflow) and asserts the call returns 0 with no THROW
  and that the history rows of the suite's own `WAITFOR` scratch job (a before-and-after snapshot of their
  `instance_id`s) all remain. It never compares the server-wide row count, which other sessions' suites, real jobs and
  the history cap change at any time. docs/testing.md records both. Scratch job runs add rows to Agent's server-wide history cap (default 1,000), pushing out the oldest rows of
  real jobs on a shared server: suites keep runs few (one `WAITFOR` job per suite), and docs/testing.md says so.
- **Live suites** (each with its seconds in `LiveGroups.Suites` and docs/ci.md's table): `Agent` (tree, capability, the Search Objects Agent batch refused for a no-role login while other kinds still index, both
  read paths with low-privilege SQL logins in each Agent role), `AgentJobs` (a scratch job with a `WAITFOR DELAY` T-SQL
  step: start at step, stop, enable/disable, status transitions through the live source, the In progress run and its
  grouping, waits on conditions only), `AgentActions` (every write template against hostile names, Script Action's script
  builds the same object, identity and `STALE` guards with two sessions editing one job and with another job's dialog
  editing a shared schedule, which `version_number` bumps, a failing middle step commits nothing, each msdb error number
  maps to its code with the refused call's index, Delete History refuses an empty job list), `AgentRoles` (a
  SQLAgentUserRole login opens and saves its own job through the describe role path; Reader sees others' jobs read-only;
  Operator starts another's job; a default SQLAgentUserRole login is refused Delete History with
  `PERMISSION_DENIED` (229) even for its own job, and the capability read reports no EXECUTE; tests never grant EXECUTE
  on msdb objects; an Operator login deletes the history of another owner's scratch job and the capability read reports
  EXECUTE for it; a Reader login reads another owner's running job's start time through `sp_help_jobactivity`), `AgentScripting` (SMO scripts vs SSMS goldens in `tests/fixtures/scripting/`),
  `AgentCredentials` (secret never in a reply or script, hostile names, an identity-only edit refused), `AgentService`
  and `AgentSteps` (above; excluded from grouped runs, run by their own command).
- **Offline**: `AgentSql.LintRead`, `LintExecutable` and `CredentialSql` lints render every variant; schedule encoding and
  sentence table tests; history grouping (the cases above) and time decoding table tests; msdb error mapping; catalogue
  snapshot; zod/C# limit mirrors; the step save planner; the `ExplorerStatusService` probe list without repeats.
- **Renderer vitest**: `agent.tree` change samples reload only the changed folder and keep expansion and selection;
  fixtures for states the live smoke cannot reach: each Agent role, Managed Instance, Linux,
  Express, failover cluster, Agent stopped, Agent service Disabled, Agent XPs disabled (stopped and running; tree, and `AGENT_DISABLED` in Job Activity Monitor, the status bar and the
  Log File Viewer), state
  unknown, `PERMISSION_DENIED` mid-dialog, `STALE`, `AGENT_STOPPED`, `JOB_STATE`, a save failure with no part index, empty,
  loading and failed history and Job Activity Monitor, error-log truncation, role-path history (1,024-character message,
  no elapsed time for a running job whose `start_execution_date` is NULL, the Delete History disabled reason
  for a login without EXECUTE on `sp_purge_jobhistory`, Delete History enabled for Operator with another owner's job
  checked, and a sysadmin-path start time taken from the current session's row when an older session's row has a start
  and no stop), the job Alerts page hidden for User and Reader, every service-control
  state (Starting…, Stopping…, access denied, left stopped, Cancel restart), and the status-bar job with and without a
  free status-only slot.
- **Smoke**: `scripts/agent-smoke.mjs` on the fake backend (tree, Job Activity Monitor grid with multi-select Start Jobs,
  the status-bar running job, job dialog round trip, Log File Viewer, the Start/Stop/Restart confirmations and progress,
  Ctrl+Q revealing a job, and the keyboard contract: Job Activity Monitor's Shift/Ctrl selection, Ctrl+Space and Ctrl+A,
  the Log File Viewer's F6 / Shift+F6 pane cycle, Space on a source and the parent's `aria-checked="mixed"`), surfaces found by ARIA role and name through `scripts/fixtures/ui.mjs`, added to `test:smoke`,
  `smoke-shards.mjs`'s times and docs/ci.md's table. Shards with a SQL Server gain the Agent node in their trees; AG-1
  updates the explorer smoke's expectations.

## Keyboard and accessibility

Smoke suites find surfaces by ARIA role and name, so these are part of the design:

- **Tree**: Agent rows are `treeitem`s whose accessible name includes the state chip text ("SQL Server Agent, Stopped",
  "Index maintenance, Running, step 2 of 4"); chips are not separate tab stops. Context menus as every tree kind.
- **Job Activity Monitor**: the grid is a `grid` with `aria-multiselectable="true"`; Up/Down move, Shift+Up/Down and
  Shift+click extend, Ctrl+click and Ctrl+Space toggle, Ctrl+A selects all visible rows; Enter opens Properties, Delete is
  not bound (jobs are deleted from Object Explorer, as SSMS), F5 refreshes now. View chips are a `radiogroup`; tiles are
  buttons: Running, Last run failed and Disabled apply their chip, Between retries applies a Status column filter (it has no
  chip). The live indicator is a `status` region announcing errors only, never each sample.
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
| AG-0 | Foundations: `src/shared/agent/catalog.ts` (code tables, gates, decoding, limits, docs generation), `agent.profile` and `agentRole` keys, `AgentReader` + `AgentSql.LintRead`, CI `MSSQL_AGENT_ENABLED` and the Agent-up wait, `VARIA_TEST_SQL_AGENT`, scratch prefix and sweep extension, Agent live suite skeleton; spikes on the owner's test instance: `sp_help_job` while stopped, the Agent XPs value after a clean Agent stop and error 15281, msdb procedures that roll back themselves (266), `xp_servicecontrol` with `SQLServerAgent` on virtual accounts and its "Access is denied" number, `version_number` bumps, msdb error numbers, the `dm_server_services` permission on 2022+ (and the probe split if needed), the Linux DMV | — | M |
| AG-1 | Object Explorer: catalogue singleton children and `opens` leaves (with C# `Served`, docs and tests), Agent node, Job Activity Monitor leaf, folders and `agentProxySubsystem`, the session sysadmin column and reader session facts, both listing paths, edition gate (`ExplorerProfile` edition; existing Linux and Managed Instance flags), platform-gate verification, `explorer.agentService`, Agent node chips, per-probe reader routing in `SqlSampler` and the role path of `explorer.agent` (updating `ExplorerStatusLiveChecks`), XPs-disabled state, `agent.tree`, Search Objects batch, icons, menus with not-yet verbs hidden (Agent node New › appears with AG-6a's Job…), Ctrl+Q reveals Agent objects | AG-0 | M |
| AG-2 | Job verbs from the tree: Start Job at Step, Stop, Enable/Disable, Rename, Delete; `AgentSql.LintExecutable` with return-code checks, the identity guard and msdb error mapping (`AGENT_STOPPED`, `JOB_STATE` after 22022, `STALE` codes registered); Agent service Start / Stop / Restart with every state; the `AgentService` suite under the exclusive lock and the path-gated `agent-service.yml` workflow | AG-1 | M |
| AG-3 | Job Activity Monitor: `agent.jobs` live source, document with LiveGrid, tiles, view chips, filters, multi-select row actions with Start Jobs / Stop Jobs progress, loading, error and Agent-stopped states, server-time labels; status-bar running job (`agent.jobs.watched`), Agent-stopped probe (`agent.jobs.service`) | AG-1 (AG-2 for actions) | M |
| AG-4 | Script As for Job, Alert, Operator, ProxyAccount (UrnBuilder JobServer children, scripting catalogue rows, goldens, role check) | AG-1 | S |
| AG-5a | Log File Viewer: `agent.history` live source (both paths), run grouping with In progress and Unknown, master/detail grids, details pane, `agent.historyMessage`, Delete History for checked jobs (all or older than), start times through `sp_help_jobactivity`, role-path message limit, cap text from `sp_get_sqlagent_properties` | AG-1, AG-2 (write path) | M |
| AG-5b | Agent error logs in the Log File Viewer: `agent.errorLogs`, `xp_readerrorlog` / `sp_readmierrorlog` capped reads with the truncation notice, Recycle | AG-5a | S |
| AG-6a | Job dialog shell: describe (both paths), General, Notifications (with the Database Mail readiness warning), Targets (local), Alerts list (Add hidden until AG-7), one-transaction save with `STALE`, Script Action, New Job (also from the Agent node's New ›, which appears with it), Ctrl+Q opens job Properties | AG-2 | M |
| AG-6b | Steps page, the step save planner, and step dialog (T-SQL with editor features and Parse, CmdExec, PowerShell, SSIS package, Advanced) | AG-6a | L |
| AG-6c | Schedules: `schedule.ts` encoding and sentences, schedule dialog (CPU-idle warning), Pick, Jobs in Schedule, Manage Schedules, Remove with delete offer; Agent node New › Schedule… | AG-6a | M |
| AG-7 | Operators and Alerts: dialogs (all pages), Enable/Disable, Rename, Delete; performance counter picker; Agent node New › Operator… and Alert…; job dialog Alerts page Add | AG-1, AG-6a (shared dialog parts) | M |
| AG-8a | SQL Server Agent Properties (General, History) through `sp_set_sqlagent_properties`, read-only on Managed Instance; the one-shot "Remove agent history older than" purge with its confirmation | AG-1, AG-2 (write path) | S |
| AG-8b | Proxies: New / Properties (General, Principals, References), Rename, Delete, Agent node New › Proxy…; New Credential and Credential Properties (`CredentialSql`, generalised secret slot, identity and secret always sent together) | AG-1, AG-6a | M |
| AG-9 | Getting Started guide and sample for Agent, parity re-check of the Agent rows | all | S |
| Later | Manage Job Categories, multi-server targets, Script Action to Job, output file and table log viewers, Activity Monitor job links, SQL Server Logs and Database Mail in the Log File Viewer, Agent Properties' remaining pages and fail-safe operator, WMI alert editing, Elastic Jobs | | |

Suggested waves: AG-0 → AG-1 → {AG-2, AG-4} → {AG-3, AG-5a, AG-6a, AG-8a} → {AG-5b, AG-6b, AG-6c, AG-7, AG-8b} → AG-9.
Lanes that touch the Agent tree menus or the actions catalogue (AG-2, AG-6a, AG-7, AG-8a, AG-8b) merge main in after each
lands, as the Activity Monitor lanes did.

Coordination with BigQuery: AG-1 and BQ-5 both extend `src/shared/explorer/catalog.ts` and its generated
docs/object-explorer.md and `explorer-catalog.json`. Land AG-1 before BQ-5 starts, or rebase whichever is second; neither
needs the other. BQ-0's `providers` default covers Agent's entries whichever lands first.

## Questions still open

None blocking. AG-0's spikes and AG-1's platform-gate verification report back in their PRs. If service control cannot
work on default virtual accounts or a named instance, or the Windows CI job cannot install SQL Server in a reasonable time,
that comes back to the owner before AG-2 merges.
