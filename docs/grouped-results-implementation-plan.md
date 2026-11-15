# Grouped results implementation plan

Give each original query result a group that owns its Table and, when built, one Pivot. Show the groups as tabs with one
active grid or stacked as today; the user chooses. Transpose becomes a way of drawing a Table or a Pivot, not a stored
result. Comparisons sit beside the groups and keep their own snapshots.

Revision 9 (2026-11-14). It follows the owner's decisions, three independent reviews against the code, the orientation
spike's findings, what PRs 1 to 13 and 16 found when they merged, and the
[pivot performance findings](pivot-performance-findings.md). PRs 14 and 17 are in progress; 15 and 18 follow. Each
merged PR's entry under Delivery says what it settled or left, and where the PR and an earlier section of this document
disagree, the entry is the later word.

The visual references are the three mocks in [prototypes/results-pane](../prototypes/results-pane/README.md): Tabs,
Stacked and the transposed grid. The owner accepted their defaults on 2026-11-11, to be adjusted as the PRs land: the
choices the README lists where this plan leaves the interface open, and the A alternative of each transposed topic
(1A, 2A and 5A are also what the spike decided). Where a mock and this document disagree, this document wins. The older
`grouped-results-ui.html` is superseded and kept only for history.

The [pivot performance investigation](pivot-performance-follow-up.md) was separate work and is done; its findings set
PR 17's threshold. The [result memory work](#result-memory-work-alongside) beside this plan changes what some of its
limits must be measured against.

## Decisions

| Topic | Decision |
| --- | --- |
| Layout | A Stacked / Tabs choice. Tabs shows one view at a time. Stacked shows every view, a group's Pivot under its Table. |
| Transpose | A display orientation of a Table or a Pivot, drawn by rotation inside the grid (the spike passed). No stored transpose result. |
| Selected rows | "Keep Selected Rows": a filter on the source of at most 4,095 rows, so it composes with sort, filters and orientation. |
| Nesting | Pivot only from a group's Table. Either can be shown transposed. Nothing deeper. |
| Composition | A transposed view follows its source by construction. A Pivot is marked out of date, later rebuilt, when its Table's filters change. Comparisons are snapshots. |
| Compare | Table with Table in this work. Pivot with Pivot is a follow-up: the diff needs an explicit key first. |
| Out of memory | A derived result (pivot, diff) that does not fit is refused whole and never stops the query's budget. |
| Plans | SQL-returned plan sets stay groups of their own with data operations off. A Plan tab inside a group is a follow-up. |
| Peek | The shared component without group chrome or toolbar. Transposed stays available; Pivot, Compare and close are off. |
| Jobs | One copy and one save per window, as now. Pivot builds and comparisons run in parallel. |

### What this gives up

Stated so it is a choice, not a surprise. Against today's stored transpose and flat stack:

- Sorting or filtering the transposed set itself (ordering attribute names, "Row 1 is not NULL"), and profiling it.
- A frozen transpose that survives re-filtering its source, and several transposes of different selections at once.
- A table and its transpose side by side. (A table and its pivot stay side by side in Stacked.)
- Transposing selected rows without touching the source: Keep Selected Rows filters the Table, so its Pivot goes out of
  date, and the filter stays until removed, also after the orientation is turned off.
- Original row numbers in a transposed selection's headers: they number the rows the view shows.
- Searching source column names as cell values, and highlighting transposed rows.
- Pivot of a pivot, transpose of a transpose, and several pivots of one result.

It gains: transposing works on a query whose result memory is full, costs no memory, has no 4,000,000-cell limit, and
always shows the source's current rows.

## Product behaviour

### Navigation and layout

- Results and Messages stay at the output level. Execution plan and Client Statistics keep their availability and docking.
- Each original result is a group, named by its original number. Closing Result 2 does not rename Result 3.
- A group has a Table view, and a Pivot view once one is built.
- A SQL-returned execution plan set is a group, as it is a numbered grid today: its link cell opens the plan and it counts
  as a result. Pivot, Compare and Transposed are unavailable for it. Closing that group releases the set, so the Execution
  plan pane stops listing that plan; captured actual plans are a separate surface and are not affected.
- Each completed comparison is its own closable item after the groups, named old to new as today ("Differences: Result 1 →
  Result 3").
- **Tabs:** one row of group and comparison tabs, the selected group's view tabs beneath, one mounted grid. Each group
  remembers its selected view. Switching keeps each view's scroll, column widths, selection, filters and sort, and releases
  nothing. No parent vertical scroll bar.
- **Stacked:** the existing stack, one item per view: a group's Table, then its Pivot, then the next group; comparisons
  last. Captions carry the close buttons: a Table's closes its group (its Pivot too), a Pivot's closes the Pivot.
  Collapse, splitters and bounded mounting stay. Splitter weights are kept per entry: a new item takes the mean of the
  existing weights and a closed item's weight is removed, so the others keep their heights.
- The choice is a setting (`queryResults.grid.layout`), a toolbar toggle and a command; switching keeps every view's state.
  Default: Tabs since PR 14 (Stacked until the overflow picker existed).
- While a run streams in Tabs, the first group is selected and stays selected; a tab the user picks stays picked.
- Find Next onto a match in another group or view selects that tab and view in Tabs, then reveals the match.
- Tab overflow opens a picker listing every group, view and comparison: a virtualized themed list (a run can hold 1,000
  results), never a native select or one element per entry. Commands select the next and previous item and view.
- The Results badge counts original groups and hides at zero.
- Run totals count the query's own rows. Today a derived set's rows are added to them; that stops (a behaviour change, in
  PR 3), and closing a result does not subtract.
- In Tabs the Messages strip opens by itself when the pane fits the two tab rows, the grid at its minimum height (or at
  its rows' height when a settled result needs less; no stack caption), and the strip.

The output toolbar keeps search, white space, text sorting, Profile, Row size, the layout toggle and Close Results (the
command that closes them all keeps its title and behaviour).

Pivot, Transposed, Compare, Save Results As and the close actions address the active view or the exact context-menu
target. Narrow panes fold the labelled actions into a menu.

Column Profile follows the active view. The pivot builder belongs to one group and names its Table as the source; there is
no source picker. In Tabs it is the selected group; in Stacked, the group of the grid that last had focus, or, when that
grid is a comparison or a plan set, the first group whose Table can be pivoted (as the panel falls back today). Every capability
of today's builder stays. Wide panes show Profile and a builder together; otherwise a selector shares the side area.

### Operations

| View | Pivot | Transposed | Compare |
| --- | --- | --- | --- |
| Table | Build or update the group's Pivot | Toggle | Another group's Table |
| Pivot | Edit its recipe (always read from the Table) | Toggle | Unavailable (follow-up) |
| Comparison | Unavailable | Unavailable | Unavailable |
| Plan set or live table | Unavailable | Unavailable | Unavailable |

`results.pivot` accepts only `rows` sources and `results.diff` only `rows` with `rows`, enforced in the backend, the
renderer and the menus' context keys, each in the PR named under Delivery.

### Transposed orientation

Transposed draws a view's columns as rows and its rows as columns. It is per view, kept with the view's
other state, and available while rows stream (the drawn columns grow as rows arrive).

- Nothing is stored. The grid reads the windows it reads today (the worker serves 4,096 rows by 262,144 cells per request;
  a rotated tile is far inside that) and draws them rotated, so the view shows its source's current sort and filters.
  It reads tiles 32 rows by 128 columns, not 128 by 32, since a transposed view spans few source rows and many columns.
- Source column names sit in a frozen first column, with each column's sort and filter controls in its name cell. There
  are no column ordinals.
- Selection, search matches, highlights and filters stay in source coordinates. A command that names a column (sort,
  filter, Copy Column Name) resolves it from the source column a transposed row stands for; menu targets carry the source
  row and column and never read them from the drawn index.
- Widths: one shared width for the drawn columns, at most 240 px, plus at most 256 columns sized on their own, which a
  re-sort clears. Fit Column fits the drawn column (a source row).
- A highlighted source row tints its drawn column; row-size bars and highlight colours sit on the drawn columns' headers.
- Past the cap: Find Next onto a match in a row the view does not draw says so and does not move. Select All still
  selects everything; a copy then writes the rows drawn and says how many it left out.
- **Using Column as Headers** is a display option: each drawn column's header is that source column's value for the row,
  written as a pivot names a column group today (`NULL`, `(blank)`, binary as hex, cut at 128 characters), repeats
  included, once its window has been read, and "Row N" until then. The header column is still drawn as a row.
- **Cap:** the first 4,095 rows of the view are drawn as columns, with a strip that says so and suggests filtering.
  With the shared-width layout, resizing no longer grows with the column count; what still bounds the cap is the scroll
  range (about 468,000 columns at 32 px), the 4,096-row window limit, and Copy and Save.
- Copy and Save write the transposed text (see Protocol).
- The command IDs `output.transpose`, `output.transposeSelectedRows` and `output.transposeWithHeaders` stay, so user
  shortcuts keep working: the first toggles the orientation; the second keeps the selected rows and turns it on; the third
  sets the header column and turns it on.

### Keep Selected Rows

A filter of its own (`keepRows`), not one of the value filters: those resolve to one representative row per distinct value.

- It keeps the rows the selection covers in the view it was made on: at most 256 ranges and at most 4,095 rows. The backend
  resolves them to a list of base rows, which the renderer keeps and re-sends like any resolved filter (the list fits the
  existing 4,096-row bound).
- More ranges or more rows than that: the command says so in the toolbar and applies nothing.
- A grid has at most one; a new one replaces it, in the same place among the filters, or last when a duplicates filter
  follows the old one: the selected rows passed every filter, but a duplicates filter counting only them would drop each
  whose pair was not selected, and last the grid shows exactly the rows selected. It counts as one of the 16.
- Its chip reads "12 selected rows": the rows it names, though a later filter (duplicates, say) may show fewer.
- It works wherever the other selection filters do: Tables, Pivots and comparisons.
- It names no column, so header funnels do not mark any. Code that tells filters apart by their `rows` or `column` must
  handle it: in `ResultsService.ts`, every place that reads a filter's `rows` or `column`, and `filterLabel`;
  `column-filter.ts`
  (`columnFilterKind`, the not-NULL test); in C#, `FilterOp`, the view's key count (which must not count it as a key) and
  the filter validation in `SqlService.cs`.
- While rows stream it keeps the rows it resolved; rows that arrive later are not kept.
- It is a command (`output.keepSelectedRows`) and a grid-menu item from PR 4, useful without the orientation.

### Pivot lifecycle

- One Pivot slot per group, and one draft per group: the draft is that slot's recipe, so Edit Pivot reopens it. Across
  runs a draft carries forward to the group with the same ordinal, fitted to its columns by name as now.
- A build reads the Table's settled view. Row order does not change any aggregate (aggregation walks base pages; ties
  resolve by base row), so only the Table's filters matter.
- The renderer keeps the view a build reads in that grid's held views until the build ends. The backend may still evict it
  (it keeps eight views a result); a build that fails because its view closed is started again once.
- A replacement is built while the existing Pivot stays readable. The new descriptor and provenance publish together on
  success, then the old result is released. Failure, cancellation or refusal keeps the old Pivot and says why. The old
  result is never freed early to make room.
- Refusals say what will help. The backend answers a stopped budget with its own error code (`BUDGET_STOPPED`) and one of
  two sentences, by the reason it stopped: its result memory filled, so run it again returning fewer rows; or the computer
  was low on memory while it ran, so run it again (true also when nothing was cut short). Out of memory otherwise stays
  `TOO_LARGE`; for a replacement the renderer adds "or close this Pivot and build it again".
- The Pivot records what it was built from: source result, the resolved filters applied, input rows, recipe, and whether
  the source was incomplete, truncated or approximate. Its strip states that.
- **Out of date:** the Table's resolved filters differ from the ones the Pivot recorded (a filter's label being named
  later is not a change). The Pivot says so and offers Update. PR 17 makes the rebuild automatic under a threshold.
