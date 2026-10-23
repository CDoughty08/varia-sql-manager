import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { columnPropertySpecs, designerCommandEntries, designerStrings, designerToolbar, tablePropertySpecs, type DesignerCommandId } from '../../../shared/designer/catalog.ts'
import { identityAllowed, parseTypeText } from '../../../shared/designer/type-text.ts'
import { useCommandsEnabled, useKeybindingLabel } from '../core/useCommand'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import PropertyGrid, { type GridGroup, type GridRow } from '../settings/PropertyGrid'
import DesignerGrid, { typeChoices } from './DesignerGrid'
import { parameterRows, type DesignerRow, type DesignerState, type TableDesignerService } from './TableDesignerService'

const yesNo = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] as const
const commands = designerCommandEntries()
const spec = (id: string) => columnPropertySpecs.find(item => item.id === id)!
const tableSpec = (id: string) => tablePropertySpecs.find(item => item.id === id)!

/** The parameter a type text holds, as typed, while it names no type yet (Length shows what is being typed). */
function parameter(row: DesignerRow, property: 'length' | 'precision' | 'scale'): string {
  const type = row.type
  if (type) return property === 'length' ? type.max ? 'MAX' : String(type.length ?? '') : String(type[property] ?? '')
  const inside = /\(([^)]*)\)?\s*$/.exec(row.typeText)?.[1]?.split(',') ?? []
  return (property === 'scale' && inside.length > 1 ? inside[1] : inside[0] ?? '').trim()
}

/** Column Properties for a row: General, then Table Designer's Identity Specification, as SSMS groups them. */
export function columnGroups(state: DesignerState, row: DesignerRow | undefined, editable: boolean, locked: boolean): GridGroup[] {
  if (!row) return []
  const system = row.type?.system ?? /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(row.typeText)?.[1]?.toLowerCase()
  // While the text names no type (a length being typed), the name it starts with still decides the parameter rows.
  const named = system ? parseTypeText(system) : undefined
  const params = parameterRows(row.type ?? (named && 'type' in named ? named.type : undefined))
  const base = (id: string, control: GridRow['control'], value: string, disabled = !editable, extra: Partial<GridRow> = {}): GridRow =>
    ({ key: id, label: spec(id).label, description: spec(id).description, control, value, changed: false, disabled, ...spec(id).parent ? { parent: spec(id).parent } : {}, ...extra })
  const identityOk = !!row.type && identityAllowed(row.type)
  const general = [
    base('name', 'text', row.name),
    base('allowNulls', 'choice', row.allowNulls ? 'Yes' : 'No', !editable || locked, { choices: yesNo }),
    base('dataType', 'combo', row.typeText, !editable, { choices: typeChoices.map(choice => ({ value: choice, label: choice })) }),
    ...params.length ? [base('length', 'text', parameter(row, 'length'))] : [],
    ...params.precision ? [base('precision', 'text', parameter(row, 'precision'))] : [],
    ...params.scale ? [base('scale', 'text', parameter(row, 'scale'))] : []
  ]
  const identity = [
    base('identitySpecification', 'readonly', row.identity ? 'Yes' : 'No', true, { expanded: state.identityExpanded }),
    base('isIdentity', 'choice', row.identity ? 'Yes' : 'No', !editable || (!identityOk && !row.identity), { choices: yesNo }),
    base('identityIncrement', 'text', row.identity?.increment ?? '', !editable || !row.identity),
    base('identitySeed', 'text', row.identity?.seed ?? '', !editable || !row.identity)
  ]
  return [{ label: 'General', rows: general }, { label: 'Table Designer', rows: identity }]
}

