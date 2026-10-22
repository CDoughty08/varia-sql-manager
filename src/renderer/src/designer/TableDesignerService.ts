import { actionLimits, unknownOutcomeMessage } from '../../../shared/actions/catalog.ts'
import type { ActionExecuteResult } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { defaultNewType, defaultTableName, designerCaption, designerStrings, typeSpec } from '../../../shared/designer/catalog.ts'
import { designProblems, tableNameProblem, type DesignProblem, type TableDesign, type TableDesignerModel } from '../../../shared/designer/schema.ts'
import { formatTypeText, identityAllowed, parseTypeText, type DesignType } from '../../../shared/designer/type-text.ts'
import type { Platform } from '../../../shared/commands/keybindings.ts'
import type { ExplorerNodeRef } from '../../../shared/explorer/refs.ts'
import { ident } from '../../../shared/explorer/schema.ts'
import type { DesignerContextState, DesignerKeys } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { pressButton } from '../grid/selection'
import type { ExplorerMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

/** A grid row: the column's name, the Data Type cell's text and the type it names (undefined while the text names none,
 *  with `typeError` saying why), Allow Nulls, and the identity's seed and increment as typed (blank means 1). `key` is
 *  stable while rows move, so the selection and the primary key follow their rows. */
export interface DesignerRow {
  readonly key: number
  readonly name: string
  readonly typeText: string
  readonly type?: DesignType
  readonly typeError?: string
  readonly allowNulls: boolean
  readonly identity?: { readonly seed: string; readonly increment: string }
}
export type DesignerColumn = 'name' | 'type' | 'nulls'
/** loading → ready (or loadFailed); Save: ready → saving → saved, or back to ready with an error. */
export type DesignerPhase = 'loading' | 'loadFailed' | 'ready' | 'saving' | 'saved'
export type DesignerPrompt =
  | { readonly kind: 'chooseName'; readonly value: string; readonly error?: string }
  | { readonly kind: 'script'; readonly text: string; readonly warnings: readonly string[] }
export interface DesignerState {
  readonly id: string
  readonly server: string
  readonly database: string
  /** The Tables folder it was opened from, which a successful save reloads. */
  readonly folderNodeId?: number
  readonly phase: DesignerPhase
  readonly model?: TableDesignerModel
  readonly name: string
  readonly schema: string
  /** Choose Name was answered: later saves keep the name (Properties changes it). */
  readonly nameChosen: boolean
  readonly rows: readonly DesignerRow[]
  /** Row keys in key order. */
  readonly primaryKey: readonly number[]
  /** Row keys of the selected rows. */
  readonly selected: readonly number[]
  readonly anchor?: number
  /** The current cell: a row index (rows.length is the empty last row) and a column. */
  readonly current: { readonly row: number; readonly column: DesignerColumn }
  readonly revision: number
  readonly dirty: boolean
  readonly error?: string
  readonly notice?: string
  readonly propertiesVisible: boolean
  readonly identityExpanded: boolean
  readonly order: 'categorized' | 'alphabetical'
  readonly prompt?: DesignerPrompt
  readonly scripting: boolean
}
export interface DesignerSnapshot { readonly designers: Readonly<Record<string, DesignerState>> }

export interface TableDesignerServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot'>
  readonly files: { saveCopy(name: string, content: string): Promise<unknown> }
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: { refreshAndSelect(folderNodeId: number, ref: ExplorerNodeRef): void }
  /** Focuses a designer's grid (the app's DOM); tests leave it out. */
  readonly focus?: (id: string) => void
  readonly newId?: () => string
}

const error = (result: ApiResult<unknown>) => result.ok ? undefined : result.error

/**
 * SSMS's Table Designer for a new table (New › Table…), one per document tab. The design lives here, in the renderer, so a
 * backend restart keeps it; the backend only describes the database, scripts the design and creates the table. It is the
 * DocumentService's provider for 'tableDesigner' documents: Save, the close prompt's revision and Stop come through it.
 * Failures are values in the snapshot; nothing throws into React.
 */
