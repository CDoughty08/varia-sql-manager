# Search index tiering plan

Status: **proposed on 2026-11-27 and revised after six owner reviews. Not yet agreed.** Every lane ships in 0.10.0,
so the release is one whole change. Two decisions are already the owner's: the saved index moves into one SQLite
database (D16), and **Index memory limit**'s minimum rises to 256 MiB (D10). The open questions are in [Decisions for
the owner](#decisions-for-the-owner), each with a recommendation. Once they are agreed, this page is the plan of record
for the lanes below. Each lane's PR updates [object-search.md](object-search.md) and moves its row here to Done. When
the last lane ships, anything still relevant moves into object-search.md and this page is deleted.

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
- **One file per unit doesn't scale to thousands of datasets.** With 5,000 BigQuery datasets, every connect opens every
  file three times (the opening sweep, `Store.List`, then the load) and writes 5,000 modified times, on Windows with
  Defender scanning each open. Sharing files across processes needs a timing protocol of its own (ties, salt checks,
  use journals, hourly touches), and Windows adds `DELETE_PENDING` and the `File.Replace` gap.

This fails for the owner's production BigQuery project, which has thousands of datasets and hundreds of thousands of
objects. Whatever does not fit in 512 MiB is listed again on every start, and its details are never read.

## Goal

The disk holds the complete index, and memory holds the part in use:

- **Every read is saved whole,** whatever the memory limit, up to **Saved index disk limit**.
- **Index memory limit stays a hard ceiling** on what the index holds in memory, reads in progress included. Within it,
  memory works as a cache.
- **Object names stay in memory, up to the names cap,** so object search stays instant. Children, details and
  definitions load per unit (a database or a dataset) when needed, and the least recently used are dropped.
- **The saved index is one SQLite database** (D16). Transactions replace the multi-process file protocol, and a connect
  reads its saved names with one query.
- **Without a key store, or with saving off, nothing changes.** Memory is the whole index, and today's budget rules
  apply, BigQuery's floors included.
- **Security does not change:** the same key in main, the same AES-256-GCM, keyed hashes for every name, and nothing
  written in clear unless the existing unencrypted setting is on.

## Today's design, in short

The detail is in object-search.md. These are the facts the lanes depend on.

- **Units.** A unit is a SQL Server database, a server's own objects, Agent, a BigQuery dataset, or the shared resource
  set. Each is a `DatabaseIndex`: 24-byte entries, a texts array, optional `ObjectDetails`, BigQuery facts, lookup
  arrays built when first used, and for SQL Server the catalog listing in `Extra` (up to 32 MiB). A read charges
  `Extra` (`DatabaseReader.KeptListing`); a load from disk (`Store.Load`) does not.
- **Children are entries.** Columns, indexes, statistics, parameters and BigQuery columns (`DetailChild`) are entries
  in the same table as their parents, and they are searched by name. Statistics are indexed only for tables and views
  (`ObjectSearchService.cs:1862`). Keys, constraints and DML triggers are child entries too, but `CHILDREN_LEFT_OUT`
  keeps them.
- **Shared texts.** Every name and definition is held once in the global `StringPool`, reference counted and charged
  once across all units and connections. One `Pooled` array per read holds that read's references. A resource set's
  records, names and details are charged with `Force`.
- **Budget.** `IndexBudget` charges against the limit (64 MiB to the maximum today, default 512 MiB), with a names
  reserve of a quarter of it (`ObjectIndexLimits`). BigQuery adds floors: 3/8 for names, 7/16 for billing and starred
  projects' details, and 1/2 for discovered projects' details. A read that does not fit loses its definitions first,
  then its children (`CHILDREN_LEFT_OUT`), and then the whole unit (`TOO_LARGE`).
- **Searches.** Name and definition search scan every unit of the connection linearly, with a 5 s budget, and return a
  ranked, capped result.
- **SQL Server editor lookups.** SQL Server completion lists are SQL Tools', but the lazy schema preview drawers read
  the index: `SqlLanguageService.resolveSuggestion` calls `language.lookup` through `LookupCache` with `details` on
  three-part paths, `EditorLookup.OneSql` answers from `IndexLookup` with columns, parameters, keys and
  `ObjectDetails`, and `IntelliSensePopover` shows the source as the index in memory.
- **BigQuery editor lookups.** Completion and hover are `language.lookup`, with a 10 s deadline, over the projects,
  datasets and objects a path names.
  - It runs on the backend's `Metadata` lane (`SqlService.LaneOf`), although it makes no network call. That lane's 8
    slots are global and shared with SQL Server completion, hover and definition, `connections.connect`,
    `connections.databases` and `bigquery.properties`. Object Explorer is on the `Explorer` lane, which has no slots.
  - In the renderer, `IndexCompletionService` has one in-flight cap of 4 for completion, hover and Go To Definition.
  - Answers carry a `State` (ready, partial, building, skipped, absent). `lookup-cache.ts` keeps an answer for 15 s
    when the index is ready and the answer is neither `building` nor cut short, so `partial`, `skipped` and `absent`
    are kept.
  - `language.hydrate` fetches one object's details on demand and merges it into the held dataset
    (`MergeHydratedEntry`). Its statuses are a fixed list (`languageHydrateStatuses`).
- **Freshness.** These read held data:
  - the checks and due marks iterate the held units and their sync;
  - BigQuery's in-place refresh (`Apply`, used by Properties, Peek, the details pane and the 4 h re-read) compares a
    held dataset's columns and definitions. It runs synchronously inside `bigquery.properties` (`TableRead`,
    `RoutineRead`), rebuilds the whole dataset from what is held (`EntriesOf`), and puts it, which queues a save;
  - BigQuery's pass 1 calls `BigQueryEntries.Known` on the earlier read, which walks every column and unpacks every
    definition, before it checks whether the dataset is unchanged (`ReadPass1Async`);
  - a BigQuery DDL mark deletes the dataset's file at once (`Sink.Stale`), for every connection of the principal. A
    SQL Server mark leaves the file alone, and a BigQuery whole-project mark (DDL whose targets are unknown) marks
    every dataset of the project.
- **Files.** One file per unit, readable only whole and in order: a 52-byte clear prefix with a per-file salt, a sealed
  header, then AES-256-GCM chunks of 256 KiB with zstd per 1 MiB block (`IndexFileContainer.Version = 2`, HKDF labels
  "v1"). Writes go through a temp file and `File.Replace`, one at a time on one BelowNormal thread, each flushed to the
  device. A BigQuery dataset is written twice, after pass 1 and after pass 2. The opening sweep and `Store.List` each
  open every file's header, and a load touches each file's modified time.
- **Sharing.** All connections of one principal share the same files, and several Varia processes may share the folder.

## Design

### Tiers

| Tier | Holds | In memory |
| --- | --- | --- |
| Names | Every entry except the detail children: tables, views, routines, types, and the keys, constraints and DML triggers that `CHILDREN_LEFT_OUT` keeps today; their names and schemas; BigQuery's lean object facts | For every unit of a connected source, up to the names cap |
| Children | The detail children (`IndexFileUnit.DetailChild`: columns, indexes, statistics, parameters, BigQuery columns), the same set `CHILDREN_LEFT_OUT` leaves out today; all of `ObjectDetails`, including the details of names-tier entries (keys' columns, functions' returns); BigQuery's table and column descriptions; the children's lookup arrays | Loaded per unit when used; least recently used dropped |
| Definitions | Module, view and routine text, computed column and constraint expressions, and a per-block ownership map: for each definition, the entries that use it, and for an owner that is a detail child, that child's name, kind and parent entry | Kept while there is room; otherwise cold on disk and searched there |
| Listing | SQL Server's catalog listing (`Extra`, `SqlListing`, up to 32 MiB per database) | Cold once written. Only a selective re-read uses it, after a fingerprint mismatch |

- **The three tiers below Names are siblings.** Each depends only on Names, never on another, so each can be hot or
  cold, loaded or evicted while the others stay as they are. A cold definitions scan builds a computed column's hit
  from the ownership map and the hot names, without reading Children.
- **Names stays lean.**
  - SQL Server's listing is its own tier, so it never counts against the names cap. The 15-minute check compares only
    the fingerprint digest in the stub.
  - BigQuery keeps in Names what listings, object lists and the freshness checks read: created, listed, the flags
    (detailed, stale, whole, columns cut, text left out), shards, rows, bytes, partitioning, clustering, a routine's
    signature, and a details digest. Only table descriptions (up to 1,024 characters) move to Children: object lists
    return them only when the request asks for details (`EditorLookup.cs:395` for a jump, `:442` for a two-part list), and a request with
    details loads Children first. A three-part lookup returns the table's description whatever `details` says
    (`:464`), so it loads Children too, as it does for the columns.
  - **The details digest** is 8 bytes per object over what `SameDetails` compares: clone or not, columns,
    partitioning, clustering, signature, columns cut and definition. One pure static helper computes it, called by
    `BigQueryReader`, `Apply` and `SweepDatasetAsync` alike after the same `FactChars` and `DefinitionChars` clipping,
    so a digest compares like `SameDetails`. A held object with `TextLeftOut` counts as differing whenever the fresh
    detail has a definition. Table descriptions stay out of both, as they are out of `SameDetails` today, so a
    description change waits for a changed digest or the next whole read, which is documented.
  - **Names' facts are charged as names.** `BigQueryReader` charges partitioning, clustering and signatures through
    `ChargeDetail` today. They stay in Names, so T-1b charges them to the names charge, and pools partitioning and
    clustering through `StringPool`, since values such as `DAY(_PARTITIONTIME)` repeat across most tables. The
    background re-read, `Apply` and pass 1 use it to tell whether details changed without loading cold parts.
  - T-1b's measurement of bytes per object (D1) is taken with this split.
- **"Fully hot" leaves out the listing.** Every saved SQL Server unit has a cold listing, so a unit whose names,
  children and definitions are hot counts as fully hot for Clear, re-announcing and the cold-part tests. Before such a
  unit is saved again its listing is loaded if the store still has it. A lost listing is dropped, and the next
  fingerprint mismatch reads the unit whole, as for a unit without `Extra` today.
- **Tiers are immutable and leased.** Today `ObjectTable` is immutable and read without locks by search,
  `BigQueryLookup` and store writes. Each tier keeps that:
  - each tier is its own immutable object, owning its arrays, its `Pooled` references and its charge, and a
    `DatabaseIndex` points at its current tiers;
  - a reader (a search, a lookup, a write) takes a lease on the tiers it reads;
  - eviction only detaches a tier. Its texts go back to `StringPool`, and its charge to the budget, when the last lease
    ends, never while a reader still uses them;
  - a search drops its leases on Children and Definitions when its hot phase answers. A live `explorer.search.more`
    keeps only Names and stubs, so a 30 s disk scan never pins hot parts.
- **Every unit keeps a stub.** Hot or cold, a unit keeps a stub in memory: its key, sync, read time, freshness marks,
  listing digest and sequence, a 64-bit mask of its kinds, whether it has definitions and detail children, and its
  object count. About 300 bytes. The 15-minute and 1-hour checks, due marks and counts work on stubs and names, so
  they never load cold parts. A check that finds a cold-whole unit changed loads its names, then re-reads it as today.
  - **The kind mask has room.** Today's catalogue (`search.ts`) has 60 kinds and 4 subtype variants. The mask holds
    kinds only, and variants are filtered after it. A check fails if the kinds outgrow 64 bits.
- **Lookups are split by tier.** The name index of top-level objects lives in Names, so `BigQueryLookup.Object` finds
  a table or routine without its children. The children and foreign-key index lives in Children, dropped when it is
  evicted and built on first use after it attaches.
- **Stubs count as datasets.** `BigQueryLookup.Datasets`, `ProjectState`, `JumpObjects`, `Wave3Pending`,
  `HasAnyHeldObject` and `TierHasAnyObject` treat a stub-only dataset by its stub: it is listed, and counts as having
  objects when its stub's object count says so (today they test `read.Table.Count > 1`).