- **A rebuild keeps** the orientation; column widths, sort keys and the header column where the column's name is unique in
  both the old and the new Pivot and present in both. **It drops** the Pivot view's own filters (a filter names rows of
  one stored result), its selection and its scroll, and says in the toolbar that the Pivot's filters were removed.

### Closing

- Closing a Pivot releases it; in Tabs the group's Table is selected if the Pivot was showing.
- Closing a group closes its Table and Pivot. If it was active, the next surviving item is selected, else the previous.
- Closing a comparison releases only the comparison. A finished comparison copies its cells, so it outlives its sources.
- A comparison's source link goes only to the exact input it compared; otherwise it reads closed.
- **Close Results** (all of them) is unchanged: every set and captured plan is released, Messages stay, the run reads
  closed.
- **Closing the last item one at a time** (possible from PR 3) sets a flag on the run (`emptied`) beside its status, which does not change, nor
  does the run summary. The Results tab stays and shows "Results were closed. Execute the query again to see them.";
  captured plans and their pane are untouched; the output does not jump to Messages and does not say the query returned no
  result sets.
- A new context key, `hasResultSets`, is true while the run holds a row, plan-set or comparison result. It gates Save
  Results As, search, Pivot and Compare; `hasResults` keeps its meaning (captured plans count there).
- With only comparisons left, Results shows them, the badge hides, and Pivot and Compare are unavailable.
- Individual close and Close Results are unavailable while the query runs.
- Closing a view or group aborts the work that depends on that result, though the query has not changed. A late answer
  never recreates a closed slot or attaches to a newer run; its result is released exactly once.
- Individual close waits for a retained-plan copy in progress before releasing, as Close Results does.
- A copy of a removed result is cancelled; a save already accepted finishes under its backend lease.
- Backend loss invalidates every row and disables data operations; closing, navigating and Messages keep working.
- Re-execution releases the previous run. Highlights keep following a result by its ordinal across runs. Nothing derived
  is rebuilt.

There is no Undo for a close.

### Comparisons

- Compare opens a picker of targets: other groups' Tables of the same run and backend generation, complete and readable,
  sharing at least one column with the active Table. Comparisons, pivots, plan sets and live results are not offered.
- The active Table is the new side (+) and the picked one the old side (−); the picker can swap them. The name always
  reads old → new.
- Pairing is the backend's: visible columns by case-insensitive name and matching wire kind, repeated names in order. The
  picker lists each side's unpaired columns from a renderer copy of that rule, pinned to the backend's by fixtures both
  test suites read; the strip reports them, as now. No manual mapping, no coercion.
- Row alignment, exact text, collation handling and approximation reporting are the diff engine's, unchanged. The picker
  never promises a key.
- A comparison reads stored results, not sorted or filtered views (`results.diff` takes no view). The picker and the strip
  say that filters on the inputs are not applied.
- Both inputs' identities and provenance are captured at the start and kept apart from the source handles.
- One comparison runs per pair of inputs and exact-text choice; asking for the same one again while it runs does nothing.
- Compare with Previous Result and its Exact Text variant keep their IDs and behaviour and publish through the same path.
- **Why not pivots yet:** the diff chooses its key by ranking integer and decimal columns ahead of text, so a pivot's
  aggregate becomes the key ahead of its group column; a NULL group disqualifies the real key; and there is no composite
  key for two or more row groups. The follow-up gives the diff the pivot's row-group columns as its key.

### Concurrency and limits

- Pivot builds on different groups and comparisons of different pairs run at once (they are one per tab today); per Pivot
  slot a newer build cancels the older. Builds of one query share its budget, so one can be refused because of another.
- At most four pivot builds and comparisons run per window; further ones wait in the renderer. Each holds one of the
  backend's 16 result slots for up to its deadline.
- The results port answers `TOO_MANY_REQUESTS` past 64 outstanding requests and the backend `BUSY` when no result slot
  frees in time. Both refuse before anything runs, so asking again is a new request, not a re-send. Pivot and diff
  requests retry as `HighlightsService` does (after 1 s, 4 s and 16 s, at most three times, on those two codes only, never
  on `TIMEOUT`), then fail with the refusal's sentence.
- Copy and save stay one each per window (main cancels the previous copy and answers a second save with JOB_BUSY).
- A run holds at most 1,000 results in the renderer, derived ones included (the backend caps only the query's own sets).
  A build that would pass it, counting builds in flight, is refused before the backend is asked, and says so; a
  replacement counts once.
- Save Results As suggests `{tab}-Result2`, `{tab}-Result2-Pivot`, `{tab}-Differences1`, with `-Transposed` when it is. Job
  strips use the same names. Main's shortening of a long name, which keeps only a `-Result{n}` suffix today
  (`results-jobs.ts`), and `suggestedName` keep the whole suffix.

### Result memory work alongside

Separate work is changing how much a result can hold, and this plan's limits were written against today's 2 GiB cap:

- **A larger global budget merged** as #447, with its gaps closed in #477: a quarter of memory up to 16 GiB, with
  limits in Options. A query's budget is half of it, so a source can hold several times the rows it did. A result-scale
  benchmark at 1 to 8 GiB of rows (`--result-scale-bench` in the .NET test project) measures sort, filter and pivot at
  those sizes.
- **Packed pages merged** in stages: #468 packs result pages inside the store behind an internal switch, #482 packs a
  result hidden for five seconds, and #480 reads packed results fused in sorts, filters, profiles, pivots and plain
  Save. A scan of a packed result pays for unpacking.
- **Merged since:** #426 sends a set's truncation reason with `progress`, so the strip shows while the query still
  runs. #427, then #432, #435 and #439, stopped sorts and groupings reading the pages for every tie (numbers first, then
  text, dates and binary values) and put keys, sorts and scans on several threads. A million-row Count by a column of
  40 values went from about 0.2 s (numbers) or 1.4 to 2.7 s (dates, text) to 30 to 95 ms.

What that changes here:

- **Limits that are counts stay.** 4,095 drawn rows, 4,096 columns, 256 ranges, 16 filters and 1,000 results do not
  depend on the budget.
- **The cap of four parallel builds stands.** The findings measured builds of one source side by side: four of a
  5,000,000-row source each took 1.25 s against 1.11 s alone, so they do not starve each other. At a 20,000,000-row
  source under a 1 GiB query budget, the second build is refused at once by the budget, which changes nothing and is
  what the plan's refusal sentence is for. Those timings predate the threaded sorts; PR 10 runs the findings' parallel
  case once more, since a build now uses up to three quarters of the cores by itself.
- **PR 17's threshold is 500,000 source rows and a last build under 250 ms**, both required. Rows are those stored in
  the Table's result, not those its filters keep. The findings first gave 100,000 and, re-measured on 2026-11-12 after
  the sort work, say the same reasoning now reaches 500,000 (the slowest recipe found takes 189 ms there on a 24-core
  machine). The time condition is what covers machines with few cores, long decimals and Distinct Count, so it is not
  optional. The owner accepted the row figure on 2026-11-12; it does not rise with
  a larger budget. Packed pages landed before PR 17, so PR 17 measures it again over them and, if the numbers no longer
  support it, asks the owner instead of changing it.
- **The reported slow Pivot was not reproduced.** At the reported shape (about 20,000 rows of one `int` column) a build
  takes 110 to 180 ms from the click to the painted pivot, before and after the sort fixes. If it is seen again it needs
  the machine, the build and the result's shape recorded.
- **Out of date and Update (PR 11) matter more.** A rebuild over a large source takes seconds, so the marked state is
  what users of large results will see most.
- **PR 1's rules hold whatever the size**, but its checks name byte counts through a memory probe; they need another
  look if what a stored page charges changes with compression.
- **The transposed grid reads tiles of 32 rows by 128 columns** across many pages. Its frame numbers were taken over
  uncompressed pages; PR 5b's benchmark entries are the place a compressed format would show a cost.

### Peek

Peek shows one set of ten rows. It uses the shared component in a bare mode: the grid alone, no tabs, close buttons,
toolbar or panels, whatever the layout setting. Transposed and Keep Selected Rows work there as in query output. Pivot,
Compare and close are off for a Peek grid by context key. (Today Pivot on a Peek grid opens a panel nothing draws.)

## Implementation design

### Stable identity

[ResultsService](../src/renderer/src/results/ResultsService.ts) keeps a flat array and keys state by position. `setKey`
already names a stored result by generation and result id, and the grid's DOM and menu targets already carry it.

**Step one is keys, not groups.** Today's list legally holds several pivots of one source, pivots of pivots and transposes
of transposes, which a group with one Pivot cannot represent. PR 2 replaces position with a stable entry key over the same
flat, ordered list. Groups arrive in PR 9, with the rules that make them true.

- **Entry key:** an opaque id `ResultsService` mints per entry, not `setKey`. An entry maps to the stored result it
  currently shows, so a rebuilt Pivot keeps its key and nothing is re-keyed in PR 10. DOM and menu targets carry the
  entry key and keep the generation and result id for staleness checks.
