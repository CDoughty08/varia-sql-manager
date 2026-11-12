# Architecture invariants

The full rules behind the summary in CLAUDE.md. Each area's own page in docs/ has its user-facing behaviour; this page
holds the rules code must keep. Update the bullet here when a rule changes, and CLAUDE.md only when a summary line stops
being true.


- The renderer is untrusted: context isolation, sandbox, no Node integration, CSP, blocked navigation and popups.
  It reaches the system only through `window.varia` (`src/preload/index.ts`); never expose generic IPC or shell APIs,
  and never disable the Chromium sandbox. Main verifies every IPC sender (`trusted()` in `src/main/index.ts`, which
  accepts only `app://varia/index.html` in built apps). Built pages load only from the privileged `app://varia/` scheme
  (`src/main/app-protocol.ts`: files under `out/renderer` alone, traversal refused), never `file:`, whose origin reaches
  every local file. Packaged builds set the Electron fuses in `build/fuses.cjs` (flipped in afterPack, read back by
  `scripts/packaged-smoke.mjs`): no `file:` privileges, RunAsNode, `NODE_OPTIONS` or `--inspect`; asar only, integrity
  checked.
  The only window the page may open is a popout (`src/main/popout-windows.ts`, docs/popout-windows.md): a same-origin
  `about:blank` child named `varia-popout-<uuid>` with exact bounds on a display, explicit preferences (no preload,
  sandboxed, isolated), no popups or navigation of its own, closed with the page. Its content is the page's DOM through
  React portals, so it sends no IPC, and `trusted()` still accepts only the main window's main frame.
- A backend method must be added in all five places: `RpcMethods` in `src/shared/contracts.ts`, a strict zod schema in
  `requestSchemas` (`src/main/validation.ts`), a `methodPolicies` entry (`src/shared/ipc/methods.ts`), a preload method,
  and a `SqlService.DispatchAsync` case plus its `MethodNames` entry, with its record in `backend/Varia.Backend/Contracts.cs`.
  Unknown methods and unknown members are rejected on both sides; main refuses a backend whose HELLO lacks a method.
- SQL language features belong to each Monaco model, never the globally active editor. The engine-neutral broker and
  context contract route to provider-specific adapters; SQL Server authentication, metadata readiness and dialect rules
  stay in its adapter. Only typed language operations cross IPC. Executables and arguments come from the trusted app;
  packaged SQL Tools Service is a pinned, checksum-verified build artifact, and the app never downloads one at runtime.
  Metadata uses independent connections, stale responses are discarded, and management actions release those connections.
  Service tracing is disabled so upstream exception logging cannot persist document text or connection details.
  Diagnostics carry their model version and use a dedicated marker owner; edits, context changes and backend loss clear
  obsolete markers immediately. SQL Tools' unversioned diagnostic notifications are correlated to immutable snapshot URIs
  on a serialized analysis child, isolated from completion's global debounce. Its retained context and idle/churn lifetime
  are bounded and released on close, disconnect, reset and relevant cache refresh. Foreground language requests preempt
  background diagnostics for their document; analysis resumes after those requests settle. Analysis never executes the buffer.
  A language server child is killed only through `ExitGate`, which the backend's exit also takes: .NET's tree kill stops a
  process (SIGSTOP) before it kills it, and an exit in between would leave the child stopped for good. The gate cannot
  cover a backend that main kills, so only Windows kills the child's tree (`LspClient.KillsTree`); Linux and macOS send the
  one signal, which has no stopped state.
  The service serves query documents' models and Peek's read-only definition models (`peekModelContext`: connection,
  database and the model's own UUID as its document id), and nothing else. A Peek model gets hover only, never completion
  or diagnostics; it is served from its first request, and its `onWillDispose` ends it as closing a query does (epoch bump,
  context, epoch and listener dropped, `language.close` if it was used). Requests in flight are capped per kind
  (`pendingLimits`): every Peek navigation makes a new document, so Peek has its own renderer cap of 2, apart from query
  documents' 8. On the backend its requests still share the metadata slots (`ProtocolHost.MetadataSlots`) with query tabs,
  Script As, `actions.describe` and `connections.connect`, so stalled Peek hovers can hold two of them until their deadline.
  A server-level object has no database, so its names resolve in the login's default.
- Backend stdout carries protocol v2 frames only (`Console.Out` goes to stderr). Never log SQL text, credentials, or
  connection strings. Passwords never reach disk in clear: not `connections.json`, process arguments, the environment,
  logs, traces or previews. A password the user chose to remember is stored only as Electron `safeStorage` ciphertext
  (async API only, in `src/main/secret-cipher.ts`) in `saved-passwords.json` (atomic, 0600, quarantined if unreadable),
  keyed by its history entry's id and bound to its server, login and TLS settings by a hash beside it and a check inside
  the ciphertext. Only main reads that file or decrypts; the renderer learns only which entries have one, and main injects
  it into `connections.connect`/`.databases` only for a matching binding. Remember password is disabled where
  safeStorage is unavailable, Linux's backend is `basic_text`/`unknown`, or its keyring cannot be reached (Electron's
  fallback key, tag `v10`; only `v11`/`v12` count, not yet confirmed on a Linux desktop, so any other tag disables it).
  Microsoft Entra tokens stay in the backend's memory for its lifetime (MSAL and Azure.Identity through Varia's own
  `SqlAuthenticationProvider`, `backend/Varia.Backend/Entra/`): never on disk, in logs or messages, and never sent to
  main or the renderer. Only connect and Load databases open a browser sign-in, under the request's token
  (Stop); sign-in hosts and token resources the server names are allowlisted. New Login's password lives only in `ObjectDialogService`'s secret slot (`setSecret`, never the snapshot), travels only in the sensitive `actions.execute`, reaches SQL only as one parameter read inside a constant batch, is scrubbed from replies, and Script writes `<password>` instead.
