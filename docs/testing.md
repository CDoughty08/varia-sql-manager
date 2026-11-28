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
  one frame a second, and every Playwright press waits for frames). Every Electron launch under xvfb that opens a
  window adds `--disable-gpu` through `xvfbArgs` (`scripts/fixtures/xvfb.mjs` says why). `VARIA_SMOKE_PROFILE=<dir>`
  saves a Playwright trace of each launch there; it holds the environment, so never upload one from a run with secrets.
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
  A newly created lock file whose metadata is still being written shows as `held by a starting run` briefly before
  naming the holder. If a restricted sandbox or permission error persistently blocks accessing a lock file, the lock
  fails with `Could not access machine lock file ...` instead of waiting forever; run outside the sandbox or set
  `VARIA_LOCK=off`.
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
  `127.0.0.1`). `VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT` (the emulator's gRPC port, such as `http://localhost:9060`, read only
  by the backend and only with the emulator endpoint) adds the Storage Read checks. The offline checks need nothing:
  `-- --bigquery-checks` runs them alone, and `-- --bigquery-read-bench` is the hand-run read throughput benchmark. No
  check in `npm run check`, a live group or a smoke suite contacts a real Google Cloud project, and none of them reads a
  project id or credential from the environment; only the opt-in group below does.
- **Real BigQuery project (opt-in, billed).** `-- --bigquery-real-project` (`BigQueryRealProjectChecks`) answers what only
  Google can, following the open real-project checklist (R1 to R21; each check prints its id). It is run by hand by the
  owner, never in CI (it refuses when `CI` is set) and never with `VARIA_TEST_BIGQUERY_ENDPOINT`. It needs
  `VARIA_TEST_BIGQUERY_PROJECT` and `VARIA_TEST_BIGQUERY_CONFIRM` set to the same project id, which stays out of the
  repository, and ADC (`gcloud auth application-default login`) or `VARIA_TEST_BIGQUERY_KEY_FILE` (a service account key).
  `VARIA_TEST_BIGQUERY_TIER` picks how far it goes, each tier including the ones before it:
  - `free` (the default): no job. The connect probe and identity pin (R2), Varia's dry-run estimate, All users'
    `jobs.list` fields and a page token reused with a smaller page (R1), `tables.get` with `fields` and with
    `selectedFields` (R5), and dry runs of `INFORMATION_SCHEMA` (R8), a value-list filter (R9) and a parameterised
    `TABLESAMPLE` (R10).
  - `zero`: jobs that read no table and bill nothing. JSON-number job fields and the 409 body (R11), the REST shape of
    RANGE, DATETIME and TIME (R12), and a session: a dry run with its id (R7), a failure inside its transaction, its
    children's minimal projection and `CALL BQ.ABORT_SESSION` with a STRING parameter (R13).
  - `billed`: jobs that scan a small public table, 10 MiB minimum each, about 100 MiB in all. A query's bytes billed
    and a script's cap per statement or per script (R15), `TABLESAMPLE` over the run's own anonymous result table (R17),
    Show CREATE Statement's estimate against its bill (R18), a DML script's children (R20) and Varia's tab session keeping
    its temp table (dry-run with the session id its first job reported).

  The rest it prints as by hand: Google's error bodies (R3), impersonation and federation (R4), a UDAF's type (R6), a busy
  or 24-hour-idle session (R13, R14), Storage Read billing (R16), the bulk index's rows (R19). Fixtures change only by hand
  from what a run printed (R21). The spending guard (`BigQueryRealProjectChecks.Budget`, held offline by the
  `BigQueryRealProjectGuard` suite):
  - every job is dry-run first, and one estimated over 100 MiB, incomplete or faked is skipped; a script runs only once
    each statement that reads a table was admitted on its own;
  - the run stops before its estimates (each at least BigQuery's 10 MiB minimum, `INFORMATION_SCHEMA` included) or its
    bytes billed pass 1 GiB in total, so it can pass 1 GiB by at most one job's cap;
  - queries read only the small public tables in `PublicTables` (`bigquery-public-data.samples.shakespeare`), the
    public dataset's `INFORMATION_SCHEMA.TABLES`, the run's own result tables and, for the checks that make them, its
    own temp tables, checked in the text and in the dry run's referenced tables;
  - the connection and every query job carry `maximumBytesBilled` of at most 100 MiB, and after each step the run lists
    the jobs it created (and Varia's jobs in its sessions, never another tool's or window's) and fails if one carried no cap within 100 MiB or billed past it (a script: its cap for each statement, within 100 MiB), or was never counted; each job is counted before the next is admitted, and one still running after its wait stops the run; it prints
    each job's bytes billed and the total. Varia's own `CALL BQ.ABORT_SESSION` job carries the 10 MiB session-job cap but
    runs outside the session and bills nothing, so the run does not count it or check its cap. A comment unique to the run keeps the query cache from answering a rerun.

  Before the first run, set a custom "Query usage per day" quota of 10–50 GiB on the project and a budget alert (a
  lowered quota takes minutes to apply; a budget only alerts). Neither limits Storage Read bytes, so the group reads no
  result through Storage Read.
- **Password tracing.** `VARIA_TEST_SQL_XE=1` (set only for CI's disposable SQL Server container) runs the live check that an
  Extended Events session cannot read a password from the RPC; docs/object-actions.md has what it records.
- **Restore fixtures.** `VARIA_UPDATE_RESTORE_FIXTURES=1` makes `RestoreLiveChecks` rewrite the scrubbed restore-planner
  fixtures from the live server's backup history.
- **Scratch.** `VARIA_TEST_SQL_SCRATCH=1` (set by CI and the session hook) adds the Object Explorer, Script As and object
  action scratch-database checks (actions in their own `VariaScratch_…_act`), the script goldens in
  `tests/fixtures/scripting/`, and lets live vitest files create and drop a uniquely named, marked `varia_scratch_…`
  database (`tests/explorer-live.test.ts`, for graph and temporal tables); without it those are skipped. With it, `VARIA_TEST_SEARCH_RELOAD_ONLY=1` makes
  `--live-suite Explorer` run only the Search Objects reload and freshness checks (`SearchReloadLiveChecks`,
  `SearchFreshnessLiveChecks`), on their own scratch databases.
- **Rewriting fixtures.** `VARIA_UPDATE_SCRIPT_GOLDENS=1` rewrites the goldens whose manifest source is `varia`;
  `VARIA_UPDATE_ORDINAL_CASING=1` (offline) rewrites `src/shared/ordinal-casing.ts` from the runtime's casing.
- **Shared servers.** Run live suites one at a time where you can. Runs sharing a server tolerate each other's scratch
  objects and load: the Object Explorer walk skips scratch databases (`ScratchDatabase.IsScratchName`), the injection
  matrix leaves scratch-named server principals out of its inventory, and the huge- and xml-value cancel checks bound the
  cancel by `LiveResultChecks.CancelBound` (twice a reference the run just measured, at least 5 s), require the cancelled
  script to leave rows unread (`LiveResultChecks.StoppedEarly`), and measure once more when they miss
  (`LiveResultChecks.OnceMore`). A new live check that walks shared server state or times work against a fixed bound
  needs the same care.
- **SQL IntelliSense.** After `npm run build:smoke`, `npm run test:language:live` runs the in-process ScriptDom +
  `IndexLookup` SQL language service against `VARIA_TEST_SQL_SERVER` (requires `VARIA_TEST_SQL_SCRATCH=1` for its two
  marked databases): scoped and qualified completion, hover after edits, syntax and catalog-binding diagnostics, metadata
  refresh, isolation and cleanup. `npm run test:language:ui` drives the real Monaco widgets through the app against the
  same server. `node scripts/language-diagnostics-smoke.mjs` checks marker decorations, messages, navigation,
  foreground scheduling, stale-result suppression and split contexts on the fake backend; `--live` checks real squiggles
  against `VARIA_TEST_SQL_SERVER`. See docs/language-services.md.
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
- **SQL Server Agent.** `VARIA_TEST_SQL_AGENT=1` (set by CI's live job and, for a container with Agent enabled, the
  session hook) runs the Agent live suites: they wait for Agent to come up (Agent XPs on and an Agent session; it starts
  after the container's health check), up to `agentLimits.agentUpWaitMs`, and fail if it never does; without the variable
  they skip with one line saying why. CI's live and Linux smoke containers set `MSSQL_AGENT_ENABLED=true`. With
  `VARIA_TEST_SQL_SCRATCH=1` they also create a scratch job and login, named with the run prefix and a kind tag (`_job`,
  `_sch`, `_op`, `_al`, `_px`, `_cr`; logins `_l…`), dropped in `finally` and swept by `ScratchDatabase.SweepAsync` once
  the prefix is 6 hours old. Each scratch job run adds rows to Agent's server-wide history cap, pushing out real jobs'
  oldest rows on a shared server, so a suite runs few jobs. `tests/agent-schedule-live.test.ts` (with both variables)
  creates one never-run scratch job per schedule shape and compares the next run Agent writes with Varia's.
  `VARIA_TEST_SQL_AGENT_SERVICE=1` lets the `AgentService` suite
  stop, start and restart the server's Agent through the Windows Service Control Manager (it needs administrator rights on
  the server's machine); set it only on a server that exists for testing Varia. Only `npm run backend:test:agent-service`
  (exclusive machine lock) and `-- --live-suite AgentService` run that suite; other Agent suites never stop Agent.
  docs/sql-server-agent.md records what is verified.
- **SQL Server Agent needs no variable.** Agent's surfaces show for every SQL Server that runs Agent; the 0.10.0 release
  removed the `VARIA_AGENT_PREVIEW` gate, so smoke, live and vitest runs set nothing to see them
  (`tests/agent-profile.test.ts` keeps the variable from coming back).
- **Smoke hooks.** Smoke tests set `VARIA_SMOKE_TEST=1` with an isolated user-data directory (`VARIA_TEST_USER_DATA`) and write screenshots to
  `artifacts/`. Every `electron.launch` passes `chromiumSandbox` so Linux keeps Chromium's sandbox (only root, as in cloud
  sessions, runs without it). `VARIA_SMOKE_MENU_STYLE=native|custom` picks the context-menu style (so the native path runs
  on Linux too). `VARIA_SMOKE_RECORD=1` makes the suites that support it (`agent-flow-run`) record the window as an animated PNG
  in `artifacts/` (`scripts/fixtures/recording.mjs`), for reviewing live behaviour; CI never sets it. `scripts/packaged-smoke.mjs` and `portable-smoke.mjs` take the built app from `VARIA_PACKAGED_EXECUTABLE`
  (with `VARIA_PACKAGED_PROFILE`) and `VARIA_PORTABLE_EXECUTABLE`. Only in unpackaged smoke runs main also honours:
  - `VARIA_TEST_BACKEND=<mode>` (runs `tests/fixtures/backend.mjs` under the absolute `VARIA_TEST_NODE`; `workbench`
    takes cues from `VARIA_TEST_BACKEND_DIR`), `VARIA_TEST_HOT_EXIT=0` (the fixture's default: no hot exit, so close
    prompts stay; docs/hot-exit.md), `VARIA_TEST_FOLLOW_SYSTEM_MOTION=1` (the fixture's default unless a launch passes
    `motion: true`: the renderer reduces motion whenever the emulated `prefers-reduced-motion` asks, without the
    Reduce motion when the system asks setting), `VARIA_TEST_WINDOW_STATE=1` (the main window keeps its place between
    launches, and main sets `globalThis.__variaWindowPlacement`; docs/popout-windows.md), `VARIA_BACKEND_LIVENESS_MS`, `VARIA_TEST_SAFE_STORAGE=test` (a reversible test
    cipher) or `=none` (a system with no key store: Remember password and the saved search index are unavailable);
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
  - Checks never depend on the machine's memory load: build a `ResultStore` without a memory probe (or with a fake; a
    hosted `SqlService` gets `CheckStores.Unprobed()`, never the default `ResultStore.FromSystem()`), and
    give a sidecar with test hooks `VARIA_RESULT_BUDGET_BYTES`, which turns the load check off; parallel lanes push a
    developer machine past the 90 % high-load threshold, where the real probe truncates every result.
