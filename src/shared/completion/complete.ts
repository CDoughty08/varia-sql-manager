// Completion items from a grammar's reading of the caret and the index's answers (docs/language-services.md, Completion from the
// index). Object sites list the containers the dialect names; expressions list the scope's columns, its aliases, functions and
// keywords; a dotted name lists an alias's columns or a STRUCT's fields. Nothing here knows an engine.
import { languageLookupLimits, type LanguageLookupPath } from '../language-lookup'
import type { CompletionDialect, CompletionItem, CompletionKind, CompletionList, CompletionRead, DialectFunction, IndexLookup, ScopeSource } from './model'
import { ScopeResolver, boundedLookup, childrenOf, columnAt, narrowing, resolverLimits, sameName, type NarrowPrefix, type ScopeColumn, type SourceColumns } from './resolve'

/** Groups order the list ahead of the editor's fuzzy score among equals: what the scope gives first, the dialect's words last. */
const group: Readonly<Record<CompletionKind, string>> = { column: '1', field: '1', alias: '2', cte: '2', table: '3', view: '3', routine: '4', model: '4', container: '5', function: '6', keyword: '7' }
const sortText = (kind: CompletionKind, rank: number, label: string) => `${group[kind]}${String(rank).padStart(2, '0')}:${label.toLowerCase()}`
const escapeSnippet = (value: string) => value.replace(/[\\$}]/g, '\\$&')
const maxAmbiguousSources = 32
const maxExpressionColumns = 4000

