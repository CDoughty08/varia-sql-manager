import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../../../shared/bigquery/cost'
import { bigQueryMaxDefinition, type BigQueryLabel, type BigQueryProperties } from '../../../shared/bigquery/objects'
import { maxClipboardText } from '../../../shared/contracts'
import { displayText, insertTextFor } from '../../../shared/explorer/refs'
import { onUnexpectedError } from '../core/errors'
import type { CommandArgs } from '../core/types'
import { requestFrame } from '../core/windows'
import { useServiceSelector, useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { createQueryEditor, type QueryEditorInstance } from '../editor/create-editor'
import { LocalGrid } from '../grid/LocalGrid'
import ResultsStack from '../grid/ResultsStack'
import Icon from '../Icon'
import CapabilityChips from '../kit/CapabilityChips'
import type { Verb } from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import FactGrid from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorTab } from '../kit/ObjectInspectorFrame'
import RatioBar from '../kit/RatioBar'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import { googleSqlLanguageId } from '../languages/googlesql'
import type { ExplorerMenuNode } from '../menus/targets'
import type { GridViewState } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { isLiveConnection } from '../services/connection-availability'
import type { LiveConnection } from '../services/connections'
import { settingsDocumentOptions } from '../services/documents'
import {
  allStructPaths, bigQueryCapabilities, bigQueryHeaderPills, bigQueryKpis, bigQueryLifecycleFacts,
  bigQueryOverviewFacts, bigQueryStorageFacts, bigQueryVitalsStorageFacts, countSchemaStats, flatColumnsToLocalTable,
  flattenSchemaRows, formatBigQuerySubtitle, hasColumnsTab, hasStorageOrLayout, schemaRowsToLocalTable,
  storageRatioSegments, supportsPreviewTab, type BigQueryPropertiesTabId
} from './bigquery-properties-format'
import type { BigQueryPropertiesView } from './BigQueryPropertiesService'
import { selectionContextOf } from './ExplorerService'
import { editorIdAttribute, peekEditorAttribute, peekEditorContextKey } from './peek-editor'

const copiedResetMs = 1500

const readOnlyGoogleSqlUse = {
  readOnly: { message: 'BigQuery Properties is read-only. Open in New Query to edit or run this SQL.' },
  compact: true,
  ariaLabel: 'Definition SQL',
  contextKey: peekEditorContextKey,
  inEditorPane: true,
  widgetHostAttribute: peekEditorAttribute
} as const

/** Read-only Monaco GoogleSQL editor mounted edge-to-edge inside a fill pane. */
function GoogleSqlReadOnlyEditor({ text }: { readonly text: string }) {
  const workbench = useWorkbench()
  const slotRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<{ readonly element: HTMLElement; readonly editor: QueryEditorInstance; readonly ownerDoc: Document } | undefined>(undefined)
  const modelRef = useRef<{ readonly text: string; readonly model: import('monaco-editor').editor.ITextModel } | undefined>(undefined)

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    if (hostRef.current && hostRef.current.ownerDoc !== slot.ownerDocument) {
      hostRef.current.editor.dispose()
      hostRef.current.element.remove()
      hostRef.current = undefined
    }
    let host = hostRef.current
    if (!host) {
      const element = slot.ownerDocument.createElement('div')
      element.className = 'peek-editor-host'
      element.setAttribute(peekEditorAttribute, '')
      slot.append(element)
      try {
        const editor = createQueryEditor(workbench, element, readOnlyGoogleSqlUse)
        element.setAttribute(editorIdAttribute, editor.instance.getId())
        host = hostRef.current = { element, editor, ownerDoc: slot.ownerDocument }
      } catch (error) {
        element.remove()
        onUnexpectedError(error)
        return
      }
    } else if (host.element.parentElement !== slot) {
      slot.append(host.element)
    }

    if (modelRef.current && modelRef.current.text === text) {
      if (host.editor.instance.getModel() !== modelRef.current.model) {
        host.editor.instance.setModel(modelRef.current.model)
      }
      return
    }
    const previous = modelRef.current
    let model: import('monaco-editor').editor.ITextModel | undefined
    try {
      const id = crypto.randomUUID()
      const uri = workbench.monaco.Uri.parse(`varia-googlesql://bq-properties/${id}`)
      model = workbench.monaco.editor.createModel(text, googleSqlLanguageId, uri)
      model.updateOptions(settingsDocumentOptions(() => workbench.settings.getSnapshot().values).modelOptions())
      host.editor.instance.setModel(model)
      modelRef.current = { text, model }
      previous?.model.dispose()
    } catch (error) {
      model?.dispose()
      onUnexpectedError(error)
    }
  }, [text, workbench])

  useEffect(() => () => {
    const host = hostRef.current
    hostRef.current = undefined
    if (host) {
      host.editor.instance.setModel(null)
      host.editor.dispose()
      host.element.remove()
    }
    modelRef.current?.model.dispose()
    modelRef.current = undefined
  }, [])

  return <div ref={slotRef} className="peek-editor" data-bq-definition-editor="" />
}

