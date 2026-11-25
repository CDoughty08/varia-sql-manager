// Toggle Brackets and Commas to Front or End: token-aware text transforms as pure functions over a string, so they are
// tested without Monaco. Toggle Brackets is SQL Server's; the comma commands read GoogleSQL too, through
// `googleSqlTransformTokens`. Each returns offset edits on the original text; `sqlTransformOp` turns them into a TextOp
// (one undo step) with the selections moved along with the text.
import { scanGoogleSql } from '../../../shared/googlesql/lexer.ts'
import { contextualKeywords, isSignificant, keywordLikeWords, lexSql, reservedKeywords, systemTypeNames, type SqlToken } from '../../../shared/sql/lexer.ts'
import { maxIdentifierLength } from '../../../shared/sql/identifiers.ts'
import { textOpLimits, type TextOp, type TextSelection } from './text-ops'

export interface OffsetRange { readonly start: number; readonly end: number }
export interface OffsetEdit { readonly start: number; readonly end: number; readonly text: string }

export const sqlTransformMessages = {
  tooLarge: `The query is too large to change (more than ${textOpLimits.characters.toLocaleString('en-US')} characters).`,
  nothingToBracket: (selection: boolean) => selection ? 'The selection has no names to bracket or unbracket.' : 'The query has no names to bracket or unbracket.',
  noCommas: (front: boolean, selection: boolean) => `No commas to move to the ${front ? 'front' : 'end'} of a line in the ${selection ? 'selection' : 'statement'}.`
} as const

const upper = (text: string, token: SqlToken) => text.slice(token.start, token.end).toUpperCase()
const inRanges = (token: SqlToken, ranges: readonly OffsetRange[] | undefined) => !ranges || ranges.some(range => token.start >= range.start && token.end <= range.end)