- **Ordinal:** an original result (kinds `rows` and `executionPlan` in `sets`) has ordinal `descriptor.index + 1`, which is
  the number it is named by today once the run ends. Names come from it: "Result 3", "Pivot of Result 3", comparison
  names.
- **Derived entries have no ordinal.** Where one is numbered by position today (job labels, save names, splitter labels
  and the grid's accessible name call a pivot at position 4 "Result 4"), PR 2 fixes that number for the entry's life, as
  the run's highest number so far plus one (the position it is appended at while nothing has been removed; a position
  alone would repeat a number after a removal). So PR 2 changes nothing visible; PR 15 gives derived views their own
  names.
- **Grid names:** the accessible name stays "Result N of M, …" in PR 2, so scripts that assert it keep passing.
- **Highlights:** an original result's are keyed by ordinal and follow a re-run; a derived entry's are keyed by entry key
  and do not.

Consumers to move off position (PR 2's scope):

- `ResultsService`: sorts, held views, sorting controllers, grid state, controllers, jobs and their labels,
  `suggestedName`, the open-value dedupe key, retained-plan labels.
- Grid: `GridSelection.resultIndex` and `GridView`'s `resultIndex` option (live grids use them too), `grid/swap.ts`,
  `ResultGrid`, `ColumnFilterPopover`, `ResultsStack` (weights, collapsed, mounted, narrow, focused, splitter labels,
  `settledContent`).
- Results tools: search (matches, names, reveal), `HighlightsService` (keyed by ordinal so highlights follow re-runs),
  `ColumnProfilePanel`, `PivotService`, `PivotPanel`, `TransposeService` (until PR 8), `CompareService`, `OutputPane`'s profile target.
- Commands and menus: `core/types.ts` cell targets, `services/result-selection.ts`, `menus/targets.ts`,
  `contributions/output.ts`, `pivot.ts`, `transpose.ts`, `compare.ts`, `highlights.ts`; `plans/ResultPlans.tsx`.
- Tests that assert positions change with it and are listed in the PR: `grid-selection`, `grid-stack`, `live-grid`,
  `menu-targets`, `menu-commands`, `menu-service`, `menus-content`, `results-service`, `results-caption`,
  `results-sort-commands`, `column-filter-popover`, `column-profile-panel`, `explorer-peek`, `ssis-operations`, the
  results tool tests and `tests/bench/grid.bench.ts`.
- Scripts: `scripts/fixtures/ui.mjs` gains a locator by entry name: the grid whose accessible name starts with it
  ("Result 2"), or whose caption carries it for a derived entry (result ids come from one backend counter and cannot be
  predicted). A view argument is added in PR 9. `results-smoke`, `menus-smoke`, `popout-smoke`, `electron-smoke`,
  `hot-exit-smoke`, `options-smoke` and `grid-bench` move to it; `estimated-plans-smoke` asserts the grid's name, which
  does not change.

It lands as two PRs: 2a moves the service and its state maps to entry keys, keeping `data-result-index` as a derived
attribute so nothing outside the services changes; 2b moves the DOM, menu targets (which then carry the source row as
well as the column, as the orientation needs), tests and script locators.

From PR 9:

| Concept | Responsibility |
| --- | --- |
| Group | Identity of an original result, its ordinal and batch, its Table slot, optional Pivot slot, selected slot |
| Presentation slot | Identity, view kind, the stored result it shows and a revision, grid state (orientation included), provenance |
| Comparison | A slot of its own with frozen references and metadata for its two inputs |

Provenance is kept apart from source liveness and bounded by the existing spec limits and the open result count.

### One cleanup path

Service operations close an entry (later a Pivot, a group, a comparison) and publish a replacement. Cleanup covers
controllers, grid state, sort and filter work, held backend views, distinct snapshots, search matches and pending reveals,
highlight bindings, profile requests, drafts and errors, copy state, the retained-plan lease and the stored handle. It
reuses `ResultClient.release` and `results.close`; a backend release already drops the result's views and snapshots.

Until PR 9 the list is flat, so a derived entry (a pivot, a stored transpose, a diff) outlives a closed source: it is a
stored result of its own and keeps its name.

Search re-runs every open result when one signature changes; it moves to per-target invalidation, so a close, a
replacement or a rebuild searches only what changed.

Asynchronous work captures the query id, result key, slot revision, source view and a sequence number, and checks them
before publishing.

### Rendering and commands

- One component draws the entries in either layout over the existing `ResultGrid` and stack layout code, with a bare mode
  for Peek. `GridView` keeps its pools and text sinks; no React per row or cell.
- A view is **shown** when the user can see it: the selected view in Tabs; in Stacked, an item that is not collapsed and
  lies at least partly inside the pane (not the wider range the stack keeps mounted).
- An unmounted grid keeps its result and state, cancels its paint and window requests, and the service retires backend
  views superseded while it was unmounted (today they are held until it mounts again).
- New commands and their menu placements go in the command catalogue; generated command, settings and context-key pages
  are regenerated in the PR that changes them. Keys through `KeybindingService`, menus through `MenuService`.
- Colours, metrics and icons from the shared catalogues. Compact density.

### Backend and protocol

`results.pivot`, `results.diff` and `results.view` are results-port methods (as `results.transpose` was until PR 8): their places are
`RpcMethods`, `methodPolicies`, `ipc/port-messages.ts`, `main/backend/results-port.ts`, the worker protocol and client,
and the C# records and dispatch. `results.copy` and `results.export` also have zod schemas in `main/validation.ts`.

Smoke suites and the grid benchmark run on a fake backend with its own filters, pivot, diff, copy and export
(`tests/fixtures/backend.mjs`), and the text goldens are checked against its writer too
(`tests/fixtures/backend/text-writer.mjs`). Every backend change below is made there as well.

- **Budget (PR 1).**
  - The page-seal check in `ResultSetBuffer.SealLocked` is the only low-memory check there is (no production caller turns
    on `TryReserve`'s). `Skip` only records a reason and does not stop a set storing, and the seal also runs inside
    `Complete()`. So: at a seal under memory pressure a derived set sets a private flag; its next `BeginRow` records
    `Skip(SystemMemory)` and returns null, as a stopped budget does for a query's own set. The seal inside `Complete()`
    sets nothing. The query's budget is not stopped. A derived set whose last seal sees pressure is kept and is not marked
    truncated.
  - `DiffAsync` opens its result as derived, checks `Budget.Stopped` first, checks that neither source was released after
    comparing, and refuses the diff whole when `RowsStored < RowsRead` after `UnifiedDiff.Write` (the writer counts each
    row before trying to store it and stops at the first refusal), so its counts never describe rows it does not show.
  - A new error code, `BUDGET_STOPPED`, added to `errorCodes` in `protocol.ts` (main turns an unknown code into
    `BACKEND_ERROR`) and thrown by Pivot, Diff and Transpose on a stopped budget, with the two sentences under Pivot
    lifecycle. The reasons that reach `Budget.Stop` are the query budget, the global budget and system memory; the row
    limit only marks its set, so the row-limit branches in `PivotAsync` and `TransposeAsync` and the check in
    `PivotChecks.cs` that forces one go.
  - `docs/ipc.md` (the error table, and Result diffs, which says a full diff keeps its first rows), comments in
    `ResultSetBuffer.cs` and `docs/architecture.md` follow.
- **Keep Selected Rows (PR 4).** `keepRows` in `results.view`'s filters: asked for as cell ranges of a view (at most
  `maxFilterRanges`), resolved to at most `limits.transpose.maxRows` base rows, re-sent resolved. Bounds in
  `port-messages.ts` and C#; `FilterChecks.cs`.
- **Transposed text (PR 6).** `results.copy` and `results.export` take `transposed` and an optional header column, with
  bounds in zod and C#. The writer gains a column-major mode, read through per-row page lookups as the transposer reads
  today, so no result is held whole.
  - Each line is one source column: with headers, its name first (field `Column`), then one value per row.
  - With headers the first line names the fields: `Column`, then `Row N`, or the header column's values written as the
    grid shows them (`NULL`, `(blank)`, hex, cut at 128 characters) and then made unique with the suffix the writer's JSON
    keys use (`_2`), in every format; a repeated value's field so differs from the grid's header by its suffix. The header
    column is still written as a line. Without headers (plain Copy, or an export with headers off) only values are
    written.
  - JSON writes one object per source column, keyed the same way, every value as text.
  - A copy block's rows and columns are the selection's, in source coordinates, rotated.
  - The first `limits.transpose.maxRows` rows of the view (or block) are written. `rows` in the answer is the source rows
    written; a new `capped` field counts those left out, and the toolbar says so. Progress counts lines written (source
    columns) of their total, since no source row is finished before the last line.
  - The size estimate sums the same cells plus the new first field. Copy parts stay at 64 ranges.
  - Golden bytes in `tests/fixtures/results-text/cases.json`; `docs/ipc.md`'s text-format section.
- **Restrictions.** `PivotAsync` takes `rows` sources only (PR 10). `DiffAsync` takes `rows` with `rows` only (PR 16).
- **Removal (PR 8).** `results.transpose`, `ResultTransposer`, `TransposeService` and their checks go, in every place
  above, with `docs/ipc.md`, `docs/architecture.md` and `README.md`. The row cap constant moves beside the text writer.

No generic result-management RPC, and no rows in React.

## Delivery

One `claude/grouped-results-<topic>` branch per PR off `main`, `npm run check` before each commit, the affected smoke
suites, and generated pages regenerated in the same PR. Every PR leaves `main` shippable.

**PR 0. Orientation spike: done.** Findings: [grouped-results-orientation-spike.md](grouped-results-orientation-spike.md).
Its prototype stays on the local branch `claude/angry-faraday-053377` for PR 5 to draw from and never lands as it is.
Outcome, accepted by the owner:

- **Approach:** rotation inside `GridView`. The grid keeps working in drawn rows and columns and turns coordinates at four
  seams: the selection it reads and writes, a cell's lookup, the tiles it asks for, and what it reports out (menu targets,
  Open Value, sort and filter). The rotating-handle adapter met the numbers too but cannot freeze names, place controls,
  draw links or highlights, show late header text or grow while rows stream. The stored-transpose fallback is not needed.
