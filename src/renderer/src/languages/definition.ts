import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText, type NodeSubtype } from '../../../shared/explorer/refs.ts'
import type { ExplorerMenuNode } from '../menus/targets'
import type { FoundDefinition } from './SqlLanguageService'

/** Go to Definition's status-bar words: every outcome but a script or a Peek tab is one of these, never an error banner. */
export const definitionMessages = {
  unavailable: 'Put the caret on an object name in a SQL editor.',
  notFound: (word?: string) => word ? `No definition found for ${word}.` : 'No definition found at the caret.',
  notScriptable: (label: string) => `${label} cannot be scripted.`,
  notPeekable: (label: string) => `Peek cannot open ${label}.`,
  failed: (detail?: string) => detail ? `Could not find the definition: ${detail}` : 'Could not find the definition.'
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
