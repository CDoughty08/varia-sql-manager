# CI cost and speed

How CI and `npm run check` spend their time, what was cut, what is left to cut, and the rules that keep them lean. Re-measure
with `node scripts/ci-timings.mjs` (add `--steps` for per-step times) before and after any CI change, and update this page.

## Where the time goes (baseline, 2026-11-07)

Measured over the 50 most recent successful runs of `ci.yml` and `release.yml` (25 each) with the method of
`scripts/ci-timings.mjs`.

**Queueing, not jobs, sets the wall time.** A busy pull request's CI run took **25.4 min** (median) while its longest job
took **10 min**. The median job waited **16 min** for a runner (up to 50). GitHub runs 20 jobs at once for the account (5 on
macOS), and several agent sessions push pull requests at the same time, so every job and slot-minute a push adds delays
every other run. **Removing whole jobs beats shaving steps.**

Each pull request push started 15 jobs and used about 89 runner-minutes:

| Workflow | Jobs | Runner-min | Linux | Windows | macOS |
| --- | --- | --- | --- | --- | --- |
| CI (`ci.yml`) | 11 | 68 | 40 | 23 | 5 |
| Release builds (`release.yml`) | 4 | 21 | 2 | 6 | 13 |

Median job run times (minutes): Check ubuntu 4.0, windows 5.3, macos 4.7; Live groups 5.5 to 5.9; Smoke Linux 8.1 and
8.3, Windows 8.1 and 10.0; Bench Linux 4.0; Package linux 2.4, osx-arm64 4.0, win 6.0, osx-x64 8.9.

Release builds packaged every pull request push. It had no concurrency group, so a superseded push kept packaging.
Measured over 232 PR runs: 0 failures that CI had not also caught, and 3 infrastructure false failures, all on Intel macOS.
Its uploaded installers were never downloaded.

**`npm run check`** ran its four phases one after another. In CI, the step took 165 to 253 s:

| Phase | CI (s) | Local, 24 cores (s) |
| --- | --- | --- |
| `tsc --noEmit` | 3 to 6 | 3.6 |
| .NET Release build plus the offline checks | 87 to 109 | 75.6 (checks only) |
| vitest (227 files) | 57 to 114 | 32.3 |
| electron-vite build | 18 to 28 | 23.5 |
| Total | 165 to 253 | 136.7 |

Most of the offline .NET run is waiting, not work. `VARIA_TEST_SLOW_MS=300` found 73 checks reached more than 300 ms after
the previous one, about 64 s of the 75.6 s. The waits:

- 24 one-second connect timeouts.
- 9 waits of 1.5 to 3.4 s each for a request's budget to run out.
- 40 shorter waits.

## What was cut (PR #166)

