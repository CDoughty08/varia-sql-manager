# Result comparison UX pass: plan

Status: revision 17, after review rounds 1 – 15 (round 15: no blockers or majors); adds Coordination with BigQuery and Agent. Mock: [prototypes/results-pane/compare-diff-ux.html](../prototypes/results-pane/compare-diff-ux.html).
Where the mock and this plan disagree, this plan wins (see "Mock differences").

This reworks how a finished comparison (`results.diff`, kind `diff`) is stored, shown and driven. It keeps the Compare
popover's targets (#490), the column pairing rule, collation handling and the whole-or-refused budget rule of
[grouped-results-implementation-plan.md](grouped-results-implementation-plan.md) § Comparisons and [ipc.md](ipc.md) §
Result diffs. It changes, and the PRs below update in those documents: the stored columns, row alignment (match modes),
the default context, comparison identity, and "the picker never promises a key".

## Problems (owner's list, 2026-11-15)

1. Changed cells are not emphasised; whole rows are.
2. `Change`, `R1`, `R2` are drawn, sorted, filtered, profiled, copied and saved as data columns, but are not data.
3. Selection, search hits and highlights replace the diff colour instead of combining with it.
4. The Column Profile of a comparison is titled "Column profile Result N": a derived number no one sees elsewhere.
5. Matching rows should stay in the diff, uncoloured. Today one unchanged row of context is kept around changes.
6. Highlight changed cells, not whole rows.
7. Compare order should be the direction, and a changed row one row, not a − row and a + row.

Found while mocking: the key is chosen automatically and cannot be changed (the owner's sample matched by `test`, the
column that differed, so nothing paired); a repeated key silently pairs in order; there is no way to step through
changes; the strip sentence is in the warning colour and always says filters were not applied; the tab name is cut off.

## Owner decisions

