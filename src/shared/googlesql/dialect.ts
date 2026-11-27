// GoogleSQL's side of the completion pipeline (src/shared/completion/model.ts): how BigQuery names are written and quoted, how a
// written table name becomes an index path (project, dataset, table, with the connection's billing project and the tab's default
// dataset filled in), and the catalogue's keywords and functions.
import type { CompletionDialect, CompletionKind, ContainerQuery, DialectFunction } from '../completion/model'
import type { LanguageLookupItem } from '../language-lookup'
import { googleSqlFunction, googleSqlFunctions, googleSqlKeywords, googleSqlReservedKeywords, googleSqlTypes, signatureLabel } from './catalog'

const reserved: ReadonlySet<string> = new Set(googleSqlReservedKeywords)
const plain = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A name as GoogleSQL takes it: bare when it is a plain word that is not reserved, else in backticks with `\` and `` ` `` escaped. */
export function quoteGoogleSqlName(name: string): string {
  return plain.test(name) && !reserved.has(name.toUpperCase()) ? name : '`' + name.replace(/[\\`]/g, '\\$&') + '`'
}

const keywords = [...new Set([...googleSqlReservedKeywords, ...googleSqlKeywords, ...googleSqlTypes])].sort()
const functions: readonly DialectFunction[] = googleSqlFunctions.map(entry => ({
  name: entry.name, summary: entry.summary, signatures: entry.signatures.map(signature => signatureLabel(entry.name, signature).label)
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
      if (item.shards) return `${label} · ${item.shards.count.toLocaleString('en-US')} shards, ${item.shards.first} to ${item.shards.last}`
      if (item.kind === 'bqRoutine' && item.detail) return `${label} ${item.detail}`
      return label
    },
    objectLabel: (kind, subtype) => (subtype && subtypeLabels[subtype]) || labels[kind] || kind,
    pathText: path => '`' + path.join('.') + '`',
    keywords,
    functions,
    functionNamed: name => { const entry = googleSqlFunction(name); return entry ? byName.get(entry.name) : undefined },
    functionNamespaces: namespaces,
    anyFunctionPrefixes: ['SAFE']
  }
}
