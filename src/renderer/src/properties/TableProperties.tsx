import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { tableLimits, type TablePropertiesModel } from '../../../shared/actions/tables.ts'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { isPeekKind, type PeekDependency, type PeekList, type PeekListId } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { onUnexpectedError } from '../core/errors'
import { useServiceSelector, useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { propertyKey, rowEditable, tableNotes, type TableDraft } from '../dialogs/table-properties'
import { createQueryEditor } from '../editor/create-editor'
import ExplorerIcon from '../explorer/ExplorerIcon'
import { PeekEditor, peekEditorUse } from '../explorer/peek-editor'
import { PeekListGrid } from '../explorer/PeekListGrid'
import { copyableDefinition, peekMessages, tooLongToCopy, type PeekDefinition, type PeekDependencies, type PeekPart, type PeekRows } from '../explorer/PeekService'
import ResultsStack from '../grid/ResultsStack'
import { useDomRowCopy } from '../grid/row-copy'
import Icon from '../Icon'
import CapabilityChips from '../kit/CapabilityChips'
import { resizeScript, setScriptOpen } from '../kit/document-frame'
import type { Verb } from '../kit/DocumentFrame'
import FactGrid from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorTab } from '../kit/ObjectInspectorFrame'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import RatioBar from '../kit/RatioBar'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import type { ExplorerMenuNode } from '../menus/targets'
import { settingsDocumentOptions } from '../services/documents'
import { partitionsTable, permissionsTable, predicatesTable } from './grids'
import PropertiesGrid from './PropertiesGrid'
import {
  generalFacts, lockEscalationSegments, storageFacts, tableCapabilities, tableChangeCount, tableHeroKpis,
  tableModifiedTabs, tableProblemTabs, tableSpaceRatio, tableStatusPills, tableVitalsFacts, toFactItems,
  versioningFacts, type TableCatalogCounts, type TableInspectorTabId
} from './table-fields'
import type { TablePropertiesService, TablePropertiesState } from './TablePropertiesService'

const fieldId = (documentId: string, key: string) => `table-properties-${documentId}-${key}`
const monoIdentity = new Set(['Name', 'Schema'])
const monoVersioning = new Set(['History table', 'Current table', 'Period start column', 'Period end column', 'Ledger view', 'Ledger history table'])
const monoStorage = new Set(['Filegroup', 'Text filegroup', 'FILESTREAM filegroup', 'Partition scheme', 'Partition column'])

const definitionEditorUse = {
  ...peekEditorUse,
  readOnly: { message: 'Definition is read-only. Use Open in New Query to edit the script.' },
  inEditorPane: true
} as const

/** Moves focus back to the selected inspector tab before Retry removes the Retry button from the DOM. */
function focusSelectedInspectorTab(event: MouseEvent<HTMLButtonElement>): void {
  event.currentTarget.closest('[data-object-inspector]')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
}

interface TabProps {
  readonly state: TablePropertiesState
  readonly model: TablePropertiesModel
  readonly draft: TableDraft
  readonly editable: boolean
  readonly errors: ReadonlyMap<string, string>
  readonly service: TablePropertiesService
}

function ModelPlaceholder({ state }: { readonly state: TablePropertiesState }) {
  return state.phase === 'loading'
    ? <Skeleton rows={4} label="Reading the table" />
    : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the table could not be read.' : ''}</p>
}

