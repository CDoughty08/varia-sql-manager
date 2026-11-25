import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { actionRequestSchema, type ActionDescribeResult, type ActionExecuteResult, type ActionRequest, type ActionScriptResult } from '../src/shared/actions/schema'
import { actionPromptBox, actionPromptRequestSchema } from '../src/shared/actions/prompts'
import { tableLimits, tableMessages, type TablePropertiesModel } from '../src/shared/actions/tables'
import { actionMenuState, dialogSpecs } from '../src/shared/actions/catalog'
import type { ApiResult } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { addPropertyRow, initialTableDraft, patchPropertyRow, propertyKey, rowEditable, tableChanged, tableChanges, tableConfirmation, tableErrors, tableNotes, tableRequest, type TableDraft, type TableRequest } from '../src/renderer/src/dialogs/table-properties'
import { setScriptOpen } from '../src/renderer/src/kit/document-frame'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import TableProperties from '../src/renderer/src/properties/TableProperties'
import {
  formatSpaceKb, generalFacts, storageFacts, tableCapabilities, tableChangeCount, tableHeroKpis,
  tableInspectorTabFromPeek, tableModifiedTabs, tablePages, tableProblemTabs, tableSpaceRatio,
  tableStatusPills, tableVitalsFacts, versioningFacts
} from '../src/renderer/src/properties/table-fields'
import { previewDelayMs } from '../src/renderer/src/properties/DatabasePropertiesService'
import { tablePropertiesMessages } from '../src/renderer/src/properties/TablePropertiesService'
import { descriptor, summaryOf } from './fixtures/results'
import { connectionInfo, connectionOptions, manualTimers, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }

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
    // Changing only the value of one of two names that differ by case keeps the name SQL Server already accepted.
    const valueOnly = patchPropertyRow(start, 'read-1', { value: 'ok' })
    expect(tableErrors(model, valueOnly).size).toBe(0)
    expect(request(model, valueOnly).tableChanges.extendedProperties).toEqual([{ op: 'update', name: 'desc', value: 'ok' }])
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
function opened(model = tableModel(), canonical = false) {
  const clock = manualTimers()
  const fixture = workbenchFixture({ timers: clock.timers })
  cleanups.push(() => fixture.dispose())
  const connectionId = canonical ? crypto.randomUUID() : 'c1', targetId = crypto.randomUUID()
  if (canonical) {
    fixture.api.push(readyBackend())
    const attempt = fixture.connections.beginConnect(connectionOptions, 1, targetId)!
    fixture.connections.accept(connectionInfo(connectionId), connectionOptions, targetId, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'sid:reader' } }, attempt)
  } else fixture.connect(connectionInfo(connectionId))
  let current = model
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'tableProperties' ? { tableProperties: current, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.scriptObjectAction.mockImplementation(async params => ({ ok: true, value: { text: `ALTER TABLE -- ${JSON.stringify(params.action === 'tableProperties' ? params.tableChanges : {})}`, database: 'AppData', warnings: [] } as ActionScriptResult }))
  const { tableProperties, documents } = fixture
  const id = tableProperties.open(node(orders, connectionId))
  const state = () => tableProperties.get(id)!
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, tableProperties, documents, id, state, executes, clock, connectionId, targetId, setModel: (next: TablePropertiesModel) => { current = next } }
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
  it('keeps a disconnected draft on its own target and never adopts another connection to a server of the same name', async () => {
    const { tableProperties, documents, id, state, executes, api, connections, connect, targets } = opened()
    await settled()
    tableProperties.updateDraft(id, { lockEscalation: 'DISABLE' })
    connections.remove('c1')
    expect(tableProperties.canApply(id)).toBe(false)
    connect({ ...connectionInfo('c3'), server: 'C1.EXAMPLE', login: 'another-account' })
    targets.retarget('c1', 'c3')
    // Even a central document update cannot point the draft at the other account.
    documents.update(id, { connectionId: 'c3' })
    await settled()
    expect(documents.follows(id, 'c1.example')).toBe(false)
    expect(tableProperties.canApply(id)).toBe(false)
    expect(await tableProperties.apply(id)).toBe(false)
    expect(executes()).toEqual([])
    expect(state()).toMatchObject({ changed: true, draft: { lockEscalation: 'DISABLE' } })
    // Properties from that connection is another document, not this draft.
    const other = tableProperties.open(node(orders, 'c3'))
    expect(other).not.toBe(id)
    await settled()
    expect(api.describeObject.mock.calls.at(-1)?.[0]).toMatchObject({ connectionId: 'c3' })
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
  it('adds zero extra SQL round-trips on open and lazy-loads Definition, Columns, Indexes & Keys, Dependencies and Preview Rows only on tab activation', async () => {
    const { tableProperties, documents, results, id, state, api } = opened()
    await settled()
    expect(api.describeObject).toHaveBeenCalledTimes(1)
    expect(api.explorerPeek).not.toHaveBeenCalled()
    expect(api.scriptObjects).not.toHaveBeenCalled()
    expect(api.explorerPeekDependencies).not.toHaveBeenCalled()
    expect(api.tableColumns).not.toHaveBeenCalled()
    expect(api.execute).not.toHaveBeenCalled()
    expect(state().activeTab).toBe('overview')

    // Columns triggers explorer.peek once; Indexes & Keys reuses the exact same catalog reply with zero second round-trip.
    const columns = { rows: [['Id', 'int', false, 'PK', '1, 1', null, null, '[Id] int IDENTITY(1,1) NOT NULL']] }
    const tableObjects = { rows: [['Primary key', 'PK_Orders', 'Clustered (Id)', 'Active']] }
    api.explorerPeek.mockResolvedValueOnce({ ok: true, value: { facts: {}, lists: { columns, tableObjects }, elapsedMs: 1 } })
    tableProperties.selectTab(id, 'columns')
    await settled()
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    expect(state().catalog).toEqual({ status: 'ready', value: { columns, tableObjects } })
    tableProperties.selectTab(id, 'indexes')
    await settled()
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)

    // Definition scripts via scripting.script only when activated, copies and opens in a new query tab.
    tableProperties.selectTab(id, 'definition')
    await settled()
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    expect(state().definition).toEqual({ status: 'ready', value: { text: '-- create Sales.Orders' } })
    await tableProperties.copyDefinition(id)
    expect(api.writeClipboardText).toHaveBeenCalledWith('-- create Sales.Orders')
    const docsBefore = documents.getSnapshot().documents.length
    tableProperties.openDefinitionInQuery(id)
    expect(documents.getSnapshot().documents.length).toBe(docsBefore + 1)

    // Dependencies loads via explorer.peekDependencies only when activated.
    api.explorerPeekDependencies.mockResolvedValueOnce({ ok: true, value: { uses: [{ name: 'Customers', schema: 'dbo', kind: 'table' }], usedBy: [], elapsedMs: 1 } })
    tableProperties.selectTab(id, 'dependencies')
    await settled()
    expect(api.explorerPeekDependencies).toHaveBeenCalledTimes(1)
    expect(state().dependencies).toEqual({ status: 'ready', value: { uses: [{ name: 'Customers', schema: 'dbo', kind: 'table' }], usesTruncated: false, usedBy: [], usedByTruncated: false } })

    // Preview Rows runs tableColumns + execute only when activated, closes its session, and releases results on close.
    api.execute.mockResolvedValueOnce({ ok: true, value: summaryOf([descriptor(1)]) })
    tableProperties.selectTab(id, 'preview')
    await settled()
    expect(api.tableColumns).toHaveBeenCalledTimes(1)
    expect(api.execute).toHaveBeenCalledTimes(1)
    expect(api.closeQuerySession).toHaveBeenCalledTimes(1)
    expect(state().preview).toMatchObject({ status: 'ready', value: { key: expect.any(String) } })
    const previewPart = state().preview
    const previewKey = previewPart?.status === 'ready' ? previewPart.value.key : ''
    expect(results.getSnapshot()[previewKey]).toBeDefined()

    // Refresh resets lazy tabs and immediately reloads the currently active lazy tab.
    api.execute.mockResolvedValueOnce({ ok: true, value: summaryOf([descriptor(2)]) })
    tableProperties.refresh(id)
    await settled()
    expect(state().catalog).toBeUndefined()
    expect(state().definition).toBeUndefined()
    expect(state().dependencies).toBeUndefined()
    expect(api.execute).toHaveBeenCalledTimes(2)
    expect(results.getSnapshot()[previewKey]).toBeUndefined()

    // Closing the document releases Preview Rows results.
    const nextPreviewPart = state().preview
    const nextPreviewKey = nextPreviewPart?.status === 'ready' ? nextPreviewPart.value.key : ''
    tableProperties.closed(id)
    expect(results.getSnapshot()[nextPreviewKey]).toBeUndefined()
  })
  it('opens directly on a requested canonical tab when promoted from Peek and focuses existing documents on that tab', async () => {
    const { tableProperties, documents, id, state, api } = opened()
    await settled()
    expect(state().activeTab).toBe('overview')
    documents.newQuery()
    // Re-opening the same table with a target tab brings the existing tab forward and switches directly to that tab.
    expect(tableProperties.open(node(), 'columns')).toBe(id)
    await settled()
    expect(documents.active?.id).toBe(id)
    expect(state().activeTab).toBe('columns')
    expect(api.describeObject).toHaveBeenCalledTimes(1)
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    // Re-opening without an explicit tab preserves the currently active tab.
    documents.newQuery()
    expect(tableProperties.open(node())).toBe(id)
    expect(state().activeTab).toBe('columns')
  })
  it('switches orphan rebind to requested tab without firing SQL for the previous tab, and handles disconnect/detach during lazy loads', async () => {
    const { tableProperties, documents, results, connections, connectionTargets, targets, connectionId, targetId, id, state, api } = opened(tableModel(), true)
    await settled()
    api.execute.mockResolvedValueOnce({ ok: true, value: summaryOf([descriptor(1)]) })
    tableProperties.selectTab(id, 'preview')
    await settled()
    expect(api.execute).toHaveBeenCalledTimes(1)
    // Disconnect cancels/releases preview and marks preview as error.
    const disconnect = connectionTargets.beginDisconnect(targetId, crypto.randomUUID())!
    connectionTargets.completeDisconnect(disconnect)
    targets.detached(targetId, { id: connectionId, generation: 1 })
    expect(state().preview?.status).toBe('error')
    expect(results.getSnapshot()).toEqual({})
    // Reconnect on the same durable target and reopen targeting 'definition': must NOT re-execute preview SQL!
    const nextConnectionId = crypto.randomUUID()
    const attempt = connections.beginConnect(connectionOptions, 1, targetId)!
    expect(connections.accept(connectionInfo(nextConnectionId), connectionOptions, targetId, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'sid:reader' } }, attempt).status).toBe('accepted')
    expect(tableProperties.open(node(orders, nextConnectionId), 'definition')).toBe(id)
    await settled()
    expect(state().activeTab).toBe('definition')
    expect(api.execute).toHaveBeenCalledTimes(1)
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    // Detach via documents.update clears connectionId and cancels in-flight lazy dependencies cleanly.
    let resolveDeps!: (value: ApiResult<{ uses: []; usedBy: []; elapsedMs: number }>) => void
    api.explorerPeekDependencies.mockImplementationOnce(() => new Promise(resolve => { resolveDeps = resolve }))
    tableProperties.selectTab(id, 'dependencies')
    expect(state().dependencies).toEqual({ status: 'loading' })
    documents.update(id, { connectionId: undefined })
    expect(state().dependencies?.status).toBe('error')
    expect(api.explorerCancel).toHaveBeenCalled()
    // Late reply after detach is ignored.
    resolveDeps({ ok: true, value: { uses: [], usedBy: [], elapsedMs: 1 } })
    await settled()
    expect(state().dependencies?.status).toBe('error')
    // Open in New Query still works offline (opens an unconnected query tab with the cached definition).
    const before = documents.getSnapshot().documents.length
    tableProperties.openDefinitionInQuery(id)
    expect(documents.getSnapshot().documents.length).toBe(before + 1)
    expect(documents.active?.connectionId).toBeUndefined()
  })
  it('handles non-scriptable droppedLedger and ledgerHistory tables, and invalidates Definition on apply and scripting options changes', async () => {
    // Dropped ledger / ledger history tables settle Definition without calling scriptObjects once known.
    const history = opened(tableModel({ ledger: { type: 'LEDGER_HISTORY_TABLE', dropped: false } }))
    await settled()
    history.tableProperties.selectTab(history.id, 'definition')
    await settled()
    expect(history.api.scriptObjects).not.toHaveBeenCalled()
    expect(history.state().definition).toEqual({ status: 'ready', value: {} })

    // Normal table: apply invalidates Definition and reloads it when Definition is active; scripting option change also reloads.
    const { tableProperties, settings, id, state, api } = opened()
    await settled()
    tableProperties.selectTab(id, 'definition')
    await settled()
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
    await settings.update({ 'objectExplorer.scripting.includeHeaders': false })
    await settled()
    expect(api.scriptObjects).toHaveBeenCalledTimes(2)
    tableProperties.updateDraft(id, { lockEscalation: 'DISABLE' })
    api.executeObjectAction.mockResolvedValueOnce(done)
    expect(await tableProperties.apply(id)).toBe(true)
    await settled()
    expect(api.scriptObjects).toHaveBeenCalledTimes(3)
    expect(state().definition).toEqual({ status: 'ready', value: { text: '-- create Sales.Orders' } })
  })
})

