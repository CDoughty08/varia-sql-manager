import type { ApiResult, ResultDescriptor } from '../../../shared/contracts'
import type { ResultKey } from '../results/worker-protocol'
import { maxQueryPlanDocuments, planLimits, type PlanDocument, type PlanStatement } from '../../../shared/plans'

/** Order both sources by batch and GO repetition, then by observer position wherever SQL matched the same execution. */
export function orderPlanEntries<T extends { descriptor: Pick<ResultDescriptor, 'batchNumber' | 'iteration' | 'resultId'> }>(entries: readonly T[], order?: readonly number[]): T[] {
  const rank = new Map(order?.map((id, index) => [id, index]))
  const last = Number.MAX_SAFE_INTEGER
  return entries.toSorted(({ descriptor: a }, { descriptor: b }) => (a.batchNumber || last) - (b.batchNumber || last)
    || a.iteration - b.iteration || (rank.get(a.resultId) ?? last) - (rank.get(b.resultId) ?? last))
}

export interface PlanSource { key: string; revision?: number; result?: ResultKey; label: string; batchLabel?: string; batchNumber?: number; iteration?: number; read(signal: AbortSignal): Promise<string> }
export type SourceStatement = PlanStatement & { sourceKey: string; batchLabel?: string; batchNumber?: number; iteration?: number; partial?: boolean }
export class PlanInputBudgetError extends Error {
  constructor() { super('The combined input budget was exceeded. Remaining plan documents were not loaded.') }
}
export class PlanSourceParseError extends Error {
  constructor(error: unknown, readonly characters: number) { super(error instanceof Error ? error.message : 'The plan could not be parsed.') }
}
/** Failed attempts still consume input: malformed XML must not bypass the combined viewer budget. */
export async function parseSourceXml(xml: string, parse: (xml: string) => Promise<ApiResult<PlanDocument>>, signal: AbortSignal): Promise<PlanDocument> {
  try {
    const result = await parse(xml)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.error)
    return result.value
  } catch (error) {
    signal.throwIfAborted()
    throw new PlanSourceParseError(error, xml.length)
  }
}
/** Treat a failed/truncated source separately so an earlier valid plan in the same run remains usable. */
export async function loadPlanSources(sources: readonly PlanSource[], parse: (xml: string) => Promise<ApiResult<PlanDocument>>, signal: AbortSignal,
  prepare?: (source: PlanSource, signal: AbortSignal, remaining: number) => Promise<{ document: PlanDocument; characters: number }>): Promise<{ statements: SourceStatement[]; notices: string[] }> {
  const statements: SourceStatement[] = [], notices: string[] = [], errors: string[] = []
  if (sources.length > maxQueryPlanDocuments)
    notices.push(`The canvas shows up to ${maxQueryPlanDocuments} plan documents. Choose an XML source to open any retained plan.`)
  let operators = 0, characters = 0
  for (const source of sources.slice(0, maxQueryPlanDocuments)) {
    try {
      signal.throwIfAborted()
      const remaining = planLimits.characters * 2 - characters
      const prepared = prepare ? await prepare(source, signal, remaining) : await (async () => {
        const xml = await source.read(signal)
        signal.throwIfAborted()
        if (xml.length > remaining) throw new PlanInputBudgetError()
        return { document: await parseSourceXml(xml, parse, signal), characters: xml.length }
      })()
      signal.throwIfAborted()
      characters += prepared.characters
      if (characters > planLimits.characters * 2) throw new PlanInputBudgetError()
      const count = prepared.document.statements.reduce((sum, entry) => sum + entry.nodes.length, 0)
      if (operators + count > planLimits.nodes || statements.length + prepared.document.statements.length > planLimits.statements)
        throw new Error('The combined operator or statement limit was exceeded.')
      operators += count
      for (const entry of prepared.document.statements) {
        const prefix = source.key + ':'
        statements.push({ ...entry, sourceKey: source.key, batchLabel: source.batchLabel, batchNumber: source.batchNumber, iteration: source.iteration, id: prefix + entry.id,
          nodes: entry.nodes.map(node => ({ ...node, id: prefix + node.id, parentId: node.parentId ? prefix + node.parentId : null })) })
      }
      for (const notice of prepared.document.notices) if (!notices.includes(notice) && notices.length < 7) notices.push(notice)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof PlanSourceParseError) characters += error.characters
      errors.push(source.label + ': ' + (error instanceof Error ? error.message : 'The plan could not be read.'))
      if (error instanceof PlanInputBudgetError || characters > planLimits.characters * 2) break
    }
  }
  if (errors.length) {
    if (!statements.length) throw new Error(errors[0])
    notices.unshift(`${errors.length} plan ${errors.length === 1 ? 'document could' : 'documents could'} not be displayed. ${errors[0]}${errors.length > 1 ? ' Choose a plan XML source to inspect an individual document.' : ''}`)
  }
  return { statements, notices }
}
