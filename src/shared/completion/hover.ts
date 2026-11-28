// Hover and lazy schema preview drawer from the index (docs/language-services.md, Completion from the index):
// 3-level BigQuery hover (project tier & counts, dataset location & counts, table/view/routine schema with description
// and nested STRUCT field counts), column/field descriptions, WITH queries, functions, and SQL Server IndexLookup
// object summaries (columns, PK/UK/Identity markers, indexes, and foreign keys). Markdown, never trusted, with every
// name escaped.
import {
  languageLookupLimits,
  type LanguageLookupItem,
  type LanguageLookupObject,
  type LanguageLookupProjectTier,
  type LanguageLookupState
} from '../language-lookup'
import type { CompletionDialect, HoverRead, IndexLookup, TextSpan } from './model'
import { ScopeResolver, childrenOf, columnAt, type ScopeColumn } from './resolve'

export interface IndexHover { readonly markdown: string; readonly span: TextSpan }
/** Columns a table's hover or drawer lists before "and N more". */
export const hoverColumns = 40
const structPreviewFields = 4
const sampleNamesLimit = 8
const sqlRelationLimit = 6

export interface ObjectMarkdownOptions {
  readonly tier?: LanguageLookupProjectTier
  readonly namesOnly?: boolean
  readonly maxColumns?: number
}

/** Text as Markdown shows it literally: every character Markdown or a table cell could read as syntax is escaped. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r\n|[\r\n]/g, ' ')
}

const bytesText = (bytes: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

export function projectTierLabel(tier?: LanguageLookupProjectTier): string | undefined {
  if (tier === 'billing') return 'Billing'
  if (tier === 'starred') return '★ Starred'
  if (tier === 'discovered') return 'Discovered'
  return undefined
}

function structFieldSummary(columns: readonly ScopeColumn[], column: ScopeColumn): string {
  const nested = childrenOf(columns, [column.path])
  if (!nested.length) return ''
  const preview = nested.slice(0, structPreviewFields).map(child => escapeMarkdown(child.path.slice(column.path.length + 1)))
  const more = nested.length > structPreviewFields ? ', …' : ''
  return ` · ${nested.length.toLocaleString('en-US')} ${nested.length === 1 ? 'field' : 'fields'}: ${preview.join(', ')}${more}`
}

/** A table's summary: its kind, optional PR #738 tier, path, facts, description, then top-level columns with nested STRUCT summaries. */
export function objectMarkdown(
  dialect: CompletionDialect,
  path: readonly string[],
  object: LanguageLookupObject,
  columns: readonly ScopeColumn[],
  truncated: boolean,
  options: ObjectMarkdownOptions = {}
): string {
  const tier = projectTierLabel(options.tier)
  const heading = [
    `**${escapeMarkdown(object.name)}**`,
    escapeMarkdown(dialect.objectLabel(object.kind, object.subtype)),
    tier ? escapeMarkdown(tier) : undefined
  ].filter(Boolean).join(' · ')
  const lines = [heading, '', escapeMarkdown(dialect.pathText(path))]
  const facts: string[] = []
  if (object.rows !== undefined) facts.push(`${object.rows.toLocaleString('en-US')} rows`)
  if (object.bytes !== undefined) facts.push(bytesText(object.bytes))
  if (object.partitioning) facts.push(`Partitioned by ${escapeMarkdown(object.partitioning)}`)
  if (object.clustering) facts.push(`Clustered by ${escapeMarkdown(object.clustering)}`)
  if (object.shards) facts.push(`${object.shards.count.toLocaleString('en-US')} shards, ${escapeMarkdown(object.shards.first)} to ${escapeMarkdown(object.shards.last)}`)
  if (object.signature) facts.push(escapeMarkdown(object.signature))
  if (facts.length) lines.push('', facts.join(' · '))
  if (object.description) lines.push('', escapeMarkdown(object.description))
  const top = childrenOf(columns, [])
  const maxCols = options.maxColumns ?? hoverColumns
  if (top.length) {
    lines.push('', '| Column | Type |', '| --- | --- |')
    for (const column of top.slice(0, maxCols)) {
      const baseType = `${escapeMarkdown(column.type ?? '')}${column.nullable === false ? ' REQUIRED' : ''}`
      const nested = structFieldSummary(columns, column)
      lines.push(`| ${escapeMarkdown(column.path)} | ${baseType}${nested} |`)
    }
    const more = top.length - Math.min(top.length, maxCols)
    if (more || truncated || object.columnsCut) lines.push('', more ? `and ${more.toLocaleString('en-US')} more columns` : 'and more columns')
  } else if (!object.detailed) {
    lines.push('', options.namesOnly ? 'Columns not indexed yet (names only — memory cap or Wave 3 pending).' : 'Its columns are not indexed yet.')
  }
  return lines.join('\n')
}

