# Varia SQL Manager

SSMS-style SQL Server workbench. Electron 44 + React 19 + Monaco 0.57 + Dockview renderer; a .NET 10 sidecar
(Microsoft.Data.SqlClient 7.1, SMO 181) speaks length-prefixed MessagePack frames (protocol v2) over stdio. It is not a
VS Code fork.
README.md documents user-facing behaviour, limits, and the protocol; docs/ipc.md is the protocol v2 reference (frames,
pages, limits, error codes, display formats, benchmarks).

## Commands

- `npm ci`: install. Use `npm install <pkg>` only to change dependencies, and commit `package-lock.json`.
- `npm run dev`: Debug backend build, then electron-vite with renderer hot reload. Restart after C# changes.
- `npm run check`: typecheck, Release .NET checks, vitest, production build. Run before every commit.
- `npm run test:smoke`: the Electron suites listed in package.json's `test:smoke`. Needs the Release backend and `out/`
  from `npm run check`.
  Headless Linux: `xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke`.
- `npm run test:electron`: `check` followed by `test:smoke`.
- `npm run backend:test`: only the .NET checks. `npx vitest run tests/<name>.test.ts`: one vitest file
  (`backend-sidecar.test.ts` starts the Release backend, so build it first with `npm run check` or `npm run backend:test`).
- `npm run bench` (node harness, Release backend), `npm run bench:e2e [-- --live]` and `npm run bench:grid [-- --live]`
  (Electron, need `out/`): the IPC and results grid benchmarks, not part of `check`. `node scripts/check-bench.mjs
  [--enforce]` compares them with `tests/bench/floors.json`; CI enforces floors on Linux only.

## Environment

- Node.js 24+ and the .NET 10 SDK (`global.json`, latest feature band). In cloud sessions `.claude/hooks/session-start.sh`
  installs both, runs `npm install`, builds the backend (Debug and Release; a failed build is reported, not fatal), and
  puts `/opt/node24/bin` on PATH. After clear or compact it only refreshes the exported variables.
- Live SQL checks run when `VARIA_TEST_SQL_SERVER` is set: SQL authentication with `VARIA_TEST_SQL_USER` and
  `VARIA_TEST_SQL_PASSWORD`, otherwise Windows authentication. The .NET suite then reports more than its 884 offline
  checks; how many depends on the server version and authentication (1414 against a local SQL Server 2025 in Mixed Mode, which
  adds the low-privilege login checks, with Windows authentication and `VARIA_TEST_SQL_SCRATCH=1`, which adds the Object Explorer, Script As and object action
  scratch-database checks (the last in their own `VariaScratch_…_act` database) and the script goldens in `tests/fixtures/scripting/`; `VARIA_UPDATE_SCRIPT_GOLDENS=1`
  rewrites the goldens whose manifest source is `varia`),
  and `connections-smoke.mjs` connects for real. Never print the password. `VARIA_TEST_SQL_SCRATCH=1` (set by CI and the
  session hook) also lets live tests create and drop a uniquely named, marked `varia_scratch_…` database
  (`tests/explorer-live.test.ts`, for graph and temporal tables); without it those checks are skipped.
  Run live suites one at a time where you can. Runs that share one server tolerate each other's scratch objects and
  load: the Object Explorer walk skips every scratch database (`ScratchDatabase.IsScratchName`), the injection matrix
  leaves scratch-named server principals out of its inventory, the huge- and xml-value cancel checks bound the cancel
  by `LiveResultChecks.CancelBound` (twice a reference the run just measured, at least 5 s) and also require the
  cancelled script to leave rows unread (`LiveResultChecks.StoppedEarly`), which no load can fake, and those value timings
  are measured once more when they miss their bound (`LiveResultChecks.OnceMore`). A new live check that walks shared
  server state or times work against a fixed bound needs the same care.
