# SQL Server Agent

SQL Server Agent support is planned for 0.11.0 ([docs/agent-plan.md](agent-plan.md), UI in
[docs/agent-ui-rethink.md](agent-ui-rethink.md)). Behind the release gate (below) Object Explorer shows the SQL Server Agent node, a job's Start Job at Step…, Stop
Job, Enable, Disable, Rename and Delete, and the Agent node's Start, Stop and Restart; Search Objects finds jobs, alerts
and operators, Script As scripts jobs, alerts, operators and proxies, and Job Activity Monitor follows the jobs live. The job
documents arrive in later lanes, behind the same gate until 0.11.0.

## How it works

- **One catalogue.** `src/shared/agent/catalog.ts` declares msdb's code tables with SSMS's names, the platform gates, the
  decoding of msdb's integer dates, times and durations, the limits and the procedures Agent may call. The backend embeds
  it as `backend/Varia.Backend/Agent/agent-catalog.json`, and the reference below is generated from it.
- **Reads.** `AgentSql` holds the backend's Agent read statements as constant text with values as parameters. Every one is
  checked by `AgentSql.LintRead`: the live lint's rules, plus two exemptions. A statement may `EXEC` an allowlisted msdb
  procedure with named arguments, or a master procedure in its one fixed shape (both listed below), and the expected
  prologue is the caller's (the live prologues, Object Explorer's, or none for describes, whose prologue runs as its own
  command). `AgentReader` runs the statements one by one on the caller's connection: each fails alone as a value (a
  refusal, a missing procedure, or `AGENT_DISABLED` for error 15281), reads at most its cap plus one row, and cancels the
  rest so a full result says it was truncated.
- **Times** are the server's local time, as msdb stores them; nothing converts them to this computer's time zone.
- **Release gate.** Agent's surfaces show only when Varia was started with `VARIA_AGENT_PREVIEW=1`: main reads the
  variable once and passes the window an argument, which becomes the static context key `agentEnabled`. Without it Object
  Explorer shows no SQL Server Agent node and no Agent command, menu item or document is offered.
