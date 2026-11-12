# Result grid tools

Right-click a result column header or cell, or press Shift+F10 in the grid, to open its menu.

- **Copy Column Name** copies that column's raw name only, without data, brackets or a display-name fallback. An unnamed
  column copies an empty string. Ordinary **Copy** and **Copy with Headers** keep their existing result-data formatting.
- **Fit Column** fits that column to its header and the widest measured value. It uses the same bounded measurement as
  double-clicking the column's right border: the first 4,096 rows plus the visible rows, subject to the existing width
  limits. It changes no result data or order. From the keyboard menu, it acts on the focused grid's active column.
- **Close Results**, in the grid menu, results toolbar and command palette, releases all result sets for that query and
  keeps Messages. It is unavailable while that query is executing. Hiding the results pane still keeps its results.
- The **Close** button at the end of a caption closes that view and frees its memory. A result's own ("Close Result 2")
  closes the result with its Pivot, which the button's tooltip says ("Close Result 2 and its Pivot"); a Pivot's ("Close
  Pivot of Result 2") or a comparison's closes that one alone. **Close Just This Result** in the grid menu, and **Close
  Result** in the command palette, do the same for the grid they are used on (from the palette, the grid last used).
  The other results keep their names and numbers (closing Result 2 does not rename Result 3), their sort, filters,
  selection and heights. A comparison made from a closed result stays: it copied what it compared. Anything still being
  built from the closed result (a pivot, a transpose, a comparison, a sort, a copy) is cancelled; a save that has
  already started writing its file finishes. The run summary and its row count do not change. Closing the last result
  leaves the Results view saying "Results were closed. Execute the query again to see them."; Messages and captured
  execution plans stay. Closing one view is unavailable while the query is executing, and there is no undo.

The menu keeps the query, result set and column it was opened for, including in popped-out panels. Column actions refuse
a result replaced by another execution or lost with the backend. The toolbar closes its own query's results; it does not
switch or close query documents. Closing results from the output moves focus to its surviving Results tab. Closing one
result from its caption moves focus to the next result's caption, else the previous one's, else the Results tab.

The run summary's row count is the rows the query returned: pivots, transposes and comparisons do not add to it. After a
splitter between results has been dragged, a result added later (a pivot, say) takes an average share and the others
keep their proportions.

## Groups

Each result the query returned is a group, named by its number. The stack draws one item per view, in this order:

- each result's own grid (its Table), with its **Pivot** directly under it once one is built, then the next result;
- every comparison after the results, in the order made ("Differences: Result 1 → Result 3").

A result has at most one Pivot, and a Pivot is always read from the result's own rows, never from another Pivot. The
pivot builder belongs to one result and names it as its source; there is nothing to pick. It follows the grid you last
used: that grid's result, or, when the grid is a comparison or a plan set, the first result that can be pivoted. Each
result keeps its own draft, which a re-run's result of the same number takes over. **Pivot Results…** on a Pivot's grid
opens the builder for that Pivot's result. **Build Pivot** on a result that has a Pivot replaces it: the old Pivot is
released first and the new one shown when it is built, so a build that fails or is cancelled leaves the result without
one.

**Compare with Previous Result** compares a result's own grid with the nearest earlier result's own grid; Pivots,
comparisons and plan sets are never compared.

A SQL-returned execution plan set (`SET SHOWPLAN_XML ON`, say) is a group too: it is numbered, its link opens the plan,
and closing it removes that plan from the Execution plan pane. Pivot, Compare and Transpose are unavailable for it.

The Results tab's badge counts the query's own results, not their Pivots or comparisons.

After a re-run the results come back in the same order under the same names, and the result whose grid was last used
is the one commands act on again. Pivots and comparisons are not rebuilt.

A stored transpose ("Transpose of Result 1") is drawn after its result's Pivot and closes with its result.

## Peek's rows

Peek's top rows are drawn bare: the grid alone, with no caption, close button, results toolbar or side panels. (A
caption appears while the grid has a filter, so the filter can be removed.) Copy, Save Results As, sorting, filters,
Keep Selected Rows and Transpose work as in query output; Pivot, Compare, Close Just This Result and Close Results are
not offered for a Peek grid.

The column commands are available to keyboard users through the grid's context menu and can be assigned shortcuts in
Tools > Options > Environment > Shortcuts.

## Copying and saving a transposed view

A results grid drawn transposed (its columns as rows) copies and saves what it shows; nothing is stored for it.

- Each line is one of the result's columns and each value on it one row, in the grid's current sort and filters. A block
  selected in the transposed grid copies as that block.
- With headers (**Copy with Headers**, or a save with the header option on) the first line reads `Column`, `Row 1`,
  `Row 2`… and each line starts with its column's name. When a column is used as headers, its values name the rows
  instead, as the grid's headers show them (`NULL`, `(blank)`, binary as hex, at most 128 characters); a repeated value
  gets `_2`, `_3`… so every field has its own name. That column is still written as a line.
- A JSON save is one object per column, with every value as text and NULL as `null`.
- The first 4,095 rows of the view are written, the ones the transposed grid draws. When rows are left out, the toolbar
  says how many; filter the results to copy or save others.

## Error source navigation

SQL errors with a location in the submitted query have a **Go to line** button in Messages. Activate it from the keyboard,
or double-click the error, to focus that query and reveal its line. Selection offsets and `GO` batch offsets are included.
Editing the query disables the old location; re-executing replaces it. Copying Messages includes only their text.

Procedure-relative errors and batches that can execute nested SQL have no source link: SQL Server can report a line in
the nested scope rather than the query's text. Errors without a source location, cancellation and connection failures
remain ordinary messages.
