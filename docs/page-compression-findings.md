# Page compression findings

A measured prototype for compressing stored result pages, measured on 2026-11-12. This is a benchmark and design page.
It changes nothing in the product: pages are still stored as they are sealed, and the product still targets .NET 10.
The rule agreed with the owner still holds: results stay in memory and never spill to disk.

The first version of this page measured only what .NET 10 has (Brotli, Deflate, ZLib) and recommended Brotli. The
owner pointed at zstd and LZ4 and is willing to move to .NET 11 (STS), whose `System.IO.Compression` has Zstandard
built in. This version measures both on .NET 11, and the recommendation changes with them.

## Summary

- **Codec: Zstandard at level 2, built into .NET 11 (`ZstandardEncoder.TryCompress`, window 18), one page at a
  time.** On realistic pages it stores a result in **36 to 52 % of its memory** (ratio 1.9 to 2.8), slightly better
  than Brotli 1. It decompresses a 256 KiB page in about 0.15 ms on one thread, against Brotli's 0.65 ms, and
  compresses one in about 0.7 to 1 ms. A whole 8 GiB result compresses in 1.5 to 2.0 s on the results' 16 workers and
  decompresses in 0.36 s (1.1 to 1.2 s into new arrays).
- **LZ4 is faster still but saves too little.** It decompresses about twice as fast as zstd (3 to 3.8 GB/s a thread),
  but its ratio is 1.1 to 1.5: it saves 12 to 34 % of memory where zstd 2 saves 48 to 64 %. LZ4 HC reaches 1.4 to 2.1
  but compresses at 70 to 80 MB/s. zstd's own fast levels (−1, −5) behave like LZ4. Brotli, Deflate and ZLib are
  matched or beaten on ratio and beaten three to four times on decompression.
- **zstd is fast enough to read compressed pages in place, so results need not be decompressed whole before use:**
  - a plain `results.read` of three pages costs 0.6 ms, or 0.3 ms with a six-page cache (0.05 ms raw);
  - a screen of a sorted view, whose 256 rows come from about 250 pages, costs 4.4 to 4.9 ms when those pages are
    decompressed on the 16 workers (15.5 ms on 3 workers; 43 to 47 ms on one thread);
  - a Save that decompresses each page as it goes, on one thread, adds about 0.7 s per GiB: 1.3 to 1.8 times the raw
    Save for most shapes (Brotli added 3 to 4 s per GiB).
- **Whole-result operations cost what they cost on raw pages once their pages are decompressed.** Sort, filter,
  profile, pivot and Save matched their raw times within noise. Decompressing all of an 8 GiB result first takes 1.1 to
  1.2 s on 16 workers (0.36 s per GiB on 3 workers).
