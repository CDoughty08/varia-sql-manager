# Changelog

## [Unreleased]

### Added

- **Getting Started:** read offline connection, query and results guides with live shortcuts, option values and mouse gestures, plus interactive fictional examples. Open it from Help or the command palette. Navigation stays available if a guide cannot load.
- **About Varia:** find the running version, platform and update status from Help or the command palette (also the app menu on macOS). Copy version details for support and open the project, issue form or release notes without needing a server connection.
- **In-app release notes:** read curated release highlights and limits offline, browse bundled history and open notes for the exact version advertised by an update. Missing notes are reported clearly, with release downloads available separately.

### Improved

- **Results:** sorting, filtering for duplicates, listing a column's values and pivoting are several times faster on number columns with many repeated values (a status, a flag, a foreign key).
- **Results:** the same operations on text, date and binary columns are many times faster on large results, most of all when values repeat or share their first characters (names, paths, codes, the dates of a month), and now use several processor cores, shared between the operations running. When result memory is too full to do this in time, they say so instead of running to their time limit.
- **Results:** column profiles of several columns are faster on large results: each column is read on its own processor core.

### Fixed

- **Results:** when a running query fills its result memory budget (or reaches a row limit, or the computer runs low on memory), the grid now says so at once, with the rows read still counting, instead of only after the query ends.
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