| # | Decision |
| --- | --- |
| D1 | Two layouts, switchable: **One row per entry** (default; a changed cell shows old → new) and **Two rows (−/+)** (today's shape with cell-level colour). |
| D2 | Rows: **All rows** (default) or **Changes only**. No "N rows of context" choice. A memory refusal of All rows offers Show changes only in one click. |
| D3 | Match rows by: **Automatic** (today's rule), **Row position**, **Whole rows** or **Key columns** (one or more: composite), from a checklist menu like the filter menus. |
| D4 | A repeated key is a real ambiguity: rows paired in order are marked ≈ and counted. |
| D5 | A removed and an added row that look alike get a **possible match** hint (?), never a change of counts or colours. |
| D6 | Change marker and row numbers move to a gutter and stop being data columns. Save Results As of a comparison always writes them as `Change`, `Old row`, `New row` (no dialog option), and in One row per entry each column is followed by `<name> (old)`, filled only where it changed, so no value is lost. Copy writes shown values only. |
| D7 | Diff colour stays visible under selection, search hits, highlights and the active cell. |
| D8 | The Column Profile of a comparison is named for the comparison. |
| D9 | Toolbar changes (layout, rows, match, exact text, swap) **replace the comparison in place**; one comparison per ordered pair of inputs. |
| D10 | Once an input result is closed, those re-run controls are **disabled** with the reason; the comparison stays readable. Inputs are not pinned. |
| D11 | Count chips **filter**, through a new backend filter by kind. Unchanged is a count only. |
| D12 | Wider than the one-row limit (2,046 compared columns), a comparison **falls back to Two rows** with a notice. |
| D13 | The popover's **Show It applies its Exact text checkbox** to an existing comparison of the pair (a replace when it differs). Plain Compare with Previous Result only focuses an existing one and never turns Exact off; its Exact Text variant turns it on. |
| D14 | A replace runs with a **budget allowance** of the old comparison's whole charge: a documented, bounded overrun of the query budget. Real memory briefly holds old and new; the old is released only after the new is shown. |
| D15 | Row **highlights carry over** a replace: they follow each entry through layout switches and swaps. A highlight whose entry no longer exists (a match change unpaired it) is dropped, and the announcement says how many. |

## Stored shape

### Column order

Every diff result, in both layouts, is: the compared (data) columns in pair order, then a hidden suffix, tone last.

| Layout | Columns |
| --- | --- |
| One row per entry | data × p, previous value × p, `mark`, `leftRow`, `rightRow`, tone |
| Two rows | data × p, `mark`, `leftRow`, `rightRow`, tone |

- The hidden roles are exactly `old`, `mark`, `leftRow`, `rightRow`, `tone`. Other roles (`xml`, `json`, `plan`,
  `udt`, `vector`) are data and stay visible. One renderer predicate `isHiddenColumn(column)` and the backend's
  `ResultTextWriter.Hidden` both test that set; the call sites that test `role === 'tone'` today to hide a column
  (ResultsService copy, selection, filter and header eligibility; ColumnProfilePanel; contributions/transpose.ts,
  output.ts; pivot.ts; compare-pairing.ts; the renderer's column-name search, search.ts; ResultJobs; ResultSearch) use them. So do the sites
  that assume tone is the only hidden column (GridView's swap check, ResultsService's live tone use); the lint also
  flags `toneColumnOf` used as a hidden-column test. A lint test fails on a new
  `role === 'tone'` or `role !== 'tone'` (either quote style) outside an allow-list: the grid's tone reader and the live readers (LiveGrid.ts, live/docs.ts,
  live/schema.ts, live/catalog.ts, ResultsService's live tone use; backend LiveCatalog.cs).
- The new roles and the `of` member (`Of` in C#, the pair a previous value belongs to) are added to the strict
  descriptor schema (`src/shared/ipc/descriptors.ts`), `ResultColumn` (contracts.ts and Contracts.cs) and main's
  descriptor copy.
- The backend refuses every column input that names a hidden column (`INVALID_PARAMS`): sort keys (`ViewAsync`'s
  loop), filters (`SqlService.ViewFilters`), `duplicates` columns, `keepRows` cells, `results.identify`'s `column`,
  and the distinct and profile column parameters.
- Row identity on a comparison: `CellHasher` skips hidden columns, so for kind `diff` row and auto identity hash the
  entry's input rows explicitly: the pairs (input, row) for each side present, ordered by input result id (lower id
  first), not by old/new. The diff set records its two input result ids when written, because identify is a later
  call. Result ids are stable across a swap within a generation. One identity per entry in both layouts (both halves share it), unchanged by a
  layout switch or a swap, so highlights carry over a replace (D15). For a diff, `results.identify` reports
  uniqueness per entry, so two halves sharing an identity are not counted as identical rows.
- Because hidden columns are a suffix, visible column indexes equal descriptor indexes, so selection, copy, sort and
  filter indexes are unchanged. The grid's visible count becomes "index of the first hidden column" instead of
  `length - 1` (GridView.ts `columns`, `toneColumnOf`; data.ts).
- Tone cell numbers become pair indexes (today `pair + 3`); every renderer `+ 3` assumption goes.
- `mark`: `" "` same, `"~"` changed (one row), `"−"`/`"+"` removed/added and the two halves of a changed entry.
  `leftRow`/`rightRow`: bigint, 1-based row in each input, NULL where the entry has none. Both halves of a changed
  entry carry both numbers (today the halves carry one each; changed in PR 1); the gutter draws each half's own side.
- One row per entry: each entry's shown value is the new side's (old side's for a removed row). A **previous value**
  column (`Role: "old"`, `Of: <pair>`) has the *left* column's type, collation and length rule and holds the old value
  in **every** changed cell (listed by the tone or past its cut), NULL elsewhere; soft (collation-only) cells are not
  changed and get none. Which cells changed is known from the tone and, for a cut row, from the change index's
  changed-pair list (below), so an old NULL is told apart from "not changed". It is not measured
  for the row-size bar, but counts toward the 8 MiB row cap; a value past the cap is truncated with the existing explicit
  marking. Columns: 2p + 4 ≤ 4,096, so p ≤ 2,046 (D12).

### Tone grammar

Space-separated tokens: `<kind> [flag…] [cell…]`.

- Kinds: `same`, `changed` (one row), `added`, `removed`, `changedOld`, `changedNew` (the two halves). `same` with soft
  cells keeps its meaning. The kinds join the grid's `rowTones`; a test pins that no live tone (live catalog) uses them.
- Flags: `dup` (D4), `poss=<row>` (D5: the partner's 1-based row in the other input; only on `added`/`removed`),
  `gap=<n>` (Changes only: the count of unchanged entries omitted just before this row, taken from
  `UnifiedDiff.Shown` while writing; absent when 0; in Two rows it goes on the first stored row after the run, the
  `changedOld` half of a changed entry). Values are int-sized, so the worst case `dup poss=<10> gap=<10>` is 34
  characters. The grid reads them with the tone it already fetches. Unknown
  flags are ignored by the reader. At most 3 flags, at most 48 characters together.
- Cells: as today (space-separated pair indexes, ranges, `~` for soft), cut with " …" so that the whole tone text,
  kind and flags included, is ≤ 500 characters (the cut budget subtracts the kind and flags; the grid reads 512).
- **A cut tone** (a row with very many scattered changed cells) is explicit: cells past the cut are drawn without
  old → new, and the row's gutter name and tooltip say "More changes in this row are not listed". The change index
  (below) counts the cut as one change unit, so navigation and totals agree with what is drawn. `columnChanges` keeps the
  model's true counts and its footnote says listed cells can be fewer.

### Answer of `results.diff`

`{ descriptor, match, same, changed, added, removed, soft, approximate, leftOnly, rightOnly, repeated, possible,
possibleSkipped, nothingPaired, columnChanges, overview, units, trailingHidden, layout }` (`trailingHidden`: in Changes only, the unchanged entries
omitted after the last stored row).

- `match: { mode, columns: string[] }`: what was used (for `auto`, the chosen column, or mode `rows` when it fell back).
  Replaces `key`.
- `columnChanges: { changed, soft }[]`, one per pair (≤ 4,092). `overview`: ≤ 512 buckets of kind bits over stored rows.
  `units`: the total of change units.
- `layout`: the layout written. Past 2,046 pairs the renderer asks for `unified` itself (D12) and the backend refuses
  `entry`; there is no silent fallback in the backend.

### Change index

Written with the diff and kept on its `ResultSetBuffer`, charged to the query budget and released with it; if its
reservation is refused, the whole diff is refused (whole or refused, as the rows are).

- Per stored row: 1 byte (kind in 3 bits, `dup`, `poss`, cut) and a 16-bit change-unit count (3 bytes a row).
- Per row flagged `poss`: its partner's **stored row in the diff** (4 bytes), so Go to Possible Match needs no search.
  A removed row's partner is usually written later, so the writer keeps a map from input row to stored row for the
  look-alike rows (at most 1,000 a side) and fixes the partner rows up after writing.
- Per cut row, in One row per entry only: its full changed-pair list (a bitset of p bits). It is read only by Save,
  which so never loses a changed cell's old value past the cut. Cut rows are rare (more scattered changes than fit in
  500 characters). The grid does not see it: past a cut, cells are drawn and named like unchanged ones, and the row's
  name says "More changes in this row are not listed". Save may run over a sorted or filtered view, so the bitsets
  are found by stored row through a sorted list of cut rows (4 bytes each) with offsets into the bitset area; both are
  charged and bounded in ipc.md § Limits (at most one bitset per stored row, p ≤ 2,046 bits each).
- Per 4,096 stored rows: a running total of units (stored-order seek and "Change n of m").
- A **change unit** is each changed cell the tone lists (a cut counts as one more), and each added or removed row. In Two
  rows a changed entry's units are on its `changedNew` half (navigation lands on the + half's cell). Totals are the same
  in both layouts except where a cut differs between them. Soft (collation-only) cells are not change units, matching
  the soft notice and `columnChanges.soft`.
- When a view of a diff is built, a running total per 4,096 view positions is built with it from the view's `Order`
  (O(view rows), 4 bytes a block, charged with the view), so view-order seek and counts need no scan.
- It serves the `kind` filter, seek, partner lookup and `overview` without reading tone text. Bounds in ipc.md § Limits and
  `limits.diff` (src/shared/ipc/wire/protocol.ts and C#).

## Design

### Layouts (D1, D12; problems 1, 6, 7)

- **One row per entry.** A changed cell draws two runs through Text nodes and spans (as `writeMarked` does; grid-lint
  holds): the old value in the removed colour, struck through; an arrow; the new value bold in the text colour; on
  `diffChangedBackground`. When the cell is narrow the old run is cut first (it shrinks with an ellipsis; the new run
  does not). Auto column width measures both runs. Unchanged cells of a changed row use the secondary text colour.
- **Two rows.** Changed cells are tinted (removed tint on the − half, added on the + half) **and bold**; other cells of
  the halves use the secondary colour. No row tint on changed entries.
- **Added and removed rows** keep a faint row wash in both layouts (retuned `diffAddedBackground`/`diffRemovedBackground`).
- Soft differences keep the dotted underline and "differs only by collation" label in both layouts.
- Accessible names: one row, a changed cell is "Price, changed from 5120.00 to 4980.00"; two rows, "Price, old value
  5120.00" on the − half and "Price, new value 4980.00" on the + half; a removed/added row cell says its kind.
- **Fallback (D12).** The renderer knows the pair count before asking; past 2,046 it asks for `unified` and shows the
  notice "Too many columns to show one row per entry, so two rows are shown." The Layout toggle is disabled with that
  reason. The backend also refuses `entry` past the limit (`INVALID_PARAMS`).
- Setting `queryResults.compare.layout` (`entry` | `unified`, default `entry`): the layout of a new comparison. The
  toolbar's **Layout** toggle changes that comparison only, not the setting.

### Gutter (D6; problem 2)

- The row header (`.rg-rn`) of a comparison draws a 3px kind bar, the mark, and the row's number in its own input: the
  new input's for same, changed, added and `changedNew`; the old input's for removed and `changedOld`. Then ≈ when the
  key repeats, else ? for a possible match (when both apply, ≈ is drawn and both are in the name). Width from the larger
  input's row count. Grids that are not comparisons are unchanged.
- Accessible name and tooltip: "Changed, repeated key, possible match with row 12 in Awesome Query; row 3 in Sample
  Query, row 4 in Awesome Query".
- **Go to Possible Match** is a catalog command, enabled on a comparison's active row that has a partner, in the palette
  and the grid's row context menu (keyboard Shift+F10 included). It asks `results.diffSeek { partnerOf }` for the partner's
  position (stored row, or view position by one pass over the view's `Order`), selects that row and scrolls to it.
  When only chips filter the view, whether the partner is shown is known at once from its kind, and the command is
  disabled with "The possible match is hidden by a filter". With other filters it stays enabled; `diffSeek` answers
  `{ hidden: true }` and the same sentence is announced in the live region. Clicking
  a row header still selects the row.
- **Fetching the hidden suffix.** `GridData` plans, with each row tile, the tiles holding `mark`, `leftRow`, `rightRow`
  and tone (they can span two 32-column tiles), and in the one-row layout always the previous-value tiles covering the
  visible column tiles (p + c does not align to 32, so one visible tile can need two). One round trip; reads stay inside
  the worker's window limits (4,096 cells a tile; a one-row read can need about five tiles, within
  `gridLimits.textBudget`). The active cell's accessible name uses the same data. Tested in data.ts.
- **Save Results As** of a comparison writes the markers always; the backend decides it from the result's kind
  (`diff`) and the job (Save, not Copy), so there is no renderer flag and no Save dialog choice. It writes `Change`,
  `Old row`, `New row` as the first three columns. In One row per entry each data column is followed by
  `<name> (old)` from its previous-value column; `ResultTextWriter` lets the `old` role through only for such a save.
  An unchanged cell's `(old)` field is written empty (JSON: the key is left out), and a changed cell whose old value is
  NULL is written as the NULL token even when the NULL text setting is empty, so "changed from NULL" never reads as
  "unchanged". Changed cells come from the tone plus the cut-row lists. The backend refuses a transposed export of a diff
  (`INVALID_PARAMS`). results-tools.md notes that in CSV/TSV an old value that is the literal text `NULL` reads like
  "changed from NULL", the existing NULL-text ambiguity. Two rows saves its − and + lines
  as today. **Copy** copies shown values only. Both documented in the results guide and results-tools.md; the
  CHANGELOG says Copy no longer includes Change/R1/R2.

### Colour layering (D7; problem 3)

- Diff colour moves to the cells' `background-color`. Layers above it, in order: user row highlights (`hl-*`, now
  translucent overlays instead of row backgrounds), search hits, selection (active or inactive). Each is a translucent
  `background-image`; the active cell stays an outline. The row header keeps its kind bar when selected. A CSS-order
  test pins diff < highlight < hit < selection, replacing the current tone-before-`hl-*` test.
- Tokens: `resultsGrid.diffChangedBackground` (reserved until the one-row layout), `resultsGrid.selectionOverlay`,
  `resultsGrid.inactiveSelectionOverlay`, `resultsGrid.hitOverlay`. The highlight keys are already translucent colours, and
  the registry holds colours only, so there is no separate alpha key. Contrast pairs (Light and Dark, with and without the
  selection overlay): text and struck removed text on `diffChangedBackground`, text on the added/removed washes.
  Regenerate `registry.ts`, `tests/fixtures/themes/*.resolved.json`, `docs/themes/tokens.md` and the schema.
- Forced colours: changed cells get a `CanvasText` border, selection a `Highlight` outline (backgrounds may be dropped);
  the mark, bold and strikethrough carry the kind without colour.
- No row hover is added (the grid has none; a grid-wide change).

### Rows (D2; problem 5)

- Setting `queryResults.compare.rows` (`all` | `changes`, default `all`) for new comparisons, and a **Rows** toolbar
  choice for this one; `all` sends `context: -1`, `changes` `context: 0`. Switching replaces (D9).
- In Changes only, with no sort or filter applied (chips included), the row after an omitted run draws a dashed top rule with the tooltip
  "312 unchanged rows hidden" ("1 unchanged row hidden"), from that row's `gap=<n>` tone flag (neighbouring row numbers cannot give it: removed rows and key
  matching break the sequence); the same count is in that row header's accessible name. A trailing run
  (`trailingHidden`) draws a rule below the last row. With a sort or filter
  the rules are not drawn; the toolbar shows the total.
- A refusal of All rows **because of its stored rows** says "Not enough result memory for all rows." with **Show
  changes only**. Only that cause gets the button: `results.diff` answers it with its own error code
  `DIFF_ROWS_TOO_LARGE` (protocol.ts, ipc.md's error table), sent when a reservation that grows with the stored rows
  (the rows, the previous-value columns, the change index) is refused **and** the request had `context: -1`. Everything
  else, refused alignment memory, low system memory, or a Changes only request, keeps `TOO_LARGE` and gets no button. The write path keeps the low-memory distinction (today every writer `TOO_LARGE`
  becomes one refusal). On a replace it
  is a notice on the comparison and the button replaces with `context: 0`. On a first run there is no comparison yet:
  the sentence and button appear in the popover's error area, or, for Compare with Previous Result or when the popover
  has closed, in an **actionable notice** in the results area; the button runs a fresh comparison with `context: 0`. It is
  a slot of its own, not `ResultsService.notify`'s shared `jobNotice` (which any later notice replaces and which has no
  buttons): drawn by OutputPane beside the job strip, with its button and a Dismiss button inside the results
  toolbar's Tab model; ordinary notices sit beside it; it does not expire; it is cleared when either input is closed or
  released, on re-execute, and when a comparison of the pair is published; its button is disabled under D10. A test
  checks that a later `notify` does not drop it.
- Changes only with no differences stores no rows: the grid says "No differences. 1,204 unchanged rows hidden."

### Matching (D3, D4, D5)

`results.diff` gains:

```ts
match?: { mode: 'auto' } | { mode: 'position' } | { mode: 'rows' } | { mode: 'columns'; columns: number[] }
layout?: 'entry' | 'unified'   // default 'unified' at the protocol, so older callers and tests keep today's shape
replaces?: number              // u32 id of a diff result of the same query (D14)
```

- `auto` (absent = auto): today's rule. `rows`: today's whole-row fallback, asked directly. `position`: the n-th row of
  each input pair; the rest are added or removed.
- `columns`: 1 – 16 unique pair indexes, each < pair count (zod and C#). Uses the composite `Rows(...)` identity over
  the chosen columns (not the single-candidate `Fill(stopEarly)` path, which rejects repeats and NULLs). Values compare
  as today. NULL equals NULL; several NULL keys are repeated keys. Float and binary columns may be chosen (exact value).
  A chosen key column holding a truncated value is refused with its own code `DIFF_KEY_TRUNCATED` (protocol.ts,
  ipc.md's error table; "A key column holds values too long to compare. Choose another."), because a truncated prefix can pair different rows. Working memory adds 4 bytes a row for
  key counts.
- **Repeated keys (D4).** Only `columns` mode can have them (`auto` takes only unique candidates; `rows` pairs identical
  rows, so order cannot change the result; `position` has no key). The k-th copy pairs with the k-th; every entry whose
  key occurs more than once on either side is flagged `dup` and counted in `repeated`.
- **Possible matches (D5).** After alignment in `auto`, `rows` and `columns` modes, look-alikes are sought among
  removed and added rows over the **compared columns**: the non-key paired columns in `auto`/`columns` mode, all paired
  columns in `rows` mode (and in `auto` when it fell back to whole rows). Skipped when there are no compared columns
  (every pair is a key). A pair qualifies when at least 75% of the compared columns are equal and at least min(3, count)
  of the equal values are non-NULL, and is kept only if each is the other's unique best (a tie on either side keeps
  neither). Bounds: removed ≤ 1,000, added ≤ 1,000, removed × added × compared columns ≤ 4,000,000, values read charged
  as working memory (a refused reservation skips the search). Skipped: `possibleSkipped: true`. Found: flags
  `poss=<row>`, counted in `possible`. `nothingPaired: true` when same + changed = 0 and both inputs have rows.
- **The match menu.** A toolbar button showing the mode ("⚷ id", "⚷ id + status", "Row position", "Whole rows",
  "Automatic: id", "Automatic: whole rows"), with an accessible name such as "Match rows by key columns: id, status". It
  opens a themed popover with the filter menu's focus and ARIA pattern: a radio group (Automatic, Row position, Whole
  rows, Key columns); a searchable checkbox list of paired columns with their types, enabled under Key columns, where the
  17th is disabled ("At most 16 key columns"); the note "NULL matches NULL"; and **Apply**, disabled while Key columns has
  none ticked. It renders in its grid's window (popouts included). Key columns show ⚷ in their headers.
- **Remembered.** Per tab, for the session: the last match applied is remembered per *ordered* pair of input names (at
  most 64 entries a tab), with key columns by name and type. A new comparison of those names uses it; a remembered column that no
  longer pairs falls back to Automatic with a notice. The popover shows the match it will use ("Match rows by: id
  (remembered)"); changing it is done on the comparison. When Show It will replace (D13, Exact differs) its label is
  **Update**, and its progress, Cancel and errors stay in the popover as today.
  - A remembered entry applies only to a comparison created from the popover or Compare with Previous Result. If that
    first run is refused with `DIFF_KEY_TRUNCATED` (and only that code), it runs again with Automatic and shows the "remembered match unavailable" notice.
  - Swap carries the comparison's current match to the new ordered pair and writes it as that pair's remembered entry;
    an older entry for the reversed pair does not apply. Key columns and widths resolve by column name, accepting
    either side's type (the data columns take the new side's types, the previous-value columns the old side's, and a
    swap exchanges the sides).

### Replace in place (D9, D10, D13, D14)

- **Identity** of a comparison is the ordered pair (old input, new input); options (layout, rows, match, exact) are its
  state. `CompareService.existing()`/`pairId` drop `exact` from the key; the `CompareInfo` moves to the new set key on
  replace.
- **Entries.** The popover's Show It on an existing pair focuses it and applies the Exact text checkbox (a replace when
  it differs) (D13). Compare with Previous Result focuses an existing comparison and never turns Exact off; its Exact
  Text variant focuses and turns Exact on. Swap onto a pair that already exists the other way focuses that one.
- **Machinery.** `replaceComparison`, modelled on `replaceSet`: same slot and place in Tabs/Stacked; renamed on swap and
  on Exact (tab label, Stacked caption and accessible name together); no new count against the 1,000-result cap; it runs
  under the existing operation progress with Cancel. A newer change cancels an older replace in flight (the Pivot rule).
  While a first run of the pair is in flight, a request with the same options does nothing (as today); one with
  different options (the Exact Text variant, Show It/Update with another Exact) cancels it and starts again with the
  new options.
- **Failure.** The old result stays until the new one is published. A failure, refusal or Cancel leaves it untouched and
  says why. Closing either input during a replace cancels it; the controls become disabled and the notice says "Sample
  Query was closed, so the change was cancelled."
- **Memory (D14).** `replaces` is a budget allowance only. The backend raises the query's limit by the replaced result's
  whole current charge (its rows, metadata, change index, views and identity) through `store.Allow(query, bytes)` on
  `QueryBudget`. There is one allowance per replaced result, granted once with a holder count: a newer replace of the same
  comparison (which carries the same `replaces` id while the old one is still published) joins it rather than adding a
  second grant. Allowances for different replaced results of one query add up. The limit becomes
  `min(Query, MaxBytes) + allowances`. One helper `QueryLimit(query, figures)` includes it and is the
  only limit reader: `TryReserve`, `FitsQuery`, `HasSpare` and `TryReserveSpare` all go through it, so every
  reservation the diff makes (on its own thread, on the sort gate's workers, or through the input sets: rooms,
  `TryUnpackAll`) sees it. The allowance lasts until the old set's bytes are actually returned (in `FreeLocked`, on an immediate release or when a pending free completes after the last lease
  or pin, such as a Copy or Save job, ends), or until its last holder fails or has its new set released; a cancelled
  older replace only drops its hold; so sorts, filters and the re-applied chip filter on the new
  comparison are not refused while the renderer still holds the old one (for example during a Save dialog). Other operations of the
  same query running meanwhile see the raised limit too; ipc.md § Result store and memory budget documents both, and that the memory meter and the truncation note can
  show a query above 100% while an allowance is in force. `QueryLimit` also feeds `query.Refused` and the truncation
  note's fallback (today `store.QueryBytes` when no stopped figure is recorded), so the note shows the raised limit. The allowance does not lift the global budget, so a replace near the query limit can
  still be refused while other queries hold memory; ipc.md says so. Global
  and system-memory checks are unchanged. The allowance is a snapshot of the old charge when the request starts; views
  or identities built on the old result afterwards are not covered, which is accepted. The renderer releases the old result after publishing, as `replaceSet` does,
  including its deferral while a Save dialog is open; Copy or Save jobs on the old result follow `replaceSet`'s rules.
  In-flight `diffSeek` answers for the old result are ignored.
