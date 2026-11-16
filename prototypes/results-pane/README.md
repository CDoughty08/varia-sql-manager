# Results pane mocks

Historical design mocks for the results pane, kept for reference now that the pane has shipped. They are not
production code and may differ from it; [docs/results-tools.md](../../docs/results-tools.md) describes the pane as it
is. Each file is one self-contained page (inline CSS and JS, no network, no build step) that opens directly in a
browser. Every page has a Dark / Light switch and pane sizes; `?theme=light`, `?size=narrow` and `?state=<id>` open a
page in that state.

| Mock | Shows |
| --- | --- |
| [grouped-results-tabs.html](grouped-results-tabs.html) | The Tabs layout: result and comparison tabs, view tabs (Table, Pivot), Transposed, the overflow picker, out-of-date Pivots and Save names. |
| [grouped-results-stacked.html](grouped-results-stacked.html) | The Stacked layout: one item per view, captions with close buttons, splitters and the Pivot builder following the focused group. |
| [grouped-results-transposed.html](grouped-results-transposed.html) | Alternatives for the transposed grid (frozen column, sort and filter, Using Column as Headers, the row cap, highlights, a transposed Pivot). |
| [compare-picker-options.html](compare-picker-options.html) | Layout options for the Compare picker (docked pane, popover, modal); `?option=A\|B\|C`. |
| [result-operation-progress.html](result-operation-progress.html) | Progress and held-off controls while an operation over a whole result runs; `?option=A\|B\|C`. Write-up: [docs/result-operation-progress.md](../../docs/result-operation-progress.md). |
