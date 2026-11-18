# SQL Server Agent

SQL Server Agent support is planned for 0.11.0 ([docs/agent-plan.md](agent-plan.md), UI in
[docs/agent-ui-rethink.md](agent-ui-rethink.md)). Nothing of it is visible yet: the foundations below are in the code, and
the Agent node, Job Activity Monitor and the job documents arrive in later lanes, behind the `VARIA_AGENT_PREVIEW=1`
release gate until 0.11.0.

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

## What AG-0 found on a real server

Checked on 2026-11-18 against SQL Server 2025 Developer (17.0.1000.7) on Windows, Agent running under its default virtual
account `NT Service\SQLSERVERAGENT` and the engine under `NT Service\MSSQLSERVER`, as sysadmin unless noted. Low-privilege
checks impersonated a scratch SQL login (`EXECUTE AS LOGIN`) that was a member of `SQLAgentUserRole` only.

- **Service control does not work on the default virtual accounts.** `xp_servicecontrol N'Stop'` and `N'Start'`
  (`N'SQLServerAgent'`) both fail with message 22003, "StartService() returned error 5, 'Access is denied.'", `@rc = 1`
  and `@@ERROR` 0. The text says StartService for a Stop too, and a Start of the running service fails the same way, so
  error 5 comes before any state check (1056 is never reached). `N'QueryState'` works and answers `Running.`. Below
  sysadmin, `xp_servicecontrol` and `xp_enumerrorlogs` are refused with 229.
- **Agent XPs off.** With `Agent XPs` set to 0 while Agent ran, `sp_help_job` (with and without arguments) did **not**
  raise 15281: it returned every job with `current_execution_status` 4 (Idle). `sp_help_jobactivity`,
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

Not checked yet: the Linux container's `sys.dm_server_services` and subsystems (AG-1, against CI's container), Managed
Instance's `sp_readmierrorlog` and archives (no instance; AG-1 from Microsoft's documentation), service control on a
named instance or under a domain account (AG-2's Windows workflow), and how history records a reordered step (AG-6b).

## Testing

`VARIA_TEST_SQL_AGENT=1` turns on the Agent live suite (docs/testing.md): it waits for Agent to come up, then fails if it
never does. Scratch Agent objects use the run prefix with a kind tag (`_job`, `_sch`, `_op`, `_al`, `_px`, `_cr`) and are
swept by `ScratchDatabase.SweepAsync` once their prefix is more than 6 hours old.

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
| Agent error log archives (`xp_enumerrorlogs`) | Yes | Yes | No | Managed Instance shows Current only until a Managed Instance check shows archives list there. |
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
| `3` | WMI event alert |

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

| Procedure | Lane |
| --- | --- |
| `msdb.dbo.sp_start_job` | AG-2 |
| `msdb.dbo.sp_stop_job` | AG-2 |
| `msdb.dbo.sp_update_job` | AG-2 |
| `msdb.dbo.sp_delete_job` | AG-2 |
| `master.dbo.xp_servicecontrol` | AG-2 |
| `msdb.dbo.sp_purge_jobhistory` | AG-6a |
| `msdb.dbo.sp_add_job` | AG-6a |
| `msdb.dbo.sp_add_jobserver` | AG-6a |
| `msdb.dbo.sp_update_alert` | AG-6a |
| `msdb.dbo.sp_add_jobstep` | AG-6b |
| `msdb.dbo.sp_update_jobstep` | AG-6b |
| `msdb.dbo.sp_delete_jobstep` | AG-6b |
| `msdb.dbo.sp_add_jobschedule` | AG-6c |
| `msdb.dbo.sp_attach_schedule` | AG-6c |
| `msdb.dbo.sp_detach_schedule` | AG-6c |
| `msdb.dbo.sp_add_schedule` | AG-6c |
| `msdb.dbo.sp_update_schedule` | AG-6c |
| `msdb.dbo.sp_delete_schedule` | AG-6c |
| `msdb.dbo.sp_add_operator` | AG-7 |
| `msdb.dbo.sp_update_operator` | AG-7 |
| `msdb.dbo.sp_delete_operator` | AG-7 |
| `msdb.dbo.sp_add_alert` | AG-7 |
| `msdb.dbo.sp_delete_alert` | AG-7 |
| `msdb.dbo.sp_add_notification` | AG-7 |
| `msdb.dbo.sp_update_notification` | AG-7 |
| `msdb.dbo.sp_delete_notification` | AG-7 |
| `msdb.dbo.sp_set_sqlagent_properties` | AG-8a |
| `msdb.dbo.sp_add_proxy` | AG-8b |
| `msdb.dbo.sp_update_proxy` | AG-8b |
| `msdb.dbo.sp_delete_proxy` | AG-8b |
| `msdb.dbo.sp_grant_proxy_to_subsystem` | AG-8b |
| `msdb.dbo.sp_revoke_proxy_from_subsystem` | AG-8b |
| `msdb.dbo.sp_grant_login_to_proxy` | AG-8b |
| `msdb.dbo.sp_revoke_login_from_proxy` | AG-8b |
| `msdb.dbo.sp_cycle_agent_errorlog` | AG-5b |

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
| `22003` | `SQL_ERROR` | Every `xp_servicecontrol` failure; the Windows code is in its text ("returned error 5" is access denied). |

### Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `listRows` | 5,000 | Jobs one listing holds; more set `truncated` |
| `historyRows` | 10,000 | History rows one history read holds, newest first; more set `truncated` |
| `historyJobs` | 64 | Jobs one history filter or one Delete History names |
| `logRows` | 10,000 | Error log rows one read holds, newest first; the rest are cancelled and a notice says so |
| `searchChars` | 200 | Characters of a history or error log search text |
| `gridMessageChars` | 512 | Characters of a history message in a grid cell (the details pane reads all of it) |
| `roleMessageChars` | 1,024 | Characters of a message `sp_help_jobhistory` returns to logins below sysadmin |
| `messageChars` | 4,000 | Characters `sysjobhistory.message` holds |
| `nameChars` | 128 | UTF-16 code units in an Agent object's name (sysname) |
| `stepsPerJob` | 50 | Steps one job save may hold |
| `schedulesPerJob` | 16 | Schedules one job save may hold |
| `scheduleJobChanges` | 64 | Jobs one schedule save may attach or detach |
| `startJobs` | 100 | Jobs one Start, Stop, Enable or Disable from Job Activity Monitor may name |
| `watchedJobs` | 3 | Jobs the status bar follows with live progress |
| `serviceStatementMs` | 30,000 | One service Start or Stop statement, in ms |
| `serviceWaitMs` | 60,000 | How long a Start or Stop waits for the service's new state, in ms |
| `serviceReadMs` | 10,000 | One service state read, in ms |
| `agentUpWaitMs` | 120,000 | How long the live checks wait for Agent after the server is up, in ms |

A job save makes at most 140 calls at these caps, below the 255 a THROW state can number.
