# Workbench visual polish plan

Status: **agreed with the owner on 2026-11-23; WP-1, WP-2, WP-3 done**. Interactive design lab:
[docs/mockups/workbench-polish.html](mockups/workbench-polish.html) (open directly in a browser; Dark/Light,
Compact/Comfortable, 6 scenarios, and 1-click toggles for **Approach B (Agreed)**, **Approach A (WCAG 3:1)**, and
**Today (Baseline)**). Each lane updates its area's doc, CHANGELOG.md's Unreleased summary, and marks its row here
**Done**. Once all lanes ship, fold any standing rules into the area docs and delete this plan.

## Goals and non-goals

Goals:

- Fix the live P0 visual defects found in the 30-screenshot workbench audit (`.output-views` empty hollow dot, squished
  Object Explorer server rows, Memory popover `.` tab truncation, false-positive amber row-size bars, native Windows
  scrollbars).
- Eliminate layout instability and visual noise across the primary SQL workbench: lock Document Tabs above per-query
  `QueryBar`, align Object Explorer and Editor horizontal baselines with zero stair-step, declutter the 7-box Results
  toolbar, collapse the redundant 3rd Results bar on solo Table views, and calm the 8-pipe Status Bar.
- Unify connection-color cues across tabs, `QueryBar`, Object Explorer server bands, and the status bar using a single
  Calm Pro hairline + directional wash grammar (retiring the thick left stripe on cards) for any preset or custom color.
- Preserve every SSMS capability, command ID, keyboard shortcut (`F5`, `Ctrl+M`, `Ctrl+L`, `Ctrl+Q`, `F1`, `Ctrl+R`,
  `F6`), classic toolbar fallback, ARIA role/name contract, and grid performance floor.

Non-goals (handled in separate plans/PRs):

- Connect OS Window v2 (`connect-v2.html` — separate plan/PR).
- Options dialog redesign (`General` theme preview cards, switch controls, `Shortcuts` header collapse).
- Activity Monitor KPI/Split-View restyle and Execution Plan toolbar/minimap polish.

## Owner decisions (2026-11-22 – 2026-11-23)

Confirmed through the Workbench v2 design lab:

1. **Document Tabs vs `QueryBar`:** **Tabs Above (Per-Query Bar)** — move `<QueryBar />` inside each SQL document below
   its group's tab strip so non-query tabs (`Activity Monitor`, `Search Objects`, designers) never cause a 36 px vertical
   tab jump, and split editor groups unambiguously show which server/database each pane executes against.
2. **Document Tab Style:** **Refined 2-Line (40 px Compact / 44 px Comfortable)** — keep `[ENV]` + live `SID`, omit the
   empty `—` chip when no session exists, allow natural tab widths (`148–210 px`), and keep the **Pin button in a fixed
   `20 px` slot** (quiet at rest when unpinned, crisp on hover/pinned) so tab buttons never shift horizontally on hover.
3. **Pinned Tabs Placement:** **Dedicated Pinned Row** — retain `TabShelves`' separate pinned shelf when tabs are pinned.
4. **`QueryBar` Plan & Cancel Controls:** **Unified `Plan ▾` menu + Morph `Execute → Cancel`** — fixes the narrow-width
   3-identical-plan-icons bug, reclaims ~160 px, and pairs an explicit Execution Scope pill (`All` / `Lines 4–9`) beside
   `Execute`.
5. **Object Explorer Chrome & Server Bands:** **1-Row Header + Inline Filter/Schema + Flush `44 px` 2-Line Server Bands
   + Tree Indent Guides** — no thick left stripe; use the same 1 px tinted hairline + soft wash as `QueryBar`, flush
   edge-to-edge so top/bottom `ExplorerPinnedBand` sticky stacking and `… N more` rollover stay 100% jump-free; lock
   `.explorer-header` height (`40 px`) to Document Tabs and `.object-search-pane` query row height (`36 px`) to
   `QueryBar` so both horizontal seams run straight across the splitter with zero stair-step.
