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
- **Progress.** The status bar shows "Indexing objects N / M" and Stop. A newer build of the same connection stops the
  older one.
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
| SQL Server Agent | Only behind the Agent release gate (`VARIA_AGENT_PREVIEW=1`; with it off the build reads no Agent objects): the jobs the login may read in `msdb.dbo.sysjobs_view` (none, and no error, for a login in no Agent role), and where msdb lets it read them (SQLAgentOperatorRole or sysadmin) operators and, where the Alerts folder is served (Windows), alerts. They name no database and reveal below the server's SQL Server Agent node. |
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

### Failures and skipped databases

- A failing statement (a catalog view the login may not read, or an edition lacks) lists the server or database as
  skipped. A first build keeps what was read before the failure; a rebuild keeps the earlier build's objects whole.
- Skip reasons (the build carries on): `TIMEOUT`, `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `CATALOG_ERROR`, `TOO_LARGE`.
  The status lists the server and system objects first, then databases in listing order, up to 256. A failed SQL Server
  Agent read is listed first, as msdb flagged `agent: true`: msdb itself may still be indexed, so it is not counted as a
  skipped database.

### Memory

- All connections share one budget. Each object is a packed 24-byte entry in its database's `ObjectTable`; names and
  definitions live in one reference-counted pool shared by every connection, so each distinct text (msdb's procedures,
  master's `spt_` objects, common column names) is held and charged once.
- A definition of 512 characters or more is held compressed (`PackedText`: one zstd frame of its UTF-8 text, level 3),
  about a seventh of the string on real module definitions, and charged at its compressed size. The same text always
  compresses to the same frame, so the pool still holds a definition shared by several databases or servers once. A
  search unpacks each definition into reusable buffers of its own (bytes and characters, which grow to as much as
  about ten times the longest definition it reads, so at most about 10 MB), which makes a search inside definitions
  about four times slower than over strings, still far inside its time limit; it checks its time limit and Stop after
  each million or so characters it unpacks, as well as every 64 objects. Packing a definition as it is read borrows
  pooled buffers of a few times its size while it compresses. Shorter definitions (defaults, most computed columns)
  stay strings, and so does a text with an unpaired surrogate, which UTF-8 cannot hold exactly.
- Once less than 128 MiB is free, definitions stop being kept: a build reads at most each one's first 256 characters,
  only to keep short texts already pooled (a default's `((0))`); others are counted as cut. A rebuild may reuse its
  predecessor's memory (and reads definitions whole while that share is left), so a database that fitted still fits.
- The editor metadata is charged per item: 13 bytes a typed column, parameter or function, 14 an index or key,
  5 a key column and 16 a type. On msdb that is about 85 KB (5,600 columns and parameters, 460 indexes and foreign keys,
  840 key columns) beside about 195 KB of entries.
- A database's first editor lookup builds its lookup arrays (names, children by parent, and foreign keys by the table
  they reference, 4 bytes per entry and per such foreign key), charged until its read is replaced or dropped; where the
  budget cannot take them, lookups scan the table instead. The Memory panel counts them with the records, walking the
  index again once they are built.
- A database that does not fit with its children is read again without columns, indexes, statistics and parameters
  (status: `CHILDREN_LEFT_OUT`); one that still does not fit is skipped as `TOO_LARGE`. A read that runs out of room
  cancels its batch at once.

### Limits

| Limit | Value |
|---|---|
| Memory across all connections (past it, a database is kept without its children, or skipped as `TOO_LARGE`) | 512 MiB |
| Memory definitions leave free for names | 128 MiB |
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
  the identifier (`Cust*` finds `Customers`).
- **Dots.** A name search with a dot matches the qualified name `database.schema.name` (a child's
  `database.schema.parent.name`) with a dot at each end. `.Sales` and `Sales.` find schema `Sales` and its contents
  (`.Sales` also finds names starting `Sales`, such as `dbo.SalesOrders`); `AppData.dbo.Orders` finds that table in
  AppData only; `PartialSchema*.Orders` finds `Orders` in every schema starting `PartialSchema`. Only the
  schema-qualified part is marked. A regex with a dot matches `schema.name` as it is.
- **Match Whole Word.** No identifier character (letter, digit, `_`, `@`, `#`, `$`) on either side.
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
  server objects or SQL Server Agent objects skipped, names only, no index, a failed build).

## Protocol

`explorer.index` (no deadline, cancellable, droppable `explorer.index.progress` EVENTs with `{ done, total, objects }`
relayed only to the requesting window, at most 4 a second) and `explorer.search` (15 s) run on the explorer lane and are
cancelled with `explorerCancel` by `requestId`; docs/ipc.md has the details. Failures are values: an invalid pattern
answers `problem`, and skipped databases are listed in the status.
