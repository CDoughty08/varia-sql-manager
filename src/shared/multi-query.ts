import type { ProviderId } from './providers.ts'
import { isSignificant, lexSql, type SqlToken } from './sql/lexer.ts'
import { scanGoogleSql, type GoogleSqlToken } from './googlesql/lexer.ts'

export const crossEngineMarkers = {
  sqlserver: '-- #Dialect="sqlserver"',
  bigquery: '-- #Dialect="bigquery"'
} as const

export type StatementCategory = 'select' | 'dml' | 'ddl' | 'transaction' | 'procedural' | 'admin' | 'other'

export interface ClassifiedStatement {
  readonly category: StatementCategory
  readonly keyword: string
  readonly line: number
  readonly batch: number
  readonly conditional: boolean
  readonly nonTransactional: boolean
  readonly permanentDdl: boolean
  readonly blocksBigQueryTransaction: boolean
}

export interface StatementClassification {
  readonly provider: ProviderId
  readonly batchCount: number
  readonly statements: readonly ClassifiedStatement[]
  readonly hasNonTransactionalTSql: boolean
  readonly hasBigQueryPermanentDdl: boolean
  readonly blocksBigQueryTransaction: boolean
  readonly firstBlockingStatement?: ClassifiedStatement
  readonly tags: readonly string[]
}

export type ParseCrossEngineResult =
  | { readonly ok: true; readonly sqlserver: string; readonly bigquery: string; readonly sqlServerStartLine: number; readonly bigQueryStartLine: number }
  | { readonly ok: false; readonly reason: string }

export interface ReadOnlyViolation {
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
  readonly keyword: string
  readonly message: string
}

interface TextLine {
  readonly line: number
  readonly start: number
  readonly contentEnd: number
  readonly nextStart: number
}

function splitTextLines(text: string): TextLine[] {
  const lines: TextLine[] = []
  let line = 1
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') {
      const eolLen = ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      lines.push({ line, start, contentEnd: i, nextStart: i + eolLen })
      line++
      i += eolLen
      start = i
    } else {
      i++
    }
  }
  lines.push({ line, start, contentEnd: text.length, nextStart: text.length })
  return lines
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) starts.push(i + 1)
  }
  return starts
}

function positionAt(starts: readonly number[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (starts[mid]! <= offset) low = mid + 1
    else high = mid - 1
  }
  const lineIdx = Math.max(0, high)
  return { line: lineIdx + 1, column: offset - starts[lineIdx]! + 1 }
}

function spanAt(starts: readonly number[], startOffset: number, endOffset: number): { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number } {
  const start = positionAt(starts, startOffset)
  const end = positionAt(starts, endOffset)
  return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column }
}

function isBlockCommentClosed(slice: string): boolean {
  let depth = 0
  let i = 0
  while (i < slice.length) {
    if (slice[i] === '/' && slice[i + 1] === '*') {
      depth++
      i += 2
    } else if (slice[i] === '*' && slice[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0 && i === slice.length) return true
    } else {
      i++
    }
  }
  return false
}

export function serializeCrossEngineSql(sqlserver: string, bigquery: string, eol: '\n' | '\r\n' = '\n'): string {
  return `${crossEngineMarkers.sqlserver}${eol}${sqlserver}${eol}${crossEngineMarkers.bigquery}${eol}${bigquery}`
}

const dialectDirectivePrefix = /^\uFEFF?\s*--\s*#Dialect\b/i
const dialectHeaderPattern = /^\uFEFF?\s*--\s*#Dialect\s*=\s*"([^"]*)"\s*$/i

type LineScanQuote = "'" | '"' | '`' | '[' | "'''" | '"""' | null

function scanLineForSectionState(
  lineText: string,
  dialect: ProviderId | 'preamble',
  state: { blockDepth: number; quote: LineScanQuote }
): void {
  let i = 0
  const n = lineText.length
  while (i < n) {
    const ch = lineText[i]!
    const next = lineText[i + 1]

    if (state.quote !== null) {
      if (state.quote === "'''" || state.quote === '"""') {
        const q = state.quote[0]!
        if (ch === '\\') { i += 2; continue }
        if (ch === q && next === q && lineText[i + 2] === q) {
          state.quote = null
          i += 3
          continue
        }
        i++
        continue
      }
      if (state.quote === '[') {
        if (ch === ']') {
          if (next === ']') { i += 2; continue }
          state.quote = null
        }
        i++
        continue
      }
      if (dialect === 'bigquery') {
        if (ch === '\\') { i += 2; continue }
        if (ch === state.quote) {
          state.quote = null
        }
        i++
        continue
      }
      // SQL Server / preamble: doubled delimiter escape ('' or "").
      if (ch === state.quote) {
        if (next === state.quote) { i += 2; continue }
        state.quote = null
      }
      i++
      continue
    }

    if (state.blockDepth > 0) {
      if (dialect !== 'bigquery' && ch === '/' && next === '*') {
        state.blockDepth++
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        state.blockDepth--
        i += 2
        continue
      }
      i++
      continue
    }

    // Outside quotes and block comments.
    if (ch === '-' && next === '-') return
    if (dialect === 'bigquery' && ch === '#') return
    if (ch === '/' && next === '*') {
      state.blockDepth = 1
      i += 2
      continue
    }
    if (dialect === 'bigquery') {
      if (ch === "'" || ch === '"') {
        if (next === ch && lineText[i + 2] === ch) {
          state.quote = ch === "'" ? "'''" : '"""'
          i += 3
          continue
        }
        state.quote = ch
        i++
        continue
      }
      if (ch === '`') {
        state.quote = '`'
        i++
        continue
      }
      i++
      continue
    }
    // SQL Server / preamble quotes & bracketed identifiers.
    if (ch === "'" || ch === '"' || ch === '[') {
      state.quote = ch
      i++
      continue
    }
    i++
  }
  // Single-line BigQuery quotes (not triple-quoted) cannot legally span newlines; reset so unclosed single-line quotes don't eat headers.
  if (dialect === 'bigquery' && (state.quote === "'" || state.quote === '"' || state.quote === '`')) {
    state.quote = null
  }
}

export function parseCrossEngineSql(text: string): ParseCrossEngineResult {
  const lines = splitTextLines(text)
  const headers: { readonly dialect: ProviderId; readonly lineInfo: TextLine }[] = []
  const scanState: { blockDepth: number; quote: LineScanQuote } = { blockDepth: 0, quote: null }
  let currentDialect: ProviderId | 'preamble' = 'preamble'

  for (const lineInfo of lines) {
    const lineText = text.slice(lineInfo.start, lineInfo.contentEnd)
    if (scanState.blockDepth === 0 && scanState.quote === null && dialectDirectivePrefix.test(lineText)) {
      const match = dialectHeaderPattern.exec(lineText)
      if (!match) return { ok: false, reason: `Malformed -- #Dialect header on line ${lineInfo.line}.` }
      const rawDialect = match[1]!.toLowerCase()
      if (rawDialect !== 'sqlserver' && rawDialect !== 'bigquery') {
        return { ok: false, reason: `Unsupported #Dialect "${match[1]}" on line ${lineInfo.line}.` }
      }
      if (headers.some(h => h.dialect === rawDialect)) {
        return { ok: false, reason: `Duplicate -- #Dialect="${rawDialect}" header on line ${lineInfo.line}.` }
      }
      headers.push({ dialect: rawDialect, lineInfo })
      currentDialect = rawDialect
      continue
    }
    scanLineForSectionState(lineText, currentDialect, scanState)
  }

  if (headers.length < 2) {
    return { ok: false, reason: 'Both -- #Dialect="sqlserver" and -- #Dialect="bigquery" headers are required.' }
  }

  const first = headers[0]!
  const second = headers[1]!
  const preamble = text.slice(0, first.lineInfo.start).replace(/^\uFEFF/, '')
  if (preamble.length > 0) {
    for (const token of lexSql(preamble)) {
      if (isSignificant(token)) {
        return { ok: false, reason: 'Non-comment SQL appears before the first -- #Dialect header.' }
      }
      if (token.kind === 'blockComment' && !isBlockCommentClosed(preamble.slice(token.start, token.end))) {
        return { ok: false, reason: 'Unterminated block comment before the first -- #Dialect header.' }
      }
    }
  }

  const firstStart = first.lineInfo.nextStart
  const prevBeforeSecond = lines[second.lineInfo.line - 2]!
  const firstEnd = Math.max(firstStart, prevBeforeSecond.contentEnd)
  const firstBody = text.slice(firstStart, firstEnd)
  const secondBody = text.slice(second.lineInfo.nextStart)

  if (first.dialect === 'sqlserver') {
    return {
      ok: true,
      sqlserver: firstBody,
      bigquery: secondBody,
      sqlServerStartLine: first.lineInfo.line + 1,
      bigQueryStartLine: second.lineInfo.line + 1
    }
  }
  return {
    ok: true,
    sqlserver: secondBody,
    bigquery: firstBody,
    sqlServerStartLine: second.lineInfo.line + 1,
    bigQueryStartLine: first.lineInfo.line + 1
  }
}

function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r')
}

interface GoLineInfo {
  readonly isGo: boolean
  readonly valid: boolean
  readonly repeatCount: number
  readonly lastLineTokenIndex: number
}

function inspectTSqlGoLine(sql: string, tokens: readonly SqlToken[], idx: number): GoLineInfo {
  const token = tokens[idx]!
  if (token.kind !== 'word' || sql.slice(token.start, token.end).toUpperCase() !== 'GO') {
    return { isGo: false, valid: false, repeatCount: 0, lastLineTokenIndex: idx }
  }
  // Check preceding tokens on the same line.
  for (let at = idx - 1; at >= 0; at--) {
    const prev = tokens[at]!
    if (prev.kind === 'newline') break
    if (prev.kind === 'blockComment') {
      if (hasLineBreak(sql.slice(prev.start, prev.end))) break
      continue
    }
    if (prev.kind !== 'space') return { isGo: false, valid: false, repeatCount: 0, lastLineTokenIndex: idx }
  }
  // Collect tokens after GO on the same line.
  const trailing: SqlToken[] = []
  let lastLineTokenIndex = idx
  for (let at = idx + 1; at < tokens.length; at++) {
    const next = tokens[at]!
    if (next.kind === 'newline') break
    if (next.kind === 'blockComment' && hasLineBreak(sql.slice(next.start, next.end))) break
    lastLineTokenIndex = at
    if (next.kind !== 'space' && next.kind !== 'lineComment' && next.kind !== 'blockComment') {
      trailing.push(next)
    }
  }
  if (trailing.length === 0) {
    return { isGo: true, valid: true, repeatCount: 1, lastLineTokenIndex }
  }
  if ((trailing[0]!.kind === 'colon' || trailing[0]!.kind === 'scope') && trailing[0]!.start === token.end) {
    // GO: (label) and GO::... (scope continuation) are not batch delimiters (GO : with a space stays invalid, matching SqlScript.cs).
    return { isGo: false, valid: false, repeatCount: 0, lastLineTokenIndex: idx }
  }
  if (trailing.length === 1 && trailing[0]!.kind === 'number') {
    const raw = sql.slice(trailing[0]!.start, trailing[0]!.end)
    if (/^[0-9]+$/.test(raw)) {
      const count = Number(raw)
      if (count >= 1 && count <= 1000) {
        return { isGo: true, valid: true, repeatCount: count, lastLineTokenIndex }
      }
    }
  }
  return { isGo: true, valid: false, repeatCount: 0, lastLineTokenIndex }
}

interface TSqlSigToken {
  readonly token: SqlToken
  readonly text: string
  readonly upper: string
  readonly line: number
}

interface TSqlBatch {
  readonly tokens: readonly TSqlSigToken[]
  readonly goCount: number
  readonly goToken?: SqlToken
  readonly goRepeatToken?: SqlToken
  readonly goValid: boolean
  readonly invalidGoTrailingTokens?: readonly TSqlSigToken[]
}

function splitTSqlBatches(sql: string, tokens: readonly SqlToken[], starts: readonly number[]): TSqlBatch[] {
  const batches: TSqlBatch[] = []
  let current: TSqlSigToken[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const tokLine = positionAt(starts, token.start).line
    if (token.kind === 'word' && sql.slice(token.start, token.end).toUpperCase() === 'GO') {
      const go = inspectTSqlGoLine(sql, tokens, i)
      if (go.isGo) {
        let repeatToken: SqlToken | undefined
        const trailing: TSqlSigToken[] = []
        for (let j = i + 1; j <= go.lastLineTokenIndex; j++) {
          const candidate = tokens[j]!
          if (isSignificant(candidate)) {
            if (!repeatToken) repeatToken = candidate
            if (!go.valid) {
              const candText = sql.slice(candidate.start, candidate.end)
              trailing.push({
                token: candidate,
                text: candText,
                upper: candidate.kind === 'word' ? candText.toUpperCase() : '',
                line: positionAt(starts, candidate.start).line
              })
            }
          }
        }
        batches.push({
          tokens: current,
          goCount: go.repeatCount,
          goToken: token,
          goRepeatToken: repeatToken,
          goValid: go.valid,
          ...(trailing.length > 0 ? { invalidGoTrailingTokens: trailing } : {})
        })
        current = []
        i = go.lastLineTokenIndex
        continue
      }
    }
    if (token.kind === 'sqlcmd') {
      current.push({ token, text: sql.slice(token.start, token.end), upper: '', line: tokLine })
      continue
    }
    if (isSignificant(token)) {
      const text = sql.slice(token.start, token.end)
      current.push({
        token,
        text,
        upper: token.kind === 'word' ? text.toUpperCase() : '',
        line: tokLine
      })
    }
  }
  if (current.length > 0 || batches.length === 0) {
    batches.push({ tokens: current, goCount: 1, goValid: true })
  }
  return batches
}

export function hasExecutableSql(sql: string, dialect: ProviderId): boolean {
  if (dialect === 'bigquery') {
    for (const token of scanGoogleSql(sql)) {
      if (token.kind === 'whitespace' || token.kind === 'comment') continue
      if (token.kind === 'punctuation' && sql[token.start] === ';') continue
      return true
    }
    return false
  }
  const tokens = lexSql(sql)
  const starts = lineStarts(sql)
  const batches = splitTSqlBatches(sql, tokens, starts)
  for (const batch of batches) {
    if (batch.tokens.some(t => t.token.kind !== 'semicolon') || !batch.goValid || batch.goCount > 1 || (batch.invalidGoTrailingTokens?.length ?? 0) > 0) return true
  }
  return false
}

const tsqlStatementStarters = new Set([
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'RECEIVE', 'BULK',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'ENABLE', 'DISABLE',
  'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END',
  'COMMIT', 'ROLLBACK', 'SAVE', 'THROW', 'RAISERROR', 'PRINT', 'RETURN',
  'WAITFOR', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'BREAK', 'CONTINUE', 'GOTO', 'LINENO',
  'BACKUP', 'RESTORE', 'RECONFIGURE', 'DBCC', 'SHUTDOWN', 'KILL',
  'USE', 'GRANT', 'REVOKE', 'DENY', 'CHECKPOINT', 'SETUSER', 'REVERT', 'SEND',
  'WRITETEXT', 'UPDATETEXT', 'READTEXT', 'ADD', 'MOVE', 'GET'
])