6. **Results Toolbar Density:** **Progressive Disclosure (Calm)** — collapse `White space` (`¶`) and `Sort text by`
   (`📏`) to compact 1-button popovers when at default (`Off` / `Value`), expanding to tinted state chips when
   non-default, and drop wireframe box borders around icon groups so `Completed · N rows · 0.042 s` stays unclipped.
7. **Results Header & Grid Polish:** **Smart 2-Bar + Right-Aligned Numeric Columns + Outlier-Only Row-Size Gutter** —
   merge solo `Table` facts + `Save ▾` onto the Result Tabs bar (+28 px), expanding the view strip only when a Pivot or
   filter chip is present; right-align numeric columns with `tabular-nums`; flag `data-large` only on genuine row-size
   outliers.
8. **Status Bar & Memory Popover:** **Grouped Calm + Live MB + Quick-Free `×`** — replace redundant `Ready` +
   `Connected.` and 8 vertical `|` pipes with calm spacing, condense language/analysis into one clickable status chip,
   show live backend MB on the status trigger, fix `.memory-biggest-tab` `.` truncation, and add hover-reveal `×` /
   `Close all` release actions inside the Memory popover.
9. **Resting Border Contrast:** **Approach B — Relaxed (`#3a404d` Dark / `#c2c8d4` Light)** — eliminates harsh 1 px
   border aliasing at rest on inputs and secondary controls while keeping crisp ≥ 3:1 focus rings (`focusBorder`) and
   elevated hover outlines (updating `palette.ts`, `contrast-pairs.ts`, and `tests/theme-contrast.test.ts` in WP-1).
10. **Connection-Color Hairline & Tint:** **Unified across `QueryBar` and Object Explorer Server Bands** — applies to
    *any* set connection color (Red, Orange, Yellow, Green, Blue, Purple, or custom hex) via `useConnectionAccent(color)`,
    neutral when unset.

## What exists today (codebase invariants checked)

- **WCAG contrast gate (`tests/theme-contrast.test.ts`):**
  - Holds `input.border` and `button.border` to **3:1** on every surface they sit on (`input.background`,
    `editorWidget.background`, `toolbar.background`, `panel.background`, `panelTitle.background`, `sideBar.background`,
    `editor.background`).
  - Asserts `objectExplorer.activeConnectionBackground` equals `sideBar.background` (untinted), so connection-color
    tinting must be driven strictly by `useConnectionAccent(color)` and never by changing `activeConnectionBackground`.
  - Asserts that every CSS rule in `styles.css` setting both `color: var(--varia-*)` and `background: var(--varia-*)`
    has a registered contrast pair in `src/shared/theme/contrast-pairs.ts`.
- **Metric & glyph token lint (`tests/theme-metrics.test.ts`):**
  - Every CSS `font-size` must use `var(--varia-size-*)` (`>= 11 px`) or `var(--varia-glyph-*)`; no literal `px` font
    sizes anywhere in `styles.css` or renderer TS/TSX.
  - Every selector sized with `--varia-header`, `--varia-bar`, `--varia-documentTab`, `--varia-control`, `--varia-row`,
    or `--varia-status` must appear in `densityUse` (`src/shared/theme/metrics.ts`); every icon-sized selector must
    appear in `glyphUse`. Regenerate `docs/themes/metrics.md` with `npx vitest run tests/theme-metrics.test.ts -u`.
  - Only `radii` tokens (`4 px`, `8 px`, `999 px`) are allowed for border-radius (except explicit `indicatorRadii`).
- **Object Explorer sticky stacking (`src/renderer/src/explorer/tree-model.ts`, `ExplorerTree.tsx`, `ExplorerPinnedBand.tsx`):**
  - `rowLayout()` and `pinnedServerBands()` assume one constant `explorerLimits.serverRowHeight` (currently `30 px`) for
    both in-tree server rows and pinned headers in top/bottom `.explorer-pin-band` overlays, synchronized per scroll
    frame via `flushSync(measure)`.
  - Moving to `44 px` flush 2-line server bands (zero outer vertical/horizontal margin, `border-radius: 0`) preserves
    exact 1:1 scroll-speed rollover into `… N more above / below`, `revealPinnedScroll` binary search, and viewport
    budget stepping (`min(viewport / 3, (viewport - 44) / 2)`).
