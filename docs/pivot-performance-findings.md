# Pivot performance findings

What the pivot benchmarks measure and what they found. These figures support the Pivot's automatic rebuild
(`pivotFollow` in `src/renderer/src/results/PivotService.ts`): a Pivot rebuilds by itself when its Table's result stores
at most **500,000 rows** and its **last build took under 250 ms**; otherwise it is marked out of date with Update. They
also support the cap of four parallel pivot and comparison builds a window.

## Running the benchmarks

Neither is part of `npm run check` or CI. Both use synthetic data only (every cell a function of its row number) and
print no user data, SQL text or values.

- **Backend:** `dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --pivot-bench
  [--budget-gib N] [--only name,name] [--max-rows N] [--view-rows N] [--packed]` (`PivotBench.cs`). It fills a
  `ResultStore` as ingestion does and runs each pivot as `SqlService.PivotAsync` does, stage by stage, then through
  `results.pivot`. Each case builds once, then seven more times or for 20 s, and prints one JSON line. `--only` picks
  cases by id or dimension (for example `threshold`, `parallel`). `--packed` packs each threshold case's source as a
  hidden result is packed and times only `results.pivot`, which reads it fused. `ResultPivoter.Build` takes an optional
  `PivotStages` that records the ticks spent in sort keys, grouping, aggregation and distinct counts; the host passes
  none.
- **End to end:** `node scripts/pivot-bench.mjs [--rows N] [--runs N] [--only name]` with `VARIA_TEST_SQL_SERVER` set.
  The built app runs a query of numbers from a cross join of catalog views, opens the Pivot panel and builds. It times
  the click to the answer (the panel stops being busy), to the pivot's grid being in the document, to its first cell
  having text and to two frames later, with the renderer's long tasks, longest frame gap and main-thread task time.

Machine for every figure: Intel Core Ultra 9 285K (24 cores: 8 fast, 16 slower), 64 GB, Windows 11 Pro, Release
builds, 2 GiB global and 1 GiB a query unless a case says otherwise. Other sessions loaded the machine throughout:
medians moved by about 15 % between runs and single cases by up to a factor of two. Tables give the median of the warm
builds and, in brackets, the slowest.

## Threshold cases

`--pivot-bench --only threshold`, raw and with `--packed`, on 2026-11-14 (.NET 11, compressed pages,
fused reads and threaded sorts). Raw is `ResultPivoter.Build` as the bench's stages time it; packed is the whole host
method. A Table is packed when only its Pivot has been shown for five seconds, which is when a hidden Pivot is shown and
rebuilds, so both cases matter.

| Recipe | 50,000 rows | 100,000 | 250,000 | 500,000 |
| --- | ---: | ---: | ---: | ---: |
| Count by an `int` of 40 values, raw | 31 ms (32) | 10 ms (14) | 20 ms (35) | 33 ms (55) |
| packed | 31 ms (37) | 12 to 13 ms (14) | 21 ms (25) | 32 to 33 ms (45) |
| By a text of 40 values, raw | 34 ms (43) | 14 ms (15) | 17 ms (20) | 26 ms (31) |
| packed | 34 to 35 ms (44) | 12 to 13 ms (15) | 18 to 19 ms (20) | 27 ms (30) |
| By a text with a value every 20 rows, raw | 23 ms (31) | 15 ms (27) | 24 ms (38) | 57 ms (72) |
| packed | 34 to 37 ms (44) | 16 to 17 ms (30) | 29 ms (45) | 51 to 53 ms (65) |
| By a `datetime2` of 40 values, raw | 28 ms (29) | 17 ms (19) | 26 ms (29) | 47 ms (55) |
| packed | 11 to 27 ms (31) | 17 to 18 ms (19) | 29 to 30 ms (34) | 45 to 47 ms (50) |
| By a `decimal(38,10)` of 40 values, raw | 92 ms (126) | 50 ms (55) | 101 ms (118) | 177 ms (198) |
| packed | 135 to 141 ms (181) | 46 to 50 ms (59) | 86 to 102 ms (117) | 194 to 197 ms (240) |
| By a text of 190 characters with a value every 20 rows, raw | 21 ms (29) | 23 ms (34) | 39 ms (60) | 87 ms (94) |
| packed | 19 to 22 ms (32) | 21 to 23 ms (46) | 43 to 45 ms (62) | 79 to 83 ms (109) |
| Two row groups, Count, Sum and Distinct Count of a text that never repeats, raw | 35 ms (47) | 40 ms (52) | 49 ms (53) | 95 ms (121) |
| packed | 37 to 38 ms (47) | 44 to 45 ms (71) | 57 to 58 ms (73) | 97 ms (114) |

