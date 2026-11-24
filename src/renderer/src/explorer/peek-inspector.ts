// Pure data model builders for the unified Peek inspector (PeekCard and PeekTab):
// derives header status pills, Full-surface Hero KPIs, Storage/Usage RatioBars, Overview FactGrids & CapabilityChips,
// Vitals rail summaries, and clickable cross-object links from OpenPeek without needing a DOM.
import { isPeekKind, isPeekListTab, peekSpecs, type PeekFact, type PeekTab, type PeekValue } from '../../../shared/explorer/peek.ts'
import { displayText, type ObjectRef } from '../../../shared/explorer/refs.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import type { CapabilityItem } from '../kit/CapabilityChips'
import type { Crumb } from '../kit/DocumentFrame'
import type { FactItem } from '../kit/FactGrid'
import type { InspectorKpi } from '../kit/ObjectInspectorFrame'
import type { RatioSegment } from '../kit/RatioBar'
import { formatCount } from '../results/status'
import { formatPeekValue } from './peek-format'
import type { OpenPeek } from './PeekService'

export interface PeekRatioMeter {
  readonly title: string
  readonly totalLabel: string
  readonly segments: readonly RatioSegment[]
}

export interface PeekStatePill {
  readonly id: string
  readonly label: string
  readonly tone: StatusTone
  readonly title?: string
}

export interface PeekFactSection {
  readonly id: string
  readonly title: string
  readonly facts: readonly FactItem[]
  readonly refused?: string
}

export interface PeekOverviewModel {
  readonly sections: readonly PeekFactSection[]
  readonly capabilities: readonly CapabilityItem[]
}

export interface PeekVitalsModel {
  readonly meter?: PeekRatioMeter
  readonly facts: readonly FactItem[]
  readonly notableFlags: readonly CapabilityItem[]
}

export interface PeekLinkTarget {
  readonly target: ObjectRef
  readonly label: string
}

export interface PeekFkActionPill {
  readonly label: string
  readonly tone: StatusTone
}

export interface PeekFkRelationModel {
  readonly parentTable: { readonly label: string; readonly link?: PeekLinkTarget }
  readonly referencedTable?: { readonly label: string; readonly link?: PeekLinkTarget }
  readonly parentColumns: readonly string[]
  readonly referencedColumns: readonly string[]
  readonly columnsTruncated?: true
  readonly onDelete?: PeekFkActionPill
  readonly onUpdate?: PeekFkActionPill
  readonly statusPills: readonly PeekStatePill[]
}

export interface PeekKeyColumnItem {
  readonly name: string
  readonly descending: boolean
  readonly type?: string
}

export interface PeekKeySummaryModel {
  readonly keyTypeLabel: string
  readonly indexType?: string
  readonly parentTable?: { readonly label: string; readonly link?: PeekLinkTarget }
  readonly columns: readonly PeekKeyColumnItem[]
  readonly columnsTruncated?: true
  readonly statusPills: readonly PeekStatePill[]
}

export interface PeekConstraintModel {
  readonly constraintType: string
  readonly column?: string
  readonly expression?: string
  readonly statusPills: readonly PeekStatePill[]
}

export const isForeignKeyFacts = (facts: Readonly<Record<string, PeekValue>>): boolean =>
  facts.keyType === 'Foreign key' || facts.keyType === 'FOREIGN_KEY_CONSTRAINT'

function referentialActionPill(raw: PeekValue | undefined): PeekFkActionPill | undefined {
  const code = str(raw)
  if (!code) return undefined
  const label = formatPeekValue({ format: 'code' }, code)
  const upper = code.toUpperCase()
  const tone: StatusTone = upper === 'CASCADE' ? 'warning' : upper === 'SET_NULL' || upper === 'SET_DEFAULT' ? 'info' : 'neutral'
  return { label, tone }
}