const tsqlNonTransactionalAdmin = new Set(['BACKUP', 'RESTORE', 'RECONFIGURE', 'DBCC', 'SHUTDOWN', 'KILL'])
const tsqlAdmin = new Set(['USE', 'GRANT', 'REVOKE', 'DENY', 'CHECKPOINT', 'SETUSER', 'REVERT', 'SEND', 'WRITETEXT', 'UPDATETEXT', 'READTEXT'])
const tsqlConditionContinuationPrev = new Set([
  'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'ALL', 'ANY', 'SOME', 'LIKE', 'BETWEEN', 'IS', 'FROM',
  'WHEN', 'THEN', 'ELSE', 'CASE', 'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'COALESCE', 'NULLIF', 'IIF', 'CHOOSE'
])
const tsqlSessionSetOptions = new Set([
  'XACT_ABORT', 'NOCOUNT', 'ANSI_NULLS', 'ANSI_PADDING', 'ANSI_WARNINGS', 'ANSI_DEFAULTS',
  'ANSI_NULL_DFLT_ON', 'ANSI_NULL_DFLT_OFF', 'CURSOR_CLOSE_ON_COMMIT', 'REMOTE_PROC_TRANSACTIONS',
  'FIPS_FLAGGER', 'OFFSETS', 'DISABLE_DEF_CNST_CHK',
  'QUOTED_IDENTIFIER', 'ARITHABORT', 'ARITHIGNORE', 'CONCAT_NULL_YIELDS_NULL', 'NUMERIC_ROUNDABORT',
  'TRANSACTION', 'LOCK_TIMEOUT', 'DEADLOCK_PRIORITY', 'QUERY_GOVERNOR_COST_LIMIT', 'ROWCOUNT',
  'DATEFIRST', 'DATEFORMAT', 'LANGUAGE', 'IMPLICIT_TRANSACTIONS', 'STATISTICS', 'SHOWPLAN_ALL',
  'SHOWPLAN_TEXT', 'SHOWPLAN_XML', 'NOEXEC', 'PARSEONLY', 'FMTONLY', 'FORCEPLAN', 'IDENTITY_INSERT',
  'CONTEXT_INFO', 'TEXTSIZE'
])
const tsqlDdlWithOptions = new Set([
  'CHECK', 'NOCHECK', 'VALUES', 'SCHEMABINDING', 'ENCRYPTION', 'VIEW_METADATA', 'EXECUTE',
  'RECOMPILE', 'NATIVE_COMPILATION', 'PASSWORD', 'DEFAULT_DATABASE', 'DEFAULT_LANGUAGE',
  'CHECK_EXPIRATION', 'CHECK_POLICY', 'LOGIN', 'SID', 'SIGNATURE', 'CERTIFICATE', 'ASYMMETRIC',
  'SYMMETRIC', 'RECOVERY', 'NORECOVERY', 'STANDBY', 'REPLACE', 'MOVE', 'STATS', 'COMPRESSION',
  'NO_COMPRESSION', 'FORMAT', 'INIT', 'NOINIT', 'COPY_ONLY', 'DIFFERENTIAL', 'NO', 'GRANT', 'ADMIN', 'OPTION',
  'ROLLBACK', 'OVERRIDE', 'NO_INFOMSGS', 'MARK', 'IDENTITY',
  'FULLSCAN', 'SAMPLE', 'RESAMPLE', 'NORECOMPUTE',
  'NOWAIT', 'LOG', 'SETERROR', 'NO_WAIT', 'ALL_ERRORMSGS', 'NOFORMAT', 'DEFAULT_SCHEMA', 'NAME',
  'CLEANUP', 'ERROR', 'LIFETIME', 'TABLERESULTS', 'PHYSICAL_ONLY', 'DATA_PURITY', 'EXTENDED_LOGICAL_CHECKS', 'ESTIMATEONLY',
  'RESULT', 'CHANGE_TRACKING'
])
const tsqlAlterDropTargets = new Set(['COLUMN', 'CONSTRAINT', 'PERIOD', 'MEMBER', 'FILE', 'EVENT', 'TARGET', 'FILTER', 'BLOCK', 'ENCRYPTION', 'VALUE'])
const tsqlNonReservedStarters = new Set(['ENABLE', 'DISABLE', 'SEND', 'RECEIVE', 'THROW', 'ADD', 'MOVE', 'GET'])
const tsqlDclPermissions = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXEC', 'EXECUTE', 'CREATE', 'ALTER', 'BACKUP',
  'SHUTDOWN', 'CHECKPOINT', 'RECEIVE', 'SEND', 'GRANT', 'OPEN', 'CLOSE', 'KILL', 'BULK'
])
const tsqlProcedural = new Set(['DECLARE', 'SET', 'EXEC', 'EXECUTE', 'WAITFOR', 'THROW', 'RAISERROR', 'PRINT', 'RETURN', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'BREAK', 'CONTINUE', 'GOTO', 'LINENO'])

function isTSqlDatabaseScoped(words: readonly string[]): boolean {
  const [, w1, w2, w3] = words
  return w1 === 'DATABASE' && w2 === 'SCOPED' && (w3 === 'CONFIGURATION' || w3 === 'CREDENTIAL')
}

function isTSqlDatabaseAuditSpec(words: readonly string[]): boolean {
  const [, w1, w2, w3] = words
  return w1 === 'DATABASE' && w2 === 'AUDIT' && w3 === 'SPECIFICATION'
}

function isTSqlNonTransactionalDdl(words: readonly string[]): boolean {
  const [w0, w1, w2, w3] = words
  if (w0 !== 'CREATE' && w0 !== 'ALTER' && w0 !== 'DROP') return false
  if (w1 === 'DATABASE' && !isTSqlDatabaseScoped(words)) return true
  if (w0 === 'ALTER' && w1 === 'SERVER' && w2 === 'CONFIGURATION') return true
  if (w0 === 'ALTER' && w1 === 'RESOURCE' && w2 === 'GOVERNOR') return true
  if (w1 === 'SERVER' && w2 === 'AUDIT') return true
  if (w1 === 'ENDPOINT') return true
  if (w1 === 'AVAILABILITY' && w2 === 'GROUP') return true
  if (w1 === 'FULLTEXT' && (w2 === 'CATALOG' || w2 === 'INDEX' || w2 === 'STOPLIST')) return true
  if (w1 === 'RESOURCE' && w2 === 'POOL') return true
  if (w1 === 'EXTERNAL' && w2 === 'RESOURCE' && w3 === 'POOL') return true
  if (w1 === 'WORKLOAD' && w2 === 'GROUP') return true
  return false
}