- **On publish.** Selection, sort, column filters, scroll and the navigation index reset; the chip filter is re-applied
  as a kind filter (from PR 8, when chips exist); column widths, key columns, highlights (D15, by entry identity; see below) and an open Profile (re-targeted)
  carry over. Widths are
  carried by column name (`replaceComparison`'s own mapping, not `replaceSet`'s `carriedState`), because a swap
  reorders the pairs (they follow the old side's column order). Key columns are part of the replace request, so they
  are resolved by name to the new pair indexes before it is sent; pairing by name is symmetric, so a swap keeps them. The other options carry over. Dismissed
  notices stay dismissed only while their kind and text are unchanged. Focus stays on the control that made the change.
  Announcements: see Toolbar and notices.
- **Highlights (D15).** HighlightsService gets a carry step for comparison owners: after the new result's first
  complete (not truncated) `findRows` on the bound result itself (not a sorted or filtered view, which can hide rows
  that exist), ids not found are pruned and counted, but only when the new comparison stores all rows (`context: -1`).
  In Changes only, unchanged entries exist but are not stored, so unfound ids are kept silently and drawn again when
  All rows returns. If `findRows` is truncated everything is kept. Comparisons never show the "not in these results" or "some rows here are identical" strip texts.
- **Disabled controls (D10).** While either input is closed, every control that re-runs is disabled with "Sample Query
  is closed": the toolbar's Layout, Rows, Match, Exact and Swap; the notice buttons (Show changes only, Choose key
  columns…, Match by row position); and their ⋯ More results tools and palette commands, through a context key
  `comparisonInputsOpen`. (Re-executing the query or losing the backend releases the comparison too.) The side names
  stay links to the inputs and read "(closed)" as the strip does today.

