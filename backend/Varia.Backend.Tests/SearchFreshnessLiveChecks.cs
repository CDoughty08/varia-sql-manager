using System.Security.Cryptography;
using Microsoft.Data.SqlClient;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Live SQL Server freshness checks (scratch only; docs/object-search.md, Freshness): DDL run through a query tab marks its
/// database stale and a script that only reads marks nothing; the next check verifies it by its fingerprint and reads again only
/// what changed, so the next search finds the new object; a check of an unchanged database keeps its read; a fingerprint that fails
/// keeps the held read and its mark.</summary>
internal static class SearchFreshnessLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, string connectionId, Func<string, string, Task<SqlRun>> sql, string scratch, Func<string, ConnectOptions> live)
    {
        var database = scratch + "_fr";
        string Bracket(string name) => "[" + name.Replace("]", "]]") + "]";
        var marker = "varia_fresh_" + Guid.NewGuid().ToString("N")[..8];
        async Task Run(string text, string name)
        {
            var run = await sql(text, database);
            check(run.Error is null, "the freshness checks " + name + ": " + run.Error);
        }
        var made = await sql("CREATE DATABASE " + Bracket(database) + ";", "master");
        check(made.Error is null, "the freshness checks create their database: " + made.Error);
        var storeRoot = Directory.CreateTempSubdirectory("varia-index-fresh-live-").FullName;
        var outcomes = new System.Collections.Concurrent.ConcurrentDictionary<string, string>(StringComparer.Ordinal);
        try
        {
            await Run("CREATE TABLE dbo." + marker + "_first (id int PRIMARY KEY); CREATE TABLE dbo.Other (id int);", "create tables");
            // A saving store: its reads keep the fingerprint a check verifies them by.
            service.Search.Store.Configure(new("encrypted", Path.Combine(storeRoot, IndexStoreLimits.FolderName), IndexStoreLimits.DefaultDiskMiB, Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))));
            await service.Search.Store.Idle();
            service.Search.CheckOutcome = (name, outcome) => { if (name == database) outcomes[name] = outcome; };
            service.Search.Forget(connectionId);
            var built = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None);
            check(built.Status is { State: "ready", Stale: null, ReadAt.Length: 20, CheckedAt.Length: 20 }, "a full build says when it read and checked the index, and that nothing may have changed");
            List<string> Names(string text) =>
                [.. service.Search.Search(new(connectionId, Guid.NewGuid().ToString(), text, false, false, false, "names", Database: database), CancellationToken.None).Hits.Select(hit => hit.Object.Kind + ":" + hit.Label)];
            async Task<ObjectIndexStatus> Check(string? only = null)
            {
                outcomes.Clear();
                return (await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString(), Stale: true, Database: only), CancellationToken.None)).Status;
            }

            var rows = await sql("SELECT COUNT(*) FROM dbo.Other; UPDATE dbo.Other SET id = id;", database);
            check(rows.Error is null && rows.IndexStale is null && !service.Search.SqlStaleOf(connectionId).Contains(database), "a query tab's script that only reads and writes rows marks nothing");

            var mark = service.Search.IndexStatus(new(connectionId)).Status.StaleMark ?? 0;
            var ddlRun = await sql("CREATE TABLE dbo." + marker + "_added (id int); EXEC sp_rename N'dbo.Other', N'" + marker + "_renamed';", database);
            check(ddlRun.Error is null && ddlRun.IndexStale > mark, "a query tab's DDL result names its new stale mark, so the window asks the check at once (" + ddlRun.IndexStale + " after " + mark + ")");
            var marked = service.Search.Search(new(connectionId, Guid.NewGuid().ToString(), marker, In: "names", Database: database), CancellationToken.None);
            check(service.Search.SqlStaleOf(connectionId).Contains(database) && marked.Index.StaleMark > mark && marked.Index.Stale >= 1 && marked.Hits.Count == 1,
                "DDL from a query tab marks its database stale, and a search says so while it answers from what is held");

            var status = await Check();
            check(outcomes.GetValueOrDefault(database) == "reread" && !service.Search.SqlStaleOf(connectionId).Contains(database) && status is { Stale: null, Checking: null, State: "ready" },
                "the next check verifies the database by its fingerprint and reads again only what changed (" + outcomes.GetValueOrDefault(database) + ")");
            check(Names(marker + "_added").Contains("table:dbo." + marker + "_added") && Names(marker + "_renamed").Contains("table:dbo." + marker + "_renamed")
                && Names("Other").All(hit => hit != "table:dbo.Other"), "the next search finds the new and renamed tables, and not the old name");

            await Check(database);
            check(outcomes.GetValueOrDefault(database) == "kept", "Refresh's check of an unchanged database keeps its read (" + outcomes.GetValueOrDefault(database) + ")");

            service.Search.ReloadFingerprint = _ => "SELECT 1/0;";
            try
            {
                await Run("CREATE TABLE dbo." + marker + "_late (id int);", "create a table");
                await Check();
                check(outcomes.GetValueOrDefault(database) == "failed" && service.Search.SqlStaleOf(connectionId).Contains(database) && Names(marker + "_first").Count == 1,
                    "a fingerprint that fails keeps the held read searchable and its mark (" + outcomes.GetValueOrDefault(database) + ")");
            }
            finally { service.Search.ReloadFingerprint = ObjectSearchSql.Fingerprint; }
            await Check();
            check(outcomes.GetValueOrDefault(database) == "reread" && Names(marker + "_late").Count == 1, "the check after it reads the change (" + outcomes.GetValueOrDefault(database) + ")");

            // DDL still open in another session: the check's fingerprint waits on it, gives up within its budget, and keeps the read and
            // the mark (as a deployment's open transaction would).
            await using (var open = new SqlConnection(new SqlConnectionStringBuilder(ConnectionSettings.Build(live(database)).ConnectionString) { Pooling = false }.ConnectionString))
            {
                await open.OpenAsync();
                await using var transaction = (SqlTransaction)await open.BeginTransactionAsync();
                await using (var ddl = open.CreateCommand())
                {
                    ddl.Transaction = transaction;
                    ddl.CommandText = "CREATE TABLE dbo." + marker + "_open (id int);";
                    await ddl.ExecuteNonQueryAsync();
                }
                service.Search.MarkSqlStale(connectionId, database);
                service.Search.FingerprintBudget = TimeSpan.FromSeconds(2);
                var waited = System.Diagnostics.Stopwatch.StartNew();
                try { await Check(); }
                finally { service.Search.FingerprintBudget = TimeSpan.FromSeconds(15); }
                check(outcomes.GetValueOrDefault(database) == "failed" && waited.Elapsed >= TimeSpan.FromSeconds(1.5) && service.Search.SqlStaleOf(connectionId).Contains(database),
                    "a check under DDL still open waits on it, gives up within the fingerprint's budget, and keeps the mark (" + outcomes.GetValueOrDefault(database) + ", " + waited.ElapsedMilliseconds + " ms)");
                await transaction.RollbackAsync();
            }
            await Check();
            check(outcomes.GetValueOrDefault(database) == "kept" && !service.Search.SqlStaleOf(connectionId).Contains(database), "once it rolls back, the next check keeps the read (" + outcomes.GetValueOrDefault(database) + ")");

            // A database created from a query tab: its mark is master's, and the check lists the new database and reads it whole.
            var created = database + "_new";
            var made2 = await sql("CREATE DATABASE " + Bracket(created) + ";", "master");
            check(made2.Error is null, "the freshness checks create a second database: " + made2.Error);
            try
            {
                await sql("CREATE TABLE dbo." + marker + "_elsewhere (id int);", created);
                var watch = System.Diagnostics.Stopwatch.StartNew();
                var answered = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString(), Stale: true), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(90));
                check(answered.Status is { Checking: null, State: "ready" } && service.Search.Search(new(connectionId, Guid.NewGuid().ToString(), marker + "_elsewhere", In: "names", Database: created), CancellationToken.None).Hits.Count == 1,
                    "a check after a database is created reads the new one whole and answers (" + watch.ElapsedMilliseconds + " ms, " + answered.Status.State + ")");
            }
            finally
            {
                SqlConnection.ClearAllPools();
                await sql("IF DB_ID(N'" + created.Replace("'", "''") + "') IS NOT NULL BEGIN ALTER DATABASE " + Bracket(created) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + Bracket(created) + "; END", "master");
            }
        }
        finally
        {
            service.Search.CheckOutcome = null;
            service.Search.ReloadFingerprint = ObjectSearchSql.Fingerprint;
            service.Search.Forget(connectionId);
            service.Search.Store.Configure(new("disabled", Path.Combine(storeRoot, IndexStoreLimits.FolderName), IndexStoreLimits.DefaultDiskMiB));
            await service.Search.Store.Idle();
            try { Directory.Delete(storeRoot, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            SqlConnection.ClearAllPools();
            await sql("IF DB_ID(N'" + database.Replace("'", "''") + "') IS NOT NULL BEGIN ALTER DATABASE " + Bracket(database) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + Bracket(database) + "; END", "master");
        }
    }
}
