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
        JsonSerializerOptions json)
    {
        // Hostile names, dropped afterwards so the fixture checks that follow see the database as the fixtures made it.
        const string schema = "Peek]'Ü";
        var created = await sql("CREATE SCHEMA [Peek]]'Ü];\nGO\n"
            + "CREATE TABLE [Peek]]'Ü].[T]]'表] (Id int NOT NULL CONSTRAINT PK_PeekT PRIMARY KEY CLUSTERED, Name nvarchar(50) NULL, Notes nvarchar(max) NULL) WITH (DATA_COMPRESSION = PAGE);\n"
            + "CREATE INDEX IX_PeekT_Name ON [Peek]]'Ü].[T]]'表] (Name);\n"
            + "INSERT [Peek]]'Ü].[T]]'表] (Id, Name) VALUES (1, N'a'), (2, N'b'), (3, N'c');\nGO\n"
            + "CREATE PROCEDURE [Peek]]'Ü].[P]]'表] WITH RECOMPILE, EXECUTE AS OWNER AS SELECT 1;\nGO\n", database);
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

            service.Explorer.Options.ForcePerDatabaseScope = true;
            var perDatabase = await Peek(service, connectionId, Ref("table", schema, "T]'表"), json);
            service.Explorer.Options.ForcePerDatabaseScope = false;
            check(perDatabase is { Error: null } && perDatabase.Facts["rowCount"] is 3L, "the per-database strategy peeks the scratch database too");
        }
        finally
        {
            var dropped = await sql("DROP PROCEDURE IF EXISTS [Peek]]'Ü].[P]]'表];\nDROP TABLE IF EXISTS [Peek]]'Ü].[T]]'表];\nDROP SCHEMA IF EXISTS [Peek]]'Ü];\n", database);
            check(dropped.Status == "completed", "the peek fixtures are dropped: " + dropped.Error);
        }
    }
}
