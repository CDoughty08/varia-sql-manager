import { useState } from 'react'
import { dialogSpecs, type PageId } from '../../../shared/actions/catalog.ts'
import { autogrowthText, fileTypeLabel, notApplicable, optionDef, type DatabaseOptionDef } from '../../../shared/actions/database.ts'
import type { DatabaseFilegroup, DatabasePropertiesModel } from '../../../shared/actions/schema.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { draftValue, greyNotes, modelValue, optionChoices, optionGroups, optionState, ownerState, setOption, type DatabaseDraft } from '../dialogs/database-properties'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { FactList, FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import { databaseStatusPill, dateText, fieldControl, megabytes, problemSections, switchStates } from './fields'
import type { DatabasePropertiesService, PropertiesState } from './DatabasePropertiesService'

/** The DOM id prefix of a document's fields, so two open documents never share one. */
const fieldId = (documentId: string, key: string) => `properties-${documentId}-${key}`
/** The header fields above the other options, in SSMS's order: Collation, Recovery model, Compatibility level, Containment type. */
const headerKeys = ['collation', 'recoveryModel', 'compatibilityLevel', 'containmentType']

export interface SectionProps {
  readonly state: PropertiesState
  readonly model: DatabasePropertiesModel
  readonly draft: DatabaseDraft
  readonly editable: boolean
  readonly errors: ReadonlyMap<string, string>
  readonly service: DatabasePropertiesService
}

/** Learn's General page rows, as facts. */
function GeneralSection({ model }: Pick<SectionProps, 'model'>) {
  const general = model.general
  const fact = (label: string, value: string, title?: string) => ({ label, value, ...title ? { title } : {} })
  return <div className="properties-general">
    <h3 className="properties-group-title">Backup</h3>
    <FactList facts={[fact('Last Database Backup', dateText(general.lastBackup)), fact('Last Database Log Backup', dateText(general.lastLogBackup))]} />
    <h3 className="properties-group-title">Database</h3>
    <FactList facts={[
      fact('Name', displayText(general.name)), fact('Status', databaseStatusPill(model).label), fact('Owner', general.owner ? displayText(general.owner) : '', 'The owner can be changed in Files.'),
      fact('Date Created', dateText(general.created)), fact('Size', megabytes(general.sizeMb)), fact('Space Available', megabytes(general.spaceAvailableMb)),
      fact('Number of Users', general.users === undefined ? '' : String(general.users)),
      fact('Memory Allocated To Memory Optimized Objects', megabytes(general.memoryAllocatedMb), 'Needs VIEW DATABASE STATE.'),
      fact('Memory Used By Memory Optimized Objects', megabytes(general.memoryUsedMb), 'Needs VIEW DATABASE STATE.')
    ]} />
    <h3 className="properties-group-title">Maintenance</h3>
    <FactList facts={[fact('Collation', general.collation ?? '', 'The collation can be changed in Options.')]} />
  </div>
}

/** "Select Database Owner": the server's logins in a list, as SSMS's browse button offers them (a small modal picker). */
function SelectOwner({ logins, current, onOk, onCancel }: { logins: readonly string[]; current: string; onOk(login: string): void; onCancel(): void }) {
  const [chosen, setChosen] = useState(logins.includes(current) ? current : logins[0] ?? '')
  return <SubDialog title="Select Database Owner" okDisabled={!chosen} onOk={() => onOk(chosen)} onCancel={onCancel} initialFocus="database-owner-list">
    <label htmlFor="database-owner-list">Logins:</label>
    <select id="database-owner-list" className="database-owner-list" size={12} value={chosen} onChange={event => setChosen(event.target.value)} onDoubleClick={() => chosen && onOk(chosen)}>
      {logins.map(login => <option key={login} value={login}>{displayText(login)}</option>)}
    </select>
  </SubDialog>
}

/**
 * Files: the name and full-text indexing as facts, the Owner (typed, suggested, or chosen in Select Database Owner), and
 * the files. The facts and the field are separate groups, so their two label styles read as two kinds of row.
 */
