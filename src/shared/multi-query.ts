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

const dialectDirectivePrefix = /^\s*--\s*#Dialect\b/i
const dialectHeaderPattern = /^\s*--\s*#Dialect\s*=\s*"([^"]*)"\s*$/i

export function parseCrossEngineSql(text: string): ParseCrossEngineResult {
  const lines = splitTextLines(text)
  const headers: { readonly dialect: ProviderId; readonly lineInfo: TextLine }[] = []

  for (const lineInfo of lines) {
    const lineText = text.slice(lineInfo.start, lineInfo.contentEnd)
    if (!dialectDirectivePrefix.test(lineText)) continue
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
  }

  if (headers.length < 2) {
    return { ok: false, reason: 'Both -- #Dialect="sqlserver" and -- #Dialect="bigquery" headers are required.' }
  }

  const first = headers[0]!
  const second = headers[1]!
  const preamble = text.slice(0, first.lineInfo.start)
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
  if (trailing[0]!.kind === 'colon') {
    // GO: is a T-SQL label, not a batch delimiter.
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
}

function splitTSqlBatches(sql: string, tokens: readonly SqlToken[], starts: readonly number[]): TSqlBatch[] {
  const batches: TSqlBatch[] = []
  let current: TSqlSigToken[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'word' && sql.slice(token.start, token.end).toUpperCase() === 'GO') {
      const go = inspectTSqlGoLine(sql, tokens, i)
      if (go.isGo) {
        let repeatToken: SqlToken | undefined
        for (let j = i + 1; j <= go.lastLineTokenIndex; j++) {
          const candidate = tokens[j]!
          if (isSignificant(candidate)) {
            repeatToken = candidate
            break
          }
        }
        batches.push({
          tokens: current,
          goCount: go.repeatCount,
          goToken: token,
          goRepeatToken: repeatToken,
          goValid: go.valid
        })
        current = []
        i = go.lastLineTokenIndex
        continue
      }
    }
    if (isSignificant(token)) {
      const text = sql.slice(token.start, token.end)
      current.push({
        token,
        text,
        upper: token.kind === 'word' ? text.toUpperCase() : '',
        line: positionAt(starts, token.start).line
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
    if (batch.tokens.some(t => t.token.kind !== 'semicolon')) return true
  }
  return false
}

const tsqlStatementStarters = new Set([
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END',
  'COMMIT', 'ROLLBACK', 'SAVE', 'THROW', 'RAISERROR', 'PRINT', 'RETURN',
  'WAITFOR', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'BREAK', 'CONTINUE', 'GOTO',
  'BACKUP', 'RESTORE', 'RECONFIGURE', 'DBCC', 'SHUTDOWN', 'KILL',
  'USE', 'GRANT', 'REVOKE', 'DENY', 'CHECKPOINT', 'SETUSER', 'SEND',
  'WRITETEXT', 'UPDATETEXT', 'READTEXT'
])

const tsqlNonTransactionalAdmin = new Set(['BACKUP', 'RESTORE', 'RECONFIGURE', 'DBCC', 'SHUTDOWN', 'KILL'])
const tsqlAdmin = new Set(['USE', 'GRANT', 'REVOKE', 'DENY', 'CHECKPOINT', 'SETUSER', 'SEND', 'WRITETEXT', 'UPDATETEXT', 'READTEXT'])
const tsqlProcedural = new Set(['DECLARE', 'SET', 'EXEC', 'EXECUTE', 'WAITFOR', 'THROW', 'RAISERROR', 'PRINT', 'RETURN', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'BREAK', 'CONTINUE', 'GOTO'])

function isTSqlNonTransactionalDdl(words: readonly string[]): boolean {
  const [w0, w1, w2, w3] = words
  if (w0 !== 'CREATE' && w0 !== 'ALTER' && w0 !== 'DROP') return false
  if (w1 === 'DATABASE') return true
  if (w0 === 'ALTER' && w1 === 'SERVER' && w2 === 'CONFIGURATION') return true
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
  const nonEmptyBatches = rawBatches.filter(b => b.tokens.some(t => t.token.kind !== 'semicolon'))
  const statements: ClassifiedStatement[] = []

  for (let bIdx = 0; bIdx < nonEmptyBatches.length; bIdx++) {
    const batch = nonEmptyBatches[bIdx]!.tokens
    const batchNum = bIdx + 1
    const blockStack: { readonly kind: 'begin' | 'try' | 'catch'; readonly conditional: boolean }[] = []
    let pendingConditional = false
    let i = 0

    const isConditionalNow = () => pendingConditional || blockStack.some(b => b.conditional)

    const consumeCondition = () => {
      let depth = 0
      while (i < batch.length) {
        const cur = batch[i]!
        const prevKind = i > 0 ? batch[i - 1]!.token.kind : undefined
        if (cur.token.kind === 'open') depth++
        else if (cur.token.kind === 'close') { if (depth > 0) depth-- }
        else if (depth === 0) {
          if (cur.token.kind === 'semicolon') break
          if (cur.token.kind === 'word' && prevKind !== 'dot' && tsqlStatementStarters.has(cur.upper)) break
        }
        i++
      }
    }

    const consumeSelect = () => {
      let depth = 0
      let prevUpper = ''
      let justStarted = true
      while (i < batch.length) {
        const cur = batch[i]!
        const prevKind = i > 0 ? batch[i - 1]!.token.kind : undefined
        const afterDot = prevKind === 'dot'
        if (cur.token.kind === 'open') depth++
        else if (cur.token.kind === 'close') { if (depth > 0) depth-- }
        else if (depth === 0) {
          if (cur.token.kind === 'semicolon') { i++; break }
          if (cur.token.kind === 'sqlcmd') break
          if (cur.token.kind === 'word' && !justStarted && !afterDot) {
            if (cur.upper === 'SELECT' && prevUpper !== 'UNION' && prevUpper !== 'EXCEPT' && prevUpper !== 'INTERSECT' && prevUpper !== 'ALL') break
            if (cur.upper !== 'SELECT' && cur.upper !== 'OPEN' && cur.upper !== 'FOR' && cur.upper !== 'SET' && tsqlStatementStarters.has(cur.upper)) break
          }
        }
        prevUpper = cur.token.kind === 'word' && !afterDot ? cur.upper : ''
        justStarted = false
        i++
      }
    }

    const consumeUntilNextStatement = (mode: 'dml' | 'ddl' | 'merge' | 'generic') => {
      let depth = 0
      let prevUpper = ''
      let justStarted = true
      while (i < batch.length) {
        const cur = batch[i]!
        const prevKind = i > 0 ? batch[i - 1]!.token.kind : undefined
        const afterDot = prevKind === 'dot'
        if (cur.token.kind === 'open') depth++
        else if (cur.token.kind === 'close') { if (depth > 0) depth-- }
        else if (depth === 0) {
          if (cur.token.kind === 'semicolon') { i++; break }
          if (cur.token.kind === 'sqlcmd') break
          if (cur.token.kind === 'word' && !justStarted && !afterDot && tsqlStatementStarters.has(cur.upper)) {
            if (mode === 'ddl' && prevUpper === 'ON' && (cur.upper === 'DELETE' || cur.upper === 'UPDATE')) {
              // Referential action (ON DELETE / ON UPDATE) inside DDL.
            } else if (mode === 'ddl' && (cur.upper === 'SET' || cur.upper === 'EXECUTE')) {
              // e.g. SET OPTION / EXECUTE AS inside DDL.
            } else if (mode === 'dml' && (cur.upper === 'SELECT' || cur.upper === 'WITH' || cur.upper === 'EXEC' || cur.upper === 'EXECUTE' || cur.upper === 'SET')) {
              // e.g. INSERT INTO ... SELECT / UPDATE ... SET.
            } else if (mode === 'merge' && (cur.upper === 'INSERT' || cur.upper === 'UPDATE' || cur.upper === 'DELETE' || cur.upper === 'SET' || cur.upper === 'SELECT' || cur.upper === 'WITH')) {
              // MERGE WHEN MATCHED THEN UPDATE/DELETE/INSERT.
            } else {
              break
            }
          }
        }
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
          consumeSelect()
          statements.push({
            category: 'select', keyword: 'SELECT', line: startLine, batch: batchNum,
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
        if (nextUpper === 'TRY') {
          blockStack.push({ kind: 'try', conditional: pendingConditional })
          pendingConditional = false
          i += 2
          continue
        }
        if (nextUpper === 'CATCH') {
          blockStack.push({ kind: 'catch', conditional: true })
          pendingConditional = false
          i += 2
          continue
        }
        blockStack.push({ kind: 'begin', conditional: pendingConditional })
        pendingConditional = false
        i++
        continue
      }
      if (cur.upper === 'END') {
        const nextUpper = batch[i + 1]?.upper ?? ''
        if (nextUpper === 'TRY' || nextUpper === 'CATCH') i += 2
        else i++
        if (blockStack.length > 0) blockStack.pop()
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
        while (scan < batch.length) {
          const t = batch[scan]!
          if (t.token.kind === 'open') depth++
          else if (t.token.kind === 'close') { if (depth > 0) depth-- }
          else if (depth === 0 && batch[scan - 1]?.token.kind !== 'dot') {
            if (t.token.kind === 'semicolon') break
            if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE') {
              mainUpper = t.upper
              break
            }
          }
          scan++
        }
        i = scan < batch.length ? scan : i + 1
      }

      if (mainUpper === 'SELECT') {
        consumeSelect()
        statements.push({
          category: 'select', keyword: 'SELECT', line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'INSERT' || mainUpper === 'UPDATE' || mainUpper === 'DELETE' || mainUpper === 'MERGE') {
        consumeUntilNextStatement(mainUpper === 'MERGE' ? 'merge' : 'dml')
        statements.push({
          category: 'dml', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (mainUpper === 'CREATE' || mainUpper === 'ALTER' || mainUpper === 'DROP' || mainUpper === 'TRUNCATE') {
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
        const keyword = objWord ? `${mainUpper} ${objWord === 'PROC' ? 'PROCEDURE' : objWord}` : mainUpper
        const nonTx = isTSqlNonTransactionalDdl(headerWords)
        if ((mainUpper === 'CREATE' || mainUpper === 'ALTER') && (objWord === 'PROC' || objWord === 'PROCEDURE' || objWord === 'FUNCTION' || objWord === 'TRIGGER')) {
          i = batch.length
        } else if ((mainUpper === 'CREATE' || mainUpper === 'ALTER') && objWord === 'VIEW') {
          consumeUntilNextStatement('dml')
        } else {
          consumeUntilNextStatement('ddl')
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
        consumeUntilNextStatement('generic')
        statements.push({
          category: 'admin', keyword: mainUpper, line: startLine, batch: batchNum,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: false
        })
        continue
      }

      if (tsqlProcedural.has(mainUpper)) {
        consumeUntilNextStatement('generic')
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

  return buildClassification('sqlserver', nonEmptyBatches.length, statements)
}

interface BqSigToken {
  readonly token: GoogleSqlToken
  readonly text: string
  readonly upper: string
  readonly line: number
}

const bqBlockEnders = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CASE'])

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
  const blockStack: { readonly kind: string; readonly conditional: boolean }[] = []
  let i = 0

  const isConditionalNow = () => blockStack.some(b => b.conditional)

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

  const consumeBeginEndBody = () => {
    // Expects i positioned at BEGIN; consumes matching END (and optional trailing ;).
    let beginDepth = 0
    while (i < sig.length) {
      const t = sig[i]!
      if (t.token.kind === 'word' && sig[i - 1]?.text !== '.') {
        if (t.upper === 'BEGIN' && sig[i + 1]?.upper !== 'TRANSACTION' && sig[i + 1]?.upper !== 'TRAN') {
          beginDepth++
        } else if (t.upper === 'CASE') {
          beginDepth++
        } else if (t.upper === 'END') {
          const next = sig[i + 1]
          if (next?.token.kind === 'word' && bqBlockEnders.has(next.upper)) {
            i++
            if (next.upper === 'CASE' && beginDepth > 0) {
              beginDepth--
            } else {
              // END IF / END WHILE / END FOR / END LOOP / END REPEAT close blocks we did not push onto beginDepth.
              i++
              continue
            }
          } else if (beginDepth > 0) {
            beginDepth--
          }
          if (beginDepth === 0) {
            i++
            if (sig[i]?.text === ';') i++
            break
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

    if (cur.upper === 'IF' || cur.upper === 'ELSEIF') {
      i++
      let depth = 0
      while (i < sig.length) {
        const t = sig[i]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0 && t.upper === 'THEN' && sig[i - 1]?.text !== '.') { i++; break }
        i++
      }
      if (cur.upper === 'IF') blockStack.push({ kind: 'IF', conditional: true })
      continue
    }
    if (cur.upper === 'ELSE') {
      i++
      continue
    }
    if (cur.upper === 'WHILE' || cur.upper === 'FOR') {
      const kind = cur.upper
      i++
      let depth = 0
      while (i < sig.length) {
        const t = sig[i]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0 && t.upper === 'DO' && sig[i - 1]?.text !== '.') { i++; break }
        i++
      }
      blockStack.push({ kind, conditional: true })
      continue
    }
    if (cur.upper === 'LOOP' || cur.upper === 'REPEAT') {
      blockStack.push({ kind: cur.upper, conditional: true })
      i++
      continue
    }
    if (cur.upper === 'UNTIL') {
      consumeToSemicolon()
      continue
    }
    if (cur.upper === 'BEGIN') {
      const nextUpper = sig[i + 1]?.upper ?? ''
      if (nextUpper === 'TRANSACTION' || nextUpper === 'TRAN') {
        const line = cur.line
        const cond = isConditionalNow()
        consumeToSemicolon()
        statements.push({
          category: 'transaction', keyword: 'BEGIN TRANSACTION', line, batch: 1,
          conditional: cond, nonTransactional: false, permanentDdl: false, blocksBigQueryTransaction: true
        })
        continue
      }
      blockStack.push({ kind: 'BEGIN', conditional: false })
      i++
      continue
    }
    if (cur.upper === 'CASE') {
      blockStack.push({ kind: 'CASE', conditional: true })
      i++
      while (i < sig.length) {
        const t = sig[i]!
        if (t.upper === 'WHEN' || t.upper === 'ELSE' || t.upper === 'END') break
        i++
      }
      continue
    }
    if (cur.upper === 'WHEN') {
      i++
      while (i < sig.length) {
        if (sig[i]!.upper === 'THEN') { i++; break }
        i++
      }
      continue
    }
    if (cur.upper === 'END') {
      const nextUpper = sig[i + 1]?.upper ?? ''
      if (bqBlockEnders.has(nextUpper)) i += 2
      else i++
      if (sig[i]?.text === ';') i++
      if (blockStack.length > 0) blockStack.pop()
      continue
    }

    const startLine = cur.line
    const cond = isConditionalNow()
    let mainUpper = cur.upper

    if (mainUpper === 'WITH') {
      let scan = i + 1
      let depth = 0
      while (scan < sig.length) {
        const t = sig[scan]!
        if (t.text === '(') depth++
        else if (t.text === ')') { if (depth > 0) depth-- }
        else if (depth === 0 && sig[scan - 1]?.text !== '.') {
          if (t.text === ';') break
          if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE') {
            mainUpper = t.upper
            break
          }
        }
        scan++
      }
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

    if (mainUpper === 'CREATE' || mainUpper === 'ALTER' || mainUpper === 'DROP' || mainUpper === 'UNDROP' || mainUpper === 'TRUNCATE') {
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
      const kindLabel = objWord === 'MATERIALIZED' && secondObj === 'VIEW'
        ? 'MATERIALIZED VIEW'
        : objWord === 'EXTERNAL' && secondObj === 'TABLE'
          ? 'EXTERNAL TABLE'
          : objWord === 'TABLE' && secondObj === 'FUNCTION'
            ? 'TABLE FUNCTION'
            : objWord
      const keyword = kindLabel ? `${mainUpper}${isTemp ? ' TEMP' : ''} ${kindLabel}` : mainUpper

      let permanentDdl = false
      let blocksTx = false
      if (mainUpper === 'TRUNCATE') {
        permanentDdl = false
        blocksTx = false
      } else if (mainUpper === 'CREATE' && isTemp && objWord === 'TABLE') {
        permanentDdl = false
        blocksTx = false
      } else if (mainUpper === 'CREATE' && isTemp && (objWord === 'FUNCTION' || kindLabel === 'TABLE FUNCTION')) {
        permanentDdl = false
        blocksTx = true
      } else if (mainUpper === 'DROP') {
        // Check target for _SESSION.<name>.
        let targetIdx = probe + (kindLabel.includes(' ') ? 2 : 1)
        if (sig[targetIdx]?.upper === 'IF' && sig[targetIdx + 1]?.upper === 'EXISTS') targetIdx += 2
        const firstPart = sig[targetIdx]?.text.replaceAll('`', '').toUpperCase() ?? ''
        const isSession = (firstPart === '_SESSION' && sig[targetIdx + 1]?.text === '.') || firstPart.startsWith('_SESSION.')
        permanentDdl = !isSession
        blocksTx = !isSession
      } else {
        permanentDdl = true
        blocksTx = true
      }

      if (mainUpper === 'CREATE' && objWord === 'PROCEDURE') {
        // Skip header until BEGIN or ;
        let depth = 0
        while (i < sig.length) {
          const t = sig[i]!
          if (t.text === '(') depth++
          else if (t.text === ')') { if (depth > 0) depth-- }
          else if (depth === 0) {
            if (t.text === ';') { i++; break }
            if (t.upper === 'BEGIN') { consumeBeginEndBody(); break }
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

    if ((mainUpper === 'EXPORT' || mainUpper === 'LOAD') && sig[i + 1]?.upper === 'DATA') {
      consumeToSemicolon()
      statements.push({
        category: 'admin', keyword: `${mainUpper} DATA`, line: startLine, batch: 1,
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

    if (mainUpper === 'GRANT' || mainUpper === 'REVOKE' || mainUpper === 'EXPLAIN' || mainUpper === 'DESCRIBE' || mainUpper === 'ANALYZE') {
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
  'EXEC', 'EXECUTE', 'CALL',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
  'SET', 'DECLARE', 'WHILE', 'IF', 'RETURN', 'THROW', 'RAISERROR', 'PRINT',
  'USE', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE',
  'INTO', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML', 'BULK',
  'WAITFOR', 'WRITETEXT', 'UPDATETEXT', 'READTEXT'
])

const bqBlockedKeywords = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'UNDROP',
  'GRANT', 'REVOKE',
  'EXEC', 'EXECUTE', 'CALL',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
  'SET', 'DECLARE', 'WHILE', 'RETURN', 'THROW', 'RAISERROR', 'PRINT',
  'USE', 'EXPORT', 'LOAD', 'ASSERT', 'LOOP', 'LEAVE', 'ITERATE',
  'INTO', 'RAISE'
])

const compoundAssignLeft = new Set(['+', '-', '*', '/', '%', '&', '|', '^'])
const selectListEndKeywords = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION'])

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
      let depth = 0

      for (let i = 0; i < stmt.length; i++) {
        const cur = stmt[i]!
        const prev = i > 0 ? stmt[i - 1] : undefined
        const next = i + 1 < stmt.length ? stmt[i + 1] : undefined
        const afterDot = prev?.token.kind === 'dot'

        if (cur.token.kind === 'sqlcmd') {
          pushViolation(cur.token.start, cur.token.end, 'SQLCMD', 'SQLCMD directives are not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.token.kind === 'open') {
          depth++
          const topScope = selectScopes[selectScopes.length - 1]
          if (topScope && topScope.awaitingTopArg && !topScope.topParenSeen && depth === topScope.depth + 1) {
            topScope.topParenSeen = true
          }
          continue
        }

        if (cur.token.kind === 'close') {
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
          if (depth > 0) depth--
          continue
        }

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
            if (selectListEndKeywords.has(cur.upper)) {
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
          const next2 = i + 2 < stmt.length ? stmt[i + 2] : undefined
          const isPlainAssign = next?.token.kind === 'operator' && next.text === '='
          const isCompoundAssign = next?.token.kind === 'operator' && compoundAssignLeft.has(next.text) &&
            next2?.token.kind === 'operator' && next2.text === '=' && next.token.end === next2.token.start
          if (isPlainAssign || isCompoundAssign) {
            const opEnd = isCompoundAssign ? next2!.token.end : next!.token.end
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
          if (topScope && topScope.depth === depth) {
            selectScopes[selectScopes.length - 1] = { depth, expectItemStart: true, awaitingTopArg: false, topParenSeen: false }
          } else if (!topScope || topScope.depth < depth) {
            selectScopes.push({ depth, expectItemStart: true, awaitingTopArg: false, topParenSeen: false })
          }
          continue
        }

        if (topScope && topScope.depth === depth && topScope.expectItemStart) {
          topScope.expectItemStart = false
        }

        if (tsqlBlockedKeywords.has(cur.upper)) {
          pushViolation(cur.token.start, cur.token.end, cur.upper, `${cur.upper} is not allowed in Cross-Engine read-only mode.`)
          continue
        }

        if (cur.upper === 'NEXT' && next?.token.kind === 'word' && next.upper === 'VALUE' && stmt[i + 2]?.token.kind === 'word' && stmt[i + 2]!.upper === 'FOR') {
          pushViolation(cur.token.start, stmt[i + 2]!.token.end, 'NEXT VALUE FOR', 'NEXT VALUE FOR is not allowed in Cross-Engine read-only mode.')
          continue
        }

        if (cur.upper === 'FETCH') {
          const prevUpper = prev?.token.kind === 'word' ? prev.upper : ''
          if (prevUpper !== 'ROW' && prevUpper !== 'ROWS') {
            pushViolation(cur.token.start, cur.token.end, 'FETCH', 'Cursor FETCH is not allowed in Cross-Engine read-only mode.')
          }
          continue
        }

        if (cur.upper === 'END' && next?.token.kind === 'word' && next.upper === 'CASE') {
          pushViolation(cur.token.start, next.token.end, 'END CASE', 'Procedural END CASE is not allowed in Cross-Engine read-only mode.')
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

  // Split into statements by `;`.
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
  }

  for (let sIdx = 1; sIdx < statements.length; sIdx++) {
    const extra = statements[sIdx]![0]!
    pushViolation(extra.token.start, extra.token.end, 'MULTI_STATEMENT', 'Cross-Engine BigQuery supports a single SELECT or WITH statement only.')
  }

  // Scan all statements' tokens for disallowed keywords/constructs.
  for (const stmt of statements) {
    let stmtFirstIdx = 0
    while (stmtFirstIdx < stmt.length && stmt[stmtFirstIdx]!.text === '(') stmtFirstIdx++
    let depth = 0
    for (let i = 0; i < stmt.length; i++) {
      const cur = stmt[i]!
      const prev = i > 0 ? stmt[i - 1] : undefined
      const next = i + 1 < stmt.length ? stmt[i + 1] : undefined
      if (cur.text === '(') { depth++; continue }
      if (cur.text === ')') { if (depth > 0) depth--; continue }
      if (cur.token.kind !== 'word' || prev?.text === '.') continue

      if (bqBlockedKeywords.has(cur.upper)) {
        pushViolation(cur.token.start, cur.token.end, cur.upper, `${cur.upper} is not allowed in Cross-Engine read-only mode.`)
        continue
      }

      if (cur.upper === 'IF') {
        const atStmtStart = i === stmtFirstIdx
        if (atStmtStart || next?.text !== '(') {
          pushViolation(cur.token.start, cur.token.end, 'IF', 'Procedural IF is not allowed in Cross-Engine read-only mode.')
        }
        continue
      }

      if (cur.upper === 'REPEAT') {
        const atStmtStart = i === stmtFirstIdx
        const isEndRepeat = prev?.token.kind === 'word' && prev.upper === 'END'
        if (!isEndRepeat && (atStmtStart || next?.text !== '(')) {
          pushViolation(cur.token.start, cur.token.end, 'REPEAT', 'Procedural REPEAT is not allowed in Cross-Engine read-only mode.')
        }
        continue
      }

      if (cur.upper === 'END' && next?.token.kind === 'word' && (next.upper === 'CASE' || next.upper === 'FOR' || next.upper === 'IF' || next.upper === 'LOOP' || next.upper === 'WHILE' || next.upper === 'REPEAT')) {
        pushViolation(cur.token.start, next.token.end, `END ${next.upper}`, `Procedural END ${next.upper} is not allowed in Cross-Engine read-only mode.`)
        continue
      }

      if (cur.upper === 'FOR') {
        const atStmtStart = i === stmtFirstIdx
        let hasDoAtSameDepth = false
        if (!atStmtStart && next?.upper !== 'SYSTEM_TIME') {
          let scanDepth = depth
          for (let j = i + 1; j < stmt.length; j++) {
            const t = stmt[j]!
            if (t.text === '(') scanDepth++
            else if (t.text === ')') {
              if (scanDepth === depth) break
              scanDepth--
            } else if (scanDepth === depth && t.token.kind === 'word' && t.upper === 'DO') {
              hasDoAtSameDepth = true
              break
            }
          }
        }
        if (atStmtStart || hasDoAtSameDepth) {
          pushViolation(cur.token.start, cur.token.end, 'FOR', 'Procedural FOR loop is not allowed in Cross-Engine read-only mode.')
        }
      }
    }
  }

  return violations
}

export function checkCrossEngineReadOnly(sql: string, dialect: ProviderId): ReadOnlyViolation[] {
  if (!hasExecutableSql(sql, dialect)) return []
  return dialect === 'bigquery' ? checkBigQueryReadOnly(sql) : checkTSqlReadOnly(sql)
}
