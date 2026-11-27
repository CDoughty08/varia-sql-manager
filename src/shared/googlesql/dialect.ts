// GoogleSQL's side of the completion pipeline (src/shared/completion/model.ts): how BigQuery names are written and quoted, how a
// written table name becomes an index path (project, dataset, table, with the connection's billing project and the tab's default
// dataset filled in), and the catalogue's keywords and functions.
import type { CompletionDialect, CompletionItem, CompletionKind, CompletionSite, CompletionWord, ContainerQuery, DialectColumn, DialectFunction, ObjectVariant, TextSpan } from '../completion/model'
import type { LanguageLookupItem, LanguageLookupObject } from '../language-lookup'
import {
  googleSqlDatePartsFor, googleSqlFunction, googleSqlFunctions, googleSqlInformationSchemaViews, googleSqlKeywords,
  googleSqlNiladicFunctions, googleSqlReservedKeywords, googleSqlSystemVariables, googleSqlTypes, signatureLabel
} from './catalog'

const reserved: ReadonlySet<string> = new Set(googleSqlReservedKeywords)
const niladicSet: ReadonlySet<string> = new Set(googleSqlNiladicFunctions)
const plain = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A name as GoogleSQL takes it: bare when it is a plain word that is not reserved, else in backticks with `\` and `` ` `` escaped. */
export function quoteGoogleSqlName(name: string): string {
  return plain.test(name) && !reserved.has(name.toUpperCase()) ? name : '`' + name.replace(/[\\`]/g, '\\$&') + '`'
}

const keywords = [...new Set([...googleSqlReservedKeywords, ...googleSqlKeywords, ...googleSqlTypes])].sort()
const statementStartKeywords: readonly string[] = [
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'CALL', 'DECLARE', 'SET', 'BEGIN', 'EXPLAIN', 'EXPORT', 'LOAD', 'ASSERT', 'EXECUTE'
]
const castTypes: readonly string[] = [...googleSqlTypes, 'ARRAY', 'STRUCT', 'RANGE']
const compositeCastTypes: readonly { readonly name: string; readonly detail: string; readonly documentation: string }[] = [
  { name: 'ARRAY', detail: 'ARRAY<T>', documentation: 'Ordered list of zero or more elements of the same type.' },
  { name: 'STRUCT', detail: 'STRUCT<...>', documentation: 'Container of ordered fields, each with a type and optional name.' },
  { name: 'RANGE', detail: 'RANGE<T>', documentation: 'Contiguous range of DATE, DATETIME, or TIMESTAMP values.' }
]
const timeOnlyFunctions = new Set(['TIME_TRUNC', 'TIME_DIFF'])
function afterFromKeywords(hasAlias = false, inJoin = false, mergeUsing = false): readonly string[] {
  const list: string[] = []
  if (!hasAlias) list.push('AS')
  if (mergeUsing) {
    list.push('ON')
    return list
  }
  if (inJoin) list.push('ON', 'USING')
  list.push(
    'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
    'GROUP BY', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER BY', 'LIMIT',
    'UNION', 'UNION ALL', 'UNION DISTINCT', 'INTERSECT', 'EXCEPT',
    'FOR SYSTEM_TIME AS OF', 'TABLESAMPLE', 'PIVOT', 'UNPIVOT'
  )
  return list
}
const functions: readonly DialectFunction[] = googleSqlFunctions.map(entry => ({
  name: entry.name,
  summary: entry.summary,
  signatures: entry.signatures.map(signature => signatureLabel(entry.name, signature).label),
  ...niladicSet.has(entry.name) ? { niladic: true } : {}
}))
const byName = new Map(functions.map(entry => [entry.name, entry]))
const namespaces = [...new Set(googleSqlFunctions.filter(entry => entry.name.includes('.')).map(entry => entry.name.slice(0, entry.name.indexOf('.'))))]

const labels: Readonly<Record<string, string>> = {
  bqProject: 'Project', bqDataset: 'Dataset', bqTable: 'Table', bqView: 'View', bqMaterializedView: 'Materialized view', bqExternalTable: 'External table',
  bqRoutine: 'Routine', bqModel: 'Model', bqColumn: 'Column'
}
const subtypeLabels: Readonly<Record<string, string>> = { snapshot: 'Snapshot', clone: 'Clone', procedure: 'Procedure', scalar: 'Function', tableValued: 'Table function', aggregate: 'Aggregate function', struct: 'Record' }
const kinds: Readonly<Record<string, CompletionKind>> = {
  bqProject: 'container', bqDataset: 'container', bqTable: 'table', bqExternalTable: 'table', bqView: 'view', bqMaterializedView: 'view', bqRoutine: 'routine', bqModel: 'model', bqColumn: 'column'
}
const caseSensitiveKinds = new Set<CompletionKind>(['container', 'table', 'view', 'routine', 'model'])

function shardSummary(shards: NonNullable<LanguageLookupItem['shards']>): string {
  const count = shards.count === 1 ? '1 shard' : `${shards.count.toLocaleString('en-US')} shards`
  return `${count}, ${shards.first}–${shards.last}`
}

function isGoogleSqlArrayType(type: string | undefined): boolean {
  return !!type && /^\s*ARRAY\b/i.test(type)
}

function googleSqlPseudoColumns(object: LanguageLookupObject, writtenParts: readonly string[]): readonly DialectColumn[] {
  const out: DialectColumn[] = []
  const lastPart = writtenParts.at(-1)
  if (lastPart?.endsWith('*') && (object.kind === 'bqTable' || object.kind === 'bqExternalTable')) {
    out.push({ name: '_TABLE_SUFFIX', type: 'STRING', description: 'Wildcard table suffix matched by `*`.', pseudo: true })
  }
  if (object.partitioning && /\bon\s+_PARTITIONTIME\b/i.test(object.partitioning)) {
    out.push(
      { name: '_PARTITIONTIME', type: 'TIMESTAMP', description: 'Ingestion-time partition timestamp pseudo-column.', pseudo: true },
      { name: '_PARTITIONDATE', type: 'DATE', description: 'Ingestion-time partition date pseudo-column.', pseudo: true }
    )
  }
  if (object.kind === 'bqExternalTable') {
    out.push({ name: '_FILE_NAME', type: 'STRING', description: 'Fully qualified path of the source file for this row.', pseudo: true })
  }
  return out
}

function googleSqlSiteItems(site: CompletionSite, word: CompletionWord, insert: (name: string) => string): readonly CompletionItem[] | undefined {
  switch (site.kind) {
    case 'castType': {
      const items: CompletionItem[] = googleSqlTypes.map(type => ({
        label: type,
        kind: 'keyword',
        insertText: type,
        detail: 'Type',
        sortText: `700:${type.toLowerCase()}`
      }))
      for (const composite of compositeCastTypes) {
        const snippet = !word.angleAhead
        items.push({
          label: composite.name,
          kind: 'keyword',
          insertText: snippet ? `${composite.name}<$0>` : composite.name,
          ...snippet ? { insertTextIsSnippet: true } : {},
          detail: composite.detail,
          documentation: composite.documentation,
          sortText: `701:${composite.name.toLowerCase()}`
        })
      }
      return items
    }
    case 'datePart': {
      const fn = site.functionName?.toUpperCase().replace(/^SAFE\./, '')
      const detail = fn && timeOnlyFunctions.has(fn) ? 'Time part' : 'Date part'
      return googleSqlDatePartsFor(fn).map((part, index) => ({
        label: part,
        kind: 'keyword',
        insertText: part,
        detail,
        sortText: `7${String(Math.min(index, 99)).padStart(2, '0')}:${part.toLowerCase()}`
      }))
    }
    case 'systemVar': {
      if (site.qualifier?.length) {
        const prefix = `@@${site.qualifier.join('.')}.`.toLowerCase()
        return googleSqlSystemVariables
          .filter(entry => entry.name.toLowerCase().startsWith(prefix) && !entry.name.slice(prefix.length).includes('.'))
          .map(entry => {
            const member = entry.name.slice(prefix.length)
            return {
              label: member,
              kind: 'field' as const,
              insertText: member,
              detail: entry.readOnly ? `${entry.type} · Read-only` : entry.type,
              documentation: entry.summary,
              sortText: `100:${member.toLowerCase()}`,
              filterText: member
            }
          })
      }
      return googleSqlSystemVariables.map(entry => ({
        label: entry.name,
        kind: 'alias' as const,
        insertText: entry.name,
        detail: entry.readOnly ? `${entry.type} · Read-only` : entry.type,
        documentation: entry.summary,
        sortText: `200:${entry.name.toLowerCase()}`,
        filterText: entry.name
      }))
    }
    case 'infoSchema': {
      const last = site.qualifier.at(-1)
      const isRegion = !!last && /^region-/i.test(last)
      const isExplicitDataset = site.qualifier.length > 0 && !isRegion
      const items: CompletionItem[] = []
      for (const view of googleSqlInformationSchemaViews) {
        if (isRegion && view.scope === 'dataset') continue
        if (isExplicitDataset && view.scope === 'region') continue
        const rank = !isRegion && !isExplicitDataset && view.scope === 'region' ? 1 : 0
        const detail = view.scope === 'region'
          ? (isRegion ? 'Region view' : 'Region view · use region-<loc>.INFORMATION_SCHEMA')
          : view.scope === 'dataset'
            ? 'Dataset view'
            : 'Dataset / region view'
        items.push({
          label: view.name,
          kind: 'view',
          insertText: insert(view.name),
          detail,
          documentation: view.summary,
          sortText: `3${String(rank).padStart(2, '0')}:${view.name.toLowerCase()}`,
          filterText: view.name
        })
      }
      return items
    }
    default:
      return undefined
  }
}

function googleSqlArrayMemberHint(targetParts: readonly string[], childFields: readonly string[], qualifierSpan?: TextSpan): CompletionItem {
  const target = targetParts.map(quoteGoogleSqlName).join('.')
  const expr = `UNNEST(${target})`
  const sample = childFields.slice(0, 6)
  const fieldsText = sample.length ? ` (fields: ${sample.join(', ')}${childFields.length > sample.length ? ', …' : ''})` : ''
  return {
    label: expr,
    kind: 'function',
    insertText: expr,
    detail: 'ARRAY<STRUCT> · use UNNEST',
    documentation: `\`${target}\` is \`ARRAY<STRUCT>\`${fieldsText}. Direct field access (\`${target}.field\`) is invalid in GoogleSQL — unnest it in \`FROM\` (\`FROM …, ${expr} AS item\`) or a subquery.`,
    sortText: `000:${expr.toLowerCase()}`,
    filterText: [expr, ...childFields.slice(0, 16)].join(' '),
    ...qualifierSpan ? { additionalDeleteSpan: qualifierSpan } : {}
  }
}

/** Where a BigQuery tab's unqualified names resolve: the connection's billing project and the tab's default dataset, if any. */
export interface GoogleSqlDefaults { readonly project: string; readonly dataset?: string }

export function googleSqlDialect(defaults: GoogleSqlDefaults): CompletionDialect {
  const { project, dataset } = defaults
  return {
    objectPath(parts) {
      if (parts.length === 3) return parts
      if (parts.length === 2) return [project, ...parts]
      if (parts.length === 1 && dataset) return [project, dataset, parts[0]]
      return undefined
    },
    containers(qualifier): ContainerQuery[] {
      // Nothing written yet: the default dataset's objects, the billing project's datasets, then the projects.
      if (!qualifier.length) return [...dataset ? [{ path: [project, dataset] }] : [], { path: [project] }, { path: [] }]
      // One part: a project's datasets, or a dataset of the billing project's objects.
      if (qualifier.length === 1) return [{ path: [project, qualifier[0]] }, { path: [qualifier[0]] }]
      if (qualifier.length === 2) return [{ path: [qualifier[0], qualifier[1]] }]
      return []
    },
    quote: quoteGoogleSqlName,
    itemKind: item => item.kind === 'bqColumn' && item.subtype === 'struct' ? 'field' : kinds[item.kind] ?? 'table',
    itemKey: (kind, label) => caseSensitiveKinds.has(kind) ? `${kind}:${label}` : `${kind}:${label.toLowerCase()}`,
    itemDetail(item: LanguageLookupItem) {
      const label = (item.subtype && subtypeLabels[item.subtype]) || labels[item.kind] || item.kind
      if (item.kind === 'bqProject') return item.detail === 'names' ? 'Project · names only' : 'Project'
      if (item.shards && item.shards.prefix.length > 0 && item.shards.count > 0) return `Latest shard · ${shardSummary(item.shards)}`
      if (item.shards) return `${label} · ${item.shards.count.toLocaleString('en-US')} shards, ${item.shards.first} to ${item.shards.last}`
      if (item.kind === 'bqRoutine' && item.detail) return `${label} ${item.detail}`
      return label
    },
    objectVariants(item: LanguageLookupItem): readonly ObjectVariant[] {
      if (!item.shards || !item.shards.prefix.length || item.shards.count <= 0) return []
      const wildcard = `${item.shards.prefix}*`
      return [{
        label: wildcard,
        insertName: wildcard,
        detail: `Wildcard · ${shardSummary(item.shards)}`,
        documentation: `Matches ${shardSummary(item.shards)}. Filter with \`_TABLE_SUFFIX\`.`,
        filterText: wildcard,
        before: true
      }]
    },
    pseudoColumns: googleSqlPseudoColumns,
    isArrayType: isGoogleSqlArrayType,
    arrayMemberHint: googleSqlArrayMemberHint,
    objectLabel: (kind, subtype) => (subtype && subtypeLabels[subtype]) || labels[kind] || kind,
    pathText: path => '`' + path.join('.') + '`',
    keywords,
    keywordsFor(site) {
      switch (site.kind) {
        case 'afterFromTable': return afterFromKeywords(site.hasAlias, site.inJoin, site.mergeUsing)
        case 'statementStart': return statementStartKeywords
        case 'castType': return castTypes
        case 'datePart': return googleSqlDatePartsFor(site.functionName)
        default: return keywords
      }
    },
    siteItems: googleSqlSiteItems,
    functions,
    functionNamed: name => { const entry = googleSqlFunction(name); return entry ? byName.get(entry.name) : undefined },
    functionNamespaces: namespaces,
    anyFunctionPrefixes: ['SAFE']
  }
}