/** Visual Foreign Key relationship card model for MSSQL `key` objects that are foreign keys. */
export function peekFkRelationModel(open: OpenPeek, onFollow?: (target: ObjectRef, label: string) => void): PeekFkRelationModel | undefined {
  if (open.kind !== 'key' || open.facts.status !== 'ready') return undefined
  const f = open.facts.value
  if (!isForeignKeyFacts(f)) return undefined
  const parentFallback = peekParentTarget(open)
  const parentRaw = str(f.parentTable)
  const parentLabel = parentRaw ? displayText(parentRaw) : parentFallback?.label
  if (!parentLabel) return undefined
  const parentLink = onFollow ? (parentRaw ? peekFactLink(open, 'parentTable', parentRaw) : parentFallback ? { target: parentFallback.target, label: parentFallback.label } : undefined) : undefined

  const refRaw = str(f.referencedTable)
  const referencedTable = refRaw
    ? { label: displayText(refRaw), ...(onFollow ? { link: peekFactLink(open, 'referencedTable', refRaw) } : {}) }
    : undefined

  const keyList = open.lists?.keyColumns
  const parentColumns: string[] = []
  const referencedColumns: string[] = []
  for (const row of keyList?.rows ?? []) {
    const col = str(row[0])
    const refCol = str(row[1])
    if (col) parentColumns.push(displayText(col))
    if (refCol) referencedColumns.push(displayText(refCol))
  }

  const statusPills: PeekStatePill[] = []
  if (f.disabled === true) statusPills.push({ id: 'disabled', label: 'Disabled', tone: 'critical' })
  else if (f.disabled === false) statusPills.push({ id: 'enabled', label: 'Enabled', tone: 'success' })
  if (f.notTrusted === true) statusPills.push({ id: 'notTrusted', label: 'Not trusted', tone: 'warning', title: 'SQL Server did not validate existing rows when enabling this foreign key.' })
  else if (f.notTrusted === false && f.disabled !== true) statusPills.push({ id: 'trusted', label: 'Trusted', tone: 'success' })
  if (f.notForReplication === true) statusPills.push({ id: 'nfr', label: 'Not for replication', tone: 'neutral' })

  return {
    parentTable: { label: parentLabel, ...(parentLink ? { link: parentLink } : {}) },
    ...(referencedTable ? { referencedTable } : {}),
    parentColumns,
    referencedColumns,
    ...(keyList?.truncated ? { columnsTruncated: true } : {}),
    ...(referentialActionPill(f.deleteAction) ? { onDelete: referentialActionPill(f.deleteAction) } : {}),
    ...(referentialActionPill(f.updateAction) ? { onUpdate: referentialActionPill(f.updateAction) } : {}),
    statusPills
  }
}

/** Key-column summary card model for MSSQL Primary Key and Unique Constraint objects. */
export function peekKeySummaryModel(open: OpenPeek, onFollow?: (target: ObjectRef, label: string) => void): PeekKeySummaryModel | undefined {
  if (open.kind !== 'key' || open.facts.status !== 'ready') return undefined
  const f = open.facts.value
  if (isForeignKeyFacts(f)) return undefined
  const keyTypeRaw = str(f.keyType)
  if (!keyTypeRaw) return undefined
  const indexType = str(f.indexType)
  const parentFallback = peekParentTarget(open)
  const parentRaw = str(f.parentTable)
  const parentLabel = parentRaw ? displayText(parentRaw) : parentFallback?.label
  const parentLink = onFollow && parentLabel ? (parentRaw ? peekFactLink(open, 'parentTable', parentRaw) : parentFallback ? { target: parentFallback.target, label: parentFallback.label } : undefined) : undefined

  const keyList = open.lists?.keyColumns
  const columns: PeekKeyColumnItem[] = []
  for (const row of keyList?.rows ?? []) {
    const col = str(row[0])
    if (!col) continue
    const colType = str(row[3])
    columns.push({ name: displayText(col), descending: row[2] === true, ...(colType ? { type: displayText(colType) } : {}) })
  }

  const isPk = keyTypeRaw === 'Primary key' || keyTypeRaw === 'PRIMARY_KEY_CONSTRAINT'
  const statusPills: PeekStatePill[] = [
    { id: 'keyType', label: isPk ? 'Primary key' : displayText(keyTypeRaw), tone: isPk ? 'info' : 'neutral' }
  ]
  if (indexType) {
    const clustered = /^clustered\b/i.test(indexType)
    statusPills.push({ id: 'indexType', label: displayText(indexType), tone: clustered ? 'info' : 'neutral' })
  }
  if (f.disabled === true) statusPills.push({ id: 'disabled', label: 'Disabled', tone: 'critical' })
  else if (f.disabled === false) statusPills.push({ id: 'enabled', label: 'Enabled', tone: 'success' })

  return {
    keyTypeLabel: displayText(keyTypeRaw),
    ...(indexType ? { indexType: displayText(indexType) } : {}),
    ...(parentLabel ? { parentTable: { label: parentLabel, ...(parentLink ? { link: parentLink } : {}) } } : {}),
    columns,
    ...(keyList?.truncated ? { columnsTruncated: true } : {}),
    statusPills
  }
}

/** Structured constraint card model (`CHECK`, `DEFAULT`, `EDGE`) for Overview and Definition fallback. */
export function peekConstraintModel(open: OpenPeek): PeekConstraintModel | undefined {
  if (open.kind !== 'constraint' || open.facts.status !== 'ready') return undefined
  const f = open.facts.value
  const constraintType = str(f.constraintType) ?? 'Constraint'
  const column = str(f.column)
  const expression = str(f.expression)
  const statusPills: PeekStatePill[] = []
  if (f.disabled === true) statusPills.push({ id: 'disabled', label: 'Disabled', tone: 'critical' })
  else if (f.disabled === false) statusPills.push({ id: 'enabled', label: 'Enabled', tone: 'success' })
  if (f.notTrusted === true) statusPills.push({ id: 'notTrusted', label: 'Not trusted', tone: 'warning' })
  else if (f.notTrusted === false && f.disabled !== true) statusPills.push({ id: 'trusted', label: 'Trusted', tone: 'success' })
  if (f.systemNamed === true) statusPills.push({ id: 'systemNamed', label: 'System-named', tone: 'neutral' })
  return {
    constraintType: displayText(constraintType),
    ...(column ? { column: displayText(column) } : {}),
    ...(expression ? { expression } : {}),
    statusPills
  }
}

