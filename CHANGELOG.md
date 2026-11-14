# Changelog

## [Unreleased]

### Added

- **Getting Started:** read offline connection, query and results guides with live shortcuts, option values and mouse gestures, plus interactive fictional examples. Open it from Help or the command palette. Navigation stays available if a guide cannot load.
- **About Varia:** find the running version, platform and update status from Help or the command palette (also the app menu on macOS). Copy version details for support and open the project, issue form or release notes without needing a server connection.
- **In-app release notes:** read curated release highlights and limits offline, browse bundled history and open notes for the exact version advertised by an update. Missing notes are reported clearly, with release downloads available separately.
- **Activity Monitor session details and Kill Process:** right-click a session in Sessions, Blocking or Active Expensive Queries for Details… (its state, current statement, batch, last batch, waits, transactions, tempdb usage and, on request, locks, beside the monitor, with Copy) or Kill Process…, which asks first, names the session's login, host and open transactions, warns about rollback, and reports what happened. Kill is refused, with the reason, without ALTER ANY CONNECTION, and is never offered for Varia's own pooled connections.
- **Activity Monitor Recent Expensive Queries:** see the statements that finished since the previous sample, grouped by query hash with per-second rates, and rank them by CPU, duration, reads, writes or executions. The plan cache is read only while the pane is shown, at its own interval (Settings › Activity Monitor › Query statistics interval, 30 seconds by default). A rank chip or column sort reorders the rows at once, without waiting for the next sample or reading the server again; so does a column sort in any live grid.
- **Activity Monitor Resource Waits and Data File I/O:** see where the server waits, by wait category or by wait type, with a 1-minute average and benign waits hidden by default, and each database file's throughput, read and write latency, response time and size. Files over the I/O latency thresholds (Settings › Activity Monitor) are highlighted, and Over threshold, Rows and Log narrow the list. Both panes read one sample, every 5 seconds by default, only while either is shown.

- **Keep Selected Rows:** filter a results grid to exactly the rows you selected, from the grid menu's Filter submenu. It works on sorted and filtered grids, pivots and comparisons, combines with other filters and sorting, and shows as one removable "12 selected rows" filter. Up to 4,095 rows.
- **Copy and save a transposed view as shown:** a results grid drawn transposed (its columns as rows; the commands that turn a grid this way follow) now copies and saves what it shows, with nothing stored: a line per column and a value per row, in the grid's sort and filters, for Copy, Copy with Headers and Save Results As in every format. With headers the first line reads Column, Row 1, Row 2…, or the values of the column used as headers (a repeated value gets _2, _3…). The first 4,095 rows are written, and the toolbar says how many were left out.
- **Discard results after execution:** Tools › Options › Query Results › SQL Server › Results to Grid can run queries without keeping their rows, as in SSMS: every row is still read from the server, the Messages tab says how many result sets and rows were read and not kept, and execution plans and client statistics are still collected. Useful for timing a very large query.
- **Close one result:** each result's caption has a close button that frees that result's memory and leaves the others as they are, with their names, numbers, sort and filters. Closing a result closes its Pivot with it; a Pivot or a comparison closes on its own, and comparisons made from a closed result stay. **Close Just This Result** in the grid menu (Close Result in the command palette) does the same. Closing the last one keeps the Results view, Messages and captured plans.
- **Grouped results:** each result now owns its Pivot, drawn directly under it, with comparisons after the results. A result has one Pivot, always built from the result itself: the Pivot builder names the result it belongs to and follows the grid you last used (the source picker is gone), each result keeps its own draft, and building again replaces the result's Pivot. Pivots of pivots and several pivots of one result are no longer possible.
- **Larger results:** query results can now use a quarter of the computer's memory up to 16 GiB (it was 2 GiB), half of it for one query, so a query of several million rows keeps them all on a machine with the memory for it. Tools › Options › Query Results › SQL Server › Results to Grid has a **Result memory limit** to set it yourself, and a **Maximum rows kept per execution** for when you only want the first rows. A change to the limit applies at once, without restarting the SQL backend, and the status bar's memory meter follows it; lowering it below what results hold keeps them and stores nothing more until enough are closed. A truncated result names the budget it filled, even after the limit changes.

### Improved

