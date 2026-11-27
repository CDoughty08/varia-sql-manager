import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import { incompleteText, pricedBytes, type CostPrompt } from '../../../shared/bigquery/dry-run'
import { SnapshotStore } from '../core/store'
import type { CostPromptAnswer, CostPromptRequest } from './bigquery-cost'

/** One BigQuery target flagged in a multi-project (Cross-Engine) cost prompt. */
export interface MultiProjectCostEntry {
  readonly connectionId: string
  readonly label: string
  readonly dataset?: string
  readonly environment?: string
  readonly prompt: CostPrompt
  readonly thresholdBytes: number
  /** True when the threshold came from the connection's Advanced Properties rather than Tools › Options. */
  readonly ownThreshold?: true
  /** The cap the job will carry (the connection's, else Options'), in bytes. */
  readonly cap?: number
}

/** A single aggregated cost prompt listing every BigQuery project exceeding its threshold or with an incomplete estimate. */
export interface MultiProjectCostPromptRequest {
  readonly kind: 'multi'
  readonly projects: readonly MultiProjectCostEntry[]
  readonly prices: boolean
  readonly totalBytes: number
  /** Total BigQuery targets in the run (may exceed `projects.length` when some targets are below threshold). */
  readonly totalProjectCount?: number
}

interface Pending {
  readonly id: number
  readonly request: CostPromptRequest
  readonly resolve: (answer: CostPromptAnswer) => void
  readonly stillAsks?: () => boolean
  readonly onAnswer?: (answer: CostPromptAnswer) => void
}

interface PendingMulti {
  readonly id: number
  readonly request: MultiProjectCostPromptRequest
  readonly resolve: (answer: CostPromptAnswer) => void
  readonly stillAsks?: () => boolean
  readonly onAnswer?: (answer: CostPromptAnswer) => void
}

type QueueItem = ({ readonly kind: 'single' } & Pending) | ({ readonly kind: 'multi' } & PendingMulti)

export interface CostPromptSnapshot {
  readonly pending?: Pending
  readonly pendingMulti?: PendingMulti
}

/**
 * The cost prompts waiting for an answer, which BigQueryCostPrompt shows one at a time (it is modal). Another tab's prompt
 * waits its turn rather than replacing the one on screen, so an answer always goes to the query it was shown for; a
 * waiting prompt's run can still be cancelled. Single-project and multi-project (Cross-Engine) prompts share one FIFO queue
 * so modals never stack.
 */