The 50,000-row cases run first in the process, while the runtime is still compiling the paths (the `int` case's first
build is 60 to 96 ms); read the 100,000-row figures for small sources.

## Why 500,000 rows and 250 ms

- **Every recipe at 500,000 rows builds under 250 ms** on this machine, raw or packed. The slowest is the 30-digit
  `decimal` (177 to 197 ms, at worst 240 ms in one packed run), because its ties still read their cells.
- **What is counted is the rows stored in the source result,** not the rows the Table's filters keep. A build keys
  every stored row, so a filter that keeps ten rows of two million still costs two million rows of keys.
- **The 250 ms condition covers what the row count cannot see:** the recipe and the machine. Keys and sorts use up to
  three quarters of the cores (16 here); a four-core laptop gets three, and its builds are nearer single-thread figures.
  The long `decimal` at 500,000 rows has only about 50 ms of margin here, so on a smaller machine it passes 250 ms and
  stays marked out of date, which is what the condition is for.
- **A late or superseded rebuild costs little:** a cancel stops it within milliseconds and the old Pivot stays
  readable, so the threshold guards wasted work and budget more than responsiveness.
- **The budget does not change it.** Build time depends on the rows, not the budget (16 GiB runs matched 2 GiB ones row
  for row). A larger budget allows larger sources; it does not make a given size cheaper.
- **Packed pages cost little at these sizes:** the fused read unpacks each page once into a worker's room. The long
  `decimal` at 500,000 rows is the exception (about 10 % slower and less steady), because its ties re-read cells.
- Nothing past 500,000 rows was run as a threshold case.

## A million rows

`--pivot-bench` on 2026-11-12, after text, date and binary sort keys became ranked or whole, keys and sorts became
multi-threaded and dates are read as ticks. Median of warm builds, a million rows unless the case
says otherwise.

| Case | Build |
| --- | ---: |
| Count by an `int` of 40 values | 32 ms |
| By a `decimal(18,2)` of 40 | 35 ms |
| By a `decimal(38,10)` of 30 digits, 40 values | 290 ms |
| By a `datetime2` of 40 | 86 ms |
| By a text, case-insensitive collation, 40 | 51 ms |
| By a text, binary collation, 40 | 46 ms |
| By a text of 190 characters with a shared start, 40 | 95 ms |
| By a text, case-insensitive, 50,000 values | 92 ms |
| By a text of 190 characters, 50,000 | 162 ms |
| By a `decimal(38,10)`, 50,000 | 677 ms |
| Row groups an `int` then a text of 12 values | 72 ms |
| Row group the `int`, column group the text | 79 ms |
| Distinct Count of a `decimal` | 287 ms |
| Distinct Count of a text of 12 values | 306 ms |
| 5,000,000 rows by an `int` | 315 ms |
| 20,000,000 rows by an `int` | 1.63 s |
| 5,000,000 rows through a filter keeping half | 171 ms |

- **The grouping sort is the largest part of most builds** (40 to 95 %). Text, date and binary groups are within
  about three times of numbers.
- **Still slow:** a `decimal` past 15 digits, whose ties read their cells (on several threads), and Distinct Count,
  whose own sort is one thread (250 ms of each 290 to 330 ms build) and which sorts the rows twice more (by cell, then
  by row group).
