using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live Attach Databases checks (D1d), with VARIA_TEST_SQL_SCRATCH=1 only. A marked scratch database of three files
/// (<see cref="ScratchDatabase.Attach"/>) is detached; its .mdf is described (its database, its files where they are, a file
/// that is not primary and a missing one as values), the server builds exactly AttachSql.Statement for hostile names and paths,
/// Script says the same, the preflight refuses a taken name and a missing owner, OK attaches it under a hostile name with an
/// owner, a second database whose file is missing rolls the first back, Stop between two attaches and Stop that loses the race
/// with a finished attach both leave nothing attached, a database newer than the server is refused by Add and by OK, FOR
/// ATTACH_REBUILD_LOG builds a new log for one deleted, and a login without CREATE ANY DATABASE is refused. Paths come from the server (its default data and log folders), so it runs on Linux as on
/// Windows; everything is dropped in finally, the files attached again first if they are left detached.</summary>
internal static class AttachLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Attach Databases live checks skipped: they need VARIA_TEST_SQL_SCRATCH=1.");
            return;
        }
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
        static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        async Task<ActionDescribeResult> Describe(string? mdf, string connectionId) => (ActionDescribeResult)await service.DispatchAsync("actions.describe", JsonSerializer.SerializeToElement(
            new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), ActionService.AttachDialog, new ObjectRefDto("server"), Attach: mdf is null ? null : new(mdf)), json), json);
        ActionArgs Args(string connectionId, params AttachDatabaseDto[] databases) => new("attach", connectionId, Guid.NewGuid().ToString(), new ObjectRefDto("server"), Databases: [.. databases]);
        async Task<ActionExecuteResult> Execute(string connectionId, params AttachDatabaseDto[] databases) =>
            (ActionExecuteResult)await service.DispatchAsync("actions.execute", JsonSerializer.SerializeToElement(Args(connectionId, databases), json), json);
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Detail + " " + step.Status + (step.Compensates == true ? " (undo)" : "")))
            + (result.Error is { } error ? " | " + error.Code + " " + error.Message : "");
        static string Said(ActionDescribeResult result) => result.Error is { } error ? error.Code + " " + error.Message
            : result.AttachDatabase?.Database is { } database ? database.DatabaseName + " " + string.Join(", ", database.Files.Select(file => file.Type + " " + file.Found)) : "facts only";

        var facts = (await Sql("SELECT CONVERT(nvarchar(1), SERVERPROPERTY('PathSeparator')), CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')), "
            + "CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultLogPath')), CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)), SUSER_SNAME();")).Sets[0][0];
        var separator = facts[0] ?? "\\";
        var linux = separator == "/";
        var dataFolder = ServerPath.Folder(facts[1] ?? "", linux);
        var logFolder = ServerPath.Folder(facts[2] ?? "", linux) ?? dataFolder;
        if (dataFolder is null || logFolder is null || facts[3] != "1")
        {
            Console.WriteLine("Attach Databases live checks skipped: the server names no default data folder, or the test login is not in sysadmin.");
            return;
        }
        bool Same(string a, string b) => ServerPath.Same(a, b, linux);

        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var files = await scratch.CreateAttachAsync(dataFolder, logFolder);
        var (mdf, ndf, ldf) = (files[0], files[1], files[2]);
        var missing = dataFolder + scratch.Attach + "_missing.mdf";
        async Task<string?> Attached() => (await Sql("SELECT name FROM sys.databases WHERE name IN (" + Quote(scratch.Attach) + ", " + Quote(scratch.AttachAs) + ", " + Quote(scratch.AttachMissing) + ");")).Scalar;
        await scratch.DetachAsync(scratch.Attach);

        // The facts Attach Databases opens with, then the detached .mdf: its database and files, each found where it recorded them.
        var opened = await Describe(null, info.Id);
        check(opened is { Error: null, AttachDatabase: { Database: null, Server: { } server } } && server.Separator == separator && server.Logins.Count > 0
            && server.DataPath is { } path && Same(path, dataFolder) && (facts[4] is null || server.Logins.Contains(facts[4]!) || server.LoginsTruncated),
            "Attach Databases opens with the server's logins, its separator and its default data folder: " + Said(opened));
        var read = await Describe(mdf, info.Id);
        // In the order the primary file records them (file_id): CREATE DATABASE gives the log file_id 2, so the second data file is third.
        check(read is { Error: null, AttachDatabase.Database: { } database } && database.DatabaseName == scratch.Attach && database.Mdf == mdf && database.Version > 0
            && database.Files.Count == 3 && database.Files[0] is { Type: "data", Found: true } first && first.Current == mdf && Same(first.Original, mdf)
            && database.Files[1] is { Type: "log", Found: true } log && Same(log.Current, ldf) && Same(log.Original, ldf)
            && database.Files[2] is { Type: "data", Found: true } second && Same(second.Current, ndf) && Same(second.Original, ndf),
            "Add reads a detached .mdf with DBCC CHECKPRIMARYFILE: its database's name and version, and its data and log files in file_id order, each found where the database recorded it: " + Said(read));
        var (legacy, legacyError) = await service.Actions.ReadPrimaryAsync(info.Id, mdf, legacy: true, CancellationToken.None);
        var notPrimary = await Describe(ndf, info.Id);
        var gone = await Describe(missing, info.Id);
        check(legacyError is null && legacy is { Files.Count: 3 } && legacy.Files.All(file => file.Found == true)
            && notPrimary is { AttachDatabase: null, Error.Code: "NOT_SUPPORTED" } && notPrimary.Error.Message.EndsWith("is not the primary data file of a database.", StringComparison.Ordinal)
            && gone is { AttachDatabase: null, Error: { Code: "FILE_ACCESS" or "PATH_NOT_FOUND" or "NOT_SUPPORTED" } },
            "SQL Server 2016's file check agrees for sysadmin, a secondary data file is not a primary one, and a missing file is a value: " + Said(notPrimary) + " | " + Said(gone));

        // The server builds exactly the statement Script shows, for hostile names and paths; Script runs nothing.
        var hostile = new AttachStatement(scratch.AttachAs, [mdf, dataFolder + "O'Brien ]]; --" + separator + "x''y ✓.ndf", logFolder + "N'evil'.ldf"], false);
        var built = await service.Actions.DryRunAttachAsync(info.Id, hostile, CancellationToken.None);
        var rebuilt = await service.Actions.DryRunAttachAsync(info.Id, hostile with { Files = [mdf], RebuildLog = true }, CancellationToken.None);
        var script = (ActionScriptResult)await service.DispatchAsync("actions.script", JsonSerializer.SerializeToElement(Args(info.Id, new AttachDatabaseDto(scratch.AttachAs, [mdf, ndf, ldf], false)), json), json);
        check(built.Count == 1 && built[0] == AttachSql.Statement(hostile) && rebuilt.Count == 1 && rebuilt[0] == AttachSql.Statement(hostile with { Files = [mdf], RebuildLog = true })
            && script is { Error: null, Database: "master", Text: { } text } && text == AttachSql.ScriptText(new(scratch.AttachAs, [mdf, ndf, ldf], false)) && await Attached() is null,
            "the server builds exactly the CREATE DATABASE … FOR ATTACH (and ATTACH_REBUILD_LOG) Script shows for hostile names and paths, and Script runs nothing: " + (built.FirstOrDefault() ?? "nothing"));

        // The preflight refuses before anything runs: a taken name, a missing owner.
        var taken = await Execute(info.Id, new AttachDatabaseDto("master", [mdf, ndf, ldf], false));
        var noOwner = await Execute(info.Id, new AttachDatabaseDto(scratch.AttachAs, [mdf, ndf, ldf], false, scratch.Name + "_nologin"));
        check(taken is { Steps: [], Error.Code: "NAME_IN_USE" } && noOwner is { Steps: [], Error.Code: "NOT_FOUND" } && await Attached() is null,
            "the preflight refuses a name a database has and an owner no login has, before anything runs: " + Steps(taken) + " | " + Steps(noOwner));

        // OK attaches the files under a hostile name with an owner (a scratch SQL login where the server has them).
        var owner = await scratch.CreateLoginAsync() ? scratch.Login : null;
        var attached = await Execute(info.Id, new AttachDatabaseDto(scratch.AttachAs, [mdf, ndf, ldf], false, owner));
        var state = (await Sql("SELECT SUSER_SNAME(d.owner_sid), (SELECT COUNT(*) FROM sys.master_files AS f WHERE f.database_id = d.database_id), "
            + "(SELECT f.physical_name FROM sys.master_files AS f WHERE f.database_id = d.database_id AND f.file_id = 1) FROM sys.databases AS d WHERE d.name = " + Quote(scratch.AttachAs) + ";")).Sets[0];
        check(attached.Error is null && attached.Steps.Select(step => step.Title + "|" + step.Status + "|" + step.Detail).SequenceEqual(owner is null
                ? ["Attach the database|done|" + scratch.AttachAs] : ["Attach the database|done|" + scratch.AttachAs, "Set the database owner|done|" + scratch.AttachAs])
            && state is [[var ownerName, "3", var primary]] && (owner is null || ownerName == owner) && primary is not null && Same(primary, mdf),
            "OK attaches the database's files under a hostile name and gives it the owner chosen: " + Steps(attached));
        var inUse = await Describe(mdf, info.Id);
        check(inUse is { AttachDatabase: null, Error: not null }, "an attached database's .mdf is a value, not a failure: " + Said(inUse));
        await scratch.DetachAsync(scratch.AttachAs);

        // A second database whose file is missing fails, and the first, already attached, is detached again (Rolled Back).
        var rolled = await Execute(info.Id, new AttachDatabaseDto(scratch.Attach, [mdf, ndf, ldf], false), new AttachDatabaseDto(scratch.AttachMissing, [missing], false));
        check(rolled.Error?.Code is "FILE_ACCESS" or "PATH_NOT_FOUND"
            && rolled.Steps.Select(step => step.Title + "|" + step.Status + "|" + step.Detail + "|" + (step.Compensates == true)).SequenceEqual([
                "Attach the database|done|" + scratch.Attach + "|False", "Attach the database|failed|" + scratch.AttachMissing + "|False", "Detach the database again|done|" + scratch.Attach + "|True"])
            && await Attached() is null,
            "a database that fails to attach detaches the ones this OK attached before it, and nothing stays attached: " + Steps(rolled));

        // Stop. The hook stops OK as the dialog's Stop would. First between two attaches: the first is detached again, and the second,
        // which never ran, has nothing to undo. Then the race Stop can lose: SQL Server finished the attach (here another session
        // attaches the same files) before its answer was read, so the step reads cancelled; the database is this OK's (its primary
        // file is the one named), so it is detached again all the same rather than left attached under a row that says Stopped.
        var actions = service.Actions;
        async Task<ActionExecuteResult?> Stopped(Func<int, Task<bool>> stopAt, params AttachDatabaseDto[] databases)
        {
            using var stop = new CancellationTokenSource();
            var attaches = 0;
            actions.Options.BeforeStep = async (title, _) => { if (title == ActionService.AttachTitle && await stopAt(++attaches)) stop.Cancel(); };
            try { return await actions.ExecuteAsync(Args(info.Id, databases), stop.Token); }
            catch (OperationCanceledException) { return null; }
            finally { actions.Options.BeforeStep = null; }
        }
        var between = await Stopped(attach => Task.FromResult(attach == 2), new AttachDatabaseDto(scratch.AttachAs, [mdf, ndf, ldf], false), new AttachDatabaseDto(scratch.AttachMissing, [missing], false));
        check(between is { Error.Code: "CANCELLED" }
            && between.Steps.Select(step => step.Title + "|" + step.Status + "|" + step.Detail + "|" + (step.Compensates == true)).SequenceEqual([
                "Attach the database|done|" + scratch.AttachAs + "|False", "Attach the database|cancelled|" + scratch.AttachMissing + "|False", "Detach the database again|done|" + scratch.AttachAs + "|True"])
            && await Attached() is null,
            "Stop between two attaches detaches the first again and has nothing of the second's to undo: " + (between is null ? "an unknown outcome" : Steps(between)));
        var raced = await Stopped(async _ =>
        {
            await Sql("CREATE DATABASE " + ActionSql.Quote(scratch.Attach) + " ON " + string.Join(", ", new[] { mdf, ndf, ldf }.Select(file => "( FILENAME = " + Quote(file) + " )")) + " FOR ATTACH;");
            return true;
        }, new AttachDatabaseDto(scratch.Attach, [mdf, ndf, ldf], false));
        check(raced is { Error.Code: "CANCELLED" }
            && raced.Steps.Select(step => step.Title + "|" + step.Status + "|" + (step.Compensates == true)).SequenceEqual(["Attach the database|cancelled|False", "Detach the database again|done|True"])
            && await Attached() is null,
            "Stop that reaches an attach SQL Server finished still detaches the database this OK attached: " + (raced is null ? "an unknown outcome" : Steps(raced)));

        // A database newer than the server (here a server that opens nothing past version 1) is refused by Add and by OK before
        // anything runs: SQL Server's own refusal, 948, would end the session as a lost connection.
        actions.Options.AttachServerVersion = 1;
        try
        {
            var newerRead = await Describe(mdf, info.Id);
            var newerRun = await Execute(info.Id, new AttachDatabaseDto(scratch.Attach, [mdf, ndf, ldf], false));
            check(newerRead is { AttachDatabase: null, Error.Code: "NOT_SUPPORTED" } && newerRead.Error.Message.StartsWith("This database is from a newer version of SQL Server", StringComparison.Ordinal)
                && newerRun is { Steps: [], Error.Code: "NOT_SUPPORTED" } && await Attached() is null,
                "a database newer than the server is refused when it is added and again when OK runs, before anything runs: " + Said(newerRead) + " | " + Steps(newerRun));
        }
        finally { actions.Options.AttachServerVersion = null; }

        // FOR ATTACH_REBUILD_LOG: the data files alone, with the log file deleted (sys.xp_delete_files, SQL Server 2019 and later,
        // on this run's own scratch file only), so SQL Server really builds a new log.
        var deletable = (await Sql("SELECT COUNT(*) FROM sys.system_objects WHERE name = N'xp_delete_files';")).Scalar == "1";
        if (deletable) await Sql("EXEC master.sys.xp_delete_files " + Quote(ldf) + ";");
        var logGone = deletable && (await Sql("SELECT CONVERT(int, x.file_exists) FROM sys.dm_os_file_exists(" + Quote(ldf) + ") AS x;")).Scalar == "0";
        var rebuild = await Execute(info.Id, new AttachDatabaseDto(scratch.Attach, [mdf, ndf], true));
        var reattached = (await Sql("SELECT d.state_desc, f.physical_name FROM sys.databases AS d JOIN sys.master_files AS f ON f.database_id = d.database_id AND f.type = 1 WHERE d.name = " + Quote(scratch.Attach) + ";")).Sets[0];
        if (reattached is [[_, { } newLog]]) scratch.AttachFilesAre([mdf, ndf, newLog]);
        check(rebuild is { Error: null, Steps: [{ Status: "done" }] } && reattached is [["ONLINE", { } logPath]]
            && (!deletable || logGone && (await Sql("SELECT CONVERT(int, x.file_exists) FROM sys.dm_os_file_exists(" + Quote(logPath) + ") AS x;")).Scalar == "1"),
            "an attach without its log files runs FOR ATTACH_REBUILD_LOG" + (deletable ? ", and SQL Server builds a new log for the one deleted" : " (this server cannot delete the log, so SQL Server finds it)") + ": " + Steps(rebuild));

        if (owner is null)
        {
            Console.WriteLine("Attach Databases low-privilege check skipped: this server accepts Windows logins only.");
            return;
        }
        // A login without CREATE ANY DATABASE is refused by the preflight, and DBCC CHECKPRIMARYFILE by SQL Server, as values.
        await scratch.DetachAsync(scratch.Attach);
        var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        try
        {
            var refused = await Execute(connected.Id, new AttachDatabaseDto(scratch.AttachAs, [mdf, ndf, ldf], false));
            var unread = await Describe(mdf, connected.Id);
            check(refused is { Steps: [], Error.Code: "PERMISSION_DENIED" } && unread is { AttachDatabase: null, Error.Code: "PERMISSION_DENIED" } && await Attached() is null,
                "a login without CREATE ANY DATABASE cannot attach or read a primary file, as values: " + Steps(refused) + " | " + Said(unread));
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json); }
    }
}
