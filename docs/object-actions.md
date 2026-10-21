# Object actions

<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->

Object Explorer's actions on objects: Select Top 1000 Rows, Rename, Delete and Properties. Which kinds and subtypes offer each is
data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`
and re-derives the subtype in the action's own connection before any DDL runs.

## Actions

| Action | Menu title | Command | Kind | Group | Mnemonic | Windows and Linux | macOS | Context key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `selectTop` | Select Top 1000 Rows | `explorer.selectTopRows` | query | `1_query` 2 | w | — | — | `explorerActionSelectTop` |
| `rename` | Rename | `explorer.rename` | inline | `7_edit` 1 | m | F2 | F2 | `explorerActionRename` |
| `delete` | Delete | `explorer.delete` | dialog (`deleteObject`) | `7_edit` 2 | e | Delete | ⌘⌫, Delete | `explorerActionDelete` |
| `properties` | Properties | `explorer.properties` | dialog (`databaseProperties`) | `9_properties` 1 | p | — | ⌘I | `explorerActionProperties` |

Keys work while Object Explorer has focus and no text field does. Delete's access key is E: Disconnect has SSMS's D in
Varia's one Object Explorer menu.
Select Top 1000 Rows follows Tools › Options › SQL Server Object Explorer › Commands (Select Top <n> Rows).
Properties is the last item, after Refresh, and is offered on SQL Server's own databases too, as in SSMS. SSMS 22's
access key and shortcut for it are unverified: Varia uses P, and ⌘I (Finder's Get Info) on macOS only, because Alt+Enter
is reserved on Windows and Linux.

## Object kinds

✓ enabled, ○ shown greyed, – not offered.

| Kind | Subtypes | Select Top 1000 Rows | Rename | Delete | Properties |
| --- | --- | --- | --- | --- | --- |
| `database` | none | – | ✓ | ✓ | ✓ |
| `database` | `system` | – | ○ | ○ | ✓ |
| `database` | `snapshot` | – | ○ | ✓ | ✓ |
| `table` | none, `graphNode`, `graphEdge` | ✓ | ✓ | ✓ | – |
| `table` | `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `ledgerHistory`, `fileTable`, `external`, `system` | ✓ | ○ | ○ | – |
| `table` | `droppedLedger` | – | ○ | ○ | – |
| `view` | none | ✓ | ✓ | ✓ | – |
| `view` | `system`, `ledger` | ✓ | ○ | ○ | – |
| `view` | `droppedLedger` | – | ○ | ○ | – |
| `procedure` | none, `sql`, `clr` | – | ✓ | ✓ | – |
| `procedure` | `extended`, `replicationFilter`, `system` | – | ○ | ○ | – |
| `function` | none, `inline`, `tableValued`, `clrTableValued`, `scalar`, `clrScalar` | – | ✓ | ✓ | – |
| `function` | `aggregate` | – | ✓ | ○ | – |

## Dialogs

| Dialog | Title | Action | Pages |
| --- | --- | --- | --- |
| `deleteObject` | Delete Object | `delete` | General |
| `databaseProperties` | Database Properties - <name> | `properties` | General, Files, Filegroups, Options |

The Script button scripts to a new query window; its arrow lists Script Action to New Query Window, Script Action to File, Script Action to Clipboard. Script never runs anything.
OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.

Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,
greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only
confirmation.

## Database Properties

Database Properties opens on General (read-only facts: backups, name, status, owner, date created, size, space available,
number of users, memory-optimized memory and collation). Files and Filegroups list the database's files and
filegroups read-only in this version; Owner on the Files page is editable. Options shows Collation, Recovery model,
Compatibility level and Containment type above SSMS's property grid. OK and Script send only the values that changed,
as SSMS does; Script with nothing changed says "There is no action to be scripted." A snapshot, a database that is not online or
not accessible, a database the login may not ALTER, and Azure SQL Managed Instance open read-only with a note.
Compatibility level is greyed for a login outside sysadmin (SSMS ignores the change silently), and Containment type
when the server's contained database authentication is off. The owner of master, model, tempdb cannot change.
On a read-only database only Database Read-Only and Restrict Access change, and the owner is greyed. Turning Database
Read-Only on cannot share an OK with a change SQL Server applies after it and refuses on a read-only database (the
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

When OK changes an exclusive option and the database has sessions (or they cannot be counted), Varia asks "To change the database properties, SQL Server must close all other connections to the database. Are you sure you want to change the properties and close all other connections?"
(Yes or No; No is the default, because Yes rolls back the other sessions' transactions, and Escape answers No).
No runs nothing. Yes writes the SET options WITH ROLLBACK IMMEDIATE. SSMS counts the connections when OK is pressed, so
the backend counts them again before anything runs: when sessions have joined since the dialog opened with none, it
answers `IN_USE` at once and the dialog asks. The backend first closes its own idle pooled connections in the database
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
available: the dialog's Stop, or the status bar's Stop for a rename. A stopped action answers once SQL Server has
ended the statement, with each step done, cancelled or skipped, so the dialog says what completed before Stop.

Deleting a database runs SSMS's statements in a safer order: Close existing connections (`SET SINGLE_USER WITH ROLLBACK
IMMEDIATE`), then `DROP DATABASE`, and only after the DROP succeeds, the backup and restore history
(`msdb.dbo.sp_delete_database_backuphistory`). SSMS deletes the history first, so a DROP that fails (for example, a
query window still uses the database) would lose it; Script Action shows the order Varia runs.

If the backend stops while an action runs: "The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check."

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
| `statusDelayMs` | 300 | How long a rename runs before the status bar shows it with Stop, in ms |