- **Results Grid pool & lint (`src/renderer/src/grid/GridView.ts`, `tests/grid-lint.test.ts`):**
  - Zero React per row/cell; text written only via `Text.nodeValue = displayText(value)`.
  - Cell classes are precomputed in `classes[bits]`; numeric alignment must be a bit in that table (zero per-cell string
    allocation) and keep `npm run bench:grid` within `tests/bench/floors.json`.
- **Row-size gutter (`src/renderer/src/grid/row-sizes.ts:88`):**
  - Currently computes `large: share > 0.5` where `share = bytes / max`. On uniform rows (~180 B), every row has
    `share ≈ 0.99 > 0.5`, flagging 100% of rows amber. `RowSizes` already fetches `results.profile([])` which returns
    `rowBytes: { max, average }` (or `readMax` while streaming), so outlier detection needs no new IPC method.
- **No backend protocol changes:** All six lanes are renderer + `src/shared/` + docs/tests only; zero new RPC methods,
  zero C# protocol changes, zero migration risk.

---

## Detailed Lane Design

### WP-1 — Foundations, P0 Fixes, Scrollbars & Header Grouping (`S`)

Fast, low-risk foundation PR that clears the highest-visibility live bugs without changing layout structure.

- **Empty `.output-views` dot fix (`OutputPane.tsx`):** Render `.output-views` only when `views.length > 0` (and add
  `.output-views:empty { display: none; }` as a belt-and-suspenders guard).
- **Memory Popover `.` truncation fix (`styles.css`):** Replace `.memory-biggest-name > .memory-biggest-tab { flex-shrink: 1000; }`
  with `flex: 0 1 auto; max-width: 42%;` so tab names remain legible before the result subtitle ellipsizes.
- **Row-size gutter outlier fix (`src/renderer/src/grid/row-sizes.ts`, `styles.css`):**
  - Capture `profileAverage` alongside `profileMax` from `handle.profile([])` (falling back to the running read average
    before profile completes).
  - Mark `large: true` only when `bytes >= 4096 && share > 0.5` or `(average > 0 && bytes >= average * 2.5 && share > 0.5)`
    so uniform ~180 B rows stay calm neutral/blue instead of all turning warning amber.
  - Lower normal bar opacity (`0.18`–`0.22`) and add a crisp `2.5 px` left warning edge on true `data-large` rows.
- **Global themed thin scrollbars (`styles.css`):** Apply `8 px` transparent-track scrollbars using
  `--varia-scrollbarSlider-background` / `hoverBackground` / `activeBackground` across scrollable renderer containers
  (Explorer, Results grids, Column Profile, Pivot, Memory Popover, dialogs), preserving `forced-colors: active` native
  scrollbars.
- **Title Bar quick-action grouping (`ShellToolbar.tsx`, `styles.css`):** Insert hairline `.toolbar-divider` separators
  grouping `Connect | New · Open · Save · Save All | Activity Monitor`, plus a subtle accent dirty dot on `Save` when
  the active document has unsaved edits.
- **Calm resting chrome (`palette.ts`, `contrast-pairs.ts`, `tests/theme-contrast.test.ts`, `styles.css`):** Adopt
  **Approach B** — soften resting `$controlBorder` / `$inputBorder` to `#3a404d` (Dark) / `#c2c8d4` (Light) so 1 px
  outlines don't alias harshly at rest, keep `focusBorder` (`#8f9cff` / `#4453d0`) and interactive hover borders crisp
  at ≥ 3:1, and update `contrast-pairs.ts` + `tests/theme-contrast.test.ts` (and verify `docs/themes/examples/*.json`)
  to reflect the resting vs focus/hover border contract.