/** Statements that start at a word: a SET after one of these (other than UPDATE and ALTER) is a statement of its own. */
const statementStarts = new Set(`SELECT INSERT UPDATE DELETE MERGE CREATE ALTER DROP DECLARE SET EXEC EXECUTE IF ELSE WHILE BEGIN END RETURN PRINT USE
GRANT DENY REVOKE TRUNCATE WITH OPEN CLOSE FETCH DEALLOCATE BREAK CONTINUE GOTO WAITFOR RAISERROR THROW COMMIT ROLLBACK SAVE
BACKUP RESTORE DBCC KILL SEND`.split(/\s+/))
/** Functions whose first argument is a date part (`day`, `mm`), never a column. */
const datePartFunctions = new Set(['DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'DATENAME', 'DATETRUNC', 'DATE_BUCKET'])
/** Keywords before a name that a parenthesis follows as a column list, not as a function's arguments. */
const nameBeforeParen = new Set(['INTO', 'TABLE', 'REFERENCES', 'INSERT', 'VIEW', 'FUNCTION', 'PROCEDURE', 'PROC', 'WITH', 'MERGE'])
/** Where the word after is an object type (CREATE SEQUENCE, CREATE NONCLUSTERED COLUMNSTORE INDEX), not a name. */
const typeKeywordAfter = new Set(['CREATE', 'ALTER', 'DROP', 'UNIQUE', 'CLUSTERED', 'NONCLUSTERED'])
/** Join hints, which follow a join type (INNER LOOP JOIN, LEFT OUTER HASH JOIN). */
const joinHints = new Set(['LOOP', 'HASH', 'REMOTE'])
const joinTypes = new Set(['INNER', 'OUTER', 'LEFT', 'RIGHT', 'FULL'])
/** The JSON functions whose arguments end with `{ NULL | ABSENT } ON NULL` or `RETURNING type` (Azure SQL's JSON_VALUE), words that are not reserved. */
const jsonClauseFunctions = new Set(['JSON_OBJECT', 'JSON_ARRAY', 'JSON_OBJECTAGG', 'JSON_ARRAYAGG', 'JSON_VALUE'])
/** Clauses that end a table hint or option list that has no parentheses (FROM t WITH NOLOCK WHERE …). */
const optionListEnds = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'UNION', 'EXCEPT', 'INTERSECT'])
/** Statements about servers, databases and security, by their first word or by the object after CREATE, ALTER or DROP. */
const adminStatements = new Set(['GRANT', 'DENY', 'REVOKE', 'BACKUP', 'RESTORE', 'DBCC', 'KILL', 'SEND'])
/** Keys and Service Broker conversations: OPEN SYMMETRIC KEY, CLOSE ALL SYMMETRIC KEYS, BEGIN DIALOG, END CONVERSATION. */
const adminAfter: Readonly<Record<string, readonly string[]>> = { OPEN: ['SYMMETRIC', 'MASTER'], CLOSE: ['SYMMETRIC', 'MASTER', 'ALL'], BEGIN: ['DIALOG', 'CONVERSATION'], END: ['CONVERSATION'] }
const adminObjects = new Set(`DATABASE LOGIN USER ROLE SEQUENCE EVENT PARTITION CERTIFICATE CREDENTIAL ENDPOINT SERVER AVAILABILITY MASTER
SYMMETRIC ASYMMETRIC APPLICATION RESOURCE WORKLOAD AUDIT BROKER MESSAGE CONTRACT QUEUE SERVICE ROUTE FULLTEXT SEARCH
CRYPTOGRAPHIC AUTHORIZATION`.split(/\s+/))
/** In those statements, the words a name follows (CREATE LOGIN l, GRANT … ON t TO u, ALTER ROLE r ADD MEMBER u, BACKUP LOG db). */
const adminNameAfter = new Set(`DATABASE LOGIN USER ROLE SEQUENCE SESSION FUNCTION SCHEME INDEX CERTIFICATE CREDENTIAL ENDPOINT AUDIT MEMBER
AUTHORIZATION ON TO PARTITION QUEUE SERVICE ROUTE CONTRACT LOG EXISTS KEY FILEGROUP`.split(/\s+/))
/** Words in a name position there that are still part of the statement's object type (CREATE DATABASE AUDIT SPECIFICATION). */
// The keywords after TO in BACKUP … TO URL, ADD FILE … TO FILEGROUP and SERVER AUDIT … TO APPLICATION_LOG, and after
// OPEN MASTER KEY and SEND ON CONVERSATION, are not names either.
const adminTypeWords = new Set([...adminObjects, 'SPECIFICATION', 'SCHEME', 'SESSION', 'URL', 'TAPE', 'FILEGROUP', 'APPLICATION_LOG', 'SECURITY_LOG', 'DECRYPTION', 'CONVERSATION', 'DIALOG'])

/**
 * Which of `text`'s word tokens Toggle Brackets may bracket: names, never keywords, built-in function names (a word that a
 * parenthesis follows, unless a column list follows a table's name), date parts, type names where a type is expected,
 * labels, or the words of option lists (WITH (…), OPTION (…), FOR XML/JSON, SET options, cursor and FETCH options).
 */