- **Numbers** (owner's machine, 4,095 columns drawn over a 4,096-column long-text source): frame p95 1 ms after a jump and
  0.5 ms during wheel either way; main-thread task per jump 47 ms against a 50 ms target; no long task.
- **Settled by PR 5a:** the table grid's first paint is unchanged. The spike's 44 and 59 ms were not reproduced over 24
  runs (none above 46 ms); the 59 ms was a median of five that held one 89 ms sample.

1. **Budget fixes. Merged as #411.** Checks in `DiffChecks.cs`, `PivotChecks.cs` and a store built with a memory probe: a refused or
   memory-pressed derived set leaves the budget open and Pivot usable; pressure at a derived set's last seal keeps it
   whole and unmarked; a partial diff is refused; a budget stopped at a query set's final seal answers `BUDGET_STOPPED`
   with the low-memory sentence.
2. **Stable keys and ordinal names**, as 2a and 2b. No visible change. Checks: a simulated middle removal leaves every
   consumer on the right entry and every name unchanged; listed suites and scripts updated.
   - **2a merged as #413.** It left adapters for 2b to remove: public methods that take a key or an index;
     `ResultSetEntry.index`, `ResultJob.index` and `GridSelection.resultIndex` derived and rewritten when entries move;
     `TabResults.sorts`, the search marks and reveal, the highlights snapshot and `PivotTab.source` still published by
     set index; `PivotInfo.source`, `TransposeInfo.source` and `CompareInfo.left/right` captured as indexes (with
     `leftNumber`/`rightNumber` beside them for names). It added `removeEntry(tabId, key)`, which nothing in the
     interface calls until PR 3. The pivot panel's source follows an original result by ordinal and a derived entry by
     key, as highlights do.
   - **2b merged as #429**, as one PR: it moved the stack's own positional state (`weights`, `collapsed`,
     `focusedIndex`), the grid, panels, contributions, menus, tests and script locators, and removed those adapters.
     `PivotTab` gained `sourceName`, so the panel can name a followed result a new run has not returned yet. The stack
     uses saved weights only while every drawn entry has one, so a result added after a splitter drag still resets the
     stack to equal shares.
3. **Lifecycle. Merged as #441.** Close one entry, the cleanup path, per-result cancellation, per-target search invalidation, run totals,
   weights per entry. Close buttons on stack captions, behind an option that Peek's stack leaves off. The `emptied` flag
   and its `OutputPane` consumers (output view choice, tab list, badge, toolbar, strip, empty state) land here, because
   this is the PR that first lets the last entry be closed. Checks: a source closed under pending work; late answers;
   save and copy leases; the retained-plan lease; re-execution; backend loss; the last entry closed.
   - **What PR 3 settled or left** (`tests/results-lifecycle.test.ts` holds its checks):
     - The M of a grid's "Result N of M" is the run's highest number so far, which a close does not lower, so no grid
       reads "Result 3 of 2". It is not a count of the results now open.
     - The close button calls `ResultsService.removeEntry` directly; there is no command or grid-menu item for closing one
       result yet. "The close actions address the active view or the exact context-menu target" is left to PR 9, when
       closing a Table closes its group.
     - The Results badge still counts every open entry, derived ones included, and hides at zero. Counting original
       groups only is left to PR 9.
     - An emptied run hides the results toolbar, as a closed one does, so Close Results is then reached from the palette
       or a Messages menu while captured plans remain.
     - Weights are shares of the pane, not heights: a closed entry's share is removed and the rest keep their
       proportions, so they grow into the room it leaves.
     - Per-result cancellation is by source: a pivot, transpose or comparison is given up when an entry it reads is
       closed. Each still runs one per tab until PR 10 and PR 16.
     - Open Value drops a value read for an entry closed meanwhile. A Save Results As whose file is not yet chosen when
       its result is closed fails with the backend's sentence; one already writing finishes.
     - No backend change was needed.
4. **Keep Selected Rows. Merged as #442.** Filter, command, chip, limits. What it settled or left:
   - A new Keep filter goes last when a duplicates filter follows the one it replaces (agreed with the owner); otherwise
     it replaces in place.
   - The backend enforces the row limit too (`TOO_LARGE` past 4,095, counted after merging and clipping the ranges) and
     refuses a selection that covers no row (`INVALID_PARAMS`).
   - It is in the grid menu's Filter submenu, not the palette. The mock's Actions menu does not exist yet.
   - The chip counts the rows the view resolved, which differs from the selection only while rows stream.
   - Left: if the view a selection was made on is closed before the filter resolves and the user sorts meanwhile, the
     Keep is dropped with "Could not sort…". The other selection filters share the race; see Follow-ups. Keep Selected
     Rows on Pivot and comparison grids has no check of its own.
5. **Orientation in the grid**, as two PRs, from the spike's prototype (its adapter and its global test switch do not
   land).
   - **5a, no visible change, merged as #430:** a column-axis abstraction, tile shape as a parameter and a column read with every row
     tile, the selection seam and offsets indirection in `GridView`, sort and size painting on any element, and grid
     targets that `menus/targets.ts` reads. It must show `grid.firstPaintMs` unchanged against `main` over repeated runs.
   - **5b, the orientation, merged as #443:** the turned selection, the shared-width layout, the `transposed` and header-column options
     and per-view orientation in the grid state, set by a test hook only until PR 7. Also the name column's drag, fit and
     saved width; names of an empty result; name-cell tooltips; theme keys for the column tint; a transposed locator in
     `ui.mjs`; the benchmark's transposed metrics with entries in `tests/bench/floors.json`, which is where Linux CI
     first measures them; `docs/architecture.md`'s grid bullet.
   - **What 5b settled or left:**
     - The test hook is `__variaGrid.setOrientation`; it writes each view's grid state through the grid. PR 7 adds the
       service's way to set it.
     - `fitColumn` does nothing while transposed and `fitRow` fits a drawn column. The Fit Column command passes a
       column, so it does nothing in a transposed grid until PR 7 passes the target's row.
     - The column tint is 12 %, not the row highlight's 14 %, which failed contrast for NULL text over a striped row.
     - A result with a tone column (a comparison) is never turned.
     - Past the cap means source row 4,095 or later, not "not drawn yet", so a match in a row still streaming in is
       revealed once it is drawn.
     - A transposed grid in the stack keeps its table's height until PR 9 sizes it by drawn rows.
     - The transposed jump task read a median of 58 ms (46 to 79) on the owner's machine while other sessions were
       running on it, against the spike's 47 ms and the 50 ms target; Linux CI read 90 ms against a floor of 170, and
       172 ms on `main` after PR 8 merged. It was measured again then (#460), and it was neither a cost of the port nor
       a regression: the benchmark's wait for a jump's paint looked at the view every animation frame, and those looks
       were counted as the jump's task time for as long as its tiles took to read (a median of 280 ms here, 500 ms on
       CI). Alternating runs of the 5b merge, the PR 6 merge, the PR 7 merge and `main` at `ce9d1659` on the owner's
       machine (20 to 40 % of its CPUs busy with other sessions throughout; it was never quiet) read medians of 56, 65,
       58 and 64 ms with that wait, spreads overlapping, and 33, 35, 34 and 38 ms with a wait that costs nothing, with
       the same mean of 24.5 to 25.0 ms a jump at each: under the 50 ms target, and equal to the 300-column table's
       (31 to 32 ms). The benchmark now waits on the grid's writes (#460); the floor stays at 170 ms, and a jump segment
       that reads over half its floor is measured once more. Linux CI read 56, 71 and 81 ms with the new wait.
       `docs/ipc.md` (Benchmarks) has the trace and the CI runners' spread.
     - `grid.transposed.jumpPaintP95Ms` (448 to 922 ms over 24 runs of Linux CI) has a floor of 2,500 ms since #460; it
       is mostly the fake backend encoding and the worker decoding 0.75 MB pages.
     - Highlights after an orientation change were lost and are fixed, with no automated check until PR 7's smoke
       steps.
     - Not done: changing the shared width by hand, and a pass with a screen reader; see Follow-ups.
6. **Transposed copy and save. Merged as #448.**
7. **Commands switch to the orientation. Merged as #449.** The three transpose commands, the header option, the cap's strip, the Find Next
   message past the cap, a context key for "this grid is transposed" so Transpose reads as a toggle, smoke steps.
8. **Remove the stored transpose. Merged as #452.** What it settled or left:
   - Gone: `results.transpose` (`RpcMethods`, `methodPolicies`, the port request and answer schemas, `ResultsPortHost`,
     the worker protocol and core, `ResultHandle.transpose`, `SqlService`'s dispatch, lane, `MethodNames` entry and
     `TransposeAsync`, the two records in `Contracts.cs`), `ResultTransposer`, `TransposeService` with its strip, the
     `transpose` result kind in `ResultDescriptor` and the descriptor schema, the fake backend's handler, and
     `TransposeChecks.cs`. It was a port method, so it never had a preload method or a schema in `main/validation.ts`.
   - Kept: `limits.transpose.maxRows` (the 4,095 rows a transposed grid draws, a transposed copy or save writes and a
     `keepRows` filter names), now the limit's only member (`maxCells` and `maxRanges` went with the method), and not
     renamed; `ResultTextWriter.MaxTransposedRows`, which `ViewSorter.MaxKeepRows` now reads directly; `RowAccess`,
     `ViewSorter.Merge`, `ColumnNames.Unique` (the overload a pivot calls) and `PivotOutput.GroupName`, which the text writer,
     filters and pivots use. `GroupName`'s hex, 128-character cut and blank rules were checked only through a transpose's
     header column; those checks moved to `PivotChecks.cs`.
   - The backend answers `results.transpose` `METHOD_NOT_FOUND` (`HostChecks`' retired methods) and the port refuses a
     `transpose` request as invalid; `tests/results-transpose.test.ts` now pins that the method, the request, the kind
     and the service stay gone. No protocol version change: main and the backend ship together.
   - `ResultsService` had no branch on the `transpose` kind (only comments), so nothing there changed for PR 9 to
     conflict with. If PR 9 merges after this one it drops its own allowance: `ResultGroup.transposes`, the `'transpose'`
     `ViewKind` and its branches, and the transposes test in `tests/results-groups.test.ts`.
9. **Groups. Merged as #450.** It also takes what PR 3 left: closing through a command or menu target, and a Results badge
   that counts original groups. The group and slot model drawn in the stack (a Pivot under its Table; a transposed item sized by its
   drawn rows), plan-set groups, and the bare mode Peek uses. The renderer's rules land here so every list is representable: Pivot is offered only on Tables, the "Pivot
   source" picker goes, and building a group's Pivot again releases the old one first and then shows the new (not yet
   atomic). `results-smoke`'s pivot steps change here. Checks: no nested pivot from menu, palette, key or service.
   - **What PR 9 settled or left** (`tests/results-groups.test.ts`, `tests/results-pivot.test.ts` and
     `tests/results-stack.test.ts` hold its checks):
     - `sets` stays the one flat list, now in the order drawn; `TabResults.groups` and `comparisons` say what each entry
       is. A slot's identity is its entry key: grid state, sort and filters were already kept by it, so nothing was
       re-keyed. Because the old Pivot is released before the new one is built, a rebuilt Pivot is a new entry with a new
       key in this PR; the slot's `revision` counts them. PR 10 keeps the key.
     - PR 8 merged first, so this PR dropped its allowance for a stored transpose (`ResultGroup.transposes`, the
       `'transpose'` view kind and their branches) when it merged `main`: transposed is how a slot is drawn, never a slot.
     - Provenance is `ResultSlot.sources`: frozen references (entry key, set key, number, name) to a Pivot's Table and to
       a comparison's old and new inputs. The recipe, resolved filters and input rows are PR 10's.
     - The builder keeps one draft per group already (by ordinal, so a re-run's group takes it over), since a builder
       that follows the focus would otherwise lose a draft at every click. It is not yet the Pivot's stored recipe.
     - The builder follows the focus by moving when the focused grid changes; `output.pivot` on a grid focuses it first.
       Focus is published (`TabResults.focused`) and follows a group by ordinal into the next run.
     - Closing a Pivot leaves the focus on its group's Table; closing a group moves it to the next surviving item, else
       the previous. A command closes one view: `output.closeResult` ("Close Just This Result" in the grid menu, whose
       access keys left no letter of "Close Result" free).
     - A bare run is an option of `ResultsService.begin`; its stack draws no caption while it has one grid without
       filters (a caption returns to hold filter chips, which have no other place). Close Results is refused for it too.
     - Pivot is shown disabled, not hidden, for a comparison and a plan set; it is hidden only for a Peek grid
       (`outputGridBare`). No comparison has a source link yet, so "reads closed" has nothing to draw until PR 16;
       the frozen references are there for it.
     - The Results badge counts groups.
     - A transposed item is sized by its drawn rows from each grid's state, read again with every snapshot (PR 7's
       `setOrientation` publishes), so an item whose grid is not mounted resizes too; the Messages strip's room
       (`stackNeed`) counts the same rows.
     - A build and its failure belong to one group: the builder shows "running" and the message only while it is that
       group's, and names the group that is building when it is another's (one build per tab until PR 10).
