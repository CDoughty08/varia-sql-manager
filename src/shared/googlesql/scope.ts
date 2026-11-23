// GoogleSQL's light scope reader for completion and hover (docs/language-services.md, Completion from the index). It reads
// the statement around the caret from the scanner's tokens, not a full parse: query blocks by parentheses, set operations
// by UNION, INTERSECT and EXCEPT, each block's FROM items (tables with their aliases, subqueries, UNNEST, joins), its select
// list's column names, WITH queries, and the targets of UPDATE, DELETE, MERGE and INSERT. Text it does not understand gives
// fewer names, never an error. The model it fills is src/shared/completion/model.ts, which every engine shares.
import type { CompletionRead, CompletionSite, CompletionWord, CteScope, HoverRead, QueryScope, QueryShape, ScopeSource } from '../completion/model'
import { googleSqlReservedKeywords } from './catalog'
import { googleSqlCallContext, scanGoogleSql, type GoogleSqlToken } from './lexer'

interface Tok extends GoogleSqlToken { readonly text: string; readonly upper: string }

const reserved: ReadonlySet<string> = new Set(googleSqlReservedKeywords)
/** Words after which a name is a table: FROM and JOIN, and the targets of DML and TABLE statements. */
const objectWords = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'MERGE'])
const joinWords = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER'])
const setWords = new Set(['UNION', 'INTERSECT', 'EXCEPT'])
/** Words that end a FROM clause at its block's level. */
const fromEnd = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'SET', 'SELECT', 'WHEN', 'OPTIONS', 'PIVOT', 'UNPIVOT', ...setWords])
/** Words that start a clause: the nearest one before a position says where it is. */
const clauseWords = new Set([...objectWords, ...fromEnd, 'ON', 'USING', 'VALUES', 'THEN', 'WITH', 'BY', 'AND', 'OR', 'NOT', 'CASE', 'ELSE'])
const castCalls = new Set(['CAST', 'SAFE_CAST'])
/** Tokens an expression can end with before an implicit alias (`'x' label`); a parenthesis (`COUNT(*) n`) shows at its block's level as its '('. */
const valueEnds: ReadonlySet<string> = new Set(['word', 'quotedIdentifier', 'string', 'number', 'parameter', 'systemVariable'])

/** A name token's parts: a word, or a quoted identifier's dotted path (`my-proj.sales.orders`), unescaped. */
function partsOf(token: Tok): string[] {
  if (token.kind === 'word') return [token.text]
  const body = token.text.slice(1, token.open ? undefined : -1)
  return body.split('.').map(part => part.replace(/\\(.)/g, '$1'))
}
const isName = (token: Tok | undefined): token is Tok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier')
const isWord = (token: Tok | undefined, ...words: string[]) => !!token && token.kind === 'word' && words.includes(token.upper)
const isPunct = (token: Tok | undefined, value: string) => !!token && token.kind === 'punctuation' && token.text === value
/** A word an alias can be: an unreserved word, or a quoted identifier. */
const isAlias = (token: Tok | undefined) => !!token && (token.kind === 'quotedIdentifier' || (token.kind === 'word' && !reserved.has(token.upper)))

/** The statement around `offset`: its significant tokens (no whitespace or comments), with each parenthesis's match and parent. */
class Statement {
  readonly toks: Tok[]
  /** For a '(' its ')' (or toks.length when unclosed); -1 for any other token. */
  readonly match: number[]
  /** The innermost '(' around each token, or -1. */
  readonly parent: number[]
  /** The token the caret is inside (a string, comment or quoted identifier), if any. */
  readonly inside?: Tok

  constructor(readonly text: string, readonly offset: number) {
    const all = scanGoogleSql(text).map(token => ({ ...token, text: text.slice(token.start, token.end), upper: token.kind === 'word' ? text.slice(token.start, token.end).toUpperCase() : '' }))
    let start = 0, end = text.length
    for (const token of all) {
      if (token.kind !== 'punctuation' || token.text !== ';') continue
      if (token.end <= offset) start = token.end
      else if (token.start >= offset) { end = token.start; break }
    }
    this.inside = all.find(token => (token.kind === 'comment' || token.kind === 'string' || token.kind === 'quotedIdentifier')
      && token.start < offset && (offset < token.end || (offset === token.end && !!token.open)))
    this.toks = all.filter(token => token.kind !== 'whitespace' && token.kind !== 'comment' && token.start >= start && token.end <= end)
    this.match = this.toks.map(() => -1)
    this.parent = this.toks.map(() => -1)
    const stack: number[] = []
    this.toks.forEach((token, index) => {
      this.parent[index] = stack.at(-1) ?? -1
      if (isPunct(token, '(')) { stack.push(index); this.match[index] = this.toks.length }
      else if (isPunct(token, ')') && stack.length) this.match[stack.pop()!] = index
    })
  }

