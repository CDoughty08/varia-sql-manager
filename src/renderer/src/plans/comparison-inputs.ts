import { planLimits } from '../../../shared/plans'
import type { RetainedPlan } from './RetainedPlansService'
import type { PlanSource } from './sources'

/** The two frozen strings are the only XML owned by a comparison (at most 32 MiB UTF-16).
 * Saved XML cannot establish capture kind, completion, session, or estimation mode. */
export interface ComparisonInput {
  readonly label: string; readonly source: PlanSource; readonly provenance: string; readonly xml: string
  readonly snapshot?: RetainedPlan; readonly document?: { id: string; revision: number; file?: string; dirty: boolean }
}
export function snapshotInput(entry: RetainedPlan): ComparisonInput {
  return Object.freeze({ label: entry.label, xml: entry.xml, snapshot: entry,
    source: Object.freeze({ key: entry.sourceKey, label: entry.label, batchNumber: entry.batchNumber, iteration: entry.iteration, read: async () => entry.xml }),
    provenance: [entry.captureType === 'query-returned' ? 'SQL-returned (capture type unspecified)' : entry.captureType === 'actual' ? 'Actual' : 'Estimated',
      entry.context.estimateMode === 'session' ? 'Query session' : entry.context.estimateMode === 'isolated' ? 'Isolated' : '',
      entry.outcome.status, entry.partialExecution ? 'Partial execution' : '', entry.incomplete ? 'Incomplete document' : '', entry.xmlTruncated ? 'Truncated XML' : '',
      `Batch ${entry.batchNumber || 'unavailable'}, repetition ${entry.iteration}`, entry.context.file ?? entry.context.name,
      `${entry.context.server ?? 'Server unavailable'} / ${entry.context.database}`, new Date(entry.context.startedAt).toLocaleString(), `Source ${entry.sourceKey}`].filter(Boolean).join(' · ') })
}
export function documentInput(document: { id: string; name: string; dirty: boolean; file?: { path: string } }, model: { getValueLength(): number; getValue(): string; getVersionId(): number }): ComparisonInput {
  if (model.getValueLength() > planLimits.characters) throw new Error('The plan document exceeds the comparison XML limit.')
  const xml = model.getValue(), revision = model.getVersionId()
  if (!xml.length) throw new Error('The plan document is empty.')
  return Object.freeze({ label: document.name, xml,
    source: Object.freeze({ key: document.id, revision, label: document.name, read: async () => xml }),
    document: Object.freeze({ id: document.id, revision, file: document.file?.path, dirty: document.dirty }),
    provenance: `Document · ${document.file?.path ?? document.name} · revision ${revision}${document.dirty ? ' · Unsaved edits included' : ''} · Capture type, estimation mode and execution status unavailable` })
}
