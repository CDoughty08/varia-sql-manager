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
            && Catalog.Retryable("PATH_NOT_FOUND") == false, "the picker's budget, path length and entry limit are the catalogue's, and PATH_NOT_FOUND is not retryable");

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
        ActionDescribeArgs Files(string purpose, string? path = null, bool? all = null, ObjectRefDto? target = null, string dialog = "serverFiles") =>
            new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target ?? Server, new(purpose, path, all));
        var invalid = new (string Name, ActionDescribeArgs Args)[]
        {
            ("an unknown purpose", Files("archive")), ("a relative path", Files("backup", "Backups")), ("a wildcard", Files("backup", "C:\\*.bak")), ("261 units", Files("backup", "C:\\" + new string('x', 258))),
            ("a control character", Files("backup", "C:\\a\nb")), ("All Files for a folder", Files("folder", "C:\\", true)), ("a database target", Files("backup", target: new ObjectRefDto("database", Name: "AppData"))),
            ("a server with a name", Files("backup", target: new ObjectRefDto("server", Name: "x"))), ("files for another dialog", Files("backup", dialog: "deleteObject")),
            ("no files", new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "serverFiles", Server))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0 && Refused(Files("backup")) == "accepted" && Refused(Files("database", "\\\\files\\share\\O'Brien ]]\\", true)) == "accepted" && Refused(Files("folder", "/var/opt/mssql/")) == "accepted",
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
    }

    private sealed class FakeHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }
}
