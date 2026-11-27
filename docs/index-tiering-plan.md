# Search index tiering plan

Status: **proposed on 2026-11-27, not yet agreed with the owner.** The open questions are in [Decisions for the
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
- **Without a key store, or with saving off, nothing changes.** Memory is the whole index, as today.
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
  names. Its answers carry a `State` (ready, partial, building, skipped, absent). `src/shared/completion/lookup-cache.ts`
  keeps an answer for 15 s when the index is ready and the answer is neither `building` nor cut short below its limit,
  so `partial`, `skipped` and `absent` answers are kept. It reuses an answer for longer prefixes unless it was
  truncated.
- **Freshness.** These read held data:
  - the checks and due marks iterate the held units and their sync;
  - BigQuery's in-place refresh (`Apply`, used by Properties, Peek, the details pane and the 4 h re-read) compares a
    held dataset's columns and definitions;
  - a BigQuery DDL mark deletes the dataset's file at once (`Sink.Stale`), for every connection of the principal. A
    SQL Server mark leaves the file alone, and a BigQuery whole-project mark (DDL whose targets are unknown) marks
    every dataset of the project.
- **Files.**
  - **Layout:** one file per unit, readable only whole and in order: a 52-byte clear prefix holding a random per-file
    salt, a sealed header, then AES-256-GCM chunks of 256 KiB with zstd per 1 MiB block. Only the header can be read
    alone.
  - **Writes:** whole-file through a temp file and rename, one at a time on a background thread. Putting a read into
    the index (`Sink.Held`) queues its save. Saving never waits on anything else.
  - **Loads:** a load already marks its file used.
  - **Sweep:** works from the files' metadata and modified times only.
  - **Limits:** 4 GiB per file and 2^25 objects per unit.
- **Sharing.** All connections of one principal share the same files, and several Varia processes may share the folder.

## Design

### Tiers

| Tier | Holds | In memory |
| --- | --- | --- |
| Names | Every entry except the detail children: tables, views, routines, types, and the keys, constraints and DML triggers that `CHILDREN_LEFT_OUT` keeps today; their names and schemas, the sync, and what the freshness checks compare: SQL Server's catalog listing and BigQuery's object facts (split under File format v2) | For every unit of a connected source, up to the names cap |
| Children | The detail children (`IndexFileUnit.DetailChild`: columns, indexes, statistics, parameters, BigQuery columns), the same set `CHILDREN_LEFT_OUT` leaves out today, `ObjectDetails`, BigQuery's column descriptions, lookup arrays | Loaded per unit when used; least recently used dropped |
| Definitions | Module, view and routine text | Kept while there is room; otherwise cold on disk and searched there |

- **Every unit keeps a stub.** Every unit, hot or cold, keeps a stub in memory: its key, sync, read time, freshness
  marks and listing digest, a few hundred bytes. The stubs are charged inside the limit but outside the names cap. The
  15-minute and 1-hour checks, due marks and counts work on stubs and names, so they never load cold parts. A check that
  finds a cold-whole unit changed loads that unit's names, then re-reads it as today.
- **Work that needs a cold part loads it first, inside the build allowance, one unit at a time:**
  - a merge: a selective re-read (SQL Server) or a changed listing (BigQuery) loads the unit's cold children and
    definitions;
  - BigQuery's in-place refresh (`Apply`): Properties, Peek and the details pane load the dataset's children first. The
    4 h background re-read loads a cold dataset's children only when that dataset is due. It already makes at most
    1,800 calls an hour, so the loads are few.
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

- **Sections.** The file has three sections: names, children and definitions. A sealed directory after the header gives
  each section's offset, length and plain size.
  - BigQuery's facts are split by tier (the one statement of the split), matching what a read without children keeps
    today:
    - names section: each object's `BigQueryObjectFacts` (created, listed, detailed, stale, shards, whole, columns cut,
      text left out, rows, bytes, partitioning, clustering, and a routine's signature, which object-list completion
      shows);
    - children section: column descriptions, and the column entries with their types.
  - A names-only load reads the header, the directory and the names section.
