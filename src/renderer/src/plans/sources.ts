import type { ApiResult } from '../../../shared/contracts'
import { maxQueryPlanDocuments, planLimits, type PlanDocument, type PlanStatement } from '../../../shared/plans'

export interface PlanSource { key: string; label: string; read(signal: AbortSignal): Promise<string> }
/** Treat a failed/truncated source separately so an earlier valid plan in the same run remains usable. */
export async function loadPlanSources(sources: readonly PlanSource[], parse: (xml: string) => Promise<ApiResult<PlanDocument>>, signal: AbortSignal): Promise<{ statements: PlanStatement[]; notices: string[] }> {
  const statements: PlanStatement[] = [], notices: string[] = [], errors: string[] = []
  if (sources.length > maxQueryPlanDocuments)
    notices.push(`The canvas shows up to ${maxQueryPlanDocuments} plan documents. Choose an XML source to open any retained plan.`)
  let operators = 0, characters = 0
  for (const [sourceIndex, source] of sources.slice(0, maxQueryPlanDocuments).entries()) {
    try {
      signal.throwIfAborted()
      const xml = await source.read(signal)
      signal.throwIfAborted()
      characters += xml.length
      if (characters > planLimits.characters * 2) throw new Error('The combined input budget was exceeded. Remaining plan documents were not loaded.')
      const result = await parse(xml)
      signal.throwIfAborted()
      if (!result.ok) throw new Error(result.error)
      const count = result.value.statements.reduce((sum, entry) => sum + entry.nodes.length, 0)
      if (operators + count > planLimits.nodes || statements.length + result.value.statements.length > planLimits.statements)
        throw new Error('The combined operator or statement limit was exceeded.')
      operators += count
      for (const entry of result.value.statements) {
        const prefix = sourceIndex + ':'
        statements.push({ ...entry, id: prefix + entry.id, nodes: entry.nodes.map(node => ({ ...node, id: prefix + node.id, parentId: node.parentId ? prefix + node.parentId : null })) })
      }
      for (const notice of result.value.notices) if (!notices.includes(notice) && notices.length < 7) notices.push(notice)
    } catch (error) {
      signal.throwIfAborted()
      errors.push(source.label + ': ' + (error instanceof Error ? error.message : 'The plan could not be read.'))
      if (characters > planLimits.characters * 2) break
    }
  }
  if (errors.length) {
    if (!statements.length) throw new Error(errors[0])
    notices.unshift(`${errors.length} plan ${errors.length === 1 ? 'document could' : 'documents could'} not be displayed. ${errors[0]}${errors.length > 1 ? ' Choose a plan XML source to inspect an individual document.' : ''}`)
  }
  return { statements, notices }
}