- **Names cap.** Names are capped at `min(limit / 2, limit − allowance − reserve − scratch − stubs − forced)` (decision
  D1), global across connections and ordered by recency. Within a newly connected source:
  - SQL Server: the database each query tab uses first, then by recency;
  - BigQuery: the billing project, then starred projects, then the rest.

  A unit past the cap stays cold whole, keeping only its stub. Lowering the limit makes the least recent units cold
  first. The index line says how many units are searched on disk.
- **Child-name search.** A search that matches child names answers from hot units at once, then scans cold units'
  first Children range, on the same path as cold definitions.
- **Hydrated-only datasets** (`HydratedOnlyDatasets`: datasets outside the index, such as public datasets a script
  names) are never saved, since hydrate only updates. They are the one exception to "a part with no saved copy is never dropped": they are evictable, back to unhydrated, and an eviction tells the renderer (on the existing index-state event), which un-records their targets in `attempted`, so they
  never pin memory; the next hover hydrates again.
- **No key store, or saving off.** A part with no saved copy is never dropped. This covers no key store, saving off,
  and a write still queued. When such a part does not fit, today's rules leave it out.
- **Refused for disk space** is different: there is a disk, it is just full. A unit whose save is refused for space
  keeps only its names (under the cap). Its children and definitions are released at once and marked left out for
  disk space, so refused units never pin memory the cache needs for units that are on disk. They are read again when
  used once space frees (Storage, Use, holders and the sweep).

### Work that needs a cold part

Everything that rebuilds a unit from what is held loads every cold part of that unit first, inside the build allowance,
one unit at a time.

- **The rebuilds.**
  - a merge: a selective re-read (SQL Server) or a changed listing (BigQuery);
  - BigQuery's `Apply`, which leaves the `bigquery.properties` response (below);
  - `language.hydrate` (`MergeHydratedEntry`), which calls `BigQueryEntries.Known(old)` and rebuilds the dataset;
  - the 4 h background re-read, when a digest differs.
- **No rebuild from a partial unit.** Each of these checks that every part the unit is meant to have is hot. A part
  that is cold, or marked not saved (a failed load, a lost row), counts as missing. A check fails if any rebuild runs
  with a part missing, since it would save the unit without its definitions or children, and that save, with its new
  sequence, would win.
- **When the parts can't all be made hot**, the merge is not retried as a merge:
  - a unit with a part marked not saved is read whole from the server before anything of it is saved. SQL Server has
    no read of one part;
  - a unit whose cold parts don't fit beside its hot ones, even read alone, is read whole under the read-alone and
    left-out rules, so its sync advances and the next check doesn't repeat the work;
  - the unit records how much room it needed, and is not tried as a merge again until the free room has grown past it.
- **`Known` only where it carries something.**
  - **Pass 1** decides whether a dataset is unchanged from the hot Names facts, or for a stub-only dataset from the
    stub's listing digest, before anything else. `Known` runs only for a dataset that changed, after its cold parts
    load. Checking 5,000 unchanged datasets at connect therefore loads nothing.
  - **`DetailAsync` (`:500`) and `Hold` (`:1613`) carry details on purpose.** `DetailAsync` keeps held details for
    objects it didn't fetch and for failed gets, and `Hold` puts held details back when a read doesn't fit. Both load the
    dataset's cold parts first, like the rebuilds, and keep calling `Known`.
  - T-3b's checks cover each call site of `Known` and `EntriesOf`.
- **`Apply` off the request path.** `TableRead` and `RoutineRead` only queue the fresh details, and
  `bigquery.properties` answers at once. A background job drops details whose digest matches, then loads the
  dataset's cold parts and rebuilds.
  - **Every object knows when its details were fetched.** Every `tables.get` and `routines.get` takes a fetch number
    from the store's shared counter before it runs (Storage, Generations), whichever path asks: `Apply`, pass 2,
    `DetailAsync`, hydrate or the 4 h re-read. Pass 2 takes one number per batch of at most 64 objects, immediately
    before that batch's gets, which cuts its counter transactions up to 64 times. The residual window is one batch: an
    `Apply` of an object in a batch already numbered can win over pass 2's slightly fresher read, until the next digest
    check. During a running build, `Apply` already waits for the build to end, so this only arises across processes. `Apply`, hydrate and the 4 h re-read take one per call. The
    number is kept per object in its Names facts (8 bytes, `detailFetch`). An object only listed, never detailed, has
    `detailFetch = 0`, so a names-only listing never outranks real details.
  - **Newer wins per object.** Any save that combines details (an `Apply`, a merge, a re-apply) decides per object:
    - **the same object** (a table's `Created` unchanged, a routine's `Listed` unchanged): keep whichever side has
      details with the higher `detailFetch`, and on equal numbers the side that has details (a real detail saved by a
      store-less read also records 0). An older detail never overwrites a newer one, whichever commits first;
    - **a re-created object** (`Created` changed in the newer listing): drop the old side's details, unless their
      `detailFetch` is above the newer listing's sequence, which means they were fetched after the listing saw the new
      object.
  - **Queued per unit, not per connection.** Pending details live in `ObjectSearchService`, not in `IndexStore`, keyed
    by store scope (the scope seed's hex, as `IndexStore.StaleKey` keys its marks, since `IndexStoreScope` has no value
    equality: two connections of one principal share a set, and two signed in as different Google principals never do),
    unit and object, a newer fetch replacing an older one. Two connections of one process applying details to
    different tables of one dataset add to one set, and neither overwrites the other. `ObjectSearchService` does the
    rebuild under its own reservations; the store only swaps.
  - **Bounded.** At most 1,000 pending objects across the service, charged to the build allowance. Past that, the
    oldest dataset's details are dropped and the dataset gets a due mark for the background re-read.
  - **During a build** the job waits instead of being refused (`Apply` is refused today while `state.Building`). It runs
    once the build ends, and is dropped only if the build re-read those details itself.
  - **Saved over the generation it was built on.** The rebuild applies every pending detail to the newest held copy
    and saves it only if the unit's stored generation is still the one that copy came from (Storage, Generations).
  - **Retried on a mismatch.** On a mismatch it adopts the stored generation and keeps only the pending details whose
    fetch number is above that object's stored one; the rest are dropped, as the store already has them or newer. If
    any are left it retries. If the stored row is a tombstone, the details are dropped and the unit is treated as marked.
  - **Dropped once saved.** A detail leaves the queue when a save that includes it commits. Nothing re-applies it
    afterwards, so no two processes trade re-applies.
  - **What a merge-retry commits.** It sets `sequence = @mine` and `applied` to the highest fetch number in the merged
    generation. It retries at most 3 times while other saves keep changing the generation, then gives up and gives the
    unit a due mark. A check covers: pass 1 refused for space, then an `Apply`, then pass 2.
  - **A slower read can't undo it.** The unit's row keeps `applied`: the highest per-object fetch number in its current
    generation, from every path that writes details (pass 2, `DetailAsync`, `Apply`, hydrate, the 4 h re-read). A read
    whose sequence is below it began before some stored detail was fetched, so its swap fails (Storage, The swap is
    atomic). If the stored row is live and its sequence is at most the read's, the read adopts the stored generation,
    merges by the per-object rule, and retries with the generation check, carrying its own listing. If the stored
    sequence is higher, or the row is a DDL tombstone, the read is not saved and the stored state is adopted.
  - **Without a store** (unconfigured, or saving off) the fetch numbers come from an in-process counter, which orders
    details within the process the same way. Those numbers are never saved: a unit saved later records 0 for them, as
    a pre-configure read records sequence 0, so they can't sit above the store's counter.
- **The 4 h background re-read** (`SweepDatasetAsync`) chooses what to get from the hot names and facts only
  (`Facts.Detailed`), not from `EntriesOf`, which today it calls before a pass of about 33 minutes. It compares each
  fetched object's digest with the one in Names. Only at the end of the pass, and only if a digest differs, does it
  load the dataset's cold parts and apply the changes as `Apply` does.
- **`language.hydrate`.**
  - It loads the dataset's cold parts before its 15 s network budget starts (bounded by the request's own deadline),
    then merges, and answers with its existing statuses. No new status is added, so main's response validation works
    as today.
  - It moves to the slotless `Lookup` lane with `language.lookup`, so a cold load never holds a metadata slot.
  - The renderer records targets as attempted before the answer (`recordBounded(attempted, …)`, `IndexCompletionService.ts:724–734`) and clears them only through
    `clearConnectionCaches`, on reconnect. A target whose outcome is `error` or `throttled` is now un-recorded, so a timeout is retried later
    instead of never.
  - A stub-only dataset loads its names first. The object is merged into the real dataset, never into a one-object
    unit added to `HydratedOnlyDatasets`, which would make `EditorLookup` answer `absent` for every other object.
  - The hydrated dataset is now rebuilt from every part, so it is saved like `Apply`'s result and becomes evictable.
- **DDL marks and cold parts.**
  - A BigQuery mark of one dataset replaces that dataset's stored rows with a tombstone (Storage, Generations) and
    drops its cold parts, as not saved. K3's retry makes sure the next check reads it whole.
  - **A whole-project mark** (decision D13) changes from today. Today it deletes every held dataset's file
    (`MarkProjectStale`); it sets `StaleProjects`, which forces whole reads, refuses saves and `Apply`, and keeps saved
    datasets from loading; and the store-level mark deletes every file of the project for the whole principal
    (`DropProjectWork`) and records a project-wide stale key. Under this plan, in T-3b:
    - the mark keeps the stored rows and cold parts. There is no `DropProjectWork` and no key refusing saves;
    - `StaleProjects` means "list this project's datasets again" and refuses nothing. `Spread`
      (`ObjectSearchService.BigQuery.cs:478`) gives each dataset a re-list mark, cleared only once that dataset's own
      listing has finished. K1 counts it as one project;
    - the connection that ran the script re-lists at its next search or run, other connections at their next check,
      at the rate limiter's normal pace. A dataset whose listing changed is re-read as today. The newer-listing rule
      (Storage) keeps an older read from winning;
    - one script whose targets are unknown therefore no longer throws away thousands of datasets;
    - T-3b checks each call site (including `Freshness.cs:135` and `IsScopeCoveredLocked`) and updates the two
      documented guarantees that a read begun before the DDL is never saved (object-search.md's Saved index, and
      architecture.md). They still hold for a mark of one dataset.
  - **What a listing can't see.** A listing catches `CREATE OR REPLACE` of a table (a new creation time) and `ALTER` of
    routines and models (a moved last change). It does not catch `ALTER VIEW`, `ALTER MATERIALIZED VIEW`, an in-place
    `ALTER TABLE`, or `CREATE OR REPLACE` of a date shard that isn't the newest (`tables.list` has no last-change time).
    Such DDL still marks its own dataset when its target is known. With unknown targets it is caught at the
    background re-read's pace, which is documented.
  - A SQL Server mark keeps the cold parts and the stored rows. The next check's fingerprint decides, and a selective
    re-read loads what it merges.

### What the limit covers

**Index memory limit** runs from 256 MiB (decision D10) to its maximum, 512 MiB by default. Everything the index holds
in memory is charged to the one budget:

- stubs, names, and hot children, definitions and listings;
- resource sets: still forced, since every connection needs them, and they are a few MiB;
- builds in flight, `pendingPass2` datasets' non-name charge, and queued unwritten units;
- tiers a lease still holds after eviction, until the last lease ends;
- the cold scans' scratch.

**The shares at the minimum and the default:**

| Share | Formula | 256 MiB | 512 MiB |
| --- | --- | --- | --- |
| Build allowance | `min(limit / 4, 256 MiB)` | 64 MiB | 128 MiB |
| Interactive reserve | `min(32 MiB, limit / 8)` | 32 MiB | 32 MiB |
| Cold-scan scratch | `min(16 MiB, limit / 16)` | 16 MiB | 16 MiB |
| Names cap | `min(limit / 2, limit − the three above − stubs − forced)` | up to 128 MiB | up to 256 MiB |