**Checks:** `tests/row-sizes.test.ts` (uniform 180 B rows have `large === false`, 14 KB outlier has `large === true`),
`tests/theme-contrast.test.ts`, `tests/theme-css.test.ts`, `tests/theme-metrics.test.ts`, `results-smoke`,
`theme-smoke`.

---

### WP-2 — Object Explorer 2-Line Flush Server Bands, Seam Alignment & Tree Polish (`M`)

- **Flush `44 px` 2-line server bands (`src/shared/explorer/catalog.ts`, `ExplorerRow.tsx`, `ExplorerPinnedBand.tsx`, `styles.css`):**
  - Update `explorerLimits.serverRowHeight` from `30` to `44` (and regenerate `tests/explorer-catalog.test.ts -u` if
    snapshot-checked).
  - Restructure both `ExplorerRow` (when `root === true`) and `PinnedServerRow` into identical `44 px` full-bleed 2-line
    bands:
    - Line 1: chevron + server icon + full semibold `displayName` + unclipped `[ENV]` pill + connection status dot.
    - Line 2 (indented under label): muted `host · version/auth` sublabel + right-aligned live chips (`2 jobs`) +
      active-query glyph (`.oe-active`) + lost-server actions when offline.
  - Replace `.oe-accent` (3 px left stripe) and `[data-current-section]` (`2 px` left border) with the unified **1 px
    tinted top/bottom hairline + soft directional wash** (`--varia-server-accent: useConnectionAccent(color)`). Keep
    `objectExplorer.activeConnectionBackground` untinted so `tests/theme-contrast.test.ts` stays untouched.
- **1-Row Header + Inline Filter/Schema + Horizontal Seam Alignment (`ExplorerPane.tsx`, `SearchPanel.tsx`, `metrics.ts`, `styles.css`):**
  - Keep `.explorer-header` on one row down to `210 px` width: `Object Explorer` + `Connect`, `Refresh`, `Collapse All`,
    and `⋯` (which retains `Disconnect`, `Remove`, `Stop`, and menu access to all tools).
  - Place `Filter Settings` and `Group by Schema` inline beside the `ExplorerSearch` input (keeping them reachable via
    keyboard & ARIA toolbar/labels, and falling back cleanly when disconnected/empty so no button vanishes unexpectedly).
  - Align `.explorer-header` height to `var(--varia-documentTab)` (`40 px` Compact / `44 px` Comfortable, registered in
    `metrics.ts` `densityUse`) and `.object-search-pane .object-search-query` height to `var(--varia-bar)` (`36 px` /
    `40 px`, centered vertically) so both horizontal borders align flush across the dock splitter with Document Tabs and
    `QueryBar`.
- **Tree guides, column legibility & footer (`ExplorerRow.tsx`, `ExplorerPane.tsx`, `registry.ts`, `styles.css`):**
  - Un-reserve and wire `tree.indentGuidesStroke` (`$borderSubtle`) as `1 px` vertical guides per nesting level in
    `.oe-indent`.
  - Prioritize `.oe-label` over `.oe-sublabel` on column rows so column names stay legible before types truncate; render
    a compact `PK` indicator on primary-key columns; slightly mute static system folders (`System Databases`, `System
    Tables`, etc.) via `--varia-objectExplorer-sublabelForeground`.
  - Keep `.explorer-servers` pinned right in `.explorer-footer` (`flex-shrink: 0`) while `.explorer-freshness-scope`
    ellipsizes, so the connected-server count never disappears on long table names.

**Checks:** `tests/explorer-tree.test.ts` (44 px `rowLayout` + `pinnedServerBands` top/bottom rollover & `revealPinnedScroll`),
`tests/theme-metrics.test.ts`, `tests/theme-contrast.test.ts`, `explorer-smoke` (including sticky band & environment tag
measurements), `environment-smoke`.

---

### WP-3 — Tabs Above Per-Query Bar, Refined 2-Line Tabs & Connection-Color QueryBar Tint (`L`)

