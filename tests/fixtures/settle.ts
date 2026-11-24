/** Yields to pending microtasks and I/O callbacks without Windows's 15.6 ms `setTimeout(0)` timer rounding. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve))
}
