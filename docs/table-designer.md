# Table Designer

<!-- Generated from src/shared/designer/catalog.ts. Regenerate with: npx vitest run tests/table-designer-catalog.test.ts -u -->

SSMS's Table Designer for a new table: Object Explorer › a database › Tables › right-click › New › Table… opens it as a
document tab. Its types, properties, commands and limits are data in `src/shared/designer/catalog.ts`; the backend embeds
the same data as `backend/Varia.Backend/Designer/designer-catalog.json` and re-validates every design before anything runs.
SSMS 22 behaviour marked "not verified" could not be confirmed from Microsoft's documentation; Varia picks the closest
documented behaviour.

## The designer

- The tab's caption is "<server>.<database> - <schema>.<table>" (not verified), with the dirty dot while it has unsaved
  changes. A new table is named Table_1, Table_2… per session (not verified) in schema dbo (verified), or the database's
  first schema when it has no dbo.
- The grid has a row selector (a key glyph marks primary key columns), Column Name, Data Type and Allow Nulls, and an
  empty last row: typing a name there adds a column of type `nchar(10)` (not verified) that allows nulls.
- Keys in the grid: arrows, Home, End, Ctrl+Home, Ctrl+End, Page Up, Page Down, Tab and Shift+Tab (wrapping rows), F2 or
  Enter to edit, typing to start editing, Escape to cancel an edit, Space to toggle Allow Nulls, and Alt+Down to edit the
  Data Type with its list of types. Shift and Ctrl (⌘ on macOS) with a click on the row selector select several rows; on
  macOS Control+click opens the menu and keeps the selection, as in the results grid. Save and Generate Change Script
  first commit the cell being edited.
- A table name cannot start with # ("A table name cannot start with #: that would make it a temporary table, which the table designer cannot create."): SQL Server would put it
  in tempdb whatever its schema, and SSMS's designer cannot create temporary tables either. Column names must differ as
  the database's catalog collation compares them: trailing spaces never count, and case and accents as the collation
  says (the describe reports both). Main and the backend check only trailing spaces; SQL Server refuses the rest.
- Column Properties shows the current column's properties by category, or alphabetically; Properties (F4) shows the
  table's. Edit › Undo and Redo act on the text field being edited only; undoing grid changes is a follow-up.
- Save (File › Save, Ctrl+S, ⌘S) asks Choose Name the first time (verified: learn.microsoft.com, Create tables), with
  "Enter a name for the table:" (not verified), then creates the table in one transaction. After a successful save the
  tab stays open, read-only, saying "<schema>.<table> was created. Changing an existing table in the designer is not available yet.", and Object Explorer
  reloads the Tables folder with the new table selected (SSMS asks for F5 there).
- Generate Change Script… shows "Save Change Script": "Do you want to save this change script to a text file?" (not verified), the
  script Save would run, Yes (save it to a file) and No.