function useCopyFeedback() {
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    seq.current++
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  const copy = useCallback((id: string, label: string, text: string) => {
    const writer = typeof window !== 'undefined' ? window.varia?.writeClipboardText : undefined
    if (!writer || !text || text.length > maxClipboardText) return
    const token = ++seq.current
    let pending: Promise<{ ok: boolean }> | undefined
    try {
      pending = Promise.resolve(writer(text))
    } catch {
      return
    }
    void pending.then(result => {
      if (seq.current !== token || !result?.ok) return
      setCopiedId(id)
      setAnnouncement(token % 2 === 0 ? `Copied ${label}` : `Copied ${label}\u200B`)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined
        if (seq.current === token) setCopiedId(undefined)
      }, copiedResetMs)
    }, () => {})
  }, [])

  return { copiedId, announcement, copy }
}

function OverviewPane({ view }: { readonly view: BigQueryPropertiesView }) {
  const idBase = useId()
  const { value } = view
  if (!value) {
    if (view.loading) return <Skeleton rows={6} label="Loading BigQuery properties" />
    return <p className="bq-props-muted">Properties could not be loaded for this object.</p>
  }
  const hasStructured = value.fullName !== undefined || value.location !== undefined || value.createdUtc !== undefined
    || value.modifiedUtc !== undefined || value.storage !== undefined || value.layout !== undefined || value.schema !== undefined
    || value.labels !== undefined || value.definition !== undefined || value.description !== undefined
  const overviewFacts = bigQueryOverviewFacts(view, value)
  const capabilities = bigQueryCapabilities(view.kind, value, view.subtype)
  const legacyGroups = !hasStructured ? value.groups : []

  const identityId = `${idBase}-identity`
  const capabilitiesId = `${idBase}-capabilities`
  const descriptionId = `${idBase}-description`

  return <div className="bq-props-flow">
    <section aria-labelledby={identityId}>
      <h2 id={identityId} className="bq-props-subhead">Identity &amp; Lifecycle</h2>
      <FactGrid facts={overviewFacts} />
    </section>

    {capabilities.length > 0 && <section aria-labelledby={capabilitiesId}>
      <h2 id={capabilitiesId} className="bq-props-subhead">Capabilities &amp; Flags</h2>
      <CapabilityChips items={capabilities} label="Capabilities and flags" />
    </section>}

    {value.description && <section aria-labelledby={descriptionId}>
      <h2 id={descriptionId} className="bq-props-subhead">Description</h2>
      <p className="bq-props-description">{value.description}</p>
    </section>}

    {legacyGroups.map(group => <section key={group.title} aria-label={group.title}>
      <h2 className="bq-props-subhead">{group.title}</h2>
      <FactGrid facts={group.facts.map((fact, idx) => ({ id: `${group.title}-${idx}`, label: fact.label, value: fact.value }))} />
    </section>)}
  </div>
}

