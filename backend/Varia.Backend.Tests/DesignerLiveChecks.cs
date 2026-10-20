using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.Actions;
using Varia.Backend.Designer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live table designer checks. Without scratch databases: the describe of master, a missing database, a script that
/// creates nothing and warns about a taken name, and SQL Server's builders composing exactly the bracketed statements for
/// every hostile schema, table, column and filegroup name at the sysname limit. With VARIA_TEST_SQL_SCRATCH=1, in a marked
/// VariaScratch_…_tbd database: each fixture design saved as one table matching it, the displayed script creating the same
/// table, hostile names creating exactly their objects, taken names and a missing schema refused before any DDL, a key
/// SQL Server refuses after CREATE TABLE leaving nothing behind, json at SQL Server 2025, and Stop behind another session's
/// lock.</summary>
internal static class DesignerLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static readonly DesignerCatalog Catalog = DesignerCatalog.Current;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        public Task<ActionDescribeResult> Describe(string database) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "tableDesigner", new ObjectRefDto("database", Name: database)));
        private ActionArgs Args(string database, TableDesignDto design) => new("createTable", connectionId, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: database), Design: design);
        public Task<ActionScriptResult> Script(string database, TableDesignDto design) => Call<ActionScriptResult>("actions.script", Args(database, design));
        public Task<ActionExecuteResult> Save(string database, TableDesignDto design, RequestContext? context = null) => Call<ActionExecuteResult>("actions.execute", Args(database, design), context);
    }

    private static bool Done(ActionExecuteResult result) => result.Error is null && result.Steps.Count > 0 && result.Steps.All(step => step.Status == "done");
    private static DesignColumnDto Column(string name, string type, int? length = null, bool nulls = true, DesignIdentityDto? identity = null, bool? max = null) =>
        new(name, new DesignTypeDto(type, length, max), nulls, identity);

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        async Task<SqlRun> Sql(string text, string database = "master", string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { if (session is null) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        var major = int.Parse((await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Scalar!, System.Globalization.CultureInfo.InvariantCulture);
        var band = Math.Clamp(major, Explorer.ExplorerCatalog.MinBand, Explorer.ExplorerCatalog.MaxBand);

        // The describe: master's schemas with dbo first by default, PRIMARY, the band, and CREATE TABLE for a sysadmin.
        var described = await client.Describe("master");
        check(described is { Error: null, TableDesigner: { Database: "master", DefaultSchema: "dbo", DefaultFilegroup: "PRIMARY", SchemasTruncated: false } model } && model.Schemas.Contains("dbo")
            && model.Schemas.Contains("guest") && !model.Schemas.Contains("sys") && !model.Schemas.Contains("INFORMATION_SCHEMA") && model.Band == band && model.CanCreate == true,
            "the table designer describes master: its schemas but sys and INFORMATION_SCHEMA, dbo by default, PRIMARY, the band and CREATE TABLE (" + described.Error?.Message + ")");
        var missing = await client.Describe("VariaMissing_" + Guid.NewGuid().ToString("N"));
        check(missing is { Error.Code: "NOT_FOUND", TableDesigner: null }, "describing a database that does not exist for the table designer is NOT_FOUND");

        // Script runs nothing, and warns about a name already taken (master's dbo.spt_monitor).
        var name = "VariaDesigner_" + Guid.NewGuid().ToString("N");
        var design = new TableDesignDto("dbo", name, [Column("Id", "int", nulls: false, identity: new("1", "1")), Column("Name", "nvarchar", 50)], [0]);
        var script = await client.Script("master", design);
        var taken = await client.Script("master", design with { Name = "spt_monitor" });
        var created = (await Sql("SELECT CASE WHEN OBJECT_ID(" + Literal("dbo." + name) + ") IS NULL THEN 0 ELSE 1 END;")).Scalar;
        check(script is { Error: null, Database: "master", Text: { } text } && text.Contains("CREATE TABLE dbo." + name + Environment.NewLine, StringComparison.Ordinal) && script.Warnings.Count == 0 && created == "0"
            && taken is { Error: null } && taken.Warnings.Any(warning => warning.Contains("already exists", StringComparison.Ordinal)),
            "Generate Change Script returns SSMS's text, creates nothing, and warns about a taken name (" + script.Error?.Message + ")");

        // SQL Server composes exactly the bracketed statements from @design for every hostile name at the sysname limit, and
        // the dry run creates nothing.
        var mismatches = new List<string>();
        var count = 0;
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮").Append("\u0001\t"))
        {
            var hostile = ActionChecks.Long(fragment);
            var plan = TableDesignValidator.Validate(Catalog, new TableDesignDto(hostile, hostile, [Column(ActionChecks.Long("c" + fragment), "nvarchar", max: true, nulls: false), Column(ActionChecks.Long("d" + fragment), "decimal") with
            {
                Type = new DesignTypeDto("decimal", Precision: 38, Scale: 0), AllowNulls = false, Identity = new("-" + new string('9', 38), "7")
            }], [1, 0]));
            var built = await service.Actions.DryRunDesignAsync(info.Id, "master", plan, hostile, CancellationToken.None);
            var expected = DesignerSql.Statements(plan, hostile).Select(statement => statement.Text).ToList();
            if (!built.SequenceEqual(expected)) mismatches.Add(fragment[..1]);
            count += expected.Count;
        }
        check(mismatches.Count == 0 && count == 33, "SQL Server's builders compose exactly the bracketed statements for every hostile schema, table, column, key and filegroup name ("
            + count + " statements): " + string.Join(", ", mismatches));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Table designer scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateDesignerAsync();
        await ScratchAsync(check, client, service, info, json, Sql, db, major);
    }

    /// <summary>A table as SQL Server describes it: each column's name, type, length, precision, scale, nullability and
    /// identity seed and increment; the primary key's name, columns and kind; lock escalation and filegroups.</summary>
    private static async Task<string> Inventory(Func<string, string, string?, Task<SqlRun>> sql, string db, string schema, string table)
    {
        var id = "OBJECT_ID(" + Literal(Bracket(schema) + "." + Bracket(table)) + ")";
        var run = await sql("SELECT c.name, ty.name, CONVERT(nvarchar(10), c.max_length), CONVERT(nvarchar(10), c.precision), CONVERT(nvarchar(10), c.scale), CONVERT(nvarchar(1), c.is_nullable), "
            + "CONVERT(nvarchar(40), ic.seed_value), CONVERT(nvarchar(40), ic.increment_value) FROM sys.columns AS c JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id WHERE c.object_id = " + id + " ORDER BY c.column_id;\n"
            + "SELECT kc.name, col.name, CONVERT(nvarchar(10), ix.key_ordinal), i.type_desc FROM sys.key_constraints AS kc JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id "
            + "JOIN sys.index_columns AS ix ON ix.object_id = i.object_id AND ix.index_id = i.index_id JOIN sys.columns AS col ON col.object_id = ix.object_id AND col.column_id = ix.column_id "
            + "WHERE kc.parent_object_id = " + id + " AND kc.type = 'PK' ORDER BY ix.key_ordinal;\n"
            + "SELECT t.lock_escalation_desc, ds.name, lds.name FROM sys.tables AS t JOIN sys.indexes AS i ON i.object_id = t.object_id AND i.index_id IN (0, 1) JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id "
            + "LEFT JOIN sys.data_spaces AS lds ON lds.data_space_id = NULLIF(t.lob_data_space_id, 0) WHERE t.object_id = " + id + ";", db, null);
        return run.Status != "completed" ? "failed: " + run.Error : string.Join(Sets, run.Sets.Select(set => string.Join(Rows, set.Select(row => string.Join(Cells, row.Select(value => value ?? "-"))))));
    }

    // Names hold line breaks, commas and bars, so the inventory separates with control characters no saved name holds.
    private const string Sets = "\u001e", Rows = "\u001d", Cells = "\u001f";

    /// <summary>What the inventory must say for a plan.</summary>
    private static string Expected(TablePlan plan, string filegroup)
    {
        string Length(PlanColumn column) => column.Type.Params switch
        {
            "length" => column.Max ? "-1" : column.Length!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "nlength" => column.Max ? "-1" : (column.Length!.Value * 2).ToString(System.Globalization.CultureInfo.InvariantCulture),
            _ => "?"
        };
        var columns = string.Join(Rows, plan.Columns.Select(column => string.Join(Cells, column.Name, column.Type.Name, Length(column), column.Precision?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "?",
            column.Scale?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "?", column.AllowNulls ? "1" : "0", column.Seed ?? "-", column.Increment ?? "-")));
        var key = string.Join(Rows, plan.PrimaryKey.Select((index, position) => string.Join(Cells, plan.PrimaryKeyName, plan.Columns[index].Name, (position + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), "CLUSTERED")));
        return columns + Sets + key + Sets + string.Join(Cells, "TABLE", filegroup, plan.Columns.Any(column => column.Lob) ? filegroup : "-");
    }

    /// <summary>The inventory with the parts Expected cannot know (fixed-size lengths, precision and scale) as "?".</summary>
    private static string Comparable(string inventory, TablePlan plan)
    {
        var lines = inventory.Split(Sets);
        if (lines.Length != 3) return inventory;
        var columns = lines[0].Split(Rows).Select((row, index) =>
        {
            var cells = row.Split(Cells);
            if (index >= plan.Columns.Count || cells.Length != 8) return row;
            var kind = plan.Columns[index].Type.Params;
            if (kind is not ("length" or "nlength")) cells[2] = "?";
            if (kind != "precisionScale") cells[3] = "?";
            if (kind is not ("precisionScale" or "scale")) cells[4] = "?";
            return string.Join(Cells, cells);
        });
        return string.Join(Rows, columns) + Sets + lines[1] + Sets + lines[2];
    }

    private static async Task ScratchAsync(Action<bool, string> check, Client client, SqlService service, ConnectionInfo info, JsonSerializerOptions json,
        Func<string, string, string?, Task<SqlRun>> sql, string db, int major)
    {
        Task<SqlRun> Sql(string text) => sql(text, db, null);
        await Sql("EXEC (N'CREATE SCHEMA [sales]');\nEXEC (N'CREATE SCHEMA [my schema]');\nCREATE TABLE dbo.Canary (id int);");

        // Each fixture design: Save creates exactly the table it describes, and the displayed script, split into batches as
        // the query window splits it, creates the same table.
        var folder = Path.Combine(GoldenText.Repository(), "tests", "fixtures", "designer");
        var failures = new List<string>();
        foreach (var item in JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "cases.json")))!["cases"]!.AsArray())
        {
            var id = item!["id"]!.GetValue<string>();
            var design = item["design"].Deserialize<TableDesignDto>(Web)!;
            var plan = TableDesignValidator.Validate(Catalog, design);
            var before = (await Sql("SELECT COUNT(*) FROM sys.objects;")).Scalar;
            var saved = await client.Save(db, design);
            var after = (await Sql("SELECT COUNT(*) FROM sys.objects;")).Scalar;
            var inventory = await Inventory(sql, db, design.Schema, design.Name);
            var objects = int.Parse(after ?? "0", System.Globalization.CultureInfo.InvariantCulture) - int.Parse(before ?? "0", System.Globalization.CultureInfo.InvariantCulture);
            if (!Done(saved) || objects != (plan.PrimaryKey.Count > 0 ? 2 : 1) || Comparable(inventory, plan) != Expected(plan, "PRIMARY"))
                failures.Add(id + " saved: " + saved.Error?.Message + " objects " + objects + "\n" + inventory + "\nexpected\n" + Expected(plan, "PRIMARY"));
            await Sql("DROP TABLE " + Bracket(design.Schema) + "." + Bracket(design.Name) + ";");
            var text = (await client.Script(db, design)).Text ?? "";
            var ran = await Sql(text);
            var scripted = await Inventory(sql, db, design.Schema, design.Name);
            if (ran.Status != "completed" || scripted != inventory) failures.Add(id + " script: " + ran.Error + "\n" + scripted + "\nSave made\n" + inventory);
            await Sql("IF OBJECT_ID(" + Literal(Bracket(design.Schema) + "." + Bracket(design.Name)) + ") IS NOT NULL DROP TABLE " + Bracket(design.Schema) + "." + Bracket(design.Name) + ";");
        }
        check(failures.Count == 0, "each fixture design saves as exactly the table it describes, and its change script creates the same table:\n" + string.Join("\n", failures));

        // Hostile names as the schema, the table and the columns: exactly their objects appear, and the canary stays.
        var hostile = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'"))
        {
            var schema = ActionChecks.Long("s" + fragment);
            await Sql("DECLARE @s nvarchar(max) = N'CREATE SCHEMA ' + QUOTENAME(" + Literal(schema) + ");\nEXEC (@s);");
            var design = new TableDesignDto(schema, ActionChecks.Long(fragment), [Column(ActionChecks.Long("k" + fragment), "int", nulls: false), Column(ActionChecks.Long("c" + fragment), "nvarchar", 40)], [0]);
            var plan = TableDesignValidator.Validate(Catalog, design);
            var saved = await client.Save(db, design);
            var inventory = await Inventory(sql, db, schema, design.Name);
            var others = (await Sql("SELECT COUNT(*) FROM sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE s.name = " + Literal(schema) + ";")).Scalar;
            var canary = (await Sql("SELECT CASE WHEN OBJECT_ID(N'dbo.Canary') IS NOT NULL AND OBJECT_ID(N'dbo.Pwned') IS NULL THEN 1 ELSE 0 END;")).Scalar;
            if (!Done(saved) || Comparable(inventory, plan) != Expected(plan, "PRIMARY") || others != "1" || canary != "1") hostile.Add(fragment[..1] + ": " + saved.Error?.Message + " " + inventory);
        }
        check(hostile.Count == 0, "hostile schema, table and column names create exactly their table, and the canary stays: " + string.Join("; ", hostile));

        // Refused before any DDL: a missing schema, a taken table name, a taken key name.
        await Sql("CREATE TABLE dbo.Taken (id int);\nCREATE TABLE dbo.PK_KeyTaken (id int);");
        var noSchema = await client.Save(db, new TableDesignDto("VariaNoSchema", "T", [Column("a", "int")], []));
        var nameTaken = await client.Save(db, new TableDesignDto("dbo", "Taken", [Column("a", "int")], []));
        var keyTaken = await client.Save(db, new TableDesignDto("dbo", "KeyTaken", [Column("a", "int", nulls: false)], [0]));
        var keyTable = (await Sql("SELECT CASE WHEN OBJECT_ID(N'dbo.KeyTaken') IS NULL THEN 0 ELSE 1 END;")).Scalar;
        check(noSchema is { Error.Code: "NOT_FOUND", Steps.Count: 0 } && nameTaken is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && keyTaken is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && keyTable == "0",
            "a missing schema is NOT_FOUND and a taken table or PK_ name is NAME_IN_USE before any DDL (" + noSchema.Error?.Message + "; " + keyTaken.Error?.Message + ")");

        // A key SQL Server refuses after CREATE TABLE ran (nvarchar(max) cannot be a key column): the transaction rolls back.
        var refused = await client.Save(db, new TableDesignDto("dbo", "Rolled", [Column("a", "nvarchar", max: true, nulls: false)], [0]));
        var rolled = (await Sql("SELECT CASE WHEN OBJECT_ID(N'dbo.Rolled') IS NULL THEN 0 ELSE 1 END;")).Scalar;
        check(refused is { Error.Code: "SQL_ERROR" } && refused.Steps.Select(step => step.Status).SequenceEqual(["done", "failed", "skipped", "skipped"]) && refused.Error.Message.EndsWith(ActionService.RolledBack, StringComparison.Ordinal)
            && rolled == "0", "a key SQL Server refuses after CREATE TABLE fails the save, which rolls the table back (" + refused.Error?.Message + ")");

        // SQL Server 2025's json is stored off-row: the table gets TEXTIMAGE_ON.
        if (major >= 17)
        {
            var design = new TableDesignDto("dbo", "Json", [Column("id", "int", nulls: false), Column("doc", "json"), new("v", new DesignTypeDto("vector", Dimensions: 3), true)], [0]);
            var saved = await client.Save(db, design);
            var inventory = await Inventory(sql, db, "dbo", "Json");
            check(Done(saved) && inventory.EndsWith(string.Join(Cells, "TABLE", "PRIMARY", "PRIMARY"), StringComparison.Ordinal), "a json column (SQL Server 2025) saves with TEXTIMAGE_ON beside a vector (" + saved.Error?.Message + "): " + inventory);
        }

        // Stop: another session holds an uncommitted CREATE TABLE of the same name, so the save waits until Stop.
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await sql("BEGIN TRANSACTION; CREATE TABLE dbo.Held (id int);", db, holder);
            using var context = new RequestContext(5, "actions.execute", RequestLane.Actions, 0);
            var waiting = client.Save(db, new TableDesignDto("dbo", "Held", [Column("a", "int", nulls: false)], [0]), context);
            var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
            context.Cancel(CancelReason.User);
            ActionExecuteResult? stopped = null;
            try { stopped = await waiting; } catch (OperationCanceledException) { }
            await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
            var left = (await Sql("SELECT CASE WHEN OBJECT_ID(N'dbo.Held') IS NULL THEN 0 ELSE 1 END;")).Scalar;
            check(held.Status == "completed" && stillWaiting && stopped is { Error.Code: "CANCELLED" } && left == "0",
                "a save waiting behind another session's uncommitted table answers CANCELLED when stopped, and nothing is left once that session rolls back (" + stopped?.Error?.Message + ")");
        }
        finally
        {
            await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json);
        }
    }
}