  /** The innermost '(' around a text position, or -1. */
  parentAt(offset: number): number {
    let found = -1
    this.toks.forEach((token, index) => {
      if (isPunct(token, '(') && token.end <= offset && (this.match[index] >= this.toks.length || this.toks[this.match[index]].start >= offset)) found = index
    })
    return found
  }

  /** A block's top-level token indexes: the statement's (open -1) or a parenthesis's. */
  top(open: number): number[] {
    const end = open < 0 ? this.toks.length : this.match[open], out: number[] = []
    for (let index = open + 1; index < end; index++) if (this.parent[index] === open) out.push(index)
    return out
  }

  /** Whether a block is a query: it starts with SELECT or WITH (or, for the statement, holds one at its top). */
  isQuery(open: number): boolean {
    const first = this.toks[open + 1]
    return open < 0 || isWord(first, 'SELECT', 'WITH')
  }

  /** The parentheses around `index`, innermost first. */
  ancestors(open: number): number[] {
    const out: number[] = []
    for (let at = open; at >= 0; at = this.parent[at]) out.push(at)
    return out
  }
}

/** A run of tokens with the index of each in the statement. */
type Run = readonly number[]

/** The segments of a block split at its top-level set operations (an EXCEPT after `*` belongs to the select list). */
function segments(statement: Statement, open: number): Run[] {
  const { toks } = statement, out: number[][] = [[]]
  for (const index of statement.top(open)) {
    const token = toks[index], before = toks[index - 1]
    if (token.kind === 'word' && setWords.has(token.upper) && !(token.upper === 'EXCEPT' && isPunct(before, '*'))) { out.push([]); continue }
    out.at(-1)!.push(index)
  }
  return out
}

/** Reads one block: its WITH queries, and per segment its sources and select list's shape. */
class BlockReader {
  constructor(private readonly statement: Statement, private readonly ctes: CteScope[]) {}

  private get toks() { return this.statement.toks }

  /** The block's segments after its WITH queries (whose shapes are added to the scope's). */
  body(open: number): Run[] {
    const all = segments(this.statement, open)
    const first = all[0]
    if (!first.length || !isWord(this.toks[first[0]], 'WITH')) return all
    let at = 1
    if (isWord(this.toks[first[at]], 'RECURSIVE')) at++
    while (at < first.length) {
      const name = this.toks[first[at]], as = this.toks[first[at + 1]], paren = first[at + 2]
      if (!isName(name) || !isWord(as, 'AS') || !isPunct(this.toks[paren], '(')) break
      this.ctes.push({ name: partsOf(name).join('.'), shape: this.shape(paren) })
      at += 3
      if (!isPunct(this.toks[first[at]], ',')) break
      at++
    }
    return [first.slice(at), ...all.slice(1)]
  }

  /** The columns a parenthesized query gives: its first segment's select list. */
  shape(open: number): QueryShape {
    const [first] = this.body(open)
    return first ? this.selectShape(first) : { columns: [], stars: [] }
  }

  /** A segment's sources: the targets of DML, then its FROM (or MERGE's USING) items. */
  sources(run: Run): ScopeSource[] {
    const { toks } = this
    const out: ScopeSource[] = []
    const lead = toks[run[0]]
    if (isWord(lead, 'UPDATE', 'DELETE', 'MERGE', 'INSERT')) {
      let at = 1
      if (isWord(toks[run[at]], 'FROM', 'INTO')) at++
      const target = this.item(run, at, true)
      if (target.source) out.push(target.source)
    }
    for (let at = 0; at < run.length; at++) {
      const token = toks[run[at]]
      const using = isWord(token, 'USING') && isWord(lead, 'MERGE')
      if (!isWord(token, 'FROM') && !using) continue
      if (isWord(lead, 'DELETE') && at <= 1) continue
      for (let next = at + 1; next < run.length;) {
        const word = toks[run[next]]
        if (word.kind === 'word' && fromEnd.has(word.upper)) break
        if (isPunct(word, ',') || (word.kind === 'word' && joinWords.has(word.upper))) { next++; continue }
        const read = this.item(run, next)
        if (read.source) out.push(read.source)
        next = this.skipCondition(run, Math.max(read.next, next + 1))
        if (using) break
      }
    }
    return out
  }

