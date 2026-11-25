# Architecture invariants

The full rules behind CLAUDE.md's summary: one bullet per area, naming what enforces it. User-facing behaviour lives in
each area's own page in docs/; protocol detail in docs/ipc.md. Update the bullet here when a rule changes, and CLAUDE.md
only when a summary line stops being true.

## Security boundary

- **Renderer and windows.** The renderer is untrusted: context isolation, sandbox, no Node integration, CSP, blocked
  navigation and popups. It reaches the system only through `window.varia` (`src/preload/index.ts`); never expose
  generic IPC or shell APIs, and never disable the Chromium sandbox. Main verifies every IPC sender (`trusted()` in
  `src/main/index.ts`, which accepts only `app://varia/index.html` in built apps). Built pages load only from
  `app://varia/` (`src/main/app-protocol.ts`: files under `out/renderer` only, traversal refused), never `file:`, whose
  origin reaches every local file. Packaged builds set the fuses in `build/fuses.cjs` (flipped in afterPack, read back by
  `scripts/packaged-smoke.mjs`): no `file:` privileges, RunAsNode, `NODE_OPTIONS` or `--inspect`; asar only, integrity
  checked.
  The only windows the page may open are popouts and dialog windows (`src/main/popout-windows.ts`, docs/popout-windows.md):
  same-origin `about:blank` children named `varia-popout-<uuid>` or `varia-dialog-<kind>-<uuid>` (Options, About), exact
  bounds on a display, no preload, sandboxed, isolated, no popups or navigation of its own, closed with the page. Their
  content is the page's DOM through React portals, so they send no IPC, and `trusted()` still accepts only the main
  window's main frame.
- **Backend methods.** Add one in all five places: `RpcMethods` (`src/shared/contracts.ts`), a strict zod schema in
  `requestSchemas` (`src/main/validation.ts`), a `methodPolicies` entry (`src/shared/ipc/methods.ts`), a preload method,
  and a `SqlService.DispatchAsync` case with its `MethodNames` entry and record in `backend/Varia.Backend/Contracts.cs`.
  Unknown methods and members are rejected on both sides; main refuses a backend whose HELLO lacks a method.
- **Providers.** One `ProviderId` (`src/shared/providers.ts`: `sqlserver`, `bigquery`) names the engine everywhere. A
  `methodPolicies` entry serves SQL Server only unless its `providers` says otherwise, and a request for another engine is
  refused with `UNSUPPORTED_PROVIDER` by main and again by `SqlService.DispatchAsync` (docs/ipc.md#providers).
- **Logs and secrets.** Backend stdout carries protocol v2 frames only (`Console.Out` goes to stderr). Never log SQL text,
  names, values, credentials or connection strings. Passwords never reach disk in clear: not `mssql-connections.json`, process arguments, the
  environment, logs, traces or previews.
  - A remembered password is only Electron `safeStorage` ciphertext (async API only, `src/main/secret-cipher.ts`) in
    `mssql-saved-passwords.json` (atomic, 0600, quarantined if unreadable), keyed by its history entry's id and bound to its
    server, login and TLS settings by a hash beside it and a check inside the ciphertext. Only main reads or decrypts it;
    the renderer learns only which entries have one, and main injects it into `connections.connect`/`.databases` only
    for a matching binding. Save remembers a typed password only when a `connections.databases` check with `remember`
    just signed in with it: main keeps a keyed hash of that password per binding for a minute (never the password), and
    Save without a match saves nothing. Remember password is disabled where safeStorage is unavailable, Linux's backend is
    `basic_text`/`unknown`, or its keyring is unreachable: only tags `v11`/`v12` count (`v10` is Electron's fallback key; the tags are not yet confirmed on a Linux desktop).
  - Entra tokens stay in backend memory for its lifetime (MSAL and Azure.Identity through Varia's
    `SqlAuthenticationProvider`, `backend/Varia.Backend/Entra/`): never on disk, in logs or messages, never sent to main
    or the renderer. Only connect and Load databases open a browser sign-in, under the request's token (Stop); sign-in
    hosts and token resources the server names are allowlisted.
  - BigQuery credentials (docs/bigquery.md): main finds and reads the key, federation configuration or ADC file (by
    opaque reference, at most 64 KiB) and sends its content only in a sensitive request; the backend loads it only through
    typed loads with every URL pinned to Google's endpoints, and keeps tokens in memory. Each connection pins the
    verified principal, and a refresh that signs in as another one fails `AUTH_IDENTITY`. The one exception to main
    reading credential files: a federation configuration's `credential_source.file` rotates, so the backend reads it
    itself on every token exchange, only at the path a configuration main read names, and only a regular local file of
    at most 64 KiB outside Varia's user data and the known credential folders (judged by its canonical path; UNC shares,
    device and NT paths, network drives and `/proc`, `/sys`, `/dev` are refused), and only once the user confirmed that
    path in the Connect dialog (kept in `bigquery-connections.json`; main fails closed without it). The renderer names a
    key file only by the reference main's picker returned and sees only its file name. BigQuery connects go through
    `ConnectionOpenService` like SQL Server's, with the same target pins. `VARIA_TEST_BIGQUERY_ENDPOINT`
    (a loopback emulator) reaches only unpackaged backends and uses anonymous credentials.
  - New Login's password lives only in `ObjectDialogService`'s secret slot (`setSecret`, never the snapshot), travels
    only in the sensitive `actions.execute`, reaches SQL only as one parameter in a constant batch, and is scrubbed from
    replies; Script writes `<password>`.
- **Clipboard and permissions.** The page reads the clipboard only through the Paste role, which main runs only within
  1 s of a click, key press or tap in the focused window (`UserActivation`, `src/main/window-roles.ts`); main cannot tell
  which input chose Paste, so a page script can read it while the user types or clicks. The session's only granted permission is a sanitized clipboard write from the main window's
  main frame; the request and check handlers answer alike (`src/main/permissions.ts`), since Electron's default check
  grants everything. On Linux, Chromium pastes the PRIMARY selection on middle-click with no role or gate, so in each
  window the page cancels every middle-button release (pointerup and mouseup, since a cancelled pointerdown leaves no mouseup) and middle-button pointermove, and hides any
  `paste` from other listeners while the middle button is held or in a release's task (`blockPrimaryPaste`,
  `src/renderer/src/core/primary-selection.ts`). Monaco's `selectionClipboard` is off only so a middle-drag selects a
  column as elsewhere: standalone Monaco has no selection clipboard.
- **Bounds.** 4 MiB request and 16 MiB response bodies, 1M-character scripts, 256 pending requests per backend
  generation, a deadline per method (`methodPolicies`), stream credit (16 MiB per stream, 64 MiB per port), explicit
  truncation of results and messages. New string inputs need max lengths in both zod and C#. A request is written to at
  most one backend generation and never re-sent. UI result caches are 256 windows and 16 Mi units; the worker cache is
  64 MiB.
- **Failures are values.** IPC returns `{ ok: false, error }`, and the UI stays responsive.
- **Preferences files** (`settings.json`, `appearance.json`, `mssql-connections.json`, `workspace-layouts.json`, `inspector-vitals.json`, `mssql-saved-passwords.json` (0600), `shortcuts.json`, `window-state.json`) are written atomically (`src/main/json-file.ts`); unreadable files are
  quarantined, never overwritten. `src/main/shortcut-store.ts` re-reads before every write, refuses a stale save with
  `STALE` by revision, salvages damaged entries and keeps unknown records verbatim.

## Connections

docs/connection-ownership.md describes main's authentication, receipt, checkpoint and pruning contracts.

- **Profile files and the 0.9.0 migration.** The profile lives under names 0.9.0 never reads, so a downgrade still opens
  0.9.0's own files: `mssql-connections.json`, `bigquery-connections.json`, `mssql-saved-passwords.json`,
  `WorkbenchSession/` and `WorkbenchAutoRecover/` (`profileFiles`, `src/main/profile-migration.ts`). At startup, before
  any store reads, each 0.9.0 file or folder is parsed with today's schema and written atomically under the new name (a
  folder through a staging folder); the 0.9.0 files are never written. A 0.10.0 file a store wrote after a failed attempt
  is merged into, never replaced: connections it lacks by id and key are added with their 0.9.0 ids, passwords are keyed
  to the matching entry unless the file has one for the same credentials, AutoRecover records join within its caps, and a
  session folder 0.10.0 made (even empty) keeps what it holds while 0.9.0's unsaved tabs are offered through AutoRecover.
  Finished steps, and the records already copied, are recorded in `profile-migration.json`, so a store's own file neither
  hides 0.9.0's nor brings back what the user discarded (so what 0.9.0 changes after a downgrade is not carried forward
  on the next upgrade); a failed or partial step retries at the next start, and saved
  passwords wait for the connections, whose library their store reconciles against. A marker that exists but cannot be
  used counts every step done (a newer version's is left alone; a corrupt one is quarantined and replaced). An unreadable
  0.9.0 file is quarantined. Logs carry only the step and an error code. A 0.9.0 workspace seal still verifies over the old `sqlServer` spelling (`connection-workspace-seal.ts`). Principals and targets carry `provider` (0.9.0's `sqlServer` reads as `sqlserver`); session
  files are version 3 and AutoRecover records version 2, each with `provider` and BigQuery's 1,024-character datasets.
- **Targets.** `src/shared/connection-targets.ts`: target ID, saved-profile hint and backend handle are distinct. Persist
  only the strict nonsecret target/workspace shapes, never lifecycle, handles, operation epochs or main-only comparison
  keys. `ConnectionIdentityRegistry` (`src/main/connection-identity.ts`) compares only authenticated live handles by
  actual credentials and trusted resolved-account evidence; a saved-profile key or equal server names prove nothing.
  The renderer's registry (`src/renderer/src/services/connection-targets.ts`, Workbench's one `connectionTargets`,
  projected by ConnectionService for handle consumers) returns stale successful handles for the backend owner to close
  and keeps intentional disconnect apart from loss, and Explorer membership apart from document references. Session v2
  stores the strict workspace and exact query association, database and attachment intent; v1 server names are display
  hints only. Reload capture shares hot exit's eligibility and pin validation. Main's `connection-open.ts` owns
  validation, credential resolution, live/pending reuse and receipt acceptance; cancelling releases only that request's
  ownership, never a transport another accepted caller uses. The renderer adopts only verified receipts, acknowledged
  through bounded main-only IPC. Replacement pages reconcile obsolete pins against their trusted saved workspace without
  touching live, pending or delivered owners (late credential settlement too). A disk restore pins Windows/Entra
  accounts only when `connection-workspace-seal.ts`'s OS-key HMAC proves main wrote them; an unproven silent target
  never reconnects in the background.
- **Account identity** is evidence from successful authentication, never a display name or group mapping: SQL and
  Windows targets pin the login's SID, Entra targets the token's tenant/object GUIDs.
  - Native connections validate the pinned principal before caller SQL. Initial SQL, Windows/Kerberos and Entra
    authentication uses a fresh physical session; later guarded opens keep the requested pooling. Identity-bound
    connections disable idle connection recovery. A failed check closes the physical connection and invalidates language
    context; only missing or different proof is AUTH_IDENTITY (a SID probe keeps transient and session-lost SQL errors).
    Failed or cancelled guarded opens dispose their connection; only rejected identity retires a pool. Known password
    rotation retires affected pools before publishing its binding.
  - Entra pools use target-private token-callback keys (submitted Application Name kept). Token acquisition needs an
    explicit request scope: Connect/database discovery may establish an account, later opens carry the pinned
    principal, and unscoped driver replenishment cannot acquire a token or seed a pool.
  - An unapproved library reopen fences that connection's commands (the SqlClient diagnostic listener, synchronous
    single-instance initialization) before scheduling cleanup, since closing inside SqlClient's Open callback can wait on
    the unfinished Open. On a driver upgrade, real-driver regressions must still prove refusal before command send.
  - A missing registration/profile fails closed at factory ownership and Open admission, during Disconnect too; metadata
    fallback keeps fatal connection errors and their authentication details. SQL Tools Service keeps its own SQL/Windows
    credential contract (no Entra, no cross-open identity proof). No token, raw password or secret-derived key enters a
    workspace snapshot or renderer receipt.
