import { afterEach, describe, expect, it, vi } from 'vitest'
import { unknownOutcomeMessage } from '../src/shared/actions/catalog'
import type { ActionExecuteResult, ActionRequest } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { commandDescriptor, commandIds } from '../src/shared/commands/catalog'
import { contextRecord } from '../src/shared/commands/context-keys'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { designerStrings } from '../src/shared/designer/catalog'
import type { TableDesignerModel } from '../src/shared/designer/schema'
import { CommandService } from '../src/renderer/src/core/commands'
import { designerContribution } from '../src/renderer/src/contributions/designer'
import { selectorPress, TableDesignerService } from '../src/renderer/src/designer/TableDesignerService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { tempTableMessage } from '../src/shared/designer/schema'
import { deferred, TestEditor } from './fixtures/documents'
import { fakeDocument, FakeElement } from './fixtures/elements'
import { connectionInfo, connectionOptions, workbenchFixture } from './fixtures/workbench'

/** The bound query editor, recording the Monaco commands it is asked to run. */
class FocusableEditor extends TestEditor {
  trigger = vi.fn()
  focus = vi.fn()
  hasTextFocus(): boolean { return false }
}

const model: TableDesignerModel = { database: 'AppData', band: 16, schemas: ['dbo', 'sales'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', caseSensitiveNames: false, accentSensitiveNames: true, canCreate: true }
const tables = (connectionId: string, database = 'AppData'): ExplorerMenuNode => ({
  id: 5, lost: false, kind: 'folder', folder: 'tables', connectionId, label: 'Tables', ref: { type: 'folder', owner: { kind: 'database', name: database }, folder: 'tables' }
})
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

function designer() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo('c1'))
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: params.dialog === 'tableDesigner' ? { tableDesigner: { ...model, database: params.target.name ?? '' }, elapsedMs: 1 } : { elapsedMs: 1 } }))
  const reconcile = vi.spyOn(fixture.explorer, 'reconcile').mockImplementation(() => {})
  const { designers, documents } = fixture
  const id = designers.open(tables('c1'))
  const state = () => designers.get(id)!
  const requests = () => fixture.api.executeObjectAction.mock.calls.map(([request]) => request as ActionRequest)
  return { ...fixture, designers, documents, id, state, reconcile, requests }
}

