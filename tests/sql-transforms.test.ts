import { describe, expect, it } from 'vitest'
import { lexSql } from '../src/shared/sql/lexer'
import { applyOffsetEdits, googleSqlTransformTokens, googleSqlTransforms, mapOffset, moveCommaEdits, sqlTransformOp, statementAt, toggleBracketEdits, transformText, sqlTransformMessages, type OffsetRange, type SqlTransformModel } from '../src/renderer/src/editor/sql-transforms'
import { textOpLimits } from '../src/renderer/src/editor/text-ops'

const toggle = (text: string, ranges?: readonly OffsetRange[]) => applyOffsetEdits(text, toggleBracketEdits(text, ranges).edits)
/** The whole text as one range, or the part between `«` and `»`. */
function commas(marked: string, position: 'front' | 'end') {
  const start = marked.indexOf('«'), text = marked.replace('«', '').replace('»', '')
  const ranges = start < 0 ? [{ start: 0, end: text.length }] : [{ start, end: marked.indexOf('»') - 1 }]
  return applyOffsetEdits(text, moveCommaEdits(text, ranges, position))
}

describe('lexSql', () => {
  it('covers the text end to end, whatever it holds', () => {
    for (const text of ["SELECT N'it''s', [a]]b], \"q\"\"x\", @v, @@ROWCOUNT, #t, ##g, $action, 1.5e3, 0xFF -- c\r\n/* a /* nested */ b */ x::y", "'open", '/* open', '[open', ':setvar x 1\nGO', '']) {
      const tokens = lexSql(text)
      let at = 0
      for (const token of tokens) { expect(token.start).toBe(at); expect(token.end).toBeGreaterThan(token.start); at = token.end }
      expect(at).toBe(text.length)
    }
  })
  it('reads nested comments, doubled delimiters and N strings as one token', () => {
    const kinds = (text: string) => lexSql(text).map(token => `${token.kind}:${text.slice(token.start, token.end)}`)
    expect(kinds("N'a''b'")).toEqual(["string:N'a''b'"])
    expect(kinds('[a]]b]')).toEqual(['bracketed:[a]]b]'])
    expect(kinds('/* a /* b */ c */x')).toEqual(['blockComment:/* a /* b */ c */', 'word:x'])
    expect(kinds('@@ROWCOUNT')).toEqual(['variable:@@ROWCOUNT'])
    expect(kinds('Name')).toEqual(['word:Name'])
    expect(kinds('a::b')).toEqual(['word:a', 'scope:::', 'word:b'])
    expect(kinds('$(Db)')).toEqual(['special:$(Db)'])
  })
})