- Microsoft Entra ID needs a tenant, so its live checks run only on request: `VARIA_TEST_ENTRA_SERVER`,
  `VARIA_TEST_ENTRA_SP_CLIENT_ID` and `VARIA_TEST_ENTRA_SP_SECRET` (a service principal with a user in the Azure SQL
  database `VARIA_TEST_ENTRA_DATABASE` names) run the Service Principal checks, and `VARIA_TEST_ENTRA_DEFAULT=1` adds Entra Default after `az login`. Never
  print the secret. Without them the offline checks cover Entra through a fake token source.
- SSIS: `VARIA_TEST_SQL_SCRATCH=1` also builds the fake SSIS catalog (`VariaScratch_…_ssis`, from
  `tests/fixtures/ssisdb/`); `VARIA_TEST_SSIS=1` adds the drift check of the real `SSISDB` and of the Integration Services
  catalog backup (restored as `VariaScratch_…_ssisref`) against `manifest.json`, which `VARIA_UPDATE_SSIS_MANIFEST=1`
  rewrites (then regenerate `schema.sql` with `npx vitest run tests/ssisdb-fixtures.test.ts -u`). These checks never
  create, alter or drop `SSISDB`; only the opt-in Create Catalog check (`VARIA_TEST_SSIS_CREATE=1`, PR S9a) may, on a
  server whose owner allows it. docs/integration-services.md records what is verified.
- Cloud sessions: the hook starts the `varia-sql` Docker container (SQL Server 2022, `sa`, localhost:1433) and exports
  those variables when it is ready. If Docker is unavailable, live checks are skipped rather than failing.
- Smoke tests set `VARIA_SMOKE_TEST=1` with an isolated user-data directory and write screenshots to `artifacts/`. Every
  `electron.launch` passes `chromiumSandbox` so Linux runs keep Chromium's sandbox (Playwright would add
  `--no-sandbox`); only root, as in cloud sessions, runs without it. Only in unpackaged smoke runs, main also honours
  `VARIA_TEST_BACKEND=<mode>` (runs `tests/fixtures/backend.mjs` under the absolute `VARIA_TEST_NODE`; `workbench` takes
  cues from `VARIA_TEST_BACKEND_DIR`), `VARIA_BACKEND_LIVENESS_MS`, `VARIA_TEST_SAFE_STORAGE=test` (a reversible test
  cipher), `globalThis.__variaTest` (kill, pid, state, states, synthesize, and the renderer hooks rendererLosses,
  holdNextRenderer and releaseHolders), the renderer's test mode (`window.__variaResults`, `window.__variaGrid`,
  `window.__variaRecovery.flush()`, which saves AutoRecover's copies at once, `window.__variaLive`, which opens views on
  the synthetic live source, stands in for a hidden window and mounts a `LiveGridPane` over one (`mountGrid`, `grid`,
  `sortGrid`, `saveGrid`, `unmountGrid`), and `window.__variaTestShellFault()`, which makes the
  workbench's next render throw), and passes the backend `VARIA_BACKEND_TEST_HOOKS` (synthetic results)
  and `VARIA_RESULT_BUDGET_BYTES`. Suites import `electron` and `expect` from `scripts/fixtures/smoke.mjs`: assertions
  wait 15 s on Windows, whose runners can take seconds to write a file, and closing the app logs main's file operations
  that took 500 ms or more.

## Architecture invariants

- The renderer is untrusted: context isolation, sandbox, no Node integration, CSP, blocked navigation and popups.
  It reaches the system only through `window.varia` (`src/preload/index.ts`); never expose generic IPC or shell APIs,
  and never disable the Chromium sandbox. Main verifies every IPC sender (`trusted()` in `src/main/index.ts`).
- A backend method must be added in all five places: `RpcMethods` in `src/shared/contracts.ts`, a strict zod schema in
  `requestSchemas` (`src/main/validation.ts`), a `methodPolicies` entry (`src/shared/ipc/methods.ts`), a preload method,
  and a `SqlService.DispatchAsync` case plus its `MethodNames` entry, with its record in `backend/Varia.Backend/Contracts.cs`.
  Unknown methods and unknown members are rejected on both sides; main refuses a backend whose HELLO lacks a method.
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
  (Stop); sign-in hosts and token resources the server names are allowlisted.
