// Table Properties' draft, without the DOM: what the person changed, its problems, the request Apply and Script send, and whether
// Apply asks first. Node tests run it; TableProperties.tsx renders what it decides.
import { actionLimits, type PageId } from '../../../shared/actions/catalog.ts'
import type { ActionPromptRequest } from '../../../shared/actions/prompts.ts'
import type { DatabaseIdentity } from '../../../shared/actions/schema.ts'
import { lockEscalationTokens, tableLimits, tableMessages, tableStatements, type ExtendedPropertyChange, type LockEscalation, type TableChanges, type TablePropertiesModel } from '../../../shared/actions/tables.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'

/** One extended property row: what it was read as (none for a new row), what it says now, and whether it is to be removed. */
export interface ExtendedPropertyRow {
  /** Stable for the row's life, so React and the field ids keep it while its name changes. */
  readonly key: string
  readonly name: string
  readonly value: string
  readonly origin?: { readonly name: string; readonly value: string; readonly type?: string }
  readonly removed?: boolean
}
export interface TableDraft {
  readonly lockEscalation: string
  readonly changeTracking: boolean
  readonly trackColumnsUpdated: boolean
  readonly extendedProperties: readonly ExtendedPropertyRow[]
}
export interface TableRequest { readonly action: 'tableProperties'; readonly target: ObjectRef; readonly tableChanges: TableChanges; readonly identity: DatabaseIdentity }

export const tableNotes = {
  emptyName: 'Enter a name.',
  longName: 'A name has at most 128 characters.',
  longValue: `A value has at most ${tableLimits.extendedPropertyValue.toLocaleString('en-US')} characters.`,
  nul: 'The text cannot contain a NUL character.',
  tooMany: `Apply at most ${actionLimits.statements} changes at once.`,
  tooManyProperties: `Change at most ${tableLimits.extendedPropertyChanges} extended properties at once.`,
  databaseTracking: 'Change tracking is off for the database. Turn it on in Database Properties first.',
  primaryKey: tableMessages.primaryKey,
  memoryOptimized: tableMessages.memoryOptimized,
  trackingMemoryOptimized: tableMessages.trackingMemoryOptimized,
  truncated: 'The table has more extended properties than are listed, so they are read-only here. Change them in a query window.',
  nonString: tableMessages.nonStringValue
} as const

export function initialTableDraft(model: TablePropertiesModel): TableDraft {
  return {
    lockEscalation: model.general.lockEscalation, changeTracking: model.changeTracking.enabled, trackColumnsUpdated: model.changeTracking.trackColumnsUpdated,
    extendedProperties: model.extendedProperties.map((property, index) => ({ key: `read-${index}`, name: property.name, value: property.value, origin: { ...property } }))
  }
}

/** The extended property changes: the properties the draft keeps by name against those read, dropped, changed and added. */
function propertyChanges(draft: TableDraft): ExtendedPropertyChange[] {
  const read = new Map<string, string>(), kept = new Map<string, string>()
  for (const row of draft.extendedProperties) if (row.origin) read.set(row.origin.name, row.origin.value)
  for (const row of draft.extendedProperties) if (!row.removed) kept.set(row.name, row.value)
  const changes: ExtendedPropertyChange[] = []
  for (const name of read.keys()) if (!kept.has(name)) changes.push({ op: 'drop', name })
  for (const [name, value] of kept) {
    const before = read.get(name)
    if (before === undefined) changes.push({ op: 'add', name, value })
    else if (before !== value) changes.push({ op: 'update', name, value })
  }
  return changes
}

/** What Apply changes: only what differs from the describe. */
export function tableChanges(model: TablePropertiesModel, draft: TableDraft): TableChanges {
  const tracking = model.changeTracking
  const changeTracking = draft.changeTracking !== tracking.enabled ? { enabled: draft.changeTracking, ...draft.changeTracking ? { trackColumnsUpdated: draft.trackColumnsUpdated } : {} }
    : draft.changeTracking && draft.trackColumnsUpdated !== tracking.trackColumnsUpdated ? { enabled: true, trackColumnsUpdated: draft.trackColumnsUpdated } : undefined
  const lockEscalation = draft.lockEscalation !== model.general.lockEscalation && (lockEscalationTokens as readonly string[]).includes(draft.lockEscalation) ? draft.lockEscalation as LockEscalation : undefined
  const extendedProperties = propertyChanges(draft)
  return { ...lockEscalation ? { lockEscalation } : {}, ...changeTracking ? { changeTracking } : {}, ...extendedProperties.length ? { extendedProperties } : {} }
}
export const tableChanged = (model: TablePropertiesModel, draft: TableDraft): boolean => tableStatements(tableChanges(model, draft)) > 0

/** A field's error key: an extended property row's name or value, or a page-wide problem. */
export const propertyKey = (row: ExtendedPropertyRow, field: 'name' | 'value') => `extendedProperties.${row.key}.${field}`

