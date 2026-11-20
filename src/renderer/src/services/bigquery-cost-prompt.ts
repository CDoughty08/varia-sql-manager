import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import { incompleteText } from '../../../shared/bigquery/dry-run'
import { SnapshotStore } from '../core/store'
import type { CostPromptAnswer, CostPromptRequest } from './bigquery-cost'

interface Pending { readonly request: CostPromptRequest; readonly resolve: (answer: CostPromptAnswer) => void }

/** The cost prompt waiting for an answer (one at a time: it is modal), which BigQueryCostPrompt shows. */
export class CostPromptService extends SnapshotStore<{ readonly pending?: Pending }> {
  constructor() { super({}) }
  ask(request: CostPromptRequest): Promise<CostPromptAnswer> {
    // A prompt still open (another tab's Execute) is answered Cancel first, so no run waits forever.
    this.getSnapshot().pending?.resolve({ run: false })
    return new Promise(resolve => { this.publish({ pending: { request, resolve } }) })
  }
  answer(answer: CostPromptAnswer): void {
    const pending = this.getSnapshot().pending
    if (!pending) return
    this.publish({})
    pending.resolve(answer)
  }
  dispose(): void { this.answer({ run: false }); this.clearListeners() }
}

/** "1.41 TiB (about $8.81 on demand)", or the bytes alone without prices. */
const figure = (bytes: number, prices: boolean) => prices ? `${formatBytes(bytes)} (about ${formatDollars(bytes)} on demand)` : formatBytes(bytes)

/** The prompt's text (docs/bigquery.md, Cost): its title, sentence, the note under it, and the opt-out's label. */
export function costPromptText(request: CostPromptRequest): { readonly title: string; readonly sentence: string; readonly note: string; readonly optOut: string } {
  const { prompt, prices } = request
  const cap = request.cap === undefined ? 'No maximum bytes billed is set for this query.' : `BigQuery will not bill more than ${formatBytes(request.cap)} for it (its maximum bytes billed).`
  const estimate = 'Estimate from a free dry run.' + (prices ? ' Projects that use reserved capacity are not billed per byte.' : '')
  if (prompt.kind === 'threshold')
    return { title: 'Run this query?', sentence: `This query will process ${figure(prompt.bytes, prices)}, more than the ${formatBytes(request.thresholdBytes)} threshold. Run it?`,
      note: `${estimate} ${cap}`, optOut: `Don't ask again for ${request.connection}` }
  return { title: 'Run this query?', sentence: `The estimate for this query, ${figure(prompt.bytes, prices)}, may be low. ${incompleteText[prompt.reason]} Run it?`,
    note: `${estimate} ${cap}`, optOut: "Don't warn me about incomplete estimates again" }
}
