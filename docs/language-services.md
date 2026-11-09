# SQL language services

Varia supplies completion, hover information and query diagnostics through Microsoft SQL Tools Service. SQL Server is the first provider. The editor-facing contract and transport are separate from that provider so another database engine can use a different language server without changing the Monaco integration.

Installed applications include the matching self-contained runtime for Windows x64, Linux x64, macOS arm64 or macOS x64. IntelliSense requires no separate installation, executable-path setting or first-launch download.

## Source builds and packaging

`npm run dev`, `npm run build`, `npm start`, and `npm run build:smoke` prepare the pinned runtime before launching or building. The first preparation downloads the upstream archive; subsequent runs verify and reuse the local copy. Transient download failures allow up to three attempts within one three-minute budget, finally using the pinned asset's official GitHub API download while retaining its checksum. `npm run package` prepares its target platform in `beforePack`, and release CI explicitly prepares it before packaging.

```sh
npm ci
npm run dev
```

The pin and platform-specific SHA-256 hashes are in `build/sqltools-service.json`. Preparation verifies the archive before extraction, preserves the entire runtime and upstream notices, adds the component's MIT license, and records each extracted file's hash. Packaged checks verify this inventory and start the real language server with developer overrides cleared.

```sh
npm run sqltools:prepare
node scripts/prepare-sqltools-service.mjs --rid linux-x64
node scripts/prepare-sqltools-service.mjs --check
```

An offline build can pass `--archive /absolute/path/to/the-pinned-archive`; it must still match the checked-in hash. Prepared runtimes live under `artifacts/sqltools-service/<rid>` and ship under `resources/sqltools-service`, beside the backend. The application never downloads a runtime while running.

Developers can override discovery with `VARIA_SQLTOOLS_SERVICE_PATH`, an absolute path to `MicrosoftSqlToolsServiceLayer.exe` on Windows or `MicrosoftSqlToolsServiceLayer` elsewhere. Keep its distribution files beside it. A nonempty override is authoritative, including when invalid; clear it to use the bundled runtime. A page or SQL document cannot choose an executable, arguments, or shell command.

Open a query tab and use **Ctrl+Space** to request suggestions, or type a provider trigger character such as `.`. Hover over an identifier for information supplied by the language server. Suggestions use the query tab's connection and selected database. Changing the active tab does not change the context of another editor's pending request.

Column suggestions rank ahead of general suggestions with the same matching quality. In supported SELECT scopes, unqualified column suggestions carry their source qualifier: a self-join exposes `t.high` and `b.high` independently, and typing `hi` can match both. Typing `t.` uses SQL Tools' normal qualified completion and returns only that source's columns. Scope resolution uses a bounded SQL parser and SQL Tools' binder for each visible source; temporary probe edits are restored before any other request uses that document. Work is limited to 16 source qualifiers and a five-second probe budget. An incomplete expansion does not reintroduce ambiguous bare table columns.

Hover and completion widgets can extend beyond a short query panel while remaining within the window. Each editor owns its widgets across split and floating groups; menus and dialogs stay above them.

SQL error checking runs after a 500 ms editing pause without executing the query. Syntax and catalog-binding errors, including missing columns and unknown aliases, appear as red squiggles; provider warnings appear yellow. Hover for the message, or use **Alt+F8** / **Alt+Shift+F8** and **Edit › IntelliSense › Next/Previous SQL Issue** to navigate the current query. The status bar reports analysis progress, failures and error/warning counts. Turn it off in **Tools › Options › Text Editor › Transact-SQL › IntelliSense › Enable error checking**. Every edit clears obsolete markers immediately; only results matching the current model version, connection context and backend generation are displayed. Results are limited to 1,000 issues, with explicit incomplete status when capped. Unconnected queries receive syntax analysis; database name resolution requires a supported live connection.

Use **Ctrl+Shift+R** (**Command+Shift+R** on macOS), **Edit › IntelliSense › Refresh Local Cache**, or the command palette to rebuild the current query's metadata cache after schema changes. Refresh uses the selected provider, connection and database. It preserves unsaved SQL, query execution sessions, transactions and temporary tables, and waits for the provider's readiness notification before reporting completion. The status bar shows refresh progress and failures. Changing the query's target or closing it discards an obsolete refresh result.

Connected IntelliSense initially supports SQL Login and Windows authentication, using the connection's encryption and certificate settings. Microsoft Entra authentication is not enabled for IntelliSense in this slice: the SQL Tools Service process does not share Varia's token broker. Query execution keeps its existing authentication support.

## Boundaries

The integration has three parts:

1. Monaco translates its model, cursor and cancellation state into database-neutral language requests. Requests contain a document identifier and version, its text, a UTF-16 position, and a context identifying the provider and connection.
2. Varia's validated IPC carries only the supported language operations. The renderer does not receive a general JSON-RPC interface or SQL Tools Service's connection and execution methods.
3. A backend provider owns language-server setup, document synchronization and database-specific connection behavior. The shared LSP client owns the child process, UTF-8 `Content-Length` framing, request correlation, cancellation and process disposal.

Language context reserves separate fields for database/default schema and project/dataset. SQL Server uses database context; PostgreSQL can later supply its own search-path behavior, and BigQuery can supply project and dataset behavior. Those providers must define their own authentication, quoting, catalog interpretation and language capabilities. An identifier in the contract does not mean that engine is implemented.