function OverviewTab({ state, model, draft, editable, errors, service }: TabProps) {
  const facts = generalFacts(model), versioning = versioningFacts(model)
  const capabilities = useMemo(() => tableCapabilities(model), [model])
  const lockId = fieldId(state.id, 'lockEscalation')
  const lockChanged = draft.lockEscalation !== model.general.lockEscalation
  const lockNote = model.general.memoryOptimized ? tableNotes.memoryOptimized : undefined
  const lockDescription = 'How SQL Server escalates row and page locks: to the table, to the partition (Auto, on a partitioned table), or not at all (Disable).'
  const tracking = model.changeTracking
  const trackingId = fieldId(state.id, 'changeTracking'), columnsId = fieldId(state.id, 'trackColumnsUpdated')
  const trackingChanged = draft.changeTracking !== tracking.enabled
  const columnsChanged = draft.changeTracking && draft.trackColumnsUpdated !== tracking.trackColumnsUpdated
  const memory = model.general.memoryOptimized
  const trackingNote = memory ? tableNotes.trackingMemoryOptimized : !tracking.enabled && !tracking.databaseEnabled ? tableNotes.databaseTracking : !tracking.enabled && !tracking.primaryKey ? tableNotes.primaryKey : undefined
  const trackingText = { description: 'Whether SQL Server tracks which rows change, for applications that synchronize from the table.', note: trackingNote, error: errors.get('changeTracking') }
  const columnsText = { description: 'Whether SQL Server also tracks which columns of a row changed.', ...!draft.changeTracking ? { note: 'Turn change tracking on first.' } : {} }
  const trackingPrereqs = useMemo(() => [
    { id: 'dbTracking', label: 'Change tracking on the database', value: tracking.databaseEnabled ? 'True' : 'False' },
    { id: 'primaryKey', label: 'Primary key', value: tracking.primaryKey ? 'True' : 'False', title: 'Change tracking needs one.' }
  ], [tracking.databaseEnabled, tracking.primaryKey])

  return <div className="table-inspector-overview">
    <h3 className="table-inspector-heading">Identity &amp; Lifecycle</h3>
    <FactGrid facts={toFactItems(facts.description, monoIdentity)} />
    <h3 className="table-inspector-heading">Capabilities &amp; Flags</h3>
    <CapabilityChips items={capabilities} label="Table capabilities" empty="No special capabilities enabled." />
    {versioning.temporal && <>
      <h3 className="table-inspector-heading">Temporal</h3>
      <FactGrid facts={toFactItems(versioning.temporal, monoVersioning)} />
    </>}
    {versioning.ledger && <>
      <h3 className="table-inspector-heading">Ledger</h3>
      <FactGrid facts={toFactItems(versioning.ledger, monoVersioning)} />
    </>}
    <h3 className="table-inspector-heading">Editable Options</h3>
    <div className="properties-fields">
      <PropertyField id={lockId} label="Lock escalation" changed={lockChanged} labelFor={false} description={lockDescription} note={lockNote}>
        <Segmented id={lockId} labelledBy={`${lockId}-label`} segments={lockEscalationSegments} value={draft.lockEscalation} disabled={!editable || memory} changed={lockChanged}
          {...fieldAria(lockId, { description: lockDescription, note: lockNote, changed: lockChanged })} onChange={value => service.updateDraft(state.id, { lockEscalation: value })} />
      </PropertyField>
      <PropertyField id={trackingId} label="Change Tracking" changed={trackingChanged} {...trackingText}>
        <Switch id={trackingId} checked={draft.changeTracking} disabled={!editable || memory || (!tracking.enabled && (!tracking.databaseEnabled || !tracking.primaryKey))} changed={trackingChanged}
          {...fieldAria(trackingId, { ...trackingText, changed: trackingChanged })} onChange={checked => service.updateDraft(state.id, { changeTracking: checked })} />
      </PropertyField>
      <PropertyField id={columnsId} label="Track Columns Updated" changed={columnsChanged} {...columnsText}>
        <Switch id={columnsId} checked={draft.changeTracking && draft.trackColumnsUpdated} disabled={!editable || memory || !draft.changeTracking} changed={columnsChanged}
          {...fieldAria(columnsId, { ...columnsText, changed: columnsChanged })} onChange={checked => service.updateDraft(state.id, { trackColumnsUpdated: checked })} />
      </PropertyField>
    </div>
    <h3 className="table-inspector-heading">Change Tracking Prerequisites</h3>
    <FactGrid facts={trackingPrereqs} />
  </div>
}