There is no cliff. The 256 MiB minimum leaves every share positive, so the special cases a 64 MiB limit needed (an
allowance floor, no reserve below 128 MiB) are gone.

**One admission rule.** Anything new is admitted only if what is held stays within the limit, with the forced resource
sets already counted. When something does not fit, eviction frees what it can. If that is not enough (leased tiers,
parts with no saved copy, texts other units share), a build waits for queued writes, and then falls back to today's
left-out rules. Builds in flight plus queued writes stay within the allowance. Three things sit outside that bound and
are still within the limit: a unit read alone (Building inside the limit), which has its own bound; and two kinds of
unit that are already charged and counted once, as held: fully hot units announced to the store again, which are
written first, and the names of units refused for disk space.

**Charges per tier.** A tier's own structures (entries, `Pooled` slots, `ObjectDetails`, facts, lookup arrays,
ownership maps) are charged to that tier, and eviction gives back exactly that. Pooled texts can't be split that way:
`StringPool` charges a text once, to whoever acquires it first, and frees it when its last reference goes. So:

- eviction counts what `StringPool.Release` actually gave back, as it does today;
- **the names cap counts texts exactly.** `StringPool.Entry` gains a `NamesRefs` count beside `Refs`, incremented by
  Names tiers only (never by resource sets, which are counted as forced), and the pool keeps the total bytes of entries with `NamesRefs > 0`. The cap compares Names'
  structures plus that total, so 300k unique object names never escape it, at O(1) per acquire and release.

**The limit reaches the backend at once.** Today `objectExplorer.search.memoryLimitMiB` is sent only inside
`explorer.index` when a build starts, so a change in Tools › Options does nothing until the next build. A main-only
control method, `explorer.index.setMemoryLimit`, mirrors `results.setMemoryLimit`: main sends it at backend start and
on every change, it is added in the five places with no renderer schema, and lowering it evicts at once.

**Rebuild credit.** A rebuild may reuse its predecessor's hot charge as credit, never a tier already evicted. The
predecessor is pinned while the build runs. Pinning is atomic with the lookup (`GetAndPin` under
`ConnectionIndex.gate`), and a predecessor already dropped gives no credit. K20 fixes the two places where credit is
wrong today.

What can take the index past the limit: the resource sets' forced charge; a rebuild's forced credit (never more than
what it replaces, given back when the new read is dropped); and, after the limit is lowered, parts with no saved copy,
leased tiers and shared texts until writes finish and leases end. Nothing new is admitted meanwhile. Every other
credit move goes through the admission rule. The Memory panel shows each part.

### Storage: one SQLite database

The saved index moves from one file per unit into one SQLite database per store (decision D16). The folder, the key in
main, the no-key-store rule, the 30-day rule and the unencrypted setting stay.

- **The dependency.** `Microsoft.Data.Sqlite.Core` with `SQLitePCLRaw.bundle_e_sqlite3`, which ships a native
  `e_sqlite3`. SQLite is public domain and the Microsoft packages are MIT and Apache-2.0; the project's own no-license
  rule is untouched. T-1a's packaging checklist:
  - the backend's `RuntimeIdentifiers` are win-x64, linux-x64, osx-arm64 and osx-x64, and only those natives ship;
  - `tests/backend-restore.test.ts`' lockfile parity and its rule of no runtime-pack downloads on a plain restore
    still pass with the new packages;
  - `SQLitePCL.Batteries_V2.Init()` runs once at backend start, before the store opens;
  - `build/backend-check.cjs` asserts `e_sqlite3.dll`, `libe_sqlite3.so` or `libe_sqlite3.dylib` is present for the
    target RID, at the path the RID publish actually uses (the publish root, not `runtimes/<rid>/native/`, which T-1a
    confirms per RID), and electron-builder signs `libe_sqlite3.dylib` inside `extraResources` on macOS;
  - the CI lanes and the WSL smoke run against the published backend.
- **The file.** `index-<n>.db` (Keys and sealing says how n is chosen), with its `-wal` and `-shm` files, in the existing `SearchIndex` folder. Development builds'
  `.vidx` files and their temp files (including `RF*.TMP` left by `File.Replace`) are deleted once when the store
  first opens. The folder's name check (`IndexStoreLimits.FolderName`) still guards it, and the store refuses to open
  any of the three files if it is a link.