| Change | Measured effect |
| --- | --- |
| `scripts/check.mjs` runs tsc, the electron-vite build, vitest, and the .NET build followed by the offline checks and the Release-backend vitest files as concurrent lanes: all at once with 8 or more CPUs, two chains side by side on CI's 3 and 4 vCPU runners | Local `npm run check` 136.7 s to **32.9 s** (with the two items below). In CI, all at once took Check ubuntu's step from about 205 s to 107 s but starved macOS (tsc 66 s instead of 5, vite 147 s instead of 20) until time-bounded tests failed, hence the chains there. |
| The offline .NET suites run in six concurrent lanes (`OfflineSuites.cs`), after the three that change process-wide state run alone; each prints its time | Offline run 65 s to **22 to 24 s** locally (1 lane 65 s, 4 lanes 26 s, 6 lanes 22 s, 8 lanes 19 s; Host's 10 s is the floor) |
| `npm run build:smoke` builds the Release backend and electron-vite side by side | Estimate: 8 to 20 s per smoke and bench job (5 a push) |
| Smoke suites race `close()` through `within()` (`scripts/fixtures/smoke.mjs`), which clears its timer. `tests/idle-waits.test.ts` holds the rule. | updates-smoke 34.2 s to **7.0 s**, live-smoke 39.0 s to **24.1 s** (local). About 123 s of idle timers per OS per run, about **4 runner-min a PR push**. The packaged and portable smoke tests, and both Electron benches, had the same leak. |
| The offline .NET checks fail their connections on a missing named pipe on Windows instead of `tcp:127.0.0.1,1` (`Unreachable.cs`) | Windows offline run 75.6 s to **65.6 s** |
| Release builds: packages main pushes, tags, manual runs, and only pull requests that touch packaging inputs. Superseded runs are cancelled. Intel macOS packages only for tags and manual runs. A typecheck runs only for tags. Installers upload only for tags and manual runs. `tests/release-workflow.test.ts` holds the layout. | About 21 runner-min, 13 of them macOS, and 4 jobs removed from about 9 in 10 PR pushes. A packaging PR runs 3 jobs (1 macOS) instead of 4 (2 macOS). |
| Live groups 2 and 3 skip setup-node and `npm ci` | About 20 runner-s a push |
| `npm ci --no-audit --no-fund` | Cleaner logs. About 1 s a job, unmeasured. |
| `VARIA_TEST_SLOW_MS=<ms>` prints each offline or live .NET check reached later than that after the previous one (offline suites then run in one lane) | A tool for finding waits |
| Smoke `suiteSeconds` refreshed from PR #166's run, after the idle timers went | Declared weights matched reality again: shards 338/336 s (Linux) and 342/340 s (Windows) against the 360 s budget, where the old weights had drifted 12 to 21% low. Main then added the 64 s Live Plan suite and a third Linux shard (about 250 s each) |
| The Windows and macOS benchmarks run daily and by hand (`bench-desktop.yml`), not on every main push | 2 jobs (1 macOS) and about 5.7 runner-min off each of 9 to 20 main pushes a day, for one daily run |
| A newer main push cancels the older main run (`ci.yml`'s concurrency), as pull requests already did | Up to 74 runner-min and 13 jobs per superseded main push; 30 of 73 main pushes came within 20 min of the previous one, so an estimated 1,000 to 2,000 slot-min a week. Each PR already tested its merge with main, and the newest main commit always gets a complete run. |

After these changes, a PR push that does not touch packaging runs 11 jobs (12 since main's third Linux smoke shard), an estimated 55 to 60 runner-min, and 1 macOS job (from 15
jobs, 89 runner-min, 3 macOS). That is about a quarter fewer jobs and 30% fewer runner-minutes. Since queueing dominates,
expect most of that to show up as wall time on busy days.

## What is left, in order

Savings are corrected figures from an adversarial review of each proposal against CI logs. "Owner" marks changes that
contradict a rule written in CLAUDE.md, so the owner decides them (the owner chose to move the desktop benchmarks and
cancel superseded main runs, now done).

1. **Settle vitest tests with `setImmediate`, not `setTimeout(0)` loops** (S). Windows rounds each timer to about 15.6 ms.
   ssis-tree-probe takes 16.7 s on Windows against 2.2 s on Linux (425 timer hops, about 34 ms each). 45 files use the
   pattern, about 32 s of Windows test time and about 10 s of wall time. Put a shared `settle()` in `tests/fixtures/`.
2. **Profile object-actions-smoke and the Windows-only slow checks** (M). object-actions takes 106 s (Linux) and 149 s
   (Windows, PR #166), the longest suite and what leaves the Windows shards only 18 s of budget,, over the roughly 90 s split guideline. Its login block (lines 1504 to 1839) is about 10 times slower per line
   than its neighbours. A Windows excess of about 15 s usually means an assertion runs out its 15 s Windows expect timeout.
   Use `VARIA_SMOKE_PROFILE`.
3. **Start the SQL Server container in the background** (M). Each Linux job with `services: sql` spends 20 to 24 s in
   "Initialize containers" before checkout. A `docker run -d` as the first step, and a health wait right before the first
   SQL step, hides that behind `npm ci` and the build. About 45 to 60 s per push for the smoke and bench jobs, and more for
   live if its `dotnet build` moves into its own step.
4. **Two SQL Server containers in one live job** (M). This keeps "each group against a server of its own" and removes one
   job: about 1 runner-min, one slot, and one container start a push. Prerequisite: the live checks with hard sub-2 s bounds
   (ExplorerLiveChecks 266/272/284, ScriptingLiveChecks 217/230/260/432/439/515) need load tolerance first
   (`LiveResultChecks.CancelBound`/`OnceMore`).
5. **Cross-build osx-x64 on arm64, or `--dir` packaging on non-tag macOS runs** (M). This would end the Intel image, which
   GitHub is retiring, even for tags. Packaging at `--dir` skips the DMG and hdiutil step behind 2 of the 3 false failures.
6. **Split the Host offline suite** (S). At 10 s it is the floor of the offline lanes (its `Thread.Sleep(1200)` and
   budget waits); split in two, 8 lanes would reach about 15 s.
7. **Shrink the CPU-bound vitest files** (S). Explorer-service's 99,000-row reconcile tests take 3 to 4 s locally and ran
   out vitest's 20 s default on a shared 4-vCPU Windows runner. They now pass `heavyTimeout` (90 s,
   `tests/fixtures/work-meter.ts`, required by `tests/idle-waits.test.ts` for every test of 50,000 rows or more), which
   stops the false failures but not the minutes: explorer-service.test.ts is about 33 s of Windows's vitest lane. Their
   work bounds come from the meter, not the size, so a smaller input (10,000 rows) may prove the same bound.

Considered and rejected (do not re-propose without new numbers):

- **One shard per OS, or three.** One shard makes 12 to 13 min jobs (smoke becomes the critical path). Three shards add
  about 1.5 runner-min and one slot per OS per push.
- **Build once and fan out artifacts.** This needs `needs:` and adds 1 to 3 min of serial wall time before the smoke
  shards, which are the critical path, to save about 2 runner-min.
- **Caching `node_modules` or the Electron download.** `npm ci` from the npm cache takes 4 to 8 s on Linux. The 637 MB tree
  restores slower than that on Windows, and Electron downloads in 0.6 to 3.4 s.
- **`paths-ignore` for docs.** No recent PR was docs-only, and `docs/*.md` are generated outputs that vitest compares.
- **Folding bench-linux into Check ubuntu.** `services:` cannot be conditional on a matrix that includes Windows and
  macOS, and the fold saves at most 1 runner-min.
- **Path-filtering the live or smoke jobs.** A safe filter (anything under `src/`) skipped 0 of 40 recent PRs.

## Rules for keeping CI lean

- **Budget per push across all workflows.** A pull request push starts at most 12 CI jobs, 1 of them macOS
  (`tests/ci-workflow.test.ts`), plus at most 3 packaging jobs, and those only when it changes packaging
  (`tests/release-workflow.test.ts`). Two overlapping pushes must fit in 20 slots.
- **Cancel superseded runs.** Every workflow a pull request triggers has a concurrency group keyed by `github.ref` with
  `cancel-in-progress`, and so do main pushes. Tags and manual runs are never cancelled.
- **Don't starve small runners.** CI's runners have 3 or 4 vCPUs. Running every check lane at once there made tsc 13 times
  slower and failed 1 to 3 s polls. Add work as a lane in a chain (`scripts/check.mjs`), and give waits that return as soon
  as their condition holds generous bounds.
- **Stress timing checks before pushing them.** Even in chains, the offline lanes share CI's 3 or 4 vCPUs with vitest, and
  timers there fire 300 ms to over 1 s late. Three rounds of PR #166's CI each failed on a different offline check with a
  sub-second race (a 300 ms budget against a 50 ms delay, a 200 ms grace against a 20 ms job, a 2 s exit wait). A sweep of
  every offline suite then made 65 such changes, adding about 9 s of suite time (Host is now 12.5 s, still the lanes'
  floor). `node scripts/offline-stress.mjs` runs five copies of the offline checks on three CPUs at once. Before the sweep,
  three copies failed every run; after it, every run of five copies passed. Give two racing timers about a second between them, and
  make a wait that returns early generous. A CancellationTokenSource timer cancels from the thread pool, which the lanes saturate: when the work it stops can finish first, cancel from a dedicated thread (SearchChecks.Deadline). Vitest's CPU-bound tests take `heavyTimeout` (`tests/fixtures/work-meter.ts`).
- **Offline .NET suites run in lanes.** Put a new suite in Program.cs's `offlineSuites` list with its weight in
  `OfflineSuites.Weights`, and in `OfflineSuites.Alone` if it touches process-wide state.
- **Fold work into an existing job before adding one.** Each job costs 40 to 70 s of setup (plus about 23 s with a SQL
  Server container) and a slot.
- **Never repeat on one commit what another job already proved.** Packaging does not re-run tsc or vitest. Report-only work
  (unenforced benchmarks, repeats of covered suites) runs on a schedule or by hand.
- **Never chain new phases with `&&` in `check`.** Add a lane in `scripts/check.mjs` and say what it waits for. Only the
  vitest files in its `needsBackend` list need the Release backend, and nothing reads `out/`.
- **No idle timers.** Race a close or an exit only through `within()` or an unreferenced delay. In tests, settle on
  microtasks, `setImmediate` or a condition, never `setTimeout` loops. A fixed wait is allowed only for a negative check
  bounded by a product timer, and at most that timer plus 0.5 s.
- **Fail connections without waiting.** Offline checks use `Unreachable.Source`, never a real TCP address.
- **Look for waits before blaming the work.** Use `VARIA_TEST_SLOW_MS=500` for the .NET checks, and `VARIA_SMOKE_PROFILE`
  for smoke. A check that is more than 10 s slower on Windows usually runs out a timeout.
- **Keep the tables current.** After adding or changing a smoke suite or live suite, copy its CI seconds into
  `suiteSeconds` or `LiveGroups.Suites`. Both budget checks trust those tables.
- **Write down the numbers.** A CI change records before and after numbers from `scripts/ci-timings.mjs` (runner-minutes,
  job count, queue) in its PR and here.
