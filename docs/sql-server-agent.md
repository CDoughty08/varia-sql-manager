# SQL Server Agent

SQL Server Agent support is planned for 0.11.0 ([docs/agent-plan.md](agent-plan.md), UI in
[docs/agent-ui-rethink.md](agent-ui-rethink.md)). Behind the release gate (below) Object Explorer shows the SQL Server Agent node, a job's New Job…, View History, Start Job at Step…, Stop
Job, Enable, Disable, Rename, Delete and Properties, and the Agent node's Start, Stop, Restart and Properties; Search Objects finds jobs, alerts
and operators, Script As scripts jobs, alerts, operators and proxies, Job Activity Monitor follows the jobs live, the
Log File Viewer reads and deletes job history, the job document edits a job's General, Schedules, Notifications, Targets and Alerts or creates a job, and the
Schedules document manages the shared schedules. The job document's Steps section arrives in a later lane, behind the same gate until 0.11.0.

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
  job's history and the schedules no other job uses. Each verb sends the listed job's immutable msdb `job_id` and name. If another job has
  taken the name, the batch returns `NOT_FOUND` before calling the procedure. The batches call only the msdb
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
  Disabled, and pressing one shows only those jobs; the View chips (All, Running, Failed, Disabled), the filter box (the
  job's own columns, never the last run) and the column value filters narrow the list in backend memory, and Clear filters takes them all off. The Last run chevron
  shows the selected job's last run below the list (`args.expand`: the job outcome and step rows from the newest
  `lastRunRows` rows of `sp_help_jobhistory`; when that read stops inside the run, the panel says only its newest steps
  show, or that no finished run is among those rows; a job that left the list says so).
  Start, Stop, Enable and Disable act on the selected jobs (at most `startJobs`), one AG-2 request per job in turn with
  the job's identity from the list, and list one result line per job; Stop on that list sends no more. A login msdb
  refuses sees "No access to SQL Server Agent" with the roles that grant it; Agent stopped or Agent XPs off is a banner,
  a note below the list says Status is msdb's last reading, and the list refreshes once Agent runs again. Double-click,
  Enter or Open on the selected job opens its job document.
