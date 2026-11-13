# Page compression findings

A measured prototype for compressing stored result pages that nobody is looking at, measured on 2026-11-12. This is
a benchmark and design page. It changes nothing in the product: pages are still stored as they are sealed. The rule
agreed with the owner still holds: results stay in memory and never spill to disk.

## Summary

- **Codec: Brotli at quality 1, window 18 (`BrotliEncoder.TryCompress`), one page at a time.** On realistic pages it
  stores a result in **38 to 53 % of its memory** (ratio 1.9 to 2.7). One thread compresses a 256 KiB page in about
  0.8 ms and decompresses it in about 0.65 ms. On the results' 16 workers, a whole 8 GiB result compresses in 2.2 to
  2.9 s and comes back in 1.5 to 1.9 s.
- **Deflate and ZLib at their fastest are worse on every count** (ratio 1.3 to 1.7, compression no faster). Deflate at
  level 6 matches Brotli 2's ratio but compresses three to five times slower. **Zstandard is not in .NET 10.** It
  arrives in `System.IO.Compression` in .NET 11 (in preview today), so it is a candidate only after that upgrade.
- **Once decompressed, every operation runs as fast as on raw pages.** The sort, filter, profile, pivot and Save over
  a decompressed result matched their raw times within this machine's noise. The cost is decompressing first: about
  0.2 s per GiB on 16 workers, and 1.0 s per GiB on 3 workers (a 4-core machine).
- **Pages must not be decompressed one at a time on demand, except for plain scrolling.** A plain read of three pages
  costs about 2 ms instead of 0.05 ms, or 0.8 ms with a six-page cache. But 256 rows of a sorted view come from about
  250 different pages: 160 ms to decompress, every time the grid scrolls. A Save that decompresses as it goes on one
  thread takes four to six times as long as from raw pages. So a result is either all raw or all compressed, and it
  goes back to raw before anything other than plain scrolling reads it.