- **Hoist Document Tabs above per-query `QueryBar` (`App.tsx`, `EditorArea.tsx`, `QueryBar.tsx`, `styles.css`):**
  - Remove `<QueryBar />` and `.query-bar-spacer` from `<main className="workspace">` in `App.tsx`.
  - Mount `<QueryBar tabId={api.id} />` directly inside `DocumentPanel` (`EditorArea.tsx`) when `kind === 'sql'` and
    `!shell.classicToolbar` (classic toolbar continues to host the global controls unchanged).
  - Scope `useQueryContext(tabId)` and `useExecutionScope(tabId)` to the owning document's `tabId` so split editor
    groups (`Group 1 [PROD]` | `Group 2 [STAGING]`) each display and control their own server, database, and execution
    state without cross-group ambiguity.
  - Ensure clicking a button in an inactive split group's `QueryBar` activates that group/document before executing
    (preserving SSMS focus return to that group's Monaco editor).
- **Refined 2-Line Document Tabs (`EditorArea.tsx`, `TabShelves.tsx`, `metrics.ts`, `styles.css`):**
  - Set `densities.compact.documentTab = 40` and `densities.comfortable.documentTab = 44` in `src/shared/theme/metrics.ts`
    (matching `.explorer-header` in WP-2; regenerate `docs/themes/metrics.md`).
  - Omit `.tab-sid` when `spid === undefined && !rememberedServer` (retiring the boxed `[—]` placeholder on idle/new
    tabs).
  - Keep `.tab-pin` in its **fixed `20 px` slot** (`opacity: 0.52` at rest when unpinned, `1` on hover/focus, accent
    when pinned) so close/pin buttons never shift on hover.
  - Keep `TabShelves`' **Dedicated Pinned Row** and multi-row `Ctrl+Wheel` stacking; tighten default cell width target
    (`TabShelves.tsx:11`) from `232 px` to `196 px` so 3–4 short tabs don't leave excessive dead space while still
    keeping `SID` + `[ENV]` + fixed Pin/Close unclipped.
- **Connection-color hairline & wash on `QueryBar` (`QueryBar.tsx`, `styles.css`):**
  - Apply `--query-bar-accent: useConnectionAccent(model.color)` to `.query-bar` and `.query-connection`, painting a
    `1 px` inset top hairline (`color-mix` ~38% dark / 32% light) + soft leading wash (~8% dark / 6.5% light) and tinted
    connection-pill border for *any* set connection color (neutral when unset).
  - Show friendly display alias (`Production ERP`) in the collapsed server `<select>` instead of repeating
    `Production ERP (prod-sql-01.corp.l…)`, keeping full host + server details in the dropdown options and tooltip.

**Checks:** Vitest coverage for per-tab `QueryBar` context in split groups and non-query tab Y-stability,
`tests/theme-metrics.test.ts`, `editor-smoke`, `layout-smoke`, `connections-smoke` (including `environment-*` captures).

---

### WP-4 — Unified `Plan ▾` Menu, Morph `Execute → Cancel` & Execution Scope Pill (`M`)

- **Distinct plan icons + Unified `Plan ▾` menu (`src/shared/icons.ts`, `QueryBar.tsx`, `styles.css`):**
  - Add three distinct custom SVGs in `src/shared/icons.ts` (`execution-plan-actual`, `execution-plan-live`,
    `execution-plan-estimated`; regenerate `tests/icons.test.ts -u` and `docs/icons.md`).
  - Replace the three separate plan buttons on the modern `QueryBar` with one `Plan ▾` menu trigger:
    - Shows active icon + label (`Plan`, `Actual Plan`, `Live Plan`, or `Actual + Live`) with pressed styling when
      Actual or Live Plan is toggled on.
    - Opens a calm popover listing `Include Actual Plan (Ctrl+M)`, `Include Live Plan`, separator, and
      `Display Estimated Plan (Ctrl+L)` — executing the exact existing commands so shortcuts, command palette, and
      `Query` menu stay 100% synced.
    - Classic toolbar (`ShellToolbar.tsx`) keeps its existing separate controls unchanged.
- **Morph `Execute → Cancel` + Scope Pill (`QueryBar.tsx`, `styles.css`):**
  - While the tab's query is idle, show `Execute [F5]` (or `Run Selection [F5]` when text is selected) paired with a
    compact scope chip (`All` muted / `Lines 4–9` warning-tinted when selecting) and hide disabled `Cancel`.
  - While the tab's query is executing, morph the primary button into a crisp error-tinted `Cancel` button with live
    elapsed timer (`1.4s`), keeping `aria-label="Cancel"` and `Alt+Break` / `query.cancel` wiring intact and keeping
    keyboard roving-focus rescue (`QueryBar.tsx:111-121`) seamless across the Execute↔Cancel transition.

**Checks:** `tests/icons.test.ts`, `tests/query-bar.test.ts` (roving focus across Execute↔Cancel morph, Plan menu toggle
states, narrow container widths), `estimated-plans-smoke`, `live-plan-smoke`, `editor-smoke`.

---

### WP-5 — Calm Results Toolbar, Smart 2-Bar Header & Numeric Grid Alignment (`M`)

- **Progressive disclosure on `ResultsToolbar` (`ResultsToolbar.tsx`, `styles.css`):**
  - Replace the always-expanded 3-way `White space (Off | Spaces | All)` and `Sort text by (Value | Chars | Bytes)`
    segmented boxes with compact 1-button popover triggers (`¶` and `📏`) that expand into tinted chips (`¶ Spaces`,
    `📏 Bytes`) only when non-default. Keep full keyboard access (`role="toolbar"` roving focus, `aria-haspopup="menu"`,
    and existing command IDs `output.showSpaces`, `output.showAllWhitespace`, `output.sortTextByChars`,
    `output.sortTextByBytes`).
  - Remove outer borders from `.results-segments` icon groups (`Profile`, `Row size`, `Pivot`, `Compare`, `Transpose`,
    `Tabs`, `Close Results`, `⋯`) and `.output-views`, using tonal hover/pressed fills and subtle `1 px` vertical
    dividers instead. Update `toolbarFolds` thresholds so narrow panes fold even later and `output-status`
    (`Completed · N rows · 0.042 s`) stays visible at default desktop widths.
- **Smart 2-Bar Results Header (`ResultsTabs.tsx`, `styles.css`):**
  - When `group && views.length === 1 && !hasActiveFilters` (solo `Table` view, no Pivot, no filter chips), hide the
    redundant `.rt-views` row and render `ViewFacts` (`Result 1 · 100 rows · 8 cols`) + `SaveView` inline on the right
    side of `.rt-results` (reclaiming `28 px`).
  - As soon as a Pivot exists (`views.length > 1`), a comparison is selected, or filter chips are active, render
    `.rt-views` cleanly beneath `.rt-results` (preserving `tabsFold` short-pane behavior and ARIA `tablist`/`tabpanel`
    `aria-labelledby` wiring!).
- **Grid numeric alignment & header hierarchy (`GridView.ts`, `styles.css`):**
  - Add a numeric alignment bit to `GridView`'s precomputed `classes[bits]` table (and `rg-ch-num` on column headers)
    keyed off each column's existing `sortKind` / numeric SQL type (`int`, `bigint`, `smallint`, `tinyint`, `decimal`,
    `numeric`, `money`, `smallmoney`, `float`, `real`, BigQuery `INT64`/`NUMERIC`/`BIGNUMERIC`/`FLOAT64`). Keep
    transposed view left-aligned where rows mix types.
  - Refine `.rg-cn` (column name semibold `--varia-resultsGrid-headerForeground`) vs `.rg-ct` (muted mono SQL type with
    clear spacing), keep `NULL` visually distinct, and verify `npm run bench:grid` stays above `tests/bench/floors.json`.