- **Background connect** is noninteractive: it needs a pinned prior principal and, for passwords, the exact opaque
  credential revision, independent of Remember Password. Each attempt is bounded even with an unlimited stored timeout,
  and interaction-required never opens a browser. A login refusal quarantines that saved revision without deleting
  ciphertext until fresh typed authentication or exact stored-secret verification; keyring, network, certificate and
  database failures keep it. The startup/reload pass starts only after session restoration, loaded settings and backend
  readiness, runs at most two attempts at once, never retries on timers, and does not rerun after an unexpected backend
  restart in the same window. Disconnect, Stop and removal clear resume intent. Only exact query targets with attachment
  intent attach, never custom-document sampling. Document tasks pause admission and defer adoption/attachment without
  spending eligibility. Manual Connect preempts unaccepted work (others resume after) and supersedes its target even if
  it fails; accepted targets finish attachment unless cancelled. Every capture/checkpoint includes the target workspace
  (target-only sessions too) and revalidates it after async writes before final close/reload; main's
  `ConnectionSessionCheckpoint` checks the authentication pins' revision around the write and final close, credential
  settlement drains before approval, and no admission races an approved close. A renderer-only checkpoint comparison
  cannot prove that main's saved credential revision stayed current.
- **Disconnect** lives in `services/disconnect.ts` behind `DisconnectHost` (`disconnect-workbench.ts` adapts services and
  owns no connection state; App mounts one prompt service and coordinator for Explorer, palette and popouts). Save and
  transaction choices finish before cancellation, session completion or teardown; revisions, associations, management
  blockers and generations are revalidated at mutation boundaries. A failed save, cancel, commit or disconnect closes no
  tab, and completed session changes are reported, not called undone. Close Query Tabs closes only after successful
  teardown, through normal close events; Keep Tabs keeps output and immutable `QueryState.provenance`. Custom providers
  bind through `CustomDocumentTargets`, accept only explicit `canFollowTarget` identity, reject replies from replaced
  handles, and keep drafts with dependent operations disabled. A failed native disconnect restores the prior resume
  preference. New work needs a connected lifecycle; a disconnecting handle may be inspected for transaction teardown, and
  cached database lists stay for rollback without new metadata reads.

## Query editor and language services

- **Language features** belong to each Monaco model, never the globally active editor. The engine-neutral broker routes
  to provider adapters; SQL Server authentication, metadata readiness and dialect rules stay in its adapter. Only typed
  language operations cross IPC. Executables and arguments come from the trusted app; SQL Tools Service is a pinned,
  checksum-verified build artifact, never downloaded at runtime. Metadata uses independent connections, discards stale
  responses, and management actions release them. Service tracing is off so upstream exception logging cannot persist
  document text or connection details. Analysis never executes the buffer.
  - Diagnostics carry their model version and a dedicated marker owner; edits, context changes and backend loss clear
    obsolete markers at once. SQL Tools' unversioned notifications are correlated to immutable snapshot URIs on a
    serialized analysis child, apart from completion's debounce, with bounded retained context and lifetime, released on
    close, disconnect, reset and relevant cache refresh. Foreground requests preempt a document's background diagnostics, which resume once they settle.
  - A language server child is killed only through `ExitGate`, which the backend's exit also takes (.NET's tree kill
    SIGSTOPs before killing, and an exit between would leave it stopped). The gate cannot cover a backend main kills, so
    only Windows kills the child's tree (`LspClient.KillsTree`); Linux and macOS send one signal.
- **Go To Definition** (`language.definition`, `DefinitionService`) never goes through SQL Tools; docs/language-services.md
  has the user-facing rules.
  - ScriptDom finds the name under the caret (white space and comments allowed around dots) in the caret's batch or, when the batch does
    not parse, the widest parsing run of statements around it (statements starting after a semicolon or at a statement keyword), and `DefinitionNames` yields at most 8 candidates, scoped as SQL Server
    does: a level's tables are its own FROM and DML target, never a subquery's; an alias hides a same-named object only
    in a column qualifier, while a table reference's own name is always the object it names; CTEs, derived tables, table variables, PIVOT, trigger pseudo-tables and declared columns name
    no object; a TVF's alias stands for the function, MERGE's target alias for its target, OUTPUT's inserted and deleted for the DML
    target; a column in an INSERT, OUTPUT INTO, index, key or foreign key list (or ALTER TABLE's DEFAULT FOR, ALTER
    COLUMN, DROP COLUMN and PERIOD FOR SYSTEM_TIME) belongs to that table; an INSERT's or OUTPUT INTO's table is never a
    source of the statement's columns; a correlated subquery's or APPLY's bare column may be an outer table's (offered
    after its own, with the column checked), a derived table's or CTE's may not; a method on a column is its table's
    column and a qualified star's qualifier (o.*) is its table; an earlier USE (never USE HINT) sets the database.
  - Constant `DefinitionSql.Lookup` resolves on the Object Explorer pool (names as parameters, other databases through
    `QUOTENAME(@db)`; default schema, then dbo, then sys; server-level objects in the login's default database) within
    10 s. Not found or unavailable is `null` (a status-bar notice, never an error banner); an unreachable server or login
    is an error. A newer F12 supersedes one waiting; a query with no connection says so.
  - F12, Alt+F12, Ctrl+hover and Ctrl+click are Varia's (`edit.goToDefinition`, `edit.peekDefinition`, gestures
    `editor.peekHover` and `editor.goToDefinition`, through `EditorPeekService`); `KeybindingService` takes the keys before
    Monaco's gotoSymbol actions, and each editor drops Monaco's Ctrl+hover link (`create-editor.ts`), which would query the
    backend for every word crossed. F12 scripts CREATE to a new query through Script As; Alt+F12 and Ctrl+hover open
    Object Explorer's Peek card (`PeekService.peekAt`, one card for both, drawn beside its `PeekAnchor` by the workbench's
    `PeekCard placement="editor"`); Ctrl+click opens a Peek tab (`edit.openPeekTab`). A hover waits on Peek's own hover
    timer (`hoverAt`), skips reserved keywords and the name already shown, and never reports a miss. The keys run on
    `editorTextFocus || peekEditorFocus` with no query-tab precondition; Peek's own editors take no hover.
  - A `googlesql` model never reaches `language.definition`: `IndexCompletionService.definition` resolves the name through
    the Search Objects index with completion's dialect (`shared/completion/definition.ts`, `language.lookup` only). F12 opens
    only `bigquery.properties`' free definition (`indexDefinitionOpener`, views, materialized views and routines), never
    Script As' billed CREATE; Peek opens on that Definition tab (`peekAt`'s and `PeekTabService.open`'s `tab`).
- **Query languages.** A query document's `provider` (absent for SQL Server) picks its Monaco language (`queryLanguages`:
  Monaco's `sql`, or Varia's `googlesql` from `languages/googlesql.ts`); the document kind stays `sql`, so
  `isQueryDocument` is unchanged. `DocumentService` sets it from the connection a query opens on or moves to, switches
  the model's language (`switchModelLanguage` clears every marker owner first) and keeps it on disconnect, in Reopen
  Closed Query, hot exit and AutoRecover. Nothing runs or is sent on a switch or restore. SQL Server's language services
  serve only `sql` models; GoogleSQL's tokens use the `.sql` colour scopes, and its signature help reads the generated
  catalogue (`src/shared/googlesql/catalog.ts`) through `shared/googlesql/lexer.ts`. docs/googlesql.md has the behaviour.
