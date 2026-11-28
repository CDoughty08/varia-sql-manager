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
| Names | Every entry except the detail children: tables, views, routines, types, and the keys, constraints and DML triggers that `CHILDREN_LEFT_OUT` keeps today; their names and schemas, the sync, and what the freshness checks compare: SQL Server's catalog listing and BigQuery's object facts (split under File format v2) | For every unit of a connected source, up to the names cap |
| Children | The detail children (`IndexFileUnit.DetailChild`: columns, indexes, statistics, parameters, BigQuery columns), the same set `CHILDREN_LEFT_OUT` leaves out today, `ObjectDetails`, BigQuery's column descriptions, the children's lookup arrays | Loaded per unit when used; least recently used dropped |
| Definitions | Module, view and routine text, computed column and constraint expressions, and an ownership map: for each definition, the entries that use it, and for an owner that is a detail child, that child's name, kind and parent entry | Kept while there is room; otherwise cold on disk and searched there |

- **Children and Definitions are siblings.** Each depends only on Names, never on the other, so either can be hot or
  cold, loaded or evicted while the other stays as it is. A cold definitions scan builds a computed column's hit from
  the ownership map and the hot names, without opening the children section.
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
      itself. The 4 h
    background re-read does the same for a cold dataset, but only when that dataset is due. It already makes at most
    1,800 calls an hour, so the loads are few.
  - **No rebuild from a partial unit.** `EntriesOf`, a merge and `Apply` check that every part the unit is meant to
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

    Under this plan all three change, in T-3, with a check for each call site. The call sites include the due-mark
    skip for projects marked whole (`Freshness.cs:135`, which overlaps K3) and `IsScopeCoveredLocked`. T-3 also
    updates the two documented guarantees that a read begun before the DDL is never saved (object-search.md's Saved
    index, and architecture.md). They still hold for a mark of one dataset. A whole-project mark relies instead on the
    newer-listing rule and on per-dataset re-list marks (File format v2, Whole-project marks):
    - the mark keeps the files and cold parts, with no `DropProjectWork` and no project key refusing saves;
    - `StaleProjects` becomes a mark that means "list this project's datasets again" and refuses nothing: no whole
      reads, no refused saves, refreshes or loads. K1 counts it as one project, not as its datasets;
    - the connection that ran the script lists the project's datasets again at its next search or run, as a stale mark
      is checked today. Other connections do it at their next check. The listings go through the rate limiter at its
      normal pace (minutes for thousands of datasets), and a dataset whose listing changed is re-read as a changed listing is today;
    - one script whose targets are unknown therefore does not throw away a project's thousands of datasets.

    T-3 checks that the listing catches every change Varia's own DDL can make, which includes `CREATE OR REPLACE` (a
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
- SQL Server's listing (`Extra`), now charged;
- resource sets: still forced, since every connection needs them, and they are a few MiB;
- builds in progress and finished units waiting for their write;
- tables a live search holds after eviction: their budget is given back when the last search lets go;
- the cold scan's scratch buffers.

**One admission rule.** Anything new is admitted only if what is held stays within the limit, with the forced resource
sets already counted. What is held means:

- stubs, names, and hot children and definitions;
- builds in flight;
- queued, unwritten units;
- search-held tables and scratch.

When something does not fit, eviction frees what it can. If that is not enough (search-held tables, parts with no file,
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
- **Until eviction catches up after lowering the limit.** Parts with no file, tables live searches hold, and texts
  other units share can't be dropped. The excess goes as queued files are written and searches end, and nothing new is
  admitted meanwhile. Clear, a new key and saving off drop units and only free memory.

Every other credit move goes through the admission rule. The Memory panel shows each part.

### File format v2

- **Layout.** In file order: the 52-byte clear prefix, the sealed header, the names section, the children section, the
  definitions section, a sealed directory, and a fixed-size trailer giving the directory's offset, its length and its
  tag.
  - The directory comes last because section lengths and block offsets are known only once the sections are written.
    The writer streams the file in one pass, keeping only the directory in memory: it never buffers the whole file and
    never copies a second temp file.
  - `Store.List` and the sweep still read only the prefix and the header. A part load or a cold scan reads the
    trailer, then the directory, which is one seek.
  - The directory gives each section's offset, length, plain size and chunk count. The trailer's tag, which binds the
    directory to the header's salt, authenticates it.
  - The header records everything the newer-listing rule needs: the listing identity, the listing digest and the
    file's tiers.
  - BigQuery's facts are split by tier (the one statement of the split), matching what a read without children keeps
    today:
    - names section: each object's `BigQueryObjectFacts` (created, listed, detailed, stale, shards, whole, columns cut,
      text left out, rows, bytes, partitioning, clustering, and a routine's signature, which object-list completion
      shows);
    - children section: column descriptions, and the column entries with their types.
  - A names-only load reads the header, the directory and the names section.
