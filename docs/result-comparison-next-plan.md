# Result comparison, next round: plan

Status: draft for the owner. Nothing here is built. Mock: [prototypes/results-pane/compare-next-ux.html](../prototypes/results-pane/compare-next-ux.html)
(one scene per feature, Dark and Light). Where the mock and this plan disagree, this plan wins.

The comparison rework left eight features out of scope. This plan gives each a value proposition, a UX, a technical
sketch and a recommendation. It builds on:
- [results-tools.md § Comparisons](results-tools.md#comparisons) for shipped behaviour, including difference navigation
  and the overview strip (#673, which every lane waits for);
- [ipc.md § Result diffs](ipc.md) for the stored shape and limits;
- [architecture.md](architecture.md) for the invariants: the "Rows are compared only in the backend", Comparisons and
  Derived sets bullets.

It refers to them rather than repeating them.

**One run only.** A comparison reads two results of **one** run. So the jobs below are one-batch jobs:
- `SELECT …; UPDATE …; SELECT …`;
- the same query against two databases or a linked server in one batch;
- two versions of a query side by side.

Comparing with an earlier run is the commonest comparison job, and it gets a plan of its own next (N5).

## Summary

| # | Feature | Who it serves | Size | Recommendation | Lane |
| --- | --- | --- | --- | --- | --- |
| 1 | [Ignore columns](#1-ignore-columns) | Anyone whose results carry timestamps, GUIDs or row versions that always differ | M | **Build** | C2 |
| 2 | [Side-by-side layout](#2-side-by-side-layout) | People used to Beyond Compare or WinMerge | L | **Defer** (N4) | — |
| 3 + 7 | [Change details](#3--7-change-details-character-diffs-and-hover) (character diffs and hover, merged) | Long text, near-equal values, collation-only differences | M, + M for Compare Values in Tab | **Build** (N1, N8) | C5, C5b |
| 4 | [Copy as Diff](#4a-copy-as-diff) and [Script Differences as T-SQL](#4b-script-differences-as-t-sql) | Tickets, reviews, chat; repairing one copy of the data from the other | M and L | **Build both** (N2) | C3, C4 |
| 5 | [Search old values](#5-search-old-values) | Anyone searching a One row comparison | S | **Build** | C1 |
| 6 | [Compare rows as shown](#6-compare-rows-as-shown) | Comparing a slice; comparing results too big to compare whole | L | **Build** | C6 |
| 8 | [Compare Pivots](#8-compare-pivots) | Comparing aggregates within one batch | M | **Defer** (N4) | — |

Recommended order: C1 and C2 (in parallel), then C3 and C5, then C6, C4 and C5b. [Delivery](#delivery) and
[Coordination](#coordination-with-in-flight-work) give the dependencies.

## Owner decisions

Decided on 2026-11-22:

| # | Decision |
| --- | --- |
| N1 | Character-level diffs (3) and row hover (7) are **one feature**: a Change details card opened by hover or by key, with changed characters marked in the card, not in grid cells. |
| N2 | Copy as patch ships **both** forms: diff text (Copy as Diff) and a T-SQL sync script (Script Differences as T-SQL). |
| N3 | An ignored column stays **shown, muted**, its header marked "ignored". It can still be sorted and filtered. |
| N4 | Side-by-side layout and comparing Pivots are **deferred**: designs kept here, not in the build order. |
| N5 | Comparing with a result of an earlier run (cross-run comparison) gets **its own plan, next**. This round's jobs are one-batch jobs. |
| N6 | Script Differences opens in an **OS dialog window**, a new kind beside Options and About ([popout-windows.md § Dialog windows](popout-windows.md#dialog-windows)), after #680 moves Connect to one. |
| N7 | The new grid-menu commands go in a **Comparison** submenu, with the shipped Go to Next/Previous Difference and Go to Possible Match moved into it. |
| N8 | Compare Values in Tab (C5b) is kept, as **one reused tab**. |

Still open. Each has a recommendation, and the mock and sketches assume the recommendation:

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Should a comparison also save its Copy as Diff text to a file, with **Save as Diff…** beside Copy as Diff? It is diff-style lines, not a patch `git apply` reads, so the file is `.txt`, not `.diff`. | **Yes, as its own command.** A whole comparison is too big to copy. Save Results As cannot offer it as a file type: it takes the format from the chosen file's extension, and `.txt` is tab-delimited text. Save as Diff… opens the Save dialog with **Diff text (\*.txt)** and All Files, and writes diff whatever the extension. It follows the grid's sort and filters, as Save does. |
| Q2 | Should Script Differences check that each UPDATE and DELETE changes exactly one row (`IF @@ROWCOUNT <> 1 THROW`), on by default? | **Yes, on by default.** Under `XACT_ABORT` a missing or repeated target row rolls the whole script back. |
| Q3 | When values a script needs were truncated, refuse the script, or leave those rows out as comments? | **Refuse**, with the count and the column. A partial sync script is the dangerous outcome. |
| Q4 | Script Differences on BigQuery: GoogleSQL DML in C4, or SQL Server only for now? | **SQL Server only in C4.** On BigQuery the command is unavailable, with the hint "Script Differences writes T-SQL for SQL Server results only.", so the dialog never opens for one. GoogleSQL is a later lane (C4b). |
| Q5 | Scripts over 1,000,000 characters (a query window's execute limit): refuse them in C4, with Save to File (streamed, no cap) later? | **Yes.** C4 offers New Query Editor Window and Clipboard, both capped. Save to File follows with Q1's export path. |
| Q6 | The character diff runs in a renderer worker over one cell's two texts. Record it as an exception to "rows are compared only in the backend"? | **Yes.** It never matches rows, compares cells for equality or computes identities: which cells differ always comes from the backend (the tone, the change index, `partnerOf`). The alternative is a backend method for a display-only job. |
| Q7 | Change details on hover: on by default, with a setting? | **On, with `queryResults.compare.hoverDetails`** (default on). The key opens it either way. |
| Q8 | Show Change Details key: Ctrl+I (⌘I on macOS), only in a comparison's grid or card? | **Yes.** VS Code's Show Hover is the chord Ctrl+K Ctrl+I, but Varia's two-part chords work only in editor text (Monaco dispatches them), so a grid key must be one keystroke. Ctrl+I is free in Varia's catalogue, keeps the "I" for information, and ⌘I is Get Info on macOS. Monaco binds it to Trigger Suggest in editor text, so `monacoShadowAllowlist` gains an entry, as F4 has for the table designer's grid. |
| Q9 | A comparison of rows as shown going out of date: rebuild automatically like Pivots, or Update only? | **Update only.** A rebuild resets the comparison's sort, filters and scroll, which is more disruptive than a Pivot rebuild. |
| Q10 | A global "always ignore columns named …" setting (dbForge's mask) with C2? | **No.** Ignored columns are remembered per pair. Revisit if people ask. |

## What every feature shares

- **A comparison's options are its state**, changed only by `CompareService.replace`, in place.
  Ignored columns (1) and rows as shown (6) join layout, match, rows and Exact text. A change keeps the comparison's tab,
  number, widths and highlights, and resets its sort, filters and scroll. Its announcement is the shipped "Comparison
  updated: …" sentence, with no "was" figures.
- **Remembered per pair.** The match memory (the last 64 pairs of names, one way round, per tab) also keeps ignored
  column names (1) and the rows choice (6), each apart from the match: choosing Automatic forgets the remembered key
  columns (`CompareService`), but keeps the ignored columns. The popover shows what it reuses ("Ignoring: server_time
  (remembered)").
- **The Comparison submenu (N7).** `output.comparison`, declared in `src/shared/commands/menus.ts` like `output.filter`,
  is placed only in the grid menu (`output.context`, `when: outputGridComparison`) as **Comparison**, access key S (free
  there). It holds the comparison commands, with access keys of their own:
  - Go to Next Difference (N), Go to Previous Difference (P), Go to Possible Match (M);
  - Show Change Details (D), Compare Values in Tab (V);
  - Match Rows By… (R), Ignore Columns… (I), Ignore This Column (T, a checkbox);
  - Copy as Diff (C), Save as Diff… (A), Script Differences as T-SQL… (S);
  - Compare Rows as Shown (H, a checkbox), Update Comparison (U, shown only for a comparison of rows as shown).

  Moves and other placements:
  - The three shipped grid-menu items leave the top level. Go to Next Difference's access key changes from X to N.
    `keylessItems` in `tests/command-catalog.test.ts` loses Go to Previous Difference and Go to Possible Match.
  - More results tools (`output.tools`) gets no submenu: it is already the comparison's toolbar folded away, so a second
    level would hide what a narrow pane folds. Ignore Columns… joins its `5_compare` group after Match Rows By…, since
    the Ignore button folds there. The other new commands go in a new group after it, `6_compareActions`. It has only
    j, k and q free, so these are keyless (arrows and type-ahead, as Pivot Results… is in the grid menu), except Script
    Differences as T-SQL… (Q). Go to Next and Previous Difference stay where #673 put them.
  - Toolbar buttons and the palette keep their own entries.
  - `tests/command-catalog.test.ts` (its `keylessItems` for both menus) and `results-smoke.mjs`'s grid-menu steps follow
    the move.
- **Engine-neutral.** Commands, context keys and settings declare both providers, except Script Differences (Q4).
  Result-naming methods are declared for both engines in `methods.ts` and checked in C#. New protocol members are optional
  fields of existing v2 shapes, and C4's one new method is offered through HELLO as every method is, so the protocol
  stays v2.
- **Every protocol change follows the results path.**
  - Results requests travel renderer → results worker (`worker-protocol.ts`, `ResultClient.ts`, and `worker-core.ts`,
    which rebuilds each port request member by member) → the strict port schema (`src/shared/ipc/port-messages.ts`) →
    main's `results-port.ts`, which checks `ResultsPortHost.owns` and copies the request member by member → C#
    (`Contracts.cs`, `SqlService`).
  - Answers come back through a strict answer schema in `port-messages.ts`.
  - Copy and Save are main-only jobs (`varia:results-copy`, `varia:results-save`, `src/main/validation.ts`); main's
    `results-jobs.ts` builds their backend params.
  - A member added at one step and not the next is refused or silently dropped, so each lane names every step.
- **The fake backend** (`tests/fixtures/backend.mjs`, which smoke runs against) implements each change, or the smoke step
  moves to the real-server part. Its copy and save use the TypeScript text writer, which today writes no `(old)` columns
  for a comparison and never sees a cut tone, so C3 first brings it level with C#.
- **Inputs closed.** Features that read only the comparison work while an input is closed: Change details (except a soft
  cell's old value, below), Copy as Diff, Save as Diff, Script Differences, Search. Features that re-run it (Ignore,
  Compare Rows as Shown, Update) are unavailable and say which input is closed, as Match is.

## 1. Ignore columns

### Value proposition

- **Job:** compare two results whose output has columns that always differ: `GETDATE()`, `NEWID()`, `rowversion`,
  `modified_at`, a server name. Examples are `SELECT …; UPDATE …; SELECT …` in one batch, or the same query over two
  databases.
  - Today such a column marks every row changed, so the counts and navigation are noise, and Whole rows matching pairs
    nothing.
  - Automatic matching often picks the noise column itself as its key, because a `datetime2(7)` or GUID column is unique
    on both sides. Then nothing pairs.
  - The owner's own sample hit exactly this (`server_time`).
- **Who and how often:** anyone comparing before and after a change, in most comparisons of real tables, since audit
  columns are common.
- **Elsewhere:**
  - SSMS has no result comparison; its only compare is Compare Showplan [S1].
  - Redgate SQL Data Compare drops columns through a per-table "Columns in Comparison" checklist, and key columns cannot
    be dropped [R1].
  - dbForge separates **Compare** from **Sync** per column, and can ignore columns by wildcard mask [D1, D2].
  - Beyond Compare marks a column **Unimportant**: its differences show in another colour and can be ignored [B1, B2].
  - DataGrip has no per-column exclusion, only a tolerance for how many columns may differ [J1].

### UX

- **Where:**
  - an **Ignore** button on the comparison toolbar after Match, reading "Ignore (2)" when any are ignored;
  - **Ignore Columns…** in the Comparison submenu and the palette ("Ignore Columns in Comparison…");
  - **Ignore This Column**, a checkbox in the Comparison submenu of the grid menu opened on that column's header or a cell
    (`comparisonColumnIgnored`, scope `target`). It is unavailable, with the reason as its hint, on a key column under Key
    columns ("Matched by: cannot be ignored") and on the last compared column ("Compare at least one column").

  From More results tools or the palette, the checklist opens beside ⋯, as Match does.
- **The checklist** is the Match menu's: the paired columns with their types, searchable, arrows to move, Space to tick,
  Apply or Cancel. A ticked column is ignored.
  - Under **Key columns**, the key columns are listed but unavailable ("Matched by: cannot be ignored").
  - Under **Automatic**, the chosen key is tickable, labelled "Chosen automatically: ignoring it matches rows another
    way". Rows are matched again without it: by another key, or by whole rows when none is left.
  - Ignoring every column is refused ("Compare at least one column"). Under Key columns that cannot happen, since the
    keys stay.
  - Columns left out by pairing are not listed.
- **In the grid (N3):**
  - The header text is muted, with the new `eye-closed` icon and a small "ignored" in place of the type. The tooltip and
    screen-reader name say "Ignored".
  - Cells show the entry's value: the new side's, or the old side's on a removed row. In Two rows each half shows its own
    side's value. The text is muted and untinted, and in forced colours `GrayText` with the header icon.
  - It is never counted, never underlined as "Has changes", never landed on by Go to Next Difference and never in the
    overview strip.
  - It can be sorted, filtered, searched and profiled. Its Column Profile card says "Ignored".
- **Matching:**
  - Whole rows compares only the compared columns, so ignoring `server_time` makes whole-row matching work again.
  - Automatic never chooses an ignored column.
  - Look-alike rows (?) are judged on compared columns only.
  - The Match menu lists ignored columns as unavailable ("Ignored: stop ignoring it to match by it").
- **Notices:**
  - One notice: "server_time is ignored." ("2 columns are ignored: server_time, row_ver."), with **Stop ignoring** and
    Dismiss.
  - The wording stays apart from the shipped "columns not compared" notice, which names columns that did not pair and are
    absent from the grid. When both show, "not compared" comes first.
  - The strip adds "1 column ignored".
- **States:** a change shows the results toolbar's progress and Cancel. A failure leaves the comparison as it was, with
  the reason on its strip.
- **Narrow panes:** Ignore folds into More results tools just before Match. The fold order becomes Exact text, Layout,
  Rows, Ignore, Match, the sides, Profile, Save.
- **Interactions:**
  - Rows (Changes only) and the chips follow the new counts. A chip whose kind is left with no rows is released.
  - Exact text does not apply to ignored columns.
  - Save writes ignored columns as data. In One row their `(old)` columns are empty; in Two rows each half of a changed
    row writes its own side's value. A row whose only differences are in ignored columns is unchanged, so it shows and
    saves the new side's value.
  - Copy as Diff leaves them out and adds `ignored: …` to its `# rows matched by` header line.
  - Script Differences INSERTs them but never SETs them.

### Technical sketch

- **Protocol:** `results.diff` gains `ignore?: number[]`, distinct pair indexes, at most `limits.page.maxColumns` of
  them, each below it. It goes through every step of the results path:
  - `ResultsDiffParams` (contracts.ts);
  - `ResultClient.diff` and the worker request;
  - the port's diff request schema;
  - main's member-by-member copy in `results-port.ts`;
  - `Contracts.cs`;
  - the fake backend.

  It also goes through `worker-core.ts`'s member-by-member rebuild. The backend refuses an index not below the pair
  count, an ignored key of a `columns` match, or every pair ignored, with `INVALID_PARAMS` and the sentences above. The
  answer is unchanged: the renderer knows the names.
- **Stored shape:** an ignored pair stays a data column. Its descriptor column gets `ignored: true`, a new optional
  member of `ResultColumn`. `CompareService` knows the names, but `GridView`, the results worker and Save read a
  comparison's columns only from its descriptor, as they read the hidden roles, so the flag travels there rather than
  through a side channel. It goes in:
  - the strict descriptor schema (`src/shared/ipc/descriptors.ts`);
  - contracts.ts and Contracts.cs;
  - main's descriptor copy.

  In the `entry` layout every pair keeps its previous-value column (dense indexing at `old + pair` is read by
  `hidden-columns.ts`, `GridView`, `UnifiedDiff.Previous`, `ResultJobs` and `ResultTextWriter`). An ignored pair's column
  is NULL throughout. The one-row limit and `maxEntryPairs` are unchanged.
- **Backend:**
  - `ResultDiffer.Compare` takes the compared pair set. Whole-row identity hashes compared pairs only.
  - Auto's candidate loop skips ignored pairs, and `LookAlikes` scores compared pairs only.
  - Cell diffs, tones and the change index skip ignored pairs.
  - `columnChanges` stays one entry per pair, with zeros for ignored pairs, since `GridView` indexes it by data column.
- **Renderer:**
  - `CompareService` keeps `ignore` in the comparison's options. The pair memory keeps it by name, and
    `compare-pairing.ts` maps names to pairs as it does for key columns.
  - `GridView` mutes `ignored` columns through a header class and a column class read once per column.
  - The notice joins `CompareNotice`.
- **Catalogues:**
  - commands `output.compareIgnoreColumns` (toolbar, the submenu, More results tools' `5_compare`, palette) and
    `output.compareIgnoreColumn` (the submenu, `toggled: comparisonColumnIgnored`). C2 also declares the submenu, moves
    the three shipped items into it and adds Match Rows By… to it;
  - context keys `comparisonColumnIgnored` and `comparisonColumnIgnorable` (scope `target`; false on a key column under
    Key columns and on the last compared column), the second as Ignore This Column's `precondition`, with its reason as
    the hint;
  - icon `eye-closed` in `src/shared/icons.ts`.

  Regenerate the commands and icons docs. No setting.
- **Budget:** unchanged rows and old columns. Ignored cells are never charged as changed cells.
- **Tests:**
  - `DiffChecks`:
    - an ignored pair is never in a tone, `columnChanges` or the change index;
    - Automatic falls back to whole rows when its only unique column is ignored;
    - rows equal except for an ignored column match as `same` under Whole rows;
    - Auto skips an ignored unique column;
    - the refusals;
    - an ignored pair's old column is NULL throughout;
    - Save writes it.
  - vitest:
    - the checklist (`compare-ignore.test.ts`), Automatic's label, memory by name across a swap;
    - the toggle's `when`, notice text and Dismiss;
    - the fold order (`results-toolbar-fold`), the submenu in `command-catalog`.
  - The fake backend implements `ignore`. Smoke (`results-smoke.mjs`): ignore `updated_at` from the toolbar, check the
    counts and the header's name by role, then Stop ignoring. The suite's steps that click the grid menu's top-level Go
    to Next Difference and Go to Possible Match open the Comparison submenu instead.
- **Risks:** a remembered ignored column that no longer pairs is dropped, and the popover says so ("server_time is not in
  these results, so it is not ignored").

**Size M. Build: lane C2.**

## 2. Side-by-side layout

### Value proposition

- **Job:** read old and new as two whole rows facing each other, as file-diff tools show text.
- **Who:** people coming from Beyond Compare, which shows two grids side by side or over-under, scrolling together [B3],
  or from text-diff tools.
  - VS Code's diff editor offers Inline, Side by Side or Automatic, switching to inline below 900 px
    (`diffEditor.renderSideBySideInlineBreakpoint`) [V1, V2].
  - DataGrip's diff viewer has side-by-side and unified modes [J2]. Which one its data diffs use is unverified.
  - Redgate and dbForge use one grid with paired columns [R3, D3]. SSMS has none.
- **How often:** a preference more than a need. One row already shows old → new in each changed cell, and Change details
  shows long values whole.

### UX (deferred design)

- A third **Layout**, **Side by side**: the old side's values in a left grid and the new side's in a right grid, with the
  gutter between them. Added rows leave hatched filler on the left, removed rows on the right. Vertical scroll is locked,
  horizontal scroll follows, and selected rows are shared.
- Below about 900 px it falls back to One row, as VS Code does, and the toolbar says so.
- Left and Right cross between the grids at their edges, and the active cell's name gains "old side" or "new side".
  Copy copies from the focused side.

### Technical sketch

- **No backend change:** it draws the `entry` stored shape. Left cell p reads `old[p]` where the tone lists p as changed,
  else `data[p]`, and right reads `data[p]`.
  - Soft cells have no old value stored, so the left side shows the shown value, underlined.
  - A removed row is left only, an added row right only.
- **Renderer:**
  - `GridView` gains a column-source map, so a drawn column can be read from one of two stored columns by row.
  - Two `GridView`s share one data source, selection model and scroll.
  - Copy, search hits, highlights, navigation and screen-reader naming each need a side.
- **Risks:** it doubles the width in the panes that are already narrow. Two coordinated pools are new to the grid lint.

**Size L. Defer (N4).** Revisit after Change details ships if people still ask.

## 3 + 7. Change details: character diffs and hover

### Value proposition

- **Jobs:**
  - see **which characters** changed in long text (notes, JSON, SQL text, paths), in values that differ only near the end
    (`…03.0483545` vs `…03.0483546`), and in collation-only differences (case, trailing spaces);
  - see **whole values** where the cell's width cuts them off;
  - see **why a ? row** looks like its partner.
- **Who and how often:** often for text-heavy results, now and then for others. It is what One row's `old → new` cannot
  show once a value is long.
- **Elsewhere:**
  - No data-compare tool documents character diffs in a grid cell, or a hover showing the other side's value.
  - Redgate and dbForge highlight whole cells, with a separate viewer for full values [R3, D3].
  - Beyond Compare has a Text Details pane. Whether it marks characters is unverified [B4].
  - DataGrip's diff viewer highlights words or characters in text diffs [J2], which is not documented for data diffs [J1].
  - VS Code's Accessible Diff Viewer (F7) lists changes for screen readers [V1], the precedent for the keyboard path below.

### UX

- **Opening the card:**
  - **By mouse**, it opens after the platform tooltip delay, on a changed or soft cell or on a gutter's **?** flag. It
    closes when the pointer leaves the cell and card, or on Escape (WCAG 1.4.13), which closes the card before it cancels a
    copy or save. Over that cell it replaces the grid's own tooltip and repeats the tooltip's truncation sentence.
  - **By key**, **Show Change Details** (Ctrl+I, ⌘I on macOS; Q8), the Comparison submenu or the palette opens it
    on the active cell. It is available on any comparison cell; cells with nothing to mark open the short cards below.
  - The card is a non-modal dialog that does not take focus. Opened by key, it stays open, and the live region says its
    summary: "Change details: note, 2 edits: '9' became '10'. Tab to read it, Escape to close." The active cell gets
    `aria-details` pointing at it. Tab moves into it, and Escape closes it, returning focus to the cell.
- **Follow mode** (opened by key): the card follows the active cell.
  - Alt+F5 and Alt+Shift+F5 work from the grid or the card: their `when` gains `comparisonDetailsFocus`.
  - Each move gives one live message: "Change 2 of 31: note, 2 edits: '9' became '10'…". A "change" is a navigation
    unit and an "edit" a run of characters, so the two words never share a sentence's meaning.
  - Follow mode ends on Escape, on focus leaving the grid and card, or on a replace of the comparison.
- **Card content:**
  - A header: column, type, "changed" or "equal by collation", and "row 4 in Result 1 → row 4 in Result 3".
  - A summary sentence, the card's first line ("2 edits: '9' became '10'; ' Rush' was removed at the end").
  - **− Old** and **+ New**, each the value up to 4,000 characters, wrapped in the mono font:
    - deleted text is struck through on a red tint, inserted text bold on a green tint (outlined in forced colours);
    - runs are found word-first, then by character, so a changed word reads as one edit;
    - NULL shows as italic NULL, an empty string as "(empty)", trailing spaces (only) as dots;
    - a soft cell names its collation and what differs ("differs only in case").
  - A footer: "2 edits · 41 → 42 characters", "Showing 4,000 of 65,535 characters" when cut, and **Compare Values in
    Tab** (C5b) on text, XML and JSON cells.
- **On a ? row:** Show Change Details on any of its cells, or hovering its gutter flag, opens the **look-alike card**:
  "Looks like row 9 in Result 3: 4 of 5 compared columns equal", the values that differ, each old → new with marks, and
  **Go to Possible Match**. Ignored columns are not counted. Which values differ comes from the backend, which judged the
  look-alike. A partner hidden by the comparison's filters or chips is still described, with "Row 9 is hidden by the
  filters" in place of Go to Possible Match. The gutter's own tooltip stays everywhere else.
- **Opened by key elsewhere,** the card says what there is:
  - an added or removed row: "Added row: only in Result 3";
  - an ignored column: "This column is ignored";
  - an unchanged cell: "Unchanged";
  - a cell past a cut tone: "More changes in this row are not listed", as the gutter says.

  Hover never opens these.
- **States:** "Reading…" while the values load (the read's deadline, then its error). A value too long or too different to
  mark shows unmarked ("Too many differences to mark: compare them in a tab"). The comparison closing closes the card.
- **Narrow panes:** min(560 px, the pane less 16 px) wide, at most 60% of the pane tall, scrolling. Under 360 px it takes
  the pane's width.
- **Interactions:**
  - One row: the card is on the cell. Two rows: either half's cell, showing both halves.
  - Chips, Rows and filters do not change it. Highlights and search hits stay in the grid.
  - Exact text off: soft cells open as "equal by collation".

### Technical sketch

- **No protocol change for the values themselves.** Values come through the results worker's whole-cell read
  (`ResultHandle.getCell`, as Open Value in New Tab uses), which gains a `maxChars` option.
  - The card reads at most 100,001 characters a side; Compare Values in Tab reads whole values.
  - The **new value** is the data column at the grid's position.
  - The **old value** depends on the cell:
    - One row, changed cell: the hidden previous-value column at `old + pair`, in the same row.
    - One row, soft cell: no old value is stored. It is read from the old input's cell (its stored row from the gutter's
      `leftRow`, through the input's own handle) while the input is open. Otherwise the card says "The old value is not
      kept (Result 1 is closed)".
    - Two rows: the other half. A sort or filter can separate the halves, so the card identifies the comparison's rows
      once (`results.identify` with `row`, cheap for a diff since the identity is its `leftRow`/`rightRow` columns), then
      asks `results.rowIds` for the active row's entry identity and `results.findRows` on the comparison's base result
      for both halves' stored positions, and reads them through the base handle.
  - A look-alike card reads the partner through `results.diffSeek { partnerOf }`. Its answer gains `differing?:
    number[]` (the pair indexes whose values differ, ascending, each below the pair count) and `compared?: number`, as
    `LookAlikes` already scored them. The renderer compares no cells, so collation and soft equality stay the backend's.
    The answer's `hidden` case gives the hidden-partner sentence. Both members go through every results-path step.
  - Window reads already serve hidden columns, since the gutter reads them.
- **Diff worker** (`results/value-diff.worker.ts`, as `plans/comparison.worker.ts` is for plans):
  - Myers O(ND) over word tokens, then characters inside changed tokens.
  - Bounded: 100,000 characters a side, an edit distance of at most 2,000, and 50 ms. Past any bound it answers "too
    different".
  - A newer request aborts the older one.
  - architecture.md's "Rows are compared only in the backend" bullet gets one sentence naming this display-only exception
    (Q6).
- **Card:** one React component in `GridShell`, outside the grid's pools, placed from a new `GridView.cellRect(row,
  column)`.
  - Escape with the focus in the grid reaches the card through `GridView`'s existing `onEscape` hook: `ResultGrid` closes
    an open card first, else cancels the tab's copy or save. Inside the card, Escape is the card's own `onKeyDown`, as
    in the Compare popover. Neither adds a key listener (`tests/keyboard-lint.test.ts`).
  - Hover comes from the grid's existing pointer handling through a debounced `onCellHover`, with no per-cell listeners.
  - The read waits for the hover delay and is cancelled on leave.
  - Marked text renders as spans in the card, which is not the grid, so the grid lint's nodeValue rule is untouched.
  - `aria-details` is set on the active cell element while the card is open.
- **Compare Values in Tab (C5b, N8):** one reused read-only document, "Compare Values".
  - A new document kind `valueDiff` hosts `monaco.editor.createDiffEditor`.
  - Each use replaces its two texts (each at most 2,097,152 characters, held in renderer memory) and brings it forward,
    so memory is bounded at one pair.
  - Its tab reads "Compare Values". Its tooltip and header name the column, both rows, both results and the query
    document, since the tab is shared by every query document ("Compare Values: note, row 4 in Result 1 → row 4 in
    Result 3 (SQLQuery3.sql)"). Its toolbar has **Inline** / **Side by side**: standalone Monaco has no toggle of its own,
    so Varia sets `renderSideBySide`, with `useInlineViewWhenSpaceIsLimited`.
  - It holds a snapshot: closing or replacing its comparison leaves it as it is, until the next use replaces it.
  - It is not saved, and is left out of hot exit's session and recovery records. It needs no connection.
  - Wiring: the document registry, `icons.ts`, `start.tsx`'s reviewed imports for the diff editor (regenerate
    `monaco-keybindings`), and Close and Close Others.
- **Catalogues:**
  - commands `output.compareChangeDetails` ("Show Change Details", `mod+i` when `(outputGridFocus ||
    comparisonDetailsFocus) && resultsGridComparison`; the submenu with `when: outputGridComparison`) and
    `output.compareValuesInTab` ("Compare Values in Tab", C5b);
  - Alt+F5 and Alt+Shift+F5's `when` gains `|| comparisonDetailsFocus`;
  - context key `comparisonDetailsFocus`. Whether hover opens a card is read from the tone by the grid, not a context
    key, since the command itself works on any comparison cell;
  - setting `queryResults.compare.hoverDetails` (boolean, default on);
  - the `monacoShadowAllowlist` entry for `mod+i` (Trigger Suggest in editor text), and regenerated commands and
    settings docs.
- **Tests:**
  - vitest:
    - the worker: word then character runs, bounds, abort, soft cells, NULL and empty, trailing spaces;
    - the card: follow mode, its end conditions, Escape (by key and on hover) and focus return, the opening announcement,
      the combined live message, the key-only states reached from the menu, the look-alike card;
    - old-value sources: One row changed, One row soft (input open or closed), Two rows sorted apart (identified first);
    - the look-alike card from `differing`, and its hidden partner;
    - the hover debounce and the key's `when`.
  - `DiffChecks`: `partnerOf` answers `differing` and `compared`, skipping ignored pairs.
  - Smoke: Ctrl+I finds the dialog by role and name, Alt+F5 updates it, Escape returns focus. C5b opens the tab by
    role and replaces it on a second use.
- **Risks:**
  - Hover noise: the delay, changed and soft cells only, and a setting.
  - A user's own shortcut on Ctrl+I: ShortcutsService reports conflicts.

**Size M** (card, worker, command), **+M for Compare Values in Tab. Build: lanes C5 and C5b.**

## 4a. Copy as Diff

### Value proposition

- **Job:** paste what changed into a ticket, a code review, chat or a commit message, in a form people already read:
  lines marked `-` and `+`. Today Copy writes only data columns, and the marks are lost.
- **Who and how often:** anyone reporting a comparison's outcome, often.
- **Elsewhere:**
  - Beyond Compare writes table compare reports (interleaved, side-by-side or summary) as text or HTML [B5].
  - VS Code's Accessible Diff Viewer shows unified hunks [V1].
  - Redgate and dbForge report or script, not diff text [R4, D4]. SSMS has none.

### UX

- **Where:** **Copy as Diff** in the Comparison submenu, More results tools and the palette. It copies the selected
  rows: any selected cell takes its entry, both halves in Two rows. It copies the selected columns, with key columns
  always included so each line identifies its row.
  - Without key columns (Row position, Whole rows, or Automatic that fell back to whole rows), each line instead starts
    with its row's stored number in its own input, the gutter's number (`-4`, `+4`), and the header names the match and
    says so (`# rows matched by whole rows; lines start with row numbers`).
  - **Save as Diff…** (Q1) writes the same text for every row the grid shows to a file.
- **Text:**

  ```
  --- Result 1 (Orders Mon)
  +++ Result 3 (Orders Tue)
  # rows matched by id; ignored: updated_at
  # id	customer	status	amount	note
  -1002	Contoso Ltd	Open	310.50	Rush delivery, call before 9 am
  +1002	Contoso Ltd	Shipped	310.50	Rush delivery, call before 10 am
  @@ rows not copied @@
  -1004	Adventure Works	Open	5120.00	Net 30, invoice to head office
  +1004	Adventure Works	Open	4980.00	Net 30, invoice to the head office
  ```

  - Each line is a prefix (`-`, `+`, or a space for unchanged), then tab-separated values.
  - Values escape `\`, tab, CR and LF as `\\`, `\t`, `\r` and `\n`. NULL is `NULL`, and a text value that is exactly
    `NULL` is `\NULL`.
  - A changed entry is a `-` line and a `+` line:
    - In **Two rows**, each line is that half's own values.
    - In **One row**, the `-` line takes the previous value where the tone (or, past a cut, the change index's bitset)
      lists the cell as changed, and the shown value elsewhere.

    So both layouts write the same text for changed cells. Unchanged cells written differently (2.0 against 2.00) may
    differ, and so may soft cells: One row stores no old value for them, so its `-` line shows the shown value.
  - **Skipped rows:** in stored order (no sort, filter or chip), a run of unchanged rows left out under Changes only is
    `@@ 312 unchanged rows @@`, from the `gap=` flags. Anywhere else, two copied rows that are not next to each other in
    the grid get `@@ rows not copied @@` between them.
  - Line endings follow Copy's (CRLF on Windows).
- **States:** unavailable outside comparisons. Over Copy's size limit it says "The selection is too large to copy (more
  than 64 MB). Use Save as Diff… instead." Progress and Cancel are Copy's and Save's. It works while an input is closed.
- **Screen readers:** "Copied 2 rows as a diff" in the results live region. A changed row counts once in both layouts,
  as One row draws it, though it writes two lines.

### Technical sketch

- **Protocol** (no new method):
  - `results.copy` gains `format?: 'tsv' | 'diff'` (default `tsv`), and `results.export`'s `format` gains `'diff'` (Q1).
  - They change in `resultsCopyRequestSchema` and `resultsSaveRequestSchema` (`src/main/validation.ts`), the preload
    signatures (`copyResults`, `saveResults`), the params `results-jobs.ts` builds (`ResultsCopyParams` and the export's)
    and the C# records.
  - `ResultsFormat` gains `diff`, so `exportDefaults.nullText`, `extensions`, `filters` and the local-save types gain
    entries; a local table refuses it.
  - Save as Diff… asks main's save job for format `diff`. Its dialog offers only "Diff text (\*.txt)" and All Files, and
    the format stays `diff` whatever extension is chosen: `chooseFile` (`src/main/results-jobs.ts`) reads the format from
    the extension (`formatFromPath`) only for Save Results As. A diff save does not become Save Results As's remembered
    last format.
  - `diff` on a result that is not a comparison is `INVALID_PARAMS`.
- **Backend:** `ResultTextWriter` gains the `diff` format.
  - It maps view positions to stored rows. A changed entry's halves are adjacent stored rows (`changedOld` at s,
    `changedNew` at s + 1), so a sort that separates them still writes both lines once, at the first half met.
  - It reads `mark`, the tone, the previous-value columns and, for a cut One row entry, the change index's changed-pair
    bitset.
  - It writes headers, prefixes and the skip lines.
  - The copy estimates (`EstimateCopyRows`, `EstimateCopyCells`, `EstimateHeader`, `ResultJobs.EstimateCopy`) count both
    lines of an entry and escapes.
- **The TypeScript twin** (`src/shared/results/text-writer.ts`) implements `diff` too, because the fake backend's copy
  and save use it. Local tables never ask for it.
  - First it catches up with C#: its `savedColumns` writes no `(old)` columns for a comparison, where C#'s
    `SavedColumns` does.
  - It passes the shared goldens, except those for a cut tone, which stay C#-only because the fake backend never cuts
    one.
- **Catalogues:** commands `output.copyAsDiff` and `output.saveAsDiff` (the submenu with `when: outputGridComparison`,
  More results tools' `6_compareActions`, palette). Regenerate the commands docs.
- **Tests:**
  - shared goldens for both writers:
    - both layouts give the same changed cells, sorted Two rows halves are paired;
    - gap and skip lines, cut rows;
    - NULL against the text `NULL`, escapes;
    - ignored columns, forced key columns, row-number prefixes without keys, CRLF and LF;
  - the refusal on a non-comparison;
  - `results-jobs`: Save as Diff to `orders.txt` writes diff, and leaves the remembered last format alone;
  - smoke: a clipboard read-back through the fake backend (needs an unlocked screen).
- **Risks:** low for the format, which changes nothing existing. Bringing the TypeScript writer level touches the fake
  backend's comparison Save, which smoke reads.

**Size M** (the format, Save as Diff…, and the TypeScript writer's catch-up). **Build: lane C3.**

## 4b. Script Differences as T-SQL

### Value proposition

- **Job:** make one copy of the data match the other without writing the statements by hand.
  - In one batch: `SELECT … FROM prod_copy.dbo.Orders; SELECT … FROM dbo.Orders`.
  - Or a table before and after a bad `UPDATE`: `SELECT …; UPDATE …; SELECT …`, then script it back.
- **Who and how often:** DBAs and developers repairing data. Less often than reading a diff, but each time it saves real
  work and typing errors.
- **Elsewhere:**
  - Redgate generates a deployment script for chosen rows, reviewed before running [R4].
  - dbForge scripts tables, but its custom-query comparisons cannot be scripted [D4].
  - Beyond Compare copies values left or right [B4]. DataGrip's SQL from a data diff is unverified [J1]. SSMS has none.

  Varia compares **results**, not tables. So the user names the target table, and the script is text to review, which
  Varia does not run.

### UX

- **Where:** **Script Differences as T-SQL…** in the Comparison submenu, More results tools and the palette. It opens an
  **OS dialog window** (N6): kind `scriptDiff`, titled "Script Differences as T-SQL · Result 1 → Result 3", 640 × 600 by
  default, at least 520 × 440, size remembered as Options' is, modeless. One is open at a time, as Options is.
- **The form:**
  - **Target table:** `[database.]schema.table`, each part 1 to 128 characters. Empty the first time, with suggestions
    from Search Objects' index for the comparison's connection; after that, the pair's remembered draft. It warns, never
    refuses, when the index lacks the table or a column, or marks a ticked column computed or identity.
  - **Direction**, naming the target as typed:
    - "[dbo].[Orders] holds Result 1's rows: change them to Result 3's" (default);
    - "[dbo].[Orders] holds Result 3's rows: change them to Result 1's".

    The script is written for the chosen direction, and the comparison is not swapped.
  - **Statements:** DELETE (n), UPDATE (n) and INSERT (n), each a checkbox with its count for the direction.
  - **Columns:** the data columns.
    - Key columns are ticked and locked. Ignored columns are ticked, for INSERT only.
    - Unscriptable columns start unticked with the reason: rowversion and timestamp ("Not insertable"), computed per the
      index ("Computed"), CLR types, sql_variant and vector ("Cannot be written as a literal").
    - A line names columns only one result has ("note2 is only in Result 1, so INSERTs leave it out").
    - Identity: when the index says a ticked column is the target's identity, **SET IDENTITY_INSERT** is offered, ticked.
      An identity column is never SET, since SQL Server refuses that: when one that is not a key changed, a line says
      "id is an identity column, so its changes are not scripted".
    - With Exact text off, values that differ only by collation are equal to the comparison, so they are not scripted. A
      line says so when there are any: "12 values differ only by collation and are not scripted. Turn on Exact text to
      include them."
  - **Rows:** All differences, Rows shown (chips and filters) or Selected rows, each with its count. Selected rows is
    unavailable while nothing is selected. They are read when you press Script.
  - **Options:** Wrap in a transaction (on), Check each statement changes one row (on; Q2). Turning off the transaction
    with the checks on warns "Without a transaction, statements before a failed check stay applied."
  - **Destination:** New Query Editor Window (default) or Clipboard.
  - A **preview** of the first 30 lines, a summary beside Script ("Deletes 2, updates 5 and inserts 2 rows in
    [dbo].[Orders]."), and **Script** and **Cancel**.
- **The script:**
  - A header comment names the comparison, the match, the direction and the time, and says "Review it before you run
    it. Varia does not run it for you."
  - Then `SET XACT_ABORT ON;` and `BEGIN TRANSACTION;`.
  - DELETEs, then UPDATEs, then INSERTs, so a reused key cannot collide.
    - One statement per row, keyed by the match's key columns, NULL-safe (`[k] IS NULL`).
    - An UPDATE SETs only changed, compared, ticked columns, never an identity column.
    - Each UPDATE and DELETE is followed by `IF @@ROWCOUNT <> 1 THROW 50000, N'Row id = 1002 was not found exactly
      once.', 1;`, with the key text cut to 200 characters.
  - `COMMIT TRANSACTION;`.
  - The New Query Editor Window opens on the comparison's connection, as Script As does, and does not run.
- **Generating:** the dialog shows progress, and Cancel stops it. A failure shows its sentence in the dialog.
- **Refused, with the reason in the dialog.** The first is known when the dialog opens; the rest are found on Script,
  and Script is available again once the form changes:
  - rows not matched by key (Row position, Whole rows, or Automatic that fell back to whole rows), with **Choose key
    columns…**;
  - chosen rows with a repeated key (≈): "12 rows share a key, so a statement could change several rows";
  - a needed value truncated, or compared by its stored part: "3 values in note were not kept in full" (Q3);
  - a needed value the script text cannot carry exactly: a lone surrogate (the answer is MessagePack text, where it
    would become U+FFFD), or a `_UTF8` char value that may hold U+FFFD for bytes SqlClient could not decode
    (`CellLengths`): "2 values in note cannot be written exactly";
  - no differences in the chosen rows;
  - over 1,000,000 characters, a query window's execute limit: "The script would be about 2,400,000 characters. A query
    window runs at most 1,000,000. Choose fewer rows." (Q5).

  On BigQuery the command is unavailable, so the dialog never opens (Q4).
- **While it is open:**
  - A replace of the comparison refreshes the counts and keeps the draft.
  - The comparison closing (re-run, Close Results, backend loss) says "The comparison was closed." and disables Script.
  - The draft (target, direction, columns, options) is remembered per pair in the tab.
  - Invoked from another comparison, the open window switches to it, with that pair's draft; the first pair's draft stays
    remembered.
  - It works while an input is closed: the script reads only the comparison.
- **Keyboard and screen readers:** a labelled form in its own window, Tab order top to bottom. Enter picks a suggestion
  while the target's list is open, and presses Script otherwise. Escape, the close button, Alt+F4 or ⌘W cancel. The
  preview is a read-only text area. After Script to a New Query Editor Window, that editor has focus and the live region
  says "Script opened in a new query editor window: 14 statements." After Clipboard or Cancel, focus returns to where it
  was, as for other dialog windows.
- **Fallback:** where main refuses the window, the dialog shows over the main window, as Options does.

### Technical sketch

- **New method `results.scriptDiff`, on the results path.**
  - **CLAUDE.md's five places:**
    - `RpcMethods` (contracts.ts);
    - the strict schema, here the port request in `port-messages.ts`, since results-lane methods go through the port and
      not a preload method;
    - `methodPolicies` (`methods.ts`), declared for both engines as every result-naming method is;
    - the renderer's call through `worker-protocol.ts` and `ResultClient`;
    - `SqlService.DispatchAsync` with its `MethodNames` entry and records in `Contracts.cs`.
  - **The results path adds:**
    - the worker's member-by-member rebuild in `worker-core.ts`;
    - main's `results-port.ts` handler (`ResultsPortHost.owns`, a member-by-member copy), the `ResultsBackend` interface
      and `supervisorResults` there, and a strict, bounded answer schema;
    - `SqlService.LaneOf`, and `Providers.BothMethods` with its `tests/validation.test.ts` mirror. C# answers
      `UNSUPPORTED_PROVIDER` for a BigQuery result;
    - a `working-memory-lint` entry;
    - the fake backend, and `FakeHandle` in `tests/fixtures/results.ts`.
  - **Params:** `{ resultId, viewId?, rows?: ranges (as Copy's parts), target: { database?, schema, name } (each 1–128
    characters, no NUL), direction: 'toNew' | 'toOld', columns: number[] (distinct pair indexes, at most the pair count),
    statements: { delete, update, insert }, transaction, checkRows, identityInsert }`.
  - **Deadline and Cancel:** 120 s in `methodPolicies`, as the other result jobs. The dialog's Cancel cancels the request
    through the protocol's cancel, and the backend drops its chunks.
  - **Answer:** `{ text (≤ 1,000,000 characters), deletes, updates, inserts }`. Past 1,000,000 characters, estimated first,
    it answers `TOO_LARGE`, well inside the 16 MiB response limit. Other refusals are `INVALID_PARAMS` with the sentences
    above.
- **Backend `Results/DiffScript.cs`:** literals by the column's `dataType`, precision and scale:

  | Type | Literal |
  | --- | --- |
  | Integers; decimal, numeric, money, smallmoney | As stored; decimals exactly |
  | float, real | Stored as G15 and G7 text: that text when it reads back as the value, else the exact value kept beside it (`CellLengths.TryExact`), written round-trip |
  | bit | 0 or 1 |
  | char, varchar, text; nchar, nvarchar, ntext | `N'…'` with `''` escaping. A non-N literal is read in the database's default code page, so even char columns get `N'…'`, converted to the column's collation on assignment |
  | date, time(n), datetime2(n), datetimeoffset(n) | ISO 8601 text in a `CAST('…' AS <type>)` of the column's own type and precision |
  | datetime, smalldatetime | `CAST('yyyy-MM-ddTHH:mm:ss.fff' AS <type>)`: the stored `yyyy-MM-dd HH:mm:ss` form depends on DATEFORMAT and language, the `T` form does not |
  | uniqueidentifier | Quoted |
  | binary, varbinary, image | `0x…` |
  | xml, json | `N'…'` |

  - Names are bracket-quoted by the existing shared `ScriptFormatter.Quote` (ActionSql, CreateDatabaseSql and DesignerSql
    use it), which gains the NUL refusal. `PeekSql`'s private `Bracket` folds into it.
  - The backend never runs this text. The "SQL the backend runs" rule (server-side `QUOTENAME`) is about executed SQL. An
    offline lint pins that `DiffScript` output never reaches a `SqlCommand`, as ScriptPipeline never executes DDL.
- **Budget:** the text is built in 1 MiB chunks charged as working memory (2 bytes a character, at most 2 MB) and
  released after the answer. Rows are read through `RowAccess`, with no copies.
- **Renderer:**
  - The dialog is a `DialogWindow` of the new kind in `dialogWindowKinds` (`src/shared/popouts.ts`), which also widens
    the `dialogWindowName` pattern (today `options|about`). popout-windows.md § Dialog windows gains the kind.
  - New Query Editor Window opens through the document service with the connection, as Script As's destination does.
  - Clipboard goes through the existing clipboard path.
  - The table suggestions read the Search Objects index, the single metadata source, and never query the server.
- **Catalogues:** command `output.compareScript` (the submenu, More results tools with access key Q, palette;
  `providers: ['sqlserver']`, with Q4's hint on BigQuery). Regenerate the commands docs. No setting.
- **Tests:**
  - `DiffScriptChecks` goldens, a new offline suite in Program.cs's `offlineSuites`:
    - every SQL Server type in `sortKind`'s table;
    - quoting, NULL keys, composite keys;
    - both directions, statement order, the row checks and their cut key text;
    - identity insert, an identity column never SET, collation-only values left out under Exact text off;
    - float values whose text does not read back, datetime in the `T` form, char values as `N'…'`;
    - the refusals, lone surrogates and possible U+FFFD included.
  - A **live round trip** (`VARIA_TEST_SQL_SCRATCH`): two scratch tables with every type, compare their SELECTs, script,
    run the script on the target, then compare again and expect no differences. Run it in both directions, and under a
    non-English language and DATEFORMAT. It is a new live `Suite(...)` with a `LiveGroups.Suites` entry, and its CI
    seconds go in docs/ci.md's table.
  - vitest for the dialog: states, counts per direction, locked and unticked columns, warnings, the comparison replaced
    or closed while open, switching to another comparison, Enter in the suggestion list, and the draft memory.
  - Smoke: open the dialog window by role, script to a New Query Editor Window, and find `BEGIN TRANSACTION` in the
    focused editor. A frameless OS window can behave differently on Linux, so run it through `npm run test:smoke:wsl`
    before pushing.
- **Risks:**
  - A wrong literal corrupts data when the user runs the script. Mitigations: the round-trip live test over every type,
    the row checks, the transaction, refusing truncated values, and never running it.
  - Result column names may be aliases rather than table columns: the index warning and the checklist cover that.
  - A target char column whose collation lacks a character stores `?`, as any assignment would. The index does not know
    the target's collations, so the dialog cannot warn.

**Size L. Build (N2): lane C4.** GoogleSQL DML for BigQuery (typed literals, backticked paths, no row checks) is C4b,
after Q4.

## 5. Search old values

### Value proposition

- **Job:** find a value you can see.
  - In One row a changed cell draws `old → new`, but search reads only the new value: the old one is in a hidden
    previous-value column, and search skips hidden columns. Searching "Open" misses rows that changed from Open.
  - In Two rows the old values are on the − rows and are found.

  With this, One row finds every value it draws. The layouts' counts still differ, since Two rows draws more cells.
- **Who and how often:** anyone searching a comparison. Small, but it reads as a bug.
- **Elsewhere:** Redgate, dbForge and Beyond Compare have Find in their difference views [R3, D3, B4]. None documents a
  search scoped to the old side.

### UX

- No new control. Search on a One row comparison also matches each changed cell's old value. The match lands on the
  data cell and is drawn as any match is.
- The search status is the shipped one, with ", old value 5120.00" appended (cut like the cell text) for a match only in
  the old value. Screen readers hear the same.
- One hit per cell, even when old and new both match. Previous and Next, F3 and Shift+F3 step as now.
- The search's **Columns** mode (column names) ignores old values. Column filters still filter by the shown value.
- Under Two rows nothing changes.

### Technical sketch

- **Protocol:** `ResultsSearchResult` gains `matchOld?: number[]`, ascending indexes into `matchRows` (each below its
  length) whose match is in the old value. It goes in `searchAnswers` (`results-port.ts`) and the strict
  `searchResultSchema`, and is optional, so v2 stays.
- **Backend:** `ResultSearcher` (`Results/ResultSearch.cs`), over a `diff` in the `entry` layout:
  - It gives each previous-value column a matcher and reports its hit as column `of`, merged so matches stay in (row,
    column) order and one hit per cell.
  - Previous-value columns are NULL in every unchanged and soft cell, and NULL never matches, so no tone lookup is needed.
  - `PageFilter` skips hidden columns today, so it builds filters for the previous-value columns too, or packed
    comparison pages could no longer be skipped.
- **Renderer:** the status and live region read `matchOld`. The old value they name is read from the hidden
  previous-value column through the window read the gutter already uses for hidden columns.
- **Tests:**
  - `ResultSearcher` checks: an old-only hit, both sides deduplicated, order kept, a cut row's old value, NULL old values,
    view order, page skipping with the new filters.
  - vitest for the status text.
  - The fake backend's search implements it. A smoke step in 14f searches an old value in One row.
- **Risks:** a wide comparison's search reads up to twice the columns of the same pages, inside search's existing
  reservations.

**Size S. Build: lane C1.** It is small and independent, so it goes first.

## 6. Compare rows as shown

### Value proposition

- **Jobs:**
  - compare just the slice you filtered to (one customer, today's rows, Keep Selected Rows);
  - compare by Row position in the order you sorted;
  - compare two results too large to compare whole, by narrowing them first.

  Today a comparison reads stored rows, ignoring its inputs' sorts and filters, and the popover warns about it.
- **Who and how often:** analysts and developers narrowing large results, regularly.
- **Elsewhere:**
  - Redgate filters the compared rows with a WHERE clause per table, the same or different per side [R2], as dbForge does
    [D2].
  - DataGrip compares whatever two queries return, so the query is the filter (inference from [J3]), and its data diff
    reads 500 rows by default [J1].
  - Beyond Compare's filters change what is shown, not what is compared [B4].

  Varia's grid filters are its WHERE clause.

### UX

One term throughout: rows **as shown** (filters, and sort where it matters), against the **whole result**. "Filtered"
would leave out the sort, and "Rows" is already the toolbar's All rows / Changes only.

- **Where:**
  - The Compare popover gains **Compare each result**: **Whole result** or **As shown (filters and sort)**, shown when
    either input has a sort or filter ("Result 1: 120 of 5,000 rows · Result 3: all 4,980"). It replaces the popover's
    shipped warning about sorted or filtered inputs, and is remembered per pair.
  - The shipped "sorted or filtered" notice gains **Compare rows as shown**.
  - **Compare Rows as Shown** is a checkbox in the Comparison submenu, More results tools and the palette.
  - Compare with Previous Result uses the pair's remembered choice, else Whole result, as today.
- **Showing it:**
  - The sides bar marks a side read as shown with a funnel and "120 of 5,000", its tooltip listing the filters and sort.
  - The name reads "Differences: Result 1 (as shown) → Result 3". A side gets "(as shown)" when it has filters, or, under
    Row position, a sort, since then its order decides the pairing.
  - A notice: "Compared as shown: Result 1 shows 120 of 5,000 rows." with **Compare whole results**.
  - Gutter row numbers stay each input's **stored** row ("row 4,312 in Result 1").
- **Out of date** (Q9): an input's filters change (Keep Selected Rows included), or, under Row position, its sort. Then:
  - The caption shows "Out of date" with **Update**, as Pivots do. In Tabs its tab gets a dot, and the strip says so.
  - Under key or whole-row matching a sort alone changes nothing, so it does not mark it. Re-applying the same filters
    does not mark it either.
  - **Update** (Comparison submenu, access key U, as Update Pivot) replaces it over the inputs as shown now, dropping
    "(as shown)" from a side with neither filters nor, under Row position, a sort.
- **Other changes.** Match, Ignore, Layout, Rows, Exact text and Swap read the inputs as shown now. While it is not out
  of date, that is the same rows. While it is out of date, they also update it, and their announcement says so:
  "Comparison updated with Result 1's current filters: 3 added, 1 removed, 4 changed." Swap swaps which view each side
  reads.
- **Memory:** when All rows is refused for memory and an input has filters, the refusal also offers Compare rows as
  shown.
- **States:**
  - It waits for an input's unpublished view, as Pivot does.
  - An input with no rows as shown compares as all removed or all added, and the notice says "Result 1's filters leave
    no rows, so every row shows as added."
  - Closed inputs disable Update and the checkbox with the reason.
- **Interactions:** under Row position the sorted orders pair. Under key matching the + side's view, as it was at build,
  orders the output; a later sort alone does not mark it out of date, since pairs and counts are unchanged, and the next
  Update or other change picks up the new order. Navigation, chips and the overview strip work on the comparison as
  usual.

### Technical sketch

- **Protocol:** `results.diff` gains `leftView?: number` and `rightView?: number`, view ids as in `results.pivot`'s
  `viewId`, on every step of the results path. The answer gains `leftRead` and `rightRead`, the rows read. They are not
  named `leftRows`, which `CompareInfo` already uses for stored rows.
  - The diff holds both views' orders for its whole run, so a view replaced or closed meanwhile leaves a running diff
    alone.
  - A view of another result, or a closed one, answers `VIEW_NOT_FOUND`. A result keeps at most 8 views, so a view
    closed meanwhile is re-asked by the renderer, once; a second `VIEW_NOT_FOUND` is the comparison's failure.
  - A remote view answers `REMOTE_RESULT`, BQ-3c-1's case.
  - `ResultClient.diff`, which compares a view's base result today, passes the view ids.
- **Backend (the large part):**
  - `ResultDiffer.Compare` and `UnifiedDiff.Write` walk sealed pages in stored order, split across threads, with
    packed-page rooms tuned for near-stored order.
  - Reading through a view's order over packed pages is search's `ByPages` problem: it needs the view's inverse (4 bytes
    a row of the input, charged as working memory) and a `working-memory-lint` entry.
  - The model's row numbers stay stored rows, so the gutter, identity and highlights are unchanged.
  - The diff set records only its input result ids, as now, and keeps no view.
- **Renderer:**
  - `CompareService` passes the inputs' current view ids (`run.sorts`), through `worker-core.ts`'s member-by-member
    rebuild as every results-path step. It keeps `inputs: 'whole' | 'shown'` in the
    options and the pair memory, and records each input's resolved filters and sort keys at build.
  - Staleness is a pure `comparisonOutOfDate`, beside `pivotOutOfDate` (ResultsService). It compares the recorded filters
    with `shownFilters`, and the recorded sort keys only under Row position. No events are needed.
  - The caption and dot reuse the Pivot's components.
  - Context keys: `comparisonAsShown`, `comparisonOutOfDate`.
- **Catalogues:** commands `output.compareAsShown` ("Compare Rows as Shown", `toggled: comparisonAsShown`) and
  `output.compareUpdate` ("Update Comparison", `when: comparisonAsShown`), in the submenu, More results tools'
  `6_compareActions` and the palette. No setting (Q9).
- **Tests:**
  - `DiffChecks`: view reads (filtered, sorted, Row position over view order, packed inputs through the inverse), stored
    row numbers, refusals, working memory counted.
  - vitest: the popover choice and counts, memory, `comparisonOutOfDate` (filters changed, same filters, sort only under
    key and under Row position, Keep Selected Rows), Update dropping "(as shown)", other changes updating an out-of-date comparison and saying so.
  - The fake backend reads views. Smoke 14x: filter an input, Compare rows as shown, change the filter, see Out of date,
    Update.
- **Risks:** packed-page reads in view order are the cost. Search's inverse and lint are the precedent.

**Size L** (backend about a week, renderer a few days). **Build: lane C6.**

## 8. Compare Pivots

### Value proposition

- **Job:** compare aggregates, such as sales by region in Result 1's Pivot against Result 3's.
- **Who and how often:** occasional. It needs two Pivots in one batch, and most aggregate comparisons are written as
  GROUP BY queries, which already compare as Tables.
- **Elsewhere:** no tool documents pivot-aware diffing. DataGrip and dbForge compare any two query results, aggregates
  included (inference from [J3, D4]). SSMS has none.

### UX (deferred design)

- Compare… offers a Pivot's other Pivots (built, same run) as candidates, and a Pivot compares only with a Pivot.
- Rows match by the Pivots' row groups as a composite key: the shipped Key columns mode, passed by the renderer from each
  Pivot's build settings, ⚷ on those headers.
- Column groups pair by name ("2025 · Sum of amount"). Figures compare by value: decimal sums exactly, float averages
  with the approximate notice.
- A rebuilt Pivot (Update or automatic) is a new result. The comparison then shows Out of date with Update, using feature
  6's machinery, instead of reading its input as closed.

### Technical sketch

- `comparableTable` and `DiffAsync` accept kind `pivot` for both inputs, with `INVALID_PARAMS` for a Pivot with a
  Table. Match columns come from the renderer, so the protocol is unchanged.
- Tests: pairing column-group names, decimal and float figures, staleness on rebuild.

**Size M. Defer (N4).** Revisit after cross-run comparison (N5), or if people ask. It depends on C6's staleness.

## Delivery

Each lane runs `npm run check` and regenerates the catalogues it changes, in the same PR. It updates:
- results-tools.md § Comparisons;
- the architecture.md Comparisons and Rows bullets;
- ipc.md (Result diffs, Limits, the method table) where the protocol changes;
- the results guide (`help/guides/results.tsx`, with live `CommandRef`s), or records why there is no guide impact;
- CHANGELOG Unreleased.

When the last lane ships, this plan folds into the area docs and is deleted.

| Lane | Contents | Depends on | Size |
| --- | --- | --- | --- |
| C1 | Search old values | #673 | S |
| C2 | Ignore columns, and the Comparison submenu (N7) | #673 | M |
| C3 | Copy as Diff, Save as Diff… (Q1) | C2 (the submenu, and the header's `ignored:` part) | M |
| C5 | Change details card and hover | C2 (the submenu) | M |
| C6 | Compare rows as shown, Out of date | C2 (both change `results.diff` and the pair memory) | L |
| C4 | Script Differences as T-SQL | C2 (ignored columns' INSERT rule), #680 (dialog windows), #671 (the same protocol files) | L |
| C5b | Compare Values in Tab | C5, #675 (documents and hot-exit records) | M |
| (later) | C4b GoogleSQL script; side-by-side; Pivots | Q4; N4 | M; L; M |

- C1 and C2 can run in parallel: they touch search and `ResultDiff`.
- C3 and C5 can run in parallel after C2: they touch the writer and the grid's card. Both append to the submenu.
- C6 and C4 can be built in parallel after C2, but both append to the results-path files (contracts.ts,
  port-messages.ts, results-port.ts, worker-protocol.ts, worker-core.ts, `ResultClient.ts`, `SqlService.cs`,
  `Contracts.cs`, the working-memory lint and the fake backend), so the second to land merges main first. C4 is listed
  last because it is the largest and riskiest lane, waits on #680 and #671, and its "script back a bad UPDATE" job is
  worth most once cross-run comparison (N5) lands.

## Coordination with in-flight work

Open PRs as of 2026-11-22. After each merges, open comparison branches merge main (merge commits, never rebase).

- **BigQuery** (docs/bigquery-plan.md, 0.10.0):
  - Remote views (BQ-3c) have merged, so C1 and C6 build on their view plumbing.
  - #671 (BQ-3d-1) touches contracts.ts, validation.ts, methods.ts, port-messages.ts, wire/protocol.ts, the preload,
    `Providers.cs`, `SqlService.cs`, `Contracts.cs` and the working-memory lint. That covers all of C4's places and
    C2/C6's protocol members. Their edits are appends, and the comparison lanes merge main after it.
  - #675 (BQ-3d-2) touches the commands catalogue, `contributions/output.ts`, the document registry, the hot-exit
    session and recovery files, and `ResultsService.ts`, where C6 adds `comparisonOutOfDate`. C5b's new document kind
    waits for it and stays out of the hot-exit records.
  - BigQuery disables Compare on windowed results, so a comparison's inputs are in memory. C6's remote-view refusal is the
    backstop.
  - New commands and keys are engine-neutral except C4 (Q4).
- **Connect in an OS window** (#680) reworks `DialogWindow`, `popouts.ts` and `popout-windows.ts`. C4's dialog kind
  follows it.
- **SQL Server Agent** (docs/agent-plan.md, 0.11.0; open #676–#678) does not touch the results pipeline, but shares
  files with the comparison lanes. Both sides only append to them:
  - menus and keys: the commands catalogue, `menus.ts`, `tests/command-catalog.test.ts`, `context-keys.ts` and
    `core/contextkeys.ts` (#677, #678), against C2's submenu and every lane's commands;
  - documents: `documents.ts`, `EditorArea.tsx` and `services/files.ts` (#677, #678), and `start.tsx` with
    `tests/fixtures/monaco-runtime.ts`'s reviewed imports (#676), against C5b;
  - `icons.ts` (#678), against C2's `eye-closed`;
  - the protocol files: the fake backend, contracts.ts, methods.ts, `SqlService.cs` and `Contracts.cs` (#676–#678),
    against C1–C6;
  - settings, CHANGELOG, architecture.md and ipc.md.
  AG-6e's "Compare with source" compares form fields; C5's value-diff worker could serve it later, and neither waits for
  the other.

## Mock

[compare-next-ux.html](../prototypes/results-pane/compare-next-ux.html) builds on
[compare-diff-ux.html](../prototypes/results-pane/compare-diff-ux.html)'s look and data:
- a scene per feature (`?scene=`), with a Dark/Light switch (`?theme=light`) and a narrow pane (`?size=narrow`);
- invented rows, a diff computed in the page, and a stand-in for `GridView`.

Its key labels are Windows'. The product draws them from `KeybindingService` (⌘I and ⌥F5 on macOS).

## Sources

Fetched on 2026-11-22. A claim marked "unverified" above had no documentation found.

- [S1] Compare execution plans, Microsoft Learn: https://learn.microsoft.com/en-us/sql/relational-databases/performance/compare-execution-plans
- [R1] Redgate SQL Data Compare, selecting tables and views: https://documentation.red-gate.com/sdc/setting-up-the-comparison/selecting-tables-and-views
- [R2] Redgate, filtering with a WHERE clause: https://documentation.red-gate.com/sdc/setting-up-the-comparison/filtering-the-comparison-with-a-where-clause
- [R3] Redgate, viewing the row differences: https://documentation.red-gate.com/sdc/reviewing-the-comparison-results/viewing-the-row-differences
- [R4] Redgate, deploying data: https://documentation.red-gate.com/sdc/worked-examples/worked-example-deploying-data-in-two-databases
- [D1] dbForge Data Compare, selecting tables and views: https://docs.devart.com/data-compare-for-sql-server/comparing-data/selecting-tables-and-views.html
- [D2] dbForge, filtering objects and data: https://docs.devart.com/data-compare-for-sql-server/working-with-particular-cases/how-to-filter-objects-and-data.html
- [D3] dbForge, viewing row differences: https://docs.devart.com/data-compare-for-sql-server/reviewing-the-comparison-results/viewing-the-row-differences.html
- [D4] dbForge, comparing custom queries: https://docs.devart.com/data-compare-for-sql-server/working-with-particular-cases/compare-custom-queries.html
- [B1] Beyond Compare, table column handling: https://www.scootersoftware.com/v5help/dlgtablecolhandling.html
- [B2] Beyond Compare, table session columns: https://www.scootersoftware.com/v5help/sessiontablecolumns.html
- [B3] Beyond Compare, Table Compare view: https://www.scootersoftware.com/v5help/viewtable.html
- [B4] Beyond Compare, Table Compare commands: https://www.scootersoftware.com/v5help/commandstable.html
- [B5] Beyond Compare, table compare report: https://beyondcompare.gitbook.io/project/other/report-table-compare
- [J1] DataGrip, compare data: https://www.jetbrains.com/help/datagrip/compare-data.html
- [J2] DataGrip, differences viewer: https://www.jetbrains.com/help/datagrip/differences-viewer.html
- [J3] DataGrip, viewing query results: https://www.jetbrains.com/help/datagrip/viewing-query-results.html
- [V1] VS Code, staging and diff view: https://code.visualstudio.com/docs/sourcecontrol/staging-commits
- [V2] VS Code 1.82 release notes: https://code.visualstudio.com/updates/v1_82