  /** Skips a join's ON or USING condition (and anything else it does not read) to the next item. */
  private skipCondition(run: Run, at: number): number {
    const { toks } = this
    while (at < run.length) {
      const token = toks[run[at]]
      if (isPunct(token, ',') || (token.kind === 'word' && (joinWords.has(token.upper) || fromEnd.has(token.upper)))) return at
      at++
    }
    return at
  }

  /** One FROM item at `at`: a table name, a subquery or UNNEST, with its alias. A DML `target` may be followed by a column list. */
  item(run: Run, at: number, target = false): { source?: ScopeSource; next: number } {
    const { toks } = this
    const token = toks[run[at]]
    let source: ScopeSource | undefined
    if (isPunct(token, '(')) {
      source = this.statement.isQuery(run[at]) ? { kind: 'derived', shape: this.shape(run[at]) } : undefined
      at++
    } else if (isWord(token, 'UNNEST') && isPunct(toks[run[at + 1]], '(')) {
      const inner = this.statement.top(run[at + 1]).map(index => toks[index])
      const path = chainOf(inner)
      source = path ? { kind: 'unnest', path } : undefined
      at += 2
    } else if (isName(token)) {
      const parts = [...partsOf(token)]
      at++
      while (isPunct(toks[run[at]], '.') && isName(toks[run[at + 1]])) { parts.push(...partsOf(toks[run[at + 1]])); at += 2 }
      // A table-valued function's columns are not indexed.
      if (isPunct(toks[run[at]], '(') && !target) return { next: at + 1 }
      source = { kind: 'object', name: parts.at(-1)!, parts, span: { start: token.start, end: toks[run[at - 1]].end } }
    } else return { next: at + 1 }
    // FOR SYSTEM_TIME AS OF … holds an AS that names nothing.
    if (isWord(toks[run[at]], 'FOR') && isWord(toks[run[at + 1]], 'SYSTEM_TIME')) at = Math.min(run.length, at + 5)
    let alias: string | undefined
    if (isWord(toks[run[at]], 'AS') && isAlias(toks[run[at + 1]])) { alias = partsOf(toks[run[at + 1]]).join('.'); at += 2 }
    else if (isAlias(toks[run[at]]) && !isWord(toks[run[at]], 'PIVOT', 'UNPIVOT', 'OPTIONS', 'FOR')) { alias = partsOf(toks[run[at]]).join('.'); at++ }
    if (source && alias !== undefined) source = { ...source, name: alias }
    return { source, next: at }
  }

  /** A segment's select list: named columns (aliases, a column reference's last part) and `*` or `alias.*`. */
  selectShape(run: Run): QueryShape {
    const { toks } = this
    const select = run.findIndex(index => isWord(toks[index], 'SELECT'))
    if (select < 0) return { columns: [], stars: [] }
    const sources = this.sources(run)
    let at = select + 1
    if (isWord(toks[run[at]], 'AS') && isWord(toks[run[at + 1]], 'STRUCT', 'VALUE')) at += 2
    if (isWord(toks[run[at]], 'DISTINCT', 'ALL')) at++
    const columns: string[] = [], stars: ScopeSource[] = []
    let item: Tok[] = []
    const finish = () => {
      if (!item.length) return
      const last = item.at(-1)!, before = item.at(-2)
      const starAt = item.findIndex(token => isPunct(token, '*'))
      if (starAt === 0) stars.push(...sources)
      else if (starAt > 1 && isPunct(item[starAt - 1], '.')) {
        const chain = chainOf(item.slice(0, starAt - 1))
        const named = chain?.length === 1 ? sources.find(source => source.name?.toLowerCase() === chain[0].toLowerCase()) : undefined
        if (named) stars.push(named)
      } else if (isWord(before, 'AS') && isName(last)) columns.push(partsOf(last).join('.'))
      else {
        const chain = chainOf(item)
        if (chain) columns.push(chain.at(-1)!)
        else if (isAlias(last) && before && (valueEnds.has(before.kind) || isPunct(before, '('))) columns.push(partsOf(last).join('.'))
      }
      item = []
    }
    for (; at < run.length; at++) {
      const token = toks[run[at]]
      if (isWord(token, 'FROM', 'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT')) break
      if (isPunct(token, ',')) { finish(); continue }
      item.push(token)
    }
    finish()
    return { columns, stars }
  }
}

