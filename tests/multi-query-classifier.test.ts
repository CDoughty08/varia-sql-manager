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

    expect(checkCrossEngineReadOnly('SELECT 1 REPEAT SELECT 2', 'bigquery').some(v => v.keyword === 'REPEAT')).toBe(true)
    expect(checkCrossEngineReadOnly('SELECT 1 END REPEAT', 'bigquery').some(v => v.keyword === 'END REPEAT')).toBe(true)

    for (const dialect of ['sqlserver', 'bigquery'] as const) {
      expect(hasExecutableSql('(', dialect)).toBe(true)
      const loneOpen = checkCrossEngineReadOnly('(', dialect)
      expect(loneOpen).toHaveLength(1)
      expect(loneOpen[0]).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 2, keyword: '(' })
      expect(checkCrossEngineReadOnly('((', dialect).length).toBeGreaterThan(0)
    }
  })
})
