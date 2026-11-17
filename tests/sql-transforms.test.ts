import { describe, expect, it } from 'vitest'
import { lexSql } from '../src/shared/sql/lexer'
import { applyOffsetEdits, mapOffset, moveCommaEdits, sqlTransformOp, statementAt, toggleBracketEdits, transformText, sqlTransformMessages, type OffsetRange, type SqlTransformModel } from '../src/renderer/src/editor/sql-transforms'
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
  it('keeps CRLF line endings', () => {
    expect(commas('SELECT a,\r\n  b', 'front')).toBe('SELECT a\r\n ,b')
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
