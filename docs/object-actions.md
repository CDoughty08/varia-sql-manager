# Object actions

<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->

Object Explorer's actions on objects: Select Top 1000 Rows, Rename, Delete, Properties, and a database's Tasks › Take Offline
and Bring Online. Which kinds and subtypes offer each is
data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`
and re-derives the subtype in the action's own connection before any DDL runs.

## Actions

| Action | Menu title | Command | Kind | Menu | Group | Mnemonic | Windows and Linux | macOS | Context key | Runs on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `selectTop` | Select Top 1000 Rows | `explorer.selectTopRows` | query | `explorer.context` | `1_query` 2 | w | — | — | `explorerActionSelectTop` | SQL Server, Managed Instance, Azure SQL Database |
| `rename` | Rename | `explorer.rename` | inline | `explorer.context` | `7_edit` 1 | m | F2 | F2 | `explorerActionRename` | SQL Server, Managed Instance |
| `delete` | Delete | `explorer.delete` | dialog (`deleteObject`) | `explorer.context` | `7_edit` 2 | e | Delete | ⌘⌫, Delete | `explorerActionDelete` | SQL Server, Managed Instance |
| `properties` | Properties | `explorer.properties` | dialog (`databaseProperties`) | `explorer.context` | `9_properties` 1 | p | — | ⌘I | `explorerActionProperties` | SQL Server, Managed Instance |
| `takeOffline` | Take Offline | `explorer.takeOffline` | dialog (`takeOffline`) | `explorer.tasks` | `1_state` 2 | t | — | — | `explorerActionTakeOffline` | SQL Server |
| `bringOnline` | Bring Online | `explorer.bringOnline` | dialog (`bringOnline`) | `explorer.tasks` | `1_state` 3 | o | — | — | `explorerActionBringOnline` | SQL Server |

"Runs on" is each action's `engines`: SQL Server is the box editions, Managed Instance is EngineEdition 8, and Azure SQL
Database stands for the cloud editions. The backend refuses an action elsewhere with `NOT_SUPPORTED` before it opens a
connection. The table designer's `createTable` runs on SQL Server and Managed Instance.

Keys work while Object Explorer has focus and no text field does. Delete's access key is E: Disconnect has SSMS's D in
Varia's one Object Explorer menu.
Select Top 1000 Rows follows Tools › Options › SQL Server Object Explorer › Commands (Select Top <n> Rows).
Properties is the last item, after Refresh, and is offered on SQL Server's own databases too, as in SSMS. SSMS 22's
access key and shortcut for it are unverified: Varia uses P, and ⌘I (Finder's Get Info) on macOS only, because Alt+Enter
is reserved on Windows and Linux.

## Object kinds

✓ enabled, ○ shown greyed, – not offered.

| Kind | Subtypes | Select Top 1000 Rows | Rename | Delete | Properties | Take Database Offline | Bring Database Online |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `database` | none | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| `database` | `system` | – | ○ | ○ | ✓ | ○ | ○ |
| `database` | `snapshot` | – | ○ | ✓ | ✓ | – | – |
| `table` | none, `graphNode`, `graphEdge` | ✓ | ✓ | ✓ | – | – | – |
| `table` | `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `ledgerHistory`, `fileTable`, `external`, `system` | ✓ | ○ | ○ | – | – | – |
| `table` | `droppedLedger` | – | ○ | ○ | – | – | – |
| `view` | none | ✓ | ✓ | ✓ | – | – | – |
| `view` | `system`, `ledger` | ✓ | ○ | ○ | – | – | – |
| `view` | `droppedLedger` | – | ○ | ○ | – | – | – |
| `procedure` | none, `sql`, `clr` | – | ✓ | ✓ | – | – | – |
| `procedure` | `extended`, `replicationFilter`, `system` | – | ○ | ○ | – | – | – |
| `function` | none, `inline`, `tableValued`, `clrTableValued`, `scalar`, `clrScalar` | – | ✓ | ✓ | – | – | – |
| `function` | `aggregate` | – | ✓ | ○ | – | – | – |

## Menus, statuses, database states and servers

An action's item goes in `explorer.context`, `explorer.tasks`, `explorer.tasks.restore`: Object Explorer's menu, or its Tasks submenus. Tasks (`explorer.tasks`) and Tasks › Restore (`explorer.tasks.restore`) stay hidden while nothing is placed in them, so they appear with their first action.

A node's status badge (`explorerNodeStatus`) can overlay its row: a disabled login offers Enable in place of Disable.
No kind changes its actions by status yet.

