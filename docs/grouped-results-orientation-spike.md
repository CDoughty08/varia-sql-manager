# Orientation spike: findings

PR 0 of the [grouped results plan](grouped-results-implementation-plan.md) (revision 5). It asks whether a results grid
can draw a Table or a Pivot transposed, with nothing stored, and by which of two approaches. This document answers each
exit criterion, gives the measurements, and says what the answer means for PRs 5 to 8. The prototype is not merged and
stays on the local spike branch; the owner accepted the recommendation and all six decisions below on 2026-11-10.

## Recommendation

**Transposed as a display orientation passes. Build it as rotation inside `GridView` (approach a). The fallback is not
needed.**

Both approaches met every pass number on the owner's machine. They differ in what they can show:

- The rotating `ResultHandle` adapter (approach b) leaves the grid untouched and is small, but an untouched grid cannot
  freeze the column names, cannot put sort and filter controls anywhere, has no link cells, no row highlight, no row-size
  mark, no asynchronous header text and no growing column count. Each of those needs a new hook in `GridView`, and with
  those hooks the adapter no longer leaves the grid untouched. It also has to be built again every time rows arrive,
  which took over a fifth of the main thread while a result streamed.
- Rotation inside `GridView` answers every criterion. The grid keeps working in drawn rows and columns for geometry,
  pools and scrolling, and turns coordinates at four seams: the selection it reads and writes, a cell's text lookup, the
  tiles it asks for, and what it reports out (menu targets, Open Value, sort and filter). The table path keeps its
  behaviour and its numbers.

One thing the adapter got right is kept: a transposed view spans few source rows and many source columns, so it reads
tiles of 32 rows by 128 columns, not 128 by 32. The in-grid prototype reads that shape too.

## What was built

On branch `claude/angry-faraday-053377`, cut from `main`, not pushed.

| Piece | Where |
| --- | --- |
| Approach a: `transposed`, `headerColumn` and `onBeyondCap` options of `GridView` | `src/renderer/src/grid/GridView.ts` |
| A selection turned, its own inverse | `rotateSelection` in `grid/selection.ts` |
| Shared-width column layout that grows, with at most 256 widths of its own | `grid/uniform-layout.ts`; `ColumnAxis` in `grid/layout.ts` |
| Tile shape as a parameter, and a column read with every row tile (the header column) | `grid/tiles.ts`, `grid/data.ts` |
| Menu targets in source rows and columns | `registerGridTarget` and `gridTarget` in `grid/anchor.ts`; `menus/targets.ts` (`OutputTarget.row`) |
| Approach b: the turned handle, its selection and its search marks | `grid/rotated-handle.ts` |
| A test-mode switch that draws every results grid as `table`, `rotated` or `adapter` | `GridStats.setOrientation`, `window.__variaGrid.setOrientation(mode, headerColumn?)`, `grid/ResultGrid.tsx` |
| Shape `T1`: 4,096 `nvarchar(60)` columns of long text | `tests/fixtures/backend/shapes.mjs` |
| The benchmark's transposed segments (`npm run bench:grid`; `-- --transposed` runs them alone) | `scripts/grid-bench.mjs` |
| Unit checks of both approaches, 18 cases | `tests/grid-orientation.test.ts` |
| A scripted walk through the built app with screenshots, not in CI | `scripts/orientation-spike.mjs` |

To look at it: `npm run check`, then `node scripts/orientation-spike.mjs` (screenshots land in
`artifacts/orientation-spike/`), or start the app in test mode and call `window.__variaGrid.setOrientation('rotated')`.

Checked on the spike branch: `npm run check`; `results-smoke` and `menus-smoke` with the switch at `table` (the first
run of `results-smoke` failed at a stack splitter's mouse drag and passed when run again; the step does not touch the
grid); the walk-through's seven checks.

Prototype shortcuts, none of which is a design answer: the orientation is one global test switch, not per-view state; the
frozen name column's width is computed and cannot be dragged; the column tint is an overlay at half opacity, not a theme
key; the stack and Copy do not know about the orientation; an empty result transposed shows no names.

## The two approaches