/** A BigQuery project's summary for 3-level hover and the lazy details drawer: PR #738 tier, dataset counts, and refresh/star hint. */
export function projectMarkdown(
  dialect: CompletionDialect,
  project: string,
  info: LanguageLookupItem | undefined,
  datasets: readonly LanguageLookupItem[],
  state: LanguageLookupState,
  truncated: boolean
): string {
  const tier = projectTierLabel(info?.tier)
  const heading = tier ? `**${escapeMarkdown(project)}** · ${escapeMarkdown(tier)} project` : `**${escapeMarkdown(project)}** · Project`
  const lines = [heading, '', escapeMarkdown(dialect.pathText([project]))]
  const facts: string[] = []
  if (datasets.length || state === 'ready') {
    facts.push(`${datasets.length.toLocaleString('en-US')}${truncated ? '+' : ''} ${datasets.length === 1 ? 'dataset' : 'datasets'}`)
  }
  const namesOnly = info?.namesOnly === true || info?.detail === 'names'
  if (namesOnly) facts.push('Names only (memory cap)')
  else if (info?.partial || state === 'partial') facts.push('Partially indexed')
  else if (state === 'building') facts.push('Indexing…')
  else if (state === 'skipped') facts.push('Skipped')
  if (facts.length) lines.push('', facts.join(' · '))
  if (datasets.length) {
    const sample = datasets.slice(0, sampleNamesLimit).map(item => escapeMarkdown(item.name)).join(', ')
    const more = datasets.length > sampleNamesLimit || truncated ? ', …' : ''
    lines.push('', `Datasets: ${sample}${more}`)
  }
  const hint = info?.tier === 'billing'
    ? 'Billing project · Ctrl+Shift+R refreshes cache.'
    : info?.tier === 'starred'
      ? 'Starred for full schema indexing · Ctrl+Shift+R refreshes cache.'
      : 'Star in Object Explorer to prioritize full schema indexing · Ctrl+Shift+R refreshes cache.'
  lines.push('', escapeMarkdown(hint))
  return lines.join('\n')
}

/** A BigQuery dataset's summary for 3-level hover and the lazy details drawer: location, object counts by kind, and refresh hint. */
export function datasetMarkdown(
  dialect: CompletionDialect,
  project: string,
  dataset: string,
  info: LanguageLookupItem | undefined,
  objects: readonly LanguageLookupItem[],
  state: LanguageLookupState,
  truncated: boolean,
  tier?: LanguageLookupProjectTier
): string {
  const location = info?.detail?.trim()
  const tierText = projectTierLabel(tier)
  const heading = [
    `**${escapeMarkdown(dataset)}**`,
    location ? `Dataset · ${escapeMarkdown(location)}` : 'Dataset',
    tierText ? escapeMarkdown(tierText) : undefined
  ].filter(Boolean).join(' · ')
  const lines = [heading, '', escapeMarkdown(dialect.pathText([project, dataset]))]
  let tables = 0, views = 0, routines = 0, models = 0
  for (const item of objects) {
    if (item.kind === 'bqView' || item.kind === 'bqMaterializedView') views++
    else if (item.kind === 'bqRoutine') routines++
    else if (item.kind === 'bqModel') models++
    else tables++
  }
  const counts: string[] = []
  if (tables) counts.push(`${tables.toLocaleString('en-US')} ${tables === 1 ? 'table' : 'tables'}`)
  if (views) counts.push(`${views.toLocaleString('en-US')} ${views === 1 ? 'view' : 'views'}`)
  if (routines) counts.push(`${routines.toLocaleString('en-US')} ${routines === 1 ? 'routine' : 'routines'}`)
  if (models) counts.push(`${models.toLocaleString('en-US')} ${models === 1 ? 'model' : 'models'}`)
  if (truncated) counts.push('more indexed…')
  if (state === 'building') counts.push('Indexing…')
  else if (state === 'partial' || info?.partial) counts.push('Partial')
  else if (state === 'skipped') counts.push('Skipped')
  if (counts.length) lines.push('', counts.join(' · '))
  else lines.push('', 'No indexed objects in this dataset yet.')
  if (info?.description) lines.push('', escapeMarkdown(info.description))
  if (objects.length) {
    const sample = objects.slice(0, sampleNamesLimit).map(item => escapeMarkdown(item.name)).join(', ')
    const more = objects.length > sampleNamesLimit || truncated ? ', …' : ''
    lines.push('', `Objects: ${sample}${more}`)
  }
  lines.push('', escapeMarkdown('Ctrl+Shift+R refreshes this dataset’s cache.'))
  return lines.join('\n')
}

