import type { EntryKey, ResultSetEntry } from '../../src/renderer/src/results/ResultsService'

type Listed = { readonly sets: readonly Pick<ResultSetEntry, 'key'>[] }
type Results = { getSnapshot(): Readonly<Record<string, Listed | undefined>> }

/** A key no entry has, for a check that a result the run lacks is refused. */
export const noEntry: EntryKey = 'no-such-entry'

/**
 * The key of the entry a test set up at `place` in a tab's run, so a test can name "the second result" the way the
 * interface does: by the key it reads off that grid. ResultsService publishes once a frame, so for the service itself this
 * reads the run it holds, which already has an entry the snapshot does not show yet; for a hand-built stand-in it reads the
 * snapshot. It throws when the place has no entry: an assertion about a result that is not there must say so with
 * `noEntry`, or it would pass whatever the code did.
 */
export function keyAt(results: Results, tabId: string, place: number): EntryKey {
  const held = (results as unknown as { runs?: ReadonlyMap<string, Listed> }).runs?.get(tabId)
  const sets = held?.sets ?? results.getSnapshot()[tabId]?.sets
  const key = sets?.[place]?.key
  if (key === undefined) throw new Error(`The run of ${tabId} has no entry at place ${place} (it has ${sets?.length ?? 'no run, so 0'}).`)
  return key
}