- Query rows stay in backend memory (never on disk) under the result budget. Main forwards DATA pages undecoded, as
  exact-size ArrayBuffers (`toExactArrayBuffer`); only the results worker decodes them (`decodePage`). Peek's Top rows are no
  exception: Select Top Rows' script with N = 10 through `query.execute`, in a session and results entry of the Peek's own
  (`PeekService`), released when its card or tab closes, moves on or refreshes, and on backend loss. Results-port
  messages from the renderer are validated with `portRequestSchema`, ownership, and the current generation.
- Rows are compared only in the backend: row identities for highlights (`Results/RowIdentity.cs`, `results.identify`,
  `results.findRows`) hash collation-normalized values there, and the renderer only receives positions and ids, never rows
  to compare. `GridView` draws highlights from sorted positions by binary search per painted row, with theme colours only.
  Result diffs (`Results/ResultDiff.cs`, `results.diff`) align and compare rows in the backend too and store the unified
  diff as a new derived result of the same query; the grid reads it like any result and marks its rows and cells from its
  hidden tone column. Pivots (`Results/ResultPivot.cs`, `results.pivot`) group and aggregate a result's or a view's rows in
  the backend too and store a derived set (`ResultStore.Open(derived: true)`): its working memory comes out of the query's
  budget, a pivot past its bounds is refused rather than shown in part,
  and main owns it only once it has the answer (one not sent is released at once). Transposes (`Results/ResultTranspose.cs`,
  `results.transpose`) copy a result's or a view's cells, columns as rows, into a derived set the same way; they take at
  most 4,095 rows (never more columns than a page holds) and at most 4,000,000 cells (fewer rows for a wide result), the
  first ones with explicit truncation. A derived set (a diff, a pivot, a transpose) is stored whole or not at all, and
  its own refusals never stop its query's budget: a row the budget refuses, or a page sealed under low system memory with
  rows still to store, fails only that set (`TOO_LARGE`), so a smaller one can still fit. Only a query's own sets stop its
  budget (the query or global budget full, or low system memory at a page seal; a row limit never does); while a query is
  still reading, what a derived build holds counts against that budget like anything else. A derived set asked of a
  stopped query is refused before any work with `BUDGET_STOPPED` and a sentence for why it stopped, and one refused
  memory or cut short because its query stopped, or its source was released, while it was built answers that
  (`BUDGET_STOPPED`, `RESULT_RELEASED`), not `TOO_LARGE`. Nothing looks again once the set is written whole: a source
  closed during the write still leaves its derived set.
