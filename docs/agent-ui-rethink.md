# Rethinking SQL Server Agent's UI

Status: **adopted by the owner on 2026-11-16** for Agent's first release, which shipped in 0.10.0 alongside BigQuery (owner decision
2026-11-23).
`docs/agent-plan.md`'s lanes were rewritten to match on 2026-11-18. Mocks: the "Rethink · …" groups
at the top of `docs/mockups/sql-server-agent.html`; the SSMS-style scenes below them stay as reference.

SSMS's Agent UI dates from small monitors: every object is a modal dialog with a page list, and anything inside it
(a step, a schedule, an operator, a credential) opens another modal on top. Setting up a job is a walk down three
levels of dialogs and back up. Varia keeps every SSMS capability, name and setting, and changes only the arrangement:
parity of what you can do, not of how many windows it takes.

## Where SSMS nests

| Task | SSMS today | Proposed | Mock |
| --- | --- | --- | --- |
| Create a job with one T-SQL step and a daily schedule | New Job › Steps › New… (step dialog) › General › Advanced › OK › Schedules › New… (schedule dialog) › OK › OK: three modal levels, about ten screens | One job document: name, Add step (edited in place), Add schedule (preset, edited in place), Save | `rx-job-new`, `rx-job-steps` |
| Change one step's command | Properties › Steps › select › Edit… › plain text box › OK › OK | Open the job (tree, Job Activity Monitor, Ctrl+Q) › click the step › edit in Monaco › Ctrl+S | `rx-job-steps` |
| Reorder steps and fix their go-to targets | Move up/down, then each affected step's Advanced page | Drag in the steps list; ✓ success and ✗ failure targets are shown in the list and follow the move | `rx-job-steps` |
| Configure an SSIS step | Package tab (Browse… dialog) › Configuration tab › Parameters / Connection managers / Advanced sub-tabs | One scroll: inline SSISDB picker, every parameter with where its value comes from, Advanced folded | `rx-step-ssis` |
| Reuse a shared schedule | Schedules › Pick… › Properties › Jobs in Schedule | Search shared schedules by name or by when; who else uses it shows in place | `rx-job-schedules` |
| Edit a schedule | Three fieldsets and a read-only sentence | Presets that fill SSMS's own fields, the sentence, the next five runs, a free-slot check | `rx-job-schedules` |
| Find out why a job failed | View History › Log File Viewer window › expand › select step › bottom pane | The job's History section: runs with a duration sparkline, the failed step's full message open, an SSIS execution link | `rx-job-history` |
| Watch a run | Job Activity Monitor refresh, or the Start Job progress dialog | The job's History shows the run live like a CI run: step states, this run against the usual time, Stop | `rx-job-running` |
| Make an alert notify a new operator | Alert › Response › New Operator… (child dialog) | Operator chips with an inline new-operator row, saved with the alert | `rx-alert` |
| Set who is notified of what | Each alert's Response page, each operator's Notifications page, each job's Notifications page | One Operators and notifications grid (alerts or jobs by operators) | `rx-operators` |
| Give a proxy a new credential | Proxy › New Credential… (child dialog) | Credential box with an inline create section | `rx-proxy` |
| Open a job from Job Activity Monitor | A modal over the monitor | Opens or focuses the job's tab; the chevron shows the last run in place | `rx-jam` |
| Change many jobs (owner, enable, schedule) | One Properties dialog per job | Select rows in Job Activity Monitor, then one bulk action; one request per job with its own result | `rx-jam` |
| Manage shared schedules | Modal list › Properties (modal) › Jobs in Schedule (modal) | A Schedules document: grid, the selected schedule and its jobs beside it, and a Timeline view | `rx-schedules-doc`, `rx-timeline` |
| Agent Properties, Start/Stop/Restart, confirmations | Dialogs | Unchanged: small, rare and already one level | |

## Principles

1. **Agent objects are documents, not modal dialogs.** Jobs, alerts, operators, proxies and schedules open as document
   tabs, like a query: several at once, a dirty dot, Ctrl+S, Script beside Save, a prompt when closing unsaved work.
   Save says how many changes it will send ("Save · 2 changes").
2. **One level of master and detail, never a dialog on a dialog.** A list on the left (steps, schedules, runs) and the
   selected item's editor on the right.
3. **Pick and create in place.** Pickers are search boxes with an inline "New …" section. Creating a credential, an
   operator or a schedule never leaves the document. Creating a whole job from an alert opens a new job tab. This retires
   the stacked child dialogs (round 35).
4. **Real editors.** T-SQL, PowerShell and CmdExec steps use Monaco with the step's database as context, Parse, and
   Open in query window to test the command there (not as the job).
5. **Show the common, fold the rare.** Retries, output files, logging and run-as sit behind a one-line summary
   ("Retry 2 times, 5 minutes apart · output to D:\AgentLogs\…") that expands in place.