- **Settings.** `journal_mode=WAL`, `synchronous=NORMAL` (decision D14), `busy_timeout=5000`,
  `auto_vacuum=INCREMENTAL`, `temp_store=MEMORY`, foreign keys on (only `holders` and `writes` reference `processes`: blocks are written before their unit's row exists
  and deleted in batches after it, so `parts`, `unit_names` and `filters` carry no foreign key or cascade),
  `journal_size_limit` of 32 MiB (so `-wal` doesn't stay at its high-water mark after a heavy build), and
  `Pooling=False` in the connection string, since
  the store owns its fixed connections and a pooled one would keep the file open after `Dispose` (and block a
  quarantine or retirement on Windows). `page_size` and `auto_vacuum` are set on a new file before `journal_mode=WAL`
  and before the first table: `page_size` can't change once the file is in WAL, and `auto_vacuum` set later silently
  stays off. T-1a picks the page size from its bench.
- **Transactions.** Every write transaction (counter bumps, blocks, swaps, `used_at`, holders, heartbeats, sweeps,
  Clear) is `BEGIN IMMEDIATE`, never Microsoft.Data.Sqlite's default deferred one. A deferred transaction that reads
  `meta` and then writes gets `SQLITE_BUSY_SNAPSHOT` at once, ignoring `busy_timeout`. `SQLITE_BUSY` and
  `SQLITE_LOCKED` are retried a bounded number of times with backoff, then fail as a value.
- **No snapshot outlives a slice.** No reader or transaction is held across an IPC round trip or longer than one
  slice of about 100 ms, so WAL checkpoints are never pinned and the `-wal` file stays small. Scans page by key
  (Searching cold parts).
- **Connections.** One writer connection on the store's thread, whose queue puts counter bumps ahead of block writes,
  sweeps and `incremental_vacuum`. Counter requests waiting in the queue are coalesced: k callers become one
  `UPDATE meta SET counter = counter + @k RETURNING counter`, each taking one of the k numbers, so 32 BigQuery readers
  and their per-object fetch numbers cost one short transaction per batch, not one each, and stay ordered across
  processes. A generation number and its `writes` row are taken in the same transaction. Reader connections that WAL never blocks behind
  the writer, in three pools: 2 for cold scans, 2 for interactive loads (hover, Go To Definition, completion,
  Properties, Peek, the details pane), and 2 for background loads (merges, the `Apply` job, the 4 h re-read, pass 1 of
  changed datasets, adopting newer generations, hydrate). Background loads never take an interactive reader.
- **Constant SQL.** The store's statements are constant text with values as parameters, in one class (`IndexDbSql`)
  with its own offline lint, like `ObjectSearchSql`'s. architecture.md's list of SQL paths gains it.

**The schema** (schema version 1, frozen when 0.10.0 ships; decision D7). Until then a lane may bump it, since
development builds already delete an incompatible store.

| Table | Holds |
| --- | --- |
| `meta` | One row (id 1): the schema version, a random store id, the store epoch, the mode (encrypted or unencrypted), a key check (an HMAC of the store id under the "key-check" subkey, so a wrong key is told at open without any GCM nonce), a retired flag, and one counter that hands out listing sequences, fetch numbers and generations |
| `units` | One row per unit: its id (an HMAC of scope and unit under the names key, 32 bytes), its scope's HMAC (indexed), the current generation, the listing sequence it carries, the highest fetch number applied (`applied`), the generation's salt (in clear), its sealed header (stub, sync, listing identity and digest, tiers, kind mask, sizes), its stored bytes, when it was saved, a tombstone cause (0 live, 1 DDL mark, 2 removed: pushed out, refused or damaged) and the too-large flag. Small (no names or use time in it), so sweeps and tombstone scans read small rows |
| `unit_names` | The Names section inline when it fits one block: unit id, generation, scope HMAC and the sealed block, keyed by (unit, generation) so a new generation never overwrites the current one, indexed by scope, so a connect reads its scope's names in one scan without touching `parts` |
| `unit_use` | `used_at` per unit id, so the 30 s use batches rewrite about 40 bytes a row, never a row holding names |
| `parts` | One row per stored block of the other sections, and of Names when it needs more than one block: unit id, generation, section, block number, and the sealed block. An ordinary rowid table (SQLite advises against `WITHOUT ROWID` for large rows), with a unique index on (unit, generation, section, block) |
| `writes` | One row per write in progress: unit id, generation, process id and start time, added in the write's first transaction and removed by its swap |
| `processes` | Each Varia process's random id and heartbeat time |
| `holders` | Which units each live process holds for a connected source |
| `filters` | T-7's filters, if T-7 is needed: unit id, generation, block number and the sealed filter. Sealed under a "filters" HKDF subkey and the generation's salt, with the block's position as nonce and the same associated data as blocks. Written, swapped, swept and cleared with their generation |

**Keys and sealing.**

- The data key stays in main. The backend derives five subkeys with HKDF, labelled "Varia index store v1 " and then
  "names" (the HMAC key for row ids and scope ids, used in both modes), "header", "blocks", "filters" and "key-check".
- Each generation of a unit has a random 32-byte salt, stored in clear in its `units` row (as today's clear prefix
  holds the file's salt). Two keys are derived from it: a header key, HKDF of the "header" subkey and the salt, used
  once with a zero nonce, as today's header key is; and a block key from the "blocks" subkey and the salt, under which
  a block's nonce is its section and block number. No nonce repeats under a key, because every save takes a new salt.
- Each header and block is AES-256-GCM. Its associated data is the store id, unit id, generation, section, block number
  and length (the header binds the store id, unit id and generation), so no block can be moved to another unit,
  generation or position, or cut short.
- **Unencrypted mode** stores blocks zstd-compressed with a plain SHA-256 of the same associated data and the block
  beside it, for integrity against damage only, so it adds nothing a reader of the file could not compute. Row ids are
  still HMACs under the names key derived from main's store key, as file names are today (`IndexStore.cs:240`).
- **What the database reveals** is what the folder reveals today: how many units, their sizes, and when each was saved
  and used. In encrypted mode, freed pages may hold old ciphertext until reused or vacuumed, never plaintext. In
  unencrypted mode they may hold old compressed text. So switching from unencrypted to encrypted or off, a key reset,
  and every Clear retire the store instead of deleting rows (turning saving off retires it without making a new one). Retiring is O(1): the
  old file's space, fragmentation and `-wal` go when it is unlinked, with no batched deletes, vacuum or checkpoint:
  - in the old file it moves the epoch and sets the retired flag, so every other process sees it at its next slice and
    closes its connections. Every read and write slice checks `epoch = @expected AND retired = 0`, and opening refuses
    a retired file;
  - stores are always named `index-<n>.db`, starting at `index-1.db`, so discovery has one rule: the highest n that
    is not retired or marked corrupt. A new store is n + 1;
  - the retiring process initializes `index-<n+1>.db` before it sets `retired` in `index-<n>.db`, so a crash between
    the two never leaves only a retired file;
  - any process initializing a store reads the carry (the counter of the highest readable earlier store, or the
    number written in its `.corrupt` marker), then in one `BEGIN IMMEDIATE` transaction runs
    `CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE INTO meta` (id 1) and
    `UPDATE meta SET counter = MAX(counter, @carry, @highWater)`, where `@highWater` is the highest sequence,
    generation or fetch number the process holds. Every process applies the same `UPDATE` each time it opens a store,
    not only at init. Two processes racing, or one finding a half-made file, converge on one store id, and the counter
    never falls below a number any process holds, even when an earlier file is damaged or gone;
  - a retired or corrupt file is never deleted or moved aside until a higher store's `meta` row exists. Then the old
    files are deleted once no live process has them open, retried on every heartbeat (30 s), so unencrypted
    text is gone soon after the last other process closes it. On Linux and macOS no process reads the unlinked file,
    because each closed on the flag.
- **Mode and key at open.** `meta` records the mode (encrypted or unencrypted) beside the key check. A key-check or
  mode mismatch at open is handled in two steps:
  - **first, reload once.** Main holds its key and settings for its lifetime (`SearchIndexKeyStore.held`, which has no
    reset today), so the process asks main to read the settings and the shared key file again through a new
    `SearchIndexKeyStore.forget()` and configure it anew, showing saving as paused meanwhile. A process that was out of
    date (another process reset the key or changed the mode) now matches and carries on;
  - **still mismatched after the reload:** this process is the current one (it made the new key, or the user changed
    the mode here), so it retires the store and creates the next one. A process still on the old key sees `retired`,
    mismatches on the new store, reloads, and gets the new key from the file. Each process reloads at most once per
    store, so two processes never retire each other's stores in a loop. Checks cover both orders.

**Sections and blocks.** A unit's sections are Names, Listing, Children range 1, Children range 2 and Definitions. Each
is stored as blocks, one row each, so any section, range or block is read on its own.

- **Names:** blocks of about 256 KiB of plain data, with the entries of names-tier objects and BigQuery's lean facts.
- **Listing:** blocks of about 1 MiB.
- **Children range 1:** blocks of about 256 KiB. Each holds the child entries of a run of parents (name, shape, parent
  entry) with a block-local string table, so a cold child-name scan resolves a block within its scratch without the
  rest of the unit. This is all a child-name scan reads.
- **Children range 2:** blocks with `ObjectDetails` (SQL Server's type names and keys), table descriptions and column
  descriptions, often more than half the section. Part loads read both ranges.
- **Definitions:** blocks of about 1 MiB of text, each with its own ownership map, so a scan or a T-7 filter can skip
  a block by itself.
- **Oversized texts.** A definition larger than a block, up to `ObjectIndexLimits.DefinitionChars` (1,000,000
  characters), gets a block of its own. That includes a raw UTF-16 string that `PackedText` can't pack (an unpaired
  surrogate), stored raw at up to 2 MB and flagged. A block is always read, authenticated and unpacked whole: GCM
  output can't be trusted before its tag is checked, and at most 2 MB fits each scan's 8 MiB share of the scratch.
- **Empty sections** have no rows. The header lists the blocks each section has, so a missing block is told from an
  empty section.

**Generations and the newer-listing rule.**

- **Writes in two steps.** A save's first transaction takes its new generation number from `meta`'s counter, so no
  two processes ever write the same generation, and inserts its `writes` row. It writes the generation's blocks in
  several short transactions. They are invisible while `units` still points at the old generation. A last short
  transaction makes it current with one statement,
  `INSERT INTO units … ON CONFLICT(id) DO UPDATE SET … WHERE <the swap rule>`, and removes its `writes` row. That is all
  it does, so it takes well under a millisecond. The old generation's `parts` and `filters` rows are deleted after it
  in short batched transactions on the writer thread (the orphan rule covers a crash between), so a large SQL Server
  database's hundreds of blocks never hold the writer lock. The writer lock is never held for a whole unit.
- **Orphans.** Blocks belong to a write in progress while its `writes` row exists. The sweep removes a write's blocks
  only when its process's heartbeat is dead, or when it started over an hour ago, and blocks with neither a current
  `units` generation nor a `writes` row. A first save of a new unit is therefore never swept while it writes.
- **Every removal lists every table.** The deferred delete, the orphan rule, the sweep and the 30-day removal cover
  `units`, `unit_names`, `unit_use`, `parts`, `filters`, `writes` and `holders` rows of what they remove.
- **The epoch fences every write.** Each write transaction (blocks, swap, `used_at`, holders) checks `meta.epoch` and
  the key check in the same transaction. On a mismatch, after a Clear or a key reset by another process, it aborts and
  drops its blocks, so no write straddling a Clear brings a unit back.
- **Reads see the epoch too.** Every read slice reads `meta.epoch` in the same snapshot. A moved epoch or the retired
  flag means a Clear, key reset or mode change, which the process handles as one (its saved state is gone, and it
  opens the next store under Mode and key at open), never as a run of missing or damaged units.
- **Reads begun before the store is configured.** `explorer.indexStore.configure` can arrive after a build has
  started (the OS key store may be slow). Such a read has no sequence, so it is saved with sequence 0 and only if the
  unit has no row at all. If a row or tombstone exists it is not saved, and the next check's fingerprint or listing
  decides.
- **One sequence for every process.** When a read or a re-listing starts, it takes the next number from the same
  counter in a short transaction. Every process shares the counter, so listings compare by number: the higher wins.
  There are no clocks and no ties, and a clock stepped back changes nothing.
- **Which saves take a new number.** A whole read and a re-listing take a new number when they start. Everything else
  carries the number of the listing it was built on: BigQuery's pass 2 carries its pass 1's, a changed-listing merge
  carries that listing's, a SQL selective re-read carries its fingerprint check's, and `Apply` and `language.hydrate`,
  which list nothing, carry their predecessor's.
- **The swap is atomic.** A read's save makes itself current only
  `WHERE (sequence < @mine AND applied < @mine) OR (sequence = @mine AND ((tombstone = 0 AND generation = @expected) OR tombstone = 2))`,
  or, after merging applied details, `WHERE generation = @expected AND tombstone = 0 AND sequence <= @mine`. A removed
  tombstone at the same number (pass 1 saved, then pushed out, then pass 2) is replaced; a DDL tombstone never is, and
  `generation = @expected` is never compared with a tombstone's empty generation. An older read never replaces a newer one, in one process or across
  many, and a save carrying the stored listing's number (pass 2 after a saved pass 1, a SQL re-read) replaces only the
  generation it was built on. `Apply` and hydrate are an `UPDATE … WHERE generation = @expected AND tombstone = 0`
  only, keeping the stored sequence. They never insert, so they can't bring back a unit whose row is gone. Only a
  read's save inserts, and a pre-configure read only as described above.
- **Tombstones.** A tombstone is a `units` row with no generation, no stored bytes and `applied = 0`, since it holds
  no details. Its sequence depends on why:
  - **a DDL mark** (cause 1) upserts one whether or not the unit has a row (a just-created dataset has none), with the sequence
    `max(the old one, a number taken at the mark)`. A read begun before the mark carries a lower number and fails the
    swap in every process, even though stale marks live in each process's memory;
  - **pushed out for space, a refused save, a damaged block** (cause 2) keep the unit's old sequence. No newer information came
    with them, so the retry of a refused save, or pass 2 after a refused pass 1, still passes the swap, while an
    in-flight read older than what was stored still fails it;
  - **the 30-day sweep** removes rows outright, since no read runs that long.

  Tombstones free no space, so the disk sweep never removes them. They expire after 24 hours, longer than any read can
  run, and in-memory copies can't outlast them unnoticed: see the next bullet.
- **Copies follow tombstones.** At each heartbeat a process reads the tombstones of the units it holds. One whose
  sequence is above the held copy's counts as a mark of that unit: its cold parts and pending details are dropped and
  it is read whole at its next use. A held copy is never saved again without a new read.
- **The stale check stays.** The store's existing stale marks (`StaleSeen`, `StoreSeen`) still refuse a read begun
  before a DDL mark of its dataset.
- **Copies follow the store.** When another connection or process makes a newer generation current, the index adopts
  it at the next quiet moment: names swap whole, so entry numbering always matches, and cold parts point at the new
  generation. If the swap does not fit, the copy drops to its stub and is adopted when room frees.
- **Part loads name their generation.** A cold part loads only from the generation its names came from. If that
  generation is gone, the load reads the `units` row again: a newer live generation is adopted (its names loaded,
  then the part), as Copies follow the store says, and only a tombstone or a missing row applies the deleted-cold-part
  rule. A save by another connection never costs a hover a server re-read.

**Startup.** A connect reads its scope's `units` rows joined to their current generation's `unit_names` blocks, in one
read transaction through the scope indexes, so no row is paired with another generation's names or with a write in
progress. Most units' Names fit one block, so 5,000 small datasets are one compact scan that never touches the large
`parts` tree. Only units whose Names need several blocks read `parts`. Nothing is touched. The opening sweep is SQL over
`units` and reads no blocks. T-1b benches this with 5,000 small datasets on Windows with Defender on, against today's
three opens per file.

**Use, holders and the sweep** (decision D3).

- **Use** means a part load, a search hit or a lookup. Each process batches the units it used and writes their
  `used_at` rows in `unit_use` in one transaction at most every 30 s. A save sets `used_at` to its own time, so a unit just written counts
  as used.
- **Holders.** Each process writes its heartbeat every 30 s, and lists in `holders` the units its connected sources
  hold. Any process removes the rows of a process whose heartbeat is over 2 minutes old. A unit with no live holder is
  disconnected, whichever process saved it.
- **The sweep's order.** One short transaction decides and tombstones; the blocks of what it removed are deleted
  afterwards by the deferred batched path, like an old generation's. The order: units unused for 30 days; then units no live process holds, least recently
  used first; then held units unused for 10 minutes, least recently used first.
- **If everything on disk was used in the last 10 minutes,** a save is refused for disk space. The unit keeps only its
  names in memory, its children and definitions are released and marked left out for disk space (Tiers), and the
  index line suggests raising **Saved index disk limit**. A names-only unit is never saved as it is (No rebuild from a
  partial unit): once space frees or units age past 10 minutes, it is read whole at its next use and saved then.
- **Units pushed out for space** become tombstones (Generations), never bare deletions.
- **The deleted-cold-part rule.** A cold part whose rows are gone (pushed out for space, Clear in another process, a
  damaged block) is left out until used. No background build, check or re-read reads it again. A use of it, or any save
  of its unit, reads the unit whole from the server first. The index line says how many units are left out, and
  whether for disk space. Disk churn therefore follows what the user does, never a loop between background saves.
- **Size.** The limit counts the stored bytes of current generations, against net growth (new minus the generation it
  replaces). Freed pages are given back with `PRAGMA incremental_vacuum` in small steps on the background lane. The
  Memory panel shows both stored bytes and the file's size.
- **A refused save never leaves a stale unit.** In the same transaction that refuses it, the store turns the unit's
  current generation into a cause-2 tombstone only `WHERE sequence <= @mine`. A newer generation from another connection or
  process is never removed, and an older one is never left to load.
- **A unit larger than the disk limit by itself** is flagged after its first refused write. It is not written again
  until the limit grows, and like every refused unit it keeps only its names in memory.

**Damage.** At open, `PRAGMA quick_check` runs on `meta`, `units` and the small control tables (`processes`,
`holders`, `writes`, `unit_use`, `unit_names`) on the background lane, which takes milliseconds. A whole-database check would read every page of a 2 GiB file at each start, and the `parts` rows
are already guarded by each block's authentication tag and by `SQLITE_CORRUPT` on access. A failed check, or `SQLITE_CORRUPT` from any
statement, closes the store and moves to the next store. A damaged file may not take a write, and on Windows it
can't be moved while another process has it open, so the process writes a small `index-<n>.corrupt` marker beside
it and creates `index-<n+1>.db`. Other processes check for the marker on an error and at each heartbeat and close
the file; the last to close moves it aside (one kept, as unreadable preferences files are). A new one is made, and every cold part falls under the deleted-cold-part rule. A block that
fails authentication turns only its unit into a cause-2 tombstone.

**What goes away.** The file format, the 2 s ties and their re-listings, salt compare-and-swap between files, use
journals, the hourly touch, `DELETE_PENDING` and `File.Replace` windows, temp files, and the three opens per file at
connect.

### Building inside the limit

- **The build allowance** is shared by all reads in flight. Each reader in flight has a share of
  `allowance / readers`, and unused share is lent to whichever reader needs it.
- **Queued writes take at most half the allowance.** Queued writes and `pendingPass2` count toward the cap together;
  a read-alone unit's handed-over charge counts against its own bound, not this one. Past `allowance / 2`, a new unit waits before opening its reader
  (builds wait only between units), so queued writes never crowd out readers already streaming, and no active read is
  abandoned when waiting for a write would have done.
- **A reader outgrows its share** only when the whole allowance is in use and it still needs more. Then the reader
  holding the most is abandoned and its charge given back, and its unit is queued to run alone. That costs a second
  read from the server, once. BigQuery's 32 readers at once therefore don't abort each other at 4 MiB apiece.
- **Alone**, one unit at a time across the whole service, not per connection, so two connections never both borrow.
  It runs after the other reads of its connection finish and may borrow up to
  `min(limit / 2, limit − reserve − scratch − stubs − forced − names it can't evict)`. To make that room it evicts hot
  children, definitions and listings first, then the least recent hot names, which go cold as a unit past the cap
  would. At 256 MiB that is up to 128 MiB once everything evictable is cold. It never touches the interactive reserve. When it starts, it reserves room in the write queue for its encoding
  scratch; its finished unit's memory moves into the queue with the charge it already has, never charged twice. Other
  connections' writes go on in the rest of the allowance.
- **A unit larger than `limit / 2`**, even alone, falls back to today's rules: definitions left out, then children,
  then `TOO_LARGE`. Its stored header records this. A unit that comes out cut records the room it needed, and gets a
  due mark only once the free room has grown past that.
- **The interactive reserve** is kept for loads a person waits on: hover, Go To Definition, completion, Properties,
  Peek and the details pane. Builds, background re-reads and queued writes never use it.
- **A build waits only between units.** It waits for room only before it opens a reader, never while a `SqlDataReader`
  or a BigQuery page is open, so the 120 s `DatabaseBudget` never runs down while it waits.
- **Order.** The reader builds the unit and its names are admitted at once, so a new unit is searchable straight away.
  The store writes it. Once the write commits, children and definitions stay in memory if there is room, or are
  released as cold.
- **BigQuery's pass 1 is not queued while pass 2 will reach it.** A dataset whose pass 2 is scheduled in the same build
  is kept as `pendingPass2`. Its names are charged to Names. Anything else it holds has no saved copy, so that charge
  counts against the build allowance. `pendingPass2` is bounded to pass 2's next window of datasets: older pass-1
  datasets are flushed in batches of up to 100. A batch runs each dataset's two steps with shared transactions (one
  for the generations and `writes` rows, a few for the blocks, one for the swaps), reads back each row's swap result
  (`changes()` per statement) so a refused dataset is handled alone, and takes a few milliseconds per transaction
  under WAL with `NORMAL`. A disconnect or crash never leaves thousands unwritten. A pending write is also queued when the names cap needs to
  make it cold, when admission can't evict enough (oldest first), and when the build stops, ends or its connection
  closes. Otherwise pass 2's save is its only write.
- **What every build charges.** Memory that builds use today without charging it is charged to the build (K22):
  `BigQueryBulk`'s rows (up to 8M characters a dataset during `DetailAsync`), `SqlListing.From`'s dictionary (about
  64 MiB at 1.2M rows), and the listing the store writes, streamed from memory instead of copied (`read.Extra.ToArray()`
  in `IndexStore.Save` today).
- **Loads don't queue behind writes.** Part loads and cold scans read on reader connections. Only writes go through the
  writer.
- **The allowance is measured first.** T-1b measures the 300k-object bench database in memory before the allowance is
  fixed. A streaming builder, which would write a unit as it reads it and remove the `limit / 2` bound, is not planned
  unless a real database or dataset needs it (decision D4).

### Evicting and loading parts

- **Stable indices.**
  - In T-1b, `Builder.Build` does a stable partition, names-tier entries first and detail children after, and remaps `Owner`,
    details, dates, BigQuery facts, descriptions, shards and `BuiltAt`. `BigQueryReader.Read` gains the remapping of
    facts, descriptions and shards through `BuiltAt`, which it lacks today, with a check.
  - Texts are numbered in ranges: Names' texts first, then those only Children uses, then those only Definitions uses.
    The lower tiers point down into Names, never at each other. A text two siblings use and Names does not (a short
    definition such as `((0))` equal to a column's type) is stored in both ranges under two ids, and the pool still
    holds it once.
  - Each text's tier comes from a classifier per tier, not from `NameTexts()`, which counts `ObjectDetails`' type
    names as names.
  - The store writes that same order, and a check asserts the ranges, so a cold part always attaches to a hot names
    table with matching numbers.
- **Eviction, in strict least-recently-used order of (unit, tier).** Every lower tier frees memory of its own even when
  all its texts are shared: entries, `Pooled` slots, `ObjectDetails`, lookup arrays, ownership map, descriptions. So
  eviction doesn't count freeable texts first:
  - a unit's recency is the most recent use by any connection holding it, so an idle window never evicts a unit
    another window is using;
  - it skips leased tiers. If only leased tiers are left, the reservation waits for leases to end, up to the request's
    deadline, then refuses as the budget does today;
  - **freed bytes go to the waiter.** What eviction frees for a reservation is moved into that reservation, not back to
    the shared budget, and while an interactive reservation waits, background admissions wait behind it. A build can't
    take what was evicted for a hover. `StringPool.Release` today calls `budget.Release(cost)` directly, so it gains a
    path that returns its bytes to a given reservation, used both by an eviction and by the last lease's release of a
    tier evicted earlier;
  - it counts what `Release` actually gave back, and goes on until the reservation is met or nothing is left;
  - it reads nothing from disk first. It trusts the generation the index holds, and the part-load rule catches a
    generation that went meanwhile.
- **Locks.** The code's lock order stays: `State.Gate`, then `ConnectionIndex.gate`, then `DatabaseIndex.gate`, then
  `ResourceCatalog.gate`, then `StringPool.gate`, with the store's gate last. The budget is Interlocked. Under that
  order:
  - **Room is reserved before any gate is taken.** `TryAcquire`, `Put` and `Settle` only use up the reservation, so
    nothing evicts while it holds a gate.
  - **Lookup arrays and resource definitions reserve too.** `DatabaseIndex.Lookup` reserves its arrays' estimated size
    when it is first called, before it takes `DatabaseIndex.gate`, not when a tier attaches, so the 5,000 datasets of a
    connect that no editor touches cost no lookup memory. `ResourceCatalog.Share` reserves before
    `ResourceCatalog.gate`. Otherwise a warm cache, always near full, would make every lookup scan and leave every
    newly connected server without resource definitions.
  - **The names cap is never enforced inside `Put`.** Four BigQuery paths call `Put` under `State.Gate` (`Hold`,
    `Apply`, `LoadSaved`, `MergeHydratedEntry`). `Put` only records the overage, and a background evictor enforces the
    cap after every gate is released. The overage is bounded by the reservation that admitted it.
  - **The ledger has its own lock.** Recency stamps are Interlocked writes on the stub. The ledger's lock is taken only
    to pick victims, never with another gate held, so stamps never wait behind the pool's builds.
  - **Leases are disposed outside the store's gate.** A lease's last release reaches `StringPool.gate`, so the store
    collects leases to release under its gate and releases them after leaving it. A check takes both orders under
    stress.
  - The ledger evicts each copy under its own connection's gate, one connection at a time, and the store sends its
    reports outside its gate.
- **In place, never through `Put`.** Eviction swaps a part out under the index's gate, so `Sink.Held` never saves a
  slimmed unit, and a check fails if an eviction queues a save.
- **Lowering the limit** evicts down to the new limit at once, where saved copies exist.
- **Loading.** A part loads through the charged load path and pools its texts again. It is never saved again
  (`SaveWhenHeld` false). It attaches only if the unit's read stamp is still the one it was loaded for. A load that
  fails marks the part not saved. The use that asked for it gets `partial`, and the unit is read whole from the
  server once, in the background.
- **Resource sets** (K19). A resource set is keyed by the server's identity and resource version. Today
  `ResourceCatalog` reuses a held set and retires it when the last connection releases it, so a reconnect reads it
  again. Under the plan a released set is saved where a store saves and loaded at the next connect, and with saving off
  it stays in memory, charged, for 10 minutes after its last release.

### Editor lookups while a part loads

- **`language.lookup`** starts loading a cold dataset's part and stamps recency. Until the part attaches it answers
  with a new `loading` state:
  - the renderer never caches or reuses `loading` (`lookup-cache.ts`, and `keepJumpCache`, which today excludes only
    `building`);
  - the list is marked incomplete (in `complete.ts`, `resolve.ts` and `IndexCompletionService`), so Monaco asks again
    as you type;
  - `classifyLookupTargets` treats `loading` as "not yet known", so no `tables.get` hydration is fired while a part
    loads from disk;
  - Go To Definition (`definition.ts`) says the index is still loading this dataset, never "No definition found".
- **Hover and Go To Definition wait.** Their lookups send a new `wait` flag and wait for the load for at most 8 s, or
  the remaining deadline less a margin. A timed-out wait answers `loading`, never `partial`. `partial` stays for a load
  that can't be admitted, and is cached as today.
- **Waiting is bounded:**
  - **waiters coalesce.** A wait joins the cold load already in flight for the same (unit, tier) instead of being
    refused, so a cancelled drawer's wait (Monaco cancels resolves as you arrow through suggestions, and the backend
    keeps the load) never blocks the next item on the same database, and costs no extra read;
  - at most one distinct cold load waited on per connection, and at most 8 waiters across the backend, as the other
    slotless lanes cap themselves (docs/ipc.md). A request past either cap gets `loading` at once;
  - a renderer counter of its own, at most 2 per window, outside `indexCompletionLimits.inFlight`, so waiting hovers
    never take completion's 4 slots;
  - a waiting lookup never takes `batchedJump` in `ask()`, so a hover can't hold completion's batched jump for 8 s.
- **Its own lane.** `language.lookup` moves to a new `Lookup` lane with no slots, as `Explorer` has none, so waiters
  never hold the 8 global metadata slots. The lane is added to `RequestLane`, `SqlService.LaneOf`, `MethodLane` and
  `methodPolicies`, and a check pins it.
- **The new state and flag** are added to the contract, zod and C#, and tested. `language.lookup` answers from one
  snapshot today, so a waiting lookup gets an async path that takes a new snapshot once the part attaches.
- **Requests with details.** An object list or jump that asks for details (`mode: "jump"`, a two-part path with
  `details`) needs table descriptions, so it loads Children and answers `loading` meanwhile.
- **A unit past the names cap** answers `loading` the same way while its names load.
- **SQL Server's preview drawers** get the same handling. `EditorLookup.OneSql` reads columns, parameters, keys and
  `ObjectDetails`, which are all Children, so a three-part lookup with `details` on a database whose Children are cold
  loads them and answers `loading` meanwhile. `SqlLanguageService.resolveSuggestion` checks `answer.state === 'loading'` before its early return on a missing
  object (`SqlLanguageService.ts:728`), so a loading answer renders the loading note instead of a bare item, and never
  caches `loading` in its
  `LookupCache`. Monaco resolves an item once, so the drawer's lookup sends the `wait` flag, bounded like hover's, and
  if the wait times out `IntelliSensePopover` says the index is loading that database instead of showing an empty
  drawer, until the next suggest session asks again. SQL Server's completion lists stay SQL Tools'.

### Clear, key reset and saving off

- **Clear Saved Search Indexes starts over** (decision D6):
  - first the backend sends a new `explorer.index.invalidated` event (connection ids and the reason) and closes the
    store epoch, so part loads already in flight fail cleanly;
  - then the store is retired and the next one made (Keys and sealing), in a few milliseconds whatever its size, so
    the space is back as soon as the last process closes the old file, well within `explorer.indexStore.clear`'s
    deadline;
  - every unit that had a cold part, or was past the names cap, is dropped from memory. Fully hot units stay, and are
    announced to the store again;
  - every window clears its `LookupCache`s (BigQuery and SQL Server) and closes its live cold scans;
  - the renderer answers the event by running `explorer.index` for each connected source that had an index (not one
    left unindexed with **Index on connect** off), once per connection: only the window that owns the connection runs
    it, never a popout sharing it, so two windows never start competing builds. It runs as on a first connect. The
    backend can't start that itself: it has no BigQuery index source, and the projects to read are the renderer's
    settings. Units come back and are saved as each is read, and meanwhile the index line says the index is being
    rebuilt;
  - the confirmation says so: "Saved indexes are deleted. Indexes in memory are rebuilt from the server, as on a first
    connect; a large BigQuery project makes many calls."
- **A new key** starts over the same way. **Save index between sessions turned off** retires and deletes the store
  but creates no new one, since with saving off nothing is saved. The rebuilt units have nothing to evict to, so they come back under today's left-out rules. The setting's description says it
  rebuilds what was on disk.
- **The event** is added in the five places a backend event needs (contract, zod, preload, main's forwarding, C#
  record), and main forwards it only to windows of those connections.
- **Other Varia processes** see the epoch move at their next read and fall under the deleted-cold-part rule, so they
  read nothing in the background. The confirmation speaks only for the process it was shown in.

### Searching cold parts

- **Hot first.** A search answers from memory first, with today's ranking, caps and 5 s budget, and returns at once.
- **Then cold parts,** from reader connections, below the store's writes: Names past the cap, Children range 1, and
  Definitions, one unit at a time, each block unpacked into the search's `Scratch`.
  - The scan has its own deadline (decision D2) and Stop.
  - At most 2 cold scans read at once across all connections. A scan takes one of the 2 slots, with its 8 MiB of
    scratch, per slice, and gives both back at the slice's end (a block is always unpacked whole within a slice), so a
    live search holds no scratch between slices. Slots are taken per slice of about 100 ms, never for its whole life, so an All servers search over many servers interleaves
    instead of starving servers past the second. Slots are granted in arrival order, so no search waits past
    `explorer.search.more`'s deadline for one.
  - A unit whose stub rules out the search (no definitions, no detail children, none of the kinds filtered on) is
    skipped without a read. With a database, project or dataset filter chip active, the scan walks only the matching
    stubs, not the whole scope.
  - **Short slices.** The scan pages through a scope's blocks by key (unit, generation, section, block), a slice of
    about 100 ms or a byte budget at a time, and releases its reader between slices and between
    `explorer.search.more` calls. No snapshot is held across an IPC round trip, so an idle Search Objects tab never
    pins a WAL checkpoint or a reader connection.
  - **Pinned to the hot phase's generations.** The hot phase records each unit's generation. A slice reads only that
    generation; if it was replaced meanwhile, the unit is skipped and the search is marked partial.
  - T-5 benches a child-name scan over 5,000 datasets on Windows.
- **No hit twice.**
  - The hot phase records, per unit, which tiers it searched hot. The cold scan covers only the others, even if they
    were evicted meanwhile.
  - Before a cold definition hit is emitted, its object's name is matched against the hot Names. If the name already
    matched, the hit was counted in the hot phase: it becomes a patch, or nothing, never a second row.
  - A computed column found in both cold Children and cold Definitions is emitted once, by its owner.
  - **Stub-only units** (past the names cap, Names and Definitions both cold) record the objects their cold Names
    matched in the search, so an object found again in their cold Definitions is a patch, never a second row.
  - No two rows share a `serverHitKey`.
- **Whole blocks only.** Every block, oversized ones included, is authenticated and unpacked whole into the scan's
  scratch before it is searched (Storage, Sections and blocks). There are no windows or seams, so `SearchMatcher`
  works exactly as it does in memory, multi-line regex included.
- **`explorer.search.more`** continues a search by a `searchId` field, the original `explorer.search`'s request id
  carried as a value, which names the search. It is stopped only through `explorer.search.close`, never by a
  cancel. It returns the next bounded batch,
  with progress. It is added in all five places and in `Providers.cs`' `BothMethods`, with string and size limits, a
  per-method deadline and the pending-request cap.
  - **Only Search Objects tabs keep a live search.** Ctrl+Q and Object Explorer's box never scan the disk (D15), so
    their searches end when they answer.
  - **One per tab.** `explorer.search` gets a `surface` parameter: `tab:<id>`, `quick` or `explorer`, at most 48
    characters in zod. Main prefixes it with the sender's window id, so the C# limit is 64. Only a `tab:` surface
    starts a live search, and the backend keys live searches by connection and prefixed surface.
  - **Main caps** live searches at 4 per connection per window, closing the oldest, and drops a window's searches when
    its sender is destroyed (a popout closing).
  - **Lanes.** `SqlService.LaneOf` and `MethodLane` place `explorer.search.more` with `explorer.search` on the
    `Explorer` lane and `explorer.search.close` on the control lane, since a method missing from `LaneOf` falls to
    `Metadata`. A check pins both, as for `Lookup`.
  - **An explicit release.** A cancel does nothing once `explorer.search` has answered. So `explorer.search.close`, on
    the control lane, cancels the live search's token (so a slice in flight stops at once, for Stop or a new query) and
    releases it. `cancellableRequests` (which routes every `explorer.*` method to the explorer channel) gains it and
    `explorer.search.more` as exclusions, beside
    `explorer.indexStatus`, so main doesn't route it as a cancellable explorer request. A new search on the same tab
    also releases the old one.
  - A search ends at the scan deadline, 10 s after its last call returned, on disconnect, or when the backend is lost.
- **Which surfaces scan the disk** (decision D15):
  - Search Objects tabs stream cold hits;
  - Ctrl+Q searches names in memory, and stays instant;
  - Object Explorer's box searches everything in memory under its filters: with Scope: Definitions or Object types:
    Columns, the hot definitions or columns too;
  - both show a note whenever something relevant to the active filters is on disk: "Some definitions are on disk.
    Search Objects searches them." (or columns, or objects). The link opens the same search in a Search Objects tab.
    `ObjectSearchService.open()` takes a full query (text, scope, types, case, whole word, regex), so nothing is lost.
- **Ranking.**
  - The On disk group has its own top-N cap, equal to the hot one, so a cold hit never displaces a hit already shown.
    `total` and `partial` count every cold hit once.
  - The results add a group labelled **On disk** below the hot hits (decision D5). Under **All servers**, each server
    gets its own On disk subgroup, and the list keeps the row at the top of the view where it is while a subgroup above
    grows.
  - **Hits never move once the user has interacted.** Before that, an exact name match found on disk goes to the top.
    After it, the match goes to the top of its On disk group, and the status links to it.
  - Focus, `keptHit` and selection follow `serverHitKey`, as today, so selection survives a rebuild of the unit.
- **A hot hit whose definition is cold** gets its match count and preview when the scan reaches it, only for the rows
  the hot phase actually sent (up to the top-N cap; the search keeps their keys), never for name hits past the cap
  that the renderer never received. Batches carry
  patches keyed by an internal key (unit, read stamp and entry). The renderer updates those rows in place, a patch
  never adds to `total`, and a patch from a replaced read is dropped.
- **Filters, if needed** (T-7). T-5's bench measures the scan over 2 GiB and over 5,000 small units. If either is too
  slow, T-7 adds per-block trigram filters, and one digest per unit for cold names:
  - stored as sealed blobs in the `filters` table under their own HKDF label, since plaintext trigrams would leak
    module text;
  - bypassed for searches under 3 characters, fuzzy searches, and regex without a literal of 3 or more characters;
  - the stub's kind mask already removes most BigQuery datasets from a definitions scan.

### What does not change

- **SQL paths.** SQL Server's SQL goes only through the existing paths (`ObjectSearchSql`, `CatalogSql`, `BigQuery`),
  and the T lanes add no SQL Server text. The store's SQLite statements are their own constant path (`IndexDbSql`).
- **Store rules.** The 30-day rule, the key in main, and the no-key-store rule stay as they are.
- **Freshness times.** 15 minutes, 1 hour, and the 4 h background re-read stay. The mark handling changes only as
  K1, K3 and D13 say.
- **BigQuery tests** run on fakes and the emulator only ([testing.md](testing.md)), and on the real project only when
  the owner asks.

## Known gaps to close

| # | Gap | Cause | Fix | Lane |
| --- | --- | --- | --- | --- |
| K1 | "N may have changed" counts a BigQuery dataset twice when it is both due and DDL-marked, and a project mark plus a dataset of that project | `Freshness.cs:163` sums `Stale`, `StaleProjects` and `Due`; `MarkStale`, `MarkStaleIfTracked`, `MarkProjectStale`, `Spread` and `SweepDatasetAsync` (`:247`) leave keys in `Due`, and `StaleProjects[P]` overlaps `Stale[(P, D)]` | Count distinct datasets, with a project mark counting once and covering its datasets' marks. Every one of those paths removes the key from `Due`, as SQL Server does (`Freshness.cs:68`) | G-1 |
| K2 | No check that object actions, Table Designer and Properties mark a database stale | Covered only through the methods they call | A wiring check per entry point | G-1 |
| K3 | A BigQuery DDL mark whose whole read failed waits for the next rebuild | `Freshness.cs:135`. `DueOnUseLocked` iterates only held units, so a mark on a dataset not yet held (just created) is never retried, and BigQuery never sets `state.Tried`, so removing the skip alone would retry at every search | `DueOnUseLocked` also iterates marked keys that aren't held, and BigQuery records `state.Tried` on each attempt, so retries wait the same threshold as SQL Server's | G-1 |
| K4 | A key store that refuses to decrypt looks like a reset one, and a new key is made | `search-index-key.ts`; `safeStorage` exposes no OS error code, and `secret-cipher.ts` maps failures to one message on purpose | A refused decrypt can't be told apart, so G-1 makes the reset visible: the index line and the Memory panel say the saved indexes were reset because the key store no longer opened the key, and object-search.md says the quarantined key file can be restored by hand | G-1 |
| K5 | A queued resource-set save is not withdrawn when its set is dropped | `IndexStore` queue; the set is shared (`ResourceCatalog`) | Withdraw it when the last connection releases the set | G-1 |
| K6 | The resource set's fingerprint and the statistics checksums use `CHECKSUM_AGG(BINARY_CHECKSUM(...))` | `ObjectSearchSql.cs:266`, `:193` | Summed row hashes, as the database fingerprint uses | G-2 |
| K7 | Weak hashes: 32-bit row hashes are summed, and the listing's row checksum is `BINARY_CHECKSUM` | `ObjectSearchSql.cs:190`, `:225` | 64-bit row hashes summed as two 32-bit halves in bigint (safe below 2^31 rows). Each object's statistics hash (`sk`, now summed row hashes) folds into its `ob` row hash, and the separate aggregate `ss` goes: statistics are indexed only for tables and views, and `ss`, which has no `ObjectTypes` filter, also counts table types' and internal tables' (Query Store) statistics, which would make K11's sums never match. One 8-byte hash per object is then the same in the fingerprint, the listing (rows of 28 bytes, fitting the 32 MiB `Extra` limit up to about 1.2M rows) and the batch's first result set. `HASHBYTES` runs once per row through `CROSS APPLY`. Bench the cost on the 300k database | G-2 |
| K8 | A permission change (VIEW DEFINITION, a column grant, a role or group membership, a server permission, ownership) changes what the login sees without changing a hashed row | Permissions are not hashed. GRANT, REVOKE and DENY run from Varia are marked (`TsqlChanges.cs:15`); changes made elsewhere are missed | A permissions hash in the sync over `sys.user_token` (the login's principals: user, `public`, Windows and Entra groups, and every nested role, readable with `public` alone, so a low-privilege login's nested roles are seen), the `sys.database_permissions` rows whose grantee is in it, `sys.fn_my_permissions(NULL, 'DATABASE')`, and `sys.fn_my_permissions(NULL, 'SERVER')` only where the session has a server scope (not Azure SQL Database, and not a contained user: `ServerProfile.ServerScopeInMaster`). No `INSERT`, so `ObjectSearchSql.Lint()` passes. **Ownership** joins the object's own hash: `COALESCE(o.principal_id, s.principal_id)` in `ob`, the listing and the batch, and the schema's owner in `NamedObjects`' `'SC'` row. `ALTER AUTHORIZATION` therefore shows as a changed object and is re-read. **Token age:** `sys.user_token` is fixed when a session logs in, and SqlClient retires an expired pooled connection only when it is returned. So the fingerprint check gets a pool of its own (its own application name, so Object Explorer's pool is untouched) with a 15-minute connection lifetime, `Min Pool Size=0` and `Max Pool Size=2`, so it never holds idle connections on a busy server, and a membership change is seen within two checks, up to about 30 minutes, which is documented. A permissions mismatch reads the database whole. The new literals join `FingerprintLiterals`. A live check grants and revokes a nested role | G-2 |
| K9 | Adding the `microsoft_database_tools_support` extended property hides an object but changes no hashed row | `ObjectSearchSql.cs:124` joins `sys.extended_properties` unhashed | Hash the property (class 1, `minor_id = 0`, that name) into the object's own row hash in `ob`, the listing and the batch, so a selective re-read sees which object it hid | G-2 |
| K10 | A selective re-read misses foreign keys and history tables whose visibility follows an object it re-reads | `SqlReloadPlan` re-reads only changed ids, and a key whose referenced table was hidden was stored with `Referenced` -1 (`ObjectDetails.cs:149`) | One constant query on its own path adds to `plan.Units` and `plan.Reread`: the parent tables of keys whose `referenced_object_id` is re-read (the batch reads key columns by `fk.parent_object_id`, `ObjectSearchSql.cs:147`), and the history tables of re-read current tables (the batch joins `cur.history_table_id = o.object_id`, `:123`), guarded by `r.Band >= 13` as that join is. Memory's links (`loaded.Table.Via`) add history tables that were dropped or swapped, which the server no longer reports. `plan.Worth` is checked again after the additions. `DatabaseReader.Seed` keeps a kept current table's id mapping, so a history table that becomes visible links up. Checks for each case | G-2 |
| K11 | Uncommitted DDL rolled back during a read is saved as verified | The read runs READ UNCOMMITTED and the fingerprints READ COMMITTED, so before and after match | **Objects:** the batch's first result sets return the server-side row hash (K7), and the read is verified only when the sums of its rows (kept rows' stored hashes plus re-read rows') equal the committed aggregates (bumping `BatchShape` and `SqlSync.Version`). **Children and definitions:** `DatabaseReader` counts the raw rows each result set streams, before any of its own filtering, with each definition's byte length capped at 2,000,000 per row (`ReadText`'s 1,000,000-character cap). The post-read check takes committed counts and capped lengths with exactly the batch's `FROM` and `WHERE`, built from the same constants, so filters never cause a mismatch. **A selective re-read** (`only: true`) streams rows only for its ids (`Only`, `TableTypeIds`, `DdlTriggerIds`), and kept objects keep no raw counts, so its check is scoped by the same ids the batch used. **Computed columns** are counted on the batch's own `sys.columns LEFT JOIN sys.computed_columns … WHERE <ColumnVisibility(r)>`, and only when the batch reads definitions, as that join is added only then, not on `sys.computed_columns` alone, which differs on graph and ledger tables. It covers `sys.columns`, `sys.indexes`, `sys.index_columns`, `sys.foreign_key_columns` (so `CREATE INDEX … WITH (DROP_EXISTING = ON)` with an unchanged index count is still seen), `sys.parameters`, and the definitions of `sys.sql_modules` (database DDL triggers included), `sys.check_constraints`, `sys.default_constraints`, `sys.computed_columns` and `sys.plan_guides`, with empty strings counted as the batch reads them. A read with parts left out verifies only what it read, and its sync is marked so the next mismatch reads it whole. **Residue, documented:** a rolled-back change that keeps every count and length can still be saved until the next fingerprint. Checks run on a database with heaps, graph and ledger tables, Query Store and DDL triggers, and on master and msdb. **Cost:** G-2 benches the post-read counts and `DATALENGTH` sums on the 300k database with realistic module bodies against the 15 s `FingerprintBudget` before K11 ships, and if it doesn't fit, sums only the definitions the read actually streamed | G-2 |
| K12 | `SET CONTAINMENT = PARTIAL` changes the catalog collation without changing the identity | The identity lacks containment | Add `containment` to the identity | G-2 |
| K13 | DDL that names another database, runs after an intermediate `USE`, or is server-level, is missed until a due search | `MarkIndexStale` (`SqlService.cs:655`) marks only the start and end databases, and nothing for server-level DDL | `TsqlChanges` scans the whole script, outside comments and strings: every `USE`; three-part names (`OtherDb.dbo.Obj`) and `OtherDb..Obj`, never four-part linked-server names; `CREATE`, `ALTER`, `DROP` and `RESTORE DATABASE <db>`, which mark that database and the server's own objects; other server-level DDL (logins, server roles, endpoints, linked servers, server triggers), which marks the server's own objects through `MarkSqlStale(connectionId, null)`; and Agent's procedures (`sp_add_job` and the rest), which mark Agent. Database DDL also makes the next check list databases again (`Listed`). A `USE` alone marks nothing: a database is marked only when DDL runs while it is current, so `USE OtherDb; SELECT 1;` leaves `OtherDb` as it is. **Names match without case** where an exact match misses, in `MarkSqlStale` (`Freshness.cs:65`) and `CheckSqlAsync` (`:199`, `:242`); if two listed names differ only by case, both are marked | G-3 |
| K14 | Ctrl+Shift+R on a SQL Server tab rebuilds only SQL Tools' cache and never checks the index | `contributions/languages.ts` calls `sqlLanguage.refreshCache` for SQL Server. BigQuery is covered on `main` by `IndexCompletionService.refreshCache` (up to 16 scopes from 32 statements, scoped `explorer.index` refreshes that read details) | SQL Server: also check the tab's database in the index (fingerprint, then a selective re-read if it changed). BigQuery stays as it is (decision D8). T-3b checks scoped refreshes with cold parts, for dataset scopes and for project-only scopes, which read every dataset and run `Spread` | G-3 |
| K15 | SQL Server 2016–2022 and low-privilege logins are not tested live | Only SQL Server 2025 as an administrator | Live suites on 2017, 2019 and 2022 containers inside WSL, and a low-privilege fixture (db_datareader, no VIEW DEFINITION, nested roles). 2016 has no Linux image (decision D9) | G-4 |
| K16 | `scripts/offline-stress.mjs` cannot finish within its 300 s default | The offline suite grew | Set the default from a measured run (at least 1,500 s), or split the suite | G-5 |
| K17 | The "not verified" state has no screenshot, and the Windows explorer smoke's clipboard step hasn't run unlocked | Needs a failing fingerprint check | A capture hook that fails the check, and a rerun with the screen unlocked | G-5 |
| K18 | The file code's known weak points (replace order, slot accounting, the unnamed-text reserve, the children fallback, the `File.Replace` window, unchecked padding, a pool reference leaked on out-of-memory, error mapping) | The per-unit file format | The store replaces that code. T-1b checks the points that carry over (slot accounting, the unnamed-text reserve, the children fallback, the leaked reference, error mapping) in the new code | T-1b |
| K19 | The one-step-lower BigQuery floor applies to new objects too, and a resource set is read again after its last connection releases it (a reconnect, or one window closing while another reconnects) | The budget floors; `ResourceCatalog`'s reference count retires the set at the last release (`ObjectSearchService.cs:847–850` reuses a held set) | T-3a replaces the floors with the cache where a store saves (with saving off, today's floors stay and only the new-object fix applies), and keeps a released resource set for a while (and saves it, where a store saves) so a reconnect reuses it (Evicting and loading parts) | T-3a |
| K20 | Rebuild credit is wrong in two places | `ReloadAsync` (`ObjectSearchService.SqlReload.cs`) passes a loaded read that was never put as credit, so `Settle(null, merged)` forces a charge while the loaded read is still charged, until `Abandon`; `ReadOnceAsync` reads its predecessor and pins it in two steps, and doesn't handle a predecessor `Keep` dropped meanwhile | Credit only from a read that was put; `GetAndPin` under `ConnectionIndex.gate`, with no credit from a dropped predecessor. Checks for both | G-1 |
| K21 | `Extra` is charged inconsistently | `HoldVerifiedAsync` discards `Extra` without giving its charge back (`DatabaseIndex.Bytes` keeps it), and `Store.Load` loads `Extra` without charging it | Give the charge back when `Extra` is discarded, and charge it at load. Under the plan it becomes the Listing tier's charge | G-1 |
| K22 | Builds use memory they never charge | `BigQueryBulk` (up to 8M characters a dataset), `SqlListing.From`'s dictionary (about 64 MiB at 1.2M rows), `IndexStore.Save`'s `read.Extra.ToArray()` copy (32 MiB), and `Known`'s unpacking of every definition | Charge them to the build allowance; stream the listing instead of copying it; skip `Known` where the digest answers (Work that needs a cold part) | T-2 |

