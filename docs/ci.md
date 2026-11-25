# CI cost and speed

How CI and `npm run check` spend their time, the mechanisms that keep them lean, what is left to cut, and the rules.
Re-measure with `node scripts/ci-timings.mjs` (`--steps` for per-step times) before and after any CI change, and replace
the Measurements below with the new baseline.

## Layout

`tests/ci-workflow.test.ts` holds this layout.

- **Triggers.** CI (`.github/workflows/ci.yml`) runs on every PR, drafts included (any base branch, so stacked PRs are
  tested), every push to main and manual runs. Newer PR and main pushes cancel their earlier runs; manual runs always
  finish (tags run release.yml, not CI). The repository is public, so minutes cost nothing, but GitHub runs only 20 of its jobs at once (5 on
  macOS).
- **Jobs.** A scope job classifies the complete change, then the 12 validation jobs start together, and a final
  `CI result` job checks their outcomes. Each validation job builds what it needs, so one failure hides nothing and the
  run takes as long as its longest job:
  - `npm run check` on Linux, Windows and macOS.
  - The live .NET checks on Linux in two jobs (`slot: [1, 2]`): slot 1 runs `--live-group 1/3`, `tests/*-live.test.ts`,
    the bundled SQL Tools Service against the container, Kerberos, and BigQuery against its emulator
    (`--bigquery-emulator-live`, the image pinned by digest: about 2 s of checks after the pull on a developer machine).
    Slot 2 starts two SQL Server containers (ports 1433 and 1434, 3 GB memory cap each) and runs groups `2/3` and `3/3`
    concurrently after one Release build (`scripts/ci-live-pair.mjs`), skipping `setup-node` and `npm ci`.
  - The smoke suites in three shards on Linux (sandboxed, under xvfb, with SQL Server; the pinned BigQuery emulator is
    started only in the shard that owns `connections-smoke.mjs`) and three on Windows (`scripts/smoke-shards.mjs`, which
    splits `test:smoke` by each platform's times in its `suiteSeconds`). The other BigQuery suites (results, Explorer,
    Job History) need no emulator: they run against loopback REST fakes on both platforms. macOS skips the smoke tests
    until they cover its window chrome.
  - Nothing in CI contacts a real BigQuery project: the real-project checks are local and opt-in (docs/testing.md).
  - The Linux benchmarks (floors enforced).
- **Report-only work stays off PRs.** Linux's 1024x768 repeats of the scripting and results suites (Windows runners'
  own display is 1024x768) run on main pushes; the Windows and macOS benchmarks run daily and by hand
  (`bench-desktop.yml`).
- **Release builds** (`release.yml`, through `package.yml`, held by `tests/release-workflow.test.ts`) package every main
  push, tags and manual runs, and a pull request only when it changes what packaging reads (its `paths`); Intel macOS packages only for tags, manual runs and a weekly scheduled run on main (Intel alone, every Monday), so an x64-only
  break shows before the tag it would block. Installers upload only for tags and manual runs; a typecheck runs only for
  tags. GitHub reads only a pull request's first 3,000 changed files for `paths`, so a larger pull request may skip
  Release builds: run them by hand then. The Windows package also publishes the update helper (NativeAOT), builds the
  archive installed copies stage from, and its installer smoke stages and swaps that archive into the installation it
  made. Every workflow a pull request triggers cancels its superseded runs.