- Query rows stay in backend memory (never on disk) under the result budget. Main forwards DATA pages undecoded, as
  exact-size ArrayBuffers (`toExactArrayBuffer`); only the results worker decodes them (`decodePage`). Results-port
  messages from the renderer are validated with `portRequestSchema`, ownership, and the current generation.
- The grid renders cells only through `GridView` pools, and text only through `nodeValue` (`tests/grid-lint.test.ts`
  forbids HTML sinks under `grid/`, `results/`, `designer/` and `live/`); no React per row or cell, and frames stay
  O(visible cells).
  Live tables show through `LiveGrid` (`src/renderer/src/live/`), which swaps each revision into its `GridView`; a table's row
  tone column (catalogue `role: 'tone'`, its last) is hidden by the grid and left out of Copy and Save (`ResultJobs`).
- Copy and Save text is formatted only by `ResultTextWriter`; export paths come only from main's save dialog and never
  leave main except to the backend.
- Results are released on re-execute, tab close, Close Results and backend loss; jobs lease them.
- Periodic data (Activity Monitor, SSIS monitoring, Object Explorer status) flows only through the results port's
  `live.subscribe` and `live.update`: the backend schedules, the renderer never polls with timers, and at most one live
  EVENT per subscription is unacknowledged (`creditedEvents`; main counts it against the stream's credit). The results
  worker relays live events undecoded and grants an event's bytes back only once the page has applied it and called the
  stream's `ack` (`ResultClient.live`), never more than the stream's events took. Sources and
  probes live only in `src/shared/live/catalog.ts`; after changing it, regenerate `docs/live.md` and the backend's embedded
  `Live/live-catalog.json` with `npx vitest run tests/live-catalog.test.ts -u`. Writes are never probes. Test-only sources
  (`debug.synthetic`) pass only main's test schemas (unpackaged smoke runs) and a backend with its test hooks. Probe SQL is
  constant text per probe and band in `Live/LiveSql.cs` (its offline lint refuses metadata built-ins, temporary tables,
  writes, DDL, transactions, waits, dynamic SQL and TOP without ORDER BY); it runs on its scope's own pool (" - Activity
  Monitor" for server DMVs) with the scope's prologue (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW), under
  the live gates and a per-statement budget, and its failures are values that back off.
  Views open live data only through `LiveService` (`src/renderer/src/live/`), which pauses hidden views, ends dormant
  ones and follows Reconnect; badges and summaries read `LiveService.peek` and never subscribe by themselves. Charts draw
  only through `ChartView` (`live/ChartView.ts`): a canvas read from the probe's ring, at most one draw a frame and none
  while off screen or hidden, at most two vertices a pixel column, colors only from the theme (its `charts.*` keys and the surface the chart sits on,
  `chartSurfaces` in `src/shared/theme/charts.ts`) or, under forced colors, the system colors as the DOM resolves them. Object
  Explorer's status chips are `background` views (`ExplorerStatusService`, one per connected server and login, owned by
  the pane, sampling in master): at most 8 a window, in slots no other view wants, given up to views the user opens when
  the window's slots are taken or the backend refuses them `BUSY` on that server; they never reload the tree.
- UI result caches are 256 windows and 16 Mi units; the worker cache is 64 MiB.
- Bound every input and output: 4 MiB request and 16 MiB response bodies, 1M-character scripts, 256 pending requests
  per backend generation, a deadline per method (`methodPolicies`), credit for result streams (16 MiB per stream, 64 MiB
  per port), and explicit truncation of results and messages.
  New string inputs need max lengths in both zod and C#. A request is written to at most one backend generation and is
  never re-sent.
