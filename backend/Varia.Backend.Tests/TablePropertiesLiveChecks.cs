using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live Table Properties checks. Read-only: one of SQL Server's own tables (read-only, its changes refused) and a missing
/// table. With VARIA_TEST_SQL_SCRATCH=1, in a marked VariaScratch_…_tbp database that tracks changes: a table named to break out of
/// brackets and strings, with change tracking, page compression, a permission and extended properties (one not text), read back;
/// Script changing nothing; Apply turning change tracking off and on, changing Track columns updated, lock escalation and extended
/// properties in one transaction; a failing last statement rolling back the first; and another table's identity refused.</summary>
internal static class TablePropertiesLiveChecks
{
    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        public Task<ActionDescribeResult> Describe(ObjectRefDto table) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "tableProperties", table));
        public ActionArgs Args(ObjectRefDto table, TableChangesDto changes, DatabaseIdentityDto? identity = null) =>
            new("tableProperties", connectionId, Guid.NewGuid().ToString(), table, Identity: identity, TableChanges: changes);
        public Task<ActionScriptResult> Script(ObjectRefDto table, TableChangesDto changes, DatabaseIdentityDto? identity = null) => Call<ActionScriptResult>("actions.script", Args(table, changes, identity));
        public Task<ActionExecuteResult> Execute(ObjectRefDto table, TableChangesDto changes, DatabaseIdentityDto? identity = null) => Call<ActionExecuteResult>("actions.execute", Args(table, changes, identity));
    }

    private static bool Done(ActionExecuteResult result) => result.Error is null && result.Steps.Count > 0 && result.Steps.All(step => step.Status == "done");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        var catalog = ActionsCatalog.Current;
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }

        // SQL Server's own table: read, read-only, and Apply's and Script's changes refused before anything runs.
        var spt = new ObjectRefDto("table", Database: "msdb", Schema: "dbo", Name: "sysjobs");
        var system = await client.Describe(spt);
        var refused = await client.Script(spt, new("AUTO", null, null));
        check(system is { Error: null, TableProperties: { General.SystemObject: true, General.Name: "sysjobs", Storage.RowCount: >= 0 } model } && model.ReadOnlyReason == catalog.Tables.Message("systemTable")
            && refused is { Error.Code: "NOT_SUPPORTED", Text: null }, "Table Properties reads one of SQL Server's own tables read-only, and refuses its changes: " + system.Error?.Code + " " + refused.Error?.Code);
        var missing = await client.Describe(spt with { Name = "VariaMissing_" + Guid.NewGuid().ToString("N") });
        check(missing is { Error.Code: "NOT_FOUND", TableProperties: null }, "describing a table that does not exist is NOT_FOUND");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Table Properties scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateTablePropertiesAsync();
        const string schema = "Sa'les]", name = "Or]ders x";
        var setup = await Sql("ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);", db);
        setup = setup.Error is null ? await Sql("CREATE SCHEMA [Sa'les]]];", db) : setup;
        setup = setup.Error is null ? await Sql("CREATE TABLE [Sa'les]]].[Or]]ders x] (id int NOT NULL CONSTRAINT pk_orders PRIMARY KEY, note nvarchar(20) NULL) WITH (DATA_COMPRESSION = PAGE);\n"
            + "ALTER TABLE [Sa'les]]].[Or]]ders x] ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);\n"
            + "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Customer orders', @level0type = N'SCHEMA', @level0name = N'Sa''les]', @level1type = N'TABLE', @level1name = N'Or]ders x';\n"
            + "EXEC sys.sp_addextendedproperty @name = N'Blob', @value = 0x0102, @level0type = N'SCHEMA', @level0name = N'Sa''les]', @level1type = N'TABLE', @level1name = N'Or]ders x';\n"
            + "DECLARE @long varchar(5000) = REPLICATE('a', 5000);\nEXEC sys.sp_addextendedproperty @name = N'Long', @value = @long, @level0type = N'SCHEMA', @level0name = N'Sa''les]', @level1type = N'TABLE', @level1name = N'Or]ders x';\n"
            + "GRANT SELECT ON [Sa'les]]].[Or]]ders x] TO public;\nINSERT [Sa'les]]].[Or]]ders x] (id, note) VALUES (1, N'a'), (2, N'b');", db) : setup;
        check(setup.Error is null, "the Table Properties scratch table is created with change tracking, compression, a permission and extended properties");
        var table = new ObjectRefDto("table", Database: db, Schema: schema, Name: name);
        async Task<TablePropertiesDto?> Model() => (await client.Describe(table)).TableProperties;

        var read = await Model();
        check(read is { ReadOnlyReason: null, General.LockEscalation: "TABLE", ChangeTracking: { DatabaseEnabled: true, Enabled: true, TrackColumnsUpdated: true, PrimaryKey: true }, Storage: { Compression: "PAGE", RowCount: 2, Filegroup: "PRIMARY", Partitioned: false } }
            && read.ExtendedProperties.Any(property => property is { Name: "MS_Description", Value: "Customer orders", Type: null })
            && read.ExtendedProperties.Any(property => property is { Name: "Blob", Type: "varbinary", Truncated: null })
            && read.ExtendedProperties.Any(property => property is { Name: "Long", Type: null, Truncated: true, Value.Length: 4000 })
            && read.ExtendedProperties.Single(property => property.Name == "MS_Description").Truncated is null
            && read.Permissions.Any(permission => permission is { Principal: "public", Permission: "SELECT", State: "GRANT" }) && read.General.Name == name && read.General.Schema == schema,
            "Table Properties reads change tracking, Track columns updated, compression, rows, the permission and the extended properties (the binary one by its type, a varchar longer than it reads as cut short)");
        var identity = read is null ? null : new DatabaseIdentityDto(read.General.Id, read.General.Created);

        // Script runs nothing.
        var script = await client.Script(table, new("AUTO", new(false, null), [new("update", "MS_Description", "All orders")]), identity);
        var unchanged = await Model();
        check(script is { Error: null, Text: { } text } && script.Database == db && text.Contains("SET XACT_ABORT ON;", StringComparison.Ordinal)
            && text.Contains("ALTER TABLE [Sa'les]]].[Or]]ders x] SET (LOCK_ESCALATION = AUTO);", StringComparison.Ordinal) && text.Contains("ALTER TABLE [Sa'les]]].[Or]]ders x] DISABLE CHANGE_TRACKING;", StringComparison.Ordinal)
            && text.Contains("@value = N'All orders', @level0type = N'SCHEMA', @level0name = N'Sa''les]'", StringComparison.Ordinal)
            && unchanged is { General.LockEscalation: "TABLE", ChangeTracking.Enabled: true }, "Script returns SSMS's statements in one transaction and changes nothing");

        // Apply: change tracking off, lock escalation, an extended property changed and one added, in one transaction.
        var off = await client.Execute(table, new("DISABLE", new(false, null), [new("update", "MS_Description", "All orders"), new("add", "Owner", "it's Sales")]), identity);
        var afterOff = await Model();
        check(Done(off) && off.Steps.Count == 5 && off.Steps[^1].Title == "Commit" && afterOff is { General.LockEscalation: "DISABLE", ChangeTracking.Enabled: false }
            && afterOff.ExtendedProperties.Any(property => property is { Name: "MS_Description", Value: "All orders" }) && afterOff.ExtendedProperties.Any(property => property is { Name: "Owner", Value: "it's Sales" }),
            "Apply turns change tracking off, sets lock escalation, changes and adds extended properties: " + string.Join(", ", off.Steps.Select(step => step.Status)) + " " + off.Error?.Code);
        var on = await client.Execute(table, new(null, new(true, false), null), identity);
        var afterOn = await Model();
        check(Done(on) && afterOn is { ChangeTracking: { Enabled: true, TrackColumnsUpdated: false } }, "Apply turns change tracking on again, without Track columns updated, inside its transaction: " + on.Error?.Message?.Length);
        var columns = await client.Execute(table, new(null, new(true, true), null), identity);
        var afterColumns = await Model();
        check(Done(columns) && columns.Steps.Count == 3 && afterColumns is { ChangeTracking: { Enabled: true, TrackColumnsUpdated: true } }, "Apply changes Track columns updated by turning change tracking off and on again");

        // A failing last statement rolls back the first: the property it adds exists already.
        var failed = await client.Execute(table, new("AUTO", null, [new("add", "Owner", "again")]), identity);
        var afterFailure = await Model();
        check(failed.Error is { } error && error.Message.Contains(catalog.Tables.Message("rolledBack"), StringComparison.Ordinal) && afterFailure is { General.LockEscalation: "DISABLE" }
            && afterFailure.ExtendedProperties.Any(property => property is { Name: "Owner", Value: "it's Sales" }),
            "a statement that fails rolls back the transaction, lock escalation included, and says so");

        // Another table's identity (a table dropped and created again since) is refused before anything changes.
        var other = await client.Execute(table, new("TABLE", null, null), identity is null ? null : identity with { Id = identity.Id + 1 });
        check(other is { Error.Code: "NOT_FOUND" } && other.Steps.All(step => step.Status != "done") && (await Model()) is { General.LockEscalation: "DISABLE" },
            "Apply refuses a table that is not the one its properties were read from");

        // Dropping: the added property goes, and the binary one may be removed though it cannot be edited.
        var dropped = await client.Execute(table, new("TABLE", null, [new("drop", "Owner", null), new("drop", "Blob", null)]), identity);
        var afterDrop = await Model();
        check(Done(dropped) && afterDrop is { General.LockEscalation: "TABLE" } && afterDrop.ExtendedProperties.All(property => property.Name is not ("Owner" or "Blob")),
            "Apply drops extended properties, one that is not text included");
    }
}