describe('Table Properties unified inspector helpers and view', () => {
  it('maps Peek tabs (legacy and canonical) onto Table Properties canonical tabs', () => {
    expect(tableInspectorTabFromPeek(undefined)).toBe('overview')
    expect(tableInspectorTabFromPeek('overview')).toBe('overview')
    expect(tableInspectorTabFromPeek('definition')).toBe('definition')
    expect(tableInspectorTabFromPeek('storage')).toBe('storage')
    expect(tableInspectorTabFromPeek('columns')).toBe('columns')
    expect(tableInspectorTabFromPeek('tableObjects')).toBe('indexes')
    expect(tableInspectorTabFromPeek('indexes')).toBe('indexes')
    expect(tableInspectorTabFromPeek('dependencies')).toBe('dependencies')
    expect(tableInspectorTabFromPeek('rows')).toBe('preview')
    expect(tableInspectorTabFromPeek('preview')).toBe('preview')
  })
  it('builds status pills, capabilities, Hero KPIs, space ratios, Vitals and modified/problem tab indicators', () => {
    const rich = tableModel({
      general: { ...tableModel().general, memoryOptimized: true, durability: 'SCHEMA_AND_DATA', graph: 'node' },
      storage: { ...tableModel().storage, dataSpaceKb: 2048, indexSpaceKb: 512, partitioned: true, partitions: [{ number: 1, rows: 600, compression: 'PAGE', filegroup: 'FG1' }, { number: 2, rows: 600, compression: 'ROW', filegroup: 'FG2' }] },
      temporal: { type: 'SYSTEM_VERSIONED_TEMPORAL_TABLE', other: 'Sales.OrdersHistory' },
      ledger: { type: 'UPDATABLE_LEDGER_TABLE', dropped: false },
      changeTracking: { databaseEnabled: true, enabled: true, trackColumnsUpdated: true, primaryKey: true }
    })
    expect(formatSpaceKb(88)).toBe('88 KB')
    expect(formatSpaceKb(2048)).toBe('2.00 MB')
    expect(tableStatusPills(rich).map(pill => pill.label)).toEqual(['System-versioned', 'Partitioned', 'Memory-optimized', 'Ledger', 'Change tracking', 'Graph node'])
    const caps = tableCapabilities(rich)
    expect(caps.filter(item => item.notable).map(item => item.id)).toContain('temporal')
    expect(caps.filter(item => item.notable).map(item => item.id)).toContain('changeTracking')
    expect(tableSpaceRatio(rich.storage)?.totalLabel).toBe('2.50 MB')
    const kpis = tableHeroKpis(rich, { columns: { count: 14 }, indexes: { count: 5 } })
    expect(kpis.map(kpi => kpi.label)).toEqual(['Rows', 'Total Space', 'Columns', 'Indexes & Keys', 'Partitions'])
    expect(kpis[1]?.ratio).toHaveLength(2)
    expect(tableVitalsFacts(rich).map(item => item.label)).toContain('Compression')

    const start = initialTableDraft(rich)
    expect(tableChangeCount(rich, start)).toBe(0)
    expect([...tableModifiedTabs(rich, start)]).toEqual([])
    const edited = patchPropertyRow({ ...start, lockEscalation: 'DISABLE' }, 'read-0', { value: 'Updated' })
    expect(tableChangeCount(rich, edited)).toBe(2)
    expect([...tableModifiedTabs(rich, edited)].sort()).toEqual(['extendedProperties', 'overview'])
    const invalid = addPropertyRow(edited, 'new-empty')
    expect([...tableProblemTabs(tableErrors(rich, invalid))]).toEqual(['extendedProperties'])
  })
  it('renders unified ObjectInspectorFrame with canonical tabs, Hero KPIs, Vitals rail, and natural-height grids without a 12-row cap', async () => {
    const manyPermissions = Array.from({ length: 20 }, (_, index) => ({
      principal: `user_${index}`, principalType: 'SQL_USER', permission: 'SELECT', state: 'GRANT', grantor: 'dbo'
    }))
    const fixture = opened(tableModel({ permissions: manyPermissions }))
    await settled()
    const workbench = { ...fixture, platform: 'win32' } as unknown as Workbench
    const render = () => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(TableProperties, { documentId: fixture.id }) }))

    const overviewHtml = render()
    expect(overviewHtml).toContain('data-object-inspector="table-properties-')
    expect(overviewHtml).toContain('SQL Server')
    expect(overviewHtml).toContain('aria-label="Key metrics"')
    expect(overviewHtml).toContain('aria-label="Vitals"')
    expect(overviewHtml).toContain('aria-label="Object sections"')
    for (const title of ['Overview', 'Definition', 'Storage &amp; Layout', 'Columns', 'Indexes &amp; Keys', 'Dependencies', 'Permissions &amp; RLS', 'Extended Properties', 'Preview Rows']) {
      expect(overviewHtml).toContain(title)
    }

    // Dirty draft updates header verb to Apply · 1 and adds a modified dot to Overview.
    fixture.tableProperties.updateDraft(fixture.id, { lockEscalation: 'DISABLE' })
    const dirtyHtml = render()
    expect(dirtyHtml).toContain('Apply · 1')
    expect(dirtyHtml).toContain('(modified)')

    // Permissions & RLS renders its 20-row grid at natural height (22 + 20 * 20 + 2 = 424px), never capped at 12 rows.
    fixture.tableProperties.selectTab(fixture.id, 'permissions')
    const permissionsHtml = render()
    expect(permissionsHtml).toContain('style="height:424px;flex:none"')
    expect(permissionsHtml).toContain('(20 permissions and predicates)')

    // Singular count labels use singular nouns when exactly one item is present (and not truncated).
    const singleFixture = opened(tableModel({
      permissions: [{ principal: 'app', principalType: 'SQL_USER', permission: 'SELECT', state: 'GRANT', grantor: 'dbo' }],
      extendedProperties: [{ name: 'MS_Description', value: 'Orders' }]
    }))
    await settled()
    const singleHtml = renderToStaticMarkup(createElement(WorkbenchProvider, {
      workbench: { ...singleFixture, platform: 'win32' } as unknown as Workbench,
      children: createElement(TableProperties, { documentId: singleFixture.id })
    }))
    expect(singleHtml).toContain('(1 permission or predicate)')
    expect(singleHtml).toContain('(1 extended property)')
  })
})
