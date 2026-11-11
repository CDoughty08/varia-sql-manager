import type { EntryKey, ResultSetEntry } from '../../src/renderer/src/results/ResultsService'

type Listed = { readonly sets: readonly Pick<ResultSetEntry, 'key'>[] }
type Results = { getSnapshot(): Readonly<Record<string, Listed | undefined>> }

/**
 * The key of the entry a test set up at `place` in a tab's run, so a test can name "the second result" the way the
 * interface does: by the key it reads off that grid. ResultsService publishes once a frame, so for the service itself this
 * reads the run it holds, which already has an entry the snapshot does not show yet; for a hand-built stand-in it reads the
 * snapshot. A place with no entry gives a key no entry has.
 */
export function keyAt(results: Results, tabId: string, place: number): EntryKey {
  const held = (results as unknown as { runs?: ReadonlyMap<string, Listed> }).runs?.get(tabId)
  const sets = held?.sets ?? results.getSnapshot()[tabId]?.sets
  return sets?.[place]?.key ?? `no-entry-${place}`
}