- **Separate streams.** Each section is its own GCM chunk stream, with the section's index in the nonce and the AAD, so
  one section can be read without decrypting the others.
- **Blocks.** Children and definitions are split into blocks of about 1 MiB of text. For each block the directory gives
  the first entry, the byte offset and the first chunk index. A scan can then skip blocks and resume, and still check
  each chunk's nonce and the stream's end.
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
      - **Refused for disk space.** Reported separately. The unit leaves the write queue and is held as parts with no
        file, outside the queue's bound, so builds never wait on it. It makes no due mark, and is tried again when
        space frees.
      - **The file in place is newer** (a save refused as older, an older copy the index ignores, or a wall clock
        stepped back). The index adopts that file: it swaps its copy to it, as for any newer save. If the swap does not
        fit, the copy drops to its stub (names past the cap, as above) and is adopted when room frees. A copy that a
        newer file supersedes counts as backed by that file, so dropping it is allowed. If the sweep deletes that file
        first, the deleted-cold-part rule applies, and the unit is read again from the server.
      - **The file in place is older** (another process's rename overwrote this copy's verified file). This is handled
        as a tie, below. The re-listing's save is newer, so it wins.
      - **A tie.** The file in place stays, and the index's own copy is not saved:
        - the index marks its own cold parts of that unit not saved, since their file is gone;
        - it schedules a re-listing of that unit on the background lane, after a random delay of up to a minute, so
          two processes do not tie again;
        - the re-listing compares listing digests first, and adopts the file in place if they match;
        - otherwise it reads every part marked not saved again from the server before saving, so it never saves a
          slimmed unit over a complete file, and its save wins with a new listing;
        - the re-listing is tried at most three times, for repeated ties within 2 s. After that, the unit's next 15-minute or 1-hour check takes a new listing and saves it, even when the
          fingerprint matches, so no unit stays unsaved and stuck in memory. If that save ties again, a new cycle of three starts;
        - none of this is counted in "may have changed".

      A read whose listing predates a DDL is therefore never taken as newer than one that follows it.
    - **Accepted:** `Apply`'s fresher columns can lose to another process's later listing that found nothing changed.
      They come back at the next in-place refresh, the rule D13 already accepts for in-place changes.
- **Touch rate.** Loading already marks the file used. v2 limits that to once a minute per file, and the index touches
  the files behind its cold parts once an hour, so another Varia process's sweep sees them as in use.
- **No migration.** 0.10.0 has not shipped. If v2 lands before the release, the v1 reader is removed and nothing
  migrates (decision D7). Landing after the release would mean v1 files fail to open, are swept, and are read once from
  the server.

### Building inside the limit

- **The build allowance.** A build charges what it reads to the same budget, evicting cold parts to make room. It has a
  working allowance of up to `min(limit / 4, 256 MiB)`, shared by all reads in flight. For BigQuery's pass 2 the
  datasets read at once share it, and only their merges run one at a time.
- **Order.** The reader builds the unit, and its names are admitted at once, so a new unit is searchable straight
  away. The store writes it; saving still waits on nothing. Once the write is verified, children and definitions stay
  in memory if there is room. Otherwise they are released as cold.
- **The write queue is bounded.** A finished unit waiting for its write keeps its charge, and builds in flight plus
  queued units stay within one allowance, with the two exceptions the admission rule names.
- **A unit larger than the allowance** falls back to today's rules: definitions left out, then children, then
  `TOO_LARGE`. Its file records this.
- **The allowance is measured first.** T-1 measures the 300k-object bench database in memory before the allowance is
  fixed. A streaming writer, which would remove the limit, is not planned unless a real database or dataset needs it
  (decision D4).

### Evicting and loading parts