- **Job document** (`agentJob`, object actions, docs/object-actions.md). One tab per job ("Job Properties - Nightly"), opened
  from a job's node (Enter, double-click or Properties), from Job Activity Monitor, from Ctrl+Q's object search and from the
  palette's SQL Server Agent: Open Job… (the job selected in Job Activity Monitor or Object Explorer, else a pick of the
  server's jobs). The header shows the job's live state from `agent.jobs.watched` (running and its step, or idle with the last
  outcome), Start with a step menu (Start once at step, which leaves the job's start step alone), Stop while it runs, Reload
  and Save. Sections: **General** (name, owner, category, description, enabled; only sysadmin changes the owner),
  **Notifications** (e-mail, page, net send, Windows event log and delete, each a level and an operator; whether Database Mail
  can send, read through `sysmail_help_profile_sp` where the login may, and an operator's missing address or pager duty hours
  as warnings), **Targets** (this server only; multi-server targets come later) and **Alerts** (the alerts that run the job;
  Remove for sysadmin only, since msdb grants `sp_update_alert` to no Agent role; New Alert comes with the Alerts lane).
  Another owner's job below sysadmin opens read-only with the reason. Edits mark the tab dirty, Save counts them ("Save · 2
  changes"), closing asks to save, and Problems warn and only block what msdb would refuse (a missing name, owner or operator).
  **Save** sends only what changed with the version and modified date the describe read, as one batch in one transaction:
  the job is resolved by name and its immutable `job_id`, the STALE guard compares `version_number` and `date_modified` under `UPDLOCK, HOLDLOCK` (so no other save lands
  before this one's) and THROWs 50011 when either moved, each removed alert is checked to still run this job before `sp_update_alert @job_id` detaches it
  (the zero GUID), and every call checks its return code (50012 with the call's index), so nothing commits unless all of it
  does. A refusal lands on the field the failing call changed (msdb's "does not exist" for an owner, operator or alert is a `SQL_ERROR` there, since `NOT_FOUND` means the job itself), the document keeps the edits, and `STALE`, or `NOT_FOUND` for a job no longer under the name it was read by (the compare finds a renamed job by its id; a job deleted and created again under the name is not compared, and Reload opens it), opens a field-by-field
  compare of what the server and you changed, a field changed by both first with a choice each, offering Reload and keep my
  changes or Discard mine and reload. The Script drawer shows SSMS's shape (`BEGIN TRANSACTION`, each call followed by
  `GOTO QuitWithRollback`) by name with literal values. **New Job** (a Jobs folder's or job's menu, or the palette) opens a
  start panel: Blank job, or Copy an existing job, which fills General and Notifications from the job picked ("Copy of …");
  nothing is created until Create, which runs `sp_add_job` and `sp_add_jobserver` in one transaction. The save batches have
  their own exact-shape lint, `AgentSql.LintJobSave`. Pager duty is not yet checked against the job's schedules.
- **Schedules** (`src/shared/agent/schedule.ts` for the encoding, sentences, presets, runs and free-slot check;
  `src/shared/actions/agent-schedule.ts` for the saves). The job document's **Schedules** section lists the job's schedules, each
  with its short "when" and whether other jobs share it, and edits the selected one in place with SSMS's own fields (Occurs,
  Daily frequency, Duration; an ending time of 00:00 is 23:59:59, as msdb stores it; past SSMS's own limits, such as every 365 days, which msdb accepts, the editor warns instead of refusing, and a job's schedule as read is checked only once it is changed), preset chips that only fill those fields ("Every day at…", "Weekdays at…", "Weekly on…", "Every N
  minutes", "Monthly on day…", and under More… agent start, CPU idle and one time; Managed Instance offers no CPU idle and refuses a schedule set to it, and an idle schedule warns where Agent has no idle CPU condition), SSMS's sentence, the next five runs in server
  time (the describe reads the server's clock; disabled, agent-start and idle schedules say why they have none) and, for
  sysadmin, a **free-slot check**: this schedule's next runs, each lasting the job's usual duration (the median of its last 10
  successful runs from `sp_help_jobhistory`, or a minute when it has none; a run is at least a second, so two starting together clash), against the runs of every other enabled job's
  schedules lasting theirs. A schedule shared with other jobs names them and says a change moves them too, with **Copy for this
  job only** (detach the shared one as read, add a copy that keeps the edits); one the login neither owns nor may change
  (below sysadmin) is read-only with Copy. **Add** searches the shared schedules the login can see (any owner's: msdb's `sp_attach_schedule` asks only for the job's owner) by name or by when they run ("night", "every
  15 minutes", "sunday"); a match shows a preview (sentence, owner, next runs, the jobs that use it) with Attach, and New
  schedule starts from SSMS's defaults, named from the search. **Remove** marks the job's schedule removed with Undo and a
  choice: detach it and keep the schedule, or (its owner and sysadmin) detach it and delete it when no job uses it. Nothing
  reaches the server until the job's Save, which runs the schedule calls last in the job's transaction in a fixed order:
  `sp_detach_schedule` (with `@delete_unused_schedule` for delete, so msdb deletes only an unused schedule, jobs the login cannot
  see included, and never fails the save over it), a guarded `sp_attach_schedule` for each picked one, a guarded
  `sp_update_schedule` for each edited one (after the attach, which leaves the schedule's version as it is, so a picked schedule
  edited in the same save passes both guards), and `sp_add_jobschedule` for each new one. Each guard compares the schedule's
  `version_number` and `date_modified` (`sysschedules_localserver_view`, `UPDLOCK, HOLDLOCK`) and THROWs 50011 with the call's
  index, so a schedule changed since it was read is `STALE` on the Schedules field and nothing commits.
- **Schedules document** (Manage Schedules on the Jobs folder's menu and the palette; New › Schedule… on the Agent node). One
  document per connection replaces SSMS's Manage Schedules dialog: a grid of the shared schedules (name, when, Enabled, how many
  jobs, owner) with All, Unused and Disabled views and a filter that matches schedule names, job names (sysadmin, whose read has the links) and when schedules run, and
  beside it the selected schedule's editor (the same one as the job document's), the jobs that use it with Detach and Attach a
  job (only jobs the login owns, or any for sysadmin, as msdb allows, on any schedule the login can see; another login's schedule takes only these job changes), and Save. Edits are kept per schedule until saved, each guarded by the schedule as its edit began, so neither Refresh nor
  the read after another save lets it pass over someone else's change; a STALE save reads again and shows their change with the
  user's on top, for the user to save again. Closing the tab with unsaved ones asks Save / Don't Save; Save (and File › Save) saves each changed schedule in turn and stops at the first refused. Only a save under way stops the close. The grid's **Enabled** box saves at once. New schedule and Duplicate edit a draft that
  Create adds; Delete asks inline and never forces, so msdb refuses one a job uses (`IN_USE`, 14372), saying how many jobs.
  Every change is the `agentSchedule` object action on the Agent node with `op` `create` (`sp_add_schedule` with the new id as
  an OUTPUT local, then guarded `sp_attach_schedule`s), `update` (the guard, `sp_update_schedule` with what changed, then guarded
  attaches and `sp_detach_schedule`s), `enable`, `disable` or `delete` (`sp_delete_schedule` without `@force_delete`), one
  transaction each with the guard above and each job's `version_number` checked before it is attached or detached. Below
  sysadmin, `sysjobschedules` is closed, so a schedule's jobs are read when it is selected (`sp_help_jobs_in_schedule`, which
  shows SQLAgentUserRole only its own jobs) and Unused counts every job, the unseen included. The saves have their own
  exact-shape lint, `AgentSql.LintScheduleSave`, which also refuses `@force_delete`.
- **Proxies and credentials** (`agentProxy`, `credential`, object actions, docs/object-actions.md). A proxy's document ("Proxy
  Account Properties - FileShareWriter") opens from a proxy's node (Enter, double-click or Properties); **New Proxy…** from the
  Proxies folder, a subsystem's folder (the proxy starts active to it), Unassigned Proxies or a proxy, and **Proxy…** from the
  SQL Server Agent node's New submenu (SQL Server only: Managed Instance has no proxies). Only sysadmin reads or changes
  proxies; below it the describe answers `PERMISSION_DENIED`. One screen: **Proxy** (name, the credential, description,
  enabled), **Subsystems** (every subsystem but T-SQL), **Principals** (logins, msdb roles and server roles that may use it
  besides sysadmin, picked or typed) and **References** (the job steps that run as it). The credential is picked, or created
  in place (name, identity, password and its confirmation) for a login with ALTER ANY CREDENTIAL. **Save** sends only what
  changed under the `proxy_id` the describe read (a proxy renamed or replaced since is `NOT_FOUND`) in two batches: first, in
  one transaction, CREATE CREDENTIAL when the save makes one, `sp_add_proxy` or `sp_update_proxy`, and the subsystem grants and
  revokes; then, without a transaction, the principal grants and revokes, because msdb checks a principal that is not a login
  with `EXECUTE AS LOGIN` inside TRY/CATCH, which dooms any open transaction (3930). A refused first batch changes nothing and
  keeps the draft; a refused second batch leaves the rest saved, so the document reads the proxy again and shows which
  principal was refused. msdb ignores a grant to a sysadmin member, who may use every proxy anyway. A **credential's
  document** ("Credential Properties - …", Security › Credentials, on SQL Server and Managed Instance; New Credential… on the
  folder or a credential) shows its name, identity, creation and modification dates, and **Used by** (the proxies that run as
  it with their subsystems, then their job steps; sysadmin only). SQL Server never returns a secret, so the password starts
  empty behind **Change identity and password**, and Save sends the identity and the password together (ALTER CREDENTIAL sets
  both) behind a STALE guard on the credential's id, name and `modify_date`. Without ALTER ANY CREDENTIAL it opens read-only.
  New Credential lists the server's enabled cryptographic providers when it has any. **Secrets**: the password fields are
  uncontrolled; what is typed lives only in the renderer's per-document secret slot (a snapshot learns only whether it is
  set, confirmed, well formed and within `credentialSecretChars`), travels only in that one `actions.execute`'s
  `secrets.secret`, and the slot is emptied after Save, on Reload, when the proxy goes back to an existing credential, when
  the change is unchecked and when the tab closes. The backend builds the statement on the server from parameters (the name
  through `QUOTENAME`, the identity and secret quoted by a binary-collation `REPLACE`), never logs it, scrubs it from any
  error text, and Script writes `<secret>` in its place. **Rename** and **Delete** of a proxy are the object actions' (Delete
  Object reads the proxy's id; Rename from the tree finds it by name). Each batch has an exact-shape lint
  (`AgentSql.LintProxySave`, `CredentialSql.Lint`).
- **Log File Viewer** (`agent.history`, docs/live.md). Job › View History, the Agent node's and the Jobs folder's View
  History, Job Activity Monitor's View history (the selected jobs) and the palette's SQL Server Agent: View History open one
  document per connection ("Log File Viewer - server"), focused if open with its sources replaced. **Select logs** lists every
  job the login may see, with All jobs; at most `historyJobs` may be checked unless all are. The runs grid (newest first) reads
  `sp_help_jobhistory` with `@mode = N'FULL'`, which every Agent role may call, for each checked job by its id (a multi-server job, which msdb answers by id with its target servers, from the every-job read) or for all, with
  `@start_run_date` for the window (24 h, Last 7 days, 30 days, All; the server's clock, read in the same sample), at most
  `historyRows` rows (once the rows read reach it, checked jobs not yet read are left out, and the note says how many; a checked job deleted since is skipped); a read that stops there says it was truncated, and a note gives the server's history caps. The backend
  groups rows into runs by each job's outcome rows: the steps after one outcome row and up to the next belong to the next
  run. Steps with no outcome row read In progress when the job is running and started at or before them, Unknown (Agent stopped
  or restarted during the run) otherwise, or In progress or unknown when the Agent XPs option is 0 and the service is not read
  as stopped (the Unknown and In progress filters keep those). The read starts a day before the window, which keeps runs by
  their start, so a run Agent never finished stays Unknown in any window; a run that started before the read (one longer than
  about a day) has its outcome row outside it, so its later steps read Unknown too, with a message that says so and that a wider
  window reads it; steps of a run that spans a daylight-saving fall-back
  can read as an Unknown run, as msdb stores local times. The Outcome, Message contains and Step filters regroup the last read in backend memory, without SQL; only the
  sources and the window read msdb again. Selecting a run shows its steps (outcome row first) and the selected row's message in
  **Message details** with Copy; the grids cut messages at `gridMessageChars`, so the details pane reads the whole message
  with `agent.historyMessage` (`sysjobhistory` by instance in msdb, or, when msdb refuses that table, the job's
  `sp_help_jobhistory` rows). **Delete History…** deletes the checked jobs' history, all of it or only rows older than a number
  of days, weeks or months counted back from the server's clock, after a confirmation naming the jobs. It is the `deleteJobHistory` object action: one
  batch calls `sp_purge_jobhistory` once per job with `@job_id` (and `@oldest_date` from the server's own clock for "older than")
  in one transaction, checked by its own exact-shape lint (`AgentSql.LintHistoryDelete`), and reports msdb's messages. Below
  sysadmin and SQLAgentOperatorRole it is offered only with EXECUTE on `sp_purge_jobhistory`, and msdb lets such a login delete only
  its own jobs' history; msdb's 14392 is `PERMISSION_DENIED` and Agent XPs off `AGENT_STOPPED`. Agent stopped is the same banner as Job Activity
  Monitor's. The viewer's source list is a list of logs, so the Agent error logs (AG-5b) join it as more sources.
- **Status bar.** A job Start started from Job Activity Monitor is followed in the status bar ("Nightly: running step 1
  of 3", then its outcome and start in server time) with Stop and Dismiss, and +N for more; at most `watchedJobs` per
  connection are followed, and as many ended items are kept (the oldest goes). Each connection has one view of `agent.jobs.watched` and `agent.jobs.service` with
  `whileHidden: 'statusOnly'`, so the job's end is seen while the window is hidden; a run counts only when its start is
  later than the job's last run before the start (the list's, or the one a sample reads while the job runs) and not
  before the Start itself, dated in server time by the watched probe's clock (unless the job was seen running since, as
  Start is refused while a job runs). Agent
  stopped (or its XPs off) on a server a monitor or a followed job reads shows as its own item, which opens that server's
  Job Activity Monitor (with several such servers, a pick of them; a monitor whose connection is gone does not count); after a followed job ends that way, the service probe alone keeps reading Agent's state until it
  runs again. The connection item is unchanged.
- **SQL Server Agent Properties** (the Agent node's Properties, a modal dialog; object actions, docs/object-actions.md). General
  shows the service account and whether it starts automatically, SSMS's "Auto restart SQL Server if it stops unexpectedly"
  and "Auto restart SQL Server Agent if it stops unexpectedly", and the error log, read-only for now; Advanced, Alert System,
  Job System and Connection come later. History has SSMS's "Limit size of job history log", "Maximum job history log size"
  (2 to `historyMaxRows`, or no limit) and "Maximum job history rows per job" (1 to the log's size). Below them, **What this
  keeps** lists the jobs with the most history, each with the rows it wrote over the last `retentionDays` days and how long
  its history lasts under the limits now, and under the ones being typed when they differ: rows per job over the job's rate,
  or the log's size over every job's rate where that is less, which a note points out, since Agent then removes the oldest
  rows of any job. Reading every job's history needs sysadmin; below it the table says why it is missing.
  OK sends only what changed, through `sp_set_sqlagent_properties` with NULL for the rest, which msdb leaves as it is (the two
  sizes go together, since msdb checks one against the other; sizes left as they were are never sent). **Delete old history now** is not a setting: older than a
  number of days, weeks or months (up to `purgeCount`), with the cut-off and about how many rows it deletes. Delete history…
  asks inline, Cancel focused, naming the server, the cut-off and, when the server's clock is in another time zone,
  "(server time)"; Escape or Cancel answers no. Delete history then runs at once, apart from OK, and the dialog reads the
  history again and keeps any unsaved change. The confirmation's cut-off is the server's clock advanced by the time the dialog has been open. The
  server computes the cut-off from its own clock (`DATEADD` back from `GETDATE()`, the local time msdb stores), never later
  than the one the confirmation showed, and the batch THROWs before `sp_purge_jobhistory` if it is NULL, which msdb would read as all history; msdb's
  info message says how many rows went. Both writes name no job, so they have their own exact-shape lint,
  `AgentSql.LintServerExecutable`. msdb grants `sp_set_sqlagent_properties` to no role and Managed Instance refuses it, so
  below sysadmin and on Managed Instance the dialog opens read-only with the reason and only Close; the action and its Script
  are refused `NOT_SUPPORTED` on Managed Instance before any connection opens. On Linux, where mssql-conf sets Agent's settings and
  `sp_set_sqlagent_properties`' registry writes end the session, the settings show read-only with that reason, and Delete old history still runs. The describe and
  the write read the platform themselves: a settings write and its Script are refused `NOT_SUPPORTED` before any connection
  opens, or, when the connect probe could not tell, by the write's own platform read before msdb is called. A purge msdb refuses (14392) is
  `PERMISSION_DENIED`, and Agent XPs off is `AGENT_STOPPED`.
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

`AgentJobDocumentChecks` checks the job document's planner offline: the save lint and its near misses, each save's batch, the
validation, the error mapping onto fields and the script's shape. In the Agent live suite, `AgentJobDocumentLiveChecks`
describes the scratch job, saves it under the STALE guard and is refused STALE on an older version, fails a later call and
checks nothing committed, renames it to a hostile name and back, runs the script back against msdb, detaches a scratch alert
(Windows), and after the job verbs delete the job creates it again through New Job. The `agent-job` smoke suite opens jobs from
Job Activity Monitor (double-click and Enter), saves an edit and a removed alert, loses a save to another session's (the fake
backend's `job-save-race` control file) and saves after Reload and keep my changes, starts the job once at a step, and creates
a job by copying another from New Job.

`AgentScheduleChecks` checks the schedules offline: the schedule saves' lint and its near misses (a missing guard, `@force_delete`,
a write out of order), each save's batch for the job document and the Schedules document, the timing rules that mirror
`timingProblem`, the validation, the error mapping onto the Schedules field, the script and the describe's records, jobs and
median durations. The `agent-job` smoke suite adds a schedule from a preset and attaches a shared one found by search on the job
document, then, in the Schedules document, saves an Enabled box at once and a rename under the guard, and creates a schedule
from the Agent node's New › Schedule….

`AgentHistoryChecks` checks the `agent.history` reader offline over a fake runner (the statements each source and window
reads, grouping into runs with In progress, Unknown and Agent XPs off, the filters regrouping without SQL, truncation and each
refusal), Delete History's validation and lint with near misses, and `agent.historyMessage`'s fallback. In the Agent live suite
with `VARIA_TEST_SQL_SCRATCH=1`, `AgentHistoryLiveChecks` reads the scratch job's run and its steps through `live.subscribe`,
reads a message, and runs Delete History on it and a second scratch job (older than 30 days keeps the run, all deletes it).
The `agent-jobs` smoke suite opens the Log File Viewer from Job Activity Monitor and drives All jobs, the Failed outcome, a
run's steps and message, and Delete History.

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
| Changing SQL Server Agent Properties | Yes | No | No | On Linux mssql-conf sets them (`sp_set_sqlagent_properties` writes the registry); Delete old history still runs there. |
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
| `msdb.dbo.sysmail_help_profile_sp` | none | sysadmin and DatabaseMailUserRole |

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
| `msdb.dbo.sp_update_job` | `@job_id`, `@enabled`, `@new_name`, `@description`, `@category_name`, `@owner_login_name`, `@notify_level_eventlog`, `@notify_level_email`, `@notify_level_netsend`, `@notify_level_page`, `@notify_email_operator_name`, `@notify_netsend_operator_name`, `@notify_page_operator_name`, `@delete_level` | AG-2 |
| `msdb.dbo.sp_delete_job` | `@job_id`, `@delete_history`, `@delete_unused_schedule` | AG-2 |
| `msdb.dbo.sp_purge_jobhistory` | `@oldest_date`, `@job_id` | AG-8a |
| `msdb.dbo.sp_add_job` | `@job_name`, `@enabled`, `@description`, `@category_name`, `@owner_login_name`, `@notify_level_eventlog`, `@notify_level_email`, `@notify_level_netsend`, `@notify_level_page`, `@notify_email_operator_name`, `@notify_netsend_operator_name`, `@notify_page_operator_name`, `@delete_level`, `@job_id` | AG-6a |
| `msdb.dbo.sp_add_jobserver` | `@job_id` | AG-6a |
| `msdb.dbo.sp_update_alert` | `@name`, `@job_id` | AG-6a |
| `msdb.dbo.sp_add_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_update_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_delete_jobstep` | later lanes | AG-6b |
| `msdb.dbo.sp_add_jobschedule` | `@job_id`, `@name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time` | AG-6c |
| `msdb.dbo.sp_attach_schedule` | `@job_id`, `@schedule_id` | AG-6c |
| `msdb.dbo.sp_detach_schedule` | `@job_id`, `@schedule_id`, `@delete_unused_schedule` | AG-6c |
| `msdb.dbo.sp_add_schedule` | `@schedule_name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time`, `@schedule_id` | AG-6c |
| `msdb.dbo.sp_update_schedule` | `@schedule_id`, `@new_name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time` | AG-6c |
| `msdb.dbo.sp_delete_schedule` | `@schedule_id` | AG-6c |
| `msdb.dbo.sp_add_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_update_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_operator` | later lanes | AG-7 |
| `msdb.dbo.sp_add_alert` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_alert` | later lanes | AG-7 |
| `msdb.dbo.sp_add_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_update_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_delete_notification` | later lanes | AG-7 |
| `msdb.dbo.sp_set_sqlagent_properties` | `@sqlserver_restart`, `@monitor_autostart`, `@jobhistory_max_rows`, `@jobhistory_max_rows_per_job` | AG-8a |
| `msdb.dbo.sp_add_proxy` | `@proxy_name`, `@enabled`, `@description`, `@credential_name`, `@proxy_id` | AG-8b |
| `msdb.dbo.sp_update_proxy` | `@proxy_id`, `@credential_name`, `@new_name`, `@enabled`, `@description` | AG-8b |
| `msdb.dbo.sp_delete_proxy` | `@proxy_id` | AG-8b |
| `msdb.dbo.sp_grant_proxy_to_subsystem` | `@proxy_id`, `@subsystem_id` | AG-8b |
| `msdb.dbo.sp_revoke_proxy_from_subsystem` | `@proxy_id`, `@subsystem_id` | AG-8b |
| `msdb.dbo.sp_grant_login_to_proxy` | `@proxy_id`, `@login_name`, `@fixed_server_role`, `@msdb_role` | AG-8b |
| `msdb.dbo.sp_revoke_login_from_proxy` | `@proxy_id`, `@name` | AG-8b |
| `msdb.dbo.sp_cycle_agent_errorlog` | later lanes | AG-5b |

msdb error numbers the actions map (AG-2 onward; reads map 15281 to `AGENT_DISABLED` instead):

| Number | Code | Meaning |
| --- | --- | --- |
| `14261` | `NAME_IN_USE` | The name is already in use (a job, or a step within its job). |
| `14262` | `NOT_FOUND` | An id or name does not exist (a job, or a step's database). |
| `14234` | `SQL_ERROR` | An argument is not valid (such as an owner login that does not exist). |
| `14266` | `SQL_ERROR` | An argument is not one of its valid values (such as a schedule's frequency type). |
| `14372` | `IN_USE` | A schedule is still used by a job. |
| `14525` | `PERMISSION_DENIED` | Only sysadmin may change a job another login owns (the job document Save). |
| `14392` | `PERMISSION_DENIED` | Only sysadmin and SQLAgentOperatorRole may purge the history of every job, or of a job the login does not own. |
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
| `jobAlerts` | 32 | Alerts one job save may detach (the job document's Alerts section) |
| `descriptionChars` | 512 | Characters of a job's description (`sysjobs.description`) |
| `ownerLogins` | 1,000 | Logins the job document's owner picker lists (sysadmin; the owner can still be typed) |
| `scheduleJobChanges` | 64 | Jobs one schedule save may attach or detach |
| `lastRunRows` | 202 | History rows Job Activity Monitor's last run reads, newest first, before it cancels the rest |
| `startJobs` | 100 | Jobs one Start, Stop, Enable or Disable from Job Activity Monitor may name |
| `watchedJobs` | 3 | Jobs the status bar follows with live progress |
| `serviceStatementMs` | 30,000 | One service Start or Stop statement, in ms |
| `serviceWaitMs` | 60,000 | How long a Start or Stop waits for the service's new state, in ms |
| `serviceReadMs` | 10,000 | One service state read, in ms |
| `servicePollMs` | 500 | How often a Start or Stop's wait polls the service's state, in ms |
| `agentUpWaitMs` | 120,000 | How long the live checks wait for Agent after the server is up, in ms |
| `profileMs` | 10,000 | The budget of `agent.profile` once it has its Object Explorer slot, in ms (a TIMEOUT value past it, unless msdb already refused the login: then the profile with no role) |
| `historyMaxRows` | 999,999 | The largest Maximum job history log size SQL Server Agent Properties sends, in rows (rows per job are 1 to it) |
| `retentionDays` | 7 | The days of history "What this keeps" measures each job's rate over |
| `retentionJobs` | 200 | Jobs "What this keeps" lists, those with the most rows first; more set `truncated` |
| `historyAgeDays` | 400 | Whole days of age the purge's row estimate counts separately (older rows count together) |
| `proxySubsystems` | 32 | Subsystems one proxy save may grant or revoke (AG-8b) |
| `proxyPrincipals` | 64 | Principals one proxy save may grant or revoke, and the most a proxy's Principals list shows |
| `principalChoices` | 1,000 | Logins, msdb roles and server roles the proxy document's principal picker lists (a name can still be typed) |
| `proxyReferences` | 500 | Job steps a proxy's References and a credential's Used by list; more set `truncated` |
| `credentials` | 1,000 | Credentials the proxy document's credential picker lists; more set `truncated` |
| `credentialProxies` | 100 | Proxies a credential's Used by lists |
| `credentialIdentityChars` | 128 | Characters of a credential's identity (CREATE and ALTER CREDENTIAL refuse more, error 15540) |
| `credentialSecretChars` | 4,000 | UTF-16 code units of a credential's secret (its own bound: a credential secret is not a login password) |
| `cryptographicProviders` | 64 | Cryptographic providers New Credential lists (`sys.cryptographic_providers`) |
| `purgeCount` | 999 | The most days, weeks or months "Delete old history now" goes back (999 months stays inside `datetime`) |

A job save makes at most 204 calls at these caps, below the 255 a THROW state can number.
