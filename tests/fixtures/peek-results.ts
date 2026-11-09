import type { QueryResult, ResultDescriptor } from '../../src/shared/contracts'
import type { PeekResults } from '../../src/renderer/src/explorer/PeekService'
import type { RunEnd } from '../../src/renderer/src/results/ResultsService'

/**
 * A stand-in for ResultsService as Peek uses it: the keys whose runs it follows, the keys released, and the result sets a
 * summary that arrived after its key was released freed (as ResultsService.finish frees them when no run shows them).
 */
export function fakeResults() {
  const runs = new Map<string, string>()
  const released: string[] = []
  const orphanSets: number[] = []
  const results: PeekResults & { released: string[]; orphanSets: number[]; held(): string[] } = {
    begin: (key: string, queryId: string) => { runs.set(key, queryId) },
    finish: (key: string, queryId: string, end: RunEnd) => {
      if (runs.get(key) !== queryId) for (const set of end.summary?.resultSets ?? []) orphanSets.push(set.resultId)
    },
    release: (key: string) => { runs.delete(key); released.push(key) },
    released,
    orphanSets,
    held: () => [...runs.keys()]
  }
  return results
}

/** A Top rows run's summary: one result set (`resultId` 7 unless given), or none. */
export function summary(_key: string, sets = 1, resultId = 7): QueryResult {
  const descriptor = { generation: 1, resultId, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [], rowsRead: 2, rowsStored: 2, rowsAvailable: 2, bytesStored: 8,
    truncatedCells: 0, state: 'complete', incomplete: false } satisfies ResultDescriptor
  return {
    resultSets: sets ? [descriptor] : [], discardedResultSets: 0, messages: [], recordsAffected: 0, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
    database: 'Sales', messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-11-08T00:00:00.0000000'
  }
}
