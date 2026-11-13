# Varia SQL Manager

SSMS-style SQL Server workbench. Electron 44 + React 19 + Monaco 0.57 + Dockview renderer; a .NET 11 sidecar
(Microsoft.Data.SqlClient 7.1, SMO 181) speaks length-prefixed MessagePack frames (protocol v2) over stdio. It is not a
VS Code fork.

Where the detail lives:
- docs/architecture.md: the full architecture invariants this file summarises. Read the area's bullet before changing it.
- docs/testing.md: test environment variables, live and scratch checks, smoke-test hooks, testing rules.
- docs/ci.md: CI layout, measurements and the rules that keep it lean.
- docs/ipc.md: protocol v2 (frames, pages, limits, error codes, benchmarks). README.md: user-facing behaviour.
- Each area's generated page (below) and hand-written page in docs/.

Keep this file stable: no check counts, timings or other numbers that change from PR to PR. A new rule goes in
docs/architecture.md or docs/testing.md; add a line here only when an agent would break something without it.

## Commands

- `npm ci`: install. Use `npm install <pkg>` only to change dependencies, and commit `package-lock.json`.
- `npm run dev`: Debug backend build, then electron-vite with renderer hot reload. Restart after C# changes.
- `npm run check`: typecheck, Release .NET checks, vitest and production build as concurrent lanes (`scripts/check.mjs`).
  Run before every commit.
- `npm run test:smoke`: the Electron suites (needs the Release backend and `out/` from `npm run check`, or
  `npm run build:smoke`). Headless Linux: `xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke`.
  `npm run test:electron` runs `check` then `test:smoke`.
- `npm run backend:test`: only the .NET checks. Add `-- --live-group k/3` to `dotnet run --project
  backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release` for one CI live group.
- `npx vitest run tests/<name>.test.ts`: one vitest file (`backend-sidecar.test.ts` needs the Release backend built).
- `npm run bench`, `npm run bench:e2e`, `npm run bench:grid`: benchmarks, not part of `check`;
  `node scripts/check-bench.mjs` compares them with `tests/bench/floors.json`.

## Environment

- Node.js 24+ and the .NET 11 SDK (`global.json`). Cloud sessions: `.claude/hooks/session-start.sh` installs both, builds
  the backend and starts a SQL Server container.
- Live SQL checks run when `VARIA_TEST_SQL_SERVER` is set (with `VARIA_TEST_SQL_USER`/`VARIA_TEST_SQL_PASSWORD` for SQL
  authentication); `VARIA_TEST_SQL_SCRATCH=1` lets them create marked scratch databases. Entra and SSIS checks are opt-in.
  docs/testing.md lists every variable. Never print passwords or secrets.

## Architecture invariants (summary; full rules in docs/architecture.md)

Security boundary:
- The renderer is untrusted: context isolation, sandbox, no Node integration, CSP, no navigation or popups (except
  popouts, `src/main/popout-windows.ts`). It reaches the system only through `window.varia` (`src/preload/index.ts`); never
  expose generic IPC or shell APIs, and never disable the Chromium sandbox. Main verifies every IPC sender (`trusted()`).
  Built pages load only from `app://varia/`, never `file:`. Packaged builds keep the Electron fuses in `build/fuses.cjs`.
- A backend method is added in all five places: `RpcMethods` (`src/shared/contracts.ts`), a strict zod schema
  (`src/main/validation.ts`), `methodPolicies` (`src/shared/ipc/methods.ts`), a preload method, and a
  `SqlService.DispatchAsync` case with its `MethodNames` entry and record in `backend/Varia.Backend/Contracts.cs`.
- Backend stdout carries protocol frames only. Never log SQL text, names, values, credentials or connection strings.
  Passwords never reach disk in clear; remembered ones are only `safeStorage` ciphertext that only main reads. Entra tokens
  stay in backend memory.
- Bound every input and output (request, response, script and pending-request limits, per-method deadlines, stream
  credit, explicit truncation). New string inputs need max lengths in both zod and C#. A request is never re-sent.
- Failures are values: IPC returns `{ ok: false, error }`, and the UI stays responsive.

Results and live data:
- Query rows stay in backend memory under the result budget, never on disk. DATA pages pass through main undecoded; only
  the results worker decodes them. Results are released on re-execute, tab close, Close Results and backend loss.
- The grid renders only through `GridView` pools and text only through `nodeValue` (`tests/grid-lint.test.ts`); no React
  per row or cell. Copy and Save text is formatted only by `ResultTextWriter`.
- Periodic data flows only through `live.subscribe`/`live.update` with the backend scheduling; the renderer never polls with
  timers. Views open live data only through `LiveService`; charts draw only through `ChartView`.

SQL the backend runs:
- Every SQL path uses constant text with values as parameters and names only through server-side `QUOTENAME`, checked by
  its offline lint, on its own pool or connection with a fixed prologue. Paths: Object Explorer (`CatalogSql`), Search
  Objects, Script As (`ScriptPipeline`, never executes DDL), live probes (`LiveSql`, `ActivitySql`), object actions and
  Table Designer (`ActionService`, the only DDL path besides `SsisActionService`), session actions, SSIS. Read the area's
  bullet in docs/architecture.md before touching any of them.

UI structure (each is the single source; tests enforce it):
- Commands and keybindings: `src/shared/commands/catalog.ts`; `KeybindingService` is the only key listener, and main
  handles no keys. User shortcuts only through `ShortcutsService`. Mouse gestures: `src/shared/commands/gestures.ts` via
  `GestureService`.