describe('Toggle Brackets', () => {
  it('brackets names, never keywords', () => {
    expect(toggle('SELECT a, b.c FROM dbo.t AS x WHERE x.id = 1 ORDER BY a DESC'))
      .toBe('SELECT [a], [b].[c] FROM [dbo].[t] AS [x] WHERE [x].[id] = 1 ORDER BY [a] DESC')
    expect(toggle('select Name from Sales.Customer c join Sales.[Order] o on o.CustomerId = c.Id'))
      .toBe('select [Name] from [Sales].[Customer] [c] join [Sales].[Order] [o] on [o].[CustomerId] = [c].[Id]')
  })
  it('never touches strings, comments, variables, temporary tables or quoted names', () => {
    const text = "SELECT 'a b', N'x', @v, @@ROWCOUNT, #t.c, \"q\" -- name here\n/* t.col */ FROM t"
    expect(toggle(text)).toBe("SELECT 'a b', N'x', @v, @@ROWCOUNT, #t.[c], \"q\" -- name here\n/* t.col */ FROM [t]")
  })
  it('takes brackets off when every name has them, except where they are needed', () => {
    expect(toggle('SELECT [a], [b].[c] FROM [dbo].[t]')).toBe('SELECT a, b.c FROM dbo.t')
    expect(toggle('SELECT [order], [user], [a b], [1x], [x-y], [ok], [GO], [a]]b] FROM [t]')).toBe('SELECT [order], [user], [a b], [1x], [x-y], ok, [GO], [a]]b] FROM t')
    expect(toggle('SELECT [Straße], [_x], [a$1#] FROM [t]')).toBe('SELECT Straße, _x, a$1# FROM t')
  })
  it('round-trips: bracket, then unbracket', () => {
    const text = 'SELECT a, b.c, COUNT(*) AS n FROM dbo.t WITH (NOLOCK) GROUP BY a, b.c'
    const once = toggle(text)
    expect(once).toBe('SELECT [a], [b].[c], COUNT(*) AS [n] FROM [dbo].[t] WITH (NOLOCK) GROUP BY [a], [b].[c]')
    expect(toggle(once)).toBe(text)
  })
  it('adds when any name lacks brackets, even if others have them', () => {
    expect(toggle('SELECT [a], b FROM [t]')).toBe('SELECT [a], [b] FROM [t]')
  })
  it('keeps a space where a name would run into its neighbour', () => {
    expect(toggle('SELECT 1 AS[x]')).toBe('SELECT 1 AS x')
    expect(toggle("SELECT [N]'a'")).toBe("SELECT N 'a'")
  })
  it('leaves built-in function names alone, but brackets a table a column list follows', () => {
    expect(toggle('SELECT ISNULL(a, 0), LEN(b), dbo.fn(c) FROM t')).toBe('SELECT ISNULL([a], 0), LEN([b]), [dbo].fn([c]) FROM [t]')
    expect(toggle('INSERT INTO dbo.t (a, b) VALUES (1, 2)')).toBe('INSERT INTO [dbo].[t] ([a], [b]) VALUES (1, 2)')
    expect(toggle('INSERT INTO t(a) SELECT x FROM STRING_SPLIT(@s, \',\') s')).toBe('INSERT INTO [t]([a]) SELECT [x] FROM STRING_SPLIT(@s, \',\') [s]')
    expect(toggle('CREATE TABLE t (id int NOT NULL, d date, FOREIGN KEY (id) REFERENCES p(id))'))
      .toBe('CREATE TABLE [t] ([id] [int] NOT NULL, [d] [date], FOREIGN KEY ([id]) REFERENCES [p]([id]))')
    expect(toggle('WITH cte (a) AS (SELECT 1) SELECT a FROM cte')).toBe('WITH [cte] ([a]) AS (SELECT 1) SELECT [a] FROM [cte]')
    expect(toggle('WITH cte AS (SELECT 1 AS a) SELECT a FROM cte')).toBe('WITH [cte] AS (SELECT 1 AS [a]) SELECT [a] FROM [cte]')
  })
  it('leaves date parts and type names where a type is expected', () => {
    expect(toggle('SELECT DATEADD(day, 1, d), DATEDIFF(mm, a, b) FROM t')).toBe('SELECT DATEADD(day, 1, [d]), DATEDIFF(mm, [a], [b]) FROM [t]')
    expect(toggle('DECLARE @x int, @y AS varchar(10) = CAST(a AS date)')).toBe('DECLARE @x int, @y AS varchar(10) = CAST([a] AS date)')
    expect(toggle('SELECT CONVERT(int, a), TRY_CAST(b AS bigint), c AS date FROM t')).toBe('SELECT CONVERT(int, [a]), TRY_CAST([b] AS bigint), [c] AS [date] FROM [t]')
    expect(toggle('SELECT CAST(a AS nvarchar(max)) FROM t')).toBe('SELECT CAST([a] AS nvarchar(max)) FROM [t]')
  })
  it('leaves option lists, hints and statement options alone', () => {
    expect(toggle('SET NOCOUNT ON;\nSET TRANSACTION ISOLATION LEVEL READ COMMITTED\nSELECT a FROM t')).toBe('SET NOCOUNT ON;\nSET TRANSACTION ISOLATION LEVEL READ COMMITTED\nSELECT [a] FROM [t]')
    expect(toggle('SET LANGUAGE us_english')).toBe('SET LANGUAGE us_english')
    expect(toggle('UPDATE t SET a = 1, b = c WHERE id = @id')).toBe('UPDATE [t] SET [a] = 1, [b] = [c] WHERE [id] = @id')
    expect(toggle('SET @a = b')).toBe('SET @a = [b]')
    expect(toggle('ALTER DATABASE db SET RECOVERY SIMPLE')).toBe('ALTER DATABASE [db] SET RECOVERY SIMPLE')
    expect(toggle('SELECT a FROM t OPTION (RECOMPILE, MAXDOP 1)')).toBe('SELECT [a] FROM [t] OPTION (RECOMPILE, MAXDOP 1)')
    expect(toggle('SELECT a FROM t FOR XML PATH(\'r\'), ROOT(\'x\'), TYPE')).toBe('SELECT [a] FROM [t] FOR XML PATH(\'r\'), ROOT(\'x\'), TYPE')
    expect(toggle('SELECT a FROM t FOR JSON AUTO, INCLUDE_NULL_VALUES')).toBe('SELECT [a] FROM [t] FOR JSON AUTO, INCLUDE_NULL_VALUES')
    expect(toggle('CREATE PROCEDURE p @a int OUTPUT WITH RECOMPILE, EXECUTE AS OWNER AS SELECT a FROM t'))
      .toBe('CREATE PROCEDURE [p] @a int OUTPUT WITH RECOMPILE, EXECUTE AS OWNER AS SELECT [a] FROM [t]')
    expect(toggle('RAISERROR(\'x\', 16, 1) WITH NOWAIT')).toBe('RAISERROR(\'x\', 16, 1) WITH NOWAIT')
    expect(toggle('SELECT TOP 5 WITH TIES a FROM t ORDER BY a')).toBe('SELECT TOP 5 WITH TIES [a] FROM [t] ORDER BY [a]')
    expect(toggle('DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT a FROM t\nFETCH NEXT FROM c INTO @a'))
      .toBe('DECLARE [c] CURSOR LOCAL FAST_FORWARD FOR SELECT [a] FROM [t]\nFETCH NEXT FROM [c] INTO @a')
  })
  it('leaves keywords that are not reserved, labels and static members', () => {
    expect(toggle('BEGIN TRY SELECT 1 END TRY BEGIN CATCH THROW; END CATCH')).toBe('BEGIN TRY SELECT 1 END TRY BEGIN CATCH THROW; END CATCH')
    expect(toggle('SELECT a FROM t CROSS APPLY f(a) ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY')).toBe('SELECT [a] FROM [t] CROSS APPLY f([a]) ORDER BY [a] OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY')
    expect(toggle('retry: GOTO retry')).toBe('retry: GOTO retry')
    expect(toggle('SELECT geography::Point(1, 2, 4326)')).toBe('SELECT geography::Point(1, 2, 4326)')
    expect(toggle('SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t'))
      .toBe('SELECT ROW_NUMBER() OVER (PARTITION BY [a] ORDER BY [b] ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM [t]')
    expect(toggle('SELECT NEXT VALUE FOR s')).toBe('SELECT NEXT VALUE FOR [s]')
    expect(toggle('CREATE SEQUENCE s; CREATE OR ALTER VIEW v AS SELECT a COLLATE Latin1_General_CI_AS FROM t'))
      .toBe('CREATE SEQUENCE [s]; CREATE OR ALTER VIEW [v] AS SELECT [a] COLLATE Latin1_General_CI_AS FROM [t]')
    expect(toggle('MERGE t USING s ON t.id = s.id WHEN NOT MATCHED BY TARGET THEN INSERT (id) VALUES (s.id) OUTPUT $action, inserted.id;'))
      .toBe('MERGE [t] USING [s] ON [t].[id] = [s].[id] WHEN NOT MATCHED BY TARGET THEN INSERT ([id]) VALUES ([s].[id]) OUTPUT $action, inserted.[id];')
    expect(toggle('SELECT a AT TIME ZONE \'UTC\' FROM t')).toBe('SELECT [a] AT TIME ZONE \'UTC\' FROM [t]')
    expect(toggle('SELECT a FROM t\nGO\n:setvar x y\nSELECT $(x)')).toBe('SELECT [a] FROM [t]\nGO\n:setvar x y\nSELECT $(x)')
  })
  it('leaves clause words that a bracket would break: grouping sets, WAITFOR, foreign key actions, temporal and computed columns, join hints', () => {
    expect(toggle('SELECT a FROM t GROUP BY GROUPING SETS ((a), ())')).toBe('SELECT [a] FROM [t] GROUP BY GROUPING SETS (([a]), ())')
    expect(toggle("WAITFOR DELAY '00:00:01'; WAITFOR TIME '22:00'")).toBe("WAITFOR DELAY '00:00:01'; WAITFOR TIME '22:00'")
    expect(toggle('ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id) ON DELETE NO ACTION ON UPDATE SET NULL, x int'))
      .toBe('ALTER TABLE [c] ADD CONSTRAINT [fk] FOREIGN KEY ([pid]) REFERENCES [p] ([id]) ON DELETE NO ACTION ON UPDATE SET NULL, [x] [int]')
    expect(toggle('SELECT a FROM t FOR SYSTEM_TIME CONTAINED IN (@a, @b)')).toBe('SELECT [a] FROM [t] FOR SYSTEM_TIME CONTAINED IN (@a, @b)')
    expect(toggle('CREATE TABLE t (a datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL, b AS (a) PERSISTED, PERIOD FOR SYSTEM_TIME (a, b)) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]'))
      .toBe('CREATE TABLE [t] ([a] [datetime2] GENERATED ALWAYS AS ROW START HIDDEN NOT NULL, [b] AS ([a]) PERSISTED, PERIOD FOR SYSTEM_TIME ([a], [b])) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]')
    expect(toggle('SELECT a FROM t INNER LOOP JOIN u ON t.a = u.a LEFT OUTER HASH JOIN v ON 1 = 1')).toBe('SELECT [a] FROM [t] INNER LOOP JOIN [u] ON [t].[a] = [u].[a] LEFT OUTER HASH JOIN [v] ON 1 = 1')
    // An alias just before a join is still a name.
    expect(toggle('SELECT 1 FROM t loop JOIN u ON 1 = 1')).toBe('SELECT 1 FROM [t] [loop] JOIN [u] ON 1 = 1')
    expect(toggle('ENABLE TRIGGER tr ON t; DISABLE TRIGGER ALL ON DATABASE')).toBe('ENABLE TRIGGER [tr] ON [t]; DISABLE TRIGGER ALL ON DATABASE')
  })
  it('leaves the NULL ON NULL, ABSENT ON NULL and RETURNING clauses of JSON functions alone, but brackets names spelled the same', () => {
    // `[ABSENT] ON NULL` and `[RETURNING] json` are syntax errors (102) on SQL Server 2025.
    expect(toggle('SELECT JSON_ARRAY(1, NULL ABSENT ON NULL)')).toBe('SELECT JSON_ARRAY(1, NULL ABSENT ON NULL)')
    expect(toggle("SELECT JSON_OBJECT('a':c ABSENT ON NULL RETURNING json) FROM t")).toBe("SELECT JSON_OBJECT('a':[c] ABSENT ON NULL RETURNING json) FROM [t]")
    expect(toggle('SELECT JSON_ARRAYAGG(v ORDER BY v NULL ON NULL RETURNING json), JSON_OBJECTAGG(k:v ABSENT ON NULL) FROM t'))
      .toBe('SELECT JSON_ARRAYAGG([v] ORDER BY [v] NULL ON NULL RETURNING json), JSON_OBJECTAGG([k]:[v] ABSENT ON NULL) FROM [t]')
    expect(toggle("SELECT JSON_OBJECT('a':JSON_ARRAY(c ABSENT ON NULL)) FROM t")).toBe("SELECT JSON_OBJECT('a':JSON_ARRAY([c] ABSENT ON NULL)) FROM [t]")
    expect(toggle("SELECT JSON_VALUE(doc, '$.a' RETURNING int) FROM t")).toBe("SELECT JSON_VALUE([doc], '$.a' RETURNING int) FROM [t]")
    // The same words as names, which SQL Server reads as columns wherever an argument or an ORDER BY item goes.
    expect(toggle('SELECT JSON_ARRAY(absent ABSENT ON NULL), absent, returning FROM t')).toBe('SELECT JSON_ARRAY([absent] ABSENT ON NULL), [absent], [returning] FROM [t]')
    expect(toggle("SELECT JSON_ARRAY(returning RETURNING json), JSON_OBJECT('a':returning), JSON_ARRAYAGG(absent ORDER BY returning ABSENT ON NULL) FROM t"))
      .toBe("SELECT JSON_ARRAY([returning] RETURNING json), JSON_OBJECT('a':[returning]), JSON_ARRAYAGG([absent] ORDER BY [returning] ABSENT ON NULL) FROM [t]")
    expect(toggle('SELECT returning date FROM t')).toBe('SELECT [returning] [date] FROM [t]')
    // A JSON key before a colon is a name, not a label.
    expect(toggle('SELECT JSON_OBJECT(k:v), JSON_OBJECTAGG(t.k:v) FROM t')).toBe('SELECT JSON_OBJECT([k]:[v]), JSON_OBJECTAGG([t].[k]:[v]) FROM [t]')
    expect(toggle('SELECT JSON_OBJECT([k]:[v], [returning]:[absent] RETURNING json) FROM [t]')).toBe('SELECT JSON_OBJECT(k:v, returning:absent RETURNING json) FROM t')
    expect(toggle('SELECT [absent], [returning] FROM [t]')).toBe('SELECT absent, returning FROM t')
  })
  it('brackets the names after an option and in an index\'s or a later CTE\'s column list', () => {
    expect(toggle('ALTER TABLE c WITH CHECK ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p (b)'))
      .toBe('ALTER TABLE [c] WITH CHECK ADD CONSTRAINT [fk] FOREIGN KEY ([a]) REFERENCES [p] ([b])')
    expect(toggle('ALTER TABLE c WITH CHECK CHECK CONSTRAINT fk')).toBe('ALTER TABLE [c] WITH CHECK CHECK CONSTRAINT [fk]')
    expect(toggle('CREATE UNIQUE NONCLUSTERED INDEX ix ON dbo.t (a) INCLUDE (b)')).toBe('CREATE UNIQUE NONCLUSTERED INDEX [ix] ON [dbo].[t] ([a]) INCLUDE ([b])')
    expect(toggle('CREATE STATISTICS s ON t (a)')).toBe('CREATE STATISTICS [s] ON [t] ([a])')
    expect(toggle('WITH a (x) AS (SELECT 1), b (y) AS (SELECT x FROM a) SELECT y FROM b'))
      .toBe('WITH [a] ([x]) AS (SELECT 1), [b] ([y]) AS (SELECT [x] FROM [a]) SELECT [y] FROM [b]')
    // A join's ON before a call stays a call.
    expect(toggle('SELECT 1 FROM t JOIN u ON ISNULL(t.a, 0) = u.a')).toBe('SELECT 1 FROM [t] JOIN [u] ON ISNULL([t].[a], 0) = [u].[a]')
  })
  it('brackets only the names in statements about servers, databases and security, however they are scripted', () => {
    const triggers = 'CREATE TRIGGER [dbo].[tr] ON [dbo].[t] AFTER INSERT AS SELECT 1; CREATE TRIGGER [tv] ON [v] INSTEAD OF DELETE AS SELECT 1'
    expect(toggleBracketEdits(triggers).mode).toBe('remove')
    expect(toggle('CREATE SEQUENCE dbo.s AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE')).toBe('CREATE SEQUENCE [dbo].[s] AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE')
    expect(toggle('CREATE USER u FOR LOGIN l WITH DEFAULT_SCHEMA = dbo')).toBe('CREATE USER [u] FOR LOGIN [l] WITH DEFAULT_SCHEMA = dbo')
    expect(toggle('ALTER ROLE db_owner ADD MEMBER u')).toBe('ALTER ROLE [db_owner] ADD MEMBER [u]')
    expect(toggle('GRANT CONNECT TO u; GRANT VIEW DEFINITION ON SCHEMA::s TO u; GRANT SELECT, INSERT ON dbo.t TO r'))
      .toBe('GRANT CONNECT TO [u]; GRANT VIEW DEFINITION ON SCHEMA::s TO [u]; GRANT SELECT, INSERT ON [dbo].[t] TO [r]')
    expect(toggle('CREATE LOGIN l FROM WINDOWS; DROP USER IF EXISTS u')).toBe('CREATE LOGIN [l] FROM WINDOWS; DROP USER IF EXISTS [u]')
    expect(toggle("CREATE DATABASE db CONTAINMENT = NONE ON PRIMARY (NAME = N'db', FILENAME = N'x.mdf', SIZE = 8192KB, MAXSIZE = UNLIMITED, FILEGROWTH = 65536KB)\n LOG ON (NAME = N'db_log', SIZE = 10MB)"))
      .toBe("CREATE DATABASE [db] CONTAINMENT = NONE ON PRIMARY (NAME = N'db', FILENAME = N'x.mdf', SIZE = 8192KB, MAXSIZE = UNLIMITED, FILEGROWTH = 65536KB)\n LOG ON (NAME = N'db_log', SIZE = 10MB)")
    expect(toggle('ALTER DATABASE db MODIFY FILE (NAME = x, SIZE = 10MB); ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 1'))
      .toBe('ALTER DATABASE [db] MODIFY FILE (NAME = x, SIZE = 10MB); ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 1')
    expect(toggle('ALTER INDEX ix ON dbo.t DISABLE; DBCC CHECKIDENT (\'t\', RESEED, 0)')).toBe('ALTER INDEX [ix] ON [dbo].[t] DISABLE; DBCC CHECKIDENT (\'t\', RESEED, 0)')
    expect(toggle('CREATE EVENT SESSION s ON SERVER ADD EVENT sqlserver.rpc_completed ADD TARGET package0.ring_buffer'))
      .toBe('CREATE EVENT SESSION [s] ON SERVER ADD EVENT sqlserver.rpc_completed ADD TARGET package0.ring_buffer')
    expect(toggle('CREATE PARTITION SCHEME ps AS PARTITION pf ALL TO ([PRIMARY])')).toBe('CREATE PARTITION SCHEME [ps] AS PARTITION [pf] ALL TO ([PRIMARY])')
    expect(toggle('BACKUP LOG db TO DISK = \'x\'')).toBe('BACKUP LOG [db] TO DISK = \'x\'')
    expect(toggle('GRANT SELECT ON dbo.Url TO u')).toBe('GRANT SELECT ON [dbo].[Url] TO [u]')
    expect(toggle("BACKUP DATABASE db TO URL = N'https://x/y.bak' WITH COMPRESSION")).toBe("BACKUP DATABASE [db] TO URL = N'https://x/y.bak' WITH COMPRESSION")
    expect(toggle("ALTER DATABASE db ADD FILE (NAME = x, FILENAME = 'y') TO FILEGROUP fg; CREATE SERVER AUDIT a TO APPLICATION_LOG"))
      .toBe("ALTER DATABASE [db] ADD FILE (NAME = x, FILENAME = 'y') TO FILEGROUP [fg]; CREATE SERVER AUDIT [a] TO APPLICATION_LOG")
    expect(toggle('OPEN SYMMETRIC KEY k DECRYPTION BY CERTIFICATE c; CLOSE ALL SYMMETRIC KEYS; OPEN MASTER KEY DECRYPTION BY PASSWORD = \'x\''))
      .toBe('OPEN SYMMETRIC KEY [k] DECRYPTION BY CERTIFICATE [c]; CLOSE ALL SYMMETRIC KEYS; OPEN MASTER KEY DECRYPTION BY PASSWORD = \'x\'')
    expect(toggle("BEGIN DIALOG CONVERSATION @h FROM SERVICE s TO SERVICE 'x' ON CONTRACT c WITH ENCRYPTION = OFF; SEND ON CONVERSATION @h MESSAGE TYPE m (@b); END CONVERSATION @h"))
      .toBe("BEGIN DIALOG CONVERSATION @h FROM SERVICE [s] TO SERVICE 'x' ON CONTRACT [c] WITH ENCRYPTION = OFF; SEND ON CONVERSATION @h MESSAGE TYPE m (@b); END CONVERSATION @h")
    // A cursor stays a cursor, BEGIN TRAN is not a conversation.
    expect(toggle('OPEN c; BEGIN TRAN; SELECT a FROM t')).toBe('OPEN [c]; BEGIN TRAN; SELECT [a] FROM [t]')
    // A table statement after one of them is bracketed as usual, and so is an ALTER TABLE's DROP COLUMN.
    expect(toggle('GRANT SELECT ON t TO u\nSELECT a FROM t')).toBe('GRANT SELECT ON [t] TO [u]\nSELECT [a] FROM [t]')
    expect(toggle('ALTER TABLE t DROP COLUMN c')).toBe('ALTER TABLE [t] DROP COLUMN [c]')
  })
  it('skips option lists that wrap onto more lines, up to the next statement or clause', () => {
    expect(toggle("BACKUP DATABASE db TO DISK = 'x'\n WITH COMPRESSION,\n INIT, STATS = 10\nSELECT a FROM t"))
      .toBe("BACKUP DATABASE [db] TO DISK = 'x'\n WITH COMPRESSION,\n INIT, STATS = 10\nSELECT [a] FROM [t]")
    expect(toggle('DECLARE c CURSOR\n LOCAL FAST_FORWARD\n FOR SELECT a FROM t')).toBe('DECLARE [c] CURSOR\n LOCAL FAST_FORWARD\n FOR SELECT [a] FROM [t]')
    expect(toggle('ALTER DATABASE db SET\n RECOVERY FULL,\n PAGE_VERIFY CHECKSUM')).toBe('ALTER DATABASE [db] SET\n RECOVERY FULL,\n PAGE_VERIFY CHECKSUM')
    expect(toggle('SET NOCOUNT ON SELECT a FROM t')).toBe('SET NOCOUNT ON SELECT [a] FROM [t]')
    expect(toggle('SELECT a FROM t WITH NOLOCK WHERE b = 1')).toBe('SELECT [a] FROM [t] WITH NOLOCK WHERE [b] = 1')
    expect(toggle('SET ANSI_NULLS ON\nGO\nmyproc 1')).toBe('SET ANSI_NULLS ON\nGO\n[myproc] 1')
    expect(toggle('UPDATE t WITH (ROWLOCK) SET a = 1 FROM t')).toBe('UPDATE [t] WITH (ROWLOCK) SET [a] = 1 FROM [t]')
  })
  it('leaves keyword-like words, ODBC escapes and OPENROWSET BULK options', () => {
    expect(toggle('COMMIT WORK; EXEC (\'SELECT 1\') AT srv')).toBe('COMMIT WORK; EXEC (\'SELECT 1\') AT [srv]')
    expect(toggle('SELECT a FROM CHANGETABLE(CHANGES t, 0) AS c WHERE CONTAINS(b, \'x\', LANGUAGE 1033)'))
      .toBe('SELECT [a] FROM CHANGETABLE(CHANGES [t], 0) AS [c] WHERE CONTAINS([b], \'x\', LANGUAGE 1033)')
    expect(toggle("SELECT a FROM OPENROWSET(BULK 'x.txt', SINGLE_CLOB) AS f")).toBe("SELECT [a] FROM OPENROWSET(BULK 'x.txt', SINGLE_CLOB) AS [f]")
    expect(toggle("SELECT {fn UCASE(a)}, {d '2024-01-01'} FROM t")).toBe("SELECT {fn UCASE([a])}, {d '2024-01-01'} FROM [t]")
    expect(toggle('CREATE TABLE t (d varbinary(max) FILESTREAM, s xml COLUMN_SET FOR ALL_SPARSE_COLUMNS); DECLARE @x character varying(10)'))
      .toBe('CREATE TABLE [t] ([d] varbinary(max) FILESTREAM, [s] [xml] COLUMN_SET FOR ALL_SPARSE_COLUMNS); DECLARE @x character varying(10)')
  })
  it('keeps adjacent names apart when it takes their brackets off', () => {
    expect(toggle('SELECT [a][b] FROM [dbo].[t][x]')).toBe('SELECT a b FROM dbo.t x')
  })
  it('changes only names wholly inside the selection', () => {
    const text = 'SELECT a, b FROM t'
    expect(toggle(text, [{ start: 7, end: 11 }])).toBe('SELECT [a], [b] FROM t')
    expect(toggle(text, [{ start: 8, end: 11 }])).toBe('SELECT a, [b] FROM t')
    expect(toggle('SELECT [a], b FROM [t]', [{ start: 7, end: 10 }])).toBe('SELECT a, b FROM [t]')
    // A selection that starts inside a comment or string still knows it is one.
    expect(toggle("SELECT 'x y' FROM t", [{ start: 9, end: 19 }])).toBe("SELECT 'x y' FROM [t]")
  })
  it('says when there is nothing to change', () => {
    expect(toggleBracketEdits('SELECT 1').mode).toBe('none')
    expect(toggleBracketEdits('-- only a comment').mode).toBe('none')
    expect(toggleBracketEdits('SELECT [a b]').mode).toBe('none')
  })
})

