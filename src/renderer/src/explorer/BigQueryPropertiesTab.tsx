import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame from '../kit/DocumentFrame'

/** BigQuery's Properties tab: the object's facts in groups (Table, Storage, Layout, History), read-only, with Refresh. */
export default function BigQueryPropertiesTab({ documentId }: { readonly documentId: string }) {
  const { bigQueryProperties, connections } = useWorkbench()
  const view = useServiceSnapshot(bigQueryProperties).views[documentId]
  const connectionList = useServiceSnapshot(connections)
  if (!view) return null
  const connection = connectionList.find(item => item.id === view.connectionId)
  const crumbs = [{ label: connection?.displayName || connection?.server || 'Not connected' }, { label: view.project }, { label: view.dataset }]
  const refresh = <button type="button" className="icon-button" aria-label="Refresh" title="Refresh" disabled={view.loading} onClick={() => { void bigQueryProperties.refresh(documentId) }}><Icon name="refresh" /></button>
  return <DocumentFrame id={`bq-properties-${documentId}`} title={view.name} subtitle={view.value ? view.value.type : kindSpecs[view.kind].title} crumbs={crumbs} tools={refresh}
    attributes={{ 'data-bigquery-properties': documentId }}>
    <div className="properties-page" role="region" aria-label="Properties" aria-busy={view.loading} tabIndex={-1}>
      {view.error && <p role="alert">{view.error}</p>}
      {!view.value && view.loading && <p>Loading properties…</p>}
      {view.value?.groups.map(group => <section key={group.title} aria-label={group.title}>
        <h3 className="properties-group-title">{group.title}</h3>
        <dl className="property-facts">{group.facts.map(fact => [<dt key={fact.label + ':label'}>{fact.label}</dt>, <dd key={fact.label + ':value'}>{fact.value}</dd>])}</dl>
      </section>)}
    </div>
  </DocumentFrame>
}