/** A run that is only a name chain (`a.b.c`, `` `p.d`.t ``) as its parts, else undefined. */
function chainOf(tokens: readonly Tok[]): string[] | undefined {
  if (!tokens.length || tokens.length % 2 === 0) return
  const parts: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (index % 2 === 0 ? !isName(token) : !isPunct(token, '.')) return
    if (index % 2 === 0) parts.push(...partsOf(token))
  }
  return parts
}

/** The scope a position sees: the sources of its query block's segment, then of each enclosing query block's segment that holds
 *  it (a WITH query's body sees no other query's sources), and the WITH queries of those blocks. */
function scopeAt(statement: Statement, open: number, offset: number): QueryScope {
  const ctes: CteScope[] = []
  const reader = new BlockReader(statement, ctes)
  const blocks = statement.ancestors(open).filter(block => statement.isQuery(block))
  if (!blocks.includes(-1)) blocks.push(-1)
  const bodies = new Map<number, Run[]>()
  // Outer blocks first, so their WITH queries are known when an inner block's names are read.
  for (const block of [...blocks].reverse()) bodies.set(block, reader.body(block))
  const sources: ScopeSource[] = []
  const end = (run: Run) => run.length ? statement.toks[run.at(-1)!].end : -1
  blocks.forEach((block, depth) => {
    const body = bodies.get(block)!
    const run = depth === 0 ? body.find(segment => segment.length && end(segment) >= offset) ?? body.at(-1) : body.find(segment => segment.includes(blocks[depth - 1]))
    if (run) sources.push(...reader.sources(run).map(source => resolveCte(source, ctes)))
  })
  return { sources, ctes }
}

/** A one-part name that is a WITH query refers to it. */
function resolveCte(source: ScopeSource, ctes: readonly CteScope[]): ScopeSource {
  if (source.kind !== 'object' || source.parts.length !== 1) return source
  const cte = ctes.find(entry => entry.name.toLowerCase() === source.parts[0].toLowerCase())
  return cte ? { kind: 'cte', name: source.name, cte: cte.name, span: source.span } : source
}

/** The nearest clause word before token `index` in its block, skipping nested parentheses. */
function clauseBefore(statement: Statement, index: number, open: number): Tok | undefined {
  const { toks } = statement
  for (let at = index - 1; at > open; at--) {
    if (statement.parent[at] !== open) continue
    const token = toks[at]
    if (token.kind === 'word' && clauseWords.has(token.upper)) return token
  }
}

/** Where a name that starts at token `first` (or the caret, when `first` is the next token) sits: a table name, an alias, or an expression. */
function placeOf(statement: Statement, first: number, open: number): 'object' | 'alias' | 'keyword' | 'expression' | 'start' {
  const { toks } = statement
  let before = first - 1
  while (before > open && statement.parent[before] !== open) before--
  const previous = before > open ? toks[before] : undefined
  if (!previous) return open < 0 || statement.isQuery(open) ? 'start' : 'expression'
  if (isWord(previous, 'AS')) return 'alias'
  if (previous.kind === 'word' && objectWords.has(previous.upper)) return 'object'
  if (isWord(previous, 'USING') && isWord(toks[open + 1] ?? toks[0], 'MERGE')) return 'object'
  const clause = clauseBefore(statement, first, open)
  const inFrom = !!clause && (clause.upper === 'FROM' || clause.upper === 'JOIN' || (clause.upper === 'USING' && isWord(toks[0], 'MERGE')))
  if (isPunct(previous, ',') && inFrom) return 'object'
  // After a table, its alias or a subquery in FROM: an alias or the next clause's keyword.
  if (inFrom && (isName(previous) || isPunct(previous, ')'))) return 'keyword'
  return 'expression'
}

/** The name chain that ends just before token or position `end`: the parts written before the one typed, and its first token. */
function chainBefore(statement: Statement, end: number): { parts: string[]; first: number } | undefined {
  const { toks } = statement
  const parts: string[] = []
  let at = end - 1
  if (!isPunct(toks[at], '.')) return { parts, first: end }
  while (isPunct(toks[at], '.')) {
    const name = toks[at - 1]
    if (!isName(name) || name.open) return undefined
    parts.unshift(...partsOf(name))
    at -= 2
  }
  return { parts, first: at + 1 }
}

