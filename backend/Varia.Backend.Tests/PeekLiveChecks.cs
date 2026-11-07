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

    private static async Task<PeekRowsResult> Rows(SqlService service, string connectionId, ObjectRefDto target, JsonSerializerOptions json) =>
        (PeekRowsResult)await service.DispatchAsync("explorer.peekRows", JsonSerializer.SerializeToElement(new PeekRowsArgs(connectionId, Guid.NewGuid().ToString(), target), json), json);

    public static async Task SystemAsync(Action<bool, string> check, SqlService service, string connectionId, int major, JsonSerializerOptions json)
    {
        var options = service.Explorer.Options;
        var objects = new ObjectRefDto("view", "master", "sys", "objects");
        var help = new ObjectRefDto("procedure", "master", "sys", "sp_help");
        var extended = new ObjectRefDto("procedure", "master", "sys", "xp_msver");
        var jobs = new ObjectRefDto("table", "msdb", "dbo", "sysjobs");
        var hex = new ObjectRefDto("function", "master", "sys", "fn_varbintohexstr");
        ObjectRefDto[] targets = [objects, help, extended, jobs, hex];
        var errors = new List<string>();
        var top = Math.Min(major, ExplorerCatalog.MaxBand);
        for (var band = ExplorerCatalog.MinBand; band <= top; band++)
        {
            options.ForceBand = band;
            foreach (var target in targets)
            {
                var peek = await Peek(service, connectionId, target, json);
                var expected = ExplorerCatalog.Current.Peek.Kinds[target.Kind].FactsFor(band).Select(fact => fact.Id);
                if (peek.Error is not null || !peek.Facts.Keys.SequenceEqual(expected)) errors.Add(target.Name + " @" + band + ": " + (peek.Error?.Message ?? string.Join(",", peek.Facts.Keys)));
            }
        }
        options.ForceBand = null;
        options.ForcePerDatabaseScope = true;
        foreach (var target in targets)
            if ((await Peek(service, connectionId, target, json)).Error is { } error) errors.Add(target.Name + " per database: " + error.Message);
        options.ForcePerDatabaseScope = false;
        check(errors.Count == 0, "Peek reads system views, procedures, extended procedures, tables and functions for bands 12-" + top + " and with a pool per database, with exactly the band's facts: "
            + string.Join(" | ", errors.Take(5)));

        var view = await Peek(service, connectionId, objects, json);
        check(view is { Error: null, Definition: { } text, DefinitionTruncated: null } && text.Contains("CREATE VIEW", StringComparison.OrdinalIgnoreCase)
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
        var function = await Peek(service, connectionId, hex, json);
        check(function is { Error: null } && function.Facts["functionType"] as string == "Scalar-valued", "a system scalar function says Scalar-valued");

        var sample = await Rows(service, connectionId, objects, json);
        check(sample is { Error: null, Rows.Count: 10, MoreColumns: null } && sample.Columns.Any(column => column is { Name: "name", Type: "nvarchar" }) && sample.Rows.All(row => row.Length == sample.Columns.Count),
            "sys.objects' top rows are 10 rows of its columns, with their names and types: " + (sample.Error?.Message ?? JsonSerializer.Serialize(sample.Columns.Take(3))));
        var noRows = await Rows(service, connectionId, new ObjectRefDto("table", "msdb", "dbo", "VariaNoSuchTable"), json);
        check(noRows is { Error.Code: "NOT_FOUND", Rows.Count: 0 }, "the top rows of a missing table are a NOT_FOUND value");

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

    public static async Task ScratchAsync(Action<bool, string> check, SqlService service, string connectionId, string database, int major, Func<string, string, Task<SqlRun>> sql,
        JsonSerializerOptions json, Func<Task<string>> memoryOptimized, Func<Task> dropMemoryOptimized)
    {
        try { await MemoryOptimizedAsync(check, service, connectionId, sql, json, memoryOptimized); }
        finally { await dropMemoryOptimized(); }
        // Hostile names, dropped afterwards so the fixture checks that follow see the database as the fixtures made it.
        const string schema = "Peek]'Ü";
        var created = await sql("CREATE SCHEMA [Peek]]'Ü];\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[T]]'表] (Id int NOT NULL CONSTRAINT PK_PeekT PRIMARY KEY CLUSTERED, Name nvarchar(50) NULL, Notes nvarchar(max) NULL) WITH (DATA_COMPRESSION = PAGE);\n"
            + "CREATE INDEX IX_PeekT_Name ON [Peek]]'Ü].[T]]'表] (Name);\n"
            + "INSERT [Peek]]'Ü].[T]]'表] (Id, Name, Notes) VALUES (1, N'a', REPLICATE(CONVERT(nvarchar(max), N'x'), 10000)), (2, N'b', NULL), (3, N'c', NULL);\nGO\n"
            + "CREATE PROCEDURE [Peek]]'Ü].[P]]'表] WITH RECOMPILE, EXECUTE AS OWNER AS SELECT 1;\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[Child] (Id int NOT NULL PRIMARY KEY, ParentId int NULL CONSTRAINT FK_PeekChild REFERENCES [Peek]]'Ü].[T]]'表] (Id));\nGO\n"
            + "CREATE VIEW [Peek]]'Ü].[V]]'表] AS SELECT Id, Name FROM [Peek]]'Ü].[T]]'表];\nGO\n"
            + "CREATE FUNCTION [Peek]]'Ü].[F] () RETURNS TABLE AS RETURN SELECT 1 AS one;\nGO\n"
            + "CREATE VIEW [Peek]]'Ü].[VF] AS SELECT f.one, t.Id FROM [Peek]]'Ü].[F]() AS f CROSS JOIN [" + database.Replace("]", "]]") + "].[Peek]]'Ü].[T]]'表] AS t;\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[Blob] (Id int NOT NULL PRIMARY KEY, B varbinary(max) NULL);\nINSERT [Peek]]'Ü].[Blob] (Id, B) VALUES (1, CONVERT(varbinary(max), REPLICATE(CONVERT(varchar(max), 'ab'), 1000000)));\nGO\n", database);
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
                && viewOfFunction.Uses.Any(item => item is { Name: "T]'表", Kind: "table", Subtype: null } && item.Database == database),
                "a dependency carries the subtype the tree gives it, and a reference naming its own database is resolved to the object: " + Names(viewOfFunction.Uses));
            check(tableUses is { Error: null } && gone is { Error.Code: "NOT_FOUND" } && tableUses.UsedBy is { } usedBy && usedBy.Any(item => item is { Name: "V]'表", Kind: "view", ForeignKey: null } && item.Schema == schema)
                && usedBy.Any(item => item is { Name: "Child", Kind: "table", ForeignKey: true }) && tableUses.UsesTruncated is null && tableUses.UsedByTruncated is null
                && view.Uses is { } viewUses && viewUses.Any(item => item is { Name: "T]'表", Kind: "table", Database: null, Server: null } && item.Schema == schema)
                && child.Uses is { } childUses && childUses.Any(item => item is { Name: "T]'表", Kind: "table", ForeignKey: true }) && procedureUses.Uses is { Count: 0 },
                "dependencies list a view's table, a foreign key's table each way, and what uses a table, under hostile names, and a missing object's are NOT_FOUND: " + Names(tableUses.UsedBy) + " | " + Names(view.Uses) + " | " + Names(child.Uses));

            var rows = await Rows(service, connectionId, Ref("table", schema, "T]'表"), json);
            var notes = rows.Rows.FirstOrDefault(row => row[0] == "1");
            check(rows is { Error: null, Rows.Count: 3, MoreColumns: null } && rows.Columns.Select(column => column.Name + " " + column.Type).SequenceEqual(["Id int", "Name nvarchar", "Notes nvarchar"])
                && notes is { } first && first[1] == "a" && first[2] is { Length: 256 } cutText && cutText.All(c => c == 'x')
                && rows.Cut is { } cut && cut.Any(cell => rows.Rows[cell[0]][0] == "1" && cell[1] == 2) && rows.Rows.Count(row => row[2] is null) == 2,
                "a hostile-named table's top rows show its values as the grid does, NULL as null, and a long value cut at 256 and marked: " + JsonSerializer.Serialize(rows.Columns));
            var blob = await Rows(service, connectionId, Ref("table", schema, "Blob"), json);
            check(blob is { Error: null, Rows.Count: 1 } && blob.Rows[0][1] is { Length: 256 } hex && hex.StartsWith("0x6162", StringComparison.Ordinal) && blob.Cut is { } blobCut && blobCut.Any(cell => cell is [0, 1]),
                "a 2 MB varbinary(max) value shows its first bytes as 0x… text, cut at 256 characters and marked: " + (blob.Error?.Message ?? blob.Rows.FirstOrDefault()?[1]?[..Math.Min(20, blob.Rows[0][1]?.Length ?? 0)]));
            var viewRows = await Rows(service, connectionId, Ref("view", schema, "V]'表"), json);
            check(viewRows is { Error: null, Rows.Count: 3 } && viewRows.Columns.Count == 2, "a hostile-named view's top rows are read too");

            service.Explorer.Options.ForcePerDatabaseScope = true;
            var perDatabase = await Peek(service, connectionId, Ref("table", schema, "T]'表"), json);
            var perDatabaseUses = await Dependencies(service, connectionId, Ref("table", schema, "T]'表"), json);
            var perDatabaseRows = await Rows(service, connectionId, Ref("table", schema, "T]'表"), json);
            service.Explorer.Options.ForcePerDatabaseScope = false;
            check(perDatabase is { Error: null } && perDatabase.Facts["rowCount"] is 3L && perDatabaseUses.UsedBy is { Count: > 0 } && perDatabaseRows is { Error: null, Rows.Count: 3 },
                "the per-database strategy peeks the scratch database too, with its dependencies and rows");

            // A user with VIEW DEFINITION but not db_owner reads the facts batch, and is refused only the dependencies one
            // (sys.sql_expression_dependencies), which is why that is a request of its own.
            const string asLow = "EXECUTE AS USER = N'peek_low';\nDECLARE @object_schema sysname = N'Peek]''Ü', @object_name sysname = N'T]''表', @take int = 11;\nBEGIN TRY\n";
            const string revert = "END TRY\nBEGIN CATCH\nREVERT;\nTHROW;\nEND CATCH;\nREVERT;\n";
            var granted = await sql("CREATE USER [peek_low] WITHOUT LOGIN;\nGRANT VIEW DEFINITION TO [peek_low];\n", database);
            var band = Math.Min(major, ExplorerCatalog.MaxBand);
            var lowFacts = await sql(asLow + PeekSql.Render(ExplorerCatalog.Current.Peek.Kinds["table"], new SqlRender(band), ExplorerCatalog.Current.Peek.DefinitionChars).Text + revert, database);
            var lowDependencies = await sql(asLow + PeekSql.Dependencies("table", new SqlRender(band)) + revert, database);
            check(granted.Status == "completed" && lowFacts.Status == "completed" && lowDependencies.Status != "completed" && lowDependencies.Error is { } refused && refused.Contains("sql_expression_dependencies", StringComparison.Ordinal),
                "a user who is not db_owner reads Peek's facts batch, and only the dependencies batch is refused: " + (lowFacts.Error ?? lowDependencies.Error ?? lowDependencies.Status));
        }
        finally
        {
            await sql("DROP USER IF EXISTS [peek_low];\n", database);
            var dropped = await sql("DROP VIEW IF EXISTS [Peek]]'Ü].[VF];\nDROP FUNCTION IF EXISTS [Peek]]'Ü].[F];\nDROP TABLE IF EXISTS [Peek]]'Ü].[Blob];\nDROP VIEW IF EXISTS [Peek]]'Ü].[V]]'表];\nDROP TABLE IF EXISTS [Peek]]'Ü].[Child];\nDROP PROCEDURE IF EXISTS [Peek]]'Ü].[P]]'表];\nDROP TABLE IF EXISTS [Peek]]'Ü].[T]]'表];\nDROP SCHEMA IF EXISTS [Peek]]'Ü];\n", database);
            check(dropped.Status == "completed", "the peek fixtures are dropped: " + dropped.Error);
        }
    }

    /// <summary>A memory-optimized table's rows (read under READ COMMITTED, since memory-optimized tables refuse the explorer pool's READ UNCOMMITTED) and those
    /// of a view over it, in a database of their own, and a disk table there still read READ UNCOMMITTED (it waits on no lock).</summary>
    private static async Task MemoryOptimizedAsync(Action<bool, string> check, SqlService service, string connectionId, Func<string, string, Task<SqlRun>> sql, JsonSerializerOptions json,
        Func<Task<string>> create)
    {
        var database = await create();
        var made = await sql("CREATE TABLE dbo.Mo (Id int NOT NULL PRIMARY KEY NONCLUSTERED, Name nvarchar(20) NULL) WITH (MEMORY_OPTIMIZED = ON, DURABILITY = SCHEMA_ONLY);\nGO\n"
            + "INSERT dbo.Mo (Id, Name) VALUES (1, N'one'), (2, NULL);\nGO\nCREATE VIEW dbo.vMo AS SELECT Id, Name FROM dbo.Mo;\nGO\n"
            + "CREATE TABLE dbo.Disk (Id int NOT NULL PRIMARY KEY, Name nvarchar(20) NULL);\nINSERT dbo.Disk (Id) VALUES (1);\nGO\n", database);
        check(made.Status == "completed", "the memory-optimized fixtures are created: " + made.Error);
        var table = await Rows(service, connectionId, new ObjectRefDto("table", database, "dbo", "Mo"), json);
        var view = await Rows(service, connectionId, new ObjectRefDto("view", database, "dbo", "vMo"), json);
        var facts = await Peek(service, connectionId, new ObjectRefDto("table", database, "dbo", "Mo"), json);
        // A transaction holding an uncommitted change to the disk table's row: READ UNCOMMITTED reads past it.
        var host = (IExplorerHost)service;
        using var template = host.Connection(connectionId, null);
        var locker = new SqlConnection(new SqlConnectionStringBuilder(template.ConnectionString) { InitialCatalog = database, Pooling = false }.ConnectionString);
        await host.OpenAsync(locker, CancellationToken.None);
        await using (var hold = locker.CreateCommand())
        {
            hold.CommandText = "BEGIN TRANSACTION; UPDATE dbo.Disk SET Name = N'held';";
            await (await hold.ExecuteReaderAsync()).DisposeAsync();
        }
        PeekRowsResult disk;
        try { disk = await Rows(service, connectionId, new ObjectRefDto("table", database, "dbo", "Disk"), json); }
        finally { await locker.DisposeAsync(); }
        check(table is { Error: null, Rows.Count: 2 } && table.Rows.Any(row => row[1] == "one") && table.Rows.Any(row => row[1] is null) && view is { Error: null, Rows.Count: 2 }
            && facts is { Error: null } && facts.Facts["memoryOptimized"] is true && disk is { Error: null, Rows.Count: 1 },
            "a memory-optimized table's top rows are read, and a view over it's, and a locked disk table beside them is still read uncommitted: "
            + (table.Error?.Message ?? view.Error?.Message ?? facts.Error?.Message ?? disk.Error?.Message));
    }
}
