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

export interface ComparisonChoice { readonly id: string; readonly label: string; readonly detail: string }
const clampEnd = (value: string, cap: number) => value.length > cap ? value.slice(0, cap - 1) + '…' : value
const clampStart = (value: string, cap: number) => value.length > cap ? '…' + value.slice(value.length - cap + 1) : value
const parentPath = (path: string) => path.replace(/[\\/]+[^\\/]*$/, '')
const preciseTime = (time: number) => {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? 'time unavailable' : `${date.toLocaleTimeString()} +${String(date.getMilliseconds()).padStart(3, '0')} ms`
}
/** Selector choices. Labels that would read identically gain the context that tells them apart (a document's folder,
 * a snapshot's millisecond), then a short identifier, so no two choices share a label. Labels stay bounded; `detail`
 * carries the full path or capture context for a tooltip and the accessible description. */
export function comparisonChoices(entries: readonly RetainedPlan[],
  documents: readonly { id: string; name: string; dirty: boolean; kind?: string; file?: { path: string } }[]): ComparisonChoice[] {
  const choices = [
    ...entries.map(entry => ({ id: 'snapshot:' + entry.id, tag: entry.id,
      label: `${entry.captureType} · ${clampEnd(entry.context.name, 80)} · batch ${entry.batchNumber}, repetition ${entry.iteration} · ${new Date(entry.context.startedAt).toLocaleString()}`,
      context: [preciseTime(entry.context.startedAt), entry.context.file && parentPath(entry.context.file) ? clampStart(parentPath(entry.context.file), 48) : ''].filter(Boolean).join(' · '),
      detail: [entry.context.file ?? entry.context.name, `${entry.context.server ?? 'Server unavailable'} / ${entry.context.database}`, `started ${new Date(entry.context.startedAt).toLocaleDateString()} ${preciseTime(entry.context.startedAt)}`].join(' · ') })),
    ...documents.filter(document => document.kind === 'sqlplan').map(document => ({ id: 'document:' + document.id, tag: document.id,
      label: `Document · ${clampEnd(document.name, 80)}${document.dirty ? ' · edited' : ''}`,
      context: document.file ? clampStart(parentPath(document.file.path) || document.file.path, 48) : 'not saved',
      detail: `${document.file?.path ?? 'Not saved to a file'}${document.dirty ? ' · unsaved edits' : ''}` }))
  ]
  const collisions = () => {
    const counts = new Map<string, number>()
    for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1)
    return new Set(choices.filter(choice => counts.get(choice.label)! > 1))
  }
  for (const choice of collisions()) choice.label += ' · ' + choice.context
  for (const choice of collisions()) choice.label += ' · #' + choice.tag.slice(-6)
  // Identifier tails can still coincide; the position in the list cannot.
  const seen = new Map<string, number>()
  for (const choice of collisions()) { const n = (seen.get(choice.label) ?? 0) + 1; seen.set(choice.label, n); choice.label += ` · (${n})` }
  return choices.map(({ id, label, detail }) => ({ id, label, detail }))
}