describe('Commas to Front and Commas to End', () => {
  it('moves trailing commas into the next line\'s indent, as Select Top Rows writes them', () => {
    expect(commas('SELECT a,\n       b,\n       c\nFROM t', 'front')).toBe('SELECT a\n      ,b\n      ,c\nFROM t')
    expect(commas('SELECT a\n      ,b\n      ,c\nFROM t', 'end')).toBe('SELECT a,\n       b,\n       c\nFROM t')
  })
  it('handles the comma-space style and no indent', () => {
    expect(commas('SELECT a\n    , b\n    , c', 'end')).toBe('SELECT a,\n    b,\n    c')
    expect(commas('a,\nb', 'front')).toBe('a\n,b')
    expect(commas('a\n,b', 'end')).toBe('a,\nb')
    expect(commas('a,\n\tb', 'front')).toBe('a\n\t,b')
  })
  it('keeps trailing comments where they are', () => {
    expect(commas('SELECT a, -- first\n       b -- second\nFROM t', 'front')).toBe('SELECT a -- first\n      ,b -- second\nFROM t')
    expect(commas('SELECT a -- first\n      ,b -- second\nFROM t', 'end')).toBe('SELECT a, -- first\n       b -- second\nFROM t')
    expect(commas('SELECT a,\n  -- note\n  b', 'front')).toBe('SELECT a\n  -- note\n ,b')
  })
  it('drops white space left at the end of a line', () => {
    expect(commas('SELECT a ,   \n  b', 'front')).toBe('SELECT a\n ,b')
  })
  it('moves a comma alone on its line with its line', () => {
    expect(commas('a\n,\nb', 'front')).toBe('a\n,b')
    expect(commas('a\n  ,  \nb', 'end')).toBe('a,\nb')
  })
  it('works in GROUP BY, ORDER BY, INSERT lists, VALUES and parameter lists', () => {
    expect(commas('INSERT INTO t (a,\n  b)\nVALUES (1,\n  2)', 'front')).toBe('INSERT INTO t (a\n ,b)\nVALUES (1\n ,2)')
    expect(commas('CREATE PROC p\n  @a int,\n  @b int\nAS SELECT 1', 'front')).toBe('CREATE PROC p\n  @a int\n ,@b int\nAS SELECT 1')
    expect(commas('SELECT a FROM t\nGROUP BY a,\n  b\nORDER BY a,\n  b DESC', 'front')).toBe('SELECT a FROM t\nGROUP BY a\n ,b\nORDER BY a\n ,b DESC')
  })
  it('never moves commas inside strings or comments, or ones in the middle of a line', () => {
    expect(commas("SELECT 'a,\n b', a, b /* x,\n y */", 'front')).toBe("SELECT 'a,\n b', a, b /* x,\n y */")
    expect(commas('SELECT a, b,\n  c', 'front')).toBe('SELECT a, b\n ,c')
  })
  it('leaves a comma next to a parenthesis, a semicolon or GO', () => {
    expect(commas('SELECT a,\n)', 'front')).toBe('SELECT a,\n)')
    expect(commas('(\n,a)', 'end')).toBe('(\n,a)')
    expect(commas('SELECT a,\nGO', 'front')).toBe('SELECT a,\nGO')
  })
  it('changes only commas inside the selection', () => {
    expect(commas('SELECT a,\n  b,\n«  c,\n»  d', 'front')).toBe('SELECT a,\n  b,\n  c\n ,d')
  })
  it('reads a comma after a string that spans lines as mid-line, and round-trips a tab indent', () => {
    expect(commas("SELECT a WHERE b IN ('a,\nb', 'c')", 'end')).toBe("SELECT a WHERE b IN ('a,\nb', 'c')")
    const tabbed = 'SELECT [a],\n\t[b]'
    expect(commas(commas(tabbed, 'front'), 'end')).toBe(tabbed)
  })
  it('keeps CRLF line endings', () => {
    expect(commas('SELECT a,\r\n  b', 'front')).toBe('SELECT a\r\n ,b')
  })
})

