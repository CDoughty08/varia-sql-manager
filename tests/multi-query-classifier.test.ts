import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import {
  checkCrossEngineReadOnly,
  classifyStatements,
  crossEngineMarkers,
  hasExecutableSql,
  parseCrossEngineSql,
  serializeCrossEngineSql
} from '../src/shared/multi-query'

describe('erasable TypeScript & Node 24 loader', () => {
  it('keeps src/shared/multi-query.ts erasable with .ts relative imports and loadable in Node 24', () => {
    const file = join('src', 'shared', 'multi-query.ts')
    const source = readFileSync(file, 'utf8')
    expect(() => stripTypeScriptTypes(source, { mode: 'strip' })).not.toThrow()
    for (const statement of source.match(/^import\b.*$/gm) ?? []) {
      expect(statement).toMatch(/^import (?:type )?\{[^}]+\} from '\.\/(?:[a-z-]+\/)?[a-z-]+\.ts'$/)
    }
    const target = pathToFileURL(file).href
    const script = `import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context) } catch (error) { if (!specifier.startsWith('.') || /\\.[cm]?[jt]s$/.test(specifier)) throw error; return next(specifier + '.ts', context) } } })
const mod = await import(${JSON.stringify(target)})
const res = mod.classifyStatements('SELECT 1', 'sqlserver')
if (res.batchCount !== 1 || res.statements.length !== 1) process.exit(2)`
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

describe('classifyStatements', () => {
  it('classifies T-SQL mockup mixed-mssql batches, conditional statements, and counts', () => {
    const sql = [
      "IF COL_LENGTH('dbo.Orders', 'Region') IS NULL",
      '  ALTER TABLE dbo.Orders ADD Region nvarchar(50) NULL;',
      'GO',
      "UPDATE dbo.Orders SET Region = 'US' WHERE Region IS NULL;",
      'GO',
      "IF EXISTS (SELECT 1 FROM dbo.Orders WHERE Region = 'US')",
      '  SELECT COUNT(*) AS UsCount FROM dbo.Orders;',
      'SELECT TOP 10 * FROM dbo.Orders;'
    ].join('\n')
    const result = classifyStatements(sql, 'sqlserver')
    expect(result.provider).toBe('sqlserver')
    expect(result.batchCount).toBe(3)
    expect(result.hasNonTransactionalTSql).toBe(false)
    expect(result.statements).toHaveLength(4)
    expect(result.statements[0]).toMatchObject({ category: 'ddl', keyword: 'ALTER TABLE', batch: 1, conditional: true, nonTransactional: false })
    expect(result.statements[1]).toMatchObject({ category: 'dml', keyword: 'UPDATE', batch: 2, conditional: false })
    expect(result.statements[2]).toMatchObject({ category: 'select', keyword: 'SELECT', batch: 3, conditional: true })
    expect(result.statements[3]).toMatchObject({ category: 'select', keyword: 'SELECT', batch: 3, conditional: false })
    expect(result.tags).toEqual(['3 batches', '1 DDL (ALTER TABLE)', '1 DML (UPDATE)', '2 SELECTs (1 conditional)'])
  })

  it('does not treat [GO], \'GO\', GO: labels, or comments as T-SQL batch delimiters', () => {
    const sql = [
      'GO:',
      "SELECT [GO], 'GO' FROM dbo.T;",
      '/* GO\n*/ SELECT 2;'
    ].join('\n')
    const result = classifyStatements(sql, 'sqlserver')
    expect(result.batchCount).toBe(1)
    expect(result.statements.map(s => s.category)).toEqual(['other', 'select', 'select'])
  })

  it('handles multi-line block comments right before GO and resolves CTEs, MERGE, CREATE PROC, and INSERT...SELECT', () => {
    const sql = [
      '/* header',
      '*/ GO',
      'WITH cte AS (SELECT 1 AS id) UPDATE t SET c = cte.id FROM cte;',
      'MERGE INTO dst USING src ON dst.id = src.id WHEN MATCHED THEN UPDATE SET dst.v = src.v WHEN NOT MATCHED THEN INSERT (id) VALUES (src.id);',
      'INSERT INTO dst SELECT id FROM src;',
      'GO',
      'CREATE OR ALTER PROCEDURE dbo.p AS BEGIN SELECT 1; UPDATE dst SET v = 2; END'
    ].join('\n')
    const result = classifyStatements(sql, 'sqlserver')
    expect(result.batchCount).toBe(2)
    expect(result.statements.map(s => [s.category, s.keyword])).toEqual([
      ['dml', 'UPDATE'],
      ['dml', 'MERGE'],
      ['dml', 'INSERT'],
      ['ddl', 'CREATE PROCEDURE']
    ])
  })

  it('detects all SQL Server Msg 226/574 non-transactional statements while keeping transactional DDL clean', () => {
    const nonTxCases = [
      'CREATE DATABASE Foo;',
      'ALTER DATABASE Foo SET RECOVERY SIMPLE;',
      'DROP DATABASE Foo;',
      'BACKUP DATABASE Foo TO DISK = \'x\';',
      'RESTORE DATABASE Foo FROM DISK = \'x\';',
      'RECONFIGURE;',
      'DBCC CHECKDB;',
      'CREATE FULLTEXT CATALOG ft;',
      'ALTER FULLTEXT INDEX ON dbo.T ENABLE;',
      'DROP FULLTEXT STOPLIST sl;',
      'CREATE AVAILABILITY GROUP ag FOR DATABASE Foo;',
      'ALTER SERVER CONFIGURATION SET PROCESS AFFINITY CPU = AUTO;',
      'CREATE RESOURCE POOL rp;',
      'CREATE EXTERNAL RESOURCE POOL erp;',
      'DROP WORKLOAD GROUP wg;',
      'SHUTDOWN;',
      'KILL 55;'
    ]
    for (const stmt of nonTxCases) {
      const res = classifyStatements(stmt, 'sqlserver')
      expect(res.hasNonTransactionalTSql, stmt).toBe(true)
      expect(res.firstBlockingStatement?.nonTransactional, stmt).toBe(true)
    }

    const txRes = classifyStatements('CREATE TABLE dbo.T (id int); ALTER TABLE dbo.T ADD c int; DROP TABLE dbo.T;', 'sqlserver')
    expect(txRes.hasNonTransactionalTSql).toBe(false)
    expect(txRes.firstBlockingStatement).toBeUndefined()
  })

  it('classifies BigQuery mockup bq-ddl and distinguishes permanent DDL from TEMP tables and _SESSION drops', () => {
    const sql = [
      '-- header',
      'CREATE OR REPLACE VIEW analytics.active_orders AS',
      '  SELECT * FROM analytics.orders WHERE active = TRUE;',
      '',
      '',
      'UPDATE analytics.orders SET synced_at = CURRENT_TIMESTAMP() WHERE active = TRUE;',
      '',
      '',
      'SELECT COUNT(*) AS active_count FROM analytics.orders;'
    ].join('\n')
    const res = classifyStatements(sql, 'bigquery')
    expect(res.hasBigQueryPermanentDdl).toBe(true)
    expect(res.blocksBigQueryTransaction).toBe(true)
    expect(res.statements.map(s => [s.category, s.keyword, s.line])).toEqual([
      ['ddl', 'CREATE VIEW', 2],
      ['dml', 'UPDATE', 6],
      ['select', 'SELECT', 9]
    ])
    expect(res.tags).toEqual(['1 permanent DDL (Line 2: CREATE VIEW)', '1 DML (Line 6: UPDATE)', '1 SELECT (Line 9)'])

    const tempTable = classifyStatements('CREATE TEMP TABLE t AS SELECT 1 AS x; DROP TABLE _SESSION.t; TRUNCATE TABLE analytics.t;', 'bigquery')
    expect(tempTable.hasBigQueryPermanentDdl).toBe(false)
    expect(tempTable.blocksBigQueryTransaction).toBe(false)

    const tempFunc = classifyStatements('CREATE TEMPORARY FUNCTION f(x INT64) AS (x + 1);', 'bigquery')
    expect(tempFunc.hasBigQueryPermanentDdl).toBe(false)
    expect(tempFunc.blocksBigQueryTransaction).toBe(true)

    const dropPerm = classifyStatements('DROP TABLE analytics.orders;', 'bigquery')
    expect(dropPerm.hasBigQueryPermanentDdl).toBe(true)
    expect(dropPerm.blocksBigQueryTransaction).toBe(true)
  })

  it('flags BigQuery transaction blockers, procedural conditionals, and ignores comments/strings/backticks', () => {
    for (const stmt of [
      "EXECUTE IMMEDIATE 'SELECT 1';",
      'CALL my_dataset.my_proc();',
      "EXPORT DATA OPTIONS(uri='gs://b/*.csv', format='CSV') AS SELECT 1;",
      "LOAD DATA OVERWRITE ds.t FROM FILES(format='CSV', uris=['gs://b/a.csv']);",
      'BEGIN TRANSACTION; COMMIT TRANSACTION;'
    ]) {
      const res = classifyStatements(stmt, 'bigquery')
      expect(res.blocksBigQueryTransaction, stmt).toBe(true)
    }

    const condRes = classifyStatements("IF x > 0 THEN SELECT 'CREATE TABLE `not_ddl`' AS `DROP TABLE`; END IF;", 'bigquery')
    expect(condRes.hasBigQueryPermanentDdl).toBe(false)
    expect(condRes.statements).toHaveLength(1)
    expect(condRes.statements[0]).toMatchObject({ category: 'select', conditional: true })
  })

  it('ignores dot-qualified member names and keeps T-SQL ALTER routine bodies self-contained', () => {
    const dotAdmin = classifyStatements('SELECT t.kill, t.backup, t.shutdown FROM dbo.T AS t', 'sqlserver')
    expect(dotAdmin.hasNonTransactionalTSql).toBe(false)
    expect(dotAdmin.firstBlockingStatement).toBeUndefined()
    expect(dotAdmin.statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    expect(dotAdmin.tags).toEqual(['1 SELECT'])

    const dotDml = classifyStatements('SELECT t.update, t.delete FROM t', 'sqlserver')
    expect(dotDml.statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    const dotCond = classifyStatements('IF t.update = 1 SELECT t.select FROM dbo.T AS t', 'sqlserver')
    expect(dotCond.statements).toHaveLength(1)
    expect(dotCond.statements[0]).toMatchObject({ category: 'select', keyword: 'SELECT', conditional: true })

    const dotUpdate = classifyStatements('UPDATE dbo.T SET t.delete = 1 WHERE t.kill = 2', 'sqlserver')
    expect(dotUpdate.hasNonTransactionalTSql).toBe(false)
    expect(dotUpdate.statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE']])

    const alterProc = classifyStatements('ALTER PROCEDURE p AS BEGIN INSERT INTO t VALUES (1); SELECT 1; END', 'sqlserver')
    expect(alterProc.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER PROCEDURE']])

    const alterFunc = classifyStatements('ALTER FUNCTION dbo.f() RETURNS int AS BEGIN DECLARE @x int = 1; RETURN @x; END', 'sqlserver')
    expect(alterFunc.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER FUNCTION']])

    const alterTrigger = classifyStatements('ALTER TRIGGER dbo.tr ON dbo.T AFTER INSERT AS BEGIN UPDATE dbo.Audit SET c = 1; END', 'sqlserver')
    expect(alterTrigger.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TRIGGER']])

    const alterTableAndView = classifyStatements('ALTER TABLE dbo.T ADD c int; ALTER VIEW dbo.v AS SELECT 1; SELECT 2;', 'sqlserver')
    expect(alterTableAndView.statements.map(s => [s.category, s.keyword])).toEqual([
      ['ddl', 'ALTER TABLE'],
      ['ddl', 'ALTER VIEW'],
      ['select', 'SELECT']
    ])
  })

  it('keeps BigQuery CREATE PROCEDURE bodies intact across END IF, nested blocks, and CASE expressions', () => {
    const simpleProc = classifyStatements(
      'CREATE PROCEDURE ds.p() BEGIN IF x > 0 THEN SELECT 1; END IF; INSERT INTO ds.t VALUES (1); END;',
      'bigquery'
    )
    expect(simpleProc.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE']])
    expect(simpleProc.hasBigQueryPermanentDdl).toBe(true)

    const nestedProc = classifyStatements(
      [
        'CREATE OR REPLACE PROCEDURE ds.p() BEGIN',
        '  IF x > 0 THEN',
        '    SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END;',
        '    SELECT t.end FROM ds.t;',
        '  END IF;',
        '  WHILE y < 3 DO SET y = y + 1; END WHILE;',
        '  CASE z WHEN 1 THEN INSERT INTO ds.t VALUES (1); END CASE;',
        '  INSERT INTO ds.t VALUES (2);',
        'END;',
        'SELECT 1;'
      ].join('\n'),
      'bigquery'
    )
    expect(nestedProc.statements.map(s => [s.category, s.keyword])).toEqual([
      ['ddl', 'CREATE PROCEDURE'],
      ['select', 'SELECT']
    ])
  })
})

describe('serializeCrossEngineSql & parseCrossEngineSql', () => {
  it('round-trips canonical LF, trailing newlines, empty sections, and CRLF', () => {
    const cases: readonly [string, string][] = [
      ['SELECT 1', 'SELECT 2'],
      ['', 'SELECT 2'],
      ['SELECT 1', ''],
      ['', ''],
      ['SELECT 1\n', 'SELECT 2\n']
    ]
    for (const [ss, bq] of cases) {
      const serialized = serializeCrossEngineSql(ss, bq)
      const parsed = parseCrossEngineSql(serialized)
      expect(parsed).toEqual({
        ok: true,
        sqlserver: ss,
        bigquery: bq,
        sqlServerStartLine: 2,
        bigQueryStartLine: 2 + ss.split('\n').length + 1
      })
    }

    const crlf = serializeCrossEngineSql('SELECT 1', 'SELECT 2', '\r\n')
    expect(parseCrossEngineSql(crlf)).toEqual({
      ok: true,
      sqlserver: 'SELECT 1',
      bigquery: 'SELECT 2',
      sqlServerStartLine: 2,
      bigQueryStartLine: 4
    })
  })

  it('allows comment and block-comment preambles and supports BigQuery-first header order', () => {
    const sql = [
      '-- Single saveable .sql file',
      '/* block /* nested */ comment */',
      crossEngineMarkers.bigquery,
      'SELECT 1',
      crossEngineMarkers.sqlserver,
      'SELECT 2'
    ].join('\n')
    expect(parseCrossEngineSql(sql)).toEqual({
      ok: true,
      sqlserver: 'SELECT 2',
      bigquery: 'SELECT 1',
      sqlServerStartLine: 6,
      bigQueryStartLine: 4
    })
  })

  it('rejects non-comment preambles, unclosed block comments, duplicate/missing/malformed headers, and unknown dialects', () => {
    expect(parseCrossEngineSql(`SELECT 0\n${crossEngineMarkers.sqlserver}\nSELECT 1\n${crossEngineMarkers.bigquery}\nSELECT 2`).ok).toBe(false)
    expect(parseCrossEngineSql(`/* unclosed\n${crossEngineMarkers.sqlserver}\nSELECT 1\n${crossEngineMarkers.bigquery}\nSELECT 2`).ok).toBe(false)
    expect(parseCrossEngineSql(`/* outer /* inner */\n${crossEngineMarkers.sqlserver}\nSELECT 1\n${crossEngineMarkers.bigquery}\nSELECT 2`).ok).toBe(false)
    expect(parseCrossEngineSql(`${crossEngineMarkers.sqlserver}\nSELECT 1\n${crossEngineMarkers.sqlserver}\nSELECT 2`).ok).toBe(false)
    expect(parseCrossEngineSql(`${crossEngineMarkers.sqlserver}\nSELECT 1`).ok).toBe(false)
    expect(parseCrossEngineSql(`-- #Dialect="postgres"\nSELECT 1\n${crossEngineMarkers.bigquery}\nSELECT 2`).ok).toBe(false)
    expect(parseCrossEngineSql(`-- #Dialect=sqlserver\nSELECT 1\n${crossEngineMarkers.bigquery}\nSELECT 2`).ok).toBe(false)
  })
})

describe('checkCrossEngineReadOnly & hasExecutableSql', () => {
  it('handles empty and comment-only inputs cleanly', () => {
    for (const empty of ['', '   \n\t', '-- comment\n/* block */', 'GO\n-- only comment']) {
      if (empty.startsWith('GO')) {
        expect(hasExecutableSql(empty, 'sqlserver')).toBe(false)
        expect(checkCrossEngineReadOnly(empty, 'sqlserver')).toEqual([])
      } else {
        for (const dialect of ['sqlserver', 'bigquery'] as const) {
          expect(hasExecutableSql(empty, dialect)).toBe(false)
          expect(checkCrossEngineReadOnly(empty, dialect)).toEqual([])
        }
      }
    }
    expect(hasExecutableSql(';', 'bigquery')).toBe(false)
    expect(hasExecutableSql('# hash comment\n', 'bigquery')).toBe(false)
    expect(hasExecutableSql('SELECT 1', 'sqlserver')).toBe(true)
    expect(hasExecutableSql('SELECT 1', 'bigquery')).toBe(true)
  })

  it('permits valid read-only SELECT/WITH/() syntax across both dialects', () => {
    const validTSql = [
      'WITH cte AS (SELECT 1 AS a)',
      'SELECT CASE WHEN a = 1 THEN \'INSERT INTO x\' ELSE [update] END AS v,',
      '  t.[delete], t.update, "DROP TABLE"',
      'FROM dbo.T AS t FOR SYSTEM_TIME AS OF \'2025-01-01\'',
      'ORDER BY a',
      'OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY;',
      'GO',
      '((SELECT * FROM dbo.Sales PIVOT (SUM(Amt) FOR Yr IN ([2024], [2025])) AS p FOR JSON AUTO));'
    ].join('\n')
    expect(checkCrossEngineReadOnly(validTSql, 'sqlserver')).toEqual([])

    const validBq = [
      'WITH cte AS (SELECT IF(a > 0, 1, 0) AS flag, REPEAT(\'abc\', 3) AS rep, CASE WHEN a = 1 THEN "DELETE" ELSE `insert` END AS s',
      '  FROM proj.ds.tbl FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() AS t)',
      'SELECT t.update, t.call, REPEAT(s, 2), * FROM cte PIVOT (SUM(flag) FOR s IN ("a", "b"));'
    ].join('\n')
    expect(checkCrossEngineReadOnly(validBq, 'bigquery')).toEqual([])
  })

  it('blocks disallowed T-SQL constructs with exact 1-based line/column spans', () => {
    const intoRes = checkCrossEngineReadOnly('SELECT a\nINTO dbo.Copy FROM dbo.T', 'sqlserver')
    expect(intoRes).toHaveLength(1)
    expect(intoRes[0]).toMatchObject({ line: 2, column: 1, endLine: 2, endColumn: 5, keyword: 'INTO' })

    const assignRes = checkCrossEngineReadOnly('SELECT @v = 1 FROM dbo.T', 'sqlserver')
    expect(assignRes.some(v => v.keyword === 'SELECT_ASSIGN' && v.line === 1 && v.column === 8)).toBe(true)

    const topAssign = checkCrossEngineReadOnly('SELECT TOP 10 PERCENT @v += 1 FROM dbo.T', 'sqlserver')
    expect(topAssign.some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)

    const consecutiveAssign = checkCrossEngineReadOnly('SELECT 1\nSELECT @x = 1 FROM t', 'sqlserver')
    expect(consecutiveAssign).toHaveLength(1)
    expect(consecutiveAssign[0]).toMatchObject({ keyword: 'SELECT_ASSIGN', line: 2, column: 8 })

    const inlineCompoundAssign = checkCrossEngineReadOnly('SELECT 1 SELECT @x += 1', 'sqlserver')
    expect(inlineCompoundAssign).toHaveLength(1)
    expect(inlineCompoundAssign[0]).toMatchObject({ keyword: 'SELECT_ASSIGN', line: 1, column: 17 })

    const caseAllowed = checkCrossEngineReadOnly('SELECT CASE WHEN @v = 1 THEN 1 ELSE 0 END FROM dbo.T', 'sqlserver')
    expect(caseAllowed).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT a = @v, IIF(@v = 1, 1, 0) FROM dbo.T WHERE @v = 1', 'sqlserver')).toEqual([])

    const blockedTSql = [
      "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=.;Trusted_Connection=yes;', 'SELECT 1')",
      "SELECT * FROM OPENQUERY(LinkedSrv, 'SELECT 1')",
      "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=s')",
      'SELECT * FROM OPENXML(@h, \'/a\')',
      'SELECT * FROM OPENROWSET(BULK \'c:\\a.txt\', SINGLE_CLOB) AS x',
      'SELECT NEXT VALUE FOR dbo.Seq',
      "WAITFOR DELAY '00:00:01'",
      'WRITETEXT dbo.T.c 0x01 \'a\'',
      'UPDATETEXT dbo.T.c 0x01 0 0 \'a\'',
      'READTEXT dbo.T.c 0x01 0 1',
      ':setvar x 1',
      'SELECT 1\nGO 2',
      'WITH cte AS (SELECT 1 AS a) DELETE FROM dbo.T',
      'SELECT * FROM (DELETE FROM dbo.T OUTPUT deleted.id) AS d',
      'FETCH NEXT FROM cur',
      'SELECT 1; END CASE'
    ]
    for (const stmt of blockedTSql) {
      expect(checkCrossEngineReadOnly(stmt, 'sqlserver').length, stmt).toBeGreaterThan(0)
    }
  })

  it('blocks BigQuery multi-statement scripts and procedural/DML/DDL constructs', () => {
    const multi = checkCrossEngineReadOnly('SELECT 1;\nSELECT 2;', 'bigquery')
    expect(multi).toHaveLength(1)
    expect(multi[0]).toMatchObject({ keyword: 'MULTI_STATEMENT', line: 2, column: 1, endLine: 2, endColumn: 7 })

    const blockedBq = [
      "EXPORT DATA OPTIONS(uri='gs://b/*.csv', format='CSV') AS SELECT 1",
      "LOAD DATA OVERWRITE ds.t FROM FILES(format='CSV', uris=['gs://b/a.csv'])",
      'ASSERT TRUE',
      'FOR r IN (SELECT 1 AS x) DO SELECT r.x; END FOR',
      'LOOP SELECT 1; END LOOP',
      'REPEAT SELECT 1; UNTIL TRUE END REPEAT',
      'SELECT 1; LEAVE lbl',
      'SELECT 1; ITERATE lbl',
      'CASE x WHEN 1 THEN SELECT 1; END CASE',
      'IF x > 0 THEN SELECT 1; END IF',
      'IF(TRUE) THEN SELECT 1; END IF'
    ]
    for (const stmt of blockedBq) {
      expect(checkCrossEngineReadOnly(stmt, 'bigquery').length, stmt).toBeGreaterThan(0)
    }

    // Single-statement BigQuery SELECT with non-reserved GoogleSQL identifiers & PIVOT FOR must not false-positive.
    expect(checkCrossEngineReadOnly('SELECT load, export, call, return, begin, commit, save, use, repeat FROM proj.ds.events', 'bigquery')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT update, delete, insert, drop, alter FROM proj.ds.audit WHERE repeat = TRUE', 'bigquery')).toEqual([])
    expect(checkCrossEngineReadOnly('WITH update AS (SELECT 1 AS id) SELECT * FROM update', 'bigquery')).toEqual([])
    expect(checkCrossEngineReadOnly("SELECT * FROM proj.ds.t PIVOT (SUM(a) FOR b IN ('x') AS do)", 'bigquery')).toEqual([])

    // No double-reporting on the same token span in BigQuery.
    expect(checkCrossEngineReadOnly('DELETE FROM ds.t', 'bigquery')).toHaveLength(1)
    expect(checkCrossEngineReadOnly('SELECT 1; DELETE FROM ds.t', 'bigquery')).toHaveLength(1)

    for (const dialect of ['sqlserver', 'bigquery'] as const) {
      expect(hasExecutableSql('(', dialect)).toBe(true)
      const loneOpen = checkCrossEngineReadOnly('(', dialect)
      expect(loneOpen).toHaveLength(1)
      expect(loneOpen[0]).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 2, keyword: '(' })
      expect(checkCrossEngineReadOnly('((', dialect).length).toBeGreaterThan(0)
    }
  })

  it('catches un-semicoloned T-SQL bypasses, allows OPTION (USE HINT/PLAN) and non-reserved call/throw, and stays linear on adversarial inputs', () => {
    const bypasses = [
      'SELECT 1 DISABLE TRIGGER ALL ON dbo.Orders',
      'SELECT 1 ENABLE TRIGGER dbo.tr ON dbo.Orders',
      'SELECT 1 RECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT 1 SEND ON CONVERSATION @h MESSAGE TYPE [m]',
      'SELECT 1 END CONVERSATION @h',
      'SELECT 1 CHECKPOINT',
      'SELECT 1 REVERT',
      "SELECT 1 SETUSER 'dbo'",
      'SELECT 1 OPEN SYMMETRIC KEY k DECRYPTION BY CERTIFICATE c',
      'SELECT 1 CLOSE ALL SYMMETRIC KEYS',
      'SELECT 1 GOTO lbl',
      'SELECT 1 AS rows FETCH NEXT FROM my_cursor',
      'SELECT 1 AS window, @x = 2 FROM dbo.T'
    ]
    for (const stmt of bypasses) {
      expect(checkCrossEngineReadOnly(stmt, 'sqlserver').length, stmt).toBeGreaterThan(0)
    }

    expect(checkCrossEngineReadOnly("SELECT * FROM dbo.Orders OPTION (USE HINT('ENABLE_QUERY_OPTIMIZER_HOTFIXES'))", 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly("SELECT * FROM dbo.Orders OPTION (USE PLAN N'<ShowPlanXML/>')", 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT call, throw FROM dbo.Calls', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver')).toEqual([])

    // Adversarial linear-time checks (previously O(N^2)).
    const start = performance.now()
    expect(checkCrossEngineReadOnly(`SELECT (${'FOR '.repeat(8000)}1)`, 'bigquery')).toEqual([])
    classifyStatements('WITH '.repeat(8000), 'sqlserver')
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('handles T-SQL clauses, SELECT INTO, BigQuery GRANT/REVOKE/TRUNCATE/CTE names, and multi-line #Dialect strings', () => {
    // T-SQL CASE...ELSE...END inside IF BEGIN...END keeps conditional tracking intact.
    const condCase = classifyStatements('IF 1 = 1 BEGIN SELECT CASE WHEN x = 1 THEN 1 ELSE 2 END FROM dbo.T; SELECT 2; END', 'sqlserver')
    expect(condCase.statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([
      ['select', 'SELECT', true],
      ['select', 'SELECT', true]
    ])
    expect(classifyStatements('SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT * FROM dbo.Orders WITH (NOLOCK)', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP 10 WITH TIES * FROM dbo.Orders ORDER BY Id', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('DROP TABLE IF EXISTS dbo.T; SELECT 1;', 'sqlserver').tags).toEqual(['1 DDL (DROP TABLE)', '1 SELECT'])
    expect(classifyStatements('CREATE INDEX ix ON dbo.T (c) WITH (ONLINE = ON)', 'sqlserver').tags).toEqual(['1 DDL (CREATE INDEX)'])
    expect(classifyStatements('SELECT * INTO dbo.BackupOrders FROM dbo.Orders', 'sqlserver').tags).toEqual(['1 DML (SELECT INTO)'])
    expect(classifyStatements('ALTER RESOURCE GOVERNOR RECONFIGURE', 'sqlserver').hasNonTransactionalTSql).toBe(true)
    expect(classifyStatements('CREATE SERVER AUDIT a TO FILE (FILEPATH = \'C:\\logs\')', 'sqlserver').hasNonTransactionalTSql).toBe(true)
    expect(classifyStatements('CREATE ENDPOINT ep STATE = STARTED AS TCP (LISTENER_PORT = 5022)', 'sqlserver').hasNonTransactionalTSql).toBe(true)

    // BigQuery GRANT/REVOKE block transactions, TRUNCATE TABLE is DML, and WITH update AS (...) is SELECT.
    expect(classifyStatements('GRANT `roles/bigquery.dataViewer` ON TABLE ds.t TO "user:a@b.com";', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('REVOKE `roles/bigquery.dataViewer` ON TABLE ds.t FROM "user:a@b.com";', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('TRUNCATE TABLE analytics.orders;', 'bigquery').tags).toEqual(['1 DML (Line 1: TRUNCATE TABLE)'])
    expect(classifyStatements('WITH update AS (SELECT 1 AS id) SELECT * FROM update;', 'bigquery').statements.map(s => s.category)).toEqual(['select'])

    // Multi-line strings and block comments containing -- #Dialect headers do not split or fail round-trip.
    const serialized = serializeCrossEngineSql("SELECT 'line1\n-- #Dialect=\"bigquery\"\nline3'", 'SELECT 2')
    const parsed = parseCrossEngineSql(serialized)
    expect(parsed).toMatchObject({ ok: true, sqlserver: "SELECT 'line1\n-- #Dialect=\"bigquery\"\nline3'", bigquery: 'SELECT 2' })
    const preambleComment = parseCrossEngineSql('/*\n-- #Dialect="sqlserver"\n*/\n-- #Dialect="sqlserver"\nSELECT 1\n-- #Dialect="bigquery"\nSELECT 2')
    expect(preambleComment).toMatchObject({ ok: true, sqlserver: 'SELECT 1', bigquery: 'SELECT 2' })
    expect(parseCrossEngineSql('-- #Dialect="sqlserver"\n/*\n-- #Dialect="bigquery"\n*/').ok).toBe(false)
  })

  it('covers Round 2 edge cases: BQ temp table functions, EXCEPTION/labels, raw strings, parenthesized CTEs, and T-SQL aliases/cursor FETCH', () => {
    // BigQuery TEMP TABLE FUNCTION and DROP [TABLE] FUNCTION _SESSION.* block transactions.
    expect(classifyStatements('CREATE TEMP TABLE FUNCTION f() AS (SELECT 1);', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('DROP FUNCTION _SESSION.my_fn;', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('DROP TABLE FUNCTION _SESSION.my_tf;', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('DROP TABLE _SESSION.my_tmp;', 'bigquery').blocksBigQueryTransaction).toBe(false)

    // BigQuery EXCEPTION handlers and labeled blocks do not swallow permanent DDL or blockers.
    const bqExc = classifyStatements('BEGIN\n  UPDATE ds.t SET a = 1 WHERE TRUE;\nEXCEPTION WHEN ERROR THEN\n  DROP TABLE ds.t;\nEND;', 'bigquery')
    expect(bqExc.hasBigQueryPermanentDdl).toBe(true)
    expect(bqExc.blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('BEGIN\n  SELECT 1;\nEXCEPTION WHEN ERROR THEN\n  CALL ds.p();\nEND;', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('my_lbl: LOOP\n  CREATE TABLE ds.t (id INT64);\n  LEAVE my_lbl;\nEND LOOP;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(classifyStatements('my_lbl: BEGIN\n  DROP TABLE ds.t;\nEND;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // BigQuery raw strings with backslash-escaped quotes preserve cross-engine splits.
    const rawTriple = parseCrossEngineSql('-- #Dialect="bigquery"\nSELECT r\'\'\'hello \\\'\'\'\n-- #Dialect="sqlserver"\nstill inside\'\'\'\n-- #Dialect="sqlserver"\nSELECT 1')
    expect(rawTriple).toMatchObject({ ok: true, sqlserver: 'SELECT 1', sqlServerStartLine: 6, bigQueryStartLine: 2 })
    const rawSingle = parseCrossEngineSql('-- #Dialect="bigquery"\nSELECT r\'foo\\\' /* not comment\'\n-- #Dialect="sqlserver"\nSELECT 1')
    expect(rawSingle).toMatchObject({ ok: true, sqlserver: 'SELECT 1' })

    // T-SQL parenthesized CTE query + un-semicoloned non-transactional DDL, and parenthesized SELECT INTO.
    const parenCte = classifyStatements('WITH cte AS (SELECT 1 AS a) (SELECT * FROM cte) DROP DATABASE Foo', 'sqlserver')
    expect(parenCte.hasNonTransactionalTSql).toBe(true)
    expect(parenCte.statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['ddl', 'DROP DATABASE']])
    expect(classifyStatements('(SELECT * INTO dbo.Copy FROM dbo.Orders)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])

    // T-SQL un-semicoloned statements after DML or SELECT are not swallowed.
    expect(classifyStatements('UPDATE dbo.Orders SET x = 1\nSELECT * FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['select', 'SELECT']])
    expect(classifyStatements('DELETE FROM dbo.Orders WHERE id = 1\nSELECT * INTO dbo.Backup FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'DELETE'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('UPDATE dbo.Orders SET x = 1\nEXEC dbo.DoSomething', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['procedural', 'EXEC']])
    expect(classifyStatements('SELECT 1\nSET XACT_ABORT OFF\nUPDATE dbo.T SET a = 1', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['procedural', 'SET'], ['dml', 'UPDATE']])

    // T-SQL read-only: cursor FETCH after OFFSET 0 ROWS and un-semicoloned side-effect statements are blocked.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T ORDER BY id OFFSET 0 ROWS FETCH PRIOR FROM my_cursor', 'sqlserver').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T ORDER BY id OFFSET 0 ROWS FETCH my_cursor', 'sqlserver').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('SELECT 1 ADD SIGNATURE TO dbo.p BY CERTIFICATE c', 'sqlserver').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('SELECT 1 MOVE CONVERSATION @h TO @g', 'sqlserver').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('SELECT 1 GET CONVERSATION GROUP @g FROM dbo.MyQueue', 'sqlserver').length).toBeGreaterThan(0)

    // T-SQL read-only: non-reserved aliases conversation/receive/throw are allowed without false positives.
    expect(checkCrossEngineReadOnly('SELECT CASE WHEN x = 1 THEN 1 ELSE 0 END conversation FROM dbo.Messages', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT id receive FROM dbo.Orders', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders receive WHERE receive.id = 1', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT id throw FROM dbo.Throws', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Throws throw WHERE throw.id = 1', 'sqlserver')).toEqual([])
  })

  it('covers Round 3 edge cases: BQ nested CASE in IF/WHEN, proc non-reserved ids, REPEAT/UNTIL, EXPORT MODEL, BQ paren CTE, T-SQL DDL/INSERT/IF paren, :: and !!', () => {
    // BigQuery nested CASE inside IF/WHEN does not swallow permanent DDL.
    const bqIfCase = classifyStatements('IF CASE WHEN x = 1 THEN TRUE ELSE FALSE END THEN\n  DROP TABLE ds.prod_orders;\nEND IF;', 'bigquery')
    expect(bqIfCase.hasBigQueryPermanentDdl).toBe(true)
    expect(bqIfCase.blocksBigQueryTransaction).toBe(true)
    const bqWhenCase = classifyStatements('CASE x WHEN CASE WHEN y = 1 THEN 1 ELSE 2 END THEN DROP TABLE ds.prod_orders; END CASE;', 'bigquery')
    expect(bqWhenCase.hasBigQueryPermanentDdl).toBe(true)
    expect(bqWhenCase.blocksBigQueryTransaction).toBe(true)

    // BigQuery CREATE PROCEDURE body with non-reserved `begin` / `repeat` identifiers does not swallow trailing DDL.
    const bqProcBegin = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT begin FROM ds.events;\nEND;\nDROP TABLE ds.orders;', 'bigquery')
    expect(bqProcBegin.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])
    const bqProcRepeat = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END repeat FROM ds.t;\nEND;\nDROP TABLE ds.orders;', 'bigquery')
    expect(bqProcRepeat.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // BigQuery REPEAT ... UNTIL ... END REPEAT does not leak conditionalDepth; EXPORT MODEL blocks transactions; WITH ... (SELECT ...) is select.
    const bqRepeat = classifyStatements('REPEAT\n  UPDATE ds.t SET x = 1 WHERE TRUE;\nUNTIL done\nEND REPEAT;\nSELECT 1;', 'bigquery')
    expect(bqRepeat.statements.map(s => [s.category, s.conditional])).toEqual([['dml', true], ['select', false]])
    expect(classifyStatements("EXPORT MODEL ds.m OPTIONS(uri='gs://b/m');", 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('WITH a AS (SELECT 1) (SELECT * FROM a);', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    // T-SQL DDL and INSERT do not swallow subsequent un-semicoloned statements; IF cond (SELECT INTO) is detected.
    expect(classifyStatements('DROP TABLE dbo.T\nEXECUTE dbo.Danger', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'DROP TABLE'], ['procedural', 'EXECUTE']])
    expect(classifyStatements('CREATE TABLE dbo.T (id int)\nSET XACT_ABORT OFF', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TABLE'], ['procedural', 'SET']])
    expect(classifyStatements('INSERT INTO dbo.T SELECT 1 FROM dbo.S\nSELECT * INTO dbo.Backup FROM dbo.S', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('INSERT INTO dbo.T SELECT 1 FROM dbo.S\nEXEC dbo.DropAll', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['procedural', 'EXEC']])
    expect(classifyStatements('IF @x = 1 (SELECT * INTO dbo.Backup FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['dml', 'SELECT INTO', true]])

    // T-SQL `::` continuation is allowed (not SQLCMD), `!!` shell escape is flagged as SQLCMD, invalid GO trailing DDL is not hidden.
    expect(checkCrossEngineReadOnly('SELECT *\nFROM\n::fn_helpcollations()', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT 1\n!!whoami', 'sqlserver').some(v => v.keyword === 'SQLCMD')).toBe(true)
    expect(classifyStatements('SELECT 1\n!!whoami', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'SQLCMD']])
    expect(classifyStatements('SELECT 1\nGO DROP DATABASE Foo', 'sqlserver').hasNonTransactionalTSql).toBe(true)

    // T-SQL read-only: non-reserved identifiers `receive * 2` and `move conversation` have no false positives.
    expect(checkCrossEngineReadOnly('SELECT receive * 2 FROM dbo.Orders', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT move conversation FROM dbo.Moves', 'sqlserver')).toEqual([])
  })

  it('covers Round 4 edge cases: standalone invalid GO, WITH SELECT (expr), ALTER TABLE/DATABASE clauses, non-reserved columns, /* c */ :r, GO :, ADD COUNTER SIGNATURE, BQ CASE+repeat & WITH DML & TEMP AGGREGATE FUNCTION', () => {
    // Standalone invalid GO lines are executable and flagged by read-only guard.
    for (const badGo of ['GO DROP DATABASE Foo', 'GO; SELECT 1', 'GO 2', 'GO 0']) {
      expect(hasExecutableSql(badGo, 'sqlserver'), badGo).toBe(true)
      expect(checkCrossEngineReadOnly(badGo, 'sqlserver').length, badGo).toBeGreaterThan(0)
    }

    // T-SQL WITH cte AS (...) SELECT (<expr>) and SELECT (<expr>) INTO.
    expect(classifyStatements('WITH cte AS (SELECT 1 AS a) SELECT (a + 1) FROM cte;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    expect(classifyStatements('WITH cte AS (SELECT 1 AS a) SELECT (a + 1) INTO dbo.Dest FROM cte;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])
    expect(classifyStatements('WITH cte AS (SELECT 1 AS a) SELECT (1) FROM cte\nUPDATE dbo.T SET a = 1', 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['select', 'SELECT', 1], ['dml', 'UPDATE', 2]])

    // Single ALTER TABLE / ALTER DATABASE statements are not split.
    expect(classifyStatements('ALTER TABLE dbo.Orders DROP COLUMN Region;', 'sqlserver').tags).toEqual(['1 DDL (ALTER TABLE)'])
    expect(classifyStatements('ALTER TABLE dbo.Orders ALTER COLUMN Region nvarchar(100);', 'sqlserver').tags).toEqual(['1 DDL (ALTER TABLE)'])
    expect(classifyStatements('ALTER TABLE dbo.Orders DISABLE TRIGGER ALL;', 'sqlserver').tags).toEqual(['1 DDL (ALTER TABLE)'])
    const alterDb = classifyStatements('ALTER DATABASE Foo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;', 'sqlserver')
    expect(alterDb.hasNonTransactionalTSql).toBe(true)
    expect(alterDb.tags).toEqual(['1 DDL (ALTER DATABASE)'])

    // Non-reserved column names do not split SELECT in classifyTSql.
    expect(classifyStatements('SELECT enable, disable, receive, send, throw FROM dbo.T;', 'sqlserver').tags).toEqual(['1 SELECT'])

    // T-SQL read-only: comment-prefixed :r, `GO :`, ADD COUNTER SIGNATURE, and receive WITH/PIVOT aliases.
    expect(checkCrossEngineReadOnly('SELECT 1\n/* c */ :r evil.sql', 'sqlserver').some(v => v.keyword === 'SQLCMD')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1\nGO : SELECT 2', 'sqlserver').some(v => v.keyword === 'GO')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1\nADD COUNTER SIGNATURE TO dbo.p BY CERTIFICATE c', 'sqlserver').some(v => v.keyword === 'ADD COUNTER SIGNATURE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders receive WITH (NOLOCK)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders receive PIVOT (COUNT(id) FOR k IN ([a])) p', 'sqlserver')).toEqual([])

    // BigQuery: CASE ... END repeat; inside CREATE PROCEDURE, WITH ... DML read-only check, and CREATE TEMP AGGREGATE FUNCTION.
    const bqProcCaseRepeat = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END repeat;\nEND;\nDROP TABLE ds.orders;', 'bigquery')
    expect(bqProcCaseRepeat.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])
    expect(checkCrossEngineReadOnly('WITH cte AS (SELECT 1) DELETE FROM ds.t WHERE TRUE', 'bigquery').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('WITH cte AS (SELECT 1) INSERT INTO ds.t SELECT * FROM cte', 'bigquery').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('WITH cte AS (SELECT 1) (SELECT * FROM cte)', 'bigquery')).toEqual([])
    const bqTempAgg = classifyStatements('CREATE TEMP AGGREGATE FUNCTION f(x INT64) RETURNS INT64 AS (SUM(x));', 'bigquery')
    expect(bqTempAgg.hasBigQueryPermanentDdl).toBe(false)
    expect(bqTempAgg.blocksBigQueryTransaction).toBe(true)
  })

  it('covers Round 5 edge cases: :: multiline quote, AS partition boundary, JOIN send ON conversation, BQ nested (WITH ...), BQ CASE THEN begin, paren SELECT INTO after SELECT, BREAK/CONTINUE', () => {
    // Line-leading `::` opening a multiline quote keeps lexer state intact across lines.
    expect(checkCrossEngineReadOnly("SELECT *\nFROM\n::fn_test('line1\n') DELETE FROM dbo.T", 'sqlserver').some(v => v.keyword === 'DELETE')).toBe(true)
    expect(classifyStatements("SELECT *\nFROM\n::fn_test('line1\n') DROP DATABASE Prod", 'sqlserver').hasNonTransactionalTSql).toBe(true)

    // Non-reserved alias `partition` does not hide following un-semicoloned statements.
    expect(checkCrossEngineReadOnly('SELECT x FROM dbo.T AS partition RECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT x FROM dbo.T AS partition ADD SIGNATURE TO dbo.p BY CERTIFICATE c', 'sqlserver').some(v => v.keyword === 'ADD SIGNATURE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT x FROM dbo.T AS partition MOVE CONVERSATION @h TO @g', 'sqlserver').some(v => v.keyword === 'MOVE CONVERSATION')).toBe(true)

    // Valid `JOIN ... send ON conversation.id = ...` is not mistaken for `SEND ON CONVERSATION`.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Messages m JOIN dbo.Sends send ON conversation.id = m.id', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM dbo.Messages m JOIN dbo.Sends send ON conversation.id = m.id', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    expect(checkCrossEngineReadOnly('SELECT 1 SEND ON CONVERSATION @h MESSAGE TYPE [m]', 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)

    // BigQuery nested parenthesized WITH inside WITH, and CASE ... THEN begin inside CREATE PROCEDURE.
    expect(checkCrossEngineReadOnly('WITH a AS (SELECT 1 AS x) (WITH b AS (SELECT * FROM a) SELECT * FROM b)', 'bigquery')).toEqual([])
    expect(classifyStatements('WITH a AS (SELECT 1 AS x) (WITH b AS (SELECT * FROM a) SELECT * FROM b)', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    const bqProcCaseBegin = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT CASE WHEN a = 1 THEN begin ELSE 0 END FROM ds.t;\nEND;\nDROP TABLE ds.orders;', 'bigquery')
    expect(bqProcCaseBegin.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // T-SQL un-semicoloned parenthesized SELECT INTO after SELECT, and reserved BREAK / CONTINUE.
    expect(classifyStatements('SELECT 1\n(SELECT * INTO dbo.Backup FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'SELECT INTO']])
    expect(checkCrossEngineReadOnly('SELECT 1 BREAK', 'sqlserver').some(v => v.keyword === 'BREAK')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1 CONTINUE', 'sqlserver').some(v => v.keyword === 'CONTINUE')).toBe(true)
  })

  it('covers Round 6 edge cases: FOR SYSTEM_TIME ALL, BQ WHILE/FOR with var do, SEND string/func handle, receive alias forms, paren SELECT after DML/DDL, CREATE PROC ds.begin(), BEGIN DIALOG', () => {
    // T-SQL FOR SYSTEM_TIME ALL ends a SELECT and does not mask trailing un-semicoloned statements.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders FOR SYSTEM_TIME ALL\nRECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly("SELECT * FROM dbo.Orders FOR SYSTEM_TIME ALL\nSEND ON CONVERSATION @h MESSAGE TYPE [m]", 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(classifyStatements('SELECT * FROM dbo.Orders FOR SYSTEM_TIME ALL\nSELECT * INTO dbo.Backup FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('SELECT * FROM dbo.Orders FOR SYSTEM_TIME ALL\n(SELECT * INTO dbo.Backup FROM dbo.Orders)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'SELECT INTO']])

    // BigQuery WHILE/FOR with variable named `do` does not swallow permanent DDL.
    expect(classifyStatements('FOR do IN (SELECT 1 AS x) DO\n  DROP TABLE ds.prod_orders;\nEND FOR;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(classifyStatements('DECLARE do INT64 DEFAULT 0;\nWHILE do < 10 DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(classifyStatements('DECLARE do BOOL DEFAULT FALSE;\nWHILE NOT do DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // T-SQL SEND ON CONVERSATION with string literal or scalar function call handle is caught.
    expect(checkCrossEngineReadOnly("SELECT 1\nSEND ON CONVERSATION '00000000-0000-0000-0000-000000000000' MESSAGE TYPE [m]", 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(checkCrossEngineReadOnly("SELECT 1\nSEND ON CONVERSATION CAST('00000000-0000-0000-0000-000000000000' AS uniqueidentifier) MESSAGE TYPE [m]", 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(classifyStatements("SELECT 1\nSEND ON CONVERSATION '00000000-0000-0000-0000-000000000000' MESSAGE TYPE [m]", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'SEND']])

    // T-SQL non-reserved alias `receive` before SELECT, WINDOW, and derived-table column list has no false positives, while RECEIVE (col) FROM q is caught.
    expect(checkCrossEngineReadOnly('SELECT 1 receive\nSELECT 2', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Orders receive\nSELECT 2', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT id, SUM(amt) OVER w FROM dbo.Orders receive WINDOW w AS (ORDER BY id)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM (SELECT 1) receive(id)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT 1\nRECEIVE (message_body) FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)

    // T-SQL parenthesized SELECT after DML/DDL, BigQuery CREATE PROCEDURE ds.begin(), and T-SQL IF BEGIN DIALOG CONVERSATION.
    expect(classifyStatements('UPDATE dbo.T SET a = 1\n(SELECT * INTO dbo.Backup FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('CREATE TABLE dbo.T (id int)\n(SELECT * FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TABLE'], ['select', 'SELECT']])
    expect(classifyStatements('CREATE PROCEDURE ds.begin() LANGUAGE js AS "return 1;";\nDROP TABLE ds.prod_orders;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])
    expect(classifyStatements("IF @x = 1 BEGIN DIALOG CONVERSATION @h FROM SERVICE s1 TO SERVICE 's2' ON CONTRACT c; SELECT 1;", 'sqlserver').statements.map(s => [s.category, s.conditional])).toEqual([['admin', true], ['select', false]])
  })

  it('covers Round 7 edge cases: CASE IS DISTINCT FROM + SELECT_ASSIGN, BQ WHILE DO (SELECT), CR-only BQ comments, RECEIVE (expr), SEND udf/CASE, WITH receive(id)/APPLY receive(), INSERT (SELECT)/SYSTEM_TIME ALL', () => {
    // T-SQL CASE ... IS [NOT] DISTINCT FROM inside SELECT list does not disable SELECT_ASSIGN detection.
    expect(checkCrossEngineReadOnly('SELECT CASE WHEN a IS DISTINCT FROM b THEN 1 ELSE 0 END, @v = 1 FROM dbo.T', 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT CASE WHEN a IS NOT DISTINCT FROM b THEN 1 ELSE 0 END, @v = 1 FROM dbo.T', 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)

    // BigQuery WHILE ... DO followed by parenthesized query does not swallow loop body DDL.
    expect(classifyStatements('DECLARE x INT64 DEFAULT 0;\nWHILE x < 10 DO\n  (SELECT 1);\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(classifyStatements('DECLARE x INT64 DEFAULT 0;\nWHILE x < 10 DO\n  (WITH a AS (SELECT 1) SELECT * FROM a);\n  DROP TABLE ds.t;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // BigQuery CR-only line endings after -- or # comments do not swallow trailing SQL.
    expect(hasExecutableSql('-- comment\rDROP TABLE ds.prod_orders;', 'bigquery')).toBe(true)
    expect(classifyStatements('-- comment\rDROP TABLE ds.prod_orders;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(checkCrossEngineReadOnly('-- comment\rDROP TABLE ds.prod_orders;', 'bigquery').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('# comment\rDROP TABLE ds.prod_orders;', 'bigquery').length).toBeGreaterThan(0)

    // T-SQL RECEIVE (expr) alias/+ after parenthesized SELECT is caught, while WITH receive(id) and CROSS/OUTER APPLY receive(1) are allowed.
    expect(checkCrossEngineReadOnly('SELECT (1)\nRECEIVE (conversation_handle) h FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT (1)\nRECEIVE (message_body) + 0x00 FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly('WITH receive (id) AS (SELECT 1) SELECT * FROM receive', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T CROSS APPLY receive(1)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T OUTER APPLY receive(1)', 'sqlserver')).toEqual([])

    // T-SQL SEND ON CONVERSATION with schema-qualified scalar UDF or CASE handle is caught.
    expect(checkCrossEngineReadOnly('SELECT 1\nSEND ON CONVERSATION dbo.GetHandle() MESSAGE TYPE [m]', 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1\nSEND ON CONVERSATION CASE WHEN 1=1 THEN @h END MESSAGE TYPE [m]', 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)

    // T-SQL INSERT INTO ... (SELECT ...) and INSERT INTO ... FOR SYSTEM_TIME ALL do not swallow trailing statements.
    expect(classifyStatements('INSERT INTO dbo.T (a) (SELECT 1 FROM dbo.S)\nSELECT * INTO dbo.Backup FROM dbo.T', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('INSERT INTO dbo.T (a) (SELECT 1 FROM dbo.S)\nEXEC dbo.DropAll', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['procedural', 'EXEC']])
    expect(classifyStatements('INSERT INTO dbo.T (a) SELECT 1 FROM dbo.S FOR SYSTEM_TIME ALL\nSELECT * INTO dbo.Backup FROM dbo.T', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['dml', 'SELECT INTO']])
  })

  it('covers Round 8 edge cases: MERGE join/query hints, non-reserved APPLY/NEXT/FIRST/OFFSET aliases, SEND 0x hex handle, BQ CREATE PROC BEGIN (SELECT), BQ UTF-8 BOM', () => {
    // T-SQL MERGE join hints and OPTION (MERGE JOIN|UNION) are allowed read-only and do not split SELECT.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A INNER MERGE JOIN dbo.B ON a.id = b.id', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A LEFT OUTER MERGE JOIN dbo.B ON a.id = b.id', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A JOIN dbo.B ON a.id = b.id OPTION (MERGE JOIN)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT 1 UNION SELECT 2 OPTION (MERGE UNION)', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM dbo.A INNER MERGE JOIN dbo.B ON a.id = b.id', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    // Non-reserved APPLY/NEXT/FIRST/OFFSET aliases do not mask trailing un-semicoloned statements.
    expect(checkCrossEngineReadOnly('SELECT 1 AS apply\nRECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.Jobs apply\nSEND ON CONVERSATION @h MESSAGE TYPE [m]', 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(checkCrossEngineReadOnly("SELECT 1 AS apply\nTHROW 50000, 'boom', 1", 'sqlserver').some(v => v.keyword === 'THROW')).toBe(true)
    for (const alias of ['apply', 'next', 'first', 'offset']) {
      expect(classifyStatements(`SELECT 1 AS ${alias}\n(SELECT * INTO dbo.Backup FROM dbo.T)`, 'sqlserver').statements.map(s => [s.category, s.keyword]), alias).toEqual([['select', 'SELECT'], ['dml', 'SELECT INTO']])
    }

    // T-SQL SEND ON CONVERSATION 0x... hex handle is caught.
    expect(checkCrossEngineReadOnly('SELECT 1\nSEND ON CONVERSATION 0x0102030405060708090A0B0C0D0E0F10 MESSAGE TYPE [m]', 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(classifyStatements('SELECT 1\nSEND ON CONVERSATION 0x0102030405060708090A0B0C0D0E0F10 MESSAGE TYPE [m]', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'SEND']])

    // BigQuery CREATE PROCEDURE with parenthesized first statement does not leak procedure body statements; UTF-8 BOM is allowed.
    const bqProcParen = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  (SELECT 1);\n  DROP TABLE ds.inside_proc;\nEND;\nSELECT 2;', 'bigquery')
    expect(bqProcParen.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['select', 'SELECT']])
    expect(checkCrossEngineReadOnly('\uFEFFSELECT 1', 'bigquery')).toEqual([])
  })

  it('covers Round 9 edge cases: GRANT/REVOKE/DENY DCL mode, receive(id) comma join & WINDOW [w], BQ WITH fail-closed, CREATE OR ALTER VIEW, WITH options on BACKUP/RESTORE/BEGIN TRAN, sqlcmd span', () => {
    // T-SQL GRANT/REVOKE/DENY do not split permission names or set false-positive hasNonTransactionalTSql.
    expect(classifyStatements('GRANT BACKUP DATABASE TO [BackupRole];', 'sqlserver')).toMatchObject({ hasNonTransactionalTSql: false, statements: [{ category: 'admin', keyword: 'GRANT' }] })
    expect(classifyStatements('GRANT CREATE DATABASE TO [AdminRole];', 'sqlserver')).toMatchObject({ hasNonTransactionalTSql: false, statements: [{ category: 'admin', keyword: 'GRANT' }] })
    expect(classifyStatements('DENY SHUTDOWN TO [AppRole];', 'sqlserver')).toMatchObject({ hasNonTransactionalTSql: false, statements: [{ category: 'admin', keyword: 'DENY' }] })
    expect(classifyStatements('GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Orders TO [AppRole] WITH GRANT OPTION;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'GRANT']])
    expect(classifyStatements('REVOKE GRANT OPTION FOR SELECT ON dbo.Orders FROM [AppRole];', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'REVOKE']])
    expect(classifyStatements('GRANT SELECT ON dbo.T TO [u]\nDROP DATABASE Foo', 'sqlserver').hasNonTransactionalTSql).toBe(true)

    // T-SQL receive(id) comma join in FROM and bracketed WINDOW [w] have no false positives, while RECEIVE (col), col FROM q is still caught.
    expect(checkCrossEngineReadOnly('SELECT * FROM (SELECT 1) receive(id), dbo.Other', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM (SELECT 1) receive(id), dbo.Other', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    expect(checkCrossEngineReadOnly('SELECT (1)\nRECEIVE (conversation_handle), message_body FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT id, SUM(amt) OVER [w] FROM dbo.Orders receive WINDOW [w] AS (ORDER BY id)', 'sqlserver')).toEqual([])

    // BigQuery WITH fails closed on unexpected non-SELECT/DML tokens after CTE bodies.
    expect(checkCrossEngineReadOnly('WITH a AS (SELECT 1) CREATE TABLE ds.t AS SELECT * FROM a', 'bigquery').length).toBeGreaterThan(0)
    expect(checkCrossEngineReadOnly('WITH a AS (SELECT 1) EXPORT DATA OPTIONS(uri="gs://b/*.csv", format="CSV") AS SELECT * FROM a', 'bigquery').length).toBeGreaterThan(0)
    expect(classifyStatements('WITH a AS (SELECT 1) CREATE TABLE ds.t AS SELECT * FROM a', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // T-SQL CREATE OR ALTER VIEW, ALTER RESOURCE GOVERNOR RECONFIGURE, and BACKUP/RESTORE/RECONFIGURE/BEGIN TRAN WITH options stay single statements.
    expect(classifyStatements('CREATE OR ALTER VIEW dbo.vOrders WITH SCHEMABINDING AS SELECT Id FROM dbo.Orders;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE VIEW']])
    expect(classifyStatements('ALTER RESOURCE GOVERNOR RECONFIGURE;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.nonTransactional])).toEqual([['ddl', 'ALTER RESOURCE', true]])
    expect(classifyStatements("BACKUP DATABASE MyDb TO DISK = 'x.bak' WITH COMPRESSION, INIT, STATS = 10;", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'BACKUP']])
    expect(classifyStatements("RESTORE DATABASE MyDb FROM DISK = 'x.bak' WITH RECOVERY, REPLACE;", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'RESTORE']])
    expect(classifyStatements('RECONFIGURE WITH OVERRIDE;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'RECONFIGURE']])
    expect(classifyStatements("BEGIN TRANSACTION t1 WITH MARK 'deploy';", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['transaction', 'BEGIN TRANSACTION']])

    // Synthetic SQLCMD spans stop before the trailing newline.
    const commentSqlcmd = checkCrossEngineReadOnly('SELECT 1\n/* c */ :r evil.sql\nSELECT 2', 'sqlserver')
    expect(commentSqlcmd).toMatchObject([{ line: 2, endLine: 2, keyword: 'SQLCMD' }])
    const bangSqlcmd = checkCrossEngineReadOnly('SELECT 1\n!!whoami\nSELECT 2', 'sqlserver')
    expect(bangSqlcmd).toMatchObject([{ line: 2, endLine: 2, keyword: 'SQLCMD' }])
  })

  it('covers Round 10 edge cases: RECEIVE after FROM-clause ), scalar func((SELECT)), TOP (SELECT), DDL + IF EXISTS (), BQ begin: LOOP, INSERT WITH TIES, DECLARE CURSOR, ALTER DB SET ANSI_NULLS', () => {
    // T-SQL Service Broker RECEIVE after FROM-clause closing paren (`WITH (NOLOCK)`, `ON (...)`, TVF) is caught.
    for (const q of [
      'SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), message_body FROM dbo.MyQueue',
      'SELECT * FROM dbo.A JOIN dbo.B ON (a.id = b.id)\nRECEIVE (conversation_handle), message_body FROM dbo.MyQueue',
      'SELECT * FROM dbo.MyTvf(1)\nRECEIVE (conversation_handle), message_body FROM dbo.MyQueue'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'RECEIVE'), q).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])
    }

    // Scalar function calls wrapping `(SELECT ...)` and `SELECT TOP ... (SELECT ...)` stay single statements.
    expect(classifyStatements('SELECT ISNULL((SELECT MAX(id) FROM dbo.Orders), 0) AS MaxId;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT COALESCE((SELECT 1), 0);', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT CAST((SELECT 1) AS int);', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('UPDATE dbo.Orders SET Total = COALESCE((SELECT SUM(Amt) FROM dbo.OrderLines), 0) WHERE Id = 1;', 'sqlserver').tags).toEqual(['1 DML (UPDATE)'])
    expect(classifyStatements('DELETE FROM dbo.T WHERE id = ABS((SELECT -1));', 'sqlserver').tags).toEqual(['1 DML (DELETE)'])
    expect(classifyStatements('SET @x = ISNULL((SELECT MAX(id) FROM dbo.T), 0);', 'sqlserver').tags).toEqual(['1 procedural'])
    expect(classifyStatements('IF ISNULL((SELECT MAX(id) FROM dbo.Orders), 0) > 10\n  UPDATE dbo.Orders SET status = 1;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['dml', 'UPDATE', true]])
    expect(classifyStatements('SELECT TOP 1 (SELECT 1) FROM dbo.T;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP (1) (SELECT 1) FROM dbo.T;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP 10 PERCENT (SELECT 1) FROM dbo.T;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP 10 WITH TIES (SELECT 1) FROM dbo.T ORDER BY id;', 'sqlserver').tags).toEqual(['1 SELECT'])

    // Un-semicoloned DDL followed by `IF [NOT] EXISTS (SELECT ...)` preserves conditional tracking.
    expect(classifyStatements('DROP TABLE dbo.OldOrders\nIF EXISTS (SELECT 1 FROM dbo.Orders)\n  SELECT COUNT(*) FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['ddl', 'DROP TABLE', false], ['select', 'SELECT', true]])
    expect(classifyStatements('CREATE TABLE dbo.Staging (id int)\nIF NOT EXISTS (SELECT 1 FROM dbo.Settings)\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['ddl', 'CREATE TABLE', false], ['select', 'SELECT', true], ['select', 'SELECT', true]])

    // BigQuery labeled `begin: LOOP` inside CREATE PROCEDURE does not swallow trailing DDL.
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  begin: LOOP\n    SELECT 1;\n    LEAVE begin;\n  END LOOP;\nEND;\nDROP TABLE ds.t;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // T-SQL INSERT WITH TIES/ROLLUP, DECLARE CURSOR FOR SELECT, and ALTER DATABASE SET ANSI_NULLS ON stay single statements.
    expect(classifyStatements('INSERT INTO dbo.T SELECT TOP 10 WITH TIES * FROM dbo.S ORDER BY id;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT']])
    expect(classifyStatements('INSERT INTO dbo.T SELECT a, COUNT(*) FROM dbo.S GROUP BY a WITH ROLLUP;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT']])
    expect(classifyStatements('DECLARE cur CURSOR FOR SELECT 1 FROM dbo.T;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'DECLARE']])
    expect(classifyStatements('ALTER DATABASE Foo SET ANSI_NULLS ON;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.nonTransactional])).toEqual([['ddl', 'ALTER DATABASE', true]])
  })

  it('covers Round 11 edge cases: RECEIVE LEFT/RIGHT(), RECEIVE (col), CASE...END, cursor FETCH next, TOP FUNC((SELECT)), DECLARE CURSOR FOR UPDATE, GO::Method(), JOIN send ON conversation LIKE/BETWEEN', () => {
    // T-SQL RECEIVE LEFT(...) / RIGHT(...) and RECEIVE (col), CASE ... END FROM <queue> are caught.
    for (const q of [
      'SELECT 1\nRECEIVE LEFT(service_name, 10) FROM dbo.MyQueue',
      'SELECT 1\nRECEIVE RIGHT(service_name, 10) FROM dbo.MyQueue',
      'SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), CASE WHEN 1 = 1 THEN 1 ELSE 2 END FROM dbo.MyQueue',
      'SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), CASE WHEN 1 = 1 THEN 1 END FROM dbo.MyQueue'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'RECEIVE'), q).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])
    }
    // Valid LEFT/RIGHT JOIN after alias `receive` remains allowed.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A receive LEFT JOIN dbo.B b ON b.id = receive.id', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A receive RIGHT OUTER JOIN dbo.B b ON b.id = receive.id', 'sqlserver')).toEqual([])

    // Cursor `FETCH next` / `FETCH first` after `SELECT offset ... AS rows` is caught.
    expect(checkCrossEngineReadOnly('SELECT offset FROM dbo.T AS rows\nFETCH next', 'sqlserver').some(v => v.keyword === 'FETCH')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT offset FROM dbo.T AS rows\nFETCH first', 'sqlserver').some(v => v.keyword === 'FETCH')).toBe(true)
    expect(classifyStatements('SELECT offset FROM dbo.T AS rows\nFETCH next', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['procedural', 'FETCH']])

    // SELECT TOP ... FUNC((SELECT ...)) stays a single SELECT.
    expect(classifyStatements('SELECT TOP 1 ISNULL((SELECT MAX(id) FROM dbo.Orders), 0) FROM dbo.Orders;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP (1) COALESCE((SELECT MAX(id) FROM dbo.Orders), 0) FROM dbo.Orders;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP 10 PERCENT ABS((SELECT -1)) FROM dbo.Orders;', 'sqlserver').tags).toEqual(['1 SELECT'])
    expect(classifyStatements('SELECT TOP 10 WITH TIES ISNULL((SELECT 1), 0) FROM dbo.T ORDER BY 1', 'sqlserver').tags).toEqual(['1 SELECT'])

    // DECLARE CURSOR FOR SELECT ... FOR UPDATE, GO::Parse(1), and JOIN send ON conversation LIKE/BETWEEN.
    expect(classifyStatements('DECLARE cur CURSOR FOR SELECT id FROM dbo.T FOR UPDATE OF col1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'DECLARE']])
    expect(checkCrossEngineReadOnly('SELECT\nGO::Parse(1)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly("SELECT * FROM dbo.A a JOIN dbo.B send ON conversation LIKE ('%foo%')", 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A a JOIN dbo.B send ON conversation BETWEEN (1) AND (2)', 'sqlserver')).toEqual([])
  })

  it('covers Round 12 edge cases: RECEIVE AS send, CASE with paginated subquery, TOP receive/move/add/get, SEND db..fn(), FETCH next SELECT 2, DATABASE SCOPED, FOR SYSTEM_TIME comma join, ALTER ROLE DROP MEMBER / STATISTICS WITH FULLSCAN', () => {
    // T-SQL Service Broker RECEIVE with non-reserved column alias (AS send/throw/enable/disable/receive) is caught.
    for (const alias of ['send', 'throw', 'enable', 'disable', 'receive']) {
      const q = `SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), message_body AS ${alias} FROM dbo.MyQueue`
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'RECEIVE'), alias).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), alias).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])
    }

    // Valid CASE containing paginated subquery (ORDER BY ... OFFSET ... FETCH NEXT) has zero violations.
    expect(checkCrossEngineReadOnly('SELECT CASE WHEN o.Status = 1 THEN (SELECT l.Amount FROM dbo.OrderLines l ORDER BY l.LineId OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY) ELSE 0 END FROM dbo.Orders o', 'sqlserver')).toEqual([])

    // Valid SELECT TOP ... receive/move/add/get expressions are allowed and stay 1 SELECT.
    for (const q of [
      'SELECT TOP 1 receive + 1 FROM dbo.Moves',
      'SELECT TOP (10) receive * 2 FROM dbo.Orders',
      'SELECT TOP 10 PERCENT receive + 1 FROM dbo.Orders',
      'SELECT TOP 10 WITH TIES receive + 1 FROM dbo.Orders ORDER BY id',
      'SELECT TOP 1 move conversation FROM dbo.Moves',
      'SELECT TOP 1 add signature FROM dbo.Docs',
      'SELECT TOP 10 WITH TIES get conversation group FROM dbo.Docs ORDER BY id'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver'), q).toEqual([])
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT']])
    }

    // SEND ON CONVERSATION with omitted-schema `..` function syntax is caught.
    for (const q of [
      'SELECT 1\nSEND ON CONVERSATION mydb..GetHandle() MESSAGE TYPE [m]',
      'SELECT 1\nSEND ON CONVERSATION [mydb]..[GetHandle]() MESSAGE TYPE [m]',
      'SELECT 1\nSEND ON CONVERSATION srv.mydb..GetHandle() MESSAGE TYPE [m]'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION'), q).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['admin', 'SEND']])
    }

    // Cursor `FETCH next` / `FETCH first` after `OFFSET 0 ROWS` followed by `SELECT 2` is caught.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T ORDER BY id OFFSET 0 ROWS\nFETCH next\nSELECT 2', 'sqlserver').some(v => v.keyword === 'FETCH')).toBe(true)
    expect(classifyStatements('SELECT * FROM dbo.T ORDER BY id OFFSET 0 ROWS\nFETCH next\nSELECT 2', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['procedural', 'FETCH'], ['select', 'SELECT']])

    // Transactional DATABASE SCOPED CONFIGURATION / CREDENTIAL are not flagged non-transactional.
    expect(classifyStatements('ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 4;', 'sqlserver').hasNonTransactionalTSql).toBe(false)
    expect(classifyStatements("CREATE DATABASE SCOPED CREDENTIAL [c] WITH IDENTITY = 'u';", 'sqlserver').hasNonTransactionalTSql).toBe(false)

    // FOR SYSTEM_TIME does not clear inFromClause; ALTER ROLE DROP MEMBER and STATISTICS WITH FULLSCAN stay single statements.
    expect(checkCrossEngineReadOnly("SELECT * FROM dbo.Orders FOR SYSTEM_TIME AS OF '2025-01-01', (SELECT 1) receive(id), dbo.Other", 'sqlserver')).toEqual([])
    expect(classifyStatements('ALTER ROLE db_owner DROP MEMBER [u];', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER ROLE']])
    expect(classifyStatements('UPDATE STATISTICS dbo.T WITH FULLSCAN;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE']])
    expect(classifyStatements('CREATE STATISTICS st ON dbo.T(a) WITH FULLSCAN;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE STATISTICS']])
  })

  it('covers Round 13 edge cases: CREATE/ALTER/DROP DATABASE Audit/Scoped, O(N) nested FETCH NEXT (, FETCH NEXT expr/func, IS DISTINCT FROM in JOIN/IF, UPDATE STATISTICS + SET', () => {
    // Unbracketed database named `Audit` or `Scoped` is still non-transactional CREATE/ALTER/DROP DATABASE.
    for (const q of [
      'CREATE DATABASE Audit;',
      'DROP DATABASE Audit;',
      'ALTER DATABASE Audit SET RECOVERY SIMPLE;',
      'CREATE DATABASE Scoped;',
      'DROP DATABASE Scoped;'
    ]) {
      const res = classifyStatements(q, 'sqlserver')
      expect(res.hasNonTransactionalTSql, q).toBe(true)
      expect(res.statements.length, q).toBe(1)
    }

    // Valid FETCH NEXT <expr> ROWS ONLY (arithmetic & scalar functions) is allowed and linear-time on nested `FETCH NEXT (`.
    for (const q of [
      'SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT @pageSize + 1 ROWS ONLY',
      'SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT 10 + 5 ROWS ONLY',
      'SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT ISNULL(@pageSize, 50) ROWS ONLY',
      'SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT CAST(@n AS int) ROWS ONLY'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver'), q).toEqual([])
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT']])
    }
    const t0 = performance.now()
    const nestedFetch = 'SELECT 1 ORDER BY 1 OFFSET 0 ROWS FETCH NEXT ('.repeat(3000) + '1' + ') ROWS ONLY'.repeat(3000)
    expect(checkCrossEngineReadOnly(nestedFetch, 'sqlserver')).toEqual([])
    expect(performance.now() - t0).toBeLessThan(1500)

    // IS [NOT] DISTINCT FROM in JOIN after receive(id) and in IF condition with (SELECT ...).
    expect(checkCrossEngineReadOnly('SELECT * FROM (SELECT 1) receive(id), dbo.T JOIN dbo.U ON dbo.T.a IS DISTINCT FROM dbo.U.b', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM (SELECT 1) receive(id), dbo.T JOIN dbo.U ON dbo.T.a IS NOT DISTINCT FROM dbo.U.b', 'sqlserver')).toEqual([])
    expect(classifyStatements('IF @a IS DISTINCT FROM (SELECT MAX(id) FROM dbo.T) UPDATE dbo.T SET x = 1;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['dml', 'UPDATE', true]])
    expect(classifyStatements('IF @a IS NOT DISTINCT FROM (SELECT 1) SELECT 2;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['select', 'SELECT', true]])

    // UPDATE STATISTICS followed by un-semicoloned SET is not swallowed.
    expect(classifyStatements('UPDATE STATISTICS dbo.T\nSET XACT_ABORT OFF', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['procedural', 'SET']])
  })

  it('covers Round 14 edge cases: WITHIN GROUP + SELECT_ASSIGN/SELECT INTO, and O(N) FETCH NEXT CASE', () => {
    // WITHIN GROUP (ORDER BY ...) does not end the SELECT list in checkTSqlReadOnly or classifyTSql.
    expect(checkCrossEngineReadOnly("SELECT STRING_AGG(Name, ',') WITHIN GROUP (ORDER BY Id), @v = 1 FROM dbo.T", 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY Val) OVER (), @v = 1 FROM dbo.T', 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)
    expect(classifyStatements("SELECT STRING_AGG(Name, ',') WITHIN GROUP (ORDER BY Id) INTO dbo.Summary FROM dbo.T", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])

    // Adversarial repeated `ROWS FETCH NEXT CASE ` stays strictly O(N).
    const t0 = performance.now()
    const badFetchCase = 'SELECT 1 ORDER BY 1 OFFSET 0 ROWS ' + 'ROWS FETCH NEXT CASE '.repeat(8000)
    expect(checkCrossEngineReadOnly(badFetchCase, 'sqlserver').length).toBeGreaterThan(0)
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('covers Round 15 edge cases: DATABASE AUDIT SPECIFICATION non-transactional, (SELECT) inside DECLARE/RETURN/PRINT/RAISERROR/AUDIT ADD, BULK INSERT, WITH NOWAIT/LOG/etc.', () => {
    // DATABASE AUDIT SPECIFICATION is non-transactional and ADD (SELECT ON ...) does not emit a phantom SELECT.
    const auditAlter = classifyStatements('ALTER DATABASE AUDIT SPECIFICATION [Spec] WITH (STATE = OFF);', 'sqlserver')
    expect(auditAlter.hasNonTransactionalTSql).toBe(true)
    expect(auditAlter.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE AUDIT SPECIFICATION']])
    const auditCreate = classifyStatements('CREATE DATABASE AUDIT SPECIFICATION [Spec] FOR SERVER AUDIT [Aud] ADD (SELECT ON DATABASE::[MyDb] BY [public]) WITH (STATE = ON);', 'sqlserver')
    expect(auditCreate.hasNonTransactionalTSql).toBe(true)
    expect(auditCreate.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE DATABASE AUDIT SPECIFICATION']])
    const srvAudit = classifyStatements('CREATE SERVER AUDIT SPECIFICATION [Spec] FOR SERVER AUDIT [Aud] ADD (SELECT ON OBJECT::dbo.T BY [public]) WITH (STATE = ON);', 'sqlserver')
    expect(srvAudit.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE SERVER']])

    // Single statements containing `(SELECT ...)` do not emit phantom SELECTs.
    expect(classifyStatements('DECLARE c CURSOR FOR (SELECT id FROM dbo.T);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'DECLARE']])
    expect(classifyStatements('RETURN (SELECT COUNT(*) FROM dbo.T);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'RETURN']])
    expect(classifyStatements('PRINT (SELECT TOP 1 Name FROM dbo.T);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'PRINT']])
    expect(classifyStatements("RAISERROR ((SELECT 'err'), 16, 1);", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'RAISERROR']])

    // BULK INSERT is classified as a single DML statement even without a preceding semicolon.
    expect(classifyStatements("BULK INSERT dbo.T FROM 'c:\\a.csv' WITH (FIRSTROW = 2);", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'BULK INSERT']])
    expect(classifyStatements("SELECT 1\nBULK INSERT dbo.T FROM 'c:\\a.csv'", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'BULK INSERT']])

    // Common T-SQL WITH options stay attached to their statement and preserve line numbers.
    expect(classifyStatements("RAISERROR ('Starting...', 0, 1) WITH NOWAIT;", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'RAISERROR']])
    expect(classifyStatements("IF @debug = 1\n  RAISERROR ('Starting...', 0, 1) WITH NOWAIT\nSELECT * FROM dbo.Orders;", 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['procedural', 'RAISERROR', 2], ['select', 'SELECT', 3]])
    expect(classifyStatements('DBCC CHECKDB (Foo) WITH ALL_ERRORMSGS;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'DBCC']])
    expect(classifyStatements('CREATE USER [u] FOR LOGIN [l] WITH DEFAULT_SCHEMA = dbo\nSELECT 1;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['ddl', 'CREATE USER', 1], ['select', 'SELECT', 2]])
    expect(classifyStatements('END CONVERSATION @h WITH CLEANUP;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'END CONVERSATION']])
  })

  it('covers Round 16 edge cases: BQ EXPORT TABLE METADATA, T-SQL WITH <opt> = <val>, GRANT ADMINISTER BULK OPERATIONS', () => {
    const bqExportMeta = classifyStatements('EXPORT TABLE METADATA FROM ds.iceberg_tbl;', 'bigquery')
    expect(bqExportMeta.blocksBigQueryTransaction).toBe(true)
    expect(bqExportMeta.statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'EXPORT TABLE METADATA']])

    expect(classifyStatements("RESTORE DATABASE MyDb FROM DISK = 'x.bak' WITH FILE = 1, RECOVERY\nSELECT 1;", 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['admin', 'RESTORE', 1], ['select', 'SELECT', 2]])
    expect(classifyStatements("CREATE CERTIFICATE [c] WITH SUBJECT = 'test'\nSELECT 1;", 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['ddl', 'CREATE CERTIFICATE', 1], ['select', 'SELECT', 2]])
    expect(classifyStatements('CREATE DATABASE ENCRYPTION KEY WITH ALGORITHM = AES_256 ENCRYPTION BY SERVER CERTIFICATE Cert1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE DATABASE']])
    expect(classifyStatements('GRANT ADMINISTER BULK OPERATIONS TO [u];', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'GRANT']])
  })

  it('covers Round 17 edge cases: dot-qualified reserved ids in T-SQL/BigQuery, FROM tbl ((SELECT INTO)), BQ proc SELECT do/t.then begin', () => {
    // Dot-qualified reserved identifiers do not bypass un-semicoloned read-only guards.
    for (const q of [
      'SELECT * FROM dbo.T t WHERE t.x = t.top\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT * FROM dbo.T t WHERE t.x = t.all\nSEND ON CONVERSATION @h MESSAGE TYPE [m]',
      'SELECT * FROM dbo.T t WHERE t.x = t.on\nMOVE CONVERSATION @h TO @g',
      'SELECT * FROM dbo.T t WHERE t.x = t.by\nGET CONVERSATION GROUP @g FROM dbo.MyQueue',
      'SELECT * FROM dbo.T t WHERE t.x = t.in\nADD SIGNATURE TO dbo.p BY CERTIFICATE c',
      "SELECT * FROM dbo.T t WHERE t.x = t.is\nTHROW 50000, 'boom', 1",
      'SELECT * FROM dbo.select\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT * FROM dbo.cross apply\nRECEIVE TOP(1) * FROM dbo.MyQueue'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
    }

    // Dot-qualified `.distinct` works cleanly for both comma-join receive(id) and RECEIVE ... col.distinct FROM.
    expect(checkCrossEngineReadOnly('SELECT t.distinct FROM (SELECT 1) receive(id), dbo.Other', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), col.distinct FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(classifyStatements('SELECT * FROM dbo.T WITH (NOLOCK)\nRECEIVE (conversation_handle), col.distinct FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])

    // BigQuery WHILE condition ending with dot-qualified reserved field (`s.in`) does not swallow loop DDL.
    expect(classifyStatements('DECLARE s STRUCT<`in` BOOL> DEFAULT STRUCT(TRUE AS `in`);\nWHILE s.in DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // T-SQL `FROM <table_ref>\n((SELECT * INTO ...))` is not mistaken for a scalar function call.
    for (const q of [
      'SELECT * FROM dbo.Orders\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM Orders\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.in my_alias\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'UPDATE dbo.T SET a = 1 FROM dbo.S\n((SELECT * INTO dbo.Backup FROM dbo.Orders))'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.some(s => s.keyword === 'SELECT INTO'), q).toBe(true)
    }

    // BigQuery CREATE PROCEDURE body with `SELECT do begin` / `SELECT t.then begin` does not swallow trailing DDL.
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT do begin FROM ds.t;\nEND;\nDROP TABLE ds.outside;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  SELECT t.then begin FROM ds.t;\nEND;\nDROP TABLE ds.outside;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])
  })

  it('covers Round 18 edge cases: SEND :: static handle, standalone ((SELECT INTO)), ORDER BY offset / FETCH next (SELECT INTO), BQ proc paren UNION, DDL+EXECUTE AS, ALTER+DROP EVENT, multiline SQLCMD', () => {
    // T-SQL SEND ON CONVERSATION with :: static method/property handle is caught.
    for (const q of [
      'SELECT 1\nSEND ON CONVERSATION dbo.MyType::GetHandle() MESSAGE TYPE [m]',
      'SELECT 1\nSEND ON CONVERSATION MyType::GetHandle() MESSAGE TYPE [m]',
      'SELECT 1\nSEND ON CONVERSATION dbo.MyType::DefaultHandle MESSAGE TYPE [m]'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION'), q).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['admin', 'SEND']])
    }

    // Standalone `((SELECT ...))` / `((SELECT * INTO ...))` is not swallowed as a scalar function call.
    expect(classifyStatements('IF @x IS NULL\n((SELECT 1))', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['select', 'SELECT', true]])
    expect(classifyStatements('IF @x IS NULL ((SELECT 1))', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['select', 'SELECT', true]])
    for (const q of [
      'IF @x IS NULL\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.Orders, dbo.Customers\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.Orders o WHERE o.CustomerId = o.ParentId\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.Orders WHERE Status = Active\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.Orders ORDER BY Id\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SET @x = NULL\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'UPDATE dbo.Orders SET Status = NewStatus\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT TOP 1 a\n((SELECT * INTO dbo.Backup FROM dbo.Orders))',
      'SELECT * FROM dbo.Orders WHERE Status = Active ((SELECT * INTO dbo.Backup FROM dbo.Orders))'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.some(s => s.keyword === 'SELECT INTO'), q).toBe(true)
    }

    // ORDER BY col, offset / col + offset and cursor FETCH next/first do not swallow `(SELECT * INTO ...)`, while valid OFFSET/FETCH pagination stays 1 SELECT.
    for (const q of [
      'SELECT * FROM dbo.Orders ORDER BY id, offset\n(SELECT * INTO dbo.Backup FROM dbo.Orders)',
      'SELECT * FROM dbo.Orders ORDER BY id + offset\n(SELECT * INTO dbo.Backup FROM dbo.Orders)',
      'INSERT INTO dbo.T SELECT id, offset FROM dbo.S ORDER BY id, offset\n(SELECT * INTO dbo.Backup FROM dbo.S)',
      'FETCH next\n(SELECT * INTO dbo.Backup FROM dbo.Orders)',
      'FETCH first\n(SELECT * INTO dbo.Backup FROM dbo.Orders)'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.some(s => s.keyword === 'SELECT INTO'), q).toBe(true)
    }
    expect(classifyStatements('SELECT * FROM dbo.Orders ORDER BY id OFFSET (SELECT 1) ROWS FETCH NEXT (SELECT 2) ROWS ONLY', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])
    expect(classifyStatements('SELECT * FROM dbo.Orders ORDER BY id OFFSET (SELECT 1) + 1 ROW', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    // BigQuery CREATE PROCEDURE parenthesized query followed by UNION ALL SELECT do begin does not swallow trailing DDL.
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  (SELECT 1 AS do)\n  UNION ALL\n  SELECT do begin FROM ds.t;\nEND;\nDROP TABLE ds.prod_orders;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // Standalone EXECUTE AS after DDL and DROP EVENT SESSION/NOTIFICATION after ALTER are not swallowed.
    expect(classifyStatements("CREATE TABLE dbo.T (id int)\nEXECUTE AS LOGIN = 'sa'", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TABLE'], ['procedural', 'EXECUTE']])
    expect(classifyStatements("DROP TABLE dbo.Old\nEXECUTE AS USER = 'dbo'", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'DROP TABLE'], ['procedural', 'EXECUTE']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nDROP EVENT SESSION MySession ON SERVER', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'DROP EVENT']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nDROP EVENT NOTIFICATION MyNotif ON SERVER', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'DROP EVENT']])
    expect(classifyStatements('ALTER EVENT SESSION MySession ON SERVER DROP EVENT sqlserver.rpc_completed;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER EVENT']])

    // SQLCMD lines with unclosed quotes or block comments stay strictly single-line and do not hide trailing DDL.
    const bangUnclosed = classifyStatements("SELECT 1\n!!echo '\nDROP DATABASE Prod;", 'sqlserver')
    expect(bangUnclosed.hasNonTransactionalTSql).toBe(true)
    expect(bangUnclosed.statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'SQLCMD'], ['ddl', 'DROP DATABASE']])
    const bangViolations = checkCrossEngineReadOnly("SELECT 1\n!!echo '\nDROP DATABASE Prod;", 'sqlserver')
    expect(bangViolations[0]).toMatchObject({ line: 2, endLine: 2, keyword: 'SQLCMD' })
    expect(bangViolations.some(v => v.keyword === 'DROP' && v.line === 3)).toBe(true)
    const commentBlockSqlcmd = checkCrossEngineReadOnly('SELECT 1\n/* c */ :r /*\n*/\nSELECT 2', 'sqlserver')
    expect(commentBlockSqlcmd).toMatchObject([{ line: 2, column: 9, endLine: 2, keyword: 'SQLCMD' }])
  })

  it('covers Round 19 edge cases: $ money literals + keywords, ALTER Governor/RECONFIGURE, ALTER DB ON + DML, Unicode whitespace GO/SQLCMD, BQ pipe proc, Always Encrypted / DISABLE TRIGGER ON, BQ TEMP TABLE function, EXEC WITH RESULT SETS', () => {
    // T-SQL $ money literals never swallow immediately-following keywords.
    for (const q of [
      'SELECT $1DROP DATABASE Prod',
      'SELECT $1.50DROP DATABASE Prod',
      'SELECT $1.DROP DATABASE Prod',
      'SELECT $.50DROP DATABASE Prod',
      'SELECT $1SHUTDOWN',
      'SELECT $1KILL 55',
      'SELECT $1DBCC CHECKDB',
      'SELECT $1RECONFIGURE',
      "SELECT $1BACKUP DATABASE Foo TO DISK = 'x'",
      'SELECT $1INTO dbo.Copy FROM dbo.T',
      'SELECT $1DELETE FROM dbo.T',
      'SELECT $1TRUNCATE TABLE dbo.T'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
    }
    expect(classifyStatements('SELECT $1DROP DATABASE Prod', 'sqlserver').hasNonTransactionalTSql).toBe(true)
    expect(classifyStatements('SELECT $1INTO dbo.Copy FROM dbo.T', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])
    expect(checkCrossEngineReadOnly('SELECT $1.50, $.25, $1 FROM dbo.T', 'sqlserver')).toEqual([])

    // ALTER statements ending in identifier Governor do not swallow trailing non-transactional RECONFIGURE.
    for (const q of [
      'ALTER TABLE dbo.T DROP COLUMN Governor\nRECONFIGURE',
      'ALTER ROLE db_owner ADD MEMBER Governor\nRECONFIGURE',
      'ALTER SCHEMA dbo TRANSFER Governor\nRECONFIGURE'
    ]) {
      const res = classifyStatements(q, 'sqlserver')
      expect(res.hasNonTransactionalTSql, q).toBe(true)
      expect(res.statements.some(s => s.keyword === 'RECONFIGURE'), q).toBe(true)
    }
    expect(classifyStatements('ALTER RESOURCE GOVERNOR RECONFIGURE;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER RESOURCE']])

    // ALTER DATABASE ... ON does not swallow trailing DELETE/UPDATE statements, while FK ON DELETE CASCADE stays intact.
    expect(classifyStatements('ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nDELETE FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE SCOPED CONFIGURATION'], ['dml', 'DELETE']])
    expect(classifyStatements('ALTER DATABASE Foo SET AUTO_CLOSE ON\nUPDATE dbo.Orders SET x = 1', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE'], ['dml', 'UPDATE']])
    expect(classifyStatements('ALTER TABLE dbo.C ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES dbo.P(id) ON DELETE CASCADE ON UPDATE SET NULL;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE']])

    // Unicode whitespace matches SqlScript.cs for GO, GO <count>, and SQLCMD.
    expect(checkCrossEngineReadOnly('SELECT 1\n\u3000GO 2', 'sqlserver').some(v => v.keyword === 'GO')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1\n\u3000:r evil.sql', 'sqlserver').some(v => v.keyword === 'SQLCMD')).toBe(true)
    expect(classifyStatements('SELECT 1\n\u3000GO\nSELECT 2', 'sqlserver').batchCount).toBe(2)

    // BigQuery CREATE PROCEDURE with GoogleSQL pipe syntax (`FROM ... |> ...`) does not swallow trailing DDL.
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  FROM ds.t |> SELECT do begin;\nEND;\nDROP TABLE ds.outside;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // ALTER TABLE does not swallow Always Encrypted DROP/ALTER COLUMN [ENCRYPTION|MASTER] KEY or standalone ENABLE/DISABLE TRIGGER ... ON.
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nDROP COLUMN ENCRYPTION KEY MyCEK', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'DROP COLUMN']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nDROP COLUMN MASTER KEY MyCMK', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'DROP COLUMN']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nALTER COLUMN ENCRYPTION KEY MyCEK DROP VALUE (COLUMN_MASTER_KEY = MyCMK)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'ALTER COLUMN']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD c int\nDISABLE TRIGGER ALL ON DATABASE', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['ddl', 'DISABLE TRIGGER']])
    expect(classifyStatements('ALTER TABLE dbo.T DISABLE TRIGGER ALL;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE']])

    // BigQuery temp table named `function` does not block transactions; T-SQL EXEC ... WITH RESULT SETS stays 1 procedural statement.
    const bqTempFn = classifyStatements('CREATE TEMP TABLE function AS SELECT 1 AS x;', 'bigquery')
    expect(bqTempFn.blocksBigQueryTransaction).toBe(false)
    expect(bqTempFn.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TEMP TABLE']])
    expect(classifyStatements('DROP TEMP TABLE function;', 'bigquery').blocksBigQueryTransaction).toBe(false)
    expect(classifyStatements('CREATE TEMP TABLE FUNCTION f(x INT64) AS SELECT x;', 'bigquery').blocksBigQueryTransaction).toBe(true)
    expect(classifyStatements('EXEC dbo.MyProc WITH RESULT SETS ((id int));', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'EXEC']])
  })

  it('covers Round 20 edge cases: BQ TEMP TABLE FUNCTION named options/clone/copy/partition/cluster, receive LEFT/RIGHT join hints, un-semicoloned ADD/MOVE/GET, nested BQ CREATE PROCEDURE', () => {
    // BigQuery TEMP TABLE FUNCTION named with non-reserved table clause keywords still blocks transactions, while TEMP TABLE function OPTIONS(...) does not.
    for (const q of [
      'CREATE TEMP TABLE FUNCTION options(x INT64) AS (SELECT x);',
      'CREATE TEMP TABLE FUNCTION clone(x INT64) AS (SELECT x);',
      'CREATE TEMP TABLE FUNCTION copy(x INT64) AS (SELECT x);',
      'CREATE TEMP TABLE FUNCTION partition(x INT64) AS (SELECT x);',
      'CREATE TEMP TABLE FUNCTION cluster(x INT64) AS (SELECT x);',
      'DROP TEMP TABLE FUNCTION options;',
      'DROP TEMP TABLE FUNCTION IF EXISTS clone;'
    ]) {
      expect(classifyStatements(q, 'bigquery').blocksBigQueryTransaction, q).toBe(true)
    }
    expect(classifyStatements("CREATE TEMP TABLE function OPTIONS(description = 'tmp') AS SELECT 1 AS x;", 'bigquery').blocksBigQueryTransaction).toBe(false)

    // T-SQL alias `receive` followed by LEFT/RIGHT {LOOP|HASH|MERGE|REMOTE} JOIN has zero false positives.
    for (const q of [
      'SELECT * FROM dbo.A receive LEFT MERGE JOIN dbo.B b ON b.id = receive.id',
      'SELECT * FROM dbo.A receive LEFT HASH JOIN dbo.B b ON b.id = receive.id',
      'SELECT * FROM dbo.A receive RIGHT LOOP JOIN dbo.B b ON b.id = receive.id',
      'SELECT * FROM dbo.A receive RIGHT REMOTE JOIN dbo.B b ON b.id = receive.id',
      'SELECT * FROM (SELECT 1) receive(id) LEFT HASH JOIN dbo.B b ON b.id = receive.id'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver'), q).toEqual([])
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT']])
    }

    // Un-semicoloned ADD SIGNATURE / ADD COUNTER SIGNATURE / ADD SENSITIVITY CLASSIFICATION / MOVE CONVERSATION / GET CONVERSATION GROUP are classified as admin.
    expect(classifyStatements('SELECT 1\nADD SIGNATURE TO dbo.p BY CERTIFICATE c', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'ADD SIGNATURE']])
    expect(classifyStatements('SELECT 1\nADD COUNTER SIGNATURE TO dbo.p BY CERTIFICATE c', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'ADD COUNTER SIGNATURE']])
    expect(classifyStatements("SELECT 1\nADD SENSITIVITY CLASSIFICATION TO dbo.T.c WITH (LABEL = 'Confidential')", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'ADD SENSITIVITY CLASSIFICATION']])
    expect(classifyStatements('SELECT 1\nMOVE CONVERSATION @h TO @g', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'MOVE CONVERSATION']])
    expect(classifyStatements('SELECT 1\nGET CONVERSATION GROUP @g FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'GET CONVERSATION GROUP']])
    expect(classifyStatements('ALTER TABLE dbo.T ADD signature int;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE']])

    // BigQuery nested CREATE PROCEDURE inside CREATE PROCEDURE keeps outer body intact.
    expect(classifyStatements('CREATE PROCEDURE ds.outer_p()\nBEGIN\n  CREATE PROCEDURE ds.inner_p()\n  BEGIN\n    SELECT 1;\n  END;\n  DROP TABLE ds.inside_outer;\nEND;\nSELECT 2;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['select', 'SELECT']])
  })

  it('covers Round 21 edge cases: $ scientific-notation money literals + keywords, INSERT DEFAULT VALUES (SELECT), ALTER TABLE ON DELETE/UPDATE CASCADE + SET', () => {
    // T-SQL $ money literals with scientific notation do not merge immediately-following keywords.
    for (const q of [
      'SELECT $1e0DROP DATABASE Prod',
      'SELECT $1.e0DROP DATABASE Prod',
      'SELECT $.5e+2DROP DATABASE Prod',
      'SELECT $1e0DELETE FROM dbo.T',
      'SELECT $1.5e2DELETE FROM dbo.T',
      'SELECT $1e0INTO dbo.Copy FROM dbo.T',
      'SELECT $1E0SHUTDOWN',
      'SELECT $1e0KILL 55',
      'SELECT $1e0EXEC dbo.DropAll',
      'SELECT $1e0TRUNCATE TABLE dbo.T'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
    }
    expect(classifyStatements('SELECT $1e0DROP DATABASE Prod', 'sqlserver').hasNonTransactionalTSql).toBe(true)
    expect(classifyStatements('SELECT $1e0INTO dbo.Copy FROM dbo.T', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])
    expect(checkCrossEngineReadOnly('SELECT $1e0, $1.5e+2, $.5e-1 FROM dbo.T', 'sqlserver')).toEqual([])

    // INSERT INTO ... DEFAULT VALUES does not swallow a trailing parenthesized SELECT / SELECT INTO.
    expect(classifyStatements('INSERT INTO dbo.T DEFAULT VALUES\n(SELECT 1)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['select', 'SELECT']])
    expect(classifyStatements('INSERT INTO dbo.T DEFAULT VALUES\n(SELECT * INTO dbo.Backup FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['dml', 'SELECT INTO']])

    // ALTER TABLE ... ON DELETE/UPDATE CASCADE followed by un-semicoloned SET does not emit a phantom DML statement or swallow SET.
    expect(classifyStatements('ALTER TABLE dbo.C ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES dbo.P(id) ON DELETE CASCADE\nSET XACT_ABORT OFF', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['procedural', 'SET']])
    expect(classifyStatements('ALTER TABLE dbo.C ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES dbo.P(id) ON UPDATE CASCADE\nSET NOCOUNT ON', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['procedural', 'SET']])
    expect(classifyStatements('ALTER TABLE dbo.C ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES dbo.P(id) ON UPDATE CASCADE\nSET @x = 1', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['procedural', 'SET']])
    expect(classifyStatements('ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nUPDATE cascade SET x = 1', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE SCOPED CONFIGURATION'], ['dml', 'UPDATE']])
  })

  it('covers Round 22 edge cases: BigQuery bare BEGIN; transaction & inside CREATE PROCEDURE, T-SQL ALTER DATABASE non-SET + trailing SET', () => {
    // BigQuery `BEGIN;` (with optional TRANSACTION omitted) blocks Transaction mode and does not corrupt blockStack / conditionalDepth.
    const bqBareBegin = classifyStatements('BEGIN;\nUPDATE ds.t SET x = 1 WHERE TRUE;', 'bigquery')
    expect(bqBareBegin.blocksBigQueryTransaction).toBe(true)
    expect(bqBareBegin.statements.map(s => [s.category, s.keyword])).toEqual([['transaction', 'BEGIN'], ['dml', 'UPDATE']])

    const bqBeginInIf = classifyStatements('IF TRUE THEN\n  BEGIN\n    BEGIN;\n    UPDATE ds.t SET x = 1 WHERE TRUE;\n  EXCEPTION WHEN ERROR THEN\n    SELECT 1;\n  END;\nEND IF;\nSELECT 2;', 'bigquery')
    expect(bqBeginInIf.blocksBigQueryTransaction).toBe(true)
    expect(bqBeginInIf.statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([
      ['transaction', 'BEGIN', true],
      ['dml', 'UPDATE', true],
      ['select', 'SELECT', true],
      ['select', 'SELECT', false]
    ])

    // BigQuery `BEGIN;` inside CREATE PROCEDURE does not swallow trailing top-level DDL.
    const bqProcBareBegin = classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  BEGIN;\n  UPDATE ds.t SET x = 1 WHERE TRUE;\n  COMMIT;\nEND;\nDROP TABLE ds.prod_orders;', 'bigquery')
    expect(bqProcBareBegin.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE'], ['ddl', 'DROP TABLE']])

    // T-SQL ALTER DATABASE non-SET actions do not swallow trailing un-semicoloned SET statements, while ALTER DATABASE <db> SET remains 1 statement.
    expect(classifyStatements('ALTER DATABASE Foo MODIFY FILE (NAME = Foo_log, SIZE = 100MB)\nSET XACT_ABORT OFF', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE'], ['procedural', 'SET']])
    expect(classifyStatements('ALTER DATABASE Foo ADD FILEGROUP FG1\nSET NOCOUNT ON', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE'], ['procedural', 'SET']])
    expect(classifyStatements('ALTER DATABASE CURRENT SET SINGLE_USER WITH ROLLBACK IMMEDIATE;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER DATABASE']])
  })

  it('covers Round 23 edge cases: SET @cur = CURSOR FOR SELECT, embedded SELECT TOP inside INSERT/CURSOR, alias receive before (SELECT)', () => {
    // T-SQL `SET @cur = CURSOR FOR SELECT ... [FOR UPDATE]` stays a single procedural SET statement.
    for (const q of [
      'SET @cur = CURSOR FOR SELECT id FROM dbo.T FOR UPDATE OF col1;',
      'SET @cur = CURSOR LOCAL FAST_FORWARD FOR SELECT id FROM dbo.T;',
      'SET @cur = CURSOR FOR (SELECT id FROM dbo.T);',
      'SET @cur = CURSOR FOR SELECT TOP 1 (SELECT 1) FROM dbo.S;'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['procedural', 'SET']])
    }

    // Embedded `SELECT TOP ...` inside INSERT ... SELECT and DECLARE CURSOR FOR SELECT does not emit phantom statements.
    for (const q of [
      'INSERT INTO dbo.T (a) SELECT TOP 1 (SELECT 1) FROM dbo.S;',
      'INSERT INTO dbo.T (a) SELECT TOP (1) (SELECT 1) FROM dbo.S;',
      'INSERT INTO dbo.T (a) SELECT TOP 10 PERCENT (SELECT 1) FROM dbo.S;',
      'INSERT INTO dbo.T (a) SELECT TOP 10 WITH TIES (SELECT 1) FROM dbo.S ORDER BY id;',
      'INSERT INTO dbo.T (a) SELECT TOP 1 ISNULL((SELECT 1), 0) FROM dbo.S;',
      'INSERT INTO dbo.T (a) SELECT TOP 1 receive + 1 FROM dbo.S;',
      'INSERT INTO dbo.T (a) SELECT TOP 1 move conversation FROM dbo.S;'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['dml', 'INSERT']])
    }
    expect(classifyStatements('DECLARE cur CURSOR FOR SELECT TOP 1 (SELECT 1) FROM dbo.S;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'DECLARE']])
    expect(classifyStatements('DECLARE cur CURSOR FOR SELECT TOP 1 receive + 1 FROM dbo.S;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'DECLARE']])

    // Non-reserved alias `receive` before an un-semicoloned `(SELECT ...)` has no false positives, while `RECEIVE (SELECT 1) FROM q` is still caught.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T receive\n(SELECT 2)', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT 1 receive\n(SELECT 2)', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM dbo.T receive\n(SELECT 2)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['select', 'SELECT']])
    expect(checkCrossEngineReadOnly('SELECT 1\nRECEIVE (SELECT 1) FROM dbo.MyQueue', 'sqlserver').some(v => v.keyword === 'RECEIVE')).toBe(true)
    expect(classifyStatements('SELECT 1\nRECEIVE (SELECT 1) FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])
  })

  it('covers Round 24 edge cases: bare e/E exponent numeric & $ literals + keywords, TOP 1e SELECT_ASSIGN, un-semicoloned T-SQL labels', () => {
    // T-SQL numeric and $ money literals with bare `e`/`E` exponent do not fuse with immediately-following keywords.
    for (const q of [
      'SELECT 1eDROP DATABASE Prod',
      'SELECT $1eDROP DATABASE Prod',
      'SELECT 1.eDROP DATABASE Prod',
      'SELECT .5eDROP DATABASE Prod',
      'SELECT $+1eDROP DATABASE Prod',
      'SELECT $-1eDROP DATABASE Prod',
      'SELECT 1eINTO dbo.Copy FROM dbo.T',
      'SELECT 1eDELETE FROM dbo.T',
      'SELECT 1eEXEC dbo.DropAll',
      'SELECT 1eSHUTDOWN',
      'SELECT 1eKILL 55',
      'SELECT 1eTRUNCATE TABLE dbo.T',
      'SELECT 1eDBCC CHECKDB',
      'SELECT 1eRECONFIGURE',
      "SELECT 1eBACKUP DATABASE Foo TO DISK = 'x'"
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
    }
    expect(classifyStatements('SELECT 1eDROP DATABASE Prod', 'sqlserver').hasNonTransactionalTSql).toBe(true)
    expect(classifyStatements('SELECT 1eINTO dbo.Copy FROM dbo.T', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'SELECT INTO']])
    expect(checkCrossEngineReadOnly('SELECT TOP 1e @v = 1 FROM dbo.T', 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN')).toBe(true)

    // Un-semicoloned T-SQL statement labels (`foo:`) are rejected in Cross-Engine read-only mode.
    expect(checkCrossEngineReadOnly('SELECT 1\nfoo:\nSELECT 2', 'sqlserver').some(v => v.keyword === ':')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1\nfoo:SELECT 2', 'sqlserver').some(v => v.keyword === ':')).toBe(true)
  })

  it('covers Round 25 edge cases: JSON_OBJECT/JSON_OBJECTAGG colons, receive(id) before (SELECT), IF cond THROW;, FROM next value FOR JSON/XML/BROWSE', () => {
    // SQL Server JSON_OBJECT / JSON_OBJECTAGG key:value colons inside parentheses are allowed read-only.
    expect(checkCrossEngineReadOnly("SELECT JSON_OBJECT('name':'Alice', 'age':30)", 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT JSON_OBJECTAGG(k: v) FROM dbo.T', 'sqlserver')).toEqual([])

    // Derived-table alias `receive(id)` before an un-semicoloned `(SELECT ...)` has zero false positives.
    expect(checkCrossEngineReadOnly('SELECT * FROM (SELECT 1) receive(id)\n(SELECT 2 FROM dbo.U)', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM (SELECT 1) receive(id)\n(SELECT 2 FROM dbo.U)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['select', 'SELECT']])

    // Bare re-throw `IF <cond> THROW;` is classified as conditional THROW without leaking pendingConditional to following statements.
    expect(classifyStatements('IF @x = 1\n  THROW;\nSELECT 2;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['procedural', 'THROW', true], ['select', 'SELECT', false]])
    expect(classifyStatements('BEGIN TRY\n  SELECT 1;\nEND TRY\nBEGIN CATCH\n  IF @x = 1\n    THROW;\n  SELECT 2;\nEND CATCH', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['select', 'SELECT', false], ['procedural', 'THROW', true], ['select', 'SELECT', true]])

    // Table `next` with alias `value` before `FOR JSON/XML/BROWSE` is allowed read-only, while `NEXT VALUE FOR` expressions remain blocked.
    expect(checkCrossEngineReadOnly('SELECT * FROM next value FOR JSON AUTO', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM next value FOR XML AUTO', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM next value FOR BROWSE', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A, next value FOR JSON AUTO', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT NEXT VALUE FOR dbo.Seq', 'sqlserver').some(v => v.keyword === 'NEXT VALUE FOR')).toBe(true)
  })

  it('covers Round 26 edge cases: BQ WHILE IS DISTINCT FROM do DO, ALTER DB SCOPED ON + DELETE/UPDATE cascade, BEGIN/END dialog:/conversation:/catch: labels, INSERT EXEC WITH RESULT SETS/RECOMPILE', () => {
    // BigQuery WHILE ... IS [NOT] DISTINCT FROM do DO does not swallow loop-body permanent DDL.
    expect(classifyStatements('DECLARE x INT64 DEFAULT 1;\nDECLARE do INT64 DEFAULT 2;\nWHILE x IS DISTINCT FROM do DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)
    expect(classifyStatements('DECLARE x INT64 DEFAULT 1;\nDECLARE do INT64 DEFAULT 2;\nWHILE x IS NOT DISTINCT FROM do DO\n  CALL ds.p();\nEND WHILE;', 'bigquery').blocksBigQueryTransaction).toBe(true)

    // ALTER DATABASE SCOPED CONFIGURATION ... = ON does not swallow un-semicoloned DELETE/UPDATE cascade DML.
    for (const [q, expectedDml] of [
      ['ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nDELETE cascade FROM dbo.Orders AS cascade', 'DELETE'],
      ['ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nDELETE cascade WHERE id = 1', 'DELETE'],
      ['ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nUPDATE cascade SET @x = 1', 'UPDATE'],
      ['ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nUPDATE cascade SET rowcount = 1', 'UPDATE']
    ] as const) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['ddl', 'ALTER DATABASE SCOPED CONFIGURATION'], ['dml', expectedDml]])
    }

    // Statement labels dialog:/conversation:/catch: after BEGIN/END do not corrupt block nesting or conditional flags.
    expect(classifyStatements('IF @x = 1\nBEGIN\n  dialog:\n  SELECT 1;\nEND\nSELECT 2;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['other', 'DIALOG', true], ['select', 'SELECT', true], ['select', 'SELECT', false]])
    expect(classifyStatements('IF @x = 1\nBEGIN\n  SELECT 1;\nEND\nconversation:\nSELECT 2;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['select', 'SELECT', true], ['other', 'CONVERSATION', false], ['select', 'SELECT', false]])
    expect(classifyStatements('BEGIN\n  catch:\n  SELECT 1;\nEND\nSELECT 2;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['other', 'CATCH', false], ['select', 'SELECT', false], ['select', 'SELECT', false]])

    // INSERT ... EXEC ... WITH RESULT SETS / WITH RECOMPILE stays a single INSERT statement.
    expect(classifyStatements('INSERT INTO dbo.T (a) EXEC dbo.GetRows WITH RESULT SETS ((a int));', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT']])
    expect(classifyStatements('INSERT INTO dbo.T (a) EXEC dbo.GetRows WITH RECOMPILE;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT']])
    expect(classifyStatements('INSERT INTO dbo.T (a) EXEC dbo.GetRows\nWITH result AS (SELECT 1) SELECT * FROM result;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'INSERT'], ['select', 'SELECT']])
  })

  it('covers Round 27 edge cases: BQ non-reserved label in CREATE PROC, bracketed/quoted implicit proc calls, BQ CREATE TEMP PROCEDURE, CROSS/OUTER APPLY next value FOR JSON', () => {
    // BigQuery non-reserved keyword block labels (`load: BEGIN`, `load: LOOP`) inside CREATE PROCEDURE do not break BEGIN/END nesting.
    expect(classifyStatements('CREATE PROCEDURE ds.p()\nBEGIN\n  load: BEGIN\n    SELECT 1;\n  END;\n  DROP TABLE ds.inside_proc;\nEND;', 'bigquery').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE']])
    expect(classifyStatements('IF TRUE THEN\n  CREATE PROCEDURE ds.p()\n  BEGIN\n    load: BEGIN\n      SELECT 1;\n    END;\n  END;\n  UPDATE ds.t SET x = 1 WHERE TRUE;\nEND IF;', 'bigquery').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['ddl', 'CREATE PROCEDURE', true], ['dml', 'UPDATE', true]])

    // T-SQL bracketed/quoted implicit stored procedure calls are not silently dropped.
    expect(classifyStatements('[dbo].[sp_ModifyData] @id = 1;\nSELECT 1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['other', '[dbo]'], ['select', 'SELECT']])
    expect(classifyStatements('"dbo"."sp_ModifyData" 1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['other', '"dbo"']])

    // BigQuery CREATE TEMP PROCEDURE is temp DDL (blocksBigQueryTransaction: true, hasBigQueryPermanentDdl: false).
    const bqTempProc = classifyStatements('CREATE TEMP PROCEDURE my_tmp_proc()\nBEGIN\n  SELECT 1;\nEND;', 'bigquery')
    expect(bqTempProc.hasBigQueryPermanentDdl).toBe(false)
    expect(bqTempProc.blocksBigQueryTransaction).toBe(true)

    // T-SQL CROSS/OUTER APPLY with table `next` aliased `value` before `FOR JSON/XML/BROWSE` has zero false positives.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A CROSS APPLY next value FOR JSON AUTO', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A OUTER APPLY next value FOR XML AUTO', 'sqlserver')).toEqual([])
  })

  it('covers Round 28 edge cases: T-SQL ODBC escape } boundaries & ORDER BY OFFSET/FETCH, SEND { guid }, implicit #proc/##proc calls', () => {
    // Un-semicoloned DML/admin/procedural statements after ODBC escape `}` are caught by read-only guard and classifier.
    for (const q of [
      'SELECT { fn NOW() }\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT * FROM { oj dbo.A LEFT OUTER JOIN dbo.B ON dbo.A.id = dbo.B.id }\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      "SELECT { d '2025-01-01' }\nSEND ON CONVERSATION @h MESSAGE TYPE [m]",
      "SELECT { d '2025-01-01' }\nMOVE CONVERSATION @h TO @g",
      "SELECT { d '2025-01-01' }\nGET CONVERSATION GROUP @g FROM dbo.MyQueue",
      "SELECT { d '2025-01-01' }\nADD SIGNATURE TO dbo.p BY CERTIFICATE c",
      "SELECT { d '2025-01-01' }\nADD COUNTER SIGNATURE TO dbo.p BY CERTIFICATE c",
      "SELECT { d '2025-01-01' }\nADD SENSITIVITY CLASSIFICATION TO dbo.T.c WITH (LABEL = 'Confidential')",
      "SELECT { d '2025-01-01' }\nTHROW 50000, 'boom', 1"
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
      expect(classifyStatements(q, 'sqlserver').statements.length, q).toBe(2)
    }

    // Parenthesized `(SELECT * INTO ...)` / `((SELECT 1))` after ODBC escape `}` is not swallowed.
    expect(classifyStatements("SELECT { d '2025-01-01' }\n(SELECT * INTO dbo.Backup FROM dbo.Orders)", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['dml', 'SELECT INTO']])
    expect(classifyStatements("IF @d = { d '2025-01-01' }\n(SELECT * INTO dbo.Backup FROM dbo.Orders)", 'sqlserver').statements.map(s => [s.category, s.keyword, s.conditional])).toEqual([['dml', 'SELECT INTO', true]])
    expect(classifyStatements("SET @d = { d '2025-01-01' }\n(SELECT * INTO dbo.Backup FROM dbo.Orders)", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['procedural', 'SET'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('SELECT { fn NOW() } alias ((SELECT 1))', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['select', 'SELECT']])

    // Valid ORDER BY { fn NOW() } OFFSET ... FETCH NEXT ... ROWS ONLY has zero false positives.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T ORDER BY { fn NOW() } OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver')).toEqual([])
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.T ORDER BY { fn NOW() } OFFSET (SELECT 1) ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT * FROM dbo.T ORDER BY { fn NOW() } OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    // SEND ON CONVERSATION with ODBC `{ guid '...' }` handle is caught by both read-only guard and classifier.
    expect(checkCrossEngineReadOnly("SELECT 1\nSEND ON CONVERSATION { guid '00000000-0000-0000-0000-000000000000' } MESSAGE TYPE [m]", 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION')).toBe(true)
    expect(classifyStatements("SELECT 1\nSEND ON CONVERSATION { guid '00000000-0000-0000-0000-000000000000' } MESSAGE TYPE [m]", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['admin', 'SEND']])

    // Implicit temporary stored procedure invocations (`#proc` / `##proc`) are preserved.
    expect(classifyStatements('#my_temp_proc 1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['other', '#my_temp_proc']])
    expect(classifyStatements('##global_temp_proc @a = 1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['other', '##global_temp_proc']])
  })

  it('covers Round 29 edge cases: Unicode currency identifier boundaries, ON/ALL clause terminators, SEQUENCE START/RESTART WITH & FULLTEXT WITH CHANGE_TRACKING', () => {
    // Unicode currency symbols inside unquoted T-SQL identifiers (`a£`, `col£`) do not act as infix operators.
    for (const q of [
      'SELECT 1 AS a£\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT 1 AS a£\nSEND ON CONVERSATION @h MESSAGE TYPE [m]',
      'SELECT 1 AS a£\nADD SIGNATURE TO dbo.p BY CERTIFICATE c',
      'SELECT 1 AS a£\nADD COUNTER SIGNATURE TO dbo.p BY CERTIFICATE c',
      "SELECT 1 AS a£\nADD SENSITIVITY CLASSIFICATION TO dbo.T.c WITH (LABEL = 'Confidential')",
      "SELECT 1 AS a£\nTHROW 50000, 'boom', 1"
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').length, q).toBeGreaterThan(0)
      expect(classifyStatements(q, 'sqlserver').statements.length, q).toBe(2)
    }
    expect(classifyStatements('SELECT 1 AS a£\n(SELECT 2)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['select', 'SELECT']])
    expect(checkCrossEngineReadOnly('SELECT col FROM dbo.T ORDER BY col£ OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver')).toEqual([])
    expect(classifyStatements('SELECT col FROM dbo.T ORDER BY col£ OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT']])

    // ON and ALL clause terminators do not swallow following un-semicoloned statements.
    for (const q of [
      'SET NOCOUNT ON\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SET NOCOUNT ON\nSEND ON CONVERSATION @h MESSAGE TYPE [m]',
      'SET NOCOUNT ON\nADD SIGNATURE TO dbo.p BY CERTIFICATE c',
      'SET NOCOUNT ON\nMOVE CONVERSATION @h TO @g',
      'SET NOCOUNT ON\nGET CONVERSATION GROUP @g FROM dbo.MyQueue',
      "SET NOCOUNT ON\nTHROW 50000, 'boom', 1",
      'SET NOCOUNT ON\n(SELECT 1)',
      'ALTER TABLE dbo.T DISABLE TRIGGER ALL\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'ALTER TABLE dbo.T DISABLE TRIGGER ALL\n(SELECT 1)',
      'ALTER TABLE dbo.T CHECK CONSTRAINT ALL\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'ALTER DATABASE Foo SET AUTO_CLOSE ON\n(SELECT 1)',
      'ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = ON\n(SELECT 1)'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.length, q).toBe(2)
    }

    // SEQUENCE START/RESTART WITH and CREATE FULLTEXT INDEX ... WITH CHANGE_TRACKING stay single DDL statements.
    expect(classifyStatements('CREATE SEQUENCE dbo.Seq START WITH 1 INCREMENT BY 1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE SEQUENCE']])
    expect(classifyStatements('ALTER SEQUENCE dbo.Seq RESTART WITH -1;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER SEQUENCE']])
    expect(classifyStatements('CREATE SEQUENCE dbo.Seq START WITH 1\nSELECT 1;', 'sqlserver').statements.map(s => [s.category, s.keyword, s.line])).toEqual([['ddl', 'CREATE SEQUENCE', 1], ['select', 'SELECT', 2]])
    expect(classifyStatements('CREATE FULLTEXT INDEX ON dbo.T (Body) KEY INDEX pk_T ON MyCatalog WITH CHANGE_TRACKING AUTO;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE FULLTEXT']])
  })

  it('covers Round 30 edge cases: BigQuery CREATE PROCEDURE conditions with REPEAT(...) or scalar CASE expressions', () => {
    // Repro 1A: REPEAT(...) inside CASE WHEN condition does not swallow trailing top-level permanent DDL.
    const r1a = classifyStatements("CREATE TEMP PROCEDURE my_tmp()\nBEGIN\n  CASE\n    WHEN REPEAT('a', 2) = 'aa' THEN\n      CASE WHEN TRUE THEN SELECT 1; END CASE;\n  END CASE;\nEND;\nDROP TABLE ds.prod_orders;", 'bigquery')
    expect(r1a.hasBigQueryPermanentDdl).toBe(true)
    expect(r1a.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TEMP PROCEDURE'], ['ddl', 'DROP TABLE']])

    // Repro 1B: scalar CASE with THEN (1) or THEN <non-reserved starter> inside condition does not swallow trailing DDL.
    const r1b1 = classifyStatements('CREATE TEMP PROCEDURE my_tmp()\nBEGIN\n  CASE\n    WHEN CASE WHEN TRUE THEN (1) ELSE 2 END = 1 THEN\n      CASE WHEN TRUE THEN SELECT 1; END CASE;\n  END CASE;\nEND;\nDROP TABLE ds.prod_orders;', 'bigquery')
    expect(r1b1.hasBigQueryPermanentDdl).toBe(true)
    expect(r1b1.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TEMP PROCEDURE'], ['ddl', 'DROP TABLE']])

    const r1b2 = classifyStatements('CREATE TEMP PROCEDURE my_tmp()\nBEGIN\n  DECLARE load INT64 DEFAULT 1;\n  CASE\n    WHEN CASE WHEN TRUE THEN load ELSE 0 END = 1 THEN\n      CASE WHEN TRUE THEN SELECT 1; END CASE;\n  END CASE;\nEND;\nDROP TABLE ds.prod_orders;', 'bigquery')
    expect(r1b2.hasBigQueryPermanentDdl).toBe(true)
    expect(r1b2.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TEMP PROCEDURE'], ['ddl', 'DROP TABLE']])

    // Repro 1C: IF REPEAT(...) THEN BEGIN ... END; END IF; does not exit CREATE PROCEDURE early.
    const r1c = classifyStatements("CREATE PROCEDURE ds.p()\nBEGIN\n  IF REPEAT('a', 2) = 'aa' THEN\n    BEGIN\n      SELECT 1;\n    END;\n  END IF;\n  INSERT INTO ds.t VALUES (1);\nEND;", 'bigquery')
    expect(r1c.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE']])

    // Boolean variable `do` inside IF/CASE conditions inside CREATE PROCEDURE stays intact.
    const rDo = classifyStatements('CREATE TEMP PROCEDURE my_tmp()\nBEGIN\n  DECLARE do BOOL DEFAULT TRUE;\n  IF do THEN\n    BEGIN\n      SELECT 1;\n    END;\n  END IF;\nEND;\nDROP TABLE ds.prod_orders;', 'bigquery')
    expect(rDo.hasBigQueryPermanentDdl).toBe(true)
    expect(rDo.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE TEMP PROCEDURE'], ['ddl', 'DROP TABLE']])
  })

  it('covers Round 31 edge cases: BQ WHILE INTERVAL do DAY, T-SQL INSERT TOP ((SELECT ...)), ALTER TABLE + SET session options', () => {
    // BigQuery WHILE condition with `INTERVAL do <date_part>` does not swallow loop DDL or break CREATE PROCEDURE nesting.
    const bqInterval = classifyStatements("DECLARE do INT64 DEFAULT 1;\nWHILE CURRENT_DATE() + INTERVAL do DAY > DATE '2025-01-01' DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;", 'bigquery')
    expect(bqInterval.hasBigQueryPermanentDdl).toBe(true)
    expect(bqInterval.blocksBigQueryTransaction).toBe(true)

    const bqProcInterval = classifyStatements("CREATE PROCEDURE ds.p()\nBEGIN\n  DECLARE do INT64 DEFAULT 1;\n  WHILE CURRENT_DATE() + INTERVAL do DAY > DATE '2025-01-01' AND (SELECT 1) = 1 DO\n    BEGIN\n      SELECT 1;\n    END;\n  END WHILE;\n  INSERT INTO ds.t VALUES (1);\nEND;", 'bigquery')
    expect(bqProcInterval.statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE PROCEDURE']])

    // Boolean variable named `interval` still terminates WHILE ... DO cleanly.
    expect(classifyStatements('DECLARE interval BOOL DEFAULT TRUE;\nWHILE interval DO\n  DROP TABLE ds.prod_orders;\nEND WHILE;', 'bigquery').hasBigQueryPermanentDdl).toBe(true)

    // T-SQL INSERT TOP ((SELECT ...)) / TOP (SELECT ...) does not split out the INSERT source query.
    for (const q of [
      'INSERT TOP ((SELECT 1)) INTO dbo.T (a)\nSELECT a FROM dbo.S;',
      'INSERT TOP (SELECT 1) INTO dbo.T (a) SELECT a FROM dbo.S;',
      'INSERT TOP ((SELECT 1)) INTO dbo.T (a) (SELECT a FROM dbo.S);',
      'INSERT TOP ((SELECT 1)) PERCENT INTO dbo.T (a) SELECT a FROM dbo.S;',
      'INSERT TOP (SELECT 1) INTO dbo.T (a) EXEC dbo.GetRows;'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['dml', 'INSERT']])
    }

    // Additional T-SQL session SET options after ALTER TABLE are not swallowed.
    for (const setStmt of [
      'SET ANSI_NULL_DFLT_ON ON',
      'SET ANSI_NULL_DFLT_OFF ON',
      'SET CURSOR_CLOSE_ON_COMMIT ON',
      'SET REMOTE_PROC_TRANSACTIONS ON',
      'SET FIPS_FLAGGER OFF',
      'SET OFFSETS SELECT ON',
      'SET DISABLE_DEF_CNST_CHK ON'
    ]) {
      expect(classifyStatements(`ALTER TABLE dbo.T ADD c int\n${setStmt}`, 'sqlserver').statements.map(s => [s.category, s.keyword]), setStmt).toEqual([['ddl', 'ALTER TABLE'], ['procedural', 'SET']])
    }
  })

  it('covers Round 32 edge cases: un-semicoloned LINENO, SEND / BEGIN CONVERSATION TIMER subqueries, SEND NULL/~ / niladic handles', () => {
    // Un-semicoloned LINENO is rejected by read-only guard and classified as procedural.
    expect(checkCrossEngineReadOnly('SELECT 1 LINENO 42', 'sqlserver').some(v => v.keyword === 'LINENO')).toBe(true)
    expect(classifyStatements('SELECT 1 LINENO 42', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['select', 'SELECT'], ['procedural', 'LINENO']])

    // Parenthesized subqueries inside SEND ON CONVERSATION and BEGIN CONVERSATION TIMER stay single statements.
    expect(classifyStatements('SEND ON CONVERSATION (SELECT TOP 1 handle FROM dbo.Handles) MESSAGE TYPE [m];', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'SEND']])
    expect(classifyStatements("SEND ON CONVERSATION @h MESSAGE TYPE [m] ((SELECT 'body'));", 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'SEND']])
    expect(classifyStatements('SEND ON CONVERSATION @h MESSAGE TYPE [m]\n(SELECT 1);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'SEND'], ['select', 'SELECT']])
    expect(classifyStatements('BEGIN CONVERSATION TIMER ((SELECT @h)) TIMEOUT = 10;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'BEGIN CONVERSATION']])

    // SEND ON CONVERSATION with NULL, unary ~, or niladic function handles is caught.
    for (const q of [
      'SELECT 1 AS a SEND ON CONVERSATION NULL MESSAGE TYPE [m]',
      'SELECT 1 AS a SEND ON CONVERSATION ~@h MESSAGE TYPE [m]',
      'SELECT 1 AS a SEND ON CONVERSATION CURRENT_USER MESSAGE TYPE [m]'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'SEND ON CONVERSATION'), q).toBe(true)
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['admin', 'SEND']])
    }
  })

  it('covers Round 33 edge cases: UDT @v.Prop = assignment, UPDATE STATISTICS WITH ALL/COLUMNS/INDEX/opt=val, CREATE/ALTER VIEW trailing statements, JOIN ON IS DISTINCT FROM NEXT VALUE FOR', () => {
    // T-SQL UDT property/field assignment (`SELECT @v.Prop = 1`) is rejected as SELECT_ASSIGN while read-only access stays allowed.
    for (const q of [
      'SELECT @v.Prop = 1 FROM dbo.T',
      'SELECT @v.Prop += 1 FROM dbo.T',
      'SELECT @v.[Prop] = 1 FROM dbo.T'
    ]) {
      expect(checkCrossEngineReadOnly(q, 'sqlserver').some(v => v.keyword === 'SELECT_ASSIGN'), q).toBe(true)
    }
    expect(checkCrossEngineReadOnly('SELECT @v.Prop, a = @v.Prop FROM dbo.T', 'sqlserver')).toEqual([])

    // UPDATE STATISTICS ... WITH ALL|COLUMNS|INDEX|<opt> = <val> stays 1 UPDATE, and WITH FULLSCAN, ALL does not swallow trailing statements.
    for (const q of [
      'UPDATE STATISTICS dbo.T WITH ALL;',
      'UPDATE STATISTICS dbo.T WITH COLUMNS;',
      'UPDATE STATISTICS dbo.T WITH INDEX;',
      'UPDATE STATISTICS dbo.T WITH MAXDOP = 4;',
      'UPDATE STATISTICS dbo.T WITH AUTO_DROP = ON;'
    ]) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['dml', 'UPDATE']])
    }
    expect(classifyStatements('UPDATE STATISTICS dbo.T WITH FULLSCAN, ALL\nRECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['dml', 'RECEIVE']])
    expect(classifyStatements('UPDATE STATISTICS dbo.T WITH FULLSCAN, ALL\n(SELECT * INTO dbo.Backup FROM dbo.T)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'UPDATE'], ['dml', 'SELECT INTO']])

    // CREATE/ALTER VIEW keeps CTE/UNION/WITH CHECK OPTION intact and does not swallow trailing un-semicoloned statements.
    expect(classifyStatements('CREATE VIEW dbo.v AS WITH cte AS (SELECT 1 AS a) SELECT a FROM cte WITH CHECK OPTION;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE VIEW']])
    expect(classifyStatements('ALTER VIEW dbo.v AS SELECT 1 AS a\nSELECT 2', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER VIEW'], ['select', 'SELECT']])
    expect(classifyStatements('CREATE VIEW dbo.v AS SELECT 1 AS a\nSELECT * INTO dbo.Backup FROM dbo.Orders', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE VIEW'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('CREATE VIEW dbo.v AS SELECT 1 AS a\n(SELECT * INTO dbo.Backup FROM dbo.Orders)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE VIEW'], ['dml', 'SELECT INTO']])
    expect(classifyStatements('CREATE VIEW dbo.v AS SELECT 1 AS a\nWITH cte AS (SELECT 1 AS a) SELECT * INTO dbo.Backup FROM cte', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'CREATE VIEW'], ['dml', 'SELECT INTO']])

    // NEXT VALUE FOR after IS [NOT] DISTINCT FROM inside JOIN ... ON is rejected.
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A a JOIN dbo.B b ON a.id IS DISTINCT FROM NEXT VALUE FOR dbo.Seq', 'sqlserver').some(v => v.keyword === 'NEXT VALUE FOR')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT * FROM dbo.A a JOIN dbo.B b ON a.id IS NOT DISTINCT FROM NEXT VALUE FOR dbo.Seq', 'sqlserver').some(v => v.keyword === 'NEXT VALUE FOR')).toBe(true)
  })

  it('covers Round 34 edge cases: REBUILD PARTITION = ALL, ALTER SERVER DIAGNOSTICS LOG ON, WITH <option> followed by (SELECT 1), DELETE WHERE x = ALL (SELECT 1)', () => {
    // REBUILD PARTITION = ALL and ALTER SERVER CONFIGURATION SET DIAGNOSTICS LOG ON do not swallow trailing statements.
    expect(classifyStatements('ALTER INDEX ix ON dbo.T REBUILD PARTITION = ALL\nRECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER INDEX'], ['dml', 'RECEIVE']])
    expect(classifyStatements('ALTER TABLE dbo.T REBUILD PARTITION = ALL\n(SELECT 1)', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER TABLE'], ['select', 'SELECT']])
    expect(classifyStatements('ALTER SERVER CONFIGURATION SET DIAGNOSTICS LOG ON\nRECEIVE TOP(1) * FROM dbo.MyQueue', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['ddl', 'ALTER SERVER'], ['dml', 'RECEIVE']])
    // DML quantified `= ALL (SELECT 1)` remains a single DML statement.
    expect(classifyStatements('DELETE FROM dbo.T WHERE x = ALL (SELECT 1);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['dml', 'DELETE']])

    // WITH <option> statements followed by un-semicoloned `(SELECT 1)` do not split at WITH or swallow `(SELECT 1)`.
    for (const [q, expected] of [
      ['RECONFIGURE WITH OVERRIDE\n(SELECT 1)', [['admin', 'RECONFIGURE'], ['select', 'SELECT']]],
      ['DBCC CHECKDB (Foo) WITH NO_INFOMSGS\n(SELECT 1)', [['admin', 'DBCC'], ['select', 'SELECT']]],
      ["BACKUP DATABASE Foo TO DISK = 'x.bak' WITH COMPRESSION\n(SELECT 1)", [['admin', 'BACKUP'], ['select', 'SELECT']]],
      ['UPDATE STATISTICS dbo.T WITH FULLSCAN\n(SELECT 1)', [['dml', 'UPDATE'], ['select', 'SELECT']]],
      ['UPDATE STATISTICS dbo.T WITH ALL\n(SELECT 1)', [['dml', 'UPDATE'], ['select', 'SELECT']]],
      ['CREATE STATISTICS st ON dbo.T(a) WITH FULLSCAN\n(SELECT 1)', [['ddl', 'CREATE STATISTICS'], ['select', 'SELECT']]],
      ['EXEC dbo.GetRows WITH RECOMPILE\n(SELECT 1)', [['procedural', 'EXEC'], ['select', 'SELECT']]],
      ['ALTER TABLE dbo.T ADD c int NULL DEFAULT 0 WITH VALUES\n(SELECT 1)', [['ddl', 'ALTER TABLE'], ['select', 'SELECT']]]
    ] as const) {
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual(expected)
    }
    // Real CTE with column list after a statement still breaks at WITH.
    expect(classifyStatements('RECONFIGURE\nWITH result (id) AS (SELECT 1) SELECT * FROM result;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'RECONFIGURE'], ['select', 'SELECT']])
  })

  it('covers Round 35 edge cases: END/MOVE CONVERSATION subqueries, derived receive(id) followed by un-semicoloned RECEIVE', () => {
    // END CONVERSATION and MOVE CONVERSATION with parenthesized subquery handles/groups stay single statements.
    expect(classifyStatements('END CONVERSATION ((SELECT @h)) WITH CLEANUP;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'END CONVERSATION']])
    expect(classifyStatements('END CONVERSATION (SELECT TOP 1 h FROM dbo.Handles) WITH CLEANUP;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'END CONVERSATION']])
    expect(classifyStatements('MOVE CONVERSATION (SELECT TOP 1 h FROM dbo.Handles) TO @g;', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'MOVE CONVERSATION']])
    expect(classifyStatements('MOVE CONVERSATION @h TO (SELECT TOP 1 g FROM dbo.Groups);', 'sqlserver').statements.map(s => [s.category, s.keyword])).toEqual([['admin', 'MOVE CONVERSATION']])

    // Valid derived-table alias `receive(id), dbo.T` before an un-semicoloned `RECEIVE` flags only line 2's RECEIVE.
    for (const q of [
      'SELECT * FROM (SELECT 1) receive(id), dbo.T\nRECEIVE TOP(1) * FROM dbo.MyQueue',
      'SELECT * FROM (SELECT 1) receive(id), dbo.T\nRECEIVE (conversation_handle), message_body FROM dbo.MyQueue'
    ]) {
      const violations = checkCrossEngineReadOnly(q, 'sqlserver')
      expect(violations, q).toHaveLength(1)
      expect(violations[0], q).toMatchObject({ line: 2, column: 1, keyword: 'RECEIVE' })
      expect(classifyStatements(q, 'sqlserver').statements.map(s => [s.category, s.keyword]), q).toEqual([['select', 'SELECT'], ['dml', 'RECEIVE']])
    }
  })
})
