# Data lists as grids: audit and plan

Status: proposal for the owner's review. Nothing here is built yet. Once the lanes ship, the rules move to
docs/architecture.md (Grid) and the area docs, and this file is deleted.

Mock: [docs/mockups/data-lists.html](mockups/data-lists.html) (Dark and Light, one scene per converted surface).

## Goal

Lists of data outside the query results (the Peek card's columns, Properties tables, SSIS property lists, Session Details)
are drawn as plain HTML today: nothing can be selected cell by cell, copied with headers, sorted or resized. They should
behave like the Results grid, limited to what makes sense for a small read-only list: cell, row and column selection,
Ctrl+A, Ctrl+C and Copy with Headers, keyboard navigation, column resize and Fit, header sort, the same context menu items
and, on persistent pages, Save Results As.

## What exists today

- `GridView` is the only grid. Its data comes from a backend result (`ResultHandle`): it calls only `getSnapshot`,
  `subscribe`, `getWindow`, `peekWindow`, `prefetch` and `measure` (plus `rowBytes`/`profile` for the row-size bar).
- Copy and Save text is formatted only by the C# `ResultTextWriter` (main streams it; `results.copy`/`results.export`).
- Only the live views (Activity Monitor panes, SSIS Operations, through `LiveGrid`) and Peek's Top rows (a results entry)
  use `GridView`. Every other table is HTML or custom divs. None offers copy, sort or column resize. Only SSIS
  `PropertiesList` and the plan outline are virtualized.

## Proposal: one local grid over `GridView`

A **local table** is a small immutable table the renderer already holds (from an IPC call, a live sample or static data).
It is never sent to the results pipeline as a result: no budget, no lifetime, no worker decoding.

1. **`LocalTable`** (`src/renderer/src/grid/local-table.ts`): columns `{ id, label, kind: 'text' | 'number' | 'flag' |
   'date' }` and rows of display text or null. Bounded at construction: 10,000 rows, 64 columns, 4,000 characters a
   cell (longer text is cut and flagged like a capped results cell), 4 MiB of text a table; past a bound it keeps the first
   rows and says so (`truncated`), as the surfaces' "There are more" notes do now. It implements the six handle members
   `GridView` reads, synchronously from memory, and `GridView`/`GridData` take that narrower type (`GridSource`), a typing
   change with no behaviour change for results.
2. **Sort in the renderer.** Header sort and multi-key sort reuse `sort-keys.ts`; a stable sort over a row permutation,
   numbers by value, text by `Intl.Collator` (base sensitivity, numeric). At 10,000 rows this is a few milliseconds, so
   there is no busy state. No filter funnels in the first lanes: the lists are short, and the surfaces that have a search
   box keep it.
3. **Copy and Save stay in `ResultTextWriter`.** A new bounded backend method `results.writeLocal` takes the columns, the
   rows and the copy plan's parts (the same `parts` as `results.copy`) and writes through `ResultTextWriter` over an
   in-memory page: Copy returns the text through main's copy path, Save goes through main's save dialog and the backend
   writes the file. The same limits as the table bound the request in zod and C#; it is added in the five places.
   Alternative for the owner: a TypeScript twin of the writer checked byte for byte against the shared goldens
   (`tests/fixtures/results-text/cases.json`, which the fake backend already passes). It works with the backend down but
   adds a second formatter to the invariant, so it is not recommended.
4. **One component, two presets.** `LocalGrid` (`src/renderer/src/grid/LocalGrid.tsx`) renders `GridShell` over a
   `LocalTable`:
   - `card` (hover Peek, Session Details, chart tables, Search Objects details): its height follows its rows up to 12
     then scrolls; no row-number column; no Save (the promoted Peek tab is a `page`).
   - `page` (Properties, SSIS properties, Client Statistics, plan comparison): fills its area; Save Results As.
   Both: selection, Ctrl+A, Ctrl+C, Ctrl+Shift+C, arrows/Home/End/PageUp/PageDown, Shift extend, column resize and
   double-click Fit, header sort, numbers right-aligned, the results grid's font, Compact row height and colours.
5. **Commands and menus are the results grid's.** A local grid registers a third output kind (`registerLocalOutput`, next to
   `registerLiveOutput` in `menus/targets.ts`) and sets `outputGridFocus`, so `output.copy`, `output.copyWithHeaders`,
   `output.selectAll`, `output.save` and the sort items run on it with the user's remapped keys, and the context menu shows
   only the items that apply (no Filter, Pivot, Profile, Transpose, Compare or Open Value). No new commands.
6. **Display text only.** A surface builds its table from the text it shows, so a masked value (an SSIS sensitive
   parameter) copies and saves masked; nothing that is not on screen can leave through Copy.
7. **States.** Loading, error and Retry stay the surface's own notes. An empty table shows the surface's existing empty
   message inside the grid frame (`role="status"`), so every list says "No …" the same way. The grid is `role="grid"`
   named "Columns, 14 rows, 4 columns" as results grids are.

