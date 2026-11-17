/**
 * A T-SQL lexer for text transforms (Toggle Brackets, Commas to Front or End): it only splits text into tokens with their
 * offsets, so a transform never touches strings, comments, variables or quoted names. It never fails: an unterminated
 * string, comment or bracketed name runs to the end of the text.
 */

export type SqlTokenKind =
  | 'space' // white space without a line break
  | 'newline' // one line break: \n, \r\n or \r
  | 'lineComment' // -- to the end of the line
  | 'blockComment' // /* */, nested as SQL Server nests them
  | 'string' // '…' or N'…', with '' inside
  | 'bracketed' // […], with ]] inside
  | 'quoted' // "…", with "" inside
  | 'variable' // @name or @@name
  | 'temp' // #name or ##name
  | 'word' // a keyword or a regular identifier
  | 'number'
  | 'special' // $action, $partition, $(sqlcmd)
  | 'comma' | 'semicolon' | 'dot' | 'open' | 'close' | 'scope' /* :: */ | 'colon' | 'operator'
  | 'sqlcmd' // a line starting with ':' (:setvar, :r), as SQLCMD mode reads it

export interface SqlToken { readonly kind: SqlTokenKind; readonly start: number; readonly end: number }

const wordStart = /[\p{L}_]/u
const wordPart = /[\p{L}\p{N}\p{M}_@#$]/u
const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\f' || char === '\v' || char === ' ' || char === '﻿'

/** The tokens of `text`, in order, covering it end to end. */
export function lexSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const length = text.length
  let at = 0
  let lineStart = true
  const push = (kind: SqlTokenKind, end: number) => { tokens.push({ kind, start: at, end }); at = end }
  /** The end of a run of characters `part` accepts, from `from`, by code point. */
  const runOf = (from: number, part: RegExp) => {
    let end = from
    while (end < length) {
      const point = String.fromCodePoint(text.codePointAt(end)!)
      if (!part.test(point)) break
      end += point.length
    }
    return end
  }
  /** The end of a delimited token: `close` doubled inside stands for itself. */
  const delimited = (from: number, close: string) => {
    let end = from
    while (end < length) {
      if (text[end] === close) {
        if (text[end + 1] === close) { end += 2; continue }
        return end + 1
      }
      end++
    }
    return length
  }
  while (at < length) {
    const char = text[at]!, next = text[at + 1]
    const startOfLine: boolean = lineStart
    lineStart = false
    if (char === '\r' || char === '\n') { push('newline', char === '\r' && next === '\n' ? at + 2 : at + 1); lineStart = true; continue }
    if (isSpace(char)) {
      let end = at + 1
      while (end < length && isSpace(text[end]!)) end++
      push('space', end)
      lineStart = startOfLine
      continue
    }
    if (startOfLine && char === ':') {
      let end = at
      while (end < length && text[end] !== '\n' && text[end] !== '\r') end++
      push('sqlcmd', end)
      continue
    }
    if (char === '-' && next === '-') {
      let end = at + 2
      while (end < length && text[end] !== '\n' && text[end] !== '\r') end++
      push('lineComment', end)
      continue
    }
    if (char === '/' && next === '*') {
      let depth = 1, end = at + 2
      while (end < length && depth > 0) {
        if (text[end] === '/' && text[end + 1] === '*') { depth++; end += 2 }
        else if (text[end] === '*' && text[end + 1] === '/') { depth--; end += 2 }
        else end++
      }
      push('blockComment', end)
      continue
    }
    if (char === "'") { push('string', delimited(at + 1, "'")); continue }
    if ((char === 'N' || char === 'n') && next === "'") { push('string', delimited(at + 2, "'")); continue }
    if (char === '[') { push('bracketed', delimited(at + 1, ']')); continue }
    if (char === '"') { push('quoted', delimited(at + 1, '"')); continue }
    if (char === '@') { push('variable', runOf(next === '@' ? at + 2 : at + 1, wordPart)); continue }
    if (char === '#') { push('temp', runOf(next === '#' ? at + 2 : at + 1, wordPart)); continue }
    if (char === '$') {
      if (next === '(') {
        let end = at + 2
        while (end < length && text[end] !== ')' && text[end] !== '\n' && text[end] !== '\r') end++
        push('special', text[end] === ')' ? end + 1 : end)
      } else push('special', runOf(at + 1, /[\p{L}\p{N}_.]/u))
      continue
    }
    if (char >= '0' && char <= '9' || (char === '.' && next !== undefined && next >= '0' && next <= '9')) {
      let end = at
      if (char === '0' && (next === 'x' || next === 'X')) end = runOf(at + 2, /[0-9a-fA-F]/)
      else {
        end = runOf(at, /[0-9]/)
        if (text[end] === '.') end = runOf(end + 1, /[0-9]/)
        if ((text[end] === 'e' || text[end] === 'E') && /[0-9+-]/.test(text[end + 1] ?? '')) end = runOf(end + 2, /[0-9]/)
      }
      push('number', end)
      continue
    }
    const point = String.fromCodePoint(text.codePointAt(at)!)
    if (wordStart.test(point)) { push('word', runOf(at, wordPart)); continue }
    switch (char) {
      case ',': push('comma', at + 1); continue
      case ';': push('semicolon', at + 1); continue
      case '.': push('dot', at + 1); continue
      case '(': push('open', at + 1); continue
      case ')': push('close', at + 1); continue
      case ':': push(next === ':' ? 'scope' : 'colon', next === ':' ? at + 2 : at + 1); continue
    }
    push('operator', at + point.length)
  }
  return tokens
}