- `sql-matrix.yml` (manual runs only) repeats the .NET checks against SQL Server 2017, 2019, 2022 and 2025.
- `agent-service.yml` (held by `tests/agent-service-workflow.test.ts`) installs SQL Server 2022 Developer as the named
  instance `VARIA` on a Windows runner and runs the `Agent` and `AgentService` live suites, which stop, start and restart
  its real SQL Server Agent through the Service Control Manager (docs/sql-server-agent.md). It runs on pull requests that
  change its `paths` (the Agent backend, the job verbs, the actions dispatch, the backend's packages, its live checks and their grouping, the workflow), daily on main, and by hand, kept
  out of `ci.yml` so every other pull request's validation is unchanged. It is not a required check: a pull request on
  which it ran merges only when it is green. The install retries Chocolatey up to four times with backoff, since the
  community feed answers 503 now and then, and fails with a plain message when SQL Server never installed. Measured time: about 230 s wall (SQL Server install 158 s, the two live
  suites 37 s, setup 30 s).
- **SQL Tools Service** is a build-time dependency pinned in `build/sqltools-service.json` for every release RID.
  Preparation verifies the official archive's SHA-256 before extraction and keeps upstream notices, the MIT license and
  an inventory of file hashes. Development commands prepare the host's distribution; packaging prepares its exact target
  and includes the complete runtime beside the backend. Packaged smoke checks those files and starts the bundled language
  server without a path override. Live group 1 tests schema completion and hover against its container. Linux smoke
  shard 3 exercises real Monaco completion and hover in split and floating editors against SQL Server 2022 with SQL
  Login (focus return from a panel's OS popout, targeted cache refresh, docking back), reusing that shard's server,
  build and display, with a five-minute deadline.
- **Suites that share a launch instead of adding a job.** The language widget suite also checks hover and suggestion
  placement in short panels and at viewport edges. `language-diagnostics-smoke.mjs` runs in the regular shards (rendered
  squiggles, messages, issue navigation, foreground scheduling with preserved markers, stale-result cleanup); the SQL
  language live suite validates real syntax and binding issues, qualified joined completions and diagnostic cache
  refresh against marked fixtures. `grouped-results-smoke.mjs` covers the results' Tabs layout in its own launch because
  `results-smoke.mjs` is near the split guideline; the other results suites pin the Stacked layout by setting.
  `updates-smoke.mjs` also carries About (Help and palette opening, focus, clipboard, fixed browser destinations, update
  states, restart), the release reader (installed and history, section and scroll preservation, exact-version and
  unavailable, light and dark) and Getting Started (search, lazy routing and focus, fictional samples, live
  shortcut/gesture/settings changes, Options navigation, narrow layout under reduced motion, sample ordering under each
  text-sort mode, focus and section restoration after a tab switch). Release-notes content checks use the publication
  loader; curated release-body compilation runs in the existing tag-publication job with a script-free install.
- **Downloads and hangs in packaging.** Smoke builds and packaging prepare Electron from its npm-pinned checksums,
  retrying transient download failures within three attempts and three minutes and seeding the shared archive cache so
  packaging verifies offline. Publishing a verified SQL Tools archive or runtime retries brief Windows sharing violations
  up to seven times; other filesystem errors still fail, and checksum and inventory verification stay required. Packaged
  smoke reports its phase, bounds application, window and CDP cleanup, and has a ten-minute runner-level timeout outside
  its five-minute body watchdog (which catches synchronous work before the watchdog starts).

## Documentation-only changes

- `scripts/ci-scope.mjs` sends a PR whose changes are limited to `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`
  and any file under `docs/` or `prototypes/` (Markdown, images, mockups, theme schema and examples) through a Linux
  documentation lane: `npm ci --ignore-scripts` (no Electron download), then source-only vitest, which keeps the
  generated-document (theme schema included), README and published-changelog assertions. It skips .NET, typechecking,
  production builds, SQL services, smoke and benchmarks. Nothing builds, typechecks or packages those folders, and
  `tests/ci-scope.test.ts` fails if a build, typecheck, test or package config starts reading them. Anything else
  (`release-notes/*.json`, scripts, workflows, build resources, tests, dependencies) runs full CI.
- For PRs the scope job fetches full history but checks out only its classifier, and reads an untruncated,
  NUL-delimited diff from the merge-base to head (stacked PRs and earlier commits included; renames count both paths).
  Unknown or empty changes and missing history fall back to full CI. Git is used directly to avoid `paths`' 3,000-file
  limit. Scope and result jobs check out only their scripts and use the runner's bundled Node; test jobs select Node 24.
- Manual runs execute the selected `regression-suite`: `docs` runs the exact documentation lane on any branch, `none`
  runs full CI, the others run focused regressions through `ci-regressions.yml` (`dialogs`, `results`, `tail`, `all`:
  Electron suites; `activity`: live SQL checks). That workflow has manual entry points only and adds no automatic runs. Every manual run reports `Manual CI result`; only automatic
  runs report the required `CI result`, so a manual success cannot stand in for it. Never require `Manual CI result`.
- The main ruleset requires the single check `CI result`, not strict: a PR need not be up to date with main, so
  merge only when the head SHA's run is green. The result job runs with `always()` and fails if
  classification or any selected job fails, is cancelled, missing or unexpectedly skipped, and on failures in
  unselected jobs. CI has no workflow-level `paths-ignore`, so the required check always reports.
- Docs-only skipping applies to PRs only. Every main push runs full CI and packaging, so cancelling a superseded main
  run is safe: the surviving run repeats the complete workload (installers, packaged smoke, 1024x768 repeats). Tag
  publication requires both packaging jobs to succeed.

## Measurements

- **Queueing, not jobs, sets the wall time.** In the 2026-11-07 baseline (50 runs) a busy PR's CI took 25.4 min median
  while its longest job took 10; the median job waited 16 min for a runner (up to 50). Several agent sessions push at
  once, so every job and slot-minute a push adds delays every other run. **Removing whole jobs beats shaving steps.**
- Packaging runs only for PRs that touch it: packaging every PR had caught nothing CI missed in 232 runs.
- Main on 2026-11-11 (3 runs, `--workflow ci.yml --workflow release.yml --branch main`): CI 10.8 min wall, 47 Linux +
  26 Windows + 5 macOS runner-minutes; packaging 14.1 min, 3 + 14 + 4. That was before the fourth Windows smoke shard,
  which adds one job's setup and `build:smoke` (a few Windows runner-minutes); the next baseline replaces these figures.
- In `npm run check` on CI the critical path is the vitest chain, which shares 3 or 4 vCPUs with the .NET chain; speeding
  up vitest under that contention is the next gain in Check.
- Most of an offline .NET run used to be waiting, not work (`VARIA_TEST_SLOW_MS=300` found about 64 s of 75.6 s in
  connect timeouts and budget waits), hence `Unreachable.Source` and the lanes below.

## Mechanisms in place

- `scripts/check.mjs` runs tsc, the electron-vite build, vitest, and the .NET build followed by the offline checks and the
  Release-backend vitest files as concurrent lanes: all at once with 8 or more CPUs, two chains side by side on CI's 3 and
  4 vCPU runners (all at once starved macOS until time-bounded tests failed). On CI runners with fewer than 8 CPUs,
  `VITEST_MAX_WORKERS` is capped (`Math.ceil(cpus / 2)`, capped below `cpus`) so vitest and the .NET lanes do not
  oversubscribe the runner. The electron-vite build runs after the .NET chain, not after vitest. tsc runs only on Linux
  (`VARIA_CHECK_SKIP=typecheck` on Windows and macOS): it reads only sources and installed types, and Linux's
  case-sensitive paths are the strictest. A check stopped by the step timeout prints what its running lanes held.
- `findConflicts(defaultRules(platform), platform)` memoizes its default-rule check per platform (returning a fresh copy)
  and `contextRecord` clones a precomputed platform base record, so every `KeybindingService` instantiated across vitest
  does not re-scan all rules and focus samples.
- `tests/fixtures/settle.ts` settles microtasks and I/O via `setImmediate` rather than `setTimeout(0)` loops (Windows
  rounds timers to 15.6 ms), and `tests/backend-sidecar.test.ts` shares one Release backend process across its stateless
  tests.
- On CI the Release .NET build compiles in its own processes (`-p:UseSharedCompilation=false`, `sharedCompilation()` in
  `scripts/check.mjs`). GitHub's Windows runner starts a job below normal priority, but the shared compiler server
  (VBCSCompiler) starts at normal priority and took every vCPU from vitest's workers for seconds at a time, timing out
  unrelated tests. Look for a process above the job's priority when a Windows test stalls with its worker using no CPU.
- The offline .NET suites run in six concurrent lanes (`OfflineSuites.cs`) with a raised `ThreadPool.SetMinThreads` floor
  so synchronous lanes do not starve async checks, after the few suites that change or measure process-wide state run
  alone; each prints its time. `FusedWhole` (`Diffs`, `DistinctsSearch`, `MixedServices`, `Faults`) and
  `BigQueryExecution` (`Core`, `Residence`, `ViewsCopySave`, `Storage`) are split into four concurrent suites each, and
  BigQuery residence checks poll asynchronously instead of busy-spinning on `SpinWait`. `OfflineSuites` names any suite
  still running after 3 minutes
  and exits. The result suites run a second time with every result's pages packed (Program.cs `packedPass`), since only
  that pass reaches every reader through packed pages.
- Offline checks fail their connections on a malformed named-pipe address on Windows instead of `tcp:127.0.0.1,1`
  (`Unreachable.cs`).
- `npm run build:smoke` prepares Electron and SQL Tools Service in parallel with the Release backend and electron-vite
  builds (`scripts/check.mjs --build`). Jobs that do not launch the SQL language server (Linux smoke shards 1 and 2,
  Windows smoke shards, Linux benchmarks) pass `VARIA_CHECK_SKIP=sqltools`.
- Linux jobs that need SQL Server (`live`, `smoke-linux`, `bench-linux`) start the container in the background right
  after checkout via `scripts/ci-docker.mjs` (retrying transient Docker pulls up to three times) and wait for readiness
  only before the first SQL step, hiding container boot behind setup and builds. The BigQuery emulator uses the same
  pull-retry helper and starts only in the Linux smoke shard that owns `connections-smoke.mjs`
  (`smoke-shards.mjs --has-suite`).
- Smoke suites race `close()` through `within()` (`scripts/fixtures/smoke.mjs`), which clears its timer
  (`tests/idle-waits.test.ts`). A close not finished in 45 s kills the app and fails the suite with its own error
  (`boundedClose`; on Linux it names the processes left in the app's process group), and `smoke-shards.mjs` kills a
  suite past four times its weight (at least 5 min), so the shard's later suites still run. Playwright's close also waits
  for the stdio pipes the backend and its language server inherit, so the backend's exit waits for its language-server
  kill (`ExitGate`), and Linux and macOS kill that child with one signal instead of a tree kill. A process left behind
  after quit is a product bug.
- Live slot 2 skips `setup-node` and `npm ci` (running `scripts/ci-live-pair.mjs` with the runner's bundled Node);
  `npm ci --no-audit --no-fund` everywhere.
- `VARIA_TEST_SLOW_MS=<ms>` prints each offline or live .NET check reached later than that after the previous one
  (offline suites then run in one lane).
- `offline-stress.mjs` strips the SQL and Entra variables, so its copies never run live suites against a shared server.
- Tests pin package.yml's packaged checks against ref or event conditions, bench-desktop.yml's steps and timeouts, the
  check's wide and build layouts, ci.yml's stated job count, and the fixtures that start the Release backend.

## What is left, in order

Savings are estimates checked against CI logs. "Owner" marks changes that contradict a rule
in CLAUDE.md, which the owner decides.

1. **Profile object-actions-smoke and the Windows-only slow checks** (M). object-actions is the longest suite (124 s
   Linux, 179 s Windows), over the roughly 90 s split guideline; its login block is about 10 times slower per line than
   its neighbours. A Windows excess of about 15 s usually means an assertion runs out its 15 s Windows expect timeout.
   Use `VARIA_SMOKE_PROFILE`.
2. **Cross-build osx-x64 on arm64, or `--dir` packaging on non-tag macOS runs** (M). Ends the Intel image GitHub is
   retiring; `--dir` skips the DMG and hdiutil step behind 2 of the 3 infrastructure false failures.
3. **Split the Host offline suite** (S). It is the floor of the offline lanes (its `Thread.Sleep(1200)` and budget waits).
4. **Non-isolated vitest for read-only catalogue and lint tests** (M, trial first). About 9 to 11 s off the vitest chain,
   but leaked module state can weaken coverage silently: trial with `sequence.shuffle` on an allowlist guarded against
   mocks, timers, globals and `process.env`.

Considered and rejected (do not re-propose without new numbers):

- **A well-formed pipe address in `Unreachable.Source`.** The single backslash makes SqlClient refuse the address before
  any open (SNI error 25). A well-formed one sends every fake's open through the Named Pipes provider and SqlClient's
  throttle of non-pooled opens: under `offline-stress.mjs`, 5 to 7 of 15 copies crashed with "Timeout attempting to open
  the connection". The checks assert only that the failure is retryable, which both forms are.
- **One shard per OS.** Makes 12 to 13 min jobs and smoke the critical path; three shards per platform keep every shard
  within the 420-second shard budget (about 1,215 s on Linux, 1,197 s on Windows).
- **Build once and fan out artifacts.** Needs `needs:` and adds 1 to 3 min of serial wall time before the smoke shards,
  the critical path, to save about 2 runner-min.
- **Caching `node_modules` or the Electron download.** `npm ci` from the npm cache takes 4 to 8 s on Linux; the 637 MB tree
  restores slower than that on Windows, and Electron downloads in 0.6 to 3.4 s.
- **Skipping all checks for docs.** Generated docs, README and the published changelog have test assertions; the
  documentation lane keeps them.
- **Folding bench-linux into Check ubuntu.** `services:` cannot be conditional on a matrix that includes Windows and
  macOS, and the fold saves at most 1 runner-min.
- **Path-filtering the live or smoke jobs.** A safe filter (anything under `src/`) skipped 0 of 40 recent PRs.

## Rules for keeping CI lean

- **Budget per push across all workflows.** A code-changing PR push starts at most 12 validation jobs, 1 of them macOS,
  plus the two short Linux scope and result jobs, which do not overlap their validation jobs (`tests/ci-workflow.test.ts`),
  plus at most 3 packaging jobs, only when it changes packaging (`tests/release-workflow.test.ts`). A PR over 3,000
  changed files may skip Release builds silently: run them by hand (`workflow_dispatch`) when it touches packaging.
- **Audit gate.** `npm audit` runs in its own workflow (`audit.yml`: one job that installs nothing), not in CI, where an
  advisory-endpoint outage or a new advisory failed every PR whatever it changed. It runs on PRs and main pushes that
  change `package.json`, `package-lock.json`, `scripts/audit.mjs` or `.github/workflows/audit.yml`, and daily on main. `scripts/audit.mjs` retries an endpoint that gives no
  report, then warns without failing. Its paths filter means it must never be a required check (a PR it skips would wait
  forever), so look at it before merging a dependency change. A high or critical advisory fails the job: upgrade or
  override the package and add its floor to `tests/dependency-floors.test.ts`. Moderate and low ones only report
  (minimatch's GHSA-g3hv-75wg-m249 has no fix below 11.0.1, a major version under electron-builder, and its patterns come
  only from Varia's build configuration).
- **Cancel superseded PR and main runs.** Every workflow a PR triggers has a concurrency group keyed by `github.ref` with
  `cancel-in-progress`; CI, Release builds and Audit also cancel superseded main runs. Tags and manual runs keep unique groups.
- **Don't starve small runners.** CI's runners have 3 or 4 vCPUs; running every check lane at once there made tsc 13
  times slower and failed 1 to 3 s polls. Add work as a lane in a chain (`scripts/check.mjs`), say what it waits for, and
  never chain new phases with `&&` in `check`. Only the vitest files in its `needsBackend` list need the Release backend,
  and nothing reads `out/`.
- **Stress timing checks before pushing them.** The offline lanes share CI's vCPUs with vitest, and timers there fire
  300 ms to over 1 s late. `node scripts/offline-stress.mjs` runs five copies of the offline checks on three CPUs at once;
  a timing check that passes there survives CI. Give two racing timers about a second between them, and make a wait that returns early
  generous. A CancellationTokenSource timer cancels from the thread pool, which the lanes saturate: when the work it
  stops can finish first, cancel from a dedicated thread (SearchChecks.Deadline). Vitest's CPU-bound tests take
  `heavyTimeout` (`tests/fixtures/work-meter.ts`; `tests/idle-waits.test.ts` requires it for every test of 50,000 rows
  or more).
- **Offline .NET suites run in lanes.** Put a new suite in Program.cs's `offlineSuites` list with its measured seconds
  in `OfflineSuites.Weights` if over 0.3 s (shorter suites count as 0.1 s), and in `OfflineSuites.Alone` if it touches process-wide state.
- **Fold work into an existing job before adding one.** Each job costs 40 to 70 s of setup (plus about 23 s with a SQL
  Server container) and a slot.
- **Never repeat on one commit what another job already proved.** Packaging does not re-run tsc or vitest. Report-only
  work (unenforced benchmarks, repeats of covered suites) runs on a schedule or by hand.
- **No idle timers.** Race a close or an exit only through `within()` or an unreferenced delay. In tests, settle on
  microtasks, `setImmediate` or a condition, never `setTimeout` loops. A fixed wait is allowed only for a negative check
  bounded by a product timer, and at most that timer plus 0.5 s.
- **Fail connections without waiting.** Offline checks use `Unreachable.Source`, never a real TCP address.
- **Look for waits before blaming the work.** `VARIA_TEST_SLOW_MS=500` for the .NET checks, `VARIA_SMOKE_PROFILE` for
  smoke. A check more than 10 s slower on Windows usually runs out a timeout.
- **Keep the tables current.** After adding or changing a smoke or live suite, copy its CI seconds (each shard's
  summary, each `Live suite name: n s` line) into `suiteSeconds` (Linux and Windows) or `LiveGroups.Suites`. Both budget
  checks trust those tables: each smoke shard has 420 s (`shardBudgetSeconds`) and each live group has 360 s
  (`LiveGroups.BudgetSeconds`), and the per-suite watchdog (four times the weight, at least 300 s) rises with a weight.
  When a run skipped a suite (no SQL endpoint), keep its existing weight.
- **Write down the numbers.** A CI change records before and after numbers from `scripts/ci-timings.mjs`
  (runner-minutes, job count, queue) in its PR, and replaces the baseline under Measurements.
