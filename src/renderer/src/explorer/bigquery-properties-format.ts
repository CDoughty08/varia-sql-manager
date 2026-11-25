import { formatBytes } from '../../../shared/bigquery/cost'
import { bigQueryPath, isBigQueryName } from '../../../shared/bigquery/names'
import type {
  BigQueryLayoutInfo, BigQueryProperties, BigQueryPropertyKind, BigQueryRoutineArgument,
  BigQuerySchemaField, BigQueryStorageInfo
} from '../../../shared/bigquery/objects'
import { kindSpecs, type NodeSubtype } from '../../../shared/explorer/catalog'
import type { ObjectRef } from '../../../shared/explorer/refs'
import type { LocalTableData } from '../../../shared/results/local-table'
import type { StatusTone } from '../../../shared/theme/tones'
import type { CapabilityItem } from '../kit/CapabilityChips'
import type { FactItem } from '../kit/FactGrid'
import type { InspectorKpi } from '../kit/ObjectInspectorFrame'
import type { RatioSegment } from '../kit/RatioBar'
import { formatCount, plural } from '../results/status'

/** Canonical tab ids for BigQuery Properties & Peek, in owner-agreed inspector order. */
export const bigQueryPropertiesTabIds = ['overview', 'definition', 'storage', 'columns', 'parameters', 'labels', 'preview'] as const
export type BigQueryPropertiesTabId = typeof bigQueryPropertiesTabIds[number]
export const isBigQueryPropertiesTabId = (tab: string): tab is BigQueryPropertiesTabId =>
  (bigQueryPropertiesTabIds as readonly string[]).includes(tab)

export interface BigQueryHeaderPill {
  readonly id: string
  readonly label: string
  readonly tone: StatusTone
  readonly title?: string
}

export interface BigQuerySchemaStats {
  readonly topLevel: number
  readonly total: number
  readonly structCount: number
}

export interface FlattenedSchemaRow {
  readonly path: string
  readonly name: string
  readonly depth: number
  readonly type: string
  readonly mode: string
  readonly badges: readonly string[]
  readonly description: string | null
  readonly hasChildren: boolean
  readonly childCount: number
  readonly expanded: boolean
}

const typeTitles: Readonly<Record<string, string>> = {
  table: 'Native Table',
  snapshot: 'Table Snapshot',
  clone: 'Table Clone',
  view: 'View',
  'materialized view': 'Materialized View',
  'external table': 'External Table',
  function: 'Scalar Function',
  procedure: 'Stored Procedure',
  'table function': 'Table-Valued Function',
  'aggregate function': 'Aggregate Function',
  dataset: 'Dataset',
  external: 'External Dataset'
}

const kindSubtitles: Readonly<Record<BigQueryPropertyKind, string>> = {
  bqTable: 'BigQuery Table',
  bqView: 'BigQuery View',
  bqMaterializedView: 'BigQuery Materialized View',
  bqExternalTable: 'BigQuery External Table',
  bqRoutine: 'BigQuery Routine',
  bqDataset: 'BigQuery Dataset'
}

/** Human-readable BigQuery object type for the Overview fact grid. */
export function formatBigQueryType(kind: BigQueryPropertyKind, rawType?: string): string {
  const trimmed = rawType?.trim()
  const key = trimmed?.toLowerCase()
  if (key && Object.hasOwn(typeTitles, key)) return typeTitles[key]!
  if (trimmed) return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return kindSpecs[kind].title
}

/** Subtitle shown next to the title in the ObjectInspectorFrame header. */
export function formatBigQuerySubtitle(kind: BigQueryPropertyKind, rawType?: string, subtype?: NodeSubtype): string {
  const key = rawType?.trim().toLowerCase()
  if (key === 'snapshot' || subtype === 'snapshot') return 'BigQuery Snapshot'
  if (key === 'clone' || subtype === 'clone') return 'BigQuery Clone'
  if (kind === 'bqRoutine') {
    if (key === 'procedure' || subtype === 'procedure') return 'BigQuery Procedure'
    if (key === 'table function' || subtype === 'tableValued') return 'BigQuery Table Function'
    if (key === 'aggregate function') return 'BigQuery Aggregate Function'
    if (key === 'function') return 'BigQuery Function'
  }
  return kindSubtitles[kind]
}

