import { useState } from 'react'
import { actionLimits, dialogSpecs, type PageId } from '../../../shared/actions/catalog.ts'
import { autogrowthText, fileTypeLabel, notApplicable, optionDef, type Growth } from '../../../shared/actions/database.ts'
import { newDatabaseBaseline, newDatabaseOptionKeys, newDatabaseScopedKeys, primaryFilegroup, type NewDatabaseProblem, type NewFilegroupType, type NewFileType } from '../../../shared/actions/new-database.ts'
import type { DatabasePropertiesModel } from '../../../shared/actions/schema.ts'
import { displayText, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { DatabaseDraft } from '../dialogs/database-properties'
import { greyNotes, optionGroups } from '../dialogs/database-properties'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { FactList, FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StepList from '../kit/StepList'
import Switch from '../kit/Switch'
import { OptionField, SelectOwner } from '../properties/DatabaseProperties'
import { newDatabaseStateProblems, rowFileName, type NewDatabaseService, type NewDatabaseState, type NewFileRow, type NewGroupRow } from './NewDatabaseService'

const fieldId = (documentId: string, key: string) => `new-database-${documentId}-${key}`
/** SSMS's header fields above the other options; Collation and Containment type are CREATE DATABASE's own. */
const headerOptionKeys = ['recoveryModel', 'compatibilityLevel']
const fileTypes: readonly NewFileType[] = ['rows', 'log', 'filestream']
const groupTables: readonly { readonly type: NewFilegroupType; readonly title: string }[] = [
  { type: 'rows', title: 'Rows' }, { type: 'filestream', title: 'FILESTREAM' }, { type: 'memoryOptimized', title: 'Memory Optimized Data' }
]

/** The section each problem marks in the list: the name, owner and files on General, the filegroups on Filegroups, the rest on Options. */
export const newDatabaseProblemSection = (problem: NewDatabaseProblem): PageId =>
  problem.field === 'name' || problem.field === 'owner' || problem.field === 'files' ? 'general' : problem.field === 'filegroups' ? 'filegroups' : 'options'

interface SectionProps {
  readonly state: NewDatabaseState
  readonly editable: boolean
  readonly problems: readonly NewDatabaseProblem[]
  readonly service: NewDatabaseService
}

/** SSMS's Change Autogrowth: Enable Autogrowth, File Growth in percent or megabytes, and Maximum File Size, limited or unlimited. */
export function ChangeAutogrowth({ file, onOk, onCancel }: { readonly file: NewFileRow; onOk(growth: Growth): void; onCancel(): void }) {
  const initial = file.growth
  const [enabled, setEnabled] = useState(initial.enabled)
  const [unit, setUnit] = useState<'mb' | 'percent'>(initial.enabled ? initial.unit : 'mb')
  const [by, setBy] = useState(String(initial.enabled ? initial.by : 64))
  const [limited, setLimited] = useState(initial.enabled && initial.maxMb !== undefined)
  const [max, setMax] = useState(String(initial.enabled && initial.maxMb !== undefined ? initial.maxMb : file.sizeMb ?? 1))
  const ceiling = file.type === 'log' ? actionLimits.logFileMb : actionLimits.dataFileMb
  const whole = (text: string, low: number, high: number) => /^[0-9]{1,10}$/.test(text) && Number(text) >= low && Number(text) <= high
  const growthOk = !enabled || whole(by, 1, unit === 'mb' ? actionLimits.growthMb : actionLimits.growthPercent)
  const maxOk = !enabled || !limited || whole(max, file.sizeMb ?? 1, ceiling)
  const growth = (): Growth => enabled ? { enabled: true, unit, by: Number(by), ...limited ? { maxMb: Number(max) } : {} } : { enabled: false }
  return <SubDialog title={`Change Autogrowth for ${file.name || 'the file'}`} okDisabled={!growthOk || !maxOk} onOk={() => onOk(growth())} onCancel={onCancel} className="new-database-autogrowth">
    <label className="new-database-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enable Autogrowth</label>
    <fieldset className="new-database-fieldset" disabled={!enabled}>
      <legend>File Growth</legend>
      <label className="new-database-check"><input type="radio" name="growth-unit" checked={unit === 'percent'} onChange={() => setUnit('percent')} />In Percent</label>
      <label className="new-database-check"><input type="radio" name="growth-unit" checked={unit === 'mb'} onChange={() => setUnit('mb')} />In Megabytes</label>
      <input className="property-input" type="number" step={1} min={1} max={unit === 'mb' ? actionLimits.growthMb : actionLimits.growthPercent} aria-label={unit === 'mb' ? 'File growth in megabytes' : 'File growth in percent'}
        aria-invalid={!growthOk || undefined} value={by} onChange={event => setBy(event.target.value)} />
    </fieldset>
    <fieldset className="new-database-fieldset" disabled={!enabled}>
      <legend>Maximum File Size</legend>
      <label className="new-database-check"><input type="radio" name="growth-max" checked={limited} onChange={() => setLimited(true)} />Limited to (MB)</label>
      <input className="property-input" type="number" step={1} min={file.sizeMb ?? 1} max={ceiling} aria-label="Maximum file size in megabytes" disabled={!limited} aria-invalid={!maxOk || undefined}
        value={max} onChange={event => setMax(event.target.value)} />
      <label className="new-database-check"><input type="radio" name="growth-max" checked={!limited} onChange={() => setLimited(false)} />Unlimited</label>
    </fieldset>
    {!growthOk && <p className="property-field-error" role="alert"><Icon name="error" />{unit === 'mb' ? `File growth is a whole number of MB from 1 to ${actionLimits.growthMb.toLocaleString()}.` : 'File growth in percent is a whole number from 1 to 100.'}</p>}
    {growthOk && !maxOk && <p className="property-field-error" role="alert"><Icon name="error" />{`The maximum is a whole number of MB from the initial size to ${ceiling.toLocaleString()}.`}</p>}
  </SubDialog>
}

/** A number field's text as the design keeps it: blank as none, otherwise the number (a fraction is a problem, not lost). */
const numberOf = (text: string): number | undefined => text.trim() === '' ? undefined : Number(text)

/** General: the database's name and owner, and its files (SSMS's grid, editable in place). */
function GeneralSection({ state, editable, problems, service }: SectionProps) {
  const model = state.model!
  const [choosing, setChoosing] = useState(false)
  const [autogrowth, setAutogrowth] = useState<number>()
  const [selected, setSelected] = useState<number>()
  const show = state.touched
  const nameId = fieldId(state.id, 'name'), ownerId = fieldId(state.id, 'owner')
  const nameError = show ? problems.find(problem => problem.field === 'name')?.message : undefined
  const ownerError = show ? problems.find(problem => problem.field === 'owner')?.message : undefined
  const fileProblems = problems.filter(problem => problem.field === 'files')
  const cellError = (index: number, column: NewDatabaseProblem['column']) => show && fileProblems.some(problem => problem.file === index && problem.column === column) || undefined
  const growing = state.files.find(row => row.key === autogrowth)
  const linux = model.linux, filestream = !linux && model.model.server.filestreamLevel > 0
  const groupsOf = (type: NewFileType) => state.filegroups.filter(group => type === 'rows' ? group.type === 'rows' : group.type !== 'rows')
  const removable = selected !== undefined && state.files[0]?.key !== selected && state.files.some(row => row.key === selected)
  return <div className="new-database-general">
    <div className="properties-fields">
      <PropertyField id={nameId} label="Database name" error={nameError}>
        <input id={nameId} className="property-input" type="text" maxLength={128} spellCheck={false} autoComplete="off" value={state.name} disabled={!editable} data-new-database-focus
          {...fieldAria(nameId, { error: nameError })} onChange={event => service.setName(state.id, event.target.value)} />
      </PropertyField>
      <PropertyField id={ownerId} label="Owner" error={ownerError} description="The login that owns the database. <default> is the login that creates it.">
        <span className="properties-owner">
          <input id={ownerId} className="property-input" type="text" list={`${ownerId}-logins`} maxLength={128} spellCheck={false} placeholder="<default>" value={state.owner} disabled={!editable}
            {...fieldAria(ownerId, { error: ownerError, description: 'The login that owns the database. <default> is the login that creates it.' })} onChange={event => service.setOwner(state.id, event.target.value)} />
          <datalist id={`${ownerId}-logins`}>{model.model.logins.map(login => <option key={login} value={login} />)}</datalist>
          <button type="button" className="property-browse" aria-label="Browse for the owner" title="Browse for the owner" disabled={!editable || model.model.logins.length === 0} onClick={() => setChoosing(true)}>…</button>
        </span>
      </PropertyField>
    </div>
    <FactList facts={[{ label: 'Use full-text indexing', value: 'Always on (since SQL Server 2008)' }]} />
    <h3 className="properties-group-title" id={`${state.id}-new-files`}>Database files</h3>
    <div className="properties-table new-database-files">
      <table className="object-dialog-grid" aria-labelledby={`${state.id}-new-files`}>
        <thead><tr>
          <th scope="col">Logical Name</th><th scope="col" data-wrap="never">File Type</th><th scope="col">Filegroup</th><th scope="col" data-wrap="never">Initial Size (MB)</th>
          <th scope="col">Autogrowth / Maxsize</th><th scope="col">Path</th><th scope="col">File Name</th>
        </tr></thead>
        <tbody>{state.files.map((row, index) => {
          const primary = index === 0, label = row.name || `File ${index + 1}`, defaultName = rowFileName(state, { ...row, fileName: undefined })
          return <tr key={row.key} data-file-row={index} data-selected={selected === row.key || undefined} onFocus={() => setSelected(row.key)} onClick={() => setSelected(row.key)}>
            <td><input className="new-database-cell" type="text" maxLength={128} spellCheck={false} aria-label={`Logical Name of ${label}`} value={row.name} disabled={!editable} aria-invalid={cellError(index, 'name')}
              onChange={event => service.setFile(state.id, row.key, { name: event.target.value })} /></td>
            <td data-wrap="never">{primary ? fileTypeLabel.rows
              : <select className="new-database-cell" aria-label={`File Type of ${label}`} value={row.type} disabled={!editable} onChange={event => service.setFile(state.id, row.key, { type: event.target.value as NewFileType })}>
                {fileTypes.filter(type => type !== 'filestream' || filestream || row.type === 'filestream').map(type => <option key={type} value={type}>{fileTypeLabel[type]}</option>)}
              </select>}</td>
            <td>{row.type === 'log' ? notApplicable : primary ? primaryFilegroup
              : <select className="new-database-cell" aria-label={`Filegroup of ${label}`} value={row.filegroup ?? ''} disabled={!editable} aria-invalid={cellError(index, 'filegroup')}
                onChange={event => service.setFile(state.id, row.key, { filegroup: event.target.value })}>
                {row.filegroup === undefined && <option value="">&nbsp;</option>}
                {groupsOf(row.type).map(group => <option key={group.key} value={group.name}>{displayText(group.name) || '(unnamed)'}</option>)}
              </select>}</td>
            <td data-wrap="never">{row.type === 'filestream' ? <span className="new-database-muted">Unlimited</span>
              : <input className="new-database-cell new-database-number" type="number" step={1} min={1} max={row.type === 'log' ? actionLimits.logFileMb : actionLimits.dataFileMb} aria-label={`Initial Size (MB) of ${label}`}
                value={row.sizeMb ?? ''} disabled={!editable} aria-invalid={cellError(index, 'size')} onChange={event => service.setFile(state.id, row.key, { sizeMb: numberOf(event.target.value) })} />}</td>
            <td><span className="new-database-browse">
              <span className="new-database-growth">{autogrowthText(row.growth, row.type)}</span>
              {row.type !== 'filestream' && <button type="button" className="property-browse" aria-label={`Change Autogrowth of ${label}`} title="Change Autogrowth" disabled={!editable} aria-invalid={cellError(index, 'growth')}
                onClick={() => setAutogrowth(row.key)}>…</button>}
            </span></td>
            <td data-wrap="anywhere"><span className="new-database-browse">
              <input className="new-database-cell" type="text" spellCheck={false} maxLength={actionLimits.serverPath} aria-label={`Path of ${label}`} value={row.path} disabled={!editable} aria-invalid={cellError(index, 'path')}
                onChange={event => service.setFile(state.id, row.key, { path: event.target.value })} />
              <button type="button" className="property-browse" aria-label={`Browse for the path of ${label}`} title="Browse the server's folders" disabled={!editable} onClick={() => void service.choosePath(state.id, row.key)}>…</button>
            </span></td>
            <td><input className="new-database-cell new-database-file-name" type="text" spellCheck={false} maxLength={actionLimits.serverPath} aria-label={`File Name of ${label}`} placeholder={defaultName}
              value={row.fileName ?? ''} disabled={!editable} aria-invalid={cellError(index, 'fileName')} onChange={event => service.setFile(state.id, row.key, { fileName: event.target.value })} /></td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <div className="new-database-grid-bar">
      <button type="button" disabled={!editable || state.files.length >= actionLimits.newDatabaseFiles} onClick={() => service.addFile(state.id)}>Add</button>
      <button type="button" disabled={!editable || !removable} onClick={() => { if (selected !== undefined) { service.removeFile(state.id, selected); setSelected(undefined) } }}>Remove</button>
      <span className="field-note">{`${state.files.length} of ${actionLimits.newDatabaseFiles} files · paths are on the server ${state.server}`}</span>
    </div>
    {show && fileProblems.length > 0 && <ul className="new-database-problems" aria-label="Problems with the files">
      {fileProblems.map((problem, index) => <li key={index} className="property-field-error"><Icon name="error" />{problem.message}</li>)}
    </ul>}
    {choosing && <SelectOwner logins={model.model.logins} current={state.owner} onCancel={() => setChoosing(false)} onOk={login => { setChoosing(false); service.setOwner(state.id, login) }} />}
    {growing && <ChangeAutogrowth file={growing} onCancel={() => setAutogrowth(undefined)} onOk={growth => { setAutogrowth(undefined); service.setFile(state.id, growing.key, { growth }) }} />}
  </div>
}

/** The model the Options section's fields compare with: model's values (the baseline), as a database that is neither
 *  read-only nor a system one, the options a new database cannot be read with (none: it is new), and its containment. */
function optionModel(state: NewDatabaseState, baseline: { readonly options: Readonly<Record<string, string>>; readonly scoped: Readonly<Record<string, string>> }): DatabasePropertiesModel {
  const model = state.model!.model
  const { readOnlyReason: _readOnly, ...rest } = model
  return { ...rest, server: { ...model.server, sysadmin: true }, options: { ...baseline.options, containmentType: state.containment }, scoped: { ...baseline.scoped } }
}

/** Options: Collation, Recovery model, Compatibility level, Containment type and Ledger, then the options New Database sets. */
function OptionsSection({ state, editable, problems, service, baseline }: SectionProps & { readonly baseline: { readonly options: Readonly<Record<string, string>>; readonly scoped: Readonly<Record<string, string>> } }) {
  const model = optionModel(state, baseline), server = state.model!
  const draft: DatabaseDraft = { options: state.options, scoped: state.scoped, owner: state.owner }
  const target: ObjectRef = { kind: 'database', name: state.name || 'new' }
  const errors = new Map(state.touched ? problems.filter(problem => problem.field === 'options' && problem.key).map(problem => [problem.key!, problem.message]) : [])
  const fields = { documentId: state.id, idPrefix: 'new-database', model, draft, target, editable, errors, onDraft: (next: DatabaseDraft) => service.setOptions(state.id, next) }
  const keys = new Set([...newDatabaseOptionKeys, ...newDatabaseScopedKeys])
  const collationId = fieldId(state.id, 'collation'), containmentId = fieldId(state.id, 'containment'), ledgerId = fieldId(state.id, 'ledger')
  const containmentError = state.touched ? problems.find(problem => problem.field === 'containment')?.message : undefined
  const ledgerError = state.touched ? problems.find(problem => problem.field === 'ledger')?.message : undefined
  const containmentGrey = !server.model.server.containedAuthentication && state.containment !== 'PARTIAL'
  const general = problems.filter(problem => problem.field === 'options' && !problem.key)
  return <div className="properties-options">
    <div className="properties-fields">
      <PropertyField id={collationId} label="Collation" changed={state.collation !== ''} description={optionDef('collation')?.description}>
        <select id={collationId} className="property-input" value={state.collation} disabled={!editable} data-changed={state.collation !== '' || undefined}
          {...fieldAria(collationId, { description: optionDef('collation')?.description, changed: state.collation !== '' })} onChange={event => service.setCollation(state.id, event.target.value)}>
          <option value="">{`<server default> (${server.serverCollation})`}</option>
          {server.model.collations.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </PropertyField>
      {headerOptionKeys.map(key => optionDef(key)!).map(def => <OptionField key={def.key} def={def} {...fields} />)}
      <PropertyField id={containmentId} label="Containment type" labelFor={false} changed={state.containment !== (server.model.options.containmentType === 'PARTIAL' ? 'PARTIAL' : 'NONE')}
        note={containmentGrey ? greyNotes.containment : undefined} error={containmentError}>
        <Segmented id={containmentId} labelledBy={`${containmentId}-label`} segments={[{ value: 'NONE', label: 'None' }, { value: 'PARTIAL', label: 'Partial' }]} value={state.containment}
          disabled={!editable || containmentGrey} {...fieldAria(containmentId, { error: containmentError, note: containmentGrey ? greyNotes.containment : undefined })}
          onChange={value => service.setContainment(state.id, value === 'PARTIAL' ? 'PARTIAL' : 'NONE')} />
      </PropertyField>
      {server.model.server.level >= 16 && <PropertyField id={ledgerId} label="Ledger database" changed={state.ledger} error={ledgerError}
        description="Every table is a ledger table, and the database can never stop being one.">
        <Switch id={ledgerId} checked={state.ledger} disabled={!editable} changed={state.ledger} states={{ on: 'True', off: 'False' }}
          {...fieldAria(ledgerId, { error: ledgerError, changed: state.ledger, description: 'Every table is a ledger table, and the database can never stop being one.' })} onChange={checked => service.setLedger(state.id, checked)} />
      </PropertyField>}
    </div>
    {optionGroups(model).map(group => ({ ...group, defs: group.defs.filter(def => keys.has(def.key)) })).filter(group => group.defs.length > 0).map(group => {
      const heading = `${state.id}-new-options-${group.category.replaceAll(' ', '-')}`
      return <div key={group.category} className="properties-group" role="group" aria-labelledby={heading}>
        <h3 className="properties-group-title" id={heading}>{group.category}</h3>
        <div className="properties-fields">{group.defs.map(def => <OptionField key={def.key} def={def} {...fields} />)}</div>
      </div>
    })}
    {state.touched && general.map((problem, index) => <p key={index} className="property-field-error"><Icon name="error" />{problem.message}</p>)}
  </div>
}

/** Filegroups: SSMS's Rows, FILESTREAM and Memory Optimized Data lists, each with Add Filegroup and Remove. */
function FilegroupsSection({ state, editable, problems, service }: SectionProps) {
  const server = state.model!
  const [selected, setSelected] = useState<number>()
  const level = server.model.server.level
  const groupProblems = problems.filter(problem => problem.field === 'filegroups')
  const filesIn = (group: NewGroupRow) => state.files.filter(row => row.filegroup !== undefined && row.filegroup.toLowerCase() === group.name.toLowerCase()).length
  const table = ({ type, title }: typeof groupTables[number]) => {
    const id = `${state.id}-new-filegroups-${type}`
    const rows = state.filegroups.map((group, index) => ({ group, index })).filter(({ group }) => group.type === type)
    const unavailable = type === 'filestream' ? server.linux ? 'SQL Server on Linux has no FILESTREAM.' : server.model.server.filestreamLevel === 0 ? greyNotes.filestream : undefined : undefined
    const canAdd = editable && !unavailable && state.filegroups.length < actionLimits.newDatabaseFilegroups && !(type === 'memoryOptimized' && rows.length > 0)
    const removable = rows.some(({ group }) => group.key === selected && state.filegroups[0]?.key !== group.key)
    const flag = (group: NewGroupRow, index: number, key: 'readOnly' | 'isDefault' | 'autogrowAllFiles', label: string, disabled: boolean) =>
      <td data-wrap="never"><input type="checkbox" aria-label={`${label} of ${group.name || `filegroup ${index + 1}`}`} checked={group[key]} disabled={!editable || disabled}
        onChange={event => service.setFilegroup(state.id, group.key, { [key]: event.target.checked })} /></td>
    return <div className="properties-filegroups-group" key={type}>
      <h3 className="properties-group-title" id={id}>{title}</h3>
      {unavailable && <p className="field-note">{unavailable}</p>}
      {rows.length > 0 && <div className="properties-table">
        <table className="object-dialog-grid" aria-labelledby={id}>
          <thead><tr>
            <th scope="col">Name</th><th scope="col" data-wrap="never">{type === 'rows' ? 'Files' : 'FILESTREAM Files'}</th>
            {type !== 'memoryOptimized' && <>{type === 'rows' && <th scope="col">Read-Only</th>}<th scope="col">Default</th></>}
            {type === 'rows' && level >= 13 && <th scope="col">Autogrow All Files</th>}
          </tr></thead>
          <tbody>{rows.map(({ group, index }) => {
            const primary = index === 0, invalid = state.touched && groupProblems.some(problem => problem.filegroup === index) || undefined
            return <tr key={group.key} data-selected={selected === group.key || undefined} onFocus={() => setSelected(group.key)} onClick={() => setSelected(group.key)}>
              <td>{primary ? primaryFilegroup : <input className="new-database-cell" type="text" maxLength={128} spellCheck={false} aria-label={`Name of filegroup ${index + 1}`} value={group.name} disabled={!editable}
                aria-invalid={invalid} onChange={event => service.setFilegroup(state.id, group.key, { name: event.target.value })} />}</td>
              <td data-wrap="never">{filesIn(group)}</td>
              {type === 'rows' && flag(group, index, 'readOnly', 'Read-Only', primary)}
              {type !== 'memoryOptimized' && flag(group, index, 'isDefault', 'Default', false)}
              {type === 'rows' && level >= 13 && flag(group, index, 'autogrowAllFiles', 'Autogrow All Files', false)}
            </tr>
          })}</tbody>
        </table>
      </div>}
      <div className="new-database-grid-bar">
        <button type="button" disabled={!canAdd} onClick={() => service.addFilegroup(state.id, type)}>Add Filegroup</button>
        <button type="button" disabled={!editable || !removable} onClick={() => { if (selected !== undefined) { service.removeFilegroup(state.id, selected); setSelected(undefined) } }}>Remove</button>
      </div>
    </div>
  }
  return <div className="properties-filegroups">
    {groupTables.map(table)}
    {state.touched && groupProblems.length > 0 && <ul className="new-database-problems" aria-label="Problems with the filegroups">
      {groupProblems.map((problem, index) => <li key={index} className="property-field-error"><Icon name="error" />{problem.message}</li>)}
    </ul>}
  </div>
}

/**
 * New Database as a document (D1b, mock-up M5): the header (where it goes, Script, Cancel and OK), what the last OK said and
 * the steps it took, SSMS's General, Options and Filegroups pages as sections, and the Script drawer, which previews what OK
 * runs. Its service keeps the design, so switching tabs loses nothing.
 */
export default function NewDatabase({ documentId }: { documentId: string }) {
  const { newDatabase } = useWorkbench()
  const { documents } = useServiceSnapshot(newDatabase)
  const state = documents[documentId]
  if (!state) return <div className="new-database" />
  const editable = newDatabase.canEdit(state.id)
  const problems = state.model ? newDatabaseStateProblems(state) : []
  const marked = new Set(state.touched ? problems.map(newDatabaseProblemSection) : [])
  const args = { tabId: state.id }
  const verbs: Verb[] = state.phase === 'creating'
    ? [{ command: 'newDatabase.stop', args, emphasis: 'danger' }]
    : [{ command: 'newDatabase.cancel', args }, { command: 'newDatabase.ok', args, label: 'OK', emphasis: 'primary' }]
  const phaseLabel = state.phase === 'loading' ? 'Reading the server…' : state.phase === 'creating' ? 'Creating the database…' : undefined
  const content = (page: PageId) => {
    if (!state.model) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the server" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the server could not be read.' : ''}</p>
    const props: SectionProps = { state, editable, problems, service: newDatabase }
    switch (page) {
      case 'general': return <GeneralSection {...props} />
      case 'options': return <OptionsSection {...props} baseline={newDatabaseBaseline(state.model.model)} />
      case 'filegroups': return <FilegroupsSection {...props} />
      default: return null
    }
  }
  const sections: FrameSection[] = dialogSpecs.newDatabase.pages.map(page => ({ id: page.id, title: page.title, problem: marked.has(page.id), content: content(page.id) }))
  const stopped = state.error?.code === 'CANCELLED'
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} role={stopped ? 'status' : 'alert'} context={`New Database on ${state.server}`}
      actions={state.phase === 'loadFailed' ? [{ label: 'Retry', run: () => newDatabase.retry(state.id) }] : state.phase === 'ready' ? [{ label: 'Dismiss', run: () => newDatabase.dismissError(state.id) }] : []} />}
    {state.model && !state.model.canCreate && <p className="document-status"><Icon name="lock" />You do not have permission to create a database on this server.</p>}
    {state.steps && state.steps.length > 0 && <StepList labelledBy={`${state.id}-new-steps`} steps={state.steps.map(step => ({ state: step.status, text: step.message ?? step.title }))} />}
    <span id={`${state.id}-new-steps`} className="visually-hidden">Steps</span>
  </>
  return <FieldHints><DocumentFrame id={`new-database-${state.id}`} title="New Database"
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'Databases' }]}
    verbs={verbs} banner={banner} sections={sections} frame={state.frame} onFrame={frame => newDatabase.setFrame(state.id, frame)} attributes={{ 'data-new-database': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void newDatabase.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
