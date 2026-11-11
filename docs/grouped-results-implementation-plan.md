# Grouped results implementation plan

Give each original query result a group that owns its Table and, when built, one Pivot. Show the groups as tabs with one
active grid or stacked as today; the user chooses. Transpose becomes a way of drawing a Table or a Pivot, not a stored
result. Comparisons sit beside the groups and keep their own snapshots.

Revision 6 (2026-11-10). It follows the owner's decisions, three independent reviews against the code, and the
orientation spike's findings. The
[Grouped views mock](../prototypes/results-pane/grouped-results-ui.html) is the visual reference for the Tabs layout only:
palette, type, row and header heights, toolbar structure, side panels, Messages strip. Where it disagrees with this
document it is wrong: Transpose as a stored inner tab, no Stacked layout, a picker that needs matching columns, comparing
pivots and transposes, a native `<select>` for overflow, a cap of 8 comparisons, "Comparison N" names, and the notice that
pivots keep the rows they were built from. Its HTML, data, simplified builder and Save placeholder are prototype code.

The [pivot performance investigation](pivot-performance-follow-up.md) is separate work; PR 17 cannot start until it has
produced the measurements that set its threshold.

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
  Default: Stacked until the overflow picker exists, then Tabs (PR 14).
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
- A grid has at most one; a new one replaces it, in the same place among the filters. It counts as one of the 16.
- Its chip reads "12 selected rows": the rows it names, though a later filter (duplicates, say) may show fewer.
- It works wherever the other selection filters do: Tables, Pivots and comparisons.
- It names no column, so header funnels do not mark any. Code that tells filters apart by their `rows` or `column` must
  handle it: `ResultsService.ts` around lines 695, 1037, 1174 and 1215 and `filterLabel`; `column-filter.ts`
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
  and the grid's accessible name call a pivot at position 4 "Result 4"), PR 2 fixes that number at the position it was
  appended at, for its life. So PR 2 changes nothing visible; PR 15 gives derived views their own names.
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
  `ColumnProfilePanel`, `PivotService`, `PivotPanel`, `TransposeService`, `CompareService`, `OutputPane`'s profile target.
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

`results.pivot`, `results.diff`, `results.view` and `results.transpose` are results-port methods: their places are
`RpcMethods`, `methodPolicies`, `ipc/port-messages.ts`, `main/backend/results-port.ts`, the worker protocol and client,
and the C# records and dispatch. `results.copy` and `results.export` also have zod schemas in `main/validation.ts`.

Smoke suites and the grid benchmark run on a fake backend with its own filters, pivot, diff, transpose, copy and export
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

**PR 0. Orientation spike: done.** Findings: [grouped-results-orientation-spike.md](grouped-results-orientation-spike.md)
(on the spike branch `claude/angry-faraday-053377` until it merges; its prototype never lands as it is). Outcome, accepted
by the owner:

- **Approach:** rotation inside `GridView`. The grid keeps working in drawn rows and columns and turns coordinates at four
  seams: the selection it reads and writes, a cell's lookup, the tiles it asks for, and what it reports out (menu targets,
  Open Value, sort and filter). The rotating-handle adapter met the numbers too but cannot freeze names, place controls,
  draw links or highlights, show late header text or grow while rows stream. The stored-transpose fallback is not needed.