/** Constraint definition expression when present in `facts.expression` (for CHECK/DEFAULT constraints). */
export function constraintExpressionText(open: OpenPeek): string | undefined {
  if (open.kind !== 'constraint' || open.facts.status !== 'ready') return undefined
  return str(open.facts.value.expression)
}

/** Monospace facts: schemas, types, collations, filegroups, filters and expressions. */
const monoFactIds = new Set([
  'schema', 'filegroup', 'textFilegroup', 'partitionScheme', 'filter', 'expression', 'column',
  'collation', 'baseObject', 'baseServer', 'baseDatabase', 'baseSchema', 'baseName',
  'dataType', 'baseType', 'default', 'rule', 'assembly', 'className', 'parentTable', 'referencedTable',
  'defaultDatabase', 'defaultLanguage'
])

/** Boolean facts whose normal SQL Server default is `true`; `false` is the notable signal. */
const defaultTrueBooleans = new Set([
  'ansiNulls', 'quotedIdentifier', 'allowRowLocks', 'allowPageLocks', 'autoCreateStats', 'autoUpdateStats',
  'allowNulls', 'nullOnNullInput'
])

/** Boolean facts that represent an alert or degraded state when `true`. */
const errorBooleans = new Set(['disabled', 'connectDenied', 'exhausted'])
const warningBooleans = new Set(['notTrusted', 'readOnly', 'autoClose', 'autoShrink', 'noRecompute'])
const neutralBooleans = new Set(['systemObject', 'systemNamed', 'notForReplication'])