Each query document has a stable model URI. The same document retains its identity when an editor group switches models or floats within the editor area. Completion and hover resolve the model that requested them, rather than reading the globally active query. Responses are discarded after a document edit, connection-context change, close, cancellation or backend-generation change. Query editors currently stay in the main OS window; other panels support [OS popouts](popout-windows.md).

Credentials stay in the backend. SQL Tools Service maintains its own database connection for language analysis; it does not share a query tab's execution session. Temporary tables, session variables, uncommitted changes and session-specific SET options from executed queries are therefore unavailable to that connection. This separation also prevents background analysis from interfering with an active query or transaction.

The SQL Server adapter opens the buffer before connecting, waits for metadata readiness, and handles transient busy completion responses within a bounded deadline. It sends explicit UTF-16 replacement ranges for edits and refreshes its cached parse tree before hovering changed text. Service file tracing is disabled, and the transport drains stderr without logging it.

## First-slice scope

- Completion, hover, syntax/catalog diagnostics and explicit metadata-cache refresh are implemented. Formatting, definition navigation, signature help and completion-item resolution are future work.
- SQL Server is the only implemented provider. The reserved PostgreSQL and BigQuery identifiers do not enable those engines.
- Server responses are bounded before reaching the editor. Documents above 250,000 UTF-16 code units retain normal editing and execution behavior without language requests. The provider holds at most 128 documents and 8,000,000 UTF-16 code units in total; a completion response returns at most 500 items. Matching identifiers are prioritized before truncation so names later in a large catalog remain reachable as the user types.
- An absent service executable leaves language support unavailable; query editing and execution remain available.
- The bundled service is pinned and verified at build time. Its executable and arguments come only from the trusted application, never SQL documents or renderer requests.

The child process starts lazily when a language request first needs it. Requests have deadlines; a failed process is reinitialized on a subsequent request, with each document synchronized again from its current full text. A failed availability check is retried on the next completion or hover request after a short cooldown, without requiring a backend restart. Refresh Local Cache can retry immediately. Closing a query or disconnecting its connection releases the corresponding language document and analysis connection.

The pinned service retains some metadata and offline parse caches after document close. When a context's last document closes, or after 128 document closures, the adapter waits for admitted language requests to finish and retires the child. Remaining documents synchronize lazily with a fresh child; query execution sessions are unaffected. Renderer cleanup is bounded and also waits for requests queued behind metadata work, so a late request cannot reopen a closed tab's analysis state. Cleanup retries only explicit pre-dispatch capacity refusals. Persistent overload reports a warning rather than restarting the backend or silently discarding cleanup.

SQL Tools publishes diagnostics asynchronously without document versions and shares its diagnostic debounce across documents. Analysis therefore uses one separate, serialized SQL Tools child with an immutable URI for each snapshot. This prevents completion or hover from cancelling analysis and prevents an earlier snapshot's notification from painting the current query. At most one diagnostic context is retained, briefly two snapshot connections during rollover. The analysis child retires on close, disconnect, relevant cache refresh, context change, 128 snapshots, reset, or 60 seconds idle. Using both analysis and completion can therefore hold two SQL Tools processes; diagnostics alone does not start the completion child. These are static language checks, not a guarantee that SQL will execute successfully; dynamic SQL and query-session-local objects remain outside the separate metadata connection.

Database management actions temporarily pause language requests and release metadata connections so IntelliSense cannot keep a database in use during rename, detach, restore or similar operations. The next language request after the action rebuilds the analysis context. This initial suspension covers all providers; a later version can narrow it to the affected connection and database.

## Next stages

Add Entra token handoff, formatting, signatures and definition navigation. Implement a second provider before promoting any SQL Server-specific assumption into the common contract.

## Live validation

Prepare the build, choose a disposable development SQL Server, and enable marked scratch fixtures. The backend suite creates two uniquely named, marked databases with different columns and drops only its own fixtures in `finally`.

```powershell
npm run build:smoke
$env:VARIA_TEST_SQL_SERVER = 'lpc:.' # Windows local instance; use your development server elsewhere.
$env:VARIA_TEST_SQL_SCRATCH = '1'
npm run test:language:live
npm run test:language:ui
```

For SQL authentication, also set `VARIA_TEST_SQL_USER` and `VARIA_TEST_SQL_PASSWORD`. Do not put passwords in command arguments. Tests omit the executable-path override to exercise bundled discovery.

The backend suite covers live table/column completion, hover after unsaved edits, external schema changes followed by refresh, concurrent documents with identical SQL in different databases, process lifetime, document close, disconnect and fixture cleanup. Refresh checks preserve a real query session's transaction and temporary table. The UI suites exercise Monaco's actual suggestion and hover widgets in split and floating editor groups, switch focus to an existing panel's OS popout and back, then refresh and dock back while preserving each query's context.

On November 8, 2026, the backend and real Monaco UI suites were validated on SQL Server 2025 Developer `17.0.1000.7` using Windows authentication. Release CI also runs the focused backend suite against its disposable SQL Server 2022 instance. Platform packaging checks verify the bundled distribution and offline server startup.

The [SQL Tools Service protocol](https://github.com/microsoft/sqltoolsservice/blob/main/docs/guide/jsonrpc_protocol.md) documents its stdio protocol and Microsoft-specific connection methods. The [Monaco completion API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.languages.CompletionItemProvider.html) defines the editor adapter's model-based provider interface.