- **Separate streams.** Each section is its own GCM chunk stream, with the section's index in the nonce and the AAD, so
  one section can be read without decrypting the others.
- **Blocks.** Children and definitions are split into blocks of about 1 MiB of text. Each block starts a new chunk,
  so a block's last chunk may be short. For each block the directory gives the first entry, the file offset of its
  first chunk, and that chunk's index in the stream.
  - v1's rule changes: a chunk may be short only at the end of a block, and the directory says where each block ends.
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
  - **Which copy is newer.** v2's header records the listing a read carries: a random id for the process that took it,
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
      (`ObjectSearchService.BigQuery.cs:396`) clears `StaleProjects` once the project's dataset list arrives and copies
      the mark into each dataset's `Stale` key. Those keys force whole reads and refuse saves and `Apply`. T-3
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
- **Touch rate.** Loading already marks the file used. v2 limits that to once a minute per file, and the index touches
  the files behind its cold parts once an hour, so another Varia process's sweep sees them as in use.
- **No migration, and no v3.** 0.10.0 has not shipped, and every lane ships in it, so the v1 reader is removed and
  nothing migrates (decision D7). Before T-1 merges, its format must hold everything later lanes read, so no later lane
  has to change it:
  - the independent Children and Definitions sections and the ownership map (T-3, T-5);
  - the split lookups (T-3);
  - the blocks and the footer directory (T-5);
  - the listing identity and digest (T-3);
  - room for T-7's per-block filters, as an optional directory field that T-1 writes empty.

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
  - **BigQuery's pass-1 saves wait for pass 2.** A dataset's pass-1 save stays in the queue until its pass 2 arrives,
    which replaces it under the same name, as the queue already does. On a large project pass 2 comes minutes later,
    under the rate limiter, so most datasets are then written once, not twice. A pass-1 save is written early, oldest
    first, when the queue needs room for a build, when the build stops, or when the connection closes. T-2's bench
    reports how many datasets were still written twice.
  - **Loads don't queue behind writes.** A part load or a cold scan reads on its own thread. Only writes go through
    the store's single writer, so an interactive load never waits behind a run of BigQuery saves.
  - T-2 benches thousands of small BigQuery datasets on Windows, with Defender on, and records saves per second
    before and after.
- **A unit larger than `limit / 2`**, even read alone, falls back to today's rules: definitions left out, then
  children, then `TOO_LARGE`. Its file records this.
- **The allowance is measured first.** T-1 measures the 300k-object bench database in memory before the allowance is
  fixed. A streaming builder, which would write a unit to disk as it reads it and so remove the `limit / 2` bound, is
  not planned unless a real database or dataset needs it (decision D4). The writer already streams the file from
  memory in one pass (File format v2).

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
  - v2 writes that same order. A check asserts the three ranges, and that neither sibling refers into the other's, so
    a cold part always attaches to a hot names table with matching numbers, whatever the other sibling's state.
  - `DatabaseIndex` keeps one pooled-reference array per tier.