Kept as they are:

- **BigQuery in-place changes** stay stale until Refresh, Properties, Peek or the background re-read.
- **A re-created BigQuery table** shows its earlier columns between pass 1 and pass 2, by design
  ([object-search.md](object-search.md#bigquery)).
- **Two servers that report the same name to the same login share saved units.** The fingerprint stops one standing
  in for the other.
- **The server's own objects and Agent** are read again on every connect. Each is one cheap read.

## Lanes

Every lane ships in 0.10.0 (decision D12), and the release waits until every row below is Done. The G lanes are
independent of each other and can start at once, beside T-1a. G-1, G-2 and G-3 land before the T lanes that build on
them: T-2 and T-3a rely on G-1's credit and `Extra` fixes (K20, K21), and T-3b on G-1's marks (K1, K3), G-2's sync
and listing shape (K7, K11) and G-3's refresh (K14). The T lanes are stacked, one PR each, each
in its own session. The store is two PRs, T-1a (engine and packaging) then T-1b (protocol and cutover), so packaging risk is reviewed apart from the codec and concurrency. The cache is three PRs so each stays reviewable: T-3a (the core), then T-3b (rebuilds) and T-3c
(editor lookups) side by side. Every lane gets adversarial review rounds until one finds nothing above low. UI changes
come with screenshots for the owner, and T-5 and T-6 update a mock first.

| Lane | Scope | Depends on | State |
| --- | --- | --- | --- |
| G-1 | Freshness, store and charge fixes: K1–K5, K20, K21 | — | Proposed |
| G-2 | Fingerprint hardening: K6–K12, with live checks on 2025, and the cost of the fingerprint and K11's aggregates benched on the 300k database | — | Proposed |
| G-3 | Editor and scripts: K13, K14 | — | Proposed |
| G-4 | Live version matrix: K15 | G-2 | Proposed |
| G-5 | Test tooling: K16, K17 | — | Proposed |
| T-1a | The SQLite engine and packaging (D16), with no caller yet: the dependency and its packaging checklist (RIDs, publish layout, restore parity, `Batteries_V2.Init`, `backend-check.cjs`, macOS signing), CI and the WSL smoke; `IndexDbSql` and its lint; the schema; connections and the three reader pools with `Pooling=False`; pragmas set before WAL and the first table, `synchronous=NORMAL` (D14); `BEGIN IMMEDIATE` with bounded retry; the writer queue with coalesced counter bumps; no snapshot across a slice; the heartbeat; `quick_check` of `meta`, `units` and the control tables; link checks; architecture.md's SQL paths | — | Proposed |
| T-1b | The store protocol and cutover (D7), with a whole-unit adapter so today's callers read and write whole units through the new store until T-3a brings tiers, keeping `main` green: keys, salts, nonces, associated data and the key check; the unencrypted mode; sections and blocks (Names inline in `unit_names` or in `parts`, Listing, Children's two ranges with block-local strings, Definitions with per-block ownership, oversized and raw texts, empty sections); generations from the shared counter, two-step writes with `writes` rows, deferred deletes of old generations, orphan rules and epoch fencing; the shared sequence, the `INSERT … ON CONFLICT` swap for reads and update-only swaps for `Apply` and hydrate; tombstones by cause and adopted at each heartbeat; retiring a store under a new file name; epoch fencing of every write and epoch checks on reads; holders and `unit_use` batching; the sweep in SQL with its tombstones and deferred deletes; a block failing authentication; pre-configure reads; one-query startup; refused saves and the too-large flag; retiring the store on every Clear, key reset and mode change, the mode in `meta` and the live-process rule for a key mismatch, the carried counter, `.corrupt` markers; deleting development builds' files; `Builder.Build`'s stable partition of entries and texts by tier and `BigQueryReader`'s `BuiltAt` remapping, so T-1b writes the real layout and D1's measurement is real; names' facts charged and pooled as names. Benches: 5,000 small datasets' startup, and the child-name scan inside a populated store (1–2 GiB of other sections in `parts`), on Windows with Defender, at page sizes of 4, 8, 16 and 32 KiB against block throughput and `unit_use` write volume (if the scan shows random reads, Children range 1 gets a compact table of its own, as Names has), the 300k database in memory for D4, names-tier bytes per object for D1, saves per second; K18 | T-1a | Proposed |
| T-2 | Building inside the limit: one read-alone unit across the service, with its encoding scratch reserved; the 256 MiB minimum in `objectSearchLimits` and `ObjectIndexLimits`, with the settings parser clamping a stored value below it to 256 MiB before validation (today an out-of-range value is dropped to the default). The clamp applies only to integers in [64, 255], the old valid range, so 0, negatives, fractions and other bad values still go through today's invalid-value path and its salvage tests stay as they are. Tests for both, and the settings catalogue regenerated; `explorer.index.setMemoryLimit` from main at start and on change; the shares table and names-cap formula; reader shares and outgrowing; read alone with its own bound and write-queue reservation; builds waiting only between units; due marks only once room has grown; the write-queue bound; `pendingPass2` bounded to pass 2's window with batched pass-1 flushes (D14); K22 | T-1b, G-1 | Proposed |
| T-3a | The cache core: immutable, leased sibling tiers; split lookups; stubs with the kind mask, in `BigQueryLookup` and its jump, wave and has-object paths; the names cap enforced outside `Put` and counted exactly through `StringPool`'s `NamesRefs`; per-tier structural charges; disk-refused units keeping names only; eviction in strict least-recently-used order with recency across connections, leased tiers skipped; reservations for lookup arrays and resource definitions; the ledger's own lock; leases released outside the store's gate; lowering the limit evicts; part loads by generation; adopting newer generations; the listing outside "fully hot"; hydrated-only datasets evictable; `StringPool`'s release into a reservation; Clear, the `explorer.index.invalidated` event and epochs; resource sets kept across rebuilds (K19); floors folded into the cache; the eviction bench over 5,000 small units, and a two-window session's structure memory for D17 | T-2, G-1 | Proposed |
| T-3b | Rebuilds with cold parts: merges, `Apply`, `language.hydrate` and the 4 h re-read loading every cold part first; the partial-unit check; whole reads when parts can't all be made hot; pass 1 deciding "unchanged" from Names facts or the stub; `Known` only where it carries; `Apply` off the request path, queued per unit with its bound, waiting out builds, with `detailFetch` taken before each get (per batch of 64 in pass 2, 0 for objects only listed), pending details held in `ObjectSearchService`, saved over its generation, identity-aware newer-wins merging per object, dropped once saved, and a slower read's swap failing below `applied`; the details digest; requests with details loading Children; scoped refreshes with cold parts (K14); whole-project marks (D13) | T-3a, G-1, G-2, G-3 | Proposed |
| T-3c | Editor lookups: the slotless `Lookup` lane, for `language.lookup` and `language.hydrate`; hydrate un-recording `error` and `throttled` targets; `loading` and `wait` in all five places; the async lookup path; the renderer's waiting counter; `batchedJump`, `keepJumpCache`, `classifyLookupTargets` and `definition.ts` handling `loading`; SQL Server's preview drawers (`EditorLookup.OneSql`, `SqlLanguageService.resolveSuggestion`, `IntelliSensePopover`) loading Children and not caching `loading`; hydrate waiting for cold loads within its budget | T-3a | Proposed |
| T-4 | Reload by tier, BigQuery and SQL Server: every saved unit's names at connect under the cap, the rest when used (through T-3c), pass 2 sharing the allowance, and SQL Server's re-read of left-out definitions under the admission rule instead of `budget.Free >= NamesReserveBytes + loaded.Bytes` | T-3b, T-3c | Proposed |
| T-5 | Cold search: `explorer.search.more`, `explorer.search.close` and `surface` in all five places, `BothMethods` and `cancellableRequests`; live searches only for Search Objects tabs, capped and dropped with their window; leases dropped after the hot phase; at most 2 scans; stub skips; short keyset slices pinned to the hot phase's generations; no hit twice; whole-block reads; the On disk group, its cap and All servers subgroups with scroll anchoring; hits that never move; patches; Ctrl+Q and the explorer box with their note and a full-query `open()` (D15); the 2 GiB and 5,000-unit benches; the results mock | T-3a | Proposed |
| T-6 | The disk as a use-driven cache in the product: the index line's left-out and disk-limit states; the Memory panel (`SqlService.ReportIndexMemory` reporting when memory shrinks, and `IndexMemoryReport` naming stubs, hot listings, leased evicted tiers, scratch and pending writes); Options wording; docs, CHANGELOG, guide impact, screenshots | T-3c, T-4, T-5 | Proposed |
| T-7 | Per-block trigram filters for the cold scan, only if T-5's bench says it is too slow: sealed in the `filters` table, bypassed for short, fuzzy and literal-free searches | T-5 | Proposed |

## Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Object names (not columns) always in memory with BigQuery's lean facts, capped at `min(limit / 2, what the other shares leave)` across all connections by recency, units past the cap searched on disk, SQL Server's listing as its own cold tier, and only table descriptions moved to Children? | Yes. Instant object search is the feature, `StringPool`'s `NamesRefs` makes the cap count names' texts exactly, and keeping the listing (up to 32 MiB a database) and descriptions out keeps 300k–500k objects inside the cap at the default limit. T-1b measures bytes per object on the 300k database and on fake BigQuery projects before the cap is fixed |
| D2 | Cold names, children and definitions searched on disk, with hits streaming in under their own deadline (30 s by default, with Stop)? | Yes. Keeping all definitions in memory would leave little to tier |
| D3 | The disk limit stays hard (use kept in its own small table, and removals left as tombstones with a cause), and the disk works as a cache driven by use: after units unused for 30 days and units no live process holds, a save may push out a held unit unused for 10 minutes. A just-saved unit counts as used, so when everything was used in the last 10 minutes a save is refused and the index line suggests a larger limit. Pushed-out parts are read again only when used? | Yes. Use and holders are rows in the store, so every process sees the same order, the disk never wedges, and churn follows use with no loop. A refused or pushed-out unit keeps only its names in memory and leaves a tombstone, so a full disk never pins memory or lets an older read back in. Keep 2 GiB until T-1b gives bytes per object, then revisit in T-6 |
| D4 | A build allowance of `min(limit / 4, 256 MiB)`, one read-alone unit at a time across the service, lookup arrays reserved on first use, shared by readers that lend unused share, an interactive reserve of `min(32 MiB, limit / 8)`, scratch of `min(16 MiB, limit / 16)`, a unit that outgrows the allowance read alone with up to `limit / 2` and its write reserved, and no streaming builder? | Yes, if T-1b's measurement of the 300k database fits; otherwise revisit before T-2. Lending share stops BigQuery's 32 readers aborting each other |
| D5 | Hits found on disk shown as an **On disk** group below the hot hits (a subgroup per server under All servers), with an exact name match moved to the top only before the user has interacted? | Yes. Hits already shown never move, and selection follows `serverHitKey` |
| D6 | Clear (and a new key, or saving off) starts over: the backend sends `explorer.index.invalidated` before deleting anything, units that had parts on disk are dropped, and the renderer rebuilds each connected source as on a first connect, costing a first build's BigQuery calls, with the dialog saying so? | Yes. Clear is rare and deliberate. The event is needed because only the renderer knows which projects to read |
| D7 | The store's schema version 1 is the only saved format 0.10.0 ships, frozen at release rather than at T-1b: T-1b aims to hold everything the later lanes read (tiers, both Children ranges with block-local strings, per-block ownership, oversized and raw texts, generations, the sequence, tombstones, the kind mask, the details digest, the `filters` table), and a later pre-release lane may still bump it? | Yes. T-1b's review checks the schema against T-3a's, T-3b's and T-5's sections, but a column T-3b or T-5 finds it needs costs nothing before release, since development builds delete an incompatible store |
| D8 | Ctrl+Shift+R on SQL Server also checks the tab's database in the index, and BigQuery keeps `main`'s scoped refresh unchanged? | Yes. SQL Server's check costs one row, and BigQuery's refresh already catches in-place changes |
| D9 | SQL Server 2016: test it on your machine, or accept it as untested beside containers for 2017–2022? | Containers for 2017–2022 now, and 2016 once on your machine before release |
| D10 | **Index memory limit** keeps its name and 512 MiB default, with its minimum raised from 64 to 256 MiB? | **Decided by the owner.** A saved value below 256 MiB is clamped to 256 MiB when read, not dropped to the default, and the description says the rest of the index stays on disk |
| D11 | K8's server-scope permissions only where the session has a server scope: not on Azure SQL Database and not for contained users, with Azure SQL Database checked live once against one you provide? | Yes. Until then, Azure SQL Database and contained users are documented as checked at database scope only |
| D12 | Every lane ships in 0.10.0, and the release waits for the last one? | Yes, as you asked, with G-1, G-2 and G-3 landed first, since T-2, T-3a and T-3b build on their fixes. T-7 may turn out empty. G-4 and G-5 change no format or behaviour, so they are the only lanes that could slip to a patch release without harm, if you ever choose to |
| D13 | A BigQuery whole-project DDL mark stops deleting the project's saved datasets and reading every dataset whole, and re-lists each dataset instead, leaving what a listing can't see (`ALTER VIEW`, in-place `ALTER TABLE`, older date shards) to the background re-read's pace? | Yes. Today one unresolved script costs a whole project's details calls, hundreds of thousands on your project. It stays in T-3b, since it relies on the shared sequence and re-list marks |
| D14 | SQLite with `synchronous=NORMAL` in WAL (no device flush on every commit), coalesced counter bumps, and BigQuery's pass 1 kept out of the write queue only for pass 2's next window, with older pass-1 datasets flushed in batches? | Yes. The store is a cache that can be rebuilt: WAL with `NORMAL` never corrupts, and a power loss loses at most the last commits, which are read again once. T-2 records saves per second and how many datasets were written twice |
| D15 | Only Search Objects tabs scan the disk. Ctrl+Q searches names in memory, and Object Explorer's box everything in memory under its filters, both with a note and a link carrying the full query whenever something relevant is on disk? | Yes. Those surfaces must stay instant, and the note says why a definition or column hit is only found in Search Objects |
| D16 | The saved index as one SQLite database (WAL, sealed blocks, keyed row ids) instead of one file per unit? | **Decided by the owner.** It replaces the multi-process file protocol with transactions, and a connect's three opens per file with one query |
| D17 | Immutable tiers shared across connections of the same store scope, unit and generation, as `ResourceCatalog` shares resource sets, instead of one copy per connection? | Not in 0.10.0's lanes unless T-3a's bench says otherwise. Texts are already shared once through `StringPool`, so sharing would save only structures, while it would make eviction, recency and leases cross-connection in the first cache PR. T-3a measures a two-window session and adds sharing if structures are a large share |