const sqlKindLabels: Readonly<Record<string, string>> = {
  table: 'Table', view: 'View', procedure: 'Stored procedure', function: 'Function',
  tableType: 'Table type', synonym: 'Synonym', sequence: 'Sequence', database: 'Database', schema: 'Schema'
}

function sqlBracketPath(path: readonly string[]): string {
  return path.map(segment => `[${segment.replaceAll(']', ']]')}]`).join('.')
}

/** A SQL Server object's summary from local `IndexLookup.cs` via `language.lookup`: columns, PK/UK/Identity markers, indexes, and FKs. */
export function sqlObjectMarkdown(
  path: readonly string[],
  object: LanguageLookupObject,
  items: readonly LanguageLookupItem[],
  truncated: boolean,
  maxColumns = hoverColumns
): string {
  const schema = path.length >= 2 ? path[path.length - 2] : undefined
  const titleName = schema ? `${schema}.${object.name}` : object.name
  const kindLabel = sqlKindLabels[object.kind] ?? object.kind
  const lines = [`**${escapeMarkdown(titleName)}** · ${escapeMarkdown(kindLabel)}`, '', escapeMarkdown(sqlBracketPath(path))]
  const columns = items.filter(item => item.kind === 'column')
  const parameters = items.filter(item => item.kind === 'parameter')
  const primaryKeys = items.filter(item => item.kind === 'key' && item.subtype === 'primary')
  const uniqueKeys = items.filter(item => item.kind === 'key' && item.subtype === 'unique')
  const indexes = items.filter(item => item.kind === 'index')
  const outgoingFks = items.filter(item => item.kind === 'foreignKey' && item.subtype === 'outgoing')
  const incomingFks = items.filter(item => item.kind === 'foreignKey' && item.subtype === 'incoming')

  const facts: string[] = []
  if (primaryKeys.length) {
    const pkDetail = primaryKeys[0].detail
    facts.push(pkDetail ? `PK ${escapeMarkdown(pkDetail)}` : 'Primary key')
  }
  if (uniqueKeys.length) facts.push(`${uniqueKeys.length} unique ${uniqueKeys.length === 1 ? 'key' : 'keys'}`)
  if (indexes.length) facts.push(`${indexes.length} ${indexes.length === 1 ? 'index' : 'indexes'}`)
  if (outgoingFks.length) facts.push(`${outgoingFks.length} ${outgoingFks.length === 1 ? 'FK' : 'FKs'} out`)
  if (incomingFks.length) facts.push(`${incomingFks.length} referenced by`)
  if (object.signature) facts.push(escapeMarkdown(object.signature))
  if (facts.length) lines.push('', facts.join(' · '))

  if (columns.length) {
    lines.push('', '| Column | Type |', '| --- | --- |')
    for (const column of columns.slice(0, maxColumns)) {
      const parts: string[] = []
      if (column.type) parts.push(escapeMarkdown(column.type))
      if (column.nullable === false) parts.push('NOT NULL')
      if (column.detail) parts.push(escapeMarkdown(column.detail))
      lines.push(`| ${escapeMarkdown(column.name)} | ${parts.join(' · ')} |`)
    }
    const more = columns.length - Math.min(columns.length, maxColumns)
    if (more || truncated) lines.push('', more ? `and ${more.toLocaleString('en-US')} more columns` : 'and more columns')
  } else if (parameters.length) {
    lines.push('', '| Parameter | Type |', '| --- | --- |')
    for (const parameter of parameters.slice(0, maxColumns)) {
      const parts: string[] = []
      if (parameter.type) parts.push(escapeMarkdown(parameter.type))
      if (parameter.detail) parts.push(escapeMarkdown(parameter.detail))
      lines.push(`| ${escapeMarkdown(parameter.name)} | ${parts.join(' · ')} |`)
    }
  } else if (!object.detailed) {
    lines.push('', 'Columns were left out by the Search Objects memory budget.')
  }

  const keyIndexList = [...primaryKeys, ...uniqueKeys, ...indexes]
  if (keyIndexList.length) {
    lines.push('', '**Keys & Indexes**')
    for (const entry of keyIndexList.slice(0, sqlRelationLimit)) {
      const badge = entry.kind === 'key' ? (entry.subtype === 'primary' ? 'PK' : 'UK') : (entry.subtype ?? 'index')
      lines.push(`- ${escapeMarkdown(badge)}: ${escapeMarkdown(entry.name)}${entry.detail ? ` ${escapeMarkdown(entry.detail)}` : ''}`)
    }
    if (keyIndexList.length > sqlRelationLimit) lines.push(`- and ${(keyIndexList.length - sqlRelationLimit).toLocaleString('en-US')} more`)
  }
  const fkList = [...outgoingFks, ...incomingFks]
  if (fkList.length) {
    lines.push('', '**Foreign Keys**')
    for (const fk of fkList.slice(0, sqlRelationLimit)) {
      const dir = fk.subtype === 'incoming' ? '←' : '→'
      lines.push(`- ${dir} ${escapeMarkdown(fk.detail ?? fk.name)}`)
    }
    if (fkList.length > sqlRelationLimit) lines.push(`- and ${(fkList.length - sqlRelationLimit).toLocaleString('en-US')} more`)
  }
  return lines.join('\n')
}