export class CostPromptService extends SnapshotStore<CostPromptSnapshot> {
  private readonly queue: QueueItem[] = []
  private next = 0
  constructor() { super({}) }
  /** Shows a single-project prompt (after any shown before it); `signal` (Cancel, or the tab closing) closes it as Cancel would.
   *  `stillAsks` is checked again when a waiting prompt's turn comes: an answer to the one before it (Don't ask again)
   *  may have made it moot, and it then resolves `moot` without showing (the caller works out what to ask, if anything). `onAnswer` applies an answer (its Don't ask again) before
   *  the next prompt's turn, so that check sees it. */
  ask(request: CostPromptRequest, signal?: AbortSignal, stillAsks?: () => boolean, onAnswer?: (answer: CostPromptAnswer) => void): Promise<CostPromptAnswer> {
    if (signal?.aborted) return Promise.resolve({ run: false })
    return new Promise(resolve => {
      const item: QueueItem = { kind: 'single', id: ++this.next, request, resolve, ...stillAsks ? { stillAsks } : {}, ...onAnswer ? { onAnswer } : {} }
      signal?.addEventListener('abort', () => this.settle(item, { run: false }), { once: true })
      this.queue.push(item)
      this.show()
    })
  }
  /** Shows a single multi-project prompt listing all flagged BigQuery projects together (never stacking N modals). */
  askMulti(request: MultiProjectCostPromptRequest, signal?: AbortSignal, stillAsks?: () => boolean, onAnswer?: (answer: CostPromptAnswer) => void): Promise<CostPromptAnswer> {
    if (signal?.aborted || !request.projects.length) return Promise.resolve({ run: false })
    return new Promise(resolve => {
      const item: QueueItem = { kind: 'multi', id: ++this.next, request, resolve, ...stillAsks ? { stillAsks } : {}, ...onAnswer ? { onAnswer } : {} }
      signal?.addEventListener('abort', () => this.settle(item, { run: false }), { once: true })
      this.queue.push(item)
      this.show()
    })
  }
  /** Answers the prompt with this id, only while it is the one on screen: a second click or Enter never answers the
   *  next tab's. */
  answer(id: number, answer: CostPromptAnswer): void {
    const snapshot = this.getSnapshot()
    const active = snapshot.pending?.id === id ? this.queue[0] : snapshot.pendingMulti?.id === id ? this.queue[0] : undefined
    if (active?.id === id) this.settle(active, answer)
  }
  private settle(item: QueueItem, answer: CostPromptAnswer): void {
    const index = this.queue.indexOf(item)
    if (index < 0) return
    this.queue.splice(index, 1)
    try { item.onAnswer?.(answer) } catch { /* The answer still stands. */ }
    item.resolve(answer)
    this.show()
  }
  private show(): void {
    const snapshot = this.getSnapshot()
    const shownId = snapshot.pending?.id ?? snapshot.pendingMulti?.id
    if (shownId !== undefined && this.queue[0]?.id === shownId) return
    let head = this.queue[0]
    while (head && head.id !== shownId && head.stillAsks && !safe(head.stillAsks)) {
      this.queue.shift()
      head.resolve({ run: true, moot: true })
      head = this.queue[0]
    }
    if (!head) {
      if (shownId !== undefined) this.publish({})
      return
    }
    if (head.id === shownId) return
    if (head.kind === 'single') this.publish({ pending: head })
    else this.publish({ pendingMulti: head })
  }
  dispose(): void { for (const item of this.queue.splice(0)) item.resolve({ run: false }); this.publish({}); this.clearListeners() }
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

export interface MultiCostPromptRow {
  readonly connectionId: string
  readonly label: string
  readonly dataset?: string
  readonly environment?: string
  readonly figure: string
  readonly detail: string
  readonly exceedsCap: boolean
  readonly capText?: string
}

export interface MultiCostPromptText {
  readonly title: string
  readonly sentence: string
  readonly rows: readonly MultiCostPromptRow[]
  readonly totalText: string
  readonly note: string
  readonly optOut: string
}

/** Formatted copy and per-project rows for a multi-project (Cross-Engine) BigQuery cost prompt. */
export function multiCostPromptText(request: MultiProjectCostPromptRequest): MultiCostPromptText {
  const { projects, prices, totalBytes, totalProjectCount } = request
  const count = projects.length
  const thresholdProjects = projects.filter(entry => entry.prompt.kind === 'threshold')
  const title = count === 1 ? 'Run this query?' : `Run across ${count} BigQuery projects?`
  const sentence = thresholdProjects.length > 0
    ? count === 1
      ? `${projects[0]!.label} will process ${figure(projects[0]!.prompt.bytes, prices)}, more than its ${formatBytes(projects[0]!.thresholdBytes)} threshold. Run it?`
      : `${count} BigQuery projects require cost confirmation (total ${figure(totalBytes, prices)}). Run the query?`
    : count === 1
      ? `The estimate for ${projects[0]!.label}, ${figure(projects[0]!.prompt.bytes, prices)}, may be low. ${incompleteText[projects[0]!.prompt.kind === 'incomplete' ? projects[0]!.prompt.reason : 'unknown']} Run it?`
      : `Estimates for ${count} BigQuery projects may be low (total ${figure(totalBytes, prices)}). Run the query?`

  const rows: MultiCostPromptRow[] = projects.map(entry => {
    const exceedsCap = entry.cap !== undefined && entry.prompt.bytes > entry.cap
    const detail = entry.prompt.kind === 'threshold'
      ? `Exceeds ${entry.ownThreshold ? 'connection ' : ''}threshold (${formatBytes(entry.thresholdBytes)})`
      : incompleteText[entry.prompt.reason]
    const capText = entry.cap === undefined
      ? undefined
      : exceedsCap
        ? `Exceeds maximum bytes billed (${formatBytes(entry.cap)})`
        : `Maximum bytes billed: ${formatBytes(entry.cap)}`
    return {
      connectionId: entry.connectionId,
      label: entry.label,
      ...entry.dataset ? { dataset: entry.dataset } : {},
      ...entry.environment ? { environment: entry.environment } : {},
      figure: pricedBytes(entry.prompt.bytes, prices),
      detail,
      exceedsCap,
      ...capText ? { capText } : {}
    }
  })

  const scopeSuffix = totalProjectCount && totalProjectCount > count
    ? ` (${count} of ${totalProjectCount} BigQuery projects flagged)`
    : ''
  const totalText = `Total across ${count} ${count === 1 ? 'project' : 'projects'}${scopeSuffix}: ${figure(totalBytes, prices)}`
  const note = 'Estimates from free dry runs.' + (prices ? ' Projects that use reserved capacity are not billed per byte.' : '')
  const optOut = thresholdProjects.length === 1
    ? `Don't ask again for ${thresholdProjects[0]!.label}`
    : thresholdProjects.length > 1
      ? `Don't ask again for these ${thresholdProjects.length} projects`
      : "Don't warn me about incomplete estimates again"

  return { title, sentence, rows, totalText, note, optOut }
}
