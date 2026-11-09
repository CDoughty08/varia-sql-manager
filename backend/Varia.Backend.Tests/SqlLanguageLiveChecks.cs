using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

/// <summary>Opt-in checks against the actual SQL Tools Service and a disposable development SQL Server. Only this
/// run's two uniquely named, marked scratch databases are created or dropped; no existing scratch objects are swept.</summary>
internal static class SqlLanguageLiveChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var server = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SERVER");
        if (string.IsNullOrWhiteSpace(server)) throw new InvalidOperationException("--sql-language-live requires VARIA_TEST_SQL_SERVER.");
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
            throw new InvalidOperationException("--sql-language-live requires VARIA_TEST_SQL_SCRATCH=1 for its two marked scratch databases.");
        var user = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_USER");
        var password = string.IsNullOrWhiteSpace(user) ? null : Environment.GetEnvironmentVariable("VARIA_TEST_SQL_PASSWORD")
            ?? throw new InvalidOperationException("VARIA_TEST_SQL_PASSWORD is required with VARIA_TEST_SQL_USER.");
        ConnectOptions Options(string database) => new(server, database, password is null ? "windows" : "sql", user, password, true,
            Advanced: new(ConnectTimeout: 10));
        var probeSettings = SqlService.ConnectBuilder(Options("master"));
        probeSettings.ApplicationName = "Varia SQL language live " + Guid.NewGuid().ToString("N");
        probeSettings.Pooling = false;
        await using var probe = new SqlConnection(probeSettings.ConnectionString);
        await probe.OpenAsync();
        await using (var version = new SqlCommand("SELECT CONVERT(nvarchar(32), SERVERPROPERTY('ProductVersion'));", probe))
            Console.WriteLine("SQL language live server version: " + (string?)await version.ExecuteScalarAsync());

        async Task<SqlRun> Sql(string text, string database)
        {
            var settings = new SqlConnectionStringBuilder(probeSettings.ConnectionString) { InitialCatalog = database };
            await using var connection = new SqlConnection(settings.ConnectionString);
            await connection.OpenAsync();
            await using var command = new SqlCommand(text, connection) { CommandTimeout = 30 };
            List<List<string?[]>> sets = [];
            try
            {
                await using var reader = await command.ExecuteReaderAsync();
                do
                {
                    List<string?[]> rows = [];
                    while (await reader.ReadAsync())
                    {
                        var row = new string?[reader.FieldCount];
                        for (var column = 0; column < row.Length; column++) row[column] = reader.IsDBNull(column) ? null : Convert.ToString(reader.GetValue(column), CultureInfo.InvariantCulture);
                        rows.Add(row);
                    }
                    sets.Add(rows);
                } while (await reader.NextResultAsync());
                return new("completed", null, sets);
            }
            catch (SqlException error) { return new("failed", "Fixture SQL failed with number " + error.Number.ToString(CultureInfo.InvariantCulture), sets); }
        }

        // Bare does not sweep pre-existing scratch databases. These two fixture databases share the same table name
        // but expose incompatible columns, so context leakage cannot pass by returning generic SQL suggestions.
        var scratch = ScratchDatabase.Bare(Sql);
        string? firstDatabase = null, secondDatabase = null;
        var initialProcesses = LanguageProcesses();
        HashSet<int> launchedProcesses = [];
        try
        {
            firstDatabase = await scratch.CreateLiveAsync();
            secondDatabase = await scratch.CreateRoundTripAsync();
            var firstFixture = await Sql("CREATE TABLE dbo.LanguageFixture (FirstOnly int NOT NULL, SharedName nvarchar(64) NULL); CREATE TABLE dbo.EditedFixture (EditedOnly bigint NOT NULL);", firstDatabase);
            var secondFixture = await Sql("CREATE TABLE dbo.LanguageFixture (SecondOnly bigint NOT NULL, SharedName nvarchar(64) NULL);", secondDatabase);
            check(firstFixture.Status == "completed" && secondFixture.Status == "completed", "language live fixtures create only test-owned tables in marked scratch databases");
            var wideColumns = string.Join(", ", Enumerable.Range(0, 600).Select(index => "Alpha" + index.ToString("D3", CultureInfo.InvariantCulture) + " int NULL"));
            check((await Sql("CREATE TABLE dbo.WideLanguageFixture (" + wideColumns + ", ZzzTail int NULL);", firstDatabase)).Status == "completed",
                "completion-limit regression creates a 601-column table only in its marked scratch database");

            using var service = new SqlService();
            async Task<T> Call<T>(string method, object parameters) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(parameters, Json), Json);
            var status = await Call<LanguageStatus>("language.status", new { });
            check(status.Providers.Single(provider => provider.Id == "sqlserver") is { Configured: true, Refresh: true }, "actual SQL Tools Service executable and cache refresh are configured for live tests");
            var firstConnection = await Call<ConnectionInfo>("connections.connect", Options(firstDatabase));
            var secondConnection = await Call<ConnectionInfo>("connections.connect", Options(secondDatabase));
            var firstId = Guid.NewGuid().ToString();
            var secondId = Guid.NewGuid().ToString();
            LanguageRequest Request(string id, int version, string text, ConnectionInfo connection, int? cursor = null) =>
                new(id, version, text, new("sqlserver", connection.Id, connection.Database), new(0, cursor ?? text.Length));
            Task<LanguageCompletionResult> Complete(LanguageRequest request) => Call<LanguageCompletionResult>("language.complete", request);
            static string Name(LanguageCompletionItem item) => item.Label.Trim('[', ']');
            static bool Has(LanguageCompletionResult value, string name) => value.Items.Any(item => Name(item).Equals(name, StringComparison.OrdinalIgnoreCase));
            // A single call must absorb STS's transient null/busy binding responses. Retrying from this test would
            // hide the empty-widget failure users see when Monaco requests suggestions once for a new document.
            var masterConnection = await Call<ConnectionInfo>("connections.connect", Options("master"));
            var systemDocument = Guid.NewGuid().ToString();
            var systemColumns = await Complete(Request(systemDocument, 1, "SELECT d.database_ FROM sys.databases AS d;", masterConnection, 18));
            check(Has(systemColumns, "database_id"), "first public completion request waits for system-catalog binding and returns database_id");
            await Call<LanguageCloseResult>("language.close", new LanguageCloseArgs(systemDocument));
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(masterConnection.Id), Json), Json);
            var wideDocument = Guid.NewGuid().ToString();
            var wide = await Complete(Request(wideDocument, 1, "SELECT w. FROM dbo.WideLanguageFixture AS w;", firstConnection, "SELECT w.".Length));
            check(wide.Items.Count == SqlToolsLanguageService.MaxCompletionItems && wide.IsIncomplete, "wide live catalogs still respect the completion response cap");
            var widePrefix = await Complete(Request(wideDocument, 2, "SELECT w.Zzz FROM dbo.WideLanguageFixture AS w;", firstConnection, "SELECT w.Zzz".Length));
            var wideExact = await Complete(Request(wideDocument, 3, "SELECT w.ZzzTail FROM dbo.WideLanguageFixture AS w;", firstConnection, "SELECT w.ZzzTail".Length));
            check(Has(widePrefix, "ZzzTail") && Has(wideExact, "ZzzTail"), "prefix and exact completion retain a live column beyond STS's first 500 declarations");
            await Call<LanguageCloseResult>("language.close", new LanguageCloseArgs(wideDocument));
            var tableRequest = Request(firstId, 1, "SELECT * FROM dbo.Lang", firstConnection);
            var tables = await Complete(tableRequest);
            check(tables.Items.Any(item => item.Label.Contains("LanguageFixture", StringComparison.OrdinalIgnoreCase)), "real SQL Tools Service completes a fixture table from live database metadata");
            const string select = "SELECT f. FROM dbo.LanguageFixture AS f";
            var firstRequest = Request(firstId, 2, select, firstConnection, "SELECT f.".Length);
            var firstColumns = await Complete(firstRequest);
            check(Has(firstColumns, "FirstOnly") && !Has(firstColumns, "SecondOnly"), "first document completes columns from its own database");
            var secondRequest = Request(secondId, 1, select, secondConnection, "SELECT f.".Length);
            var secondColumns = await Complete(secondRequest);
            check(Has(secondColumns, "SecondOnly") && !Has(secondColumns, "FirstOnly"), "second document with identical SQL keeps its different database context");
            var paired = await Task.WhenAll(Complete(firstRequest), Complete(secondRequest));
            check(Has(paired[0], "FirstOnly") && !Has(paired[0], "SecondOnly") && Has(paired[1], "SecondOnly") && !Has(paired[1], "FirstOnly"),
                "concurrent completion requests preserve document and database isolation");

            const string edited = "SELECT f. FROM dbo.EditedFixture AS f";
            var editedColumns = await Complete(Request(firstId, 3, edited, firstConnection, "SELECT f.".Length));
            check(Has(editedColumns, "EditedOnly") && !Has(editedColumns, "FirstOnly"), "unsaved text edits replace the server buffer and update alias-bound column completion");
            const string hoverText = "SELECT f.FirstOnly FROM dbo.LanguageFixture AS f";
            var hover = await Call<LanguageHover?>("language.hover", Request(firstId, 4, hoverText, firstConnection, "SELECT f.First".Length));
            check(hover is not null && hover.Contents.Contains("FirstOnly", StringComparison.OrdinalIgnoreCase) && hover.Contents.Contains("int", StringComparison.OrdinalIgnoreCase),
                "real SQL Tools Service hover describes the live fixture column and its type");
            launchedProcesses = LanguageProcesses().Except(initialProcesses).ToHashSet();
            check(launchedProcesses.Count > 0, "live language requests launch the actual bundled SQL Tools Service child process");

            // Keep real query-tab state open while a separate connection changes this run's fixture schema. A
            // language refresh must never achieve freshness by restarting the backend or closing its SQL sessions.
            var session = await Call<QueryResult>("query.execute", new QueryArgs(firstConnection.Id, firstId, firstDatabase,
                "CREATE TABLE #language_refresh_probe (value int NOT NULL); INSERT INTO #language_refresh_probe VALUES (37); BEGIN TRANSACTION; SELECT @@SPID, @@TRANCOUNT;",
                Guid.NewGuid().ToString(), 10, 30));
            check(session.Status == "completed" && session.Spid is not null, "refresh regression retains a query session with an open transaction and a session-local table");
            check(!Has(firstColumns, "RefreshedOnly"), "the warmed metadata predates the new fixture column");
            var alteration = await Sql("ALTER TABLE dbo.LanguageFixture ADD RefreshedOnly decimal(12,3) NULL; CREATE TABLE dbo.RefreshedFixture (NewObjectOnly date NOT NULL);", firstDatabase);
            check(alteration.Status == "completed", "a separate SQL connection changes only this run's fixture schema after metadata warmup");
            var refresh = Call<LanguageRefreshResult>("language.refresh", new LanguageRefreshRequest(firstId, 4, hoverText,
                new("sqlserver", firstConnection.Id, firstDatabase)));
            var siblingDuringRefresh = await Complete(secondRequest);
            check((await refresh).Refreshed && Has(siblingDuringRefresh, "SecondOnly") && !Has(siblingDuringRefresh, "RefreshedOnly"),
                "targeted cache refresh completes while an unrelated database continues serving its own metadata");
            check(LanguageProcesses().Except(initialProcesses).ToHashSet().SetEquals(launchedProcesses), "cache refresh retains the actual SQL Tools Service process");
            var refreshedColumns = await Complete(Request(firstId, 5, select, firstConnection, "SELECT f.".Length));
            check(Has(refreshedColumns, "RefreshedOnly") && Has(refreshedColumns, "FirstOnly"), "one completion after refresh exposes the newly added live column");
            const string refreshedHoverText = "SELECT f.RefreshedOnly FROM dbo.LanguageFixture AS f";
            var refreshedHover = await Call<LanguageHover?>("language.hover", Request(firstId, 6, refreshedHoverText, firstConnection, "SELECT f.Refreshed".Length));
            check(refreshedHover is not null && refreshedHover.Contents.Contains("RefreshedOnly", StringComparison.OrdinalIgnoreCase)
                && refreshedHover.Contents.Contains("decimal", StringComparison.OrdinalIgnoreCase), "hover after refresh describes the new column and its actual SQL type");
            var refreshedTables = await Complete(Request(firstId, 7, "SELECT * FROM dbo.Refreshed", firstConnection));
            check(refreshedTables.Items.Any(item => item.Label.Contains("RefreshedFixture", StringComparison.OrdinalIgnoreCase)), "one completion after refresh exposes the newly created live table");
            var retained = await Call<QueryResult>("query.execute", new QueryArgs(firstConnection.Id, firstId, firstDatabase,
                "SELECT @@SPID, @@TRANCOUNT, value FROM #language_refresh_probe;", Guid.NewGuid().ToString(), 10, 30));
            var retainedRows = retained.ResultSets.Count > 0 ? LiveResultChecks.RowsOf(service.Results, retained.ResultSets[0]) : [];
            check(retained.Status == "completed" && retained.Spid == session.Spid && retainedRows.Count == 1
                && retainedRows[0][1] == "1" && retainedRows[0][2] == "37", "refresh preserves the query's SPID, open transaction and session-local data");
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(firstId, "rollback"), Json), Json);

            async Task<int> ChildSessions(string database)
            {
                await using var command = new SqlCommand("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND database_id = DB_ID(@database) AND host_process_id <> @parent;", probe) { CommandTimeout = 10 };
                command.Parameters.AddWithValue("@database", database);
                command.Parameters.AddWithValue("@parent", Environment.ProcessId);
                return Convert.ToInt32(await command.ExecuteScalarAsync(), CultureInfo.InvariantCulture);
            }
            async Task<bool> Released(string database)
            {
                var watch = Stopwatch.StartNew();
                while (true)
                {
                    if (await ChildSessions(database) == 0) return true;
                    if (watch.Elapsed >= TimeSpan.FromSeconds(10)) return false;
                    await Task.Delay(100);
                }
            }
            check((await Call<LanguageCloseResult>("language.close", new LanguageCloseArgs(firstId))).Closed && await Released(firstDatabase),
                "closing one language document releases its external metadata sessions");
            check(Has(await Complete(secondRequest), "SecondOnly"), "closing another document leaves the remaining database document usable");
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(secondConnection.Id), Json), Json);
            check(await Released(secondDatabase), "disconnecting a backend connection releases SQL Tools Service metadata sessions");
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(firstConnection.Id), Json), Json);
            Console.WriteLine("SQL language live metadata, edits, isolation, hover, targeted refresh, query state and cleanup verified.");
        }
        finally { await scratch.DisposeAsync(); }
        var exit = Stopwatch.StartNew();
        while (LanguageProcesses().Overlaps(launchedProcesses) && exit.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(50);
        check(!LanguageProcesses().Overlaps(launchedProcesses), "backend disposal terminates the actual SQL Tools Service child process");
        foreach (var database in new[] { firstDatabase, secondDatabase }.OfType<string>())
        {
            await using var gone = new SqlCommand("SELECT CASE WHEN DB_ID(@name) IS NULL THEN 1 ELSE 0 END;", probe);
            gone.Parameters.AddWithValue("@name", database);
            check(Convert.ToInt32(await gone.ExecuteScalarAsync(), CultureInfo.InvariantCulture) == 1, "language live scratch database is removed after validation");
        }
    }

    private static HashSet<int> LanguageProcesses()
    {
        HashSet<int> ids = [];
        foreach (var process in Process.GetProcessesByName("MicrosoftSqlToolsServiceLayer"))
            using (process) ids.Add(process.Id);
        return ids;
    }
}
