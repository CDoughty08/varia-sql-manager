# Rethinking SQL Server Agent's UI

Status: proposal for the owner, 2026-11-16. Nothing here is in `docs/agent-plan.md` yet; once accepted, the plan
is revised to match. Mocks: the "Rethink (proposal)" group at the top of `docs/mockups/sql-server-agent.html`.

SSMS's Agent UI dates from small monitors: every object is a modal dialog with a page list, and anything inside it
(a step, a schedule, an operator, a credential) opens another modal on top. Setting up a job is a walk down three
levels of dialogs and back up. Varia keeps every SSMS capability, name and setting, and changes only the arrangement:
parity of what you can do, not of how many windows it takes.

## Where SSMS nests

| Task | SSMS today | Proposed |
| --- | --- | --- |
| Create a job with one T-SQL step and a daily schedule | New Job › Steps › New… (step dialog) › General › Advanced › OK › Schedules › New… (schedule dialog, three fieldsets) › OK › OK: three modal levels, about ten screens | One job document: name, Add step (edited in place), Add schedule (preset, edited in place), Save |
| Change one step's command | Properties › Steps › select › Edit… › edit in a plain text box › OK › OK | Open the job (tree, Job Activity Monitor, Ctrl+Q) › click the step › edit in a SQL editor › Ctrl+S |
| Reorder steps and fix their go-to targets | Move up/down, then open each affected step's Advanced page to repair On success / On failure | Drag in the steps list; each step's success and failure targets are inline in the list, broken ones flagged |
| Configure an SSIS step | Step dialog › Package tab (Browse… opens a package dialog) › Configuration tab › Parameters / Connection managers / Advanced sub-tabs: four levels | Step editor sections stacked in one scroll: package picked from an inline SSIS Catalog tree, parameters and connection managers as tables, Advanced collapsed |
| Reuse a shared schedule | Schedules › Pick… (picker) › Properties › Jobs in Schedule | "Add schedule" box searches shared schedules by name or by sentence; the jobs using each show as chips in place |
| Edit a schedule | Frequency, Daily frequency and Duration fieldsets, a read-only Description sentence | Presets, the fields in one compact block, the live sentence, and the next ten run times |
| Find out why a job failed | View History › Log File Viewer window › expand the run › select the step › read the bottom pane | The job document's History section: runs with step outcomes inline, the failed step's message open by default; Log File Viewer stays for cross-job history |
| Make an alert notify a new operator | Alert › Response › New Operator… (child dialog) | Operators as chips with an inline "Add operator" row (name, e-mail, pager) |
| Give a proxy a new credential | Proxy › New Credential… (child dialog) | Credential box with an inline "Create credential" section (name, identity, secret) |
| Open a job from Job Activity Monitor | A modal over the monitor, which stops being usable | Opens (or focuses) the job's document tab; the monitor stays live in its own tab or split |
| Manage shared schedules | Modal list › Properties (modal) › Jobs in Schedule (modal) | A Schedules document: grid with inline Enabled, the selected schedule's editor and its jobs beside it |
| Operator notifications, Agent Properties, confirmations | Pages and modals | Unchanged in spirit: small, rarely used, already one level |

## Principles

1. **Agent objects are documents, not modal dialogs.** Jobs, alerts, operators, proxies and schedules open as document
   tabs, like a query: several at once, a dirty dot, Ctrl+S to save, Script beside Save, a prompt when closing unsaved
   work. Agent Properties, Start/Stop/Restart and every confirmation stay dialogs.
2. **One level of master and detail, never a dialog on a dialog.** A list on the left (steps, schedules, runs) and the
   selected item's editor on the right, in the same document.
3. **Pick and create in place.** Pickers are search boxes with an inline "New …" section; creating a credential, an
   operator or a schedule never leaves the document. Creating a whole job from an alert opens a new job tab instead.
   This retires the stacked child dialogs (round 35): nothing needs a dialog over a dialog any more.
4. **Real editors.** T-SQL, PowerShell and CmdExec steps use the query editor's Monaco with syntax, the step's database
   as context, and completion from the Search Objects index.
5. **Show the common, fold the rare.** Retries, output files, table logging, run-as and Targets sit behind a one-line
   summary ("Retries 2 × 5 min · output to D:\AgentLogs\…") that expands in place.
6. **Live context where you work.** The job header shows its live state, last outcome, next run, Start (with a step
   menu) and Stop, from the same `agent.jobs` probe Job Activity Monitor uses.
7. **SSMS's vocabulary stays.** Page names become section names, every field keeps its SSMS label, and Script still
   produces SSMS's script.

## Create from…

Many jobs differ from another only in a step's SSIS package, a database or the schedule. SSMS's answer is Script Job
As › CREATE, edit the text, run it. Varia adds a direct path.

- **Entry points**: the job context menu and Job Activity Monitor's row menu, "Create Job Like This…"; the Jobs folder's
  New Job split button, "New Job from Existing…" (a job picker); the palette, "SQL Server Agent: New Job from
  Existing…".
- **What opens**: a New Job document filled from the source job's describe, with a banner "Based on <source>" and a
  **Changes from source** panel at the top that gathers what usually differs, so a typical clone is one screen:
  - Name, prefilled "<source> (copy)" and selected.
  - Enabled, off by default with "Enable when saved" (two jobs running the same work by accident is the costly mistake).
  - Each step's key field: the SSIS package and environment, the T-SQL database, the CmdExec command or the PowerShell
    script, editable right there; everything else in the step is copied.
  - Each schedule: **Share** (attach the same shared schedule; the default, as SSMS's schedules are shared objects),
    **Copy** (a new schedule you can edit) or **Leave out**.
  - Fields changed from the source carry a small "changed" mark, so a reviewer sees the difference at a glance.
- **What is copied**: description, category, notifications, steps with their flow, retries and output settings.
  **Not copied**: history, alert links (they belong to the alerts; sysadmin gets a "Link the same alerts" checkbox),
  the owner (you, unless sysadmin keeps the source's), a proxy the login may not use (flagged on its step).
- **Save** is New Job's own one-transaction `sp_add_job` save; Script shows the CREATE script. No new backend write.
- **Create several (option)**: from the same panel, "Create several…" turns the key fields into a table, one row per new
  job (Name, package, schedule), each created in its own transaction with a per-row result. Useful for the "one job per
  package" pattern; it could ship later.

## If accepted, what changes in the plan

- Job, alert, operator, proxy and schedule editors become document tabs instead of `ObjectDialog` pages. The save
  paths, msdb templates, identity and `STALE` guards, step save planner, role rules and read-only rules are unchanged;
  read-only becomes a document mode. Unsaved drafts join hot exit like query tabs.
- Dropped: stacked child dialogs (inline creation instead) and the object-target dialog open form (documents open from
  anywhere). Kept: Log File Viewer master/detail for cross-job history; Job Activity Monitor; every service-control
  dialog.
- Lanes: AG-6a becomes the job document shell (sections, steps master/detail, Monaco step editor); AG-6c the schedule
  editor (presets, next runs) and Schedules document; Create from… joins AG-6a, Create several… is its own small lane
  or later. The sizing is about even: document infrastructure replaces the child-dialog infrastructure.

## Questions for the owner

1. Adopt documents and in-place editing for Agent objects (retiring stacked child dialogs)?
2. Create several… in 0.10.0, or later?
3. On Create from…, should schedules default to Share or Copy?