function columnMarkdown(column: ScopeColumn, owner?: string): string {
  const lines = [`**${escapeMarkdown(column.path)}** ${escapeMarkdown(column.type ?? '')}${column.nullable === false ? ' · REQUIRED' : ''}`]
  if (column.description) lines.push('', escapeMarkdown(column.description))
  if (owner) lines.push('', `In ${escapeMarkdown(owner)}`)
  return lines.join('\n')
}

/** Hover at a name chain the grammar read, from the index through `lookup`. */
export async function hoverFromIndex(read: HoverRead, dialect: CompletionDialect, lookup: IndexLookup): Promise<IndexHover | undefined> {
  const { parts, at, span, scope } = read
  const upTo = parts.slice(0, at + 1)
  const resolver = new ScopeResolver(scope, dialect, lookup)
  if (read.object) {
    if (at !== parts.length - 1) {
      const fullPath = dialect.objectPath(parts)
      // 3-part name (`project.dataset.table`): at 0 is project, at 1 is dataset.
      // 2-part name (`dataset.table` with billing project): at 0 is dataset in billing project (or project if dataset absent).
      if (parts.length === 3 && at === 0) {
        const project = parts[0]
        const [projectInfo, datasets] = await resolver.load([
          { path: [], prefix: project, exact: true, limit: 1 },
          { path: [project], limit: languageLookupLimits.defaultItems }
        ])
        const info = projectInfo?.items[0]
        if (!info && (!datasets || datasets.state === 'absent')) return undefined
        const resolvedProject = datasets?.path[0] ?? info?.name ?? project
        return { span, markdown: projectMarkdown(dialect, resolvedProject, info, datasets?.items ?? [], datasets?.state ?? 'ready', datasets?.truncated ?? false) }
      }
      const datasetPath = parts.length === 3 && at === 1
        ? [parts[0], parts[1]]
        : fullPath && fullPath.length === 3 && at === 0
          ? [fullPath[0], parts[0]]
          : undefined
      if (datasetPath) {
        const [project, dataset] = datasetPath
        const [dsInfo, objects, projectInfo] = await resolver.load([
          { path: [project], prefix: dataset, exact: true, limit: 1 },
          { path: [project, dataset], limit: languageLookupLimits.defaultItems },
          { path: [], prefix: project, exact: true, limit: 1 }
        ])
        const info = dsInfo?.items[0]
        if (info || (objects && objects.state !== 'absent')) {
          const resolvedProject = objects?.path[0] ?? projectInfo?.items[0]?.name ?? project
          const resolvedDataset = objects?.path[1] ?? info?.name ?? dataset
          return { span, markdown: datasetMarkdown(dialect, resolvedProject, resolvedDataset, info, objects?.items ?? [], objects?.state ?? 'ready', objects?.truncated ?? false, projectInfo?.items[0]?.tier) }
        }
        // Fallback: on a 2-part `project.dataset` reference where `parts[0]` is a project name, show project hover.
        if (parts.length === 2 && at === 0) {
          const [pInfo, pDatasets] = await resolver.load([
            { path: [], prefix: parts[0], exact: true, limit: 1 },
            { path: [parts[0]], limit: languageLookupLimits.defaultItems }
          ])
          if (pInfo?.items[0] || (pDatasets && pDatasets.state !== 'absent')) {
            const resolvedProject = pDatasets?.path[0] ?? pInfo?.items[0]?.name ?? parts[0]
            return { span, markdown: projectMarkdown(dialect, resolvedProject, pInfo?.items[0], pDatasets?.items ?? [], pDatasets?.state ?? 'ready', pDatasets?.truncated ?? false) }
          }
        }
      }
      return undefined
    }
    const cte = parts.length === 1 ? resolver.cte(parts[0]) : undefined
    if (cte) {
      // Its `*` reads objects: ask for them first.
      await resolver.load()
      const columns = (await resolver.columns({ kind: 'cte', name: parts[0], cte: parts[0] })).columns
      const allTop = childrenOf(columns, [])
      const shown = allTop.slice(0, hoverColumns)
      const more = allTop.length - shown.length
      const lines = [`**${escapeMarkdown(parts[0])}** · WITH query`, '', ...shown.map(column => `- ${escapeMarkdown(column.path)}`)]
      if (more > 0) lines.push('', `and ${more.toLocaleString('en-US')} more columns`)
      return { span, markdown: lines.join('\n') }
    }
    const path = dialect.objectPath(parts)
    if (!path) return
    const [answer, projectInfo] = await resolver.load([
      { path: [...path], limit: languageLookupLimits.items, details: true },
      { path: [], prefix: path[0], exact: true, limit: 1 }
    ])
    if (!answer?.object) return
    const proj = projectInfo?.items[0]
    return {
      span,
      markdown: objectMarkdown(
        dialect,
        answer.path,
        answer.object,
        answer.items.map(item => ({ path: item.name, type: item.type, nullable: item.nullable, description: item.description })),
        answer.truncated,
        { tier: proj?.tier, namesOnly: proj?.namesOnly === true || proj?.detail === 'names' }
      )
    }
  }
  await resolver.load([], true)
  const field = await resolver.field(upTo)
  if (field) {
    const owner = field.source.kind === 'object' ? field.columns.path && dialect.pathText(field.columns.path) : field.source.name
    if (!field.path.length) {
      // The alias itself: its table's summary (with project tier / namesOnly), or a WITH query's or subquery's columns.
      if (field.columns.object && field.columns.path) {
        const [projectInfo] = field.columns.path[0]
          ? await resolver.load([{ path: [], prefix: field.columns.path[0], exact: true, limit: 1 }])
          : [undefined]
        const proj = projectInfo?.items[0]
        return {
          span,
          markdown: objectMarkdown(
            dialect,
            field.columns.path,
            field.columns.object,
            field.columns.columns,
            field.columns.truncated,
            { tier: proj?.tier, namesOnly: proj?.namesOnly === true || proj?.detail === 'names' }
          )
        }
      }
      const allTop = childrenOf(field.columns.columns, [])
      if (!allTop.length) return undefined
      const shown = allTop.slice(0, hoverColumns)
      const more = allTop.length - shown.length
      const lines = [`**${escapeMarkdown(parts[0])}**`, '', ...shown.map(column => `- ${escapeMarkdown(column.path)}${column.type ? ` ${escapeMarkdown(column.type)}` : ''}`)]
      if (more > 0) lines.push('', `and ${more.toLocaleString('en-US')} more columns`)
      return { span, markdown: lines.join('\n') }
    }
    const column = columnAt(field.columns.columns, field.path)
    if (column) return { span, markdown: columnMarkdown(column, owner) }
  }
  const call = dialect.functionNamed(upTo.join('.'))
  if (call && at === parts.length - 1) {
    return { span, markdown: [`**${escapeMarkdown(call.name)}**`, '', escapeMarkdown(call.summary), '', ...call.signatures.map(signature => `- ${escapeMarkdown(signature)}`)].join('\n') }
  }
  return undefined
}
