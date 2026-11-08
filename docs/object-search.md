# Search Objects

Search Objects searches every object a server's login can see, not just the nodes Object Explorer has loaded: every kind
Object Explorer lists, from logins and databases down to columns and parameters. It matches names, and it can also match text
inside definitions (procedures, functions, views and triggers, and constraint, computed column and plan guide expressions).

The same search runs in two places, with the same options and results:

- **Object Explorer's search box**, at the top of the pane. Search in Object Explorer (Ctrl+Shift+F, Cmd+Shift+F on macOS,
  or the palette) focuses it and selects its text, so typing replaces it and End keeps it. It searches the server of the
  tree's selection, or the first connected server. While the box has text, its hits show in a band above the tree, which
  stays as it is; a hit reveals its object in the tree below. Enter reveals the first hit and keeps focus in the box, so
  each further Enter reveals the next one, wrapping round (Shift+Enter goes back); an Enter typed before the search has
  answered searches at once. ↓ moves into the hits (to the selected one), and Left and Right in the tree collapse and expand. Escape clears the
  text, and Escape in an empty box returns to the tree. The band's hits are one tab stop on the selected hit, walked as the
  tab's are (↑ ↓, Page Up, Page Down, Home and End); a click or Enter reveals the hit with focus kept in the hits, and ↑ on
  the first hit, or Escape, returns to the box.
  Search scope (All, Names, Definitions) stays visible. Object types opens a checkbox popover over the results; selected
  types combine and a compact summary and Clear action stay beside the results. Narrow sidebars stack the type picker
  below the scope, and the popover follows the pane's width without enlarging the search band. Search options holds
  Match Case, Match Whole Word, Use Regular Expression and Fuzzy Match; its button marks when any are on. The result count stays
  concise, with index counts, result limits and timing under Search and index details. Index progress, errors and
  incomplete indexes remain visible. Escape or a click outside dismisses a popover; Escape returns focus to its button.
