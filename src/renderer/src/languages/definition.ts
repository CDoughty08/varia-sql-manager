import { bigQueryPath } from '../../../shared/bigquery/names.ts'
import { bigQueryMaxDefinition, isBigQueryPropertyKind } from '../../../shared/bigquery/objects.ts'
import { kindSpecs, type NodeKind } from '../../../shared/explorer/catalog.ts'
import { displayText, type NodeSubtype } from '../../../shared/explorer/refs.ts'
import type { ExplorerMenuNode } from '../menus/targets'
import type { FoundIndexObject } from './IndexCompletionService'
import type { FoundDefinition } from './SqlLanguageService'

/** Why Go to Definition cannot ask at all (`SqlLanguageService.definition` throws them); shown as they are. */
export const definitionErrors = {
  connectFirst: 'Connect this query to a SQL Server first.',
  connectBigQueryFirst: 'Connect this query to BigQuery first.',
  indexUnavailable: 'The Search Objects index could not answer just now. Try again in a moment.',
  tooLarge: 'This query is too large to look up a definition in.'
} as const
const ownErrors: readonly string[] = Object.values(definitionErrors)

/** Go to Definition's status-bar words: every outcome but a script or a Peek tab is one of these, never an error banner. */
export const definitionMessages = {
  unavailable: 'Put the caret on an object name in a SQL editor.',
  notFound: (word?: string) => word ? `No definition found for ${word}.` : 'No definition found at the caret.',
  notScriptable: (label: string) => `${label} cannot be scripted.`,
  notPeekable: (label: string) => `Peek cannot open ${label}.`,
  /** F12 on a BigQuery object with no free definition: reading its CREATE statement would be a billed query. */
  noFreeDefinition: (label: string) => `${label} has no definition to open without a billed query. Peek Definition shows its properties.`,
  /** F12 on a BigQuery view or routine whose metadata holds no SQL (a remote function, say). */
  noStoredDefinition: (label: string) => `${label} has no stored SQL definition.`,
  definitionCut: (label: string) => `The definition of ${label} is longer than Varia reads; the new query holds its first ${bigQueryMaxDefinition.toLocaleString('en-US')} characters.`,
  failed: (detail?: string) => detail && ownErrors.includes(detail) ? detail : detail ? `Could not find the definition: ${detail}` : 'Could not find the definition.'
} as const

/** `schema.name`, with hidden characters made visible, as Script As's status lines name an object. */
export const definitionLabel = (found: FoundDefinition): string => displayText(`${found.definition.schema}.${found.definition.name}`)

/**
 * The object as an Object Explorer node, which Script As and Peek take: its connection, kind, subtype and names. It has no tree
 * row (`id` -1), so it is never the selection and never anchors Peek's card.
 */
export function definitionNode(found: FoundDefinition): ExplorerMenuNode {
  const { database, schema, name, kind, subtype } = found.definition
  // Only a subtype the kind has: a newer backend's unknown one leaves the node without, as the tree would show it.
  const known = subtype !== undefined && (kindSpecs[kind].subtypes as readonly string[] | undefined)?.includes(subtype)
  return {
    id: -1, connectionId: found.connectionId, lost: false, kind, ...known ? { subtype: subtype as NodeSubtype } : {},
    ref: { type: 'object', object: { kind, database, schema, name } }, label: `${schema}.${name}`
  }
}

/** The BigQuery kinds whose definition `tables.get` or `routines.get` returns free; Peek opens them on their Definition tab. */
export const bigQueryDefinitionKinds: ReadonlySet<string> = new Set(['bqView', 'bqMaterializedView', 'bqRoutine'])

/** `project.dataset.name` in backticks, as BigQuery's status lines name an object, with hidden characters made visible. */
export const indexObjectLabel = (found: FoundIndexObject): string => displayText(bigQueryPath(found.project, found.dataset, found.name))

/**
 * A BigQuery object Go To Definition found, as the Object Explorer node Peek takes, or undefined for a kind Peek cannot show (a
 * model). Like `definitionNode`'s, it has no tree row.
 */
export function indexObjectNode(found: FoundIndexObject): ExplorerMenuNode | undefined {
  const { kind, project, dataset, name, subtype } = found
  if (!isBigQueryPropertyKind(kind) || kind === 'bqDataset') return undefined
  const known = subtype !== undefined && (kindSpecs[kind as NodeKind].subtypes as readonly string[] | undefined)?.includes(subtype)
  return {
    id: -1, connectionId: found.connectionId, lost: false, kind, ...known ? { subtype: subtype as NodeSubtype } : {},
    ref: { type: 'object', object: { kind, project, dataset, name } }, label: name
  }
}