- **Stable indices.** Today entries are interleaved: children follow their parents, and keys and triggers fall between
  tables in object_id order. Text ids are handed out in insertion order and shared across tiers, since a column named
  like a table shares that table's name id.
  - `Builder.Build` does a stable partition, putting names-tier entries first and detail children after them, and remaps `Owner`, details, dates,
    BigQuery facts and `BuiltAt` (the listing's `Entry`).
  - Texts are numbered by the lowest tier that uses them, so names-tier texts are a prefix. A higher tier may point down
    to them, and evicting it frees only ids above the prefix.
  - Each text's tier comes from a classifier per tier, not from `NameTexts()`. That method counts the type names in
    `ObjectDetails` as names, but they belong to the children tier.
  - A child entry's definition (a computed column, a constraint's expression) belongs to the definitions tier.
  - v2 writes that same order. A check asserts both prefixes, so a cold part always attaches to a hot names table with
    matching numbers.
  - `DatabaseIndex` keeps one pooled-reference array per tier.
- **What eviction frees.** Eviction counts only texts whose last reference would go, and skips a part that frees
  nothing. Two connections to one server share nearly every text, so eviction runs through a ledger held by the pool.
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
  - the bytes a part frees are computed when it is evicted, by walking its references under the pool lock, since the
    pool counts references and not holders;
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
  - A load that fails (a damaged file, another key, a refused salt) marks the part not saved, and the unit's next check
    or build reads it from the server.
- **Completion.**
  - BigQuery's `language.lookup` starts loading a cold dataset's part and stamps recency.
  - Until the part attaches it answers with a new `loading` state. The renderer never caches or reuses `loading`
    (`lookup-cache.ts`), and the list is marked incomplete when an answer's state is `loading` (in `complete.ts` for object lists,
    `resolve.ts` for column answers, and `IndexCompletionService`, which sets the flag), so Monaco asks again as you type and the
    columns appear once loaded.
  - Hover and Go To Definition have no retry, so their lookups send a new `wait` flag (added to the contract, zod and C# with `loading`) and
    wait for the load for at most 8 s, or the request's remaining deadline less a margin if that is shorter (the
    10 s deadline includes waiting for a metadata slot). After that it answers `loading` or `partial`. A waited answer is cached under today's rules.
    - Waiting lookups have their own in-flight cap of one, outside completion's, so a hover never makes completion
      fall back to keywords.
    - A waiting lookup does not hold a metadata slot while it waits for the load, so waiting hovers on many
      connections cannot leave Object Explorer `BUSY`.
      - Today `ProtocolHost` takes the slot before dispatch and releases it in `finally`. T-3 gives the request context
        a slot handle that the dispatcher can release and take again, guarded against releasing twice.
      - If the slot cannot be taken again within the remaining deadline, the lookup answers `loading` or `partial`
        without it, never `BUSY` or `TIMEOUT`.
      - Waiters stay bounded: one per connection, at most 8 s each, under the pending-request cap.
    - The cap of one is per connection in the backend, so each popout's renderer shares it. A second waiting request
      while one waits does not wait: it gets today's answer, `loading` or `partial`, rather than an error. The renderer
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
- **The sweep order.** The sweep deletes disconnected sources' files first, least recently used first, then cold-part
  files if it must (decision D3). A file touched within the hour counts as connected in its first pass, so one
  process's sweep spares the files another process is using. A deleted cold part falls back to today's rules: re-read and held if it fits, otherwise
  left out, with the index line saying so.
- **No delete-and-save loop.** A save that would push out a connected source's cold file is not made. The unit stays in
  memory, or its children and definitions are left out, until the space is there. A save, and so a sweep, never pushes
  out another connected source's file in a loop.

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
  reads them again before any save, and no slimmed unit is ever saved. If the salt differs, the salt-mismatch rule applies. Either way, no process drops a part behind a file it
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
  - one live search per connection per window (the main window and each popout). Main enforces this by sender, since
    no window id reaches the backend, and cancels the old request id;
  - a new search in that window cancels the old one;
  - a search ends at the scan deadline, or 10 s after its last call returned, whichever comes first;
  - it is released on disconnect and when the backend is lost;
  - tables it held after eviction are given back when it ends.
- **Ranking.**
  - Cold hits count under the same top-N cap and candidate cap, and `total` and `partial` include them as they arrive.
  - The results add a group labelled **On disk** below the hot hits (decision D5).
  - An exact name match found on disk is moved to the top of the results, since it is the hit the user most likely
    wants.