/** The draft's problems by field key, each on the page that shows it. */
export function tableErrors(model: TablePropertiesModel, draft: TableDraft): Map<string, string> {
  const errors = new Map<string, string>()
  const live = draft.extendedProperties.filter(row => !row.removed)
  // SQL Server compares the names under the database's collation, by default case-insensitive and blind to trailing spaces.
  const nameKey = (name: string) => name.trimEnd().toLowerCase()
  const counts = new Map<string, number>()
  for (const row of live) counts.set(nameKey(row.name), (counts.get(nameKey(row.name)) ?? 0) + 1)
  for (const row of live) {
    const name = propertyKey(row, 'name'), value = propertyKey(row, 'value')
    if (row.name.length === 0) errors.set(name, tableNotes.emptyName)
    else if (row.name.length > 128) errors.set(name, tableNotes.longName)
    else if (row.name.includes('\0')) errors.set(name, tableNotes.nul)
    else if ((counts.get(nameKey(row.name)) ?? 0) > 1) errors.set(name, tableMessages.duplicateName)
    if (row.value.length > tableLimits.extendedPropertyValue) errors.set(value, tableNotes.longValue)
    else if (row.value.includes('\0')) errors.set(value, tableNotes.nul)
  }
  const changes = tableChanges(model, draft)
  if ((changes.extendedProperties?.length ?? 0) > tableLimits.extendedPropertyChanges) errors.set('extendedProperties', tableNotes.tooManyProperties)
  else if (tableStatements(changes) > actionLimits.statements) errors.set('extendedProperties', tableNotes.tooMany)
  if (changes.extendedProperties?.length && model.extendedPropertiesTruncated) errors.set('extendedProperties', tableNotes.truncated)
  if (changes.changeTracking && model.general.memoryOptimized) errors.set('changeTracking', tableNotes.trackingMemoryOptimized)
  else if (changes.changeTracking?.enabled && !model.changeTracking.enabled) {
    if (!model.changeTracking.databaseEnabled) errors.set('changeTracking', tableNotes.databaseTracking)
    else if (!model.changeTracking.primaryKey) errors.set('changeTracking', tableNotes.primaryKey)
  }
  return errors
}
/** The page a field's problem marks in the section list. */
export const tableProblemSection = (key: string): PageId => key.startsWith('extendedProperties') ? 'extendedProperties' : key === 'changeTracking' ? 'changeTracking' : 'general'
export const tableProblemSections = (errors: ReadonlyMap<string, string>): ReadonlySet<PageId> => new Set([...errors.keys()].map(tableProblemSection))

/** Apply's and Script's request; undefined with nothing to change; a problem while the draft has one. */
export function tableRequest(target: ObjectRef, model: TablePropertiesModel, draft: TableDraft): TableRequest | undefined | { readonly problem: string } {
  const errors = tableErrors(model, draft)
  const first = errors.values().next()
  if (!first.done) return { problem: first.value }
  const changes = tableChanges(model, draft)
  if (tableStatements(changes) === 0) return undefined
  return { action: 'tableProperties', target, tableChanges: changes, identity: { id: model.general.id, created: model.general.created } }
}

/** The question Apply asks first: turning change tracking off, or changing Track columns updated (off and on again), discards what it tracked. */
export function tableConfirmation(model: TablePropertiesModel, request: TableRequest): ActionPromptRequest | undefined {
  const tracking = request.tableChanges.changeTracking
  if (!tracking || !model.changeTracking.enabled) return undefined
  const facts = { schema: model.general.schema, table: model.general.name }
  if (!tracking.enabled) return { prompt: 'disableChangeTracking', facts: { ...facts, reenable: false } }
  return tracking.trackColumnsUpdated !== undefined && tracking.trackColumnsUpdated !== model.changeTracking.trackColumnsUpdated ? { prompt: 'disableChangeTracking', facts: { ...facts, reenable: true } } : undefined
}

/** Whether a row's name and value take edits: a value that is not text stays as it is (it can still be removed). */
export const rowEditable = (row: ExtendedPropertyRow): boolean => !row.origin?.type

/** The draft with a new, empty extended property row. */
export function addPropertyRow(draft: TableDraft, key: string): TableDraft {
  return { ...draft, extendedProperties: [...draft.extendedProperties, { key, name: '', value: '' }] }
}
/** The draft with a row changed: a new row that is removed goes; a read one is marked, and can be restored. */
export function patchPropertyRow(draft: TableDraft, key: string, patch: Partial<Pick<ExtendedPropertyRow, 'name' | 'value' | 'removed'>>): TableDraft {
  const rows = draft.extendedProperties.flatMap(row => {
    if (row.key !== key) return [row]
    if (patch.removed && !row.origin) return []
    if (!rowEditable(row) && (patch.name !== undefined || patch.value !== undefined)) return [row]
    return [{ ...row, ...patch }]
  })
  return { ...draft, extendedProperties: rows }
}
