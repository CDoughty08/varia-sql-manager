using Microsoft.Data.SqlClient;
using System.Text.Json;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Live explorer.peek checks, run by the Explorer suite: system objects for every band up to the server's and with a
/// pool per database, missing objects, the budget, and (VARIA_TEST_SQL_SCRATCH=1) hostile-named objects in the scratch
/// database whose facts are known.</summary>
internal static class PeekLiveChecks
{
    private static async Task<PeekResult> Peek(SqlService service, string connectionId, ObjectRefDto target, JsonSerializerOptions json) =>
        (PeekResult)await service.DispatchAsync("explorer.peek", JsonSerializer.SerializeToElement(new PeekArgs(connectionId, Guid.NewGuid().ToString(), target), json), json);

    private static async Task<PeekDependenciesResult> Dependencies(SqlService service, string connectionId, ObjectRefDto target, JsonSerializerOptions json) =>
        (PeekDependenciesResult)await service.DispatchAsync("explorer.peekDependencies", JsonSerializer.SerializeToElement(new PeekArgs(connectionId, Guid.NewGuid().ToString(), target), json), json);

    private static async Task<PeekDefinitionResult> DefinitionPage(SqlService service, string connectionId, ObjectRefDto target, int offset, JsonSerializerOptions json) =>
        (PeekDefinitionResult)await service.DispatchAsync("explorer.peekDefinition", JsonSerializer.SerializeToElement(new PeekDefinitionArgs(connectionId, Guid.NewGuid().ToString(), target, offset), json), json);

    /// <summary>A module longer than one page, read as the renderer reads it: the peek's first page, then explorer.peekDefinition
    /// from where each page ended, compared whole with the text that made it. A surrogate pair straddles the first page's end, so
    /// the first page ends before it and the second starts with it whole; every page answers the same length and stamp.</summary>
    private static async Task LongDefinitionAsync(Action<bool, string> check, SqlService service, string connectionId, string database, Func<string, string, Task<SqlRun>> sql, JsonSerializerOptions json)
    {
        var limits = ExplorerCatalog.Current.Peek;
        const string header = "CREATE PROCEDURE dbo.PeekLong AS\n--";
        var before = limits.DefinitionPageChars - 1 - header.Length;
        var after = limits.DefinitionPageChars + limits.DefinitionPageChars / 2;
        var expected = header + new string('a', before) + "\U0001F600" + new string('b', after) + "\nSELECT 1;";
        // Built on the server, so the script stays small; 0x3DD800DE is U+1F600's UTF-16LE pair whatever the collation.
        var created = await sql("DECLARE @body nvarchar(max) = N'CREATE PROCEDURE dbo.PeekLong AS' + NCHAR(10) + N'--' + REPLICATE(CONVERT(nvarchar(max), N'a'), " + before
            + ") + CONVERT(nvarchar(2), 0x3DD800DE) + REPLICATE(CONVERT(nvarchar(max), N'b'), " + after + ") + NCHAR(10) + N'SELECT 1;';\nEXEC (@body);\n", database);
        try
        {
            check(created.Status == "completed", "the long procedure is created: " + created.Error);
            var target = new ObjectRefDto("procedure", database, "dbo", "PeekLong");
            var peek = await Peek(service, connectionId, target, json);
            var first = peek.Definition ?? "";
            check(peek is { Error: null, DefinitionLength: { } length, DefinitionStamp: not null } && length == expected.Length && first.Length == limits.DefinitionPageChars - 1 && expected.StartsWith(first, StringComparison.Ordinal),
                "a module longer than a page peeks with its first page, which ends before a pair it would split, and the whole text's length: " + (peek.Error?.Message ?? first.Length + "/" + peek.DefinitionLength));
            var text = new System.Text.StringBuilder(first);
            var problems = new List<string>();
            for (var page = 0; text.Length < expected.Length && page < 8; page++)
            {
                var next = await DefinitionPage(service, connectionId, target, text.Length, json);
                if (next.Error is not null || next.Text is not { Length: > 0 } part || next.Length != expected.Length || next.Stamp != peek.DefinitionStamp) { problems.Add(next.Error?.Message ?? "page at " + text.Length); break; }
                if (part.Length > limits.DefinitionPageChars || char.IsLowSurrogate(part[0])) problems.Add("page at " + text.Length + " is " + part.Length + " long");
                text.Append(part);
            }
            check(problems.Count == 0 && text.ToString() == expected,
                "its pages, each from where the last ended, carry the same length and stamp and put together the text whole: " + string.Join(", ", problems) + " (" + text.Length + "/" + expected.Length + ")");
            var past = await DefinitionPage(service, connectionId, target, expected.Length, json);
            var gone = await DefinitionPage(service, connectionId, target with { Name = "NoSuchLong" }, 5, json);
            check(past is { Error: null, Text: "", Length: var pastLength } && pastLength == expected.Length && gone.Error?.Code == "NOT_FOUND",
                "a page past the end is empty, and a page of a module that is gone is NOT_FOUND: " + (past.Error?.Message ?? past.Text?.Length.ToString()) + " " + gone.Error?.Code);
        }
        finally { await sql("DROP PROCEDURE IF EXISTS dbo.PeekLong;", database); }
    }