/** Formats a BigQuery duration in milliseconds (e.g. default table/partition expiration) cleanly. */
export function formatExpirationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'None'
  const dayMs = 86_400_000
  const hourMs = 3_600_000
  if (ms >= dayMs) {
    const days = ms / dayMs
    const text = Number.isInteger(days) ? formatCount(days) : Number(days.toFixed(2)).toString()
    return `${text} ${days === 1 ? 'day' : 'days'}`
  }
  if (ms >= hourMs) {
    const hours = ms / hourMs
    const text = Number.isInteger(hours) ? formatCount(hours) : Number(hours.toFixed(2)).toString()
    return `${text} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `${formatCount(minutes)} ${minutes === 1 ? 'min' : 'mins'}`
}

/** Formats BigQuery routine determinism level into readable text. */
export function formatDeterminismLabel(level?: string): string | undefined {
  if (!level) return undefined
  const upper = level.trim().toUpperCase()
  if (upper === 'DETERMINISTIC') return 'Deterministic'
  if (upper === 'NOT_DETERMINISTIC') return 'Non-deterministic'
  return upper ? level : undefined
}

function parseBigQueryTablePath(fullName?: string): { readonly project: string; readonly dataset: string; readonly name: string } | undefined {
  if (!fullName) return undefined
  const parts = fullName.split('.')
  if (parts.length !== 3) return undefined
  const [project, dataset, name] = parts
  if (!isBigQueryName('project', project!) || !isBigQueryName('dataset', dataset!) || !isBigQueryName('table', name!)) return undefined
  return { project: project!, dataset: dataset!, name: name! }
}

/** Active logical bytes (total logical minus long-term logical, clamped at 0). */
export function activeLogicalBytes(storage?: BigQueryStorageInfo): number | undefined {
  if (storage?.logicalBytes === undefined) return undefined
  if (storage.longTermLogicalBytes === undefined) return storage.logicalBytes
  return Math.max(0, storage.logicalBytes - storage.longTermLogicalBytes)
}

/** Logical-to-physical compression ratio (e.g. "4.4×") when both figures are positive. */
export function compressionRatio(storage?: BigQueryStorageInfo): string | undefined {
  if (!storage?.logicalBytes || storage.logicalBytes <= 0 || !storage.physicalBytes || storage.physicalBytes <= 0) return undefined
  const ratio = storage.logicalBytes / storage.physicalBytes
  return `${ratio.toFixed(1)}×`
}

/** Active vs. Long-Term logical storage segments for RatioBar when both figures are reported and total > 0. */
export function storageRatioSegments(storage?: BigQueryStorageInfo): readonly RatioSegment[] {
  if (storage?.logicalBytes === undefined || storage.logicalBytes <= 0 || storage.longTermLogicalBytes === undefined) return []
  const longTerm = Math.min(storage.logicalBytes, Math.max(0, storage.longTermLogicalBytes))
  const active = Math.max(0, storage.logicalBytes - longTerm)
  return [
    { id: 'active', label: 'Active logical', value: active, displayValue: formatBytes(active), series: 1 },
    { id: 'longTerm', label: 'Long-term', value: longTerm, displayValue: formatBytes(longTerm), series: 3 }
  ]
}

/** Counts top-level columns, total fields (including nested), and fields that contain nested STRUCT/RECORD children. */
export function countSchemaStats(schema?: readonly BigQuerySchemaField[]): BigQuerySchemaStats {
  if (!schema?.length) return { topLevel: 0, total: 0, structCount: 0 }
  let total = 0
  let structCount = 0
  const stack: (readonly BigQuerySchemaField[])[] = [schema]
  while (stack.length > 0) {
    const list = stack.pop()!
    for (let i = 0; i < list.length; i++) {
      const field = list[i]
      total++
      if (field.fields && field.fields.length > 0) {
        structCount++
        stack.push(field.fields)
      }
    }
  }
  return { topLevel: schema.length, total, structCount }
}

/** Extracts the partitioning column name from BigQueryService's formatted partitioning string (ignoring _PARTITIONTIME). */
export function partitionColumnName(partitioning?: string): string | undefined {
  if (!partitioning) return undefined
  const match = /\bon\s+([^,\s]+)/i.exec(partitioning)
  const column = match?.[1]?.trim()
  if (!column || column.toUpperCase() === '_PARTITIONTIME') return undefined
  return column
}

/** Short partitioning label for a semantic header pill ("Partitioned · DAY", "Partitioned · Range", etc.). */
export function shortPartitionLabel(partitioning: string): string {
  if (/^integer range\b/i.test(partitioning)) return 'Partitioned · Range'
  const kind = /^(HOUR|DAY|MONTH|YEAR)\s+on\b/i.exec(partitioning)?.[1]
  return kind ? `Partitioned · ${kind.toUpperCase()}` : 'Partitioned'
}

/** Semantic StatusPills displayed beside the BigQuery engine badge in the inspector header. */
export function bigQueryHeaderPills(kind: BigQueryPropertyKind, value?: BigQueryProperties, subtype?: NodeSubtype): readonly BigQueryHeaderPill[] {
  const pills: BigQueryHeaderPill[] = []
  const rawType = value?.type?.trim().toLowerCase()
  if (rawType === 'snapshot' || subtype === 'snapshot') pills.push({ id: 'snapshot', label: 'Snapshot', tone: 'info' })
  else if (rawType === 'clone' || subtype === 'clone') pills.push({ id: 'clone', label: 'Clone', tone: 'info' })
  else if (kind === 'bqExternalTable' || rawType === 'external table') pills.push({ id: 'external', label: 'External', tone: 'neutral' })
  else if (kind === 'bqMaterializedView') pills.push({ id: 'mv', label: 'Materialized View', tone: 'info' })

  if (kind === 'bqRoutine') {
    const routine = value?.routine
    if (routine?.language) pills.push({ id: 'language', label: routine.language, tone: 'info' })
    const det = formatDeterminismLabel(routine?.determinism)
    if (det) pills.push({ id: 'determinism', label: det, tone: det === 'Deterministic' ? 'success' : 'warning' })
    return pills
  }

  if (kind === 'bqDataset') {
    if (value?.location) pills.push({ id: 'location', label: value.location, tone: 'neutral' })
    const ds = value?.dataset
    if (ds?.kmsKeyName) pills.push({ id: 'cmek', label: 'CMEK', tone: 'info', title: `Customer-managed encryption key: ${ds.kmsKeyName}` })
    if (ds?.storageBillingModel === 'PHYSICAL') pills.push({ id: 'billing', label: 'Physical billing', tone: 'info' })
    if (ds?.isCaseInsensitive) pills.push({ id: 'ci', label: 'Case-insensitive', tone: 'neutral' })
    return pills
  }

  const layout = value?.layout
  if (layout?.partitioning) pills.push({ id: 'partitioned', label: shortPartitionLabel(layout.partitioning), tone: 'running', title: layout.partitioning })
  if (layout?.requirePartitionFilter) pills.push({ id: 'requireFilter', label: 'Require partition filter', tone: 'warning', title: 'Queries must include a filter over the partitioning column.' })
  if (layout?.clustering?.length) {
    pills.push({
      id: 'clustered',
      label: `Clustered (${layout.clustering.length})`,
      tone: 'neutral',
      title: `Clustered by ${layout.clustering.join(', ')}`
    })
  }
  return pills
}

/** Hero KPI strip items for Full view; omits metrics that do not apply (e.g. storage on views). */
export function bigQueryKpis(value?: BigQueryProperties): readonly InspectorKpi[] {
  if (!value) return []
  const kpis: InspectorKpi[] = []
  if (value.routine) {
    const routine = value.routine
    if (routine.language) kpis.push({ id: 'language', label: 'Language', value: routine.language })
    if (routine.returnType) kpis.push({ id: 'returns', label: 'Returns', value: routine.returnType })
    if (routine.arguments) {
      const count = routine.arguments.length
      kpis.push({ id: 'parameters', label: 'Parameters', value: routine.argumentsTruncated ? `${formatCount(count)}+` : formatCount(count) })
    }
    const det = formatDeterminismLabel(routine.determinism)
    if (det) kpis.push({ id: 'determinism', label: 'Determinism', value: det })
    return kpis
  }
  if (value.dataset) {
    const ds = value.dataset
    if (value.location) kpis.push({ id: 'location', label: 'Location', value: value.location })
    if (ds.defaultTableExpirationMs !== undefined) kpis.push({ id: 'tableExpiry', label: 'Default table expiry', value: formatExpirationMs(ds.defaultTableExpirationMs) })
    if (ds.maxTimeTravelHours !== undefined) kpis.push({ id: 'timeTravel', label: 'Time travel', value: `${formatCount(ds.maxTimeTravelHours)} h` })
    if (ds.storageBillingModel) kpis.push({ id: 'billing', label: 'Billing model', value: ds.storageBillingModel === 'PHYSICAL' ? 'Physical' : ds.storageBillingModel === 'LOGICAL' ? 'Logical' : ds.storageBillingModel })
    if (value.labels?.length) kpis.push({ id: 'labels', label: 'Labels', value: formatCount(value.labels.length) })
    return kpis
  }
  const storage = value.storage
  if (storage?.rows !== undefined) {
    kpis.push({ id: 'rows', label: 'Rows', value: formatCount(storage.rows) })
  }
  if (storage?.logicalBytes !== undefined) {
    const ratio = storageRatioSegments(storage)
    const active = activeLogicalBytes(storage)
    const title = ratio.length > 0 && active !== undefined && storage.longTermLogicalBytes !== undefined
      ? `Logical size: ${formatBytes(storage.logicalBytes)} (Active ${formatBytes(active)}, Long-term ${formatBytes(storage.longTermLogicalBytes)})`
      : `Logical size: ${formatBytes(storage.logicalBytes)}`
    kpis.push({ id: 'logical', label: 'Logical', value: formatBytes(storage.logicalBytes), title, ...(ratio.length > 0 ? { ratio } : {}) })
  }
  if (storage?.physicalBytes !== undefined) {
    const comp = compressionRatio(storage)
    kpis.push({
      id: 'physical',
      label: 'Physical',
      value: formatBytes(storage.physicalBytes),
      ...(comp ? { sub: comp, title: `Physical size: ${formatBytes(storage.physicalBytes)} (${comp} compression)` } : {})
    })
  }
  const stats = countSchemaStats(value.schema)
  if (stats.topLevel > 0) {
    kpis.push({
      id: 'columns',
      label: 'Columns',
      value: formatCount(stats.topLevel),
      ...(stats.structCount > 0 ? { sub: `${formatCount(stats.structCount)} STRUCT`, title: `${formatCount(stats.topLevel)} top-level ${plural(stats.topLevel, 'column')}, ${formatCount(stats.total)} total fields` } : {})
    })
  } else if (value.columns?.length) {
    kpis.push({ id: 'columns', label: 'Columns', value: formatCount(value.columns.length) })
  }
  if (value.location) {
    kpis.push({ id: 'location', label: 'Location', value: value.location })
  }
  return kpis
}

/** Whether the Definition tab applies (every BigQuery properties kind except datasets). */
export function hasDefinitionTab(kind: BigQueryPropertyKind): boolean {
  return kind !== 'bqDataset'
}

/** Whether the Storage & Layout tab applies to this object. */
export function hasStorageOrLayout(value?: BigQueryProperties): boolean {
  if (!value) return false
  return bigQueryStorageFacts(value).length > 0 || storageRatioSegments(value.storage).length > 0
}

/** Whether the Columns tab applies to this object. */
export function hasColumnsTab(value?: BigQueryProperties): boolean {
  return !!((value?.schema && value.schema.length > 0) || (value?.columns && value.columns.length > 0))
}

/** Whether the Parameters tab applies (BigQuery routines with arguments). */
export function hasParametersTab(value?: BigQueryProperties): boolean {
  return !!(value?.routine?.arguments && value.routine.arguments.length > 0)
}

/** Whether the Preview Rows tab applies (stored tables, snapshots and clones via free tabledata.list). */
export function supportsPreviewTab(kind: BigQueryPropertyKind): boolean {
  return kind === 'bqTable'
}

/** Whether a given canonical tab id is currently available for this object and properties payload. */
export function isBigQueryTabAvailable(tab: BigQueryPropertiesTabId, kind: BigQueryPropertyKind, value?: BigQueryProperties): boolean {
  switch (tab) {
    case 'overview': return true
    case 'definition': return hasDefinitionTab(kind)
    case 'storage': return hasStorageOrLayout(value)
    case 'columns': return hasColumnsTab(value)
    case 'parameters': return hasParametersTab(value)
    case 'labels': return !!(value?.labels && value.labels.length > 0)
    case 'preview': return supportsPreviewTab(kind)
  }
}

/** Identity & Lifecycle facts for the Overview tab. */
export function bigQueryOverviewFacts(
  object: { readonly kind: BigQueryPropertyKind; readonly project: string; readonly dataset: string; readonly name: string },
  value: BigQueryProperties,
  onFollow?: (target: ObjectRef, label: string) => void
): readonly FactItem[] {
  if (object.kind === 'bqDataset') {
    const fullName = value.fullName ?? `${object.project}.${object.dataset}`
    const ds = value.dataset
    const facts: FactItem[] = [
      { id: 'fullName', label: 'Full name', value: fullName, mono: true, copyValue: bigQueryPath(object.project, object.dataset) },
      { id: 'type', label: 'Type', value: formatBigQueryType(object.kind, value.type) },
      { id: 'project', label: 'Project', value: object.project, mono: true }
    ]
    if (value.location) facts.push({ id: 'location', label: 'Location', value: value.location })
    if (ds?.friendlyName) facts.push({ id: 'friendlyName', label: 'Friendly name', value: ds.friendlyName })
    if (ds?.defaultTableExpirationMs !== undefined) facts.push({ id: 'defaultTableExpiry', label: 'Default table expiration', value: formatExpirationMs(ds.defaultTableExpirationMs) })
    if (ds?.defaultPartitionExpirationMs !== undefined) facts.push({ id: 'defaultPartitionExpiry', label: 'Default partition expiration', value: formatExpirationMs(ds.defaultPartitionExpirationMs) })
    facts.push({
      id: 'encryption',
      label: 'Encryption',
      value: ds?.kmsKeyName ?? 'Google-managed',
      ...(ds?.kmsKeyName ? { mono: true } : {})
    })
    if (ds?.defaultCollation) facts.push({ id: 'defaultCollation', label: 'Default collation', value: ds.defaultCollation, mono: true })
    if (ds?.maxTimeTravelHours !== undefined) facts.push({ id: 'timeTravel', label: 'Time travel window', value: `${formatCount(ds.maxTimeTravelHours)} hours` })
    if (ds?.storageBillingModel) facts.push({ id: 'billingModel', label: 'Storage billing model', value: ds.storageBillingModel })
    if (value.createdUtc) facts.push({ id: 'created', label: 'Created', value: value.createdUtc })
    if (value.modifiedUtc) facts.push({ id: 'modified', label: 'Last modified', value: value.modifiedUtc })
    return facts
  }

  const fullName = value.fullName ?? `${object.project}.${object.dataset}.${object.name}`
  const datasetLink = onFollow
    ? {
        onLink: () => onFollow({ kind: 'bqDataset', project: object.project, name: object.dataset }, `${object.project}.${object.dataset}`),
        linkLabel: `Peek ${object.project}.${object.dataset}`
      }
    : {}

  if (object.kind === 'bqRoutine') {
    const routine = value.routine
    const facts: FactItem[] = [
      { id: 'fullName', label: 'Full name', value: fullName, mono: true, copyValue: bigQueryPath(object.project, object.dataset, object.name) },
      { id: 'type', label: 'Type', value: formatBigQueryType(object.kind, value.type) },
      { id: 'project', label: 'Project', value: object.project, mono: true },
      { id: 'dataset', label: 'Dataset', value: object.dataset, mono: true, ...datasetLink }
    ]
    if (routine?.language) facts.push({ id: 'language', label: 'Language', value: routine.language })
    const det = formatDeterminismLabel(routine?.determinism)
    if (det) facts.push({ id: 'determinism', label: 'Determinism', value: det })
    if (routine?.returnType) facts.push({ id: 'returnType', label: 'Return type', value: routine.returnType, mono: true })
    if (routine?.signature) facts.push({ id: 'signature', label: 'Signature', value: routine.signature, mono: true })
    if (value.createdUtc) facts.push({ id: 'created', label: 'Created', value: value.createdUtc })
    if (value.modifiedUtc) facts.push({ id: 'modified', label: 'Last modified', value: value.modifiedUtc })
    return facts
  }

  const facts: FactItem[] = [
    { id: 'fullName', label: 'Full name', value: fullName, mono: true, copyValue: bigQueryPath(object.project, object.dataset, object.name) },
    { id: 'type', label: 'Type', value: formatBigQueryType(object.kind, value.type) },
    { id: 'project', label: 'Project', value: object.project, mono: true },
    { id: 'dataset', label: 'Dataset', value: object.dataset, mono: true, ...datasetLink }
  ]
  if (value.location) facts.push({ id: 'location', label: 'Location', value: value.location })
  if (value.baseTable) {
    const parsedBase = onFollow ? parseBigQueryTablePath(value.baseTable) : undefined
    facts.push({
      id: 'baseTable',
      label: 'Base table',
      value: value.baseTable,
      mono: true,
      ...(parsedBase && onFollow ? {
        onLink: () => onFollow({ kind: 'bqTable', project: parsedBase.project, dataset: parsedBase.dataset, name: parsedBase.name }, value.baseTable!),
        linkLabel: `Peek ${value.baseTable}`
      } : {})
    })
  }
  if (value.createdUtc) facts.push({ id: 'created', label: 'Created', value: value.createdUtc })
  if (value.modifiedUtc) facts.push({ id: 'modified', label: 'Last modified', value: value.modifiedUtc })
  if (value.expiresUtc) facts.push({ id: 'expires', label: 'Expires', value: value.expiresUtc })
  if (value.snapshotTimeUtc) facts.push({ id: 'snapshotTime', label: 'Snapshot time', value: value.snapshotTimeUtc })
  return facts
}

/** Signal-first CapabilityChips for the Overview tab. */
export function bigQueryCapabilities(kind: BigQueryPropertyKind, value: BigQueryProperties, subtype?: NodeSubtype): readonly CapabilityItem[] {
  const items: CapabilityItem[] = []
  if (kind === 'bqRoutine') {
    const routine = value.routine
    if (routine?.language) items.push({ id: 'language', label: 'Language', value: routine.language, notable: true, tone: 'accent' })
    const det = formatDeterminismLabel(routine?.determinism)
    if (det) items.push({ id: 'determinism', label: det, notable: true, tone: det === 'Deterministic' ? 'success' : 'warning' })
    const argCount = routine?.arguments?.length ?? 0
    items.push({
      id: 'arguments',
      label: 'Parameters',
      value: argCount > 0 ? (routine?.argumentsTruncated ? `${formatCount(argCount)}+` : formatCount(argCount)) : 'None',
      notable: argCount > 0
    })
    if (value.definition !== undefined) {
      items.push({ id: 'freeSql', label: 'Definition', value: 'Free (routines.get)', notable: false })
    }
    return items
  }
  if (kind === 'bqDataset') {
    const ds = value.dataset
    items.push({
      id: 'encryption',
      label: 'Encryption',
      value: ds?.kmsKeyName ? 'CMEK' : 'Google-managed',
      notable: !!ds?.kmsKeyName,
      ...(ds?.kmsKeyName ? { tone: 'accent' as const, title: ds.kmsKeyName } : {})
    })
    items.push({
      id: 'defaultTableExpiry',
      label: 'Default table expiry',
      value: ds?.defaultTableExpirationMs !== undefined ? formatExpirationMs(ds.defaultTableExpirationMs) : 'Never',
      notable: ds?.defaultTableExpirationMs !== undefined,
      ...(ds?.defaultTableExpirationMs !== undefined ? { tone: 'warning' as const } : {})
    })
    if (ds?.defaultPartitionExpirationMs !== undefined) {
      items.push({ id: 'defaultPartitionExpiry', label: 'Default partition expiry', value: formatExpirationMs(ds.defaultPartitionExpirationMs), notable: true, tone: 'warning' })
    }
    if (ds?.isCaseInsensitive !== undefined) {
      items.push({ id: 'caseInsensitive', label: 'Case-insensitive', value: ds.isCaseInsensitive ? 'Yes' : 'No', notable: ds.isCaseInsensitive, ...(ds.isCaseInsensitive ? { tone: 'accent' as const } : {}) })
    }
    if (ds?.storageBillingModel) {
      items.push({ id: 'billingModel', label: 'Billing model', value: ds.storageBillingModel, notable: ds.storageBillingModel === 'PHYSICAL', ...(ds.storageBillingModel === 'PHYSICAL' ? { tone: 'accent' as const } : {}) })
    }
    const labelCount = value.labels?.length ?? 0
    items.push({ id: 'labels', label: 'Labels', value: labelCount > 0 ? formatCount(labelCount) : 'None', notable: labelCount > 0 })
    return items
  }
  const layout = value.layout
  const storage = value.storage
  const rawType = value.type?.trim().toLowerCase()

  if (rawType === 'snapshot' || subtype === 'snapshot') {
    items.push({ id: 'snapshot', label: 'Table snapshot', notable: true, tone: 'accent' })
  } else if (rawType === 'clone' || subtype === 'clone') {
    items.push({ id: 'clone', label: 'Table clone', notable: true, tone: 'accent' })
  } else if (kind === 'bqExternalTable' || rawType === 'external table') {
    items.push({ id: 'external', label: 'External table', notable: true, tone: 'neutral' })
  } else if (kind === 'bqMaterializedView') {
    items.push({ id: 'materializedView', label: 'Materialized view', notable: true, tone: 'accent' })
  }

  const isTableLike = kind === 'bqTable' || kind === 'bqMaterializedView' || kind === 'bqExternalTable'
  if (isTableLike || layout?.partitioning) {
    items.push({
      id: 'partitioning',
      label: 'Partitioned',
      value: layout?.partitioning ? shortPartitionLabel(layout.partitioning).replace(/^Partitioned · /, '') : 'No',
      notable: !!layout?.partitioning,
      ...(layout?.partitioning ? { tone: 'accent' as const, title: layout.partitioning } : {})
    })
  }
  if (isTableLike || layout?.requirePartitionFilter !== undefined) {
    const required = layout?.requirePartitionFilter === true
    items.push({
      id: 'requireFilter',
      label: 'Require partition filter',
      value: required ? 'Yes' : 'No',
      notable: required,
      ...(required ? { tone: 'warning' as const } : {})
    })
  }
  if (isTableLike || layout?.clustering?.length) {
    const count = layout?.clustering?.length ?? 0
    items.push({
      id: 'clustering',
      label: 'Clustered',
      value: count > 0 ? layout!.clustering!.join(', ') : 'No',
      notable: count > 0,
      ...(count > 0 ? { tone: 'accent' as const } : {})
    })
  }
  if (storage?.logicalBytes !== undefined && storage.longTermLogicalBytes !== undefined) {
    const clampedLongTerm = Math.min(storage.logicalBytes, Math.max(0, storage.longTermLogicalBytes))
    const hasLongTerm = clampedLongTerm > 0
    const pct = storage.logicalBytes > 0 ? Math.round((clampedLongTerm / storage.logicalBytes) * 100) : 0
    items.push({
      id: 'longTermStorage',
      label: 'Long-term storage',
      value: hasLongTerm ? `${pct}% (${formatBytes(clampedLongTerm)})` : 'None',
      notable: hasLongTerm,
      ...(hasLongTerm ? { tone: 'success' as const } : {})
    })
  }
  items.push({
    id: 'expiration',
    label: 'Expiration',
    value: value.expiresUtc ? 'Set' : 'Never',
    notable: !!value.expiresUtc,
    ...(value.expiresUtc ? { tone: 'warning' as const, title: `Expires ${value.expiresUtc}` } : {})
  })
  const labelCount = value.labels?.length ?? 0
  items.push({
    id: 'labels',
    label: 'Labels',
    value: labelCount > 0 ? formatCount(labelCount) : 'None',
    notable: labelCount > 0
  })
  if (value.definition !== undefined) {
    items.push({ id: 'freeSql', label: 'SQL definition', value: 'Free (tables.get)', notable: false })
  }
  return items
}

const bytesWithExact = (bytes: number): string => bytes >= 1024 ? `${formatBytes(bytes)} (${formatCount(bytes)} B)` : formatBytes(bytes)

/** Storage & Layout facts for the dedicated Storage & Layout tab. */
export function bigQueryStorageFacts(value: BigQueryProperties): readonly FactItem[] {
  const facts: FactItem[] = []
  const storage = value.storage
  const layout: BigQueryLayoutInfo | undefined = value.layout

  if (storage?.rows !== undefined) {
    facts.push({ id: 'rows', label: 'Rows', value: formatCount(storage.rows) })
  }
  if (storage?.logicalBytes !== undefined) {
    facts.push({ id: 'logical', label: 'Logical size', value: bytesWithExact(storage.logicalBytes) })
  }
  const active = activeLogicalBytes(storage)
  if (active !== undefined && storage?.longTermLogicalBytes !== undefined && storage.logicalBytes !== undefined) {
    const clampedLongTerm = Math.min(storage.logicalBytes, Math.max(0, storage.longTermLogicalBytes))
    const pct = storage.logicalBytes > 0 ? ` (${Math.round((active / storage.logicalBytes) * 100)}%)` : ''
    facts.push({ id: 'activeLogical', label: 'Active logical size', value: `${formatBytes(active)}${pct}` })
    const ltPct = storage.logicalBytes > 0 ? ` (${Math.round((clampedLongTerm / storage.logicalBytes) * 100)}%)` : ''
    facts.push({ id: 'longTermLogical', label: 'Long-term logical size', value: `${formatBytes(clampedLongTerm)}${ltPct}` })
  }
  if (storage?.physicalBytes !== undefined) {
    facts.push({ id: 'physical', label: 'Physical size', value: bytesWithExact(storage.physicalBytes) })
  }
  const comp = compressionRatio(storage)
  if (comp) {
    facts.push({ id: 'compression', label: 'Compression ratio', value: comp })
  }
  if (layout?.partitioning) {
    facts.push({ id: 'partitioning', label: 'Partitioning', value: layout.partitioning })
  }
  if (layout?.requirePartitionFilter !== undefined) {
    facts.push({
      id: 'requirePartitionFilter',
      label: 'Require partition filter',
      value: layout.requirePartitionFilter ? 'Yes' : 'No'
    })
  }
  if (layout?.clustering?.length) {
    facts.push({ id: 'clustering', label: 'Clustering', value: layout.clustering.join(', '), mono: true })
  }
  if (value.baseTable) {
    facts.push({ id: 'baseTable', label: 'Base table', value: value.baseTable, mono: true })
  }
  if (value.snapshotTimeUtc) {
    facts.push({ id: 'snapshotTime', label: 'Snapshot time', value: value.snapshotTimeUtc })
  }
  return facts
}

/** Compact Storage & Layout facts for the right Vitals rail. */
export function bigQueryVitalsStorageFacts(value: BigQueryProperties): readonly FactItem[] {
  const facts: FactItem[] = []
  const storage = value.storage
  const layout = value.layout
  if (value.location) facts.push({ id: 'location', label: 'Location', value: value.location })
  if (storage?.rows !== undefined) facts.push({ id: 'rows', label: 'Rows', value: formatCount(storage.rows) })
  if (storage?.logicalBytes !== undefined && storageRatioSegments(storage).length === 0) {
    facts.push({ id: 'logical', label: 'Logical size', value: formatBytes(storage.logicalBytes) })
  }
  if (storage?.physicalBytes !== undefined) {
    const comp = compressionRatio(storage)
    facts.push({ id: 'physical', label: 'Physical size', value: comp ? `${formatBytes(storage.physicalBytes)} (${comp})` : formatBytes(storage.physicalBytes) })
  }
  if (layout?.partitioning) facts.push({ id: 'partitioning', label: 'Partitioning', value: layout.partitioning })
  if (layout?.requirePartitionFilter) facts.push({ id: 'requireFilter', label: 'Partition filter', value: 'Required' })
  if (layout?.clustering?.length) facts.push({ id: 'clustering', label: 'Clustering', value: layout.clustering.join(', '), mono: true })
  const stats = countSchemaStats(value.schema)
  if (stats.topLevel > 0) {
    facts.push({
      id: 'columns',
      label: 'Columns',
      value: stats.structCount > 0 ? `${formatCount(stats.topLevel)} (${formatCount(stats.structCount)} STRUCT)` : formatCount(stats.topLevel)
    })
  } else if (value.columns?.length) {
    facts.push({ id: 'columns', label: 'Columns', value: formatCount(value.columns.length) })
  }
  if (value.routine) {
    const routine = value.routine
    if (routine.language) facts.push({ id: 'language', label: 'Language', value: routine.language })
    if (routine.returnType) facts.push({ id: 'returns', label: 'Returns', value: routine.returnType, mono: true })
    if (routine.arguments) {
      const count = routine.arguments.length
      facts.push({ id: 'parameters', label: 'Parameters', value: routine.argumentsTruncated ? `${formatCount(count)}+` : formatCount(count) })
    }
    const det = formatDeterminismLabel(routine.determinism)
    if (det) facts.push({ id: 'determinism', label: 'Determinism', value: det })
  }
  if (value.dataset) {
    const ds = value.dataset
    if (ds.defaultTableExpirationMs !== undefined) facts.push({ id: 'tableExpiry', label: 'Table expiry', value: formatExpirationMs(ds.defaultTableExpirationMs) })
    if (ds.defaultPartitionExpirationMs !== undefined) facts.push({ id: 'partExpiry', label: 'Partition expiry', value: formatExpirationMs(ds.defaultPartitionExpirationMs) })
    if (ds.maxTimeTravelHours !== undefined) facts.push({ id: 'timeTravel', label: 'Time travel', value: `${formatCount(ds.maxTimeTravelHours)} h` })
    if (ds.kmsKeyName) facts.push({ id: 'encryption', label: 'Encryption', value: 'CMEK' })
    if (ds.storageBillingModel) facts.push({ id: 'billing', label: 'Billing', value: ds.storageBillingModel })
  }
  if (value.baseTable) facts.push({ id: 'baseTable', label: 'Base table', value: value.baseTable, mono: true })
  return facts
}

/** Lifecycle timestamp facts for the right Vitals rail. */
export function bigQueryLifecycleFacts(value: BigQueryProperties): readonly FactItem[] {
  const facts: FactItem[] = []
  if (value.createdUtc) facts.push({ id: 'created', label: 'Created', value: value.createdUtc })
  if (value.modifiedUtc) facts.push({ id: 'modified', label: 'Last modified', value: value.modifiedUtc })
  if (value.expiresUtc) facts.push({ id: 'expires', label: 'Expires', value: value.expiresUtc })
  if (value.snapshotTimeUtc) facts.push({ id: 'snapshotTime', label: 'Snapshot time', value: value.snapshotTimeUtc })
  return facts
}

/** Collects every expandable STRUCT/RECORD path in `schema` (for Expand All). */
export function allStructPaths(schema?: readonly BigQuerySchemaField[]): string[] {
  if (!schema?.length) return []
  const paths: string[] = []
  const walk = (fields: readonly BigQuerySchemaField[], prefix: string) => {
    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name
      if (field.fields && field.fields.length > 0) {
        paths.push(path)
        walk(field.fields, path)
      }
    }
  }
  walk(schema, '')
  return paths
}

/**
 * Flattens nested `BigQuerySchemaField` trees into visible rows for `LocalGrid`, computing `PART`, `CLUST`, and `REP`
 * badges and supporting interactive expand/collapse plus substring filtering (matching descendants automatically expand
 * their ancestor STRUCTs).
 */
export function flattenSchemaRows(
  schema: readonly BigQuerySchemaField[],
  options: {
    readonly filter: string
    readonly expanded: ReadonlySet<string>
    readonly partitioning?: string
    readonly clustering?: readonly string[]
  }
): readonly FlattenedSchemaRow[] {
  const query = options.filter.trim().toLowerCase()
  const partCol = partitionColumnName(options.partitioning)?.toLowerCase()
  const clusterIndex = new Map<string, number>()
  options.clustering?.forEach((name, idx) => clusterIndex.set(name.toLowerCase(), idx + 1))

  const badgesOf = (path: string, mode?: string): string[] => {
    const out: string[] = []
    const lower = path.toLowerCase()
    if (partCol && lower === partCol) out.push('PART')
    const rank = clusterIndex.get(lower)
    if (rank !== undefined) out.push(clusterIndex.size > 1 ? `CLUST #${rank}` : 'CLUST')
    if (mode?.toUpperCase() === 'REPEATED') out.push('REP')
    return out
  }

  const matches = (path: string, field: BigQuerySchemaField, badges: readonly string[]): boolean => {
    if (!query) return true
    if (path.toLowerCase().includes(query)) return true
    if (field.type.toLowerCase().includes(query)) return true
    if ((field.mode ?? 'NULLABLE').toLowerCase().includes(query)) return true
    if (field.description?.toLowerCase().includes(query)) return true
    return badges.some(badge => badge.toLowerCase().includes(query))
  }

  const walk = (fields: readonly BigQuerySchemaField[], depth: number, prefix: string): FlattenedSchemaRow[] => {
    const out: FlattenedSchemaRow[] = []
    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name
      const children = field.fields
      const hasChildren = !!(children && children.length > 0)
      const badges = badgesOf(path, field.mode)
      const selfMatches = matches(path, field, badges)
      if (!query) {
        const isExpanded = hasChildren && options.expanded.has(path)
        out.push({
          path, name: field.name, depth, type: field.type, mode: field.mode ?? 'NULLABLE',
          badges, description: field.description ?? null, hasChildren, childCount: children?.length ?? 0, expanded: isExpanded
        })
        if (isExpanded && children) out.push(...walk(children, depth + 1, path))
      } else {
        const matchedChildren = hasChildren && children ? walk(children, depth + 1, path) : []
        if (selfMatches || matchedChildren.length > 0) {
          out.push({
            path, name: field.name, depth, type: field.type, mode: field.mode ?? 'NULLABLE',
            badges, description: field.description ?? null, hasChildren, childCount: children?.length ?? 0,
            expanded: hasChildren && matchedChildren.length > 0
          })
          if (matchedChildren.length > 0) out.push(...matchedChildren)
        }
      }
    }
    return out
  }

  return walk(schema, 0, '')
}

