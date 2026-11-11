# Changelog

## [Unreleased]

### Added

- **About Varia:** find the running version, platform and update status from Help or the command palette (also the app menu on macOS). Copy version details for support and open the project, issue form or release notes without needing a server connection.

## [0.8.0] - 2026-11-10

A feature release focused on SQL IntelliSense, result transformations and everyday query workflows.

### Added

- **SQL IntelliSense:** bundled SQL Tools Service provides connection-aware completion, identifier hover, syntax and catalog diagnostics, and **Refresh Local Cache** (Ctrl+Shift+R). Suggestions distinguish columns from different sources, and SQL issues appear in the editor with keyboard navigation. See [language services](docs/language-services.md).
- **Results filters:** filter by selected values, ranges, NULLs or duplicate rows without re-executing SQL. Each column's funnel offers a searchable distinct-value checklist with counts and custom conditions. Filters combine with sorting; search, profiles, highlights, copy and export follow the displayed rows.
- **Pivot results:** group the displayed rows and calculate Count, Distinct Count, Sum, Average, Min or Max, with optional column groups and totals. The pivot opens as another result that can be sorted, filtered, copied and exported.
- **Transpose results:** turn all displayed rows or selected rows into columns, optionally using a selected column's values as headers. NULLs and truncation marks are preserved; the new columns contain text.
- **Activity Monitor Processes:** a live sessions grid with view chips, system-session and Varia-session toggles, column filters and text filtering. Every overview chart can now be expanded at once.
- **Query workflows:** reopen closed queries with Ctrl+Shift+T as unsaved, disconnected copies, open queries in a specific editor group with its **+** button or a double-click, and see whether Execute will run a selection or the entire query. Status-bar controls offer Go to Line and insert/overtype switching.
- **Results and error navigation:** Copy Column Name, keyboard-accessible Fit Column, a results-toolbar Close Results button, and Go to Line for SQL errors whose source location is still current. See [result grid tools](docs/results-tools.md).

### Changed

- **Updates on Windows:** an installed copy in a folder you can write (the installer's default) now unpacks a new release beside itself while you work, so **Restart to Update** swaps it in instead of running the installer. Installations for all users keep the installer. See [updates](docs/updates.md).
- **Updates on macOS:** macOS builds no longer download updates. They are not code signed, so they tell you a release exists and open the releases page.
- **Restart to Update** verifies the downloaded file again before installing it.

### Fixed and improved

- Improve tab focus, rename and overflow behavior; single-row shelves scroll horizontally, stacked shelves expose hidden tabs, and each group's requested shelf heights restore with the workspace.
- Show Object Explorer Peek definitions in a read-only editor with Find and SQL hover, page long definitions without silently cutting them, and keep Peek usable in narrow panels.
- Improve saved-connection selection, Object Explorer recovery actions, database-scoped object search, compact controls and keyboard focus through menus.
- Correct result highlight and comparison edge cases, filtered row counts and filter/sort key reuse; keep numeric pivot sums exact to 38 digits.
- Harden shortcut import and persistence, cancellation responses, language-server cleanup, verified runtime downloads and packaged-app smoke checks.

### Availability and limits

- Connected IntelliSense supports SQL Login and Windows authentication. Entra IntelliSense is not yet available; query execution keeps its existing authentication support. Analysis uses a separate connection, so query-session temporary tables and uncommitted changes are unavailable to it.
- Result transformations stay in memory. Transpose takes at most the first 4,095 displayed or selected rows and reports truncation. Pivots exceeding their group or figure limits are refused with an explanation.
- Activity Monitor's Blocking, Resource Waits, Data File I/O and expensive-query panes are not yet shown; this release adds the Processes grid.
- Builds remain unsigned, and macOS builds are not notarized. See the [current limitations](README.md#current-limitations).

## [0.7.0] - 2026-11-08

A feature release focused on execution plans, results analysis and workspace customization.

### Added

- **Execution plans:** a graphical viewer for Actual, Live and Estimated plans, with `.sqlplan`/Showplan XML opening and saving, pan/zoom/fit controls, a searchable operator outline and a properties inspector. Diagnostics show available runtime counters, predicates, parameters, memory grants, spills, warnings and missing-index details.
- **Plan history and comparison:** retain and pin plan snapshots in memory, reopen them after re-execution or closing a query tab, and compare retained or saved plans side by side. History lasts until the workbench window closes or reloads.
- **Estimated plans in the query session:** an explicit command compiles against the current tab's temporary objects and session context. The ordinary estimate command uses an isolated connection. See [estimated plans](docs/estimated-plans.md) for session effects and cancellation behavior.
- **Client Statistics:** per-execution SqlClient traffic, counters and reply-wait timings, with comparisons and averages in a separate output tab.
- **Results analysis:** multi-column sorting without re-execution, text sorting by character or byte length, cell and column search, column profiles and histograms, row-size bars and whitespace visualization. Copy and export follow the displayed sort order.
- **Results highlights and comparison:** color rows across sorting and re-execution using detected row identities, and compare against the previous result in a unified diff, with an optional exact-text mode.
- **Editor groups and tab shelves:** split, stack and float query groups inside the main window, pin query tabs in separate shelves, and adjust pinned and unpinned shelf row counts independently. Groups and pins restore through hot exit.
- **Panel windows:** move Object Explorer, Results, Messages and Execution Plan panels into separate operating-system windows, then return them to the main window.
- **Object Explorer Peek:** inspect supported objects' definitions, properties, columns or parameters, dependencies and top rows in a card or document tab. Pinned server headers keep server context visible while scrolling.
- **Search Objects:** fuzzy name matching, searches across connected servers, a details pane, result context menus and improved keyboard navigation.
- **Custom shortcuts:** an Environment › Shortcuts page for scoped keyboard bindings, conflict handling, supported mouse gesture modifiers, import/export and resets.
- **Memory visibility:** live status-bar meters and details for search-index and retained-result memory budgets.

### Fixed and improved

- Preserve restored query text through renderer crashes and Windows session ends, and protect newer external file edits when saving restored tabs.
- Improve docking guides, floating and detached-panel focus, tab overflow and workspace restoration.
- Bound and cancel result searches, profiles and comparisons reliably; preserve highlight identities through sorting and re-execution.
- Reduce result-ingestion allocations and search/index work, improve large XML and SQL Server 2025 JSON handling, and bound SSIS Operations scans.
- Improve macOS SQL-file paths and links, Linux middle-button paste handling, and saved-connection double-click behavior.
- Harden the renderer origin, IPC validation and packaged Electron fuses; update Electron, DOMPurify and other dependencies.
- Improve startup packaging and run packaged-app smoke checks before publishing installers for Windows, Linux and both macOS architectures.

### Availability and limits

- Automatic Actual plan capture requires Extended Events permissions. Live plans require a supported server and profiling permissions; see [live plans](docs/live-plans.md) and [capture requirements](docs/plan-capture-hardening.md).
- Results, searches, profiles, diffs and plan history remain bounded in memory. The application reports truncation, partial data and estimates.
- Builds remain unsigned, and macOS builds are not notarized. See the [current limitations](README.md#current-limitations) for features still in development.

## Earlier releases

Release notes for [0.6.0 and earlier](https://github.com/CDoughty08/varia-sql-manager/releases/tag/v0.6.0) are available on GitHub.

[Unreleased]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.6.0...v0.7.0
