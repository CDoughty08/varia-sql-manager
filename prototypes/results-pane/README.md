# Results pane mocks

Design references for [the grouped results plan](../../docs/grouped-results-implementation-plan.md) (revision 7). They are
not production code: each file is one self-contained page (inline CSS and JS, no network, no build step) that opens
directly in a browser. Where a mock and the plan disagree, the plan wins.

Every page has a Dark / Light switch and pane sizes (Normal, Narrow, Short, Narrow + short; the pane's corner also drags).
Colours are the Varia Dark and Varia Light palettes of `src/shared/theme/palette.ts`; sizes are the Compact metrics of
`src/shared/theme/metrics.ts` and the results grid's own row and header heights. `?theme=light`, `?size=narrow` and
`?state=<id>` in the URL open a page in that state.

| Mock | Shows | Plan sections |
| --- | --- | --- |
| [grouped-results-tabs.html](grouped-results-tabs.html) | The Tabs layout: group and comparison tabs, view tabs (Table, Pivot), the Transposed toggle and its header column, comparisons named old → new, the overflow picker as a themed virtual list (1,000 results), the out-of-date Pivot mark with Update and the notice that a rebuild removed the Pivot's filters, the Keep Selected Rows chip and its refusal, the Compare picker, a plan-set group, the state after the last item is closed, comparisons only, a running query, backend loss, the Messages strip, Save names. | Navigation and layout (Tabs); Operations; Keep Selected Rows; Pivot lifecycle; Closing; Comparisons; Concurrency and limits (Save names) |
| [grouped-results-stacked.html](grouped-results-stacked.html) | The Stacked layout: one item per view, a group's Pivot under its Table, comparisons last, close buttons on captions (a Table's closes its group), collapse, splitters, the Stacked / Tabs toggle, and the Pivot builder following the focused group, with its fallback. | Navigation and layout (Stacked, the layout choice, the builder's group); Closing |
| [grouped-results-transposed.html](grouped-results-transposed.html) | The transposed grid as labelled alternatives for the PR 0 spike: 1 frozen column and header row, 2 sort and filter controls, 3 Using Column as Headers (repeats, NULL, blank, the "Row N" placeholder), 4 the 4,095-row cap strip, 5 a highlighted source row as a column, 6 a transposed Pivot. Pick one per topic, or draw a topic's alternatives side by side. | Transposed orientation; Delivery, PR 0 exit criteria (gutter and header, Using Column as Headers, re-sort and re-filter, marks, the cap's strip) |

`grouped-results-ui.html` is superseded by these three. It predates the plan's decisions (it has Transpose as a stored tab,
no Stacked layout, a picker that needs matching columns, comparisons of pivots, a native select for overflow and
"Comparison N" names) and is a widget fragment that needs a host page. It is kept because the plan links to it.

## What the mocks simplify

- The grid is a small stand-in for `GridView`, not its code. Search, White space, Sort text and Row size are drawn but
  do nothing. Funnels filter only columns with few values.
- The Pivot builder is a three-field version of today's builder. Builds and comparisons finish at once, so progress,
  cancellation, refusals (`BUDGET_STOPPED`, `TOO_LARGE`, the 1,000-result rule) and retries are not shown.
- A comparison's rows are invented from the sample data; no key is implied.
- The running state uses a timer to stand in for pages arriving from the backend.
- The Tabs and Stacked mocks draw Transposed with the A alternatives of the third mock. The owner accepted those and
  the choices below as defaults on 2026-11-11; the spike's decisions agree with 1A, 2A and 5A.

## Choices made where the plan leaves the interface open

- **Where the view's actions sit.** Tabs: on the view-tab row, folding into an Actions menu in narrow panes. Stacked: as
  icon buttons on each caption, folding into a menu.
- **Where "the toolbar says" appears.** As a dismissable notice line under the view row (Tabs) or under the output
  toolbar (Stacked), for the removed Pivot filters and the Keep Selected Rows refusal.
- **Out of date.** A dot on the Pivot's view tab, an "Out of date" chip with Update beside it (on the caption in
  Stacked), and a sentence in the Pivot's strip.
- **Compare picker.** A side panel in the builder's place, with old and new boxes, a swap button, a list of targets, each
  side's unpaired columns (with both types when only the type differs), Exact text, and the filters note, which turns to
  a warning when an input is sorted or filtered.
- **Overflow picker.** Shown only when tabs do not fit; its button counts the items without a tab. One row per view, a
  Pivot indented under its result, with a filter box.
- **A plan-set group** has a Table view tab, a "Plan set" chip and a plan glyph on its tab; its data actions are drawn
  disabled, with the reason in their tooltips, not hidden.
- **Stacked heights.** Each item keeps a height of its own and the stack scrolls; a splitter resizes the item above it.
- **Transposed header picker.** A "Headers: Row number" drop-down beside the Transposed toggle while it is on.