| | a. Rotation inside `GridView` | b. Rotating `ResultHandle` adapter |
| --- | --- | --- |
| Grid code changed | About 350 lines in `GridView.ts`, plus three small helpers | None |
| Coordinates the rest of the app sees | The source's, unchanged: `GridViewState.selection`, marks, highlights, callbacks | The adapter's: the shell translates the selection both ways and keeps a second grid state |
| Column names | Frozen first column | An ordinary first column, which scrolls away under 4,095 columns |
| Sort and filter controls | In the frozen name cell | None possible; menu only |
| Using Column as Headers | Header text written when its tile arrives | Descriptor is fixed: the grid must be built again once every header has been read |
| Rows streaming in | Column count grows in place | Grid built again at each growth |
| Highlight, row size, links, type | All drawn | None without new grid hooks |
| Tile cache | 32 × 128 tiles of the source | 32 × 128 windows of the source, a turned copy of each beside it |
| Risk | Branches on hot paths of the table grid | None to the table grid |

The risk in (a) is measured below: the table grid's frame and task times did not move; its first paint needs another look.

## Exit criteria

Each answer says what the prototype does (**P**) and what PR 5 or 7 still has to do (**To do**).

### Approach

Rotation inside `GridView`, for the reasons above.

`GridView` gains one fixed option, `transposed`. Changing the orientation builds another view, as a tab switch does;
scroll offsets and widths of the transposed view live in `GridViewState.transposed`, so each orientation keeps its place.
Inside the view, "row" and "column" mean drawn row and column everywhere geometry is concerned: the scroll model, pools,
ring, hit test, visible range and reveal are untouched. The seams:

1. **Selection.** `selection()` returns the state's selection turned (`rotateSelection`, memoised per change); `select()`
   turns it back before storing and reporting. `pressSelection`, `dragSelection`, `navigate` and `windowRanges` run
   unchanged on the drawn selection. The state always holds source coordinates.
2. **Cell lookup.** `paintCell` reads text, flags, link, search marks and diff marks at (drawn column, drawn row).
3. **Reads.** `GridData.ensure` and `prepare` get the frame's range turned back, and tiles of 32 × 128.
4. **Out.** Open Value, sort, filter, Fit and menu targets report source rows and columns.

### Gutter and header

- **Frozen first column:** each drawn row's source column name, then its SQL type in the muted small text a header uses
  when "show column types" is on. This is the existing sticky row-number column, wider, so it costs no new layer. Its
  width fits the widest name and type plus the two buttons, between 64 and 320 px.