    public static async Task SystemAsync(Action<bool, string> check, SqlService service, string connectionId, int major, JsonSerializerOptions json)
    {
        var options = service.Explorer.Options;
        var objects = new ObjectRefDto("view", "master", "sys", "objects");
        var help = new ObjectRefDto("procedure", "master", "sys", "sp_help");
        var extended = new ObjectRefDto("procedure", "master", "sys", "xp_msver");
        var jobs = new ObjectRefDto("table", "msdb", "dbo", "sysjobs");
        var hex = new ObjectRefDto("function", "master", "sys", "fn_varbintohexstr");
        var master = new ObjectRefDto("database", null, null, "master");
        var clustered = new ObjectRefDto("index", "msdb", null, "clust", new ParentRefDto("table", "dbo", "sysjobs"));
        // sa may be renamed: it is peeked only where it keeps its name.
        var sa = new ObjectRefDto("login", null, null, "sa");
        var hasSa = (await Peek(service, connectionId, sa, json)).Error is null;
        ObjectRefDto[] targets = [objects, help, extended, jobs, hex, master, clustered, .. hasSa ? new[] { sa } : []];
        var errors = new List<string>();
        var top = Math.Min(major, ExplorerCatalog.MaxBand);
        for (var band = ExplorerCatalog.MinBand; band <= top; band++)
        {
            options.ForceBand = band;
            foreach (var target in targets)
            {
                var peek = await Peek(service, connectionId, target, json);
                // A login refused an optional group (index usage) gets the other facts.
                var expected = ExplorerCatalog.Current.Peek.Kinds[target.Kind].FactsFor(band).Where(fact => !fact.Optional || peek.Refused is null).Select(fact => fact.Id);
                if (peek.Error is not null || !peek.Facts.Keys.SequenceEqual(expected)) errors.Add(target.Name + " @" + band + ": " + (peek.Error?.Message ?? string.Join(",", peek.Facts.Keys)));
            }
        }
        options.ForceBand = null;
        options.ForcePerDatabaseScope = true;
        foreach (var target in targets)
            if ((await Peek(service, connectionId, target, json)).Error is { } error) errors.Add(target.Name + " per database: " + error.Message);
        options.ForcePerDatabaseScope = false;
        check(errors.Count == 0, "Peek reads system views, procedures, extended procedures, tables, functions, an index, master and sa for bands 12-" + top + " and with a pool per database, with exactly the band's facts: "
            + string.Join(" | ", errors.Take(5)));

        var view = await Peek(service, connectionId, objects, json);
        check(view is { Error: null, Definition: { } text, DefinitionLength: null, DefinitionStamp: null } && text.Contains("CREATE VIEW", StringComparison.OrdinalIgnoreCase)
            && view.Facts["schema"] as string == "sys" && view.Facts["systemObject"] is true && view.Facts["created"] is string { Length: 19 } created && created[10] == 'T',
            "sys.objects peeks as a system view in sys with its text and a yyyy-MM-ddTHH:mm:ss creation date");
        var procedure = await Peek(service, connectionId, help, json);
        check(procedure is { Error: null, Definition: { } helpText } && helpText.Contains("CREATE PROC", StringComparison.OrdinalIgnoreCase) && procedure.Facts["executeAs"] as string == "CALLER"
            && procedure.Facts["recompile"] is false && procedure.Facts["ansiNulls"] is bool, "sp_help peeks with its text, EXECUTE AS CALLER and its options");
        var xp = await Peek(service, connectionId, extended, json);
        check(xp is { Error: null, Definition: null } && xp.Facts["executeAs"] is null && xp.Facts["ansiNulls"] is null && xp.Facts["systemObject"] is true,
            "an extended procedure has no module: no text and no module options");
        var table = await Peek(service, connectionId, jobs, json);
        check(table is { Error: null, Definition: null } && table.Facts["rowCount"] is long rows && rows >= 0 && table.Facts["lockEscalation"] as string == "TABLE" && table.Facts["systemObject"] is true
            && table.Facts["dataSpace"] is long && table.Facts["indexSpace"] is long && table.Facts["filegroup"] as string == "PRIMARY" && table.Facts["partitioned"] is false,
            "msdb's sysjobs peeks as a system table with its row count, space and filegroup, and no text: " + JsonSerializer.Serialize(table.Facts));
        var masterPeek = await Peek(service, connectionId, master, json);
        var masterFiles = masterPeek.Lists?.GetValueOrDefault("files")?.Rows ?? [];
        check(masterPeek is { Error: null, Definition: null } && masterPeek.Facts["status"] as string == "ONLINE" && masterPeek.Facts["owner"] as string is { Length: > 0 }
            && masterFiles.Any(row => row[0] as string == "master" && row[1] as string == "ROWS") && masterFiles.Any(row => row[1] as string == "LOG"),
            "master peeks on the server with its status, owner and files: " + (masterPeek.Error?.Message ?? JsonSerializer.Serialize(masterFiles.Select(row => row[0]))));
        var jobsIndex = await Peek(service, connectionId, clustered, json);
        check(jobsIndex is { Error: null } && jobsIndex.Facts["indexType"] as string == "Clustered" && jobsIndex.Lists?["indexColumns"].Rows is [["job_id", false, false, _]],
            "msdb's sysjobs clustered index peeks with its key column: " + (jobsIndex.Error?.Message ?? JsonSerializer.Serialize(jobsIndex.Facts)));
        if (hasSa)
        {
            var saPeek = await Peek(service, connectionId, sa, json);
            check(saPeek is { Error: null } && saPeek.Facts["loginType"] as string == "SQL Server authentication" && saPeek.Lists?["serverRoles"].Rows.Any(row => row is ["sysadmin", true]) == true,
                "sa peeks as a SQL login in sysadmin: " + (saPeek.Error?.Message ?? JsonSerializer.Serialize(saPeek.Facts)));
        }
        else Console.WriteLine("Peek's sa check skipped: this server has no login named sa.");
        var function = await Peek(service, connectionId, hex, json);
        check(function is { Error: null } && function.Facts["functionType"] as string == "Scalar-valued", "a system scalar function says Scalar-valued");

        var missing = await Peek(service, connectionId, new ObjectRefDto("table", "msdb", "dbo", "VariaNoSuchTable"), json);
        var goneDatabase = await Peek(service, connectionId, new ObjectRefDto("view", "VariaMissing_" + Guid.NewGuid().ToString("N"), "dbo", "v"), json);
        var wrongKind = await Peek(service, connectionId, objects with { Kind = "procedure" }, json);
        check(missing is { Error: { Code: "NOT_FOUND", Action: "refreshParent", Message: "dbo.VariaNoSuchTable no longer exists." }, Facts.Count: 0 } && goneDatabase.Error?.Code == "NOT_FOUND"
            && wrongKind.Error?.Code == "NOT_FOUND", "a missing object, a missing database and an object of another kind are NOT_FOUND values");

        options.TestDelay = TimeSpan.FromSeconds(3);
        options.PeekBudget = TimeSpan.FromMilliseconds(400);
        try
        {
            var slow = await Peek(service, connectionId, objects, json);
            check(slow is { Error: { Code: "TIMEOUT", Retryable: true }, Facts.Count: 0 } && slow.ElapsedMs < 2500 && service.Explorer.RunningCount == 0,
                "a peek past its budget is a TIMEOUT value, and unregisters (" + slow.ElapsedMs + " ms)");
        }
        finally { options.TestDelay = null; options.PeekBudget = null; }
    }

    /// <summary>The name with every letter's case swapped, so it differs from the original in every letter.</summary>
    private static string Recased(string name) => string.Concat(name.Select(c => char.IsUpper(c) ? char.ToLowerInvariant(c) : char.ToUpperInvariant(c)));