describe('Commas to Front and Commas to End in GoogleSQL', () => {
  const google = (text: string, position: 'front' | 'end') =>
    applyOffsetEdits(text, moveCommaEdits(text, [{ start: 0, end: text.length }], position, googleSqlTransformTokens(text), googleSqlTransforms))
  it('covers the text with tokens end to end, splitting white space at line breaks', () => {
    for (const text of ['SELECT a, # x\r\n  b -- y\r\n, `c`', "r'''a,\n''', b\"\"\"x\"\"\" /* ,\n */ @p, @@time_zone,\n[1, 2]"]) {
      const tokens = googleSqlTransformTokens(text)
      expect(tokens.map(token => text.slice(token.start, token.end)).join('')).toBe(text)
      for (const token of tokens) {
        if (token.kind === 'space') expect(text.slice(token.start, token.end)).not.toMatch(/[\r\n]/)
        if (token.kind === 'lineComment') expect(text.slice(token.start, token.end)).not.toMatch(/\r/)
      }
    }
    expect(googleSqlTransformTokens('a # b\r\nc').map(token => token.kind)).toEqual(['word', 'space', 'lineComment', 'newline', 'word'])
  })
  it('moves commas past # comments, raw and triple-quoted strings and backtick names, keeping those intact', () => {
    expect(google('SELECT a, # first, note\n  r"x,y",\n  \'\'\'p,\nq\'\'\',\n  `d,e`\nFROM t', 'front'))
      .toBe('SELECT a # first, note\n ,r"x,y"\n ,\'\'\'p,\nq\'\'\'\n ,`d,e`\nFROM t')
    expect(google('SELECT a # one,\n  b', 'front')).toBe('SELECT a # one,\n  b')
    expect(google('SELECT a\n  ,b # x\n  ,c', 'end')).toBe('SELECT a,\n   b, # x\n   c')
  })
  it('reads an array\'s brackets as brackets, and CRLF line endings stay', () => {
    expect(google('SELECT [1,\n  2,\n]', 'front')).toBe('SELECT [1\n ,2,\n]')
    expect(google('SELECT a,\r\n  b # c\r\nFROM t', 'front')).toBe('SELECT a\r\n ,b # c\r\nFROM t')
  })
  it('finds the statement without GO lines', () => {
    const text = 'SELECT a,\n  b\nGO\n, c'
    expect(statementAt(text, text.length, googleSqlTransformTokens(text), googleSqlTransforms)).toEqual({ start: 0, end: text.length })
    // T-SQL's GO line ends the statement before it.
    expect(statementAt(text, text.length)).toEqual({ start: text.indexOf('GO') + 2, end: text.length })
  })
})

