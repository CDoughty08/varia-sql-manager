using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Protocol;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Live Script As checks (VARIA_TEST_SQL_SERVER): built-in msdb and master objects through scripting.script,
/// the session the scripting pool keeps, the command tracker, cancellation, budgets, disconnect and the gates; with
/// VARIA_TEST_SQL_SCRATCH=1, every scriptable kind of the Object Explorer scratch fixture, encrypted and oversized
/// modules, blocking, and names built to escape SMO's headers.</summary>
internal static partial class ScriptingLiveChecks
{
    private static readonly string NL = Environment.NewLine;

    /// <summary>The options page's defaults, as the renderer sends them.</summary>
    public static ScriptingOptionsDto Defaults(JsonSerializerOptions json)
    {
        var values = new JsonObject();
        foreach (var option in ScriptingCatalog.Current.Options) values[option.Key] = JsonNode.Parse(option.Default.GetRawText());
        return values.Deserialize<ScriptingOptionsDto>(json)!;
    }

    [GeneratedRegex(@"Script Date: [^\n]*? \*{6}/")]
    private static partial Regex ScriptDate();

    /// <summary>Spec G5's normalization, as much of it as these checks need: line endings and the header date.</summary>
    public static string Normalize(string text) => ScriptDate().Replace(text.Replace("\r\n", "\n"), "Script Date: <date> ******/");

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public ScriptingOptionsDto Options { get; } = Defaults(json);

        public async Task<ScriptResult> Script(ObjectRefDto target, string verb, ScriptingOptionsDto? options = null, RequestContext? context = null, string? connectionId = null) =>
            (ScriptResult)await service.DispatchAsync("scripting.script", JsonSerializer.SerializeToElement(
                new ScriptArgs(connectionId ?? ConnectionId, Guid.NewGuid().ToString(), [target], verb, options ?? Options), json), json, context);