10. **Atomic Pivot replacement. Merged as #465.** Stored recipe and per-group draft, provenance, replacement that keeps the old Pivot
    until the new one publishes, `results.pivot` from Tables only in the backend, parallel builds with their cap and
    retry, the 1,000 rule. Checks: replacement success, cancellation, failure, late answer, memory overlap.
    - **What PR 10 settled or left** (`tests/results-pivot.test.ts`, `tests/results-derived-jobs.test.ts` and
      `PivotChecks.cs` hold its checks):
      - A rebuilt Pivot keeps its slot's entry key, number, name and place; `ResultsService.addSet` swaps the new result
        into the slot (`replaceSet`), raises `revision`, records the new provenance, publishes at once (not on the next
        frame, so no snapshot points a grid at a released handle), and only then releases the old result. The grid is built again over the new result (the stack keys `ResultGrid` by set key under the
        stable item), so nothing outside the service sees a new key. `run.pivots` is gone.
      - What a rebuild keeps, as the lifecycle says: the focus and the group's selected view, collapse and splitter
        share, the orientation, and the sort keys, user-set widths and header column of each column whose name is unique
        in both results (`uniqueNames`, `carriedState`; GridView measures a carried state's NaN widths as new columns).
        It drops the filters (the toolbar says "Pivot of Result N was built again, so its filters were removed."), the
        selection, the scroll and the transposed layout's per-row widths (its shared width and name column stay). A copy of the old result in progress is
        cancelled. Highlights rebind to the new result by identity, as they do after a sort; that is not a rule the plan
        named.
      - Provenance is `ResultSlot.pivot` (`PivotProvenance`): the recipe, the resolved filters of the view the build
        read (none for stored rows), input rows, and whether the Table was truncated, incomplete or approximate. The
        strip adds "Result N holds only part of its query's rows, so the pivot counts those." for the first two. PR 11
        compares `filters`.
      - The stored recipe and the draft: drafts stay per group by ordinal (PR 9); opening the builder on the Pivot's grid
        (Pivot Results… there, or the toolbar while it has the focus) resets the draft to the Pivot's recipe. Opening it
        on the Table keeps the draft as it is, so an edit not yet built survives there.
      - Failure, cancellation and refusal keep the old Pivot. The builder says why: the backend's sentence; for
        `TOO_LARGE` on a replacement it adds ", or close Pivot of Result N and build it again."; a user's cancel of a
        replacement says "Building was cancelled, so Pivot of Result N still shows its last build." (a first build's
        cancel says nothing, as before). The old Pivot is never released early.
      - Late answers: a build is given up when its run changes, its Table closes or the Pivot it would replace closes
        (closing the Pivot does not let a rebuild come back as a slot the user closed), or a newer build of its group
        starts. An answer that arrives anyway is released through `ResultsService.discard`.
      - `results.pivot` takes only `rows` in `SqlService.PivotAsync` and the fake backend (`INVALID_PARAMS`, "Only a query's
        results can be pivoted.", before anything is reserved). The renderer already refused it in `addSet` and
        `pivotGroup`; `ResultClient` does not check the kind (its handle state has no kind).
      - Parallel builds: `DerivedJobs` (`results/derived-jobs.ts`, one per window as `workbench.derivedJobs`) gives four
        places for pivot builds, which PR 16 gave comparisons too. A free place is taken in the same task, so
        a build starts as before; the rest wait in order and the builder says "Waiting for other pivots and comparisons to finish" (or, while it
        waits to ask a busy backend again, that it is asked again in a moment). `BUSY` and `TOO_MANY_REQUESTS` are asked again after 1, 4 and 16 s, giving the place up while waiting;
        never `TIMEOUT`. Builds of different groups no longer block each other (`PivotTab.busy` is gone, `queued` is
        new); a newer build of the same group cancels the older.
      - A build reads the Table's view the grid showed at the click, held through `ResultsService.holdView` from then
        until the build ends, so a grid re-sorted or re-filtered while the build waits for a place or for a busy backend
        changes nothing it reads, and does not close it. On `VIEW_NOT_FOUND` (the backend evicted it) the build runs once more: over the
        grid's current view when the grid has built another since, else over the same order and filters built again for
        the build alone and closed after it. The grid's own evicted view is not rebuilt here. A second failure says the
        backend's sentence and keeps the old Pivot.
      - The 1,000 rule: a group's first Pivot is refused before the backend is asked when the run's sets plus other
        groups' first Pivots in flight in that tab reach 1,000; a refused build leaves the group's build in flight alone.
        A replacement is never refused by it. The count reads the published snapshot, which may be a frame behind, and
        does not count comparisons in flight; `addSet` still refuses past 1,000 whoever asks, so the worst case is a
        build released unused.
      - A Save Results As of the old Pivot in progress during a rebuild keeps the old result until the save ends (its
        file dialog may still be open, before main checks the result is there), then releases it; its strip sits on the
        rebuilt Pivot's slot until it ends. A Copy of the old Pivot in progress is cancelled, as for a close.
      - Not done, as the plan chose: holding a build back by its budget estimate (the findings' `rows × (16 × keys + 16)`
        suggestion). Two large builds of one query can still refuse each other with `TOO_LARGE`, and for a replacement
        the old Pivot's own memory counts against the new one.
      - **The cap of four stands**, measured again now that a build sorts on several threads (`--pivot-bench --only
        parallel`, same 24-core machine, other sessions running on it; each figure is one cold build, as the bench
        runs it). Five million rows at 1 GiB a query: one build 1.29 to 1.32 s; two at once 2.6 to 3.1 s each (no faster
        than one after the other); four at once 2.3 to 4.0 s each, all four done in 2.5 to 4.1 s against 5.2 s one after
        another; eight refuse three by the budget. Twenty million rows at 8 GiB a query: one 5.3 s, two 17.4 s each, four
        14.4 to 19.4 s, eight 14.9 to 19.4 s with none refused. At 1 GiB a query a 20-million-row build is now refused
        alone (725 MB of keys beside a 347 MB source), in under 0.1 s. So a build no longer runs on one thread while others
        wait: builds at once share the cores, each takes about twice as long, and four together still finish well before
        four in turn. Nothing starves, which is what the cap is for; two at once gain nothing over one after the other, so
        a lower cap would cost little either, but the plan's four is kept. [Pivot performance findings](pivot-performance-findings.md#measured-again-for-pr-10)
        has the table.
11. **Out of date and Update. Merged as #476**, with #487 after it: the mark compares filters by the values they keep,
    so re-ticking the same values or re-making a selection filter from other cells no longer marks a Pivot.
    - **What PR 11 settled or left** (`tests/results-pivot.test.ts`'s "an out-of-date Pivot and Update",
      `tests/menu-commands.test.ts`'s Update Pivot case, `tests/results-stack.test.ts` and `tests/results-tabs.test.ts`
      for the marks, and `results-smoke` step 13b2 hold its checks):
      - Out of date is a pure function of the published run, `pivotOutOfDate(tab, group)` in `ResultsService.ts`: the
        Pivot's recorded `filters` (PR 10's provenance) against `shownFilters`, the resolved filters of the view the
        Table's grid shows (none while it shows its stored rows). A view still being built does not count until it
        shows, so the mark changes with the grid. Nothing is stored for it, so nothing can fall out of step.
      - `sameFilters` compares what filters keep: a `groups` filter by its digest, value and Keep Selected Rows filters by
        their rows in any order, a range by its two rows in order, duplicates by its columns. Filters intersect, so their
        order counts only around a duplicates filter (re-applying a filter moves it last, which changes nothing). Labels
        are not part of it, so naming a filter later changes nothing. (PR 11 compared a `groups` filter by its snapshot
        and value filters by the representative rows picked from the cells selected, so re-ticking the same values or
        re-making a selection filter from other cells of the same values marked the Pivot; the follow-up below fixed it.)
      - Drawn on the Pivot's caption in Stacked, as the mock does: a warning chip "Out of date" and an **Update** button
        ("Update Pivot of Result N"), disabled while the query runs or the Table cannot be pivoted (its sort or filter
        being built, its rows lost). The strip starts with "Out of date: Result N's filters changed after this Pivot
        was built. Update builds it again from Result N as it is filtered now." The mark is one component, `PivotMark`
        (`ResultsStack.tsx`), which PR 13's Tabs layout also draws on its view row while the Pivot is shown; there the
        Pivot's view tab carries a warning dot (described as "Out of date") whichever view is shown.
      - Update is a command, `output.updatePivot` ("Update Pivot"), offered for a group's Pivot or Table grid (the named
        one, else the focused one) while the Pivot is out of date, not being built and its Table can be pivoted. It is
        on the grid menu under Pivot Results… (with the same `when`, disabled until out of date), the caption and the
        palette, not the toolbar. That menu shows up to 24 items and their titles hold only 23 letters (none has k, q or
        x), so no assignment gives each a key. With the owner's agreement Update takes **u** and Pivot Results…, whose key
        was assigned automatically, goes without one; every other key is unchanged. `tests/command-catalog.test.ts` now
        lets an item go without a key only where `keylessItems` names it and every letter of its title is the key of an
        item shown with it. The menu already reaches such an item by arrow keys and type-ahead.
      - `PivotService.update(tabId, key)` builds from the Pivot's stored recipe, never the builder's draft (an edit not
        yet built stays in the draft), through the same `start` path as Build Pivot: the Table's shown view held, one of
        `DerivedJobs`' places with its retries, `addSet`'s atomic replacement, the old Pivot readable until then. A second
        Update while one runs does nothing; Build Pivot meanwhile still gives the older build up, as before.
      - Failure, refusal and cancellation keep the old Pivot and say why with PR 10's sentences, in the builder's error
        for that group and, since the builder may be closed or on another group, in the results toolbar
        (`ResultsService.notify`) while the run is still the one updated; so does any cancel by the user, Build Pivot's too. While a group's Pivot is built (by Update or
        Build Pivot) its caption shows "Building again…" with **Cancel** (`PivotService.cancel(tabId, ordinal)`);
        `PivotSnapshot.building` changes as builds start and end; `PivotService.building(tabId, ordinal)` says whether one of the current run is in flight. Build Pivot during an Update gives the Update up silently.
      - A closed source: closing the Table (which closes the Pivot), closing the Pivot, a re-run, Close Results and the
        tab closing give an Update up through PR 10's rules, its late answer released, and nothing is said. After
        backend loss the Table cannot be pivoted, so Update is neither offered nor sent.
      - Left: rebuilding by itself (PR 17); a Pivot whose last build failed or was cancelled stays marked, with no
        record of the failure on its caption (the toolbar's notice fades).
    - **Filters compared by value** (the follow-up the owner asked for; `tests/results-pivot.test.ts`'s "does not mark a
      Pivot for a filter made again of the same values", `FilterChecks`' lowest-row checks, `DistinctChecks`' digest
      check and `results-smoke` step 13b2's selection and funnel cases hold its checks). No backend method was added;
      `results.view` answers its resolved filters by value:
      - A value filter (`in`, `notIn`, `between`) resolves each value to its lowest base row, whichever cells or rows
        named it, so the same values give the same rows. Rows below a sealed row are sealed, so that row never changes as
        more arrive. A view's first filter reads every row in base order anyway, so it finds them in its own pass
        (`ViewSorter.KeepLowest`: In and NotIn from the binary search that decides a row, Between from its two
        comparisons); a later one sees only the rows kept before it, so `ViewSorter.Lowest` finds them in a pass of its
        own that stops once every value has met its lowest row, at the latest at the highest row named (at most 4,096
        values, one binary search a row).
      - A resolved `groups` filter carries `digest` (`DistinctSnapshot.Digest`), 32 hex digits of a SHA-256 of its column,
        keep or drop, NULL and its frozen rows in value order, hashed once when the snapshot first filters, in 1 KiB chunks
        outside the ticks' lock so nothing is held a row, and kept with the snapshot. A snapshot's rows are each the lowest
        of the rows it grouped holding its value, so two snapshots over the same rows (the grid's other filters keeping
        the same rows) that tick the same values have the same digest. The rows themselves are not sent: there is one
        a distinct value, unbounded.
      - Left: a `groups` filter and a value filter keeping the same values still differ (different ops, compared apart);
        so do snapshots over different rows (another filter of the grid changed between) that freeze to the same rows
        kept, and a snapshot frozen as `notIn` against one frozen as `in` (the result still loading, then complete).
        Each errs towards offering Update. A filter's label reads its values from the resolved rows, so a selection
        filter is named by its value's lowest row (under a CI collation 'a' for a selected 'A'), as the funnel's checklist
        already lists that row's text.
12. **`hasResultSets`** and its consumers. **Merged as #474.** (After PRs 7 and 9, which edit the same contributions). Until then an
    emptied run with captured plans still has `hasResults`, so Find and Save Results As are enabled and do nothing.
    Consumers: `contributions/output.ts`, `pivot.ts`, `transpose.ts`, `PivotService`'s sync,
    the catalogue's preconditions for Save and Find, `PeekCard`.
    - **What PR 12 settled or left** (`tests/menu-commands.test.ts`, `tests/results-lifecycle.test.ts`,
      `tests/results-pivot.test.ts`, `tests/commands.test.ts` and a `results-smoke` step after the actual-plan runs hold
      its checks):
      - `hasResultSets` is `ResultsService.resultSets`, published beside `context` (`hasResults`) by the same pass and only
        when its set of tabs changes: a tab whose run is neither closed nor lost and still holds a set in `sets` (a Table,
        a Pivot, a plan set or a comparison). Captured plans (`planSets`) count only for `hasResults`.
      - Moved to it: Find in Results' and Save Results As' `when` (`contributions/output.ts`) and the catalogue's
        `hasResultSets` precondition on Find Next and Find Previous, so in an emptied run with captured plans they are
        disabled from the palette, a key, the toolbar's tab and a menu left open on a closed grid. The precondition reads
        the active query while the two step through the output a menu or the focus names, so they also check
        `hasResultSets` for that tab in their own `when`.
      - Stayed on `hasResults`: Close Results (its `when` and `results.context`), because captured plans are still there
        for it to release; the context key's own pages; the guides' results-grid reference context, which now sets both.
      - Needed no change, because PRs 7, 9, 10 and 16 rewrote them to read the run's `groups` and `sets`, which an emptied
        run has none of: Pivot (`pivot.ts`, `pivotGroup`), Compare and Compare with Previous (`compare.ts`,
        `CompareService.canPick`/`canCompare`), the transpose commands (`ResultsService.canTranspose`), Close Just This
        Result, and `PeekCard` (which reads `tab.sets`; a bare run cannot be emptied). Checks pin each of them disabled in
        the emptied-with-plans state, and Find and Save on while only a comparison is left (Pivot and Compare off).
      - `PivotService`'s sync now closes the builder by the Compare picker's rule (agreed with the owner on review): once
        the tab's results are gone (Close Results, a finished run with no result, or its last result closed, so an
        emptied run too), the builder's `open` goes false and `open()` refuses, so the next run does not bring it back.
        A run still running is not gone (a re-run releases the old results before its first set arrives), and a run
        whose only result left is a comparison keeps the builder, with no group to pivot. The drafts, kept by group
        ordinal, stay for the next Pivot…. Until then it stayed open, hidden with the grids, and came back with the
        next run, which `results-pivot` pinned for Close Results.
      - The plan's "with only comparisons left, the badge hides" was already true from PR 9 (the badge counts groups).
13. **Tabs layout**, default still Stacked. **Merged as #467.** Tabs, the toggle and setting, view tabs, selection rules, Find Next across
    tabs, the strip rule, focus fallback. Existing smoke suites pin Stacked by setting; a new `grouped-results` suite
    covers Tabs, with its seconds recorded in `scripts/smoke-shards.mjs` and `docs/ci.md` (`results-smoke` is already near
    the split guideline).
    - **What PR 13 settled or left** (`tests/results-tabs.test.ts` holds its checks, with `tests/layout-focus.test.ts` for
      the focus across a switch and `tests/results-stack.test.ts` for the stack's side; `scripts/grouped-results-smoke.mjs`
      its interface steps):
      - The layout is `ResultsTabs` beside `ResultsStack`, chosen by `OutputPane` from `queryResults.grid.layout`
        (`stacked` | `tabs`, default `stacked`). The toggle is `output.toggleResultsTabs` ("Show Results as Tabs"), a
        context key `resultsTabs`, a toolbar button in the results toolbar's last group, and Window › Results as Tabs.
        It is not in the grid menu: that menu has no free access key left (as PR 9 found), so the native menu
        placement every toggle needs went to the Window menu, beside Panel Tabs.
      - After PR 10 (a rebuilt Pivot keeps its entry key and swaps in a new result), the one grid is keyed by its
        result's `setKey`, as the stack's is, so a rebuilt Pivot is drawn over its new result, and the layout tells a
        built Pivot by its result rather than its key: building a result's Pivot again from its Table shows it at once.
      - One `ResultsService` change: `removeEntry` gives the focus to the view the neighbouring group last showed
        (`shownView`), not the next entry of the flat list, so closing Result 2 neither lands on Result 1's Pivot it
        never showed nor makes Result 3 forget its Pivot. `tests/results-groups.test.ts`' check of PR 9's old rule
        changed with it. Otherwise the selected view is the published `focused` entry, falling back to the run's first
        entry; a tab click, an arrow key, Find Next and a close all go through `focusEntry`/`removeEntry`, so commands,
        the toolbar, the menus' Transposed toggle and the builder follow the view shown. A group's tab selects
        `ResultGroup.selected`. Column Profile follows the selected view in Tabs (in Stacked it still follows DOM focus).
      - Streaming keeps the first group selected because `focused` stays unset until a grid or tab takes it. A run that
        inherits a focused ordinal from the previous run (`refocus`, PR 9) selects that group when it arrives, even
        mid-stream: "a tab the user picks stays picked" covers the pick from the last run (the owner confirmed this on 2026-11-13).
      - A Pivot built for the selected group is selected at once (in `ResultsTabs`, not `PivotService`, which PR 10
        rewrites); a rebuilt Pivot already took the focus through `PivotService`. While a comparison or a plan set is selected the builder
        works on a group it can pivot, so a Pivot built for any group is selected. A Pivot that appears for another group
        while a group that can be pivoted is selected, or while a grid of the layout has the focus (the user went back to a
        grid during the build, where PivotService also leaves the focus), selects nothing. A comparison made while the layout is drawn is selected the same way (it is the row's last tab,
        often past the strip's edge).
      - Only the selected grid is mounted, keyed by entry key: switching unmounts the other `ResultGrid`, whose
        `GridShell` disposes its view, pool and registration; its state stays in `TabViewState.grids`. The service's
        retiring of backend views superseded while unmounted is still as before (plan, Rendering and commands).
      - Without the overflow picker, a run of more than `gridLimits.resultTabsDrawn` (64) results draws a window of 64
        result tabs around the selected one with "+N" counts either side; arrow keys and Find Next reach the rest. PR 14
        replaced the counts with the picker (its notes, below). Fewer tabs than that fit a pane, so the tabs drawn sit in a strip that scrolls
        sideways (the wheel too) with no scroll bar and fades a clipped edge. It brings the selected tab into view, clear
        of the fade (`revealLeft`), when the selection or the window moves and when the strip is resized (`observeResize`,
        so in a popout too), never on a plain redraw, so a strip the user scrolled stays put. Comparisons are tabs in the same row, after the groups, with a "Comparison"
        label where view tabs would be.
      - The view row carries the view's facts (rows, columns, batch), its filter chips (the stack's `FilterChips`, now
        shared) and Save Results As; there is no caption. The two rows are `gridLimits.resultTabsHeight` and
        `viewTabsHeight` (28 px each), which `tabsNeed` adds to the grid's floor (or settled rows) for the strip rule.
      - A switch while a grid had the focus (F3 onto another view, Close Just This Result, a comparison shown as it is
        made) focuses the grid shown instead before its effects run, so a reveal makes the match its active cell and the grid's
        keys keep working.
      - Close focus: a closed view moves the focus to the tab selected next in the row it was in (a Pivot's to its
        Table's view tab), else the Results tab, only when the focus was in what closed or nowhere. Tab close buttons
        are not Tab stops (one Tab stop per row); `output.closeResult` from the palette closes the selected view once a tab or
        grid has been used: as in Stacked, it never closes the run's first result for want of one.
      - Stacked's caption close follows the service's new rule: when the closed view had the grid focus, the caption focus
        goes to the view the service focused (the neighbour's last-shown Pivot or Table), so the two never disagree.
      - Switching the layout while a grid has the focus (the palette and the menus give it back to the grid before the
        command runs) gives the focus to the focused view's grid in the other layout once it is mounted (`OutputPane`'s
        `useLayoutFocus`), instead of letting it fall to the page. The stack drawn then opens that view if collapsed and
        scrolls it into view (`revealFocused`, through Find Next's reveal), so its grid mounts; the hand-off gives up as
        soon as the user clicks, wheels or moves the focus. Whether a grid of the pane had the focus is read in the render
        that switches, not kept from focus events, so a grid removed by a re-run or Close Results leaves nothing behind.
      - The strip's wheel is the fixed gesture `resultTabs.scroll` (Control+wheel still zooms), and in forced colours the
        selected tab's focus ring is HighlightText on Highlight.
      - Existing suites that read stacked captions pin Stacked: `results-smoke`, `popout-smoke`, `electron-smoke` and
        `explorer-smoke` through `pinStackedResults` (`scripts/fixtures/results-pane.mjs`), `menus-smoke` in its seeded
        `settings.json`. The new suite took 4 s on Linux and 6 s on Windows in CI (its shard weights).
      - Departures from the mock: one toggle button rather than a Stacked/Tabs segmented pair (the toolbar must fit a
        1,024 px window); no facts row of its own under the view tabs; no streaming dot on a group's tab; the view's
        actions stay in the results toolbar (the mock's Actions menu is PR 15's narrow-pane work).
      - Getting Started: the results guide describes per-grid actions and no layout, so it is unchanged; PR 14, which
        makes Tabs the default, should add the layout there.
14. **Overflow picker and navigation commands; Tabs becomes the default.** The 1,000-group case is a vitest and a
    benchmark case, not smoke.
    - **What PR 14 settled or left** (`tests/results-tabs.test.ts` holds its checks, the 1,000-result picker among them;
      `tests/bench/grid.bench.ts` its benchmark, `node.grid.resultPicker.opsPerSecond`; `scripts/grouped-results-smoke.mjs`
      its interface steps):
      - `queryResults.grid.layout` defaults to `tabs`. A saved `tabs` stays; `stacked` was never saved while it was the default (the settings store drops defaults), so earlier Stacked choices become Tabs. The suites that read stacked captions were
        already pinned (PR 13); `grid-bench` and `pivot-bench` now pin Stacked too. The grouped-results suite's first step
        starts on Tabs and turns it off and on.
      - The overflow picker (`ResultsPicker`, logic in `grid/result-picker.ts`) replaces PR 13's "+N" counts. A button at
        the end of the result row (`.rt-overflow`, "+12") counts the items without a tab shown whole: those outside the
        drawn window and those the strip scrolls out of view or cuts. It is shown only when that count is above zero, as the
        mock has it, and it toggles the picker. The picker is a themed popover in the anchor's window (a portal, placed by
        the Compare popover's `placePopover`, so popouts work): a filter box (a combobox that keeps the focus, with
        `aria-activedescendant`), a virtual listbox of one row per view in the order drawn (a result's Table, its Pivot
        indented under it and marked when out of date, then comparisons), and a footer with the counts. It draws the rows
        in view and two either side (`pickerWindow`), 22 px rows (`--varia-row`, so `.rt-picker-row` joined
        `densityUse.row`), at most 10 shown. The filter keeps rows holding every word typed ("3 piv"). Up, Down, Page Up and
        Page Down move the active row; Enter or a click shows the view and gives its result's tab the focus once the drawn
        window has moved; Escape gives the focus back to the button, or to where Go to Result… ran from (the editor, a
        grid); a press outside, the focus leaving, the window losing the focus or the pane moving windows closes it. It
        opens at the view shown (`aria-current`; the active row is the selected option). A new filter starts again there;
        the run changing underneath keeps the active row. Its row height is read from `--varia-row`, so a denser or
        roomier density keeps the list's maths right.
      - The row still draws at most `gridLimits.resultTabsDrawn` (64) tabs around the selected one, so the DOM stays
        bounded at 1,000 results; the picker, the arrow keys, Home, End, Find Next and the commands reach the rest. The
        result row's `role="tablist"` moved from `.rt-results` onto `.rt-strip`, so the button is not inside a tablist.
      - Commands (catalogue and generated pages regenerated). Owner review on PR 494 chose browser tab keys over SSMS's
        query shortcuts (Ctrl+1 `sp_who`, Ctrl+2 `sp_lock`; those can come back as palette commands that open a query):
        - **Next Result** and **Previous Result**: Ctrl+Alt+Page Down and Up from anywhere (the editor too), and Ctrl+Page
          Down and Up in the Results pane (`resultsFocus && multipleResults`: the focus in the Results pane or its picker,
          and two or more results or comparisons; Windows and Linux, as Next and Previous Query have them). Next and
          Previous Query keep Ctrl+Tab everywhere and Ctrl+Page Down and Up otherwise, so Messages, the plan and a query
          with one result keep the query keys.
        - **Go to Result 1** to **8** and **Go to Last Result** (`output.goToResult1`…, `output.goToLastResult`): Ctrl/⌘+1
          to 9 under the same condition; otherwise the same keys run **Go to Query 1** to **8** and **Go to Last Query**
          (`document.goToQuery1`…, in tab order across editor groups), as a browser's do. The id rule allows a trailing
          place number.
        - **Next Result View** and **Previous Result View**: Ctrl+Alt+Shift+Page Down and Up with `!textInputFocus` (Monaco
          binds those keys to column selection on Windows, recorded in the Monaco allowlist); Tabs only, and unavailable
          on a comparison or a result without a Pivot.
        - **Go to Result…**: Ctrl/⌘+Shift+O (VS Code's Go to Symbol; Ctrl+Alt+letters are reserved for AltGr), Window
          menu after Results as Tabs, access key G; Tabs only.
        - All need `hasResultSets`. Next and Previous Result and Go to Result N work in Stacked too: they select through
          `focusEntry`, bring the Results pane forward (`view.toggleResultsPane` when Ctrl+R hid every output pane, `window.results` when it is closed or behind another, the popout's tab when it is in a window), and `stackReveals` (a pending request a stack mounting within 2 s takes) asks the stack to open the view if collapsed and scroll to it, as Find Next does;
          its grid takes the focus once mounted when the focus was in the stack. In Tabs they leave the focus where it
          was, except that a grid's focus moves to the grid shown (PR 13's hand-off) and a focused tab's moves to the tab
          now selected in its row, also when that tab unmounted (another result's view tabs, the drawn window moving).
          Next and Previous Result wrap round, and a result shows the view it showed last. None has a menu placement but
          Go to Result… (`menus.test.ts` lists them with the keyboard-only commands); all are in the palette. Go to
          Result… waits up to two seconds for a layout not drawn yet (`pickerRequests`), then lapses, so a layout drawn
          much later never opens the picker by surprise.
      - Short panes (owner review): the results pane can be dragged to its 100 px minimum, and a window made smaller
        takes the results pane's room first, which left the grid 8 px under the two rows of tabs at 1024×700 with a
        banner. `tabsFold` keeps the grid's header and two rows: the rows of tabs share one row (`data-fold="one"`, the
        facts left to the status line), then go (`data-fold="none"`, the grid alone, as Stacked's one set gives up its
        caption; a tab that had the focus hands it to the grid). `backend-smoke` runs its short-pane step on Tabs (no Stacked pin).
        The fold is measured before the first paint, so a new run in a short pane never shows both rows for a frame; in
        the shortest pane the picker is placed under the top of the layout, and a pick or Escape gives the grid the focus
        in a tab's place. The picker follows its anchor's size and closes when the anchor goes (Ctrl+R hides the pane);
        Go to Result… asked again while it is open keeps where it was first opened from for Escape.
      - Getting Started: the results guide has a new section, Move between results, on the tabs, the picker, the commands
        and the layout setting, with live references.
      - Inherited from PR 13: the grouped-results suite's CI seconds were already measured (4 s Linux, 6 s Windows), and the
        Pivot view tab's out-of-date dot was already drawn (`rt-dot`), so neither needed work here.
      - Departures from the mock: the picker's button reads "+N" and a chevron, without the mock's count of every item;
        the Pivot row reads "Pivot" under its result rather than repeating the result's name; the mock's short pane hides
        the facts and strips at 330 px, where this folds the rows of tabs only when the grid would lose its rows.
      - Left: the SSMS query shortcuts' procedures as palette commands; the 1,440 px Tabs button cutoff, narrow panes,
        Save names and popouts stay PR 15's.
15. **Save names, narrow and short panes, popouts.** After PR 14. It inherits two things from PR 13: the Tabs toolbar
    button is hidden at 1,440 px and below, which leaves the Window menu as the only way to change layout there, and
    the results toolbar's search box is squeezed in a narrow window. PR 14 folds Tabs' rows of tabs in a short pane
    (`tabsFold`); what else a short pane hides (the mock's 330 px rules) is still this PR's.
16. **Compare picker**, Tables only, with the backend restriction, the pairing fixtures, and parallel comparisons.
    **Merged as #466.** Changed since: #489 fixed Compare failing on results matched by whole rows (the answer has no
    `key` member then), and #490 turned the picker into a popover beside what opened it, from the options mocked in
    #488; it no longer takes the Pivot builder's place.
    - **What PR 16 settled or left** (`tests/results-compare.test.ts`, `tests/compare-pairing.test.ts`,
      `tests/results-derived-jobs.test.ts`, `DiffChecks.cs` and `results-smoke` step 14g hold its checks):
      - The picker is a side panel in the builder's place (`ComparePanel`): opening Compare closes the Pivot builder and
        Pivot… closes the picker. It is opened by a new command, `output.compare` ("Compare Results…" in the palette, a
        Compare toggle in the results toolbar). Its grid-menu title is **Compare…** (p): to free p, Copy
        Column Name took y and the Transpose submenu n.
      - Targets are a radio group, not the mock's listbox: the keyboard lint allows no key listener of its own, and radios
        bring the arrow keys. The default target is the Table Compare with Previous Result would pick, else the first.
      - The picker stays on the Table it was opened on when the focus moves (the mock closes it); Compare… on another grid
        moves it. Only the user closes it (Close, the head's close button, the toolbar toggle, Pivot…). It follows its
        Table and target by group number into the next run, waiting while the query runs; while the run has no such
        Table it says so and offers nothing. A target that closes leaves it with nothing picked. It goes only with the
        tab's results: the tab closing, Close Results, a finished run with no result, or its last result closed (nothing
        to show it beside). A group whose number now holds a plan set counts as no Table. Cancel is said in the picker.
      - While its pair runs the picker offers Cancel and shows a failure there; success leaves it open (its button then
        reads Show It) and focuses the comparison unless the user moved the focus meanwhile (`focusStamp`). The run's comparison of the same two inputs,
        the same way round and exact-text choice is shown (Show It), not made again.
      - Parallel comparisons go through PR 10's `DerivedJobs`, the workbench's one instance that Pivot builds use (this PR's
        own `DerivedWork` was dropped when PR 10 landed first): four builds and comparisons at once, the rest queued in
        order, a `TOO_MANY_REQUESTS` or `BUSY` refusal retried after 1, 4 and 16 s with the place given back meanwhile,
        never `TIMEOUT`. The Pivot builder's wait now says "other pivots and comparisons".
      - The 1,000 rule counts this run's comparisons and first Pivots in flight in both services (`compareFullText`, and
        the Pivot refusal): each takes the other's `adding(tabId)`, wired in the workbench.
      - The backend refuses any kind but `rows` on either side with `INVALID_PARAMS` and `SqlService.NotTablesSentence`;
        the fake backend does the same, and now pairs by wire and `OrdinalIgnoreCase` as `ResultDiffer.Pairs` does
        (it paired by lower-cased name only). No protocol change.
      - The backend (`ResultDiffer.Pairs` through `OrdinalNames`), the renderer and the fake backend compare names with
        one fixed table, `src/shared/ordinal-casing.ts`: `OrdinalIgnoreCase` code point by code point, as the generating
        runtime cased it. Neither `OrdinalIgnoreCase` itself nor `toUpperCase` could be shared: each follows its own ICU
        and so its own Unicode version (and JavaScript maps ſ to S and ı to I). `DiffChecks.OrdinalCasing` checks the table
        against the runtime wherever it knows the letter and against the count and checksum its generator wrote into it (a
        lost range shows); `VARIA_UPDATE_ORDINAL_CASING=1` rewrites it. `tests/fixtures/compare-pairing` has cases
        for the Kelvin sign, ı, ſ, a letter past the BMP and one whose full upper case is two letters. A target sharing more columns than a diff can show
        (`ResultDiffer.MaxPairs`) is not offered.
      - Source links: the strip starts with the two inputs from `ResultSlot.sources`, each a link while an entry of that
        key still shows that set key, else "Result N (closed)". A link focuses the input's grid, which scrolls the stack
        to it; a layout that mounts the grid only when selected (Tabs, PR 13) gets the focus a frame later. The strip
        also says that the inputs' filters and sorts were not applied.
      - Compare… from the toolbar acts on its own tab's focused grid, never another tab's; from the palette with no grid
        focused, on the active document's focused result (as Pivot… does). Compare with Previous Result now falls back the
        same way.
      - On success the keyboard focus goes from the Compare button to the comparison's grid (`focusResultGrid`, looked for
        over the next few frames while the stack draws it), unless the user put it somewhere else meanwhile. While its
        comparison runs the button is `aria-disabled`, not disabled, so the focus stays on it and a failure meets it there.
      - Left: a target's row count in the picker is its stored rows, not its view's; the picker does not warn when an
        input is still loading (such a Table is simply not offered). A re-run releases the old results before any new
        one arrives, so the results view (the picker with it) is not drawn until the first set comes, and a keyboard focus
        inside it falls to the page, as it does from a grid; the picker's state waits in `CompareService` meanwhile.
    - **Compare popover (after PR 16).** The owner found the side panel unintuitive and wordy and chose a popover from the
      mocks in `prototypes/results-pane/compare-picker-options.html` (option B). `ComparePopover` replaces `ComparePanel`
      and supersedes the side-panel and stay-open bullets above (`tests/compare-popover.test.ts`, `results-smoke` 14g):
      - It opens beside its trigger, in that window: under the toolbar's Compare (which passes itself as the command's
        `anchor`; the picker records `anchor: 'toolbar'`), else at the top right of the Table's grid. It no longer takes
        the builder's slot, so Compare no longer closes the Pivot builder; Pivot… still closes the popover.
      - Transient: Escape, Close and the close button close it and return the focus to the trigger (the button, else the
        grid); the toolbar's Compare (`aria-expanded`), a press outside, its window losing the focus and the focus moving
        out by key (not into another dialog) close it too (`output.compare` is offered only while the Results panel shows); it closes once its comparison is
        shown (Compare or Show It), when the query runs again, when its Table closes, or with the results; also when it is
        no longer drawn (its pane hidden, another document shown) and when its pane moves window (`windows.onDidAdopt`).
        It is placed by `placePopover`, held inside the window and, on a grid, to the grid's part in view. The follow-into-
        the-next-run, waiting and "no such Table" states are gone. A comparison running when it closes goes on, and its
        failure goes to the toolbar.
      - `CompareService` remembers, per tab, the choice made on each group (target group number and swap) and the last
        exact-text choice, and offers them when the popover opens on that group, in this run or a later one, while the
        target is offered. Only a pick, a swap, Exact text or Compare records; opening does not. Close Results keeps it;
        the tab going (`ResultsService.release`) forgets it.
      - Content says only what applies: no list with one target (just the two sides), an amber "N of M columns" on a
        target with a column of either result left out (M counts a pair once), "Not compared" only when columns are left out (the pairing rule in its
        ⓘ), the sorted-or-filtered warning only while it holds, the comparison's name in the Compare button's tooltip.
        Enter on a target or Exact text compares.