/** Completion at a position the grammar read, from the index through `lookup`. */
export async function completeFromIndex(read: CompletionRead, dialect: CompletionDialect, lookup: IndexLookup): Promise<CompletionList> {
  const { site, scope, word } = read
  const typed = word.quoted ? word.typed.replace(/\\(.)/g, '$1') : word.typed
  const insert = (name: string) => word.quoted ? name.replace(/[\\`]/g, '\\$&') : dialect.quote(name)
  const items = new Map<string, CompletionItem>()
  const add = (item: CompletionItem) => { const id = dialect.itemKey ? dialect.itemKey(item.kind, item.label) : `${item.kind}:${item.label.toLowerCase()}`; if (!items.has(id)) items.set(id, item) }
  let incomplete = false
  switch (site.kind) {
    case 'none': return { items: [], incomplete: false }
    case 'afterFromTable':
    case 'statementStart':
    case 'castType':
    case 'datePart':
    case 'systemVar':
    case 'infoSchema': {
      const custom = dialect.siteItems?.(site, word, insert)
      if (custom) {
        for (const item of custom) add(item)
      } else if (site.kind !== 'systemVar' && site.kind !== 'infoSchema') {
        for (const keyword of dialect.keywordsFor?.(site) ?? dialect.keywords) add(keywordItem(keyword))
      }
      break
    }
    case 'object': {
      if (!site.qualifier.length) for (const cte of scope.ctes) add({ label: cte.name, kind: 'cte', insertText: insert(cte.name), detail: 'WITH query', sortText: sortText('cte', 0, cte.name) })
      const containers = dialect.containers(site.qualifier).slice(0, languageLookupLimits.requests)
      if (!containers.length) break
      const requests: LanguageLookupPath[] = containers.map(container => ({ path: [...container.path], ...typed ? { prefix: typed } : {}, limit: languageLookupLimits.defaultItems }))
      const answers = await boundedLookup(lookup)(requests)
      // No answer (the index busy or unreachable): the editor asks again as the word grows.
      if (!answers) incomplete = true
      const typedLower = typed.toLowerCase()
      answers?.forEach((answer, rank) => {
        incomplete ||= answer.truncated
        for (const entry of answer.items) {
          const kind = dialect.itemKind(entry)
          const variants = dialect.objectVariants?.(entry) ?? []
          const addVariant = (variant: typeof variants[number]) => {
            const matchTarget = (variant.filterText ?? variant.label).toLowerCase()
            if (typedLower && !matchTarget.startsWith(typedLower)) return
            const vKind = variant.kind ?? kind
            add({
              label: variant.label,
              kind: vKind,
              insertText: insert(variant.insertName ?? variant.label),
              detail: variant.detail,
              documentation: variant.documentation,
              sortText: sortText(vKind, rank, variant.label),
              filterText: variant.filterText ?? variant.label
            })
          }
          for (const variant of variants) if (variant.before) addVariant(variant)
          const rawInsert = insert(entry.name)
          const callSnippet = kind === 'routine' && !word.quoted && !word.parenAhead
          add({
            label: entry.name,
            kind,
            insertText: callSnippet ? `${escapeSnippet(rawInsert)}($0)` : rawInsert,
            ...callSnippet ? { insertTextIsSnippet: true, triggerParameterHints: true } : {},
            detail: dialect.itemDetail(entry),
            sortText: sortText(kind, rank, entry.name),
            filterText: entry.name
          })
          for (const variant of variants) if (!variant.before) addVariant(variant)
        }
      })
      break
    }
    case 'member': {
      let resolver = new ScopeResolver(scope, dialect, lookup)
      await resolver.load()
      let field = await resolver.field(site.qualifier)
      // A table wider than its share of the answer may hold the field past what came back, read directly, through `*` or an UNNEST
      // (or, written without an alias, the column itself): ask again for the names that start with what is written.
      const cutShort = resolver.cutShort()
      const namespace = site.qualifier.length === 1 && [...dialect.functionNamespaces, ...dialect.anyFunctionPrefixes].some(name => sameName(name, site.qualifier[0]))
      if (cutShort.size && (field ? field.columns.truncated : !namespace)) {
        const { prefix, object } = field ? await resolver.prefixThrough(field.source, field.path, typed) : { prefix: [...site.qualifier, typed].join('.'), object: undefined }
        if (prefix) {
          const prefixes: NarrowPrefix[] = [prefix]
          // Also fetch exact ancestor column entries (e.g. `z_items`) so wide-table narrowing still detects ARRAY<...> parents.
          const ancestorSeen = new Set<string>()
          const addAncestor = (name: string) => {
            if (!name || ancestorSeen.has(name.toLowerCase()) || prefixes.length >= resolverLimits.narrowPrefixes) return
            ancestorSeen.add(name.toLowerCase())
            prefixes.push({ prefix: name, exact: true })
          }
          if (field && field.path.length) {
            for (let k = 1; k <= field.path.length; k++) {
              const ancestor = await resolver.prefixThrough(field.source, field.path.slice(0, k), '')
              const base = ancestor.prefix.endsWith('.') ? ancestor.prefix.slice(0, -1) : ancestor.prefix
              addAncestor(base)
            }
          } else if (!field && site.qualifier.length) {
            for (let k = 1; k <= site.qualifier.length; k++) addAncestor(site.qualifier.slice(0, k).join('.'))
          }
          resolver = new ScopeResolver(scope, dialect, lookup, object && cutShort.has(object) ? new Map([[object, prefixes]]) : narrowing(cutShort, prefixes))
          await resolver.load()
          field = await resolver.field(site.qualifier) ?? field
        }
      }
      incomplete ||= resolver.failed || resolver.cut || resolver.overBudget || (!field && (resolver.missedCut || resolver.cutShort().size > 0))
      if (field) {
        incomplete ||= field.columns.truncated
        let arrayDepth = -1
        let arrayType: string | undefined
        for (let k = 1; k <= field.path.length; k++) {
          const col = columnAt(field.columns.columns, field.path.slice(0, k))
          if (col && dialect.isArrayType?.(col.type)) { arrayDepth = k; arrayType = col.type; break }
        }
        if (arrayDepth > 0) {
          // Never rewrite inside backticked identifiers (`o.items.`sk|`` or `` `o.items.|` ``), and never double-UNNEST inside `UNNEST(...)`.
          if (!read.preferArray && !word.quoted) {
            const arrayPath = field.path.slice(0, arrayDepth)
            const childFields = childrenOf(field.columns.columns, arrayPath).map(col => col.path.split('.').slice(arrayDepth).join('.'))
            const targetParts = site.qualifier.slice(0, Math.max(1, site.qualifier.length - field.path.length + arrayDepth))
            const qualifierSpan = read.qualifierStart !== undefined ? { start: read.qualifierStart, end: word.start } : undefined
            const hint = dialect.arrayMemberHint?.(targetParts, childFields, arrayType, qualifierSpan)
            if (hint) add(hint)
          }
        } else {
          for (const column of childrenOf(field.columns.columns, field.path)) {
            const item = columnItem(column, field.path.length, insert)
            if (read.preferArray && dialect.isArrayType?.(column.type)) {
              add({ ...item, sortText: `000:${item.label.toLowerCase()}` })
            } else {
              add(item)
            }
          }
        }
      } else if (site.qualifier.length === 1) {
        // A function namespace (NET.) lists its members; SAFE. takes any function.
        const namespace = dialect.functionNamespaces.find(name => sameName(name, site.qualifier[0]))
        if (namespace) {
          for (const entry of dialect.functions) if (entry.name.toUpperCase().startsWith(namespace.toUpperCase() + '.')) add(functionItem(entry, entry.name.slice(namespace.length + 1), word.parenAhead))
        } else if (dialect.anyFunctionPrefixes.some(name => sameName(name, site.qualifier[0]))) {
          for (const entry of dialect.functions) if (!entry.name.includes('.')) add(functionItem(entry, entry.name, word.parenAhead))
        }
      }
      break
    }
    case 'expression':
    case 'joinCondition':
    case 'unnestArg': {
      let resolver = new ScopeResolver(scope, dialect, lookup)
      await resolver.load()
      let given = await resolver.all(scope.sources)
      const cutShort = resolver.cutShort()
      if (typed && cutShort.size) {
        // The typed names, and an UNNEST's element fields that start with them (UNNEST(w.items) asks w's table for items.<typed>).
        const plan = new Map([...cutShort].map(path => [path, [typed]]))
        const unnests = scope.sources.filter(source => source.kind === 'unnest')
        // Past the cap an UNNEST's fields go unasked: the list is not final when one of those reads a table cut short (or a bare
        // name, which may lie in one).
        for (const source of unnests.slice(resolverLimits.narrowUnnests)) {
          if (source.kind !== 'unnest' || !source.path.length) continue
          const { object } = await resolver.prefixThrough(source, [], typed)
          if (!object || cutShort.has(object)) { incomplete = true; break }
        }
        for (const source of unnests.slice(0, resolverLimits.narrowUnnests)) {
          const { prefix, object } = await resolver.prefixThrough(source, [], typed)
          for (const [path, prefixes] of plan) if (prefix && (!object || object === path) && !prefixes.includes(prefix)) prefixes.push(prefix)
        }
        resolver = new ScopeResolver(scope, dialect, lookup, plan)
        await resolver.load()
        given = await resolver.all(scope.sources)
      }
      incomplete ||= resolver.failed || resolver.cut || resolver.overBudget
      const topByCols = new Map<SourceColumns, ScopeColumn[]>()
      const seenNames = new Set<string>()
      const seenUnnamedCols = new Set<SourceColumns>()
      const entries: { readonly rank: number; readonly source: ScopeSource; readonly cols: SourceColumns; readonly top: readonly ScopeColumn[]; readonly qualifiable: boolean }[] = []
      for (const [rank, source] of scope.sources.entries()) {
        const columns = given[rank]
        incomplete ||= columns.truncated
        const nameLower = source.name?.toLowerCase() ?? ''
        if (nameLower) {
          if (seenNames.has(nameLower)) continue
          seenNames.add(nameLower)
        } else {
          if (seenUnnamedCols.has(columns)) continue
          seenUnnamedCols.add(columns)
        }
        let top = topByCols.get(columns)
        if (!top) {
          const seenInCols = new Set<string>()
          top = []
          for (const col of childrenOf(columns.columns, [])) {
            const lower = col.path.toLowerCase()
            if (seenInCols.has(lower)) continue
            seenInCols.add(lower)
            top.push(col)
          }
          topByCols.set(columns, top)
        }
        if (!top.length) continue
        entries.push({ rank, source, cols: columns, top, qualifiable: !!source.name && !source.name.endsWith('*') })
      }
      const activeEntries = entries.slice(0, maxAmbiguousSources)
      if (entries.length > maxAmbiguousSources) incomplete = true
      const counts = new Map<string, number>()
      for (const entry of activeEntries) {
        for (const column of entry.top) {
          const lower = column.path.toLowerCase()
          counts.set(lower, (counts.get(lower) ?? 0) + 1)
        }
      }
      const preferArray = site.kind === 'unnestArg'
      let emittedColumns = 0
      for (const entry of activeEntries) {
        for (const column of entry.top) {
          if (emittedColumns >= maxExpressionColumns) { incomplete = true; break }
          const ambiguous = (counts.get(column.path.toLowerCase()) ?? 0) > 1
          const qualify = ambiguous && entry.qualifiable && !word.quoted
          const base = columnItem(column, 0, insert, entry.source.name, qualify ? entry.source.name : undefined, dialect, entry.cols.object?.name)
          const arrayBoost = preferArray && dialect.isArrayType?.(column.type)
          const prefix = arrayBoost ? '0' : group[base.kind]
          const rankStr = String(Math.min(entry.rank, 99)).padStart(2, '0')
          add({ ...base, sortText: `${prefix}${rankStr}:${base.label.toLowerCase()}` })
          emittedColumns++
        }
        if (emittedColumns >= maxExpressionColumns) break
      }
      // The nearest source of a name is the one it means (add keeps the first of a label).
      const seenAliases = new Set<string>()
      for (const source of scope.sources) {
        if (!source.name) continue
        const lower = source.name.toLowerCase()
        if (seenAliases.has(lower)) continue
        seenAliases.add(lower)
        add({ label: source.name, kind: 'alias', insertText: insert(source.name), detail: aliasDetail(source), sortText: sortText('alias', 0, source.name) })
      }
      for (const entry of dialect.functions) if (!entry.name.includes('.')) add(functionItem(entry, entry.name, word.parenAhead))
      for (const keyword of dialect.keywords) add(keywordItem(keyword))
      break
    }
  }
  return { items: [...items.values()], incomplete }
}

function aliasDetail(source: { kind: string }): string {
  return source.kind === 'cte' ? 'WITH query' : source.kind === 'derived' ? 'Subquery' : source.kind === 'unnest' ? 'UNNEST' : 'Table'
}

function columnItem(
  column: ScopeColumn,
  depth: number,
  insert: (name: string) => string,
  source?: string,
  qualifier?: string,
  dialect?: CompletionDialect,
  objectName?: string
): CompletionItem {
  const name = column.path.split('.').slice(depth).join('.')
  const kind: CompletionKind = depth > 0 || column.path.includes('.') ? 'field' : 'column'
  const pseudoLabel = column.pseudo ? 'Pseudo-column' : undefined
  if (qualifier && dialect) {
    const label = `${qualifier}.${name}`
    const owner = objectName && !sameName(objectName, qualifier) ? objectName : undefined
    const detail = [column.type, column.nullable === false ? 'REQUIRED' : undefined, pseudoLabel, owner].filter(Boolean).join(' · ') || undefined
    return {
      label,
      kind,
      insertText: `${dialect.quote(qualifier)}.${dialect.quote(name)}`,
      detail,
      documentation: column.description,
      sortText: sortText(kind, 0, label),
      filterText: name
    }
  }
  const detail = [column.type, column.nullable === false ? 'REQUIRED' : undefined, pseudoLabel, source].filter(Boolean).join(' · ') || undefined
  return { label: name, kind, insertText: insert(name), detail, documentation: column.description, sortText: sortText(kind, 0, name), filterText: name }
}

function functionItem(entry: DialectFunction, label: string, parenAhead?: boolean): CompletionItem {
  const snippet = !entry.niladic && !parenAhead
  return {
    label,
    kind: 'function',
    insertText: snippet ? `${escapeSnippet(label)}($0)` : label,
    ...snippet ? { insertTextIsSnippet: true, triggerParameterHints: true } : {},
    detail: entry.signatures[0],
    documentation: entry.summary,
    sortText: sortText('function', 0, label)
  }
}

function keywordItem(keyword: string): CompletionItem {
  return { label: keyword, kind: 'keyword', insertText: keyword, sortText: sortText('keyword', 0, keyword) }
}
