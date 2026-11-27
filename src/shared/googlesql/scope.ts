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
const castCalls = new Set(['CAST', 'SAFE_CAST'])
/** Tokens an expression can end with before an implicit alias (`'x' label`); a parenthesis (`COUNT(*) n`) shows at its block's level as its '('. */
const valueEnds: ReadonlySet<string> = new Set(['word', 'quotedIdentifier', 'string', 'number', 'parameter', 'systemVariable'])
/** Words after a FROM item that are not its alias. */
const notAliases = new Set(['PIVOT', 'UNPIVOT', 'OPTIONS', 'FOR', 'TABLESAMPLE', 'ON', 'USING', 'WITH'])
/** How deep the reader follows nested subqueries for their columns: past it a subquery gives none (keeps a keystroke cheap). */
export const readerLimits = { depth: 64 } as const

/** Date-part units accepted after `INTERVAL <expr>` inside `FOR SYSTEM_TIME AS OF` expressions. */
const intervalUnits = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'MILLISECOND', 'MICROSECOND'])
/** Clause/join keywords that end or follow a `FOR SYSTEM_TIME AS OF` expression rather than starting one. */
const timestampStopWords = new Set([...fromEnd, ...joinWords, 'FROM', 'ON', 'USING', 'AS', 'FOR', 'TABLESAMPLE'])
const unescapeQuoted = (part: string) => part.replace(/\\(.)/g, '$1')

/**
 * Returns the leading `domain:project` prefix inside a backticked identifier body (before any whitespace or `.` after `:`),
 * allowing an empty suffix right after `:` (`example.com:`) for completion at the project boundary.
 */
function domainProjectPrefix(body: string): string | undefined {
  const space = body.search(/\s/)
  const head = space < 0 ? body : body.slice(0, space)
  const colon = head.indexOf(':')
  if (colon <= 0) return undefined
  const domain = head.slice(0, colon)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return undefined
  const dot = head.indexOf('.', colon + 1)
  return dot < 0 ? head : head.slice(0, dot)
}

/** Splits a backticked identifier body on `.`, keeping a domain-scoped project (`example.com:my-proj`) as its first segment. */
function splitQuotedParts(body: string): string[] {
  const prefix = domainProjectPrefix(body)
  if (!prefix) return body.split('.').map(unescapeQuoted)
  const rest = body.slice(prefix.length)
  if (!rest) return [unescapeQuoted(prefix)]
  if (rest.startsWith('.')) return [unescapeQuoted(prefix), ...rest.slice(1).split('.').map(unescapeQuoted)]
  return body.split('.').map(unescapeQuoted)
}