A database row carries its runtime state as listed (state, user access, read-only, standby); a newer live status sample wins.
Rules narrow a database's actions by it, each with the reason a greyed item shows. The states: `online`, `restoring`, `recovering`, `recoveryPending`, `suspect`, `emergency`, `offline`, `copying`, `offlineSecondary`, `other`.
| Action | States | Access | Read-only | Effect | Reason |
| --- | --- | --- | --- | --- | --- |
| Take Database Offline | offline | Any | Any | Greyed | The database is offline. |
| Take Database Offline | restoring, recovering, copying, offlineSecondary | Any | Any | Greyed | A database that is restoring or recovering cannot be taken offline. |
| Bring Database Online | online | Any | Any | Greyed | The database is online. |
| Bring Database Online | restoring, recovering, copying | Any | Any | Greyed | A database that is restoring or recovering cannot be brought online. |

An action can name the servers that offer it (`box`, `managedInstance`, `cloud`: an on-premises SQL Server or a container, Azure SQL Managed Instance, Azure SQL Database);
the Runs on column above says which. Menus read the server through `explorerServerEngine` and `explorerServerLinux`.

## Dialogs

| Dialog | Title | Opens as | Action | Pages | Steps panel |
| --- | --- | --- | --- | --- | --- |
| `deleteObject` | Delete Object | Modal dialog | `delete` | General (`settings-gear`) | No |
| `databaseProperties` | Database Properties - <name> | Document tab | `properties` | General (`settings-gear`), Files (`settings-gear`), Filegroups (`settings-gear`), Options (`settings-gear`) | No |
| `takeOffline` | Take Database Offline - <name> | Modal dialog | `takeOffline` | General (`settings-gear`) | Yes |
| `bringOnline` | Bring Database Online - <name> | Modal dialog | `bringOnline` | General (`settings-gear`) | Yes |

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

### Take Offline and Bring Online

Tasks › Take Offline opens Take Database Offline - <name>: a grid of Database Name, Drop All Active Connections
(cleared), Status and Message, as SSMS 18 and later lay it out (recalled). The Message counts the sessions in the
database and those with an open transaction; a disclosure lists them (session id, login, program, host and open
transactions, at most 8, with VIEW SERVER STATE), and the page names Varia's own query windows on the database
whose session holds an open transaction, which Drop All Active Connections rolls back (A7). The counts leave out the
backend's own pooled connections, which the action closes itself. Without VIEW SERVER STATE the Message says the sessions
are unknown, and OK runs.

`SET OFFLINE` without a termination clause waits for every other session to leave, so while sessions are connected and
the box is cleared the Status is Not ready and OK is disabled, with the reason beside it; Check Again counts them again.
Checked, OK runs `SET OFFLINE WITH ROLLBACK IMMEDIATE` (about 3 s even on an idle database, probed). Either way the run
can wait for locks, so Stop cancels it in SQL Server and the database stays online. A success keeps the dialog open on
its steps with Close focused, as SSMS's progress dialog does.

Tasks › Bring Online opens Bring Database Online - <name> and runs `SET ONLINE` at once, with nothing to confirm; Stop
cancels a recovery that waits. The menu offers it on any state SQL Server lets `SET ONLINE` act on (offline, recovery
pending, suspect, emergency) and greys it while the database is online, restoring, recovering or copying. A database left
SINGLE_USER (or RESTRICTED_USER) while it was offline comes back so, and the reply says so in a message.