- The grid renders cells only through `GridView` pools, and text only through `nodeValue` (`tests/grid-lint.test.ts`
  forbids HTML sinks under `grid/`, `results/`, `designer/` and `live/`); no React per row or cell, and frames stay
  O(visible cells).
  `GridView` works in drawn rows and columns for geometry, pools and scrolling, and meets the result's own rows and columns
  at named seams (its `selection`/`select`, `sourceRange`, a cell's lookup in `paintCell`, `targetOf`, `buttonColumn`, Open
  Value and Fit), each the identity in a table; its saved state, marks and callbacks are always in the result's. Columns
  are placed through `ColumnAxis` (`grid/layout.ts`) and tiles have a `TileShape` (`grid/tiles.ts`). A menu's row and column
  come from the grid (`gridTarget`, `grid/anchor.ts`); an ARIA index is read only where no `GridView` is registered.
  `tests/grid-view.test.ts` holds the seams.
  Transposed is an orientation of that grid, not a stored result: `GridView`'s `transposed` option swaps rows with columns
  at every seam and nowhere else (`rotateSelection`, its own inverse; tiles of 32 rows by 128 columns), so nothing outside
  the grid converts coordinates and no code may turn them a second time. It draws the first `limits.transpose.maxRows`
  rows as columns, placed by `UniformLayout` (`grid/uniform-layout.ts`: one shared width of at most 240 px and at most 256
  widths of their own, which a new sort or filter clears, so growth while rows stream rebuilds nothing), and the columns as
  rows named in the frozen first column, whose name cells hold the sort buttons and funnels. A highlighted row tints its
  drawn column through pooled bands and colours that column's header, which also carries the row-size bar; a search match
  past the cap is reported (`onBeyondCap`) and never scrolled to. The orientation, the header column and the transposed
  view's own offsets and widths are per view in `GridViewState` (`orientation`, `headerColumn`, `transposed`); the option is
  fixed for a view's life, so a change builds the grid again. `ResultsService.setOrientation` is the only writer of the
  orientation and the header column: the transpose commands (`contributions/transpose.ts`) call it, it publishes, and
  `ResultGrid` reads `orientation()`. Its `turned` store (the focused grid of each tab, when transposed) feeds the
  `resultsGridTransposed` key and the toolbar; a grid's own menu reads that grid's orientation from its target
  (`argsFor`'s stand-in state), so a Peek card's grid toggles too. Fit Column on a transposed grid fits the target's row
  (`fitDrawn`), or the name column for a name. The stored transpose (`results.transpose`, `TransposeService`) is no longer
  reached by any command and is removed separately; Copy and Save do not write the transposed text yet. A result with a
  tone column (a comparison, a live table) is never transposed. `tests/grid-orientation.test.ts`,
  `tests/results-orientation.test.ts` and `tests/results-toolbar-transpose.test.ts` hold this.
  Live tables show through `LiveGrid` (`src/renderer/src/live/`), which swaps each revision into its `GridView`; a table's row
  tone column (catalogue `role: 'tone'`, its last) is hidden by the grid and left out of Copy and Save (`ResultJobs`).
- Copy and Save text is formatted only by `ResultTextWriter`; export paths come only from main's save dialog and never
  leave main except to the backend.
- Results are released on re-execute, tab close, Close Results, closing one result and backend loss; jobs lease them.
- Every way a result leaves its run goes through one cleanup, `ResultsService.drop`: closing one entry (`removeEntry`, a
  stack caption's close button, on an ended run only), Close Results, a new run and the tab closing. It aborts the entry's
  sort or filter being built, forgets its held views, sort, distinct snapshots, grid controller and state and its part of
  the stack's state, cancels a copy of it (a save the backend accepted finishes under its lease), and releases the stored
  results in one request, after a retained-plan copy in progress has read them. Add a new piece of per-entry state there,
  not in a caller. Services that follow the results give up their own work on an entry that has gone when the snapshot
  loses it (`PivotService`, `TransposeService` and `CompareService` abort a build whose source closed; search re-searches
  only the grids whose target changed; highlights unbind), and `addSet` releases a derived result whose source the run no
  longer has, so a late answer is released once and never shown. A derived result outlives a closed source. Closing does
  not change the run's status, summary or row total (which counts the query's own rows, never a derived result's);
  closing the last entry sets `TabResults.emptied`, which keeps the Results view (`hasResultsView`, `OutputPane.tsx`).
- In the renderer a result is an entry of its run, named everywhere by the opaque key `ResultsService` mints for it
  (`EntryKey`, the grid's `data-result-entry`), never by its place in the list: sorts, held views, grid state, the
  stack's weights, collapse and focus, search marks, highlights, panels, commands and menu targets all follow the key, so
  they stay with the entry when one before it goes. A grid's menu target also carries the generation and result id it
  was read from, which the grid commands of `contributions/output.ts` check before acting. Names come from the entry's
  number (`entryName`), not its position. Nothing identifies an entry by its place; the list's order is read only where
  order is the meaning: the stack's layout, Compare with Previous Result, and the order search steps through matches.
- Periodic data (Activity Monitor, SSIS monitoring, Object Explorer status) flows only through the results port's
  `live.subscribe` and `live.update`: the backend schedules, the renderer never polls with timers, and at most one live
  EVENT per subscription is unacknowledged (`creditedEvents`; main counts it against the stream's credit). The results
  worker relays live events undecoded and grants an event's bytes back only once the page has applied it and called the
  stream's `ack` (`ResultClient.live`), never more than the stream's events took. Sources and
  probes live only in `src/shared/live/catalog.ts`; after changing it, regenerate `docs/live.md` and the backend's embedded
  `Live/live-catalog.json` with `npx vitest run tests/live-catalog.test.ts -u`. Writes are never probes. Test-only sources
  (`debug.synthetic`) pass only main's test schemas (unpackaged smoke runs) and a backend with its test hooks. Probe SQL is
  constant text per probe and band in `Live/LiveSql.cs`, or for the Activity Monitor in `Activity/ActivitySql.cs`, run statement
  by statement through `ActivityReader`, where a statement the login may not run fails alone (each offline lint refuses metadata built-ins, temporary tables,
  writes, DDL, transactions, waits, dynamic SQL and TOP without ORDER BY); it runs on its scope's own pool (" - Activity
  Monitor" for server DMVs, " - Integration Services" in the catalog's database for SSISDB) with the scope's prologue
  (READ UNCOMMITTED, or READ COMMITTED for an SSISDB with RCSI; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW), under the live
  gates and one budget per probe (an `ActivityReader` probe's statements share it), and its failures are values that back
  off.
  Views open live data only through `LiveService` (`src/renderer/src/live/`), which pauses hidden views, ends dormant
  ones and follows Reconnect; badges and summaries read `LiveService.peek` and never subscribe by themselves. Charts draw
  only through `ChartView` (`live/ChartView.ts`): a canvas read from the probe's ring, at most one draw a frame and none
  while off screen or hidden, at most two vertices a pixel column, colors only from the theme (its `charts.*` keys and the surface the chart sits on,
  `chartSurfaces` in `src/shared/theme/charts.ts`) or, under forced colors, the system colors as the DOM resolves them. Object
  Explorer's status chips are `background` views (`ExplorerStatusService`, one per connected server and login, owned by
  the pane, sampling in master): at most 8 a window, in slots no other view wants, given up to views the user opens when
  the window's slots are taken or the backend refuses them `BUSY` on that server; they never reload the tree.
  Job progress EVENTs (`results.export`, `actions.execute`, `explorer.index`) are droppable, per-request and not periodic data.
- UI result caches are 256 windows and 16 Mi units; the worker cache is 64 MiB.
- Bound every input and output: 4 MiB request and 16 MiB response bodies, 1M-character scripts, 256 pending requests
  per backend generation, a deadline per method (`methodPolicies`), credit for result streams (16 MiB per stream, 64 MiB
  per port), and explicit truncation of results and messages.
  New string inputs need max lengths in both zod and C#. A request is written to at most one backend generation and is
  never re-sent.
- Preferences are written atomically (`src/main/json-file.ts`) (`settings.json`, `appearance.json`, `connections.json`,
  `workspace-layouts.json`, `saved-passwords.json` (0600), `shortcuts.json` (`src/main/shortcut-store.ts`: re-read before every
  write, a revision that refuses a stale save with `STALE`, damaged entries salvaged, unknown records kept verbatim)); unreadable
  files are quarantined, never overwritten.
- Failures are values: IPC returns `{ ok: false, error }`, and the UI stays responsive.
- Commands and keybindings are declared only in `src/shared/commands/catalog.ts`. `KeybindingService`
  (`src/renderer/src/core/keybindings.ts`) is the only key listener and routes keys to an open menu first; main handles
  no keys (`tests/keyboard-lint.test.ts`). Electron roles are commands (`role`): native menus show the role, and custom
  menus and the palette run it through `varia:run-role`. Two-part chords that Varia owns are `bridge` keybindings,
  registered with Monaco from the catalogue by `registerEditorBridge`; Monaco dispatches them. After catalogue changes,
  regenerate `docs/commands.md` with `npx vitest run tests/commands-docs.test.ts -u`.
  Peek's definition is the query editor itself (`createQueryEditor` with `peekEditorUse`, `explorer/peek-editor.ts`), never
  a copy of it: read-only, one per card or tab, a model per definition disposed as the view moves on. Its focus key is
  `peekEditorFocus`, never `editorFocus`, and its Monaco context key `variaPeekEditor` keeps the bridge's chords off it, so no
  query command acts on it.
  User shortcuts reach the renderer only through `ShortcutsService` (`src/renderer/src/core/ShortcutsService.ts`), which
  hands `effectiveRules` to `KeybindingService.setRules` (labels, menus, the palette and the editor bridge follow) and the
  file's gestures to `GestureService.setModifiers`; the Shortcuts page records keys only through `KeybindingService.capture`.
  Monaco's own default keys (the modules `start.tsx` imports, all three platforms) are generated into
  `src/shared/commands/monaco-keys.generated.ts` from the installed Monaco by `tests/fixtures/monaco-runtime.ts`; after a Monaco
  upgrade or a change to those imports, regenerate it with `npx vitest run tests/monaco-keybindings.test.ts -u`.
  Mouse gestures (modifier behaviours, pointer commands, fixed gestures) are declared only in `src/shared/commands/gestures.ts`;
  handlers read pointer modifiers only through `GestureService` (`src/renderer/src/core/gestures.ts`, `tests/gesture-lint.test.ts`),
  every pointer command has a keyboard path, and tooltips that name a gesture take its words from the service. After
  changing it, regenerate `docs/gestures.md` with `npx vitest run tests/gestures.test.ts -u`.
- Menus are declared only in `src/shared/commands` (placements in `catalog.ts`, submenus in `menus.ts`) plus the theme
  provider (`src/shared/theme/menu.ts`). Windows/Linux render them in `src/renderer/src/menus`; macOS renders them
  natively from ids. Main's application menu takes only command-id sets from the renderer (`menuStateSchema`) and sends
  back a bare id; it is the macOS menu bar and stays hidden elsewhere, where it still serves Electron's role keys. macOS
  context menus (`src/main/context-menu.ts`) open only in the focused window or within 1 s of input there, and send
  back a token and an id. Menu targets
  (`src/renderer/src/menus/targets.ts`, registered with `useMenuTarget`) never cross IPC. `MenuService` is the only
  `contextmenu` listener, and only `.menu-layer` reaches z-index 30000.
- The page reads the clipboard only through the Paste role, which main runs only within 1 s of a click, key press or tap
  in the focused window (`UserActivation` in `src/main/window-roles.ts`). An idle or background page cannot read it, but
  main cannot tell which input chose Paste, so a page script can read it while the user types or clicks. On Linux,
  Chromium pastes the PRIMARY selection on a middle-click (into any editable, and as a readable `paste` event wherever
  the click lands) with no role or gate: in each window the page cancels every middle-button release event
  (pointerup and mouseup, since a cancelled pointerdown leaves no mouseup) and every middle-button pointermove (how a
  chorded press or release comes) and hides any `paste` from every other listener while the middle button is held or in a release's
  task (`blockPrimaryPaste`, `src/renderer/src/core/primary-selection.ts`). Monaco's `selectionClipboard` is off only so
  a middle-drag selects a column as on other platforms: standalone Monaco has no selection clipboard.
- Object Explorer structure lives only in `src/shared/explorer/catalog.ts` (folders, kinds, icons, filters, version
  gates, the kinds that carry live status chips, whose words are in `status.ts`); after changing it, regenerate `docs/object-explorer.md` and the backend's embedded
  `Explorer/explorer-catalog.json` with `npx vitest run tests/explorer-catalog.test.ts -u`. Explorer SQL is constant
  text per query, band and filter shape, with values as parameters and database names only through `QUOTENAME`; no
  metadata built-ins; `READ UNCOMMITTED` and `LOCK_TIMEOUT 5000` on the explorer pool. The offline `CatalogSql` lint
  renders and checks every variant.
- Peek never cuts a definition. A module's text comes in pages of `peekLimits.definitionPageChars` UTF-16 code units, so
  each reply stays far under the 16 MiB response bound: `explorer.peek` carries the first page with the facts, and a longer
  text (its `definitionLength` and `definitionStamp`, the module's `modify_date`) is read one page at a time with
  `explorer.peekDefinition` (constant `PeekSql.DefinitionPage`, `SUBSTRING` from `@offset` under a binary collation that
  counts code units), each page asked for once the last is in, and put together in the renderer (`PeekReads`). A page
  never ends inside a surrogate pair. A page whose length or stamp differs from the first page's means the module changed
  in between, and the part says so instead of showing pages that do not fit. Closing, replacing or refreshing the view
  cancels the page being read. The one bound is `peekLimits.definitionMaxChars` (2^27 code units), a bound on the renderer's
  memory (about twice that for a moment, while the pages are joined): a longer text is not read, and the part says so, never
  showing part of it. Search Objects' details pane, which shows at most `shownChars`, reads a module's pages only that far.
- Search Objects' index (`backend/Varia.Backend/Search/`, docs/object-search.md) lives only in backend memory, one per
  connection, never on disk, and is dropped on disconnect; its limits are `objectSearchLimits` in
  `src/shared/explorer/search.ts`, mirrored in C# (`tests/object-search.test.ts`), with everything it holds (records, names
  and definitions, by `IndexMemory`'s estimates) under one 512 MiB budget for all connections (`IndexBudget`); names and
  definitions are held once across connections in a reference-counted `StringPool`. It reads on its own pool (" - Object Search", the explorer's prologue) from
  `ObjectSearchSql`'s constant batch, run in each database only through `QUOTENAME(@db).sys.sp_executesql` and linted by
  `CatalogSql.Lint`, and the server's own objects from `ObjectSearchSql.Server` on the server's connection; it indexes every
  kind Object Explorer lists but the SSIS Catalog's, and definitions come from `sys.sql_modules` (and constraint, computed column,
  plan guide and server trigger text). It indexes Microsoft-shipped objects too; the resource
  database's (negative ids, from `sys.all_objects` and `sys.all_sql_modules`) are read once per build and shared across
  connections by fingerprint in `ResourceCatalog`, which interns their definitions. Object Explorer's search box and the
  Search Objects tab are one search (`SearchPanel`, `ObjectSearchService`), and the header's Search (Ctrl+Q) lists objects only
  from it (`quickSearch`, shown through the quick input's `setAnswer`); the tree has no filter or listing of loaded rows. Regex runs only `NonBacktracking` with a match timeout, and
  a database the build cannot read is a skipped value. Never log names, definitions or search text.
- Script As verbs, titles, URN types and preflight ids live only in `src/shared/scripting/catalog.ts`, and scripting
  options only in `options.ts`; after changing them, regenerate `docs/scripting.md` and the backend's embedded
  `Scripting/scripting-catalog.json` with `npx vitest run tests/scripting-catalog.test.ts -u`. Scripting uses its own
  pool (`READ COMMITTED`, `LOCK_TIMEOUT 10000`, database context restored before pooling), runs SMO only through
  `ScriptPipeline` with a fresh `Server` per job and prefetch limited to one object's own children, applies
  `HeaderGuard` to every SMO script with headers, leaves out SMO's comments for unresolved references (they hold names
  unescaped) and refuses any other SMO comment batch a name breaks, caps output at 4,000,000 characters, never executes
  DDL, and never logs scripts, names or options.
- Object actions (Select Top 1000 Rows, Rename, Delete, Properties, Restore Database, a login's Disable and Enable, and folder actions such as Databases › Attach), their dialogs, pages and database options live only
  in `src/shared/actions/catalog.ts`, `database.ts` and `logins.ts` (login subtypes, protected-principal rules and limits); after changing them, regenerate `docs/object-actions.md` and the
  backend's embedded `Actions/actions-catalog.json` with `npx vitest run tests/object-actions-catalog.test.ts -u`. DDL runs
  only in `ActionService` (and, for the SSIS Catalog's server verbs, in `SsisActionService`; see the SSIS bullet): on its own unpooled connection (the application name plus " - Object Actions", never retried),
  never the explorer or scripting pool; with statements only from constant templates in `ActionSql`, `Actions/DatabaseAlter`
  and `Designer/DesignerSql`, all checked by `ActionSql.LintExecutable` (its template form for `ActionSql`, its builder
  forms for the others), New Database's `Actions/CreateDatabaseSql`, checked by its own `Lint` (file names and paths as
  N'' literals quoted on the server, under a binary collation) with the designer form's OPENJSON rules
  (`Actions/JsonBuilderLint`: number or `nvarchar(max)` columns, text only inside `QUOTENAME`), `Actions/AttachSql`
  (Attach's builder and its `DBCC CHECKPRIMARYFILE (@mdf, n)` reads, checked by `AttachSql.Lint`, with paths only in one
  JSON parameter that the server quotes), for RESTORE and BACKUP, which take no `QUOTENAME`d text, `Actions/RestoreSql`
  binding only variables (`RestoreSql.LintMedia`), and, for logins, `Actions/LoginSql`, checked by its own `LoginSql.LintExecutable`,
  which `ActionSql.Lint` chains (the password only as `@password` behind a NULL guard, through a binary-collation REPLACE,
  never in a literal), where names, the database a batch runs in included, go in as parameters through server-side
  `QUOTENAME`, numbers only through `CONVERT` of range-checked parameters, keywords only from the embedded catalogue, and
  collations only as `sys.fn_helpcollations()` names them (live checks prove the server builds what Script Action shows
  for hostile names, and that Database Properties' script equals SMO's capture of SSMS's sequence); after a preflight in
  the same connection; waiting for locks as SSMS does (`LOCK_TIMEOUT -1`), so every DDL path needs a Stop (the dialog's,
  or the status bar's for a rename and a login's Disable and Enable), whose reply waits for SQL Server and lists the steps completed; and never logging
  names, SQL or values. Varia undoes only its own partial changes and drops only a RESTORING database its own restore created
  (`ActionSql.DropRestoring`, identity checked in the batch), never one that existed. Script never runs anything. Describe and script reads use `LOCK_TIMEOUT 10000`
  (the loginFacts describe, whose facts only advise, under READ UNCOMMITTED). Every lint refuses `LOGINPROPERTY` (it takes its own locks whatever
  the isolation level) and any read of a password hash (`CatalogSql.SecretUses`). The test-only dry
  run is an internal C# method, never a request field. Action statements run through a reader (`ActionService.ReadAllAsync`),
  never `ExecuteNonQuery` (`tests/action-reader-lint.test.ts`), whose info messages SqlClient holds until the statement ends, and a Stop
  reaches the statement only through `ActionService.StatementStop` (SqlClient's own cancel from another thread waits while a statement
  streams info messages), the job's token cancelled off the frame loop; a long action (the catalogue's `long`)
  takes the long gate (per Varia connection, like the others) and reports message 3211 as droppable `action.progress` EVENTs
  that main relays only to the requesting window (`varia:actions-progress`), and a closing backend stops it and waits for
  its cleanup (`DrainCommitted`; main's `drainMs`, `actionDrainMs`).
- Table Designer types, properties, commands and limits live only in `src/shared/designer/catalog.ts`; after changing it,
  regenerate `docs/table-designer.md` and the backend's embedded `Designer/designer-catalog.json` with
  `npx vitest run tests/table-designer-catalog.test.ts -u`. Designer DDL runs only through `actions.execute`'s `createTable`,
  in one transaction: the backend re-validates the design (`TableDesignValidator`), sends it as one JSON parameter, and
  constant builder batches (`DesignerSql.Builder`, linted by `ActionSql.LintExecutable`'s designer form) have SQL Server
  shred it with OPENJSON and compose each statement from `QUOTENAME`d names, `CONVERT`ed typed numbers and type keywords
  from a constant table generated from the catalogue; a live dry run proves the server builds exactly
  `DesignerSql.Statements` for hostile names. The design lives in the renderer (`TableDesignerService`, a
  `CustomDocumentProvider` tab with no Monaco model), never reaches AutoRecover, and saves outside the document task.
- Activity Monitor structure (probes, panes, tables and columns, tiles, view chips, wait categories, limits) lives only in
  `src/shared/activity/catalog.ts`; after changing it, regenerate `docs/activity-monitor.md` and the backend's embedded
  `Activity/activity-catalog.json` with `npx vitest run tests/activity-catalog.test.ts -u`. Its SQL is constant text per probe,
  statement, band and capability in `Activity/ActivitySql.cs`: DMVs (joined to `sys.databases` and `sys.master_files` for
  names), values as parameters, text sizes and caps from the catalogue's limits, no metadata built-ins, temp tables,
  `sys.sysprocesses` or `dm_tran_locks`, every TOP ordered (only the capability probe asks what the login may do); the offline
  lint renders and checks every variant. Its live probes are built from this catalogue (`src/shared/live/catalog.ts`), and
  their column ids are unique within a probe (`liveColumnId`). Filters run in backend memory over a sample (`ActivityFilter`,
  sent as the source's args), never in SQL. A session is one of Varia's pools (hidden by default) only when its id is one
  Varia's own pooled or Object Actions connections were given as they opened (`ILiveHost.OwnSessions`), never by the
  process id, host name and program name a client claims at login alone; `VariaSessions.Protected` (the ledger's ids or
  those claims) is the wider set a refusal can use, since SqlClient's reconnect can move a held pool connection to an id
  the ledger lacks. The session actions (`Activity/SessionActions.cs`)
  have the only exemptions: `activity.details` reads `dm_tran_locks` only on request, on the monitor's pool under the live
  gates; `activity.kill` runs on the object actions' unpooled, never-retried connection, one guarded batch per session that
  checks the session's identity (login time, host process id), refuses its own, system and this backend's pool sessions (of every connection, whatever its Application Name), and
  only then runs a dynamic KILL built on the server from an int parameter. Neither logs session ids, logins, hosts or SQL.
- SSIS Catalog semantics (code tables, `ssis.describe` views, `ssis.execute` verbs, Object Explorer verbs and their commands,
  documents, error codes, features, limits) live only in `src/shared/ssis/catalog.ts`; its tree kinds and folders are Object
  Explorer's catalogue. After changing it, regenerate
  the generated part of `docs/integration-services.md` (below its marker line; the part above is hand-written) and the
  backend's embedded `Ssis/ssis-catalog.json` with `npx vitest run tests/ssis-catalog.test.ts -u`. SSISDB is read on the
  SSIS read pool (and by a write's preflight in its own connection) (the application name plus " - Integration Services", Initial Catalog the catalog's database), never
  the explorer pool, from `SsisSql`'s constant text and the explorer's SSIS listings, both linted by `SsisSql.Lint`
  (values as parameters, no metadata built-ins, no `datetime` conversions, no dynamic SQL, no writes, never
  `SYNCHRONIZED`); tree listings run `READ UNCOMMITTED`, describes `READ UNCOMMITTED` (`READ COMMITTED` when SSISDB has
  RCSI), both with `LOCK_TIMEOUT 5000`, the profile's role checks with 1000. The SSIS pool keeps idle connections in SSISDB
  until disconnect. SSISDB changes only in `SsisActionService` (`ssis.execute`, sensitive): on its own unpooled connection
  (the application name plus " - Integration Services Actions", Initial Catalog the catalog's database, never retried), never
  a pool; after a preflight in the same connection (READ COMMITTED, `LOCK_TIMEOUT 10000`, 25 s); with steps only from
  `SsisSql.WriteTemplates`, each calling only its verb's catalog procedures (`SsisSql.LintWrite`), values as parameters, no
  outer transaction; waiting for locks as SSMS does (`LOCK_TIMEOUT -1`) until Stop, whose reply waits for SQL Server and
  lists the steps completed (`AnswersStop`); a verb SSISDB refuses to SQL Server logins answers `WINDOWS_AUTH_REQUIRED` on a
  box server before connecting. The catalog's database name comes only from the internal `SsisOptions.CatalogDatabase`
  (SSISDB, or the checks' fake catalog), never a request field; there is no 32-bit runtime option anywhere. The
  catalogue's server verbs (scope `server`; Create Catalog) are the second DDL path: the same connection rules but in
  `master`, with commands only from `SsisCreateSql` (`ServerCommands(verb)`, every one checked by `SsisCreateSql.Lint`:
  values as parameters, dynamic SQL only where SQL Server takes a literal, built from `QUOTENAME` or the server's quote
  escape `REPLACE(… COLLATE Latin1_General_BIN2, N'''', N'''''')`), the database name from the catalogue (or the internal
  `SsisOptions.CreateScratch` of the dry run), never a request field; Stop cancels any statement but the restore (whose
  reply waits for it to end), and a Stop or failure after the restore removes exactly what the request made, waiting at
  most 30 s per lock. Never log names, values, SQL or messages.
- Getting Started uses `src/shared/help/catalog.ts` and lazy JSX guide modules with matching stable IDs. References
  resolve through the existing command, setting, effective shortcut and gesture catalogs/services. Lesson focus is
  explicit, so Help focus does not erase editor or results bindings. The singleton custom document has no text model,
  SQL session, recovery record or persisted progress. Its frame/navigation stay mounted while only the section body
  loads or fails; guide modules never refocus on load. Samples are bounded fictional illustrations with local state;
  they do not connect, execute SQL or duplicate production result processing. docs/help-authoring.md owns the workflow.
- Release notes are reviewed, versioned plain-text records (`release-notes/*.json`), validated by
  `src/shared/releases/schema.ts` and explicitly bundled by its catalog. Their read-only document uses the normal custom
  provider and document frame; it has no SQL model or backend connection. Requested versions match exactly; missing
  notes do not fall back silently or block the updater. `scripts/release-notes.mjs` also generates public release bodies
  and published changelog sections from those records. Manual downloads remain the fixed main-owned releases URL.
- Updates live in `src/shared/updates.ts` (feed, manifest schema, states, failure words); only main fetches (its own
  in-memory session, `net` through the system proxy and certificate store), verifies size and SHA-512 against the
  release's `varia-update-v2.json` (written by `scripts/update-manifest.mjs` in the release job), and installs, only after
  Restart to Update's quit has closed the windows and stopped the backend (`src/main/update-install.ts`). The page gets
  only `UpdateState` and asks with argument-free calls; it never names a URL or path. docs/updates.md describes it.
  The release job keeps writing `varia-update.json` in its first shape: builds up to 0.7.0 refuse a manifest with a kind
  or field they do not know, so a new kind goes only in the current manifest, which leaves out what a build cannot use
  instead of refusing the release. An installed
  Windows copy whose folder the user can write stages a release beside itself while it runs and swaps it in at restart,
  through the update helper (`backend/Varia.Updater`, `src/main/update-staging.ts`): the helper takes paths only from
  main, works only in the one folder beside the installation that main stages in and only when that folder is this
  user's alone (main believes no marker there by itself: it asks the helper), checks the archive's SHA-512 again before
  unpacking it, and asks for no elevation; anything it cannot do falls back to the installer, for that release in
  every later run too (`update-failed.json` in the profile, written before every swap is started). macOS builds do not update themselves until they are code signed.
- Settings live only in `src/shared/settings/` (pages in `pages.ts`, definitions per area, aggregated by `catalog.ts`;
  the Scripting page's entries come from `src/shared/scripting/options.ts`), with defaults, bounds, platforms and zod
  schemas built from the definitions. Only main reads and writes `settings.json` (`SettingsStore`: overrides only, read
  before every write, atomic writes, invalid files quarantined); the renderer receives validated values through
  `SettingsService` and changes them only with `updateSettings` patches. After changing the catalogue, regenerate
  `docs/settings.md` with `npx vitest run tests/settings-catalog.test.ts -u`.
- Colours live only in `src/shared/theme/`. CSS and TSX use `var(--varia-*)`; `tests/theme-css.test.ts` enforces this.
  Theme files are untrusted: only main reads them, and the renderer applies only the validated map main sends.
- Sizes, radii, shadows and motion are metric tokens in `src/shared/theme/metrics.ts`, not theme keys, mirrored on
  `:root` in `styles.css`. `tests/theme-metrics.test.ts` rejects literals outside them (font sizes in renderer code too),
  keeps text at 11 px or more, lets only hover fills fade, and stops every animation under reduced motion, Monaco's codicon
  spinners included; regenerate `docs/themes/metrics.md` with
  `npx vitest run tests/theme-metrics.test.ts -u`.
- Icons live only in `src/shared/icons.ts` (codicons and Varia's own SVGs, by id); catalogues name icons by those ids and
  the renderer draws them only through `Icon.tsx`, or `codiconClass` where an element or Monaco takes a class
  (`tests/icons.test.ts` forbids other codicon classes, inline SVGs and text glyphs in the renderer). Fonts are fixed in
  `src/renderer/src/fonts.ts`. After changing the registry, regenerate `docs/icons.md` with
  `npx vitest run tests/icons.test.ts -u`.

## Product direction (agreed with the owner, in full)

- Goal: SSMS 2022-level polish plus a VS Code-style F1 command palette. Core first (connections, databases, objects);
  SSIS, replication, and credentials later. Windows, Linux, and macOS are all first-class. Never freeze or crash;
  handle error states cleanly.
- Roadmap: PR0 CI/test foundations, PR1 theme tokens, PR2 command registry + F1 palette, PR3 context menus,
  PR4 Object Explorer v2 (backend node provider, virtualized keyboard tree), PR5 scripting (Script As), PR6 binary
  IPC v2, PR7 streaming virtualized results grid.
- IPC v2: length-prefixed MessagePack frames (control and row pages), server push and streams with credit-based
  backpressure, MessagePort with transferable ArrayBuffers to the renderer.
- Results stay in memory under a backend memory budget with explicit truncation. No spill to disk.
- Menus: custom-rendered themed menus (title bar and context menus) on Windows/Linux; native global menu bar and native
  context menus on macOS.
- SQL Server 2016-2025. Authentication: SQL and Integrated (Windows SSPI; Kerberos on Linux/macOS) first, Microsoft
  Entra ID next.
- Visuals: the modern Calm Pro design language (graphite neutrals, one iris accent, Compact density by default and
  Comfortable as an option), not SSMS's look; SSMS's features, behaviours, names and keys stay the parity target. Dense
  Power's environment and status indicators are in (the red Production tag on connections, live Object Explorer status
  chips), showing only what a probe produces. Icons are codicons (bundled with Monaco) plus custom SVGs; Microsoft's SSMS
  icons cannot be reused. Themes: Dark and Light (plus follow System), customizable through a standardized palette
  system like VS Code or opencode.