- **Numbers** (owner's machine, 4,095 columns drawn over a 4,096-column long-text source): frame p95 1 ms after a jump and
  0.5 ms during wheel either way; main-thread task per jump 47 ms against a 50 ms target; no long task.
- **Still open, for PR 5a to settle:** the table grid's first paint read 44 and 59 ms on the spike build against 40 and
  36 ms on `main`; two runs cannot call that noise. The Linux CI runner is unmeasured until a branch is pushed.

1. **Budget fixes.** Checks in `DiffChecks.cs`, `PivotChecks.cs` and a store built with a memory probe: a refused or
   memory-pressed derived set leaves the budget open and Pivot usable; pressure at a derived set's last seal keeps it
   whole and unmarked; a partial diff is refused; a budget stopped at a query set's final seal answers `BUDGET_STOPPED`
   with the low-memory sentence.
2. **Stable keys and ordinal names**, as 2a and 2b. No visible change. Checks: a simulated middle removal leaves every
   consumer on the right entry and every name unchanged; listed suites and scripts updated.
3. **Lifecycle.** Close one entry, the cleanup path, per-result cancellation, per-target search invalidation, run totals,
   weights per entry. Close buttons on stack captions, behind an option that Peek's stack leaves off. The `emptied` flag
   and its `OutputPane` consumers (output view choice, tab list, badge, toolbar, strip, empty state) land here, because
   this is the PR that first lets the last entry be closed. Checks: a source closed under pending work; late answers;
   save and copy leases; the retained-plan lease; re-execution; backend loss; the last entry closed.
4. **Keep Selected Rows.** Filter, command, chip, limits.
5. **Orientation in the grid**, as two PRs, from the spike's prototype (its adapter and its global test switch do not
   land).
   - **5a, no visible change:** a column-axis abstraction, tile shape as a parameter and a column read with every row
     tile, the selection seam and offsets indirection in `GridView`, sort and size painting on any element, and grid
     targets that `menus/targets.ts` reads. It must show `grid.firstPaintMs` unchanged against `main` over repeated runs.
   - **5b, the orientation:** the turned selection, the shared-width layout, the `transposed` and header-column options
     and per-view orientation in the grid state, set by a test hook only until PR 7. Also the name column's drag, fit and
     saved width; names of an empty result; name-cell tooltips; theme keys for the column tint; a transposed locator in
     `ui.mjs`; the benchmark's transposed metrics with entries in `tests/bench/floors.json`, which is where Linux CI
     first measures them; `docs/architecture.md`'s grid bullet.
6. **Transposed copy and save.**
7. **Commands switch to the orientation.** The three transpose commands, the header option, the cap's strip, the Find Next
   message past the cap, a context key for "this grid is transposed" so Transpose reads as a toggle, smoke steps.
8. **Remove the stored transpose.**
9. **Groups.** The group and slot model drawn in the stack (a Pivot under its Table; a transposed item sized by its
   drawn rows), plan-set groups, and the bare mode Peek uses. The renderer's rules land here so every list is representable: Pivot is offered only on Tables, the "Pivot
   source" picker goes, and building a group's Pivot again releases the old one first and then shows the new (not yet
   atomic). `results-smoke`'s pivot steps change here. Checks: no nested pivot from menu, palette, key or service.
10. **Atomic Pivot replacement.** Stored recipe and per-group draft, provenance, replacement that keeps the old Pivot
    until the new one publishes, `results.pivot` from Tables only in the backend, parallel builds with their cap and
    retry, the 1,000 rule. Checks: replacement success, cancellation, failure, late answer, memory overlap.
11. **Out of date and Update.**
12. **`hasResultSets`** and its consumers: `contributions/output.ts`, `pivot.ts`, `transpose.ts`, `PivotService`'s sync,
    the catalogue's preconditions for Save and Find, `PeekCard`.
13. **Tabs layout**, default still Stacked. Tabs, the toggle and setting, view tabs, selection rules, Find Next across
    tabs, the strip rule, focus fallback. Existing smoke suites pin Stacked by setting; a new `grouped-results` suite
    covers Tabs, with its seconds recorded in `scripts/smoke-shards.mjs` and `docs/ci.md` (`results-smoke` is already near
    the split guideline).
14. **Overflow picker and navigation commands; Tabs becomes the default.** The 1,000-group case is a vitest and a
    benchmark case, not smoke.
15. **Save names, narrow and short panes, popouts.**
16. **Compare picker**, Tables only, with the backend restriction, the pairing fixtures, and parallel comparisons.
17. **Pivots follow filters.** Automatic under a source-row threshold from the performance investigation (each build
    reserves and keys the whole source, not the filtered rows); Update above it. Only a shown Pivot rebuilds; another
    stays marked and rebuilds when shown. A newer filter change cancels the build in flight.
18. **Integration.** Remove what nothing uses, update `docs/results-tools.md`, `docs/architecture.md` and `README.md`,
    review Dark and Light, short panes, docked, floating and popped out.

Follow-ups, not in this work: Pivot with Pivot comparison (explicit diff key); a Plan tab inside a group; uncapped
transposed columns; value-based filters that survive a Pivot rebuild; opening one view in its own window.

## Validation

| Area | Checks to extend |
| --- | --- |
| Budgets | backend `DiffChecks.cs`, `PivotChecks.cs`, result store checks |
| Identity and cleanup | `tests/results-service.test.ts`, `tests/result-client.test.ts`, `tests/results-port.test.ts` |
| Pivot slot | `tests/results-pivot.test.ts`, backend `PivotChecks.cs` |
| Orientation | grid tests, `tests/results-transpose.test.ts`, `tests/results-toolbar-transpose.test.ts`, text-writer goldens, grid benchmark |
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