/** A name token's parts: a word, or a quoted identifier's dotted path (`my-proj.sales.orders`), unescaped. */
function partsOf(token: Tok): string[] {
  if (token.kind === 'word') return [token.text]
  // An unclosed backtick runs to the end of the line: its name ends at the first space.
  const body = token.open ? token.text.slice(1).split(/\s/)[0] : token.text.slice(1, -1)
  return splitQuotedParts(body)
}
const isName = (token: Tok | undefined): token is Tok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier')
const isWord = (token: Tok | undefined, ...words: string[]) => !!token && token.kind === 'word' && words.includes(token.upper)
const isPunct = (token: Tok | undefined, ...values: string[]) => !!token && token.kind === 'punctuation' && values.includes(token.text)
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
  /** Each block's top-level token indexes (the statement's under -1), without a parenthesis's closing ')'. */
  private readonly children = new Map<number, number[]>()

  constructor(readonly text: string, readonly offset: number) {
    const scanned = scanGoogleSql(text)
    // `my-proj-2.sales`: the scanner reads `2.` as a number; a name follows, so it is `2` then a dot.
    // So is a dashed name's last piece before a dot (my-project-123456.), whatever follows.
    const dashedPiece = (index: number) => scanned[index - 1]?.kind === 'punctuation' && text[scanned[index - 1].start] === '-' && scanned[index - 1].end === scanned[index].start
    const split = scanned.flatMap((token, index) => token.kind === 'number' && /^\d+\.$/.test(text.slice(token.start, token.end)) && ((scanned[index + 1]?.kind === 'word' && scanned[index + 1].start === token.end) || dashedPiece(index))
      ? [{ kind: 'number' as const, start: token.start, end: token.end - 1 }, { kind: 'punctuation' as const, start: token.end - 1, end: token.end }] : [token])
    const all = split.map(token => ({ ...token, text: text.slice(token.start, token.end), upper: token.kind === 'word' ? text.slice(token.start, token.end).toUpperCase() : '' }))
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
      const parent = stack.at(-1) ?? -1
      this.parent[index] = parent
      const closing = isPunct(token, ')') && stack.length > 0
      if (!closing) { const list = this.children.get(parent); if (list) list.push(index); else this.children.set(parent, [index]) }
      if (isPunct(token, '(')) { stack.push(index); this.match[index] = this.toks.length }
      else if (closing) this.match[stack.pop()!] = index
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
  top(open: number): readonly number[] {
    return this.children.get(open) ?? []
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
  private readonly bodies = new Map<number, Run[]>()
  private readonly shapes = new Map<number, QueryShape>()
  private depth = 0
  /** For a WITH query's body (by its '('), the WITH names it cannot see: itself (unless RECURSIVE) and the ones after it. */
  readonly hidden = new Map<number, { readonly siblings: readonly CteScope[]; readonly from: number }>()
  /** The WITH names read so far by lower-case name, the first of a name winning. */
  private readonly named = new Map<string, CteScope>()

  constructor(private readonly statement: Statement, private readonly ctes: CteScope[]) {}

  private get toks() { return this.statement.toks }

  /** The block's segments after its WITH queries (whose shapes are added to the scope's), read once. */
  body(open: number): Run[] {
    const kept = this.bodies.get(open)
    if (kept) return kept
    const read = this.readBody(open)
    this.bodies.set(open, read)
    return read
  }

  private readBody(open: number): Run[] {
    const all = segments(this.statement, open)
    const first = all[0]
    if (!first.length || !isWord(this.toks[first[0]], 'WITH')) return all
    let at = 1
    const recursive = isWord(this.toks[first[at]], 'RECURSIVE')
    if (recursive) at++
    const siblings: { cte: CteScope; paren: number }[] = []
    while (at < first.length) {
      const name = this.toks[first[at]], as = this.toks[first[at + 1]], paren = first[at + 2]
      if (!isName(name) || !isWord(as, 'AS') || !isPunct(this.toks[paren], '(')) break
      // Read before its name is added: a WITH query sees only the ones before it (GoogleSQL's rule without RECURSIVE).
      const cte = { name: partsOf(name).join('.'), shape: this.shape(paren) }
      this.ctes.push(cte)
      if (!this.named.has(cte.name.toLowerCase())) this.named.set(cte.name.toLowerCase(), cte)
      siblings.push({ cte, paren })
      at += 3
      if (!isPunct(this.toks[first[at]], ',')) break
      at++
    }
    const list = siblings.map(entry => entry.cte)
    siblings.forEach(({ paren }, index) => this.hidden.set(paren, { siblings: list, from: recursive ? index + 1 : index }))
    return [first.slice(at), ...all.slice(1)]
  }

  /** The columns a parenthesized query gives: its first segment's select list. Nesting past readerLimits.depth gives none. */
  shape(open: number): QueryShape {
    const kept = this.shapes.get(open)
    if (kept) return kept
    if (this.depth >= readerLimits.depth) return { columns: [], stars: [] }
    this.depth++
    try {
      const [first] = this.body(open)
      const shape = first ? this.selectShape(first) : { columns: [], stars: [] }
      this.shapes.set(open, shape)
      return shape
    } finally { this.depth-- }
  }

  /** A segment's sources: the targets of DML, then its FROM (or MERGE's USING) items. An INSERT's target counts only for a caret
   *  in its column list (`caret`; its SELECT reads other tables), unless `includeInsertTarget` is true. */
  sources(run: Run, caret?: number, includeInsertTarget = false): ScopeSource[] {
    const { toks } = this
    const out: ScopeSource[] = []
    const lead = toks[run[0]]
    if (isWord(lead, 'UPDATE', 'DELETE', 'MERGE', 'INSERT')) {
      let at = 1
      if (isWord(toks[run[at]], 'FROM', 'INTO')) at++
      const target = this.item(run, at, true)
      const list = run[target.next] ?? -1
      const inList = isPunct(toks[list], '(') && caret !== undefined && toks[list].end <= caret
        && (this.statement.match[list] >= toks.length || toks[this.statement.match[list]].start >= caret)
      if (target.source && (!isWord(lead, 'INSERT') || inList || includeInsertTarget)) out.push(target.source)
    }
    for (let at = 0; at < run.length; at++) {
      const token = toks[run[at]]
      const using = isWord(token, 'USING') && isWord(lead, 'MERGE')
      if (!isWord(token, 'FROM') && !using) continue
      if (isWord(lead, 'DELETE') && at <= 1) continue
      const items: ScopeSource[] = []
      // The items' names so far, lowercased: implicit unnest asks of each new item whether it starts with one.
      const names = new Set<string>()
      let next = at + 1
      while (next < run.length) {
        const word = toks[run[next]]
        if (word.kind === 'word' && (fromEnd.has(word.upper) || word.upper === 'FROM')) break
        if (isPunct(word, ',') || (word.kind === 'word' && joinWords.has(word.upper))) { next++; continue }
        const read = this.item(run, next)
        if (read.source) {
          const source = implicitUnnest(read.source, names)
          items.push(source)
          if (source.name) names.add(source.name.toLowerCase())
        }
        next = this.skipCondition(run, Math.max(read.next, next + 1))
        if (using) break
      }
      for (const source of items) out.push(source)
      // The scan goes on from where the items ended, so text with many FROMs is read once.
      at = next - 1
    }
    return out
  }

  /** Skips a join's ON or USING condition (and anything else it does not read) to the next item. */
  private skipCondition(run: Run, at: number): number {
    const { toks } = this
    while (at < run.length) {
      const token = toks[run[at]]
      if (isPunct(token, ',') || (token.kind === 'word' && (joinWords.has(token.upper) || fromEnd.has(token.upper) || token.upper === 'FROM'))) return at
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
      const first = dashed(toks, run, at)
      const parts = [...first.parts]
      at = first.next
      while (isPunct(toks[run[at]], '.') && isName(toks[run[at + 1]])) { for (const part of partsOf(toks[run[at + 1]])) parts.push(part); at += 2 }
      // A table-valued function's columns are not indexed.
      if (isPunct(toks[run[at]], '(') && !target) return { next: at + 1 }
      source = { kind: 'object', name: parts.at(-1)!, parts, span: { start: token.start, end: toks[run[at - 1]].end } }
    } else return { next: at + 1 }
    at = this.skipModifiers(run, at)
    let alias: string | undefined
    if (isWord(toks[run[at]], 'AS') && isAlias(toks[run[at + 1]])) { alias = partsOf(toks[run[at + 1]]).join('.'); at += 2 }
    else if (isAlias(toks[run[at]]) && !(toks[run[at]].kind === 'word' && notAliases.has(toks[run[at]].upper))) { alias = partsOf(toks[run[at]]).join('.'); at++ }
    at = this.skipModifiers(run, at)
    if (source && alias !== undefined) source = { ...source, name: alias }
    return { source, next: at }
  }

  /** Skips FOR SYSTEM_TIME AS OF <expression> (whose AS names nothing) and TABLESAMPLE <method> (…), before or after an alias. */
  private skipModifiers(run: Run, at: number): number {
    const { toks } = this
    for (;;) {
      if (isWord(toks[run[at]], 'FOR') && isWord(toks[run[at + 1]], 'SYSTEM_TIME')) {
        at += 2
        if (isWord(toks[run[at]], 'AS') && isWord(toks[run[at + 1]], 'OF')) at += 2
        at = this.skipTimestampExpr(run, at)
      } else if (isWord(toks[run[at]], 'TABLESAMPLE')) {
        at++
        if (toks[run[at]]?.kind === 'word') at++
        if (isPunct(toks[run[at]], '(')) at++
      } else return at
    }
  }

  /** Consumes one `FOR SYSTEM_TIME AS OF` timestamp expression without swallowing a trailing un-`AS`'d table alias or clause keyword. */
  private skipTimestampExpr(run: Run, at: number): number {
    const { toks } = this
    const isExprName = (token: Tok | undefined): token is Tok => isName(token) && !(token.kind === 'word' && timestampStopWords.has(token.upper))
    while (at < run.length) {
      while (at < run.length && isPunct(toks[run[at]], '+', '-')) at++
      const token = toks[run[at]]
      if (!token) break
      if (isWord(token, 'INTERVAL')) {
        at++
        while (at < run.length && isPunct(toks[run[at]], '+', '-')) at++
        const operand = toks[run[at]]
        if (!operand) break
        if (isPunct(operand, '(') || operand.kind === 'number' || operand.kind === 'string' || operand.kind === 'parameter' || isExprName(operand)) at++
        else break
        if (toks[run[at]]?.kind === 'word' && intervalUnits.has(toks[run[at]].upper)) at++
        if (isWord(toks[run[at]], 'TO') && toks[run[at + 1]]?.kind === 'word' && intervalUnits.has(toks[run[at + 1]].upper)) at += 2
      } else if (isWord(token, 'CASE')) {
        let depth = 1
        at++
        while (at < run.length && depth > 0) {
          const cur = toks[run[at]]
          if (cur?.kind === 'word' && cur.upper !== 'WHEN' && timestampStopWords.has(cur.upper)) break
          if (isWord(cur, 'CASE')) depth++
          else if (isWord(cur, 'END')) depth--
          at++
        }
      } else if (isWord(token, 'TIMESTAMP', 'DATE', 'DATETIME', 'TIME') && toks[run[at + 1]]?.kind === 'string') {
        at += 2
      } else if (isPunct(token, '(') || token.kind === 'string' || token.kind === 'number' || token.kind === 'parameter' || token.kind === 'systemVariable') {
        at++
      } else if (isExprName(token)) {
        at++
        while (isPunct(toks[run[at]], '.') && isName(toks[run[at + 1]])) at += 2
        if (isPunct(toks[run[at]], '(')) at++
      } else break
      if (at < run.length && isPunct(toks[run[at]], '+', '-', '*', '/')) { at++; continue }
      break
    }
    return at
  }

  /** A segment's select list: named columns (aliases, a column reference's last part) and `*` or `alias.*`. */
  selectShape(run: Run): QueryShape {
    const { toks } = this
    const select = run.findIndex(index => isWord(toks[index], 'SELECT'))
    if (select < 0) return { columns: [], stars: [] }
    // WITH names as far as they are known here: a WITH query's body is read before its own name and the later ones are added.
    const sources = this.sources(run).map(source => resolveCte(source, name => this.named.get(name)))
    let at = select + 1
    if (isWord(toks[run[at]], 'AS') && isWord(toks[run[at + 1]], 'STRUCT', 'VALUE')) at += 2
    if (isWord(toks[run[at]], 'DISTINCT', 'ALL')) at++
    const columns: string[] = [], stars: ScopeSource[] = []
    // Each source is a star's once, however many times `*` names it (SELECT *, *, t.*).
    const starred = new Set<ScopeSource>()
    const star = (source: ScopeSource) => { if (!starred.has(source)) { starred.add(source); stars.push(source) } }
    let everyStarred = false
    // The sources by name (the first of each), built the first time an `alias.*` asks.
    let names: Map<string, ScopeSource> | undefined
    const byName = () => {
      if (!names) {
        names = new Map()
        for (const source of sources) if (source.name && !names.has(source.name.toLowerCase())) names.set(source.name.toLowerCase(), source)
      }
      return names
    }
    let item: Tok[] = []
    const finish = () => {
      if (!item.length) return
      const last = item.at(-1)!, before = item.at(-2)
      const starAt = item.findIndex(token => isPunct(token, '*'))
      if (starAt === 0) {
        if (!everyStarred) for (const source of sources) star(source)
        everyStarred = true
      }
      else if (starAt > 1 && isPunct(item[starAt - 1], '.')) {
        const chain = chainOf(item.slice(0, starAt - 1))
        const named = chain?.length === 1 ? byName().get(chain[0].toLowerCase()) : undefined
        if (named) star(named)
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

/** `FROM orders o, o.items AS item`: a path that starts with an earlier item's name is that item's array, not a table. */
function implicitUnnest(source: ScopeSource, earlier: ReadonlySet<string>): ScopeSource {
  if (source.kind !== 'object' || source.parts.length < 2) return source
  return earlier.has(source.parts[0].toLowerCase()) ? { kind: 'unnest', name: source.name, path: source.parts } : source
}

/** Whether a token can be a piece of a dashed name (a word or a number). */
const isPiece = (token: Tok | undefined): token is Tok => !!token && (token.kind === 'word' || token.kind === 'number')

/** The first and last pieces of the dashed name (`my-proj-2`, no spaces) around piece `index` of the statement's tokens. */
function dashedSpan(toks: readonly Tok[], index: number): [number, number] {
  let lo = index, hi = index
  while (isPunct(toks[lo - 1], '-') && toks[lo - 1].end === toks[lo].start && isPiece(toks[lo - 2]) && toks[lo - 2].end === toks[lo - 1].start) lo -= 2
  while (isPunct(toks[hi + 1], '-') && toks[hi + 1].start === toks[hi].end && isPiece(toks[hi + 2]) && toks[hi + 2].start === toks[hi + 1].end) hi += 2
  return [lo, hi]
}

/** A name at run position `at` with any dashed words joined on (`my-proj-2`, written without backticks in FROM). */
function dashed(toks: readonly Tok[], run: Run, at: number): { parts: string[]; next: number } {
  const token = toks[run[at]]
  if (token.kind !== 'word') return { parts: partsOf(token), next: at + 1 }
  let text = token.text, end = token.end
  at++
  while (isPunct(toks[run[at]], '-') && toks[run[at]].start === end && (toks[run[at + 1]]?.kind === 'word' || toks[run[at + 1]]?.kind === 'number') && toks[run[at + 1]].start === toks[run[at]].end) {
    text += '-' + toks[run[at + 1]].text
    end = toks[run[at + 1]].end
    at += 2
  }
  return { parts: [text], next: at }
}

/** A run that is only a name chain (`a.b.c`, `` `p.d`.t ``) as its parts, else undefined. */
function chainOf(tokens: readonly Tok[]): string[] | undefined {
  if (!tokens.length || tokens.length % 2 === 0) return
  const parts: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (index % 2 === 0 ? !isName(token) : !isPunct(token, '.')) return
    if (index % 2 === 0) for (const part of partsOf(token)) parts.push(part)
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
  // Inside a WITH query's body, the names it cannot see (itself and the later ones) are out of scope.
  const hidden = new Set<CteScope>()
  for (const block of blocks) {
    const entry = reader.hidden.get(block)
    if (entry) for (let at = entry.from; at < entry.siblings.length; at++) hidden.add(entry.siblings[at])
  }
  const visible = ctes.filter(cte => !hidden.has(cte))
  const named = new Map<string, CteScope>()
  for (const cte of visible) if (!named.has(cte.name.toLowerCase())) named.set(cte.name.toLowerCase(), cte)
  const sources: ScopeSource[] = []
  const end = (run: Run) => run.length ? statement.toks[run.at(-1)!].end : -1
  blocks.forEach((block, depth) => {
    const body = bodies.get(block)!
    const run = depth === 0 ? body.find(segment => segment.length && end(segment) >= offset) ?? body.at(-1) : body.find(segment => segment.includes(blocks[depth - 1]))
    if (run) for (const source of reader.sources(run, offset)) sources.push(resolveCte(source, name => named.get(name)))
  })
  return { sources, ctes: visible }
}

/** A one-part name that is a WITH query refers to it (`find` takes a lower-case name). */
function resolveCte(source: ScopeSource, find: (name: string) => CteScope | undefined): ScopeSource {
  if (source.kind !== 'object' || source.parts.length !== 1) return source
  const cte = find(source.parts[0].toLowerCase())
  return cte ? { kind: 'cte', name: source.name, cte: cte.name, span: source.span } : source
}

/** The top-level token index at `open`'s level immediately before `index`, or -1. */
function prevAtLevel(statement: Statement, index: number, open: number): number {
  let at = index - 1
  while (at > open && statement.parent[at] !== open) at--
  return at > open ? at : -1
}

/** Whether `index` is a closing `)` or an opening `(` whose matching `)` closes before `first`. */
function isClosedGroup(statement: Statement, index: number, first: number): boolean {
  if (index < 0) return false
  const token = statement.toks[index]
  return isPunct(token, ')') || (isPunct(token, '(') && statement.match[index] < first)
}

/** If `index` sits inside/at the end of a `FOR SYSTEM_TIME AS OF <expr>` modifier of the current FROM item, returns the `FOR` token index, else -1. */
function systemTimeBefore(statement: Statement, index: number, open: number): number {
  const { toks } = statement
  const path: number[] = []
  let caseDepth = 0
  for (let at = index; at > open; at--) {
    if (statement.parent[at] !== open) continue
    const token = toks[at]
    if (token.kind === 'word' && token.upper === 'END') { caseDepth++; path.push(at); continue }
    if (caseDepth > 0) {
      if (token.kind === 'word' && token.upper === 'CASE') caseDepth--
      else if (token.kind === 'word' && (token.upper === 'FROM' || token.upper === 'JOIN' || token.upper === 'ON' || token.upper === 'USING' || (fromEnd.has(token.upper) && token.upper !== 'WHEN'))) break
      path.push(at)
      continue
    }
    if (isPunct(token, ',')) break
    if (token.kind === 'word' && (token.upper === 'FROM' || token.upper === 'JOIN' || token.upper === 'ON' || token.upper === 'USING' || fromEnd.has(token.upper))) break
    path.push(at)
  }
  // `path` is reversed (from `index` back toward the item start); require at least one token after `OF`.
  for (let i = path.length - 1; i >= 4; i--) {
    if (isWord(toks[path[i]], 'FOR') && isWord(toks[path[i - 1]], 'SYSTEM_TIME') && isWord(toks[path[i - 2]], 'AS') && isWord(toks[path[i - 3]], 'OF')) {
      return path[i]
    }
  }
  return -1
}

/** Whether `index` is the date-part unit word of an `INTERVAL <expr> <unit>` phrase at `open`'s level. */
function isIntervalUnit(statement: Statement, index: number, open: number): boolean {
  const { toks } = statement
  if (toks[index]?.kind !== 'word' || !intervalUnits.has(toks[index].upper)) return false
  let at = prevAtLevel(statement, index, open)
  if (at >= 0 && isWord(toks[at], 'TO')) {
    const firstUnit = prevAtLevel(statement, at, open)
    if (firstUnit < 0 || toks[firstUnit].kind !== 'word' || !intervalUnits.has(toks[firstUnit].upper)) return false
    at = prevAtLevel(statement, firstUnit, open)
  }
  if (at < 0) return false
  const operand = toks[at]
  if (!valueEnds.has(operand.kind) && !isPunct(operand, ')', '(')) return false
  let before = prevAtLevel(statement, at, open)
  while (before >= 0 && isPunct(toks[before], '+', '-')) before = prevAtLevel(statement, before, open)
  return before >= 0 && isWord(toks[before], 'INTERVAL')
}

/** Whether `before` is immediately inside the `FOR [SYSTEM_TIME [AS [OF [TIMESTAMP]]]]` header (expecting an expression, not an alias/next clause). */
function inSystemTimeHeader(statement: Statement, before: number, open: number): boolean {
  const { toks } = statement
  const p1 = prevAtLevel(statement, before, open)
  const p2 = p1 >= 0 ? prevAtLevel(statement, p1, open) : -1
  const p3 = p2 >= 0 ? prevAtLevel(statement, p2, open) : -1
  const p4 = p3 >= 0 ? prevAtLevel(statement, p3, open) : -1
  const tok0 = toks[before]
  if (isWord(tok0, 'FOR')) return true
  if (isWord(tok0, 'SYSTEM_TIME') && p1 >= 0 && isWord(toks[p1], 'FOR')) return true
  if (isWord(tok0, 'AS') && p1 >= 0 && isWord(toks[p1], 'SYSTEM_TIME') && p2 >= 0 && isWord(toks[p2], 'FOR')) return true
  if (isWord(tok0, 'OF') && p1 >= 0 && isWord(toks[p1], 'AS') && p2 >= 0 && isWord(toks[p2], 'SYSTEM_TIME') && p3 >= 0 && isWord(toks[p3], 'FOR')) return true
  if (isWord(tok0, 'TIMESTAMP') && p1 >= 0 && isWord(toks[p1], 'OF') && p2 >= 0 && isWord(toks[p2], 'AS') && p3 >= 0 && isWord(toks[p3], 'SYSTEM_TIME') && p4 >= 0 && isWord(toks[p4], 'FOR')) return true
  if (isWord(tok0, 'CASE') && systemTimeBefore(statement, before, open) >= 0) return true
  if (isWord(tok0, 'INTERVAL') && systemTimeBefore(statement, before, open) >= 0) return true
  if (isWord(tok0, 'TO') && p1 >= 0 && isIntervalUnit(statement, p1, open) && !(p2 >= 0 && isWord(toks[p2], 'TO')) && systemTimeBefore(statement, before, open) >= 0) return true
  let op = p1
  while (op >= 0 && isPunct(toks[op], '+', '-')) op = prevAtLevel(statement, op, open)
  if (op >= 0 && isWord(toks[op], 'INTERVAL') && systemTimeBefore(statement, before, open) >= 0) return true
  return false
}

/** Whether the FROM item ending at `before` already carries an alias. */
function hasFromAlias(statement: Statement, before: number, open: number, first: number): boolean {
  const { toks } = statement
  const merge = isWord(toks[open + 1] ?? toks[0], 'MERGE')
  let at = before
  for (;;) {
    if (at < 0) return false
    if (isClosedGroup(statement, at, first)) {
      const p1 = prevAtLevel(statement, at, open)
      const p2 = p1 >= 0 ? prevAtLevel(statement, p1, open) : -1
      // Skip trailing TABLESAMPLE <method> (...), PIVOT(...), or UNPIVOT(...) modifiers; closed join USING (...) accepts no alias.
      if (p1 >= 0 && toks[p1].kind === 'word' && p2 >= 0 && isWord(toks[p2], 'TABLESAMPLE')) {
        at = prevAtLevel(statement, p2, open)
        continue
      }
      if (p1 >= 0 && isWord(toks[p1], 'PIVOT', 'UNPIVOT')) {
        at = prevAtLevel(statement, p1, open)
        continue
      }
      if (p1 >= 0 && isWord(toks[p1], 'USING') && !merge) return true
    }
    const st = systemTimeBefore(statement, at, open)
    if (st >= 0) {
      const prev = prevAtLevel(statement, at, open)
      const isExprEnd = !isName(toks[at])
        || isWord(toks[at], 'END')
        || (prev >= 0 && isWord(toks[prev], 'OF') && isWord(toks[prevAtLevel(statement, prev, open)], 'AS'))
        || isIntervalUnit(statement, at, open)
      if (isExprEnd) {
        at = prevAtLevel(statement, st, open)
        continue
      }
    }
    break
  }
  if (at < 0 || !isName(toks[at])) return false
  const prev2 = prevAtLevel(statement, at, open)
  const prev2Tok = prev2 >= 0 ? toks[prev2] : undefined
  if (!prev2Tok || isPunct(prev2Tok, '.') || isPunct(prev2Tok, '-') || isPunct(prev2Tok, ',')) return false
  if (isWord(toks[at], 'OFFSET') && isWord(prev2Tok, 'WITH')) return false
  if (prev2Tok.kind === 'word' && (objectWords.has(prev2Tok.upper) || (prev2Tok.upper === 'USING' && merge))) return false
  if (isWord(prev2Tok, 'OF') && isWord(toks[prevAtLevel(statement, prev2, open)], 'AS')) return false
  return true
}

/** Where a name that starts at token `first` (or the caret, when `first` is the next token) sits: a table name, an alias, or an expression. */
function placeOf(statement: Statement, first: number, open: number): 'object' | 'alias' | 'afterFromTable' | 'expression' | 'statementStart' {
  const { toks } = statement
  const before = prevAtLevel(statement, first, open)
  const previous = before >= 0 ? toks[before] : undefined
  if (!previous) return open < 0 || statement.isQuery(open) ? 'statementStart' : 'expression'
  const from = fromPlace(statement, first, open)
  if (from?.kind === 'items' && inSystemTimeHeader(statement, before, open)) return 'expression'
  if (isWord(previous, 'AS')) return 'alias'
  // Inside a call or other parenthesis that holds no query, FROM is an argument's (EXTRACT(YEAR FROM placed)).
  if (open >= 0 && !statement.isQuery(open)) return 'expression'
  if (previous.kind === 'word' && objectWords.has(previous.upper)) return 'object'
  if (isWord(previous, 'USING') && isWord(toks[open + 1] ?? toks[0], 'MERGE')) return 'object'
  if (isPunct(previous, ',') && from) return 'object'
  // After a table, its alias, a subquery, or a table-operator/time-travel suffix in FROM: an alias or the next clause's keyword.
  if (from?.kind === 'items' && (isName(previous) || isClosedGroup(statement, before, first) || (before >= 0 && valueEnds.has(toks[before].kind) && systemTimeBefore(statement, before, open) >= 0))) return 'afterFromTable'
  return 'expression'
}

/** Whether token `index` is in its block's FROM clause: among its items (and whether directly after JOIN), or in a join's ON or USING condition. */
function fromPlace(statement: Statement, index: number, open: number): { readonly kind: 'items' | 'condition'; readonly inJoin: boolean } | undefined {
  const { toks } = statement
  const merge = isWord(toks[open + 1] ?? toks[0], 'MERGE')
  let condition = false
  let sawComma = false
  let sawClosedUsing = false
  let lastAtLevel = -1
  let caseDepth = 0
  for (let at = index - 1; at > open; at--) {
    if (statement.parent[at] !== open) continue
    const token = toks[at]
    const prevLast = lastAtLevel
    lastAtLevel = at
    if (token.kind === 'word' && token.upper === 'END') { caseDepth++; continue }
    if (caseDepth > 0) {
      if (token.kind === 'word' && token.upper === 'CASE') caseDepth--
      else if (token.kind === 'word' && (token.upper === 'FROM' || token.upper === 'JOIN' || (fromEnd.has(token.upper) && token.upper !== 'WHEN'))) return
      continue
    }
    if (token.kind === 'word' && token.upper === 'CASE') return
    if (isPunct(token, ',')) { sawComma = true; continue }
    if (token.kind !== 'word') continue
    if (token.upper === 'FROM' || token.upper === 'JOIN' || (token.upper === 'USING' && merge)) {
      return { kind: !sawComma && condition ? 'condition' : 'items', inJoin: !sawComma && !sawClosedUsing && token.upper === 'JOIN' }
    }
    if (!sawComma && token.upper === 'ON') condition = true
    else if (!sawComma && token.upper === 'USING') {
      if (prevLast >= 0 && isPunct(toks[prevLast], '(') && statement.match[prevLast] < index) sawClosedUsing = true
      else condition = true
    } else if (token.upper === 'WITH') {
      if (!isWord(toks[prevLast], 'OFFSET')) return
    } else if (token.upper === 'PIVOT' || token.upper === 'UNPIVOT') {
      if (!(prevLast >= 0 && isPunct(toks[prevLast], '(') && statement.match[prevLast] < index)) return
    } else if (fromEnd.has(token.upper)) return
  }
}

/** The name chain that ends just before token or position `end`: the parts written before the one typed, and its first token. */
function chainBefore(statement: Statement, end: number): { parts: string[]; first: number } | undefined {
  const { toks } = statement
  const reversed: string[][] = []
  let at = end - 1
  if (!isPunct(toks[at], '.')) return { parts: [], first: end }
  while (isPunct(toks[at], '.')) {
    const name = toks[at - 1]
    // A dashed project written without backticks (my-proj-2.ds.): its words (and numbers) join into one part.
    const plain = name?.kind === 'word' || (name?.kind === 'number' && isPunct(toks[at - 2], '-'))
    if (!plain && (!isName(name) || name.open)) return undefined
    let start = at - 1, text = name.text
    while (plain && isPunct(toks[start - 1], '-') && toks[start - 1].end === toks[start].start
      && (toks[start - 2]?.kind === 'word' || toks[start - 2]?.kind === 'number') && toks[start - 2].end === toks[start - 1].start) {
      text = toks[start - 2].text + '-' + text
      start -= 2
    }
    reversed.push(plain ? [text] : partsOf(name))
    at = start - 1
  }
  return { parts: reversed.reverse().flat(), first: at + 1 }
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
  // A dashed project typed without backticks where a table goes (FROM my-pro): the word starts at its first piece.
  const at = current >= 0 && isPiece(toks[current]) ? current : -1
  const leftOf = at >= 0 ? at : next
  const startsAt = at >= 0 ? toks[at].start : offset
  if (isPunct(toks[leftOf - 1], '-') && toks[leftOf - 1].end === startsAt && isPiece(toks[leftOf - 2]) && toks[leftOf - 2].end === toks[leftOf - 1].start) {
    const [lo] = dashedSpan(toks, leftOf - 2)
    const open = statement.parentAt(toks[lo].start)
    const chain = chainBefore(statement, lo)
    if (chain && placeOf(statement, chain.first, open) === 'object') {
      const end = at >= 0 ? toks[dashedSpan(toks, at)[1]].end : offset
      word = { start: toks[lo].start, end, typed: text.slice(toks[lo].start, offset), quoted: false }
      return { site: { kind: 'object', qualifier: chain.parts }, scope: scopeAt(statement, open, offset), word }
    }
  }
  if (current >= 0) {
    const token = toks[current]
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'parameter' || token.kind === 'systemVariable') return none(empty)
    if (token.kind === 'word') { word = { start: token.start, end: token.end, typed: text.slice(token.start, offset), quoted: false }; next = current }
    else if (token.kind === 'quotedIdentifier' && (offset < token.end || token.open)) {
      // Inside backticks: the dotted path before the caret qualifies the part being typed; unclosed backticks stop at whitespace.
      const rawBodyEnd = token.open ? token.end : token.end - 1
      const rawBody = text.slice(token.start + 1, rawBodyEnd)
      const firstSpace = token.open ? rawBody.search(/\s/) : -1
      const bodyEnd = firstSpace >= 0 ? Math.max(offset, token.start + 1 + firstSpace) : rawBodyEnd
      const body = firstSpace >= 0 ? rawBody.slice(0, firstSpace) : rawBody
      const before = text.slice(token.start + 1, offset)
      const fullDomain = domainProjectPrefix(body)
      if (fullDomain && before.length <= fullDomain.length) {
        const start = token.start + 1
        const endOffset = token.start + 1 + fullDomain.length
        qualifier = []
        word = { start, end: endOffset, typed: before, quoted: true }
      } else {
        const dot = before.lastIndexOf('.')
        const start = token.start + 1 + dot + 1
        // An unclosed backtick's part ends at a dot, or (its closing backtick not typed yet) at the first space.
        const after = text.slice(offset, bodyEnd).search(token.open ? /[.\s]/ : /\./)
        qualifier = dot < 0 ? [] : splitQuotedParts(before.slice(0, dot))
        word = { start, end: after < 0 ? bodyEnd : offset + after, typed: text.slice(start, offset), quoted: true }
      }
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
  else if (place === 'alias') site = castCalls.has(googleSqlCallContext(text, offset)?.name.toUpperCase() ?? '') ? { kind: 'castType' } : { kind: 'none' }
  else if (parts.length) site = { kind: 'member', qualifier: parts }
  else if (place === 'afterFromTable') {
    const before = prevAtLevel(statement, chain.first, open)
    const from = fromPlace(statement, chain.first, open)
    site = { kind: 'afterFromTable', hasAlias: hasFromAlias(statement, before, open, chain.first), inJoin: from?.inJoin ?? false }
  } else if (place === 'statementStart') site = { kind: 'statementStart' }
  else site = { kind: 'expression' }
  return { site, scope, word }
}

/** The name chain at `offset` for hover: every part, the one under the caret, and whether it names a table. */
export function readGoogleSqlHover(text: string, offset: number): HoverRead | undefined {
  const statement = new Statement(text, offset)
  const { toks } = statement
  if (statement.inside && statement.inside.kind !== 'quotedIdentifier') return
  const under = toks.findIndex(token => (token.kind === 'word' || token.kind === 'number' || token.kind === 'quotedIdentifier') && token.start <= offset && offset < token.end)
  if (under < 0) return
  // A dashed project written without backticks in FROM (my-proj.sales.orders) is one part; elsewhere `a-b` is a subtraction.
  const dashedFirst = (index: number) => isPiece(toks[index]) ? dashedSpan(toks, index)[0] : index
  let at = under, first = under, last = under
  let [lo, hi] = isPiece(toks[under]) ? dashedSpan(toks, under) : [under, under]
  if (lo !== hi) { first = hi; last = hi }
  while (isPunct(toks[first - 1], '.') && isName(toks[first - 2])) first -= 2
  while (isPunct(toks[last + 1], '.') && isName(toks[last + 2])) last += 2
  lo = dashedFirst(first)
  const dashedObject = lo < first && placeOf(statement, lo, statement.parentAt(toks[lo].start)) === 'object'
  if (!dashedObject) {
    if (!isName(toks[under])) return
    at = first = last = under
    while (isPunct(toks[first - 1], '.') && isName(toks[first - 2])) first -= 2
    while (isPunct(toks[last + 1], '.') && isName(toks[last + 2])) last += 2
  } else if (under < first) at = first
  const parts: string[] = []
  let index = 0
  for (let token = first; token <= last; token += 2) {
    const own = token === first && dashedObject ? [text.slice(toks[lo].start, toks[first].end)] : partsOf(toks[token])
    if (token === at) {
      if (toks[token].kind === 'quotedIdentifier') {
        // The part of a dotted quoted path the caret is on.
        const inner = text.slice(toks[token].start + 1, offset)
        const rawBodyEnd = toks[token].open ? toks[token].end : toks[token].end - 1
        const rawBody = text.slice(toks[token].start + 1, rawBodyEnd)
        const firstSpace = toks[token].open ? rawBody.search(/\s/) : -1
        const body = firstSpace >= 0 ? rawBody.slice(0, firstSpace) : rawBody
        const fullDomain = domainProjectPrefix(body)
        const partIndex = fullDomain && inner.length <= fullDomain.length ? 0 : splitQuotedParts(inner).length - 1
        index = parts.length + Math.min(own.length - 1, partIndex)
      } else index = parts.length
    }
    for (const part of own) parts.push(part)
  }
  if (dashedObject) first = lo
  const open = statement.parentAt(toks[first].start)
  const place = placeOf(statement, first, open)
  // A name followed by '(' is a call: a function, not a column.
  if (isPunct(toks[last + 1], '(') && index === parts.length - 1 && place !== 'object') {
    return { parts, at: index, span: { start: toks[first].start, end: toks[last].end }, object: false, call: true, scope: { sources: [], ctes: [] } }
  }
  return { parts, at: index, span: { start: toks[first].start, end: toks[last].end }, object: place === 'object', scope: scopeAt(statement, open, offset) }
}

/**
 * All object sources in the statement around `offset`, across every set-operation segment, CTE body, and nested subquery,
 * independent of whether `offset` sits inside a literal, comment or trailing token.
 */
export function readGoogleSqlStatementSources(text: string, offset: number): ScopeSource[] {
  const statement = new Statement(text, offset)
  const ctes: CteScope[] = []
  const reader = new BlockReader(statement, ctes)
  const blocks = [-1]
  for (let index = 0; index < statement.toks.length; index++) {
    if (isPunct(statement.toks[index], '(') && statement.isQuery(index)) blocks.push(index)
  }
  const sources: ScopeSource[] = []
  for (const block of blocks) {
    for (const run of reader.body(block)) {
      for (const source of reader.sources(run, undefined, true)) sources.push(source)
    }
  }
  return sources
}
