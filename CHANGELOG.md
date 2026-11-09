# Changelog

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

[0.7.0]: https://github.com/CDoughty08/varia-sql-manager/compare/v0.6.0...v0.7.0