function Toolbar({ state }: { state: DesignerState }) {
  const { commands: service } = useWorkbench()
  const removable = useCommandsEnabled([{ id: 'tableDesigner.removePrimaryKey' }])[0]
  const ids: DesignerCommandId[] = designerToolbar.map(id => id === 'tableDesigner.setPrimaryKey' && removable ? 'tableDesigner.removePrimaryKey' : id)
  const enabled = useCommandsEnabled(ids.map(id => ({ id, args: { tabId: state.id } })))
  const properties = useKeybindingLabel('tableDesigner.properties')
  return <div className="table-designer-toolbar" role="toolbar" aria-label="Table Designer">
    {ids.map((id, index) => <button key={id} className="icon-button" aria-label={commands[id].title} title={commands[id].title} disabled={!enabled[index]}
      onClick={() => void service.execute(id, { tabId: state.id }, 'toolbar')}>{commands[id].icon && <Icon name={commands[id].icon} />}</button>)}
    <span className="toolbar-divider" />
    <button className="icon-button" aria-label="Properties" aria-pressed={state.propertiesVisible} title={properties ? `Properties (${properties.text})` : 'Properties'}
      onClick={() => void service.execute('tableDesigner.properties', { tabId: state.id }, 'toolbar')}><Icon name="settings-gear" /></button>
  </div>
}

/**
 * A table designer document: the toolbar strip, the error or saved bar, the column grid, the splitter, Column Properties,
 * and the Properties panel (F4) on the right. Choose Name and Save Change Script open over it.
 */