- **Runtime:** the SQL backend now runs on .NET 11 (it was .NET 10). Nothing to install: Varia ships the runtime with the backend. Building from source needs the .NET 11 SDK.
- **Transposed is now a view, not a copy:** Transpose Results draws the same grid with its columns as rows and turns it back again, instead of adding a new result. It costs no result memory, works while rows are still arriving and on a query whose result memory is full, and follows the grid's sort, filters, selection and highlights. Transpose Selected Rows keeps the selected rows as a filter first. Using Column as Headers is a setting of the view, changed from Headers beside the toolbar button. The first 4,095 rows are drawn as columns, with a strip that says so. Shortcuts assigned to the three commands keep working. Copy and Save Results As write the grid as drawn. The transposed names and rows can no longer be sorted, filtered or profiled as a result of their own.
- **Results:** the Results tab's badge counts the query's own results, not their pivots or comparisons. After a re-run, commands act again on the result whose grid you last used. Peek's top rows show the grid alone, without a caption, and no longer offer Pivot, Compare or Close Results, which did nothing useful there.
- **Results:** the run summary's row count is the rows the query returned; a pivot or comparison no longer adds its rows to it. A result added after you drag a splitter no longer resets the other results' heights. Search in results looks again only at the grids that changed.
- **Results:** sorting, filtering for duplicates, listing a column's values and pivoting are several times faster on number columns with many repeated values (a status, a flag, a foreign key).
- **Results:** the same operations on text, date and binary columns are many times faster on large results, most of all when values repeat or share their first characters (names, paths, codes, the dates of a month), and now use several processor cores, shared between the operations running. When result memory is too full to do this in time, they say so instead of running to their time limit.
- **Results:** column profiles are several times faster on large results: they now use several processor cores.
- **Results:** two operations on results at once (two sorts, a sort and a pivot, a pivot beside a column profile) now share the processor cores, so the second no longer runs on what the first leaves: two pivots started together both finish a little later than one alone would, instead of one taking three times as long.
- **Results:** search in results, highlights' row matching and Compare Results use several processor cores too, and filtering for duplicates or listing a column's values no longer sorts every row when the column holds few different values.
- **Results:** a pivot's Distinct Count is many times faster on large results (about 4 seconds down to a fraction of a second for 4 million rows), and Compare Results' matching and a column's value list with many different values now use several processor cores as well.

### Fixed

- **Execution timeouts on Linux and macOS:** a query whose execution timeout passed while many tabs were connecting at once could run past its timeout and report "Query completed with errors" instead of timing out. Timeouts now stop the query on time.
- **Results:** when a running query fills its result memory budget (or reaches a row limit, or the computer runs low on memory), the grid now says so at once, with the rows read still counting, instead of only after the query ends.
- **Results:** the notice for a running query that has filled its result memory, or that stopped keeping rows because the computer is low on memory, now has a **Stop query** button (Cancel Executing Query for that tab), reachable by keyboard, until the query ends. The row limit you set yourself only says it was reached.
- **No leftover language service on Linux and macOS:** a SQL backend that crashed or was restarted while a query's language service was closing could leave that process suspended in the background. It now always ends.

## [0.8.0] - 2026-11-10

Write SQL with connection\-aware suggestions, reshape results without running the query again, and see more of what your server is doing\.

### New and improved

- **SQL IntelliSense:** Get suggestions for tables, columns and other database objects, inspect identifiers with hover, and see SQL issues in the editor\. Refresh Local Cache updates the schema information when objects change\.
- **Filter results in place:** Use a column's funnel to choose values, search its value checklist, or filter by ranges, NULLs and duplicates\. Filters combine with sorting\. Search, copy, export, profiles and highlights follow the displayed rows; SQL is not executed again\.
- **Pivot and transpose:** Group displayed results and calculate counts, sums, averages, minimums or maximums in a new pivot result\. Transpose turns displayed or selected rows into columns\. Both outputs can be sorted, filtered, copied and exported\.
- **Activity Monitor Processes:** Inspect a live sessions grid with text and column filters, view chips, and switches for system sessions and Varia's own sessions\. Expand more than one overview chart at a time\.
- **Recover a closed query:** Reopen closed queries as unsaved, disconnected copies\. Create a query directly in an editor group, and see whether Execute will run your selection or the entire query\. The status bar also offers Go to Line and insert/overtype switching\.
- **More ways to work with results and errors:** Copy a column's name, fit columns with the keyboard, close results from their toolbar, and jump from a SQL error to its source line when the source has not changed\.

