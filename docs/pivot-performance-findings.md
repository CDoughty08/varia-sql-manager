# Pivot performance findings

> Re-measured on 2026-11-12 after the sort keys changed (#432, #435, #439): see [Re-measured](#re-measured-on-2026-11-12).
> The figures for text, date and binary groups, the proposal and the threshold below are of 2026-11-11.

The investigation [pivot-performance-follow-up.md](pivot-performance-follow-up.md) asked for, measured on 2026-11-11. It
serves the [Grouped views plan](grouped-results-implementation-plan.md): PR 17's automatic rebuild needs a source-row
threshold, and PR 10's cap of four parallel builds needed checking.

## Summary

- **The reported slowdown was not reproduced.** Two results of 20,463 rows of one `int` column with repeats and NULLs,
  pivoted as a Count by that column, take 110 to 180 ms from the click on Build Pivot to the painted pivot, in every UI
  state tried, with no long task in the renderer. The backend's share is 3 to 40 ms. Nothing at this size is slow on
  this machine, on a Release or a Debug backend, before or after #427.
- **One cost dominates every larger build: the sort that groups the rows.** It is 85 to 99 % of the backend's time in
  every case measured. The renderer's part (about 100 ms, three or four frames) does not grow with the source, the pivot
  or the number of results in the stack.
- **#427 removed that cost for numbers** (a million rows by an `int`: 1.24 s before, 0.17 s after). It is on `main`.
- **Text, date and time, binary and long decimal groups are still 8 to 30 times slower than numbers**, for the same
  reason #427 fixed for numbers: two rows whose 8-byte key prefixes are equal are compared by reading both cells from
  their pages again, and in a column of a few repeated values most comparisons are of equal prefixes. A million rows by
  a text column of 40 values takes 2.2 to 2.7 s, by a `datetime2` 1.4 s. The fix proposed below (a separate PR) brings
  those to 0.2 to 0.45 s.
- **Threshold for PR 17: 100,000 source rows**, counted as the rows stored in the Table's result, not the rows its
  filters keep. See [Threshold](#threshold-for-the-automatic-rebuild).
- **Four parallel builds per window is safe.** They do not slow each other much; what stops them at large sources is
  the query's budget, by an immediate refusal that changes nothing. See [Parallel builds](#parallel-builds).

## Re-measured on 2026-11-12

`--pivot-bench` again, on the same machine and budget, on `main` after #432, #435 and #439 (text, date and binary sort
keys held by rank or whole, keys built and rows sorted on several threads, dates read as ticks) with the sampling change
that followed them. The sections below are the record of 2026-11-11 and are left as measured; where this section and
they disagree, this one is current. Median of warm builds, a million rows unless a row says otherwise.

| Case | `main` on 2026-11-11 | Now |
| --- | ---: | ---: |
| Count by an `int` of 40 values | 183 ms | 32 ms |
| By a `decimal(18,2)` of 40 | 206 ms | 35 ms |
| By a `decimal(38,10)` of 30 digits, 40 values | 2.01 s | 290 ms |
| By a `datetime2` of 40 | 1.42 s | 86 ms |
| By a text, case-insensitive collation, 40 | 2.42 s | 51 ms |
| By a text, binary collation, 40 | 1.75 s | 46 ms |
| By a text of 190 characters with a shared start, 40 | 5.94 s | 95 ms |
| By a text, case-insensitive, 50,000 values | 2.8 to 3.1 s | 92 ms |
| By a text of 190 characters, 50,000 | 7.4 s | 162 ms |
| By a `decimal(38,10)`, 50,000 | 2.1 to 2.3 s | 677 ms |
| Row groups an `int` then a text of 12 values | 2.93 s | 72 ms |
| Row group the `int`, column group the text | 2.33 s | 79 ms |
| Distinct Count of a `decimal` | 703 ms | 287 ms |
| Distinct Count of a text of 12 values | 3.01 s | 306 ms |
| 5,000,000 rows by an `int` | 1.57 s | 315 ms |
| 20,000,000 rows by an `int` | 7.3 s | 1.63 s |
| 5,000,000 rows through a filter keeping half | 601 ms | 171 ms |

What changed in the conclusions:

- **Text, date and time, and binary groups are no longer slower than numbers by more than about three times.** The 8
  to 30 times of the summary is gone; the change this page proposed (#437) was closed in favour of #432, which does the
  same for repeated values and more for values that do not repeat.
- **What is still slow:** a `decimal` past 15 digits (its ties still read their cells, now on several threads), and
  Distinct Count, whose own sort is still one thread (250 ms of each 290 to 330 ms build).
- **The grouping sort is still the largest part of most builds** (40 to 95 % in these cases), but of a build four to fifty times shorter.
- **Small sources did not reproduce this page's figures.** 20,463 rows by the `int` takes 12 ms here now, where the page
  has 2.9 ms. #436's own commit, built and run on this machine on 2026-11-12, takes 32 ms for it, so today's code is
  faster at that size too; the 2.9 ms was not seen again and the cause was not found. The end-to-end figures of "The
  reported shape" (110 to 180 ms to paint) were not re-measured: `scripts/pivot-bench.mjs` needs a SQL Server this
  session did not have.

The threshold's cases:

| Recipe | 50,000 rows | 100,000 | 250,000 | 500,000 |
| --- | ---: | ---: | ---: | ---: |
| Count by an `int` of 40 values | 6 ms | 7 ms | 12 ms | 21 ms |
| By a text of 40 values | 9 ms | 11 ms | 18 ms | 29 ms |
| By a `datetime2` of 40 values | 8 ms | 12 ms | 22 ms | 40 ms |
| By a text with a value every 20 rows | 10 ms | 14 ms | 27 ms | 48 ms |
| By a `decimal(38,10)` of 40 values | 30 ms | 37 ms | 68 ms | 119 ms |
| By a text of 190 characters with a value every 20 rows | 15 ms | 20 ms | 46 ms | 83 ms |
| Two row groups, Count, Sum and Distinct Count of a text that never repeats | 25 ms | 44 ms | 95 ms | 189 ms |

- **By this page's own reasoning the threshold could rise to 500,000 rows.** It stopped at 100,000 because the slow
  recipes passed a second at 250,000. The slowest found now takes 189 ms at 500,000, under the 250 ms the page gives an
  ordinary rebuild. Larger sizes were not run as threshold cases; a million rows by one column is 32 to 95 ms above,
  290 to 680 ms for the long `decimal` and for Distinct Count.
- **"With a larger budget: do not raise it" was about the budget, and still holds.** What moved the figures is the
  code, not the budget.
- **These builds now use threads the machine may not have.** Keys and sorts take up to three quarters of the cores (16
  here). A four-core laptop gets three, and its builds will be nearer the single-thread figures than these. The second
  condition the page recommends (rebuild automatically only if the last build took under 250 ms) is what covers that,
  and matters more with a higher row threshold.
- The decision is the Grouped views plan's to take; this is the measurement for it.

Parallel builds, 5,000,000 rows at 1 GiB a query:

| Builds at once | Each took | Refused |
| ---: | ---: | ---: |
| 1 | 345 ms | 0 |
| 2 | 1.21 s | 0 |
| 4 | 1.25 s | 0 |
| 8 | 1.27 s | 3 |

- **Builds at once share the threads, and the first to ask takes them.** One build alone has them all; a second that
  starts while the first holds them gets one thread for that step and runs at about the old single-thread speed
  (1.1 to 1.3 s here, as on 2026-11-11). Nothing is slower than it was, but two builds at once finish later than the
  same two one after the other would (0.7 s). Dividing the threads between the operations that are running is the
  change that would fix it; it was not made here.
- Four at once are still safe, and still refused only by the query's budget.

Cancellation stopped a 2.3 s build of five million rows within 0.2 to 15 ms at seven points; a source that leaves no
room for the working memory is refused in 0.1 ms with nothing reserved.

## Environment

| | |
| --- | --- |
| Machine | Intel Core Ultra 9 285K (24 cores: 8 fast, 16 slower), 64 GB, Windows 11 Pro 10.0.26200 |
| Runtimes | .NET 10.0.14 (SDK 10.0.403, workstation GC), Node 24.14.0, Electron 44.10.2, SQL Server 2025 (17.0.1000.7), local |
| Builds | Release backend and `out/` (`npm run build:smoke`); one Debug backend run, marked |
| Revisions | "Before #427": `ba1a7b49`. "`main`": `ab6315c5`, which has #427. "With the fix": `main` and the change proposed below |
| Budget | 2 GiB global, 1 GiB a query (today's cap) unless a case says 16 GiB (8 GiB a query). No memory-load check |
| Data | Synthetic only: every cell is a function of its row number. No user data, SQL text or values in any output |

Other sessions were building and testing on the machine throughout, and a thread that lands on a slower core runs about
twice as long. Medians of repeated runs moved by 15 % between runs and single cases by a factor of two (a text case
measured 2.8 s and 6.7 s on the same build). Differences smaller than that mean nothing here. The tables give the median
of the warm builds and, in brackets, the slowest.

## Fixtures and how to run them

- **Backend:** `dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --pivot-bench
  [--budget-gib N] [--only name,name] [--max-rows N] [--view-rows N]` (`PivotBench.cs`). It fills a `ResultStore` as
  ingestion does and runs each pivot as `SqlService.PivotAsync` does, stage by stage, then the same pivot through
  `results.pivot`. Each case builds once (the first build), then seven more or for 20 s. It prints one JSON line a case.
  `ResultPivoter.Build` takes an optional `PivotStages` that records the ticks spent in sort keys, grouping,
  aggregation and distinct counts; the host passes none.
- **End to end:** `node scripts/pivot-bench.mjs [--rows N] [--runs N] [--only name]` with `VARIA_TEST_SQL_SERVER` set.
  The built app runs a query of numbers from a cross join of catalog views, opens the Pivot panel and builds. It times
  the click to the answer (the panel stops being busy), to the pivot's grid being in the document, to its first cell
  having text and to two frames later, with the renderer's long tasks, longest frame and main-thread task time.
- Neither is part of `npm run check` or CI. The result-scale benchmark the brief refers to (`--result-scale-bench`) was
  not on `main` or in an open PR, so these are the pivot fixtures only; nothing was copied from it.

## The reported shape

End to end, median (slowest) of five builds, on `main`:

| Case | Answer | Grid in the document | First cell | Painted | Renderer task time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Two results of 20,463 rows, Count by the column | 16 ms (47) | 51 ms (68) | 65 ms (80) | 113 ms (129) | 25 ms (33) |
| One result | 15 ms (16) | 50 ms (52) | 64 ms (65) | 112 ms (113) | 25 ms (25) |
| About 17,000 row groups | 22 ms (25) | 51 ms (52) | 64 ms (65) | 113 ms (113) | 24 ms (25) |
| Seven columns | 15 ms (16) | 52 ms (55) | 64 ms (65) | 112 ms (114) | 26 ms (29) |
| The column as the column group (252 columns) | 16 ms (16) | 51 ms (54) | 64 ms (65) | 113 ms (113) | 26 ms (39) |
| Column Profile open | 15 ms (16) | 49 ms (51) | 64 ms (65) | 113 ms (113) | 23 ms (25) |
| Row size shown | 15 ms (16) | 50 ms (52) | 64 ms (64) | 113 ms (113) | 23 ms (25) |
| A results search active (before #427) | 45 ms (74) | 68 ms (102) | 81 ms (114) | 129 ms (162) | 35 ms (44) |
| 40 builds on one run (42 results in the stack) | 15 ms (17) | 49 ms (51) | 64 ms (65) | 112 ms (113) | 35 ms (70) |

Before #427 the same cases painted in 113 to 146 ms (178 ms at the slowest, the first build of a session). No case had
a long task, and the longest frame was 17 ms. The fortieth build on a run painted as fast as the first. Forty changes
of the panel's draft with 42 results in the stack cost 9 ms of task time each.

Backend alone, 20,463 rows: the first build in a process 36 to 70 ms (the sort runs unoptimised until the runtime has
compiled it), later ones 14 ms before #427 and 3 ms on `main`. A Debug backend, as `npm run dev` builds, 42 to 50 ms.

What this rules out for that shape: backend grouping, queuing, delivery, grid mount, column measurement, profiling, Row
size, search and the growing stack. What it does not rule out is listed under [Not measured](#not-measured).

## Stage by stage

The six stages of the brief, for the reported shape and for a million rows of the same column, on `main`:

| Stage | 20,463 rows | 1,000,000 rows | How it was measured |
| --- | ---: | ---: | --- |
| 1. Dispatch, queuing, the round trip to the backend and back | about 12 ms | about 12 ms | The answer end to end, less the backend's time |
| 2. Working-memory reservation and source access | under 0.01 ms | under 0.01 ms | `PivotBench`: the page snapshot and `TryReserve` |
| 3. Sort keys | 0.5 ms | 15 ms | `PivotStages.Keys` |
| 3. Grouping (the sort) | 2.3 ms | 148 ms | `PivotStages.Grouping` |
| 3. Aggregation | 0.05 ms | 2.6 ms | `PivotStages.Aggregation` |
| 4. Output columns, pages, sealing | 0.04 ms | 0.07 ms | `PivotBench` |
| 5. Answer to the grid in the document | 35 ms | 25 ms | End to end: two frames |
| 5. To the first cell with text | 13 ms | 11 ms | One frame: the window read and its decode |
| 5. To paint | the next frame | the next frame | |
| 6. Profile, highlight, search for the new result | inside the 25 ms of task time | 35 ms of task time | DevTools `TaskDuration` over the whole span |

Through the host (`results.pivot`: argument checks and two hops to the thread pool) a build takes the same time as its
stages added up, within noise. Nothing waits in stage 1: one pivot runs per tab today.

End to end by row volume (one result, 40 values and NULL, Count by the column), click to painted:

| Rows | Before #427 | `main` |
| ---: | ---: | ---: |
| 20,463 | 146 ms | 112 ms |
| 200,000 | 195 ms | 113 ms |
| 1,000,000 | 1.03 s | 246 ms |
| 5,000,000 | 8.05 s | 1.21 s |

The renderer's share is the same 80 to 100 ms in every row.

## Controlled cases

Backend only. A million rows unless the case says otherwise; "With the fix" is `main` and the change proposed below.

### Row volume

One `int` column of 40 values and NULL, Count of rows by it.

| Rows | Before #427 | `main` | Sort keys | Grouping | Reserved | Allocated | Source |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.40 ms | 0.17 ms (0.19) | 0.06 ms | 0.08 ms | 32 KiB | 29 KiB | 6 KiB |
| 20,463 | 14 ms | 2.9 ms (3.7) | 0.5 ms | 2.3 ms | 642 KiB | 412 KiB | 113 KiB |
| 200,000 | 108 ms | 31 ms (58) | 4.6 ms | 26 ms | 6.1 MiB | 3.9 MiB | 1.1 MiB |
| 1,000,000 | 1.24 s | 168 ms (174) | 15 ms | 148 ms | 30.6 MiB | 19.3 MiB | 5.4 MiB |
| 5,000,000 | 10.5 s | 1.57 s (1.78) | 89 ms | 1.46 s | 153 MiB | 96 MiB | 27 MiB |
| 20,000,000 | 51.6 s | 7.3 s (7.7) | 369 ms | 6.9 s | 613 MiB | 385 MiB | 108 MiB |
| 50,000,000 (16 GiB) | | 20.5 s (20.9) | 868 ms | 19.4 s | 1.50 GiB | 962 MiB | 269 MiB |
| 100,000,000 (16 GiB) | | 51.2 s (53.7) | 1.9 s | 49.0 s | 2.99 GiB | 1.88 GiB | 538 MiB |

At 1 GiB a query, 50 million rows of this column cannot be pivoted at all: the source is 269 MiB and the pivot reserves
1.5 GiB. A narrow source is the case where the pivot's working memory, 32 bytes a row and key column, is several times
the rows it reads.

### Group cardinality

An `int` column with the number of values shown.

| Values | Before #427 | `main` | Row groups |
| ---: | ---: | ---: | ---: |
| 2 | 753 ms | 135 ms (149) | 3 |
| 40 | 1.12 s | 278 ms (330) | 41 |
| 1,000 | 1.17 s | 227 ms (235) | 1,001 |
| 50,000 | 910 ms | 243 ms (255) | 50,001 |
| 99,000 | 852 ms | 230 ms (280) | 99,001 |
| 500,000 | 496 ms | 236 ms (255) | refused: past 100,000 row groups |

A pivot past its bounds is refused only after its whole sort (236 ms here), because the groups are counted from the
sorted rows. Writing 99,001 rows of output takes 10 ms.

### Shape

Eight columns, about 190 bytes a row.

| Case | Before #427 | `main` | With the fix | Groups |
| --- | ---: | ---: | ---: | ---: |
| Count by the `int` column (a wide source) | 1.35 s | 179 ms (203) | 239 ms (248) | 41 |
| Row groups an `int` then a text of 12 values | 4.58 s | 2.93 s (3.48) | 641 ms (686) | 121 |
| Row group the `int`, column group the text | 3.46 s | 2.33 s (2.69) | 745 ms (897) | 41 x 13 |
| The same with Count, Sum, Average and Max | 3.46 s | 2.22 s (2.41) | 798 ms (866) | 41 x 13 |

A wide source costs nothing extra: the keys read one column of each page, then the pages are not read again.

### Group column type

Count of rows by one column of the type, 40 values and then 50,000.

| Type | Before #427 | `main` | With the fix |
| --- | ---: | ---: | ---: |
| `int`, 40 values | 1.04 s | 183 ms (228) | unchanged |
| `decimal(18,2)`, 40 | 1.10 s | 206 ms (255) | unchanged |
| `decimal(38,10)` of 30 digits, 40 | 1.78 s | 2.01 s (2.69) | unchanged |
| `float`, 40 | 182 ms | 185 ms (195) | unchanged |
| `datetime2`, 40 | 1.41 s | 1.42 s (1.56) | 243 ms (268) |
| Text, case-insensitive collation, 40 | 2.18 s | 2.42 s (2.71) | 443 ms (480) |
| Text, binary collation, 40 | 1.45 s | 1.75 s (2.13) | 347 ms (373) |
| Text of 190 characters with a shared start, 40 | 5.28 s | 5.94 s (6.02) | 1.84 s (1.87) |
| `int`, 50,000 values | 772 ms | 258 ms (294) | unchanged |
| `decimal(38,10)`, 50,000 | 2.08 s | 2.1 to 2.3 s | unchanged |
| `datetime2`, 50,000 | 1.79 s | 1.8 to 2.0 s | unchanged (1.8 to 2.2 s) |
| Text, case-insensitive, 50,000 | 2.81 s | 2.8 to 3.1 s | unchanged (2.5 to 2.9 s) |
| Text, binary, 50,000 | 2.29 s | 2.0 to 2.3 s | unchanged (2.3 s) |
| Text of 190 characters, 50,000 | 6.28 s | 7.4 s | unchanged |

`float` never read a cell on a tie, which is why it was always fast; it shows what the sort itself costs. In the last
text row with the fix, 1.6 s of the 1.84 s is building collation sort keys for 190-character values, not grouping.

### Recipe

The wide source grouped by the `int` column, one value at a time.

| Value | Before #427 | `main` | With the fix | Of which distinct counting |
| --- | ---: | ---: | ---: | ---: |
| Count of rows | 1.24 s | 182 ms (213) | unchanged | |
| Count of a column | 1.32 s | 177 ms (196) | unchanged | |
| Sum of a `decimal` | 1.37 s | 204 ms (250) | unchanged | |
| Average of a `decimal` | 1.36 s | 228 ms (232) | unchanged | |
| Sum of a `float` | 1.44 s | 237 ms (259) | unchanged | |
| Min, Max of a `decimal` | 1.38 s, 1.31 s | 214 ms, 275 ms | unchanged | |
| Min of a text | 1.56 s | 397 ms (444) | unchanged | |
| Distinct Count of a `decimal` | 2.53 s | 703 ms (826) | unchanged | 441 ms |
| Distinct Count of a text of 12 values | 3.96 s | 3.01 s (3.51) | 906 ms (1.04 s) | 2.67 s, then 436 ms |
| All six of a `decimal` | 2.54 s | 621 ms (646) | unchanged | 343 ms |

Aggregation itself is 2 to 55 ms a million rows whatever the values: sums parse each cell once, and no value scans the
rows twice. Distinct Count is the exception. It sorts the rows twice more (by cell, then by row group), with the same
tie cost.

### Source view

Five million rows of an `int` of 100 values and an id, 80 MiB. The pivot reads the grid's view.

| View | Rows pivoted | Before #427 | `main` | Sort keys | Grouping | Reserved | Allocated |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| None | 5,000,000 | 9.8 s | 1.14 s (1.30) | 80 ms | 1.05 s | 153 MiB | 96 MiB |
| A filter keeping one value of 100 | 49,998 | 178 ms | 96 ms (99) | 81 ms | 10 ms | 153 MiB | 58 MiB |
| A filter keeping half the values | 2,500,019 | 5.3 s | 601 ms (624) | 83 ms | 508 ms | 153 MiB | 68 MiB |
| Sorted by the group column | 5,000,000 | 7.7 s | 980 ms (1.07 s) | 83 ms | 884 ms | 153 MiB | 77 MiB |
| Sorted by the id | 5,000,000 | 11.5 s | 1.10 s (1.14) | 81 ms | 1.01 s | 153 MiB | 77 MiB |

Building those views took 145 to 150 ms for the filters and 0.8 s for the sort by id.

### Resource pressure

| Case | Result |
| --- | --- |
| Cancel at seven points through a 3.6 s build (5 million rows) | The work stopped 0.2 to 0.8 ms after the cancel (2.6 ms at the slowest before #427). Nothing stayed reserved |
| A source that leaves no room for the working memory | `TOO_LARGE` in 0.5 ms, before any row is read. Nothing reserved, the source untouched |
| A pivot past 100,000 row groups | `INVALID_PARAMS` after the sort: 236 ms at a million rows |

Source closure and backend loss during a build were not driven here; `PivotChecks` covers the released-source and
closed-view answers.

## Questions the brief asked

**Does backend grouping dominate, or is the delay before the request or after the answer?** Grouping dominates above
about 200,000 rows and is the only part that grows. Below that the fixed 100 ms after the answer is larger than the
backend's time. Nothing was found before the request.

**Are sort keys, page layouts or text normalisation recomputed more than needed?** Sort keys are built once a column
and shared by every use in the build. Page layouts are parsed once a page. What is repeated is the comparison of equal
prefixes: each reads two cells by a binary search over the pages, and for a collated column decodes both and asks the
runtime to compare them. A sort of a million rows makes about 20 million comparisons. That is the dominant cost.

**How does the reserved working memory relate to the rows visited?** It does not follow them. A build reserves
`rows x (16.125 x key columns + 16)` bytes for every stored row of the source, builds each key over every stored row,
and allocates an array of every stored row for each grouping, whatever the view keeps. The filter that kept 1 % of five
million rows reserved the same 153 MiB as the unfiltered build and allocated 58 MiB; 81 of its 96 ms went on keys for
rows it then ignored. Reading keys for only the view's rows, as a view's own sort keys already do (`kept` in
`ViewSorter.Build`), would make a filtered pivot cost what its rows cost. It is not the cause of anything slow today:
the reservation is taken and returned in under 0.01 ms, and it matters only when it is refused.

What is allocated is about 63 % of what is reserved (20 bytes a row of the 32 for one key). With a column group and no
view, the build holds four arrays of four bytes a row where `WorkingBytes` counts three; the keys' unused half covers
it today.

**Do multiple aggregates repeat scans or allocate per cell?** No. One pass over the pages serves every Count, Sum,
Average, Min and Max, with no allocation a row. Each Distinct Count adds two sorts.

**Is column measurement or profiling more costly than the aggregation for narrow, low-cardinality pivots?** Both are
small. The renderer spends 23 to 35 ms of task time on the whole build, with the profile panel open or closed, and a
pivot of 252 columns costs the same as one of two.

**Does a rebuild release the superseded result and its views?** There is no rebuild today: each Build Pivot appends
another pivot to the run, and all of them stay until the run is closed or run again. In the backend, a pivot whose
answer is not sent (cancelled, or past its deadline) is released at once, a failed build releases what it had written,
and the working memory is returned on every path (the bench's reservation was back to zero after each cancel and
refusal). A build makes no view of its own; it reads the grid's, and answers `VIEW_NOT_FOUND` if that view went while it
ran.

**What is the peak budget during a replacement, and does a refusal preserve the prior view?** With PR 11's rule (the
old Pivot stays readable until the new one publishes) the peak is the source, the old pivot, the new build's working
memory and figures, and the new pivot. The working memory is the large term: 32 bytes a source row and key column,
against a pivot of a few kilobytes to a few megabytes. Every refusal measured happened before anything was changed, so
the prior result is intact.

**Does cancellation stop the expensive phases promptly?** Yes, within a millisecond. One thing to know: a cancel during
a sort reaches the caller as an `InvalidOperationException` whose inner exception is the `OperationCanceledException`,
because `Array.Sort` wraps what its comparer throws. Every cancel measured arrived that way. It is harmless today (the
host answers a cancelled unary request itself and discards the late failure, and the memory is returned in a
`finally`), but code that catches `OperationCanceledException` around a build will not see it.

## The dominant cost and the change proposed

**Cost.** `ResultPivoter.Group` sorts the rows by the grouped columns' keys. A key holds 8 bytes a row. When two rows'
8 bytes are equal the comparison reads both cells from their pages. #427 stopped that for numbers of up to 15 digits,
whose 8 bytes are the whole value. For every other type the 8 bytes are a prefix: of a collation sort key, of the
display text of a date or time, or of the bytes. Values that repeat always have equal prefixes, and so do different
values that start alike (dates in the same month, names with a common start).

**Change (its own PR, stacked on this one).** A text, date, time or binary key numbers each distinct value in order
while the key is built, and compares rows by that number alone. The collation sort key is already computed for every
row to take its prefix; the change keeps the whole key for each distinct value instead of discarding all but 8 bytes.

- Bounded inside the existing reservation: `ViewSorter.WorkingBytes` reserves 16 bytes a row and key and these keys use
  8. The numbers take 4 and the distinct values may take the other 4 a row. When they do not fit, or a value is longer
  than 1,024 bytes, the key compares as it does today. No limit is raised and nothing is charged that was not reserved.
- That covers a column whose distinct values number up to about one in 30 rows. Past it nothing changes, and nothing
  measurable is lost (the 50,000-value rows above).
- It is in the keys, so sorted views, duplicate filters and distinct lists on such columns gain as the pivot does.
- Correctness checks compare every pair of values against the runtime's own comparison, by case, accent, width, kana,
  trailing spaces, code points and NULL, through a sort, a filter, a key built over kept rows and a pivot with Distinct
  Count and Max, with a truncated cell and a cancelled build.

Before and after are the "With the fix" columns above: 5 to 6 times faster for text and dates of few values, 3 to 4
times for pivots that group or count by one.

**Not proposed here, in the order they would pay:**

1. **`decimal` and `numeric` values past 15 digits** still read their cells on a tie (2 s a million rows). The same
   numbering would serve them, ordered by `CompareNumericText`. Left out to keep the change away from the lines #427
   had just changed.
2. **Keys over only the view's rows** for a filtered pivot (see the reservation question): a filter keeping 1 % of five
   million rows would build in about 15 ms instead of 96 ms and reserve 1 % of the memory.
3. **Many distinct values that share their first bytes** (2 to 7 s a million rows) are not ties and no bounded table
   helps. It is the cost of sorting such a column at all.
4. **Grouping without a sort.** With numbered values a grouping could count instead of sort. The sort is now 0.15 to
   0.25 s a million rows, so this matters only for sources of tens of millions of rows.
5. **Unwrap the cancel** that `Array.Sort` wraps, in `Group`, `Distinct` and `ViewSorter`.

**Compressed pages.** Every tie that reads a cell reads a page. If sealed pages are compressed, an unranked tie would
decompress two pages a comparison, twenty million times a million rows. Number keys (#427) and ranked keys never go
back to the pages; the cases in items 1 and 3 do, and would need a page cache or the same numbering before compressed
pages ship.

## Threshold for the automatic rebuild

Measured at the sizes a threshold might take, with an easy recipe and the slowest ones found. Median (slowest).

| Recipe | 50,000 rows | 100,000 | 250,000 | 500,000 |
| --- | ---: | ---: | ---: | ---: |
| Count by an `int` of 40 values | 10 to 45 ms | 18 to 30 ms | 60 to 89 ms | 79 to 101 ms |
| By a text of 40 values, `main` | 46 to 94 ms | 192 to 294 ms | 0.5 to 1.1 s | 0.8 to 1.1 s |
| The same with the fix | 64 ms (89) | 49 ms (93) | 76 ms (90) | 168 ms (189) |
| By a `datetime2` of 40 values, `main` | 32 to 57 ms | 90 to 214 ms | 0.31 s | 0.55 to 0.68 s |
| The same with the fix | 14 ms (17) | 17 ms (23) | 48 ms (57) | 119 ms (129) |
| By a text with a value every 20 rows | 67 to 150 ms | 167 to 376 ms | 0.45 to 0.76 s | 1.2 to 1.4 s |
| By a `decimal(38,10)` of 40 values | 52 to 96 ms | 87 to 289 ms | 0.26 to 0.44 s | 0.7 s |
| By a text of 190 characters with a value every 20 rows | 0.2 to 0.39 s | 0.48 to 0.81 s | 1.4 to 1.6 s | 3.1 s |
| Two row groups, Count, Sum and Distinct Count of a text that never repeats, `main` | 147 to 242 ms | 0.39 to 0.61 s | 0.76 to 1.7 s | 2.1 s |
| The same with the fix | 174 ms (195) | 226 ms (241) | 574 ms (644) | 1.45 s (1.58) |

Ranges are the medians of two or three runs; see the note on noise.

**Recommendation: rebuild automatically when the Table's result stores at most 100,000 rows.**

- **What is counted:** the rows stored in the source result, not the rows the Table's filters keep. A build keys every
  stored row, so a filter that keeps ten rows of two million still costs two million rows of keys.
- **What it buys:** on `main`, ordinary recipes rebuild in 20 to 300 ms and the slowest found in 0.5 to 0.8 s. With the
  fix, 20 to 230 ms and 0.5 s. The filter's own view takes about 3 ms at that size and the grid about 100 ms to show the
  result, so a rebuild lands within a quarter of a second of the filter in the ordinary case.
- **Why not higher:** at 250,000 rows the slow recipes pass a second on `main`, and a rebuild that slow should be asked
  for. A late or superseded rebuild costs little (a cancel stops it within a millisecond and the old Pivot stays
  readable), so the threshold guards wasted work and budget more than responsiveness.
- **A second condition worth adding:** rebuild automatically only if this Pivot's last build took under 250 ms, and
  mark it out of date otherwise. The row count cannot see the recipe or the machine; the last build's time can. This
  machine is fast: a laptop at half its speed has the slow recipes at one to one and a half seconds at 100,000 rows.
- **Measured at** 2 GiB global and 1 GiB a query, on the machine above, on `main` after #427.
- **With a larger budget: do not raise it.** Build time depends on the rows, not on the budget (the 16 GiB runs match
  the 2 GiB ones row for row). A larger budget makes larger sources possible; it does not make 100,000 rows cheaper.
  At the threshold a build reserves 3.2 MiB a key column, which no budget from 256 MiB up will refuse.
- **With compressed pages: measure again.** The key stage reads every page once and would pay for decompression
  (15 ms a million `int` rows today); unranked ties would pay far more (see above). Run
  `--pivot-bench --only threshold`.

## Parallel builds

Builds of one source at once, each on its own thread, on `main`.

| Source | Budget a query | Builds | Each took | Refused |
| --- | ---: | ---: | ---: | ---: |
| 5,000,000 rows, 80 MiB | 1 GiB | 1 | 1.11 s | 0 |
| | | 2 | 1.16 s | 0 |
| | | 4 | 1.25 s | 0 |
| | | 8 | 1.32 s | 2 |
| 20,000,000 rows, 331 MiB | 1 GiB | 1 | 6.5 s | 0 |
| | | 2 | 6.2 s | 1 |
| | | 4 | 6.3 s | 3 |
| 20,000,000 rows, 331 MiB | 8 GiB | 1 | 7.2 s | 0 |
| | | 2 | 7.7 s | 0 |
| | | 4 | 8.6 s (8.8) | 0 |
| | | 8 | 9.9 s (10.0) | 0 |

- **Four is safe.** Four builds each take 13 to 20 % longer than one. Each build is one thread and the machine has 24;
  on four cores they would take the whole machine for their duration, which was not measured.
- **What limits them is the budget.** Each build reserves 32 bytes a source row for its first key column and 16 more
  for each further one, all from the query's budget. At 1 GiB a query a second build of a 20 million row source is
  refused. Four one-key builds of a narrow source fit up to about 8 million rows, of a 190-byte-a-row source up to about
  3 million; with three key columns, about half of that. At 8 GiB a query those row counts are eight times larger, and
  each build then runs for tens of seconds and holds a result slot that long (50 million rows: 20 s; 100 million: 51 s
  of the 120 s deadline).
- **A refusal is immediate and changes nothing** (0.5 ms, nothing reserved), so builds that refuse each other fail
  cleanly. They fail with "not enough result memory", though, when waiting would have worked.
- **For PR 10:** keep four as the count. Have the renderer hold back a build while the builds in flight on the same
  query, and it, would reserve more than the query's budget has free: it knows the source's rows and the recipe's key
  columns, and `rows x (16 x keys + 16)` is the reservation. That turns a refusal into a wait. Without it, a user who
  starts pivots on two large groups of one query gets one of them refused.

## Not measured

- The owner's own session. The report is a screenshot; its data, build, recipe and machine state are unknown. The
  shape it shows is not slow here in any state tried.
- A grid that is not active (another output tab, another document, a popout window), and a pivot started while a sort
  or filter is still settling. The panel disables Build Pivot until the view is built, so that case costs the view's
  build time (0.15 to 0.8 s at five million rows).
- Highlights on the source or the pivot.
- The grouped UI against today's: only today's exists on `main`.
- Renderer memory after closing results, and backend memory beyond the store's own accounting.
- A machine with few cores, Linux and macOS, a packaged build.
- Budgets between 2 and 16 GiB, sources past 100 million rows, and compressed pages.
- Source closure and backend loss in the middle of a build.

## Noticed on the way

Not part of this work; listed so they are not lost.

- The Pivot panel's heading says "0 rows" for a query's result: it reads the row count from the descriptor the result
  was opened with, before any row was stored (`pivotFacts(entry.descriptor.rowsStored, ...)` in `PivotPanel.tsx`).
- A new pivot is appended at the end of the stack, so it can arrive below the fold, where it draws no cells until it is
  scrolled to (37 of 40 builds on one run did). From the user's side the click on Build Pivot then appears to do nothing.
