// The hand-run benchmarks that use the real backend's own budget (scripts/pivot-bench.mjs, scripts/grid-bench.mjs --live)
// meet its memory-load check: on a computer at high memory load (the operating system's load at or past what .NET calls
// high, about 90 %) the backend stores no more rows and refuses pivots and sorts, saying the computer is low on memory.
// Timings taken then measure a machine that is paging, so the benchmarks stop and say so instead of timing it or failing
// on a missing grid. The backend's sentences (SqlService.LowMemory, BudgetStoppedLowMemory and the truncation note) are
// matched by tests/bench-memory-load.test.ts.
export const lowMemoryText = /computer (?:is|was) low on memory/i

export const lowMemoryStop = what => `${what}: the backend reported that this computer is low on memory, so it stored no more rows `
  + 'or refused the work. Timings taken at high memory load measure paging, not Varia. Close other programs and run the benchmark again.'

/** Throws `lowMemoryStop(what)` when the page shows one of the backend's low-memory sentences anywhere (messages, panels). */
export async function stopIfLowMemory(page, what) {
  if (await page.getByText(lowMemoryText).count() > 0) throw new Error(lowMemoryStop(what))
}