- **Header row:** one header per drawn column, reading "Row N" (the row's position in the view, from 1) or the header
  column's value. It also carries the row's highlight colour and its row-size bar.
- **Corner:** Select all, as now.
- **Sort and filter controls:** in the frozen name cell of the column they act on, with the same glyphs, visibility rules
  (shown on hover, kept while sorted or filtered) and callbacks as a header's. The funnel's popover opens under the name
  cell. `aria-sort` goes on the row's header. Headers of drawn columns have neither button: a drawn column is a row, and
  there is nothing to sort a row by.
- The ordinal of a source column (what the stored transpose shows as its row number) is not shown.

**P:** all of it, checked in the app (sorting twice from the `id` name's button reorders the drawn columns).
**To do:** drag the corner's right border to size the name column, double-click to fit, and keep the width in the view's
state; tooltips on name cells; the names of an empty result.

### Using Column as Headers

A header's text is no longer read once from the descriptor. Each frame, a transposed header asks for its row's value in
the header column from the tile cache: if the tile is there it shows the value (`NULL`, `(blank)`, cut at 128
characters, repeats included); if not, "Row N". The header column's tile column is added to every frame's read plan
(`GridData.also`, the mechanism that already reads a live table's tone column with its rows), so the text arrives with
the cells and the frame that paints them rewrites the header. The cost is one string comparison per visible header a
frame.

Headers do not size columns (see Widths), so late text moves nothing. The header column is still drawn as a row. After a
sort or filter the new view's tiles are read and the headers follow.

**P:** all of it; in the app the headers of a result sorted descending show the names of rows 5,999, 5,998, …
**To do:** binary values as hex need no work (tiles already hold the grid's text for binary).

### Streaming

`UniformLayout` holds a count, a shared width and a small sorted list of overrides. A column's offset is its index times
the shared width plus what the overrides before it add. Changing the count is one assignment, so the frame sets it from
`rowsAvailable` every time; nothing is rebuilt and nothing drawn moves. Open-ended selection blocks grow as they do in a
table. The scroll range holds 4,095 columns at the 3,000 px maximum (12.3 million of 15 million px).

**P:** all of it. A grid mounted over 2 rows shows 40 columns after the source grows, without being built again. While
4,095 rows streamed at 1,000 a second in pages of 64, the main thread was 7 % busy in-grid against 6 % for the same
result as a table; the adapter, built again at each of the 64 growth steps, took 22 %.

### Re-sort and re-filter while transposed

They are the existing path: `ResultsService` builds the view, the shell calls `prepare` and `swap`. The selection is in
source coordinates, so `swap`'s remap needs nothing new. What differs:

- A new order or other rows put a table at its first row. Transposed, rows run across, so the grid goes to its first
  drawn column and keeps its vertical place (which column the user was reading).
- Widths the user gave to positions are dropped, because positions now hold other rows.
- The drawn column count follows the view's row count, so filtering under 4,095 rows removes the cap strip.

**P:** sort from the name cell, the swap, the return to the first column, in the app. Filter uses the same swap and was
not exercised separately.

### Widths and Fit Column

One shared width with bounded overrides.

- **Shared width:** from the widest type hint at first, then once from the widest value of the first 128 rows across all
  columns (the measure a table already makes), never under a header's "Row 4,095" and never over 240 px. A drawn column
  holds a value of every source column, so its natural width is the widest of them; the cap stops one `nvarchar(max)`
  column from making every drawn column 400 px wide.
- **Overrides:** dragging a header's border, or fitting, gives that drawn column a width of its own. At most 256 are
  kept, the newest; a re-sort or re-filter drops them.
- **Fit Column** (double-click on a header's border, and the command on a cell) fits that drawn column, which is one
  source row, to its header and its widest value: one worker measure of a single row across the columns. It does not
  mean "fit the source column": a source column is a drawn row, and rows have one height.
- **The name column** fits its names.

Per-column widths were rejected: 4,095 measured widths would need every row read, `ColumnLayout` rebuilds its prefix
sums on every growth, and a width kept per position means nothing after a sort.

**P:** shared width, overrides, the bound, Fit of a drawn column. **To do:** the name column's drag and fit; a way to
change the shared width by hand (suggested: dragging a column that has no width of its own with Shift held sets it for
all).

### Marks

| Mark | Transposed |
| --- | --- |
| **Highlight tint** | A highlighted source row is a drawn column. Its cells are not given a class: one pooled band element per highlighted column in view lies over them, and its header takes the colour and the `aria-description`. A frame costs one element per highlighted visible column. |
| **Search, column-name mode** | A matched name is marked in its frozen name cell with a header's match classes; the active one scrolls into view vertically; cells of columns the search leaves out are dimmed as now (the cell's bit is by source column). |
| **Search, values mode** | Unchanged: marks are keyed by source row and column and looked up turned. |
| **Row size** | The bar moves from the row number to the drawn column's header, with the same tooltip (in the prototype a hover over the header drops it). |
| **White space** | Unchanged, per cell. |
| **Column type** | After the name in the frozen cell, as a header shows it. |
| **Link cells** | A link column is a drawn row of links. Click and Enter open with the source row and column. |
| **Keyboard** | Keys move over what is drawn. Right is the next row of the result, Down the next column, Home and End the first and last drawn column, PageUp and PageDown a page of drawn rows, Shift+Space the drawn row (a whole source column), Ctrl+Space the drawn column (a whole source row). |
| **The cap's strip** | The grid's existing one-line strip: "Transposed shows the first 4,095 of 6,000 rows as columns. Filter the result to see others." It shows while the view has more rows than the cap, also while they stream. |

Diff marks and row tones never apply: comparisons and live tables are not transposed.

**P:** all of them in code; highlight, row size, links, type, keys and the strip checked in the app; the two search
modes by unit test only. **To do:** theme keys for the column tint in place of the prototype's opacity; the band under a
lowered scroll cap (a transposed grid is at most 4,096 rows tall, so it never scrolls virtually in production).

### Past the cap

The state keeps source coordinates, so nothing is lost; what is at or beyond row 4,095 is simply not drawn.

| | Behaviour |
| --- | --- |
| **Find Next** | The match stays counted and becomes the active match, the grid does not move, and the strip says where it is: "The match is in row 5,001. Transposed shows the first 4,095 …". Skipping such matches would make "3 of 20" jump; switching the orientation off would surprise. |
| **Ctrl+End** | The last drawn cell: row 4,095's value of the last column. Keys never leave the drawn rows. |
| **Select All** | Everything, as one open-ended block in source coordinates. All drawn cells show selected. Copy while transposed writes the first 4,095 rows and says how many it left out (PR 6's `capped`). |
| **An existing selection** | Kept as it is. Blocks inside the cap draw, blocks beyond it draw nothing and are still there when the orientation is turned off or a filter brings their rows under the cap. |
| **The active cell** | Recommended: when the orientation turns on, or a swap leaves it beyond the cap, it moves to the same column in the last drawn row and the owner is told, as a swap moves it today. |
| **A highlight** | Not drawn. The highlight strip still counts it. |

**P:** Find Next (`onBeyondCap` and the strip), Ctrl+End, Select All and the kept selection. The active cell is only
clamped when painted, as a table clamps one past `rowsAvailable`. **To do:** the active cell's move in state.

### Targets and ARIA

- **Menu targets** no longer read `aria-colindex`. `GridView` registers a resolver (`registerGridTarget`) that maps an
  element to `{ row?, column? }` in source coordinates through the slot map it already keeps: a cell gives both, a frozen
  name its column, a drawn column's header its row. `OutputTarget` gains `row`. Sort, Filter, Copy Column Name and Open
  Value take `column`; Fit Column takes `row` when transposed. This also holds for a table, so PR 2b can move every
  target to it.
- **ARIA** describes what is drawn, because that is what a screen reader walks. `aria-rowcount` is the column count plus
  the header row and `aria-colcount` the drawn rows plus the name column, updated as rows stream. Each row's
  `rowheader` is the column's name (with `aria-sort`); each `columnheader` is "Row N" or the header value, with the
  highlight's description. The active cell's label is unchanged. The grid's name says it: "Result 1 of 2, transposed, 8
  columns as rows, the first 4,095 of 6,000 rows as columns".
- **Smoke locators.** `gridCellSelector(row, column)` addresses drawn cells by ARIA index. PR 5 adds a transposed
  variant to `scripts/fixtures/ui.mjs` so suites keep naming source rows and columns.

**P:** the resolver, `OutputTarget.row`, the ARIA attributes. **To do:** the commands' use of `row`; a pass with a screen
reader.

### Stack sizing

A transposed item's drawn row count is its column count, known when the set opens. `contentHeight` takes that count in
place of the rows, and its strip flag is also true when the cap strip shows. The rule that a set is sized to its content
only once it has every row stays, so the scroll bar and the cap strip are final when the height is set and streaming rows
still move nothing. A transposed grid is almost always wider than its pane, so the horizontal scroll bar is counted
unless the grid reports that its columns fit, as now. In Tabs the grid fills the pane.

**P:** none; the prototype's switch is global and the benchmark shows one set. This is a change to `settledContent`'s
arguments, not to the layout.

## Numbers

Owner's machine: Intel Core Ultra 9 285K (24 cores), 64 GB, Windows 11 Pro 26200, RTX 5090, one 5120 × 1440 display at
59 Hz. Node 24.14.0, Electron 44.10.2, .NET SDK 10.0.403. Production renderer build (`electron-vite build`), app window
1600 × 1000 in test mode, fake backend. Source: `T1` × 5,000 rows, so a transposed grid draws 4,095 columns by 4,096
rows. 60 scroll bar jumps to fresh rows and columns; 3 s of scrolling at 400 px a frame each way.

<!-- numbers:begin -->
Pass numbers, 4,095 columns drawn. "Table" is the same result untransposed, for scale; it is not a criterion.

| Measure | Target | Floor | Table | a. In-grid | b. Adapter |
| --- | --- | --- | --- | --- | --- |
| `frame()` after a jump, p95 | ≤ 8 ms | ≤ 16 ms | 1.4 ms | 1 ms | 0.7 ms |
| `frame()` during horizontal wheel, p95 | ≤ 6 ms | ≤ 12 ms | 0.4 ms | 0.5 ms | 0.4 ms |
| `frame()` during vertical wheel, p95 | ≤ 6 ms | ≤ 12 ms | 0.7 ms | 0.5 ms | 0.5 ms |
| Main-thread task time per jump, p95 | ≤ 50 ms | ≤ 170 ms | 73.9 ms | 47.3 ms | 42.2 ms |
| Longest long task in its segments | ≤ 50 ms | ≤ 250 ms | 0 ms | 0 ms | 0 ms |

Targets and floors are those of `grid.x1.jumpFrameP95Ms`, `grid.x1.horizontalFrameP95Ms` (both wheel rows),
`grid.x1.jumpTaskP95Ms` and `grid.longTaskMaxMs`. A long task is one over 50 ms; 0 ms means there was none.

Beside them, reported only:

| Measure | Table | a. In-grid | b. Adapter |
| --- | --- | --- | --- |
| Jump → cells painted, p95 | 1,046 ms | 415 ms | 280 ms |
| Animation-frame interval, horizontal wheel, p95 | 17 ms | 17 ms | 17.3 ms |
| Animation-frame interval, vertical wheel, p95 | 17 ms | 17 ms | 17 ms |
| DOM elements of the grid | 655 | 945 | 597 |
| Main thread busy while 4,095 rows of 300 columns stream at 1,000 a second | 6.37 % | 6.88 % | 22.3 % |
| Task time per jump over 300 bit columns × 5,000 rows transposed (40 px columns, the most cells in view), p95; `grid.x2.jumpTaskP95Ms` is ≤ 50 ms, floor ≤ 260 ms | 45.1 ms | 40.1 ms | 40.2 ms |
| DOM elements of that grid | 1,643 | 1,543 | 1,517 |

The table grid, before and after the in-grid changes (existing benchmark metrics, the first of two runs each):

| Metric | Target | Floor | `main` | Spike build |
| --- | --- | --- | --- | --- |
| `grid.firstPaintMs` | ≤ 50 ms | ≤ 250 ms | 39.5 ms | 43.6 ms |
| `grid.stream.busyPercent` | ≤ 10 % | ≤ 25 % | 5.33 % | 5.4 % |
| `grid.wheel.frameP95Ms` | ≤ 3 ms | ≤ 8 ms | 0.6 ms | 0.6 ms |
| `grid.jump.paintP95Ms` | ≤ 50 ms | ≤ 250 ms | 49 ms | 48.9 ms |
| `grid.x1.jumpFrameP95Ms` | ≤ 8 ms | ≤ 16 ms | 1.9 ms | 1.9 ms |
| `grid.x1.jumpTaskP95Ms` | ≤ 50 ms | ≤ 170 ms | 36.4 ms | 33.7 ms |
| `grid.x1.horizontalFrameP95Ms` | ≤ 6 ms | ≤ 12 ms | 0.4 ms | 0.3 ms |
| `grid.x1.wheelIntervalP95Ms` | ≤ 17.5 ms | ≤ 60 ms | 17.2 ms | 17.1 ms |
| `grid.x2.jumpTaskP95Ms` | ≤ 50 ms | ≤ 260 ms | 38.1 ms | 45.1 ms |
| `grid.x2.wheelIntervalP95Ms` | ≤ 17.5 ms | ≤ 80 ms | 17.4 ms | 17.2 ms |
| `grid.w1.elements` | ≤ 1500 elements | ≤ 1500 elements | 603 | 603 |
| `grid.x1.elements` | ≤ 4000 elements | ≤ 4000 elements | 1,071 | 1,071 |
| `grid.x2.elements` | ≤ 4000 elements | ≤ 4000 elements | 1,643 | 1,643 |
| `grid.heapGrowthMb` | ≤ 80 MB | ≤ 150 MB | 0.051 MB | 0.0677 MB |
| `grid.longTasks` | ≤ 0 tasks | — | 0 | 0 |
| `grid.longTaskMaxMs` | ≤ 50 ms | ≤ 250 ms | 0 ms | 0 ms |
<!-- numbers:end -->

Reading them:

- **Every pass number is met by both approaches**, with no long task in any transposed segment. The closest is the
  in-grid task time per jump, 47 ms against a 50 ms target (43 ms in an earlier run of these segments alone); most of
  it is receiving the tiles' text, which is why the table over the same result is at 74 ms.
- **The table grid's frame and jump numbers did not move.** Each build was run twice, back to back. Run to run,
  `grid.x2.jumpTaskP95Ms` read 38 and 52 ms on `main` and 45 and 45 ms on the spike build, and `grid.x1.jumpTaskP95Ms`
  36 and 32 ms against 34 and 34 ms: the difference between builds is inside the spread of one build.
- **First paint is not settled.** `grid.firstPaintMs` read 40 and 36 ms on `main` and 44 and 59 ms on the spike build
  (the second with one 89 ms sample of five). Nothing on the table path explains 10 ms, and the prototype's shell does
  more per grid than the real one will (a global switch, the adapter's bookkeeping), but two runs cannot call it noise.
  PR 5a must show this metric unchanged before 5b builds on it.
- Time from a jump to painted cells is dominated by the worker decoding pages, not by the grid: a page of `T1` is 4 rows
  and about 0.75 MB. A table reads tiles 128 rows tall (32 such pages); the transposed tile is 32 rows tall (8 pages),
  which is why both transposed modes paint sooner than the table over the same result.
- The adapter's lower jump task time is not an advantage of the approach: its columns came out 400 px wide (it sizes
  them by the table's rule), so it shows fewer cells.

**Not measured:** the Linux CI runner. The criterion there is "under the floors", which the runner can only show once a
branch is pushed; PR 5 adds the transposed metrics to `tests/bench/floors.json` and CI then enforces them. On this
machine the transposed numbers are below the floors by a factor of 3 or more.

## Scope for PRs 5 to 8

**PR 5, orientation in the grid.** Split in two.

- **5a, no visible change:** `ColumnAxis`; tile shape and `GridData.also`; the `selection()` / `select()` seam and the
  `offsets` indirection in `GridView`; `paintSort` and `paintSize` taking any element; `registerGridTarget`, with
  `menus/targets.ts` reading it. Verified by the existing grid tests, smoke suites and benchmark.
- **5b, the orientation:** `rotateSelection`, `UniformLayout`, the `transposed` and `headerColumn` options and
  `GridViewState.transposed`, from the prototype. Added to it: the name column's drag, fit and saved width; the active
  cell's move into the drawn rows; names of an empty result; name-cell tooltips; theme keys for the column tint;
  `settledContent` sized by drawn rows; per-view `orientation` and `headerColumn` in the grid state (PR 2a keys that
  state by entry, so it follows the entry), set by a test hook only until PR 7. The transposed locator in `ui.mjs`. The
  benchmark's transposed metrics get fixed ids and entries in `floors.json`. `docs/architecture.md`'s grid bullet.
  `tests/grid-orientation.test.ts` carries over without its adapter cases.

**PR 6, transposed copy and save.** As planned. The selection is already in source coordinates, so copy parts need no
translation: the renderer adds `transposed` and the header column. The field named `Column` matches the frozen name
column.

**PR 7, commands.** As planned, plus what the spike found: Fit Column acts on the target's `row` when transposed; the
cap strip (`capText`) and the Find Next message (`onBeyondCap`) come from the prototype; a context key for "this grid is
transposed" so Transpose reads as a toggle; `output.transposeSelectedRows` is Keep Selected Rows (PR 4) then the
orientation.

**PR 8, removal.** As planned. `grid/rotated-handle.ts` is prototype only and never lands. `limits.transpose.maxRows`
stays where the grid can read it, since the grid now enforces the cap.

**Elsewhere.** PR 2b: move menu targets to `gridTarget` and carry `row`. PR 9: the stack sizes a transposed item by its
columns. Peek: the orientation needs nothing from the stack, so the bare mode gets it for free.

## Decisions for the owner

All six accepted by the owner on 2026-11-10.

1. Approach (a), and no fallback.
2. Names in a frozen first column with the sort and filter controls there, and no column ordinals.
3. One shared width, capped at 240 px, with at most 256 widths of their own that a re-sort clears.
4. Fit Column fits the drawn column (a row) when transposed.
5. Find Next onto a match past the cap reports it and does not move.
6. Row-size bars and highlight colours on the drawn columns' headers; a highlighted row tints its column.

## Observations outside the spike

- The plan says the cap cannot be raised because "resizing is linear in columns". With `UniformLayout` it is not; what
  remains is the scroll range (about 468,000 columns at 32 px). The follow-up "uncapped transposed columns" is closer
  than the plan assumes, though Copy, Save and the 4,096-row window limit still bound it.
- A table over a result as wide as `T1` takes about a second to paint after a jump (see the table row above), because a
  tile is 128 rows tall whatever the page size. That is existing behaviour and separate work.
- `docs/ipc.md` records `grid.x1.jumpTaskP95Ms` at 73 to 85 ms on its reference machine, above the 50 ms target. The pass
  criterion compares with the target on the owner's machine, where the table also meets it.
