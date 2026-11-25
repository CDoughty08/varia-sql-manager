import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import { incompleteText } from '../../../shared/bigquery/dry-run'
import { SnapshotStore } from '../core/store'
import type { CostPromptAnswer, CostPromptRequest } from './bigquery-cost'

interface Pending {
  readonly id: number
  readonly request: CostPromptRequest
  readonly resolve: (answer: CostPromptAnswer) => void
  readonly stillAsks?: () => boolean
  readonly onAnswer?: (answer: CostPromptAnswer) => void
}

/**
 * The cost prompts waiting for an answer, which BigQueryCostPrompt shows one at a time (it is modal). Another tab's prompt
 * waits its turn rather than replacing the one on screen, so an answer always goes to the query it was shown for; a
 * waiting prompt's run can still be cancelled.
 */
export class CostPromptService extends SnapshotStore<{ readonly pending?: Pending }> {
  private readonly queue: Pending[] = []
  private next = 0
  constructor() { super({}) }
  /** Shows the prompt (after any shown before it); `signal` (Cancel, or the tab closing) closes it as Cancel would.
   *  `stillAsks` is checked again when a waiting prompt's turn comes: an answer to the one before it (Don't ask again)
   *  may have made it moot, and it then resolves `moot` without showing (the caller works out what to ask, if anything). `onAnswer` applies an answer (its Don't ask again) before
   *  the next prompt's turn, so that check sees it. */
  ask(request: CostPromptRequest, signal?: AbortSignal, stillAsks?: () => boolean, onAnswer?: (answer: CostPromptAnswer) => void): Promise<CostPromptAnswer> {
    if (signal?.aborted) return Promise.resolve({ run: false })
    return new Promise(resolve => {
      const pending: Pending = { id: ++this.next, request, resolve, ...stillAsks ? { stillAsks } : {}, ...onAnswer ? { onAnswer } : {} }
      signal?.addEventListener('abort', () => this.settle(pending, { run: false }), { once: true })
      this.queue.push(pending)
      this.show()
    })
  }
  /** Answers the prompt with this id, only while it is the one on screen: a second click or Enter never answers the
   *  next tab's. */
  answer(id: number, answer: CostPromptAnswer): void {
    const pending = this.getSnapshot().pending
    if (pending?.id === id) this.settle(pending, answer)
  }
  private settle(pending: Pending, answer: CostPromptAnswer): void {
    const index = this.queue.indexOf(pending)
    if (index < 0) return
    this.queue.splice(index, 1)
    try { pending.onAnswer?.(answer) } catch { /* The answer still stands. */ }
    pending.resolve(answer)
    this.show()
  }
  private show(): void {
    if (this.getSnapshot().pending === this.queue[0] && this.queue[0]) return
    let head = this.queue[0]
    while (head && head !== this.getSnapshot().pending && head.stillAsks && !safe(head.stillAsks)) {
      this.queue.shift()
      head.resolve({ run: true, moot: true })
      head = this.queue[0]
    }
    if (this.getSnapshot().pending !== head) this.publish(head ? { pending: head } : {})
  }
  dispose(): void { for (const pending of this.queue.splice(0)) pending.resolve({ run: false }); this.publish({}); this.clearListeners() }
}

const safe = (check: () => boolean) => { try { return check() } catch { return true } }

/** "1.41 TiB (about $8.81 on demand)", or the bytes alone without prices. */
const figure = (bytes: number, prices: boolean) => prices ? `${formatBytes(bytes)} (about ${formatDollars(bytes)} on demand)` : formatBytes(bytes)

/** The prompt's text (docs/bigquery.md, Cost): its title, sentence, the note under it, and the opt-out's label. */
export function costPromptText(request: CostPromptRequest): { readonly title: string; readonly sentence: string; readonly note: string; readonly optOut: string } {
  const { prompt, prices } = request
  const cap = request.cap === undefined ? 'No maximum bytes billed is set for this query.' : `BigQuery will not bill more than ${formatBytes(request.cap)} for it (its maximum bytes billed).`
  const estimate = 'Estimate from a free dry run.' + (prices ? ' Projects that use reserved capacity are not billed per byte.' : '')
  // A Job History Re-run names the job it runs again.
  const job = request.rerunOf === undefined ? undefined : request.rerunOf.length > 40 ? request.rerunOf.slice(0, 39) + '…' : request.rerunOf
  const title = job ? 'Re-run this job?' : 'Run this query?'
  if (prompt.kind === 'threshold')
    return { title, sentence: `${job ? `Re-running job ${job}` : 'This query'} will process ${figure(prompt.bytes, prices)}, more than the ${formatBytes(request.thresholdBytes)} threshold. Run it?`,
      note: `${estimate} ${cap}${request.ownThreshold ? ' The threshold is this connection\'s own, set in its Advanced Properties (Prompt above).' : ''}`, optOut: `Don't ask again for ${request.connection}` }
  return { title, sentence: `The estimate for ${job ? `re-running job ${job}` : 'this query'}, ${figure(prompt.bytes, prices)}, may be low. ${incompleteText[prompt.reason]} Run it?`,
    note: `${estimate} ${cap}`, optOut: "Don't warn me about incomplete estimates again" }
}
