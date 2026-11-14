using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

/// <summary>language.definition without a server: the name under the caret and what it may stand for (DefinitionNames), request
/// validation, the answer's shape on the wire, and the lookup SQL's offline lint.</summary>
internal static class SqlDefinitionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The candidates for the caret at the first '|' in <paramref name="marked"/> (which is removed).</summary>
    private static DefinitionLookup? At(string marked)
    {
        var offset = marked.IndexOf('|', StringComparison.Ordinal);
        var text = marked.Remove(offset, 1);
        return DefinitionNames.Find(text, DefinitionNames.PositionOf(text, offset));
    }
    private static DefinitionName[] Candidates(string marked) => [.. At(marked)?.Candidates ?? []];
    private static async Task<string?> Code(Func<Task> run)
    {
        try { await run(); return null; }
        catch (RequestException error) { return error.Code; }
    }

    public static async Task RunAsync(Action<bool, string> check)
    {
        Names(check);
        await RequestsAsync(check);
        Lint(check);
    }

    private static void Names(Action<bool, string> check)
    {
        check(Candidates("SELECT * FROM dbo.Cus|tomer") is [{ Database: null, Schema: "dbo", Name: "Customer", Column: null }], "an object's two-part name is its own candidate");
        check(Candidates("SELECT * FROM dbo.Customer|") is [{ Schema: "dbo", Name: "Customer" }], "a caret just after a name still finds it");
        check(Candidates("SELECT * FROM d|bo.Customer") is [{ Schema: "dbo", Name: "Customer" }], "a caret on the schema finds the whole name");
        check(Candidates("EXEC Sales.dbo.Lo|ad") is [{ Database: "Sales", Schema: "dbo", Name: "Load" }], "a three-part name keeps its database");
        check(Candidates("SELECT * FROM Sales..Cust|omer") is [{ Database: "Sales", Schema: null, Name: "Customer" }], "db..name leaves the schema to the default one");
        check(Candidates("SELECT * FROM [Sales Data].[my]]schema].\"Odd\"\"Name|\"") is [{ Database: "Sales Data", Schema: "my]schema", Name: "Odd\"Name" }],
            "bracketed and quoted parts are unquoted, doubled closers included");
        check(Candidates("SELECT * FROM Cust|omer") is [{ Database: null, Schema: null, Name: "Customer" }], "a one-part name resolves in the default schema");
        check(At("SELECT * FROM srv.Sales.dbo.Cust|omer") is null, "a linked server's four-part name is not looked up");
        check(At("SELECT * FROM #te|mp") is null && At("DECLARE @x int; SELECT @|x") is null, "temporary tables and variables are not looked up");
        check(At("SEL|ECT 1") is null && At("SELECT 1 |") is null && At("|") is null, "keywords and white space have no definition");
        check(At("SELECT * FROM 'dbo|.Customer'") is null && At("-- dbo.Cus|tomer") is null, "names inside literals and comments are not names");

        // Columns: the table behind an alias or table name, or the statement's tables for a bare column.
        check(Candidates("SELECT c.Na|me FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer", Column: null }],
            "a qualified column's alias stands for its table, and hides any object called c");
        check(Candidates("SELECT c|.Name FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer" }], "a caret on the alias finds its table too");
        check(Candidates("SELECT Customer.Na|me FROM dbo.Customer") is [{ Schema: "dbo", Name: "Customer" }, ..], "a column qualified by its table's name finds that table");
        check(Candidates("SELECT Na|me FROM dbo.Customer") is [{ Schema: "dbo", Name: "Customer", Column: null }], "a bare column of one table is that table's");
        check(Candidates("SELECT Na|me FROM dbo.Customer AS c INNER JOIN Sales.dbo.Orders AS o ON o.Id = c.Id")
            is [{ Schema: "dbo", Name: "Customer", Column: "Name" }, { Database: "Sales", Schema: "dbo", Name: "Orders", Column: "Name" }],
            "a bare column of several tables lets the column decide among them");
        check(Candidates("SELECT x.Id FROM (SELECT Na|me FROM dbo.Inner1) AS x INNER JOIN dbo.Outer1 AS o ON 1 = 1") is [{ Name: "Inner1", Column: null }],
            "a subquery's bare column takes the subquery's own tables");
        check(Candidates("UPDATE c SET Na|me = 1 FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer" }], "UPDATE's FROM names the target's table");
        check(Candidates("CREATE PROCEDURE dbo.P AS SELECT t.Co|l FROM dbo.T AS t") is [{ Schema: "dbo", Name: "T" }, ..], "a procedure body's own query resolves its aliases");
        // A broken batch elsewhere hides nothing; a broken batch here still finds names, and a qualified one may be a column.
        check(Candidates("SELECT FROM WHERE\nGO\nSELECT c.Na|me FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer" }, ..], "only the caret's batch is parsed");
        check(Candidates("SELECT c.Na|me FROM dbo.Customer AS c WHERE") is [{ Schema: "c", Name: "Name" }, { Schema: null, Name: "c" }],
            "an unparsable batch tries the name as an object and then its qualifier");
        check(Candidates("SELECT a.b.c.d.Na|me") is [], "a five-part name has no candidates");

        // A level's tables are its own FROM clause and target: never a subquery's, a CTE's or a derived table's.
        check(Candidates("SELECT (SELECT TOP 1 a.x FROM dbo.Z AS a) AS z, a.I|d FROM dbo.T AS a") is [{ Schema: "dbo", Name: "T" }],
            "a subquery's alias of the same name does not shadow the outer query's");
        check(Candidates("SELECT (SELECT MAX(v) FROM dbo.Z) AS m, Na|me FROM dbo.T") is [{ Schema: "dbo", Name: "T", Column: null }],
            "a subquery's tables are not the outer query's bare column's");
        check(Candidates("SELECT a.Id FROM dbo.T AS a WHERE EXISTS (SELECT 1 FROM dbo.Z AS a WHERE a.I|d = 1)") is [{ Schema: "dbo", Name: "Z" }],
            "inside a subquery, its own alias wins");
        check(Candidates("MERGE dbo.Target AS t USING dbo.Src AS s ON t.I|d = s.Id WHEN MATCHED THEN DELETE;") is [{ Schema: "dbo", Name: "Target" }]
            && Candidates("MERGE dbo.Target AS t USING dbo.Src AS s ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET t.Na|me = s.Name;") is [{ Name: "Target" }]
            && Candidates("MERGE dbo.Target AS t USING dbo.Src AS s ON t.Id = s.I|d WHEN MATCHED THEN DELETE;") is [{ Name: "Src" }],
            "MERGE's target alias and its source's resolve");
        check(At("WITH Orders AS (SELECT * FROM dbo.Sales) SELECT * FROM Ord|ers") is null
            && At("WITH Orders AS (SELECT Id FROM dbo.Sales) SELECT I|d FROM Orders") is null
            && At("WITH Orders AS (SELECT Id FROM dbo.Sales) SELECT o.I|d FROM Orders AS o") is null,
            "a CTE is no object, so neither it nor its columns are looked up as one");
        check(Candidates("WITH o AS (SELECT I|d FROM dbo.Sales) SELECT * FROM o") is [{ Schema: "dbo", Name: "Sales", Column: null }],
            "a CTE's own query resolves its tables");
        check(Candidates("SELECT f.Va|l FROM dbo.fn(1) AS f") is [{ Schema: "dbo", Name: "fn" }]
            && Candidates("SELECT f.Va|l FROM dbo.T AS a CROSS APPLY dbo.fn(a.x) AS f") is [{ Schema: "dbo", Name: "fn" }],
            "a table-valued function's alias, in FROM or APPLY, stands for the function");
        check(At("SELECT d.To|tal FROM (SELECT 1 AS Total) AS d") is null && At("DECLARE @t TABLE (x int); SELECT v.|x FROM @t AS v") is null
            && At("SELECT p.[1] FROM dbo.T PIVOT (MAX(v) FOR k IN ([1])) AS p WHERE p|.[1] = 1") is null,
            "a derived table's, a table variable's and a PIVOT's alias have no object");
        check(Candidates("SELECT To|tal FROM (SELECT 1 AS Total) AS d CROSS JOIN dbo.T") is [{ Schema: "dbo", Name: "T", Column: "Total" }],
            "beside a derived table, a bare column's table must have the column");
        // A table reference's own name is that object: another scope's alias of the same name never hides it.
        check(Candidates("SELECT * FROM (SELECT * FROM Ord|ers WHERE x = 1) AS Orders") is [{ Schema: null, Name: "Orders" }]
            && Candidates("WITH c AS (SELECT * FROM Ord|ers) SELECT * FROM c AS Orders") is [{ Name: "Orders" }]
            && Candidates("SELECT * FROM dbo.X AS Orders WHERE EXISTS (SELECT 1 FROM Ord|ers)") is [{ Schema: null, Name: "Orders" }]
            && Candidates("IF EXISTS (SELECT 1 FROM Ord|ers) SELECT * FROM dbo.Archive AS Orders") is [{ Schema: null, Name: "Orders" }]
            && Candidates("CREATE PROCEDURE p @t Fixture|List READONLY AS SELECT * FROM dbo.X AS FixtureList") is [{ Name: "FixtureList" }],
            "a table, type or other name is the object it names, whatever an alias elsewhere is called");
        check(Candidates("SELECT c.Name FROM dbo.Customer AS |c") is [{ Schema: "dbo", Name: "Customer" }]
            && Candidates("MERGE dbo.Target AS |t USING dbo.Src AS s ON t.Id = s.Id WHEN MATCHED THEN DELETE;") is [{ Name: "Target" }]
            && At("SELECT * FROM (SELECT 1 AS x) AS |d") is null && At("WITH |o AS (SELECT 1 AS x) SELECT * FROM o") is null,
            "an alias where it is declared is its table's, and a CTE's or derived table's is none");
        // GO 2 repeats the batch before it; the next batch starts after the count.
        check(Candidates("SELECT 1\nGO 2\nSELECT c.Na|me FROM dbo.C AS c") is [{ Schema: "dbo", Name: "C" }], "GO with a count still starts the next batch");
        // A column list's column is its own table's.
        check(Candidates("UPDATE dbo.T SET id = 1 OUTPUT inserted.id INTO dbo.Audit (i|d)") is [{ Schema: "dbo", Name: "Audit", Column: null }]
            && Candidates("INSERT INTO dbo.T (c|ol) SELECT x FROM dbo.S") is [{ Schema: "dbo", Name: "T" }],
            "OUTPUT INTO's and INSERT's column lists name their own table");
        check(Candidates("UPDATE dbo.T SET id = 1 OUTPUT inserted.i|d INTO dbo.Audit (id)") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("UPDATE c SET Name = 1 OUTPUT deleted.Na|me FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer" }]
            && At("SELECT inserted.Na|me FROM inserted") is null,
            "OUTPUT's inserted and deleted are the DML target's rows, and elsewhere no object");
        check(Candidates("UPDATE T SET c|c = 1 FROM dbo.T") is [{ Schema: "dbo", Name: "T", Column: null }],
            "UPDATE T ... FROM dbo.T names one table, the FROM clause's");
        // Only UPDATE's and DELETE's target names another table; INSERT's is its own, whatever its source is called.
        check(Candidates("INSERT INTO Customer (I|d, Name) SELECT Id, Name FROM Staging.Customer") is [{ Schema: null, Name: "Customer" }]
            && Candidates("INSERT INTO Customer (Id, Name) OUTPUT inserted.I|d SELECT Id, Name FROM Staging.Customer") is [{ Schema: null, Name: "Customer" }]
            && Candidates("INSERT INTO T (x|) SELECT a FROM dbo.S AS T") is [{ Schema: null, Name: "T" }],
            "an INSERT target is never swapped for a source of its name");
        check(At("INSERT INTO #tmp (x|) SELECT a FROM dbo.S") is null && At("INSERT INTO @t (x|) SELECT a FROM dbo.S") is null
            && At("UPDATE dbo.T SET x = 1 OUTPUT inserted.x INTO @t (x|)") is null && At("UPDATE dbo.T SET x = 1 OUTPUT inserted.x INTO #a (x|)") is null,
            "a column list of a variable or temp table has nothing to go to, never another table");
        check(Candidates("SELECT * FROM dbo.Orders AS o JOIN Archive.Orders ON o.Id = Orders.I|d") is [{ Schema: "Archive", Name: "Orders" }]
            && Candidates("CREATE TRIGGER t ON dbo.T AFTER INSERT AS INSERT INTO dbo.A (x) OUTPUT inserted.x| SELECT i.x FROM inserted AS i") is [{ Schema: "dbo", Name: "A" }],
            "an aliased table's own name is hidden, as SQL Server hides it");
        check(Candidates("UPDATE |c SET Name = 1 FROM dbo.Customer AS c") is [{ Schema: "dbo", Name: "Customer" }]
            && Candidates("DELETE |c FROM dbo.Customer AS c WHERE c.Id = 1") is [{ Schema: "dbo", Name: "Customer" }]
            && Candidates("UPDATE |T SET x = 1 FROM dbo.T") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("UPDATE dbo.|T SET x = 1") is [{ Schema: "dbo", Name: "T" }],
            "the caret on UPDATE's or DELETE's target finds the table it names");
        // Scripts without semicolons: a broken statement before or after the caret's still leaves its aliases.
        check(Candidates("SELECT o.Tot|al FROM dbo.Orders o\nSELECT * FROM WHERE") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT * FROM dbo.Lines l WHERE\nSELECT o.Tot|al FROM dbo.Orders o") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT o.Id\nFROM dbo.Orders o\nWHERE o.Sta|tus = 1\n\nSELECT TOP 10 * FROM dbo.Lines l WHERE l.") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT Tot|al FROM dbo.Orders\nSELECT * FROM dbo.Lines WHERE") is [{ Schema: "dbo", Name: "Orders", Column: null }]
            && Candidates("UPDATE c SET Na|me = 1 FROM dbo.Customer AS c WITH (NOLOCK) WHERE c.Id = 1\nSELECT * FROM WHERE") is [{ Schema: "dbo", Name: "Customer" }],
            "a statement keyword starts a statement for the fallback, and SET or WITH inside one stays with it");
        // A method of a column (XML, CLR types) is the column's, never a three-part object.
        check(Candidates("SELECT t.Do|c.value('(/a)[1]','int') FROM dbo.Xml t") is [{ Schema: "dbo", Name: "Xml" }]
            && Candidates("SELECT |t.Doc.value('(/a)[1]','int') FROM dbo.Xml t") is [{ Schema: "dbo", Name: "Xml" }]
            && Candidates("SELECT t.Doc.val|ue('(/a)[1]','int') FROM dbo.Xml t") is [{ Schema: "dbo", Name: "Xml" }]
            && Candidates("SELECT Do|c.value('(/a)[1]','int') FROM dbo.Xml") is [{ Schema: "Doc", Name: "value" }, { Schema: "dbo", Name: "Xml", Column: "Doc" }]
            && Candidates("SELECT dbo.f|n(1) FROM dbo.T") is [{ Schema: "dbo", Name: "fn" }, ..],
            "a call on a column is a method of its table's column; a schema's function stays first otherwise");
        // White space and comments may sit around the dots.
        check(Candidates("SELECT * FROM dbo . /*x*/ Ord|ers") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT * FROM dbo./*c*/Ord|ers") is [{ Schema: "dbo", Name: "Orders" }]
            && At("SELECT * FROM dbo.  Ord|ers")?.Range == new LanguageRange(new(0, 14), new(0, 26))
            && Candidates("SELECT l . Tot|al FROM dbo.Orders o JOIN dbo.Lines l ON o.Id = l.OrderId") is [{ Schema: "dbo", Name: "Lines" }],
            "white space and comments around a name's dots keep it whole");
        check(At("CREATE TRIGGER dbo.trg ON dbo.Orders AFTER INSERT AS SELECT * FROM inser|ted") is null
            && At("CREATE TRIGGER dbo.trg ON dbo.Orders AFTER DELETE AS SELECT * FROM dele|ted") is null,
            "a trigger's inserted and deleted in FROM have no object");
        // Correlation: a subquery's column may be an outer table's; a derived table's or CTE's may not.
        check(Candidates("SELECT (SELECT MAX(v) FROM (VALUES (Col|A), (ColB)) AS t(v)) FROM dbo.Wide") is [{ Schema: "dbo", Name: "Wide", Column: "ColA" }],
            "a VALUES list inside a subquery leaves its columns to the outer table");
        check(Candidates("SELECT * FROM dbo.Customers c WHERE EXISTS (SELECT 1 FROM dbo.Orders o WHERE o.CustomerId = c.Id AND Regi|on = 'W')")
            is [{ Name: "Orders", Column: "Region" }, { Name: "Customers", Column: "Region" }],
            "a correlated subquery's bare column may be the outer table's, offered after its own");
        check(Candidates("SELECT * FROM dbo.A AS a CROSS APPLY (SELECT TOP 1 Va|l FROM dbo.B AS b WHERE b.Id = a.Id) AS x") is [{ Name: "B", Column: "Val" }, { Name: "A", Column: "Val" }]
            && Candidates("WITH c AS (SELECT Na|me FROM dbo.Inner1) SELECT * FROM c CROSS JOIN dbo.Outer1") is [{ Name: "Inner1", Column: null }],
            "an APPLY's query sees outer tables, a CTE's does not");
        // Column names that are no column references.
        check(Candidates("CREATE TABLE dbo.Lines (OrderId int REFERENCES dbo.Orders (I|d))") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("ALTER TABLE dbo.Lines ADD FOREIGN KEY (OrderId) REFERENCES dbo.Orders (I|d)") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("CREATE INDEX ix ON dbo.Orders (Custom|erId) INCLUDE (Total)") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("CREATE INDEX ix ON dbo.Orders (CustomerId) INCLUDE (Tot|al)") is [{ Schema: "dbo", Name: "Orders" }]
            && At("SELECT o.Total AS Gra|nd FROM dbo.Orders o") is null,
            "a foreign key's and an index's columns are their table's, and a column alias has no object");
        check(Candidates("SELECT d|bo.Orders.Total FROM dbo.Orders") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT Sales.dbo.Orders.To|tal FROM Sales.dbo.Orders") is [{ Database: "Sales", Schema: "dbo", Name: "Orders" }],
            "a caret anywhere in a column's qualifier finds the whole qualifier");
        check(Candidates("USE Sales;\nSELECT * FROM dbo.Ord|ers") is [{ Database: "Sales", Schema: "dbo", Name: "Orders" }]
            && Candidates("USE [Sales Data]\nGO\nSELECT o.To|tal FROM dbo.Orders AS o") is [{ Database: "Sales Data", Schema: "dbo", Name: "Orders" }]
            && Candidates("USE Sales; SELECT * FROM Other.dbo.Ord|ers") is [{ Database: "Other" }],
            "USE earlier in the script is the database a name without one resolves in");
        check(Candidates("SELECT * FROM dbo.T OPTION (USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION'))\nSELECT * FROM dbo.Ord|ers") is [{ Database: null, Schema: "dbo", Name: "Orders" }],
            "a query's USE HINT is no USE statement");
        check(Candidates("SELECT * FROM dbo.Lines l WHERE\nSELECT o.Total FROM dbo.Orders o ORDER BY o.Status|") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT * FROM dbo.Lines l WHERE\nSELECT o.Total FROM dbo.Orders o|") is [{ Schema: "dbo", Name: "Orders" }],
            "a caret at the end of the text still finds its statement's aliases");
        check(Candidates("SELECT COUNT( FROM dbo.X\nSELECT o.Tot|al FROM dbo.Orders o WHERE o.Id = 1") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT * FROM dbo.X WHERE Id IN (1, 2\nSELECT l.Qt|y FROM dbo.Lines l WHERE l.Id = 1") is [{ Schema: "dbo", Name: "Lines" }],
            "an unclosed parenthesis before the caret's statement does not hide it");
        check(Candidates("SELECT o.Id\nFROM dbo.Orders o\nWHERE o.Id IN (\n  SELECT a.X FROM dbo.A a)\n  OR o.Id IN (\n  SELECT b.X FROM dbo.B b)\n  OR o.Id IN (\n  SELECT c.X FROM dbo.C c)\n  OR o.Id IN (\n  SELECT d.X FROM dbo.D d)\nORDER BY o.To|tal\n\nSELECT * FROM dbo.Lines WHERE") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("WITH a AS (\n  SELECT 1 AS x), b AS (\n  SELECT 1 AS x), c AS (\n  SELECT 1 AS x), d AS (\n  SELECT 1 AS x)\nSELECT * FROM d|\nSELECT * FROM dbo.Lines WHERE") is [],
            "subqueries on their own lines never crowd their statement's start out of the fallback's reach");
        check(Candidates("ALTER TABLE dbo.Lines ADD CONSTRAINT fk FOREIGN KEY (Order|Id) REFERENCES dbo.Orders (Id)") is [{ Schema: "dbo", Name: "Lines" }]
            && Candidates("CREATE TABLE dbo.T (Id int, PId int, CONSTRAINT fk FOREIGN KEY (P|Id) REFERENCES dbo.P (Id))") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("ALTER TABLE dbo.Lines ADD CONSTRAINT pk PRIMARY KEY (I|d)") is [{ Schema: "dbo", Name: "Lines" }],
            "a key's or foreign key's own columns are its table's");
        check(At("CREATE TABLE dbo.A (Id int)\nDECLARE @t TABLE (Id int, PRIMARY KEY (I|d))") is null
            && At("CREATE TABLE dbo.A (Id int);\nCREATE TYPE dbo.TT AS TABLE (Id int, PRIMARY KEY (I|d))") is null
            && At("CREATE PROCEDURE p AS BEGIN CREATE TABLE dbo.A (Id int); DECLARE @t TABLE (Id int, PRIMARY KEY (I|d)) END") is null,
            "a table's key list never lends the table to a later table variable or type");
        check(Candidates("ALTER TABLE dbo.B ADD CONSTRAINT df DEFAULT 0 FOR I|d") is [{ Schema: "dbo", Name: "B" }]
            && Candidates("ALTER TABLE dbo.T ALTER COLUMN I|d int") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("ALTER TABLE dbo.T DROP COLUMN I|d") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("ALTER TABLE dbo.T DROP COLUMN A, B|") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("ALTER TABLE dbo.T ADD PERIOD FOR SYSTEM_TIME (Valid|From, ValidTo)") is [{ Schema: "dbo", Name: "T" }]
            && Candidates("CREATE TABLE dbo.T (Id int, INDEX ix (I|d))") is [{ Schema: "dbo", Name: "T" }]
            && At("DECLARE @t TABLE (Id int, INDEX ix (I|d))") is null
            && Candidates("INSERT INTO dbo.Arch|ive (Id) SELECT Id FROM dbo.Orders") is [{ Schema: "dbo", Name: "Archive" }],
            "ALTER TABLE's column names are its table's, and an INSERT target before its column list is that table alone");
        check(Candidates("SELECT * FROM dbo.tv|f(1) AS f") is [{ Schema: "dbo", Name: "tvf", Column: null }],
            "a FROM clause's table-valued function is never a column's method");
        check(Candidates("WITH src AS (SELECT Id, Name FROM dbo.Staging) INSERT INTO dbo.Customer (Id, Name) SELECT Id, Na|me FROM src") is []
            && Candidates("INSERT INTO dbo.Archive (Id) SELECT I|d FROM dbo.Orders") is [{ Schema: "dbo", Name: "Orders", Column: null }]
            && Candidates("INSERT INTO dbo.Archive (I|d) SELECT Id FROM dbo.Orders") is [{ Schema: "dbo", Name: "Archive" }],
            "an INSERT's target is no source of its SELECT's columns, only of its column list");
        check(Candidates("SELECT o|.* FROM dbo.Orders o JOIN dbo.Lines l ON o.Id = l.OrderId") is [{ Schema: "dbo", Name: "Orders" }]
            && Candidates("SELECT l|.* FROM dbo.Orders o JOIN dbo.Lines l ON o.Id = l.OrderId") is [{ Schema: "dbo", Name: "Lines" }]
            && Candidates("SELECT d|.* FROM (SELECT 1 AS a) AS d") is [],
            "a qualified star's qualifier is its table");
        check(At("CREATE TABLE dbo.T (I|d int)") is null
            && At("WITH c(a|b, cd) AS (SELECT 1, 2) SELECT * FROM c") is null
            && At("SELECT * FROM (VALUES (1)) AS t(v|v)") is null
            && At("SELECT * FROM dbo.X x CROSS APPLY x.Doc.nodes('/a') AS t(c|)") is null,
            "a declared column has no object");
        check(Candidates("SELECT t.c.val|ue('.', 'int') FROM dbo.X x CROSS APPLY x.Doc.nodes('/a') AS t(c)") is []
            && Candidates("SELECT * FROM dbo.X x CROSS APPLY x.Doc.no|des('/a') AS t(c)") is [{ Schema: "dbo", Name: "X" }],
            "an XML nodes() call is a method of its table's column, never a database's function");
        // A batch that does not parse still has a caret statement that may.
        check(Candidates("SELECT c.Na|me FROM dbo.C c; SELECT * FROM") is [{ Schema: "dbo", Name: "C" }]
            && Candidates("SELECT Na|me FROM dbo.C; SELECT * FROM") is [{ Schema: "dbo", Name: "C", Column: null }]
            && Candidates("SELECT * FROM; SELECT c.Na|me FROM dbo.C c;") is [{ Schema: "dbo", Name: "C" }],
            "a broken statement before or after the caret's does not hide its aliases");

        var lookup = At("SELECT 1;\r\nSELECT * FROM [dbo].Cust|omer\r\n");
        check(lookup?.Range == new LanguageRange(new(1, 14), new(1, 28)), "the range spans the whole name in UTF-16 positions, CRLF counted once");
        check(Candidates("SELECT * FROM dbo.🙂T|able") is [{ Name: "🙂Table" }] && At("SELECT * FROM dbo.🙂Table|")?.Range.End == new LanguagePosition(0, 25),
            "surrogate pairs count as two UTF-16 units");
        var deep = "SELECT " + string.Concat(Enumerable.Repeat("(", 200)) + "c.Na|me" + string.Concat(Enumerable.Repeat(")", 200)) + " FROM dbo.Customer AS c";
        check(Candidates(deep) is [{ Schema: "c", Name: "Name" }, ..], "deep nesting skips the parse rather than recursing, and still finds the name");
        check(At(new string('x', 200) + "|") is null, "a name longer than sysname is refused");
        var joins = "SELECT |x FROM dbo.T0" + string.Concat(Enumerable.Range(1, 11).Select(index => " CROSS JOIN dbo.T" + index));
        check(Candidates(joins) is { Length: DefinitionNames.MaxCandidates } bounded && bounded[0] is { Name: "T0", Column: "x" } && bounded[^1].Name == "T" + (DefinitionNames.MaxCandidates - 1),
            "a bare column of twelve tables keeps the first eight candidates");
    }

    private static async Task RequestsAsync(Action<bool, string> check)
    {
        var host = new Host();
        var service = new DefinitionService(host);
        var connection = Guid.NewGuid().ToString();
        LanguageRequest Request(string text = "SELECT * FROM dbo.T", LanguageContext? context = null, LanguagePosition? position = null) =>
            new(Guid.NewGuid().ToString(), 1, text, context ?? new("sqlserver", connection, "Sales"), position ?? new(0, 16));
        check(await Code(() => service.ResolveAsync(Request() with { DocumentId = "not-a-guid" }, default)) == "INVALID_PARAMS", "a definition request needs a document UUID");
        check(await Code(() => service.ResolveAsync(Request(new string('x', SqlToolsLanguageService.MaxTextCharacters + 1)), default)) == "INVALID_PARAMS", "the backend bounds the document itself");
        check(await Code(() => service.ResolveAsync(Request(context: new("sqlserver", connection, new string('d', 129))), default)) == "INVALID_PARAMS", "the database name is bounded by sysname");
        check(await Code(() => service.ResolveAsync(Request(position: new(4, 0)), default)) == "INVALID_PARAMS", "the position must be inside the document");
        check(await Code(() => service.ResolveAsync(Request(context: new("postgresql", connection)), default)) == "INVALID_PARAMS", "only the SQL Server provider resolves definitions");
        check(await Code(() => service.ResolveAsync(Request(context: new("sqlserver", "not-a-guid")), default)) == "INVALID_PARAMS", "the connection id is a UUID");
        check(await service.ResolveAsync(Request(context: new("sqlserver")), default) is null && host.Profiles == 0, "a query without a connection answers null without SQL");
        check(await service.ResolveAsync(Request("SELECT 1", position: new(0, 3)), default) is null && host.Profiles == 0, "no name under the caret answers null without SQL");
        check(await Code(() => service.ResolveAsync(Request(), default)) == "NOT_CONNECTED" && host.Profiles == 1, "an unknown connection is NOT_CONNECTED");
        // A database that cannot be opened is nothing to go to; a server or login that cannot be reached is an error, not "no definition".
        var cloud = new Host(new ServerProfile(12, null, 5, null, false, true, true, 16), ConnectionFailureChecks.Sql(4060, 1, 11, "server", "Cannot open database."));
        check(await new DefinitionService(cloud).ResolveAsync(Request("SELECT * FROM Gone.dbo.T", position: new(0, 22)), default) is null && cloud.Opened.SequenceEqual(["Gone"]),
            "a cloud database the login cannot open answers null");
        check(new[] { 922, 924, 926, 927, 976, 978 }.All(number => DefinitionService.Unavailable(ConnectionFailureChecks.Sql(number, 1, 14, "server", "Database unavailable.")))
            && !DefinitionService.Unavailable(ConnectionFailureChecks.Sql(18456, 1, 14, "server", "Login failed.")),
            "a recovering, suspect, restoring, single-user or unreadable secondary database is nothing to go to, a failed login is not");
        var refused = new Host(new ServerProfile(17, null, 3, null, false, true, true, 16), ConnectionFailureChecks.Sql(18456, 1, 14, "server", "Login failed."));
        var surfaced = false;
        try { await new DefinitionService(refused).ResolveAsync(Request(), default); }
        catch (Microsoft.Data.SqlClient.SqlException error) { surfaced = error.Number == 18456; }
        check(surfaced && refused.Opened.SequenceEqual([(string?)null]), "a failed login is the caller's error, never a null answer");

        using var sql = new SqlService();
        check(SqlService.MethodNames.Contains("language.definition") && sql.LaneOf("language.definition") == Varia.Backend.Protocol.RequestLane.Metadata,
            "language.definition is announced and takes a metadata slot");
        var strict = new JsonSerializerOptions(JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        try
        {
            await sql.DispatchAsync("language.definition", JsonSerializer.SerializeToElement(new { documentId = Guid.NewGuid().ToString(), version = 1, text = "x", context = new { providerId = "sqlserver" }, position = new { line = 0, character = 0 }, extra = 1 }, Json), strict);
            check(false, "language.definition rejects unexpected request properties");
        }
        catch (JsonException) { check(true, "language.definition rejects unexpected request properties"); }
        var answer = await sql.DispatchAsync("language.definition", JsonSerializer.SerializeToElement(Request(context: new("sqlserver")), Json), strict);
        check(answer is null, "a definition with nothing to look up is a null answer");
        var wire = JsonSerializer.Serialize(new LanguageDefinition("Sales", "dbo", "Load", "procedure", "sql", new(new(0, 5), new(0, 13))), Json);
        check(wire == "{\"database\":\"Sales\",\"schema\":\"dbo\",\"name\":\"Load\",\"kind\":\"procedure\",\"subtype\":\"sql\",\"range\":{\"start\":{\"line\":0,\"character\":5},\"end\":{\"line\":0,\"character\":13}}}",
            "the answer has the renderer schema's members, in camel case");
        string[] kinds = ["table", "view", "procedure", "function", "synonym", "sequence", "type", "tableType"];
        string[] codes = ["U", "S", "V", "P", "PC", "X", "RF", "FN", "IF", "TF", "FS", "FT", "AF", "SN", "SO", "TT", "UA", "UD"];
        check(codes.All(code => DefinitionSql.KindOf(code) is { } kind && kinds.Contains(kind.Kind)) && DefinitionSql.KindOf("PK") is null && DefinitionSql.KindOf("TR") is null
            && DefinitionSql.KindOf("U ") == ("table", null) && codes.All(code => DefinitionSql.Lookup.Contains("'" + code + "'", StringComparison.Ordinal)),
            "every code the lookup returns maps to a kind the renderer accepts, and nothing else does");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = Enumerable.Range(ExplorerCatalog.MinBand, ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1)
            .SelectMany(band => CatalogSql.Lint(DefinitionSql.Lookup, new SqlRender(band), list: false, mayCheckAccess: false, DefinitionSql.Literals)).ToList();
        check(problems.Count == 0, "the definition lookup passes the catalog lint: " + string.Join("; ", problems));
        check(!DefinitionSql.Lookup.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase) && !DefinitionSql.Lookup.Contains("TYPE_ID(", StringComparison.OrdinalIgnoreCase)
            && !DefinitionSql.Lookup.Contains("EXEC", StringComparison.OrdinalIgnoreCase), "the lookup reads catalog views only and executes nothing");
        foreach (var parameter in new[] { "@schema", "@name", "@column" }) check(DefinitionSql.Lookup.Contains(parameter, StringComparison.Ordinal) && DefinitionSql.Declarations.Contains(parameter + " sysname", StringComparison.Ordinal), "the lookup takes " + parameter + " as a sysname parameter");
        var wrapper = DefinitionSql.Wrapper;
        check(wrapper.Contains("QUOTENAME(@db) + N'.sys.sp_executesql'", StringComparison.Ordinal) && wrapper.Split("@db").Length == 2
            && CatalogSql.Lint(wrapper.Replace("@db", "@x", StringComparison.Ordinal), new SqlRender(12), false, false).Count == 0,
            "the cross-database wrapper names the database only through QUOTENAME");
    }

    /// <summary>No server: every connection is unknown, as SqlService answers before connecting; or, with a profile, every open
    /// fails with <paramref name="open"/>.</summary>
    private sealed class Host(ServerProfile? profile = null, Exception? open = null) : IExplorerHost
    {
        public int Profiles;
        public List<string?> Opened { get; } = [];
        public ServerProfile Profile(string connectionId) { Profiles++; return profile ?? throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first."); }
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId, string? database) { Opened.Add(database); return profile is null ? throw new InvalidOperationException("No SQL in offline checks.") : new Microsoft.Data.SqlClient.SqlConnection(); }
        public Microsoft.Data.SqlClient.SqlConnection SsisConnection(string connectionId) => throw new InvalidOperationException("No SQL in offline checks.");
        public string SsisCatalog => "SSISDB";
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => throw open ?? new InvalidOperationException("No SQL in offline checks.");
    }
}
