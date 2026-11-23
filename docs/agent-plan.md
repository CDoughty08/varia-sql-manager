# SQL Server Agent plan (0.11.0)

Status: **agreed with the owner on 2026-11-15** (decisions below), revised after adversarial review, UI rethink adopted
on 2026-11-16, lanes rewritten to the document model on 2026-11-18. Implementation starts with AG-0a. This page is the plan of record for the Agent lanes; each lane's PR updates the area's own page (a new
docs/sql-server-agent.md, generated below a marker like docs/integration-services.md) and moves the lane's row here to Done.

Agent is planned for 0.11.0. 0.10.0 focuses on BigQuery (docs/bigquery-plan.md); Agent lanes run beside it without getting
in its way (Coordination with BigQuery, after Lanes) and stay hidden until 0.11.0. SSMS 2022/22 is the parity target for names,
menus, keys and behaviour; visuals follow Calm Pro.

Mocks of every new or changed surface: [docs/mockups/sql-server-agent.html](mockups/sql-server-agent.html) (open it in a
browser; Dark and Light, a picker per surface, design notes as dashed boxes). Each lane's PR builds what its mock shows, or
updates the mock in the same PR when the design changes.

## Owner decisions (2026-11-18)

- **Start implementation** beside BigQuery, without heavily conflicting with it: AG-0a (new files only) starts now, lanes
  that register methods, keys or catalogue entries wait for BQ-0, and the shared-file order is in Coordination with
  BigQuery. The rethink scenes were reviewed and the lanes below are rewritten to the document model.
- **Release gate**: agreed as proposed in Coordination with BigQuery (`agentEnabled`, `VARIA_AGENT_PREVIEW=1`, removed in
  AG-9).
- **Create from… schedules** default to **Share**; the user can switch a schedule to Copy or Leave out.
- **Agent service control: the Windows route, state only elsewhere.** AG-0 found `xp_servicecontrol` Start and Stop
  refused on default installs: it runs as the engine's service account, which has no service rights. SSMS instead calls
  the server machine's Service Control Manager as the user's own Windows account, so it works wherever that user is an
  administrator on the server. Varia does the same: Start, Stop and Restart run from a **Windows client** against a
  **Windows server**, as the signed-in Windows user (Service control in SQL rules). On macOS and Linux clients, and for
  Linux servers, Managed Instance and failover cluster instances, Varia shows Agent's state only, with the actions
  disabled and the reason. Other platforms are revisited later. This replaces the 2026-11-15 `xp_servicecontrol` design.

## Owner decisions (2026-11-16)

- **Release**: Agent moves from 0.10.0 to 0.11.0 so 0.10.0 can focus on BigQuery. Until then only the plan and mocks are
  polished.
- **UI rethink adopted** ([docs/agent-ui-rethink.md](agent-ui-rethink.md)): Agent objects become document tabs with
  in-place editing and inline creation, replacing the stacked child dialogs decided on 2026-11-16. Agent's first release
  takes the rethink's first two tiers plus Create several.
- **Review the mocks first**: every view the rethink changes gets a "Rethink" scene in the mocks, and the SSMS-style scenes
  stay as reference. Done on 2026-11-18: the lanes are rewritten; the sections keep their
  SQL and rules and read "document" for "dialog" (Lanes).

## Owner decisions (2026-11-15)

- **Plan home**: this docs page plus the mocks, in a docs-only PR (as docs/bigquery-plan.md), pushed only with mocks for
  all new and changed UI in Varia's style.
- **Agent service control**: Start, Stop and Restart in 0.11.0, behind a confirmation. **Must ship** (lane AG-2).
  Revised on 2026-11-18: the Windows route, not `xp_servicecontrol` (above).