function bracketableWords(text: string, tokens: readonly SqlToken[]): Set<SqlToken> {
  const sig = tokens.filter(isSignificant)
  const lineOf = lineIndex(text)
  const result = new Set<SqlToken>()
  const word = (index: number) => sig[index]?.kind === 'word' ? upper(text, sig[index]!) : undefined
  const skip = new Set<number>()
  /** Skips from `from` to the end of the parenthesised group that opens at `open`. */
  const skipGroup = (open: number) => {
    let depth = 0, index = open
    for (; index < sig.length; index++) {
      skip.add(index)
      if (sig[index]!.kind === 'open') depth++
      else if (sig[index]!.kind === 'close' && --depth === 0) break
    }
    return index
  }
  /**
   * Skips an option list from `from`, over line breaks and the groups it opens, to the end of its statement: a semicolon,
   * a SQLCMD line, the next statement or clause (`ends`), a parenthesis it did not open, or `stop`.
   */
  const skipOptions = (from: number, stop?: (index: number) => boolean) => {
    let depth = 0
    for (let index = from; index < sig.length; index++) {
      const token = sig[index]!, keyword = word(index)
      if (token.kind === 'semicolon' || token.kind === 'sqlcmd' || (keyword === 'GO' && firstOnLine(index))) break
      if (depth === 0 && ((keyword !== undefined && (statementStarts.has(keyword) || optionListEnds.has(keyword))) || stop?.(index))) break
      if (token.kind === 'open') depth++
      else if (token.kind === 'close') { if (depth === 0) break; depth-- }
      skip.add(index)
    }
  }
  const firstOnLine = (index: number) => index === 0 || lineOf(sig[index - 1]!.end) !== lineOf(sig[index]!.start)
  // Statements about servers, databases and security (CREATE LOGIN, ALTER DATABASE, GRANT, BACKUP …) are mostly options
  // that no list can hold: in them only a name position is bracketed (`adminNameAfter`, or a part of a dotted name).
  const admin: (string | undefined)[] = []
  for (let index = 0, depth = 0, head: string | undefined; index < sig.length; index++) {
    const token = sig[index]!, keyword = word(index)
    if (token.kind === 'semicolon' || token.kind === 'sqlcmd' || (keyword === 'GO' && firstOnLine(index))) { head = undefined; depth = 0; continue }
    if (depth === 0 && keyword !== undefined && statementStarts.has(keyword) && (head === undefined || firstOnLine(index))) {
      const object = word(index + 1)
      head = adminStatements.has(keyword) || (object !== undefined && adminAfter[keyword]?.includes(object)) ? keyword
        : (keyword === 'CREATE' || keyword === 'ALTER' || keyword === 'DROP') && object !== undefined && (adminObjects.has(object) || (keyword === 'ALTER' && object === 'INDEX')) ? object
          : undefined
    }
    if (token.kind === 'open') depth++
    else if (token.kind === 'close' && depth > 0) depth--
    admin[index] = head
  }
  // The word before each open parenthesis, innermost last, so a word knows the function it is an argument of.
  // And each open parenthesis's closing one, by index.
  const callers: (string | undefined)[] = []
  const callerAt: (string | undefined)[] = []
  const opens: number[] = [], closing: number[] = []
  for (let index = 0; index < sig.length; index++) {
    const token = sig[index]!
    callerAt[index] = callers[callers.length - 1]
    if (token.kind === 'open') { callers.push(word(index - 1)); opens.push(index) }
    else if (token.kind === 'close') { callers.pop(); const open = opens.pop(); if (open !== undefined) closing[open] = index }
  }
  for (let index = 0; index < sig.length; index++) {
    const token = sig[index]!
    if (token.kind !== 'word' || skip.has(index)) continue
    const name = upper(text, token), next = sig[index + 1]
    if ((name === 'WITH' || name === 'OPTION') && next?.kind === 'open') { index = skipGroup(index + 1); continue }
    // OPENROWSET(BULK 'file', SINGLE_CLOB) and (BULK …, FORMATFILE = …) hold only options.
    if (name === 'OPENROWSET' && next?.kind === 'open' && word(index + 2) === 'BULK') { index = skipGroup(index + 1); continue }
    if (name === 'FOR' && ['XML', 'JSON', 'BROWSE'].includes(word(index + 1) ?? '')) {
      let depth = 0
      for (let at = index + 1; at < sig.length; at++) {
        const inside = sig[at]!
        if (inside.kind === 'semicolon' || (depth === 0 && inside.kind === 'word' && statementStarts.has(upper(text, inside)))) break
        if (inside.kind === 'open') depth++
        else if (inside.kind === 'close') { if (depth === 0) break; depth-- }
        skip.add(at)
      }
      continue
    }
    if (name === 'WITH' && next?.kind === 'word') {
      const after = sig[index + 2]
      const cte = after?.kind === 'open' || (after?.kind === 'word' && upper(text, after) === 'AS' && sig[index + 3]?.kind === 'open')
      // `WITH CHECK ADD CONSTRAINT fk …` (ALTER TABLE) names the constraint and its columns after the option.
      if (!cte && upper(text, next) !== 'TIES') skipOptions(index + 1, at => word(at) === 'AS' || word(at) === 'ADD' || word(at) === 'CONSTRAINT')
      continue
    }
    if (name === 'SET') {
      // A foreign key's ON DELETE SET NULL / ON UPDATE SET DEFAULT is an action, not a SET statement.
      if ((word(index - 1) === 'DELETE' || word(index - 1) === 'UPDATE') && word(index - 2) === 'ON') continue
      let head: string | undefined
      for (let back = index - 1; back >= 0; back--) {
        const before = sig[back]!
        if (before.kind === 'semicolon' || before.kind === 'sqlcmd') break
        const keyword = word(back)
        if (keyword === 'GO' && lineOf(before.start) !== lineOf(token.start)) break
        // UPDATE t WITH (ROWLOCK) SET: a table hint's WITH is not the statement's.
        if (keyword !== undefined && statementStarts.has(keyword) && !(keyword === 'WITH' && sig[back + 1]?.kind === 'open')) { head = keyword; break }
      }
      if (head === 'ALTER' || (head !== 'UPDATE' && next !== undefined && next.kind !== 'variable')) skipOptions(index + 1)
      continue
    }
    if (name === 'CURSOR' && sig[index - 1]?.kind !== 'variable') { skipOptions(index + 1, at => word(at) === 'FOR'); continue }
    if (name === 'FETCH') { skipOptions(index + 1, at => word(at) === 'FROM'); continue }
  }
  for (let index = 0; index < sig.length; index++) {
    const token = sig[index]!
    if (token.kind !== 'word' || skip.has(index)) continue
    const name = upper(text, token)
    if (reservedKeywords.has(name) || contextualKeywords.has(name) || keywordLikeWords.has(name)) continue
    const previous = sig[index - 1], next = sig[index + 1]
    const before = word(index - 1), beforeThat = word(index - 2)
    // ODBC escapes: {fn UCASE(…)}, {d '2024-01-01'}, {call p}.
    if (previous?.kind === 'operator' && text[previous.start] === '{') continue
    const statement = admin[index]
    if (statement !== undefined) {
      const dotted = previous?.kind === 'dot' || next?.kind === 'dot'
      const named = statement === 'EVENT' ? before === 'SESSION' : dotted || (before !== undefined && adminNameAfter.has(before))
      if (!named || (!dotted && adminTypeWords.has(name))) continue
    }
    // Labels (`retry:`, GOTO retry), static members (geography::Point), and the word after keywords that name a type or option.
    // JSON_OBJECT(k:v) and JSON_OBJECTAGG(k:v) put a key, not a label, before the colon.
    const jsonKey = callerAt[index] === 'JSON_OBJECT' || callerAt[index] === 'JSON_OBJECTAGG'
    if ((next?.kind === 'colon' && !jsonKey) || next?.kind === 'scope' || previous?.kind === 'scope') continue
    if (before === 'GOTO' || before === 'COLLATE' || before === 'DBCC' || before === 'NEXT') continue
    if (before !== undefined && typeKeywordAfter.has(before) && previous?.kind === 'word') continue
    if (before === 'OR' && beforeThat === 'CREATE') continue
    if (before === 'AS' && (beforeThat === 'EXEC' || beforeThat === 'EXECUTE')) continue
    if (before === 'BY' && beforeThat === 'MATCHED') continue
    // WAITFOR DELAY / TIME, ON DELETE NO ACTION, a temporal table's ROW START and PERIOD FOR SYSTEM_TIME, ENABLE / DISABLE
    // TRIGGER, and a join hint (INNER LOOP JOIN).
    if (before === 'WAITFOR' || (name === 'ACTION' && before === 'NO') || (name === 'START' && before === 'ROW')) continue
    if ((name === 'PERIOD' && word(index + 1) === 'FOR') || ((name === 'ENABLE' || name === 'DISABLE') && word(index + 1) === 'TRIGGER')) continue
    if (joinHints.has(name) && word(index + 1) === 'JOIN' && joinTypes.has(before ?? '')) continue
    if ((name === 'AT' && word(index + 1) === 'TIME' && word(index + 2) === 'ZONE') || (name === 'TIME' && before === 'AT' && word(index + 1) === 'ZONE') || (name === 'ZONE' && before === 'TIME' && beforeThat === 'AT')) continue
    if (previous?.kind === 'open' && datePartFunctions.has(beforeThat ?? '') && next?.kind === 'comma') continue
    // A column may be called absent or returning: the clause words are the ones ON NULL or a type name follows.
    if (jsonClauseFunctions.has(callerAt[index] ?? '') && ((name === 'ABSENT' && word(index + 1) === 'ON' && word(index + 2) === 'NULL') || (name === 'RETURNING' && systemTypeNames.has(word(index + 1) ?? '')))) continue
    if (systemTypeNames.has(name)) {
      if (previous?.kind === 'variable' || before === 'RETURNS' || (before === 'RETURNING' && jsonClauseFunctions.has(callerAt[index] ?? ''))) continue
      if (before === 'AS' && (sig[index - 2]?.kind === 'variable' || callerAt[index] === 'CAST' || callerAt[index] === 'TRY_CAST')) continue
      if (previous?.kind === 'open' && (beforeThat === 'CONVERT' || beforeThat === 'TRY_CONVERT')) continue
    }
    if (next?.kind === 'open') {
      // A name a column list follows (INSERT INTO t (…), REFERENCES s.t (…)); anything else before a parenthesis is a call.
      let first = index
      while (sig[first - 1]?.kind === 'dot' && ['word', 'bracketed', 'quoted'].includes(sig[first - 2]?.kind ?? '')) first -= 2
      const keyword = word(first - 1)
      // CREATE INDEX ix ON t (…) and CREATE STATISTICS s ON t (…) name a table; a CTE's name has its column list before AS (.
      const onTable = keyword === 'ON' && ['INDEX', 'STATISTICS'].includes(word(first - 3) ?? '') && ['word', 'bracketed', 'quoted'].includes(sig[first - 2]?.kind ?? '')
      const close = closing[index + 1]
      const cte = close !== undefined && word(close + 1) === 'AS' && sig[close + 2]?.kind === 'open'
      if (!onTable && !cte && (keyword === undefined || !nameBeforeParen.has(keyword))) continue
    }
    result.add(token)
  }
  return result
}

