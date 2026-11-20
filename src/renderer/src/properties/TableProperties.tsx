import { useMemo } from 'react'
import { useDomRowCopy } from '../grid/row-copy'
import { dialogSpecs, type PageId } from '../../../shared/actions/catalog.ts'
import { tableLimits, type TablePropertiesModel } from '../../../shared/actions/tables.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { propertyKey, rowEditable, tableNotes, tableProblemSections, type TableDraft } from '../dialogs/table-properties'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { FactList, FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import Switch from '../kit/Switch'
import { permissionsTable, partitionsTable, predicatesTable } from './grids'
import PropertiesGrid from './PropertiesGrid'
import { generalFacts, lockEscalationSegments, storageFacts, tablePages, versioningFacts } from './table-fields'
import type { TablePropertiesService, TablePropertiesState } from './TablePropertiesService'

const fieldId = (documentId: string, key: string) => `table-properties-${documentId}-${key}`

interface SectionProps {
  readonly state: TablePropertiesState
  readonly model: TablePropertiesModel
  readonly draft: TableDraft
  readonly editable: boolean
  readonly errors: ReadonlyMap<string, string>
  readonly service: TablePropertiesService
}

function GeneralSection({ state, model, draft, editable, service }: SectionProps) {
  const facts = generalFacts(model), versioning = versioningFacts(model), id = fieldId(state.id, 'lockEscalation')
  const changed = draft.lockEscalation !== model.general.lockEscalation
  const note = model.general.memoryOptimized ? tableNotes.memoryOptimized : undefined
  const description = 'How SQL Server escalates row and page locks: to the table, to the partition (Auto, on a partitioned table), or not at all (Disable).'
  return <div className="properties-general">
    <h3 className="properties-group-title">Description</h3>
    <FactList facts={facts.description} />
    <h3 className="properties-group-title">Options</h3>
    <FactList facts={facts.options} />
    <div className="properties-fields">
      <PropertyField id={id} label="Lock escalation" changed={changed} labelFor={false} description={description} note={note}>
        <Segmented id={id} labelledBy={`${id}-label`} segments={lockEscalationSegments} value={draft.lockEscalation} disabled={!editable || model.general.memoryOptimized} changed={changed}
          {...fieldAria(id, { description, note, changed })} onChange={value => service.updateDraft(state.id, { lockEscalation: value })} />
      </PropertyField>
    </div>
    {versioning.temporal && <><h3 className="properties-group-title">Temporal</h3><FactList facts={versioning.temporal} /></>}
    {versioning.ledger && <><h3 className="properties-group-title">Ledger</h3><FactList facts={versioning.ledger} /></>}
  </div>
}

function PermissionsSection({ state, model }: Pick<SectionProps, 'state' | 'model'>) {
  const table = useMemo(() => permissionsTable(model), [model])
  return <div className="properties-permissions">
    <h3 className="properties-group-title">Permissions granted or denied on the table</h3>
    <PropertiesGrid table={table} label="Permissions" empty="No permissions are granted or denied on this table." suggestedName={`${state.label} permissions`} />
    <p className="field-note">{model.permissionsTruncated ? `The table has more than ${tableLimits.permissions.toLocaleString()} permissions; the first are listed. ` : ''}Grant, deny and revoke permissions in a query window.</p>
  </div>
}

function ChangeTrackingSection({ state, model, draft, editable, errors, service }: SectionProps) {
  const tracking = model.changeTracking, id = fieldId(state.id, 'changeTracking'), columnsId = fieldId(state.id, 'trackColumnsUpdated')
  const changed = draft.changeTracking !== tracking.enabled, columnsChanged = draft.changeTracking && draft.trackColumnsUpdated !== tracking.trackColumnsUpdated
  const memory = model.general.memoryOptimized
  const note = memory ? tableNotes.trackingMemoryOptimized : !tracking.enabled && !tracking.databaseEnabled ? tableNotes.databaseTracking : !tracking.enabled && !tracking.primaryKey ? tableNotes.primaryKey : undefined
  const text = { description: 'Whether SQL Server tracks which rows change, for applications that synchronize from the table.', note, error: errors.get('changeTracking') }
  const columns = { description: 'Whether SQL Server also tracks which columns of a row changed.', ...!draft.changeTracking ? { note: 'Turn change tracking on first.' } : {} }
  return <div className="properties-change-tracking">
    <FactList facts={[{ label: 'Change tracking on the database', value: tracking.databaseEnabled ? 'True' : 'False' }, { label: 'Primary key', value: tracking.primaryKey ? 'True' : 'False', title: 'Change tracking needs one.' }]} />
    <div className="properties-fields">
      <PropertyField id={id} label="Change Tracking" changed={changed} {...text}>
        <Switch id={id} checked={draft.changeTracking} disabled={!editable || memory || (!tracking.enabled && (!tracking.databaseEnabled || !tracking.primaryKey))} changed={changed}
          {...fieldAria(id, { ...text, changed })} onChange={checked => service.updateDraft(state.id, { changeTracking: checked })} />
      </PropertyField>
      <PropertyField id={columnsId} label="Track Columns Updated" changed={columnsChanged} {...columns}>
        <Switch id={columnsId} checked={draft.changeTracking && draft.trackColumnsUpdated} disabled={!editable || memory || !draft.changeTracking} changed={columnsChanged}
          {...fieldAria(columnsId, { ...columns, changed: columnsChanged })} onChange={checked => service.updateDraft(state.id, { trackColumnsUpdated: checked })} />
      </PropertyField>
    </div>
  </div>
}

