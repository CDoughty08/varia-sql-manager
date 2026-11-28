# Search index tiering plan

Status: **proposed on 2026-11-27 and revised the same day after the owner's review. Not yet agreed.** Every lane ships in
0.10.0, so the release is one whole change and nothing is left for 0.11.0. The open questions are in [Decisions for the
owner](#decisions-for-the-owner), each with a recommendation. Once they are agreed, this page is the plan of record for
the lanes below. Each lane's PR updates [object-search.md](object-search.md) and moves its row here to Done. When the
last lane ships, anything still relevant moves into object-search.md and this page is deleted.

## Why

The saved index ([object-search.md › Saved index](object-search.md#saved-index)) is a copy of what memory held. Memory
decides what gets read in the first place, so for one large source the disk never holds more than the memory limit
lets in:

- **What memory leaves out, the file leaves out.** A definition left out for memory is saved as left out. A BigQuery
  dataset read by name only is saved by name only.
- **Reload is capped the same way.** A saved BigQuery dataset that does not fit in memory at reload is read again as if
  nothing were saved. After the first discovered dataset that does not fit, no other discovered dataset is loaded.
- **Compression is not the difference.** Long definitions are zstd frames in memory as well (`PackedText`), and the file
  stores those same frames. The bench target is a file at 0.35 of memory, and most of that saving comes from records
  and names.
- **Nothing in memory is ever evicted.** Lowering **Index memory limit** drops nothing, and the Memory panel can show
  more than 100%.

This fails for the owner's production BigQuery project, which has thousands of datasets and hundreds of thousands of
objects. Whatever does not fit in 512 MiB is listed again on every start, and its details are never read.

## Goal

The disk holds the complete index, and memory holds the part in use:

- **Every read is saved whole,** whatever the memory limit, up to **Saved index disk limit**.
- **Index memory limit stays a hard ceiling** on what the index holds in memory, reads in progress included. Within it,
  memory works as a cache.
- **Object names stay in memory, up to the names cap,** so object search stays instant. Children, details and definitions load per unit (a
  database or a dataset) when needed, and the least recently used are dropped.
- **Without a key store, or with saving off, nothing changes.** Memory is the whole index, and today's budget rules
  apply, BigQuery's floors included.
- **Security does not change:** the same key, encryption, file names and sweep. Nothing is written in clear unless the
  existing unencrypted setting is on.

## Today's design, in short

The detail is in object-search.md. These are the facts the lanes depend on.

- **Units.** A unit is a SQL Server database, a server's own objects, Agent, a BigQuery dataset, or the shared resource
  set. Each is a `DatabaseIndex`: 24-byte entries, a texts array, optional `ObjectDetails`, BigQuery facts, lookup
  arrays built when first used, and for SQL Server the catalog listing in `Extra` (up to 32 MiB, not charged to the
  budget).
- **Children are entries.** Columns, indexes, statistics, parameters and BigQuery columns (`DetailChild`) are entries
  in the same table as their parents, and they are searched by name. Files already treat them as a separate detail
  section. Keys, constraints and DML triggers are child entries too, but `CHILDREN_LEFT_OUT` keeps them.
- **Shared texts.** Every name and definition is held once in the global `StringPool`, reference counted and charged
  once across all units and connections. One `Pooled` array per read holds that read's references. A resource set's
  records, names and details are charged with `Force`.
- **Budget.** `IndexBudget` charges against the limit, with a names reserve of a quarter of it (`ObjectIndexLimits`). BigQuery adds floors: 3/8 for names, 7/16
  for billing and starred projects' details, and 1/2 for discovered projects' details. A read that does not fit loses
  its definitions first, then its children (`CHILDREN_LEFT_OUT`), and then the whole unit (`TOO_LARGE`).
- **Searches.** Name and definition search scan every unit of the connection linearly, with a 5 s budget, and return a
  ranked, capped result. SQL Server completion is SQL Tools' (`IndexLookup` has no production caller yet). BigQuery
  completion and hover are `language.lookup`, with a 10 s deadline, over the projects, datasets and objects a path
  names. It runs on the backend's `Metadata` lane (`SqlService.LaneOf`), although it makes no network call. That lane's
  8 slots are global and shared with SQL Server completion, hover and definition, `connections.connect`,
  `connections.databases` and `bigquery.properties`. Object Explorer is on the `Explorer` lane, which has no slots. In
  the renderer, `IndexCompletionService` has one in-flight cap of 4 for completion, hover and Go To Definition
  together.
  Its answers carry a `State` (ready, partial, building, skipped, absent). `src/shared/completion/lookup-cache.ts`
  keeps an answer for 15 s when the index is ready and the answer is neither `building` nor cut short below its limit,
  so `partial`, `skipped` and `absent` answers are kept. It reuses an answer for longer prefixes unless it was
  truncated.
- **Freshness.** These read held data:
  - the checks and due marks iterate the held units and their sync;
  - BigQuery's in-place refresh (`Apply`, used by Properties, Peek, the details pane and the 4 h re-read) compares a
    held dataset's columns and definitions. It runs synchronously inside `bigquery.properties` (`TableRead`,
    `RoutineRead`), rebuilds the whole dataset from what is held (`EntriesOf`), and puts it, which queues a save of the
    whole file;
  - a BigQuery DDL mark deletes the dataset's file at once (`Sink.Stale`), for every connection of the principal. A
    SQL Server mark leaves the file alone, and a BigQuery whole-project mark (DDL whose targets are unknown) marks
    every dataset of the project.
- **Files.**
  - **Layout:** one file per unit, readable only whole and in order: a 52-byte clear prefix holding a random per-file
    salt, a sealed header, then AES-256-GCM chunks of 256 KiB with zstd per 1 MiB block. Only the header can be read
    alone.
  - **Writes:** whole-file through a temp file and rename, one at a time on one BelowNormal thread, each flushed to
    the device (`Flush(flushToDisk: true)`). Putting a read into the index (`Sink.Held`) queues its save, so a BigQuery
    dataset is written twice, once after pass 1 and once after pass 2. Saving never waits on anything else.
  - **Chunks:** every chunk but a stream's last must be exactly 256 KiB, and the last-chunk flag marks the end.
  - **Loads:** a load already marks its file used.
  - **Sweep:** works from the files' metadata and modified times only.
  - **Limits:** 4 GiB per file and 2^25 objects per unit.
- **Sharing.** All connections of one principal share the same files, and several Varia processes may share the folder.

## Design

### Tiers

| Tier | Holds | In memory |
| --- | --- | --- |
| Names | Every entry except the detail children: tables, views, routines, types, and the keys, constraints and DML triggers that `CHILDREN_LEFT_OUT` keeps today; their names and schemas, and the lean part of BigQuery's object facts that listings, completion and freshness use (split under File format v3) | For every unit of a connected source, up to the names cap |
| Children | The detail children (`IndexFileUnit.DetailChild`: columns, indexes, statistics, parameters, BigQuery columns), the same set `CHILDREN_LEFT_OUT` leaves out today, `ObjectDetails`, BigQuery's table and column descriptions, the children's lookup arrays | Loaded per unit when used; least recently used dropped |
| Listing | SQL Server's catalog listing (`Extra`, `SqlListing`, up to 32 MiB per database) | Cold once written. Only a selective re-read uses it, after a fingerprint mismatch, so it loads then and goes again |
| Definitions | Module, view and routine text, computed column and constraint expressions, and an ownership map: for each definition, the entries that use it, and for an owner that is a detail child, that child's name, kind and parent entry | Kept while there is room; otherwise cold on disk and searched there |

- **Children, Definitions and Listing are siblings.** Each depends only on Names, never on another, so each can be hot
  or cold, loaded or evicted while the others stay as they are. A cold definitions scan builds a computed column's hit
  from the ownership map and the hot names, without opening the children section.
- **Names stays lean.** Nothing in Names is used only after a load:
  - SQL Server's listing is its own tier, so a 32 MiB listing never counts against the names cap. The 15-minute
    check compares only the fingerprint digest in the stub. A selective re-read loads the listing, as it loads the
    unit's other cold parts.
  - **The listing doesn't count toward "fully hot".** Every saved SQL Server unit has a cold listing, so a unit whose
    names, children and definitions are all hot counts as fully hot for Clear, re-announcing and the cold-part tests.
    Before such a unit is announced again, its listing is loaded if its file still exists. A listing that is lost
    (file gone, load failed) is dropped, the unit is saved without one, and its next fingerprint mismatch reads it
    whole instead of selectively. That is today's rule for a unit without `Extra`.
  - BigQuery keeps in Names what listings, object-list completion and the freshness checks read, and moves only the
    table's description (up to 1,024 characters) to Children. Object lists show rows, bytes, partitioning and
    clustering for every object (`EditorLookup.cs:172–178`, `:219–223`), but the description only with details. The
    split itself is stated once, under File format v3.
  - Names also keeps a per-object details digest: 8 bytes covering what `SameDetails` compares (columns,
    partitioning, clustering, signature, columns cut, definition). The background re-read and `Apply` can then tell
    whether fetched details changed without loading the dataset's cold parts.
  - T-1's measurement of bytes per object (D1) is taken with this split.
- **Tiers are immutable and leased.** Today `ObjectTable` is immutable and read without locks by search,
  `BigQueryLookup` and store writes. Each tier keeps that:
  - Each tier is its own immutable object, owning its arrays, its `Pooled` references and its charge. A
    `DatabaseIndex` points at its current tiers.
  - A reader (a search, a lookup, a write) takes a lease on the tiers it reads.
  - Eviction only detaches a tier from its `DatabaseIndex`. Its texts go back to `StringPool`, and its charge to the
    budget, when the last lease on it ends, never while a reader is still using them.
  - A search drops its leases on Children and Definitions when its hot phase answers. A live `explorer.search.more`
    keeps only Names and stubs for resolving cold hits, so a 30 s disk scan never pins hot parts.
- **Each stub says what the unit holds.** It carries a 64-bit mask of the kinds in the unit, and whether it has
  definitions and detail children, in about 16 bytes. A cold definitions scan or a kind-filtered scan skips a unit whose
  stub rules it out, with no disk read. Most BigQuery datasets hold only tables, so most dataset files are skipped.
- **Lookups are split by tier.** `DatabaseIndex.Lookup`'s arrays split in two:
  - the name index of top-level objects lives in Names, so `BigQueryLookup.Object` finds a table or routine without
    its children;
  - the children and foreign-key index lives in Children, and is dropped when Children is evicted and rebuilt when it
    attaches.
- **Stubs count as datasets.** `BigQueryLookup.Datasets` and `ProjectState` list the stubs of units past the names cap
  as well as held reads, so dataset-name completion still lists every dataset.

- **Every unit keeps a stub.** Every unit, hot or cold, keeps a stub in memory: its key, sync, read time, freshness
  marks and listing digest, a few hundred bytes. The stubs are charged inside the limit but outside the names cap. The
  15-minute and 1-hour checks, due marks and counts work on stubs and names, so they never load cold parts. A check that
  finds a cold-whole unit changed loads that unit's names, then re-reads it as today.
- **Work that needs a cold part loads it first, inside the build allowance, one unit at a time:**
  - a merge: a selective re-read (SQL Server) or a changed listing (BigQuery) loads the unit's cold children and
    definitions;
  - BigQuery's in-place refresh (`Apply`) leaves the `bigquery.properties` response. `TableRead` and `RoutineRead`
    only queue the fresh details, and `bigquery.properties` answers at once. A background job then loads the dataset's
    cold children and definitions, inside the build allowance, and only then runs `EntriesOf` and the rebuild.
    - **The queue is bounded:** details are coalesced per dataset and object, so a newer one replaces the older, and
      there are at most 1,000 objects per connection. Past that, the oldest dataset's queued details are dropped and
      the dataset gets a due mark for the background re-read.
    - **During a build** the job waits in the queue instead of being refused, as `Apply` is refused today while
      `state.Building`. It runs once the build ends, and is dropped only if that build re-read the dataset's details
      itself.
    - **Equal listings need the same predecessor.** `Apply` keeps its predecessor's listing, and an equal listing is
      accepted. So when two connections or processes run `Apply` on different tables of one loaded file, both saves
      carry the same listing. So:
      - An `Apply` save names the expected salt: that of the file in place it was built on. The store replaces only
        that file (compare and swap on the writer thread).
      - A save that replaces one still queued inherits the queued one's expected salt, since that is still the file
        in place. A chain of `Apply`s built on each other while queued therefore swaps once, over the right file.
      - An `Apply` job's details stay queued until its write is verified, not until its rebuild runs.
      - On a mismatch, or when a part load finds a different salt with an equal listing, the index adopts the file in
        place (the other side's `Apply`) and applies the details still pending to it again. An equal listing with a
        different salt is handled this way everywhere, so it never falls between the newer and older cases.
  - **The 4 h background re-read** (`SweepDatasetAsync`) chooses what to get from the hot names and facts only
    (`Facts.Detailed`), not from `EntriesOf`. Today it calls `EntriesOf` before its pass, which runs about 33 minutes
    for 1,000 objects at 2 s a call, so it would hold cold parts for that long. It compares each fetched object's
    details digest with the one in Names. Only at the end of the pass, and only if a digest differs, does it load the
    dataset's cold parts and apply the changes as `Apply` does. `Apply` uses the same digest to drop details that
    changed nothing before loading anything.
  - **`language.hydrate`** (`MergeHydratedEntry`) is the third rebuild from held data, beside merges and `Apply`. It
    calls `BigQueryEntries.Known(old)`, rebuilds the dataset through `BigQueryReader.Read`, and puts it with
    `SaveWhenHeld = false`. Under this plan:
    - it follows the same rule as `Apply`: it loads the dataset's cold children and definitions first, or, when the
      hover is waiting, queues as an `Apply` job does and answers `loading`;
    - a dataset past the names cap (stub only) loads its names first. The hydrated object is then merged into the
      real dataset, never into a one-object unit added to `HydratedOnlyDatasets`, which would make `EditorLookup`
      answer `absent` for every other object of that dataset;
    - its result is not saved today, so until a save it is held as parts with no file, which can't be evicted, and is
      counted under the admission rule. T-3b checks whether a hydrated dataset, now rebuilt from every part, can be
      saved like `Apply`'s result, so it becomes evictable again;
    - it is in "No rebuild from a partial unit" and its check, below.
  - **No rebuild from a partial unit.** `EntriesOf`, a merge, `Apply` and `language.hydrate` check that every part the unit is meant to
    have is hot: one that is cold, or marked not saved (a failed load, a refused salt, a swap that did not fit), counts
    as missing. A check fails if any rebuild runs with a part missing, since it would save a file without its
    definitions or children over the complete one, and that save, with its new listing, would win.
  - **When the parts can't all be made hot**, the merge is not retried as a merge:
    - A unit with a part marked not saved is read whole from the server before anything of it is saved, as the tie
      path does. SQL Server has no read of one part.
    - A unit whose cold parts don't fit beside its hot ones, even read alone (below), is read whole under the
      read-alone and left-out rules. Its sync then advances, so the next check doesn't find the same mismatch and
      repeat the work.
    - The unit records how much room it needed. It is not tried as a merge again until the free room has grown past
      that.
- **DDL marks and cold parts.**
  - A BigQuery mark of one dataset drops that dataset's cold parts with its file, as not saved, and K3's retry makes
    sure the next check reads it whole.
  - A whole-project mark changes from today. Today it does three things:
    - `MarkProjectStale` deletes every held dataset's file;
    - it sets `StaleProjects`, which makes the next build read every dataset of the project whole, refuses saves
      (`SaveWhenHeld`) and in-place refresh (`Apply`), filters what is announced to the store, and keeps saved datasets
      from loading at reload;
    - the store-level mark (`MarkSavedStale` with no dataset) deletes every file of the project for the whole principal
      (`DropProjectWork`), withdraws queued saves, and records a project-wide stale key, so saves of earlier reads are
      refused and every connection reads the project's datasets whole.

    Under this plan all three change, in T-3b, with a check for each call site. The call sites include the due-mark
    skip for projects marked whole (`Freshness.cs:135`, which overlaps K3) and `IsScopeCoveredLocked`. T-3b also
    updates the two documented guarantees that a read begun before the DDL is never saved (object-search.md's Saved
    index, and architecture.md). They still hold for a mark of one dataset. A whole-project mark relies instead on the
    newer-listing rule and on per-dataset re-list marks (File format v3, Whole-project marks):
    - the mark keeps the files and cold parts, with no `DropProjectWork` and no project key refusing saves;
    - `StaleProjects` becomes a mark that means "list this project's datasets again" and refuses nothing: no whole
      reads, no refused saves, refreshes or loads. K1 counts it as one project, not as its datasets;
    - the connection that ran the script lists the project's datasets again at its next search or run, as a stale mark
      is checked today. Other connections do it at their next check. The listings go through the rate limiter at its
      normal pace (minutes for thousands of datasets), and a dataset whose listing changed is re-read as a changed listing is today;
    - one script whose targets are unknown therefore does not throw away a project's thousands of datasets.

    T-3b checks that the listing catches every change Varia's own DDL can make, which includes `CREATE OR REPLACE` (a
    new creation time) and `ALTER` of routines and models (a moved last change). Any DDL the listing cannot see, such as
    an in-place `ALTER TABLE`, still marks its own dataset when its target is known. A whole-project mark leaves in-place changes to the background re-read's normal pace, as the owner accepted for
    in-place changes made outside Varia. It queues nothing extra.
  - A SQL Server mark keeps the cold parts and the file. The next check's fingerprint decides, and a selective re-read
    loads what it merges.
- **Names cap.** The names tier is capped at half the limit (decision D1). The cap is global across connections and
  ordered by recency. Within a newly connected source:
  - SQL Server: the database each query tab uses first, then by recency;
  - BigQuery: the billing project, then starred projects, then the rest.

  A unit past the cap stays cold whole, keeping only its stub. Lowering the limit makes the least recent units cold
  first. The index line says how many units are searched on disk.
- **Child-name search.** A search that matches child names (a column named `CustomerId`) answers from hot units at once,
  then scans cold units' children sections, on the same path as cold definitions.
- **No key store, or saving off.** A part with no file is never dropped. This covers no key store, saving off, and a
  write still queued. When such a part does not fit, today's rules leave it out.

### What the limit covers

Everything the index holds in memory is charged to the one budget:

- names, children, definitions;
- SQL Server's listing (`Extra`), now charged while it is hot;
- resource sets: still forced, since every connection needs them, and they are a few MiB;
- builds in progress and finished units waiting for their write;
- tiers a lease still holds after eviction: their budget is given back when the last lease ends;
- the cold scan's scratch buffers.

**One admission rule.** Anything new is admitted only if what is held stays within the limit, with the forced resource
sets already counted. What is held means:

- stubs, names, and hot children and definitions;
- builds in flight, and `pendingPass2` datasets' non-name charge;
- queued, unwritten units;
- leased tiers already evicted, and scratch.

When something does not fit, eviction frees what it can. If that is not enough (leased tiers, parts with no file,
texts other units share), a build waits for queued writes to drain, and then falls back to today's left-out rules. The
queue is bounded with the builds: in flight plus queued stay within one allowance. Two kinds of unit sit outside that
bound because they are already charged, and are counted once, as held:
- every fully hot unit announced to the store again, for whatever reason (after Clear or a new key, or because its
  file was found gone). These are written first. With saving off nothing is written, so nothing is announced.
- units refused for disk space, held without a file until space frees.

**Charges per tier.** Today a unit's charge is one figure (`DatabaseIndex.Bytes`) that never changes. With tiers, each
unit records what each of its tiers has charged, and eviction gives back only the evicted tier's charge.

**Rebuild credit.** A rebuild may still reuse its predecessor's charge as credit. That credit is only what the
predecessor holds hot and charged, never a tier already evicted. The predecessor is pinned (not evicted) while the build
runs, so its charge cannot be given back twice.

What can take the index past the limit:

- **Resource sets.** Their forced records, names and details, as today: every connection needs them, and they are a
  few MiB.
- **A rebuild's forced credit** (`Settle`'s `Force`). It is never more than the hot charge of the read it replaces, and
  it is given back when the new read is dropped.
- **Until eviction catches up after lowering the limit.** Parts with no file, tiers still leased, and texts
  other units share can't be dropped. The excess goes as queued files are written and searches end, and nothing new is
  admitted meanwhile. Clear, a new key and saving off drop units and only free memory.

Every other credit move goes through the admission rule. The Memory panel shows each part.

### File format v3

- **Naming.** Today's code writes `IndexFileContainer.Version = 2`, with HKDF labels that say "v1". This page calls
  today's format v2 and the new one v3.
  - The new format writes `Version = 3`, so a v2 file from a development build fails cleanly as
    `IndexFileProblem.Version`, not as `Corrupt`, and is swept.
  - Its HKDF labels say v3 ("Varia index file v3 header", "body", "directory"), so no key of one format can open the
    other's data.
- **Layout.** In file order: the 52-byte clear prefix, the sealed header, the names section, the listing section, the
  children section, the definitions section, a sealed directory, and a fixed-size trailer giving the directory's
  offset, its length and its tag.
  - The directory comes last because section lengths and block offsets are known only once the sections are written.
    The writer streams the file in one pass, keeping only the directory in memory: it never buffers the whole file and
    never copies a second temp file.
  - `Store.List` and the sweep still read only the prefix and the header. A part load or a cold scan reads the
    trailer, then the directory, which is one seek.
  - The directory gives each section's offset, length, plain size and chunk count.
  - **Authenticating the directory.** It is sealed under its own HKDF subkey. Its AAD is SHA-256 of the clear prefix
    and the sealed header, plus the directory's offset and length, so a directory can't be moved to another file or
    another position. In the unencrypted mode the trailer's tag is a keyed SHA-256 over those same bytes and the
    directory, under the existing names key. The reader checks it before it trusts any offset.
  - **Sections are checked against the directory.** They must be in order, not overlap, and lie between the header
    and the directory. Today's `PayloadReader.Backed` checks sizes against the bytes left in the whole file (`chunks.Unread`). It becomes
    bounded by the section's or block's length in the directory, so a part load never reads into a neighbour.
  - The header records everything the newer-listing rule needs: the listing identity, the listing digest and the
    file's tiers.
  - BigQuery's facts are split by tier (the one statement of the split):
    - names section: created, listed, detailed, stale, shards, whole, columns cut, text left out, rows, bytes,
      partitioning, clustering, a routine's signature, and the details digest. These are all what object lists show
      and the checks compare;
    - children section: the table's description and the column entries with their types and descriptions, in the
      two ranges below.
  - **The children section has two ranges**, in this order, both in the directory:
    1. the child entries, their names, shapes and parent entries, which is all a cold child-name search reads;
    2. `ObjectDetails` (SQL Server's types and keys), table descriptions and column descriptions, often more than
       half the section.

    A part load reads both. A cold child-name scan reads only the first.
  - A names-only load reads the header, the directory and the names section.
- **Separate streams.** Each section is its own GCM chunk stream, with the section's index in the nonce and the AAD, so
  one section can be read without decrypting the others.
- **Blocks.** Children and definitions are split into blocks of about 1 MiB of text. Each block starts a new chunk,
  so a block's last chunk may be short. For each block the directory gives the first entry, the file offset of its
  first chunk, and that chunk's index in the stream.
  - v2's rule changes: a chunk may be short only at the end of a block, and the directory says where each block ends.
  - **A definition larger than a block.** A packed definition can be up to 1,000,000 characters, 1–3 MiB of UTF-8, and
    is written as it is (`AsIs`), with today's padding. Such a definition gets a block of its own, as large as it
    needs, never split across blocks. The directory marks it oversized, and T-7's filter treats it as one block.
    - A scan never holds such a block whole. It streams the block through a bounded window: decrypting chunk by
      chunk, decompressing with zstd's streaming decoder, and matching over a window with an overlap as long as the
      search text. The scan's scratch share therefore bounds it, even at the 64 MiB minimum limit.
    - A preview takes only the characters around the match.
  - A section's end is authenticated by the last-chunk flag on its final chunk, checked against the directory's chunk
    count. A scan that skips blocks therefore still checks each chunk's nonce. A truncated or reordered section fails
    against the directory, not only at a last-chunk flag the scan may never reach.
- **Which save a part belongs to.**
  - The file's existing random salt identifies one save.
  - A part load checks that salt against the one its names came from.
  - A mismatch means another connection or process saved the unit since. If the newer-listing rule (below) says that
    file is newer, the index loads its names section too and swaps the unit whole, so entry numbering always matches. Parts of one unit therefore always come
    from one read, without two connections refusing each other's saves in a loop.
  - If the swap does not fit, the load is refused and the part is treated as not saved.
  - When the store reports another save of a unit this connection holds, the index swaps its copy to the new file at the
    next quiet moment, not only at its next part load. Copies across connections then share one file and can be
    evicted together.
  - **Which copy is newer.** v3's header records the listing a read carries: a random id for the process that took it,
    that process's monotonic sequence number at the time, and the wall-clock time.
    - **Which listing a read carries.** A whole read or a re-listing takes a new one. A merge carries the newest listing
      it was built on: BigQuery pass 2 and a changed-listing merge take the new listing; a SQL selective re-read takes
      the fingerprint listing that started it. Only `Apply`, which lists nothing, keeps its predecessor's listing.
    - **How two listings compare.**
      - The same listing (the same process id and the same sequence number) is **equal**. An equal save is accepted, which is how
        `Apply` replaces its predecessor.
      - From the same process, otherwise, they compare by sequence number, which no clock step can reverse.
      - From different processes they compare by wall clock. Times within 2 s are a **tie**, and on a tie the incoming
        save loses and the file in place stays.
    - **One rule: the newer listing wins.** Everywhere a save meets another, the older listing or the incoming side of
      a tie loses:
      - when a save replaces one still queued under the same name;
      - when the store checks the header of the file in place before renaming, as one step on its single writer
        thread;
      - when the index decides whether to swap to another connection's or process's file.

      The header check is atomic only within a process. Two processes can each check the old header and then rename in
      turn, leaving the older listing on disk. The other process catches that through its salt check at its next part
      load, or at its hourly touch of its cold parts' files, and takes the losing path below. Until then its cold parts
      of that unit point at a file that changed, and the salt check refuses them.
    - **A merge replaces its predecessor**, whether that is still queued or already written. The predecessor is
      identified by the read the merge was built from, or by the salt of its verified write. A merge is never older
      than its predecessor.
    - **The stale check stays.** The store's existing stale marks (`StaleSeen`, `StoreSeen`) still refuse a read begun
      before a DDL mark of its dataset.
    - **Whole-project marks.** A whole-project mark records no store key under this plan. Today `Spread`
      (`ObjectSearchService.BigQuery.cs:478`) clears `StaleProjects` once the project's dataset list arrives and copies
      the mark into each dataset's `Stale` key. Those keys force whole reads and refuse saves and `Apply`. T-3b
      replaces that copy with a per-dataset re-list mark: it refuses nothing and is cleared only once that dataset's own
      listing has finished. A build stopped after the dataset list therefore keeps the marks of the datasets it did not
      reach. Re-list marks count under their project in "may have changed", as one project, as K1's fix counts a
      project mark.
    - **When a save loses.** The store reports a save it refused as older or as the incoming side of a tie, as it reports
      verified writes.
      - **Refused for disk space.** Reported separately, after the unit's own superseded file is deleted (Verified
        writes). The unit leaves the write queue and is held as parts with no file, outside the queue's bound, so builds
        never wait on it. It makes no due mark. It is tried again when space frees, or once the files in its way have
        gone 10 minutes unused.
      - **The file in place is newer** (a save refused as older, an older copy the index ignores, or a wall clock
        stepped back). The index adopts that file: it swaps its copy to it, as for any newer save. If the swap does not
        fit, the copy drops to its stub (names past the cap, as above) and is adopted when room frees. A copy that a
        newer file supersedes counts as backed by that file, so dropping it is allowed. If the sweep deletes that file
        first, the deleted-cold-part rule applies: the unit is read again from the server when it is next used.
      - **The file in place is older** (another process's rename overwrote this copy's verified file). This is handled
        as a tie, below. The re-listing's save is newer, so it wins.
      - **A tie.** The file in place stays, and the index's own copy is not saved. If the file's listing digest
        matches its own, which is the usual case of two windows connecting at once, the index adopts the file at once,
        as for a newer save, and nothing more happens. Otherwise:
        - the index marks its own cold parts of that unit not saved, since their file is gone;
        - it schedules a re-listing of that unit on the background lane, after a random delay of up to a minute, so
          two processes do not tie again;
        - the re-listing compares listing digests first, and adopts the file in place if they match;
        - otherwise it reads the unit whole from the server before saving, so it never saves a slimmed unit over a
          complete file, and its save wins with a new listing;
        - the re-listing is tried at most three times, for repeated ties within 2 s. After that, the unit's next 15-minute or 1-hour check takes a new listing and saves it, even when the
          fingerprint matches, so no unit stays unsaved and stuck in memory. If that save ties again, a new cycle of three starts;
        - none of this is counted in "may have changed".

      A read whose listing predates a DDL is therefore never taken as newer than one that follows it.
    - **Accepted:** `Apply`'s fresher columns can lose to another process's later listing that found nothing changed.
      They come back at the next in-place refresh, the rule D13 already accepts for in-place changes.
- **Touch rate.** Loading already marks the file used. v3 limits that to once a minute per file, and the index touches
  the files behind its cold parts once an hour, so another Varia process's sweep sees them as in use.
- **No migration, and no v4.** 0.10.0 has not shipped, and every lane ships in it, so the v2 reader is removed and
  nothing migrates (decision D7). Before T-1 merges, its format must hold everything later lanes read, so no later lane
  has to change it:
  - the independent Children and Definitions sections and the ownership map, the Listing section and the children section's two ranges (T-3a, T-3b, T-5);
  - the split lookups and the stub's kind mask (T-3a, T-5);
  - the blocks and the footer directory (T-5);
  - the listing identity and digest (T-3a, T-3b);

  T-1's review checks the format against each of those lanes' sections of this page.

### Building inside the limit

- **The build allowance.** A build charges what it reads to the same budget, evicting cold parts to make room. It has a
  working allowance of up to `min(limit / 4, 256 MiB)`, shared by all reads in flight. For BigQuery's pass 2 the
  datasets read at once share it, and only their merges run one at a time.
- **The interactive reserve.** `min(32 MiB, limit / 8)` of the limit is kept for loads a person is waiting on: hover,
  Go To Definition, completion, Properties, Peek and the details pane. Builds, background re-reads and queued writes
  never use it, so a busy background build never makes the editor wait.
- **The allowance's floor.** The allowance is never less than 24 MiB. At the 64 MiB minimum limit, `limit / 4` would be
  16. The interactive reserve and the names cap shrink first to make room. Below a 128 MiB limit there is no
  interactive reserve, and the names cap is what remains after the allowance and the stubs. The Options description
  says a limit below 128 MiB keeps few names in memory (decision D10).
- **One large unit runs alone.** A unit that outgrows its share of the allowance does not fail the others in flight.
  - **Mid-read**, the read that outgrows its share is abandoned and its charge given back. The unit is queued to run
    alone. That costs a second read from the server, but only once.
  - **Alone**, it runs after the other reads finish, and may borrow up to `limit / 2`. The borrow is bounded by what
    can actually be freed. It evicts cold parts, then pushes the least recent names past the names cap (making those
    units cold whole for now), but never touches the interactive reserve. The cap grows back as the borrow is given
    back.
  - **The queue admits it.** When nothing else is queued, the write queue admits one finished unit up to the borrow
    size, so a unit read alone can always be queued for its write.
  - Only a unit that does not fit even then falls back to today's left-out rules. Two 75 MiB databases under a
    128 MiB allowance are therefore read one after the other, never both cut to `CHILDREN_LEFT_OUT`.
- **A build waits only between units.** A build waits for room only before it opens a reader. It never waits while a
  `SqlDataReader` or a BigQuery page is open, so the 120 s `DatabaseBudget` never runs down while it waits. Growth
  during a read comes from eviction. When that is not enough, the read-alone rule above applies.
  - A unit that comes out with parts left out, even alone, records the room it needed. It gets a due mark only once
    the free room has grown past that, so it is never read again just to be cut again.
- **Order.** The reader builds the unit, and its names are admitted at once, so a new unit is searchable straight
  away. The store writes it; saving still waits on nothing. Once the write is verified, children and definitions stay
  in memory if there is room. Otherwise they are released as cold.
- **The write queue is bounded.** A finished unit waiting for its write keeps its charge, and builds in flight plus
  queued units stay within one allowance, with the two exceptions the admission rule names.
- **Writes are cheap enough to keep up** (decision D14):
  - **No device flush.** Index files are written through a temp file and an atomic rename, without
    `Flush(flushToDisk: true)`. The file is a cache that can be rebuilt, and every header and chunk is authenticated.
    A crash of the process loses nothing, since the operating system still writes its cache. After a power loss, a
    file that did not reach the disk fails to open, is swept, and its unit is read once from the server. Main's
    preferences and the key file are not affected.
  - **BigQuery's pass 1 is not queued while pass 2 will reach it.** A dataset whose pass 2 is scheduled in the same
    build is kept as `pendingPass2`, not put in the write queue. Its names are already charged to Names. Anything
    else it holds (details carried from the earlier read, children loaded for a changed listing) has no file and
    can't be evicted, so that charge counts against the build allowance, as a build in flight does. Its pass-1 write
    is queued:
    - when the names cap needs to make the dataset cold, since a part with no file can't be dropped;
    - whenever admission can't evict enough, oldest `pendingPass2` first, so the queue can free memory for pass 2;
    - when the build stops or ends before pass 2 reaches it;
    - when the connection closes.

    Otherwise pass 2's save is the dataset's only write. T-2's bench reports how many datasets were still written
    twice.
  - **Loads don't queue behind writes.** A part load or a cold scan reads on its own thread. Only writes go through
    the store's single writer, so an interactive load never waits behind a run of BigQuery saves.
  - T-2 benches thousands of small BigQuery datasets on Windows, with Defender on, and records saves per second
    before and after.
- **A unit larger than `limit / 2`**, even read alone, falls back to today's rules: definitions left out, then
  children, then `TOO_LARGE`. Its file records this.
- **The allowance is measured first.** T-1 measures the 300k-object bench database in memory before the allowance is
  fixed. A streaming builder, which would write a unit to disk as it reads it and so remove the `limit / 2` bound, is
  not planned unless a real database or dataset needs it (decision D4). The writer already streams the file from
  memory in one pass (File format v3).

### Evicting and loading parts

- **Stable indices.** Today entries are interleaved: children follow their parents, and keys and triggers fall between
  tables in object_id order. Text ids are handed out in insertion order and shared across tiers, since a column named
  like a table shares that table's name id.
  - `Builder.Build` does a stable partition, putting names-tier entries first and detail children after them, and remaps `Owner`, details, dates,
    BigQuery facts and `BuiltAt` (the listing's `Entry`).
  - Texts are numbered in three ranges: `[0, N)` are Names' texts, `[N, C)` texts only Children uses, and `[C, T)` texts
    only Definitions uses. Children and Definitions may point down into Names, but never at each other.
  - A text that both Children and Definitions use but Names does not (a short definition such as `((0))` that equals a
    column's name or type) is stored in both ranges under two ids. That costs a few bytes in the file, and in memory the
    `StringPool` still holds it once when both tiers are hot. Evicting either sibling frees only its own range.
  - Each text's tier comes from a classifier per tier, not from `NameTexts()`. That method counts the type names in
    `ObjectDetails` as names, but they belong to the children tier.
  - A child entry's definition (a computed column's expression) belongs to the definitions tier, and the ownership map
    says which entry uses it. Many constraints sharing one text, such as `((0))`, are listed under that one text.
  - v3 writes that same order. A check asserts the three ranges, and that neither sibling refers into the other's, so
    a cold part always attaches to a hot names table with matching numbers, whatever the other sibling's state.
  - `DatabaseIndex` keeps one pooled-reference array per tier.
- **What eviction frees, without counting first.** A Children, Definitions or Listing tier always frees memory of its
  own, even when every one of its texts is shared: its records (24 bytes per entry), `Pooled` slots (8 bytes per
  reference), `ObjectDetails`, lookup arrays, ownership map and column descriptions. Eviction therefore doesn't walk
  the pool to count freeable texts:
  - it evicts in strict least-recently-used order of (unit, tier). A unit's recency is the most recent use by any
    connection holding it, so an idle window never evicts a unit another window is using;
  - it skips tiers a lease holds, since evicting one frees nothing until its lease ends, and a hot search leases
    every unit for its 5 s. If only leased tiers are left, the reservation waits for leases to end, up to the
    request's deadline, then refuses as the budget does today. One reservation therefore never detaches the whole
    cache;
  - it counts what `Release` actually gave back, and evicts the next victim until the reservation is met or nothing
    is left to evict;
  - so it never holds `StringPool.gate` for a walk, and has no count to go stale between counting and evicting.

  Two connections to one server share nearly every text, so eviction runs through a ledger held by the pool.
  The ledger finds the copies of one unit across connections and evicts them together. It keeps the code's existing
  lock nesting:
  - the order is the service's `State.Gate`, then `ConnectionIndex.gate`, then `DatabaseIndex.gate` (lookup arrays),
    then `ResourceCatalog.gate`, then `StringPool.gate`, with the store's gate always last. The budget itself is
    Interlocked, not a lock;
  - room is reserved, evicting what is needed, before any gate is taken. `TryAcquire`, `Put` and `Settle` then only use
    up the reservation, so nothing evicts while it holds a gate, including the BigQuery paths that call `Put` and
    `Settle` under `State.Gate`;
  - the charges already made under a gate never evict. Each refuses instead, as it does today when the budget is full:
    - `DatabaseIndex.Lookup`'s lookup arrays: lookups scan instead;
    - `ResourceCatalog.Share`'s definitions: left out;
  - the ledger picks its victims under the pool lock, releases it, then evicts each copy under its own connection's
    gate, one connection at a time;
  - a tier's texts and charge go back only when its last lease ends (Tiers), so what a reservation gets counts only
    leases already ended. An evicted tier that a search still leases frees nothing until that search ends;
  - the store sends its reports outside its own gate.
- **In place, never through `Put`.** Eviction swaps the part out under the index's gate, not through
  `ConnectionIndex.Put`. `Sink.Held` therefore never saves a slimmed read over the complete file, and a check fails if
  an eviction queues a save.
- **What gets dropped.**
  - The least recently used part with a verified file goes first.
  - Lookups, hover, Properties, the details pane and search hits stamp recency. A search stamps only the units it found
    hits in, since every search scans every unit.
  - A part being read and a part with no file are never dropped. Names leave memory only by falling past the names
    cap.
- **Lowering the limit** evicts down to the new limit at once, where files exist.
- **Loading.** A part loads through the existing charged load path and pools its texts again. It is never saved again
  (`SaveWhenHeld` false).
  - It attaches only if the unit's read stamp is still the one it was loaded for, checked under the gate. A load that
    loses to a Freshness re-read is discarded.
  - A load that fails (a damaged file, another key, a refused salt) marks the part not saved, and the deleted-cold-part
    rule applies. The use that asked for the load gets `partial`, and the unit is read whole from the server once, in
    the background, since that use is waiting for it.
- **Completion.**
  - BigQuery's `language.lookup` starts loading a cold dataset's part and stamps recency.
  - Until the part attaches it answers with a new `loading` state. The renderer never caches or reuses `loading`
    (`lookup-cache.ts`), and the list is marked incomplete when an answer's state is `loading` (in `complete.ts` for object lists,
    `resolve.ts` for column answers, and `IndexCompletionService`, which sets the flag), so Monaco asks again as you type and the
    columns appear once loaded.
  - Hover and Go To Definition have no retry, so their lookups send a new `wait` flag (added to the contract, zod and C# with `loading`) and
    wait for the load for at most 8 s, or the request's remaining deadline less a margin if that is shorter. After that
    it answers `loading`, never `partial`. `lookup-cache.ts` keeps `partial` answers, and hover and completion share
    one cache per connection, so a timed-out `partial` would hide the columns for 15 s after the part attached.
    `partial` stays for a load that can't be admitted. A waited answer that is ready is cached under today's rules.
    - Waiting lookups have a backend cap of one per connection, outside completion's, so a hover never makes
      completion fall back to keywords.
    - **`language.lookup` gets its own `Lookup` lane, with no slots**, as `Explorer` has none. It makes no network
      call, so it leaves the `Metadata` lane. Waiting hovers can then never hold the 8 global metadata slots that
      connects, SQL Server completion and `bigquery.properties` need. `ProtocolHost` needs no slot that is released and
      taken again, and a lane with no slots can't starve lookups on another connection behind a waiter.
      - The lane is added to `RequestLane`, `SqlService.LaneOf`, `MethodLane` and `methodPolicies`, and a check pins it.
      - It stays bounded without slots: the renderer's caps, one waiter per connection in the backend, at most 8 s per
        wait, and the pending-request cap.
    - **Waiting lookups have their own renderer counter**, outside `indexCompletionLimits.inFlight`, of at most 2 per
      window. Four hovers waiting on four connections therefore never take completion's 4 slots, so completion doesn't
      fall back to keywords and Go To Definition doesn't fail with `indexUnavailable`.
    - The cap of one is per connection in the backend, so each popout's renderer shares it. A second waiting request
      while one waits does not wait: it gets `loading` (or `partial` if the load can't be admitted) rather than an
      error. The renderer
      shows that answer as a hover without columns, and does not ask again.
    `language.lookup` answers synchronously from one snapshot today, so a waiting lookup needs an async path that takes
    a new snapshot once the part attaches.
  - A part whose load could not be admitted answers `partial` with the reason instead, which is cached as today, so
    keystrokes do not retry a load that cannot fit.
  - The new state is added to the contract, zod and C# and tested.
  - A unit past the names cap answers `loading` the same way while its names load.
  - SQL Server completion is SQL Tools', so nothing changes there until the index serves it.

### Verified writes, and what the store tells the index

- **Verified** means the store renamed the file into place under the current store epoch, with the salt the index
  holds.
- **The store reports each verified write and each deletion.** Only then can a part become cold.
- **The index hands the store the set of files behind its cold parts.**
- **The sweep order.** The sweep deletes disconnected sources' files first, least recently used first, then files of
  connected sources unused for 10 minutes, least recently used first (decision D3).
  - **Connected is not the same as used.** The hourly touch only says a process still holds a file, so it keeps the
    file from the 30-day and disconnected-first passes. Real use (a part load, a search hit, a lookup) is recorded
    separately, so the 10-minute rule works across processes too:
    - each process keeps a small use journal in the folder, `uses-<random process id>`. It is written atomically at most
      once a minute and lists the hashed file names it used, with when;
    - the sweep reads every journal, and ignores a journal not rewritten for an hour (its process is gone);
    - the names in it are the same keyed hashes the files already carry, so it says nothing more than the folder does;
    - each write keeps only entries from the last 15 minutes, so a journal stays small. A reader refuses one larger
      than 1 MiB;
    - journals are read only as regular files, never through links or reparse points, as the store reads index
      files;
    - the sweep deletes journals not rewritten for an hour. A process deletes its own on dispose, on Clear and when
      saving is turned off.

    Two long-running processes can therefore push out each other's unused files, and the disk never wedges at full.
  - **The deleted-cold-part rule.** A cold part whose file is gone is left out until used. Its file may have been pushed
    out by a sweep for space, or removed some other way: another process's Clear, a damaged file, a salt that no longer
    matches.
    - No background build, check or re-read reads it again.
    - A use of it, or any save of its unit, reads the unit whole from the server first (No rebuild from a partial
      unit).
    - The index line says how many units are left out, and whether for disk space.

    A Clear in one process therefore never makes every other process re-read its project in the background.
- **The disk works as a cache too, driven by use** (decision D3). After disconnected sources' files are gone, a save
  may push out a connected source's file only if no one has used it for 10 minutes. Using a file means a part load, a
  search hit or a lookup, not a background check or a touch.
  - The parts behind a pushed-out file fall under the deleted-cold-part rule, as **left out for disk space**. Their
    unit's names stay hot when they were.
  - Only a use reads them again, and that use's save may in turn push out whatever is least recently used. Disk churn
    therefore follows what the user does, never a loop between background saves.
  - A save that would push out a file used within the last 10 minutes is refused for disk space, as below.
- **A unit larger than the disk limit by itself** (an 80 MiB file under a 64 MiB limit) is marked too large for the
  limit after its first refused write, and not written again until the limit grows or the unit is read again. It is never serialized, encrypted,
  written and refused on every retry. The index line says so, and its parts stay in memory under today's left-out rules.
- **A save refused for disk space never leaves a stale file.**
  - The limit is checked against net growth: the new file's size minus the size of the unit's own file it replaces.
  - If the save is still refused, the unit's superseded file is deleted, so neither a restart nor another Varia
    process loads it as current.
    - Only a file the refused save would have won against is deleted: on the writer thread, the store reads the
      header of the file in place and applies the newer-listing rule.
    - A newer file, or the file in place on a tie, is kept, and the index adopts it as when a save loses.
    - The store's header check is atomic only within a process. If another process renames a newer file in between,
      the salt check of every reader catches the deletion, and the deleted-cold-part rule applies.
  - This is safe because any rebuild that saves is made from a unit with every part hot (No rebuild from a partial
    unit, above), so the old file backs nothing.
  - The unit is then held as parts with no file, as the Verified writes rules say.

### Clear, key reset and saving off

Each of these deletes the files that cold parts depend on, and an index in memory is no longer whole by itself:

- **Clear Saved Search Indexes starts over** (decision D6). Clear is a rare, deliberate command, so it uses the paths
  that already exist rather than a reduced re-read of its own:
  - every unit that had any cold part, or was past the names cap, is dropped from memory as if it had never been read;
  - fully hot units stay, and are announced to the store again (as `Opened` does), so they are saved again and can be
    evicted afterwards;
  - each connected source then runs the build it would run on a first connect with nothing saved: its listings, then
    BigQuery's pass 2 in its usual order and pacing, or SQL Server's database reads. Units come back and are saved as
    each is read;
  - until then the index line says the index is being rebuilt, as it does at a first build.

  On a large BigQuery project this costs a first build's details calls. The confirmation says so: "Saved indexes are
  deleted. Indexes in memory are rebuilt from the server, as on a first connect; a large BigQuery project makes many
  calls."
- **A new key, a store epoch change, or Save index between sessions turned off** start over in the same way, since each
  sweeps the files at once. With saving off, the rebuilt units have no files to evict to, so they come back under
  today's left-out rules. The Options description of the setting says it rebuilds what was on disk. A write that
  finishes under an old epoch is dropped, as now, and its part stays in memory.
- **Re-announced hot units** are already charged, so they don't count toward the write-queue bound. Each one written
  makes memory evictable, so they are written first, and a build waiting for room moves them ahead of its own saves.
- **Other Varia processes** sharing the folder don't start over. They find their backing files gone when a part load or
  the hourly touch of their cold parts' files fails. A missing file counts as deleted, and the deleted-cold-part rule
  applies.
  - Eviction reads no file. It trusts the salt the index holds for the unit, from its last verified-write report,
    salt check or hourly touch.
  - A read of the clear prefix just before evicting would not stop another process deleting the file a moment later
    anyway, and it would put a file open, and Defender's scan of it, on the reservation path.
  - A file that changed or went after that is caught by the salt check at the next part load or hourly touch. The
    salt-mismatch rule or the deleted-cold-part rule then applies, and the unit is read whole before any save, so no
    slimmed unit is ever saved.
  - T-3a's bench covers eviction across thousands of small units.

  The confirmation speaks only for the process it was shown in.

### Searching cold parts

- **Hot first.** A search answers from memory first, with today's ranking, caps and 5 s budget, and returns at once.
- **Then cold parts.** Cold units' children and definitions sections, and cold units' names past the cap, are scanned
  next, one file at a time and below the store's writes. Each block is decrypted and unpacked into the search's
  `Scratch`.
  - The scan has its own deadline (decision D2) and Stop.
  - At most 2 cold scans read at once across all connections, so All servers over many connections doesn't open
    dozens of files together. Scratch is bounded by the limit, `min(16 MiB, limit / 16)` across all scans, so at the
    64 MiB minimum the scans share 4 MiB.
  - A unit whose stub rules out the search (no definitions, no detail children, none of the kinds filtered on) is
    skipped without reading its file.
  - **No hit twice.** The hot phase records, per unit, which tiers it searched hot. The cold scan covers only the
    tiers the hot phase didn't search, even if they were evicted meanwhile, so a tier's hits never appear twice, and
    no two rows share a `serverHitKey`.
  - **The kind mask has room.** Today's catalogue (`search.ts`) has exactly 64 kinds and subtype variants: 52 SQL
    Server, 8 BigQuery and 4 variants. So the mask holds kinds only (60 bits), and variants are filtered after the
    mask. A check fails if the kinds outgrow the mask.
- **`explorer.search.more`** continues a search by its `explorer.search` request id and returns the next bounded batch,
  with progress. It is added in all five places, with string and size limits, a per-method deadline and the
  pending-request cap. Its lifetime is bounded:
  - only Search Objects tabs keep a live search, since Ctrl+Q and Object Explorer's box never scan the disk (D15) and
    so never call `explorer.search.more`. Their searches end when they answer, as today;
  - one live search per connection per Search Objects tab, in each window (the main window and each popout). Main
    enforces this by sender and the request's surface id, since no window id reaches the backend. Main caps live
    searches at 4 per connection per window, closing the oldest. Typing in Ctrl+Q therefore never closes a scan
    running in a Search Objects tab;
  - **the surface reaches the backend.** `explorer.search` gets a new `surface` parameter (`tab:<id>`, `quick`,
    `explorer`; at most 64 characters in zod and C#). Only a `tab:` surface starts a live search. Main prefixes it with the sender's window id, which the renderer
    can't set, and the backend keys live searches by connection and that prefixed surface;
  - **an explicit release.** Cancelling does nothing once `explorer.search` has answered, since `ProtocolHost` ignores
    a cancel for a finished id. So `explorer.search.close` (control lane, added in all five places) releases a live
    search, its held tables and its scratch. The backend also releases the old live search itself when a new
    `explorer.search` arrives for the same key;
  - a new search on that surface replaces the old one;
  - a search ends at the scan deadline, or 10 s after its last call returned, whichever comes first;
  - it is released on disconnect and when the backend is lost;
  - its leases end when it ends (it holds only Names and stubs by then).
- **Which surfaces scan the disk** (decision D15):
  - Search Objects tabs stream cold hits.
  - Ctrl+Q searches names that are in memory, and stays instant.
  - Object Explorer's search box searches everything in memory under its scope and type filters: names, and with
    Scope: Definitions or Object types: Columns, the hot definitions or columns too.
  - Both show a note whenever something relevant to the active filters is on disk, not only when units are past the
    names cap: "Some definitions are on disk. Search Objects searches them." (or columns, or objects, by the active
    filters) The link opens the same search, with its
    filters, in a Search Objects tab.
- **Ranking.**
  - The On disk group has its own top-N cap, equal to the hot one, so a cold hit never displaces a hit already shown.
    `total` and `partial` still count every cold hit as it arrives, and each hit counts once.
  - The results add a group labelled **On disk** below the hot hits (decision D5). Under **All servers**, each server's
    group gets its own On disk subgroup, below that server's hot hits.
  - **Hits never move once the user has interacted.** Before the user has focused, selected or walked a hit, an exact
    name match found on disk goes to the top of the results. After that it goes to the top of its On disk group, and
    the status says an exact match was found on disk, with a link to it.
  - Focus, `keptHit` and the roving selection follow a hit's semantic key (`serverHitKey`, as today), never its
    position, so selection survives a rebuild of the unit. Enter and the arrow keys keep walking from the hit the user
    is on as cold hits arrive.
  - Patches use an internal key, the unit, its read stamp and the entry, since entry numbers change when a re-read
    rebuilds the unit during a live search.
- **A hot hit whose definition is cold** gets its match count and preview when the scan reaches it.
  - The backend tracks which hot hits it returned while their definitions were cold.
  - `explorer.search.more` batches carry patches keyed by each such hit's identity, with the match count and preview.
  - The renderer updates those rows in place. A patch never adds to `total`, since the hit was already counted.
  - A patch whose read stamp no longer matches the unit, because a re-read replaced it, is dropped.
- **Filters, if needed.** T-5's bench measures the scan two ways: over 2 GiB on disk, and over thousands of small
  units past the names cap, where opening each file and deriving its keys costs more than the bytes. If either is too
  slow, T-7 adds a per-block trigram filter (about 1–2% of the text), and for cold names one digest per unit.
  - Filters stored in each file's directory would still cost a file open, and Defender's scan of it, per unit on every
    search. So T-7 keeps them in one consolidated filter file, loaded once, or in Bloom filters held in memory under a
    fixed share of the budget, whichever its bench finds faster on Windows. The files carry no filters.
  - The stub's kind mask already removes most BigQuery files from a definitions scan before any filter.

### What does not change

- **SQL paths.** SQL goes only through the existing paths (`ObjectSearchSql`, `CatalogSql`, `BigQuery`). The T lanes
  add no SQL text.
- **Store rules.** The 30-day sweep, the key in main, and the no-key-store rule stay as they are.
- **Freshness times.** 15 minutes, 1 hour, and the 4 h background re-read stay. The mark handling changes only as
  K1, K3 and D13 say.
- **BigQuery tests** run on fakes and the emulator only ([testing.md](testing.md)), and on the real project only when
  the owner asks.

## Known gaps to close

| # | Gap | Cause | Fix | Lane |
| --- | --- | --- | --- | --- |
| K1 | A BigQuery dataset both due and DDL-marked counts twice in "N may have changed", as does a project mark plus a due dataset of that project | `ObjectSearchService.Freshness.cs:163` sums `Stale`, `StaleProjects` and `Due`; BigQuery's stale mark (`MarkStale`, `ObjectSearchService.BigQuery.cs:88`) leaves the key in `Due` | Count distinct datasets, and remove from `Due` on a stale mark as SQL Server does (`Freshness.cs:68`) | G-1 |
| K2 | No check that object actions, Table Designer and Properties mark a database stale | They are covered only through the methods they call | A wiring check per entry point that fails if the call is removed | G-1 |
| K3 | A BigQuery DDL mark whose whole read failed waits for the next rebuild | `Freshness.cs:135` | Retry at the dataset's next check or due search | G-1 |
| K4 | A key store that refuses to decrypt looks like a reset one: a new key is made and the old files are swept | `src/main/search-index-key.ts`; Electron's `safeStorage` exposes no OS error code, and `secret-cipher.ts` maps every failure to one fixed message on purpose | A refused decrypt can't be told apart from a reset key store, so G-1 does not try. The new key is already sealed before the old file is quarantined. G-1 makes the reset visible instead: the index line and the Memory panel say the saved indexes were reset because the key store no longer opened the key, and object-search.md documents it, including that the quarantined key file can be restored by hand | G-1 |
| K5 | A queued resource-set save is not withdrawn when its set is dropped | `IndexStore` queue; the set is shared across connections (`ResourceCatalog`) | Withdraw it when the last connection releases the set | G-1 |
| K6 | The resource set's fingerprint and the statistics aggregates use `CHECKSUM_AGG(BINARY_CHECKSUM(...))` | `ObjectSearchSql.cs:266`, `:193` | Summed row hashes, as the database fingerprint uses | G-2 |
| K7 | Weak hashes: 32-bit row hashes are summed, and the listing's row checksum is `BINARY_CHECKSUM` | `ObjectSearchSql.cs:190`, `:225` | 64-bit row hashes summed as two 32-bit halves in bigint (safe below 2^31 rows). The fingerprint keeps its separate statistics aggregate (`ss`), which already sums row hashes over every kept statistic, table types' included. Folding `sk` into `ob` would lose those: `ob` reads `sys.objects` under `ObjectTypes`, which has no `'TT'`, yet a table type's inline indexes have `sys.stats` rows (`auto_created = 0`) that the full read indexes. A check covers a table type with an inline index. `sk` stays as the listing row's per-object statistics input. The listing row can store the fingerprint's own row hash: 8 bytes instead of 4, rows of 28 bytes instead of 24, and the selective re-read fits the 32 MiB listing (`Extra`) limit up to about 1.2M rows (about 1.4M today). Bench the per-row SHA-256 cost on the 300k database | G-2 |
| K8 | A permission change (VIEW DEFINITION, a column grant, a role or group membership, a server permission) changes what the login sees without changing a `sys.objects` row | Permissions are not hashed. GRANT, REVOKE and DENY run from Varia are already marked (`TsqlChanges.cs:15`); changes made elsewhere are missed | A separate permissions hash in the sync, of the login's effective permissions and of ownership: `sys.fn_my_permissions(NULL, 'DATABASE')`, `sys.fn_my_permissions(NULL, 'SERVER')` where the server has a server scope (not Azure SQL Database), the login's role memberships, and the `sys.database_permissions` rows whose grantee is one of those principals (so an administrator is not made stale by grants to others). **Memberships** start from `DATABASE_PRINCIPAL_ID()` (null for a login that reaches the database only through a group), `public` (principal 0), and the group principals in `sys.user_token` (`WINDOWS GROUP`, `EXTERNAL GROUP`). They follow `sys.database_role_members` through nested roles in a bounded loop into a table variable, at most 32 rounds, adding only principals not yet in it. A diamond of roles therefore costs one row per role, where a `UNION ALL` recursive CTE could grow exponentially before its `DISTINCT`. The catalog reflects a role change on a pooled connection; only a group change needs a new login. **Ownership** is folded into existing hashes rather than scanned again: `COALESCE(o.principal_id, s.principal_id)` (an object owned through its schema has a null `principal_id`) joins `ob`'s row hash, and the schema's `principal_id` the `'SC'` row of `NamedObjects`. A permissions mismatch reads the database whole, because the listing cannot say which definitions became visible. The new literals join `FingerprintLiterals` for the offline lint. A live check grants and revokes a role on a pooled connection. A Windows or Entra group change shows only once the login's token changes, at its next login, which is documented | G-2 |
| K9 | Adding the `microsoft_database_tools_support` extended property hides an object but changes no hashed row | `ObjectSearchSql.cs:124` joins `sys.extended_properties`, which is not hashed | Hash those property rows (class 1, that name) | G-2 |
| K10 | A selective re-read misses foreign keys and history tables whose visibility follows an object it re-reads | The fingerprint sees the referenced object change, but `SqlReloadPlan` re-reads only changed ids | Memory can't say what to add: a key whose referenced table was hidden was stored with `Referenced` -1 (`ObjectDetails.cs:149`). So the selective re-read asks the server, in one constant query on its own path, and adds what it finds to `plan.Units` and `plan.Reread`. **Foreign keys:** the batch reads `sys.foreign_key_columns` by `fk.parent_object_id IN Only` (`ObjectSearchSql.cs:147`), so adding a key's own id would not re-read its columns. The re-read adds the parent tables (`parent_object_id`) of the keys whose `referenced_object_id` is a re-read id, with their children. **History tables:** the batch joins the current table onto its history table (`cur.history_table_id = o.object_id`, `:123`), so when a current table is re-read, its history table (`history_table_id` of the re-read tables) is added. In the reverse case, a history table that becomes visible while its current table is kept, `DatabaseReader.Seed` keeps the current table's id mapping so the history table's link resolves. Both cases get a check | G-2 |
| K11 | Uncommitted DDL rolled back during a read is saved as verified | The read runs READ UNCOMMITTED and the fingerprints READ COMMITTED, so before and after match | Two parts, and an honest residue. **Objects:** the result sets the fingerprint aggregates (objects, named objects, types, triggers, plan guides, and statistics through `sk`) return the server-side `RowHash` of their rows (bumping `BatchShape` and `SqlSync.Version`), and the sync stores the fingerprint's raw aggregates beside its digest. The read is saved as verified only when the sums of its rows (the kept rows' stored hashes plus the re-read rows', for a selective read) equal the committed aggregates. C# never recomputes the server's hash. **Children and definitions:** the object hashes can't catch a dirty column, index, parameter or definition read after result set 1 and then rolled back (the objects still match). So the post-read check only, not the 15-minute fingerprint, also takes committed aggregates of what the read took. These are the counts of `sys.columns`, `sys.indexes` and `sys.parameters` rows, and the count and sum of `DATALENGTH(definition)` of every definition the read takes: `sys.sql_modules`, `sys.check_constraints`, `sys.default_constraints`, `sys.computed_columns` and `sys.plan_guides`. It compares them with the read's own counts and lengths. **The aggregates apply exactly the batch's filters,** or a normal database would never verify: `ExplorerQueries.ColumnVisibility` for columns (graph and ledger columns), `type > 0 AND is_hypothetical = 0 AND name IS NOT NULL` for indexes (heaps), and only children of visible parents. The SQL is built from the same constants the batch uses, and a check runs both on a database with heaps, graph tables and ledger tables. **A whole read** filters by `sys.objects WHERE type IN (ObjectTypes)` plus `TableTypeIds`, not by passing 300k ids through `OPENJSON`. A selective read uses its `Only` list. A read with children left out compares only the objects and definitions, and one with definitions left out only the objects and children. **Residue, documented:** an uncommitted change that is rolled back and keeps every count and length (a same-length edit to a procedure, a column's type changed in place) can still be saved, until the next fingerprint reads the committed state. G-2 benches the extra aggregates on the 300k database | G-2 |
| K12 | `SET CONTAINMENT = PARTIAL` changes the catalog collation without changing the identity | The identity lacks containment (a contained database's catalog collation is fixed) | Add `containment` to the identity | G-2 |
| K13 | DDL that names another database (`OtherDb.dbo.Object`), or runs after an intermediate `USE`, is missed until a due search | `MarkIndexStale` (`SqlService.cs:655`) marks only the databases a script started and ended in, and marks nothing for server-level DDL | Also mark the databases of three-part names and of every `USE` target. Server-level DDL (`CREATE`, `ALTER` or `DROP DATABASE`, logins, server roles, endpoints, linked servers, server triggers, Agent jobs) marks the server's own objects unit through `MarkSqlStale(connectionId, null)`, which already exists but has no caller from query tabs. Database DDL also makes the next check list the databases again (`Listed`), so a created database is read and a dropped one is dropped. **Names are matched without regard to case.** `MarkSqlStale` looks a database up in `state.Listed` and `state.Index` ordinally (`Freshness.cs:65`), and a typed `USE otherdb` often differs in case from `sys.databases` (`OtherDb`), so the mark would be dropped. When the exact name misses, it is resolved case-insensitively against `state.Listed`; if two listed names differ only by case, both are marked | G-3 |
| K14 | Ctrl+Shift+R (Refresh Local Cache) on a SQL Server tab rebuilds only SQL Tools' cache and never checks the index | `contributions/languages.ts` calls `sqlLanguage.refreshCache` for SQL Server. BigQuery is already covered on `main`: the same command calls `IndexCompletionService.refreshCache`, which clears the lookup cache, takes up to 16 project and dataset scopes from up to 32 statements of the whole document (`extractBigQueryRefreshScopes`), and runs scoped `explorer.index` refreshes, whose pass reads details, so in-place changes show | SQL Server: also check the tab's database in the index (fingerprint, then a selective re-read if it changed) beside `sqlLanguage.refreshCache`. BigQuery stays as it is (decision D8). T-3b only checks that a scoped refresh still works with cold parts. A dataset scope reads the dataset whole, so it is a whole read, never a merge from a partial unit. A project-only scope (`extractBigQueryRefreshScopes` emits those too) reads every dataset of the project and runs `Spread`, which T-3b rewrites, so the check covers project scopes as well | G-3 |
| K15 | SQL Server 2016–2022 and low-privilege logins are not tested live | Only SQL Server 2025 as an administrator, over `lpc:.` | Live suites on 2017, 2019 and 2022 containers, run inside WSL with `test:smoke:wsl`'s toolchain (this machine's shell reaches SQL Server only through shared memory), and a low-privilege login fixture (db_datareader, no VIEW DEFINITION). 2016 has no Linux image (decision D9) | G-4 |
| K16 | `scripts/offline-stress.mjs` cannot finish within its 300 s default | The offline suite grew | Set the default from a measured run (at least 1,500 s), or split the suite so each copy fits | G-5 |
| K17 | The "not verified" freshness state has no screenshot, and the Windows explorer smoke's clipboard step has not run with the screen unlocked | The state needs a fingerprint check that fails or is denied | A capture hook that makes the check fail, and a rerun with the screen unlocked | G-5 |
| K18 | The v2 file code's known weak points: the order in which a file is replaced, slot accounting, the reserve for unnamed texts, the children fallback when a dataset already has details, the `File.Replace` window on Windows, padding bytes that are not checked to be zero, a pool reference that leaks on out-of-memory, and error mapping | File format v2 | v3 replaces that code; T-1 checks each point in the new code | T-1 |
| K19 | The one-step-lower BigQuery floor applies to new objects too, and a resource set may be read again on each rebuild | The budget floors and the resource catalog | Fixed in T-3a, which replaces the floors with the cache wherever a store saves. Without a key store, or with saving off, there is no cache to evict to, so today's floors stay and only the new-object fix applies | T-3a |
| K20 | A selective re-read misses the statistics of table types | `ObjectSearchSql.cs:139` filters `sys.stats` by `Only` alone, whereas the column, index and key queries around it also take `TableTypeIds` | Add `OR st.object_id IN TableTypeIds`, as those queries do, with a check that a selective re-read keeps a table type's inline index statistics | G-2 |

Kept as they are:

- **BigQuery in-place changes** stay stale until Refresh, Properties, Peek or the background re-read.
- **A re-created BigQuery table** shows its earlier columns between pass 1 and pass 2, by design
  ([object-search.md](object-search.md#bigquery)).
- **Two servers that report the same name to the same login share files.** The fingerprint stops one standing in for
  the other.
- **The server's own objects and Agent** are read again on every connect. Each is one cheap read.

## Lanes

Every lane ships in 0.10.0 (decision D12), and the release waits until every row below is Done. The G lanes are
independent of each other and of tiering, and can start at once, beside T-1. The T lanes are stacked, one PR each, each
in its own session. The cache is split into three PRs so each stays reviewable: T-3a (the core), then T-3b
(rebuilds) and T-3c (editor lookups). T-3b and T-3c can run side by side, since they touch different code. Every lane gets adversarial review rounds until one finds nothing above low. UI changes come
with screenshots for the owner, and T-5 and T-6 update a mock first.

| Lane | Scope | Depends on | State |
| --- | --- | --- | --- |
| G-1 | Freshness and store fixes: K1–K5 | — | Proposed |
| G-2 | Fingerprint hardening: K6–K12 and K20, with live checks on 2025, and the fingerprint's and K11's post-read aggregates' cost benched on the 300k database | — | Proposed |
| G-3 | Editor and scripts: K13, K14 | — | Proposed |
| G-4 | Live version matrix: K15 (2017, 2019 and 2022 containers, the low-privilege fixture, how to run it) | G-2 | Proposed |
| G-5 | Test tooling: K16, K17 | — | Proposed |
| T-1 | File format v3 (`Version = 3`, v3 HKDF labels), final for the release: sections, the sibling Children, Definitions and Listing sections with their text ranges and the ownership map, the lean names split of BigQuery's facts, the children section's two ranges, the footer directory with its own subkey and AAD, the trailer, sections checked in order and `Backed` bounded per section, single-pass streaming writes, per-section streams, blocks on chunk boundaries, oversized definition blocks, the listing identity and digest in the header, the stub's kind mask, the details digest in Names, salt checks, part loads, the touch rate. Its review checks the format against T-3a's, T-3b's and T-5's sections. Bench a names-only load, a single-section load and bytes per object; measure the 300k database in memory for D4, and the names tier on it and on fake BigQuery projects (one large dataset, thousands of small ones) for D1; K18 | — | Proposed |
| T-2 | Building inside the limit: everything charged (listing, scratch, queued writes), the build allowance with its floor, the interactive reserve, one large unit read alone (abandoned mid-read, a borrow bounded by what can be freed, the queue admitting it), builds waiting only between units, due marks only once room has grown, the write-queue bound, writes without a device flush (D14), pass 1 kept as `pendingPass2` and not queued while pass 2 will reach it, units too large for the disk limit marked once, loads off the writer thread, verified writes and the store's reports, complete units saved whatever the cache holds, "on disk" told apart from "left out". Bench saves per second over thousands of small datasets on Windows | T-1 | Proposed |
| T-3a | The cache core: immutable, leased tiers as siblings (Names, Children, Definitions, Listing), split lookups, stubs (with the kind mask) in `BigQueryLookup`, the names cap, per-tier charges, eviction in place in strict least-recently-used order of (unit, tier) with recency across connections and no pool walk or salt read, lowering the limit evicts, parts loaded on demand with the stamp check, salt swaps and the swap to another save at the next quiet moment, the whole tie path (adopted on a matching digest, otherwise the delayed re-listing, its three tries and the next check's new listing), the hourly touch of cold parts' files, leased tiers skipped by eviction, the listing's place outside "fully hot", Clear and epoch handling, floors folded into the cache where a store saves; K19; the eviction bench over thousands of small units | T-2 | Proposed |
| T-3b | Cold-aware rebuilds: merges and `Apply` that load every cold part first, the check that no rebuild runs from a partial unit (not-saved parts counted as missing), whole reads when parts can't all be made hot, with the needed room recorded, `Apply` off the `bigquery.properties` response in a bounded queue that waits out builds, `Apply` saves swapped only over their predecessor's salt, `SweepDatasetAsync` choosing from hot names and loading cold parts only when a details digest differs, `language.hydrate` loading cold parts first and never making a one-object dataset, `Apply` saves inheriting the expected salt of a queued predecessor, with details kept until verified, a check that BigQuery's scoped refresh (K14) stays a whole read, whole-project marks (D13) | T-3a | Proposed |
| T-3c | Editor lookups: the slotless `Lookup` lane, the `loading` state and `wait` flag in all five places, the renderer's separate waiting counter, timed-out waits answering `loading`, the async lookup path, and completion, hover, Go To Definition and `language.hydrate` while a part loads | T-3a | Proposed |
| T-4 | BigQuery reload by tier: every saved dataset's names at connect under the cap, children when used (through T-3c's `loading` and `wait`), pass 2 sharing the allowance | T-3b, T-3c | Proposed |
| T-5 | Cold search: `explorer.search.more`, `explorer.search.close` and `explorer.search`'s new `surface` parameter, the search lifetime per surface, searches dropping their Children and Definitions leases after the hot phase, at most 2 cold scans at once with scratch bounded by the limit, stub-based skips, no tier searched twice, oversized blocks streamed through a bounded window, live searches only for Search Objects tabs, the On disk group's own cap, ranking and caps, the On disk group and its All servers subgroups, hits that never move and selection by `serverHitKey`, patches keyed by unit, read stamp and entry, Ctrl+Q on hot names and the explorer box on everything hot under its filters, with their note (D15), the scan of names past the cap, children (first range only) and definitions (resolved through the ownership map), status, Stop and cancel, the 2 GiB bench, the results mock | T-3a | Proposed |
| T-6 | The sweep with the cold set, the disk as a use-driven cache (files unused for 10 minutes, the per-process use journals with their pruning, limits and deletion, the deleted-cold-part rule with no background re-read), refused saves measured by net growth and deleting only a superseded file they would have won against, the Memory panel's memory and disk lines, Options wording, docs, CHANGELOG, guide impact, screenshots | T-3c, T-4, T-5 | Proposed |
| T-7 | A per-block trigram filter for the cold scan, only if T-5's bench says it is too slow: in one consolidated filter file or in budget-capped Bloom filters in memory, not in each file, so the format does not change | T-5 | Proposed |

## Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Object names (not columns) always in memory with BigQuery's lean listing facts, capped at half the limit across all connections by recency, and units past the cap searched on disk? SQL Server's listing becomes its own cold tier, and BigQuery's table descriptions move to Children | Yes. Top-level names are a small part of an index, and instant object search is the feature. Moving the listing (up to 32 MiB a database) and descriptions (up to 1,024 characters a table) out keeps 300k–500k objects well inside the 256 MiB cap at the default limit. T-1 measures the names tier's bytes per object on the 300k SQL Server database and on fake BigQuery projects, one large dataset and thousands of small ones, with pass-2 details filled in, before the cap is fixed |
| D2 | Cold names, children and definitions searched on disk, with hits streaming in under their own deadline (30 s by default, with Stop)? | Yes. Keeping all definitions in memory would leave little to tier |
| D3 | The disk limit stays hard, and the disk works as a cache driven by use: once disconnected sources' files are gone, a save may push out a connected source's file unused for 10 minutes. Use is real use (loads, hits, lookups), recorded across processes in use journals, never the hourly touch. Those parts are left out for disk space and read again only when used, never by a background build, as is any part whose file another process removed. A refused save deletes its unit's superseded file only when it would have won against it, and the limit counts net growth? | Yes. The disk never wedges at full, a stale file is never left to load, a newer file is never deleted, and churn follows use, so there is no loop. Keep 2 GiB until T-1 gives bytes per object, then revisit in T-6 |
| D4 | A build allowance of `min(limit / 4, 256 MiB)` inside the limit, never below 24 MiB, with an interactive reserve of `min(32 MiB, limit / 8)` that builds can't use, a unit that outgrows its share read alone with up to `limit / 2`, and no streaming builder? | Yes, if T-1's measurement of the 300k database fits; otherwise revisit before T-2. The floor keeps the 64 MiB minimum usable, and reading a large unit alone stops two large databases from cutting each other's children |
| D5 | Hits found on disk shown as an **On disk** group below the hot hits (a subgroup per server under All servers), rather than merged into one list, with an exact name match moved to the top only before the user has focused or walked a hit? | Yes. Hits already shown never move, and selection follows a hit's identity, so arrow keys and Enter stay where the user is |
| D6 | Clear Saved Search Indexes (and a new key, or saving turned off) starts over: units that had parts on disk are dropped and rebuilt as on a first connect, costing a first build's BigQuery calls, with the dialog saying so? | Yes. Clear is rare and deliberate, and a cheaper names-only re-read would need a third kind of partial unit that reload, the background re-read and freshness checks would all have to learn. Someone who wants to avoid the calls can leave saving on and not clear |
| D7 | v3 (`Version = 3`) is the only format 0.10.0 ships, with T-1 holding everything T-3a, T-3b and T-5 read (sibling sections with Listing, ownership map, split lookups, the children section's two ranges, footer directory, blocks, listing identity and digest, the stub's kind mask), so no v4 follows? | Yes. Freezing v3 before its readers are designed was the risk; T-1's review against those lanes' sections removes it. Development builds' version-2 files fail cleanly as a version mismatch and are swept once. T-7's filters live outside the files, so they never change the format |
| D8 | Ctrl+Shift+R on SQL Server also checks the tab's database in the index (fingerprint, then a selective re-read if it changed), and BigQuery keeps `main`'s existing whole-document scoped refresh unchanged? | Yes. SQL Server's check costs one row. BigQuery's refresh already clears the cache and reads the named datasets' details, catching in-place changes; a caret-only path with targeted gets would be narrower, and is worth adding only if a scoped refresh of a huge dataset proves too slow |
| D9 | SQL Server 2016: test it on your machine, or accept it as untested beside containers for 2017–2022? | Containers for 2017–2022 now, and 2016 once on your machine before release |
| D10 | **Index memory limit** keeps its name and 512 MiB default, meaning the ceiling for the cache and builds? Its 64 MiB minimum stays, with no interactive reserve below 128 MiB and a description warning that a low limit keeps few names in memory? | Yes, with its description saying the rest stays on disk. Raising the minimum to 128 MiB would be simpler, but would reject settings users may already have |
| D11 | K8's permission hash on Azure SQL Database: database scope only (it has no server scope), checked live once against an Azure SQL Database you provide? | Yes. Until then, Azure SQL Database is documented as checked at database scope only |
| D12 | Every lane, G-1 to G-5 and T-1 to T-7, ships in 0.10.0, and the release waits for the last one? | Yes, as you asked, so 0.10.0 is one whole change. T-7 is the only lane that may turn out empty, if T-5's bench finds the scan fast enough. G-4 (the version matrix) and G-5 (test tooling) change no file format or behaviour, so they are the only lanes that could slip to a patch release without harm, if you ever choose to |
| D13 | A BigQuery whole-project DDL mark (DDL whose targets are unknown) stops deleting the project's files and reading every dataset whole, and checks each dataset by its listing instead, leaving in-place changes to the background re-read's normal pace? | Yes. Today one unresolved script costs a whole project's details calls, which on your project means hundreds of thousands. The cost is that an in-place change made by such a script shows up later. It stays in T-3b rather than a G lane: it relies on the newer-listing rule and re-list marks T-3a and T-3b add, and since everything ships in 0.10.0, pulling it forward would only mean building it twice, once on v2 |
| D14 | Index files written without a device flush (`flushToDisk: false`), through a temp file and an atomic rename, with BigQuery's pass 1 kept out of the write queue while pass 2 will reach it, written only if it must go cold or the build ends first? | Yes. The files are an authenticated cache that can be rebuilt: a process crash loses nothing, and after a power loss a damaged file is swept and read once. T-2 records the measured gain and how many datasets were still written twice; the expected order is ten times or more on thousands of small datasets |
| D15 | Only Search Objects tabs scan the disk. Ctrl+Q searches names in memory. Object Explorer's search box searches everything in memory under its filters (definitions with Scope: Definitions, columns with Object types: Columns). Both show "Some definitions are on disk. Search Objects searches them." (or columns, or objects) with a link whenever something relevant to the active filters is on disk? | Yes. Those two surfaces must stay instant, a scan there would compete with the one in a Search Objects tab, and the note tells the user why a definition or column hit is only found there |
