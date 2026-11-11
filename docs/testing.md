# Testing and test environment

The full detail behind CLAUDE.md's Environment and Testing sections. docs/ci.md holds CI's layout, measurements and
the rules that keep it lean.

## Commands in detail

- `npm ci`: install. Use `npm install <pkg>` only to change dependencies, and commit `package-lock.json`.
- `npm run dev`: Debug backend build, then electron-vite with renderer hot reload. Restart after C# changes.
- `npm run check`: typecheck, Release .NET checks, vitest, production build, as concurrent lanes (`scripts/check.mjs`, which
  prints each lane's seconds): every lane at once with 8 or more CPUs, otherwise (CI's runners) two chains side by side, so
  time-bounded tests are not starved (`VARIA_CHECK_CPUS=<n>` tries either; `VARIA_CHECK_SKIP=typecheck`, as CI's Windows and
  macOS jobs set, leaves out tsc, which Linux's job runs). A stopped check prints its running lanes' output. Run before every commit.
- `npm run test:smoke`: the Electron suites listed in package.json's `test:smoke`. Needs the Release backend and `out/`
  from `npm run check` (or just those, from `npm run build:smoke`). `node scripts/smoke-shards.mjs 2/2`: one CI shard.
  The fixture launches the hidden smoke window with `--disable-frame-rate-limit`: Chromium otherwise draws it at one
  frame a second, and every Playwright press waits for frames. Set `VARIA_SMOKE_PROFILE=<dir>` to save a Playwright trace
  of each launch there (it holds the environment, so never upload one from a run with secrets).
  Headless Linux: `xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke`.
- `npm run test:electron`: `check` followed by `test:smoke`.
- `npm run backend:test`: only the .NET checks. `dotnet run --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj
  --configuration Release -- --live-group 1/3`: one CI live group (no offline checks; needs `VARIA_TEST_SQL_SERVER`). `npx vitest run tests/<name>.test.ts`: one vitest file
  (`backend-sidecar.test.ts` starts the Release backend, so build it first with `npm run check` or `npm run backend:test`).
- `npm run bench` (node harness, Release backend), `npm run bench:e2e [-- --live]` and `npm run bench:grid [-- --live]`
  (Electron, need `out/`): the IPC and results grid benchmarks, not part of `check`. `node scripts/check-bench.mjs
  [--enforce]` compares them with `tests/bench/floors.json`; CI enforces floors on Linux only.

## Environment

- Node.js 24+ and the .NET 10 SDK (`global.json`, latest feature band). In cloud sessions `.claude/hooks/session-start.sh`
  installs both, runs `npm install`, builds the backend (Debug and Release; a failed build is reported, not fatal), and
  puts `/opt/node24/bin` on PATH. After clear or compact it only refreshes the exported variables.
- Live SQL checks run when `VARIA_TEST_SQL_SERVER` is set: SQL authentication with `VARIA_TEST_SQL_USER` and
  `VARIA_TEST_SQL_PASSWORD`, otherwise Windows authentication. The .NET suite then adds live checks to its offline ones;
  how many depends on the server version and authentication (Mixed Mode adds the low-privilege login checks, and
  `VARIA_TEST_SQL_SCRATCH=1` adds the Object Explorer, Script As and object action scratch-database checks, the last in
  their own `VariaScratch_…_act` database, and the script goldens in `tests/fixtures/scripting/`;
  `VARIA_UPDATE_SCRIPT_GOLDENS=1` rewrites the goldens whose manifest source is `varia`), and `connections-smoke.mjs`
  connects for real. Check counts are not recorded in docs: they change with almost every PR. Never print the password. `VARIA_TEST_SQL_SCRATCH=1` (set by CI and the
  session hook) also lets live tests create and drop a uniquely named, marked `varia_scratch_…` database
  (`tests/explorer-live.test.ts`, for graph and temporal tables); without it those checks are skipped.
  Run live suites one at a time where you can. Runs that share one server tolerate each other's scratch objects and
  load: the Object Explorer walk skips every scratch database (`ScratchDatabase.IsScratchName`), the injection matrix
  leaves scratch-named server principals out of its inventory, the huge- and xml-value cancel checks bound the cancel
  by `LiveResultChecks.CancelBound` (twice a reference the run just measured, at least 5 s) and also require the
  cancelled script to leave rows unread (`LiveResultChecks.StoppedEarly`), which no load can fake, and those value timings
  are measured once more when they miss their bound (`LiveResultChecks.OnceMore`). A new live check that walks shared
  server state or times work against a fixed bound needs the same care.
- SQL IntelliSense: after `npm run build:smoke`, `npm run test:language:live` runs the actual bundled SQL Tools Service
  against `VARIA_TEST_SQL_SERVER` and requires `VARIA_TEST_SQL_SCRATCH=1` for its two uniquely owned, marked databases.
  It validates scoped/qualified completion, hover after edits, diagnostics, metadata refresh, isolation and cleanup. `npm run test:language:ui` exercises the real Monaco
  widgets through the full application against the same server. Both use bundled discovery without a service-path
  override; SQL authentication uses the usual test user/password variables. `node scripts/language-diagnostics-smoke.mjs`
  checks actual red/yellow marker decorations, messages, navigation, stale-result suppression and split contexts using the
  fake backend; `--live` verifies real syntax and missing-column squiggles against `VARIA_TEST_SQL_SERVER`. See docs/language-services.md.
- Microsoft Entra ID needs a tenant, so its live checks run only on request: `VARIA_TEST_ENTRA_SERVER`,
  `VARIA_TEST_ENTRA_SP_CLIENT_ID` and `VARIA_TEST_ENTRA_SP_SECRET` (a service principal with a user in the Azure SQL
  database `VARIA_TEST_ENTRA_DATABASE` names) run the Service Principal checks, and `VARIA_TEST_ENTRA_DEFAULT=1` adds Entra Default after `az login`. Never
  print the secret. Without them the offline checks cover Entra through a fake token source.
- SSIS: `VARIA_TEST_SQL_SCRATCH=1` also builds the fake SSIS catalog (`VariaScratch_…_ssis`, from
  `tests/fixtures/ssisdb/`) and, where Integration Services is installed, runs Create Catalog's dry run (the catalog
  backup restored by Varia's own steps as `VariaScratch_…_ssiscc`, no server-level changes); `VARIA_TEST_SSIS=1` adds the drift check of the real `SSISDB` (and its tree probe, read only) and of the Integration Services
  catalog backup (restored as `VariaScratch_…_ssisref`) against `manifest.json`, which `VARIA_UPDATE_SSIS_MANIFEST=1`
  rewrites (then regenerate `schema.sql` with `npx vitest run tests/ssisdb-fixtures.test.ts -u`). These checks never
  create, alter or drop `SSISDB`; only the opt-in Create Catalog check (`VARIA_TEST_SSIS_CREATE=1`, PR S9a) creates and
  drops it, on a server whose owner allows it and only when the server has no `SSISDB`: it never drops a catalog it did
  not create. docs/integration-services.md records what is verified.
- Cloud sessions: the hook starts the `varia-sql` Docker container (SQL Server 2022, `sa`, localhost:1433) and exports
  those variables when it is ready. If Docker is unavailable, live checks are skipped rather than failing.
- Smoke tests set `VARIA_SMOKE_TEST=1` with an isolated user-data directory and write screenshots to `artifacts/`. Every
  `electron.launch` passes `chromiumSandbox` so Linux runs keep Chromium's sandbox (Playwright would add
  `--no-sandbox`); only root, as in cloud sessions, runs without it. Only in unpackaged smoke runs, main also honours
  `VARIA_TEST_BACKEND=<mode>` (runs `tests/fixtures/backend.mjs` under the absolute `VARIA_TEST_NODE`; `workbench` takes
  cues from `VARIA_TEST_BACKEND_DIR`), `VARIA_TEST_HOT_EXIT=0` (the smoke fixture's default: no hot exit, so close prompts stay; docs/hot-exit.md), `VARIA_BACKEND_LIVENESS_MS`, `VARIA_TEST_SAFE_STORAGE=test` (a reversible test
  cipher), `globalThis.__variaTest` (kill, pid, state, states, synthesize, and the renderer hooks rendererLosses,
  holdNextRenderer and releaseHolders), the renderer's test mode (`window.__variaResults`, `window.__variaGrid`,
  `window.__variaRecovery.flush()`, which saves AutoRecover's copies at once, `window.__variaLive`, which opens views on
  the synthetic live source, stands in for a hidden window and mounts a `LiveGridPane` over one (`mountGrid`, `grid`,
  `sortGrid`, `saveGrid`, `unmountGrid`), and `window.__variaTestShellFault()`, which makes the
  workbench's next render throw), and passes the backend `VARIA_BACKEND_TEST_HOOKS` (synthetic results)
  and `VARIA_RESULT_BUDGET_BYTES`. Suites import `electron` and `expect` from `scripts/fixtures/smoke.mjs`: assertions
  wait 15 s on Windows, whose runners can take seconds to write a file, and closing the app logs main's file operations
  that took 500 ms or more. A close that has not finished in 45 s kills the app and fails the suite without hiding its own
  error (`boundedClose`; on Linux it first names the processes still in the app's process group, since Playwright's close waits
  for pipes the backend and its language server inherit), and `smoke-shards.mjs` kills a suite past four times its weight (at least 5 min), so one hang
  cannot run its shard to the job's timeout.


