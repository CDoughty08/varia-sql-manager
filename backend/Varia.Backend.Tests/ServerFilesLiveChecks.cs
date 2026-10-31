using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live server file picker checks (actions.describe 'serverFiles'). Read-only: the roots (drives or /, and the
/// default folders), master's own files through each purpose's type filter, a missing folder, a file, another platform's
/// path and hostile paths as values, a level-0 listing of the drive within a generous bound, truncation under a smaller
/// limit, and SQL Server 2016's statements on this server. With VARIA_TEST_SQL_SCRATCH=1: a low-privilege login's listing
/// (and 2016's silent nothing for it, legacyEmpty), and on Linux a scratch database's backup file in the backup folder.</summary>
internal static class ServerFilesLiveChecks
{
    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public async Task<ActionDescribeResult> List(string purpose, string? path = null, bool? all = null, bool? exists = null) =>
            (ActionDescribeResult)await service.DispatchAsync("actions.describe", JsonSerializer.SerializeToElement(
                new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "serverFiles", new ObjectRefDto("server"), new ServerFilesArgsDto(purpose, path, all, exists)), json), json);
    }

    private static string Describe(ActionDescribeResult result) => result.Error is { } error ? error.Code + " " + error.Message
        : result.ServerFiles is { } listing ? listing.Entries.Count + " entries, " + listing.Roots.Count + " roots" : "nothing";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 1000, 120, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        var client = new Client(service, info.Id, json);
        var facts = (await Sql("SELECT CONVERT(nvarchar(1), SERVERPROPERTY('PathSeparator')), CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')), "
            + "CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)), (SELECT physical_name FROM sys.master_files WHERE database_id = 1 AND file_id = 1), "
            + "(SELECT physical_name FROM sys.master_files WHERE database_id = 1 AND file_id = 2);")).Sets[0][0];
        var separator = facts[0] ?? "\\";
        var linux = separator == "/";
        var sysadmin = facts[2] == "1";
        var dataFolder = ServerPath.Folder(facts[1] ?? "", linux);
        static (string Folder, string Name) Split(string path, string separator) => (path[..(path.LastIndexOf(separator, StringComparison.Ordinal) + 1)], path[(path.LastIndexOf(separator, StringComparison.Ordinal) + 1)..]);
        var (masterFolder, masterFile) = Split(facts[3]!, separator);
        var (logFolder, logFile) = Split(facts[4]!, separator);
        bool Same(string a, string b) => ServerPath.Same(a, b, linux);
        bool Has(ServerFilesDto listing, string name, bool directory = false) => listing.Entries.Any(entry => entry.Directory == directory && Same(entry.Name, name));
        bool Ordered(ServerFilesDto listing) => listing.Entries.SkipWhile(entry => entry.Directory).All(entry => !entry.Directory);

        // The roots: the server's separator, its drives (Windows) or / (Linux), and the default data folder with its tag.
        var roots = await client.List("backup");
        check(roots is { Error: null, ServerFiles: { Path: null, Entries: [], Truncated: false, Notice: null } listed } && listed.Separator == separator
            && (linux ? listed.Roots[0] is { Path: "/", Kind: "drive" } : listed.Roots.Any(root => root.Kind == "drive" && root.Path.Length == 3 && root.Path.EndsWith(":\\", StringComparison.Ordinal) && root.FreeMb > 0))
            && (dataFolder is null || listed.Roots.Any(root => Same(root.Path, dataFolder) && root.Defaults?.Contains("data") == true))
            && listed.Roots.All(root => root.Path.EndsWith(separator, StringComparison.Ordinal)) && listed.Roots.Select(root => root.Path.ToLowerInvariant()).Distinct().Count() == listed.Roots.Count,
            "the picker's roots are the server's drives (or / on Linux) and its default folders, one row per folder, each ending with the server's separator: " + Describe(roots));

        // master's own files through each purpose's type filter, folders first.
        var data = await client.List("database", masterFolder.TrimEnd(separator[0]));
        var dataEntry = data.ServerFiles?.Entries.FirstOrDefault(entry => !entry.Directory && Same(entry.Name, masterFile));
        check(data is { Error: null, ServerFiles: { } dataListing } && Same(dataListing.Path!, masterFolder) && dataListing.Path!.EndsWith(separator, StringComparison.Ordinal) && Ordered(dataListing)
            && dataEntry is { SizeBytes: > 0, Modified: { Length: 19 } } && dataListing.Entries.All(entry => entry.Directory || entry.Name.EndsWith(".mdf", StringComparison.OrdinalIgnoreCase)),
            "Locate Database Files lists master's data folder, given without its separator: master's .mdf with its size and time, folders first, and only .mdf files: " + Describe(data));
        var logs = await client.List("log", logFolder);
        var folders = await client.List("folder", masterFolder);
        var all = await client.List("backup", masterFolder, true);
        var backups = await client.List("backup", masterFolder);
        check(logs.ServerFiles is { } logListing && Has(logListing, logFile) && logListing.Entries.All(entry => entry.Directory || entry.Name.EndsWith(".ldf", StringComparison.OrdinalIgnoreCase))
            && folders.ServerFiles is { } folderListing && folderListing.Entries.All(entry => entry.Directory)
            && all.ServerFiles is { } allListing && Has(allListing, masterFile) && (!Same(masterFolder, logFolder) || Has(allListing, logFile)) && Ordered(allListing)
            && backups.ServerFiles is { } backupListing && !Has(backupListing, masterFile) && backupListing.Entries.All(entry => entry.Directory || entry.Name.EndsWith(".bak", StringComparison.OrdinalIgnoreCase) || entry.Name.EndsWith(".trn", StringComparison.OrdinalIgnoreCase)),
            "each purpose keeps its own extensions (log .ldf, backup .bak and .trn), a folder picker lists folders only, and All Files lists every file: " + Describe(logs) + " | " + Describe(all));
        if (!linux)
        {
            var slashes = await client.List("database", masterFolder.Replace('\\', '/'));
            check(slashes.ServerFiles is { } slashed && slashed.Path == masterFolder.Replace('/', '\\') && Has(slashed, masterFile), "on Windows a path typed with forward slashes lists the same folder, written with backslashes");
        }

        // Values, never exceptions: a missing folder, hostile names, a file, another platform's path.
        var missing = await client.List("backup", masterFolder + "VariaNoSuchFolder_" + Guid.NewGuid().ToString("N"));
        var hostile = await client.List("backup", masterFolder + "O'Brien ]] --; DROP TABLE x; '" + separator);
        var file = await client.List("backup", masterFolder + masterFile);
        var foreign = await client.List("backup", linux ? "C:\\Backups" : "/var/opt/mssql/data");
        check(missing is { ServerFiles: null, Error: { Code: "PATH_NOT_FOUND", Retryable: false } } && missing.Error.Message.Contains("does not exist", StringComparison.Ordinal)
            && hostile is { ServerFiles: null, Error.Code: "PATH_NOT_FOUND" } && file is { ServerFiles: null, Error.Code: "PATH_NOT_FOUND" } && file.Error.Message.EndsWith("is a file, not a folder.", StringComparison.Ordinal)
            && foreign is { ServerFiles: null, Error.Code: "PATH_NOT_FOUND" } && foreign.Error.Message.Contains("is not a full path on this server", StringComparison.Ordinal),
            "a missing folder, a path holding quotes, brackets and a comment, a file and another platform's path are PATH_NOT_FOUND values: " + Describe(missing) + " | " + Describe(file) + " | " + Describe(foreign));

        // A check of one path, for a name a listing does not show: its own entry (a file, or a folder given with or without its
        // separator), or none for a missing one, and on Windows forward slashes are the server's backslashes.
        var masterPath = masterFolder + masterFile;
        var hasFile = await client.List("backup", masterPath, exists: true);
        var hasFolder = await client.List("backup", masterFolder, exists: true);
        var hasNothing = await client.List("backup", masterFolder + "VariaNoSuchFile_" + Guid.NewGuid().ToString("N") + ".bak", exists: true);
        var forward = linux ? hasFile : await client.List("backup", masterPath.Replace('\\', '/'), exists: true);
        check(hasFile is { Error: null, ServerFiles: { Entries: [{ Directory: false } fileEntry], Truncated: false, Notice: null } fileCheck } && Same(fileEntry.Name, masterFile) && fileCheck.Path == masterPath
            && hasFolder is { Error: null, ServerFiles: { Entries: [{ Directory: true }] } folderCheck } && Same(folderCheck.Path! + separator, masterFolder)
            && hasNothing is { Error: null, ServerFiles: { Entries: [], Notice: null } } && forward is { ServerFiles.Entries: [{ Directory: false }], ServerFiles.Path: { } forwardPath } && forwardPath == masterPath,
            "a check finds master's data file as a file and its folder as a folder, finds nothing for a missing name, and writes the path as the server does: "
            + Describe(hasFile) + " | " + Describe(hasFolder) + " | " + Describe(hasNothing));

        // One level of the drive, never the tree below it: SMO's level-0 form stays fast with the ORDER BY and the type filter.
        var drive = linux ? "/" : masterFolder[..3];
        var (timed, ms) = await LiveResultChecks.OnceMore("the picker's listing of " + drive, 2000, item => item.Ms, async () =>
        {
            var watch = Stopwatch.StartNew();
            var result = await client.List("backup", drive);
            return (Result: result, Ms: watch.ElapsedMilliseconds);
        });
        check(timed is { Error: null, ServerFiles: { Entries.Count: > 0, Truncated: false } } && ms < 2000, "the drive's root lists one level within 2 s (" + ms + " ms): " + Describe(timed));

        // Truncation under a smaller limit: one more row than the limit is read, and the listing says it stopped.
        var json2 = JsonNode.Parse(File.ReadAllText(Fixtures.Path("backend/Varia.Backend/Actions/actions-catalog.json")))!;
        json2["limits"]!["browseEntries"] = 2;
        using var small = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json2.ToJsonString()));
        var limited = ActionsCatalog.Parse(small);
        var (cut, cutError) = await service.Actions.ListServerFilesAsync(info.Id, new("backup", drive, true), legacy: false, limited, CancellationToken.None);
        var (whole, _) = await service.Actions.ListServerFilesAsync(info.Id, new("backup", drive, true), legacy: false, null, CancellationToken.None);
        check(cutError is null && cut is { Truncated: true, Entries.Count: 2 } && whole is { Entries.Count: > 2 } && cut.Entries.Select(entry => entry.Name).SequenceEqual(whole.Entries.Take(2).Select(entry => entry.Name)),
            "a folder with more entries than the limit lists the first ones in order and says it was truncated");

        // SQL Server 2016's statements (xp_dirtree, xp_fileexist, xp_fixeddrives) on this server, as a member of sysadmin.
        if (sysadmin)
        {
            var (legacy, legacyError) = await service.Actions.ListServerFilesAsync(info.Id, new("database", masterFolder), legacy: true, null, CancellationToken.None);
            var (legacyRoots, _) = await service.Actions.ListServerFilesAsync(info.Id, new("backup"), legacy: true, null, CancellationToken.None);
            var (legacyMissing, legacyMissingError) = await service.Actions.ListServerFilesAsync(info.Id, new("backup", masterFolder + "VariaNoSuchFolder_" + Guid.NewGuid().ToString("N")), legacy: true, null, CancellationToken.None);
            var (legacyFile, _) = await service.Actions.ListServerFilesAsync(info.Id, new("backup", masterFolder + masterFile, Exists: true), legacy: true, null, CancellationToken.None);
            var (legacyNone, _) = await service.Actions.ListServerFilesAsync(info.Id, new("backup", masterFolder + "VariaNoSuchFile_" + Guid.NewGuid().ToString("N"), Exists: true), legacy: true, null, CancellationToken.None);
            check(legacyError is null && legacy is { Notice: null } && legacy.Entries.FirstOrDefault(entry => Same(entry.Name, masterFile)) is { Directory: false, SizeBytes: null, Modified: null }
                && legacy.Entries.All(entry => entry.Directory || entry.Name.EndsWith(".mdf", StringComparison.OrdinalIgnoreCase)) && Ordered(legacy)
                && legacyRoots is { } oldRoots && roots.ServerFiles is { } newRoots
                && oldRoots.Roots.Where(root => root.Kind == "drive").Select(root => root.Path).SequenceEqual(newRoots.Roots.Where(root => root.Kind == "drive").Select(root => root.Path), StringComparer.OrdinalIgnoreCase)
                && legacyMissing is null && legacyMissingError?.Code == "PATH_NOT_FOUND"
                && legacyFile is { Notice: null, Entries: [{ Directory: false }] } && legacyNone is { Notice: null, Entries: [] },
                "SQL Server 2016's statements list the same folder and drives for a member of sysadmin, without sizes, find a missing folder, and check a file: " + legacyMissingError?.Code);
        }
        else Console.WriteLine("Server file picker checks of SQL Server 2016's statements skipped: the test login is not in sysadmin.");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1") return;
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        // On Linux a scratch database's backup goes to a file in the backup folder, which Locate Backup File must list.
        var backup = await ScratchDatabase.Backup.ForAsync((text, database) => Sql(text, database), scratch.Files);
        try
        {
            if (backup.IsFile)
            {
                await scratch.CreateFilesAsync();
                var made = await Sql(backup.DatabaseSql("COPY_ONLY, INIT"));
                var (folder, name) = Split(backup.Device, separator);
                var listing = await client.List("backup", folder);
                check(made.Status == "completed" && listing.ServerFiles is { } backupFolder && backupFolder.Entries.FirstOrDefault(entry => entry.Name == name) is { Directory: false, SizeBytes: > 0 },
                    "Locate Backup File lists a scratch database's .bak in the backup folder: " + Describe(listing));
            }
            else Console.WriteLine("Server file picker backup file check skipped: SQL Server on Windows backs scratch databases up to NUL.");
        }
        finally { await backup.ForgetAsync((text, database) => Sql(text, database)); }

        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Server file picker low-privilege checks skipped: this server accepts Windows logins only.");
            return;
        }
        var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        try
        {
            var low = new Client(service, connected.Id, json);
            var lowRoots = await low.List("backup");
            var lowData = await low.List("database", masterFolder);
            var (lowLegacy, lowLegacyError) = await service.Actions.ListServerFilesAsync(connected.Id, new("database", masterFolder), legacy: true, null, CancellationToken.None);
            var lowCheck = await low.List("database", masterFolder + masterFile, exists: true);
            var (lowLegacyCheck, lowLegacyCheckError) = await service.Actions.ListServerFilesAsync(connected.Id, new("database", masterFolder + masterFile, Exists: true), legacy: true, null, CancellationToken.None);
            check(lowRoots is { Error: null, ServerFiles: { } lowListed } && (dataFolder is null || lowListed.Roots.Any(root => Same(root.Path, dataFolder)))
                && lowData is { Error: null, ServerFiles: { } lowFiles } && Has(lowFiles, masterFile)
                && lowLegacyError is null && lowLegacy is { Notice: "legacyEmpty", Entries: [], Truncated: false }
                && lowCheck is { Error: null, ServerFiles: { Entries: [{ Directory: false }], Notice: null } } && lowLegacyCheckError is null && lowLegacyCheck is { Notice: "legacyEmpty", Entries: [] },
                "a login with no server permissions lists the roots and master's folder and checks master's file from SQL Server 2017, and SQL Server 2016's xp_dirtree and xp_fileexist answer it with nothing, which the listing and the check say (legacyEmpty): "
                + Describe(lowRoots) + " | " + Describe(lowData) + " | " + (lowLegacyError?.Code ?? lowLegacy?.Notice ?? "no notice"));
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json); }
    }
}