Not converted: editable grids (Table Designer, New Database, Restore, object dialog pages, Shortcut Mapping, Extended
properties) keep their controls; trees (Object Explorer, plan outline, View Dependencies, server files) stay trees;
listboxes whose rows are actions (Search Objects hits, pickers, Peek Dependencies with Follow) stay listboxes; Messages is
a log; the column profile is cards; Release Notes and help samples are prose.

## Audit

Rows: today's cap. "Card" and "Page" are the presets above.

| Surface | Today | Rows | Recommendation | Lane |
| --- | --- | --- | --- | --- |
| Peek: Columns / Parameters tab (editor Ctrl+hover, Alt+F12, Explorer hover; Peek tab) | `<ul>` of icon, name, "(PK, int, not null)" | 1,024 | Card grid with real columns: Name, Type, Nullable, Key, Identity, Computed, Default (parameters: Name, Type, Direction, Default). Needs these as a Peek list from `explorer.peek` instead of the tree's sublabel. Page preset in the promoted Peek tab | LG-1 |
| Peek: list tabs (Index columns, Events, Files, Server roles, User mapping) | HTML table | 1,024 | Card grid (Page in the Peek tab) | LG-1 |
| Peek: Properties tab | `<dl>` | ~40 | Keep the layout; add Copy (selected or all facts as `Name<TAB>Value`) to its context menu | LG-1 |
| Peek: Dependencies (Uses / Used by) | `<ul>` with Follow | 200 + 200 | Keep: rows are Follow actions. Add Copy name | later |
| Search Objects details: Columns | `<ul>` | 500 | Card grid (Name, Type, Nullable, …) from the same Peek list | LG-2 |
| Activity Session Details: Waits, Transactions, Locks | HTML tables | 20 / 50 / 1,000 | Card grids | LG-2 |
| Table Properties: Permissions, Partitions, Security predicates | HTML tables | 1,024 / 1,000 / 256 | Page grids | LG-3 |
| Database Properties: Files, Filegroups (3) | HTML tables | 1,024 / 256 | Page grids | LG-3 |
| SSIS Properties: Packages, Parameters, References, Variables | virtualized HTML table | 2,048 | Page grids; sensitive values stay masked | LG-4 |
| Client Statistics | HTML table | ~20 | Page grid, no sort (rows are an ordered report); Copy with Headers is the main win | LG-5 |
| Plan comparison details | 2 HTML tables | ~60 | Page grids | LG-5 |
| Live chart "View as table" | HTML table | 120 | Card grid, re-sampled on each tick by swapping the table | LG-5 |
| Activity Monitor panes, SSIS Operations | `LiveGrid` | 10k-20k | Already the Results grid | none |
| Peek: Top rows | results entry | 10 | Already the Results grid | none |
| Plan operator outline | virtualized tree | 10,000 | Stays a tree; add Copy row (operator, cost, rows) | later |
| Plan properties, hover card, Peek facts | nested `<dl>` | 64 | Stay; plan properties get Copy value | later |
| Messages | log | ~1,028 | Stays a log; already has Ctrl+A and text selection | none |
| Table Designer, New Database, Restore, dialog pages, Shortcut Mapping, Extended properties | editable tables and custom grids | up to 4,096 | Stay editable. Later: Ctrl+C of selected rows as TSV through `results.writeLocal` | later |
| Search Objects hits, pickers, Connect history, Quick Input | listboxes | 200-1,000 | Stay listboxes (rows are actions); Ctrl+C copies the name already | none |
| Column profile, Release Notes, About, help samples, Memory "Biggest results", connection compare | cards, prose, tiny tables | < 10 | Stay | none |

## Lanes

Each lane has a vitest check and a smoke step (grid found by role and name through `scripts/fixtures/ui.mjs`: select
all, copy with headers, read the clipboard), docs and a CHANGELOG Unreleased line.

1. **LG-0 Local grid.** `LocalTable`, `GridSource` typing, `LocalGrid` with both presets, `registerLocalOutput`,
   `results.writeLocal` (five places, zod and C# bounds, a .NET check over the writer goldens), a test-only surface for the
   smoke. Architecture bullet in Grid. No user-visible change.
2. **LG-1 Peek.** Columns and Parameters as a Peek list with real columns (catalogue in `src/shared/explorer/peek.ts`,
   facts from `CatalogSql`), list tabs as grids, Copy in Properties. Peek smoke and docs/object-explorer.md.
3. **LG-2 Search details and Session Details.** Reuses LG-1's columns list; Activity smoke.
4. **LG-3 Table and Database Properties.**
5. **LG-4 SSIS Properties.** Replaces `PropertiesList`'s own virtualization; a check that a sensitive value copies masked.
6. **LG-5 Client Statistics, plan comparison, chart tables.**

LG-1 to LG-5 depend only on LG-0 and touch separate areas, so they can run in parallel once LG-0 merges.

## Questions for the owner

1. Copy and Save through the backend's `ResultTextWriter` (recommended), or a goldens-checked TypeScript twin?
2. Peek's Columns tab: real columns (Name, Type, Nullable, Key, Identity, Computed, Default; a small catalog change), or
   keep the tree's one "(PK, int, not null)" text in a single Details column?
3. Local grids in the results grid's font (consistent, recommended), or the UI font the lists use now?
4. Row numbers: off in local grids (recommended), or shown as in results?
