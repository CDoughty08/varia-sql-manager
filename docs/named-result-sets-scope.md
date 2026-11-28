# Named result sets

A query names its result sets from its own text, so the results pane, the Compare picker and saved files say
"Open orders" where they would say "Result 2". The user's SQL is never changed: a marker is an ordinary comment to the
server, so the script runs unchanged in SSMS, sqlcmd and Azure Data Studio.

```sql
/* #Name="Sample Query" */
SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, SYSDATETIME() AS server_time;

SELECT name FROM sys.databases;
```

The first result is **Sample Query**. The second is **Result 2**: an unnamed result keeps its positional number, so
naming one result never renumbers another. A name is a label over a result; its identity stays the ordinal, and state
that follows a result across runs (Pivot drafts, highlights, the Compare popover's remembered choice) follows its
position. The query text is the only source of a name; there is no rename in the results pane.

Code: the marker scan in `SqlScript.Parse` (SQL Server) and `GoogleSqlScanner` (BigQuery), binding in
`backend/Varia.Backend/ResultNames.cs` and `backend/Varia.Backend/BigQuery/BigQueryResultNames.cs`, the optional `name` on
the result descriptor (`Contracts.cs`, `src/shared/contracts.ts`, `src/shared/ipc/descriptors.ts`, docs/ipc.md), and the
naming functions in `src/renderer/src/results/ResultsService.ts`. Shared fixtures in `tests/fixtures/result-names/` hold
the marker scan, statement classes, binding cases and refused characters; `ResultNameChecks.cs` (offline),
`BigQueryResultNameChecks.cs` (offline), `ResultNameLiveChecks.cs` (live) and `tests/result-name-descriptor.test.ts` read
them. User-facing behaviour is in [results-tools.md](results-tools.md#named-results).

## Syntax

```sql
/* #Name="Sample Query" */
-- #Name="Open orders"
-- #name = "Says ""hello"""
```

- The comment holds the marker and nothing else apart from white space. Either comment form; a block comment may put
  the marker on a line of its own.
- `#Name` is matched without regard to case. White space is allowed around `=`.
- The name is in double quotes, which are required. A quote inside it is doubled. The name is trimmed and runs of white
  space (tabs included) become one space.
- 1 to 128 characters after that (`ResultNames.MaxChars`, the length of a query tab's name, `tabNameChars`). Refused:
  C0 and C1 controls, line and paragraph separators, bidirectional marks, embeddings, overrides and isolates, and the
  BOM (`tests/fixtures/result-names/refused.json`).
- A malformed marker (no closing quote, text after it, empty, too long, a refused character) names nothing. It is an
  ordinary comment to the server either way.
- A marker in a string, or in a comment nested in another, is not a marker; commenting out a block turns its markers
  off.

`#`, not `@`: commented-out T-SQL is full of `@name` (`-- @Name NVARCHAR(100) = NULL,`), and a marker must never be
taken for a variable or parameter. The quotes stay required because `#` starts temporary table names, so a form that
took the rest of the line would name a result after a commented-out `-- #Name (Id int, …)`. T-SQL strings use single
quotes, so `#Name="…"` does not turn up by accident.

## Binding rule

A name belongs to the next top-level statement that starts after its comment, in the same batch. It is given to the
first result set that statement returns, when the backend can know which set that is. Stacked markers name the
statement's successive sets, in order. A name never crosses a `GO`.

The backend parses each batch that holds a marker once with ScriptDom (`TSql180Parser`), before it runs however often
`GO n` repeats it, and classes each top-level statement by how many result sets it returns:

| Class | Statements |
| --- | --- |
| None | `DECLARE` (variables, table variables, cursors), `SET` (except the options below), `USE`, `PRINT`, DDL, transactions, `TRUNCATE`, `RAISERROR`, `THROW`, `RETURN`, `GRANT`/`DENY`/`REVOKE`, `EXECUTE AS`/`REVERT`, `OPEN`/`CLOSE`/`DEALLOCATE` cursor, `FETCH … INTO`, `WAITFOR DELAY`/`TIME`, `INSERT`/`UPDATE`/`DELETE`/`MERGE` without `OUTPUT` (or with `OUTPUT … INTO`), `SELECT` that assigns variables, `SELECT … INTO` |
| One | Any other `SELECT`; DML with `OUTPUT` to the client |
| Unknown | `EXEC` and `EXECUTE`, `IF`, `WHILE`, `BEGIN … END`, `TRY … CATCH`, `SET NOEXEC`/`PARSEONLY`/`FMTONLY`, `FETCH` without `INTO`, `WAITFOR (RECEIVE …)`, `SELECT` with `COMPUTE`, `DBCC`, anything not listed |

While a batch runs the backend counts its result sets (every set with columns, kept or not, leaving out sets it
recognises as plans). A statement's first set is at a known place when every statement before it in the batch is of a
known class. Then:

- The name is put on that set's descriptor when it opens.
- After the first error in a batch execution, no further name is applied in it: a statement that fails without ending
  the batch returns no set, and every count after it would be one off.
- A statement of class One whose select list or `OUTPUT` has no `*` and no `FOR` clause has a known column count. A set
  that arrives with another count, or one the batch's statements do not select (a trigger's, or `STATISTICS PROFILE`
  output), is not named, and binding stops for that batch execution.
- A batch that sets `NOEXEC`, `PARSEONLY` or `FMTONLY` anywhere (in an `IF` or `BEGIN … END` too) gets no names: the
  server then skips statements or runs them differently without an error.

A missing name is better than a wrong one. The cases:

| Case | What happens |
| --- | --- |
| Named `SELECT`, then an unnamed `SELECT` | "Sample Query", then "Result 2". |
| Named statement that returns no set (`UPDATE`) | The name is unused. Messages says so. |
| Named `EXEC` that returns three sets | The first is named. With three markers stacked before it, all three are, in order. Applies only when no later statement in the batch can return a set. |
| More stacked markers than sets | The extra names are unused. Messages says so. |
| Name before `IF` or `WHILE` | The first set the statement returns takes it, if it returns one and no later statement in the batch can return a set. |
| Named `EXEC`, `IF` or `WHILE` followed in the same batch by a statement that can return a set | Not applied: which sets are its own cannot be known. Messages names the later statement and suggests `GO` after the named one. |
| Name inside `BEGIN … END`, a branch, a loop or a `TRY` | Not applied: how often the statement runs is not known. Messages says so. |
| Name inside a statement (before a `UNION` branch, in a subquery) | Not applied. Messages says so. |
| Named statement after an `EXEC`, `IF` or `WHILE` in the same batch | Not applied: the sets before it cannot be counted. Messages names the statement in the way and suggests a `GO` between them. |
| Name at the end of a batch, or in a batch of comments only | Unused. |
| The same name twice | Allowed. Both show it; lists also show each one's number ([Where the name shows](#where-the-name-shows)). |
| `GO 3` | Each repetition's set gets the name; the repetition is already in the view's facts. |
| Selection execute that leaves the marker out | No name: what is selected is what runs, and the backend does not look back for a marker. Selecting from the comment's line includes it. |
| Estimated plan | Not result sets; nothing changes. |
| Actual plan from the toolbar | Captured on another connection; no extra sets, nothing changes. |
| `SET STATISTICS XML ON` in the script | Plan sets are recognised and left out of the count, so rows keep their names. Plan sets are not named. A plan that arrives where a `SELECT *` stood stops naming for the rest of the batch. A batch whose text mentions the XML plan column's name anywhere (a comment, string or dynamic SQL too) gets no names. |
| A trigger that returns rows | Its set can still shift a name when it has the same number of columns as the named statement's. A documented limit. |
| The batch does not parse | No names for that batch; one Messages line says so. The server reports a syntax error itself. |
| The batch is over the parse bounds (length, parenthesis depth) or its text mentions the XML plan column's name | No names for that batch; each marker gets a Messages note saying why. |

```sql
-- #Name="Order"
-- #Name="Lines"
-- #Name="Totals"
EXEC dbo.GetOrder @OrderId = 42;
```

```sql
-- Not applied: EXEC returns an unknown number of sets, and Messages says why.
EXEC dbo.RefreshStaging;
-- #Name="Staged rows"
SELECT * FROM dbo.Staging;
```

Messages notes about names are informational, never errors, do not stop a run, appear once each, and are capped at 20
a run (`ResultNames.MaxNotes`) with one line counting the rest. They quote the name and the line, not the statement.

**Why the backend.** It has the only splitter and the only parser, it sees errors and sets in order, and it knows the
repetition. Nothing from the server maps a set to a statement, so a name can only be bound by predicting from the parse
which set a statement's first set will be. Main only passes the field through.

**Cost and bounds.** A batch with no marker is not parsed; a script without names pays only the marker check inside
`SqlScript`'s existing pass. A batch over 262,144 characters (`MaxParseChars`; one of 1,289 statements parsed in 170 to
250 ms) or nested deeper than 128 parentheses (`MaxParenDepth`, since ScriptDom's parse time grows faster than linearly
with nesting and its recursion can overflow the stack) is not parsed, and its names are reported as not applied. The
parse runs on a thread of its own with a large reserved stack.

## BigQuery (GoogleSQL)

BigQuery queries and multi-statement scripts support `#Name="…"` markers without changing the SQL sent to BigQuery
(`GoogleSqlScanner.cs`, `BigQueryResultNames.cs`, `SqlService.BigQueryExecution.cs`).

- **Comment forms.** In addition to `-- #Name="…"` and `/* #Name="…" */`, GoogleSQL `#` line comments accept both
  `# #Name="…"` and bare `#Name="…"` (where `#` is both the GoogleSQL comment introducer and the marker prefix). Bare
  `#Name` requires `=` after `#Name` (ignoring white space), so prose comments such as `#Name of report` or
  `#Name: orders`, as well as `#Names`, `#standardSQL` and `# Name="…"`, stay ordinary comments. The same 128-character
  limit, refused characters, whitespace collapsing, doubled `""` quotes, `MaxParseChars` (262,144) and `MaxNotes` (20)
  bounds apply, and neither SQL nor names are ever logged.
- **Single queries.** A marker preceding a top-level `SELECT`, `WITH`, `FROM` (pipe syntax) or parenthesized query names
  its result whether it stays in memory (REST or Storage Read) or is windowed in BigQuery, and the name stays across
  Load into memory, Re-run and re-attaching (`query.attach`, read from the job's own SQL when BigQuery returns it). If
  multiple valid markers precede the same query statement, the last marker wins and each earlier marker receives an
  informational note in Messages.
- **Multi-statement scripts (`SCRIPT`).** Each child job from `jobs.list` carries `statistics.scriptStatistics.stackFrames`
  (`startLine`/`startColumn`, 1-based in the submitted script; SQL text is never decoded). Top-level single-frame
  statement children match their planned query statement by `(startLine, startColumn)` (or unique line when no other
  top-level query starts on that line). When child jobs omit `stackFrames` (for example in emulator or minimal-fake
  modes), deterministic top-level queries match positionally only when no control-flow or dynamic statement precedes
  them and the child listing is complete.
- **Safety rule.** A marker before or inside control flow (`IF`, `LOOP`, `WHILE`, `REPEAT`, `FOR`, `BEGIN … END`,
  `CASE`, `CALL`, `EXECUTE IMMEDIATE`), inside a statement (such as before `UNION ALL`), on a non-result statement
  (`DECLARE`, `SET`, DML, DDL, `BEGIN TRANSACTION`), on a repeated execution, in an oversized (> 262,144 characters) or
  unbalanced script, or in a script whose children could not be listed is never misapplied: the result stays unnamed and
  Messages explains why (capped at `ResultNames.MaxNotes`).

## Security and limits

- The name is user text from the query. It travels only in the descriptor, is never logged (the rule for SQL text
  covers it) and never reaches SQL: nothing is sent to the server that the user did not write.
- It is bounded in three places: the backend scanner (128 characters, the refused characters), the descriptor's zod
  schema (`refusedResultNameChars` in `src/shared/ipc/descriptors.ts`), and the fake backend. A descriptor whose name
  breaks the bound fails validation like any other bad field.
- It reaches the DOM as React text or through `setAttribute` for accessible names and tooltips, never as markup. Grid
  cells are not involved, so the `nodeValue` rule is untouched.
- It reaches the file system only as a suggested name, through `save-names.ts` and main's `sanitizeFileName`.
- Names in a run are bounded by the result sets kept (1,000). Notes are capped as above.

## Where the name shows

One set of naming functions in `ResultsService.ts` names an entry everywhere. Each keeps the name and the positional
text ("Result 2") apart, so a surface shows either or both:

| Function | Gives |
| --- | --- |
| `entryName` | The entry's label (a query's `#Name`, or Varia's name for a Pivot or comparison), else "Result N". |
| `entryNumber` | "Result N", which every entry has, named or not. |
| `entrySecondary` | "Result N" beside a named result; nothing for an unnamed one, a Pivot or a comparison. |
| `numberedName` | "Totals · Result 2" for a named result in lists and tooltips; the name alone otherwise. |
| `spokenName` | "Totals, Result 2" for accessible names, so a screen reader tells two of one name apart. |
| `resultTitle` | "Totals, Result 3" where a number named a result before names existed (splitter, plans, copy and save jobs, Column Profile). |
| `entryTitle` | `resultTitle` for an original result, a Pivot's or comparison's own name otherwise (splitter, plans, Column Profile). |
| `distinctName` | The name, with "(Result 3)" only when another result of the run has the same name: titles and links of Pivots and comparisons. |

- Tabs, Stacked captions, view tabs, Pivot titles and sentences, comparison titles and links, the Compare popover, Go
  to Result and the overflow picker, the grid's accessible name ("Open orders, Result 2 of 5, …"; a Pivot's or comparison's starts with its own name), Column Profile,
  splitters, plans and memory details all take their text from these. results-tools.md, "Where a result's name shows",
  lists each surface's exact wording.
- **Long names.** A tab showing a query-given name is at most the `resultTab` metric wide (240 px) with an ellipsis, and
  such a caption's name gives way before its facts. A comparison's tab reads old → new with each side shortened in the
  middle instead. Tooltip and accessible name keep the whole name.
- **Names that collide.** Nothing is renamed or suffixed in the pane; lists carry each number.
- **Go to Result 1 to 8** stay positional.
- **Derived titles are frozen when made:** a comparison made from "Open orders" keeps that title.
- **Re-execute** releases the previous run; the new descriptors bring their own names. Editing the query so that
  "Open orders" moves from second to third leaves position-following state on the second result.
- **Save Results As** puts the name where the number would be: `{tab}-Open orders`, `{tab}-Open orders-Pivot`
  (`save-names.ts`). The number stays beside the name when another result of the run makes the same file name or the
  name was cut (a name keeps at most 64 characters). A name of only refused characters is named by its number. The tab's
  name gives way first, never the suffix.
- **Smoke locators.** `scripts/fixtures/ui.mjs` finds a grid by an accessible name starting "Result 2", or by name; a
  Pivot's or comparison's grid, named for itself, by the number it keeps in `data-result-number`.

## The default query

`welcomeQueryText` (`src/renderer/src/services/documents.ts`), the query a new user starts with, names its result so
the first F5 shows the feature:

```sql
-- Connect this query to a server and press F5 to execute.
-- A #Name comment names the result that follows it.

/* #Name="Sample Query" */
SELECT
    @@SERVERNAME AS server_name,
    DB_NAME() AS database_name,
    SYSDATETIME() AS server_time;
```

The workbench, the output pane and the command catalogue read that constant to know a query is still the untouched
default. A session restored by hot exit that still holds the earlier text (`previousWelcomeQueryText`, without the
marker) keeps it, and it still counts as untouched.