- **The Search Objects tab** (View › Search Objects…, a server or database node's menu, or the palette), with a server picker
  when more than one server is connected. Its hits are one tab stop on the selected hit: a click selects a hit, ↑ ↓,
  Page Up, Page Down (to the last hit in view first, then a page on), Home and End move the selection, and a double-click or Enter reveals the hit in Object Explorer, which
  shows without taking focus, so the keys go on walking the hits. ↑ on the first hit, and Escape, return to the box.
  Beside the hits, behind a sash, is the *details pane* (below them when the tab is narrower than 760 px): see
  *The details pane* below.
- **In both,** the hits are a listbox whose options announce the selected one, and each has a context menu (right-click,
  which selects the hit, or Shift+F10 and the context-menu key on the selected hit). See *A hit's menu* below.

## The index

- **Where it lives.** The index is held in the backend's memory, one per connection, and is never written to disk. It is
  built when a server connects (setting `objectExplorer.search.indexOnConnect`), or on demand with Rebuild Search Index.
  It is dropped on disconnect and when the backend ends.
- **Progress.** The status bar shows "Indexing objects N / M" and a Stop button while a build runs. A newer build of the
  same connection stops the older one.
- **What it reads.** First the server's own objects, in one constant batch on the server's connection. Then every online
  database the login can open (`HAS_DBACCESS`, not snapshots or `tempdb`), at most two at a time. Each database is one
  constant batch of catalog views on the " - Object Search" pool (`READ UNCOMMITTED`, `LOCK_TIMEOUT 5000`,
  `DEADLOCK_PRIORITY LOW`) through `QUOTENAME(@db).sys.sp_executesql`. On Azure SQL Database each database gets its own
  connection instead. No metadata built-ins are used. Definitions come from `sys.sql_modules`, `sys.check_constraints`,
  `sys.default_constraints`, `sys.computed_columns`, `sys.plan_guides` and `sys.server_sql_modules`.
- **Objects indexed.** Every kind Object Explorer lists except the server node, return values and the SSIS Catalog's
  folders, projects, packages and environments (which live in SSISDB). Each hit carries the ref and folder Object Explorer
  uses, so it can be revealed and scripted:
  - **Server:** every database (under Databases, System Databases or Database Snapshots, whatever its state), and on box
    editions and Managed Instance the logins, server roles, credentials, cryptographic providers, audits, server audit
    specifications, backup devices, linked servers and server triggers.
  - **Database:** users, database and application roles, schemas, assemblies, asymmetric and symmetric keys,
    certificates, column master and encryption keys, database audit specifications, database triggers, external data
    sources and file formats, full-text catalogs and stoplists, partition schemes and functions, search property lists and
    plan guides.
  - **Schema:** tables (in Tables, or in FileTables, External Tables, Graph Tables or Dropped Ledger Tables), views,
    synonyms, procedures (T-SQL, CLR, extended and replication-filter), scalar, table-valued and aggregate functions,
    sequences, user-defined data and CLR types, table types, XML schema collections, rules, defaults and security policies.
  - **Children:** columns, keys, constraints, DML triggers, indexes, statistics and parameters, each under its table, view,
    table type, procedure or function, and only where Object Explorer lists such a folder (an external table has no keys).
    A child's label is `schema.parent.name`, and its hit names the folder that lists its parent. The columns are the ones
    the Columns folder shows: graph tables' hidden columns and dropped ledger columns are left out. So are the columns and
    parameters of system functions, which no folder lists yet.
  - **History tables:** a temporal or ledger history table, and its columns, indexes and statistics, name the table whose
    history row shows it, and Reveal walks there. A dropped ledger table's history, which Object Explorer does not list,
    is left out.

  Every object the login can see is indexed, Microsoft-shipped ones included: master's `spt_` tables and msdb's procedures
  under System Tables and System Stored Procedures, as Object Explorer lists them, and system functions under Functions.
  System objects rank after user objects with the same kind of match. Fixed roles, `public`, `guest`, `sys` and
  `INFORMATION_SCHEMA`, and SQL Server's own `##…##` logins count as system objects too.
- **The server's objects.** They name no database, so a search limited to one database leaves them out.
- **A read that fails part way.** If a statement fails (a catalog view the login may not read, or one an edition lacks),
  the status lists the server or the database as skipped. A first build keeps what was read before the failure (the
  databases, or a database's tables and procedures); a rebuild keeps the earlier build's objects whole instead.
- **Memory.** Every connection's index shares one memory budget (512 MiB). Each object is charged an estimate of its
  record. Names and definitions live in one pool shared by every connection, each distinct text once, reference counted:
  a text is charged when it first comes in and given back when the last database or system set holding it is dropped.
  So msdb's procedures and their definitions, master's `spt_` objects, schemas and common column names are held once
  however many servers are connected. Definitions stop being kept once less than 128 MiB is free, so names always have
  room; past that point they are not even read from the server. A rebuild may reuse the memory of the build it replaces, so a database that fitted before still fits when the
  budget is full; the swap moves that share over rather than charging it twice.
- **Large databases.** A database that does not fit in what is free with its children is read again without its columns,
  indexes, statistics and parameters. It still counts as indexed, and the status says children were left out
  (`CHILDREN_LEFT_OUT`). A database that does not fit even without them is skipped as `TOO_LARGE`. A read that runs out of
  room cancels its batch at once rather than reading the rest of it only to throw it away.
- **The resource database's objects.** The `sys` and `INFORMATION_SCHEMA` views, procedures and functions that every database
  shows (with their columns and parameters) come from SQL Server's hidden resource database, so they are the same in every database. The index reads them once
  per build, not once per database, and a search shows each of them once, as master's (or as the database a search names).
  Connections to servers whose resource objects have the same fingerprint (version, edition, and the count, latest change
  and checksum of those objects) share one copy in memory, charged against the budget once. Names and definitions that two
  builds have in common are held and charged once, through the same pool. A server whose objects differ never reuses another's copy, even with the same
  version string. If the read fails, the status lists it as skipped as `mssqlsystemresource`.
- **Skipped databases.** A database the build could not read is reported as skipped, with a reason, and the build
  carries on: `TIMEOUT` (120 s per database), `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `CATALOG_ERROR` or `TOO_LARGE`.
- **Definitions.** Setting `objectExplorer.search.definitions` controls whether definitions are indexed. With it off,
  only names are indexed.

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
- **Wildcards.** Without Use Regular Expression, `*` stands for any characters on one line and `?` for one character; the
  rest is literal (use a regular expression to find a name with a `*` or `?` in it). A search matches anywhere in a name, so
  `Cust*` and `Cust` find the same names; under Match Whole Word an outer `*` matches the rest of the identifier, so `Cust*`
  finds `Customers`.
- **Dots.** A name search with a dot matches the qualified name, `database.schema.name` (a column's or trigger's is
  `database.schema.parent.name`), with a dot at each end, so a dot marks where a part starts or ends. `.Sales` and `Sales.`
  find the schema `Sales` and everything in it (`.Sales` also finds names that start with `Sales`, such as `dbo.SalesOrders`),
  `AppData.dbo.Orders` finds that table in AppData only, and `PartialSchema*.Orders` finds `Orders` in every schema whose name
  starts with `PartialSchema`. Only the schema-qualified part shows marked. A regular expression with a dot matches
  `schema.name` as it is.
- **Match Whole Word.** A match must have no identifier character (a letter, a digit, `_`, `@`, `#` or `$`) on either side.
- **Use Regular Expression.** Patterns run with .NET's `NonBacktracking` engine, which takes linear time. Lookarounds and
  backreferences are refused with a message instead of running.
- **Fuzzy Match** (the toggle after Use Regular Expression; `match: 'fuzzy'`). Names also match approximately, below every
  exact hit, so typos and sound-alikes still find the object: `custmer adress` finds `Sales.CustomerAddress`, `fone` finds
  `PhoneNumber`. The search and each name are split into words, at punctuation, camelCase (`orderLines`), the end of a
  capital run (`XMLParser`: `XML`, `Parser`) and digits, so prefixes such as `usp_` are words of their own. Every word of the
  search must find a word of the name, in any order, that equals it or starts with it, is within a few edits (one for 3 to 5
  letters, two from 6, a swap of neighbours counting one; words of 1 or 2 letters must be exact, a word of 3 to 5 letters
  must have the right first letter, and only a word of 4 letters or more may be a typo of a longer word's start), or, for a
  word of 4 letters or more, sounds like it (as a longer word's start only when its key has 4 codes or more, so `store` does
  not find `String`). A number matches only exactly or as a prefix: `Sales2019` does not find `Sales2018`. Two search words may match the same name word. A
  single word is also compared with the whole name run together (`custmeraddres`). Case is ignored for approximate
  matches; Match Case still applies to exact hits and definitions. Under Match Whole Word a word must match a whole word,
  never a prefix (it may still be a typo of one: `order` finds `Orders`, one edit away). `*` and `?` separate words. With a dot, the words before the last dot match the schema's (and a child's
  parent's) words and the rest the name's. An approximate hit marks the span from its first matched word to its last, with
  a dotted underline instead of the exact match's emphasis. Definitions always match exactly. Fuzzy Match cannot go with
  Use Regular Expression: the toggle is disabled while Regex is on (it keeps its setting for later), and a request asking
  for both is refused.
  - *Sound.* A small Metaphone-style key per word (`FuzzyName.Phonetic`): silent initial letters dropped, a leading vowel
    kept and later vowels dropped, letters that sound alike given one code (`c`/`k`/`q`, `ph`/`f`/`v`, `z`/soft `c`, soft `g`
    as `j`, `sh`/`ch`/`tio`, `th`, `d` as `t`), so `Kustomer` and `Customer` share `KSTMR`. SQL Server's SOUNDEX was
    considered and left out: its four-character code keeps the first letter and three consonants, so long identifiers
    collide (`Customer`, `CustomsHold` and `Cashier` are nearly one code) and a different first letter never matches.
    Double Metaphone handles more English spelling, but identifiers are mostly abbreviations, which no sound key helps with,
    and edit distance already covers most of what it adds.
  - *Cost.* Nothing is stored for it: words, edit distances and keys are worked out per search, so Fuzzy Match takes no
    index memory. A letter-set check skips most edit-distance work, and a sound key stops at its first differing code. On a
    million synthetic names a fuzzy search took 0.3 to 0.7 s where an exact one took about 0.1 s (Release build, one desktop
    core); the search's 5 s budget and Stop bound it as any search. Past the 20,000 candidates a search sorts, a better hit
    takes the worst one's place, so approximate hits never push out exact ones; every other hit past them is only counted.
    Labels are built only for the candidates kept, and hits (previews, match counts, dates) only for the ones answered.
- **Scope.** Search names and definitions (All), names only, or definitions only.
- **Object types.** Chips narrow a search to kinds of object: Tables, Views, Columns, Procedures, Functions, Parameters,
  Triggers, Keys and indexes, Schemas, Types, Security and Other. Several can be on at once, and All types turns them all off.
  Each kind the index holds is under exactly one chip (`searchTypes` in `src/shared/explorer/search.ts`), and the search
  sends the chosen chips' kinds as `kinds`.
- **Narrow panes.** The filters fit the width they have. Chips that do not fit in one line wait behind "+n more", which
  shows them all; its outline marks when a hidden chip is on. When even the scope does not fit, Scope and the chips become
  one Filters button that names what is chosen ("Filters: Names, Columns") and shows them on demand. The layout is worked
  out from a hidden copy of the controls, so it follows the font, density and the check a chosen chip draws.
- **Ranking.** Exact name matches come first, then name prefixes, then other name matches, then under Fuzzy Match the
  approximate ones (every word found but not together, then within edits, then by sound, each by fewest edits), then
  definition-only matches. A
  search with a dot counts the schema-qualified name: `dbo.Orders` matches `dbo.Orders` exactly and `dbo.Orders.id` by prefix.
  Within each group, hits are sorted by database and then by name.
- **Definition hits.** A hit inside a definition shows the line, a preview with the match marked, and how many more
  matches the definition has.
- **While a build runs.** A search answers from what the index holds so far. Searches run again when the build ends, keeping
  the selected hit when it is still there (as any new answer to the same query does) (so Enter in Object Explorer's box goes on from it) and the list where it was scrolled.
- **Using a hit.** Clicking a hit in Object Explorer's box, or double-clicking one in the tab (or Enter on either), reveals the
  object in Object Explorer. The tree walks its path down from the server,
  expanding each node on the way (the database, nested folders such as Programmability › Functions, a trigger's table or
  view) and loading a folder's later pages until the object's row arrives, past the node budget. It then selects the row
  and scrolls it into view. A database is looked for under Databases, then System Databases (the other way round for
  master, model and msdb).
- **When a reveal fails.** The status says why: the listing failed, a filter hides the row, the folder stopped at its
  100,000-item cap (filter it by name), or the object is gone. Stop in Object Explorer, another reveal, or losing the
  server ends it.
- **A hit's menu** (`search.hit.context`) is Object Explorer's menu for the hit's object, which the tree need not have
  loaded: Reveal in Object Explorer; Select Top N Rows on a table or view; Modify on a T-SQL module; Script … as, titled
  and greyed for the object's kind as in the tree; and Copy. Its Object Explorer commands read the hit's own selection
  keys (`CommandArgs.state`, from `selectionContextOf`), never the tree's selection. Rename, Delete and Properties need
  the tree's row and are left to the tree: reveal the hit first.
- **Copy** has four forms. Name is the name as stored (Ctrl+C on a hit). Schema-Qualified Name and Fully Qualified Name
  (Ctrl+Shift+C) join the database, schema, a child's parent and the name with dots, bracketing only a part that is not a
  regular identifier or is a reserved keyword (`AppData.dbo.[Order Details].UnitPrice`); they are offered only for objects
  in a schema. Bracketed Name brackets every part, `]` doubled as QUOTENAME does (`[AppData].[dbo].[Orders]`); a login, a
  database or a database user has only its name, bracketed.
- **The details pane** (`SearchDetails`, `SearchDetailsService`) shows the tab's selected hit. Its name, type and place
  (database, schema, a child's parent) show at once; the reads start once the selection has rested 80 ms, so arrowing
  through the hits reads only the hit the selection stops on. Tables, views, stored procedures and functions are read as
  Object Explorer's Peek reads them (`PeekService.read`): their properties from `explorer.peek` in a strip above, and the
  definition, a module's text from `sys.sql_modules` or a table's Script As CREATE script (kept in Peek's script cache,
  so peeking or selecting the table again while it is unchanged starts no SMO job). Any other kind Script As can write (a
  trigger, an index, a login…) shows its CREATE script; a kind it cannot write says it has no definition. The matched
  line of a definition hit is marked and scrolled a third of the way into view: the index's line for a module's own text,
  else the line of a script that holds the match's preview, nearest that line. A table or a view also shows its columns
  (Definition and Columns), one page of 500 from Object Explorer's Columns folder, read the first time they are shown.
  Script to New Query, Refresh (which never takes a kept script) and Hide are in its header; the Details pane button
  beside the result count hides and shows it in every tab. A hidden pane reads nothing; a new hit, a closed tab, a hidden
  pane or a lost server cancels the tab's reads. Object Explorer's own search has no details pane.

## Protocol

| Method | Purpose | Lane | Deadline |
|---|---|---|---|
| `explorer.index` | Builds a connection's index | explorer | None (cancellable) |
| `explorer.search` | Searches the index | explorer | 15 s |

- **Progress events.** `explorer.index` sends droppable `explorer.index.progress` EVENTs with `{ done, total, objects }`.
  Main relays them only to the window that asked, at most 4 a second, latest wins.
- **Cancelling.** Both methods are cancelled with `explorerCancel` by `requestId`.
- **Failures.** They are values: a search with an invalid pattern answers `problem`, and a skipped database is listed
  in the status.

## Later

- **Disk persistence.** A disk copy (for example SQLite) could start searches before a rebuild ends.
