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

## What this change did

| Change | Measured effect |
| --- | --- |
| `scripts/check.mjs` runs tsc, the electron-vite build, vitest, and the .NET build followed by the offline checks and the Release-backend vitest files, all at once | Local `npm run check` 136.7 s to **78.9 s**, and **70.5 s** with the named pipe below. CI estimate: 30 to 95 s less per Check job. |
| `npm run build:smoke` builds the Release backend and electron-vite side by side | Estimate: 8 to 20 s per smoke and bench job (5 a push) |
| Smoke suites race `close()` through `within()` (`scripts/fixtures/smoke.mjs`), which clears its timer. `tests/idle-waits.test.ts` holds the rule. | updates-smoke 34.2 s to **7.0 s**, live-smoke 39.0 s to **24.1 s** (local). About 123 s of idle timers per OS per run, about **4 runner-min a PR push**. The packaged and portable smoke tests, and both Electron benches, had the same leak. |
| The offline .NET checks fail their connections on a missing named pipe on Windows instead of `tcp:127.0.0.1,1` (`Unreachable.cs`) | Windows offline run 75.6 s to **65.6 s** |
| Release builds: packages main pushes, tags, manual runs, and only pull requests that touch packaging inputs. Superseded runs are cancelled. Intel macOS packages only for tags and manual runs. A typecheck runs only for tags. Installers upload only for tags and manual runs. `tests/release-workflow.test.ts` holds the layout. | About 21 runner-min, 13 of them macOS, and 4 jobs removed from about 9 in 10 PR pushes. A packaging PR runs 3 jobs (1 macOS) instead of 4 (2 macOS). |
| Live groups 2 and 3 skip setup-node and `npm ci` | About 20 runner-s a push |
| `npm ci --no-audit --no-fund` | Cleaner logs. About 1 s a job, unmeasured. |
| `VARIA_TEST_SLOW_MS=<ms>` prints each offline or live .NET check reached later than that after the previous one | A tool for finding waits |

After this change, a PR push that does not touch packaging runs 11 jobs, an estimated 60 to 64 runner-min, and 1 macOS job (from 15
jobs, 89 runner-min, 3 macOS). That is about a quarter fewer jobs and 30% fewer runner-minutes. Since queueing dominates,
expect most of that to show up as wall time on busy days.

## What is left, in order

Savings are corrected figures from an adversarial review of each proposal against CI logs. "Owner" marks changes that
contradict a rule written in CLAUDE.md, so the owner decides them.

1. **Refresh `suiteSeconds` from this change's CI run** (S). The weights had drifted 12 to 21% low (object-actions is
   declared at 36 s on Linux but measured 108 s), and the timer fix moved most suites. Copy the times from each shard's
   summary. `tests/ci-workflow.test.ts` checks the declared sums against the 360 s budget, so update the weights after the
   fix lands, not before. Expect the longest Windows shard to drop by 20 to 45 s.
2. **Parallelize the offline .NET suites in-process** (M). The offline lane (65 to 77 s) is now the floor of
   `npm run check`. Most of it is budget and timeout waits (see above), not CPU, so running independent suites concurrently
   (`Task.WhenAll` over groups, an `Interlocked` check counter, suites that share no static state) should halve it. First
   print each suite's time, the way the live suites do.
3. **Settle vitest tests with `setImmediate`, not `setTimeout(0)` loops** (S). Windows rounds each timer to about 15.6 ms.
   ssis-tree-probe takes 16.7 s on Windows against 2.2 s on Linux (425 timer hops, about 34 ms each). 45 files use the
   pattern, about 32 s of Windows test time and about 10 s of wall time. Put a shared `settle()` in `tests/fixtures/`.
4. **Profile object-actions-smoke and the Windows-only slow checks** (M). object-actions takes 108 s (Linux) and 135 s
   (Windows), over the roughly 90 s split guideline. Its login block (lines 1504 to 1839) is about 10 times slower per line
   than its neighbours. A Windows excess of about 15 s usually means an assertion runs out its 15 s Windows expect timeout.
   Use `VARIA_SMOKE_PROFILE`.
5. **Start the SQL Server container in the background** (M). Each Linux job with `services: sql` spends 20 to 24 s in
   "Initialize containers" before checkout. A `docker run -d` as the first step, and a health wait right before the first
   SQL step, hides that behind `npm ci` and the build. About 45 to 60 s per push for the smoke and bench jobs, and more for
   live if its `dotnet build` moves into its own step.
6. **Two SQL Server containers in one live job** (M). This keeps "each group against a server of its own" and removes one
   job: about 1 runner-min, one slot, and one container start a push. Prerequisite: the live checks with hard sub-2 s bounds
   (ExplorerLiveChecks 266/272/284, ScriptingLiveChecks 217/230/260/432/439/515) need load tolerance first
   (`LiveResultChecks.CancelBound`/`OnceMore`).
7. **Cross-build osx-x64 on arm64, or `--dir` packaging on non-tag macOS runs** (M). This would end the Intel image, which
   GitHub is retiring, even for tags. Packaging at `--dir` skips the DMG and hdiutil step behind 2 of the 3 false failures.
8. **Report-only work off main pushes** (Owner, S). The desktop benchmarks (5.7 runner-min, 1 macOS job) and Linux's
   1024x768 repeats (99 s) run on every main push, 9 to 20 a day. Move them to a separate scheduled workflow. Do not add
   `schedule` to `ci.yml`: every job there would run.
9. **Cancel superseded main runs** (Owner). Every main commit gets its own complete 13-job run (74 runner-min), and 30 of
   73 main pushes came within 20 minutes of the previous one. Each PR already tested its merge ref. Keying main runs by ref
   with `cancel-in-progress` could reclaim 1,000 to 2,000 slot-min a week, but it drops the "every main commit has a run"
   guarantee.

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

- **Budget per push across all workflows.** A pull request push starts at most 11 CI jobs, 1 of them macOS
  (`tests/ci-workflow.test.ts`), plus at most 3 packaging jobs, and those only when it changes packaging
  (`tests/release-workflow.test.ts`). Two overlapping pushes must fit in 20 slots.
- **Cancel superseded runs.** Every workflow a pull request triggers has a concurrency group keyed by `github.ref` with
  `cancel-in-progress`. Tags and manual runs are never cancelled.
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
