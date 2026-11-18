# Page compression

The backend packs stored result pages with Zstandard so the result budget holds about twice the rows. Results stay in
memory and never spill to disk: nothing is ever dropped or written out to make room. `ResultPacker` decides what is
packed, `PageCodec` packs and unpacks pages, and the readers in `ResultViews` and the operations read packed pages in
place. The measurements below come from `PageCompressionBench` (see [Running the benchmark](#running-the-benchmark)).

## Policy

Packing applies only to complete results of 1 MiB (four pages) or more that are not live tables (`query.Live`: small,
64 KiB pages, replaced every tick) and not held by a pin or lease (a read, an operation, Copy or Save). It is on in
every backend Varia starts (`SqlService`'s `packHidden`, passed only by the backend process); the checks' stores leave
it off unless a check turns it on. There is no setting: the measured costs are below a frame for plain reads, the rules
below keep packing away from results in use, and a setting would only let users keep half the budget idle.

<a id="stage-1-as-built"></a>

### Stage 1: hidden results

A result no window shows, popouts included, is packed once it has been hidden for 5 seconds. The renderer reports
visibility through `results.visibility`. With zstd, showing a result again costs a fraction of a millisecond a screen,
so the delay only avoids packing results the user is still moving between.

- **Its own thread, not the worker gate.** The gate shares its threads fairly with no priority, so packing through it
  would take half the workers from a visible sort. One thread packs a result page by page, compressing each page at the
  lowest priority where the operating system honours it (Windows; on Linux and macOS it competes as an ordinary
  thread). Everything done under a lock or that allocates (the visibility lookup, renting and copying the page's buffer,
  replacing a page, charging the budget) runs at normal priority, because a lowest-priority thread preempted while
  holding the store's or a set's lock would stall reads and new queries until the scheduler boosted it. The thread packs
  at 200 to 400 MB/s, 3 to 5 s a GiB. On a machine whose processors are all busy it may barely run (the offline stress
  run showed it waiting tens of seconds); the result then stays raw a while longer.
- **One reused encoder, streamed.** The thread keeps one encoder, warmed at normal priority, so it does not allocate a
  native context per page while lowered, and compresses each page as a stream of unknown length. With the length
  unknown, zstd uses level 2's tables for inputs over 256 KiB for every page; full pages are a little over 256 KiB, so
  ratios are unchanged. Only a short last page, or a page of very few narrow rows, may pack a few percent less.
- **Event-driven.** The thread sleeps until the next hidden result falls due, a result of 1 MiB or more completes,
  `results.visibility` applies a new set, or a pin, lease or operation that stopped or undid packing ends.
- **An operation's unpack counts as a use.** A hidden result that an operation has just unpacked whole waits the delay
  again, so a result read run after run is not unpacked and packed each time.

<a id="stage-2-as-built"></a>

### Stage 2: idle shown results

A shown result is packed on the same thread, with the same rules, once it has been idle for 30 seconds
(`ResultPacker.VisibleIdleMs`): no pin or lease has begun or ended, the result has not completed and it has not been
shown again for 30 s (`ResultSetBuffer.Activity` on `ResultStore.Clock`). The wait runs from the end of a hold. The grid
reads its result every time it scrolls, so a result the user is looking through never falls due; 30 s keeps a result
raw while the user reads a screen and scrolls on, and packs results left on screen in other tabs and groups within a
minute. Hidden results keep 5 s.

- **No thrash.** A read stops a pass at its next page (the set's touch count changed) and keeps the pages already
  packed: the result shows as `partial` in the Memory panel and falls due again 30 s later. Plain reads never unpack a
  result whole. Each operation that unpacks it whole (see [Operations that unpack first](#operations-that-unpack-first))
  doubles the wait, up to eight times as long (`MaxBackoff` = 3 doublings, 4 minutes).
- **A sorted or filtered grid is packed like any other, and never unpacked for its view.** A view reads its rows' pages
  in the view's order, a page or so a row. The grid reads 128-row tiles: through main, a random tile of a sorted
  1,000,000-row view takes about 3.1 ms packed against 0.5 ms raw on 16 cores (p99 7.0 against 1.3 ms; on 4, 7.2 ms
  packed, p99 19 ms; `node.viewTile.*`). The grid
  prefetches two views either way once scrolling pauses and reads nothing during a fast scroll until it settles, so
  scrolling rarely waits on it and a jump pays one or two tiles. Those figures are with room in the budget: a tile
  unpacks its pages on the workers as a group (`ViewPages.UnpackTogether`, up to 16 MiB of working memory). When the
  budget refuses the group, as when packing for room just gave its room to a new query, the tile unpacks each row's
  page on one thread through the cache, about 45 ms a screen, until the budget has room again. A shown result with an open view is packed once idle,
  and the sort reads a packed result fused and its screens read the packed pages. Unpacking it whole for its view would
  keep the raw bytes out of the budget (131 MiB for a 256 MiB `orders` result) for tiles a few milliseconds faster.
  `node.packedSort.budgetGrowthMb` (`npm run bench`, floor in `tests/bench/floors.json`) fails if sorting a packed shown
  result grows the budget by more than its view's order.
- **Find through a sorted grid reads in page order.** A search through a view far from its packed pages' order reads
  the result in page order, fused, each row placed at its view position through the view's inverse (4 bytes a row of the result, for
  the search's length), keeping per run only the rows its answer may take. It never unpacks the result: a sorted
  1,000,000-row view of a packed W1 result searched whole in about 33 ms, the budget as before (`node.packedSearch.*`).
- **Value lists do not keep a result raw.** A distinct snapshot keeps its result's pages, not their bytes, so its later
  reads go through packed pages.
- **Candidates are asked again** before a pass starts and before each page: one the user began to work with meanwhile
  (an operation holds it or has unpacked it) is left alone.

### Room for a query

When the budget refuses a query's row (its half or the global budget) and something could be packed
(`ResultStore.CanMakeRoom`), the row stays open and ingestion waits outside every lock (`WaitForRoomAsync`: up to 10 s a
wait, 4 waits a row, 30 s in all for the query) while the policy packs at once, at normal priority, on the workers'
gate (`ViewSorter.Gate`, a page an item, sharing threads fairly with sorts and reads). It packs complete, unheld results
of 1 MiB or more that could make room: any query's for the global budget, only the query's own when its half is full;
hidden first, then largest, until no query waits. It ignores the idle delays but never takes one an operation unpacked
and still uses. While a row waits, the rows committed before it are not yet
sealed. With nothing to pack, or once the waits run out, the row is refused and the query truncated as before. Stored
rows are never dropped, and a stop is never undone: stored rows stay a prefix of the rows read.

Idle packing stays on the lowest-priority thread, since nobody is waiting on its saving; packing for room goes through
the gate, since a query is waiting.

## Format and codec

Zstandard in the runtime is why the backend targets .NET 11, a short-term-support release; it moves to .NET 12 (LTS)
when that ships.

A packed page's body is replaced by its Zstandard bytes with the raw length beside it, one page at a time. `FirstRow`,
`Rows` and the lengths sidecar (`PageLengths`, 4 bytes a row, 0.3 to 3.4 % of a result) stay raw, so `results.rowBytes`,
`CellSize` and the row index work without unpacking. The page being built and pages of an open result are always raw.
A page whose packed size saves less than 10 % stays raw.

**Zstandard level 2**, built into .NET 11's `System.IO.Compression` (window 18). It is not in .NET 10, which is why the
backend moved to .NET 11; a NuGet wrapper would have added a native library. Why level 2:

- **Decompression is what every read pays,** and zstd's is about four times Brotli's at the same or better ratio. LZ4
  and zstd's negative levels decompress faster again, but by then decompression no longer matters (0.15 ms a page) while
  the memory saved halves.
- **Level 2 over level 1:** 3 to 10 % better ratio at the same decompression speed. Packing runs in the background.
- **Level 3 and above** add under 3 % for half the compression speed or less.
- The decoder reads any level, so the level can change later without a format change.

**Lengths form.** Zstandard packs a page's ascending u32 offsets poorly and its cells' lengths well, so `PageCodec`
packs each page in its lengths form (`PageCodec.Lengths.cs`): each column's offsets become one LEB128 length when every
non-NULL cell has that length (dates, keys, GUIDs; about 40 % of columns), else each cell's LEB128 length, and the zero
padding between regions is dropped. Unpacking rebuilds the page as sealed in its own room, so readers never see the
form. Bytes that are not exactly a sealed page are packed as they are. The form packs 3 to 55 % more rows into the
same budget (table below). The other integer packings measured (Group Varint, Stream VByte with a SIMD prefix sum,
128-value frame-of-reference bit packing) came within 1.5 % of LEB128 once Zstandard ran, and rebuilding offsets costs
about 1 ns a cell against Zstandard's 150 µs a page, so SIMD decoding buys nothing measurable.

1 GiB of each realistic shape on .NET 11, page window 256 KiB (a 4 MiB window gave the same ratio). Ranges run across
the four shapes (`orders`, `wide`, `log`, `numeric`; see [Shapes](#shapes)):

| Codec | Ratio | Compress, 1 thread | Decompress, 1 thread | Decompress 1 GiB, 16 workers |
| --- | ---: | ---: | ---: | ---: |
| zstd −1 | 1.15–1.66 | 420–940 MB/s | 2.0–3.8 GB/s | 0.02–0.04 s |
| zstd 1 | 1.86–2.70 | 370–780 MB/s | 1.4–1.8 GB/s | 0.04–0.05 s |
| zstd 2 | 1.93–2.80 | 310–380 MB/s | 1.3–1.9 GB/s | 0.05 s |
| **zstd 2, lengths form** (`page`) | **2.29–3.24** | **270–330 MB/s** | **1.4–1.7 GB/s** | **0.05 s** |
| zstd 3 | 1.93–2.82 | 170–190 MB/s | 1.1–1.7 GB/s | 0.05–0.06 s |
| LZ4 | 1.13–1.51 | 450–680 MB/s | 3.0–3.8 GB/s | 0.02–0.04 s |
| LZ4 HC 3 | 1.43–2.11 | 67–81 MB/s | 3.1–4.2 GB/s | 0.02 s |
| Brotli 1 | 1.90–2.68 | 230–280 MB/s | 400–430 MB/s | 0.16–0.19 s |
| Deflate 6 | 1.96–2.55 | 65–84 MB/s | 400–450 MB/s | 0.16–0.18 s |

Per page, the store's codec decompresses in a median 146 to 179 µs (p99 0.2 to 0.5 ms) and compresses in 0.7 to 1.0 ms.
With the lengths sidecar, which stays raw, `numeric` packs 1.87 → 2.90 times, `orders` 2.05 → 2.55, `wide` 2.78 → 3.22 and
`log` 2.22 → 2.28 (zstd 2 over pages as sealed → the lengths form). A packed result takes 31 to 44 % of its raw memory
in these shapes; random keys, hashes or GUIDs compress 1.1 to 1.5 times or not
at all. At 8 GiB the ratios and per-page speeds were the same. Packing on the workers (for room) takes about 0.2 s of 16
workers a GiB (1.5 to 2.0 s for 8 GiB).

## Reading a packed result

Every reader gets page bodies through one accessor and pins the result while it reads. A missed call site would fail
with "Unsupported result page" (`PageView.Parse` checks the header), and the offline checks run a second pass with
every complete result packed.

- **Plain `results.read`:** the pages it needs, through a per-result cache of six unpacked pages charged as working
  memory, freed with the result. About 0.2 ms a 1,000-row read while scrolling `orders`, 0.8 ms on `log`, 0.4 to 1 ms
  for a jump: well inside a frame. A plain read never unpacks a result whole, so reading does not undo packing.
- **`results.read` through a view:** the distinct pages behind the rows asked for, unpacked in parallel on the workers.

### Fused per-page reads

A sort, filter, profile, pivot, distinct value list, row identity, search, diff and a plain Copy or Save read a packed
result in place. Each worker unpacks the page it is about to read into a room of its own (`PageRooms`), reserved as
working memory, so the operation holds about a page a worker and the result stays packed.

- A fused sort, filter, profile, distinct list, row identity or search holds 16 rooms of one page (4 MiB) instead of
  what unpacking adds (raw less packed: 525 MiB at 1 GiB, 2.1 GiB at 4 GiB). The pivot holds two batches of rooms
  (8 MiB), one read while the next is unpacked.
- **Sort ties.** A key whose comparisons go back to cells (long exact numbers that tie as doubles, text kept as 8-byte
  prefixes) extracts its column once after it is built: that column's cells of every page, charged as working memory
  (300 MiB at 1 GiB for `orders`' note column). No comparison unpacks a page; a sort compares millions of ties. If the
  extract is refused, the result is unpacked in place (rooms and extracts given back first), so a sort that unpacking
  could run still runs.
- **Distinct snapshots** keep their result's pages, not their bytes. Later reads and value searches go in row order
  through one room, each page unpacked once.
- **Diffs** in about their pages' order read the first result in the second's order through a few kept pages a run
  (`LeftSlots`), and the unified result, written on one thread, has each side's pages unpacked ahead on the workers (two
  batches of rooms, taken only from memory the budget can spare). A diff holds 35 to 89 MiB instead of both results'
  growth (1 and 4.2 GiB).
- **Copy and Save** stay on one thread and unpack each page just before writing it (0.5 to 0.9 s per GiB, 1.4 to 2.5
  times the raw Save). They are never refused for want of room. Decompressing ahead on a second thread was not built.
- Fused rooms are plain arrays freed with the operation.

### Operations that unpack first

These revisit pages at random, so they unpack the result whole ("rehydrate": every page unpacked on the workers into
raw pages after reserving raw less packed; 0.15 s per GiB on 16 workers, 0.36 s on 3):

- a diff whose first result is read far from its pages' order, after counting the unpacks its order would cost
  (`ResultDiffer.Local`: past four a page). It holds what unpacking that result adds (562 MiB at 1 GiB) instead of both
  results' growth (1,060 MiB), and the second result stays packed;
- a transposed Copy or Save, which unpacks the pages its rows lie on;
- a pivot or column extract refused its rooms.

If the reservation is refused, the operation answers `TOO_LARGE`, as a sort that does not fit does.

## Budget and memory

- **A packed page is charged its packed length plus `PageOverhead` plus its sidecar.** Packing returns the difference
  to the query and global budgets at once.
- **The unpacked-page cache, rooms, extracts and rehydration are working memory.**
- **Returning memory to the operating system follows `ResultStore.CollectNow`.** Bytes packing frees count as freed, so
  packing triggers the same collections as a release, but it never forces a compaction on its own. A non-compacting
  collection gives back almost nothing (0.1 to 0.3 GiB), yet the freed space is reused: 4.2 to 5.3 GiB of new pages
  fitted with no growth in the GC heap's commit. So the saving is real for the process even without compaction, and
  charging the budget the packed size at once is honest. A compacting collection gives everything back (down to the
  packed bytes plus about 100 MiB) but pauses 1.0 to 1.4 s for 3 to 4 GiB that remains, 0.1 to 0.3 s a GiB (about 0.3 s on the busy
  benchmark machine), so `ResultStore.MayCompact` will often decline after packing alone. Unpacking
  and packing again leaves no residue.
- **Views** (sort orders, filter masks, `KeyMemory`) are not pages and are not packed. Pivots and diffs are results
  (`Derived`) and follow the same rules. Live tables are never packed.

The status bar's Memory panel shows packed figures in its Nerd metrics section ([status-bar-memory.md](status-bar-memory.md)).

## Measurements

All on an Intel Core Ultra 9 285K (24 cores, 16 result workers), 64 GB, Windows 11, .NET 11 Release with workstation
concurrent GC, on 2026-11-12 to 2026-11-14 while other sessions loaded the machine. Times moved by up to 30 % between
repeats; ratios and memory figures do not depend on load. Except the `--policy` budget row, these ran with zstd 2 over
pages as sealed; the lengths form unpacks at the same speed and packs smaller (see [Format and codec](#format-and-codec)).

`orders`, zstd 2 (packs 2.05 times). Fused against rehydrating, median seconds, and the most working memory charged
above the result:

| Operation | 1 GiB raw | rehydrate | fused | budget, rehydrate | budget, fused | 4 GiB raw | rehydrate | fused |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sort by a random `int` | 0.53 | 0.42 | 0.39 | 525 MiB | 4 MiB | 1.56 | 1.80 | 1.68 |
| Sort by a text | 1.32 | 1.40 | 1.36 | 639 MiB | 118 MiB | 6.07 | 5.91 | 6.17 |
| Sort by prose text, ties compare cells | 1.89 | 1.89 | 1.93 | 525 MiB | 305 MiB | 9.26 | 9.43 | 8.51 |
| Filter: IN on a low-cardinality column | 0.06 | 0.13 | 0.13 | 525 MiB | 4 MiB | 0.22 | 0.46 | 0.43 |
| Profile of two columns | 0.15 | 0.19 | 0.21 | 525 MiB | 4 MiB | 0.48 | 0.73 | 0.82 |
| Pivot: count, sum, max by status | 0.31 | 0.38 | 0.45 | 525 MiB | 8 MiB | 1.29 | 1.50 | 1.71 |
| Save as CSV (one thread) | 0.85 | 0.96 | 1.38 | 525 MiB | 0.25 MiB | 3.00 | 3.17 | 5.49 |
| Distinct list, low cardinality | 0.16 | 0.11 | 0.12 | 525 MiB | 4 MiB | 0.19 | 0.41 | 0.42 |
| Distinct list, high cardinality, with a value search | 2.53 | 2.47 | 2.83 | 639 MiB | 118 MiB | 13.86 | 17.76 | 15.87 |
| Row identities | 0.06 | 0.09 | 0.08 | 525 MiB | 4 MiB | 0.11 | 0.38 | 0.30 |
| Search | 0.12 | 0.20 | 0.15 | 525 MiB | 4 MiB | 0.49 | 0.71 | 0.62 |
| Diff, second result in the same order | 0.32 | 0.38 | 0.49 | 1,067 MiB | 35 MiB | 1.16 | 1.83 | 2.06 |
| Diff, second result shuffled | 0.67 | 0.76 | 0.84 | 1,060 MiB | 562 MiB | 2.99 | 3.50 | 3.97 |

Against rehydrating, fused reads cost from 10 % less to 26 % more time on the workers' operations (sort, filter, profile,
pivot) and from 25 % less to 27 % more on most whole-result operations; Save and a diff in the same order cost more, as the
table shows. That is about 0.05 s per GiB unpacked on 16 workers, paid in each operation. Results that are not packed read as before.

The policy, with the real `ResultPacker` (`--policy`: one 1 GiB result; `--stage2`: four of 256 MiB, the first shown):

| | `orders` | `log` |
| --- | ---: | ---: |
| Budget charged, raw → stage 1 → stage 2 (`--stage2`) | 1,043 → 646 → 513 MiB (2.03×) | 1,033 → 607 → 466 MiB (2.22×) |
| Budget charged, raw → packed (`--policy`, lengths form) | 1,039 → 418 MiB (2.48×) | 1,030 → 442 MiB (2.33×) |
| Stage 1 pass over 1 GiB, one thread | 2.7 to 3.9 s (275 to 400 MB/s) | 3.4 to 3.5 s (303 to 316 MB/s) |
| Stage 2 pass over the shown 256 MiB, one thread | 0.86 to 1.27 s (213 to 312 MB/s) | 1.13 s (238 MB/s) |
| Three pages at random positions, raw → packed, cold cache | 1 µs → 0.63 to 0.70 ms | 1 µs → 0.62 ms |
| 1,000-row read while scrolling, raw → packed (median, p99) | 0.8 µs → 0.20 ms (0.7 to 5 ms) | 1.2 µs → 0.77 ms (1.4 ms) |
| 1,000-row read at a random row, raw → packed | 1 µs → 0.42 ms (p99 0.9 to 4 ms) | 0.9 µs → 0.96 ms (p99 3.3 ms) |
| Sorted view's 256-row screen, raw → packed | 0.9 ms → 4.2 to 5.7 ms (p99 25 to 28 ms; 3 workers: 1.0 → 22 ms) | 0.41 ms → 5.0 ms |
| The policy's next look once the packed shown result is sorted | adds 0 MiB (it stays packed) | |
| First sort after idle, raw → packed (fused) | 0.36 to 0.49 s → 0.26 to 0.37 s | 0.13 s → 0.28 s |
| An operation's whole unpack, 16 workers (1 GiB) | 0.07 to 0.16 s | 0.06 s |
| A second query's fill alone → beside packing | 0.89 to 1.21 s → 0.80 to 1.09 s | 0.80 to 0.85 s → 0.77 to 0.78 s |

A new query stores its rows no slower while the policy packs. The six-page cache hits 2 to 6 % of lookups while
scrolling, because the grid reads pages it has not read since they were packed, so a cold page's cost (about 0.2 ms) is
what matters.

## Running the benchmark

`dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --page-compression-bench <GiB> <shape>
[options]` (`PageCompressionBench.cs`, `PageCompressionBench.Fused.cs`, `PageCompressionBench.Stage2.cs`), one size and shape a process so each memory
reading is its own. It fills a query budget as ingestion does (`ResultSetBuffer.BeginRow`/`TryCommitRow`, real
`PageBuilder` pages and lengths sidecars), prints one JSON line per metric, measures only and checks nothing, and is
not part of `npm run check` or CI. Every run warms the JIT with an untimed pass and reports the median of three.

- With no mode flag: each codec over a 384-page sample on one thread and over every page on the workers; every
  operation on raw pages; reads of three pages, a scroll trace through LRU caches of 0, 6 and 24 pages, a sorted view's
  screen and a streamed Save on packed pages; then the process's memory with the raw pages dropped, before and after
  collections, and every operation again on rehydrated pages.
- `--codecs name,name` picks the codecs run over all pages; `--keep name` (default `brotli1`) is the one kept for the
  memory and rehydrate steps; `--no-ops` skips the operations. Codec names: `brotli<quality>`, `deflate<level>`,
  `zlib<level>`, `zstd<level>` (`zstdm1` is level −1), `zstd<level>r` (one encoder and decoder kept per thread),
  `lz4`, `lz4hc3`, `w22` for a 4 MiB window, and `page` for the store's own codec (`PageCodec`: zstd 2 over the
  lengths form).
- `--fused`: each operation raw, rehydrated and fused, with budget and heap peaks. `--fused --whole`: distinct lists,
  row identities, search and diffs.
- `--policy`: the real `ResultPacker` over one result. `--stage2`: four results of 256 MiB, the first shown.
- `VARIA_BENCH_CORES=n` holds the process to n cores and the workers to what such a machine would have.

The LZ4 package (`K4os.Compression.LZ4`, managed) is referenced only by the test project, for the comparison.

### Shapes

Every cell is a deterministic function of its row and column, from a hash. Text uses about 110 common English and
business words then 3,900 made-up words, heavily skewed toward the common ones, with a number every ninth word, so it
compresses roughly as prose and log messages do. No user data, SQL text or values appear in any output.

| Shape | Columns | Bytes a row | Stands for |
| --- | --- | ---: | --- |
| `orders` | 14: keys, status and region text, decimals, dates, `uniqueidentifier`, e-mail, a 20–300 character note (50 % NULL), `bit`, `float` | 287 | A typical OLTP query |
| `wide` | 120: key, then cycling `int`, label, `datetime2`, `decimal`, sparse `int`, `bit` | 1,538 | A wide reporting row |
| `log` | 7: key, timestamp, level, source, thread, message of 100–1,500 characters, `uniqueidentifier` | 927 | Text-heavy rows |
| `numeric` | 8: numbers and dates only | 116 | Narrow numbers |
| `w1` | `SyntheticRows` W1 | 219 | Reference only: compresses far better than real data |

## Not measured

- Real sessions: how big users' results are and how many tabs hold them.
- Binary columns and documents (xml, json, plans).
- Fused reads with fewer workers, on `wide` and `log`, and under contention on the worker gate.
- zstd 2 with a reused encoder per thread in the one-shot path, and zstd dictionaries.
- End-to-end time in the app (renderer and IPC); Linux, macOS and a real 4-core machine.