- **What the login may do** (`agent.profile`). One constant batch in msdb, on the Object Explorer pool on its own slot per connection,
  reads the login's sysadmin membership and Agent roles (`IS_ROLEMEMBER`, so nested membership counts), EXECUTE on
  `sp_purge_jobhistory` and `sysmail_help_profile_sp`, the server-state permissions `sys.dm_server_services` and Agent's
  sessions need (VIEW SERVER STATE, and from SQL Server 2022 VIEW SERVER SECURITY or PERFORMANCE STATE), ALTER ANY
  CREDENTIAL, whether the server is a failover cluster instance, and `Agent XPs` and `Database Mail XPs` in use. A server
  with no Agent (Express, the cloud editions) answers `NOT_SUPPORTED` without connecting; msdb refusing the login (916)
  is a profile with no role and no msdb permission, whose server facts a second read at server scope still fills in. The renderer derives the login's Agent role from it (`agentRoleOf`: sysadmin, operator,
  reader, user, none; unknown before the read, profileFailed after a failed one), which the context keys `agentRole`
  (Object Explorer's menu) and `explorerSelectionAgentRole` carry for Agent nodes.
- **Job verbs** (object actions, docs/object-actions.md). A job's context menu offers Start Job at Step… and Stop Job, then
  Disable (Enable on a disabled job), Rename and Delete. Start Job at Step… reads the job and its steps (`sp_help_jobstep`):
  a job with one step starts as the dialog opens, as SSMS's does, and one with more lists its steps, the first chosen.
  Stop Job, Disable, Enable and Rename run as status-bar jobs with Stop; Delete is Delete Object, which also deletes the
  job's history and the schedules no other job uses. Each verb sends the job's creation time from the tree
  (`agentIdentity`, sysjobs `date_created` to the second), and its one batch resolves the job by name and that time first,
  so a job created since under the name is refused `NOT_FOUND` before msdb runs anything. The batches call only the msdb
  procedures listed below, with named arguments, and are checked by `AgentSql.LintExecutable`, an exact-shape allow list.
  msdb's procedures report failures by return code, so each batch raises its own error on a nonzero code. SQL Server
  Agent's 22022 is read again before it is reported: Agent XPs off is `AGENT_STOPPED` ("SQL Server Agent is not running"),
  a job that is not running when stopped, or already running when started, is `JOB_STATE`; msdb's 14261, 14262 and 14372
  are `NAME_IN_USE`, `NOT_FOUND` and `IN_USE`.
- **Service control** (`AgentServiceControl`). The Agent node's Start, Stop and Restart ask before they run ("Are you sure
  you want to stop the SQLAgent$SALES service on DB01?", with the state the Service Control Manager reports) and then show
  their steps in place: Restart stops the service, waits for Stopped, starts it and waits for Running. They go through
  Windows' Service Control Manager as the Windows user Varia runs as, so Windows decides, as in SSMS; the SQL login needs
  no role. The machine is `SERVERPROPERTY('ComputerNamePhysicalNetBIOS')` and the service `SQLSERVERAGENT` or
  `SQLAgent$<instance>`, both read from the server and checked against strict patterns; nothing typed names a machine.
  Each call is bounded (`serviceStatementMs`, `serviceReadMs`) and a wait polls every `servicePollMs` up to
  `serviceWaitMs`. Access denied is `PERMISSION_DENIED` ("Starting and stopping SQL Server Agent needs Windows
  administrator rights on <machine>"), an unreachable machine or Service Control Manager `SERVICE_UNREACHABLE`, no
  such service `NOT_FOUND`, and a Start while the service is still stopping `BLOCKED`. The verbs are offered with Varia on Windows for a Windows server that is not Managed Instance
  and not a failover cluster instance; elsewhere they stay in the menu, greyed with the reason (Varia not on Windows, a
  Linux server, Managed Instance, the service changing state), and the backend refuses them
  `NOT_SUPPORTED`. A start, stop or restart takes the long gate, so one runs per connection. The state shown elsewhere
  stays SQL's (`xp_servicecontrol N'QueryState'`); `xp_servicecontrol` never starts or stops anything.
- **Job Activity Monitor** (`agent.jobs`, docs/live.md). The Agent node's menu (first item), Enter or double-click on its
  Job Activity Monitor node, and the palette's SQL Server Agent: Job Activity Monitor open one document per connection
  ("Job Activity Monitor - server"), focused if open. Its view of `agent.jobs.list` (every 5 s) and `agent.jobs.service`
  (every 10 s) lists every job the login may see from `sp_help_job`, with SSMS's columns, how long a running job has run
  and a tone per row (last run failed, running, disabled). Tiles count Running, Last run failed, Between retries and
  Disabled, and pressing one shows only those jobs; the View chips (All, Running, Failed, Disabled), the filter box and
  the column value filters narrow the list in backend memory, and Clear filters takes them all off. The Last run chevron
  shows the selected job's last run below the list (`args.expand`: the job outcome and step rows from the newest
  `lastRunRows` rows of `sp_help_jobhistory`; when that read stops inside the run, the panel says only its newest steps
  show, or that no finished run is among those rows).
  Start, Stop, Enable and Disable act on the selected jobs (at most `startJobs`), one AG-2 request per job in turn with
  the job's identity from the list, and list one result line per job; Stop on that list sends no more. A login msdb
  refuses sees "No access to SQL Server Agent" with the roles that grant it; Agent stopped or Agent XPs off is a banner,
  a note below the list says Status is msdb's last reading, and the list refreshes once Agent runs again. Opening a job
  from the list waits for the job documents (AG-6a).
- **Status bar.** A job Start started from Job Activity Monitor is followed in the status bar ("Nightly: running step 1
  of 3", then its outcome and start in server time) with Stop and Dismiss, and +N for more; at most `watchedJobs` per
  connection are followed. Each connection has one view of `agent.jobs.watched` and `agent.jobs.service` with
  `whileHidden: 'statusOnly'`, so the job's end is seen while the window is hidden; a run counts only when its start is
  later than the job's last run before the start (the list's, or the one a sample reads while the job runs). Agent
  stopped (or its XPs off) on a server a monitor or a followed job reads shows as its own item, which opens that server's
  Job Activity Monitor; after a followed job ends that way, the service probe alone keeps reading Agent's state until it
  runs again. The connection item is unchanged.
- **Script As.** A job, alert, operator or proxy node offers SSMS's Script Job as, Script Alert as, Script Operator as and
  Script Proxy as, each with CREATE, DROP and DROP And CREATE to a new query, a file or the clipboard (rows in
  [docs/scripting.md](scripting.md)). SMO writes the script through `ScriptPipeline` as for every other kind (headers
  guarded, nothing executed): the msdb procedures SSMS writes (`sp_add_job` with its steps, schedules and target server in
  one transaction, `sp_add_alert`, `sp_add_operator`, `sp_add_proxy` with its subsystems, which SMO leaves out for a Linux server), after `USE [msdb]`. A proxy's
  script names its credential, never a secret; an alert's leaves out its notifications, as SSMS's does. The preflight
  (`agentObject`) reads the object by name from msdb's tables in msdb through the scope wrapper, a job from
  `sysjobs_view` with its category, since SMO finds a job below `JobServer` by name and category. A login in
  `SQLAgentUserRole` alone scripts its own jobs (`sysjobs_view` shows it only those); msdb refuses it the alert,
  operator and proxy tables, which Object Explorer does not list for it either. Below `sysadmin` and
  `SQLAgentOperatorRole`, SMO names a step's proxy only if msdb shows that proxy to the login, so a job with a step of
  another subsystem than T-SQL that names no proxy is scripted with a warning to check its steps. A job name that two jobs share (a
  multi-server job from a master server and a local job) is refused as ambiguous. A cloud database has no Agent to script.
  As for every kind Script As can write, Search Objects' details pane shows a selected job's, alert's or operator's CREATE
  script.

## What AG-0 found on a real server

Checked on 2026-11-18 against SQL Server 2025 Developer (17.0.1000.7) on Windows, Agent running under its default virtual
account `NT Service\SQLSERVERAGENT` and the engine under `NT Service\MSSQLSERVER`, as sysadmin unless noted. Low-privilege
checks impersonated a scratch SQL login (`EXECUTE AS LOGIN`) that was a member of `SQLAgentUserRole` only.

- **Service control does not work on the default virtual accounts.** `xp_servicecontrol N'Stop'` and `N'Start'`
  (`N'SQLServerAgent'`) both fail with message 22003, "StartService() returned error 5, 'Access is denied.'", `@rc = 1`
  and `@@ERROR` 0. The text says StartService for a Stop too, and a Start of the running service fails the same way, so
  error 5 comes before any state check (1056 is never reached). `N'QueryState'` works and answers `Running.`. Below
  sysadmin, `xp_servicecontrol` and `xp_enumerrorlogs` are refused with 229.
- **Agent XPs off.** With `Agent XPs` set to 0 while Agent ran, `sp_help_job` (with and without arguments, and through
  SqlClient and `AgentReader` under every caller's prologue) did **not** raise 15281: it returned every job with `current_execution_status` 4 (Idle). `sp_help_jobactivity`,
  `sp_help_jobhistory @mode = N'FULL'`, `sp_help_jobstep`, `sp_help_jobschedule`, `sp_help_schedule`, `sp_help_category`,
  `sp_help_operator`, `sp_help_alert`, `sp_help_proxy`, `sp_help_jobs_in_schedule`, `sp_enum_sqlagent_subsystems`,
  `xp_enumerrorlogs 2`, `xp_readerrorlog` and `QueryState` also answered. Only `sp_get_sqlagent_properties` and
  `xp_sqlagent_enum_jobs` raised 15281. So a job list cannot tell "Agent off" from "all idle": the Agent state comes from
  the service probe and `Agent XPs` (`sys.configurations`, `configuration_id` 16384, `value_in_use`), never from a failed
  job read. Reads while the Agent *service* is stopped were not checked (it could not be stopped from T-SQL, above);
  stopping Agent turns `Agent XPs` off, so they are expected to behave the same.
- **`sp_get_sqlagent_properties`** returned every value, the history caps and the Agent error log's path included, to the
  `SQLAgentUserRole` login. Its cap text, idle-CPU and mail facts can show to every role that can run it.
- **Server state on SQL Server 2025.** `sys.dm_server_services` answered to any one of VIEW SERVER STATE, VIEW SERVER
  SECURITY STATE or VIEW SERVER PERFORMANCE STATE; without them it raised 300 (naming the last two) and then 297.
  `sys.dm_exec_sessions` returned **no** `SQLAgent - %` sessions, and no error, to a login without VIEW SERVER PERFORMANCE
  STATE, so a session count is only meaningful behind a `HAS_PERMS_BY_NAME` check.
- **Roles.** `SQLAgentUserRole` ran `sp_help_job`, `sp_help_jobactivity` and `sp_enum_sqlagent_subsystems`, and has no
  EXECUTE on `sp_purge_jobhistory` (`HAS_PERMS_BY_NAME` 0).
- **`version_number`.** `sysjobs.version_number` went up with `sp_add_jobstep`, `sp_update_jobstep`,
  `sp_delete_jobstep`, `sp_update_job` (any argument, `@enabled` included) and `sp_detach_schedule`, but **not** with
  `sp_attach_schedule` or `sp_update_schedule`. `sysschedules.version_number` went up with `sp_update_schedule`
  (`@enabled` included) and not with attach or detach. A job's identity guard therefore does not see another session
  attaching a schedule to it.
- **msdb errors.** Each failure below returned `@rc = 1` with `@@ERROR` 0 after it, so only a return-code check sees it:
  14261 for a job or step name in use, 14262 for a missing job id and for a step's database that does not exist, 14234
  for an owner login that does not exist, 14266 for a schedule frequency type that is not valid, 14372 for deleting a
  schedule a job uses, and 22022 for stopping a job that is not running.
- **One transaction per save.** Under `XACT_ABORT ON` with no `TRY`, a failing `sp_add_jobstep` raised msdb's 14262 first,
  then the template's `THROW 50012` with the call's index as its state, and nothing committed. Inside `BEGIN TRY` the
  msdb error jumps straight to `CATCH` instead (the THROW never runs), so templates do not use `TRY`. No error 266 came
  from `sp_add_job` or `sp_add_jobschedule` failing inside a transaction.
- **Subsystems.** `syssubsystems` listed TSQL, CmdExec, Snapshot, LogReader, Distribution, Merge, QueueReader,
  ANALYSISQUERY, ANALYSISCOMMAND, SSIS and PowerShell.
- **Error logs.** `xp_enumerrorlogs 2` returns `Archive #`, `Date` and `Log File Size (Byte)`, with 0 the current log;
  `xp_readerrorlog <n>, 2, …, N'desc'` returns `LogDate`, `ErrorLevel` and `Text`, newest first.
- **Linux (CI's SQL Server 2022 container).** `xp_enumerrorlogs 2` returns no result set at all, so Linux lists no archives
  and the reader reports `NOT_SUPPORTED`; `xp_readerrorlog 0, 2, …` still reads the current Agent log, and
  `xp_servicecontrol N'QueryState'` answers "Running.".

- **Agent's state (Object Explorer's `explorer.agentService`).** On Windows `sys.dm_server_services` lists `SQL Server Agent
  (<instance>)` with its status and startup type. Where it lists no Agent row, the probe falls back to whether an
  `SQLAgent - …` session is connected (running or stopped, no startup type), only for a login that sees other sessions
  (VIEW SERVER PERFORMANCE STATE from SQL Server 2022; without it the state is unknown, as 0 sessions would read as
  stopped). The DMV itself answers VIEW SERVER SECURITY or PERFORMANCE STATE from 2022, VIEW SERVER STATE before. The Agent live suite's check says which
  answered, so CI's Linux container log records the Linux answer. Managed Instance's Agent always runs and cannot be
  stopped (Microsoft's T-SQL differences page), so the probe reads running there without the DMV.
- **Subsystems.** `msdb.dbo.syssubsystems` lists TSQL as `subsystem_id` 1. Object Explorer's Proxies folder lists every
  other subsystem with its proxies, labelled as SSMS labels them, so Linux shows the ones its container reports.

Not checked yet: Managed Instance's `sp_readmierrorlog` and archives (no instance to test), service control on a named
instance or under a domain account (AG-2's Windows workflow), and how history records a reordered step (AG-6b).

## Testing

`VARIA_TEST_SQL_AGENT=1` turns on the Agent live suite (docs/testing.md): it waits for Agent to come up, then fails if it
never does. Scratch Agent objects use the run prefix with a kind tag (`_job`, `_sch`, `_op`, `_al`, `_px`, `_cr`) and are
swept by `ScratchDatabase.SweepAsync` once their prefix is more than 6 hours old. With `VARIA_TEST_SQL_SCRATCH=1` the
suite also runs the job verbs on its scratch job through `actions.describe` and `actions.execute`. Its Script As checks
(`AgentScriptingLiveChecks`) script this run's job, operator, alert (Windows) and proxy, compare the job's script with
SMO's own `Job.Script`, run the job's DROP And CREATE script, and script a `SQLAgentUserRole` login's own job (on Windows,
its step that runs as a proxy comes without the proxy and with the warning).

`AgentJobsChecks` checks the `agent.jobs` reader offline over a fake runner (rows, tones, views, filters, the last run,
the watched slots, the service probe and each refusal) and, in the Agent live suite, subscribes to all three probes on
the scratch job. The `agent-jobs` smoke suite drives Job Activity Monitor against the fake backend's jobs: opening it,
a view chip, Start on two jobs with the status bar following them, the Last run chevron and reopening it from its node.

The service verbs have offline checks through the `IServiceControl` fake (every refusal, the waits, a partial restart and
the platform gates) and a live suite of their own, `AgentService` (`VARIA_TEST_SQL_AGENT_SERVICE=1`), which really stops,
starts and restarts Agent and leaves it running. No grouped or full live run reaches it: it runs only through
`npm run backend:test:agent-service`, under the exclusive machine lock so no other session's Agent checks run while Agent
is stopped, and in `.github/workflows/agent-service.yml` (docs/ci.md) against a named instance on Windows. A remote
server's service control is checked by hand.

<!-- Generated below from src/shared/agent/catalog.ts. Regenerate with: npx vitest run tests/agent-catalog.test.ts -u -->

## Reference

### Servers

The Agent node shows on engine editions 1 (Personal), 2 (Standard), 3 (Enterprise and Developer), 8 (Managed Instance). Express and the cloud editions have no Agent.

### Platform gates

| Feature | Windows | Linux | Managed Instance | Note |
| --- | --- | --- | --- | --- |
| Alerts folder, the job Alerts section, New › Alert and operators' alert notifications | Yes | No | No |  |
| Proxies folder | Yes | Yes | No | Linux lists the subsystems `syssubsystems` has. |
| SQL Server event alerts | Yes | No | No |  |
| Performance condition alerts | Yes | No | No |  |
| WMI event alerts | Yes | No | No |  |
| Start whenever the CPUs become idle schedules | Yes | Yes | No |  |
| E-mail notifications | Yes | Yes | Yes | Managed Instance sends only through the Database Mail profile `AzureManagedInstance_dbmail_profile`. |
| Pager notifications | Yes | Yes | No |  |
| Net send notifications | Yes | No | No |  |
| Write to the Windows Application event log | Yes | No | No |  |
| Agent error logs | Yes | Yes | Yes | Managed Instance reads them through `sp_readmierrorlog`; the others through `xp_readerrorlog`. |
| Agent error log archives (`xp_enumerrorlogs`) | Yes | No | No | SQL Server 2022 on Linux answers `xp_enumerrorlogs 2` with no result set, so Linux shows Current only; Managed Instance too until a Managed Instance check shows archives list there. |
| Changing SQL Server Agent Properties | Yes | Yes | No |  |
| Credentials with a Windows identity | Yes | Yes | No |  |
| Start, Stop and Restart of the Agent service | Yes | No | No | Not on a failover cluster instance (`SERVERPROPERTY('IsClustered') = 1`), where the cluster owns the service. |
| Multi-server (MSX/TSX) targets | No | No | No | Later on every platform; the Targets section shows the local server only. |

Step types each platform can run; a server offers those its `syssubsystems` lists:

| Type | msdb name | Windows | Linux | Managed Instance |
| --- | --- | --- | --- | --- |
| Transact-SQL script (T-SQL) | `TSQL` | Yes | Yes | Yes |
| Operating system (CmdExec) | `CmdExec` | Yes | No | No |
| PowerShell | `PowerShell` | Yes | No | No |
| SQL Server Integration Services Package | `SSIS` | Yes | No | Yes |
| SQL Server Analysis Services Command | `ANALYSISCOMMAND` | Yes | No | No |
| SQL Server Analysis Services Query | `ANALYSISQUERY` | Yes | No | No |
| Replication Distributor | `Distribution` | Yes | Yes | Yes |
| Replication Merge | `Merge` | Yes | No | No |
| Replication Queue Reader | `QueueReader` | Yes | No | No |
| Replication Snapshot | `Snapshot` | Yes | Yes | Yes |
| Replication Transaction-Log Reader | `LogReader` | Yes | Yes | Yes |

### Codes

Job and step outcomes (`run_status`):

| Code | Meaning | Tone |
| --- | --- | --- |
| `0` | Failed | error |
| `1` | Succeeded | success |
| `2` | Retry | warning |
| `3` | Canceled | muted |
| `4` | In Progress | accent |

Last run outcome (`sp_help_job`):

| Code | Meaning | Tone |
| --- | --- | --- |
| `0` | Failed | error |
| `1` | Succeeded | success |
| `3` | Canceled | muted |
| `5` | Unknown |  |

Execution status (`current_execution_status`):

| Code | Meaning | Tone |
| --- | --- | --- |
| `0` | Not tracked on this server |  |
| `1` | Executing | accent |
| `2` | Waiting for worker thread | accent |
| `3` | Between retries | warning |
| `4` | Idle |  |
| `5` | Suspended | warning |
| `7` | Performing completion actions | accent |

Step actions on success and on failure:

| Code | Meaning |
| --- | --- |
| `1` | Quit the job reporting success |
| `2` | Quit the job reporting failure |
| `3` | Go to the next step |
| `4` | Go to step |

Step flags Varia sets (others are kept as read):

| Bit | Meaning |
| --- | --- |
| `2` | Append output to the output file |
| `4` | Include step output in history |
| `8` | Log to table |
| `16` | Log to table, appending to the existing entry |

Schedule types (`freq_type`):

| Code | Meaning |
| --- | --- |
| `1` | One time |
| `4` | Daily |
| `8` | Weekly |
| `16` | Monthly |
| `32` | Monthly, relative |
| `64` | Start automatically when SQL Server Agent starts |
| `128` | Start whenever the CPUs become idle |

Daily frequency units (`freq_subday_type`):

| Code | Meaning |
| --- | --- |
| `1` | At the specified time |
| `2` | Seconds |
| `4` | Minutes |
| `8` | Hours |

Weekly days (`freq_interval` bits):

| Code | Meaning |
| --- | --- |
| `1` | Sunday |
| `2` | Monday |
| `4` | Tuesday |
| `8` | Wednesday |
| `16` | Thursday |
| `32` | Friday |
| `64` | Saturday |

Monthly relative weeks (`freq_relative_interval`) and days (`freq_interval`):

| Code | Meaning |
| --- | --- |
| `1` | First |
| `2` | Second |
| `4` | Third |
| `8` | Fourth |
| `16` | Last |

| Code | Meaning |
| --- | --- |
| `1` | Sunday |
| `2` | Monday |
| `3` | Tuesday |
| `4` | Wednesday |
| `5` | Thursday |
| `6` | Friday |
| `7` | Saturday |
| `8` | Day |
| `9` | Weekday |
| `10` | Weekend day |

Notification levels (`notify_level_*`, `delete_level`):

| Code | Meaning |
| --- | --- |
| `0` | Never |
| `1` | When the job succeeds |
| `2` | When the job fails |
| `3` | When the job completes |

Alert types and notification methods:

| Code | Meaning |
| --- | --- |
| `1` | SQL Server event alert |
| `2` | SQL Server performance condition alert |
| `4` | WMI event alert |

| Code | Meaning |
| --- | --- |
| `1` | E-mail |
| `2` | Pager |
| `4` | Net send |

Dates, times and durations are SQL Server's local time, as msdb stores them: a date is `yyyymmdd` (0 is never), a time
`hhmmss`, and a duration `hhmmss` with hours past 99 as more leading digits (`1234505` is 123:45:05).

### Procedures

Reads may `EXEC` only these msdb procedures, as `EXEC msdb.dbo.<name> @argument = @parameter, …;` with named arguments,
each a parameter or one of the constants listed (`AgentSql.LintRead`):

| Procedure | Arguments | Who can run it |
| --- | --- | --- |
| `msdb.dbo.sp_help_job` | `@job_id`, `@job_aspect` (`N'JOB'`) | Every Agent role (its own jobs for SQLAgentUserRole) |
| `msdb.dbo.sp_help_jobhistory` | `@job_id`, `@step_id`, `@run_status`, `@start_run_date`, `@end_run_date`, `@mode` (`N'FULL'`) | Every Agent role |
| `msdb.dbo.sp_help_jobactivity` | `@job_id`, `@session_id` | Every Agent role |
| `msdb.dbo.sp_help_jobstep` | `@job_id`, `@step_id` | Every Agent role |
| `msdb.dbo.sp_help_jobschedule` | `@job_id`, `@schedule_id`, `@include_description` (`1`) | Every Agent role |
| `msdb.dbo.sp_help_schedule` | `@schedule_id`, `@include_description` (`1`) | Every Agent role |
| `msdb.dbo.sp_help_category` | `@class` (`N'JOB'`, `N'ALERT'`, `N'OPERATOR'`) | Every Agent role |
| `msdb.dbo.sp_help_operator` | `@operator_id` | Every Agent role (msdb grants SQLAgentUserRole EXECUTE) |
| `msdb.dbo.sp_help_alert` | `@alert_id` | SQLAgentOperatorRole and sysadmin |
| `msdb.dbo.sp_help_notification` | `@object_type` (`N'ALERTS'`, `N'OPERATORS'`), `@name`, `@enum_type` (`N'ACTUAL'`, `N'ALL'`), `@notification_method` (`7`) | SQLAgentOperatorRole and sysadmin |
| `msdb.dbo.sp_help_proxy` | `@proxy_id`, `@subsystem_name` | Every Agent role (proxies granted to it below sysadmin) |
| `msdb.dbo.sp_enum_login_for_proxy` | `@proxy_id` | SQLAgentOperatorRole and sysadmin |
| `msdb.dbo.sp_help_jobs_in_schedule` | `@schedule_id` | Every Agent role (its own jobs for SQLAgentUserRole) |
| `msdb.dbo.sp_enum_sqlagent_subsystems` | none | Every Agent role |
| `msdb.dbo.sp_get_sqlagent_properties` | none | Every Agent role (AG-0: SQLAgentUserRole gets values); fails with 15281 while Agent XPs is off |

And these master procedures, each in exactly this shape (`@p` is a parameter):

| Procedure | Statement | Who can run it |
| --- | --- | --- |
| `xp_enumerrorlogs` | `EXEC master.dbo.xp_enumerrorlogs 2;` | sysadmin |
| `xp_readerrorlog` | `EXEC master.dbo.xp_readerrorlog @p, 2, @p, @p, NULL, NULL, N'desc';` | sysadmin |
| `sp_readmierrorlog` | `EXEC master.dbo.sp_readmierrorlog @p, 2, @p, @p;` | Managed Instance; sysadmin |
| `xp_servicecontrol` | `EXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';` | sysadmin |

Writes (from AG-2) call only these, each followed by a return-code check:

| Procedure | Arguments | Lane |
| --- | --- | --- |
| `msdb.dbo.sp_start_job` | `@job_id`, `@step_name` | AG-2 |
| `msdb.dbo.sp_stop_job` | `@job_id` | AG-2 |
| `msdb.dbo.sp_update_job` | `@job_id`, `@enabled`, `@new_name` | AG-2 |
| `msdb.dbo.sp_delete_job` | `@job_id`, `@delete_history`, `@delete_unused_schedule` | AG-2 |
| `msdb.dbo.sp_purge_jobhistory` | later lanes | AG-6a |
| `msdb.dbo.sp_add_job` | later lanes | AG-6a |
| `msdb.dbo.sp_add_jobserver` | later lanes | AG-6a |
| `msdb.dbo.sp_update_alert` | later lanes | AG-6a |
| `msdb.dbo.sp_add_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_update_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_delete_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_add_jobschedule` | later lanes | AG-6c |
| `msdb.dbo.sp_attach_schedule` | later lanes | AG-6c |
| `msdb.dbo.sp_detach_schedule` | later lanes | AG-6c |
| `msdb.dbo.sp_add_schedule` | later lanes | AG-6c |
| `msdb.dbo.sp_update_schedule` | later lanes | AG-6c |
| `msdb.dbo.sp_delete_schedule` | later lanes | AG-6c |
| `msdb.dbo.sp_add_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_update_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_add_alert` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_alert` | later lanes | AG-7 |
| `msdb.dbo.sp_add_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_update_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_set_sqlagent_properties` | later lanes | AG-8a |
| `msdb.dbo.sp_add_proxy` | later lanes | AG-8b |
| `msdb.dbo.sp_update_proxy` | later lanes | AG-8b |
| `msdb.dbo.sp_delete_proxy` | later lanes | AG-8b |
| `msdb.dbo.sp_grant_proxy_to_subsystem` | later lanes | AG-8b |
| `msdb.dbo.sp_revoke_proxy_from_subsystem` | later lanes | AG-8b |
| `msdb.dbo.sp_grant_login_to_proxy` | later lanes | AG-8b |
| `msdb.dbo.sp_revoke_login_from_proxy` | later lanes | AG-8b |
| `msdb.dbo.sp_cycle_agent_errorlog` | later lanes | AG-5b |

msdb error numbers the actions map (AG-2 onward; reads map 15281 to `AGENT_DISABLED` instead):

| Number | Code | Meaning |
| --- | --- | --- |
| `14261` | `NAME_IN_USE` | The name is already in use (a job, or a step within its job). |
| `14262` | `NOT_FOUND` | An id or name does not exist (a job, or a step's database). |
| `14234` | `SQL_ERROR` | An argument is not valid (such as an owner login that does not exist). |
| `14266` | `SQL_ERROR` | An argument is not one of its valid values (such as a schedule's frequency type). |
| `14372` | `IN_USE` | A schedule is still used by a job. |
| `15281` | `AGENT_STOPPED` | Agent XPs is off (SQL Server Agent is stopped or disabled). |
| `22022` | `JOB_STATE` | SQL Server Agent refused a start or stop; decided by a re-read, never by number. |
| `22003` | `SQL_ERROR` | Every `xp_servicecontrol` failure (only its `QueryState` read is used); the Windows code is in its text. |

### Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `listRows` | 5,000 | Jobs one listing holds; more set `truncated` |
| `historyRows` | 10,000 | History rows one history read holds, newest first; more set `truncated` |
| `historyJobs` | 64 | Jobs one history filter or one Delete History names |
| `logRows` | 10,000 | Error log rows one read holds, newest first (oldest first on Managed Instance, whose `sp_readmierrorlog` takes no sort argument); the rest are cancelled and a notice says so |
| `searchChars` | 200 | Characters of a history or error log search text |
| `gridMessageChars` | 512 | Characters of a history message in a grid cell (the details pane reads all of it) |
| `messageChars` | 4,000 | Characters `sysjobhistory.message` holds |
| `nameChars` | 128 | UTF-16 code units in an Agent object's name (sysname) |
| `stepsPerJob` | 50 | Steps one job save may hold |
| `schedulesPerJob` | 16 | Schedules one job save may hold |
| `scheduleJobChanges` | 64 | Jobs one schedule save may attach or detach |
| `lastRunRows` | 201 | History rows Job Activity Monitor's last run reads, newest first, before it cancels the rest |
| `startJobs` | 100 | Jobs one Start, Stop, Enable or Disable from Job Activity Monitor may name |
| `watchedJobs` | 3 | Jobs the status bar follows with live progress |
| `serviceStatementMs` | 30,000 | One service Start or Stop statement, in ms |
| `serviceWaitMs` | 60,000 | How long a Start or Stop waits for the service's new state, in ms |
| `serviceReadMs` | 10,000 | One service state read, in ms |
| `servicePollMs` | 500 | How often a Start or Stop's wait polls the service's state, in ms |
| `agentUpWaitMs` | 120,000 | How long the live checks wait for Agent after the server is up, in ms |
| `profileMs` | 10,000 | The budget of `agent.profile` once it has its Object Explorer slot, in ms (a TIMEOUT value past it, unless msdb already refused the login: then the profile with no role) |

A job save makes at most 140 calls at these caps, below the 255 a THROW state can number.
