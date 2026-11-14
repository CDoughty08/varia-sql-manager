// Table Properties' draft, without the DOM: what the person changed, its problems, the request Apply and Script send, and whether
// Apply asks first. Node tests run it; TableProperties.tsx renders what it decides.
import { actionLimits, type PageId } from '../../../shared/actions/catalog.ts'
import type { ActionPromptRequest } from '../../../shared/actions/prompts.ts'
import type { DatabaseIdentity } from '../../../shared/actions/schema.ts'
import { lockEscalationTokens, tableLimits, tableMessages, tableStatements, type ExtendedPropertyChange, type LockEscalation, type TableChanges, type TablePropertiesModel } from '../../../shared/actions/tables.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { wellFormed } from '../../../shared/ssis/schema.ts'

/** One extended property row: what it was read as (none for a new row), what it says now, and whether it is to be removed. */
export interface ExtendedPropertyRow {
  /** Stable for the row's life, so React and the field ids keep it while its name changes. */
  readonly key: string
  readonly name: string
  readonly value: string
  readonly origin?: { readonly name: string; readonly value: string; readonly type?: string; readonly truncated?: boolean }
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
  broken: 'The text holds a broken character (half of a surrogate pair).',
  tooLong: 'This value is longer than Varia changes; it can only be removed here.',
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
  const read = new Map<string, NonNullable<ExtendedPropertyRow['origin']>>(), kept = new Map<string, ExtendedPropertyRow>()
  for (const row of draft.extendedProperties) if (row.origin) read.set(row.origin.name, row.origin)
  for (const row of draft.extendedProperties) if (!row.removed) kept.set(row.name, row)
  const changes: ExtendedPropertyChange[] = []
  for (const name of read.keys()) if (!kept.has(name)) changes.push({ op: 'drop', name })
  for (const [name, row] of kept) {
    const before = read.get(name)
    if (before === undefined) changes.push({ op: 'add', name, value: row.value })
    // A value that is not text (or was read cut short), replaced by another row of that name, becomes that row's text even when it reads the same.
    else if (before.value !== row.value || ((before.type || before.truncated) && row.origin !== before)) changes.push({ op: 'update', name, value: row.value })
  }
  return changes
}
/** Whether a row writes anything: a new row, or a read one renamed or given another value. Only these are checked, so a value
 *  SQL Server already holds (longer than Varia writes, with a NUL, or a name another differs from only by case) never blocks Apply. */
const writes = (row: ExtendedPropertyRow): boolean => !row.origin || row.name !== row.origin.name || row.value !== row.origin.value

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
  // A row that writes may not take a name another row has under that comparison; rows read as they are may (a case-sensitive database).
  for (const row of live.filter(writes)) {
    const name = propertyKey(row, 'name'), value = propertyKey(row, 'value')
    if (row.name.length === 0) errors.set(name, tableNotes.emptyName)
    else if (row.name.length > 128) errors.set(name, tableNotes.longName)
    else if (row.name.includes('\0')) errors.set(name, tableNotes.nul)
    else if (!wellFormed(row.name)) errors.set(name, tableNotes.broken)
    else if (live.some(other => other !== row && nameKey(other.name) === nameKey(row.name))) errors.set(name, tableMessages.duplicateName)
    if (row.value.length > tableLimits.extendedPropertyValue) errors.set(value, tableNotes.longValue)
    else if (row.value.includes('\0')) errors.set(value, tableNotes.nul)
    else if (!wellFormed(row.value)) errors.set(value, tableNotes.broken)
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
export const rowEditable = (row: ExtendedPropertyRow): boolean => !row.origin?.type && !row.origin?.truncated && (row.origin?.value.length ?? 0) <= tableLimits.extendedPropertyValue

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
