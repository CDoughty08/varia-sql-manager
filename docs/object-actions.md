# Object actions

<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->

Object Explorer's actions on objects: Select Top 1000 Rows, Rename and Delete. Which kinds and subtypes offer each is
data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`
and re-derives the subtype in the action's own connection before any DDL runs.

## Actions

| Action | Menu title | Command | Kind | Group | Mnemonic | Windows and Linux | macOS | Context key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `selectTop` | Select Top 1000 Rows | `explorer.selectTopRows` | query | `1_query` 2 | w | — | — | `explorerActionSelectTop` |
| `rename` | Rename | `explorer.rename` | inline | `7_edit` 1 | m | F2 | F2 | `explorerActionRename` |
| `delete` | Delete | `explorer.delete` | dialog (`deleteObject`) | `7_edit` 2 | e | Delete | ⌘⌫, Delete | `explorerActionDelete` |

Keys work while Object Explorer has focus and no text field does. Delete's access key is E: Disconnect has SSMS's D in
Varia's one Object Explorer menu.
Select Top 1000 Rows follows Tools › Options › SQL Server Object Explorer › Commands (Select Top <n> Rows).

## Object kinds

✓ enabled, ○ shown greyed, – not offered.

| Kind | Subtypes | Select Top 1000 Rows | Rename | Delete |
| --- | --- | --- | --- | --- |
| `database` | none | – | ✓ | ✓ |
| `database` | `system` | – | ○ | ○ |
| `database` | `snapshot` | – | ○ | ✓ |
| `table` | none, `graphNode`, `graphEdge` | ✓ | ✓ | ✓ |
| `table` | `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `ledgerHistory`, `fileTable`, `external`, `system` | ✓ | ○ | ○ |
| `table` | `droppedLedger` | – | ○ | ○ |
| `view` | none | ✓ | ✓ | ✓ |
| `view` | `system`, `ledger` | ✓ | ○ | ○ |
| `view` | `droppedLedger` | – | ○ | ○ |
| `procedure` | none, `sql`, `clr` | – | ✓ | ✓ |
| `procedure` | `extended`, `replicationFilter`, `system` | – | ○ | ○ |
| `function` | none, `inline`, `tableValued`, `clrTableValued`, `scalar`, `clrScalar` | – | ✓ | ✓ |
| `function` | `aggregate` | – | ✓ | ○ |

## Dialogs

| Dialog | Title | Pages |
| --- | --- | --- |
| `deleteObject` | Delete Object | General |

The Script button scripts to a new query window; its arrow lists Script Action to New Query Window, Script Action to File, Script Action to Clipboard. Script never runs anything.
OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.

Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,
greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only
confirmation.

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
| `scriptChars` | 65,536 | Characters in a script |
| `newName` | 128 | UTF-16 code units in a new name (used verbatim, never trimmed) |
| `stopGraceMs` | 10,000 | How long a stopped action waits for SQL Server to end its statement before it answers `CANCELLED` with an unknown outcome, in ms |
| `statusDelayMs` | 300 | How long a rename runs before the status bar shows it with Stop, in ms |
