using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the server file picker (actions.describe 'serverFiles'): the catalogue's purposes and limits,
/// the path rules against tests/fixtures/server-paths.json (which the zod schema's test reads too), the lint over its
/// statements and what the lint must catch, validation parity with zod, and the service's refusals before any connection.</summary>
internal static class ServerFilesChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto Server = new("server");

    public static async Task RunAsync(Action<bool, string> check)
    {
        check(Catalog.ServerFilePurposes.Keys.SequenceEqual(["backup", "database", "log", "folder"]) && Catalog.ServerFilePurposes["backup"].SequenceEqual([".bak", ".trn"])
            && Catalog.ServerFilePurposes["database"].SequenceEqual([".mdf"]) && Catalog.ServerFilePurposes["log"].SequenceEqual([".ldf"]) && Catalog.ServerFilePurposes["folder"].Count == 0
            && Catalog.ServerFilePurposes.Values.All(extensions => extensions.Count <= 2 && extensions.All(extension => extension.StartsWith('.') && extension.Length <= 16 && extension == extension.ToLowerInvariant())),
            "the catalogue's picker purposes keep at most two lower-case extensions each, which the listing binds as @e1 and @e2");
        var options = new ActionServiceOptions();
        check(Catalog.Limit("browseMs") == (long)options.BrowseBudget.TotalMilliseconds && Catalog.Limit("serverPath") == 260 && Catalog.Limit("browseEntries") == 2_000
            && Catalog.Limit("browsePerConnection") == options.BrowsePerConnection && options.BrowsePerConnection == 1 && Catalog.Retryable("PATH_NOT_FOUND") == false,
            "the picker's budget, path length, entry limit and gate are the catalogue's, and PATH_NOT_FOUND is not retryable");

        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/server-paths.json")));
        var root = fixture.RootElement;
        var wrong = new List<string>();
        foreach (var item in root.GetProperty("valid").EnumerateArray()) if (!ServerPath.Valid(item.GetString(), 260)) wrong.Add("refused " + item.GetString());
        foreach (var item in root.GetProperty("invalid").EnumerateArray()) if (ServerPath.Valid(item.GetString(), 260)) wrong.Add("accepted " + item.GetString());
        foreach (var item in root.GetProperty("folders").EnumerateArray())
        {
            var path = item.GetProperty("path").GetString()!;
            var expected = item.GetProperty("folder").ValueKind == JsonValueKind.Null ? null : item.GetProperty("folder").GetString();
            var folder = ServerPath.Folder(path, item.GetProperty("linux").GetBoolean());
            if (folder != expected) wrong.Add(path + " lists " + (folder ?? "nothing"));
        }
        foreach (var item in root.GetProperty("keys").EnumerateArray())
        {
            var path = item.GetProperty("path").GetString()!;
            var expected = item.GetProperty("key").ValueKind == JsonValueKind.Null ? null : item.GetProperty("key").GetString();
            var key = ServerPath.Key(path, item.GetProperty("linux").GetBoolean());
            if (key != expected) wrong.Add(path + " keys as " + (key ?? "nothing"));
        }
        check(wrong.Count == 0 && ServerPath.Valid("C:\\" + new string('x', 257), 260) && !ServerPath.Valid("C:\\" + new string('x', 258), 260)
            && !ServerPath.Valid("C:\\a\uD800b", 260) && !ServerPath.Valid("C:\\a\uDC00", 260) && ServerPath.Valid("C:\\a\uD83D\uDE00", 260) && !ServerPath.Valid(null, 260),
            "server paths follow tests/fixtures/server-paths.json, as zod does: 1–260 UTF-16 units, well formed, no control or wildcard characters, a drive, a share or /: " + string.Join("; ", wrong.Take(5)));

        var lint = ServerFiles.LintAll().ToList();
        var problems = lint.SelectMany(item => item.Problems.Select(problem => item.Name + ": " + problem)).ToList();
        check(lint.Count == 7 && problems.Count == 0, "every picker statement passes its lint: " + string.Join("; ", problems.Take(5)));
        check(ServerFiles.Lint("SELECT TOP (@take) f.file_or_directory_name FROM sys.dm_os_enumerate_filesystem(@path + N'x', N'*') AS f ORDER BY f.file_or_directory_name;").Count > 0
            && ServerFiles.Lint("SELECT TOP (@take) f.file_or_directory_name FROM sys.dm_os_enumerate_filesystem(N'C:\\', N'*') AS f ORDER BY f.file_or_directory_name;").Count > 0
            && ServerFiles.Lint("DECLARE @sql nvarchar(max) = N'x';\nEXEC (@sql);").Count > 0 && ServerFiles.Lint("SELECT OBJECT_ID(N'sys.dm_os_file_exists');").Count > 0
            && ServerFiles.Lint("SELECT f.file_or_directory_name FROM sys.dm_os_enumerate_filesystem(@path, N'*') AS f ORDER BY f.file_or_directory_name;").Count > 0
            && ServerFiles.Lint("SELECT @path;").Count > 0 && ServerFiles.Lint("EXEC sys.sp_executesql @path;").Count > 0,
            "the picker's lint refuses a spliced or literal path, dynamic SQL, metadata functions, a listing without TOP (@take) and the path outside the file functions");
        // Level 0 is what keeps the listing from walking the whole drive (probed: 161,114 folders under C:\ without it).
        check(ServerFiles.List.Contains("WHERE f.[level] = 0 AND ", StringComparison.Ordinal) && ServerFiles.LegacyList.Contains("xp_dirtree @path, 1, 1", StringComparison.Ordinal)
            && ServerFiles.LegacyList.Contains("t.depth = 1", StringComparison.Ordinal), "a listing reads one level of the folder, never the tree below it");

        using var service = new ActionService(new FakeHost());
        string Refused(ActionDescribeArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ActionDescribeArgs Files(string purpose, string? path = null, bool? all = null, ObjectRefDto? target = null, string dialog = "serverFiles", bool? exists = null) =>
            new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target ?? Server, new(purpose, path, all, exists));
        var invalid = new (string Name, ActionDescribeArgs Args)[]
        {
            ("an unknown purpose", Files("archive")), ("a relative path", Files("backup", "Backups")), ("a wildcard", Files("backup", "C:\\*.bak")), ("261 units", Files("backup", "C:\\" + new string('x', 258))),
            ("a control character", Files("backup", "C:\\a\nb")), ("All Files for a folder", Files("folder", "C:\\", true)), ("a database target", Files("backup", target: new ObjectRefDto("database", Name: "AppData"))),
            ("a server with a name", Files("backup", target: new ObjectRefDto("server", Name: "x"))), ("files for another dialog", Files("backup", dialog: "deleteObject")),
            ("no files", new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "serverFiles", Server)), ("a check without a path", Files("backup", exists: true)),
            ("a check with a type filter", Files("backup", "C:\\x.bak", false, exists: true))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0 && Refused(Files("backup")) == "accepted" && Refused(Files("database", "\\\\files\\share\\O'Brien ]]\\", true)) == "accepted" && Refused(Files("folder", "/var/opt/mssql/")) == "accepted"
            && Refused(Files("backup", "\\\\files\\share\\O'Brien ]].bak", exists: true)) == "accepted",
            "Validate refuses what zod refuses for the picker and accepts hostile paths verbatim: " + string.Join(", ", accepted));

        var cloudHost = new FakeHost(5);
        using var cloud = new ActionService(cloudHost);
        var refused = await cloud.DescribeAsync(Files("backup"), CancellationToken.None);
        var managedHost = new FakeHost(8);
        using var managed = new ActionService(managedHost);
        var instance = await managed.DescribeAsync(Files("backup"), CancellationToken.None);
        check(refused is { Error.Code: "NOT_SUPPORTED", ServerFiles: null } && cloudHost.Connections == 0 && instance.Error is { Code: "NOT_SUPPORTED", Message: ActionService.ManagedInstanceFilesMessage }
            && managedHost.Connections == 0 && managed.RunningCount == 0, "Azure SQL Database and Managed Instance answer the picker NOT_SUPPORTED before any connection opens");
        var unreachable = new FakeHost();
        using var offline = new ActionService(unreachable);
        var lost = await offline.DescribeAsync(Files("backup", "C:\\"), CancellationToken.None);
        check(lost is { Error.Code: "CONNECTION_LOST", ServerFiles: null } && unreachable.Connections == 1 && offline.RunningCount == 0, "a picker listing that cannot connect is a value, and frees its request");
        await GatesAsync(check);
    }

    /// <summary>SQL Server honours an attention only once a file-system call returns (about 21 s for an unreachable share), so a
    /// listing past its budget still holds its gate. Listings stuck on four servers, as many as the read gates allow in total,
    /// leave Database Properties and Delete Object their gates on those servers and others; a second listing on a stuck server
    /// waits only for its own.</summary>
    private static async Task GatesAsync(Action<bool, string> check)
    {
        var host = new StuckHost();
        using var service = new ActionService(host);
        // A listing's job must reach its open within the budget, which starts with the request; a starved CI runner can start
        // the job's Task.Run hundreds of milliseconds late, and a job cancelled before its gate never opens.
        service.Options.BrowseBudget = TimeSpan.FromMilliseconds(1000);
        service.Options.GateWait = TimeSpan.FromSeconds(5);
        var servers = Enumerable.Range(0, service.Options.ReadTotal).Select(_ => Guid.NewGuid().ToString()).ToList();
        ActionDescribeArgs Listing(string connectionId) => new(connectionId, Guid.NewGuid().ToString(), "serverFiles", Server, new("backup", "\\\\unreachable\\share\\"));
        var stuck = servers.Select(server => service.DescribeAsync(Listing(server), CancellationToken.None)).ToList();
        var watch = Stopwatch.StartNew();
        while (host.Held < servers.Count && watch.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(10);
        var timedOut = await Task.WhenAll(stuck);
        var second = await service.DescribeAsync(Listing(servers[0]), CancellationToken.None);
        host.Blocking = false;
        async Task<string> Describe(string connectionId)
        {
            try { return (await service.DescribeAsync(new(connectionId, Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("table", "AppData", "dbo", "Orders")), CancellationToken.None)).Error?.Code ?? "none"; }
            catch (RequestException error) { return error.Code; }
        }
        var sameServer = await Describe(servers[0]);
        var otherServer = await Describe(Guid.NewGuid().ToString());
        // Counted while the stuck listings still hold their gates. A listing answers TIMEOUT before its job hears of it (the
        // job's token is cancelled from the pool), so once the gate is released the second listing's job can win it and open
        // a seventh connection before that cancel lands: seen on a starved CI runner, and no fault of the gate.
        var heldWhile = host.Held;
        var openedWhile = host.OpenedBy();
        host.Release();
        watch.Restart();
        while (service.ActiveJobs > 0 && watch.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(10);
        var opens = servers.Select(server => openedWhile.GetValueOrDefault(server)).ToList();
        check(timedOut.All(result => result.Error?.Code == "TIMEOUT") && heldWhile == servers.Count && second.Error?.Code == "TIMEOUT" && opens[0] == 2 && opens.Skip(1).All(count => count == 1)
            && openedWhile.Values.Sum() == servers.Count + 2 && sameServer == "CONNECTION_LOST" && otherServer == "CONNECTION_LOST" && service.ActiveJobs == 0 && service.RunningCount == 0,
            "listings stuck past their budget hold only the picker's own gate: a second listing on that server waits for it, and describes on that server and others still open (their unreachable fake answers CONNECTION_LOST, not BUSY): "
            + string.Join(", ", timedOut.Select(result => result.Error?.Code)) + " | " + second.Error?.Code + " | " + sameServer + " | " + otherServer + " | " + heldWhile + " held, opened while held: "
            + string.Join("+", opens) + " on the stuck servers (the first has the describe's too), " + openedWhile.Values.Sum() + " in all; " + host.Opened + " once released, " + service.ActiveJobs + " jobs left");
    }

    // These checks exercise gates and error mapping. Real failed opens can time out in SqlClient's non-pooled-open
    // throttle on a starved runner before reaching the deliberately unreachable endpoint.
    private static SqlException Refused() => ConnectionFailureChecks.Sql(53, 0, 20, "offline", "The fixture refused the connection.");

    /// <summary>A server whose connections never open while Blocking holds them, whatever their token says, as a file-system call
    /// SQL Server is waiting on ignores the attention; Release lets them fail.</summary>
    internal sealed class StuckHost : IActionHost
    {
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int held, opened;
        public volatile bool Blocking = true;
        public int Held => Volatile.Read(ref held);
        public int Opened => Volatile.Read(ref opened);
        public void Release() => released.TrySetResult();
        public ServerProfile Profile(string connectionId) => Box2022;
        private readonly ConcurrentDictionary<string, int> openedBy = new();
        /// <summary>The opens so far, by Varia connection.</summary>
        public Dictionary<string, int> OpenedBy() => new(openedBy);
        public SqlConnection Connection(string connectionId) => new("Application Name=" + connectionId + ";Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        public async Task OpenAsync(SqlConnection connection, CancellationToken token)
        {
            openedBy.AddOrUpdate(new SqlConnectionStringBuilder(connection.ConnectionString).ApplicationName, 1, (_, count) => count + 1);
            Interlocked.Increment(ref opened);
            if (Blocking)
            {
                Interlocked.Increment(ref held);
                await released.Task;
                throw new OperationCanceledException(token);
            }
            token.ThrowIfCancellationRequested();
            throw Refused();
        }
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }

    private sealed class FakeHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            throw Refused();
        }
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }
}