export function FilesSection({ state, model, draft, editable, errors, service }: SectionProps) {
  const [choosing, setChoosing] = useState(false)
  const owner = ownerState(model, state.target), id = fieldId(state.id, 'owner'), disabled = !editable || owner.disabled
  const note = owner.note && owner.note !== model.readOnlyReason && owner.note !== greyNotes.readOnlyDatabase ? owner.note : undefined
  const changed = draft.owner !== (model.general.owner ?? ''), text = { note, error: errors.get('owner') }
  return <div className="properties-files">
    <h3 className="properties-group-title">Database</h3>
    <FactList facts={[{ label: 'Database name', value: displayText(model.general.name) }, { label: 'Use full-text indexing', value: 'Always on (since SQL Server 2008)' }]} />
    <h3 className="properties-group-title">Ownership</h3>
    <PropertyField id={id} label="Owner" changed={changed} {...text}>
      <span className="properties-owner">
        <input id={id} className="property-input" type="text" list={`${id}-logins`} maxLength={128} spellCheck={false} value={draft.owner} disabled={disabled}
          data-changed={changed || undefined} {...fieldAria(id, { ...text, changed })} onChange={event => service.updateDraft(state.id, { owner: event.target.value })} />
        <datalist id={`${id}-logins`}>{model.logins.map(login => <option key={login} value={login} />)}</datalist>
        <button type="button" className="property-browse" aria-label="Browse for the owner" title="Browse for the owner" disabled={disabled || model.logins.length === 0} onClick={() => setChoosing(true)}>…</button>
      </span>
    </PropertyField>
    <h3 className="properties-group-title" id={`${state.id}-files-grid`}>Database files</h3>
    <div className="properties-table">
      <table className="object-dialog-grid" aria-labelledby={`${state.id}-files-grid`}>
        <thead><tr><th scope="col">Logical Name</th><th scope="col" data-wrap="never">File Type</th><th scope="col">Filegroup</th><th scope="col" data-wrap="never">Size (MB)</th><th scope="col">Autogrowth / Maxsize</th><th scope="col">Path</th><th scope="col">File Name</th></tr></thead>
        <tbody>{model.files.map(file => <tr key={file.name}>
          <td><bdi>{displayText(file.name)}</bdi></td><td data-wrap="never">{fileTypeLabel[file.type]}</td><td><bdi>{file.type === 'log' ? notApplicable : displayText(file.filegroup ?? '')}</bdi></td>
          <td data-wrap="never">{file.type === 'filestream' ? '' : file.sizeMb.toLocaleString()}</td><td>{autogrowthText(file.growth, file.type)}</td><td data-wrap="anywhere"><bdi>{displayText(file.path)}</bdi></td><td><bdi>{displayText(file.fileName)}</bdi></td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="field-note">{model.filesTruncated ? 'The database has more files than are listed. ' : ''}Adding, removing and resizing files is not supported yet.</p>
    {choosing && <SelectOwner logins={model.logins} current={draft.owner} onCancel={() => setChoosing(false)} onOk={login => { setChoosing(false); service.updateDraft(state.id, { owner: login }) }} />}
  </div>
}

/** Filegroups: SSMS's Rows, FILESTREAM and Memory Optimized Data lists, read-only in this version, flags as words. */
function FilegroupsSection({ state, model }: Pick<SectionProps, 'state' | 'model'>) {
  const of = (type: DatabaseFilegroup['type']) => model.filegroups.filter(row => row.type === type)
  const headers = { readOnly: 'Read-Only', isDefault: 'Default', autogrowAllFiles: 'Autogrow All Files' } as const
  const yes = (value: boolean | undefined) => value ? 'Yes' : 'No'
  const table = (key: string, title: string, rows: readonly DatabaseFilegroup[], columns: readonly (keyof typeof headers)[], note?: string) => {
    const id = `${state.id}-filegroups-${key}`
    return <div className="properties-filegroups-group" key={key}>
      <h3 className="properties-group-title" id={id}>{title}</h3>
      {note && <p className="field-note">{note}</p>}
      {rows.length === 0 ? <p className="field-note">None.</p> : <div className="properties-table">
        <table className="object-dialog-grid" aria-labelledby={id}>
          <thead><tr><th scope="col">Name</th><th scope="col">{key === 'rows' ? 'Files' : 'FILESTREAM Files'}</th>{columns.map(column => <th key={column} scope="col">{headers[column]}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.name}><td><bdi>{displayText(row.name)}</bdi></td><td data-wrap="never">{row.files}</td>{columns.map(column => <td key={column} data-wrap="never">{yes(row[column])}</td>)}</tr>)}</tbody>
        </table>
      </div>}
    </div>
  }
  return <div className="properties-filegroups">
    {table('rows', 'Rows', of('rows'), model.server.level >= 13 ? ['readOnly', 'isDefault', 'autogrowAllFiles'] : ['readOnly', 'isDefault'])}
    {table('filestream', 'FILESTREAM', of('filestream'), ['readOnly', 'isDefault'], model.server.filestreamLevel === 0 ? greyNotes.filestream : undefined)}
    {table('memory', 'Memory Optimized Data', of('memoryOptimized'), [])}
    <p className="field-note">{model.filegroupsTruncated ? 'The database has more filegroups than are listed. ' : ''}Adding, removing and changing filegroups is not supported yet.</p>
  </div>
}

/** One option as its field: a fact (plain text, never a live region), a switch, a segmented control, a list, or a number field. */
export function OptionField({ def, state, model, draft, editable, errors, service }: SectionProps & { readonly def: DatabaseOptionDef }) {
  const id = fieldId(state.id, def.key), control = fieldControl(def)
  const value = draftValue(draft, def) ?? '', changed = value !== (modelValue(model, def) ?? '')
  const greyed = optionState(def, model, draft, state.target)
  // The notes every row would share (a read-only database) show once, at the top of the section.
  const note = greyed.note && greyed.note !== model.readOnlyReason && greyed.note !== greyNotes.readOnlyDatabase ? greyed.note : undefined
  const text = { description: def.description, note, error: errors.get(def.key) }
  const disabled = !editable || greyed.disabled, aria = fieldAria(id, { ...text, changed })
  const change = (next: string) => service.updateDraft(state.id, setOption(draft, def.key, next))
  const choices = optionChoices(def, model)
  if (control === 'fact') {
    const shown = choices.find(choice => choice.value === value)?.label ?? value
    // A stop of its own, as SSMS's read-only grid rows can be selected: focus shows its description in the hint strip, and
    // a screen reader hears its label, value and description (read-only text, never a live region).
    return <PropertyField id={id} label={def.label} labelFor={false} description={def.description}>
      <span id={id} className="property-value" role="textbox" aria-readonly="true" tabIndex={0} aria-labelledby={`${id}-label`} {...fieldAria(id, { description: def.description })}>{shown || '—'}</span>
    </PropertyField>
  }
  return <PropertyField id={id} label={def.label} changed={changed} labelFor={control !== 'segmented'} {...text}>
    {control === 'switch' && <Switch id={id} checked={value === 'true'} disabled={disabled} changed={changed} states={switchStates(def)} {...aria} onChange={checked => change(checked ? 'true' : 'false')} />}
    {control === 'segmented' && <Segmented id={id} labelledBy={`${id}-label`} segments={choices} value={value} disabled={disabled} changed={changed} {...aria} onChange={change} />}
    {control === 'select' && <select id={id} className="property-input" value={value} disabled={disabled} data-changed={changed || undefined} {...aria} onChange={event => change(event.target.value)}>
      {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>}
    {control === 'integer' && <input id={id} className="property-input" type="number" step={1} min={def.range?.min} max={def.range?.max} value={value} disabled={disabled} data-changed={changed || undefined} {...aria}
      onChange={event => change(event.target.value)} />}
    {control === 'combo' && <>
      <input id={id} className="property-input" type="text" list={`${id}-list`} value={value} disabled={disabled} data-changed={changed || undefined} spellCheck={false} {...aria} onChange={event => change(event.target.value)} />
      <datalist id={`${id}-list`}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</datalist>
    </>}
  </PropertyField>
}

/** Options: the four header fields, then SSMS's categories, each under its own heading. */
function OptionsSection(props: SectionProps) {
  const { state, model } = props
  const header = headerKeys.map(key => optionDef(key)!)
  return <div className="properties-options">
    <div className="properties-fields">{header.map(def => <OptionField key={def.key} def={def} {...props} />)}</div>
    {optionGroups(model).map(group => {
      const heading = `${state.id}-options-${group.category.replaceAll(' ', '-')}`
      return <div key={group.category} className="properties-group" role="group" aria-labelledby={heading}>
        <h3 className="properties-group-title" id={heading}>{group.category}</h3>
        <div className="properties-fields">{group.defs.map(def => <OptionField key={def.key} def={def} {...props} />)}</div>
      </div>
    })}
  </div>
}

/**
 * Database Properties as a document (U1 D2, Calm Pro's property sheets): the header (where the database is, its state,
 * Refresh, Discard Changes and Apply), what the last action said, SSMS's pages as sections with their list, and the
 * Script drawer, which previews what Apply would run. Its service keeps the draft and the frame, so switching tabs loses
 * nothing.
 */
export default function DatabaseProperties({ documentId }: { documentId: string }) {
  const { properties } = useWorkbench()
  const { documents } = useServiceSnapshot(properties)
  const state = documents[documentId]
  if (!state) return <div className="database-properties" />
  const { model, draft } = state
  const editable = properties.canEdit(state.id), errors = properties.errors(state.id), problems = problemSections(errors)
  const args = { tabId: state.id }
  const verbs: Verb[] = state.phase === 'applying'
    ? [{ command: 'databaseProperties.stop', args, emphasis: 'danger' }]
    : [{ command: 'databaseProperties.refresh', args }, { command: 'databaseProperties.discard', args }, { command: 'databaseProperties.apply', args, label: 'Apply', emphasis: 'primary' }]
  const pill = model ? databaseStatusPill(model) : undefined
  const phaseLabel = state.phase === 'loading' ? 'Reading the database…' : state.phase === 'applying' ? 'Applying the changes…' : state.phase === 'confirming' ? 'Waiting for your answer…' : undefined
  const content = (page: PageId) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the database" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the database could not be read.' : ''}</p>
    const props: SectionProps = { state, model, draft, editable, errors, service: properties }
    switch (page) {
      case 'general': return <GeneralSection model={model} />
      case 'files': return <FilesSection {...props} />
      case 'filegroups': return <FilegroupsSection state={state} model={model} />
      case 'options': return <OptionsSection {...props} />
    }
  }
  const sections: FrameSection[] = dialogSpecs.databaseProperties.pages.map(page => ({ id: page.id, title: page.title, problem: problems.has(page.id), content: content(page.id) }))
  const stopped = state.error?.code === 'CANCELLED'
  // The way out the message names: Refresh, or, while the draft whose outcome is unknown still holds changes, Discard Changes first.
  // NOT_FOUND: the database went, or another has taken its name since it was read, so what is shown must be read again.
  const reread = state.stale || state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND'
  const recovery = reread && properties.canRefresh(state.id) ? [{ label: 'Refresh', run: () => properties.refresh(state.id) }]
    : reread && properties.canDiscard(state.id) ? [{ label: 'Discard Changes', run: () => properties.discard(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} role={stopped ? 'status' : 'alert'} context={`Database Properties - ${state.label} on ${state.server}`}
      actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnlyReason && <p className="document-status"><Icon name="lock" />{model.readOnlyReason}</p>}
    {model && !model.readOnlyReason && model.options.readOnly === 'true' && <p className="document-status"><Icon name="lock" />{greyNotes.readOnlyDatabase}</p>}
  </>
  return <FieldHints><DocumentFrame id={`properties-${state.id}`} title={state.label} subtitle="Database Properties" crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'Databases' }]}
    state={pill && <StatusPill tone={pill.tone} label={pill.label} size="small" />} verbs={verbs} banner={banner} sections={sections} frame={state.frame}
    onFrame={frame => properties.setFrame(state.id, frame)} attributes={{ 'data-properties': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void properties.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
