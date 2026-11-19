# Testing and test environment

The detail behind CLAUDE.md's Environment and Testing sections. docs/ci.md holds CI's layout, measurements and lean-CI
rules.

## Commands in detail

- `npm run check` (`scripts/check.mjs`) prints each lane's seconds. Every lane runs at once with 8 or more CPUs,
  otherwise (CI's runners) two chains side by side so time-bounded tests are not starved; `VARIA_CHECK_CPUS=<n>` tries
  either. `VARIA_CHECK_SKIP=typecheck` (CI's Windows and macOS jobs) leaves out tsc. Off CI it first takes the machine
  lock (below). A stopped check prints its running lanes' output.
- `npm run test:smoke` runs the suites in package.json's `test:smoke`; `node scripts/smoke-shards.mjs 2/3` runs one CI
  shard. The fixture launches the hidden smoke window with `--disable-frame-rate-limit` (Chromium otherwise draws it at
  one frame a second, and every Playwright press waits for frames). `VARIA_SMOKE_PROFILE=<dir>` saves a Playwright trace
  of each launch there; it holds the environment, so never upload one from a run with secrets.
- `npm run test:smoke:wsl -- <suite>...` runs smoke suites on Linux from a Windows checkout, through WSL (below). Run
  it for a change that can behave differently on Linux (window state, menus, clipboard, file paths) before pushing.
- `dotnet run --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release -- --live-group 1/3`
  runs one CI live group (no offline checks; needs `VARIA_TEST_SQL_SERVER`); `-- --live-suite <Name>` runs one live
  suite (names in `LiveGroups.Suites`). `backend-sidecar.test.ts` and `*-live.test.ts` start the
  Release backend: build it first with `npm run check` or `npm run backend:test`.
- Benchmarks, not part of `check`: `npm run bench` (node harness, Release backend), `npm run bench:e2e [-- --live]`,
  `npm run bench:grid [-- --live]` and `npm run bench:startup` (Electron, need `out/`). `node scripts/check-bench.mjs
  [--enforce]` compares them with `tests/bench/floors.json`; CI enforces floors on Linux only.
- By-hand benchmarks that enforce nothing, each a flag after `--` on the tests project above:
  - `--pivot-bench` (backend, stage by stage) and `node scripts/pivot-bench.mjs` (the built app against
    `VARIA_TEST_SQL_SERVER`); docs/pivot-performance-findings.md.
  - `--page-compression-bench <GiB> <shape>`, one size and shape a process; docs/page-compression-findings.md.
  - `--fairness-bench [--rows N] [--runs N]`: a sort, a pivot and a profile alone and in pairs, to see how they share the
    worker threads; docs/ipc.md's "Worker threads measured".
  - `--result-work-bench [--rows N] [--runs N] [--only name,name]`: a pivot's Distinct Count, Compare Results and a
    column's distinct values past the coded limit, stage by stage, on synthetic results (4,000,000 rows by default).
  - Prefix `DOTNET_PROCESSOR_COUNT=n` to simulate a machine with fewer cores.

## Parallel sessions and the machine lock

Several agent sessions (Claude, Codex) or a developer often work in separate worktrees on one machine. Heavy runs at
once overloaded it: time-bounded tests missed deadlines, benchmarks measured each other, smoke suites overwrote each
other's clipboard.

**Run only what applies while developing:** the vitest files, .NET suite and smoke suite that cover the change
(`npx vitest run tests/<name>.test.ts`; `node scripts/<area>-smoke.mjs` after `npm run build:smoke`). Run
`npm run check` once before committing, the whole `test:smoke` only when a change reaches across the UI, and the
benchmarks only when a change can move them. CI runs everything on every PR.

**The machine lock** (`scripts/machine-lock.mjs`) queues heavy runs across every worktree and clone on the machine:

| Tier | Taken by | Runs |
| --- | --- | --- |
| shared | `npm run check`, `npm run build:smoke`, `npm run backend:test` | up to `VARIA_LOCK_SHARED` at once (default 2) |
| exclusive | every smoke suite and Electron benchmark (through `scripts/fixtures/smoke.mjs`), `npm run bench` | alone |

- A waiting run prints `Waiting for the machine lock (<tier>) for <run>, held by <run> (pid, worktree, since)`, a line a
  minute, then `Took the machine lock`. **Leave it running**: it continues when the holder finishes, and stopping it
  only loses its place. Agents run long commands in the background so a tool timeout does not kill a waiting run.
- A waiting exclusive run goes ahead of shared runs that arrive after it, then waits for the shared runs already going.
  Each smoke suite takes the lock as it starts, so another session's check can run between two suites of `test:smoke`.
- The shard runner takes each suite's lock before spawning it and starting its watchdog, so waiting does not spend the
  suite's budget. Interrupting a queued suite releases only its own reservation and launches nothing; a running suite
  keeps the whole-process-tree cleanup.
- Each check plans for its share of the machine: the CPUs divided among the shared slots (12 of 24 by default), which
  picks its lane layout and caps each vitest lane's workers (`vitestWorkers` in `scripts/check.mjs`), so two checks fill
  the machine without oversubscribing it. `VARIA_CHECK_CPUS` and `VITEST_MAX_WORKERS` override it.
- A run started with `node scripts/machine-lock.mjs` holds the lock under the wrapper's process: kill the whole process
  tree, not only the wrapper, or the command keeps running after the lock is cleared.
- The lock is files in `<os temp>/varia-machine-lock` (`VARIA_LOCK_DIR` moves it), each naming its holder and touched
  every few seconds. A file whose process has gone or that nobody touched for a while is cleared, so a crash never blocks
  the next run; nothing needs deleting by hand.
- CI (`CI=true`) skips the lock; `VARIA_LOCK=off` skips it locally. A process started under a holder (`VARIA_LOCK_HELD`,
  set by the holder) never waits, so the check's own vitest cannot wait on it.
- `node scripts/machine-lock.mjs shared|exclusive <executable> [args...]` runs any other command under the lock.
- `npm run test:smoke:wsl` takes the Windows lock for its WSL work (shared for the build, exclusive for the suites) and
  tells the Linux side it holds it, since WSL's `/tmp` lock does not span the Windows sessions.

## Linux smoke through WSL

`scripts/smoke-wsl.mjs` (Linux half: `scripts/smoke-wsl.sh`) runs smoke suites under `xvfb-run` in WSL2, so a Linux-only
failure turns up before a push instead of in CI's `smoke-linux` jobs.

```bash
npm run test:smoke:wsl -- --setup
npm run test:smoke:wsl -- options menus
npm run test:smoke:wsl -- --all
```

- `--setup`, once per machine: installs Node 24 and the .NET SDK pinned by `global.json` under `~/.varia-wsl` inside WSL
  (Node's checksum is verified). It names any missing apt packages (`xvfb`, `libgssapi-krb5-2`), which need `sudo apt-get
  install` by hand.
- Each run snapshots HEAD plus uncommitted and untracked, unignored files as an unreferenced commit (through a temporary
  index; the worktree, index and stash are untouched; `--committed` takes HEAD alone), fetches it into one clone on the
  Linux filesystem (`~/.varia-wsl/clone`, never `/mnt/c`), runs `npm ci` only when `package-lock.json` changed, then
  `npm run build:smoke`, then each suite, all of them even after one fails. It exits non-zero if any failed.
- Suites are named as `options`, `options-smoke` or `scripts/options-smoke.mjs`. `--no-build` reruns the suites on the
  last build; `--distro <name>` (or `VARIA_WSL_DISTRO`) picks a distro other than WSL's default.
- Every worktree shares the clone, so runs queue on a lock of their own (`wsl-clone` in the lock directory) before taking
  the machine lock.
- `VARIA_TEST_*` and `VARIA_SMOKE_*` variables pass into WSL by name through `WSLENV`; their values are never printed.
  Under WSL2's default NAT networking `localhost` is the Linux VM, so point `VARIA_TEST_SQL_SERVER` at the Windows
  host's address, or enable mirrored networking, for the suites that need SQL Server.
- `VARIA_WSL_HOME` and `VARIA_WSL_CLONE` move the toolchain and the clone.

## Environment

- **Cloud sessions.** `.claude/hooks/session-start.sh` installs Node 24 and, when `dotnet --list-sdks` shows no 11.0 SDK, `dotnet-sdk-11.0` from
  apt (`tests/session-start-hook.test.ts` keeps the check, the package and `global.json` on one band), runs `npm install`, builds the backend (Debug and Release; a failed build is reported, not fatal), puts
  `/opt/node24/bin` on PATH, and starts the `varia-sql` Docker container (SQL Server 2022, `sa`, localhost:1433),
  exporting the SQL variables once it is ready. After clear or compact it skips `npm install` and the builds; it still ensures the SQL container, the SDK and Node. Without
  Docker, live checks are skipped rather than failing.
- **Live SQL.** `VARIA_TEST_SQL_SERVER` turns on the live .NET checks and real connections in `connections-smoke.mjs`:
  SQL authentication with `VARIA_TEST_SQL_USER`/`VARIA_TEST_SQL_PASSWORD`, otherwise Windows authentication. Which checks
  run depends on server version and authentication (Mixed Mode adds the low-privilege login checks). Never print the
  password, and never record check counts in docs.
- **Kerberos.** `VARIA_TEST_KERBEROS_NO_TICKET=1` (with `VARIA_TEST_SQL_SERVER`, Linux or macOS only; CI's Linux job sets
  `KRB5CCNAME` to a cache that does not exist) runs `tests/kerberos-live.test.ts`: Integrated authentication without a
  ticket must fail cleanly. A real Kerberos round trip needs a KDC and a domain-joined SQL Server, so it is a manual
  check: `kinit`, then connect with Windows authentication to a server name or SPN registered for Kerberos.
- **BigQuery.** `VARIA_TEST_BIGQUERY_ENDPOINT` (a loopback http address such as `http://localhost:9050`, honoured only by
  unpackaged builds) puts the backend in emulator mode against `ghcr.io/goccy/bigquery-emulator`, and
  `-- --bigquery-emulator-live` runs the emulator checks (docs/bigquery.md#testing has the `docker run` line; on Windows use
  `127.0.0.1`). The offline checks need nothing: `-- --bigquery-checks` runs them alone. No check ever contacts a real
  Google Cloud project, and none reads a project id or credential from the environment.
- **Password tracing.** `VARIA_TEST_SQL_XE=1` (set only for CI's disposable SQL Server container) runs the live check that an
  Extended Events session cannot read a password from the RPC; docs/object-actions.md has what it records.
- **Restore fixtures.** `VARIA_UPDATE_RESTORE_FIXTURES=1` makes `RestoreLiveChecks` rewrite the scrubbed restore-planner
  fixtures from the live server's backup history.
- **Scratch.** `VARIA_TEST_SQL_SCRATCH=1` (set by CI and the session hook) adds the Object Explorer, Script As and object
  action scratch-database checks (actions in their own `VariaScratch_…_act`), the script goldens in
  `tests/fixtures/scripting/`, and lets live vitest files create and drop a uniquely named, marked `varia_scratch_…`
  database (`tests/explorer-live.test.ts`, for graph and temporal tables); without it those are skipped.
- **Rewriting fixtures.** `VARIA_UPDATE_SCRIPT_GOLDENS=1` rewrites the goldens whose manifest source is `varia`;
  `VARIA_UPDATE_ORDINAL_CASING=1` (offline) rewrites `src/shared/ordinal-casing.ts` from the runtime's casing.
- **Shared servers.** Run live suites one at a time where you can. Runs sharing a server tolerate each other's scratch
  objects and load: the Object Explorer walk skips scratch databases (`ScratchDatabase.IsScratchName`), the injection
  matrix leaves scratch-named server principals out of its inventory, and the huge- and xml-value cancel checks bound the
  cancel by `LiveResultChecks.CancelBound` (twice a reference the run just measured, at least 5 s), require the cancelled
  script to leave rows unread (`LiveResultChecks.StoppedEarly`), and measure once more when they miss
  (`LiveResultChecks.OnceMore`). A new live check that walks shared server state or times work against a fixed bound
  needs the same care.
- **SQL IntelliSense.** After `npm run build:smoke`, `npm run test:language:live` runs the bundled SQL Tools Service
  against `VARIA_TEST_SQL_SERVER` (requires `VARIA_TEST_SQL_SCRATCH=1` for its two marked databases): scoped and
  qualified completion, hover after edits, diagnostics, metadata refresh, isolation and cleanup. `npm run
  test:language:ui` drives the real Monaco widgets through the app against the same server. Both use bundled discovery
  without a service-path override. `node scripts/language-diagnostics-smoke.mjs` checks marker decorations, messages,
  navigation, stale-result suppression and split contexts on the fake backend; `--live` checks real squiggles against
  `VARIA_TEST_SQL_SERVER`. See docs/language-services.md.
- **Microsoft Entra ID** checks run only on request: `VARIA_TEST_ENTRA_SERVER`, `VARIA_TEST_ENTRA_SP_CLIENT_ID` and
  `VARIA_TEST_ENTRA_SP_SECRET` (a service principal with a user in the Azure SQL database `VARIA_TEST_ENTRA_DATABASE`
  names) run the Service Principal checks; `VARIA_TEST_ENTRA_DEFAULT=1` adds Entra Default after `az login`. Never print
  the secret. Offline checks cover Entra through a fake token source.
- **SSIS.** `VARIA_TEST_SQL_SCRATCH=1` also builds the fake SSIS catalog (`VariaScratch_…_ssis`, from
  `tests/fixtures/ssisdb/`) and, where Integration Services is installed, runs Create Catalog's dry run (the catalog
  backup restored by Varia's own steps as `VariaScratch_…_ssiscc`, no server-level changes). `VARIA_TEST_SSIS=1` adds the
  drift check of the real `SSISDB` (and its read-only tree probe) and of the Integration Services catalog backup
  (restored as `VariaScratch_…_ssisref`) against `manifest.json`, which `VARIA_UPDATE_SSIS_MANIFEST=1` rewrites (then
  regenerate `schema.sql` with `npx vitest run tests/ssisdb-fixtures.test.ts -u`). These never create, alter or drop
  `SSISDB`; only the opt-in `VARIA_TEST_SSIS_CREATE=1` creates and drops it, on a server whose owner allows it and only
  when it has no `SSISDB`: it never drops a catalog it did not create. docs/integration-services.md records what is
  verified.
- **Smoke hooks.** Smoke tests set `VARIA_SMOKE_TEST=1` with an isolated user-data directory (`VARIA_TEST_USER_DATA`) and write screenshots to
  `artifacts/`. Every `electron.launch` passes `chromiumSandbox` so Linux keeps Chromium's sandbox (only root, as in cloud
  sessions, runs without it). `VARIA_SMOKE_MENU_STYLE=native|custom` picks the context-menu style (so the native path runs
  on Linux too). `scripts/packaged-smoke.mjs` and `portable-smoke.mjs` take the built app from `VARIA_PACKAGED_EXECUTABLE`
  (with `VARIA_PACKAGED_PROFILE`) and `VARIA_PORTABLE_EXECUTABLE`. Only in unpackaged smoke runs main also honours:
  - `VARIA_TEST_BACKEND=<mode>` (runs `tests/fixtures/backend.mjs` under the absolute `VARIA_TEST_NODE`; `workbench`
    takes cues from `VARIA_TEST_BACKEND_DIR`), `VARIA_TEST_HOT_EXIT=0` (the fixture's default: no hot exit, so close
    prompts stay; docs/hot-exit.md), `VARIA_TEST_FOLLOW_SYSTEM_MOTION=1` (the fixture's default unless a launch passes
    `motion: true`: the renderer reduces motion whenever the emulated `prefers-reduced-motion` asks, without the
    Reduce motion when the system asks setting), `VARIA_TEST_WINDOW_STATE=1` (the main window keeps its place between
    launches, and main sets `globalThis.__variaWindowPlacement`; docs/popout-windows.md), `VARIA_BACKEND_LIVENESS_MS`, `VARIA_TEST_SAFE_STORAGE=test` (a reversible test
    cipher);
  - `globalThis.__variaTest` (kill, pid, state, states, synthesize, and the renderer hooks rendererLosses,
    holdNextRenderer and releaseHolders);
  - the renderer's test mode: `window.__variaResults`, `window.__variaGrid`, `window.__variaRecovery.flush()` (saves
    AutoRecover's copies at once), `window.__variaLive` (opens views on the synthetic live source, stands in for a hidden
    window, mounts a `LiveGridPane` with `mountGrid`, `grid`, `sortGrid`, `saveGrid`, `unmountGrid`) and
    `window.__variaTestShellFault()` (the workbench's next render throws), `window.__variaTestExplorerFault()`,
    `window.__variaServerFiles`, `window.__variaRestore`, `window.__variaFailures` and `window.__variaMotion.refresh()`
    (re-reads the reduced-motion preference; the fixture calls it after each `emulateMedia`);
  - and passes the backend `VARIA_BACKEND_TEST_HOOKS` (synthetic results) and `VARIA_RESULT_BUDGET_BYTES`.
- **Smoke fixture.** Suites import `electron` and `expect` from `scripts/fixtures/smoke.mjs`: assertions wait 15 s on
  Windows (its runners can take seconds to write a file), and closing the app logs main's file operations of 500 ms or
  more. `boundedClose` and the shard watchdog (docs/ci.md) keep one hang from running its shard to the job's timeout.

## Testing expectations

- Every behaviour change or bug fix comes with a check that would have caught it.
- **vitest:** `tests/*.test.ts`, fixtures in `tests/fixtures/`. A live vitest file is named `*-live.test.ts`, so CI's live
  job runs it.
- **.NET:** `backend/Varia.Backend.Tests/Program.cs`, a console program of `Check(condition, name)` calls.
  - Offline checks come first, in concurrent lanes (`OfflineSuites.cs`: six by default, `VARIA_TEST_OFFLINE_LANES=<n>`;
    one when `VARIA_TEST_SLOW_MS` is set; a suite still running after 3 minutes is named and the run exits,
    `VARIA_TEST_OFFLINE_SUITE_MS=<ms>` changes that). A new offline suite goes in Program.cs's `offlineSuites`, with its
    measured seconds in `OfflineSuites.Weights` if over 0.3 s, and in `OfflineSuites.Alone` if it changes or measures
    process-wide state (console, environment variables, a static override, GC measurements, lock contention counts).
  - The result suites (`packedPass`) run a second time with `ResultStore.DefaultPacking` = `EveryComplete`, so every
    reader meets packed pages through the accessor. A new result suite joins `packedPass` unless it sets each store's
    packing itself (`FusedReadChecks` and its `FusedWhole` suite). In those checks: compare budget figures with
    `Held.Bytes` (without the unpacked-page cache) and `StoredPage.StoredLength`; size a budget by `Held.AsSealed`; add
    `Held.Rooms` (an upper bound) when leaving just enough room for a fused reader (sort, filter, profile, pivot, distinct
    list, row identity, diff, search); and give the store `Packing = PagePacking.Off` when the check is not about pages
    (GC measurements, a stop's figure) or needs an exact margin (a thread-count retry).
  - The checks run with `ResultSetBuffer.RequirePins`, so a page read without a pin or lease fails.
  - Live checks follow and create only session-local temporary objects; databases and logins only with
    `VARIA_TEST_SQL_SCRATCH=1`, uniquely named, marked and dropped in `finally` (`ScratchDatabase.cs` also sweeps stale
    `VariaScratch_` ones by name and age). A new live suite runs through `Suite(...)` with an entry in `LiveGroups.Suites`.
  - `InjectionMatrix.cs` (scratch only) scripts objects named to break out of SMO's comments, strings, brackets and lines
    with every DDL verb and runs each script in a rolled-back transaction, which must change only what its verb implies;
    keep it when changing scripting.
- **UI:** `scripts/*-smoke.mjs` drive the real app through Playwright's Electron API. Suites and the Electron benches find
  surfaces by ARIA role and accessible name through `scripts/fixtures/ui.mjs`, the only place that names Varia's classes
  (for parts with no role; `tests/smoke-selectors.test.ts`), so markup changes update ui.mjs and keep roles and names
  stable. The connections suite's `scripts/fixtures/connection-lifecycle.mjs` drives main's real request and credential
  owners against an isolated fake backend and test cipher, with sample secrets that are never real credentials.
- **Performance:** `tests/bench/*.bench.ts`, `scripts/ipc-bench.mjs`, `scripts/grid-bench.mjs` and
  `scripts/startup-bench.mjs` only measure. A new metric needs a `tests/bench/floors.json` entry
  (`tests/bench-floors.test.ts` checks both lists) and a row in docs/ipc.md. Floors stay well below what slow shared CI
  runners measure. Put report-only measurements in the benchmarks, not the checks.
- **Keep CI fast.** docs/ci.md's "Rules for keeping CI lean" holds the timer, race, stress and budget rules
  (`within()`, no `setTimeout` loops, `Unreachable.Source`, `VARIA_TEST_SLOW_MS=500`, `node scripts/offline-stress.mjs`
  before pushing an offline timing check, about a second between racing timers). Beyond those:
  - Each smoke shard and live group has a 360 s budget (`shardBudgetSeconds` in `scripts/smoke-shards.mjs`,
    `LiveGroups.BudgetSeconds`); exceeding it fails `tests/ci-workflow.test.ts` or the offline .NET checks. Before adding
    a smoke suite, check whether an existing launch can take the checks; split any suite over about 90 s.
  - Make a bound on a wait that returns as soon as its condition holds generous, and keep tight bounds for what the check
    means to time. Never use fixed sleeps or `WAITFOR` delays longer than the behaviour needs.
  - Wait for file-bound background work (a vault or library write that outlives its caller) by awaiting the promise its
    owner exposes, such as `whenCancelledWorkDrained()` or the updater's `whenSwept()`, never by polling a flag under `vi.waitFor`.
  - `GC.GetAllocatedBytesForCurrentThread` can read up to one allocation quantum (about 8 KB) high while other suites'
    threads allocate, never low: an allocation bound takes the least of several runs (`IdentityChecks.LeastAllocated`), and
    a zero-allocation window is retried on a fresh thread before it fails.
  - Smoke suites and fixtures read a JSON-lines log (`calls.jsonl`) only through `parseCalls`/`completeLines`
    (`scripts/fixtures/call-log.mjs`): the fake backend appends asynchronously, so the last line can be half written.
  - Checks never depend on the machine's memory load: build a `ResultStore` without a memory probe (or with a fake), and
    give a sidecar with test hooks `VARIA_RESULT_BUDGET_BYTES`, which turns the load check off; parallel lanes push a
    developer machine past the 90 % high-load threshold, where the real probe truncates every result.