/** A bracketed name's text, or undefined when taking its brackets off would change what it means. */
function plainName(text: string, token: SqlToken): string | undefined {
  const raw = text.slice(token.start, token.end)
  if (!raw.endsWith(']') || raw.length < 3) return undefined
  const name = raw.slice(1, -1)
  if (name.length > maxIdentifierLength || !/^[\p{L}_][\p{L}\p{Nd}_@#$]*$/u.test(name)) return undefined
  const key = name.toUpperCase()
  if (reservedKeywords.has(key) || contextualKeywords.has(key)) return undefined
  return name
}

/**
 * Toggle Brackets: in the ranges (the whole text when undefined), brackets every name that has none, or, when every name
 * already has them, takes them off the names that do not need them. Strings, comments, variables, temporary tables,
 * quoted names and keywords are never changed.
 */
export function toggleBracketEdits(text: string, ranges?: readonly OffsetRange[]): { readonly mode: 'add' | 'remove' | 'none'; readonly edits: OffsetEdit[] } {
  const tokens = lexSql(text)
  const add = [...bracketableWords(text, tokens)].filter(token => inRanges(token, ranges))
  if (add.length) return { mode: 'add', edits: add.map(token => ({ start: token.start, end: token.end, text: `[${text.slice(token.start, token.end)}]` })) }
  const edits: OffsetEdit[] = []
  const joins = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_@#$'"]/u.test(char)
  for (const token of tokens) {
    if (token.kind !== 'bracketed' || !inRanges(token, ranges)) continue
    const name = plainName(text, token)
    if (name === undefined) continue
    // `AS[x]`, `[N]'…'` and `[a][b]` (a column and its alias) keep a space, so a name never runs into its neighbours.
    const last = edits[edits.length - 1], afterPlain = last !== undefined && last.end === token.start && !last.text.endsWith(' ')
    edits.push({ start: token.start, end: token.end, text: (joins(text[token.start - 1]) || afterPlain ? ' ' : '') + name + (joins(text[token.end]) ? ' ' : '') })
  }
  return { mode: edits.length ? 'remove' : 'none', edits }
}

/** The query languages the comma commands read: `go` is whether a line holding only GO ends a statement (T-SQL's batch separator). */
export interface TransformDialect { readonly go: boolean }
export const tsqlTransforms: TransformDialect = { go: true }
export const googleSqlTransforms: TransformDialect = { go: false }

/**
 * GoogleSQL's tokens (`shared/googlesql/lexer.ts`) in the shape the comma commands read: `#` and `--` comments, triple-quoted
 * and raw strings and backtick names each stay one token, so no comma inside them ever moves. White space is split at line
 * breaks, a line comment ends before a `\r`, and `[`/`]` are brackets as `(`/`)` are.
 */
export function googleSqlTransformTokens(text: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const space = (start: number, end: number) => {
    let at = start
    while (at < end) {
      const char = text[at]
      if (char === '\n' || char === '\r') {
        const stop = char === '\r' && text[at + 1] === '\n' && at + 1 < end ? at + 2 : at + 1
        tokens.push({ kind: 'newline', start: at, end: stop })
        at = stop
      } else {
        let stop = at + 1
        while (stop < end && text[stop] !== '\n' && text[stop] !== '\r') stop++
        tokens.push({ kind: 'space', start: at, end: stop })
        at = stop
      }
    }
  }
  const punctuation: Readonly<Record<string, SqlToken['kind']>> = { ',': 'comma', ';': 'semicolon', '.': 'dot', '(': 'open', '[': 'open', ')': 'close', ']': 'close', ':': 'colon' }
  // A line comment's `\r` is held back for the white space after it, so `\r\n` stays one line break.
  let held: number | undefined
  for (const token of scanGoogleSql(text)) {
    const { start, end } = token
    if (held !== undefined && token.kind !== 'whitespace') { space(held, start); held = undefined }
    switch (token.kind) {
      case 'whitespace': space(held ?? start, end); held = undefined; break
      case 'comment':
        if (text.startsWith('/*', start)) tokens.push({ kind: 'blockComment', start, end })
        else {
          const stop = end > start && text[end - 1] === '\r' ? end - 1 : end
          tokens.push({ kind: 'lineComment', start, end: stop })
          if (stop < end) held = stop
        }
        break
      case 'string': tokens.push({ kind: 'string', start, end }); break
      case 'quotedIdentifier': tokens.push({ kind: 'quoted', start, end }); break
      case 'number': tokens.push({ kind: 'number', start, end }); break
      case 'word': tokens.push({ kind: 'word', start, end }); break
      case 'parameter': case 'systemVariable': tokens.push({ kind: 'variable', start, end }); break
      default: tokens.push({ kind: punctuation[text[start]!] ?? 'operator', start, end })
    }
  }
  if (held !== undefined) space(held, text.length)
  return tokens
}

/** The statement around `offset`: between semicolons, GO lines (T-SQL), SQLCMD lines and blank lines. */
export function statementAt(text: string, offset: number, tokens: readonly SqlToken[] = lexSql(text), dialect: TransformDialect = tsqlTransforms): OffsetRange {
  const boundaries: OffsetRange[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'semicolon') boundaries.push({ start: token.end, end: token.end })
    else if (token.kind === 'sqlcmd') boundaries.push(token)
    else if (dialect.go && token.kind === 'word' && text.slice(token.start, token.end).toUpperCase() === 'GO' && firstOnLine(tokens, index) && lastOnLine(tokens, index)) boundaries.push(token)
    else if (token.kind === 'newline') {
      let next = index + 1
      if (tokens[next]?.kind === 'space') next++
      if (tokens[next]?.kind === 'newline') boundaries.push({ start: token.end, end: tokens[next]!.start })
    }
  }
  // A semicolon's boundary is empty and just after it, so a caret right after a statement's semicolon is in that statement.
  let start = 0, end = text.length
  for (const boundary of boundaries) {
    if (boundary.end < offset || (boundary.end === offset && boundary.start !== boundary.end)) start = Math.max(start, boundary.end)
    // A caret inside a separator (on GO, a SQLCMD line or a blank line) is in the statement before it.
    if (boundary.start >= offset || boundary.end > offset) end = Math.min(end, boundary.start)
  }
  return { start, end: Math.max(start, end) }
}

const firstOnLine = (tokens: readonly SqlToken[], index: number) => {
  for (let at = index - 1; at >= 0; at--) { const kind = tokens[at]!.kind; if (kind === 'newline') return true; if (kind !== 'space' && kind !== 'blockComment') return false }
  return true
}
const lastOnLine = (tokens: readonly SqlToken[], index: number) => {
  for (let at = index + 1; at < tokens.length; at++) { const kind = tokens[at]!.kind; if (kind === 'newline') return true; if (kind !== 'space' && kind !== 'lineComment' && kind !== 'blockComment') return false }
  return true
}

/** Where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) starts.push(index + 1)
  }
  return starts
}

/** Line numbers (from 0) by offset, through a sorted list of line starts. */
function lineIndex(text: string, starts: readonly number[] = lineStarts(text)): (offset: number) => number {
  return offset => {
    let low = 0, high = starts.length
    while (low < high) { const middle = (low + high) >> 1; if (starts[middle]! <= offset) low = middle + 1; else high = middle }
    return low - 1
  }
}

/**
 * Commas to Front or Commas to End: every comma (outside strings and comments) in the ranges that ends a line moves to the
 * start of the next item's line (`front`, SSMS's `      ,[b]` shape: into the indent's last space), or every comma that
 * starts a line moves to the end of the item before it (`end`, ahead of a trailing comment). A comma before a closing
 * parenthesis, a semicolon or GO (T-SQL), or after an opening one, stays. GoogleSQL passes `googleSqlTransformTokens` and
 * `googleSqlTransforms`.
 */
export function moveCommaEdits(text: string, ranges: readonly OffsetRange[], position: 'front' | 'end', tokens: readonly SqlToken[] = lexSql(text), dialect: TransformDialect = tsqlTransforms): OffsetEdit[] {
  const lineOf = lineIndex(text)
  const edits: OffsetEdit[] = []
  const significant = (from: number, step: 1 | -1) => { for (let at = from + step; at >= 0 && at < tokens.length; at += step) if (isSignificant(tokens[at]!)) return at; return undefined }
  const isGo = (index: number) => dialect.go && tokens[index]!.kind === 'word' && text.slice(tokens[index]!.start, tokens[index]!.end).toUpperCase() === 'GO'
  for (let index = 0; index < tokens.length; index++) {
    const comma = tokens[index]!
    if (comma.kind !== 'comma' || !inRanges(comma, ranges)) continue
    const p = significant(index, -1), n = significant(index, 1)
    if (p === undefined || n === undefined) continue
    const before = tokens[p]!, after = tokens[n]!
    if (['open', 'comma', 'semicolon', 'sqlcmd'].includes(before.kind) || ['close', 'comma', 'semicolon', 'sqlcmd'].includes(after.kind) || isGo(n)) continue
    const line = lineOf(comma.start)
    const trailing = lineOf(after.start) > line, leading = lineOf(before.end) < line
    if (position === 'front' ? !trailing : !leading) continue
    // A comma alone on its line (white space around it, nothing else) takes its line with it.
    const lineStart = tokens[index - 1]?.kind === 'space' ? index - 1 : index
    const alone = leading && trailing && (lineStart === 0 || tokens[lineStart - 1]!.kind === 'newline')
      && (tokens[index + 1]?.kind === 'newline' || (tokens[index + 1]?.kind === 'space' && tokens[index + 2]?.kind === 'newline'))
    if (alone) {
      const newline = tokens[index + 1]!.kind === 'newline' ? tokens[index + 1]! : tokens[index + 2]!
      edits.push({ start: tokens[lineStart]!.start, end: newline.end, text: '' })
    } else if (position === 'front') {
      // `a ,   ⏎` loses the comma and the white space either side of it; a comment after it stays where it is.
      let start = comma.start, end = comma.end
      if (tokens[index - 1]?.kind === 'space') start = tokens[index - 1]!.start
      if (tokens[index + 1]?.kind === 'space' && (tokens[index + 2] === undefined || tokens[index + 2]!.kind === 'newline')) end = tokens[index + 1]!.end
      edits.push({ start, end, text: '' })
    } else {
      // `    , b` becomes `    b`; `      ,b` becomes `       b`, keeping b where it was.
      const space = tokens[index + 1]
      if (space?.kind === 'space') edits.push({ start: comma.start, end: space.end, text: '' })
      else edits.push({ start: comma.start, end: comma.end, text: text[comma.start - 1] === ' ' ? ' ' : '' })
    }
    if (position === 'front') {
      const indent = tokens[n - 1]
      const firstOnItsLine = indent?.kind === 'space' && (n - 1 === 0 || tokens[n - 2]!.kind === 'newline')
      if (firstOnItsLine && text[after.start - 1] === ' ' && !(alone && edits[edits.length - 1]!.end > after.start - 1)) edits.push({ start: after.start - 1, end: after.start, text: ',' })
      else edits.push({ start: after.start, end: after.start, text: ',' })
    } else edits.push({ start: before.end, end: before.end, text: ',' })
  }
  return mergeEdits(edits)
}

/** Sorts edits and joins those that touch, so the editor never sees two at one place. */
function mergeEdits(edits: readonly OffsetEdit[]): OffsetEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: OffsetEdit[] = []
  for (const edit of sorted) {
    const last = merged[merged.length - 1]
    if (last && edit.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, edit.end), text: last.text + edit.text }
    } else merged.push(edit)
  }
  return merged
}