- **This makes compressing much more actively possible,** as the owner suggested: every complete result can be
  compressed a few seconds after it is hidden, showing it again needs no wait, and a later step can keep even visible
  results compressed. See [Recommended design](#recommended-design).
- **Memory:** compressed results return their saving to the budget at once, and the GC reuses the freed space for new
  pages without growing (4.2 to 5.3 GiB of new pages fitted with no growth in the GC heap's commit). Only giving
  memory back to the operating system needs a compacting collection, which paused 1.0 to 1.4 s for the 3 to 4 GiB
  that remained.
- **Prerequisite: move the backend to .NET 11.** zstd is not in .NET 10; a NuGet wrapper would add a native library.

## Environment

| | |
| --- | --- |
| Machine | Intel Core Ultra 9 285K (24 cores: 8 fast, 16 slower), 64 GB, Windows 11 Pro 10.0.26200 |
| Runtimes | .NET 11.0.0 (SDK 11.0.100) for every table unless marked; .NET 10 (SDK 10.0.403) for the first run, kept below. Release builds, workstation concurrent GC (the backend's settings) |
| Revision | `main` at `ce9d1659` plus this branch's benchmark |
| Workers | `ViewSorter.Workers` = 16 on 24 logical processors; runs with `VARIA_BENCH_CORES=4` (3 workers) are marked |
| Budget | One query budget the size of the run (1 or 8 GiB), global four times that; no memory-load check |
| LZ4 | `K4os.Compression.LZ4` 1.3.8 (managed code, no native library), referenced only by the .NET 11 build of the test project |
| Data | Synthetic only (below). No user data, SQL text or values in any output |

Four other sessions were building and benchmarking on the machine for much of the time, often at 100 % processor.
Repeated medians moved by up to 30 %, single runs by more (one raw Save of the wide shape took 6.9 s and then 19 s).
Differences smaller than that mean nothing here. Compression ratios and memory figures do not depend on load; times
do.

## Fixtures and how to run them

`dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --page-compression-bench <GiB> <shape>
[--codecs name,name] [--keep name] [--no-ops]` (`PageCompressionBench.cs`), one size and shape a process so each
memory reading is its own. On .NET 10 it has the Brotli, Deflate and ZLib codecs. The zstd and LZ4 codecs compile only
for .NET 11 (`#if NET11_0_OR_GREATER`, and the LZ4 package is referenced only for `net11.0`). Until the repository moves,
build them from a copy of `backend/` outside the repository, where `global.json` does not pin SDK 10, with the three
projects' `TargetFramework` set to `net11.0`.

It fills a query budget as ingestion does (`ResultSetBuffer.BeginRow`/`TryCommitRow`, real `PageBuilder` pages and
lengths sidecars), then:

1. Each codec over a sample of 384 pages on one thread (speed, median and p99 per page), then over every page on the
   workers (ratio, speed). Every codec but the kept one is collected before the next.
2. Every operation on the raw pages. The first full pass is untimed and warms the JIT; then three timed runs, median
   reported. Without the warm pass the first raw runs were 2 to 10 times slower, because tiered compilation was still
   promoting the code.
3. A `results.read` of three pages, raw and compressed. A scroll trace through an LRU cache of 0, 6 and 24
   decompressed pages. A read of 256 rows through a view sorted by a random `int`, on one thread and on the workers. A
   Save that decompresses each page into one reused buffer just before writing it.
4. Drops the raw pages, keeping only the kept codec's (`--keep`, default `brotli1`), and reads the process's memory
   with no collection, after a non-compacting gen2 collection, after allocating new pages for the bytes saved, and
   after `ResultStore.CollectNow`'s compacting collection (timed).
5. Decompresses every page on the workers into new arrays ("rehydrate"), runs every operation again, then drops them
   and compacts again.

Codec names: `brotli<quality>`, `deflate<level>`, `zlib<level>`, `zstd<level>` (`zstdm1` is level −1), `zstd<level>r`
(one encoder and decoder kept per thread instead of the one-shot calls), `lz4` (fast) and `lz4hc3`, and `w22` for a
4 MiB window instead of one page's 256 KiB. `--codecs` picks which codecs run over all pages (the kept one always does).
`--no-ops` skips steps 2 and 5, and the view read and streamed Save of step 3. `VARIA_BENCH_CORES=n` holds the process
to n cores and the workers to what such a machine would have. It prints one JSON line per metric. It measures only and
checks nothing, and it is not part of `npm run check` or CI. The result-scale benchmark used in earlier hand runs
(`--result-scale-bench`) is not in the repository; this one borrows its way of filling the store.

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

1 GiB of each shape on .NET 11. "1 thread" is MB/s of page bytes over the sample (the range runs across the four
realistic shapes); "all" is every page of 1 GiB on 16 workers. The window is one page (256 KiB) unless marked: a 4 MiB
window gave the same ratio for Brotli and zstd.

| Codec | `orders` ratio | `wide` | `log` | `numeric` | `w1` | Compress, 1 thread | Decompress, 1 thread | Compress 1 GiB, all | Decompress 1 GiB, all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| zstd −5 | 1.27 | 1.50 | 1.24 | 1.06 | 2.66 | 620–1,460 MB/s | 2.6–6.6 GB/s | 0.11–0.16 s | 0.02–0.03 s |
| zstd −1 | 1.40 | 1.66 | 1.42 | 1.15 | 3.61 | 420–940 MB/s | 2.0–3.8 GB/s | 0.11–0.20 s | 0.02–0.04 s |
| zstd 1 | 1.96 | 2.70 | 2.03 | 1.86 | 4.89 | 370–780 MB/s | 1.4–1.8 GB/s | 0.12–0.20 s | 0.04–0.05 s |
| **zstd 2** | **2.09** | **2.80** | **2.23** | **1.93** | **5.37** | **310–380 MB/s** | **1.3–1.9 GB/s** | **0.21–0.25 s** | **0.05 s** |
| zstd 3 | 2.10 | 2.82 | 2.29 | 1.93 | 5.39 | 170–190 MB/s | 1.1–1.7 GB/s | 0.48–0.54 s | 0.05–0.06 s |
| zstd 3, encoder reused | 2.10 | 2.82 | 2.29 | 1.93 | 5.39 | 190–290 MB/s | 1.1–1.6 GB/s | 0.30–0.35 s | 0.05–0.07 s |
| zstd 6 | 2.15 | 2.92 | 2.35 | 2.00 | 5.42 | 67–74 MB/s | 1.3–1.5 GB/s | 1.4–1.8 s | 0.05–0.06 s |
| LZ4 | 1.32 | 1.51 | 1.30 | 1.13 | 2.82 | 450–680 MB/s | 3.0–3.8 GB/s | 0.13–0.16 s | 0.02–0.04 s |
| LZ4 HC 3 | 1.63 | 2.11 | 1.82 | 1.43 | 3.09 | 67–81 MB/s | 3.1–4.2 GB/s | 0.92–1.04 s | 0.02 s |
| Brotli 1 | 1.99 | 2.68 | 2.11 | 1.90 | 4.72 | 230–280 MB/s | 400–430 MB/s | 0.33–0.41 s | 0.16–0.19 s |
| Brotli 2 | 2.19 | 2.77 | 2.26 | 2.01 | 5.66 | 120–130 MB/s | 360–420 MB/s | 0.60–0.88 s | 0.18–0.30 s |
| Deflate 1 | 1.51 | 1.70 | 1.53 | 1.33 | 3.08 | 180–210 MB/s | 380–410 MB/s | 0.40–0.43 s | 0.17–0.19 s |
| Deflate 6 | 2.13 | 2.55 | 2.21 | 1.96 | 4.36 | 65–84 MB/s | 400–450 MB/s | 0.96–1.13 s | 0.16–0.18 s |

Per page, zstd 2 decompresses in a median 136 to 198 µs (p99 0.2 to 0.9 ms) and compresses in 0.7 to 1.0 ms; zstd 1
in 134 to 179 µs and 0.3 to 0.75 ms; Brotli 1 in 600 to 630 µs and 0.9 to 1.2 ms. At 8 GiB the ratios were the same to
two decimals (zstd 2: `orders` 2.10, `wide` 2.80, `log` 2.24), and so were the speeds per page.

Why zstd 2:

- **Decompression is what every read pays,** and zstd's is about four times Brotli's at the same or better ratio. Its
  fast negative levels and LZ4 decompress faster again, but by then decompression is no longer the cost that matters
  (0.15 ms a page against a 0.05 ms raw read of three pages), while the memory they save drops by half.
- **Level 2 over level 1:** 3 to 10 % better ratio (2.09 against 1.96 for `orders`, 2.23 against 2.03 for `log`) at
  the same decompression speed. Compression runs in the background, and level 2 is still faster than Brotli 1.
- **Level 3 and above** add under 3 % for half the compression speed or less. Reusing one encoder per thread made
  level 3 faster (context set-up is not free there) but changed little at levels −1 and 1. Level 2 was not measured
  with a reused encoder.
- **The choice is per page and can change later without a format change,** because the decoder reads any level. A
  page whose compressed size saves less than 10 % should simply stay raw.

### On .NET 10 (the first run)

The same codecs on .NET 10 had the same ratios, and their speeds were within this machine's noise of the .NET 11
figures above (Brotli 1 decompressed at 330 to 410 MB/s, Deflate 1 at 280 to 490 MB/s). Zstandard is not in the .NET 10
runtime; `ZstandardEncoder`, `ZstandardDecoder` and `ZstandardStream` are new in .NET 11's `System.IO.Compression`, and
.NET 11.0.0 ships them as released API.

## Cost to the operations that read pages

### Whole-result operations at 8 GiB

zstd 2 on .NET 11. Median of three runs, seconds. "Decompressed" is the same operation on pages decompressed into new
arrays; "decompress first" is the time to do that on 16 workers.

| Operation | `orders` raw | decompressed | `wide` raw | decompressed | `log` raw | decompressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Decompress first (all pages, 16 workers) | | 1.17 | | 1.09 | | 1.13 |
| Sort by a random `int` | 4.60 | 4.76 | 1.75 | 0.82 | 0.84 | 0.71 |
| Sort by a text | 12.5 | 12.4 | 2.24 | 1.05 | 1.31 | 1.02 |
| Filter: IN on a low-cardinality column | 0.43 | 0.44 | 0.38 | 0.22 | 0.16 | 0.15 |
| Profile of two columns | 0.96 | 0.87 | 0.19 | 0.16 | 3.05 | 2.93 |
| Pivot: count, sum, max by status | 2.35 | 2.43 | 0.59 | 0.54 | 0.66 | 0.67 |
| Save as CSV (one thread) | 6.27 | 6.56 | 10.9 | 9.76 | 1.55 | 1.56 |
| Save, decompressing each page just before it is written (one thread) | | 11.5 | | 13.7 | | 6.67 |
| The same Save with Brotli 1 (.NET 10 run) | | 28.7 | | 26.9 | | 21.5 |

(The `wide` raw sorts ran while another session was busy; the decompressed runs are the better guide there.)

- **Decompressed pages cost nothing more to read.** Every operation reads `byte[]` bodies through `PageView`.
- **Decompressing as it goes is now affordable.** One thread decompresses about 1.5 GB/s, so a one-thread streamed
  Save adds about 0.7 s per GiB: 1.3 to 1.8 times the raw Save for `orders`, `wide` and `numeric`, and 4 times for
  `log`, whose raw Save is unusually fast (5 GB/s of long text). Brotli added 3 to 4 s per GiB (4 to 12 times).
  Decompressing ahead on a second thread would hide most of it. The operations that already run on the
  workers (key builds, profile, search) would pay about 0.05 s per GiB if each worker decompressed its own pages
  (the "decompress 1 GiB, all" column). That fused path was not measured as such.
- **On a small machine:** with 3 workers (`VARIA_BENCH_CORES=4`), decompressing all of 1 GiB of `orders` took 0.36 s
  (0.15 s on 16), so about 3 s for 8 GiB (extrapolated).

### Scrolling

| Read (zstd 2) | Time |
| --- | ---: |
| `results.read` of three raw pages (copying the bytes once) | 50–53 µs |
| Three compressed pages, decompressed into new arrays | 0.61–0.66 ms (p99 1.1–1.3 ms) |
| Scroll trace (forward 300 pages, back 100, 50 jumps), no cache | 0.68–0.75 ms a read |
| The same with an LRU of 6 decompressed pages (1.5 MiB) | 0.28–0.30 ms a read |
| The same with 24 pages (6 MiB) | 0.28–0.30 ms a read |
| 256 rows of a view sorted by a random `int` (≈250 source pages), one thread | 43–47 ms (Brotli 1: 158–167 ms) |
| The same pages on 16 workers | **4.4–4.9 ms** (p99 6–7 ms) |
| The same pages on 3 workers | 15.5 ms (p99 22 ms) |
| `log` (fewer rows a page: ≈58 pages), one thread / 16 workers | 10 ms / 1.4 ms |

Plain scrolling of a compressed result costs well under a millisecond. A sorted view costs a few milliseconds a
screen when its pages are decompressed on the workers, which is inside a frame on this machine and about one frame on
a 4-core one. So a result does not have to be decompressed whole before it is shown.

## Memory returned to the operating system

The process's private bytes (its commit) as the run went, MiB, keeping zstd 2. "Raw" is after the fill and a
compacting collection. "Dropped" is with the raw pages unreachable and the compressed copies held, before any
collection.

| Stage | `orders` 8 GiB | `wide` 8 GiB | `log` 8 GiB | `orders` 1 GiB |
| --- | ---: | ---: | ---: | ---: |
| Raw | 8,305 | 8,305 | 8,305 | 1,055 |
| Dropped, no collection | 16,905 | 13,234 | 15,038 | 3,747 |
| After a non-compacting gen2 collection | 16,776 | 12,956 | 14,875 | 3,660 |
| After allocating new pages for the bytes saved | 16,901 (4,223 MiB allocated) | 13,034 (5,251) | 15,027 (4,512) | 3,755 (524) |
| After a compacting collection | **4,174** | **3,037** | **3,803** | **542** |
| Pause of the compacting collection | 1.37 s | 1.05 s | 1.17 s | 0.25 s |
| After decompressing everything again, dropping it and compacting | 4,174 | 3,037 | 3,807 | 543 |

("Dropped" includes garbage from the codecs that ran before the kept one, which is why it is above raw plus
compressed.)

- **A non-compacting collection gives almost nothing back to the operating system** (0.1 to 0.3 GiB), but the space
  it frees is reused: new pages for every byte compression saved fitted without the GC heap's commit growing at all,
  and the process grew by 1 to 3 % of what was allocated. So **a compressed result's saving is real for the process
  even without compaction,** and charging the budget the compressed size at once is honest.
- **A compacting collection gives everything back,** down to the compressed bytes plus about 100 MiB. Its pause grows
  with what remains: 1.0 to 1.4 s for 3 to 4 GiB, about 0.3 s a GiB on this busy machine (`ResultStore` notes 0.1 to
  0.2 s).
- **Decompressing and compressing again leaves no residue.**
- **`ResultStore.MayCompact` will often say no** to compacting after compression alone (what remains is usually more
  than what was freed). That is fine given the reuse above.

The first run (Brotli 1, .NET 10) gave the same picture: 8.3 GiB raw to 3.2 to 4.4 GiB after compaction, 1.1 to 1.3 s
pauses, and 4 GiB of new pages after a non-compacting collection with no growth in the GC heap's commit.

## Recommended design

### What a result is

A complete result set is raw (as today) or compressed: each sealed page's body is replaced by its zstd bytes, with the
raw length beside it. `FirstRow`, `Rows` and the lengths sidecar stay as they are, so `results.rowBytes`, `CellSize`
and the row index work without decompressing anything. The page being built, and pages of an open result, are always
raw.

### Reading a compressed result

Every reader gets page bodies through one accessor instead of `StoredPage.Body`. The accessor decompresses into a
per-result cache of decompressed pages, charged to the budget as working memory:

- **`results.read` of a plain grid:** the pages it needs, through a cache of six pages (0.3 ms a read).
- **`results.read` through a view:** the distinct pages behind the rows asked for, decompressed in parallel on the
  workers (about 5 ms a screen on 16 workers, 15 ms on 3), through the same cache.
- **Whole-result operations** (view and key builds, filters, distinct values, profile, pivot, diff, search, row
  identity, Copy and Save): at first, **rehydrate** the result (decompress every page on the workers into raw pages,
  after reserving their raw size from the budget; 0.15 s per GiB on 16 workers, 0.36 s on 3), run, and let it be
  compressed again later. Later, each worker decompresses its own pages as it reads them, so no raw copy is needed
  and no raw budget either. That needs every reader to read page by page through the accessor (most already do: key
  builds, profile and search run per page on the workers), and the readers that revisit cells at random (ties in a
  sort that re-read cells, pivot output, diff) to go through the cache.

### When a result is compressed

Stage 1 (hidden results):

- The result is complete, not leased (Copy or Save) and not pinned by a running operation.
- It is not visible in any window, popouts included, for 5 seconds. Visibility is new information for the backend;
  the renderer sends it (a new method, see the PR order). With zstd, flicking back to a tab costs a fraction of a
  millisecond per screen, so the delay only avoids compressing results the user is still moving between.
- It is at least 1 MiB (four pages). Below that there is little to save.
- It is not a live table (`query.Live`). Live sets are small, use 64 KiB pages kept off the large object heap, and are
  replaced every tick.

Stage 2 (once whole-result operations read compressed pages in place): compress **every** complete result after it
has been idle for a few seconds, visible or not. Then the store holds raw only the pages being built, the decompressed
cache, and results an operation is reading. That is the most active option and roughly doubles what the budget holds.
It is a separate step because it depends on the fused reads, and because the grid's visible result would then pay
0.3 ms a scroll read that today costs 0.05 ms. That is invisible in a frame, but it should be measured in the app
before it becomes the default.

Compression runs in the background on the results' workers, through `ViewSorter.Gate` at the lowest priority, page by
page, at about 0.2 s of 16 workers per GiB. A visible operation that needs the workers stops it between pages. A
result being compressed stays readable: each page switches when its compressed copy is ready.

### How the budget is charged

- **A compressed page is charged its compressed length plus `PageOverhead` plus its sidecar,** as a raw page is
  charged today. Compressing returns the difference to the query and global budgets at once.
- **The decompressed-page cache is working memory** (six pages, about 1.5 MiB a result, plus a view screen's pages
  while it is read), freed when the result is released.
- **Rehydrating reserves the raw size first** (`TryReserve`, refused under high system memory load as rows are). If it
  is refused in stage 1, plain and view reads still work through the cache, and the operation answers `TOO_LARGE`, as
  a sort that does not fit does today. In stage 2 this case goes away. Nothing is ever dropped or written to disk.
- **Returning memory to the operating system follows `ResultStore.CollectNow`.** Count the bytes compression frees as
  freed, so compression triggers the same collections as a release, and do not force a compaction for compression
  alone: the space is reused anyway, and a forced compaction would pause the backend for 0.3 s a GiB that remains.

### Derived results, views and live tables

- **Pivots and diffs** are result sets (`Derived`) and follow the same rules as any result.
- **Views** (sort orders, filter masks, `KeyMemory`) are not pages and are not compressed. Releasing a hidden view's
  key memory is a separate question, left alone here.
- **Live tables** are never compressed.

## What it would save

Compressed results take 36 to 52 % of their raw memory in these shapes (1.9 to 2.8 times smaller; less if the data
is mostly random numbers or GUIDs, more for repetitive text). In budget terms:

- A 16 GB machine has an automatic budget of 4 GiB (2 GiB a query). Stage 1: two hidden 1 GiB results (`orders`-like)
  hold about 1 GiB instead of 2 GiB. Stage 2: the same 4 GiB holds about 8 to 11 GiB of such results.
- A 64 GB machine (16 GiB, 8 GiB a query) with an 8 GiB result in a hidden tab gets back about 4.1 GiB of budget, and
  that much of the process's memory once a compacting collection runs.
- A session whose results are kilobytes or a few megabytes (the common case) gains little. The 1 MiB floor keeps
  the smallest raw, and the feature costs them nothing.

How large real users' results are, and how many tabs keep them, was not measured. These are worked examples, not a
forecast.

## Risks

- **The .NET 11 move comes first.** STS support is shorter than .NET 10's LTS, and the upgrade touches the whole
  backend and its packages (SqlClient, SMO, ScriptDom). It is its own PR with the full live suites.
- **Correctness surface.** Every reader moves behind the accessor. A missed call site would read compressed bytes as a
  page and fail with "Unsupported result page" (`PageView.Parse` checks the header). The offline checks need a mode
  that compresses every complete result at once, so the whole suite runs against compressed results.
- **Readers that revisit cells at random.** A sort whose keys tie re-reads cells; with compressed pages each re-read
  may decompress a page. Through the cache this is bounded, but it is the case to measure in stage 2 (a text column
  with many equal 8-byte prefixes, or a long `decimal`).
- **Rehydrating can be refused in stage 1** when the budget filled while the result was compressed. The user sees
  "too large to sort now"; the wording needs care.
- **Memory comes back slowly** to the operating system. The budget sees the saving at once; Task Manager may not until
  a release triggers a compaction. The status bar's memory (status-bar-memory.md) should show compressed bytes
  separately.
- **CPU in the background.** Compressing 8 GiB takes 1.5 to 2.0 s of 16 workers (about 6 to 8 s on 3 workers,
  extrapolated). It runs through the worker gate at the lowest priority and stops for visible work.
- **Ratios depend on the data.** Results of random keys, hashes or GUIDs compress to 1.1 to 1.5 times or not at all.
  Pages that save less than 10 % stay raw.
- **The numbers come from a loaded machine.** Treat the times as ranges. Ratios and memory figures are solid.

## Proposed PR order

1. **Move the backend to .NET 11.** Target framework, `global.json`, CI images and the packaging workflow; the full
   live suites. No feature change.
2. **One page accessor and pins.** Every `SealedSnapshot`/`PagesFor` reader gets bodies through one accessor and pins
   the result while it reads (a pin count beside the lease count; release waits for pins as for leases). No behaviour
   change.
3. **Compressed pages inside the store, behind an internal switch.** zstd 2 per page, the skip for pages that save
   under 10 %, the decompressed-page cache, parallel decompression for view reads, rehydrate with its reservation,
   budget transfer, and freed bytes counted for `CollectNow`. An offline mode that compresses every complete result,
   run as a second pass of the result checks.
4. **Visibility.** A `results.visibility` method in all five places (contract, zod, method policy, preload,
   `SqlService` dispatch), sent by the renderer when a result's grid is shown or hidden in any window.
5. **Stage 1 policy.** Compress complete, unpinned, hidden results of 1 MiB or more after 5 s, through the worker
   gate. The status bar and `results.memory` report compressed bytes. README, status-bar memory docs, CHANGELOG.
6. **Fused reads.** Whole-result operations decompress page by page on their workers instead of rehydrating; measure
   sort ties and Save with decompression ahead.
7. **Stage 2 policy.** Compress idle visible results too, after measuring scrolling and sorting in the app.

## Not measured

- Real sessions: how big users' results are and how many tabs hold them.
- Binary columns (`varbinary`, images) and documents (xml, json, plans). The `L1` and `B1` synthetic shapes exist but
  repeat one document, so they would overstate the ratio. They were left out rather than reported.
- The fused path (each worker decompressing its own pages inside an operation), and sort ties re-reading compressed
  cells. The cost is estimated from the parallel decompression figures, not measured.
- zstd 2 with a reused encoder per thread, and zstd dictionaries (.NET 11 can train one per result, which might help
  pages of one result share their repeated text).
- Compressing a result while the grid reads it, and the worker gate's priority under contention.
- The end-to-end time in the app (renderer and IPC included). Only the backend's share was measured.
- Linux and macOS, and a real 4-core machine (`VARIA_BENCH_CORES` only restricts affinity on this one).
- The compacting collection's pause with other large results in the heap. Each run held one result.