## Testing expectations

- vitest: `tests/*.test.ts`, fixtures in `tests/fixtures/`.
- .NET: `backend/Varia.Backend.Tests/Program.cs`, a console program of `Check(condition, name)` calls. Offline checks come
  first, their suites in concurrent lanes (`OfflineSuites.cs`: six by default, `VARIA_TEST_OFFLINE_LANES=<n>`; one when
  `VARIA_TEST_SLOW_MS` is set; a suite still running after 3 minutes is named and the run exits,
  `VARIA_TEST_OFFLINE_SUITE_MS=<ms>` to change that): a new offline suite goes in Program.cs's `offlineSuites` list, with its measured seconds in
  `OfflineSuites.Weights` if over 0.3 s, and runs in `OfflineSuites.Alone` if it changes process-wide state (the console,
  environment variables, a static override, GC measurements); live checks follow and create only session-local temporary objects. They create databases (and logins) only
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
- Keep CI fast: docs/ci.md holds the measurements, the plan and the rules (queueing for the 20 shared runners sets most of a
  run's wall time, so a job removed beats a step trimmed); measure with `node scripts/ci-timings.mjs`. Race a close or exit only
  through `within()` (`tests/idle-waits.test.ts`), settle tests without `setTimeout` loops, fail offline connections with
  `Unreachable.Source`, and find .NET waits with `VARIA_TEST_SLOW_MS=500`. Each smoke shard and live group has a time budget (`shardBudgetSeconds` in `scripts/smoke-shards.mjs`,
  `LiveGroups.BudgetSeconds`, both 360 s); exceeding it fails `tests/ci-workflow.test.ts` or the offline .NET checks.
  A bound on a wait that returns as soon as its condition holds costs nothing when it passes: make it generous (CI's 3 and
  4 vCPU runners stall for seconds), and keep tight bounds for what the check means to time. Two timers that race (a budget
  that must outlast a delay or a second call) need about a second between them. A CancellationTokenSource timer cancels from the thread pool, so a Stop that must land before CPU-bound work ends comes from a dedicated thread. Before pushing an offline .NET timing check,
  run `node scripts/offline-stress.mjs` (five copies of the offline checks pinned to three CPUs, as starved as CI's).
  Checks never depend on the machine's memory load: build a `ResultStore` without a memory probe (or pass a fake one), and
  give a sidecar with the test hooks `VARIA_RESULT_BUDGET_BYTES`, which turns the load check off; parallel lanes push a
  developer machine past the 90 % high-load threshold, where the real probe truncates every result.
  A new smoke suite needs its seconds on Linux and Windows in `suiteSeconds`, and a new live .NET suite runs through
  `Suite(...)` in `Program.cs` with an entry in `LiveGroups.Suites`. Copy times from CI's logs: each shard's summary and
  each `Live suite name: n s` line. Before you add a smoke suite, check whether an existing suite's launch can take the
  checks: each Electron launch costs seconds. Split any suite over about 90 s. Wait on conditions, never fixed sleeps or
  `WAITFOR` delays longer than the behaviour needs. Put report-only measurements in the benchmarks, not the checks. A
  live vitest file is named `*-live.test.ts`, so CI's live job runs it.

