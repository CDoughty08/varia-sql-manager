import { afterEach, describe, expect, it } from 'vitest'
import { actionRequestSchema, type ActionDescribeResult, type ActionExecuteResult, type ActionRequest, type ActionScriptResult } from '../src/shared/actions/schema'
import { actionPromptBox, actionPromptRequestSchema } from '../src/shared/actions/prompts'
import { tableLimits, tableMessages, type TablePropertiesModel } from '../src/shared/actions/tables'
import { actionMenuState, dialogSpecs } from '../src/shared/actions/catalog'
import type { ApiResult } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { addPropertyRow, initialTableDraft, patchPropertyRow, propertyKey, rowEditable, tableChanged, tableChanges, tableConfirmation, tableErrors, tableNotes, tableRequest, type TableDraft, type TableRequest } from '../src/renderer/src/dialogs/table-properties'
import { setScriptOpen } from '../src/renderer/src/kit/document-frame'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { generalFacts, storageFacts, tablePages, versioningFacts } from '../src/renderer/src/properties/table-fields'
import { previewDelayMs } from '../src/renderer/src/properties/DatabasePropertiesService'
import { tablePropertiesMessages } from '../src/renderer/src/properties/TablePropertiesService'
import { connectionInfo, manualTimers, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

const orders: ObjectRef = { kind: 'table', database: 'AppData', schema: 'Sales', name: 'Orders' }
export function tableModel(patch: Partial<TablePropertiesModel> = {}): TablePropertiesModel {
  return {
    general: { name: 'Orders', schema: 'Sales', created: '2026-01-01T00:00:00.000', systemObject: false, ansiNulls: true, replicated: false, lockEscalation: 'TABLE', memoryOptimized: false, fileTable: false, external: false, id: 901 },
    storage: { rowCount: 1200, dataSpaceKb: 72, indexSpaceKb: 16, compression: 'PAGE', filegroup: 'PRIMARY', partitioned: false, partitions: [{ number: 1, rows: 1200, compression: 'PAGE', filegroup: 'PRIMARY' }], partitionsTruncated: false },
    changeTracking: { databaseEnabled: true, enabled: false, trackColumnsUpdated: false, primaryKey: true },
    permissions: [{ principal: 'app', principalType: 'SQL_USER', permission: 'SELECT', state: 'GRANT', grantor: 'dbo' }], permissionsTruncated: false,
    securityPredicates: [], securityPredicatesTruncated: false,
    extendedProperties: [{ name: 'MS_Description', value: 'Customer orders' }, { name: 'Version', value: '0x01', type: 'varbinary' }], extendedPropertiesTruncated: false,
    level: 16, ...patch
  }
}
const node = (object: ObjectRef = orders, connectionId = 'c1', id = 40): ExplorerMenuNode => ({ id, connectionId, ref: { type: 'object', object }, kind: 'table', label: `${object.schema}.${object.name}`, lost: false })
const request = (model: TablePropertiesModel, draft: TableDraft) => tableRequest(orders, model, draft) as TableRequest

describe('Table Properties draft', () => {
  it('changes only what differs, and each extended property once by name', () => {
    const model = tableModel(), start = initialTableDraft(model)
    expect(tableChanged(model, start)).toBe(false)
    expect(tableRequest(orders, model, start)).toBeUndefined()
    let draft: TableDraft = { ...start, lockEscalation: 'AUTO', changeTracking: true, trackColumnsUpdated: true }
    draft = patchPropertyRow(draft, 'read-0', { value: 'All orders' })
    draft = patchPropertyRow(addPropertyRow(draft, 'new-1'), 'new-1', { name: 'Owner', value: 'Sales' })
    expect(tableChanges(model, draft)).toEqual({ lockEscalation: 'AUTO', changeTracking: { enabled: true, trackColumnsUpdated: true }, extendedProperties: [{ op: 'update', name: 'MS_Description', value: 'All orders' }, { op: 'add', name: 'Owner', value: 'Sales' }] })
    const built = request(model, draft)
    expect(built).toEqual({ action: 'tableProperties', target: orders, tableChanges: expect.any(Object), identity: { id: 901, created: '2026-01-01T00:00:00.000' } })
    // zod accepts what the draft sends.
    expect(actionRequestSchema.safeParse({ ...built, connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }).success).toBe(true)
    // A rename drops the old name and adds the new; removing a property and adding one of its name changes it in place.
    const renamed = patchPropertyRow(start, 'read-0', { name: 'Description' })
    expect(tableChanges(model, renamed).extendedProperties).toEqual([{ op: 'drop', name: 'MS_Description' }, { op: 'add', name: 'Description', value: 'Customer orders' }])
    const replaced = patchPropertyRow(patchPropertyRow(addPropertyRow(patchPropertyRow(start, 'read-0', { removed: true }), 'new-2'), 'new-2', { name: 'MS_Description' }), 'new-2', { value: 'x' })
    expect(tableChanges(model, replaced).extendedProperties).toEqual([{ op: 'update', name: 'MS_Description', value: 'x' }])
    // A value that is not text cannot be edited, only removed; a removed new row goes.
    expect(patchPropertyRow(start, 'read-1', { value: 'y' })).toEqual(start)
    expect(tableChanges(model, patchPropertyRow(start, 'read-1', { removed: true })).extendedProperties).toEqual([{ op: 'drop', name: 'Version' }])
    expect(patchPropertyRow(addPropertyRow(start, 'new-3'), 'new-3', { removed: true })).toEqual(start)
  })
  it('diffs renames, swaps and replacements by name, and turns a non-text value replaced by a row of its name into text', () => {
    const model = tableModel({ extendedProperties: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }, { name: 'Version', value: '0x01', type: 'varbinary' }] }), start = initialTableDraft(model)
    // A case-only rename drops the old name first, then adds the new (the backend orders drops before adds).
    expect(tableChanges(model, patchPropertyRow(start, 'read-0', { name: 'a' })).extendedProperties).toEqual([{ op: 'drop', name: 'A' }, { op: 'add', name: 'a', value: '1' }])
    // Swapping two names changes both values in place.
    const swapped = patchPropertyRow(patchPropertyRow(start, 'read-0', { name: 'B' }), 'read-1', { name: 'A' })
    expect(tableChanges(model, swapped).extendedProperties).toEqual([{ op: 'update', name: 'B', value: '1' }, { op: 'update', name: 'A', value: '2' }])
    expect(tableErrors(model, swapped).size).toBe(0)
    // Removing a text property and adding it back as it was sends nothing.
    const back = patchPropertyRow(patchPropertyRow(addPropertyRow(patchPropertyRow(start, 'read-0', { removed: true }), 'n'), 'n', { name: 'A' }), 'n', { value: '1' })
    expect(tableChanged(model, back)).toBe(false)
    // Removing a non-text property and adding text of its name writes that text, even when it reads the same as the hex shown.
    const retyped = patchPropertyRow(patchPropertyRow(addPropertyRow(patchPropertyRow(start, 'read-2', { removed: true }), 'v'), 'v', { name: 'Version' }), 'v', { value: '0x01' })
    expect(tableChanges(model, retyped).extendedProperties).toEqual([{ op: 'update', name: 'Version', value: '0x01' }])
  })
  it('checks only the rows that write: what SQL Server already holds never blocks Apply', () => {
    // A varchar longer than Varia writes, one read cut short, a NUL, and two names that differ only by case (a case-sensitive database).
    const long = 'x'.repeat(tableLimits.extendedPropertyValue + 10)
    const model = tableModel({ extendedProperties: [{ name: 'Desc', value: long }, { name: 'desc', value: 'a\0b' }, { name: 'Cut', value: 'y'.repeat(4000), truncated: true }] }), start = initialTableDraft(model)
    expect(tableErrors(model, start).size).toBe(0)
    expect(request(model, { ...start, lockEscalation: 'AUTO' }).tableChanges).toEqual({ lockEscalation: 'AUTO' })
    // The long and the cut values can only be removed; the others still take edits, which are checked.
    const [desc, lower, cut] = start.extendedProperties
    expect([rowEditable(desc!), rowEditable(lower!), rowEditable(cut!)]).toEqual([false, true, false])
    expect(tableChanges(model, patchPropertyRow(start, 'read-2', { removed: true })).extendedProperties).toEqual([{ op: 'drop', name: 'Cut' }])
    const edited = patchPropertyRow(start, 'read-1', { value: 'still\0bad' })
    expect(tableErrors(model, edited).get(propertyKey(edited.extendedProperties[1]!, 'value'))).toBe(tableNotes.nul)
    // A name that writes may not take another's under the default collation (case and trailing spaces), and a broken character is refused.
    const clash = patchPropertyRow(patchPropertyRow(addPropertyRow(start, 'n'), 'n', { name: 'DESC ' }), 'n', { value: '\ud800' })
    const errors = tableErrors(model, clash), row = clash.extendedProperties[3]!
    expect([errors.get(propertyKey(row, 'name')), errors.get(propertyKey(row, 'value'))]).toEqual([tableMessages.duplicateName, tableNotes.broken])
    expect(errors.get(propertyKey(clash.extendedProperties[0]!, 'name'))).toBeUndefined()
  })
  it('turns change tracking off and on again only to change Track columns updated, and asks first when it discards what was tracked', () => {
    const tracked = tableModel({ changeTracking: { databaseEnabled: true, enabled: true, trackColumnsUpdated: false, primaryKey: true } }), start = initialTableDraft(tracked)
    expect(tableChanges(tracked, { ...start, trackColumnsUpdated: true })).toEqual({ changeTracking: { enabled: true, trackColumnsUpdated: true } })
    expect(tableChanges(tracked, { ...start, changeTracking: false, trackColumnsUpdated: true })).toEqual({ changeTracking: { enabled: false } })
    const off = tableConfirmation(tracked, request(tracked, { ...start, changeTracking: false }))
    expect(off).toEqual({ prompt: 'disableChangeTracking', facts: { schema: 'Sales', table: 'Orders', reenable: false } })
    expect(tableConfirmation(tracked, request(tracked, { ...start, trackColumnsUpdated: true }))).toEqual({ prompt: 'disableChangeTracking', facts: { schema: 'Sales', table: 'Orders', reenable: true } })
    expect(tableConfirmation(tracked, request(tracked, { ...start, lockEscalation: 'DISABLE' }))).toBeUndefined()
    const untracked = tableModel()
    expect(tableConfirmation(untracked, request(untracked, { ...initialTableDraft(untracked), changeTracking: true }))).toBeUndefined()
    // main's message box: Cancel is the default, the question names the table.
    expect(actionPromptRequestSchema.safeParse(off).success).toBe(true)
    const box = actionPromptBox(off!)
    expect(box).toMatchObject({ title: 'Change Tracking', buttons: ['Turn Off', 'Cancel'], answers: ['apply', 'cancel'] })
    expect(box.defaultId).toBe(box.cancelId)
    expect(box.message).toContain('Sales.Orders')
  })
  it('says what is wrong, field by field, and sends nothing while anything is', () => {
    const model = tableModel(), start = initialTableDraft(model)
    const draft = patchPropertyRow(patchPropertyRow(addPropertyRow(addPropertyRow(start, 'a'), 'b'), 'a', { name: 'MS_Description' }), 'b', { value: 'x'.repeat(tableLimits.extendedPropertyValue + 1) })
    const rows = draft.extendedProperties
    const errors = tableErrors(model, draft)
    expect(errors.get(propertyKey(rows[2]!, 'name'))).toBe(tableMessages.duplicateName)
    expect(errors.get(propertyKey(rows[3]!, 'name'))).toBe(tableNotes.emptyName)
    expect(errors.get(propertyKey(rows[3]!, 'value'))).toBe(tableNotes.longValue)
    expect(tableRequest(orders, model, draft)).toEqual({ problem: tableMessages.duplicateName })
    const noDatabase = tableModel({ changeTracking: { databaseEnabled: false, enabled: false, trackColumnsUpdated: false, primaryKey: true } })
    expect(tableErrors(noDatabase, { ...initialTableDraft(noDatabase), changeTracking: true }).get('changeTracking')).toBe(tableNotes.databaseTracking)
    const noKey = tableModel({ changeTracking: { databaseEnabled: true, enabled: false, trackColumnsUpdated: false, primaryKey: false } })
    expect(tableErrors(noKey, { ...initialTableDraft(noKey), changeTracking: true }).get('changeTracking')).toBe(tableNotes.primaryKey)
    // SQL Server compares the names under the collation: a case or trailing-space variant is the same property.
    const variant = patchPropertyRow(addPropertyRow(start, 'v'), 'v', { name: 'ms_description ', value: 'x' })
    expect(tableErrors(model, variant).get(propertyKey(variant.extendedProperties[2]!, 'name'))).toBe(tableMessages.duplicateName)
    // A memory-optimized table has no change tracking.
    const memory = tableModel({ general: { ...model.general, memoryOptimized: true } })
    expect(tableErrors(memory, { ...initialTableDraft(memory), changeTracking: true }).get('changeTracking')).toBe(tableNotes.trackingMemoryOptimized)
    // A truncated list cannot be diffed safely: its changes are refused.
    const truncated = tableModel({ extendedPropertiesTruncated: true })
    const added = patchPropertyRow(addPropertyRow(initialTableDraft(truncated), 'n'), 'n', { name: 'Owner', value: 'x' })
    expect(tableRequest(orders, truncated, added)).toEqual({ problem: tableNotes.truncated })
  })
  it('lists the facts SSMS shows, temporal and ledger ones when the table is either, and Security Predicates only when a policy names it', () => {
    const model = tableModel({ temporal: { type: 'SYSTEM_VERSIONED_TEMPORAL_TABLE', other: 'Sales.OrdersHistory', periodStart: 'ValidFrom', periodEnd: 'ValidTo', retention: '6 MONTHS' } })
    expect(generalFacts(model).description.map(fact => fact.label)).toEqual(['Name', 'Schema', 'Created date', 'System object'])
    expect(versioningFacts(model).temporal).toContainEqual({ label: 'History table', value: 'Sales.OrdersHistory' })
    expect(versioningFacts(model).ledger).toBeUndefined()
    expect(storageFacts(model).compression).toEqual([{ label: 'Data compression', value: 'Page' }])
    const pages = dialogSpecs.tableProperties.pages
    expect(tablePages(pages, model).map(page => page.id)).not.toContain('securityPredicates')
    expect(tablePages(pages, undefined)).toHaveLength(pages.length)
    expect(tablePages(pages, tableModel({ securityPredicates: [{ policy: 'Security.OrdersPolicy', type: 'FILTER', predicate: '([Security].[fn]([Region]))', enabled: true }] })).map(page => page.id)).toContain('securityPredicates')
  })
  it('opens on every table, as Object Explorer and Peek offer Properties there', () => {
    expect(actionMenuState({ kind: 'table' }).properties).toBe('enabled')
    expect(actionMenuState({ kind: 'table', subtype: 'system' }).properties).toBe('enabled')
  })
})

