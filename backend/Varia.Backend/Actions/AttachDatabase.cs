using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>One step of an attach's plan: attach a database, set its owner, or (a compensation) detach it again. Undoes is the
/// index among the main steps of the attach a compensation undoes; Mdf, a compensation's, is the primary file that attach named,
/// by which a Stop's compensation knows the database as this OK's (AttachSql.Attached).</summary>
internal sealed record AttachStep(string Title, StepKind Kind, string Database, AttachStatement? Attach = null, AlterStatement? Owner = null, PlannedStatement? Detach = null, int? Undoes = null,
    string? Mdf = null);

/// <summary>Attach Databases (D1d): its describe (the server's facts, and one primary data file's database), Script and OK.</summary>
internal sealed partial class ActionService
{
    /// <summary>Attach Databases' dialog and describe id (src/shared/actions/catalog.ts).</summary>
    public const string AttachDialog = "attachDatabase";
    public const string AttachTitle = "Attach the database", OwnerTitle = "Set the database owner", DetachAgainTitle = "Detach the database again";

    /// <summary>Re-validates attachSchema's databases: 1 to attachDatabases of them, each with an identifier as its name (no two
    /// alike), an optional owner identifier, and 1 to attachFiles server paths, none twice.</summary>
    private void ValidateAttach(List<AttachDatabaseDto>? databases)
    {
        if (databases is null || databases.Count == 0 || databases.Count > catalog.Limit("attachDatabases")) throw Invalid("databases.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        var max = catalog.Limit("serverPath");
        foreach (var database in databases)
        {
            if (database is null || !ExplorerRefs.Ident(database.Name) || !names.Add(database.Name)) throw Invalid("databases.name.");
            if (database.Owner is not null && !ExplorerRefs.Ident(database.Owner)) throw Invalid("databases.owner.");
            if (database.Files is null || database.Files.Count == 0 || database.Files.Count > catalog.Limit("attachFiles")) throw Invalid("databases.files.");
            var files = new HashSet<string>(StringComparer.Ordinal);
            foreach (var file in database.Files) if (!ServerPath.Valid(file, max) || !files.Add(file)) throw Invalid("databases.files.");
        }
    }

    /// <summary>The statements an attach runs, in order: per database "Attach the database", then with an owner "Set the database
    /// owner" (ALTER AUTHORIZATION, as Database Properties writes it); then, newest first, a compensation per attach that detaches
    /// it again once a later step failed or was stopped (SSMS's Rolled Back; decision 5: only what this OK attached).</summary>
    public static List<AttachStep> AttachPlan(IReadOnlyList<AttachDatabaseDto> databases)
    {
        var plan = new List<AttachStep>();
        var attached = new List<(AttachDatabaseDto Database, int Index)>();
        var main = 0;
        foreach (var database in databases)
        {
            plan.Add(new(AttachTitle, StepKind.Main, database.Name, Attach: new(database.Name, database.Files, database.RebuildLog)));
            attached.Add((database, main++));
            if (database.Owner is not { } owner) continue;
            plan.Add(new(OwnerTitle, StepKind.Main, database.Name, Owner: new(AlterTemplate.Owner, database.Name, "owner", Name: owner, Title: "Owner")));
            main++;
        }
        for (var i = attached.Count - 1; i >= 0; i--)
        {
            var (database, index) = attached[i];
            plan.Add(new(DetachAgainTitle, StepKind.Compensation, database.Name, Detach: ActionSql.Detach(database.Name, updateStatistics: false, StepKind.Compensation, index), Undoes: index,
                Mdf: database.Files[0]));
        }
        return plan;
    }

    /// <summary>Why a database of <paramref name="fileVersion"/> cannot be attached on a server that opens <paramref name="serverVersion"/>
    /// and older, or null (also when either is unknown, and SQL Server decides). SQL Server's own refusal, 948, is severity 20 and
    /// ends the session: the user would read a lost connection, and the databases this OK attached before it could not be detached.</summary>
    public static string? VersionProblem(int? fileVersion, int? serverVersion) =>
        fileVersion is { } file && serverVersion is { } server && file > server
            ? "This database is from a newer version of SQL Server and cannot be attached here (its version is " + file.ToString(CultureInfo.InvariantCulture)
                + "; this server opens " + server.ToString(CultureInfo.InvariantCulture) + " and older)."
            : null;

    /// <summary>The server facts Attach Databases opens with, then, with <paramref name="attach"/>, its primary file's database,
    /// refused when it is newer than the server.</summary>
    private async Task<ActionDescribeResult> DescribeAttachJobAsync(SqlConnection connection, AttachDescribeArgsDto? attach, bool linux, CancellationToken token)
    {
        var (server, version) = await AttachFactsAsync(connection, linux, token);
        if (attach is null) return new(null, 0, AttachDatabase: new(server));
        var (database, error) = await ReadPrimaryAsync(connection, attach.Mdf, token);
        if (database is null) return new(null, 0, error);
        if (VersionProblem(database.Version, version) is { } problem) return new(null, 0, Error("NOT_SUPPORTED", problem));
        return new(null, 0, AttachDatabase: new(server, database));
    }

    /// <summary>The newest database version the server opens: master's, or the live checks' stand-in.</summary>
    private int? ServerVersion(int? master) => Options.AttachServerVersion ?? master;

    private async Task<(AttachServerDto Server, int? Version)> AttachFactsAsync(SqlConnection connection, bool linux, CancellationToken token)
    {
        var take = (int)catalog.Limit("logins");
        var logins = new List<string>();
        string? dataPath = null;
        int? version = null;
        await using var command = connection.CreateCommand();
        command.CommandText = AttachSql.Facts;
        command.CommandTimeout = 0;
        Add(command, "@logins", SqlDbType.Int, 0, take + 1);
        await using (var reader = await command.ExecuteReaderAsync(token))
        {
            while (await reader.ReadAsync(token)) if (!reader.IsDBNull(0)) logins.Add(reader.GetString(0));
            if (await reader.NextResultAsync(token) && await reader.ReadAsync(token))
            {
                if (!reader.IsDBNull(0)) dataPath = reader.GetString(0);
                if (!reader.IsDBNull(1)) version = reader.GetInt32(1);
            }
        }
        var truncated = logins.Count > take;
        if (truncated) logins.RemoveRange(take, logins.Count - take);
        return (new(logins, truncated, linux ? "/" : "\\", dataPath is { Length: > 0 } path && ServerPath.Valid(path, catalog.Limit("serverPath")) ? path : null), ServerVersion(version));
    }

    /// <summary>Reads a detached primary data file (critic A10: DBCC CHECKPRIMARYFILE with the path bound, its result sets read
    /// here): whether it is one, its database's name and version, and its files by file id, each checked for existence as the
    /// server file picker checks a path. SQL Server's own errors (a missing file, one in use, no permission) are the job's
    /// failure value. <paramref name="legacy"/> (the live checks only) checks with SQL Server 2016's xp_fileexist.</summary>
    internal async Task<(AttachDatabaseInfoDto? Database, ActionError? Error)> ReadPrimaryAsync(SqlConnection connection, string mdf, CancellationToken token, bool legacy = false)
    {
        var display = ScriptingErrors.Display(mdf);
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = AttachSql.IsPrimary;
            command.CommandTimeout = 0;
            Add(command, "@mdf", SqlDbType.NVarChar, 260, mdf);
            await using var reader = await command.ExecuteReaderAsync(token);
            var primary = await reader.ReadAsync(token) && !reader.IsDBNull(0) && Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture) == 1;
            if (!primary) return (null, Error("NOT_SUPPORTED", display + " is not the primary data file of a database."));
        }
        string? name = null;
        int? version = null;
        var files = new List<(int Id, string Path, bool Log)>();
        var limit = (int)catalog.Limit("attachFiles");
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = AttachSql.Primary;
            command.CommandTimeout = 0;
            Add(command, "@mdf", SqlDbType.NVarChar, 260, mdf);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                var property = reader.IsDBNull(0) ? null : Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture)?.Trim();
                var value = reader.IsDBNull(1) ? null : reader.GetValue(1);
                if (property == "Database name") name = Convert.ToString(value, CultureInfo.InvariantCulture)?.TrimEnd();
                else if (property == "Database version" && value is not null) version = Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            if (await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token))
                {
                    if (files.Count == limit) return (null, Error("NOT_SUPPORTED", "The database in " + display + " has more than " + limit + " files; attach it with a script."));
                    var status = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
                    var id = Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture);
                    var path = reader.IsDBNull(3) ? "" : Convert.ToString(reader.GetValue(3), CultureInfo.InvariantCulture)?.TrimEnd() ?? "";
                    files.Add((id, path, (status & 0x40) != 0));
                }
        }
        if (string.IsNullOrEmpty(name) || files.Count == 0 || !files.Any(file => file.Id == 1)) return (null, Error("NOT_SUPPORTED", "SQL Server could not read the database in " + display + "."));
        files.Sort((a, b) => a.Id.CompareTo(b.Id));
        // The .mdf itself was just read where it was added; the others are checked where it recorded them.
        var others = files.Where(file => file.Id != 1).Select(file => file.Path).ToList();
        var found = await ServerFiles.FilesExistAsync(connection, others, token, legacy);
        var next = 0;
        var listed = files.Select(file => file.Id == 1
            ? new AttachFileDto(file.Path, file.Log ? "log" : "data", mdf, true)
            : new AttachFileDto(file.Path, file.Log ? "log" : "data", file.Path, found[next++])).ToList();
        return (new(mdf, name, listed, version), null);
    }

    /// <summary>The live checks' way to read a primary file as Add does, on a connection of its own.</summary>
    internal async Task<(AttachDatabaseInfoDto? Database, ActionError? Error)> ReadPrimaryAsync(string connectionId, string mdf, bool legacy, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        await RunAsync(connection, ActionSql.ReadPrologue, token);
        try { return await ReadPrimaryAsync(connection, mdf, token, legacy); }
        catch (SqlException error) { return (null, ActionErrors.FromSql(catalog, error, connection, ddl: false, null)); }
    }

    /// <summary>Script Action: the plan's main statements as SSMS lays them out (USE and GO); Script never runs anything.</summary>
    private ActionScriptResult ScriptAttach(ActionArgs args)
    {
        var text = new StringBuilder();
        var limit = ScriptLimit("attach");
        foreach (var step in AttachPlan(args.Databases!).Where(step => step.Kind == StepKind.Main))
        {
            text.Append(step.Attach is { } attach ? AttachSql.ScriptText(attach) : DatabaseAlter.ScriptText(catalog, [step.Owner!]));
            if (text.Length > limit) return new(null, "master", [], Error("SQL_ERROR", "The script is too large."));
        }
        return new(text.ToString(), "master", []);
    }

    /// <summary>OK: the preflight for every database (refused as a value before anything runs), then the plan through runner v2.</summary>
    private async Task<ActionExecuteResult> ExecuteAttachJobAsync(SqlConnection connection, ActionArgs args, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        foreach (var database in args.Databases!)
            if (await AttachRefusalAsync(connection, database, token) is { } refused) return new([], [], 0, refused);
        var (steps, failure, _) = await RunStepsAsync(connection, AttachSteps(connection, args.Databases!), null, token, CleanupBudget("attach"));
        return new(steps, messages.Collected(), 0, failure);
    }

    /// <summary>Why one database cannot be attached now (AttachSql.Preflight in the action's connection), or null.</summary>
    private async Task<ActionError?> AttachRefusalAsync(SqlConnection connection, AttachDatabaseDto database, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = AttachSql.Preflight;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database.Name);
        Add(command, "@owner", SqlDbType.NVarChar, 128, database.Owner);
        ScriptPreflight.Row row;
        await using (var reader = await command.ExecuteReaderAsync(token))
        {
            if (!await reader.ReadAsync(token)) return Error("SQL_ERROR", "The server did not answer the attach preflight.");
            row = ReadRow(reader);
        }
        var display = ScriptingErrors.Display(database.Name);
        if (row.Int("master_level") < 130) return Error("NOT_SUPPORTED", "Attach builds its statement with OPENJSON, which needs master's compatibility level to be 130 or higher.");
        if (!row.Bool("can_create")) return Error("PERMISSION_DENIED", "You do not have permission to attach databases (CREATE ANY DATABASE).");
        if (row.Bool("name_in_use")) return Error("NAME_IN_USE", "A database named " + display + " already exists. Choose another name in Attach As.");
        if (!row.Bool("owner_exists")) return Error("NOT_FOUND", "The login " + ScriptingErrors.Display(database.Owner!) + " does not exist.");
        // The file may have changed since Add read it; a newer database would end this session at its attach (948).
        var server = ServerVersion(row.Long("server_version") is { } master ? (int)master : null);
        return server is not null && VersionProblem(await PrimaryVersionAsync(connection, database.Files[0], token), server) is { } problem ? Error("NOT_SUPPORTED", problem) : null;
    }

    /// <summary>The version a primary file records (DBCC CHECKPRIMARYFILE 2), or null when SQL Server will not read it here, and the
    /// attach then reports why.</summary>
    private static async Task<int?> PrimaryVersionAsync(SqlConnection connection, string mdf, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = AttachSql.Properties;
            command.CommandTimeout = 0;
            Add(command, "@mdf", SqlDbType.NVarChar, 260, mdf);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
                if (!reader.IsDBNull(0) && !reader.IsDBNull(1) && Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture)?.Trim() == "Database version")
                    return Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture);
            return null;
        }
        catch (SqlException error) when (error.Class < 20 && connection.State == ConnectionState.Open && !token.IsCancellationRequested) { return null; }
    }

    private List<RunStep> AttachSteps(SqlConnection connection, IReadOnlyList<AttachDatabaseDto> databases) =>
    [
        .. AttachPlan(databases).Select(step => new RunStep(step.Title, async context =>
        {
            if (step.Attach is { } attach) await RunAttachAsync(connection, attach, dryRun: false, context.Token);
            else if (step.Owner is { } owner) await RunAlterAsync(connection, owner, dryRun: false, context.Token);
            else await RunStatementAsync(connection, step.Detach!, dryRun: false, context.Token);
        }, step.Kind, step.Undoes, Detail: step.Database, Confirm: step.Mdf is { } mdf ? context => IsAttachedAsync(connection, step.Database, mdf, context.Token) : null))
    ];

    /// <summary>Whether <paramref name="name"/> is attached from <paramref name="mdf"/> (AttachSql.Attached), read through a reader as
    /// every action statement is (tests/action-reader-lint.test.ts).</summary>
    private static async Task<bool> IsAttachedAsync(SqlConnection connection, string name, string mdf, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = AttachSql.Attached;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@mdf", SqlDbType.NVarChar, 260, mdf);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) && !reader.IsDBNull(0) && reader.GetBoolean(0);
    }

    private static async Task<List<string?>> RunAttachAsync(SqlConnection connection, AttachStatement statement, bool dryRun, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = AttachSql.Executable(statement.RebuildLog, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, statement.Name);
        Add(command, "@design", SqlDbType.NVarChar, -1, AttachSql.Design(statement));
        return await ReadAllAsync(command, token);
    }

    /// <summary>The live checks' only way to see the CREATE DATABASE … FOR ATTACH the server would build (never the wire).</summary>
    internal async Task<List<string?>> DryRunAttachAsync(string connectionId, AttachStatement statement, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return await RunAttachAsync(connection, statement, dryRun: true, token);
    }
}
