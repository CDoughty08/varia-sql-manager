# SQL language services

Varia supplies completion, hover and query diagnostics through Microsoft SQL Tools Service. SQL Server is the only
provider; the editor-facing contract and transport are provider-neutral so another engine can use a different language
server without changing the Monaco integration. BigQuery queries are GoogleSQL, which SQL Tools never sees; its editor is
described in [googlesql.md](googlesql.md), and it completes from the Search Objects index instead
([Completion from the index](#completion-from-the-index)).

Installed applications include the matching self-contained runtime for Windows x64, Linux x64, macOS arm64 or macOS x64.
IntelliSense needs no separate installation, path setting or first-launch download.

## Using IntelliSense

- **Completion.** **Ctrl+Space**, or a provider trigger character such as `.`. Suggestions use the query tab's
  connection and database; switching tabs does not change another editor's pending request.
- **Exact matches first.** A name that matches the typed word exactly, ignoring case and brackets, is listed and selected
  first, above names that merely start with it, fuzzy matches and system objects. Monaco's own scoring would otherwise
  prefer a prefix in the typed case (`orders` would rank `orders_archive` or a lower-case system view above `Orders`).
  Each list is re-ranked as the word grows: a complete answer is reused for identifier characters typed at the caret,
  and a truncated one is requested again.
- **Brackets.** Every column suggestion shows and inserts its name in brackets (`[bob].[columnName]`, `[Order Date]`);
  the bare name still filters, and so does a name after a typed `[` or `"`. A table or other name that is inserted in
  brackets because it needs quoting also shows its brackets. Accepting a suggestion inside an auto-closed `[...]`
  replaces the whole bracketed word, closing bracket included.
- Because each list is requested again as you type, a list opened with **Ctrl+Space** shows *No suggestions* once
  nothing matches, instead of keeping the last matches.
- A table created after the query's metadata was loaded is not suggested until **Refresh Local Cache** (below).
- **Columns** rank ahead of general suggestions of equal match quality. In supported SELECT scopes, unqualified column
  suggestions carry their source qualifier (a self-join offers `t.[high]` and `b.[high]`; `hi` matches both). `t.` returns
  only that source's columns. Scope resolution uses a bounded parser and SQL Tools' binder per visible source (temporary
  probe edits are restored before any other request), limited to 16 source qualifiers and a five-second probe budget. An
  incomplete expansion does not bring back ambiguous bare columns.
- **Hover** an identifier for the language server's information.
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
the query's metadata cache after schema changes, for its provider, connection and database. It preserves unsaved SQL,
execution sessions, transactions and temporary tables, and waits for the provider's readiness notification before
reporting completion. The status bar shows progress and failures; changing the query's target or closing it discards an
obsolete result.

### Authentication

Connected IntelliSense supports SQL Login and Windows authentication with the connection's encryption and certificate
settings. Microsoft Entra authentication is not supported for IntelliSense (SQL Tools Service does not share Varia's
token broker); query execution is unaffected.

## Completion from the index

A BigQuery tab has no language server: completion and hover are Varia's own, read from the connection's Search Objects
index ([object-search.md](object-search.md#bigquery)) in the backend's memory through `language.lookup`
([ipc.md](ipc.md)). Nothing is sent to Google and nothing is billed. SQL Server tabs keep SQL Tools.

- **Pipeline.** `src/shared/completion/` knows no engine: a grammar reads the caret's statement into a site (an object
  name, a member after a dot, an expression or a keyword) and its scope; `resolve.ts` asks the index for the objects the
  scope names; `complete.ts` and `hover.ts` build the items. A dialect gives quoting, how a written name becomes an
  index path, keywords and functions. GoogleSQL's are `src/shared/googlesql/scope.ts` (the reader) and `dialect.ts`.
- **Objects.** After `FROM`, `JOIN`, a comma in `FROM` (after a join condition too), `UPDATE`, `INTO`, `TABLE`, `MERGE` and `USING`: the statement's
  `WITH` names, the default dataset's objects, the billing project's datasets and all indexed projects (billing, starred
  and discovered accessible projects). `x.` lists a project's
  datasets or the billing project's dataset `x`'s objects; `x.y.` that dataset's objects. A date-sharded group is one
  item with its range, and a wildcard (`events_*`) or one of its shards within the range reads the newest shard's columns
  (`events_*` reads the `events_YYYYMMDD` group even beside `events_summary`; `ev*` over two groups, or a group and a
  table, reads none).
- **Expressions.** The columns of every source in scope, the scope's aliases, functions and keywords. `alias.` lists that
  source's columns, `alias.record.` a STRUCT's fields, `NET.` (and the other namespaces) their functions, and `SAFE.` any
  function. After `CAST(… AS`, types and keywords.
- **Scope.** `FROM` and `JOIN` items with or without `AS` (after `FOR SYSTEM_TIME AS OF` and `TABLESAMPLE` too), dashed
  projects written without backticks, comma joins, `UNNEST(…) AS x` and an earlier item's array (`FROM orders o, o.items`), subqueries (by their select
  list's names and stars), `WITH` queries (each sees only the ones before it, so one may read the table it shadows), set operations and outer queries' sources.
  An unqualified table is in the tab's default dataset of the connection's billing project.
- **Names** are inserted as GoogleSQL takes them: bare when plain and not reserved, else in backticks.
- **Hover.** A table or view: its kind and path, rows, size, partitioning, clustering, shards and top-level columns with
  types (the first 40); a routine's signature; a column or field: type, REQUIRED and description; an alias or `WITH`
  name: what it reads; a function: its signatures.
- **Index state.** While the index builds, every list is incomplete, so names read later appear as the word grows; the
  first request on a connection that was never indexed starts a build when Options allows builds on connect. A project
  read by name only has datasets and tables but no columns. The status bar's IntelliSense item says when the index is
  building, unbuilt, unreachable or the tab is disconnected (keywords and functions only).
- **Limits.** `language.lookup` takes 16 paths a request and answers 500 items a path by default (2,000 at most, 4,000
  in all); the renderer keeps answers per connection for 15 seconds (256 at most) and sends at most 4 lookups at once.
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

- Implemented: completion, hover, syntax/catalog diagnostics, metadata-cache refresh, Go To Definition. Not yet:
  formatting, signature help, completion-item resolution, Entra IntelliSense.
- Documents above 250,000 UTF-16 code units edit and execute normally without language requests.
- Completion keeps at most 128 documents and 8,000,000 UTF-16 code units in total, and returns at most 500 items per
  response, prioritizing matching identifiers before truncation so later catalog names stay reachable.
- A missing service executable leaves language support unavailable; editing and execution still work.

### Documents and processes

- **Document cap.** The broker tracks at most 128 documents. A new one waits for a close under way; otherwise the least
  recently used document with no request in progress is released (it reopens from full text on its next request). Only
  when all 128 have requests in progress is the new one refused as busy.
- **Notification queue.** Bounded by 8,388,608 characters (each notification counted at its parameters' length plus 512);
  passing the bound stops the child, which is reinitialized.
- **Lifetime.** The child starts on the first request that needs it; the first-launch welcome query is not analysed until
  edited. Requests have deadlines; a failed process is reinitialized on a later request, resynchronizing each document
  from full text. A failed availability check is retried on the next completion or hover after a short cooldown;
  Refresh Local Cache retries at once. Closing a query or disconnecting releases its document and analysis connection.
- **Retirement.** When a context's last document closes, or after 128 closures, the adapter waits for admitted requests and
  retires the child (the pinned service keeps caches after close); remaining documents resync lazily. Renderer cleanup is
  bounded, waits for requests queued behind metadata work, and retries only explicit pre-dispatch capacity refusals;
  persistent overload reports a warning.
- **Analysis child.** Diagnostics run in one separate, serialized SQL Tools child with an immutable URI per snapshot,
  because SQL Tools publishes unversioned diagnostics with a shared debounce. Completion and hover preempt pending
  analysis for their document; error checking resumes after them. At most one diagnostic context is kept (briefly two
  snapshot connections during rollover). The child retires on close, disconnect, relevant refresh, context change, 128
  snapshots, 8,000,000 cumulative snapshot UTF-16 code units, reset, or 60 seconds idle. The broker keeps fingerprints,
  not buffer copies. Analysis and completion together can hold two processes; diagnostics alone does not start the
  completion child.
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