**Checks:** `tests/grid-lint.test.ts`, `tests/results-toolbar.test.ts` (folding + progressive chips),
`tests/results-tabs.test.ts` (2-bar solo Table vs 3-bar Pivot/filtered + `aria-labelledby`), `results-smoke`,
`grouped-results-smoke`, `npm run bench:grid`.

---

### WP-6 — Grouped Calm Status Bar & Actionable Memory Popover (`S–M`)

- **Grouped Status Bar (`App.tsx`, `QueryStatusBar.tsx`, `EditorStatus.tsx`, `styles.css`):**
  - When backend is `ready` and the active query is connected, collapse the redundant `● Ready` + `🔌 Connected.` pair
    into one calm connection segment (`[ENV] · ● Server · database · login (SPID)`), still surfacing `Starting…` /
    `Restarting…` / `SQL backend unavailable` prominently whenever backend health is non-ready.
  - Replace the 8 vertical `|` pipe separators with clean group spacing + subtle `1 px` dividers between logical groups
    (Connection | Caret & Encoding | Language/Analysis | Memory).
  - Condense `IntelliSense off` + `SQL analysis paused` into one compact clickable status button (opening the relevant
    language/analysis setting or tooltip with full detail), while keeping `aria-live="polite"` error/issue announcements.
- **Live Memory Trigger & Quick-Free Actions (`MemoryIndicator.tsx`, `NerdMetrics.tsx`, `ResultsService.ts`, `styles.css`):**
  - Display live compact total (e.g., `147 MB`, or `Memory` when `0 MB` / unavailable) beside the dual memory rings in
    `.memory-indicator`.
  - In `BIGGEST RESULTS` (`NerdMetrics.tsx`), add a hover/focus-revealed `×` button per row (`aria-label="Close <result>
    to free memory"`) that releases that specific result set via `results.removeEntry(tabId, entryKey)` (disabled while
    its query is running), plus a `Close all` link in the `BIGGEST RESULTS` header for releasing all non-running results
    across tabs.