function DefinitionPane({ documentId, view, connection, live }: {
  readonly documentId: string
  readonly view: BigQueryPropertiesView
  readonly connection: LiveConnection | undefined
  readonly live: boolean
}) {
  const { bigQueryProperties, documents } = useWorkbench()
  const { copiedId, announcement, copy } = useCopyFeedback()
  const freeSql = view.value?.definition
  const ddl = view.ddl
  const sqlText = freeSql ?? (ddl?.status === 'ready' ? ddl.text : undefined)
  const truncated = freeSql !== undefined && !!(view.value?.definitionTruncated || view.value?.definitionCut)
  const canCopy = sqlText !== undefined && sqlText.length > 0 && sqlText.length <= maxClipboardText
  const canOpenQuery = sqlText !== undefined && sqlText.length > 0 && live

  const openInNewQuery = () => {
    if (!sqlText || !live) return
    const dataset = view.project === connection?.server ? view.dataset : (connection?.database ?? '')
    documents.newQuery(sqlText, undefined, view.connectionId, dataset, false)
    requestFrame(() => documents.boundEditor?.focus())
  }

  const metadataPending = !view.value && view.loading
  const metadataFailed = !view.value && !!view.error
  const sourceLabel = freeSql !== undefined
    ? 'Free · tables.get'
    : metadataPending
      ? 'Loading metadata…'
      : 'On-demand · INFORMATION_SCHEMA.TABLES'
  const titleLabel = freeSql !== undefined ? 'GoogleSQL Definition' : 'GoogleSQL DDL'

  return <>
    <div className="bq-props-fill-toolbar">
      <span className="bq-props-toolbar-title">{titleLabel}</span>
      <StatusPill tone="neutral" size="small" icon={null} label={sourceLabel} />
      <span className="bq-props-toolbar-spacer" />
      <button type="button" className="bq-props-tool-btn" disabled={!canCopy}
        title={sqlText && sqlText.length > maxClipboardText ? 'The definition is too long for the clipboard.' : 'Copy SQL to clipboard'}
        onClick={() => { if (sqlText) copy('definition', 'definition SQL', sqlText) }}>
        <Icon name={copiedId === 'definition' ? 'check' : 'copy'} />
        <span>{copiedId === 'definition' ? 'Copied' : 'Copy'}</span>
      </button>
      <button type="button" className="bq-props-tool-btn outline" disabled={!canOpenQuery}
        title={live ? 'Open SQL in a new GoogleSQL query tab' : 'Reconnect to open in a query tab'}
        onClick={openInNewQuery}>
        <Icon name="file-code" />
        <span>Open in New Query</span>
      </button>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>

    {truncated && <div className="bq-props-notice" role="status">
      <Icon name="info" />
      <span>This definition was truncated at {formatCount(bigQueryMaxDefinition)} characters. Use Script As › CREATE to read the complete statement.</span>
    </div>}

    {ddl?.status === 'ready' && ddl.warnings.length > 0 && <div className="bq-props-notice" role="status">
      <Icon name="warning" />
      <span>{ddl.warnings.join(' ')}</span>
    </div>}

    {sqlText !== undefined
      ? <GoogleSqlReadOnlyEditor text={sqlText} />
      : metadataPending
        ? <div className="bq-props-center" role="status">
          <p className="bq-props-loading-row"><Icon name="loading" spin /><span>Loading object metadata…</span></p>
        </div>
        : metadataFailed
          ? <div className="bq-props-center">
            <InlineError message={view.error!} context={`Properties - ${view.project}.${view.dataset}.${view.name}`}
              actions={live ? [{ label: 'Retry', run: () => { void bigQueryProperties.refresh(documentId) } }] : []} />
          </div>
          : ddl?.status === 'loading'
            ? <div className="bq-props-center" role="status">
              <p className="bq-props-loading-row"><Icon name="loading" spin /><span>{ddl.phase === 'estimating' ? 'Estimating CREATE statement query…' : 'Loading CREATE statement…'}</span></p>
              <button type="button" className="bq-props-tool-btn outline" onClick={() => bigQueryProperties.cancelDdl(documentId)}>Cancel</button>
            </div>
            : ddl?.status === 'error'
              ? <div className="bq-props-center">
                <InlineError message={ddl.message} context={`Load DDL - ${view.project}.${view.dataset}.${view.name}`}
                  actions={live ? [{ label: 'Retry', run: () => { void bigQueryProperties.loadDdl(documentId) } }] : []} />
              </div>
              : <div className="bq-props-center">
                <EmptyState icon="file-code" title="Load CREATE statement on demand"
                  detail="BigQuery bills INFORMATION_SCHEMA.TABLES to read a table's CREATE statement (typically at the 10 MiB minimum). Varia runs a free dry-run estimate first and applies your cost prompts before running."
                  actions={[{
                    label: 'Load DDL',
                    primary: true,
                    disabled: !bigQueryProperties.canLoadDdl(documentId),
                    run: () => { void bigQueryProperties.loadDdl(documentId) }
                  }]} />
              </div>}
  </>
}

