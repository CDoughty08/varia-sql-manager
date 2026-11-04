# Object actions

<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->

Object Explorer's actions on objects: Select Top 1000 Rows, Rename, Delete, Properties, a database's Tasks › Detach…, Take
Offline and Bring Online, and the Databases folder's Attach. Which kinds, subtypes and folders offer each is
data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`
and re-derives the subtype in the action's own connection before any DDL runs.

## Actions

| Action | Menu title | Command | Kind | Menu | Group | Mnemonic | Windows and Linux | macOS | Servers | Context key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `selectTop` | Select Top 1000 Rows | `explorer.selectTopRows` | query | `explorer.context` | `1_query` 3 | w | — | — | SQL Server, Managed Instance, Azure SQL Database | `explorerActionSelectTop` |
| `rename` | Rename | `explorer.rename` | inline | `explorer.context` | `7_edit` 1 | m | F2 | F2 | SQL Server, Managed Instance | `explorerActionRename` |
| `delete` | Delete | `explorer.delete` | dialog (`deleteObject`) | `explorer.context` | `7_edit` 2 | e | Delete | ⌘⌫, Delete | SQL Server, Managed Instance | `explorerActionDelete` |
| `properties` | Properties | `explorer.properties` | dialog (`databaseProperties`) | `explorer.context` | `9_properties` 1 | p | — | ⌘I | SQL Server, Managed Instance | `explorerActionProperties` |
| `attach` | Attach… | `explorer.attachDatabase` | dialog (`attachDatabase`) | `explorer.context` | `0_new` 2 | a | — | — | SQL Server | `explorerActionAttach` |
| `takeOffline` | Take Offline | `explorer.takeOffline` | dialog (`takeOffline`) | `explorer.tasks` | `1_state` 1 | t | — | — | SQL Server | `explorerActionTakeOffline` |
| `bringOnline` | Bring Online | `explorer.bringOnline` | dialog (`bringOnline`) | `explorer.tasks` | `1_state` 2 | o | — | — | SQL Server | `explorerActionBringOnline` |
| `detach` | Detach… | `explorer.detachDatabase` | dialog (`detachDatabase`) | `explorer.tasks` | `0_detach` 1 | d | — | — | SQL Server | `explorerActionDetach` |
| `restore` | Restore Database… | `explorer.restoreDatabase` | dialog | `explorer.context` | `0_new` 3 | r | — | — | SQL Server | `explorerActionRestore` |
| `restoreFiles` | Restore Files and Filegroups… | `explorer.restoreFiles` | dialog | `explorer.context` | `0_new` 4 | e | — | — | SQL Server | `explorerActionRestoreFiles` |
| `disable` | Disable | `explorer.disable` | inline | `explorer.context` | `6_state` 1 | b | — | — | SQL Server, Managed Instance | `explorerActionDisable` |
| `enable` | Enable | `explorer.enable` | inline | `explorer.context` | `6_state` 1 | b | — | — | SQL Server, Managed Instance | `explorerActionEnable` |

"Servers" is each action's `engines`: SQL Server is the box editions, Managed Instance is EngineEdition 8, and Azure SQL
Database stands for the cloud editions. The backend refuses an action elsewhere with `NOT_SUPPORTED` before it opens a
connection. The table designer's `createTable` runs on SQL Server and Managed Instance.

Actions that make an object open their dialog on a folder and name its owner as their target; no tree row offers them, so
they have their own commands and no context key:

| Action | Title | Dialog | Servers |
| --- | --- | --- | --- |
| `createLogin` | New Login | `newLogin` | SQL Server |

Keys work while Object Explorer has focus and no text field does. Delete's access key is E: Disconnect has SSMS's D in
Varia's one Object Explorer menu.
Select Top 1000 Rows follows Tools › Options › SQL Server Object Explorer › Commands (Select Top <n> Rows).
Properties is the last item, after Refresh, and is offered on SQL Server's own databases too, as in SSMS. SSMS 22's
access key and shortcut for it are unverified: Varia uses P, and ⌘I (Finder's Get Info) on macOS only, because Alt+Enter
is reserved on Windows and Linux.

## Object kinds

✓ enabled, ○ shown greyed, – not offered.

| Kind | Subtypes | Select Top 1000 Rows | Rename | Delete | Properties | Take Database Offline | Bring Database Online | Detach Database… | Disable Login | Enable Login |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `login` | none | – | – | – | – | – | – | – | – | – |
| `login` | `sa` | – | ✓ | ○ | – | – | – | – | ✓ | – |
| `login` | `system` | – | ○ | ○ | – | – | – | – | ○ | – |
| `login` | `sql`, `windowsUser`, `certificateMapped`, `asymmetricKeyMapped` | – | ✓ | ✓ | – | – | – | – | ✓ | – |
| `login` | `windowsGroup` | – | ✓ | ✓ | – | – | – | – | ○ | – |
| `login` | `externalUser`, `externalGroup` | – | ○ | ✓ | – | – | – | – | ✓ | – |
| `database` | none | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| `database` | `system` | – | ○ | ○ | ✓ | ○ | ○ | ○ | – | – |
| `database` | `snapshot` | – | ○ | ✓ | ✓ | – | – | – | – | – |
| `table` | none, `graphNode`, `graphEdge` | ✓ | ✓ | ✓ | – | – | – | – | – | – |
| `table` | `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `ledgerHistory`, `fileTable`, `external`, `system` | ✓ | ○ | ○ | – | – | – | – | – | – |
| `table` | `droppedLedger` | – | ○ | ○ | – | – | – | – | – | – |
| `view` | none | ✓ | ✓ | ✓ | – | – | – | – | – | – |
| `view` | `system`, `ledger` | ✓ | ○ | ○ | – | – | – | – | – | – |
| `view` | `droppedLedger` | – | ○ | ○ | – | – | – | – | – | – |
| `procedure` | none, `sql`, `clr` | – | ✓ | ✓ | – | – | – | – | – | – |
| `procedure` | `extended`, `replicationFilter`, `system` | – | ○ | ○ | – | – | – | – | – | – |
| `function` | none, `inline`, `tableValued`, `clrTableValued`, `scalar`, `clrScalar` | – | ✓ | ✓ | – | – | – | – | – | – |
| `function` | `aggregate` | – | ✓ | ○ | – | – | – | – | – | – |

## Folder actions

These are offered on an Object Explorer folder instead of object rows; their target is the folder's server (`{ kind: 'server' }`),
and the backend refuses any other target.

| Action | Folder | Servers |
| --- | --- | --- |
| Attach Database… | `databases` | SQL Server |
| Restore Database… | `databases` | SQL Server |
| Restore Files and Filegroups… | `databases` | SQL Server |

## Menus, statuses, database states and servers

An action's item goes in `explorer.context`, `explorer.tasks`, `explorer.tasks.restore`: Object Explorer's menu, or its Tasks submenus. Tasks (`explorer.tasks`) and Tasks › Restore (`explorer.tasks.restore`) stay hidden while nothing is placed in them, so they appear with their first action.

A node's status badge (`explorerNodeStatus`) can overlay its row: a disabled login offers Enable in place of Disable.

| Kind | Subtypes | Status | Changes |
| --- | --- | --- | --- |
| `login` | `sa`, `sql`, `windowsUser`, `certificateMapped`, `asymmetricKeyMapped`, `externalUser`, `externalGroup` | `disabled` | Disable Login: –, Enable Login: ✓ |
| `login` | `system` | `disabled` | Disable Login: –, Enable Login: ○ |
| `login` | `windowsGroup` | `disabled` | Disable Login: –, Enable Login: – |

Only `disabled` changes a login's actions: a login denied permission to connect can still be disabled, as in SSMS.

A database row carries its runtime state as listed (state, user access, read-only, standby); a newer live status sample wins.
Rules narrow a database's actions by it, each with the reason a greyed item shows. The states: `online`, `restoring`, `recovering`, `recoveryPending`, `suspect`, `emergency`, `offline`, `copying`, `offlineSecondary`, `other`.
| Action | States | Access | Read-only | Effect | Reason |
| --- | --- | --- | --- | --- | --- |
| Take Database Offline | offline | Any | Any | Greyed | The database is offline. |
| Take Database Offline | restoring, recovering, copying, offlineSecondary | Any | Any | Greyed | A database that is restoring or recovering cannot be taken offline. |
| Bring Database Online | online | Any | Any | Greyed | The database is online. |
| Bring Database Online | restoring, recovering, copying | Any | Any | Greyed | A database that is restoring or recovering cannot be brought online. |
| Detach Database… | restoring, recovering, copying | Any | Any | Greyed | Wait until it finishes restoring or recovering. |
| Detach Database… | suspect, recoveryPending | Any | Any | Greyed | Set the database to EMERGENCY with T-SQL before you detach it. |
| Rename | restoring, recovering, recoveryPending, suspect, emergency, offline, copying, offlineSecondary, other | Any | Any | Greyed | The database must be online to be renamed. |
| Rename | Any | Any | Yes | Greyed | A read-only database cannot be renamed. |

Each action names the servers that offer it (`box`, `managedInstance`, `cloud`: an on-premises SQL Server or a container, Azure SQL Managed Instance, Azure SQL Database);
the Servers column above says which, and on another server the menu hides the item. Menus read the server through
`explorerServerEngine` and `explorerServerLinux`.

## Dialogs

| Dialog | Title | Opens as | Action | Pages | Steps panel |
| --- | --- | --- | --- | --- | --- |
| `deleteObject` | Delete Object | Modal dialog | `delete` | General (`settings-gear`) | Yes |
| `databaseProperties` | Database Properties - <name> | Document tab | `properties` | General (`settings-gear`), Files (`settings-gear`), Filegroups (`settings-gear`), Options (`settings-gear`) | No |
| `newDatabase` | New Database | Document tab | `createDatabase` | General (`settings-gear`), Options (`settings-gear`), Filegroups (`settings-gear`) | No |
| `attachDatabase` | Attach Databases | Modal dialog | `attach` | General (`settings-gear`) | No |
| `newLogin` | Login - New | Modal dialog | `createLogin` | General (`settings-gear`, kept mounted), Server Roles (`settings-gear`), User Mapping (`settings-gear`, kept mounted), Status (`settings-gear`) | Yes |
| `takeOffline` | Take Database Offline - <name> | Modal dialog | `takeOffline` | General (`settings-gear`) | Yes |
| `bringOnline` | Bring Database Online - <name> | Modal dialog | `bringOnline` | General (`settings-gear`) | Yes |
| `detachDatabase` | Detach Database - <name> | Modal dialog | `detach` | General (`settings-gear`) | Yes |

A modal dialog is for a confirmation (Delete Object). A property sheet opens as a document tab instead (U1 D2): its
pages are sections in one scrolling column with a section list beside it, and a Script drawer under it.

