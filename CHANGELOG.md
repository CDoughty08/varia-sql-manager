# Changelog

## [Unreleased]

### New and improved

- **Toggle Brackets:** Ctrl\+\[ \(Cmd\+\[ on macOS\), the editor's context menu or Edit › Advanced brackets every name in the selection or the whole query, or takes the brackets off again where they are not needed\. Strings, comments, variables and keywords are never touched\.
- **Commas to front or end:** Move Commas to Front and Move Commas to End restyle SELECT lists, GROUP BY, ORDER BY, INSERT column lists, VALUES and parameter lists in the selection or the current statement, keeping trailing comments in place\.

### Changes to everyday use

- **Peek from the query editor:** Hold Ctrl \(Cmd on macOS\) and rest the pointer on a table or other object name to Peek it in a card beside the name, as in Object Explorer\. Alt\+F12 opens the same card at the caret, and Ctrl\+click now opens a Peek tab instead of scripting the object; F12 still scripts it as CREATE\.

## [0.9.0] - 2026-11-15

Organize, name and keep far larger results, see what is slowing your server with the rest of Activity Monitor, and pick up where you left off with restored connections\.

### New and improved

- **Results as tabs:** Show one result at a time with a row of result tabs, each with its own Table and Pivot view, or switch back to Stacked\. Go to Result \(Ctrl\+Shift\+O\) lists every result, Pivot and comparison with a filter, and Ctrl\+Page Up/Down, Ctrl\+1 to Ctrl\+9 and Ctrl\+Alt\+Page Up/Down move between results\. Each result's close button frees just that result\.
- **Named results:** Put /\* \#Name="Open orders" \*/ or \-\- \#Name="Open orders" before a statement to name its result\. The name appears on its tab and caption, in Go to Result, Compare, Pivot titles and suggested Save Results As file names\. The query runs exactly as written; where Varia cannot tell which result a statement returns, the Messages tab explains why the name was not applied\.
- **Pivots that belong to their result:** Each result owns one Pivot, drawn beneath it\. Building again replaces it in place without losing focus or column widths\. When you change a result's filters, its Pivot shows Out of date with Update, and small, quick Pivots rebuild by themselves\.
- **Compare popover and Keep Selected Rows:** Compare opens a small popover beside the grid to choose the other result, swap old and new and compare exact text\. Keep Selected Rows filters a grid to the rows you selected, as one removable filter\.
- **Progress and Cancel for long result operations:** Slow sorts, filters, profiles, Pivots and comparisons show their phase and percentage with Cancel in the results toolbar\. Cancel or Escape keeps the grid's previous order and rows\.
- **Discard results after execution:** As in SSMS, run a query without keeping its rows, for timing very large queries\. Plans and client statistics are still collected, and the status bar and the empty grid say that results were discarded, with a way to turn it off and run again\.
- **Activity Monitor, complete:** Blocking, Active Expensive Queries, Recent Expensive Queries, Resource Waits and Data File I/O join the Sessions grid, which now uses the results grid's sorting and filters\. Right\-click a session for Details \(statement, waits, transactions, tempdb use and locks\) or Kill Process, which asks first and explains rollback\.
- **Table Properties:** Open SSMS's Table Properties from Object Explorer or Peek: General, Permissions, Change Tracking, Storage, Security Predicates and Extended Properties\. Lock escalation, change tracking and extended properties apply in one transaction, and Script shows the same statements\.
- **View Dependencies and Go To Definition:** View Dependencies shows what depends on an object, or what it depends on, as a tree read as you expand it\. In a query, F12 scripts the object under the caret as CREATE to a new tab, Alt\+F12 opens it in Peek, and Ctrl\+click follows F12\.
- **Connections that come back:** Object Explorer connections and each query's server, database and attachment are restored after a restart or reload, and previously connected servers reconnect in the background unless you disconnected them\. Background reconnect never opens a browser sign\-in or runs query text\. Disconnected servers stay in Object Explorer, and Disconnect asks whether to keep or close the server's query tabs\.
- **Getting Started, About and release notes:** Read offline guides to connecting, querying and results, with your current shortcuts and interactive fictional examples\. About Varia shows the version, platform and update status, and Release Notes shows these highlights for the installed version or the one an update offers\.
- **Editor conveniences:** Hold Ctrl and turn the mouse wheel to resize the editor font\. New Query with sp\_help, sp\_who and sp\_lock in the command palette stand in for SSMS's query shortcuts\. Query tabs show the file name on one line and environment and session badges on a second\.

### Changes to everyday use

- **Much larger results:** Results can now use a quarter of the computer's memory up to 16 GiB \(it was 2 GiB\), half of it for one query\. Set your own Result memory limit or Maximum rows kept per execution in Tools › Options › Query Results; changes apply at once\.
- **Results take less memory:** A large result you are not looking at or using is compressed in the background, typically to a third or half of its size, so more results fit\. Nothing is dropped or written to disk\. A query that fills result memory first waits briefly while others are compressed to make room\.
- **Faster result operations:** Sorting, filtering, value lists, profiles, Pivots, Distinct Count, search and Compare are many times faster on large results and use several processor cores, shared fairly between operations running at once\. Changing only the sort no longer recomputes the column profile\.
- **Transpose is a view:** Transpose now turns the same grid on its side instead of adding a result, costing no result memory and following its sort, filters and selection\. Copy and Save Results As write what the transposed grid shows\.
- **New shortcuts for results:** Tabs is the default results layout\. Ctrl\+1 to Ctrl\+9 \(Cmd on macOS\) now pick query tabs and results like a browser's tabs, instead of SSMS's query shortcuts, which are in the command palette\.
- **Lighter search and startup:** Search Objects holds up to about 2\.4 times as many objects per megabyte, and Ctrl\+Q searches the same index, finding objects whether or not Object Explorer has loaded them\. Startup no longer starts IntelliSense for the untouched welcome query, saving about 110 MB until your first edit\.
- **Updated runtime and components:** The SQL backend runs on \.NET 11, shipped with Varia, so there is nothing to install\. Electron 45\.3\.2, Microsoft\.Data\.SqlClient 7\.1\.2 and other components bring security and stability fixes\.

### Fixes

- **Safer object actions and connections:** Delete a database now refuses to run if a different database has taken its name since the dialog opened\. Dependent documents such as Table Designer and Activity Monitor no longer follow a replacement connection by server name alone, and an edited session file cannot make startup sign in with Windows or Entra authentication unasked\.
- **Results you can rely on:** Save Results As JSON writes numbers with more than 15 significant digits as strings so other tools keep their digits\. A running query that fills result memory says so at once, with Stop query\. Compare handles results without key columns, the mouse wheel scrolls very large transposed grids, and result operations are refused cleanly when the computer is low on memory\.
- **Stability across platforms:** Execution timeouts on Linux and macOS stop queries on time, a busy Activity Monitor probe no longer reconnects every other live view, Linux updates no longer delete a newer download, and File › Open opens the files it can read when one cannot be read\. Script As handles ledger objects on Azure SQL Database and targets Managed Instance's real engine version\.

### Things to know

- **Results stay in memory:** Results are never written to disk\. Transposed views and Keep Selected Rows use at most 4,095 rows and say when rows are left out, and a result that fills its memory limit is truncated with an explanation\.
- **Some features depend on permissions:** Kill Process requires ALTER ANY CONNECTION and is never offered for Varia's own connections\. Recent Expensive Queries reads the plan cache only while its pane is shown\. Entra IntelliSense is not available yet\.
- **Unsigned builds:** Builds remain unsigned, and macOS builds are not notarized\. Your operating system may ask you to confirm that you trust the application\.

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

[Unreleased]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.9.0
[0.8.0]: https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.8.0
[0.7.0]: https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.7.0