    /// <summary>Makes ScratchAsync's hostile-named fixtures. Those that rest on how the server is set up are made apart from the
    /// main batch, and only where a probe shows the server can make them: once a batch fails its later fixtures never run, and
    /// the checks after it fail with misleading messages. VC names T with the database spelled in another case, which CREATE
    /// VIEW resolves at once (it fails where database names compare by case); PL names T through @@SERVERNAME, which is NULL
    /// on a server whose local name was dropped, and EXEC of a NULL text succeeds without making anything.</summary>
    internal static async Task<(SqlRun Created, bool Caseless, bool Named)> CreateFixturesAsync(string database, Func<string, string, Task<SqlRun>> sql)
    {
        var created = await sql("CREATE SCHEMA [Peek]]'Ü];\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[T]]'表] (Id int NOT NULL CONSTRAINT PK_PeekT PRIMARY KEY CLUSTERED, Name nvarchar(50) NULL, Notes nvarchar(max) NULL) WITH (DATA_COMPRESSION = PAGE);\n"
            + "CREATE INDEX IX_PeekT_Name ON [Peek]]'Ü].[T]]'表] (Name);\n"
            + "INSERT [Peek]]'Ü].[T]]'表] (Id, Name, Notes) VALUES (1, N'a', REPLICATE(CONVERT(nvarchar(max), N'x'), 10000)), (2, N'b', NULL), (3, N'c', NULL);\nGO\n"
            + "CREATE PROCEDURE [Peek]]'Ü].[P]]'表] WITH RECOMPILE, EXECUTE AS OWNER AS SELECT 1;\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[Child] (Id int NOT NULL PRIMARY KEY, ParentId int NULL CONSTRAINT FK_PeekChild REFERENCES [Peek]]'Ü].[T]]'表] (Id));\nGO\n"
            + "CREATE VIEW [Peek]]'Ü].[V]]'表] AS SELECT Id, Name FROM [Peek]]'Ü].[T]]'表];\nGO\n"
            + "CREATE FUNCTION [Peek]]'Ü].[F] () RETURNS TABLE AS RETURN SELECT 1 AS one;\nGO\n"
            + "CREATE VIEW [Peek]]'Ü].[VF] AS SELECT f.one, t.Id FROM [Peek]]'Ü].[F]() AS f CROSS JOIN [" + database.Replace("]", "]]") + "].[Peek]]'Ü].[T]]'表] AS t;\nGO\n"
            // T named both ways in one view: SQL Server resolves each to T, so it lists T once with no database.
            + "CREATE VIEW [Peek]]'Ü].[VB] AS SELECT a.Id FROM [Peek]]'Ü].[T]]'表] AS a JOIN [" + database.Replace("]", "]]") + "].[Peek]]'Ü].[T]]'表] AS b ON b.Id = a.Id;\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[Blob] (Id int NOT NULL PRIMARY KEY, B varbinary(max) NULL);\nINSERT [Peek]]'Ü].[Blob] (Id, B) VALUES (1, CONVERT(varbinary(max), REPLICATE(CONVERT(varchar(max), 'ab'), 1000000)));\nGO\n", database);
        var caseless = (await sql("SELECT CASE WHEN DB_ID(N'" + Recased(database).Replace("'", "''") + "') = DB_ID(N'" + database.Replace("'", "''") + "') THEN 1 ELSE 0 END;", "master")).Scalar == "1";
        var named = (await sql("SELECT CASE WHEN @@SERVERNAME IS NULL THEN 0 ELSE 1 END;", "master")).Scalar == "1";
        if (created.Status != "completed") return (created, caseless, named);
        if (caseless)
        {
            var recased = await sql("CREATE VIEW [Peek]]'Ü].[VC] AS SELECT t.Id FROM [" + Recased(database).Replace("]", "]]") + "].[Peek]]'Ü].[T]]'表] AS t;\n", database);
            if (recased.Status != "completed") return (recased, caseless, named);
        }
        if (named)
        {
            // T named through the local server's own name (built on the server, which alone knows @@SERVERNAME): resolved too,
            // so it lists with no server and no database.
            var loopback = await sql("DECLARE @loopback nvarchar(max) = N'CREATE PROCEDURE [Peek]]''Ü].[PL] AS SELECT Id FROM ' + QUOTENAME(@@SERVERNAME) + N'.' + QUOTENAME(DB_NAME()) + N'.[Peek]]''Ü].[T]]''表];';\n"
                + "EXEC (@loopback);\n", database);
            if (loopback.Status != "completed") return (loopback, caseless, named);
        }
        return (created, caseless, named);
    }