### Toolbar and notices

From left: icon and title; **sides** (− old ⇄ + new; names are links; ⇄ swaps); **Match**; **Rows**; **Layout**;
**Exact text** toggle; chips; Previous/Next Difference with "Change 2 of 31"; Profile; Save.

- **Chips (D11).** + added, − removed and ~ changed are show-only toggle buttons (`aria-pressed`). None pressed: no kind
  filter. Any pressed: a `kind` filter with exactly the pressed kinds, so unchanged rows are hidden while any is pressed.
  The unchanged count and ≈ repeated count are plain text. Counts use `formatCount` with singular forms ("1 added"). A chip whose count is 0 is disabled ("No added rows")
  unless it is pressed. On publish, pressed kinds whose new count is 0 are released, and the announcement says so.
- **Kind filter.** New view filter op `{ op: 'kind', kinds: ('same' | 'changed' | 'added' | 'removed')[] }` (1 – 4
  unique kinds), valid only on a diff result (`same` is accepted although no chip sends it; ipc.md says so), read from the change
  index; `changedOld`/`changedNew` count as `changed`.
  Places: `ViewFilter`/`ResolvedViewFilter` (contracts.ts), the request and resolved filter schemas (port-messages.ts),
  main's `copyFilter` (results-port.ts), ResultClient's filter check (which today requires a `column`), `filterKey`
  and the filter label and column sites (ResultsService), column-filter.ts, the filter strip labels (ResultsStack),
  `ViewFilterArgs`/`ViewFilterResult` with a `Kinds` member (Contracts.cs), `SqlService.ViewFilters` (a `kind` branch,
  the diff-only check, the op-list sentence) and `FilterResult`, `FilterOp.Kind`, the `ViewFilter` record's `Kinds`, a kind
  step in `ViewSorter.Build` and `ViewSorter.KeyCount` counting no column for it (ResultViews.cs, reaching the change index on `ResultSetBuffer`), and `tests/fixtures/backend.mjs`. Shown as the chips, not in column funnels.