describe('statementAt', () => {
  const at = (marked: string) => { const offset = marked.indexOf('|'), text = marked.replace('|', ''); const range = statementAt(text, offset); return text.slice(range.start, range.end) }
  it('splits at semicolons, GO lines, SQLCMD lines and blank lines', () => {
    expect(at('SELECT 1; SELECT |2; SELECT 3')).toBe(' SELECT 2;')
    expect(at('SELECT 1;|')).toBe('SELECT 1;')
    expect(at('SELECT a,\n b\nGO\nSELECT |c')).toBe('\nSELECT c')
    expect(at('SELECT a,\n  |b\n\nSELECT c')).toBe('SELECT a,\n  b\n')
    expect(at('SELECT a /* x\n\n y */,\n  |b')).toBe('SELECT a /* x\n\n y */,\n  b')
    expect(at("SELECT 'x;\n\n', |a")).toBe("SELECT 'x;\n\n', a")
    // A caret on a separator is in the statement before it, never in both.
    expect(at('SELECT a,\n b\nG|O\nSELECT c,\n d')).toBe('SELECT a,\n b\n')
    expect(at('SELECT a,\n b\n  |  \nSELECT c')).toBe('SELECT a,\n b\n')
    expect(at('SELECT a\n:setv|ar x 1\nSELECT c')).toBe('SELECT a\n')
  })
})