- **A hot hit whose definition is cold** gets its match count and preview when the scan reaches it.
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
| K4 | A key store that refuses to decrypt looks like a reset one: a new key is made and the old files are swept | `src/main/search-index-key.ts` | Tell a refused decrypt apart where the OS reports it, keep the files and say so; otherwise document it | G-1 |
| K5 | A queued resource-set save is not withdrawn when its set is dropped | `IndexStore` queue; the set is shared across connections (`ResourceCatalog`) | Withdraw it when the last connection releases the set | G-1 |
| K6 | The resource set's fingerprint and the statistics aggregates use `CHECKSUM_AGG(BINARY_CHECKSUM(...))` | `ObjectSearchSql.cs:266`, `:193` | Summed row hashes, as the database fingerprint uses | G-2 |
| K7 | Weak hashes: 32-bit row hashes are summed, and the listing's row checksum is `BINARY_CHECKSUM` | `ObjectSearchSql.cs:190`, `:225` | 64-bit row hashes summed as two 32-bit halves in bigint (safe below 2^31 rows). The object row hash takes in the per-object statistics checksum (`sk`), so the separate statistics aggregate goes (after checking that `sk`'s object filter covers every statistic that aggregate counted) and the listing row can store the fingerprint's own row hash: 8 bytes instead of 4, rows of 28 bytes instead of 24, and the selective re-read fits the 32 MiB listing (`Extra`) limit up to about 1.2M rows (about 1.4M today). Bench the per-row SHA-256 cost on the 300k database | G-2 |
| K8 | A permission change (VIEW DEFINITION, a column grant, a role or group membership, a server permission) changes what the login sees without changing a `sys.objects` row | Permissions are not hashed. GRANT, REVOKE and DENY run from Varia are already marked (`TsqlChanges.cs:15`); changes made elsewhere are missed | A separate permissions hash in the sync, of the login's effective permissions and of ownership: `sys.fn_my_permissions(NULL, 'DATABASE')`, `sys.fn_my_permissions(NULL, 'SERVER')` where the server has a server scope (not Azure SQL Database), the `sys.database_permissions` rows whose grantee is in `sys.user_token` (so an administrator is not made stale by grants to others), and `principal_id` of schemas and objects. A permissions mismatch reads the database whole, because the listing cannot say which definitions became visible; a grant to any role in the login's token does so too. The new literals join `FingerprintLiterals` for the offline lint. `sys.user_token` is fixed for a session and may survive a pooled reset, so G-2 checks live whether a role membership change is seen on a pooled connection. If it is not, the fingerprint uses a connection that is not pooled. A Windows group change shows only once the login's token changes, which is documented | G-2 |
| K9 | Adding the `microsoft_database_tools_support` extended property hides an object but changes no hashed row | `ObjectSearchSql.cs:124` joins `sys.extended_properties`, which is not hashed | Hash those property rows (class 1, that name) | G-2 |
| K10 | A selective re-read misses foreign keys and history tables whose visibility follows an object it re-reads | The fingerprint sees the referenced object change, but `SqlReloadPlan` re-reads only changed ids | Also re-read the keys and current tables that reference re-read objects | G-2 |
| K11 | Uncommitted DDL rolled back during a read is saved as verified | The read runs READ UNCOMMITTED and the fingerprints READ COMMITTED, so before and after match | The result sets the fingerprint aggregates (objects, named objects, types, triggers, plan guides, and statistics through `sk`) return the server-side `RowHash` of their rows; columns, indexes, parameters and definitions do not (bumping `BatchShape` and `SqlSync.Version`), and the sync stores the fingerprint's raw aggregates beside its digest. The read is saved as verified only when the sums of its rows (the kept rows' stored hashes plus the re-read rows', for a selective read) equal the committed aggregates. A read with children left out compares the object aggregates only. C# never recomputes the server's hash | G-2 |
| K12 | `SET CONTAINMENT = PARTIAL` changes the catalog collation without changing the identity | The identity lacks containment (a contained database's catalog collation is fixed) | Add `containment` to the identity | G-2 |
| K13 | DDL that names another database (`OtherDb.dbo.Object`), or runs after an intermediate `USE`, is missed until a due search | `SqlService.cs:650` marks only the databases a script started and ended in | Also mark the databases of three-part names and of every `USE` target | G-3 |
| K14 | Ctrl+Shift+R (Refresh Local Cache) rebuilds only SQL Tools' cache; on a BigQuery tab it fails with "The query is unavailable for SQL language support." | `contributions/languages.ts:26`, `SqlLanguageService.ts:236`, `:438` | SQL Server: also check the tab's database in the index (fingerprint, selective re-read). BigQuery: re-list the datasets the query names (free calls), with BigQuery's own wording (decision D8) | G-3 |
| K15 | SQL Server 2016–2022 and low-privilege logins are not tested live | Only SQL Server 2025 as an administrator, over `lpc:.` | Live suites on 2017, 2019 and 2022 containers, run inside WSL with `test:smoke:wsl`'s toolchain (this machine's shell reaches SQL Server only through shared memory), and a low-privilege login fixture (db_datareader, no VIEW DEFINITION). 2016 has no Linux image (decision D9) | G-4 |
| K16 | `scripts/offline-stress.mjs` cannot finish within its 300 s default | The offline suite grew | Set the default from a measured run (at least 1,500 s), or split the suite so each copy fits | G-5 |
| K17 | The "not verified" freshness state has no screenshot, and the Windows explorer smoke's clipboard step has not run with the screen unlocked | The state needs a fingerprint check that fails or is denied | A capture hook that makes the check fail, and a rerun with the screen unlocked | G-5 |
| K18 | The v1 file code's known weak points: the order in which a file is replaced, slot accounting, the reserve for unnamed texts, the children fallback when a dataset already has details, the `File.Replace` window on Windows, padding bytes that are not checked to be zero, a pool reference that leaks on out-of-memory, and error mapping | File format v1 | v2 replaces that code; T-1 checks each point in the new code | T-1 |
| K19 | The one-step-lower BigQuery floor applies to new objects too, and a resource set may be read again on each rebuild | The budget floors and the resource catalog | Fixed in T-3, which replaces the floors with the cache | T-3 |

