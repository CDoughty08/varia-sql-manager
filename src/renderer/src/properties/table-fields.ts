// Table Properties' words, without the DOM: the facts each page lists and how a value reads. Node tests run it.
import type { PageId } from '../../../shared/actions/catalog.ts'
import { lockEscalationLabels, lockEscalationTokens, type LockEscalation, type TablePropertiesModel, type TableStorage } from '../../../shared/actions/tables.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { StatusTone } from '../../../shared/theme/tones.ts'
import { tableChanges, tableProblemSections, type TableDraft } from '../dialogs/table-properties'
import type { CapabilityItem } from '../kit/CapabilityChips'
import type { FactItem } from '../kit/FactGrid'
import type { InspectorKpi } from '../kit/ObjectInspectorFrame'
import type { RatioSegment } from '../kit/RatioBar'
import { dateText } from './fields'

export interface Fact { readonly label: string; readonly value: string; readonly title?: string }
const yes = (value: boolean | undefined): string => value === undefined ? '' : value ? 'True' : 'False'
const fact = (label: string, value: string, title?: string): Fact => ({ label, value, ...title ? { title } : {} })
/** "1,024 KB" in the person's locale; unknown as blank. */
export const kilobytes = (value: number | undefined): string => value === undefined ? '' : `${value.toLocaleString()} KB`
const count = (value: number | undefined): string => value === undefined ? '' : value.toLocaleString()
/** SQL Server's tokens (PAGE, SYSTEM_VERSIONED_TEMPORAL_TABLE) as words. */
export const tokenText = (value: string | undefined): string => value === undefined ? '' : value.replaceAll('_', ' ').toLowerCase().replace(/^./, first => first.toUpperCase())

