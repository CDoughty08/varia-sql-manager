import { useMemo } from 'react'
import { maxQueryPlanDocuments } from '../../../shared/plans'
import { limits } from '../../../shared/ipc/wire/protocol'
import type { ResultSetEntry } from '../results/ResultsService'
import PlanViewer from './PlanViewer'
import { orderPlanEntries, type PlanSource } from './sources'
import { useWorkbench } from '../core/WorkbenchContext'
import type { QueryPlanState } from './QueryPlansService'

// A native Showplan result has one document. Unusual multi-row plan results can open further rows from their grid.
const maxXmlSources = limits.maxResultSets.max + maxQueryPlanDocuments

export default function ResultPlans({ queryId, tabId, plans, order, live }: { queryId: string; tabId: string; plans: readonly ResultSetEntry[]; order?: readonly number[]; live?: QueryPlanState }) {
  const { commands } = useWorkbench()
  const key = plans.map(entry => `${entry.descriptor.generation}:${entry.descriptor.resultId}:${entry.index}:${entry.handle.getSnapshot().rowsAvailable}:${entry.handle.getSnapshot().state}`).join('|')
  const sources = useMemo(() => {
    const sources: (PlanSource & { entry: ResultSetEntry; row: number })[] = []
    for (const entry of orderPlanEntries(plans, order)) {
      const snapshot = entry.handle.getSnapshot()
      if (snapshot.state === 'lost' || snapshot.state === 'released') continue
      const { batchNumber, iteration, generation, resultId } = entry.descriptor
      const batchLabel = batchNumber ? `Batch ${batchNumber}${iteration > 1 ? `, repetition ${iteration}` : ''}` : undefined
      for (let row = 0; row < snapshot.rowsAvailable && sources.length < maxXmlSources; row++) {
        sources.push({
          entry, row, key: `${generation}:${resultId}:${row}`, batchLabel, batchNumber, iteration,
          label: entry.capturedPlan ? `Plan ${entry.index + 1}${batchLabel ? ` · ${batchLabel}` : ''}` : `Result ${entry.index + 1}, plan ${row + 1}`,
          read: async (signal: AbortSignal) => {
            const value = await entry.handle.getCell(row, 0, { signal })
            if (value.truncated) throw new Error('This plan was truncated while storing query results. Open its plan document to read the available XML.')
            if (value.isNull || value.error) throw new Error('This execution plan value is unavailable.')
            return value.text
          }
        })
      }
      if (sources.length === maxXmlSources) break
    }
    return sources
  }, [key, order])
  return <PlanViewer key={queryId} sources={sources} identity={'query:' + queryId} live={live} openDocument={key => {
    const source = sources.find(source => source.key === key)
    if (source) void commands.execute('output.openValue', { tabId, cell: { resultIndex: source.entry.index, row: source.row, column: 0, capturedPlan: source.entry.capturedPlan } }, 'toolbar')
  }} />
}