Kept as they are:

- **BigQuery in-place changes** stay stale until Refresh, Properties, Peek or the background re-read.
- **A re-created BigQuery table** shows its earlier columns between pass 1 and pass 2, by design
  ([object-search.md](object-search.md#bigquery)).
- **Two servers that report the same name to the same login share files.** The fingerprint stops one standing in for
  the other.
- **The server's own objects and Agent** are read again on every connect. Each is one cheap read.

## Lanes

The G lanes are independent of each other and of tiering, and can start at once. T-1 to T-6 are stacked, one PR each,
each in its own session. Every lane gets adversarial review rounds until one finds nothing above low. UI changes come
with screenshots for the owner, and T-5 and T-6 update a mock first.

| Lane | Scope | Depends on | State |
| --- | --- | --- | --- |
| G-1 | Freshness and store fixes: K1–K5 | — | Proposed |
| G-2 | Fingerprint hardening: K6–K12, with live checks on 2025 and the fingerprint's cost benched on the 300k database | — | Proposed |
| G-3 | Editor and scripts: K13, K14 | — | Proposed |
| G-4 | Live version matrix: K15 (2017, 2019 and 2022 containers, the low-privilege fixture, how to run it) | G-2 | Proposed |
| G-5 | Test tooling: K16, K17 | — | Proposed |
| T-1 | File format v2: sections, the directory, per-section streams, blocks, salt checks, part loads, the touch rate. Bench a names-only load, a single-section load and bytes per object; measure the 300k database in memory for D4, and the names tier on it and on fake BigQuery projects (one large dataset, thousands of small ones) for D1; K18 | — | Proposed |
| T-2 | Building inside the limit: everything charged (listing, scratch, queued writes), the build allowance, the write-queue bound, verified writes and the store's reports, complete units saved whatever the cache holds, "on disk" told apart from "left out" | T-1 | Proposed |
| T-3 | The cache: tiers, the names cap, per-tier references and freeable bytes, eviction in place, recency, lowering the limit evicts, parts loaded on demand with the stamp check, merges that load cold parts, the eviction bench over thousands of small units, Clear and epoch handling, BigQuery completion while loading, floors folded into the cache; K19 | T-2 | Proposed |
| T-4 | BigQuery reload by tier: every saved dataset's names at connect under the cap, children when used, pass 2 sharing the allowance | T-3 | Proposed |
| T-5 | Cold search: `explorer.search.more` and its lifetime, ranking and caps, the On disk group, the scan of names past the cap, children and definitions, status, Stop and cancel, the 2 GiB bench, the results mock | T-3 | Proposed |
| T-6 | The sweep with the cold set and no delete-and-save loop, the Memory panel's memory and disk lines, Options wording, docs, CHANGELOG, guide impact, screenshots | T-4, T-5 | Proposed |
| T-7 | A per-block trigram filter for the cold scan, only if T-5's bench says it is too slow | T-5 | Proposed |

## Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Object names (not columns) always in memory, with SQL Server's listing and BigQuery's listing facts, capped at half the limit across all connections by recency, and units past the cap searched on disk? | Yes. Top-level names and listings are a small part of an index, and instant object search is the feature. Columns go with children so the names tier stays small. T-1 measures the names tier's bytes per object on the 300k SQL Server database and on fake BigQuery projects, one large dataset and thousands of small ones, with pass-2 details filled in (their facts now sit in names), before the cap is fixed |
| D2 | Cold names, children and definitions searched on disk, with hits streaming in under their own deadline (30 s by default, with Stop)? | Yes. Keeping all definitions in memory would leave little to tier |
| D3 | The disk limit stays hard, so the sweep may delete files behind cold parts once disconnected sources' files are gone (those parts are then read again from the server, and nothing is saved that would push out another connected source's file)? | Yes. Keep 2 GiB until T-1 gives bytes per object, then revisit in T-6 |
| D4 | A build allowance of `min(limit / 4, 256 MiB)` inside the limit, with no streaming writer? | Yes, if T-1's measurement of the 300k database fits; otherwise revisit before T-2 |
| D5 | Hits found on disk shown as an **On disk** group below the hot hits (an exact name match moved to the top), rather than merged into one list? | Yes. Hits already shown don't move as the scan runs |
| D6 | Clear Saved Search Indexes (and a new key, or saving turned off) starts over: units that had parts on disk are dropped and rebuilt as on a first connect, costing a first build's BigQuery calls, with the dialog saying so? | Yes. Clear is rare and deliberate, and a cheaper names-only re-read would need a third kind of partial unit that reload, the background re-read and freshness checks would all have to learn. Someone who wants to avoid the calls can leave saving on and not clear |
| D7 | Land T-1 (format v2) before 0.10.0 ships, so v1 never reaches users? | Yes if 0.10.0 can wait for it; otherwise ship v1 and let v2 sweep v1 files once |
| D8 | Ctrl+Shift+R also checks the index (SQL Server fingerprint and selective re-read; BigQuery re-lists the datasets the query names)? | Yes. It costs a one-row query or free listing calls, and it is what a refresh is expected to do |
| D9 | SQL Server 2016: test it on your machine, or accept it as untested beside containers for 2017–2022? | Containers for 2017–2022 now, and 2016 once on your machine before release |
| D10 | **Index memory limit** keeps its name and 512 MiB default, meaning the ceiling for the cache and builds? | Yes, with its description saying the rest stays on disk |
| D11 | K8's permission hash on Azure SQL Database: database scope only (it has no server scope), checked live once against an Azure SQL Database you provide? | Yes. Until then, Azure SQL Database is documented as checked at database scope only |
| D12 | Which release: 0.10.0 for the G lanes and T-1, then 0.10.x or 0.11.0 for T-2 to T-7? | Yes. The G lanes fix work already in 0.10.0 |
| D13 | A BigQuery whole-project DDL mark (DDL whose targets are unknown) stops deleting the project's files and reading every dataset whole, and checks each dataset by its listing instead, leaving in-place changes to the background re-read's normal pace? | Yes. Today one unresolved script costs a whole project's details calls, which on your project means hundreds of thousands. The cost is that an in-place change made by such a script shows up later |