    public static async Task ScratchAsync(Action<bool, string> check, SqlService service, string connectionId, string database, int major, Func<string, string, Task<SqlRun>> sql,
        JsonSerializerOptions json, Func<Task<string>> memoryOptimized, Func<Task> dropMemoryOptimized, Func<string, string> ownLogin)
    {
        await KindsAsync(check, service, connectionId, database, major, sql, json, ownLogin("peek"), ownLogin("peeku"));
        await LongDefinitionAsync(check, service, connectionId, database, sql, json);
        try { await MemoryOptimizedAsync(check, service, connectionId, sql, json, memoryOptimized); }
        finally { await dropMemoryOptimized(); }
        // Hostile names, dropped afterwards so the fixture checks that follow see the database as the fixtures made it.
        const string schema = "Peek]'Ü";
        var (created, caseless, named) = await CreateFixturesAsync(database, sql);
        if (!caseless) Console.WriteLine("Peek's database-name case check skipped: this server compares database names case-sensitively.");
        if (!named) Console.WriteLine("Peek's local server name check skipped: this server has no local name (@@SERVERNAME is NULL).");
        try
        {
            check(created.Status == "completed", "the peek fixtures are created: " + created.Error);
            ObjectRefDto Ref(string kind, string owner, string name) => new(kind, database, owner, name);
            var table = await Peek(service, connectionId, Ref("table", schema, "T]'表"), json);
            var facts = table.Facts;
            check(table is { Error: null, Definition: null } && facts["schema"] as string == schema && facts["rowCount"] is 3L && facts["compression"] as string == "PAGE"
                && facts["systemObject"] is false && facts["memoryOptimized"] is false && facts["replicated"] is false && facts["partitioned"] is false && facts["filegroup"] as string == "PRIMARY"
                && facts["textFilegroup"] as string == "PRIMARY" && facts["dataSpace"] is long data && data > 0 && facts["indexSpace"] is long index && index > 0
                && (major < 13 || facts["temporal"] as string == "NON_TEMPORAL_TABLE") && (major < 16 || facts["ledger"] as string == "NON_LEDGER_TABLE"),
                "a hostile-named table peeks with its row count, compression, filegroups and space: " + JsonSerializer.Serialize(facts));
            var procedure = await Peek(service, connectionId, Ref("procedure", schema, "P]'表"), json);
            check(procedure is { Error: null, Definition: { } text } && text.StartsWith("CREATE PROCEDURE", StringComparison.Ordinal) && procedure.Facts["executeAs"] as string == "OWNER"
                && procedure.Facts["recompile"] is true && procedure.Facts["nativelyCompiled"] is false && procedure.Facts["ansiNulls"] is true && procedure.Facts["quotedIdentifier"] is true,
                "a hostile-named procedure peeks with its text, EXECUTE AS OWNER and WITH RECOMPILE");

            var orders = await Peek(service, connectionId, Ref("procedure", "Sales", "usp_Orders"), json);
            var secret = await Peek(service, connectionId, Ref("procedure", "dbo", "usp_Secret"), json);
            check(orders is { Error: null, Definition: { } ordersText } && ordersText.Contains("CREATE PROCEDURE Sales.usp_Orders", StringComparison.Ordinal) && orders.Facts["executeAs"] as string == "CALLER"
                && secret is { Error: null, Definition: null } && secret.Facts["executeAs"] as string == "CALLER",
                "a procedure runs as CALLER by default, and an encrypted one peeks without its text");
            var totals = await Peek(service, connectionId, Ref("view", "dbo", "vOrderTotals"), json);
            var customers = await Peek(service, connectionId, Ref("view", "dbo", "vCustomers"), json);
            check(totals is { Error: null, Definition: { } viewText } && viewText.StartsWith("CREATE VIEW dbo.vOrderTotals", StringComparison.Ordinal) && totals.Facts["schemaBound"] is true
                && totals.Facts["indexed"] is true && customers.Facts["schemaBound"] is false && customers.Facts["indexed"] is false, "views say whether they are schema bound and indexed");
            var kinds = new List<string?>();
            foreach (var name in new[] { "fn_Scalar", "fn_Inline", "fn_Multi" }) kinds.Add((await Peek(service, connectionId, Ref("function", "dbo", name), json)).Facts["functionType"] as string);
            var policy = await Peek(service, connectionId, Ref("function", "dbo", "fn_Policy"), json);
            check(kinds.SequenceEqual(["Scalar-valued", "Inline table-valued", "Multi-statement table-valued"]) && policy.Facts["schemaBound"] is true && policy.Facts["nullOnNullInput"] is false
                && policy.Facts["executeAs"] is null, "functions say their type in SSMS's words; an inline function is schema bound and has no EXECUTE AS: " + string.Join(", ", kinds));
            var invoices = await Peek(service, connectionId, Ref("table", "Sales", "Invoices"), json);
            var heap = await Peek(service, connectionId, Ref("table", "Odd]Schema", "t"), json);
            check((major < 13 || invoices.Facts["temporal"] as string == "SYSTEM_VERSIONED_TEMPORAL_TABLE") && heap is { Error: null } && heap.Facts["rowCount"] is 0L && heap.Facts["indexSpace"] is 0L
                && heap.Facts["compression"] as string == "NONE" && heap.Facts["textFilegroup"] is null,
                "a temporal table says so, and an empty heap has no rows, no index space and no text filegroup: " + JsonSerializer.Serialize(heap.Facts));

            static string Names(IEnumerable<PeekDependency>? items) => string.Join(", ", (items ?? []).Select(item => item.Database + "." + item.Schema + "." + item.Name + ":" + item.Kind + ":" + item.Subtype + (item.ForeignKey is true ? ":fk" : "")));
            var tableUses = await Dependencies(service, connectionId, Ref("table", schema, "T]'表"), json);
            var view = await Dependencies(service, connectionId, Ref("view", schema, "V]'表"), json);
            var child = await Dependencies(service, connectionId, Ref("table", schema, "Child"), json);
            var procedureUses = await Dependencies(service, connectionId, Ref("procedure", schema, "P]'表"), json);
            var gone = await Dependencies(service, connectionId, Ref("view", schema, "NoSuchView"), json);
            var viewOfFunction = await Dependencies(service, connectionId, Ref("view", schema, "VF"), json);
            check(viewOfFunction is { Error: null } && viewOfFunction.Uses.Any(item => item is { Name: "F", Kind: "function", Subtype: "inline", Database: null })
                && viewOfFunction.Uses.Any(item => item is { Name: "T]'表", Kind: "table", Subtype: null, Database: null, Server: null }),
                "a dependency carries the subtype the tree gives it, and a reference naming its own database is resolved to the object, with no database: " + Names(viewOfFunction.Uses));
            var bothWays = await Dependencies(service, connectionId, Ref("view", schema, "VB"), json);
            check(bothWays is { Error: null } && bothWays.Uses.Count(item => item.Name == "T]'表") == 1 && bothWays.Uses.Any(item => item is { Name: "T]'表", Kind: "table", Database: null }),
                "a table named both with and without its database lists once: " + Names(bothWays.Uses));
            if (named)
            {
                var loopback = await Dependencies(service, connectionId, Ref("procedure", schema, "PL"), json);
                check(loopback is { Error: null } && loopback.Uses.Count == 1 && loopback.Uses.Any(item => item is { Name: "T]'表", Kind: "table", Database: null, Server: null }),
                    "a table named through the local server's own name is resolved with no server or database: " + (loopback.Error?.Message ?? Names(loopback.Uses)));
            }
            if (caseless)
            {
                // Followed as the page follows a dependency: in its own database, or the one it was listed in when it names none.
                var otherCase = await Dependencies(service, connectionId, Ref("view", schema, "VC"), json);
                var target = otherCase.Uses.FirstOrDefault();
                var followed = target is { Kind: { } kind, Schema: { } owner } ? await Peek(service, connectionId, new ObjectRefDto(kind, target.Database ?? database, owner, target.Name), json) : null;
                check(otherCase is { Error: null, Uses.Count: 1 } && target is { Name: "T]'表", Kind: "table", Database: null, Server: null } && followed is { Error: null } && followed.Facts["rowCount"] is 3L,
                    "a table named with its database spelled in another case is resolved with no database, and following it peeks the table: " + Names(otherCase.Uses) + " " + followed?.Error?.Message);
            }
            check(tableUses is { Error: null } && gone is { Error.Code: "NOT_FOUND" } && tableUses.UsedBy is { } usedBy && usedBy.Any(item => item is { Name: "V]'表", Kind: "view", ForeignKey: null } && item.Schema == schema)
                && usedBy.Any(item => item is { Name: "Child", Kind: "table", ForeignKey: true }) && tableUses.UsesTruncated is null && tableUses.UsedByTruncated is null
                && view.Uses is { } viewUses && viewUses.Any(item => item is { Name: "T]'表", Kind: "table", Database: null, Server: null } && item.Schema == schema)
                && child.Uses is { } childUses && childUses.Any(item => item is { Name: "T]'表", Kind: "table", ForeignKey: true }) && procedureUses.Uses is { Count: 0 },
                "dependencies list a view's table, a foreign key's table each way, and what uses a table, under hostile names, and a missing object's are NOT_FOUND: " + Names(tableUses.UsedBy) + " | " + Names(view.Uses) + " | " + Names(child.Uses));

            service.Explorer.Options.ForcePerDatabaseScope = true;
            var perDatabase = await Peek(service, connectionId, Ref("table", schema, "T]'表"), json);
            var perDatabaseUses = await Dependencies(service, connectionId, Ref("table", schema, "T]'表"), json);
            service.Explorer.Options.ForcePerDatabaseScope = false;
            check(perDatabase is { Error: null } && perDatabase.Facts["rowCount"] is 3L && perDatabaseUses.UsedBy is { Count: > 0 },
                "the per-database strategy peeks the scratch database too, with its dependencies");

            // A user with VIEW DEFINITION but not db_owner reads the facts batch, and is refused only the dependencies one
            // (sys.sql_expression_dependencies), which is why that is a request of its own.
            const string asLow = "EXECUTE AS USER = N'peek_low';\nDECLARE @object_schema sysname = N'Peek]''Ü', @object_name sysname = N'T]''表', @take int = 11;\nBEGIN TRY\n";
            const string revert = "END TRY\nBEGIN CATCH\nREVERT;\nTHROW;\nEND CATCH;\nREVERT;\n";
            var granted = await sql("CREATE USER [peek_low] WITHOUT LOGIN;\nGRANT VIEW DEFINITION TO [peek_low];\n", database);
            var band = Math.Min(major, ExplorerCatalog.MaxBand);
            var lowFacts = await sql(asLow + PeekSql.Render(ExplorerCatalog.Current.Peek.Kinds["table"], new SqlRender(band), ExplorerCatalog.Current.Peek.DefinitionPageChars).Text + revert, database);
            var lowDependencies = await sql(asLow + PeekSql.Dependencies("table", new SqlRender(band)) + revert, database);
            check(granted.Status == "completed" && lowFacts.Status == "completed" && lowDependencies.Status != "completed" && lowDependencies.Error is { } refused && refused.Contains("sql_expression_dependencies", StringComparison.Ordinal),
                "a user who is not db_owner reads Peek's facts batch, and only the dependencies batch is refused: " + (lowFacts.Error ?? lowDependencies.Error ?? lowDependencies.Status));

            // A user allowed the dependencies but not T itself: SQL Server resolved both of VB's references to T, so they still list
            // once with no database, though sys.all_objects hides T's names and type from this user.
            var hidden = await sql("CREATE USER [peek_dep] WITHOUT LOGIN;\nGRANT VIEW DEFINITION TO [peek_dep];\nGRANT SELECT ON sys.sql_expression_dependencies TO [peek_dep];\n"
                + "DENY VIEW DEFINITION ON OBJECT::[Peek]]'Ü].[T]]'表] TO [peek_dep];\n", database);
            var hiddenUses = await sql("EXECUTE AS USER = N'peek_dep';\nDECLARE @object_schema sysname = N'Peek]''Ü', @object_name sysname = N'VB', @take int = 11;\nBEGIN TRY\n"
                + PeekSql.Dependencies("view", new SqlRender(band)) + revert, database);
            var hiddenRows = hiddenUses.Sets.Count > 1 ? hiddenUses.Sets[1].Where(row => row[3] == "T]'表").ToList() : [];
            check(hidden.Status == "completed" && hiddenUses.Status == "completed" && hiddenRows is [[null, null, "Peek]'Ü", _, null, ..]],
                "a resolved reference to a table hidden from the user lists once with no server or database: " + (hidden.Error ?? hiddenUses.Error ?? JsonSerializer.Serialize(hiddenRows)));
        }
        finally
        {
            await sql("DROP USER IF EXISTS [peek_dep];\nDROP USER IF EXISTS [peek_low];\n", database);
            var dropped = await sql("DROP VIEW IF EXISTS [Peek]]'Ü].[VC];\nDROP VIEW IF EXISTS [Peek]]'Ü].[VB];\nDROP PROCEDURE IF EXISTS [Peek]]'Ü].[PL];\nDROP VIEW IF EXISTS [Peek]]'Ü].[VF];\nDROP FUNCTION IF EXISTS [Peek]]'Ü].[F];\nDROP TABLE IF EXISTS [Peek]]'Ü].[Blob];\nDROP VIEW IF EXISTS [Peek]]'Ü].[V]]'表];\nDROP TABLE IF EXISTS [Peek]]'Ü].[Child];\nDROP PROCEDURE IF EXISTS [Peek]]'Ü].[P]]'表];\nDROP TABLE IF EXISTS [Peek]]'Ü].[T]]'表];\nDROP SCHEMA IF EXISTS [Peek]]'Ü];\n", database);
            check(dropped.Status == "completed", "the peek fixtures are dropped: " + dropped.Error);
        }
    }

