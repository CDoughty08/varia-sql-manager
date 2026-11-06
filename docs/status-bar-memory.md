# Status bar memory meters

Replace the Results memory text in the bottom-right status bar with one compact Memory control. Its blue ring shows the Search Indexer’s budget usage and its violet ring shows Results budget usage. Keep the rings in the same order and retain their feature colors as usage changes.

![Status bar with a red Memory control and an open breakdown showing Search Indexer near its limit and Results at a critical level](images/status-bar-memory.png)

Hover or keyboard focus previews the breakdown above the status bar. Click, tap, Enter, or Space keeps it open. Escape or a click outside closes it. Each row shows memory used, the feature’s budget, the percentage used, the remaining memory, and what happens as the budget fills.

| Feature | Yellow | Red |
| --- | ---: | ---: |
| Search Indexer | 75% | 95% |
| Results | 90% | 95% |

The control takes the more severe of the two levels and adds a warning symbol. The breakdown names each level so the colors have a text equivalent. The Search Indexer’s yellow threshold reflects the 128 MiB that definitions leave available for object names in the 512 MiB budget. Results keeps its existing 90% warning threshold. The 95% red threshold is a proposed early signal for both features.

## Data and implementation

- **Search Indexer.** `ObjectSearchService` exposes `MemoryUsed` and `Limits.MemoryBytes`. `MemoryUsed` is the estimate charged to the shared budget for object records, names, and definitions across connections. Publish both values through a global backend event. The existing build progress event carries per-request object counts, so keep that event for its current audience. Sample the global counter during builds and refresh on disconnect so the meter reflects released memory. [Backend counter](../backend/Varia.Backend/Search/ObjectSearchService.cs)
- **Results.** `ResultMemoryService` already consumes global `results.memory` events and query summaries with `usedBytes` and `globalBytes`. Keep the backend’s runtime budget, which ranges from 256 MiB to 2 GiB. This store’s usage includes live tables that draw from its shared budget. Add 95% to the backend’s reporting bands so a growing result can trigger red without waiting for a query summary or a 64 MiB change. [Renderer subscription](../src/renderer/src/results/memory.ts)
- **Lifecycle.** Seed usage and limits when the backend connects, and clear the prior generation on replacement. Show unavailable until a current sample exists. Use the backend’s accounted bytes for the tooltip and clamp the visual arc at 100%.
- **Placement.** Mount the trigger in `App.tsx` and render the breakdown in a portal anchored above it. The footer uses `overflow: hidden`, so an overlay inside the footer would be clipped. Scope the alert background to the Memory control so the footer can still show connection and execution state. [Status bar](../src/renderer/src/App.tsx)

## Verification

The mock uses simulated usage with the current 512 MiB index limit and an example 2 GiB Results budget. Playwright verified all three alert levels, hover, click, Enter, Escape, and popover placement at 320 px and 736 px in both light and dark modes. The telemetry and production status bar are implementation work for this PR.
