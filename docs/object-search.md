# Search Objects

Search Objects (View › Search Objects…, a server or database node's menu in Object Explorer, or the palette) searches every
object a server's login can see. It does not search just the nodes Object Explorer has loaded. It matches names, and it
can also match text inside module definitions (procedures, functions, views and triggers).

## The index

- **Where it lives.** The index is held in the backend's memory, one per connection, and is never written to disk. It is
  built when a server connects (setting `objectExplorer.search.indexOnConnect`), or on demand with Rebuild Search Index.
  It is dropped on disconnect and when the backend ends.
- **Progress.** The status bar shows "Indexing objects N / M" and a Stop button while a build runs. A newer build of the
  same connection stops the older one.
- **What it reads.** Every online database the login can open (`HAS_DBACCESS`, not snapshots or `tempdb`), at most two
  at a time. Each database is one constant batch of catalog views on the " - Object Search" pool (`READ UNCOMMITTED`,
  `LOCK_TIMEOUT 5000`, `DEADLOCK_PRIORITY LOW`) through `QUOTENAME(@db).sys.sp_executesql`. On Azure SQL Database each
  database gets its own connection instead. No metadata built-ins are used, and definitions come from `sys.sql_modules`.
- **Objects indexed.** Tables, external tables, views, procedures (T-SQL, CLR and extended), scalar, table-valued and
  aggregate functions, synonyms, sequences, DML triggers (under their table or view), user-defined data and CLR types,
  table types, and database DDL triggers. Microsoft-shipped objects are left out.
- **Skipped databases.** A database the build could not read is reported as skipped, with a reason, and the build
  carries on: `TIMEOUT` (120 s per database), `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `CATALOG_ERROR` or `TOO_LARGE`.
- **Definitions.** Setting `objectExplorer.search.definitions` controls whether definitions are indexed. With it off,
  only names are indexed.

### Limits

| Limit | Value |
|---|---|
| Objects per connection | 1,000,000 |
| Characters kept per definition (longer ones are cut and marked) | 1,000,000 |
| Definition characters across all connections | 64 Mi |
| Databases read at once | 2 |
| Time per database | 120 s |
| Search text | 1,000 UTF-16 code units |
| Hits per search (default 200) | 1,000 |
| Skipped databases reported | 256 |
| Time per search | 5 s |
| Regex time per match | 2 s |
| Matches counted per definition | 999 |
| Preview length | 160 characters |

## Searching

- **Match Case.** Off by default; matching is ordinal and ignores case.
- **Match Whole Word.** A match must have no identifier character (a letter, a digit, `_`, `@`, `#` or `$`) on either side.
- **Use Regular Expression.** Patterns run with .NET's `NonBacktracking` engine, which takes linear time. Lookarounds and
  backreferences are refused with a message instead of running.
- **Scope.** Search names and definitions, names only, or definitions only.
- **Ranking.** Exact name matches come first, then name prefixes, then other name matches, then definition-only matches.
  Within each group, hits are sorted by database and then by name.
- **Definition hits.** A hit inside a definition shows the line, a preview with the match marked, and how many more
  matches the definition has.
- **While a build runs.** A search answers from what the index holds so far. Searches run again when the build ends.
- **Using a hit.** Clicking a hit reveals the object in Object Explorer. The tree walks its path down from the server,
  expanding each node on the way (the database, nested folders such as Programmability › Functions, a trigger's table or
  view) and loading a folder's later pages until the object's row arrives, past the node budget. It then selects the row
  and scrolls it into view. A database is looked for under Databases, then System Databases (the other way round for
  master, model and msdb).
- **When a reveal fails.** The status says why: the listing failed, a filter hides the row, the folder stopped at its
  100,000-item cap (filter it by name), or the object is gone. Stop in Object Explorer, another reveal, or losing the
  server ends it.
- **Scripting a hit.** The script button scripts the object to a new query: ALTER for modules where the login may,
  otherwise CREATE.

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