- **What eviction frees.** A part's freeable bytes are everything it alone holds, and it is skipped only if that total
  is nothing:
  - its records (24 bytes per entry), its `ObjectDetails`, its `Pooled` slots (8 bytes per reference), and its column
    descriptions. Each tier's charge records these, so counting them takes no pool lock;
  - plus the texts whose last reference would go.

  A unit whose columns are all common names (`Id`, `Name`, `CreatedAt`) therefore still frees its entries and details.

  The text count is taken in bounded steps: the walk takes `StringPool.gate` for at most 4,096 references at a time,
  so builds acquiring texts on other units never wait long. Another build may take a reference between the count and
  the eviction, so the part may free less than counted. Eviction checks the budget afterwards and picks more
  victims, at most three rounds per request, then refuses as the budget does today. Two connections to one server share nearly every text, so eviction runs through a ledger held by the pool.
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
  - the bytes a part frees are computed when it is evicted, as above, since the pool counts references and not
    holders;
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
    - the names in it are the same keyed hashes the files already carry, so it says nothing more than the folder does.

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
  applies. Before evicting a hot part, eviction reads the salt in its file's clear prefix. It does this with the
  reservation, before any gate is taken, reusing a fresh file state: the salt from the unit's verified-write report,
  or the hourly touch. Bulk eviction after the limit is lowered does its salt reads on the background lane, never in
  front of a request. T-3's bench covers eviction across thousands of small units. If the file is gone, nothing is evicted. A fully hot unit is announced to
  the store again. A unit with other parts already cold has those parts marked not saved, so the deleted-cold-part rule
  reads the unit whole before any save, and no slimmed unit is ever saved. If the salt differs, the salt-mismatch rule applies. Either way, no process drops a part behind a file it
  doesn't match, and the deleted-cold-part rule covers a file deleted after the check. The confirmation speaks only for the process it was shown in.

### Searching cold parts

- **Hot first.** A search answers from memory first, with today's ranking, caps and 5 s budget, and returns at once.
- **Then cold parts.** Cold units' children and definitions sections, and cold units' names past the cap, are scanned
  next, one file at a time and below the store's writes. Each block is decrypted and unpacked into the search's
  `Scratch`.
  - The scan has its own deadline (decision D2) and Stop.
