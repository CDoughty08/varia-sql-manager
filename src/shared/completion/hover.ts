// Hover from the index (docs/language-services.md, Completion from the index): a table's schema summary (its columns and types,
// partitioning, clustering, rows and size), a column's or field's type and description, a WITH query's columns, and a function's
// signatures. Markdown, never trusted, with every name escaped. Nothing here knows an engine.
import { languageLookupLimits, type LanguageLookupObject } from '../language-lookup'
import type { CompletionDialect, HoverRead, IndexLookup, TextSpan } from './model'
import { ScopeResolver, childrenOf, columnAt, type ScopeColumn } from './resolve'

export interface IndexHover { readonly markdown: string; readonly span: TextSpan }
/** Columns a table's hover lists before "and N more". */
export const hoverColumns = 40

/** Text as Markdown shows it literally: every character Markdown or a table cell could read as syntax is escaped. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ')
}

const bytesText = (bytes: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

/** A table's summary: its kind and path, its facts, then its top-level columns with their types. */
export function objectMarkdown(dialect: CompletionDialect, path: readonly string[], object: LanguageLookupObject, columns: readonly ScopeColumn[], truncated: boolean): string {
  const lines = [`**${escapeMarkdown(object.name)}** · ${escapeMarkdown(dialect.objectLabel(object.kind, object.subtype))}`, '', escapeMarkdown(dialect.pathText(path))]
  const facts: string[] = []
  if (object.rows !== undefined) facts.push(`${object.rows.toLocaleString('en-US')} rows`)
  if (object.bytes !== undefined) facts.push(bytesText(object.bytes))
  if (object.partitioning) facts.push(`Partitioned by ${escapeMarkdown(object.partitioning)}`)
  if (object.clustering) facts.push(`Clustered by ${escapeMarkdown(object.clustering)}`)
  if (object.shards) facts.push(`${object.shards.count.toLocaleString('en-US')} shards, ${escapeMarkdown(object.shards.first)} to ${escapeMarkdown(object.shards.last)}`)
  if (object.signature) facts.push(escapeMarkdown(object.signature))
  if (facts.length) lines.push('', facts.join(' · '))
  const top = childrenOf(columns, [])
  if (top.length) {
    lines.push('', '| Column | Type |', '| --- | --- |')
    for (const column of top.slice(0, hoverColumns)) lines.push(`| ${escapeMarkdown(column.path)} | ${escapeMarkdown(column.type ?? '')}${column.nullable === false ? ' REQUIRED' : ''} |`)
    const more = top.length - Math.min(top.length, hoverColumns)
    if (more || truncated || object.columnsCut) lines.push('', more ? `and ${more.toLocaleString('en-US')} more columns` : 'and more columns')
  } else if (!object.detailed) lines.push('', 'Its columns are not indexed yet.')
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
    // Only the whole name: its project or dataset part says nothing worth a hover yet.
    if (at !== parts.length - 1) return
    const cte = parts.length === 1 ? resolver.cte(parts[0]) : undefined
    if (cte) {
      const columns = (await resolver.columns({ kind: 'cte', name: parts[0], cte: parts[0] })).columns
      return { span, markdown: [`**${escapeMarkdown(parts[0])}** · WITH query`, '', ...childrenOf(columns, []).slice(0, hoverColumns).map(column => `- ${escapeMarkdown(column.path)}`)].join('\n') }
    }
    const path = dialect.objectPath(parts)
    if (!path) return
    const [answer] = await resolver.load([{ path: [...path], limit: languageLookupLimits.items }])
    if (!answer?.object) return
    return { span, markdown: objectMarkdown(dialect, answer.path, answer.object, answer.items.map(item => ({ path: item.name, type: item.type, nullable: item.nullable })), answer.truncated) }
  }
  await resolver.load([], true)
  const field = await resolver.field(upTo)
  if (field) {
    const owner = field.source.kind === 'object' ? field.columns.path && dialect.pathText(field.columns.path) : field.source.name
    if (!field.path.length) {
      // The alias itself: its table's summary, or a WITH query's or subquery's columns.
      if (field.columns.object && field.columns.path) return { span, markdown: objectMarkdown(dialect, field.columns.path, field.columns.object, field.columns.columns, field.columns.truncated) }
      const top = childrenOf(field.columns.columns, [])
      return top.length ? { span, markdown: [`**${escapeMarkdown(parts[0])}**`, '', ...top.slice(0, hoverColumns).map(column => `- ${escapeMarkdown(column.path)}${column.type ? ` ${escapeMarkdown(column.type)}` : ''}`)].join('\n') } : undefined
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