A modal dialog with more than one page lists them beside the page (SSMS's "Select a page"); where the dialog is narrower
than 720 px (a viewport under 768 CSS px, as when zoomed in: the window is at least 1024 px wide) the list becomes a row of tabs above the page (a `tablist` named "Select a page", arrow keys, Home and End). A
page marked kept mounted stays in the page once visited, hidden while another shows, so what it holds (a running list,
a typed value) survives switching away. A dialog with a steps panel shows its plan as a list of steps, scrolling in at most 40 % of the column
(`kit/StepList.tsx`, Create Catalog's too), each pending, running, done, failed, cancelled or skipped, with an optional
progress bar under a running step.

In a modal dialog, the Script button scripts to a new query window; its arrow lists Script Action to New Query Window, Script Action to File, Script Action to Clipboard. Script never runs anything.
OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.

Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,
greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only
confirmation.

For a database, the dialog also says what the DROP meets. Its warnings say when the database is offline ("This database
is offline. Deleting it removes it from the server but leaves its files on disk."; SQL Server drops an offline database
without deleting its files) and when database snapshots of it exist (the DROP fails until they are deleted). With VIEW
SERVER STATE it lists the sessions using the database in a "Sessions using <database>" disclosure (session, program,
host, and whether each has an open transaction; at most 8 of them, never Varia's own pooled sessions). A session
uses the database when it is in it or has a transaction there from another database: SET SINGLE_USER WITH ROLLBACK
IMMEDIATE rolls back both. Under Close existing connections the dialog counts the sessions with an open transaction,
which closing rolls back, and names Varia's own query windows whose session holds one (by session, whatever database
the window is in). On Azure SQL Managed Instance, which cannot set SINGLE_USER, Close existing connections is greyed
with that reason, and a request that asks for it is refused before anything runs; where the option is greyed, the dialog
only counts the open transactions. An offline database has no sessions to close: the option is greyed ("An offline
database has no connections to close.") and its Delete runs no SINGLE_USER. Without VIEW SERVER STATE (or with VIEW
SERVER PERFORMANCE STATE denied on SQL Server 2022 and later) the dialog counts and lists no sessions, since SQL Server
shows such a login only its own, and the database's owner still describes, scripts and deletes it: the transaction DMVs
that find sessions using the database from elsewhere are read only with the permission.

Once a database is deleted (or its DROP completed before a later step failed), each Database Properties document on it
turns orphan: what it showed stays, read-only, under "This database no longer exists on <server>." with Close and no
Refresh, and a toast counts the query windows that were using it ("3 query windows were using SalesDb."), which stay open.

### Take Offline and Bring Online

Tasks › Take Offline opens Take Database Offline - <name>: a grid of Database Name, Drop All Active Connections
(cleared), Status and Message, as SSMS 18 and later lay it out (recalled). The Message counts the sessions in the
database and those with an open transaction; a disclosure lists them (session id, login, program, host and open
transactions, at most 8, with VIEW SERVER STATE), and the page names Varia's own query windows on the database
whose session holds an open transaction, which Drop All Active Connections rolls back (A7). Before it counts, the
describe closes the backend's own idle pooled connections in the database, as the action does before SET OFFLINE, and
waits up to a second for SQL Server to end their sessions; every session left is listed, Varia's query windows and busy
pooled connections included (a session id alone never marks a session as Varia's: SQL Server reuses freed ids). Without
VIEW SERVER STATE the Message says the sessions are unknown, and OK runs.

`SET OFFLINE` without a termination clause waits for every other session to leave, so while sessions are connected and
the box is cleared the Status is Not ready and OK is disabled, with the reason beside it; Check Again counts them again.
Checked, OK runs `SET OFFLINE WITH ROLLBACK IMMEDIATE` (about 3 s even on an idle database, probed). Either way the run
can wait for locks, so Stop (focused once OK starts the run) cancels it in SQL Server and the database stays online; the
row then asks to Check Again. A success keeps the dialog open on its steps with Close focused and Script greyed, as
SSMS's progress dialog does.

Tasks › Bring Online opens Bring Database Online - <name> and runs `SET ONLINE` at once, with nothing to confirm; Stop
cancels a recovery that waits. The menu offers it on any state SQL Server lets `SET ONLINE` act on (offline, recovery
pending, suspect, emergency) and greys it while the database is online, restoring, recovering or copying. A database left
SINGLE_USER (or RESTRICTED_USER) while it was offline comes back so, and the reply says so in a message (read after
SET ONLINE under a budget of its own, so a Stop that arrives just then leaves the success a success).

Both are offered on box SQL Server only (Managed Instance cannot set OFFLINE or ONLINE), greyed on SQL Server's own
databases and absent on a snapshot. The backend re-derives the state rules above from `sys.databases` before it runs
anything, refuses a database whose identity changed since the dialog read it, and needs ALTER ANY DATABASE, dbcreator,
ownership, or (while it is online) ALTER on the database: `HAS_PERMS_BY_NAME` on the database answers 0 to a login with no
user in it, to sysadmin while another session holds it SINGLE_USER, and to everyone once it is offline (probed). SQL
Server's 5011 is PERMISSION_DENIED too. After either, the Databases folder is listed again ("(Offline)" in the sublabel),
and the database's Database Properties documents on that server read it again, or, while they hold changes, keep them
with an Offline status and a banner; Apply still runs, and its preflight refuses a database that is not online.

### Detach

Tasks › Detach… opens Detach Database - <name>, a modal laid out as Learn describes SSMS's dialog: a "Databases to detach"
grid of Database Name, Drop Connections and Update Statistics (both cleared), Status and Message. Keep Full-Text Catalogs is
left out: SSMS shows it only for a database upgraded from SQL Server 2005. The Message counts the sessions in the database
(after the describe closes the backend's own idle pooled connections in it, as Take Offline's does); a closed disclosure
lists them, and the page says what Drop Connections rolls back, naming Varia's query windows with an open transaction (A7).
Below the grid, "Files that stay on the server" lists the database's files (`sys.master_files`, at most 256: logical name, type
and path), which Copy paths copies one per line, for an Attach later. A db_owner member without VIEW ANY DEFINITION sees no
rows there, so an online database's own `sys.database_files` lists them instead; when neither shows any, a note says the paths
could not be read. Once the detach succeeded, the sessions and what closing them rolls back are no longer shown, and the
boxes are disabled. Enter on the closed Sessions list opens it, as on any disclosure or link, and never presses OK.

`sp_detach_db` refuses a database other sessions use (3703, `IN_USE`), so while sessions are connected and Drop Connections
is cleared the Status is Not ready and OK is disabled; Check Again counts them again. So is a database SQL Server would refuse:
one used for replication, one with a database snapshot (3709, `DEPENDENTS`), in an availability group, or mirrored, each a
blocking warning. The menu greys Detach… while the database is restoring, recovering or copying, and while it is suspect or
recovery pending (SQL Server's 3707 asks for EMERGENCY first). A database that is not online on a Windows server is Not ready
until its box is checked, Detach while offline (OFFLINE) or Detach anyway (EMERGENCY): SQL Server may leave a database
detached in those states with files no attach can open (critic A27; probed for both, OS error 5). On Linux the dialog only
says so. On Windows a SQL Server login also gets a note: SQL Server then lets only its service account open the detached
files (probed), so a Windows-authenticated attach fails and the attach should use SQL Server authentication.

Detach needs sysadmin or membership in the database's db_owner role (its owner is dbo), which DBCC DETACHDB checks: ALTER or
CONTROL on the database, ALTER ANY DATABASE and dbcreator pass SET OFFLINE's check but get 7983 (`PERMISSION_DENIED`) from
`sp_detach_db`, after Drop Connections would already have rolled everyone back. So the describe and the execute read the
permission first (sysadmin or ownership in master, db_owner membership inside an online database) and refuse the rest. Update
Statistics is greyed and cleared, and refused at execute, while the database is not online, read-only or in standby:
`sp_updatestats` raises 942 on an offline database, which aborts the detach, and 15635 on the others, which does not.

OK runs Close existing connections (`SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, only with Drop Connections), then Detach the
database (`sp_detach_db`, with `@skipchecks = 'false'` when Update Statistics is checked and `'true'` when it is not).
SQL Server can raise an error, or answer a Stop, after DBCC DETACHDB has detached the database: when the detach step fails
or is stopped and the database is gone from `sys.databases`, the step is done and the error is kept as a message. When
the detach fails or is stopped after SINGLE_USER and the database is still there, a compensation step gives it back the access it had:
Restore multi-user access, or Restore restricted user access for one that was RESTRICTED_USER; one already SINGLE_USER is
left so. SSMS's script leaves `@skipchecks` out when Update Statistics is cleared, which runs UPDATE STATISTICS anyway
(the procedure's default); Varia's Script Action writes `'true'`, with a comment saying why, so the script does what the
dialog does.

A success keeps the dialog open on its steps with Close focused. The reply lists the files left on the server (`filesKept`),
the Databases folder is listed again, so the node goes, the database's Database Properties documents on that connection
turn orphan ("This database no longer exists on <server>." with only Close), and a toast says "<name> was detached. Its
files stay on the server.", counts the query windows that were using it, and offers Copy paths. The connection forgets
the name as it does for a dropped database. Detach is offered on box SQL Server only (Managed Instance cannot run
`sp_detach_db`), greyed on SQL Server's own databases and absent on a snapshot; the backend re-derives every rule above
before it runs anything and refuses a database whose identity changed since the dialog read it.

### Rename of a database

F2 on a user database first reads its facts (`actions.describe` with `renameDatabase`, one of the fact describes, which
open no dialog): the preflight's refusals, the database's identity and user access, how many other sessions are in it and
how many of those hold an open transaction (with VIEW SERVER STATE, after the backend closed its own idle pooled connections
there, as the rename does), and how many logins have it as their default database. With no other session the rename runs
at once, `ALTER DATABASE … MODIFY NAME` alone. Otherwise the Rename Database confirmation (Confirmations, below) asks: Close Connections and
Rename sets `SINGLE_USER WITH ROLLBACK IMMEDIATE`, renames, and restores the access the database had (MULTI_USER, or
RESTRICTED_USER), the status bar saying "Closing connections" while it runs; Rename When Free runs MODIFY NAME alone, which
waits for the other sessions until they leave or Stop cancels it, the status bar saying "Waiting for connections to close"
(SQL Server 2025 queues MODIFY NAME behind them, probed; where SQL Server refuses it at once with 5030, as earlier versions are
recalled to, the backend tries it again each second until it completes or Stop); Cancel sends nothing. The prompt names Varia's own query
windows on the database whose session holds an open transaction (A7), through any connection the describe names as reaching
the same server (`SERVERPROPERTY('ServerName')`, whatever name each was opened with). From Enter the status bar shows the
rename ("Reading the database" during the describe) with Stop, which cancels the describe too. A database already in
single-user mode is renamed without setting it again, and only when no other session is in it: while one is, MODIFY NAME
fails with 924 and `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` waits for that session rather than closing it (both probed on
SQL Server 2025), so the describe refuses it with `IN_USE`, saying the session must disconnect or be ended in Activity
Monitor; where the sessions cannot be counted, its prompt offers Rename When Free only.

If the rename fails or is stopped after SINGLE_USER completed, Varia restores the access it changed, under the old name, or
under the new one when MODIFY NAME completed first, and only that: never another session's change. A rename that completed
before a later step failed still counts, and the message says what was left. After a rename, the database's query windows on
that server (through any connection to it), the home database of the connections opened in it (New Query on the server), and
its Database Properties documents follow the new name. MODIFY NAME gives the database a new `create_date` (sys.databases:
"created or renamed"), so the reply carries its identity under the new name, read just after, and a document with unsaved
changes takes it, so its Apply is not refused as another database's. When logins default to the old name a warning says how
many, since they cannot connect without naming a database until their defaults change.

Rename is greyed unless the database is online and read-write (MODIFY NAME checkpoints it: SQL Server answers 902 for a
read-only or standby database, probed), and F2 on a greyed one says why in a notice, as the command palette's greyed row does
(Take Offline and Bring Online likewise). It is refused on an availability group database,
and needs CONTROL SERVER, ownership, or ALTER on the database (`can_rename`): a dbcreator member with no user in the database is refused before
anything runs, because SQL Server refuses its MODIFY NAME with 916 (probed). Managed Instance renames, but cannot set
SINGLE_USER, so its prompt offers Rename When Free only. The backend refuses a database whose identity changed since the
describe read it.

The Table Designer (New › Table…) uses the same requests without being a dialog: `actions.describe` with
`tableDesigner` and a database, and the `createTable` action; its ids live in `src/shared/designer/catalog.ts`, and
[docs/table-designer.md](table-designer.md) describes them.

## Server file picker

`actions.describe` with `serverFiles`, the server as its target and a `files` member (`purpose`, `path`,
`allFiles`, `exists`) lists one folder on the server, or with no path the server's drives (/ on Linux) and its default
data, log and backup folders. With `exists` it checks one path instead, for a typed name the listing does not show (past
its limit or outside the type filter): the answer's entries hold that path's own entry, or none when it does not exist.
Paths are the server's, with its separator; SQL Server's service account must be able to read them.

| Purpose | Title | Files of type | Extensions |
| --- | --- | --- | --- |
| `backup` | Locate Backup File - <server> | Backup Files(*.bak;*.trn), All Files(*.*) | .bak, .trn |
| `database` | Locate Database Files - <server> | Database Data Files(*.mdf), All Files(*.*) | .mdf |
| `log` | Locate Database Files - <server> | Database Log Files(*.ldf), All Files(*.*) | .ldf |
| `folder` | Locate Folder - <server> | Folders only | — |

A listing reads one level: SQL Server 2017 and later through `sys.dm_os_enumerate_filesystem` (level 0, with sizes and
times), `sys.dm_os_file_exists` and `sys.dm_os_enumerate_fixed_drives`; SQL Server 2016 through `xp_dirtree`,
`xp_fileexist` and `xp_fixeddrives`, which list folders only to members of sysadmin and answer anyone else with
nothing, so that listing (and a check) carries the `legacyEmpty` notice. The path is a parameter of constant
statements, and the type filter runs in SQL before `TOP`, so a folder full of other files still lists its backups. A
missing folder, a file, or a path that is not a full path on that server is `PATH_NOT_FOUND`. Azure SQL Database and
Managed Instance are refused before connecting (`NOT_SUPPORTED`). Main's deadline for a listing is 15 s. Listings take
a gate of their own, one per server, so one stuck on an unreachable share never delays a dialog's describe.

The picker's titles, Files of type entries and field names (Select the file, Select the folder, Selected path, Files of
type, File name, Folder name) are SSMS's as recalled, not yet checked against SSMS 22.

## Confirmations

An action that asks first (A13) sends main a prompt id and bounded facts (`varia:confirm-action`); main checks them
(names up to 128 characters, counts up to 1,000,000, at most 8 query window names, no unknown members), writes
the message box from `src/shared/actions/prompts.ts` with names shown through `displayText`, and answers with the
chosen button's id; Escape, a closed box or a page that went away answers Cancel. The page can neither word a prompt nor
choose its default. Database Properties' Open Connections prompt keeps its own channel.

| Prompt | Title | Buttons | Example |
| --- | --- | --- | --- |
| `renameDatabase` | Rename Database | **Close Connections and Rename**, Rename When Free, Cancel | 3 connections are using Sales (2 query windows in Varia). Close them and rename the database? 1 session has an open transaction, which closing rolls back. Varia's query windows with open transactions: Query 1.sql. Rename When Free waits until they disconnect; Stop in the status bar ends the wait. |
| `disableLogin` | Disable Login | Disable, **Cancel** | Disable the login app_user? New connections will be refused. 2 sessions connected as this login stay connected until they end; Activity Monitor can end them. SQL Server Agent (MSSQLSERVER) runs as this account, and cannot connect while it is disabled. Varia's connection Reporting (sql01) signs in as this login, and cannot reconnect while it is disabled. |

The default button is bold. Rename Database defaults to Rename When Free where Varia may not close the connections, and
Disable Login to Cancel for a login a service runs as.

## Long runs

An action that changes a server for seconds or hours registers as a long run (`LongRunService`) while it runs. Until it
ends, closing the window is refused with a banner naming it and its server, Disconnect of its server and Restart SQL
Backend are refused with "<Run> is running on <server>. Stop it first.", and main's reload prompt names it first
(the page reports at most 16 runs, server names up to 256 characters, and counts the rest; `varia:long-runs`).
A run shown in a modal dialog (Create Catalog) repeats a refused close or Restart in that dialog, which covers the banner.
While the backend does not answer, the run cannot be stopped either, so Restart SQL Backend goes on to main's prompt,
which names the run it would stop part way.
A long run never holds the document task, so nothing waits for it silently; main's drain of a stopping backend stays the
last resort.

| Kind | Named as |
| --- | --- |
| `createCatalog` | Create Catalog |
| `newDatabase` | New Database |
| `attach` | An attach |
| `restore` | A restore |
| `verify` | A backup verification |
| `newLogin` | New Login |
| `backup` | A backup |
| `shrink` | A shrink |

Create Catalog, New Database and Attach Databases are the long runs so far; the others are reserved for the actions that will use them.

A short state action (a rename, a login's Disable and Enable) runs as a status-bar job instead: one per node, shown
with Stop after `statusDelayMs` ("Disabling app_user…", Stop disable), naming its step when it has several ("Renaming
Sales to Sales2: Closing connections…").

### Long actions and progress

An action marked long in the catalogue (a restore, a verify or a backup) takes the long gate instead of the execute gate:
1 per Varia connection and 2 in all. Another waits up to `gateWaitMs`, then answers `BUSY`
("Another restore or backup is running on this connection.", or "Restores or backups are already running on other
connections." when long actions elsewhere hold every slot), so a long run never blocks a rename or a delete.
Its steps run through a data reader, never `ExecuteNonQuery`, because SqlClient raises informational messages as they
arrive only for a reader: SQL Server's message 3211 ("n percent processed.", from `STATS`) becomes a droppable
`action.progress` EVENT `{step, percent}` at most every 250 ms, and is never one of the 32 messages the reply keeps.
Each step's start goes out at once as percent 0, and a percent the interval held back goes out when the interval ends (or
before the next step's start), so a step's last percent is not lost and a finished step never looks stuck while the next waits.
Main checks each EVENT and pushes `varia:actions-progress {requestId, step, percent}` only to the window that sent the request, at most 4 a
second: a new step at once, and the latest percent held inside the interval when it ends (`actionProgressRelay`); an
invalid EVENT is dropped, never a reason to stop the run. The page keeps
the latest percent per request (`ActionProgressService`) and draws it under the running step of its `StepList`; the
reply's steps carry the last percent each step reached as `progress`.

When the backend's generation is closed (a quit, a reload, Restart SQL Backend), it stops its long actions itself and
runs their cleanup steps within their budgets; main lets that generation run `stopGraceMs` plus the action's cleanup budget plus 5 s
before it kills it (`actionDrainMs`, methodPolicies' `drainMs`).

Long actions: Restore Database…, Restore Files and Filegroups….

## Database Properties

Database Properties opens as a document tab, one per database and connection (Properties on a database whose
document is open brings that tab forward). Its header names the server and the database, shows the database's
state in SMO's words ("Normal", "Restoring, Standby", "Normal, Read-Only"), and offers Refresh, Discard Changes and
Apply; Stop replaces them while the changes run. Its sections are SSMS's pages. General shows read-only facts as
text: backups, name, status, owner, date created, size, space available, number of users, memory-optimized memory and
collation. Files and Filegroups list the database's files and filegroups read-only in this version; Owner in Files is
editable (typed, suggested from the server's logins, or chosen in Select Database Owner). Options shows Collation,
Recovery model, Compatibility level and Containment type, then every option under its category: a boolean as a
switch, an enum of four values or fewer as a segmented control, a longer or server-supplied one as a list, a number as
a number field, and what Varia does not change as text. A row's whole description shows in a strip under the
sections while the pointer or focus is in the row, and as the label's tooltip; why a row is greyed and what is wrong
with a value show under it, and a section with a problem is marked in the list. Changed values are bold and say
"Changed" (part of the control's description for screen readers), and the tab shows unsaved changes.

Apply (also File › Save, Ctrl+S, and the close prompt's Save, which bring the document forward with its Stop) is
SSMS's OK that keeps the document open: it runs only the values that changed, reloads the Databases listing, and
reads the database again; if that read fails, the message says the changes were applied. File › Save All leaves the
document out, because its ALTER DATABASE can wait on locks. Refresh waits until the changes are applied or discarded.
When whether an Apply completed is unknown (the server or backend went, or Stop got no answer in time), the fields lock
until a Refresh, and the message says to Discard Changes, then Refresh. The Script drawer previews what Apply would
run while it is open,
once typing pauses; with nothing changed it says "There is no action to be scripted." A snapshot, a database that is not online or
not accessible, a database the login may not ALTER, and Azure SQL Managed Instance open read-only with a note.
Compatibility level is greyed for a login outside sysadmin (SSMS ignores the change silently), and Containment type
when the server's contained database authentication is off. The owner of master, model, tempdb cannot change.
On a read-only database only Database Read-Only and Restrict Access change, and the owner is greyed. Turning Database
Read-Only on cannot share an Apply with a change SQL Server applies after it and refuses on a read-only database (the
"Read-only" column below, and the owner): SSMS would leave the database read-only with that change failed, so Varia
says why and runs nothing.

Compatibility levels offered: SQL Server 2008 (100), SQL Server 2012 (110), SQL Server 2014 (120), SQL Server 2016 (130), SQL Server 2017 (140), SQL Server 2019 (150), SQL Server 2022 (160), SQL Server 2025 (170), up to the server's own.

### Database options

"Exclusive": SSMS closes other connections to change it. "Read-only": SQL Server refuses the change on a read-only
database (3906, or 5073 for COLLATE; measured on SQL Server 2025). "Not on": system databases SQL Server refuses it on
(Learn's master, model, msdb and tempdb pages). "Since": the version band (13 = SQL Server 2016, 17 = 2025).

| Option | Category | Settable | SQL | Exclusive | Read-only | Since | Not on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Collation | Header | Yes | `COLLATE` |  | Yes |  | master, model, msdb, tempdb |
| Recovery model | Header | Yes | `RECOVERY` `FULL`, `BULK_LOGGED`, `SIMPLE` |  |  |  | tempdb |
| Compatibility level | Header | Yes | `COMPATIBILITY_LEVEL` |  | Yes |  |  |
| Containment type | Header | Yes | `CONTAINMENT` `NONE`, `PARTIAL` |  |  |  | tempdb |
| Auto Close | Automatic | Yes | `AUTO_CLOSE` `ON`, `OFF` |  |  |  | master, tempdb |
| Auto Create Incremental Statistics | Automatic | Yes | `AUTO_CREATE_STATISTICS` |  |  |  |  |
| Auto Create Statistics | Automatic | Yes | `AUTO_CREATE_STATISTICS` |  |  |  |  |
| Auto Shrink | Automatic | Yes | `AUTO_SHRINK` `ON`, `OFF` |  |  |  | master, tempdb |
| Auto Update Statistics | Automatic | Yes | `AUTO_UPDATE_STATISTICS` `ON`, `OFF` |  |  |  |  |
| Auto Update Statistics Asynchronously | Automatic | Yes | `AUTO_UPDATE_STATISTICS_ASYNC` `ON`, `OFF` |  |  |  |  |
| Default Fulltext Language LCID | Containment | No |  |  |  |  |  |
| Default Language | Containment | No |  |  |  |  |  |
| Nested Triggers Enabled | Containment | No |  |  |  |  |  |
| Transform Noise Words | Containment | No |  |  |  |  |  |
| Two Digit Year Cutoff | Containment | No |  |  |  |  |  |
| Close Cursor on Commit Enabled | Cursor | Yes | `CURSOR_CLOSE_ON_COMMIT` `ON`, `OFF` |  |  |  |  |
| Default Cursor | Cursor | Yes | `CURSOR_DEFAULT` `GLOBAL`, `LOCAL` |  |  |  |  |
| FILESTREAM Directory Name | FILESTREAM | No |  |  |  |  |  |
| FILESTREAM Non-Transacted Access | FILESTREAM | Yes | `FILESTREAM( NON_TRANSACTED_ACCESS = … )` | Yes | Yes |  |  |
| Is Ledger Database | Ledger | No |  |  |  | 16 |  |
| Allow Snapshot Isolation | Miscellaneous | Yes | `ALLOW_SNAPSHOT_ISOLATION` |  |  |  | master, msdb |
| ANSI NULL Default | Miscellaneous | Yes | `ANSI_NULL_DEFAULT` `ON`, `OFF` |  |  |  |  |
| ANSI NULLS Enabled | Miscellaneous | Yes | `ANSI_NULLS` `ON`, `OFF` |  |  |  |  |
| ANSI Padding Enabled | Miscellaneous | Yes | `ANSI_PADDING` `ON`, `OFF` |  |  |  |  |
| ANSI Warnings Enabled | Miscellaneous | Yes | `ANSI_WARNINGS` `ON`, `OFF` |  |  |  |  |
| Arithmetic Abort Enabled | Miscellaneous | Yes | `ARITHABORT` `ON`, `OFF` |  |  |  |  |
| Concatenate Null Yields Null | Miscellaneous | Yes | `CONCAT_NULL_YIELDS_NULL` `ON`, `OFF` |  |  |  |  |
| Cross-database Ownership Chaining Enabled | Miscellaneous | No |  |  |  |  |  |
| Date Correlation Optimization Enabled | Miscellaneous | Yes | `DATE_CORRELATION_OPTIMIZATION` `ON`, `OFF` | Yes | Yes |  |  |
| Delayed Durability | Miscellaneous | Yes | `DELAYED_DURABILITY` `DISABLED`, `ALLOWED`, `FORCED` |  | Yes |  |  |
| Is Read Committed Snapshot On | Miscellaneous | Yes | `READ_COMMITTED_SNAPSHOT` `ON`, `OFF` | Yes |  |  | master, msdb, tempdb |
| Numeric Round-Abort | Miscellaneous | Yes | `NUMERIC_ROUNDABORT` `ON`, `OFF` |  |  |  |  |
| Parameterization | Miscellaneous | Yes | `PARAMETERIZATION` `SIMPLE`, `FORCED` |  |  |  |  |
| Quoted Identifiers Enabled | Miscellaneous | Yes | `QUOTED_IDENTIFIER` `ON`, `OFF` |  |  |  |  |
| Recursive Triggers Enabled | Miscellaneous | Yes | `RECURSIVE_TRIGGERS` `ON`, `OFF` |  |  |  |  |
| Trustworthy | Miscellaneous | No |  |  |  |  |  |
| VarDecimal Storage Format Enabled | Miscellaneous | No |  |  |  |  |  |
| Page Verify | Recovery | Yes | `PAGE_VERIFY` `CHECKSUM`, `TORN_PAGE_DETECTION`, `NONE` |  |  |  |  |
| Target Recovery Time (Seconds) | Recovery | Yes | `TARGET_RECOVERY_TIME` `n SECONDS` |  | Yes |  |  |
| Broker Enabled | Service Broker | Yes | `ENABLE_BROKER`, `DISABLE_BROKER` |  |  |  | master, model |
| Honor Broker Priority | Service Broker | No |  |  |  |  |  |
| Service Broker Identifier | Service Broker | No |  |  |  |  |  |
| Database Read-Only | State | Yes | `READ_ONLY`, `READ_WRITE` | Yes |  |  | master, tempdb |
| Database State | State | No |  |  |  |  |  |
| Encryption Enabled | State | No |  |  |  |  |  |
| Restrict Access | State | Yes | `MULTI_USER`, `RESTRICTED_USER`, `SINGLE_USER` | Yes |  |  | master, tempdb |
| Legacy Cardinality Estimation | Database Scoped Configurations | Yes | `SET LEGACY_CARDINALITY_ESTIMATION` |  | Yes | 13 |  |
| Legacy Cardinality Estimation for Secondary | Database Scoped Configurations | Yes | `FOR SECONDARY SET LEGACY_CARDINALITY_ESTIMATION` |  | Yes | 13 |  |
| Max DOP | Database Scoped Configurations | Yes | `SET MAXDOP` |  | Yes | 13 |  |
| Max DOP for Secondary | Database Scoped Configurations | Yes | `FOR SECONDARY SET MAXDOP` |  | Yes | 13 |  |
| Parameter Sniffing | Database Scoped Configurations | Yes | `SET PARAMETER_SNIFFING` |  | Yes | 13 |  |
| Parameter Sniffing for Secondary | Database Scoped Configurations | Yes | `FOR SECONDARY SET PARAMETER_SNIFFING` |  | Yes | 13 |  |
| Query Optimizer Fixes | Database Scoped Configurations | Yes | `SET QUERY_OPTIMIZER_HOTFIXES` |  | Yes | 13 |  |
| Query Optimizer Fixes for Secondary | Database Scoped Configurations | Yes | `FOR SECONDARY SET QUERY_OPTIMIZER_HOTFIXES` |  | Yes | 13 |  |

### Statement order

Script and OK write SSMS's statements in SSMS's order (SMO's Database.ScriptAlter, then SSMS's own steps):

1. One ALTER DATABASE per changed option in SMO's order: containment, compatibility level, collation, then the SET
   options (WITH NO_WAIT, or WITH ROLLBACK IMMEDIATE when other connections are closed), then the scoped
   configurations in the database (`USE [db]`, then `ALTER DATABASE SCOPED CONFIGURATION …`).
2. `ALTER DATABASE … SET ALLOW_SNAPSHOT_ISOLATION`, as SSMS's SetSnapshotIsolation.
3. The owner: `ALTER AUTHORIZATION ON DATABASE::[db] TO [login]` in the database.

Each statement is one step; the first failure stops the rest, which are skipped. Statements are built by SQL Server
from constant text: names through `QUOTENAME`, numbers through `CONVERT` of range-checked parameters, keywords only
from this catalogue, and a collation only as `sys.fn_helpcollations()` names it.

### Open Connections

When Apply changes an exclusive option and the database has sessions (or they cannot be counted), Varia asks "To change the database properties, SQL Server must close all other connections to the database. Are you sure you want to change the properties and close all other connections?"
(Yes or No; No is the default, because Yes rolls back the other sessions' transactions, and Escape answers No).
No runs nothing. Yes writes the SET options WITH ROLLBACK IMMEDIATE. SSMS counts the connections when OK is pressed, so
the backend counts them again before anything runs: when sessions have joined since the document read none, it
answers `IN_USE` at once and the document asks. The backend first closes its own idle pooled connections in the database
and, because SQL Server lists their sessions for a few milliseconds after that, counts again every 50 ms for up to a
second while the count is above zero. Without the prompt, WITH NO_WAIT makes SQL Server refuse (`IN_USE`)
rather than wait for the other sessions' transactions; SQL Server gives up after about 20 seconds. That failure advises
choosing Yes only after an exclusive change made without closing connections; otherwise (Broker Enabled or Containment
type with other sessions, which SSMS does not close connections for) it advises closing them first. Script never
asks: it always writes WITH NO_WAIT, as SSMS does.

## New Database

A server action makes something on the server rather than acting on an object row, so no row offers it and no
`explorerAction*` key gates it: its item reads the node it is on, and its describe's target is the server.

| Action | Menu title | Command | Document | On | Group | Mnemonic | Servers | Long run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createDatabase` | New Database… | `explorer.newDatabase` | `newDatabase` | the `databases` folder, a `database` node | `0_new` 1; on a node, `1_query` 1, as the menu-only `explorer.newDatabaseOnDatabase` | n | SQL Server | `newDatabase` |

New Database opens as a document tab (`newDatabase`, never dirty and never in Save All; Cancel, Escape or closing it
discards it, as SSMS's Cancel does, and Save (Ctrl+S), or Enter outside its grids, is OK). A second one open is titled
New Database (2), and so on. Its describe reads model as Database Properties reads it (a new database starts as a copy of
model), the instance's default data and log folders, the server's collation, whether the login may create a database,
master's compatibility level and the platform. The document sends the files, filegroups, collation, containment and
ledger, and only the options and scoped configurations that differ from model: Script writes those, never every option as
SSMS does. A file's default name is its logical name with .mdf, .ndf or .ldf, made safe for the server's platform
(critic A23); a FILESTREAM or memory-optimized container is a folder named after it and grows as it needs. SQL Server on
Linux has no FILESTREAM, so its filegroups are not offered there.

OK runs the steps "Create the database", then Database Properties' own ALTER steps for the options (titled by option),
the filegroup changes (Autogrow all files, Set the default filegroup, Make the filegroup read-only) and "Set the owner".
A failure after CREATE leaves the database, as SSMS does, and the steps say what completed. OK registers the
`newDatabase` long run while it runs, and Stop cancels the running statement. On success the document closes, Object
Explorer reloads the Databases folder (the one above System Databases, when it was opened on a system database) and
selects the new database, and the toolbar's database list refreshes.

The builder has SQL Server compose CREATE DATABASE from one JSON parameter: names through `QUOTENAME`, file names and
paths as N'' literals quoted on the server (`REPLACE` under `Latin1_General_BIN2`), sizes through `CONVERT` of typed
numbers (in KB up to 2,097,151 MB, as SQL Server reads a size as an int, and in MB above), the collation only as
`sys.fn_helpcollations()` names it, files joined without `STRING_AGG`, and one execution
form, `EXEC @module @stmt` with `@module = QUOTENAME(@db) + N'.sys.sp_executesql'`. Before it, the preflight refuses a
name in use, a login without CREATE ANY DATABASE, a missing owner or collation, a folder that does not exist or a file
that does (from SQL Server 2017, through `sys.dm_os_file_exists`), FILESTREAM where it is off, ledger before SQL Server
2022, and Partial containment without contained database authentication. `CreateDatabaseSql.Lint` checks the builder
with the table designer's OPENJSON rules (`JsonBuilderLint`): every column a number or `nvarchar(max)`, text only inside
`QUOTENAME` (or the quoted-literal form), and JSON columns only into the arrays it shreds again.

## Attach Databases

Databases › Attach… opens Attach Databases, a modal dialog, on SQL Server's box editions only (Managed Instance and Azure SQL
Database have no attach). It opens with the server's logins for Owner and its default data folder; Add… opens the server
file picker (Locate Database Files, Database Data Files(*.mdf)), then `actions.describe` with `attachDatabase` and `attach: { mdf }`
reads the file with `DBCC CHECKPRIMARYFILE (@mdf, 0)`, `(@mdf, 2)` and `(@mdf, 3)`: whether it is a primary data file, its
database's name and version, and the files it records (a log by status 0x40). The path is a bound parameter; nothing
is built as text, and the result sets are read in the backend. Each recorded file on the server's own disks is checked as
the picker checks a path (`sys.dm_os_file_exists`, or `xp_fileexist` on SQL Server 2016, which answers only sysadmin); a
share or device path the file records is never probed, since SQL Server's service account would sign in to that host, so
its existence is unknown until the user checks it or OK runs. The .mdf's own row takes the path that was added. A file
that is in use (an attached database's) cannot be read, and the error says so. A database newer than the server (its
version above master's, `DATABASEPROPERTYEX(N'master', 'Version')`, the catalog lint's one exception) is refused with
`NOT_SUPPORTED`: SQL Server's own refusal, 948, is severity 20 and ends the session. Add's read waits on the file system,
so it takes the picker's gate, not the describe gates.

Each database row has Attach As (its database name by default), Owner (`<default>`: the attaching login), Status and
Message; its details list Original File Name, File Type, Current File Path (typed, or chosen with "…", and checked again
on Enter or when the field is left) and Message ("Not found"). OK is disabled while a data file is not found or a typed
one is not yet checked, and while Add… reads a file or a path is checked. Remove takes a log file out: with every log file
removed, SQL Server rebuilds the log (`FOR ATTACH_REBUILD_LOG`), which breaks the log backup chain, needs the database to
have been shut down cleanly, and needs every data file.

OK first checks, in the action's connection, that no database has the name, that the owner's login exists, that the login
may create databases, that master's compatibility level is 130 or more (OPENJSON), and that the primary file is not newer
than the server (its version read again). Then, per database, "Attach the
database" (`CREATE DATABASE [name] ON ( FILENAME = N'…' ), … FOR ATTACH`, or `FOR ATTACH_REBUILD_LOG`), and with an owner
"Set the database owner" (`ALTER AUTHORIZATION ON DATABASE::[name] TO [login]` in the database, as Database Properties
writes it; SSMS uses the deprecated `sp_changedbowner`). SQL Server builds the CREATE DATABASE from two parameters:
the name, through `QUOTENAME`, and one JSON array of paths, each quoted on the server (`REPLACE` of `'` in a binary collation), joined in order
without `STRING_AGG` (SQL Server 2016), and the keyword chosen from two constant batches. When a later step fails or Stop
ends one, "Detach the database again" (`sp_detach_db` with `@skipchecks = 'true'`) undoes each attach this OK made
(and one Stop reached after SQL Server finished it, found by its name and primary file),
newest first, so its row reads Rolled Back, as SSMS's does. Script Action writes the same statements and runs nothing.
An attach is a long run: while it runs, closing the window, disconnecting its server and Restart SQL Backend are refused.

Its labels (Databases to attach, MDF File Location, Database Name, Attach As, Owner, Status, Message, Add…, Remove,
"<name>" database details, Original File Name, File Type, Current File Path, Not found) are SSMS's as recalled, not yet
checked against SSMS 22.

## Restore Database

Restore Database is a document tab ("Restore Database - <database>") with SSMS's pages as sections
(General, Files, Options), the Select backup devices and Backup Timeline sub-dialogs, and a Script
drawer. The Databases folder's Restore Database… (R) and a user database's Tasks › Restore › Database… (D) open it, on
SQL Server itself (not Azure SQL Database or Managed Instance); from a database, that database is the source. Its header
verbs are Refresh and Restore, and Stop while it runs (catalogue commands, so the palette offers them too).

Its reads are `actions.describe` with `restoreDatabase`, the server as its target and a `restore` member, one of
`history`, `devices`, `historyFiles`, `mediaFiles`:

| Source | Reads |
| --- | --- |
| `history` | msdb's history: the databases it has backups of, and with `database` that database's newest sets with their media (disk files only) |
| `devices` | `RESTORE LABELONLY` on each backup file, which groups them into media sets, then `RESTORE HEADERONLY` on each media set |
| `historyFiles` | One history set's files from msdb's `backupfile` |
| `mediaFiles` | `RESTORE FILELISTONLY` on one media set at one position |

Every answer also carries the server's facts: its path separator, default data, log and backup folders, whether the
login may restore, the databases a restore could replace and the files other databases hold. SQL Server 2016 and 2017
have no default backup folder (`InstanceDefaultBackupPath` came with 2019), so their backup folder is the default data
folder; SSMS reads the registry's BackupDirectory instead, which Varia's constant reads cannot. Statements are constant
(`Actions/RestoreSql.cs`), with every name, path and position a parameter. A restore describe takes a gate of its own,
2 per connection and outside the object actions' read gates, because SQL Server ends a read of a file on an
unreachable share only when the file call returns (about 21 s per file): a media read past its budget then still holds
its gate, and never one Database Properties or Delete Object waits for. Its budget is 120 s, and main's deadline is 130 s.
A device SQL Server cannot open is `PATH_NOT_FOUND` when its operating system error says the file or path is not
there (2, 3, 53, 67, 123, 161), and `FILE_ACCESS` otherwise (access denied, a file another program holds); media a
restore cannot use (another program's, a damaged or incomplete set) is `MEDIA`. Azure SQL Database and Managed Instance
are refused before connecting (`NOT_SUPPORTED`).

### Plan

The planner (`src/shared/actions/restore-plan.ts`) chooses only full, differential, transaction log backups that are on disk and not damaged;
the grid still lists the other kinds it reads, unchecked, with checkboxes disabled and the reason as their description:

| Set type | Component | Type | Planned |
| --- | --- | --- | --- |
| `full` | Database | Full | Yes |
| `differential` | Database | Differential | Yes |
| `log` | Database | Transaction Log | Yes |
| `file` | File | Full | No |
| `fileDifferential` | File | Differential | No |
| `partial` | Partial | Full | No |
| `partialDifferential` | Partial | Differential | No |

It builds each plan backwards from its end, as SMO does. For the last backup taken, it starts from the newest backup
and goes back through the logs it continues to the latest differential (with its full) or full. For a point in time
(STOPAT, the server's local time) it takes the latest full and differential that finished by the point when one ends
there; otherwise the first log that finished at or after the point, back through sets that finished by it. A copy-only
log never joins a chain. A log continues a set only on its recovery fork: after a restore to a point in time, the next
log starts on the old fork and forks inside itself, so it continues only a set that ends by its fork point, and the
abandoned branch's logs never join a plan (`tests/fixtures/restore/smo-fork.json`, which the live checks record and
restore). Sets of another database (`family_guid`) never chain, and Source › Device lists one database the media hold
at a time (Source › Device › Database, the first one by default). SMO's `DatabaseRestorePlanner`, which SSMS uses,
chooses the same sets in every case but one: for a point between
the last log before a differential and that differential, SMO restores the differential, which no STOPAT can undo, so
the database comes back as at the differential. Varia restores the logs instead (`tests/fixtures/restore/smo-plans.json`
records both plans; the live checks restore each).

The grid's checkboxes take clicks only while Manual Selection is checked; unchecking a set also unchecks every set
after it in the plan, as SSMS does, and unchecking Manual Selection brings the planner's plan back. Sets that do not chain say "The selected backup sets do not form a valid restore plan."
A set the planner never uses keeps its checkbox disabled, with the reason as its description and the row's tooltip:
not on a disk file, "This backup set is marked damaged.", "A copy-only log backup is not part of the log chain." or "File and partial backups restore with T-SQL."
A point in time the checked sets cannot stop at says "The checked backup sets do not reach the point to restore to: check the log backup that covers it, or restore to the last backup taken."
Until the plan's full backup's files are read, Script waits: "The files of the full backup to restore are not read yet."

The Backup Timeline shows the backups over an interval (Hour, Six Hours, Day, Week; Day first) ending at the last
backup: a large triangle for a full backup, a small one for a differential, a tick for a log, and a band where log
backups cover. Its point is a slider: the arrow keys move it a minute, Shift and an arrow or Page Up and Page Down an
hour, Home and End to the interval's ends. A point outside the covered band (other than a full or differential
backup's finish) leaves OK disabled. SSMS also allows a point after the last log backup, restoring the tail-log backup
it takes first; Varia refuses such a point (a known gap: restore to the last backup taken, or past it in T-SQL).

### Options and script

Recovery state is one of RESTORE WITH RECOVERY, RESTORE WITH NORECOVERY, RESTORE WITH STANDBY. Restoring over the database the
backups came from takes a tail-log backup first by default (BACKUP LOG … WITH NORECOVERY into the default backup folder,
`<database>_LogBackup_<yyyy-MM-dd_HH-mm-ss>.bak`); a copy under another name moves its files to the default data and
log folders under its own name, or to the folders Relocate all files to folder names. A Restore As path that another
database holds, or that two files share, is marked on the Files section: the Files section compares paths as the
server's platform does (exactly on Linux), while main and the backend refuse two files on one path ignoring case on
every platform, so on Linux two files whose paths differ only in case cannot restore together (a known limit).

Script (`actions.script` with the `restore` action) is written from the request and the catalogue, on no connection, and
stops once it passes 4,000,000 characters ("The script is too large"). It writes what SMO's restore plan scripts for the same choices:
`USE [master]`, `ALTER DATABASE … SET SINGLE_USER WITH ROLLBACK IMMEDIATE` when Close existing connections is checked
and the destination exists, the tail-log backup, one RESTORE per set (`FILE =`, `MOVE`, `REPLACE`, `KEEP_REPLICATION`, `RESTRICTED_USER`,
`NORECOVERY` or `STANDBY`, `STOPAT`, `NOUNLOAD`, `STATS = 5`), `SET MULTI_USER` after it, and `GO`. Live checks compare
the text with SMO's `Script()` for hostile names and paths; Varia writes two spaces after SET (`SET  SINGLE_USER`), as its
other database options do, where SMO writes one.

### Run

Restore (SSMS's OK) reads the server again, then asks in the document when a fact calls for it, Restore first and Cancel
last, the default (focused, drawn as the default, and Escape's answer; Restore is disabled while the bar asks):
REPLACE over an existing database (which is left restoring if the run stops or fails part way, and whose contents are
lost outright when it is not the database the backups are of: another name, or the same name with another recovery
family, from another server or an earlier database of that name), a tail-log backup that could be taken but is off, and
Close existing connections, with the sessions it ends, those with open transactions it rolls back, and Varia's own
query windows in the database that are running or may hold one. Only an online database has connections to close, so
the option is disabled, and not sent, for any other. SSMS asks none of these. It then runs `actions.execute`
with the same request Script takes, as a long run (closing the tab or the window, Disconnect of the server and Restart
SQL Backend are refused until it ends: Stop it first) on the long gate, and the Run panel lists its steps with the running
RESTORE's STATS percent (`action.progress`), an overall percent (the sets done and the running set's percent, each set
alike) and the time. Answering the bar moves focus to the Run panel's title (Restore, Stop) or back to the verb (Cancel,
Keep restoring).

The backend first checks what the request names, on the action's own connection: the destination's identity (an
existing database must be the one the document read), a snapshot or a database without RESTORING rights, whether the
tail-log backup can be taken, Close existing connections over a database that is not online (`DATABASE_UNAVAILABLE`),
each set's header on the media (`RESTORE HEADERONLY`: its type, family, and that it continues the set before it;
`RestoreChain`), REPLACE over another database's backups (`BACKUP_MISMATCH`), and the files the restore writes
(`NAME_IN_USE`): the first set's `RESTORE FILELISTONLY` with the Restore As paths gives each file's path, which must be no
other database's file and, unless it is a file of the destination, no file already on the server; a standby file or
tail-log backup must be no database's file and have no database file's extension. Paths compare by a key
(`ServerPath.Key`, `serverPathKey` in the renderer, both checked against `tests/fixtures/server-paths.json`): `.` and
empty segments dropped, `..` resolved, and on Windows `/` as `\`, trailing dots and spaces trimmed, and case ignored.
Files on disk are seen through `sys.dm_os_file_exists` (SQL Server 2017 and later) or `xp_fileexist` (2016, sysadmin
only; otherwise not checked). Then the steps, each its own statement with every name, path and number a parameter
(`RestoreSql`):

| Step | When |
| --- | --- |
| Close existing connections | Close existing connections is checked and the destination exists (`SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, after Varia's own pooled sessions in it are cleared) |
| Back up the tail of the log | The tail-log backup is on (`BACKUP LOG … TO DISK = … WITH NORECOVERY` when Leave source database in the restoring state is checked) |
| Restore the full backup, Restore the differential backup, Restore log backup (n of m) | One RESTORE per set of the plan, NORECOVERY on all but the last |
| Restore multi-user access | After a RECOVERY restore that closed connections, unless Restrict access is checked |
| Bring the database back online | Cleanup: the tail-log backup left the database restoring (it ended, or a Stop came as it finished), no RESTORE has written to it, and it is still RESTORING with the id the preflight read (`RESTORE DATABASE … WITH RECOVERY`) |
| Restore multi-user access | Compensation: connections were closed and no RESTORE has written to the database (its access as it was: multi-user or restricted) |
| Remove the partly restored database | Cleanup: the destination did not exist, and a RESTORE left it RESTORING; dropped only when its name, state 1 and an id absent at the preflight all match, which the DROP's own batch checks again. Its files are read first, and checked on disk after the DROP |

After a failure or Stop the compensations and the cleanup run in order under a fresh 30 s budget, and are listed only
when they run. Varia never drops a database that existed (owner decision 5). Stop cancels the running statement in SQL
Server; over a database that existed it asks first ("Stopping leaves <database> restoring and unusable until a restore
finishes", Stop first and Keep restoring last, the default). A refusal SQL Server makes while it plans a RESTORE (3101, 3154, 3159, 3201, 4305…)
has not written to the database, so the compensations still run. The reply lists the steps, and the database's state and
access as the run left it (`restored`: `sys.databases` read last; the access comes from the backup), or `absent` when no
database has the name, or nothing when it could not be read (the panel then says to check Object Explorer). A Stop that
came as the last RESTORE WITH RECOVERY reached 100 % and left the database online says it was restored. SQL Server leaves
the files of a cancelled RESTORE on disk even when the partly restored database is dropped: `restored.filesLeft` names
them (at most 16), the error and the cleanup step say to delete them or restore to other paths, and the
next restore to those paths is refused until then. A Stop or an unknown outcome shows as a status in the warning tone, a
failure as an error. The Databases folder is reconciled once the run ends, and Restore again keeps the choices. A run
whose backend or server is lost, or whose reply main stopped waiting for, says that how far it got is not known.

SQL Server's own databases (master, model, msdb, tempdb) are refused as destinations, in any case (MSDB too): "Restore system databases with T-SQL; it needs single-user mode or a stopped Agent."
Their backups can still be sources, restored under another name (msdb_copy), as SSMS allows.
Prompt before restoring each backup and Verify Backup Media are greyed ("Not yet available").

The labels (General, Files and Options; Source, Device, Destination, Restore to, Timeline…, Backup sets to restore and
its columns, Manual Selection; Relocate all files to folder, Data file folder, Log file folder, Restore the database
files as, Restore As; the restore options, Tail-Log
backup, Server connections and Prompt; Select backup devices; Backup Timeline) are SSMS's as recalled, not yet checked
against SSMS 22.

### Restore Files and Filegroups

Restore Files and Filegroups (D1g) restores some files of an existing database: the Databases folder's Restore Files and
Filegroups… (E) and a user database's Tasks › Restore › Files and Filegroups… (F) open the same document in its files mode
("Restore Files and Filegroups - <database>"), with SSMS's pages as sections (General, Options), and the same
describes, Script drawer, verbs, Run panel, Stop and long run as Restore Database. General has To database (the server's
user databases), Source for restore (From database, whose backups msdb has, or From device, whose … opens Restore Database's
Select backup devices titled Specify backup devices, Learn's name for it in this dialog), and Select the backup sets
to restore: the files of the newest 16 full and file backups (msdb's `backupfile` or FILELISTONLY, read one describe after
another; files a file backup does not hold (`absent`: `is_present` 0) and log files are not listed), then the log backups
that continue the backup set of the checked rows, checked with them and never alone (copy-only and damaged logs never
chain). One restore restores from one backup set: checking a row of another set starts again from it. Options has Restore
as filegroup (the rows become filegroups, named with FILEGROUP =, and a Filegroup column first shows each row's name),
Overwrite the existing database (WITH REPLACE), Prompt before restoring each backup (greyed, with a note saying why, as every
greyed option has), Restrict access to the restored database (WITH RESTRICTED_USER), Restore the
database files as (Original File Name, File Type and Restore As, for the restored files, where they are unless typed), the
Recovery state with SSMS's long labels ("Leave the database ready for use by rolling back the uncommitted transactions. Additional transaction logs cannot be restored. (RESTORE WITH RECOVERY)"…) and Rollback undo file, and Varia's own
Log backup group.

Under the full or bulk-logged recovery model an online file restore ends only with a log backup taken after it (probed on
2025: the files stay RESTORING after every earlier log, "Additional roll forward past LSN … is required"). SSMS's dialog
has no such step and leaves the person to take and restore one; Varia offers "Back up the log and restore it to bring the
files online (WITH COPY_ONLY)", checked by default for an online database in the full or bulk-logged recovery model WITH
RECOVERY, to a new file named as SSMS names a tail-log backup. Unchecked there, Restore asks first ("No log backup is
taken: under the full or bulk-logged recovery model, restored files stay restoring until a log backup taken after they are restored is restored."), as it does for WITH REPLACE. STANDBY
is greyed while the database is online: SQL Server refuses it on an online file restore (4302), and only after the files
are restored, so the preflight refuses it first.

A file of the PRIMARY filegroup restores only offline: on an online database it puts the whole database in RESTORING, and
with WITH REPLACE it restores the log file too, so the changes since the last log backup are lost and the database cannot
recover (probed on 2025: 4303, then 927 for a tail-log backup). Varia greys PRIMARY's rows while the database is online or
offline, with the reason under the grid ("A file of the PRIMARY filegroup restores only offline, which takes the whole database out of use and, without a tail-log backup, loses the changes since the last log backup: restore the database with Restore Database, which backs up the tail of the log first."), and the preflight refuses them (`NOT_SUPPORTED`);
they restore only into a database already restoring. Restore Database restores PRIMARY with its tail-log backup first.

Under the full or bulk-logged recovery model the plan must reach the database's log chain: its last set must end at or
after `sys.database_recovery_status.last_log_backup_lsn`, where the next log backup starts (a copy-only log backup leaves it).
A regular log backup taken after the plan's last set (a maintenance job, media not added under From device, or one taken
after the document read msdb) would leave the restored files waiting for it, and Varia's copy-only backup would not continue
them (4305). The preflight refuses such a plan before any statement (`RESTORE_SEQUENCE`, "The log has been backed up since the last backup set this restore plans, and restored files roll forward only through every log backup: Refresh to read the backup history again, or add the files of the newer log backups under From device."),
naming the newest log backup from msdb (when it finished and its file) where the login may read msdb. Back up the log reads
the chain again before it runs: a log backup taken during the restore fails that step with the same naming
("The log was backed up during the restore, so a log backup taken now would not continue the restored files: restore that log backup, then back up the log and restore it WITH RECOVERY to bring the files online."), before the doomed backup and restore.

The request (`restoreFiles`) names the sets (a full or file backup, then logs), the files and filegroups (each at most
256), the moves, the options and the log backup. A file restore takes no STOPAT and no differential, and its
database must exist, so its identity is required. The backend's preflight checks the identity and that it is no snapshot;
the log backup (not under SIMPLE, and only online); STANDBY online; the chain on the media (`RestoreChain`, files variant);
that the backups are the database's own (its backup family, else its name; `BACKUP_MISMATCH`, "These backups are of another database: files restore only from the database's own backups.");
that the plan reaches the log chain; that each file and filegroup is in the set, held by it, no log file and, online or
offline, not of PRIMARY; under SIMPLE, Learn's rule
("Under the simple recovery model, the file must belong to a read-only filegroup.", `NOT_SUPPORTED`, from `sys.master_files.is_read_only`); and the files it writes, as Restore
Database's does, with the log backup file new. The steps, each its own statement with every name a parameter
(`FILE = @f1`, `FILEGROUP = @g1`; live checks restore hostile names):

| Step | When |
| --- | --- |
| Restore the files | `RESTORE DATABASE … FILE = … FILEGROUP = … FROM … WITH FILE =`, the moves, `NORECOVERY` (or the recovery state when it is the last statement), `REPLACE`, `RESTRICTED_USER`, `STATS = 5` |
| Restore log backup (n of m) | One `RESTORE LOG` per log backup after the set |
| Back up the log | The log backup is on: the log chain read again, then `BACKUP LOG … TO DISK = … WITH COPY_ONLY, NOFORMAT, NOINIT, NAME = …` |
| Restore the log backup | Then `RESTORE LOG` from that new file WITH RECOVERY, which brings the restored files online |

A file restore has no compensation or cleanup, and Varia never drops the database; Stop asks first ("Stopping leaves the
files being restored in <database> restoring…"). The reply names the files still RESTORING (`restored.filesRestoring`, by
logical name, at most 16), and the Run panel says so. Script writes the statements SMO's `Restore { Action = Files }` writes,
with `STATS = 5` as Restore Database's (SMO scripted 10 as the spec captured it), and the log backup's two statements
after the logs.

### Restore limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `mediaReadMs` | 120,000 | The backend's budget for one restore describe, in ms (LABELONLY and HEADERONLY on a large striped set or a slow share); then `TIMEOUT` |
| `describeDeadlineMs` | 130,000 | Main's deadline for a restore describe, in ms: the budget and time to answer |
| `mediaReadsPerConnection` | 2 | Restore describes one connection runs at once, under their own gate outside the object actions' read gates |
| `backupDevices` | 64 | Backup files one describe or restore names (a media set's families) |
| `historyDatabases` | 1,024 | Databases msdb's history lists; more set `historyTruncated` |
| `historySets` | 1,024 | The newest backup sets one database's history, or the media, lists; more set `setsTruncated` |
| `planSets` | 1,024 | Backup sets one restore runs: as many as the history lists (each RESTORE is a statement of its own) |
| `restoreMoves` | 1,000 | Files one restore moves (64 devices and 2 × 1,000 MOVE parameters stay under SQL Server's 2,100) |
| `destinations` | 4,096 | Destination names and other databases' files read for Restore As collisions; more set a truncation flag |
| `serverFiles` | 8,192 | Other databases' files read for Restore As collisions |
| `setName` | 128 | Characters of a backup set's name and user name (nvarchar(128)) |
| `setId` | 36 | Characters of a set id: a backup_set_uuid (history) or <media set>:<position> (devices) |
| `lsnDigits` | 25 | Digits of an LSN, numeric(25, 0) sent as decimal text |
| `position` | 32,767 | A backup set's position in its media set (RESTORE … WITH FILE) |
| `stats` | 5 | STATS = n in the script, as SSMS asks SMO for |
| `databases` | 32,767 | Database ids a run's preflight reads (SQL Server's most): its cleanup drops only a database whose id was not among them |
| `scriptChars` | 4,000,000 | Characters of a restore's script, checked as each statement is written (every RESTORE repeats the moves) |
| `restoreFiles` | 256 | Files (FILE), and filegroups (FILEGROUP), one file restore names: form 4's `@f1`…`@f256` and `@g1`…`@g256` |
| `fileSets` | 16 | The newest full and file backups whose files Restore Files and Filegroups reads, one describe each |
| `parameters` | 2,100 | SQL Server's parameters per statement: a file restore's files, filegroups, devices and moves (two each), with its own three, stay under them |

## SQL

DDL runs on its own unpooled connection (the program name plus " - Object Actions"), never Object Explorer's or
scripting's pools, after a preflight in the same connection that finds the object again, re-derives its subtype and
checks permissions and name collisions. Statements are built by SQL Server from constant text: names are nvarchar(128)
parameters passed through `QUOTENAME`. DDL waits for locks without a timeout, as SSMS does, and Stop is always
available: the dialog's or document's Stop, or the status bar's Stop for a rename. A stopped action answers once SQL
Server has ended the statement, with each step done, cancelled or skipped, so the dialog or document says what completed
before Stop.

### Steps, compensation and cleanup

Each statement is a step, and the reply lists them in order with a status (done, failed, cancelled or skipped), a title, SQL
Server's message for a failed one, and for some a detail (a name) or progress. The first failure stops the rest, which are
skipped. An action may also plan compensation steps, each undoing one earlier step once that step completed and a later one
failed or was stopped (restoring a database's user access after a failed rename, for example), and cleanup steps that run
after any failure or Stop (removing a partly restored database Varia created). They run on the same connection under a fresh
budget (`cleanupMs`), are listed only when they ran, marked as compensating, and the error message says how they ended. A
Stop's reply waits for SQL Server to end the statement and then for them, so it never reports an unknown outcome while
Varia's own cleanup runs. An action can instead run its steps in one transaction (the table designer's Save): a failure or
Stop rolls it back, and only the commit, which Stop no longer reaches, completes it.

Before the first statement that needs a database to itself (setting single-user, taking it offline, renaming, dropping or detaching it), and
before Database Properties applies its changes, the backend frees the database of its own sessions, on every connection
to that server: for each connection whose own database it is (the Connect dialog's Database, or the login's default, read
at connect), Object Explorer's, scripting's, SSIS's and the live views' server-scope connections open in master from then
on (unless the login is a contained database user, who cannot open master, or the connect could not read the server's
profile), the idle pooled connections in the database are closed, and for up to a second the backend waits for SQL Server
to end the sessions its pooled connections were given (with VIEW SERVER STATE; without it the action cannot see them).
Activity Monitor and Object Explorer's status sample in master on SQL Server and Managed Instance, for the same reason,
except for a contained database user or an unread profile. Query windows are the user's own and stay where they are.

Deleting a database runs SSMS's statements in a safer order: Close existing connections (`SET SINGLE_USER WITH ROLLBACK
IMMEDIATE`), then `DROP DATABASE`, and only after the DROP succeeds, the backup and restore history
(`msdb.dbo.sp_delete_database_backuphistory`). SSMS deletes the history first, so a DROP that fails (for example, a
query window still uses the database) would lose it; Script Action shows the order Varia runs. When the DROP fails or is
stopped after Close existing connections set single-user mode, a compensation step restores the access the database had
(Restore multi-user access, or Restore restricted user access), so a failed delete never leaves it single-user.

If the backend stops while an action runs: "The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check."

### Shared statements

Take Offline and Bring Online plan the first three, Detach the next three, later actions the others. Each is built by SQL Server from constant text, linted, and checked against hostile
names by a live dry run:

| Step | As Script Action writes it |
| --- | --- |
| Take database offline | `ALTER DATABASE [db] SET  OFFLINE` |
| Close connections and take database offline | `ALTER DATABASE [db] SET  OFFLINE WITH ROLLBACK IMMEDIATE` |
| Bring database online | `ALTER DATABASE [db] SET  ONLINE` |
| Restore multi-user access | `ALTER DATABASE [db] SET  MULTI_USER` |
| Restore restricted user access | `ALTER DATABASE [db] SET  RESTRICTED_USER` |
| Detach the database | `EXEC master.dbo.sp_detach_db @dbname = N'db', @skipchecks = 'false'` ('true' when Update Statistics is cleared) |
| Deny or Grant permission to connect | `DENY CONNECT SQL TO [login]`, `GRANT CONNECT SQL TO [login]` |
| Drop the database user | `DROP USER [user]`, in its database |
| Add to a server role (New Login) | `ALTER SERVER ROLE [role] ADD MEMBER [login]` |
| Create a user (User Mapping) | `CREATE USER [user] FOR LOGIN [login]`, in its database |
| Set the default schema (User Mapping) | `ALTER USER [user] WITH DEFAULT_SCHEMA=[schema]`, in its database |
| Create a schema (User Mapping) | `CREATE SCHEMA [schema] AUTHORIZATION [user]`, in its database, in a batch of its own |
| Add to a database role (User Mapping) | `ALTER ROLE [role] ADD MEMBER [user]`, in its database |

## Logins

Object Explorer gives each login a subtype from `sys.server_principals`: `sa` by principal_id 1 whatever its name, `system`
for SQL Server's own logins (a name that starts and ends with `##`), else by type: `S` `sql`, `U` `windowsUser`, `G` `windowsGroup`, `C` `certificateMapped`, `K` `asymmetricKeyMapped`, `E` `externalUser`, `X` `externalGroup`.
The backend's login preflight reads the facts an action needs in the action's own connection from catalog views only:
never `LOGINPROPERTY`, which waits on a login another session is changing, and never a password hash, which no Varia
statement may name. Delete, Unlock and Properties arrive in later versions; their rules are data already.

### Disable, Enable and Rename

Disable and Enable are inline actions in a login's menu after Copy Name, one of them at a time: a disabled login offers
Enable. Each runs at once as a status-bar job with Stop, from the server's master database, and then Object Explorer
reselects the login with its new state. Both first read the login's facts (`actions.describe` with `loginFacts`, in the
action's own connection, under READ UNCOMMITTED so that another session's open change to the login cannot hold it back;
meanwhile the status bar says "Disabling app_user: Reading the login…" with Stop, and a second request for the login
says why it waits). Disable then asks (A13 `disableLogin`): the prompt counts the sessions connected as the login, which
stay connected, warns when it is a member of sysadmin, names the service that runs as it (from
`sys.dm_server_services`, or an `NT SERVICE\` name), and names Varia's other connections that sign in as it. Enable
asks nothing; its notice says when permission to connect is still denied. The statement itself waits behind such a
change, as SSMS's does, until Stop. The facts only advise, since they read past other sessions' open changes, but the
request names the login they describe (its SID and creation time): when another login has taken the name since,
the backend refuses before any statement ("Refresh Object Explorer and try again"). Before Disable, Enable and Rename
run, the preflight reads only the login's own rows, never what it owns, so another session's open change to other
logins (a New Login in its transaction) holds back neither it nor Script Action.

Rename uses Object Explorer's inline box, as for a table. A SQL Server login's name cannot hold a backslash: "A SQL Server login's name cannot contain a backslash."
SQL Server would refuse it (15021). No login may take a name in SQL Server's own form: "Names that start and end with ## are reserved for SQL Server's own logins."
SQL Server would accept it, and Varia would then take the login for one of SQL Server's own. The box stays open with
either message, which leaves the banner when the box closes. The backend refuses a name another login or server role
uses (`NAME_IN_USE`). A notice says database users mapped to the login keep their names, and a warning names Varia's
other connections that sign in under the old name.

| Action | Step | As Script Action writes it |
| --- | --- | --- |
| Disable | Disable the login | `ALTER LOGIN [login] DISABLE` |
| Enable | Enable the login | `ALTER LOGIN [login] ENABLE` |
| Rename | Rename | `ALTER LOGIN [login] WITH NAME=[new]` |

### Delete

Delete opens Delete Object, as for a table, with the login's row (Object Type Login). Its describe reads the login's
facts past other sessions' open changes (READ UNCOMMITTED: they only advise), then the database users mapped to its SID:
one read per online database (no snapshots) the connection can enter and see the users of (VIEW DEFINITION), each under
the lock timeout, at most 4,096 databases within 20 s. A database it does not reach (offline, restoring,
not accessible or readable, a failed read, or past the bound or budget) counts as not checked, and the page says how
many; the server's total is read on its own, so a connection that may read no database is told it checked none, never
that no user is mapped. The page lists at most 100 users, each as "database: user" ("…and n more" after them), and
marks the ones a Delete keeps with why: those whose DROP USER would fail (a schema, role or other securable it owns, a
permission it granted, 15138, 15421, 15183 and 15284), in a read-only database, or where the connection may not drop users
(ALTER ANY USER).

SSMS deletes the login and says afterwards that its users are left orphaned; Varia says it first: "Deleting a login does not delete the database users mapped to it. They are left orphaned: they keep their permissions but no login can use them."
It offers "Also delete the database users mapped to this login" (unchecked), greyed with its reason when no user is mapped, every
listed user is kept, more are mapped than it lists, or the connection cannot count the login's sessions (without VIEW
SERVER STATE a session would fail the login's DROP after its users were gone). SSMS's note shows only where a user may be
left orphaned. With the option, Delete drops each user it may in its database, then the login in master; the steps name
each user ("user in database"). The statements are not one transaction (DROP USER in several databases would hold all of
them until the end), and every partial outcome is coherent: a user dropped and the login kept. After a user was dropped,
the loaded Users folders of those databases reload, and after a failure or Stop the page reads the login again, so it lists
only the users still mapped.

The warnings name what SQL Server refuses the DROP for, with the warning icon: the sessions connected as the login (15434;
Activity Monitor can end them), the databases it owns (15174), its SQL Server Agent jobs (15170), the server roles,
endpoints and availability groups it owns (15141) and the server permissions it granted to others (15173); the service
that runs as a Windows login is a note, with the info icon. OK still runs, and the backend refuses any of these before a
statement runs. A Windows group's members sign in under their own SIDs, so a group counts no sessions. The
protected-principal rules grey OK with their reason, drawn as an error (sa, the login this connection uses, SQL Server's
own logins, the permissions); Script Action still works and runs nothing. Varia's other connections that sign in as the
login are named as warnings: their pools' sessions fail the DROP until they are disconnected, and Activity Monitor neither
shows nor ends Varia's own sessions. The execute needs the login it read (its SID and creation time) and reads the login
again under READ COMMITTED: a login that took the name since is refused. With its users, it also refuses, before any
DDL, a login whose sessions it cannot count (`NOT_SUPPORTED`) and a database its own scan could not read again (`BLOCKED`,
retryable), whose users would stay orphaned. Each DROP checks, in its own batch, the principal it was planned for: a user
by its name and the login's SID, the login by its SID, principal id and creation time, again after the DROP in one
transaction, so a user renamed or remapped in an open transaction while the scan read past it, or a login dropped and
created again while an earlier step waited, is never dropped in their stead (`NOT_FOUND`). When a session the preflight
could not count (without VIEW SERVER STATE) fails the DROP, `IN_USE` says to end it first.

| Action | Step | As Script Action writes it |
| --- | --- | --- |
| Delete, with the users | Drop the database user (one per user; its detail "user in database") | `DROP USER [user]`, in its database |
| Delete | Drop the login | `DROP LOGIN [login]`, in master |

SQL Server's errors for logins map to the codes below; without ALTER ANY LOGIN, `PERMISSION_DENIED` also says what
changing a login needs. SQL Server's own logins (`##…##`, trailing spaces ignored as SQL Server ignores them) are
refused by the backend as system objects, whatever the page asks: the preflight judges the principal the server
collation finds by the name the catalog holds, and the statement names exactly that principal, so no other spelling
(a trailing space, a fullwidth `＃`) reaches one of them. A greyed verb's reason (a Windows group's Disable, SQL
Server's own logins) is its hint in the command palette.

✓ allowed, ○ shown greyed and refused, – not offered.

| Subtype | Disable | Enable | Unlock | Rename | Delete | Why greyed |
| --- | --- | --- | --- | --- | --- | --- |
| `sa` | ✓ | ✓ | ✓ | ✓ | ○ | The sa login cannot be deleted. |
| `system` | ○ | ○ | ○ | ○ | ○ | This login belongs to SQL Server and cannot be changed. |
| `sql` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `windowsUser` | ✓ | ✓ | – | ✓ | ✓ |  |
| `windowsGroup` | ○ | – | – | ✓ | ✓ | A Windows group cannot be disabled. Deny it permission to connect (DENY CONNECT SQL) instead. |
| `certificateMapped` | ✓ | ✓ | – | ✓ | ✓ |  |
| `asymmetricKeyMapped` | ✓ | ✓ | – | ✓ | ✓ |  |
| `externalUser` | ✓ | ✓ | – | ○ | ✓ | A Microsoft Entra login cannot be renamed. |
| `externalGroup` | ✓ | ✓ | – | ○ | ✓ | A Microsoft Entra login cannot be renamed. |

The login this connection uses, or a Windows group it gets in through, cannot be disabled, renamed, deleted: "This is the login this connection uses. Connect with another login to change it."
Without ALTER ANY LOGIN: "You do not have permission to change logins (ALTER ANY LOGIN)." For a sysadmin member without CONTROL SERVER: "The login is a member of sysadmin: changing it needs CONTROL SERVER."

### Login limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `password` | 128 | UTF-16 code units in a password |
| `databases` | 4,096 | Databases New Login and Login Properties list |
| `languages` | 64 | Languages the Default language list offers |
| `serverRoles` | 256 | Server roles listed and chosen |
| `roles` | 256 | Database roles listed and chosen per database |
| `schemas` | 1,024 | Schemas listed per database |
| `mappings` | 256 | Database user mappings per request |
| `credentials` | 16 | Credentials mapped per request |
| `certificates` | 1,024 | Certificates listed |
| `asymmetricKeys` | 1,024 | Asymmetric keys listed |
| `permissions` | 512 | Server permissions per request |
| `sidHex` | 172 | Characters of a SID as hexadecimal text |
| `stepTitle` | 64 | Characters in a step's title |
| `stepDetail` | 128 | Characters in a step's detail |
| `ownedDatabases` | 100 | Databases a login owns that the login preflight names |
| `mappedUsers` | 100 | Mapped database users Delete Login lists |
| `scanDatabases` | 4,096 | Databases the mapped-user scan reads |
| `scanMs` | 20,000 | How long the mapped-user scan reads databases before it counts the rest as not checked, in ms |
| `serviceNames` | 4 | Service accounts the service lookup reads |
| `serviceName` | 256 | Characters of the service name the login facts carry |

### New Login

Security › New › Login…, and New Login… on the Logins folder and on a login, open "Login - New", a modal dialog with the pages
General, Server Roles, User Mapping, Status (Securables follows once its OK works). Its action is `createLogin`, on
SQL Server (Managed Instance follows); its target is the server.

- **General**: Login name; Windows authentication (DOMAIN\name) or SQL Server authentication (the default when the server
  runs on Linux) with Password, Confirm password, Specify old password (greyed: Login Properties only), Enforce password
  policy, Enforce password expiration and User must change password at next login, each greyed unless the one before it
  is checked (SQL Server refuses MUST_CHANGE without CHECK_EXPIRATION, 15099, and CHECK_EXPIRATION without CHECK_POLICY,
  15122); Default database and Default language (`<default>`: no DEFAULT_LANGUAGE clause). A note says when the server
  takes Windows authentication only, and when this login may lack ALTER ANY LOGIN. A blank password needs the password policy on.
- **Server Roles**: every server role, public checked and greyed (every login is a member).
- **User Mapping**: the grid "Users mapped to this login:" (Map, Database, User, Default Schema), one row per database New Login
  listed, virtualized; a database that is not online, not open to this login, or read-only (set READ_ONLY, a log-shipping
  standby or a database snapshot, where CREATE USER would fail after CREATE LOGIN had run) shows its state chip (or NO ACCESS,
  READ-ONLY) and cannot be mapped. Map fills User with the login name; a User or Default Schema that equals the login name
  follows a rename, on unmapped rows too, but a blank one stays blank: a blank User shows and sends the login name, and a blank
  Default Schema leaves the clause out (typing the name after checking Map never sets one). The … button (and Alt+Down) opens Select Schema, the database's schemas. Below it,
  "Guest account enabled for:" the selected database (read-only, as in SSMS) and "Database role membership for:" it: public
  checked and greyed, the others enabled once its row is mapped. The keys are the grid's: arrows, Home/End, Page Up/Down,
  Space toggles Map, F2 or Enter or typing edits User or Default Schema, Enter or Tab commits, Escape ends the edit only.
  Selecting a database reads its roles, schemas and guest state once (`actions.describe` with dialog `loginDatabaseRoles`,
  on the action's read connection, inside the database through sp_executesql; a newer selection cancels a read still
  running); at most 256 roles and 1,024 schemas are listed, and 256 databases mapped.
- **Status**: Permission to connect to database engine (Grant, Deny) and Login (Enabled, Disabled).

The password fields are masked, never reach the dialog's snapshot, React state that is saved, AutoRecover, a toast or a log, and
are cleared when the dialog closes, the server disconnects or OK succeeds. The password travels only in `actions.execute`, which is
sensitive as a whole (its frames are zeroed on both sides once used); `actions.script` refuses one in main and in the backend.
In SQL it is one nvarchar(128) parameter, read once inside a constant batch:
`N' WITH PASSWORD=N''' + REPLACE(@password COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''`; the binary collation keeps
U+FF07 from being doubled too. A lint pins that form. The fields take one character more than the limit, so a longer pasted
password is refused ("A password can have at most 128 characters.") rather than cut short. The backend replaces the password (and an old
one) with `<password>` in SQL Server's own error and message text: where SQL Server quotes it (in single or double quotes, as
typed or with its quotes doubled), and, from 8 characters, anywhere. A shorter password could be part of SQL Server's words, and
Varia's own sentences never hold it.

Script Action never carries or writes the password: a SQL Server login's script is one batch in one `SET XACT_ABORT ON` transaction
under the comment "/* Varia leaves passwords out of scripts. Replace <password> with the login's password, as an N'…' literal, before you run this script. */", with `PASSWORD=<password>` unquoted, so an unedited script fails to parse and runs
nothing (no later statement can give a role to an existing login of that name). A Windows login's script is SSMS's, one statement
per batch. Each mapped database's statements run there through `EXEC [database].sys.sp_executesql N'…'` inside that transaction
(a Windows login's script uses `USE [database]` and `GO` as SSMS does); Script reads the server only when a Default Schema is
chosen, to learn whether the database has it (SSMS's CREATE SCHEMA), and never refuses a name.

OK runs SSMS's statements in SSMS's order, one by one: `CREATE LOGIN`, `DENY CONNECT SQL` (Deny), `ALTER LOGIN … DISABLE`
(Disabled), then `ALTER SERVER ROLE … ADD MEMBER` per role by name, then per mapped database by name, in it: `CREATE USER … FOR
LOGIN`, `ALTER USER … WITH DEFAULT_SCHEMA=` when one is chosen, `CREATE SCHEMA … AUTHORIZATION` the user when the database
lacks it, and `ALTER ROLE … ADD MEMBER` per role by name (at most 512 statements in all, or OK and Script refuse:
"This login would need more than 512 statements. Map fewer databases, or apply the rest afterwards."). They do not share a transaction (critic A24, owner decision
6): on SQL Server 2025 an open transaction holding `CREATE LOGIN` keeps out every SQL Server login whose security token is not
cached (one that has not signed in since the server started) until it ends, and one holding a server role membership change
keeps out every SQL Server login, so one statement waiting for a lock would lock users out. A live check signs in four such
logins while New Login waits before each later statement, and shows both blocks with transactions it rolls back.
A failure or Stop after `CREATE LOGIN` leaves what completed, and the message starts with the login's real state: "The login was
created, but the steps after it did not all complete.", then "It can connect: permission to connect was not denied." when Deny
did not apply, "It is enabled." when Disabled did not, "Not every server role was added." when a role is missing, and "Not every database was mapped as chosen." when a mapping step is, so the clip
at the message limit cuts the list of completed steps, never that. When Stop reaches SQL Server as `CREATE LOGIN` completes, the
backend looks for the login within the cleanup budget; if it exists, that step is done and the message says so. Either way the
dialog reloads Logins and selects the login, as after OK, and stays open with the error.
Before anything runs, the preflight refuses a name a login or server role already has (`NAME_IN_USE`) and a
login without ALTER ANY LOGIN (`PERMISSION_DENIED`); then, per mapped database, one that is gone (`NOT_FOUND`), not online,
not open to this login or read-only (`DATABASE_UNAVAILABLE`), a user name a user or role there already has (`NAME_IN_USE`) and a
role it lacks (`NOT_FOUND`). Two cases are not caught before `CREATE LOGIN` runs, so they end as a partial run: an availability
group's readable secondary (its role is only in a DMV that needs VIEW SERVER STATE), which fails `CREATE USER` as read-only, and a
Windows login whose SID already has a user under another name in the database (an orphan, often after a restore from another
server in the domain), which fails it with 15063; resolving a Windows SID before the login exists would mean asking the domain
from the preflight. The server's password policy answers `PASSWORD_POLICY` (15114 to 15118, and 33062 to 33064 from the
policy SQL Server on Linux applies), which keeps the dialog open with its password; 15025 and 15023 are `NAME_IN_USE`, 15010, 15033 and 15401 `NOT_FOUND`, and 15099,
15122, 15006, 15407 and 37525 `NOT_SUPPORTED`. After OK the server's Logins folder, once Object Explorer has listed it, reloads and selects the new login,
and each mapped database's Users folder that Object Explorer has listed reloads (after a partial run too).

Whether a server-side trace or Extended Events session can read the password from the RPC (critic A16) is checked by an opt-in live
check (`VARIA_TEST_SQL_XE=1`, set only for CI's disposable SQL Server container; it first checks, read-only, that every event,
field, action and predicate it uses exists on the server): it records `rpc_starting`, `rpc_completed`,
`sql_batch_starting`, `sql_batch_completed` and the statement-level events (statements, batch text, data streams and output
parameters) in a scratch session while New Login creates a login and Create Catalog's master key batch runs, and fails if either
password appears in any field, as text, doubled quotes, XML-escaped or UTF-16 bytes. Each half counts only once the session has
recorded that half's own RPC (its constant batch text, or SQL Server's notice that it hid the statement), polled for on the
ring buffer rather than awaited for a fixed time. Developers' servers never run it (owner decision 14). It has not run yet:
D2a does not merge until it has run once on a disposable server and its result is recorded here (critic A16).

## Errors

Failures come back as values in the result. Retryable ones can succeed when tried again.

| Code | Retryable |
| --- | --- |
| `NOT_FOUND` | No |
| `NOT_SUPPORTED` | No |
| `PERMISSION_DENIED` | Yes |
| `IN_USE` | Yes |
| `BLOCKED` | Yes |
| `DEPENDENTS` | No |
| `NAME_IN_USE` | No |
| `PATH_NOT_FOUND` | No |
| `FILE_ACCESS` | Yes |
| `MEDIA` | No |
| `BACKUP_MISMATCH` | No |
| `TAIL_LOG_NEEDED` | No |
| `RESTORE_SEQUENCE` | No |
| `DATABASE_UNAVAILABLE` | Yes |
| `TIMEOUT` | Yes |
| `CONNECTION_LOST` | Yes |
| `SQL_ERROR` | Yes |
| `CANCELLED` | Yes |
| `AUTH_KERBEROS` | Yes |
| `AUTH_UNSUPPORTED` | Yes |
| `AUTH_ENTRA` | Yes |
| `PASSWORD_POLICY` | Yes |

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `describeMs` | 40,000 | The backend's budget for reading what a dialog shows, in ms; then `TIMEOUT` |
| `scriptMs` | 25,000 | The backend's budget for building a script, in ms; then `TIMEOUT` |
| `readLockTimeoutMs` | 10,000 | `LOCK_TIMEOUT` while reading for a dialog or a script, in ms; then `BLOCKED`. DDL itself waits without one |
| `gateWaitMs` | 30,000 | How long a request waits for its gate before the backend answers `BUSY`, in ms |
| `readPerConnection` | 2 | Describe and script requests at once per connection |
| `readTotal` | 4 | Describe and script requests at once in total |
| `executePerConnection` | 1 | Actions running at once per connection; long actions take the long gate instead |
| `executeTotal` | 2 | Actions running at once in total |
| `registered` | 128 | Requests the backend tracks; more fail with `BUSY` |
| `cancelIds` | 16 | Request ids per cancellation |
| `tombstones` | 64 | Cancelled request ids remembered for requests that have not arrived yet |
| `tombstoneMs` | 60,000 | How long a cancelled request id is remembered, in ms |
| `dependents` | 100 | Dependents listed per kind of dependent; more set `dependentsTruncated` |
| `messageChars` | 2,048 | Characters in an error message |
| `infoMessages` | 32 | Informational messages an action returns |
| `infoMessageChars` | 512 | Characters in an informational message |
| `scriptChars` | 1,000,000 | Characters in a script: main's limit for a query, so a script sent to a new query window can run there |
| `newName` | 128 | UTF-16 code units in a new name (used verbatim, never trimmed) |
| `files` | 1,024 | Files Database Properties lists; more make the Files page say so |
| `filegroups` | 256 | Filegroups Database Properties lists; more make the Filegroups page say so |
| `logins` | 1,024 | Logins the Owner field suggests |
| `collations` | 8,192 | Collations the Collation list offers |
| `statements` | 512 | Statements one Database Properties request may plan |
| `stopGraceMs` | 10,000 | How long a stopped action waits for SQL Server to end its statement before it answers `CANCELLED` with an unknown outcome, in ms |
| `statusDelayMs` | 300 | How long a state action (a rename, a login's Disable or Enable) runs before the status bar shows it with Stop, in ms |
| `serverPath` | 260 | UTF-16 code units in a path on the server (`sys.master_files.physical_name` is nvarchar(260)) |
| `browseEntries` | 2,000 | Entries the server file picker lists per folder; more set `truncated` |
| `browseMs` | 10,000 | The backend's budget for one listing of the server file picker, in ms; then `TIMEOUT` (main's deadline is 15 s) |
| `browsePerConnection` | 1 | Server file picker listings at once per server, under a gate of their own rather than the describe and script gates |
| `attachDatabases` | 16 | Databases one Attach Databases OK attaches |
| `attachFiles` | 1,000 | Files one database to attach lists (a primary file that records more is refused) |
| `cleanupMs` | 10,000 | How long an action's compensation and cleanup steps may run after a failure or Stop, in ms, unless the action sets its own; a Stop's reply waits `stopGraceMs` plus this |
| `progressEventMs` | 250 | How often a long step's progress (SQL Server's message 3211, from `STATS`) may reach main as a droppable `action.progress` EVENT, at most, in ms |
| `progressPerSecond` | 4 | Progress updates main pushes to the window per request each second, at most; the first of each step always goes |
| `longPerConnection` | 1 | Long actions (a restore or backup) running at once per connection; another waits `gateWaitMs`, then `BUSY` |
| `longTotal` | 2 | Long actions running at once in total |
| `drainMarginMs` | 5,000 | What main adds to a long action's Stop wait (`stopGraceMs` plus its cleanup budget) when it lets a closing backend finish, in ms |
| `newDatabaseFiles` | 256 | Files one New Database request may create |
| `newDatabaseFilegroups` | 256 | Filegroups one New Database request may create, PRIMARY included |
| `dataFileMb` | 16,777,215 | A data file's initial and maximum size in New Database, in MB (2,147,483,647 pages, SQL Server's ceiling for a file, just under 16 TB) |
| `logFileMb` | 2,097,152 | A log file's initial and maximum size in New Database, in MB (2 TB, SQL Server's ceiling for a log file) |
| `growthMb` | 2,097,152 | A file's autogrowth in MB, in New Database |
| `growthPercent` | 100 | A file's autogrowth in percent, in New Database |
| `sessions` | 8 | Sessions Take Database Offline lists from the database (with VIEW SERVER STATE); more say so |
| `sessionText` | 128 | Characters of each login, program and host name in that list |
| `detachFiles` | 256 | Files Detach Database lists as staying on the server, and the reply's `filesKept`; more make the dialog say so |
| `filePath` | 260 | Characters of a file's path in that list (`sys.master_files.physical_name` is nvarchar(260)) |
| `blockers` | 8 | Sessions in a database that Delete Object lists (never Varia's own pooled sessions); more set `blockersTruncated` |
| `blockerChars` | 128 | Characters of each listed session's program and host names |
| `serverConnections` | 64 | Connections to the same server a database rename's describe names (whatever name each was opened with); their query windows and Database Properties documents follow the new name |