- **`explorer.search.more`** continues a search by its `explorer.search` request id and returns the next bounded batch,
  with progress. It is added in all five places, with string and size limits, a per-method deadline and the
  pending-request cap. Its lifetime is bounded:
  - one live search per connection per surface, in each window (the main window and each popout). A surface is a
    Search Objects tab, Ctrl+Q or Object Explorer's search box. Main enforces this by sender and the request's surface
    id, since no window id reaches the backend. Main caps live searches at 4 per connection per window, closing the
    oldest. Typing in Ctrl+Q therefore never closes a scan running in a Search Objects tab;
  - **the surface reaches the backend.** `explorer.search` gets a new `surface` parameter (`tab:<id>`, `quick`,
    `explorer`; at most 64 characters in zod and C#). Main prefixes it with the sender's window id, which the renderer
    can't set, and the backend keys live searches by connection and that prefixed surface;
  - **an explicit release.** Cancelling does nothing once `explorer.search` has answered, since `ProtocolHost` ignores
    a cancel for a finished id. So `explorer.search.close` (control lane, added in all five places) releases a live
    search, its held tables and its scratch. The backend also releases the old live search itself when a new
    `explorer.search` arrives for the same key;
  - a new search on that surface replaces the old one;
  - a search ends at the scan deadline, or 10 s after its last call returned, whichever comes first;
  - it is released on disconnect and when the backend is lost;
  - tables it held after eviction are given back when it ends.
- **Which surfaces scan the disk** (decision D15):
  - Search Objects tabs stream cold hits.
  - Ctrl+Q and Object Explorer's search box search hot names only, and they stay instant. When some units are on
    disk, a note says how many, with a link that opens the same search in a Search Objects tab.
- **Ranking.**
  - The On disk group has its own top-N cap, equal to the hot one, so a cold hit never displaces a hit already shown.
    `total` and `partial` still count every cold hit as it arrives, and each hit counts once.
  - The results add a group labelled **On disk** below the hot hits (decision D5). Under **All servers**, each server's
    group gets its own On disk subgroup, below that server's hot hits.
  - **Hits never move once the user has interacted.** Before the user has focused, selected or walked a hit, an exact
    name match found on disk goes to the top of the results. After that it goes to the top of its On disk group, and
    the status says an exact match was found on disk, with a link to it.
  - Focus, `keptHit` and the roving selection follow a hit's identity, never its position. The identity is the
    connection, the unit, the unit's read stamp and the entry, since entry numbers change when a re-read rebuilds the
    unit during a live search. Enter and the arrow keys keep walking from the hit the user is on as cold hits arrive.
- **A hot hit whose definition is cold** gets its match count and preview when the scan reaches it.
  - The backend tracks which hot hits it returned while their definitions were cold.
  - `explorer.search.more` batches carry patches keyed by each such hit's identity, with the match count and preview.
  - The renderer updates those rows in place. A patch never adds to `total`, since the hit was already counted.
  - A patch whose read stamp no longer matches the unit, because a re-read replaced it, is dropped.
- **Filters, if needed.** T-5's bench measures the scan two ways: over 2 GiB on disk, and over thousands of small
  units past the names cap, where opening each file and deriving its keys costs more than the bytes. If either is too
  slow, T-7 adds a filter in memory: a per-block trigram filter (about 1–2% of the text), and for cold names one digest
  per unit.

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
| K1 | A BigQuery dataset both due and DDL-marked counts twice in "N may have changed", as does a project mark plus a due dataset of that project | `ObjectSearchService.Freshness.cs:163` sums `Stale`, `StaleProjects` and `Due`; BigQuery's stale mark (`ObjectSearchService.BigQuery.cs:31`, `:88`) leaves the key in `Due` | Count distinct datasets, and remove from `Due` on a stale mark as SQL Server does (`Freshness.cs:68`) | G-1 |
| K2 | No check that object actions, Table Designer and Properties mark a database stale | They are covered only through the methods they call | A wiring check per entry point that fails if the call is removed | G-1 |
| K3 | A BigQuery DDL mark whose whole read failed waits for the next rebuild | `Freshness.cs:135` | Retry at the dataset's next check or due search | G-1 |
| K4 | A key store that refuses to decrypt looks like a reset one: a new key is made and the old files are swept | `src/main/search-index-key.ts`; Electron's `safeStorage` exposes no OS error code, and `secret-cipher.ts` maps every failure to one fixed message on purpose | A refused decrypt can't be told apart from a reset key store, so G-1 does not try. The new key is already sealed before the old file is quarantined. G-1 makes the reset visible instead: the index line and the Memory panel say the saved indexes were reset because the key store no longer opened the key, and object-search.md documents it, including that the quarantined key file can be restored by hand | G-1 |
| K5 | A queued resource-set save is not withdrawn when its set is dropped | `IndexStore` queue; the set is shared across connections (`ResourceCatalog`) | Withdraw it when the last connection releases the set | G-1 |
| K6 | The resource set's fingerprint and the statistics aggregates use `CHECKSUM_AGG(BINARY_CHECKSUM(...))` | `ObjectSearchSql.cs:266`, `:193` | Summed row hashes, as the database fingerprint uses | G-2 |
| K7 | Weak hashes: 32-bit row hashes are summed, and the listing's row checksum is `BINARY_CHECKSUM` | `ObjectSearchSql.cs:190`, `:225` | 64-bit row hashes summed as two 32-bit halves in bigint (safe below 2^31 rows). The object row hash takes in the per-object statistics checksum (`sk`), so the separate statistics aggregate goes. `ObjectTypes` has no `'TT'`, yet a table type's inline indexes have `sys.stats` rows (`auto_created = 0`) that the full read indexes, so `sk` must also cover table types' statistics (`TableTypeIds`), with a check against a table type with an inline index. The listing row can store the fingerprint's own row hash: 8 bytes instead of 4, rows of 28 bytes instead of 24, and the selective re-read fits the 32 MiB listing (`Extra`) limit up to about 1.2M rows (about 1.4M today). Bench the per-row SHA-256 cost on the 300k database | G-2 |
| K8 | A permission change (VIEW DEFINITION, a column grant, a role or group membership, a server permission) changes what the login sees without changing a `sys.objects` row | Permissions are not hashed. GRANT, REVOKE and DENY run from Varia are already marked (`TsqlChanges.cs:15`); changes made elsewhere are missed | A separate permissions hash in the sync, of the login's effective permissions and of ownership: `sys.fn_my_permissions(NULL, 'DATABASE')`, `sys.fn_my_permissions(NULL, 'SERVER')` where the server has a server scope (not Azure SQL Database), the login's role memberships read from the catalog (`sys.database_role_members`, followed recursively from `DATABASE_PRINCIPAL_ID()` through nested roles, plus `public`), the `sys.database_permissions` rows whose grantee is one of those principals (so an administrator is not made stale by grants to others), and `principal_id` of schemas and objects. The catalog reflects a role change on a pooled connection, which `sys.user_token` (fixed for a session, and it may survive a pooled reset) may not, so no unpooled connection is needed. A permissions mismatch reads the database whole, because the listing cannot say which definitions became visible. The new literals join `FingerprintLiterals` for the offline lint. A live check grants and revokes a role on a pooled connection. A Windows or Entra group change shows only once the login's token changes, at its next login, which is documented | G-2 |
| K9 | Adding the `microsoft_database_tools_support` extended property hides an object but changes no hashed row | `ObjectSearchSql.cs:124` joins `sys.extended_properties`, which is not hashed | Hash those property rows (class 1, that name) | G-2 |
| K10 | A selective re-read misses foreign keys and history tables whose visibility follows an object it re-reads | The fingerprint sees the referenced object change, but `SqlReloadPlan` re-reads only changed ids | Also re-read the keys and current tables that reference re-read objects. Memory can't say which: a key whose table was hidden was stored with `Referenced` -1 (`ObjectDetails.cs:149`). So the selective re-read asks the server, in one constant query on its own path: the foreign keys whose `referenced_object_id` is a re-read id (`sys.foreign_keys`), and the tables whose `history_table_id` is one (`sys.tables`). It adds them to `plan.Reread` | G-2 |
| K11 | Uncommitted DDL rolled back during a read is saved as verified | The read runs READ UNCOMMITTED and the fingerprints READ COMMITTED, so before and after match | Two parts, and an honest residue. **Objects:** the result sets the fingerprint aggregates (objects, named objects, types, triggers, plan guides, and statistics through `sk`) return the server-side `RowHash` of their rows (bumping `BatchShape` and `SqlSync.Version`), and the sync stores the fingerprint's raw aggregates beside its digest. The read is saved as verified only when the sums of its rows (the kept rows' stored hashes plus the re-read rows', for a selective read) equal the committed aggregates. C# never recomputes the server's hash. **Children and definitions:** the object hashes can't catch a dirty column, index, parameter or definition read after result set 1 and then rolled back (the objects still match). So the post-read check only, not the 15-minute fingerprint, also takes committed aggregates of what the read took: the count of `sys.columns`, `sys.indexes` and `sys.parameters` rows, and the count and sum of `DATALENGTH(definition)` of `sys.sql_modules`, over the ids it read. It compares them with the read's own counts and lengths. A read with children left out compares only the objects and definitions, and one with definitions left out only the objects and children. **Residue, documented:** an uncommitted change that is rolled back and keeps every count and length (a same-length edit to a procedure, a column's type changed in place) can still be saved, until the next fingerprint reads the committed state. G-2 benches the extra aggregates on the 300k database | G-2 |
| K12 | `SET CONTAINMENT = PARTIAL` changes the catalog collation without changing the identity | The identity lacks containment (a contained database's catalog collation is fixed) | Add `containment` to the identity | G-2 |
| K13 | DDL that names another database (`OtherDb.dbo.Object`), or runs after an intermediate `USE`, is missed until a due search | `SqlService.cs:650` marks only the databases a script started and ended in, and marks nothing for server-level DDL | Also mark the databases of three-part names and of every `USE` target. Server-level DDL (`CREATE`, `ALTER` or `DROP DATABASE`, logins, server roles, endpoints, linked servers, server triggers, Agent jobs) marks the server's own objects unit through `MarkSqlStale(connectionId, null)`, which already exists but has no caller from query tabs. Database DDL also makes the next check list the databases again (`Listed`), so a created database is read and a dropped one is dropped | G-3 |
| K14 | Ctrl+Shift+R (Refresh Local Cache) rebuilds only SQL Tools' cache; on a BigQuery tab it fails with "The query is unavailable for SQL language support." | `contributions/languages.ts:26`, `SqlLanguageService.ts:236`, `:438` | SQL Server: also check the tab's database in the index (fingerprint, selective re-read). BigQuery: clear the renderer's lookup cache, re-list the datasets the statement names, and get the details (`tables.get`, `routines.get`, through `TableRead` and `RoutineRead`) of the objects the statement names, at most 20, so an in-place `ALTER TABLE ADD COLUMN` or a patched view shows when the refresh finishes. G-3 lands against today's synchronous `Apply`. Once T-3 makes `Apply` a background job, the refresh waits for its own jobs, which go ahead of other queued ones, for at most 15 s; during a build they wait as any `Apply` job does. It clears the lookup cache only once they have landed, so no completion caches the old answer meanwhile, and the status says so if the wait ran out. All of these are free metadata calls under the principal's limiter. Re-listing alone would miss them, since an in-place change keeps the creation time. The scope is stated: the statement at the caret, parsed as completion and hover parse it (`readGoogleSqlCompletion`, `readGoogleSqlHover`), not the whole document. It uses BigQuery's own wording (decision D8) | G-3 |
| K15 | SQL Server 2016–2022 and low-privilege logins are not tested live | Only SQL Server 2025 as an administrator, over `lpc:.` | Live suites on 2017, 2019 and 2022 containers, run inside WSL with `test:smoke:wsl`'s toolchain (this machine's shell reaches SQL Server only through shared memory), and a low-privilege login fixture (db_datareader, no VIEW DEFINITION). 2016 has no Linux image (decision D9) | G-4 |
| K16 | `scripts/offline-stress.mjs` cannot finish within its 300 s default | The offline suite grew | Set the default from a measured run (at least 1,500 s), or split the suite so each copy fits | G-5 |
| K17 | The "not verified" freshness state has no screenshot, and the Windows explorer smoke's clipboard step has not run with the screen unlocked | The state needs a fingerprint check that fails or is denied | A capture hook that makes the check fail, and a rerun with the screen unlocked | G-5 |
| K18 | The v1 file code's known weak points: the order in which a file is replaced, slot accounting, the reserve for unnamed texts, the children fallback when a dataset already has details, the `File.Replace` window on Windows, padding bytes that are not checked to be zero, a pool reference that leaks on out-of-memory, and error mapping | File format v1 | v2 replaces that code; T-1 checks each point in the new code | T-1 |
| K19 | The one-step-lower BigQuery floor applies to new objects too, and a resource set may be read again on each rebuild | The budget floors and the resource catalog | Fixed in T-3, which replaces the floors with the cache wherever a store saves. Without a key store, or with saving off, there is no cache to evict to, so today's floors stay and only the new-object fix applies | T-3 |
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
independent of each other and of tiering, and can start at once, beside T-1. T-1 to T-6 are stacked, one PR each, each
in its own session. Every lane gets adversarial review rounds until one finds nothing above low. UI changes come
with screenshots for the owner, and T-5 and T-6 update a mock first.

| Lane | Scope | Depends on | State |
| --- | --- | --- | --- |
| G-1 | Freshness and store fixes: K1–K5 | — | Proposed |
| G-2 | Fingerprint hardening: K6–K12 and K20, with live checks on 2025, and the fingerprint's and K11's post-read aggregates' cost benched on the 300k database | — | Proposed |
| G-3 | Editor and scripts: K13, K14 | — | Proposed |
| G-4 | Live version matrix: K15 (2017, 2019 and 2022 containers, the low-privilege fixture, how to run it) | G-2 | Proposed |
| G-5 | Test tooling: K16, K17 | — | Proposed |
| T-1 | File format v2, final for the release: sections, the sibling Children and Definitions sections with their text ranges and the ownership map, the footer directory and trailer, single-pass streaming writes, per-section streams, blocks on chunk boundaries, the listing identity and digest in the header, salt checks, part loads, the touch rate, and an empty field for T-7's filters. Its review checks the format against T-3's and T-5's sections. Bench a names-only load, a single-section load and bytes per object; measure the 300k database in memory for D4, and the names tier on it and on fake BigQuery projects (one large dataset, thousands of small ones) for D1; K18 | — | Proposed |
| T-2 | Building inside the limit: everything charged (listing, scratch, queued writes), the build allowance with its floor, the interactive reserve, one large unit read alone (abandoned mid-read, a borrow bounded by what can be freed, the queue admitting it), builds waiting only between units, due marks only once room has grown, the write-queue bound, writes without a device flush (D14), pass 1 and pass 2 written once, loads off the writer thread, verified writes and the store's reports, complete units saved whatever the cache holds, "on disk" told apart from "left out". Bench saves per second over thousands of small datasets on Windows | T-1 | Proposed |
| T-3 | The cache: tiers as siblings, split lookups, stubs in `BigQueryLookup`, the names cap, per-tier references and freeable bytes counted in bounded steps, eviction in place, recency, lowering the limit evicts, parts loaded on demand with the stamp check, merges and `Apply` that load every cold part first (`Apply` off the `bigquery.properties` response, in a bounded queue that waits out builds, with K14's refresh waiting on its own jobs), the check that no rebuild runs from a partial unit (not-saved parts counted as missing), whole reads when parts can't all be made hot, with the needed room recorded, the slotless `Lookup` lane and the renderer's separate waiting counter, timed-out waits answering `loading`, the eviction bench over thousands of small units, Clear and epoch handling, ties adopted on a matching digest, BigQuery completion while loading, floors folded into the cache, whole-project marks (D13); K19 | T-2 | Proposed |
| T-4 | BigQuery reload by tier: every saved dataset's names at connect under the cap, children when used, pass 2 sharing the allowance | T-3 | Proposed |
| T-5 | Cold search: `explorer.search.more`, `explorer.search.close` and `explorer.search`'s new `surface` parameter, the search lifetime per surface, the On disk group's own cap, hit identity with the read stamp, ranking and caps, the On disk group and its All servers subgroups, hits that never move and selection by identity, patches for hot hits with cold definitions, Ctrl+Q and the explorer box on hot names with their note (D15), the scan of names past the cap, children and definitions (definitions resolved through the ownership map), status, Stop and cancel, the 2 GiB bench, the results mock | T-3 | Proposed |
| T-6 | The sweep with the cold set, the disk as a use-driven cache (files unused for 10 minutes, the per-process use journals, the deleted-cold-part rule with no background re-read), refused saves measured by net growth and deleting only a superseded file they would have won against, the Memory panel's memory and disk lines, Options wording, docs, CHANGELOG, guide impact, screenshots | T-4, T-5 | Proposed |
| T-7 | A per-block trigram filter for the cold scan, only if T-5's bench says it is too slow. It fills the directory field T-1 left empty, so the format does not change | T-5 | Proposed |

## Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Object names (not columns) always in memory, with SQL Server's listing and BigQuery's listing facts, capped at half the limit across all connections by recency, and units past the cap searched on disk? | Yes. Top-level names and listings are a small part of an index, and instant object search is the feature. Columns go with children so the names tier stays small. T-1 measures the names tier's bytes per object on the 300k SQL Server database and on fake BigQuery projects, one large dataset and thousands of small ones, with pass-2 details filled in (their facts now sit in names), before the cap is fixed |
| D2 | Cold names, children and definitions searched on disk, with hits streaming in under their own deadline (30 s by default, with Stop)? | Yes. Keeping all definitions in memory would leave little to tier |
| D3 | The disk limit stays hard, and the disk works as a cache driven by use: once disconnected sources' files are gone, a save may push out a connected source's file unused for 10 minutes. Use is real use (loads, hits, lookups), recorded across processes in use journals, never the hourly touch. Those parts are left out for disk space and read again only when used, never by a background build, as is any part whose file another process removed. A refused save deletes its unit's superseded file only when it would have won against it, and the limit counts net growth? | Yes. The disk never wedges at full, a stale file is never left to load, a newer file is never deleted, and churn follows use, so there is no loop. Keep 2 GiB until T-1 gives bytes per object, then revisit in T-6 |
| D4 | A build allowance of `min(limit / 4, 256 MiB)` inside the limit, never below 24 MiB, with an interactive reserve of `min(32 MiB, limit / 8)` that builds can't use, a unit that outgrows its share read alone with up to `limit / 2`, and no streaming builder? | Yes, if T-1's measurement of the 300k database fits; otherwise revisit before T-2. The floor keeps the 64 MiB minimum usable, and reading a large unit alone stops two large databases from cutting each other's children |
| D5 | Hits found on disk shown as an **On disk** group below the hot hits (a subgroup per server under All servers), rather than merged into one list, with an exact name match moved to the top only before the user has focused or walked a hit? | Yes. Hits already shown never move, and selection follows a hit's identity, so arrow keys and Enter stay where the user is |
| D6 | Clear Saved Search Indexes (and a new key, or saving turned off) starts over: units that had parts on disk are dropped and rebuilt as on a first connect, costing a first build's BigQuery calls, with the dialog saying so? | Yes. Clear is rare and deliberate, and a cheaper names-only re-read would need a third kind of partial unit that reload, the background re-read and freshness checks would all have to learn. Someone who wants to avoid the calls can leave saving on and not clear |
| D7 | v2 is the only format 0.10.0 ships, with T-1 holding everything T-3, T-5 and T-7 read (sibling sections, ownership map, split lookups, footer directory, blocks, listing identity and digest, an empty filter field), so no v3 follows? | Yes. Freezing v2 before its readers are designed was the risk; T-1's review against T-3's and T-5's sections removes it, and since all of it ships at once, no format is ever swept |
| D8 | Ctrl+Shift+R also checks the index (SQL Server: fingerprint and selective re-read; BigQuery: clears the lookup cache, re-lists the datasets the statement at the caret names, and gets the details of up to 20 objects it names)? | Yes. It costs a one-row query or free metadata calls, and it is what a refresh is expected to do, including in-place changes a listing can't see |
| D9 | SQL Server 2016: test it on your machine, or accept it as untested beside containers for 2017–2022? | Containers for 2017–2022 now, and 2016 once on your machine before release |
| D10 | **Index memory limit** keeps its name and 512 MiB default, meaning the ceiling for the cache and builds? Its 64 MiB minimum stays, with no interactive reserve below 128 MiB and a description warning that a low limit keeps few names in memory? | Yes, with its description saying the rest stays on disk. Raising the minimum to 128 MiB would be simpler, but would reject settings users may already have |
| D11 | K8's permission hash on Azure SQL Database: database scope only (it has no server scope), checked live once against an Azure SQL Database you provide? | Yes. Until then, Azure SQL Database is documented as checked at database scope only |
| D12 | Every lane, G-1 to G-5 and T-1 to T-7, ships in 0.10.0, and the release waits for the last one? | Yes, as you asked, so 0.10.0 is one whole change. T-7 is the only lane that may turn out empty, if T-5's bench finds the scan fast enough |
| D13 | A BigQuery whole-project DDL mark (DDL whose targets are unknown) stops deleting the project's files and reading every dataset whole, and checks each dataset by its listing instead, leaving in-place changes to the background re-read's normal pace? | Yes. Today one unresolved script costs a whole project's details calls, which on your project means hundreds of thousands. The cost is that an in-place change made by such a script shows up later. It stays in T-3 rather than a G lane: it relies on the newer-listing rule and re-list marks T-3 adds, and since everything ships in 0.10.0, pulling it forward would only mean building it twice, once on v1 |
| D14 | Index files written without a device flush (`flushToDisk: false`), through a temp file and an atomic rename, with BigQuery's pass-1 save held in the queue until pass 2 replaces it? | Yes. The files are an authenticated cache that can be rebuilt: a process crash loses nothing, and after a power loss a damaged file is swept and read once. T-2 records the measured gain and how many datasets were still written twice; the expected order is ten times or more on thousands of small datasets |
| D15 | Ctrl+Q and Object Explorer's search box search hot names only, with a note and a link to Search Objects when units are on disk; only Search Objects tabs scan the disk? | Yes. Those two surfaces must stay instant, and a scan there would compete with the one in a Search Objects tab |
