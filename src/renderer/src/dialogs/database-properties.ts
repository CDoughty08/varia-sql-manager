// Database Properties without the DOM: the draft its pages edit, which rows are greyed and why, and the request OK and
// Script send, which carries only what differs from the describe, as SSMS sends only changed values. Node tests run it.
import {
  afterReadOnlyProblem, compatibilityLabel, databaseOptionDefs, optionDef, ownerNotOn, scopedConfigurationDefs, tokenProblem, type DatabaseOptionDef, type OptionCategory, type SystemDatabase
} from '../../../shared/actions/database.ts'
import type { ActionError, DatabaseChanges, DatabasePropertiesModel, PropertiesRequest } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { ident } from '../../../shared/explorer/schema.ts'

/** The dialog's edits: options and scoped configurations as tokens (an integer field keeps what was typed), and the owner. */
export interface DatabaseDraft {
  readonly options: Readonly<Record<string, string>>
  readonly scoped: Readonly<Record<string, string>>
  readonly owner: string
}
export type DatabaseRequest = Omit<PropertiesRequest, 'connectionId' | 'requestId'>

export const greyNotes = {
  sysadmin: 'Only members of sysadmin can change the compatibility level here, as in SSMS.',
  readOnlyDatabase: 'The database is read-only. Set Database Read-Only to False first.',
  filestream: 'FILESTREAM is not enabled on this server.',
  incremental: 'Auto Create Statistics must be True for incremental statistics.',
  containment: 'Partial containment needs the server option contained database authentication.',
  notOn: (database: string) => `SQL Server does not allow this option on ${database}.`,
  owner: (database: string) => `SQL Server does not allow changing the owner of ${database}.`
} as const

export const initialDatabaseDraft = (model: DatabasePropertiesModel): DatabaseDraft => ({ options: { ...model.options }, scoped: { ...model.scoped }, owner: model.general.owner ?? '' })

const systemDatabase = (target: ObjectRef): SystemDatabase | undefined =>
  (['master', 'model', 'msdb', 'tempdb'] as const).find(name => name === target.name)

/** Whether a row shows at all: its version band, a scoped configuration the describe read, and containment's own rows. */
export function optionShown(def: DatabaseOptionDef, model: DatabasePropertiesModel): boolean {
  if (def.since !== undefined && model.server.level < def.since) return false
  if (def.category === 'Database Scoped Configurations') return def.key in model.scoped
  if (def.category === 'Containment') return model.options.containmentType === 'PARTIAL'
  return true
}

/** Whether a row is greyed, and the note that says why (the read-only rows SSMS shows need none). */
export function optionState(def: DatabaseOptionDef, model: DatabasePropertiesModel, draft: DatabaseDraft, target: ObjectRef): { readonly disabled: boolean; readonly note?: string } {
  if (model.readOnlyReason) return { disabled: true, note: model.readOnlyReason }
  if (!def.settable) return { disabled: true }
  const system = systemDatabase(target)
  if (system && def.notOn?.includes(system)) return { disabled: true, note: greyNotes.notOn(system) }
  if (model.options.readOnly === 'true' && def.key !== 'readOnly' && def.key !== 'restrictAccess') return { disabled: true, note: greyNotes.readOnlyDatabase }
  if (def.key === 'compatibilityLevel' && (!model.server.sysadmin || !model.compatibilityLevels.includes(Number(model.options.compatibilityLevel)))) {
    return { disabled: true, ...!model.server.sysadmin ? { note: greyNotes.sysadmin } : {} }
  }
  if (def.key === 'filestreamNonTransactedAccess' && model.server.filestreamLevel === 0) return { disabled: true, note: greyNotes.filestream }
  if (def.key === 'autoCreateIncrementalStatistics' && draft.options.autoCreateStatistics !== 'true') return { disabled: true, note: greyNotes.incremental }
  if (def.key === 'containmentType' && !model.server.containedAuthentication && model.options.containmentType !== 'PARTIAL') return { disabled: true, note: greyNotes.containment }
  return { disabled: false }
}

/** The owner field: greyed for a read-only dialog, for the system databases whose owner SQL Server keeps, and on a
 *  read-only database, where SQL Server refuses ALTER AUTHORIZATION (3906). */
export function ownerState(model: DatabasePropertiesModel, target: ObjectRef): { readonly disabled: boolean; readonly note?: string } {
  if (model.readOnlyReason) return { disabled: true, note: model.readOnlyReason }
  const system = systemDatabase(target)
  if (system && ownerNotOn.includes(system)) return { disabled: true, note: greyNotes.owner(system) }
  return model.options.readOnly === 'true' ? { disabled: true, note: greyNotes.readOnlyDatabase } : { disabled: false }
}

/** A list's choices: an option's own, the server's collations, and the compatibility levels the server offers. */
export function optionChoices(def: DatabaseOptionDef, model: DatabasePropertiesModel): { readonly value: string; readonly label: string }[] {
  if (def.key === 'collation') {
    const current = model.options.collation
    return [...current && !model.collations.includes(current) ? [current] : [], ...model.collations].map(name => ({ value: name, label: name }))
  }
  if (def.key === 'compatibilityLevel') {
    const current = Number(model.options.compatibilityLevel)
    return [...model.compatibilityLevels.includes(current) || !Number.isFinite(current) ? [] : [current], ...model.compatibilityLevels].map(level => ({ value: String(level), label: compatibilityLabel(level) }))
  }
  return (def.choices ?? []).map(choice => ({ value: choice.token, label: choice.label }))
}