describe('applying transforms', () => {
  it('maps offsets past edits', () => {
    const edits = [{ start: 2, end: 3, text: '[x]' }, { start: 5, end: 5, text: ',' }]
    expect(mapOffset(edits, 0)).toBe(0)
    expect(mapOffset(edits, 2)).toBe(2)
    expect(mapOffset(edits, 4)).toBe(6)
    expect(mapOffset(edits, 5)).toBe(7)
    expect(mapOffset(edits, 6)).toBe(9)
  })
  it('moves selections with the text and refuses a query over the limit', () => {
    const text = 'SELECT a,\n  b'
    const lines = text.split('\n'), starts = [0, lines[0]!.length + 1]
    const model: SqlTransformModel = {
      getValue: () => text, getValueLength: () => text.length,
      getOffsetAt: ({ lineNumber, column }) => starts[lineNumber - 1]! + column - 1,
      getPositionAt: offset => offset >= starts[1]! ? { lineNumber: 2, column: offset - starts[1]! + 1 } : { lineNumber: 1, column: offset + 1 }
    }
    const edits = moveCommaEdits(text, [{ start: 0, end: text.length }], 'front')
    const op = sqlTransformOp(model, text, edits, [{ selectionStartLineNumber: 2, selectionStartColumn: 3, positionLineNumber: 2, positionColumn: 4 }])
    expect(op.selections).toEqual([{ selectionStartLineNumber: 2, selectionStartColumn: 3, positionLineNumber: 2, positionColumn: 4 }])
    expect(op.edits.map(edit => edit.text)).toEqual(['', ','])
    expect(() => transformText({ ...model, getValueLength: () => textOpLimits.characters + 1 })).toThrow(sqlTransformMessages.tooLarge)
  })
})