function classifyTSql(sql: string): StatementClassification {
  const tokens = lexSql(sql)
  const starts = lineStarts(sql)
  const rawBatches = splitTSqlBatches(sql, tokens, starts)
  const nonEmptyBatches = rawBatches.filter(b => b.tokens.some(t => t.token.kind !== 'semicolon') || (b.invalidGoTrailingTokens?.length ?? 0) > 0)
  const statements: ClassifiedStatement[] = []

  for (let bIdx = 0; bIdx < nonEmptyBatches.length; bIdx++) {
    const batchObj = nonEmptyBatches[bIdx]!
    const batchNum = bIdx + 1
    const batchChunks: readonly (readonly TSqlSigToken[])[] = batchObj.invalidGoTrailingTokens
      ? [batchObj.tokens, batchObj.invalidGoTrailingTokens]
      : [batchObj.tokens]
    for (const batch of batchChunks) {
    if (!batch.some(t => t.token.kind !== 'semicolon')) continue
    const blockStack: { readonly kind: 'begin' | 'try' | 'catch'; readonly conditional: boolean }[] = []
    let conditionalDepth = 0
    let pendingConditional = false
    let i = 0

    const isConditionalNow = () => pendingConditional || conditionalDepth > 0
    const pushBlock = (kind: 'begin' | 'try' | 'catch', conditional: boolean) => {
      blockStack.push({ kind, conditional })
      if (conditional) conditionalDepth++
    }
    const popBlock = () => {
      const popped = blockStack.pop()
      if (popped?.conditional) conditionalDepth--
    }

    const commaFromCache: CommaFromCache = { end: -1, hasFrom: false }
    let batchMatchingClose: Int32Array | null = null
    const getBatchMatchingClose = () => (batchMatchingClose ??= buildMatchingClose(batch))

    const isNonReservedStarterBoundary = (
      idx: number,
      prevUpper: string,
      prev2Upper: string,
      prevTok: TSqlSigToken | undefined,
      inFromClause = false,
      inCondition = false
    ): boolean => {
      const cur = batch[idx]!
      const next = batch[idx + 1]
      const next2 = batch[idx + 2]
      if (cur.upper === 'ENABLE' || cur.upper === 'DISABLE') {
        return next?.token.kind === 'word' && next.upper === 'TRIGGER'
      }
      if (cur.upper === 'SEND') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        return boundary
          && next?.token.kind === 'word' && next.upper === 'ON'
          && next2?.token.kind === 'word' && next2.upper === 'CONVERSATION'
          && isSendConversationHandle(batch, idx)
      }
      if (cur.upper === 'RECEIVE') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        return boundary && !isReceiveAliasFollower(batch, idx, prevTok?.token.kind, prevUpper, inFromClause, commaFromCache, getBatchMatchingClose)
      }
      if (cur.upper === 'THROW') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        return boundary && (
          (next !== undefined && (next.token.kind === 'number' || next.token.kind === 'variable'))
          || (inCondition && (next === undefined || next.token.kind === 'semicolon'
            || (next.token.kind === 'word' && (next.upper === 'END' || next.upper === 'ELSE'))))
        )
      }
      if (cur.upper === 'MOVE') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        return boundary && next?.token.kind === 'word' && next.upper === 'CONVERSATION'
      }
      if (cur.upper === 'GET') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        return boundary
          && next?.token.kind === 'word' && next.upper === 'CONVERSATION'
          && next2?.token.kind === 'word' && next2.upper === 'GROUP'
      }
      if (cur.upper === 'ADD') {
        const boundary = isTSqlStmtBoundary(prevTok, prevUpper, prev2Upper)
        const next3 = batch[idx + 3]
        return boundary && next?.token.kind === 'word' && (
          (next.upper === 'SIGNATURE' && next2?.token.kind === 'word' && next2.upper === 'TO')
          || (next.upper === 'COUNTER' && next2?.token.kind === 'word' && next2.upper === 'SIGNATURE' && next3?.token.kind === 'word' && next3.upper === 'TO')
          || (next.upper === 'SENSITIVITY' && next2?.token.kind === 'word' && next2.upper === 'CLASSIFICATION' && next3?.token.kind === 'word' && next3.upper === 'TO')
        )
      }
      return true
    }

    const consumeCondition = () => {
      let depth = 0
      let caseDepth = 0
      let sawCondToken = false
      let prevUpper = ''
      let prev2Upper = ''
      let prevTok: TSqlSigToken | undefined
      while (i < batch.length) {
        const cur = batch[i]!
        const prevKind = prevTok?.token.kind
        const afterDot = prevKind === 'dot'
        if (cur.token.kind === 'open') {
          if (depth === 0 && caseDepth === 0 && sawCondToken
            && !isTSqlInfixOrPrefixOperator(prevTok) && prevKind !== 'comma' && prevKind !== 'open'
            && (!tsqlConditionContinuationPrev.has(prevUpper) || (prevUpper === 'ALL' && prev2Upper === 'SYSTEM_TIME'))) {
            let peek = i + 1
            while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
            if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT'
              && !isScalarFuncSubqueryOpen(batch, i, peek, getBatchMatchingClose, false, false)) break
          }
          depth++
        } else if (cur.token.kind === 'close') {
          if (depth > 0) depth--
        } else if (depth === 0) {
          if (cur.token.kind === 'semicolon' || cur.token.kind === 'sqlcmd') break
          if (cur.token.kind === 'word' && !afterDot) {
            if (cur.upper === 'CASE') {
              caseDepth++
              sawCondToken = true
              prev2Upper = prevUpper
              prevUpper = cur.upper
              prevTok = cur
              i++
              continue
            }
            if (cur.upper === 'END' && caseDepth > 0) {
              caseDepth--
              sawCondToken = true
              prev2Upper = prevUpper
              prevUpper = cur.upper
              prevTok = cur
              i++
              continue
            }
            if (cur.upper === 'ELSE' && caseDepth > 0) {
              sawCondToken = true
              prev2Upper = prevUpper
              prevUpper = cur.upper
              prevTok = cur
              i++
              continue
            }
            if (caseDepth === 0 && tsqlStatementStarters.has(cur.upper)
              && isNonReservedStarterBoundary(i, prevUpper, prev2Upper, prevTok, false, true)) break
          }
        }
        sawCondToken = true
        prev2Upper = prevUpper
        prevUpper = cur.token.kind === 'word' && !afterDot ? cur.upper : ''
        prevTok = cur
        i++
      }
    }

    const consumeSelect = (): boolean => {
      let depth = 0
      let targetDepth = 0
      while (i < batch.length && batch[i]!.token.kind === 'open') {
        depth++
        targetDepth++
        i++
      }
      let caseDepth = 0
      let prevUpper = ''
      let prev2Upper = ''
      let justStarted = true
      let offsetSeen = false
      let seenOrderBy = false
      let inFromClause = false
      let seenClauseAfterSelectList = false
      let awaitingTop = false
      let topConsumedValue = false
      let topParenDepth: number | null = null
      let justEndedTop = false
      let hasInto = false
      while (i < batch.length) {
        const cur = batch[i]!
        const prevTok = i > 0 ? batch[i - 1] : undefined
        const prevKind = prevTok?.token.kind
        const next = i + 1 < batch.length ? batch[i + 1] : undefined
        const afterDot = prevKind === 'dot'
        const wasJustEndedTop = justEndedTop
        justEndedTop = false
        if (cur.token.kind === 'open') {
          let consumedTopOpen = false
          if (depth === targetDepth && awaitingTop) {
            if (!topConsumedValue) {
              topParenDepth = depth + 1
              consumedTopOpen = true
            } else {
              // First select-list item after TOP <n> / TOP (<n>) [PERCENT] [WITH TIES] is a parenthesized expression/subquery.
              awaitingTop = false
              if (!hasSelectIntoInParens(batch, i, getBatchMatchingClose)) consumedTopOpen = true
            }
          }
          if (!consumedTopOpen && depth === 0 && !justStarted && caseDepth === 0
            && !isTSqlInfixOrPrefixOperator(prevTok) && prevKind !== 'comma' && prevKind !== 'open'
            && !isTSqlSubqueryContinuation(batch, i, prevUpper, prev2Upper, seenOrderBy, getBatchMatchingClose)) {
            let peek = i + 1
            while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
            if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT'
              && !isScalarFuncSubqueryOpen(batch, i, peek, getBatchMatchingClose, inFromClause, wasJustEndedTop)) break
          }
          depth++
        } else if (cur.token.kind === 'close') {
          if (topParenDepth !== null && depth === topParenDepth) {
            topParenDepth = null
            topConsumedValue = true
          }
          if (depth > 0) depth--
          if (depth < targetDepth) targetDepth = depth
        } else if (depth === targetDepth && cur.token.kind === 'word' && !afterDot) {
          if (awaitingTop) {
            if (topConsumedValue && (cur.upper === 'PERCENT' || cur.upper === 'WITH' || cur.upper === 'TIES')) {
              // Still inside TOP <n> [PERCENT] [WITH TIES].
            } else {
              awaitingTop = false
              if (topConsumedValue) justEndedTop = true
            }
          }
          if (cur.upper === 'CASE') {
            caseDepth++
          } else if (cur.upper === 'END' && caseDepth > 0) {
            caseDepth--
          } else if (cur.upper === 'ELSE' && caseDepth > 0) {
            // ELSE inside CASE expression.
          } else if (caseDepth === 0) {
            if (cur.upper === 'TOP' && !seenClauseAfterSelectList && (prevUpper === 'SELECT' || prevUpper === 'ALL' || prevUpper === 'DISTINCT')) {
              awaitingTop = true
              topConsumedValue = false
              topParenDepth = null
            } else if (cur.upper === 'INTO' && !seenClauseAfterSelectList && prevUpper !== 'AS') {
              hasInto = true
            } else if (cur.upper === 'FROM' || cur.upper === 'WHERE' || (cur.upper === 'GROUP' && prevUpper !== 'WITHIN') || cur.upper === 'HAVING' || cur.upper === 'ORDER') {
              if (cur.upper === 'FROM') {
                if (prevUpper !== 'DISTINCT') {
                  seenClauseAfterSelectList = true
                  inFromClause = true
                }
              } else {
                seenClauseAfterSelectList = true
                inFromClause = false
              }
              if (cur.upper === 'ORDER' && next?.upper === 'BY') seenOrderBy = true
            } else if (cur.upper === 'OFFSET' && seenOrderBy
              && prevKind !== 'comma' && !isTSqlInfixOrPrefixOperator(prevTok) && prevUpper !== 'BY' && prevUpper !== 'AS' && prevUpper !== 'SELECT') {
              offsetSeen = true
              inFromClause = false
            } else if (cur.upper === 'UNION' || cur.upper === 'EXCEPT' || cur.upper === 'INTERSECT') {
              seenClauseAfterSelectList = false
              offsetSeen = false
              seenOrderBy = false
              inFromClause = false
              awaitingTop = false
            } else if ((cur.upper === 'FOR' && next?.upper !== 'SYSTEM_TIME') || cur.upper === 'OPTION' || (cur.upper === 'WINDOW' && isIdentToken(next) && batch[i + 2]?.upper === 'AS' && batch[i + 3]?.token.kind === 'open')) {
              inFromClause = false
            }
            if (depth === 0 && !justStarted) {
              if (cur.upper === 'SELECT' && prevUpper !== 'UNION' && prevUpper !== 'EXCEPT' && prevUpper !== 'INTERSECT' && !(prevUpper === 'ALL' && prev2Upper === 'UNION')) break
              if (cur.upper === 'FETCH' && offsetSeen && (prevUpper === 'ROW' || prevUpper === 'ROWS') && isTSqlPagingFetch(batch, i, getBatchMatchingClose)) {
                offsetSeen = false
              } else if (cur.upper === 'WITH' && (next?.token.kind === 'open' || next?.upper === 'TIES' || next?.upper === 'CUBE' || next?.upper === 'ROLLUP')) {
                // Table hint WITH (NOLOCK), TOP ... WITH TIES, GROUP BY ... WITH CUBE/ROLLUP.
              } else if (cur.upper === 'MERGE' && isTSqlMergeJoinHint(prevUpper, next)) {
                // Join hint: INNER/LEFT/RIGHT/FULL/OUTER MERGE JOIN.
              } else if (justEndedTop && (cur.upper === 'RECEIVE' || cur.upper === 'SEND' || cur.upper === 'THROW'
                || cur.upper === 'ADD' || cur.upper === 'MOVE' || cur.upper === 'GET')) {
                // First select-list item after `TOP ...` (e.g. `SELECT TOP 1 receive + 1 FROM ...`, `SELECT TOP 1 move conversation FROM ...`).
              } else if (cur.upper !== 'SELECT' && tsqlStatementStarters.has(cur.upper)
                && isNonReservedStarterBoundary(i, prevUpper, prev2Upper, prevTok, inFromClause)) {
                break
              }
            }
          }
        } else if (depth === targetDepth && awaitingTop) {
          if (!topConsumedValue && cur.token.kind === 'number') {
            topConsumedValue = true
          } else {
            awaitingTop = false
          }
          if (depth === 0) {
            if (cur.token.kind === 'semicolon') { i++; break }
            if (cur.token.kind === 'sqlcmd') break
          }
        } else if (depth === 0) {
          if (cur.token.kind === 'semicolon') { i++; break }
          if (cur.token.kind === 'sqlcmd') break
        }
        prev2Upper = prevUpper
        prevUpper = cur.token.kind === 'word' && !afterDot ? cur.upper : ''
        justStarted = false
        i++
      }
      return hasInto
    }

    const consumeUntilNextStatement = (
      mode: 'insert' | 'update' | 'dml' | 'view' | 'ddl' | 'alterDdl' | 'alterDb' | 'dcl' | 'declare' | 'set' | 'merge' | 'generic',
      allowReferentialAction = false
    ) => {
      const stmtStart = i
      const isCursorMode = mode === 'declare' || mode === 'set'
      const isDdlMode = mode === 'ddl' || mode === 'alterDdl' || mode === 'alterDb'
      const isSendStmt = mode === 'generic' && batch[stmtStart]?.upper === 'SEND'
      const isConvTimerStmt = mode === 'generic' && batch[stmtStart]?.upper === 'CONVERSATION' && batch[stmtStart + 1]?.upper === 'TIMER'
      const isEndConvStmt = mode === 'generic' && batch[stmtStart]?.upper === 'END' && batch[stmtStart + 1]?.upper === 'CONVERSATION'
      const isMoveConvStmt = mode === 'generic' && batch[stmtStart]?.upper === 'MOVE' && batch[stmtStart + 1]?.upper === 'CONVERSATION'
      const isCteColumnList = (openIdx: number): boolean => {
        if (batch[openIdx]?.token.kind !== 'open') return false
        const closeIdx = getBatchMatchingClose()[openIdx]
        return closeIdx !== undefined && closeIdx >= 0
          && batch[closeIdx + 1]?.upper === 'AS'
          && batch[closeIdx + 2]?.token.kind === 'open'
      }
      let depth = 0
      let caseDepth = 0
      let prevUpper = ''
      let prev2Upper = ''
      let justStarted = true
      let offsetSeen = false
      let seenOrderBy = false
      let inFromClause = false
      let seenValuesOrDefault = false
      let seenInsertSource = false
      let seenInsertExec = false
      let seenUpdateSet = false
      let seenUpdateStatistics = false
      let seenDclPrincipal = false
      let seenCursor = false
      let seenCursorSelect = false
      let seenSetOffsets = false
      let seenSetOffsetsEnd = false
      let seenSendMessageType = false
      let seenViewAs = false
      let seenViewWithCte = false
      let seenViewSelect = false
      let awaitingTop = false
      let topConsumedValue = false
      let topParenDepth: number | null = null
      let justEndedTop = false
      while (i < batch.length) {
        const cur = batch[i]!
        const prevTok = i > 0 ? batch[i - 1] : undefined
        const prevKind = prevTok?.token.kind
        const next = i + 1 < batch.length ? batch[i + 1] : undefined
        const afterDot = prevKind === 'dot'
        const wasJustEndedTop = justEndedTop
        justEndedTop = false
        if (cur.token.kind === 'open') {
          let consumedTopOpen = false
          if (depth === 0 && awaitingTop) {
            if (!topConsumedValue) {
              topParenDepth = 1
              consumedTopOpen = true
            } else {
              awaitingTop = false
              if (!hasSelectIntoInParens(batch, i, getBatchMatchingClose)) consumedTopOpen = true
            }
          }
          if (!consumedTopOpen && depth === 0 && !justStarted && caseDepth === 0) {
            if (mode === 'insert' && !seenValuesOrDefault && !seenInsertSource && prevUpper !== 'TOP') {
              let peek = i + 1
              while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
              if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT') seenInsertSource = true
            } else if (isCursorMode && seenCursor && !seenCursorSelect && prevUpper === 'FOR') {
              let peek = i + 1
              while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
              if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT') seenCursorSelect = true
            } else if (mode === 'view' && seenViewAs && !seenViewSelect
              && ((!seenViewWithCte && prevUpper === 'AS') || (seenViewWithCte && prevKind === 'close'))) {
              let peek = i + 1
              while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
              if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT') seenViewSelect = true
            } else if (mode !== 'merge'
              && prevUpper !== 'RETURN' && prevUpper !== 'PRINT' && prevUpper !== 'RAISERROR'
              && !(mode === 'dml' && prevUpper === 'RECEIVE' && !hasSelectIntoInParens(batch, i, getBatchMatchingClose))
              && !(((isSendStmt && prevUpper === 'CONVERSATION')
                || (isConvTimerStmt && prevUpper === 'TIMER')
                || (isEndConvStmt && prevUpper === 'CONVERSATION')
                || (isMoveConvStmt && (prevUpper === 'CONVERSATION' || prevUpper === 'TO'))
                || (isSendStmt && seenSendMessageType && batch[i + 1]?.token.kind === 'open'))
                && !hasSelectIntoInParens(batch, i, getBatchMatchingClose))
              && !isTSqlInfixOrPrefixOperator(prevTok) && prevKind !== 'comma' && prevKind !== 'open') {
              const prevIsOptionValue = (prevUpper === 'ON' && !inFromClause
                && ((mode === 'set' && !seenCursorSelect) || mode === 'alterDb' || batch[i - 2]?.text === '=' || (mode === 'alterDdl' && prev2Upper === 'LOG')))
                || (prevUpper === 'ALL' && (seenUpdateStatistics || (isDdlMode && batch[i - 2]?.text === '=')))
              if (!isTSqlSubqueryContinuation(batch, i, prevIsOptionValue ? '' : prevUpper, prev2Upper, seenOrderBy, getBatchMatchingClose)) {
                let peek = i + 1
                while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
                if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT'
                  && !((mode === 'ddl' || mode === 'alterDdl') && prevUpper === 'ADD' && batch[peek + 1]?.upper === 'ON')
                  && !isScalarFuncSubqueryOpen(batch, i, peek, getBatchMatchingClose, inFromClause, wasJustEndedTop)) break
              }
            }
          }
          depth++
        } else if (cur.token.kind === 'close') {
          if (topParenDepth !== null && depth === topParenDepth) {
            topParenDepth = null
            topConsumedValue = true
          }
          if (depth > 0) depth--
        } else if (depth === 0) {
          if (cur.token.kind === 'semicolon') { i++; break }
          if (cur.token.kind === 'sqlcmd') break
          if (cur.token.kind === 'word' && !afterDot) {
            if (awaitingTop) {
              if (topConsumedValue && (cur.upper === 'PERCENT' || cur.upper === 'WITH' || cur.upper === 'TIES')) {
                // Still inside TOP <n> [PERCENT] [WITH TIES].
              } else {
                awaitingTop = false
                if (topConsumedValue) justEndedTop = true
              }
            }
            if (cur.upper === 'CASE') {
              caseDepth++
            } else if (cur.upper === 'END' && caseDepth > 0) {
              caseDepth--
            } else if (cur.upper === 'ELSE' && caseDepth > 0) {
              // ELSE inside CASE expression.
            } else if (caseDepth === 0) {
              if (cur.upper === 'TOP' && ((mode === 'insert' && seenInsertSource) || (isCursorMode && seenCursorSelect) || (mode === 'view' && seenViewSelect))
                && (prevUpper === 'SELECT' || prevUpper === 'ALL' || prevUpper === 'DISTINCT')) {
                awaitingTop = true
                topConsumedValue = false
                topParenDepth = null
              }
              if (cur.upper === 'FROM' && prevUpper !== 'DISTINCT') inFromClause = true
              else if (cur.upper === 'WHERE' || (cur.upper === 'GROUP' && prevUpper !== 'WITHIN') || cur.upper === 'HAVING' || cur.upper === 'ORDER' || cur.upper === 'UNION' || cur.upper === 'EXCEPT' || cur.upper === 'INTERSECT' || (cur.upper === 'FOR' && next?.upper !== 'SYSTEM_TIME') || cur.upper === 'OPTION') {
                inFromClause = false
                if (cur.upper === 'UNION' || cur.upper === 'EXCEPT' || cur.upper === 'INTERSECT') awaitingTop = false
              }
              if (cur.upper === 'ORDER' && next?.upper === 'BY') seenOrderBy = true
              if (cur.upper === 'OFFSET' && seenOrderBy
                && prevKind !== 'comma' && !isTSqlInfixOrPrefixOperator(prevTok) && prevUpper !== 'BY' && prevUpper !== 'AS' && prevUpper !== 'SELECT') {
                offsetSeen = true
              }
              if (mode === 'insert' && (cur.upper === 'VALUES' || cur.upper === 'DEFAULT')) seenValuesOrDefault = true
              if (mode === 'update' && prevUpper === 'UPDATE' && cur.upper === 'STATISTICS') seenUpdateStatistics = true
              if (mode === 'dcl' && (cur.upper === 'TO' || cur.upper === 'FROM')) seenDclPrincipal = true
              if (cur.upper === 'CURSOR' && (mode === 'declare'
                || (mode === 'set' && batch[stmtStart + 1]?.token.kind === 'variable' && batch[stmtStart + 2]?.text === '='))) {
                seenCursor = true
              }
              if (mode === 'set' && i === stmtStart + 1 && cur.upper === 'OFFSETS') seenSetOffsets = true
              if (seenSetOffsets && (cur.upper === 'ON' || cur.upper === 'OFF')) seenSetOffsetsEnd = true
              if (isSendStmt && cur.upper === 'TYPE' && prevUpper === 'MESSAGE') seenSendMessageType = true
              if (mode === 'view' && !seenViewAs && cur.upper === 'AS') seenViewAs = true
              const prevIsOptionValue = (prevUpper === 'ON' && !inFromClause
                && ((mode === 'set' && !seenCursorSelect) || mode === 'alterDb' || batch[i - 2]?.text === '=' || (mode === 'alterDdl' && prev2Upper === 'LOG')))
                || (prevUpper === 'ALL' && (seenUpdateStatistics || (isDdlMode && batch[i - 2]?.text === '=')))
              if (!justStarted && tsqlStatementStarters.has(cur.upper)
                && isNonReservedStarterBoundary(i, prevIsOptionValue ? '' : prevUpper, prev2Upper, prevTok, inFromClause)) {
                const isDdl = mode === 'ddl' || mode === 'alterDdl' || mode === 'alterDb'
                const isAlter = mode === 'alterDdl' || mode === 'alterDb'
                if (cur.upper === 'MERGE' && isTSqlMergeJoinHint(prevUpper, next)) {
                  // Join hint: INNER/LEFT/RIGHT/FULL/OUTER MERGE JOIN.
                } else if (justEndedTop && (cur.upper === 'RECEIVE' || cur.upper === 'SEND' || cur.upper === 'THROW'
                  || cur.upper === 'ADD' || cur.upper === 'MOVE' || cur.upper === 'GET')) {
                  // First select-list item after TOP ... inside embedded SELECT.
                } else if (seenSetOffsets && !seenSetOffsetsEnd && (cur.upper === 'SELECT' || cur.upper === 'EXECUTE')) {
                  // SET OFFSETS select, execute ON|OFF.
                } else if (cur.upper === 'FETCH' && offsetSeen && (prevUpper === 'ROW' || prevUpper === 'ROWS') && isTSqlPagingFetch(batch, i, getBatchMatchingClose)) {
                  offsetSeen = false
                } else if (isCursorMode && seenCursor && cur.upper === 'SELECT' && ((!seenCursorSelect && prevUpper === 'FOR') || (seenCursorSelect && (prevUpper === 'UNION' || (prevUpper === 'ALL' && prev2Upper === 'UNION') || prevUpper === 'EXCEPT' || prevUpper === 'INTERSECT')))) {
                  // DECLARE/SET cur CURSOR FOR SELECT ... [UNION ... SELECT ...]
                  seenCursorSelect = true
                } else if (isCursorMode && seenCursorSelect && cur.upper === 'UPDATE' && prevUpper === 'FOR') {
                  // DECLARE/SET cur CURSOR FOR SELECT ... FOR UPDATE [OF col1, ...].
                } else if (isCursorMode && seenCursorSelect && cur.upper === 'WITH' && (next?.token.kind === 'open' || next?.upper === 'TIES' || next?.upper === 'CUBE' || next?.upper === 'ROLLUP')) {
                  // Table/TOP/GROUP hint inside DECLARE/SET CURSOR SELECT.
                } else if (mode === 'dcl' && !seenDclPrincipal && tsqlDclPermissions.has(cur.upper)) {
                  // Permission name inside GRANT/REVOKE/DENY before TO/FROM.
                } else if (mode === 'dcl' && seenDclPrincipal && cur.upper === 'WITH' && next?.upper === 'GRANT') {
                  // GRANT ... TO [role] WITH GRANT OPTION.
                } else if (mode === 'dcl' && seenDclPrincipal && cur.upper === 'GRANT' && prevUpper === 'WITH' && next?.upper === 'OPTION') {
                  // WITH GRANT OPTION.
                } else if (allowReferentialAction && prevUpper === 'ON' && (cur.upper === 'DELETE' || cur.upper === 'UPDATE')
                  && next?.token.kind === 'word' && (
                    (next.upper === 'CASCADE'
                      && !(cur.upper === 'DELETE' && (batch[i + 2]?.upper === 'FROM' || batch[i + 2]?.upper === 'WHERE' || batch[i + 2]?.upper === 'OUTPUT' || batch[i + 2]?.upper === 'WITH'))
                      && !(cur.upper === 'UPDATE' && batch[i + 2]?.upper === 'SET'
                        && batch[i + 3]?.token.kind !== 'variable'
                        && !tsqlSessionSetOptions.has(batch[i + 3]?.upper ?? '')))
                    || (next.upper === 'NO' && batch[i + 2]?.upper === 'ACTION')
                    || (next.upper === 'SET' && (batch[i + 2]?.upper === 'NULL' || batch[i + 2]?.upper === 'DEFAULT'))
                  )) {
                  // Referential action (ON DELETE / ON UPDATE) inside DDL.
                } else if (isDdl && cur.upper === 'IF'
                  && ((next?.upper === 'EXISTS' && batch[i + 2]?.token.kind !== 'open')
                    || (next?.upper === 'NOT' && batch[i + 2]?.upper === 'EXISTS' && batch[i + 3]?.token.kind !== 'open'))) {
                  // DROP ... IF EXISTS <name> / CREATE ... IF NOT EXISTS <name> (never IF [NOT] EXISTS (SELECT ...)).
                } else if (isDdl && cur.upper === 'EXECUTE' && prevUpper === 'WITH' && next?.upper === 'AS') {
                  // WITH EXECUTE AS inside DDL headers.
                } else if (isAlter && cur.upper === 'DROP' && next?.token.kind === 'word' && tsqlAlterDropTargets.has(next.upper)
                  && !(next.upper === 'EVENT' && (batch[i + 2]?.upper === 'SESSION' || batch[i + 2]?.upper === 'NOTIFICATION'))
                  && !(next.upper === 'COLUMN' && (batch[i + 2]?.upper === 'ENCRYPTION' || batch[i + 2]?.upper === 'MASTER') && batch[i + 3]?.upper === 'KEY')) {
                  // ALTER TABLE/ROLE/DATABASE/EVENT SESSION/COLUMN ENCRYPTION KEY ... DROP COLUMN / CONSTRAINT / MEMBER / FILE / VALUE / etc.
                } else if (isAlter && cur.upper === 'ALTER' && next?.upper === 'COLUMN'
                  && !(batch[i + 2]?.upper === 'ENCRYPTION' && batch[i + 3]?.upper === 'KEY')) {
                  // ALTER TABLE ... ALTER COLUMN (excluding standalone ALTER COLUMN ENCRYPTION KEY).
                } else if (isAlter && (cur.upper === 'ENABLE' || cur.upper === 'DISABLE')
                  && (next?.upper === 'CHANGE_TRACKING'
                    || (next?.upper === 'TRIGGER' && !isStandaloneTriggerToggle(batch, i)))) {
                  // ALTER TABLE ... ENABLE/DISABLE TRIGGER / CHANGE_TRACKING (excluding standalone ENABLE/DISABLE TRIGGER ... ON ...).
                } else if (isAlter && cur.upper === 'ROLLBACK' && prevUpper === 'WITH') {
                  // ALTER DATABASE ... WITH ROLLBACK IMMEDIATE / AFTER n SECONDS.
                } else if (isAlter && cur.upper === 'RECONFIGURE' && prevUpper === 'GOVERNOR' && prev2Upper === 'RESOURCE') {
                  // ALTER RESOURCE GOVERNOR RECONFIGURE.
                } else if (mode === 'alterDb' && cur.upper === 'SET' && i === stmtStart + 3 && next?.token.kind !== 'variable') {
                  // ALTER DATABASE { db_name | CURRENT } SET ANSI_NULLS ON / SET RECOVERY SIMPLE / SET SINGLE_USER ...
                } else if (isDdl && cur.upper === 'SET' && (prevUpper === 'DELETE' || prevUpper === 'UPDATE' || next?.token.kind === 'open'
                  || (mode === 'alterDdl' && next?.token.kind !== 'variable' && !tsqlSessionSetOptions.has(next?.upper ?? '')))) {
                  // ON DELETE SET NULL / SET (...) / ALTER ... SET <option>.
                } else if ((isDdl || mode === 'generic') && cur.upper === 'WITH'
                  && (next?.token.kind === 'open'
                    || (isDdl && (prevUpper === 'START' || prevUpper === 'RESTART')
                      && (next?.token.kind === 'number' || (next?.token.kind === 'operator' && (next.text === '+' || next.text === '-'))))
                    || (next?.token.kind === 'word' && (
                      (tsqlDdlWithOptions.has(next.upper) && batch[i + 2]?.upper !== 'AS' && !isCteColumnList(i + 2))
                      || (batch[i + 2]?.token.kind === 'operator' && batch[i + 2]!.text === '=')
                    )))) {
                  // CREATE INDEX ... WITH (ONLINE = ON) / ALTER TABLE ... WITH CHECK / BACKUP ... WITH COMPRESSION / WITH <opt> = <val>.
                } else if (mode === 'insert' && !seenValuesOrDefault && !seenInsertSource && (cur.upper === 'SELECT' || cur.upper === 'EXEC' || cur.upper === 'EXECUTE')) {
                  // INSERT INTO ... SELECT / INSERT INTO ... EXEC (single source).
                  seenInsertSource = true
                  if (cur.upper === 'EXEC' || cur.upper === 'EXECUTE') seenInsertExec = true
                } else if (mode === 'insert' && seenInsertSource && cur.upper === 'SELECT' && (prevUpper === 'UNION' || (prevUpper === 'ALL' && prev2Upper === 'UNION') || prevUpper === 'EXCEPT' || prevUpper === 'INTERSECT')) {
                  // Compound INSERT INTO ... SELECT ... UNION [ALL] SELECT ...
                } else if (mode === 'insert' && cur.upper === 'WITH' && (next?.token.kind === 'open'
                  || (seenInsertSource && (next?.upper === 'TIES' || next?.upper === 'CUBE' || next?.upper === 'ROLLUP'))
                  || (seenInsertExec && (next?.upper === 'RESULT' || next?.upper === 'RECOMPILE') && batch[i + 2]?.upper !== 'AS' && !isCteColumnList(i + 2)))) {
                  // INSERT INTO t WITH (TABLOCK) / INSERT ... SELECT TOP 10 WITH TIES / GROUP BY WITH ROLLUP|CUBE / INSERT ... EXEC ... WITH RESULT SETS|RECOMPILE.
                } else if (mode === 'update' && !seenUpdateStatistics && cur.upper === 'SET' && !seenUpdateSet) {
                  seenUpdateSet = true
                } else if (mode === 'update' && cur.upper === 'WITH' && (next?.token.kind === 'open'
                  || (seenUpdateStatistics && next?.token.kind === 'word' && (
                    ((tsqlDdlWithOptions.has(next.upper) || next.upper === 'ALL' || next.upper === 'COLUMNS' || next.upper === 'INDEX')
                      && batch[i + 2]?.upper !== 'AS' && !isCteColumnList(i + 2))
                    || (batch[i + 2]?.token.kind === 'operator' && batch[i + 2]!.text === '=')
                  )))) {
                  // UPDATE t WITH (ROWLOCK) SET ... / UPDATE STATISTICS t WITH FULLSCAN|ALL|COLUMNS|INDEX|<opt> = <val>.
                } else if (mode === 'dml' && cur.upper === 'WITH' && next?.token.kind === 'open') {
                  // DELETE FROM t WITH (ROWLOCK) ...
                } else if (mode === 'view' && cur.upper === 'SELECT' && ((!seenViewSelect && seenViewAs)
                  || (seenViewSelect && (prevUpper === 'UNION' || (prevUpper === 'ALL' && prev2Upper === 'UNION') || prevUpper === 'EXCEPT' || prevUpper === 'INTERSECT')))) {
                  // CREATE/ALTER VIEW v AS [WITH cte AS (...)] SELECT ... [UNION ... SELECT ...].
                  seenViewSelect = true
                } else if (mode === 'view' && cur.upper === 'WITH' && (!seenViewAs
                  || (!seenViewSelect && prevUpper === 'AS')
                  || (seenViewSelect && (next?.token.kind === 'open' || next?.upper === 'TIES' || next?.upper === 'CUBE' || next?.upper === 'ROLLUP' || (next?.upper === 'CHECK' && batch[i + 2]?.upper === 'OPTION'))))) {
                  // CREATE VIEW v WITH SCHEMABINDING AS WITH cte AS (...) SELECT ... WITH CHECK OPTION.
                  if (seenViewAs && !seenViewSelect && prevUpper === 'AS') seenViewWithCte = true
                } else if (mode === 'merge' && (cur.upper === 'INSERT' || cur.upper === 'UPDATE' || cur.upper === 'DELETE' || cur.upper === 'SET' || cur.upper === 'SELECT' || cur.upper === 'WITH')) {
                  // MERGE WHEN MATCHED THEN UPDATE/DELETE/INSERT.
                } else {
                  break
                }
              }
            }
          } else if (awaitingTop) {
            if (!topConsumedValue && cur.token.kind === 'number') {
              topConsumedValue = true
            } else {
              awaitingTop = false
            }
          }
        }
        prev2Upper = prevUpper
        prevUpper = cur.token.kind === 'word' && !afterDot ? cur.upper : ''
        justStarted = false
        i++
      }
    }

    while (i < batch.length) {
      const cur = batch[i]!
      if (cur.token.kind === 'semicolon') {
        i++
        continue
      }
      if (cur.token.kind === 'sqlcmd') {
        statements.push({
          category: 'admin', keyword: 'SQLCMD', line: cur.line, batch: batchNum,
          conditional: isConditionalNow(), nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        pendingConditional = false
        i++
        continue
      }

      if (cur.token.kind !== 'word') {
        if (cur.token.kind === 'open') {
          const cond = isConditionalNow()
          pendingConditional = false
          const startLine = cur.line
          const hasInto = consumeSelect()
          statements.push({
            category: hasInto ? 'dml' : 'select', keyword: hasInto ? 'SELECT INTO' : 'SELECT', line: startLine, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
        if (cur.token.kind === 'bracketed' || cur.token.kind === 'quoted' || cur.token.kind === 'temp') {
          const cond = isConditionalNow()
          pendingConditional = false
          const startLine = cur.line
          consumeUntilNextStatement('generic')
          statements.push({
            category: 'other', keyword: cur.text, line: startLine, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
        i++
        continue
      }

      if (cur.upper === 'IF' || cur.upper === 'WHILE') {
        i++
        consumeCondition()
        pendingConditional = true
        continue
      }
      if (cur.upper === 'ELSE') {
        i++
        if (i < batch.length && batch[i]!.upper === 'IF') {
          i++
          consumeCondition()
        }
        pendingConditional = true
        continue
      }
      if (cur.upper === 'BEGIN') {
        const nextUpper = batch[i + 1]?.upper ?? ''
        if (nextUpper === 'TRAN' || nextUpper === 'TRANSACTION' || nextUpper === 'DISTRIBUTED') {
          const cond = isConditionalNow()
          pendingConditional = false
          const line = cur.line
          i++
          consumeUntilNextStatement('generic')
          statements.push({
            category: 'transaction', keyword: 'BEGIN TRANSACTION', line, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
        const nextIsLabel = batch[i + 2]?.token.kind === 'colon'
        if (!nextIsLabel && (nextUpper === 'DIALOG' || nextUpper === 'CONVERSATION')) {
          const cond = isConditionalNow()
          pendingConditional = false
          const line = cur.line
          i++
          consumeUntilNextStatement('generic')
          statements.push({
            category: 'admin', keyword: `BEGIN ${nextUpper}`, line, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
        if (!nextIsLabel && nextUpper === 'TRY') {
          pushBlock('try', pendingConditional)
          pendingConditional = false
          i += 2
          continue
        }
        if (!nextIsLabel && nextUpper === 'CATCH') {
          pushBlock('catch', true)
          pendingConditional = false
          i += 2
          continue
        }
        pushBlock('begin', pendingConditional)
        pendingConditional = false
        i++
        continue
      }
      if (cur.upper === 'END') {
        const nextUpper = batch[i + 1]?.upper ?? ''
        const nextIsLabel = batch[i + 2]?.token.kind === 'colon'
        if (!nextIsLabel && nextUpper === 'CONVERSATION') {
          const cond = isConditionalNow()
          pendingConditional = false
          const line = cur.line
          consumeUntilNextStatement('generic')
          statements.push({
            category: 'admin', keyword: 'END CONVERSATION', line, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
        if (!nextIsLabel && (nextUpper === 'TRY' || nextUpper === 'CATCH')) i += 2
        else i++
        popBlock()
        pendingConditional = false
        continue
      }

      const cond = isConditionalNow()
      pendingConditional = false
      const startLine = cur.line
      let mainUpper = cur.upper

      if (mainUpper === 'WITH') {
        let scan = i + 1
        let depth = 0
        let foundMain = false
        let seenCteBody = false
        let prevZeroUpper = ''
        let prevZeroKind: string | undefined
        while (scan < batch.length) {
          const t = batch[scan]!
          if (t.token.kind === 'open') {
            if (depth === 0 && seenCteBody && prevZeroKind !== 'comma' && prevZeroUpper !== 'AS' && prevZeroKind !== 'word') {
              let peek = scan + 1
              while (peek < batch.length && batch[peek]!.token.kind === 'open') peek++
              if (batch[peek]?.token.kind === 'word' && batch[peek]!.upper === 'SELECT') {
                mainUpper = 'SELECT'
                foundMain = true
                break
              }
            }
            depth++
          } else if (t.token.kind === 'close') {
            if (depth > 0) {
              depth--
              if (depth === 0) {
                seenCteBody = true
                prevZeroKind = 'close'
                prevZeroUpper = ''
              }
            }
          } else if (depth === 0 && batch[scan - 1]?.token.kind !== 'dot') {
            if (t.token.kind === 'semicolon' || t.token.kind === 'sqlcmd') break
            if (t.token.kind === 'word') {
              const nextTok = batch[scan + 1]
              if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE') {
                mainUpper = t.upper
                foundMain = true
                break
              }
              const isCteName = (!seenCteBody || prevZeroKind === 'comma') && (nextTok?.upper === 'AS' || nextTok?.token.kind === 'open')
              if (!isCteName && t.upper !== 'WITH' && tsqlStatementStarters.has(t.upper)) {
                break
              }
              prevZeroUpper = t.upper
            } else {
              prevZeroUpper = ''
            }
            prevZeroKind = t.token.kind
          }
          scan++
        }
        if (foundMain) {
          i = scan
        } else {
          // Advance past the entire scanned CTE fragment in O(N) rather than rescanning each WITH token.
          i = scan < batch.length && batch[scan]!.token.kind === 'semicolon' ? scan + 1 : scan
          statements.push({
            category: 'other', keyword: 'WITH', line: startLine, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
      }

      if (mainUpper === 'SELECT') {
        const hasInto = consumeSelect()
        statements.push({
          category: hasInto ? 'dml' : 'select', keyword: hasInto ? 'SELECT INTO' : 'SELECT', line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'BULK' && batch[i + 1]?.upper === 'INSERT') {
        i++
        consumeUntilNextStatement('dml')
        statements.push({
          category: 'dml', keyword: 'BULK INSERT', line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'INSERT' || mainUpper === 'UPDATE' || mainUpper === 'DELETE' || mainUpper === 'MERGE' || mainUpper === 'RECEIVE') {
        const dmlMode = mainUpper === 'MERGE' ? 'merge' : mainUpper === 'INSERT' ? 'insert' : mainUpper === 'UPDATE' ? 'update' : 'dml'
        consumeUntilNextStatement(dmlMode)
        statements.push({
          category: 'dml', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'CREATE' || mainUpper === 'ALTER' || mainUpper === 'DROP' || mainUpper === 'TRUNCATE' || mainUpper === 'ENABLE' || mainUpper === 'DISABLE') {
        const headerWords: string[] = [mainUpper]
        let probe = i + 1
        while (probe < batch.length && headerWords.length < 4) {
          const w = batch[probe]!
          if (w.token.kind !== 'word') break
          if (w.upper === 'OR' && batch[probe + 1]?.upper === 'ALTER') {
            probe += 2
            continue
          }
          headerWords.push(w.upper)
          probe++
        }
        const objWord = headerWords[1] ?? ''
        const isDbScopedOrAudit = isTSqlDatabaseScoped(headerWords) || isTSqlDatabaseAuditSpec(headerWords)
        const keyword = isDbScopedOrAudit
          ? `${mainUpper} DATABASE ${headerWords[2]} ${headerWords[3]}`
          : objWord ? `${mainUpper} ${objWord === 'PROC' ? 'PROCEDURE' : objWord}` : mainUpper
        const nonTx = isTSqlNonTransactionalDdl(headerWords)
        if ((mainUpper === 'CREATE' || mainUpper === 'ALTER') && (objWord === 'PROC' || objWord === 'PROCEDURE' || objWord === 'FUNCTION' || objWord === 'TRIGGER')) {
          i = batch.length
        } else if ((mainUpper === 'CREATE' || mainUpper === 'ALTER') && objWord === 'VIEW') {
          if (batch[i + 1]?.upper === 'OR' && batch[i + 2]?.upper === 'ALTER') i += 2
          consumeUntilNextStatement('view')
        } else {
          const allowRef = (mainUpper === 'CREATE' || mainUpper === 'ALTER') && objWord === 'TABLE'
          consumeUntilNextStatement(mainUpper === 'ALTER' ? (objWord === 'DATABASE' && !isDbScopedOrAudit ? 'alterDb' : 'alterDdl') : 'ddl', allowRef)
        }
        statements.push({
          category: 'ddl', keyword, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: nonTx, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'COMMIT' || mainUpper === 'ROLLBACK' || mainUpper === 'SAVE') {
        consumeUntilNextStatement('generic')
        statements.push({
          category: 'transaction', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (tsqlNonTransactionalAdmin.has(mainUpper)) {
        consumeUntilNextStatement('generic')
        statements.push({
          category: 'admin', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: true, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (tsqlAdmin.has(mainUpper)) {
        consumeUntilNextStatement(mainUpper === 'GRANT' || mainUpper === 'REVOKE' || mainUpper === 'DENY' ? 'dcl' : 'generic')
        statements.push({
          category: 'admin', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'MOVE' && batch[i + 1]?.token.kind === 'word' && batch[i + 1]!.upper === 'CONVERSATION') {
        consumeUntilNextStatement('generic')
        statements.push({
          category: 'admin', keyword: 'MOVE CONVERSATION', line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'GET' && batch[i + 1]?.token.kind === 'word' && batch[i + 1]!.upper === 'CONVERSATION'
        && batch[i + 2]?.token.kind === 'word' && batch[i + 2]!.upper === 'GROUP') {
        consumeUntilNextStatement('generic')
        statements.push({
          category: 'admin', keyword: 'GET CONVERSATION GROUP', line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'ADD' && batch[i + 1]?.token.kind === 'word') {
        const w1 = batch[i + 1]!.upper
        const w2 = batch[i + 2]?.token.kind === 'word' ? batch[i + 2]!.upper : ''
        const w3 = batch[i + 3]?.token.kind === 'word' ? batch[i + 3]!.upper : ''
        const addKeyword = w1 === 'SIGNATURE' && w2 === 'TO'
          ? 'ADD SIGNATURE'
          : w1 === 'COUNTER' && w2 === 'SIGNATURE' && w3 === 'TO'
            ? 'ADD COUNTER SIGNATURE'
            : w1 === 'SENSITIVITY' && w2 === 'CLASSIFICATION' && w3 === 'TO'
              ? 'ADD SENSITIVITY CLASSIFICATION'
              : null
        if (addKeyword) {
          consumeUntilNextStatement('generic')
          statements.push({
            category: 'admin', keyword: addKeyword, line: startLine, batch: batchNum,
            conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
          })
          continue
        }
      }

      if (tsqlProcedural.has(mainUpper)) {
        consumeUntilNextStatement(mainUpper === 'DECLARE' ? 'declare' : mainUpper === 'SET' ? 'set' : 'generic')
        statements.push({
          category: 'procedural', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      consumeUntilNextStatement('generic')
      statements.push({
        category: 'other', keyword: mainUpper, line: startLine, batch: batchNum,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
    }
    }
  }

  return buildClassification('sqlserver', nonEmptyBatches.length, statements)
}

interface BqSigToken {
  readonly token: GoogleSqlToken
  readonly text: string
  readonly upper: string
  readonly line: number
}

const bqBlockEnders = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CASE'])
const bqThenStop = new Set(['THEN'])
const bqDoStop = new Set(['DO'])
const bqCaseHeaderStops = new Set(['WHEN', 'ELSE', 'END'])
const bqSimpleStmtStarters = new Set([
  'SELECT', 'WITH', 'FROM', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SET', 'DECLARE', 'CALL',
  'CREATE', 'ALTER', 'DROP', 'UNDROP', 'TRUNCATE', 'EXPORT', 'LOAD', 'GRANT', 'REVOKE',
  'EXECUTE', 'ASSERT', 'RAISE', 'RETURN', 'LEAVE', 'ITERATE', 'BREAK', 'CONTINUE',
  'START', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'DESCRIBE', 'ANALYZE'
])
const bqWhilePrevContWords = new Set(['AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'BETWEEN', 'WHEN', 'THEN', 'ELSE', 'CASE', 'FROM'])
const bqWhileNextInfixWords = new Set(['AND', 'OR', 'IS', 'IN', 'LIKE', 'BETWEEN', 'NOT'])
const bqWhilePrevContOps = new Set(['<', '>', '=', '!', '+', '-', '*', '/', '%', '|', '&', '^', '~', ',', '.', '(', '[', '==', '!=', '<>', '<=', '>=', '||', '<<', '>>'])
const bqWhileNextInfixOps = new Set(['<', '>', '=', '!', '+', '-', '*', '/', '%', '|', '&', '^', '.', '[', '==', '!=', '<>', '<=', '>=', '||', '<<', '>>'])
const bqIntervalDateParts = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'MILLISECOND', 'MICROSECOND', 'NANOSECOND'])

function isBigQueryWhileDoTerminator(tokens: readonly BqSigToken[], idx: number, rejectAfterWhileOrFor: boolean): boolean {
  const prev = idx > 0 ? tokens[idx - 1] : undefined
  const next = tokens[idx + 1]
  const prevIsWord = prev !== undefined && prev.token.kind === 'word' && tokens[idx - 2]?.text !== '.'
  const prevCont = prev !== undefined && (
    (prevIsWord && ((rejectAfterWhileOrFor && (prev.upper === 'WHILE' || prev.upper === 'FOR')) || bqWhilePrevContWords.has(prev.upper)))
    || bqWhilePrevContOps.has(prev.text)
  )
  const nextCont = next !== undefined && (bqWhileNextInfixWords.has(next.upper) || bqWhileNextInfixOps.has(next.text))
  const isIntervalExpr = prevIsWord && prev.upper === 'INTERVAL' && next?.token.kind === 'word' && bqIntervalDateParts.has(next.upper)
  return !prevCont && !nextCont && !isIntervalExpr
}

function resolveBigQueryWithMain(tokens: readonly BqSigToken[], startIdx: number): { readonly verb: string; readonly token?: BqSigToken; readonly index?: number } {
  let cursor = startIdx
  while (cursor < tokens.length) {
    let scan = cursor + 1
    if (tokens[scan]?.upper === 'RECURSIVE') scan++
    let depth = 0
    let seenCteBody = false
    let prevZeroUpper = ''
    let prevZeroText = ''
    let prevZeroKind: string | undefined
    let descended = false
    while (scan < tokens.length) {
      const t = tokens[scan]!
      if (t.text === '(') {
        if (depth === 0 && seenCteBody && prevZeroText !== ',' && prevZeroUpper !== 'AS' && prevZeroKind !== 'word') {
          let peek = scan + 1
          while (peek < tokens.length && tokens[peek]!.text === '(') peek++
          const inner = tokens[peek]
          if (inner?.token.kind === 'word' && inner.upper === 'SELECT') {
            return { verb: 'SELECT', token: inner, index: peek }
          }
          if (inner?.token.kind === 'word' && inner.upper === 'WITH') {
            cursor = peek
            descended = true
            break
          }
          if (inner) {
            return { verb: inner.token.kind === 'word' ? inner.upper : inner.text, token: inner, index: peek }
          }
        }
        depth++
      } else if (t.text === ')') {
        if (depth > 0) {
          depth--
          if (depth === 0) {
            seenCteBody = true
            prevZeroText = ')'
            prevZeroUpper = ''
            prevZeroKind = 'punctuation'
          }
        }
      } else if (depth === 0 && tokens[scan - 1]?.text !== '.') {
        if (t.text === ';') break
        if (seenCteBody && prevZeroText !== ',' && t.text !== ',') {
          if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE') {
            return { verb: t.upper, token: t, index: scan }
          }
          return { verb: t.token.kind === 'word' ? t.upper : t.text, token: t, index: scan }
        }
        // Skip CTE name before AS (e.g. `WITH update AS (...) SELECT ...`).
        if (tokens[scan + 1]?.upper === 'AS' && tokens[scan + 2]?.text === '(') {
          scan += 2
          prevZeroUpper = 'AS'
          prevZeroText = 'AS'
          prevZeroKind = 'word'
          continue
        }
        if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE') {
          return { verb: t.upper, token: t, index: scan }
        }
        prevZeroUpper = t.token.kind === 'word' ? t.upper : ''
        prevZeroText = t.text
        prevZeroKind = t.token.kind
      }
      scan++
    }
    if (!descended) break
  }
  return { verb: 'WITH', token: tokens[startIdx], index: startIdx }
}

function classifyBigQuery(sql: string): StatementClassification {
  const starts = lineStarts(sql)
  const rawTokens = scanGoogleSql(sql)
  const sig: BqSigToken[] = []
  for (const token of rawTokens) {
    if (token.kind === 'whitespace' || token.kind === 'comment') continue
    const text = sql.slice(token.start, token.end)
    sig.push({
      token,
      text,
      upper: token.kind === 'word' ? text.toUpperCase() : '',
      line: positionAt(starts, token.start).line
    })
  }
  if (sig.every(t => t.text === ';')) {
    return buildClassification('bigquery', 0, [])
  }

  const statements: ClassifiedStatement[] = []
  const blockStack: { readonly kind: string; conditional: boolean }[] = []
  let conditionalDepth = 0
  let i = 0

  const isConditionalNow = () => conditionalDepth > 0
  const pushBlock = (kind: string, conditional: boolean) => {
    blockStack.push({ kind, conditional })
    if (conditional) conditionalDepth++
  }
  const popBlock = () => {
    const popped = blockStack.pop()
    if (popped?.conditional) conditionalDepth--
  }

  const consumeToSemicolon = () => {
    let depth = 0
    while (i < sig.length) {
      const t = sig[i]!
      if (t.text === '(') depth++
      else if (t.text === ')') { if (depth > 0) depth-- }
      else if (t.text === ';' && depth === 0) { i++; break }
      i++
    }
  }

  const consumeUntilKeyword = (stopKeywords: ReadonlySet<string>, consumeStop: boolean) => {
    let depth = 0
    let caseDepth = 0
    while (i < sig.length) {
      const t = sig[i]!
      if (t.text === '(') depth++
      else if (t.text === ')') { if (depth > 0) depth-- }
      else if (depth === 0 && t.token.kind === 'word' && sig[i - 1]?.text !== '.') {
        if (t.upper === 'CASE') {
          caseDepth++
        } else if (t.upper === 'END' && caseDepth > 0) {
          caseDepth--
        } else if (caseDepth === 0 && stopKeywords.has(t.upper)) {
          if (consumeStop) i++
          break
        }
      }
      i++
    }
  }

  const consumeBeginEndBody = () => {
    // Expects i positioned at BEGIN; consumes matching END (and optional trailing ;).
    const stack: ('begin' | 'stmtCase' | 'exprCase')[] = []
    let parenDepth = 0
    let atBlockBoundary = true
    let headerKind: 'then' | 'do' | 'until' | null = null
    let inSimpleStmt = false
    let inProcHeader = false
    let seenProcParams = false
    const isCreateProcedureAt = (idx: number): boolean => {
      let p = idx + 1
      if (sig[p]?.upper === 'OR' && sig[p + 1]?.upper === 'REPLACE') p += 2
      if (sig[p]?.upper === 'TEMP' || sig[p]?.upper === 'TEMPORARY') p++
      if (sig[p]?.upper === 'PUBLIC' || sig[p]?.upper === 'PRIVATE') p++
      return sig[p]?.token.kind === 'word' && sig[p]!.upper === 'PROCEDURE'
    }
    while (i < sig.length) {
      const t = sig[i]!
      const top = stack[stack.length - 1]
      if (t.text === '(') {
        if (atBlockBoundary && !inSimpleStmt && parenDepth === 0 && top !== 'exprCase') {
          inSimpleStmt = true
          atBlockBoundary = false
          headerKind = null
        }
        parenDepth++
      } else if (t.text === ')') {
        if (parenDepth === 1 && inProcHeader) seenProcParams = true
        if (parenDepth > 0) parenDepth--
      } else if (t.text === ';' && parenDepth === 0) {
        inSimpleStmt = false
        inProcHeader = false
        seenProcParams = false
        atBlockBoundary = true
        headerKind = null
      } else if (t.token.kind === 'word' && sig[i - 1]?.text !== '.') {
        const atBoundary = atBlockBoundary && !inSimpleStmt && parenDepth === 0 && top !== 'exprCase'
        const atNestedProcBegin = inProcHeader && seenProcParams && parenDepth === 0 && top !== 'exprCase'
        // Labeled block or loop (`my_lbl: LOOP ...`, `load: BEGIN ...`, `begin: LOOP ...`).
        if (atBoundary && sig[i + 1]?.text === ':') {
          i += 2
          continue
        }
        if (t.upper === 'BEGIN' && (atBoundary || atNestedProcBegin)) {
          const nextAfterBegin = sig[i + 1]
          if (nextAfterBegin === undefined || nextAfterBegin.text === ';'
            || nextAfterBegin.upper === 'TRANSACTION' || nextAfterBegin.upper === 'TRAN') {
            inSimpleStmt = true
            atBlockBoundary = false
            headerKind = null
          } else {
            stack.push('begin')
            atBlockBoundary = true
            headerKind = null
            if (atNestedProcBegin) {
              inSimpleStmt = false
              inProcHeader = false
              seenProcParams = false
            }
          }
        } else if (t.upper === 'CASE') {
          if (atBoundary) {
            stack.push('stmtCase')
            atBlockBoundary = false
            headerKind = 'then'
          } else {
            stack.push('exprCase')
          }
        } else if (t.upper === 'END') {
          const next = sig[i + 1]
          const afterNext = sig[i + 2]
          if (top === 'exprCase') {
            stack.pop()
          } else if (top === 'stmtCase' && parenDepth === 0) {
            stack.pop()
            atBlockBoundary = false
            headerKind = null
            if (next?.token.kind === 'word' && next.upper === 'CASE' && (afterNext === undefined || afterNext.text === ';')) {
              i++
            }
          } else if (parenDepth === 0) {
            const isCompoundEnder = next?.token.kind === 'word'
              && bqBlockEnders.has(next.upper)
              && (afterNext === undefined || afterNext.text === ';')
            if (isCompoundEnder) {
              // END IF / END WHILE / END FOR / END LOOP / END REPEAT close blocks not pushed onto stack.
              atBlockBoundary = false
              headerKind = null
              i += 2
              continue
            }
            if (stack.length > 0) stack.pop()
            atBlockBoundary = false
            headerKind = null
          }
          if (stack.length === 0) {
            i++
            if (sig[i]?.text === ';') i++
            break
          }
        } else if (atBoundary) {
          if (t.upper === 'IF' || t.upper === 'ELSEIF' || t.upper === 'WHEN' || t.upper === 'EXCEPTION') {
            atBlockBoundary = false
            headerKind = 'then'
          } else if (t.upper === 'WHILE' || t.upper === 'FOR') {
            atBlockBoundary = false
            headerKind = 'do'
          } else if (t.upper === 'UNTIL') {
            atBlockBoundary = false
            headerKind = 'until'
          } else if (t.upper === 'ELSE' || t.upper === 'LOOP' || t.upper === 'REPEAT') {
            atBlockBoundary = true
            headerKind = null
          } else if (bqSimpleStmtStarters.has(t.upper)) {
            inSimpleStmt = true
            atBlockBoundary = false
            headerKind = null
            if (t.upper === 'CREATE' && isCreateProcedureAt(i)) {
              inProcHeader = true
              seenProcParams = false
            }
          }
        } else if (!inSimpleStmt && parenDepth === 0 && top !== 'exprCase') {
          if (headerKind === 'then' && t.upper === 'THEN') {
            atBlockBoundary = true
            headerKind = null
          } else if (headerKind === 'do' && t.upper === 'DO' && isBigQueryWhileDoTerminator(sig, i, true)) {
            atBlockBoundary = true
            headerKind = null
          }
        }
      }
      i++
    }
  }

  while (i < sig.length) {
    const cur = sig[i]!
    if (cur.text === ';') { i++; continue }

    if (cur.token.kind !== 'word') {
      if (cur.text === '(') {
        const startLine = cur.line
        const cond = isConditionalNow()
        consumeToSemicolon()
        statements.push({
          category: 'select', keyword: 'SELECT', line: startLine, batch: 1,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }
      i++
      continue
    }

    // Labeled block or loop (e.g. `my_lbl: LOOP ...`, `my_lbl: BEGIN ...`).
    if (sig[i + 1]?.text === ':') {
      i += 2
      continue
    }

    if (cur.upper === 'EXCEPTION') {
      i++
      consumeUntilKeyword(bqThenStop, true)
      const top = blockStack[blockStack.length - 1]
      if (top && top.kind === 'BEGIN' && !top.conditional) {
        top.conditional = true
        conditionalDepth++
      }
      continue
    }

    if (cur.upper === 'IF' || cur.upper === 'ELSEIF') {
      i++
      consumeUntilKeyword(bqThenStop, true)
      if (cur.upper === 'IF') pushBlock('IF', true)
      continue
    }
    if (cur.upper === 'ELSE') {
      i++
      continue
    }
    if (cur.upper === 'FOR') {
      i++
      // Skip loop variable name (which may be a non-reserved identifier like `do`) and scan to `IN`, then `DO`.
      if (i < sig.length && sig[i]!.token.kind === 'word') i++
      let depth = 0
      while (i < sig.length) {
        const t = sig[i]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0 && t.token.kind === 'word' && sig[i - 1]?.text !== '.' && t.upper === 'IN') { i++; break }
        i++
      }
      consumeUntilKeyword(bqDoStop, true)
      pushBlock('FOR', true)
      continue
    }
    if (cur.upper === 'WHILE') {
      i++
      let depth = 0
      let caseDepth = 0
      let sawExprToken = false
      while (i < sig.length) {
        const t = sig[i]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0 && t.token.kind === 'word' && sig[i - 1]?.text !== '.') {
          if (t.upper === 'CASE') {
            caseDepth++
          } else if (t.upper === 'END' && caseDepth > 0) {
            caseDepth--
          } else if (caseDepth === 0 && t.upper === 'DO' && sawExprToken && isBigQueryWhileDoTerminator(sig, i, false)) {
            i++
            break
          }
        }
        sawExprToken = true
        i++
      }
      pushBlock('WHILE', true)
      continue
    }
    if (cur.upper === 'LOOP' || cur.upper === 'REPEAT') {
      pushBlock(cur.upper, true)
      i++
      continue
    }
    if (cur.upper === 'UNTIL') {
      i++
      let depth = 0
      let caseDepth = 0
      while (i < sig.length) {
        const t = sig[i]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0) {
          if (t.text === ';') { i++; break }
          if (t.token.kind === 'word' && sig[i - 1]?.text !== '.') {
            if (t.upper === 'CASE') caseDepth++
            else if (t.upper === 'END' && caseDepth > 0) caseDepth--
            else if (caseDepth === 0 && t.upper === 'END') {
              i++
              if (sig[i]?.upper === 'REPEAT') i++
              if (sig[i]?.text === ';') i++
              break
            }
          }
        }
        i++
      }
      popBlock()
      continue
    }
    if (cur.upper === 'BEGIN') {
      const next = sig[i + 1]
      const nextUpper = next?.upper ?? ''
      if (nextUpper === 'TRANSACTION' || nextUpper === 'TRAN' || next === undefined || next.text === ';') {
        const line = cur.line
        const cond = isConditionalNow()
        const keyword = nextUpper === 'TRANSACTION' || nextUpper === 'TRAN' ? 'BEGIN TRANSACTION' : 'BEGIN'
        consumeToSemicolon()
        statements.push({
          category: 'transaction', keyword, line, batch: 1,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
        })
        continue
      }
      pushBlock('BEGIN', false)
      i++
      continue
    }
    if (cur.upper === 'CASE') {
      pushBlock('CASE', true)
      i++
      consumeUntilKeyword(bqCaseHeaderStops, false)
      continue
    }
    if (cur.upper === 'WHEN') {
      i++
      consumeUntilKeyword(bqThenStop, true)
      continue
    }
    if (cur.upper === 'END') {
      const nextUpper = sig[i + 1]?.upper ?? ''
      if (bqBlockEnders.has(nextUpper)) i += 2
      else i++
      if (sig[i]?.text === ';') i++
      popBlock()
      continue
    }

    const startLine = cur.line
    const cond = isConditionalNow()
    let mainUpper = cur.upper

    if (mainUpper === 'WITH') {
      const resolved = resolveBigQueryWithMain(sig, i)
      mainUpper = resolved.verb
      if (resolved.index !== undefined && resolved.index > i) i = resolved.index
    }

    if (mainUpper === 'SELECT') {
      consumeToSemicolon()
      statements.push({
        category: 'select', keyword: 'SELECT', line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
      continue
    }

    if (mainUpper === 'INSERT' || mainUpper === 'UPDATE' || mainUpper === 'DELETE' || mainUpper === 'MERGE') {
      consumeToSemicolon()
      statements.push({
        category: 'dml', keyword: mainUpper, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
      continue
    }

    if (mainUpper === 'TRUNCATE') {
      const objWord = sig[i + 1]?.upper === 'TABLE' ? 'TABLE' : ''
      const keyword = objWord ? 'TRUNCATE TABLE' : 'TRUNCATE'
      consumeToSemicolon()
      statements.push({
        category: 'dml', keyword, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
      continue
    }

    if (mainUpper === 'CREATE' || mainUpper === 'ALTER' || mainUpper === 'DROP' || mainUpper === 'UNDROP') {
      let probe = i + 1
      let isTemp = false
      if (probe < sig.length && sig[probe]!.upper === 'OR' && sig[probe + 1]?.upper === 'REPLACE') {
        probe += 2
      }
      if (probe < sig.length && (sig[probe]!.upper === 'TEMP' || sig[probe]!.upper === 'TEMPORARY')) {
        isTemp = true
        probe++
      }
      if (probe < sig.length && sig[probe]!.upper === 'PUBLIC') probe++
      if (probe < sig.length && sig[probe]!.upper === 'PRIVATE') probe++
      const objWord = sig[probe]?.upper ?? ''
      const secondObj = sig[probe + 1]?.upper ?? ''
      const isTableFunction = (() => {
        if (objWord !== 'TABLE' || secondObj !== 'FUNCTION') return false
        const third = sig[probe + 2]
        if (!third || third.text === ';' || third.text === '(') return false
        if (mainUpper === 'DROP') return true
        if (third.token.kind !== 'word') return true
        if (third.upper === 'AS' || third.upper === 'LIKE' || third.upper === 'DEFAULT' || third.upper === 'FOR') return false
        const fourth = sig[probe + 3]
        if (third.upper === 'CLONE' || third.upper === 'COPY' || third.upper === 'PARTITION' || third.upper === 'CLUSTER') {
          return fourth?.text === '(' || fourth?.text === '.'
        }
        if (third.upper === 'OPTIONS') {
          if (fourth?.text === '.') return true
          if (fourth?.text !== '(') return true
          let depth = 1
          let p = probe + 4
          while (p < sig.length && depth > 0) {
            const tok = sig[p]!
            if (tok.text === '(') depth++
            else if (tok.text === ')') depth--
            else if (depth === 1 && tok.text === '=') return false
            p++
          }
          return true
        }
        return true
      })()
      const kindLabel = objWord === 'MATERIALIZED' && secondObj === 'VIEW'
        ? 'MATERIALIZED VIEW'
        : objWord === 'EXTERNAL' && secondObj === 'TABLE'
          ? 'EXTERNAL TABLE'
          : isTableFunction
            ? 'TABLE FUNCTION'
            : objWord === 'AGGREGATE' && secondObj === 'FUNCTION'
              ? 'AGGREGATE FUNCTION'
              : objWord
      const keyword = kindLabel ? `${mainUpper}${isTemp ? ' TEMP' : ''} ${kindLabel}` : mainUpper

      let permanentDdl = false
      let blocksTx = false
      if (mainUpper === 'CREATE' && isTemp && kindLabel === 'TABLE') {
        permanentDdl = false
        blocksTx = false
      } else if (mainUpper === 'CREATE' && isTemp && (objWord === 'FUNCTION' || objWord === 'PROCEDURE' || kindLabel === 'TABLE FUNCTION' || kindLabel === 'AGGREGATE FUNCTION')) {
        permanentDdl = false
        blocksTx = true
      } else if (mainUpper === 'DROP') {
        // Check target for _SESSION.<name> or explicit DROP TEMP TABLE.
        let targetIdx = probe + (kindLabel.includes(' ') ? 2 : 1)
        if (sig[targetIdx]?.upper === 'IF' && sig[targetIdx + 1]?.upper === 'EXISTS') targetIdx += 2
        const firstPart = sig[targetIdx]?.text.replaceAll('`', '').toUpperCase() ?? ''
        const isSession = (firstPart === '_SESSION' && sig[targetIdx + 1]?.text === '.') || firstPart.startsWith('_SESSION.')
        const isTempObj = isSession || isTemp
        permanentDdl = !isTempObj
        blocksTx = !(isTempObj && kindLabel === 'TABLE')
      } else {
        permanentDdl = true
        blocksTx = true
      }

      if (mainUpper === 'CREATE' && objWord === 'PROCEDURE') {
        // Skip header until BEGIN (after parameter list) or ;
        let depth = 0
        let seenParams = false
        while (i < sig.length) {
          const t = sig[i]!
          if (t.text === '(') depth++
          else if (t.text === ')') {
            if (depth === 1) seenParams = true
            if (depth > 0) depth--
          } else if (depth === 0) {
            if (t.text === ';') { i++; break }
            if (t.upper === 'BEGIN' && seenParams && sig[i - 1]?.text !== '.') { consumeBeginEndBody(); break }
          }
          i++
        }
      } else {
        consumeToSemicolon()
      }

      statements.push({
        category: 'ddl', keyword, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl, blocksBigQueryTransaction: blocksTx
      })
      continue
    }

    if (mainUpper === 'COMMIT' || mainUpper === 'ROLLBACK') {
      const nextUpper = sig[i + 1]?.upper ?? ''
      const keyword = nextUpper === 'TRANSACTION' || nextUpper === 'TRAN' ? `${mainUpper} TRANSACTION` : mainUpper
      consumeToSemicolon()
      statements.push({
        category: 'transaction', keyword, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if (mainUpper === 'EXECUTE' && sig[i + 1]?.upper === 'IMMEDIATE') {
      consumeToSemicolon()
      statements.push({
        category: 'procedural', keyword: 'EXECUTE IMMEDIATE', line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if (mainUpper === 'CALL') {
      consumeToSemicolon()
      statements.push({
        category: 'procedural', keyword: 'CALL', line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if (mainUpper === 'EXPORT' && sig[i + 1]?.upper === 'TABLE' && sig[i + 2]?.upper === 'METADATA') {
      consumeToSemicolon()
      statements.push({
        category: 'admin', keyword: 'EXPORT TABLE METADATA', line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if ((mainUpper === 'EXPORT' && (sig[i + 1]?.upper === 'DATA' || sig[i + 1]?.upper === 'MODEL'))
      || (mainUpper === 'LOAD' && sig[i + 1]?.upper === 'DATA')) {
      const targetKind = sig[i + 1]!.upper
      consumeToSemicolon()
      statements.push({
        category: 'admin', keyword: `${mainUpper} ${targetKind}`, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if (mainUpper === 'DECLARE' || mainUpper === 'SET' || mainUpper === 'ASSERT' || mainUpper === 'RAISE' || mainUpper === 'RETURN' || mainUpper === 'LEAVE' || mainUpper === 'ITERATE' || mainUpper === 'BREAK' || mainUpper === 'CONTINUE') {
      consumeToSemicolon()
      statements.push({
        category: 'procedural', keyword: mainUpper, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
      continue
    }

    if (mainUpper === 'GRANT' || mainUpper === 'REVOKE') {
      consumeToSemicolon()
      statements.push({
        category: 'admin', keyword: mainUpper, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
      })
      continue
    }

    if (mainUpper === 'EXPLAIN' || mainUpper === 'DESCRIBE' || mainUpper === 'ANALYZE') {
      consumeToSemicolon()
      statements.push({
        category: 'admin', keyword: mainUpper, line: startLine, batch: 1,
        conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
      })
      continue
    }

    consumeToSemicolon()
    statements.push({
      category: 'other', keyword: mainUpper, line: startLine, batch: 1,
      conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
    })
  }

  return buildClassification('bigquery', statements.length > 0 ? 1 : 0, statements)
}

function buildClassification(provider: ProviderId, batchCount: number, statements: readonly ClassifiedStatement[]): StatementClassification {
  const hasNonTransactionalTSql = provider === 'sqlserver' && statements.some(s => s.nonTransactional)
  const hasBigQueryPermanentDdl = provider === 'bigquery' && statements.some(s => s.permanentDdl)
  const blocksBigQueryTransaction = provider === 'bigquery' && statements.some(s => s.blocksBigQueryTransaction)
  const firstBlockingStatement = provider === 'bigquery'
    ? statements.find(s => s.blocksBigQueryTransaction)
    : statements.find(s => s.nonTransactional)

  const tags: string[] = []
  if (provider === 'sqlserver' && batchCount > 1) {
    tags.push(`${batchCount} batches`)
  }

  if (provider === 'bigquery') {
    const permDdl = statements.filter(s => s.permanentDdl)
    const otherDdl = statements.filter(s => s.category === 'ddl' && !s.permanentDdl)
    if (permDdl.length === 1) tags.push(`1 permanent DDL (Line ${permDdl[0]!.line}: ${permDdl[0]!.keyword})`)
    else if (permDdl.length > 1) tags.push(`${permDdl.length} permanent DDL`)
    if (otherDdl.length === 1) tags.push(`1 temp DDL (${otherDdl[0]!.keyword})`)
    else if (otherDdl.length > 1) tags.push(`${otherDdl.length} temp DDL`)
  } else {
    const nonTx = statements.filter(s => s.nonTransactional)
    const ddl = statements.filter(s => s.category === 'ddl')
    if (ddl.length === 1) tags.push(`1 DDL (${ddl[0]!.keyword})`)
    else if (ddl.length > 1) tags.push(`${ddl.length} DDL`)
    if (nonTx.length === 1 && nonTx[0]!.category !== 'ddl') {
      tags.push(`1 non-transactional (${nonTx[0]!.keyword})`)
    } else if (nonTx.length > 1) {
      tags.push(`${nonTx.length} non-transactional`)
    }
  }

  const dml = statements.filter(s => s.category === 'dml')
  if (dml.length === 1) {
    tags.push(provider === 'bigquery' ? `1 DML (Line ${dml[0]!.line}: ${dml[0]!.keyword})` : `1 DML (${dml[0]!.keyword})`)
  } else if (dml.length > 1) {
    tags.push(`${dml.length} DML`)
  }

  const selects = statements.filter(s => s.category === 'select')
  if (selects.length > 0) {
    const condCount = selects.filter(s => s.conditional).length
    let label = selects.length === 1 ? '1 SELECT' : `${selects.length} SELECTs`
    if (condCount > 0) label += ` (${condCount} conditional)`
    else if (provider === 'bigquery' && selects.length === 1 && statements.some(s => s.category !== 'select')) {
      label += ` (Line ${selects[0]!.line})`
    }
    tags.push(label)
  }

  const tx = statements.filter(s => s.category === 'transaction')
  if (tx.length > 0) tags.push(`${tx.length} transaction`)
  const proc = statements.filter(s => s.category === 'procedural')
  if (proc.length > 0) tags.push(`${proc.length} procedural`)
  const admin = statements.filter(s => s.category === 'admin' && !s.nonTransactional)
  if (admin.length > 0) tags.push(`${admin.length} admin`)

  return {
    provider,
    batchCount,
    statements,
    hasNonTransactionalTSql,
    hasBigQueryPermanentDdl,
    blocksBigQueryTransaction,
    ...(firstBlockingStatement ? { firstBlockingStatement } : {}),
    tags
  }
}

export function classifyStatements(sql: string, provider: ProviderId): StatementClassification {
  return provider === 'bigquery' ? classifyBigQuery(sql) : classifyTSql(sql)
}

const tsqlBlockedKeywords = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'GRANT', 'REVOKE', 'DENY',
  'EXEC', 'EXECUTE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
  'SET', 'DECLARE', 'WHILE', 'IF', 'RETURN', 'RAISERROR', 'PRINT',
  'USE', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE',
  'CHECKPOINT', 'REVERT', 'SETUSER', 'GOTO', 'BREAK', 'CONTINUE', 'OPEN', 'CLOSE', 'DEALLOCATE', 'LINENO',
  'INTO', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML', 'BULK',
  'WAITFOR', 'WRITETEXT', 'UPDATETEXT', 'READTEXT'
])

const tsqlExprContinuationPrev = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'AS', 'FROM', 'JOIN', 'ON', 'WHERE', 'AND', 'OR', 'NOT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'BY', 'IN', 'LIKE', 'BETWEEN', 'IS', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'TOP', 'OVER'
])

const tsqlSubqueryContinuationPrev = new Set(['EXISTS', 'ANY', 'SOME'])
const tsqlMergeJoinPrev = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER'])

function isTSqlMergeJoinHint(prevWord: string, next: TSqlSigToken | undefined): boolean {
  return tsqlMergeJoinPrev.has(prevWord) && next?.token.kind === 'word' && next.upper === 'JOIN'
}

function isStandaloneTriggerToggle(tokens: readonly TSqlSigToken[], toggleIdx: number): boolean {
  let p = toggleIdx + 2
  while (p < tokens.length) {
    const t = tokens[p]!
    if (t.token.kind === 'word' && t.upper === 'ON' && tokens[p - 1]?.token.kind !== 'dot') return true
    if (t.token.kind === 'dot' || t.token.kind === 'comma' || t.token.kind === 'bracketed' || t.token.kind === 'quoted') {
      p++
      continue
    }
    if (t.token.kind === 'word' && (t.upper === 'ALL' || !tsqlStatementStarters.has(t.upper))) {
      p++
      continue
    }
    break
  }
  return false
}

function isTSqlExprContinuation(prevWord: string, prev2Word: string): boolean {
  if (prevWord === 'ALL') return prev2Word !== 'SYSTEM_TIME' && prev2Word !== 'TRIGGER' && prev2Word !== 'CONSTRAINT'
  if (prevWord === 'APPLY') return prev2Word === 'CROSS' || prev2Word === 'OUTER'
  return tsqlExprContinuationPrev.has(prevWord)
}

function isTSqlSubqueryContinuation(
  tokens: readonly TSqlSigToken[],
  openIdx: number,
  prevWord: string,
  prev2Word: string,
  allowOffset: boolean,
  getMatchingClose: () => Int32Array
): boolean {
  if (isTSqlExprContinuation(prevWord, prev2Word)) return true
  if (prevWord === 'NEXT' || prevWord === 'FIRST') {
    return allowOffset
      && prev2Word === 'FETCH'
      && isTSqlPagingFetch(tokens, openIdx - 2, getMatchingClose)
      && !hasSelectIntoInParens(tokens, openIdx, getMatchingClose)
  }
  if (prevWord === 'OFFSET') {
    return allowOffset && isTSqlPagingOffsetParen(tokens, openIdx, getMatchingClose)
  }
  if (prevWord === 'VALUES') {
    return prev2Word !== 'DEFAULT' && prev2Word !== 'WITH' && !hasSelectIntoInParens(tokens, openIdx, getMatchingClose)
  }
  return tsqlSubqueryContinuationPrev.has(prevWord)
}

const tsqlAliasFollowKeywords = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON',
  'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION',
  'AS', 'INTO', 'SET', 'VALUES', 'WHEN', 'THEN', 'ELSE', 'END',
  'WITH', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE'
])

const tsqlInfixOrPrefixOperators = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~'])

function isTSqlInfixOrPrefixOperator(tok: TSqlSigToken | undefined): boolean {
  return tok?.token.kind === 'operator' && tsqlInfixOrPrefixOperators.has(tok.text)
}

function isTSqlStmtBoundary(prevTok: TSqlSigToken | undefined, prevWord: string, prev2Word: string): boolean {
  const prevKind = prevTok?.token.kind
  return prevKind !== undefined
    && prevKind !== 'comma'
    && prevKind !== 'open'
    && !isTSqlInfixOrPrefixOperator(prevTok)
    && !isTSqlExprContinuation(prevWord, prev2Word)
}

const tsqlSendPredicateKeywords = new Set(['IN', 'LIKE', 'BETWEEN', 'NOT', 'AND', 'OR', 'IS', 'COLLATE'])
const tsqlSendNiladicHandles = new Set(['NULL', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER', 'CURRENT_TIMESTAMP'])

function isSendConversationHandle(tokens: readonly TSqlSigToken[], sendIdx: number): boolean {
  const t3 = tokens[sendIdx + 3]
  if (!t3) return false
  if (t3.token.kind === 'variable' || t3.token.kind === 'open' || t3.token.kind === 'string'
    || (t3.token.kind === 'operator' && (t3.text === '{' || t3.text === '~'))) return true
  if (t3.token.kind === 'number' && /^0x/i.test(t3.text)) return true
  if (t3.token.kind === 'word' && (t3.upper === 'CASE' || tsqlSendNiladicHandles.has(t3.upper))) return true
  if (t3.token.kind === 'word' || t3.token.kind === 'bracketed' || t3.token.kind === 'quoted') {
    if (t3.token.kind === 'word' && tsqlSendPredicateKeywords.has(t3.upper)) return false
    let p = sendIdx + 3
    let sawScope = false
    while (p < tokens.length && (tokens[p]!.token.kind === 'word' || tokens[p]!.token.kind === 'bracketed' || tokens[p]!.token.kind === 'quoted')) {
      if (tokens[p + 1]?.token.kind === 'dot') {
        p += tokens[p + 2]?.token.kind === 'dot' ? 3 : 2
        continue
      }
      if (tokens[p + 1]?.token.kind === 'scope') {
        sawScope = true
        p += 2
        continue
      }
      return sawScope || tokens[p + 1]?.token.kind === 'open'
    }
  }
  return false
}

function buildMatchingClose(tokens: readonly TSqlSigToken[]): Int32Array {
  const map = new Int32Array(tokens.length).fill(-1)
  const stack: number[] = []
  for (let k = 0; k < tokens.length; k++) {
    const kind = tokens[k]!.token.kind
    if (kind === 'open') stack.push(k)
    else if (kind === 'close' && stack.length > 0) map[stack.pop()!] = k
  }
  return map
}

function isTSqlPagingFetch(tokens: readonly TSqlSigToken[], fetchIdx: number, getMatchingClose: () => Int32Array): boolean {
  const next = tokens[fetchIdx + 1]
  if (!next || next.token.kind !== 'word' || (next.upper !== 'NEXT' && next.upper !== 'FIRST')) return false
  let p = fetchIdx + 2
  let exprTokens = 0
  let caseDepth = 0
  while (p < tokens.length) {
    const t = tokens[p]!
    if (t.token.kind === 'open') {
      const closeIdx = getMatchingClose()[p]!
      if (closeIdx < 0) return false
      p = closeIdx + 1
      exprTokens++
      continue
    }
    if (t.token.kind === 'close' || t.token.kind === 'semicolon' || t.token.kind === 'sqlcmd') return false
    if (t.token.kind === 'word' && tokens[p - 1]?.token.kind !== 'dot') {
      if (t.upper === 'CASE') {
        caseDepth++
        exprTokens++
        p++
        continue
      }
      if (t.upper === 'END' && caseDepth > 0) {
        caseDepth--
        exprTokens++
        p++
        continue
      }
      if (caseDepth === 0) {
        if ((t.upper === 'ROW' || t.upper === 'ROWS') && exprTokens > 0
          && tokens[p + 1]?.token.kind === 'word' && tokens[p + 1]!.upper === 'ONLY') {
          return true
        }
        if (t.upper === 'FROM' || t.upper === 'INTO' || tsqlStatementStarters.has(t.upper)) return false
      }
    }
    exprTokens++
    p++
  }
  return false
}

function isIdentToken(tok: TSqlSigToken | undefined): boolean {
  return tok !== undefined && (tok.token.kind === 'word' || tok.token.kind === 'bracketed' || tok.token.kind === 'quoted')
}

const tsqlNonFunctionKeywords = new Set([
  'NULL', 'DEFAULT', 'END', 'ASC', 'DESC', 'TIES', 'PERCENT', 'ONLY', 'ROW', 'ROWS',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER', 'CURRENT_DATE',
  'ALL', 'DISTINCT', 'TOP', 'TRUE', 'FALSE'
])

function hasSelectIntoInParens(
  tokens: readonly TSqlSigToken[],
  openIdx: number,
  getMatchingClose: () => Int32Array
): boolean {
  const closeIdx = getMatchingClose()[openIdx]
  const limit = closeIdx !== undefined && closeIdx >= 0 ? closeIdx : tokens.length
  for (let k = openIdx + 1; k < limit; k++) {
    const t = tokens[k]!
    if (t.token.kind === 'word' && t.upper === 'INTO' && tokens[k - 1]?.token.kind !== 'dot') {
      const prev = tokens[k - 1]
      const prevIsAs = prev?.token.kind === 'word' && prev.upper === 'AS' && tokens[k - 2]?.token.kind !== 'dot'
      if (!prevIsAs) return true
    }
  }
  return false
}

function isTSqlPagingOffsetParen(
  tokens: readonly TSqlSigToken[],
  openIdx: number,
  getMatchingClose: () => Int32Array
): boolean {
  const prev2 = openIdx > 1 ? tokens[openIdx - 2] : undefined
  if (!prev2) return false
  if (prev2.token.kind === 'comma' || isTSqlInfixOrPrefixOperator(prev2) || prev2.token.kind === 'open') return false
  if (prev2.token.kind === 'word' && tokens[openIdx - 3]?.token.kind !== 'dot'
    && (prev2.upper === 'AS' || prev2.upper === 'BY' || prev2.upper === 'SELECT')) {
    return false
  }
  const closeIdx = getMatchingClose()[openIdx]
  if (closeIdx === undefined || closeIdx < 0) return false
  if (hasSelectIntoInParens(tokens, openIdx, getMatchingClose)) return false
  let p = closeIdx + 1
  let caseDepth = 0
  while (p < tokens.length) {
    const t = tokens[p]!
    if (t.token.kind === 'open') {
      const nestedClose = getMatchingClose()[p]!
      if (nestedClose < 0) return false
      p = nestedClose + 1
      continue
    }
    if (t.token.kind === 'close' || t.token.kind === 'semicolon' || t.token.kind === 'sqlcmd') return false
    if (t.token.kind === 'word' && tokens[p - 1]?.token.kind !== 'dot') {
      if (t.upper === 'CASE') {
        caseDepth++
        p++
        continue
      }
      if (t.upper === 'END' && caseDepth > 0) {
        caseDepth--
        p++
        continue
      }
      if (caseDepth === 0) {
        if (t.upper === 'ROW' || t.upper === 'ROWS') return true
        if (t.upper === 'FROM' || t.upper === 'INTO' || t.upper === 'OFFSET' || tsqlStatementStarters.has(t.upper)) return false
      }
    }
    p++
  }
  return false
}

function isScalarFuncSubqueryOpen(
  tokens: readonly TSqlSigToken[],
  openIdx: number,
  peekIdx: number,
  getMatchingClose: () => Int32Array,
  inFromClause: boolean,
  allowAfterTop: boolean
): boolean {
  if (peekIdx <= openIdx + 1) return false
  const openTok = tokens[openIdx]!
  const prev = openIdx > 0 ? tokens[openIdx - 1] : undefined
  if (!isIdentToken(prev) || prev!.line !== openTok.line) return false
  if (hasSelectIntoInParens(tokens, openIdx, getMatchingClose)) return false
  const prev2 = openIdx > 1 ? tokens[openIdx - 2] : undefined
  if (!prev2) return false
  const p2Kind = prev2.token.kind
  if (prev!.token.kind === 'word' && p2Kind !== 'dot' && tsqlNonFunctionKeywords.has(prev!.upper)) return false
  if (allowAfterTop) return true
  if (p2Kind === 'dot') {
    // Walk back across qualified identifier chain (`ident . ident` / `ident .. ident`); reject `FROM|JOIN|APPLY` and comma-joined `FROM` tables.
    let head = openIdx - 1
    while (head > 0 && tokens[head - 1]?.token.kind === 'dot') {
      head--
      if (head > 0 && tokens[head - 1]?.token.kind === 'dot') head--
      if (head > 0 && isIdentToken(tokens[head - 1])) head--
      else break
    }
    const beforeChain = head > 0 ? tokens[head - 1] : undefined
    if (inFromClause && beforeChain?.token.kind === 'comma') return false
    const beforeChainDotted = head > 1 && tokens[head - 2]?.token.kind === 'dot'
    if (beforeChain?.token.kind === 'word' && !beforeChainDotted
      && (beforeChain.upper === 'FROM' || beforeChain.upper === 'JOIN' || beforeChain.upper === 'APPLY')) {
      return false
    }
    return true
  }
  if (p2Kind === 'comma') return !inFromClause
  if (isTSqlInfixOrPrefixOperator(prev2) || p2Kind === 'open') return true
  if (p2Kind === 'word') {
    if (openIdx > 2 && tokens[openIdx - 3]?.token.kind === 'dot') return false
    if (prev2.upper === 'AS' || prev2.upper === 'FROM' || prev2.upper === 'JOIN') return false
    return tsqlExprContinuationPrev.has(prev2.upper)
      || prev2.upper === 'IF' || prev2.upper === 'WHILE' || prev2.upper === 'SET' || prev2.upper === 'RETURN'
  }
  return false
}

interface CommaFromCache {
  end: number
  hasFrom: boolean
}

function commaHasTopLevelFrom(tokens: readonly TSqlSigToken[], startIdx: number, cache: CommaFromCache): boolean {
  if (startIdx >= cache.end) {
    let scan = startIdx
    let d = 0
    let caseDepth = 0
    let found = false
    while (scan < tokens.length) {
      const t = tokens[scan]!
      if (t.token.kind === 'open') d++
      else if (t.token.kind === 'close') {
        if (d === 0) break
        d--
      } else if (d === 0) {
        if (t.token.kind === 'semicolon' || t.token.kind === 'sqlcmd') break
        if (t.token.kind === 'word' && tokens[scan - 1]?.token.kind !== 'dot') {
          if (t.upper === 'CASE') {
            caseDepth++
          } else if (t.upper === 'END' && caseDepth > 0) {
            caseDepth--
          } else if (caseDepth === 0) {
            if (t.upper === 'FROM' && !(tokens[scan - 1]?.token.kind === 'word' && tokens[scan - 1]!.upper === 'DISTINCT' && tokens[scan - 2]?.token.kind !== 'dot')) {
              found = true
              break
            }
            if (t.upper === 'WHERE' || t.upper === 'GROUP' || t.upper === 'HAVING' || t.upper === 'ORDER'
              || t.upper === 'UNION' || t.upper === 'EXCEPT' || t.upper === 'INTERSECT'
              || t.upper === 'FOR' || t.upper === 'OPTION'
              || (t.upper !== 'WITH' && !tsqlNonReservedStarters.has(t.upper) && tsqlStatementStarters.has(t.upper))) {
              break
            }
            if (t.upper === 'RECEIVE' && scan > startIdx) {
              const prev = tokens[scan - 1]
              const prev2 = scan > 1 ? tokens[scan - 2] : undefined
              const prev3 = scan > 2 ? tokens[scan - 3] : undefined
              const prevWord = prev?.token.kind === 'word' && prev2?.token.kind !== 'dot' ? prev.upper : ''
              const prev2Word = prev2?.token.kind === 'word' && prev3?.token.kind !== 'dot' ? prev2.upper : ''
              const after = tokens[scan + 1]
              const isAliasAfter = after === undefined || after.token.kind === 'comma' || after.token.kind === 'close' || after.token.kind === 'semicolon'
                || isReceiveAliasFollowWord(tokens, scan + 1, false)
              if (isTSqlStmtBoundary(prev, prevWord, prev2Word) && !isAliasAfter) {
                break
              }
            }
          }
        }
      }
      scan++
    }
    cache.end = scan
    cache.hasFrom = found
  }
  return cache.hasFrom
}

const tsqlJoinHints = new Set(['LOOP', 'HASH', 'MERGE', 'REMOTE'])

function isReceiveAliasFollowWord(tokens: readonly TSqlSigToken[], wordIdx: number, disallowFromAndAs: boolean): boolean {
  const tok = tokens[wordIdx]
  if (!tok || tok.token.kind !== 'word' || !tsqlAliasFollowKeywords.has(tok.upper)) return false
  if (disallowFromAndAs && (tok.upper === 'FROM' || tok.upper === 'AS')) return false
  if (tok.upper === 'LEFT' || tok.upper === 'RIGHT') {
    const after = tokens[wordIdx + 1]
    if (after?.token.kind !== 'word') return false
    if (after.upper === 'JOIN' || after.upper === 'OUTER') return true
    return tsqlJoinHints.has(after.upper)
      && tokens[wordIdx + 2]?.token.kind === 'word'
      && tokens[wordIdx + 2]!.upper === 'JOIN'
  }
  return true
}

function isReceiveAliasFollower(
  tokens: readonly TSqlSigToken[],
  idx: number,
  prevKind: string | undefined,
  prevWord: string,
  inFromClause: boolean,
  commaFromCache: CommaFromCache,
  getMatchingClose: () => Int32Array
): boolean {
  const next = tokens[idx + 1]
  if (next === undefined || next.token.kind === 'comma' || next.token.kind === 'close' || next.token.kind === 'semicolon') return true
  if (isReceiveAliasFollowWord(tokens, idx + 1, false)) return true
  if (next.token.kind === 'word' && next.upper === 'WINDOW'
    && isIdentToken(tokens[idx + 2])
    && tokens[idx + 3]?.upper === 'AS'
    && tokens[idx + 4]?.token.kind === 'open') {
    return true
  }
  const isStandaloneParenSelectAt = (openPos: number): boolean => {
    let peek = openPos + 1
    while (peek < tokens.length && tokens[peek]!.token.kind === 'open') peek++
    if (tokens[peek]?.token.kind !== 'word' || tokens[peek]!.upper !== 'SELECT') return false
    const closeIdx = getMatchingClose()[openPos]
    return closeIdx !== undefined && closeIdx >= 0 && !commaHasTopLevelFrom(tokens, closeIdx + 1, commaFromCache)
  }
  if (next.token.kind === 'open' && isStandaloneParenSelectAt(idx + 1)) {
    return true
  }
  if ((prevKind === 'close' || prevWord === 'WITH') && next.token.kind === 'open') {
    // Validate a simple identifier/comma column list inside `(...)`.
    let p = idx + 2
    let expectId = true
    let count = 0
    while (p < tokens.length && tokens[p]!.token.kind !== 'close') {
      const tk = tokens[p]!.token.kind
      if (expectId) {
        if (tk !== 'word' && tk !== 'bracketed' && tk !== 'quoted') return false
        expectId = false
        count++
      } else {
        if (tk !== 'comma') return false
        expectId = true
      }
      p++
    }
    if (count === 0 || expectId || tokens[p]?.token.kind !== 'close') return false
    const afterParen = tokens[p + 1]
    if (prevWord === 'WITH') {
      return afterParen?.upper === 'AS' && tokens[p + 2]?.token.kind === 'open'
    }
    if (afterParen === undefined || afterParen.token.kind === 'close' || afterParen.token.kind === 'semicolon') return true
    if (afterParen.token.kind === 'open' && isStandaloneParenSelectAt(p + 1)) return true
    if (inFromClause && afterParen.token.kind === 'comma' && !commaHasTopLevelFrom(tokens, p + 2, commaFromCache)) return true
    if (isReceiveAliasFollowWord(tokens, p + 1, true)) return true
    if (afterParen.token.kind === 'word' && afterParen.upper === 'WINDOW'
      && isIdentToken(tokens[p + 2])
      && tokens[p + 3]?.upper === 'AS'
      && tokens[p + 4]?.token.kind === 'open') {
      return true
    }
    return false
  }
  return false
}

const compoundAssignLeft = new Set(['+', '-', '*', '/', '%', '&', '|', '^'])
const selectListEndKeywords = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION'])

function checkTSqlReadOnly(sql: string): ReadOnlyViolation[] {
  const tokens = lexSql(sql)
  const starts = lineStarts(sql)
  const batches = splitTSqlBatches(sql, tokens, starts)
  const violations: ReadOnlyViolation[] = []

  const pushViolation = (startOffset: number, endOffset: number, keyword: string, message: string) => {
    const span = spanAt(starts, startOffset, endOffset)
    violations.push({ ...span, keyword, message })
  }

  for (const batch of batches) {
    if (!batch.goValid && batch.goToken) {
      const endOffset = batch.goRepeatToken ? batch.goRepeatToken.end : batch.goToken.end
      pushViolation(batch.goToken.start, endOffset, 'GO', 'Only GO (repeat count 1) is allowed in Cross-Engine read-only mode.')
    } else if (batch.goCount > 1 && batch.goToken) {
      const endOffset = batch.goRepeatToken ? batch.goRepeatToken.end : batch.goToken.end
      pushViolation(batch.goToken.start, endOffset, 'GO', `GO repeat count (${batch.goCount}) is not allowed in Cross-Engine read-only mode.`)
    }

    // Split batch tokens into semicolon-separated statements.
    const statements: TSqlSigToken[][] = []
    let currentStmt: TSqlSigToken[] = []
    for (const sig of batch.tokens) {
      if (sig.token.kind === 'semicolon') {
        if (currentStmt.length > 0) {
          statements.push(currentStmt)
          currentStmt = []
        }
      } else {
        currentStmt.push(sig)
      }
    }
    if (currentStmt.length > 0) statements.push(currentStmt)

    for (const stmt of statements) {
      // First non-`(` token must be SELECT or WITH.
      let firstIdx = 0
      while (firstIdx < stmt.length && stmt[firstIdx]!.token.kind === 'open') firstIdx++
      const first = stmt[firstIdx]
      if (!first) {
        const openTok = stmt[0]!
        pushViolation(openTok.token.start, openTok.token.end, openTok.text, `Only SELECT and WITH statements are allowed in Cross-Engine read-only mode (found ${openTok.text}).`)
        continue
      }
      if (first.token.kind === 'sqlcmd') {
        pushViolation(first.token.start, first.token.end, 'SQLCMD', 'SQLCMD directives are not allowed in Cross-Engine read-only mode.')
        continue
      }
      if (first.token.kind !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
        const kw = first.token.kind === 'word' ? first.upper : first.text
        pushViolation(first.token.start, first.token.end, kw, `Only SELECT and WITH statements are allowed in Cross-Engine read-only mode (found ${kw}).`)
        continue
      }

      // Track SelectSetVariable (SELECT @v = ...) per paren depth.
      interface SelectScope {
        readonly depth: number
        expectItemStart: boolean
        awaitingTopArg: boolean
        topParenSeen: boolean
      }
      const selectScopes: SelectScope[] = []
      const offsetSeenAtDepth = new Set<number>()
      const orderBySeenAtDepth = new Set<number>()
      const inFromClauseAtDepth = new Set<number>()
      const commaFromCache: CommaFromCache = { end: -1, hasFrom: false }
      let stmtMatchingClose: Int32Array | null = null
      const getStmtMatchingClose = () => (stmtMatchingClose ??= buildMatchingClose(stmt))
      let optionParenDepth: number | null = null
      const caseDepthAtDepth: number[] = [0]
      let depth = 0

      for (let i = 0; i < stmt.length; i++) {
        const cur = stmt[i]!
        const prev = i > 0 ? stmt[i - 1] : undefined
        const prev2 = i > 1 ? stmt[i - 2] : undefined
        const prev3 = i > 2 ? stmt[i - 3] : undefined
        const next = i + 1 < stmt.length ? stmt[i + 1] : undefined
        const afterDot = prev?.token.kind === 'dot'
        const prevWord = prev?.token.kind === 'word' && prev2?.token.kind !== 'dot' ? prev.upper : ''
        const prev2Word = prev2?.token.kind === 'word' && prev3?.token.kind !== 'dot' ? prev2.upper : ''

        if (cur.token.kind === 'sqlcmd') {
          pushViolation(cur.token.start, cur.token.end, 'SQLCMD', 'SQLCMD directives are not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.token.kind === 'colon' && depth === 0) {
          pushViolation(cur.token.start, cur.token.end, ':', 'Statement labels (:) are not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.token.kind === 'open') {
          depth++
          caseDepthAtDepth.push(0)
          if (prevWord === 'OPTION' && optionParenDepth === null) {
            optionParenDepth = depth
          }
          const topScope = selectScopes[selectScopes.length - 1]
          if (topScope && depth === topScope.depth + 1) {
            if (topScope.awaitingTopArg && !topScope.topParenSeen) {
              topScope.topParenSeen = true
            } else if (topScope.expectItemStart) {
              topScope.expectItemStart = false
            }
          }
          continue
        }

        if (cur.token.kind === 'close') {
          offsetSeenAtDepth.delete(depth)
          orderBySeenAtDepth.delete(depth)
          inFromClauseAtDepth.delete(depth)
          if (optionParenDepth !== null && depth === optionParenDepth) {
            optionParenDepth = null
          }
          while (selectScopes.length > 0 && selectScopes[selectScopes.length - 1]!.depth >= depth) {
            selectScopes.pop()
          }
          const topScope = selectScopes[selectScopes.length - 1]
          if (topScope && topScope.awaitingTopArg && topScope.topParenSeen && depth === topScope.depth + 1) {
            if (next?.token.kind === 'word' && (next.upper === 'PERCENT' || next.upper === 'WITH')) {
              topScope.topParenSeen = false
            } else {
              topScope.awaitingTopArg = false
              topScope.expectItemStart = true
            }
          }
          if (depth > 0) {
            caseDepthAtDepth.pop()
            depth--
          }
          continue
        }

        const curCaseDepth = caseDepthAtDepth[depth] ?? 0
        const topScope = selectScopes[selectScopes.length - 1]
        if (topScope && topScope.depth === depth) {
          if (cur.token.kind === 'comma') {
            topScope.expectItemStart = true
            topScope.awaitingTopArg = false
            continue
          }
          if (cur.token.kind === 'word' && !afterDot) {
            if (topScope.expectItemStart && (cur.upper === 'ALL' || cur.upper === 'DISTINCT')) {
              continue
            }
            if (topScope.expectItemStart && cur.upper === 'TOP') {
              topScope.awaitingTopArg = true
              topScope.topParenSeen = false
              topScope.expectItemStart = false
              continue
            }
            if (topScope.awaitingTopArg) {
              if (cur.upper === 'PERCENT') {
                if (next?.token.kind !== 'word' || next.upper !== 'WITH') {
                  topScope.awaitingTopArg = false
                  topScope.expectItemStart = true
                }
                continue
              }
              if (cur.upper === 'WITH') continue
              if (cur.upper === 'TIES') {
                topScope.awaitingTopArg = false
                topScope.expectItemStart = true
                continue
              }
              topScope.awaitingTopArg = false
              topScope.expectItemStart = true
            }
            const isWindowClause = cur.upper === 'WINDOW'
              && prevWord !== 'AS'
              && isIdentToken(next)
              && stmt[i + 2]?.upper === 'AS'
              && stmt[i + 3]?.token.kind === 'open'
            const isWithinGroup = cur.upper === 'GROUP' && prevWord === 'WITHIN'
            if (curCaseDepth === 0 && ((!isWithinGroup && selectListEndKeywords.has(cur.upper)) || isWindowClause)) {
              selectScopes.pop()
            }
          } else if (topScope.awaitingTopArg && !topScope.topParenSeen && cur.token.kind === 'number') {
            // TOP <number> [PERCENT] [WITH TIES]
            if (next?.token.kind !== 'word' || (next.upper !== 'PERCENT' && next.upper !== 'WITH')) {
              topScope.awaitingTopArg = false
              topScope.expectItemStart = true
            }
            continue
          }
        }

        if (cur.token.kind === 'variable' && topScope && topScope.depth === depth && topScope.expectItemStart) {
          topScope.expectItemStart = false
          let opIdx = i + 1
          while (stmt[opIdx]?.token.kind === 'dot' && isIdentToken(stmt[opIdx + 1])) opIdx += 2
          const op1 = stmt[opIdx]
          const op2 = stmt[opIdx + 1]
          const isPlainAssign = op1?.token.kind === 'operator' && op1.text === '='
          const isCompoundAssign = op1?.token.kind === 'operator' && compoundAssignLeft.has(op1.text)
            && op2?.token.kind === 'operator' && op2.text === '=' && op1.token.end === op2.token.start
          if (isPlainAssign || isCompoundAssign) {
            const opEnd = isCompoundAssign ? op2!.token.end : op1!.token.end
            pushViolation(cur.token.start, opEnd, 'SELECT_ASSIGN', `Variable assignment (${cur.text} =) is not allowed in Cross-Engine read-only mode.`)
          }
          continue
        }

        if (topScope && topScope.depth === depth && cur.token.kind !== 'word') {
          topScope.expectItemStart = false
        }

        if (cur.token.kind !== 'word' || afterDot) {
          continue
        }

        if (cur.upper === 'SELECT') {
          offsetSeenAtDepth.delete(depth)
          orderBySeenAtDepth.delete(depth)
          inFromClauseAtDepth.delete(depth)
          if (topScope && topScope.depth === depth) {
            selectScopes[selectScopes.length - 1] = { depth, expectItemStart: true, awaitingTopArg: false, topParenSeen: false }
          } else if (!topScope || topScope.depth < depth) {
            selectScopes.push({ depth, expectItemStart: true, awaitingTopArg: false, topParenSeen: false })
          }
          continue
        }

        if (curCaseDepth === 0) {
          if (cur.upper === 'FROM' && prevWord !== 'DISTINCT') inFromClauseAtDepth.add(depth)
          else if (cur.upper === 'WHERE' || (cur.upper === 'GROUP' && prevWord !== 'WITHIN') || cur.upper === 'HAVING' || cur.upper === 'ORDER'
            || cur.upper === 'UNION' || cur.upper === 'EXCEPT' || cur.upper === 'INTERSECT'
            || (cur.upper === 'FOR' && next?.upper !== 'SYSTEM_TIME') || cur.upper === 'OPTION'
            || (cur.upper === 'WINDOW' && isIdentToken(next) && stmt[i + 2]?.upper === 'AS' && stmt[i + 3]?.token.kind === 'open')) {
            inFromClauseAtDepth.delete(depth)
          }
          if (cur.upper === 'ORDER' && next?.upper === 'BY') {
            orderBySeenAtDepth.add(depth)
          } else if (cur.upper === 'UNION' || cur.upper === 'EXCEPT' || cur.upper === 'INTERSECT') {
            orderBySeenAtDepth.delete(depth)
            offsetSeenAtDepth.delete(depth)
          }
        }

        const atSelectItemStart = !!(topScope && topScope.depth === depth && topScope.expectItemStart)
        if (atSelectItemStart) {
          topScope!.expectItemStart = false
        }

        if (cur.upper === 'CASE') {
          caseDepthAtDepth[depth] = curCaseDepth + 1
          continue
        }

        if (cur.upper === 'OFFSET' && curCaseDepth === 0 && orderBySeenAtDepth.has(depth)
          && prev?.token.kind !== 'comma' && !isTSqlInfixOrPrefixOperator(prev)
          && prevWord !== 'BY' && prevWord !== 'AS' && prevWord !== 'SELECT') {
          offsetSeenAtDepth.add(depth)
          continue
        }

        // Allow OPTION (USE HINT(...)), OPTION (USE PLAN N'...'), OPTION (MERGE JOIN|UNION), and INNER/LEFT/RIGHT/FULL/OUTER MERGE JOIN.
        if (cur.upper === 'USE' && optionParenDepth !== null && depth >= optionParenDepth && (next?.upper === 'HINT' || next?.upper === 'PLAN')) {
          continue
        }
        if (cur.upper === 'MERGE' && (isTSqlMergeJoinHint(prevWord, next)
          || (optionParenDepth !== null && depth >= optionParenDepth && next?.token.kind === 'word' && (next.upper === 'JOIN' || next.upper === 'UNION')))) {
          continue
        }

        if (tsqlBlockedKeywords.has(cur.upper)) {
          pushViolation(cur.token.start, cur.token.end, cur.upper, `${cur.upper} is not allowed in Cross-Engine read-only mode.`)
          continue
        }

        const atPossibleStmtBoundary = depth === 0 && !atSelectItemStart && isTSqlStmtBoundary(prev, prevWord, prev2Word)

        if ((cur.upper === 'DISABLE' || cur.upper === 'ENABLE') && next?.token.kind === 'word' && next.upper === 'TRIGGER') {
          pushViolation(cur.token.start, next.token.end, `${cur.upper} TRIGGER`, `${cur.upper} TRIGGER is not allowed in Cross-Engine read-only mode.`)
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'SEND' && next?.token.kind === 'word' && next.upper === 'ON' && stmt[i + 2]?.upper === 'CONVERSATION'
          && isSendConversationHandle(stmt, i)) {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'SEND ON CONVERSATION', 'SEND ON CONVERSATION is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'MOVE' && next?.token.kind === 'word' && next.upper === 'CONVERSATION') {
          pushViolation(cur.token.start, next.token.end, 'MOVE CONVERSATION', 'MOVE CONVERSATION is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'GET' && next?.token.kind === 'word' && next.upper === 'CONVERSATION' && stmt[i + 2]?.token.kind === 'word' && stmt[i + 2]!.upper === 'GROUP') {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'GET CONVERSATION GROUP', 'GET CONVERSATION GROUP is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'ADD' && next?.token.kind === 'word' && next.upper === 'SIGNATURE') {
          pushViolation(cur.token.start, next.token.end, 'ADD SIGNATURE', 'ADD SIGNATURE is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'ADD' && next?.token.kind === 'word' && next.upper === 'COUNTER' && stmt[i + 2]?.token.kind === 'word' && stmt[i + 2]!.upper === 'SIGNATURE') {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'ADD COUNTER SIGNATURE', 'ADD COUNTER SIGNATURE is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (atPossibleStmtBoundary && cur.upper === 'ADD' && next?.token.kind === 'word' && next.upper === 'SENSITIVITY' && stmt[i + 2]?.token.kind === 'word' && stmt[i + 2]!.upper === 'CLASSIFICATION') {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'ADD SENSITIVITY CLASSIFICATION', 'ADD SENSITIVITY CLASSIFICATION is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.upper === 'RECEIVE' && atPossibleStmtBoundary && !isReceiveAliasFollower(stmt, i, prev?.token.kind, prevWord, inFromClauseAtDepth.has(depth), commaFromCache, getStmtMatchingClose)) {
          pushViolation(cur.token.start, cur.token.end, 'RECEIVE', 'Service Broker RECEIVE is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.upper === 'THROW' && atPossibleStmtBoundary && next !== undefined && (next.token.kind === 'number' || next.token.kind === 'variable')) {
          pushViolation(cur.token.start, cur.token.end, 'THROW', 'THROW is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.upper === 'NEXT' && next?.token.kind === 'word' && next.upper === 'VALUE' && stmt[i + 2]?.token.kind === 'word' && stmt[i + 2]!.upper === 'FOR'
          && !(inFromClauseAtDepth.has(depth)
            && stmt[i + 3]?.token.kind === 'word' && (stmt[i + 3]!.upper === 'JSON' || stmt[i + 3]!.upper === 'XML' || stmt[i + 3]!.upper === 'BROWSE')
            && ((prevWord === 'FROM' && prev2Word !== 'DISTINCT') || prevWord === 'JOIN' || prev?.token.kind === 'comma'
              || (prevWord === 'APPLY' && (prev2Word === 'CROSS' || prev2Word === 'OUTER'))))) {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'NEXT VALUE FOR', 'NEXT VALUE FOR is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.upper === 'FETCH') {
          const hadOffset = curCaseDepth === 0 && offsetSeenAtDepth.has(depth)
          if (curCaseDepth === 0) offsetSeenAtDepth.delete(depth)
          if (hadOffset && (prevWord === 'ROW' || prevWord === 'ROWS') && isTSqlPagingFetch(stmt, i, getStmtMatchingClose)) {
            // Valid OFFSET ... ROW[S] FETCH NEXT|FIRST <expr> ROW[S] ONLY pagination.
          } else {
            pushViolation(cur.token.start, cur.token.end, 'FETCH', 'Cursor FETCH is not allowed in Cross-Engine read-only mode.')
          }
          continue
        }

        if (cur.upper === 'END') {
          if (curCaseDepth > 0) {
            caseDepthAtDepth[depth] = curCaseDepth - 1
            continue
          }
          if (next?.token.kind === 'word' && (next.upper === 'CASE' || next.upper === 'CONVERSATION')) {
            pushViolation(cur.token.start, next.token.end, `END ${next.upper}`, `END ${next.upper} is not allowed in Cross-Engine read-only mode.`)
          }
        }
      }
    }
  }

  return violations
}

function checkBigQueryReadOnly(sql: string): ReadOnlyViolation[] {
  const starts = lineStarts(sql)
  const rawTokens = scanGoogleSql(sql)
  const sig: BqSigToken[] = []
  for (const token of rawTokens) {
    if (token.kind === 'whitespace' || token.kind === 'comment') continue
    const text = sql.slice(token.start, token.end)
    sig.push({
      token,
      text,
      upper: token.kind === 'word' ? text.toUpperCase() : '',
      line: positionAt(starts, token.start).line
    })
  }

  const violations: ReadOnlyViolation[] = []
  const pushViolation = (startOffset: number, endOffset: number, keyword: string, message: string) => {
    const span = spanAt(starts, startOffset, endOffset)
    violations.push({ ...span, keyword, message })
  }

  // Split into statements by `;` (GoogleSQL requires `;` between statements and forbids DML/DDL/procedural blocks inside SELECT/WITH).
  const statements: BqSigToken[][] = []
  let current: BqSigToken[] = []
  for (const t of sig) {
    if (t.text === ';') {
      if (current.length > 0) {
        statements.push(current)
        current = []
      }
    } else {
      current.push(t)
    }
  }
  if (current.length > 0) statements.push(current)

  if (statements.length === 0) return violations

  const firstStmt = statements[0]!
  let firstIdx = 0
  while (firstIdx < firstStmt.length && firstStmt[firstIdx]!.text === '(') firstIdx++
  const first = firstStmt[firstIdx]
  if (!first) {
    const openTok = firstStmt[0]!
    pushViolation(openTok.token.start, openTok.token.end, openTok.text, `Only a single SELECT or WITH statement is allowed in Cross-Engine BigQuery mode (found ${openTok.text}).`)
  } else if (first.token.kind !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    const kw = first.token.kind === 'word' ? first.upper : first.text
    pushViolation(first.token.start, first.token.end, kw, `Only a single SELECT or WITH statement is allowed in Cross-Engine BigQuery mode (found ${kw}).`)
  } else if (first.upper === 'WITH') {
    const resolved = resolveBigQueryWithMain(firstStmt, firstIdx)
    if (resolved.verb !== 'SELECT') {
      const targetTok = resolved.token ?? first
      pushViolation(targetTok.token.start, targetTok.token.end, resolved.verb, `Only a single SELECT or WITH ... SELECT statement is allowed in Cross-Engine BigQuery mode (found ${resolved.verb}).`)
    }
  }

  for (let sIdx = 1; sIdx < statements.length; sIdx++) {
    const extra = statements[sIdx]![0]!
    pushViolation(extra.token.start, extra.token.end, 'MULTI_STATEMENT', 'Cross-Engine BigQuery supports a single SELECT or WITH statement only.')
  }

  return violations
}

export function checkCrossEngineReadOnly(sql: string, dialect: ProviderId): ReadOnlyViolation[] {
  if (!hasExecutableSql(sql, dialect)) return []
  return dialect === 'bigquery' ? checkBigQueryReadOnly(sql) : checkTSqlReadOnly(sql)
}
