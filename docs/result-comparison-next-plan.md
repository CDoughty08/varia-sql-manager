# Result comparison, next round: plan

Status: draft for the owner. Nothing here is built. Mock: [prototypes/results-pane/compare-next-ux.html](../prototypes/results-pane/compare-next-ux.html)
(one scene per feature, Dark and Light). Where the mock and this plan disagree, this plan wins.

The comparison rework left eight features out of scope. This plan gives each a value proposition, a UX, a technical
sketch and a recommendation. It builds on:
- [results-tools.md § Comparisons](results-tools.md#comparisons) for shipped behaviour, including difference navigation
  and the overview strip (the difference navigation work, now on main, which every lane builds on);
- [ipc.md § Result diffs](ipc.md#result-diffs) for the stored shape and limits;
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
| N6 | Script Differences opens in an **OS dialog window**, a new kind beside Connect, Options and About ([popout-windows.md § Dialog windows](popout-windows.md#dialog-windows)). |
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
| Q8 | Show Change Details key: Ctrl+I (⌘I on macOS), only in a comparison's grid or card? | **Yes.** VS Code's Show Hover is the chord Ctrl+K Ctrl+I, but Varia's two-part chords work only in editor text (Monaco dispatches them), so a grid key must be one keystroke. Ctrl+I is free in Varia's catalogue and keeps the "I" for information. ⌘I is already Properties in Object Explorer on macOS, so the two share it by focus, as ⌘I and Get Info do in Finder. Monaco binds both to Trigger Suggest in editor text, so `monacoShadowAllowlist` gains `ctrl+i` and its `cmd+i` reason names the grid too; the card's `focusSamples` entry is under § 3 + 7's catalogues. |
| Q9 | A comparison of rows as shown going out of date: rebuild automatically like Pivots, or Update only? | **Update only.** A rebuild resets the comparison's sort, filters and scroll, which is more disruptive than a Pivot rebuild. |
| Q10 | A global "always ignore columns named …" setting (dbForge's mask) with C2? | **No.** Ignored columns are remembered per pair. Revisit if people ask. |
| Q11 | Should Check each statement also check that each UPDATE's and DELETE's row still holds the values the comparison saw, and that each INSERT's row is not in the target yet? | **Yes, as part of that check.** Each UPDATE's WHERE also compares the columns it SETs with the values the target should hold now, NULL-safe (`AND [status] = N'Open'`), so a wrong direction, or a row changed since the comparison, updates no row and the check THROWs. Each DELETE's WHERE also compares the row's ticked, compared columns, so a row changed since, or a same-keyed row of another table, is not deleted. Each INSERT is preceded by `IF EXISTS (SELECT 1 FROM … WHERE <its keys>) THROW …`, so a wrong direction with only INSERT ticked, or a row already restored, inserts nothing instead of a duplicate where the key is not the table's. Without these, the wrong direction for a repair passes every check and changes nothing, or inserts the other side's rows again. Columns without `=` (xml, text, ntext, image, json, vector), pairs whose types are of different kinds, values that were truncated, hold U+FFFD or are subnormal floats, and char or varchar values that are not all ASCII under a SQL_ collation are left out of the comparison. An UPDATE that changes only such columns checks only its keys, and the form and the header say how many there are. Values compare in the target column's collation, so a case-only change under a case-insensitive collation is not caught. |

## What every feature shares

- **A comparison's options are its state**, changed only by `CompareService.replace`, in place.
  Ignored columns (1) and rows as shown (6) join layout, match, rows and Exact text.
  - As shipped, a change keeps the comparison's tab, number, widths, highlights and pressed chips (applied again as its
    `kind` filter), and resets its selection, sort, scroll and every other filter (value filters, Keep Selected Rows,
    duplicates, groups). Those name the old result's rows (`in`, `notIn` and `between` by representative rows, distinct
    snapshots, row sets), which a replace does not keep.
  - Ignore and Stop ignoring keep the columns, so they also keep the sort keys, as a rebuilt Pivot does. Because they
    keep the sort, someone could expect them to keep the filters too, so they alone say when those were cleared.
    They also keep the active column and, while the active row's entry is still shown, that entry, found again by its
    stored rows (`results.findRows`), and scroll it into view; otherwise the top, as today. Toggling columns while
    scanning keeps the place.
  - The announcement, in order: the shipped sentence ("Comparison updated: matched by id, 4 changed, 3 added, 1
    removed."); "Result 1's current filters were applied." (a comparison of rows as shown that was out of date, § 6, in
    the caption's forms); "The comparison's filters were removed." (Ignore and Stop ignoring, when there were any), as a
    Pivot rebuild says its filters were removed; the notices it newly shows; and the shipped sentence for each chip left
    with no rows ("No changed rows are left, so that filter was turned off.").
- **Remembered per pair.** The match memory (the last 64 pairs of names, one way round, per tab) also keeps ignored
  column names (1) and the Compare each result choice (6), each apart from the match: choosing Automatic forgets the remembered key
  columns (`CompareService`, which today forgets the pair's whole entry), but keeps the ignored columns and the Script
  Differences draft. The popover shows what it reuses ("Ignoring: server_time
  (remembered)").
- **The Comparison submenu (N7).** `output.comparison`, declared in `src/shared/commands/menus.ts` like `output.filter`,
  is placed only in the grid menu (`output.context`, `when: outputGridComparison`) as **Comparison**, access key S. No
  letter of "Comparison" is free there: S is Then Sort Descending's, assigned because it has no explicit key. A menu assigns keys over
  the items it shows, so in a comparison's grid menu Then Sort Descending takes N, which Transpose leaves free there
  (comparisons cannot be transposed), and it keeps S in other grids. The catalogue test checks keys without a menu's
  `when`, so `keylessItems['output.context']` gains it. It holds the comparison commands, with access keys of their own:
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
    the Ignore button folds there. The other new commands go in a new group after it, `6_compareactions` (group names are lowercase, per
    `tests/command-catalog.test.ts`). It has only
    j, k and q free, and every letter of "Ignore Columns…" is taken, so the new items are keyless (arrows and type-ahead,
    as Pivot Results… is in the grid menu) except Script Differences as T-SQL… (Q). `keylessItems['output.tools']` gains
    Ignore Columns…, Show Change Details, Compare Values in Tab, Copy as Diff, Save as Diff…, Compare Rows as Shown and
    Update Comparison. Go to Next and Previous Difference stay where the navigation work put them.
  - Toolbar buttons and the palette keep their own entries.
  - `tests/command-catalog.test.ts` (its `keylessItems` for both menus) and `results-smoke.mjs`'s grid-menu steps (their
    clicks, and the top-level Go to Possible Match's `aria-disabled` check) follow the move. That test assigns keys
    without a menu's `when`, so `tests/menus-content.test.ts` gains a comparison grid-menu sample
    (`fixtures/menus-context.*.txt`), pinning Comparison's S and Then Sort Descending's N, and a comparison's More
    results tools: keyless means keyless in that static assignment, but menus assign keys at run time among the items
    shown, and a comparison hides Choose Headers…, so there Show Change Details takes its H. Each lane that adds to More
    results tools (C2 to C6, and C5b) updates `results-toolbar-fold.test.ts`'s pinned `output.tools` list.
- **Engine-neutral.** Commands, context keys and settings declare both providers, except Script Differences (Q4).
  Result-naming methods are declared for both engines in `methods.ts` and checked in C#. New protocol members are
  optional fields of existing v2 shapes, and C4's two new methods (`results.scriptDiff` and `explorer.scriptTarget`) are
  offered through HELLO as every method is, so the protocol stays v2.
- **Every protocol change follows the results path.**
  - Results requests travel renderer → results worker (`worker-protocol.ts`, `ResultClient.ts`, and `worker-core.ts`,
    which rebuilds each port request member by member) → the strict port schema (`src/shared/ipc/port-messages.ts`) →
    main's `src/main/backend/results-port.ts`, which checks `ResultsPortHost.owns` and copies the request member by
    member → C# (`Contracts.cs`, `SqlService`).
  - Answers come back through a strict answer schema in `port-messages.ts`.
  - Copy and Save are main-only jobs (`varia:results-copy`, `varia:results-save`, `src/main/validation.ts`); main's
    `results-jobs.ts` builds their backend params.
  - A member added at one step and not the next is refused or silently dropped, so each lane names every step.
- **The fake backend** (`tests/fixtures/backend.mjs`, which smoke runs against) implements each change, or the smoke step
  moves to the real-server part. Its copy and save use the TypeScript text writer, which today writes no `(old)` columns
  for a comparison and never sees a cut tone, so C3 first brings it level with C#.
- **Inputs closed.** Features that read only the comparison work while an input is closed: Change details and Compare
  Values in Tab (except a soft cell's old value, below), Copy as Diff, Save as Diff, Script Differences (except its
  re-matching buttons), Search. Features that re-run it (Ignore, Compare Rows as Shown, Update, and the notices'
  **Stop ignoring** and **Compare whole results**) are unavailable and say which input is closed, as Match is.

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
  - an **Ignore** button on the comparison toolbar after Match, reading "Ignore (2)" when any are ignored, its accessible
    name "Ignore columns: server_time, row_ver" ("Ignore columns" when none are);
  - **Ignore Columns…** in the Comparison submenu and the palette ("Ignore Columns in Comparison…");
  - **Ignore This Column**, a checkbox in the Comparison submenu of the grid menu opened on that column's header or a cell
    (not shown when the menu is opened on the gutter, by the new target key `outputGridOnColumn`)
    (`comparisonColumnIgnored`). It is unavailable, with the reason as its hint, on a key column under Key columns ("Rows
    are matched by this column, so it cannot be ignored.") and on the last compared column ("Compare at least one
    column.").

  From the grid menu, More results tools or the palette, the checklist opens at the toolbar's Ignore button, or beside ⋯
  when it is folded, as Match does. Match Rows By… from the grid menu opens the same way (`MatchMenuFrom` gains a
  grid-menu origin, and C4 adds a Script Differences one). Apply, Escape or Cancel returns the focus to where it was:
  the active cell, from the grid menu.
- **The checklist** is the Match menu's: the paired columns with their types, searchable, arrows to move, Space to tick,
  Apply or Cancel. A note under it says what ignoring does: "A ticked column is ignored: it stays in the grid, muted,
  but its differences are not counted, coloured or stepped through. Remembered for Result 1 → Result 3."
  - Under **Key columns**, the key columns are listed but unavailable ("Rows are matched by this column, so it cannot be ignored.").
  - Under **Automatic**, the chosen key is tickable, labelled "Chosen automatically: ignoring it matches rows another
    way". Rows are matched again without it: by another key, or by whole rows when none is left.
  - Ignoring every column is refused ("Compare at least one column."). Under Key columns that cannot happen, since the
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
- **Narrow panes:** Ignore folds into More results tools just before Match. The fold order (`comparisonFolds`,
  `ComparisonToolbar.tsx`) becomes the chips, Exact text, Layout, Rows, Ignore, Match, the sides, Profile, Save.
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
  answer gains no new member; only its descriptor columns gain `ignored` (below), since the renderer knows the names.
- **Stored shape:** an ignored pair stays a data column. Its descriptor column gets `ignored: true`, a new optional
  member of `ResultColumn`. `CompareService` knows the names, but `GridView`, the results worker and Save read a
  comparison's columns only from its descriptor, as they read the hidden roles, so the flag travels there rather than
  through a side channel. It goes in:
  - the strict descriptor schema (`src/shared/ipc/descriptors.ts`);
  - contracts.ts and Contracts.cs (main passes the parsed descriptor through, so the strict schema is its only gate).

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
  - the menu target key `outputGridOnColumn` (`src/shared/commands/context-keys.ts`, `targetKeys` in `menus/targets.ts`,
    and the pinned `keysOfScope('target')` list in `tests/command-catalog.test.ts`), true when the grid menu opened on a
    header or cell, Ignore This Column's `when`. `targetFor` fills a missing column from the anchor cell for a gutter
    click and for a keyboard menu alike, so `outputTarget` records on the target, before that fill, whether a header or
    cell was clicked (`onColumn`), and a keyboard menu (Shift+F10, the Menu key) counts as on the active cell: the key
    is true for a header, a cell or the keyboard, and false for the gutter;
  - context keys `comparisonColumnIgnored` and `comparisonColumnIgnorable`. `toggled` and `precondition` take only
    static and state keys (`catalog.ts`, checked by `tests/command-catalog.test.ts`), so both are state keys, as the
    navigation work's `comparisonRowHasPartner` is: `core/contextkeys.ts` computes them for the focused grid's active
    cell, and in the grid menu `argsFor` (`menus/targets.ts`) overrides them with the column the menu opened on.
    `argsFor` reads only the target, so `GridView.targetOf` adds that column's ignored and ignorable facts to
    `GridTarget`, as `partner` carries the row's partner for `comparisonRowHasPartner`. A keyboard menu has no clicked
    cell, and `targetFor`'s anchor fill takes only `column` and `row` from the anchor's `outputCell` today, so it drops
    `partner` (Go to Possible Match is unavailable from Shift+F10 on a ? row) and would drop the new facts; C2 makes the
    fill take the anchor's `partner` (as `rowHasPartner`) with its row, only when the row came from the anchor (a
    keyboard menu), and the column facts whenever the column did: a right-click on a row number already carries the
    clicked row and its partner, which the active cell's must not replace. The second is Ignore This Column's
    `precondition`, true on a column already ignored so the checkbox can be unticked. Its handler's `unavailable()`
    gives the reason for the case at hand (the key column, the last compared column, or an input closed), so
    `unavailableHint` is only the fallback;
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
    - a `results-port.test.ts` case sending `ignore` and checking it reaches the backend request, and a `worker-core`
      case for the rebuilt request, as C4 and C6 have;
    - the toggle's `when`, notice text and Dismiss; `outputGridOnColumn` and the two state keys for gutter, header, cell
      and keyboard menus, the keyboard ones through `targetFor` with a registered grid target, on a ? row
      (`comparisonRowHasPartner`) and on an ignored column; and through `targetFor`, a right-click on a ? row's number
      while the active cell is on a plain row, and on a plain row's number while it is on a ? row, each keeping the
      clicked row's partner;
    - sort keys and chips kept, and filters (a value filter, Keep Selected Rows) removed with "The comparison's filters
      were removed.", across Ignore and Stop ignoring, in the announcement's order; the lost-column notice and its
      plural;
    - the fold order: no test pins `comparisonFolds` today (`results-toolbar-fold.test.ts` pins `toolbarFolds` and the
      `output.tools` list), so C2 adds that assertion; the submenu in `command-catalog`.
  - The fake backend implements `ignore`. Smoke (`results-smoke.mjs`): ignore `updated_at` from the toolbar, check the
    counts and the header's name by role, then Stop ignoring. The suite's steps that click the grid menu's top-level Go
    to Next Difference and Go to Possible Match open the Comparison submenu instead.
- **Risks:** a remembered ignored column that no longer pairs is dropped. The popover says so ("server_time is not in
  these results, so it is not ignored"), and so does a notice when Compare with Previous Result skips the popover
  ("server_time is not in these results, so it is no longer ignored."; "server_time and row_ver are not in these
  results, so they are no longer ignored."), as the shipped remembered-match notice does.

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
  - **By mouse**, it opens after 500 ms, on a changed or soft cell or on a gutter's **?** flag, while the focus is in
    that comparison's grid or its card. It closes when the pointer leaves the cell and card (unless it was clicked
    into, when it stays until the focus leaves, so a selection dragged past its edge survives), when the focus leaves
    the grid and card, or on Escape (WCAG 1.4.13),
    which closes the card before it cancels a copy or save. Escape is reserved for closing widgets, so it is not a
    catalogue key, and it reaches the card only through the focused grid: a card that opened while the focus was
    elsewhere could not be dismissed without moving the pointer. With the focus elsewhere, the grid's own tooltip shows,
    as today. Over that cell the card replaces the tooltip and repeats its truncation sentence.
  - **By key**, **Show Change Details** (Ctrl+I, ⌘I on macOS; Q8), the Comparison submenu or the palette opens it on the
    active cell. From the palette or More results tools, where the focus is elsewhere, it first shows the pane and
    focuses the comparison's grid on that cell, so Escape and Tab reach the card. From the grid menu it opens on the
    cell the menu was opened on (from a header, the active row's cell in that column; from a ? row's gutter, the
    look-alike card; from any other gutter, that row's cell in the active cell's column), passed through `argsFor` as
    Ignore This Column's column is: a right press inside a selection keeps the active cell elsewhere. Opened on the
    active cell (a right press on it, Shift+F10 or the Menu key), it is a card opened by key. Opened on a cell that is
    not the active cell, the card describes that cell, which gets `aria-details`; it has its close button, is the next
    Tab stop and says the opening announcement, but does not follow, and closes when the active cell moves (Alt+F5
    included). Like a card opened by key, it ignores the pointer, and no hover card replaces it while it shows. It is
    available on any comparison cell; cells with nothing to mark open the short cards below.
  - The card is a non-modal dialog named "Change details: note" ("Possible match" for the look-alike card) that does not
    take focus. Opened by key, it stays open, with a close button (✕, "Close change details"), and the live region says
    the card's name (which holds the column) and its summary, then "Tab to read it, Escape to close.": "Change details:
    note, 2 edits: '9' became '10', and 1 more. Tab to read it, Escape to close." (a summary joins the name with its
    first word lower case, except NULL and quoted text: "Change details: note, equal by collation: case-insensitive,
    …"); on a ? row, whose card describes the
    whole row, "Possible match: removed row, looks like row 9 in Result 3: 4 of 5 compared columns equal. Tab to read
    it, Escape to close." The active cell gets `aria-details` pointing at it. The message waits for the summary, which
    needs a read and the worker's diff, up to 500 ms; past that it says the name with "reading…" ("Change details: note,
    reading…"), and then the summary, or the read's error sentence, as a message of its own. Follow mode's messages do
    the same.
  - The card comes after the grid root in the DOM. Opened by key, its body is focusable (`tabindex="0"`), then its
    close button, so it is the next Tab stop: Tab moves into it without leaving the grid and card, and a second Ctrl+I
    focuses the same body. Opened by hover, it is not in the Tab order (its body and buttons take `tabindex="-1"`), so
    a pointer resting on a cell never pulls Tab into a card that closes when the pointer moves; it can still be
    clicked. Any card that closes with the focus inside it (Escape, a replace, the comparison closing)
    returns the focus to the grid's active cell, or to the Results pane when the grid itself closed.
- **Follow mode** (opened by key): the card follows the active cell.
  - Alt+F5 and Alt+Shift+F5 work from the grid or the card: their `when` gains `comparisonDetailsFocus`.
  - Each move gives one live message: the position, then the column and the card's summary, as on opening: "Change 2
    of 31: note, 2 edits: '9' became '10', and 1 more." On a whole-row unit (an added or removed row, or a cut row's
    unlisted changes, `DiffUnit.whole`) navigation selects the whole row with the active cell on its first column
    (`GridView`), so the message leaves out the column and the card is that unit's own (the short card, or the
    look-alike card on a ? row), not the first column's:
    "Change 3 of 31: added row, only in Result 3."; "Change 7 of 31: more changes in this row are not listed." A
    "change" is a navigation unit and an "edit" a run of characters, so
    the two words never share a sentence's meaning.
  - Moves by arrow keys add nothing to the live region: the cell's own name already speaks.
  - A move never strands the focus: the footer keeps **Compare Values in Tab** on every card (unavailable, with its
    hint, where it does not apply), and when a move removes the focused control (Go to Possible Match, which only
    look-alike cards have), the focus moves to the card's body.
  - Follow mode ends on Escape, on focus leaving the grid and card, or on a replace of the comparison, and the card
    closes with it: a card left open would go stale, and Escape could no longer reach it.
  - While a card opened by key shows, hover opens none. Ctrl+I always opens a card by key for the active cell: any card
    not opened by key (a hover card, on the active cell or another, or one the grid menu opened on another cell) is
    replaced by one,
    with follow mode, its close button and the opening announcement. A second Ctrl+I on a card opened by key moves the
    focus into it, as VS Code's Show or Focus Hover does.
- **Card content:**
  - A header: column, type, "changed" or "equal by collation", and "row 4 in Result 1 → row 4 in Result 3".
  - A summary sentence, the card's first line: the number of edits, the first edit, then how many more ("2 edits:
    '9' became '10', and 1 more."; "1 edit: ' Rush' was removed."). An edit reads "'x' became 'y'", "'x' was removed" or
    "'y' was added". The same summary is what the live region says, so:
    - a quoted run is cut at 40 characters with "…";
    - a run made only of whitespace is named, not quoted: "a space was added", "2 line breaks were removed",
      "a tab became a space"; CRLF counts as one line break, and a mixed run names its parts ("a line break and 4
      spaces were added");
    - a change from or to NULL is not an edit: "NULL became 'Net 30'.", "'Net 30' became NULL."
  - **− Old** and **+ New**, wrapped in the mono font. A value up to 4,000 characters shows whole. A longer one shows a
    window of context around each edit, joined by "…", so an edit at character 50,000 still shows ("Showing 3 edits in
    60,000 characters"). A value stored truncated says so under its side, at the grid's limit for its kind ("The old
    value was truncated at 65,535 characters, so differences past it do not show."; 2,097,152 for XML and JSON), and a
    run that reaches the cut is not marked:
    - deleted text is struck through on a red tint, inserted text bold on a green tint (outlined in forced colours);
    - runs are found word-first, then by character, so a changed word reads as one edit;
    - NULL shows as italic NULL, an empty string as "(empty)", trailing spaces (only) as dots;
    - a soft cell says how its collation compares, built from Result 1's flags, under which the diff decides soft
      equality (`ResultDiff` hashes Result 3's columns by the first result's collation), not the comparison column's,
      which are Result 3's; `CompareService` keeps the old input's flags per pair at build, so they hold after Result 1
      closes (`ResultCollation` has no
      name), and always adds trailing spaces, which SQL Server's padding ignores under every collation: "Equal by
      collation: case-insensitive, trailing spaces ignored", "accent-insensitive", "width-insensitive" and
      "kana-insensitive" joining as they apply, or "Equal by collation: trailing spaces ignored" for a case-sensitive
      collation. The marks show what differs; the card names no class of difference, since the renderer compares no
      cells (Q6).
  - A footer: "2 edits · 41 → 42 characters" ("NULL → 7 characters" for a change from or to NULL, which is not an edit),
    a key hint ("Follows the active cell (Alt+F5)" opened by key, "Closes when the active cell moves" on a card that
    does not follow, "Click the cell, then Ctrl+I, to follow changes" on hover), and **Compare Values in Tab** (C5b,
    once it ships) on changed and soft text, XML and JSON cells. Elsewhere that command is unavailable with a hint:
    "Compare Values in Tab compares text, XML and JSON values.", "An added row has no old value to compare." (a ? row
    included), "A removed row has no new value to compare.", "This column is ignored.", "This cell is unchanged.", "More
    changes in this row are not listed." (past a cut tone), or, on a soft cell, "Result 1 is closed, so its value cannot
    be read."
- **On a ? row:** Show Change Details on any of its cells, or hovering its gutter flag, opens the **look-alike card**:
  "Looks like row 9 in Result 3: 4 of 5 compared columns equal", the values that differ, each old → new with marks, and
  **Go to Possible Match**. Ignored columns are not counted, nor are the match's key columns, at least one of which
  differs on a look-alike. Its summary, for the live region, is "removed row, looks like row 9 in Result 3: 4 of 5
  compared columns equal". Which values differ comes from the backend, which judged the look-alike. A partner hidden by
  the comparison's filters or chips is still described, with navigation's sentence (`partnerHiddenText`, "The possible
  match is hidden by a filter", which the card ends with a period) in place of Go to Possible Match. Go to Possible
  Match in the card moves the active cell to the partner, as the command does, and returns the focus to the grid; a
  following card then describes the partner and says follow mode's combined message, and any other card closes. The
  gutter's own tooltip stays everywhere else.
- **Opened by key elsewhere,** the card says what there is:
  - an added row: "Added row: only in Result 3."; a removed row: "Removed row: only in Result 1."; these cards, and a
    cut row's, describe the whole row, so they are named for it ("Change details: added row", "Change details: removed
    row", "Change details: unlisted changes"), and the opening announcement does not repeat the kind: "Change details:
    added row, only in Result 3. Tab to read it, Escape to close.";
  - an ignored column: "This column is ignored.";
  - an unchanged cell: "Unchanged.";
  - a cell past a cut tone: "More changes in this row are not listed.", as the gutter says. The card reads the tone
    the renderer holds, not the change index's full list, which stays in the backend; Copy as Diff and Script read
    that list, so a ticket or a script still has the cell.

  Hover never opens these.
- **States:**
  - "Reading…" while the values load (the read's deadline, then its error).
  - A value over the diff's bounds shows unmarked: "Too long to mark." over 100,000 characters, "Too many differences to
    mark." past the edit or time bound. " Compare them in a tab." follows only where Compare Values in Tab is offered.
    With no edits to centre windows on, each side over 4,000 characters shows its first 4,000 ("Showing the first 4,000
    of 150,000 characters").
  - A soft cell whose old input is closed: "Equal by collation: case-insensitive, trailing spaces ignored. The old value
    is not kept (Result 1 is closed)."
  - The comparison closing closes the card.
- **Narrow panes:** min(560 px, the pane less 16 px) wide, at most 60% of the pane tall, scrolling. Under 360 px it
  takes the pane's width, above or below its row (the active row, or the hovered row for a hover card), never over it. A
  card opened by key whose cell is scrolled out of view stays clamped to the pane's edge, still describing the active
  cell, and moves back with it.
- **Interactions:**
  - One row: the card is on the cell. Two rows: either half's cell, showing both halves.
  - Chips and filters do not change it; Rows, like any replace, closes it. Highlights and search hits stay in the grid.
  - Exact text off: soft cells open as "equal by collation".

### Technical sketch

- **No protocol change for the values themselves.** Values come through the results worker's whole-cell read
  (`ResultHandle.getCell`, as Open Value in New Tab uses), which gains a `maxChars` option.
  - The card reads at most 100,001 characters a side; Compare Values in Tab reads whole values.
  - The **new value** is the data column at the grid's position.
  - The **old value** depends on the cell:
    - One row, changed cell: the hidden previous-value column at `old + pair`, in the same row.
    - One row, soft cell: no old value is stored. It is read from the old input's cell (its stored row from the gutter's
      `leftRow`, which is 1-based, less one, through the input's own handle) while the input is open. Otherwise the card
      gives the closed-input state above.
    - Two rows, a cell of a `same` entry (one whose only differences are soft): stored as one row
      (`UnifiedDiff.StoredRows`), so there is no other half. It takes One row's soft path: the old input's cell at
      `leftRow`, or the closed-input state.
    - Two rows, any cell of a changed entry, soft cells included: the other half, which holds every old value. A sort or
      filter can separate the halves, so the card identifies the comparison's rows once (`results.identify` with `row`,
      cheap for a diff since the identity is its `leftRow`/`rightRow` columns), then asks `results.rowIds` for the
      active row's entry identity and `results.findRows` on the comparison's base result for both halves' stored
      positions, and reads them through the base handle.
  - A look-alike card reads the partner through `results.diffSeek { partnerOf }`. Its answer gains `differing?:
    number[]` (the pair indexes whose values differ, ascending, each below the pair count) and `compared?: number` (the
    compared pairs other than the match's key columns). Today `LookAlikes` returns only the partners, and `DiffIndex`
    keeps only a partner per row, so the build keeps more: as `LookAlikes` scores a pair it records which compared
    pairs' hashes differ, and `DiffIndex` stores that as a changed-pair bitset beside each partner (one bit a pair).
    `BytesFor` charges a flat `PossibleBytes` a look-alike today and takes no pair count, so it gains `pairs`, as
    `CutBytes(pairs)` has, and SqlService passes `model.Pairs.Length`, so a wide comparison's bitsets are charged. A
    seek still reads only the index, so architecture.md's change-index bullet gains "and each look-alike's differing
    pairs". The renderer compares no cells, so collation and soft equality stay the backend's. Both members go through
    every results-path step.
  - A view seek's `hidden` answer carries no row (`diffSeekResultSchema`'s strict `{ hidden: true }`), so the card seeks
    `partnerOf` on the comparison's base result, whose stored rows are never hidden, for the partner's stored row,
    `differing` and `compared`, and reads that row through the base handle. `partnerOf` is a row of the result sought,
    and under a sort or filter the card knows only the ? row's view position, so it first finds that row's stored row as
    Two rows finds its halves (`results.identify`, `results.rowIds`, `results.findRows`). A seek on the view then says
    whether the partner is hidden (the hidden-partner sentence) or where Go to Possible Match lands.
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
  - It renders as a sibling of the grid root in `rg-frame`, not inside it. Everything inside `[data-result-grid]` sets
    `outputGridFocus` (`core/contextkeys.ts`) and sends keys to `GridView.key` through the root's `onKeyDown`, so a card
    inside it would turn Ctrl+C, Ctrl+A and Ctrl+F into grid commands and arrow keys into grid moves. It carries its
    own marker attribute, which `focusFacts` and `noFocus` read for `comparisonDetailsFocus`, so in the card native copy
    and selection work on its text.
  - Its sizes and the hover delay are `metrics.ts` entries, and its marks are theme tokens with contrast pairs in both
    themes (regenerate `theme-metrics` and the theme docs).
  - Escape with the focus in the grid reaches the card through `GridView`'s existing `onEscape` hook: `ResultGrid` closes
    an open card first, else cancels the tab's copy or save. Inside the card, Escape is the card's own `onKeyDown`, as
    in the Compare popover. Neither adds a key listener (`tests/keyboard-lint.test.ts`).
  - Hover comes from the grid's existing pointer handling through a debounced `onCellHover`, with no per-cell listeners.
  - The read waits for the hover delay and is cancelled on leave.
  - Marked text renders as spans in the card, which is not the grid, so the grid lint's nodeValue rule is untouched.
  - `aria-details` goes through a `GridView` option applied in `paintCell`, since a pooled cell element set from React
    would keep it when the pool reuses that element.
- **Compare Values in Tab (C5b, N8):** one reused read-only document, "Compare Values".
  - A new document kind `valueDiff` hosts `monaco.editor.createDiffEditor`.
  - Each use replaces its two texts (each at most 2,097,152 characters, held in renderer memory) and brings it forward,
    so memory is bounded at one pair.
  - Its tab reads "Compare Values". Its tooltip and header name the column, both rows, both results and the query
    document, since the tab is shared by every query document ("Compare Values: note, row 4 in Result 1 → row 4 in
    Result 3 (SQLQuery3.sql)"). Its toolbar has **Inline** / **Side by side**: standalone Monaco has no toggle of its own,
    so Varia sets `renderSideBySide`, with `useInlineViewWhenSpaceIsLimited`.
  - It holds a snapshot: closing or replacing its comparison leaves it as it is, until the next use replaces it.
  - A value read only in part, cut at 2,097,152 characters or stored truncated, says so in the header, in Open Value in
    New Tab's words, at the limit for its kind ("The old value was truncated at 65,535 characters."; 2,097,152 for XML
    and JSON), so the tab never passes for whole values. A NULL side shows as empty text, so the header says so too
    ("The old value is NULL."), since the editor cannot tell it from an empty string.
  - It is not saved, and is left out of hot exit's session and recovery records. It needs no connection.
  - Wiring: the document registry, `icons.ts`, `start.tsx`'s reviewed imports for the diff editor (regenerate
    `monaco-keybindings`), and Close and Close Others.
- **Catalogues:**
  - commands `output.compareChangeDetails` ("Show Change Details", `mod+i` when `(outputGridFocus &&
    activePanel == 'output' || comparisonDetailsFocus) && resultsGridComparison`, since a Peek card's grid also sets
    `outputGridFocus` and Escape could not reach a card opened from there; the submenu with `when:
    outputGridComparison`, More results tools' `6_compareactions`, the palette) and `output.compareValuesInTab`
    ("Compare Values in Tab", C5b, in the same places);
  - Alt+F5 and Alt+Shift+F5's `when` gains `|| comparisonDetailsFocus`;
  - context key `comparisonDetailsFocus`. Whether hover opens a card is read from the tone by the grid, not a context
    key, since the command itself works on any comparison cell;
  - setting `queryResults.compare.hoverDetails` (boolean, default on);
  - Q8's `monacoShadowAllowlist` entries, and a `focusSamples` entry for the card: `{ name: 'comparisonCard', keys: {
    activePanel: 'output', resultsFocus: true, comparisonDetailsFocus: true } }`, with `outputGridFocus` false since
    the card is outside the grid root. Regenerate the commands and settings docs.
- **Tests:**
  - vitest:
    - the worker: word then character runs, bounds, abort, soft cells, NULL and empty, trailing spaces, context windows
      for edits past 4,000 characters;
    - the card: follow mode, its end conditions, Escape (by key and on hover) and focus return, the opening announcement,
      the combined live message, the key-only states reached from the menu, the look-alike card;
    - old-value sources: One row changed, One row soft (input open or closed), a Two rows `same` entry (the same path),
      a soft cell of a changed Two rows entry (the other half), Two rows sorted apart (identified first);
    - the look-alike card from `differing`, and its hidden partner;
    - the hover debounce, no hover card while the focus is outside the grid and card, and the key's `when`.
  - `DiffChecks`: `partnerOf` answers `differing` and `compared`, skipping ignored pairs; `BytesFor` charges the bitsets
    by the pair count, and a diff with many look-alikes on a low budget, and a wide one (2,046 pairs) with a few, is
    refused, not cut.
  - `results-port`: a partner answer carrying `differing` and `compared` passes `diffSeekResultSchema` and reaches the
    renderer, so a schema left unwidened is caught.
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
    with its row's stored number in its own input, the gutter's number (`-4`, `+4`; an unchanged line takes its number
    in the new input). Under Automatic the match line says so (`# rows matched automatically by id`, and `# rows matched
    automatically by whole rows; lines start with row numbers` when it fell back), as Script Differences' first line
    does. The header names the match and says so (`# rows matched by whole rows; lines start with row numbers`, with any
    `ignored: …` before that last part), and the column line starts with `row`.
  - **Save as Diff…** (Q1) writes the same text for every row the grid shows, with every column it shows but ignored
    ones, to a file. While chips or filters narrow the grid, its header says so (`# the comparison shows 12 of 40
    differences`), counted in a first pass over the view, so a saved diff with the ~ chip pressed is not read as having
    no added or removed rows. Copy as Diff says so too, whenever the entries it writes as − and + lines are fewer than
    all differences (`# copied 12 of 40 differences`), and adds `# 3 copied rows changed only in columns not copied`
    when it wrote changed entries as one unchanged line, both counted in a first pass over the copied entries (the one
    that pairs Two rows halves).
- **Text:**

  ```
  --- Result 1
  +++ Result 3
  # rows matched by id; ignored: updated_at
  # copied 2 of 40 differences
  # id	customer	status	amount	note
  -1002	Contoso Ltd	Open	310.50	Rush delivery, call before 9 am
  +1002	Contoso Ltd	Shipped	310.50	Rush delivery, call before 10 am
  @@ rows not copied @@
  -1004	Adventure Works	Open	5120.00	Net 30, invoice to head office
  +1004	Adventure Works	Open	4980.00	Net 30, invoice to the head office
  ```

  - The header's lines come in this order: `---` and `+++`, the shows lines under them (C6), `# rows matched by …`, then
    Save's `# the comparison shows …` or Copy's `# copied …` and not-copied lines, then the `#` column line.
  - The `---` and `+++` lines name the sides as the comparison does: a result's name, or "Totals (Result 2)" when two
    results share one, with "(as shown)" for a side read as shown (§ 6) and a line under them saying how many rows it
    showed (`# Result 1 shows 120 of 5,000 rows`), so a pasted diff is not read as the whole result.
  - Each line is a prefix (`-`, `+`, or a space for unchanged), then tab-separated values. The `#` column line escapes
    column names as values are, so an alias holding a line break cannot forge a line either.
  - Values escape `\`, tab, CR and LF as `\\`, `\t`, `\r` and `\n`. NULL is `NULL`, and a text value that is exactly
    `NULL` is `\NULL`.
  - A changed entry whose copied columns are all unchanged (its changes are in columns not copied) is one unchanged
    line, with a space prefix, so a ticket never shows a `-` and a `+` line that look the same.
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
- **States:** unavailable outside comparisons. Over Copy's size limit, both forms of Copy's sentence (main's "more than
  64 MB" and the backend's "…; the limit is 64 MB") end "Use Save as Diff… instead." in place of "Use Save Results As
  instead." Progress and Cancel are Copy's and Save's. It works while an input is closed.
- **Screen readers and the toolbar:** "Copied 2 rows as a diff." in the results live region, and "Saved 12 rows as a
  diff to orders.txt." on the toolbar and in the live region, as Save's sentence is. Both keep the shipped clauses that
  follow: " 3 values were truncated." (with its notice), since a cut value can make a − line and a + line look the same.
  A changed row counts once in both layouts, as One row draws it, though it writes two lines.

### Technical sketch

- **Protocol** (no new method):
  - `results.copy` gains `format?: 'tsv' | 'diff'` (default `tsv`), and `results.export`'s `format` gains `'diff'` (Q1).
  - With `diff`, both also take `names: { left, right }`, required: the sides' display names ("Result 1", "Totals
    (Result 2)"), which only the renderer knows (`entryNumber`), each 1–260 characters, bounded in zod and C#. The
    writer escapes every name in every header line as it escapes values (the side names, the match line's key and
    ignored column names, `# rows matched by id; ignored: updated_at`, and the `#` column line), so a name holding a
    line break cannot forge a diff line.
  - The rest of the header comes from the diff set, which records it beside `DiffInputs` in `DiffWritten`: the match
    used (`DiffMatch`, its mode and key pairs), the ignored pairs, and, for a side read as shown (C6), its rows shown
    and its rows. Today it records only `DiffInputs`, so C3 adds the match and ignored pairs, and C6 the counts (C4 adds
    Result 1's column types and collations and whether the inputs were BigQuery results, which only it reads). The match
    text, "lines start with row numbers" under a match without key columns, and the `# Result 1 shows 120 of 5,000 rows`
    line are written from them. Whichever of C3 and C6 lands second writes the "(as shown)" names and that line, in both
    writers, with a shared golden and the fake backend's recorded counts.
  - They change in `resultsCopyRequestSchema` and `resultsSaveRequestSchema` (`src/main/validation.ts`), the preload
    signatures (`copyResults`, `saveResults`), the params `results-jobs.ts` builds (`ResultsCopyParams` and the export's),
    the fake backend and the C# records, each with `names`.
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
    - Through a sorted or filtered view of Two rows, that needs a bit per stored row (written already), and a selection
      needs it too. `ResultJobs` reserves it as working memory before writing (`set.TryReserveWork`, as copy and export
      reserve today), and refuses with `TOO_LARGE` when it does not fit. `tests/working-memory-lint.test.ts`'s
      reservation checks read only `SqlService.cs`, so a `DiffChecks` refusal check on a low budget pins it.
  - It reads `mark`, the tone, the previous-value columns and, for a cut entry, the change index's changed-pair bitset,
    which its one-unchanged-line rule needs. The change index keeps a cut row's full changed-pair list only in One row
    (`keepsList: cut`), so C3 keeps it on a cut Two rows entry's new half too, charged by `CutBytes` as now, and
    `DiffIndex`'s summary and architecture.md's change-index bullet say both layouts.
  - It writes headers, prefixes and the skip lines. For Save through a view that chips or filters narrow, a first pass
    counts the view's entries for the `# the comparison shows 12 of 40 differences` line (a Two rows entry once,
    through the same reserved bit per stored row, cleared after), the second number being the diff's own count.
  - The copy estimates (`EstimateCopyRows`, `EstimateCopyCells`, `EstimateHeader`, `ResultJobs.EstimateCopy`) count both
    lines of an entry and escapes, and `EstimateHeader` the shows and copied lines.
  - Copy counts, in its first pass, which pairs Two rows halves through the same reserved bit, the copied entries it
    writes as − and + lines and those it writes as one unchanged line, for the `# copied 12 of 40 differences` and `# 3
    copied rows changed only in columns not copied` lines.
- **The TypeScript twin** (`src/shared/results/text-writer.ts`) implements `diff` too, because the fake backend's copy
  and save use it. Local tables never ask for it.
  - First it catches up with C#: its `savedColumns` writes no `(old)` columns for a comparison, where C#'s
    `SavedColumns` does.
  - It passes the shared goldens, except those for a cut tone, which stay C#-only because the fake backend never cuts
    one.
- **Catalogues:** commands `output.copyAsDiff` and `output.saveAsDiff` (the submenu with `when: outputGridComparison`,
  More results tools' `6_compareactions`, palette). Regenerate the commands docs.
- **Tests:**
  - shared goldens for both writers:
    - both layouts give the same changed cells, sorted Two rows halves are paired;
    - gap and skip lines, cut rows in both layouts, a cut Two rows entry's full changed-pair list kept;
    - NULL against the text `NULL`, escapes;
    - ignored columns, forced key columns, row-number prefixes without keys, CRLF and LF;
    - the header from the diff set's recorded match and ignored pairs, and side names, a key column name and an ignored
      column name each holding a line break, escaped;
    - a changed entry whose copied columns are unchanged, written as one unchanged line;
    - a Save through a view narrowed by a chip, with its shows line, in both layouts; a Copy of some of the differences,
      with its copied line, of all of them, without it, and of one column whose entries changed elsewhere, with the
      not-copied line;
  - the refusal on a non-comparison, and a `DiffChecks` case: a sorted Two rows copy on a low budget is refused, not
    cut; and a Two rows build with a cut entry on a low budget refused, since `Builder.Add` stores a cut row's list
    without checking it was reserved and the new half's list is C3's;
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
  **OS dialog window** (N6): kind `scriptDiff`, titled "Script Differences as T-SQL" (main sets the kind's static title,
  `dialogWindowKinds`), 640 × 600 by default, at least 520 × 440, its size remembered as Options' is, modeless. One is
  open at a time, as Options is. It opens at its remembered position (`dialogWindowBounds`, which Connect in an OS
  window brought) while it lies on a connected display (main's `onDisplay` check, else the window opens centred),
  remembered apart for a Results pane in the main window and one in a popout, so a dialog parked on a second display
  beside the grid opens there again; else it opens centred over the window that holds the comparison's Results pane (the
  main window, or a popout on another display), and stays a child of the main window, as every dialog window is:
  parented to a popout, it would close when the panel docks back. A popout clicked meanwhile can cover it; Script
  Differences as T-SQL… brings it forward.
- **The form:**
  - A first line names the comparison and how rows are matched: "Result 1 → Result 3 (SQLQuery3.sql), rows matched by
    key columns: id" ("rows matched automatically by order_no" under Automatic, and the strip's own `matchedBy` words
    for the rest: "whole rows matched", "rows matched by position"), and changes when another comparison invokes the
    dialog. A script is written only under Key columns the user chose (below).
  - **Target table:** `[database.]schema.table`, each part 1 to 128 characters, parsed as SQL Server parses a multipart
    name: parts plain, bracketed (`[my.schema].Orders`, with `]]` inside brackets) or double-quoted. One part is refused
    ("Name the schema too, such as dbo.Orders."), and so are four ("A linked server cannot be the target. Name the table
    as [database.]schema.table."), and a part holding a line break or other control character ("A table name cannot hold
    a line break or other control character."), which the query window would normalize inside brackets. Five or more
    parts take the four-part sentence; an empty part (`dbo.` while typing, or `Sales_Test..Orders`, whose default schema
    the script could not name) "Name each part, such as Sales_Test.dbo.Orders."; a part over 128 characters "Each part
    of the name is at most 128 characters."; an unclosed bracket or quote "Close the bracket or quote in the name." The
    field is checked as it changes, and its sentence shows once it loses focus or on Script. Empty the first time, with
    suggestions from Search Objects' index for the comparison's connection (tables holding every compared column first,
    then by how many they hold, then the query document's current database first, then by name, history and dropped
    ledger tables left out, none highlighted until an arrow key moves to one, so Enter never picks one unchosen), and
    Script waits for it ("Choose the target table."); after that, the pair's remembered draft.
    - **Database.** A two-part name is resolved to the query document's current database when it is typed or picked,
      while the document is on the comparison's connection: its target is the comparison's server, connected or not,
      since Disconnect with Keep Tabs keeps the document's database (connections-explorer.md), and a document a
      reconnect reattaches counts again, while one disconnected through its own command is not reattached and does not.
      A line under the field always names the server and the database the script will change ("In Sales_Test on
      SQLDEV01, SQLQuery3.sql's database"). The dialog keeps that resolution, as the draft does: when the document's
      database or connection changes while the dialog is open, the field is rewritten in three parts
      (`Sales_Test.dbo.Orders`), as the draft shows it, so the target and its facts never move and a later edit cannot
      resolve it again unseen, and the line says what changed: "In Sales_Test on SQLDEV01. SQLQuery3.sql's database is
      now Sales_Dev." for a database, "In Sales_Test on SQLDEV01. SQLQuery3.sql is now on SQLPROD02." for another
      connection whatever its database is called, and "In Sales_Test on SQLDEV01. SQLQuery3.sql has no connection now."
      when it has none. The live region says it, and the window says it again when activated. Such a line wins over the
      three-part line below, which shows only while nothing has changed since the name was resolved. A two-part name
      typed while the document is on another connection takes the sentence "SQLQuery3.sql is now on another connection.
      Name the database too, such as Sales_Test.dbo.Orders." (one typed while the document has no connection,
      disconnected through its own command, "SQLQuery3.sql has no connection. Name the database too, such as
      Sales_Test.dbo.Orders."), since the script opens on the comparison's connection, and the line under the field
      names only the server ("On SQLDEV01, the comparison's connection.") until a database is named. A three-part name
      picks another, and the line names it ("In Sales_Dev on SQLDEV01, not SQLQuery3.sql's database."). Suggestions are
      three-part (`Sales_Test.dbo.Orders`), so two databases with the same schema on one server are told apart. The
      script writes three-part names everywhere, so it changes that database whatever the query window's database is
      when it runs, and its header names the server and the database.
    - When the index knows the table it says so ("Search Objects knows [Sales_Test].[dbo].[Orders] on this connection: 8
      columns, all 6 compared columns among them. id is its identity column."). It knows the table whenever the index
      holds a read of that database with its columns, whatever else that read left out (definitions, cut definitions,
      system objects); while a rebuild runs over that read, or after a later read of the database failed, the line adds
      "These are from Search Objects' last index of Sales_Test." It warns, never refuses, when it cannot, naming what
      that costs, since without the index the dialog cannot offer SET IDENTITY_INSERT and an INSERT into an identity
      column then fails and rolls the script back (Msg 544):
      - the index lacks the table: "Search Objects does not know [Sales_Test].[dbo].[Orders], so its columns cannot be
        checked and SET IDENTITY_INSERT is not offered. Check the name, or rebuild the search index.", with **Rebuild
        Search Index** (`explorer.rebuildIndex` for the comparison's connection). Pressed, it stays in place,
        unavailable (`aria-disabled`, so it keeps the focus) while the build runs, the live region says "Rebuilding the
        search index for SQLDEV01…", and when the build finishes it says the line that follows;
      - the connection has no index (Index on connect off): "SQLDEV01 has no search index yet, so its tables are not
        suggested, the target's columns cannot be checked and SET IDENTITY_INSERT is not offered.", with **Build index**,
        as Search Objects offers, which behaves as Rebuild Search Index does;
      - the database was skipped (the login cannot open it, say) and no earlier read of it is held: "Search Objects
        skipped Sales_Test, so the target's columns cannot be checked and SET IDENTITY_INSERT is not offered.", with no
        button, since a rebuild would skip it again;
      - the database is still being indexed and no earlier read of it is held: "Search Objects is still indexing
        Sales_Test, so its columns cannot be checked yet.";
      - the database was indexed without its columns: "Search Objects holds no columns for Sales_Test, since its index
        did not fit the memory budget, so its columns cannot be checked and SET IDENTITY_INSERT is not offered.";
      - a ticked column the table lacks (compared, or ignored and ticked for INSERT): "[Sales_Test].[dbo].[Orders] has
        no column note in Search Objects' index, so a statement naming it would fail. Check the table, or rebuild the
        search index.";
      - over 4,096 columns: "[Sales_Test].[dbo].[Orders] has more than 4,096 columns, so its columns are not checked.";
      - the comparison's connection is not open (Disconnect with Keep Tabs keeps the comparison, and the index is
        dropped on disconnect): "SQLDEV01 is not connected, so the target's columns cannot be checked and SET
        IDENTITY_INSERT is not offered.", with no suggestions and no request, the line under the field naming the server
        and the document's kept database (a two-part name resolves to it, as above), and New Query Editor Window
        unavailable (Destination below) while Clipboard stays available, since the script reads only the comparison.
        Reconnecting brings the facts back as a finished build does.

      The dialog asks `explorer.scriptTarget` again when that connection reconnects or its index build finishes (the
      progress `ObjectSearchService` follows), so the facts appear without retyping. Its first request goes out on
      opening (none while the comparison's connection is not open, which shows the not-connected state instead) with the
      draft's target as `text` and `table` (the first time, empty text and no `table`, so the suggestions show before
      anything is typed), and with a draft's target Script shows "Checking the target table…" until it answers; so does
      each opening again, after Choose key columns… or for another comparison, so a remembered target never scripts
      without its facts. Script waits from the moment the target changes until the answer for that target arrives, the
      300 ms wait before the request included: it is unavailable, described "Checking the target table…", which pressing
      it says, so a suggestion picked with Enter and Enter pressed again never scripts with the last name's facts. The
      renderer sends facts (`identity`, `indexReasons`, SET IDENTITY_INSERT) only from an answer whose `table` is the
      target it sends. A lookup that fails (its deadline, a backend error) leaves no facts: "Search Objects did not
      answer, so the target's columns cannot be checked and SET IDENTITY_INSERT is not offered.", with **Try again**
      beside it, which asks again, and Script available. Pressed, Try again stays in place, unavailable
      (`aria-disabled`, so it keeps the focus) while the request runs, and the live region says "Checking the target
      table…" and then the line that follows, the failure sentence again when it fails again. A disconnect while a
      lookup is pending, or after one failed, shows the not-connected state instead, with no Try again.
  - **Direction**, naming the target as resolved ("The target table" before one is chosen):
    - "[Sales_Test].[dbo].[Orders] holds Result 1's rows: change them to Result 3's";
    - "[Sales_Test].[dbo].[Orders] holds Result 3's rows: change them to Result 1's".

    Neither is picked the first time, and Script waits for one ("Choose a direction.", after "Choose the target
    table."): both jobs above need the second, so no default fits. After that the pair's draft remembers it, and a line
    says so ("Remembered from the last script for Result 1 and Result 3.") while the direction is the one the draft
    supplied on opening, since a batch whose two SELECTs swapped keeps their names and columns, which the draft cannot
    tell apart. The script is written for the chosen direction, and the comparison is not swapped. The summary names the
    end state, and Q11's check stops a wrong direction when the script runs, except in an UPDATE that changes only
    columns the check cannot compare, which a line names (Options below).
  - **Statements:** DELETE (n), UPDATE (n) and INSERT (n), each a checkbox with its count for the direction, shown once
    one is picked. The first time UPDATE and INSERT are ticked and DELETE is not, since a row missing from a result is
    often one the query left out; the draft remembers the ticks. While DELETE is ticked, a line says "DELETEs fire the
    target's delete triggers and ON DELETE cascades. A row missing from a result is deleted, even when the query only
    left it out (a WHERE or TOP)." With none ticked, the summary says "No statements are ticked." and Script is
    unavailable. When the chosen rows hold look-alike rows (?) and DELETE or INSERT is ticked, a line warns, counting
    them (the answer's look-alike counts), worded by the ticks, since with only one ticked a look-alike pair is neither
    replaced nor kept whole. These lines count only rows whose look-alike is among the chosen rows too:
    - both: "12 removed rows look like added rows: each pair is scripted as a DELETE and an INSERT, not an UPDATE.";
    - INSERT only (the first time's ticks): "12 rows to insert look like rows DELETE would remove. With DELETE unticked,
      the target keeps both. Tick DELETE to replace them.";
    - DELETE only: "12 rows to delete look like rows INSERT would add. With INSERT unticked, they are deleted and not
      replaced. Tick INSERT to replace them."

    A row whose look-alike the chosen rows leave out (the − chip pressed, or Selected rows on one ? row) gets its own
    line while its statement is ticked, whatever the other tick, since ticking the other would not write the partner: "2
    rows to delete look like rows the chosen rows leave out, so they are deleted and not replaced. Choose rows that hold
    both, or untick DELETE." and "2 rows to insert look like rows the chosen rows leave out, so the target keeps both.
    Choose rows that hold both, or untick INSERT."

    When the comparison did not look for them ("Too many unmatched rows to look for possible matches."), the line,
    worded by the ticked statements that have rows among the chosen rows, says "Possible matches were not looked for, so
    a changed key is scripted as a DELETE and an INSERT.", or with one ticked "…so a row whose key changed is inserted
    under its new key and also stays under its old one. Tick DELETE to replace such rows." and "…so a row whose key
    changed is deleted and not inserted under its new key. Tick INSERT to replace such rows."; when the other statement
    has no rows among the chosen rows, ticked or not, its advice is "Choose rows that hold both." instead.
  - **Columns:** the data columns, as one list and one Tab stop with a search field above it, as Ignore Columns…'
    checklist has: the field filters the list, arrows move in the list, and Space ticks, so a result of 60 columns adds
    two Tab stops, not 60. A locked column takes the focus and says its reason (a key column "Key column: always
    scripted"), but Space leaves it as it is.
    - Key columns are ticked and locked, whatever else would lock a column unticked (a type no literal writes, a
      repeated name), since the key refusals answer those before anything else (Params in the sketch). A key column
      INSERT cannot write (rowversion or timestamp, in either result or per the index in the target, or computed or
      GENERATED ALWAYS per the index) leaves INSERT unavailable, with the reason ("row_ver is a key column that cannot
      be inserted (rowversion), so INSERT is unavailable."). Ignored columns are ticked, for INSERT only, except one the
      index says the target lacks (an expression alias such as `server_time = GETDATE()`, usually), which starts
      unticked with its reason ("Not in [Sales_Test].[dbo].[Orders]"), since an INSERT naming it fails the whole batch
      when it compiles (Msg 207), before the transaction's TRY can catch it. That start follows the target and is not
      remembered as the user's choice; ticking the column again brings the warning for a column the table lacks. While
      UPDATE is ticked, a line says what ignoring costs, since the summary's "to match Result 3" would otherwise hide
      it: "updated_at is ignored: UPDATEs leave its changes out, and rows that differ only in it get no statement. Stop
      ignoring it to include them." ("updated_at and memo are ignored: … their changes … only in them …"). While DELETE
      and the checks are on, it names that cost too ("…get no statement, and DELETEs do not check it."), and shows for
      it alone when UPDATE is unticked ("updated_at is ignored, so DELETEs do not check it."). An ignored column the
      index says the target lacks is left out of this line, since the target cannot hold its changes and stopping
      ignoring it would only make it a compared column the table lacks; its reason in the list says why. While an input
      is closed, the comparison cannot be rebuilt, so this line and the Exact text line below drop their last sentence.
    - Unscriptable columns start unticked and locked, with the reason: rowversion and timestamp, in either result or,
      per the index, in the target ("Not insertable": an INSERT or SET naming one fails when it compiles, Msg 273 and
      272), computed per the index ("Computed"), GENERATED ALWAYS per the index ("Generated by the server": a temporal
      table's period columns, which change in every updated row, so an UPDATE whose only changes are there is skipped),
      CLR types and sql_variant ("Cannot be written as a literal"), and vector ("Not scripted": it has a literal but no
      `=`, so it is left out until a lane writes and round-trips it). Unscriptable wins over ignored: "row_ver
      (ignored): Not insertable". A diff's columns carry Result 3's types, so the comparison records both inputs' column
      types per pair when it is built (as the remembered match reads them, `resolveRemembered`), and the form locks a
      pair by either type while Result 1 is closed. The renderer is untrusted, so `DiffScript` also refuses
      (`INVALID_PARAMS`) a `columns` pair either result's recorded type cannot write (CLR types, sql_variant, vector,
      rowversion and timestamp), except a key pair: a key of the first three takes the `keyType` refusal first, and a
      rowversion or timestamp key pair, which a WHERE compares as binary, is accepted while INSERT is not ticked;
      computed and GENERATED ALWAYS columns, a target's rowversion column paired with another type, and a column the
      target lacks are known only to the index, and an INSERT that names one fails the whole batch when it compiles (Msg
      271, 13536, 273, 207), before any statement runs.
    - A line names columns only one result has ("note2 is only in Result 1, so INSERTs leave it out").
    - While INSERT is ticked and the index knows the table, a line names its columns the result lacks: "INSERTs leave
      created_by and region out, so inserted rows get their defaults or NULL." (not columns the target fills itself:
      rowversion, computed, GENERATED ALWAYS and identity). One that is NOT NULL without a default fails the INSERT, and
      the transaction rolls the script back.
    - While UPDATE or INSERT is ticked, a line names the unticked columns the script would otherwise write: "note is
      unticked: UPDATEs leave its changes out, and inserted rows get its default or NULL." ("note and memo are unticked:
      … their changes …"), each clause only while its statement is ticked and naming only the columns it would write (an
      ignored column only in the INSERT clause, and not one the target lacks, whose reason says it). While DELETE and
      the checks are on, it adds "and DELETEs do not check it" ("…check them"), since a DELETE's WHERE holds only ticked
      columns, and the line shows for that alone when UPDATE and INSERT are unticked. Columns the target fills itself
      (rowversion, computed, GENERATED ALWAYS, an identity left out) have their own lines instead.
    - A data column without a name, whose name the result repeats, or whose name holds a control character, U+2028 or
      U+2029 (the target parts' rule) starts unticked and locked ("No name", "Name repeated", "Name has a control
      character"), since an INSERT could not name it: a query window normalizes line breaks in a bracketed name too.
    - A line names pairs whose types differ ("amount is decimal(10,2) in Result 1 and decimal(12,2) in Result 3. Each
      value is written as its own result's type."). Each value is formatted by its own input's column type. A diff's
      data columns carry Result 3's types (`UnifiedDiff.Columns`) whichever result a value came from, and only One row's
      previous-value columns carry Result 1's, so the diff set also records Result 1's column type (its name, precision,
      scale and maximum length, as `ResultColumn` holds them, since a literal or a key's CAST needs them) and collation
      per pair. Every Result 1 value is formatted by it, even while Result 1 is closed: removed rows in both layouts,
      Two rows' `changedOld` halves (the values a toOld UPDATE SETs), and the WHERE keys taken from them. A literal's
      form always comes from its own input's column type, never another column's: pairs join by name and wire (Text or
      Binary, `ResultDiffer.Pairs`), so `id int` can pair with `id varchar`, and an int rule would copy varchar text raw
      into the script. In a WHERE clause (keys, Q11's guards, the INSERT check) only the text decisions follow the
      column of the side the target holds, Result 1's under `toNew` (One row keeps only Result 3's key values on a
      changed entry) and Result 3's under `toOld`: whether an all-ASCII value is written plain, and whether one that is
      not is refused under a SQL_ collation (Literals below). A key pair whose two types are of different kinds is
      refused, and Q11's guards leave such a pair out. The kinds come from `sortKind`: numbers (integer, decimal, float,
      boolean), text (text, json), dates and times (date, datetime, timestamp), times (time, since SQL Server refuses a
      conversion between time and date), binary (rowversion and timestamp among it), and uniqueidentifier, which
      `sortKind` calls `other` and is told by its type name. So int pairs with decimal, and int with varchar is refused.
      A key pair of one kind whose two recorded types differ (datetime against datetime2(3), int against decimal)
      compares in the target side's type: a WHERE clause wraps the literal, still written by its own column, in a CAST
      to the target side's recorded type, written as the typed casts are (`CAST(CAST('2024-05-01T10:00:00.003' AS
      datetime2(3)) AS datetime)`). Without it the comparison runs in the higher type and can miss the row (a datetime's
      .003 is .00333…), and the INSERT check would then let a duplicate in. A CAST that overflows fails the script under
      XACT_ABORT, and one that rounds onto another key only makes a check THROW. Text and binary pairs are never cast:
      the text decisions already choose plain varchar or `N'…'` by the target's column, and a CAST of `N'…'` to varchar
      converts through the database's default code page, not the column's, so a Cyrillic key in a Windows-collation
      varchar column would no longer match; `=` already ignores differences of length and trailing spaces (text) or
      trailing zero bytes (binary).
    - Identity: when the index says a ticked column is the target's identity, **SET IDENTITY_INSERT** is offered,
      ticked. An identity column is never SET, since SQL Server refuses that: when one that is not a key changed, a line
      says "id is an identity column, so its changes are not scripted". With SET IDENTITY_INSERT unticked, INSERTs leave
      the identity column out, and a line says "Inserted rows get new id values from the target."; when the identity
      column is a key column, it cannot be unticked, since the inserted rows would no longer match their keys: it is
      `aria-disabled` and focusable, described by "id is the key and the target's identity column, so SET
      IDENTITY_INSERT stays on."
    - With Exact text off, values that differ only by collation are equal to the comparison, so they are not scripted. A
      line says so when there are any: "12 values differ only by collation and are not scripted. Turn on Exact text to
      include them."
  - **Rows:** All differences, Rows in the grid (chips and filters) or Selected rows, each with its count. Rows in the
    grid is the default, and the same rows as All differences while nothing is filtered: someone who filtered the
    comparison to one customer gets statements only for the rows they saw. It starts there each time, not from the
    draft, so a filter set since never meets a remembered All differences. While All differences is chosen and chips or
    filters hide differences, the summary adds "All differences includes 35 differences the grid does not show."
    Selected rows are the grid's selection, which holds at least the active cell's row while the grid has rows; an empty
    grid (Rows set to Changes only on a comparison with no differences, or a filter that leaves no rows) has none, so
    Selected rows counts 0. The dialog follows it live, so the option names the keys of the chosen entries that differ
    while there are at most three ("Selected rows (1: id = 1002)", "(2: id = 1002; id = 1004)", the answer's
    `selectedKeys`, joined with "; " since a composite key holds commas), the header's rows line names them too, and
    while Selected rows is chosen, a change to the differing entries it holds says "Selected rows now holds 1 difference
    (id = 1009)." ("…now holds 12 differences." past three, "…now holds no differences." for none), the form the replace
    sentences take, so a click in the grid to look at a cell never changes the script unnoticed; a move that leaves
    those entries as they were (another cell of the same row, a row with no difference) says nothing. In Two rows an
    entry is chosen when either of its halves is. The preview reads them as it shows, and Script reads them again.
  - **Options:** Wrap in a transaction (on), Check each statement changes one row (on; Q2), with the line "UPDATEs also
    check that the row still holds the values they change from, DELETEs the values the comparison saw, and INSERTs that
    the row is not there yet." (Q11). While UPDATE is ticked and some chosen UPDATEs change only columns the check
    cannot compare (the answer's `uncheckedUpdates`), a line under it gives the answer's sentence: "2 UPDATEs change
    only columns the checks cannot compare (note: xml; code: values not all ASCII under its SQL_ collation), so nothing
    stops them with the wrong direction, where they change nothing, or on a row changed since the comparison, which they
    overwrite." While DELETE is ticked and some chosen DELETEs have ticked, compared columns that Q11 all leaves out
    (the answer's `uncheckedDeletes`), a line gives that sentence too: "3 DELETEs check only their keys, since their
    other ticked columns cannot be compared (note: xml), so nothing stops them on a row changed since the comparison, or
    on a same-keyed row of another copy of the table." These lines, and the header's parts for them, show only while the
    checks and their statement are on. Turning off the transaction warns "Without a transaction, statements before a
    failure stay applied.", since a failed check, a key violation or a trigger's error all leave earlier statements in
    place. Turning off the checks warns "Without the checks, a statement runs even when its row is missing, repeated,
    changed or already there, and nothing says so."
  - **Destination:** New Query Editor Window (default) or Clipboard. While the comparison's connection is not open, New
    Query Editor Window is unavailable, with its reason as the destination's description ("SQLDEV01 is not connected, so
    a query window cannot open on it. Choose Clipboard, or reconnect."), and while it is chosen Script is unavailable,
    its description and the summary the destination's sentence, which pressing it says, as an unusable target name's
    sentence is; the choice is not changed for the user. A connection lost while the script is written for a New Query
    Editor Window ends the generation: the window shows the not-connected state with its draft, New Query Editor Window
    unavailable, and Script, which keeps the focus, unavailable with the destination's sentence as its description,
    which the live region says.
  - A **preview** of the first 30 lines (headed "Preview: first 30 lines" while the script is longer), a summary beside
    Script ("Deletes 2 rows, updates 5 rows and inserts 1 row in [Sales_Test].[dbo].[Orders] to match Result 3.", with
    singulars, naming only ticked statements and leaving out zero counts), and **Script** and **Cancel**. While an
    unticked column, or a ticked identity column, has changes (the comparison's `columnChanges`), it says "updates up to
    5 rows", since an UPDATE whose changes are all in unticked columns or the identity column, which is never SET, is
    skipped. While a statement with rows is unticked, the summary adds what stays, so "to match" never reads as a full
    sync: "DELETE is unticked, so 2 rows only in Result 1 stay." ("UPDATE is unticked, so 5 changed rows stay as they
    are."; "INSERT is unticked, so 2 rows only in Result 3 are not added."; "INSERT is unavailable, so …" when a key
    column cannot be inserted). While the chosen rows hold fewer differences than All differences, it adds that too:
    "Rows in the grid holds 5 of 40 differences; the other 35 stay as they are." ("Selected rows holds 1 of 40
    differences; …"), and the announcement after Script repeats the summary. When every count is 0, the summary is "The
    chosen rows have no differences to script."; when only unticked statements have rows, it is "The ticked statements
    change no rows." with the stays sentences ("DELETE is unticked, so 3 rows only in Result 3 stay."), so it never
    reads as if the target already matched. Either way Script is unavailable.
    - The preview asks the backend for its 30 lines (`results.scriptDiff` with `maxLines`) on opening, with or without a
      target and direction, and then 300 ms after the form last changed, cancelling the request before. Each answer
      brings the Rows options' counts. It refuses only what those lines need (a truncated or U+FFFD value among them, or
      a refusal known on opening); the rest are found on Script. A preview line over 2,000 characters (a long value's
      literal) ends in "…", the preview's only cut; the script holds it whole. While it waits, the preview reads "--
      Choose the target table and a direction to see the script." ("-- Choose a direction to see the script.", "--
      Choose the target table to see the script." while only the target is missing, "-- Fix the target table's name to
      see the script." while its name cannot be used), and after a refused answer "-- No preview: the reason is beside
      Script." A request that fails instead (its deadline, or `TOO_LARGE` when the count's working memory does not fit)
      is not a refusal. On opening, its sentence replaces "Reading the comparison…", with **Try again**, which takes the
      focus, is described by the sentence, which the live region says, and sends the request again. Later, the preview
      reads "-- No preview: " and the sentence, with Try again under it; the counts show nothing until an answer brings
      them, the summary reads "The preview could not be read." unless a reason in the summary's order (Keyboard and
      screen readers) holds, and Script stays available only while none does, since its own run says any failure. A
      backend loss is not such a failure: it releases the comparison, so the closed state shows instead, on opening and
      later.
    - The counts and the summary are entries by kind in the chosen rows. All differences reads the diff's own counts.
      Rows in the grid and Selected rows are counted by the backend in a pass over the chosen rows, after one that marks
      them (so a look-alike's partner can be found among them), reserving the bit per stored row as Copy as Diff does;
      in Two rows an entry is chosen when either half is (a value filter on an old value keeps only − halves), as Copy
      as Diff pairs them, so the counts and the script agree. Once a direction is chosen, each statement shows its count
      whether or not it is ticked. Every preview answer carries them, a refused one included, so the counts and the
      zero-count rules hold while a refusal shows. An UPDATE whose changed columns are all unticked is skipped, so the
      counts said after Script, which are the script's own, can be lower.
- **The script:**
  - A header of `--` lines names the comparison, the match and any ignored columns, the server and database, the
    direction, the rows chosen ("N of M differences" while they are fewer than All differences) and any statement left
    out ("-- Rows in the grid: 5 of 40 differences. Not included: DELETE (2 rows)."), what else it leaves out, as the
    form's lines say ("-- Left out: note (unticked); changes to id (identity column); note2 (only in Result 1); 12
    values that differ only by collation (Exact text off); the old-value check for 2 UPDATEs (note: xml); the value
    check for 3 DELETEs (note: xml)."), the left-out reasons as the form's lines give them, and the time, so a reviewer
    reading only the script never takes it for a full sync. It says "Review it before you run it. Varia does not run it
    for you. It leaves XACT_ABORT on." Every name in every header line (results, the query document, key and ignored
    columns, the left-out line's columns, server, database, target) has its control characters escaped (`\t`, `\r`,
    `\n`, and `\uXXXX` for the others, U+2028 and U+2029) and nothing else, so a name holding a line break cannot end a
    comment line and put its text into the script as a statement, and `HOST\SQL2022` or `O'Brien` reads as it is.
  - Then `SET XACT_ABORT ON;` and `BEGIN TRANSACTION;`.
  - DELETEs, then UPDATEs, then INSERTs, so a reused key cannot collide.
    - One statement per row, keyed by the match's key columns, NULL-safe (`[k] IS NULL`).
    - An UPDATE SETs only changed, compared, ticked columns, never an identity column. With the check on, its WHERE
      also holds each of those columns' current value, written as the key values are (`AND [status] = N'Open'`, or
      `[status] IS NULL`), except the columns Q11 leaves out. A DELETE's WHERE holds, the same way, the row's value in
      each ticked, compared column, so it never deletes a row changed since the comparison, or a row of another table
      that only shares the key.
    - Each UPDATE and DELETE is followed by `IF @@ROWCOUNT <> 1 THROW 50000, N'Row id = 1002 was not found exactly
      once with the values the comparison saw.', 1;` (an UPDATE's says "…exactly once with the values it changes
      from."), and each INSERT is preceded by
      `IF EXISTS (SELECT 1 FROM [Sales_Test].[dbo].[Orders] WHERE [id] = 1011) THROW 50000, N'Row id = 1011 is already
      in the target.', 1;` (Q11). DELETEs run first, so a reused key is gone before its INSERT checks. THROW takes only
      a literal or a variable, so the key text there is one plain literal: the raw key text is cut to 200 code points
      first (never inside a surrogate pair), then escaped as a literal: quotes doubled, `\\`, `\t`, `\r` and `\n` for
      backslash, tab, CR and LF, and `\uXXXX` for every other control character (U+0000–U+001F, U+007F–U+009F), U+2028
      and U+2029, never `NCHAR` joins. Copy as Diff escapes only the first four, so this is `DiffScript`'s own rule, and
      the header's names take it without the quotes and backslash. Escaping after the cut means a doubled quote or an
      escape is never split.
  - `COMMIT TRANSACTION;`.
  - When the script turns SET IDENTITY_INSERT on, its body after `SET XACT_ABORT ON;` runs in `BEGIN TRY … END TRY BEGIN
    CATCH IF @@TRANCOUNT > 0 ROLLBACK; SET IDENTITY_INSERT <target> OFF; THROW; END CATCH`: a rollback does not undo a
    SET option, so a failed check or key violation would otherwise leave IDENTITY_INSERT on in the query window's
    session, failing its next ordinary INSERT into the table and any other table's `SET IDENTITY_INSERT … ON`. Cancel or
    a query timeout in the query window is an attention, which skips CATCH: XACT_ABORT still rolls the transaction back,
    but IDENTITY_INSERT stays on, so the header adds "-- If you stop it while it runs, run SET IDENTITY_INSERT
    [Sales_Test].[dbo].[Orders] OFF; in the same window." (Msg 545 otherwise).
  - The New Query Editor Window opens on the comparison's connection, as Script As does, and does not run.
- **Generating:** the footer shows "Writing statements…" with progress in place of the summary, and the form is
  read-only (its controls `aria-disabled`), so the script written is always the form shown. A lookup the dialog would
  ask again meanwhile (a finished index build, a reconnect) waits until the script is written, and a disconnect while a
  Clipboard script is written keeps the facts the form shows until it is written. Script keeps the focus, unavailable,
  with that text as its description, which pressing it (or Enter) says; Cancel is the only action. Cancel, or Escape,
  stops generating, says "Stopped writing the script." and keeps the window open with its draft; the next Cancel closes
  it. A failure (its deadline, `TOO_LARGE`) shows its sentence in the footer in place of the summary, as Script's
  description, with the focus kept on Script and the sentence said in the live region; unlike a refusal it leaves Script
  available, so pressing it again tries again, and the next change the preview follows brings the summary back. A
  backend loss shows the closed state instead. If the chosen rows change while it generates (a replace, chips or filters
  under Rows in the grid, the selection under Selected rows, or another comparison invoking the window; a sort changes
  no statement, so it does not), the generation is cancelled and a line above the summary says "The comparison changed,
  so the script was not written. Script again to write it.", the two Script's description, so the refreshed summary and
  its "N of M differences" stay in sight; the live region says the line after the shipped sentence and any Rows
  sentence; when the change closed the comparison or brought a refusal, it shows that state instead, and when another
  comparison invoked the window it says "The script for Result 1 → Result 3 was not written." before the new pair's
  form.
- **Refused, with the reason in the dialog.** The first four are known when the dialog opens (its first preview request,
  which C# answers before anything else, with or without a target and direction, answers them): the refusal replaces the
  form below its first line (the comparison and its match, so a refusal never hides which comparison it is about), the
  two become the window's description, the live region says the refusal, and the focus moves to its first button
  (Keyboard and screen readers below). One that arises while the dialog is open (the toolbar's Match set to Automatic,
  Compare Rows as Shown ticked) replaces the form the same way: the live region says it, and the focus moves to its
  first button, or Cancel, without activating the window. The rest are found on Script, or by the preview (above): they
  show in the footer in place of the summary, with the refusal's button if it has one, so a form scrolled to Options
  still shows why; the window's live region says the refusal, and Script, which keeps the focus when it was pressed, is
  marked unavailable (`aria-disabled`). It is available again on any change the preview follows: the form, or the
  comparison's sort, filters, chips, selection or a replace. When a refusal that replaced the form clears, after its own
  button or a replace, the dialog's focused element becomes Target table, unless it is Cancel, which keeps it, so an
  Enter meant for Cancel never presses Script (the window is activated only when Choose key columns… opens it again) and
  the live region says the shipped sentence ("Comparison updated: matched by order_no, …"); a replace that fails says
  its sentence in the dialog and keeps the refusal and its focus. While a replace the dialog started runs (its own
  button's, or one applied in the Match menu Choose key columns… opened), the refusal reads "Updating the comparison…"
  with progress, which becomes the window's description and the live region says, and its buttons are unavailable
  (`aria-disabled`, so the pressed one keeps the focus); Cancel cancels the replace first, and the next Cancel closes
  the dialog. When several apply, the first in this list shows. Each refusal says what to do:
  - a comparison of rows as shown (§ 6): "Result 1 is compared as shown, so rows its filters hide show as added or
    removed, and a script would insert or delete them. Compare whole results to script differences. To script only
    some rows, filter the comparison itself.", with **Compare whole results** ("Result 1 and Result 3 are compared as
    shown, so rows their filters hide …" for both). This holds even when both sides have the same filters, since a row
    that changes out of a filter shows as removed. It shows only under key columns the user chose: under any other
    match the not-matched-by-key refusal shows instead, since comparing whole results alone would not help, so a side
    shown only in its sorted order (Row position) never reaches it;
  - a key column a WHERE clause cannot compare or write: "Rows are matched by notes, an xml column, which a statement
    cannot use to find its row. Choose other key columns to script differences.", with **Choose key columns…**. That is
    xml, text, ntext, image, json and vector (no `=`), and CLR types and sql_variant (no literal, as in Columns above).
    A key pair whose types are of different kinds (Columns above) takes the same form: "Rows are matched by id, which
    is int in Result 1 and varchar in Result 3, so a statement could not match its row exactly. Choose other key
    columns to script differences.";
  - a key column without a name, whose name the result repeats, or whose name holds a control character: "Result 3 has 2
    columns named id, so a statement could not name its key. Choose other key columns to script differences.", with
    **Choose key columns…**: renaming the column would mean running the query again, which runs its other statements
    again too;
  - rows not matched by key columns the user chose:
    - Row position, Whole rows, or Automatic that fell back to whole rows: "Rows are not matched by key columns, so a
      statement could not find its row. Choose key columns to script differences.", with **Choose key columns…**;
    - Automatic that chose a key: "Rows were matched automatically by order_no. Choose key columns to script
      differences.", with **Choose key columns…** (the default button) and **Use order_no as key columns**. Automatic
      can pick a column that is unique only by chance, such as a timestamp (§ 1), and keying on it would turn every
      changed row into a DELETE and an INSERT, firing delete triggers and cascades. So **Use … as key columns** is
      offered only when rows paired by that column and it is not a date or time type or rowversion; otherwise Choose key
      columns… is the only button, and where nothing paired the sentence reads "Rows were matched automatically by
      updated_at, but no rows paired by it, since its values are unique only by chance. Choose key columns to script
      differences.";
    - **Choose key columns…** closes the dialog, keeping its draft, brings forward the window that holds the
      comparison's Results pane (the main window, or a popout), shows the pane and the comparison's tab, and opens the
      Match menu at the toolbar's Match button, or beside ⋯ when Match is folded (`MatchMenuFrom` gains `script`). The
      dialog is a child window, always above the main one and opened over the window that holds the pane, so it would
      cover the menu, and a dialog window cannot be hidden (`DialogWindow` only opens, focuses and closes one). When the
      menu closes on Apply, Cancel or Escape, the renderer opens the dialog again from the draft, where it opens (Where
      above), with the focus where an opening puts it (Keyboard and screen readers below), or on Cancel while the
      replace Apply started runs, and the replace refreshes it. When it closes otherwise (a press outside, F6, the pane
      hiding, the comparison closing), the dialog stays closed rather than take the focus back, and Script Differences
      as T-SQL… opens it again from the draft;
    - with an input closed, rows cannot be matched again, so the buttons are unavailable (`aria-disabled`, so they stay
      in the Tab order) and the sentence's last part becomes "…, and Result 1 is closed, so rows cannot be matched
      again." It gives no further advice: running the query again would run every statement in it again, including the
      UPDATE the script was meant to repair. The xml-key and key-name refusals take the same form, the repeated-key
      refusal keeps only "Choose rows without a repeated key.", the key-collation refusal keeps only "Choose rows
      without them.", and the as-shown refusal does the same: "Result 1 is closed, so the comparison cannot be rebuilt."
  - chosen rows with a repeated key (≈): "12 rows share a key, so a statement could change several rows. Choose key
    columns that are unique, or rows without a repeated key.", with **Choose key columns…**;
  - a needed value truncated, or compared by its stored part: "3 values in note were not kept in full (rows id = 1002,
    1007 and 1 more), so the script would not be exact. Choose rows without them, or untick note." (Q3), the keys
    written as the THROW text is, each cut at 40 characters, a one-column key's values joined with ", " and a composite
    key's with "; ", as Selected rows joins them, since its text holds commas ("rows id = 1002, region = 'EU'; id =
    1007, region = 'US' and 1 more"). One value reads "1 value in note was not kept in full", and several columns "5
    values in note and memo were not kept in full, … or untick those columns."; unticking says what it costs (Columns
    above);
  - a needed text value holding U+FFFD: "2 values in note cannot be written exactly (rows id = 1002 and 1007). Choose
    rows without them, or untick note.", with the same singular and several-column forms, and the keys written as the
    truncation refusal writes them, since these values are not marked in the grid. Stored pages already hold U+FFFD for
    a lone surrogate (`PageBuilder.AppendText`) and for bytes a `_UTF8` collation could not decode (`CellLengths`), and
    a genuine U+FFFD cannot be told apart from either, so the script would write U+FFFD over the original. A rare
    genuine U+FFFD is refused too: the cost of never writing a wrong value. The live round trip cannot catch this, since
    both sides store U+FFFD and compare equal, so an offline check does. A subnormal float (Literals below) in a key,
    SET or INSERT takes the same refusal ("1 value in ratio cannot be written exactly (row id = 1004)."), so a statement
    never writes or matches 0 in its place (SQL Server reads such a literal as 0), and Q11's guards leave one out. When
    the values are in a key column, which cannot be unticked, these two refusals are kinds of their own (`keyTruncated`,
    `keyUnwritable`, so the dialog picks the button by kind), end "Choose rows without them, or other key columns." and
    offer **Choose key columns…**, as the key-collation refusal does; with an input closed they keep only "Choose rows
    without them.";
  - a key value of a char or varchar column with a SQL_ collation that is not all ASCII (Literals below): "2 key values
    in code cannot be matched exactly under its collation ('Straße' and 1 more). Choose rows without them, or other key
    columns.", with **Choose key columns…**;
  - no differences in the chosen rows: "The chosen rows have no differences to script.";
  - every UPDATE skipped because its changes are all in unticked columns, with no other statement left: "None of the
    ticked columns changed in the chosen rows. Tick a changed column."; when only the identity column changed: "Only id,
    an identity column, changed in the chosen rows, and an identity column is never SET."; when unticked columns changed
    too: "Of the ticked columns, only id changed, and an identity column is never SET. Tick a changed column.";
  - over 1,000,000 characters, a query window's execute limit: "The script would be about 2,400,000 characters. Scripts
    are limited to 1,000,000 characters, the most a query window runs. Choose fewer rows." (Q5).

  On BigQuery the command is unavailable, so the dialog never opens (Q4).
- **While it is open:**
  - A replace of the comparison refreshes the counts and keeps the draft. So does any change to the comparison's sort,
    filters, chips or selection: the counts, summary and preview follow the grid, as the preview follows the form, so
    what Script writes is what the window shows.
  - A replace resets the selection and every filter but the chips, and can turn off a chip (shipped). When that changes
    the rows the chosen option holds, a line by Rows says so with the new count, and the dialog's live region adds it
    after the shipped sentence: "The comparison's filters were removed, so Rows in the grid now holds 31 differences.";
    "A filter was turned off, so Rows in the grid now holds 31 differences."; "The selection was reset, so Selected rows
    now holds 1 difference (id = 1002)." A refusal's button never changes the rows unannounced. With no difference left,
    a sentence ends "now holds no differences."
  - A screen reader does not read a live region in a window in the background, so of what the dialog's live region said
    while its window was in the background, the latest sentence of each kind (the Rows or selection sentence, the
    document's database line, the changed line, the closed sentence) is said again, in the order they came, when the
    window is activated: a replace started from the main window never widens what Script writes unheard, and choosing
    rows in the grid for Selected rows leaves one sentence, not one per move. A refusal that arose there is not said
    again, since it is the window's description, which activation reads, and a switch to another comparison drops what
    the first pair's form said.
  - The comparison closing (re-run, Close Results, backend loss) says "The comparison was closed." and makes Script
    unavailable (`aria-disabled`).
  - The draft (target and its server, direction, statement ticks, columns, destination) is remembered per pair in the
    tab as it changes, so it is kept however the window closes, in the same 64-pair memory as the match. It keeps the
    target as resolved and shows it in three parts, so a later run never moves it to another database. The draft records
    the document's connection and database when the name was resolved, and when either has changed since, the line under
    the field says so, as above ("In Sales_Test on SQLDEV01. SQLQuery3.sql's database is now Sales_Dev.",
    "…SQLQuery3.sql is now on SQLPROD02.", "…SQLQuery3.sql has no connection now."). The draft records the server too,
    and a target remembered from a comparison on another server says so as a warning, since its draft carries over to a
    server that may be production ("⚠ In Sales_Test on SQLPROD02. The last target was on SQLDEV01."). It keeps unticked
    columns by name, as ignored columns are. The memory follows a swap to the swapped pair, so Swap inverts the
    remembered direction, and the target still holds the same result's rows. Result names repeat across runs ("Result
    1"), so the draft also records the pair's column names, and when the pair's columns are not those, another query has
    taken the names: the dialog starts as the first time (no target or direction, DELETE unticked), with a line by
    Target table ("Result 1 and Result 3 have other columns than last time, so the last target was not reused.").
  - Wrap in a transaction, the row checks and SET IDENTITY_INSERT are not in the draft: they start on (SET
    IDENTITY_INSERT whenever it is offered) each time the dialog opens, as Rows starts at Rows in the grid, so a
    choice made for one script never carries over unseen to a later one, whose lines would sit below the fold. The
    Choose key columns… round trip is the same script, so its reopen keeps them as they were.
  - Invoked from another comparison, the open window switches to it, with that pair's draft, and is activated with
    the focus and description it has on opening; the first pair's draft stays remembered. A switch is an opening for
    the per-script choices: Rows goes back to Rows in the grid and the three options back on.
  - It works while an input is closed: the script reads only the comparison.
- **Keyboard and screen readers:** a labelled form in its own window, Tab order top to bottom. Its sentences are
  descriptions (`aria-describedby`), so Tab reads them: the summary, with its stays and "N of M differences" sentences,
  is Script's; each warning or note is the control's it follows (the look-alike and DELETE lines DELETE's or INSERT's,
  the column lines the column list's, each Options warning its checkbox's, the name's sentence Target table's). Script
  is always in the Tab order: unavailable, it is `aria-disabled`, not disabled, its description is the summary or, while
  one shows, the refusal, and pressing it (or Enter, as the default button) says that sentence in the live region.
  Script with a target name it cannot use puts the name's sentence in the summary and says it. When several reasons
  hold, the summary and Script's description give the first of: the comparison closed, a refusal, "Choose the target
  table.", the name's sentence, "Choose a direction.", "Checking the target table…", the destination's sentence, "No
  statements are ticked.", then the no-rows sentences ("The chosen rows have no differences to script.", "The ticked
  statements change no rows."); Script is unavailable while any of them holds. Until the first preview answer arrives,
  the window shows only the first line and "Reading the comparison…" with progress, the two its description, Script
  unavailable and Cancel, with the focus on Cancel, so a refusal that answer brings never takes the focus from a field
  being typed in. The answer then shows the form or the refusal, and the focus moves to Target table, or to a refusal's
  first button, or stays on Cancel when a refusal has none or its buttons are unavailable (an input closed); the live
  region says a refusal.
  - When the focused control goes away, the focus moves to a fixed place and the live region says the line that replaced
    it: from Rebuild Search Index or Build index when the build ends, to Target table; from a later Try again when an
    answer arrives, to the preview; from a footer refusal's button when the refusal clears (a change the preview
    follows, or a replace), to Script, and a focus already on Script stays there; from any other control that goes away
    (SET IDENTITY_INSERT or Rebuild Search Index when the connection drops, a failed lookup's Try again), to Target
    table.
  - Enter on a button presses that button. In the columns' search field it moves to the first match in the list, and
    with no match does nothing. In the target box, while the suggestion list is open, it picks the highlighted
    suggestion, or with none highlighted closes the list and keeps the typed name; it never presses Script while the
    list is open. Elsewhere it presses Script, the default button.
  - Escape closes an open suggestion list first, and in the columns' search field clears text it holds first. Otherwise
    it is Cancel, with Cancel's two steps while generating (stop, then close). The close button, Alt+F4 and ⌘W close at
    once; while generating they cancel the request first, so no query window opens and the clipboard is left as it was.
  - The preview is a read-only text area.
  - After Script to a New Query Editor Window, the window closes, that editor has focus, and the live region says "Script opened in a new
    query editor window." and the summary ("It deletes 2 rows, updates 5 rows and inserts 1 row in
    [Sales_Test].[dbo].[Orders] to match Result 3.").
    After Clipboard, the window closes, the live region says "Script copied to the clipboard." and the summary, and focus
    returns to where it was, as after Cancel and for other dialog windows.
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
      `UNSUPPORTED_PROVIDER` when the diff set records BigQuery inputs (below): a derived set has no `residence`, and
      `ProviderOf` answers SQL Server for any result outside `ProviderChecks` (only they set `RequestProvider`), so
      neither says so once an input is closed;
    - its reservations (Budget below);
    - the fake backend, and `FakeHandle` in `tests/fixtures/results.ts`.
  - **Params:** `{ resultId, viewId?, rows: ranges (as Copy's parts, but possibly none, since an empty grid has no
    selection: `GridView` answers no active cell with no rows and `resolveBlocks` drops empty ranges, so Copy's
    `.min(1)` would refuse the dialog's opening request), target?: { database, schema, name } (each 1–128 characters, no
    control characters, U+2028 or U+2029; the renderer resolves a two-part name to the query document's database, so it
    always has three parts), names: { left, right, document, server } (each 1–260 characters, for the header, which
    escapes each one's control characters), direction?: 'toNew' | 'toOld', columns: number[], identity?: number,
    statements: { delete, update, insert }, transaction, checkRows, identityInsert, rowsChoice: 'all' | 'grid' |
    'selected' (the rows the script takes, and the header's words), maxLines? }`. Whatever Rows chooses, the renderer
    sends `rows` (the selection) and, while the grid has one, `viewId`, so every answer counts every Rows option.
    `columns` holds distinct pair indexes, at most `limits.page.maxColumns` in zod, each below the pair count (checked
    in C#). `identity` is the pair the index names as the target's identity column, one of `columns` (checked in both):
    only the renderer knows it, from Search Objects. `DiffScript` leaves it out of every SET. With `identityInsert` on
    it wraps the INSERTs in `SET IDENTITY_INSERT`, and writes that, its TRY/CATCH body and the header's stop line only
    when the script holds at least one INSERT, since SET IDENTITY_INSERT needs ALTER on the table and an UPDATE-only
    script must not fail for a login that has only UPDATE; with it off it leaves the identity column out of the INSERTs,
    and refuses (`INVALID_PARAMS`) when that column is a key; `identityInsert` on without `identity` is `INVALID_PARAMS`
    in both zod and C#. `indexReasons?: { pair, reason: 'computed' | 'generated' | 'notInsertable' | 'notInTarget' }[]`
    holds the pairs left out for a reason only the index knows (a computed or GENERATED ALWAYS column of the target, a
    target column of rowversion or timestamp, a column the target lacks), with distinct pairs, at most
    `limits.page.maxColumns`, each below the pair count and none in `columns`, checked in zod and C#, so the header's
    left-out line gives the form's reason ("(computed)", "(generated)", "(not insertable)", "(not in
    [Sales_Test].[dbo].[Orders])") rather than "(unticked)". C# also answers `INVALID_PARAMS` when `columns` leaves out
    a recorded key pair (an INSERT would write its row without the key, and the existence check by key would still
    pass), and on Script when no statement is ticked. It answers the four refusals known on opening (below) before it
    checks `columns` and `identity`, so a comparison keyed on a hierarchyid column or a repeated name gets its refusal,
    with its Choose key columns…, never `INVALID_PARAMS` and a failed preview. The other locked reasons (rowversion, CLR
    types, sql_variant, vector) follow from the recorded types. Script (no `maxLines`) requires `target` and `direction`
    (`INVALID_PARAMS` in both); a preview may leave either out, as the dialog's request on opening does before the form
    has them. Its answer has empty `text` and carries any of the four refusals known on opening (`asShown`, `keyType`,
    `keyName`, `notColumns`), `differences`, `updates` and `softValues`, and, only with a `direction`, which decides
    them (which rows are deleted, and the target side's values and collations), `deletes`, `inserts`, the look-alike
    counts, `uncheckedUpdates` and `uncheckedDeletes`.
  - **Deadline and Cancel:** 120 s in `methodPolicies`, as the other result jobs. The dialog's Cancel cancels the request
    through the protocol's cancel, and the backend drops its chunks.
  - **Preview:** `maxLines?: number` (1–30) answers only the first lines, with `complete: false` when there are more,
    and always the counts for the chosen rows (Params above), even when it refuses (the refusal then comes back as the
    answer's `refusal`, not an error). It reads only the rows those lines need, and skips the size estimate. Each
    preview line is cut at 2,000 characters with "…" while it is written, so a long value's literal is never built whole
    for a preview, and a preview answer stays near 60,000 characters whatever the values (one INSERT of a
    2,097,152-character XML value is about 8.4 million characters as its hex term); the size refusal is Script's.
  - **Answer:** `{ text (≤ 1,000,000 characters), differences: { all, grid, selected }, deletes?, updates, inserts?,
    lookAlikeDeletes?, lookAlikeInserts?, lookAlikeDeletesAlone?, lookAlikeInsertsAlone?, softValues, softValuesCut?,
    uncheckedUpdates?: { count, sentence }, uncheckedDeletes?: { count, sentence }, selectedKeys?, complete, refusal?
    }`. `differences` is each Rows option's count of entries that are not `same`, which the options show beside their
    names and the "N of M differences" sentences read (`grid` is `all` when no view is sent). `uncheckedUpdates` is the
    chosen UPDATEs whose every SET column Q11 leaves out, so their WHERE checks only the keys, counted in the counts
    pass by value, so a preview and Script agree: by type alone for a column Q11 always leaves out, and from the value
    the target holds now (Result 1's under `toNew`, Result 3's under `toOld`), judged by that side's column type and
    collation, for one whose type leaves it to the value (char or varchar under a SQL_ collation or with none recorded,
    a value marked truncated, U+FFFD, a subnormal float), reading only those cells. Its sentence is the backend's, as a
    refusal's is, since only the backend knows the reasons: it names at most three columns, then "and 2 more", each cut
    at 60 characters with its reason (the type, as "note: xml"; "id: int and varchar in the two results"; or by value,
    "code: values not all ASCII under its SQL_ collation", "memo: values not kept in full", "note: values that cannot be
    written exactly", "ratio: values too small to write exactly"), within 1,000 characters. `uncheckedDeletes` is
    counted and worded the same way, over the chosen DELETEs whose ticked, compared columns (at least one) Q11 all
    leaves out, so their WHERE checks only the keys. `selectedKeys` holds the key text of Selected rows' entries that
    differ (each as the row checks write it, `id = 1002`, cut at 60 characters) while there are at most three. The
    look-alike counts are the chosen rows to delete and to insert that have a look-alike (`DiffIndex.Poss`) among the
    chosen rows, and `lookAlikeDeletesAlone` and `lookAlikeInsertsAlone` those whose look-alike the chosen rows leave
    out, told apart by the same reserved bit per stored row, which the marking pass sets for every chosen row before the
    counting pass reads a partner's, and `softValues` the chosen rows' soft values in ticked columns, counted in the
    same pass as the counts and `differences`, so the look-alike and Exact text lines describe the chosen rows, not the
    whole diff. Past a cut tone the change index keeps only changed pairs, so a cut entry's later soft values are not
    counted, and `softValuesCut` says so, turning the Exact text line's and the header's count into "at least 12
    values". A refusal is an answer, not an error, with empty `text`: `refusal: { kind, sentence }`, `kind` one of
    `asShown`, `keyType`, `keyName`, `notColumns`, `repeatedKey`, `truncated`, `keyTruncated`, `unwritable`,
    `keyUnwritable`, `keyCollation`, `noDifferences`, `noTickedChange` and `tooLarge`, and the sentence at most 1,000
    characters, both bounded in the answer schema. Every refusal's sentence, closed-input forms included, is the
    backend's (naming at most three columns, then "and 2 more", each cut at 60 characters, so it stays within its
    1,000), which holds the counts, names and sample values and knows when an input's result was released; the dialog
    chooses only the refusal's buttons and their availability, by `kind`, and never parses the sentence. Past 1,000,000
    characters, estimated first, it refuses with `tooLarge`, well inside the 16 MiB response limit. In a preview the
    counts are the chosen rows' entries by kind; after Script they are the script's own statements, which can be lower
    (Counts above). The backend itself refuses a comparison whose match is not a `columns` match, so Automatic's choice
    can never be scripted by accident (Use order_no as key columns replaces the comparison with that `columns` match
    first), and a comparison of rows as shown. Both read the diff set's records (C3's match and C6's as-shown flags),
    and the WHERE clauses take the recorded key pairs, so the params carry no key columns.
- **Backend `Results/DiffScript.cs`:** literals by the column's `dataType`, precision and scale:

  | Type | Literal |
  | --- | --- |
  | Integers; decimal, numeric, money, smallmoney | As stored; decimals exactly |
  | float, real | Stored as G15 and G7 text: that text when it reads back as the value, else the exact value kept beside it (`PageLengths.TryExact`, in CellLengths.cs), written round-trip. Always with an exponent (`3.0000000000000004E-1`, `1E0`): without one, T-SQL reads the text as a numeric literal, whose conversion to float may not round correctly. A real is written as its value widened to double, in that double's round-trip text (0.1 as `1.0000000149011612E-1`): a literal is a float, and comparing it with a real column widens the real, so the shorter `1E-1` would find no row as a key or in Q11's guard, while the widened value is exact both compared and assigned, with no decimal → double → real double rounding. A non-zero float smaller in magnitude than 2.2250738585072014E-308 (subnormal: SQL Server stores one that arithmetic produces, but reads its literal as 0) is refused as a value that cannot be written exactly; a real widened to double is never subnormal |
  | bit | 0 or 1 |
  | char, varchar, text; nchar, nvarchar, ntext | `N'…'` with `''` escaping. A non-N literal is read in the database's default code page, so even char columns get `N'…'`, converted to the column's collation on assignment. CR, LF, U+0085, U+2028, U+2029 and every other control character but tab are written as `NCHAR(n)` joins (`N'a' + NCHAR(13) + NCHAR(10) + N'b'`): the query window's model normalizes line breaks and the clipboard may convert them. A joined value over 4,000 characters starts with `CAST(N'…' AS nvarchar(max))`, since joining shorter strings stops at 4,000. A value that would need more than 64 joins (pretty-printed JSON or XML, a long multi-line note) is written instead as one exact term, `CAST(0x<its UTF-16LE bytes> AS nvarchar(max))`: a chain of thousands of `+` terms risks SQL Server's nesting and expression limits (errors 191, 8631, 8632), which would fail the statement and roll the script back. The size estimate counts its 4 hex digits a code unit. In a WHERE clause (keys, Q11's guard, the INSERT check) a char or varchar value that is all ASCII is written in a plain form instead, varchar end to end: `'…'`, its control characters joined with `CHAR(n)` (an `NCHAR` term would make the whole expression nvarchar again), a joined value over 8,000 characters started with `CAST('…' AS varchar(max))` (non-max varchar joins stop at 8,000), and past 64 joins `CAST(0x<its ASCII bytes> AS varchar(max))`: ASCII has the same bytes in every code page, and the comparison then follows the column's own collation, while under a SQL_ collation a varchar column compared with `N'…'` follows Unicode rules, so `N'ss'` also matches a stored 'ß'. A value that is not all ASCII from a column with a SQL_ collation (`ResultCollation.SortId` ≠ 0), or with no recorded collation (`SqlClientCollation.Of` can answer none), cannot be matched exactly: as a key it is refused, and Q11's guard leaves it out. Under a Windows collation it is written `N'…'`, which compares by the same rules |
  | date, time(n), datetime2(n), datetimeoffset(n) | ISO 8601 text in a `CAST('…' AS <type>)` of the column's own type and precision |
  | datetime, smalldatetime | `CAST('yyyy-MM-ddTHH:mm:ss.fff' AS <type>)`: the stored `yyyy-MM-dd HH:mm:ss` form depends on DATEFORMAT and language, the `T` form does not |
  | uniqueidentifier | Quoted |
  | binary, varbinary, image | `0x…` |
  | xml | `CONVERT(xml, N'…', 1)`, with the same joins or hex term inside. Style 1 keeps whitespace as written; SQL Server already serializes whitespace-only text nodes as character references (`&#x20;`), which style 0 keeps too, so it is a safeguard, not a need |
  | json | `N'…'`, with the same joins or hex term |

  - **Changes to the diff** that only C4 needs:
    - Exact floats by their own column. `UnifiedDiff.Row` keeps a float's exact value only when Result 3's column holds
      one (`ColumnTypes.HoldsExact(set.Columns[p])`), so a Result 1 float paired with a Result 3 decimal keeps only its
      G15 text in removed rows and `changedOld` halves. `Row` tests the source column instead (Result 1's on that
      side), as `Previous` already does.
    - A cut tone lists only the first changed cells, so `DiffScript` takes an entry's changed pairs (its SET columns
      and Q11's) from the change index's full list whenever the tone was cut, which C3 keeps in both layouts (§ 4a).
    - Three more records on the diff set, written in `DiffWritten` beside the match C3 records: Result 1's column type
      (name, precision, scale and maximum length) and collation per pair (Columns above, Literals); whether the inputs
      were BigQuery results (`residence` set), for the refusal; and the names of columns only one result has, as the
      diff answer's `OneSided` lists them (at most `MaxDiffColumnNames` a side), for the header's left-out line, which
      must be written while Result 1 is closed.
  - Names are bracket-quoted by the existing shared `ScriptFormatter.Quote`, unchanged: it has many callers (Script As,
    restore, the alter and DML templates among them), so a control character in a target name (NUL and line breaks
    among them) is refused by the request's zod schema and by C#'s request validation instead.
  - The backend never runs this text. The "SQL the backend runs" rule (server-side `QUOTENAME`) is about executed SQL. An
    offline lint pins that `DiffScript` output never reaches a `SqlCommand`, as ScriptPipeline never executes DDL.
- **Budget:** the text is built in 1 MiB chunks charged as working memory (2 bytes a character, at most 2 MB) and
  released after the answer. Rows are read through `RowAccess`, with no copies. Rows in the grid and Selected rows read
  through a view, so pairing a changed entry's halves takes the same bit per stored row as Copy as Diff, reserved first.
  `SqlService`'s dispatch hands the job to `DiffScript`, as copy and export go to `ResultJobs`, so the reservations live
  there and `DiffScriptChecks` refusal checks on a low budget pin them (the lint's reservation checks read only
  `SqlService.cs`).
- **New method `explorer.scriptTarget`, on the explorer lane.** No method gives the renderer what the target field
  needs: `explorer.search` hits carry an object, label, range and subtype (`src/shared/explorer/search.ts`), and
  `tables.columns` asks the server for names and types. The index already holds each column's type, nullability,
  identity, computed and default flags (`ObjectSearchSql.TypedColumns`), so this method reads them through
  `IndexLookup` (`Database()` with its state and gaps, `Objects()` comparing names by the catalog collation's case,
  `Columns()` with each column's type and flags) and never queries the server. The index gains one flag, GENERATED
  ALWAYS (`generated_always_type`, version-gated as Object Explorer's column query reads it in `ExplorerQueries`), a
  new `TypedFlags` value, since a temporal table's period columns show in `SELECT *` and an INSERT or SET naming one
  fails the whole batch when it compiles (Msg 13536 and 13537).
  - **The places it touches:** `RpcMethods`; a strict zod schema beside `objectSearchParamsSchema` in
    `src/shared/explorer/search.ts`, mapped in `validation.ts`, its new limits in `objectSearchLimits` and their C#
    mirror, which `tests/object-search.test.ts` compares; `methodPolicies` (explorer lane, 15 s as `explorer.search`,
    `providers: ['sqlserver']`); a preload method; main's cancellable explorer requests, where only the method union in
    `src/main/index.ts` gains it, since `cancellableRequests` (`src/main/backend/renderer-requests.ts`) already takes
    every `explorer.` method, registered by its `requestId` and cancelled through `explorerCancel`; the fake backend
    (`tests/fixtures/backend.mjs`, whose HELLO lists `backendMethods`), which answers it from a fixture for the smoke
    runs; and a `SqlService.DispatchAsync` case handing it to `ObjectSearchService`, with its `MethodNames` entry, a
    `LaneOf` entry (a method `LaneOf` does not name runs on the Metadata lane, whatever `methods.ts` says) and records
    in `Contracts.cs`.
  - **Params:** `{ connectionId, requestId, text (the field's typed name, for suggestions, at most 800 characters: three
    bracketed 128-character parts with every ] doubled), table?: { database, schema, name } (the target as the renderer
    resolved it, a two-part name in the database it was resolved to, each part 1–128 characters), columns (every pair's
    name in pair order, compared and ignored alike, since an INSERT names both: at most `limits.page.maxColumns`, each
    0–128 characters, since an unaliased expression pairs with its namesake unnamed column and an empty name matches
    nothing), ignored? (the indexes into `columns` of the ignored pairs, distinct, each below its length), limit (1–20)
    }`.
  - **Answer:** `{ suggestions: { database, schema, name, holds? }[], table?: { columns: { name, type, nullable,
    identity, computed, generated, hasDefault }[], columnsCut?, pairs: (number | null)[] }, state?, held? }`. `holds`
    counts the compared names (those not in `ignored`, and not empty) a table holds, and only a suggestion from a read
    with its columns has it; `state` and `held` describe the database of the sent `table` and come only with one, since
    the first time's opening request and a suggestion-only request send none. `pairs` gives, for each sent name, the
    index of the table's column it names, or null when the table lacks it, compared as `Objects()` compares names (the
    database's case, and the dotted I of Turkish and Azeri collations), since a case-sensitive database's [ID] is not
    its [id] and the renderer knows no collation; the dialog reads every fact for a pair through it (identity, computed,
    generated, the type, and a column the table lacks). Suggestions are at most limit tables whose name holds the typed
    text's last part, found as Search Objects' literal search finds a name (`SearchMatcher`, without case) by a scan of
    each held read's tables, since `IndexLookup.Objects()` finds only exact names; a schema or database part typed must
    equal that part, compared as `Objects()` compares, and empty text lists every table by rank. They are ranked with
    those holding every compared column first, then by `holds`, those without `holds` last, the renderer putting the
    query document's current database first among equals, then by name, leaving out history tables (subtypes `history`
    and `ledgerHistory`), since an INSERT into one fails (Msg 13559), and dropped ledger tables (`droppedLedger`), which
    refuse every change. An append-only ledger table, which refuses UPDATE and DELETE, is kept, since the index does not
    record that kind; such a script fails and rolls back. `table` answers the sent `table` when the index holds it, so
    two databases that both hold `dbo.Orders` are told apart, with at most 4,096 columns (`columnsCut` past that).
    `state` is that database's state from `Database()` (ready, partial, building, skipped or absent), and `held` says
    whether the index holds a read of it with its columns (`LookupDatabase.Held` set, `LookupGaps.ChildrenLeftOut` clear
    and the held read not `FailedPart`, since a read that failed part way, kept when nothing was held before, can stop
    before its columns), whatever `state` says: a read without definitions (`objectExplorer.search.definitions` off),
    with a cut definition or without system objects is partial and still holds every column, a rebuild running over an
    earlier read is building, and a failed read after an earlier one is skipped, each with that earlier read still
    answering. The dialog keys every column fact on `held`, and `state` only picks the sentence: unless `held`, it
    claims no column facts and says still indexing (building), skipped (skipped), indexed without columns (partial) or
    the table unknown (absent); with `held` and a building or skipped `state`, the knows line adds that its facts are
    from the last index.
  - **Tests:** a new offline suite in Program.cs's `offlineSuites` over a built index: ranking by compared columns held,
    three-part suggestions across two databases with the same schema and the sent `table` choosing between them, a
    table's identity, computed, generated, NOT NULL and default flags, history and dropped ledger tables left out, the
    4,096-column cut, a database read without its columns, no index, `held` with `state` partial for a read without
    definitions, one with a cut definition and one without system objects, `held` with `state` building for a rebuild
    running over a held read and skipped for a failed read after one, a name typed as a fragment, with a schema part and
    with a database part, `pairs` for a name differing only by case in a case-sensitive database and in a
    case-insensitive one, an ignored name the table lacks (null, and not counted in `holds`), an unnamed pair (null, not
    counted in `holds`), a read kept after failing part way (not `held`), `state`, `held` and `holds` absent without a
    sent `table` or for a read without columns, and `LaneOf` naming the method as Explorer; vitest for the schema's
    bounds against `objectSearchLimits` (an empty name accepted), a request sent while one runs (the first cancelled
    through `explorerCancel`, no `DUPLICATE_REQUEST`), and the dialog's index line from a fake answer.
- **Renderer:**
  - The dialog is a `DialogWindow` of the new kind in `dialogWindowKinds` (`src/shared/popouts.ts`), which also widens
    the `dialogWindowName` pattern (today `options|about|connect`). `DialogWindow` takes the window to open over, the
    one holding the comparison's Results pane, where today `dialogWindowBounds` centres on the main window and keeps one
    position per kind; for this kind the remembered position is kept per kind and holder (the main window, or a popout),
    and main's rule stays: a position main refuses as off every display (`onDisplay`, checked in `openDialog`) is tried
    again centred over the holder, as `openHost` retries today. The window stays the main window's child.
    popout-windows.md § Dialog windows gains the kind and that rule, and its "At most four" follows `maxWindows`, two
    per kind (eight with Connect's kind and this one).
  - New Query Editor Window opens through the document service with the connection, as Script As's destination does.
  - Clipboard goes through the existing clipboard path.
  - The table suggestions and the index line read `explorer.scriptTarget`, 300 ms after Target table last changed,
    cancelling the request before through `explorerCancel`: the Search Objects index is the single metadata source, and
    the dialog never queries the server.
- **Catalogues:** command `output.compareScript` (the submenu, More results tools with access key Q, palette;
  `providers: ['sqlserver']`, with Q4's hint on BigQuery). Regenerate the commands docs. No setting.
- **Tests:**
  - `DiffScriptChecks` goldens, a new offline suite in Program.cs's `offlineSuites`:
    - an UPDATE-only script with an identity key and `identityInsert` on, and one whose chosen rows have no inserts,
      each with no SET IDENTITY_INSERT, TRY/CATCH body or stop line;
    - every SQL Server type in `sortKind`'s table, plus uniqueidentifier, with sql_variant, vector and CLR types
      refused;
    - an int key paired with a varchar key holding `1) SELECT 1; --`, both directions, refused as a key pair of
      different kinds, and such a pair left out of Q11's guards; an int key paired with a decimal key accepted; a
      datetime key paired with a datetime2(3) key, both directions and with each result as the datetime2(3) side (so a
      cast to Result 1's type needs its recorded scale), cast to the target side's type, its UPDATE matching its row and
      its INSERT check finding an existing one; a varchar key paired with an nvarchar key, both directions, never cast;
      a date key paired with a time key refused;
    - a rowversion key accepted with INSERT unticked; a subnormal float as a key refused and as a guard left out;
    - the look-alike and soft counts for Rows in the grid and Selected rows, and the alone counts with the − chip
      pressed and with Selected rows on one ? row; a refusal naming four long columns, cut;
    - `columns` without a key pair, and Script with no statement ticked, each `INVALID_PARAMS`; an opening preview of a
      comparison keyed on a hierarchyid column, and one keyed on a repeated name, each answering its refusal, not
      `INVALID_PARAMS`;
    - the header's SET IDENTITY_INSERT OFF line for a stopped script, only while SET IDENTITY_INSERT is on;
    - the header's left-out line with Result 1 closed: one-sided, unticked and identity columns, and each of
      `indexReasons`' four reasons; `indexReasons` with a repeated pair, a pair in `columns` or a fifth reason
      `INVALID_PARAMS` in both;
    - `uncheckedDeletes` for a DELETE whose only ticked compared column is xml; neither in an answer without a
      direction; `uncheckedUpdates` alike in a preview and in Script (an UPDATE changing only an xml column, one
      changing only non-ASCII varchar under a SQL_ collation, and one with an ASCII value there, which is checked; under
      `toOld` too, with the SQL_-collated varchar on only one side); `selectedKeys` for one to three entries and none
      past three;
    - an empty grid: `rows` with no ranges answers 0 for Selected rows and Rows in the grid, and the diff's counts for
      All differences, never `INVALID_PARAMS`;
    - a preview with no target or direction: empty `text`, an opening refusal, `differences` for all three options,
      `updates` and no delete, insert or look-alike counts; Script without either `INVALID_PARAMS`;
    - quoting, NULL keys, composite keys;
    - both directions, statement order, the row checks and their cut key text;
    - Two rows filtered by an old value, so only − halves are in the grid: the counts, the summary and the script agree;
    - a preview of a 2,097,152-character XML INSERT, cut to 2,000 characters a line, with the working memory it charged
      near that line's size, not the hex term's; each refusal's `kind`;
    - Q11's old values in an UPDATE's WHERE: NULL, each type it leaves out, a truncated or U+FFFD value left out, a
      real key and guard compared exactly, both directions; the same in a DELETE's WHERE; the INSERT check with NULL
      and composite keys;
    - identity insert, an identity column never SET, collation-only values left out under Exact text off;
    - the TRY/CATCH body when IDENTITY_INSERT is turned on, and none otherwise;
    - float values whose text does not read back, datetime in the `T` form, char values as `N'…'`;
    - the refusals, a match that is not `columns`, and a comparison of rows as shown;
    - a lone surrogate read through `PageBuilder`, and a `_UTF8` value SqlClient could not decode, each reaching the
      U+FFFD refusal;
    - a value with CR, LF, NUL and U+2028, and one over 4,000 characters with line breaks, written with `NCHAR` joins and
      the `nvarchar(max)` cast; a key with those characters in its THROW message, and one with a quote straddling the
      200-point cut;
    - Result 1 values by Result 1's types in both layouts (a float against decimal whose G15 text does not read back,
      datetime against date);
    - a cut Two rows entry, whose UPDATE SETs every changed column, not only the tone's;
    - the hex term at 65 joins and not at 64; xml as `CONVERT(…, 1)`;
    - names with line breaks in every header line (a key column and an ignored column among them), written escaped,
      names with a backslash or a quote written as they are, and target parts with control characters refused;
    - identity with SET IDENTITY_INSERT on and off, and off refused for an identity key;
    - floats with 17 significant digits and none after the point, written with an exponent; a subnormal float
      refused, and a subnormal real written widened;
    - a char key and guard with no recorded collation taking the SQL_ path;
    - char keys and guards: all-ASCII values written plain, with `CHAR` joins, the varchar(max) cast and the varchar hex
      term, never an nvarchar term; others refused (keys) or left out (guards) under a SQL_ collation and written `N'…'`
      under a Windows one;
    - key columns a WHERE cannot use, unnamed and repeated names, an identity pair never SET, pairs whose types differ;
    - a `columns` pair of each unwritable type (CLR, sql_variant, vector, rowversion) refused as `INVALID_PARAMS`;
    - WHERE values by the column of the side the target holds: a key from Result 3 under `toNew` against Result 1's
      SQL_-collation varchar column refused when not all ASCII.
  - A **live round trip** (`VARIA_TEST_SQL_SCRATCH`): two scratch tables with every type (multi-line and
    control-character text, a value with 10,000 line breaks, an xml value stored with style 1, 17-digit floats, a
    subnormal real, a real key column, and a varchar key and guarded column under SQL_Latin1_General_CP1_CI_AS holding
    'ss' beside 'ß' and 'ss' + CR beside 'ß' + CR, only the 'ss' rows changed, and a non-ASCII key in a
    Windows-collation varchar column whose code page differs from the database default, included), compare their
    SELECTs, script, run the script on the target, then compare again and expect no differences. Run it in both
    directions, and under a non-English language and DATEFORMAT. Then run a script of the wrong direction, once whole
    and once with only INSERT ticked (with SET IDENTITY_INSERT, so its THROW comes inside the IDENTITY_INSERT body and
    exercises the CATCH), and one whose deleted row was changed after the comparison, and expect the check's THROW, with
    the target unchanged and, in the same session, an ordinary INSERT into the identity table succeeding
    (IDENTITY_INSERT was turned off). It is a new live `Suite(...)` with a `LiveGroups.Suites` entry, and its CI seconds
    go in docs/ci.md's table.
  - vitest: a `results-port.test.ts` case sending every new `results.scriptDiff` member (`viewId`, `identity`,
    `indexReasons`, `maxLines`, `rowsChoice`) and checking each reaches the backend request, as the diff layout's case
    does, and a `worker-core` case for the rebuilt request.
  - vitest for the dialog: states, counts per direction, locked and unticked columns, warnings, the comparison replaced
    or closed while open, switching to another comparison, Enter and Escape in the suggestion list and on buttons, the
    draft memory, multipart target names, the Automatic and as-shown refusals and their buttons, the closed-input form
    of the key refusals, refusals said in the live region, Cancel while generating, the comparison changing while it
    generates, the INSERT line for target columns the result lacks, the refusal's buttons chosen by `kind`
    (`keyTruncated` and `keyUnwritable` with Choose key columns…, their ordinary forms with none), the form's
    descriptions, Script focusable while unavailable, the safety options and Rows starting fresh each time, the server
    line and a two-part name after Change Connection, a switch to another comparison resetting the per-script choices,
    the header's left-out line, the preview's waiting and refused states, suggestions unhighlighted, the request on
    opening (no target or direction) filling the Rows counts and showing an opening refusal, the reading state before it
    with the focus on Cancel, a failed preview request on opening and later (a backend loss showing the closed state),
    the changed line above the summary and a sort not cancelling a generation, the form read-only while generating and a
    failure beside Script, the background replay (the latest sentence of each kind, a refusal left to the description,
    dropped on a switch), the remembered position kept per holder while it is on a display, Script's description while
    generating, the stop sentence and Script available after a generation failure, the updating state's focus and
    description, the unchecked line's backend sentence, both identity sentences, the unticked line's DELETE clause, the
    unchecked-UPDATEs line, Selected rows' keys and its sentence said only when the differing entries change, the
    key-name refusal's button, the look-alike lines for rows whose look-alike is not chosen, the column list as one Tab
    stop with its search field, the index sentences (the table unknown with Rebuild Search Index, still indexing,
    indexed without columns, a column unknown, over 4,096 columns) and the request again when the index build finishes,
    the unchecked lines hidden while their statement is unticked, the remembered-direction line and its hiding once the
    direction changes, the not-connected state (no request, New Query Editor Window unavailable, the facts back on
    reconnect), Rebuild Search Index keeping the focus and saying the rebuild, the no-index and skipped sentences, the
    document's database first among equal suggestions, the locked SET IDENTITY_INSERT's description, a temporal table's
    period columns locked as generated, an ignored expression column the target lacks starting unticked with its reason
    and warning once ticked again, a target rowversion column paired with a binary(8) column locked as not insertable,
    the knows line from a held read while a rebuild runs and after a definitions-off read, a two-part name kept when the
    document's database changes (the line, said and said again on activation), Script waiting for a pending lookup
    ("Checking the target table…") and facts sent only from the answer for the sent target, a failed lookup's sentence,
    a two-part name resolved to a disconnected document's kept database, Script's destination sentence while
    disconnected, a connection lost while generating, the focus after Rebuild Search Index, a later Try again and a
    footer refusal's button go away, Enter and Escape in the columns' search field (Enter with no match doing nothing),
    Script pressed inside the 300 ms wait before a lookup saying "Checking the target table…", the field rewritten in
    three parts when the document's database or connection changes, the connection lines (now on another server, no
    connection now) winning over the three-part line, the draft recording the document's connection, an ignored column
    the target lacks left out of the ignored line, the failed lookup's Try again while it runs and failing again, a
    disconnect while a lookup is pending showing the not-connected state, the focus staying on Cancel when a refusal
    that replaced the form clears, a lookup held while the script is written, the no-connection sentence, the three-part
    line for another database, the opening request carrying the draft's target with Script checking until it answers, a
    failed lookup's Try again, the summary's order with a failed preview leaving Script unavailable while a reason
    holds, the not-connected state after a connection lost while generating, the focus staying on Script when a footer
    refusal clears and falling back to Target table, a two-part target in a database beside another holding the same
    table, the key-column form of the truncation and U+FFFD refusals, closing while generating opening nothing, Enter in
    Target table with nothing highlighted, the window over a popped-out Results pane, a cancelled generation giving way
    to a closed or refused state, and the Clipboard announcement.
  - Smoke: open the dialog window by role, script to a New Query Editor Window, and find `BEGIN TRANSACTION` in the
    focused editor. A frameless OS window can behave differently on Linux, so run it through `npm run test:smoke:wsl`
    before pushing.
- **Risks:**
  - A wrong literal corrupts data when the user runs the script. Mitigations: the round-trip live test over every type,
    the row checks, the transaction, refusing truncated values, and never running it.
  - Result column names may be aliases rather than table columns: the index warning and the checklist cover that.
  - A script stopped while it runs (Cancel, a query timeout) skips its CATCH, so SET IDENTITY_INSERT stays on in that
    session until the header's OFF line is run; the next ordinary INSERT into the table fails (Msg 545), which is safe.
  - varbinary keys that differ only by trailing zero bytes are two keys to the diff but one to SQL Server (`0x01 =
    0x0100`); the row checks THROW, so it fails safely.
  - A target char column whose collation lacks a character stores `?`, as any assignment would. The index does not know
    the target's collations, so the dialog cannot warn.
  - All-ASCII char and varchar keys are written plain, so they seek. A key that is not all ASCII is refused under a SQL_
    collation, and written `N'…'` under a Windows one, which converts the column and scans: slow on a large target, but
    exact. The target is assumed to share the result column's collation, since the index does not know collations; if
    it differs, the row checks THROW rather than change a second row. A later refinement can write `CAST(N'…' AS
    varchar(n))` where the index knows the column.

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
- The search box's visible count stays "2 of 10": a listed changed cell draws `old → new`, so the old value is in
  view; a cell past a cut tone draws only its new value, so while it is the current match its tooltip shows the old
  value too, as the live region's old value says.
  The live region, which says "2 of 10 matches" today, appends ", old value 5120.00" (cut like the cell text) for a
  match only in the old value.
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
- **Renderer:** the live region reads `matchOld`. The old value they name is read from the hidden
  previous-value column through the window read the gutter already uses for hidden columns.
- **Tests:**
  - `ResultSearcher` checks: an old-only hit, both sides deduplicated, order kept, a cut row's old value, NULL old values,
    view order, page skipping with the new filters.
  - vitest for the status text.
  - The fake backend's search implements it. A `results-smoke.mjs` step searches an old value in One row.
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
    there is something to apply: either input has filters, or a sort while the popover's match is Row position ("Result
    1: 120 of 5,000 rows · Result 3: all 4,980"). Then it replaces the popover's shipped warning about sorted or filtered
    inputs. It is remembered per pair.
  - The choice defaults to Whole result, as today; the pair's remembered choice wins.
  - When the run already has the popover's pair, the button reads **Update** when Compare each result differs from that
    comparison's, as it does for Exact text, or when As shown is chosen and that comparison is out of date, and
    **Show It** otherwise.
  - The shipped notice ("Filters and sorts on the inputs were not applied: …") gains **Compare rows as shown** when
    there is something to apply. A comparison read as shown never shows that notice: its own notice replaces it.
  - **Compare Rows as Shown** is a checkbox in the Comparison submenu, More results tools and the palette. Unticked, it
    is unavailable while there is nothing to apply, with the hint "Neither result is filtered." ("Neither result is
    sorted or filtered." under Row position). Ticked, it stays available, so it can always be unticked, except while
    an input is closed (below).
  - Compare with Previous Result uses the pair's remembered choice, else Whole result, as today.
- **Showing it:**
  - The sides bar marks a side read as shown with a funnel and "120 of 5,000", its tooltip listing the filters and sort.
  - The name reads "Differences: Result 1 (as shown) → Result 3". A side gets "(as shown)" when it has filters, or,
    under Row position, a sort, since then its order decides the pairing. That is the one meaning of "read as shown":
    the diff set records it per side, and Script Differences refuses only then. A build with nothing to apply (a
    remembered As shown choice while no side has filters or, under Row position, a sort, or an Update after the filters
    were removed) records `inputs: 'whole'`: a whole-results comparison, with no notice, `comparisonAsShown` false, and
    never out of date. Such a comparison is whole in every respect: its own choice becomes Whole result, so its later
    replaces (Match, Ignore, Layout, Update) read whole results and Compare Rows as Shown shows unticked, and only the
    pair memory keeps As shown, for the popover's next run and Compare with Previous Result.
  - A notice with **Compare whole results**: "Compared as shown: Result 1 shows 120 of 5,000 rows." For a side read
    only in its sorted order (Row position) it says "Result 1 is read in its sorted order", and two sides join with
    "; ".
  - Gutter row numbers stay each input's **stored** row ("row 4,312 in Result 1").
- **Out of date** (Q9): an input's filters change (Keep Selected Rows included), or, under Row position, its sort. Then:
  - The caption shows "Out of date: Result 1's filters changed since this comparison was made." ("Result 1's sort",
    "Result 1's filters and sort", or "Both results' filters" as it applies) with **Update**
    (tooltip "Compare the rows the results show now"), as Pivots do. In Tabs its tab gets a dot, and the strip says so.
  - Under key or whole-row matching a sort alone changes nothing, so it does not mark it. Re-applying the same filters
    does not mark it either.
  - **Update** (Comparison submenu, access key U, as Update Pivot) replaces it over the inputs as shown now, dropping
    "(as shown)" from a side with neither filters nor, under Row position, a sort. While the comparison is up to date
    it is unavailable, as Update Pivot is, with the hint "The comparison is up to date."
- **Other changes.** Match, Ignore, Layout, Rows, Exact text and Swap read the inputs as shown now. While it is not out
  of date, that is the same rows. While it is out of date, they also update it, and their announcement says so after
  the shipped sentence: "Comparison updated: matched by id, 4 changed, 3 added, 1 removed. Result 1's current filters
  were applied." ("Result 1's current sort was applied.", "…filters and sort were applied.", "Both results' current
  filters were applied.", as the caption reads, or "Result 1 has no filters now, so it is compared whole." when they
  were cleared). Swap swaps which view each side reads.
- **Memory:** when All rows is refused for memory and an input has filters, the refusal also offers Compare rows as
  shown.
- **States:**
  - It waits for an input's unpublished view, as Pivot does.
  - An input with no rows as shown compares as all removed or all added, and the notice says "Result 1's filters leave
    no rows, so every row shows as added." When both do, it says "Neither result's filters leave any rows, so there is
    nothing to compare." in place of "No differences."
  - Closed inputs disable Update and the checkbox with the reason.
- **Interactions:** under Row position the sorted orders pair. Under key matching the + side's view, as it was at build,
  orders the output; a later sort alone does not mark it out of date, since pairs and counts are unchanged, and the next
  Update or other change picks up the new order. Navigation, chips and the overview strip work on the comparison as
  usual.

### Technical sketch

- **Protocol:** `results.diff` gains `leftView?: number` and `rightView?: number`, view ids as in `results.pivot`'s
  `viewId`, on every step of the results path. The answer gains `leftRead` and `rightRead`, the rows read. They are not
  named `leftRows`, which `CompareInfo` already uses for stored rows.
  - Closing a view returns its charge at once (`ResultStore.CloseViews`, and `AddView`'s eviction), so the diff does not
    keep a closed view's order uncharged. As search, profile, distinct and pivot do, it checks `store.HasView` again
    after its read and answers `VIEW_NOT_FOUND` when a view closed meanwhile, which the renderer's one re-ask below
    covers.
  - A view of another result, or a closed one, answers `VIEW_NOT_FOUND`. A result keeps at most 8 views, so a view
    closed meanwhile is re-asked by the renderer, once; a second `VIEW_NOT_FOUND` is the comparison's failure.
  - A remote view answers `REMOTE_RESULT`, BQ-3c-1's case.
  - `ResultClient.diff`, which compares a view's base result today, passes the view ids.
- **Backend (the large part):**
  - `ResultDiffer.Compare` and `UnifiedDiff.Write` walk sealed pages in stored order, split across threads, with
    packed-page rooms tuned for near-stored order.
  - Reading through a view's order over packed pages is search's `ByPages` problem: it needs the view's inverse (4 bytes
    a row of the input), reserved where it is read, as `ResultSearcher.ByPages` reserves its own, and pinned the same
    way, by a refusal check (`FusedReadChecks`'s pattern) rather than the lint.
  - The model's row numbers stay stored rows, so the gutter, identity and highlights are unchanged.
  - The diff set records its input result ids, as now, and, beside the match C3 records, whether each side was read
    as shown, with its rows shown and its rows, which C4's refusal and Copy as Diff's header read. It keeps no view.
    If C3 has landed, C6 also writes Copy as Diff's as-shown header lines (§ 4a).
- **Renderer:**
  - `CompareService` passes the inputs' current view ids (`TabResults.sorts`), through `worker-core.ts`'s member-by-member
    rebuild as every results-path step. It keeps `inputs: 'whole' | 'shown'` in the
    options and the pair memory, and records each input's resolved filters and sort keys at build.
  - Staleness is a pure `comparisonOutOfDate`, beside `pivotOutOfDate` (ResultsService). It compares the recorded filters
    with `shownFilters`, and the recorded sort keys only under Row position. No events are needed.
  - The caption and dot reuse the Pivot's components.
  - Context keys: `comparisonAsShown` (a side read as shown, as the comparison recorded at build),
    `comparisonOutOfDate`, and `comparisonInputsShowable` (an input has filters or, under Row position, a sort), Compare
    Rows as Shown's `precondition` while unticked; all three are state keys, as `precondition` and `toggled` require.
    `core/contextkeys.ts` computes them for the focused comparison from `resultsComparing`'s record, which gains
    `asShown`, `outOfDate` and `showable` beside `inputsOpen`. A grid menu can open on a comparison that is not the
    focused one (a stacked Grid layout), so, as for `comparisonInputsOpen`, `ResultGrid` marks the view element
    (`data-comparison-shown`, `data-comparison-out-of-date`, `data-comparison-showable`, beside
    `data-comparison-inputs`), `outputTarget` (`menus/targets.ts`) reads them onto the output target, and `argsFor` adds
    the three keys for a diff grid.
- **Catalogues:** commands `output.compareAsShown` ("Compare Rows as Shown", `toggled: comparisonAsShown`) and
  `output.compareUpdate` ("Update Comparison", `when: comparisonAsShown`), in the submenu, More results tools'
  `6_compareactions` and the palette. No setting (Q9).
- **Tests:**
  - `DiffChecks`: view reads (filtered, sorted, Row position over view order, packed inputs through the inverse), stored
    row numbers, refusals, working memory counted, and a view closed mid-run answering `VIEW_NOT_FOUND`.
  - vitest: a `results-port.test.ts` case sending `leftView` and `rightView` and checking both reach the backend
    request, and a `worker-core` case for the view ids, since a dropped member would compare whole results under an "(as
    shown)" caption; the popover choice and counts, memory, `comparisonOutOfDate` (filters changed, same filters, sort
    only under key and under Row position, Keep Selected Rows), Update dropping "(as shown)", other changes updating an
    out-of-date comparison and saying so, and a build with nothing to apply recorded whole, its choice Whole result, so
    a later Layout after a filter still reads whole results; the grid menu on a comparison that is not the focused one,
    its Compare Rows as Shown tick and Update Comparison following that comparison's state.
  - The fake backend reads views. A `results-smoke.mjs` step: filter an input, Compare rows as shown, change the filter,
    see Out of date, Update.
  - Whichever of C3 and C6 lands second: a shared golden for both writers with one side read as shown ("(as shown)" in
    its `---` line and `# Result 1 shows 120 of 5,000 rows` under it).
- **Risks:** packed-page reads in view order are the cost. Search's inverse and its refusal check are the precedent.

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
- the architecture.md Comparisons and Rows bullets, including the diffs bullet's sentence that hidden columns are never
  copied or searched, which C1 (search reads `old` columns) and C3 (Copy as Diff reads previous values) narrow, and the
  float and real bullet's rule that a copied exact value is kept when its own column holds exact values, which C4 keys
  on the source column instead;
- ipc.md (Result diffs, Limits, the method table) where the protocol changes, and for C4 architecture.md's Search
  Objects bullet and object-search.md, which gain `explorer.scriptTarget` as a reader of the index and the GENERATED
  ALWAYS flag;
- the results guide (`help/guides/results.tsx`, with live `CommandRef`s), or records why there is no guide impact;
- CHANGELOG Unreleased.

When the last lane ships, this plan folds into the area docs and is deleted.

| Lane | Contents | Depends on | Size |
| --- | --- | --- | --- |
| C1 | Search old values | difference navigation | S |
| C2 | Ignore columns, and the Comparison submenu (N7) | difference navigation | M |
| C3 | Copy as Diff, Save as Diff… (Q1) | C2 (the submenu, and the header's `ignored:` part) | M |
| C5 | Change details card and hover | C2 (the submenu) | M |
| C6 | Compare rows as shown, Out of date | C2 (both change `results.diff` and the pair memory) | L |
| C4 | Script Differences as T-SQL | C2 (ignored columns' INSERT rule), C3 (the match and ignored pairs it records on the diff set, and cut changed-pair lists in both layouts) | L |
| C5b | Compare Values in Tab | C5 | M |
| (later) | C4b GoogleSQL script; side-by-side; Pivots | Q4; N4 | M; L; M |

- C1 and C2 can run in parallel: they touch search and `ResultDiff`.
- C3 and C5 can run in parallel after C2: they touch the writer and the grid's card. Both append to the submenu and
  change `DiffIndex.cs` and architecture.md's change-index bullet (C3's cut lists in both layouts, C5's look-alike
  bitsets, both charged there), and C5 also changes `diffSeek`'s answer across the results-path files, which C3, C4 and
  C6 append to as well.
- C6 can start after C2, and C4 after C3, whose recorded match it reads for its keys and its refusal. They can then be
  built in parallel, but both append to the results-path files (contracts.ts, port-messages.ts, results-port.ts,
  worker-protocol.ts, worker-core.ts, `ResultClient.ts`, `SqlService.cs`, `Contracts.cs` and the fake backend), so the
  second to land merges main first. Whichever of them lands second also adds Script Differences' refusal of a comparison
  of rows as shown, and whichever of C3 and C6 lands second, Copy as Diff's as-shown header lines. C4 is listed last
  because it is the largest and riskiest lane, and its "script back a bad UPDATE" job is worth most once cross-run
  comparison (N5) lands.

## Coordination with in-flight work

In flight as of 2026-11-22. After each merges, open comparison branches merge main (merge commits, never rebase).

- **Difference navigation** has merged: Go to Next/Previous Difference, Go to Possible Match, the overview strip and the
  `comparisonRowHasPartner` key that C2's keys copy. Every lane starts from main.
- **BigQuery** (docs/bigquery-plan.md, 0.10.0):
  - Remote views (BQ-3c) and job re-attach (BQ-3d-1, BQ-3d-2) have merged, so C1 and C6 build on the view plumbing, and
    the protocol, catalogue, document-registry and hot-exit files the comparison lanes append to already hold BQ-3d's
    changes. C6 adds `comparisonOutOfDate` to `ResultsService.ts`; C5b's new document kind stays out of the hot-exit
    records.
  - BigQuery disables Compare on windowed results, so a comparison's inputs are in memory. C6's remote-view refusal is the
    backstop.
  - New commands and keys are engine-neutral except C4 (Q4).
- **Connect in an OS window** has merged: `DialogWindow`, `popouts.ts` and `popout-windows.ts` hold its `connect` kind
  and `dialogWindowBounds`, which C4's kind builds on.
- **SQL Server Agent** (docs/agent-plan.md, 0.11.0; AG-6b, AG-6c and AG-7 have merged, and its later lanes are in
  flight) does not touch the results pipeline, but shares files with the comparison lanes. Both sides only append to
  them:
  - menus and keys: the commands catalogue, `menus.ts`, `tests/command-catalog.test.ts`, `context-keys.ts` and
    `core/contextkeys.ts` (as AG-7 did), against C2's submenu and every lane's commands;
  - documents: `documents.ts`, `EditorArea.tsx` and `services/files.ts` (as AG-7 did), and `start.tsx` with
    `tests/fixtures/monaco-runtime.ts`'s reviewed imports, which AG-6b changed and C5b builds on;
  - `icons.ts` (as AG-6c did), against C2's `eye-closed`;
  - the protocol files: the fake backend, contracts.ts, methods.ts, the preload, `validation.ts`, `SqlService.cs` and
    `Contracts.cs` (all three), against C1–C6;
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
