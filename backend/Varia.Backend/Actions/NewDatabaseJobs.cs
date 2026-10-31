using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>New Database's jobs on the object-action path (D1b): describe model and the server in master, script the design, and create
/// it: CREATE DATABASE from the builder, then Database Properties' ALTER statements for the options and scoped configurations that
/// differ from model, the filegroup changes and the owner, each a step Stop can end. A failure after CREATE leaves the database, as
/// SSMS does; the steps say what completed.</summary>
internal sealed partial class ActionService
{
    public const string CreateDatabaseTitle = "Create the database";
    public const string SetOwnerTitle = "Set the owner";

    private static string FilegroupTitle(AlterTemplate template) => template switch
    {
        AlterTemplate.FilegroupDefault => "Set the default filegroup",
        AlterTemplate.FilegroupReadOnly => "Make the filegroup read-only",
        _ => "Autogrow all files"
    };

    private static async Task<ScriptPreflight.Row> NewDatabaseFactsAsync(SqlConnection connection, string? name, string? owner, string? collation, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = CreateDatabaseSql.Facts;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@owner", SqlDbType.NVarChar, 128, owner);
        Add(command, "@collation", SqlDbType.NVarChar, 128, collation);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) throw new InvalidOperationException("The facts statement returned no row.");
        return ReadRow(reader);
    }

    /// <summary>model as Database Properties reads it (a new database starts as its copy), the default folders (model's own when the
    /// server names none), the server's collation, whether the login may create a database, master's level and the platform.</summary>
    private async Task<ActionDescribeResult> DescribeNewDatabaseJobAsync(SqlConnection connection, ServerProfile profile, int band, CancellationToken token)
    {
        var facts = await NewDatabaseFactsAsync(connection, null, null, null, token);
        var (model, missing) = await DatabaseProperties.DescribeAsync(connection, catalog, "model", band, token);
        if (model is null) return new(null, 0, Error("NOT_FOUND", missing!));
        var data = facts.Name("data_path") is { Length: > 0 } dataPath ? dataPath : model.Files.FirstOrDefault(file => file.Type == "rows")?.Path ?? "";
        var log = facts.Name("log_path") is { Length: > 0 } logPath ? logPath : model.Files.FirstOrDefault(file => file.Type == "log")?.Path ?? data;
        return new(null, 0, NewDatabase: new(model, data, log, facts.Name("server_collation"), facts.Bool("can_create"), facts.Int("master_level"), profile.Linux));
    }

    /// <summary>The preflight Script and OK share, in master: the name, permission, owner and collation, the server's own rules, the
    /// folders and files on the server (from SQL Server 2017, when the login may ask), and the ALTER statements after CREATE. Script
    /// turns what would only fail into warnings; OK refuses it before any DDL.</summary>
    private async Task<(NewDatabasePlan? Plan, List<AlterStatement>? Alters, ActionError? Error, List<string> Warnings)> PlanNewDatabaseAsync(SqlConnection connection, ActionArgs args,
        ServerProfile profile, int band, bool execute, CancellationToken token)
    {
        var plan = NewDatabaseValidator.Validate(catalog, args.Target.Name!, args.Design?.As<NewDatabaseDesignDto>());
        var warnings = new List<string>();
        var facts = await NewDatabaseFactsAsync(connection, plan.Name, plan.Owner, plan.Collation, token);
        if (facts.Int("engine_edition") is 5 or 8) return (null, null, Error("NOT_SUPPORTED", EngineMessage(facts.Int("engine_edition") == 8 ? "managedInstance" : "cloud")), warnings);
        var problems = new List<(string Code, string Message)>();
        if (facts.Bool("name_in_use")) problems.Add(("NAME_IN_USE", "A database named " + ScriptingErrors.Display(plan.Name) + " already exists."));
        if (!facts.Bool("can_create")) problems.Add(("PERMISSION_DENIED", "You do not have permission to create a database (CREATE ANY DATABASE)."));
        if (!facts.Bool("owner_exists")) problems.Add(("NOT_FOUND", "The login " + ScriptingErrors.Display(plan.Owner!) + " does not exist."));
        if (!facts.Bool("collation_exists")) problems.Add(("NOT_FOUND", "The collation " + ScriptingErrors.Display(plan.Collation!) + " is not one of the server's."));
        if (NewDatabaseValidator.ServerProblem(catalog, plan, new(band, profile.Linux, facts.Int("filestream_level"), facts.Bool("contained_authentication"))) is { } server) problems.Add(server);
        else if (facts.Int("file_exists_view") > 0) problems.AddRange(await FileProblemsAsync(connection, plan, profile.Linux, token));

        var alterFacts = new DatabaseAlter.Facts(band, Math.Min(facts.Int("major") * 10, catalog.CompatibilityLevels.Max()), facts.Bool("model_auto_create"));
        var (alters, refusal) = DatabaseAlter.Plan(catalog, plan.Name, new DatabaseChangesDto(null, plan.Options, plan.Scoped), rollback: false, alterFacts);
        if (refusal is not null) return (null, null, Error("NOT_SUPPORTED", refusal), warnings);
        alters!.AddRange(plan.FilegroupChanges().Select(change => new AlterStatement(change.Template, plan.Name, "filegroup", Name: change.Filegroup, Title: FilegroupTitle(change.Template))));
        if (plan.Owner is { } owner) alters.Add(new(AlterTemplate.Owner, plan.Name, "owner", Name: owner, Title: SetOwnerTitle));
        if (execute)
        {
            // The builder shreds the design with OPENJSON, which needs master at compatibility level 130 (SQL Server 2016) or later.
            if (facts.Int("master_level") < 130) return (null, null, Error("NOT_SUPPORTED", "Creating a database needs master at compatibility level 130 or later."), warnings);
            if (problems.Count > 0) return (null, null, Error(problems[0].Code, problems[0].Message), warnings);
        }
        warnings.AddRange(problems.Take(8).Select(problem => problem.Message));
        return (plan, alters, null, warnings);
    }

    /// <summary>Each folder must exist and each file must not, as sys.dm_os_file_exists sees them. A login the server will not answer
    /// (it needs VIEW SERVER STATE) stops the checks: CREATE DATABASE then says.</summary>
    private static async Task<List<(string Code, string Message)>> FileProblemsAsync(SqlConnection connection, NewDatabasePlan plan, bool linux, CancellationToken token)
    {
        var problems = new List<(string, string)>();
        var separator = linux ? '/' : '\\';
        var folders = new HashSet<string>(linux ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var file in plan.Files)
            {
                var folder = ServerPath.Folder(file.Path, linux)!;
                if (folders.Add(folder))
                {
                    var probe = folder.Length > 1 && !(folder.Length == 3 && folder[1] == ':') ? folder[..^1] : folder;
                    var (_, directory) = await ServerFiles.ExistsAsync(connection, ServerFiles.Exists, probe, token);
                    if (!directory) problems.Add(("PATH_NOT_FOUND", "The folder " + ScriptingErrors.Display(folder) + " does not exist, or SQL Server's service account cannot see it."));
                }
                var full = NewDatabaseValidator.FullPath(file, separator);
                var (exists, isDirectory) = await ServerFiles.ExistsAsync(connection, ServerFiles.Exists, full, token);
                if (exists || isDirectory) problems.Add(("NAME_IN_USE", "The file " + ScriptingErrors.Display(full) + " already exists on the server."));
            }
        }
        catch (SqlException) when (!token.IsCancellationRequested) { }
        return problems;
    }

    private async Task<ActionScriptResult> ScriptNewDatabaseJobAsync(SqlConnection connection, ActionArgs args, ServerProfile profile, int band, CancellationToken token)
    {
        var (plan, alters, error, warnings) = await PlanNewDatabaseAsync(connection, args, profile, band, execute: false, token);
        if (plan is null) return new(null, "master", [], error);
        var text = CreateDatabaseSql.Script(plan, profile.Linux) + DatabaseAlter.ScriptText(catalog, alters!, context: "master");
        if (text.Length > ScriptLimit(args.Action)) return new(null, "master", [], Error("SQL_ERROR", "The script is too large."));
        return new(text, "master", warnings);
    }

    private async Task<ActionExecuteResult> ExecuteNewDatabaseJobAsync(SqlConnection connection, ActionArgs args, ServerProfile profile, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (plan, alters, error, _) = await PlanNewDatabaseAsync(connection, args, profile, band, execute: true, token);
        if (plan is null) return new([], [], 0, error);
        var design = CreateDatabaseSql.DesignJson(plan, profile.Linux);
        var work = new List<RunStep> { new(CreateDatabaseTitle, context => RunCreateAsync(connection, design, dryRun: false, context.Token)) };
        work.AddRange(alters!.Select(statement => new RunStep(statement.Title, context => RunAlterAsync(connection, statement, dryRun: false, context.Token),
            Detail: statement.Filegroup ? ScriptingErrors.Display(statement.Name!) : null)));
        var (steps, failure, _) = await RunStepsAsync(connection, work, null, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }

    private static async Task<List<string?>> RunCreateAsync(SqlConnection connection, string design, bool dryRun, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = CreateDatabaseSql.Builder(dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@design", SqlDbType.NVarChar, -1, design);
        var values = new List<string?>();
        await using var reader = await command.ExecuteReaderAsync(token);
        do
        {
            while (await reader.ReadAsync(token))
                for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
        } while (await reader.NextResultAsync(token));
        return values;
    }

    /// <summary>The live checks' only way to see what New Database's builder composes for a plan (see the other DryRunAsync).</summary>
    internal async Task<List<string?>> DryRunCreateAsync(string connectionId, NewDatabasePlan plan, bool linux, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return await RunCreateAsync(connection, CreateDatabaseSql.DesignJson(plan, linux), dryRun: true, token);
    }
}
