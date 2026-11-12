# Result grid tools

Right-click a result column header or cell, or press Shift+F10 in the grid, to open its menu.

- **Copy Column Name** copies that column's raw name only, without data, brackets or a display-name fallback. An unnamed
  column copies an empty string. Ordinary **Copy** and **Copy with Headers** keep their existing result-data formatting.
- **Fit Column** fits that column to its header and the widest measured value. It uses the same bounded measurement as
  double-clicking the column's right border: the first 4,096 rows plus the visible rows, subject to the existing width
  limits. It changes no result data or order. From the keyboard menu, it acts on the focused grid's active column.
- **Close Results**, in the grid menu, results toolbar and command palette, releases all result sets for that query and
  keeps Messages. It is unavailable while that query is executing. Hiding the results pane still keeps its results.
- The **Close** button at the end of a result's caption ("Close Result 2") closes that one result and frees its memory.
  The other results keep their names and numbers (closing Result 2 does not rename Result 3), their sort, filters,
  selection and heights. A pivot, transpose or comparison made from a closed result stays: it is a result of its own.
  Anything still being built from the closed result (a pivot, a transpose, a comparison, a sort, a copy) is cancelled; a
  save that has already started writing its file finishes. The run summary and its row count do not change. Closing the
  last result leaves the Results view saying "Results were closed. Execute the query again to see them."; Messages and
  captured execution plans stay. The button is unavailable while the query is executing, and there is no undo. Peek's
  top rows have no close button.

The menu keeps the query, result set and column it was opened for, including in popped-out panels. Column actions refuse
a result replaced by another execution or lost with the backend. The toolbar closes its own query's results; it does not
switch or close query documents. Closing results from the output moves focus to its surviving Results tab. Closing one
result from its caption moves focus to the next result's caption, else the previous one's, else the Results tab.

The run summary's row count is the rows the query returned: pivots, transposes and comparisons do not add to it. After a
splitter between results has been dragged, a result added later (a pivot, say) takes an average share and the others
keep their proportions.

The column commands are available to keyboard users through the grid's context menu and can be assigned shortcuts in
Tools > Options > Environment > Shortcuts.

## Error source navigation

SQL errors with a location in the submitted query have a **Go to line** button in Messages. Activate it from the keyboard,
or double-click the error, to focus that query and reveal its line. Selection offsets and `GO` batch offsets are included.
Editing the query disables the old location; re-executing replaces it. Copying Messages includes only their text.

Procedure-relative errors and batches that can execute nested SQL have no source link: SQL Server can report a line in
the nested scope rather than the query's text. Errors without a source location, cancellation and connection failures
remain ordinary messages.