function StoragePane({ value }: { readonly value: BigQueryProperties }) {
  const detailsId = `${useId()}-storage-details`
  const ratio = storageRatioSegments(value.storage)
  const facts = bigQueryStorageFacts(value)
  return <div className="bq-props-flow">
    {ratio.length > 0 && value.storage?.logicalBytes !== undefined && (
      <RatioBar title="Active vs. Long-Term Logical Storage" totalLabel={formatBytes(value.storage.logicalBytes)} segments={ratio} />
    )}
    {facts.length > 0 && <section aria-labelledby={detailsId}>
      <h2 id={detailsId} className="bq-props-subhead">Storage &amp; Layout</h2>
      <FactGrid facts={facts} />
    </section>}
  </div>
}

function ColumnsPane({ view, value }: { readonly view: BigQueryPropertiesView; readonly value: BigQueryProperties }) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [activePath, setActivePath] = useState<string | undefined>(undefined)
  const gridState = useMemo<GridViewState>(() => ({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }), [])

  const schema = value.schema?.length ? value.schema : undefined
  const structPaths = useMemo(() => allStructPaths(schema), [schema])
  const filtering = filter.trim().length > 0
  const flattened = useMemo(
    () => schema ? flattenSchemaRows(schema, { filter, expanded, partitioning: value.layout?.partitioning, clustering: value.layout?.clustering }) : undefined,
    [schema, filter, expanded, value.layout?.partitioning, value.layout?.clustering]
  )
  const table = useMemo(
    () => flattened ? schemaRowsToLocalTable(flattened, filtering) : flatColumnsToLocalTable(value.columns ?? [], filter),
    [flattened, filtering, value.columns, filter]
  )

  const toggleStruct = useCallback((path: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  const allExpanded = structPaths.length > 0 && structPaths.every(path => expanded.has(path))
  const anyExpanded = structPaths.some(path => expanded.has(path))
  const toggleAllStructs = () => setExpanded(allExpanded ? new Set() : new Set(structPaths))

  const handleActiveRow = useCallback((rowIndex: number | undefined) => {
    setActivePath(rowIndex !== undefined && flattened ? flattened[rowIndex]?.path : undefined)
  }, [flattened])
  const activeSchemaRow = !filtering && flattened && activePath !== undefined
    ? flattened.find(row => row.path === activePath)
    : undefined
  const handleActivateRow = useCallback((rowIndex: number) => {
    if (filtering || !flattened) return false
    const row = flattened[rowIndex]
    if (!row?.hasChildren) return false
    toggleStruct(row.path)
    return true
  }, [filtering, flattened, toggleStruct])

  const stats = useMemo(() => countSchemaStats(schema), [schema])
  const totalCount = schema ? stats.topLevel : (value.columns?.length ?? 0)
  const shownCount = table.rows.length
  const countText = filtering
    ? `${formatCount(shownCount)} shown`
    : schema && anyExpanded
      ? `${formatCount(shownCount)} rows (${formatCount(totalCount)} top-level)`
      : `${formatCount(totalCount)} ${plural(totalCount, 'column')}`
  const truncated = schema ? !!value.schemaTruncated : !!value.columnsCut

  return <>
    <div className="bq-props-fill-toolbar">
      <div className="bq-props-search">
        <Icon name="search" />
        <input type="search" aria-label="Filter columns" placeholder="Filter columns or types…" value={filter} onChange={event => setFilter(event.target.value)} />
      </div>
      <span className="bq-props-toolbar-meta">{countText}</span>
      <span className="bq-props-toolbar-spacer" />
      {structPaths.length > 0 && !filtering && <>
        {activeSchemaRow?.hasChildren && (
          <button type="button" className="bq-props-tool-btn" onClick={() => toggleStruct(activeSchemaRow.path)}>
            <Icon name={activeSchemaRow.expanded ? 'chevron-down' : 'chevron-right'} />
            <span>{activeSchemaRow.expanded ? `Collapse ${activeSchemaRow.name}` : `Expand ${activeSchemaRow.name}`}</span>
          </button>
        )}
        <button type="button" className="bq-props-tool-btn" onClick={toggleAllStructs}
          title={allExpanded ? 'Collapse all nested STRUCT fields' : 'Expand all nested STRUCT fields'}>
          <Icon name={allExpanded ? 'collapse-all' : 'list-tree'} />
          <span>{allExpanded ? 'Collapse all' : 'Expand all'}</span>
        </button>
      </>}
    </div>

    {truncated && <div className="bq-props-notice" role="status">
      <Icon name="info" />
      <span>Some deeply nested fields or columns past the display limit were omitted.</span>
    </div>}

    <LocalGrid table={table} label="Columns" preset="page" empty={filtering ? 'No columns match the filter.' : 'This object has no columns.'}
      suggestedName={`${view.name} Columns`} sortable={structPaths.length === 0} state={gridState}
      onActiveRow={handleActiveRow} onActivateRow={handleActivateRow} />
  </>
}

function LabelsPane({ labels }: { readonly labels: readonly BigQueryLabel[] }) {
  const { copiedId, announcement, copy } = useCopyFeedback()
  const allText = useMemo(() => labels.map(label => `${label.key}=${label.value}`).join('\n'), [labels])

  return <div className="bq-props-flow">
    <div className="bq-props-labels-head">
      <h2 className="bq-props-subhead">Labels ({formatCount(labels.length)})</h2>
      <button type="button" className="bq-props-tool-btn" onClick={() => copy('all-labels', 'all labels', allText)}>
        <Icon name={copiedId === 'all-labels' ? 'check' : 'copy'} />
        <span>{copiedId === 'all-labels' ? 'Copied' : 'Copy all'}</span>
      </button>
    </div>
    <ul className="bq-label-chips" aria-label="Labels">
      {labels.map(label => {
        const pair = `${label.key}=${label.value}`
        const isCopied = copiedId === label.key
        return <li key={label.key} className="bq-label-chip" title={pair}>
          <span className="bq-label-key">{label.key}</span>
          <span className="bq-label-val">{label.value || '—'}</span>
          <button type="button" className={isCopied ? 'bq-label-copy copied' : 'bq-label-copy'}
            aria-label={isCopied ? `Copied label ${label.key}` : `Copy label ${label.key}`}
            title={isCopied ? 'Copied' : `Copy ${pair}`}
            onClick={() => copy(label.key, `label ${label.key}`, pair)}>
            <Icon name={isCopied ? 'check' : 'copy'} />
          </button>
        </li>
      })}
    </ul>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>
}

function PreviewPane({ documentId, view, live }: { readonly documentId: string; readonly view: BigQueryPropertiesView; readonly live: boolean }) {
  const { bigQueryProperties, results } = useWorkbench()
  const preview = view.preview
  const key = preview?.status === 'ready' ? preview.key : undefined
  const tab = useServiceSelector(results, all => key === undefined ? undefined : all[key])

  return <>
    <div className="bq-props-fill-toolbar">
      <span className="bq-props-toolbar-title">Preview Rows</span>
      <StatusPill tone="success" size="small" icon={null} label="Free · tabledata.list (0 B billed)" />
      <span className="bq-props-toolbar-spacer" />
      <button type="button" className="bq-props-tool-btn" disabled={!live || preview?.status === 'loading'}
        onClick={() => { void bigQueryProperties.reloadPreview(documentId) }}>
        <Icon name="refresh" />
        <span>Reload</span>
      </button>
    </div>

    {!preview || preview.status === 'loading'
      ? <div className="bq-props-center" role="status">
        <p className="bq-props-loading-row"><Icon name="loading" spin /><span>Reading preview rows via tabledata.list…</span></p>
        {preview?.status === 'loading' && <button type="button" className="bq-props-tool-btn outline" onClick={() => bigQueryProperties.cancelPreview(documentId)}>Cancel</button>}
      </div>
      : preview.status === 'error'
        ? <div className="bq-props-center">
          <InlineError message={preview.message} context={`Preview Rows - ${view.project}.${view.dataset}.${view.name}`}
            actions={live ? [{ label: 'Retry', run: () => { void bigQueryProperties.reloadPreview(documentId) } }] : []} />
        </div>
        : !tab?.sets.length
          ? <div className="bq-props-center"><p className="bq-props-muted">Preview rows are no longer available.</p></div>
          : <div className="peek-rows" data-bq-preview-rows="">
            <ResultsStack tabId={preview.key} tab={tab} />
            {preview.rowsRead === 0 && <p className="bq-props-empty-note">This table has no rows.</p>}
          </div>}
  </>
}

function VitalsRail({ value }: { readonly value: BigQueryProperties }) {
  const ratio = storageRatioSegments(value.storage)
  const storageFacts = bigQueryVitalsStorageFacts(value)
  const lifecycleFacts = bigQueryLifecycleFacts(value)
  return <>
    {ratio.length > 0 && value.storage?.logicalBytes !== undefined && (
      <div className="vitals-block">
        <h3 className="vitals-block-title">Logical Storage</h3>
        <RatioBar flat title="Active vs. Long-Term" totalLabel={formatBytes(value.storage.logicalBytes)} segments={ratio} />
      </div>
    )}
    {storageFacts.length > 0 && (
      <div className="vitals-block">
        <h3 className="vitals-block-title">Storage &amp; Layout</h3>
        <FactGrid compact facts={storageFacts} />
      </div>
    )}
    {lifecycleFacts.length > 0 && (
      <div className="vitals-block">
        <h3 className="vitals-block-title">Lifecycle</h3>
        <FactGrid compact facts={lifecycleFacts} />
      </div>
    )}
  </>
}

function explorerNodeFor(view: BigQueryPropertiesView, live: boolean): ExplorerMenuNode {
  const rawType = view.value?.type?.trim().toLowerCase()
  const subtype = view.subtype ?? (rawType === 'snapshot' ? 'snapshot' : rawType === 'clone' ? 'clone' : undefined)
  return {
    id: 0,
    connectionId: view.connectionId,
    lost: !live,
    provider: 'bigquery',
    kind: view.kind,
    ...(subtype ? { subtype } : {}),
    label: view.name,
    ref: { type: 'object', object: { kind: view.kind, project: view.project, dataset: view.dataset, name: view.name } }
  }
}

/**
 * BigQuery's Properties tab (OP-2b): unified `ObjectInspectorFrame` (`surface="full"`) presenting structured
 * `tables.get` metadata across canonical tabs (Overview, Definition, Storage & Layout, Columns, Labels, Preview Rows),
 * Hero KPIs, and a collapsible/resizable Vitals rail. Zero billed SQL runs automatically.
 */
export default function BigQueryPropertiesTab({ documentId }: { readonly documentId: string }) {
  const { bigQueryProperties, connections } = useWorkbench()
  const view = useServiceSnapshot(bigQueryProperties).views[documentId]
  const connectionList = useServiceSnapshot(connections)
  if (!view) return null

  const connection = connectionList.find(item => item.id === view.connectionId)
  const live = isLiveConnection(connection)
  const value = view.value
  const crumbs = [
    { label: connection?.displayName || connection?.server || 'Not connected' },
    { label: view.project },
    { label: view.dataset }
  ]
  const subtitle = formatBigQuerySubtitle(view.kind, value?.type, view.subtype)
  const pills = bigQueryHeaderPills(view.kind, value, view.subtype)
  const state = <span className="bq-props-pills">
    <StatusPill tone="neutral" variant="tag" size="small" label="BigQuery" />
    {pills.map(pill => <StatusPill key={pill.id} tone={pill.tone} size="small" icon={null} label={pill.label} title={pill.title} />)}
  </span>

  const node = explorerNodeFor(view, live)
  const scriptArgs: CommandArgs = {
    target: { kind: 'explorer', node },
    state: selectionContextOf(live ? node : undefined, { insertable: insertTextFor(node.ref) !== undefined })
  }
  const verbs: Verb[] = [{ command: 'explorer.scriptAs', args: scriptArgs, label: 'Script As…' }]
  const refreshTool = (
    <button type="button" className="document-verb" aria-label="Refresh" title="Refresh" disabled={!live || view.loading}
      onClick={() => { void bigQueryProperties.refresh(documentId) }}>
      <Icon name="refresh" spin={view.loading} />
      <span className="document-verb-label">Refresh</span>
    </button>
  )

  const kpis = bigQueryKpis(value)
  const schemaStats = countSchemaStats(value?.schema)
  const columnCount = value?.schema?.length ? schemaStats.topLevel : value?.columns?.length
  const labelCount = value?.labels?.length ?? 0

  const tabs: InspectorTab[] = [
    { id: 'overview', title: 'Overview', layout: 'flow', content: <OverviewPane view={view} /> },
    { id: 'definition', title: 'Definition', layout: 'fill', content: <DefinitionPane documentId={documentId} view={view} connection={connection} live={live} /> },
    ...value && hasStorageOrLayout(value) ? [{ id: 'storage', title: 'Storage & Layout', layout: 'flow' as const, content: <StoragePane value={value} /> }] : [],
    ...value && hasColumnsTab(value) ? [{
      id: 'columns',
      title: 'Columns',
      layout: 'fill' as const,
      count: columnCount,
      countLabel: columnCount !== undefined ? `${formatCount(columnCount)} ${plural(columnCount, 'column')}` : undefined,
      content: <ColumnsPane view={view} value={value} />
    }] : [],
    ...value && labelCount > 0 ? [{
      id: 'labels',
      title: 'Labels',
      layout: 'flow' as const,
      count: labelCount,
      countLabel: `${formatCount(labelCount)} ${plural(labelCount, 'label')}`,
      content: <LabelsPane labels={value.labels!} />
    }] : [],
    ...supportsPreviewTab(view.kind) ? [{ id: 'preview', title: 'Preview Rows', layout: 'fill' as const, content: <PreviewPane documentId={documentId} view={view} live={live} /> }] : []
  ]

  const hasVitals = !!value && (
    storageRatioSegments(value.storage).length > 0
    || bigQueryVitalsStorageFacts(value).length > 0
    || bigQueryLifecycleFacts(value).length > 0
  )

  const banner = view.error
    ? <InlineError message={view.error} context={`BigQuery Properties - ${view.project}.${view.dataset}.${view.name}`}
      actions={live ? [{ label: 'Retry', run: () => { void bigQueryProperties.refresh(documentId) } }] : []} />
    : undefined

  return <ObjectInspectorFrame
    id={`bq-properties-${documentId}`}
    title={displayText(view.name)}
    subtitle={subtitle}
    crumbs={crumbs}
    state={state}
    tools={refreshTool}
    verbs={verbs}
    surface="full"
    kpis={kpis}
    banner={banner}
    tabs={tabs}
    activeTab={view.activeTab}
    onSelectTab={id => bigQueryProperties.selectTab(documentId, id as BigQueryPropertiesTabId)}
    vitals={hasVitals ? <VitalsRail value={value} /> : undefined}
    attributes={{ 'data-bigquery-properties': documentId }}
  />
}