function DefinitionTab({ state, part, editor, connectionId, connected, service }: {
  readonly state: TablePropertiesState
  readonly part: PeekPart<PeekDefinition> | undefined
  readonly editor: PeekEditor | undefined
  readonly connectionId: string
  readonly connected: boolean
  readonly service: TablePropertiesService
}) {
  const slot = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const text = part?.status === 'ready' ? part.value.text : undefined
  const copyable = copyableDefinition(text)
  const shownKey = text === undefined ? undefined : `${state.id}:${state.definitionEpoch}:${connectionId}`

  useLayoutEffect(() => {
    const here = slot.current
    if (!here || !editor || text === undefined || !shownKey) return
    try {
      editor.show(here, {
        key: shownKey, text, connectionId,
        ...(state.target.database === undefined ? {} : { database: state.target.database })
      })
    } catch (failure) { onUnexpectedError(failure) }
    return () => editor.hide(here)
  }, [editor, text, shownKey, connectionId, state.target.database])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const onCopy = () => {
    void service.copyDefinition(state.id).then(written => { if (written) setCopied(true) }, onUnexpectedError)
  }

  return <>
    <div className="table-inspector-toolbar" role="toolbar" aria-label="Definition actions">
      <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={!copyable}
        title={text !== undefined && !copyable ? tooLongToCopy : 'Copy definition'}
        onClick={onCopy}>
        <Icon name={copied ? 'check' : 'copy'} /><span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={text === undefined}
        title="Open CREATE script in a new query tab"
        onClick={() => service.openDefinitionInQuery(state.id)}>
        <Icon name="new-file" /><span>Open in New Query</span>
      </button>
    </div>
    <div className="table-inspector-editor-fill">
      {(!part || part.status === 'loading') && <p className="table-inspector-note" role="status"><Icon name="loading" spin />Loading the definition…</p>}
      {part?.status === 'error' && <div className="table-inspector-note error" role="alert">
        <span>{part.message}</span>
        <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={!connected}
          onClick={event => { focusSelectedInspectorTab(event); service.retryTab(state.id, 'definition') }}>Retry</button>
      </div>}
      {part?.status === 'ready' && text === undefined && <p className="table-inspector-note">{peekMessages.noDefinition}</p>}
      {text !== undefined && <div ref={slot} className="peek-editor" />}
    </div>
  </>
}

function StorageTab({ state, model }: Pick<TabProps, 'state' | 'model'>) {
  const facts = storageFacts(model)
  const spaceRatio = useMemo(() => tableSpaceRatio(model.storage), [model.storage])
  const partitions = useMemo(() => partitionsTable(model), [model])
  return <div className="table-inspector-storage">
    {spaceRatio && <RatioBar title="Data vs. Index Space" totalLabel={spaceRatio.totalLabel} segments={spaceRatio.segments} />}
    <h3 className="table-inspector-heading">General</h3>
    <FactGrid facts={toFactItems(facts.general)} />
    <h3 className="table-inspector-heading">Compression</h3>
    <FactGrid facts={toFactItems(facts.compression)} />
    <h3 className="table-inspector-heading">Filegroups</h3>
    <FactGrid facts={toFactItems(facts.filegroups, monoStorage)} />
    <h3 className="table-inspector-heading">Partitioning</h3>
    <FactGrid facts={toFactItems(facts.partitioning, monoStorage)} />
    {model.storage.partitioned && <>
      <h3 className="table-inspector-heading">Partitions</h3>
      <PropertiesGrid table={partitions} label="Partitions" empty="No partitions are listed." suggestedName={`${state.label} partitions`} maxRows={Infinity} />
      {model.storage.partitionsTruncated && <p className="field-note">The table has more partitions than are listed.</p>}
    </>}
    <p className="field-note">Change compression and partitioning with Manage Compression and Create Partition in a query window.</p>
  </div>
}

