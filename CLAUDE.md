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
- `npm run test:smoke`: the seven Electron suites in `scripts/`. Needs the Release backend and `out/` from `npm run check`.
  Headless Linux: `xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke`.
- `npm run test:electron`: `check` followed by `test:smoke`.
- `npm run backend:test`: only the .NET checks. `npx vitest run tests/<name>.test.ts`: one vitest file
  (`backend-sidecar.test.ts` starts the Release backend, so build it first with `npm run check` or `npm run backend:test`).
- `npm run bench` (node harness, Release backend) and `npm run bench:e2e [-- --live]` (Electron, needs `out/`): the IPC
  benchmarks, not part of `check`. `node scripts/check-bench.mjs [--enforce]` compares them with
  `tests/bench/floors.json`; CI enforces floors on Linux only.

## Environment

- Node.js 24+ and the .NET 10 SDK (`global.json`, latest feature band). In cloud sessions `.claude/hooks/session-start.sh`
  installs both, runs `npm install`, builds the backend (Debug and Release; a failed build is reported, not fatal), and
  puts `/opt/node24/bin` on PATH. After clear or compact it only refreshes the exported variables.
- Live SQL checks run when `VARIA_TEST_SQL_SERVER` is set: SQL authentication with `VARIA_TEST_SQL_USER` and
  `VARIA_TEST_SQL_PASSWORD`, otherwise Windows authentication. The .NET suite then reports 187 checks instead of 123, and
  `connections-smoke.mjs` connects for real. Never print the password. `VARIA_TEST_SQL_SCRATCH=1` (set by CI and the
  session hook) also lets live tests create and drop a uniquely named, marked `varia_scratch_…` database
  (`tests/explorer-live.test.ts`, for graph and temporal tables); without it those checks are skipped.
- Cloud sessions: the hook starts the `varia-sql` Docker container (SQL Server 2022, `sa`, localhost:1433) and exports
  those variables when it is ready. If Docker is unavailable, live checks are skipped rather than failing.
- Smoke tests set `VARIA_SMOKE_TEST=1` with an isolated user-data directory and write screenshots to `artifacts/`.
  Every `electron.launch` passes `chromiumSandbox` so Linux runs keep Chromium's sandbox (Playwright would add
  `--no-sandbox`); only root, as in cloud sessions, runs without it. Only in unpackaged smoke runs, main also honours
  `VARIA_TEST_BACKEND=<mode>` (runs `tests/fixtures/backend.mjs` under the absolute `VARIA_TEST_NODE`; `workbench`
  takes cues from `VARIA_TEST_BACKEND_DIR`), `VARIA_BACKEND_LIVENESS_MS`, `globalThis.__variaTest` (kill, states,
  synthesize), the renderer's test mode (`window.__variaResults`), and passes the backend `VARIA_BACKEND_TEST_HOOKS`
  (synthetic results) and `VARIA_RESULT_BUDGET_BYTES`.

## Architecture invariants

- The renderer is untrusted: context isolation, sandbox, no Node integration, CSP, blocked navigation and popups.
  It reaches the system only through `window.varia` (`src/preload/index.ts`); never expose generic IPC or shell APIs,
  and never disable the Chromium sandbox. Main verifies every IPC sender (`trusted()` in `src/main/index.ts`).
- A backend method must be added in all five places: `RpcMethods` in `src/shared/contracts.ts`, a strict zod schema in
  `requestSchemas` (`src/main/validation.ts`), a `methodPolicies` entry (`src/shared/ipc/methods.ts`), a preload method,
  and a `SqlService.DispatchAsync` case plus its `MethodNames` entry, with its record in `backend/Varia.Backend/Contracts.cs`.
  Unknown methods and unknown members are rejected on both sides; main refuses a backend whose HELLO lacks a method.
- Backend stdout carries protocol v2 frames only (`Console.Out` goes to stderr). Never log SQL text, credentials, or
  connection strings. Passwords stay in memory: not in `connections.json`, process arguments, or previews.
- Query rows stay in backend memory (never on disk) under the result budget. Main forwards DATA pages undecoded, as
  exact-size ArrayBuffers (`toExactArrayBuffer`); only the results worker decodes them (`decodePage`). Results-port
  messages from the renderer are validated with `portRequestSchema`, ownership, and the current generation.
- Bound every input and output: 4 MiB request and 16 MiB response bodies, 1M-character scripts, 256 pending requests
  per backend generation, a deadline per method (`methodPolicies`), credit for result streams (16 MiB per stream, 64 MiB
  per port), and explicit truncation of results and messages.
  New string inputs need max lengths in both zod and C#. A request is written to at most one backend generation and is
  never re-sent.
- Preferences are written atomically (`src/main/json-file.ts`); unreadable files are quarantined, never overwritten.
- Failures are values: IPC returns `{ ok: false, error }`, and the UI stays responsive.
- Commands and keybindings are declared only in `src/shared/commands/catalog.ts`. `KeybindingService`
  (`src/renderer/src/core/keybindings.ts`) is the only key listener and routes keys to an open menu first; main handles
  no keys (`tests/keyboard-lint.test.ts`). Electron roles are commands (`role`): native menus show the role, and custom
  menus and the palette run it through `varia:run-role`. After catalogue changes, regenerate `docs/commands.md` with
  `npx vitest run tests/commands-docs.test.ts -u`.
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
- Colours live only in `src/shared/theme/`. CSS and TSX use `var(--varia-*)`; `tests/theme-css.test.ts` enforces this.
  Theme files are untrusted: only main reads them, and the renderer applies only the validated map main sends.

## Testing expectations

- vitest: `tests/*.test.ts`, fixtures in `tests/fixtures/`.
- .NET: `backend/Varia.Backend.Tests/Program.cs`, a console program of `Check(condition, name)` calls. Offline checks come
  first; live checks follow and create only session-local temporary objects.
- UI behaviour: `scripts/*-smoke.mjs` drive the real app through Playwright's Electron API.
- IPC performance: `tests/bench/*.bench.ts` and `scripts/ipc-bench.mjs` only measure; a new metric needs a
  `tests/bench/floors.json` entry (`tests/bench-floors.test.ts` checks both lists) and a row in docs/ipc.md. Floors must
  stay well below what slow shared CI runners measure.
- Every behaviour change or bug fix comes with a check that would have caught it.

## Conventions

- TypeScript: no semicolons, single quotes, 2-space indent, long lines. C#: 4-space indent, nullable enabled, warnings
  as errors. LF line endings (`.editorconfig`, `.gitattributes`). Comments explain why, sparingly.
- One `claude/<topic>` branch per PR, off `main` or, for a stacked PR, off the branch it builds on. Merge with merge
  commits (never squash or rebase), so stacked branches need no rebase; imperative commit subjects.
- CI (`.github/workflows/ci.yml`): the Linux job (live SQL Server service, sandboxed smoke tests under xvfb) runs on
  every PR (any base branch, so stacked PRs are tested) and every push to main. Windows and macOS run on push to main,
  manual runs, and non-draft PRs only, because the repository is private and their minutes bill at 2x and 10x; macOS
  skips the smoke tests until they cover its window chrome. Keep PRs in draft while iterating.
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
- Visuals: SSMS layout, density, and behaviours. Icons are codicons (bundled with Monaco) plus custom SVGs; Microsoft's
  SSMS icons cannot be reused. Themes: Dark and Light (plus follow System), customizable through a standardized palette
  system like VS Code or opencode.