- **SQL text transforms** (Toggle Brackets, Move Commas to Front/End: `editor/sql-transforms.ts`) work on tokens from
  `shared/sql/lexer.ts`, never regular expressions over the text, so strings, comments, variables and quoted names never
  change. They return offset edits applied as one undo step with selections mapped through them, refuse a model over
  `textOpLimits.characters`, and are tested in `tests/sql-transforms.test.ts`. Toggle Brackets is SQL Server only, with a
  handler `when` on the bound model's language too, since a command target (an Explorer node) could supply SQL Server's
  context while the editor shows a GoogleSQL query. The comma commands serve both: the bound model's language picks
  `lexSql` or `googleSqlTransformTokens` (`shared/googlesql/lexer.ts`'s tokens in the same shape) and the dialect's
  `go` (whether a GO line ends a statement).
- **Peek's language service** serves query documents and Peek's read-only definition models (`peekModelContext`:
  connection, database and the model's UUID as document id), nothing else. A Peek model gets hover and Go To Definition
  only, never completion or diagnostics, from its first request; its `onWillDispose` ends it as closing a query does
  (epoch bump, context and listener dropped, `language.close` if used). In-flight requests are capped per kind
  (`pendingLimits`): Peek 2, query documents 8. On the backend Peek shares the metadata slots
  (`ProtocolHost.MetadataSlots`) with query tabs, Script As, `actions.describe` and `connections.connect`, so stalled
  Peek hovers can hold two until their deadline.
- **Peek editor.** Peek's definition is the query editor itself (`createQueryEditor` with `peekEditorUse`,
  `explorer/peek-editor.ts`): read-only, one per card or tab, a model per definition disposed as the view moves on. Its
  focus key is `peekEditorFocus`, never `editorFocus`, and its Monaco context key `variaPeekEditor` keeps bridge chords
  off it, so no query command acts on it except Go To and Peek Definition.

## Results

- **Rows stay in the backend** (never on disk) under the result budget. Main forwards DATA pages undecoded as exact-size
  ArrayBuffers (`toExactArrayBuffer`); only the results worker decodes them (`decodePage`). Results-port messages from
  the renderer are validated with `portRequestSchema`, ownership and the current generation. Peek's Top rows are no
  exception: Select Top Rows' script with N = 10 through `query.execute`, in Peek's own session and results entry
  (`PeekService`), released when its card or tab closes, moves on or refreshes, and on backend loss.
- **A windowed BigQuery result keeps its rows in BigQuery** (docs/bigquery.md, Residence): its set holds no pages, only a
  per-result block cache (`Results/RemoteResult.cs`) charged to the global budget and read from the job's destination
  table with `tabledata.list` (Preview Rows' own `tabledata.list` reads a stored table's first rows into memory under the
  budget instead, and never a windowed result's). The residence is decided once, after the first page (`SqlService.DecideResidenceAsync`);
  a switch between memory and windowed (a misestimate, Load into memory) goes only through `ResultStore.Demote` and
  `ResultSetBuffer.Promote`, bumps the descriptor's `revision` and sends `resultSet.residence`, after which the renderer
  drops every page and window of the older revision. Only `results.read`, `results.rowBytes` (cache only), and Copy and
  Save read a windowed result, and only `results.remoteQuery` loads it; every other reader of stored pages finds its set through
  `SqlService.Stored`, which answers `REMOTE_RESULT` before any work, while Copy and Save (`ResultJobs`, whose `Lease` holds
  either kind) read a windowed set's rows through `RemoteResult.ReadPagesAsync` and its `IRemoteRows` export, never its pages; a
  switch after that check is refused where the hold is taken (`SealedSnapshot`, `AddView`, `AddSnapshot`,
  `Released`); `Demote` marks the set windowed before it drops views and snapshots, so a hold finished meanwhile is refused
  or dropped, and searches and operations stop on any revision change, even one loaded back
  (`tests/result-page-access.test.ts`). The cache reserves each block's estimate before it fetches and any overrun after,
  within its own limit (past it, up to twice the limit, only for blocks reads wait for, trimmed back after), always
  through the global budget, never forcing a charge, and never builds a block past that limit
  (`tests/working-memory-lint.test.ts`).
- **Column types are classified once.** A result column's `sortKind` is set by one factory (`ColumnTypes.SortKindOf`,
  mirrored by `sortKindOf` in `src/shared/results/sort-kind.ts`); sort, filter, pivot, profiles, row identity, Copy and
  Save, highlights and length sorts read `sortKind`, never type-name lists. SQL Server-only refinements the kinds lack
  (uniqueidentifier order, money scale, text and ntext as keys) live beside the factory; `SortKindChecks` and
  `tests/sort-kind.test.ts` pin each consumer's kinds for every SQL Server type.
- **float and real cells keep their exact value apart from their text.** A page holds SSMS's display text (15 and 7
  significant digits), so Copy, Save and the grid are unchanged; a cell whose text reads back as another value
  (`PageBuilder.AppendFloat`/`AppendReal`) keeps its exact value in the page's lengths sidecar (`PageLengths.Exacts`,
  charged with it, never sent to main). Stored pages' readers attach the sidecar (`PageView.With`), and every value
  operation (sort keys, filters, distinct values, duplicates, profiles, Pivot, row identity and comparisons) reads
  `PageView.TryExact` before parsing the text, only for columns that may hold one (`ColumnTypes.HoldsExact`: float
  and real; a sql_variant sorts and groups by its text). A new reader of stored pages attaches it too, and a result built from another (Pivot, comparison)
  carries a copied cell's exact value with `KeepExact` when its own column holds exact values.