- Preferences are written atomically (`src/main/json-file.ts`) (`settings.json`, `appearance.json`, `connections.json`,
  `workspace-layouts.json`, `saved-passwords.json` (0600)); unreadable files are quarantined, never overwritten.
- Failures are values: IPC returns `{ ok: false, error }`, and the UI stays responsive.
- Commands and keybindings are declared only in `src/shared/commands/catalog.ts`. `KeybindingService`
  (`src/renderer/src/core/keybindings.ts`) is the only key listener and routes keys to an open menu first; main handles
  no keys (`tests/keyboard-lint.test.ts`). Electron roles are commands (`role`): native menus show the role, and custom
  menus and the palette run it through `varia:run-role`. Two-part chords that Varia owns are `bridge` keybindings,
  registered with Monaco from the catalogue by `registerEditorBridge`; Monaco dispatches them. After catalogue changes,
  regenerate `docs/commands.md` with `npx vitest run tests/commands-docs.test.ts -u`.
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
  main cannot tell which input chose Paste, so a page script can read it while the user types or clicks.
- Object Explorer structure lives only in `src/shared/explorer/catalog.ts` (folders, kinds, icons, filters, version
  gates, the kinds that carry live status chips, whose words are in `status.ts`); after changing it, regenerate `docs/object-explorer.md` and the backend's embedded
  `Explorer/explorer-catalog.json` with `npx vitest run tests/explorer-catalog.test.ts -u`. Explorer SQL is constant
  text per query, band and filter shape, with values as parameters and database names only through `QUOTENAME`; no
  metadata built-ins; `READ UNCOMMITTED` and `LOCK_TIMEOUT 5000` on the explorer pool. The offline `CatalogSql` lint
  renders and checks every variant.
- Script As verbs, titles, URN types and preflight ids live only in `src/shared/scripting/catalog.ts`, and scripting
  options only in `options.ts`; after changing them, regenerate `docs/scripting.md` and the backend's embedded
  `Scripting/scripting-catalog.json` with `npx vitest run tests/scripting-catalog.test.ts -u`. Scripting uses its own
  pool (`READ COMMITTED`, `LOCK_TIMEOUT 10000`, database context restored before pooling), runs SMO only through
  `ScriptPipeline` with a fresh `Server` per job and prefetch limited to one object's own children, applies
  `HeaderGuard` to every SMO script with headers, leaves out SMO's comments for unresolved references (they hold names
  unescaped) and refuses any other SMO comment batch a name breaks, caps output at 4,000,000 characters, never executes
  DDL, and never logs scripts, names or options.