- Menus: `src/shared/commands` and `src/shared/theme/menu.ts`; `MenuService` is the only `contextmenu` listener.
- Settings: `src/shared/settings/`; only main reads and writes `settings.json`.
- Colours: `src/shared/theme/` via `var(--varia-*)`; metrics: `src/shared/theme/metrics.ts`; icons: `src/shared/icons.ts`
  drawn through `Icon.tsx`.
- Preferences files are written atomically (`src/main/json-file.ts`); unreadable files are quarantined, never overwritten.

## Generated files

After changing a catalogue, regenerate its outputs with the matching command and commit them:

| Change | Regenerate with |
| --- | --- |
| `src/shared/commands/catalog.ts` | `npx vitest run tests/commands-docs.test.ts -u` |
| `src/shared/commands/gestures.ts` | `npx vitest run tests/gestures.test.ts -u` |
| Monaco upgrade or `start.tsx` imports | `npx vitest run tests/monaco-keybindings.test.ts -u` |
| `src/shared/live/catalog.ts` | `npx vitest run tests/live-catalog.test.ts -u` |
| `src/shared/explorer/catalog.ts` | `npx vitest run tests/explorer-catalog.test.ts -u` |
| `src/shared/scripting/catalog.ts`, `options.ts` | `npx vitest run tests/scripting-catalog.test.ts -u` |
| `src/shared/actions/` | `npx vitest run tests/object-actions-catalog.test.ts -u` |
| `src/shared/designer/catalog.ts` | `npx vitest run tests/table-designer-catalog.test.ts -u` |
| `src/shared/activity/catalog.ts` | `npx vitest run tests/activity-catalog.test.ts -u` |
| `src/shared/ssis/catalog.ts` | `npx vitest run tests/ssis-catalog.test.ts -u` |
| `src/shared/settings/` | `npx vitest run tests/settings-catalog.test.ts -u` |
| `src/shared/theme/metrics.ts` | `npx vitest run tests/theme-metrics.test.ts -u` |
| `src/shared/icons.ts` | `npx vitest run tests/icons.test.ts -u` |
| Published `release-notes/*.json` records | `node scripts/release-notes.mjs --changelog` |

## User-facing documentation

For a user-facing feature or behavior change, update the affected README, docs and guides in the same PR, along with
CHANGELOG.md's Unreleased summary, or explain concretely why no documentation changes are needed. Published release
records are frozen: feature PRs do not add their work to an older release. Release preparation curates the versioned
plain-text records and regenerates the published changelog; docs/release-notes.md describes that process and the shared
producer for in-app and public notes. Keep guidance for both Codex and Claude here; AGENTS.md delegates to this file.

Getting Started pages register in `src/shared/help/catalog.ts` with typed references and advisory source areas;
follow docs/help-authoring.md to add or update guides and samples. Review those dependencies for every feature PR
and record the guide/sample impact or a concrete no-impact reason. Use live reference components, not copied keys,
defaults or menu labels. Samples are fictional and never execute SQL or connect automatically.

## Testing expectations

- Every behaviour change or bug fix comes with a check that would have caught it.
- vitest: `tests/*.test.ts`. .NET: `backend/Varia.Backend.Tests/`, `Check(condition, name)` calls; a new offline suite
  goes in Program.cs's `offlineSuites`, a new live suite through `Suite(...)` with an entry in `LiveGroups.Suites`.
- Smoke suites (`scripts/*-smoke.mjs`) find surfaces by ARIA role and name through `scripts/fixtures/ui.mjs`, the only
  place that names Varia's classes.
- Keep CI fast (docs/ci.md): wait on conditions, never fixed sleeps or `setTimeout` loops; make waits that return early
  generous; run `node scripts/offline-stress.mjs` before pushing an offline .NET timing check; record a new smoke or live
  suite's CI seconds in its table. docs/testing.md has the full rules.

## Conventions

- TypeScript: no semicolons, single quotes, 2-space indent, long lines. C#: 4-space indent, nullable enabled, warnings
  as errors. LF line endings. Comments explain why, sparingly.
- One `claude/<topic>` branch per PR, off `main` or, for a stacked PR, off the branch it builds on. Merge with merge
  commits (never squash or rebase); imperative commit subjects.
- CI (`.github/workflows/ci.yml`) runs on every PR, with a source-only lane for documentation-only PRs; its layout is pinned by `tests/ci-workflow.test.ts` and
  `tests/release-workflow.test.ts` and described in docs/ci.md.
- No license has been chosen; do not add one.

## Product direction (agreed with the owner)

- Goal: SSMS 2022-level polish plus a VS Code-style F1 command palette. Windows, Linux and macOS are all first-class.
  Never freeze or crash; handle error states cleanly. SQL Server 2016-2025; SQL, Integrated (Kerberos off Windows) and
  Microsoft Entra ID authentication.
- Results stay in memory under a backend budget with explicit truncation; no spill to disk.
- Menus: custom-rendered themed menus on Windows/Linux; native menu bar and context menus on macOS.
- Visuals: the modern Calm Pro design language (graphite neutrals, one iris accent, Compact density by default), not
  SSMS's look; SSMS's features, behaviours, names and keys stay the parity target. Icons are codicons plus custom SVGs;
  Microsoft's SSMS icons cannot be reused. Themes: Dark, Light and System, customizable through the palette system.