describe('table designer', () => {
  it('opens at once as a clean tab, describes the database, and starts with the empty last row', async () => {
    const { designers, documents, id, state, api } = designer()
    expect(documents.active).toMatchObject({ id, kind: 'tableDesigner', name: 'c1.example.AppData - dbo.Table_1', dirty: false, connectionId: 'c1', database: 'AppData' })
    expect(state()).toMatchObject({ phase: 'loading', rows: [], name: 'Table_1' })
    await settled()
    expect(api.describeObject).toHaveBeenCalledWith(expect.objectContaining({ dialog: 'tableDesigner', target: { kind: 'database', name: 'AppData' }, connectionId: 'c1' }))
    expect(state()).toMatchObject({ phase: 'ready', schema: 'dbo', model })
    expect(designers.canEdit(id)).toBe(true)
    // A second designer in the session is Table_2.
    expect(designers.get(designers.open(tables('c1')))?.name).toBe('Table_2')
  })
  it('adds a column from the empty last row with SSMS\'s defaults, and every edit is dirty and moves the revision', async () => {
    const { designers, documents, id, state } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    expect(state().rows).toMatchObject([{ name: 'Id', typeText: 'nchar(10)', type: { system: 'nchar', length: 10 }, allowNulls: true }])
    expect(documents.get(id)?.dirty).toBe(true)
    const revision = documents.revision(id)
    designers.setCell(id, 0, 'type', 'INT')
    expect(state().rows[0]).toMatchObject({ typeText: 'int', type: { system: 'int' } })
    expect(documents.revision(id)).toBe(revision + 1)
    designers.setCell(id, 0, 'type', 'varchar2')
    expect(state().rows[0]).toMatchObject({ typeText: 'varchar2', typeError: 'varchar2 is not a data type the table designer offers.' })
    designers.setCell(id, 0, 'type', 'nvarchar(max)')
    expect(state().rows[0].typeText).toBe('nvarchar(MAX)')
    // Column Properties' Data Type changes with every key: what is typed stays as typed, and still names the type.
    designers.setColumnProperty(id, 0, 'dataType', 'nvarchar')
    expect(state().rows[0]).toMatchObject({ typeText: 'nvarchar', type: { system: 'nvarchar', length: 50 } })
  })
  it('sets the primary key on the selection (Allow Nulls off and greyed), removes it, inserts above and deletes columns', async () => {
    const { designers, id, state } = designer()
    await settled()
    for (const name of ['a', 'b', 'c']) designers.setCell(id, state().rows.length, 'name', name)
    designers.select(id, 0)
    designers.select(id, 1, 'toggle')
    designers.setPrimaryKey(id)
    const [a, b, c] = state().rows
    expect(state().primaryKey).toEqual([a.key, b.key])
    expect(state().rows.map(row => row.allowNulls)).toEqual([false, false, true])
    expect(designers.nullsLocked(state(), a) && !designers.nullsLocked(state(), c)).toBe(true)
    designers.toggleNulls(id, 0)
    expect(state().rows[0].allowNulls).toBe(false)
    designers.removePrimaryKey(id)
    expect(state().primaryKey).toEqual([])
    designers.setCurrent(id, 1, 'name')
    designers.insertColumn(id)
    expect(state().rows.map(row => row.name)).toEqual(['a', '', 'b', 'c'])
    // An empty inserted row is not a column of the design.
    expect(TableDesignerService.design(state()).design.columns.map(column => column.name)).toEqual(['a', 'b', 'c'])
    designers.select(id, 2)
    designers.deleteColumns(id)
    expect(state().rows.map(row => row.name)).toEqual(['a', '', 'c'])
    expect(state().rows.some(row => row.key === b.key)).toBe(false)
  })
  it('makes an identity column not allow nulls, keeps one identity per table, and drops it for a type that cannot be one', async () => {
    const { designers, id, state } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'a')
    designers.setCell(id, 0, 'type', 'int')
    designers.setCell(id, 1, 'name', 'b')
    designers.setCell(id, 1, 'type', 'bigint')
    designers.setColumnProperty(id, 0, 'isIdentity', 'Yes')
    expect(state().rows[0]).toMatchObject({ identity: { seed: '1', increment: '1' }, allowNulls: false })
    designers.setColumnProperty(id, 1, 'isIdentity', 'Yes')
    expect(state().rows.map(row => !!row.identity)).toEqual([false, true])
    designers.setColumnProperty(id, 1, 'identitySeed', ' 100 ')
    designers.setColumnProperty(id, 1, 'identityIncrement', '')
    // A blank increment means 1, as in SSMS.
    expect(TableDesignerService.design(state()).design.columns[1].identity).toEqual({ seed: '100', increment: '1' })
    designers.setCell(id, 1, 'type', 'varchar(10)')
    expect(state().rows[1].identity).toBeUndefined()
    designers.setColumnProperty(id, 0, 'length', '20')
    expect(state().rows[0].typeText).toBe('int')
    designers.setCell(id, 0, 'type', 'nvarchar(10)')
    designers.setColumnProperty(id, 0, 'length', 'max')
    expect(state().rows[0].typeText).toBe('nvarchar(MAX)')
  })
  it('asks Choose Name on the first save only; Cancel sends nothing and leaves it dirty', async () => {
    const { designers, documents, id, state, requests } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    let saving = designers.save(id)
    expect(state().prompt).toEqual({ kind: 'chooseName', value: 'Table_1' })
    designers.answerName(id, undefined)
    expect(await saving).toBe(false)
    expect(requests()).toEqual([])
    expect(documents.get(id)?.dirty).toBe(true)
    saving = designers.save(id)
    designers.answerName(id, '')
    expect(state().prompt).toMatchObject({ kind: 'chooseName', error: 'Enter a name for the table.' })
    designers.answerName(id, 'x'.repeat(129))
    expect(state().prompt).toMatchObject({ kind: 'chooseName', error: 'At most 128 UTF-16 code units.' })
    designers.answerName(id, 'Orders')
    expect(await saving).toBe(true)
    expect(requests()).toEqual([{
      action: 'createTable', connectionId: 'c1', requestId: expect.any(String), target: { kind: 'database', name: 'AppData' },
      design: { schema: 'dbo', name: 'Orders', columns: [{ name: 'Id', type: { system: 'nchar', length: 10 }, allowNulls: true }], primaryKey: [] }
    }])
    expect(documents.get(id)?.name).toBe('c1.example.AppData - dbo.Orders')
  })
  it('after a save: clean, read-only with SSMS\'s notice, and Object Explorer reconciles Tables with the new table selected', async () => {
    const { designers, documents, id, state, reconcile } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const saving = designers.save(id)
    designers.answerName(id, 'Orders')
    await saving
    expect(state()).toMatchObject({ phase: 'saved', dirty: false, notice: designerStrings.saved('dbo.Orders') })
    expect(documents.get(id)?.dirty).toBe(false)
    expect(designers.canEdit(id)).toBe(false)
    designers.setCell(id, 0, 'name', 'Other')
    expect(state().rows[0].name).toBe('Id')
    expect(reconcile).toHaveBeenCalledWith(5, { select: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } } })
  })
  it('stays dirty and editable when SQL Server refuses, and the second save keeps the chosen name', async () => {
    const { designers, documents, id, state, api, requests } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'An object named Orders already exists in schema dbo.', retryable: false } } })
    const saving = designers.save(id)
    designers.answerName(id, 'Orders')
    expect(await saving).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', error: 'An object named Orders already exists in schema dbo.', nameChosen: true })
    expect(documents.get(id)?.dirty).toBe(true)
    expect(await designers.save(id)).toBe(true)
    expect(state().prompt).toBeUndefined()
    expect(requests()).toHaveLength(2)
  })
  it('refuses a design with problems before anything is sent, showing the first one at its cell', async () => {
    const { designers, id, state, requests } = designer()
    await settled()
    expect(await designers.save(id)).toBe(false)
    expect(state().error).toBe(designerStrings.noColumns)
    designers.setCell(id, 0, 'name', 'a')
    designers.setCell(id, 1, 'name', 'a')
    expect(await designers.save(id)).toBe(false)
    expect(state()).toMatchObject({ error: 'The column name a is used twice.', current: { row: 1, column: 'name' } })
    expect(requests()).toEqual([])
  })
  it('brings a background designer forward when Save All needs its Choose Name or refuses its design', async () => {
    const { designers, documents, files, id, state, requests } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const other = designers.open(tables('c1'))
    await settled()
    designers.setCell(other, 0, 'name', 'a')
    designers.setCell(other, 1, 'name', 'a')
    const query = documents.newQuery('SELECT 1', 'Query.sql', undefined, 'master')
    expect(documents.active?.id).toBe(query.id)
    // Only the active designer renders, so a prompt in a hidden one would wait unseen while Save All holds the task.
    const saving = files.saveAll()
    await settled()
    expect(documents.active?.id).toBe(id)
    expect(state().prompt).toEqual({ kind: 'chooseName', value: 'Table_1' })
    designers.answerName(id, 'Orders')
    await saving
    expect(requests()).toHaveLength(1)
    // The second design names a column twice: Save All stops there, showing it with the first problem.
    expect(documents.active?.id).toBe(other)
    expect(designers.get(other)).toMatchObject({ error: 'The column name a is used twice.' })
    expect(documents.getSnapshot().busy).toBe(false)
  })
  it('sends one request for concurrent saves, and Stop cancels it in SQL Server', async () => {
    const { designers, id, state, api, requests } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const first = designers.save(id), second = designers.save(id)
    expect(second).toBe(first)
    designers.answerName(id, 'Orders')
    await settled()
    expect(requests()).toHaveLength(1)
    expect(state().phase).toBe('saving')
    expect(designers.anySaving).toBe(true)
    expect(designers.canClose(id)).toBe(designerStrings.saving)
    designers.stop(id)
    expect(api.cancelObjectActions).toHaveBeenCalledWith([requests()[0].requestId])
    pending.resolve({ ok: true, value: { steps: [{ status: 'cancelled', message: 'Create the table' }], messages: [], elapsedMs: 1, error: { code: 'CANCELLED', message: 'stopped', retryable: true } } })
    expect(await first).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', error: designerStrings.stopped })
    expect(designers.anySaving).toBe(false)
  })
  it('says the outcome is unknown when the server disconnects or the backend stops while it saves', async () => {
    const { designers, id, state, api, connections } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const saving = designers.save(id)
    designers.answerName(id, 'Orders')
    await settled()
    connections.remove('c1')
    expect(state()).toMatchObject({ phase: 'ready', error: unknownOutcomeMessage })
    expect(api.cancelObjectActions).toHaveBeenCalled()
    pending.resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    expect(await saving).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', dirty: true })
    expect(designers.canSubmit(id)).toBe(false)
    expect(await designers.save(id)).toBe(false)
    expect(state().error).toBe(designerStrings.disconnected)
  })
  it('a backend loss mid-save is an unknown outcome too', async () => {
    const { designers, id, state, api } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    api.executeObjectAction.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    const saving = designers.save(id)
    designers.answerName(id, 'Orders')
    expect(await saving).toBe(false)
    expect(state().error).toBe(unknownOutcomeMessage)
  })
  it('a failed describe leaves a clean tab that closes without asking', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockResolvedValue({ ok: true, value: { elapsedMs: 1, error: { code: 'DATABASE_UNAVAILABLE', message: 'The database AppData is offline.', retryable: true } } })
    const id = fixture.designers.open(tables('c1'))
    await settled()
    expect(fixture.designers.get(id)).toMatchObject({ phase: 'loadFailed', error: 'The database AppData is offline.' })
    await fixture.files.close(id)
    expect(fixture.documents.get(id)).toBeUndefined()
    expect(fixture.api.confirmClose).not.toHaveBeenCalled()
  })
  it('shows the change script with its warnings, and Yes saves it to a file the user picks', async () => {
    const { designers, id, state, api, files } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    api.scriptObjectAction.mockResolvedValueOnce({ ok: true, value: { text: 'CREATE TABLE dbo.Table_1', database: 'AppData', warnings: ['An object named Table_1 already exists in schema dbo.'] } })
    await designers.generateScript(id)
    expect(api.scriptObjectAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'createTable', design: expect.objectContaining({ name: 'Table_1' }) }))
    expect(state().prompt).toEqual({ kind: 'script', text: 'CREATE TABLE dbo.Table_1', warnings: ['An object named Table_1 already exists in schema dbo.'] })
    const saveCopy = vi.spyOn(files, 'saveCopy').mockResolvedValue(undefined)
    await designers.answerScript(id, true)
    expect(saveCopy).toHaveBeenCalledWith('Table_1.sql', 'CREATE TABLE dbo.Table_1')
    expect(state().prompt).toBeUndefined()
  })
  it('resolves a pending Choose Name as Cancel when it closes or the service goes', async () => {
    const { designers, id } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const saving = designers.save(id)
    designers.dispose()
    expect(await saving).toBe(false)
  })
  it('is never written to AutoRecover, and follows a reconnect only to the server it was opened on', async () => {
    const fixture = designer(), { designers, id, api, recovery, targets, documents, connections, state, requests } = fixture
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    await recovery.flush()
    expect(api.writeRecovery).not.toHaveBeenCalled()
    // A designer has a connection but no SQL session: closing the window never reads one for it.
    expect(await fixture.queries.confirmSessions('exit', [id])).toEqual(new Map())
    expect(api.querySessionState).not.toHaveBeenCalledWith(id)
    // c1 is lost, and the Reconnect dialog's server is changed to another server: the designer stays on c1, disconnected.
    connections.markLostBefore(2)
    connections.replace('c1', { ...connectionInfo('c2', 2), server: 'production.example' }, connectionOptions)
    targets.retarget('c1', 'c2')
    expect(documents.get(id)?.connectionId).toBe('c1')
    expect(documents.get(id)?.name).toBe('c1.example.AppData - dbo.Table_1')
    expect(await designers.save(id)).toBe(false)
    expect(state().error).toBe(designerStrings.disconnected)
    expect(requests()).toEqual([])
    // Reconnected to its own server (named in any case), it follows and saves there.
    connections.replace('c2', { ...connectionInfo('c3', 2), server: 'C1.EXAMPLE' }, connectionOptions)
    targets.retarget('c1', 'c3')
    expect(documents.get(id)?.connectionId).toBe('c3')
    const saving = designers.save(id)
    designers.answerName(id, 'Orders')
    expect(await saving).toBe(true)
    expect(requests().map(request => request.connectionId)).toEqual(['c3'])
  })
  it('commits a cell being edited before Save or Generate Change Script reads the design', async () => {
    const { designers, id, state, api, requests } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    // The grid's editor holds "Extra" in the empty last row; Ctrl+S reaches the workbench before the field blurs.
    let pending: string | undefined = 'Extra'
    const registration = designers.registerEditor(id, () => { if (pending) designers.setCell(id, state().rows.length, 'name', pending); pending = undefined })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'An object named Taken already exists in schema dbo.', retryable: false } } })
    const saving = designers.save(id)
    designers.answerName(id, 'Taken')
    expect(await saving).toBe(false)
    // The retry save, with no Choose Name to blur the field, sends what is typed too.
    pending = 'More'
    designers.setTableProperty(id, 'tableName', 'Orders')
    expect(await designers.save(id)).toBe(true)
    expect(requests().map(request => request.action === 'createTable' ? request.design.columns.map(column => column.name) : [])).toEqual([['Id', 'Extra'], ['Id', 'Extra', 'More']])
    registration.dispose()
    // Generate Change Script commits it too.
    const other = designers.open(tables('c1'))
    await settled()
    pending = 'Only'
    const editor = designers.registerEditor(other, () => { if (pending) designers.setCell(other, 0, 'name', pending); pending = undefined })
    await designers.generateScript(other)
    expect(api.scriptObjectAction).toHaveBeenCalledWith(expect.objectContaining({ design: expect.objectContaining({ columns: [expect.objectContaining({ name: 'Only' })] }) }))
    editor.dispose()
  })
  it('compares column names as the database\'s catalog does, and refuses a temporary table\'s name', async () => {
    const { designers, id, state, requests } = designer()
    await settled()
    // AppData's catalog is case-insensitive: Id and ID are the same name to SQL Server.
    designers.setCell(id, 0, 'name', 'Id')
    designers.setCell(id, 1, 'name', 'ID')
    expect(await designers.save(id)).toBe(false)
    expect(state()).toMatchObject({ error: 'The column name ID is used twice.', current: { row: 1, column: 'name' } })
    designers.setCell(id, 1, 'name', 'Name')
    const saving = designers.save(id)
    designers.answerName(id, '##Orders')
    expect(state().prompt).toMatchObject({ kind: 'chooseName', error: tempTableMessage })
    designers.answerName(id, '#Orders')
    expect(state().prompt).toMatchObject({ kind: 'chooseName', error: tempTableMessage })
    designers.answerName(id, undefined)
    expect(await saving).toBe(false)
    // Properties' Name refuses it at Save too, showing Properties.
    designers.setTableProperty(id, 'tableName', '#Orders')
    expect(await designers.save(id)).toBe(false)
    expect(state()).toMatchObject({ error: tempTableMessage, propertiesVisible: true })
    expect(state().prompt).toBeUndefined()
    expect(requests()).toEqual([])
  })
  it('classifies a press on a row selector as the results grid does on each platform', () => {
    const press = (button: number, keys: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => ({ button, ctrlKey: false, metaKey: false, shiftKey: false, ...keys })
    // macOS: Control+click opens the menu, which keeps a selected row's selection; ⌘ adds a row.
    expect(selectorPress(press(0, { ctrlKey: true }), 'darwin', true)).toBeUndefined()
    expect(selectorPress(press(0, { ctrlKey: true }), 'darwin', false)).toBe('single')
    expect(selectorPress(press(0, { metaKey: true }), 'darwin', true)).toBe('toggle')
    expect(selectorPress(press(2), 'darwin', true)).toBeUndefined()
    // Windows and Linux: Ctrl adds; the Windows key does nothing special.
    expect(selectorPress(press(0, { ctrlKey: true }), 'win32', true)).toBe('toggle')
    expect(selectorPress(press(0, { metaKey: true }), 'linux', false)).toBe('single')
    expect(selectorPress(press(0, { shiftKey: true }), 'win32', false)).toBe('range')
    expect(selectorPress(press(2), 'win32', true)).toBeUndefined()
    expect(selectorPress(press(2), 'win32', false)).toBe('single')
    expect(selectorPress(press(1), 'win32', false)).toBeUndefined()
  })
  it('turns the text-only commands off while a designer is active, and the editor keys with them', async () => {
    const { context, designers, id } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    const keys = context.getState()
    expect(keys).toMatchObject({ activeDocumentIsDesigner: true, activeDocumentIsText: false, activeDocumentIsQuery: false, designerEditable: true, designerRowSelected: true, hasActiveDocument: true })
    for (const id of ['edit.find', 'edit.replace', 'edit.findNext', 'edit.goToLine', 'edit.toggleBookmark', 'edit.makeUppercase', 'editor.toggleOvertype', 'window.switchPane', 'file.saveAs', 'query.execute'] as const) {
      expect(evaluateWhen(compileWhen(commandDescriptor(id).precondition ?? 'true'), keys), id).toBe(false)
    }
    // Every key bound to the editor (editorFocus, editorTextFocus, or the editor panel) is off or inert in a focused designer.
    const focused = contextRecord('win32', { ...keys, activePanel: 'editor', designerFocus: true, editorFocus: false, editorTextFocus: false })
    const editorBound = commandIds.filter(command => (commandDescriptor(command).keybindings ?? []).some(binding => /editorFocus|editorTextFocus|activePanel == 'editor'/.test(binding.when ?? '')))
    expect(editorBound.length).toBeGreaterThan(3)
    for (const command of editorBound) {
      const descriptor = commandDescriptor(command)
      const live = descriptor.keybindings!.filter(binding => /editorFocus|editorTextFocus|activePanel == 'editor'/.test(binding.when ?? '')).some(binding => evaluateWhen(compileWhen(binding.when!), focused))
      expect(live && evaluateWhen(compileWhen(descriptor.precondition ?? 'true'), focused), command).toBe(false)
    }
    // The Query menu acts on the active query, its keys (Ctrl+U) included: a designer is connected but is not one.
    const queryCommands = commandIds.filter(command => commandDescriptor(command).category === 'Query')
    expect(queryCommands).toEqual(expect.arrayContaining(['query.changeDatabase', 'query.disconnect', 'query.disconnectAll', 'query.changeConnection', 'query.execute']))
    for (const command of queryCommands) expect(evaluateWhen(compileWhen(commandDescriptor(command).precondition ?? 'true'), focused), command).toBe(false)
  })
  it('leaves a designer out of Disconnect All Queries: it has no session to close and keeps its server', async () => {
    const { designers, id, documents, targets, api, context } = designer()
    await settled()
    designers.setCell(id, 0, 'name', 'Id')
    expect(context.getState().anyDocumentConnected).toBe(false)
    const query = documents.newQuery('SELECT 1', 'Query.sql', 'c1', 'master')
    expect(context.getState().anyDocumentConnected).toBe(true)
    await targets.disconnectAll()
    expect(api.closeQuerySession.mock.calls).toEqual([[query.id]])
    expect(documents.get(id)?.connectionId).toBe('c1')
    expect(documents.get(query.id)?.connectionId).toBeUndefined()
  })
  it('keeps Edit › Undo and Redo away from the hidden query editor while a designer is active', async () => {
    const { id, documents, commands } = designer()
    await settled()
    const editor = new FocusableEditor()
    const binding = documents.bindEditor(editor.asEditor())
    cleanups.push(() => binding.dispose())
    expect(documents.getSnapshot().activeId).toBe(id)
    const doc = fakeDocument(), grid = new FakeElement(doc, 'div', { className: 'designer-grid', attributes: { role: 'grid' } })
    grid.focus()
    vi.stubGlobal('document', Object.assign(doc, { execCommand: vi.fn(), querySelector: () => null }))
    vi.stubGlobal('HTMLElement', FakeElement)
    cleanups.push(() => vi.unstubAllGlobals())
    expect(await commands.execute('edit.undo', undefined, 'menu')).toBe(true)
    expect(await commands.execute('edit.redo', undefined, 'keybinding')).toBe(true)
    expect([editor.focus.mock.calls.length, editor.trigger.mock.calls.length]).toEqual([0, 0])
    expect(doc.activeElement).toBe(grid)
  })
})