- **Proxies and credentials**: full dialogs in 0.11.0: New and Properties for proxies (General, Principals, References),
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
- **Scope cut if 0.11.0 runs long**: must ship AG-0 to AG-6c; may slip AG-7 (operators and alerts dialogs), AG-8a (Agent
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
which Agent reads raise 15281 with Agent XPs off (expected of `sp_help_job` through `sp_get_composite_job_info`'s
`xp_sqlagent_*` calls, but AG-0 found it does not; `sp_help_jobactivity` and `sp_help_jobhistory @mode = N'FULL'` contain no `xp_sqlagent` call, and
the sysadmin path reads `sysjobhistory` directly, so history is expected to stay readable; the Log File Viewer's running state comes from `agent.jobs`, which AG-0 found does not fail (every job reads Idle),
so its banner comes from Agent's state (the service probe and `Agent XPs`), and if a history read also raises 15281 its view ends with `AGENT_DISABLED` and is
restarted by the Log File Viewer's refresh of both handles, below);
whether `sp_get_sqlagent_properties` returns values to a SQLAgentUserRole login (msdb grants that role EXECUTE and the
procedure has no sysadmin check, but it reads through `xp_instance_regread`, which may refuse non-sysadmin callers; until
then the plan treats it as sysadmin-only, and if it works the cap text, idle-CPU and mail facts show to every role that
can run it, with any refusal number mapped to "not read"; AG-0 found it does); what
`sp_help_job` and `xp_sqlagent_enum_jobs` return while Agent is stopped; that `xp_servicecontrol N'Start'|N'Stop',
N'SQLServerAgent'` works under the default virtual accounts and for a named instance (the CI job installs one); how its failures
surface (a probe of `QueryState` on a missing service showed every `xp_servicecontrol` failure arrives as engine message
22003, a reused number, with `@rc = 1` and `@@ERROR` 0, the Windows code only in the xp's fixed "returned error <n>," text); which msdb calls bump `sysjobs.version_number` and `sysschedules.version_number`; the
msdb error numbers the action mapping needs; and what the Linux container's `sys.dm_server_services` lists.

AG-0a ran these on 2026-11-18; the results are in docs/sql-server-agent.md › What AG-0 found on a real server. Two change
the plan: `xp_servicecontrol` Start and Stop are refused ("Access is denied", Windows error 5) under the default virtual
accounts, so service control (AG-2) comes back to the owner; and `sp_help_job` does not raise 15281 with Agent XPs off
(it reports every job idle), so Agent's state comes from the service probe and `Agent XPs`, never from a failed job read.
`sp_get_sqlagent_properties` returns values to SQLAgentUserRole.

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
  control, no Agent Properties writes (mssql-conf sets them; Delete old history still runs).
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
needs; `sys.dm_server_services` may need VIEW SERVER SECURITY STATE there, so AG-0 settles which permission each
part needs; `explorer.agentService` and `agent.jobs.service` stay one ungated probe each, guarding the DMV part and the
session fallback with their own `HAS_PERMS_BY_NAME` checks (a catalogue `permission` would make the probe unavailable and
lose the ungated `Agent XPs` read that recovery, the re-list and the sublabel need), so no probe split and no new
permission kind; before 2022 both are VIEW SERVER STATE), `ALTER ANY CREDENTIAL`, `SERVERPROPERTY('IsClustered')`, the `Agent XPs` value from
`sys.configurations`, and whether Database Mail can be read. It is cached per connection in a renderer `AgentProfileService` (keyed by connection id, read when the server's
children are first listed, so the collapsed Agent node already has it, and before that the role is `unknown`: the
`noAccess` badge is absent, Start/Stop/Restart and Properties are disabled with "Reading this login's Agent role…", and
the read is also started when the Agent node's context menu or an Agent palette command opens (vitest of the node menu
before the profile arrives); if the read fails with 916 (no msdb access: it runs through `msdb.sys.sp_executesql`) the
role is `none` with a no-msdb flag (the server facts then come from a second read at server scope), so the `noAccess` badge still shows; any other failure (deadline, error) is
`profileFailed`, whose disabled reason is "Could not read this login's Agent role: <reason>. Refresh to retry." and
Refresh re-reads it (vitests for 916, a failure and the retry; a live `AgentRoles` check with guest CONNECT revoked on a
scratch database login where practical; mock note on `oe-unknown`), re-read on Refresh of the Agent node and on reconnect, dropped on disconnect) that
`ExplorerService` takes through `useAgentProfiles`, re-publishing context keys when it changes (vitest that the role and
service-control keys follow it), and drives
the tree, the menus (target-scoped context key `agentRole`: `sysadmin | operator | reader | user | none | unknown | profileFailed`, each in the menu `when` and
reason tables, plus
`explorerSelectionAgentRole`) and the read path. It is a `CatalogSql` statement linted by `CatalogSql.Lint` with its own
exact per-statement `literals` set (as Peek's rows batch; the role names, `N'sysadmin'`, the `HAS_PERMS_BY_NAME` object
and permission names, `N'IsClustered'`); `Agent XPs` is read as `value_in_use` (not `value`, which
`sp_configure` changes before `RECONFIGURE`) by `configuration_id = 16384`, as in every Agent XPs read in this plan, so no option-name literal is
needed. The `msdb.sys.sp_executesql` wrapper stays outside the linted text, as `ModuleCall`'s does. ExplorerChecks
renders and lints it.

| Login | Tree shows | Can do |
| --- | --- | --- |
| sysadmin | Everything | Everything, incl. any job owner, Agent properties, error logs, service control. |
| SQLAgentOperatorRole | Jobs (all), Job Activity Monitor, Alerts, Operators (Proxies sysadmin only as built, see AG-1) | Start/Stop/Enable/Disable any local job; enable or disable any schedule (`sp_update_schedule @enabled` only; Manage Schedules shows Enable/Disable for them); delete history; edit only own jobs. |
| SQLAgentReaderRole | Jobs (all, others' read-only), Job Activity Monitor | View all jobs and history; edit only own jobs; no Delete History by default (needs EXECUTE on `sp_purge_jobhistory`). |
| SQLAgentUserRole | Jobs (own only), Job Activity Monitor (own) | Create and manage own jobs (no Delete History by default: needs EXECUTE on `sp_purge_jobhistory`); T-SQL steps, or other subsystems only through a proxy granted to the login. |
| No msdb access / no role | Agent node with `noAccess` status | Nothing; the node says why. |

Rules: hide what SSMS hides (Alerts/Operators below Operator; Proxies and Error Logs sysadmin only, as AG-1 built them), disable rather than hide
verbs on objects the login can see but not change (others' jobs for Reader), and treat every refusal the server still
returns as a value (`PERMISSION_DENIED`) with the dialog staying open and saying which step was refused. The owner picker
is read-only for non-sysadmin, as in SSMS. Properties of an object the login can see but not change opens read-only, as
SSMS does, instead of failing on OK: the describe reply carries `readOnly` with a reason (Reader or Operator on another
owner's job, "Owned by <owner>: <the login's own Agent role> may view it, not change it"; Operator on an alert, operator or proxy,
since no Agent role has EXECUTE on `sp_add_alert`/`sp_update_alert`, `sp_add_operator`/`sp_update_operator` or
`sp_add_proxy`/`sp_update_proxy`; a non-owner, non-sysadmin on a schedule in Manage Schedules and the schedule dialog;
SQL Server Agent Properties on Managed Instance, "Managed Instance does not allow changing SQL Server Agent properties", in
AG-8a). The Agent node's Properties item is disabled for non-sysadmin logins with "Only sysadmin can read SQL Server Agent
properties" (node-menu vitest); AG-0 found `sp_get_sqlagent_properties` returns values to SQLAgentUserRole, so AG-8a may enable it for every Agent role.
`ObjectDialog` gains a read-only mode for it (for Agent objects, the document's read-only mode, `rx-job-readonly`): every field disabled, OK replaced by Close (primary, focused), and the reason
in the message bar; pages stay navigable; list buttons that change something (Steps' New, Insert, Delete, Move up/down;
Schedules' New, Pick, Remove; Alerts' Add, Remove; Start step) are disabled with the same reason, while Edit stays enabled
and opens the Step, Schedule or Alert dialog read-only the same way; Script stays offered and, since nothing can change,
says "There is no action to be scripted." as SSMS's Script Action does with no changes; New and Delete stay disabled with
the same reason. Read-only carries into the controls of nested dialogs: a read-only schedule's Jobs in Schedule opens with
its checkboxes disabled and Close; a read-only step's Open… is disabled; a read-only alert's Response page disables New
Job… and New Operator… (View Job and View Operator open those read-only when the login may not change them). Credentials
join the rule: a login that sees Security › Credentials without `ALTER ANY CREDENTIAL` opens Credential Properties
read-only with "ALTER ANY CREDENTIAL is needed to change it", and New Credential is disabled with that reason (mock scenes
`job-readonly`, drawn on the Steps page with Start step disabled and an inset of Script's message, `agent-props-mi`,
`oe-user`'s Agent node menu with Properties disabled, and notes on `proxy-references` (non-sysadmin) and
`credential-props` (read-only); renderer vitests for each of those cases, each nested control above,
a nested step dialog opened read-only, and Script's message; the live `AgentRoles` suite asserts the describe returns the
flag for Reader on another's job, Operator on an alert, an operator and a proxy, and a SQLAgentUserRole login on a scratch
schedule owned by another scratch login). A state the login cannot read is unknown, never a guess: Agent state without
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
  sublabel, lists no folders and no Job Activity Monitor singleton (decided by the service probe and `Agent XPs`: AG-0 found `sp_help_job` reports every job idle rather than raising 15281), and still offers Start to sysadmin on Windows
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
  a `tests/live-schema.test.ts` case accepting an `AGENT_DISABLED` tick error cover it. It joins `LiveErrors.IsTerminal`: a non-terminal error backs off (up to the
  larger of `backoffMs` and the interval) and `LiveService.Refresh` never shortens a backing-off probe's delay, whereas a
  terminally stopped probe is restarted by a refresh with its failures reset. So the failing probe stops and the view shows
  the banner. Every view that can stop this way has an XPs signal it holds itself, so recovery needs nothing else to be open,
  and every subscription but possibly the Log File Viewer's history one keeps a running signal probe, so it never ends by
  `AllStopped()`: Job Activity Monitor has `agent.jobs.service`; the
  Log File Viewer holds, beside its `agent.history` view, an `agent.jobs` view of `agent.jobs.list` and
  `agent.jobs.service` for the running state its In progress grouping needs (below), so it gets the same signal; the
  status bar's view of `agent.jobs.watched` also includes `agent.jobs.service`; and Object Explorer's status view has
  `explorer.agentService`. Recovery is level-triggered, not
  edge-triggered (a stop and start inside one signal interval, or a 15281 the signal probe never saw as 0, leaves no
  0 → 1 edge): while the view holds a probe stopped with `AGENT_DISABLED`, the first signal sample taken after that stop
  that reports XPs 1 (also after a Start whose service reached Running before Agent turned the option on) makes the view
  send one `live.update` with `refresh: true`, once per stop, which restarts the stopped probes; the Log File Viewer calls `refresh()` on both its handles,
  and a history view that ended with `AGENT_DISABLED` (if AG-0 finds history raises 15281; a view's probes must come from
  its own source, so `agent.jobs.service` cannot join it) restarts through `refresh()`'s re-subscribe path for a
  retryable end, and while ended it shows the warning banner, not the generic ended error (renderer vitest); for Object Explorer that is
  `ExplorerStatusService`, so the role-path `explorer.agent` probe (`sp_help_job`, terminal on 15281 where a read raises it; AG-0 found `sp_help_job` itself does not, so the role path also reads `Agent XPs`) and the running-jobs
  chips come back by themselves alongside `AgentStateSource`'s re-list. A C# offline LiveService check asserts that after
  an `AGENT_DISABLED` stop a refresh makes the probe due at once; renderer vitests cover each view: Job Activity Monitor
  and the Log File Viewer (with Object Explorer hidden, including a 15281 right after their own Start that recovers on the
  next XPs-1 sample, and a stop followed by signal samples that read 1 and never 0) and Object Explorer (a role-path
  `explorer.agent` stop, then an `explorer.agentService` sample reading 1, one `refresh: true` and no second one, and the
  chip back). Agent's own stop sets Agent XPs to 0 (the
  server's error log records the change at each stop), so a plain Agent stop usually arrives as `AGENT_DISABLED` with the
  service Stopped; the views therefore decide by `agent.jobs.service`'s service state. The status-bar watched job: service
  Stopped means the job ended, so it shows "Agent stopped, job outcome unknown" once and releases its view and status-only
  slot without re-subscribing; service Running (XPs off while Agent runs) means the job may still run, so it shows "Agent
  XPs off, job progress unavailable", keeps its slot and recovers like the other views; service state unknown (no
  `HAS_PERMS_BY_NAME` permission, the usual case for User and Reader logins) shows "Agent stopped or Agent XPs off, job
  progress unavailable" and keeps its slot until the first XPs-1 sample. Outcome matching: Agent records `last_run_date`/`last_run_time` as the
  run's start in whole seconds, so the Start template reads the server time before `sp_start_job` in the same batch,
  truncated to the second and returned as text (`CONVERT(char(8), @t, 112) + REPLACE(CONVERT(char(8), @t, 108), ':', '')`,
  since `ActionService.ReadAllAsync` reads every column with `GetString`); `ActionExecuteResult` gains an optional
  `jobStarted` string (14 characters, yyyymmddhhmmss) in the C# record, the strict zod schema and the C# bounds, with an
  offline contract test and a live check. Actions stay single-target, as `actionRequestSchema` and
  `actionExecuteRequestSchema` are today and as `AgentIdentityDto` is: multi-select Start Jobs, Stop Jobs, Enable Jobs and Disable Jobs
  (each with SSMS's one-line-per-job progress dialog) send one ordinary `actions.execute` per selected job, one after another, each with its own target, identity guard and template,
  so each job's `jobStarted`, `JOB_STATE` or `NOT_FOUND` comes back on its own reply and one refusal never fails the
  others (the progress dialog's line per job). The renderer caps a selection at `agentLimits.startJobs` (those four verbs are
  disabled above it, with the reason), so no request shape changes. The progress dialog's Stop (disabled once pressed, moving focus to Close, which stays enabled), and Close or
  Escape mid-sequence, send no further requests (mock scene `start-jobs-stopped`): unsent jobs show "Not run", the request in flight finishes and reports (a
  request is never withdrawn or re-sent), and no `sp_stop_job` is sent to jobs already started. A renderer vitest covers
  a partial failure, the cap and Stop mid-sequence for each verb, Stop becoming disabled when the last reply arrives with
  focus on it moving to Close, Stop pressed by keyboard leaving focus on Close, and a
  multi-step job in a multi-select Start opening no step dialog and sending no `@step_name` (multi-select Start sends
  `sp_start_job @job_id` alone, so each job starts at its own start step, as SSMS). Every reply in the sequence goes to the status-bar job
  service whether or not the dialog is still open, so a successful Start becomes a watched job (or joins the overflow
  item) with its `jobStarted` even after Close (vitest: Close mid-sequence with a Start in flight still watches that job). The status bar takes a
  finished job's outcome only when its last run, compared at second precision, is at or after that time (table tests: the
  job starts in the same second, and in the next). `sp_start_job` only posts the request, so for a moment the job can read
  idle with the previous run's `last_run`: the status bar shows "Starting…" until the job is seen running (status not 4)
  or an idle sample's last run is at or after the start time (a job that finished inside one interval: Starting… ends at
  once with its outcome; renderer fixture), or `agentLimits.watchStartSamples` samples pass, and only after that does idle with an older last run (Agent stopped
  mid-run and left no outcome row) show "Agent stopped, job outcome unknown" (renderer fixture: first sample idle with an
  older `last_run`, next running, never "outcome unknown"). Stop is disabled during Starting… (until the job is seen
  running), since `sp_stop_job` refuses a job that is not yet running; Dismiss stays (mock scene `running-status-starting`). A normal end shows
  "<job>: Succeeded / Failed / Canceled (started <time>)", with the date when the start is not on the server's current
  day and "(server time)" when the server's offset differs from this computer's, as every Agent time, the time being `job0LastRun` (Agent's `last_run_*` is the run's
  start, and `sp_help_job @job_aspect = N'JOB'` returns no duration, so no end time is claimed; table test), for a few
  seconds with View History, then releases the view. Every
  status-bar job item has a Dismiss action that releases the view and slot at once, so the unknown case never holds one
  of the window's 4 status-only slots indefinitely. Renderer fixtures cover all three service states, a normal end, an
  Agent stop and restart while the service state is unknown with an older `last_run_outcome` (shows outcome unknown),
  and Dismiss, and the mock's `running-status-stopped` scene shows the texts. In the Log File
  Viewer, while Agent XPs is off (from Agent's state; AG-0 found `agent.jobs` then reads every job Idle rather than
  reporting `AGENT_DISABLED`): with the service Stopped, step rows after the last job outcome row
  group as Unknown (no job outcome) and the banner is the Agent-stopped one (Start where allowed); with the service
  Running or unknown the running state cannot be read, so those rows show as "In progress or unknown (Agent XPs off)".
  A renderer vitest and the grouping table tests cover both, with history readable, the banner, and recovery on the
  next XPs-1 sample. Job Activity Monitor and the Log File Viewer show it as a warning banner, never the error state, worded by
  `agent.jobs.service`'s service state: Stopped is the "Agent stopped" banner, offering Start (sysadmin on Windows, not a
  failover cluster instance, startup type not Disabled), with Status pills "Agent stopped"; Running offers no Start, only
  the `sp_configure` / `mssql-conf` sentence, with Status pills "Unknown (Agent XPs off)"; unknown (the usual case for
  User and Reader logins) says "SQL Server Agent is stopped or the Agent XPs option is 0", offers no Start, with Status
  pills "Unknown"; a C# offline check covers `LiveErrors.Classify(15281)` and `LiveErrors.IsTerminal("AGENT_DISABLED")`,
  renderer fixtures assert the banner text, button and Status pills for `AGENT_DISABLED` with the service Stopped,
  Running and unknown, and a renderer
  vitest feeds Job Activity Monitor an `AGENT_DISABLED` sample. The node's explanation names `sp_configure` on Windows and `mssql-conf` on Linux. The XPs value is
  live, not cached: `explorer.agentService` also reads `Agent XPs` from `sys.configurations`, so after Start turns it on the
  next sample clears the sublabel. Whether the Agent folders are listed is a children-listing decision:
  the children listing is in C# only (`Explorer/ExplorerService.cs`), and the capability read is cached. Listing the
  `agent` kind runs no SQL today (static folders and singletons, no `list`, so `LoadAsync` returns before opening a
  connection), so AG-1 adds an explicit pre-folder step for `target.Kind == "agent"` beside `DatabaseProblemAsync` and
  `HistoryAsync`: one constant `CatalogSql` batch (linted with its own exact `literals` set, rendered by ExplorerChecks) run through `msdb.sys.sp_executesql` (as the capability read, so
  `IS_ROLEMEMBER` resolves in msdb rather than returning NULL in master) via `RunAsync` on the explorer pool, counted
  against `Budget` with the usual timeout and error mapping. It reads `Agent XPs` from `sys.configurations` (`value_in_use`, by `configuration_id = 16384`; the
  ExplorerChecks render pins the column, as do the live lint renders of `explorer.agentService` and `agent.jobs.service`) (no
  permission needed), `IS_SRVROLEMEMBER(N'sysadmin')` and the three Agent role memberships. At XPs 0 it adds neither the
  folders nor the Job Activity Monitor singleton and returns the explorer error `AGENT_DISABLED` with the `sp_configure` /
  `mssql-conf` sentence, so the expanded node says why even when the status view is off; otherwise it gates folders by the role rules above (Alerts, Operators
  need SQLAgentOperatorRole or sysadmin, Proxies and Error Logs sysadmin; a login with no Agent role and no sysadmin gets
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
  (modelled on `DatabaseRuntimeSource`) carries the whole `explorer.agentService` sample (XPs value, service state,
  startup type) for each server, and `ExplorerService` gains a late `useLongRuns(source)` setter like the existing `useStatus`, called in
  `src/renderer/src/core/workbench.ts` once `LongRunService` exists (it is built after `ExplorerService` today), plus a
  late `useAgentProfiles(source)` for the profile holder below; `ExplorerTarget` (`src/shared/explorer/refs.ts`) gains the
  same optional `agent` field as `ActionTarget`, since `targetOf` returns an `ExplorerTarget`; `targetOf` fills `agent` for `kind === 'agent'`
  from both, and `updateContext()` re-publishes the context keys on either signal (vitest that the Start/Stop/Restart keys
  flip when a sample changes and when an Agent run begins or ends). When the XPs value changes 0 → 1 or 1 → 0 it
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
  are hidden. The Agent node's Start, Stop and Restart (sysadmin, Windows, not a failover cluster instance) follow the
  sampled service state: Running enables Stop and Restart and disables Start ("SQL Server Agent is running"); Stopped
  enables Start and disables Stop and Restart ("SQL Server Agent is stopped"); Start pending, Stop pending, Starting… and
  Stopping…, a sample that says the state is unreadable, or a service action already running in this window disable all
  three with that reason; no sample at all (the status view off or Object Explorer hidden) is unknown, not unreadable, so,
  as the catalogue's "without a runtime the row stands" convention, all three stay enabled for sysadmin on Windows and the
  dialog's fresh describe (`agentService`) decides the confirmation, or refuses with the state it read: in place of the
  confirmation it says "SQL Server Agent is already running on <server>" (Start while Running), "SQL Server Agent is
  already stopped on <server>" (Stop or Restart while Stopped), "SQL Server Agent is <state>; try again when it settles"
  (a pending state) or "The SQL Server Agent service is disabled" (Start or Restart), with Close only, primary and focused
  (mock note on `oe-stopped`, the Start confirmation scene; vitest per state with the status view off);
  startup type Disabled disables Start and Restart with "The SQL Server Agent service is disabled" (a running service can be
  set Disabled and keeps running; Restart's Stop would work and its Start could not). With Agent XPs at 0 (`AGENT_DISABLED`),
  New ›, Job Activity Monitor and View History on the node, and the palette's "SQL Server Agent: Job Activity Monitor" and
  "SQL Server Agent: New Job", are disabled with the `AGENT_DISABLED` sentence, while Start keeps the rules above (renderer
  vitest over every state, the startup type and XPs 0, mock scenes `oe-stopped`, `oe-starting`, `oe-stopping`, `oe-xps`
  and the `jam-disabled` note). The Stop and Restart confirmations name only the running-job count from the latest
  `explorer.agent` sample ("2 jobs are running. Stopping Agent stops them, …"), with "Any running jobs are stopped" when
  the count is unknown or the sample failed, and no job names (no extra read; renderer vitest for a count, zero and unknown).

## Jobs

Identity and concurrency: refs carry the name. Describe returns `job_id`, `date_created`, `date_modified` and
`version_number`, and `actions.execute` carries them in a new `AgentIdentityDto` (job id as a uuid string, created,
version, modified, and a list of at most `agentLimits.schedulesPerJob` schedule ids with their version and modified),
added to Contracts.cs, the strict zod schema and the C# bounds (`DatabaseIdentityDto` holds an int id and cannot). Tree
verbs with no dialog (Enable, Disable, Rename, Delete, Start, Stop) take the identity from the listing row, which carries
`job_id` and `date_created` (both paths return them), so the guard compares against what the user saw. Every write binds
`@job_id` and first checks, in its batch, that the named job still has that ID (else `NOT_FOUND` through the existing THROW 50010, as Delete Database's check answers). Properties saves
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
`agentLimits` caps steps and schedules per job (SSMS-sized, well under 255 calls in all), and zod and C# enforce it.
The standalone schedule save carries a `scheduleJobs` list (job id, its `version_number`, attach or detach) capped by
`agentLimits.scheduleJobChanges`, and Delete History's job list by `agentLimits.historyJobs`; both are set so a save stays
under 255 calls guards included (vitest and offline check at each cap). C#
reads the msdb number from the first error and the index from the THROW, and the dialog says which part was refused
("Saving step 2 'Rebuild' was refused: …"). An error that aborts the batch before the THROW (a severe error under
`XACT_ABORT`, or error 266 from an msdb procedure that rolls back itself, which AG-0 probes) has no index; the dialog then
says the save failed and nothing was saved, without naming a part.

Verbs (all via ActionService, see SQL rules):

| Verb | msdb procedure | Notes |
| --- | --- | --- |
| Start Job at Step… | `sp_start_job @job_id, @step_name` | Dialog lists steps when the job has more than one, as SSMS. From Job Activity Monitor with several jobs selected (AG-3), SSMS's Start Jobs progress dialog lists one line per job. |
| Stop Job | `sp_stop_job @job_id` | Several selected (AG-3): one line per job, as Start. |
| Enable / Disable | `sp_update_job @job_id, @enabled` | Multi-select in Job Activity Monitor with the one-line-per-job progress dialog, as Start; single in the tree. |
| Rename | `sp_update_job @job_id, @new_name` | Inline rename like other kinds. |
| Delete | `sp_delete_job @job_id, @delete_history, @delete_unused_schedule` | Delete Object dialog; both options shown and on by default, as SSMS passes both as 1. |
| Write procedures | `AgentSql.WriteProcedures` in `src/shared/agent/catalog.ts` lists every procedure `LintExecutable` admits, with its owning lane: jobs (AG-4, AG-6a/b): `sp_start_job`, `sp_stop_job`, `sp_update_job`, `sp_delete_job`, `sp_add_job`, `sp_add_jobstep`, `sp_update_jobstep`, `sp_delete_jobstep`, `sp_add_jobschedule`, `sp_attach_schedule`, `sp_detach_schedule`, `sp_add_jobserver`, `sp_purge_jobhistory`, and
`sp_update_alert` for the job Alerts page's Remove (AG-6a); schedules (AG-6c): `sp_add_schedule`, `sp_update_schedule`, `sp_delete_schedule`; operators and alerts (AG-7): `sp_add_operator`, `sp_update_operator`, `sp_delete_operator`, `sp_add_alert`, `sp_update_alert`, `sp_delete_alert`, `sp_add_notification`, `sp_update_notification`, `sp_delete_notification`; proxies (AG-8b): `sp_add_proxy`, `sp_update_proxy`, `sp_delete_proxy`, `sp_grant_proxy_to_subsystem`, `sp_revoke_proxy_from_subsystem`, `sp_grant_login_to_proxy`, `sp_revoke_login_from_proxy`; Agent properties (AG-8a): `sp_set_sqlagent_properties`; error logs (AG-5b): `sp_cycle_agent_errorlog`
(sysadmin; not offered where the gates read logs through `sp_readmierrorlog` unless AG-0 shows it works there); service (AG-5a): `xp_servicecontrol` | Lint render and a near-miss test per entry; the generated docs list it. |
| New Job / Properties | `sp_add_job`, `sp_update_job`, `sp_add_jobstep`, `sp_update_jobstep`, `sp_delete_jobstep`, `sp_add_jobschedule` / `sp_attach_schedule` / `sp_detach_schedule`, `sp_add_jobserver`, `sp_update_job` notification arguments, `sp_update_alert` for the Alerts page's sysadmin Remove | One transaction, each call's return code checked (SQL rules); Script Action shows SSMS's `BEGIN TRANSACTION … QuitWithRollback` shape with literals, as Login's does. |
| Script Job as › CREATE / DROP / DROP And CREATE To › New Query, File, Clipboard | SMO `Server/JobServer/Job[@Name and @CategoryID]` through `ScriptPipeline` | Also Alert, Operator and `ProxyAccount`. Never executes. |

Status bar (AG-3): a job this window started shows "Index maintenance: running step 2 of 4" with Stop in the status bar
until it ends. Background views pause when Object Explorer or the window is hidden and yield their slot, and tables pause
under status-only, so this uses a table-less probe, `agent.jobs.watched`. Series are static catalogue ids, so it declares
fixed slot series (`job0Status`, `job0Step`, `job0Steps`, `job0Started`, `job0LastOutcome` (code), and `job0LastRun`
(numeric yyyymmddhhmmss in server local time, the last run's start), read through `sp_help_job @job_id, @job_aspect = N'JOB'` (one result set instead of four), … up to `agentLimits.watchedJobs`, small), mapped to
the watched job ids by their order in the args. The `agent.jobs` source declares `hidden: 'statusOnly'` (the first
production source to use it; `tests/live-service.test.ts` is the only user today), so a view of it keeps its table-less
probes sampling while hidden when the view also opens with `whileHidden: 'statusOnly'`
(`LiveSpec`; `statusOnlyAllowed()` needs both). Only the status bar's `agent.jobs.watched` + `agent.jobs.service` view
passes it; Job Activity Monitor's and the Log File Viewer's `agent.jobs` views do not, so they pause when hidden as today
and never take one of the window's status-only slots (the status-bar renderer fixture asserts the spec carries it and
the other two do not). The status bar owns that view (window-scoped, the window-wide limit of 4 status-only views
applies; when none is free the status bar shows the job without live progress, never an error). It watches at most
`agentLimits.watchedJobs` jobs: when one Start Jobs launches more, or this window starts another while every slot is in
use, the extra jobs join an "n more jobs started" item with View in Job Activity Monitor, without live progress, and the
watched view's args never change past the bound (renderer fixture: starting `watchedJobs + 1` jobs gives no subscribe
error and one summary item). That summary item's accessible name is "<n> more Agent jobs started, live progress
unavailable"; it is never promoted into a freed slot, a later overflow Start adds to its count, and it goes away on its
Dismiss or when Job Activity Monitor is opened from it (renderer fixture covers both and a count bump; mock scene
`running-status-overflow`). The status bar holds its view only while a
watched job runs and never polls; it does not depend on Job Activity Monitor or Object Explorer being open. Elapsed time
shows only when the start is readable (below).

Start times: `sp_help_job` returns no start time for a running job. Sysadmin reads `sysjobactivity.start_execution_date` for the newest Agent session only
(`session_id = MAX(syssessions.session_id)`, the filter `LiveSql.Agent` and `sp_help_jobactivity` already use, since a
crashed session's row keeps a start with no stop);
other logins read `sp_help_jobactivity`, which joins `sysjobs_view` and so returns every job `sp_help_job` shows the login
(Reader and Operator see all jobs, User its own). Where no start time is readable (a NULL `start_execution_date`, or no
row for the current Agent session in `syssessions`), Varia shows no elapsed time (tiles, status bar, In progress run),
never a guess.

Job document sections (the rethink's job document, `rx-job-*`; formerly `ObjectDialog` pages; describe through `actions.describe`). Describe
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
    per step writing its full content (name, subsystem, command, actions, go-to targets) into its final id, starting from the
    described row so what Varia does not model is carried through unchanged: `@flags` keeps every bit outside 2, 4, 8 and
    16 (`flags & ~30`, such as 32 and 64), and `os_run_priority`, `server`, `additional_parameters` and the other unmodelled
    columns are passed back as read (planner table test; `AgentActions` round trip of a step with flags 32|64 and a
    non-default `os_run_priority` that is moved and renamed); (5)
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
    Retry attempts and interval, Output file (server path through the server file picker) and Append, Log to table and "Append output to existing entry
    in table" (enabled only with Log to table), Include
    step output in history, encoded as `@flags` by a table in `src/shared/agent/catalog.ts`: Append to output file 2, Include
    step output in history 4, Log to table alone 8, Log to table with Append 16 (not 24), as SSMS scripts them (table tests
    against SSMS-scripted `@flags` values; an `AgentActions` live round trip reads `sysjobsteps.flags` back for each
    checkbox combination), Run as user (T-SQL). SSMS's View buttons for the output file and the table log are later.
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
  own jobs are listed" for those logins. Inside the job dialog Jobs in Schedule is a read-only list (its `SubDialog` edits
  only this job's draft, and other jobs carry no identity in this save), with "Change which jobs use it from Manage
  Schedules". From Manage Schedules (and New › Schedule…), the Schedule dialog is its own dialog id `schedule` that saves on
  its own: `sp_add_schedule`, or `sp_update_schedule` guarded by the schedule's `version_number` (`STALE` when it changed),
  and its Jobs in Schedule checkboxes become one `sp_attach_schedule` / `sp_detach_schedule` per changed job in the same
  transaction, each guarded by that job's `sysjobs.version_number`; rows for jobs the login may not change (another owner's,
  below sysadmin) are disabled with "Owned by <owner>" (mock note on `jobs-in-schedule`; renderer vitests; `AgentActions`
  checks for standalone add, update with a stale version, attach and detach).
  - **Manage Schedules** (AG-6c; Jobs folder menu): an `ObjectDialog` with dialog id `manageSchedules` and a new
    `layout: 'list'` (one page, Close only, no Script), opened through the object-target form on the server. Its rows come
    from a page-scoped describe `scheduleList` (`sp_help_schedule` on the role path, which returns the schedules the login
    may see; ID, name, owner, enabled, jobs in schedule, description), re-read after every row action and child save. Row
    actions are separate `actions.execute` requests, each on target `{ kind: 'schedule', id, version }` with the
    `version_number` guard (`STALE` re-reads the list and says so): `enableSchedule` / `disableSchedule`
    (`sp_update_schedule @enabled` only) and `deleteSchedule` (`sp_delete_schedule` without `@force_delete`; in-use maps to
    `IN_USE` with msdb's message), behind the destructive confirmation below ("Delete schedule <name>? This cannot be
    undone."). New… and Properties open the `schedule` dialog through `openChild`, then re-read `scheduleList` and select
    the row; Jobs in Schedule opens the same child on its Jobs page. Role matrix: sysadmin, every button on every schedule;
    a schedule's owner, Properties (editable), Enable, Disable, Delete on their own; SQLAgentOperatorRole, Enable and Disable
    on any schedule, others' Properties read-only, Delete only on their own; Reader and User, their own as the owner, others'
    Properties read-only with Enable, Disable and Delete disabled with "Owned by <owner>" (vitests per role's buttons, the
    child re-read, Delete refused as `IN_USE`, `STALE` on a row action; smoke step: Manage Schedules › New… and back; mock
    `manage-schedules` and a note on its Delete confirmation).
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
  Add opens New Alert with the job preset and is hidden until AG-7 lands, so the page ships with AG-6a either way). Alert
  links are written through `sp_update_alert`, which no Agent role may run, so for any non-sysadmin, even on a job the
  login owns, Add and Remove are disabled with the role-named reason ("SQLAgentOperatorRole may view alerts, not change
  them") and Edit opens the alert read-only; the describe marks alert links not editable (renderer vitest for an Operator on
  their own job; `AgentRoles` check of the describe flag). Edit, like Add, needs the Alert dialog, so until AG-7 lands the
  page lists the alerts with Remove (sysadmin) only.
- **Superseded by the document model** (2026-11-16 rethink, replacing the stacked child dialogs decided earlier that day):
  Agent objects are document tabs, so nothing opens a dialog on a dialog. What the child-dialog design needed carries
  over: documents open without a tree node (tree, Job Activity Monitor, Ctrl+Q, palette) and reveal the saved object
  through `folderNode(connectionId, owner, folder)` with the folder's real owner (`{ kind: 'agent' }` for Agent folders,
  the server for Security › Credentials); a document re-reads only the list an inline create changed through the
  page-scoped describes (`jobAlerts`, `credentialList`, `alertJobPicker`, `alertOperatorPicker`), merged without touching
  the identity and version fields, so `STALE` still sees another session's edit; a disconnect or backend loss puts open
  documents into the disconnected state with their drafts kept. New Alert from a job's Alerts section opens an alert tab
  beside the job with the job preset (`rx-job-alerts`); in an unsaved New Job it says "Save the job first, then add
  alerts". The SSMS-style scene `job-alerts-child` stays as reference only.
- **Notifications**: E-mail / Page / Net send operator with When (succeeds, fails, completes), Write to the Windows
  Application event log, Automatically delete job. Kinds the platform gates refuse are disabled with the reason.
- **Targets**: "Target local server" only in 0.11.0; multi-server (MSX/TSX) targets are later and shown disabled.

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
  Status reads by service state (see Object Explorer's Agent XPs bullet). Once `agent.jobs.list` stops: with the service
  Stopped, the Running and Between retries tiles and the Running chip read 0, their row tones clear and no elapsed time
  shows; with the service Running or unknown they read "—" (unknown), elapsed time stops and the renderer clears the
  running and between-retries row tones too (the backend's tones are stale once the probe stopped); in every case the live
  indicator reads "Agent unavailable", not Live; Failed and Disabled counts stay (from msdb). The `AGENT_DISABLED`
  renderer fixtures assert tiles, chip counts, row tones and the indicator. With the service Stopped, Next Run is marked as not
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
  `instance_id` filter, so on the role path the pane shows the captured row's message, which AG-0 found is the whole
  message there too (`sp_help_jobhistory_full` selects `sysjobhistory.message` as stored, with no role-based cut).
- History cap text ("Agent keeps 1,000 history rows, 100 per job") shows only when it was read: through
  `msdb.dbo.sp_get_sqlagent_properties` (undocumented, allowlisted read; AG-0 found it returns values to SQLAgentUserRole, so every Agent role
  sees the cap text). Logins it refuses see none.
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

| Area | 0.11.0 | Later |
| --- | --- | --- |
| Shared schedules | Schedule dialog, Pick, Jobs in Schedule, Manage Schedules: Delete offered for any schedule the login owns (sysadmin: any), never judged "unused" from Jobs in schedule counts; `sp_delete_schedule` without `@force_delete`, whose in-use refusal maps to `IN_USE` with msdb's message (an `AgentActions` check) | |
| Job categories | Category picker | Manage Job Categories dialog |
| Operators | List, New / Properties (General: name, enabled, e-mail, pager and on-duty schedule; Notifications: alerts and jobs; History), Enable/Disable, Rename, Delete (Delete Object offers "Reassign to" another operator, sending `sp_delete_operator @reassign_to_operator` so its alert and job notifications move instead of being dropped; AG-7 confirms SSMS's dialog; vitest and `AgentActions` check), Script As | Fail-safe operator (Agent Properties › Alert System) |
| Alerts | List, New / Properties (General: SQL Server event by error number or severity with database and message text; performance condition with object, counter and instance from `sys.dm_os_performance_counters` when the login has VIEW SERVER STATE, typed otherwise; Response: run job, with New Job… and View Job opening the job dialog nested, and notify operators, with New Operator… and View Operator opening the operator dialog nested, the new object selected on return, New buttons hidden for roles that cannot create, read-only from a read-only alert, vitest; Options: include error text, additional notification message to send, delay between responses; History: date of last alert, date of last response, number of occurrences from `sp_help_alert`, History is hidden in New Alert, which has nothing to show (AG-7
confirms SSMS's page set, vitest), and Reset Count, sysadmin only, which as in SSMS is applied with the alert's save (OK sends `@occurrence_count = 0` in
the same `sp_update_alert`, under the alert's identity guard; the page shows 0 pending and Cancel discards it; an
`AgentActions` check reads the count back as 0), with mock scene `alert-history` and a vitest), Enable/Disable, Rename, Delete, Script As | WMI event alerts editable (shown read-only) |
| Proxies | List by subsystem, New / Properties (General: name, credential, description, subsystems from `syssubsystems`; Principals; References: job steps that run as this proxy, read by sysadmin from `sysjobsteps` joined to `sysproxies`; other roles, which cannot read `sysjobsteps`, see "Only sysadmin can list the job steps that use this proxy", with a fixture per role), Rename, Delete, Script As | |
| Credentials | New Credential and Credential Properties on the existing Security › Credentials folder (kind `credential`) and from the Proxy dialog: name, identity, secret, encryption provider (listed from `sys.cryptographic_providers`, spliced into `FOR CRYPTOGRAPHIC PROVIDER` only through server-side `QUOTENAME` in `CredentialSql`, read-only in Properties since `ALTER CREDENTIAL` cannot change it; lint render and near-miss tests, and the field is hidden when no provider exists). `ALTER CREDENTIAL` resets the secret when `SECRET` is omitted, so in Properties the Identity and secret are read-only until "Change identity and password" is checked, and every ALTER sends both | |
| Error logs | List, view in Log File Viewer, Recycle | Configure (log path, level) via Agent Properties › General |
| SQL Server Agent Properties | General (auto restart SQL Server, auto restart Agent, error log file read-only), History (max rows, per job) through `msdb.dbo.sp_set_sqlagent_properties` (undocumented, what SSMS calls; allowlisted; read-only on Managed Instance, and on Linux, where mssql-conf sets them). History's "Remove agent history older than" is not a setting: it is a one-shot purge of **all** jobs' history (SSMS runs it on OK; Varia runs it apart from OK, as History's "Delete old history now") (`sp_purge_jobhistory @oldest_date`, sysadmin), behind its own destructive confirmation; it is its own allowlisted template with its own lint entry (it passes no `@job_id`, which Delete History's template refuses) and shares only the server-computed `CASE @unit … DATEADD(…, GETDATE())` cut-off statement, its bounds and its NULL-date THROW, and the confirmation labels it "(server time)" when the offsets differ (renderer test; AG-8a's live check covers the cut-off) | Advanced, Alert System (mail profile, fail-safe), Job System, Connection |
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
  describe), is checked by `AgentSql.LintRead`, a new rule: `LiveSql.Lint`'s rules plus two exemptions, made caller-aware for the
  prologue (today `LiveSql.Lint` rejects text that does not start with a live prologue): `LintRead(text, prologue)` takes
  the expected prologue per caller, the live prologues for live probes, `CatalogSql.Prologue` for listings and Search
  Objects, and none for describes, whose `ActionSql.ReadPrologue` runs as a separate command (lint-render tests for one
  statement from each caller). A statement may
  be exactly `EXEC msdb.dbo.<procedure> @arg = @param, …` (named arguments, parameters or the constants the catalogue
  lists per procedure, such as `@mode = N'FULL'` for `sp_help_jobhistory` and `@job_aspect = N'JOB'` for `sp_help_job`) for a procedure in `AgentSql.ReadProcedures` (`sp_help_job`,
  `sp_help_jobhistory`, `sp_help_jobactivity`, `sp_help_jobstep`, `sp_help_jobschedule`, `sp_help_schedule`,
  `sp_help_category`, `sp_help_operator`, `sp_help_alert`, `sp_help_notification`, `sp_help_proxy`,
  `sp_enum_login_for_proxy`, `sp_help_jobs_in_schedule`, `sp_enum_sqlagent_subsystems`, and `sp_get_sqlagent_properties`, which AG-0 found returns values to SQLAgentUserRole).
  And the master procedures, which take positional arguments, each have a named shape: `EXEC master.dbo.xp_enumerrorlogs
  2;`, `EXEC master.dbo.xp_readerrorlog @p1, 2, @p2, @p3, NULL, NULL, N'desc';` and, on Managed Instance, `EXEC
  master.dbo.sp_readmierrorlog @p1, 2, @p2, @p3` (its documented signature has no sort argument; AG-0 had no Managed Instance to run it on, so it caps from the
  oldest and the notice says so) (the only literals allowed are the log type `2`, `NULL` for
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
- **Service control** (revised 2026-11-18; the owner decision above). What changes from the design below:
  - **Start and Stop are not SQL.** A backend `AgentServiceControl` calls the server machine's Service Control Manager
    (`System.ServiceProcess.ServiceController`, Windows only) as the Varia process's Windows user, the way SSMS does. It
    is the only call Varia makes to a server's operating system, and gets its own bullet in docs/architecture.md. The
    machine is `SERVERPROPERTY('ComputerNamePhysicalNetBIOS')` and the service `SQLSERVERAGENT` or `SQLAgent$<instance>`
    from `SERVERPROPERTY('InstanceName')`, both read on the connection and checked against strict patterns; nothing the
    user types names a machine or service. Each call is bounded by `serviceStatementMs`, and the waits poll the
    controller's status, bounded by `serviceWaitMs`.
  - **Who may run it**: Windows decides, as in SSMS, not the SQL login, so sysadmin is no longer required. Refusals map
    to values: access denied (Windows error 5) is `PERMISSION_DENIED`, "Starting and stopping SQL Server Agent needs
    Windows administrator rights on <machine>"; an unreachable machine or service manager (RPC errors such as 1722, an
    unknown host) is a new action code `SERVICE_UNREACHABLE`, not retryable, naming the machine; a missing service is
    `NOT_FOUND`.
  - **Where it is offered**: a Windows client, a Windows server, not Managed Instance, not `IsClustered`. Everywhere else
    the three verbs stay in the menu, disabled with the reason ("Needs Varia on Windows", "On Linux, use systemctl on the
    server", "Use Failover Cluster Manager for a clustered instance"), and the preflight refuses them `NOT_SUPPORTED`.
  - **State stays SQL** on every platform: `xp_servicecontrol N'QueryState'` and `sys.dm_server_services`, as below.
    `xp_servicecontrol` Start and Stop are dropped, so `LintExecutable` no longer admits `xp_servicecontrol` at all.
  - **Tests**: an `IServiceControl` seam with an offline fake covers every refusal, the waits and the gates; the
    Windows workflow runs the real controller against its local instance; the owner's test instance runs it locally
    with `VARIA_TEST_SQL_AGENT_SERVICE=1`. A remote server is checked by hand before AG-2 merges.
  - Kept as designed below: the confirmation and progress dialogs, the long-run rows, steps, limits and cleanup formula.

  Original design (statement parts superseded): `EXEC @rc = master.dbo.xp_servicecontrol @action, N'SQLServerAgent';` with `@action` in
  `N'Start'`, `N'Stop'`, `N'QueryState'` as a parameter; `LintExecutable` allows exactly this positional shape, with
  `N'SQLServerAgent'` its only literal, beside the `EXEC @rc = msdb.dbo.<proc> @arg = @param` shape. `xp_servicecontrol` maps the constant `SQLServerAgent` to the
  connected instance's Agent (`SQLSERVERAGENT` or `SQLAgent$<instance>`), as the QueryState fact showed; the Windows CI job
  proves it on a named instance. Catalogue shape (today's catalogue narrows only database targets): `actionKindSpecs` gains an `agent` row offering the
  three verbs; `ActionTarget` gains an optional `agent` field (service state, startup type, sysadmin, Linux, Managed
  Instance, clustered, and a `busy` flag) filled from the node's `explorer.agentService` sample and the profile, with
  `busy` true while `LongRunService` holds a `startAgent`, `stopAgent` or `restartAgent` run for that server or the node
  shows Starting…/Stopping… (its own `agentServiceActionRules` row and vitest); an `agentServiceActionRules`
  table, mirroring `databaseActionRules`, gives each verb's enablement and reason, and `actionMenuState`/`actionMenuReasons`
  apply it when the kind is `agent` (emitted in `actionsCatalogJson` and the generated docs, regenerated with
  `npx vitest run tests/object-actions-catalog.test.ts -u`; vitest per rule). The backend's preflight repeats what it can
  check itself before any statement: Linux, Managed Instance or `IsClustered` refuses `NOT_SUPPORTED`, a non-sysadmin login
  `PERMISSION_DENIED` (offline check for each through a fake capability read). All three rows are `class: 'dialog'` with three
  new dialog ids, `startAgent`, `stopAgent` and `restartAgent`, in `dialogIds` (a `DialogSpec` names one action, C#'s
  `ActionOf(dialog)` maps one-to-one, and `ObjectDialogDefinition.longRun` is one kind, so each verb gets its own id, its
  own `action` and its own `longRun`). Their `dialogSpecs` entries share a new optional `layout: 'confirmProgress'` field
  on `DialogSpec` (added to the docs.ts dialog table): one hidden `general` page keeps `open()`'s `pages[0]` read valid, and
  the layout renders a confirmation that becomes the steps table in place, footers as below, no page list and no Script
  button (vitest that it renders no Script and no page list). Every dialog id is a describe id and `open()` always
  describes, so the C# describe switch gains a `DescribeAgentServiceAsync` case for the three ids (on the read gate, through `AgentReader` under `AgentSql.LintRead`, whose master shapes gain one read-only
  `EXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';` with both arguments constant, so Start and
  Stop stay admitted only by `LintExecutable` (lint render of the describe batch, near-miss tests that `N'Start'`,
  `N'Stop'`, a parameter action or another service name are refused); the startup type from `sys.dm_server_services`, a
  catalog read already admitted by `LintRead`, sysadmin, and the profile's Linux, Managed Instance and clustered facts), returning a typed
  `agentService` member of `ActionDescribeResult` (TS interface and strict zod schema in `src/shared/actions/schema.ts`, the
  C# record and bounds; offline check that the switch never falls through to `DescribeJobAsync` for these ids, and a vitest
  of the describe shape); the confirmation text and enablement are taken from that fresh describe, not only the sample.
  `ObjectDialogService` receives step events: `ObjectDialogServiceOptions` gains `progress: ActionProgressService`, whose
  construction in `src/renderer/src/core/workbench.ts` moves ahead of the dialogs service, and the dialog `track`s its
  request id before sending the execute and `forget`s it after the reply (vitest that a step-2 event disables Cancel restart
  and that each step event updates its row). Each row's `explorer.*` command feeds `actionCommandEntries()`, so the lane
  also registers the three handlers (with `when` and `unavailable`) in `src/renderer/src/contributions/actions.ts` and
  regenerates the commands docs with `npx vitest run tests/commands-docs.test.ts -u`. Script is not offered: the three requests get their own strict `agentServiceRequestSchema` (action enum, `connectionId`,
  `requestId`, target `{ kind: 'agent' }` only) that joins `actionExecuteRequestSchema`'s union but not the
  `actionRequestSchema` union that `actionScriptRequestSchema` pipes into, with the matching `ActionRequest` type and a C#
  `ActionArgs` `Validate` rule that the request carries no other fields; zod's `actions.script` schema and C#
  `Validate(args, script: true)` therefore refuse the three action ids (vitest and offline check), so `ScriptAsync` never
  reaches them. Three action rows: `startAgent`, `stopAgent` and `restartAgent`, each an `objectActions` entry with an
  `ObjectActionSpec` row on the Agent node kind (only object actions carry `long`; `actionDrainMs`, the long gate, step
  events and drain registration all key off it, so a server or kind-dialog row would silently get none; a vitest that
  `actionDrainMs` is non-zero and the generated `actionsCatalogJson()` row says `long: true` for each, and a C# offline
  check that `ActionsCatalog.Current.IsLong` is true for each). Two more limits bound the parts:
  `agentLimits.serviceStatementMs` (one `xp_servicecontrol` Start or Stop, as the command timeout) and
  `agentLimits.serviceReadMs` (one `QueryState` read, as `CancelAfter` on its own token), documented with the others. Each
  row's `cleanupMs` is derived from them in the actions catalogue by one formula used everywhere in this plan: statement +
  `serviceWaitMs` + read for Start and Stop, and for Restart the same sum for its start phase (the Start, its wait and the
  read after it), which is larger than the post-cancel read (offline check per row that `actionDrainMs`
  and `StopWait` cover it; `tests/action-seams.test.ts`'s per-row `cleanupMs` assertion gains the three rows). Start and
  Stop are built like Restart below:
  `long: true`, fixed steps (Start: 0 Start, 1 Wait for Running; Stop: 0 Stop, 1 Wait for stopped),
  each wait bounded by `agentLimits.serviceWaitMs` (60 s), the job returning its outcome as a value from the moment the
  statement is sent (the statement itself runs on a token of its own bounded by `serviceStatementMs`, so a drain or Stop
  sends no attention to it, and its `QueryState` reads on a token of their own; fake-service check that a Stop during
  the statement still returns the statement's outcome), and a long run registered for the whole action
  (`startAgent` and `stopAgent` kinds beside `restartAgent`, subjects "A start of SQL Server Agent" / "A stop of SQL
  Server Agent", with the same per-kind "Wait for it to finish" override below; both take the long gate like Restart), so close, Disconnect and Restart SQL Backend are refused
  while one runs. When a Start's wait passes `serviceWaitMs` (plain Start, Restart's step 2 and Start again alike), the action
  reads `QueryState` once on its own token: only Stopped ends "SQL Server Agent was left stopped" with Start again; any
  other state ends "SQL Server Agent did not start within <n> s; its state is <QueryState>" (or "… could not be read") with
  Close only, since sending Start to a pending service would fail. A Stop's timeout ends the same way, "SQL Server Agent
  did not stop within <n> s; its state is <QueryState>", Close only. The plain Start and Stop dialogs show the confirmation,
  then the same progress layout as Restart: a steps table in a `log` region, no Cancel button (neither can be stopped once
  its statement is sent; a Stop request before that is the drain's only use), Close disabled with focus on the log region,
  Escape and the title-bar close doing nothing while it runs, then Close enabled, primary and focused at every ending
  (Running or stopped, access denied, timeout), with Escape and the title-bar close acting as Close (mock scenes
  `start-agent-progress`, `stop-agent-timeout`, `start-agent-pending`; renderer vitests for success, each timeout wording
  and access denied, each asserting the text, footer and focus); backend fake-service
  checks cover a cancel after each statement was sent, a failing Start whose read says Start pending, a Start timeout reading Stopped and one reading Start pending, and a
  Stop timeout, and vitests the long-run refusal for each kind. The state every ending names travels as a typed field, not
  parsed text: `ActionExecuteResult` gains an optional `agentService` (`running`, `stopped`, `startPending`,
  `stopPending`, `unreadable`) in `src/shared/actions/schema.ts` (the interface and the strict `actionExecuteResultSchema`), the C# record and C#
  bounds; `AgentSql` maps `QueryState`'s text to it in the backend, an offline contract check covers every value and an
  unknown text (`unreadable`), and the renderer vitests drive each ending (Start again or Close only, the wording) from
  that field alone. A Start that fails with an error (plain Start, Restart's step 2 and Start again alike) reads `QueryState`
  once on its own token, skips the wait, and ends with the engine's text plus the state: Running ends "SQL Server Agent is
  already running" with Close only and success styling (the stale-sample 1056 case); Stopped ends "SQL Server Agent could
  not be started; it is Stopped" with Start again beside Close unless the code was 1058 or the startup type is Disabled; any
  other state, Close only (mock `start-agent-failed`; fake-service checks for a failing Start reading Stopped and one reading
  Running, renderer vitests for both). A Stop statement that fails (plain Stop, or Restart's step 0) reads `QueryState` once on its
  own token, skips the wait, sends no Start, and ends with the engine's message plus the state, Close only (mocks
  `stop-agent-failed`, `restart-stop-failed`). Success endings say "SQL Server Agent is running on <server>" (Start, Start
  again, Restart) or "SQL Server Agent is stopped on <server>" (Stop), Close only (mock `start-agent-done`; Stop's and
  Restart's success use the same layout with their own wording, noted on that scene). "Access is
  denied" takes precedence over every state rule: it ends `PERMISSION_DENIED` with Close only and never offers Start again,
  since the same request would be refused (mock `agent-denied` in the progress layout). "Left stopped" offers Start again only
  when the startup type is not Disabled, taken from the dialog's describe (`agentService` carries it, so it is known
  with no sample) and refreshed by the latest sample when there is one; otherwise it says the service is disabled
  and offers Close only. A plain Start dialog's Start again behaves like Restart's below: in place, no second confirmation, a
  new step row, its own `startAgent` long run, Close disabled with focus on the log region until it ends (mock
  `start-agent-left-stopped`). `ObjectDialogService.ok()` only sends the open definition's own request and registers its
  own `longRun`, so Start again is a new service method, `startAgain()`: it builds `{ action: 'startAgent', target }` with
  a fresh request id that it `track`s and `forget`s on `ActionProgressService`, calls `longRuns.begin({ kind:
  'startAgent' })`, and appends its step rows to the open dialog; for `layout: 'confirmProgress'`, the `ready` phase is the confirmation: Stop and Restart render as `alertdialog` (today
  `ObjectDialog.tsx` hard-codes `role="dialog"`, so the layout passes its role) with initial focus on Cancel, the default,
  and Enter on the form or the message acting as Cancel, so only a click or Enter on the Stop Agent / Restart button sends;
  Start renders as `dialog` with focus on Start, whose Enter sends (vitests that Enter on the form and on the message in
  `ready` sends no `executeObjectAction` for Stop and Restart, and that focus starts on Cancel). `ok()` sends only from the
  `ready` phase and every ending is terminal: in `failed` or
  `stopped` `ok()` acts as Close, and Enter anywhere in the dialog (the form, the log region) acts as Close, so a second
  Enter never resends Stop or Restart unconfirmed, and Start again is reachable only through `startAgain()` (vitests that
  Enter on the form and on the log region after each ending sends no `executeObjectAction`); the three definitions set
  `keepOpen: true`, so a success
  leaves the dialog open on its ending with Close focused (vitests that Start again registers a `startAgent` run, not
  `restartAgent`, and that success keeps the dialog open). Fake-service checks: a failing Stop in each of plain Stop and Restart step 0, access denied
  on Start reading Stopped; renderer vitests for those endings, the Disabled variant and the plain dialog's Start again. Restart is Stop,
  then the action itself re-reads `QueryState` (ActionService has no live
  probes) on its own connection under the `AgentSql` lint until it reads stopped, each wait bounded by `agentLimits.serviceWaitMs` and
  Stop-able, then Start. Sysadmin and Windows servers only, not on a failover cluster instance; confirmation first, through
  ActionService. Failures arrive as a `SqlException` (the xp raises message 22003 at level 16 for every failure;
  the batch goes on with `@rc = 1` and `@@ERROR` 0, but SqlClient still throws, since action connections do not set
  `FireInfoMessageEventOnUserErrors`), so the Start, Stop and `QueryState` calls catch `SqlException` with `Number == 22003`
  around the statement themselves, before `JobAsync`'s generic `ActionErrors.FromSql` could see it, with `@rc <> 0` kept
  only as a backstop; the fake service throws a level-16 22003 `SqlException` carrying the xp's text, so the offline checks
  run that path. They are classified in the backend by
  the Windows code in the xp's fixed "returned error <n>," text, a documented exception to classifying by number since the
  engine number is the same for all of them: 5 ("Access is denied"; the engine's virtual account may lack the right on the
  Agent service) maps to a `PERMISSION_DENIED` value, and anything else (1056 already running, 1058 disabled, 1060, 1061
  cannot accept control messages, 1062, 1069 logon failure, unparseable text) to `SQL_ERROR` with the engine's text plus the
  `QueryState` read (offline table check over 5, 1056, 1058, 1060, 1061, 1062, 1069 and unknown text; the 22003 shape itself is checked against the fake service, since `LintExecutable`
  admits only the constant service name). The `PERMISSION_DENIED` value comes with a fixed sentence: "Windows refused the request: the SQL Server service account may
  not control the Agent service on this server. Start it in SQL Server Configuration Manager, or grant that account the
  right." (no account name: the action path has no read of `service_account`, and none is added for an error message). This deliberately differs from
  SSMS, which controls the service from the client computer through WMI: Varia goes through the engine so it needs no
  Windows rights or network path to the server, and works the same from Linux and macOS clients. If AG-0 finds it cannot
  work on default virtual accounts, the lane comes back to the owner. States, each mocked and in the renderer fixtures:
  Starting… / Stopping… on the node and in the dialog until `QueryState` agrees (the next `explorer.agentService` sample
  then takes over); "Access is denied" with that fixed sentence; a Restart whose Stop succeeded but whose Start
  failed or timed out, which reads `QueryState` once and says "SQL Server Agent was left stopped" with Start again only when
  it reads stopped (otherwise the "its state is …" or "could not be read" ending with Close only); and Cancel restart (the
  dialog's button, never a bare "Stop"), which after Stop leaves Agent stopped and says so. The restart row in
  `actions-catalog.json` is `long: true` with a `cleanupMs`, so `actionDrainMs` covers the larger of the two phases (stopGraceMs plus cleanupMs, as `StopWait`) and a closing
  backend generation drains it as the last resort (a crash or Windows session end; the run is also registered with
  `LongRunService` as a new `restartAgent` kind in `longRunKinds`/`longRunSubjects`, subject "A restart of SQL Server
  Agent", so the window close, Disconnect of that server and Restart SQL Backend are refused and the reload prompt names it;
  `longRunMessages` gains a per-kind override so `restartAgent`, `startAgent` and `stopAgent` each say "… Wait for it to finish." instead of "Stop it
  first", and the same override covers `close` ("… Wait for it to finish, then close the window.") and main's `reload` and
  `restart` prompt lines (built by `stops()` and `longRunMessages.reload`/`.restart` in `src/shared/long-runs.ts`;
  src/main/action-prompts.ts only joins them, and the `total`/`longRunLimits.runs` wording stays), which today describe the whole state through its first run; they
  become one clause per run kind present (Agent kinds first, then "… and a restore stops part way" for the rest), so a mixed
  state is worded right in either order (vitest for a mixed state in each order); for these kinds they say the backend lets a sent Start or Stop finish, and cancels a Restart only before its Start is
  sent, instead of "stops it part way", since Cancel restart is disabled in the start phase and a plain Start or Stop cannot be stopped once its statement is sent; vitest per kind over `stop`, `close`, `reload` and `restart`): during the stop phase the drain acts as Cancel restart,
  during the start phase Start finishes (offline check that the drain covers both phases) (only long actions send step events today, through
  `ActionProgress.Begin` and main's `varia:actions-progress`), so it takes the long gate and reports fixed steps: 0 Stop,
  1 Wait for stop, 2 Start, each begun with `progress.Begin(i)`, with every step's result in the reply. `RunAsync` maps anything a cancelled job throws to
  `CANCELLED` "stopped before it changed anything", and `JobAsync` maps a `SqlException` only while the token is not
  cancelled, which is false once Stop has run: so from step 0 on (once the Stop statement has been sent) the restart job catches `OperationCanceledException` and
  `SqlException` itself and returns the step results as a value (cancelled after Stop, left stopped, Start error), never
  letting them escape (only a cancel before step 0, in the gate wait, sign-in or prologue, is left to `RunAsync`'s
  `CANCELLED`), and step 2's Start and its `QueryState` reads run on a token of their own bounded by the Start wait,
  not the job token (`cleanupMs` is the formula above, statement + `serviceWaitMs` + read, which covers the post-cancel read too, since a
  Stop's reply and the drain wait only `stopGraceMs` plus `cleanupMs`). Backend fake-service checks: a Stop in step 1 returns the cancelled-after-Stop
  outcome with the read state, and a Stop in step 2 followed by a failing Start returns the Start error with the state read
  after it (`stopped` gives left stopped; a `startPending` read gives the Close-only ending, its own check). The long gate is shared with restores and backups (`longPerConnection` 1, `longTotal` 2), so its BUSY messages in
  `ActionService` and the generated `longPerConnection` text in `src/shared/actions/docs.ts` (both of its quotes), the `long` doc comment in
  `src/shared/actions/catalog.ts`, docs/ipc.md's text and quotes, and the `LongBusy`/`LongElsewhere` constants in
  `ActionProgressChecks` are reworded to "another long action (restore, backup, or Agent start, stop or restart)", since all three Agent rows are long and take the long gate, with checks that a restart and a plain Start blocked by a restore, and a restore blocked by an Agent Start, get that message. Once
  step 2 has begun, a Stop no longer cancels the Start statement: the action finishes Start, reads `QueryState` and returns that
  outcome instead of `CANCELLED` (backend check with a fake service: a Stop arriving after Start still returns the Start
  outcome). The renderer enables Cancel restart only while the latest step event is below 2. Cancel restart is
  enabled only during the stop phase; once Start is sent it is disabled and focus on it moves to the
  dialog's `log` region (`tabindex="-1"`), since Close is still disabled and cannot take focus; a vitest asserts focus
  stays inside the dialog in the start phase. The title-bar close button follows Escape: inert while the restart runs,
  Close once it ends. On Cancel restart in step 0 or 1 the action sends no Start and reads
  `QueryState` once on a token of its own bounded within `cleanupMs` (never the cancelled job token); if that read fails
  the dialog says "Restart cancelled; SQL Server Agent's state could not be read" with Close only (fake-service checks
  for Cancel in step 0 and step 1 include it); and the reply carries that state: the dialog says "Restart cancelled;
  SQL Server Agent was left stopped" with Start again beside Close only when it reads stopped, otherwise "Restart
  cancelled; SQL Server Agent is <state>" with Close only; focus goes to Close, the primary button, in every ending (mock
  scene `restart-cancelled`; backend fake-service checks for Cancel in step 0 and step 1, renderer vitests for all
  three wordings, each asserting the text, the footer and focus on Close). Start again sends the `startAgent` action defined above without a second confirmation (the restart
  was already confirmed) and runs in place: the same dialog adds a "Start SQL Server Agent" step row with the Start
  action's own progress and endings (Running, access denied, or on timeout left stopped with Start again offered once more, or still pending with Close only), registering its own `startAgent`
  long run, Cancel restart stays disabled,
  Close is disabled while it runs with focus on the `log` region and becomes enabled and takes focus when it ends, and
  Escape and the title-bar close follow Close (mock scene `restart-start-again`; renderer vitest for success and failure
  endings and their focus). If the stop phase passes its deadline without QueryState reading stopped, no Start is sent and the
  dialog says "SQL Server Agent did not stop within <n> s; its state is <QueryState>" (Close only, no Start again, since Agent is not stopped; mock scene `restart-stop-timeout`) while the node shows the sampled
  state. When Restart ends by itself (success, left stopped, or that stop timeout) Close becomes enabled and takes focus;
  on left stopped the footer offers Start again beside Close, as the `restart-failed` mock shows, with focus on Close.
  The Restart steps table sits in a `log` region announcing each step's result; Escape does nothing while the restart
  runs (Close disabled) and acts as Close after it ends. Renderer vitests cover success, left stopped, the stop timeout,
  Cancel restart in the stop phase and disabled in the start phase, focus on each ending, and Escape or the
  title-bar close mid-restart sending nothing.
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
| `agent.profile` | Capability read (roles, server state, Database Mail access, platform, Agent state) | Explorer lane, its own slot per connection, short deadline |
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

Actions catalogue rows (today's catalogue knows none of these kinds, `enable`/`disable` serve only logins and are titled
"Enable Login"/"Disable Login", and `delete` refuses `deleteHistory` for anything but a database):
- `actionKindSpecs` gains `agentJob`, `agentAlert`, `agentOperator`, `agentProxy`, `agentErrorLog` and `schedule` rows,
  each listing its verbs. The shared `enable`/`disable` verbs take per-kind titles ("Enable Job", "Disable Alert", …) from
  the kind row, so no Agent kind shows "Disable Login"; C#'s `enable`/`disable` refusal widens from `login` to the Agent
  kinds, each kind mapped to its own template (`sp_update_job`, `sp_update_alert`, `sp_update_operator`, `@enabled`).
- New object actions: `startJob` (with the Start Job at Step… dialog id `startJobAtStep`, whose describe lists the steps),
  `stopJob`, `enableSchedule`, `disableSchedule`, `deleteSchedule`, `recycleAgentErrorLog` (AG-5b; sysadmin; on
  `agentErrorLog`), `deleteJobHistory` (Delete History), plus the service rows above.
- New describe ids: `agentJob` (job document and New Job), `agentAlert`, `agentOperator`, `agentProxy`, `credential`,
  `schedule`, `scheduleList` (the Schedules document), the page-scoped describes (`jobAlerts`, `credentialList`,
  `alertJobPicker`, `alertOperatorPicker`), and the dialogs that stay dialogs: `agentProperties`, `startJobAtStep` (from
  the tree; the job header uses its Start menu) and the service-control dialogs. `manageSchedules` is dropped (the
  Schedules document replaces it).
- `ActionArgs` (zod and C#, strict, bounded) gain `agentIdentity` (the job, schedule, alert, operator or proxy id with its
  version or modified date), `deleteUnusedSchedule`, `reassignTo` (operator name, `sysname` bound) and a `scheduleJobs` list
  (below); `deleteHistory` widens from databases to `agentJob`, where it means `@delete_history` (both on by default, as
  SSMS).
- Describes for Agent kinds, Delete Object's included, route through `AgentReader` on the role path, never the default
  `DescribeJobAsync` over `CatalogSql`, so a role-path login's Delete Object describe works (offline check per kind that
  the switch reaches the Agent case; vitest per verb's title and enablement).
Owned by AG-2 (rows, args, routing), AG-6a (job), AG-6c (schedules), AG-7 (alerts, operators), AG-8b (proxies,
credentials), AG-5b (error logs).

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
  control is refused as `NOT_SUPPORTED` — that assertion lives in `AgentActions`, which runs everywhere. The backend's
  preflight for the three service rows refuses Linux, Managed Instance and failover cluster instances
  (`SERVERPROPERTY('IsClustered') = 1`) with `NOT_SUPPORTED` before any `xp_servicecontrol`, independent of the hidden menu
  item (offline check per profile through a fake capability read). Other Agent suites
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
  loading and failed history and Job Activity Monitor, error-log truncation, role-path history (the captured row's message,
  no elapsed time for a running job whose `start_execution_date` is NULL, the Delete History disabled reason
  for a login without EXECUTE on `sp_purge_jobhistory`, Delete History enabled for Operator with another owner's job
  checked, and a sysadmin-path start time taken from the current session's row when an older session's row has a start
  and no stop), the job Alerts page hidden for User and Reader, every service-control
  state (Starting…, Stopping…, access denied, left stopped, start timeout still pending, stop timeout, Cancel restart, the
  plain Start and Stop progress and endings, and the node menu's enablement per state), and the status-bar job with and without a
  free status-only slot.
- **Smoke**: `scripts/agent-smoke.mjs` on the fake backend (tree, Job Activity Monitor grid with multi-select Start Jobs,
  the status-bar running job with Stop, its normal end with View History, and Dismiss, job dialog round trip, Log File Viewer, the Start/Stop/Restart confirmations and progress,
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
- **Dialogs**: `dialog` with the page list as a `tablist` (as Login Properties); the Start, Stop, Enable and Disable Jobs progress dialog is a `table`
  (Action, Status, Message; one row per job, as the mock and SSMS) inside a `log` region that announces each row's result; destructive confirmations are `alertdialog`s whose
  default button is Cancel. One mechanism per confirmation: Delete History, Recycle ("Close the current SQL Server Agent
  error log and start a new one? The current log becomes Archive #1 and the oldest archive is deleted."), the Agent
  Properties purge, Remove schedule with "delete if unused", and Manage Schedules' Delete use `SubDialog`'s `destructive`
  mode (focus on Cancel; Enter acts as Cancel everywhere but the destructive button); Stop and Restart use the
  `confirmProgress` rule above; Delete on an Agent kind keeps the existing `deleteObject` dialog unchanged (`dialog`, OK and
  Cancel, as SSMS and every other kind). A vitest per `SubDialog` confirmation asserts that Enter on the form sends nothing
  destructive (mocks `delete-job` redrawn as the existing Delete Object, `remove-schedule` with Cancel the default,
  `recycle-errorlog`, `delete-operator`).
- **Status bar job**: a `status` region announcing start and end, with Stop, View History and Dismiss as buttons.

## Lanes

Rewritten on 2026-11-18 to the document model ([docs/agent-ui-rethink.md](agent-ui-rethink.md)). The sections above keep
their SQL, guards, role rules and limits; where they say "dialog", "page" or "child dialog" for a job, alert, operator,
proxy, credential or schedule, read "document" and "section", and creation in place replaces the child (see Superseded by
the document model in Jobs). Each lane builds what its Rethink scene shows; the SSMS-style scenes are reference for names,
fields and behaviour. AG-0 is split into AG-0a and AG-0b; "AG-0" above means both (the spikes are AG-0a's).

Ordered; lanes on the same line can run in parallel once their dependency lands. Sizes are rough (S < 1 day of agent
work, M, L). **Every lane's definition of done** includes its part of docs/sql-server-agent.md, README where users see a
change, CHANGELOG.md's Unreleased summary, and its Getting Started guide/sample impact or a concrete no-impact reason, as
CLAUDE.md requires. The **Shared files** column names files BigQuery lanes also change (Coordination with BigQuery below).

| Lane | Scope | Depends on | Shared files | Size |
| --- | --- | --- | --- | --- |
| AG-0a | **Done.** Foundations in new files only: `src/shared/agent/catalog.ts` (code tables, gates, decoding, limits, `AgentSql.ReadProcedures`/`WriteProcedures` lists) with `tests/agent-catalog.test.ts` generating docs/sql-server-agent.md's reference part and `Agent/agent-catalog.json`; `backend/Varia.Backend/Agent/` with `AgentSql` and `AgentSql.LintRead`, `AgentReader` (not yet wired to a method), offline suites; `VARIA_TEST_SQL_AGENT`, the scratch prefix and sweep extension, the Agent live suite skeleton; CI `MSSQL_AGENT_ENABLED` and the Agent-up wait; AG-0's spikes on the owner's test instance (results in the PR and in docs/sql-server-agent.md) | — | Program.cs `offlineSuites`, `LiveGroups.Suites`, ci.yml, `tests/ci-workflow.test.ts`, session-start.sh, CLAUDE.md's generated-files table (one row each) | M |
| AG-0b | **Done.** `agent.profile` in the five places, the `agentRole` context keys, the release gate (Coordination with BigQuery) | AG-0a, **BQ-0 merged** | contracts.ts, validation.ts, methods.ts, preload, `SqlService.DispatchAsync`, Contracts.cs, context keys | S |
| AG-1 | **Done.** Object Explorer (catalogue kinds, Agent node, folders, `explorer.agentService`, chips, Search Objects batch, icons, menus with not-yet verbs hidden, Ctrl+Q reveal), all behind the release gate. As built: Jobs list through `CatalogSql` over `sysjobs_view` for every role (msdb filters a User's jobs), not an AgentReader role path; Proxies and Error Logs are sysadmin only (no Agent role may read the proxy tables), so the AgentReader proxy path moves to the proxy lane; Search Objects indexes jobs, alerts (where the Alerts folder is served) and operators, only behind the gate, which the backend reads from its environment too (proxies, subsystems and error logs are unindexed); Error Logs lists Current alone where xp_enumerrorlogs returns no list (Linux); Copy Name copies a job, alert, operator or proxy name unquoted; a login msdb refuses or with no Agent role sees the node's PERMISSION_DENIED or NO_DB_ACCESS error value, not a `noAccess` badge (the badge from the cached capability read moves to AG-2, with the verbs it disables); the `agent.tree` change source and re-listing the node when Agent XPs flips move to AG-3 (until then Refresh reloads); Job Activity Monitor's double-click opens nothing until AG-3 | AG-0b; **before BQ-5** | explorer catalogue and its generated docs, live catalogue, icons, menus | M |
| AG-2 | **Done.** Job verbs from the tree (Start Job at Step dialog, Stop, Enable/Disable, Rename, Delete), `AgentSql.LintExecutable`, identity guard, msdb error mapping, Agent service Start / Stop / Restart through the Windows route (state only elsewhere), `agent-service.yml`. As built: the identity is the job's immutable `job_id`, which the tree lists, resolved inside each batch (no separate preflight read); service control is `AgentServiceControl` over `System.ServiceProcess.ServiceController`; the menu greys the service verbs for a clustered instance only once the backend refuses it (the tree has no cluster fact yet), and the `busy` rule waits for AG-3's status-bar job (the long gate refuses a second run); `AgentService` is excluded from grouped runs through `LiveGroups.Excluded` and `--live-suite` takes a comma-separated list; AgentSteps (CmdExec, PowerShell) stays with the step lanes | AG-1 | actions catalogue, ActionService | M |
| AG-3 | **Done.** Job Activity Monitor (`agent.jobs`, LiveGrid, tiles, chips, filters, states) with the rethink's chevron (last run in place), double-click to open (shipped with AG-6a: double-click, Enter and Open open the job document), bulk Enable, Disable, Start and Stop with one result per job; status-bar running job and Agent-stopped probe. As built: `agent.jobs` has list, service and watched probes on the server pool through AgentReader (the source's hidden policy `statusOnly` lets the status bar's watched view keep sampling while hidden); the chevron is a last-run panel below the grid fed by `args.expand`, not an in-row expansion; a started job's outcome is the first last run later than its last run before the start; the banner offers no Start Agent yet (the service verbs stay on the Agent node); no View menu item or F5 binding, so no ungated menubar item or key conflict; the tree's job-state chips and the `agent.tree` change source stay deferred | AG-1 (AG-2 for actions) | live catalogue, status bar | M |
| AG-4 | **Done.** Script As for Job, Alert, Operator, ProxyAccount. As built: one `agentObject` preflight in msdb (a job's category from `sysjobs_view`); a SQLAgentUserRole login scripts its own jobs, so Agent kinds need no role restriction (below sysadmin and SQLAgentOperatorRole a step's proxy may be left out, which the script warns of; a job name two jobs share is refused); SMO leaves an alert's notifications out (AgentNotify off, as SSMS); the `AgentScripting` checks run inside the Agent live suite and compare a job's script with SMO's own `Job.Script` (SSMS goldens wait for an SSMS run) | AG-1; **before BQ-5** | scripting catalogue, `ScriptPipeline` | S |
| AG-5a | **Done.** Log File Viewer for cross-job history, unchanged (master/detail, `agent.history`, `agent.historyMessage`, Delete History). As built: one document per connection (`agentLogViewer`) with Select logs (job checkboxes, at most `historyJobs` unless all), runs, run steps and Message details; `agent.history` reads `sp_help_jobhistory` FULL (every Agent role) for one job or all, groups runs in the backend and regroups the last read without SQL when only outcome, text, step or the selected run change; `agent.historyMessage` goes through the actions path (sysjobhistory, or the job's `sp_help_jobhistory` rows when msdb refuses the table); Delete History is the object action `deleteJobHistory` (target the Agent node, one `sp_purge_jobhistory` per job in one transaction, `AgentSql.LintHistoryDelete`); ownership below SQLAgentOperatorRole is left to msdb (14392) since no login name is at hand; smoke steps join the `agent-jobs` suite rather than a suite of their own | AG-1, AG-2, AG-3 | live catalogue | M |
| AG-5b | Agent error logs in the Log File Viewer, Recycle | AG-5a | | S |
| AG-6a | **Done.** As built: the save is one batch in one transaction (identity resolve, a STALE guard on `version_number` and `date_modified` under `UPDLOCK, HOLDLOCK`, a guard per removed alert, each call's return code checked) with its own lint `AgentSql.LintJobSave`; no new RPC (`actions.describe`/`execute`/`script` with the `agentJob` dialog); a renamed job is followed by its id, and only the job itself missing is `NOT_FOUND` (which opens the compare); Steps and Schedules stay with AG-6b and AG-6c. Planned: Job document shell (`rx-job-general`, `-notifications`, `-alerts`, `-readonly`, `-stale`, `-denied`, `-new`): an Agent document kind on `DocumentFrame` and the document service, as Table Designer; opens from the tree, Job Activity Monitor, Ctrl+Q and the palette (one tab per job, focused if open); header with live state from `agent.jobs`, Start split button with the step menu (`rx-start-step`) and Stop; sections General, Notifications (Database Mail readiness, off-duty pager), Targets, Alerts (list, Remove; New Alert opens beside with AG-7); dirty state, "Save · n changes", close prompt; read-only mode; Problems (field, section, header; warn, never block); the one-transaction save with `STALE`, the field-by-field compare and "Reload and keep my changes"; errors on the field that caused them; Script; New Job's start panel (Blank, Copy an existing job) | AG-2, AG-3 | document kinds in `services/documents.ts`, commands catalogue | L |
| AG-6b | **Done.** Steps master/detail (`rx-job-steps`, `rx-step-ssis`, `-ps`, `-cmdexec`, `-delete`). As built: the draft keys steps (`s<id>`, `n<k>`) so go-to targets follow a move; the planner (`planAgentSteps`, `src/shared/agent/steps.ts`) saves inside the job's transaction as deletes (highest first), a temporary `__varia_step_<hex>` name for every survivor, inserts under temporary names, every step's whole content written by id, then `@start_step_id`, each shape admitted by `AgentSql.LintJobSave`; one new method, `language.parse` (ScriptDom, nothing runs); T-SQL editors complete against the step's database through `registerSqlModel`; PowerShell and CmdExec get Monaco's `powershell` and `bat` languages; the SSIS step reuses `ssis.describe` and `explorer.children` for its inline picker. Move up and Move down buttons stand in for Alt+Up and Alt+Down (the gesture lint keeps modifier reads out of the renderer). Load from file… for CmdExec and PowerShell is left for a follow-up (it needs a main open-file API) | AG-6a | | L |
| AG-6c | **Done.** As built: no new RPC; one `agentSchedule` object action with `op` (create, update, enable, disable, delete) in place of the `manageSchedules`/`schedule` dialogs and per-row actions above, and the describe id `agentSchedules` in place of `scheduleList`; the job document's schedule changes ride on its `agentJob` save (detach, guarded attach, guarded update, add, last in its transaction); guards compare `version_number` and `date_modified`; lint `AgentSql.LintScheduleSave`. Below sysadmin only a schedule's owner may change it (SQLAgentOperatorRole's Enable and Disable of others' schedules is not offered yet); the Timeline view (`rx-timeline`) and an Agent live suite for schedules are not part of it. Known gaps: a repeating window that crosses midnight is counted on the day it starts, and an every-N-months schedule counts its months from its start date; neither is yet checked against what a live Agent runs. Planned: Schedules (`rx-job-schedules`, `-schedule-pick`, `-schedule-remove`, `rx-schedules-doc`): `schedule.ts` encoding and sentences, presets, next five runs, free-slot check, the in-place editor, pick with search and preview, Remove with detach or delete and Undo, the Schedules document replacing Manage Schedules; Agent node New › Schedule… | AG-6a | | M |
| AG-6d | **Done.** History in place and the live run view (`rx-job-history`, `rx-job-running`): runs with step states, the failed step's message open, usual duration (median of the last 10 successful runs) and sparkline, SSIS execution link. As built: no new RPC; the section is one `agent.history` view with one checked job and a new `usual` arg, for which the probe adds a fourth table (the job's and each step's median over its newest 10 succeeded runs, computed in the backend over the grouped runs); the run view times the run from the header's `agent.jobs.watched` start and server clock; the SSIS execution link opens a query window over `SSISDB.catalog.event_messages` (not run), since Varia has no execution messages view yet; the sparkline is plain bars, not a ChartView chart; Output file (SSMS's View) stays later with the other output viewers | AG-6a, AG-5a | | M |
| AG-6e | **Done.** As built: a pure `src/shared/agent/create-from.ts` (the copy's draft, Share/Copy/Leave out, Replace across the copy, key fields, Compare with source, the `agent.createJobLike` command) that AG-6f's rows reuse; New Job's describe then the source's (`JobDocumentService.createLike`), a Changes from source section first, and New Job's own `agentJob` save (no new RPC or backend write); Job Activity Monitor's entry is a bar button beside Open, as it has no row menu. Planned: Create Job Like This (`rx-create-from`): Changes from source, Replace across the copy with preview, per-step key fields, schedules Share, Copy or Leave out, Compare with source; entry points on the job menu, Job Activity Monitor and the palette; saves through New Job's save | AG-6b, AG-6c | commands catalogue | M |
| AG-6f | **Done.** As built: a pure `src/shared/agent/create-several.ts` (columns over the copy's template, rows of typed cells over a full-editor draft, Fill, checks, review summary) and a table mode of the copy's own job tab (`JobDocumentService.createSeveral`, `CreateSeveral.tsx`); each row saves through New Job's `agentJob` save and Enable uses AG-2's `enable` (no new RPC or backend write). Planned: Create several (`rx-create-several`, `-review`): table, Columns, per-row overrides, Open full editor and back, Fill, checks, one transaction per row, Enable the created jobs | AG-6e | | M |
| AG-6g | Unsaved Agent documents in hot exit and AutoRecover, restored like query tabs | AG-6a, **BQ-3d merged** | session and AutoRecover records, docs/hot-exit.md | S |
| AG-7 | Alerts and operators (`rx-alert`, `-alert-perf`, `-alerts-recommended`, `rx-operators`, `-operator-delete`): alert document on one screen (When / Then / Options, history in the header, current counter values), operator chips with the inline new operator, the Operators and notifications grid, Send test e-mail and the Agent mail check, Add recommended alerts, Delete operator with Reassign to; Enable/Disable, Rename, Delete; Agent node New › Operator… and Alert…; the job's Alerts section Add | AG-6a | actions catalogue | L |
| AG-8a | **Done.** SQL Server Agent Properties (`rx-agent-props`; stays a dialog) with what retention keeps per job and the inline purge confirmation. As built: the existing `actions.describe`/`actions.execute` carry it (action `agentProperties`, no new method); OK sends only the changed settings; Delete old history runs apart from OK through `ObjectDialogService.runInline`; the Properties item is enabled for every Agent role and the describe opens it read-only below sysadmin and on Managed Instance | AG-1, AG-2 | | S |
| AG-8b | **Done.** Proxy document on one screen with the inline credential (`rx-proxy`); Credential document with Used by (`rx-credential`); Rename, Delete, Agent node New › Proxy…. As built: no new RPC (`actions.describe`/`execute`/`script` with the `agentProxy` and `credential` dialogs, Rename and Delete on target kind `agentProxy`); both documents share `AgentObjectDocumentService` on the job document's model, with a per-document secret slot (`SecretSlot`) instead of `ObjectDialogService`'s, whose modal slot a document cannot hold; a proxy save is two batches, the principal grants and revokes after the transaction commits, since msdb's principal check (`EXECUTE AS LOGIN` in TRY/CATCH) dooms a user transaction; the credential identity limit is 128 characters, which CREATE and ALTER CREDENTIAL enforce (15540) | AG-6a | actions catalogue, `ObjectDialogService` secret slot | M |
| AG-3b | Job Activity Monitor bulk Change owner and Attach schedule, one request per job | AG-3, AG-6c | | S |
| AG-9 | Getting Started guide and sample, parity re-check, the release gate removed | all | help catalogue | S |
| Later | Schedules Timeline, Agent overview health checks, Copy to another server, New Job templates, Flow view; Manage Job Categories, multi-server targets, Script Action to Job, output file and table log viewers, Activity Monitor job links, SQL Server Logs and Database Mail in the Log File Viewer, Agent Properties' remaining pages and fail-safe operator, WMI alert editing, Elastic Jobs | | | |

Suggested waves: AG-0a (now) → AG-0b once BQ-0 merges → AG-1 → {AG-2, AG-4} → {AG-3, AG-8a} → AG-6a →
{AG-5a, AG-6b, AG-6c, AG-7, AG-8b} → {AG-5b, AG-6d, AG-6e, AG-3b} → AG-6f → AG-6g once BQ-3d merges → AG-9.
Lanes that touch the Agent tree menus, the actions catalogue or the document service (AG-2, AG-6a, AG-6e, AG-7, AG-8a,
AG-8b) merge main in after each lands, as the Activity Monitor lanes did.

Scope cut if 0.11.0 runs long: must ship AG-0a to AG-6c; may slip AG-6d to AG-6f, AG-7, AG-8a, AG-8b and AG-3b.
Operators, alerts and proxies stay listable and scriptable from AG-1 and AG-4.

## Coordination with BigQuery

BigQuery (docs/bigquery-plan.md) is the 0.10.0 milestone and runs at the same time, with BQ-0 in progress. Agent must not
slow it down:

- **Before BQ-0 merges, only AG-0a.** BQ-0 touches every registry (methods in the five places, context keys, the
  commands, menus, Explorer and actions catalogues, tab and session records). AG-0a adds new files and one line in each of
  a few shared lists; it registers no method, context key, command, menu, Explorer kind or action. Everything that
  registers waits for BQ-0, then takes its `providers` default of `['sqlserver']` and its lint.
- **Agent never edits a BigQuery lane's hot files beyond appending.** No refactor of a shared file inside an Agent lane: if
  one is needed it is its own small PR, announced in the shared notes folder first.
- **Order in the files both plans change:**

  | Shared area | BigQuery lane | Rule |
  | --- | --- | --- |
  | ci.yml, `tests/ci-workflow.test.ts`, session-start.sh, `LiveGroups` | BQ-1 (emulator service and live group) | One-line additions each; whichever merges second merges main |
  | The five method places, context keys, catalogues' `providers` | BQ-0 | AG-0b and later start after BQ-0 merges |
  | Explorer catalogue, docs/object-explorer.md, `explorer-catalog.json` | BQ-5 | AG-1 lands before BQ-5 starts |
  | Scripting catalogue, `ScriptPipeline` | BQ-5 (Script As) | AG-4 lands before BQ-5 starts |
  | Status bar | BQ-2 (principal and project) | Agent adds its chip in its own item; no change to the connection item |
  | Live catalogue | BQ-9 (`bigquery` scope) | Additive entries |
  | Session and AutoRecover records, docs/hot-exit.md | BQ-3a-2, BQ-3d | AG-6g after BQ-3d merges |
  | Results pipeline, query execution, connect dialog, settings pages | BQ-2, BQ-3a to BQ-3c, BQ-7 | Agent does not touch them |

- **Release gate** (agreed 2026-11-18). Agent lanes merge to main during 0.10.0 but Agent must not appear in 0.10.0. From AG-0b, every Agent
  surface (Explorer node, commands, menus, documents) is behind a context key `agentEnabled`, false unless the
  `VARIA_AGENT_PREVIEW=1` environment variable is set (smoke and live tests set it); while it is false the server lists
  no SQL Server Agent node and the tree is as it was before Agent. AG-9 removes the gate for 0.11.0. AG-0a has no user-visible surface.
- After each BigQuery lane merges, open Agent branches merge main. Agent sessions note their shared-file changes in the
  shared notes folder (`agent-shared-infrastructure.md`).

## Questions still open

None blocking (the release gate, Share as the Create from… default and the Windows service-control route were decided on
2026-11-18). AG-1's platform-gate verification reports back in its PR. If the Windows CI job cannot install SQL Server in
a reasonable time, that comes back to the owner before AG-2 merges.