        public string ConnectionId { get; } = connectionId;
    }

    private static bool Ok(ScriptResult result) => result.Error is null && result.Text is { Length: > 0 };

    /// <summary>A script's batches as SqlScript.Parse splits them, which must be one per GO the formatter wrote, less the
    /// batches that hold only SMO's header (a script the query window could not run is not framed).</summary>
    private static bool Framed(string text)
    {
        try
        {
            return SqlScript.Parse(text).Count + HeaderOnly().Matches(text).Count == Regex.Matches(text, "^GO\r?$", RegexOptions.Multiline).Count
                && text.EndsWith("GO" + NL + NL, StringComparison.Ordinal);
        }
        catch (RequestException) { return false; }
    }

    [GeneratedRegex(@"^/\*{6} Object:[^\r\n]*\*{6}/\r?\nGO\r?$", RegexOptions.Multiline)]
    private static partial Regex HeaderOnly();

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 100_000, 300), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
        }
        var options = service.Scripting.Options;

        // Tables, views, procedures and functions in msdb (spec G3).
        var sysjobs = new ObjectRefDto("table", "msdb", "dbo", "sysjobs");
        var create = await client.Script(sysjobs, "create");
        check(Ok(create) && create.Text!.StartsWith("USE [msdb]" + NL + "GO" + NL + NL, StringComparison.Ordinal) && create.Text.Contains("CREATE TABLE [dbo].[sysjobs](", StringComparison.Ordinal)
            && create.Database == "msdb" && create.Warnings.Count == 0 && Framed(create.Text), "Script Table as CREATE writes USE, SMO's CREATE TABLE and a GO after every batch");
        check(create.Commands > 0 && create.ElapsedMs > 0, "the command tracker counts the job's commands (" + create.Commands + ")");
        check(create.Text!.Contains("/****** Object:  Table [dbo].[sysjobs]", StringComparison.Ordinal) && create.Text.Contains("SET ANSI_PADDING", StringComparison.Ordinal)
            && !create.Text.Contains("COLLATE", StringComparison.Ordinal), "the defaults keep descriptive headers and ANSI_PADDING and leave out collations");
        var drop = await client.Script(sysjobs, "drop");
        check(Ok(drop) && drop.Text!.Contains("DROP TABLE [dbo].[sysjobs]", StringComparison.Ordinal) && !drop.Text.Contains("CREATE TABLE", StringComparison.Ordinal) && Framed(drop.Text),
            "Script Table as DROP drops the table");
        var both = await client.Script(sysjobs, "dropAndCreate");
        check(Ok(both) && both.Text!.IndexOf("DROP TABLE", StringComparison.Ordinal) is >= 0 and var at && both.Text.IndexOf("CREATE TABLE [dbo].[sysjobs](", StringComparison.Ordinal) > at
            && Regex.Matches(both.Text, @"^USE \[msdb\]", RegexOptions.Multiline).Count == 1 && Framed(both.Text), "DROP And CREATE drops before it creates, writing USE once");
        var plain = await client.Script(sysjobs, "create", client.Options with { ScriptUseDatabase = false, DelimitStatements = false, IncludeHeaders = false, SchemaQualify = false });
        check(Ok(plain) && !plain.Text!.Contains("USE [msdb]", StringComparison.Ordinal) && !plain.Text.Contains("GO" + NL, StringComparison.Ordinal)
            && !plain.Text.Contains("/******", StringComparison.Ordinal) && plain.Text.Contains("CREATE TABLE [sysjobs](", StringComparison.Ordinal), "the USE, GO, header and schema options turn their parts off");
        var exists = await client.Script(sysjobs, "create", client.Options with { CheckExistence = true });
        check(Ok(exists) && exists.Text!.Contains("IF NOT EXISTS", StringComparison.Ordinal), "Check for object existence guards the CREATE");
        // SSMS's templates (spec B9): one preflight round trip after the prologue, no SMO.
        var select = await client.Script(sysjobs, "select");
        check(Ok(select) && select.Text!.StartsWith("USE [msdb]" + NL + "GO" + NL + NL + "SELECT [job_id]" + NL + "      ,[originating_server_id]" + NL, StringComparison.Ordinal)
            && select.Text.EndsWith(NL + "  FROM [dbo].[sysjobs]" + NL + "GO" + NL + NL, StringComparison.Ordinal) && select.Commands == 2 && Framed(select.Text),
            "Script Table as SELECT lists sysjobs' columns after USE, in two commands (" + select.Commands + ")");
        var insert = await client.Script(sysjobs, "insert");
        check(Ok(insert) && insert.Text!.Contains("INSERT INTO [dbo].[sysjobs]" + NL + "           ([job_id]" + NL, StringComparison.Ordinal)
            && insert.Text.Contains("     VALUES" + NL + "           (<job_id, uniqueidentifier,>" + NL + "           ,<originating_server_id, int,>" + NL + "           ,<name, sysname,>", StringComparison.Ordinal)
            && Framed(insert.Text), "Script Table as INSERT lists columns and typed placeholders");
        var update = await client.Script(sysjobs, "update");
        check(Ok(update) && update.Text!.Contains("UPDATE [dbo].[sysjobs]" + NL + "   SET [job_id] = <job_id, uniqueidentifier,>" + NL + "      ,[originating_server_id] = <originating_server_id, int,>", StringComparison.Ordinal)
            && update.Text.Contains(NL + " WHERE <Search Conditions,,>" + NL + "GO" + NL, StringComparison.Ordinal), "Script Table as UPDATE sets every column to a placeholder");
        var delete = await client.Script(sysjobs, "delete");
        check(Ok(delete) && delete.Text == "USE [msdb]" + NL + "GO" + NL + NL + "DELETE FROM [dbo].[sysjobs]" + NL + "      WHERE <Search Conditions,,>" + NL + "GO" + NL + NL,
            "Script Table as DELETE");

        var view = new ObjectRefDto("view", "msdb", "dbo", "sysjobs_view");
        var definition = (await Sql("SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.sysjobs_view');", "msdb")).Scalar!;
        var viewCreate = await client.Script(view, "create");
        check(Ok(viewCreate) && viewCreate.Text!.Contains(Body(definition, "sysjobs_view", view: true), StringComparison.Ordinal) && Framed(viewCreate.Text),
            "a view's CREATE holds its stored body byte for byte below the header SMO writes");
        var viewAlter = await client.Script(view, "alter");
        check(Ok(viewAlter) && Regex.IsMatch(viewAlter.Text!, @"^\s*ALTER\s+VIEW", RegexOptions.Multiline | RegexOptions.IgnoreCase) && !viewAlter.Text!.Contains("CREATE VIEW", StringComparison.OrdinalIgnoreCase),
            "ALTER scripts ALTER VIEW");
        var viewBoth = await client.Script(view, "createOrAlter");
        check(Ok(viewBoth) && viewBoth.Text!.Contains("CREATE OR ALTER VIEW", StringComparison.OrdinalIgnoreCase), "CREATE OR ALTER scripts CREATE OR ALTER VIEW");
        var procedure = new ObjectRefDto("procedure", "msdb", "dbo", "sp_add_job");
        var procedureDefinition = (await Sql("SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.sp_add_job');", "msdb")).Scalar!;
        var procedureCreate = await client.Script(procedure, "create");
        // msdb's own header differs by version (2022 writes CREATE OR ALTER, which SMO turns into "CREATE   ").
        check(Ok(procedureCreate) && Regex.IsMatch(procedureCreate.Text!, @"CREATE\s+PROCEDURE \[dbo\]\.\[sp_add_job\]") && procedureCreate.Text!.Contains("[dbo].[sp_add_job]" + Body(procedureDefinition, "sp_add_job"), StringComparison.Ordinal),
            "a procedure's CREATE keeps its stored text, with only the name schema-qualified");
        var execute = await client.Script(procedure, "execute");
        check(Ok(execute) && execute.Text!.StartsWith("USE [msdb]" + NL + "GO" + NL + NL + "DECLARE @RC int" + NL + "DECLARE @job_name sysname" + NL, StringComparison.Ordinal)
            && execute.Text.Contains(NL + NL + "-- TODO: Set parameter values here." + NL + NL + "EXECUTE @RC = [dbo].[sp_add_job] " + NL + "   @job_name" + NL + "  ,@enabled" + NL, StringComparison.Ordinal)
            && execute.Text.Contains(NL + "  ,@job_id OUTPUT" + NL + "  ,@originating_server" + NL + "GO" + NL, StringComparison.Ordinal) && execute.Commands == 2, "Script Stored Procedure as EXECUTE declares and passes every parameter");
        var function = new ObjectRefDto("function", "msdb", "dbo", "agent_datetime");
        var functionDrop = await client.Script(function, "drop");
        check(Ok(functionDrop) && functionDrop.Text!.Contains("DROP FUNCTION [dbo].[agent_datetime]", StringComparison.Ordinal), "a scalar function's DROP");
        var functionSelect = await client.Script(function, "select");
        check(Ok(functionSelect) && functionSelect.Text!.Contains("SELECT [dbo].[agent_datetime] (" + NL + "   <@date, int,>" + NL + "  ,<@time, int,>)" + NL + "GO", StringComparison.Ordinal),
            "Script Function as SELECT selects a scalar function's value with a placeholder per parameter");
        var functionExecute = await client.Script(function, "execute");
        check(Ok(functionExecute) && functionExecute.Text!.Contains("DECLARE @RC datetime" + NL + "DECLARE @date int" + NL + "DECLARE @time int" + NL + NL, StringComparison.Ordinal)
            && functionExecute.Text.Contains("EXECUTE @RC = [dbo].[agent_datetime] " + NL + "   @date" + NL + "  ,@time" + NL + "GO", StringComparison.Ordinal),
            "Script Function as EXECUTE declares the return code with the function's return type");
        var viewSelect = await client.Script(view, "select", client.Options with { ScriptUseDatabase = false, SchemaQualify = false });
        check(Ok(viewSelect) && viewSelect.Text!.StartsWith("SELECT [job_id]" + NL, StringComparison.Ordinal) && viewSelect.Text.Contains(NL + "  FROM [sysjobs_view]" + NL, StringComparison.Ordinal),
            "a view's SELECT follows the USE and schema options");
        check((await client.Script(new ObjectRefDto("table", "msdb", "dbo", "VariaNoSuchTable"), "insert")).Error?.Code == "NOT_FOUND", "a template for a missing object is NOT_FOUND");

        // Databases and server objects use master (spec C1).
        var master = await client.Script(new ObjectRefDto("database", Name: "master"), "create");
        check(Ok(master) && master.Text!.Contains("CREATE DATABASE [master]", StringComparison.Ordinal) && master.Database == "master" && Framed(master.Text), "Script Database as CREATE");
        var sa = await client.Script(new ObjectRefDto("login", Name: "sa"), "create");
        check(Ok(sa) && sa.Text!.Contains("CREATE LOGIN [sa]", StringComparison.Ordinal) && sa.Database == "master", "Script Login as CREATE");
        var extended = await client.Script(new ObjectRefDto("procedure", "master", "sys", "xp_cmdshell"), "create");
        check(extended.Error is { Code: "NOT_SUPPORTED" } && extended.Error.Message == "CREATE scripts are not available for Stored Procedure sys.xp_cmdshell. Refresh Object Explorer and try again.",
            "an extended procedure listed as a system procedure is refused by the backend's own subtype");
        var missing = await client.Script(new ObjectRefDto("table", "msdb", "dbo", "VariaNoSuchTable"), "create");
        check(missing.Error is { Code: "NOT_FOUND", Retryable: false } && missing.Error.Message.StartsWith("dbo.VariaNoSuchTable no longer exists", StringComparison.Ordinal) && missing.Commands == 2,
            "a missing object is NOT_FOUND after the prologue and the preflight, without SMO");
        var gone = await client.Script(new ObjectRefDto("table", "VariaNoSuchDatabase", "dbo", "t"), "create");
        check(gone.Error?.Code == "NOT_FOUND", "an object in a missing database is NOT_FOUND" + gone.Error?.Code + gone.Error?.Message);

        // The pooled session after a script (spec C2).
        (int LockTimeout, int Isolation, string Database)? state = null;
        options.Released = async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT @@LOCK_TIMEOUT, transaction_isolation_level, DB_NAME() FROM sys.dm_exec_sessions WHERE session_id = @@SPID;";
            await using var reader = await command.ExecuteReaderAsync();
            if (await reader.ReadAsync()) state = (reader.GetInt32(0), reader.GetInt16(1), reader.GetString(2));
        };
        try { await client.Script(view, "create"); }
        finally { options.Released = null; }
        check(state is { LockTimeout: 10000, Isolation: 2 } && state.Value.Database == info.Database,
            "the scripting session keeps LOCK_TIMEOUT 10 s and READ COMMITTED after SMO, and returns to its home database (" + state + ")");

        // Culture affects only the header's date (spec C4).
        try
        {
            ScriptingCulture.Override = CultureInfo.GetCultureInfo("en-US");
            var english = Normalize((await client.Script(sysjobs, "create")).Text!);
            var same = true;
            foreach (var name in new[] { "de-DE", "tr-TR", "ja-JP", "sv-SE", "he-IL" })
            {
                ScriptingCulture.Override = CultureInfo.GetCultureInfo(name);
                same &= Normalize((await client.Script(sysjobs, "create")).Text!) == english;
            }
            check(same, "scripts in de-DE, tr-TR, ja-JP, sv-SE and he-IL equal en-US apart from the header date");
        }
        finally { ScriptingCulture.Override = null; }

        await CancellationAsync(check, service, client, live, json);
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Scripting scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await ScratchAsync(check, service, client, json, Sql, live);
    }

    private static async Task<bool> Stops(Task task)
    {
        try { await task; return false; }
        catch (OperationCanceledException) { return true; }
        catch (RequestException error) when (error.Code == "CANCELLED") { return true; }
    }

    private static async Task CancellationAsync(Action<bool, string> check, SqlService service, Client client, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        var scripting = service.Scripting;
        var options = scripting.Options;
        var table = new ObjectRefDto("table", "msdb", "dbo", "sysjobs");
        using (var context = new RequestContext(1, "scripting.script", RequestLane.Metadata, 0))
        {
            context.Cancel(CancelReason.User);
            var watch = Stopwatch.StartNew();
            check(await Stops(client.Script(table, "create", context: context)) && watch.ElapsedMilliseconds < 500 && scripting.ActiveJobs == 0 && scripting.RunningCount == 0,
                "a request cancelled before it runs ends at once and takes no gate");
        }
        options.PreflightDelay = TimeSpan.FromSeconds(5);
        try
        {
            using (var context = new RequestContext(2, "scripting.script", RequestLane.Metadata, 0))
            {
                var watch = Stopwatch.StartNew();
                var running = client.Script(table, "create", context: context);
                await Task.Delay(300);
                context.Cancel(CancelReason.User);
                var stopped = await Stops(running);
                check(stopped && watch.ElapsedMilliseconds < 1000 && scripting.RunningCount == 0, "a CANCEL answers within 1 s (" + watch.ElapsedMilliseconds + " ms)");
                // The attention ends the statement, so the job lets go of its gates soon after the reply.
                check(SpinWait.SpinUntil(() => scripting.ActiveJobs == 0, 2000), "the cancelled job releases its gates within one round trip");
            }
            options.Budget = TimeSpan.FromSeconds(1);
            var watchBudget = Stopwatch.StartNew();
            var budget = await client.Script(table, "create");
            check(budget.Error is { Code: "TIMEOUT", Retryable: true } && budget.Error.Message == "Scripting dbo.sysjobs took longer than 55 seconds and was stopped." && watchBudget.ElapsedMilliseconds < 2500,
                "the job's budget ends it as a TIMEOUT value");
            options.Budget = new ScriptingServiceOptions().Budget;
            SpinWait.SpinUntil(() => scripting.ActiveJobs == 0, 2000);

            // Two jobs at a time per connection: six one-second preflights take three rounds.
            options.PreflightDelay = TimeSpan.FromSeconds(1);
            var peak = 0;
            using var sampling = new CancellationTokenSource();
            var sampler = Task.Run(async () => { while (!sampling.IsCancellationRequested) { peak = Math.Max(peak, scripting.ActiveJobs); await Task.Delay(20); } });
            var concurrent = Stopwatch.StartNew();
            var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => client.Script(table, "drop")));
            sampling.Cancel();
            await sampler;
            check(results.All(Ok) && concurrent.ElapsedMilliseconds >= 2900 && peak <= 2, "one connection runs at most two scripting jobs at once (" + concurrent.ElapsedMilliseconds + " ms, peak " + peak + ")");

            options.PreflightDelay = TimeSpan.FromSeconds(5);
            var other = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master"), json), json);
            var pending = client.Script(table, "create", connectionId: other.Id);
            await Task.Delay(300);
            var disconnected = Stopwatch.StartNew();
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(other.Id), json), json);
            try { await pending; check(false, "a disconnected connection's script completed"); }
            catch (RequestException error) { check(error.Code == "CANCELLED" && disconnected.ElapsedMilliseconds < 1000, "disconnect cancels the connection's scripting jobs"); }
        }
        finally
        {
            options.PreflightDelay = null;
            options.Budget = new ScriptingServiceOptions().Budget;
        }
        check(Ok(await client.Script(table, "create")), "the scripting pool serves the next request after cancellations");
    }

    private static async Task ScratchAsync(Action<bool, string> check, SqlService service, Client client, JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql,
        Func<string, ConnectOptions> live)
    {
        var fixtures = Path.Combine(AppContext.BaseDirectory, "Fixtures");
        await using var scratch = await ScratchDatabase.CreateAsync(sql, fixtures);
        var db = scratch.Name;
        await SweepServerObjectsAsync(sql);
        var extra = await sql(File.ReadAllText(Path.Combine(fixtures, "scripting-extra.sql")), db);
        if (extra.Status != "completed") throw new InvalidOperationException("The scripting fixture failed: " + extra.Error);
        try
        {
            var server = await sql(File.ReadAllText(Path.Combine(fixtures, "scripting-server.sql")).Replace("{{scratch}}", db, StringComparison.Ordinal), "master");
            if (server.Status != "completed") throw new InvalidOperationException("The scripting server fixture failed: " + server.Error);
            await ScratchChecksAsync(check, service, client, json, sql, live, scratch);
        }
        finally { await DropServerObjectsAsync(sql, db); }
    }

    private static async Task ScratchChecksAsync(Action<bool, string> check, SqlService service, Client client, JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql,
        Func<string, ConnectOptions> live, ScratchDatabase scratch)
    {
        var db = scratch.Name;
        ObjectRefDto Schema(string kind, string schema, string name) => new(kind, db, schema, name);
        ObjectRefDto Named(string kind, string name) => new(kind, db, Name: name);
        ObjectRefDto Child(string kind, string parentKind, string schema, string parent, string name) => new(kind, db, Name: name, Parent: new ParentRefDto(parentKind, schema, parent));
        // One object of every kind the fixture has, with the text its CREATE must contain (SMO resolves every URN type).
        var objects = new (ObjectRefDto Target, string Contains)[]
        {
            (new ObjectRefDto("database", Name: db), "CREATE DATABASE [" + db + "]"),
            (Schema("table", "Sales", "Orders"), "CREATE TABLE [Sales].[Orders]("),
            (Schema("table", "Sales", "Invoices"), "SYSTEM_VERSIONING = ON"),
            (Schema("table", "Sales", "InvoicesHistory"), "CREATE TABLE [Sales].[InvoicesHistory]("),
            (Schema("view", "dbo", "vCustomers"), "CREATE VIEW [dbo].[vCustomers]"),
            (Schema("procedure", "Sales", "usp_Orders"), "CREATE PROCEDURE [Sales].[usp_Orders]"),
            (Schema("function", "dbo", "fn_Inline"), "CREATE FUNCTION [dbo].[fn_Inline]"),
            (Schema("function", "dbo", "fn_Multi"), "CREATE FUNCTION [dbo].[fn_Multi]"),
            (Schema("function", "dbo", "fn_Scalar"), "CREATE FUNCTION [dbo].[fn_Scalar]"),
            (Schema("synonym", "dbo", "syn_Orders"), "CREATE SYNONYM [dbo].[syn_Orders]"),
            (Schema("sequence", "dbo", "seq_Orders"), "CREATE SEQUENCE [dbo].[seq_Orders]"),
            (Schema("type", "dbo", "Name"), "CREATE TYPE [dbo].[Name]"),
            (Schema("tableType", "Sales", "OrderLines"), "CREATE TYPE [Sales].[OrderLines] AS TABLE("),
            (Schema("xmlSchemaCollection", "dbo", "Coll"), "CREATE XML SCHEMA COLLECTION [dbo].[Coll]"),
            (Schema("rule", "dbo", "r_Positive"), "CREATE RULE [dbo].[r_Positive]"),
            (Schema("default", "dbo", "d_Zero"), "CREATE DEFAULT [dbo].[d_Zero]"),
            (Schema("securityPolicy", "dbo", "CustomerPolicy"), "CREATE SECURITY POLICY [dbo].[CustomerPolicy]"),
            (Child("trigger", "table", "Sales", "Orders", "TR_Orders_Audit"), "CREATE TRIGGER [Sales].[TR_Orders_Audit] ON [Sales].[Orders]"),
            (Child("trigger", "view", "dbo", "vCustomers", "TR_vCustomers"), "CREATE TRIGGER [dbo].[TR_vCustomers] ON [dbo].[vCustomers]"),
            (Child("index", "table", "Sales", "Orders", "IX_Orders_Customer"), "CREATE NONCLUSTERED INDEX [IX_Orders_Customer] ON [Sales].[Orders]"),
            (Child("index", "view", "dbo", "vOrderTotals", "IX_vOrderTotals"), "CREATE UNIQUE CLUSTERED INDEX [IX_vOrderTotals] ON [dbo].[vOrderTotals]"),
            (Child("key", "table", "Sales", "Orders", "PK_Orders"), "ADD  CONSTRAINT [PK_Orders] PRIMARY KEY"),
            (Child("key", "table", "Sales", "Customers", "UQ_Customers_Email"), "ADD  CONSTRAINT [UQ_Customers_Email] UNIQUE"),
            (Child("key", "table", "Sales", "Orders", "FK_Orders_Customers"), "CONSTRAINT [FK_Orders_Customers] FOREIGN KEY"),
            (Child("constraint", "table", "Sales", "Orders", "CK_Orders_Price"), "CONSTRAINT [CK_Orders_Price] CHECK"),
            (Child("constraint", "table", "Sales", "Customers", "DF_Customers_Created"), "CONSTRAINT [DF_Customers_Created]  DEFAULT"),
            (Child("statistic", "table", "Sales", "Orders", "ST_Orders_Quantity"), "CREATE STATISTICS [ST_Orders_Quantity] ON [Sales].[Orders]"),
            (Named("schema", "Sales"), "CREATE SCHEMA [Sales]"),
            (Named("user", "NoLoginUser"), "CREATE USER [NoLoginUser]"),
            (Named("databaseRole", "SalesReaders"), "CREATE ROLE [SalesReaders]"),
            (Named("applicationRole", "AppRole"), "CREATE APPLICATION ROLE [AppRole]"),
            (Named("databaseTrigger", "trg_ddl_on"), "CREATE TRIGGER [trg_ddl_on] ON DATABASE"),
            (Named("partitionFunction", "pf_Range"), "CREATE PARTITION FUNCTION [pf_Range]"),
            (Named("partitionScheme", "ps_Range"), "CREATE PARTITION SCHEME [ps_Range]"),
            (Named("planGuide", "pg_Orders"), "sp_create_plan_guide")
        };
        var failed = new List<string>();
        foreach (var (target, contains) in objects)
        {
            var result = await client.Script(target, "create");
            if (!Ok(result) || !result.Text!.Contains(contains, StringComparison.Ordinal) || !Framed(result.Text)) failed.Add(target.Kind + " " + target.Name + ": " + (result.Error?.Message ?? Excerpt(result.Text, contains)));
        }
        check(failed.Count == 0, "Script as CREATE resolves every kind of the scratch fixture: " + string.Join("; ", failed));
        failed.Clear();
        foreach (var (target, _) in objects.Where(item => item.Target.Kind is not "database"))
        {
            var result = await client.Script(target, "drop");
            if (!Ok(result) || !result.Text!.Contains("DROP", StringComparison.Ordinal)) failed.Add(target.Kind + " " + target.Name + ": " + (result.Error?.Message ?? "no DROP"));
        }
        check(failed.Count == 0, "Script as DROP resolves every kind of the scratch fixture: " + string.Join("; ", failed));
        // The runner guards only scripts with headers (spec C7): SMO 181 writes none when asked for none, whatever the kind
        // or name, so nothing a name holds can end a comment there.
        failed.Clear();
        var plain = client.Options with { IncludeHeaders = false };
        foreach (var target in objects.Select(item => item.Target).Concat([new ObjectRefDto("login", Name: "sa"), new ObjectRefDto("serverTrigger", Name: db + "_trg"),
            Schema("table", "dbo", "x*/ DROP TABLE dbo.Victim /*"), Schema("table", "dbo", "a*/b"), Schema("table", "dbo", "line\r\nGO\r\nbreak")]))
            foreach (var verb in target.Kind == "database" ? new[] { "create" } : ["create", "drop"])
            {
                var result = await client.Script(target, verb, plain);
                if (!Ok(result) || result.Text!.Contains("/******", StringComparison.Ordinal) || HeaderGuard.Dated(result.Text) > 0 || result.Warnings.Count > 0)
                    failed.Add(target.Kind + " " + target.Name + " " + verb + ": " + (result.Error?.Message ?? string.Join(" ", result.Warnings)));
            }
        check(failed.Count == 0, "with headers off SMO writes no descriptive header for any kind, crafted names included: " + string.Join("; ", failed));
        // SMO's dependency discovery refuses most kinds (databases, indexes, keys, principals); the option then adds nothing.
        failed.Clear();
        var dependents = client.Options with { GenerateDependentObjects = true };
        foreach (var (target, contains) in objects.Append((new ObjectRefDto("login", Name: "sa"), "CREATE LOGIN [sa]"))
            .Append((new ObjectRefDto("serverTrigger", Name: db + "_trg"), "CREATE TRIGGER [" + db + "_trg] ON ALL SERVER")))
        {
            var result = await client.Script(target, "create", dependents);
            if (!Ok(result) || !result.Text!.Contains(contains, StringComparison.Ordinal)) failed.Add(target.Kind + " " + target.Name + ": " + (result.Error?.Message ?? Excerpt(result.Text, contains)));
        }
        check(failed.Count == 0, "Script as CREATE resolves every kind with Generate script for dependent objects on: " + string.Join("; ", failed));
        // DROP And CREATE is the DROP script, then the CREATE script after its USE: the CREATE half keeps the USE batches
        // SMO writes inside it (a database's extended properties are added in the database, then the script returns to master).
        failed.Clear();
        var golden = GoldenText.Load();
        foreach (var target in new[] { new ObjectRefDto("database", Name: db), Schema("table", "Sales", "Orders"), Schema("view", "dbo", "vCustomers"), Schema("procedure", "Sales", "usp_Orders"),
            Named("schema", "Sales"), Child("index", "table", "Sales", "Orders", "IX_Orders_Customer"), Child("trigger", "table", "Sales", "Orders", "TR_Orders_Audit"), new ObjectRefDto("login", Name: "sa") })
        {
            // Spec G5's normalization: a login's CREATE carries a new random password each time.
            var create = golden.Normalize((await client.Script(target, "create")).Text ?? "");
            var drop = golden.Normalize((await client.Script(target, "drop")).Text ?? "");
            var both = golden.Normalize((await client.Script(target, "dropAndCreate")).Text ?? "");
            var use = create.StartsWith("USE [", StringComparison.Ordinal) ? create.IndexOf("\nGO\n\n", StringComparison.Ordinal) + 5 : -1;
            if (use < 0 || !drop.StartsWith(create[..use], StringComparison.Ordinal) || both != drop + create[use..])
                failed.Add(target.Kind + " " + target.Name + (use < 0 ? ": no USE" : " differs at " + GoldenText.FirstDifference(drop + create[use..], both)));
        }
        check(failed.Count == 0, "DROP And CREATE is the DROP script followed by the CREATE script after its USE: " + string.Join("; ", failed));

        var secret = Schema("procedure", "dbo", "usp_Secret");
        var encrypted = await client.Script(secret, "create");
        check(encrypted.Error is { Code: "ENCRYPTED", Retryable: false } && encrypted.Error.Message == "dbo.usp_Secret is encrypted (WITH ENCRYPTION), so its definition cannot be scripted. DROP and EXECUTE scripts still work."
            && encrypted.Commands == 2, "an encrypted module is refused before SMO runs");
        check((await client.Script(secret, "alter")).Error?.Code == "ENCRYPTED" && Ok(await client.Script(secret, "drop")), "an encrypted module still scripts DROP");

        var bytes = (await sql("SELECT DATALENGTH(definition) FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.usp_Large');", db)).Scalar;
        var tooLarge = await client.Script(Schema("procedure", "dbo", "usp_Large"), "create");
        check(long.Parse(bytes!, CultureInfo.InvariantCulture) > 8_000_000 && tooLarge.Error is { Code: "TOO_LARGE" }
            && tooLarge.Error.Message == "The definition of dbo.usp_Large is larger than 8 MB, which Varia cannot open." && tooLarge.Commands <= 2,
            "a module over 8,000,000 bytes is refused before SMO loads it (" + bytes + " bytes, " + tooLarge.Commands + " commands)");

        // Names that would end SMO's header comment early, or split it over lines (scripting-extra.sql).
        var safe = await client.Script(Schema("table", "dbo", "b"), "create");
        var batches = SqlScript.Parse(safe.Text!).Count;
        foreach (var name in new[] { "x*/ DROP TABLE dbo.Victim /*", "a*/b" })
        {
            // SMO 181 writes "?" for such a name in its header; the guard passes that, and would catch an SMO that did not.
            var guarded = await client.Script(Schema("table", "dbo", name), "create");
            check(Ok(guarded) && HeaderGuard.Safe(guarded.Text!) && guarded.Text!.Contains("/****** Object:  Table ?", StringComparison.Ordinal)
                && SqlScript.Parse(guarded.Text).Count == batches, "a table named " + name + " keeps a header that cannot end early");
        }
        var broken = await client.Script(Schema("table", "dbo", "line\r\nGO\r\nbreak"), "create");
        // SMO writes that name into its header as is, so the header guard scripts the table again without headers.
        check(Ok(broken) && !broken.Text!.Contains("/******", StringComparison.Ordinal) && broken.Warnings.SequenceEqual([HeaderGuard.Warning])
            && SqlScript.Parse(broken.Text).Count == batches, "a header split by a name's line break is left out, with a warning, and the name's GO splits no batch");

        // Another session's uncommitted ALTER holds the table's metadata (spec C5): LOCK_TIMEOUT answers BLOCKED.
        var holder = Guid.NewGuid().ToString();
        var lockedRun = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(client.ConnectionId, holder, db, "BEGIN TRANSACTION; ALTER TABLE dbo.a ADD z int NULL;", Guid.NewGuid().ToString(), 10, 30), json), json);
        try
        {
            var locked = Schema("table", "dbo", "a");
            var watch = Stopwatch.StartNew();
            var blocked = await client.Script(locked, "create");
            check(lockedRun.Status == "completed" && blocked.Error is { Code: "BLOCKED", Retryable: true } && watch.ElapsedMilliseconds is >= 9000 and < 15_000,
                "a script blocked by another session's DDL is BLOCKED after the 10 s lock timeout (" + watch.ElapsedMilliseconds + " ms)");
            using var context = new RequestContext(3, "scripting.script", RequestLane.Metadata, 0);
            var cancelWatch = Stopwatch.StartNew();
            var pending = client.Script(locked, "create", context: context);
            await Task.Delay(500);
            context.Cancel(CancelReason.User);
            check(await Stops(pending) && cancelWatch.ElapsedMilliseconds < 2000, "a CANCEL stops a blocked script within 2 s");
            check(SpinWait.SpinUntil(() => service.Scripting.ActiveJobs == 0, 2000), "the attention frees the blocked job's gates");
            var other = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master"), json), json);
            var orphan = client.Script(locked, "create", connectionId: other.Id);
            await Task.Delay(500);
            var dropped = Stopwatch.StartNew();
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(other.Id), json), json);
            check(await Stops(orphan) && dropped.ElapsedMilliseconds < 2000 && SpinWait.SpinUntil(() => service.Scripting.ActiveJobs == 0, 2000),
                "disconnecting cancels a blocked script and frees its gates");
        }
        finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json); }
        check(Ok(await client.Script(Schema("table", "dbo", "a"), "create")), "the table scripts once the other session rolls back");
        await SchemaLockAsync(check, service, client, json, Schema("table", "dbo", "Victim"), db);
        await DefinitionsAsync(check, client, Schema);
        await OldHeadersAsync(check, client, sql, db);
        await CultureAsync(check, client, sql, db);
        await GoldenAsync(check, service, client, scratch, sql, live, json);
    }

    /// <summary>Another session's uncommitted TRUNCATE holds a schema-modification lock that sys.tables does not wait for
    /// but object-level metadata functions and SMO do. The preflight decides VIEW DEFINITION without waiting when the
    /// database grants it, and the command tracker's attention ends SMO's blocked statement on a CANCEL.</summary>
    private static async Task SchemaLockAsync(Action<bool, string> check, SqlService service, Client client, JsonSerializerOptions json, ObjectRefDto table, string db)
    {
        var holder = Guid.NewGuid().ToString();
        var truncate = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(client.ConnectionId, holder, db, "BEGIN TRANSACTION; TRUNCATE TABLE " + table.Schema + "." + table.Name + ";", Guid.NewGuid().ToString(), 10, 30), json), json);
        try
        {
            var watch = Stopwatch.StartNew();
            var select = await client.Script(table, "select");
            check(truncate.Status == "completed" && Ok(select) && select.Warnings.Count == 0 && watch.ElapsedMilliseconds < 3000,
                "behind another session's TRUNCATE the SELECT template answers at once, without a VIEW DEFINITION warning (" + watch.ElapsedMilliseconds + " ms)");
            watch.Restart();
            var create = await client.Script(table, "create");
            check(create.Error is { Code: "BLOCKED" } && watch.ElapsedMilliseconds is >= 9000 and < 15_000,
                "behind another session's TRUNCATE a CREATE is BLOCKED after one 10 s lock timeout (" + watch.ElapsedMilliseconds + " ms, " + create.Error?.Code + ")");
            // The preflight passes at once, so after 2 s SMO's own statement is the one waiting on the lock.
            using var context = new RequestContext(4, "scripting.script", RequestLane.Metadata, 0);
            var pending = client.Script(table, "create", context: context);
            await Task.Delay(2000);
            context.Cancel(CancelReason.User);
            var cancelled = Stopwatch.StartNew();
            var stopped = await Stops(pending);
            var released = SpinWait.SpinUntil(() => service.Scripting.ActiveJobs == 0, 1500);
            check(stopped && released, "a CANCEL while SMO waits on a lock ends SMO's statement and frees the job's gates within 1.5 s (" + cancelled.ElapsedMilliseconds + " ms)");
        }
        finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json); }
    }

    /// <summary>Script triggers and Generate script for dependent objects make SMO read definitions besides the target's:
    /// an encrypted or oversized one is refused before SMO loads it, naming that object and the option (spec F).</summary>
    private static async Task DefinitionsAsync(Action<bool, string> check, Client client, Func<string, string, string, ObjectRefDto> schema)
    {
        var triggers = client.Options with { ScriptTriggers = true };
        var dependents = client.Options with { GenerateDependentObjects = true };
        var secretTrigger = await client.Script(schema("table", "dbo", "SecretTrigger"), "create", triggers);
        check(secretTrigger.Error is { Code: "ENCRYPTED", Retryable: false } && secretTrigger.Error.Message == "Trigger TR_SecretTrigger of dbo.SecretTrigger is encrypted (WITH ENCRYPTION), "
            + "so dbo.SecretTrigger cannot be scripted with Script triggers on. Turn it off in Tools › Options › Scripting and try again.",
            "an encrypted trigger is named when Script triggers brings it in: " + secretTrigger.Error?.Message);
        check(Ok(await client.Script(schema("table", "dbo", "SecretTrigger"), "create")) && Ok(await client.Script(schema("table", "dbo", "SecretTrigger"), "drop", triggers)),
            "the table scripts without Script triggers, and its DROP needs no trigger text");
        var secretView = await client.Script(schema("view", "dbo", "vSecret"), "create", dependents);
        check(secretView.Error is { Code: "ENCRYPTED" } && secretView.Error.Message == "dbo.fn_Secret is encrypted (WITH ENCRYPTION), so dbo.vSecret cannot be scripted with "
            + "Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again.", "an encrypted dependent function is named: " + secretView.Error?.Message);
        var allocated = GC.GetTotalAllocatedBytes(true);
        var largeTrigger = await client.Script(schema("table", "dbo", "LargeTrigger"), "create", triggers);
        var largeView = await client.Script(schema("view", "dbo", "vLarge"), "create", dependents);
        allocated = GC.GetTotalAllocatedBytes(true) - allocated;
        check(largeTrigger.Error is { Code: "TOO_LARGE" } && largeTrigger.Error.Message == "The definition of trigger TR_LargeTrigger of dbo.LargeTrigger is larger than 8 MB, which Varia "
            + "cannot open. Turn off Script triggers in Tools › Options › Scripting and try again." && largeView.Error is { Code: "TOO_LARGE" }
            && largeView.Error.Message == "The definition of dbo.fn_Large is larger than 8 MB, which Varia cannot open. Turn off Generate script for dependent objects in Tools › Options › "
            + "Scripting and try again." && allocated < 48_000_000,
            "a trigger or dependent definition over 8,000,000 bytes is refused before SMO loads it (" + allocated / 1_000_000 + " MB allocated): " + largeTrigger.Error?.Message + " " + largeView.Error?.Message);
        check(Ok(await client.Script(schema("view", "dbo", "vLarge"), "create")), "the view over the large function scripts on its own");
        allocated = GC.GetTotalAllocatedBytes(true);
        var parts = await client.Script(schema("view", "dbo", "vParts"), "create", dependents);
        allocated = GC.GetTotalAllocatedBytes(true) - allocated;
        check(parts.Error is { Code: "TOO_LARGE" } && parts.Error.Message.StartsWith("The script for dbo.vParts is longer than 4,000,000 characters", StringComparison.Ordinal)
            && allocated < 48_000_000, "dependents each under 8,000,000 bytes that together could not fit in a script are refused before SMO loads them ("
            + allocated / 1_000_000 + " MB allocated): " + parts.Error?.Message);
        var triggerParts = schema("table", "dbo", "TriggerParts");
        allocated = GC.GetTotalAllocatedBytes(true);
        var partsCreate = await client.Script(triggerParts, "create", triggers);
        var partsBoth = await client.Script(triggerParts, "dropAndCreate", triggers);
        allocated = GC.GetTotalAllocatedBytes(true) - allocated;
        check(new[] { partsCreate, partsBoth }.All(result => result.Error is { Code: "TOO_LARGE" }
                && result.Error.Message.StartsWith("The script for dbo.TriggerParts is longer than 4,000,000 characters", StringComparison.Ordinal))
            && allocated < 48_000_000 && Ok(await client.Script(triggerParts, "create")),
            "triggers each under 8,000,000 bytes that together could not fit in a script are refused before SMO loads them (" + allocated / 1_000_000 + " MB allocated), "
            + "and the table scripts without Script triggers: " + partsCreate.Error?.Message + " " + partsBoth.Error?.Message);

        // A dependent in a database that does not exist: the message names that database and the option, not the target as
        // missing. SMO's walk lists the dependent, so the definition check is what fails there, naming it itself.
        var noDatabase = await client.Script(schema("procedure", "dbo", "usp_NoDatabase"), "create", dependents);
        check(noDatabase.Error is { Code: "DATABASE_UNAVAILABLE", Retryable: true } && noDatabase.Error.Message.StartsWith("Database varia_no_such_database is not available (", StringComparison.Ordinal)
            && noDatabase.Error.Message.EndsWith("), so dbo.usp_NoDatabase cannot be scripted with "
            + "Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again.", StringComparison.Ordinal)
            && Ok(await client.Script(schema("procedure", "dbo", "usp_NoDatabase"), "create")),
            "a dependent's database that does not exist is named, with the option to turn off: " + noDatabase.Error?.Message);

        // A stored line the query window reads as GO would run the rest of the definition as a batch of its own.
        var split = await client.Script(schema("procedure", "dbo", "usp_go"), "create");
        check(Ok(split) && split.Warnings.SequenceEqual([SmoScriptRunner.SplitWarning]) && split.Text!.Contains("\r\nGO\r\nDROP TABLE dbo.Victim", StringComparison.Ordinal),
            "a definition with a GO line scripts as stored, with a warning that running it would split it: " + string.Join(" ", split.Warnings));
        var drop = await client.Script(schema("procedure", "dbo", "usp_go"), "drop");
        check(Ok(drop) && drop.Warnings.Count == 0, "its DROP carries no warning");
    }

    /// <summary>Definitions that keep an old SSMS header in their own text, in any shape (spec C7): the guard cannot tell
    /// such a line from a header, so the script is made again without headers, and SMO's headers stay because they are all
    /// it differs by. Without headers SMO writes none, so the stored text is all there is to keep.</summary>
    private static async Task OldHeadersAsync(Action<bool, string> check, Client client, Func<string, string, Task<SqlRun>> sql, string db)
    {
        var failed = new List<string>();
        var verbs = new (string Verb, string Keyword)[] { ("create", "CREATE"), ("alter", "ALTER"), ("createOrAlter", "CREATE OR ALTER"), ("dropAndCreate", "CREATE") };
        foreach (var name in new[] { "usp_OldHeader", "usp_OldHeaderLine", "usp_LeadingHeader", "usp_HeaderTrailing", "usp_HeaderBanner", "usp_HeaderNoDate", "usp_HeaderSameLine" })
        {
            var target = new ObjectRefDto("procedure", db, "dbo", name);
            var header = "/****** Object:  StoredProcedure [dbo].[" + name + "]    Script Date: ";
            // SMO writes the name quoted and keeps the stored text around it byte for byte, the old header included.
            var definition = (await sql("SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo." + name + "');", db)).Scalar ?? "";
            var create = "CREATE PROCEDURE dbo." + name;
            var at = definition.IndexOf(create, StringComparison.Ordinal);
            foreach (var headers in new[] { true, false })
                foreach (var (verb, keyword) in verbs)
                {
                    var result = await client.Script(target, verb, client.Options with { IncludeHeaders = headers });
                    var stored = at < 0 ? null : definition[..at] + keyword + " PROCEDURE [dbo].[" + name + "]" + definition[(at + create.Length)..];
                    if (!Ok(result) || result.Text!.Contains(header, StringComparison.Ordinal) != headers || stored is null || !result.Text.Contains(stored, StringComparison.Ordinal)
                        || result.Warnings.Count > 0 || !Framed(result.Text))
                        failed.Add(name + " " + verb + (headers ? "" : " without headers") + ": " + (result.Error?.Message ?? string.Join(" ", result.Warnings)));
                }
        }
        // A trigger or a function with such a banner comes in with Script triggers or Generate script for dependent objects.
        const string banner = "/****** Object:  StoredProcedure [dbo].[old]\r\n** Purpose: nightly load\r\n******/\r\n";
        foreach (var headers in new[] { true, false })
        {
            var options = client.Options with { IncludeHeaders = headers };
            foreach (var (label, target, extra) in new (string, ObjectRefDto, ScriptingOptionsDto)[]
            {
                ("trigger", new ObjectRefDto("trigger", db, Name: "TR_HeaderBanner", Parent: new ParentRefDto("table", "dbo", "HeaderTrigger")), options),
                ("its table with Script triggers", new ObjectRefDto("table", db, "dbo", "HeaderTrigger"), options with { ScriptTriggers = true }),
                ("function", new ObjectRefDto("function", db, "dbo", "fn_HeaderBanner"), options),
                ("view over it with dependent objects", new ObjectRefDto("view", db, "dbo", "vHeaderBanner"), options with { GenerateDependentObjects = true })
            })
            {
                var result = await client.Script(target, "create", extra);
                if (!Ok(result) || !result.Text!.Contains(banner + "CREATE ", StringComparison.Ordinal) || result.Warnings.Count > 0 || !Framed(result.Text))
                    failed.Add(label + (headers ? "" : " without headers") + ": " + (result.Error?.Message ?? string.Join(" ", result.Warnings)));
            }
        }
        check(failed.Count == 0, "a definition holding an old SSMS header of any shape scripts as stored with every DDL verb, with headers on or off, also as a trigger "
            + "or dependent object: " + string.Join("; ", failed));
        var secret = new ObjectRefDto("databaseTrigger", db, Name: "trg_SecretDdl");
        var encrypted = await client.Script(secret, "create");
        check(encrypted.Error is { Code: "ENCRYPTED" } && encrypted.Error.Message == "trg_SecretDdl is encrypted (WITH ENCRYPTION), so its definition cannot be scripted. DROP and EXECUTE scripts still work."
            && Ok(await client.Script(secret, "drop")), "an encrypted database trigger is ENCRYPTED for a login that may view definitions, and still scripts DROP: " + encrypted.Error?.Message);
    }

    /// <summary>The scripting culture formats only the header's date (spec F): a minus sign such as sv-SE's U+2212 or
    /// he-IL's bidi-marked one would make IDENTITY fail to run and SMO refuse a sequence that starts at its minimum.</summary>
    private static async Task CultureAsync(Action<bool, string> check, Client client, Func<string, string, Task<SqlRun>> sql, string db)
    {
        var targets = new[] { new ObjectRefDto("table", db, "dbo", "NegativeIdentity"), new ObjectRefDto("sequence", db, "dbo", "seq_Default"), new ObjectRefDto("sequence", db, "dbo", "seq_Int") };
        var options = client.Options with { ScriptUseDatabase = false };
        var english = new List<string>();
        var hebrew = new List<string>();
        var differs = new List<string>();
        try
        {
            ScriptingCulture.Override = CultureInfo.GetCultureInfo("en-US");
            foreach (var target in targets) english.Add(Normalize((await client.Script(target, "create", options)).Text ?? ""));
            foreach (var name in new[] { "sv-SE", "he-IL", "ar-SA" })
            {
                ScriptingCulture.Override = CultureInfo.GetCultureInfo(name);
                for (var i = 0; i < targets.Length; i++)
                {
                    var result = await client.Script(targets[i], "create", options);
                    if (!Ok(result) || Normalize(result.Text!) != english[i])
                        differs.Add(name + " " + targets[i].Name + ": " + (result.Error?.Message ?? GoldenText.FirstDifference(english[i], Normalize(result.Text!))));
                    else if (name == "he-IL") hebrew.Add(result.Text!);
                }
            }
        }
        finally { ScriptingCulture.Override = null; }
        // The he-IL scripts create the objects again.
        var dropped = await sql("DROP TABLE dbo.NegativeIdentity;\nDROP SEQUENCE dbo.seq_Default;\nDROP SEQUENCE dbo.seq_Int;", db);
        var ran = hebrew.Count == targets.Length ? await sql(string.Concat(hebrew), db) : null;
        check(english[0].Contains("[Id] [int] IDENTITY(-100,-1) NOT NULL", StringComparison.Ordinal) && english[0].Contains("DEFAULT ((-1.5))", StringComparison.Ordinal)
            && english[1].Contains("START WITH -9223372036854775808", StringComparison.Ordinal) && differs.Count == 0 && dropped.Status == "completed" && ran?.Status == "completed",
            "scripts in sv-SE, he-IL and ar-SA equal en-US apart from the header date, negative numbers included, and run: " + string.Join("; ", differs) + " " + ran?.Error);
    }

    /// <summary>A module's stored text after its name; for a view, after its AS, since SMO writes a view's header up to it.</summary>
    private static string Body(string definition, string name, bool view = false)
    {
        var rest = definition[(definition.IndexOf(name, StringComparison.OrdinalIgnoreCase) + name.Length)..];
        if (!view) return rest;
        var keyword = Regex.Match(rest, @"\bAS\b", RegexOptions.IgnoreCase);
        return rest[(keyword.Index + keyword.Length)..].TrimStart();
    }

    private static string Excerpt(string? text, string expected) => text is null ? "no text" : "expected " + expected + " in " + (text.Length > 600 ? text[..600] : text).Replace("\n", "\\n");
}