describe('New › Table…', () => {
  it('runs only on a Tables folder of a database on a live server', async () => {
    const commands = new CommandService()
    const opened: ExplorerMenuNode[] = []
    const live = new Set(['c1'])
    const contribution = designerContribution({
      commands, explorer: { menuNode: () => undefined, getSnapshot: () => ({ selected: undefined }) } as never,
      designers: { open: (node: ExplorerMenuNode) => { opened.push(node); return 'tab' }, get: () => undefined } as never,
      documents: { getSnapshot: () => ({ activeId: '' }), focusActive: () => {} } as never, connections: { isLive: (id: string) => live.has(id) } as never
    })
    cleanups.push(() => { contribution.dispose(); commands.dispose() })
    const views = { ...tables('c1'), folder: 'views', ref: { type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'views' } } as ExplorerMenuNode
    expect(commands.canRun('explorer.newTable', { target: { kind: 'explorer', node: tables('c1') } })).toBe(true)
    expect(commands.canRun('explorer.newTable', { target: { kind: 'explorer', node: views } })).toBe(false)
    expect(commands.canRun('explorer.newTable', { target: { kind: 'explorer', node: tables('c2') } })).toBe(false)
    expect(commands.canRun('explorer.newTable', { target: { kind: 'explorer', node: { ...tables('c1'), lost: true } } })).toBe(false)
    expect(commands.canRun('explorer.newTable')).toBe(false)
    await commands.run('explorer.newTable', { target: { kind: 'explorer', node: tables('c1') } })
    expect(opened.map(node => node.id)).toEqual([5])
  })
})