/** Tokens that are neither white space nor comments. */
export const isSignificant = (token: SqlToken): boolean => token.kind !== 'space' && token.kind !== 'newline' && token.kind !== 'lineComment' && token.kind !== 'blockComment'

/**
 * SQL Server's reserved keywords (Transact-SQL and the ODBC words SQL Server reserves), which a name can use only in
 * brackets.
 */
export const reservedKeywords: ReadonlySet<string> = new Set(`
ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE CHECK CHECKPOINT CLOSE
CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTAINSTABLE CONTINUE CONVERT CREATE CROSS CURRENT
CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC
DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE
FILLFACTOR FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT
IDENTITYCOL IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK
NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPENDATASOURCE OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER
PERCENT PIVOT PLAN PRECISION PRIMARY PRINT PROC PROCEDURE PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES
REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT
SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE SEMANTICSIMILARITYTABLE SESSION_USER SET SETUSER SHUTDOWN SOME
STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY_CONVERT TSEQUAL UNION
UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WRITETEXT
`.trim().split(/\s+/))

/**
 * Words that are not reserved but act as keywords wherever they appear in ordinary scripts, so Toggle Brackets neither
 * brackets them nor takes their brackets off: the batch separator, TRY/CATCH, APPLY, OUTPUT's pseudo-tables, paging and
 * window frames, table hints, and statement options.
 */
export const contextualKeywords: ReadonlySet<string> = new Set(`
GO TRY CATCH THROW APPLY USING OUTPUT OUT READONLY INSERTED DELETED MATCHED OFFSET ROWS ROW NEXT ONLY TIES PARTITION RANGE
UNBOUNDED PRECEDING FOLLOWING WITHIN IGNORE RESPECT NULLS WINDOW RETURNS SCHEMABINDING ENCRYPTION RECOMPILE
NATIVE_COMPILATION XMLNAMESPACES NOLOCK READUNCOMMITTED READCOMMITTED READCOMMITTEDLOCK READPAST ROWLOCK PAGLOCK TABLOCK
TABLOCKX UPDLOCK XLOCK NOWAIT SERIALIZABLE REPEATABLEREAD FORCESEEK FORCESCAN NOEXPAND SETERROR MAXDOP NOCOUNT XACT_ABORT
ANSI_NULLS QUOTED_IDENTIFIER ANSI_WARNINGS ANSI_PADDING ARITHABORT CONCAT_NULL_YIELDS_NULL NUMERIC_ROUNDABORT
IMPLICIT_TRANSACTIONS DATEFIRST DATEFORMAT DEADLOCK_PRIORITY LOCK_TIMEOUT SHOWPLAN_XML SHOWPLAN_ALL SHOWPLAN_TEXT NOEXEC
PARSEONLY FMTONLY SYSTEM_TIME BOTH LEADING TRAILING REBUILD REORGANIZE SWITCH MAX
`.trim().split(/\s+/))

/** SQL Server's system type names, which Toggle Brackets leaves alone where a type is expected (after a variable, CAST's AS). */
export const systemTypeNames: ReadonlySet<string> = new Set(`
BIGINT INT SMALLINT TINYINT BIT DECIMAL DEC NUMERIC MONEY SMALLMONEY FLOAT REAL DATE TIME DATETIME DATETIME2 DATETIMEOFFSET
SMALLDATETIME CHAR VARCHAR TEXT NCHAR NVARCHAR NTEXT BINARY VARBINARY IMAGE ROWVERSION TIMESTAMP HIERARCHYID
UNIQUEIDENTIFIER SQL_VARIANT XML GEOMETRY GEOGRAPHY SYSNAME JSON VECTOR CURSOR TABLE
`.trim().split(/\s+/))
