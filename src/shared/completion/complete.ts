// Completion items from a grammar's reading of the caret and the index's answers (docs/language-services.md, Completion from the
// index). Object sites list the containers the dialect names; expressions list the scope's columns, its aliases, functions and
// keywords; a dotted name lists an alias's columns or a STRUCT's fields. Nothing here knows an engine.
import { languageLookupLimits, type LanguageLookupPath } from '../language-lookup'
import type { CompletionDialect, CompletionItem, CompletionKind, CompletionList, CompletionRead, DialectFunction, IndexLookup } from './model'
import { ScopeResolver, childrenOf, sameName, sourceNamed, type ScopeColumn } from './resolve'

/** Groups order the list ahead of the editor's fuzzy score among equals: what the scope gives first, the dialect's words last. */
const group: Readonly<Record<CompletionKind, string>> = { column: '1', field: '1', alias: '2', cte: '2', table: '3', view: '3', routine: '4', model: '4', container: '5', function: '6', keyword: '7' }
const sortText = (kind: CompletionKind, rank: number, label: string) => `${group[kind]}${String(rank).padStart(2, '0')}:${label.toLowerCase()}`

/** Completion at a position the grammar read, from the index through `lookup`. */
export async function completeFromIndex(read: CompletionRead, dialect: CompletionDialect, lookup: IndexLookup): Promise<CompletionList> {
  const { site, scope, word } = read
  const insert = (name: string) => word.quoted ? name : dialect.quote(name)
  const items = new Map<string, CompletionItem>()
  const add = (item: CompletionItem) => { const id = `${item.kind}:${item.label.toLowerCase()}`; if (!items.has(id)) items.set(id, item) }
  let incomplete = false
  switch (site.kind) {
    case 'none': return { items: [], incomplete: false }
    case 'keyword':
      for (const keyword of dialect.keywords) add(keywordItem(keyword))
      break
    case 'object': {
      if (!site.qualifier.length) for (const cte of scope.ctes) add({ label: cte.name, kind: 'cte', insertText: insert(cte.name), detail: 'WITH query', sortText: sortText('cte', 0, cte.name) })
      const containers = dialect.containers(site.qualifier).slice(0, languageLookupLimits.requests)
      if (!containers.length) break
      const requests: LanguageLookupPath[] = containers.map(container => ({ path: [...container.path], ...word.typed ? { prefix: word.typed } : {}, limit: languageLookupLimits.defaultItems }))
      const answers = await lookup(requests)
      // No answer (the index busy or unreachable): the editor asks again as the word grows.
      if (!answers) incomplete = true
      answers?.forEach((answer, rank) => {
        incomplete ||= answer.truncated
        for (const entry of answer.items) {
          const kind = dialect.itemKind(entry)
          add({ label: entry.name, kind, insertText: insert(entry.name), detail: dialect.itemDetail(entry), sortText: sortText(kind, rank, entry.name), filterText: entry.name })
        }
      })
      break
    }
    case 'member': {
      const resolver = new ScopeResolver(scope, dialect, lookup)
      await resolver.load()
      incomplete ||= resolver.failed
      const field = await resolver.field(site.qualifier)
      if (field) {
        incomplete ||= field.columns.truncated
        for (const column of childrenOf(field.columns.columns, field.path)) add(columnItem(column, field.path.length, insert))
      } else if (site.qualifier.length === 1) {
        // A function namespace (NET.) lists its members; SAFE. takes any function.
        const namespace = dialect.functionNamespaces.find(name => sameName(name, site.qualifier[0]))
        if (namespace) {
          for (const entry of dialect.functions) if (entry.name.toUpperCase().startsWith(namespace.toUpperCase() + '.')) add(functionItem(entry, entry.name.slice(namespace.length + 1)))
        } else if (dialect.anyFunctionPrefixes.some(name => sameName(name, site.qualifier[0]))) {
          for (const entry of dialect.functions) if (!entry.name.includes('.')) add(functionItem(entry, entry.name))
        }
      }
      break
    }
    case 'expression': {
      const resolver = new ScopeResolver(scope, dialect, lookup)
      await resolver.load()
      incomplete ||= resolver.failed
      for (const [rank, source] of scope.sources.entries()) {
        const given = await resolver.columns(source)
        incomplete ||= given.truncated
        for (const column of childrenOf(given.columns, [])) add({ ...columnItem(column, 0, insert, source.name), sortText: sortText('column', Math.min(rank, 99), column.path) })
      }
      for (const source of scope.sources) if (source.name && sourceNamed(scope, source.name) === source) add({ label: source.name, kind: 'alias', insertText: insert(source.name), detail: aliasDetail(source), sortText: sortText('alias', 0, source.name) })
      for (const entry of dialect.functions) if (!entry.name.includes('.')) add(functionItem(entry, entry.name))
      for (const keyword of dialect.keywords) add(keywordItem(keyword))
      break
    }
  }
  return { items: [...items.values()], incomplete }
}

function aliasDetail(source: { kind: string }): string {
  return source.kind === 'cte' ? 'WITH query' : source.kind === 'derived' ? 'Subquery' : source.kind === 'unnest' ? 'UNNEST' : 'Table'
}

function columnItem(column: ScopeColumn, depth: number, insert: (name: string) => string, source?: string): CompletionItem {
  const name = column.path.split('.').slice(depth).join('.')
  const kind: CompletionKind = depth > 0 || column.path.includes('.') ? 'field' : 'column'
  const detail = [column.type, column.nullable === false ? 'REQUIRED' : undefined, source].filter(Boolean).join(' · ') || undefined
  return { label: name, kind, insertText: insert(name), detail, documentation: column.description, sortText: sortText(kind, 0, name), filterText: name }
}

function functionItem(entry: DialectFunction, label: string): CompletionItem {
  return { label, kind: 'function', insertText: label, detail: entry.signatures[0], documentation: entry.summary, sortText: sortText('function', 0, label) }
}

function keywordItem(keyword: string): CompletionItem {
  return { label: keyword, kind: 'keyword', insertText: keyword, sortText: sortText('keyword', 0, keyword) }
}