6. **Problems, not surprises.** A document lists what will make the job fail before it runs: a required SSIS parameter
   without a value, a go-to target that no longer exists, a proxy not active for the step's subsystem, an owner that
   cannot log in. They show on the field, the tab and the header. They warn but do not block Save, since msdb does not
   check them either.
7. **Live context where you work.** The job header shows state, last outcome and next run, with Start (and a step menu)
   and Stop, from the same `agent.jobs` probe Job Activity Monitor uses.
8. **SSMS's vocabulary stays.** Page names become section names, every field keeps its SSMS label (Frequency, Daily
   frequency, Duration, "Active to the following subsystems"), and Script still produces SSMS's script.

## Industry patterns and aids worth borrowing

Each is a well-known pattern elsewhere. Each would cut steps or prevent a common Agent mistake.

| Pattern | Where it is familiar | In Varia | Mock |
| --- | --- | --- | --- |
| Document tabs with dirty state and save | Every editor; VS Code | Agent objects as documents | all `rx-job-*` |
| Duplicate with a "what changes" form | Cloud consoles ("Create similar", "Launch more like this") | Create Job Like This, Changes from source | `rx-create-from` |
| Find and replace across a copy, with preview | Refactoring tools | Replace across the copy ("Sales" → "HR" in names, commands, paths) | `rx-create-from` |
| Spreadsheet-style bulk create, paste from Excel | Admin consoles, Azure DevOps bulk edit | Create several, with per-row overrides | `rx-create-several` |
| Run view with step states and durations | CI pipelines (GitHub Actions, Azure Pipelines) | Running job and History look like CI runs | `rx-job-running`, `rx-job-history` |
| Duration baselines and anomaly hints | APM and job schedulers | "usual 18 min" from the median of the last 10 successful runs; sparkline | `rx-job-history` |
| Natural-language schedule plus next fire times | crontab.guru, cloud schedulers, Task Scheduler | SSMS's sentence plus the next five runs and presets | `rx-job-schedules` |
| Job calendar / timeline | Third-party Agent monitors (job calendars and Gantt views) | Schedules › Timeline with overlaps flagged | `rx-timeline` |
| Lint before run | IDEs, infrastructure "plan" | Problems on the document (principle 6) | `rx-step-ssis` |
| Best-practice health checks | Community scripts such as sp_Blitz; cloud advisors | Agent overview: failed jobs, owners that cannot log in, jobs that notify no one, history retention, missing alerts, mail | `rx-agent-overview` |
| Recommended defaults in one click | Community-standard alert set (severity 17–25, errors 823–825) | Add recommended alerts | `rx-alerts-recommended` |
| Test the notification channel | Monitoring tools' "send test" | Send test e-mail (`sp_notify_operator`) and an Agent mail check | `rx-alert`, `rx-operators` |
| Matrix for many-to-many settings | Permission grids | Operators by alerts (or jobs) | `rx-operators` |
| Multi-select and bulk actions | Every admin grid | Job Activity Monitor bulk bar | `rx-jam` |
| Templates on New | Project templates, cloud quick-starts | New Job: Blank, Copy an existing job, or a template | `rx-job-new` |
| Copy to another environment with a dependency check | dbatools Copy-DbaAgentJob | Copy to another server | `rx-copy-server` |

## Create from…

Many jobs differ from another only in a step's SSIS package, a database or the schedule. SSMS's answer is Script Job
As › CREATE, edit the text, run it. Varia adds a direct path.

- **Entry points**: "Create Job Like This…" on the job menu and Job Activity Monitor's row menu; "Copy an existing
  job…" on New Job's start panel; the palette's "SQL Server Agent: New Job from Existing…".