    /// <summary>The kinds beyond modules (P4) on hostile-named objects in the scratch database: an index with key, descending
    /// and included columns, a filter and options, and its usage; a DML trigger with its events and text, and a disabled
    /// database trigger; a synonym of a local table (followed) and of a remote one; a sequence a default uses; an alias type
    /// and a table type a procedure takes; the scratch database with its files; and a scratch login with a server role, a
    /// denied connect and a user in the scratch database. Usage is refused alone to a user who may not read server state.
    /// Every object is dropped in finally; the login is also the scratch database's to drop.</summary>
    internal static async Task KindsAsync(Action<bool, string> check, SqlService service, string connectionId, string database, int major, Func<string, string, Task<SqlRun>> sql,
        JsonSerializerOptions json, string login, string usageLogin)
    {
        const string schema = "Pk4]'Ü";
        const string s = "[Pk4]]'Ü]";
        static bool Bit(string? value) => value is "1" or "True" or "true";
        var created = await sql("CREATE SCHEMA " + s + ";\nGO\n"
            + "CREATE TABLE " + s + ".[T]]'表] (Id int NOT NULL CONSTRAINT [PK]]'表] PRIMARY KEY CLUSTERED, Name nvarchar(50) NULL, Amount decimal(9, 2) NULL);\n"
            + "CREATE UNIQUE INDEX [IX]]'表] ON " + s + ".[T]]'表] (Name DESC, Id) INCLUDE (Amount) WHERE Name IS NOT NULL WITH (FILLFACTOR = 80, PAD_INDEX = ON);\n"
            + "INSERT " + s + ".[T]]'表] (Id, Name, Amount) VALUES (1, N'a', 1.5), (2, N'b', NULL), (3, NULL, NULL);\nGO\n"
            + "CREATE SEQUENCE " + s + ".[S]]'表] AS bigint START WITH 10 INCREMENT BY 5 MINVALUE 10 MAXVALUE 1000 CYCLE CACHE 20;\nGO\n"
            + "CREATE TABLE " + s + ".[UsesS] (Id bigint NOT NULL CONSTRAINT [DF_Pk4S] DEFAULT (NEXT VALUE FOR " + s + ".[S]]'表]));\nGO\n"
            + "CREATE TRIGGER " + s + ".[TR]]'表] ON " + s + ".[T]]'表] AFTER INSERT, UPDATE AS SET NOCOUNT ON; SELECT COUNT(*) FROM " + s + ".[UsesS];\nGO\n"
            + "CREATE TRIGGER [DTR]]'表] ON DATABASE FOR CREATE_TABLE, DROP_TABLE AS SET NOCOUNT ON;\nGO\nDISABLE TRIGGER [DTR]]'表] ON DATABASE;\nGO\n"
            + "CREATE SYNONYM " + s + ".[SY]]'表] FOR " + s + ".[T]]'表];\nCREATE SYNONYM " + s + ".[SYR] FOR [Remote]]Srv].[Db].[dbo].[X];\nGO\n"
            + "CREATE TYPE " + s + ".[AT]]'表] FROM nvarchar(20) NOT NULL;\nGO\nCREATE TYPE " + s + ".[TT]]'表] AS TABLE (Id int NOT NULL PRIMARY KEY, Name nvarchar(10) NULL, Phone " + s + ".[AT]]'表] NULL);\nGO\n"
            + "CREATE PROCEDURE " + s + ".[UsesTypes] @a " + s + ".[AT]]'表], @t " + s + ".[TT]]'表] READONLY AS SELECT 1;\nGO\n"
            + "SELECT NEXT VALUE FOR " + s + ".[S]]'表];\nGO\n", database);
        // The scratch login: random password (never printed), a server role, CONNECT SQL denied, and a hostile-named user here.
        var password = "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
        var bracketed = "[" + login.Replace("]", "]]") + "]";
        var usageBracketed = "[" + usageLogin.Replace("]", "]]") + "]";
        var madeLogin = await sql("CREATE LOGIN " + bracketed + " WITH PASSWORD = N'" + password + "', CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];\n"
            + "ALTER SERVER ROLE [dbcreator] ADD MEMBER " + bracketed + ";\nDENY CONNECT SQL TO " + bracketed + ";\nALTER LOGIN " + bracketed + " DISABLE;\n", "master");
        var mapped = madeLogin.Status == "completed" ? await sql("CREATE USER [U]]'表] FOR LOGIN " + bracketed + " WITH DEFAULT_SCHEMA = " + s + ";\n", database) : madeLogin;
        try
        {
            check(created.Status == "completed" && mapped.Status == "completed", "the P4 peek fixtures and the scratch login are created: " + (created.Error ?? mapped.Error));
            ObjectRefDto Child(string kind, string parent, string name, string parentKind = "table") => new(kind, database, null, name, new ParentRefDto(parentKind, schema, parent));
            ObjectRefDto Own(string kind, string name) => new(kind, database, schema, name);
            string Facts(PeekResult peek) => peek.Error?.Message ?? JsonSerializer.Serialize(peek.Facts);

            // Index.
            var index = await Peek(service, connectionId, Child("index", "T]'表", "IX]'表"), json);
            var f = index.Facts;
            var columns = index.Lists?.GetValueOrDefault("indexColumns")?.Rows ?? [];
            check(index is { Error: null, Definition: null, Refused: null } && f["indexType"] as string == "Nonclustered" && f["unique"] is true && f["primaryKey"] is false
                && f["filter"] as string == "([Name] IS NOT NULL)" && f["fillFactor"] is 80L && f["padIndex"] is true && f["rowCount"] is 2L && f["filegroup"] as string == "PRIMARY"
                && f["partitions"] is 1L && f["compression"] as string == "NONE" && (major < 15 ? !f.ContainsKey("optimizeForSequentialKey") : f["optimizeForSequentialKey"] is false)
                && f["userUpdates"] is long updates && updates >= 1 && f.ContainsKey("lastSeek")
                && columns.Count == 3 && columns[0] is ["Name", false, true, string nameType] && nameType.StartsWith("nvarchar", StringComparison.Ordinal)
                && columns[1] is ["Id", false, false, "int"] && columns[2] is ["Amount", true, false, string amountType] && amountType.StartsWith("decimal", StringComparison.Ordinal),
                "a hostile-named filtered unique index peeks with its type, filter, options, storage and usage, and its key, descending and included columns: "
                + Facts(index) + " " + JsonSerializer.Serialize(columns));
            var primary = await Peek(service, connectionId, Child("index", "T]'表", "PK]'表"), json);
            check(primary is { Error: null } && primary.Facts["indexType"] as string == "Clustered" && primary.Facts["primaryKey"] is true && primary.Facts["filter"] is null
                && primary.Lists?["indexColumns"].Rows is [["Id", false, false, "int"]], "a primary key's clustered index says so: " + Facts(primary));
            var wrongParent = await Peek(service, connectionId, Child("index", "UsesS", "IX]'表"), json);
            check(wrongParent is { Error.Code: "NOT_FOUND" }, "an index is found only below its own table");

            // Triggers.
            var trigger = await Peek(service, connectionId, Child("trigger", "T]'表", "TR]'表"), json);
            var events = trigger.Lists?.GetValueOrDefault("events")?.Rows ?? [];
            check(trigger is { Error: null, Definition: { } triggerText } && triggerText.StartsWith("CREATE TRIGGER", StringComparison.Ordinal) && trigger.Facts["disabled"] is false
                && trigger.Facts["insteadOf"] is false && trigger.Facts["clr"] is false && trigger.Facts["executeAs"] as string == "CALLER"
                && events.Select(row => row[0] as string).Order(StringComparer.Ordinal).SequenceEqual(["INSERT", "UPDATE"]) && events.All(row => row[1] is false && row[2] is false),
                "a hostile-named DML trigger peeks with its text, options and events: " + Facts(trigger) + " " + JsonSerializer.Serialize(events));
            var triggerUses = await Dependencies(service, connectionId, Child("trigger", "T]'表", "TR]'表"), json);
            check(triggerUses is { Error: null } && triggerUses.Uses.Any(item => item is { Name: "UsesS", Kind: "table", Database: null } && item.Schema == schema),
                "a trigger's dependencies list the table its code reads: " + (triggerUses.Error?.Message ?? string.Join(", ", triggerUses.Uses.Select(item => item.Name))));
            var databaseTrigger = await Peek(service, connectionId, new ObjectRefDto("databaseTrigger", database, null, "DTR]'表"), json);
            var ddl = databaseTrigger.Lists?.GetValueOrDefault("events")?.Rows ?? [];
            check(databaseTrigger is { Error: null, Definition: { } ddlText } && ddlText.Contains("ON DATABASE", StringComparison.Ordinal) && databaseTrigger.Facts["disabled"] is true
                && ddl.Select(row => row[0] as string).Order(StringComparer.Ordinal).SequenceEqual(["CREATE_TABLE", "DROP_TABLE"]),
                "a disabled hostile-named database trigger peeks with its text and DDL events: " + Facts(databaseTrigger) + " " + JsonSerializer.Serialize(ddl));

            // Synonyms, followed to their base as the card follows a dependency.
            var synonym = await Peek(service, connectionId, Own("synonym", "SY]'表"), json);
            var synonymUses = await Dependencies(service, connectionId, Own("synonym", "SY]'表"), json);
            var baseObject = synonymUses.Uses.FirstOrDefault();
            var followed = baseObject is { Kind: { } baseKind, Schema: { } baseSchema, Database: null, Server: null } ? await Peek(service, connectionId, new ObjectRefDto(baseKind, database, baseSchema, baseObject.Name), json) : null;
            check(synonym is { Error: null, Definition: null } && synonym.Facts["schema"] as string == schema && synonym.Facts["baseObject"] as string == "[Pk4]]'Ü].[T]]'表]"
                && synonym.Facts["baseName"] as string == "T]'表" && synonym.Facts["baseSchema"] as string == schema && synonym.Facts["baseServer"] is null
                && synonymUses is { Error: null, Uses.Count: 1 } && baseObject is { Name: "T]'表", Kind: "table" } && followed is { Error: null } && followed.Facts["rowCount"] is 3L,
                "a hostile-named synonym peeks with its base object's parts, and its dependency is the table, which peeks when followed: " + Facts(synonym) + " " + followed?.Error?.Message);
            var remote = await Dependencies(service, connectionId, Own("synonym", "SYR"), json);
            var remoteFacts = await Peek(service, connectionId, Own("synonym", "SYR"), json);
            check(remote is { Error: null, Uses: [{ Server: "Remote]Srv", Database: "Db", Schema: "dbo", Name: "X" }] } && remoteFacts.Facts["baseServer"] as string == "Remote]Srv"
                && remoteFacts.Facts["baseDatabase"] as string == "Db", "a synonym of a remote object lists the parts it names, which the card does not follow: " + Facts(remoteFacts));

            // Sequence.
            var sequence = await Peek(service, connectionId, Own("sequence", "S]'表"), json);
            var sf = sequence.Facts;
            var sequenceUses = await Dependencies(service, connectionId, Own("sequence", "S]'表"), json);
            check(sequence is { Error: null, Definition: null } && sf["dataType"] as string == "bigint" && sf["startValue"] as string == "10" && sf["increment"] as string == "5"
                && sf["minimum"] as string == "10" && sf["maximum"] as string == "1000" && sf["cycle"] is true && sf["cache"] as string == "20" && sf["currentValue"] as string == "10"
                && (major < 14 ? !sf.ContainsKey("lastUsedValue") : sf["lastUsedValue"] as string == "10") && sf["exhausted"] is false
                && sequenceUses is { Error: null } && sequenceUses.UsedBy.Count > 0,
                "a hostile-named sequence peeks with its type, bounds, cycle, cache and current value, and lists the default that uses it: " + Facts(sequence) + " "
                + (sequenceUses.Error?.Message ?? string.Join(", ", sequenceUses.UsedBy.Select(item => item.Name))));

            // Types.
            var alias = await Peek(service, connectionId, Own("type", "AT]'表"), json);
            var aliasUses = await Dependencies(service, connectionId, Own("type", "AT]'表"), json);
            check(alias is { Error: null } && alias.Facts["schema"] as string == schema && alias.Facts["baseType"] as string == "nvarchar(20)" && alias.Facts["allowNulls"] is false
                && alias.Facts["maxLength"] is 40L && alias.Facts["default"] is null && aliasUses is { Error: null, Uses.Count: 0 } && aliasUses.UsedBy.Any(item => item is { Name: "UsesTypes", Kind: "procedure" })
                && aliasUses.UsedBy.Any(item => item is { Name: "TT]'表", Kind: "tableType" } && item.Schema == schema) && !aliasUses.UsedBy.Any(item => item.Name.StartsWith("TT_", StringComparison.Ordinal)),
                "a hostile-named alias type peeks with its base type and nullability, uses nothing, and is used by the procedure that takes it and the table type with a column of it: "
                + Facts(alias) + " " + string.Join(", ", aliasUses.UsedBy.Select(item => item.Name)));
            var tableType = await Peek(service, connectionId, Own("tableType", "TT]'表"), json);
            var tableTypeUses = await Dependencies(service, connectionId, Own("tableType", "TT]'表"), json);
            check(tableType is { Error: null } && tableType.Facts["memoryOptimized"] is false && tableType.Facts["schema"] as string == schema
                && tableTypeUses.UsedBy.Any(item => item is { Name: "UsesTypes", Kind: "procedure" }) && !tableTypeUses.UsedBy.Any(item => item.Name.StartsWith("TT_", StringComparison.Ordinal)),
                "a hostile-named table type peeks, and lists the procedure that takes it but not its own table object: " + Facts(tableType));

            // The scratch database, read on the server.
            var scratch = await Peek(service, connectionId, new ObjectRefDto("database", null, null, database), json);
            var files = scratch.Lists?.GetValueOrDefault("files")?.Rows ?? [];
            check(scratch is { Error: null, Definition: null } && scratch.Facts["status"] as string == "ONLINE" && scratch.Facts["size"] is long size && size > 0
                && scratch.Facts["compatibilityLevel"] is long && scratch.Facts["recoveryModel"] is string && files.Any(row => row[1] as string == "ROWS") && files.Any(row => row[1] as string == "LOG")
                && files.All(row => row[2] is long fileSize && fileSize > 0 && row[3] is string { Length: > 0 } && row[4] is string { Length: > 0 }),
                "the scratch database peeks on the server with its status, size and options, and its data and log files: " + Facts(scratch) + " " + JsonSerializer.Serialize(files.Select(row => row[1])));

            // The scratch login.
            var peekLogin = await Peek(service, connectionId, new ObjectRefDto("login", null, null, login), json);
            var roles = peekLogin.Lists?.GetValueOrDefault("serverRoles")?.Rows ?? [];
            var mapping = peekLogin.Lists?.GetValueOrDefault("userMapping");
            check(peekLogin is { Error: null, Definition: null } && peekLogin.Facts["loginType"] as string == "SQL Server authentication" && peekLogin.Facts["disabled"] is true
                && peekLogin.Facts["connectDenied"] is true && peekLogin.Facts["enforcePolicy"] is false && peekLogin.Facts["defaultDatabase"] as string == "master"
                && roles.Any(row => row is ["dbcreator", true]) && mapping is { } map && map.Rows.Any(row => row[0] as string == database && row[1] as string == "U]'表" && row[2] as string == schema)
                && map.Rows.Count(row => row[0] as string == database) == 1,
                "a scratch login peeks with its type, status, server role and its hostile-named user in the scratch database, read without LOGINPROPERTY: " + Facts(peekLogin) + " "
                + JsonSerializer.Serialize(roles) + " " + JsonSerializer.Serialize(mapping?.Rows.Where(row => row[0] as string == database)));
            // Out of User mapping's time: every database it would read is unread, and the facts and roles are kept.
            service.Explorer.Options.PeekMappingBudget = TimeSpan.Zero;
            PeekResult lateLogin;
            try { lateLogin = await Peek(service, connectionId, new ObjectRefDto("login", null, null, login), json); }
            finally { service.Explorer.Options.PeekMappingBudget = null; }
            check(lateLogin is { Error: null } && lateLogin.Facts["disabled"] is true && lateLogin.Lists?.GetValueOrDefault("serverRoles")?.Rows.Count > 0
                && lateLogin.Lists?.GetValueOrDefault("userMapping") is { Rows.Count: 0, Unread: > 0 },
                "a login whose User mapping runs out of time keeps its facts and counts the databases unread: " + JsonSerializer.Serialize(lateLogin.Lists?.GetValueOrDefault("userMapping")?.Unread));
            var missingLogin = await Peek(service, connectionId, new ObjectRefDto("login", null, null, login + "_gone"), json);
            var missingDatabase = await Peek(service, connectionId, new ObjectRefDto("database", null, null, database + "_gone"), json);
            check(missingLogin is { Error.Code: "NOT_FOUND" } && missingDatabase is { Error.Code: "NOT_FOUND" }, "a missing login and a missing database are NOT_FOUND values");

            // The per-database strategy reads children and server objects too.
            service.Explorer.Options.ForcePerDatabaseScope = true;
            var perDatabase = await Peek(service, connectionId, Child("index", "T]'表", "IX]'表"), json);
            var perDatabaseLogin = await Peek(service, connectionId, new ObjectRefDto("login", null, null, login), json);
            service.Explorer.Options.ForcePerDatabaseScope = false;
            check(perDatabase is { Error: null } && perDatabase.Facts["unique"] is true && perDatabaseLogin is { Error: null } && perDatabaseLogin.Facts["disabled"] is true,
                "the per-database strategy peeks an index and a login too");

            // Usage refused alone: a login that may not read server state (impersonated as a login, since a user without one is
            // refused every server-scoped view with 15562 instead) gets the index's other facts and lists, and a refused row.
            var band = Math.Min(major, ExplorerCatalog.MaxBand);
            var batch = PeekSql.Render(ExplorerCatalog.Current.Peek.Kinds["index"], new SqlRender(band), ExplorerCatalog.Current.Peek.DefinitionPageChars, "table");
            var usagePassword = "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
            var madeUsage = await sql("CREATE LOGIN " + usageBracketed + " WITH PASSWORD = N'" + usagePassword + "', CHECK_POLICY = OFF;\n", "master");
            var granted = madeUsage.Status == "completed" ? await sql("CREATE USER [peek_usage] FOR LOGIN " + usageBracketed + ";\nGRANT VIEW DEFINITION TO [peek_usage];\n", database) : madeUsage;
            var refused = await sql("EXECUTE AS LOGIN = N'" + usageLogin.Replace("'", "''") + "';\nDECLARE @object_schema sysname = N'Pk4]''Ü', @object_name sysname = N'T]''表', @k1 sysname = N'IX]''表', @take int = 1025;\n"
                + "BEGIN TRY\n" + batch.Text + "END TRY\nBEGIN CATCH\nREVERT;\nTHROW;\nEND CATCH;\nREVERT;\n", database);
            var last = refused.Sets.Count > 0 && refused.Sets[^1].Count == 1 ? refused.Sets[^1][0] : null;
            check(granted.Status == "completed" && refused.Status == "completed" && refused.Sets.Count == 4 && refused.Sets[1].Count == 1 && refused.Sets[2].Count == 3
                && last is [var flag] && Bit(flag),
                "a login without VIEW SERVER STATE reads the index's facts and columns, and its usage statement answers one refused column: "
                + (granted.Error ?? refused.Error ?? JsonSerializer.Serialize(refused.Sets.Select(set => set.Count))));
        }
        finally
        {
            var dropped = await sql("DROP USER IF EXISTS [peek_usage];\nDROP USER IF EXISTS [U]]'表];\nDROP PROCEDURE IF EXISTS " + s + ".[UsesTypes];\nDROP TYPE IF EXISTS " + s + ".[TT]]'表];\n"
                + "DROP TYPE IF EXISTS " + s + ".[AT]]'表];\nDROP SYNONYM IF EXISTS " + s + ".[SYR];\nDROP SYNONYM IF EXISTS " + s + ".[SY]]'表];\n"
                + "IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'DTR]''表') DROP TRIGGER [DTR]]'表] ON DATABASE;\n"
                + "DROP TABLE IF EXISTS " + s + ".[T]]'表];\nDROP TABLE IF EXISTS " + s + ".[UsesS];\nDROP SEQUENCE IF EXISTS " + s + ".[S]]'表];\nDROP SCHEMA IF EXISTS " + s + ";\n", database);
            var droppedLogin = await sql("IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'" + login.Replace("'", "''") + "') DROP LOGIN " + bracketed + ";\n"
                + "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'" + usageLogin.Replace("'", "''") + "') DROP LOGIN " + usageBracketed + ";\n", "master");
            check(dropped.Status == "completed" && droppedLogin.Status == "completed", "the P4 peek fixtures and the scratch login are dropped: " + (dropped.Error ?? droppedLogin.Error));
        }
    }

    /// <summary>A memory-optimized table's facts, in a database of their own. (Its Top rows run through query.execute in a session of
    /// their own, under the session's READ COMMITTED, so the explorer pool's READ UNCOMMITTED never reaches them.)</summary>
    private static async Task MemoryOptimizedAsync(Action<bool, string> check, SqlService service, string connectionId, Func<string, string, Task<SqlRun>> sql, JsonSerializerOptions json,
        Func<Task<string>> create)
    {
        var database = await create();
        var made = await sql("CREATE TABLE dbo.Mo (Id int NOT NULL PRIMARY KEY NONCLUSTERED, Name nvarchar(20) NULL) WITH (MEMORY_OPTIMIZED = ON, DURABILITY = SCHEMA_ONLY);\nGO\n", database);
        check(made.Status == "completed", "the memory-optimized fixture is created: " + made.Error);
        var facts = await Peek(service, connectionId, new ObjectRefDto("table", database, "dbo", "Mo"), json);
        check(facts is { Error: null } && facts.Facts["memoryOptimized"] is true, "a memory-optimized table peeks as memory-optimized: " + facts.Error?.Message);
    }
}