- **Named result sets** (`backend/Varia.Backend/ResultNames.cs`, docs/named-result-sets-scope.md): a `#Name="…"` comment
  names the next top-level statement's first result set in its batch. The SQL is sent unchanged; markers are found by
  `SqlScript.Parse`'s masking (not in strings, quoted names or nested comments). Only a batch with a well-formed marker
  is parsed, once however often `GO n` repeats it, by ScriptDom on its own large-stack thread within
  `ResultNames.MaxParseChars` and `MaxParenDepth` (ScriptDom's recursion can end the process).
  - Binding is conservative (docs/named-result-sets-scope.md has the rules): statements are None, One or Unknown, and a
    name binds by position (sets with columns, plans excluded) only where every earlier statement is known, an
    Unknown's only when nothing after it can return a set; a batch that sets NOEXEC,
    PARSEONLY or FMTONLY anywhere, or names SQL Server's plan column, gets none. At run time `ResultNameBinder` stops at
    the first error, a column-count mismatch, SHOWPLAN or STATISTICS PROFILE text, a plan set where a `*` statement
    stood, or a full budget.
  - A name not applied (including one a cancel, timeout or ended script never reached, in a later batch or `GO n`
    repetition too; a repetition's notes name it) is an informational Messages line quoting the
    name and line, never an error or logged, at most `ResultNames.MaxNotes` per run. The descriptor's optional `name`
    carries it; a result's identity stays its ordinal.
- **Visibility** reaches the backend only through `results.visibility`, sent by `ResultVisibilityService` from the grids
  `ResultGrid` registers (one ResizeObserver per window, PaneService for hidden dock tabs, document visibility, no
  timers): the whole set when it changes and again on backend ready or results-port generation change, and, once main has
  reported a state, only while main and the port agree on the generation (until then the backend is taken as ready), ordered by `{ source, seq }`. The backend keeps it in `ResultVisibility`,
  outside page code, as a hint: it never releases, pins or changes a result by itself.
- **Budget figures** change through `ResultStore.Resize` (`results.setMemoryLimit`, sent by main alone when the
  Options limit changes, as each generation becomes ready and after each successful settings read,
  `SettingsStore.onDidLoad`). They are replaced whole, each reservation reads them once, and a change never drops stored
  results or undoes a query's stop (docs/ipc.md, Result store and memory budget). The one other change is a replace's
  allowance (`ResultStore.Allow`, `results.diff`'s `replaces`): it raises one query's limit by the replaced comparison's
  whole charge until that comparison's bytes go back or nothing holds it. The limit is read only through
  `ResultStore.QueryLimit`, so every reservation of the query (rows, working memory on any thread, rooms, waits for room,
  spare memory) sees it; the query's other operations may use the raised limit meanwhile, and the global budget and the
  memory-load check are never raised. Every whole-result operation reserves
  its working memory before it builds (search reserves only its rooms for a packed result, and through a sorted view
  of one the view's inverse, 4 bytes a row of the result, and keeps a narrowing memo of two bits a position as spare
  memory, one a result, freed with it and given back to the search's own reservations when they would be refused: docs/ipc.md, Search in results); small steps go through `WorkSteps`, which asks the memory load once per 64 MiB held.
  `tests/working-memory-lint.test.ts` pins each operation's reservations in `SqlService`.
- **Rows are compared only in the backend.** Row identities (`Results/RowIdentity.cs`, `results.identify`,
  `results.findRows`) hash collation-normalized values; the renderer gets positions and ids, never rows. `GridView` draws
  highlights from sorted positions by binary search per painted row, theme colours only. A cell's own colour (a diff's
  tint, NULL's) is its `background-color`; the row's highlight, a search match and the selection lie over it in that order
  as translucent `background-image` layers set through `--rg-hl`, `--rg-hit` and `--rg-sel`, so none replaces another, and
  no other cell rule sets an image or the `background` shorthand outside forced colours (`tests/results-diff.test.ts`).
  Diffs (`Results/ResultDiff.cs`,
  `results.diff`) store the unified diff as a derived result of the same query: its data columns, then a hidden suffix
  (roles `mark`, `leftRow`, `rightRow`, `tone`) that the grid draws as a gutter in the row header and colours from; the
  one-row layout (`layout: 'entry'`) adds a previous-value column a pair after the data (role `old`, `of` its pair, the
  first result's type), holding the old value in each changed cell, at most 2,046 pairs. Hidden columns are one set, tested only by `isHiddenColumn`
  (`grid/hidden-columns.ts`) and `ResultTextWriter.Hidden`: never drawn, copied, searched, sorted, filtered or profiled,
  and the backend's sort keys, filters, distinct values, profiles, pivots and identify's column refuse them
  (`INVALID_PARAMS`), while search and Copy skip them and window reads serve them (the gutter reads them so); only Save
  of a diff writes `Change`, `Old row`, `New row` first and each data column's previous values after it as `<name> (old)`
  (`ResultJobs.SavedColumns`, from the kind; which cells changed from the tone or, for a cut row, the change index). `tests/result-hidden-columns.test.ts` lints `role === 'tone'`
  to the tone reader and the live readers. A diff's row identity is per entry (`RowIdentity.Entries`: its (input, row)
  pairs, ordered by input result id from `ResultSetBuffer.DiffInputs`), so both halves share it and a swap keeps it.
  Rows match by `results.diff`'s `match` (`ResultDiffer.Compare`: auto, position, whole rows, or a composite key over
  chosen pairs hashed with `CellHasher`, which reads `sortKind`, never type names); repeated keys and look-alikes are
  marks, never kinds: the tone is `<kind> [flag…] [cell…]` (kinds `same`, `changed`, `added`, `removed`, `changedOld`,
  `changedNew`; flags `dup`, `poss=<row>`, `gap=<n>`), kept within 500 characters, and readers ignore unknown flags.
  The look-alike search is bounded (1,000 rows a side, 4,000,000 comparisons) and skipped, not slowed, past its bounds.
  A diff keeps a change index (`Results/DiffIndex.cs`) beside its rows, charged with them and refused with them: each
  stored row's kind, marks, change units and look-alike partner, a cut one-row entry's changed-pair bitset (found
  through a sorted list of cut rows), with running totals per 4,096 rows that each view of the diff keeps over its own
  order. A refusal of what grows with the rows stored, for All rows, is `DIFF_ROWS_TOO_LARGE` (`SqlService.DiffRefusal`);
  every other refusal of a diff stays `TOO_LARGE`. The `kind` view filter, `results.diffSeek` and the answer's `overview` and `units`
  read only this index (a seek reads one tone, of the row it lands on), never the tone column's text row by row.
  Pivots (`Results/ResultPivot.cs`, `results.pivot`) store a derived set (`ResultStore.Open(derived: true)`).
- **Derived sets** (diffs, pivots) take working memory from the query's budget, are stored whole or not at all (a pivot
  past its bounds is refused, not shown in part), and main owns one only once it has the answer (one not sent is released
  at once). Their own refusals (a row refused, or a page sealed under low system memory) fail only that set
  (`TOO_LARGE`) and never stop the query's budget; only a query's own sets stop it (query or global budget full, or low
  system memory at a page seal; never a row limit). While a query still reads, a derived build counts against its
  budget. A derived set asked of a stopped query is refused before work with `BUDGET_STOPPED` and the reason; one cut
  short because its query stopped or its source was released answers `BUDGET_STOPPED` or `RESULT_RELEASED`, not
  `TOO_LARGE`. Once written whole, a source closed meanwhile still leaves it.
- **Grid.** Cells render only through `GridView` pools and text only through `nodeValue` (`tests/grid-lint.test.ts`
  forbids HTML sinks under `grid/`, `results/`, `designer/` and `live/`); no React per row or cell; frames stay
  O(visible cells).
  - The Tabs layout (`ResultsTabs`, `queryResults.grid.layout`) mounts only the focused entry's `ResultGrid`; switching
    unmounts the other (its `GridShell` returns pool and registration, state stays in `GridViewState`) and releases
    nothing in the backend.
  - `GridView` works in drawn rows and columns for geometry, pools and scrolling, and meets the result's rows and columns
    at named seams (`selection`/`select`, `sourceRange`, a cell's lookup in `paintCell`, `targetOf`, `buttonColumn`, Open
    Value and Fit), each the identity in a table; saved state, marks and callbacks are always in result coordinates.
    Columns are placed through `ColumnAxis` (`grid/layout.ts`); tiles have a `TileShape` (`grid/tiles.ts`). A menu's row
    and column come from the grid (`gridTarget`, `grid/anchor.ts`); an ARIA index is read only where no `GridView` is
    registered. `tests/grid-view.test.ts` holds the seams.
  - **Transposed** is an orientation, not a stored result: `GridView`'s `transposed` option swaps rows and columns at
    every seam and nowhere else (`rotateSelection`, its own inverse; tiles 32 rows by 128 columns), so nothing outside
    the grid converts coordinates and nothing turns them twice. It draws the first `limits.transpose.maxRows` rows as
    columns through `UniformLayout` (`grid/uniform-layout.ts`: one shared width of at most 240 px plus at most 256 own
    widths, cleared by a new sort or filter, so streaming rebuilds nothing), with the columns as rows named in a frozen
    first column holding the sort buttons and funnels. Highlights tint drawn columns through pooled bands; a search match
    past the cap is reported (`onBeyondCap`), never scrolled to. Orientation, header column and transposed offsets and
    widths are per view in `GridViewState`; the option is fixed for a view's life. `ResultsService.setOrientation` is
    the only writer (`contributions/transpose.ts` calls it); `ResultGrid` reads `orientation()`, its `turned` store feeds
    `resultsGridTransposed` and the toolbar, and a grid's menu reads orientation from its target (`argsFor`), so Peek
    cards toggle too. Fit Column fits the target's row (`fitDrawn`). A result with hidden columns (comparison, toned live
    table) is never transposed (`transposedView` in `ResultsService.ts`, the one rule for grid, `orientation()`, Copy and
    Save), and only `turnableKinds` (by descriptor kind) offer it; the backend refuses a transposed Save of a diff.
    `results.transpose` answers `METHOD_NOT_FOUND` (`tests/results-transpose.test.ts`). `tests/grid-orientation.test.ts`,
    `tests/results-orientation.test.ts` and `tests/results-toolbar-transpose.test.ts` hold this.
  - A transposed grid copies and saves as drawn, storing nothing: the request says `transposed` (and the header column),
    parts stay in result coordinates (`transposedCopyPlan`), and `ResultTextWriter`'s column-major mode writes a line per
    column for the rows drawn, counting the rest in `capped` (docs/ipc.md, Copy and Save Results As).
  - Live tables show through `LiveGrid` (`src/renderer/src/live/`), which swaps each revision into its `GridView`; the
    row tone column (catalogue `role: 'tone'`, last) is hidden and left out of Copy and Save (`ResultJobs`).
  - **Local tables** show through `LocalGrid` (`grid/LocalGrid.tsx`): a small read-only table the renderer already holds (a
    Peek list, a Properties table), never a backend result. `GridView` reads any `GridSource` (the six read members of a
    `ResultHandle`); `LocalSource` (`grid/local-source.ts`) serves the table from memory, and a sort is a new source the
    grid swaps in. A new table object is a new grid, unless its owner keeps the view state (`state`) and the columns are the
    same: then it is swapped into the same view (a live chart's table re-sampled each tick), so a drag or resize under way goes on. `boundTable` (`src/shared/results/local-table.ts`) holds a table to `localTableLimits`. The table is
    built from the text shown, so a masked value copies and saves masked. Its menu and keys are Query Output's, as a grid
    with its own source (view `live`, `LiveOutput`); a `card` has no Save, and a `fit` page (a list in a scrolling column) is
    sized to its rows as a card is but keeps Save. A kept view state's selection is held to a new table's rows and columns. Its strip says what the bounds left out (rows
    past the first, columns past the first, cells cut). A copy formats a page at a time, stops past the clipboard's bound,
    and stops once a later copy of any grid begins or the page writes other text through main (`grid/copy-generation.ts`; a native copy, such as the editor's, does not stop it, as it does not stop a results copy job). A save is refused before its file is built when it could pass `saveBytes` in the format
    chosen (`localSaveBytes`), is formatted in main a page at a time, and never recreates a deleted folder (docs/ipc.md). `LocalGrid` disposes the view it
    mounts (GridShell leaves that to its owner). Loading, error and Retry stay the surface's own notes; an empty table says
    so in the surface's words (`empty`) over the header. `tests/local-grid.test.ts` and results-smoke's local grid step hold this.
    A read-only list of rows a user may want to copy is a `LocalGrid`. These stay as they are: editable grids (Table
    Designer, New Database, Restore, object dialog pages, Shortcut Mapping, Extended properties), trees (Object Explorer,
    the plan outline, View Dependencies, server files), listboxes whose rows are actions (Search Objects hits, pickers,
    Peek Dependencies), Messages (a log), fact lists (`<dl>`: Peek Properties, plan properties), the column profile's
    cards, and prose. Where such a list copies, it still formats through the TypeScript writer (`localTableCopyText`):
    the plan outline's Copy (its row with a header line per the copy setting) and plan properties' Copy and Copy Value
    (`plans/plan-copy.ts`). An editable grid copies its selected rows on the copy event (Ctrl+C, Edit › Copy) through
    `grid/row-copy.ts`: Table Designer, User Mapping and Securables (whose rows are virtualized) from their models, the others from the row as shown (`domCopyRows`, a cell's
    `data-copy` overriding its text), unless the copy is of selected text.
    Table and Database Properties' lists are `fit` pages (`PropertiesGrid`), and SSIS Properties' lists (`SsisList`) are
    `fit` pages too, each table memoized on the model so editing a draft keeps a grid's selection. Fitted grids in
    scrolling columns render at natural height (`maxRows={Infinity}`) so the outer column is the sole vertical scroller
    (zero scroll-within-a-scroll), while `GridView` (`outerScroll`) virtualizes painted rows against the nearest scrolling
    ancestor so capped lists keep bounded DOM pools.
- **Copy and Save** text is formatted only by `ResultTextWriter` and, for local tables, its TypeScript twin
  (`src/shared/results/text-writer.ts`, which the fake backend uses too), held byte for byte to the same goldens
  (`tests/fixtures/results-text/cases.json`: `TextChecks.cs`, `tests/results-text.test.ts`). A local table copies in the
  renderer and saves in main (`varia:results-save-local`, `ResultsJobHost.saveLocal`). Export paths come only from main's
  save dialog and never leave main except to the backend.
- **Operations busy state.** Whole-result operations (sort or filter building a view, profile, pivot, comparison) have
  one busy state, `ResultsService.operations` (`results/operations.ts`), read by every result control. A sort or filter
  holds that grid's sorting, filtering, funnels, Save and Sort Text By off (`holdsOff`, `refused`: refused, never
  queued, and pulses the operation); Cancel (toolbar strip, Escape in the grid) keeps the previous view. Progress comes
  only from the backend's droppable `op.progress` EVENTs (`OperationProgress.cs`, relayed by main and the worker to the
  request's listener); the renderer's only timers are one-shot (shown after 300 ms, kept 500 ms, a notice for 8 s) plus
  the elapsed-time display clock. `OperationStrip` draws it with its live region, `GridShell` the bar, `GridView` the
  ring on the sort button (text by `nodeValue`). `tests/result-operations.test.ts` and `tests/results-service.test.ts`
  hold this.
- **Release, pins and leases.** Results are released on re-execute, tab close, Close Results, closing one result and
  backend loss; jobs lease them. Every backend reader of stored pages (results.read, view pages, sort, filter, distinct
  values, profile, search, row identity, diff, pivot, Copy and Save, plan pairing) reads bytes only through
  `StoredPage.Body()` (`ResultSetBuffer.Body`) and pins its result while reading (`ResultSetBuffer.Pin`, a count beside
  the leases): a release ends reads at their next check but frees pages and budget only when the last pin and lease end.
  No pin outlasts the reading: whole-result operations run through `SqlService.UntilReleased`, which the release cancels
  (`ResultSetBuffer.Released`, `RESULT_RELEASED`), and results.read pins only to take or build a page, never across its
  wait for credit. Copy and Save lease, so a release never cuts them short. Nothing else touches `StoredPage.Stored`
  (`tests/result-page-access.test.ts`), and the .NET checks refuse reads of an unpinned, unleased set
  (`ResultSetBuffer.RequirePins`).
- **Page packing.** The store may keep a page packed (`PackedPage`: Zstandard level 2, one-page window, `PageCodec`),
  over the page's lengths form (each column's offsets as cell lengths) with typed columns (a column whose every cell is
  the exact text of one number, date, time or GUID shape kept as values in a frame of their own, `PageCodec.Typed.cs`);
  unpacking always returns the page as sealed, byte for byte.
  Packing is an internal switch (`ResultStore.Packing`), not a setting; the policy is `ResultPacker` (docs/ipc.md's
  "Result store and memory budget", measurements in docs/page-compression-findings.md).
  - Find filters: packing a page of 32 KiB or more also builds its n-gram filter (`PageFilter`), which lets Find pass the
    page over unread; it is charged with the packed page (at most an eighth of it, and the page with it still saves a
    tenth), dropped on unpack and never stored apart from it (docs/ipc.md's "Search in results").
  - When: stage 1 packs a complete result of 1 MiB or more hidden in every window for 5 s (`ResultVisibility`); stage 2
    a shown one idle for 30 s (no pin or lease begun or ended, not completed or shown again; `ResultSetBuffer.Activity`
    on `ResultStore.Clock`), the wait doubling per operation that unpacked it whole, up to `MaxBackoff` (3) times, 4 minutes at most. An
    operation's unpack clears the packed mark and counts as a use.
  - At seal: once a query's own set holds 1 MiB (`ResultPacker.FloorBytes`), each page is packed as it seals, the
    earlier pages with the one that crosses it, on a thread-pool worker (one a set, never the reading thread or the workers' gate;
    `ResultStore.PackAtSeal`, `ResultSetBuffer.PackSealed`; a failure drops the queue and leaves the pages raw), so a result larger than its query's half raw is not truncated
    while it waits for the policy. Never a live table or a derived set; never while a pin or lease is held (the page stays
    queued and the hold's end restarts the worker); a release, or a complete result an operation unpacked whole, drops
    what is queued. Only the service running the policy turns it on (`packHidden`).
  - The policy never packs a live table, a result still storing rows, or one pinned or leased (`ResultSetBuffer.Pack`,
    page by page; a page saving under a tenth stays raw). An open view (a sorted or filtered grid) does not prevent packing, nor does an open
    distinct snapshot: their sorts and screens read the packed pages, and a view never unpacks a result whole
    (`node.packedSort.budgetGrowthMb`, `node.viewTile.packedP99Ms`).
  - Idle packing (both stages) runs on its own thread, not the workers' gate: it compresses at the lowest priority (honoured on Windows) and takes locks or
    allocates only at normal priority, so a starved packer never holds a lock a read or query waits on. It wakes only on
    a deadline, a completed result of 1 MiB or more, a visibility change, the end of a pin or lease that stopped it or
    of an operation that unpacked it (signalled through `ResultStore.Settled`), never on a poll, and stops between pages when the result is shown (stage 1), touched (stage 2),
    held, released or the service disposed.
  - Charges: a packed page costs its packed length plus `PageOverhead` plus its sidecar; the saving returns to the budgets
    at once and counts toward `CollectNow`'s next collection, never a compacting one.
  - Packing for room: a query row its own half or the global budget refuses (never a live table's or derived set's)
    waits outside every lock (`TryCommitRow`'s `mayWait`, `ResultStore.CanMakeRoom`, `WaitForRoomAsync`,
    `SqlService.WaitAndCommitAsync`; bounded by `RoomWaitMs`, `SqlService.MaxRoomWaits` and `MaxRoomWaitMs`; rows committed before the waiting row
    are sealed only once it ends) while the
    policy packs at normal priority on the workers' gate the complete, unheld results of 1 MiB or more that could make
    room, never one an operation unpacked and still uses
    (`ForRoom`, `MakeRoom`, `PackForRoom`; any query's for the global budget,
    only its own for its own half; hidden first, then largest, until `StillWaited` is false), then commits the row again.
    The query's own pages queued for packing at seal make room too unless a lease holds them
    (`QueryBudget.SealCanPack`; a pin ends with its read, Find or profile and its end restarts the worker, within the
    wait's bounds): the row waits for them as for
    the policy. With nothing to pack the row is refused at once. A stop is never undone: stored rows are
    a prefix of rows read.
  - Reads: a packed page unpacks into a six-page per-result cache (`CachePages`) only while the budget has spare room
    (`TryReserveSpare`), else for that read alone. A view read unpacks its base pages 64 at a time on the workers
    (`BodiesTogether`, reserved working memory, one at a time when refused) into rooms rented from the store's pool.
  - Room pool (`RoomPool`, `ResultStore.Rooms`): view reads and `PageRooms` rent their rooms from it and give them back
    once nothing reads them (a grid's view read before it hands over a page, Copy and Save through a view when they drop
    the group; `PageRooms` at its end, only rooms their readers gave back), so reading again allocates no large arrays. A
    rented room is at least the page's length (read its first `StoredPage.Length` bytes; the shortest idle room that fits,
    so it may be longer) and its reader is charged the page's length. Idle rooms are uncharged, capped at `RoomPool.IdleBytes`
    (a tile's 64 rooms and one a worker), never kept twice or past `LargestRoom`, and let go after `IdleMs` without a
    rental (the memory timer's `Trim`).
  - Fused reads leave the result packed. Sort, filter, profile and pivot use `ViewSorter.PageSource` and `PageRooms`;
    distinct lists, row identities, diffs and search use `PageRooms.Over` with a `RoomReader` per worker. Each reader
    unpacks the page it reads into a room (one page of the largest packed length, working memory reserved when made,
    returned at the end; `ResultSetBuffer.Read`, never the cache). Rooms are worker state (`WorkerGate` disposes an
    `IDisposable` state) and ask the memory load once per `WorkCheckBytes`. A refusal answers `TOO_LARGE` with the
    operation's sentence and nothing held, except: a profile retries on one thread; a pivot's output (`RowAccess.Hold`) unpacks in place. A key that reads cells (`Key.ReadsCells`) has its column extracted once after the key is built
    (`PageSource.Extract`), so no comparison unpacks a page; refused, the result is unpacked in place
    (`PageSource.Rehydrate`), and only if that is refused does it answer `TOO_LARGE`. Sampled reads use `ForRows`; a
    pivot's in-order pass (`InOrder`) and a diff's writer (`PageAhead`, spare budget only, returned at `HasSpare`'s
    eighth) unpack ahead in two batches of rooms. A diff keeps `ResultDiffer.LeftSlots`/`RightSlots` and past
    `UnpacksPerPage` (counted by `ResultDiffer.Local`) unpacks the first result in place (`TryUnpackAll`). A distinct
    snapshot keeps pages, not bytes (`KeptPages`), reading in row order through one `ReadRoom`. A search through a far
    (sorted) view (`ResultSearcher.Local`) reads in page order instead, each row placed at its view position through the
    view's inverse, and keeps per run only the rows the answer may take (`ResultSearcher.ByPages`); it never unpacks.
  - A transposed Copy or Save holds the pages its rows lie on (`BodiesTogether`, `TOO_LARGE` when refused); a plain one
    reads through one `ReadRoom` (refused, through the accessor and cache).
  - The Memory panel's state is `partial` while some pages are packed and no whole pass has ended since the last unpack
    (`ResultSetBuffer.Memory`'s `Whole`); `ResultStore.PackingSnapshot` feeds `results.memory`, so its figures are the
    budget's. The checks' stores leave packing off unless a check turns it on (`SqlService`'s `packHidden`).
- **Runs, groups and slots.** A run's results are groups (`TabResults.groups`): each original result owns its Table
  slot and at most one Pivot slot; a comparison is its own slot with frozen references to its inputs
  (`TabResults.comparisons`). `sets` is the one flat list in drawn order (a group's Table, its Pivot, the next group,
  comparisons last). `ResultsService.addSet` is the only way a derived result joins a run: a pivot comes only from a
  group's Table of rows (the backend's `results.pivot` refuses anything but `rows`) and replaces the group's Pivot in
  place (`replaceSet`: same entry key, next `revision`, new provenance in `ResultSlot.pivot`, then the old one is
  released, never earlier); a bare run (Peek's, `begin`'s `bare`) takes neither pivot nor diff. A slot's identity is its
  entry key; add no second key for a view, and Transposed is not a view. The pivot builder belongs to one group and
  follows the focused grid (`ResultsService.focusEntry`, `PivotService`); no source picker. Commands tell grids apart by
  `pivotGroup`, `slotOf` and `groupOf`, and Peek grids by their target's `bare` (`outputGridBare`).
- **Pivot follow.** A Pivot follows its Table's filters only through `PivotService.followGroup`, checked in a microtask
  after a results publish, a layout change (`PivotFollowHost`) or a build's end, never on a timer, over the published run
  only (it waits while the grid shows an unpublished view). It rebuilds through Update's path and never again over the
  filters it last built over (`tried`, the last set only; filters whose build it gave up itself may be tried again), so
  failures, refusals and cancels never loop. An automatic build whose Pivot is hidden mid-run is given up; a `followed` rebuild
  never switches the output pane. `pivotShown` is a function of the run, layout, collapsed entries and whether the
  Results panel shows (`PaneService`), so every collapse change goes through `ResultsService.setCollapsed`, never
  `TabViewState.collapsed` directly. The threshold is `pivotFollow`, in one place.
- **Comparisons** read two group Tables of rows only (`comparableTable` in `CompareService`; the backend's `DiffAsync`
  refuses others). The Compare popover's pairing (`results/compare-pairing.ts`) copies `ResultDiffer.Pairs`, pinned by
  `tests/fixtures/compare-pairing/cases.json`, read by `DiffChecks.cs` and `tests/compare-pairing.test.ts`: change both
  and add a case. Names compare through one table, `src/shared/ordinal-casing.ts`, in the backend (`OrdinalNames`), the
  renderer and the fake backend, never ICU casing (its Unicode version differs by platform); `DiffChecks.OrdinalCasing`
  checks it against the runtime. All three pair by looking columns up under the name's key (`nameKey`,
  `OrdinalNames.KeyOf`) and wire, never by scanning the other side per column, so results of thousands of columns pair in
  linear time. Pivots and comparisons share the window's `DerivedJobs` (four at once, busy refusals
  retried), count each other's in-flight results against a run's 1,000 (`adding`; a change of a comparison is not
  counted). A run has one comparison per ordered pair (`pairId`, without Exact text); asked again with other options while
  its first run is in flight, the first run is given up. Its options (layout, Exact text, match, rows) are its state: a
  change goes only through `CompareService.replace`, which asks `results.diff` with `replaces` and shows the answer through
  `ResultsService.replaceComparison` (same entry key and number, widths carried by column name, old result released
  after), one change in flight per comparison (a newer one aborts it). Highlights carry by entry identity
  (`HighlightsService.carry`). Changes are refused while an input is closed (`closedReason`, the `comparisonInputsOpen`
  key). Source links come from frozen `ResultSlot.sources` and go only to an entry whose set key is still the one
  compared; otherwise they read closed.
  Moving between differences (`CompareService.navigate`, `goToPossibleMatch`) asks `results.diffSeek` in the grid's own
  view and steps between one row's units itself, from the tone `GridView` has read (`grid/diff-navigation.ts`); the
  grid lands and selects (`GridView.landDiff`), and reports its active row's tone (`onDiffRow`) for the
  `comparisonRowHasPartner` key. Moves run one after another (a few queue), each waiting for the row it starts on to have its
  tone (`GridView.toneWhenRead`), so a quick repeat steps within the row the last one landed on. The overview strip (`grid/overview.ts`) draws the
  answer's `overview` and shows only while the grid shows the stored rows in their order; nothing polls.
- **Dropping a result.** Every way a result leaves its run goes through `ResultsService.drop`: closing one view
  (`removeEntry`, caption or tab close buttons, Close Result on an ended run; a Table closes its group and Pivot), Close
  Results, a new run, the tab closing. It aborts the entry's sort or filter build, forgets held views, sort, distinct
  snapshots, grid controller and state and stack state, cancels a copy (an accepted save finishes under its lease), and
  releases stored results in one request after any retained-plan copy has read them. Add new per-entry state there, not
  in a caller. Followers give up work on a vanished entry (`PivotService` and `CompareService` abort, search re-searches
  only changed grids, highlights unbind), and `addSet` releases a derived result whose source has gone. A comparison
  outlives a closed input; a Pivot does not outlive its Table. Closing never changes the run's status, summary or row
  total (the query's own rows); closing the last entry sets `TabResults.emptied`, which keeps the Results view
  (`hasResultsView`, `OutputPane.tsx`). `hasResults` (`ResultsService.context`) holds while the run keeps a set or a
  captured plan (Close Results stays); `hasResultSets` (`ResultsService.resultSets`) only while a grid shows a set (rows, a Pivot, a
  plan set or a comparison), and gates Find, Find Next/Previous and Save Results As.
- **Entry keys.** A result is an entry of its run, named everywhere by the opaque `EntryKey` `ResultsService` mints (the
  grid's `data-result-entry`), never by position: sorts, held views, grid state, stack weights, collapse, focus, search
  marks, highlights, panels, commands and menu targets follow the key. A grid's menu target also carries the generation
  and result id, which `contributions/output.ts`'s grid commands check before acting. Names come from the entry's number
  (`entryName`). List order is read only where order is the meaning: stack layout, Compare with Previous Result, search
  order.

## Live data

- **Subscriptions.** Periodic data (Activity Monitor, SSIS monitoring, Object Explorer status) flows only through the
  results port's `live.subscribe` and `live.update`: the backend schedules, the renderer never polls with timers, and at
  most one live EVENT per subscription is unacknowledged (`creditedEvents`; main counts it against stream credit). The
  results worker relays live events undecoded and grants bytes back only once the page applied the event and called
  the stream's `ack` (`ResultClient.live`), never more than the stream's events took. Job progress EVENTs (`results.export`, `actions.execute`, `explorer.index`)
  are droppable, per-request and not periodic data.
- **Catalogue and probes.** Sources and probes live only in `src/shared/live/catalog.ts` (regenerates `docs/live.md` and
  the embedded `Live/live-catalog.json`). Writes are never probes. Test-only sources (`debug.synthetic`) pass only main's
  test schemas (unpackaged smoke runs) and a backend with test hooks. Probe SQL is constant text per probe and band in
  `Live/LiveSql.cs`, or for Activity Monitor `Activity/ActivitySql.cs` run statement by statement through
  `ActivityReader` (a statement the login may not run fails alone). Each offline lint refuses metadata built-ins,
  temporary tables, writes, DDL, transactions, waits, dynamic SQL and TOP without ORDER BY. `LiveSql.Lint` also allows,
  after the prologue, only the statement kinds SELECT, WITH, DECLARE and IF/ELSE/BEGIN … END, and no number holding a
  letter but a hex literal (T-SQL reads `1DELETE` as 1 and DELETE, where a regex word boundary sees one word). It
  refuses a code or name character outside printable ASCII (SQL Server reads U+200B as whitespace, which .NET's `\s`
  does not), a four-part (linked-server) name, a locking or isolation table hint, MAXRECURSION, QUERYTRACEON and
  MIN_GRANT_PERCENT, functions that read the server's files, log or every page (`fn_xe_file_target_read_file`,
  `fn_dump_dblog`, `dm_db_index_physical_stats` and kin; a file path can be a UNC share on another host), and system
  functions that do a refused thing inside (`dm_exec_describe_first_result_set` compiles SQL from a literal,
  `fn_my_permissions` resolves names, `CERTPRIVATEKEY` reads a secret). Its name checks read bracketed and quoted names
  unwrapped (`l.[password_hash]` is still `password_hash`). Live Plan's `query.plan.operators`
  probe (source `query.plan`, run by `Plans/LivePlanSampler.cs` on the server pool) takes its SQL from
  `Plans/LivePlanSql.cs`: one text per permission scope (Azure SQL Database, SQL Server 2022 and later, older versions and
  Managed Instance), each with `LiveSql.UncommittedPrologue` and its permission check in the same batch, held to `LiveSql`'s
  lint except that `DB_NAME()` may appear once, in Azure's permission check. Probes run on their scope's
  own pool (" - Activity Monitor" for server DMVs, " - Integration Services" in the catalog's database) with its prologue
  (READ UNCOMMITTED, or READ COMMITTED for an SSISDB with RCSI; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW), under the live
  gates and one budget per probe (shared by an `ActivityReader` probe's statements); failures are values that back off.
- **Views.** Views open live data only through `LiveService` (`src/renderer/src/live/`), which pauses hidden views, ends
  dormant ones and follows Reconnect; badges and summaries read `LiveService.peek` and never subscribe. Charts draw only
  through `ChartView` (`live/ChartView.ts`): a canvas from the probe's ring, at most one draw a frame and none off screen
  or hidden, at most two vertices a pixel column, colours only from the theme (`charts.*` and `chartSurfaces` in
  `src/shared/theme/charts.ts`) or system colours under forced colours. Object Explorer status chips are `background`
  views (`ExplorerStatusService`, isolated by exact target, handle and generation, owned by the pane, sampling in
  master): at most 8 a window, in slots no other view wants, given up to views the user opens when slots run out or the
  backend refuses them `BUSY`; they never reload the tree.

## SQL the backend runs

Every path: constant text, values as parameters, names only through server-side `QUOTENAME`, checked by its offline
lint, on its own pool or connection with a fixed prologue (the actual-plan collector has none, below). Never log names, SQL, values or messages.
Metadata built-ins stay out of every read: they ignore READ UNCOMMITTED, so behind another session's uncommitted DDL they
wait out LOCK_TIMEOUT and fail with 1222, and `HAS_PERMS_BY_NAME` waits and then answers 0 without an error. The lints
check names as SQL Server resolves them (`CatalogSql.Uses` and `SecretUses`: bracketed or quoted names unwrapped, comments
and spaces before a parenthesis ignored, nothing outside printable ASCII), and a lint with a word list of writes also
refuses a word glued to a number (`CatalogSql.GluedNumbers`; T-SQL reads `1DELETE` as `1` and `DELETE`).

- **Object Explorer.** Structure lives only in `src/shared/explorer/catalog.ts` (folders, kinds, icons, filters,
  version gates, kinds with live status chips, whose words are in `status.ts`; regenerates `docs/object-explorer.md` and
  the embedded `Explorer/explorer-catalog.json`). SQL is constant per query, band and filter shape; no metadata
  built-ins; `READ UNCOMMITTED` and `LOCK_TIMEOUT 5000` on the explorer pool. The `CatalogSql` lint renders and checks
  every variant.
- **Peek definitions** are never cut. Text comes in pages of `peekLimits.definitionPageChars` UTF-16 code units, far
  under the 16 MiB response bound: `explorer.peek` carries the first page with the facts; a longer text
  (`definitionLength`, `definitionStamp` = `modify_date`) is read a page at a time with `explorer.peekDefinition`
  (constant `PeekSql.DefinitionPage`, `SUBSTRING` from `@offset` under a binary collation), each requested once the last
  is in, joined in the renderer (`PeekReads`). A page never ends inside a surrogate pair. A length or stamp that differs
  from the first page's means the module changed, and the part says so. Closing, replacing or refreshing cancels the
  page being read. The one bound is `peekLimits.definitionMaxChars` (2^27 code units, a renderer memory bound): a longer
  text is not read, never shown in part. Search Objects' details pane reads pages only up to its `shownChars`.
- **Peek lists** (`peekLists` in `src/shared/explorer/peek.ts`) come with the facts in `explorer.peek`'s batch, each
  `TOP (@take)` in a fixed order, and show through `PeekListGrid` (card or page preset). Columns' and Parameters'
  Definition is composed in C# (`PeekSql.ColumnRow`, `ParameterRow`) from names the batch quotes with `QUOTENAME`, since
  catalogue SQL holds no literals; a T-SQL parameter's default comes from its module's header (`ModuleHeader`), matched by its declared catalog spelling.
- **View Dependencies** (`src/shared/explorer/dependencies.ts`, `DependenciesService`, `dependency-tree.ts`) has no SQL
  of its own: a level is `explorer.dependencies`, Peek's lookup and one of the Dependencies tab's two listings
  (`PeekSql.Level`, joined by `PeekSql.Dependencies`), on Peek's slot and budget. A level is read only on expand, at most
  `dependencyLimits.perLevel` objects (`dependencyLevel`, mirrored in C#), the tree at most `dependencyLimits.nodes` and
  `.depth`, each cut marked. A node already above on its branch is a cycle leaf; another database's or a linked server's
  object is a leaf; neither is read. Closing the dialog or changing its choice cancels running reads (`explorerCancel`)
  and drops their answers.
- **Search Objects' index** (`backend/Varia.Backend/Search/`, docs/object-search.md) lives only in backend memory, one per
  connection, dropped on disconnect. Limits are `objectSearchLimits` (`src/shared/explorer/search.ts`, mirrored in C#,
  `tests/object-search.test.ts`); everything it holds (an `ObjectTable` per database with its editor metadata, `ObjectDetails`, and the lookup arrays the
  editor's in-process `IndexLookup` builds on first use, names, definitions, by
  `IndexMemory`'s estimates) is under one 512 MiB budget for all connections (`IndexBudget`), with names and definitions
  held once in a reference-counted `StringPool` (long definitions as zstd `PackedText` frames, equal by content). It reads on its own pool (" - Object Search", the explorer's prologue)
  from `ObjectSearchSql`'s constant batch, run per database only through `QUOTENAME(@db).sys.sp_executesql` (linted by
  `CatalogSql.Lint`), and server objects from `ObjectSearchSql.Server`. It indexes every kind Object Explorer lists but
  the SSIS Catalog's, Microsoft-shipped objects included; the resource database's are read once per build and shared by
  fingerprint in `ResourceCatalog`. Object Explorer's search box and the Search Objects tab are one search
  (`SearchPanel`, `ObjectSearchService`), and the header's Search (Ctrl+Q) lists objects only from it (`quickSearch`);
  the tree has no filter of loaded rows. Regex runs only `NonBacktracking` with a match timeout; an unreadable database is
  a skipped value. Never log names, definitions or search text. A BigQuery connection's index (`ObjectSearchService.BigQuery`,
  `BigQueryIndex.cs`) is the same per-connection index and budget, one read per dataset (`DatabaseIndex.Dataset`), built
  from free REST metadata calls (`IBigQueryIndexSource`, through the per-principal limiter); DDL marks datasets stale for
  the next `stale` build (`MarkStale`). Its only jobs are the opt-in billed bulk path (`BigQueryBulk.cs`,
  `BigQueryService.Bulk.cs`): a full build's `bulk` locations exist only after `bigquery.indexEstimate` and the renderer's
  cost prompts, and the rows must fill the same entries pass 2 would (`BigQueryIndexChecks.Bulk`).
- **Script As.** Verbs, titles, URN types and preflight ids live only in `src/shared/scripting/catalog.ts`, options only in
  `options.ts` (regenerate `docs/scripting.md` and embedded `Scripting/scripting-catalog.json`). Its own pool
  (`READ COMMITTED`, `LOCK_TIMEOUT 10000`, database context restored before pooling); SMO only through `ScriptPipeline`
  with a fresh `Server` per job and prefetch limited to one object's children; `HeaderGuard` on every script with
  headers; SMO's comments for unresolved references left out (they hold names with unescaped line breaks, and since SMO
  181.38.1 a name with a comment delimiter as "?", so the warning names it) and any other comment batch a name breaks
  refused; output capped at 4,000,000 characters; never executes DDL; never logs scripts, names or options.
- **Object actions** (Select Top 1000 Rows, Rename, Delete, Properties, Restore Database, login Disable/Enable, folder
  actions such as Databases › Attach), their dialogs, pages and database options live only in
  `src/shared/actions/catalog.ts`, `database.ts` and `logins.ts`.
  - Object DDL runs only in `ActionService` (and `SsisActionService`, below; the actual-plan collector's event-session
    DDL is the only other DDL), on its own unpooled, never-retried connection
    (application name plus " - Object Actions"), never the explorer or scripting pool, after a preflight in the same
    connection.
  - Statements come only from linted constant templates and builders: `ActionSql`, `Actions/DatabaseAlter`,
    `Actions/TableAlter` (extended property procedures via `QUOTENAME(@db)`, `TableAlter.LintProcedure`) and
    `Designer/DesignerSql` under `ActionSql.LintExecutable`; `Actions/CreateDatabaseSql` (own `Lint`: file names and
    paths as server-quoted N'' literals under a binary collation, plus `Actions/JsonBuilderLint`'s OPENJSON rules: number or `nvarchar(max)` columns, text only inside
    `QUOTENAME`);
    `Actions/PermissionSql` (`PermissionSql.LintExecutable`); `Actions/AttachSql` (`AttachSql.Lint`, paths only in one server-quoted JSON parameter, `DBCC CHECKPRIMARYFILE (@mdf,
    n)`); `Actions/RestoreSql` for RESTORE and BACKUP, binding only variables (`RestoreSql.LintMedia`); `Actions/LoginSql`
    (`LoginSql.LintExecutable`, chained by `ActionSql.Lint`; the password only as `@password` behind a NULL guard through
    a binary-collation REPLACE, never a literal). Names (the batch's database included) go through server-side
    `QUOTENAME`, numbers through `CONVERT` of range-checked parameters, keywords only from the embedded catalogue,
    collations only as `sys.fn_helpcollations()` names them. Live checks prove the server builds what Script Action
    shows for hostile names, and that Database Properties' script equals SMO's capture of SSMS's sequence.
  - DDL waits for locks as SSMS does (`LOCK_TIMEOUT -1`), so every DDL path has a Stop (the dialog's, or the status bar's
    for rename and login Disable/Enable) whose reply waits for SQL Server and lists completed steps. Statements run
    through a reader (`ActionService.ReadAllAsync`, never `ExecuteNonQuery`, `tests/action-reader-lint.test.ts`); Stop
    reaches one only through `ActionService.StatementStop` (SqlClient's own cancel waits while info messages stream),
    cancelled off the frame loop. A `long` action takes the per-connection long gate and reports message 3211 as
    droppable `action.progress` EVENTs relayed only to the requesting window (`varia:actions-progress`); a closing
    backend stops it and waits for cleanup (`DrainCommitted`; main's `drainMs`, `actionDrainMs`).
  - Varia undoes only its own partial changes and drops only a RESTORING database its own restore created
    (`ActionSql.DropRestoring`, identity checked in the batch). A database Delete carrying Delete Object's
    `DatabaseIdentityDto` binds each statement on the database through `PlannedStatement.Bound`, which first checks
    `database_id` and `create_date` (`ActionSql.CheckOf`); only those batches may read `@id` and `@created`.
  - Script never runs anything. Describe and script reads use `LOCK_TIMEOUT 10000` (the advisory loginFacts describe
    under READ UNCOMMITTED). Every lint refuses `LOGINPROPERTY` (it locks at any isolation level) and any password hash
    read (`CatalogSql.SecretUses`). The test-only dry run is an internal C# method, never a request field.
- **Table Designer.** Types, properties, commands and limits live only in `src/shared/designer/catalog.ts` (regenerate
  `docs/table-designer.md` and embedded `Designer/designer-catalog.json`). DDL runs only through `actions.execute`'s
  `createTable`, in one transaction: the backend re-validates (`TableDesignValidator`) and sends the design as one JSON
  parameter; constant builder batches (`DesignerSql.Builder`, `ActionSql.LintExecutable`'s designer form) shred it with
  OPENJSON and compose statements from `QUOTENAME`d names, `CONVERT`ed numbers and type keywords from a table generated
  from the catalogue; a live dry run proves the server builds exactly `DesignerSql.Statements` for hostile names. The
  design lives in the renderer (`TableDesignerService`, a `CustomDocumentProvider` tab with no Monaco model), never
  reaches AutoRecover, and saves outside the document task.
- **Activity Monitor.** Probes, panes, tables and columns, tiles, view chips, wait categories and limits live only in
  `src/shared/activity/catalog.ts` (regenerate `docs/activity-monitor.md` and embedded `Activity/activity-catalog.json`);
  its live probes are built from it, column ids unique within a probe (`liveColumnId`). SQL is constant per probe,
  statement, band and capability in `Activity/ActivitySql.cs`: DMVs (joined to `sys.databases` and `sys.master_files`
  for names), sizes and caps from the catalogue, no metadata built-ins, temp tables, `sys.sysprocesses` or
  `dm_tran_locks`, every TOP ordered (only the capability probe asks what the login may do). Filters run in backend
  memory over a sample (`ActivityFilter`, sent as the source's args), never in SQL. A session is one of Varia's pools (hidden by default) only when
  its id is one Varia's pooled or Object Actions connections were given (`ILiveHost.OwnSessions`), never by claimed
  process id, host or program alone; `VariaSessions.Protected` (ledger ids or those claims) is the wider set refusals
  use, since SqlClient's reconnect can move a pool connection to an unrecorded id.
  Session actions (`Activity/SessionActions.cs`) have the only exemptions: `activity.details` reads `dm_tran_locks`
  only on request, on the monitor's pool under the live gates; `activity.kill` runs on the object actions' connection,
  one guarded batch per session that checks identity (login time, host process id), refuses its own, system and this
  backend's pool sessions (every connection, any Application Name), then runs a server-built KILL from an int
  parameter. Neither logs session ids, logins, hosts or SQL.
- **Actual-plan collector** (`ActualPlanSql`, docs/execution-plans.md) runs on the observer's own connection, never the
  query's. Its SQL is constant text per scope and version variant, rendered once; its event-session SQL is held to `ActualPlanSql.Lint` (a connection-id read in
  `ActualPlanCapture` is not):
  dynamic SQL only through `sys.sp_executesql` of text built from literals, `QUOTENAME(@name)` and server-side `CONVERT`s
  of typed parameters; only known variables; no DDL but event sessions'. All DDL values are parameters. It has no
  prologue: besides a permission check and a connection-id read it only creates, starts, reads and drops its event
  session, and drops abandoned Varia collectors it recovers.
- **Agent service control** (`AgentServiceControl`, docs/sql-server-agent.md). The Agent node's Start, Stop and Restart are
  the only object actions that run outside SQL Server: Windows' Service Control Manager, through the `IServiceControl` seam
  (offline checks use its fake), as the Windows user Varia runs as. The machine and service names come only from the
  server (`SERVERPROPERTY`) and pass strict patterns before any call; every call and wait is bounded by the Agent catalogue's
  limits, and refusals are values (`PERMISSION_DENIED`, `SERVICE_UNREACHABLE`, `NOT_FOUND`, `NOT_SUPPORTED` off Windows, on
  Linux, Managed Instance and clustered instances). `xp_servicecontrol` only reads the state; `AgentSql.LintExecutable`
  admits it nowhere. The job verbs' msdb batches pass the same lint and resolve the job by its tree identity first.
- **SSIS Catalog.** Code tables, `ssis.describe` views, `ssis.execute` verbs, Explorer verbs and commands, documents,
  error codes, features and limits live only in `src/shared/ssis/catalog.ts` (tree kinds and folders are Object
  Explorer's); it generates `docs/integration-services.md` below its marker line only.
  - Reads use the SSIS read pool (" - Integration Services", Initial Catalog the catalog's database, idle connections
    kept until disconnect) or a write's preflight, never the explorer pool, from `SsisSql` and the explorer's SSIS
    listings under `SsisSql.Lint` (no metadata built-ins, `datetime` conversions, dynamic SQL, writes or
    `SYNCHRONIZED`): listings and describes `READ UNCOMMITTED` (describes `READ COMMITTED` with RCSI) with
    `LOCK_TIMEOUT 5000`, the profile's role checks 1000.
  - Writes only in `SsisActionService` (`ssis.execute`, sensitive): own unpooled, never-retried connection
    (" - Integration Services Actions"), preflight in it (READ COMMITTED, `LOCK_TIMEOUT 10000`, 25 s), steps only from
    `SsisSql.WriteTemplates` calling only their verb's procedures (`SsisSql.LintWrite`), no outer transaction,
    `LOCK_TIMEOUT -1` until Stop, whose reply waits and lists completed steps (`AnswersStop`). A verb SSISDB refuses to
    SQL logins answers `WINDOWS_AUTH_REQUIRED` on a box server before connecting.
  - The catalog database name comes only from internal `SsisOptions.CatalogDatabase`, never a request; there is no 32-bit
    runtime option.
  - Server verbs (Create Catalog) are the SSIS DDL path: same rules in `master`, commands only from
    `SsisCreateSql.ServerCommands(verb)` (`SsisCreateSql.Lint`: dynamic SQL only where SQL Server takes a literal, from
    `QUOTENAME` or `REPLACE(… COLLATE Latin1_General_BIN2, N'''', N'''''')`), database name from the catalogue or internal
    `SsisOptions.CreateScratch`. Stop cancels any statement but the restore; a Stop or failure after it removes exactly
    what the request made, waiting at most 30 s per lock.
- **BigQuery** (`BigQueryService`, docs/bigquery.md) runs GoogleSQL through its REST client, never legacy SQL
  (`useLegacySql` false; `#legacySQL` is refused before a job exists). The connect probe dry-runs the constant
  `BigQueryService.ProbeSql`; every job carries `BigQueryService.Labels`. Its own session statements are the constants in
  `BigQuerySql` (`COMMIT TRANSACTION` in the tab's session; `CALL BQ.ABORT_SESSION(@session_id)` outside it, the id a
  STRING parameter), held to constant text by `BigQuerySessionChecks`; a session id is kept only when `BigQuerySql.SessionId`
  accepts it, and never leaves the backend.
- **BigQuery names** (`BqNames`, docs/bigquery.md#object-explorer). BigQuery has no `QUOTENAME` and no identifier parameters,
  so an object's name reaches SQL text (Script As' templates, CREATE's `INFORMATION_SCHEMA` qualifier and the bulk index's
  region qualifier, `BqNames.RegionPath`) only through
  `BqNames`: its kind's rule, the same as `src/shared/bigquery/names.ts`, then backticks with backslashes and backticks
  escaped; a refused name throws `INVALID_PARAMS` first, and values stay parameters. `BigQueryExplorerChecks` renders every
  template with hostile names. Object Explorer, Preview Rows, Properties and Search Objects' details pane read only BigQuery's
  free REST metadata calls, through the per-principal limiter (`BigQueryRateLimiter`), and never run a job; Script As ›
  CREATE's billed query, the details pane's Show CREATE Statement and the bulk index go through the cost prompts first.
- **Dry runs send query text.** `bigquery.dryRun` sends a BigQuery tab's editor text to Google without running it. It is
  the one path that does so automatically, without a user action: after an editing pause, for diagnostics and the estimate
  beside Execute (`BigQueryCostService`). It runs only for a connected BigQuery tab, only after the user edits or executes
  (never by itself after a restore or a provider switch), and Text Editor › GoogleSQL turns the automatic one off; Execute
  still dry-runs what it is about to send.

## UI structure

- **Provider gating.** Commands, submenus, Explorer kinds, object actions, live sources, settings pages and Script As
  kinds have `providers`, SQL Server only when absent. Commands (object and server actions' commands take their spec's)
  are gated at run time, and submenus in Object Explorer's menu: `CommandService.isEnabled` checks a command against `activeDocumentProvider`, or
  `explorerSelectionProvider` for an Object Explorer command or one run on an Object Explorer node or search result (whose
  arguments stand the object's engine in), and not at all for one that finds its own object (`providerContext`;
  `commandProviderKey`), and Object Explorer's menu leaves out items whose `providers` lack `explorerProvider`. The
  other catalogues' `providers` are read by the lint and by the lanes that add BigQuery's surfaces. What enforces the
  engine is the method gate (docs/ipc.md#providers). `tests/providers-catalog.test.ts` lints that an entry whose
  `when` names a provider declares it, and that one declaring `bigquery` names no method that serves SQL Server only (the
  methods a command lists in `methods`; the other catalogues name theirs).
- **Commands and keys.** Commands and keybindings are declared only in `src/shared/commands/catalog.ts`.
  `KeybindingService` (`src/renderer/src/core/keybindings.ts`) is the only key listener and routes keys to an open menu
  first; main handles no keys (`tests/keyboard-lint.test.ts`). Electron roles are commands (`role`): native menus show
  the role, custom menus and the palette run it through `varia:run-role`. Varia's two-part chords are `bridge`
  keybindings, registered with Monaco by `registerEditorBridge`, which Monaco dispatches. The one other Monaco rule is
  Escape closing Peek's card (`registerPeekCardEscape`), while a query editor's `variaPeekCard` key is set (never in Peek's
  own editor); an added rule outranks Monaco's defaults, so its clause steps aside for each Monaco widget that takes Escape
  (`monacoEscapeContextKeys`, pinned by `tests/monaco-keybindings.test.ts`). User shortcuts reach the
  renderer only through `ShortcutsService` (`src/renderer/src/core/ShortcutsService.ts`), which hands `effectiveRules`
  to `KeybindingService.setRules` and the file's gestures to `GestureService.setModifiers`; the Shortcuts page records
  keys only through `KeybindingService.capture`. Peek's Ctrl state, and the column profile's (`ProfilePeekService`), comes from
  `KeybindingService`'s `keyDown`, `keyUp` and `blur` hooks (`PeekService.keyDown`), never a listener of its own; its cursor is CSS (`data-peek-armed`). Monaco's defaults (the modules `start.tsx` imports, all platforms) are
  generated into `src/shared/commands/monaco-keys.generated.ts` by `tests/fixtures/monaco-runtime.ts`.
- **Output yield.** While the active document is not a query, `OutputYield` (`src/renderer/src/output-yield.ts`) hides
  the grid group of output panels directly below the query editor, across its width and at the bottom of the dock (so Dockview gives its
  space to the editor) with Dockview's group visibility, which keeps its size for when a query is active again; moved,
  floating and popped-out output panels are never touched, and a query shown in another editor group keeps them. The
  saved layout always shows that group (`withGroupShown`), so yielding writes nothing and a restart or saved layout never
  loses the output; any change to the docked arrangement while it hides (a panel moved into it, a docked group added or
  removed) shows it again (`check`). It re-decides only when the active document changes between a query and another
  kind or a query appears or goes in another editor group, so a panel revealed over such a document stays until then
  (`tests/output-yield.test.ts`).
- **Gestures** are declared only in `src/shared/commands/gestures.ts`; handlers read pointer modifiers only through
  `GestureService` (`src/renderer/src/core/gestures.ts`, `tests/gesture-lint.test.ts`). Every pointer command has a
  keyboard path, and tooltips naming a gesture take its words from the service.
- **Menus** are declared only in `src/shared/commands` (placements in `catalog.ts`, submenus in `menus.ts`) plus
  `src/shared/theme/menu.ts`. Windows/Linux render them in `src/renderer/src/menus`; macOS natively from ids. Main's
  application menu takes only command-id sets (`menuStateSchema`) and sends back a bare id; it is the macOS menu bar and
  hidden elsewhere, where it still serves role keys. macOS context menus (`src/main/context-menu.ts`) open only in the
  focused window or within 1 s of input there, and send back a token and an id. Menu targets
  (`src/renderer/src/menus/targets.ts`, `useMenuTarget`) never cross IPC. `MenuService` is the only `contextmenu`
  listener, and only `.menu-layer` reaches z-index 30000. A closed shortcut popover leaves its visible invoker as menu
  anchor and focus destination; deferred Connect focus yields to newer input recorded by `WindowRegistry` (popouts too). Pinned server shortcuts use the
  same canonical connection target as ordinary rows.
- **Settings** live only in `src/shared/settings/` (pages in `pages.ts`, definitions per area aggregated by `catalog.ts`;
  the Scripting page from `src/shared/scripting/options.ts`), with defaults, bounds, platforms and zod schemas built from
  the definitions. Only main reads and writes `settings.json` (`SettingsStore`: overrides only, read before every
  write, atomic, invalid files quarantined); the renderer gets validated values through `SettingsService` and changes
  them only with `updateSettings` patches.
- **Colours** live only in `src/shared/theme/`; CSS and TSX use `var(--varia-*)` (`tests/theme-css.test.ts`). Theme files
  are untrusted: only main reads them, and the renderer applies only the validated map main sends.
- **Metrics.** Sizes, radii, shadows and motion are tokens in `src/shared/theme/metrics.ts`, mirrored on `:root` in
  `styles.css`. `tests/theme-metrics.test.ts` rejects literals outside them (renderer font sizes too), keeps text at
  11 px or more, lets only hover fills fade, and stops every animation under reduced motion (Monaco's codicon spinners
  included). Reduced motion is opt-in (Environment › General › Reduce motion when the system asks): only
  `services/reduced-motion.ts` reads `prefers-reduced-motion`, and it sets the root class `varia-reduced-motion` that
  every reduced-motion rule keys off and popouts copy (`tests/reduced-motion.test.ts`).
- **Icons** live only in `src/shared/icons.ts` (codicons and Varia's SVGs, by id); catalogues name icons by id and the
  renderer draws them only through `Icon.tsx`, or `codiconClass` where an element or Monaco takes a class
  (`tests/icons.test.ts` forbids other codicon classes, inline SVGs and text glyphs). Fonts are fixed in
  `src/renderer/src/fonts.ts`.
- **Object inspectors and properties.** Full inspectors (`TableProperties`, `BigQueryPropertiesTab`, `PeekCard`,
  `PeekTab`) share `ObjectInspectorFrame` (`src/renderer/src/kit/ObjectInspectorFrame.tsx`) with canonical tab order
  (`Overview`, `Definition`, `Storage & Layout` / `Usage Telemetry`, then data/relationship tabs), focus-scoped
  `Ctrl+1`–`9` (`objectInspectorFocus`), and a collapsible, resizable Vitals rail whose open state and width persist
  independently for `full` and `peek` surfaces (`src/main/json-file.ts`). Every inspector and secondary property surface
  (`DatabaseProperties`, `SsisProperties`, `SearchDetails`, `DependenciesDialog`) renders read-only metadata through
  `FactGrid` (click-to-copy via `window.varia.writeClipboardText` with polite status announcements) and proportion meters
  through `RatioBar`, upholding the zero scroll-within-a-scroll invariant: flow panes scroll as one page with
  natural-height `LocalGrid` tables (`maxRows={Infinity}`), while fill panes host one edge-to-edge scrolling grid or
  Monaco editor. Editable property sheets keep `FieldHintStrip` in a zero-height overlay dock cleared via
  `<FieldHints resetKey={...}>` on tab or section switch.
- **Getting Started** uses `src/shared/help/catalog.ts` and lazy JSX guide modules with matching stable IDs; references
  resolve through the live command, setting, effective shortcut and gesture catalogues. Lesson focus is explicit, so Help
  focus does not erase editor or results bindings. The singleton custom document has no text model, SQL session,
  recovery record or persisted progress; its frame and navigation stay mounted while only the section body loads or
  fails, and guide modules never refocus on load. Samples are bounded fictional illustrations with local state that
  never connect, execute SQL or duplicate result processing. docs/help-authoring.md owns the workflow.
- **Release notes** are reviewed, versioned plain-text records (`release-notes/*.json`) validated by
  `src/shared/releases/schema.ts` and explicitly bundled by its catalog. Their read-only document uses the normal custom
  provider and frame, with no SQL model or backend connection. Requested versions match exactly; missing notes never fall
  back silently or block the updater. `scripts/release-notes.mjs` also generates public release bodies and changelog
  sections. Manual downloads use the fixed main-owned releases URL.
- **Updates** live in `src/shared/updates.ts` (feed, manifest schema, states, failure words); docs/updates.md. Only main
  fetches (its own in-memory session, `net` through the system proxy and certificate store), verifies size and SHA-512
  against the release's `varia-update-v2.json` (written by `scripts/update-manifest.mjs`), and installs only after
  Restart to Update's quit has closed the windows and stopped the backend (`src/main/update-install.ts`). The page gets
  only `UpdateState` and asks with argument-free calls; it never names a URL or path. The release job keeps writing
  `varia-update.json` in its first shape: builds up to 0.7.0 refuse unknown kinds or fields, so new kinds go only in the
  current manifest. An installed Windows copy whose folder the user can write stages a release beside itself and swaps
  it in at restart through the update helper (`backend/Varia.Updater`, `src/main/update-staging.ts`): paths only from
  main, only in the one staging folder beside the installation and only when that folder is this user's alone (main
  trusts no marker there itself; it asks the helper), SHA-512 checked again before unpacking, no elevation. Anything it
  cannot do falls back to the installer, for that release in every later run too (`update-failed.json` in the profile,
  written before every swap starts). macOS builds do not update themselves until they are code signed.

## Generated documents

After changing a catalogue, regenerate with the command in CLAUDE.md's Generated files table: commands
(`docs/commands.md`), Monaco keys, gestures (`docs/gestures.md`), live (`docs/live.md`, `Live/live-catalog.json`),
explorer, scripting, actions, designer, activity, SSIS, GoogleSQL (`docs/googlesql.md`), settings (`docs/settings.md`), metrics
(`docs/themes/metrics.md`) and icons (`docs/icons.md`). Backend catalogues embed their generated JSON.

## Product direction (agreed with the owner)

CLAUDE.md has the summary. In addition:

- Core first (connections, databases, objects); SSIS, replication and credentials later.
- IPC v2: length-prefixed MessagePack frames (control and row pages), server push and streams with credit-based
  backpressure, MessagePort with transferable ArrayBuffers to the renderer.
- Menus: custom-rendered themed title bar and context menus on Windows/Linux; native global menu bar and context menus
  on macOS.
- Authentication: SQL, Integrated (Windows SSPI; Kerberos on Linux/macOS) and Microsoft Entra ID.
- Visuals: Compact density by default with Comfortable as an option. Dense Power's environment and status indicators
  are in (the red Production tag on connections, live Object Explorer status chips), showing only what a probe produces.
  Icons are codicons (bundled with Monaco) plus custom SVGs. Themes: Dark and Light (plus follow System), customizable
  through a standardized palette system like VS Code or opencode.
