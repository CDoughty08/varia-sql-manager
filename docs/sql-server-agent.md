# SQL Server Agent

SQL Server Agent ships in 0.10.0 ([docs/agent-plan.md](agent-plan.md), UI in
[docs/agent-ui-rethink.md](agent-ui-rethink.md)), on for every SQL Server connection to a server that runs Agent, with no setting or environment variable
(Express, Azure SQL Database and BigQuery connections have no Agent node). Object Explorer shows the SQL Server Agent node, a job's New Job…, View History,
Start Job at Step…, Stop Job, Enable, Disable, Rename, Delete and Properties, and the Agent node's Start, Stop, Restart and
Properties; Search Objects finds jobs, alerts and operators, Script As scripts jobs, alerts, operators and proxies, Job
Activity Monitor follows the jobs live, the Log File Viewer reads and deletes job history and reads Agent's error logs, the
job document edits a job's General, Steps, Schedules, Notifications, Targets and Alerts or creates a job and shows its
History live, the Schedules document manages the shared schedules, the alert and operator documents and the Operators and
notifications grid edit and create alerts, operators and who is notified, and the proxy and credential documents edit and
create proxies and credentials. Help › Getting Started has a guide, Schedule work with SQL Server Agent, with a fictional
schedule sample. Parity with SSMS 2022 is recorded below (Parity with SSMS).

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
- **No release gate.** Until 0.10.0 Agent's surfaces were behind a release gate (`VARIA_AGENT_PREVIEW=1`, the context key
  `agentEnabled`); AG-9 removed it, so the node, commands, menus, documents, Search Objects' Agent kinds, the node's status
  probe and hot exit's Agent records need nothing to turn them on. `tests/agent-profile.test.ts` fails if the variable, the
  key or the renderer argument comes back anywhere in the code, scripts or CI.
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
- **Object Explorer follows Agent live** (`agent.tree`, `agent.jobs`, docs/live.md). While a Jobs folder is expanded and
  shown, its job rows carry state chips from Job Activity Monitor's own `agent.jobs.list` and `agent.jobs.service` probes,
  in one background view per connection: **Running · step n/m** (Executing, Waiting for worker thread, Performing
  completion actions), **Between retries** or **Suspended**, otherwise **Failed** when the last run failed; a job the list
  reads as disabled is dimmed with ", disabled" (and one it reads as enabled is not), unless the row was listed after that
  read, as a Disable or Enable lists it again at once; the job's menu offers Enable Job or Disable Job by the same state. The chip's words join the row's accessible name and tooltip. Collapsing or
  hiding the folder ends the view; with Agent stopped or Agent XPs off (the list then stops on `AGENT_DISABLED`)
  the last read's **Failed** chips and disabled jobs stay, and Running and the retry states go, as they would be out of date. While the Agent node
  is expanded and shown, the `agent.tree` source reads Agent XPs and the service state (explorer.agentService's text) and,
  for each of `sysjobs_view`, `sysalerts`, `sysoperators`, `sysproxies` and `sysproxysubsystem`, a row count and a checksum
  of the columns the tree shows, each table only where `HAS_PERMS_BY_NAME` lets the login read it. When Agent XPs or the
  service state changes, the Agent node is listed again; when a table's fingerprint moves (a job, alert, operator or proxy
  created, renamed, enabled, disabled or deleted elsewhere), only its folders are, keeping expansion and selection, so
  Refresh is not needed. A failing sample is retried as every live probe's is (docs/live.md); a view that ends opens again after a back-off
  from 2 s to a minute, unless it ended on a permission, sign-in or unsupported-server failure, which waits for Refresh. Both follow `liveData.explorerStatus` and pause with Object Explorer.
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
  Linux server, Managed Instance, a failover cluster instance, which the node's `explorer.agentService` probe reads from
  `SERVERPROPERTY('IsClustered')`, a start, stop or restart of it already running in this window, the service changing
  state), and the backend refuses them
  `NOT_SUPPORTED`. A start, stop or restart takes the long gate, so one runs per connection. The state shown elsewhere
  stays SQL's (`xp_servicecontrol N'QueryState'`); `xp_servicecontrol` never starts or stops anything.
