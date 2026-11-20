import { gibibytes, incompleteText, pricedBytes } from '../../shared/bigquery/dry-run'
import type { SettingsValues } from '../../shared/settings/catalog'
import type { StatusTone } from '../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import StatusPill from './kit/StatusPill'
import type { EstimateState } from './services/bigquery-cost'

/** The chip's tone, words and tooltip for a tab's estimate (docs/bigquery.md, Cost). */
export function costChip(state: EstimateState, settings: Pick<SettingsValues, 'queryExecution.bigQuery.costPrompt' | 'queryExecution.bigQuery.costThreshold' | 'queryExecution.bigQuery.showCost'>): { tone: StatusTone; label: string; title: string } {
  const prices = settings['queryExecution.bigQuery.showCost'] !== 'bytes'
  const rate = prices ? ' Prices are on-demand estimates; projects that use reserved capacity are not billed per byte.' : ''
  switch (state.phase) {
    case 'checking': return { tone: 'running', label: 'Estimating…', title: 'A free dry run is estimating what this query will process.' }
    case 'ran': return { tone: 'success', label: `${pricedBytes(state.bytes, prices)} processed`, title: `What the last run processed.${rate}` }
    case 'refused': return { tone: 'critical', label: 'Query error', title: `${state.message} (from a free dry run)` }
    case 'unavailable': return { tone: 'neutral', label: 'No estimate', title: state.message }
    case 'estimate': {
      if (state.faked) return { tone: 'neutral', label: 'No estimate', title: 'The BigQuery emulator does not estimate queries.' }
      const threshold = gibibytes(settings['queryExecution.bigQuery.costThreshold']) ?? 0
      const over = settings['queryExecution.bigQuery.costPrompt'] && state.bytes > threshold
      const note = state.incomplete ? ` ${incompleteText[state.incomplete]}` : ''
      return { tone: over ? 'warning' : 'neutral', label: `≈ ${pricedBytes(state.bytes, prices)}`,
        title: `Free dry-run estimate: this query will process about ${pricedBytes(state.bytes, prices)}.${over ? ' Over the threshold: Execute asks first.' : ''}${note}${rate}` }
    }
  }
}

/** The estimate beside Execute on a BigQuery query tab: neutral, amber above the cost-prompt threshold, and after a run
 *  what the job processed and cost. Shown only while there is an estimate to show. */
export default function BigQueryCostChip({ tabId }: { tabId: string | undefined }) {
  const { bigQueryCost, settings } = useWorkbench()
  const estimates = useServiceSnapshot(bigQueryCost), values = useServiceSnapshot(settings).values
  const state = tabId ? estimates.get(tabId) : undefined
  if (!state) return null
  const chip = costChip(state, values)
  return <span className="bigquery-cost-chip" role="status" aria-label={`Estimate: ${chip.label}`} title={chip.title}>
    <StatusPill tone={chip.tone} label={chip.label} size="small" title={chip.title} />
  </span>
}
