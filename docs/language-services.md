# SQL language services

Varia supplies completion, hover and query diagnostics through Microsoft SQL Tools Service. SQL Server is the only
provider; the editor-facing contract and transport are provider-neutral so another engine can use a different language
server without changing the Monaco integration.

Installed applications include the matching self-contained runtime for Windows x64, Linux x64, macOS arm64 or macOS x64.
IntelliSense needs no separate installation, path setting or first-launch download.

## Using IntelliSense

- **Completion.** **Ctrl+Space**, or a provider trigger character such as `.`. Suggestions use the query tab's
  connection and database; switching tabs does not change another editor's pending request.
- **Columns** rank ahead of general suggestions of equal match quality. In supported SELECT scopes, unqualified column
  suggestions carry their source qualifier (a self-join offers `t.high` and `b.high`; `hi` matches both). `t.` returns
  only that source's columns. Scope resolution uses a bounded parser and SQL Tools' binder per visible source (temporary
  probe edits are restored before any other request), limited to 16 source qualifiers and a five-second probe budget. An
  incomplete expansion does not bring back ambiguous bare columns.
- **Hover** an identifier for the language server's information.
- Hover and completion widgets can extend beyond a short query panel within the window; each editor owns its widgets
  across split and floating groups, and menus and dialogs stay above them.

### Go To Definition

**F12** scripts the table, view, procedure, function, synonym or user-defined type under the caret as CREATE to a new
query tab; on a column it goes to the column's table, using the statement's aliases. **Alt+F12** opens it in a Peek tab.
**Ctrl+click** (**⌘-click** on macOS; changeable among the Shortcuts page's mouse gestures) does what F12 does. Both keys
work in query tabs and Peek's read-only definition editor. Go To Definition is implemented by Varia's backend, not SQL
Tools.

- Names resolve on the query's connection and database as SQL Server resolves them: three-part names in another
  database; a one-part name in your default schema, then dbo, then sys (`sp_who` finds `sys.sp_who`); a column through
  its own query's aliases, not a subquery's. An earlier `USE` changes the database. A column's XML or CLR method
  (`t.Doc.value(...)`) goes to the column's table.
- CTEs, derived tables, table variables and columns a statement declares have no definition. A name matching nothing, a
  temporary object or a linked server's object shows a short status-bar message, never an error dialog.

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

## Source builds and packaging

`npm run dev`, `npm run build`, `npm start` and `npm run build:smoke` prepare the pinned runtime first. The first run
downloads the upstream archive; later runs verify and reuse it. Transient failures get up to three attempts within one
three-minute budget, the last through the pinned asset's official GitHub API download, checksum unchanged.
`npm run package` prepares its platform in `beforePack`; release CI prepares it explicitly.

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