### Changes to everyday use

- **Quicker updates on Windows:** An installed copy in a folder you can write now prepares a downloaded release while you work\. Restart to Update swaps it into place\. Installations for all users continue to use the installer\. Restart verifies the downloaded file again before installing\.
- **Manual updates on macOS:** macOS builds tell you when a release is available and open its downloads page\. They no longer download an update that this unsigned copy cannot install itself\.

### Fixes

- **Tabs, Peek and everyday navigation:** Tab focus, renaming and overflow are more reliable\. Peek shows long definitions in a read\-only editor with Find and SQL hover, and remains usable in narrow panels\. Saved\-connection selection and Object Explorer recovery actions are improved\.
- **Results remain consistent as you reshape them:** Corrected highlight and comparison edge cases, filtered row counts and reuse of filter/sort results\. Numeric pivot sums retain precision up to 38 digits\.

### Things to know

- **IntelliSense uses its own connection:** Connected IntelliSense currently supports SQL Login and Windows authentication\. Entra IntelliSense is not available yet; query execution keeps its existing authentication support\. Query\-session temporary tables and uncommitted changes are not visible to the analysis connection\.
- **Results stay in memory:** Transpose uses at most the first 4,095 displayed or selected rows and reports truncation\. A pivot that exceeds its group or figure limits is refused with an explanation\.
- **More Activity Monitor panes are still to come:** This release adds the Processes grid\. Blocking, Resource Waits, Data File I/O and expensive\-query panes are not shown yet\.
- **Unsigned builds:** Builds remain unsigned, and macOS builds are not notarized\. Your operating system may ask you to confirm that you trust the application\.

## [0.7.0] - 2026-11-08

Explore execution plans, compare results, and arrange your SQL workspace around the way you work\.

### New and improved

- **Graphical execution plans:** Inspect Actual, Live and Estimated plans, open and save \.sqlplan files, and navigate with pan, zoom, fit, an operator outline and a properties inspector\. Available diagnostics include runtime counters, predicates, parameters, memory grants, spills and missing\-index details\.
- **Plan history and comparison:** Retain and pin plan snapshots, reopen them after executing again or closing a query tab, and compare retained or saved plans side by side\. Plan history lasts until the workbench window closes or reloads\.
- **Analyze the results you already have:** Sort by multiple columns without executing SQL again\. Search cells and columns, inspect column profiles and histograms, show row sizes and whitespace, and compare against a previous result\. Copy and export follow the displayed order\.
- **Arrange your workspace:** Split, stack and float query editor groups\. Pin queries on separate shelves and adjust shelf heights\. Move Object Explorer, Results, Messages or Execution Plan panels into their own operating\-system windows and return them to the main window\.
- **Inspect objects and find them faster:** Peek at supported objects' definitions, properties, columns, parameters, dependencies and top rows in a card or document tab\. Search Objects adds fuzzy matching, searches across connected servers and a details pane\.
- **Shortcuts, statistics and memory visibility:** Customize scoped keyboard shortcuts and supported mouse modifiers, with conflict handling, import/export and resets\. Client Statistics compares per\-execution counters, while the status bar shows search\-index and retained\-result memory use\.

### Fixes

- **Safer recovery and more reliable focus:** Preserve restored query text through renderer crashes and Windows session ends, protect newer external file edits when saving restored tabs, and improve docking, detached\-panel focus, tab overflow and workspace restoration\.

### Things to know

- **Plan capture depends on server permissions:** Automatic Actual plan capture requires Extended Events permissions\. Live plans require a supported server and profiling permissions\. Estimating a plan in the query session is an explicit action; the ordinary estimate uses a separate connection\.
- **Bounded, in\-memory analysis:** Results, searches, profiles, comparisons and plan history stay within memory limits\. Varia reports truncation, partial data and estimates\. Builds remain unsigned, and macOS builds are not notarized\.

## Earlier releases

Release notes for [0.6.0 and earlier](https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.6.0) are available on GitHub.

[Unreleased]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.8.0
[0.7.0]: https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.7.0