17. **Pivots follow filters.** Automatic when the Table's result stores at most 500,000 rows and the Pivot's last build
    took under 250 ms (each build reserves and keys the whole source, not the filtered rows); Update otherwise. Only a shown Pivot rebuilds; another
    stays marked and rebuilds when shown. A newer filter change cancels the build in flight.
18. **Integration.** Remove what nothing uses, update `docs/results-tools.md`, `docs/architecture.md` and `README.md`,
    review Dark and Light, short panes, docked, floating and popped out.

Follow-ups, not in this work: Pivot with Pivot comparison (explicit diff key); a Plan tab inside a group; uncapped
transposed columns; value-based filters that survive a Pivot rebuild; opening one view in its own window; a selection
filter (Keep Selected Rows included) that survives its view closing while it resolves; changing a transposed grid's
shared width by hand; a screen reader pass over the transposed grid; a Find match past the transposed cap, which shows
the cap's strip and is then used up, so Find Next must be pressed again to reach the next match.

## Validation

| Area | Checks to extend |
| --- | --- |
| Budgets | backend `DiffChecks.cs`, `PivotChecks.cs`, result store checks |
| Identity and cleanup | `tests/results-service.test.ts`, `tests/result-client.test.ts`, `tests/results-port.test.ts` |
| Pivot slot | `tests/results-pivot.test.ts`, backend `PivotChecks.cs` |
| Orientation | grid tests, `tests/results-orientation.test.ts`, `tests/results-toolbar-transpose.test.ts`, `tests/results-transpose.test.ts` (the stored transpose stays gone), text-writer goldens, grid benchmark |
| Filters | backend `FilterChecks.cs`, `tests/results-service.test.ts` |
| Comparisons | `tests/results-diff.test.ts`, backend `DiffChecks.cs`, shared pairing fixtures |
| Search and highlights | `tests/results-search.test.ts`, `tests/results-highlights.test.ts` |
| Commands, settings, jobs, Peek | command and menu tests, `tests/results-jobs.test.ts`, settings catalogue, `tests/explorer-peek.test.ts` |
| Interface | `scripts/results-smoke.mjs`, the new grouped-results suite, popout and menus smoke, grid, theme and metric lints |

Follow `docs/testing.md` for live coverage and `docs/ci.md` for condition-based waits and smoke timings.

Done means:

- Results show as groups in Tabs or Stacked with per-view state kept across switches, layouts and unmounting.
- Every close releases only what it owns; nothing is recreated by a late answer.
- A group has at most one Pivot, replaced atomically, built only from its Table; a Table or Pivot can be shown transposed
  with no stored copy, and copies and saves as shown.
- Tables that share a column can be compared, the comparison names what it left out, and it outlives its sources.
- A derived result that cannot be stored never disables Pivot for the rest of the run.
- Search, copy, save, sort, filter, profile, highlights, Messages, plans, keyboard use, popouts and Peek keep working.
- Partial input, truncation, approximation, cancellation, backend loss and both closed states are explicit.
- Documentation and generated catalogues describe what shipped.