/** `text` with sorted, non-overlapping `edits` applied. */
export function applyOffsetEdits(text: string, edits: readonly OffsetEdit[]): string {
  let result = '', at = 0
  for (const edit of edits) { result += text.slice(at, edit.start) + edit.text; at = edit.end }
  return result + text.slice(at)
}

/** Where `offset` in the original text is after the edits: an offset inside a replaced span moves to its end, one at an insertion stays before it. */
export function mapOffset(edits: readonly OffsetEdit[], offset: number): number {
  let delta = 0
  for (const edit of edits) {
    if (edit.start >= offset) break
    if (edit.end > offset) return edit.start + delta + edit.text.length
    delta += edit.text.length - (edit.end - edit.start)
  }
  return offset + delta
}

/** The parts of a Monaco text model the transforms read. */
export interface SqlTransformModel {
  getValue(): string
  getValueLength(): number
  getOffsetAt(position: { readonly lineNumber: number; readonly column: number }): number
  getPositionAt(offset: number): { readonly lineNumber: number; readonly column: number }
}

/** The non-empty selections as offset ranges, or undefined when every selection is a caret. */
export function selectedRanges(model: SqlTransformModel, selections: readonly TextSelection[]): OffsetRange[] | undefined {
  const ranges = selections.map(selection => {
    const anchor = model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn })
    const caret = model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn })
    return { start: Math.min(anchor, caret), end: Math.max(anchor, caret) }
  }).filter(range => range.end > range.start)
  return ranges.length ? ranges : undefined
}