function CatalogListTab({ state, id, tabId, list, part, connected, service }: {
  readonly state: TablePropertiesState
  readonly id: PeekListId
  readonly tabId: TableInspectorTabId
  readonly list: PeekList | undefined
  readonly part: PeekPart<unknown> | undefined
  readonly connected: boolean
  readonly service: TablePropertiesService
}) {
  if (!part || part.status === 'loading') return <p className="table-inspector-note" role="status"><Icon name="loading" spin />Loading…</p>
  if (part.status === 'error') return <div className="table-inspector-note error" role="alert">
    <span>{part.message}</span>
    <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={!connected}
      onClick={event => { focusSelectedInspectorTab(event); service.retryTab(state.id, tabId) }}>Retry</button>
  </div>
  return <div className="table-inspector-grid-fill">
    <PeekListGrid id={id} list={list} preset="page" fill objectName={state.label} />
    {list?.truncated && <p className="table-inspector-note">There are more items than are listed.</p>}
  </div>
}

const dependencyName = (dependency: PeekDependency) => displayText([dependency.server, dependency.database, dependency.schema, dependency.name].filter(part => part !== undefined).join('.'))

function canFollowDependency(dependency: PeekDependency): boolean {
  return dependency.kind !== undefined && isPeekKind(dependency.kind) && kindSpecs[dependency.kind].scope === 'schemaObject'
    && dependency.server === undefined && dependency.database === undefined && dependency.schema !== undefined
}

function DependencyGroup({ title, items, truncated, connected, onOpen }: {
  readonly title: string
  readonly items: readonly PeekDependency[]
  readonly truncated: boolean
  readonly connected: boolean
  readonly onOpen: (dependency: PeekDependency) => void
}) {
  return <section aria-label={title}>
    <h3 className="table-inspector-heading">{title}</h3>
    {items.length === 0
      ? <p className="field-note">{peekMessages.noDependencies}</p>
      : <ul className="table-inspector-dep-list">{items.map((dependency, index) => {
        const icon = <ExplorerIcon name={dependency.kind ? kindSpecs[dependency.kind].icon : 'references'} />
        const note = dependency.foreignKey ? 'Foreign key' : dependency.kind ? kindSpecs[dependency.kind].title : undefined
        const name = dependencyName(dependency)
        const body = <>{icon}<bdi className="table-inspector-dep-name">{name}</bdi>{note && <span className="table-inspector-dep-kind">{note}</span>}</>
        return <li key={`${name}-${index}`} className="table-inspector-dep-item">
          {canFollowDependency(dependency)
            ? <button type="button" className="table-inspector-dep-link" disabled={!connected}
              aria-label={`Open ${name}`} title={connected ? `Open ${name}` : peekMessages.notConnected} onClick={() => onOpen(dependency)}>{body}</button>
            : body}
        </li>
      })}</ul>}
    {truncated && <p className="field-note">There are more dependencies than are listed.</p>}
  </section>
}

function DependenciesTab({ state, part, connectionId, connected, service }: {
  readonly state: TablePropertiesState
  readonly part: PeekPart<PeekDependencies> | undefined
  readonly connectionId: string
  readonly connected: boolean
  readonly service: TablePropertiesService
}) {
  const { documents, peekTabs } = useWorkbench()
  if (!part || part.status === 'loading') return <p className="table-inspector-note" role="status"><Icon name="loading" spin />Loading dependencies…</p>
  if (part.status === 'error') return <div className="table-inspector-note error" role="alert">
    <span>{part.message}</span>
    <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={!connected}
      onClick={event => { focusSelectedInspectorTab(event); service.retryTab(state.id, 'dependencies') }}>Retry</button>
  </div>
  const openDependency = (dependency: PeekDependency) => {
    if (!connected || !connectionId || !dependency.kind || !dependency.schema || !canFollowDependency(dependency)) return
    const object = { kind: dependency.kind, ...(state.target.database === undefined ? {} : { database: state.target.database }), schema: dependency.schema, name: dependency.name }
    const node: ExplorerMenuNode = {
      id: -1, connectionId, kind: dependency.kind, ...(dependency.subtype === undefined ? {} : { subtype: dependency.subtype }),
      ref: { type: 'object', object }, label: `${dependency.schema}.${dependency.name}`, lost: false
    }
    // Route through peekTabs.open so tables promote cleanly to TableProperties and disconnected checks stay unified.
    if (peekTabs.open(node)) documents.focusActive()
  }
  const { uses, usesTruncated, usedBy, usedByTruncated } = part.value
  return <div className="table-inspector-deps">
    <DependencyGroup title="Uses" items={uses} truncated={usesTruncated} connected={connected} onOpen={openDependency} />
    <DependencyGroup title="Used by" items={usedBy} truncated={usedByTruncated} connected={connected} onOpen={openDependency} />
  </div>
}

