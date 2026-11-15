# Named result sets: scope

Let a query name its result sets from its own text, so the results pane, the Compare picker and saved files say
"Open orders" where they say "Result 2" today.

Revision 1 (2026-11-14). This is a scope, not an implementation: no code changes with it. The owner accepted the six
picks under [Decisions](#decisions) on 2026-11-14. It was worked out from the code on `main` and from PR #494's branch;
nothing was tried against a live server, so two things are assumptions the first PR must check before it relies on
them: that errors and result sets reach the backend in the order the server sent them, and what a ScriptDom parse of a
large batch costs ([What PR 1 must measure](#what-pr-1-must-measure)).

It sits beside the [grouped results plan](grouped-results-implementation-plan.md) and changes none of its decisions: a
result is still a group with an ordinal, and the ordinal stays the identity. A name is a label over it.

## The feature in one example

```sql
/* @Name="Sample Query" */
SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, SYSDATETIME() AS server_time;

SELECT name FROM sys.databases;
```

The first result is shown as **Sample Query**. The second is **Result 2**: an unnamed result keeps its positional
number, so naming one result never renumbers another (the owner's rule, and the plan's "Closing Result 2 does not
rename Result 3").

## Decisions

| Topic | Decision |
| --- | --- |
| Syntax | A marker comment, `@Name="…"`, alone in a `/* */` or `--` comment. Double quotes required. |
| Custom `GO` | Rejected: the script must run unchanged in SSMS, sqlcmd and Azure Data Studio. |
| What a name binds to | The first result set of the next top-level statement in the same batch. |
| Several sets from one statement | Stacked markers name the statement's successive sets, in order. |
| Where binding is computed | The backend, with a ScriptDom parse of only the batches that hold a marker. |
| A position that cannot be known | The name is not applied and Messages says why. A missing name is better than a wrong one. |
| Identity | Unchanged: the ordinal. State that follows a result across runs keeps following its position. |
| Selection execute | What is selected is what runs. A marker outside the selection is not looked for. |
| Rename from the results pane | Not in this work. The query text is the only source of a name. |
| Protocol | One optional field, `name`, on the result descriptor. No new method. |

## How a result is labelled today

- **Backend.** `SqlService.ExecuteAsync` splits the script with `SqlScript.Parse`, runs one `SqlCommand` per batch
  execution and walks `NextResultAsync`. A set with columns that is kept gets `Index = sets.Count`: 0-based, global
  across batches and `GO n` repetitions, counting only kept sets. `ResultDescriptor` (`Contracts.cs`,
  `src/shared/contracts.ts`, the zod schema in `src/shared/ipc/descriptors.ts`) carries `ResultId`, `Index`,
  `BatchNumber`, `Iteration`, `Kind` and the columns. Nothing in it names a statement or a line.
- **Renderer.** `ResultsService.opened()` makes an entry with `ordinal` and `number` of `descriptor.index + 1`.
  `entryName` (`ResultsService.ts`) returns `entry.label ?? "Result N"`; `label` is set today only on entries Varia
  makes (Pivots, comparisons). Tabs, stacked captions, the Compare popover, the Pivot builder and derived titles call
  `entryName`.
- **Not through `entryName`.** These build "Result N" themselves and would not pick up a name: the grid's accessible
  name (`GridView.ts`, "Result N of M"), the stack's splitter labels and the "Out of date" sentences
  (`ResultsStack.tsx`), `ColumnProfilePanel.tsx`, `PivotService.pivotName` and its `sourceName`, two sentences in
  `CompareService.ts`, the copy and save job labels and `suggestedName` in `ResultsService.ts`, plan labels
  (`ResultPlans.tsx`, the retained-plan label) and `memory-details.ts`.
- **No name at all.** Find, Copy's strip, the Messages pane, popout window titles and the status bar never mention a
  result by name, so they need nothing.

## How the query text reaches the server

- **Splitting is the backend's alone.** `SqlScript.Parse` is a line-based scanner that masks nested `/* */` comments,
  `--` comments, strings, quoted and bracketed names, finds `GO` and `GO n` (at most 1,000 executions) and refuses
  SQLCMD lines. Comments stay verbatim in the batch text; a batch that holds only comments is dropped. It records each batch's
  start line and nothing finer.
- **Selection execute** sends only the selected text and its start line (`documents.getExecuteText`). No column, no end.
- **Nothing maps a set to a statement.** `StatementCompleted` only feeds "(N rows affected)". The server does not say
  which statement produced a set, one statement can return none, one or many, and the descriptor has only the batch
  and the repetition. This is what decides the design: a name can only be bound by predicting, from a parse of the
  batch, which set a statement's first set will be.
- **The renderer has no T-SQL tokenizer.** Highlighting is Monaco's built-in `sql` grammar. The one comment-aware
  scanner is `SqlScript`; the one parser is ScriptDom (`TSql180Parser`), already referenced by the backend for Go To
  Definition and completion scope and not used by execution.

## Syntax

```sql
/* @Name="Sample Query" */
-- @Name="Open orders"
-- @name = "Says ""hello"""
```

- The comment holds the marker and nothing else, apart from white space. Either comment form; a block comment may put
  the marker on a line of its own.
- `@Name` is matched without regard to case. White space is allowed around `=`.
- The name is in double quotes. A quote inside it is doubled. The name is trimmed and runs of white space become one
  space.
- 1 to 128 characters after that (the length of a query tab's name, `tabNameChars`). No control characters, line
  separators or bidirectional overrides; a marker with one is malformed.
- A malformed marker (no closing quote, text after it, empty, too long, a refused character) names nothing. It is an
  ordinary comment to the server either way.

Why the quotes are required: commented-out T-SQL is full of `@name`.

```sql
-- @Name NVARCHAR(100) = NULL,
-- @name = 'Smith'
```

A form that took the rest of the line would turn both into result names. T-SQL strings use single quotes, so
`@Name="…"` does not turn up by accident.

### Alternatives rejected

| Alternative | Why not |
| --- | --- |
| `GO WITH NAME "…"` | SSMS, sqlcmd and Azure Data Studio fail on it, so the script stops being portable. It names a batch, not a statement, comes after what it names, and collides with `GO n`. |
| `-- @name Sample Query` (rest of line) | Matches commented-out parameters and assignments, as above. |
| Any comment before a statement is its title (DataGrip's default) | Every explanatory comment becomes a name. DataGrip itself offers a required prefix for this reason. |
| `-- title: …` (DBeaver), `-- name: …` (sqlc) | Workable, but ordinary prose starts this way too ("-- name: the customer's"), and the owner's form is as short. |
| A first column or `PRINT` that carries the name | Changes what the query returns or prints. |
| Rename in the results pane only | Lost on the next run unless kept by position, which is the problem being solved. |

Prior art: DataGrip titles a result tab from the comment before the query, optionally only after a set prefix; DBeaver
reads `-- title:`; SQL Workbench/J reads `-- @WbResult Name` and takes the rest of the line. SSMS and Azure Data Studio
have nothing. All three put the name in a comment before the statement, which is the owner's first idea.

`@Key="value"` leaves room for other markers later. None is proposed here.

## Binding rule

A name belongs to the next top-level statement that starts after its comment, in the same batch. It is given to the
first result set that statement returns, when the backend can know which set that is.

The backend parses a batch that holds a marker and classes each top-level statement by how many result sets it returns:

| Class | Statements |
| --- | --- |
| None | `DECLARE`, `SET`, `USE`, `PRINT`, DDL, transactions, `INSERT`/`UPDATE`/`DELETE`/`MERGE` without `OUTPUT` (or with `OUTPUT … INTO`), `SELECT` that assigns variables, `SELECT … INTO` |
| One | Any other `SELECT`; DML with `OUTPUT` to the client |
| Unknown | `EXEC` and `EXECUTE`, `IF`, `WHILE`, `BEGIN … END`, `TRY … CATCH`, anything not listed |

While a batch runs the backend counts its result sets (every set with columns, kept or not, leaving out sets it
recognises as plans). A statement's first set is at a known place when every statement before it in the batch is of a
known class. Then:

- The name is put on that set's descriptor when it opens.
- After the first error in a batch execution, no further name is applied in it. A statement that fails without ending
  the batch (a permission error, for one) returns no set, and every count after it would be one off.
- A statement of class One whose select list has no `*` has a known column count. A set that arrives with another
  count is not named, and binding stops for that batch execution. This catches the row-shaped sets that
  `SET STATISTICS PROFILE ON` and `SHOWPLAN_ALL` add, which nothing else can see.

The cases:

| Case | What happens |
| --- | --- |
| Named `SELECT`, then an unnamed `SELECT` | "Sample Query", then "Result 2". |
| Named statement that returns no set (`UPDATE`) | The name is unused. Messages says so. |
| Named `EXEC` that returns three sets | The first is named. With three markers stacked before it, all three are, in order. |
| More stacked markers than sets | The extra names are unused. Messages says so. |
| Name before `IF` or `WHILE` | The first set the statement returns takes it, if it returns one. |
| Name inside `BEGIN … END`, a branch, a loop or a `TRY` | Not applied: how often the statement runs is not known. Messages says so. |
| Name inside a statement (before a `UNION` branch, in a subquery) | Not applied. Messages says so. |
| Named statement after an `EXEC`, `IF` or `WHILE` in the same batch | Not applied: the sets before it cannot be counted. Messages names the statement in the way and suggests a `GO` between them. |
| Name at the end of a batch, or in a batch of comments only | Unused. A name never crosses a `GO`. |
| The same name twice | Allowed. Both show it; lists also show each one's number ([Where the name shows](#where-the-name-shows)). |
| `GO 3` | Each repetition's set gets the name; the repetition is already in the view's facts. |
| `@Name="…"` in a string, or in a comment nested in another | Not a marker. Commenting out a block turns its markers off. |
| Selection execute that leaves the marker out | No name. Selecting from the comment's line includes it. |
| Estimated plan | Not result sets; nothing changes. |
| Actual plan from the toolbar | Captured on another connection; no extra sets, nothing changes. |
| `SET STATISTICS XML ON` in the script | The plan sets are recognised and left out of the count, so the rows keep their names. Plan sets are not named. |
| The batch does not parse | No names for that batch; one Messages line says so. The server reports the syntax error itself. |

```sql
-- @Name="Order"
-- @Name="Lines"
-- @Name="Totals"
EXEC dbo.GetOrder @OrderId = 42;
```

```sql
EXEC dbo.RefreshStaging;      -- returns an unknown number of sets
-- @Name="Staged rows"        -- not applied; Messages says why
SELECT * FROM dbo.Staging;
```

Messages notes about names are informational, never errors, do not stop a run, and are capped at 20 per run with a
count of the rest. They quote the name and the line, not the statement.

**Where it is computed: the backend.** It has the only splitter and the only parser, it sees errors and sets in
order, and it knows the repetition. The renderer would need its own T-SQL scanner and still could not see the stream.
Main only passes the field through.

**Cost.** A batch with no marker is not parsed, so a script without names pays one extra scan for the marker inside
`SqlScript`'s existing pass. A batch with a marker is parsed once before it runs, however often `GO n` repeats it. A
batch over a size bound (a constant; 262,144 characters proposed) is not parsed and its names are reported as not
applied.

### What PR 1 must measure

- That with `FireInfoMessageEventOnUserErrors` an error raised between two result sets is seen before the second set
  opens. If it is not, the stop-on-error rule cannot hold and names are applied only when the batch execution ends
  without error, which needs the late update described under Follow-ups.
- The parse time of a 262,144-character batch, to confirm or lower the bound.
- A table with a trigger that returns rows: a DML statement classed None then returns a set. The column check does not
  help here. If it cannot be detected, it is a documented limit.

## Where the name shows

One function names an entry everywhere. It gives the name and, apart from it, the positional text ("Result 2"), so a
surface can show either or both.

| Surface | With a name |
| --- | --- |
| Tabs: result tab | The name. Tooltip: the name and "Result 2". |
| Stacked: caption | The name, then "Result 2" among the facts. |
| View tabs (Table, Pivot) | Unchanged words; their accessible names use the name ("Pivot of Open orders"). |
| Pivot title, builder, "Out of date" and "built again" sentences | The Table's name in place of "Result N". |
| Comparison title and source links | "Differences: Open orders → Result 3"; a closed source reads "Open orders (closed)". |
| Compare picker | Each Table by name with "Result 2" as secondary text. |
| Go to Result and the overflow picker (#494) | The same; the filter matches the name and the number. |
| Column Profile | The name. |
| Grid accessible name | "Open orders, Result 2 of 5, …". The number stays, so a screen reader user can still tell two results of one name apart. |
| Splitter labels | "Resize Open orders". |
| Save Results As | `{tab}-{name}`; see below. |
| Plans from a result, memory details | The name in place of "Result N". |

- **Long names.** A result tab gets a maximum width (a theme metric) and an ellipsis, which it has neither of today;
  the caption's name can shrink the same way. The full name is in the tooltip and the accessible name.
- **Names that collide.** Nothing is renamed or suffixed in the pane. Lists always carry the number, so two "Totals"
  read "Totals · Result 2" and "Totals · Result 5".
- **Go to Result 1 to 8** stay positional.
- **Derived titles are frozen when made**, as now: a comparison made from "Open orders" keeps that title.
- **Re-execute.** The previous run is released and the new descriptors bring their own names. State that follows a
  result across runs (Pivot drafts, highlights, the Compare popover's remembered choice) keeps following the ordinal.
  Editing the query so that "Open orders" moves from second to third leaves that state on the second result, as today.
- **"Out of date"** is about a Table's filters and is not affected by names.
- **Smoke locators.** `scripts/fixtures/ui.mjs` finds a grid by an accessible name that starts "Result 2". Unnamed
  results keep that; the locator gains a by-name form for the new checks.

### Save names

The plan's PR 15 sets `{tab}-Result2`, `{tab}-Result2-Pivot` and `{tab}-Differences1`. With a name the middle part is
the name: `{tab}-Open orders`, `{tab}-Open orders-Pivot`. Main's `sanitizeFileName` already replaces unsafe, control
and bidirectional characters, guards reserved device names and bounds the length; `results-jobs.ts` keeps only a
`-Result{n}` suffix whole when it shortens, which PR 15 already has to widen. Two results of one name suggest the same
file name; the save dialog's own overwrite prompt covers that.

## Security and limits

- The name is user text from the query. It travels only in the descriptor, is never logged (the rule for SQL text
  covers it) and never reaches SQL: nothing is sent to the server that the user did not write.
- It is bounded in three places: the backend scanner (128 characters, the refused characters), the descriptor's zod
  schema, and the fake backend. A descriptor whose name breaks the bound fails validation like any other bad field.
- It reaches the DOM as React text or through `setAttribute` for accessible names and tooltips, never as markup. The
  grid's cells are not involved, so the `nodeValue` rule is untouched.
- It reaches the file system only as a suggested name through `sanitizeFileName`.
- Names in a run are bounded by the result sets kept (1,000). Notes are capped as above.

## Rename from the results pane

Not in this work. Two sources of a name need a rule for which wins and for what a typed name means on the next run,
when nothing in the query text carries it. If it is wanted later: a rename on the tab or caption (the query tab's
`TabRenameService` pattern) holds for that run only, wins while it lasts, and the next execute goes back to the text.

## Delivery

No backend method is added, so the five-places rule does not apply. The descriptor field is added in `Contracts.cs`,
`src/shared/contracts.ts`, `src/shared/ipc/descriptors.ts` and the fake backend, and `docs/ipc.md` records it; an
optional field needs no protocol version change.

1. **Backend: marker, binding, the `name` field.**
   - The marker scan beside `SqlScript`'s masking; the ScriptDom classification; the count and the stop rules in
     `ExecuteAsync`; the Messages notes; the measurements above.
   - The renderer shows the name wherever `entryName` is already used, by feeding it the descriptor's name. Nothing
     else in the pane changes yet.
   - Checks: an offline .NET suite over shared fixtures (`tests/fixtures/result-names/`: each syntax form, each
     malformed form, the class of each statement kind, every row of the case table that needs no server); a live
     suite (multi-set `EXEC`, an error between two sets, `GO 3`, `SET STATISTICS XML ON`, a permission failure) with
     its entry in `LiveGroups.Suites` and its CI seconds; vitest for the descriptor schema and `results-service`.
   - Docs: `docs/ipc.md`, `docs/architecture.md` (the execution bullet: user SQL is still sent unchanged, and how
     names are bound), CHANGELOG, a first paragraph in `docs/results-tools.md` and README.
   - Can start now; it does not touch the pane's files.
2. **Renderer: the name on every surface.**
   - One naming function with the positional text apart; the hard-coded "Result N" sites moved to it; tab and caption
     ellipsis and its metric (`npx vitest run tests/theme-metrics.test.ts -u`); pickers showing and filtering on both;
     the accessible names; the by-name smoke locator.
   - Checks: `tests/results-caption.test.ts`, `tests/results-service.test.ts`, the Tabs and picker tests,
     `tests/compare-popover.test.ts`, `tests/results-pivot.test.ts`, grid accessible-name tests; a step in
     `scripts/results-smoke.mjs` and in the grouped-results suite (a named and an unnamed result in Tabs and Stacked,
     a long name, two of one name in the Compare picker).
   - Docs: README, `docs/results-tools.md`, CHANGELOG; the Getting Started `run-query` guide ("Read the outcome") and
     `results` guide ("Explore returned rows") gain the marker, with their catalogue entries reviewed per
     docs/help-authoring.md.
   - After #494 merges: it rewrites the tab strip and adds the picker this PR labels.
3. **Save names.** Part of the plan's PR 15 if that follows PR 2 here (it then takes the name from the naming
   function); otherwise a small PR after it. Checks: `tests/results-jobs.test.ts`, main's file-name tests.
4. **Editor.**
   - A small TypeScript marker scanner in `src/shared/sql/`, held to the backend's by the same fixtures.
   - The marker drawn apart from ordinary comments (a decoration; the editor's second user of them after bookmarks).
   - A command, "Name Result", that inserts the marker above the caret's line (`src/shared/commands/catalog.ts`;
     `npx vitest run tests/commands-docs.test.ts -u`).
   - A warning marker under a malformed `@Name`, under an owner of its own, apart from SQL Tools' diagnostics.
   - Checks: the scanner's vitest over the fixtures, command and menu tests, an editor smoke step.
   - Docs: `docs/language-services.md`, the `run-query` guide, CHANGELOG.

Against the grouped results plan: #493 (PR 17) is merged. #494 (PR 14) goes first for PR 2 here. PR 15 and PR 3 here
are the same change to save names and should be one. PR 18's integration pass only needs to mention names where it
updates `docs/results-tools.md` and README.

## Follow-ups, not in this work

- Names for statements after one of unknown count, by counting back from the end of the batch. It needs a descriptor
  update after the set opened, which the protocol does not have.
- Markers inside a plain `BEGIN … END` at the top level, which runs once and in order.
- State that follows a result by name across runs, when the name is unique in the run.
- Rename from the results pane, as described above.
- Looking back from a selection for the marker just above it.
- "Go to the statement that returned this result", which the same parse could support for the sets it can place.

## Questions settled

The owner accepted these on 2026-11-14.

| Question | Answer |
| --- | --- |
| Are the double quotes required? | Yes. |
| Do stacked markers name a statement's successive sets? | Yes. |
| A name after a statement of unknown count? | Not applied, with a note; counting back is a follow-up. |
| Does selection execute look back for a marker? | No. |
| Does state follow the name across runs? | Not in this work. |
| Rename from the results pane? | Not in this work. The name shows on the Result tab and the Stacked caption; it is set only in the query text. |