function StorageSection({ state, model }: Pick<SectionProps, 'state' | 'model'>) {
  const facts = storageFacts(model), partitions = useMemo(() => partitionsTable(model), [model])
  return <div className="properties-storage">
    <h3 className="properties-group-title">Compression</h3>
    <FactList facts={facts.compression} />
    <h3 className="properties-group-title">Filegroups</h3>
    <FactList facts={facts.filegroups} />
    <h3 className="properties-group-title">Partitioning</h3>
    <FactList facts={facts.partitioning} />
    <h3 className="properties-group-title">General</h3>
    <FactList facts={facts.general} />
    {model.storage.partitioned && <>
      <h3 className="properties-group-title">Partitions</h3>
      <PropertiesGrid table={partitions} label="Partitions" empty="No partitions are listed." suggestedName={`${state.label} partitions`} />
      {model.storage.partitionsTruncated && <p className="field-note">The table has more partitions than are listed.</p>}
    </>}
    <p className="field-note">Change compression and partitioning with Manage Compression and Create Partition in a query window.</p>
  </div>
}

function SecurityPredicatesSection({ state, model }: Pick<SectionProps, 'state' | 'model'>) {
  const table = useMemo(() => predicatesTable(model), [model])
  return <div className="properties-security-predicates">
    <h3 className="properties-group-title">Row-level security predicates on the table</h3>
    <PropertiesGrid table={table} label="Security predicates" empty="No security predicates apply to this table." suggestedName={`${state.label} security predicates`} />
    {model.securityPredicatesTruncated && <p className="field-note">The table has more predicates than are listed.</p>}
  </div>
}

function ExtendedPropertiesSection({ state, model, draft, editable: documentEditable, errors, service }: SectionProps) {
  const copyRow = useDomRowCopy()
  // A truncated list cannot be diffed safely (an add could collide with a property not listed), so it is read-only.
  const editable = documentEditable && !model.extendedPropertiesTruncated
  const heading = `${state.id}-extended-grid`, problem = errors.get('extendedProperties')
  const add = () => {
    const key = service.addProperty(state.id)
    if (key) requestAnimationFrame(() => document.getElementById(fieldId(state.id, `${key}-name`))?.focus())
  }
  return <div className="properties-extended">
    <h3 className="properties-group-title" id={heading}>Extended properties</h3>
    {draft.extendedProperties.length === 0 ? <p className="field-note">The table has no extended properties.</p> : <div className="properties-table">
      <table onCopy={copyRow} className="object-dialog-grid" aria-labelledby={heading}>
        <thead><tr><th scope="col">Name</th><th scope="col">Value</th><th scope="col"><span className="visually-hidden">Remove</span></th></tr></thead>
        <tbody>{draft.extendedProperties.map((row, index) => {
          const nameId = fieldId(state.id, `${row.key}-name`), valueId = fieldId(state.id, `${row.key}-value`), rowEdit = editable && rowEditable(row) && !row.removed
          const nameError = errors.get(propertyKey(row, 'name')), valueError = errors.get(propertyKey(row, 'value'))
          const nameChanged = row.origin ? row.name !== row.origin.name : true, valueChanged = row.origin ? row.value !== row.origin.value : true
          // Each row's fields say which property they are; a problem is linked to its field and read when the field is, not announced as it appears.
          const label = `property ${index + 1}`, readOnlyNote = row.origin?.type ? tableNotes.nonString : !rowEditable(row) ? tableNotes.tooLong : undefined
          const errorAria = (id: string, error: string | undefined) => error ? { 'aria-invalid': true as const, 'aria-errormessage': `${id}-error`, 'aria-describedby': `${id}-error` } : {}
          return <tr key={row.key} data-removed={row.removed || undefined}>
            <td><input id={nameId} className="property-input" type="text" aria-label={`Name of ${label}`} maxLength={128} spellCheck={false} value={row.name} disabled={!rowEdit}
              data-changed={nameChanged || undefined} {...errorAria(nameId, nameError)} title={nameError} onChange={event => service.patchProperty(state.id, row.key, { name: event.target.value })} />
              {nameError && <span id={`${nameId}-error`} className="property-field-error"><Icon name="error" />{nameError}</span>}</td>
            <td>{readOnlyNote ? <span className="property-value" title={readOnlyNote}>{row.value}{row.origin?.truncated ? '…' : ''}{row.origin?.type ? ` (${row.origin.type})` : ''}</span>
              : <input id={valueId} className="property-input" type="text" aria-label={`Value of ${label}`} maxLength={tableLimits.extendedPropertyValue} spellCheck={false} value={row.value} disabled={!rowEdit}
                data-changed={valueChanged || undefined} {...errorAria(valueId, valueError)} title={valueError} onChange={event => service.patchProperty(state.id, row.key, { value: event.target.value })} />}
              {valueError && <span id={`${valueId}-error`} className="property-field-error"><Icon name="error" />{valueError}</span>}</td>
            <td data-wrap="never">{row.removed
              ? <button type="button" disabled={!editable} onClick={() => service.patchProperty(state.id, row.key, { removed: false })}>Restore</button>
              : <button type="button" className="property-browse" aria-label={`Remove ${row.name || 'the new property'}`} title="Remove" disabled={!editable} onClick={() => service.patchProperty(state.id, row.key, { removed: true })}><Icon name="trash" /></button>}</td>
          </tr>
        })}</tbody>
      </table>
    </div>}
    <p><button type="button" disabled={!editable} onClick={add}><Icon name="add" />New Property</button></p>
    {problem && <p className="property-field-error" role="alert"><Icon name="error" />{problem}</p>}
    {model.extendedPropertiesTruncated && <p className="field-note">{tableNotes.truncated}</p>}
  </div>
}