**Checks:** `tests/memory-indicator.test.ts` (live label, per-result release, running-query guard, focus retention),
`tests/query-status.test.ts`, `results-smoke`, `language-services-smoke`, `connections-smoke`.

---

## PR Lanes

Ordered; lanes in the same wave can run in parallel once their dependency lands. Sizes: **S** (< 1 day), **M** (1–2
days), **L** (2–4 days). Every lane's definition of done includes `npm run check`, its targeted smoke suites, affected
docs under `docs/`, `CHANGELOG.md` Unreleased summary, and Getting Started guide/sample impact (or a concrete no-impact
note).

| Lane | Scope | Depends on | Shared files | Generated outputs | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **WP-1** | P0 fixes (`.output-views` dot, `.memory-biggest-tab` truncation, `RowSizes` outlier threshold), global thin themed scrollbars, Title Bar icon grouping + dirty Save dot, calm resting chrome (Approach B: `$controlBorder`/`$inputBorder`, `commandCenter.border` & `chip.border` promoted from `/45`, `resultsGrid.splitterBackground` mapped to `$iconMuted` to keep 3:1) | — | `styles.css`, `palette.ts`, `registry.ts` | `docs/themes/tokens.md`, `docs/themes/varia-theme.schema.json`, `docs/settings.md` | S | **Done** |
| **WP-2** | Object Explorer `44 px` flush 2-line server bands (unified hairline + tint, jump-free `ExplorerPinnedBand` rollover), 1-row header + inline Filter/Schema, Row 1 & Row 2 seam alignment with tabs/`QueryBar`, `tree.indentGuidesStroke`, column legibility, pinned footer server count | WP-1 | `styles.css`, `metrics.ts`, `registry.ts` | `docs/themes/metrics.md`, `docs/themes/tokens.md`, `docs/themes/varia-theme.schema.json`, `docs/object-explorer.md`, `docs/commands.md` | M | **Done** |
| **WP-3** | Hoist Document Tabs above per-query `QueryBar` (split-group safe, retire `.query-bar-spacer`), Refined 2-Line `40 px` tabs (omit empty `—`, fixed `20 px` Pin slot, keep Dedicated Pinned Row), connection-color hairline + wash on `QueryBar`, alias-only collapsed server select | WP-1 *(syncs `40 px` token with WP-2)* | `App.tsx`, `EditorArea.tsx`, `QueryBar.tsx`, `styles.css`, `metrics.ts` | `docs/themes/metrics.md` | L | **Done** |
| **WP-4** | Unified `Plan ▾` menu with 3 distinct plan icons (fixes narrow 3-identical-icons bug), Morph `Execute → Cancel` with live timer, anchored Execution Scope pill (`All` / `Lines 4–9`) | WP-3 | `QueryBar.tsx`, `src/shared/icons.ts`, `styles.css` | `docs/icons.md` (`tests/icons.test.ts -u`) | M | **Done** |
| **WP-5** | Calm `ResultsToolbar` progressive disclosure (`¶` & `📏` popovers, borderless icon groups), Smart 2-Bar `ResultsTabs` collapse on solo Table views, `GridView` precomputed right-aligned numeric columns & column header hierarchy | WP-1 | `ResultsToolbar.tsx`, `ResultsTabs.tsx`, `GridView.ts`, `styles.css` | — | M | Pending |
| **WP-6** | Grouped calm Status Bar (no `Ready`/`Connected.` duplication, no 8 pipes, condensed clickable SQL status chip), live MB figure on `MemoryIndicator`, actionable `×` / `Close all` result release in Memory Popover | WP-1 | `App.tsx`, `QueryStatusBar.tsx`, `EditorStatus.tsx`, `MemoryIndicator.tsx`, `NerdMetrics.tsx`, `styles.css` | — | S–M | Pending |