- **Memory comes back to the operating system only through a compacting collection.** A non-compacting gen2
  collection after compressing 8 GiB gave back about 1 % of what was saved (private bytes 13.6 to 13.4 GiB). A
  compacting one brought the process down to the compressed size (8.3 GiB raw to 4.4 GiB), but it stopped every
  thread for 1.1 to 1.3 s while it copied the 3 to 4 GiB that remained. That is 0.3 s per GiB here, above the 0.1 to 0.2 s that
  `ResultStore` notes, on a busy machine. Without compaction the freed space is still reused: 4 GiB of new pages
  allocated after a non-compacting collection did not grow the GC heap's commit at all
  ([Reuse without compaction](#reuse-without-compaction)). So the budget can be credited at once, and giving memory
  back to the operating system can wait for the compactions `ResultStore` already runs.
- **What it saves:** hidden results take half their budget or less. That is worth having only for large results: a
  session whose results are a few megabytes gains nothing. Nothing here measured real sessions.
- **Recommendation:** worth building, in the five PRs at the end. The first is a refactor with no change in behaviour,
  so later PRs can stop at any point.

## Environment

| | |
| --- | --- |
| Machine | Intel Core Ultra 9 285K (24 cores: 8 fast, 16 slower), 64 GB, Windows 11 Pro 10.0.26200 |
| Runtime | .NET 10.0 (SDK 10.0.403), Release build, workstation concurrent GC (the backend's settings) |
| Revision | `main` at `ce9d1659` plus this branch's benchmark |
| Workers | `ViewSorter.Workers` = 16 on 24 logical processors; one run with `VARIA_BENCH_CORES=4` (3 workers) |
| Budget | One query budget the size of the run (1 or 8 GiB), global four times that; no memory-load check |
| Data | Synthetic only (below). No user data, SQL text or values in any output |

Four other sessions were building and benchmarking on the machine the whole time, and the processor was often at
100 %. Repeated medians moved by up to 30 %, single runs by more (one raw Save of the wide shape took 6.9 s and then
19 s). Differences smaller than that mean nothing here. Compression ratios and memory figures do not depend on load;
times do.

## Fixtures and how to run them

`dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --page-compression-bench <GiB> <shape>
[--codecs name,name] [--keep name] [--no-ops]` (`PageCompressionBench.cs`), one size and shape a process so each
memory reading is its own. It fills a query budget as ingestion does (`ResultSetBuffer.BeginRow`/`TryCommitRow`, real
`PageBuilder` pages and lengths sidecars), then:

1. Each codec over a sample of 384 pages on one thread (speed, median and p99 per page), then over every page on the
   workers (ratio, speed).
2. Every operation on the raw pages. The first full pass is untimed and warms the JIT; then three timed runs, median
   reported. Without the warm pass the first raw runs were 2 to 10 times slower, because tiered compilation was still
   promoting the code.
3. A `results.read` of three pages, raw and compressed. A scroll trace through an LRU cache of 0, 6 and 24
   decompressed pages. A read of 256 rows through a view sorted by a random `int`. A Save that decompresses each page
   into one reused buffer just before writing it.
4. Drops the raw pages, keeping only the kept codec's (`--keep`, default `brotli1`), and reads the process's memory
   with no collection, after a non-compacting gen2 collection, after allocating new pages for the bytes saved, and
   after `ResultStore.CollectNow`'s compacting collection (timed).
5. Decompresses every page on the workers into new arrays ("rehydrate"), runs every operation again, then drops them
   and compacts again.

`--codecs` picks which codecs run over all pages (the kept one always does). `--no-ops` skips steps 2 and 5, and
the view read and streamed Save of step 3. `VARIA_BENCH_CORES=n` holds the process to n cores and the workers to what such a machine would
have. It prints one JSON line per metric. It measures only and checks nothing, and it is not part of `npm run check`
or CI. The result-scale benchmark used in earlier hand runs (`--result-scale-bench`) is not in the repository; this
one borrows its way of filling the store.

### Shapes

Every cell is a deterministic function of its row and column, from a hash, so values do not repeat in patterns.
Text uses about 110 common English and business words followed by 3,900 made-up words, chosen with a heavy skew toward
the common ones, with a number every ninth word. It compresses roughly as prose and log messages do, not as repeated
filler.

| Shape | Columns | Bytes a row | What it stands for |
| --- | --- | ---: | --- |
| `orders` | 14: sequential `int` key, random `int` (200,000 values), status (6) and region (12) text, `decimal(18,2)`, `int` 1–20, increasing `datetime2(7)`, `date` 60 % NULL, random `uniqueidentifier`, e-mail, `decimal(5,2)` 85 % NULL, note of 20–300 characters 50 % NULL, `bit`, `float` | 287 | A typical OLTP query |
| `wide` | 120: key, then cycling random `int`, label of 5,000 values, random `datetime2`, `decimal`, `int` 90 % NULL, `bit` | 1,538 | A wide reporting row |
| `log` | 7: key, increasing `datetime2`, level (5), source (40), thread, message of 100–1,500 characters, `uniqueidentifier` | 927 | Text-heavy rows |
| `numeric` | 8: key, random `int` and `bigint`, `decimal(38,10)`, `float`, `date` 10 % NULL, `decimal` 30 % NULL, `int` of 16 values | 116 | Narrow numbers only |
| `w1` | `SyntheticRows` W1 | 219 | Reference only: each cell nearly repeats its neighbour, so it compresses far better than real data |

The lengths sidecar (`PageLengths`, 4 bytes a row) is 0.3 % (wide) to 3.4 % (numeric) of a result's bytes. It stays
raw in every design below, because the views read it. The ratios below are of page bodies; counting the sidecar
lowers them by 1 to 3 %.

## Codecs

1 GiB of each shape. The first run of the day, when the machine was quieter. "1 thread" is MB/s of page bytes over the
sample; "All" is every page on 16 workers. Brotli's window is 18 (256 KiB, one page) unless marked: a 4 MiB window
(`w22`) gave the same ratio.

| Codec | `orders` ratio | `wide` | `log` | `numeric` | `w1` | Compress, 1 thread | Decompress, 1 thread | Compress 1 GiB, all | Decompress 1 GiB, all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Brotli 0 | 1.82 | 2.26 | 1.89 | 1.67 | 3.88 | 260–410 MB/s | 310–340 MB/s | 0.26–0.59 s | 0.20–0.45 s |
| **Brotli 1** | **1.99** | **2.68** | **2.11** | **1.90** | **4.72** | **130–340 MB/s** | **330–410 MB/s** | **0.33–0.70 s** | **0.16–0.28 s** |
| Brotli 2 | 2.19 | 2.77 | 2.26 | 2.01 | 5.66 | 86–160 MB/s | 360–410 MB/s | 0.49–0.99 s | 0.18–0.33 s |
| Brotli 3 | 2.20 | 2.80 | 2.27 | 2.01 | 5.60 | 76–150 MB/s | 360–430 MB/s | 0.56–1.10 s | 0.16–0.31 s |
| Brotli 5 | 2.47 | 2.92 | 2.44 | 2.38 | 7.48 | 25–45 MB/s | 340–450 MB/s | 2.1–2.8 s | 0.16–0.25 s |
| Deflate 1 | 1.51 | 1.70 | 1.53 | 1.33 | 3.08 | 130–240 MB/s | 280–490 MB/s | 0.39–0.68 s | 0.19–0.33 s |
| Deflate 6 | 2.13 | 2.55 | 2.21 | 1.96 | 4.36 | 47–85 MB/s | 260–460 MB/s | 0.89–1.91 s | 0.16–0.39 s |
| ZLib 1 | 1.51 | 1.70 | 1.53 | 1.33 | 3.08 | 99–250 MB/s | 250–450 MB/s | 0.34–0.70 s | 0.17–0.33 s |

The speed ranges run from the `log` shape (slowest: long text) to `numeric` or `wide`. Per page, Brotli 1 compresses in
a median 0.73 to 1.5 ms and decompresses in 0.63 to 0.67 ms; its decompression p99 was 0.9 to 3.8 ms. At 8 GiB the
ratios were the same to two decimals (`orders` 2.01, `wide` 2.68, `log` 2.12), and so were the speeds per page.

Why Brotli 1:

- Decompression costs the same at every Brotli level. Only compression cost and ratio change.
- Quality 1 gains 6 to 19 % in ratio over quality 0 at about the same speed.
- Quality 2 gains another 4 to 10 % but compresses at half the speed. That is a fair alternative if compression runs
  in the background (see [Recommended design](#recommended-design)): the choice is per page and can change without a
  format break, because the decoder reads any quality.
- Deflate at level 1 stores 25 to 35 % more than Brotli 1 and compresses no faster. ZLib only adds a checksum.

Zstandard: `ZstandardEncoder`, `ZstandardDecoder` and `ZstandardStream` are new in .NET 11's `System.IO.Compression`
and marked preview. The .NET 10 runtime on this machine (10.0.14) has no Zstandard type. A NuGet wrapper would be a new
native dependency, which the brief ruled out. Revisit after the .NET 11 upgrade: Zstandard's fast levels usually
decompress several times faster than Brotli, which is the cost that matters most here.

## Cost to the operations that read pages

### Whole-result operations at 8 GiB

Median of three runs, seconds. "Decompressed" is the same operation on pages decompressed into new arrays. "Decompress
first" is the time to do that on 16 workers before the operation can start.

| Operation | `orders` raw | decompressed | `wide` raw | decompressed | `log` raw | decompressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Decompress first (all pages, 16 workers) | | 1.89 | | 1.50 | | 1.53 |
| Sort by a random `int` | 3.39 | 3.21 | 0.64 | 0.72 | 0.65 | 0.61 |
| Sort by a text | 14.7 | 14.0 | 0.86 | 0.77 | 0.94 | 0.92 |
| Filter: IN on a low-cardinality column | 0.46 | 0.41 | 0.28 | 0.22 | 0.14 | 0.14 |
| Profile of two columns | 1.01 | 0.84 | 0.20 | 0.16 | 2.73 | 2.80 |
| Pivot: count, sum, max by status | 2.80 | 2.83 | 0.77 | 0.50 | 0.67 | 0.65 |
| Save as CSV (one thread) | 5.12 | 4.99 | 15.5 (6.9–19.0) | 7.02 | 1.79 | 1.75 |
| Save, decompressing each page just before it is written (one thread) | | 28.7 | | 26.9 | | 21.5 |

At 1 GiB the picture is the same: decompress first 0.18 to 0.26 s, then each operation within noise of raw.

- **Decompressed pages cost nothing more to read.** Every operation reads `byte[]` bodies through `PageView`, so a
  rehydrated result behaves exactly as a raw one.
- **The one-thread Save shows why decompression must not sit in the reading thread.** A Save formats about 1.4 GB/s
  of page bytes, and one thread decompresses about 0.4 GB/s. Decompressing ahead on the workers, or rehydrating first
  (1.5 to 1.9 s here), keeps it near the raw time.
- **On a small machine decompressing is the larger cost.** With 3 workers (`VARIA_BENCH_CORES=4`), 1 GiB of `orders`
  took 1.04 s to decompress (0.22 s on 16), so 8 GiB would take about 8 s (extrapolated, not measured).

### Scrolling

| Read | Time |
| --- | ---: |
| `results.read` of three raw pages (copying the bytes once) | 51–71 µs |
| Three compressed pages, decompressed into new arrays | 2.0–2.2 ms (p99 2.6–5.2 ms); `w1` 1.1 ms |
| Scroll trace (forward 300 pages, back 100, 50 jumps), no cache | 2.0–2.3 ms a read |
| The same with an LRU of 6 decompressed pages (1.5 MiB) | 0.78–0.93 ms a read |
| The same with 24 pages (6 MiB) | 0.76–0.87 ms a read |
| 256 rows of a view sorted by a random `int` (≈250 source pages) | 158–167 ms |
| The same in `log` (fewer rows a page: ≈58 pages) | 38 ms |

Plain scrolling of a compressed result is fine: 2 ms is far inside a frame, and a six-page cache halves it (a
larger cache adds almost nothing). A sorted or filtered view is not: its rows are scattered across the whole result,
so each screen decompresses hundreds of pages. That is why the design below decompresses a whole result before it is
shown.

## Memory returned to the operating system

The process's private bytes (its commit) as the run went, MiB. "Raw" is after the fill and a compacting collection.
"Dropped" is with the raw pages unreachable and the compressed copies held, before any collection; it is the peak of
both together.

| Stage | `orders` 8 GiB | `wide` 8 GiB | `log` 8 GiB | `orders` 1 GiB | `numeric` 1 GiB | `w1` 1 GiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Raw | 8,305 | 8,305 | 8,305 | 1,055 | 1,055 | 1,055 |
| Dropped, no collection | 13,597 | 12,327 | 14,466 | 2,820 | — | — |
| After a non-compacting gen2 collection | 13,426 | 12,100 | 14,302 | 2,754 | — | — |
| After a compacting collection | **4,366** | **3,165** | **4,012** | **574** | **599** | **266** |
| Pause of the compacting collection | 1.29 s | 1.08 s | 1.29 s | 0.28 s | 0.60 s | 0.22 s |
| After decompressing everything again, dropping it and compacting | 4,366 | 3,167 | 4,015 | 572 | 597 | 265 |

(The 1 GiB `numeric` and `w1` runs compressed with every codec in turn, so their "dropped" figures hold other codecs'
copies and are left out.)

- **A non-compacting collection gives back almost nothing.** It frees the raw pages inside the heap, but the GC keeps
  the memory committed: 0.2 GiB of 4 GiB saved, for `orders`.
- **A compacting collection gives it all back,** down to the compressed bytes plus about 100 MiB of process. Its pause
  grows with what remains: 1.1 to 1.3 s for 3 to 4 GiB, about 0.3 s a GiB.
- **Rehydrating and compressing again leaves no residue.** After dropping the decompressed copy and compacting, the
  process is back at the compressed size.
- **The rule in `ResultStore.MayCompact` will often say no.** It compacts only when what remains is no more than what
  was freed since the last compaction. Compressing a result frees about half of it, while the compressed half and
  every other result remain. So compressing alone rarely earns a compaction under today's rule.

### Reuse without compaction

A second run (`--codecs brotli1 --no-ops`) checked whether the space a non-compacting collection frees is used again.
After that collection, it allocated new 256 KiB pages for as many bytes as compression had saved, as the next results
would:

| | `orders` 8 GiB | `orders` 1 GiB |
| --- | ---: | ---: |
| GC heap committed after the non-compacting collection | 13,159 MiB | 2,334 MiB |
| New pages allocated | 4,050 MiB | 502 MiB |
| GC heap committed after them | 13,159 MiB (no growth) | 2,334 MiB (no growth) |
| Private bytes, before and after | 13,331 → 13,461 MiB | 2,379 → 2,453 MiB |

The new pages fit into the freed space: the GC heap's commit did not grow at all, and the process grew by 3 % of what
was allocated. So **a compressed result's saving is real for the process even without compaction:** the next 4 GiB of
results cost no new memory. Only giving the memory back to the operating system needs the compacting collection.
This is why charging the budget the compressed size at once (below) is honest.

## Recommended design

### What a result is

A complete result set is in one of two states:

- **Raw:** as today.
- **Compressed:** each sealed page's body is replaced by its Brotli 1 bytes, with the raw length beside it. `FirstRow`,
  `Rows` and the lengths sidecar stay as they are, so `results.rowBytes`, `CellSize` and the row index keep working
  without decompressing anything.

A compressed result is never read in place by the operations. It is made raw again (rehydrated) first, except for
plain `results.read` of a few pages, which decompresses those pages into a small per-result cache (six pages).

### When a result is compressed

All of these must hold:

- The result is complete: not open, not being written.
- It is not visible in any window, popouts included, for 30 seconds. Visibility is new information: today the backend
  does not know which results are on screen, so the renderer tells it (a new method, see the PR order). The delay keeps
  someone flicking between tabs from paying to compress and decompress over and over.
- No lease (Copy or Save running), no view, profile, pivot, diff or search running on it, and no pin (below).
- It is large enough to matter: at least 16 MiB. Below that, compression saves less than a single page builder holds.
- It is not a live table (`query.Live`). Live sets are small, use 64 KiB pages kept off the large object heap, and are
  replaced every tick; compressing them would only add work.

Compression runs in the background on the results' workers, through `ViewSorter.Gate` at the lowest priority, page by
page. A visible operation that needs the workers stops it between pages. A result being compressed stays readable:
each page switches when its compressed copy is ready.

### When it is decompressed

- **When it becomes visible.** Rehydrate at once, on the workers. Until that finishes, plain reads are served by
  decompressing the pages they need (about 2 ms), so the grid paints immediately. A read through a sorted or filtered
  view waits for the rehydrate (0.2 s per GiB on 16 workers, about 1 s per GiB on 3).
- **When anything else needs the whole result:** a sort or filter (a view), profile, pivot, diff, search, distinct
  values, Copy or Save, or row identity. Each of these first pins the result (below), which rehydrates it if needed.
  A Copy or Save of a hidden result therefore costs the rehydrate on top of the job. The alternative, decompressing
  ahead on the workers inside the job, saves the memory but complicates `ResultJobs`. Leave it for later.
- **Never page by page inside an operation.** The view read and the one-thread Save above show why.

### How the budget is charged

- **A compressed page is charged its compressed length plus `PageOverhead` plus its sidecar,** as a raw page is
  charged today. Compressing returns the difference to the query and global budgets at once, so new results and
  working memory can use it.
- **Rehydrating must reserve the raw length again first,** as working memory is reserved (`TryReserve`, refused under
  high system memory load as rows are). If it is refused, the result stays compressed. Plain scrolling still works
  through the page cache. Operations that need the whole result answer `TOO_LARGE`, as a sort that does not fit does
  today, saying to close other results. Nothing is ever dropped or written to disk to make room.
- **The page cache (6 pages, about 1.5 MiB a result) is charged as working memory** and freed when the result is
  rehydrated or released.
- **Returning memory to the operating system follows `ResultStore.CollectNow`.** Count the bytes compression frees as
  freed (`freedSinceCollect`/`freedSinceCompact`), so compression triggers the same collections as a release. Do not
  force a compaction for compression alone: the pause (0.3 s a GiB that remains) would land while the user works in
  another tab, and the budget is already returned whether or not the operating system gets the memory back.

### Pins: the one structural change

Today ten call sites take `set.SealedSnapshot()` or `set.PagesFor(...)` and read the `byte[]` bodies directly
(`SqlService` reads, views, profile, pivot, diff, search, distinct values, row identity, `ResultJobs`, plan
deduplication). Compression needs one gate in front of them: `set.Pin()` returns a raw snapshot and holds the result
raw until it is disposed (as a lease holds its pages), rehydrating first if it must. `Release` already waits for
leases; it waits for pins the same way. Every reader moves to `Pin()` in the first PR, which changes no behaviour and
is where review effort belongs.

### Derived results, views and live tables

- **Pivots and diffs** are result sets (`Derived`). They follow the same rules as any result: compressed when hidden
  and large, rehydrated when shown. Their sources are not pinned by them once built.
- **Views** (sort orders, filter masks, `KeyMemory`) are not pages and are not compressed. A view keeps its order
  array. Reading through it pins its result, so a view on a compressed result rehydrates when its tab is shown.
  Releasing a hidden view's key memory is a separate question, left alone here.
- **Live tables** are never compressed (above).

## What it would save

Hidden results take 38 to 53 % of their raw memory in these shapes (1.9 to 2.7×, less if the data is mostly random
numbers or GUIDs, more for repetitive text). In budget terms:

- A 16 GB machine has an automatic budget of 4 GiB (2 GiB a query). With one large result visible and two large ones
  hidden, about 2 GiB of results (`orders`-like) hold about 1 GiB, which is room for another large result or a sort.
- A 64 GB machine (16 GiB, 8 GiB a query) holding an 8 GiB result in a hidden tab gets back about 4 GiB of budget, and
  4 GiB of the process's memory once a compacting collection runs.
- A session whose results are kilobytes or a few megabytes (the common case) gains nothing measurable. The 16 MiB
  floor keeps such results raw, and the feature costs them nothing.

How large real users' results are, and how many tabs keep them, was not measured. These are worked examples, not a
forecast.

## Risks

- **Tab switches cost time.** Showing a hidden 8 GiB result rehydrates it for 1.5 to 1.9 s on 16 workers, about 8 s
  on a 4-core machine. Plain scrolling works at once, but a sorted view waits. The 30 s delay and the 16 MiB floor
  limit how often this happens. It still needs a busy state in the grid's header, as long sorts have.
- **Rehydrating can be refused.** A result that was compressed while the budget filled up may not fit back. The
  design answers `TOO_LARGE` rather than evicting anything. Users will see this as "the result I had is too large to
  sort now", which needs clear wording.
- **Memory comes back slowly or not at all** under today's compaction rule. The budget sees the saving at once; Task
  Manager may not. The status bar's memory (status-bar-memory.md) should show compressed bytes separately, or users
  will think nothing happened.
- **Correctness surface.** Every reader moves behind `Pin()`. A missed call site would read compressed bytes as a page
  and fail, at worst with "Unsupported result page" (`PageView.Parse` checks the header). The offline checks need a
  mode that compresses every complete result at once, so the whole suite runs against compressed results.
- **Ratios depend on the data.** Results of random keys, hashes or GUIDs compress to 1.3 to 1.6× or less. Pages that
  save less than 10 % should stay raw (one comparison per page, already in the loop).
- **CPU in the background.** Compressing 8 GiB takes 2.2 to 2.9 s of 16 workers. On battery or a small machine that
  is noticeable. It runs through the worker gate at the lowest priority and stops for visible work.
- **The numbers come from a loaded machine.** Treat the times as ranges. Ratios and memory figures are solid.

## Proposed PR order

1. **Pins.** `ResultSetBuffer.Pin()` and a pin count beside the lease count. Move every `SealedSnapshot`/`PagesFor`
   reader onto it, and have release wait for pins as for leases. No behaviour change. Offline checks for
   release-while-pinned and lease-and-pin together.
2. **Compressed pages inside the store, behind an internal switch.** A page's body is raw or compressed; `Compress()`
   and `Rehydrate()` on a set, with budget transfer (charge compressed, reserve raw to rehydrate, `TOO_LARGE` when
   refused), the six-page read cache, freed bytes counted for `CollectNow`, and the skip for pages that do not
   compress. An offline mode that compresses every complete result, run as a second pass of the result checks. No
   user-visible change yet.
3. **Visibility.** A `results.visibility` method in all five places (contract, zod, method policy, preload,
   `SqlService` dispatch), sent by the renderer when a result's grid is shown or hidden in any window. The backend only
   records it.
4. **Policy.** Compress complete, unpinned, hidden results of 16 MiB or more after 30 s, through the worker gate at the
   lowest priority. Rehydrate on show and on pin. Busy state in the grid while rehydrating. README and status-bar
   memory docs; CHANGELOG.
5. **Show it.** The status bar's memory and `results.memory` report compressed bytes. Optional: a setting to turn
   compression off (`src/shared/settings/`).

Later: Zstandard after the .NET 11 upgrade (decompression speed, mainly for the rehydrate); decompressing ahead inside
Copy and Save instead of rehydrating; releasing hidden views' key memory.

## Not measured

- Real sessions: how big users' results are and how many hidden tabs hold them.
- Binary columns (`varbinary`, images) and documents (xml, json, plans). The `L1` and `B1` synthetic shapes exist but
  repeat one document, so they would overstate the ratio. They were left out rather than reported.
- Compressing a result while the grid reads it, and the worker gate's priority under contention. Both are design
  claims, not measurements.
- The end-to-end time in the app to show a hidden result (renderer and IPC included). Only the backend's share was
  measured.
- Linux and macOS, and a real 4-core machine (`VARIA_BENCH_CORES` only restricts affinity on this one).
- The compacting collection's pause with other large results in the heap. Each run held one result.
