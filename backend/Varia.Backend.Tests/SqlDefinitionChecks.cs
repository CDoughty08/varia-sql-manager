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
        check(Candidates(string.Join(" UNION ALL ", Enumerable.Range(0, 20).Select(index => "SELECT x FROM dbo.T" + index)).Replace("SELECT x", "SELECT |x", StringComparison.Ordinal)).Length <= DefinitionNames.MaxCandidates,
            "candidates are bounded");
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
