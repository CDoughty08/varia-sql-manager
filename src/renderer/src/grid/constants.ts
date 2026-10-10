// The results grid's sizes and limits. Pixel values are CSS pixels; row math stays O(1) because every row is the same
// height. A tile (tileRows × tileColumns cells of at most maxCellChars characters) always fits the worker's window
// limits, so no window is ever cut short by its text budget.
export const gridLimits = {
  rowHeight: 20, headerHeight: 22, cellPadding: 6,
  /** Two paddings and the 1 px gridline: what a column needs beyond its text. */
  cellChrome: 13,
  rowHeaderMinWidth: 40, rowHeaderMinRows: 9999,
  columnMinWidth: 32, columnMaxWidth: 3000, initialMinWidth: 40, initialMaxWidth: 400,
  overscanRows: 8, overscanColumns: 2,
  /** Past this many pooled cells (a 4K view of narrow columns) the overscan shrinks to the reduced one. */
  poolCells: 4000, reducedOverscanRows: 2, reducedOverscanColumns: 1,
  /** Pools shrink only when this much too large, so a resize back and forth does not churn DOM nodes. */
  poolSlack: 0.25,
  tileRows: 128, tileColumns: 32, maxCellChars: 512, textBudget: 2_100_000,
  uiCacheWindows: 256, uiCacheUnits: 16_777_216,
  fetchesPerGrid: 4, fetchesPerClient: 16, abortAfterFrames: 2, frontierPerSecond: 10,
  fastScrollViewports: 3, settleMs: 50, prefetchIdleFrames: 2, prefetchViewports: 2,
  /** A read refused because main's results port is full (many grids reading at once) is tried again after this. */
  busyRetryMs: 250,
  scrollCap: 15_000_000, scrollCapPhysical: 30_000_000, rebaseRows: 4096,
  splitter: 5, stackMinRows: 4, stackBorder: 2, mountedGrids: 12, mountsPerFrame: 2,
  selectionBlocks: 64, dragThreshold: 4, resizeZoneLeft: 4, resizeZoneRight: 3,
  ariaRowCountMs: 1000, liveRegionMs: 300,
  measureInitialRows: 128, measureFitRows: 4096, measureCap: 512,
  copyStripDelayMs: 300,
  /** How long the toolbar shows how a save ended ("Saved 400 rows to results.csv."). */
  jobNoticeMs: 8000,
  /**
   * Stored values, formatted documents, and nesting accepted by the formatters. A large value document opens with a small
   * first chunk and fills a chunk a frame (Monaco's cost grows with the text added at once); over documentBracketChars it
   * has no bracket matching or colours, which Monaco computes over the whole document in one task.
   */
  storedChars: 2_097_152, formattedChars: 4_194_304, xmlDepth: 256, jsonDepth: 512, documentFirstChunk: 16_384, documentChunk: 131_072, documentBracketChars: 65_536
} as const

/** The last row of an open-ended range (whole columns, everything): a copy runs to the end of the result. */
export const openEnd = Number.MAX_SAFE_INTEGER