Suggested waves: **WP-1** → **{WP-2, WP-3, WP-5, WP-6}** *(WP-2 and WP-3 rebase/sync on `metrics.ts` `--varia-documentTab: 40`)* → **WP-4**.

---

## Testing & accessibility strategy

- **Vitest (`npm run check`):** Every lane adds unit/DOM tests covering its new behavior (`RowSizes` outlier math,
  `44 px` `pinnedServerBands` rollover, per-tab `QueryBar` in split groups, `Execute↔Cancel` focus rescue, `Plan ▾`
  command parity, 2-bar vs 3-bar `ResultsTabs` `aria-labelledby`, `GridView` numeric class bits, Memory quick-free).
- **Smoke suites (`scripts/fixtures/ui.mjs`):** Because smoke suites locate controls by ARIA role and name, lanes that
  consolidate UI controls (`WP-2` inline Filter/Schema, `WP-4` `Plan ▾` menu & morph `Cancel`, `WP-5` progressive
  Whitespace/Sort popovers, `WP-6` condensed status bar) update affected smoke steps in the same PR and keep
  accessible names/shortcuts intact. Run `npm run test:smoke:wsl` on Linux for scrollbar, font-metric, and focus-ring
  parity on `WP-1`, `WP-2`, `WP-3`, and `WP-5`.
- **Benchmarks:** Run `npm run bench:grid` and `node scripts/check-bench.mjs` on **WP-5** to confirm zero regression on
  grid paint/scroll throughput.

---

## Open decisions before WP-1

None blocking — all decisions settled on 2026-11-23:

- **Resting borders:** **Approach B** (`#3a404d` Dark / `#c2c8d4` Light at rest, ≥ 3:1 on focus/hover) to avoid harsh
  1 px border aliasing; WP-1 updates `palette.ts`, `contrast-pairs.ts`, and `tests/theme-contrast.test.ts` accordingly.
- **Connection-color hairline + wash:** Strictly follows `connection.color` (`useConnectionAccent(color)`), neutral when
  unset.
- **Mock location:** Committed alongside this plan at [docs/mockups/workbench-polish.html](mockups/workbench-polish.html).