- **Job Activity Monitor** (`agent.jobs`, docs/live.md). The Agent node's menu (first after New), Enter or double-click on its
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
  refuses sees "No access to SQL Server Agent" with the roles that grant it; Change owner… and Attach schedule… (AG-3b)
  open a form below the bulk bar for the jobs selected then. Change owner reads New Job's describe for the logins (a login
  that is not sysadmin is told msdb lets only sysadmin change an owner, and Change stays off) and sends one `changeJobOwner`
  per job: AG-2's identity guard, then `sp_update_job @owner_login_name` as a parameter (`AgentSql.ChangeOwner`, under the
  write lint); a job the list already shows with that owner gets "Already owned by …" and no request. Attach schedule reads
  the Schedules describe and picks a shared schedule as the job document's Schedules section does (search by name or by
  when, its sentence, owner and next five runs), then sends one `agentSchedule` update per job with the schedule's guard
  and that job's `version_number` guard and the one job attach (AG-6c's save; `sp_attach_schedule` leaves the schedule's
  version and date as they are, so every job's request passes the same guard); a job sysadmin's links show already on the
  schedule gets "Already uses this schedule" and no request, and one the read did not list fails its line unsent. Each
  result is its own line, a refusal fails only that job, and Stop and Escape (which closes a form) work as for Start; Agent stopped or Agent XPs off is a banner,
  a note below the list says Status is msdb's last reading, and the list refreshes once Agent runs again. The Agent-stopped
  banner has **Start Agent…**, which runs the Agent node's Start (`explorer.startAgent`, with its confirmation and rules: greyed
  with the reason where the node's would be, or while a dialog is open; the monitor's own `agent.jobs.service` reading, which
  carries the cluster fact too, stands in for one the tree has not sampled). Double-click, Enter or Open on the selected job
  opens its job document, and F5 in it refreshes the list (Refresh Jobs). View › Job Activity Monitor opens it too, on the active
  tab's server or Object Explorer's selected one, else asking which server when more than one is connected. The list's row menu (right-click, Shift+F10 or the context-menu
  key; `agent.jobs.context` through MenuService) acts on the selected jobs: Open, Create Job Like This and Script Job as CREATE
  (a new query window, through Object Explorer's Script As) on one job, Start Job, Stop Job, Enable Job and Disable Job as the
  bar runs them, View History, and Refresh. The row menu replaces Query Output's, but the grid keeps Query Output's keys
  (Ctrl+C, Ctrl+Shift+C, Ctrl+A, Ctrl+S, and Alt+Down for a column's filter).
- **Activity Monitor job links** (docs/activity-monitor.md › SQL Server Agent jobs). A session running a job step shows the
  job and step in the Activity Monitor's Agent Job column, a link to the job document at History; Open Job and Stop Job are on
  the session's menu.
- **Job document** (`agentJob`, object actions, docs/object-actions.md). One tab per job ("Job Properties - Nightly"), opened
  from a job's node (Enter, double-click or Properties), from Job Activity Monitor, from Ctrl+Q's object search and from the
  palette's SQL Server Agent: Open Job… (the job selected in Job Activity Monitor or Object Explorer, else a pick of the
  server's jobs). The header shows the job's live state from `agent.jobs.watched` (running and its step, or idle with the last
  outcome), Start with a step menu (Start once at step, which leaves the job's start step alone), Stop while it runs, Reload
  and Save. Sections: **General** (name, owner, category, description, enabled; only sysadmin changes the owner),
  **Notifications** (e-mail, page, net send, Windows event log and delete, each a level and an operator; whether Database Mail
  can send, read through `sysmail_help_profile_sp` where the login may, and an operator's missing address or pager duty hours
  as warnings), **Targets** (this server only; multi-server targets come later) and **Alerts** (the alerts that run the job;
  Remove for sysadmin only, since msdb grants `sp_update_alert` to no Agent role; New alert for this job… opens New Alert with the job as its response).
  **Steps** is a master/detail page: the list shows each step's number, type and where it goes on success and on failure, marks
  the Start step, and reorders by drag, Move up and Move down, or Alt+Up and Alt+Down (Move Step Up and Move Step Down, in the
  Steps section but not in a field or the step's command editor, where the keys open a list or move lines); moving the step shown
  keeps it shown. Go-to targets follow the step they name, since the draft keys
  steps rather than numbering them. Delete acts at once and its banner names the steps that went to the deleted one and now quit
  reporting failure (as SSMS does), with Undo putting all of it back. The editor shows the step's name and type, then the
  type's fields: T-SQL in a Monaco editor that completes against the step's database, with **Parse** (`language.parse`,
  ScriptDom's parser in the backend on a large-stack thread, nothing runs; text nested more than 128 parentheses deep is
  reported too deep to parse) and **Open in query window** (a new query tab on the job's connection and the
  step's database); PowerShell and CmdExec in their own editors, with Run as (the SQL Server Agent service account or a
  proxy granted to the step's type, `sp_help_proxy @subsystem_name`) and CmdExec's success exit code, and **Load from file…**
  (SSMS's Open…, AG-11): main shows its own open dialog filtered to the type's scripts (`.ps1`, `.psm1`, `.psd1`; `.bat`, `.cmd`)
  plus All files, reads the chosen file with Open's encoding detection (a byte order mark, UTF-8, BOM-less UTF-16, else the
  system's ANSI code page) up to one step's 100,000 characters, and returns only its text, never its path
  (`openAgentStepScript`, the page names only the step type); the text replaces the command, with CRLF line endings if the file has any (LF otherwise), as one edit Undo takes back, and a
  refused file (too long, holding NUL bytes, a folder) says why under the command; SSIS on one scroll, with
  the package picked inline from SSISDB's folders, projects and packages (or SQL Server and file system sources), its
  parameters, environment, 32-bit runtime and logging; Analysis Services Command and Query with the Server they run on. On success and On failure choose next step, quit with success, quit
  with failure or go to a named step; More options (retries, output file and its append, log to table, history output)
  stays folded with a one-line summary. Problems block only what msdb refuses (a missing name, a go-to past the
  last step, a proxy not granted to the type) and warn on the rest. The describe reads at most 50 steps and each command up to
  100,000 characters (1,000,000 for all of them): a longer job lists its first 50 steps read-only, and a cut command only warns
  until the steps are part of a save, which it then blocks, so Varia never writes a cut command or a renumbering it could not see.
  Reload and keep my changes matches steps by name: steps you did not touch take the job's version now (another session's renames,
  deletes, inserts and Start step stand), your edits land on the step you edited at its current number, and the compare's Steps row
  says what each side added, deleted, edited or reordered.
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
  start panel: Blank job, or Copy an existing job, which opens Create Job Like This on the job picked (below);
  nothing is created until Create, which runs `sp_add_job` and `sp_add_jobserver` in one transaction.
  **Create Job Like This…** (AG-6e; a job's menu after New Job…, Job Activity Monitor's bar for the one job selected, the palette, which
  copies the active job document or asks for a job, and New Job's Copy an existing job) opens New Job filled from the job's describe
  ("Copy of …"): General, Notifications and every step with its flow, retries, output and logging, each step new to msdb (its
  `sp_add_jobstep`). It is saved disabled unless Enable when saved is ticked, owned by the login (sysadmin keeps the source's owner and
  may change it), and each schedule is shared (`sp_attach_schedule` under its version guard) by default, or copied as a new schedule
  (`sp_add_jobschedule`, named "… (copy)"), or left out; a schedule whose version could not be read can only be copied. History and the
  alerts that run the source are not copied: an alert runs one job. A **Changes from source** section leads the document: Replace
  across the copy (one find and replace over the job's and steps' names, step commands, which hold SSIS package paths, output file
  paths and copied schedules' names, never a shared schedule's; a preview lists each match, ticked until unticked, and an edit since
  the preview asks for a new one), Name, Owner and Enable when saved, each step's key fields (a T-SQL step's database and command, an
  SSIS step's package and environment, any other type's command) with Edit command and Change package going to Steps, and an SSIS
  step whose package differs from the source's reads that package so its required parameters without a value show with Set it now;
  each schedule's Share, Copy or Leave out; then what else is copied and what is not. Fields that differ from the source are marked
  Changed, and **Compare with source** in the banner lists every difference (the job's fields, each step added, removed, moved or
  edited, and each schedule copied, left out or new). The copy saves through New Job's own save; no backend write was added. A source
  with more steps than Varia reads (`stepsPerJob`) cannot be copied from here (Script Job As › CREATE copies it whole). The save batches have
  their own exact-shape lint, `AgentSql.LintJobSave`. **Steps** save inside the same transaction after the job and its
  alerts, in the planner's order (`planAgentSteps`, `src/shared/agent/steps.ts`): deleted steps highest id first, every
  surviving step renamed to a temporary `__varia_step_<32 hex>` name at its id (with neutral T-SQL content, since
  `sp_update_jobstep` re-checks every argument it is not given against the stored step), new steps inserted at their final ids under
  temporary names, then each step's whole content written into its final id (`sp_update_jobstep` with every argument), and
  `sp_update_job @start_step_id` last when the Start step moved. Writing whole contents by id means a swap or rotation never
  depends on msdb's renumbering of go-tos, and the temporary names keep `sp_verify_jobstep`'s unique-name check (14261) from
  refusing a step that takes another's old name. New Job's steps are its `sp_add_jobstep` calls between `sp_add_job` and
  `sp_add_jobserver`. A refused step call lands on Steps ("Saving step 2 was refused"). The Schedules section's calls follow the steps (below).
  Pager duty is not yet checked against the job's schedules.
  **Create several…** (AG-6f; mocks `rx-create-several`, `rx-create-several-review`) on Changes from source turns the copy into a table in
  the same tab ("Create several jobs"), one row per new job; the copy as it stands is the template. An empty cell uses the template's value
  (grey); a typed one overrides that field for that row only (accent edge); clearing it goes back to the template's. Columns opens with Name,
  each step's key fields but its command, each schedule's Share, Copy or Leave out, and Enabled, and offers every other field: Owner
  (sysadmin only), Category, Description, the e-mail and pager operators and levels, the event log and delete levels, and each step's
  name, command, retries, retry minutes, output file and Run as. A row copying a schedule names it after the row's job ("Job – Schedule")
  unless it was renamed. Fill: Add row, Duplicate row, Paste rows (tab-separated lines, one cell per visible column, also when pasted into
  a cell; at most 100 rows) and Fill names (`{n}`, `{package}`, `{database}`, `{source}`). The selected row's details list every field it
  differs in from the template, with Reset for those not in a visible column; **Open full editor** opens the row as an unsaved job tab
  ("Row n · name") with every section, whose edits go straight back to the row as its whole draft (shown as Other changes), and Back to
  the table closes it; Save and Reload are off there, it is read-only while the table shows its review or results, and a row removed or created meanwhile leaves the editor a copy of its own. Checks
  run before anything is sent: a duplicate name among the rows, a name msdb already lists, a cell that cannot be used and every error New
  Job's save refuses block a row; warnings (a required SSIS parameter without a value, an operator not notified) only show. **Review and
  create** lists what each row sends and the rows it skips; Create sends each row as its own `agentJob` save (New Job's one transaction),
  one after another, each with its own result: created rows lock with Open, a failed row says msdb's error and was rolled back, and a
  lost connection marks the row on its way unknown and sends no more. Back to the table keeps the rows not created to fix and retry;
  **Enable the created jobs** reads the job list once for their ids, then enables each (AG-2's `enable`) with its own result. No new
  RPC or backend write.
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
  (below sysadmin) is read-only with Copy, and one msdb hides from the login (another login's, below SQLAgentReaderRole) can be neither removed nor copied, since `sp_detach_schedule` could not find it. **Add** searches the shared schedules the login can see (any owner's: msdb's `sp_attach_schedule` asks only for the job's owner) by name or by when they run ("night", "every
  15 minutes", "sunday"); a match shows a preview (sentence, owner, next runs, the jobs that use it) with Attach, and New
  schedule starts from SSMS's defaults, named from the search. **Remove** marks the job's schedule removed with Undo and a
  choice: detach it and keep the schedule, or (its owner and sysadmin) detach it and delete it when no job uses it. Nothing
  reaches the server until the job's Save, which runs the schedule calls last in the job's transaction in a fixed order:
  `sp_detach_schedule` (with `@delete_unused_schedule` for delete, so msdb deletes only an unused schedule, jobs the login cannot
  see included, and never fails the save over it), a guarded `sp_attach_schedule` for each picked one, a guarded
  `sp_update_schedule` for each edited one (after the attach, which leaves the schedule's version as it is, so a picked schedule
  edited in the same save passes both guards), and `sp_add_jobschedule` for each new one. Each guard compares the schedule's
  `version_number` and `date_modified` (`sysschedules_localserver_view`, `UPDLOCK, HOLDLOCK`) and THROWs 50011 with the call's
  index, so a schedule changed since it was read is `STALE` on the Schedules field and nothing commits. A new job has nothing to
  compare: its attached schedules are read again and take the new versions, keeping your edits, and the next Save names them.
- **History** (AG-6d; `src/shared/agent/job-history.ts` for the rules, `JobHistoryService` and `JobHistory.tsx` in the renderer). The job
  document's last section shows the job's own runs in place, as SSMS's View History shows them in the Log File Viewer: a bar per run for the
  newest 14 finished runs with the job's **usual** time as a line ("usual 18 min": the median of its newest 10 succeeded runs, whatever
  the filter), the runs newest first with All and Failed, and beside them the selected run (the newest until another is picked): its
  start in server time, its duration against the usual one, who invoked it and its outcome (both from msdb's job outcome message),
  and its steps with outcome, duration and retries. The run's last failed step opens with its whole message (agent.historyMessage
  where the grid's copy was cut), with Copy, **Edit step** (the step of that name as the job is now) and **Start at step**. A step
  whose message names an SSIS Catalog execution ("Execution ID: 48213", which a failed catalog step writes) has an **SSIS execution**
  link that opens that run's page in the server's Integration Services document ([Integration Services](integration-services.md#the-integration-services-document)):
  where it failed, its task timeline and its catalog messages, where the real error usually is. While the job runs, the section starts with the run view: the elapsed time from the run's start and the server's clock
  (the header's `agent.jobs.watched` probe; no elapsed time where the start is unreadable, never a guess) against the usual time as a
  bar, each step's state (finished steps as their rows say, the step Agent reports as current Executing or Between retries, the rest
  Waiting; with this run not selected under All, or its rows not read yet, the others show — rather than a guess) with this run's and
  the usual time, and Stop. A step or the run ending reads History again at once while it shows. Saved edits apply from the next run, which the run view says. The section
  is one `agent.history` view (one checked job, `usual: true`, so the probe adds a fourth table of the usual durations for the job
  and each step, a step's rows in a run added up) opened when the section first shows (on its connection's return when it shows
  disconnected); it runs while the document is the active one with History open, pauses while the document is hidden or the section
  collapsed, and runs nothing between samples: the backend schedules every read. The watched clock redraws the document only while
  History shows. A New Job has no History until it is
  saved. All jobs' history in Log File Viewer opens the viewer with this job checked. The sparkline draws through ChartView like
  every chart: a ring of the last 14 finished runs, evenly spaced oldest first (runs, not samples over time), their durations over
  a faint fill and the usual time as a gray line. It is one image whose name (also its tooltip) says how many runs failed and the
  usual time, since status colours are never a series; a sparkline has no crosshair, so each run's start, outcome and duration
  are read in the runs list beside it.
- **Schedules document** (Manage Schedules on the Jobs folder's menu and the palette; New › Schedule… on the Agent node). One
  document per connection replaces SSMS's Manage Schedules dialog: a grid of the shared schedules (name, when, Enabled, how many
  jobs, owner) with All, Unused and Disabled views and a filter that matches schedule names, job names (sysadmin, whose read has the links) and when schedules run, and
  beside it the selected schedule's editor (the same one as the job document's), the jobs that use it with Detach and Attach a
  job (only jobs the login owns, or any for sysadmin, as msdb allows, on any schedule the login can see; another login's schedule takes only these job changes), and Save. Edits are kept per schedule until saved, each guarded by the schedule as its edit began, so neither Refresh nor
  the read after another save lets it pass over someone else's change; a STALE save reads again and shows their change with the
  user's on top, for the user to save again. Closing the tab with unsaved ones asks Save / Don't Save; Save (and File › Save) saves each changed schedule in turn and stops at the first refused. Only a save under way stops the close. The grid's **Enabled** box saves at once. Below sysadmin it is
  offered on a schedule another login owns only to a member of msdb's SQLAgentOperatorRole (read once through `agent.profile`),
  whose `enable` and `disable` send `sp_update_schedule` only the schedule and `@enabled`, as msdb allows that role; the
  schedule's other settings stay read-only to it. New schedule and Duplicate edit a draft that
  Create adds; Delete asks inline and never forces, so msdb refuses one a job uses (`IN_USE`, 14372), saying how many jobs.
  Every change is the `agentSchedule` object action on the Agent node with `op` `create` (`sp_add_schedule` with the new id as
  an OUTPUT local, then guarded `sp_attach_schedule`s), `update` (the guard, `sp_update_schedule` with what changed, then guarded
  attaches and `sp_detach_schedule`s), `enable`, `disable` or `delete` (`sp_delete_schedule` without `@force_delete`), one
  transaction each with the guard above and each job's `version_number` checked before it is attached or detached. Below
  sysadmin, `sysjobschedules` is closed, so a schedule's jobs are read when it is selected (`sp_help_jobs_in_schedule`, which
  shows SQLAgentUserRole only its own jobs) and Unused counts every job, the unseen included. The saves have their own
  exact-shape lint, `AgentSql.LintScheduleSave`, which also refuses `@force_delete`.
- **When schedules run.** The next runs, the free-slot check and the Timeline follow SQL Server Agent's own rules, checked shape by
  shape against the next run Agent writes (`tests/agent-schedule-live.test.ts`): a daily schedule's every-N days and a relative
  monthly one's every-N months count from its start date; a weekly or monthly every-N cycle counts from its first run on or after
  now (or the start date) when the schedule is saved or attached, and from Agent's own runs after that. So wherever the read has
  sysadmin's links, the editor, the free-slot check and the Timeline count a saved, unchanged, already attached schedule from Agent's
  next run: the job's `sysjobactivity.next_scheduled_run_date` (rewritten as soon as a schedule changes) when it is a run of that
  schedule on the cycle of the pair value below, or of a save less than 30 minutes old (it is the job's earliest run across its
  schedules, so another schedule's run in this one's off week does not count), else `sysjobschedules.next_run_date` (rewritten every 20 minutes) if it is a run of the timing as read and the schedule was
  saved at least 30 minutes earlier, else the schedule's last save (`date_modified`), where Agent restarted the cycle; for the
  schedule itself, the cycle every job using it keeps, or none when they differ (jobs attached in different weeks). The
  Pick preview, Attach schedule, an edited timing and below sysadmin count from now. A repeating daily window that crosses
  midnight (22:00 to 04:00) runs on past midnight after a run day, stepping on from its start time, but not past the end date,
  while a weekly, monthly or relative one stops at midnight, which the editor says. Weeks start on Sunday. Agent passes over a run
  less than about a minute after it computes. Not followed: a relative schedule with a future start date whose start month's
  occurrence falls before that date, for which Agent writes no next run at all, and a job attached to a saved schedule less than
  30 minutes ago whose job-wide next run is another schedule's, which counts from the schedule's save rather than its attach.
- **Schedules Timeline** (the Schedules document's Timeline view, `src/shared/agent/timeline.ts`, `TimelineView.ts`). A Gantt
  chart from now over the next 24 hours or 7 days: for sysadmin one row per job, from the links and each job's usual duration
  (a job without one drawn for a minute), below sysadmin one row per schedule some job uses; rows in the order they next run, disabled jobs
  and schedules dashed. Runs of two jobs that meet are flagged and listed under the chart as "Overlap 02:30–02:48: Backup
  starts once during Nightly." with Open on the schedule (at most 20, the rest counted), and a job whose usual run outlasts the
  gap to its next start is called out, as Agent skips a start while the job runs. Zoom in and out (Ctrl+wheel, + and -), scroll
  (the slider, Shift+wheel), Show all; hovering a run shows its times, schedule and usual run; clicking it or Enter opens the
  job, Shift+click or Shift+Enter its schedule. The chart is a grid: Up and Down move between rows, Left, Right, Home and End
  between runs, each announced. It draws at most 200 rows and 40,000 runs, shared evenly over the rows (at most 2,000 a row),
  stops checking overlaps after two million row checks, and says each cut; runs closer than two pixels draw as one bar. The filter applies to it; All, Unused and Disabled do not.
- **Alerts and operators** (`actions` dialogs `agentAlert`, `agentOperator`, `agentOperators`; `src/renderer/src/agent/`). An alert or
  operator opens in its own tab from its node (Enter, double-click or Properties) or the palette's Open Alert… and Open Operator…;
  the Agent node's New › Alert… and Operator…, the Alerts and Operators folders' New, and the palette open New Alert and New Operator,
  which create nothing until Create. The **alert document** is one screen: **When** (a SQL Server event: an error number or a
  severity, a database and a "Message contains" text; or a performance condition: object, counter, instance, comparison and value,
  with the counter's current values read through `agent.counterValues`; msdb wants a value that starts with a digit, and an instance for a counter that has them), **Then** (a job to run, and the operators to notify as chips
  with E-mail, Pager and Net send toggles, an "Add an operator" pick and an inline New operator created in the same save) and
  **Options** (the delay between responses, the error text in e-mail, pager or net send, an additional message). The header shows
  the history: when it last fired and how often. A WMI alert's When is read-only; its Then and Options can change. The **operator document** has General (name, enabled,
  e-mail, pager and net send addresses, Send test e-mail), Pager duty (the days and each day kind's hours) and Notifications (the
  alerts that notify it, each a method toggle, and the jobs that notify it, read-only). Save sends only what changed as one batch
  in one transaction (`AgentSql.ObjectBatch`): an existing object's opens with its identity guard (name and id; 50010 `NOT_FOUND`
  when the object was replaced), every call checks its return code, and a refusal names the call that failed with the document's
  edits kept. The Script drawer shows the same calls with literal values. **Operators and Notifications…** (the Alerts and Operators folders'
  menus or the palette) opens the grid (read-only past the notifications it reads at once): one row per alert, one column per operator, each cell cycling none, E-mail, E-mail and Pager,
  Pager; Save sends one `agentAlert` save per changed alert, in turn, and says how many saved if one is refused. Its side pane opens
  the selected operator, sends a test e-mail or deletes it (not while the grid is read-only, when it cannot count what notifies the operator), and a table below the grid lists the jobs that notify operators. **Add recommended alerts…**
  creates any of severity 17 and 19 to 25 and errors 823 to 825 the server has no alert for (any name), each with an operator if
  one is picked. **Send test e-mail** runs `sp_notify_operator` through Agent's own Database Mail profile, refused before anything
  is sent when Agent has none, the operator is disabled or Database Mail XPs is off; the Agent mail check (Database Mail XPs, a profile, Agent using it) shows on the operator document
  and among the alert's warnings. **Delete** on an operator that alerts or jobs notify offers Reassign to (`sp_delete_operator
  @reassign_to_operator`); Enable, Disable, Rename and Delete on alert and operator rows go through the same batches. Alerts are
  SQL Server on Windows only (NOT_SUPPORTED on Linux and Managed Instance), and only sysadmin writes alerts and operators: msdb
  refuses the other roles, so the documents open read-only for them. The tree's verbs are not greyed by role yet.
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
  Monitor's.
- **Agent error logs** (`agent.errorLog`, `agent.errorLogs`). For sysadmin, Select logs lists SQL Server Agent's error logs
  under the jobs ("Current - date", "Archive #1 - date", the date in one format with Object Explorer's Error Logs labels, both
  parsed by `ErrorLogTime` from `xp_enumerrorlogs`' text; `xp_enumerrorlogs 2`, archive order, Current alone where the server
  lists none, as on Linux). View Agent Log on the Error Logs folder (Current) or a log opens the server's viewer with that log
  checked and no job. The checked logs' rows show in their own grid (Agent log: date, log, type, message), newest first across
  logs, with the window and Message contains filters shared with the runs: the window reads the server's clock, and the text is
  `xp_readerrorlog`'s search argument (`sp_readmierrorlog` on Managed Instance, which reads oldest first, so its truncation note
  says the oldest rows were kept). A read holds at most `logRows` rows; the selected row's whole message shows in **Log row
  details** with Copy. The rows are a separate grid from the runs rather than the same one because their columns differ (no
  duration, steps or outcome); with logs checked and no job, only the log grid shows. **Recycle…** (the viewer's header, the
  Error Logs folder or a log, or the palette) runs `msdb.dbo.sp_cycle_agent_errorlog` after a destructive confirmation whose
  Cancel takes focus, so Enter recycles nothing. It is the `recycleAgentErrorLog` object action (target the Agent node, one
  exact-shape batch, `AgentSql.LintRecycle`), sysadmin only and not offered on Managed Instance; Agent stopped or Agent XPs off
  is `AGENT_STOPPED`. Afterwards the viewer reads the logs again and Object Explorer reloads the Error Logs folder.
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

## Parity with SSMS

Re-checked for 0.10.0 (AG-9) against SSMS 2022's SQL Server Agent surfaces: its Object Explorer nodes and context menus,
Job Activity Monitor, the Log File Viewer and the Job, Job Step, Job Schedule, Alert, Operator, Proxy Account, Credential
and SQL Server Agent Properties dialogs. SSMS's names, order and mnemonics are kept wherever Varia has the verb; Varia's
rethink (docs/agent-ui-rethink.md) deliberately turns the dialogs into document tabs. Gaps go to a lane of
docs/agent-plan.md (AG-10 to AG-16) or to its Later row.

**Matches SSMS**

| Surface | SSMS 2022 | Varia |
| --- | --- | --- |
| Agent node | After the server's folders; children Jobs, Job Activity Monitor, Alerts, Operators, Proxies, Error Logs | Same order and names; which children show follows the login's Agent role, as SSMS's do; Managed Instance has no Alerts or Proxies, as in SSMS |
| Agent node menu | New › Job…, Alert…, Operator…, Proxy…, Schedule…; Start, Stop, Restart; View History; Properties | Same items, grouped differently (Job Activity Monitor and View History after New, then Start, Stop and Restart); Start, Stop and Restart through the Service Control Manager as the Windows user, as SSMS |
| Jobs folder menu | New Job…, Manage Schedules, View History | Same (Manage Schedules opens the Schedules document) |
| Job menu | New Job…, Script Job as, Start Job at Step…, Stop Job, Enable/Disable, View History, Rename, Delete, Properties | Same names, grouped as Varia's menus are: New Job… and Create Job Like This…, View History, Start Job at Step… and Stop Job, Script Job as, Enable/Disable, Rename and Delete, Properties |
| Job Activity Monitor node | Double-click or View Job Activity opens it | Double-click, Enter or Job Activity Monitor opens it, one per server |
| Alerts, Operators, Proxies menus | New Alert… / New Operator… / New Proxy…; Script … as; Enable/Disable (alerts); Rename; Delete; Properties | Same; Proxies list one folder per subsystem, then Unassigned Proxies, as SSMS |
| Error Logs menu | View Agent Log, Recycle | Same (Recycle asks first; not on Managed Instance) |
| Log File Viewer | Select logs, runs with their steps, message details, Delete history | Same layout (master/detail), with Agent's error logs in the same viewer |
| Job dialog pages | General, Steps, Schedules, Alerts, Notifications, Targets | Same sections, plus History (rethink); Targets shows the local server only |
| Job Step dialog | General (name, type, Run as, database, command, Parse, Open), Advanced (on success, on failure, retries, output file, log to table) | Same fields on the Steps page beside the list, with Open as Load from file… on PowerShell and CmdExec steps; Advanced is the folded More options |
| Job Schedule dialog | Schedule type, frequency, daily frequency, duration, summary sentence | Same fields and SSMS's sentence, plus presets and the next runs (rethink) |
| Alert dialog | General (event, performance condition, WMI), Response (job, operators), Options | One screen with When / Then / Options; WMI alerts read-only (editing is Later) |
| Operator dialog | General (e-mail, pager, on-duty schedule), Notifications, History | General, Pager duty and Notifications, plus Send test e-mail and the Operators and Notifications grid; the History page (last notification attempts) is Later |
| Proxy Account dialog | General (credential, subsystems), Principals, References | One screen with the inline credential; References as Used by on the credential |
| SQL Server Agent Properties | General, Advanced, Alert System, Job System, Connection, History | General and History (a dialog, as SSMS); the rest are Later |
| Keys | No default Agent keys; Enter opens, Delete deletes, F2 renames in Object Explorer; F5 refreshes | Same in Object Explorer; F5 refreshes Job Activity Monitor, and Alt+Up and Alt+Down move a job's steps |

**Deliberate differences (the rethink)**

- Jobs, alerts, operators, proxies, credentials and the shared schedules are document tabs, not modal dialogs: several stay
  open, unsaved ones survive a restart (hot exit and AutoRecover), and Save writes one transaction that refuses to overwrite
  another session's change (STALE, with a field-by-field compare).
- Creation happens in place (a new schedule, operator or credential inside the job, alert or proxy that needs it) instead of
  stacked child dialogs.
- Job Activity Monitor is a live document with tiles, view chips and a last-run panel; SSMS's Filter dialog is the filter
  box and column filters, and its bulk verbs give one result line per job.
- New Job adds Create Job Like This and Create several; the job document adds History in place and the live run view.
- Manage Schedules is the Schedules document (a grid with the selected schedule's editor) instead of a dialog.
- Start, Stop and Restart run only from a Windows client against a Windows server that is not Managed Instance or a cluster,
  and show the state elsewhere, because they need the Service Control Manager.

**Gaps**

| Gap | Where it goes |
| --- | --- |
| Job-state chips on job nodes, and reloading the Agent node when Agent XPs flips | AG-12 |
| An SSIS execution messages view for the job history's SSIS link (a query window today) | AG-13 |
| Schedules timeline; schedule occurrences across midnight and for every N months; an Agent live suite for schedules | AG-14 |
| Agent overview health checks | AG-15 |
| Activity Monitor sessions that link to the job they run | AG-16 |
| Manage Job Categories; multi-server targets (MSX/TSX); Script Action to Job; output file and table log viewers; SQL Server Logs and Database Mail in the Log File Viewer; Agent Properties' Advanced, Alert System, Job System and Connection pages and the fail-safe operator; the operator's History page; Error Logs' Configure; WMI alert editing; Copy to another server; New Job templates; Flow view; Elastic Jobs | Later |
| SSMS's Start PowerShell, Reports and Policies items on Agent nodes | Not planned (Varia has none of them on any node) |

AG-4's Script As output still waits for SSMS goldens from an SSMS run (the owner's); it is compared with SMO's own
`Job.Script` until then.

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
a view chip, Start on two jobs with the status bar following them, the Last run chevron, Change owner on two jobs (and
Escape closing its form), Attach schedule on three jobs with one already on the schedule, and reopening it from its node.
`tests/agent-job-bulk.test.ts` covers the two forms' requests, the skipped and unsent jobs, a refusal failing one line, a
login below sysadmin and a read that fails or answers after its form closed; `AgentActionChecks.ChangeOwner` covers the
backend's validation and write.

`AgentJobDocumentChecks` checks the job document's planner offline: the save lint and its near misses, each save's batch, the
validation, the error mapping onto fields and the script's shape, and the steps' planner shapes (renumbered, New Job's, the
Start step alone), their lint near misses and validation, and `language.parse`'s bounds. In the Agent live suite, `AgentJobDocumentLiveChecks`
describes the scratch job, saves it under the STALE guard and is refused STALE on an older version, fails a later call and
checks nothing committed, renames it to a hostile name and back, runs the script back against msdb, detaches a scratch alert
(Windows), and after the job verbs delete the job creates it again through New Job, then adds two steps, swaps them and
deletes one, reading `sysjobsteps` back after each save. The `agent-job` smoke suite opens jobs from
Job Activity Monitor (double-click and Enter), saves an edit and a removed alert, loses a save to another session's (the fake
backend's `job-save-race` control file) and saves after Reload and keep my changes, starts the job once at a step, reorders, parses,
deletes and undoes steps on Steps and saves them, and creates a job by copying another from New Job.

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
With args.usual the same checks cover the usual durations (the median, the newest 10 succeeded runs only, a retried step's
rows added up, the table sent empty without it), and the live suite reads the scratch job's. `tests/agent-job-history.test.ts` covers the
History section's rules (durations, the outcome message, the SSIS execution link, the sparkline's samples, each step's state while the job
runs, the elapsed time) and its service against a fake view (opening once, following the newest run, a picked run kept, the failed
step's whole message, Copy, Failed, refusals). The `agent-jobs` smoke suite opens the Log File Viewer from Job Activity Monitor and drives All jobs, the Failed outcome, a
run's steps and message, and Delete History, then checks Current, selects a log row and runs Recycle (Enter on its
confirmation cancels). The `agent-job` smoke suite opens a job's History section.
`AgentErrorLogChecks` checks the error log args, the reader's merge, cap and failures against a fake
reader, the list's fallbacks, Recycle's validation and its lint with near misses offline; in the Agent live suite with
`VARIA_TEST_SQL_SCRATCH=1`, `AgentErrorLogLiveChecks` lists the logs, reads Current and recycles the server's Agent error log
(Current becomes Archive #1 and the new Current gets Agent's 412 line), or expects `AGENT_STOPPED` with Agent stopped.

`AgentObjectChecks` checks the alert and operator writes offline: validation and its refusals, each save's batch, the object batch
lint with near misses, the error mapping and the scripts. In the Agent live suite with `VARIA_TEST_SQL_SCRATCH=1`,
`AgentObjectLiveChecks` creates a scratch operator, saves it and is refused `NOT_FOUND` under another id, renames it to a hostile
name and back, disables and enables it, and on Windows creates a scratch alert with an inline new operator and two notifications,
changes and drops them, fails a later call and checks nothing committed, deletes the operator with Reassign to and deletes the
alert. No check sends e-mail. The `agent-job` smoke suite creates an alert from a job's New alert for this job…, saves a changed
cell in the Operators and notifications grid and sends a test e-mail through the fake backend.

Agent documents with unsaved changes are kept by hot exit and AutoRecover (docs/hot-exit.md, SQL Server Agent documents):
`tests/agent-hot-exit.test.ts` covers each kind's kept state and reopening, and the `agent-hot-exit` smoke suite quits with an
edited job and relaunches.

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
| `msdb.dbo.sp_update_job` | `@job_id`, `@enabled`, `@new_name`, `@description`, `@category_name`, `@owner_login_name`, `@notify_level_eventlog`, `@notify_level_email`, `@notify_level_netsend`, `@notify_level_page`, `@notify_email_operator_name`, `@notify_netsend_operator_name`, `@notify_page_operator_name`, `@delete_level`, `@start_step_id` | AG-2 |
| `msdb.dbo.sp_delete_job` | `@job_id`, `@delete_history`, `@delete_unused_schedule` | AG-2 |
| `msdb.dbo.sp_purge_jobhistory` | `@oldest_date`, `@job_id` | AG-8a |
| `msdb.dbo.sp_add_job` | `@job_name`, `@enabled`, `@description`, `@category_name`, `@owner_login_name`, `@notify_level_eventlog`, `@notify_level_email`, `@notify_level_netsend`, `@notify_level_page`, `@notify_email_operator_name`, `@notify_netsend_operator_name`, `@notify_page_operator_name`, `@delete_level`, `@job_id` | AG-6a |
| `msdb.dbo.sp_add_jobserver` | `@job_id` | AG-6a |
| `msdb.dbo.sp_update_alert` | `@name`, `@job_id`, `@new_name`, `@enabled`, `@message_id`, `@severity`, `@delay_between_responses`, `@notification_message`, `@include_event_description_in`, `@database_name`, `@event_description_keyword`, `@occurrence_count`, `@count_reset_date`, `@count_reset_time`, `@performance_condition` | AG-6a |
| `msdb.dbo.sp_add_jobstep` | `@job_id`, `@step_id`, `@step_name`, `@subsystem`, `@command`, `@cmdexec_success_code`, `@on_success_action`, `@on_success_step_id`, `@on_fail_action`, `@on_fail_step_id`, `@server`, `@database_name`, `@database_user_name`, `@retry_attempts`, `@retry_interval`, `@os_run_priority`, `@output_file_name`, `@flags`, `@proxy_id`, `@proxy_name` | AG-6b |
| `msdb.dbo.sp_update_jobstep` | `@job_id`, `@step_id`, `@step_name`, `@subsystem`, `@command`, `@cmdexec_success_code`, `@on_success_action`, `@on_success_step_id`, `@on_fail_action`, `@on_fail_step_id`, `@server`, `@database_name`, `@database_user_name`, `@retry_attempts`, `@retry_interval`, `@os_run_priority`, `@output_file_name`, `@flags`, `@proxy_id`, `@proxy_name` | AG-6b |
| `msdb.dbo.sp_delete_jobstep` | `@job_id`, `@step_id` | AG-6b |
| `msdb.dbo.sp_add_jobschedule` | `@job_id`, `@name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time` | AG-6c |
| `msdb.dbo.sp_attach_schedule` | `@job_id`, `@schedule_id` | AG-6c |
| `msdb.dbo.sp_detach_schedule` | `@job_id`, `@schedule_id`, `@delete_unused_schedule` | AG-6c |
| `msdb.dbo.sp_add_schedule` | `@schedule_name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time`, `@schedule_id` | AG-6c |
| `msdb.dbo.sp_update_schedule` | `@schedule_id`, `@new_name`, `@enabled`, `@freq_type`, `@freq_interval`, `@freq_subday_type`, `@freq_subday_interval`, `@freq_relative_interval`, `@freq_recurrence_factor`, `@active_start_date`, `@active_end_date`, `@active_start_time`, `@active_end_time` | AG-6c |
| `msdb.dbo.sp_delete_schedule` | `@schedule_id` | AG-6c |
| `msdb.dbo.sp_add_operator` | `@name`, `@enabled`, `@email_address`, `@pager_address`, `@weekday_pager_start_time`, `@weekday_pager_end_time`, `@saturday_pager_start_time`, `@saturday_pager_end_time`, `@sunday_pager_start_time`, `@sunday_pager_end_time`, `@pager_days`, `@netsend_address` | AG-7 |
| `msdb.dbo.sp_update_operator` | `@name`, `@new_name`, `@enabled`, `@email_address`, `@pager_address`, `@weekday_pager_start_time`, `@weekday_pager_end_time`, `@saturday_pager_start_time`, `@saturday_pager_end_time`, `@sunday_pager_start_time`, `@sunday_pager_end_time`, `@pager_days`, `@netsend_address` | AG-7 |
| `msdb.dbo.sp_delete_operator` | `@name`, `@reassign_to_operator` | AG-7 |
| `msdb.dbo.sp_add_alert` | `@name`, `@message_id`, `@severity`, `@enabled`, `@delay_between_responses`, `@notification_message`, `@include_event_description_in`, `@database_name`, `@event_description_keyword`, `@job_id`, `@performance_condition` | AG-7 |
| `msdb.dbo.sp_delete_alert` | `@name` | AG-7 |
| `msdb.dbo.sp_add_notification` | `@alert_name`, `@operator_name`, `@notification_method` | AG-7 |
| `msdb.dbo.sp_update_notification` | `@alert_name`, `@operator_name`, `@notification_method` | AG-7 |
| `msdb.dbo.sp_delete_notification` | `@alert_name`, `@operator_name` | AG-7 |
| `msdb.dbo.sp_set_sqlagent_properties` | `@sqlserver_restart`, `@monitor_autostart`, `@jobhistory_max_rows`, `@jobhistory_max_rows_per_job` | AG-8a |
| `msdb.dbo.sp_add_proxy` | `@proxy_name`, `@enabled`, `@description`, `@credential_name`, `@proxy_id` | AG-8b |
| `msdb.dbo.sp_update_proxy` | `@proxy_id`, `@credential_name`, `@new_name`, `@enabled`, `@description` | AG-8b |
| `msdb.dbo.sp_delete_proxy` | `@proxy_id` | AG-8b |
| `msdb.dbo.sp_grant_proxy_to_subsystem` | `@proxy_id`, `@subsystem_id` | AG-8b |
| `msdb.dbo.sp_revoke_proxy_from_subsystem` | `@proxy_id`, `@subsystem_id` | AG-8b |
| `msdb.dbo.sp_grant_login_to_proxy` | `@proxy_id`, `@login_name`, `@fixed_server_role`, `@msdb_role` | AG-8b |
| `msdb.dbo.sp_revoke_login_from_proxy` | `@proxy_id`, `@name` | AG-8b |
| `msdb.dbo.sp_cycle_agent_errorlog` |  | AG-5b |
| `msdb.dbo.sp_notify_operator` | `@profile_name`, `@name`, `@subject`, `@body` | AG-7 |

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
| `startJobs` | 100 | Jobs one Start, Stop, Enable, Disable, Change owner or Attach schedule from Job Activity Monitor may name |
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
| `notificationChanges` | 64 | Notification changes one alert or operator save makes (each one msdb call) |
| `newOperators` | 4 | Operators an alert save creates in place (the inline New operator) |
| `alertMessageChars` | 512 | Characters of an alert's additional notification message |
| `alertKeywordChars` | 100 | Characters of an alert's "Message contains" text |
| `conditionChars` | 512 | Characters of a performance condition (object\|counter\|instance\|comparator\|value) |
| `addressChars` | 100 | Characters of an operator's e-mail, pager and net send addresses |
| `alertDelaySeconds` | 86,400 | The most seconds an alert waits between responses |
| `counterRows` | 4,000 | Performance counters the alert document's pickers list |
| `counterInstances` | 500 | Instances one counter's current values list |
| `recommendedAlerts` | 16 | Alerts one Add recommended alerts creates |
| `alertRows` | 1,000 | Alerts the Operators and notifications grid reads |
| `operatorRows` | 500 | Operators one listing reads |
| `stepCommandChars` | 100,000 | Characters of one step's command in a job save |
| `stepCommandTotalChars` | 1,000,000 | Characters of all the steps' commands in one job save |
| `stepOutputChars` | 200 | Characters of a step's output file path (`sysjobsteps.output_file_name`) |
| `stepRetries` | 9,999 | A step's largest Retry attempts |
| `stepRetryMinutes` | 9,999 | A step's largest Retry interval, in minutes |
| `parseChars` | 250,000 | Characters the step editor's Parse sends (`language.parse`) |
| `parseErrors` | 100 | Errors one Parse reports; more set `truncated` |

A job save makes at most 254 calls at these caps, below the 255 a THROW state can number.