const num = (value: PeekValue | undefined): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const str = (value: PeekValue | undefined): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Parses an unambiguous `schema.name` string (exact single dot, non-empty parts within SQL Server's 128-char sysname bound).
 * Returns undefined when the text cannot be split safely without guessing embedded dots.
 */
export function parseSchemaQualified(text: string): { readonly schema: string; readonly name: string } | undefined {
  const dot = text.indexOf('.')
  if (dot <= 0 || dot === text.length - 1 || text.indexOf('.', dot + 1) !== -1) return undefined
  const schema = text.slice(0, dot), name = text.slice(dot + 1)
  if (schema.length > 128 || name.length > 128) return undefined
  return { schema, name }
}

/** Target for navigating from a child object (`index`, `key`, `constraint`, `trigger`) to its parent table/view/tableType. */
export function peekParentTarget(open: OpenPeek): (PeekLinkTarget & { readonly fieldLabel: string }) | undefined {
  if (open.node.ref.type !== 'object') return undefined
  const { database, parent } = open.node.ref.object
  if (!parent || !database || !parent.schema || !isPeekKind(parent.kind)) return undefined
  const label = displayText(`${parent.schema}.${parent.name}`)
  const fieldLabel = parent.kind === 'view' ? 'Parent view' : parent.kind === 'tableType' ? 'Parent table type' : 'Parent table'
  return { target: { kind: parent.kind, database, schema: parent.schema, name: parent.name }, label, fieldLabel }
}

/** Resolves a clickable cross-object target for a fact when the value names a peekable object on the same connection. */
export function peekFactLink(open: OpenPeek, factId: string, value: PeekValue): PeekLinkTarget | undefined {
  if (open.node.ref.type !== 'object') return undefined
  if (factId === 'parentTable') {
    const parent = peekParentTarget(open)
    return parent ? { target: parent.target, label: parent.label } : undefined
  }
  if (factId === 'referencedTable') {
    const database = open.node.ref.object.database
    const text = str(value)
    const parsed = database && text ? parseSchemaQualified(text) : undefined
    if (!parsed || !database) return undefined
    return { target: { kind: 'table', database, schema: parsed.schema, name: parsed.name }, label: displayText(text!) }
  }
  if (factId === 'defaultDatabase' && open.kind === 'login') {
    const name = str(value)
    if (!name || name.length > 128) return undefined
    return { target: { kind: 'database', name }, label: displayText(name) }
  }
  return undefined
}

/** Breadcrumbs for Full-surface Peek Tab: Server › Database › Parent (for child objects). */
export function peekCrumbs(open: OpenPeek, serverLabel: string): readonly Crumb[] {
  const object = open.node.ref.type === 'object' ? open.node.ref.object : undefined
  const crumbs: Crumb[] = [{ label: serverLabel }]
  if (object?.database !== undefined) crumbs.push({ label: displayText(object.database) })
  if (object?.parent) {
    const parentName = displayText([object.parent.schema, object.parent.name].filter(Boolean).join('.'))
    if (parentName) crumbs.push({ label: parentName })
  }
  return crumbs
}

/** Proportion meter (`RatioBar`) for objects with quantitative allocation or usage splits. */
export function peekRatioMeter(open: OpenPeek): PeekRatioMeter | undefined {
  if (open.facts.status !== 'ready') return undefined
  const facts = open.facts.value
  if (open.kind === 'table') {
    const data = num(facts.dataSpace), index = num(facts.indexSpace)
    if (data === undefined || index === undefined) return undefined
    const safeData = Math.max(0, data), safeIndex = Math.max(0, index)
    return {
      title: 'Space allocation',
      totalLabel: formatPeekValue({ format: 'kb' }, safeData + safeIndex),
      segments: [
        { id: 'data', label: 'Data', value: safeData, displayValue: formatPeekValue({ format: 'kb' }, safeData), series: 1 },
        { id: 'index', label: 'Index', value: safeIndex, displayValue: formatPeekValue({ format: 'kb' }, safeIndex), series: 2 }
      ]
    }
  }
  if (open.kind === 'index') {
    if (open.refused?.includes('usage')) return undefined
    const seeks = num(facts.userSeeks), scans = num(facts.userScans), lookups = num(facts.userLookups) ?? 0, updates = num(facts.userUpdates)
    if (seeks === undefined && scans === undefined && updates === undefined) return undefined
    const s = Math.max(0, seeks ?? 0), sc = Math.max(0, scans ?? 0), l = Math.max(0, lookups), u = Math.max(0, updates ?? 0)
    const reads = s + sc + l, total = reads + u
    const readPct = total > 0 ? Math.round((reads / total) * 100) : 0
    const segments: RatioSegment[] = [
      { id: 'seeks', label: 'Seeks', value: s, displayValue: formatCount(s), series: 3 },
      { id: 'scans', label: 'Scans', value: sc, displayValue: formatCount(sc), series: 1 },
      ...(l > 0 ? [{ id: 'lookups', label: 'Lookups', value: l, displayValue: formatCount(l), series: 4 as const }] : []),
      { id: 'updates', label: 'Updates', value: u, displayValue: formatCount(u), series: 2 }
    ]
    return {
      title: 'Usage since server start',
      totalLabel: total > 0 ? `${formatCount(total)} ops · ${readPct}% reads` : '0 ops',
      segments
    }
  }
  if (open.kind === 'database') {
    const data = num(facts.dataSize), log = num(facts.logSize)
    if (data === undefined || log === undefined) return undefined
    const safeData = Math.max(0, data), safeLog = Math.max(0, log)
    return {
      title: 'File allocation',
      totalLabel: formatPeekValue({ format: 'kb' }, safeData + safeLog),
      segments: [
        { id: 'data', label: 'Data files', value: safeData, displayValue: formatPeekValue({ format: 'kb' }, safeData), series: 1 },
        { id: 'log', label: 'Log files', value: safeLog, displayValue: formatPeekValue({ format: 'kb' }, safeLog), series: 2 }
      ]
    }
  }
  return undefined
}

/** High-signal semantic status pills shown in the header (at most 3). */
export function peekStatePills(open: OpenPeek): readonly PeekStatePill[] {
  if (open.facts.status !== 'ready') return []
  const f = open.facts.value
  const pills: PeekStatePill[] = []
  const add = (id: string, label: string, tone: StatusTone, title?: string) => { if (pills.length < 3) pills.push({ id, label, tone, title }) }

  if (open.kind === 'table') {
    const temporal = str(f.temporal)
    if (temporal && temporal !== 'NON_TEMPORAL_TABLE') add('temporal', temporal === 'SYSTEM_VERSIONED_TEMPORAL_TABLE' ? 'System-versioned' : formatPeekValue({ format: 'code' }, temporal), 'info')
    const ledger = str(f.ledger)
    if (ledger && ledger !== 'NON_LEDGER_TABLE') add('ledger', formatPeekValue({ format: 'code' }, ledger), 'info')
    if (f.memoryOptimized === true) add('mem', 'Memory-optimized', 'info')
    if (f.partitioned === true) add('part', 'Partitioned', 'success')
  } else if (open.kind === 'index') {
    if (f.disabled === true) add('disabled', 'Disabled', 'critical')
    else if (!open.refused?.includes('usage')) {
      const reads = Math.max(0, num(f.userSeeks) ?? 0) + Math.max(0, num(f.userScans) ?? 0) + Math.max(0, num(f.userLookups) ?? 0)
      const updates = Math.max(0, num(f.userUpdates) ?? 0)
      const total = reads + updates
      if (total > 0) {
        const readPct = Math.round((reads / total) * 100)
        if (reads === 0) add('usage', 'Write-only', 'warning', 'Index has updates but no recorded reads since server start')
        else if (readPct >= 50) add('usage', `Healthy · ${readPct}% reads`, 'success')
        else add('usage', `${readPct}% reads`, 'warning')
      }
    }
    if (f.primaryKey === true) add('pk', 'Primary key', 'info')
    else if (f.unique === true) add('unique', 'Unique', 'neutral')
    if (str(f.filter)) add('filtered', 'Filtered', 'info')
  } else if (open.kind === 'key') {
    if (isForeignKeyFacts(f)) {
      if (f.disabled === true) add('disabled', 'Disabled', 'critical')
      else if (f.disabled === false) add('enabled', 'Enabled', 'success')
      if (f.notTrusted === true) add('untrusted', 'Not trusted', 'warning')
      else if (f.disabled !== true) add('trusted', 'Trusted', 'success')
    } else {
      const kt = str(f.keyType)
      if (kt === 'Primary key' || kt === 'PRIMARY_KEY_CONSTRAINT') add('pk', 'Primary key', 'info')
      else if (kt === 'Unique constraint' || kt === 'UNIQUE_CONSTRAINT') add('uq', 'Unique', 'neutral')
      const idxType = str(f.indexType)
      if (idxType) add('indexType', displayText(idxType), /^clustered\b/i.test(idxType) ? 'info' : 'neutral')
      if (f.disabled === true) add('disabled', 'Disabled', 'critical')
    }
  } else if (open.kind === 'constraint') {
    if (f.disabled === true) add('disabled', 'Disabled', 'critical')
    else if (f.disabled === false) add('enabled', 'Enabled', 'success')
    if (f.notTrusted === true) add('untrusted', 'Not trusted', 'warning')
    else if (f.disabled !== true && (
      f.notTrusted === false || f.constraintType === 'Check constraint' || f.constraintType === 'CHECK_CONSTRAINT'
    )) add('trusted', 'Trusted', 'success')
    if (f.systemNamed === true) add('systemNamed', 'System-named', 'neutral')
  } else if (open.kind === 'trigger' || open.kind === 'databaseTrigger' || open.kind === 'serverTrigger') {
    if (f.disabled === true) add('disabled', 'Disabled', 'critical')
    if (f.insteadOf === true) add('insteadOf', 'Instead of', 'info')
  } else if (open.kind === 'database') {
    const status = str(f.status)
    if (status) {
      const tone: StatusTone = status === 'ONLINE' ? 'success' : status === 'OFFLINE' || status === 'SUSPECT' || status === 'EMERGENCY' ? 'critical' : 'warning'
      add('status', formatPeekValue({ format: 'code' }, status), tone)
    }
    if (f.readOnly === true) add('readOnly', 'Read-only', 'warning')
  } else if (open.kind === 'login') {
    if (f.disabled === true) add('disabled', 'Disabled', 'critical')
    if (f.connectDenied === true) add('denied', 'Connect denied', 'warning')
  } else if (open.kind === 'view') {
    if (f.schemaBound === true) add('schemaBound', 'Schema-bound', 'info')
    if (f.indexed === true) add('indexed', 'Indexed', 'success')
  } else if (open.kind === 'procedure' || open.kind === 'function') {
    if (f.nativelyCompiled === true) add('native', 'Natively compiled', 'info')
    if (f.schemaBound === true) add('schemaBound', 'Schema-bound', 'info')
  } else if (open.kind === 'sequence') {
    if (f.exhausted === true) add('exhausted', 'Exhausted', 'critical')
    if (f.cycle === true) add('cycle', 'Cycles', 'info')
  }
  return pills
}

const listCountString = (open: OpenPeek, id: keyof NonNullable<OpenPeek['lists']>): string | undefined => {
  const list = open.lists?.[id]
  if (!list) return undefined
  return list.truncated ? `${formatCount(list.rows.length)}+` : formatCount(list.rows.length)
}

/** Hero KPI strip items for Full-surface Peek Tab (omitted automatically on `surface="peek"`). */
export function peekHeroKpis(open: OpenPeek): readonly InspectorKpi[] {
  if (open.facts.status !== 'ready') return []
  const f = open.facts.value
  const meter = peekRatioMeter(open)
  const kpis: InspectorKpi[] = []
  const push = (kpi: InspectorKpi) => { if (kpis.length < 5) kpis.push(kpi) }

  if (open.kind === 'table') {
    if (num(f.rowCount) !== undefined) push({ id: 'rows', label: 'Rows', value: formatPeekValue({ format: 'count' }, f.rowCount!) })
    if (meter) push({ id: 'space', label: 'Total space', value: meter.totalLabel, ratio: meter.segments })
    const cols = listCountString(open, 'columns')
    if (cols) push({ id: 'columns', label: 'Columns', value: cols })
    const objs = listCountString(open, 'tableObjects')
    if (objs) push({ id: 'indexes', label: 'Indexes & keys', value: objs })
    const fg = str(f.filegroup)
    if (fg) push({ id: 'filegroup', label: 'Filegroup', value: displayText(fg) })
  } else if (open.kind === 'index') {
    if (!open.refused?.includes('usage')) {
      if (num(f.userSeeks) !== undefined) push({ id: 'seeks', label: 'Seeks', value: formatPeekValue({ format: 'count' }, f.userSeeks!) })
      if (num(f.userScans) !== undefined) push({ id: 'scans', label: 'Scans', value: formatPeekValue({ format: 'count' }, f.userScans!) })
      if (num(f.userUpdates) !== undefined) push({ id: 'updates', label: 'Updates', value: formatPeekValue({ format: 'count' }, f.userUpdates!), ...(meter ? { ratio: meter.segments } : {}) })
    }
    if (num(f.space) !== undefined) push({ id: 'space', label: 'Space used', value: formatPeekValue({ format: 'kb' }, f.space!) })
    if (num(f.rowCount) !== undefined) push({ id: 'rows', label: 'Rows', value: formatPeekValue({ format: 'count' }, f.rowCount!) })
    const ff = num(f.fillFactor)
    if (ff !== undefined && ff > 0) push({ id: 'fillFactor', label: 'Fill factor', value: `${ff}%` })
  } else if (open.kind === 'database') {
    if (num(f.size) !== undefined) push({ id: 'size', label: 'Size', value: formatPeekValue({ format: 'kb' }, f.size!), ...(meter ? { ratio: meter.segments } : {}) })
    const files = listCountString(open, 'files')
    if (files) push({ id: 'files', label: 'Files', value: files })
    if (str(f.recoveryModel)) push({ id: 'recovery', label: 'Recovery', value: formatPeekValue({ format: 'code' }, f.recoveryModel!) })
    if (num(f.compatibilityLevel) !== undefined) push({ id: 'compat', label: 'Compat level', value: String(f.compatibilityLevel) })
  } else if (open.kind === 'view' || open.kind === 'tableType') {
    const cols = listCountString(open, 'columns')
    if (cols) push({ id: 'columns', label: 'Columns', value: cols })
    if (str(f.created)) push({ id: 'created', label: 'Created', value: formatPeekValue({ format: 'date' }, f.created!) })
    if (str(f.modified)) push({ id: 'modified', label: 'Last modified', value: formatPeekValue({ format: 'date' }, f.modified!) })
  } else if (open.kind === 'procedure' || open.kind === 'function') {
    const fnType = open.kind === 'function' ? str(f.functionType) : undefined
    if (fnType) push({ id: 'type', label: 'Type', value: displayText(fnType) })
    const params = listCountString(open, 'parameters')
    if (params) push({ id: 'parameters', label: 'Parameters', value: params })
    if (str(f.created)) push({ id: 'created', label: 'Created', value: formatPeekValue({ format: 'date' }, f.created!) })
    if (str(f.modified)) push({ id: 'modified', label: 'Last modified', value: formatPeekValue({ format: 'date' }, f.modified!) })
  } else if (open.kind === 'key') {
    const keyType = str(f.keyType)
    if (keyType) push({ id: 'keyType', label: 'Type', value: displayText(keyType) })
    const keyCols = listCountString(open, 'keyColumns')
    if (keyCols) push({ id: 'keyColumns', label: 'Key columns', value: keyCols })
    if (str(f.deleteAction)) push({ id: 'deleteAction', label: 'On delete', value: formatPeekValue({ format: 'code' }, f.deleteAction!) })
    if (str(f.updateAction)) push({ id: 'updateAction', label: 'On update', value: formatPeekValue({ format: 'code' }, f.updateAction!) })
  } else if (open.kind === 'constraint') {
    const constraintType = str(f.constraintType)
    if (constraintType) push({ id: 'type', label: 'Type', value: displayText(constraintType) })
    const col = str(f.column)
    if (col) push({ id: 'column', label: 'Column', value: displayText(col) })
  } else if (open.kind === 'login') {
    const loginType = str(f.loginType)
    if (loginType) push({ id: 'type', label: 'Login type', value: displayText(loginType) })
    const roles = listCountString(open, 'serverRoles')
    if (roles) push({ id: 'roles', label: 'Server roles', value: roles })
    const dbs = listCountString(open, 'userMapping')
    if (dbs) push({ id: 'databases', label: 'Mapped DBs', value: dbs })
    const defaultDb = str(f.defaultDatabase)
    if (defaultDb) push({ id: 'defaultDb', label: 'Default DB', value: displayText(defaultDb) })
  } else if (open.kind === 'trigger' || open.kind === 'databaseTrigger' || open.kind === 'serverTrigger') {
    const events = listCountString(open, 'events')
    if (events) push({ id: 'events', label: 'Events', value: events })
    if (str(f.created)) push({ id: 'created', label: 'Created', value: formatPeekValue({ format: 'date' }, f.created!) })
    if (str(f.modified)) push({ id: 'modified', label: 'Last modified', value: formatPeekValue({ format: 'date' }, f.modified!) })
  } else if (open.kind === 'sequence') {
    const dataType = str(f.dataType), current = str(f.currentValue), increment = str(f.increment)
    if (dataType) push({ id: 'dataType', label: 'Data type', value: displayText(dataType) })
    if (current) push({ id: 'current', label: 'Current value', value: displayText(current) })
    if (increment) push({ id: 'increment', label: 'Increment', value: displayText(increment) })
  } else if (open.kind === 'synonym') {
    const baseObject = str(f.baseObject)
    if (baseObject) push({ id: 'base', label: 'Base object', value: displayText(baseObject) })
    if (str(f.created)) push({ id: 'created', label: 'Created', value: formatPeekValue({ format: 'date' }, f.created!) })
  } else if (open.kind === 'type') {
    const baseType = str(f.baseType), className = str(f.className)
    if (baseType) push({ id: 'baseType', label: 'Data type', value: displayText(baseType) })
    else if (className) push({ id: 'className', label: 'Class', value: displayText(className) })
    if (num(f.maxLength) !== undefined) push({ id: 'bytes', label: 'Bytes', value: formatPeekValue({ format: 'count' }, f.maxLength!) })
  }
  return kpis
}

function toFactItem(open: OpenPeek, fact: PeekFact, raw: PeekValue, onFollow?: (target: ObjectRef, label: string) => void): FactItem {
  const formatted = formatPeekValue(fact, raw)
  const isEmpty = raw === null
  const link = !isEmpty && onFollow ? peekFactLink(open, fact.id, raw) : undefined
  return {
    id: fact.id,
    label: fact.label,
    value: isEmpty ? '' : formatted,
    mono: monoFactIds.has(fact.id),
    ...(link && onFollow ? { onLink: () => onFollow(link.target, link.label), linkLabel: `Peek ${link.label}` } : {})
  }
}

function toCapabilityItem(kind: OpenPeek['kind'], fact: PeekFact, value: boolean): CapabilityItem {
  if (kind === 'key' || kind === 'constraint') {
    if (fact.id === 'disabled') {
      return value
        ? { id: fact.id, label: 'Disabled', notable: true, tone: 'error' }
        : { id: fact.id, label: 'Enabled', notable: true, tone: 'success' }
    }
    if (fact.id === 'notTrusted') {
      return value
        ? { id: fact.id, label: 'Not trusted', notable: true, tone: 'warning' }
        : { id: fact.id, label: 'Trusted', notable: true, tone: 'success' }
    }
    if (fact.id === 'systemNamed') {
      return value
        ? { id: fact.id, label: 'System-named', notable: true, tone: 'neutral' }
        : { id: fact.id, label: 'System-named', value: 'No', notable: false, tone: 'neutral' }
    }
  }
  if (defaultTrueBooleans.has(fact.id)) {
    const notable = !value
    return {
      id: fact.id,
      label: fact.label,
      value: value ? 'On' : 'Off',
      notable,
      tone: notable ? (fact.id === 'allowNulls' ? 'neutral' : 'warning') : 'neutral'
    }
  }
  const notable = value
  const tone: CapabilityItem['tone'] = !value ? 'neutral'
    : errorBooleans.has(fact.id) ? 'error'
      : warningBooleans.has(fact.id) ? 'warning'
        : neutralBooleans.has(fact.id) ? 'neutral'
          : 'accent'
  return {
    id: fact.id,
    label: fact.label,
    ...(value ? {} : { value: 'Off' }),
    notable,
    tone
  }
}

/** Subtype-filtered groups for `open`. */
export function visiblePeekGroups(open: OpenPeek) {
  if (!isPeekKind(open.kind)) return []
  const subtype = open.node.subtype
  return peekSpecs[open.kind].groups.filter(group => !group.subtypes || (subtype !== undefined && group.subtypes.includes(subtype)))
}

/** Builds structured FactGrid sections and CapabilityChips for the Overview tab (excluding dedicated Storage/Usage tabs). */
export function peekOverviewModel(open: OpenPeek, onFollow?: (target: ObjectRef, label: string) => void): PeekOverviewModel {
  if (open.facts.status !== 'ready') return { sections: [], capabilities: [] }
  const values = open.facts.value
  const sections: PeekFactSection[] = []
  const capabilities: CapabilityItem[] = []
  const parent = peekParentTarget(open)
  const excluded = open.kind === 'table' ? 'storage' : open.kind === 'index' ? 'usage' : undefined

  for (const group of visiblePeekGroups(open)) {
    if (group.id === excluded) continue
    if (group.refused && open.refused?.includes(group.id)) {
      sections.push({ id: group.id, title: group.title, facts: [], refused: group.refused })
      continue
    }
    const facts: FactItem[] = []
    if (group.id === 'general' && parent && !group.facts.some(fact => fact.id === 'parentTable')) {
      facts.push({
        id: 'parent',
        label: parent.fieldLabel,
        value: parent.label,
        mono: true,
        ...(onFollow ? { onLink: () => onFollow(parent.target, parent.label), linkLabel: `Peek ${parent.label}` } : {})
      })
    }
    for (const fact of group.facts) {
      if (!Object.hasOwn(values, fact.id)) continue
      const raw = values[fact.id]
      if (fact.format === 'bool' && typeof raw === 'boolean') {
        capabilities.push(toCapabilityItem(open.kind, fact, raw))
      } else {
        facts.push(toFactItem(open, fact, raw, onFollow))
      }
    }
    if (facts.length > 0) sections.push({ id: group.id, title: group.title, facts })
  }

  return { sections, capabilities }
}

/** Builds FactGrid items for the Storage & Layout tab (`table`). */
export function peekStorageModel(open: OpenPeek): { readonly meter?: PeekRatioMeter; readonly facts: readonly FactItem[] } {
  if (open.facts.status !== 'ready' || !isPeekKind(open.kind)) return { facts: [] }
  const group = peekSpecs[open.kind].groups.find(item => item.id === 'storage')
  if (!group) return { facts: [] }
  const values = open.facts.value
  const facts = group.facts.filter(fact => Object.hasOwn(values, fact.id)).map(fact => toFactItem(open, fact, values[fact.id]))
  return { meter: peekRatioMeter(open), facts }
}

/** Builds RatioBar and FactGrid items (or refused words) for the Usage Telemetry tab (`index`). */
export function peekUsageModel(open: OpenPeek): { readonly meter?: PeekRatioMeter; readonly facts: readonly FactItem[]; readonly refused?: string } {
  if (open.facts.status !== 'ready' || !isPeekKind(open.kind)) return { facts: [] }
  const group = peekSpecs[open.kind].groups.find(item => item.id === 'usage')
  if (!group) return { facts: [] }
  if (group.refused && open.refused?.includes(group.id)) return { facts: [], refused: group.refused }
  const values = open.facts.value
  const facts = group.facts.filter(fact => Object.hasOwn(values, fact.id)).map(fact => toFactItem(open, fact, values[fact.id]))
  return { meter: peekRatioMeter(open), facts }
}

const vitalsFactOrder: Readonly<Partial<Record<OpenPeek['kind'], readonly string[]>>> = {
  table: ['rowCount', 'dataSpace', 'indexSpace', 'filegroup', 'compression', 'modified'],
  index: ['indexType', 'space', 'rowCount', 'fillFactor', 'filegroup', 'lastSeek'],
  key: ['parentTable', 'referencedTable', 'keyType', 'deleteAction', 'updateAction', 'modified'],
  constraint: ['parentTable', 'constraintType', 'column', 'modified'],
  view: ['schema', 'created', 'modified'],
  procedure: ['schema', 'executeAs', 'created', 'modified'],
  function: ['schema', 'functionType', 'executeAs', 'modified'],
  trigger: ['executeAs', 'created', 'modified'],
  databaseTrigger: ['executeAs', 'created', 'modified'],
  serverTrigger: ['executeAs', 'created', 'modified'],
  database: ['status', 'size', 'recoveryModel', 'compatibilityLevel', 'collation', 'owner'],
  login: ['loginType', 'defaultDatabase', 'defaultLanguage', 'created', 'modified'],
  synonym: ['schema', 'baseObject', 'created', 'modified'],
  sequence: ['dataType', 'currentValue', 'increment', 'cache'],
  type: ['schema', 'baseType', 'className', 'maxLength', 'collation'],
  tableType: ['schema', 'created', 'modified']
}

/** Compact Vitals rail content: optional flat RatioBar, top key facts (with links), and active/notable capability chips. */
export function peekVitalsModel(open: OpenPeek, onFollow?: (target: ObjectRef, label: string) => void): PeekVitalsModel {
  if (open.facts.status !== 'ready') return { facts: [], notableFlags: [] }
  const values = open.facts.value
  const allFacts = new Map(visiblePeekGroups(open).flatMap(group => group.refused && open.refused?.includes(group.id) ? [] : group.facts).map(fact => [fact.id, fact]))
  const facts: FactItem[] = []
  const parent = peekParentTarget(open)
  const wanted = vitalsFactOrder[open.kind] ?? []

  if (parent && !wanted.includes('parentTable')) {
    facts.push({
      id: 'parent',
      label: parent.fieldLabel,
      value: parent.label,
      mono: true,
      ...(onFollow ? { onLink: () => onFollow(parent.target, parent.label), linkLabel: `Peek ${parent.label}` } : {})
    })
  }
  for (const id of wanted) {
    const spec = allFacts.get(id)
    if (!spec || !Object.hasOwn(values, id)) continue
    facts.push(toFactItem(open, spec, values[id], onFollow))
  }
  // Surface list counts when helpful for concise objects like views, procedures and functions.
  if (open.kind === 'view' || open.kind === 'tableType') {
    const cols = listCountString(open, 'columns')
    if (cols) facts.push({ id: 'columnsCount', label: 'Columns', value: cols })
  } else if (open.kind === 'procedure' || open.kind === 'function') {
    const params = listCountString(open, 'parameters')
    if (params) facts.push({ id: 'parametersCount', label: 'Parameters', value: params })
  } else if (open.kind === 'trigger' || open.kind === 'databaseTrigger' || open.kind === 'serverTrigger') {
    const events = listCountString(open, 'events')
    if (events) facts.push({ id: 'eventsCount', label: 'Events', value: events })
  }

  const notableFlags = peekOverviewModel(open).capabilities.filter(item => item.notable)
  return { meter: peekRatioMeter(open), facts, notableFlags }
}

/** Tab count badge for list tabs and loaded Dependencies; undefined when not applicable or not yet loaded. */
export function peekTabCount(open: OpenPeek, tab: PeekTab): number | string | undefined {
  if (isPeekListTab(tab)) {
    const list = open.lists?.[tab]
    if (!list) return undefined
    return list.truncated ? `${formatCount(list.rows.length)}+` : list.rows.length
  }
  if (tab === 'dependencies' && open.dependencies?.status === 'ready') {
    const { uses, usedBy, usesTruncated, usedByTruncated } = open.dependencies.value
    const total = uses.length + usedBy.length
    return usesTruncated || usedByTruncated ? `${formatCount(total)}+` : total
  }
  return undefined
}