- **What opens**: a New Job document filled from the source's describe, with a **Changes from source** tab first:
  - **Replace across the copy**: one find/replace over names, step commands, output file paths and package paths, with
    a preview of each match before it applies.
  - **Job**: Name; Owner (you, unless sysadmin keeps the source's); Enabled, off by default with "Enable when saved".
  - **Each step's key field**: the SSIS package and environment, the T-SQL database and command, the CmdExec command,
    the PowerShell script. When a new package has a required parameter the source's did not, it is flagged with "Set it
    now".
  - **Each schedule**: Share (attach the same schedule), Copy (a new schedule you can edit in place) or Leave out.
  - Fields changed from the source carry a "changed" mark, and "Compare with source" shows every difference.
- **What is copied**: description, category, notifications, steps with their flow, retries, output and logging.
  **Not copied**: history; the alerts that run the source. An alert runs exactly one job, so linking it to the copy
  would take it away from the source. The first pass offered "Link the same alerts"; that was wrong and is withdrawn.
- **Save** is New Job's own one-transaction `sp_add_job` save; Script shows the CREATE script. No new backend write.

### Create several (option)

"Create several…" on the Changes from source tab turns the copy into a table, one row per new job.

- **Columns**: Name and the key fields to start with. **Columns** adds any other field of the job as a column
  (a step's command, retries, a notification operator, description, category, owner). Empty cells use the source's
  value, shown grey. A typed cell overrides that field for that job only, and shows an accent edge.
- **Per-job customization**: to change a field in only one row, select the row. Its details pane lists every field
  that differs from the source, with Reset on each. **Open full editor** opens that row as an unsaved job tab with
  every section. What you change there comes back to the row as "Other changes" (for example "+3 fields") and is
  listed in the details pane. So every job can be customized completely: through a column for changes all rows need,
  through the full editor for one-offs.
- **Fill**: Add row, Duplicate row, Paste rows (one spreadsheet column per visible column) and Fill names… (a pattern
  such as "ETL – Load {package}").
- **Checks before sending**: duplicate names and required parameters without values are flagged on the row before
  anything is sent. "Review and create N jobs" sends rows with no blocking problem.
- **Results**: each row is its own transaction with its own result. Created rows lock with an Open link. Failed and
  skipped rows go back to the table to fix and retry. "Enable the created jobs" is one click, since they were saved
  disabled.

## What changes in the plan

- Job, alert, operator, proxy and schedule editors become document tabs instead of `ObjectDialog` pages. These stay
  unchanged: save paths, msdb templates, identity and `STALE` guards, the step save planner, role rules and read-only
  rules. Read-only becomes a document mode, and unsaved drafts join hot exit like query tabs.
- Alert becomes one screen (When / Then / Options; history in the header). Proxy becomes one screen.
- Dropped: stacked child dialogs (inline creation replaces them) and the object-target dialog open form (documents
  open from anywhere). Kept: Log File Viewer master/detail for cross-job history, Job Activity Monitor and every
  service-control dialog.
- Lanes:
  - AG-6a becomes the job document shell: sections, steps master/detail, the Monaco step editor, Problems, History in
    place and the live run view.
  - AG-6c becomes the schedule editor (presets, next runs) and the Schedules document.
  - Create Job Like This joins AG-6a. Create several is its own small lane.
  - Overall sizing is about even: document infrastructure replaces the child-dialog infrastructure.

## Tiers (decided 2026-11-16)

In Agent's first release (0.10.0):
- The document model.
- Inline creation.
- Alert and proxy on one screen.
- Schedule presets and next runs.
- History in place and the live run view (same probes and history reads the plan already has).
- Problems on the document.
- Create Job Like This with Replace across the copy.
- Job Activity Monitor's chevron, double-click to open, and bulk Enable, Disable and Start.
- Add recommended alerts (sp_add_alert and sp_add_notification, which the plan already uses).
- Send test e-mail and the Agent mail check (sysadmin reads).
- The Operators and notifications grid (it replaces three pages, so it is close to neutral).
- Bulk Change owner and Attach schedule (one request per job).
- Create several.

After the first release, in docs/agent-plan.md's lanes:
- Schedules Timeline (AG-14).
- Activity Monitor job links (AG-16).

Later:
- Copy to another server (a write on a second connection).
- New Job templates.
- A Flow view of step targets.

## Every changed view has a rethink scene

| SSMS-style scene (kept for reference) | Rethink scene |
| --- | --- |
| Job Properties · General, Targets | rx-job-general |
| Job Properties · Notifications | rx-job-notifications |
| Job Properties · Alerts, Job › Alerts › New Alert (stacked child) | rx-job-alerts |
| Job Properties · read-only | rx-job-readonly |
| Save refused (changed by someone else, permission denied) | rx-job-stale, rx-job-denied |
| Job Properties · Steps, Job Step · General (T-SQL) | rx-job-steps |
| Job Step · General (PowerShell, proxy), Advanced | rx-step-ps |
| Job Step · General (CmdExec) | rx-step-cmdexec |
| Job Step · General (SSIS package) | rx-step-ssis |
| Delete step (other steps jump to it) | rx-step-delete |
| Start Job at Step | rx-start-step |
| Job Properties · Schedules, Job Schedule | rx-job-schedules |
| Pick Schedule, Jobs in Schedule, CPU idle warning | rx-schedule-pick |
| Remove schedule (offer to delete) | rx-schedule-remove |
| Manage Schedules | rx-schedules-doc |
| Alert Properties · General, Response, Options, History | rx-alert |
| Alert Properties · performance condition, WMI | rx-alert-perf |
| Operator Properties · General, Notifications, History | rx-operators |
| Delete Object · operator, Reassign to | rx-operator-delete |
| Proxy Properties, New Credential | rx-proxy |
| Credential Properties | rx-credential |
| SQL Server Agent Properties · General, History, purge confirmation | rx-agent-props |
| Job Activity Monitor | rx-jam |

Unchanged, so no rethink scene: the Object Explorer scenes, Log File Viewer (cross-job history and the error log), every
service-control dialog and progress state, Delete Object for a job, Delete History, Filter Settings and the status-bar
chip.

## Questions for the owner

None. Create from… schedules default to Share (decided 2026-11-18); each can be switched to Copy or Leave out.