/** Human-readable storage space from kilobytes (KB / MB / GB), for KPIs, meters and Vitals. */
export function formatSpaceKb(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`
  if (value >= 1024) return `${(value / 1024).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`
  return `${Math.round(value).toLocaleString()} KB`
}

/** Canonical inspector tabs for SQL Server Table Properties, in agreed unified order. */
export const tableInspectorTabs = [
  'overview', 'definition', 'storage', 'columns', 'indexes', 'dependencies', 'permissions', 'extendedProperties', 'preview'
] as const
export type TableInspectorTabId = typeof tableInspectorTabs[number]
export const isTableInspectorTab = (value: string): value is TableInspectorTabId => (tableInspectorTabs as readonly string[]).includes(value)

/** Maps any Peek tab id (legacy or canonical) onto the matching Table Properties inspector tab. */
export function tableInspectorTabFromPeek(tab: string | undefined): TableInspectorTabId {
  switch (tab) {
    case 'definition': return 'definition'
    case 'storage': return 'storage'
    case 'columns': return 'columns'
    case 'indexes':
    case 'tableObjects': return 'indexes'
    case 'dependencies': return 'dependencies'
    case 'permissions': return 'permissions'
    case 'extendedProperties': return 'extendedProperties'
    case 'preview':
    case 'rows': return 'preview'
    default: return 'overview'
  }
}

/** Lock escalation's segments, as SSMS words them. */
export const lockEscalationSegments = lockEscalationTokens.map(token => ({ value: token, label: lockEscalationLabels[token] }))

/** General's facts in SSMS's order (Description, then Options), with what Varia adds: kinds SSMS shows elsewhere. */
export function generalFacts(model: TablePropertiesModel): { readonly description: readonly Fact[]; readonly options: readonly Fact[] } {
  const general = model.general
  const description = [
    fact('Name', displayText(general.name)), fact('Schema', displayText(general.schema)), fact('Created date', dateText(general.created)),
    ...general.modified ? [fact('Modified date', dateText(general.modified))] : [], fact('System object', yes(general.systemObject))
  ]
  const options = [
    fact('ANSI NULLs', yes(general.ansiNulls)), fact('Table is replicated', yes(general.replicated)), fact('Memory optimized', yes(general.memoryOptimized)),
    ...general.durability ? [fact('Durability', tokenText(general.durability))] : [], fact('FileTable', yes(general.fileTable)), fact('External', yes(general.external)),
    ...general.graph ? [fact('Graph table', general.graph === 'node' ? 'Node' : 'Edge')] : []
  ]
  return { description, options }
}

/** Temporal and ledger facts, when the table is either (SQL Server 2016 and 2022 and later). */
export function versioningFacts(model: TablePropertiesModel): { readonly temporal?: readonly Fact[]; readonly ledger?: readonly Fact[] } {
  const temporal = model.temporal && [
    fact('Temporal type', tokenText(model.temporal.type)),
    ...model.temporal.other ? [fact(model.temporal.type === 'HISTORY_TABLE' ? 'Current table' : 'History table', displayText(model.temporal.other))] : [],
    ...model.temporal.periodStart ? [fact('Period start column', displayText(model.temporal.periodStart))] : [],
    ...model.temporal.periodEnd ? [fact('Period end column', displayText(model.temporal.periodEnd))] : [],
    ...model.temporal.retention ? [fact('History retention period', model.temporal.retention)] : []
  ]
  const ledger = model.ledger && [
    fact('Ledger type', tokenText(model.ledger.type)), ...model.ledger.view ? [fact('Ledger view', displayText(model.ledger.view))] : [],
    ...model.ledger.history ? [fact('Ledger history table', displayText(model.ledger.history))] : [], fact('Dropped', yes(model.ledger.dropped))
  ]
  return { ...temporal ? { temporal } : {}, ...ledger ? { ledger } : {} }
}

/** Storage's facts, in SSMS's groups: Compression, Filegroups, Partitioning, General. */
export function storageFacts(model: TablePropertiesModel): { readonly compression: readonly Fact[]; readonly filegroups: readonly Fact[]; readonly partitioning: readonly Fact[]; readonly general: readonly Fact[] } {
  const storage = model.storage
  return {
    compression: [fact('Data compression', storage.compression === 'MIXED' ? 'Mixed (see the partitions)' : tokenText(storage.compression))],
    filegroups: [
      fact('Filegroup', displayText(storage.filegroup ?? '')), fact('Text filegroup', displayText(storage.textFilegroup ?? '')),
      ...storage.filestreamFilegroup ? [fact('FILESTREAM filegroup', displayText(storage.filestreamFilegroup))] : []
    ],
    partitioning: [
      fact('Table is partitioned', yes(storage.partitioned)), ...storage.partitionScheme ? [fact('Partition scheme', displayText(storage.partitionScheme))] : [],
      ...storage.partitionColumn ? [fact('Partition column', displayText(storage.partitionColumn))] : [], fact('Number of partitions', count(storage.partitions.length) + (storage.partitionsTruncated ? '+' : ''))
    ],
    general: [fact('Row count', count(storage.rowCount)), fact('Data space', kilobytes(storage.dataSpaceKb)), fact('Index space', kilobytes(storage.indexSpaceKb))]
  }
}

/** Semantic header status pills summarizing active table traits. */
export interface TableStatusBadge { readonly id: string; readonly label: string; readonly tone: StatusTone; readonly title?: string }
export function tableStatusPills(model: TablePropertiesModel): readonly TableStatusBadge[] {
  const pills: TableStatusBadge[] = []
  if (model.temporal) {
    pills.push(model.temporal.type === 'SYSTEM_VERSIONED_TEMPORAL_TABLE'
      ? { id: 'temporal', label: 'System-versioned', tone: 'info' }
      : model.temporal.type === 'HISTORY_TABLE'
        ? { id: 'temporal', label: 'Temporal history', tone: 'neutral' }
        : { id: 'temporal', label: tokenText(model.temporal.type), tone: 'info' })
  }
  if (model.storage.partitioned) pills.push({ id: 'partitioned', label: 'Partitioned', tone: 'info' })
  if (model.general.memoryOptimized) pills.push({ id: 'memoryOptimized', label: 'Memory-optimized', tone: 'info', ...model.general.durability ? { title: tokenText(model.general.durability) } : {} })
  if (model.ledger) {
    pills.push(model.ledger.dropped
      ? { id: 'ledger', label: 'Dropped ledger', tone: 'warning' }
      : { id: 'ledger', label: 'Ledger', tone: 'info', title: tokenText(model.ledger.type) })
  }
  if (model.changeTracking.enabled) pills.push({ id: 'changeTracking', label: 'Change tracking', tone: 'success' })
  if (model.general.fileTable) pills.push({ id: 'fileTable', label: 'FileTable', tone: 'info' })
  if (model.general.external) pills.push({ id: 'external', label: 'External', tone: 'info' })
  if (model.general.graph) pills.push({ id: 'graph', label: model.general.graph === 'node' ? 'Graph node' : 'Graph edge', tone: 'info' })
  if (model.readOnlyReason) pills.push({ id: 'readOnly', label: 'Read-only', tone: 'warning', title: model.readOnlyReason })
  return pills
}

/** Signal-first capability chips for Overview (`Notable (n/m) ↔ All`). */
export function tableCapabilities(model: TablePropertiesModel): readonly CapabilityItem[] {
  const { general, storage, changeTracking, temporal, ledger } = model
  const compressionLabel = storage.compression === 'MIXED' ? 'Mixed' : tokenText(storage.compression) || 'None'
  const compressed = !!storage.compression && storage.compression !== 'NONE'
  return [
    { id: 'temporal', label: 'Temporal', value: temporal ? tokenText(temporal.type) : 'Off', notable: !!temporal, ...temporal ? { tone: 'accent' as const } : {} },
    { id: 'partitioned', label: 'Partitioned', value: storage.partitioned ? `${storage.partitions.length.toLocaleString()}${storage.partitionsTruncated ? '+' : ''}` : 'No', notable: storage.partitioned, ...storage.partitioned ? { tone: 'accent' as const } : {} },
    { id: 'memoryOptimized', label: 'Memory-optimized', value: general.memoryOptimized ? (general.durability ? tokenText(general.durability) : 'Yes') : 'No', notable: general.memoryOptimized, ...general.memoryOptimized ? { tone: 'accent' as const } : {} },
    { id: 'ledger', label: 'Ledger', value: ledger ? tokenText(ledger.type) : 'No', notable: !!ledger, ...ledger ? { tone: ledger.dropped ? 'warning' as const : 'accent' as const } : {} },
    { id: 'changeTracking', label: 'Change tracking', value: changeTracking.enabled ? (changeTracking.trackColumnsUpdated ? 'On (columns)' : 'On') : 'Off', notable: changeTracking.enabled, ...changeTracking.enabled ? { tone: 'success' as const } : {} },
    { id: 'compression', label: 'Compression', value: compressionLabel, notable: compressed, ...compressed ? { tone: 'neutral' as const } : {} },
    { id: 'replicated', label: 'Replicated', value: general.replicated ? 'Yes' : 'No', notable: general.replicated, ...general.replicated ? { tone: 'accent' as const } : {} },
    { id: 'fileTable', label: 'FileTable', value: general.fileTable ? 'Yes' : 'No', notable: general.fileTable, ...general.fileTable ? { tone: 'accent' as const } : {} },
    { id: 'external', label: 'External', value: general.external ? 'Yes' : 'No', notable: general.external, ...general.external ? { tone: 'accent' as const } : {} },
    { id: 'graph', label: 'Graph table', value: general.graph ? (general.graph === 'node' ? 'Node' : 'Edge') : 'No', notable: !!general.graph, ...general.graph ? { tone: 'accent' as const } : {} },
    { id: 'ansiNulls', label: 'ANSI NULLs', value: general.ansiNulls === undefined ? '—' : general.ansiNulls ? 'True' : 'False', notable: general.ansiNulls === false, ...general.ansiNulls === false ? { tone: 'warning' as const } : {} },
    { id: 'systemObject', label: 'System object', value: general.systemObject ? 'Yes' : 'No', notable: general.systemObject, ...general.systemObject ? { tone: 'warning' as const } : {} }
  ]
}

/** Data vs. Index storage proportion segments for RatioBar (mini KPI, flow card and flat Vitals rail). */
export interface TableSpaceRatio {
  readonly totalKb: number
  readonly totalLabel: string
  readonly segments: readonly RatioSegment[]
}
export function tableSpaceRatio(storage: TableStorage): TableSpaceRatio | undefined {
  if (storage.dataSpaceKb === undefined && storage.indexSpaceKb === undefined) return undefined
  const data = Math.max(0, storage.dataSpaceKb ?? 0)
  const index = Math.max(0, storage.indexSpaceKb ?? 0)
  const totalKb = data + index
  return {
    totalKb,
    totalLabel: formatSpaceKb(totalKb),
    segments: [
      { id: 'data', label: 'Data', value: data, displayValue: formatSpaceKb(data), series: 1 },
      { id: 'index', label: 'Index', value: index, displayValue: formatSpaceKb(index), series: 2 }
    ]
  }
}

export interface TableCatalogCounts {
  readonly columns?: { readonly count: number; readonly truncated?: boolean }
  readonly indexes?: { readonly count: number; readonly truncated?: boolean }
}

/** Headline Hero KPIs for Full Table Properties view. */
export function tableHeroKpis(model: TablePropertiesModel, counts?: TableCatalogCounts): readonly InspectorKpi[] {
  const { storage } = model
  const ratio = tableSpaceRatio(storage)
  const kpis: InspectorKpi[] = [
    {
      id: 'rows', label: 'Rows', value: storage.rowCount === undefined ? '—' : storage.rowCount.toLocaleString(),
      title: storage.rowCount === undefined ? 'Row count unavailable' : `${storage.rowCount.toLocaleString()} rows`
    },
    {
      id: 'space', label: 'Total Space', value: ratio ? ratio.totalLabel : '—',
      ...(ratio && ratio.totalKb > 0 ? { ratio: ratio.segments } : {}),
      title: ratio ? `Total ${ratio.totalLabel} (${kilobytes(storage.dataSpaceKb ?? 0)} data, ${kilobytes(storage.indexSpaceKb ?? 0)} index)` : 'Space usage unavailable'
    }
  ]
  if (counts?.columns) {
    const text = `${counts.columns.count.toLocaleString()}${counts.columns.truncated ? '+' : ''}`
    kpis.push({ id: 'columns', label: 'Columns', value: text, title: `${text} columns` })
  }
  if (counts?.indexes) {
    const text = `${counts.indexes.count.toLocaleString()}${counts.indexes.truncated ? '+' : ''}`
    kpis.push({ id: 'indexes', label: 'Indexes & Keys', value: text, title: `${text} indexes, keys, constraints and triggers` })
  }
  const partText = `${storage.partitions.length.toLocaleString()}${storage.partitionsTruncated ? '+' : ''}`
  kpis.push({
    id: 'partitions', label: 'Partitions', value: partText,
    ...(storage.partitioned ? {} : { sub: 'Unpartitioned' }),
    title: storage.partitioned ? `${partText} partitions` : '1 partition (not partitioned)'
  })
  return kpis
}

/** Compact storage & identity facts for the right Vitals rail. */
export function tableVitalsFacts(model: TablePropertiesModel): readonly FactItem[] {
  const { general, storage, changeTracking } = model
  const lockLabel = (lockEscalationTokens as readonly string[]).includes(general.lockEscalation)
    ? lockEscalationLabels[general.lockEscalation as LockEscalation]
    : tokenText(general.lockEscalation)
  return [
    { id: 'schema', label: 'Schema', value: displayText(general.schema), mono: true },
    { id: 'filegroup', label: 'Filegroup', value: storage.filegroup ? displayText(storage.filegroup) : '', mono: true },
    { id: 'compression', label: 'Compression', value: storage.compression === 'MIXED' ? 'Mixed' : tokenText(storage.compression) },
    { id: 'lockEscalation', label: 'Lock escalation', value: lockLabel },
    { id: 'changeTracking', label: 'Change tracking', value: changeTracking.enabled ? (changeTracking.trackColumnsUpdated ? 'On (columns)' : 'On') : 'Off' },
    { id: 'created', label: 'Created', value: dateText(general.created) },
    ...(general.modified ? [{ id: 'modified', label: 'Modified', value: dateText(general.modified) }] : [])
  ]
}

/** Counts logical pending changes in the draft, for the header `Apply · n` label. */
export function tableChangeCount(model: TablePropertiesModel, draft: TableDraft): number {
  const changes = tableChanges(model, draft)
  return (changes.lockEscalation ? 1 : 0) + (changes.changeTracking ? 1 : 0) + (changes.extendedProperties?.length ?? 0)
}

/** Inspector tabs carrying unsaved edits. */
export function tableModifiedTabs(model: TablePropertiesModel, draft: TableDraft): ReadonlySet<TableInspectorTabId> {
  const changes = tableChanges(model, draft)
  const tabs = new Set<TableInspectorTabId>()
  if (changes.lockEscalation || changes.changeTracking) tabs.add('overview')
  if ((changes.extendedProperties?.length ?? 0) > 0) tabs.add('extendedProperties')
  return tabs
}

/** Inspector tabs carrying validation problems. */
export function tableProblemTabs(errors: ReadonlyMap<string, string>): ReadonlySet<TableInspectorTabId> {
  const pages = tableProblemSections(errors)
  const tabs = new Set<TableInspectorTabId>()
  if (pages.has('general') || pages.has('changeTracking')) tabs.add('overview')
  if (pages.has('extendedProperties')) tabs.add('extendedProperties')
  return tabs
}

/** Converts legacy Fact[] arrays into FactGrid's FactItem[]. */
export function toFactItems(facts: readonly Fact[], monoLabels: ReadonlySet<string> = new Set()): readonly FactItem[] {
  return facts.map((item, index) => ({
    id: `${item.label}-${index}`,
    label: item.label,
    value: item.value,
    ...(item.title ? { title: item.title } : {}),
    ...(monoLabels.has(item.label) ? { mono: true } : {})
  }))
}

/** The pages a model shows: Security Predicates only when SQL Server has row-level security and a policy names the table. */
export function tablePages<P extends { readonly id: PageId }>(pages: readonly P[], model: TablePropertiesModel | undefined): P[] {
  return pages.filter(page => page.id !== 'securityPredicates' || !model || (model.securityPredicates?.length ?? 0) > 0)
}