- **Narrow panes.** The chips and navigation stay; chips shrink to icon and count first. Exact, Layout, Rows, Match,
  then the sides (as **Swap Sides**, **Go to Old Result** and **Go to New Result**), Profile and Save fold, in that order,
  into ⋯ More results tools (`output.tools`) as catalog commands with a `resultsGridComparison` when-clause (Swap Sides
  disabled under D10; each Go to command checks its own side, through `commands.unavailableReason`, and is disabled with "Sample Query is
  closed" only when that side is closed); the title never folds. The Match popover opened from ⋯ anchors to the ⋯
  button. The toolbar keeps the results toolbar's Tab stop and arrow-key model.
- **Notices** under the toolbar, one line each, plain text, dismissible by keyboard. In-strip buttons use sentence case.
- **Announcements.** One polite live region per comparison. On every publish, the first included, it announces one
  message: a summary ("Comparison ready: …" the first time, then "Comparison updated: matched by id, 3 changed, 1
  added, 0 removed.", followed by any notices newly shown. When the highlight carry step later prunes some, a follow-up message in the same
  region says "2 highlights removed". A notice shown without a publish (a failed, refused or
  cancelled replace, a closed input) is announced in the same region too. Navigation's "Change 2 of 31" uses it as well.
  The popover's first-run errors keep the popover's own alert.
  - Possible match: in `auto`/`columns` mode "1 removed and 1 added row look like the same row with a changed key
    (test). Counts and colours are unchanged."; in `rows` mode "1 removed and 1 added row look like one row with changed
    values." Buttons: **Choose key columns…** (opens the match menu), and **Match by row position** only when both inputs
    have the same row count.
  - Possible matches not searched (`possibleSkipped`): "Too many unmatched rows to look for possible matches."
  - Nothing paired (same buttons); fallback to two rows; memory refusal (**Show changes only**); remembered match
    unavailable; columns not compared; approximate; soft differences; a cancelled change; and filters and sorts not
    applied, shown only when an input had a sort or filter when Compare was pressed (`comparePair` captures it into a new
    `CompareInfo` field), in the information colour.
- **Empty cases.** Both inputs empty: an empty grid and "Both results are empty." One input empty: every row added or
  removed; no possible-match or nothing-paired notice. No differences: "No differences"; Previous/Next disabled.
- **Names.** A comparison with Exact text on is named "Differences: old → new (exact text)" everywhere. The **tab
  label** is "old → new" (plus " (exact text)") with the comparison icon, each side shortened in the middle; the full
  name is the accessible name and tooltip. Save names and job labels keep today's names.

### Navigation

- Commands **Go to Next Difference** (`Alt+F5`) and **Go to Previous Difference** (`Shift+Alt+F5`), as VS Code's diff
  editor (F8 is Show Object Explorer). The keybindings also require focus in a results grid, so Alt+F5 in the editor
  does nothing; the palette and menus work from anywhere. In the palette, ⋯ More results tools and the comparison grid's context menu;
  enabled by `resultsGridComparison`. The docs note that some Linux window managers use Alt+F5, that macOS keyboards may
  need Fn (Option+Fn+F5) and macOS system shortcuts may take it, and that it can be remapped.
- **Context keys** (context-keys.ts, contextkeys.ts, targets.ts): `resultsGridComparison`, a state key true when the
  results grid that last had focus in the active query is a comparison (computed as `resultsGridTransposed` is, so
  the palette keeps it); `comparisonInputsOpen` and `comparisonRowHasPartner` (false until the active row's suffix tiles have loaded), state
  keys; `outputGridComparison`, a
  target key for `output.context` placements. Like `resultsGridTransposed`, the comparison keys are passed per grid by
  `argsFor` (menus/targets.ts), so a row context menu uses the grid that was right-clicked. Disabled reasons come
  through `commands.unavailableReason`. They move the active cell by change unit, wrap, and announce "Change 2 of 31" in the
  comparison's live region (`formatCount`: "Change 1,204 of 31,876"). Under a filter (chips included) the counts are
  the view's, said as "Change 2 of 31 shown". An added or removed row's unit, and a cut unit, select the row with its
  first column active.
- **`results.diffSeek`** `{ resultId, viewId?, from, direction }` or `{ resultId, viewId?, partnerOf }` →
  `{ row, column, index, total } | { none: true } | { hidden: true }` (port, results lane, 10 s; `hidden` only for
  `partnerOf`). `partnerOf`, like `from`, is a view
  position when `viewId` is given, else a stored row. `from` and `row` are view positions when `viewId` is given, else stored rows. It reads the change
  index's running totals and per-row counts, and parses tone text only for the one target row. Places: `RpcMethods` and
  params (contracts.ts), port request and answer schemas (port-messages.ts), `methodPolicies`, main's results-port
  handler, ResultClient, worker-protocol.ts and worker-core, `SqlService.DispatchAsync`, `MethodNames`, the backend's lane switch, Contracts.cs
  records, `limits.diff`, `tests/fixtures/backend.mjs`.
- **Overview strip**: an overlay element beside the native scrollbar drawing `overview`; clicking a mark scrolls there;
  `aria-hidden`. Hidden while a sort or filter (chips included) is applied.

### Column Profile (D8; problem 4)

- For a comparison the panel's title is "Column profile" with the comparison's name under it, and its operation target
  says the same, through the existing `entryName`. Every surface that names a comparison by `resultTitle` (Stacked
  splitter aria-label, memory details) uses `entryName`; a test lists them.
- Each card of a comparison shows its change counts (changed, soft; added/removed/same rows) as a stacked bar from
  `columnChanges`, with value statistics behind **Show value statistics** ("Values shown: new side, old side for removed
  rows").
- Headers of columns with changes get a changed underline and dot (from `columnChanges`), the cue for changes off-screen.

## `results.diff` request, all places

`match`, `layout`, `replaces` and the answer fields land in: `ResultsDiffParams`/answer type (contracts.ts), the strict
`diff` port request and `diffResultSchema` (port-messages.ts), main's member-by-member copy (results-port.ts, which refuses `RESULT_UNAVAILABLE` unless the port owns `replaces`,
as it checks `resultId` and `right`; a popout re-run replaces through the port that owns the old diff; main and C# both require the replaced diff to have
the same two inputs, in either order, so a swap can replace),
ResultClient validation, worker-protocol.ts (the `diff` message and answer union) and worker-core's send,
`ResultsDiffArgs`/`ResultsDiffResult` (Contracts.cs), `DiffAsync`, `limits.diff` (src/shared/ipc/wire/protocol.ts and C#),
`buildDiff` in tests/fixtures/backend.mjs (column order, roles, match), tests/fixtures/compare-pairing/cases.json where
pairing output changes, tests/ipc-lint.test.ts's nullable `key` note, and ipc.md (method table, Result diffs, Limits). The new error codes `DIFF_ROWS_TOO_LARGE` and `DIFF_KEY_TRUNCATED` go in
src/shared/ipc/wire/protocol.ts's `errorCodes`, the renderer's error-code union and ResultClient's mapping, and ipc.md's error table.

## Out of scope (follow-ups)

- Ignore columns; side-by-side layout; character-level diff in long text; Copy as patch; searching old values.
- Comparing filtered or sorted views; the mock's "Compare filtered rows instead" link.
- Row hover in the grid. Comparing Pivots (`columns` mode is the first step).

## Delivery

Each PR runs `npm run check`, regenerates any catalogue it changes in the same PR (commands docs, settings, themes),
updates the affected docs/architecture.md bullets, docs/ipc.md (method table, Result diffs, Limits, error table) wherever
the protocol or stored shape changes, README, docs/results-tools.md (strip, names, closed sources; § Comparisons lines on identity, Show It and Exact
text), the results guide registered in src/shared/help/catalog.ts (the entry with the `comparison` keyword) or records
why not, CHANGELOG Unreleased, and records its guide/sample impact.

1. **Hidden suffix and gutter (D6).** Backend column order and roles (two-row writer), descriptor schema, tone cell
   numbers as pair indexes, `isHiddenColumn`/`ResultTextWriter.Hidden`, grid visible count, suffix fetch, gutter bar,
   mark and number (from today's kinds), Save writing the markers for a diff (decided by the backend). Tests: `role === 'tone'` lint and allow-list;
   XML/JSON/UDT columns stay visible; copy, save, search, profile, filter exclude hidden roles; gutter text and names;
   smoke 14f (no Change/R1/R2 headers); the backend refusing every column input that names a hidden column; the two-row writer
   putting both row numbers on both halves; the diff set recording its input result ids; diff row identity from
   (input, row) pairs ordered by result id, uniqueness per entry; checks that a highlight stays on one entry and that
   halves are not reported as identical rows; column-name search on a comparison matches no hidden column; `turnable` tests the descriptor kind, not the tone
   column; `results.identify` refuses `by: 'column'` on a diff and its `auto` answers column −1 there (entry identity is the
   only identity, so HighlightsService never records a column for a comparison). Updates
   architecture.md's Result diffs bullet and ipc.md § Result diffs (column order, roles, tone cell numbers, `rowBytes`).
   The CHANGELOG says change kind and input rows are no longer columns, so they cannot be sorted or filtered as such;
   the chips (kind filter, PRs 5 and 8) replace filtering by kind. Land PRs 1 – 8 in one release where possible.
2. **Colour layering (D7) and two-row emphasis.** CSS, tokens, contrast pairs, forced colours, layer-order test, theme
   generated files. Until PR 4 a changed half is recognised as removed/added with listed cells.
3. **Names (D8).** `entryName` everywhere, profile title, tab label. ("(exact text)" names land with PR 7.)
4. **Match modes, kinds, flags, answer.** Backend and protocol: `match`, tone kinds and flags, look-alikes, `repeated`,
   `possible`, `possibleSkipped`, `nothingPaired`, `columnChanges`, cut handling. The minimal renderer changes ride
   along so every PR leaves comparisons correct: CompareService reads `match` (the strip says "rows matched by …" as
   today), the new kinds join `rowTones`, and the gutter draws ≈/?, the halves' numbers, the flags' names (`dup`, `poss`; the `gap` count's name "N unchanged rows hidden" comes with PR 8's dashed rule,
   so nothing is announced that is not drawn) and the cut-row text ("More changes in this row are not listed"); PR 2's
   two-row emphasis switches from "removed/added with listed cells" to `changedOld`/`changedNew`. DiffChecks:
   position, rows, columns (composite, NULL keys, repeats, floats, truncated refusal), look-alike thresholds, mutual best
   and ties, zero compared columns, rows-mode look-alikes, bounds and skipped, flags under the cap, cut rows, `DIFF_KEY_TRUNCATED`; `gap=<n>` flags with a removed row inside an omitted run under
   `columns` matching, on the `changedOld` half in Two rows, and `trailingHidden`. Updates
   architecture.md's Result diffs bullet and ipc.md (match modes, kinds, answer, error codes).
5. **Change index, kind filter, seek, overview (backend + protocol).** Index under budget (refusal refuses the diff),
   partner rows, view running totals, `kind` filter in all its places, `results.diffSeek` (both forms), `overview`,
   `units`. Checks for view-order seek, partner lookup under a view, cut rows and released memory. ipc.md: `results.diffSeek` in the method table, the `kind` filter op, change-index
   bounds in § Limits.
6. **One-row layout and replace allowance (backend and protocol).** The protocol plumbing for `layout` and
   `replaces`: port schema, main's copy and its record of each owned diff's inputs (for the same-inputs check),
   ResultClient, worker. `layout`, previous-value columns (left type), the 2,046 refusal, writing the cut-row bitsets
   and their lookup into PR 5's change index,
   8 MiB row cap test; a saved one-row comparison keeps its old values in `<name> (old)` columns, including an old NULL (with empty NULL
   text) and a cut row; Copy writes no markers or old values; `replaces` through `store.Allow` and `QueryLimit` (all four limit readers), summed allowances, the
   whole charge, and the lifetime keyed by the replaced id ending in `FreeLocked`; `DIFF_ROWS_TOO_LARGE` only for
   stored-row reservations at `context: -1` (a check per reservation kind, and none at `context: 0`); a lease on the old
   set keeps the allowance alive. Checks: reservations on worker threads and through rooms
   see it; it outlives the request until a set is released; a re-filter while the old is held is not refused; the
   other `TOO_LARGE` causes keep their code. Rewrites architecture.md's budget bullet (`Resize` is no longer the only
   path that changes the figures) and states the effect on other operations of the query.
7. **One-row grid, replace and toolbar shell (renderer).** Two-run cells, names, layout setting (regenerated), fallback
   notice; `replaceComparison`, identity change, D13 entries (Update label), "(exact text)" names; the toolbar's sides
   with ⇄, Layout and Exact; context keys `resultsGridComparison`, `outputGridComparison` and `comparisonInputsOpen`; disabled controls; the live
   region and publish announcement. Its notices (fallback, input closed, cancelled) use today's strip line until PR 8
   adds the notice strip. Tests: newer replace cancels older; failure and Cancel keep the old; input closed
   mid-replace; 1,000 cap untouched; popout re-run through the owning port; `replaces` from another port refused; highlights carried through a layout
   switch and a swap, pruned with a follow-up count when a match change unpairs them, kept when `findRows` is truncated,
   no "not in these results" text on a comparison; All rows → Changes only → All rows keeps highlights (the D15 checks are service-level, passing `match` and `context`
   directly, until PR 8's UI); swap onto an existing pair; swap carries widths and `match.columns`
   by name; a different-options request cancels an in-flight first run; Show It applying Exact; Compare with Previous never turning Exact off; each control disabled while an input is
   closed.
8. **Rows, match menu, chips, notices, profile cards.** Rows setting (regenerated), the Rows choice, the first-run
   refusal in the popover and the actionable results notice, the match menu and remembered match, chips, the notices,
   the narrow-pane fold commands (commands docs regenerated), profile cards and header marker, the dashed gap rule and
   its "N unchanged rows hidden" row-header name. Tests extend the D10
   checks to every control and notice button added here; the actionable notice survives a later `notify`; a swap writes the remembered entry; only
   `DIFF_KEY_TRUNCATED` triggers the remembered-match Automatic re-run; smoke for the menu, chips, rows and the live region.
9. **Navigation.** Go to Next/Previous Difference and Go to Possible Match (commands docs regenerated), the
   `comparisonRowHasPartner` key, the overview
   strip, announcements in the live region; smoke.

2 follows 1 (its emphasis reads the new cell numbering and styles PR 1's gutter); 3 is independent; 4 follows 1–3. 4, 5 and 6 land in that order (4 with its small renderer part); 7, 8 and 9 follow in
order. The grouped plan § Comparisons is updated in each PR that changes a fact it states (1 stored columns, 4 alignment,
7 identity, 8 default context and the remembered match).

## Coordination with BigQuery and Agent

BigQuery (docs/bigquery-plan.md, 0.10.0) and SQL Server Agent (docs/agent-plan.md, 0.11.0) run at the same time. BQ-0
(provider foundation) is in progress and touches every registry plus the `sortKind` factory, which rewrites the type-name
checks in `ViewSorter`/`KindOf`, `ResultTextWriter`, `RowIdentity`, `HighlightsService`, `ColumnProfiles` and
`ResultsService`. Comparison work must not slow either down:

- **Before BQ-0 merges, only PRs 1 – 3.** They register no method, context key, command, menu or setting. PR 1's edits
  to `ResultTextWriter`, `HighlightsService`, `ResultsService` and `results.identify` stay small and local (the hidden
  roles, entry identity), so they rebase onto BQ-0's `sortKind` edits without rework; whichever merges second merges
  main. No refactor of those files inside a comparison PR.
- **PR 4 waits for BQ-0.** Composite keys build on `RowIdentity`, and float/approximate detection and key typing read
  `sortKind` instead of type names (so BigQuery's in-memory results, and its samples, compare by the same rules). Its
  error codes join the enums after BQ-0's.
- **PRs 5 – 9 wait for BQ-0.** `results.diffSeek` and the `kind` filter op go through BQ-0's method `providers`; the
  comparison's commands, context keys, menu entries and settings are engine-neutral and declare both engines, as BQ-0's
  lint asks for neutral entries.
- **BQ-3c-1's remote-result refusal.** Every page reader refuses a remote result with `REMOTE_RESULT`. `results.diffSeek`
  and the change index are new readers: whichever of PR 5 and BQ-3c-1 merges second adds the case, and
  `tests/result-page-access.test.ts` covers it. BigQuery already disables Compare on a windowed result, so a diff's
  inputs are always in memory.
- **PR 6 before BQ-3c-1 starts.** PR 6 changes `ResultStore`'s limit readers (`store.Allow`, `QueryLimit`); BQ-3c-1
  adds the block cache and residence beside them. BQ-3c-1 is late on BigQuery's critical path, so PR 6 lands first or
  rebases onto it.
- **Agent** does not touch the results pipeline. Shared files are append-only for both (commands catalogue, context
  keys, settings, CHANGELOG, architecture.md, ipc.md).
- After each BigQuery lane merges, open comparison branches merge main.

## Mock differences

The mock expands a gap in place, uses F8, filters in the page (Unchanged included), has row hover, a "Diff: name" tab
label, a "Compare filtered rows instead" link, "Rows" for the layout toggle, profile cards replacing statistics, and
looser look-alike rules over all rows. This plan has a dashed rule and count, Alt+F5, backend kind filters with Unchanged
as a count, no hover, an "old → new" tab label, no link, **Layout** and **Rows** as separate choices, statistics behind a
toggle, and bounded mutual-best look-alikes.