/** The model's text, or the size error when it holds more than a text operation changes. */
export function transformText(model: SqlTransformModel): string {
  if (model.getValueLength() > textOpLimits.characters) throw new Error(sqlTransformMessages.tooLarge)
  return model.getValue()
}

/** `edits` as a TextOp on `model`, with each selection moved along with the text it was on. */
export function sqlTransformOp(model: SqlTransformModel, text: string, edits: readonly OffsetEdit[], selections: readonly TextSelection[]): TextOp {
  const after = applyOffsetEdits(text, edits)
  const starts = lineStarts(after), lineOf = lineIndex(after, starts)
  const position = (offset: number) => { const line = lineOf(offset); return { lineNumber: line + 1, column: offset - starts[line]! + 1 } }
  const moved = (lineNumber: number, column: number) => position(mapOffset(edits, model.getOffsetAt({ lineNumber, column })))
  return {
    edits: edits.map(edit => {
      const start = model.getPositionAt(edit.start), end = model.getPositionAt(edit.end)
      return { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: edit.text }
    }),
    selections: selections.map(selection => {
      const anchor = moved(selection.selectionStartLineNumber, selection.selectionStartColumn), caret = moved(selection.positionLineNumber, selection.positionColumn)
      return { selectionStartLineNumber: anchor.lineNumber, selectionStartColumn: anchor.column, positionLineNumber: caret.lineNumber, positionColumn: caret.column }
    })
  }
}