const expandedMarker = '\u25be '
const collapsedMarker = '\u25b8 '

/** Converts flattened BigQuery schema rows into a `LocalTableData` payload for full-bleed `LocalGrid`. */
export function schemaRowsToLocalTable(rows: readonly FlattenedSchemaRow[], filtering: boolean): LocalTableData {
  return {
    columns: [
      { name: 'Column' },
      { name: 'Type' },
      { name: 'Mode' },
      { name: 'Flags' },
      { name: 'Description' }
    ],
    rows: rows.map(row => {
      const indent = '  '.repeat(row.depth)
      const chevron = row.hasChildren ? (row.expanded ? expandedMarker : collapsedMarker) : ''
      const label = filtering && row.depth > 0 ? row.path : row.name
      const count = row.hasChildren ? ` (${formatCount(row.childCount)} ${plural(row.childCount, 'field')})` : ''
      return [
        `${indent}${chevron}${label}${count}`,
        row.type,
        row.mode,
        row.badges.length > 0 ? row.badges.join(' · ') : '',
        row.description ?? ''
      ]
    })
  }
}

/** Fallback `LocalTableData` when only flat `value.columns` is populated (without nested `value.schema`). */
export function flatColumnsToLocalTable(columns: NonNullable<BigQueryProperties['columns']>, filter: string): LocalTableData {
  const query = filter.trim().toLowerCase()
  const filtered = query
    ? columns.filter(col => col.name.toLowerCase().includes(query) || col.type.toLowerCase().includes(query) || (col.description?.toLowerCase().includes(query) ?? false))
    : columns
  return {
    columns: [{ name: 'Column' }, { name: 'Type' }, { name: 'Description' }],
    rows: filtered.map(col => [col.name, col.type, col.description ?? ''])
  }
}

/** Converts BigQuery routine arguments into a `LocalTableData` payload for full-bleed `LocalGrid`. */
export function routineArgumentsToLocalTable(args: readonly BigQueryRoutineArgument[], filter: string): LocalTableData {
  const query = filter.trim().toLowerCase()
  const filtered = query
    ? args.filter(arg =>
        arg.name.toLowerCase().includes(query)
        || (arg.type?.toLowerCase().includes(query) ?? false)
        || (arg.mode?.toLowerCase().includes(query) ?? false)
        || (arg.kind?.toLowerCase().includes(query) ?? false)
      )
    : args
  return {
    columns: [{ name: 'Parameter' }, { name: 'Type' }, { name: 'Mode' }, { name: 'Kind' }],
    rows: filtered.map(arg => [arg.name || '(unnamed)', arg.type ?? '', arg.mode ?? 'IN', arg.kind ?? ''])
  }
}