- Closing a designer with unsaved changes asks to save it, like a query; Save All and closing the window include
  designers; a designer whose save needs Choose Name, has a problem or fails comes forward rather than waiting unseen
  (SSMS 22's behaviour here is not verified). AutoRecover does not keep designers yet. While a save runs, Stop cancels it
  and SQL Server rolls it back.
- A designer stays bound to the server it was opened on, as SSMS's is: after a lost connection, Reconnect moves it only
  to a connection to that server (otherwise it stays disconnected and cannot save), Disconnect All Queries leaves it
  connected, and the Query menu's commands (Change Database, Disconnect) do not act on it.

## Data types

| Type | List entries | Parameters | Identity | Off-row (TEXTIMAGE_ON) | Since |
| --- | --- | --- | --- | --- | --- |
| `bigint` | bigint |  | Yes |  |  |
| `binary` | binary(50) | length 1–8,000 |  |  |  |
| `bit` | bit |  |  |  |  |
| `char` | char(10) | length 1–8,000 |  |  |  |
| `date` | date |  |  |  |  |
| `datetime` | datetime |  |  |  |  |
| `datetime2` | datetime2(7) | scale 0–7 |  |  |  |
| `datetimeoffset` | datetimeoffset(7) | scale 0–7 |  |  |  |
| `decimal` | decimal(18, 0) | precision 1–38, scale 0–precision | Yes (scale 0) |  |  |
| `float` | float |  |  |  |  |
| `geography` | geography |  |  | Yes |  |
| `geometry` | geometry |  |  | Yes |  |
| `hierarchyid` | hierarchyid |  |  |  |  |
| `image` | image |  |  | Yes |  |
| `int` | int |  | Yes |  |  |
| `json` | json |  |  | Yes | SQL Server 2025 |
| `money` | money |  |  |  |  |
| `nchar` | nchar(10) | length 1–4,000 characters |  |  |  |
| `ntext` | ntext |  |  | Yes |  |
| `numeric` | numeric(18, 0) | precision 1–38, scale 0–precision | Yes (scale 0) |  |  |
| `nvarchar` | nvarchar(50), nvarchar(MAX) | length 1–4,000 characters or MAX |  |  |  |
| `real` | real |  |  |  |  |
| `smalldatetime` | smalldatetime |  |  |  |  |
| `smallint` | smallint |  | Yes |  |  |
| `smallmoney` | smallmoney |  |  |  |  |
| `sql_variant` | sql_variant |  |  |  |  |
| `sysname` | sysname |  |  |  |  |
| `text` | text |  |  | Yes |  |
| `time` | time(7) | scale 0–7 |  |  |  |
| `timestamp` | timestamp |  |  |  |  |
| `tinyint` | tinyint |  | Yes |  |  |
| `uniqueidentifier` | uniqueidentifier |  |  |  |  |
| `varbinary` | varbinary(50), varbinary(MAX) | length 1–8,000 or MAX |  |  |  |
| `varchar` | varchar(50), varchar(MAX) | length 1–8,000 or MAX |  |  |  |
| `vector` | typed only | dimensions 1–1,998 |  |  | SQL Server 2025 |
| `xml` | xml |  |  | Yes |  |

The Data Type cell takes any case and spacing: `nvarchar(max)` becomes `nvarchar(MAX)`, `decimal(18,0)` becomes
`decimal(18, 0)`, and a bare name takes the list's parameters. A table has at most one identity and one timestamp column.
The list and its order follow SSMS (not verified as SSMS 22's exact list).

## Column Properties

| Property | Category | Description |
| --- | --- | --- |
| (Name) | General | The name of the column. |
| Allow Nulls | General | Whether the column accepts NULL. A primary key or identity column never does. |
| Data Type | General | The data type of the column, as the grid shows it. |
| Length | General | The number of characters (or bytes for binary types) the column holds; MAX for the (MAX) types. |
| Precision | General | The total number of digits a decimal or numeric column holds. |
| Scale | General | The digits after the decimal point, or the fractional seconds of a time, datetime2 or datetimeoffset column. |
| Identity Specification | Table Designer | Whether the column is the table's identity column, and its seed and increment. |
| › (Is Identity) | Table Designer | Whether SQL Server numbers new rows in this column. A table has at most one identity column. |
| › Identity Increment | Table Designer | What each new row adds to the last identity value. It cannot be 0. |
| › Identity Seed | Table Designer | The identity value of the first row. |

Names and categories are SSMS's (verified: learn.microsoft.com, Column Properties). Identity Specification's value mirrors
(Is Identity); an empty Identity Seed or Increment means 1 (verified). Setting (Is Identity) clears Allow Nulls, as does
Set Primary Key, which also greys it.

## Properties (F4)

| Property | Category | Description |
| --- | --- | --- |
| (Name) | (Identity) | The name of the table. Save asks for it the first time. |
| Database Name | (Identity) | The database the table is created in. |
| Schema | (Identity) | The schema that contains the table. |
| Server Name | (Identity) | The server the table is created on. |
| Identity Column | Table Designer | The table's identity column, set in Column Properties. |
| Regular Data Space Specification | Table Designer | The filegroup the table is created on: the database's default filegroup. |

## Commands

| Command | Title | Key | Context menu |
| --- | --- | --- | --- |
| `explorer.newTable` | New Table… |  | explorer.new (`1_table`, T) |
| `tableDesigner.setPrimaryKey` | Set Primary Key |  | tableDesigner.context (`1_key`, Y) |
| `tableDesigner.removePrimaryKey` | Remove Primary Key |  | tableDesigner.context (`1_key`, V) |
| `tableDesigner.insertColumn` | Insert Column |  | tableDesigner.context (`2_column`, I) |
| `tableDesigner.deleteColumn` | Delete Column |  | tableDesigner.context (`2_column`, N) |
| `tableDesigner.generateChangeScript` | Generate Change Script… |  | tableDesigner.context (`8_script`, S) |
| `tableDesigner.properties` | Properties | F4 | tableDesigner.context (`9_properties`, R) |
| `tableDesigner.stop` | Stop |  |  |

The designer's toolbar strip has Set Primary Key (Remove Primary Key when every selected row is a key column), Insert
Column (above the current row), Delete Column and Generate Change Script…; the designer's context menu adds Properties.
The Table Designer menubar menu is a follow-up.

## Script

The change script is SSMS's: its comment, the SET prologue in a transaction, `CREATE TABLE` with one column a line,
`) ON [PRIMARY]` (the database's default filegroup) and `TEXTIMAGE_ON` when a column is stored off-row, the primary key
as `ALTER TABLE … ADD CONSTRAINT PK_<table> PRIMARY KEY CLUSTERED … WITH( STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY =
OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]`, `SET (LOCK_ESCALATION = TABLE)`, and `COMMIT` (the
prologue, the key block and LOCK_ESCALATION are verified against SSMS change scripts; the IDENTITY and TEXTIMAGE_ON shapes
and the order of the blocks are not). Names are bare when they are regular identifiers that are not reserved keywords
(184 of them) or GO, as SSMS writes them, and bracketed otherwise. PK_<table> is cut to 128 UTF-16 units
without splitting a surrogate pair (not verified). The goldens in `tests/fixtures/designer` are Varia's until the owner
captures SSMS 22's.

## SQL

Save runs on the object-action connection (`actions.execute`'s `createTable`), after a preflight in the same connection:
the database is online and accessible, CREATE TABLE and ALTER on the schema are not denied (advisory), the schema
exists, and neither the table's nor PK_<table>'s name is taken. The renderer never sends SQL: the backend turns the
validated design into one JSON parameter, and constant builder batches have SQL Server shred it with OPENJSON (so master
needs compatibility level 130 or later) and compose each statement from `QUOTENAME`d names, `CONVERT`ed numbers and type
keywords from a constant table generated from the catalogue, then run it in the database. CREATE TABLE, the primary key
and LOCK_ESCALATION run in one transaction, committed only when all succeed; any failure, Stop or lost connection rolls
it back. DDL waits for locks without a time-out, as the object actions do; Stop is always available: in the preflight it
answers that nothing changed, and during a statement SQL Server cancels it, the transaction rolls back, and the steps say
where it stopped.

If the backend stops while a save runs: "The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check."

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `columns` | 1,024 | Columns in a table (SQL Server's limit for a table that is not wide) |
| `keyColumns` | 32 | Columns in the primary key (SQL Server's limit for a clustered index) |
| `designChars` | 400,000 | UTF-16 code units of every string in a design together |
| `scriptChars` | 1,000,000 | Characters in a change script: main's limit for a query, so the script can run in a query window |
| `schemas` | 2,048 | Schemas the Schema list offers; more are listed as truncated |
| `identityDigits` | 38 | Digits in an identity seed or increment (decimal(38, 0)) |
| `captionChars` | 400 | Characters in a designer tab's caption, so main's close prompt always takes it |

## Not yet

- Design (changing an existing table), and the Table Designer menubar menu.
- Default Value or Binding, Computed Column Specification, Collation, Description, Condensed Data Type, RowGuid, Not For
  Replication, Size and the other read-only Table Designer rows, user-defined data types, and Lock Escalation (PR-G2),
  with the error mappings they need: 2715 (a type that does not exist) and 448 (an invalid collation) as NOT_FOUND. Core
  offers only system types and no collation, so neither can occur yet.
- Tools › Options › Designers (Table and Database Designers): the transaction time-out and Auto generate change scripts.
- Relationships, indexes and keys other than the primary key, check constraints, and the Database Diagram.
- Undo and Redo of grid changes, and AutoRecover for designers.
