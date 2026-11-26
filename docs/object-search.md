# Search Objects

Search Objects searches every object a server's login can see, not just the nodes Object Explorer has loaded: every kind
Object Explorer lists, from logins and databases down to columns and parameters. It matches names and, optionally, text
inside definitions (procedures, functions, views and triggers, and constraint, computed column and plan guide
expressions).

## Where to search

**Object Explorer's search box** (top of the pane). Search in Object Explorer (Ctrl+Shift+F, Cmd+Shift+F on macOS; Ctrl+F or
Cmd+F while the Object Explorer pane has focus; or the palette) focuses it and selects its text. It searches the server of the tree's selection, or the first connected
server. Hits show in a band above the tree; a hit reveals its object in the tree below.

- In the box: Enter reveals the first hit and keeps focus; each further Enter reveals the next, wrapping (Shift+Enter goes
  back); typed before the answer, it searches at once. ↓ moves into the hits. Escape clears the text, or in an empty box
  returns to the tree, where Left and Right collapse and expand.
- In the hits (one tab stop): ↑ ↓, Page Up, Page Down, Home and End walk; a click or Enter reveals with focus kept; ↑ on
  the first hit, or Escape, returns to the box.
- Scope (All, Names, Definitions) stays visible. Object types opens a checkbox popover (stacked below the scope in narrow
  sidebars, following the pane's width); chosen types show as a summary with Clear. Search options holds Match Case,
  Match Whole Word, Use Regular Expression and Fuzzy Match, its button marked when any are on. Search and index details
  has index counts, limits and timing; progress, errors and incomplete indexes stay visible. Escape or a click outside
  dismisses a popover (Escape returns focus to its button).

**The Search Objects tab** (View › Search Objects…, a server or database node's menu, or the palette). A server picker
appears when more than one server is connected and can also search *All servers* (below). Opened from a database's menu,
results are scoped to that database in a removable Database chip; clearing it, or choosing another server or All
servers, searches every database (the index still covers the whole server). Hits are one tab stop: a click selects; ↑ ↓,
Page Up, Page Down (to the last hit in view first, then a page on), Home and End move; double-click or Enter reveals the
hit in Object Explorer without taking focus. ↑ on the first hit, and Escape, return to the box. Beside the hits, behind a
sash (below them when the tab is narrower than 760 px), is [the details pane](#the-details-pane).

**The header's Search** (View › Search…, Ctrl+Q on Windows) lists objects below the queries and commands it matches: names
only, Fuzzy Match, every connected server, as you type (nothing without text), at most 50 hits per server with server
and database. It never builds an index; a server without one (`objectExplorer.search.indexOnConnect` off) is named in a
message until built (Build index in Search Objects, or Rebuild Search Index). A hit reveals its object in Object
Explorer, which takes focus. The last row, *See all in Search Objects*, opens a tab with the text and Fuzzy Match on (All
servers when several are connected). New text drops stale hits at once, so Enter never reveals a stale object; a row
stays active on its object as other servers answer. The search ends when the widget closes or changes mode.

In all of them the hits are a listbox announcing the selected option, and each hit has a [context menu](#a-hits-menu):
right-click (which selects the hit), or Shift+F10 or the context-menu key on the selected hit.

## The index

- **Lifetime.** Backend memory only, one per connection; built on connect (`objectExplorer.search.indexOnConnect`) or by
  Rebuild Search Index, dropped on disconnect or backend exit. With the setting off nothing else builds one: the search
  says "This server has no index yet." with **Build index** (**Build indexes** on All servers).
- **Progress.** The status bar shows "Indexing objects N / M" and Stop (a BigQuery build names its pass instead; see
  BigQuery below). A newer build of the same connection stops the older one.
- **Stopped builds.** What a stopped build read stays searchable: the index line reports it with "· build stopped" and
  offers **Build index** until a full build finishes (the window reads the status with `explorer.indexStatus`). A new build
  lists everything again, so drops and additions are seen, but on BigQuery it reuses the details already held of objects
  whose creation and modification times are unchanged, so only the names are listed again for them; a dataset whose details
  were still being read when the build stopped is read again.
- **Reading.** First the server's objects, in one constant batch on the server's connection, then every online database
  the login can open (`HAS_DBACCESS`, not snapshots or `tempdb`), two at a time; an unexpected failure stops the other
  read in flight. Each database is one constant batch of catalog views on the
  " - Object Search" pool (`READ UNCOMMITTED`, `LOCK_TIMEOUT 5000`, `DEADLOCK_PRIORITY LOW`) through
  `QUOTENAME(@db).sys.sp_executesql`; on Azure SQL Database each database gets its own connection. No metadata built-ins.
  Definitions come from `sys.sql_modules`, `sys.check_constraints`, `sys.default_constraints`, `sys.computed_columns`,
  `sys.plan_guides` and `sys.server_sql_modules`.
- **Definitions.** `objectExplorer.search.definitions` controls whether they are indexed; off, only names are.

### Objects indexed

Every kind Object Explorer lists except the server node, return values, the SSIS Catalog's folders, projects,
packages and environments, and SQL Server Agent's node, Job Activity Monitor, proxies, proxy subsystems and error logs.
Each hit carries Object Explorer's ref and folder, so it can be revealed and scripted.

| Level | Kinds |
| --- | --- |
| Server | Every database (under Databases, System Databases or Database Snapshots, any state); on box editions and Managed Instance also logins, server roles, credentials, cryptographic providers, audits, server audit specifications, backup devices, linked servers and server triggers. |
| Database | Users, database and application roles, schemas, assemblies, asymmetric and symmetric keys, certificates, column master and encryption keys, database audit specifications, database triggers, external data sources and file formats, full-text catalogs and stoplists, partition schemes and functions, search property lists, plan guides. |
| Schema | Tables (in Tables, FileTables, External Tables, Graph Tables or Dropped Ledger Tables), views, synonyms, procedures (T-SQL, CLR, extended, replication-filter), scalar, table-valued and aggregate functions, sequences, user-defined data and CLR types, table types, XML schema collections, rules, defaults, security policies. |
| Children | Columns, keys, constraints, DML triggers, indexes, statistics and parameters under their table, view, table type, procedure or function, only where Object Explorer lists such a folder. Label `schema.parent.name`; the hit names the parent's folder. Columns are those the Columns folder shows (no graph hidden or dropped ledger columns), and system functions' columns and parameters are left out. |
| SQL Server Agent | On SQL Server connections: the jobs the login may read in `msdb.dbo.sysjobs_view` (none, and no error, for a login in no Agent role), and where msdb lets it read them (SQLAgentOperatorRole or sysadmin) operators and, where the Alerts folder is served (Windows), alerts. They name no database and reveal below the server's SQL Server Agent node. |
| History tables | A temporal or ledger history table and its columns, indexes and statistics name the table whose history row shows it, and Reveal walks there. A dropped ledger table's history is left out. |

Microsoft-shipped objects are indexed as Object Explorer lists them (master's `spt_` tables and msdb's procedures under
System Tables and System Stored Procedures, system functions under Functions). System objects rank after user objects
with the same kind of match; fixed roles, `public`, `guest`, `sys`, `INFORMATION_SCHEMA` and `##…##` logins count as
system. Server objects name no database, so a search limited to one database leaves them out.

**Resource database objects.** The `sys` and `INFORMATION_SCHEMA` views, procedures and functions every database shows
(with columns and parameters) are read once per build and shown once, as master's (or the database a search names).
Servers whose resource objects share a fingerprint (version, edition, and those objects' count, latest change and
checksum) share one copy, charged once; a server whose objects differ never reuses another's. A failed read is listed as
skipped as `mssqlsystemresource`.

### Editor metadata

Where a database's children are kept, its table also holds what the query editor needs about them (`ObjectDetails`,
column-wise beside the entries, found by binary search on the entry):

- Each column's, parameter's and scalar function's return type (the function's parameter 0) as a type id, max length,
  precision, scale and ordinal, with flags: nullable, identity, computed, has a default, output, read-only. Types are
  the database's own list (system, alias, CLR and table types) with their names pooled as names, so a type text such as
  `nvarchar(40)`, `decimal(18,2)`, `datetime2(7)`, `vector(3)` or an alias's own name is formatted on demand.
- Each index's key columns in key order (descending marked) and then its included columns (not a partitioning column SQL
  Server adds to an aligned index); a primary or unique key
  shares its index's list; each foreign key's column pairs and the table it references (none when that table is not
  indexed, as a hidden or left-out one).
- The resource database's columns and parameters carry their types too. A database read without its children
  (`CHILDREN_LEFT_OUT`) has no metadata.

### Editor lookup

The query editor reads the index in process through `IndexLookup` (no IPC), a snapshot of a connection's build state and
the reads held when it is made:

- Objects by database, schema and name (any schema when none is given, optionally only some kinds), the database's own
  and the resource database's `sys` and `INFORMATION_SCHEMA` ones; then an object's columns and parameters by ordinal with
  their types, its indexes and primary and unique keys with their columns by name, and its foreign keys out (to the table
  they reference) and in (from the tables that reference it).
- Names compare as the database's catalog collation does for case: each database batch ends by comparing `a` with `A`,
  and `i` with `I`, under `CATALOG_DEFAULT`, which reads no catalog row. A Turkish or Azeri collation (`a` equals `A`
  but `i` does not equal `I`) pairs `i` with `İ` and `ı` with `I`. Where the rule is unknown (a batch that failed part
  way, or failed at that comparison, which costs none of the objects read before it) names compare without case. Only
  case (and the Turkish i) is followed: accent, kana and width insensitivity, and characters a collation ignores, are
  not. A database's own name matches exactly, else the one known name that differs from it only in case.
- A database's answer (and every object lookup, which carries it) gives its state: `Ready` (its last read was whole);
  `Partial` with its gaps (children left out, definitions left out by the build, definitions cut, or system objects
  unknown because the connection's resource database read failed); `Building` (a running build has not reached it yet;
  an earlier read, where there is one, still answers); `Skipped` with the skip of its last read (a read that failed part way, or an
  earlier one, still answers where there is one); `Absent`. Each database keeps its last outcome across builds: a
  stopped build, or one whose listing fails, leaves the databases it did not reach as they were; a later read (whole, or
  without its children) clears a skip, and so does a listing that no longer names the database. It also carries when the read it answers
  from finished, and the database's case rule. Columns, keys and foreign keys are asked of an object found that way.
- A lookup is a snapshot: make one per request. One kept across a rebuild or a disconnect keeps the reads it holds alive
  outside the memory budget.

A BigQuery connection's index answers through `LookupBigQuery` instead (`BigQueryLookup`), which the editor reaches over
`language.lookup` ([Completion from the index](language-services.md#completion-from-the-index)): the connection's
projects (billing first, then starred and discovered accessible projects, marked when read by name only), a project's datasets, a dataset's objects (a
sharded group as its newest shard, a routine with its signature) and an object's facts and columns by field path in
schema order. Projects, datasets and objects match exactly, else the one name that differs only in case; a wildcard
(`events_*`, `events_2026*`) or a shard within a date-sharded group's range answers with the group's newest shard; the
prefix matches with case, a group the wildcard covers whole wins over the tables and groups it only begins
(`events_summary`, `events_intraday_`), and otherwise a wildcard that begins two groups, or a group and a plain table,
answers nothing. A dataset's state is `Ready`,
`Partial` (children left out, its project read by name only, its details skipped, or a later read failed with an earlier
one kept), `Building`, `Skipped` or `Absent`; a project is `Partial` when its dataset listing failed after earlier reads or
a listed dataset's read failed.
States come from the build's skip list, which keeps the first 255 skips and the latest.

### Failures and skipped databases

- A failing statement (a catalog view the login may not read, or an edition lacks) lists the server or database as
  skipped. A first build keeps what was read before the failure; a rebuild keeps the earlier build's objects whole.
- Skip reasons (the build carries on): `TIMEOUT`, `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `CATALOG_ERROR`, `TOO_LARGE`.
  The status lists the server and system objects first, then databases in listing order, up to 256. A failed SQL Server
  Agent read is listed first, as msdb flagged `agent: true`: msdb itself may still be indexed, so it is not counted as a
  skipped database.

### Memory

- All connections share one budget, Options › SQL Server Object Explorer › Commands › Index memory limit
  (`objectExplorer.search.memoryLimitMiB`, 512 MiB by default, 64 to 16,384). Each object is a packed 24-byte entry in
  its database's `ObjectTable`; names and definitions live in one reference-counted pool shared by every connection, so
  each distinct text (msdb's procedures, master's `spt_` objects, common column names) is held and charged once.
- A definition of 512 characters or more is held compressed (`PackedText`: one zstd frame of its UTF-8 text, level 3),
  about a seventh of the string on real module definitions, and charged at its compressed size. The same text always
  compresses to the same frame, so the pool still holds a definition shared by several databases or servers once. A
  search unpacks each definition into reusable buffers of its own (bytes and characters, which grow to as much as
  about ten times the longest definition it reads, so at most about 10 MB), which makes a search inside definitions
  about four times slower than over strings, still far inside its time limit; it checks its time limit and Stop after
  each million or so characters it unpacks, as well as every 64 objects. Packing a definition as it is read borrows
  pooled buffers of a few times its size while it compresses. Shorter definitions (defaults, most computed columns)
  stay strings, and so does a text with an unpaired surrogate, which UTF-8 cannot hold exactly.
- Once less than a quarter of the limit (the names' reserve, 128 MiB at the default) is free, definitions stop being
  kept: a build reads at most each one's first 256 characters, only to keep short texts already pooled (a default's
  `((0))`); others are counted as cut and as left out for memory. A rebuild may reuse its predecessor's memory (and reads
  definitions whole while that share is left), so a database that fitted still fits.
- **BigQuery leaves SQL Server its room.** What a BigQuery index takes must leave a floor of the budget free, each floor
  above the names' reserve, so however much BigQuery metadata is indexed, and whichever connection was built first, a
  SQL Server database still finds room for its definitions. The floors are parts of the limit, and BigQuery gives way
  in this order: discovered projects' columns and view and routine text keep half the limit free (256 MiB at the
  default), the billing and starred projects' 7/16 (224 MiB), and everything else BigQuery holds (names, records, its
  lookup arrays) 3/8 (192 MiB). So BigQuery uses at most 5/8 of the limit less what SQL Server holds, and SQL Server
  always has at least an eighth of the limit (64 MiB) for names and definitions before a definition is left out, in
  practice more, since details stop well before names do. A floor only refuses BigQuery: SQL Server's reads take
  whatever is free, which also means SQL Server's use counts against BigQuery's room: with SQL Server holding 5/8 of
  the limit or more (or the two engines together), a BigQuery index reads nothing new, and says why.
- **What a BigQuery dataset holds, it keeps.** A rebuild or refresh charges the share of the read it replaces, names
  to the part its names held and details (columns, signatures, layout, text slots) to the rest, so a new object's name
  does not push a held column out of that share; each part lends to the other only once the budget has refused, so a
  read no larger than the one it replaces always fits. Pass 1 goes on holding, by name (a date-sharded group by its
  prefix, since a new shard renames its entry; not across a table becoming a group or the reverse), the details of the
  objects pass 2 is about to read again (a forced read's, a table created again, one not read whole), marked so that a
  build stopped or a read that fails in between leaves nothing a later build reuses. A
  dataset that already holds details keeps one floor less free than its project's (7/16 for a discovered project, 3/8
  for the billing and starred projects) for whatever details it reads, so what it holds can grow, and
  discovered datasets that hold details are read before the half-free line is checked, whatever the names pass found.
  An object whose pass 2 read fails keeps the details it had, to be read again by the next build, unless it was
  created or changed since, whose carried details were another generation's and are dropped (a date-sharded group is
  the same table whatever its newest shard). When pass 2's read of the dataset does not fit even there, objects go back
  to what the dataset held of them (nothing, for a new one), in this order until the read fits: the new objects; those
  whose details grew; the one the read ran out of room at (a column renamed in place), up to 16 times; then every
  object. An object no larger than before keeps what pass 2 read (one created again keeps it only when its columns are
  the same). Either way the dataset keeps what it held, lists what is new by
  name, and reports details missing. In pass 1, when the names of what is new do not fit beside what it holds (a new
  name's text is always new memory), the dataset is left as it was read before (skipped as `TOO_LARGE`, its earlier
  read kept) until there is room. A new dataset of a discovered project that does not fit stops the names pass for new
  datasets only: datasets the index already holds are still listed and read; details carried from a build stopped
  between its passes stay until a build's pass 2 reads them again. A
  read never swaps a dataset that holds details for one without them: only a dataset that holds none is kept without
  its columns (`CHILDREN_LEFT_OUT`). A read of one project or dataset (Refresh, or a project a search hit reveals)
  uses the billing and starred floors, whatever the project.
- **When memory runs out, the index says so.** The status counts the definitions left out for memory (`leftOut`) and
  the databases or datasets they belong to (`leftOutIn`; the server's own and the system objects are in none), apart
  from definitions only cut at their length and from turning `objectExplorer.search.definitions` off. The index line
  adds "N definitions left out (not enough index memory)", which keeps the line in view in Object
  Explorer's band; below it in the tab, and in the band's Search and index details, a note says a search inside
  definitions misses them and names the option to raise. The same note shows when children were left out, a database or
  dataset did not fit, or BigQuery projects were read by name only. The system objects are shared between servers: a
  set whose definitions were left out is read again by the next build that finds room above the names' reserve.
- **Changing the limit.** Each `explorer.index` carries the option's value (`memoryLimitMiB`), so a change applies from
  the next build of any connection, with the reserve and floors in proportion. Raising it lets that build use the room.
  Lowering it drops nothing: a rebuild reuses its predecessor's share, so an index over the new limit keeps what it has
  (the Memory panel then shows more than 100 %) and takes nothing new, so a database that has grown since is kept
  without its children, or skipped, at its next read; an index gives its memory back when its server disconnects.
- The editor metadata is charged per item: 13 bytes a typed column, parameter or function, 14 an index or key,
  5 a key column and 16 a type. On msdb that is about 85 KB (5,600 columns and parameters, 460 indexes and foreign keys,
  840 key columns) beside about 195 KB of entries.
- A database's first editor lookup builds its lookup arrays (names, children by parent, and foreign keys by the table
  they reference, 4 bytes per entry and per such foreign key), charged until its read is replaced or dropped; where the
  budget cannot take them (for a BigQuery dataset, above its names floor), lookups scan the table instead. The Memory
  panel counts them with the records, walking the index again once they are built.
- A database that does not fit with its children is read again without columns, indexes, statistics and parameters
  (status: `CHILDREN_LEFT_OUT`); one that still does not fit is skipped as `TOO_LARGE`. A read that runs out of room
  cancels its batch at once.

### Limits

| Limit | Value |
|---|---|
| Memory across all connections (past it, a database is kept without its children, or skipped as `TOO_LARGE`) | 512 MiB by default, 64 to 16,384 MiB (`objectExplorer.search.memoryLimitMiB`) |
| Memory definitions leave free for names | 1/4 of the limit (128 MiB) |
| Memory a BigQuery index's names, records and lookup arrays leave free | 3/8 of the limit (192 MiB) |
| Memory the billing and starred projects' details leave free | 7/16 of the limit (224 MiB) |
| Memory discovered projects' details leave free | 1/2 of the limit (256 MiB) |
| Characters kept per definition (longer ones are cut and marked) | 1,000,000 |
| Databases read at once | 2 |
| Time per database | 120 s |
| Search text | 1,000 UTF-16 code units |
| Kinds one search may name | 64 |
| Hits per search (default 200) | 1,000 |
| Skipped databases reported | 256 |
| Time per search | 5 s |
| Regex time per match | 2 s |
| Words in a Fuzzy Match search (more match exactly only) | 8 |
| Characters per Fuzzy Match word (a longer word: exactly only) | 64 |
| Matches counted per definition | 999 |
| Preview length | 160 characters |

## Searching

- **Match Case.** Off by default; matching is ordinal and ignores case.
- **Wildcards.** Without regex, `*` is any characters on one line and `?` one character; the rest is literal. A search
  matches anywhere in a name, so `Cust*` and `Cust` find the same; under Match Whole Word an outer `*` matches the rest of
  the identifier (`Cust*` finds `Customers`). An internal star can stretch to the word boundary, so `Order*Id` finds `OrderIdArchiveId`.
- **Dots.** A name search with a dot matches the qualified name `database.schema.name` (a child's
  `database.schema.parent.name`) with a dot at each end. `.Sales` and `Sales.` find schema `Sales` and its contents
  (`.Sales` also finds names starting `Sales`, such as `dbo.SalesOrders`); `AppData.dbo.Orders` finds that table in
  AppData only; `PartialSchema*.Orders` finds `Orders` in every schema starting `PartialSchema`. Only the
  schema-qualified part is marked. A regex with a dot matches `schema.name` as it is.
- **Match Whole Word.** No identifier character (letter, digit, `_`, `@`, `#`, `$`) on either side. A regex may stretch
  to the word's end to get there (`Order.*?Id` finds `OrderIdArchiveId`).
- **Use Regular Expression.** .NET's `NonBacktracking` engine (linear time). Lookarounds and backreferences are refused
  with a message.
- **Scope.** All (names and definitions), Names or Definitions.
- **Object types.** Chips: Tables, Views, Columns, Procedures, Functions, Parameters, Triggers, Keys and indexes,
  Schemas, Types, Security, Other. Several can be on; All types turns them off. Each indexed kind is under exactly one
  chip (`searchTypes` in `src/shared/explorer/search.ts`); the search sends the chosen kinds as `kinds`.
- **Narrow panes.** Chips that do not fit one line wait behind "+n more" (outlined when a hidden chip is on); when even
  the scope does not fit, Scope and chips become one Filters button ("Filters: Names, Columns").
- **Ranking.** Exact name matches, then name prefixes, other name matches, Fuzzy Match's approximate ones (every word
  found but not together, then within edits, then by sound, each by fewest edits), then definition-only matches. A dotted
  search counts the schema-qualified name (`dbo.Orders` matches `dbo.Orders` exactly, `dbo.Orders.id` by prefix). Within
  a group, by database then name.
- **Definition hits** show the line, a preview with the visible portion of the match marked, and how many more matches the definition has.
- **During a build** a search answers from what the index holds so far and runs again when the build ends, keeping the
  selected hit (so Enter in Object Explorer's box continues from it) and the scroll position.

### Fuzzy Match

The toggle after Use Regular Expression (`match: 'fuzzy'`). Names also match approximately, below every exact hit:
`custmer adress` finds `Sales.CustomerAddress`, `fone` finds `PhoneNumber`.

- The search and each name split into words at punctuation, camelCase (`orderLines`), the end of a capital run
  (`XMLParser`: `XML`, `Parser`) and digits, so prefixes such as `usp_` are words. `*` and `?` also separate words.
- Every search word must find a name word, in any order (two search words may share one), that:
  - equals it or starts with it;
  - is within one edit (3 to 5 letters) or two (6 or more), a neighbour swap counting one; 1 to 2 letter words must be
    exact, 3 to 5 letter words need the right first letter, and only a word of 4 or more letters may be a typo of a
    longer word's start;
  - or, for 4 or more letters, sounds like it (as a longer word's start only when its key has 4 or more codes, so
    `store` does not find `String`).
- Numbers match only exactly or as a prefix (`Sales2019` does not find `Sales2018`).
- A single word is also compared with the whole name run together (`custmeraddres`).
- Case is ignored for approximate matches; Match Case still applies to exact hits and definitions. Definitions always
  match exactly.
- Under Match Whole Word a word must match a whole word, never a prefix (it may be a typo of one: `order` finds
  `Orders`).
- With a dot, words before the last dot match the schema's (and a child's parent's) words, the rest the name's.
- An approximate hit marks the span from its first to last matched word with a dotted underline.
- Not with Use Regular Expression: the toggle is disabled while Regex is on (keeping its setting), and a request asking
  for both is refused.
- **Sound key** (`FuzzyName.Phonetic`, Metaphone-style): silent initial letters dropped, a leading vowel kept and later
  vowels dropped, alike letters share a code (`c`/`k`/`q`, `ph`/`f`/`v`, `z`/soft `c`, soft `g` as `j`, `sh`/`ch`/`tio`,
  `th`, `d` as `t`), so `Kustomer` and `Customer` share `KSTMR`.
- **Cost.** Computed per search, so no index memory; bounded by the 5 s budget and Stop. A search sorts at most 20,000
  candidates; past that a better hit replaces the worst (approximate hits never push out exact ones) and the rest are only
  counted. Once the budget passes, a definition hit shows the matches counted so far (`uncounted`: "+N+ more", or "more
  not counted") and an unbuilt name hit shows no definition match; only such hits make the result partial.

## Using a hit

- **Reveal.** Clicking a hit in Object Explorer's box, double-clicking one in the tab, or Enter on either, reveals it in
  Object Explorer: the tree walks down from the server, expanding each node (database, nested folders such as
  Programmability › Functions, a trigger's table or view) and loading a folder's later pages until the row arrives, past
  the node budget, then selects and scrolls to it. A database is looked for under Databases, then System Databases (the
  other way round for master, model and msdb).
- **When a reveal fails** the status says why: the listing failed, a filter hides the row, the folder stopped at its
  100,000-item cap (filter it by name), or the object is gone. Stop in Object Explorer, another reveal, collapsing a node
  on the path (or Collapse All past the server node) or losing the server ends it, so a folder you collapse stays
  collapsed.

### A hit's menu

`search.hit.context` is Object Explorer's menu for the hit's object, loaded in the tree or not: Reveal in Object
Explorer; Select Top N Rows on a table or view; Modify on a T-SQL module; Script … as, titled and greyed per kind as in
the tree; and Copy. Its commands read the hit's own selection keys (`CommandArgs.state`, from `selectionContextOf`),
never the tree's. Rename, Delete and Properties need the tree's row: reveal the hit first.

**Copy** has four forms:

| Form | Result |
| --- | --- |
| Name (Ctrl+C on a hit) | The name as stored. |
| Schema-Qualified Name | Schema, a child's parent and name joined with dots, bracketing only parts that are not regular identifiers or are reserved keywords (`dbo.[Order Details].UnitPrice`). Only for objects in a schema. |
| Fully Qualified Name (Ctrl+Shift+C) | The same with the database first (`AppData.dbo.[Order Details].UnitPrice`). Only for objects in a schema. |
| Bracketed Name | Every part bracketed, `]` doubled as QUOTENAME does (`[AppData].[dbo].[Orders]`); a login, database or database user is its name alone, bracketed. |

### The details pane

`SearchDetails` and `SearchDetailsService` show the tab's selected hit. Name, type and place (database, schema, a
child's parent) show at once; reads start once the selection has rested 80 ms.

- Tables, views, procedures and functions are read as Peek reads them (`PeekService.read`): properties (`explorer.peek`)
  in a strip, and the definition (module text from `sys.sql_modules`, or a table's Script As CREATE script from Peek's
  cache, so an unchanged table starts no SMO job). Other kinds Script As can write (a trigger, an index, a login…) show
  their CREATE script; others say they have no definition.
- A definition hit's matched line is marked and scrolled a third of the way into view: the index's line for a module's
  text, else the script line holding the match's preview nearest that line. Tabs in the SQL match the spaces shown in the preview.
- Tables and views also show Columns: Peek's Columns list, which comes with the properties (no read of its own), as a card
  grid with Peek's columns (Name, Type, Nullable, Key, Identity, Computed, Default, Definition) that selects, sorts and
  copies as a results grid does. Up to 1,024 columns are listed; a note says when there are more.
- BigQuery hits read only `bigquery.properties` (`tables.get`, or `routines.get` for a routine), which is free: the facts in
  the strip (location, description, labels, rows, sizes, partitioning, clustering, created and changed), a view's or
  materialized view's text or a routine's body as the definition, and a table's Columns (Name, Type, Description: up to
  1,000 columns and nested fields by path, descriptions cut at 1,024 characters). A table's CREATE statement comes from
  a billed `INFORMATION_SCHEMA.TABLES` query, so selecting a table never reads it: Show CREATE Statement runs its free
  estimate, then the cost prompts, then the read under the cap they set (as Script As does). Models, datasets and columns
  show their place only.
- Header: Script to New Query, Refresh (never takes a kept script) and Hide. The Details pane button beside the result
  count hides and shows it in every tab. A hidden pane reads nothing; a new hit, closed tab, hidden pane or lost server
  cancels the reads. Object Explorer's own search has no details pane.

## All servers

- **Where.** Only the tab's server picker offers *All servers*. Search Objects from the palette, View or the toolbar
  opens on All servers when more than one server is connected; from a server's or database's menu, on that server. On
  All servers, Rebuild Search Index rebuilds every server's index.
- **The picker** (`ServerPicker`, a WAI-ARIA select-only combobox themed like the menus) shows each server's connection
  colour (or `connection.default`), environment tag and result count ("…" while searching), and *All servers* the total,
  from answers the tab already has. Keys: ↓, ↑, Enter, Space, Alt+↓ open; Home/End open at the first/last option;
  letters type ahead (repeat to cycle); Enter, Space, Alt+↑ choose; Tab chooses and moves on; Escape or a click outside
  closes unchosen.
- **How.** The renderer sends one `explorer.search` per connected server at once (`ObjectSearchService`, `searchAll`)
  and shows each server's group as it lands, in Object Explorer's order; a slow server holds back only its own group
  ("searching…"), and the selection stays on its server's hit. Each server has its own hit limit. Every server gets an
  index if it has none while indexing on connect is on. When a server's build ends or a server connects, only that
  server is asked again and merged in (its group keeps its previous answer meanwhile). A server that disconnects drops
  out, named in the summary.
- **Results.** Each server's hits are a list "Results on *server*" under a collapsible header: colour, name,
  environment tag (red PROD for Production) and its results or why it has none (indexing, an error, a problem with the
  query), with "… *n* more" when the cap cut it short. Every hit starts with its kind's badge (T tables, V views,
  P procedures and triggers, F functions, C columns; `searchKind.*` theme keys; "?" for an unknown kind, shown as an
  Object in details and not revealable) and ends with its path.
- **Keys.** The list is one tab stop, roving to a header while focused, walked as a tree grid: ↑ and ↓ move through
  headers and shown hits (↑ on a group's first hit reaches its header); ← on a hit goes to its header; ← and → on a
  header collapse and expand (→ on an expanded header goes to its first hit); Page keys, Home and End walk the hits. A
  group collapsing on the selected hit passes the selection to the next shown hit. A hit's Reveal, menu, Copy and
  details act on its own server.
- **Summary.** Servers, total results, slowest server's time, and servers still searching or indexing, unsearchable or
  disconnected. The index line counts every server's index and names each that leaves objects out (skipped databases,
  server objects or SQL Server Agent objects skipped, names only, definitions left out for memory, no index, a failed
  build), with the [memory note](#memory) below it when any server's index ran short.

## BigQuery

A BigQuery connection has an index of its own, searched in every way above (the box, the tab, the header's Search and All
servers, which spans SQL Server and BigQuery connections together). It lives under the same budget, of which it may use
only a part so that SQL Server's definitions keep their room ([Memory](#memory)), and is built and
dropped the same way, from BigQuery's free metadata calls only: no job runs and nothing is billed.

- **Three prioritized waves.** Every build reads free REST metadata through the principal's shared limiter (each method
  paced at BigQuery's per-user rate; docs/bigquery.md, Rate limiter), so the billing project finishes first and
  interactive Object Explorer / Properties calls stay responsive:
  1. **Billing project (names + details).** Lists the billing project's datasets (`datasets.list`), then its objects
     (`tables.list`, `routines.list`, `models.list`, 32 datasets at a time), then reads details (`tables.get` for
     columns, nested STRUCT fields by path such as `address.city`, descriptions, partitioning, clustering, rows, size and
     view text, and `routines.get` for routine bodies and signatures, 64 at a time; or the opt-in billed bulk path).
  2. **Starred and discovered projects (names).** When Options › Object Explorer › Commands › Index all accessible
     BigQuery projects (`objectExplorer.search.bigQueryAccessibleProjects`, on by default) is on, a full build calls
     `projects.list` (up to `objectExplorer.search.bigQueryMaxProjects`, default 500, configurable 1–5,000, sorted
     deterministically) and combines the user's starred projects with all
     discovered accessible projects. It lists their datasets (16 projects at a time) and objects (32 datasets at a
     time), swapping each dataset into the index immediately so every table, view, routine, model and dataset across all
     accessible projects becomes searchable within seconds.
  3. **Starred, then discovered projects (details).** Reads `tables.get` and `routines.get` (64 at a time) for starred
     projects first, then discovered projects, swapping each dataset as it finishes. Once less than half the memory
     limit is free (discovered projects' floor, [Memory](#memory)), pass 2 stops early for the remaining discovered
     projects (recording them as names only) while keeping Wave 1 and Wave 2 intact; the billing and starred projects'
     details go on until 7/16 is free (3/8 for a dataset that already holds details), after which a dataset that holds
     no details keeps its names without its columns and one that does keeps what it held.
  The status says "Discovering accessible BigQuery projects…", then "Indexing N of M datasets", then "Reading details of
  N of M objects"; the finished index line reports the project count when more than one project is indexed. The status
  bar names the pass the same way ("Listing BigQuery datasets N / M", "Reading BigQuery object details N / M"). While wave
  2 is still listing projects, more datasets can join the total, so it reads "~M" (Search Objects says "about M"). While
  BigQuery is refusing calls for its rate limit, the status bar adds "(rate limited)" and Search Objects adds a sentence
  saying so. Refused calls wait and retry, so the build slows down. A call still has its own 30 s, so only a long throttle
  turns into skipped datasets or missing details. Builds that count different things (SQL Server databases and BigQuery objects, say) are not added
  together; the status bar then shows "Indexing objects on N servers…".
- **Projects.** Starred projects (managed per verified BigQuery principal in Object Explorer) are always indexed with
  details — including public or dataset-ACL projects such as `bigquery-public-data` that `projects.list` does not return.
  Turning off `objectExplorer.search.bigQueryAccessibleProjects` limits indexing to the billing project and starred
  projects.
- **Sharded tables.** Tables whose names end in a valid date (`events_20260101`, `events_20260102`, …), two or more with
  the same prefix, are one entry, the newest shard, whose row names the shard count and date range. Its schema is read
  once.
- **Refresh.** A rebuild lists everything again, prunes projects no longer accessible (when discovery succeeded and was
  not cut), and reuses what an earlier read knew about an object whose creation time (and, for routines and models, last
  change) is unchanged, since `tables.list` reports no change time. Refresh on a project or dataset in Object Explorer
  re-reads that project or dataset whole (including starred, discovered and session projects), starring a project reads
  that project, Refresh on a node below a dataset reads that dataset, and Refresh on the connection's node rebuilds
  everything.
  DDL run from a query tab (CREATE, ALTER, DROP, UNDROP, and LOAD DATA, which can create a table or change its schema; not row
  access policies, search or vector indexes, reservations or project options, which change nothing the index lists)
  marks the datasets it changed stale, read from the job: a statement's target (its table, routine or dataset), and for a
  script each DDL statement's entry in the child listing the run reads anyway, so marking adds no call; a statement whose entry
  names no target (a script's LOAD DATA, whose destination the listing leaves out) is read with jobs.get in the background, up
  to 32 a script. DDL whose target cannot be read, and a script whose statements could not be listed, mark the default
  dataset; when there is none, or the listing was cut short, the
  whole billing project is marked, and its next stale read lists its datasets again and re-reads each. Temp tables and
  functions live in the session's or script's anonymous `_` dataset, which no index lists, so they mark nothing. A run that
  does not finish in its request (Stop, a lost connection, a tab closed or a run left attached) is followed in the background
  with jobs.get, every 5 s at first and backing off to once a minute, at most 64 jobs at a time, until BigQuery reports it done,
  then marked the same way (it gives up after 10 failed reads in a row); text with no word of such a statement (for a re-attached run, the job's own text) is not
  followed. Every mark is free REST metadata, never a query. Marks carry a number: a query's result (`indexStale`), a search's
  index status and a build's status (`staleMark`) name the newest, and the renderer asks one stale-only build for each new
  number, so a mark set after its tab closed is read at the next search, run or build; a dataset whose read failed keeps its
  mark for the next rebuild without asking again. A stale-only build that failed, or was cancelled other than by Stop, is asked
  again at the next hint; one you Stop waits for a newer mark. Marked datasets are re-read whole, or by a build already running
  when it reaches them. A dataset DDL names in a starred or discovered project is marked like any other, and one in a project the index does
  not read is not marked; only the whole-project mark (targets unknown) is the billing project's alone. A refresh
  asked while a build runs waits for it; after a rebuild fails, only another rebuild runs.
- **Failures.** On the billing project and starred projects, any project or dataset listing failure is reported as a skip
  with BigQuery's reason (`PERMISSION_DENIED`, `NOT_FOUND`, `TIMEOUT`, `QUOTA`, `API_DISABLED`, …). On auto-discovered
  projects, `API_DISABLED`, `PERMISSION_DENIED` and `NOT_FOUND` on `datasets.list` are silently ignored so non-BigQuery
  GCP projects do not pollute the skip list, while operational failures (`TIMEOUT`, `QUOTA`, `AUTH_EXPIRED`,
  `CONNECTION_LOST`, `TOO_LARGE`) and a VPC Service Controls refusal (off the network: the project keeps what earlier
  builds read) still report. A dataset whose objects' details could not all be read keeps their names
  and is counted as "details missing". Each metadata call has 30 s. A dataset dropped since its last read leaves the index
  without a skip.
- **Limits** (`objectSearchLimits.bigQuery`, `BigQueryIndexLimits`): up to 500 discovered projects by default (configurable
  1–5,000 via `objectExplorer.search.bigQueryMaxProjects`), 16 projects and 32 datasets listed at once, 64 detail reads at
  once, 200 starred projects, 500 pages of 1,000 per listing, 10,000 columns per table, and 1,024 characters of each
  column description or routine signature. What a listing or a details pass has read stays outside the budget until its
  dataset is held, so it is bounded too. Only 4 listings across all builds go past their first page at once. Pass 2 admits
  datasets while the objects they read add up to at most 4,096; a larger dataset reads alone.

### Billed bulk index

Options › Text Editor › GoogleSQL › General › Read the search index's details with billed INFORMATION_SCHEMA queries
(`textEditor.googleSql.bulkIndex`, off by default) replaces most of pass 2's per-object calls for the billing project and
starred projects with three region-scoped queries per location, which is faster for projects with thousands of objects
(auto-discovered projects always use free REST calls so enabling bulk indexing never bills scans across an entire org):

- `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` joined with `COLUMNS` and `TABLES` (columns and nested fields with types,
  descriptions, order and nullability, and whether a table is a clone or snapshot), `VIEWS` (view text) and `ROUTINES`
  (routine bodies). With definitions off (`objectExplorer.search.definitions`), only the column query runs.
- **Cost.** BigQuery bills each query at least 10 MiB for every INFORMATION_SCHEMA view it reads (the column query reads
  three) and never answers them from cache. So a full build first asks `bigquery.indexEstimate`: the locations of the
  billing project's and starred projects' datasets, up to 64, each query dry-run free, each counted as every view's floor
  plus its bytes. The estimate then goes through the same cost prompts as
  Execute, which ask only above the cost threshold or when the estimate may be low. The estimate shown is the build's
  budget: a location's queries run one at a time, each capped at what is left of the budget less the later queries'
  floors (or at the connection's or Options' maximum bytes billed, Query Execution › BigQuery › Cost, when lower). The
  whole cap leaves the budget when the query starts, and only once it is done, finished or failed, does what it did not
  bill (its cap less BigQuery's billed bytes for the job) return; when that cannot be read, the whole cap stays charged.
  So the build never bills more than the estimate. A query over its cap fails without being billed, and a location the
  rest of the budget or the cap cannot cover is not started; either way its datasets are read with the free calls. The
  status says "Estimating the billed INFORMATION_SCHEMA read of the index's details…" meanwhile; Stop, a newer build or
  a disconnect ends it.
- **The same entries.** The rows fill exactly the entries pass 2's `tables.get` and `routines.get` would (the offline
  checks compare them), with the same limits. Objects the rows do not cover still use the free calls: materialized
  views' text, routines without a body, objects dropped or created again after the listing (or not yet in
  INFORMATION_SCHEMA), and every dataset in a location whose queries failed, and a dataset whose rows pass 8 million
  characters. Bulk-read objects carry no row count, size, partitioning, clustering, routine signature or last change in
  the index (a table's hit shows its creation date); the details pane reads those live.
- **When it runs.** Only full builds (indexing on connect, Rebuild Search Index, Refresh on the connection's node); a
  refresh of a project, dataset or DDL change uses the free calls. A declined prompt or a failed estimate builds with
  the free calls only. The next build reads bulk-read objects again rather than reuse them. The index line says
  how many locations were read with INFORMATION_SCHEMA, and when a location's read failed (with BigQuery's reason), that
  its details were read with free calls instead.
- **SQL.** The text is constant but for the region qualifier (`` `project`.`region-us` ``), which `BqNames.RegionPath`
  builds from a checked project and location; there are no other values. The offline lint renders every template.

Searching and hits:

- **Kinds.** Datasets, tables, views, materialized views, external tables, routines, models and columns. Tables,
  Views, Columns and Procedures are shared with SQL Server's chips; Materialized views, External tables, Snapshots,
  Clones, Routines, Table functions, Models and Datasets show when a BigQuery connection is searched. Each server is sent
  only its own engine's kinds; a server none of the chosen types apply to answers no hits. A clone in a project read by
  name only is listed as a table (only its details say it is a clone).
- **Names and definitions.** Name search covers dataset, object and column names (a column by its field path); definition
  search covers view and materialized view text and routine bodies. Opening Search Objects from a BigQuery project or
  dataset node scopes the tab to that project or dataset with a removable chip; switching servers or choosing All servers
  clears the scope so mixed SQL Server and BigQuery searches work together.
- **A hit's row** shows its name without the dataset, and the project, dataset and folder, then a column's type or a
  sharded table's shards. Reveal walks project › dataset › folder › object (a column through its table and the record
  columns above it); if the hit's project is not yet in Object Explorer, Reveal adds it for the current session (unstarred)
  before walking to the object.
- **Its menu** has New Query (a GoogleSQL query tab on the hit's connection, in its dataset when that is in the billing
  project), Preview Rows (tables), Script As and Copy (Name, and Fully Qualified Name: the backtick-quoted path). The
  details pane shows its free facts, a view's text or a routine's body, and a table's columns ([The details
  pane](#the-details-pane)).

## Protocol

`explorer.index` (no deadline, cancellable, droppable `explorer.index.progress` EVENTs with `{ done, total, objects }`, and
BigQuery's `phase` — `projects`, `names` or `details` —
relayed only to the requesting window, at most 4 a second) and `explorer.search` (15 s) run on the explorer lane and are
cancelled with `explorerCancel` by `requestId`; docs/ipc.md has the details. Failures are values: an invalid pattern
answers `problem`, and skipped databases are listed in the status. Both methods serve BigQuery connections too: `explorer.index`
takes BigQuery's `starredProjects`, `allProjects`, `maxProjects`, `scope` (a project, or a project's dataset), `stale` and `bulk` (SQL Server refuses them), and
`explorer.search` its `project` and `dataset` (SQL Server's `database` is refused for BigQuery, and theirs for SQL Server).
On either engine `explorer.index` takes `memoryLimitMiB` (64 to 16,384, checked in zod and in C#), the limit every
connection's index shares from that build on; a status carries `leftOut` and `leftOutIn` when definitions were left out
for memory.