/** What completion finds at `offset` in `text`. */
export function readGoogleSqlCompletion(text: string, offset: number): CompletionRead {
  const statement = new Statement(text, offset)
  const { toks, inside } = statement
  const none = (word: CompletionWord): CompletionRead => ({ site: { kind: 'none' }, scope: { sources: [], ctes: [] }, word })
  const empty: CompletionWord = { start: offset, end: offset, typed: '', quoted: false }
  if (inside && inside.kind !== 'quotedIdentifier') return none(empty)
  // The token the caret is in or at the end of, and the word it types.
  let word = empty, next = toks.findIndex(token => token.start >= offset), qualifier: string[] = []
  if (next < 0) next = toks.length
  const current = toks.findIndex(token => token.start < offset && offset <= token.end)
  if (current >= 0) {
    const token = toks[current]
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'parameter' || token.kind === 'systemVariable') return none(empty)
    if (token.kind === 'word') { word = { start: token.start, end: token.end, typed: text.slice(token.start, offset), quoted: false }; next = current }
    else if (token.kind === 'quotedIdentifier' && (offset < token.end || token.open)) {
      // Inside backticks: the dotted path before the caret qualifies the part being typed.
      const bodyEnd = token.open ? token.end : token.end - 1
      const before = text.slice(token.start + 1, offset)
      const dot = before.lastIndexOf('.')
      const start = token.start + 1 + dot + 1
      const after = text.slice(offset, bodyEnd).indexOf('.')
      qualifier = dot < 0 ? [] : before.slice(0, dot).split('.').map(part => part.replace(/\\(.)/g, '$1'))
      word = { start, end: after < 0 ? bodyEnd : offset + after, typed: text.slice(start, offset), quoted: true }
      next = current
    }
  }
  const chain = chainBefore(statement, next)
  if (!chain) return none(word)
  const parts = [...chain.parts, ...qualifier]
  const open = statement.parentAt(word.start)
  const scope = scopeAt(statement, open, offset)
  const place = placeOf(statement, chain.first, open)
  let site: CompletionSite
  if (place === 'object') site = { kind: 'object', qualifier: parts }
  else if (place === 'alias') site = castCalls.has(googleSqlCallContext(text, offset)?.name.toUpperCase() ?? '') ? { kind: 'keyword' } : { kind: 'none' }
  else if (parts.length) site = { kind: 'member', qualifier: parts }
  else if (place === 'keyword' || place === 'start') site = { kind: 'keyword' }
  else site = { kind: 'expression' }
  return { site, scope, word }
}

/** The name chain at `offset` for hover: every part, the one under the caret, and whether it names a table. */
export function readGoogleSqlHover(text: string, offset: number): HoverRead | undefined {
  const statement = new Statement(text, offset)
  const { toks } = statement
  if (statement.inside && statement.inside.kind !== 'quotedIdentifier') return
  const at = toks.findIndex(token => isName(token) && token.start <= offset && offset < token.end)
  if (at < 0) return
  let first = at, last = at
  while (isPunct(toks[first - 1], '.') && isName(toks[first - 2])) first -= 2
  while (isPunct(toks[last + 1], '.') && isName(toks[last + 2])) last += 2
  const parts: string[] = []
  let index = 0
  for (let token = first; token <= last; token += 2) {
    const own = partsOf(toks[token])
    if (token === at) {
      if (toks[token].kind === 'quotedIdentifier') {
        // The part of a dotted quoted path the caret is on.
        const inner = text.slice(toks[token].start + 1, offset)
        index = parts.length + Math.min(own.length - 1, inner.split('.').length - 1)
      } else index = parts.length
    }
    parts.push(...own)
  }
  const open = statement.parentAt(toks[first].start)
  const place = placeOf(statement, first, open)
  // A name followed by '(' is a call: a function, not a column.
  if (isPunct(toks[last + 1], '(') && index === parts.length - 1 && place !== 'object') {
    return { parts, at: index, span: { start: toks[first].start, end: toks[last].end }, object: false, scope: { sources: [], ctes: [] } }
  }
  return { parts, at: index, span: { start: toks[first].start, end: toks[last].end }, object: place === 'object', scope: scopeAt(statement, open, offset) }
}
