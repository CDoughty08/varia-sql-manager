# SQL language services

Varia supplies SQL Server **completion and hover** in-process using Microsoft's `ScriptDom` (`TSql180Parser`) and the
Search Objects in-memory index (`IndexLookup`, [object-search.md](object-search.md#editor-lookup)), across all SQL Server
authentication modes (SQL Login, Windows Authentication, and **Microsoft Entra ID**). Query **error checking**
(diagnostics) continues to run in an isolated Microsoft SQL Tools Service child process until Phase 2 replaces
diagnostics as well. BigQuery queries are GoogleSQL, which completes from the Search Objects index
([Completion from the index](#completion-from-the-index)) and is described in [googlesql.md](googlesql.md).

Installed applications include the matching self-contained SQL Tools Service diagnostic runtime for Windows x64, Linux
x64, macOS arm64 or macOS x64. Completion and hover need no external language-server process, separate installation, path
setting or first-launch download.

## Using IntelliSense

- **Completion.** **Ctrl+Space**, or a provider trigger character such as `.` (and `` ` `` in GoogleSQL). Suggestions use the query tab's
  connection and database; switching tabs does not change another editor's pending request. Suggestions show the identifier
  name with right-aligned kind/type metadata, with document-word suggestions (`wordBasedSuggestions`) disabled so comments and
  unrelated words never pollute SQL lists. Accept suggestions with **Tab** or click; **Enter** inserts a newline so short
  table aliases (such as `t`) are never hijacked by clause keywords.
- **Exact matches first.** A name that matches the typed word exactly, ignoring case and quoting (brackets or backticks),
  is listed and selected first, above names that merely start with it, fuzzy matches and system objects. Monaco's own
  scoring would otherwise prefer a prefix in the typed case (`orders` would rank `orders_archive` or a lower-case
  system view above `Orders`). Each list is re-ranked as the word grows: a complete answer is reused for identifier
  characters typed at the caret, and a truncated one is requested again.
- **Brackets.** Every column suggestion shows and inserts its name in brackets (`[bob].[columnName]`, `[Order Date]`);
  the bare name still filters, and so does a name after a typed `[` or `"`. A table or other name that is inserted in
  brackets because it needs quoting also shows its brackets. Accepting a suggestion inside an auto-closed `[...]`
  replaces the whole bracketed word, closing bracket included.
- Because each list is requested again as you type, a list opened with **Ctrl+Space** shows *No suggestions* once
  nothing matches, instead of keeping the last matches.
- A table created after the query's metadata was loaded is not suggested until **Refresh Local Cache** (below).
- **Columns, scope & script-local objects.** Columns rank ahead of general suggestions of equal match quality. In-process
  `ScriptDom` (`TsqlScopeReader`) resolves `FROM` / `JOIN` / `CROSS APPLY` / `OUTER APPLY` / `PIVOT` / `UNPIVOT` /
  `OPENJSON` / `UPDATE` / `DELETE` / `MERGE` / `INSERT` sources and aliases, CTEs (`WITH`), derived tables, `OUTPUT`
  `inserted` / `deleted`, script-local `#temp` and `##global_temp` tables (`CREATE TABLE #t`, `SELECT … INTO #t`,
  persisting across `GO` batches), batch-local `@table` and `@scalar` variables (plus procedure/function parameters), and
  mid-script `USE other_db` database switches directly against `IndexLookup` (~1 ms, zero IPC hop, full database
  collation case rules including case-sensitive and Turkish/Azeri dotted-I collations, plus `sys` and
  `INFORMATION_SCHEMA` resource objects). Aliased and multi-source unqualified columns carry their source qualifier
  (`t.[high]`, `b.[high]`; `hi` matches both), and `t.` returns only that source's columns.
- **FK-aware `JOIN … ON` & cross-DB fuzzy `FROM` jump.** Inside `JOIN … ON |`, `IndexLookup` foreign keys (outgoing,
  incoming, and multi-column composite FKs) suggest the join predicate (`o.[CustomerId] = c.[Id]`) ranked **#1** ahead of
  individual columns. Typing 2+ characters at an unqualified `FROM` / `JOIN` site performs a bounded cross-schema and
  cross-database fuzzy jump (current DB `dbo` → current DB other schemas → other indexed databases), inserting
  `[schema].[Table]` or `[OtherDB].[dbo].[Table]`.
- **T-SQL context sites.** `CAST(x AS |)` / `CONVERT(|, x)` / `DECLARE @x |` suggest T-SQL data types only;
  `DATEADD(|, …)` / `DATEDIFF` / `DATEDIFF_BIG` / `DATENAME` / `DATEPART` / `DATETRUNC` suggest T-SQL date parts only;
  `@@|` (with `@` as a trigger character) suggests curated system globals (`@@ROWCOUNT`, `@@TRANCOUNT`, `@@ERROR`,
  `@@IDENTITY`, `@@SPID`, `@@VERSION`, etc.) while `@|` suggests batch-local variables; built-in T-SQL functions include
  hover signatures.
- **3-level hover.** Hovering a SQL Server **database** segment (or `USE` target) shows index state, collation case rule,
  and schema/object counts; hovering a **schema** shows object counts and sample objects; hovering a **table, view,
  procedure, function, synonym, or table type** shows columns with `PK`/`UK`/`FK`/`IDENTITY` markers, parameters/return
  type, and incoming/outgoing foreign keys; hovering an alias, column, `#temp` table, `@var`, CTE, `@@` global, or
  built-in function shows its resolved schema, type, FK target, or signature.
- **Lazy schema preview drawer.** Arrowing through completion suggestions lazily resolves a full schema preview in Monaco's details pane from the local Search Objects RAM index (~1 ms, zero extra SQL Server, STS, or BigQuery calls): BigQuery items show their path, PR #738 discovery tier (`Billing`, `★ Starred`, `Discovered`), rows, size, partitioning/clustering, description, nested `STRUCT` field summaries, and top columns; SQL Server items enrich suggestions with columns, types, `PK`/`UK`/`FK`/`IDENTITY` markers, indexes, and incoming/outgoing foreign keys.
- **Unified status bar IntelliSense popover.** Clicking the status bar's SQL IntelliSense chip opens a Calm Pro popover (dismissible with **Esc** or an outside click) summarizing index and provider health, the shared Search Objects memory budget bar, one-click **Refresh Cache** / **Refresh Local Cache** (`Ctrl+Shift+R`), **Build index** / **Refresh index** when unindexed or memory-capped (`CHILDREN_LEFT_OUT`), and **Settings**. On BigQuery tabs it breaks down the 3-wave index (billing, ★ starred, and discovered / memory-capped projects) and checks the health of each `FROM`/`JOIN` table in the active query; on SQL Server tabs it reports `ScriptDom + Index` for completion/hover alongside SQL Tools Service error checking (or `Unavailable on Entra ID` on Microsoft Entra ID tabs) and indexed database counts.
- Hover and completion widgets can extend beyond a short query panel within the window; each editor owns its widgets
  across split and floating groups, and menus and dialogs stay above them.

### Go To Definition

**F12** scripts the table, view, procedure, function, synonym or user-defined type under the caret as CREATE to a new
query tab; on a column it goes to the column's table, using the statement's aliases. The mouse and Peek work as on an
Object Explorer row ([Peek](object-explorer.md#peek)):

- **Ctrl+hover** (**⌘+hover** on macOS): rest the pointer on a name with Ctrl held and Peek's card opens below it (above
  it near the bottom of the window) without taking focus. **Esc** in the editor, a press outside the card, editing the
  query or another peek closes it; it follows the name as the editor scrolls. Esc first closes the suggestions, Find, the
  read-only message, an SQL issue (F8) or a snippet when the editor shows one, then the card; a hover showing beside it closes with the card. Unlike Object Explorer, the editor shows no peek cursor, and pressing
  Ctrl with the pointer already resting on a name does nothing until the pointer moves.
- **Alt+F12** (Peek Definition) opens the same card at the caret and moves focus into it; **Esc** returns to the editor.
  Esc pressed while the name is still being looked up cancels the peek, so a slow server never opens the card later.
- **Ctrl+click** (**⌘-click**), **Open Definition in Peek Tab** on the editor's context menu, or **Ctrl+Enter** in the card
  opens the object in a Peek tab.

Both modifiers are changeable among the Shortcuts page's mouse gestures. F12 and Alt+F12 work in query tabs and Peek's
read-only definition editor; hovering in Peek's own editor peeks nothing, since the new card would replace the one it is
in. Keywords are never looked up on hover, and a hover that finds nothing says nothing. Go To Definition is implemented by
Varia's backend, not SQL Tools.

- Names resolve on the query's connection and database as SQL Server resolves them: three-part names in another
  database; a one-part name in your default schema, then dbo, then sys (`sp_who` finds `sys.sp_who`); a column through
  its own query's aliases, not a subquery's. An earlier `USE` changes the database. A column's XML or CLR method
  (`t.Doc.value(...)`) goes to the column's table.
- CTEs, derived tables, table variables and columns a statement declares have no definition. A name matching nothing, a
  temporary object or a linked server's object shows a short status-bar message, never an error dialog.

In a **BigQuery query** the same keys and gestures work, without the backend's SQL Server lookup and without billing:

- Names resolve as [completion](#completion-from-the-index) resolves them, from the connection's Search Objects index: a
  table, view or table function where a table is written, a routine where it is called (`sales.to_cents(price)`), and an
  alias or column's table or view. A one-part name is in the tab's default dataset, a two-part one in the billing project.
  `WITH` queries, subqueries, built-in functions (`NET.HOST(`) and anything the index has not read yet have no definition.
  A `CREATE TEMP FUNCTION` in the script is not in the index: a call to it finds a persistent routine of the same name in
  the default dataset, if there is one. An index busy or failing says so rather than that nothing was found.
- The keys work in BigQuery query tabs only, not in BigQuery Properties' or Peek's read-only Definition editor, which has
  no query connection to resolve names on.
- **F12** on a view, materialized view or routine opens its SQL in a new query on the same connection (in the object's
  dataset when it is in the billing project), read from `tables.get` or `routines.get` as Properties reads it. A table, or a
  routine with no stored body, has no free CREATE statement (Script As › CREATE reads it with a billed query, after its
  cost prompt), so F12 says so instead.
- **Alt+F12**, Ctrl+hover and Ctrl+click open BigQuery's Peek card or Properties tab ([BigQuery › Peek](bigquery.md#properties)),
  on **Definition** for a view, materialized view or routine and where they open today for a table.

### Toggle Brackets and comma placement

These commands read the query's tokens, so text in strings, comments, variables, temporary tables and quoted names never
changes. Each is one undo step, on the editor's context menu, **Edit › Advanced** and the command palette. Toggle Brackets
is available only in SQL Server queries, since GoogleSQL's `[1]` is an array. Move Commas reads a BigQuery query with
GoogleSQL's own tokens: `#` and `--` comments, backtick names, and raw, bytes and triple-quoted strings keep their commas,
`[…]` is a bracket like `(…)`, and `GO` is an ordinary name, never a statement boundary.

- **Toggle Brackets** (**Ctrl+[**, **⌘[** on macOS) brackets every name in the selection, or in the whole query when
  nothing is selected: `dbo.Orders o` becomes `[dbo].[Orders] [o]`. When every name already has brackets, it takes them off
  wherever that is safe, keeping them on reserved keywords (`[Order]`), names that are not regular identifiers
  (`[Order Lines]`, `[1st]`) and `[GO]`. Keywords, built-in function names (a name a parenthesis follows, except a table a
  column list follows), date parts (`DATEADD(day, …)`), type names where a type is expected (`@x int`, `CAST(a AS date)`),
  labels, `geography::Point`, ODBC escapes (`{fn …}`), the JSON functions' `ABSENT ON NULL` and `RETURNING json` (a key before its colon, `JSON_OBJECT(k:v)`, is a name), and the options of `WITH`, `OPTION (…)`, `FOR XML`/`FOR JSON`, `SET`
  statements and cursor declarations, over as many lines as they take, are left alone. In statements about servers,
  databases and security (`CREATE DATABASE`, `CREATE LOGIN`, `CREATE SEQUENCE`, `ALTER ROLE`, `GRANT`, `BACKUP` and the
  like), which are mostly options, only the names are bracketed: `ALTER ROLE r ADD MEMBER u` becomes
  `ALTER ROLE [r] ADD MEMBER [u]`.
- **Move Commas to Front** moves each comma that ends a line to the start of the next item's line, into the last space of
  its indent as Select Top Rows writes columns (`      ,[b]`); **Move Commas to End** moves each comma that starts a line
  to the end of the item before it, ahead of a trailing comment. They act on the selection, or on the statement around the
  caret (between semicolons, `GO` lines and blank lines), in SELECT lists, GROUP BY, ORDER BY, INSERT column lists,
  VALUES rows, parameter lists and any other comma-separated list. A comma alone on its line moves with its line; commas in
  the middle of a line, and those next to a parenthesis, a semicolon or `GO`, stay where they are.

Nothing to change shows a short status-bar message. A query longer than 1,000,000 characters is not changed.

### Error checking

Runs after a 500 ms editing pause without executing the query. Syntax and catalog-binding errors (missing columns,
unknown aliases) show as red squiggles, provider warnings yellow. Hover for the message, or use **Alt+F8** /
**Alt+Shift+F8** and **Edit › IntelliSense › Next/Previous SQL Issue**. The status bar reports progress, failures and
error/warning counts. Turn it off in **Tools › Options › Text Editor › Transact-SQL › IntelliSense › Enable error
checking**.

- Every edit clears obsolete markers; only results matching the current model version, connection context and backend
  generation show.
- At most 1,000 issues, with an explicit incomplete status when capped.
- Unconnected queries get syntax analysis; name resolution needs a supported live connection.
- These are static checks: dynamic SQL and session-local objects are outside the separate metadata connection.

### Refresh Local Cache

**Ctrl+Shift+R** (**Command+Shift+R** on macOS), **Edit › IntelliSense › Refresh Local Cache** or the palette rebuilds
the query's metadata cache after schema changes, for its provider, connection and database (or BigQuery datasets). It
preserves unsaved SQL, execution sessions, transactions and temporary tables. On SQL Server it calls `language.refresh`,
which refreshes the database in the Search Objects index (via fingerprint + selective reload, or a full index build if
unindexed), clears the renderer's `LookupCache`, and resets the STS diagnostic child so error checking picks up schema
changes too; on BigQuery it clears the connection's `LookupCache` immediately and runs a scoped `explorer.index` refresh
for the datasets referenced by the tab (or its default dataset and billing project). The status bar shows
`SQL: Refreshing` (`IntelliSense refreshing`) and failures; changing the query's target, disconnecting or closing it
discards an obsolete result.

### Authentication

SQL Server **completion, hover, Go To Definition, and Refresh Local Cache** support **SQL Login, Windows Authentication,
and Microsoft Entra ID** (using Varia's own connection pools and Search Objects index). Live SQL error checking
(diagnostics) still uses SQL Tools Service's separate process and therefore supports SQL Login and Windows authentication
until Phase 2 replaces STS diagnostics; Microsoft Entra ID tabs cleanly pause error checking while keeping completion,
hover, and cache refresh active.

## Completion from the index

A BigQuery tab has no language server: completion and hover are Varia's own, read from the connection's Search Objects
index ([object-search.md](object-search.md#bigquery)) in the backend's memory through `language.lookup`
([ipc.md](ipc.md)). Nothing is sent to Google and nothing is billed. SQL Server tabs keep SQL Tools.

- **Pipeline.** `src/shared/completion/` knows no engine: a grammar reads the caret's statement into a site (an object
  name, a member after a dot, an expression, or a clause site such as `afterFromTable`, `statementStart`, `castType`,
  `datePart`, `systemVar`, `infoSchema`, `joinCondition`, or `unnestArg`) and its scope; `resolve.ts` asks the index for
  the objects the scope names; `complete.ts` and `hover.ts` build the items. A dialect gives quoting, clause-specific
  keywords, how a written name becomes an index path, keywords and functions. GoogleSQL's are
  `src/shared/googlesql/scope.ts` (the reader) and `dialect.ts`.
- **Objects and cross-project jump.** After `FROM`, `JOIN`, a comma in `FROM` (after a join condition too), `CALL`, `UPDATE`, `INTO`, `TABLE`, `MERGE` and `USING`: the statement's
  `WITH` names, the default dataset's objects, the billing project's datasets and all indexed projects ranked
  **Billing → ★ Starred → Recently Queried → Discovered** (with clear tier descriptions including `Names only · memory cap`
  and `Wave 3 indexing…`; Billing and Starred projects are never truncated behind the 500-item page cap). Once 2 or more
  characters are typed at an unqualified `FROM`/`JOIN` position, a bounded cross-project fuzzy jump (`mode: 'jump'`, up to
  50 hits in RAM) surfaces matching tables, views, routines and models across indexed datasets ranked **Default dataset →
  Billing → ★ Starred → Recently Queried → Discovered**, inserting compact `dataset.table` for the billing project or
  `` `project.dataset.table` `` for cross-project matches. `x.` lists a project's
  datasets or the billing project's dataset `x`'s objects; `x.y.` that dataset's objects. A date-sharded group suggests
  its wildcard (`events_*`, `Wildcard · N shards, first–last`) ahead of its latest concrete shard (`events_YYYYMMDD`),
  and querying a wildcard (`events_*`) or a concrete shard within the range reads the newest shard's columns
  (`events_*` reads the `events_YYYYMMDD` group even beside `events_summary`; `ev*` over two groups, or a group and a
  table, reads none). Hyphenated project and table identifiers (`my-proj-2`) use a hyphen-safe `wordPattern` so typing
  or filtering across `-` keeps suggestions anchored without breaking subtraction expressions.
- **On-demand JIT hydration.** When **Options › Text Editor › GoogleSQL › Fetch schemas on demand for tables without
  indexed columns** (`textEditor.googleSql.jitHydrate`, on by default) is enabled and a query references a table or routine
  in a tracked project whose columns have not been indexed yet (Wave 3 still running or stopped at the memory cap),
  IntelliSense fetches just that object via `language.hydrate` (free REST `tables.get` / `routines.get`, never billed,
  rate-limited and cached under the shared 512 MiB memory budget with a 2-minute negative cache for 404/403). Unstarred
  external/public projects (such as `bigquery-public-data`) are never fetched automatically; completion and hover offer
  one-click **Fetch schema (free)** and **★ Star project** actions instead.
- **BigQuery pseudo-columns.** Wildcard table references (`events_*`) automatically include `_TABLE_SUFFIX` (`STRING`),
  ingestion-time partitioned tables include `_PARTITIONTIME` (`TIMESTAMP`) and `_PARTITIONDATE` (`DATE`), and external
  tables include `_FILE_NAME` (`STRING`). Pseudo-columns are excluded from `SELECT *` expansion in CTEs and subqueries.
- **Clause keywords, smart context sites and function snippets.** After a `FROM` or `JOIN` table, subquery, `UNNEST`, or alias (`afterFromTable`),
  only valid `FROM`-clause continuations are suggested (`AS` when unaliased, `ON`/`USING` inside `JOIN`, `WHERE`, joins,
  `GROUP BY`, `ORDER BY`, `TABLESAMPLE`, etc. — never `TABLE`, `ABORT`, or data types). At `statementStart` only statement
  starters are suggested; inside `CAST(… AS` / `SAFE_CAST(… AS` (`castType`) only the 22 GoogleSQL types and
  `ARRAY<>`/`STRUCT<>`/`RANGE<>` snippets; inside `EXTRACT(| FROM …)` and the granularity argument of
  `DATE_TRUNC`/`DATETIME_TRUNC`/`TIMESTAMP_TRUNC`/`TIME_TRUNC`/`DATE_DIFF`/`DATETIME_DIFF`/`TIMESTAMP_DIFF`/`TIME_DIFF`/`LAST_DAY`
  (`datePart`) only the valid date/time parts for that function; after `@@` (`systemVar`, with `@` as a trigger character
  while keeping single `@` query parameters quiet) curated BigQuery system variables (`@@project_id`, `@@dataset_id`,
  `@@script.bytes_billed`, `@@error.message`, etc., plus dotted namespace members after `@@script.`/`@@error.`); and after
  `INFORMATION_SCHEMA.` (`infoSchema`) curated metadata views filtered and badged by dataset vs. region scope.
  Non-niladic functions and routines insert `NAME($0)` (skipping `(` if already ahead on the same line) and trigger
  Signature Help (`editor.action.triggerParameterHints`); niladic functions (`CURRENT_DATE`, `CURRENT_TIMESTAMP`, etc.)
  stay bare.
- **Expressions, joins and `ARRAY<STRUCT>` / `UNNEST`.** The columns of every source in scope, the scope's aliases, functions and keywords.
  When two or more in-scope sources share a column name (`id`), unqualified completion emits qualified items (`o.id`, `c.id`,
  each filterable by `id`) instead of dropping the second source's column. `alias.` lists that source's columns,
  `alias.record.` a `STRUCT`'s fields, `NET.` (and the other namespaces) their functions, and `SAFE.` any function.
  Direct dot access on an `ARRAY<STRUCT>` column (`o.items.`) blocks invalid field suggestions and offers an actionable
  `UNNEST(o.items)` replacement instead; inside `UNNEST(…)` (`unnestArg` and `UNNEST(o.|)`), `ARRAY<…>` columns rank at
  the top ahead of scalar columns and keywords.
- **Scope.** `FROM` and `JOIN` items with or without `AS` (after `FOR SYSTEM_TIME AS OF` and `TABLESAMPLE` too), dashed
  projects written without backticks, comma joins, `UNNEST(…) AS x` and an earlier item's array (`FROM orders o, o.items`), subqueries (by their select
  list's names and stars), `WITH` queries (each sees only the ones before it, so one may read the table it shadows), set operations and outer queries' sources.
  An unqualified table is in the tab's default dataset of the connection's billing project.
- **Names** are inserted as GoogleSQL takes them: bare when plain and not reserved, else in backticks. Accepting a leaf
  identifier (`table`, `view`, `routine`, `model`, `column`, `field`, `cte`, `alias`) inside auto-closed `` `…` ``
  consumes the trailing closing backtick so the caret exits cleanly; accepting a container (`project`, `dataset`) keeps
  the caret inside so `.` chaining continues.
- **Hover.** 3-level BigQuery hover: hovering a **project** segment shows its PR #738 tier (`Billing`, `★ Starred`, or
  `Discovered`), dataset counts, names-only/memory-cap state, and star/refresh hints; hovering a **dataset** shows its
  location (when known), object counts by kind, and sample objects; hovering a **table** or **view** shows its kind,
  tier, path, rows, size, partitioning, clustering, shards, description, and top-level columns with nested `STRUCT` field
  counts (`STRUCT · 3 fields: city, state, geo`, first 40 columns); a routine shows its signature; a column or field shows
  type, REQUIRED and description; an alias or `WITH` name shows what it reads; a function shows its signatures.
- **Index state.** While the index builds, every index-reading list is incomplete, so names read later appear as the word
  grows; the first request on a connection that was never indexed starts a build when Options allows builds on connect.
  `IndexCompletionService` subscribes to `ObjectSearchService` so index builds, manual refreshes, and DDL-stale updates
  invalidate that connection's `LookupCache` immediately (with a generation guard blocking stale in-flight writes). A project
  read by name only has datasets and tables but no columns. The status bar's IntelliSense item says when the index is
  building, refreshing, unbuilt, unreachable or the tab is disconnected (keywords and functions only).
- **Limits.** `language.lookup` takes 16 paths a request and answers 500 items a path by default (2,000 at most, 4,000
  items or 12 MiB estimated UTF-8/MessagePack bytes in all); the renderer keeps answers per connection for 15 seconds (256 at most) and sends at most 4 lookups at once.
  Documents over 250,000 characters get none, and subqueries nested (or `WITH` queries chained through `*`) more than 64
  deep give no columns. One completion merges at most a million `*` columns across its `WITH` queries and subqueries;
  past that the list is incomplete. A table wider than its share is asked again by what is typed (up to 4 prefixes, and
  the first 16 `UNNEST`s' element fields). An `INSERT`'s target lends its columns only to its column list.

## Source builds and packaging

`npm run dev`, `npm run build`, `npm start` and `npm run build:smoke` prepare the pinned runtime first. The first run
downloads the upstream archive; later runs verify and reuse it. Transient failures get up to three attempts within one
three-minute budget, the last through the pinned asset's official GitHub API download, checksum unchanged.
`npm run package` prepares its platform in `beforePack`; release CI prepares it explicitly ([packaging locally](ci.md#packaging-locally)).

The pin and per-platform SHA-256 hashes are in `build/sqltools-service.json`. Preparation verifies the archive before
extraction, keeps the whole runtime and upstream notices, adds the component's MIT license and records each file's hash.
Packaged checks verify this inventory and start the real language server with developer overrides cleared.

```sh
npm run sqltools:prepare
node scripts/prepare-sqltools-service.mjs --rid linux-x64
node scripts/prepare-sqltools-service.mjs --check
```

- Offline builds can pass `--archive /absolute/path/to/the-pinned-archive`; it must match the checked-in hash.
- Prepared runtimes live under `artifacts/sqltools-service/<rid>` and ship under `resources/sqltools-service`, beside
  the backend. The application never downloads a runtime while running.
- `VARIA_SQLTOOLS_SERVICE_PATH` overrides discovery: an absolute path to `MicrosoftSqlToolsServiceLayer.exe` on Windows
  or `MicrosoftSqlToolsServiceLayer` elsewhere, with its distribution files beside it. A nonempty override is
  authoritative even when invalid; clear it to use the bundled runtime. Pages and SQL documents cannot choose an
  executable, arguments or shell command.

## Boundaries

1. Monaco turns its model, cursor and cancellation state into database-neutral requests: document id and version, text,
   a UTF-16 position, and a context naming provider and connection.
2. Varia's validated IPC carries only the supported language operations; the renderer gets no general JSON-RPC interface
   and none of SQL Tools' connection or execution methods.
3. A backend provider owns server setup, document synchronization and database-specific connection behaviour. The shared
   LSP client owns the child process, UTF-8 `Content-Length` framing, request correlation, cancellation and disposal.

The language context reserves separate fields for database/default schema and project/dataset, so PostgreSQL (search
path) or BigQuery (project, dataset) can supply their own; each must define its own authentication, quoting, catalog
interpretation and capabilities. The reserved identifiers do not enable those engines. Implement a second provider
before promoting any SQL Server-specific assumption into the common contract.

- Each query document has a stable model URI, kept when an editor group switches models or floats. Completion and hover
  resolve the requesting model, not the active query. Responses are discarded after an edit, context change, close,
  cancellation or backend-generation change. Query editors stay in the main OS window; other panels support
  [OS popouts](popout-windows.md).
- Credentials stay in the backend. SQL Tools keeps its own database connection, not a query tab's session, so temporary
  tables, session variables, uncommitted changes and session SET options are invisible to it, and background analysis
  cannot interfere with a running query or transaction.
- The SQL Server adapter opens the buffer before connecting, waits for metadata readiness and retries transient busy
  completion responses within a deadline. It sends explicit UTF-16 replacement ranges and refreshes its parse tree before
  hovering changed text. Service file tracing is off; stderr is drained without logging.
- The executable and arguments come only from the trusted application.

## Scope and limits

- Implemented: in-process `ScriptDom` + `IndexLookup` SQL Server completion and 3-level hover (all auth modes including
  **Microsoft Entra ID**), lazy completion-item schema previews (via local Search Objects `language.lookup` on both
  BigQuery and SQL Server), syntax/catalog diagnostics (SQL Login & Windows via isolated STS child), metadata-cache
  refresh, Go To Definition, and unified status bar IntelliSense popover. Not yet: formatting, signature help, Entra ID
  error squiggles (Phase 2).
- Documents above 250,000 UTF-16 code units edit and execute normally without language requests.
- Completion keeps at most 128 documents and returns at most 500 items per response (and 1,000,000 aggregate characters),
  prioritizing FK join suggestions, exact matches, and columns before truncation so later catalog names stay reachable.
- When `objectExplorer.search.indexOnConnect` is off or a database is `CHILDREN_LEFT_OUT`, `Skipped`, or `Absent`,
  completion continues serving keywords, built-in functions, `@@` globals, `#temp` tables, `@vars`, and CTEs, while the
  status bar popover surfaces a one-click **Build index** / **Refresh index** action.
- A missing SQL Tools Service executable leaves error checking unavailable; ScriptDom completion, hover, editing, and
  execution still work.

### Documents and processes

- **Document cap.** The broker tracks at most 128 documents. A new one waits for a close under way; otherwise the least
  recently used document with no request in progress is released. Only when all 128 have requests in progress is the new
  one refused as busy.
- **No completion child process.** SQL Server completion, hover, and cache refresh run strictly in-process in the .NET
  backend (~1 ms) using `ScriptDom` + `IndexLookup`; zero interactive SQL Tools Service completion child processes are
  spawned.
- **Analysis child.** Diagnostics run in one separate, serialized SQL Tools child with an immutable URI per snapshot,
  because SQL Tools publishes unversioned diagnostics with a shared debounce. Completion and hover preempt pending
  analysis for their document; error checking resumes after them. At most one diagnostic context is kept (briefly two
  snapshot connections during rollover). The child retires on close, disconnect, relevant refresh, context change, 128
  snapshots, 8,000,000 cumulative snapshot UTF-16 code units, reset, or 60 seconds idle. The broker keeps fingerprints,
  not buffer copies.
- **Management actions** pause language requests and release metadata connections so IntelliSense cannot keep a database
  in use during rename, detach, restore and similar; the next request rebuilds the context. The pause covers all
  providers.

## Live validation

Use a disposable development SQL Server with marked scratch fixtures; the backend suite creates two uniquely named, marked
databases with different columns and drops only its own in `finally`.

```powershell
npm run build:smoke
$env:VARIA_TEST_SQL_SERVER = 'lpc:.' # Windows local instance; use your development server elsewhere.
$env:VARIA_TEST_SQL_SCRATCH = '1'
npm run test:language:live
npm run test:language:ui
```

For SQL authentication also set `VARIA_TEST_SQL_USER` and `VARIA_TEST_SQL_PASSWORD` (never in command arguments). Tests
omit the path override to exercise bundled discovery.

The backend suite covers table/column completion, hover after unsaved edits, external schema changes plus refresh,
identical SQL in different databases, process lifetime, close, disconnect and cleanup; refresh checks preserve a real
session's transaction and temporary table. The UI suites drive Monaco's suggestion and hover widgets in split and floating
groups, switch to a panel's OS popout and back, then refresh and dock back keeping each query's context. CI (`ci.yml`) runs
the backend suite and, on Linux smoke shard 3, the UI suite against its disposable SQL Server 2022 instance; packaging checks verify the bundled distribution and offline
startup.

References: [SQL Tools Service protocol](https://github.com/microsoft/sqltoolsservice/blob/main/docs/guide/jsonrpc_protocol.md),
[Monaco completion API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.languages.CompletionItemProvider.html).