- **Aggregation itself** is 2 to 55 ms a million rows whatever the values: sums parse each cell once, one pass over the
  pages serves every Count, Sum, Average, Min and Max, and nothing allocates per row.
- **A wide source costs nothing extra:** keys read one column of each page, and the pages are not read again.
- **A pivot past 100,000 row groups** is refused (`INVALID_PARAMS`) only after its whole sort, because groups are
  counted from the sorted rows.

## Working memory

A build reserves `ResultPivoter.WorkingBytes` from the query's budget for every stored row of the source, whatever the
Table's view keeps: about `rows x (16.25 x key columns + 20)` bytes, so about 36 bytes a row for the first key column and
16 more for each further one. At the 500,000-row threshold that is about 8 MB a key column plus 10 MB. A source that leaves no
room for it is refused in about 0.1 ms with nothing reserved and the source untouched. Every refusal measured happened
before anything changed, so the previous Pivot stays intact. At 1 GiB a query a single 20-million-row build no longer
fits beside its source (725 MB of keys and 347 MB stored) and is refused in under 0.1 s.

Cancellation stopped a 2.3 s build of five million rows within 0.2 to 15 ms at seven points, with nothing left
reserved.

## Parallel builds

`--pivot-bench --only parallel`, after the threaded sorts. Each figure is one cold build (median and slowest of the
builds at once); the five-million-row rows are three runs.

| Source | Budget a query | Builds | Each took | All done | Refused |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000,000 rows, 80 MiB | 1 GiB | 1 | 1.29 to 1.32 s | 1.3 s | 0 |
| | | 2 | 2.6 to 3.1 s | 2.6 to 3.1 s | 0 |
| | | 4 | 2.3 to 4.0 s | 2.5 to 4.1 s | 0 |
| | | 8 | 2.2 to 3.7 s | 2.3 to 3.7 s | 3 |
| 20,000,000 rows, 331 MiB | 1 GiB | 1 to 8 | refused | under 0.1 s | all |
| 20,000,000 rows, 331 MiB | 8 GiB | 1 | 5.3 s | 5.3 s | 0 |
| | | 2 | 17.4 s | 17.5 s | 0 |
| | | 4 | 14.4 to 19.4 s | 19.4 s | 0 |
| | | 8 | 14.9 to 19.4 s | 19.5 s | 0 |

- **Builds share the cores.** Each takes about twice as long as one alone, and four together finish in about half the
  time of four in turn. The worker gate gives each running operation a fair share (docs/ipc.md, Sorted views,
  "Threads"; "Worker threads measured" has pairs of sorts, pivots and profiles).
- **The cap of four stands:** nothing starves, and what stops large builds is the query's budget, by an immediate
  refusal that changes nothing.

## End to end

`scripts/pivot-bench.mjs` on 2026-11-11 (Electron 44, SQL Server 2025, before the sort-key changes above, so the backend
share is now smaller). One result of an `int` column of 40 values and NULL, Count by the column, click to painted:

| Rows | Painted |
| ---: | ---: |
| 20,463 | 112 ms |
| 200,000 | 113 ms |
| 1,000,000 | 246 ms |
| 5,000,000 | 1.21 s |

The renderer's share is 80 to 100 ms (three or four frames) in every row and does not grow with the source, the pivot
or the number of results in the stack. At 20,463 rows the click-to-paint time was 110 to 180 ms in every UI state tried
(two results, about 17,000 row groups, 252 columns, Column Profile open, Row size shown, 42 results in the stack), with
no long task and a longest frame of 17 ms.

## Not measured

- A machine with few cores, Linux and macOS, a packaged build.
- Budgets between 2 and 16 GiB, and sources past 100 million rows.
- Source closure and backend loss in the middle of a build (`PivotChecks` covers the released-source and closed-view
  answers).
- End-to-end figures since the sort-key changes.