export default function TableDesigner({ documentId }: { documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.designers
  const { designers } = useServiceSnapshot(service)
  useServiceSnapshot(service.context)
  const state = designers[documentId]
  const [split, setSplit] = useState(0.55)
  const [focusedProperty, setFocusedProperty] = useState<string>()
  const content = useRef<HTMLDivElement | null>(null)
  const row = state ? state.rows[state.current.row] : undefined
  const editable = !!state && service.canEdit(state.id)
  const columnRows = useMemo(() => state ? columnGroups(state, row, editable, !!row && service.nullsLocked(state, row)) : [], [state, row, editable, service])
  if (!state) return <div className="table-designer" />
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = content.current?.getBoundingClientRect()
    if (!box) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const moveTo = (y: number) => setSplit(Math.min(0.85, Math.max(0.15, (y - box.top) / box.height)))
    const target = event.currentTarget
    const moveHandler = (moved: PointerEvent) => moveTo(moved.clientY)
    const up = () => { target.removeEventListener('pointermove', moveHandler); target.removeEventListener('pointerup', up) }
    target.addEventListener('pointermove', moveHandler)
    target.addEventListener('pointerup', up)
  }
  const splitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit(value => Math.min(0.85, Math.max(0.15, value + (event.key === 'ArrowUp' ? -0.05 : 0.05)))) }
  }
  const identity = state.rows.find(item => item.identity)
  const tableGroups: GridGroup[] = [
    { label: '(Identity)', rows: [
      { key: 'tableName', label: tableSpec('tableName').label, description: tableSpec('tableName').description, control: 'text', value: state.name, changed: false, disabled: !editable },
      { key: 'databaseName', label: tableSpec('databaseName').label, description: tableSpec('databaseName').description, control: 'readonly', value: state.database, changed: false, disabled: true },
      { key: 'schema', label: tableSpec('schema').label, description: tableSpec('schema').description, control: 'choice', value: state.schema, changed: false, disabled: !editable || !state.model,
        choices: (state.model?.schemas.includes(state.schema) ? state.model.schemas : [state.schema, ...state.model?.schemas ?? []]).map(schema => ({ value: schema, label: schema })) },
      { key: 'serverName', label: tableSpec('serverName').label, description: tableSpec('serverName').description, control: 'readonly', value: state.server, changed: false, disabled: true }
    ] },
    { label: 'Table Designer', rows: [
      { key: 'identityColumn', label: tableSpec('identityColumn').label, description: tableSpec('identityColumn').description, control: 'readonly', value: identity?.name ?? '', changed: false, disabled: true },
      { key: 'dataSpace', label: tableSpec('dataSpace').label, description: tableSpec('dataSpace').description, control: 'readonly', value: state.model?.defaultFilegroup ?? '', changed: false, disabled: true }
    ] }
  ]
  const prompt = state.prompt
  return <div className="table-designer" data-designer={state.id}>
    <Toolbar state={state} />
    {state.phase === 'loading' && <div className="table-designer-bar" role="status">Reading the database…</div>}
    {state.phase === 'saving' && <div className="table-designer-bar" role="status">Saving the table… <button onClick={() => void workbench.commands.execute('tableDesigner.stop', { tabId: state.id }, 'toolbar')}>Stop</button></div>}
    {state.error && <div className="table-designer-bar error" role="alert"><span>{state.error}</span>{state.phase !== 'loadFailed' && <button aria-label="Dismiss" onClick={() => service.dismissError(state.id)}><Icon name="close" /></button>}</div>}
    {state.notice && <div className="table-designer-bar info" role="status"><Icon name="info" /><span>{state.notice}</span></div>}
    <div className="table-designer-main">
      <div className="table-designer-content" ref={content}>
        <div className="table-designer-top" style={{ flexBasis: `${split * 100}%` }}>
          {state.phase !== 'loadFailed' && <DesignerGrid state={state} service={service} editable={editable} />}
        </div>
        <div className="table-designer-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize Column Properties" aria-valuenow={Math.round(split * 100)} aria-valuemin={15} aria-valuemax={85}
          tabIndex={0} onPointerDown={drag} onKeyDown={splitterKey} />
        <section className="table-designer-column-properties" aria-label="Column Properties">
          <div className="table-designer-section-head">
            <span>Column Properties</span>
            <button className="icon-button" aria-label="Categorized" aria-pressed={state.order === 'categorized'} title="Categorized" onClick={() => service.setOrder(state.id, 'categorized')}><Icon name="list-tree" /></button>
            <button className="icon-button" aria-label="Alphabetical" aria-pressed={state.order === 'alphabetical'} title="Alphabetical" onClick={() => service.setOrder(state.id, 'alphabetical')}><Icon name="case-sensitive" /></button>
          </div>
          {row ? <PropertyGrid label="Column Properties" groups={columnRows} order={state.order} idPrefix={`${state.id}-column-`} focused={focusedProperty} onFocusRow={setFocusedProperty}
            onToggle={() => service.toggleIdentity(state.id)} onChange={(key, text) => service.setColumnProperty(state.id, state.current.row, key as Parameters<TableDesignerService['setColumnProperty']>[2], text)} />
            : <p className="table-designer-empty">Select a column to see its properties.</p>}
          {focusedProperty && row && <p className="table-designer-description">{columnPropertySpecs.find(item => item.id === focusedProperty)?.description}</p>}
        </section>
      </div>
      {state.propertiesVisible && <aside className="table-designer-properties" aria-label="Properties">
        <div className="table-designer-section-head"><span>Properties</span></div>
        <PropertyGrid label="Properties" groups={tableGroups} idPrefix={`${state.id}-table-`} onFocusRow={() => {}} onChange={(key, text) => service.setTableProperty(state.id, key as 'tableName' | 'schema', text)} />
      </aside>}
    </div>
    {prompt?.kind === 'chooseName' && <ChooseName state={state} service={service} value={prompt.value} error={prompt.error} />}
    {prompt?.kind === 'script' && <SubDialog title={designerStrings.changeScriptTitle} okLabel="Yes" cancelLabel="No" onOk={() => void service.answerScript(state.id, true)} onCancel={() => void service.answerScript(state.id, false)}>
      <p>{designerStrings.changeScriptPrompt}</p>
      {prompt.warnings.map(warning => <p key={warning} className="table-designer-warning">{warning}</p>)}
      <textarea className="table-designer-script" readOnly value={prompt.text} aria-label="Change script" spellCheck={false} rows={14} />
    </SubDialog>}
  </div>
}

function ChooseName({ state, service, value, error }: { state: DesignerState; service: TableDesignerService; value: string; error?: string }) {
  const [text, setText] = useState(value)
  const inputId = `${state.id}-choose-name`
  return <SubDialog title={designerStrings.chooseNameTitle} onOk={() => service.answerName(state.id, text)} onCancel={() => service.answerName(state.id, undefined)} initialFocus={inputId}>
    <label htmlFor={inputId}>{designerStrings.chooseNameLabel}</label>
    <input id={inputId} value={text} onChange={event => setText(event.target.value)} aria-invalid={error ? true : undefined} aria-errormessage={error ? inputId + '-error' : undefined}
      onFocus={event => event.currentTarget.select()} spellCheck={false} />
    {error && <span className="options-field-error" id={inputId + '-error'}>{error}</span>}
  </SubDialog>
}