function PermissionsTab({ state, model }: Pick<TabProps, 'state' | 'model'>) {
  const permissions = useMemo(() => permissionsTable(model), [model])
  const predicates = useMemo(() => predicatesTable(model), [model])
  return <div className="table-inspector-permissions">
    <h3 className="table-inspector-heading">Permissions granted or denied on the table</h3>
    <PropertiesGrid table={permissions} label="Permissions" empty="No permissions are granted or denied on this table." suggestedName={`${state.label} permissions`} maxRows={Infinity} />
    <p className="field-note">{model.permissionsTruncated ? `The table has more than ${tableLimits.permissions.toLocaleString()} permissions; the first are listed. ` : ''}Grant, deny and revoke permissions in a query window.</p>
    {model.securityPredicates !== undefined && <>
      <h3 className="table-inspector-heading">Row-level security predicates</h3>
      <PropertiesGrid table={predicates} label="Security predicates" empty="No security predicates apply to this table." suggestedName={`${state.label} security predicates`} maxRows={Infinity} />
      {model.securityPredicatesTruncated && <p className="field-note">The table has more predicates than are listed.</p>}
    </>}
  </div>
}

function ExtendedPropertiesTab({ state, model, draft, editable: documentEditable, errors, service }: TabProps) {
  const copyRow = useDomRowCopy()
  // A truncated list cannot be diffed safely (an add could collide with a property not listed), so it is read-only.
  const editable = documentEditable && !model.extendedPropertiesTruncated
  const heading = `${state.id}-extended-grid`, problem = errors.get('extendedProperties')
  const add = () => {
    const key = service.addProperty(state.id)
    if (key) requestAnimationFrame(() => document.getElementById(fieldId(state.id, `${key}-name`))?.focus())
  }
  return <div className="properties-extended">
    <h3 className="table-inspector-heading" id={heading}>Extended properties</h3>
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

function PreviewRowsTab({ state, part, connected, service }: {
  readonly state: TablePropertiesState
  readonly part: PeekPart<PeekRows> | undefined
  readonly connected: boolean
  readonly service: TablePropertiesService
}) {
  const { results } = useWorkbench()
  const key = part?.status === 'ready' ? part.value.key : undefined
  const tab = useServiceSelector(results, all => key === undefined ? undefined : all[key])
  if (!part || part.status === 'loading') return <p className="table-inspector-note" role="status"><Icon name="loading" spin />Reading the top rows…</p>
  if (part.status === 'error') return <div className="table-inspector-note error" role="alert">
    <span>{part.message}</span>
    <button type="button" className="ui-button table-inspector-toolbar-btn" data-control-variant="secondary" disabled={!connected}
      onClick={event => { focusSelectedInspectorTab(event); service.retryTab(state.id, 'preview') }}>Retry</button>
  </div>
  if (!tab?.sets.length) return <p className="table-inspector-note">{peekMessages.rowsUnavailable}</p>
  const read = tab.summary?.resultSets[0]?.rowsRead
  return <div className="table-inspector-preview" data-peek-rows="">
    <ResultsStack tabId={part.value.key} tab={tab} />
    {read === 0 && <p className="table-inspector-note">{peekMessages.noRows}</p>}
  </div>
}

function TableVitals({ model }: { readonly model: TablePropertiesModel }) {
  const spaceRatio = useMemo(() => tableSpaceRatio(model.storage), [model.storage])
  const facts = useMemo(() => tableVitalsFacts(model), [model])
  const activeCapabilities = useMemo(() => tableCapabilities(model).filter(item => item.notable), [model])
  return <>
    {spaceRatio && <div className="vitals-block">
      <h4 className="vitals-block-title">Space Breakdown</h4>
      <RatioBar flat title="Data vs. Index" totalLabel={spaceRatio.totalLabel} segments={spaceRatio.segments} />
    </div>}
    <div className="vitals-block">
      <h4 className="vitals-block-title">Storage &amp; Identity</h4>
      <FactGrid compact facts={facts} />
    </div>
    <div className="vitals-block">
      <h4 className="vitals-block-title">Active Capabilities</h4>
      {activeCapabilities.length > 0
        ? <ul className="table-inspector-vitals-caps" aria-label="Active capabilities">
          {activeCapabilities.map(item => (
            <li key={item.id} className="cap-chip on" data-tone={item.tone} title={item.title}>
              <span className="cap-chip-label">{item.label}</span>
              {item.value !== undefined && <span className="cap-chip-value">{item.value}</span>}
            </li>
          ))}
        </ul>
        : <span className="cap-chips-empty">Standard table</span>}
    </div>
  </>
}

/**
 * SQL Server Table Properties on the unified `ObjectInspectorFrame` shell: breadcrumbs, engine badge, semantic status
 * pills, Hero KPI strip, resizable Vitals rail, canonical tabs (with lazy-loaded Definition, Columns, Indexes & Keys,
 * Dependencies and Preview Rows), zero scroll-within-a-scroll, transactional Apply/Discard, zero-height FieldHintStrip
 * overlay and docked ScriptDrawer.
 */
export default function TableProperties({ documentId }: { documentId: string }) {
  const workbench = useWorkbench()
  const { tableProperties, documents: documentService, connections } = workbench
  const { documents } = useServiceSnapshot(tableProperties)
  const state = documents[documentId]
  // Subscribe reactively to connectionId and connection list so reconnect/disconnect updates Monaco and Retry buttons.
  const connectionId = useServiceSelector(documentService, snapshot => snapshot.documents.find(doc => doc.id === documentId)?.connectionId ?? '')
  useServiceSnapshot(connections)

  // Hoist PeekEditor at document scope (allocated lazily on first Definition visit) so switching tabs preserves scroll/selection/Find.
  const [definitionVisited, setDefinitionVisited] = useState(() => state?.activeTab === 'definition')
  if (state?.activeTab === 'definition' && !definitionVisited) setDefinitionVisited(true)
  const [definitionEditor, setDefinitionEditor] = useState<PeekEditor | undefined>(undefined)
  useEffect(() => {
    if (!definitionVisited || !workbench.monaco?.editor?.createModel) return
    const made = new PeekEditor({
      monaco: workbench.monaco,
      create: container => createQueryEditor(workbench, container, definitionEditorUse),
      modelOptions: settingsDocumentOptions(() => workbench.settings.getSnapshot().values).modelOptions
    })
    setDefinitionEditor(made)
    return () => { setDefinitionEditor(undefined); made.dispose() }
  }, [workbench, definitionVisited])

  const definitionText = state?.definition?.status === 'ready' ? state.definition.value.text : undefined
  const definitionKey = state && definitionText !== undefined ? `${state.id}:${state.definitionEpoch}:${connectionId}` : undefined
  useEffect(() => { definitionEditor?.keep(definitionKey) }, [definitionEditor, definitionKey])

  if (!state) return <div className="table-properties" />
  const { model, draft } = state
  const connected = tableProperties.isConnected(state.id)
  const editable = tableProperties.canEdit(state.id)
  const errors = tableProperties.errors(state.id)
  const problemTabs = tableProblemTabs(errors)
  const modifiedTabs = model && draft ? tableModifiedTabs(model, draft) : new Set<TableInspectorTabId>()
  const changeCount = model && draft ? tableChangeCount(model, draft) : 0
  const args = { tabId: state.id }
  const verbs: Verb[] = state.phase === 'applying'
    ? [{ command: 'tableProperties.stop', args, emphasis: 'danger' }]
    : [
      { command: 'tableProperties.refresh', args },
      { command: 'tableProperties.discard', args, label: 'Discard' },
      { command: 'tableProperties.apply', args, label: changeCount > 0 ? `Apply · ${changeCount}` : 'Apply', emphasis: 'primary' }
    ]
  const phaseLabel = state.phase === 'loading' ? 'Reading the table…' : state.phase === 'applying' ? 'Applying the changes…' : state.phase === 'confirming' ? 'Waiting for your answer…' : undefined
  const stopped = state.error?.code === 'CANCELLED'
  const reread = state.stale || state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND'
  const recovery = reread && tableProperties.canRefresh(state.id) ? [{ label: 'Refresh', run: () => tableProperties.refresh(state.id) }]
    : reread && tableProperties.canDiscard(state.id) ? [{ label: 'Discard Changes', run: () => tableProperties.discard(state.id) }] : []

  const banner = (phaseLabel || state.error || state.notice || model?.readOnlyReason) ? <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} role={stopped ? 'status' : 'alert'} context={`Table Properties - ${state.label} on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnlyReason && <p className="document-status"><Icon name="lock" />{model.readOnlyReason}</p>}
  </> : undefined

  const catalogReady = state.catalog?.status === 'ready' ? state.catalog.value : undefined
  const catalogCounts: TableCatalogCounts | undefined = catalogReady ? {
    ...(catalogReady.columns ? { columns: { count: catalogReady.columns.rows.length, truncated: catalogReady.columns.truncated } } : {}),
    ...(catalogReady.tableObjects ? { indexes: { count: catalogReady.tableObjects.rows.length, truncated: catalogReady.tableObjects.truncated } } : {})
  } : undefined
  const kpis = model ? tableHeroKpis(model, catalogCounts) : []
  const badges = model ? tableStatusPills(model) : []
  const headerState = <span className="table-inspector-badges">
    <StatusPill variant="tag" size="small" tone="neutral" label="SQL Server" />
    {badges.map(badge => <StatusPill key={badge.id} size="small" tone={badge.tone} label={badge.label} title={badge.title} />)}
  </span>

  const tabProps: TabProps | undefined = model && draft ? { state, model, draft, editable, errors, service: tableProperties } : undefined
  const depsReady = state.dependencies?.status === 'ready' ? state.dependencies.value : undefined
  const tabCount = (count: number, truncated: boolean | undefined, singular: string, plural: string) => {
    const isTruncated = !!truncated
    const formatted = `${count.toLocaleString()}${isTruncated ? '+' : ''}`
    return { count: formatted, countLabel: `${formatted} ${count === 1 && !isTruncated ? singular : plural}` }
  }
  const partBadge = model?.storage.partitioned ? tabCount(model.storage.partitions.length, model.storage.partitionsTruncated, 'partition', 'partitions') : undefined
  const colsBadge = catalogCounts?.columns ? tabCount(catalogCounts.columns.count, catalogCounts.columns.truncated, 'column', 'columns') : undefined
  const idxsBadge = catalogCounts?.indexes ? tabCount(catalogCounts.indexes.count, catalogCounts.indexes.truncated, 'index or key', 'indexes and keys') : undefined
  const depsBadge = depsReady ? tabCount(depsReady.uses.length + depsReady.usedBy.length, !!(depsReady.usesTruncated || depsReady.usedByTruncated), 'dependency', 'dependencies') : undefined
  const permsBadge = model ? tabCount(model.permissions.length + (model.securityPredicates?.length ?? 0), !!(model.permissionsTruncated || model.securityPredicatesTruncated), 'permission or predicate', 'permissions and predicates') : undefined
  const extBadge = draft && model ? tabCount(draft.extendedProperties.filter(row => !row.removed).length, model.extendedPropertiesTruncated, 'extended property', 'extended properties') : undefined

  const tabs: InspectorTab[] = [
    {
      id: 'overview', title: 'Overview', layout: 'flow',
      modified: modifiedTabs.has('overview'), problem: problemTabs.has('overview'),
      content: tabProps ? <OverviewTab {...tabProps} /> : <ModelPlaceholder state={state} />
    },
    {
      id: 'definition', title: 'Definition', layout: 'fill',
      content: <DefinitionTab state={state} part={state.definition} editor={definitionEditor} connectionId={connectionId} connected={connected} service={tableProperties} />
    },
    {
      id: 'storage', title: 'Storage & Layout', layout: 'flow',
      ...partBadge,
      content: model ? <StorageTab state={state} model={model} /> : <ModelPlaceholder state={state} />
    },
    {
      id: 'columns', title: 'Columns', layout: 'fill',
      ...colsBadge,
      content: <CatalogListTab state={state} id="columns" tabId="columns" list={catalogReady?.columns} part={state.catalog} connected={connected} service={tableProperties} />
    },
    {
      id: 'indexes', title: 'Indexes & Keys', layout: 'fill',
      ...idxsBadge,
      content: <CatalogListTab state={state} id="tableObjects" tabId="indexes" list={catalogReady?.tableObjects} part={state.catalog} connected={connected} service={tableProperties} />
    },
    {
      id: 'dependencies', title: 'Dependencies', layout: 'flow',
      ...depsBadge,
      content: <DependenciesTab state={state} part={state.dependencies} connectionId={connectionId} connected={connected} service={tableProperties} />
    },
    {
      id: 'permissions', title: 'Permissions & RLS', layout: 'flow',
      ...permsBadge,
      content: model ? <PermissionsTab state={state} model={model} /> : <ModelPlaceholder state={state} />
    },
    {
      id: 'extendedProperties', title: 'Extended Properties', layout: 'flow',
      ...extBadge,
      modified: modifiedTabs.has('extendedProperties'), problem: problemTabs.has('extendedProperties'),
      content: tabProps ? <ExtendedPropertiesTab {...tabProps} /> : <ModelPlaceholder state={state} />
    },
    {
      id: 'preview', title: 'Preview Rows', layout: 'fill',
      content: <PreviewRowsTab state={state} part={state.preview} connected={connected} service={tableProperties} />
    }
  ]

  return <FieldHints resetKey={state.activeTab}>
    <ObjectInspectorFrame
      id={`table-properties-${state.id}`}
      title={state.label}
      subtitle="Table Properties"
      state={headerState}
      crumbs={[
        { label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server },
        { label: displayText(state.target.database ?? '') },
        { label: 'Tables' }
      ]}
      surface="full"
      kpis={kpis}
      verbs={verbs}
      banner={banner}
      tabs={tabs}
      activeTab={state.activeTab}
      onSelectTab={id => tableProperties.selectTab(state.id, id as TableInspectorTabId)}
      vitals={model ? <TableVitals model={model} /> : undefined}
      attributes={{ 'data-table-properties': state.id }}
      script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void tableProperties.deliver(state.id, destination) }}
      scriptOpen={state.frame.scriptOpen}
      scriptSize={state.frame.scriptSize}
      onScriptToggle={() => tableProperties.setFrame(state.id, setScriptOpen(state.frame, !state.frame.scriptOpen))}
      onScriptResize={size => tableProperties.setFrame(state.id, resizeScript(state.frame, size))}
      hint={<FieldHintStrip />}
    />
  </FieldHints>
}