Both are offered on box SQL Server only (Managed Instance cannot set OFFLINE or ONLINE), greyed on SQL Server's own
databases and absent on a snapshot. The backend re-derives the state rules above from `sys.databases` before it runs
anything, refuses a database whose identity changed since the dialog read it, and needs ALTER on the database (for one that
is not online, ALTER ANY DATABASE or ownership; SQL Server's 5011 is PERMISSION_DENIED too). After either, the Databases folder is
listed again ("(Offline)" in the sublabel), and the database's Database Properties documents on that connection read
it again, or, while they hold changes, keep them with Apply disabled until it is online.

The Table Designer (New › Table…) uses the same requests without being a dialog: `actions.describe` with
`tableDesigner` and a database, and the `createTable` action; its ids live in `src/shared/designer/catalog.ts`, and
[docs/table-designer.md](table-designer.md) describes them.

## Confirmations

An action that asks first (A13) sends main a prompt id and bounded facts (`varia:confirm-action`); main checks them
(names up to 128 characters, counts up to 1,000,000, at most 8 query window names, no unknown members), writes
the message box from `src/shared/actions/prompts.ts` with names shown through `displayText`, and answers with the
chosen button's id; Escape, a closed box or a page that went away answers Cancel. The page can neither word a prompt nor
choose its default. Database Properties' Open Connections prompt keeps its own channel.

| Prompt | Title | Buttons | Example |
| --- | --- | --- | --- |
| `renameDatabase` | Rename Database | **Close Connections and Rename**, Rename When Free, Cancel | 3 connections are using Sales (2 query windows in Varia). Close them and rename the database? 1 session has an open transaction, which closing rolls back. Varia's query windows with open transactions: Query 1.sql. Rename When Free waits until they disconnect; Stop in the status bar ends the wait. |
| `disableLogin` | Disable Login | Disable, **Cancel** | Disable the login app_user? New connections will be refused. 2 sessions connected as this login stay connected until they end; Activity Monitor can end them. SQL Server Agent (MSSQLSERVER) runs as this account, and cannot connect while it is disabled. |

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

Create Catalog is the only long run so far; the others are reserved for the actions that will use them.

A short state action (a rename; later a login's Disable and Enable) runs as a status-bar job instead: one per node,
shown with Stop after `statusDelayMs`, naming its step when it has several ("Renaming Sales to Sales2: Closing
connections…").

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
query window still uses the database) would lose it; Script Action shows the order Varia runs.

If the backend stops while an action runs: "The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check."

### Shared statements

Take Offline and Bring Online plan the first three, later actions the others. Each is built by SQL Server from constant text, linted, and checked against hostile
names by a live dry run:

| Step | As Script Action writes it |
| --- | --- |
| Take database offline | `ALTER DATABASE [db] SET  OFFLINE` |
| Close connections and take database offline | `ALTER DATABASE [db] SET  OFFLINE WITH ROLLBACK IMMEDIATE` |
| Bring database online | `ALTER DATABASE [db] SET  ONLINE` |
| Restore multi-user access | `ALTER DATABASE [db] SET  MULTI_USER` |
| Restore restricted user access | `ALTER DATABASE [db] SET  RESTRICTED_USER` |
| Detach the database | `EXEC master.dbo.sp_detach_db @dbname = N'db', @skipchecks = 'false'` ('true' when Update Statistics is cleared) |
| Disable the login, Enable the login | `ALTER LOGIN [login] DISABLE`, `ALTER LOGIN [login] ENABLE` |
| Deny or Grant permission to connect | `DENY CONNECT SQL TO [login]`, `GRANT CONNECT SQL TO [login]` |
| Drop the database user | `DROP USER [user]`, in its database |

## Logins

Object Explorer gives each login a subtype from `sys.server_principals`: `sa` by principal_id 1 whatever its name, `system`
for SQL Server's own logins (a name that starts and ends with `##`), else by type: `S` `sql`, `U` `windowsUser`, `G` `windowsGroup`, `C` `certificateMapped`, `K` `asymmetricKeyMapped`, `E` `externalUser`, `X` `externalGroup`.
The login actions arrive in later versions; their rules are data already, and the backend's login preflight reads the
facts they need in the action's own connection from catalog views only: never `LOGINPROPERTY`, which waits on a login
another session is changing, and never a password hash, which no Varia statement may name.

✓ allowed, ○ shown greyed and refused, – not offered.

| Subtype | Disable | Enable | Unlock | Rename | Delete | Why greyed |
| --- | --- | --- | --- | --- | --- | --- |
| `sa` | ✓ | ✓ | ✓ | ✓ | ○ | The sa login cannot be deleted. |
| `system` | ○ | ○ | ○ | ○ | ○ | This login belongs to SQL Server and cannot be changed. |
| `sql` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `windowsUser` | ✓ | ✓ | – | ✓ | ✓ |  |
| `windowsGroup` | ○ | – | – | ✓ | ✓ | A Windows group cannot be disabled. Deny it permission to connect in Login Properties › Status. |
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
| `serviceNames` | 4 | Service accounts the service lookup reads |

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
| `DATABASE_UNAVAILABLE` | Yes |
| `TIMEOUT` | Yes |
| `CONNECTION_LOST` | Yes |
| `SQL_ERROR` | Yes |
| `CANCELLED` | Yes |
| `AUTH_KERBEROS` | Yes |
| `AUTH_UNSUPPORTED` | Yes |
| `AUTH_ENTRA` | Yes |

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `describeMs` | 40,000 | The backend's budget for reading what a dialog shows, in ms; then `TIMEOUT` |
| `scriptMs` | 25,000 | The backend's budget for building a script, in ms; then `TIMEOUT` |
| `readLockTimeoutMs` | 10,000 | `LOCK_TIMEOUT` while reading for a dialog or a script, in ms; then `BLOCKED`. DDL itself waits without one |
| `gateWaitMs` | 30,000 | How long a request waits for its gate before the backend answers `BUSY`, in ms |
| `readPerConnection` | 2 | Describe and script requests at once per server |
| `readTotal` | 4 | Describe and script requests at once in total |
| `executePerConnection` | 1 | Actions running at once per server |
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
| `cleanupMs` | 10,000 | How long an action's compensation and cleanup steps may run after a failure or Stop, in ms, unless the action sets its own; a Stop's reply waits `stopGraceMs` plus this |
| `sessions` | 8 | Sessions Take Database Offline lists from the database (with VIEW SERVER STATE); more say so |
| `sessionText` | 128 | Characters of each login, program and host name in that list |