- Object actions (Select Top 1000 Rows, Rename, Delete, Properties), their dialogs, pages and database options live only
  in `src/shared/actions/catalog.ts` and `database.ts`; after changing them, regenerate `docs/object-actions.md` and the
  backend's embedded `Actions/actions-catalog.json` with `npx vitest run tests/object-actions-catalog.test.ts -u`. DDL runs
  only in `ActionService`: on its own unpooled connection (the application name plus " - Object Actions", never retried),
  never the explorer or scripting pool; with statements only from constant templates in `ActionSql`, `Actions/DatabaseAlter`
  and `Designer/DesignerSql`, all checked by `ActionSql.LintExecutable` (its template form for `ActionSql`, its builder
  forms for the others), where names, the database a batch runs in included, go in as parameters through server-side
  `QUOTENAME`, numbers only through `CONVERT` of range-checked parameters, keywords only from the embedded catalogue, and
  collations only as `sys.fn_helpcollations()` names them (live checks prove the server builds what Script Action shows
  for hostile names, and that Database Properties' script equals SMO's capture of SSMS's sequence); after a preflight in
  the same connection; waiting for locks as SSMS does (`LOCK_TIMEOUT -1`), so every DDL path needs a Stop (the dialog's,
  or the status bar's for a rename), whose reply waits for SQL Server and lists the steps completed; and never logging
  names, SQL or values. Script never runs anything. Describe and script reads use `LOCK_TIMEOUT 10000`. The test-only dry
  run is an internal C# method, never a request field.
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
  `sys.sysprocesses` or `dm_tran_locks`, every TOP ordered; the offline lint renders and checks every variant. Filters run
  in backend memory over a sample (`ActivityFilter`), never in SQL. The session actions (`Activity/SessionActions.cs`)
  have the only exemptions: `activity.details` reads `dm_tran_locks` only on request, on the monitor's pool under the live
  gates; `activity.kill` runs on the object actions' unpooled, never-retried connection, one guarded batch per session that
  checks the session's identity (login time, host process id), refuses its own, system and this backend's pool sessions (of every connection, whatever its Application Name), and
  only then runs a dynamic KILL built on the server from an int parameter. Neither logs session ids, logins, hosts or SQL.
- SSIS Catalog semantics (code tables, `ssis.describe` views, `ssis.execute` verbs, error codes, features, limits) live only in
  `src/shared/ssis/catalog.ts`; its tree kinds and folders are Object Explorer's catalogue. After changing it, regenerate
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
  (SSISDB, or the checks' fake catalog), never a request field; there is no 32-bit runtime option anywhere. Never log
  names, values, SQL or messages.
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

## Testing expectations

- vitest: `tests/*.test.ts`, fixtures in `tests/fixtures/`.
- .NET: `backend/Varia.Backend.Tests/Program.cs`, a console program of `Check(condition, name)` calls. Offline checks come
  first; live checks follow and create only session-local temporary objects. They create databases (and logins) only
  when `VARIA_TEST_SQL_SCRATCH=1`; scratch objects are uniquely named, marked, and dropped in `finally`
  (`ScratchDatabase.cs` also sweeps stale `VariaScratch_` ones by name and age). `InjectionMatrix.cs` (scratch only)
  scripts objects named to break out of SMO's comments, strings, brackets and lines with every DDL verb and runs each
  script in a rolled-back transaction, which must change only what its verb implies; keep it when changing scripting.
- UI behaviour: `scripts/*-smoke.mjs` drive the real app through Playwright's Electron API. Suites and the Electron benches
  find surfaces by ARIA role and accessible name through `scripts/fixtures/ui.mjs`, the only place that names Varia's
  classes (for parts with no role); `tests/smoke-selectors.test.ts` enforces it, so markup changes update ui.mjs, keeping
  the roles and names stable.
- Performance: `tests/bench/*.bench.ts`, `scripts/ipc-bench.mjs` and `scripts/grid-bench.mjs` only measure; a new
  metric needs a `tests/bench/floors.json` entry (`tests/bench-floors.test.ts` checks both lists) and a row in
  docs/ipc.md. Floors must stay well below what slow shared CI runners measure.
- Every behaviour change or bug fix comes with a check that would have caught it.

## Conventions

- TypeScript: no semicolons, single quotes, 2-space indent, long lines. C#: 4-space indent, nullable enabled, warnings
  as errors. LF line endings (`.editorconfig`, `.gitattributes`). Comments explain why, sparingly.
- One `claude/<topic>` branch per PR, off `main` or, for a stacked PR, off the branch it builds on. Merge with merge
  commits (never squash or rebase), so stacked branches need no rebase; imperative commit subjects.
- CI (`.github/workflows/ci.yml`): the Linux job (live SQL Server service, sandboxed smoke tests under xvfb) and the
  Windows and macOS jobs run on every PR, drafts included (any base branch, so stacked PRs are tested), every push to
  main and manual runs; the repository is public, so their minutes cost nothing. macOS skips the smoke tests until they
  cover its window chrome. Once `npm run check` passes, the smoke suites and the benchmarks each run even when the other
  failed first, so one run reports both (`tests/ci-workflow.test.ts`). `sql-matrix.yml` (manual runs only) repeats the
  .NET checks against SQL Server 2017, 2019, 2022 and 2025.
- No license has been chosen; do not add one.

## Product direction (agreed with the owner)

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
