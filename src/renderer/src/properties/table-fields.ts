// Table Properties' words, without the DOM: the facts each page lists and how a value reads. Node tests run it.
import type { PageId } from '../../../shared/actions/catalog.ts'
import { lockEscalationLabels, lockEscalationTokens, type TablePropertiesModel } from '../../../shared/actions/tables.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { dateText } from './fields'

export interface Fact { readonly label: string; readonly value: string; readonly title?: string }
const yes = (value: boolean | undefined): string => value === undefined ? '' : value ? 'True' : 'False'
const fact = (label: string, value: string, title?: string): Fact => ({ label, value, ...title ? { title } : {} })
/** "1,024 KB" in the person's locale; unknown as blank. */
export const kilobytes = (value: number | undefined): string => value === undefined ? '' : `${value.toLocaleString()} KB`
const count = (value: number | undefined): string => value === undefined ? '' : value.toLocaleString()
/** SQL Server's tokens (PAGE, SYSTEM_VERSIONED_TEMPORAL_TABLE) as words. */
export const tokenText = (value: string | undefined): string => value === undefined ? '' : value.replaceAll('_', ' ').toLowerCase().replace(/^./, first => first.toUpperCase())

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

/** The pages a model shows: Security Predicates only when SQL Server has row-level security and a policy names the table. */
export function tablePages<P extends { readonly id: PageId }>(pages: readonly P[], model: TablePropertiesModel | undefined): P[] {
  return pages.filter(page => page.id !== 'securityPredicates' || !model || (model.securityPredicates?.length ?? 0) > 0)
}