export class TableDesignerService extends SnapshotStore<DesignerSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'tableDesigner' as const
  private readonly newId: () => string
  private readonly registration: Disposable
  private readonly unsubscribe: () => void
  private readonly contextStore = new (class extends SnapshotStore<DesignerContextState> { set(value: DesignerContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {}, saving: false })
  private readonly saving = new Map<string, Promise<boolean>>()
  /** The request each designer has in flight (describe, script or save), so Stop and a disconnect can cancel it. */
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'script' | 'save'; dropped: boolean }>()
  private readonly prompts = new Map<string, (value: string | undefined) => void>()
  /** Each mounted grid's cell editor: commits what is typed in it, which Save and Generate Change Script read first. */
  private readonly editors = new Map<string, () => void>()
  private tables = 0
  private rowKeys = 0
  private disposed = false

  constructor(private readonly options: TableDesignerServiceOptions) {
    super({ designers: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  /** The designers' context keys (activeDocumentIsDesigner, designerEditable, …). */
  get context(): ExternalStore<DesignerContextState> { return this.contextStore }
  get(id: string): DesignerState | undefined { return this.getSnapshot().designers[id] }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  /** New › Table… on a Tables folder: the tab opens at once, loading, and the database is described. */
  open(node: ExplorerMenuNode): string {
    if (this.disposed) throw new Error('The table designer is not available.')
    const owner = node.ref.type === 'folder' && node.ref.folder === 'tables' ? node.ref.owner : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!owner || owner.kind !== 'database' || !owner.name) throw new Error('Select the Tables folder of a database in Object Explorer.')
    if (!connection) throw new Error('Connect to the server first.')
    const name = defaultTableName(++this.tables), database = owner.name
    const document = this.options.documents.openCustom('tableDesigner', designerCaption(connection.server, database, 'dbo', name), connection.id, database)
    const state: DesignerState = {
      id: document.id, server: connection.server, database, folderNodeId: node.id, phase: 'loading', name, schema: 'dbo', nameChosen: false, rows: [], primaryKey: [], selected: [],
      current: { row: 0, column: 'name' }, revision: 0, dirty: false, propertiesVisible: false, identityExpanded: true, order: 'categorized', scripting: false
    }
    this.put(state)
    void this.describe(document.id)
    return document.id
  }

  private async describe(id: string): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'tableDesigner', target: { kind: 'database', name: state.database } }))
    if (!this.end(id, requestId)) return
    const model = result.ok ? result.value.tableDesigner : undefined
    if (!model) {
      this.patch(id, { phase: 'loadFailed', error: (result.ok ? result.value.error?.message : error(result)) ?? designerStrings.loadFailed })
      return
    }
    this.patch(id, { phase: 'ready', model, schema: model.defaultSchema })
    this.caption(id)
  }

  // --- Editing -----------------------------------------------------------------------------------------------------------

  /** Whether the designer takes edits now: loaded, and not saving or saved. */
  canEdit(id: string): boolean { return this.get(id)?.phase === 'ready' }
  /** Whether Save and Generate Change Script can run: editable, and its server connected. */
  canSubmit(id: string): boolean { return this.canEdit(id) && this.live(id) }

  /** Types into a cell. The empty last row's name adds a column (nchar(10), Allow Nulls checked). `raw` keeps the Data Type
   *  text as typed (Column Properties' field, which changes with every key), rather than rewriting it in SSMS's form. */
  setCell(id: string, rowIndex: number, column: 'name' | 'type', value: string, raw = false): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    if (rowIndex >= state.rows.length) {
      if (column !== 'name' || value === '') return
      this.edit(id, { rows: [...state.rows, this.newRow(value)], current: { row: state.rows.length, column } })
      return
    }
    const row = state.rows[rowIndex]
    if (column === 'name' ? value === row.name : value === row.typeText) return
    if (column === 'name') {
      const typed = row.typeText === '' && value !== '' ? this.typed(formatTypeText(defaultNewType)) : {}
      this.replaceRow(id, rowIndex, { ...row, ...typed, name: value })
    } else {
      const typed = this.typed(value, state.model?.band)
      this.replaceRow(id, rowIndex, { ...row, ...typed, ...raw ? { typeText: value } : {} })
    }
  }
  toggleNulls(id: string, rowIndex: number): void {
    const state = this.get(id), row = state?.rows[rowIndex]
    if (!state || !row || !this.canEdit(id) || this.nullsLocked(state, row)) return
    this.replaceRow(id, rowIndex, { ...row, allowNulls: !row.allowNulls })
  }
  /** A primary key or identity column never allows nulls, so its Allow Nulls is greyed. */
  nullsLocked(state: DesignerState, row: DesignerRow): boolean { return state.primaryKey.includes(row.key) || !!row.identity }
  setCurrent(id: string, row: number, column: DesignerColumn): void {
    const state = this.get(id)
    if (!state) return
    const index = Math.max(0, Math.min(row, state.rows.length))
    if (state.current.row !== index || state.current.column !== column) this.patch(id, { current: { row: index, column } })
  }
  /** A click on a row selector: one row, Ctrl/⌘ toggles it, Shift extends from the last one chosen. */
  select(id: string, rowIndex: number, mode: 'single' | 'toggle' | 'range' = 'single'): void {
    const state = this.get(id)
    if (!state) return
    const row = state.rows[rowIndex]
    if (!row) { this.patch(id, { selected: [], current: { row: state.rows.length, column: state.current.column } }); return }
    const anchorIndex = state.rows.findIndex(item => item.key === state.anchor)
    let selected: number[]
    if (mode === 'toggle') selected = state.selected.includes(row.key) ? state.selected.filter(key => key !== row.key) : [...state.selected, row.key]
    else if (mode === 'range' && anchorIndex >= 0) {
      const [from, to] = anchorIndex < rowIndex ? [anchorIndex, rowIndex] : [rowIndex, anchorIndex]
      selected = state.rows.slice(from, to + 1).map(item => item.key)
    } else selected = [row.key]
    this.patch(id, { selected, anchor: mode === 'range' ? state.anchor : row.key, current: { row: rowIndex, column: state.current.column } })
  }
  /** The rows selected, else the current row: what the key and column commands act on. */
  private targets(state: DesignerState): DesignerRow[] {
    const chosen = state.rows.filter(row => state.selected.includes(row.key))
    return chosen.length ? chosen : state.rows[state.current.row] ? [state.rows[state.current.row]] : []
  }
  /** SSMS's Set Primary Key: the selected columns become the key, in row order, and stop allowing nulls. */
  setPrimaryKey(id: string): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    const chosen = this.targets(state).filter(row => row.name !== '' || row.typeText !== '')
    if (!chosen.length) return
    const keys = new Set(chosen.map(row => row.key))
    this.edit(id, { primaryKey: state.rows.filter(row => keys.has(row.key)).map(row => row.key), rows: state.rows.map(row => keys.has(row.key) ? { ...row, allowNulls: false } : row) })
  }
  /** Remove Primary Key: the table has no key; Allow Nulls stays as it was and can change again. */
  removePrimaryKey(id: string): void {
    if (this.get(id)?.primaryKey.length && this.canEdit(id)) this.edit(id, { primaryKey: [] })
  }
  /** Insert Column: an empty row above the current one; it becomes a column once it has a name. */
  insertColumn(id: string): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    const at = Math.min(state.current.row, state.rows.length)
    const row: DesignerRow = { key: ++this.rowKeys, name: '', typeText: '', allowNulls: true }
    this.edit(id, { rows: [...state.rows.slice(0, at), row, ...state.rows.slice(at)], selected: [row.key], anchor: row.key, current: { row: at, column: 'name' } })
  }
  /** Delete Column: the selected rows, and their place in the key. */
  deleteColumns(id: string): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    const gone = new Set(this.targets(state).map(row => row.key))
    if (!gone.size) return
    const rows = state.rows.filter(row => !gone.has(row.key))
    this.edit(id, { rows, primaryKey: state.primaryKey.filter(key => !gone.has(key)), selected: [], current: { row: Math.min(state.current.row, rows.length), column: state.current.column } })
  }
  /** Column Properties: (Name), Allow Nulls, Data Type, Length, Precision, Scale, (Is Identity), Identity Increment and Seed. */
  setColumnProperty(id: string, rowIndex: number, property: 'name' | 'allowNulls' | 'dataType' | 'length' | 'precision' | 'scale' | 'isIdentity' | 'identityIncrement' | 'identitySeed', value: string): void {
    const state = this.get(id), row = state?.rows[rowIndex]
    if (!state || !row || !this.canEdit(id)) return
    switch (property) {
      case 'name': return this.setCell(id, rowIndex, 'name', value)
      case 'dataType': return this.setCell(id, rowIndex, 'type', value, true)
      case 'allowNulls':
        if (!this.nullsLocked(state, row) && (value === 'Yes') !== row.allowNulls) this.replaceRow(id, rowIndex, { ...row, allowNulls: value === 'Yes' })
        return
      case 'length': case 'precision': case 'scale': {
        const type = row.type
        if (!type) return
        const number = /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
        const next: DesignType = property === 'length'
          ? value.trim().toLowerCase() === 'max' ? { system: type.system, max: true } : { system: type.system, length: number }
          : { ...type, [property]: number }
        this.replaceRow(id, rowIndex, { ...row, ...this.typed(Number.isNaN(number) && !(property === 'length' && value.trim().toLowerCase() === 'max') ? `${type.system}(${value})` : formatTypeText(next), state.model?.band) })
        return
      }
      case 'isIdentity': {
        const on = value === 'Yes'
        if (on === !!row.identity) return
        // As SSMS does, an identity column stops allowing nulls; only one column of a table is the identity.
        const rows = state.rows.map((item, index) => index === rowIndex ? on ? { ...item, identity: { seed: '1', increment: '1' }, allowNulls: false } : { ...item, identity: undefined }
          : on && item.identity ? { ...item, identity: undefined } : item)
        this.edit(id, { rows })
        return
      }
      case 'identityIncrement': case 'identitySeed':
        if (row.identity) this.replaceRow(id, rowIndex, { ...row, identity: { ...row.identity, [property === 'identitySeed' ? 'seed' : 'increment']: value.trim() } })
        return
    }
  }
  /** The Properties window's Name and Schema. */
  setTableProperty(id: string, property: 'tableName' | 'schema', value: string): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    if (property === 'tableName' && value !== state.name) this.edit(id, { name: value })
    if (property === 'schema' && value !== state.schema) this.edit(id, { schema: value })
    this.caption(id)
  }
  toggleProperties(id: string): void { const state = this.get(id); if (state) this.patch(id, { propertiesVisible: !state.propertiesVisible }) }
  toggleIdentity(id: string): void { const state = this.get(id); if (state) this.patch(id, { identityExpanded: !state.identityExpanded }) }
  setOrder(id: string, order: DesignerState['order']): void { if (this.get(id)) this.patch(id, { order }) }
  dismissError(id: string): void { if (this.get(id)?.error) this.patch(id, { error: undefined }) }

  // --- The design --------------------------------------------------------------------------------------------------------

  /** The rows that are columns: an empty inserted row (no name, no type) is not one. */
  static columnRows(state: DesignerState): readonly DesignerRow[] { return state.rows.filter(row => row.name !== '' || row.typeText !== '') }
  /** The design Save sends, and each problem with the row index it is about. */
  static design(state: DesignerState): { readonly design: TableDesign; readonly problems: readonly (DesignProblem & { readonly row?: number })[] } {
    const rows = TableDesignerService.columnRows(state)
    const design: TableDesign = {
      schema: state.schema, name: state.name, primaryKey: state.primaryKey.map(key => rows.findIndex(row => row.key === key)).filter(index => index >= 0),
      columns: rows.map(row => ({
        name: row.name, type: row.type ?? { system: row.typeText }, allowNulls: row.allowNulls,
        // A blank seed or increment means 1, as in SSMS.
        ...row.identity ? { identity: { seed: row.identity.seed || '1', increment: row.identity.increment || '1' } } : {}
      }))
    }
    const rowOf = (column: number | undefined) => column === undefined ? undefined : state.rows.indexOf(rows[column])
    const typeProblems = rows.flatMap((row, column) => row.typeError ? [{ column, property: 'dataType' as const, message: row.typeError }] : [])
    const comparison = state.model ? { caseSensitive: state.model.caseSensitiveNames, accentSensitive: state.model.accentSensitiveNames } : undefined
    const problems = [...typeProblems, ...designProblems(design, state.model?.band, comparison).filter(problem => !(problem.property === 'dataType' && rows[problem.column ?? -1]?.typeError))]
      .sort((a, b) => (a.column ?? -1) - (b.column ?? -1))
      .map(problem => ({ ...problem, row: rowOf(problem.column) }))
    return { design, problems }
  }

  // --- Save, script and Stop ---------------------------------------------------------------------------------------------

  /** File › Save: one at a time per designer (a second Save waits for the first); never re-sent. */
  save(id: string): Promise<boolean> {
    const running = this.saving.get(id)
    if (running) return running
    const promise = this.runSave(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => { this.saving.delete(id); this.publishContext() })
    this.saving.set(id, promise)
    return promise
  }
  private async runSave(id: string): Promise<boolean> {
    this.commitEditor(id)
    let state = this.get(id)
    if (!state) return false
    if (state.phase === 'saved') return true
    if (state.phase !== 'ready') return false
    if (!this.live(id)) { this.patch(id, { error: designerStrings.disconnected }); return false }
    if (!this.refuse(id)) return false
    if (!state.nameChosen) {
      const chosen = await this.ask(id, state.name)
      state = this.get(id)
      if (chosen === undefined || !state || state.phase !== 'ready') return false
      this.patch(id, { name: chosen, nameChosen: true })
      this.caption(id)
      if (!this.refuse(id)) return false
      state = this.get(id)!
    }
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) { this.patch(id, { error: designerStrings.disconnected }); return false }
    const { design } = TableDesignerService.design(state)
    const requestId = this.begin(id, 'save'), request = this.requests.get(id)
    this.patch(id, { phase: 'saving', error: undefined, notice: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ action: 'createTable', connectionId, requestId, target: { kind: 'database', name: state.database }, design }))
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    // A disconnect while it ran has already said the outcome is unknown.
    if (this.disposed || !this.get(id) || request?.dropped) return false
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      const label = `${design.schema}.${design.name}`
      this.patch(id, { phase: 'saved', dirty: false, error: undefined, notice: designerStrings.saved(label), selected: [] })
      this.options.documents.setDirty(id, false)
      if (state.folderNodeId !== undefined) {
        try { this.options.explorer.refreshAndSelect(state.folderNodeId, { type: 'object', object: { kind: 'table', database: state.database, schema: design.schema, name: design.name } }) }
        catch (failure) { onUnexpectedError(failure) }
      }
      return true
    }
    const message = value?.error?.code === 'CANCELLED' ? designerStrings.stopped
      : !result.ok && result.code === 'CANCELLED' ? designerStrings.stoppedUnknown
        : !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST') ? unknownOutcomeMessage
          : value?.error?.message ?? error(result) ?? 'The table could not be saved.'
    this.patch(id, { phase: 'ready', error: message })
    this.show(id)
    return false
  }
  /** The first problem refuses Save or Generate Change Script: it shows, and its cell becomes current. */
  private refuse(id: string): boolean {
    const state = this.get(id)
    if (!state) return false
    if (!TableDesignerService.columnRows(state).length) { this.patch(id, { error: designerStrings.noColumns }); this.show(id); return false }
    const first = TableDesignerService.design(state).problems[0]
    if (!first) return true
    const column: DesignerColumn = first.property === 'dataType' || first.property === 'identity' ? 'type' : first.property === 'allowNulls' ? 'nulls' : 'name'
    this.patch(id, { error: first.message, ...first.row !== undefined ? { current: { row: first.row, column } } : {}, ...first.property === 'tableName' || first.property === 'schema' ? { propertiesVisible: true } : {} })
    this.show(id)
    this.options.focus?.(id)
    return false
  }
  /** Generate Change Script…: the script Save would run, in SSMS's Save Change Script dialog. */
  async generateScript(id: string): Promise<void> {
    if (this.canEdit(id) && !this.get(id)?.scripting) this.commitEditor(id)
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId || !this.canEdit(id) || state.scripting) return
    if (!this.live(id)) { this.patch(id, { error: designerStrings.disconnected }); return }
    if (!this.refuse(id)) return
    const { design } = TableDesignerService.design(state)
    const requestId = this.begin(id, 'script')
    this.patch(id, { scripting: true, error: undefined })
    const result = await this.call(() => this.options.api.scriptObjectAction({ action: 'createTable', connectionId, requestId, target: { kind: 'database', name: state.database }, design }))
    if (!this.end(id, requestId)) { this.patch(id, { scripting: false }); return }
    const text = result.ok ? result.value.text : undefined
    if (text === undefined) { this.patch(id, { scripting: false, error: (result.ok ? result.value.error?.message : error(result)) ?? 'No script was produced.' }); return }
    this.patch(id, { scripting: false, prompt: { kind: 'script', text, warnings: result.ok ? result.value.warnings : [] } })
  }
  /** Save Change Script's Yes (save it to a file the user picks) or No. */
  async answerScript(id: string, save: boolean): Promise<void> {
    const state = this.get(id), prompt = state?.prompt
    if (!state || prompt?.kind !== 'script') return
    this.patch(id, { prompt: undefined })
    this.options.focus?.(id)
    if (save) await this.options.files.saveCopy(`${state.name}.sql`, prompt.text)
  }
  /** Choose Name's OK (with the name) or Cancel (undefined). A name that is not a sysname keeps the dialog open. */
  answerName(id: string, value: string | undefined): void {
    const state = this.get(id), resolve = this.prompts.get(id)
    if (!state || state.prompt?.kind !== 'chooseName' || !resolve) return
    if (value !== undefined) {
      const parsed = ident.safeParse(value)
      const problem = value === '' ? 'Enter a name for the table.' : !parsed.success ? parsed.error.issues[0]?.message ?? 'The name is not valid.' : tableNameProblem(value)
      if (problem) { this.patch(id, { prompt: { kind: 'chooseName', value, error: problem } }); return }
    }
    this.prompts.delete(id)
    this.patch(id, { prompt: undefined })
    this.options.focus?.(id)
    resolve(value)
  }
  private ask(id: string, value: string): Promise<string | undefined> {
    return new Promise(resolve => {
      this.prompts.get(id)?.(undefined)
      this.prompts.set(id, resolve)
      this.patch(id, { prompt: { kind: 'chooseName', value } })
      this.show(id)
    })
  }
  /** Stop: cancels the designer's save in SQL Server (the active one, else every one saving). */
  stop(id?: string): void {
    const ids = id && this.requests.get(id)?.kind === 'save' ? [id] : [...this.requests].filter(([, request]) => request.kind === 'save').map(([key]) => key)
    this.cancel(ids.flatMap(key => { const request = this.requests.get(key); return request ? [request.id] : [] }))
  }
  get anySaving(): boolean { return [...this.requests.values()].some(request => request.kind === 'save') }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  canClose(id: string): string | undefined { return this.get(id)?.phase === 'saving' ? designerStrings.saving : undefined }
  revision(id: string): number { return this.get(id)?.revision ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** A designer stays bound to the server it was opened on (its caption names it), as SSMS's is: a reconnect moves it only
   *  to a connection to that same server. */
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  /** The grid's cell editor registers here while it is mounted. */
  registerEditor(id: string, commit: () => void): Disposable {
    this.editors.set(id, commit)
    return { dispose: () => { if (this.editors.get(id) === commit) this.editors.delete(id) } }
  }
  private commitEditor(id: string): void {
    try { this.editors.get(id)?.() } catch (failure) { onUnexpectedError(failure) }
  }
  closed(id: string): void {
    const request = this.requests.get(id)
    if (request) { this.requests.delete(id); this.cancel([request.id]) }
    this.prompts.get(id)?.(undefined)
    this.prompts.delete(id)
    this.editors.delete(id)
    this.publish({ designers: Object.fromEntries(Object.entries(this.getSnapshot().designers).filter(([key]) => key !== id)) })
    this.publishContext()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.prompts.values()) resolve(undefined)
    this.prompts.clear()
    this.cancel([...this.requests.values()].map(request => request.id))
    this.requests.clear()
    this.registration.dispose()
    this.unsubscribe()
    this.clearListeners()
    this.contextStore.clear()
  }

  // --- Internals ---------------------------------------------------------------------------------------------------------

  private newRow(name: string): DesignerRow { return { key: ++this.rowKeys, name, allowNulls: true, ...this.typed(formatTypeText(defaultNewType)) } }
  private typed(text: string, band?: number): Pick<DesignerRow, 'typeText' | 'type' | 'typeError'> {
    if (text.trim() === '') return { typeText: '', type: undefined, typeError: 'Choose a data type.' }
    const parsed = parseTypeText(text, band)
    return 'type' in parsed ? { typeText: formatTypeText(parsed.type), type: parsed.type, typeError: undefined } : { typeText: text, type: undefined, typeError: parsed.problem }
  }
  private replaceRow(id: string, index: number, row: DesignerRow): void {
    const state = this.get(id)
    if (!state) return
    // A type that cannot be an identity drops it, as SSMS greys (Is Identity) for it.
    const next = row.identity && row.type && !identityAllowed(row.type) ? { ...row, identity: undefined } : row
    this.edit(id, { rows: state.rows.map((item, at) => at === index ? next : item) })
  }
  /** An edit: the revision moves and the designer is dirty (the empty last row alone never is). */
  private edit(id: string, patch: Partial<DesignerState>): void {
    const state = this.get(id)
    if (!state) return
    this.patch(id, { ...patch, revision: state.revision + 1, dirty: true, error: undefined })
    this.options.documents.setDirty(id, true)
  }
  private patch(id: string, patch: Partial<DesignerState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as DesignerState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: DesignerState): void {
    this.publish({ designers: { ...this.getSnapshot().designers, [state.id]: state } })
    this.publishContext()
  }
  /** Only the active designer renders: Save All and the close prompts save designers in the background, and one that
   *  needs the user (Choose Name, a problem, a failure) comes forward rather than waiting unseen while they hold the task. */
  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private caption(id: string): void {
    const state = this.get(id)
    if (state) this.options.documents.update(id, { name: designerCaption(state.server, state.database, state.schema, state.name) })
  }
  private publishContext(): void {
    const byDocument: Record<string, DesignerKeys> = {}
    for (const state of Object.values(this.getSnapshot().designers)) {
      const targets = this.targets(state)
      byDocument[state.id] = {
        editable: state.phase === 'ready' && this.live(state.id), rowSelected: targets.length > 0,
        keyRemovable: targets.length > 0 && targets.every(row => state.primaryKey.includes(row.key))
      }
    }
    this.contextStore.set({ byDocument, saving: this.anySaving })
  }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return !!connectionId && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  private begin(id: string, kind: 'describe' | 'script' | 'save'): string {
    const requestId = this.newId()
    this.requests.set(id, { id: requestId, kind, dropped: false })
    this.publishContext()
    return requestId
  }
  /** Whether an answer still matters: its designer is open and the request was not dropped. */
  private end(id: string, requestId: string): boolean {
    const request = this.requests.get(id)
    if (request?.id === requestId) this.requests.delete(id)
    this.publishContext()
    return !this.disposed && !!this.get(id) && request?.id === requestId && !request.dropped
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  /** A server that disconnects: a running save's outcome is unknown, and its request is cancelled in the backend. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().designers)) {
      if (this.live(state.id)) continue
      const request = this.requests.get(state.id)
      if (request && !request.dropped) {
        request.dropped = true
        this.requests.delete(state.id)
        this.cancel([request.id])
        if (request.kind === 'save') this.patch(state.id, { phase: 'ready', error: unknownOutcomeMessage })
        else if (request.kind === 'describe') this.patch(state.id, { phase: 'loadFailed', error: designerStrings.disconnected })
        else this.patch(state.id, { scripting: false })
      }
    }
    this.publishContext()
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}

/** What a press on a row selector does, as the results grid decides (grid/selection.ts' pressButton): on macOS
 *  Control+click opens the menu (a secondary press, which keeps a selected row's selection) and ⌘ adds; elsewhere Ctrl adds. */
export function selectorPress(event: { readonly button: number; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }, platform: Platform, selected: boolean): 'single' | 'toggle' | 'range' | undefined {
  const press = pressButton(event, platform)
  if (!press || (press === 'secondary' && selected)) return undefined
  if (press === 'secondary') return 'single'
  return event.shiftKey ? 'range' : (platform === 'darwin' ? event.metaKey : event.ctrlKey) ? 'toggle' : 'single'
}

/** Whether a type takes each parameter, for Column Properties' Length, Precision and Scale rows. */
export function parameterRows(type: DesignType | undefined): { readonly length: boolean; readonly precision: boolean; readonly scale: boolean } {
  const params = type ? typeSpec(type.system)?.params : undefined
  return { length: params === 'length' || params === 'nlength', precision: params === 'precisionScale', scale: params === 'precisionScale' || params === 'scale' }
}