/** A workbench whose describe answers Table Properties' model, on manual timers so the Script preview's delay is the test's. */
function opened(model = tableModel()) {
  const clock = manualTimers()
  const fixture = workbenchFixture({ timers: clock.timers })
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo('c1'))
  let current = model
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'tableProperties' ? { tableProperties: current, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.scriptObjectAction.mockImplementation(async params => ({ ok: true, value: { text: `ALTER TABLE -- ${JSON.stringify(params.action === 'tableProperties' ? params.tableChanges : {})}`, database: 'AppData', warnings: [] } as ActionScriptResult }))
  const { tableProperties, documents } = fixture
  const id = tableProperties.open(node())
  const state = () => tableProperties.get(id)!
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, tableProperties, documents, id, state, executes, clock, setModel: (next: TablePropertiesModel) => { current = next } }
}
const done: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done', title: 'Set lock escalation' }], messages: [], elapsedMs: 1 } }

describe('Table Properties as a document', () => {
  it('opens a tab at once, reads the table, and brings an open one forward', async () => {
    const { tableProperties, documents, id, state, api } = opened()
    expect(documents.active).toMatchObject({ id, kind: 'tableProperties', name: 'Table Properties - Sales.Orders', dirty: false, connectionId: 'c1', database: 'AppData' })
    expect(state().phase).toBe('loading')
    await settled()
    expect(api.describeObject.mock.calls).toEqual([[expect.objectContaining({ dialog: 'tableProperties', target: orders })]])
    expect(state()).toMatchObject({ phase: 'ready', changed: false, draft: { lockEscalation: 'TABLE', changeTracking: false } })
    documents.newQuery()
    expect(tableProperties.open(node())).toBe(id)
    expect(api.describeObject).toHaveBeenCalledTimes(1)
  })
  it('is dirty while the draft differs, previews the script, applies only the changes and reads the table again', async () => {
    const { tableProperties, documents, id, state, executes, api, clock, setModel } = opened()
    await settled()
    tableProperties.updateDraft(id, { lockEscalation: 'DISABLE' })
    expect(documents.get(id)?.dirty).toBe(true)
    expect(tableProperties.canRefresh(id)).toBe(false)
    tableProperties.setFrame(id, setScriptOpen(state().frame, true))
    clock.advance(previewDelayMs)
    await settled()
    expect(state().script).toEqual({ state: 'ready', text: 'ALTER TABLE -- {"lockEscalation":"DISABLE"}' })
    expect(api.scriptObjectAction.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'tableProperties', target: orders, tableChanges: { lockEscalation: 'DISABLE' }, identity: { id: 901 } })
    api.executeObjectAction.mockResolvedValueOnce(done)
    setModel(tableModel({ general: { ...tableModel().general, lockEscalation: 'DISABLE' } }))
    expect(await tableProperties.apply(id)).toBe(true)
    expect(executes()).toEqual([{ action: 'tableProperties', target: orders, tableChanges: { lockEscalation: 'DISABLE' }, identity: { id: 901, created: '2026-01-01T00:00:00.000' }, connectionId: 'c1', requestId: expect.any(String) }])
    expect(api.describeObject).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ phase: 'ready', changed: false, notice: tablePropertiesMessages.applied, draft: { lockEscalation: 'DISABLE' } })
    expect(documents.get(id)?.dirty).toBe(false)
    // Discard puts a draft back.
    tableProperties.updateDraft(id, { lockEscalation: 'AUTO' })
    tableProperties.discard(id)
    expect(state()).toMatchObject({ changed: false, draft: { lockEscalation: 'DISABLE' } })
  })
  it('asks before turning change tracking off: Cancel sends nothing, Turn Off applies', async () => {
    const { tableProperties, id, state, executes, api } = opened(tableModel({ changeTracking: { databaseEnabled: true, enabled: true, trackColumnsUpdated: true, primaryKey: true } }))
    await settled()
    tableProperties.updateDraft(id, { changeTracking: false })
    expect(await tableProperties.apply(id)).toBe(false)
    expect(api.confirmAction.mock.calls).toEqual([[{ prompt: 'disableChangeTracking', facts: { schema: 'Sales', table: 'Orders', reenable: false } }]])
    expect(executes()).toEqual([])
    expect(state()).toMatchObject({ phase: 'ready', changed: true })
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'apply' })
    api.executeObjectAction.mockResolvedValueOnce(done)
    expect(await tableProperties.apply(id)).toBe(true)
    expect(executes()).toEqual([expect.objectContaining({ tableChanges: { changeTracking: { enabled: false } } })])
  })
  it('sends nothing when the server goes while the question is open, whatever the answer', async () => {
    const { tableProperties, id, state, executes, api, connections } = opened(tableModel({ changeTracking: { databaseEnabled: true, enabled: true, trackColumnsUpdated: true, primaryKey: true } }))
    await settled()
    tableProperties.updateDraft(id, { changeTracking: false })
    let answer!: (value: ApiResult<'apply' | 'cancel'>) => void
    api.confirmAction.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const applying = tableProperties.apply(id)
    await settled()
    expect(state().phase).toBe('confirming')
    connections.remove('c1')
    expect(state().phase).toBe('ready')
    answer({ ok: true, value: 'apply' })
    expect(await applying).toBe(false)
    expect(executes()).toEqual([])
    expect(state()).toMatchObject({ changed: true, stale: false })
  })
  it('keeps the changes after a failure SQL Server rolled back, and marks an Apply whose outcome is unknown', async () => {
    const { tableProperties, id, state, api } = opened()
    await settled()
    tableProperties.updateDraft(id, { lockEscalation: 'AUTO' })
    const rolled = { code: 'SQL_ERROR', message: `Lock escalation failed. ${tableMessages.rolledBack}`, retryable: true } as const
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed', title: 'Set lock escalation' }], messages: [], elapsedMs: 1, error: rolled } })
    expect(await tableProperties.apply(id)).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', changed: true, stale: false, error: rolled })
    expect(tableProperties.canApply(id)).toBe(true)
    api.executeObjectAction.mockResolvedValueOnce({ ok: false, error: 'Cancelled', code: 'CANCELLED' })
    expect(await tableProperties.apply(id)).toBe(false)
    expect(state()).toMatchObject({ stale: true, error: { code: 'CANCELLED', message: tablePropertiesMessages.stopped } })
    expect(tableProperties.canApply(id)).toBe(false)
  })
  it('is read-only for a table that may not change', async () => {
    const { tableProperties, id } = opened(tableModel({ readOnlyReason: tableMessages.systemTable }))
    await settled()
    expect(tableProperties.canEdit(id)).toBe(false)
    tableProperties.updateDraft(id, { lockEscalation: 'AUTO' })
    expect(tableProperties.get(id)?.changed).toBe(false)
  })
})