/**
 * Table Properties as a document: the header (where the table is, Refresh, Discard Changes and Apply), what the last action said,
 * SSMS's pages as sections, and the Script drawer, which previews what Apply would run in its one transaction.
 */
export default function TableProperties({ documentId }: { documentId: string }) {
  const { tableProperties } = useWorkbench()
  const { documents } = useServiceSnapshot(tableProperties)
  const state = documents[documentId]
  if (!state) return <div className="table-properties" />
  const { model, draft } = state
  const editable = tableProperties.canEdit(state.id), errors = tableProperties.errors(state.id), problems = tableProblemSections(errors)
  const args = { tabId: state.id }
  const verbs: Verb[] = state.phase === 'applying'
    ? [{ command: 'tableProperties.stop', args, emphasis: 'danger' }]
    : [{ command: 'tableProperties.refresh', args }, { command: 'tableProperties.discard', args }, { command: 'tableProperties.apply', args, label: 'Apply', emphasis: 'primary' }]
  const phaseLabel = state.phase === 'loading' ? 'Reading the table…' : state.phase === 'applying' ? 'Applying the changes…' : state.phase === 'confirming' ? 'Waiting for your answer…' : undefined
  const content = (page: PageId) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the table" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the table could not be read.' : ''}</p>
    const props: SectionProps = { state, model, draft, editable, errors, service: tableProperties }
    switch (page) {
      case 'general': return <GeneralSection {...props} />
      case 'permissions': return <PermissionsSection state={state} model={model} />
      case 'changeTracking': return <ChangeTrackingSection {...props} />
      case 'storage': return <StorageSection state={state} model={model} />
      case 'securityPredicates': return <SecurityPredicatesSection state={state} model={model} />
      case 'extendedProperties': return <ExtendedPropertiesSection {...props} />
      default: return null
    }
  }
  const sections: FrameSection[] = tablePages(dialogSpecs.tableProperties.pages, model).map(page => ({ id: page.id, title: page.title, problem: problems.has(page.id), content: content(page.id) }))
  const stopped = state.error?.code === 'CANCELLED'
  const reread = state.stale || state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND'
  const recovery = reread && tableProperties.canRefresh(state.id) ? [{ label: 'Refresh', run: () => tableProperties.refresh(state.id) }]
    : reread && tableProperties.canDiscard(state.id) ? [{ label: 'Discard Changes', run: () => tableProperties.discard(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} role={stopped ? 'status' : 'alert'} context={`Table Properties - ${state.label} on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnlyReason && <p className="document-status"><Icon name="lock" />{model.readOnlyReason}</p>}
  </>
  return <FieldHints><DocumentFrame id={`table-properties-${state.id}`} title={state.label} subtitle="Table Properties"
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: displayText(state.target.database ?? '') }, { label: 'Tables' }]}
    verbs={verbs} banner={banner} sections={sections} frame={state.frame} onFrame={frame => tableProperties.setFrame(state.id, frame)} attributes={{ 'data-table-properties': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void tableProperties.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