/** The rows of the Options page's grid: every shown option but the header's, by category in SSMS's order. */
export function optionGroups(model: DatabasePropertiesModel): { readonly category: OptionCategory; readonly defs: readonly DatabaseOptionDef[] }[] {
  const order: OptionCategory[] = ['Automatic', 'Containment', 'Cursor', 'Database Scoped Configurations', 'FILESTREAM', 'Ledger', 'Miscellaneous', 'Recovery', 'Service Broker', 'State']
  const defs = [...databaseOptionDefs, ...scopedConfigurationDefs].filter(def => def.category !== 'header' && optionShown(def, model))
  return order.map(category => ({ category, defs: defs.filter(def => def.category === category) })).filter(group => group.defs.length > 0)
}

const isScoped = (def: DatabaseOptionDef) => def.category === 'Database Scoped Configurations'
/** The draft's value of an option (scoped configurations live apart). */
export const draftValue = (draft: DatabaseDraft, def: DatabaseOptionDef): string | undefined => (isScoped(def) ? draft.scoped : draft.options)[def.key]
export const modelValue = (model: DatabasePropertiesModel, def: DatabaseOptionDef): string | undefined => (isScoped(def) ? model.scoped : model.options)[def.key]
/** The draft with one option's control text. */
export function setOption(draft: DatabaseDraft, key: string, text: string): DatabaseDraft {
  const def = optionDef(key)
  if (!def) return draft
  return isScoped(def) ? { ...draft, scoped: { ...draft.scoped, [key]: text } } : { ...draft, options: { ...draft.options, [key]: text } }
}

const range = (def: DatabaseOptionDef) => def.range ? `a whole number from ${def.range.min.toLocaleString('en-US')} to ${def.range.max.toLocaleString('en-US')}` : 'one of its values'
const readOnlyOrder = optionDef('readOnly')!.smoOrder
/** Problems OK and Script show instead of sending, by option key ('owner' for the owner). Turning Database Read-Only on
 *  cannot share an OK with a change SQL Server would refuse after it (SSMS would leave the database read-only with
 *  that change failed); DatabaseAlter.Plan refuses the same. */
export function draftErrors(model: DatabasePropertiesModel, draft: DatabaseDraft, target: ObjectRef): Map<string, string> {
  const errors = new Map<string, string>()
  const turningReadOnly = draft.options.readOnly === 'true' && model.options.readOnly !== 'true'
  for (const def of [...databaseOptionDefs, ...scopedConfigurationDefs]) {
    const value = draftValue(draft, def)
    if (value === undefined || value === modelValue(model, def) || optionState(def, model, draft, target).disabled) continue
    if (tokenProblem(def, value.trim() === value ? value : '')) errors.set(def.key, `${def.label} must be ${def.choices && def.range ? def.choices.map(choice => choice.token).join(' or ') + ' or ' : ''}${range(def)}.`)
    else if (turningReadOnly && def.refusedReadOnly && def.smoOrder > readOnlyOrder) errors.set(def.key, afterReadOnlyProblem(def.label))
  }
  if (draft.owner !== (model.general.owner ?? '') && !ownerState(model, target).disabled) {
    if (!ident.safeParse(draft.owner).success) errors.set('owner', 'Owner must be a login name of 1 to 128 characters.')
    else if (turningReadOnly) errors.set('owner', afterReadOnlyProblem('Owner'))
  }
  return errors
}

/** Whether the draft differs from what the describe read: Database Properties as a document is dirty while it does. */
export function databaseChanged(model: DatabasePropertiesModel, draft: DatabaseDraft): boolean {
  if (draft.owner !== (model.general.owner ?? '')) return true
  const differs = (values: Readonly<Record<string, string>>, read: Readonly<Record<string, string>>) => Object.keys(values).some(key => values[key] !== read[key])
  return differs(draft.options, model.options) || differs(draft.scoped, model.scoped)
}

/** OK's and Script's request: only what changed, or undefined when nothing did, or the first problem. */
export function databaseRequest(target: ObjectRef, model: DatabasePropertiesModel, draft: DatabaseDraft): DatabaseRequest | undefined | { readonly problem: string } {
  if (model.readOnlyReason) return undefined
  const [problem] = draftErrors(model, draft, target).values()
  if (problem) return { problem }
  const options: Record<string, string> = {}, scoped: Record<string, string> = {}
  for (const def of [...databaseOptionDefs, ...scopedConfigurationDefs]) {
    const value = draftValue(draft, def)
    if (value === undefined || value === modelValue(model, def) || optionState(def, model, draft, target).disabled) continue
    (isScoped(def) ? scoped : options)[def.key] = value
  }
  const changes: { -readonly [K in keyof DatabaseChanges]: DatabaseChanges[K] } = {}
  if (Object.keys(options).length) changes.options = options
  if (Object.keys(scoped).length) changes.scoped = scoped
  if (draft.owner !== (model.general.owner ?? '') && !ownerState(model, target).disabled) changes.owner = draft.owner
  return Object.keys(changes).length ? { action: 'properties', target, closeConnections: false, changes } : undefined
}

/** The model after OK failed: when other connections were in the way (IN_USE), the session count the dialog opened with
 *  is stale, so it becomes unknown and the next OK asks Open Connections, as SSMS counts them when OK is pressed. */
export function afterDatabaseFailure(model: DatabasePropertiesModel, failure: ActionError): DatabasePropertiesModel {
  if (failure.code !== 'IN_USE' || model.sessions === undefined) return model
  const { sessions: _stale, ...rest } = model
  return rest
}

/** SSMS's Open Connections prompt: OK changes an option it closes other connections for, and the database has sessions (or they cannot be counted). */
export function databaseConfirm(model: DatabasePropertiesModel, request: DatabaseRequest): 'openConnections' | undefined {
  const exclusive = Object.keys(request.changes.options ?? {}).some(key => optionDef(key)?.exclusive)
  return exclusive && (model.sessions === undefined || model.sessions > 0) ? 'openConnections' : undefined
}
